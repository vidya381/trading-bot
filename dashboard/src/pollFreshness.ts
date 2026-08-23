/**
 * HOW OLD THE DISPLAYED DATA IS, and whether that is worth saying out loud.
 *
 * ── THE HALF OF DECISION LOG 54 THAT SINGLE-FLIGHT DOES NOT FIX ──
 *
 * Entry 54 found two defects wearing one bug's clothes. `pollEngine`'s three
 * rules fix the first -- THE POLL COULD NOT COMPLETE. This module addresses the
 * second -- THE UI DID NOT ADMIT IT.
 *
 * They are genuinely independent, and that is why this is a separate file rather
 * than a branch inside the engine. Single-flight makes the poll ABLE to complete;
 * it cannot make a dead server answer. When every request times out, the
 * last-good rule (decision logs 47, 51, deliberately unchanged) keeps the
 * previous numbers on screen -- correctly, because blanking a money dashboard on
 * a blip is worse. THIS MODULE IS WHAT STOPS THOSE NUMBERS READING AS CURRENT.
 *
 * It is also the only piece here that is defensive against a FUTURE
 * starvation-shaped bug, because it is a property of `lastUpdated` and a clock,
 * not of any particular control flow. If some later edit reintroduces a way for
 * the poll to stop settling, this still notices.
 *
 * ── ⚠ THIS IS NOT `killSwitchBannerState`'s `unknown`, AND MUST NOT BECOME IT ──
 *
 * The banner's `unknown` looks like the same idea and is not. Its boundary is
 * stated in its own header:
 *
 *   > "`unknown` is `data === null` AFTER the first poll has settled. It is never
 *   >  reached while any last-good status is held."
 *
 * That is entry 54's COLD row only -- nothing was ever obtained. The dangerous
 * row is WARM: `data` present, `error` null, `lastUpdated` frozen. Teaching the
 * banner's verdict to return `unknown` for a STALE poll would mean adding
 * `if (stale) return "unknown"`, and `killSwitchBannerState.ts:41-51` exists
 * specifically to make that edit fail loudly -- it would DROP A CONFIRMED TRIPPED
 * BANNER on the first transient blip, which that file calls "a strictly worse bug
 * than the one this module fixes."
 *
 * So the relationship is ADDITIVE, never substitutive. The banner keeps deciding
 * tripped/armed/unknown/pending from `data` and `loading` alone. A freshness
 * verdict may be rendered BESIDE it. Nothing here is an input to any banner's
 * verdict, and `pollFreshness.test.ts` D7 fails the build if that ever changes.
 *
 * ── THE SHAPE, BORROWED FROM `src/research/staleness.ts` ──
 *
 * That module solved this same class of problem for proposals, and four things it
 * got right are copied here rather than reinvented:
 *
 *   1. THREE STATES, NOT TWO, and the third is not `fresh`. An input that never
 *      produced a value has no age to compare; rendering it as fresh is how data
 *      built on a failed read reads as current.
 *   2. THE THRESHOLD IS A NAMED POLICY IN ONE PLACE, with its reasoning and its
 *      lack of evidence attached -- not a constant inside a component.
 *   3. IT FLAGS; IT DOES NOT GATE. A stale verdict must not blank data, disable a
 *      control, or hide a number. It says how old, and stops.
 *   4. WORDS AS WELL AS COLOUR. "a distinction a colour-blind reviewer cannot make
 *      is the same as no distinction" (`ProposalFreshness.tsx:95-96`).
 *
 * The code is NOT imported from there: `staleness.ts` lives in `src/research/`,
 * is keyed to the four proposal inputs, and its thresholds span 15 minutes to 7
 * days -- three orders of magnitude away from a 5-second poll. The third state is
 * named `never` rather than `unknown` for one reason only: `unknown` already
 * means something else, one import away, in `killSwitchBannerState`.
 *
 * ⚠ `formatAge` IS NOT REDEFINED HERE. It already exists in `proposal.ts`,
 * already handles the clock-skew case, and is already what `ProposalFreshness`
 * renders ages with. `pollFreshnessMessage` calls it.
 */

import { formatAge } from "./proposal";

/** Epoch milliseconds. */
type Timestamp = number;

