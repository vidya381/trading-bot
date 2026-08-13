/**
 * Stage 1's four inputs, assembled into one bundle per candidate (spec 21.4).
 *
 * Section 21 as a whole is still PLANNED, NOT YET BUILT -- no Assess stage, no
 * Derive stage, no Explain stage, no prompt, no proposal record, no Workers AI
 * call, no endpoint, no persistence. This module adds no new read of its own:
 * every fact in a bundle was produced by `candidates.ts`, `candles.ts` or
 * `concentration.ts`, and this file is the seam that puts them in one place.
 *
 * ── An HONEST PARTIAL bundle, not all-or-nothing ──
 *
 * Assembly's job is honest collection. It is NOT a judgement about whether the
 * result is good enough to show a human -- that is Stage 4's job (21.4,
 * "Explain and assemble"), and Stage 4 does not exist yet. So a bundle comes
 * back whenever a candidate exists, carrying each input's REAL state: candles
 * with their `truncated`/`missingHistoryMs`, concentration's
 * `no_concentration`/`flagged` variant, the candidate's own merged provenance.
 *
 * This is not a weakening of 21.5 requirement 6 ("fail closed"), and the
 * distinction is the load-bearing idea in this file:
 *
 *   * WITHIN each input, fail-closed is untouched. `fetchCandleWindow` still
 *     throws six ways rather than returning a short window; `readAccountExposure`
 *     still throws rather than reporting "no concentration" for a read it could
 *     not do. Nothing here catches those and substitutes a value.
 *   * BETWEEN inputs, a failure is RECORDED, not propagated. A candle fetch that
 *     failed puts the real `CandleWindowError` in the candles slot and leaves
 *     every other slot alone.
 *
 * The failure a whole-bundle throw would cause is specific and bad: one
 * unreachable venue would erase a concentration flag that was read successfully
 * from D1 and is exactly the thing 21.4 wants "presented prominently". Losing a
 * real risk signal because an unrelated fetch failed is not failing closed; it
 * is failing closed on the wrong thing.
 *
 * What no reader may do is mistake a recorded failure for a success. That is
 * enforced by the type rather than by care: every real input is a discriminated
 * union whose value is only reachable through the `ok` arm, the same
 * `ExchangeOutcome` discipline section 5.6 imposes one layer down.
 *
 * ── It COMPOSES the existing types; it invents no error vocabulary ──
 *
 * `GatheredInput` is an envelope with three states and no error taxonomy of its
 * own: the `failed` arm carries the module's OWN error object -- a real
 * `CandleWindowError` with its real `CandleWindowErrorCode`, a real
 * `ConcentrationError` with its real code. A second vocabulary re-describing
 * `candles_unavailable` as some flatter `fetch_failed` would drift from the
 * first, and the copy that drifts is the one nobody is watching (21.5's rule
 * about duplicated risk checks, applied to duplicated failure descriptions).
 *
 * The third state, `threw_unexpectedly`, exists because it is REACHABLE and
 * therefore must be nameable: `fetchCandleWindow` does not wrap its ports, so a
 * `Database` or `CandleSource` that throws raw produces something that is not a
 * `CandleWindowError`. Folding it into `failed` would mean typing `error` as
 * `CandleWindowError` while sometimes holding a D1 exception, which is a lie the
 * type system would happily tell. Keeping it separate makes "this module refused
 * for a reason it enumerated" and "something below it broke" two different
 * facts, which is the same distinction `tradable_set_unreadable` draws.
 *
 * ── The news slot is a STATE, not a TODO (decision log 30) ──
 *
 * No news or sentiment vendor has been chosen. `news.ts` exists, is tested, and
 * is deliberately unused; step 30 paused the question on purpose and listed the
 * three things that would unblock it, none of which has happened.
 *
 * So the bundle carries `NEWS_NOT_YET_AVAILABLE` -- a permanent-until-changed
 * part of the type, in the discriminant position every other input's state lives
 * in. It is structurally incapable of being read as a failed fetch: it has no
 * `error`, no `failedAt` and no `fetchedAt`, because no fetch was attempted and
 * a timestamp would claim one was. When a vendor is chosen, `NewsInput` gains
 * the `ok`/`failed`/`threw_unexpectedly` arms beside it and every exhaustive
 * switch over the union stops compiling until it is handled -- which is the
 * point of putting it in the type instead of in a comment.
 *
 * The guarantee is structural at the port layer too: `GatherPorts` has NO news
 * source in it. Assembly cannot reach a vendor even by mistake, the same way
 * `NamedCandidatePorts` cannot reach a trending vendor (`candidates.ts`).
 *
 * ── Every fetch keeps its OWN timestamp ──
 *
 * The sub-fetches are not simultaneous, so there is no single instant a bundle
 * was "fetched at" and none is manufactured. Each timestamp stays where the
 * module that earned it put it:
 *
 *   * `candles.value.fetchedAt`     -- when the venue answered
 *   * `concentration.value.readAt`  -- when `bot_instances` was read
 *   * `candidate.sources[].{requestedAt,addedAt,fetchedAt}` -- per provenance
 *   * `<input>.failedAt`            -- when a failure was OBSERVED, on the arms
 *                                      that have no fetch time because no fetch
 *                                      succeeded
 *
 * `assembledAt` is beside them and is NOT one of them: it is when this function
 * ran, the same kind of thing `CandidateSet.selectedAt` is, and it is documented
 * on the field so nothing downstream times a proposal from it (21.5 requirement
 * 4 wants the fetch time, not the render time).
 *
 * ── A SECOND, LATER GATHER FOR STAGE 3 ──
 *
 * `gatherDeriveContext` is a separate entry point that reads two more real
 * things -- the account's `capital_ledger` headroom (section 8.5) and the pair's
 * real trading filters -- for the candidate a human is actually deriving
 * parameters for. It is deliberately NOT folded into the bundle above; the
 * reasons (a per-symbol uncached request, reading a stale-by-construction money
 * figure as late as possible, and not changing the type Stage 2 is built on) are
 * argued on `DeriveContext`.
 *
 * The capital figure it carries is a PREFILL for a human to confirm and is never
 * a reservation. `capital.ts` states that at length, and the real check remains
 * `createBotInstanceWithCapital`'s, at creation, unchanged.
 *
 * ── What this module deliberately does NOT do ──
 *
 *   * NO persistence of its own. 21.5 requirement 5's record now EXISTS
 *     (migration 0009, `proposal-log.ts`) and it stores this bundle whole -- but
 *     it is written by the endpoints that produce a proposal, and a gather is not
 *     one: it has no reasoning and no outcome a human could record. Nothing here
 *     writes a row, and `/gather` deliberately writes none either. See
 *     `proposal-log.ts` on why that omission is the measurement working.
 *   * NO judgement. Nothing here decides a bundle is too degraded to use, ranks
 *     candidates, or filters any of them out. A flagged candidate and a
 *     candidate whose candles failed both come back, in their own position.
 *   * NO re-derivation of what `candidates.ts` already resolved. The account
 *     label, exchange and pair are read off the `Candidate`; the general run's
 *     operator-stated quote assets are read off `CandidateSet.trending`.
 */

