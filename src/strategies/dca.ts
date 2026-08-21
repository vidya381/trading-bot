/**
 * The DCA strategy, as pure logic (spec section 6.3), build step 6.
 *
 * There is no storage, no exchange call and no Durable Object here. This module
 * answers one question -- "given this configuration, this position, and this
 * price, what should happen next?" -- and returns the answer as data. The
 * Durable Object in `/src/durable-objects/bot-instance.ts` is what carries the
 * answer out: it places the orders, persists the state, and mirrors to D1.
 *
 * That split is section 13's requirement, not tidiness. Backtesting has to run
 * "the same strategy code ... without duplication" against historical candles,
 * and it can only do that if the strategy is separable from the machinery that
 * talks to an exchange. `decide` takes a price and returns an action, so a
 * backtest drives it directly.
 *
 * ROUNDING DIRECTIONS
 * -------------------
 * Step 2's decision 3 removed every default rounding mode on purpose, so each
 * threshold here names its own, and each one is chosen to be conservative in
 * the direction that matters:
 *
 *   - stop-loss price rounds UP, so the halt triggers a fraction sooner;
 *   - take-profit price rounds UP, so the exit requires the full configured
 *     profit rather than a fraction less;
 *   - the next buy trigger rounds DOWN, so an additional buy requires the full
 *     configured drop rather than firing a fraction early;
 *   - order sizes round DOWN, so the bot never plans to spend more than it
 *     said it would.
 *
 * Every threshold is computed as one `divideRounded` over a scale-16
 * intermediate rather than as a percentage converted to a rate and then
 * applied, so there is exactly one rounding step between the input and the
 * threshold instead of two.
 */

import type { Money, Rounding } from "../shared/money";
import { divideRounded, fromDecimalString, mulInt, ONE, toDecimalString, ZERO } from "../shared/money";
import type { Timestamp } from "../shared/exchange-client";

/**
 * Stored-state schema version (spec sections 8.1 and 16).
 *
 * Bumped whenever the shape of `DcaConfig` or `DcaState` changes in a way that
 * an already-running bot's stored state would not satisfy. Section 16 requires
 * a migration step that runs the first time an object wakes under new code;
 * `migrateStoredState` below is where that goes.
 */
export const DCA_SCHEMA_VERSION = 1;

/** 100, as Money. Percentages are stored as the percentage itself, not a rate. */
const HUNDRED_PERCENT = 100n * ONE;

export type DcaErrorCode =
  /** A parameter is zero, negative, or otherwise outside its permitted range. */
  | "invalid_parameter"
  /** The configured buys cannot all be funded from the allocated capital. */
  | "exceeds_allocated_capital"
  /** Stored state carries a schemaVersion this code does not know how to read. */
  | "unknown_schema_version";

export class DcaError extends Error {
  readonly code: DcaErrorCode;

  constructor(code: DcaErrorCode, message: string) {
    super(message);
    this.name = "DcaError";
    this.code = code;
  }
}

/**
 * Section 6.3's parameters.
 *
 * Order sizes are denominated in the QUOTE asset (the bot's `capital_asset`),
 * not the base asset. Section 6.3 says only "base order size" and leaves the
 * denomination open; quote was chosen because `allocated_capital` and the whole
 * of section 8.5's capital ledger are denominated that way, so a size in quote
 * can be checked against the allocation directly. A size in base could not be,
 * without knowing a price that does not exist at configuration time.
 */
