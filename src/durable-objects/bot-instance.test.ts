/**
 * The DCA `BotInstance` Durable Object, end to end.
 *
 * Real Durable Object storage and real D1, both inside the Workers runtime, per
 * section 14. Only the exchange is mocked -- Binance's testnet is deliberately
 * not touched by the automated suite.
 *
 * This is also the first test anywhere in the project that drives the
 * idempotency module, the order state machine, the D1 access layer and the
 * capital module together, which step 2's open question 8 has been asking for
 * since it was written.
 */


import { beforeEach, describe, expect, it } from "vitest";
import { seedPlaceholderTotalBalance } from "../capital";
import type { Database } from "../db/database";
import { freshDatabase } from "../db/test-helpers";
import { fromDecimalString as m, ZERO } from "../shared/money";
import type { Price } from "../shared/exchange-client";
import type { DcaParams } from "../strategies/dca";
import type { BotInstance, CreateDcaBotRequest, PipelineResult } from "./bot-instance";
import { BotInstanceError } from "./bot-instance";
import { FakeExchange, TEST_PAIR } from "./fake-exchange";
import { inBot, inLimiter, rateLimiterStub } from "./test-helpers";
import type { AcquireRequest, AcquireResult } from "./rate-limiter";
import { BINANCE_METHOD_WEIGHTS, type RateLimiterPort } from "../exchange/rate-limited";

const T0 = 1_760_000_000_000;
const ACTOR = "owner@example.com";
const BOT_ID = "dca-btc-1";

let db: Database;
let exchange: FakeExchange;
let clock: number;
let idCounter: number;
/** A distinct Durable Object per test, so no state leaks between them. */
let objectName: string;
let nameCounter = 0;

const params: DcaParams = {
  baseOrderSize: m("100"),
  additionalOrderSize: m("100"),
  stepMultiplier: m("1.5"),
  dropPct: m("5"),
  maxAdditionalBuys: 2,
  takeProfitPct: m("2"),
  stopLossPct: m("20"),
  autoRestart: false,
  sellOnStopLoss: false,
};

function creation(overrides: Partial<CreateDcaBotRequest> = {}): CreateDcaBotRequest {
  return {
    botInstanceId: BOT_ID,
    accountLabel: "main",
    exchange: "binance",
    pair: TEST_PAIR,
    capitalAsset: "USDT",
    // base 100 + additional 100 + 150 = 350
    allocatedCapital: m("400"),
    params,
    actor: ACTOR,
    ...overrides,
  };
}

function priceAt(value: string): Price {
  return { pair: TEST_PAIR, price: m(value), at: clock };
}

/**
 * Run `body` inside the Durable Object, with this test's dependencies attached.
 *
 * The rate limiter (section 5.4) is a REAL `RateLimiter` Durable Object, but a
 * fresh one per test, named after this test's bot rather than after its account
 * label. The routing is genuine -- every exchange call below really does request
 * budget first -- while a budget spent by one test cannot starve the next. That
 * is the same isolation `objectName` already gives the bot itself, applied to
 * the other object it now depends on; without it the whole file would share one
 * 1200-weight-per-minute budget against a real wall clock.
 *
 * The tests that care about the BINDING being wired, rather than about the
 * budget, attach no `limiterFor` at all. See "wired to the account's limiter".
 */
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
  objectName = `bot-${nameCounter}`;

  await seedPlaceholderTotalBalance(
    db,
    { accountLabel: "main", asset: "USDT", totalBalance: m("10000"), note: "test fixture" },
    { actor: ACTOR, now: T0 },
  );
});

/** Create, start, and fill the base order at `price`. */
async function openPosition(price = "100"): Promise<string> {
  await run((bot) => bot.create(creation()));
  await run((bot) => bot.start(ACTOR));
  await run((bot) => bot.onPriceUpdate(priceAt(price)));
  const clientOrderId = exchange.placed[0]!.clientOrderId;
  await run((bot) => bot.onFill(clientOrderId, exchange.fillFor(clientOrderId)));
  return clientOrderId;
}

// ---------------------------------------------------------------------------

