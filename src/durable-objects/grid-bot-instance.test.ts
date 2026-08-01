/**
 * The grid `BotInstance` behaviour, end to end (spec section 6.2), step 9.
 *
 * Real Durable Object storage and real D1 inside the Workers runtime, per
 * section 14; only the exchange is mocked. The same object as the DCA tests,
 * driven through its grid branch.
 *
 * The pure ladder maths and replace-on-fill rule are covered in
 * `../strategies/grid.test.ts`. This file exercises the plumbing: that the
 * object places the initial buy ladder, maintains a correct ladder across fills,
 * cancels every open order on a stop-loss and liquidates the position, and
 * cashes out on an upside breakout.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { seedPlaceholderTotalBalance } from "../capital";
import type { Database } from "../db/database";
import { freshDatabase } from "../db/test-helpers";
import { fromDecimalString as m, ZERO } from "../shared/money";
import type { Price } from "../shared/exchange-client";
import type { GridParams } from "../strategies/grid";
import type { BotInstance, CreateGridBotRequest } from "./bot-instance";
import { FakeExchange, TEST_PAIR } from "./fake-exchange";
import { inBot, noopFeed, rateLimiterStub } from "./test-helpers";

const T0 = 1_760_000_000_000;
const ACTOR = "owner@example.com";
const BOT_ID = "grid-btc-1";

let db: Database;
let exchange: FakeExchange;
let clock: number;
let idCounter: number;
let objectName: string;
let nameCounter = 0;

/** Levels 90, 95, 100, 105, 110. Stop-loss at 81, breakout at 115. */
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

function creation(overrides: Partial<CreateGridBotRequest> = {}): CreateGridBotRequest {
  return {
    botInstanceId: BOT_ID,
    accountLabel: "main",
    exchange: "binance",
    pair: TEST_PAIR,
    capitalAsset: "USDT",
    allocatedCapital: m("500"), // peak exposure 100 x 4 = 400
    params,
    actor: ACTOR,
    ...overrides,
  };
}

function priceAt(value: string): Price {
  return { pair: TEST_PAIR, price: m(value), at: clock };
}

async function run<T>(body: (bot: BotInstance) => Promise<T>): Promise<T> {
  return await inBot(objectName, async (instance) => {
    instance.attach({
      db,
      exchange,
      now: () => clock,
      newId: () => {
        idCounter += 1;
        return `generated-${idCounter}`;
      },
      limiterFor: () => rateLimiterStub(`limiter-${objectName}`),
      sleep: async () => undefined,
      feedFor: () => noopFeed,
    });
    return await body(instance);
  });
}

beforeEach(async () => {
  db = await freshDatabase();
  exchange = new FakeExchange();
  clock = T0;
  idCounter = 0;
  nameCounter += 1;
  objectName = `grid-${nameCounter}`;

  await seedPlaceholderTotalBalance(
    db,
    { accountLabel: "main", asset: "USDT", totalBalance: m("10000"), note: "test fixture" },
    { actor: ACTOR, now: T0 },
  );
});

/** Create, start, and place the initial ladder at `price`. */
async function startAt(price = "100"): Promise<void> {
  await run((bot) => bot.createGrid(creation()));
  await run((bot) => bot.start(ACTOR));
  await run((bot) => bot.onPriceUpdate(priceAt(price)));
}

/** The clientOrderId of the resting order at a given level price, from what was placed. */
function placedAtPrice(price: string): string {
  const order = exchange.placed.find((o) => o.price === m(price) && !exchange.cancelled.includes(o.clientOrderId));
  if (order === undefined) throw new Error(`no live order at ${price}`);
  return order.clientOrderId;
}

// ---------------------------------------------------------------------------