export interface DcaParams {
  /** Quote spent on the first buy of every cycle. */
  readonly baseOrderSize: Money;
  /** Quote spent on the first ADDITIONAL buy. */
  readonly additionalOrderSize: Money;
  /**
   * Applied to each additional buy after the first, compounding: the second
   * additional buy is `additionalOrderSize x stepMultiplier`, the third is that
   * again x `stepMultiplier`, and so on. ONE means every additional buy is the
   * same size.
   */
  readonly stepMultiplier: Money;
  /** Percentage drop from the LAST ENTRY price that triggers the next buy. */
  readonly dropPct: Money;
  /** Section 6.3's "maximum number of additional buys". Excludes the base order. */
  readonly maxAdditionalBuys: number;
  /** Percentage above AVERAGE ENTRY at which the full position is sold. */
  readonly takeProfitPct: Money;
  /** Percentage drawdown from AVERAGE ENTRY that halts the bot. */
  readonly stopLossPct: Money;
  /**
   * Section 6.3 step 6: after a take-profit exit, start a fresh cycle rather
   * than stopping for human review.
   */
  readonly autoRestart: boolean;
  /**
   * Whether a stop-loss halt also sells the position.
   *
   * **NOT IMPLEMENTED. `true` is currently rejected at validation.**
   *
   * Section 6.3 step 5 requires that the bot "not auto-sell at a large loss
   * without this being an explicit, configured behavior the account owner has
   * chosen", so the option has to exist in the model even before the selling
   * half is built. What it must never do is exist and quietly do nothing: a
   * config field that reads as a risk control and is not one is worse than an
   * absent field, because someone sets it and believes the position will be
   * closed.
   *
   * So the field is here, `false` is the only accepted value, and
   * `validateDcaParams` refuses `true` with a message saying why. Building the
   * sell half is a follow-up. Note it differs from section 6.2's grid
   * stop-loss, which does sell -- the two strategies genuinely differ.
   */
  readonly sellOnStopLoss: boolean;
}

/** Everything a `BotInstance` needs to know about itself, persisted verbatim. */
export interface DcaConfig {
  /**
   * Discriminates the config union in the Durable Object (grid is the other
   * arm, added at step 9). Required here so a stored config always records which
   * strategy it is; the object reads an ABSENT `strategy` as `"dca"`, the
   * section-16-additive treatment for any state written before this field
   * existed -- of which there is none, since no exchange client has ever run.
   */
  readonly strategy: "dca";
  /** Section 8.1 and 16. See DCA_SCHEMA_VERSION. */
  readonly schemaVersion: number;
  /** Matches BOT_INSTANCE_ID_PATTERN; embedded in every clientOrderId. */
  readonly botInstanceId: string;
  readonly accountLabel: string;
  readonly exchange: string;
  readonly pair: string;
  /** The asset `allocatedCapital` and every order size are denominated in. */
  readonly capitalAsset: string;
  readonly allocatedCapital: Money;
  readonly params: DcaParams;
}

/** One filled entry in the current cycle. */
export interface DcaEntry {
  readonly clientOrderId: string;
  readonly price: Money;
  /** Base asset acquired. */
  readonly quantity: Money;
  /** Quote asset spent, as executed rather than as planned. */
  readonly cost: Money;
  readonly at: Timestamp;
}

/**
 * The position built up by the current cycle.
 *
 * `averageEntryPrice` is derived (cost / quantity) but stored, because section
 * 6.3 step 3 requires it to be recalculated on every entry and both risk
 * thresholds key off it. Storing it means the number the bot acted on is the
 * number that was recorded, rather than one recomputed later from rounded
 * inputs.
 */
export interface DcaPosition {
  /** Base asset held. */
  readonly quantity: Money;
  /** Quote asset spent acquiring it. */
  readonly cost: Money;
  readonly averageEntryPrice: Money;
  readonly entries: readonly DcaEntry[];
  /** Additional buys FILLED so far this cycle. Excludes the base order. */
  readonly additionalBuysUsed: number;
  /** Price of the most recent entry: the reference for the next drop trigger. */
  readonly lastEntryPrice: Money;
}

export const EMPTY_POSITION: DcaPosition = {
  quantity: ZERO,
  cost: ZERO,
  averageEntryPrice: ZERO,
  entries: [],
  additionalBuysUsed: 0,
  lastEntryPrice: ZERO,
};

export type DcaHaltReason =
  /** Section 6.3 step 5: drawdown from average entry breached. */
  | "stop_loss"
  /** Section 7.5: an unexpected exception in strategy or order-placing code. */
  | "unhandled_error"
  /** An order the exchange refused for a reason that will not fix itself. */
  | "order_rejected"
  /** Section 6.3 step 6 with autoRestart off: the cycle finished, awaiting review. */
  | "take_profit_reached"
  /** A human halted it from the dashboard, or section 7.3/7.4 did. */
  | "manual";

/**
 * What the strategy wants done next.
 *
 * A closed set, so the Durable Object's dispatch is exhaustive and adding a
 * case later is a compile error rather than a silently ignored action.
 */