describe("creation (sections 6.1, 8.5)", () => {
  it("comes into existence through the capital module, not by writing its own row", async () => {
    const result = await run((bot) => bot.create(creation()));
    expect(result).toEqual({ botInstanceId: BOT_ID, status: "created" });

    const row = await db.botInstances.findOne({ id: BOT_ID });
    expect(row).not.toBeNull();
    expect(row!.status).toBe("created");
    expect(row!.allocated_capital).toBe(m("400"));
    expect(row!.strategy_type).toBe("dca");
    expect(row!.capital_asset).toBe("USDT");
    expect(row!.schema_version).toBe(1);

    // The reservation is the capital module's, and it happened.
    const ledger = await db.capitalLedger.findOne({ account_label: "main", asset: "USDT" });
    expect(ledger!.total_allocated).toBe(m("400"));

    // And its audit entry names the capital module's action, not this object's.
    const audit = await db.auditLog.findMany({ where: { action: "capital.allocated" } });
    expect(audit).toHaveLength(1);
  });

  it("stores its full configuration, with a schemaVersion, in its own storage", async () => {
    await run((bot) => bot.create(creation()));
    const snapshot = await run((bot) => bot.snapshot());

    expect(snapshot.config.schemaVersion).toBe(1);
    expect(snapshot.config.pair).toBe(TEST_PAIR);
    // Narrow via the discriminator: config is now the strategy union.
    expect(snapshot.config.strategy).toBe("dca");
    if (snapshot.config.strategy === "dca") {
      expect(snapshot.config.params.takeProfitPct).toBe(m("2"));
    }
    expect(snapshot.state.status).toBe("created");
    expect(snapshot.state.cycleCount).toBe(0);
    expect(snapshot.state.position.quantity).toBe(ZERO);
    expect(snapshot.state.nextSequence).toBe(0);
  });

  it("writes strategy params as decimal strings, because JSON cannot hold a bigint", async () => {
    await run((bot) => bot.create(creation()));
    const row = await db.botInstances.findOne({ id: BOT_ID });
    expect(row!.strategy_params_json).toMatchObject({
      strategy: "dca",
      schemaVersion: 1,
      baseOrderSize: "100.00000000",
      stepMultiplier: "1.50000000",
      maxAdditionalBuys: 2,
      autoRestart: false,
    });
  });

  it("refuses a ladder that cannot be funded from its own allocation", async () => {
    // base 100 + 100 + 150 = 350, against an allocation of 200.
    await expect(run((bot) => bot.create(creation({ allocatedCapital: m("200") })))).rejects.toThrow(
      /more than the .* allocated to it/,
    );
    // Nothing was reserved and no row was written.
    expect(await db.botInstances.findOne({ id: BOT_ID })).toBeNull();
    const ledger = await db.capitalLedger.findOne({ account_label: "main", asset: "USDT" });
    expect(ledger!.total_allocated).toBe(ZERO);
  });

  it("refuses to be created twice", async () => {
    await run((bot) => bot.create(creation()));
    await expect(run((bot) => bot.create(creation()))).rejects.toThrow(BotInstanceError);
  });

  it("refuses a bot instance id that is not a short slug", async () => {
    await expect(
      run((bot) => bot.create(creation({ botInstanceId: crypto.randomUUID() }))),
    ).rejects.toThrow(/must be 1-20 characters/);
  });

  it("refuses to act before it has been created", async () => {
    await expect(run((bot) => bot.start(ACTOR))).rejects.toThrow(BotInstanceError);
    await expect(run((bot) => bot.snapshot())).rejects.toThrow(/no configuration/);
  });
});

describe("start and the base order (section 6.3 steps 1-2)", () => {
  it("moves to running and mirrors that to D1 in the same pass", async () => {
    await run((bot) => bot.create(creation()));
    const result = await run((bot) => bot.start(ACTOR));

    expect(result.status).toBe("running");
    expect((await db.botInstances.findOne({ id: BOT_ID }))!.status).toBe("running");
    const audit = await db.auditLog.findMany({ where: { action: "bot.started" } });
    expect(audit).toHaveLength(1);
    expect(audit[0]!.actor).toBe(ACTOR);
  });

  it("places the base order on the first price update, and mirrors the order row", async () => {
    await run((bot) => bot.create(creation()));
    await run((bot) => bot.start(ACTOR));
    const result = await run((bot) => bot.onPriceUpdate(priceAt("100")));

    expect(result.action).toBe("placed-base");
    expect(exchange.placed).toHaveLength(1);
    expect(exchange.placed[0]).toMatchObject({
      pair: TEST_PAIR,
      side: "buy",
      type: "limit",
      price: m("100"),
      quantity: m("1"),
    });

    // The clientOrderId is the deterministic one from step 2, not a UUID.
    expect(exchange.placed[0]!.clientOrderId).toBe(`v1-${BOT_ID}-0`);

    const orders = await db.orders.findMany({ where: { bot_instance_id: BOT_ID } });
    expect(orders).toHaveLength(1);
    expect(orders[0]).toMatchObject({
      id: `v1-${BOT_ID}-0`,
      client_order_id: `v1-${BOT_ID}-0`,
      exchange_order_id: "E1",
      side: "buy",
      status: "pending",
      price: m("100"),
      quantity: m("1"),
      filled_quantity: ZERO,
    });
  });

  it("does nothing on a price update before it is started", async () => {
    await run((bot) => bot.create(creation()));
    const result = await run((bot) => bot.onPriceUpdate(priceAt("100")));
    expect(result).toMatchObject({ action: "ignored", status: "created" });
    expect(exchange.placed).toHaveLength(0);
  });

  it("cannot be started twice", async () => {
    await run((bot) => bot.create(creation()));
    await run((bot) => bot.start(ACTOR));
    await expect(run((bot) => bot.start(ACTOR))).rejects.toThrow(/cannot start a bot whose status/);
  });
});

