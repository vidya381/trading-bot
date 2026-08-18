/**
 * `GET /api/proposals`' filters and paging, decided in a module a test can drive.
 *
 * ── WHY THIS IS NOT INLINE IN THE HANDLER ──
 *
 * `handlers.ts` is exercised end to end through `api.test.ts` against real D1,
 * which is the right shape for wiring and the wrong shape for a boundary: proving
 * that `limit=0`, `limit=101`, `limit=-1`, `limit=1.5`, `limit=1e3` and
 * `limit=%20` each land on the correct side of a bound needs six cases against a
 * function, not six HTTP round trips against a database. Decision log 45's gap (b)
 * is the standing argument -- a decision nothing can reach is a decision nobody is
 * watching -- and this module is where the decisions are, so this is where the
 * tests point.
 *
 * ── ⚠ WHY THERE IS A MAXIMUM PAGE SIZE AND IT IS NOT NEGOTIABLE ──
 *
 * `proposals` is the one table in this system with no delete path (section 8.7),
 * and it now grows by two rows per button press (decision log 46). "Return
 * everything" was never available here, and a caller-chosen unbounded `limit` is
 * the same thing with a longer URL.
 *
 * ── THE THREE FILTERS, AND ONE OF THEM IS NOT A COLUMN VALUE ──
 *
 * `stage` and `outcome` are closed enumerations, so an unrecognised value is a 400
 * rather than an empty list -- `listAlerts`' rule, for its stated reason: a typo
 * that returns "nothing matched" is indistinguishable from a real empty result.
 *
 * ⚠ `outcome=pending` IS THE ONE THAT MATTERS, and it is deliberately a value the
 * COLUMN cannot hold. Migration 0009: *"`outcome IS NULL` IS 21.5's 'ignored',
 * read after the fact"*, and `idx_proposals_unresolved` is the partial index that
 * exists to count it. The whole reason 21.5 requirement 5 says *"including the ones
 * nobody acts on"* is that "the system kept proposing things nobody wanted" is
 * invisible if only decisions are listable. A history view that could filter to
 * `approved` and `rejected` but not to the rows in between would omit the one
 * question the table was built to answer.
 *
 * ⚠ AND THE HONEST QUALIFICATION TRAVELS WITH IT, unchanged from migration 0009: a
 * proposal made thirty seconds ago also has a NULL outcome, so a `pending` count is
 * only meaningful over rows old enough that a human would have acted. No threshold
 * is invented here for that, exactly as none was invented there.
 *
 * ── `accountLabel` IS NOT CHECKED AGAINST THE REGISTRY, AND THAT IS A DECISION ──
 *
 * `listWatchlist` refuses an unknown account label rather than returning `[]`,
 * because "nothing is watched" about an account that does not exist is a lie the
 * caller cannot detect. This endpoint deliberately does NOT do that, and the reason
 * is the difference between a live set and a permanent record: **an account can be
 * de-registered, and its proposals do not stop existing.** Section 8.7 keeps every
 * row forever, so an id that names a retired account must still be findable, and a
 * 404 driven by today's registry would hide history that is deliberately undeletable.
 * The dashboard closes the typo hole at the other end, by offering a select rather
 * than a text field.
 */

import type { ProposalOutcome, ProposalStage } from "../db/schema";
import { PROPOSAL_OUTCOMES, PROPOSAL_STAGES } from "../db/schema";

/**
 * The default page size.
 *
 * 25 rather than a round 50 or 100 because a page is a thing a human reads, and
 * because every row of it is a real proposal that cost a paid inference -- the set
 * this table describes is small enough per page to be looked at rather than
 * scrolled past.
 */
export const DEFAULT_PROPOSAL_LIMIT = 25;

/**
 * The largest page any caller may ask for.
 *
 * ⚠ IT IS A CAP ON ROW COUNT AND NOT ON BYTES, and that is only safe because
 * `PROPOSAL_LIST_COLUMNS` never reads `inputs_json` or `reasoning_json`. A page of
 * 100 rows is ~100 short strings per row; the same page read through
 * `Repository.findMany` would be up to 100 × 290,459 bytes of candle windows and
 * prompts (migration 0009's measured ceiling). If a future edit ever puts the
 * payloads back into the list read, this number becomes dangerous rather than
 * generous -- which is why the two facts are written down together.
 */
export const MAX_PROPOSAL_LIMIT = 100;

/**
 * `pending` is not a stored value. See the header: it is `outcome IS NULL`, which
 * is the state 21.5's central signal is measured over.
 */
export const PENDING_OUTCOME = "pending" as const;

export type ProposalOutcomeFilter = ProposalOutcome | typeof PENDING_OUTCOME;

export const PROPOSAL_OUTCOME_FILTERS: readonly ProposalOutcomeFilter[] = [
  ...PROPOSAL_OUTCOMES,
  PENDING_OUTCOME,
];

