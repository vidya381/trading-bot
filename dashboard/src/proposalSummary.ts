/**
 * THE SUMMARY CARD'S DECISIONS — every one of them, in a React-free module.
 *
 * ── WHY THIS FILE EXISTS AT ALL ──
 *
 * The proposal page is long ON PURPOSE. Decision log 44 listed every evidence
 * item, cited or not, and put nothing behind a collapsed toggle, because *what
 * the model ignored is visible only from the difference*. Decision log 48 PART 10
 * recorded the cost of that in the operator's own words after live use — the page
 * runs 30+ printed pages, and the one control that leads out of it sat at the very
 * bottom — and named a summary card as the reconciliation, explicitly deferred to
 * its own step. This is that step.
 *
 * ⚠ A SUMMARY IS IN TENSION WITH ENTRY 44'S DECISION, NOT MERELY ADDITIONAL TO IT,
 * and pretending otherwise is how the tension gets resolved silently in the
 * summary's favour. The reconciliation this module is built to is narrow and is
 * worth stating before any of the code:
 *
 *   THE CARD ADDS A FAST PATH. IT REMOVES NOTHING. Every panel entry 44 built is
 *   still rendered, in the same order, with the same content, below it. The card
 *   answers "what was suggested, is it stale, is it safe to act on" — four facts a
 *   reviewer currently reconstructs by scrolling. It does not answer "was the data
 *   worth reasoning about", it does not summarise the evidence, and it does not
 *   summarise the reasoning. A reviewer who reads only this card has read less than
 *   one who scrolls, and the card says so on its face.
 *
 * ── WHY REACT-FREE, AND WHY THAT IS NOT A STYLE CHOICE ──
 *
 * The dashboard has no jsdom and no testing-library, and a test importing a `.tsx`
 * collects ZERO TESTS RATHER THAN FAILING inside the Workers pool this suite runs
 * in (decision logs 44, 45, 46, 48). `proposalFields.ts` was extracted for exactly
 * this reason after a mutation run proved its inline predecessor's guard call site
 * unreachable by any test: **a decision that cannot be tested is a decision nobody
 * is watching.**
 *
 * So every judgement the card makes lives here and is driven by the root suite. The
 * component is presentational: it maps over what this module returns.
 *
 * ── ⚠ NOTHING HERE DECIDES A VERDICT. IT READS THE ONES THAT ALREADY EXIST ──
 *
 * This is the property the whole card is judged on, and the failure would be
 * invisible: a badge reading "clean" beside a proposal the real check FLAGGED, or
 * "fresh" beside one the real policy calls STALE, is worse than no badge — it is a
 * reassurance the page has not earned, placed at the top where it is read first and
 * trusted most.
 *
 *   CONCENTRATION — `concentrationVerdictOf` reads `ConcentrationResult.assessment`,
 *   the BACKEND's own field, and the slot's own `outcome` discriminant. It applies
 *   no threshold, counts no bots and compares no capital share. There is no policy
 *   in this file to drift from `src/research/concentration.ts`.
 *
 *   STALENESS — `stalenessVerdictOf` composes `freshnessOf` and `stalenessFor`, the
 *   same two functions `ProposalFreshness` renders from, which compose the BACKEND's
 *   `stalenessOf`/`worstVerdict` over `DEFAULT_STALENESS_POLICY`. No threshold and
 *   no comparison is written here.
 *
 *   HEADLINE NUMBERS — `headlineFieldsOf` calls `proposalFieldsOf`, the same
 *   function `ProposalParameters` builds its full table from, and SELECTS from its
 *   result. It does not format a number of its own. A card that re-formatted
 *   `orderSize` could print a different string for the same value than the table
 *   forty lines below it, and the one a reviewer acted on would be whichever they
 *   read first.
 */

import type { DeriveResponse, ConcentrationResult, GatheredInput } from "./api/research-types";
import type { StalenessVerdict } from "../../src/research/staleness";
import type { ProposalStrategy } from "../../src/research/proposal-shape";
import { freshnessOf, stalenessFor } from "./proposal";
import { proposalFieldsOf, type FieldSpec } from "./proposalFields";
import { formatMoney } from "./format";

/**
 * ⚠ THREE STATES, AND COLLAPSING THE THIRD INTO "CLEAN" IS THE BUG THIS TYPE EXISTS
 * TO MAKE UNSPELLABLE.
 *
 *   `flagged` — the check ran and found something to weigh.
 *   `clean`   — the check ran and found nothing. A positive statement.
 *   `unknown` — the read FAILED or THREW, so whether this proposal would
 *               over-concentrate the account was never established.
 *
 * `ProposalConcentration` has rendered these as three distinct things since step
 * 44, and its header states the reason: *"an unknown is not a clean result, and the
 * failure mode this guards against is a reviewer glancing at a quiet strip and
 * reading 'nothing shown' as 'nothing there'."* A two-state badge at the TOP of the
 * page would reintroduce exactly that failure mode in the most prominent position
 * available, and it would do so on a page where `/assess` and `/derive` both
 * deliberately let a failed concentration read through rather than failing the
 * request.
 *
 * A boolean here would compile, render, and be wrong only when the D1 read failed —
 * which is to say, only in the case the badge exists for.
 */