describe("fills and average entry (section 6.3 step 3)", () => {
  it("records the position, the order state, and the trade, all in one pass", async () => {
    const clientOrderId = await openPosition("100");

    const snapshot = await run((bot) => bot.snapshot());
    expect(snapshot.state.position.quantity).toBe(m("1"));
    expect(snapshot.state.position.cost).toBe(m("100"));
    expect(snapshot.state.position.averageEntryPrice).toBe(m("100"));
    expect(snapshot.state.openOrderIds).toEqual([]);

    const order = await db.orders.findOne({ id: clientOrderId });
    expect(order).toMatchObject({ status: "filled", filled_quantity: m("1") });

    const trades = await db.trades.findMany({ where: { bot_instance_id: BOT_ID } });
    expect(trades).toHaveLength(1);
    expect(trades[0]).toMatchObject({
      order_id: clientOrderId,
      price: m("100"),
      quantity: m("1"),
      fee_asset: "USDT",
    });
  });

  it("moves the position incrementally on a partial fill", async () => {
    await run((bot) => bot.create(creation()));
    await run((bot) => bot.start(ACTOR));
    await run((bot) => bot.onPriceUpdate(priceAt("100")));
    const id = exchange.placed[0]!.clientOrderId;

    await run((bot) => bot.onFill(id, exchange.fillFor(id, { quantity: m("0.4") })));
    let snapshot = await run((bot) => bot.snapshot());
    expect(snapshot.state.position.quantity).toBe(m("0.4"));
    expect(snapshot.state.openOrderIds).toEqual([id]);
    expect((await db.orders.findOne({ id }))!.status).toBe("partially_filled");

    await run((bot) => bot.onFill(id, exchange.fillFor(id, { quantity: m("0.6") })));
    snapshot = await run((bot) => bot.snapshot());
    expect(snapshot.state.position.quantity).toBe(m("1"));
    expect(snapshot.state.openOrderIds).toEqual([]);
    expect((await db.orders.findOne({ id }))!.status).toBe("filled");
    expect(await db.trades.count({ bot_instance_id: BOT_ID })).toBe(2);
  });

  it("buys again on the configured drop and recalculates the average entry", async () => {
    await openPosition("100");

    // 5% below the last entry of 100.
    const result = await run((bot) => bot.onPriceUpdate(priceAt("95")));
    expect(result.action).toBe("placed-additional-0");
    expect(exchange.placed[1]).toMatchObject({ price: m("95") });
    // 100 quote at 95 -> 1.05263157 base, floored to the step size.
    expect(exchange.placed[1]!.quantity).toBe(m("1.05263"));

    const second = exchange.placed[1]!.clientOrderId;
    expect(second).toBe(`v1-${BOT_ID}-1`);
    await run((bot) => bot.onFill(second, exchange.fillFor(second)));

    const snapshot = await run((bot) => bot.snapshot());
    expect(snapshot.state.position.quantity).toBe(m("2.05263"));
    // cost 100 + 99.99985 = 199.99985 over 2.05263 base.
    expect(snapshot.state.position.cost).toBe(m("199.99985"));
    expect(snapshot.state.position.averageEntryPrice).toBe(m("97.43589931"));
    expect(snapshot.state.position.additionalBuysUsed).toBe(1);
  });

  it("does not buy again while an order is still outstanding", async () => {
    await run((bot) => bot.create(creation()));
    await run((bot) => bot.start(ACTOR));
    await run((bot) => bot.onPriceUpdate(priceAt("100")));
    // The base order is live and unfilled: a further drop must not stack.
    const result = await run((bot) => bot.onPriceUpdate(priceAt("80")));
    expect(result.action).toBe("hold");
    expect(exchange.placed).toHaveLength(1);
  });

  it("stops buying once max additional buys are exhausted, without halting", async () => {
    await openPosition("100");
    for (const price of ["95", "90.25"]) {
      await run((bot) => bot.onPriceUpdate(priceAt(price)));
      const id = exchange.placed.at(-1)!.clientOrderId;
      await run((bot) => bot.onFill(id, exchange.fillFor(id)));
    }
    expect(exchange.placed).toHaveLength(3);

    // A third drop, with maxAdditionalBuys of 2 already used. Above the
    // stop-loss, so it holds rather than halting.
    const result = await run((bot) => bot.onPriceUpdate(priceAt("86")));
    expect(result.action).toBe("hold");
    expect(result.status).toBe("running");
    expect(exchange.placed).toHaveLength(3);
  });

  it("treats a redelivered fill as routine rather than an emergency", async () => {
    await run((bot) => bot.create(creation()));
    await run((bot) => bot.start(ACTOR));
    await run((bot) => bot.onPriceUpdate(priceAt("100")));
    const id = exchange.placed[0]!.clientOrderId;
    const fill = exchange.fillFor(id, { quantity: m("0.4") });

    await run((bot) => bot.onFill(id, fill));
    const replay = await run((bot) => bot.onFill(id, fill));

    // Step 2's decision 8: a duplicate fill is a redelivered queue message, not
    // a reason to halt.
    expect(replay.action).toBe("duplicate_fill");
    expect(replay.status).toBe("running");
    const snapshot = await run((bot) => bot.snapshot());
    expect(snapshot.state.position.quantity).toBe(m("0.4"));
    expect(await db.trades.count({ bot_instance_id: BOT_ID })).toBe(1);
  });

  it("alerts rather than throwing on a fill for an order it never placed", async () => {
    await run((bot) => bot.create(creation()));
    await run((bot) => bot.start(ACTOR));
    const result = await run((bot) =>
      bot.onFill("v1-dca-btc-1-99", {
        fillId: "T1",
        price: m("100"),
        quantity: m("1"),
        feeAmount: ZERO,
        feeAsset: "USDT",
        executedAt: clock,
      }),
    );
    expect(result.action).toBe("unknown_order");
    const alerts = await db.alerts.findMany({ where: { alert_type: "unknown_order_fill" } });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.severity).toBe("critical");
  });
});