import type { CandleInterval, SymbolFilters, Timestamp } from "../shared/exchange-client";
import {
  CandleWindowError,
  fetchCandleWindow,
  type CandleWindow,
  type CandleWindowPorts,
} from "./candles";
import type { Candidate, CandidateSet } from "./candidates";
import {
  ResearchCapitalError,
  readAccountCapital,
  type AccountCapital,
} from "./capital";
import {
  ConcentrationError,
  assessConcentration,
  readAccountExposure,
  type AccountExposure,
  type ConcentrationPolicy,
  type ConcentrationPorts,
  type ConcentrationResult,
} from "./concentration";
import type { SymbolDetailSource } from "./tradability";

// ---------------------------------------------------------------------------
// The envelope
// ---------------------------------------------------------------------------

/**
 * One Stage 1 input, in one of the three states it can really be in.
 *
 * `T` is the producing module's own success type and `E` its own error class.
 * Nothing is re-described: to know WHY an input failed, read `error.code` on the
 * module's own error, exactly as a direct caller would.
 *
 * The value is reachable only through the `ok` arm, so a caller cannot read a
 * candle window out of a failed fetch without the type system objecting -- the
 * `ExchangeOutcome` discipline (section 5.6) applied one layer up.
 */
export type GatheredInput<T, E> =
  | { readonly outcome: "ok"; readonly value: T }
  /** The module refused, for one of the reasons it enumerates. */
  | { readonly outcome: "failed"; readonly error: E; readonly failedAt: Timestamp }
  /**
   * Something beneath the module threw: a port, a driver, a bug.
   *
   * `unknown` rather than `Error`, because a thrown non-Error is legal
   * JavaScript and narrowing it to a lie here would be the papering-over this
   * whole file exists to avoid.
   */
  | { readonly outcome: "threw_unexpectedly"; readonly error: unknown; readonly failedAt: Timestamp };

