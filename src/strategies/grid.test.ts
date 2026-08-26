import { describe, expect, it } from "vitest";
import { fromDecimalString as m, ZERO } from "../shared/money";
import {
  acquisitionOf,
  breakoutPrice,
  buildLevels,
  claimSlot,
  decide,
  decodeGridParams,
  emptyLadder,
  encodeGridParams,
  GRID_SCHEMA_VERSION,
  GridError,
  initialLadderOrders,
  levelOf,
  openOrderIds,
  planFill,
  quantityForLevel,
  stopLossPrice,
  topRungGap,
  vacantLadder,
  validateGridParams,
  withSlot,
  type GridConfig,
  type GridLadder,
  type GridParams,
  type GridSlot,
} from "./grid";

/** A five-line arithmetic grid from 90 to 110: levels 90, 95, 100, 105, 110. */
const params: GridParams = {
  upperBound: m("110"),
  lowerBound: m("90"),
  gridLines: 5,
  spacing: "arithmetic",
  orderSize: m("100"),
  stopLossPct: m("10"),
  breakoutTakeProfit: true,
  breakoutThresholdPct: null,
  takeProfitAmount: null,
};

const config: GridConfig = {
  strategy: "grid",
  schemaVersion: GRID_SCHEMA_VERSION,
  botInstanceId: "grid-btc-1",
  accountLabel: "main",
  exchange: "binance",
  pair: "BTCUSDT",
  capitalAsset: "USDT",
  // orderSize 100 x (5 - 1) buy levels = 400 peak exposure.
  allocatedCapital: m("500"),
  params,
};

function gridParams(overrides: Partial<GridParams> = {}): GridParams {
  return { ...params, ...overrides };
}

/** A ladder with `placed` true and a given set of live slots, for decide()/planFill tests. */
function placedLadder(overrides: Partial<GridLadder> = {}): GridLadder {
  return { ...emptyLadder(params), placed: true, ...overrides };
}

/**
 * A placed ladder that is actually WORKING -- one live rung, so it is not vacant.
 *
 * `placedLadder()` alone is `placed: true` with every slot null, which is
 * precisely the dead-ladder state `vacantLadder` now matches. Tests that mean
 * "an ordinary running grid" have to say so, or they assert the rebuild path
 * while reading as though they assert `hold`.
 */
function workingLadder(overrides: Partial<GridLadder> = {}): GridLadder {
  const base = placedLadder(overrides);
  return withSlot(base, 1, buySlot("v1-grid-btc-1-live", "1.05"));
}

function buySlot(clientOrderId: string, quantity: string): GridSlot {
  return { side: "buy", clientOrderId, costBasis: null, quantity: m(quantity) };
}

function sellSlot(clientOrderId: string, quantity: string, costBasis: string): GridSlot {
  return { side: "sell", clientOrderId, costBasis: m(costBasis), quantity: m(quantity) };
}

// ---------------------------------------------------------------------------

