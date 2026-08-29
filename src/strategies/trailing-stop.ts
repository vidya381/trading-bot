/**
 * Trailing stop (spec section 22): parameters, decoding and validation.
 *
 * ⚠ THIS IS NOT A COMPLETE STRATEGY, AND THE DIRECTORY IT SITS IN IMPLIES THAT
 * IT IS. `dca.ts` and `grid.ts` each carry a `decide()` -- the pure
 * configuration-and-price-in, action-out function section 22.1 requires and
 * section 13's backtesting depends on. THIS FILE HAS NO `decide()`. It exists
 * because 22.4 touchpoint 7 places the decoder "alongside `decodeGridParams` /
 * `decodeDcaParams`" and requires Stage 3's validation to REUSE it rather than
 * reimplement it (21.5 requirement 3: a second implementation of a risk check
 * drifts from the first, and the copy that drifts is the one nobody is watching).
 * One shared decoder needs one home, and this is it.
 *
 * What is still missing before a trailing-stop bot can exist: `decide()`, the
 * Durable Object's `createTrailingStop`, the exit-completion path (22.9), and
 * 22.3's dropped-candle test, which is a HARD precondition for shipping.
 */

import {
  ONE,
  ZERO,
  divideRounded,
  fromDecimalString,
  max,
  toDecimalString,
  type Money,
} from "../shared/money";

/**
 * Section 8.1 and 16.
 *
 * Independent of `DCA_SCHEMA_VERSION` and `GRID_SCHEMA_VERSION` for the reason
 * `grid.ts` states: strategies store different state and version separately, so
 * one strategy's migration must not make another's stored state unreadable.
 */
export const TRAILING_STOP_SCHEMA_VERSION = 1;

/** 100, as Money. Percentages are stored as the percentage itself, not a rate. */
const HUNDRED_PERCENT = 100n * ONE;

/**
 * ⚠ PROVISIONAL BOUNDS. 22.5 open question 1 proposes 1-20% and marks it
 * explicitly UNCONFIRMED: "Both ends need an argument: too tight and ordinary
 * noise exits every position immediately; too loose and the strategy gives back
 * most of what it gained before triggering."
 *
 * They are enforced rather than ignored -- an unbounded trail is worse than a
 * provisionally bounded one -- but they are NOT settled, and no backtest,
 * volatility model or market data produced them. When they are settled, this
 * constant pair and the message below are the only things that change.
 */
export const TRAIL_PCT_MIN: Money = ONE;
export const TRAIL_PCT_MAX: Money = 20n * ONE;

export type TrailingStopErrorCode =
  /** A parameter is zero, negative, or otherwise outside its permitted range. */
  | "invalid_parameter"
  /** Stored state carries a schemaVersion this code does not know how to read. */
  | "unknown_schema_version";

export class TrailingStopError extends Error {
  readonly code: TrailingStopErrorCode;

  constructor(code: TrailingStopErrorCode, message: string) {
    super(message);
    this.name = "TrailingStopError";
    this.code = code;
  }
}

/**
 * The strategy's parameters. ONE field, per 22.2 decision 1.
 *
 * `trailPct` does double duty: the trail distance below the high-water mark, and
 * the initial stop distance from entry before any new high is made. 22.2 decision
 * 1 records that this can later be split into two parameters additively, without
 * restructuring the strategy.
 *
 * ⚠ NO ORDER SIZE, AND THAT IS NOT AN OMISSION. Per 22.2's consequence of
 * decisions 1 and 4, the single entry is sized by `allocatedCapital`; there is no
 * field here that could size it otherwise.
 */
export interface TrailingStopParams {
  readonly trailPct: Money;
}

/** The stored JSON shape, mirroring `DcaParamsJson`/`GridParamsJson`. */
export interface TrailingStopParamsJson {
  readonly strategy: "trailing_stop";
  readonly schemaVersion: number;
  readonly trailPct: string;
}

export function encodeTrailingStopParams(params: TrailingStopParams): TrailingStopParamsJson {
  return {
    strategy: "trailing_stop",
    schemaVersion: TRAILING_STOP_SCHEMA_VERSION,
    trailPct: toDecimalString(params.trailPct),
  };
}

/**
 * Reject stored state written by a schema version this code cannot read
 * (section 16). One version so far, so this only guards the unreadable case.
 */
export function assertReadableSchema(schemaVersion: number): void {
  if (schemaVersion !== TRAILING_STOP_SCHEMA_VERSION) {
    throw new TrailingStopError(
      "unknown_schema_version",
      `stored state is schemaVersion ${schemaVersion}, and this code reads ` +
        `${TRAILING_STOP_SCHEMA_VERSION}. A bot with an open position must not be operated by ` +
        `code that cannot read its state; migrate it or let the position close under ` +
        `the previous deploy (section 16).`,
    );
  }
}

/**
 * Decode stored or submitted params. The `strategy` discriminator is checked
 * first, exactly as `decodeDcaParams` checks for `"dca"`.
 */
