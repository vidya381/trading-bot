/**
 * EVERY DECISION THE PROPOSAL HISTORY VIEW MAKES, in a module a test can drive.
 *
 * React-free and network-free, for `proposalFields.ts`'s reason, which a mutation
 * run established rather than a preference: a decision living in a `.tsx` is
 * reachable by NO test in this repository. There is no jsdom and no
 * testing-library, and a test importing a `.tsx` collects ZERO TESTS RATHER THAN
 * FAILING inside the Workers pool the root suite runs in (decision logs 44, 45, 46,
 * 48, 49). So `pages/ProposalHistory.tsx` maps over what this returns and decides
 * nothing but layout.
 *
 * ── WHAT IS AND IS NOT DECIDED HERE ──
 *
 * DECIDED HERE: which URL parameters are real filters, what page a given offset is,
 * what a row's outcome cell says, and how a pending duration reads.
 *
 * NOT DECIDED HERE, and deliberately: whether a proposal was any good. Every label
 * below reports a fact the record already holds. Nothing computes a verdict, ranks
 * a row, or hides one -- which is the same rule `proposalSummary.ts` keeps and for
 * the same reason: a second implementation of a judgement drifts from the first,
 * and the copy that drifts is the one nobody is watching.
 *
 * ── ⚠ THE FILTERING IS THE BACKEND'S, AND THIS MIRRORS ONLY THE VOCABULARY ──
 *
 * `GET /api/proposals` filters and pages in SQL. This module never filters a fetched
 * array -- `pages/Alerts.tsx`'s standing rule, *"never fetch-everything-then-filter"*,
 * and it is not optional here: the table has no delete path (section 8.7) and gains
 * two rows per real run, so "fetch everything" has no ceiling at all.
 *
 * What is mirrored is the set of ACCEPTED VALUES, because a `<select>` has to know
 * what to offer. That is a copy, and it is the same forced copy `resubmission.ts`
 * records: the backend's `PROPOSAL_STAGES` and `PROPOSAL_OUTCOME_FILTERS` live in
 * `src/db/schema.ts` and `src/api/proposal-query.ts`, which pull in the Worker's D1
 * types and break `tsc -b` for the dashboard (the failure `dashboard/src/derive.ts`
 * records and the reason `staleness.ts` had to be written with zero imports).
 *
 * ⚠ THE COPY FAILS SAFE RATHER THAN SILENTLY. An unrecognised value in the URL is
 * DROPPED rather than sent, so the worst outcome of drift is an unfiltered page --
 * never a 400 on load, and never a filter the reader believes is applied and is
 * not. The backend still refuses anything it does not recognise, so nothing here is
 * the guard; this is the affordance.
 */

import type {
  ProposalOutcomeFilter,
  ProposalPageInfo,
  ProposalRecordSummary,
  ProposalStage,
} from "./api/research-types";
import type { ProposalFilters } from "./api/client";
import { formatAge } from "./proposal";

/** The stages `GET /api/proposals` accepts. Mirrors `PROPOSAL_STAGES`. */
export const HISTORY_STAGES: readonly ProposalStage[] = ["assess", "derive"];

/**
 * The outcome filters `GET /api/proposals` accepts. Mirrors
 * `PROPOSAL_OUTCOME_FILTERS`.
 *
 * ⚠ `pending` IS THE ONE THAT MATTERS AND IS NOT A STORED VALUE. Migration 0009:
 * *"`outcome IS NULL` IS 21.5's 'ignored', read after the fact"*. The whole reason
 * requirement 5 says *"including the ones nobody acts on"* is that "the system kept
 * proposing things nobody wanted" is invisible if only decisions are listable.
 */
export const HISTORY_OUTCOMES: readonly ProposalOutcomeFilter[] = [
  "approved",
  "rejected",
  "pending",
];

/**
 * The page size this view asks for.
 *
 * Well inside the backend's maximum on purpose. The backend REFUSES an oversized
 * limit rather than clamping it (a clamped page looks complete and paging on from
 * it skips records), so a page size chosen here that drifted past the cap would
 * 400 on load rather than degrade -- which is the right failure, and a reason to
 * stay far from the edge.
 */
export const HISTORY_PAGE_SIZE = 25;

export interface HistoryFilters {
  readonly accountLabel: string | null;
  readonly stage: ProposalStage | null;
  readonly outcome: ProposalOutcomeFilter | null;
}

export interface HistoryQuery extends HistoryFilters {
  readonly offset: number;
}

