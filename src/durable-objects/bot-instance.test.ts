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
import { alertRow, freshDatabase } from "../db/test-helpers";
import { GlobalKillSwitchError, tripGlobalKillSwitch } from "../reconciliation/kill-switch";
import { fromDecimalString as m, toDecimalString, ZERO } from "../shared/money";
import { TERMINAL_STATES } from "../shared/order-state";
import type { Price } from "../shared/exchange-client";
import type { DcaParams } from "../strategies/dca";
import type { BotInstance, CreateDcaBotRequest, PipelineResult } from "./bot-instance";
import { BotInstanceError } from "./bot-instance";
import { FakeExchange, TEST_PAIR } from "./fake-exchange";
import { inBot, inLimiter, noopFeed, rateLimiterStub, recordingFeed } from "./test-helpers";
import type { PriceFeedPort } from "./price-feed";
import type { AcquireRequest, AcquireResult } from "./rate-limiter";
import { BINANCE_METHOD_WEIGHTS, type RateLimiterPort } from "../exchange/rate-limited";

/**
 * The fake clock's origin, and it is deliberately in the FUTURE.
 *
 * Step 20 arms a real Durable Object alarm, and the runtime fires an alarm
 * whose time has passed as soon as it is set. With the old origin (2025) every
 * armed alarm was already overdue the instant it was written, so the runtime
 * raced each test with a spurious poll -- sometimes against this file's
 * injected clock and exchange, sometimes against a re-created instance with
 * neither. Every assertion below is relative to `T0`, so moving it forward
 * costs nothing and makes the alarm fire only when a test fires it.
 *
 * `FakeExchange.now` is set to match in `beforeEach`; the two were equal by
 * construction before and the trade-timestamp assertions rely on it.
 */
const T0 = 1_900_000_000_000;
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
async function run<T>(
  body: (bot: BotInstance) => Promise<T>,
  feed: PriceFeedPort = noopFeed,
  /**
   * Which Durable Object to run in. Defaults to this test's own, which is what
   * every test but one wants. The exception is step 27's per-bot alert scoping,
   * which has to drive a SECOND bot against the same database to prove that
   * resuming one does not touch the other's rows -- a property no single-object
   * test can observe.
   */
  name: string = objectName,
): Promise<T> {
  return await inBot(name, async (instance) => {
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
      feedFor: () => feed,
    });
    return await body(instance);
  });
}

