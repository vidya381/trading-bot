/**
 * The grid strategy, as pure logic (spec section 6.2), build step 9.
 *
 * A sibling to `dca.ts`, and the same separation: no storage, no exchange call,
 * no clock, no Durable Object. This module answers "given this configuration,
 * this ladder, and this price (or this fill), what should happen next?" and
 * returns the answer as data. `/src/durable-objects/bot-instance.ts` carries it
 * out -- it mints the clientOrderIds, places the orders, persists the ladder,
 * and mirrors to D1.
 *
 * That split is section 13's requirement, not tidiness: backtesting must run
 * "the same strategy code ... without duplication" against historical candles,
 * which is only possible if the strategy is separable from the machinery that
 * talks to an exchange.
 *
 * FOUR READINGS OF SECTION 6.2, decided before this file was written and
 * recorded in the step 9 decision-log entry:
 *
 *  1. A started grid places BUYS ONLY. Section 6.2 step 2 says "buy orders below
 *     and sell orders above", but step 6's decision 10 denominated capital in
 *     the QUOTE asset, so a fresh bot holds no base and cannot fund a sell.
 *     Every sell is created by the replace-on-fill rule (step 3), funded by the
 *     buy one level below it. Self-funding by construction.
 *
 *  2. Ladder state is the constructed level prices (built once, persisted) plus
 *     one slot per level. Replace-on-fill is then a change of two adjacent
 *     slots, and "at most one live order per level" holds by construction. Each
 *     sell slot carries the cost basis of the buy that funded it, so realized
 *     profit is exact per round trip.
 *
 *  3. "Significantly above the highest grid line" (step 5) defaults to one grid
 *     step above the top line -- the ladder's own spacing, the only scale the
 *     spec supplies -- and is configurable via `breakoutThresholdPct`.
 *
 *  4. The upside breakout cash-out (step 5) defaults to ON, per the spec's
 *     "should be configurable but defaults to on". `breakoutTakeProfit`.
 *
 * ROUNDING DIRECTIONS
 * -------------------
 * Step 2's decision 3 removed every default rounding mode, so each computation
 * names its own:
 *
 *   - level prices round HALF-EVEN: a price grid has no directional interest of
 *     its own, and each level is snapped again to the symbol's tickSize by
 *     `validateOrder` at placement time, so the strategy-level rounding only has
 *     to be deterministic and unbiased;
 *   - the stop-loss price rounds UP (ceil), so the halt triggers a fraction
 *     sooner rather than later, matching `dca.ts`;
 *   - the breakout price rounds UP (ceil), so a marginal move does not cash the
 *     grid out early;
 *   - order quantities round DOWN (floor), so the bot never plans to buy or sell
 *     more base than the quote it committed pays for;
 *   - realized profit rounds HALF-EVEN: an internal accounting figure that
 *     accumulates across many round trips, so it should carry no bias.
 */

import type { Money, Rounding } from "../shared/money";
import {
  divideRounded,
  fromDecimalString,
  mul,
  ONE,
  toDecimalString,
  ZERO,
} from "../shared/money";
import type { OrderSide, Timestamp } from "../shared/exchange-client";

/**
 * Stored-state schema version (spec sections 8.1 and 16).
 *
 * Independent of `DCA_SCHEMA_VERSION`: the two strategies store different state
 * and version separately. Bumped whenever the shape of `GridConfig` or the
 * ladder changes in a way an already-running bot's stored state would not
 * satisfy.
 */
export const GRID_SCHEMA_VERSION = 1;

/** 100, as Money. Percentages are stored as the percentage itself, not a rate. */
const HUNDRED_PERCENT = 100n * ONE;

export type GridErrorCode =
  /** A parameter is zero, negative, or otherwise outside its permitted range. */
  | "invalid_parameter"
  /** The buy ladder cannot be funded from the allocated capital. */
  | "exceeds_allocated_capital"
  /** Bounds and line count that collapse two levels onto one price. */
  | "degenerate_ladder"
  /** Stored state carries a schemaVersion this code does not know how to read. */
  | "unknown_schema_version";

export class GridError extends Error {
  readonly code: GridErrorCode;

  constructor(code: GridErrorCode, message: string) {
    super(message);
    this.name = "GridError";
    this.code = code;
  }
}

/** Arithmetic: equal price gaps. Geometric: equal price ratios. Section 6.2. */
export type GridSpacing = "arithmetic" | "geometric";

/**
 * Section 6.2's parameters.
 *
 * `orderSize` is denominated in the QUOTE asset, like DCA's sizes and for the
 * same reason (step 6's decision 10): `allocatedCapital` and the whole capital
 * ledger are quote-denominated, so a size can be checked against the allocation
 * directly.
 */