describe("ladder construction", () => {
  it("builds an arithmetic ladder with equal gaps and pinned bounds", () => {
    expect(buildLevels(params)).toEqual([m("90"), m("95"), m("100"), m("105"), m("110")]);
  });

  it("builds a geometric ladder with equal ratios and pinned bounds", () => {
    // 100 -> 200 in four steps geometrically is a ratio of 2^(1/4) ~ 1.18920712.
    // The interior lands on that ratio compounded and floored; the endpoints are
    // pinned exactly to 100 and 200.
    const geo = buildLevels(
      gridParams({ lowerBound: m("100"), upperBound: m("200"), gridLines: 5, spacing: "geometric" }),
    );
    expect(geo[0]).toBe(m("100"));
    expect(geo[4]).toBe(m("200"));
    // Ratio 2^(1/4) rounds to 1.18920712 at scale 8; interior levels compound
    // it and floor, with the endpoints pinned. Deterministic given the params.
    expect(geo[1]).toBe(m("118.92071200"));
    expect(geo[2]).toBe(m("141.42135742"));
    expect(geo[3]).toBe(m("168.17928516"));
    for (let i = 1; i < geo.length; i += 1) {
      expect(geo[i]! > geo[i - 1]!).toBe(true);
    }
  });

  it("keeps a geometric ladder's ratios equal to within a rounding step", () => {
    const geo = buildLevels(
      gridParams({ lowerBound: m("100"), upperBound: m("200"), gridLines: 5, spacing: "geometric" }),
    );
    // ratio[i] = level[i]/level[i-1]; all four should be ~1.18920712.
    const ratios = geo.slice(1).map((level, i) => (level * 100_000_000n) / geo[i]!);
    for (const ratio of ratios) {
      // within a handful of satoshi of 1.18920712 at scale 8
      expect(ratio >= 118_920_600n && ratio <= 118_920_800n).toBe(true);
    }
  });

  it("rejects fewer than two grid lines", () => {
    expect(() => buildLevels(gridParams({ gridLines: 1 }))).toThrow(/gridLines/);
  });

  it("rejects an upper bound at or below the lower", () => {
    expect(() => buildLevels(gridParams({ upperBound: m("90") }))).toThrow(/must be above/);
  });

  it("rejects a geometric ladder whose lower bound is not positive", () => {
    expect(() =>
      buildLevels(gridParams({ lowerBound: ZERO, spacing: "geometric" })),
    ).toThrow(/lowerBound must be positive/);
  });

  it("rejects a grid too fine for its range at scale 8", () => {
    // 100.00000000 to 100.00000003 with 5 lines cannot give 5 distinct prices.
    expect(() =>
      buildLevels(gridParams({ lowerBound: m("100"), upperBound: m("100.00000003"), gridLines: 5 })),
    ).toThrow(GridError);
  });

  it("exposes the top rung gap for breakout sizing", () => {
    expect(topRungGap(buildLevels(params))).toBe(m("5"));
  });
});

describe("quantities", () => {
  it("floors the base quantity a quote order buys", () => {
    // 100 quote at price 90 -> 1.11111111... base, floored.
    expect(quantityForLevel(m("100"), m("90"))).toBe(m("1.11111111"));
  });
});

describe("thresholds", () => {
  it("puts the stop-loss below the lowest line by the configured percentage", () => {
    // 90 - 10% = 81.
    expect(stopLossPrice(params, buildLevels(params))).toBe(m("81"));
  });

  it("defaults the breakout to one grid step above the highest line", () => {
    // highest 110 + one 5-wide step = 115.
    expect(breakoutPrice(params, buildLevels(params))).toBe(m("115"));
  });

  it("uses a configured breakout percentage when set", () => {
    // highest 110 + 2% = 112.2.
    expect(breakoutPrice(gridParams({ breakoutThresholdPct: m("2") }), buildLevels(params))).toBe(m("112.2"));
  });
});

describe("validation", () => {
  it("accepts a ladder that fits its allocation", () => {
    expect(() => validateGridParams(params, m("400"))).not.toThrow();
  });

  it("refuses a ladder whose peak exposure exceeds the allocation", () => {
    // 100 x 4 buy levels = 400 > 399.
    expect(() => validateGridParams(params, m("399"))).toThrow(/more than the/);
  });

  it("refuses a non-positive order size, stop-loss, or optional field", () => {
    expect(() => validateGridParams(gridParams({ orderSize: ZERO }), m("400"))).toThrow(/orderSize/);
    expect(() => validateGridParams(gridParams({ stopLossPct: ZERO }), m("400"))).toThrow(/stopLossPct/);
    expect(() => validateGridParams(gridParams({ breakoutThresholdPct: m("-1") }), m("400"))).toThrow(
      /breakoutThresholdPct/,
    );
    expect(() => validateGridParams(gridParams({ takeProfitAmount: ZERO }), m("400"))).toThrow(
      /takeProfitAmount/,
    );
  });

  it("refuses a stop-loss of 100% or more, which no positive price can reach", () => {
    expect(() => validateGridParams(gridParams({ stopLossPct: m("100") }), m("400"))).toThrow(/below 100%/);
  });
});