describe("fee conversion (section 5.5)", () => {
  it("converts a fee already in the reporting currency at a rate of one", async () => {
    await run((bot) => bot.create(creation()));
    await run((bot) => bot.start(ACTOR));
    await run((bot) => bot.onPriceUpdate(priceAt("100")));
    const id = exchange.placed[0]!.clientOrderId;
    await run((bot) =>
      bot.onFill(id, exchange.fillFor(id, { feeAmount: m("0.1"), feeAsset: "USDT" })),
    );

    const trade = (await db.trades.findMany({ where: { bot_instance_id: BOT_ID } }))[0]!;
    expect(trade.fee_amount).toBe(m("0.1"));
    expect(trade.fee_reporting_amount).toBe(m("0.1"));
    expect(trade.fee_reporting_asset).toBe("USDT");
    expect(trade.fee_conversion_rate).toBe(m("1"));
  });

  it("converts a fee in the base asset at the fill's own price", async () => {
    await run((bot) => bot.create(creation()));
    await run((bot) => bot.start(ACTOR));
    await run((bot) => bot.onPriceUpdate(priceAt("100")));
    const id = exchange.placed[0]!.clientOrderId;
    await run((bot) =>
      bot.onFill(id, exchange.fillFor(id, { feeAmount: m("0.001"), feeAsset: "BTC" })),
    );

    const trade = (await db.trades.findMany({ where: { bot_instance_id: BOT_ID } }))[0]!;
    expect(trade.fee_conversion_rate).toBe(m("100"));
    expect(trade.fee_reporting_amount).toBe(m("0.1"));
  });

  it("leaves all three columns NULL when no rate is available", async () => {
    await run((bot) => bot.create(creation()));
    await run((bot) => bot.start(ACTOR));
    await run((bot) => bot.onPriceUpdate(priceAt("100")));
    const id = exchange.placed[0]!.clientOrderId;
    // A fee in the exchange's own token: nothing here can price it.
    await run((bot) =>
      bot.onFill(id, exchange.fillFor(id, { feeAmount: m("0.5"), feeAsset: "BNB" })),
    );

    const trade = (await db.trades.findMany({ where: { bot_instance_id: BOT_ID } }))[0]!;
    expect(trade.fee_amount).toBe(m("0.5"));
    expect(trade.fee_asset).toBe("BNB");
    expect(trade.fee_reporting_amount).toBeNull();
    expect(trade.fee_reporting_asset).toBeNull();
    expect(trade.fee_conversion_rate).toBeNull();
  });
});

describe("take-profit (section 6.3 steps 4 and 6)", () => {
  async function reachTakeProfit(autoRestart: boolean): Promise<PipelineResult> {
    await run((bot) => bot.create(creation({ params: { ...params, autoRestart } })));
    await run((bot) => bot.start(ACTOR));
    await run((bot) => bot.onPriceUpdate(priceAt("100")));
    const base = exchange.placed[0]!.clientOrderId;
    await run((bot) => bot.onFill(base, exchange.fillFor(base)));

    await run((bot) => bot.onPriceUpdate(priceAt("102")));
    const exit = exchange.placed[1]!.clientOrderId;
    return await run((bot) => bot.onFill(exit, exchange.fillFor(exit)));
  }

  it("sells the full position at the take-profit price", async () => {
    await openPosition("100");
    const result = await run((bot) => bot.onPriceUpdate(priceAt("102")));

    expect(result.action).toBe("placed-take-profit");
    expect(exchange.placed[1]).toMatchObject({
      side: "sell",
      price: m("102"),
      quantity: m("1"),
    });
  });

  it("completes the cycle and starts another when autoRestart is on", async () => {
    const result = await reachTakeProfit(true);
    expect(result.status).toBe("running");

    const snapshot = await run((bot) => bot.snapshot());
    expect(snapshot.state.cycleCount).toBe(1);
    expect(snapshot.state.position.quantity).toBe(ZERO);
    expect(snapshot.state.realizedGross).toBe(m("2"));
    expect(snapshot.state.exitOrderId).toBeNull();
    expect((await db.botInstances.findOne({ id: BOT_ID }))!.status).toBe("running");

    // And the next price update genuinely opens a fresh cycle.
    await run((bot) => bot.onPriceUpdate(priceAt("100")));
    expect(exchange.placed).toHaveLength(3);
    expect(exchange.placed[2]).toMatchObject({ side: "buy" });
  });

  it("halts with take_profit_reached when autoRestart is off", async () => {
    const result = await reachTakeProfit(false);
    expect(result.status).toBe("halted");

    const row = await db.botInstances.findOne({ id: BOT_ID });
    expect(row!.status).toBe("halted");
    expect(row!.halt_reason).toMatch(/take_profit_reached/);
    expect(row!.halted_at).toBe(clock);

    // Capital is NOT released: a completed cycle is not a close.
    const ledger = await db.capitalLedger.findOne({ account_label: "main", asset: "USDT" });
    expect(ledger!.total_allocated).toBe(m("400"));

    const alerts = await db.alerts.findMany({ where: { alert_type: "take_profit" } });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.severity).toBe("info");
  });

  it("records the completed cycle in the audit log", async () => {
    await reachTakeProfit(true);
    const audit = await db.auditLog.findMany({ where: { action: "bot.cycle_completed" } });
    expect(audit).toHaveLength(1);
    expect(audit[0]!.details_json).toMatchObject({ cycle: 1, gross_profit: "2.00000000" });
  });

  it("cancels a resting buy before placing the exit", async () => {
    await run((bot) => bot.create(creation()));
    await run((bot) => bot.start(ACTOR));
    await run((bot) => bot.onPriceUpdate(priceAt("100")));
    const base = exchange.placed[0]!.clientOrderId;
    await run((bot) => bot.onFill(base, exchange.fillFor(base, { quantity: m("0.5") })));

    // Position open AND the base order still live. A take-profit must not leave
    // a buy resting behind the sell.
    await run((bot) => bot.onPriceUpdate(priceAt("102")));
    expect(exchange.cancelled).toContain(base);
  });
});