/** 21.4 Stage 1's first bullet. `CandleWindow` carries its own depth honesty. */
export type CandleInput = GatheredInput<CandleWindow, CandleWindowError>;

/** 21.4 Stage 1's third bullet, per candidate. A flag, never a filter. */
export type ConcentrationInput = GatheredInput<ConcentrationResult, ConcentrationError>;

/**
 * The ONE `bot_instances` read a set-wide gather does, reported beside the
 * per-candidate results it produced.
 *
 * Step 34 returns the exposure from `assessCandidateSetConcentration` for
 * 21.5 requirement 2's reason -- "the actual raw data it used" -- and the same
 * reasoning applies to a bundle that will one day be shown to a human.
 */
export type ExposureInput = GatheredInput<AccountExposure, ConcentrationError>;

// ---------------------------------------------------------------------------
// The paused input
// ---------------------------------------------------------------------------

/**
 * 21.4 Stage 1's second bullet, paused rather than missing (decision log 30).
 *
 * This is NOT a failure and must never be rendered as one. No vendor has been
 * chosen, so no request was made, so there is nothing that could have failed.
 * The absence of `error`, `failedAt` and `fetchedAt` is the structural half of
 * that statement; `reason` and `decisionLogEntry` are the half a human reads.
 *
 * The distinction matters at the point it will actually be used: a proposal that
 * says "news could not be fetched" invites a retry and implies a transient
 * problem, while the truth is a deliberate, recorded pause with three named
 * conditions for lifting it. Those two sentences must never be produced by the
 * same branch.
 */
export interface NewsNotYetAvailable {
  readonly outcome: "not_yet_available";
  readonly reason: string;
  /** Where the pause is argued, so the bundle is self-describing. */
  readonly decisionLogEntry: string;
}

/**
 * A one-armed union, on purpose.
 *
 * `ok` and `failed` arms are NOT pre-declared. Nothing can produce them, and a
 * state no code can reach is a claim about a fetch this system has never made.
 * When a vendor lands, the arms are added here and every exhaustive switch stops
 * compiling until each one is handled -- loudly, at build time, which is the
 * whole reason the pause lives in the type rather than in a comment.
 */
export type NewsInput = NewsNotYetAvailable;

/**
 * The single value every bundle's news slot holds, frozen and shared.
 *
 * One instance rather than a fresh object per bundle, so that "the placeholder,
 * unmodified" is assertable by identity and so no caller can mutate one
 * bundle's copy into something another bundle disagrees with.
 */
export const NEWS_NOT_YET_AVAILABLE: NewsNotYetAvailable = Object.freeze({
  outcome: "not_yet_available",
  reason:
    "No news or sentiment vendor has been chosen. src/research/news.ts is written, " +
    "tested and deliberately unused: its wire format is unverified, this project holds " +
    "no key for any vendor, and the pause is on the vendor decision rather than on the " +
    "code. This is NOT a failed fetch -- no request was made. See the decision log entry " +
    "for the three conditions, any one of which lifts the pause.",
  decisionLogEntry: "docs/decision-log/30.md",
});

// ---------------------------------------------------------------------------
// The bundles
// ---------------------------------------------------------------------------

/**
 * Everything Stage 1 gathered about ONE candidate.
 *
 * `candidate` is the candidate-selection input, carried verbatim rather than
 * summarised: it is `candidates.ts`'s real result for this coin, and its
 * `sources` tuple is 21.5 requirement 2's "which watchlist entry, or which
 * trending pull, and when". It has no envelope because it cannot have failed --
 * a `Candidate` exists only because selection already succeeded, and selection's
 * own failures are refusals from `selectNamedCandidate`/`selectGeneralCandidates`
 * that produce no candidate to bundle. An `ok`/`failed` wrapper here would model
 * a state unreachable by construction, which this folder makes unrepresentable
 * rather than checks for (`Candidate.sources`, `ConcentrationResult`).
 *
 * The three real inputs are independent fields, which is what makes requirement
 * "tell candles-failed from concentration-failed from all-succeeded" a property
 * of the TYPE rather than of a convention: there is no shared status, no first
 * error, and no ordering between them.
 */
