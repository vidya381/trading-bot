import { describe, expect, it } from "vitest";
import type { Fill } from "./exchange-client";
import { fromDecimalString as m } from "./money";
import {
  ALLOWED_TRANSITIONS,
  applyFill,
  assertTransition,
  canTransition,
  closeOrder,
  compareWithExchange,
  createOrder,
  isFullyFilled,
  isTerminal,
  OrderStateError,
  remainingQuantity,
  TERMINAL_STATES,
  type OrderState,
  type TrackedOrder,
} from "./order-state";

const AT = 1_700_000_000_000;

function order(overrides: Partial<Parameters<typeof createOrder>[0]> = {}): TrackedOrder {
  return createOrder({
    clientOrderId: "v1-bot1-1",
    pair: "BTCUSDT",
    side: "buy",
    price: m("43120.50"),
    quantity: m("1"),
    at: AT,
    ...overrides,
  });
}

function fill(overrides: Partial<Fill> = {}): Fill {
  return {
    fillId: "f1",
    price: m("43120.50"),
    quantity: m("0.25"),
    feeAmount: m("0.001"),
    feeAsset: "BNB",
    executedAt: AT + 1000,
    ...overrides,
  };
}

describe("transition table", () => {
  it("starts an order pending with nothing filled", () => {
    const o = order();
    expect(o.state).toBe("pending");
    expect(o.filledQuantity).toBe(0n);
    expect(o.fills).toEqual([]);
    expect(remainingQuantity(o)).toBe(m("1"));
  });

  it("treats filled, cancelled, rejected and expired as terminal", () => {
    for (const state of TERMINAL_STATES) {
      expect(isTerminal(state)).toBe(true);
      expect(ALLOWED_TRANSITIONS[state]).toEqual([]);
    }
    expect(isTerminal("pending")).toBe(false);
    expect(isTerminal("partially_filled")).toBe(false);
  });

  it("permits the section 5.3 paths", () => {
    expect(canTransition("pending", "partially_filled")).toBe(true);
    expect(canTransition("partially_filled", "filled")).toBe(true);
    expect(canTransition("pending", "cancelled")).toBe(true);
    expect(canTransition("pending", "filled")).toBe(true);
  });

  it("permits cancelling a partially filled order", () => {
    // Required by the halt behaviour in section 7.2, which cancels all open
    // orders regardless of how much of each has already executed.
    expect(canTransition("partially_filled", "cancelled")).toBe(true);
  });

  it("forbids leaving a terminal state", () => {
    expect(canTransition("filled", "cancelled")).toBe(false);
    expect(canTransition("cancelled", "pending")).toBe(false);
    expect(canTransition("rejected", "filled")).toBe(false);
    expect(canTransition("expired", "partially_filled")).toBe(false);
  });

  it("forbids rejecting an order that has already partially filled", () => {
    expect(canTransition("partially_filled", "rejected")).toBe(false);
  });

  it("throws a coded error on an invalid transition", () => {
    try {
      assertTransition("filled", "pending");
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(OrderStateError);
      expect((error as OrderStateError).code).toBe("invalid_transition");
    }
  });
});

describe("createOrder validation", () => {
  it("rejects a non-positive quantity", () => {
    expect(() => order({ quantity: 0n })).toThrow(OrderStateError);
    expect(() => order({ quantity: m("-1") })).toThrow(/quantity must be positive/);
  });

  it("rejects a non-positive price", () => {
    expect(() => order({ price: 0n })).toThrow(/price must be positive/);
  });
});

