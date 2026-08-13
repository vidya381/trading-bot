/**
 * THE STALENESS THRESHOLDS (spec 21.5 requirement 4), and the verdict they
 * produce.
 *
 * Requirement 4 has two halves. The first -- "every proposal is timestamped with
 * when its underlying data was fetched, the fetch time not the render time" --
 * was satisfied at step 44: `freshnessOf` publishes all four real fetch times
 * with the reason each matters. The second half was NOT:
 *
 *   > "If a meaningful delay passes between generation and human approval, the UI
 *   > must flag the proposal as stale and prompt a refresh rather than let it be
 *   > approved on old data."
 *
 * Spec 21.7 open question 4 is exactly this gap -- *"What 'a meaningful delay'
 * is in requirement 4 -- the staleness threshold -- is unset, and should
 * probably differ by strategy (a grid's bounds go stale faster than a DCA's drop
 * percentage)"* -- and decision log 44 declined to pick a number in a rendering
 * layer, stating the absence on the page instead. This module is the number,
 * chosen here so that it is one named policy in one place rather than a constant
 * inside a component.
 *
 * ── ⚠ READ THIS BEFORE QUOTING ANY OF THESE FOUR NUMBERS AS THOUGH IT MEANT
 *    SOMETHING ──
 *
 * They are POLICY CHOICES, in exactly the category `DEFAULT_CONCENTRATION_POLICY`
 * (`concentration.ts`), `VERIFIED_INTERVALS` (`candles.ts`) and
 * `DERIVATIVE_NAME_SUFFIXES` (`tradability.ts`) already occupy: **no backtest
 * supports them, no volatility model produced them, no market data was consulted,
 * and no operator has yet said they are the right numbers.** They are here,
 * named, in one place, so that changing them is a visible edit rather than a
 * tuning session.
 *
 * What they ARE grounded in is the shape of the dependency -- which parameters
 * are denominated against which input, and what breaks when that input moves.
 * That reasoning is per-threshold below, and it is an ARGUMENT, NOT EVIDENCE.
 *
 * ── WHY FOUR THRESHOLDS AND NOT ONE, AND WHY ONE OF THEM IS PER-STRATEGY ──
 *
 * Decision log 44 established that four real fetch times stand behind a proposal
 * and that they age at completely different rates, so it refused to collapse them
 * into one number. The same argument applies to the thresholds, and harder: the
 * numbers below span from 15 minutes to 7 days -- nearly three orders of
 * magnitude. A single threshold would be wrong for at least three of the four.
 *
 * IT IS ALSO WHY `oldest` IS NOT THE ANSWER. `freshnessOf` already computes the
 * stalest fetch, and comparing THAT against a single threshold looks like the
 * cheap version of this module. It is not equivalent, and the difference is the
 * point:
 *
 *   * A 2-hour-old venue-rules fetch is very likely the `oldest` of the four and
 *     is nowhere near stale -- tick sizes do not move hourly.
 *   * A 20-minute-old price fetch on a GRID proposal is stale, and is almost
 *     certainly NOT the oldest.
 *
 * So each input is compared against its OWN threshold, and the proposal's verdict
 * is the worst of the four. Both cases above are pinned by tests, because they
 * are the two a single-threshold implementation would get backwards.
 *
 * ── THREE STATES, NOT TWO, AND `unknown` MUST NOT READ AS FRESH ──
 *
 * An input that never produced a value has no fetch time (`at: null`), so there
 * is nothing to compare and it is `unknown` -- neither fresh nor stale. That is
 * section 5.6's rule ("could not reach the exchange" is not a price move) applied
 * to time, and it is the same distinction `MinimumOrderCheck`'s
 * `none_published` and `DuplicateKeyCheck`'s `unavailable_transport_parsed` both
 * exist to preserve: a guarantee that could not be checked is reported, never
 * faked. A two-state boolean would have to call it one or the other, and calling
 * it fresh is how a proposal built on a failed read reads as current.
 *
 * ── WHAT THIS MODULE DOES NOT DO ──
 *
 * It does not decide whether a proposal is any GOOD -- that limit is carried
 * forward from decision logs 40, 41, 42 and 44 without dilution. A fresh proposal
 * derived from meaningless data is meaningless AND current, which is arguably the
 * more convincing failure. Staleness is a question about age, and the human in
 * 21.1 remains the only part of this loop that can judge quality.
 *
 * It also does not BLOCK anything. Requirement 4 asks the UI to flag and prompt a
 * refresh; 21.1 keeps the create-bot form as the only path to a bot, and that
 * form runs its own checks (including the ledger's binding capital compare-and-
 * swap) unchanged. Nothing here is a gate.
 *
 * ── ⚠ THIS FILE HAS NO IMPORTS, AND THAT IS LOAD-BEARING RATHER THAN INCIDENTAL ──
 *
 * The DASHBOARD imports it directly. It is the third file to cross that seam,
 * after `src/shared/alert-types.ts` (18.1 addendum) and `src/shared/money.ts`
 * (step 25), and it earns the crossing on exactly their terms: dependency-free by
 * contract, so both toolchains compile it unchanged despite the deliberate
 * TypeScript 5.7 / 7 split, and verified by building rather than assumed.
 *
 * The alternative was a documented MIRROR in `dashboard/src/`, the way
 * `dashboard/src/derive.ts` mirrors `applyPercent` because `dca.ts` could not be
 * imported. **A mirror is exactly what fails silently here.** If a threshold or
 * the comparison direction diverged, nothing would throw and nothing would fail to
 * compile -- the page would simply show a reviewer "fresh" about a proposal the
 * policy calls stale, on the screen read to decide whether to commit capital. That
 * is the failure mode `dca-dashboard-parity.test.ts` exists to close, and not
 * having a second copy closes it better than testing one does.
 *
 * So: NO import of `StrategyType` from `/src/db/schema`, which would pull the
 * Worker's D1 types into the dashboard's `tsc -b` and break it (the failure
 * `dashboard/src/derive.ts` already records). The two strategies are the keys of
 * `priceHistory`, and `staleness.test.ts` PINS those keys to `StrategyType` with a
 * two-way type assertion, so the union cannot drift even though it is not imported.
 * Adding ANY import to this file breaks the dashboard build, and the parity test
 * that imports it from the dashboard side is what says so.
 */

