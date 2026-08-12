/**
 * The two deterministic reads the proposal view makes over a real `/derive`
 * response: WHEN its data was fetched, and WHAT its data does not cover.
 *
 * Pure functions, no React, no I/O, no clock of their own (`now` is passed in),
 * so the same discipline `format.ts` and `derive.ts` keep applies here: nothing
 * below constructs a float, invents a value, or reaches the network.
 *
 * ── WHY THESE ARE COMPUTED HERE RATHER THAN ASKED OF THE MODEL ──
 *
 * Both answers are already in the fetched data. `truncated`, `missingHistoryMs`,
 * `count`, the news slot's `outcome`, the candidate's `sources` and every fetch
 * timestamp are FACTS the backend collected, and a model's prose about them is a
 * rendering whose accuracy is the thing in question (21.5 requirement 2). Stage 2
 * is asked to state thin evidence as a claim and generally does; that claim is
 * shown too, beside these. The difference is that these cannot be forgotten by a
 * model having an off run.
 *
 * ── ⚠ SCOPE: NOTHING HERE IS PERSISTED ──
 *
 * Spec 21.5 requirement 5 (full audit logging of every proposal, its inputs, its
 * reasoning and its outcome) is NOT satisfied, NOT partially satisfied and NOT
 * begun by this module or anything that calls it. There is no storage, no D1
 * write and no `audit_log` entry anywhere in this stage -- it is a deliberately
 * separate, later step. See `components/ProposalView.tsx` for the same statement
 * where the assembly happens.
 */

import type {
  CandidateGatherBundle,
  DeriveContext,
  DeriveResponse,
  EvidenceItem,
} from "./api/research-types";

// ---------------------------------------------------------------------------
// Freshness (21.5 requirement 4)
// ---------------------------------------------------------------------------

/**
 * One real fetch time, or the honest statement that this input has none.
 *
 * `at: null` is NOT "unknown when": it means the input never successfully
 * produced a value, so there is no moment a venue or a table answered. A slot
 * that failed carries `failedAt` -- when the failure was OBSERVED -- and that is
 * a different fact from a fetch time, so it is reported as `observedAt` under
 * its own label rather than quietly filling the column.
 */
export interface FetchTimestamp {
  readonly key: string;
  readonly label: string;
  /** When the venue or table actually answered. Null when it never did. */
  readonly at: number | null;
  /** When the failure was observed, on the arms that have one. */
  readonly observedAt: number | null;
  /** Why this particular timestamp matters to someone deciding right now. */
  readonly why: string;
  readonly note: string | null;
}

/**
 * A time this system did something, which is NOT a fetch time.
 *
 * Carried separately and labelled, because 21.5 requirement 4 asks for the fetch
 * time specifically and `assembledAt`/`gatheredAt`/`selectedAt` are the three
 * values most likely to be mistaken for one. `serialize.ts` says so at each of
 * them; this is the same statement at the point a human reads it.
 */
export interface AssemblyTimestamp {
  readonly key: string;
  readonly label: string;
  readonly at: number;
  readonly note: string;
}

export interface Freshness {
  /** Every real fetch time, in the order a reviewer should weigh them. */
  readonly fetches: readonly FetchTimestamp[];
  /**
   * The price-history fetch, called out because it is the one that decides
   * whether a proposal is worth reading at all.
   */
  readonly priceFetch: FetchTimestamp;
  /**
   * The OLDEST real fetch among the inputs that produced one -- the bound on the
   * whole proposal's freshness, since a proposal is no fresher than its stalest
   * input. Null when no input produced a fetch time at all.
   */
  readonly oldest: FetchTimestamp | null;
  readonly assembly: readonly AssemblyTimestamp[];
}