export type ConcentrationVerdict = "flagged" | "clean" | "unknown";

/**
 * The concentration verdict, read from the response rather than computed.
 *
 * Every branch mirrors `ProposalConcentration`'s three, in the same order and off
 * the same two discriminants — the slot's `outcome` and the result's own
 * `assessment`. `assessment` is a value the BACKEND wrote after running
 * `src/research/concentration.ts`'s real policy against the real bot rows; this
 * function's entire job is to not lose it.
 *
 * ⚠ THE DEFAULT IS `unknown`, NOT `clean`. The final branch is reached only when
 * the check ran and `assessment` is not `flagged`, which today means it is
 * `clean` — but a slot that failed never reaches it, because `outcome` is tested
 * FIRST. Fail closed: an unrecognised outcome answers unknown.
 */
export function concentrationVerdictOf(
  concentration: GatheredInput<ConcentrationResult>,
): ConcentrationVerdict {
  if (concentration.outcome !== "ok") return "unknown";
  return concentration.value.assessment === "flagged" ? "flagged" : "clean";
}

/**
 * This proposal's staleness verdict, RIGHT NOW.
 *
 * `now` is a parameter and this module has no clock, for `staleness.ts`'s own
 * reason and for decision log 48 PART 3's: the verdict is a function of time, the
 * gap between a proposal being made and a human deciding on it is real and has been
 * measured at 7h 46m live, and a verdict computed once and carried would say
 * "fresh" about a moment nearly eight hours gone. The card recomputes on the same
 * 1-second tick `ProposalFreshness` and `ProposalPrefillBanner` already use.
 *
 * A thin composition and nothing more: `freshnessOf` pairs each of the four inputs
 * with its OWN threshold (the price threshold is per-strategy), `stalenessFor`
 * hands those triples to the backend's `stalenessOf`, and `worstVerdict` ranks
 * `stale` > `unknown` > `fresh`. Not one of those decisions is made here.
 */
export function stalenessVerdictOf(derive: DeriveResponse, now: number): StalenessVerdict {
  return stalenessFor(freshnessOf(derive), now).verdict;
}

/**
 * WHICH fields are the headline ones, per strategy.
 *
 * ⚠ THESE ARE A SELECTION FOR A CARD, NOT A STATEMENT THAT THE REST MATTER LESS.
 * 21.4 stage 3 requires a proposal to fill EVERY field the form requires, with
 * "nothing left as 'tune this yourself'", and `ProposalParameters` renders the full
 * list unconditionally below — this card links to it and the copy says the list is
 * partial. The three per strategy are the ones that answer "what shape of bot is
 * this, and how big", which is the question a reviewer asks before deciding whether
 * to read further.
 *
 * Field names are the REAL ones off `GridParams` / `DcaParams` in
 * `api/research-types.ts`, and they are checked against the backend's own
 * `GRID_PROPOSAL_FIELDS` / `DCA_PROPOSAL_FIELDS` by a test — a headline field
 * naming a key that no longer exists would render nothing and look like a proposal
 * with no numbers in it.
 */
export const HEADLINE_FIELDS: Readonly<Record<ProposalStrategy, readonly string[]>> = Object.freeze(
  {
    grid: Object.freeze(["lowerBound", "upperBound", "orderSize"]),
    dca: Object.freeze(["baseOrderSize", "additionalOrderSize", "dropPct"]),
  },
);

/**
 * The card's numbers, or none.
 *
 * `specs` is EMPTY whenever `shape.ok` is false, exactly as `proposalFieldsOf`
 * returns it, and the pairing is the point: a card cannot print headline numbers
 * for a params object that failed the shape check, because there are none to print.
 * Returning both together — rather than a check the caller then chooses to honour —
 * is what removed the untestable branch from `ProposalParameters`, and the same
 * reasoning applies here.
 */
export interface ProposalSummary {
  /** The validated strategy, or null when the params did not pass the shape check. */
  readonly strategy: ProposalStrategy | null;
  /** What the strategy label CLAIMS to be, for the failure copy. Always present. */
  readonly claimedStrategy: string;
  /** True only when the params passed `checkParamsShape`. */
  readonly ok: boolean;
  /** The headline field specs, in `HEADLINE_FIELDS` order. Empty when `ok` is false. */
  readonly headline: readonly FieldSpec[];
  /** Allocated capital and its asset, pre-formatted exactly as the table below formats it. */
  readonly allocatedCapital: string;
  readonly concentration: ConcentrationVerdict;
  readonly staleness: StalenessVerdict;
}