beforeEach(async () => {
  db = await freshDatabase();
  exchange = new FakeExchange();
  exchange.now = T0;
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

  /**
   * The loss-causing step, gated.
   *
   * Reproduces what happened to two live testnet bots: reconciliation found the
   * local record behind the exchange's real fill count, halted the bot, and the
   * halt's own cancel sweep then `closeOrder`d that record at the understated
   * number. A terminal order can never accept a fill afterwards, so the fills
   * the bot had not yet observed became permanently unattributable -- the poll
   * could no longer apply them, and `applyMissedFills` could not reach an order
   * that had left `openOrderIds`.
   *
   * `#foldTerminalState` already refuses exactly this for the poll's trigger.
   * These assert `#recordCancellation` now refuses it for the halt's.
   */
  it("does NOT close an order cancelled with more filled than it recorded", async () => {
    await openPosition("100");
    await run((bot) => bot.onPriceUpdate(priceAt("95")));
    const resting = exchange.placed[1]!.clientOrderId;
    // The exchange saw 0.25 fill in the window before the cancel landed; this
    // bot recorded none of it, and the cancellation response carries no trade
    // id to apply it with.
    exchange.fillOnCancel = m("0.25");

    const result = await run((bot) => bot.halt("manual", "operator", ACTOR));

    // The halt itself is correct and is NOT swallowed by the refusal.
    expect(result.status).toBe("halted");
    expect((await db.botInstances.findOne({ id: BOT_ID }))!.status).toBe("halted");

    const snapshot = await run((bot) => bot.snapshot());
    const order = snapshot.orders.find((each) => each.clientOrderId === resting)!;

    // THE FIX. Terminal at 0 filled is what made the understatement permanent.
    expect(order.state).not.toBe("cancelled");
    expect(order.state).toBe("pending");
    // And the record still ACCEPTS a fill, which is the whole point of not
    // closing it: `isTerminal` false means `applyFill` will not throw
    // `fill_after_terminal` when the real execution finally arrives with its id.
    expect(TERMINAL_STATES).not.toContain(order.state);

    // Left where the poll can still reach it. The poll only reads what is on
    // this list, and a halted bot is still polled (`#pollArmed` excludes only
    // `stopped`), so this is what makes the refusal a deferral rather than a
    // dead end.
    expect(snapshot.state.openOrderIds).toEqual([resting]);
    // The D1 mirror is not flipped either: `#mirrorOrderUpdate` is downstream
    // of the gate.
    expect((await db.orders.findOne({ id: resting }))!.status).toBe("pending");

    // Still signalled, through the alert type this condition already had.
    const alerts = await db.alerts.findMany({ where: { alert_type: "cancel_fill_discrepancy" } });
    expect(alerts).toHaveLength(1);
  });

  it("still closes a cancelled order normally when the fill counts agree", async () => {
    // The common case, and the one that must not regress: nothing filled behind
    // the bot's back, so there is nothing to lose by closing the record.
    await openPosition("100");
    await run((bot) => bot.onPriceUpdate(priceAt("95")));
    const resting = exchange.placed[1]!.clientOrderId;
    expect(exchange.fillOnCancel).toBe(ZERO);

    await run((bot) => bot.halt("manual", "operator", ACTOR));

    const snapshot = await run((bot) => bot.snapshot());
    const order = snapshot.orders.find((each) => each.clientOrderId === resting)!;
    expect(order.state).toBe("cancelled");
    expect(snapshot.state.openOrderIds).toEqual([]);
    expect((await db.orders.findOne({ id: resting }))!.status).toBe("cancelled");
    expect(await db.alerts.count({ alert_type: "cancel_fill_discrepancy" })).toBe(0);
  });

  it("lets the poll finish what the refusal deferred: apply the fill, then close", async () => {
    // What the refusal is FOR. Leaving the record open is only worth anything
    // if the missing execution can still be applied afterwards -- so this drives
    // the repair the old code made impossible, end to end.
    await openPosition("100");
    await run((bot) => bot.onPriceUpdate(priceAt("95")));
    const resting = exchange.placed[1]!.clientOrderId;
    const placed = exchange.resting.get(resting)!;
    exchange.fillOnCancel = m("0.25");

    await run((bot) => bot.halt("manual", "operator", ACTOR));

    // The venue now hands over the same execution WITH its own trade id, which
    // is the one thing the cancellation response could not supply.
    exchange.fillsByOrder.set(resting, [
      {
        fillId: "gemini-tid-9001",
        price: placed.request.price,
        quantity: m("0.25"),
        feeAmount: ZERO,
        feeAsset: "USDT",
        executedAt: T0 + 1000,
      },
    ]);

    const pass = await run((bot) => bot.checkOpenOrders(ACTOR));

    expect(pass.applied).toEqual([
      {
        clientOrderId: resting,
        fillId: "gemini-tid-9001",
        quantity: toDecimalString(m("0.25")),
        price: toDecimalString(placed.request.price),
      },
    ]);
    // Applied by real id, and only NOW closed -- by `#foldTerminalState`, whose
    // own gate passes because the two counts finally agree.
    expect(pass.closed).toEqual([resting]);

    const snapshot = await run((bot) => bot.snapshot());
    const order = snapshot.orders.find((each) => each.clientOrderId === resting)!;
    expect(order.filledQuantity).toBe(m("0.25"));
    expect(order.state).toBe("cancelled");
    expect(snapshot.state.openOrderIds).toEqual([]);
    // The bot never left `halted`: observing is not resuming.
    expect(pass.status).toBe("halted");
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
        feedFor: () => noopFeed,
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

    const audit = await db.auditLog.findMany({ where: { action: "bot.resumed" } });
    expect(audit[0]!.actor).toBe(ACTOR);
  });

  it("clears halt_reason and halted_at, so a resolved failure stops reading as current", async () => {
    // This REVERSES the previous behaviour, which kept the reason on the row
    // and was asserted here as deliberate ("migration 0001's CHECK is
    // one-directional"). The CHECK does permit keeping it -- but `halt_reason`
    // is a current-state column that the dashboard renders, so a running bot
    // kept advertising a failure that had already been fixed. A real bot sat
    // `running` for hours showing an `order_rejected ... MissingAccounts` that
    // no longer applied.
    await openPosition("100");
    await run((bot) => bot.halt("manual", "operator review", ACTOR));

    const halted = await db.botInstances.findOne({ id: BOT_ID });
    expect(halted!.halt_reason).toMatch(/manual/);
    expect(halted!.halted_at).not.toBeNull();

    await run((bot) => bot.resume(ACTOR));

    const row = await db.botInstances.findOne({ id: BOT_ID });
    expect(row!.status).toBe("running");
    expect(row!.halt_reason).toBeNull();
    expect(row!.halted_at).toBeNull();
  });

  it("keeps the reason in the audit log, which is where history belongs", async () => {
    // Clearing the column must not lose why the bot stopped. The append-only
    // log is the right home for that: a status column would be overwritten by
    // the next halt anyway.
    await openPosition("100");
    await run((bot) => bot.halt("manual", "operator review", ACTOR));
    await run((bot) => bot.resume(ACTOR));

    const audit = await db.auditLog.findMany({ where: { action: "bot.resumed" } });
    // `details_json` is decoded by the repository layer, not a raw string.
    const details = audit[0]!.details_json as unknown as Record<string, unknown>;
    expect(String(details["previous_halt_reason"])).toMatch(/manual/);
    expect(details["previous_halted_at"]).not.toBeNull();
  });

  it("clears the in-object state too, not just the D1 mirror", async () => {
    // The row and the Durable Object's own storage must agree. A snapshot that
    // still carried the old reason would put it straight back on the next
    // mirror write.
    await openPosition("100");
    await run((bot) => bot.halt("manual", "operator review", ACTOR));
    await run((bot) => bot.resume(ACTOR));

    const snapshot = await run((bot) => bot.snapshot());
    expect(snapshot.state.haltReason).toBeNull();
    expect(snapshot.state.haltedAt).toBeNull();
  });

  it("refuses to resume a bot that is not halted", async () => {
    await openPosition("100");
    await expect(run((bot) => bot.resume(ACTOR))).rejects.toThrow(/only a halted bot/);
  });

  // -------------------------------------------------------------------------
  // Resolving the halt ALERT, step 27
  // -------------------------------------------------------------------------
  //
  // The row-level half of step 16's bug 3. That fixed `halt_reason`, the
  // current-state column a running bot kept advertising a fixed failure in; the
  // `halt_*` alert row for the same halt was left `unresolved` forever, which is
  // where an operator counting open criticals actually looks.

  it("resolves the halt alert when the bot successfully resumes", async () => {
    await openPosition("100");
    await run((bot) => bot.halt("order_rejected", "MissingAccounts", ACTOR));

    // Open while the bot is halted: the condition genuinely applies.
    expect(await db.alerts.count({ alert_type: "halt_order_rejected", resolved: false })).toBe(1);

    await run((bot) => bot.resume(ACTOR));

    expect(await db.alerts.count({ alert_type: "halt_order_rejected", resolved: false })).toBe(0);
    // Resolved, NOT deleted. The halt happened and the history says so.
    expect(await db.alerts.count({ alert_type: "halt_order_rejected", resolved: true })).toBe(1);

    // And the resume's own audit entry records which rows it closed.
    const audit = await db.auditLog.findMany({ where: { action: "bot.resumed" } });
    const details = audit[0]!.details_json as unknown as Record<string, unknown>;
    expect(details["resolved_halt_alert_ids"]).toHaveLength(1);
  });

  it("resolves nothing when the resume is REFUSED and the bot stays halted", async () => {
    // The other side of "on a SUCCESSFUL resume", and the reason the resolve
    // call sits after the status writes rather than at the top of `#resumePass`.
    // A latched global kill switch refuses the resume; the bot is still halted,
    // so its critical must still be open. Closing it here would take the alert
    // away from an operator whose bot did not actually come back.
    await openPosition("100");
    await run((bot) => bot.halt("stop_loss", "drawdown breached", ACTOR));
    await tripGlobalKillSwitch(db, {
      reason: "venue outage",
      actor: ACTOR,
      now: clock,
      haltBot: async () => {}, // the bot under test is already halted
      newId: () => `kill-${(idCounter += 1)}`,
    });

    await expect(run((bot) => bot.resume(ACTOR))).rejects.toBeInstanceOf(GlobalKillSwitchError);

    const row = await db.botInstances.findOne({ id: BOT_ID });
    expect(row!.status).toBe("halted");
    expect(await db.alerts.count({ alert_type: "halt_stop_loss", resolved: false })).toBe(1);
  });

  it("does NOT resolve this bot's other alerts, which a resume does not address", async () => {
    // The scope question, and `cancel_failed` is the one that matters: it is
    // raised BY the halt path, so it looks like part of the same incident. It is
    // not. It means an order may still be live on the exchange, which resuming
    // does not cancel -- and reconciliation owns that row through
    // INGESTED_ALERT_TYPES, so closing it here would give one row two owners.
    await openPosition("100");
    await run((bot) => bot.halt("manual", "operator review", ACTOR));

    const untouched = [
      // Same source, same bot, raised during the halt itself.
      { alert_type: "cancel_failed", source: "bot-instance" },
      // Same source, same bot, owned by the poll's own resolve half.
      { alert_type: "poll_blind", source: "bot-instance" },
      { alert_type: "unattributable_fill", source: "bot-instance" },
      // Reconciliation's, ingested. `order_state_drift` USED TO BE IN THIS LIST
      // and moved to "refuses to resume while an order-state-drift alert stands"
      // below at step 57 (fix 2): it is now a REFUSAL condition, so a resume
      // that reaches the point of resolving anything can no longer have one
      // open. The property this test asserted about it -- that a resume does not
      // close it -- is asserted there instead, and more strongly.
      { alert_type: "cancel_fill_discrepancy", source: "bot-instance" },
      // A DIFFERENT writer's row about this bot, excluded twice over.
      { alert_type: "price_feed_fanout_failed", source: "price-feed" },
    ];
    for (const [index, alert] of untouched.entries()) {
      await db.alerts.insert(
        alertRow({ id: `unrelated-${index}`, bot_instance_id: BOT_ID, ...alert }),
      );
    }

    await run((bot) => bot.resume(ACTOR));

    expect(await db.alerts.count({ alert_type: "halt_manual", resolved: false })).toBe(0);
    for (const alert of untouched) {
      expect(await db.alerts.count({ alert_type: alert.alert_type, resolved: false })).toBe(1);
    }
  });

  /**
   * Step 57, fix 2. The scenario found on two real bots: reconciliation halted
   * them for a meaningful drift finding, an operator resumed both, and resuming
   * cleared the halt and the halt alert while correcting nothing.
   */
  it("refuses to resume while an order-state-drift alert stands", async () => {
    await openPosition("100");
    // Exactly how reconciliation halts a bot: through `haltBot`, which calls
    // `halt("manual", detail, "reconciliation")`. There is no drift HaltReason --
    // which is the whole reason the gate reads the alert and not the reason.
    await run((bot) =>
      bot.halt("manual", "reconciliation run r-1 found meaningful drift: ...", "reconciliation"),
    );
    await db.alerts.insert(
      alertRow({
        id: "drift-1",
        bot_instance_id: BOT_ID,
        alert_type: "reconciliation_meaningful_order_state_drift",
        source: "reconciliation",
      }),
    );

    await expect(run((bot) => bot.resume(ACTOR))).rejects.toMatchObject({
      code: "position_unverified",
    });

    // The refusal happens BEFORE anything is written, so the bot is still halted
    // in its own state and in D1 -- a gate that flipped the status first would
    // last exactly as long as it takes to click resume twice.
    const snapshot = await run((bot) => bot.snapshot());
    expect(snapshot.state.status).toBe("halted");
    expect((await db.botInstances.findOne({ id: BOT_ID }))!.status).toBe("halted");
    // And the halt alert is NOT closed, which is what made the live incident
    // invisible afterwards: an operator counting open criticals saw nothing.
    expect(await db.alerts.count({ alert_type: "halt_manual", resolved: false })).toBe(1);
    // The drift row stands too. Resume cannot dismiss it by running.
    expect(await db.alerts.count({ id: "drift-1", resolved: false })).toBe(1);
  });

  it("refuses on the bot's OWN drift alert too, not just reconciliation's", async () => {
    // `#onOrderStateError` writes an untiered `order_state_drift` when the order
    // state machine refuses a fill. Same condition, different writer -- which is
    // why the gate is not scoped by `source`.
    await openPosition("100");
    await run((bot) => bot.halt("manual", "operator review", ACTOR));
    await db.alerts.insert(
      alertRow({
        id: "drift-own",
        bot_instance_id: BOT_ID,
        alert_type: "order_state_drift",
        source: "bot-instance",
      }),
    );

    await expect(run((bot) => bot.resume(ACTOR))).rejects.toMatchObject({
      code: "position_unverified",
    });
  });

  it("resumes once the drift alert is resolved by its owner", async () => {
    // The gate is a latch on a CONDITION, not a permanent brand. Whatever closes
    // the row -- reconciliation no longer re-finding it, or the repair path --
    // restores the resume, and resume itself never closes it.
    await openPosition("100");
    await run((bot) => bot.halt("manual", "reconciliation run r-1 found meaningful drift: ...", "reconciliation"));
    await db.alerts.insert(
      alertRow({
        id: "drift-2",
        bot_instance_id: BOT_ID,
        alert_type: "reconciliation_meaningful_order_state_drift",
        source: "reconciliation",
      }),
    );
    await expect(run((bot) => bot.resume(ACTOR))).rejects.toMatchObject({
      code: "position_unverified",
    });

    await db.alerts.update({ id: "drift-2" }, { resolved: true });

    const result = await run((bot) => bot.resume(ACTOR));
    expect(result).toMatchObject({ status: "running", action: "resumed" });
  });

  it("does not refuse on ANOTHER bot's drift alert", async () => {
    // The row is scoped to its bot. A drift finding elsewhere on the account is
    // reconciliation's business and not this bot's resume.
    await openPosition("100");
    await run((bot) => bot.halt("manual", "operator review", ACTOR));
    await db.alerts.insert(
      alertRow({
        id: "drift-other",
        bot_instance_id: null,
        alert_type: "reconciliation_meaningful_order_state_drift",
        source: "reconciliation",
      }),
    );

    const result = await run((bot) => bot.resume(ACTOR));
    expect(result).toMatchObject({ status: "running", action: "resumed" });
  });

  it("resumes normally for every ORDINARY halt reason", async () => {
    // The majority path, and the one that must not regress. Every reason in the
    // `HaltReason` union that a bot can actually be sitting on, resumed with no
    // drift row present. `take_profit` and `breakout_take_profit` are grid-only
    // reasons but `halt` takes the union, so driving them here proves the gate
    // does not consult the reason at all -- which is exactly its design.
    const ordinary = [
      "stop_loss",
      "manual",
      "order_rejected",
      "unhandled_error",
      "take_profit_reached",
      "take_profit",
      "breakout_take_profit",
    ] as const;

    await openPosition("100");
    for (const reason of ordinary) {
      await run((bot) => bot.halt(reason, `halted for ${reason}`, ACTOR));
      const result = await run((bot) => bot.resume(ACTOR));
      expect(result).toMatchObject({ status: "running", action: "resumed" });
    }
  });

  it("resolves per bot: resuming one leaves another bot's halt alert open", async () => {
    // Two halted bots, one resumed. The other is still halted and its critical
    // must still say so -- a resolve scoped only by `source` and alert type would
    // close both, and on an account halted by the circuit breaker that is every
    // bot on it going quiet at once because one was reviewed.
    const OTHER_ID = "dca-btc-2";
    const otherObject = `${objectName}-other`;
    const inOther = <T>(body: (bot: BotInstance) => Promise<T>) => run(body, noopFeed, otherObject);

    await openPosition("100");
    await run((bot) => bot.halt("manual", "operator review", ACTOR));

    await inOther((bot) => bot.create(creation({ botInstanceId: OTHER_ID })));
    await inOther((bot) => bot.halt("manual", "the other operator review", ACTOR));

    expect(await db.alerts.count({ alert_type: "halt_manual", resolved: false })).toBe(2);

    await run((bot) => bot.resume(ACTOR));

    const open = await db.alerts.findMany({
      where: { alert_type: "halt_manual", resolved: false },
    });
    expect(open).toHaveLength(1);
    expect(open[0]!.bot_instance_id).toBe(OTHER_ID);
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
      feedFor: () => noopFeed,
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
      instance.attach({ db, exchange, now: () => clock, newId: () => "generated-x", feedFor: () => noopFeed });
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

describe("price feed wiring (step 14 D)", () => {
  it("subscribes on start, with the bot's id, exchange, and pair", async () => {
    const feed = recordingFeed();
    await run((bot) => bot.create(creation()), feed.port);
    await run((bot) => bot.start(ACTOR), feed.port);

    expect(feed.subscribes).toEqual([
      { botInstanceId: BOT_ID, config: { exchange: "binance", pair: TEST_PAIR } },
    ]);
    expect(feed.unsubscribes).toEqual([]);
  });

  it("unsubscribes on a manual halt", async () => {
    const feed = recordingFeed();
    await run((bot) => bot.create(creation()), feed.port);
    await run((bot) => bot.start(ACTOR), feed.port);
    await run((bot) => bot.halt("manual", "operator review", ACTOR), feed.port);

    expect(feed.unsubscribes).toEqual([BOT_ID]);
  });

  it("unsubscribes on a stop-loss halt driven by a price update", async () => {
    const feed = recordingFeed();
    await run((bot) => bot.create(creation()), feed.port);
    await run((bot) => bot.start(ACTOR), feed.port);
    await run((bot) => bot.onPriceUpdate(priceAt("100")), feed.port); // base buy
    const base = exchange.placed[0]!.clientOrderId;
    await run((bot) => bot.onFill(base, exchange.fillFor(base)), feed.port);
    // A price far below the 20% stop-loss from entry halts the bot.
    const result = await run((bot) => bot.onPriceUpdate(priceAt("70")), feed.port);

    expect(result.status).toBe("halted");
    expect(feed.unsubscribes).toEqual([BOT_ID]);
  });

  it("re-subscribes on resume after a halt", async () => {
    const feed = recordingFeed();
    await run((bot) => bot.create(creation()), feed.port);
    await run((bot) => bot.start(ACTOR), feed.port);
    await run((bot) => bot.halt("manual", "review", ACTOR), feed.port);
    await run((bot) => bot.resume(ACTOR), feed.port);

    // Two subscribes (start + resume), one unsubscribe (the halt in between).
    expect(feed.subscribes.map((s) => s.botInstanceId)).toEqual([BOT_ID, BOT_ID]);
    expect(feed.unsubscribes).toEqual([BOT_ID]);
  });

  it("unsubscribes on close (which can leave running directly)", async () => {
    const feed = recordingFeed();
    await run((bot) => bot.create(creation()), feed.port);
    await run((bot) => bot.start(ACTOR), feed.port);
    await run((bot) => bot.close(ACTOR), feed.port);

    expect(feed.unsubscribes).toEqual([BOT_ID]);
  });

  it("does NOT unsubscribe on a DCA take-profit that auto-restarts (it stays running)", async () => {
    const feed = recordingFeed();
    await run((bot) => bot.create(creation({ params: { ...params, autoRestart: true } })), feed.port);
    await run((bot) => bot.start(ACTOR), feed.port); // subscribe
    await run((bot) => bot.onPriceUpdate(priceAt("100")), feed.port);
    const base = exchange.placed[0]!.clientOrderId;
    await run((bot) => bot.onFill(base, exchange.fillFor(base)), feed.port);
    await run((bot) => bot.onPriceUpdate(priceAt("102")), feed.port); // take-profit exit
    const exit = exchange.placed[1]!.clientOrderId;
    const result = await run((bot) => bot.onFill(exit, exchange.fillFor(exit)), feed.port);

    // The cycle completed and the bot stayed running — so it must NOT have left
    // the feed. Only the initial start subscribed; nothing unsubscribed.
    expect(result.status).toBe("running");
    expect(feed.subscribes).toHaveLength(1);
    expect(feed.unsubscribes).toEqual([]);
  });

  it("DOES unsubscribe on a DCA take-profit that halts (autoRestart off)", async () => {
    const feed = recordingFeed();
    await run((bot) => bot.create(creation({ params: { ...params, autoRestart: false } })), feed.port);
    await run((bot) => bot.start(ACTOR), feed.port);
    await run((bot) => bot.onPriceUpdate(priceAt("100")), feed.port);
    const base = exchange.placed[0]!.clientOrderId;
    await run((bot) => bot.onFill(base, exchange.fillFor(base)), feed.port);
    await run((bot) => bot.onPriceUpdate(priceAt("102")), feed.port);
    const exit = exchange.placed[1]!.clientOrderId;
    const result = await run((bot) => bot.onFill(exit, exchange.fillFor(exit)), feed.port);

    // take-profit-off halts via #halt, which is the unsubscribe funnel.
    expect(result.status).toBe("halted");
    expect(feed.unsubscribes).toEqual([BOT_ID]);
  });
});

// ---------------------------------------------------------------------------
// applyMissedFills: the order-state-drift repair (step 18)
// ---------------------------------------------------------------------------

describe("applyMissedFills (the human correction path)", () => {
  /** A bot with one resting, unfilled order, halted -- the incident's shape. */
  async function haltedWithRestingOrder(): Promise<string> {
    await run((bot) => bot.create(creation()));
    await run((bot) => bot.start(ACTOR));
    await run((bot) => bot.onPriceUpdate(priceAt("100")));
    const clientOrderId = exchange.placed[0]!.clientOrderId;
    // Halting tries to cancel; make that fail, exactly as it did live, so the
    // order stays believed-open rather than being recorded cancelled.
    exchange.nextCancelFailure = { kind: "exchange_error", message: "could not read response" };
    await run((bot) => bot.halt("manual", "reconciliation found drift", ACTOR));
    return clientOrderId;
  }

  it("records the exchange's real fill, moves the position, and writes the trade", async () => {
    const clientOrderId = await haltedWithRestingOrder();
    const order = exchange.resting.get(clientOrderId)!;
    // The exchange's OWN fill id, as `include_trades` would report it.
    exchange.fillsByOrder.set(clientOrderId, [
      {
        fillId: "gemini-tid-4242",
        price: order.request.price,
        quantity: order.request.quantity,
        feeAmount: ZERO,
        feeAsset: "USD",
        executedAt: T0 + 1000,
      },
    ]);

    const result = await run((bot) => bot.applyMissedFills(ACTOR));

    expect(result.applied).toHaveLength(1);
    expect(result.applied[0]!.fillId).toBe("gemini-tid-4242");
    expect(result.skipped).toEqual([]);

    // The order moved pending -> filled in D1, and the trade row now exists.
    const row = await db.orders.findOne({ client_order_id: clientOrderId });
    expect(row!.status).toBe("filled");
    expect(await db.trades.count({ bot_instance_id: BOT_ID })).toBe(1);

    // And the position moved, through the same applyEntry the live path uses.
    const snapshot = await run((bot) => bot.snapshot());
    expect(snapshot.state.position.quantity).toBe(order.request.quantity);
    expect(snapshot.state.position.averageEntryPrice).toBe(order.request.price);
  });

  it("leaves the bot HALTED -- repairing the books is not resuming", async () => {
    const clientOrderId = await haltedWithRestingOrder();
    exchange.fillsByOrder.set(clientOrderId, [
      exchange.fillFor(clientOrderId, { fillId: "gemini-tid-1" }),
    ]);

    const result = await run((bot) => bot.applyMissedFills(ACTOR));

    expect(result.status).toBe("halted");
    const row = await db.botInstances.findOne({ id: BOT_ID });
    expect(row!.status).toBe("halted");
  });

  it("is idempotent: a second run applies nothing", async () => {
    // Guaranteed by `applyFill`'s fillId dedup, which is exactly why a
    // synthesised id would have been corrupting.
    const clientOrderId = await haltedWithRestingOrder();
    exchange.fillsByOrder.set(clientOrderId, [
      exchange.fillFor(clientOrderId, { fillId: "gemini-tid-9" }),
    ]);

    const first = await run((bot) => bot.applyMissedFills(ACTOR));
    const second = await run((bot) => bot.applyMissedFills(ACTOR));

    expect(first.applied).toHaveLength(1);
    expect(second.applied).toHaveLength(0);
    // No double-counted trade, no double-counted position.
    expect(await db.trades.count({ bot_instance_id: BOT_ID })).toBe(1);
  });

  it("refuses on a bot that is not halted", async () => {
    await run((bot) => bot.create(creation()));
    await run((bot) => bot.start(ACTOR));
    await expect(run((bot) => bot.applyMissedFills(ACTOR))).rejects.toThrow(
      /only be applied to a halted bot/,
    );
  });

  it("reports an unreadable order rather than assuming it did not fill", async () => {
    // Section 5.6: an unreachable exchange is not evidence of anything.
    await haltedWithRestingOrder();
    exchange.orderStatusFailure = { kind: "transport", message: "connection reset" };

    const result = await run((bot) => bot.applyMissedFills(ACTOR));

    expect(result.applied).toEqual([]);
    expect(result.skipped.join(" ")).toMatch(/connection reset/);
    expect(await db.trades.count({ bot_instance_id: BOT_ID })).toBe(0);
  });

  it("distinguishes 'no per-fill detail reported' from 'no executions'", async () => {
    // The venue answered but carried no `trades`. There is no real fill id to
    // apply, so nothing is applied and the gap is reported -- not silently
    // treated as an unfilled order.
    await haltedWithRestingOrder();

    const result = await run((bot) => bot.applyMissedFills(ACTOR));

    expect(result.applied).toEqual([]);
    expect(result.skipped.join(" ")).toMatch(/no per-fill detail/);
  });

  it("audits the repair against the human actor", async () => {
    const clientOrderId = await haltedWithRestingOrder();
    exchange.fillsByOrder.set(clientOrderId, [
      exchange.fillFor(clientOrderId, { fillId: "gemini-tid-77" }),
    ]);

    await run((bot) => bot.applyMissedFills(ACTOR));

    const audit = await db.auditLog.findMany({ where: { action: "bot.missed_fills_applied" } });
    expect(audit).toHaveLength(1);
    expect(audit[0]!.actor).toBe(ACTOR);
    const details = audit[0]!.details_json as unknown as Record<string, unknown>;
    expect(JSON.stringify(details["applied"])).toContain("gemini-tid-77");
  });
});

// ---------------------------------------------------------------------------
// checkOpenOrders: observing fills on RESTING orders (step 19)
// ---------------------------------------------------------------------------

describe("checkOpenOrders (the resting-order observation gap)", () => {
  /** A RUNNING bot with one resting, unfilled base order. */
  async function runningWithRestingOrder(): Promise<string> {
    await run((bot) => bot.create(creation()));
    await run((bot) => bot.start(ACTOR));
    await run((bot) => bot.onPriceUpdate(priceAt("100")));
    return exchange.placed[0]!.clientOrderId;
  }

  it("folds in a fill the placement response never carried, on a RUNNING bot", async () => {
    // The gap itself. `onFill` is only ever called with the fills attached to a
    // placement response, so an order that RESTS and fills later reaches the
    // position through nothing at all until this runs.
    const clientOrderId = await runningWithRestingOrder();
    const order = exchange.resting.get(clientOrderId)!;
    exchange.fillsByOrder.set(clientOrderId, [
      {
        fillId: "gemini-tid-5150",
        price: order.request.price,
        quantity: order.request.quantity,
        feeAmount: ZERO,
        feeAsset: "USDT",
        executedAt: T0 + 1000,
      },
    ]);

    const result = await run((bot) => bot.checkOpenOrders(ACTOR));

    expect(result.status).toBe("running");
    expect(result.applied).toHaveLength(1);
    expect(result.applied[0]!.fillId).toBe("gemini-tid-5150");
    expect(result.skipped).toEqual([]);

    // Through the same path the live one uses: order, trade, and position.
    const row = await db.orders.findOne({ client_order_id: clientOrderId });
    expect(row!.status).toBe("filled");
    expect(await db.trades.count({ bot_instance_id: BOT_ID })).toBe(1);
    const snapshot = await run((bot) => bot.snapshot());
    expect(snapshot.state.position.quantity).toBe(order.request.quantity);
    expect(snapshot.state.position.averageEntryPrice).toBe(order.request.price);
  });

  it("is idempotent: a second pass applies nothing", async () => {
    const clientOrderId = await runningWithRestingOrder();
    exchange.fillsByOrder.set(clientOrderId, [
      exchange.fillFor(clientOrderId, { fillId: "gemini-tid-1" }),
    ]);

    const first = await run((bot) => bot.checkOpenOrders(ACTOR));
    const second = await run((bot) => bot.checkOpenOrders(ACTOR));

    expect(first.applied).toHaveLength(1);
    expect(second.applied).toHaveLength(0);
    expect(await db.trades.count({ bot_instance_id: BOT_ID })).toBe(1);
  });

  it("reports an unreadable order rather than assuming it did not fill", async () => {
    await runningWithRestingOrder();
    exchange.orderStatusFailure = { kind: "transport", message: "connection reset" };

    const result = await run((bot) => bot.checkOpenOrders(ACTOR));

    expect(result.applied).toEqual([]);
    expect(result.skipped.join(" ")).toMatch(/connection reset/);
    expect(await db.trades.count({ bot_instance_id: BOT_ID })).toBe(0);
  });

  it("alerts and skips a filled quantity with no fill id behind it", async () => {
    // Binance's order-status endpoint carries no fills array at all. A
    // synthesised id would make the real execution double-count or vanish, so
    // the gap is reported and left for reconciliation.
    const clientOrderId = await runningWithRestingOrder();
    exchange.resting.get(clientOrderId)!.filledQuantity = m("1");

    const result = await run((bot) => bot.checkOpenOrders(ACTOR));

    expect(result.applied).toEqual([]);
    expect(result.skipped.join(" ")).toMatch(/no real fill id/);
    expect(await db.trades.count({ bot_instance_id: BOT_ID })).toBe(0);
    const alerts = await db.alerts.findMany({ where: { alert_type: "unattributable_fill" } });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.severity).toBe("critical");
  });

  it("closes an order the exchange cancelled, so openOrderIds drains", async () => {
    // Without this the id is re-read forever and the bot never places again.
    const clientOrderId = await runningWithRestingOrder();
    exchange.resting.get(clientOrderId)!.cancelled = true;

    const result = await run((bot) => bot.checkOpenOrders(ACTOR));

    expect(result.closed).toEqual([clientOrderId]);
    const snapshot = await run((bot) => bot.snapshot());
    expect(snapshot.state.openOrderIds).toEqual([]);
    const row = await db.orders.findOne({ client_order_id: clientOrderId });
    expect(row!.status).toBe("cancelled");
  });

  it("leaves an unattributable fill's order open rather than closing it", async () => {
    // Cancelled on the exchange AND filled beyond what was recorded, with no
    // per-fill detail: the bot-44400a shape exactly. Reported, not closed.
    const clientOrderId = await runningWithRestingOrder();
    const resting = exchange.resting.get(clientOrderId)!;
    resting.cancelled = true;
    resting.filledQuantity = m("1");

    const result = await run((bot) => bot.checkOpenOrders(ACTOR));

    expect(result.closed).toEqual([]);
    const snapshot = await run((bot) => bot.snapshot());
    expect(snapshot.state.openOrderIds).toEqual([clientOrderId]);
    const row = await db.orders.findOne({ client_order_id: clientOrderId });
    expect(row!.status).toBe("pending");
  });

  it("REFUSES to close a terminal order whose fill could not be applied", async () => {
    // The quantity gate on its own. The venue DID report per-fill detail, so
    // the unattributable branch does not fire -- but the fill overfills the
    // order and cannot be applied, leaving the local record behind. Closing it
    // would be permanent: a terminal order can never accept a fill afterwards,
    // which is precisely how bot-44400a's base order became unrecoverable.
    const clientOrderId = await runningWithRestingOrder();
    exchange.resting.get(clientOrderId)!.cancelled = true;
    exchange.fillsByOrder.set(clientOrderId, [
      {
        fillId: "gemini-tid-overfill",
        price: m("100"),
        quantity: m("5"), // the order is for 1
        feeAmount: ZERO,
        feeAsset: "USDT",
        executedAt: T0 + 1000,
      },
    ]);

    const result = await run((bot) => bot.checkOpenOrders(ACTOR));

    expect(result.applied).toEqual([]);
    expect(result.closed).toEqual([]);
    expect(result.skipped.join(" ")).toMatch(/never accept the missing fill/);
    const row = await db.orders.findOne({ client_order_id: clientOrderId });
    expect(row!.status).toBe("pending");
    const snapshot = await run((bot) => bot.snapshot());
    expect(snapshot.state.openOrderIds).toEqual([clientOrderId]);
  });

  it("refuses on a stopped bot", async () => {
    await run((bot) => bot.create(creation()));
    await run((bot) => bot.start(ACTOR));
    await run((bot) => bot.close(ACTOR));
    await expect(run((bot) => bot.checkOpenOrders(ACTOR))).rejects.toThrow(/stopped bot/);
  });

  it("writes no audit row for a pass that changed nothing", async () => {
    // Once this runs every 30s the no-op pass is the common one, and a row per
    // pass would measure uptime rather than events.
    await runningWithRestingOrder();

    await run((bot) => bot.checkOpenOrders(ACTOR));

    expect(await db.auditLog.count({ action: "bot.open_orders_checked" })).toBe(0);
  });

  it("audits a pass that did move something", async () => {
    const clientOrderId = await runningWithRestingOrder();
    exchange.fillsByOrder.set(clientOrderId, [
      exchange.fillFor(clientOrderId, { fillId: "gemini-tid-77" }),
    ]);

    await run((bot) => bot.checkOpenOrders(ACTOR));

    const audit = await db.auditLog.findMany({ where: { action: "bot.open_orders_checked" } });
    expect(audit).toHaveLength(1);
    expect(audit[0]!.actor).toBe(ACTOR);
    expect(JSON.stringify(audit[0]!.details_json)).toContain("gemini-tid-77");
  });

  it("writes ONE unattributable_fill row however many passes re-detect it", async () => {
    // Step 19 recorded this as an explicit PRECONDITION for scheduling the
    // poll: at 30 seconds an unconditional insert is ~2,880 rows per bot per
    // day, which is step 18's measured 186-identical-criticals problem 60x
    // faster. The dedup is the shared one reconciliation uses.
    const clientOrderId = await runningWithRestingOrder();
    exchange.resting.get(clientOrderId)!.filledQuantity = m("1");

    for (let i = 0; i < 10; i++) await run((bot) => bot.checkOpenOrders(ACTOR));

    expect(await db.alerts.count({ alert_type: "unattributable_fill" })).toBe(1);
  });

  it("resolves the standing alert once the condition clears", async () => {
    const clientOrderId = await runningWithRestingOrder();
    exchange.resting.get(clientOrderId)!.filledQuantity = m("1");
    await run((bot) => bot.checkOpenOrders(ACTOR));

    // The venue now reports the same quantity this bot has recorded.
    exchange.resting.get(clientOrderId)!.filledQuantity = ZERO;
    await run((bot) => bot.checkOpenOrders(ACTOR));

    const rows = await db.alerts.findMany({ where: { alert_type: "unattributable_fill" } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.resolved).toBe(true);
  });

  it("never resolves this bot's OTHER alerts, which it does not re-detect", async () => {
    // `cancel_failed`, `order_state_drift` and the rest are discrete events
    // written by this same object under this same source, and three of them are
    // reconciliation's to ingest and close (`INGESTED_ALERT_TYPES`). A poll
    // that claimed them would silently close incidents it never observed --
    // and, since step 18.1 gates the "Apply missed fills" control on an
    // UNRESOLVED drift row, would make the repair button disappear from a bot
    // that still needs it.
    const clientOrderId = await runningWithRestingOrder();
    exchange.cancelFailure = { kind: "transport", message: "cancel unreachable" };
    await run((bot) => bot.halt("manual", "operator halted it", ACTOR));
    expect(await db.alerts.count({ alert_type: "cancel_failed", resolved: false })).toBe(1);

    // Clean passes: everything read, nothing amiss, so the poll's own standing
    // conditions would all resolve here.
    exchange.cancelFailure = null;
    for (let i = 0; i < 3; i++) await run((bot) => bot.checkOpenOrders(ACTOR));

    expect(await db.alerts.count({ alert_type: "cancel_failed", resolved: false })).toBe(1);
    const snapshot = await run((bot) => bot.snapshot());
    expect(snapshot.state.openOrderIds).toEqual([clientOrderId]);
  });

  it("does NOT resolve it on a pass that could not read the order", async () => {
    // Section 5.6 applied to the alert lifecycle: a pass that saw nothing found
    // nothing, and closing the incident on that basis would clear a live
    // problem on the strength of an outage.
    const clientOrderId = await runningWithRestingOrder();
    exchange.resting.get(clientOrderId)!.filledQuantity = m("1");
    await run((bot) => bot.checkOpenOrders(ACTOR));

    exchange.orderStatusFailure = { kind: "transport", message: "connection reset" };
    await run((bot) => bot.checkOpenOrders(ACTOR));

    const rows = await db.alerts.findMany({ where: { alert_type: "unattributable_fill" } });
    expect(rows[0]!.resolved).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The audit gate: a pass that REFUSED is a pass worth recording (step 22)
// ---------------------------------------------------------------------------

describe("bot.open_orders_checked (what a pass records)", () => {
  async function runningWithRestingOrder(): Promise<string> {
    await run((bot) => bot.create(creation()));
    await run((bot) => bot.start(ACTOR));
    await run((bot) => bot.onPriceUpdate(priceAt("100")));
    return exchange.placed[0]!.clientOrderId;
  }

  async function auditRows() {
    return await db.auditLog.findMany({ where: { action: "bot.open_orders_checked" } });
  }

  it("audits the terminal-fold REFUSAL -- the bot-44400a condition -- which wrote nothing before", async () => {
    // The gap step 22 closes, in its most important shape. An order that ended
    // terminal on the exchange with MORE filled than this bot recorded is left
    // open and reported, because closing it would make the understatement
    // permanent. That is the single most consequential decision this pass can
    // take, and under `applied || closed` it left no durable trace whatsoever.
    const clientOrderId = await runningWithRestingOrder();
    const resting = exchange.resting.get(clientOrderId)!;
    resting.cancelled = true;
    exchange.fillsByOrder.set(clientOrderId, [
      {
        fillId: "gemini-tid-overfill",
        price: m("100"),
        quantity: m("5"), // the order is for 1: cannot be applied
        feeAsset: "USDT",
        feeAmount: ZERO,
        executedAt: T0 + 1000,
      },
    ]);

    const result = await run((bot) => bot.checkOpenOrders(ACTOR));

    // Nothing moved -- which is exactly why the old gate wrote nothing.
    expect(result.applied).toEqual([]);
    expect(result.closed).toEqual([]);

    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actor).toBe(ACTOR);
    // And it records the REASON, not just that a pass happened.
    expect(JSON.stringify(rows[0]!.details_json)).toMatch(/never accept the missing fill/);
  });

  it("audits an unattributable fill, which is read-and-refused rather than unread", async () => {
    const clientOrderId = await runningWithRestingOrder();
    exchange.resting.get(clientOrderId)!.filledQuantity = m("1");

    await run((bot) => bot.checkOpenOrders(ACTOR));

    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows[0]!.details_json)).toMatch(/no real fill id/);
  });

  it("writes NOTHING for an unreadable pass, however many times it repeats", async () => {
    // The reason `refused` is its own list rather than the gate reading
    // `skipped`. An unreachable venue at 30s would be ~2,880 rows per bot per
    // day saying the same thing, and that condition already has a lifecycle:
    // the backoff and one standing `poll_blind`.
    await runningWithRestingOrder();
    exchange.orderStatusFailure = { kind: "transport", message: "connection reset" };

    for (let i = 0; i < 5; i++) await run((bot) => bot.checkOpenOrders(ACTOR));

    // It IS reported to the caller -- it is simply not an audit event.
    const result = await run((bot) => bot.checkOpenOrders(ACTOR));
    expect(result.skipped.join(" ")).toMatch(/connection reset/);
    expect(await auditRows()).toHaveLength(0);
  });

  it("still writes nothing for a clean pass that found nothing", async () => {
    await runningWithRestingOrder();
    await run((bot) => bot.checkOpenOrders(ACTOR));
    expect(await auditRows()).toHaveLength(0);
  });

  // The MIXED pass -- one order unreadable and another refused, which is what
  // actually separates `refused` from `skipped` -- needs two simultaneously open
  // orders. DCA cannot express that (`decide` holds while `hasOpenOrder`), so it
  // lives with the ladder, in grid-bot-instance.test.ts.
});

// ---------------------------------------------------------------------------
// Tick staleness: what makes "wait for the next tick" sound (step 22)
// ---------------------------------------------------------------------------

describe("price_updates_stale (the first real read of lastPriceAt)", () => {
  /** Ten minutes: 4.6x the measured 130s worst-case gap between closed candles. */
  const STALE_MS = 600_000;

  async function runningWithRestingOrder(): Promise<string> {
    await run((bot) => bot.create(creation()));
    await run((bot) => bot.start(ACTOR));
    await run((bot) => bot.onPriceUpdate(priceAt("100")));
    return exchange.placed[0]!.clientOrderId;
  }

  async function staleAlerts() {
    return await db.alerts.findMany({ where: { alert_type: "price_updates_stale" } });
  }

  it("raises nothing across the WORST measured gap between two closed candles", async () => {
    // THE TEST THAT PINS THE THRESHOLD AGAINST THE MEASUREMENT, and it has to
    // poll BETWEEN the ticks rather than alongside them -- an earlier version
    // advanced the clock and delivered a tick before each pass, so the age was
    // zero every time and it would have passed at any threshold at all.
    //
    // The real shape: the poll fires every 30s, the feed forwards a closed
    // candle far less often. Step 14's probe measured candle frames arriving
    // only on activity, 35-70s apart, and a forward needs a frame carrying a
    // newer openTime -- so the worst case is ~60s to the boundary plus up to
    // ~70s of quiet, the same ~130s arithmetic that sized the deployed live
    // check's 120s window. A threshold that fired anywhere in here would fire
    // on a perfectly healthy feed.
    await runningWithRestingOrder();

    for (let elapsed = 30_000; elapsed <= 130_000; elapsed += 30_000) {
      clock = T0 + elapsed;
      exchange.now = clock;
      await run((bot) => bot.checkOpenOrders(ACTOR));
      expect(await staleAlerts()).toHaveLength(0);
    }

    // And the tick that finally arrives at the far end of that gap is normal.
    await run((bot) => bot.onPriceUpdate(priceAt("100")));
    expect(await staleAlerts()).toHaveLength(0);
  });

  it("raises nothing one second short of the threshold", async () => {
    await runningWithRestingOrder();
    clock += STALE_MS - 1000;
    exchange.now = clock;

    await run((bot) => bot.checkOpenOrders(ACTOR));

    expect(await staleAlerts()).toHaveLength(0);
  });

  it("raises a standing warning once the bot has gone silent for the threshold", async () => {
    // The condition step 21 left as a hope: a poll-observed fill waits for the
    // next tick, and nothing verified a next tick was coming.
    await runningWithRestingOrder();
    clock += STALE_MS;
    exchange.now = clock;

    await run((bot) => bot.checkOpenOrders(ACTOR));

    const rows = await staleAlerts();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.severity).toBe("warning");
    expect(rows[0]!.category).toBe("system");
    expect(rows[0]!.bot_instance_id).toBe(BOT_ID);
    expect(rows[0]!.message).toMatch(/no live price/);
  });

  it("writes ONE row however many passes re-detect it", async () => {
    // At 30 seconds an unconditional insert is ~2,880 rows per bot per day.
    // This goes through the same standing mechanism reconciliation uses.
    await runningWithRestingOrder();
    clock += STALE_MS;
    exchange.now = clock;

    for (let i = 0; i < 10; i++) await run((bot) => bot.checkOpenOrders(ACTOR));

    expect(await staleAlerts()).toHaveLength(1);
  });

  it("resolves the moment a real tick arrives", async () => {
    await runningWithRestingOrder();
    clock += STALE_MS;
    exchange.now = clock;
    await run((bot) => bot.checkOpenOrders(ACTOR));
    expect((await staleAlerts())[0]!.resolved).toBe(false);

    clock += 1000;
    exchange.now = clock;
    await run((bot) => bot.onPriceUpdate(priceAt("100")));
    await run((bot) => bot.checkOpenOrders(ACTOR));

    const rows = await staleAlerts();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.resolved).toBe(true);
  });

  it("never raises on a HALTED bot, whose price clock is frozen by design", async () => {
    // `#onPriceUpdatePass` returns `ignored` before writing `lastPriceAt` for
    // any status but running. Checking a halted bot would alert on every one of
    // them, forever, for behaving exactly as specified.
    await runningWithRestingOrder();
    await run((bot) => bot.halt("manual", "operator halted it", ACTOR));
    clock += STALE_MS * 3;
    exchange.now = clock;

    await run((bot) => bot.checkOpenOrders(ACTOR));

    expect(await staleAlerts()).toHaveLength(0);
  });

  it("resolves an open row when the bot halts, because the condition stops being a fault", async () => {
    // The cancel is made to fail on purpose, and that is not incidental: it is
    // what leaves an order in `openOrderIds`, and the resolve half is gated on
    // `reads > 0`. A halt that cancels cleanly disarms the poll and the row
    // stays open until the bot polls again -- the same limitation step 20
    // recorded for `poll_blind` (its open question 2), and it applies here for
    // the same reason: only a pass that actually looked may close a row.
    await runningWithRestingOrder();
    clock += STALE_MS;
    exchange.now = clock;
    await run((bot) => bot.checkOpenOrders(ACTOR));
    expect((await staleAlerts())[0]!.resolved).toBe(false);

    exchange.cancelFailure = { kind: "transport", message: "cancel unreachable" };
    await run((bot) => bot.halt("manual", "operator halted it", ACTOR));
    exchange.cancelFailure = null;
    await run((bot) => bot.checkOpenOrders(ACTOR));

    expect((await staleAlerts())[0]!.resolved).toBe(true);
  });

  it("does not resolve it on a pass that could not read the venue", async () => {
    // The staleness itself is derived from local state, but the resolve half is
    // one call covering every type this object owns, and section 5.6 gates it on
    // the pass having actually observed. The safe direction.
    await runningWithRestingOrder();
    clock += STALE_MS;
    exchange.now = clock;
    await run((bot) => bot.checkOpenOrders(ACTOR));

    clock += 1000;
    exchange.now = clock;
    await run((bot) => bot.onPriceUpdate(priceAt("100")));
    exchange.orderStatusFailure = { kind: "transport", message: "connection reset" };
    await run((bot) => bot.checkOpenOrders(ACTOR));

    expect((await staleAlerts())[0]!.resolved).toBe(false);
  });

  it("raises nothing for a running bot that has never seen a tick", async () => {
    // `lastPriceAt` null: an age is not computable, there is no `startedAt` to
    // measure against, and the scheduled path cannot reach this state anyway
    // (an order is only ever placed from inside `onPriceUpdate`, which writes
    // the timestamp first, and a bot with no order arms no alarm).
    await run((bot) => bot.create(creation()));
    await run((bot) => bot.start(ACTOR));
    clock += STALE_MS * 5;
    exchange.now = clock;

    const result = await run((bot) => bot.checkOpenOrders(ACTOR));

    expect(result.applied).toEqual([]);
    expect(await staleAlerts()).toHaveLength(0);
  });

  it("is raised by the ALARM too, not only by a human calling in", async () => {
    // The path that matters in production: nobody is watching, and the poll is
    // the only thing awake.
    await runningWithRestingOrder();
    clock += STALE_MS;
    exchange.now = clock;

    await run((bot) => bot.alarm());

    expect(await staleAlerts()).toHaveLength(1);
  });

  it("does not count a stale tick as a failed READ, so the poll keeps its 30s cadence", async () => {
    // The two conditions are independent: the venue is perfectly reachable and
    // this pass read every order. Folding staleness into `unreadable` would back
    // a healthy bot off to the five-minute floor and eventually claim
    // `poll_blind` on a venue that never stopped answering.
    await runningWithRestingOrder();
    clock += STALE_MS;
    exchange.now = clock;

    await run((bot) => bot.alarm());

    const schedule = await inBot(objectName, async (_bot, state) => {
      return (await state.storage.get("poll-schedule")) as { failures: number };
    });
    expect(schedule.failures).toBe(0);
    expect(await db.alerts.count({ alert_type: "poll_blind" })).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The alarm: the poll, on a timer (step 20)
// ---------------------------------------------------------------------------

describe("alarm (the scheduled open-order poll)", () => {
  /** The single alarm this object is allowed to hold, as stored. */
  async function alarmAt(): Promise<number | null> {
    return await inBot(objectName, async (_bot, state) => await state.storage.getAlarm());
  }

  async function pollSchedule(): Promise<{
    nextPollAt: number | null;
    failures: number;
    blindSince: number | null;
    escalated: boolean;
  }> {
    return await inBot(objectName, async (_bot, state) => {
      return (await state.storage.get("poll-schedule")) as never;
    });
  }

  /** A RUNNING bot with one resting, unfilled base order. */
  async function runningWithRestingOrder(): Promise<string> {
    await run((bot) => bot.create(creation()));
    await run((bot) => bot.start(ACTOR));
    await run((bot) => bot.onPriceUpdate(priceAt("100")));
    return exchange.placed[0]!.clientOrderId;
  }

  /** Advance to the moment the alarm is due, then fire it as the runtime would. */
  async function fireAlarm(): Promise<void> {
    const due = await alarmAt();
    if (due !== null) clock = Math.max(clock, due);
    await run((bot) => bot.alarm());
  }

  // --- arming and disarming ------------------------------------------------

  it("arms nothing for a bot that has never placed an order", async () => {
    await run((bot) => bot.create(creation()));
    expect(await alarmAt()).toBeNull();

    await run((bot) => bot.start(ACTOR));
    expect(await alarmAt()).toBeNull();
  });

  it("arms the alarm the moment an order starts resting", async () => {
    await runningWithRestingOrder();
    expect(await alarmAt()).toBe(T0 + 30_000);
  });

  it("disarms when the last open order leaves", async () => {
    // A timer firing against an empty list is rate-limit cost with no possible
    // finding.
    const clientOrderId = await runningWithRestingOrder();
    await run((bot) => bot.onFill(clientOrderId, exchange.fillFor(clientOrderId)));

    const snapshot = await run((bot) => bot.snapshot());
    expect(snapshot.state.openOrderIds).toEqual([]);
    expect(await alarmAt()).toBeNull();
  });

  it("disarms when the bot is closed", async () => {
    await runningWithRestingOrder();
    await run((bot) => bot.close(ACTOR));
    expect(await alarmAt()).toBeNull();
  });

  it("re-arms a lost alarm on the next state write", async () => {
    // The recovery path. A Durable Object's alarm lives in storage and survives
    // eviction on its own; what this covers is the alarm going missing for any
    // other reason (a deploy that placed orders before this step existed), and
    // it works because arming hangs off `#putState` rather than off the
    // lifecycle methods.
    await runningWithRestingOrder();
    await inBot(objectName, async (_bot, state) => await state.storage.deleteAlarm());
    expect(await alarmAt()).toBeNull();

    clock += 10_000;
    await run((bot) => bot.onPriceUpdate(priceAt("100")));

    // Restored to the instant it was already due at, not pushed out by the
    // recovery: the schedule is what survives, and the alarm is derived from it.
    expect(await alarmAt()).toBe(T0 + 30_000);
  });

  it("keeps its whole schedule in storage, so an eviction loses nothing", async () => {
    // Nothing about the schedule is an in-memory field: the object can be
    // evicted between any two passes and the alarm still fires with the right
    // backoff state.
    await runningWithRestingOrder();
    exchange.orderStatusFailure = { kind: "transport", message: "unreachable" };
    await fireAlarm();

    expect(await pollSchedule()).toMatchObject({ failures: 1, nextPollAt: clock + 60_000 });
  });

  // --- what a firing actually does ----------------------------------------

  it("folds in a resting fill when it fires, through the ordinary live path", async () => {
    const clientOrderId = await runningWithRestingOrder();
    const order = exchange.resting.get(clientOrderId)!;
    exchange.fillsByOrder.set(clientOrderId, [
      {
        fillId: "gemini-tid-2020",
        price: order.request.price,
        quantity: order.request.quantity,
        feeAmount: ZERO,
        feeAsset: "USDT",
        executedAt: T0 + 1000,
      },
    ]);

    await fireAlarm();

    const snapshot = await run((bot) => bot.snapshot());
    expect(snapshot.state.position.quantity).toBe(order.request.quantity);
    expect(await db.trades.count({ bot_instance_id: BOT_ID })).toBe(1);
    // And the order is no longer open, so the alarm has disarmed itself.
    expect(await alarmAt()).toBeNull();
  });

  it("audits a scheduled pass as `system`, and only when something moved", async () => {
    const clientOrderId = await runningWithRestingOrder();
    await fireAlarm();
    expect(await db.auditLog.count({ action: "bot.open_orders_checked" })).toBe(0);

    exchange.fillsByOrder.set(clientOrderId, [
      exchange.fillFor(clientOrderId, { fillId: "gemini-tid-99" }),
    ]);
    await fireAlarm();

    const audit = await db.auditLog.findMany({ where: { action: "bot.open_orders_checked" } });
    expect(audit).toHaveLength(1);
    expect(audit[0]!.actor).toBe("system");
  });

  it("re-arms 30 seconds later after a clean pass that found nothing", async () => {
    await runningWithRestingOrder();

    await fireAlarm();

    expect(await alarmAt()).toBe(T0 + 30_000 + 30_000);
  });

  it("keeps polling a HALTED bot, and places nothing", async () => {
    // Step 19: observing a halted bot is safe and useful -- a halt whose
    // cancellation failed leaves live orders on the exchange, and a human is
    // about to make a decision about exactly those books. What it must never
    // do is put an order back on the exchange.
    const clientOrderId = await runningWithRestingOrder();
    exchange.cancelFailure = { kind: "transport", message: "cancel unreachable" };
    await run((bot) => bot.halt("manual", "operator halted it", ACTOR));

    const snapshot = await run((bot) => bot.snapshot());
    expect(snapshot.state.status).toBe("halted");
    expect(snapshot.state.openOrderIds).toEqual([clientOrderId]);
    expect(await alarmAt()).not.toBeNull();

    const placedBefore = exchange.placed.length;
    exchange.fillsByOrder.set(clientOrderId, [
      exchange.fillFor(clientOrderId, { fillId: "gemini-tid-halted" }),
    ]);
    await fireAlarm();

    expect(await db.trades.count({ bot_instance_id: BOT_ID })).toBe(1);
    expect(exchange.placed).toHaveLength(placedBefore);
  });

  it("refuses to poll a STOPPED bot even if one somehow holds an open order", async () => {
    // `close()` empties `openOrderIds`, so this state is not reachable through
    // the public API -- it is written directly, because the guard exists for
    // the case that is not reachable rather than the one that is. A stopped
    // bot's capital is released and `checkOpenOrders` refuses outright, so a
    // poll would be work whose result nothing may use.
    const clientOrderId = await runningWithRestingOrder();
    exchange.fillsByOrder.set(clientOrderId, [
      exchange.fillFor(clientOrderId, { fillId: "gemini-tid-stopped" }),
    ]);

    await inBot(objectName, async (_bot, state) => {
      const stored = (await state.storage.get("state")) as Record<string, unknown>;
      await state.storage.put("state", { ...stored, status: "stopped" });
      await state.storage.put("poll-schedule", {
        nextPollAt: clock,
        failures: 0,
        blindSince: null,
        escalated: false,
      });
    });

    await run((bot) => bot.alarm());

    expect(await db.trades.count({ bot_instance_id: BOT_ID })).toBe(0);
    expect(await alarmAt()).toBeNull();
  });

  it("neither throws nor re-arms on an object that holds no bot", async () => {
    // An alarm can outlive a bot that was never finished: capital is reserved
    // and the D1 row written before this object's storage (step 6, open
    // question 6). A throwing handler would be retried by the runtime.
    await expect(run((bot) => bot.alarm())).resolves.toBeUndefined();
    expect(await alarmAt()).toBeNull();
  });

  // --- backoff, blindness, escalation --------------------------------------

  it("applies the backoff even when the same pass read some orders successfully", async () => {
    // The mixed pass writes state (it applied something), and that write
    // re-arms through `#putState` at the healthy cadence. The failure has to
    // win, or a bot that can read one order and not another polls the
    // unreadable one every 30 seconds forever.
    const first = await runningWithRestingOrder();
    exchange.fillsByOrder.set(first, [exchange.fillFor(first, { fillId: "gemini-tid-mixed" })]);
    // A second id the venue has never heard of, so its read fails while the
    // first succeeds. Written straight into storage because DCA will not place
    // a second order while one is open -- the shape is reachable in production
    // (a grid ladder, or an order placed before a restart), not through this
    // strategy's own pipeline.
    await inBot(objectName, async (_bot, state) => {
      const stored = (await state.storage.get("state")) as { openOrderIds: string[] };
      await state.storage.put("state", {
        ...stored,
        openOrderIds: [first, "v1-ghost-order-0"],
      });
    });

    const firedAt = (await alarmAt())!;
    clock = firedAt;
    await run((bot) => bot.alarm());

    expect(await db.trades.count({ bot_instance_id: BOT_ID })).toBe(1);
    expect(await alarmAt()).toBe(firedAt + 60_000);
  });

  it("backs off on repeated unreadable passes: 30s, 60, 120, 240, then a 5-minute floor", async () => {
    await runningWithRestingOrder();
    exchange.orderStatusFailure = { kind: "transport", message: "unreachable" };

    const delays: number[] = [];
    for (let i = 0; i < 5; i++) {
      const firedAt = (await alarmAt())!;
      clock = firedAt;
      await run((bot) => bot.alarm());
      delays.push((await alarmAt())! - firedAt);
    }

    expect(delays).toEqual([60_000, 120_000, 240_000, 300_000, 300_000]);
  });

  it("goes blind after five consecutive failures, with ONE alert row", async () => {
    await runningWithRestingOrder();
    exchange.orderStatusFailure = { kind: "transport", message: "unreachable" };

    for (let i = 0; i < 10; i++) await fireAlarm();

    const blind = await db.alerts.findMany({ where: { alert_type: "poll_blind" } });
    expect(blind).toHaveLength(1);
    expect(blind[0]!.severity).toBe("warning");
    expect(blind[0]!.resolved).toBe(false);
    // Still retrying: an outage must self-heal rather than dying silently.
    expect(await alarmAt()).not.toBeNull();
  });

  it("escalates ONCE if it stays blind past thirty minutes", async () => {
    await runningWithRestingOrder();
    exchange.orderStatusFailure = { kind: "transport", message: "unreachable" };
    for (let i = 0; i < 5; i++) await fireAlarm();
    expect(await db.alerts.count({ alert_type: "poll_blind_escalated" })).toBe(0);

    clock += 31 * 60_000;
    for (let i = 0; i < 5; i++) await fireAlarm();

    const escalated = await db.alerts.findMany({ where: { alert_type: "poll_blind_escalated" } });
    expect(escalated).toHaveLength(1);
    expect(escalated[0]!.severity).toBe("critical");
  });

  it("recovers: a readable pass resolves both blind alerts and restores the 30s cadence", async () => {
    await runningWithRestingOrder();
    exchange.orderStatusFailure = { kind: "transport", message: "unreachable" };
    for (let i = 0; i < 5; i++) await fireAlarm();
    clock += 31 * 60_000;
    await fireAlarm();
    expect(await db.alerts.count({ resolved: false, alert_type: "poll_blind" })).toBe(1);

    exchange.orderStatusFailure = null;
    const firedAt = (await alarmAt())!;
    clock = firedAt;
    await run((bot) => bot.alarm());

    expect(await db.alerts.count({ resolved: false, alert_type: "poll_blind" })).toBe(0);
    expect(await db.alerts.count({ resolved: false, alert_type: "poll_blind_escalated" })).toBe(0);
    expect(await alarmAt()).toBe(firedAt + 30_000);
    expect(await pollSchedule()).toMatchObject({ failures: 0, blindSince: null, escalated: false });
  });

  it("writes ONE unattributable_fill row across many firings", async () => {
    // The same standing-alert guarantee the manual path has, at 60x the rate.
    const clientOrderId = await runningWithRestingOrder();
    exchange.resting.get(clientOrderId)!.filledQuantity = m("1");

    for (let i = 0; i < 20; i++) await fireAlarm();

    expect(await db.alerts.count({ alert_type: "unattributable_fill" })).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Step 21: interleaving safety
// ---------------------------------------------------------------------------

/**
 * Every test here forces a real interleaving rather than hoping for one, in the
 * shape `rate-limiter.test.ts` established at step 8: a seam the object really
 * uses is wrapped, and the competing pass is driven from inside it. That is the
 * only way to make a race reproducible, and step 21's section 0 probe
 * (`concurrency-model.test.ts`) is what establishes these interleavings are
 * ones the runtime genuinely produces -- an RPC and an alarm are both delivered
 * while this object sits suspended inside an exchange call.
 */
describe("interleaving safety (step 21)", () => {
  async function pollSchedule(): Promise<{
    nextPollAt: number | null;
    failures: number;
    blindSince: number | null;
    escalated: boolean;
  }> {
    return await inBot(objectName, async (_bot, state) => {
      return (await state.storage.get("poll-schedule")) as never;
    });
  }

  async function openOrderIds(): Promise<readonly string[]> {
    return await inBot(objectName, async (bot) => (await bot.snapshot()).state.openOrderIds);
  }

  /** A RUNNING bot with one resting, unfilled base order. */
  async function runningWithRestingOrder(): Promise<string> {
    await run((bot) => bot.create(creation()));
    await run((bot) => bot.start(ACTOR));
    await run((bot) => bot.onPriceUpdate(priceAt("100")));
    return exchange.placed[0]!.clientOrderId;
  }

  /** Report one full execution for `clientOrderId`, with real per-fill detail. */
  function reportFill(clientOrderId: string): void {
    const order = exchange.resting.get(clientOrderId)!;
    exchange.fillsByOrder.set(clientOrderId, [
      {
        fillId: `gemini-tid-${clientOrderId}`,
        price: order.request.price,
        quantity: order.request.quantity,
        feeAmount: ZERO,
        feeAsset: "USDT",
        executedAt: T0 + 1000,
      },
    ]);
  }

  // --- #mutateState: writes that used to revert each other -----------------

  it("keeps an order whose cancellation failed when the take-profit sell is placed", async () => {
    // Deterministic, and it needs no concurrency at all -- one failed cancel is
    // enough. `#placeTakeProfitSell` used to write `openOrderIds: [exitId]`,
    // discarding whatever `#cancelOpenOrders` had just been unable to cancel.
    // That order is still live on the exchange, and dropping it here meant it
    // was never polled and never cancelled again, on the one path where the bot
    // is trying to get flat.
    await openPosition("100");
    await run((bot) => bot.onPriceUpdate(priceAt("95")));
    const restingBuy = exchange.placed[1]!.clientOrderId;
    expect(await openOrderIds()).toContain(restingBuy);

    exchange.cancelFailure = { kind: "transport", message: "gateway timeout" };
    await run((bot) => bot.onPriceUpdate(priceAt("120"))); // above the take-profit target

    const ids = await openOrderIds();
    const exitId = await inBot(objectName, async (bot) => (await bot.snapshot()).state.exitOrderId);

    expect(exitId).not.toBeNull();
    expect(ids).toContain(exitId!); // the exit is tracked
    expect(ids).toContain(restingBuy); // and so is the order that would not cancel
  });

  it("does not drop an order a concurrent pass added while a halt was cancelling", async () => {
    // Scenario B. The halt sweep cancels across the network, order by order,
    // and used to finish by ASSIGNING the list it believed in when it started.
    // A poll folding a fill mid-sweep places a grid replacement, and that id was
    // silently erased -- a live order on the exchange, untracked, unpolled, and
    // never cancelled.
    //
    // Driven here on DCA for simplicity: the competing pass adds an id through
    // the ordinary placement path while the sweep is suspended on its cancel.
    await openPosition("100");
    await run((bot) => bot.onPriceUpdate(priceAt("95")));
    const restingBuy = exchange.placed[1]!.clientOrderId;

    let addedDuringSweep: string | null = null;
    const realCancel = exchange.cancelOrder.bind(exchange);
    exchange.cancelOrder = async (pair, clientOrderId) => {
      if (addedDuringSweep === null) {
        // A second order starts resting while the sweep is in flight.
        addedDuringSweep = "concurrent-order";
        await inBot(objectName, async (_bot, state) => {
          const stored = (await state.storage.get("state")) as { openOrderIds: string[] };
          await state.storage.put("state", {
            ...stored,
            openOrderIds: [...stored.openOrderIds, addedDuringSweep],
          });
        });
      }
      return await realCancel(pair, clientOrderId);
    };

    await run((bot) => bot.halt("manual", "operator", ACTOR));

    const ids = await openOrderIds();
    expect(ids).not.toContain(restingBuy); // cancelled, so it leaves
    expect(ids).toContain("concurrent-order"); // added meanwhile, so it stays
  });

  // --- the point of no return ----------------------------------------------

  it("abandons a buy rather than sending it to a bot that halted mid-preparation", async () => {
    // Scenario D's shape. The decision to buy is taken while running, but the
    // send happens several awaits later -- `#ensureFilters` reaches the network
    // on a bot with no cached filters. A halt landing in that window used to
    // put a live order on the exchange from a halted bot, which is precisely
    // the invariant steps 18 and 19 worked to protect.
    await run((bot) => bot.create(creation()));
    await run((bot) => bot.start(ACTOR));

    const realFilters = exchange.getSymbolFilters.bind(exchange);
    let halted = false;
    exchange.getSymbolFilters = async (pair) => {
      if (!halted) {
        halted = true;
        await run((bot) => bot.halt("manual", "halted mid-placement", ACTOR));
      }
      return await realFilters(pair);
    };

    const result = await run((bot) => bot.onPriceUpdate(priceAt("100")));

    expect(result.action).toBe("aborted");
    expect(result.status).toBe("halted");
    // The whole point: nothing reached the exchange.
    expect(exchange.placed).toHaveLength(0);
  });

  // --- the poll's yield-and-defer -------------------------------------------

  it("defers a poll that would overlap another pass, and applies nothing", async () => {
    const clientOrderId = await runningWithRestingOrder();
    reportFill(clientOrderId);

    // The competing pass is a halt, which reaches the network to cancel. The
    // poll is driven from inside that cancel, so it starts while the halt is
    // genuinely in flight.
    let observed: Awaited<ReturnType<BotInstance["checkOpenOrders"]>> | null = null;
    const realCancel = exchange.cancelOrder.bind(exchange);
    exchange.cancelOrder = async (pair, id) => {
      observed ??= await run((bot) => bot.checkOpenOrders("competing-poll"));
      return await realCancel(pair, id);
    };

    await run((bot) => bot.halt("manual", "operator", ACTOR));

    expect(observed).not.toBeNull();
    expect(observed!.deferred).toBe(true);
    expect(observed!.applied).toHaveLength(0);

    // And the fill really was left for a later pass rather than lost: nothing
    // reached the position.
    const position = await inBot(objectName, async (bot) => (await bot.snapshot()).state.position);
    expect(position.quantity).toBe(ZERO);
  });

  it("does not count a deferred pass as a failure", async () => {
    // A deferred pass is not a blind one. Counting it would back a busy bot off
    // toward the five-minute floor and eventually raise `poll_blind` against a
    // venue that was answering the whole time.
    const clientOrderId = await runningWithRestingOrder();
    reportFill(clientOrderId);

    const realCancel = exchange.cancelOrder.bind(exchange);
    let done = false;
    exchange.cancelOrder = async (pair, id) => {
      if (!done) {
        done = true;
        await run((bot) => bot.alarm());
      }
      return await realCancel(pair, id);
    };

    clock = T0 + 30_000;
    await run((bot) => bot.halt("manual", "operator", ACTOR));

    expect((await pollSchedule()).failures).toBe(0);
  });

  it("does not let a deferred pass resolve a standing alert it never looked for", async () => {
    // The other half of the lifecycle, and the reason `deferred` is a third
    // outcome rather than folded into a clean pass. A deferred pass found no
    // unattributable fill because it looked at nothing.
    const clientOrderId = await runningWithRestingOrder();

    // Raise a real `unattributable_fill`: filled on the venue, no per-fill
    // detail, so there is no id to apply.
    exchange.resting.get(clientOrderId)!.filledQuantity = exchange.placed[0]!.quantity;
    await run((bot) => bot.checkOpenOrders(ACTOR));
    expect(await db.alerts.count({ alert_type: "unattributable_fill", resolved: false })).toBe(1);

    // Now a deferred pass runs while another is in flight. It must not close it.
    const realCancel = exchange.cancelOrder.bind(exchange);
    let done = false;
    exchange.cancelOrder = async (pair, id) => {
      if (!done) {
        done = true;
        await run((bot) => bot.checkOpenOrders("competing-poll"));
      }
      return await realCancel(pair, id);
    };
    await run((bot) => bot.halt("manual", "operator", ACTOR));

    expect(await db.alerts.count({ alert_type: "unattributable_fill", resolved: false })).toBe(1);
  });
});