export function decodeTrailingStopParams(raw: unknown): TrailingStopParams {
  if (typeof raw !== "object" || raw === null) {
    throw new TrailingStopError(
      "invalid_parameter",
      `strategy params are ${typeof raw}, not an object`,
    );
  }
  const json = raw as Partial<TrailingStopParamsJson>;
  if (json.strategy !== "trailing_stop") {
    throw new TrailingStopError(
      "invalid_parameter",
      `strategy params are for ${JSON.stringify(json.strategy)}, not trailing_stop`,
    );
  }
  assertReadableSchema(json.schemaVersion ?? 0);

  if (typeof json.trailPct !== "string") {
    throw new TrailingStopError(
      "invalid_parameter",
      `strategy params field trailPct is ${typeof json.trailPct}, not a string`,
    );
  }
  return { trailPct: fromDecimalString(json.trailPct) };
}

/**
 * The real validator, run by `POST /api/bots` and reused by Stage 3's
 * deterministic validation. One implementation, two callers.
 *
 * Takes `allocatedCapital` for the same reason grid's and DCA's do -- but checks
 * something different with it. Theirs answer "can this configuration be FUNDED";
 * a trailing stop's single entry IS its allocation, so there is no funding
 * arithmetic, only the question of whether an order can be placed at all.
 */