export interface GridParams {
  /** Top of the grid. The highest sell rests here. */
  readonly upperBound: Money;
  /** Bottom of the grid. The lowest buy rests here. */
  readonly lowerBound: Money;
  /** Number of grid lines, including both bounds. At least 2. */
  readonly gridLines: number;
  readonly spacing: GridSpacing;
  /** Quote spent per buy line (and recovered, plus profit, per sell). */
  readonly orderSize: Money;
  /**
   * Percentage below the LOWEST grid line at which the bot halts and sells
   * (section 6.2 step 4). Mandatory: section 6.1 makes stop-loss mandatory for
   * every strategy.
   */
  readonly stopLossPct: Money;
  /**
   * Section 6.2 step 5: cash out on a strong break above the highest line.
   *
   * Defaults to `true` per the spec's "should be configurable but defaults to
   * on". The default is applied by whoever constructs the params (the creation
   * path); this model carries it as a required field so a bot's stored config
   * always records which behaviour it was created with, rather than leaving it
   * implicit.
   */
  readonly breakoutTakeProfit: boolean;
  /**
   * How far above the highest line counts as "significantly above" (step 5).
   *
   * `null` means one grid step -- the gap between the top two levels, which is
   * the ladder's own spacing and the only scale section 6.2 supplies. A
   * percentage overrides it with a fixed distance above the highest line.
   */
  readonly breakoutThresholdPct: Money | null;
  /**
   * Section 6.2 step 6: optional take-profit on ACCUMULATED REALIZED PROFIT.
   *
   * `null` disables it (the spec calls take-profit "recommended for grid", not
   * mandatory as it is for DCA). When set, once realized profit across all
   * completed round trips reaches this quote amount, the bot cancels every open
   * order, sells the held position, and halts.
   */
  readonly takeProfitAmount: Money | null;
}

/** Everything a `BotInstance` needs to know about a grid bot, persisted verbatim. */
export interface GridConfig {
  /** Discriminates the config union in the Durable Object. */
  readonly strategy: "grid";
  /** Section 8.1 and 16. See GRID_SCHEMA_VERSION. */
  readonly schemaVersion: number;
  /** Matches BOT_INSTANCE_ID_PATTERN; embedded in every clientOrderId. */
  readonly botInstanceId: string;
  readonly accountLabel: string;
  readonly exchange: string;
  readonly pair: string;
  /** The asset `allocatedCapital` and `orderSize` are denominated in. */
  readonly capitalAsset: string;
  readonly allocatedCapital: Money;
  readonly params: GridParams;
}

/**
 * One level's live order, or the absence of one.
 *
 * A slot is `null` when no order rests at that level. When present, `costBasis`
 * is the price of the buy this sell replaced -- set only on a sell, `null` on a
 * buy -- and is what makes realized profit exact when the sell fills.
 */
export interface GridSlot {
  readonly side: OrderSide;
  readonly clientOrderId: string;
  /** For a sell: the buy price it replaced. For a buy: null. */
  readonly costBasis: Money | null;
  /** Base quantity the order is for. */
  readonly quantity: Money;
}

/**
 * The full ladder state.
 *
 * `levels` is constructed once when the bot starts and persisted, rather than
 * recomputed each pass. This follows DCA storing `averageEntryPrice` even though
 * it is derivable: the prices the bot placed orders against are the prices that
 * were recorded, not ones re-derived later from rounded inputs.
 *
 * `slots` is index-aligned with `levels`. `heldQuantity` is the base currently
 * held (bought and not yet sold), which the stop-loss and breakout sells need.
 * `realizedGross` accumulates profit across round trips, for section 6.2 step 6.
 */
export interface GridLadder {
  readonly levels: readonly Money[];
  readonly slots: readonly (GridSlot | null)[];
  /** Base held: sum of filled buys not yet sold. */
  readonly heldQuantity: Money;
  /** Quote spent acquiring `heldQuantity`, for reporting and average cost. */
  readonly heldCost: Money;
  /** Accumulated realized profit across completed round trips (quote). */
  readonly realizedGross: Money;
  /** Whether the initial buy ladder has been placed (section 6.2 step 2). */
  readonly placed: boolean;
}

export type GridHaltReason =
  /** Section 6.2 step 4: price broke below the lowest line by stopLossPct. */
  | "stop_loss"
  /** Section 6.2 step 5: price broke above the highest line, cashed out. */
  | "breakout_take_profit"
  /** Section 6.2 step 6: accumulated realized profit reached the target. */
  | "take_profit"
  /** Section 7.5: an unexpected exception in strategy or order-placing code. */
  | "unhandled_error"
  /** An order the exchange refused for a reason that will not fix itself. */
  | "order_rejected"
  /** A human halted it from the dashboard, or section 7.3/7.4 did. */
  | "manual";

/** An order the ladder wants placed. The Durable Object mints the clientOrderId. */
export interface GridOrderIntent {
  readonly levelIndex: number;
  readonly side: OrderSide;
  readonly price: Money;
  readonly quantity: Money;
  /** For a sell: the buy price being replaced, carried into the new slot. */
  readonly costBasis: Money | null;
}

/**
 * What the strategy wants done at a price update.
 *
 * A closed set, so the Durable Object's dispatch is exhaustive. Fill-driven
 * replacement is a separate function (`planFill`), because it is triggered by a
 * fill event rather than a price update -- the same split DCA has between
 * `decide` and the object's `onFill`.
 */