export type DcaAction =
  /** Nothing to do at this price. */
  | { readonly kind: "hold" }
  /** Section 6.3 step 2: the cycle's first buy. */
  | { readonly kind: "open_base"; readonly quoteAmount: Money }
  /** Section 6.3 step 3: price dropped the configured percentage from the last entry. */
  | {
      readonly kind: "additional_buy";
      /** 0-based index among the additional buys; sizes the order. */
      readonly index: number;
      readonly quoteAmount: Money;
      readonly triggerPrice: Money;
    }
  /** Section 6.3 step 4: sell the full position. Mandatory exit for DCA. */
  | { readonly kind: "take_profit"; readonly targetPrice: Money; readonly quantity: Money }
  /** Section 7.2. */
  | { readonly kind: "halt"; readonly reason: DcaHaltReason; readonly detail: string };

/** Everything `decide` looks at, gathered so the function stays pure. */
export interface DcaDecisionInput {
  readonly config: DcaConfig;
  readonly position: DcaPosition;
  /** The latest usable price. Section 5.6 governs what counts as usable. */
  readonly price: Money;
  /**
   * Whether an order this bot placed is still live.
   *
   * Suppresses further BUYS only. A stop-loss or take-profit still fires with
   * an order outstanding, because the halt path cancels open orders anyway and
   * a risk exit must not wait on a resting limit order that may never fill.
   */
  readonly hasOpenOrder: boolean;
}

// ---------------------------------------------------------------------------
// Thresholds
// ---------------------------------------------------------------------------

/** `base x (100 + pct) / 100`, in one rounding step. */
function applyPercent(base: Money, pct: Money, rounding: Rounding): Money {
  return divideRounded(base * (HUNDRED_PERCENT + pct), HUNDRED_PERCENT, rounding);
}

/**
 * Price at or below which the next additional buy fires (section 6.3 step 3).
 *
 * Measured from the LAST ENTRY, not from the average. Section 6.3 says "each
 * time price drops by the configured percentage from the last entry", and the
 * two differ once more than one entry exists: averaging up the reference would
 * make each successive buy trigger sooner than configured.
 *
 * Rounds down, so the drop must be at least the configured percentage.
 */
export function nextBuyTriggerPrice(params: DcaParams, lastEntryPrice: Money): Money {
  return applyPercent(lastEntryPrice, -params.dropPct, "floor");
}

/** Price at or above which the full position is sold (section 6.3 step 4). */
export function takeProfitPrice(params: DcaParams, averageEntryPrice: Money): Money {
  return applyPercent(averageEntryPrice, params.takeProfitPct, "ceil");
}

/** Price at or below which the bot halts (section 6.3 step 5). */
export function stopLossPrice(params: DcaParams, averageEntryPrice: Money): Money {
  return applyPercent(averageEntryPrice, -params.stopLossPct, "ceil");
}

/**
 * Quote to spend on the additional buy at `index` (0-based).
 *
 * Compounded by repeated multiplication rather than by raising `stepMultiplier`
 * to a power, and floored at each step. That makes the sequence exactly
 * reproducible: `plannedTotalSpend` sums the same values this returns, so the
 * capital check at creation and the amount actually requested at run time
 * cannot disagree by a rounding step.
 */
export function additionalOrderSizeFor(params: DcaParams, index: number): Money {
  if (!Number.isInteger(index) || index < 0) {
    throw new DcaError("invalid_parameter", `additional buy index must be a non-negative integer, got ${index}`);
  }
  let size = params.additionalOrderSize;
  for (let step = 0; step < index; step += 1) {
    size = divideRounded(size * params.stepMultiplier, ONE, "floor");
  }
  return size;
}

/**
 * Quote required if every configured buy fires: the base order plus every
 * additional buy. This is what `allocated_capital` has to cover.
 */