// ---------------------------------------------------------------------------
// The policy. JUDGEMENT CALLS, NOT VERIFIED FACTS.
// ---------------------------------------------------------------------------

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * The two strategies, as this file's own keys rather than an import.
 *
 * PINNED TO `StrategyType` (`/src/db/schema.ts`) BY A TWO-WAY TYPE ASSERTION IN
 * `staleness.test.ts`, not by this comment -- see the module header on why the
 * import is deliberately absent. A third strategy added to `StrategyType` without
 * a threshold here is a compile error in that test, which is the point.
 */
export type StalenessStrategy = "grid" | "dca";

/**
 * How old each of the four real inputs may be before a proposal resting on it is
 * flagged stale, in milliseconds.
 *
 * `priceHistory` is a record keyed by strategy because 21.7 open question 4 says
 * it should be, and because the dependency genuinely differs. The other three are
 * strategy-independent and say so by not being keyed.
 */
export interface StalenessPolicy {
  /**
   * The price window (`candles.value.fetchedAt`), PER STRATEGY.
   *
   * ── GRID: 15 MINUTES ──
   *
   * A grid's `upperBound` and `lowerBound` are ABSOLUTE PRICES, and the proposal
   * is only the proposal a human reviewed while the current price still sits
   * inside the ladder. Every live derivation this project has produced bracketed
   * its own derive-time close (decision log 42: 62660.91 < 63757.71 < 64036.14).
   * Once price leaves the band, the bot that gets created is not the one that was
   * reviewed -- it places the whole ladder on one side, or nothing -- and
   * `orderSize`, the minimum-order check at `upperBound`, and the peak-commitment
   * arithmetic are all denominated against that same window.
   *
   * Fifteen minutes, and the reasoning such as it is: it is the same order of
   * magnitude as the ONE real cross-call gap this project has measured (600 s
   * between the `/assess` and `/derive` of decision log 42's live run) with
   * headroom above it, so an ordinary two-call review does not trip it while a
   * reviewer who walks away from the tab returns to a flag instead of an
   * approval.
   *
   * ⚠ IT IS NOT DERIVED FROM MARKET VOLATILITY, and nothing here measures any.
   * The 17.60 price move entry 42 observed over those 600 s is a real
   * observation, but it is an observation about the GEMINI SANDBOX, whose data
   * entry 40 found is not a real market -- a series that sat at one price for 83
   * minutes. Quoting it as evidence about how fast bounds go stale would be
   * exactly the sandbox mistake that entry warns about.
   */
  readonly priceHistory: Readonly<Record<StalenessStrategy, number>>;
  /**
   * The capital ledger read (`context.capital.value.readAt`): 1 HOUR.
   *
   * Loose on purpose, because the cost of staleness here is a NUISANCE rather
   * than a risk, and that is a fact traced from source rather than a guess.
   * `allocatedCapital` is a PREFILL (decision log 41: `readAccountCapital` writes
   * nothing, reserves nothing and holds no lock), and the BINDING check is
   * `createBotInstanceWithCapital`'s compare-and-swap against the ledger at the
   * moment the bot is created, which refuses with `insufficient_capital`. So a
   * stale figure produces a form that fails validation, not a badly funded bot.
   *
   * An hour is chosen as materially longer than the price threshold -- because
   * the consequence is materially smaller -- while still firing on a proposal
   * reviewed after a long break, when another bot may have taken the headroom.
   */
  readonly capitalLedger: number;
  /**
   * The account's bot list (`concentration.value.readAt`): 24 HOURS.
   *
   * It changes only when a human starts or stops a bot, so it ages by human
   * action rather than by the clock: this account's real list moved from 11 bots
   * to 13 across the whole of decision logs 34-41. A day therefore fires on
   * precisely the case worth firing on -- a proposal made yesterday and reviewed
   * this morning, when someone may have stopped a bot overnight and the
   * prominent over-concentration flag (21.4) no longer describes the account.
   */
  readonly botList: number;
  /**
   * The venue's trading rules (`context.filters.value.fetchedAt`): 7 DAYS.
   *
   * The slowest-moving of the four (decision log 44). Tick size, step size and
   * Gemini's `min_order_size` change when a venue changes its own rules -- rare,
   * announced in advance, and not price-driven. A week means the flag fires on a
   * proposal being reviewed long after it was made, which is the case requirement
   * 4 exists for, without firing on anything ordinary.
   *
   * Note what this threshold is NOT protecting: the real filter check happens at
   * order time (`validateOrder`, section 4.3), so a rule that changed after the
   * proposal was made is caught there regardless of what this says.
   */
  readonly venueRules: number;
}