export interface CandidateGatherBundle {
  readonly candidate: Candidate;
  readonly candles: CandleInput;
  readonly news: NewsInput;
  readonly concentration: ConcentrationInput;
  /**
   * When assembly ran. NOT a data-fetch time and never to be used as one --
   * 21.5 requirement 4 times a proposal from when its data was fetched, and
   * those timestamps live inside the slots (see the module header).
   */
  readonly assembledAt: Timestamp;
}

/**
 * A whole `CandidateSet`'s bundles, plus the one read behind their
 * concentration results.
 *
 * `set` is carried whole so the set-level provenance survives -- 21.5
 * requirement 2's "which trending pull, and when" lives on
 * `set.trending.fetchedAt`, and `set.watchlist.readAt` on the other half. Those
 * are per-SET facts and are not copied onto each candidate, which would state
 * the same timestamp N times and invite one of the copies to drift.
 *
 * `bundles` has exactly `set.candidates.length` entries, in the set's own order,
 * with no filtering of any kind -- the same guarantee
 * `assessCandidateSetConcentration` makes, for the same reason.
 */
export interface CandidateSetGatherBundle {
  readonly set: CandidateSet;
  readonly exposure: ExposureInput;
  readonly bundles: readonly CandidateGatherBundle[];
  /** When assembly started. See `CandidateGatherBundle.assembledAt`. */
  readonly assembledAt: Timestamp;
}

// ---------------------------------------------------------------------------
// Ports and request
// ---------------------------------------------------------------------------

/**
 * Exactly the ports the three real inputs need, and nothing else.
 *
 * `CandleWindowPorts` contributes `db`, `listTradablePairs` and `getCandles`;
 * `ConcentrationPorts` contributes `db` (the same `Database`) and `now`.
 *
 * There is NO news source and NO trending source here, and both absences are
 * load-bearing rather than incidental. Assembly cannot call a news vendor
 * because it holds no way to, and it cannot re-run candidate selection because
 * selection is its input, not its job.
 */
export interface GatherPorts extends CandleWindowPorts, ConcentrationPorts {}

/**
 * The facts a `Candidate` does not carry and assembly must be told.
 *
 * A `Candidate` is an account, an exchange, a pair and its provenance. It says
 * nothing about how much price history to ask for, because "which timeframe this
 * run reasons over" is the caller's decision and not a property of the coin.
 */