/**
 * Which timestamps matter, and why each one is here rather than a chosen single
 * value.
 *
 * FOUR REAL FETCH TIMES EXIST and they age at completely different rates, so
 * collapsing them to one number would be picking arbitrarily and calling it the
 * answer:
 *
 *   1. PRICE HISTORY (`candles.value.fetchedAt`) -- the fastest-moving input by
 *      far, and the one every proposed number is denominated against: bounds, an
 *      order size, a reference price. A ten-minute gap moved `candles.last_close`
 *      by 17.60 in the live run behind decision log 42. This is the headline.
 *   2. CAPITAL LEDGER (`context.capital.value.readAt`) -- second, because
 *      `allocatedCapital` is a PREFILL checked against the real ledger at
 *      creation time. A stale figure here does not create a bad bot; it creates a
 *      form that fails validation, which is a nuisance rather than a risk.
 *   3. BOT LIST (`concentration.value.readAt`) -- the over-concentration read.
 *      Changes only when a human starts or stops a bot, so it ages slowly, but
 *      it is what the prominent flag above rests on and a reviewer weighing that
 *      flag should be able to see when it was true.
 *   4. VENUE TRADING RULES (`context.filters.value.fetchedAt`) -- slowest-moving
 *      of the four. Tick and step sizes change rarely; listed for completeness
 *      rather than because it is likely to be the problem.
 *
 * `oldest` is then computed across all four, because whichever of them is
 * stalest is the real age of the proposal as a whole.
 */
export function freshnessOf(response: DeriveResponse): Freshness {
  const { bundle, context } = response;

  const candles = bundle.candles;
  const priceFetch: FetchTimestamp = {
    key: "candles",
    label: "Price history fetched",
    at: candles.outcome === "ok" ? candles.value.fetchedAt : null,
    observedAt: candles.outcome === "ok" ? null : candles.failedAt,
    why: "Every proposed price, bound and order size is denominated against this window. It is the fastest-moving input and the one most likely to have moved since.",
    note:
      candles.outcome === "ok"
        ? `${candles.value.count} candle(s) at the ${candles.value.interval} interval`
        : "The candle fetch produced no window, so there is no fetch time.",
  };

  const concentration = bundle.concentration;
  const capital = context.capital;
  const filters = context.filters;

  const fetches: readonly FetchTimestamp[] = [
    priceFetch,
    {
      key: "capital",
      label: "Capital ledger read",
      at: capital.outcome === "ok" ? capital.value.readAt : null,
      observedAt: capital.outcome === "ok" ? null : capital.failedAt,
      why: "The headroom the proposed allocation was sized against. It is a PREFILL a human confirms, and the real check runs against the ledger again at creation.",
      note: capital.outcome === "ok" ? `${capital.value.assets.length} asset row(s)` : null,
    },
    {
      key: "concentration",
      label: "Account bot list read",
      at: concentration.outcome === "ok" ? concentration.value.readAt : null,
      observedAt: concentration.outcome === "ok" ? null : concentration.failedAt,
      why: "What the over-concentration flag above rests on. It changes only when a bot is started or stopped, so it ages slowly.",
      note:
        concentration.outcome === "ok"
          ? `${concentration.value.rowsRead} bot row(s) read`
          : null,
    },
    {
      key: "filters",
      label: "Venue trading rules fetched",
      at: filters.outcome === "ok" ? filters.value.fetchedAt : null,
      observedAt: filters.outcome === "ok" ? null : filters.failedAt,
      why: "Tick size, step size and the minimum-order floor the proposal was checked against. The slowest-moving of the four.",
      note: filters.outcome === "ok" ? `symbol status ${filters.value.status}` : null,
    },
  ];

  const dated = fetches.filter((f): f is FetchTimestamp & { at: number } => f.at !== null);
  const oldest =
    dated.length === 0
      ? null
      : dated.reduce((worst, candidate) => (candidate.at < worst.at ? candidate : worst));

  const assembly: readonly AssemblyTimestamp[] = [
    {
      key: "selectedAt",
      label: "Candidate selected",
      at: response.selectedAt,
      note: "When this request resolved the pair to a candidate. Not a fetch.",
    },
    {
      key: "assembledAt",
      label: "Stage 1 bundle assembled",
      at: bundle.assembledAt,
      note: "When assembly ran, NOT when any of the data was fetched (21.5 requirement 4).",
    },
    {
      key: "gatheredAt",
      label: "Stage 3 extra reads ran",
      at: context.gatheredAt,
      note: "When the capital and filters reads were made, NOT when their data was fetched.",
    },
  ];

  return { fetches, priceFetch, oldest, assembly };
}