/**
 * ── THE DEFAULTS, AND THE ONE ASYMMETRY WORTH ARGUING WITH ──
 *
 * DCA's price threshold is 1 HOUR -- four times grid's -- and this is 21.7 open
 * question 4's own hypothesis, implemented with its reasoning checked rather than
 * assumed:
 *
 * EVERY DCA PARAMETER THAT DECIDES BEHAVIOUR IS RELATIVE. `dropPct`,
 * `stepMultiplier`, `takeProfitPct` and `stopLossPct` are percentages applied to
 * whatever price the base order actually FILLS AT, at order time. Nothing in
 * `DcaParams` names an absolute price. So the price window ages as CONTEXT for
 * the judgement ("is this a coin worth averaging into") rather than as the
 * denominator of the numbers, which is exactly the distinction 21.7 draws.
 *
 * ⚠ BUT DCA IS NOT PRICE-INDEPENDENT, and the threshold is an hour rather than
 * "no threshold" because of it. `baseOrderSize` and `additionalOrderSize` are
 * absolute quote amounts, and `derive-parse.ts`'s minimum-order check evaluates
 * them at THE NEWEST REAL CLOSE (decision log 41, which also records that this
 * reference price cannot be exact and does not claim to be). A window that has
 * aged an hour can put the implied quantity on the other side of the venue's
 * floor. The binding protection there is `validateOrder`'s filter check at order
 * time, exactly as the binding capital protection is the ledger's -- so an hour
 * bounds the drift on a check that has a real backstop, rather than pretending
 * the dependency is absent.
 *
 * An hour also keeps a DCA proposal inside roughly the same trading session, so
 * the regime the Stage 2 assessment described is still plausibly the current one.
 *
 * A DIFFERENT OPERATOR WOULD DEFEND 5 MINUTES AND 30 FOR GRID, OR 30 AND 120,
 * JUST AS WELL. What the pair encodes is the ORDERING and the rough RATIO, and
 * those are the parts the reasoning above actually supports. The absolute values
 * are the parts it does not.
 */
export const DEFAULT_STALENESS_POLICY: StalenessPolicy = Object.freeze({
  priceHistory: Object.freeze({
    grid: 15 * MINUTE_MS,
    dca: 60 * MINUTE_MS,
  }),
  capitalLedger: 1 * HOUR_MS,
  botList: 1 * DAY_MS,
  venueRules: 7 * DAY_MS,
});

// ---------------------------------------------------------------------------
// The verdict
// ---------------------------------------------------------------------------

/**
 * One input's age verdict.
 *
 *   `fresh`   -- it produced a fetch time and that time is inside its threshold.
 *   `stale`   -- it produced a fetch time and that time is outside its threshold.
 *   `unknown` -- it never produced a fetch time, so there is nothing to compare.
 *                NOT fresh. See the module header.
 */
export type StalenessVerdict = "fresh" | "stale" | "unknown";