describe("halt (section 7.2)", () => {
  it("cancels open orders, marks halted with a reason, and alerts", async () => {
    await run((bot) => bot.create(creation()));
    await run((bot) => bot.start(ACTOR));
    await run((bot) => bot.onPriceUpdate(priceAt("100")));
    const base = exchange.placed[0]!.clientOrderId;
    await run((bot) => bot.onFill(base, exchange.fillFor(base)));
    await run((bot) => bot.onPriceUpdate(priceAt("95")));
    const second = exchange.placed[1]!.clientOrderId;

    // Average entry 100, stop-loss 20% -> 80.
    const result = await run((bot) => bot.onPriceUpdate(priceAt("79")));

    expect(result.status).toBe("halted");
    // 1. Open orders cancelled.
    expect(exchange.cancelled).toEqual([second]);
    expect((await db.orders.findOne({ id: second }))!.status).toBe("cancelled");
    // 3. Marked halted with a recorded reason.
    const row = await db.botInstances.findOne({ id: BOT_ID });
    expect(row!.status).toBe("halted");
    expect(row!.halt_reason).toMatch(/^stop_loss: /);
    expect(row!.halted_at).toBe(clock);
    // 4. An alert fired.
    const alerts = await db.alerts.findMany({ where: { alert_type: "halt_stop_loss" } });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.severity).toBe("critical");
    expect(alerts[0]!.category).toBe("trading");
  });

  it("stops placing new orders, and never auto-resumes", async () => {
    await openPosition("100");
    await run((bot) => bot.onPriceUpdate(priceAt("79")));
    const placedAtHalt = exchange.placed.length;

    // 2 and 5: further price updates, including ones that would otherwise
    // trigger a buy or a take-profit, do nothing at all.
    for (const price of ["70", "95", "102", "200"]) {
      const result = await run((bot) => bot.onPriceUpdate(priceAt(price)));
      expect(result).toMatchObject({ action: "ignored", status: "halted" });
    }
    expect(exchange.placed).toHaveLength(placedAtHalt);
  });

  it("does not release capital: a halt is not a close", async () => {
    await openPosition("100");
    await run((bot) => bot.onPriceUpdate(priceAt("79")));
    const ledger = await db.capitalLedger.findOne({ account_label: "main", asset: "USDT" });
    expect(ledger!.total_allocated).toBe(m("400"));
    expect((await db.botInstances.findOne({ id: BOT_ID }))!.status).toBe("halted");
  });

  it("is idempotent", async () => {
    await openPosition("100");
    await run((bot) => bot.halt("manual", "first", ACTOR));
    const second = await run((bot) => bot.halt("manual", "second", ACTOR));
    expect(second.action).toBe("already_halted");
    expect(await db.alerts.count({ alert_type: "halt_manual" })).toBe(1);
  });

  it("keeps halting the rest when one cancellation cannot be confirmed", async () => {
    await openPosition("100");
    await run((bot) => bot.onPriceUpdate(priceAt("95")));
    const resting = exchange.placed[1]!.clientOrderId;
    exchange.nextCancelFailure = { kind: "transport", message: "connection reset" };

    const result = await run((bot) => bot.halt("manual", "operator", ACTOR));
    expect(result.status).toBe("halted");

    // Section 5.6: an unreachable exchange is not a cancellation. The order
    // stays open in this object's own view, and it is alerted on.
    const snapshot = await run((bot) => bot.snapshot());
    expect(snapshot.state.openOrderIds).toEqual([resting]);
    expect((await db.orders.findOne({ id: resting }))!.status).toBe("pending");
    expect(await db.alerts.count({ alert_type: "cancel_failed" })).toBe(1);
  });

  it("alerts, and does not silently adopt, a fill discovered at cancellation", async () => {
    // Step 3.1's open question 1, exercised: the exchange reports more filled
    // at cancellation than this bot knew about, and the response carries no
    // trade id to deduplicate against.
    await openPosition("100");
    await run((bot) => bot.onPriceUpdate(priceAt("95")));
    exchange.fillOnCancel = m("0.25");

    await run((bot) => bot.halt("manual", "operator", ACTOR));

    const alerts = await db.alerts.findMany({ where: { alert_type: "cancel_fill_discrepancy" } });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.message).toMatch(/0\.25000000/);
    // The position is deliberately left understating what is held.
    const snapshot = await run((bot) => bot.snapshot());
    expect(snapshot.state.position.quantity).toBe(m("1"));
  });

  it("halts on an unexpected exception (section 7.5)", async () => {
    await openPosition("100");
    // No cached filters would be needed here, so force the failure path that
    // throws rather than one that has a stale value to fall back on.
    await run(async (bot) => {
      await bot.halt("manual", "reset", ACTOR);
      return null;
    });

    // A genuinely unexpected error: an exchange whose placeOrder throws.
    const broken = new FakeExchange();
    broken.placeOrder = async () => {
      throw new TypeError("something nobody anticipated");
    };
    await inBot(objectName, async (instance) => {
      instance.attach({
        db,
        exchange: broken,
        now: () => clock,
        newId: () => {
          idCounter += 1;
          return `generated-${idCounter}`;
        },
      });
      await instance.resume(ACTOR);
      return await instance.onPriceUpdate(priceAt("102"));
    });

    const row = await db.botInstances.findOne({ id: BOT_ID });
    expect(row!.status).toBe("halted");
    expect(row!.halt_reason).toMatch(/unhandled_error: TypeError/);
    // One alert per event, not two: the halt raises it, classified `system`.
    const alerts = await db.alerts.findMany({ where: { alert_type: "halt_unhandled_error" } });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.category).toBe("system");
  });

  it("halts rather than skipping when the exchange refuses an order outright", async () => {
    await run((bot) => bot.create(creation()));
    await run((bot) => bot.start(ACTOR));
    exchange.nextPlaceFailure = { kind: "exchange_error", message: "account has insufficient balance" };

    const result = await run((bot) => bot.onPriceUpdate(priceAt("100")));
    expect(result.status).toBe("halted");
    expect((await db.botInstances.findOne({ id: BOT_ID }))!.halt_reason).toMatch(/order_rejected/);
  });

  it("leaves an order of unknown outcome unresolved rather than halting or resending", async () => {
    await run((bot) => bot.create(creation()));
    await run((bot) => bot.start(ACTOR));
    exchange.nextPlaceFailure = { kind: "transport", message: "socket hang up" };

    const result = await run((bot) => bot.onPriceUpdate(priceAt("100")));
    // Section 5.6 and 5.1: the order may or may not exist. Still running, and
    // the attempt record stays `attempting` so recovery looks it up.
    expect(result).toMatchObject({ status: "running", action: "unresolved" });

    // The sequence is spent. A retry must NOT re-send under the same id.
    const retry = await run((bot) => bot.onPriceUpdate(priceAt("100")));
    expect(retry.action).toBe("placed-base");
    expect(exchange.placed[0]!.clientOrderId).toBe(`v1-${BOT_ID}-1`);
  });

  it("skips an order the symbol filters reject, without halting", async () => {
    // Section 4.3: "do not send it; log the reason and skip that action."
    exchange.filters = { ...exchange.filters, minNotional: m("1000") };
    await run((bot) => bot.create(creation()));
    await run((bot) => bot.start(ACTOR));

    const result = await run((bot) => bot.onPriceUpdate(priceAt("100")));
    expect(result).toMatchObject({ status: "running", action: "skipped" });
    expect(exchange.placed).toHaveLength(0);
    expect(await db.alerts.count({ alert_type: "order_not_constructible" })).toBe(1);
  });
});