/**
 * The `where` this query becomes, in the repository's own vocabulary.
 *
 * `outcome: null` is how `Repository.#where` spells `IS NULL` -- a bare null value
 * on a nullable column, not a comparison object. That is the mechanism behind
 * `outcome=pending`, and it is why `pending` never reaches the column encoder as a
 * string the CHECK constraint would refuse.
 */
export interface ProposalListWhere {
  readonly account_label?: string;
  readonly stage?: ProposalStage;
  readonly outcome?: ProposalOutcome | null;
}

export interface ProposalQuery {
  readonly accountLabel: string | null;
  readonly stage: ProposalStage | null;
  readonly outcome: ProposalOutcomeFilter | null;
  readonly limit: number;
  readonly offset: number;
}

export interface ProposalQueryRefusal {
  readonly ok: false;
  /** `listAlerts`' own code for a bad filter value, reused rather than reinvented. */
  readonly code: "invalid_filter";
  readonly message: string;
}

export type ProposalQueryResult = { readonly ok: true; readonly query: ProposalQuery } | ProposalQueryRefusal;

function refuse(message: string): ProposalQueryRefusal {
  return { ok: false, code: "invalid_filter", message };
}

/**
 * Digits and nothing else. See `parseCount`.
 */
const NON_NEGATIVE_INTEGER = /^\d+$/;

/**
 * Parse one non-negative integer query parameter.
 *
 * ⚠ IT MATCHES THE TEXT AND THEN CONVERTS, RATHER THAN CONVERTING AND CHECKING,
 * AND THAT ORDER WAS FORCED BY A TEST RATHER THAN CHOSEN. The obvious spelling is
 * `Number.isInteger(Number(raw)) && parsed >= 0`, which is what
 * `getAccountAssess` uses for `since` -- and it **accepts `"1e3"`**, because
 * `Number("1e3")` is exactly 1000 and 1000 is an integer. It likewise accepts
 * `"5.0"`, `"+5"`, `"0x10"` and `" 5 "`. None of those is something a caller types
 * on purpose, and `1e3` is ten times this endpoint's page cap arriving through a
 * check written to stop it.
 *
 * ⚠ THE SISTER BUG WAS FOUND AT THE SAME TIME AND IS WORTH NAMING: the first
 * version of this module's own test asserted that `limit=1e3` was refused, and it
 * PASSED -- but for the wrong reason. 1e3 parses to 1000, 1000 exceeds
 * `MAX_PROPOSAL_LIMIT`, and the CAP refused it while the PARSE waved it through.
 * A test that passes for a reason other than the one it states is the pattern
 * decision logs 45, 46, 48 and 49 each record an instance of; this is another.
 * `offset` has no cap at all, so there the same hole had nothing behind it.
 *
 * `Number.isSafeInteger` is still asserted after the match: a string of thirty
 * digits is all digits and is past 2^53, where integer arithmetic stops being
 * exact -- the same bound `columns.ts` enforces on every integer column.
 */
function parseCount(raw: string, name: string): { ok: true; value: number } | ProposalQueryRefusal {
  const trimmed = raw.trim();
  const parsed = Number(trimmed);
  if (!NON_NEGATIVE_INTEGER.test(trimmed) || !Number.isSafeInteger(parsed)) {
    return refuse(
      `query parameter "${name}", if given, must be a non-negative integer written in plain ` +
        `digits, not ${JSON.stringify(raw)}`,
    );
  }
  return { ok: true, value: parsed };
}

/**
 * Read the filters and paging off a request's query string.
 *
 * Returns a REFUSAL VALUE rather than throwing, the shape `checkTradable` and
 * `checkParamsShape` both use: the caller (a handler) owns the HTTP status, and a
 * pure module that threw `ApiError` would be a second place statuses are decided.
 */
