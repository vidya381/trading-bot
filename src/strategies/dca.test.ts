import { describe, expect, it } from "vitest";
import { fromDecimalString as m, ONE, ZERO } from "../shared/money";
import {
  additionalOrderSizeFor,
  applyEntry,
  assertReadableSchema,
  decide,
  DCA_SCHEMA_VERSION,
  DcaError,
  EMPTY_POSITION,
  nextBuyTriggerPrice,
  plannedTotalSpend,
  positionValue,
  quantityForQuote,
  stopLossPrice,
  takeProfitPrice,
  validateDcaParams,
  type DcaConfig,
  type DcaEntry,
  type DcaParams,
  type DcaPosition,
} from "./dca";

const params: DcaParams = {
  baseOrderSize: m("100"),
  additionalOrderSize: m("100"),
  stepMultiplier: m("1.5"),
  dropPct: m("5"),
  maxAdditionalBuys: 3,
  takeProfitPct: m("2"),
  stopLossPct: m("20"),
  autoRestart: false,
  sellOnStopLoss: false,
};

const config: DcaConfig = {
  schemaVersion: DCA_SCHEMA_VERSION,
  botInstanceId: "dca-btc-1",
  accountLabel: "main",
  exchange: "binance",
  pair: "BTCUSDT",
  capitalAsset: "USDT",
  // 100 + 100 + 150 + 225 = 575
  allocatedCapital: m("600"),
  params,
};

function entry(overrides: Partial<DcaEntry> = {}): DcaEntry {
  return {
    clientOrderId: "v1-dca-btc-1-0",
    price: m("100"),
    quantity: m("1"),
    cost: m("100"),
    at: 1_000,
    ...overrides,
  };
}

function positionAt(price: string, quantity: string, cost: string): DcaPosition {
  return applyEntry(EMPTY_POSITION, entry({ price: m(price), quantity: m(quantity), cost: m(cost) }), false);
}

describe("order sizing", () => {
  it("compounds the step multiplier across additional buys", () => {
    expect(additionalOrderSizeFor(params, 0)).toBe(m("100"));
    expect(additionalOrderSizeFor(params, 1)).toBe(m("150"));
    expect(additionalOrderSizeFor(params, 2)).toBe(m("225"));
    expect(additionalOrderSizeFor(params, 3)).toBe(m("337.5"));
  });

  it("treats a multiplier of ONE as a flat ladder", () => {
    const flat = { ...params, stepMultiplier: ONE };
    expect(additionalOrderSizeFor(flat, 0)).toBe(m("100"));
    expect(additionalOrderSizeFor(flat, 5)).toBe(m("100"));
  });

  it("sums planned spend from exactly the sizes it will request", () => {
    // The property that matters: the capital check and the run-time request
    // must not disagree by a rounding step.
    const summed =
      params.baseOrderSize +
      additionalOrderSizeFor(params, 0) +
      additionalOrderSizeFor(params, 1) +
      additionalOrderSizeFor(params, 2);
    expect(plannedTotalSpend(params)).toBe(summed);
    expect(plannedTotalSpend(params)).toBe(m("575"));
  });

  it("floors the compounding at each step rather than at the end", () => {
    // A multiplier that does not divide evenly at scale 8, so the two
    // strategies genuinely differ.
    const awkward = { ...params, additionalOrderSize: m("0.00000007"), stepMultiplier: m("1.33333333") };
    expect(additionalOrderSizeFor(awkward, 1)).toBe(m("0.00000009"));
    // Floored again, not compounded from an unrounded intermediate.
    expect(additionalOrderSizeFor(awkward, 2)).toBe(m("0.00000011"));
  });

  it("rejects a negative or fractional index", () => {
    expect(() => additionalOrderSizeFor(params, -1)).toThrow(DcaError);
    expect(() => additionalOrderSizeFor(params, 1.5)).toThrow(/non-negative integer/);
  });

  it("floors the quantity a quote amount buys", () => {
    expect(quantityForQuote(m("100"), m("40"))).toBe(m("2.5"));
    // 100 / 3 does not terminate; floors rather than rounding up, so the order
    // cannot cost more quote than was allocated to it.
    expect(quantityForQuote(m("100"), m("3"))).toBe(m("33.33333333"));
  });

  it("refuses a non-positive price", () => {
    expect(() => quantityForQuote(m("100"), ZERO)).toThrow(DcaError);
  });
});

