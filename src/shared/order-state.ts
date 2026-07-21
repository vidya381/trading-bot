/**
 * Order and fill state machine (spec section 5.3).
 *
 * Pure logic over plain data. There is no storage, no exchange call, and no
 * strategy decision here: a Durable Object supplies the stored order at step 6
 * and persists whatever this module returns.
 *
 * Every function is total and non-mutating -- applying a fill returns a new
 * order rather than editing one in place, so a caller cannot half-apply a
 * change and then fail.
 */

import type { Asset, Fill, OrderSide, Pair, Timestamp } from "./exchange-client";
import { mul, ZERO, type Money } from "./money";

/**
 * Order lifecycle states.
 *
 * `pending`, `partially_filled`, `filled` and `cancelled` come from section
 * 5.3. `rejected` and `expired` are added because `getOrderStatus` and the
 * section 9 reconciliation job can both observe them from the exchange;
 * modelling them means they are handled explicitly rather than falling through
 * as an unmapped value.
 */
export type OrderState =
  | "pending"
  | "partially_filled"
  | "filled"
  | "cancelled"
  | "rejected"
  | "expired";

/** States from which no further transition is possible. */
export const TERMINAL_STATES = [
  "filled",
  "cancelled",
  "rejected",
  "expired",
] as const satisfies readonly OrderState[];

/**
 * Permitted transitions.
 *
 * `partially_filled -> cancelled` is included deliberately. Section 5.3 lists
 * only `pending -> cancelled`, but section 6.2 step 4 and the section 7.2 halt
 * behaviour both cancel all open orders, and some of those will be partially
 * filled at that moment. The cancelled order keeps its filled quantity, so the
 * position stays correct.
 */
export const ALLOWED_TRANSITIONS: Readonly<Record<OrderState, readonly OrderState[]>> = {
  pending: ["partially_filled", "filled", "cancelled", "rejected", "expired"],
  partially_filled: ["partially_filled", "filled", "cancelled", "expired"],
  filled: [],
  cancelled: [],
  rejected: [],
  expired: [],
};

export type OrderStateErrorCode =
  /** The requested state change is not in the transition table. */
  | "invalid_transition"
  /** A fill with an id already applied to this order. Expected on queue redelivery. */
  | "duplicate_fill"
  /** Fills would exceed the order's original quantity. */
  | "overfill"
  /** A fill arrived for an order already in a terminal state. */
  | "fill_after_terminal"
  /** A quantity or price that is zero or negative where it must be positive. */
  | "invalid_quantity";

/**
 * A typed, catchable error rather than a bare throw.
 *
 * Several of these describe races that genuinely happen in production -- a
 * fill crossing a cancellation, or a redelivered queue message. Step 6 should
 * catch them and route to reconciliation (section 9) rather than treating them
 * as the unhandled exceptions that section 7.5 turns into an immediate halt.
 */
export class OrderStateError extends Error {
  readonly code: OrderStateErrorCode;

  constructor(code: OrderStateErrorCode, message: string) {
    super(message);
    this.name = "OrderStateError";
    this.code = code;
  }
}

