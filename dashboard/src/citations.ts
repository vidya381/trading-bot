/**
 * CITATION CLASSIFICATION -- decision log 43's requirement on Stage 4, implemented.
 *
 * ── WHY THIS MODULE EXISTS ──
 *
 * Entry 43 decided NOT to build a parser-level distinction between kinds of
 * citation, and placed the requirement here instead, in the layer that speaks to
 * a human. Quoting it, because this file is the thing it was written about:
 *
 *   > Stage 4's presentation layer MUST be designed with explicit awareness that
 *   > a citation may point to (a) real fetched data, (b) an absence marker, or
 *   > (c) a prior stage's own claim -- and MUST describe these differently to a
 *   > human reader rather than rendering all three as interchangeable "here is
 *   > the source" citations.
 *
 * It is a requirement ON this layer, not a suggestion it may weigh against its
 * own convenience, and the entry says why in one sentence: a reviewer who cannot
 * tell that a parameter rests on a non-observation, or on another model's
 * judgement rather than on a fetched number, is being shown a proposal that
 * looks better grounded than it is.
 *
 * (b) AND (c) ARE NOT WEAKER CITATIONS AND THIS MODULE DOES NOT DEMOTE THEM.
 * Both were sound on live inspection ("I set no take-profit target because I
 * have no news signal" is honest). The requirement is only to stop them reading
 * as (a).
 *
 * ── THE RULE, TRACED FROM SOURCE ──
 *
 * `EvidenceItem.source` already carries the classification with no new backend
 * field -- which is what made entry 43's "change nothing in the parser" decision
 * coherent rather than merely deferred. Every `source` string this system can
 * emit, read from `src/research/assess-prompt.ts` and
 * `src/research/derive-prompt.ts`:
 *
 *   (c) PRIOR STAGE'S OWN CLAIM  -- `collectAssessment` (derive-prompt.ts)
 *       `assessment.strategy`, `assessment.claims[N]`
 *
 *   (b) ABSENCE MARKER          -- the paused news slot and the four failed-read arms
 *       `news`                                    (collectNews, assess-prompt.ts)
 *       `candles.error`                           (collectCandles)
 *       `concentration.error`                     (collectConcentration)
 *       `capital.error`                           (collectCapital, derive-prompt.ts)
 *       `filters.error`                           (collectFilters, derive-prompt.ts)
 *
 *   (a) REAL FETCHED OR COMPUTED DATA -- everything else
 *       `candidate.pair`, `candidate.sources[N]`, `candles.outcome`,
 *       `candles.value.*`, `concentration.outcome`, `concentration.value.*`,
 *       `capital.outcome`, `capital.value.*`, `filters.outcome`,
 *       `filters.value.*`, `assembledAt`, `gatheredAt`
 *
 * ── TWO PRECISIONS, because a near-miss rule would be worse than none ──
 *
 * 1. THE NEWS TEST IS EXACT EQUALITY, NOT A PREFIX. The paused slot's source is
 *    the literal string `"news"`. Matching `source.startsWith("news")` would be
 *    correct today and WRONG the moment a news vendor is chosen (entry 30): that
 *    slot would emit `news.value.*` for real fetched headlines, and a prefix test
 *    would label genuine data an absence marker -- the exact inversion this file
 *    exists to prevent. A future `news.error` is caught by the rule below anyway.
 *
 * 2. THE FAILED-READ TEST IS A SUFFIX, NOT A HARDCODED SET OF FOUR. Today
 *    `.error` matches exactly `candles.error`, `concentration.error`,
 *    `capital.error` and `filters.error`. It is written as a suffix because a
 *    fifth slot added later (a news vendor, a trending vendor) follows the same
 *    convention and would be classified correctly without an edit here, and
 *    because NO non-error source can collide with it: every other source is a
 *    path into a value (`candles.value.fetchedAt`) or an outcome discriminant
 *    (`candles.outcome`), and none ends in `.error`.
 *
 * ── ⚠ TWO REAL BRANCHES THIS RULE CLASSIFIES AS (a) THOUGH THEY READ AS ABSENCE ──
 *
 * Recorded rather than silently worked around, because entry 43's table is the
 * specified rule and deviating from it here would be this layer rediscovering
 * the decision independently -- which the entry explicitly forbids. Both are
 * flagged for the operator:
 *
 *   1. `collectCandles`' empty-window branch emits `candles.status` with the
 *      value `"MISSING -- the candle slot reports success but carries no candles
 *      at all..."` and the source `candles.value.candles`. That is an absence
 *      rendered under an (a) source. `assess-prompt.ts` states the branch is
 *      unreachable (`fetchCandleWindow` refuses an empty answer with
 *      `no_candles_returned`) and is handled only so a fabricated price can never
 *      be printed from an empty window.
 *   2. `collectCapital`' zero-rows branch emits `capital.status` with the value
 *      `"NONE -- this account has no capital_ledger row for any asset..."` and
 *      the source `capital.value.assets`. This one is arguably correctly (a):
 *      the read SUCCEEDED and found nothing, and the value says so in its own
 *      words ("This is NOT a failed read").
 *
 * In both cases the rendered `value` still says MISSING/NONE in full and is shown
 * verbatim beside the class, so nothing is hidden from a reader either way.
 *
 * ── WHAT THIS MODULE DOES NOT DO ──
 *
 * It RE-VERIFIES NOTHING. `/assess` and `/derive` already resolved every citation
 * against the evidence their own run emitted (`resolveCitations`, and
 * `parseResubmittedAssessment` for a resubmission), and re-checking here would
 * duplicate step 42's work for no reason. This is presentation over data the
 * backend has already validated.
 */