describe("initial ladder (section 6.2 step 2)", () => {
  it("places buys only, at every level strictly below the current price", () => {
    const ladder = emptyLadder(params);
    // Price 100: levels 90 and 95 are below; 100, 105, 110 are not.
    const orders = initialLadderOrders(ladder, params, m("100"));
    expect(orders.map((o) => [o.levelIndex, o.side, o.price])).toEqual([
      [0, "buy", m("90")],
      [1, "buy", m("95")],
    ]);
    // No sells: a quote-funded grid holds no base to sell at start.
    expect(orders.every((o) => o.side === "buy")).toBe(true);
  });

  it("places nothing when the price is at or below the lowest line", () => {
    expect(initialLadderOrders(emptyLadder(params), params, m("90"))).toEqual([]);
  });

  it("sizes each buy by flooring order size over the level price", () => {
    const orders = initialLadderOrders(emptyLadder(params), params, m("100"));
    expect(orders[0]!.quantity).toBe(quantityForLevel(m("100"), m("90")));
  });
});

describe("decide (price-driven, section 6.2)", () => {
  it("asks for the initial ladder while unplaced", () => {
    const action = decide({ config, ladder: emptyLadder(params), price: m("100"), outstanding: false });
    expect(action.kind).toBe("place_initial_ladder");
  });

  it("holds a placed ladder that is inside its bounds", () => {
    expect(decide({ config, ladder: workingLadder(), price: m("100"), outstanding: false }).kind).toBe("hold");
  });

  it("stops out below the lowest line, before any other check", () => {
    const action = decide({
      config,
      ladder: placedLadder({ heldQuantity: m("2") }),
      price: m("81"),
      outstanding: false,
    });
    expect(action).toMatchObject({ kind: "stop_loss", heldQuantity: m("2") });
  });

  it("declares an upside breakout when breakoutTakeProfit is on", () => {
    const action = decide({
      config,
      ladder: placedLadder({ heldQuantity: m("1") }),
      price: m("115"),
      outstanding: false,
    });
    expect(action).toMatchObject({ kind: "breakout_take_profit", heldQuantity: m("1") });
  });

  it("leaves the bot idle above the ladder when breakoutTakeProfit is off", () => {
    const off: GridConfig = { ...config, params: gridParams({ breakoutTakeProfit: false }) };
    expect(decide({ config: off, ladder: workingLadder(), price: m("115"), outstanding: false }).kind).toBe(
      "hold",
    );
  });

  it("takes profit once accumulated realized profit reaches the target", () => {
    const withTarget: GridConfig = { ...config, params: gridParams({ takeProfitAmount: m("50") }) };
    const ladder = workingLadder({ realizedGross: m("50"), heldQuantity: m("1") });
    expect(decide({ config: withTarget, ladder, price: m("100"), outstanding: false }).kind).toBe("take_profit");
  });

  it("rebuilds a VACANT placed ladder -- the halted-then-resumed case", () => {
    // The defect this whole change exists for: `placed` is true (the bot did
    // place a ladder once), every slot was nulled by a wholesale clear, and
    // nothing is held or outstanding. Before the fix this returned `hold`,
    // forever, on a bot that was genuinely running and watching price.
    const action = decide({ config, ladder: placedLadder(), price: m("100"), outstanding: false });
    expect(action.kind).toBe("place_initial_ladder");
    // And it asks for real orders, not an empty list: every level below spot.
    expect(action.kind === "place_initial_ladder" && action.orders.length).toBe(2);
  });

  it("prefers the stop-loss over the breakout if both somehow read true", () => {
    // A degenerate price cannot be both, but the ORDER of checks is what is
    // asserted: stop-loss is evaluated first no matter what.
    const action = decide({ config, ladder: placedLadder(), price: m("50"), outstanding: false });
    expect(action.kind).toBe("stop_loss");
  });
});

describe("vacantLadder (the rebuild condition)", () => {
  it("is true for a placed ladder with no rungs, nothing held and nothing outstanding", () => {
    expect(vacantLadder(placedLadder(), false)).toBe(true);
  });

  it("is FALSE while any rung is live -- a partly placed ladder is a working one", () => {
    expect(vacantLadder(workingLadder(), false)).toBe(false);
  });

  it("is FALSE while base is held -- that is uncovered inventory, a human's call", () => {
    // An initial ladder is BUYS ONLY, so rebuilding here would trade around
    // base that has no sell resting against it and paper over the one detector
    // written to find exactly that.
    expect(vacantLadder(placedLadder({ heldQuantity: m("0.5") }), false)).toBe(false);
  });

  it("is FALSE while anything is outstanding -- unresolved business on the exchange", () => {
    expect(vacantLadder(placedLadder(), true)).toBe(false);
  });

  it("holds rather than rebuilding when outstanding, even with an empty ladder", () => {
    expect(decide({ config, ladder: placedLadder(), price: m("100"), outstanding: true }).kind).toBe(
      "hold",
    );
  });
});