describe("thresholds", () => {
  it("measures the next buy trigger from the last entry, not the average", () => {
    expect(nextBuyTriggerPrice(params, m("100"))).toBe(m("95"));
    expect(nextBuyTriggerPrice(params, m("95"))).toBe(m("90.25"));
  });

  it("rounds the buy trigger down, so the drop must be at least as deep as configured", () => {
    // 3.333...% below 100 is 96.666..., which floors to 96.66666666: a price of
    // 96.66666667 does NOT yet trigger.
    const odd = { ...params, dropPct: m("3.33333333") };
    expect(nextBuyTriggerPrice(odd, m("100"))).toBe(m("96.66666667"));
  });

  it("rounds the take-profit target up, so the exit earns the full configured profit", () => {
    expect(takeProfitPrice(params, m("100"))).toBe(m("102"));
    const odd = { ...params, takeProfitPct: m("0.00000001") };
    expect(takeProfitPrice(odd, m("100"))).toBe(m("100.00000001"));
  });

  it("rounds the stop-loss up, so the halt triggers a fraction sooner", () => {
    expect(stopLossPrice(params, m("100"))).toBe(m("80"));
    const odd = { ...params, stopLossPct: m("33.33333333") };
    // 66.66666667 exactly; ceil keeps the threshold at or above the true value.
    expect(stopLossPrice(odd, m("100"))).toBe(m("66.66666667"));
  });
});

describe("validateDcaParams", () => {
  it("accepts a configuration whose planned spend fits the allocation", () => {
    expect(() => validateDcaParams(params, m("575"))).not.toThrow();
  });

  it("refuses a configuration that cannot fund its own ladder", () => {
    expect(() => validateDcaParams(params, m("574.99999999"))).toThrow(DcaError);
    try {
      validateDcaParams(params, m("100"));
    } catch (error) {
      expect((error as DcaError).code).toBe("exceeds_allocated_capital");
    }
  });

  it.each([
    ["baseOrderSize", { baseOrderSize: ZERO }],
    ["dropPct", { dropPct: ZERO }],
    ["takeProfitPct", { takeProfitPct: ZERO }],
    ["stopLossPct", { stopLossPct: ZERO }],
  ])("refuses a non-positive %s", (_name, override) => {
    expect(() => validateDcaParams({ ...params, ...override }, m("10000"))).toThrow(DcaError);
  });

  it("refuses a drop or stop-loss of 100% or more", () => {
    expect(() => validateDcaParams({ ...params, dropPct: m("100") }, m("10000"))).toThrow(/below 100%/);
    expect(() => validateDcaParams({ ...params, stopLossPct: m("150") }, m("10000"))).toThrow(/below 100%/);
  });

  it("permits a zero-additional-buy configuration without an additional size", () => {
    const single = { ...params, maxAdditionalBuys: 0, additionalOrderSize: ZERO, stepMultiplier: ZERO };
    expect(() => validateDcaParams(single, m("100"))).not.toThrow();
    expect(plannedTotalSpend(single)).toBe(m("100"));
  });

  it("requires an additional size once additional buys are configured", () => {
    expect(() =>
      validateDcaParams({ ...params, additionalOrderSize: ZERO }, m("10000")),
    ).toThrow(/additionalOrderSize must be positive/);
  });

  it("refuses a fractional maxAdditionalBuys", () => {
    expect(() => validateDcaParams({ ...params, maxAdditionalBuys: 2.5 }, m("10000"))).toThrow(DcaError);
  });

  it("refuses sellOnStopLoss, because the selling half is not built", () => {
    // A configured risk control that silently does nothing is worse than an
    // absent one. Delete this test when the sell half lands.
    expect(() => validateDcaParams({ ...params, sellOnStopLoss: true }, m("10000"))).toThrow(
      /not implemented/,
    );
  });
});