/**
 * Three states, and `never` is NOT `fresh`.
 *
 *   `fresh`  -- a poll succeeded within the threshold.
 *   `stale`  -- a poll succeeded, but not recently enough. What is on screen is
 *               real data that has stopped being updated.
 *   `never`  -- no poll has EVER succeeded, so there is no age to compare. Not a
 *               worse `stale`; a different fact, with no timestamp behind it.
 */
export type PollFreshnessVerdict = "fresh" | "stale" | "never";

/**
 * How long since the last SUCCESSFUL poll before the screen should say so.
 *
 * ⚠ A POLICY NUMBER with no evidence behind it, in the category
 * `VERIFIED_INTERVALS` (`candles.ts`), `DEFAULT_CONCENTRATION_POLICY` and the
 * proposal staleness thresholds already occupy. It is here, named, in one place,
 * so changing it is a visible edit rather than a tuning session.
 *
 * 15,000 ms is THREE POLL INTERVALS, the figure decision log 51 costed for the
 * banner's elapsed-time threshold. The reasoning is about false alarms rather
 * than about markets: one missed poll is ordinary jitter and two is bad luck, so
 * a threshold at one or two intervals would fire during normal operation --
 * and `killSwitchBannerState.ts:76` already names that hazard, that a warning
 * appearing routinely teaches the operator to ignore warnings. Three intervals is
 * the smallest number that cannot be reached by ordinary jitter alone.
 */
export const POLL_STALE_AFTER_MS = 15_000;

export interface PollFreshness {
  readonly verdict: PollFreshnessVerdict;
  /** Age of the last successful poll, or `null` when there has never been one. */
  readonly ageMs: number | null;
  /** Echoed so a caller can show the number it was judged against. */
  readonly thresholdMs: number;
}

/**
 * Judge a poll's age.
 *
 * ── ⚠ `error` IS DELIBERATELY NOT A PARAMETER ──
 *
 * This is the WARM row of decision log 54 PART 3 encoded in a signature. During
 * the starvation no `setState` ever ran, so `error` stayed `null` while
 * `lastUpdated` froze -- the dashboard showed old numbers with NOTHING marking
 * them as old, and a green dot still reading "Live". Any implementation that
 * consulted `error` would have called that state fresh, because there was no
 * error to see.
 *
 * Staleness is a fact about TIME, not about whether the most recent attempt
 * happened to report a failure. Making `error` uncallable from here is a stronger
 * guarantee than a test, and D6 pins the consequence anyway.
 */
export function pollFreshness(
  lastUpdated: Timestamp | null,
  now: Timestamp,
  thresholdMs: number = POLL_STALE_AFTER_MS,
): PollFreshness {
  if (lastUpdated === null) {
    return { verdict: "never", ageMs: null, thresholdMs };
  }

  const ageMs = now - lastUpdated;

  // CLOCK SKEW. A negative age means the stamp is in the future -- the machine's
  // clock moved, not the data. Reporting that as stale would put a warning on
  // screen that no refresh could ever clear, so it is treated as fresh and the
  // real age is carried out for a caller that wants to say so.
  if (ageMs < 0) {
    return { verdict: "fresh", ageMs, thresholdMs };
  }

  // AT the threshold is already stale: the threshold is the longest age still
  // considered current, so reaching it is no longer being within it.
  return { verdict: ageMs >= thresholdMs ? "stale" : "fresh", ageMs, thresholdMs };
}

/**
 * The sentence to put beside the data. `null` when there is nothing worth saying
 * -- a fresh poll gets no banner, the same argument `ProposalFreshness` makes for
 * not rendering a "this is fresh" reassurance the page has not earned.
 *
 * IT FLAGS, IT DOES NOT GATE: this returns words. Nothing here hides a number or
 * disables a control.
 */
export function pollFreshnessMessage(freshness: PollFreshness): string | null {
  if (freshness.verdict === "fresh") return null;
  if (freshness.verdict === "never") {
    return "No update has ever succeeded — nothing on screen has been confirmed.";
  }
  return `Not updated for ${formatAge(freshness.ageMs ?? 0)} — this data has stopped refreshing.`;
}