describe("the gate ORDER: risk exits are evaluated before any rebuild", () => {
  // Each of these is a bot that is simultaneously eligible to rebuild (vacant,
  // or never placed) AND past a risk threshold. Rebuilding first would place a
  // full ladder and cancel it on the very next tick, every cycle, forever.

  it("exits on the stop-loss rather than rebuilding a vacant ladder", () => {
    const action = decide({ config, ladder: placedLadder(), price: m("81"), outstanding: false });
    expect(action.kind).toBe("stop_loss");
  });

  it("exits on the breakout rather than rebuilding a vacant ladder", () => {
    const action = decide({ config, ladder: placedLadder(), price: m("115"), outstanding: false });
    expect(action.kind).toBe("breakout_take_profit");
  });

  it("takes profit rather than rebuilding a vacant ladder", () => {
    // The `#gridExit` on take-profit clears the slots; it does NOT clear
    // `realizedGross`. So a bot resumed after one is vacant AND still over its
    // target -- the churn case, exactly.
    const withTarget: GridConfig = { ...config, params: gridParams({ takeProfitAmount: m("50") }) };
    const ladder = placedLadder({ realizedGross: m("50") });
    const action = decide({ config: withTarget, ladder, price: m("100"), outstanding: false });
    expect(action.kind).toBe("take_profit");
  });

  it("exits a FRESH bot below its stop-loss instead of looping on the placement gate", () => {
    // The (f) interaction. A never-placed bot below its lowest line has no
    // orders to place, so with placement first it would re-enter that gate on
    // every tick and never reach this exit at all.
    const action = decide({ config, ladder: emptyLadder(params), price: m("81"), outstanding: false });
    expect(action.kind).toBe("stop_loss");
  });

  it("exits a FRESH bot above its breakout without placing a ladder first", () => {
    const action = decide({ config, ladder: emptyLadder(params), price: m("115"), outstanding: false });
    expect(action.kind).toBe("breakout_take_profit");
  });
});