/**
 * A duration in milliseconds as a short human age ("4m 12s ago" -> "4m 12s").
 *
 * Integer arithmetic on an integer input; no float and no `Intl.RelativeTime`
 * rounding that would turn 89 seconds into "a minute". A negative input -- a
 * fetch time ahead of this browser's clock, which real clock skew produces --
 * is reported as exactly that rather than rendered as a large positive age.
 */
export function formatAge(ms: number): string {
  if (ms < 0) return `${formatAge(-ms)} in the future (clock skew)`;
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes}m ${seconds}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

// ---------------------------------------------------------------------------
// Data limits (21.3's hype hazard, and honest reporting of what is not covered)
// ---------------------------------------------------------------------------

/**
 * One thing the data behind this proposal does not cover, stated plainly.
 *
 * `evidenceIds` names the ids that SHOW it, so a reviewer can find the same fact
 * in the raw evidence rather than taking this line's word for it -- the same
 * standard the citation machinery holds the model to.
 */
export interface DataLimit {
  readonly key: string;
  readonly headline: string;
  readonly detail: string;
  readonly evidenceIds: readonly string[];
}

/**
 * Every limited-history / missing-input / provenance fact, read from the bundle.
 *
 * ── ⚠ NO THRESHOLD IS INVENTED HERE, AND THAT IS THE DESIGN ──
 *
 * Spec 21.3 names three hazards: limited price history, thin liquidity, and
 * hype-driven interest. Two of the three are decidable from data this system
 * really has:
 *
 *   - LIMITED HISTORY is decidable exactly. `truncated` and `missingHistoryMs`
 *     are the venue's own report that the window is shallower than was asked
 *     for, and `requestedSince: null` means no depth was asked for at all.
 *   - HYPE-DRIVEN INTEREST is decidable from provenance: a `trending` source
 *     means the candidate arrived because it was popular. The prompt already
 *     tells the model that is not evidence (`RULE_PROVENANCE_IS_NOT_EVIDENCE`);
 *     this states it to the human too.
 *
 * THIN LIQUIDITY IS NOT DECIDABLE HERE AND IS NOT GUESSED AT. There is no
 * liquidity threshold anywhere in this system -- not in the spec, not in
 * `concentration.ts`'s policy, not in the venue filters -- and picking one in a
 * rendering layer would be inventing a risk rule in the place least equipped to
 * own it, then presenting its verdict as a finding. So the volume figures are
 * surfaced as raw data with the absence of any test stated outright
 * (`no_liquidity_test`), and the judgement stays with the human. An unstated
 * gap is the failure mode; a stated one is a limitation.
 */