/**
 * Read the view's state out of the URL, keeping only what the backend accepts.
 *
 * `useSearchParams`, the way `pages/Alerts.tsx` does it and for its stated reasons:
 * a filtered view is deep-linkable, the back button works, and a link can point at
 * one -- which matters more here than there, because "every proposal on this
 * account that nobody acted on" is a question worth sending someone.
 *
 * ⚠ AN UNRECOGNISED VALUE BECOMES `null`, NOT AN ERROR. A hand-edited or
 * out-of-date URL yields an unfiltered page rather than a refusal, and the select
 * shows "All" -- so what is on screen and what was asked for always agree.
 */
export function historyFiltersFrom(params: URLSearchParams): HistoryFilters {
  const accountLabel = params.get("accountLabel");
  const stage = params.get("stage");
  const outcome = params.get("outcome");
  return {
    accountLabel: accountLabel === null || accountLabel.trim() === "" ? null : accountLabel.trim(),
    stage: HISTORY_STAGES.includes(stage as ProposalStage) ? (stage as ProposalStage) : null,
    outcome: HISTORY_OUTCOMES.includes(outcome as ProposalOutcomeFilter)
      ? (outcome as ProposalOutcomeFilter)
      : null,
  };
}

/** Digits and nothing else. The same rule the backend's `parseCount` applies. */
const NON_NEGATIVE_INTEGER = /^\d+$/;

/**
 * The offset in the URL, falling back to the first page unless it is a real
 * non-negative integer written in plain digits.
 *
 * ⚠ MATCHED AS TEXT AND THEN CONVERTED, NOT CONVERTED AND THEN CHECKED. The
 * obvious `Number.isInteger(Number(raw))` **accepts `"1e3"`**, because
 * `Number("1e3")` is exactly 1000 — a real hole this module's own test found, in
 * both this function and the backend's, on the first run. It also accepts `"5.0"`,
 * `"+5"` and `"0x10"`.
 *
 * The consequence here is milder than on the backend (an offset has no cap, so the
 * worst case is a page nobody asked for) but the rule is the same one and there is
 * no reason for the two to differ.
 */
export function historyOffsetFrom(params: URLSearchParams): number {
  const raw = params.get("offset");
  if (raw === null) return 0;
  const trimmed = raw.trim();
  const parsed = Number(trimmed);
  if (!NON_NEGATIVE_INTEGER.test(trimmed) || !Number.isSafeInteger(parsed)) return 0;
  return parsed;
}

export function historyQueryFrom(params: URLSearchParams): HistoryQuery {
  return { ...historyFiltersFrom(params), offset: historyOffsetFrom(params) };
}

/**
 * The query as `fetchProposals` arguments.
 *
 * ⚠ AN ABSENT FILTER IS AN ABSENT KEY, never `undefined` and never `""`. The client
 * only sets a parameter it was given, and the backend refuses an empty
 * `accountLabel` outright -- an empty filter is not the same request as no filter,
 * and guessing which was meant is what `researchParams` refuses one layer up.
 */
export function historyFetchArgs(query: HistoryQuery): ProposalFilters {
  return {
    ...(query.accountLabel === null ? {} : { accountLabel: query.accountLabel }),
    ...(query.stage === null ? {} : { stage: query.stage }),
    ...(query.outcome === null ? {} : { outcome: query.outcome }),
    limit: HISTORY_PAGE_SIZE,
    offset: query.offset,
  };
}

/** A stable key for the query, so changing a filter remounts and refetches at once. */
export function historyKey(query: HistoryQuery): string {
  return [query.accountLabel ?? "", query.stage ?? "", query.outcome ?? "", query.offset].join("|");
}

/**
 * The next URL parameters after a filter change.
 *
 * ⚠ CHANGING A FILTER RESETS THE OFFSET TO 0, and forgetting that is the classic
 * bug in this shape: a reader on page 5 of 312 records who narrows to one account
 * with 3 records would land on page 5 of 3 and see an empty table, which reads as
 * "this account has no proposals" about an account that has three.
 */
export function withHistoryFilter(
  params: URLSearchParams,
  key: "accountLabel" | "stage" | "outcome",
  value: string,
): URLSearchParams {
  const next = new URLSearchParams(params);
  if (value === "") next.delete(key);
  else next.set(key, value);
  next.delete("offset");
  return next;
}

/** The next URL parameters for a different page. Offset 0 is the absent default. */
export function withHistoryOffset(params: URLSearchParams, offset: number): URLSearchParams {
  const next = new URLSearchParams(params);
  if (offset <= 0) next.delete("offset");
  else next.set("offset", String(offset));
  return next;
}