describe("replace-on-fill (section 6.2 step 3)", () => {
  it("places a sell one level above when a buy fully fills", () => {
    // A buy at level 1 (price 95) filled for 1.05 base.
    const ladder = placedLadder({ slots: withSlot(placedLadder(), 1, buySlot("v1-grid-btc-1-0", "1.05")).slots });
    const plan = planFill(ladder, params, 1, m("95"), m("1.05"), true);

    expect(plan.replacement).toMatchObject({
      levelIndex: 2,
      side: "sell",
      price: m("100"),
      quantity: m("1.05"),
      costBasis: m("95"),
    });
    // The buy slot is cleared; the sell slot is written by the object on placement.
    expect(plan.ladder.slots[1]).toBeNull();
    // Held position grew by the fill.
    expect(plan.ladder.heldQuantity).toBe(m("1.05"));
    expect(plan.realized).toBe(ZERO);
  });

  it("places a buy one level below when a sell fully fills, realizing exact profit", () => {
    // A sell at level 2 (price 100) with cost basis 95 fills for 1.05 base.
    const withSell = withSlot(placedLadder({ heldQuantity: m("1.05"), heldCost: m("99.75") }), 2, sellSlot("v1-grid-btc-1-1", "1.05", "95"));
    const plan = planFill(withSell, params, 2, m("100"), m("1.05"), true);

    // Round trip 95 -> 100 on 1.05 base = 5.25 profit.
    expect(plan.realized).toBe(m("5.25"));
    expect(plan.ladder.realizedGross).toBe(m("5.25"));
    // A new buy one level below, at level 1 (price 95).
    expect(plan.replacement).toMatchObject({ levelIndex: 1, side: "buy", price: m("95"), costBasis: null });
    // Held position shrank by what was sold.
    expect(plan.ladder.heldQuantity).toBe(ZERO);
    expect(plan.ladder.slots[2]).toBeNull();
  });

  it("maintains a correct ladder across a full round trip", () => {
    // Start placed with a buy resting at level 1.
    let ladder = withSlot(placedLadder(), 1, buySlot("buy-1", "1.05"));
    expect(openOrderIds(ladder)).toEqual(["buy-1"]);

    // The buy fills: slot 1 clears, a sell is planned at level 2.
    let plan = planFill(ladder, params, 1, m("95"), m("1.05"), true);
    ladder = plan.ladder;
    // The object writes the sell slot on placement.
    ladder = withSlot(ladder, plan.replacement!.levelIndex, sellSlot("sell-1", "1.05", "95"));
    expect(levelOf(ladder, "sell-1")).toBe(2);
    expect(ladder.heldQuantity).toBe(m("1.05"));

    // The sell fills: slot 2 clears, a buy is planned back at level 1, profit realized.
    plan = planFill(ladder, params, 2, m("100"), m("1.05"), true);
    ladder = plan.ladder;
    ladder = withSlot(ladder, plan.replacement!.levelIndex, buySlot("buy-2", "1.05"));
    expect(levelOf(ladder, "buy-2")).toBe(1);
    expect(ladder.heldQuantity).toBe(ZERO);
    expect(ladder.realizedGross).toBe(m("5.25"));
    // One live order again: the ladder is back where it started, one round trip richer.
    expect(openOrderIds(ladder)).toEqual(["buy-2"]);
  });

  it("moves the position but plans no replacement on a partial fill", () => {
    const ladder = withSlot(placedLadder(), 1, buySlot("buy-1", "2"));
    const plan = planFill(ladder, params, 1, m("95"), m("1"), false);
    expect(plan.replacement).toBeNull();
    expect(plan.ladder.heldQuantity).toBe(m("1"));
    // The order still rests: its slot is untouched.
    expect(plan.ladder.slots[1]).not.toBeNull();
  });

  it("plans no replacement when the top level's buy fills (nothing above to sell into)", () => {
    const ladder = withSlot(placedLadder(), 4, buySlot("buy-top", "1"));
    const plan = planFill(ladder, params, 4, m("110"), m("1"), true);
    expect(plan.replacement).toBeNull();
    expect(plan.ladder.slots[4]).toBeNull();
  });

  it("plans no replacement when the bottom level's sell fills (nothing below to buy into)", () => {
    const ladder = withSlot(
      placedLadder({ heldQuantity: m("1"), heldCost: m("85") }),
      0,
      sellSlot("sell-bottom", "1", "85"),
    );
    const plan = planFill(ladder, params, 0, m("90"), m("1"), true);
    expect(plan.replacement).toBeNull();
    expect(plan.realized).toBe(m("5"));
  });

  it("refuses a fill against a level with no live order", () => {
    expect(() => planFill(placedLadder(), params, 2, m("100"), m("1"), true)).toThrow(/no live order/);
  });
});