/** One input, its real age, its own threshold, and the verdict that follows. */
export interface InputStaleness {
  /** The `FetchTimestamp.key` this verdict is about: candles, capital, concentration, filters. */
  readonly key: string;
  readonly verdict: StalenessVerdict;
  /** `now - fetchedAt`, or null when there is no fetch time. May be negative under clock skew. */
  readonly ageMs: number | null;
  /** The threshold this input was compared against. Always present, even when the verdict is `unknown`. */
  readonly thresholdMs: number;
}

/**
 * A whole proposal's staleness.
 *
 * `verdict` is the WORST of the parts, in the order `stale` > `unknown` >
 * `fresh`. Stale outranks unknown because a known-too-old input is a definite
 * reason to refuse; unknown outranks fresh for the module header's reason.
 */
export interface ProposalStaleness {
  readonly verdict: StalenessVerdict;
  readonly inputs: readonly InputStaleness[];
  /** The parts that are `stale`, so a caller can name them without re-filtering. */
  readonly staleInputs: readonly InputStaleness[];
  /** The parts that are `unknown`, for the same reason. */
  readonly unknownInputs: readonly InputStaleness[];
}

/**
 * One input's fetch time and which threshold applies to it.
 *
 * `at` is the real fetch time or null -- the same shape and the same meaning as
 * `FetchTimestamp.at` in the dashboard's `freshnessOf`, deliberately, so this
 * function can be driven straight off it with no re-derivation.
 */
export interface StalenessInput {
  readonly key: string;
  readonly at: number | null;
  readonly thresholdMs: number;
}

/**
 * ⚠ THE COMPARISON IS STRICTLY GREATER THAN, and the boundary belongs to FRESH.
 *
 * At exactly the threshold a proposal is fresh; one millisecond past it is stale.
 * That choice is as arbitrary as the numbers themselves, which is precisely why
 * it is stated here and tested at the boundary in both directions -- the same
 * treatment `ConcentrationPolicy`'s "at or above" gets, and for the same reason.
 * (The two conventions differ, and deliberately: a concentration threshold is a
 * level you have REACHED, an age threshold is a budget you have SPENT.)
 *
 * A NEGATIVE AGE IS FRESH, NOT AN ERROR. A fetch time ahead of the reader's clock
 * is ordinary clock skew between a Worker and a browser, and `formatAge` already
 * reports it as skew rather than rendering a large positive age. Treating "the
 * future" as stale would flag a proposal made seconds ago on a machine whose
 * clock is a second behind.
 */
export function verdictFor(input: StalenessInput, now: number): InputStaleness {
  if (input.at === null) {
    return { key: input.key, verdict: "unknown", ageMs: null, thresholdMs: input.thresholdMs };
  }
  const ageMs = now - input.at;
  return {
    key: input.key,
    verdict: ageMs > input.thresholdMs ? "stale" : "fresh",
    ageMs,
    thresholdMs: input.thresholdMs,
  };
}

/**
 * The worst verdict across a set of inputs: `stale` > `unknown` > `fresh`.
 *
 * An EMPTY set is `unknown`, not `fresh`. Nothing produces one today -- a
 * proposal always has four inputs -- but "no inputs were checked" answering
 * "fresh" is the fail-open shape this whole module is written against, and a
 * future caller passing a subset must not be able to reach it.
 */
export function worstVerdict(inputs: readonly InputStaleness[]): StalenessVerdict {
  if (inputs.some((input) => input.verdict === "stale")) return "stale";
  if (inputs.some((input) => input.verdict === "unknown")) return "unknown";
  if (inputs.length === 0) return "unknown";
  return "fresh";
}

/**
 * Every input's verdict, and the proposal's.
 *
 * Pure, with `now` passed in: no clock of its own, so a test drives real ages
 * rather than sleeping, and the dashboard's 1-second tick drives the same
 * function the backend's policy defines.
 */
export function stalenessOf(
  inputs: readonly StalenessInput[],
  now: number,
): ProposalStaleness {
  const verdicts = inputs.map((input) => verdictFor(input, now));
  return {
    verdict: worstVerdict(verdicts),
    inputs: verdicts,
    staleInputs: verdicts.filter((input) => input.verdict === "stale"),
    unknownInputs: verdicts.filter((input) => input.verdict === "unknown"),
  };
}

/**
 * The price-history threshold for a strategy.
 *
 * A function rather than a bare index so the per-strategy lookup has ONE
 * implementation. A call site writing `policy.priceHistory.grid` while holding a
 * `strategy` variable compiles, reads correctly in review, and quietly makes
 * every DCA proposal answer to grid's threshold -- which is exactly the class of
 * bug decision log 41's mutant D3 caught in the Derive transport.
 */
export function priceThresholdFor(
  strategy: StalenessStrategy,
  policy: StalenessPolicy = DEFAULT_STALENESS_POLICY,
): number {
  return policy.priceHistory[strategy];
}