export interface HistoryPagination {
  /** 1-based, for humans. */
  readonly page: number;
  readonly pages: number;
  /** 1-based index of the first row on this page, or 0 when the page is empty. */
  readonly from: number;
  /** 1-based index of the last row on this page, or 0 when the page is empty. */
  readonly to: number;
  readonly total: number;
  readonly hasPrevious: boolean;
  readonly hasNext: boolean;
  readonly previousOffset: number;
  readonly nextOffset: number;
  /** "26–50 of 312", or "no proposals". Built here so the page prints one string. */
  readonly summary: string;
}

/**
 * Turn the backend's page facts into what a pager renders.
 *
 * ⚠ `hasNext` IS THE BACKEND'S OWN `hasMore`, NOT A RECOMPUTATION. It is computed
 * there from `offset + returned < total` -- what actually came back, not what was
 * asked for -- and the two formulas differ on exactly the case that occurs on every
 * complete browse: the last page. Recomputing it here would be a second
 * implementation of a comparison whose failure mode is a next button that returns
 * nothing, which is precisely the class of duplicate `proposalSummary.ts` refuses
 * for concentration.
 *
 * ⚠ `pages` IS DERIVED AND IS ONLY AS GOOD AS `total`, which the backend counts in
 * a second query at a slightly different instant from the page read. A row written
 * between the two makes the count one larger than the page it describes. Stated
 * rather than hidden: the only writer is a real `/assess` or `/derive` call, so the
 * drift is one row per real paid inference and never a reordering of anything
 * already read.
 */
export function historyPagination(page: ProposalPageInfo): HistoryPagination {
  const limit = Math.max(1, page.limit);
  const pages = Math.max(1, Math.ceil(page.total / limit));
  const current = Math.floor(page.offset / limit) + 1;
  const from = page.returned === 0 ? 0 : page.offset + 1;
  const to = page.returned === 0 ? 0 : page.offset + page.returned;

  return {
    page: current,
    pages,
    from,
    to,
    total: page.total,
    hasPrevious: page.offset > 0,
    hasNext: page.hasMore,
    previousOffset: Math.max(0, page.offset - limit),
    nextOffset: page.offset + limit,
    summary:
      page.total === 0
        ? "no proposals"
        : page.returned === 0
          ? `no proposals on this page — ${page.total} in total`
          : `${from}–${to} of ${page.total}`,
  };
}

/**
 * How a row's outcome reads, and it is three states rather than two.
 *
 * ⚠ `pending` IS NOT "nothing here", and rendering it as an empty cell would be the
 * fault decision log 49 PART 3 names: an unestablished state rendering as an
 * established one. It is the state 21.5 requirement 5 exists to measure -- *"the
 * system kept proposing things nobody wanted"* -- so it gets a word, a colour and a
 * count, not a blank.
 *
 * ⚠ AND THE HONEST QUALIFICATION TRAVELS WITH IT, unchanged from migration 0009: a
 * proposal made thirty seconds ago also has no outcome, so `pending` on a fresh row
 * means "not yet" and on an old one means "nobody did". **No threshold is invented
 * here to tell them apart** -- the same stance `proposal.ts` takes on the absent
 * liquidity test and `staleness.ts` takes on its own numbers. The age is printed
 * beside it and the reader draws the line.
 */
export type OutcomeDisplay = "approved" | "rejected" | "pending";

export const OUTCOME_LABEL: Readonly<Record<OutcomeDisplay, string>> = Object.freeze({
  approved: "approved",
  rejected: "rejected",
  pending: "no decision",
});

export const OUTCOME_CLASS: Readonly<Record<OutcomeDisplay, string>> = Object.freeze({
  approved: "border-emerald-500/40 bg-emerald-500/10 text-emerald-300",
  rejected: "border-zinc-600 bg-zinc-800/60 text-zinc-300",
  // Amber rather than grey: "nobody acted" is the finding, not the absence of one.
  pending: "border-amber-500/40 bg-amber-500/10 text-amber-200",
});

export const OUTCOME_TITLE: Readonly<Record<OutcomeDisplay, string>> = Object.freeze({
  approved: "A human created a real bot from this proposal (POST /api/bots with its id).",
  rejected: "A human read this proposal and recorded a decision against it.",
  pending:
    "No decision has been recorded. That is spec 21.5's \"ignored\", read after the fact — " +
    "nothing ever writes that word. A proposal made moments ago also has no decision yet, " +
    "so read this beside the age rather than as a verdict.",
});