describe("sizing a replacement sell across several executions (the uncovered-inventory leak)", () => {
  // THE BUG, IN ONE SENTENCE. `fullyFilled` is true on an order's LAST
  // execution, not only on its only one, so a buy that filled in slices ran
  // this branch once, holding the last slice's quantity -- and the sell was
  // sized from that. The rest stayed held with nothing resting against it, and
  // nothing re-runs replace-on-fill for a rung already missed.
  //
  // bot-3trlgb reached this from an ordinary, entirely successful fill: no
  // cancellation, no slot collision, no repair. That is why these tests fold
  // the fills the way the object really does -- one call per execution -- rather
  // than asserting the final call in isolation.

  it("sells everything the buy acquired, not just the execution that completed it", () => {
    // A buy for 1.0 at level 1, filling 0.4 then 0.6.
    const ladder = withSlot(placedLadder(), 1, buySlot("buy-1", "1"));
    const first = { price: m("94"), quantity: m("0.4") };
    const second = { price: m("95"), quantity: m("0.6") };

    // Execution 1: partial. Position moves, order still rests, no replacement.
    const partial = planFill(ladder, params, 1, first.price, first.quantity, false);
    expect(partial.replacement).toBeNull();
    expect(partial.ladder.heldQuantity).toBe(m("0.4"));

    // Execution 2: completes the order. The whole history goes in.
    const plan = planFill(partial.ladder, params, 1, second.price, second.quantity, true, {
      orderFills: [first, second],
    });

    // The position is 1.0, and the sell resting against it is 1.0.
    expect(plan.ladder.heldQuantity).toBe(m("1"));
    expect(plan.replacement!.quantity).toBe(m("1"));
    expect(plan.replacement!.quantity).toBe(plan.ladder.heldQuantity);

    // THE PINNED "BEFORE". The old code passed `fillQuantity` straight through,
    // so this was 0.6 -- covering the completing execution and abandoning the
    // 0.4 that came first. Named explicitly so the regression is impossible to
    // reintroduce quietly.
    expect(plan.replacement!.quantity).not.toBe(second.quantity);
    expect(plan.ladder.heldQuantity - plan.replacement!.quantity).toBe(ZERO);
  });

  it("carries the quantity-weighted average price as the cost basis, not the last fill's", () => {
    const ladder = withSlot(placedLadder(), 1, buySlot("buy-1", "1"));
    const first = { price: m("94"), quantity: m("0.4") };
    const second = { price: m("95"), quantity: m("0.6") };

    const partial = planFill(ladder, params, 1, first.price, first.quantity, false);
    const plan = planFill(partial.ladder, params, 1, second.price, second.quantity, true, {
      orderFills: [first, second],
    });

    // (94 x 0.4 + 95 x 0.6) / 1.0 = 94.6. Not 95 (the last fill), and not 94.5
    // (the unweighted mean of the two prices) -- the slices are different sizes.
    expect(plan.replacement!.costBasis).toBe(m("94.6"));
    expect(plan.replacement!.costBasis).not.toBe(second.price);
    expect(plan.replacement!.costBasis).not.toBe(m("94.5"));
  });

  it("weights correctly when the average does not divide evenly", () => {
    // 0.1 @ 94 + 0.2 @ 95 = 28.4 over 0.3 -> 94.666... half-even at scale 8.
    const ladder = withSlot(placedLadder(), 1, buySlot("buy-1", "0.3"));
    const first = { price: m("94"), quantity: m("0.1") };
    const second = { price: m("95"), quantity: m("0.2") };

    const partial = planFill(ladder, params, 1, first.price, first.quantity, false);
    const plan = planFill(partial.ladder, params, 1, second.price, second.quantity, true, {
      orderFills: [first, second],
    });

    expect(plan.replacement!.quantity).toBe(m("0.3"));
    expect(plan.replacement!.costBasis).toBe(m("94.66666667"));
  });

  it("handles three executions, because nothing bounds an order to two", () => {
    const ladder = withSlot(placedLadder(), 1, buySlot("buy-1", "0.9"));
    const fills = [
      { price: m("94"), quantity: m("0.2") },
      { price: m("95"), quantity: m("0.3") },
      { price: m("96"), quantity: m("0.4") },
    ];

    let current = placedLadder({ slots: ladder.slots });
    current = planFill(current, params, 1, fills[0]!.price, fills[0]!.quantity, false).ladder;
    current = planFill(current, params, 1, fills[1]!.price, fills[1]!.quantity, false).ladder;
    const plan = planFill(current, params, 1, fills[2]!.price, fills[2]!.quantity, true, {
      orderFills: fills,
    });

    // 18.8 + 28.5 + 38.4 = 85.7 over 0.9 -> 95.22222222 half-even.
    expect(plan.replacement!.quantity).toBe(m("0.9"));
    expect(plan.ladder.heldQuantity).toBe(m("0.9"));
    expect(plan.replacement!.costBasis).toBe(m("95.22222222"));
  });

  it("is bit-identical to the old behaviour on a single-execution full fill", () => {
    // THE UNREGRESSION GUARD for the one path that was already correct. The
    // history-aware call and the historyless one must agree exactly here, which
    // is what makes the change additive rather than a rewrite of the common case.
    const ladder = withSlot(placedLadder(), 1, buySlot("buy-1", "1.05"));
    const only = { price: m("95"), quantity: m("1.05") };

    const withHistory = planFill(ladder, params, 1, only.price, only.quantity, true, {
      orderFills: [only],
    });
    const withoutHistory = planFill(ladder, params, 1, only.price, only.quantity, true);

    expect(withHistory.replacement).toEqual(withoutHistory.replacement);
    expect(withHistory.replacement).toMatchObject({
      levelIndex: 2,
      side: "sell",
      price: m("100"),
      quantity: m("1.05"),
      costBasis: m("95"),
    });
    expect(withHistory.ladder).toEqual(withoutHistory.ladder);
  });

  it("REFUSES to size a multi-execution fill when no history was supplied", () => {
    // Not a fallback, on purpose. Sizing from this execution under-covers the
    // position (the original bug); sizing from the order's requested quantity
    // over-covers it. There is no honest third answer, so it refuses.
    const ladder = withSlot(placedLadder(), 1, buySlot("buy-1", "1"));
    const partial = planFill(ladder, params, 1, m("94"), m("0.4"), false);

    expect(() => planFill(partial.ladder, params, 1, m("95"), m("0.6"), true)).toThrow(
      /more than one execution/,
    );
  });

  it("leaves the SELL side alone: its replacement buy is sized from params, not fills", () => {
    // The sell half never had this bug -- a replacement buy's quantity comes from
    // `quantityForLevel(orderSize, price)`, not from what filled -- and this pins
    // that the fix did not reach across into it.
    const ladder = withSlot(
      placedLadder({ heldQuantity: m("1"), heldCost: m("95") }),
      2,
      sellSlot("sell-1", "1", "95"),
    );
    const firstHalf = planFill(ladder, params, 2, m("100"), m("0.4"), false);
    const plan = planFill(firstHalf.ladder, params, 2, m("100"), m("0.6"), true, {
      orderFills: [
        { price: m("100"), quantity: m("0.4") },
        { price: m("100"), quantity: m("0.6") },
      ],
    });

    expect(plan.replacement).toMatchObject({ levelIndex: 1, side: "buy", price: m("95") });
    expect(plan.replacement!.quantity).toBe(quantityForLevel(params.orderSize, m("95")));
    // Both executions realized their own profit as they landed: 5 over 1.0 base.
    expect(firstHalf.realized + plan.realized).toBe(m("5"));
  });
});