describe("applyFill", () => {
  it("moves pending to partially_filled and reports the deltas", () => {
    const effect = applyFill(order(), fill({ quantity: m("0.25") }));

    expect(effect.order.state).toBe("partially_filled");
    expect(effect.order.filledQuantity).toBe(m("0.25"));
    expect(effect.fullyFilled).toBe(false);
    // 43120.50 * 0.25 = 10780.125
    expect(effect.baseDelta).toBe(m("0.25"));
    expect(effect.quoteDelta).toBe(m("-10780.125"));
  });

  it("moves straight to filled when one fill completes the order", () => {
    const effect = applyFill(order(), fill({ quantity: m("1") }));
    expect(effect.order.state).toBe("filled");
    expect(effect.fullyFilled).toBe(true);
    expect(isFullyFilled(effect.order)).toBe(true);
    expect(remainingQuantity(effect.order)).toBe(0n);
  });

  it("accumulates partial fills incrementally to a filled order", () => {
    let o = order();
    const quantities = ["0.25", "0.25", "0.5"];
    const deltas = [];

    for (const [index, quantity] of quantities.entries()) {
      const effect = applyFill(o, fill({ fillId: `f${index}`, quantity: m(quantity) }));
      o = effect.order;
      deltas.push(effect.baseDelta);
    }

    // Section 5.3: position updates per fill, not once at the end.
    expect(deltas).toEqual([m("0.25"), m("0.25"), m("0.5")]);
    expect(o.state).toBe("filled");
    expect(o.filledQuantity).toBe(m("1"));
    expect(o.fills).toHaveLength(3);
  });

  it("reverses the delta signs for a sell", () => {
    const effect = applyFill(
      order({ side: "sell" }),
      fill({ quantity: m("0.25") }),
    );
    expect(effect.baseDelta).toBe(m("-0.25"));
    expect(effect.quoteDelta).toBe(m("10780.125"));
  });

  it("passes the fee through in its own asset without converting it", () => {
    // Section 5.5: fees must never be assumed to be in the quote currency.
    const effect = applyFill(order(), fill({ feeAsset: "BNB", feeAmount: m("0.001") }));
    expect(effect.feeAsset).toBe("BNB");
    expect(effect.feeAmount).toBe(m("0.001"));
    // The fee is not silently folded into the quote delta.
    expect(effect.quoteDelta).toBe(m("-10780.125"));
  });

  it("does not mutate the order it is given", () => {
    const original = order();
    const snapshot = { ...original, fills: [...original.fills] };
    applyFill(original, fill());
    expect(original).toEqual(snapshot);
    expect(original.filledQuantity).toBe(0n);
  });

  it("rejects a repeated fill id, as a redelivered queue message would send", () => {
    const first = applyFill(order(), fill({ fillId: "dup" }));
    try {
      applyFill(first.order, fill({ fillId: "dup" }));
      expect.unreachable("should have thrown");
    } catch (error) {
      expect((error as OrderStateError).code).toBe("duplicate_fill");
    }
  });

  it("rejects fills that would exceed the original quantity", () => {
    const first = applyFill(order(), fill({ fillId: "a", quantity: m("0.6") }));
    try {
      applyFill(first.order, fill({ fillId: "b", quantity: m("0.5") }));
      expect.unreachable("should have thrown");
    } catch (error) {
      expect((error as OrderStateError).code).toBe("overfill");
    }
  });

  it("rejects a fill arriving after cancellation, the cancel/execute race", () => {
    const cancelled = closeOrder(order(), "cancelled", AT + 500);
    try {
      applyFill(cancelled, fill());
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(OrderStateError);
      expect((error as OrderStateError).code).toBe("fill_after_terminal");
    }
  });

  it("rejects a non-positive fill quantity", () => {
    expect(() => applyFill(order(), fill({ quantity: 0n }))).toThrow(OrderStateError);
  });

  it("rounds an inexact notional without directional bias", () => {
    // A notional whose exact value falls on a half at scale 8, so the choice
    // of rounding mode is observable. Half-even keeps error from accumulating.
    const effect = applyFill(
      order({ price: m("0.00000005"), quantity: m("1") }),
      fill({ price: m("0.00000005"), quantity: m("1") }),
    );
    expect(effect.quoteDelta).toBe(m("-0.00000005"));
  });

  it("advances updatedAt to the fill time and leaves createdAt alone", () => {
    const effect = applyFill(order(), fill({ executedAt: AT + 9999 }));
    expect(effect.order.updatedAt).toBe(AT + 9999);
    expect(effect.order.createdAt).toBe(AT);
  });
});

describe("closeOrder", () => {
  it("cancels a pending order", () => {
    const closed = closeOrder(order(), "cancelled", AT + 100);
    expect(closed.state).toBe("cancelled");
    expect(closed.updatedAt).toBe(AT + 100);
  });

  it("cancels a partially filled order and keeps the filled quantity", () => {
    const partial = applyFill(order(), fill({ quantity: m("0.3") })).order;
    const closed = closeOrder(partial, "cancelled", AT + 100);

    expect(closed.state).toBe("cancelled");
    expect(closed.filledQuantity).toBe(m("0.3"));
    // Terminal, but never fully filled -- section 5.3's distinction.
    expect(isTerminal(closed.state)).toBe(true);
    expect(isFullyFilled(closed)).toBe(false);
    expect(remainingQuantity(closed)).toBe(m("0.7"));
  });

  it("marks an order rejected or expired", () => {
    expect(closeOrder(order(), "rejected", AT).state).toBe("rejected");
    expect(closeOrder(order(), "expired", AT).state).toBe("expired");
  });

  it("refuses to close an already terminal order", () => {
    const filled = applyFill(order(), fill({ quantity: m("1") })).order;
    expect(() => closeOrder(filled, "cancelled", AT)).toThrow(OrderStateError);
  });
});

describe("compareWithExchange", () => {
  it("reports a match when local and remote agree", () => {
    const partial = applyFill(order(), fill({ quantity: m("0.3") })).order;
    const result = compareWithExchange(partial, {
      state: "partially_filled",
      filledQuantity: m("0.3"),
    });
    expect(result).toEqual({
      matches: true,
      stateDiffers: false,
      filledQuantityDelta: 0n,
    });
  });

  it("surfaces a quantity drift without deciding its severity", () => {
    const partial = applyFill(order(), fill({ quantity: m("0.3") })).order;
    const result = compareWithExchange(partial, {
      state: "partially_filled",
      filledQuantity: m("0.5"),
    });
    expect(result.matches).toBe(false);
    expect(result.filledQuantityDelta).toBe(m("0.2"));
    expect(result.stateDiffers).toBe(false);
  });

  it("surfaces a state drift", () => {
    const result = compareWithExchange(order(), {
      state: "filled" satisfies OrderState,
      filledQuantity: m("1"),
    });
    expect(result.stateDiffers).toBe(true);
    expect(result.filledQuantityDelta).toBe(m("1"));
  });
});