export function validateTrailingStopParams(
  params: TrailingStopParams,
  allocatedCapital: Money,
): void {
  // Arithmetic impossibility first, and separately from the provisional range:
  // these two are not judgement calls, and saying so in a distinct message keeps
  // "you typed something meaningless" apart from "that is outside our range".
  if (params.trailPct <= ZERO) {
    throw new TrailingStopError(
      "invalid_parameter",
      `trailPct must be positive, got ${toDecimalString(params.trailPct)}: a trail at or ` +
        `below zero is not a trail, and would sit at or above the high-water mark it follows.`,
    );
  }
  if (params.trailPct >= HUNDRED_PERCENT) {
    throw new TrailingStopError(
      "invalid_parameter",
      `trailPct must be below 100, got ${toDecimalString(params.trailPct)}: a trail of 100% or ` +
        `more puts the stop at or below zero, where no positive price can ever reach it.`,
    );
  }
  if (params.trailPct < TRAIL_PCT_MIN || params.trailPct > TRAIL_PCT_MAX) {
    throw new TrailingStopError(
      "invalid_parameter",
      `trailPct is ${toDecimalString(params.trailPct)}, outside the permitted range of ` +
        `${toDecimalString(TRAIL_PCT_MIN)} to ${toDecimalString(TRAIL_PCT_MAX)} percent. ` +
        `Below the floor, ordinary market noise exits the position almost immediately; above ` +
        `the ceiling, the trail gives back most of what it gained before it triggers. ` +
        `NOTE: these bounds are PROVISIONAL (spec 22.5 open question 1) -- they are a ` +
        `deliberate starting range, not a backtested result.`,
    );
  }
  if (allocatedCapital <= ZERO) {
    throw new TrailingStopError(
      "invalid_parameter",
      `allocatedCapital must be positive, got ${toDecimalString(allocatedCapital)}: this ` +
        `strategy's single entry is sized by its allocation (spec 22.2), so a non-positive ` +
        `allocation can place no order at all.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Config, halt reasons, and the trail level
// ---------------------------------------------------------------------------

/** Everything a `BotInstance` needs to know about a trailing-stop bot. */
export interface TrailingStopConfig {
  /** Discriminates the config union in the Durable Object. */
  readonly strategy: "trailing_stop";
  /** Section 8.1 and 16. See TRAILING_STOP_SCHEMA_VERSION. */
  readonly schemaVersion: number;
  /** Matches BOT_INSTANCE_ID_PATTERN; embedded in every clientOrderId. */
  readonly botInstanceId: string;
  readonly accountLabel: string;
  readonly exchange: string;
  readonly pair: string;
  /** The asset `allocatedCapital` is denominated in, and the single entry with it. */
  readonly capitalAsset: string;
  readonly allocatedCapital: Money;
  readonly params: TrailingStopParams;
}

export type TrailingStopHaltReason =
  /**
   * Spec 22.9. The trail was crossed and the position exited -- the strategy's
   * INTENDED, SUCCESSFUL outcome, not a failure. Named with the `_reached`
   * suffix DCA's `take_profit_reached` uses for the same role, and listed in
   * `#halt`'s `positiveExit` so it alerts as `info` rather than `critical`.
   */
  | "trailing_stop_reached"
  /** Section 7.5: an unexpected exception in strategy or order-placing code. */
  | "unhandled_error"
  /** An order the exchange refused for a reason that will not fix itself. */
  | "order_rejected"
  /** A human halted it from the dashboard, or section 7.3/7.4 did. */
  | "manual";

/**
 * `highWaterMark x (100 - trailPct) / 100` -- the price at or below which the
 * position exits.
 *
 * ONE rounding step, matching `applyPercent` in `dca.ts` and `grid.ts`. `ceil`
 * for the reason `stopLossPrice` uses it: rounding a protective stop UP makes it
 * trigger no later than the exact level, never later.
 *
 * Lives here rather than in `serialize.ts`, which is where it was first written
 * when this module did not exist. One implementation, imported by the view --
 * the dashboard-parity test asserts it against `stopLossPrice`'s arithmetic.
 */
export function trailLevelOf(highWaterMark: Money, trailPct: Money): Money {
  return divideRounded(highWaterMark * (HUNDRED_PERCENT - trailPct), HUNDRED_PERCENT, "ceil");
}

// ---------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------

/**
 * What the strategy wants done next.
 *
 * A closed set, so the Durable Object's dispatch is exhaustive and adding a case
 * later is a compile error rather than a silently ignored action -- the reason
 * `dca.ts` gives for the same shape.
 */
export type TrailingStopAction =
  /** Nothing to do at this price. */
  | { readonly kind: "hold" }
  /** 22.2 decision 4's single entry, sized by the allocation (22.2's consequence note). */
  | { readonly kind: "open_entry"; readonly quoteAmount: Money }
  /** The trail was crossed. Sell the whole position; the fill halts the bot (22.9). */
  | {
      readonly kind: "trailing_exit";
      readonly trailLevel: Money;
      readonly highWaterMark: Money;
      readonly quantity: Money;
    }
  /** Section 7.2. */
  | { readonly kind: "halt"; readonly reason: TrailingStopHaltReason; readonly detail: string };

/** The position fields this strategy reads. Structurally satisfied by `DcaPosition`. */
export interface TrailingStopPosition {
  readonly quantity: Money;
  readonly averageEntryPrice: Money;
}

/** Everything `decide` looks at, gathered so the function stays pure. */
export interface TrailingStopDecisionInput {
  readonly config: TrailingStopConfig;
  readonly position: TrailingStopPosition;
  /**
   * The persisted high-water mark, ALREADY RATCHETED for this price.
   *
   * ⚠ READ, NEVER RECOMPUTED. `#onPriceUpdatePass` raises the mark on the same
   * state write that records `lastPrice`, before this function is called, and
   * `raisesHighWaterMark` is the only place that decision is made. A second
   * ratchet here would be a second implementation of the same rule, free to
   * disagree with the stored one -- and the stored one is what the 22.8 integrity
   * detector reads. `undefined` before the bot has seen any price.
   */
  readonly highWaterMark: Money | undefined;
  /** The latest usable price. Section 5.6 governs what counts as usable. */
  readonly price: Money;
  /**
   * Whether an order this bot placed is still live.
   *
   * Suppresses the ENTRY only. The trailing exit still fires with an order
   * outstanding, for the reason `dca.ts` gives: a risk exit must not wait on a
   * resting limit order that may never fill, and the halt path cancels open
   * orders anyway.
   */
  readonly hasOpenOrder: boolean;
}

/**
 * The strategy, as a pure function (spec 22.1).
 *
 * No I/O and no clock, so section 13's backtesting can drive it directly and so
 * the dropped-candle behaviour 22.3 requires can be tested as arithmetic.
 */
export function decide(input: TrailingStopDecisionInput): TrailingStopAction {
  const { config, position, price, highWaterMark } = input;

  if (price <= ZERO) {
    throw new TrailingStopError("invalid_parameter", `price must be positive, got ${price}`);
  }

  // No position yet: waiting on the single entry.
  if (position.quantity <= ZERO) {
    return input.hasOpenOrder
      ? { kind: "hold" }
      : { kind: "open_entry", quoteAmount: config.allocatedCapital };
  }

  // 22.2 DECISION 3'S FORMULA, VERBATIM:
  //   stop = max(entry_price, highest_price_observed_since_entry) x (1 - trailPct)
  //
  // The `max` against the entry price is what makes 22.2 decision 2 work: before
  // any new high exists the high-water mark IS the entry, and the formula
  // degrades into a plain stop-loss at trailPct below entry. It also makes a
  // missing `highWaterMark` safe rather than special-cased -- see 22.3.
  const reference = max(position.averageEntryPrice, highWaterMark ?? ZERO);
  const trailLevel = trailLevelOf(reference, config.params.trailPct);

  // ⚠ A LEVEL TEST, NOT A CROSSING EVENT, AND THAT IS THE 22.3 PROPERTY.
  // This compares the current price against the current trail every time it
  // runs. It does not ask "did price cross since last time", so it holds no
  // state that a dropped candle could desynchronise: a candle that is never
  // delivered cannot consume the exit, because there is nothing to consume. The
  // next delivered candle re-asks the same question against the same trail.
  if (price <= trailLevel) {
    return {
      kind: "trailing_exit",
      trailLevel,
      highWaterMark: reference,
      quantity: position.quantity,
    };
  }

  return { kind: "hold" };
}