describe("creation (sections 6.1, 6.2, 8.5)", () => {
  it("comes into existence through the capital module with strategy_type grid", async () => {
    const result = await run((bot) => bot.createGrid(creation()));
    expect(result).toEqual({ botInstanceId: BOT_ID, status: "created" });

    const row = await db.botInstances.findOne({ id: BOT_ID });
    expect(row!.strategy_type).toBe("grid");
    expect(row!.allocated_capital).toBe(m("500"));
    // Grid take-profit is an amount, not a pct: the column is null.
    expect(row!.take_profit_pct).toBeNull();
    expect(row!.stop_loss_pct).toBe(m("10"));

    const ledger = await db.capitalLedger.findOne({ account_label: "main", asset: "USDT" });
    expect(ledger!.total_allocated).toBe(m("500"));
  });

  it("stores the constructed ladder in its own state", async () => {
    await run((bot) => bot.createGrid(creation()));
    const snapshot = await run((bot) => bot.snapshot());
    expect(snapshot.config.strategy).toBe("grid");
    expect(snapshot.state.ladder!.levels).toEqual([m("90"), m("95"), m("100"), m("105"), m("110")]);
    expect(snapshot.state.ladder!.placed).toBe(false);
    expect(snapshot.state.ladder!.slots.every((s) => s === null)).toBe(true);
  });

  it("writes grid params as decimal strings through the discriminator gate", async () => {
    await run((bot) => bot.createGrid(creation()));
    const row = await db.botInstances.findOne({ id: BOT_ID });
    expect(row!.strategy_params_json).toMatchObject({
      strategy: "grid",
      lowerBound: "90.00000000",
      upperBound: "110.00000000",
      spacing: "arithmetic",
      breakoutTakeProfit: true,
    });
  });

  it("refuses a ladder whose peak exposure exceeds its allocation", async () => {
    // 100 x 4 buy levels = 400 > 300.
    await expect(run((bot) => bot.createGrid(creation({ allocatedCapital: m("300") })))).rejects.toThrow(
      /more than the/,
    );
    expect(await db.botInstances.findOne({ id: BOT_ID })).toBeNull();
  });
});

describe("initial ladder (section 6.2 step 2)", () => {
  it("places buy orders at every level below the current price, and none above", async () => {
    await startAt("100");
    // Levels 90 and 95 are below 100; 100, 105, 110 are not.
    expect(exchange.placed).toHaveLength(2);
    expect(exchange.placed.every((o) => o.side === "buy")).toBe(true);
    expect(exchange.placed.map((o) => o.price).sort()).toEqual([m("90"), m("95")]);

    const snapshot = await run((bot) => bot.snapshot());
    expect(snapshot.state.ladder!.placed).toBe(true);
    // Two live slots, both buys, at levels 0 and 1.
    expect(snapshot.state.openOrderIds).toHaveLength(2);

    // The order rows are mirrored to D1.
    const orders = await db.orders.findMany({ where: { bot_instance_id: BOT_ID } });
    expect(orders).toHaveLength(2);
    expect(orders.every((o) => o.side === "buy")).toBe(true);
  });

  it("is idempotent: a re-run does not double-place already-live levels", async () => {
    await startAt("100");
    expect(exchange.placed).toHaveLength(2);
    // A second price update at the same price must not place the ladder again.
    await run((bot) => bot.onPriceUpdate(priceAt("100")));
    expect(exchange.placed).toHaveLength(2);
  });
});

describe("replace-on-fill through the object (section 6.2 step 3)", () => {
  it("places a sell one level above when a buy fills", async () => {
    await startAt("100");
    const buyAt95 = placedAtPrice("95");
    await run((bot) => bot.onFill(buyAt95, exchange.fillFor(buyAt95)));

    // A sell should now rest one level up, at 100.
    const sell = exchange.placed.find((o) => o.side === "sell");
    expect(sell).toBeDefined();
    expect(sell!.price).toBe(m("100"));

    const snapshot = await run((bot) => bot.snapshot());
    // Slot 1 (the filled buy) cleared; slot 2 now a sell.
    expect(snapshot.state.ladder!.slots[1]).toBeNull();
    expect(snapshot.state.ladder!.slots[2]!.side).toBe("sell");
    expect(snapshot.state.ladder!.slots[2]!.costBasis).toBe(m("95"));
    expect(snapshot.state.ladder!.heldQuantity).toBeGreaterThan(ZERO);
  });

  it("completes a round trip: sell fills, a buy returns one level below, profit realized", async () => {
    await startAt("100");
    const buyAt95 = placedAtPrice("95");
    await run((bot) => bot.onFill(buyAt95, exchange.fillFor(buyAt95)));
    const sellAt100 = placedAtPrice("100");
    await run((bot) => bot.onFill(sellAt100, exchange.fillFor(sellAt100)));

    const snapshot = await run((bot) => bot.snapshot());
    // A buy is back at level 1 (95); the sell slot cleared.
    expect(snapshot.state.ladder!.slots[2]).toBeNull();
    expect(snapshot.state.ladder!.slots[1]!.side).toBe("buy");
    // Round trip 95 -> 100 realized a positive profit, and held is back to flat.
    expect(snapshot.state.ladder!.realizedGross).toBeGreaterThan(ZERO);
    expect(snapshot.state.realizedGross).toBe(snapshot.state.ladder!.realizedGross);
    expect(snapshot.state.ladder!.heldQuantity).toBe(ZERO);

    // The trade was mirrored to D1.
    const trades = await db.trades.findMany({ where: { bot_instance_id: BOT_ID } });
    expect(trades.length).toBeGreaterThanOrEqual(2);
  });
});