describe("applyEntry", () => {
  it("recalculates the average entry price on every entry", () => {
    let position = applyEntry(EMPTY_POSITION, entry({ price: m("100"), quantity: m("1"), cost: m("100") }), false);
    expect(position.averageEntryPrice).toBe(m("100"));
    expect(position.additionalBuysUsed).toBe(0);

    position = applyEntry(position, entry({ price: m("90"), quantity: m("1"), cost: m("90") }), true);
    expect(position.averageEntryPrice).toBe(m("95"));
    expect(position.additionalBuysUsed).toBe(1);
    expect(position.lastEntryPrice).toBe(m("90"));
    expect(position.quantity).toBe(m("2"));
    expect(position.cost).toBe(m("190"));
  });

  it("averages from executed cost and quantity, not from requested amounts", () => {
    // A partial fill: 0.5 of the base acquired for 45 quote, not 1 for 90.
    let position = applyEntry(EMPTY_POSITION, entry({ price: m("100"), quantity: m("1"), cost: m("100") }), false);
    position = applyEntry(position, entry({ price: m("90"), quantity: m("0.5"), cost: m("45") }), true);
    expect(position.quantity).toBe(m("1.5"));
    expect(position.cost).toBe(m("145"));
    expect(position.averageEntryPrice).toBe(m("96.66666667"));
  });

  it("does not mutate the position it was given", () => {
    const before = applyEntry(EMPTY_POSITION, entry(), false);
    const entriesBefore = before.entries.length;
    applyEntry(before, entry({ clientOrderId: "v1-dca-btc-1-1" }), true);
    expect(before.entries.length).toBe(entriesBefore);
    expect(EMPTY_POSITION.entries.length).toBe(0);
  });

  it("refuses a zero-quantity entry", () => {
    expect(() => applyEntry(EMPTY_POSITION, entry({ quantity: ZERO }), false)).toThrow(DcaError);
  });

  it("values a position at a given price without touching the average", () => {
    const position = positionAt("100", "2", "200");
    expect(positionValue(position, m("110"))).toBe(m("220"));
    expect(position.averageEntryPrice).toBe(m("100"));
  });
});