export function parseProposalQuery(params: URLSearchParams): ProposalQueryResult {
  const accountLabelRaw = params.get("accountLabel");
  if (accountLabelRaw !== null && accountLabelRaw.trim() === "") {
    // An empty filter is not the same request as no filter, and guessing which was
    // meant is the thing `researchParams` refuses one layer up.
    return refuse(
      `query parameter "accountLabel", if given, must not be empty -- omit it to list every account`,
    );
  }
  const accountLabel = accountLabelRaw === null ? null : accountLabelRaw.trim();

  const stageRaw = params.get("stage");
  if (stageRaw !== null && !PROPOSAL_STAGES.includes(stageRaw as ProposalStage)) {
    return refuse(`stage must be one of ${PROPOSAL_STAGES.join(", ")}`);
  }
  const stage = stageRaw === null ? null : (stageRaw as ProposalStage);

  const outcomeRaw = params.get("outcome");
  if (outcomeRaw !== null && !PROPOSAL_OUTCOME_FILTERS.includes(outcomeRaw as ProposalOutcomeFilter)) {
    return refuse(
      `outcome must be one of ${PROPOSAL_OUTCOME_FILTERS.join(", ")} -- ` +
        `"${PENDING_OUTCOME}" means no decision has been recorded, which is 21.5's "ignored" ` +
        `read after the fact and is stored as NULL rather than as a word`,
    );
  }
  const outcome = outcomeRaw === null ? null : (outcomeRaw as ProposalOutcomeFilter);

  let limit = DEFAULT_PROPOSAL_LIMIT;
  const limitRaw = params.get("limit");
  if (limitRaw !== null) {
    const parsed = parseCount(limitRaw, "limit");
    if (!parsed.ok) return parsed;
    if (parsed.value === 0) {
      // A page of nothing is always a caller bug: it cannot page forward, and it
      // reports "no proposals" about a table that may be full of them.
      return refuse(`query parameter "limit" must be at least 1`);
    }
    if (parsed.value > MAX_PROPOSAL_LIMIT) {
      // ⚠ REFUSED, NOT SILENTLY CLAMPED. A clamped page returns 100 rows to a
      // caller who asked for 500 and believes it has them all, which is a wrong
      // answer wearing the shape of a right one -- and paging from it skips 400
      // records. Saying so costs one 400 and no data.
      return refuse(
        `query parameter "limit" must be at most ${MAX_PROPOSAL_LIMIT}, not ${parsed.value}. ` +
          `It is refused rather than clamped: a silently shortened page would look complete ` +
          `and paging on from it would skip records.`,
      );
    }
    limit = parsed.value;
  }

  let offset = 0;
  const offsetRaw = params.get("offset");
  if (offsetRaw !== null) {
    const parsed = parseCount(offsetRaw, "offset");
    if (!parsed.ok) return parsed;
    offset = parsed.value;
  }

  return { ok: true, query: { accountLabel, stage, outcome, limit, offset } };
}

/**
 * The query as a repository filter.
 *
 * ⚠ AN ABSENT FILTER IS AN ABSENT KEY, never `undefined` and never an empty
 * string. `Repository.#where` skips an `undefined` value, so either would work by
 * accident today -- but "the key is not there" is the property, and building it
 * that way means a filter cannot be half-applied by a value that stringifies to
 * nothing.
 */
export function proposalListWhere(query: ProposalQuery): ProposalListWhere {
  return {
    ...(query.accountLabel === null ? {} : { account_label: query.accountLabel }),
    ...(query.stage === null ? {} : { stage: query.stage }),
    ...(query.outcome === null
      ? {}
      : { outcome: query.outcome === PENDING_OUTCOME ? null : query.outcome }),
  };
}

export interface ProposalPage {
  readonly limit: number;
  readonly offset: number;
  /** Rows matching the filters across the WHOLE table, not just this page. */
  readonly total: number;
  /** How many came back in this page. */
  readonly returned: number;
  /** Whether asking for `offset + limit` would return anything. */
  readonly hasMore: boolean;
}

/**
 * The paging facts, computed once so the endpoint and the page agree.
 *
 * ⚠ `hasMore` IS COMPUTED FROM `offset + returned`, NOT FROM `offset + limit`, AND
 * THE REASON IS NARROWER THAN IT FIRST LOOKS. This docblock's first version said
 * the two differ "on the last page", which a mutation run disproved: on an ordinary
 * last page they agree, and the test written against that sentence passed without
 * discriminating between them at all.
 *
 * They differ on exactly one region, and it is real: **a page that comes back
 * SHORTER than the limit while more rows still match** -- `offset + returned <
 * total <= offset + limit`. There the correct formula says "keep going" and
 * `offset + limit` says "you have reached the end", which HIDES the remaining rows
 * behind a disabled next button, with a `total` on screen that says they exist.
 *
 * That is not hypothetical here. `total` is a SECOND query at a slightly different
 * instant from the page read (see below), so the two can disagree by a row, and any
 * future result-set truncation would widen the gap. The formula that reports what
 * actually came back is the one that stays right through both.
 *
 * ⚠ AND `total` IS A SECOND QUERY, DELIBERATELY. A page with no total cannot say
 * "26 of 312" and cannot render a last page, so "real pagination" would be a next
 * button and a guess. `COUNT(*)` under the same WHERE reads no payload column at
 * all, which is why it is affordable here in a way `findMany` would not have been.
 *
 * ⚠ IT IS A COUNT AT ONE INSTANT, not a transaction with the page read. A row
 * written between the two queries makes `total` one larger than the page it
 * describes. That is inherent to counting and paging separately, it is not
 * corrected here, and it is stated rather than left to be discovered: the only
 * writer is a real `/assess` or `/derive` call, so the drift is one row per real
 * inference and never a silent reordering of anything already read.
 */
export function proposalPage(query: ProposalQuery, total: number, returned: number): ProposalPage {
  return {
    limit: query.limit,
    offset: query.offset,
    total,
    returned,
    hasMore: query.offset + returned < total,
  };
}