export function outcomeDisplayOf(record: ProposalRecordSummary): OutcomeDisplay {
  // `outcome !== null` FIRST, so a value this dashboard does not recognise falls to
  // a recorded decision rather than to `pending` — `concentrationVerdictOf`'s
  // ordering rule, for its reason: the fail-safe direction is the one that does not
  // report an unresolved proposal about a resolved one.
  if (record.outcome === null) return "pending";
  return record.outcome === "approved" ? "approved" : "rejected";
}

/**
 * One row of the history table, as strings.
 *
 * `pendingMs` is rendered only when a decision exists, because the backend only
 * publishes it then -- "how long it sat" is not a finished quantity while it is
 * still sitting. For a row with no decision the AGE is shown instead, computed from
 * `createdAt` against a clock the caller passes in, so the table never has to
 * pretend a running total is a settled one.
 */
export interface HistoryRow {
  readonly id: string;
  readonly pair: string;
  readonly accountLabel: string;
  readonly stage: ProposalStage;
  readonly strategy: string;
  readonly outcome: OutcomeDisplay;
  readonly outcomeLabel: string;
  readonly createdAt: number;
  /** "38.7s" once resolved; `null` while still pending. */
  readonly pendingLabel: string | null;
  /** "3d 4h" — how long ago it was made. Always present. */
  readonly ageLabel: string;
  /** The bot a human really created from it, when there is one. */
  readonly botInstanceId: string | null;
  readonly href: string;
}

export function historyRowOf(record: ProposalRecordSummary, now: number): HistoryRow {
  const outcome = outcomeDisplayOf(record);
  return {
    id: record.id,
    pair: record.pair,
    accountLabel: record.accountLabel,
    stage: record.stage,
    strategy: record.strategy,
    outcome,
    outcomeLabel: OUTCOME_LABEL[outcome],
    createdAt: record.createdAt,
    // Published by the backend only once a decision exists. Not recomputed here:
    // `outcome_at - created_at` is the record's own arithmetic and a second copy
    // could disagree with the figure the detail page shows.
    pendingLabel: record.pendingMs === null ? null : formatAge(record.pendingMs),
    ageLabel: formatAge(now - record.createdAt),
    botInstanceId: record.outcomeBotInstanceId,
    href: proposalRecordHref(record.id),
  };
}

/** Where a row links. One place, so the list and every other link agree. */
export function proposalRecordHref(id: string): string {
  return `/proposals/${encodeURIComponent(id)}`;
}

/**
 * Where a reader goes to ask about this pair again, and it is a bare link.
 *
 * ⚠ IT CARRIES NO QUERY PARAMETERS, AND THAT IS DELIBERATE RATHER THAN LAZY.
 * `pages/ProposalRun.tsx` does not read `useSearchParams` — its account, pair and
 * interval are `useState("")`. Putting `?accountLabel=…&pair=…` on this href would
 * therefore be a field accepted and ignored, which is the exact fault this project
 * refuses in three other places: `parseResubmittedAssessment` refuses an object
 * citation because *"a field accepted and ignored reads exactly like one that was
 * used"*, and decision log 46 refused to surface `proposal_not_derivable` on a page
 * that cannot produce it. A URL that looks prefilled and lands on an empty form is
 * worse than one that plainly is not, so the copy beside the link names the account
 * and the pair instead and the reader retypes two fields.
 *
 * ⚠ IT GOES TO A FORM AND PRESSES NOTHING. That page states the cost — two paid
 * inferences and two permanent rows per press — and requires a deliberate press,
 * which is decision log 46's whole design for it. Producing a proposal from a
 * history page with one click would put the spend one click closer than that step
 * decided it should be.
 *
 * ⚠ AND IT IS OFFERED ONLY FOR A PENDING RECORD. For a resolved one there is
 * nothing left to decide: the decision is made and this system will not record a
 * second one (`outcome IS NULL` is in the UPDATE's WHERE clause). Re-running is
 * still possible from the run page itself; it is simply not something history
 * invites.
 *
 * ⚠ AND NOTHING FROM THE OLD PROPOSAL IS CARRIED ACROSS. A fresh run gathers its
 * own data and asks the model again; carrying a stored parameter into it would be a
 * proposal supplying a value, which is what decision log 45 argued the record must
 * never do.
 */
export const RERUN_HREF = "/proposal/run";

export function rerunHref(record: ProposalRecordSummary): string | null {
  return record.outcome === null ? RERUN_HREF : null;
}