export type GridPriceAction =
  /** Nothing to do at this price. */
  | { readonly kind: "hold" }
  /** Section 6.2 step 2: place the initial buy ladder below the current price. */
  | { readonly kind: "place_initial_ladder"; readonly orders: readonly GridOrderIntent[] }
  /** Section 6.2 step 4: halt and sell the held position. */
  | {
      readonly kind: "stop_loss";
      readonly triggerPrice: Money;
      readonly heldQuantity: Money;
      readonly detail: string;
    }
  /** Section 6.2 step 5: cash out on an upside breakout, then halt. */
  | {
      readonly kind: "breakout_take_profit";
      readonly triggerPrice: Money;
      readonly heldQuantity: Money;
      readonly detail: string;
    }
  /** Section 6.2 step 6: accumulated realized profit reached the target; halt. */
  | {
      readonly kind: "take_profit";
      readonly heldQuantity: Money;
      readonly detail: string;
    };

/** What a fill against a ladder order means for the ladder. */
export interface GridFillPlan {
  /** The ladder with the filled slot cleared and held position updated. */
  readonly ladder: GridLadder;
  /**
   * The replacement order to place, or `null` when the fill was at an edge
   * level with nowhere to replace to (top buy, bottom sell). The Durable Object
   * places it, mints its id, and writes the slot on success.
   */
  readonly replacement: GridOrderIntent | null;
  /** Realized profit from this fill: positive on a sell round trip, else zero. */
  readonly realized: Money;
}

/**
 * Overrides for folding a fill whose slot is no longer the ladder's own record.
 *
 * Both fields exist for ONE case: an order that filled after being displaced
 * from its level (see `claimSlot`). Such a fill still has to move the held
 * position and realize its profit -- the execution happened -- but the slot at
 * its level now belongs to a different order, so neither reading nor clearing
 * that slot is correct.
 *
 * The caller supplies the displaced order's OWN side and cost basis (which the
 * Durable Object carries on the order record precisely so this is possible) and
 * says it no longer owns the level. Left unset, `planFill` behaves exactly as
 * it always has: slot read from the ladder, slot cleared on a full fill.
 */
export interface PlanFillOptions {
  /**
   * The filled order's own slot, when the ladder no longer holds it.
   *
   * Supplying this is what keeps realized profit honest on a displaced sell:
   * `costBasis` falls back to ZERO when it is missing, and against a ladder
   * slot belonging to some other order that fallback would report the sell's
   * entire proceeds as profit.
   */
  readonly slot?: GridSlot;
  /**
   * Whether the filled order still owns the slot at its level. Default true.
   *
   * False suppresses the slot-clearing a full fill normally does -- clearing it
   * would evict whichever order legitimately holds the level now, which is the
   * same class of silent loss `claimSlot` exists to prevent.
   */
  readonly ownsSlot?: boolean;
}

/** Everything the price-update planner looks at, gathered so it stays pure. */
export interface GridDecisionInput {
  readonly config: GridConfig;
  readonly ladder: GridLadder;
  /** The latest usable price. Section 5.6 governs what counts as usable. */
  readonly price: Money;
}

// ---------------------------------------------------------------------------
// Ladder construction
// ---------------------------------------------------------------------------

/** `x^n` for a non-negative integer `n`, over bigint. */
function powInt(base: bigint, exponent: number): bigint {
  let result = 1n;
  for (let i = 0; i < exponent; i += 1) result *= base;
  return result;
}

/**
 * The geometric ratio between adjacent levels: `(upper / lower)^(1/(n-1))`, as
 * scale-8 Money, computed with integer arithmetic only.
 *
 * There is no floating point anywhere in this: `Math.pow` on a ratio and then
 * snapping to Money would put a float in the middle of a price calculation,
 * which section 5.2 exists to forbid. Instead the exact target is formed at
 * scale 8 and an integer root is found by binary search, rounded to nearest.
 *
 * With `e = n - 1` and the ratio `r` expressed at scale 8, the requirement
 * `(r / ONE)^e = (upper / lower)` becomes `r^e = (upper/lower) * ONE^(e-1)`,
 * where `(upper/lower)` is itself carried at scale 8. That whole right-hand side
 * is an exact integer, so the largest `r` with `r^e <= target` is a pure
 * integer search, and the nearer of `r` and `r+1` is chosen.
 */
function geometricRatio(lower: Money, upper: Money, gridLines: number): Money {
  const e = gridLines - 1;
  // (upper / lower) at scale 8, exactly enough for the search below.
  const ratioScaled = divideRounded(upper * ONE, lower, "half-even");
  const target = ratioScaled * powInt(ONE, e - 1);

  // Binary search for the largest r with r^e <= target. The ratio is >= 1
  // because upper > lower, and <= ratioScaled (the two-line case, e = 1).
  let low = ONE;
  let high = ratioScaled;
  while (low < high) {
    const mid = (low + high + 1n) / 2n;
    if (powInt(mid, e) <= target) {
      low = mid;
    } else {
      high = mid - 1n;
    }
  }

  // Round to nearest: is `low + 1` closer to the true root than `low`?
  const lowPow = powInt(low, e);
  const highPow = powInt(low + 1n, e);
  return target - lowPow <= highPow - target ? low : low + 1n;
}