describe("acquisitionOf", () => {
  it("returns a single execution unchanged", () => {
    expect(acquisitionOf([{ price: m("95"), quantity: m("1.05") }])).toEqual({
      price: m("95"),
      quantity: m("1.05"),
    });
  });

  it("sums quantity and weights price by it", () => {
    expect(
      acquisitionOf([
        { price: m("94"), quantity: m("0.4") },
        { price: m("95"), quantity: m("0.6") },
      ]),
    ).toEqual({ price: m("94.6"), quantity: m("1") });
  });

  it("is order-independent: the same executions in any sequence weigh the same", () => {
    const a = { price: m("94"), quantity: m("0.4") };
    const b = { price: m("95"), quantity: m("0.6") };
    expect(acquisitionOf([a, b])).toEqual(acquisitionOf([b, a]));
  });

  it("refuses an empty history rather than dividing by zero", () => {
    expect(() => acquisitionOf([])).toThrow(GridError);
  });
});

describe("claimSlot (the 2026-08-05 slot collision)", () => {
  it("claims a level that is empty", () => {
    const claim = claimSlot(placedLadder(), 1, buySlot("buy-1", "1.05"));
    expect(claim.kind).toBe("claimed");
    expect(claim.kind === "claimed" && claim.ladder.slots[1]?.clientOrderId).toBe("buy-1");
  });

  it("is idempotent when an order re-writes its own slot", () => {
    // A retry must not be mistaken for a collision with itself.
    const ladder = withSlot(placedLadder(), 1, buySlot("buy-1", "1.05"));
    const claim = claimSlot(ladder, 1, buySlot("buy-1", "1.05"));
    expect(claim.kind).toBe("claimed");
  });

  it("refuses a level held by a different order, and names the occupant", () => {
    const ladder = withSlot(placedLadder(), 1, buySlot("buy-1", "1.05"));
    const claim = claimSlot(ladder, 1, sellSlot("sell-9", "1.05", "90"));
    expect(claim.kind).toBe("occupied");
    expect(claim.kind === "occupied" && claim.by.clientOrderId).toBe("buy-1");
    // And critically: the occupant is still there. `withSlot` would have
    // replaced it, taking the ladder's only record that buy-1 is live with it.
    expect(ladder.slots[1]?.clientOrderId).toBe("buy-1");
  });
});