import type { EvidenceItem } from "./api/research-types";

/**
 * The three kinds decision log 43 names, as (a), (b), (c) in its own order.
 *
 * A union rather than a boolean pair, so "an absence marker that is also a prior
 * claim" is unrepresentable and a future fourth kind has to be added on purpose.
 * Entry 43's reopening condition 1 is exactly a fourth kind appearing.
 */
export type CitationClass =
  /** (a) A real fetched or computed datum. */
  | "fetched_data"
  /** (b) A marker reporting that an input is absent: not collected, or failed. */
  | "absence_marker"
  /** (c) An earlier pipeline stage's own claim, carried forward as citable. */
  | "prior_stage_claim";

/** The prefix `collectAssessment` gives every id it emits. */
const PRIOR_STAGE_SOURCE_PREFIX = "assessment.";

/** The paused news slot's source, EXACTLY. See precision 1 in the header. */
const NEWS_ABSENCE_SOURCE = "news";

/** The suffix every failed-read arm's source carries. See precision 2. */
const FAILED_READ_SOURCE_SUFFIX = ".error";

/**
 * Classify one evidence item by its `source`, per decision log 43's table.
 *
 * Total: every string lands in exactly one class, and `fetched_data` is the
 * default rather than a fallback for the unrecognised -- which is the correct
 * default precisely because (a) is the large, open-ended class (every
 * `*.value.*` path) while (b) and (c) are small and named.
 */
export function classifyCitation(item: EvidenceItem): CitationClass {
  const source = item.source;
  if (source.startsWith(PRIOR_STAGE_SOURCE_PREFIX)) return "prior_stage_claim";
  if (source === NEWS_ABSENCE_SOURCE) return "absence_marker";
  if (source.endsWith(FAILED_READ_SOURCE_SUFFIX)) return "absence_marker";
  return "fetched_data";
}

/**
 * How each class is described to a human, in the words a reviewer needs.
 *
 * The three `short` labels are deliberately not three shades of the word
 * "source": entry 43's whole point is that "here is the source" said three times
 * is the failure. Each says what KIND of thing the value is.
 */
export interface CitationClassCopy {
  /** The badge text. */
  readonly short: string;
  /** One sentence a reviewer can act on, shown in the legend and on hover. */
  readonly explanation: string;
}