/**
 * Everything the card renders, from the response and the reader's clock.
 *
 * ⚠ THE HEADLINE SPECS COME OUT OF `proposalFieldsOf` AND ARE FILTERED, NEVER
 * REBUILT. That is the anti-drift property worth stating: the card and the full
 * parameters table print the SAME `FieldSpec.value` string for the same field,
 * because it is the same object. A card that formatted its own would be a second
 * implementation of the same rendering, and the copy that drifts is the one nobody
 * is watching.
 *
 * The order is `HEADLINE_FIELDS`', not `proposalFieldsOf`'s, so the card reads
 * lower-bound-then-upper-bound rather than in the form's field order. A field named
 * in `HEADLINE_FIELDS` that `proposalFieldsOf` did not return is DROPPED rather
 * than rendered blank — the same refusal `proposalFieldsOf` makes for the same
 * reason, and a test pins that it cannot happen for either real strategy.
 */
export function summarize(derive: DeriveResponse, now: number): ProposalSummary {
  const proposal = derive.derive.proposal;
  const { shape, specs } = proposalFieldsOf(proposal.params);

  const strategy = shape.ok ? shape.strategy : null;
  const byField = new Map(specs.map((spec) => [spec.field, spec]));
  const headline =
    strategy === null
      ? []
      : HEADLINE_FIELDS[strategy]
          .map((field) => byField.get(field))
          .filter((spec): spec is FieldSpec => spec !== undefined);

  return {
    strategy,
    claimedStrategy: shape.ok ? shape.strategy : shape.claimedStrategy,
    ok: shape.ok,
    headline,
    // The same expression `ProposalParameters` renders for the same value, so the
    // card and the table agree by construction rather than by review.
    allocatedCapital: `${formatMoney(proposal.allocatedCapital)} ${proposal.capitalAsset}`,
    concentration: concentrationVerdictOf(derive.bundle.concentration),
    staleness: stalenessVerdictOf(derive, now),
  };
}

/**
 * The words and the colour for each concentration verdict.
 *
 * WORDS AS WELL AS COLOUR, for `ProposalCitations`' reason restated in decision log
 * 44: *a distinction a colour-blind reviewer cannot make is the same as no
 * distinction.* And amber for BOTH `flagged` and `unknown`, deliberately — an
 * unestablished result must not be quieter than an established one, which is the
 * whole argument `ProposalConcentration` makes for rendering its "NOT CHECKED"
 * branch as loudly as its "flagged" branch.
 */
export const CONCENTRATION_BADGE: Readonly<
  Record<ConcentrationVerdict, { readonly label: string; readonly title: string; readonly className: string }>
> = Object.freeze({
  flagged: {
    label: "concentration: FLAGGED",
    title:
      "The over-concentration check ran and found something to weigh. It is a flag, not a block — see the full findings below.",
    className: "border-amber-500/60 bg-amber-500/15 text-amber-100 font-semibold",
  },
  clean: {
    label: "concentration: clean",
    title: "The over-concentration check ran and found nothing to flag.",
    className: "border-emerald-600/40 bg-emerald-600/10 text-emerald-200",
  },
  unknown: {
    label: "concentration: NOT CHECKED",
    title:
      "The read of what this account already holds did not complete, so whether this proposal would over-concentrate the account is unknown. That is NOT the same as it being fine.",
    className: "border-amber-500/60 bg-amber-500/15 text-amber-100 font-semibold",
  },
});

/**
 * The words and the colour for each staleness verdict.
 *
 * The labels match `ProposalFreshness`' `VERDICT_STYLE` deliberately — a reviewer
 * who reads "STALE" on the card and scrolls to the freshness panel should find the
 * same word, not a synonym they have to reconcile.
 */
export const STALENESS_BADGE: Readonly<
  Record<StalenessVerdict, { readonly label: string; readonly title: string; readonly className: string }>
> = Object.freeze({
  fresh: {
    label: "data: fresh",
    title:
      "Every input is inside its own staleness threshold right now. Thresholds are policy choices with no backtest behind them (src/research/staleness.ts).",
    className: "border-emerald-600/40 bg-emerald-600/10 text-emerald-200",
  },
  stale: {
    label: "data: STALE",
    title:
      "At least one input is past its own threshold right now. Do not act on this without refreshing — see the freshness panel below for which one.",
    className: "border-amber-500/60 bg-amber-500/15 text-amber-100 font-semibold",
  },
  unknown: {
    label: "data: AGE UNKNOWN",
    title:
      "At least one input never produced a fetch time, so there is no age to compare against a threshold. That is NOT the same as being fresh.",
    className: "border-amber-500/60 bg-amber-500/15 text-amber-100 font-semibold",
  },
});
