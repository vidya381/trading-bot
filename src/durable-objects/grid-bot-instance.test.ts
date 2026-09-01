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
import {
  gridOrderWasPlaced,
  gridOutstanding,
  pollTierFor,
  POLL_TIER_INTERVAL_MS,
  type BotInstance,
  type BotRuntimeState,
  type CreateGridBotRequest,
} from "./bot-instance";
import { FakeExchange, TEST_PAIR } from "./fake-exchange";
import { inBot, noopFeed, rateLimiterStub } from "./test-helpers";

const T0 = 1_900_000_000_000; // future: an armed alarm must not already be overdue (step 20)
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

/**
 * `database` defaults to the suite's real D1. It is overridden only by the
 * best-effort-reporting tests, which need one specific repository method to
 * fail while everything else keeps working.
 */
async function run<T>(
  body: (bot: BotInstance) => Promise<T>,
  database: Database = db,
): Promise<T> {
  return await inBot(objectName, async (instance) => {
    instance.attach({
      db: database,
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

describe("Stage A: a buy filling in several executions is fully covered", () => {
  // The leak, at the object rather than in the pure layer. `fullyFilled` is true
  // on an order's LAST execution, so replace-on-fill ran once and sized the sell
  // from that execution alone; everything acquired earlier stayed held with
  // nothing resting against it, permanently. bot-3trlgb reached this state from
  // an ordinary successful fill -- no cancellation, no collision, no repair.

  it("rests a sell for the WHOLE acquired position, not the completing slice", async () => {
    await startAt("100");
    const buyAt95 = placedAtPrice("95");
    const ordered = exchange.resting.get(buyAt95)!.request.quantity;

    // Two executions at different prices, together completing the order.
    const firstQty = m("0.4");
    const restQty = ordered - firstQty;
    await run((bot) => bot.onFill(buyAt95, exchange.fillFor(buyAt95, { quantity: firstQty, price: m("94") })));
    await run((bot) => bot.onFill(buyAt95, exchange.fillFor(buyAt95, { quantity: restQty, price: m("95") })));

    const snapshot = await run((bot) => bot.snapshot());
    const held = snapshot.state.ladder!.heldQuantity;
    expect(held).toBe(ordered);

    const sells = exchange.placed.filter((o) => o.side === "sell");
    expect(sells).toHaveLength(1);
    // THE INVARIANT THAT WAS BROKEN: everything held has a sell against it.
    expect(sells[0]!.quantity).toBe(held);
    // And the pinned "before": the old code sized this from the last execution.
    expect(sells[0]!.quantity).not.toBe(restQty);
  });

  it("carries a weighted cost basis, strictly between the two execution prices", async () => {
    await startAt("100");
    const buyAt95 = placedAtPrice("95");
    const ordered = exchange.resting.get(buyAt95)!.request.quantity;
    const firstQty = m("0.4");

    await run((bot) => bot.onFill(buyAt95, exchange.fillFor(buyAt95, { quantity: firstQty, price: m("94") })));
    await run((bot) =>
      bot.onFill(buyAt95, exchange.fillFor(buyAt95, { quantity: ordered - firstQty, price: m("96") })),
    );

    const snapshot = await run((bot) => bot.snapshot());
    const sellSlot = snapshot.state.ladder!.slots.find((slot) => slot?.side === "sell")!;
    // Neither execution's own price: a weighted blend of both. Bounded rather
    // than pinned to a constant here -- the exact weighting is pinned in
    // `strategies/grid.test.ts`, and what this asserts is that the object really
    // handed the whole history across the boundary.
    expect(sellSlot.costBasis!).toBeGreaterThan(m("94"));
    expect(sellSlot.costBasis!).toBeLessThan(m("96"));
  });

  it("leaves the single-execution path exactly as it was", async () => {
    // The one path already proven clean (entry 63). Asserted here as well as in
    // the pure layer because the object is what changed around it.
    await startAt("100");
    const buyAt95 = placedAtPrice("95");
    const ordered = exchange.resting.get(buyAt95)!.request.quantity;
    await run((bot) => bot.onFill(buyAt95, exchange.fillFor(buyAt95)));

    const snapshot = await run((bot) => bot.snapshot());
    const sells = exchange.placed.filter((o) => o.side === "sell");
    expect(sells).toHaveLength(1);
    expect(sells[0]!.quantity).toBe(ordered);
    expect(sells[0]!.price).toBe(m("100"));
    expect(snapshot.state.ladder!.heldQuantity).toBe(ordered);
    expect(snapshot.state.ladder!.slots[2]!.costBasis).toBe(m("95"));
  });

  it("still rests nothing while the buy is only partially filled", async () => {
    // Unchanged and correct: the order is still live, so the sell is not owed
    // yet. Only a COMPLETED buy owes its rung.
    await startAt("100");
    const buyAt95 = placedAtPrice("95");
    await run((bot) => bot.onFill(buyAt95, exchange.fillFor(buyAt95, { quantity: m("0.4") })));

    const snapshot = await run((bot) => bot.snapshot());
    expect(snapshot.state.ladder!.heldQuantity).toBe(m("0.4"));
    expect(exchange.placed.filter((o) => o.side === "sell")).toHaveLength(0);
    expect(snapshot.state.ladder!.slots[1]).not.toBeNull();
  });
});

describe("Stage B: a replacement that cannot be placed is queued, never dropped", () => {
  // All five of these used to be dropped while the fold reported `replaced-sell`
  // to its caller. Each one is base the buy acquired with no sell against it,
  // and nothing re-runs replace-on-fill for a rung already missed.

  it("classifies every non-placement outcome as 'nothing is resting'", () => {
    // The branch that decides queue-vs-drop, over every shape
    // `#placeGridOrder` can return. `recover` and `aborted` are covered here
    // rather than end to end: one needs a clientOrderId sequence collision and
    // the other needs the bot to leave `running` mid-flight, neither of which a
    // test can induce without reaching inside the object.
    for (const action of ["slot_occupied", "skipped", "throttled", "unresolved", "recover", "aborted"]) {
      expect(gridOrderWasPlaced({ status: "running", action })).toBe(false);
    }
    // And the success shape `#placeGridOrder` actually mints.
    expect(gridOrderWasPlaced({ status: "running", action: "placed-sell-2" })).toBe(true);
    expect(gridOrderWasPlaced({ status: "running", action: "placed-buy-1" })).toBe(true);
    // Fails CLOSED: an outcome nobody listed is treated as not placed.
    expect(gridOrderWasPlaced({ status: "running", action: "something_new" })).toBe(false);
  });

  it("queues a THROTTLED replacement and does not claim it was placed", async () => {
    await startAt("100");
    const buyAt95 = placedAtPrice("95");
    exchange.nextPlaceFailure = { kind: "rate_limited", message: "budget spent" };

    const result = await run((bot) => bot.onFill(buyAt95, exchange.fillFor(buyAt95)));

    expect(result.action).toBe("queued-sell");
    expect(result.action).not.toBe("replaced-sell");
    const snapshot = await run((bot) => bot.snapshot());
    expect(snapshot.state.pendingReplacements).toHaveLength(1);
    expect(snapshot.state.pendingReplacements![0]).toMatchObject({ levelIndex: 2, side: "sell" });
    expect(exchange.placed.filter((o) => o.side === "sell")).toHaveLength(0);
  });

  it("queues an UNRESOLVED (transport) replacement and does not claim it was placed", async () => {
    await startAt("100");
    const buyAt95 = placedAtPrice("95");
    exchange.nextPlaceFailure = { kind: "transport", message: "socket hang up" };

    const result = await run((bot) => bot.onFill(buyAt95, exchange.fillFor(buyAt95)));

    expect(result.action).toBe("queued-sell");
    const snapshot = await run((bot) => bot.snapshot());
    expect(snapshot.state.pendingReplacements).toHaveLength(1);
  });

  it("queues a SKIPPED (unconstructible) replacement and does not claim it was placed", async () => {
    await startAt("100");
    const buyAt95 = placedAtPrice("95");
    // Raise the venue's minimum above the replacement's size, so the sell
    // cannot be constructed at all. This is the dust shape: the sell is owed
    // and cannot be placed, which is exactly the state a human has to resolve.
    exchange.filters = { ...exchange.filters, minQuantity: m("100") };

    const result = await run((bot) => bot.onFill(buyAt95, exchange.fillFor(buyAt95)));

    expect(result.action).toBe("queued-sell");
    const snapshot = await run((bot) => bot.snapshot());
    expect(snapshot.state.pendingReplacements).toHaveLength(1);
    expect(exchange.placed.filter((o) => o.side === "sell")).toHaveLength(0);
  });

  it("keeps a queued replacement across a drain that still cannot place it", async () => {
    // The other half of the fix. The drain used to REMOVE an intent on every
    // outcome except `slot_occupied` -- "it has had its turn" -- which turned
    // the queue into a one-shot retry and lost the cover one poll later.
    await startAt("100");
    const buyAt95 = placedAtPrice("95");
    exchange.filters = { ...exchange.filters, minQuantity: m("100") };
    await run((bot) => bot.onFill(buyAt95, exchange.fillFor(buyAt95)));
    expect((await run((bot) => bot.snapshot())).state.pendingReplacements).toHaveLength(1);

    // A second fold drains; the sell is still unconstructible.
    const buyAt90 = placedAtPrice("90");
    await run((bot) => bot.onFill(buyAt90, exchange.fillFor(buyAt90, { quantity: m("0.1") })));

    const snapshot = await run((bot) => bot.snapshot());
    expect(snapshot.state.pendingReplacements).toHaveLength(1);
  });

  it("places the queued replacement once it becomes placeable, and only then forgets it", async () => {
    await startAt("100");
    const buyAt95 = placedAtPrice("95");
    exchange.nextPlaceFailure = { kind: "rate_limited", message: "budget spent" };
    await run((bot) => bot.onFill(buyAt95, exchange.fillFor(buyAt95)));
    expect((await run((bot) => bot.snapshot())).state.pendingReplacements).toHaveLength(1);

    // The next fold drains the queue, and this time nothing is forcing a failure.
    const buyAt90 = placedAtPrice("90");
    await run((bot) => bot.onFill(buyAt90, exchange.fillFor(buyAt90, { quantity: m("0.1") })));

    const snapshot = await run((bot) => bot.snapshot());
    expect(snapshot.state.pendingReplacements ?? []).toHaveLength(0);
    const sells = exchange.placed.filter((o) => o.side === "sell");
    expect(sells).toHaveLength(1);
    expect(sells[0]!.price).toBe(m("100"));
  });

  it("raises the standing alert while a replacement stays queued", async () => {
    await startAt("100");
    const buyAt95 = placedAtPrice("95");
    exchange.filters = { ...exchange.filters, minQuantity: m("100") };
    await run((bot) => bot.onFill(buyAt95, exchange.fillFor(buyAt95)));

    // The alert is raised by the DRAIN, which the queuing fold returns before
    // reaching -- so it lands on the next drain (the poll, every 30s, or the
    // next fold) rather than at the instant of queuing. Unchanged from how
    // `slot_occupied` has always behaved, and asserted here so the delay is a
    // recorded property rather than a surprise.
    const buyAt90 = placedAtPrice("90");
    await run((bot) => bot.onFill(buyAt90, exchange.fillFor(buyAt90, { quantity: m("0.1") })));

    const alerts = await db.alerts.findMany({ where: { alert_type: "grid_replacement_queued" } });
    expect(alerts.length).toBeGreaterThanOrEqual(1);
    expect(alerts[0]!.message).toContain("nothing resting against");
  });

  it("writes ONE unconstructible alert, not one per retry", async () => {
    // The flood B's retention would otherwise create: the drain runs on every
    // poll and after every fold, and `order_not_constructible` is an
    // unconditional insert. The first attempt reports the event; the ongoing
    // condition is carried by the standing `grid_replacement_queued` above.
    await startAt("100");
    const buyAt95 = placedAtPrice("95");
    exchange.filters = { ...exchange.filters, minQuantity: m("100") };
    await run((bot) => bot.onFill(buyAt95, exchange.fillFor(buyAt95)));

    const buyAt90 = placedAtPrice("90");
    await run((bot) => bot.onFill(buyAt90, exchange.fillFor(buyAt90, { quantity: m("0.1") })));
    await run((bot) => bot.onFill(buyAt90, exchange.fillFor(buyAt90, { quantity: m("0.1") })));

    const alerts = await db.alerts.findMany({ where: { alert_type: "order_not_constructible" } });
    expect(alerts).toHaveLength(1);
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

// ---------------------------------------------------------------------------
// checkOpenOrders on a ladder (step 19)
// ---------------------------------------------------------------------------

describe("checkOpenOrders on a grid ladder", () => {
  it("places the paired sell for a fill it observed rather than received", async () => {
    // The grid working, not a repair. A buy that filled while resting must
    // replace itself one level up exactly as a pushed fill would -- which is
    // why this path passes `placeReplacement` true where the halted-bot repair
    // passes false.
    await startAt("100");
    const buyAt95 = placedAtPrice("95");
    exchange.fillsByOrder.set(buyAt95, [exchange.fillFor(buyAt95, { fillId: "gemini-tid-31" })]);

    const result = await run((bot) => bot.checkOpenOrders(ACTOR));

    expect(result.applied).toHaveLength(1);
    const sells = exchange.placed.filter((o) => o.side === "sell");
    expect(sells).toHaveLength(1);
    expect(sells[0]!.price).toBe(m("100"));
  });

  it("gives BOTH adjacent buys their sell when they fill in the same pass", async () => {
    /*
     * THE 2026-08-05 REGRESSION, in its original shape.
     *
     * Levels 90 and 95 both rest as buys and both fill in one instant. The poll
     * folds them one at a time, in ascending level order, and folding the fill
     * at level 0 wants its replacement sell at level 1 -- the level the buy at
     * 95 still occupies, because its own fill has not been folded yet.
     *
     * The old code overwrote that slot. The buy at 95 then had no slot, so
     * `levelOf` returned -1 when its fill was read, and it took the "not on the
     * ladder any more" branch: recorded, no replacement, no alert. One sell
     * existed where there should have been two, and the base that buy acquired
     * was held with nothing resting against it. On bot-4xcq8p that happened
     * twice in one pass and stranded 0.00037572 BTC.
     */
    await startAt("100");
    const buyAt90 = placedAtPrice("90");
    const buyAt95 = placedAtPrice("95");
    exchange.fillsByOrder.set(buyAt90, [exchange.fillFor(buyAt90, { fillId: "tid-same-1" })]);
    exchange.fillsByOrder.set(buyAt95, [exchange.fillFor(buyAt95, { fillId: "tid-same-2" })]);

    const result = await run((bot) => bot.checkOpenOrders(ACTOR));

    expect(result.applied).toHaveLength(2);

    // TWO sells, one per filled buy, at the rung above each.
    const sells = exchange.placed.filter((o) => o.side === "sell");
    expect(sells.map((o) => o.price).sort()).toEqual([m("100"), m("95")].sort());

    // And the ladder agrees: every unit of base held is covered by a resting
    // sell. This is the assertion that would have caught the original bug --
    // the position was never wrong, only uncovered.
    const snapshot = await run((bot) => bot.snapshot());
    const ladder = snapshot.state.ladder!;
    const covered = ladder.slots.reduce(
      (total, slot) => (slot !== null && slot.side === "sell" ? total + slot.quantity : total),
      ZERO,
    );
    expect(ladder.heldQuantity).toBeGreaterThan(ZERO);
    expect(covered).toBe(ladder.heldQuantity);
    expect(snapshot.state.pendingReplacements ?? []).toHaveLength(0);
  });

  it("queues a replacement whose level still holds a live resting order, evicting nothing", async () => {
    // The buy at 90 fills alone. Its sell belongs at level 1 (price 95), where
    // a buy is still resting and entirely healthy. The old code would have
    // overwritten that slot -- and for a grid `openOrderIds` is derived from
    // the slots, so the buy at 95 would have stopped being polled and stopped
    // being cancellable while staying live on the exchange.
    await startAt("100");
    const buyAt90 = placedAtPrice("90");
    const buyAt95 = placedAtPrice("95");
    exchange.fillsByOrder.set(buyAt90, [exchange.fillFor(buyAt90, { fillId: "tid-queue-1" })]);

    await run((bot) => bot.checkOpenOrders(ACTOR));

    // Nothing was sold into an occupied rung.
    expect(exchange.placed.filter((o) => o.side === "sell")).toHaveLength(0);
    const snapshot = await run((bot) => bot.snapshot());
    // The occupant is untouched and still tracked.
    expect(snapshot.state.ladder!.slots[1]?.clientOrderId).toBe(buyAt95);
    expect(snapshot.state.openOrderIds).toContain(buyAt95);
    expect(exchange.cancelled).not.toContain(buyAt95);
    // The intent is held, not lost.
    expect(snapshot.state.pendingReplacements).toMatchObject([{ levelIndex: 1, side: "sell" }]);
  });

  it("drains a queued replacement once its level frees up", async () => {
    await startAt("100");
    const buyAt90 = placedAtPrice("90");
    const buyAt95 = placedAtPrice("95");
    exchange.fillsByOrder.set(buyAt90, [exchange.fillFor(buyAt90, { fillId: "tid-drain-1" })]);
    await run((bot) => bot.checkOpenOrders(ACTOR));
    expect((await run((bot) => bot.snapshot())).state.pendingReplacements).toHaveLength(1);

    // Now the buy at 95 fills too, clearing level 1.
    exchange.fillsByOrder.set(buyAt95, [exchange.fillFor(buyAt95, { fillId: "tid-drain-2" })]);
    await run((bot) => bot.checkOpenOrders(ACTOR));

    const snapshot = await run((bot) => bot.snapshot());
    expect(snapshot.state.pendingReplacements ?? []).toHaveLength(0);
    const sells = exchange.placed.filter((o) => o.side === "sell");
    expect(sells.map((o) => o.price).sort()).toEqual([m("100"), m("95")].sort());
  });

  it("records the ladder level and cost basis on the order itself", async () => {
    // The order's own copy of where it belongs. Without it, an order's level is
    // recoverable only by searching the live slots, so an order loses its
    // identity the moment anything takes its slot.
    await startAt("100");
    const buyAt95 = placedAtPrice("95");
    exchange.fillsByOrder.set(buyAt95, [exchange.fillFor(buyAt95, { fillId: "tid-ident-1" })]);
    await run((bot) => bot.checkOpenOrders(ACTOR));

    const snapshot = await run((bot) => bot.snapshot());
    const buy = snapshot.orders.find((o) => o.clientOrderId === buyAt95)!;
    expect(buy.levelIndex).toBe(1);
    expect(buy.costBasis ?? null).toBeNull();

    const sell = snapshot.orders.find((o) => o.side === "sell")!;
    expect(sell.levelIndex).toBe(2);
    // The buy price it replaced -- what makes the round trip's profit exact.
    expect(sell.costBasis).toBe(m("95"));
  });

  it("places NOTHING when the bot is halted, even though the fill is applied", async () => {
    // A halted bot must not put a live order on the exchange. This is the
    // invariant the repair path's `false` protects, and it has to survive a
    // path whose normal answer is `true`.
    await startAt("100");
    const buyAt95 = placedAtPrice("95");
    // Persistent cancel failure: the halt leaves the ladder intact, so the
    // order is still believed open and still gets polled.
    exchange.cancelFailure = { kind: "exchange_error", message: "could not read response" };
    await run((bot) => bot.halt("manual", "reconciliation found drift", ACTOR));
    const placedBefore = exchange.placed.length;
    exchange.fillsByOrder.set(buyAt95, [exchange.fillFor(buyAt95, { fillId: "gemini-tid-32" })]);

    const result = await run((bot) => bot.checkOpenOrders(ACTOR));

    expect(result.status).toBe("halted");
    expect(result.applied).toHaveLength(1);
    expect(exchange.placed).toHaveLength(placedBefore);
  });

  it("clears the ladder slot when the exchange cancelled a level's order", async () => {
    // The ladder owns openOrderIds for a grid, so the slot is the removal.
    await startAt("100");
    const buyAt95 = placedAtPrice("95");
    exchange.resting.get(buyAt95)!.cancelled = true;

    const result = await run((bot) => bot.checkOpenOrders(ACTOR));

    expect(result.closed).toEqual([buyAt95]);
    const snapshot = await run((bot) => bot.snapshot());
    expect(snapshot.state.openOrderIds).not.toContain(buyAt95);
    expect(snapshot.state.ladder!.slots.filter((s) => s !== null)).toHaveLength(1);
  });

  it("separates a REFUSAL from an OUTAGE on a mixed pass, and audits only the refusal (step 22)", async () => {
    // THE TEST THE AUDIT GATE ACTUALLY TURNS ON, and it needs two open orders
    // at once -- which is why it lives here rather than with the DCA passes:
    // `decide` holds while a DCA bot has any open order, so that strategy
    // cannot produce this state at all. The ladder produces it on start.
    //
    // `skipped` holds both lines, because it is the honest full account of what
    // this pass could not do. `refused` holds only the one the pass READ and
    // then declined, and only that one justifies an audit row: gating on
    // `skipped` would write a row on every pass of an outage, ~2,880 a day per
    // bot at the 30-second cadence.
    await startAt("100");
    const buyAt95 = placedAtPrice("95");
    const buyAt90 = placedAtPrice("90");

    // Read fine, then refused: filled beyond what this bot recorded, with no
    // per-fill detail behind it, so there is no real fill id to apply.
    exchange.resting.get(buyAt95)!.filledQuantity = m("1");
    // Never read at all: the venue would not answer for this one.
    exchange.orderStatusFailureFor.add(buyAt90);

    const result = await run((bot) => bot.checkOpenOrders(ACTOR));

    expect(result.applied).toEqual([]);
    expect(result.closed).toEqual([]);
    expect(result.skipped).toHaveLength(2);

    const rows = await db.auditLog.findMany({ where: { action: "bot.open_orders_checked" } });
    expect(rows).toHaveLength(1);
    const details = rows[0]!.details_json as { refused: string[]; skipped: string[] };
    expect(details.skipped).toHaveLength(2);
    expect(details.refused).toHaveLength(1);
    expect(details.refused[0]).toMatch(/no real fill id/);
    expect(details.refused.join(" ")).not.toMatch(/unreadable/);
  });

  it("reads every open order CONCURRENTLY, and still applies them in ladder order", async () => {
    // WHAT THIS PINS, and why a green suite without it proved nothing: the
    // reads in `#pollOpenOrders` used to run strictly one after another, each
    // paying a `RateLimiter` RPC and then a venue round trip before the next
    // one started. A bot resting N orders paid N times a single-order bot's
    // latency -- measured in production as 780ms per alarm on a four-rung
    // ladder against 250-310ms for its single-order peers. Reverting to a
    // sequential loop is invisible to every other test in this file, because
    // the RESULTS are identical either way; only the timing differs. This
    // measures the timing.
    //
    // Two open orders is enough to tell the shapes apart, and the ladder is the
    // only strategy that produces them -- the same reason the mixed pass above
    // lives here rather than with the DCA passes.
    await startAt("100");

    const outstanding = await inBot(
      objectName,
      async (bot) => (await bot.snapshot()).state.openOrderIds,
    );
    expect(outstanding.length).toBeGreaterThan(1);

    // Held open until every caller has arrived, so overlap is observable rather
    // than a matter of scheduling luck.
    let inFlight = 0;
    let maxInFlight = 0;
    const entered: string[] = [];
    const real = exchange.getOrderStatus.bind(exchange);
    exchange.getOrderStatus = async (pair, clientOrderId) => {
      entered.push(clientOrderId);
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      const outcome = await real(pair, clientOrderId);
      inFlight -= 1;
      return outcome;
    };

    await run((bot) => bot.checkOpenOrders(ACTOR));

    // Every read outstanding at once. A sequential loop scores 1 here.
    expect(maxInFlight).toBe(outstanding.length);
    // And the fan-out preserves `openOrderIds` order, which the sequential
    // APPLICATION below it still depends on: a filled buy places its paired
    // sell, mutating the ladder that the next order is applied against.
    expect(entered).toEqual(outstanding);
  });
});

// ---------------------------------------------------------------------------
// repairPosition gate 1 (fix 3): grid is explicitly out of scope
// ---------------------------------------------------------------------------

describe("repairPosition on a grid bot", () => {
  it("refuses at gate 1 rather than guessing at a ladder", async () => {
    // The DCA repair rebuilds `position` from entry and exit fills. A grid bot's
    // position IS its ladder -- levels, slots, `heldQuantity`, `heldCost` -- and
    // reconstructing one is a different problem with different arithmetic.
    // Refusing is honest; attempting it would not be.
    await run((bot) => bot.createGrid(creation()));
    await run((bot) => bot.start(ACTOR));
    await run((bot) => bot.halt("manual", "operator review", ACTOR));

    const report = await run((bot) => bot.repairPosition(ACTOR, { commit: true }));

    expect(report.outcome).toBe("refused");
    expect(report.committed).toBe(false);
    expect(report.blockedBy).toBe("gate 1: strategy");
    expect(report.reasons[0]).toMatch(/grid bot, whose position is its ladder/);
  });
});

// ---------------------------------------------------------------------------
// The `placed` latch: a halted-then-resumed grid must rebuild its ladder.
// See docs/open-items/grid-ladder-placed-latch.md.
// ---------------------------------------------------------------------------

describe("rebuilding a ladder emptied by a wholesale clear", () => {
  /**
   * How many orders the exchange has been asked to place, ever.
   *
   * The assertion that matters throughout this block. Reading the ACTION string
   * is not enough and never was: the defect produced a perfectly well-formed
   * `hold`, and a bot reporting `hold` on every tick is exactly what two real
   * testnet bots looked like while doing nothing at all.
   */
  function placedCount(): number {
    return exchange.placed.length;
  }

  /** Live rungs on the ladder, by level index. */
  async function liveSlots(): Promise<number[]> {
    const snapshot = await run((bot) => bot.snapshot());
    return snapshot.state
      .ladder!.slots.map((slot, index) => (slot === null ? -1 : index))
      .filter((index) => index >= 0);
  }

  it("places a fresh ladder after a MANUAL halt and resume", async () => {
    await startAt("100");
    expect(await liveSlots()).toEqual([0, 1]); // buys at 90 and 95
    const beforeHalt = placedCount();

    await run((bot) => bot.halt("manual", "operator paused it", ACTOR));
    // `#cancelOpenOrders` resolved both rungs, so the ladder is now empty --
    // and `placed` is still true, which is the whole defect.
    expect(await liveSlots()).toEqual([]);
    const snapshotHalted = await run((bot) => bot.snapshot());
    expect(snapshotHalted.state.ladder!.placed).toBe(true);

    await run((bot) => bot.resume(ACTOR));
    const result = await run((bot) => bot.onPriceUpdate(priceAt("100")));

    expect(result.action).toBe("placed_initial_ladder");
    expect(await liveSlots()).toEqual([0, 1]);
    expect(placedCount()).toBe(beforeHalt + 2);

    // The rungs are really tracked, not just written into slots.
    const snapshot = await run((bot) => bot.snapshot());
    for (const slot of snapshot.state.ladder!.slots) {
      if (slot !== null) expect(snapshot.state.openOrderIds).toContain(slot.clientOrderId);
    }
  });

  it("places a fresh ladder after a RECONCILIATION halt and resume", async () => {
    // The path `bot-gvtr1a` actually took: reconciliation's `haltBot` port calls
    // `halt("manual", detail, "reconciliation")`.
    await startAt("100");
    await run((bot) =>
      bot.halt("manual", "reconciliation run r-1 found meaningful drift: ...", "reconciliation"),
    );
    expect(await liveSlots()).toEqual([]);

    await run((bot) => bot.resume(ACTOR));
    await run((bot) => bot.onPriceUpdate(priceAt("100")));

    expect(await liveSlots()).toEqual([0, 1]);
  });

  it("places a fresh ladder after a BREAKOUT exit, once price is back in range", async () => {
    await startAt("100");
    const exited = await run((bot) => bot.onPriceUpdate(priceAt("115")));
    expect(exited).toMatchObject({ status: "halted", action: "breakout_take_profit" });
    expect(await liveSlots()).toEqual([]);
    const afterExit = placedCount();

    await run((bot) => bot.resume(ACTOR));
    await run((bot) => bot.onPriceUpdate(priceAt("100")));

    expect(await liveSlots()).toEqual([0, 1]);
    expect(placedCount()).toBe(afterExit + 2);
  });

  it("places a fresh ladder after a STOP-LOSS exit, once price is back in range", async () => {
    await startAt("100");
    const exited = await run((bot) => bot.onPriceUpdate(priceAt("80")));
    expect(exited).toMatchObject({ status: "halted", action: "stop_loss" });
    expect(await liveSlots()).toEqual([]);

    await run((bot) => bot.resume(ACTOR));
    await run((bot) => bot.onPriceUpdate(priceAt("100")));

    expect(await liveSlots()).toEqual([0, 1]);
  });

  it("places a fresh ladder after liquidatePosition cleared it", async () => {
    await startAt("100");
    const buyAt95 = placedAtPrice("95");
    await run((bot) => bot.onFill(buyAt95, exchange.fillFor(buyAt95)));
    await run((bot) => bot.halt("manual", "operator paused it", ACTOR));

    const liquidation = await run((bot) => bot.liquidatePosition(ACTOR));
    expect(liquidation.action).toBe("liquidating");

    // Fill the liquidation sell so the position goes flat and `exitOrderId`
    // clears. Read the id from state rather than scanning `exchange.placed` for
    // a sell: the replacement sell that the filled buy at 95 placed is also a
    // sell, and it is the earlier of the two.
    const liquidating = await run((bot) => bot.snapshot());
    const exitId = liquidating.state.exitOrderId!;
    expect(exitId).not.toBeNull();
    await run((bot) => bot.onFill(exitId, exchange.fillFor(exitId)));

    const afterLiquidation = await run((bot) => bot.snapshot());
    expect(afterLiquidation.state.exitOrderId).toBeNull();
    expect(afterLiquidation.state.ladder!.heldQuantity).toBe(ZERO);
    expect(afterLiquidation.state.ladder!.placed).toBe(true);
    expect(await liveSlots()).toEqual([]);

    await run((bot) => bot.resume(ACTOR));
    await run((bot) => bot.onPriceUpdate(priceAt("100")));

    expect(await liveSlots()).toEqual([0, 1]);
  });

  it("places a fresh ladder after an order_rejected halt and resume", async () => {
    await startAt("100");
    // A hard refusal on the next placement halts the bot (section 7.5).
    exchange.nextPlaceFailure = { kind: "exchange_error", message: "MissingAccounts" };
    const buyAt95 = placedAtPrice("95");
    await run((bot) => bot.onFill(buyAt95, exchange.fillFor(buyAt95)));

    const halted = await run((bot) => bot.snapshot());
    expect(halted.state.status).toBe("halted");
    expect(halted.state.haltReason).toContain("order_rejected");

    // It halted holding base, so the ladder is NOT vacant and must not rebuild.
    expect(halted.state.ladder!.heldQuantity).toBeGreaterThan(ZERO);
    await run((bot) => bot.resume(ACTOR));
    await run((bot) => bot.onPriceUpdate(priceAt("100")));
    const held = await run((bot) => bot.snapshot());
    expect(held.state.ladder!.slots.every((slot) => slot === null)).toBe(true);
  });
});

describe("the gate order: a resumed bot still past its threshold exits, and does NOT churn", () => {
  it("re-exits on the breakout instead of rebuilding and cancelling a full ladder", async () => {
    await startAt("100");
    await run((bot) => bot.onPriceUpdate(priceAt("115")));
    await run((bot) => bot.resume(ACTOR));
    const before = exchange.placed.length;

    // Resumed, but price never came back: still above the breakout.
    const result = await run((bot) => bot.onPriceUpdate(priceAt("115")));

    expect(result).toMatchObject({ status: "halted", action: "breakout_take_profit" });
    // THE ASSERTION: not one order was placed. With the rebuild gate evaluated
    // first, this pass would have placed the whole ladder and cancelled it again.
    expect(exchange.placed.length).toBe(before);
  });

  it("re-exits on the stop-loss instead of rebuilding beneath it", async () => {
    await startAt("100");
    await run((bot) => bot.onPriceUpdate(priceAt("80")));
    await run((bot) => bot.resume(ACTOR));
    const before = exchange.placed.length;

    const result = await run((bot) => bot.onPriceUpdate(priceAt("80")));

    expect(result).toMatchObject({ status: "halted", action: "stop_loss" });
    expect(exchange.placed.length).toBe(before);
  });
});

describe("the zero-order initial placement (the third exposure)", () => {
  it("does NOT latch `placed` when it placed nothing", async () => {
    // Spot below the lowest line (90) but above the stop-loss (81): every level
    // is at or above spot, so `initialLadderOrders` returns an empty list.
    await run((bot) => bot.createGrid(creation()));
    await run((bot) => bot.start(ACTOR));
    const result = await run((bot) => bot.onPriceUpdate(priceAt("85")));

    expect(result.detail).toBe("0 buy levels below spot");
    expect(exchange.placed).toEqual([]);

    const snapshot = await run((bot) => bot.snapshot());
    expect(snapshot.state.ladder!.placed).toBe(false);
    expect(snapshot.state.status).toBe("running");
  });

  it("places the ladder once price rises back into range", async () => {
    await run((bot) => bot.createGrid(creation()));
    await run((bot) => bot.start(ACTOR));
    await run((bot) => bot.onPriceUpdate(priceAt("85")));
    await run((bot) => bot.onPriceUpdate(priceAt("100")));

    const snapshot = await run((bot) => bot.snapshot());
    expect(snapshot.state.ladder!.placed).toBe(true);
    expect(exchange.placed.length).toBe(2);
  });

  it("HALTS a fresh bot below its stop-loss rather than looping on the gate", async () => {
    // The (f)-plus-reorder interaction. With placement evaluated first, a
    // never-placed bot with nothing to place would re-enter that gate on every
    // tick and never reach this exit.
    await run((bot) => bot.createGrid(creation()));
    await run((bot) => bot.start(ACTOR));
    const result = await run((bot) => bot.onPriceUpdate(priceAt("80")));

    expect(result).toMatchObject({ status: "halted", action: "stop_loss" });
  });
});

describe("the rebuild refuses to fire while anything is outstanding", () => {
  it("does not rebuild while a liquidation sell is still resting", async () => {
    await startAt("100");
    const buyAt95 = placedAtPrice("95");
    await run((bot) => bot.onFill(buyAt95, exchange.fillFor(buyAt95)));
    await run((bot) => bot.halt("manual", "operator paused it", ACTOR));
    await run((bot) => bot.liquidatePosition(ACTOR));

    // Deliberately NOT filled: `exitOrderId` is set and base is still held.
    const beforeResume = exchange.placed.length;
    await run((bot) => bot.resume(ACTOR));
    await run((bot) => bot.onPriceUpdate(priceAt("100")));

    expect(exchange.placed.length).toBe(beforeResume);
    const snapshot = await run((bot) => bot.snapshot());
    expect(snapshot.state.exitOrderId).not.toBeNull();
  });

  it("does not rebuild while base is held with no rung against it", async () => {
    await startAt("100");
    const buyAt95 = placedAtPrice("95");
    await run((bot) => bot.onFill(buyAt95, exchange.fillFor(buyAt95)));
    // Halt clears every rung, but the base bought at 95 is still held.
    await run((bot) => bot.halt("manual", "operator paused it", ACTOR));
    const beforeResume = exchange.placed.length;

    await run((bot) => bot.resume(ACTOR));
    await run((bot) => bot.onPriceUpdate(priceAt("100")));

    // Vacant slots, but NOT vacant: rebuilding would place buys around
    // inventory that has no sell against it. That stays a human's decision.
    expect(exchange.placed.length).toBe(beforeResume);
    const snapshot = await run((bot) => bot.snapshot());
    expect(snapshot.state.ladder!.heldQuantity).toBeGreaterThan(ZERO);
  });
});

describe("the rebuild cannot fire inside 3a's interrupted-resume window", () => {
  /**
   * `run`, but with access to the Durable Object's storage so this block can
   * make the object's own status write fail. The grid counterpart of
   * `resume-write-order.test.ts`'s TEST 2, and it needs its own copy because
   * that file's fixture is a DCA bot and the gate under test is grid-only.
   */
  async function runWithStorage<T>(
    body: (bot: BotInstance, state: DurableObjectState) => Promise<T>,
  ): Promise<T> {
    return await inBot(objectName, async (instance, state) => {
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
      return await body(instance, state);
    });
  }

  it("places nothing while D1 says running and the object still says halted", async () => {
    // 3a writes D1 FIRST and the object SECOND, so an interruption between them
    // leaves exactly this pair. The design's safety argument is that the rebuild
    // is reached only through `#onPriceUpdatePass`, which gates on the OBJECT's
    // status -- never D1's. This asserts that by BEHAVIOUR rather than by
    // restating it: the bot is fed a price and must place nothing.
    await startAt("100");
    await run((bot) => bot.halt("manual", "operator paused it", ACTOR));
    expect(await run((bot) => bot.snapshot())).toMatchObject({
      state: { status: "halted" },
    });

    await expect(
      runWithStorage(async (bot, state) => {
        const storage = state.storage as unknown as {
          put: (key: unknown, value?: unknown) => Promise<void>;
        };
        const realPut = storage.put.bind(storage);
        storage.put = async (key: unknown, value?: unknown) => {
          const status = (value as { status?: string } | undefined)?.status;
          if (key === "state" && status === "running") {
            throw new Error("simulated object-storage failure");
          }
          return await realPut(key, value);
        };
        try {
          return await bot.resume(ACTOR);
        } finally {
          storage.put = realPut;
        }
      }),
    ).rejects.toThrow(/simulated object-storage failure/);

    // The window: D1 committed `running`, the object never left `halted`.
    const row = await db.botInstances.findOne({ id: BOT_ID });
    expect(row!.status).toBe("running");
    const snapshot = await run((bot) => bot.snapshot());
    expect(snapshot.state.status).toBe("halted");
    // And the ladder is vacant -- every precondition for a rebuild is met
    // EXCEPT the object's own status, which is the one that governs.
    expect(snapshot.state.ladder!.slots.every((slot) => slot === null)).toBe(true);
    expect(snapshot.state.ladder!.placed).toBe(true);

    const before = exchange.placed.length;
    const result = await run((bot) => bot.onPriceUpdate(priceAt("100")));

    expect(result.action).toBe("ignored");
    expect(exchange.placed.length).toBe(before);
  });

  it("places the ladder once the resume actually completes", async () => {
    // The other half: the window is survivable, not permanent. Once the object
    // reaches `running`, the very next tick rebuilds.
    await startAt("100");
    await run((bot) => bot.halt("manual", "operator paused it", ACTOR));
    const before = exchange.placed.length;

    await run((bot) => bot.resume(ACTOR));
    await run((bot) => bot.onPriceUpdate(priceAt("100")));

    expect(exchange.placed.length).toBe(before + 2);
  });
});

describe("the standing alert for a running bot with a dead ladder", () => {
  async function vacantAlerts(): Promise<{ resolved: boolean }[]> {
    return await db.alerts.findMany({
      where: { bot_instance_id: BOT_ID, alert_type: "grid_ladder_vacant" },
    });
  }

  it("raises once when a rebuild runs and places nothing", async () => {
    // Spot below the lowest line: the gate fires, `initialLadderOrders` returns
    // nothing, and the bot is left running with an empty ladder. That is not a
    // fault -- but from outside it is indistinguishable from the defect, so it
    // is stated.
    await run((bot) => bot.createGrid(creation()));
    await run((bot) => bot.start(ACTOR));
    await run((bot) => bot.onPriceUpdate(priceAt("85")));

    const raised = await vacantAlerts();
    expect(raised).toHaveLength(1);
    expect(raised[0]!.resolved).toBe(false);

    // Standing, not per-tick: a second pass in the same condition writes no
    // second row.
    await run((bot) => bot.onPriceUpdate(priceAt("86")));
    expect(await vacantAlerts()).toHaveLength(1);
  });

  it("resolves itself once the ladder is actually placed", async () => {
    await run((bot) => bot.createGrid(creation()));
    await run((bot) => bot.start(ACTOR));
    await run((bot) => bot.onPriceUpdate(priceAt("85")));
    expect((await vacantAlerts())[0]!.resolved).toBe(false);

    await run((bot) => bot.onPriceUpdate(priceAt("100")));

    const after = await vacantAlerts();
    expect(after).toHaveLength(1);
    expect(after[0]!.resolved).toBe(true);
  });

  it("never raises on the ordinary path", async () => {
    await startAt("100");
    expect(await vacantAlerts()).toHaveLength(0);

    // Including across a halt and a resume that rebuilds successfully.
    await run((bot) => bot.halt("manual", "operator paused it", ACTOR));
    await run((bot) => bot.resume(ACTOR));
    await run((bot) => bot.onPriceUpdate(priceAt("100")));
    expect(await vacantAlerts()).toHaveLength(0);
  });
});

/**
 * The vacancy report is ADVISORY, and must never be able to stop trading.
 *
 * The live incident these cover: a Cloudflare storage blip failed the `alerts`
 * read inside `raiseStandingAlert` -- for a bot idle below its own range, the
 * only D1 call in the whole price-update pass -- and `#haltOnUnexpected` halted
 * a bot that was doing exactly the right thing. See `#reportLadderVacancy`.
 */
describe("the vacancy report is best-effort and cannot halt the bot", () => {
  /** Tonight's platform error, verbatim. */
  const D1_TIMEOUT =
    "D1_ERROR: D1 DB storage operation exceeded timeout which caused object to be reset.";

  async function vacantAlerts(): Promise<{ resolved: boolean }[]> {
    return await db.alerts.findMany({
      where: { bot_instance_id: BOT_ID, alert_type: "grid_ladder_vacant" },
    });
  }

  /**
   * Methods are bound to the REAL instance rather than to the proxy: `Database`
   * and `Repository` both hold `#` private fields, which resolve against the
   * actual instance and would throw if `this` were the proxy.
   */
  function boundGet(target: object, prop: string | symbol): unknown {
    const value = Reflect.get(target, prop) as unknown;
    return typeof value === "function" ? value.bind(target) : value;
  }

  /** The real database, with ONE repository method replaced by a thrower. */
  function dbFailing(
    real: Database,
    table: "alerts" | "orders",
    method: string,
    message: string,
  ): Database {
    const repository = new Proxy(real[table] as object, {
      get: (target, prop) =>
        prop === method
          ? async () => {
              throw new Error(message);
            }
          : boundGet(target, prop),
    });
    return new Proxy(real, {
      get: (target, prop) => (prop === table ? repository : boundGet(target, prop)),
    });
  }

  it("does not halt when the vacancy alert's own D1 read fails", async () => {
    // THE EXACT LIVE INCIDENT. Spot at 85 is below the lowest line (90) and
    // above the stop-loss (81): the gate fires, nothing is placed, and the
    // vacancy report runs -- whose `alerts` read is the only D1 call this pass
    // makes.
    await run((bot) => bot.createGrid(creation()));
    await run((bot) => bot.start(ACTOR));

    const result = await run(
      (bot) => bot.onPriceUpdate(priceAt("85")),
      dbFailing(db, "alerts", "findMany", D1_TIMEOUT),
    );

    // The pass completed normally, exactly as if the report had never run.
    expect(result.status).toBe("running");
    expect(result.action).toBe("placed_initial_ladder");

    const snapshot = await run((bot) => bot.snapshot());
    expect(snapshot.state.status).toBe("running");
    expect(snapshot.state.haltReason ?? null).toBeNull();

    // D1 agrees: no halt was mirrored, and no halt alert was written.
    expect((await db.botInstances.findOne({ id: BOT_ID }))!.status).toBe("running");
    expect(
      await db.alerts.findMany({ where: { bot_instance_id: BOT_ID, category: "system" } }),
    ).toHaveLength(0);

    // Nothing is lost: the gate re-fires every tick, so the next pass -- with
    // D1 healthy again -- reports the vacancy it could not report before.
    await run((bot) => bot.onPriceUpdate(priceAt("86")));
    const raised = await vacantAlerts();
    expect(raised).toHaveLength(1);
    expect(raised[0]!.resolved).toBe(false);
  });

  it("does not halt when the RESOLVE half's D1 read fails", async () => {
    // The other branch of the same method. A recovering bot whose ladder is no
    // longer vacant reaches `resolveClearedStandingAlerts`, which reads `alerts`
    // too -- and must be just as unable to halt the bot.
    await run((bot) => bot.createGrid(creation()));
    await run((bot) => bot.start(ACTOR));
    await run((bot) => bot.onPriceUpdate(priceAt("85")));
    expect((await vacantAlerts())[0]!.resolved).toBe(false);

    const result = await run(
      (bot) => bot.onPriceUpdate(priceAt("100")),
      dbFailing(db, "alerts", "findMany", D1_TIMEOUT),
    );

    expect(result.status).toBe("running");
    const snapshot = await run((bot) => bot.snapshot());
    expect(snapshot.state.status).toBe("running");
    // The ladder was still built -- the failure touched only the reporting.
    expect(snapshot.state.ladder!.slots.filter((slot) => slot !== null).length).toBeGreaterThan(0);
  });

  it("leaves the ordinary path completely unregressed", async () => {
    // The full raise-then-resolve lifecycle, with a healthy database, still
    // behaves exactly as it did before the `catch` existed.
    await run((bot) => bot.createGrid(creation()));
    await run((bot) => bot.start(ACTOR));

    await run((bot) => bot.onPriceUpdate(priceAt("85")));
    const raised = await vacantAlerts();
    expect(raised).toHaveLength(1);
    expect(raised[0]!.resolved).toBe(false);

    // Standing, not per-tick: still exactly one row.
    await run((bot) => bot.onPriceUpdate(priceAt("86")));
    expect(await vacantAlerts()).toHaveLength(1);

    // Back into range: placed, and the incident closes.
    const result = await run((bot) => bot.onPriceUpdate(priceAt("100")));
    expect(result.action).toBe("placed_initial_ladder");
    const after = await vacantAlerts();
    expect(after).toHaveLength(1);
    expect(after[0]!.resolved).toBe(true);
  });

  it("still halts on an unrelated failure in the same pass", async () => {
    // THE SCOPE CHECK. The `catch` covers the vacancy report and nothing else:
    // a D1 failure on the order mirror -- a real trading write, in the same
    // pass, reached from the same `try` -- must still halt the bot.
    await run((bot) => bot.createGrid(creation()));
    await run((bot) => bot.start(ACTOR));

    const result = await run(
      (bot) => bot.onPriceUpdate(priceAt("100")),
      dbFailing(db, "orders", "insert", D1_TIMEOUT),
    );

    expect(result.status).toBe("halted");
    const snapshot = await run((bot) => bot.snapshot());
    expect(snapshot.state.status).toBe("halted");
    expect(snapshot.state.haltReason).toContain("unhandled_error");
    expect(snapshot.state.haltReason).toContain("exceeded timeout");
  });
});

describe("a PARTIALLY placed ladder is not vacant, and still completes via `!placed`", () => {
  it("leaves `placed` false when one level could not be sent, then finishes it", async () => {
    // THE CASE THAT FORBIDS REPLACING THE FLAG WITH THE DERIVED CONDITION.
    // A partial placement has non-null slots, so `vacantLadder` is false; only
    // `!placed` brings the bot back to finish the levels that were refused. If
    // the gate had been rewritten as "vacant" alone, these rungs would never be
    // placed -- a fresh instance of the very bug this change closes.
    await run((bot) => bot.createGrid(creation()));
    await run((bot) => bot.start(ACTOR));

    // The first order of the pass (level 0, price 90) cannot be sent.
    exchange.nextPlaceFailure = { kind: "transport", message: "socket hang up" };
    const first = await run((bot) => bot.onPriceUpdate(priceAt("100")));
    expect(first.action).toBe("initial_ladder_partial");

    const partial = await run((bot) => bot.snapshot());
    // Exactly one rung live, and the latch is deliberately still false.
    expect(partial.state.ladder!.slots.filter((slot) => slot !== null)).toHaveLength(1);
    expect(partial.state.ladder!.placed).toBe(false);
    // Not vacant: a rung is resting. The rebuild disjunct is NOT what brings
    // this bot back -- `!placed` is.
    expect(partial.state.ladder!.slots.every((slot) => slot === null)).toBe(false);

    // The next tick completes the ladder and only then latches.
    const second = await run((bot) => bot.onPriceUpdate(priceAt("100")));
    expect(second.action).toBe("placed_initial_ladder");

    const complete = await run((bot) => bot.snapshot());
    expect(complete.state.ladder!.slots.filter((slot) => slot !== null)).toHaveLength(2);
    expect(complete.state.ladder!.placed).toBe(true);
    // And it did not double-place the level that was already resting.
    expect(exchange.placed.filter((o) => o.price === m("95"))).toHaveLength(1);
  });
});

describe("gridOutstanding: each term independently blocks a rebuild", () => {
  /** A flat, rung-less grid state -- vacant on every count except the one under test. */
  function flatState(overrides: Partial<BotRuntimeState> = {}): BotRuntimeState {
    return {
      schemaVersion: 1,
      status: "running",
      cycleCount: 0,
      position: { quantity: ZERO, averageEntryPrice: ZERO, spent: ZERO, additionalBuys: 0 },
      nextSequence: 0,
      openOrderIds: [],
      haltReason: null,
      haltedAt: null,
      lastPrice: null,
      lastPriceAt: null,
      realizedGross: ZERO,
      filters: null,
      exitOrderId: null,
      ...overrides,
    } as BotRuntimeState;
  }

  it("is false when nothing is outstanding", () => {
    expect(gridOutstanding(flatState())).toBe(false);
  });

  it("is true while an order is still tracked", () => {
    expect(gridOutstanding(flatState({ openOrderIds: ["v1-grid-btc-1-0"] }))).toBe(true);
  });

  it("is true while an exit sell is resting", () => {
    expect(gridOutstanding(flatState({ exitOrderId: "v1-grid-btc-1-9" }))).toBe(true);
  });

  it("is true while a replacement is queued", () => {
    const queued = flatState({
      pendingReplacements: [
        { levelIndex: 2, side: "sell", price: m("100"), quantity: m("1"), costBasis: m("95") },
      ],
    });
    expect(gridOutstanding(queued)).toBe(true);
  });
});

describe("a gridExit that could not cancel everything does not rebuild on resume", () => {
  it("refuses while a retained order is still unresolved, then rebuilds once it clears", async () => {
    // ENTRY 74's RETAINED ORDERS, and the one `gridOutstanding` term that is
    // reachable on its own. `#gridExit` clears EVERY rung wholesale, while
    // `#cancelOpenOrders` keeps the id of any cancellation it could not confirm.
    // The result is a flat bot with no rungs and an order that may still be
    // live on the exchange -- vacant by slots and by position, and the last
    // thing that should happen is a fresh ladder placed on top of it.
    await startAt("100");
    const buyAt90 = placedAtPrice("90");

    // One cancellation cannot be confirmed during the breakout exit.
    exchange.cancelFailure = { kind: "transport", message: "socket hang up" };
    await run((bot) => bot.onPriceUpdate(priceAt("115")));
    exchange.cancelFailure = null;

    const exited = await run((bot) => bot.snapshot());
    expect(exited.state.status).toBe("halted");
    expect(exited.state.ladder!.slots.every((slot) => slot === null)).toBe(true);
    expect(exited.state.ladder!.heldQuantity).toBe(ZERO);
    expect(exited.state.openOrderIds).toContain(buyAt90);

    const beforeResume = exchange.placed.length;
    await run((bot) => bot.resume(ACTOR));
    await run((bot) => bot.onPriceUpdate(priceAt("100")));

    // THE ASSERTION: nothing placed, because the bot still has unresolved
    // business even though its ladder looks empty.
    expect(exchange.placed.length).toBe(beforeResume);

    // Once that order resolves, the very next tick rebuilds.
    await run((bot) => bot.onFill(buyAt90, exchange.fillFor(buyAt90)));
    await run((bot) => bot.checkOpenOrders(ACTOR));
    const settled = await run((bot) => bot.snapshot());
    if (settled.state.openOrderIds.length === 0 && settled.state.ladder!.heldQuantity === ZERO) {
      await run((bot) => bot.onPriceUpdate(priceAt("100")));
      expect(exchange.placed.length).toBeGreaterThan(beforeResume);
    }
  });
});

// ---------------------------------------------------------------------------
// The poll interval's SAFETY FLOOR (step 84)
// ---------------------------------------------------------------------------

/**
 * The two conditions that outrank every other tier, locked down before the
 * tiering that could break them.
 *
 * WHY THESE TWO AND NOTHING ELSE. The conditional interval that follows slows
 * the poll down for bots whose books can afford to be a little stale: the poll
 * does not evaluate stop-loss or take-profit (those ride price ticks through
 * `#onPriceUpdatePass`), so for most bots it only maintains records. These two
 * states are the exceptions, where the poll IS the mechanism rather than the
 * bookkeeping:
 *
 *  - `exitOrderId !== null` -- a liquidation or take-profit sell is resting on
 *    the exchange RIGHT NOW and the poll is what notices it filled. This is the
 *    risk-management path, not a record of one.
 *  - a non-empty `pendingReplacements` -- a grid buy filled and its paired sell
 *    could not be placed, so base is held with nothing against it. The poll is
 *    what drains the queue (`#drainReplacements`), so a slower poll is a longer
 *    uncovered window -- the exact condition behind `grid_replacement_queued`
 *    and behind the reconciliation drift that halted bot-gnqel3 in production.
 *
 * REGARDLESS OF STRATEGY OR STATUS is the load-bearing half, and the halted
 * case below is why it is not merely defensive. A grid stop-loss cancels every
 * rung, places a liquidation sell, and HALTS -- so the bot sits in `halted`
 * with an exit in flight. A tier that keyed on status alone would put exactly
 * that bot on the dormant interval, slowing the poll for the one order in the
 * whole system that most needs watching. Ordering the urgent checks ahead of
 * the status check is what prevents it, and this test is what would notice if
 * that ordering were ever reversed.
 */
describe("poll interval: the urgent floor outranks every other tier", () => {
  /** The delay the single armed alarm currently represents, from now. */
  async function armedDelay(): Promise<number | null> {
    const at = await inBot(objectName, async (_bot, state) => await state.storage.getAlarm());
    return at === null ? null : at - clock;
  }

  it("keeps the tightest interval for a resting liquidation sell, even though the bot is HALTED", async () => {
    await startAt("100");
    // A held position, so the stop has something to liquidate.
    await run((bot) => bot.onFill(placedAtPrice("95"), exchange.fillFor(placedAtPrice("95"))));

    // Below the lowest line (90) by more than the 10% stop.
    const result = await run((bot) => bot.onPriceUpdate(priceAt("80")));
    expect(result.status).toBe("halted");

    const state = (await run((bot) => bot.snapshot())).state;
    // The precondition this test is actually about: halted AND mid-exit.
    expect(state.status).toBe("halted");
    expect(state.exitOrderId).not.toBeNull();

    expect(await armedDelay()).toBe(30_000);
  });

  it("keeps the tightest interval while a replacement sell is queued", async () => {
    await startAt("100");
    const buyAt95 = placedAtPrice("95");
    // The replacement cannot be placed, so it is queued and base is uncovered.
    exchange.nextPlaceFailure = { kind: "rate_limited", message: "budget spent" };
    await run((bot) => bot.onFill(buyAt95, exchange.fillFor(buyAt95)));

    const state = (await run((bot) => bot.snapshot())).state;
    expect(state.pendingReplacements).toHaveLength(1);

    expect(await armedDelay()).toBe(30_000);
  });

  it("tightens an already-armed loose interval the moment a replacement queues", async () => {
    // THE LAG THIS CLOSES. `#syncAlarm` only recomputes `nextPollAt` when it is
    // null, so a bot that armed on a loose tier would hold that instant even
    // after going urgent -- up to a full loose interval before the floor
    // applied. A fill arrives on the PRICE-TICK path, not the poll, so there is
    // no firing in between to re-arm it. The schedule must be pulled in.
    await startAt("100");
    const armedLoose = await armedDelay();
    expect(armedLoose).toBeGreaterThan(30_000);

    const buyAt95 = placedAtPrice("95");
    exchange.nextPlaceFailure = { kind: "rate_limited", message: "budget spent" };
    await run((bot) => bot.onFill(buyAt95, exchange.fillFor(buyAt95)));

    expect((await run((bot) => bot.snapshot())).state.pendingReplacements).toHaveLength(1);
    expect(await armedDelay()).toBe(30_000);
  });
});

// ---------------------------------------------------------------------------
// The tier table itself (step 84)
// ---------------------------------------------------------------------------

describe("pollTierFor: which cadence a state earns", () => {
  /** A state vacant on every count except the one under test. */
  function stateOf(overrides: Partial<BotRuntimeState> = {}): BotRuntimeState {
    return {
      schemaVersion: 1,
      status: "running",
      cycleCount: 0,
      position: { quantity: ZERO, averageEntryPrice: ZERO, spent: ZERO, additionalBuys: 0 },
      nextSequence: 0,
      openOrderIds: ["v1-grid-btc-1-0"],
      haltReason: null,
      haltedAt: null,
      lastPrice: null,
      lastPriceAt: null,
      realizedGross: ZERO,
      filters: null,
      exitOrderId: null,
      ...overrides,
    } as BotRuntimeState;
  }

  /** A minimal ladder, present only to mark this state as a grid's. */
  const ladder = { slots: [null], heldQuantity: ZERO, heldCost: ZERO, realizedGross: ZERO } as never;
  const queued = [{ levelIndex: 1, side: "sell", price: ZERO }] as never;

  it("puts a running DCA or trailing-stop bot on the routine tier", () => {
    expect(pollTierFor(stateOf())).toBe("routine");
  });

  it("puts a running grid on its own tier, between routine and urgent", () => {
    expect(pollTierFor(stateOf({ ladder }))).toBe("grid");
    expect(POLL_TIER_INTERVAL_MS.grid).toBeLessThan(POLL_TIER_INTERVAL_MS.routine);
    expect(POLL_TIER_INTERVAL_MS.grid).toBeGreaterThan(POLL_TIER_INTERVAL_MS.urgent);
  });

  it("puts a halted bot on the dormant tier, whatever its strategy", () => {
    expect(pollTierFor(stateOf({ status: "halted" }))).toBe("dormant");
    expect(pollTierFor(stateOf({ status: "halted", ladder }))).toBe("dormant");
  });

  // --- the two that outrank everything ------------------------------------

  it("is urgent while an exit is in flight, in EVERY status and strategy", () => {
    for (const status of ["running", "halted"] as const) {
      for (const extra of [{}, { ladder }]) {
        expect(pollTierFor(stateOf({ status, exitOrderId: "v1-grid-btc-1-9", ...extra }))).toBe(
          "urgent",
        );
      }
    }
  });

  it("is urgent while a replacement is queued, in EVERY status and strategy", () => {
    for (const status of ["running", "halted"] as const) {
      expect(pollTierFor(stateOf({ status, ladder, pendingReplacements: queued }))).toBe("urgent");
    }
  });

  it("ranks the urgent floor tightest of all four", () => {
    const intervals = Object.values(POLL_TIER_INTERVAL_MS);
    expect(Math.min(...intervals)).toBe(POLL_TIER_INTERVAL_MS.urgent);
    expect(Math.max(...intervals)).toBe(POLL_TIER_INTERVAL_MS.dormant);
  });
});