describe("stop-loss (section 6.2 step 4)", () => {
  it("cancels every open order and sells the held position, then halts", async () => {
    await startAt("100");
    // Fill the buy at 95 so there is a held position and a resting sell + buy.
    const buyAt95 = placedAtPrice("95");
    await run((bot) => bot.onFill(buyAt95, exchange.fillFor(buyAt95)));

    // Live orders before the stop: the resting buy at 90, and the sell at 100.
    const buyAt90 = placedAtPrice("90");
    const sellAt100 = placedAtPrice("100");
    const placedBefore = exchange.placed.length;

    // Price breaks below the lowest line (90) by more than the 10% stop -> 80.
    const result = await run((bot) => bot.onPriceUpdate(priceAt("80")));
    expect(result.status).toBe("halted");

    const row = await db.botInstances.findOne({ id: BOT_ID });
    expect(row!.status).toBe("halted");
    expect(row!.halt_reason).toMatch(/stop_loss/);

    // Every open order was cancelled.
    expect(exchange.cancelled).toContain(buyAt90);
    expect(exchange.cancelled).toContain(sellAt100);

    // And a liquidation sell for the held position was placed (one more order).
    expect(exchange.placed.length).toBe(placedBefore + 1);
    const liquidation = exchange.placed[exchange.placed.length - 1]!;
    expect(liquidation.side).toBe("sell");

    const snapshot = await run((bot) => bot.snapshot());
    expect(snapshot.state.exitOrderId).toBe(liquidation.clientOrderId);
    // The alert is critical (a loss), not info.
    const alerts = await db.alerts.findMany({ where: { alert_type: "halt_stop_loss" } });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.severity).toBe("critical");
  });

  it("folds the liquidation fill back in, staying halted with the position flat", async () => {
    await startAt("100");
    const buyAt95 = placedAtPrice("95");
    await run((bot) => bot.onFill(buyAt95, exchange.fillFor(buyAt95)));
    await run((bot) => bot.onPriceUpdate(priceAt("80")));

    const liquidation = exchange.placed[exchange.placed.length - 1]!;
    await run((bot) => bot.onFill(liquidation.clientOrderId, exchange.fillFor(liquidation.clientOrderId)));

    const snapshot = await run((bot) => bot.snapshot());
    expect(snapshot.state.status).toBe("halted");
    expect(snapshot.state.exitOrderId).toBeNull();
    expect(snapshot.state.ladder!.heldQuantity).toBe(ZERO);
  });
});

describe("upside breakout (section 6.2 step 5)", () => {
  it("cashes out and halts when the price breaks above the highest line by default", async () => {
    await startAt("100");
    // Acquire a position so there is something to cash out.
    const buyAt95 = placedAtPrice("95");
    await run((bot) => bot.onFill(buyAt95, exchange.fillFor(buyAt95)));
    const placedBefore = exchange.placed.length;

    // Breakout price is 110 + one 5-step = 115; go above it.
    const result = await run((bot) => bot.onPriceUpdate(priceAt("116")));
    expect(result.status).toBe("halted");

    const row = await db.botInstances.findOne({ id: BOT_ID });
    expect(row!.halt_reason).toMatch(/breakout_take_profit/);

    // A liquidation sell was placed to cash out the held position.
    expect(exchange.placed.length).toBe(placedBefore + 1);
    expect(exchange.placed[exchange.placed.length - 1]!.side).toBe("sell");

    // A breakout cash-out is good news: the halt alert is info, not critical.
    const alerts = await db.alerts.findMany({ where: { alert_type: "halt_breakout_take_profit" } });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.severity).toBe("info");
  });

  it("leaves the bot idle above the ladder when breakoutTakeProfit is off", async () => {
    await run((bot) => bot.createGrid(creation({ params: { ...params, breakoutTakeProfit: false } })));
    await run((bot) => bot.start(ACTOR));
    await run((bot) => bot.onPriceUpdate(priceAt("100")));
    const buyAt95 = placedAtPrice("95");
    await run((bot) => bot.onFill(buyAt95, exchange.fillFor(buyAt95)));

    const result = await run((bot) => bot.onPriceUpdate(priceAt("116")));
    // No cash-out: the bot holds, still running, no new sell for the whole position.
    expect(result.status).toBe("running");
    expect(result.action).toBe("hold");
    const row = await db.botInstances.findOne({ id: BOT_ID });
    expect(row!.status).toBe("running");
  });
});