/** An order as this system tracks it, independent of any exchange payload. */
export interface TrackedOrder {
  clientOrderId: string;
  pair: Pair;
  side: OrderSide;
  price: Money;
  /** Quantity originally requested; never changes. */
  quantity: Money;
  /** Sum of applied fill quantities. */
  filledQuantity: Money;
  state: OrderState;
  /** Fills applied so far, in application order. */
  fills: readonly Fill[];
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

/**
 * The accounting effect of a fill, for the caller to apply to its position.
 *
 * Section 5.3 requires position size to be updated incrementally on each
 * partial fill, so these are per-fill deltas, not running totals.
 */
export interface FillEffect {
  order: TrackedOrder;
  /** Change in base-asset position: positive on a buy, negative on a sell. */
  baseDelta: Money;
  /** Change in quote-asset holding: negative on a buy, positive on a sell. */
  quoteDelta: Money;
  /**
   * The fee exactly as the exchange reported it, in its own asset. Converting
   * it to the reporting currency is the fee module's job (section 5.5); it is
   * deliberately not folded into the deltas above.
   */
  feeAmount: Money;
  feeAsset: Asset;
  /** True once filled quantity equals the original quantity. */
  fullyFilled: boolean;
}

/**
 * Rounding for the quote-side notional (price x quantity), which is not always
 * exact at scale 8. Half-even is used because it has no directional bias, so
 * error does not accumulate in one direction across many fills.
 */
const NOTIONAL_ROUNDING = "half-even" as const;

export function isTerminal(state: OrderState): boolean {
  return (TERMINAL_STATES as readonly OrderState[]).includes(state);
}

export function canTransition(from: OrderState, to: OrderState): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

/** @throws OrderStateError with code "invalid_transition". */
export function assertTransition(from: OrderState, to: OrderState): void {
  if (!canTransition(from, to)) {
    throw new OrderStateError(
      "invalid_transition",
      `cannot move an order from "${from}" to "${to}"`,
    );
  }
}

/** Quantity still outstanding on the order. */
export function remainingQuantity(order: TrackedOrder): Money {
  return order.quantity - order.filledQuantity;
}

/**
 * Whether the order is fully resolved in the sense section 5.3 means: filled
 * quantity equals original quantity. A cancelled order with a partial fill is
 * terminal but not fully filled, which is why these are separate questions.
 */
export function isFullyFilled(order: TrackedOrder): boolean {
  return order.filledQuantity === order.quantity;
}

/** Create a new order in the `pending` state with nothing filled. */
export function createOrder(params: {
  clientOrderId: string;
  pair: Pair;
  side: OrderSide;
  price: Money;
  quantity: Money;
  at: Timestamp;
}): TrackedOrder {
  if (params.quantity <= ZERO) {
    throw new OrderStateError(
      "invalid_quantity",
      `order quantity must be positive, got ${params.quantity}`,
    );
  }
  if (params.price <= ZERO) {
    throw new OrderStateError(
      "invalid_quantity",
      `order price must be positive, got ${params.price}`,
    );
  }

  return {
    clientOrderId: params.clientOrderId,
    pair: params.pair,
    side: params.side,
    price: params.price,
    quantity: params.quantity,
    filledQuantity: ZERO,
    state: "pending",
    fills: [],
    createdAt: params.at,
    updatedAt: params.at,
  };
}

/**
 * Apply one fill, returning the updated order and the position deltas.
 *
 * Rejects, with a distinct error code for each:
 *  - a fill on a terminal order (a cancel and an execution crossing);
 *  - a repeated fill id (a redelivered queue message, section 5.1);
 *  - fills that would exceed the original quantity.
 *
 * Each of these is a real condition to be classified, not a programmer error,
 * which is why they carry codes a caller can branch on.
 */
export function applyFill(order: TrackedOrder, fill: Fill): FillEffect {
  if (isTerminal(order.state)) {
    throw new OrderStateError(
      "fill_after_terminal",
      `fill ${fill.fillId} arrived for order ${order.clientOrderId} ` +
        `already in terminal state "${order.state}"`,
    );
  }

  if (fill.quantity <= ZERO) {
    throw new OrderStateError(
      "invalid_quantity",
      `fill quantity must be positive, got ${fill.quantity}`,
    );
  }

  if (order.fills.some((existing) => existing.fillId === fill.fillId)) {
    throw new OrderStateError(
      "duplicate_fill",
      `fill ${fill.fillId} has already been applied to order ${order.clientOrderId}`,
    );
  }

  const filledQuantity = order.filledQuantity + fill.quantity;
  if (filledQuantity > order.quantity) {
    throw new OrderStateError(
      "overfill",
      `fill ${fill.fillId} would take order ${order.clientOrderId} to ` +
        `${filledQuantity}, beyond its quantity of ${order.quantity}`,
    );
  }

  const fullyFilled = filledQuantity === order.quantity;
  const nextState: OrderState = fullyFilled ? "filled" : "partially_filled";
  assertTransition(order.state, nextState);

  const notional = mul(fill.price, fill.quantity, NOTIONAL_ROUNDING);
  const isBuy = order.side === "buy";

  return {
    order: {
      ...order,
      filledQuantity,
      state: nextState,
      fills: [...order.fills, fill],
      updatedAt: fill.executedAt,
    },
    baseDelta: isBuy ? fill.quantity : -fill.quantity,
    quoteDelta: isBuy ? -notional : notional,
    feeAmount: fill.feeAmount,
    feeAsset: fill.feeAsset,
    fullyFilled,
  };
}

/**
 * Move an order to a terminal state that is not the result of a fill.
 *
 * Cancelling a partially filled order is permitted and retains its filled
 * quantity, which the section 7.2 halt path depends on.
 */
export function closeOrder(
  order: TrackedOrder,
  state: "cancelled" | "rejected" | "expired",
  at: Timestamp,
): TrackedOrder {
  assertTransition(order.state, state);
  return { ...order, state, updatedAt: at };
}

/**
 * Reconcile a locally tracked order against what the exchange reports
 * (section 9). Returns the mismatches rather than deciding what to do about
 * them: classifying drift as minor, meaningful, or severe is the
 * reconciliation job's call, not this module's.
 */
export function compareWithExchange(
  local: TrackedOrder,
  remote: { state: OrderState; filledQuantity: Money },
): { matches: boolean; stateDiffers: boolean; filledQuantityDelta: Money } {
  const stateDiffers = local.state !== remote.state;
  const filledQuantityDelta = remote.filledQuantity - local.filledQuantity;
  return {
    matches: !stateDiffers && filledQuantityDelta === ZERO,
    stateDiffers,
    filledQuantityDelta,
  };
}