describe("decide", () => {
  it("opens the base order when there is no position", () => {
    expect(decide({ config, position: EMPTY_POSITION, price: m("100"), hasOpenOrder: false })).toEqual({
      kind: "open_base",
      quoteAmount: m("100"),
    });
  });

  it("holds instead of re-opening while the base order is still live", () => {
    expect(decide({ config, position: EMPTY_POSITION, price: m("100"), hasOpenOrder: true })).toEqual({
      kind: "hold",
    });
  });

  it("holds while the price sits between the triggers", () => {
    const position = positionAt("100", "1", "100");
    expect(decide({ config, position, price: m("99"), hasOpenOrder: false })).toEqual({ kind: "hold" });
  });

  it("buys again once the price drops the configured percentage from the last entry", () => {
    const position = positionAt("100", "1", "100");
    expect(decide({ config, position, price: m("95"), hasOpenOrder: false })).toEqual({
      kind: "additional_buy",
      index: 0,
      quoteAmount: m("100"),
      triggerPrice: m("95"),
    });
  });

  it("does not fire at one tick above the trigger", () => {
    const position = positionAt("100", "1", "100");
    expect(decide({ config, position, price: m("95.00000001"), hasOpenOrder: false })).toEqual({ kind: "hold" });
  });

  it("sizes each additional buy by how many have already filled", () => {
    let position = positionAt("100", "1", "100");
    position = applyEntry(position, entry({ price: m("95"), quantity: m("1.05"), cost: m("100") }), true);
    const action = decide({ config, position, price: m("90.25"), hasOpenOrder: false });
    expect(action).toMatchObject({ kind: "additional_buy", index: 1, quoteAmount: m("150") });
  });

  it("suppresses a further buy while an order is outstanding", () => {
    const position = positionAt("100", "1", "100");
    expect(decide({ config, position, price: m("95"), hasOpenOrder: true })).toEqual({ kind: "hold" });
  });

  it("takes profit once the price rises the configured percentage above average entry", () => {
    const position = positionAt("100", "1", "100");
    expect(decide({ config, position, price: m("102"), hasOpenOrder: false })).toEqual({
      kind: "take_profit",
      targetPrice: m("102"),
      quantity: m("1"),
    });
  });

  it("still takes profit with an order outstanding", () => {
    // A risk or profit exit must not wait on a resting limit order that may
    // never fill; the exit path cancels it.
    const position = positionAt("100", "1", "100");
    expect(decide({ config, position, price: m("102"), hasOpenOrder: true })).toMatchObject({
      kind: "take_profit",
    });
  });

  it("takes profit against the AVERAGE entry, not the first one", () => {
    let position = positionAt("100", "1", "100");
    position = applyEntry(position, entry({ price: m("90"), quantity: m("1"), cost: m("90") }), true);
    // Average is 95; the target is 96.9, well below the original 102.
    expect(decide({ config, position, price: m("96.9"), hasOpenOrder: false })).toMatchObject({
      kind: "take_profit",
      targetPrice: m("96.9"),
      quantity: m("2"),
    });
  });

  it("halts on the stop-loss", () => {
    const position = positionAt("100", "1", "100");
    const action = decide({ config, position, price: m("80"), hasOpenOrder: false });
    expect(action).toMatchObject({ kind: "halt", reason: "stop_loss" });
  });

  it("checks the stop-loss before anything else at the same price", () => {
    // Contrived so the price is simultaneously at or below the buy trigger and
    // at or below the stop-loss. The risk exit must win.
    const wide = { ...params, dropPct: m("5"), stopLossPct: m("5") };
    const position = positionAt("100", "1", "100");
    const action = decide({
      config: { ...config, params: wide },
      position,
      price: m("95"),
      hasOpenOrder: false,
    });
    expect(action).toMatchObject({ kind: "halt", reason: "stop_loss" });
  });

  it("stops buying but keeps watching once max additional buys are exhausted", () => {
    // Section 6.3 step 5's second clause: exhaustion is NOT itself a halt. The
    // mandatory stop-loss is the only downside trigger.
    const single = { ...config, params: { ...params, maxAdditionalBuys: 1 } };
    let position = positionAt("100", "1", "100");
    position = applyEntry(position, entry({ price: m("95"), quantity: m("1"), cost: m("95") }), true);

    // Average 97.5; stop-loss at 78. Well below the next drop trigger of 90.25.
    expect(decide({ config: single, position, price: m("90"), hasOpenOrder: false })).toEqual({ kind: "hold" });
    expect(decide({ config: single, position, price: m("80"), hasOpenOrder: false })).toEqual({ kind: "hold" });
    expect(decide({ config: single, position, price: m("78"), hasOpenOrder: false })).toMatchObject({
      kind: "halt",
      reason: "stop_loss",
    });
  });

  it("refuses a non-positive price", () => {
    expect(() => decide({ config, position: EMPTY_POSITION, price: ZERO, hasOpenOrder: false })).toThrow(DcaError);
  });
});

describe("assertReadableSchema", () => {
  it("accepts the current version", () => {
    expect(() => assertReadableSchema(DCA_SCHEMA_VERSION)).not.toThrow();
  });

  it("refuses state written by a version it cannot read", () => {
    expect(() => assertReadableSchema(2)).toThrow(DcaError);
    try {
      assertReadableSchema(0);
    } catch (error) {
      expect((error as DcaError).code).toBe("unknown_schema_version");
    }
  });
});