export const CITATION_CLASS_COPY: Readonly<Record<CitationClass, CitationClassCopy>> = {
  fetched_data: {
    short: "Fetched data",
    explanation:
      "A real value this run fetched or computed from fetched values -- a price, a count, a venue rule, a ledger figure. Check it against the raw data below.",
  },
  absence_marker: {
    short: "Absence marker",
    explanation:
      "NOT a datum. This records that an input is missing: a read that failed, or a slot nothing was collected from. A value resting on one rests on a non-observation, which the prompt's own rule calls UNKNOWN -- not good news, not bad news, not a quiet market.",
  },
  prior_stage_claim: {
    short: "Earlier stage's claim",
    explanation:
      "An earlier model stage's own judgement, carried forward as citable evidence -- not a fetched number. A value resting on one rests on another model's reasoning; the datum underneath it is one step further away.",
  },
};

/**
 * Tailwind classes per citation class.
 *
 * Colour is a SECOND channel, never the only one: every badge also carries its
 * `short` text, because a distinction a colour-blind reviewer cannot make is
 * the same as no distinction. Amber and violet rather than red, deliberately --
 * (b) and (c) are not errors and must not read as ones (entry 43: "the
 * requirement is not to hide or demote them").
 */
export const CITATION_CLASS_STYLE: Readonly<Record<CitationClass, string>> = {
  fetched_data: "border-zinc-700 bg-zinc-800/60 text-zinc-300",
  absence_marker: "border-amber-500/40 bg-amber-500/10 text-amber-300",
  prior_stage_claim: "border-violet-500/40 bg-violet-500/10 text-violet-300",
};

/**
 * The classes present in a set of citations, in (a),(b),(c) order.
 *
 * Order is fixed rather than first-seen so two fields with the same mix read
 * identically wherever they appear.
 */
export function classesIn(citations: readonly EvidenceItem[]): readonly CitationClass[] {
  const present = new Set(citations.map(classifyCitation));
  return (["fetched_data", "absence_marker", "prior_stage_claim"] as const).filter((c) =>
    present.has(c),
  );
}

/**
 * True when NOT ONE citation in the set is real fetched data.
 *
 * This is the field-level signal entry 43's worked examples are about. A
 * parameter citing both `candles.last_close` and `assessment.claim.2` rests on a
 * real number and is ordinary; a parameter citing ONLY `news.status`, or ONLY
 * `assessment.claim.3`, does not rest on any observation this run made, and that
 * is the thing a reviewer must not have to reconstruct by reading each badge.
 *
 * An empty set returns false: no citations at all is a different fault, and the
 * backend refuses it before a response exists (`RULE_CITE_EVERY_CLAIM`, and
 * `derive-parse.ts`'s per-field citation requirement), so it cannot arrive here.
 */
export function restsOnNoFetchedData(citations: readonly EvidenceItem[]): boolean {
  if (citations.length === 0) return false;
  return citations.every((item) => classifyCitation(item) !== "fetched_data");
}

/**
 * The sentence shown when `restsOnNoFetchedData` is true, worded for the mix.
 *
 * Three cases rather than one generic line, because "no news was collected" and
 * "an earlier stage judged the range tight" are different things to be uneasy
 * about and a reviewer should not have to work out which one they are looking at.
 */
export function noFetchedDataWarning(citations: readonly EvidenceItem[]): string {
  const classes = classesIn(citations);
  const hasAbsence = classes.includes("absence_marker");
  const hasPrior = classes.includes("prior_stage_claim");

  if (hasAbsence && hasPrior) {
    return "Rests on no fetched data: every citation is either a missing input or an earlier stage's judgement.";
  }
  if (hasAbsence) {
    return "Rests on no fetched data: every citation is a record that an input is MISSING or was NOT COLLECTED.";
  }
  if (hasPrior) {
    return "Rests on no fetched data: every citation is an earlier model stage's own claim, not a value this run observed.";
  }
  /* istanbul ignore next -- unreachable while the three classes are exhaustive. */
  return "Rests on no fetched data.";
}
