/**
 * THE NAMED-COIN TRIGGER (spec 21.6), orchestrated ENTIRELY IN THE CLIENT.
 *
 * One function that makes the two real calls a human has been making by hand
 * since step 42: `GET /api/accounts/:label/assess`, then the projection entry 42
 * specifies, then `GET /api/accounts/:label/derive` with the result. It replaces
 * a curl-and-paste round trip; it does not replace, weaken or duplicate one line
 * of what those two endpoints do.
 *
 * ── ⚠ WHAT THIS IS NOT, STATED FIRST ──
 *
 * NO NEW BACKEND. Nothing here is a new endpoint, a new route or a new safety
 * mechanism. Both calls go to the surfaces that already exist, exactly as they
 * are, with exactly the parameters `curl` would send.
 *
 * NO NEW SAFETY MECHANISM, AND NO WEAKENED ONE. Every check still runs where it
 * always ran, on the server: `parseResubmittedAssessment` re-resolves every
 * citation against the evidence `/derive` gathers for itself, the real create-bot
 * decoders and the real strategy validators still pass on the parameters, the
 * venue floor and the capital headroom are still checked, and the proposal record
 * is still written by the backend. This module checks NOTHING. It calls, it
 * projects, and it reports.
 *
 * NO PATH TO A BOT. 21.1 is untouched: a successful run renders a proposal
 * through the same `ProposalView` a paste renders through, which has no approve
 * button and no prefilled create-bot link. The only way this output becomes a bot
 * is still a human reading it and filling in the create-bot form.
 *
 * ONLY THE NAMED ENTRY POINT. `entryPoint=general` and the watchlist door are not
 * reachable from here and are not attempted: no trending vendor has been chosen
 * (decision logs 30, 31, 45), so `general` still 503s, and that is independent,
 * deferred work rather than a gap in this module.
 *
 * ── ⚠ THIS SPENDS REAL MONEY, TWICE, AND TAKES A REAL MINUTE ──
 *
 * Each run is two paid Workers AI inferences. `MEASURED_LATENCY` below carries
 * the real samples this project has taken rather than an invented estimate, and
 * the honest reading of them is in its own docblock.
 *
 * ── WHY THE CLIENT ORCHESTRATES AND NOT THE SERVER ──
 *
 * Because the two-call split is a deliberate property of the backend, not an
 * accident to paper over. Entry 42 measured a single combined run at 88,480 ms of
 * model time and split it precisely so no single HTTP request carries more than
 * one inference. A server-side "do both" endpoint would rebuild the long request
 * that split was made to avoid, and it would have to re-solve the resubmission
 * question the split already answers.
 */

import type { AssessResponse, DeriveResponse, Strategy } from "../api/research-types";
import { encodeResubmission, projectResubmission } from "./resubmission";
import { describeRunFailure, type StageFailure } from "./runErrors";

// ---------------------------------------------------------------------------
// The request
// ---------------------------------------------------------------------------

/**
 * Every parameter both endpoints take, in ONE object used for BOTH calls.
 *
 * ⚠ ONE OBJECT IS THE POINT, NOT A CONVENIENCE. `/derive`'s own parameter
 * docblock requires the pair to be "the SAME pair the resubmitted assessment was
 * made about", and the interval carries the same hazard at both stages: a wrong
 * one does not error, it returns correctly-shaped candles of a DIFFERENT duration
 * that no reader downstream can detect. Building the two requests from two
 * objects would make a silent divergence between them representable. Building
 * them from one makes it unrepresentable.
 */
export interface ResearchRequest {
  readonly accountLabel: string;
  /** The venue's own symbol, exactly as `GET /api/accounts/:label/symbols` reports it. */
  readonly pair: string;
  /** One of the seven the backend accepts. The BACKEND decides which are verified. */
  readonly interval: string;
  /** Optional oldest close time wanted, epoch ms. Omitted, not defaulted. */
  readonly since?: number;
  /** Optional quote-asset filter. Omitted, not defaulted. */
  readonly quoteAssets?: readonly string[];
}

/**
 * The two calls, injectable.
 *
 * The real implementation is `fetchAssess` / `fetchDerive` in `api/client.ts`.
 * This interface exists so `runProposal` is testable with a fake — every test in
 * this repository drives an injected double rather than a network, and a paid
 * inference is the strongest possible reason to keep that rule.
 */
export interface ProposalClient {
  assess(request: ResearchRequest, signal?: AbortSignal): Promise<AssessResponse>;
  derive(
    request: ResearchRequest,
    assessment: string,
    signal?: AbortSignal,
  ): Promise<DeriveResponse>;
}

// ---------------------------------------------------------------------------
// Progress
// ---------------------------------------------------------------------------