describe("resume (section 7.2 step 5)", () => {
  it("is the only path out of halted, and takes an actor", async () => {
    await openPosition("100");
    await run((bot) => bot.halt("manual", "operator review", ACTOR));

    const result = await run((bot) => bot.resume(ACTOR));
    expect(result.status).toBe("running");
    const row = await db.botInstances.findOne({ id: BOT_ID });
    expect(row!.status).toBe("running");
    // The reason is deliberately kept, per migration 0001's one-directional
    // halt_requires_reason CHECK.
    expect(row!.halt_reason).toMatch(/manual/);

    const audit = await db.auditLog.findMany({ where: { action: "bot.resumed" } });
    expect(audit[0]!.actor).toBe(ACTOR);
  });

  it("refuses to resume a bot that is not halted", async () => {
    await openPosition("100");
    await expect(run((bot) => bot.resume(ACTOR))).rejects.toThrow(/only a halted bot/);
  });
});

describe("close (section 8.5)", () => {
  it("releases capital through the capital module, which owns the stopped transition", async () => {
    await openPosition("100");
    const result = await run((bot) => bot.close(ACTOR));

    expect(result.status).toBe("stopped");
    const row = await db.botInstances.findOne({ id: BOT_ID });
    expect(row!.status).toBe("stopped");
    const ledger = await db.capitalLedger.findOne({ account_label: "main", asset: "USDT" });
    expect(ledger!.total_allocated).toBe(ZERO);

    const released = await db.auditLog.findMany({ where: { action: "capital.released" } });
    expect(released).toHaveLength(1);
  });

  it("cancels open orders before returning the capital", async () => {
    await openPosition("100");
    await run((bot) => bot.onPriceUpdate(priceAt("95")));
    const resting = exchange.placed[1]!.clientOrderId;

    await run((bot) => bot.close(ACTOR));
    expect(exchange.cancelled).toContain(resting);
    const snapshot = await run((bot) => bot.snapshot());
    expect(snapshot.state.openOrderIds).toEqual([]);
  });

  it("cannot release the same capital twice", async () => {
    await openPosition("100");
    await run((bot) => bot.close(ACTOR));
    await expect(run((bot) => bot.close(ACTOR))).rejects.toThrow(/already stopped/);
    const ledger = await db.capitalLedger.findOne({ account_label: "main", asset: "USDT" });
    expect(ledger!.total_allocated).toBe(ZERO);
  });

  it("closes a halted bot, moving it from halted to stopped", async () => {
    await openPosition("100");
    await run((bot) => bot.onPriceUpdate(priceAt("79")));
    expect((await db.botInstances.findOne({ id: BOT_ID }))!.status).toBe("halted");

    await run((bot) => bot.close(ACTOR));
    expect((await db.botInstances.findOne({ id: BOT_ID }))!.status).toBe("stopped");
  });

  it("never writes stopped from the Durable Object's own mirror", async () => {
    // The guard on the settled ownership split: even a halt on a bot that was
    // somehow already stopped must not rewrite that column.
    await openPosition("100");
    await run((bot) => bot.close(ACTOR));
    await expect(run((bot) => bot.halt("manual", "after close", ACTOR))).rejects.toThrow(
      /stopped bot cannot be halted/,
    );
  });
});

describe("durability", () => {
  it("recovers its full state after the object is evicted", async () => {
    await openPosition("100");
    await run((bot) => bot.onPriceUpdate(priceAt("95")));

    const { evictDurableObject } = await import("cloudflare:test");
    const { botStub } = await import("./test-helpers");
    await evictDurableObject(botStub(objectName));

    const snapshot = await run((bot) => bot.snapshot());
    expect(snapshot.state.status).toBe("running");
    expect(snapshot.state.position.quantity).toBe(m("1"));
    expect(snapshot.state.position.averageEntryPrice).toBe(m("100"));
    expect(snapshot.state.nextSequence).toBe(2);
    expect(snapshot.orders).toHaveLength(2);
  });

  it("keeps money exact across storage, past what a JS number can hold", async () => {
    // 2^53 is 9007199254740992, i.e. 90071992.54740992 at scale 8. A quantity
    // near it round-trips through DO storage but would be corrupted by a direct
    // D1 integer read, which is why /src/db casts to TEXT.
    await run((bot) => bot.create(creation()));
    await run((bot) => bot.start(ACTOR));
    await run((bot) => bot.onPriceUpdate(priceAt("100")));
    const id = exchange.placed[0]!.clientOrderId;
    await run((bot) => bot.onFill(id, exchange.fillFor(id, { quantity: m("0.00000001") })));

    const snapshot = await run((bot) => bot.snapshot());
    expect(snapshot.state.position.quantity).toBe(1n);
    const trade = (await db.trades.findMany({ where: { bot_instance_id: BOT_ID } }))[0]!;
    expect(trade.quantity).toBe(1n);
  });

  it("refuses to operate on state written by a schema version it cannot read", async () => {
    await run((bot) => bot.create(creation()));
    await inBot(objectName, async (_instance, state) => {
      const config = await state.storage.get<Record<string, unknown>>("config");
      await state.storage.put("config", { ...config!, schemaVersion: 99 });
    });

    await expect(run((bot) => bot.snapshot())).rejects.toThrow(/schemaVersion 99/);
  });
});

