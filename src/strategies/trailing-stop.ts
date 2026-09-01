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
  roundToStep,
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
  /**
   * Spec 22.10. The single entry was placed `MAX_ENTRY_ATTEMPTS` times and never
   * held long enough to fill. NOT a positive exit: the strategy never started,
   * so this alerts `critical` like any other failure to trade.
   */
  | "entry_unfilled"
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
// The entry price, and the bound on how many times it may be attempted
// ---------------------------------------------------------------------------

/**
 * How far ABOVE the last trade price the single entry is priced, as a percent.
 *
 * ⚠ WHY THIS EXISTS AT ALL, from the incident that produced it (spec 22.10).
 * The first live trailing-stop bot placed its entry through `#placeBuy`, which
 * prices a buy AT the last trade price. That is right for DCA and grid, whose
 * buys are MAKER orders meant to rest on the book until the market comes to
 * them -- a DCA cycle that waits an hour for its base order is a DCA cycle
 * working as designed. It is wrong here. A trailing stop has ONE entry, and it
 * cannot begin doing the thing it exists to do -- ratchet a high-water mark
 * above a position -- until that entry fills. A buy at the last price sits
 * behind the ask and fills only if the market ticks down into it. The live bot
 * placed exactly that order ten times and filled none of them.
 *
 * So the entry is priced to CROSS the spread: a limit ABOVE the current price,
 * which the venue matches against resting asks immediately and which therefore
 * behaves like a market order in every respect except the one that matters --
 * the limit is still a hard ceiling on what may be paid. Section 4.5 rules out
 * true market orders ("for price certainty") and `OrderType` is `"limit"` alone,
 * so this is not a workaround for a missing order type; it is the same
 * marketable-limit construction `#placeLiquidationSell` already uses on the sell
 * side, applied to the one buy in this system that must not rest.
 *
 * ⚠ THE TRADEOFF, STATED PLAINLY. A crossing limit gives up price for
 * certainty. The fill may be worse than the last trade -- up to this offset
 * worse, and no worse than that -- and it pays taker rather than maker fees.
 * The resting limit it replaces gave up certainty for price, and the certainty
 * it gave up was total: it may never fill at all, which is the defect being
 * fixed. For a strategy whose entire risk model is "hold, ratchet, and exit at
 * `trailPct` below the peak", 0.25% of entry slippage is small against a trail
 * that is 1-20% wide, and it is paid once. Never filling is not small.
 *
 * ⚠ 0.25 IS A JUDGEMENT, LIKE `TRAIL_PCT_MIN`/`MAX`, AND IS MARKED AS ONE. It
 * is roughly two orders of magnitude wider than the top-of-book spread on the
 * liquid pairs this system trades, so it clears several levels of depth, while
 * capping the worst case at a quarter of one percent of the allocation. No
 * backtest or depth study produced it. If a thin symbol turns out to need more,
 * this constant is the only thing that changes.
 */
export const ENTRY_CROSS_PCT: Money = fromDecimalString("0.25");

/**
 * How many times the single entry may be placed before the bot gives up.
 *
 * ⚠ THE UNBOUNDED LOOP THIS CLOSES. `decide` is a pure function of the position
 * and the price, so it re-answers `open_entry` on EVERY candle for as long as
 * the position is flat and no order is live. That is correct for DCA and grid,
 * whose retries are bounded by their own cycle and ladder logic -- a DCA bot
 * with a resting base order has `hasOpenOrder` true and stops asking. It is
 * unbounded here, because nothing in this strategy ever concludes that the entry
 * is not going to happen. The live bot placed and lost the same order ten times
 * at the identical price and would have continued indefinitely.
 *
 * THREE, and the reasoning is the shape of the failure rather than a round
 * number. With a crossing entry a healthy placement fills on attempt one; there
 * is no market condition in which the second attempt is the lucky one. So every
 * attempt after the first is evidence of something structural -- a venue
 * cancelling on an account setting, a book too thin to cross, a symbol that is
 * quoted but not tradable. Three allows two transient cancellations to be
 * absorbed silently and surfaces a structural fault within about three candles
 * instead of ten-plus. Set higher, the bot spends longer failing quietly; set to
 * one, an ordinary venue hiccup halts a bot that a human then has to restart.
 */
export const MAX_ENTRY_ATTEMPTS = 3;

/**
 * The limit price for the single entry: `lastPrice x (100 + crossPct) / 100`,
 * aligned UP onto the symbol's tick grid.
 *
 * TWO roundings, both `ceil`, and both in the same direction for the same
 * reason -- this price exists to be crossable, so every rounding step must move
 * it further above the market, never back toward it. The tick alignment is done
 * HERE rather than left to `validateOrder`, which rounds a buy's price DOWN (its
 * "never pay more than asked" rule, correct for a maker ladder). On a symbol
 * whose tick is coarse relative to the offset, that floor would quietly undo the
 * crossing and hand back the resting order this function exists to replace. An
 * already-aligned price makes `validateOrder`'s floor a no-op, so the two rules
 * agree instead of fighting.
 *
 * `tickSize` of ZERO means the symbol has no price grid (`DISABLED` in
 * `filters.ts`), and the raw price is returned unaligned.
 */
export function entryLimitPrice(lastPrice: Money, crossPct: Money, tickSize: Money): Money {
  const crossed = divideRounded(
    lastPrice * (HUNDRED_PERCENT + crossPct),
    HUNDRED_PERCENT,
    "ceil",
  );
  return tickSize > ZERO ? roundToStep(crossed, tickSize, "ceil") : crossed;
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
  /**
   * How many times the single entry has already been PLACED on the exchange
   * (spec 22.10). Bounds the entry, and nothing else.
   *
   * ⚠ REQUIRED, NOT OPTIONAL WITH A ZERO DEFAULT, even though the stored state
   * field behind it IS optional. A default here would mean a caller that forgot
   * to pass it got an unbounded bot and no compile error -- which is precisely
   * the failure this field exists to prevent, reintroduced one level up. The
   * `?? 0` belongs at the one place that reads storage, not in the rule.
   *
   * Never reset. There is one entry in this strategy's whole life (22.2 decision
   * 4), so a counter that could be reset would be counting something else.
   */
  readonly entryAttempts: number;
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
    if (input.hasOpenOrder) return { kind: "hold" };

    // SPEC 22.10. Checked BEFORE `open_entry` is returned, so the cap bounds
    // placements rather than trailing them by one: at the cap, the next answer
    // is the halt, not one more order followed by a halt.
    if (input.entryAttempts >= MAX_ENTRY_ATTEMPTS) {
      return {
        kind: "halt",
        reason: "entry_unfilled",
        detail:
          `the entry order was placed ${input.entryAttempts} times and never filled, so this ` +
          `bot has no position to trail and has stopped trying. Each attempt was a limit ` +
          `${toDecimalString(ENTRY_CROSS_PCT)} percent above the market, priced to fill ` +
          `immediately, so an order that did not fill was almost certainly cancelled on the ` +
          `exchange rather than left behind by the price. Check the account's own ` +
          `order-cancellation settings before restarting this bot.`,
      };
    }

    return { kind: "open_entry", quoteAmount: config.allocatedCapital };
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