/**
 * Construct the ladder's level prices, ascending, length `gridLines`.
 *
 * Both endpoints are pinned to the configured bounds exactly -- `levels[0]` is
 * `lowerBound` and `levels[last]` is `upperBound` -- so no accumulated rounding
 * can move the grid off the bounds a human chose. The interior is filled by the
 * spacing rule.
 *
 * Deterministic: given the same params it always returns the same prices, which
 * is what lets the creation-time capital check and the run-time order placement
 * agree on where the lines are.
 *
 * @throws GridError "degenerate_ladder" if two adjacent levels collapse onto one
 *   price (a grid too fine for its range at scale 8), because a ladder with a
 *   zero-width rung cannot place two distinct orders.
 */
export function buildLevels(params: GridParams): Money[] {
  const { lowerBound: lo, upperBound: hi, gridLines: n, spacing } = params;
  if (!Number.isInteger(n) || n < 2) {
    throw new GridError("invalid_parameter", `gridLines must be an integer >= 2, got ${n}`);
  }
  if (lo <= ZERO) {
    throw new GridError("invalid_parameter", `lowerBound must be positive, got ${lo}`);
  }
  if (hi <= lo) {
    throw new GridError("invalid_parameter", `upperBound ${hi} must be above lowerBound ${lo}`);
  }

  const levels: Money[] = new Array(n);
  levels[0] = lo;
  levels[n - 1] = hi;

  if (spacing === "arithmetic") {
    // Direct per-level formula rather than accumulation, so interior rounding
    // cannot drift: level[i] = lo + (hi - lo) * i / (n - 1). Half-even, since a
    // price grid carries no directional interest of its own.
    const span = hi - lo;
    for (let i = 1; i < n - 1; i += 1) {
      levels[i] = lo + divideRounded(span * BigInt(i), BigInt(n - 1), "half-even");
    }
  } else {
    // Geometric: interior by repeated multiplication by the ratio, floored at
    // each step for reproducibility (the same technique DCA's
    // additionalOrderSizeFor uses). The endpoints stay pinned, so the small
    // undershoot a floored ratio produces is absorbed into the top rung.
    const ratio = geometricRatio(lo, hi, n);
    for (let i = 1; i < n - 1; i += 1) {
      levels[i] = mul(levels[i - 1]!, ratio, "floor");
    }
  }

  for (let i = 1; i < n; i += 1) {
    if (levels[i]! <= levels[i - 1]!) {
      throw new GridError(
        "degenerate_ladder",
        `grid levels collapsed: level ${i} (${levels[i]}) is not above level ${i - 1} ` +
          `(${levels[i - 1]}). The bounds ${lo}..${hi} are too narrow for ${n} lines at scale 8.`,
      );
    }
  }

  return levels;
}

/** The spacing of the top rung: the gap between the two highest levels. */
export function topRungGap(levels: readonly Money[]): Money {
  return levels[levels.length - 1]! - levels[levels.length - 2]!;
}

// ---------------------------------------------------------------------------
// Thresholds
// ---------------------------------------------------------------------------

/** `base x (100 + pct) / 100`, in one rounding step. */
function applyPercent(base: Money, pct: Money, rounding: Rounding): Money {
  return divideRounded(base * (HUNDRED_PERCENT + pct), HUNDRED_PERCENT, rounding);
}

/**
 * Price at or below which the bot halts and sells (section 6.2 step 4).
 *
 * Measured below the LOWEST grid line by `stopLossPct`. Rounds up, so the halt
 * triggers a fraction sooner rather than later -- matching `dca.ts`.
 */
export function stopLossPrice(params: GridParams, levels: readonly Money[]): Money {
  return applyPercent(levels[0]!, -params.stopLossPct, "ceil");
}

/**
 * Price at or above which an upside breakout is declared (section 6.2 step 5).
 *
 * `breakoutThresholdPct` set: that percentage above the highest line. Unset: one
 * grid step above it (the top rung's own gap), which is the ladder's own scale
 * and means "past where the grid could have placed another sell". Rounds up, so
 * a marginal move does not cash out early.
 */
export function breakoutPrice(params: GridParams, levels: readonly Money[]): Money {
  const top = levels[levels.length - 1]!;
  if (params.breakoutThresholdPct !== null) {
    return applyPercent(top, params.breakoutThresholdPct, "ceil");
  }
  return top + topRungGap(levels);
}

// ---------------------------------------------------------------------------
// Quantities
// ---------------------------------------------------------------------------

/**
 * Base quantity to buy for `orderSize` quote at a given level price.
 *
 * Floors, before the symbol's own step-size rounding is applied on top: a
 * quantity rounded up can cost more quote than was allocated for it, and the
 * exchange rejects the whole order rather than trimming it (step 2, decision 3).
 */