// ---------------------------------------------------------------------------
// Section 5.4: this object cannot reach the exchange without budget
// ---------------------------------------------------------------------------

/**
 * A limiter that records every request and can be told to refuse.
 *
 * `refuse` is a predicate rather than a set of priorities, because WHERE in a
 * pass the refusal lands changes what should happen. A throttled filter read
 * costs nothing -- no sequence, no attempt record -- while a throttled
 * `placeOrder` has already taken both. Refusing "everything routine" would only
 * ever exercise the first, since the filter read comes first.
 */
class SpyLimiter implements RateLimiterPort {
  readonly requests: AcquireRequest[] = [];
  refuse: (request: AcquireRequest) => boolean = () => false;

  async acquire(request: AcquireRequest): Promise<AcquireResult> {
    this.requests.push(request);
    if (this.refuse(request)) {
      return {
        granted: false,
        reason: "weight_exceeds_limit",
        ticketId: null,
        retryAfterMs: 0,
        queuePosition: 0,
        usedWeight: 1200,
        remainingForPriority: 0,
        at: clock,
      };
    }
    return {
      granted: true,
      weight: request.weight,
      usedWeight: request.weight,
      remainingForPriority: 1000,
      at: clock,
    };
  }

  async release(): Promise<void> {}
}

let spy: SpyLimiter;

/** `run`, but against a spy limiter so priorities and refusals are observable. */
async function runSpied<T>(body: (bot: BotInstance) => Promise<T>): Promise<T> {
  return await inBot(objectName, async (instance) => {
    instance.attach({
      db,
      exchange,
      now: () => clock,
      newId: () => {
        idCounter += 1;
        return `generated-${idCounter}`;
      },
      limiterFor: () => spy,
      sleep: async () => undefined,
    });
    return await body(instance);
  });
}

describe("wired to the account's limiter (section 5.4)", () => {
  beforeEach(() => {
    spy = new SpyLimiter();
  });

  it("uses the RATE_LIMITER binding for its own account when nothing is injected", async () => {
    // No `limiterFor` here, deliberately. This is the production path: the
    // object resolves the account's limiter from the binding itself, so routing
    // through the budget is not something a caller can forget to wire.
    const account = "binding-check";
    await seedPlaceholderTotalBalance(
      db,
      { accountLabel: account, asset: "USDT", totalBalance: m("10000"), note: "test fixture" },
      { actor: ACTOR, now: T0 },
    );

    await inBot(objectName, async (instance) => {
      instance.attach({ db, exchange, now: () => clock, newId: () => "generated-x" });
      await instance.create(creation({ accountLabel: account }));
      await instance.start(ACTOR);
      await instance.onPriceUpdate(priceAt("100"));
    });

    expect(exchange.placed).toHaveLength(1);

    // The real Durable Object named after the ACCOUNT recorded the spend: one
    // exchangeInfo (20) plus one placeOrder (1).
    await inLimiter(account, async (limiter) => {
      const stats = await limiter.stats();
      expect(stats.usedWeight).toBe(
        BINANCE_METHOD_WEIGHTS.getSymbolFilters + BINANCE_METHOD_WEIGHTS.placeOrder,
      );
    });
  });

  it("asks for budget BEFORE placing an entry order, at routine priority", async () => {
    await runSpied((bot) => bot.create(creation()));
    await runSpied((bot) => bot.start(ACTOR));
    await runSpied((bot) => bot.onPriceUpdate(priceAt("100")));

    expect(spy.requests.map((request) => [request.priority, request.weight])).toEqual([
      // The filter read and the order itself are both entry work, so both are
      // routine and may only draw on `limit - reserveForRiskExit`.
      ["routine", BINANCE_METHOD_WEIGHTS.getSymbolFilters],
      ["routine", BINANCE_METHOD_WEIGHTS.placeOrder],
    ]);
  });

  it("asks at risk-exit priority for the cancellations a halt issues", async () => {
    await openPosition("100");
    await run((bot) => bot.onPriceUpdate(priceAt("94")));
    const placed = exchange.placed.length;
    expect(placed).toBeGreaterThan(1);

    spy.requests.length = 0;
    await runSpied((bot) => bot.halt("manual", "risk check", ACTOR));

    // Section 7.2's halt cancels every open order, and every one of those goes
    // out on the reserved slice -- which is the whole point of the reserve.
    expect(spy.requests).not.toHaveLength(0);
    expect(spy.requests.every((request) => request.priority === "risk-exit")).toBe(true);
    expect(spy.requests.every((request) => request.weight === BINANCE_METHOD_WEIGHTS.cancelOrder)).toBe(
      true,
    );
  });

  it("asks at risk-exit priority for the take-profit exit and its filter read", async () => {
    await openPosition("100");
    spy.requests.length = 0;

    // Above average entry by the configured take-profit percentage.
    await runSpied((bot) => bot.onPriceUpdate(priceAt("103")));

    expect(spy.requests).not.toHaveLength(0);
    // Section 6.3 step 4 makes this the mandatory exit. Note the FILTER read is
    // risk-exit too: an exit that cannot be constructed cannot be placed, so
    // making that read routine would starve the exit through the back door.
    expect(spy.requests.every((request) => request.priority === "risk-exit")).toBe(true);
  });
});