export interface GatherRequest {
  /**
   * Required, with no default.
   *
   * `VERIFIED_INTERVALS` currently holds only `"1m"`, so a default would even be
   * a correct guess today -- and would silently become a wrong one the moment
   * that array is widened, on a field whose whole failure mode is being wrong
   * invisibly (candles of the wrong duration pass every type check; see
   * `candles.ts`). Stated by the caller, refused by `fetchCandleWindow` if
   * unverified.
   */
  readonly interval: CandleInterval;
  /** The oldest close time wanted. Best-effort; `CandleWindow.truncated` reports how well it was met. */
  readonly since?: Timestamp;
  /**
   * Extra quote assets for concentration's base-asset split, on top of the ones
   * observed on the account's own bots.
   *
   * The set-wide entry point MERGES the operator's own stated quote assets from
   * `CandidateSet.trending.quoteAssets` into this, rather than making a caller
   * restate a decision `selectGeneralCandidates` already normalised.
   */
  readonly quoteAssets?: readonly string[];
  readonly policy?: ConcentrationPolicy;
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

/**
 * Run one input, and record what really happened to it.
 *
 * The `catch` is deliberately total for the reason `readAccountExposure`'s is:
 * this module cannot enumerate every way a port fails, and the alternative to
 * catching broadly is an assembly that throws for one candidate's candles and
 * silently discards another candidate's concentration flag on the way out.
 *
 * The `instanceof` split is what keeps `threw_unexpectedly` honest -- an error
 * that is not the module's own is never dressed up as one of its enumerated
 * refusals.
 */
async function runInput<T, E extends Error>(
  run: () => Promise<T>,
  isOwnError: (error: unknown) => error is E,
  now: () => Timestamp,
): Promise<GatheredInput<T, E>> {
  try {
    return { outcome: "ok", value: await run() };
  } catch (error) {
    const failedAt = now();
    if (isOwnError(error)) return { outcome: "failed", error, failedAt };
    return { outcome: "threw_unexpectedly", error, failedAt };
  }
}

const isCandleWindowError = (error: unknown): error is CandleWindowError =>
  error instanceof CandleWindowError;

const isConcentrationError = (error: unknown): error is ConcentrationError =>
  error instanceof ConcentrationError;

/**
 * The `bot_instances` read, as an envelope.
 *
 * Separate from the fold for step 34's reason -- a general run over fifteen
 * candidates costs ONE read rather than fifteen identical ones -- and enveloped
 * here so a failed read becomes every candidate's recorded concentration
 * failure rather than the whole gather's exception. It genuinely was one read,
 * so N identical recorded failures is an accurate report of what happened and
 * not a duplicated guess.
 */
async function readExposure(ports: GatherPorts, accountLabel: string): Promise<ExposureInput> {
  return runInput(
    () => readAccountExposure(ports.db, accountLabel, ports.now),
    isConcentrationError,
    ports.now,
  );
}

/**
 * Fold one candidate against an already-read exposure.
 *
 * A read that failed propagates as THAT read's error object, unaltered: the
 * concentration slot then carries a real `ConcentrationError` with code
 * `bot_list_unreadable`, which is the true reason this candidate has no
 * concentration result. Re-wrapping it in a second error would restate the same
 * fact in a second vocabulary, which is what this module refuses to do.
 */
function foldConcentration(
  ports: GatherPorts,
  candidate: Candidate,
  request: GatherRequest,
  exposure: ExposureInput,
): ConcentrationInput {
  if (exposure.outcome !== "ok") return exposure;
  try {
    return {
      outcome: "ok",
      value: assessConcentration(exposure.value, candidate, {
        ...(request.quoteAssets === undefined ? {} : { quoteAssets: request.quoteAssets }),
        ...(request.policy === undefined ? {} : { policy: request.policy }),
      }),
    };
  } catch (error) {
    const failedAt = ports.now();
    if (isConcentrationError(error)) return { outcome: "failed", error, failedAt };
    return { outcome: "threw_unexpectedly", error, failedAt };
  }
}

/**
 * Assemble one candidate's bundle against an exposure already read.
 *
 * The two real fetches are run one after the other and each is enveloped
 * independently, so neither can observe or short-circuit the other: there is no
 * shared accumulator, no early return between them, and no `throw` path out of
 * this function at all. The candle fetch runs whatever the exposure read did,
 * and the fold runs whatever the candle fetch did.
 */
async function gatherAgainstExposure(
  ports: GatherPorts,
  candidate: Candidate,
  request: GatherRequest,
  exposure: ExposureInput,
): Promise<CandidateGatherBundle> {
  const assembledAt = ports.now();

  const candles = await runInput<CandleWindow, CandleWindowError>(
    () =>
      fetchCandleWindow(ports, {
        accountLabel: candidate.accountLabel,
        pair: candidate.pair,
        interval: request.interval,
        ...(request.since === undefined ? {} : { since: request.since }),
      }),
    isCandleWindowError,
    ports.now,
  );

  const concentration = foldConcentration(ports, candidate, request, exposure);

  return {
    candidate,
    candles,
    news: NEWS_NOT_YET_AVAILABLE,
    concentration,
    assembledAt,
  };
}

/**
 * Stage 1 for ONE candidate.
 *
 * Reads `bot_instances` for this candidate's account, fetches its candle window,
 * and records the paused news slot. Never throws: every failure a real input can
 * produce lands in that input's own slot.
 *
 * The account, exchange and pair are taken from the `Candidate` and nothing is
 * re-derived. `fetchCandleWindow` does re-read the registry row and re-run
 * `checkTradable`, and that duplication is accepted rather than worked around:
 * it is the module's own rule that the venue comes from the registry and never
 * from a caller (step 11), the listing is KV-cached so the check is usually
 * free, and the alternative is an internal entry point that trusts a caller's
 * word about tradability -- which is a validation that validates nothing.
 *
 * A candidate whose `exchange` disagrees with the registry row
 * `fetchCandleWindow` reads is NOT a new error state here. Both values are in
 * the bundle -- `candidate.exchange` and `candles.value.exchange` -- so the
 * disagreement is visible to anyone who looks, and inventing a code for a
 * mid-run registry change would add vocabulary for a fact the bundle already
 * carries.
 */
export async function gatherCandidateData(
  ports: GatherPorts,
  candidate: Candidate,
  request: GatherRequest,
): Promise<CandidateGatherBundle> {
  const exposure = await readExposure(ports, candidate.accountLabel);
  return gatherAgainstExposure(ports, candidate, request, exposure);
}

// ---------------------------------------------------------------------------
// The Stage 3 context: two more real reads, gathered separately and on purpose
// ---------------------------------------------------------------------------

/**
 * The account's real `capital_ledger` headroom (section 8.5). See `capital.ts`
 * for why the figure inside is a PREFILL and never a reservation.
 */
export type CapitalInput = GatheredInput<AccountCapital, ResearchCapitalError>;

/**
 * The pair's real trading filters, for the minimum-order floor 21.5 requirement
 * 3 asks for.
 *
 * `ExchangeOutcome` is a result type rather than a throw, so a refusal from the
 * venue arrives as `ok: false` and is converted to this envelope's `failed` arm
 * carrying a real `Error` built from the outcome's own `kind` and `message` --
 * the venue's words, not a second vocabulary describing them.
 */
export type SymbolFiltersInput = GatheredInput<SymbolFilters, Error>;

/**
 * Everything Stage 3 needs that Stage 1's bundle does not already carry.
 *
 * ── WHY THIS IS A SECOND FUNCTION AND NOT TWO MORE FIELDS ON THE BUNDLE ──
 *
 * Both reads are real, and both are genuinely new: nothing in this repository
 * read `capital_ledger` for research before, and `getSymbolFilters` was reached
 * only by the order path and the bot-creation gate. They are added here, beside
 * the bundle rather than inside it, for three reasons that are all about not
 * charging Stage 2 for Stage 3's needs:
 *
 *  1. **COST.** A symbol-details read is ONE UNCACHED PER-SYMBOL REQUEST --
 *     `tradability.ts` says so explicitly and warns that
 *     `selectGeneralCandidates` checks up to fifteen coins per run. Putting it
 *     in `gatherCandidateData` would spend that request on every candidate of
 *     every Assess run, including the ones Assess is about to reason over and
 *     nobody ever derives parameters for.
 *  2. **ORDER.** Derive runs only after Assess has chosen, and only for a
 *     candidate someone is actually deriving. Reading late means reading a
 *     ledger figure closer to the moment a human sees it, which is the right
 *     direction for a number 21.5 requirement 4 calls stale by construction.
 *  3. **BLAST RADIUS.** `CandidateGatherBundle` is what Stage 2's prompt, its
 *     tests and the live-verified `/assess` endpoint are all built on. Two new
 *     required fields on it would change every one of those for a stage none of
 *     them run.
 *
 * What is NOT different is the discipline. Both slots are the same
 * `GatheredInput` envelope, both carry the producing layer's own failure, and
 * neither one's failure erases the other's result -- exactly as the bundle's
 * three inputs behave, and for the reasons the module header argues.
 */
export interface DeriveContext {
  readonly bundle: CandidateGatherBundle;
  readonly capital: CapitalInput;
  readonly filters: SymbolFiltersInput;
  /** When this second gather ran. NOT a fetch time -- see `CandidateGatherBundle.assembledAt`. */
  readonly gatheredAt: Timestamp;
}

/**
 * `GatherPorts` plus the one-symbol details read.
 *
 * `SymbolDetailSource` is `tradability.ts`'s existing port -- the same one
 * `checkSpotInstrument` and the bot-creation gate already use, reached through
 * the same wiring. A second port for "the same symbol's details" would be a
 * second thing to keep pointed at the same venue.
 */
export interface DeriveContextPorts extends GatherPorts {
  readonly getSymbolDetails: SymbolDetailSource;
}

/**
 * An `ExchangeOutcome` failure, as an `Error` that keeps the venue's own words.
 *
 * Named rather than inlined so the conversion is one place: an outcome is
 * `{ok: false, kind, message}` and the envelope's `failed` arm wants an `Error`.
 * The `kind` is preserved on the error so a reader can tell an unreachable venue
 * from a refused symbol, which is section 5.6's whole distinction.
 */
export class SymbolFiltersUnavailableError extends Error {
  readonly kind: string;
  constructor(kind: string, message: string) {
    super(`symbol filters unavailable (${kind}): ${message}`);
    this.name = "SymbolFiltersUnavailableError";
    this.kind = kind;
  }
}

/**
 * Stage 3's extra reads for ONE already-gathered candidate.
 *
 * Never throws, for `gatherCandidateData`'s reason: each read lands in its own
 * slot carrying its own failure, and one failing does not remove the other. The
 * decision about whether a failed slot is fatal belongs to `deriveParameters`,
 * which argues each one -- and both ARE fatal there, which is a different
 * statement from being fatal here. Recording honestly and refusing loudly are
 * two jobs, and this folder keeps them in two places.
 */
export async function gatherDeriveContext(
  ports: DeriveContextPorts,
  bundle: CandidateGatherBundle,
): Promise<DeriveContext> {
  const gatheredAt = ports.now();

  const capital = await runInput<AccountCapital, ResearchCapitalError>(
    () => readAccountCapital(ports.db, bundle.candidate.accountLabel, ports.now),
    (error): error is ResearchCapitalError => error instanceof ResearchCapitalError,
    ports.now,
  );

  const filters = await runInput<SymbolFilters, Error>(
    async () => {
      const outcome = await ports.getSymbolDetails(
        { label: bundle.candidate.accountLabel, exchange: bundle.candidate.exchange },
        bundle.candidate.pair,
      );
      if (!outcome.ok) {
        throw new SymbolFiltersUnavailableError(outcome.kind, outcome.message);
      }
      return outcome.value;
    },
    (error): error is Error => error instanceof Error,
    ports.now,
  );

  return { bundle, capital, filters, gatheredAt };
}

/**
 * Stage 1 for a whole `CandidateSet`: ONE bot-list read, one bundle per
 * candidate.
 *
 * This is the entry point BOTH of 21.2's doors reach, unchanged -- a named run
 * is a `CandidateSet` holding one candidate, and nothing here knows or cares
 * which door it came through. 21.2's rule ("not two code paths") holds by
 * construction rather than by discipline, the same way it does in
 * `assessCandidateSetConcentration`.
 *
 * Candidates are gathered SEQUENTIALLY rather than concurrently. That is a
 * deliberate cost: each candidate spends one venue candle request, and a general
 * run's candidate count is bounded but not small (21.3's watchlist of 5-10 plus
 * a trending pull), so firing them at once would put a burst against the rate
 * budget section 5.4 owns for a run whose latency nobody is waiting on
 * interactively yet. Isolation does not depend on the ordering either way -- see
 * `gatherAgainstExposure` -- so this can become concurrent later without
 * changing what a bundle means.
 *
 * The operator's own quote assets are read off `set.trending` and MERGED into
 * the caller's, rather than replacing them: both lists are additive input to the
 * base-asset split (`AssessConcentrationOptions.quoteAssets`), the longest
 * suffix wins inside `normaliseQuotes`, and a set that came through the named
 * door simply contributes none.
 */
export async function gatherCandidateSetData(
  ports: GatherPorts,
  set: CandidateSet,
  request: GatherRequest,
): Promise<CandidateSetGatherBundle> {
  const assembledAt = ports.now();
  const quoteAssets = [...(request.quoteAssets ?? []), ...(set.trending?.quoteAssets ?? [])];
  const merged: GatherRequest =
    quoteAssets.length === 0 ? request : { ...request, quoteAssets };

  const exposure = await readExposure(ports, set.accountLabel);

  const bundles: CandidateGatherBundle[] = [];
  for (const candidate of set.candidates) {
    bundles.push(await gatherAgainstExposure(ports, candidate, merged, exposure));
  }

  return { set, exposure, bundles, assembledAt };
}