describe("folding a fill whose slot was taken", () => {
  it("realizes profit against the ORDER's cost basis, not the current occupant's", () => {
    // The displaced sell was placed at level 2 carrying cost basis 95. Some
    // other order holds level 2 now, and it carries a different basis.
    const ladder = withSlot(
      placedLadder({ heldQuantity: m("1.05"), heldCost: m("99.75") }),
      2,
      sellSlot("someone-else", "1.05", "50"),
    );
    const displaced = sellSlot("displaced-sell", "1.05", "95");

    const plan = planFill(ladder, params, 2, m("100"), m("1.05"), true, {
      slot: displaced,
      ownsSlot: false,
    });

    // 95 -> 100 on 1.05 base = 5.25. Reading the occupant's basis of 50 would
    // have reported 52.50 -- ten times the real profit, from a sell that never
    // had that basis.
    expect(plan.realized).toBe(m("5.25"));
    expect(plan.ladder.heldQuantity).toBe(ZERO);
  });

  it("leaves the level alone rather than clearing the order that now holds it", () => {
    const ladder = withSlot(placedLadder(), 1, buySlot("current-holder", "1.05"));
    const plan = planFill(ladder, params, 1, m("95"), m("1.05"), true, {
      slot: buySlot("displaced-buy", "1.05"),
      ownsSlot: false,
    });

    // Clearing here would evict `current-holder` -- the same silent loss in the
    // other direction. The fill still moves the position and still plans its
    // replacement one rung up.
    expect(plan.ladder.slots[1]?.clientOrderId).toBe("current-holder");
    expect(plan.ladder.heldQuantity).toBe(m("1.05"));
    expect(plan.replacement).toMatchObject({ levelIndex: 2, side: "sell", costBasis: m("95") });
  });

  it("still clears its own level in the ordinary case", () => {
    const ladder = withSlot(placedLadder(), 1, buySlot("buy-1", "1.05"));
    const plan = planFill(ladder, params, 1, m("95"), m("1.05"), true);
    expect(plan.ladder.slots[1]).toBeNull();
  });
});

describe("the D1 boundary", () => {
  it("round-trips params through the JSON encoding", () => {
    const full = gridParams({ breakoutThresholdPct: m("2"), takeProfitAmount: m("50") });
    expect(decodeGridParams(encodeGridParams(full))).toEqual(full);
  });

  it("round-trips the null-valued optional fields", () => {
    expect(decodeGridParams(encodeGridParams(params))).toEqual(params);
  });

  it("writes every money value as a decimal string, because JSON cannot hold a bigint", () => {
    const json = encodeGridParams(params);
    expect(json).toMatchObject({
      strategy: "grid",
      schemaVersion: GRID_SCHEMA_VERSION,
      lowerBound: "90.00000000",
      upperBound: "110.00000000",
      orderSize: "100.00000000",
      breakoutThresholdPct: null,
      takeProfitAmount: null,
    });
  });

  it("refuses params written for another strategy (the discriminator gate)", () => {
    expect(() => decodeGridParams({ strategy: "dca", schemaVersion: 1 })).toThrow(/not grid/);
  });

  it("refuses a schema version it cannot read", () => {
    const json = { ...encodeGridParams(params), schemaVersion: 99 };
    expect(() => decodeGridParams(json)).toThrow(/schemaVersion 99/);
  });

  it("refuses a non-object", () => {
    expect(() => decodeGridParams(null)).toThrow(/not an object/);
    expect(() => decodeGridParams("nope")).toThrow(/not an object/);
  });
});