describe("a refused budget (section 5.4) is not a halt", () => {
  beforeEach(() => {
    spy = new SpyLimiter();
  });

  /** Refuse only the order itself, letting the filter read through. */
  const refusePlacement = (request: AcquireRequest): boolean =>
    request.weight === BINANCE_METHOD_WEIGHTS.placeOrder;

  it("skips the entry, records why, and leaves the bot running", async () => {
    await runSpied((bot) => bot.create(creation()));
    await runSpied((bot) => bot.start(ACTOR));

    spy.refuse = () => true;
    const result = await runSpied((bot) => bot.onPriceUpdate(priceAt("100")));

    // NOT halted. The exchange refused nothing -- this system declined to ask --
    // and turning backpressure into an incident needing human review to undo is
    // exactly what step 6's decision 8 would have done with any other failure.
    expect(result.status).toBe("running");
    expect(result.action).toBe("throttled");
    expect(exchange.placed).toHaveLength(0);

    const row = await db.botInstances.findOne({ id: BOT_ID });
    expect(row!.status).toBe("running");
    expect(row!.halt_reason).toBeNull();

    const alerts = await db.alerts.findMany({ where: { alert_type: "order_throttled" } });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.severity).toBe("warning");
  });

  it("costs nothing at all when the refusal lands on the filter read", async () => {
    // The cheapest place to be throttled, and worth pinning: the filter read
    // happens before any sequence is taken or attempt recorded, so a refusal
    // there leaves no trace to clean up and burns no clientOrderId.
    await runSpied((bot) => bot.create(creation()));
    await runSpied((bot) => bot.start(ACTOR));
    spy.refuse = () => true;
    await runSpied((bot) => bot.onPriceUpdate(priceAt("100")));

    const snapshot = await runSpied((bot) => bot.snapshot());
    expect(snapshot.state.nextSequence).toBe(0);
    const attempts = await inBot(objectName, async (_bot, state) => {
      const entries = await state.storage.list({ prefix: "attempt:" });
      return [...entries.values()];
    });
    expect(attempts).toHaveLength(0);
  });

  it("marks the attempt FAILED when the refusal lands on the order itself", async () => {
    await runSpied((bot) => bot.create(creation()));
    await runSpied((bot) => bot.start(ACTOR));
    // Filters are read successfully; only the placement is refused, which is
    // the case where a sequence and an attempt record already exist.
    spy.refuse = refusePlacement;
    const result = await runSpied((bot) => bot.onPriceUpdate(priceAt("100")));
    expect(result).toMatchObject({ status: "running", action: "throttled" });

    // The distinction from `transport`, which is the reason `rate_limited`
    // needed to be its own failure kind. A transport failure leaves the attempt
    // `attempting` because the order may be resting on the book; nothing was
    // sent here, so leaving it unresolved would have reconciliation chasing an
    // order that never existed.
    const attempts = await inBot(objectName, async (_bot, state) => {
      const entries = await state.storage.list<{ state: string; failureReason?: string }>({
        prefix: "attempt:",
      });
      return [...entries.values()];
    });
    expect(attempts).toHaveLength(1);
    expect(attempts[0]!.state).toBe("failed");
    // The recorded reason says the thing that matters about this failure kind.
    expect(attempts[0]!.failureReason).toMatch(/not sent/i);
  });

  it("retries on the next price update once budget is available again", async () => {
    await runSpied((bot) => bot.create(creation()));
    await runSpied((bot) => bot.start(ACTOR));

    spy.refuse = refusePlacement;
    expect((await runSpied((bot) => bot.onPriceUpdate(priceAt("100")))).action).toBe("throttled");

    // `decide()` is a pure function of the position and the price, so the base
    // order is still the right action and the bot simply does it now.
    spy.refuse = () => false;
    const result = await runSpied((bot) => bot.onPriceUpdate(priceAt("100")));
    expect(result.action).toBe("placed-base");
    expect(exchange.placed).toHaveLength(1);
    // A fresh sequence, not a re-send of the throttled id (step 6, decision 8).
    expect(exchange.placed[0]!.clientOrderId).toBe(`v1-${BOT_ID}-1`);
  });

  it("raises a cancel_failed alert when a halt's cancellation is throttled", async () => {
    await openPosition("100");
    // A second, UNFILLED order, so the halt has something to cancel.
    // `openPosition` fills the base order completely, which takes it out of
    // `openOrderIds` -- a halt then cancels nothing and the test would pass
    // without exercising the path at all.
    await run((bot) => bot.onPriceUpdate(priceAt("94")));
    spy.refuse = (request) => request.priority === "risk-exit";

    const result = await runSpied((bot) => bot.halt("manual", "risk check", ACTOR));

    // The halt still happens -- the bot is marked halted first (step 6,
    // decision 2) -- but the order it could not cancel is reported, and step
    // 7's reconciliation ingests `cancel_failed` as meaningful drift.
    expect(result.status).toBe("halted");
    const alerts = await db.alerts.findMany({ where: { alert_type: "cancel_failed" } });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.message).toContain("rate_limited");
  });
});