/**
 * The run's real states. There are exactly two waiting states because there are
 * exactly two calls, and each is reported when that call actually starts.
 *
 * ⚠ NO STATE HERE IS COSMETIC, and that is deliberate. The projection between the
 * two calls is a synchronous object rebuild that takes no measurable time, so it
 * gets NO phase of its own: a progress step that flashes for zero milliseconds is
 * a spinner wearing a label, and it would say the client was working when the
 * client was not. What the second phase carries instead is a real fact the first
 * one could not — the STRATEGY Assess actually chose — so "Deciding grid
 * parameters" is a report rather than a guess.
 */
export type RunPhase =
  | { readonly kind: "assessing" }
  | {
      readonly kind: "deriving";
      /** Assess's real answer, complete. The strategy in it is decided, not predicted. */
      readonly assess: AssessResponse;
    };

/** What a run ends as. `assess` survives a derive-stage failure, and says so. */
export type RunOutcome =
  | { readonly kind: "ok"; readonly assess: AssessResponse; readonly derive: DeriveResponse }
  | {
      readonly kind: "failed";
      readonly failure: StageFailure;
      /**
       * Non-null exactly when Assess SUCCEEDED and Derive refused. The strategy
       * judgement was real, was paid for, and is still readable — reporting the
       * failure without it would throw away the half that worked.
       */
      readonly assess: AssessResponse | null;
    };

// ---------------------------------------------------------------------------
// What the wait really costs
// ---------------------------------------------------------------------------

/**
 * ⚠ EVERY NUMBER HERE IS A REAL MEASUREMENT FROM A REAL LIVE RUN. Nothing is
 * estimated, rounded up for comfort, or carried over from another system.
 *
 * ── ⚠ THESE ARE A RECORD OF WHAT HAS HAPPENED. THEY ARE NOT A BOUND. ──
 *
 * READ THIS BEFORE RENDERING ANY OF THEM, because this file has already been
 * wrong about it once and in the direction that misleads.
 *
 * The first version of this constant carried three Derive samples with a maximum
 * of 46,969 ms, and the waiting panel rendered them as a flat range: "Derive has
 * taken 27-47s". **The very first real run through the page that quoted it took
 * 77,344 ms** (decision log 46) — 1.65x the number on screen, on the stage the
 * operator was at that moment waiting for. The copy was accurate about its own
 * provenance and it was still read as a ceiling, because a bare range presented
 * during a wait reads as a promise about that wait.
 *
 * So the naming here is deliberate: `observedStageRangeSeconds`, not
 * `expected...`. Nothing in this system controls Workers AI inference time, no
 * ceiling has ever been established, and the honest thing a UI can say is what
 * has been measured plus how many times — never what will happen.
 *
 * ── PROVENANCE, so a future sample can be added without re-deriving the set ──
 *
 *   Assess, 9 samples: 13,540 / 20,326 / 10,614 (entry 37's three probes),
 *   10,546 (39), 11,470 (40), 13,080 and 41,511 (41's two runs), 17,622 (42),
 *   14,428 (46).
 *
 *   Derive, 4 samples: 28,632 and 46,969 (41), 27,473 (42), 77,344 (46).
 *
 *   Whole chains, 4: 41,712 and 88,480 (41), 45,095 (42), 91,772 (46). Each is
 *   its own run's Assess + Derive, which entry 42's table confirms arithmetically
 *   and which `proposalRun.test.ts` pins, so a total can never be a figure no
 *   pair of real stages produced.
 *
 * ⚠ THREE THINGS THAT MUST NOT BE LOST WHEN THESE ARE QUOTED:
 *
 *  1. `latencyMs` IS MODEL TIME ONLY. Each endpoint also selects the candidate,
 *     checks tradability, fetches candles, reads concentration — and `/derive`
 *     additionally reads the capital ledger and the venue filters — before the
 *     clock below starts, and writes a proposal record after it stops. So real
 *     wall-clock is LONGER than these numbers, by an amount nothing here has
 *     measured. A countdown built from them would run out early.
 *  2. NINE AND FOUR SAMPLES ARE NOT A DISTRIBUTION. Entry 41 attached this caveat
 *     to two samples, entry 42 to three and entry 46 to four; it has not stopped
 *     being true. Assess's spread is ~3.9x across its nine and Derive's is now
 *     ~2.8x across its four, where entry 42 measured ~1.7x across three.
 *  3. THEY ARE SANDBOX MEASUREMENTS, from the same environment entry 40 found is
 *     not a real market.
 */