export function quantityForLevel(orderSize: Money, price: Money): Money {
  if (price <= ZERO) {
    throw new GridError("invalid_parameter", `level price must be positive, got ${price}`);
  }
  return divideRounded(orderSize * ONE, price, "floor");
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Reject a configuration that cannot work, before any capital is reserved.
 *
 * The capital check parallels DCA's `validateDcaParams`: section 6.1 checks the
 * requested allocation against the account's free balance, but nothing else
 * checks that the bot's own ladder fits inside its own allocation. The grid's
 * peak quote exposure is every buy level live at once -- up to `gridLines - 1`
 * levels, since the topmost line only ever holds a sell -- so the allocation
 * must cover `orderSize x (gridLines - 1)`. Without this, a bot is created
 * happily and then fails at the exchange when the ladder fills out, mid-run,
 * with a position open, which section 7.5 turns into a halt.
 */
export function validateGridParams(params: GridParams, allocatedCapital: Money): void {
  if (params.orderSize <= ZERO) {
    throw new GridError("invalid_parameter", `orderSize must be positive, got ${params.orderSize}`);
  }
  if (params.stopLossPct <= ZERO) {
    throw new GridError("invalid_parameter", `stopLossPct must be positive, got ${params.stopLossPct}`);
  }
  if (params.stopLossPct >= HUNDRED_PERCENT) {
    throw new GridError("invalid_parameter", `stopLossPct must be below 100%, got ${params.stopLossPct}`);
  }
  if (params.breakoutThresholdPct !== null && params.breakoutThresholdPct <= ZERO) {
    throw new GridError(
      "invalid_parameter",
      `breakoutThresholdPct must be positive when set, got ${params.breakoutThresholdPct}`,
    );
  }
  if (params.takeProfitAmount !== null && params.takeProfitAmount <= ZERO) {
    throw new GridError(
      "invalid_parameter",
      `takeProfitAmount must be positive when set, got ${params.takeProfitAmount}`,
    );
  }

  // Throws on bad bounds / line count / a degenerate ladder.
  buildLevels(params);

  const buyLevels = BigInt(params.gridLines - 1);
  const peakExposure = params.orderSize * buyLevels;
  if (peakExposure > allocatedCapital) {
    throw new GridError(
      "exceeds_allocated_capital",
      `this ladder commits up to ${peakExposure} at scale 8 with every buy line live ` +
        `(${params.orderSize} x ${params.gridLines - 1} buy levels), which is more than the ` +
        `${allocatedCapital} allocated to it. The bot would fail to fund a buy mid-run with a ` +
        `position open.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Ladder state helpers
// ---------------------------------------------------------------------------

/** A fresh ladder for a newly created bot: levels built, nothing placed. */
export function emptyLadder(params: GridParams): GridLadder {
  const levels = buildLevels(params);
  return {
    levels,
    slots: levels.map(() => null),
    heldQuantity: ZERO,
    heldCost: ZERO,
    realizedGross: ZERO,
    placed: false,
  };
}

/**
 * Replace one slot, returning a new ladder. `slot` may be `null` to clear it.
 *
 * UNCONDITIONAL, and that is why `claimSlot` below exists. Use this only where
 * the caller has already established that overwriting whatever is at the level
 * is correct -- clearing a filled rung, or a halt sweep clearing everything.
 * For PLACING an order at a level, go through `claimSlot`.
 */
export function withSlot(ladder: GridLadder, levelIndex: number, slot: GridSlot | null): GridLadder {
  if (levelIndex < 0 || levelIndex >= ladder.slots.length) {
    throw new GridError("invalid_parameter", `level index ${levelIndex} is out of range`);
  }
  const slots = ladder.slots.slice();
  slots[levelIndex] = slot;
  return { ...ladder, slots };
}

/**
 * The result of trying to put an order's slot at a level.
 *
 * `occupied` carries the slot that is in the way, so the caller can name it in
 * the alert rather than reporting an anonymous collision.
 */
export type SlotClaim =
  | { readonly kind: "claimed"; readonly ladder: GridLadder }
  | { readonly kind: "occupied"; readonly by: GridSlot };

/**
 * Take a level for an order, but ONLY if the level is free.
 *
 * WHY THIS EXISTS. `withSlot` writes unconditionally, and on 2026-08-05 that
 * silently lost two replacement sells on bot-4xcq8p. Four ladder buys filled in
 * the same instant; the poll folds them one at a time, and folding the fill at
 * level 0 placed its replacement sell into level 1 -- the level still holding
 * the buy that the very next iteration was about to fold. That buy's slot was
 * gone by the time its own fill was read, `levelOf` returned -1, and the fill
 * took the "not on the ladder any more" branch: recorded, but with no
 * replacement placed and no alert raised. 0.00037572 BTC ended up held with no
 * sell resting against it, on a bot that went on reporting itself healthy.
 *
 * A slot may be claimed when the level is EMPTY, or when it already holds this
 * same order (a retry re-writing its own slot must stay idempotent). Anything
 * else is a collision, and the caller decides what to do about it -- queue the
 * order, or alert. What it must not do is overwrite, because the slot that
 * would be lost is the ladder's only record that its order is live: for a grid,
 * `openOrderIds` is DERIVED from the slots, so an evicted order stops being
 * polled and stops being cancellable. A resting order evicted this way leaks
 * onto the exchange entirely unmanaged, which is strictly worse than the filled
 * case that exposed the bug.
 */
export function claimSlot(ladder: GridLadder, levelIndex: number, slot: GridSlot): SlotClaim {
  if (levelIndex < 0 || levelIndex >= ladder.slots.length) {
    throw new GridError("invalid_parameter", `level index ${levelIndex} is out of range`);
  }
  const occupant = ladder.slots[levelIndex] ?? null;
  if (occupant !== null && occupant.clientOrderId !== slot.clientOrderId) {
    return { kind: "occupied", by: occupant };
  }
  return { kind: "claimed", ladder: withSlot(ladder, levelIndex, slot) };
}

/** The level index whose slot holds this order, or -1 if none does. */
export function levelOf(ladder: GridLadder, clientOrderId: string): number {
  return ladder.slots.findIndex((slot) => slot?.clientOrderId === clientOrderId);
}

/** clientOrderIds of every live order on the ladder, in level order. */
export function openOrderIds(ladder: GridLadder): string[] {
  const ids: string[] = [];
  for (const slot of ladder.slots) {
    if (slot !== null) ids.push(slot.clientOrderId);
  }
  return ids;
}

// ---------------------------------------------------------------------------
// The initial ladder (section 6.2 step 2)
// ---------------------------------------------------------------------------

/**
 * The buy orders to place when the grid starts: one at every level strictly
 * below the current price.
 *
 * Buys only, per decision 1 -- a quote-funded bot has no base to sell yet, and
 * the sell side of the ladder is built by replace-on-fill as buys fill. A level
 * at or above the current price gets nothing now; a sell will land there once
 * the buy below it fills.
 */
export function initialLadderOrders(ladder: GridLadder, params: GridParams, price: Money): GridOrderIntent[] {
  const orders: GridOrderIntent[] = [];
  for (let i = 0; i < ladder.levels.length; i += 1) {
    const levelPrice = ladder.levels[i]!;
    if (levelPrice >= price) break; // levels ascend; nothing at or above spot
    orders.push({
      levelIndex: i,
      side: "buy",
      price: levelPrice,
      quantity: quantityForLevel(params.orderSize, levelPrice),
      costBasis: null,
    });
  }
  return orders;
}

// ---------------------------------------------------------------------------
// The price-update decision
// ---------------------------------------------------------------------------

/**
 * The whole of section 6.2's price-driven behaviour, as one pure function.
 *
 * ORDER OF CHECKS, which is the part that matters -- risk exits ahead of routine
 * work, exactly as DCA orders its own:
 *
 *  1. Initial placement, if the ladder has not been placed yet. There is no risk
 *     exit to lose a race to before any order exists.
 *  2. Stop-loss, before every other running check. A downside break must not
 *     lose a race to anything.
 *  3. Upside breakout (only if `breakoutTakeProfit`), so the bot cashes out
 *     rather than sitting idle above its own ladder.
 *  4. Take-profit on accumulated realized profit, if configured.
 *  5. Otherwise hold. Everything else -- the replace-on-fill that builds and
 *     rebuilds the ladder -- is driven by fills, not by price, and lives in
 *     `planFill`.
 */
export function decide(input: GridDecisionInput): GridPriceAction {
  const { config, ladder, price } = input;
  const { params } = config;

  if (price <= ZERO) {
    throw new GridError("invalid_parameter", `price must be positive, got ${price}`);
  }

  if (!ladder.placed) {
    return {
      kind: "place_initial_ladder",
      orders: initialLadderOrders(ladder, params, price),
    };
  }

  const stopLoss = stopLossPrice(params, ladder.levels);
  if (price <= stopLoss) {
    return {
      kind: "stop_loss",
      triggerPrice: stopLoss,
      heldQuantity: ladder.heldQuantity,
      detail:
        `price ${price} is at or below the stop-loss ${stopLoss}, which is ${params.stopLossPct} ` +
        `percent below the lowest grid line ${ladder.levels[0]}`,
    };
  }

  if (params.breakoutTakeProfit) {
    const breakout = breakoutPrice(params, ladder.levels);
    if (price >= breakout) {
      return {
        kind: "breakout_take_profit",
        triggerPrice: breakout,
        heldQuantity: ladder.heldQuantity,
        detail:
          `price ${price} is at or above the breakout ${breakout}, above the highest grid line ` +
          `${ladder.levels[ladder.levels.length - 1]}; cashing out (section 6.2 step 5)`,
      };
    }
  }

  if (params.takeProfitAmount !== null && ladder.realizedGross >= params.takeProfitAmount) {
    return {
      kind: "take_profit",
      heldQuantity: ladder.heldQuantity,
      detail:
        `accumulated realized profit ${ladder.realizedGross} reached the target ` +
        `${params.takeProfitAmount} (section 6.2 step 6)`,
    };
  }

  return { kind: "hold" };
}

// ---------------------------------------------------------------------------
// Replace-on-fill (section 6.2 step 3)
// ---------------------------------------------------------------------------

/**
 * Fold a fill against a ladder order into the ladder, and say what to place next.
 *
 * Section 6.2 step 3: a filled buy places a new sell one grid level ABOVE; a
 * filled sell places a new buy one grid level BELOW. This computes both the
 * updated ladder (filled slot cleared, held position moved) and the replacement
 * order to place. The Durable Object mints the replacement's clientOrderId,
 * places it, and writes the slot on success -- so this function never invents an
 * id, and a placement that then fails simply leaves the level empty, which the
 * next price update or reconciliation handles.
 *
 * The fill quantity is what was ACTUALLY executed, which may be a partial fill.
 * Replacement is planned only on a level's order fully clearing; a partial fill
 * moves the held position and leaves the slot in place. Whether a fill fully
 * fills the level is the Durable Object's determination (it tracks the order
 * against `TrackedOrder`), passed in as `fullyFilled`.
 *
 * Realized profit is recognised only on a sell that completes a round trip:
 * `(fillPrice - costBasis) x fillQuantity`, half-even. A buy fill realizes
 * nothing -- it is an acquisition.
 *
 * @param levelIndex the level whose order filled (from `levelOf`).
 * @param fullyFilled whether this fill closed the order at that level.
 */
export function planFill(
  ladder: GridLadder,
  params: GridParams,
  levelIndex: number,
  fillPrice: Money,
  fillQuantity: Money,
  fullyFilled: boolean,
  options: PlanFillOptions = {},
): GridFillPlan {
  const slot = options.slot ?? ladder.slots[levelIndex];
  const ownsSlot = options.ownsSlot ?? true;
  if (slot === undefined || slot === null) {
    throw new GridError("invalid_parameter", `no live order at level ${levelIndex} to fill`);
  }
  if (levelIndex < 0 || levelIndex >= ladder.levels.length) {
    throw new GridError("invalid_parameter", `level index ${levelIndex} is out of range`);
  }
  if (fillQuantity <= ZERO) {
    throw new GridError("invalid_parameter", `fill quantity must be positive, got ${fillQuantity}`);
  }

  if (slot.side === "buy") {
    // Acquisition: held base and its cost both grow. Cost is what was executed
    // (fillPrice x fillQuantity), not what was requested.
    const cost = mul(fillPrice, fillQuantity, "half-even");
    let next: GridLadder = {
      ...ladder,
      heldQuantity: ladder.heldQuantity + fillQuantity,
      heldCost: ladder.heldCost + cost,
    };

    if (!fullyFilled) {
      // A partial buy: position moved, order still resting, no replacement yet.
      return { ladder: next, replacement: null, realized: ZERO };
    }

    // Only clear a level this order still owns. A displaced order's level now
    // belongs to someone else, and clearing it would repeat the eviction.
    if (ownsSlot) next = withSlot(next, levelIndex, null);
    const sellIndex = levelIndex + 1;
    if (sellIndex >= ladder.levels.length) {
      // The top level filled: there is no rung above to sell into. The breakout
      // logic owns what happens past the top; nothing is placed here.
      return { ladder: next, replacement: null, realized: ZERO };
    }

    return {
      ladder: next,
      replacement: {
        levelIndex: sellIndex,
        side: "sell",
        price: ladder.levels[sellIndex]!,
        // Sell exactly the base this buy acquired, carrying the buy's price as
        // the cost basis so the eventual sell's profit is exact.
        quantity: fillQuantity,
        costBasis: fillPrice,
      },
      realized: ZERO,
    };
  }

  // A sell filled: a round trip closed. Realize (fillPrice - costBasis) x qty.
  const costBasis = slot.costBasis ?? ZERO;
  const realized = mul(fillPrice - costBasis, fillQuantity, "half-even");
  // Release the base sold, and the proportional cost it was carried at.
  const releasedCost = mul(costBasis, fillQuantity, "half-even");
  let next: GridLadder = {
    ...ladder,
    heldQuantity: ladder.heldQuantity - fillQuantity,
    heldCost: ladder.heldCost - releasedCost,
    realizedGross: ladder.realizedGross + realized,
  };

  if (!fullyFilled) {
    return { ladder: next, replacement: null, realized };
  }

  if (ownsSlot) next = withSlot(next, levelIndex, null);
  const buyIndex = levelIndex - 1;
  if (buyIndex < 0) {
    // The bottom level's sell filled: no rung below to buy back into.
    return { ladder: next, replacement: null, realized };
  }

  const buyPrice = ladder.levels[buyIndex]!;
  return {
    ladder: next,
    replacement: {
      levelIndex: buyIndex,
      side: "buy",
      price: buyPrice,
      quantity: quantityForLevel(params.orderSize, buyPrice),
      costBasis: null,
    },
    realized,
  };
}

// ---------------------------------------------------------------------------
// Migration
// ---------------------------------------------------------------------------

/**
 * Reject stored state written by a schema version this code cannot read
 * (section 16). One version so far, so this only guards the unreadable case; it
 * exists now so the call site is already present when the first migration lands.
 */
export function assertReadableSchema(schemaVersion: number): void {
  if (schemaVersion !== GRID_SCHEMA_VERSION) {
    throw new GridError(
      "unknown_schema_version",
      `stored state is schemaVersion ${schemaVersion}, and this code reads ${GRID_SCHEMA_VERSION}. ` +
        `A bot with an open ladder must not be operated by code that cannot read its state; ` +
        `migrate it or let it be closed under the previous deploy (section 16).`,
    );
  }
}

// ---------------------------------------------------------------------------
// The D1 boundary
// ---------------------------------------------------------------------------

/**
 * `GridParams` as stored in `bot_instances.strategy_params_json`.
 *
 * Every money value is a decimal string, forced rather than stylistic:
 * `JSON.stringify` throws on a `bigint`, so `GridParams` cannot be written to a
 * JSON column at all. This mirrors step 6's `DcaParamsJson` exactly -- the same
 * discriminator gate, the same `toDecimalString` encoding, the same validating
 * decode. The column stays typed `unknown` in `schema.ts`; `decodeGridParams`
 * is the gate for the grid half, `decodeDcaParams` for the DCA half.
 */
export interface GridParamsJson {
  readonly strategy: "grid";
  readonly schemaVersion: number;
  readonly upperBound: string;
  readonly lowerBound: string;
  readonly gridLines: number;
  readonly spacing: GridSpacing;
  readonly orderSize: string;
  readonly stopLossPct: string;
  readonly breakoutTakeProfit: boolean;
  /** null encodes "one grid step"; a decimal string overrides it. */
  readonly breakoutThresholdPct: string | null;
  /** null encodes "no take-profit target". */
  readonly takeProfitAmount: string | null;
}

export function encodeGridParams(params: GridParams): GridParamsJson {
  return {
    strategy: "grid",
    schemaVersion: GRID_SCHEMA_VERSION,
    upperBound: toDecimalString(params.upperBound),
    lowerBound: toDecimalString(params.lowerBound),
    gridLines: params.gridLines,
    spacing: params.spacing,
    orderSize: toDecimalString(params.orderSize),
    stopLossPct: toDecimalString(params.stopLossPct),
    breakoutTakeProfit: params.breakoutTakeProfit,
    breakoutThresholdPct:
      params.breakoutThresholdPct === null ? null : toDecimalString(params.breakoutThresholdPct),
    takeProfitAmount:
      params.takeProfitAmount === null ? null : toDecimalString(params.takeProfitAmount),
  };
}

/**
 * Read grid params back from D1.
 *
 * Validates rather than casts. The column is `unknown` by design, so anything
 * that ever wrote a row is a possible input -- including a DCA bot's params, or
 * a row written by an older schema version. The `strategy: "grid"` discriminator
 * is checked first, exactly as `decodeDcaParams` checks for `"dca"`.
 */
export function decodeGridParams(raw: unknown): GridParams {
  if (typeof raw !== "object" || raw === null) {
    throw new GridError("invalid_parameter", `strategy params are ${typeof raw}, not an object`);
  }
  const json = raw as Partial<GridParamsJson>;
  if (json.strategy !== "grid") {
    throw new GridError(
      "invalid_parameter",
      `strategy params are for ${JSON.stringify(json.strategy)}, not grid`,
    );
  }
  assertReadableSchema(json.schemaVersion ?? 0);

  const money = (name: keyof GridParamsJson): Money => {
    const value = json[name];
    if (typeof value !== "string") {
      throw new GridError("invalid_parameter", `strategy params field ${name} is ${typeof value}, not a string`);
    }
    return fromDecimalString(value);
  };
  const optionalMoney = (name: keyof GridParamsJson): Money | null => {
    const value = json[name];
    if (value === null) return null;
    if (typeof value !== "string") {
      throw new GridError(
        "invalid_parameter",
        `strategy params field ${name} is ${typeof value}, not a string or null`,
      );
    }
    return fromDecimalString(value);
  };

  if (typeof json.gridLines !== "number") {
    throw new GridError("invalid_parameter", `gridLines is ${typeof json.gridLines}, not a number`);
  }
  if (json.spacing !== "arithmetic" && json.spacing !== "geometric") {
    throw new GridError("invalid_parameter", `spacing is ${JSON.stringify(json.spacing)}, not a grid spacing`);
  }
  if (typeof json.breakoutTakeProfit !== "boolean") {
    throw new GridError("invalid_parameter", `breakoutTakeProfit is ${typeof json.breakoutTakeProfit}, not a boolean`);
  }

  return {
    upperBound: money("upperBound"),
    lowerBound: money("lowerBound"),
    gridLines: json.gridLines,
    spacing: json.spacing,
    orderSize: money("orderSize"),
    stopLossPct: money("stopLossPct"),
    breakoutTakeProfit: json.breakoutTakeProfit,
    breakoutThresholdPct: optionalMoney("breakoutThresholdPct"),
    takeProfitAmount: optionalMoney("takeProfitAmount"),
  };
}