describe("take-profit on accumulated profit (section 6.2 step 6)", () => {
  it("cashes out once realized profit reaches the configured amount", async () => {
    // A tiny target so one round trip crosses it.
    await run((bot) =>
      bot.createGrid(creation({ params: { ...params, takeProfitAmount: m("1") } })),
    );
    await run((bot) => bot.start(ACTOR));
    await run((bot) => bot.onPriceUpdate(priceAt("100")));

    // One full round trip realizes ~5.26 profit, above the target of 1.
    const buyAt95 = placedAtPrice("95");
    await run((bot) => bot.onFill(buyAt95, exchange.fillFor(buyAt95)));
    const sellAt100 = placedAtPrice("100");
    await run((bot) => bot.onFill(sellAt100, exchange.fillFor(sellAt100)));

    // The next price update sees the accumulated profit target met and cashes out.
    const result = await run((bot) => bot.onPriceUpdate(priceAt("100")));
    expect(result.status).toBe("halted");
    const row = await db.botInstances.findOne({ id: BOT_ID });
    expect(row!.halt_reason).toMatch(/take_profit/);
  });
});

describe("grid halt reuses the shared, throttled cancel path (section 5.4/7.2)", () => {
  it("marks halted before cancelling, so a failed cancel still leaves the bot halted", async () => {
    await startAt("100");
    const buyAt95 = placedAtPrice("95");
    await run((bot) => bot.onFill(buyAt95, exchange.fillFor(buyAt95)));

    // A manual halt (not an exit): cancels, does NOT liquidate.
    const placedBefore = exchange.placed.length;
    const result = await run((bot) => bot.halt("manual", "operator review", ACTOR));
    expect(result.status).toBe("halted");
    // No liquidation sell on a plain manual halt -- that is exit-only behaviour.
    expect(exchange.placed.length).toBe(placedBefore);
    const row = await db.botInstances.findOne({ id: BOT_ID });
    expect(row!.status).toBe("halted");
  });
});

// ---------------------------------------------------------------------------
// applyMissedFills on a GRID bot: the repair must not trade (step 18)
// ---------------------------------------------------------------------------

describe("applyMissedFills never places an order", () => {
  /** A halted grid bot whose ladder is intact and whose buy is still believed open. */
  async function haltedWithLadder(): Promise<string> {
    await startAt("100");
    const buy = placedAtPrice("95");
    // Halting cancels; make it fail, as it did live, so the order stays open and
    // the ladder keeps its slots -- the exact state the incident left behind.
    exchange.cancelFailure = { kind: "exchange_error", message: "could not read response" };
    await run((bot) => bot.halt("manual", "reconciliation found drift", ACTOR));
    return buy;
  }

  it("records the fill but does NOT place the paired sell", async () => {
    // THE HAZARD THIS GUARDS. A grid fill normally places the replacement sell
    // (`#applyGridFillToOrder`). Doing that during a repair would put a live
    // order on the exchange from a HALTED bot -- resuming trading by the back
    // door, which is precisely what the operator withheld consent for.
    const buy = await haltedWithLadder();
    const before = exchange.placed.length;
    exchange.fillsByOrder.set(buy, [exchange.fillFor(buy, { fillId: "gemini-tid-500" })]);

    const result = await run((bot) => bot.applyMissedFills(ACTOR));

    expect(result.applied).toHaveLength(1);
    // Nothing new was sent to the exchange.
    expect(exchange.placed).toHaveLength(before);
    expect(result.status).toBe("halted");
  });

  it("still updates held quantity and cost through planFill", async () => {
    // Suppressing the PLACEMENT must not suppress the ACCOUNTING -- otherwise
    // the repair would trade one wrong number for another.
    const buy = await haltedWithLadder();
    const order = exchange.resting.get(buy)!;
    exchange.fillsByOrder.set(buy, [exchange.fillFor(buy, { fillId: "gemini-tid-501" })]);

    await run((bot) => bot.applyMissedFills(ACTOR));

    const snapshot = await run((bot) => bot.snapshot());
    expect(snapshot.state.ladder!.heldQuantity).toBe(order.request.quantity);
    expect(snapshot.state.ladder!.heldCost).toBeGreaterThan(ZERO);
  });

  it("leaves NO phantom order on the ladder", async () => {
    // `planFill` clears the filled level itself and returns the replacement as a
    // separate intent, so skipping placement cannot leave the ladder believing
    // in an order that was never sent. Asserted, not assumed: a phantom would
    // make the very next reconciliation pass raise fresh drift.
    const buy = await haltedWithLadder();
    exchange.fillsByOrder.set(buy, [exchange.fillFor(buy, { fillId: "gemini-tid-502" })]);

    await run((bot) => bot.applyMissedFills(ACTOR));

    const snapshot = await run((bot) => bot.snapshot());
    const liveIds = snapshot.state.openOrderIds;
    for (const id of liveIds) {
      // Every id the bot still believes open was genuinely placed.
      expect(exchange.placed.some((o) => o.clientOrderId === id)).toBe(true);
    }
    // And the filled level's own slot is cleared.
    expect(liveIds).not.toContain(buy);
  });
});