export const MEASURED_LATENCY = Object.freeze({
  assess: Object.freeze({
    samplesMs: Object.freeze([
      10_546, 10_614, 11_470, 13_080, 13_540, 14_428, 17_622, 20_326, 41_511,
    ]),
    minMs: 10_546,
    maxMs: 41_511,
  }),
  derive: Object.freeze({
    samplesMs: Object.freeze([27_473, 28_632, 46_969, 77_344]),
    minMs: 27_473,
    maxMs: 77_344,
  }),
  /** Model time for a WHOLE run: each entry is one real chain's two stages. */
  totalObservedMs: Object.freeze([41_712, 45_095, 88_480, 91_772]),
});

/** A measured range, always carrying HOW MANY runs it is drawn from. */
export interface ObservedRange {
  readonly minS: number;
  readonly maxS: number;
  /** The sample count. Rendered beside the range so it is never read as a law. */
  readonly runs: number;
}

/**
 * What whole runs have really taken, in whole seconds of model time.
 *
 * Named `observed`, not `expected`: see the constant's header. A caller must
 * render `runs` alongside, and must not present the result as an upper bound.
 */
export function observedRunRangeSeconds(): ObservedRange {
  const total = MEASURED_LATENCY.totalObservedMs;
  return {
    minS: Math.round(Math.min(...total) / 1000),
    maxS: Math.round(Math.max(...total) / 1000),
    runs: total.length,
  };
}

/** The same, for one stage. */
export function observedStageRangeSeconds(stage: "assess" | "derive"): ObservedRange {
  const measured = MEASURED_LATENCY[stage];
  return {
    minS: Math.round(measured.minMs / 1000),
    maxS: Math.round(measured.maxMs / 1000),
    runs: measured.samplesMs.length,
  };
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

/**
 * True for the `AbortError` a cancelled in-flight fetch throws. Copied from
 * `pages/CreateBot.tsx`'s `isAbort` — the same one-line test, kept beside the
 * code that needs it rather than hoisted out of a `.tsx` no test can import.
 */
function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

/**
 * Run the named-coin pipeline: assess, project, derive.
 *
 * @param client   the two calls. Real in the page, a fake in every test.
 * @param request  ONE request object, used to build BOTH calls. See its type.
 * @param onPhase  called as each real call starts. Never called after the run
 *                 settles, so a late tick cannot revive a finished run's UI.
 * @param signal   cancels whichever call is in flight.
 *
 * @returns `ok` with both real responses, or `failed` with the REAL refusal from
 *          whichever stage produced it. It does not throw for a refusal —
 *          a refused run is an ordinary outcome of this feature, not an
 *          exception, and both stages' refusals have to be reportable in the
 *          same shape for the page to tell them apart.
 *
 * @throws the original `AbortError` when cancelled, and nothing else. A cancelled
 *         run is not a failure to report: `describeRunFailure` would have to
 *         invent a title for a thing the operator did on purpose, and the caller
 *         that aborted is the one that knows why.
 */
export async function runProposal(
  client: ProposalClient,
  request: ResearchRequest,
  onPhase: (phase: RunPhase) => void,
  signal?: AbortSignal,
): Promise<RunOutcome> {
  onPhase({ kind: "assessing" });

  let assess: AssessResponse;
  try {
    assess = await client.assess(request, signal);
  } catch (error) {
    if (isAbort(error)) throw error;
    // No Assess result, so nothing survived: `assess` is null and the page says
    // the run never got as far as a strategy.
    return { kind: "failed", failure: describeRunFailure("assess", error), assess: null };
  }

  onPhase({ kind: "deriving", assess });

  // ENTRY 42'S PROJECTION, and the client's entire contribution to the pipeline.
  // Built from `assess.assess` — the Stage 2 result — and never from the whole
  // response, so the four-field contract lives in exactly one place.
  const assessment = encodeResubmission(projectResubmission(assess.assess));

  // ⚠ THE SAME `request` OBJECT. Not a rebuilt one, not a spread with the pair
  // swapped in: the pair, interval, since and quoteAssets Derive sees are
  // literally the ones Assess saw, so the two calls cannot silently disagree
  // about what they are about.
  let derive: DeriveResponse;
  try {
    derive = await client.derive(request, assessment, signal);
  } catch (error) {
    if (isAbort(error)) throw error;
    // ⚠ `assess` IS CARRIED THROUGH. The strategy judgement was real and was paid
    // for; a Derive refusal does not make it wrong, and discarding it here would
    // charge the operator for an answer and then throw it away.
    return { kind: "failed", failure: describeRunFailure("derive", error), assess };
  }

  return { kind: "ok", assess, derive };
}

/**
 * The strategy Assess chose, for the waiting copy. `null` before Assess answers,
 * because before that nothing knows it and guessing would be the "confident
 * because the input was loud" failure 21.3 names, in miniature.
 */
export function strategyInFlight(phase: RunPhase): Strategy | null {
  return phase.kind === "deriving" ? phase.assess.assess.strategy : null;
}