export function plannedTotalSpend(params: DcaParams): Money {
  let total = params.baseOrderSize;
  for (let index = 0; index < params.maxAdditionalBuys; index += 1) {
    total += additionalOrderSizeFor(params, index);
  }
  return total;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Reject a configuration that cannot work, before any capital is reserved.
 *
 * The capital check is the one worth stating: section 6.1 checks the requested
 * allocation against the account's free balance, but nothing anywhere checks
 * that the bot's own parameters fit inside its own allocation. Without this, a
 * bot with a 100 USDT allocation and 5 x 50 USDT buys configured would be
 * created happily and then fail at the exchange on its third buy, mid-cycle,
 * with a position already open -- which section 7.5 turns into a halt. Failing
 * at creation instead costs nothing.
 */
export function validateDcaParams(params: DcaParams, allocatedCapital: Money): void {
  const positive: readonly (readonly [string, Money])[] = [
    ["baseOrderSize", params.baseOrderSize],
    ["dropPct", params.dropPct],
    ["takeProfitPct", params.takeProfitPct],
    ["stopLossPct", params.stopLossPct],
  ];
  for (const [name, value] of positive) {
    if (value <= ZERO) {
      throw new DcaError("invalid_parameter", `${name} must be positive, got ${value}`);
    }
  }

  if (!Number.isInteger(params.maxAdditionalBuys) || params.maxAdditionalBuys < 0) {
    throw new DcaError(
      "invalid_parameter",
      `maxAdditionalBuys must be a non-negative integer, got ${params.maxAdditionalBuys}`,
    );
  }
  if (params.maxAdditionalBuys > 0) {
    if (params.additionalOrderSize <= ZERO) {
      throw new DcaError(
        "invalid_parameter",
        `additionalOrderSize must be positive when maxAdditionalBuys is ${params.maxAdditionalBuys}`,
      );
    }
    if (params.stepMultiplier <= ZERO) {
      throw new DcaError("invalid_parameter", `stepMultiplier must be positive, got ${params.stepMultiplier}`);
    }
  }

  // A drop of 100% or more would take the trigger price to zero or below, and
  // a stop-loss of 100% or more can never be reached by a positive price.
  if (params.dropPct >= HUNDRED_PERCENT) {
    throw new DcaError("invalid_parameter", `dropPct must be below 100%, got ${params.dropPct}`);
  }
  if (params.stopLossPct >= HUNDRED_PERCENT) {
    throw new DcaError("invalid_parameter", `stopLossPct must be below 100%, got ${params.stopLossPct}`);
  }

  if (params.sellOnStopLoss) {
    throw new DcaError(
      "invalid_parameter",
      `sellOnStopLoss is not implemented: a stop-loss halt cancels open orders ` +
        `and leaves the position held. Accepting it would mean a configured risk ` +
        `control that silently does nothing, which is worse than not offering it. ` +
        `See the note on DcaParams.sellOnStopLoss.`,
    );
  }

  const planned = plannedTotalSpend(params);
  if (planned > allocatedCapital) {
    throw new DcaError(
      "exceeds_allocated_capital",
      `this configuration spends ${planned} at scale 8 if every buy fires ` +
        `(base order plus ${params.maxAdditionalBuys} additional buys), which is more ` +
        `than the ${allocatedCapital} allocated to it. The bot would halt mid-cycle ` +
        `with a position open when a buy could no longer be funded.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Position maths
// ---------------------------------------------------------------------------

/**
 * Fold one filled entry into the position, recalculating the average entry
 * price (section 6.3 step 3).
 *
 * Average entry is total cost divided by total quantity, from the amounts
 * actually executed rather than the amounts requested -- partial fills and
 * step-size rounding both mean those differ. Rounded half-even: it is a
 * derived accounting figure that accumulates across many entries, matching
 * step 2's decision 3 on internal accounting values.
 */
export function applyEntry(position: DcaPosition, entry: DcaEntry, isAdditional: boolean): DcaPosition {
  if (entry.quantity <= ZERO) {
    throw new DcaError("invalid_parameter", `entry quantity must be positive, got ${entry.quantity}`);
  }
  const quantity = position.quantity + entry.quantity;
  const cost = position.cost + entry.cost;
  return {
    quantity,
    cost,
    averageEntryPrice: divideRounded(cost * ONE, quantity, "half-even"),
    entries: [...position.entries, entry],
    additionalBuysUsed: position.additionalBuysUsed + (isAdditional ? 1 : 0),
    lastEntryPrice: entry.price,
  };
}

/** One exit-side execution, as the accounting needs it. */
export interface DcaExit {
  /** Base sold by THIS fill. Positive. */
  readonly quantity: Money;
  /**
   * Quote received for it, at the price the fill actually executed at -- not at
   * the order's limit price. `applyFill` already computes exactly this figure as
   * its `quoteDelta`, so the caller has it to hand and nothing is re-derived.
   */
  readonly proceeds: Money;
}

/** What one exit fill did to the position, and what it realized doing it. */
export interface DcaExitEffect {
  readonly position: DcaPosition;
  /**
   * Realized profit (or loss) on the base this fill sold: what it fetched, less
   * the cost basis that left the position with it.
   */
  readonly realized: Money;
}

/**
 * Apply one exit fill: the inverse `applyEntry` never had.
 *
 * WHY THIS DID NOT EXIST, AND WHAT IT COST. Within a cycle `quantity` and `cost`
 * only ever grew, and both were zeroed together, wholesale, at
 * `#completeCycle` / `#completeLiquidation` -- reached only when an exit sell
 * FULLY fills. An exit that filled PARTIALLY and was then cancelled, or that
 * simply rested part-filled, never touched the position at all. Two live bots
 * sat holding a `position.quantity` that counted coin they had already sold, one
 * of them by a factor of 3.7, with its stop-loss and take-profit both computed
 * from the inflated figure. This is the function whose absence caused that.
 *
 * THE COST MODEL IS PROPORTIONAL, matching the one-time repair built for those
 * two bots so that a normally-run position and a repaired one cannot disagree.
 * `cost` is scaled by the fraction still held, which holds `averageEntryPrice`
 * steady -- the coin still held WAS bought at that average, and both risk
 * thresholds key off it. Leaving `cost` whole while reducing `quantity` would
 * inflate the average by the inverse of the fraction remaining and drag the
 * stop-loss and take-profit with it.
 *
 * THE COST BASIS IS TAKEN AS A REMAINDER, NOT AS A PRODUCT, and that is a small
 * but deliberate improvement on the repair's form. The repair measured the sold
 * leg as `soldQuantity x averageEntryPrice`; this measures it as `cost - newCost`.
 * The two agree to within rounding on any single exit, but only the remainder
 * form is SELF-BALANCING: the amounts removed across every fill of a full exit
 * sum to exactly the cycle's original cost, leaving no residue and no drift, at
 * any number of partial fills. `cost` therefore reaches exactly ZERO when the
 * position goes flat rather than approximately zero.
 *
 * WHAT IT DELIBERATELY DOES NOT TOUCH. `entries` is buy-side by definition -- it
 * records what BUILT the position, one element per applied buy fill -- so an
 * exit appends nothing and removes nothing; `#completeCycle` clears the whole
 * position when the cycle ends. `additionalBuysUsed` and `lastEntryPrice` are
 * likewise properties of the entry side: selling does not hand back a buy
 * allowance, and it does not change which entry the next drop trigger is
 * measured from.
 */
export function applyExit(position: DcaPosition, exit: DcaExit): DcaExitEffect {
  if (exit.quantity <= ZERO) {
    throw new DcaError("invalid_parameter", `exit quantity must be positive, got ${exit.quantity}`);
  }
  if (exit.quantity > position.quantity) {
    // Unreachable in ordinary operation -- an exit is sized from
    // `position.quantity` and rounded DOWN onto the symbol's step, and
    // `applyFill` caps fills at the order's own quantity -- so reaching here
    // means the books already disagree with themselves. Refusing is section
    // 7.5's business; silently clamping would hide the very condition this
    // function exists to stop producing.
    throw new DcaError(
      "invalid_parameter",
      `exit quantity ${exit.quantity} exceeds the position's ${position.quantity}`,
    );
  }

  const quantity = position.quantity - exit.quantity;
  const cost =
    quantity > ZERO
      ? divideRounded(position.cost * quantity, position.quantity, "half-even")
      : ZERO;

  return {
    position: {
      quantity,
      cost,
      averageEntryPrice:
        quantity > ZERO ? divideRounded(cost * ONE, quantity, "half-even") : ZERO,
      entries: position.entries,
      additionalBuysUsed: position.additionalBuysUsed,
      lastEntryPrice: position.lastEntryPrice,
    },
    realized: exit.proceeds - (position.cost - cost),
  };
}

/**
 * Quote value of the position at a given price, for reporting. Not used by any
 * threshold: every threshold keys off average entry, per section 6.3.
 */
export function positionValue(position: DcaPosition, price: Money): Money {
  return divideRounded(position.quantity * price, ONE, "half-even");
}

// ---------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------

/**
 * The whole of section 6.3's running behaviour, as one pure function.
 *
 * ORDER OF CHECKS, which is the part that matters:
 *
 *  1. Stop-loss, before anything else. A risk exit must not be able to lose a
 *     race to a routine buy at the same price update.
 *  2. Take-profit. Mandatory for DCA; it defines the cycle's exit.
 *  3. Additional buy, only if no order is outstanding.
 *
 * Exhausting `maxAdditionalBuys` does NOT halt. Section 6.3 step 5 names
 * "maximum buys are exhausted and price continues falling" as a halt condition
 * but gives no threshold for "continues falling", and the mandatory stop-loss
 * is already exactly that threshold, measured from average entry. Treating
 * exhaustion as its own trigger would mean two downside thresholds where the
 * spec funds only one, and the second would have to be invented. So the bot
 * stops buying, keeps watching, and halts when the stop-loss is breached.
 */
export function decide(input: DcaDecisionInput): DcaAction {
  const { config, position, price } = input;
  const { params } = config;

  if (price <= ZERO) {
    throw new DcaError("invalid_parameter", `price must be positive, got ${price}`);
  }

  // No position yet: this is a fresh cycle waiting on its base order.
  if (position.quantity <= ZERO) {
    return input.hasOpenOrder
      ? { kind: "hold" }
      : { kind: "open_base", quoteAmount: params.baseOrderSize };
  }

  const stopLoss = stopLossPrice(params, position.averageEntryPrice);
  if (price <= stopLoss) {
    return {
      kind: "halt",
      reason: "stop_loss",
      detail:
        `price ${price} is at or below the stop-loss ${stopLoss}, which is ` +
        `${params.stopLossPct} percent below the average entry ` +
        `${position.averageEntryPrice} across ${position.entries.length} entries`,
    };
  }

  const target = takeProfitPrice(params, position.averageEntryPrice);
  if (price >= target) {
    return { kind: "take_profit", targetPrice: target, quantity: position.quantity };
  }

  if (position.additionalBuysUsed >= params.maxAdditionalBuys || input.hasOpenOrder) {
    return { kind: "hold" };
  }

  const trigger = nextBuyTriggerPrice(params, position.lastEntryPrice);
  if (price <= trigger) {
    const index = position.additionalBuysUsed;
    return {
      kind: "additional_buy",
      index,
      quoteAmount: additionalOrderSizeFor(params, index),
      triggerPrice: trigger,
    };
  }

  return { kind: "hold" };
}

/**
 * Base quantity to request for a given quote amount at a given price.
 *
 * Floors, before the symbol's own step-size rounding is applied on top: a
 * quantity rounded up can cost more quote than was allocated for it, and the
 * exchange rejects the whole order rather than trimming it (step 2, decision
 * 3). Symbol filters are applied separately by the caller, because they are
 * exchange facts rather than strategy ones.
 */
export function quantityForQuote(quoteAmount: Money, price: Money): Money {
  if (price <= ZERO) {
    throw new DcaError("invalid_parameter", `price must be positive, got ${price}`);
  }
  return divideRounded(quoteAmount * ONE, price, "floor");
}

/**
 * Migrate stored state written by an older version of this code (section 16).
 *
 * There is exactly one version so far, so this only rejects the unreadable
 * case. It exists now rather than at the first migration because section 16
 * requires the migration step to run "the first time an object wakes up under
 * new code", which means the call site has to already be there when the change
 * lands -- adding it at the same time as the first breaking change is how it
 * gets forgotten for the bots that woke up before the deploy.
 */
export function assertReadableSchema(schemaVersion: number): void {
  if (schemaVersion !== DCA_SCHEMA_VERSION) {
    throw new DcaError(
      "unknown_schema_version",
      `stored state is schemaVersion ${schemaVersion}, and this code reads ` +
        `${DCA_SCHEMA_VERSION}. A bot with an open position must not be operated by ` +
        `code that cannot read its state; migrate it or let the cycle finish under ` +
        `the previous deploy (section 16).`,
    );
  }
}

// ---------------------------------------------------------------------------
// The D1 boundary
// ---------------------------------------------------------------------------

/**
 * `DcaParams` as it is stored in `bot_instances.strategy_params_json`.
 *
 * Every money value is a decimal string, and that is forced rather than
 * stylistic: `JSON.stringify` throws outright on a `bigint`, so a `DcaParams`
 * cannot be written to a JSON column at all. Durable Object storage has no such
 * problem -- it keeps the bigints -- so this encoding exists only at the D1
 * boundary, which is where every other money value in this codebase also
 * changes representation.
 *
 * `toDecimalString` rather than `toStorageString`, matching step 5's
 * `AllocationAuditDetails`: it is readable in a dashboard and exactly parseable
 * back by `fromDecimalString`, so legibility costs no precision.
 *
 * This is the answer to step 4's open question 6 for the strategy half. The
 * column stays typed `unknown` in `schema.ts`, because the shape differs per
 * strategy and grid will define its own at step 9; `decodeDcaParams` is the
 * validating gate between the two.
 */
export interface DcaParamsJson {
  readonly strategy: "dca";
  readonly schemaVersion: number;
  readonly baseOrderSize: string;
  readonly additionalOrderSize: string;
  readonly stepMultiplier: string;
  readonly dropPct: string;
  readonly maxAdditionalBuys: number;
  readonly takeProfitPct: string;
  readonly stopLossPct: string;
  readonly autoRestart: boolean;
  readonly sellOnStopLoss: boolean;
}

export function encodeDcaParams(params: DcaParams): DcaParamsJson {
  return {
    strategy: "dca",
    schemaVersion: DCA_SCHEMA_VERSION,
    baseOrderSize: toDecimalString(params.baseOrderSize),
    additionalOrderSize: toDecimalString(params.additionalOrderSize),
    stepMultiplier: toDecimalString(params.stepMultiplier),
    dropPct: toDecimalString(params.dropPct),
    maxAdditionalBuys: params.maxAdditionalBuys,
    takeProfitPct: toDecimalString(params.takeProfitPct),
    stopLossPct: toDecimalString(params.stopLossPct),
    autoRestart: params.autoRestart,
    sellOnStopLoss: params.sellOnStopLoss,
  };
}

/**
 * Read params back from D1.
 *
 * Validates rather than casts. The column is `unknown` by design, so anything
 * that ever wrote a row is a possible input here -- including a future grid
 * bot's params, or a row written by an older schema version.
 */
export function decodeDcaParams(raw: unknown): DcaParams {
  if (typeof raw !== "object" || raw === null) {
    throw new DcaError("invalid_parameter", `strategy params are ${typeof raw}, not an object`);
  }
  const json = raw as Partial<DcaParamsJson>;
  if (json.strategy !== "dca") {
    throw new DcaError(
      "invalid_parameter",
      `strategy params are for ${JSON.stringify(json.strategy)}, not dca`,
    );
  }
  assertReadableSchema(json.schemaVersion ?? 0);

  const money = (name: keyof DcaParamsJson): Money => {
    const value = json[name];
    if (typeof value !== "string") {
      throw new DcaError("invalid_parameter", `strategy params field ${name} is ${typeof value}, not a string`);
    }
    return fromDecimalString(value);
  };

  if (typeof json.maxAdditionalBuys !== "number") {
    throw new DcaError("invalid_parameter", `maxAdditionalBuys is ${typeof json.maxAdditionalBuys}, not a number`);
  }
  if (typeof json.autoRestart !== "boolean" || typeof json.sellOnStopLoss !== "boolean") {
    throw new DcaError("invalid_parameter", `autoRestart and sellOnStopLoss must both be booleans`);
  }

  return {
    baseOrderSize: money("baseOrderSize"),
    additionalOrderSize: money("additionalOrderSize"),
    stepMultiplier: money("stepMultiplier"),
    dropPct: money("dropPct"),
    maxAdditionalBuys: json.maxAdditionalBuys,
    takeProfitPct: money("takeProfitPct"),
    stopLossPct: money("stopLossPct"),
    autoRestart: json.autoRestart,
    sellOnStopLoss: json.sellOnStopLoss,
  };
}
