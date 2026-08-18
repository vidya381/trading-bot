/**
 * WHICH OF THE GLOBAL BANNER'S STATES IS TRUE, given whatever the app's one
 * shared kill-switch poll has produced so far.
 *
 * ── THE GAP THIS CLOSES (decision log 47, section 8) ──
 *
 * `KillSwitchBanner.tsx` used to decide with a single line:
 *
 *     if (status === null || status.state !== "tripped") return null;
 *
 * That renders nothing in three situations which are not the same fact:
 *
 *   1. the switch is ARMED               -- confirmed safe
 *   2. the first poll has not resolved   -- not known yet, but about to be
 *   3. no poll has EVER succeeded        -- not known, and nothing says so
 *
 * Case 3 is the defect. If `GET /api/kill-switch` fails from the very first
 * request -- an expired Access session, a `no_schema` 503, a D1 error -- WHILE
 * THE SWITCH IS ACTUALLY TRIPPED, the loudest safety element in the system
 * renders exactly what it renders when everything is fine: nothing. "We do not
 * know" was pixel-identical to "we checked, and it is safe."
 *
 * This module refuses that conflation. It returns FOUR values, and the caller
 * renders a visibly different thing for each of the three that are decidable.
 *
 * ── WHY THIS IS A MODULE AND NOT A TERNARY INSIDE THE .tsx ──
 *
 * The same reason `statusCounts.ts` and `proposalSummary.ts` exist. This
 * repository's suite runs inside the Workers runtime (see vitest.config.ts),
 * which has no DOM, and a `.tsx` module cannot even be IMPORTED there -- its JSX
 * compiles to a `react/jsx-runtime` import and React ships CommonJS that workerd
 * cannot `require`. A test file that imports a `.tsx` collects ZERO TESTS and
 * reports a green suite (docs/open-items/component-test-harness.md).
 *
 * `proposalFields.ts` was extracted after a mutation run proved its inline
 * predecessor's guard call site unreachable by any test: A DECISION THAT CANNOT
 * BE TESTED IS A DECISION NOBODY IS WATCHING. This is the most safety-relevant
 * decision in the dashboard, so it does not live in a file no test can reach.
 * The component keeps only the copy, the colour and the placement.
 *
 * ── ⚠ WHAT DOES *NOT* CHANGE: LAST-GOOD DATA STILL WINS ──
 *
 * `usePolling`'s catch keeps `data: prev.data` and `lastUpdated: prev.lastUpdated`
 * on a failed poll. That is deliberate and stays exactly as it was: once a poll
 * has succeeded even once, a later failure must NOT blank a real TRIPPED bar.
 *
 * So `error` is an input here that the verdict DELIBERATELY IGNORES whenever
 * `data` is present. It is in the signature, and pinned by tests, precisely so
 * that a future edit adding `if (poll.error) return "unknown"` fails loudly --
 * that edit would drop a confirmed tripped banner on the first transient blip,
 * which is a strictly worse bug than the one this module fixes.
 *
 * THE BOUNDARY, STATED ONCE: "unknown" is `data === null` AFTER the first poll
 * has settled. It is never reached while any last-good status is held.
 */

import type { KillSwitchStatus } from "./api/types";

/**
 * What the global banner should say.
 *
 * Four values, three of which are decidable states and one of which is a
 * bounded, deliberately-silent window:
 *
 *   `tripped` -- confirmed pulled. The red bar. Every bot is halted.
 *   `armed`   -- confirmed safe. Renders nothing, and that is now an ASSERTION
 *                rather than a fallthrough: it is only returned when a real
 *                status object said so.
 *   `unknown` -- no status has ever been obtained. Renders the third bar.
 *   `pending` -- the first poll is still in flight. Renders nothing.
 *
 * WHY `pending` IS SEPARATE FROM `armed` EVEN THOUGH BOTH RENDER NOTHING.
 * They are different facts and folding them together is the exact mistake this
 * module exists to undo; keeping them apart also makes "the unknown bar must not
 * flash during ordinary first-load latency" a testable property rather than an
 * implicit one. Decision log 47 named that flash as a real design risk -- a bar
 * that appears on every page load teaches the operator to ignore bars.
 *
 * WHY `pending` IS SEPARATE FROM `unknown`. `pending` is bounded: the poll is
 * out, and it will settle. `unknown` is not: it persists for as long as the
 * failures do. Only the unbounded one deserves a bar.
 */
export type KillSwitchBannerState = "tripped" | "armed" | "unknown" | "pending";

/**
 * The part of `PollState<KillSwitchStatus>` this decision reads.
 *
 * Structural, not the full `PollState`, so the rule can be tested without
 * constructing a `refetch`. A real `PollState<KillSwitchStatus>` satisfies it.
 *
 * `lastUpdated` is deliberately NOT read. It carries the same "has a poll ever
 * succeeded" signal as `data === null`, and consulting both would create two
 * sources of truth for one question that could disagree. `data` is the one that
 * is read, because `data` is the thing that would be RENDERED: a banner must
 * decide from what it can actually show, not from a timestamp claiming that
 * something showable exists.
 */
export interface KillSwitchPollView {
  readonly data: KillSwitchStatus | null;
  readonly error: Error | null;
  readonly loading: boolean;
}

/**
 * Resolve the poll into exactly one banner state.
 *
 * Order matters and is the safety property:
 *
 *   1. A held status wins over everything -- including an error beside it. This
 *      is the last-good rule, unchanged from step 47.
 *   2. An UNRECOGNISED `state` string is `unknown`, not `armed`. `requestJson`
 *      casts the response (`(await response.json()) as ApiEnvelope<T>`) and
 *      performs NO runtime validation, so a backend that ever answers anything
 *      other than "armed"/"tripped" -- a new state, a rename, a malformed row --
 *      reaches this function as a value TypeScript believes is impossible. The
 *      fail-safe direction for a value we cannot interpret is to admit we cannot
 *      interpret it. Reading "not tripped" as "armed" is how the original line
 *      turned every unknown into an all-clear.
 *   3. Only with no status at all does the poll's phase decide, and only a
 *      SETTLED first poll with nothing to show is `unknown`.
 */
export function killSwitchBannerState(poll: KillSwitchPollView): KillSwitchBannerState {
  if (poll.data !== null) {
    if (poll.data.state === "tripped") return "tripped";
    if (poll.data.state === "armed") return "armed";
    return "unknown";
  }
  if (poll.loading) return "pending";
  return "unknown";
}