export function dataLimits(bundle: CandidateGatherBundle, context: DeriveContext): readonly DataLimit[] {
  const limits: DataLimit[] = [];
  const candles = bundle.candles;

  if (candles.outcome !== "ok") {
    limits.push({
      key: "no_price_history",
      headline: "No price history at all",
      detail: `The candle fetch produced no usable window (${candles.error.message}). No price, high, low or volume figure exists for this coin in this run.`,
      evidenceIds: ["candles.status"],
    });
  } else {
    const window = candles.value;

    if (window.truncated) {
      const missing =
        window.missingHistoryMs === null
          ? "The venue did not say how much is missing."
          : `About ${formatAge(window.missingHistoryMs)} of the requested range is missing off the front.`;
      limits.push({
        key: "truncated_history",
        headline: "The price history is SHALLOWER than this run asked for",
        detail: `The venue could not reach back as far as requested. ${missing} Every claim and every bound below was reasoned from this shorter window, not from the one that was asked for.`,
        evidenceIds: ["candles.truncated", "candles.missing_history_ms", "candles.count"],
      });
    }

    if (window.requestedSince === null) {
      limits.push({
        key: "no_depth_requested",
        headline: "No history depth was requested",
        detail:
          "This run took the venue's own recent window rather than asking for a specific range, so the depth below is whatever the venue chose to return -- not a decision anyone made about how much history this judgement needs.",
        evidenceIds: ["candles.requested_since", "candles.count"],
      });
    }

    const inProgress = window.candles.filter((candle) => !candle.closed).length;
    if (inProgress > 0) {
      limits.push({
        key: "in_progress_candles",
        headline: `${inProgress} candle(s) in this window have not closed yet`,
        detail:
          "An open candle's high, low, close and volume are partial and will change. Any aggregate computed across the window includes them.",
        evidenceIds: ["candles.in_progress", "candles.count"],
      });
    }

    limits.push({
      key: "no_liquidity_test",
      headline: "Liquidity was NOT assessed -- this system has no liquidity test",
      detail: `Spec 21.3 names thin liquidity as a hazard, and nothing in this system decides it: there is no volume threshold in the spec, in the concentration policy, or in the venue's filters. Total volume across the window (${window.candles.length} candle(s)) is in the raw evidence as candles.volume_total; whether it is thin is your judgement, and no part of this proposal has made it.`,
      evidenceIds: ["candles.volume_total", "candles.count", "candles.interval"],
    });
  }

  limits.push({
    key: "no_news",
    headline: "No news or sentiment was collected",
    detail: `${bundle.news.reason} (see decision log ${bundle.news.decisionLogEntry}). This is NOT evidence that there is no news about this asset, and it must not be read as a quiet market.`,
    evidenceIds: ["news.status"],
  });

  if (bundle.concentration.outcome !== "ok") {
    limits.push({
      key: "concentration_unknown",
      headline: "The over-concentration check did not run",
      detail: `${bundle.concentration.error.message}. What this account already holds is UNKNOWN for this proposal -- which is not the same as it holding nothing.`,
      evidenceIds: ["concentration.status"],
    });
  }

  if (context.capital.outcome !== "ok") {
    limits.push({
      key: "capital_unknown",
      headline: "The capital ledger could not be read",
      detail: `${context.capital.error.message}. The account's real headroom is UNKNOWN.`,
      evidenceIds: ["capital.status"],
    });
  } else if (context.capital.value.assets.length === 0) {
    limits.push({
      key: "capital_none",
      headline: "This account has no capital ledger row for any asset",
      detail:
        "The read succeeded and found nothing. No bot on this account can be funded at all until a row is seeded. This is NOT a failed read.",
      evidenceIds: ["capital.status"],
    });
  }

  if (context.filters.outcome !== "ok") {
    limits.push({
      key: "filters_unknown",
      headline: "The pair's venue trading rules could not be read",
      detail: `${context.filters.error.message}. The minimum-order floor, tick size and step size this proposal would have to satisfy are UNKNOWN.`,
      evidenceIds: ["filters.status"],
    });
  }

  for (const source of bundle.candidate.sources) {
    if (source.kind === "trending") {
      limits.push({
        key: `trending_${source.pullId}`,
        headline: "This candidate arrived from a TRENDING pull",
        detail: `Vendor ${source.vendor}, coin ${source.coinId} (${source.symbol}), rank ${source.rank === null ? "not published" : source.rank}. Trending measures attention, not quality, and it is disproportionately newly-listed and thinly-traded coins. It is not a reason for confidence and no claim below may treat it as one (spec 21.3).`,
        evidenceIds: ["candidate.source.1"],
      });
    }
  }

  return limits;
}

/**
 * The evidence items a set of claims and per-field citations actually cited.
 *
 * Returned as a Set of ids so the raw-evidence panel can show the DIFFERENCE
 * between what was offered and what was used. 21.5 requirement 2 wants the full
 * source data shown, and `serialize.ts` publishes it for a specific reason:
 * "what the model ignored is visible from the difference". That difference is
 * only visible if something computes it.
 */
export function citedIds(...groups: readonly (readonly EvidenceItem[])[]): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const group of groups) {
    for (const item of group) ids.add(item.id);
  }
  return ids;
}
