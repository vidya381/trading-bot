/**
 * The unified human-triggered liquidation (`BotInstance.liquidatePosition`),
 * spec sections 4.5 / 6.2 / 6.3 / 7.2, build step 10.3.
 *
 * Real Durable Object storage and real D1 inside the Workers runtime, per
 * section 14; only the exchange is mocked. Both strategies are driven through
 * the SAME public call, which is the point of it: a future dashboard button
 * closes a halted DCA bot and a halted grid bot identically.
 *
 * The scenario this exists for is the one the DCA `sellOnStopLoss` refusal (step
 * 6, decision 14) and the grid manual-halt-does-not-liquidate rule (step 9,
 * decision 2) deliberately leave open: a bot halts holding a position, and a
 * human later decides to close it out, on purpose, through the same mechanism
 * grid's stop-loss already uses.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { seedPlaceholderTotalBalance } from "../capital";
import type { Database } from "../db/database";
import { freshDatabase } from "../db/test-helpers";
import { fromDecimalString as m, ZERO } from "../shared/money";
import type { Price } from "../shared/exchange-client";
import type { DcaParams } from "../strategies/dca";
import type { GridParams } from "../strategies/grid";
import type { BotInstance, CreateDcaBotRequest, CreateGridBotRequest } from "./bot-instance";
import { BotInstanceError } from "./bot-instance";
import { FakeExchange, TEST_PAIR } from "./fake-exchange";
import { inBot, rateLimiterStub } from "./test-helpers";

const T0 = 1_760_000_000_000;
const ACTOR = "owner@example.com";

let db: Database;
let exchange: FakeExchange;
let clock: number;
let idCounter: number;
let objectName: string;
let nameCounter = 0;

const dcaParams: DcaParams = {
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

/** Levels 90, 95, 100, 105, 110. Stop-loss at 81, breakout at 115. */
const gridParams: GridParams = {
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

function dcaCreation(overrides: Partial<CreateDcaBotRequest> = {}): CreateDcaBotRequest {
  return {
    botInstanceId: "dca-liq",
    accountLabel: "main",
    exchange: "binance",
    pair: TEST_PAIR,
    capitalAsset: "USDT",
    allocatedCapital: m("400"),
    params: dcaParams,
    actor: ACTOR,
    ...overrides,
  };
}

function gridCreation(overrides: Partial<CreateGridBotRequest> = {}): CreateGridBotRequest {
  return {
    botInstanceId: "grid-liq",
    accountLabel: "main",
    exchange: "binance",
    pair: TEST_PAIR,
    capitalAsset: "USDT",
    allocatedCapital: m("500"),
    params: gridParams,
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
  objectName = `liq-${nameCounter}`;

  await seedPlaceholderTotalBalance(
    db,
    { accountLabel: "main", asset: "USDT", totalBalance: m("10000"), note: "test fixture" },
    { actor: ACTOR, now: T0 },
  );
});

/** The most recently placed order on the fake. */
function lastPlaced() {
  return exchange.placed[exchange.placed.length - 1]!;
}

// ---------------------------------------------------------------------------
// DCA: a real halted DCA bot liquidated
// ---------------------------------------------------------------------------

describe("DCA liquidation (sections 6.3, 7.2)", () => {
  /** Create, start, fill the base order at `price`, so a real position is held. */
  async function dcaWithPosition(price = "100"): Promise<void> {
    await run((bot) => bot.create(dcaCreation()));
    await run((bot) => bot.start(ACTOR));
    await run((bot) => bot.onPriceUpdate(priceAt(price)));
    const base = exchange.placed[0]!.clientOrderId;
    await run((bot) => bot.onFill(base, exchange.fillFor(base)));
  }

  it("closes out a bot that halted at a stop-loss holding its position (the sellOnStopLoss gap)", async () => {
    await dcaWithPosition("100"); // holds 1.0 BTC at cost 100

    // DCA does NOT auto-sell at a stop-loss (sellOnStopLoss is refused): it
    // halts holding the position. Drop below the 20% stop (100 -> 80).
    const halt = await run((bot) => bot.onPriceUpdate(priceAt("80")));
    expect(halt.status).toBe("halted");
    let snapshot = await run((bot) => bot.snapshot());
    expect(snapshot.state.position.quantity).toBe(m("1")); // still held, not sold

    // The human liquidates at the current price. Set it below cost so the
    // realized figure is a loss, recorded honestly rather than hidden.
    exchange.currentPrice = m("80");
    const result = await run((bot) => bot.liquidatePosition(ACTOR));
    expect(result.action).toBe("liquidating");
    expect(result.status).toBe("halted");

    // A marketable limit SELL of the whole position was placed at 80.
    const sell = lastPlaced();
    expect(sell.side).toBe("sell");
    expect(sell.price).toBe(m("80"));
    expect(sell.quantity).toBe(m("1"));

    snapshot = await run((bot) => bot.snapshot());
    expect(snapshot.state.exitOrderId).toBe(sell.clientOrderId);
    expect(snapshot.state.exitKind).toBe("liquidation");
    // An audit entry names the human actor.
    const audit = await db.auditLog.findMany({ where: { action: "bot.liquidated" } });
    expect(audit).toHaveLength(1);
    expect(audit[0]!.actor).toBe(ACTOR);

    // Fill it: the bot STAYS halted (not a cycle completion, no auto-restart),
    // the position goes flat, and the loss is realized.
    await run((bot) => bot.onFill(sell.clientOrderId, exchange.fillFor(sell.clientOrderId)));
    snapshot = await run((bot) => bot.snapshot());
    expect(snapshot.state.status).toBe("halted");
    expect(snapshot.state.position.quantity).toBe(ZERO);
    expect(snapshot.state.exitOrderId).toBeNull();
    expect(snapshot.state.realizedGross).toBe(m("-20")); // (80 - 100) x 1
  });

  it("is callable regardless of why the bot is halted (a manual halt)", async () => {
    await dcaWithPosition("100");
    await run((bot) => bot.halt("manual", "operator review", ACTOR));

    const result = await run((bot) => bot.liquidatePosition(ACTOR));
    expect(result.action).toBe("liquidating");
    expect(lastPlaced().side).toBe("sell");
  });

  it("refuses to liquidate a RUNNING bot", async () => {
    await run((bot) => bot.create(dcaCreation()));
    await run((bot) => bot.start(ACTOR)); // status running

    await expect(run((bot) => bot.liquidatePosition(ACTOR))).rejects.toMatchObject({
      code: "invalid_status",
    });
    // Nothing was sold.
    expect(exchange.placed.filter((o) => o.side === "sell")).toHaveLength(0);
  });

  it("is a no-op when the position is already flat", async () => {
    await run((bot) => bot.create(dcaCreation()));
    await run((bot) => bot.start(ACTOR));
    await run((bot) => bot.halt("manual", "review", ACTOR)); // halted, never bought

    const result = await run((bot) => bot.liquidatePosition(ACTOR));
    expect(result.action).toBe("nothing_to_liquidate");
    expect(exchange.placed).toHaveLength(0);
    const alerts = await db.alerts.findMany({ where: { alert_type: "liquidation_noop" } });
    expect(alerts).toHaveLength(1);
  });

  it("does not double-sell when a liquidation is already live", async () => {
    await dcaWithPosition("100");
    await run((bot) => bot.halt("manual", "review", ACTOR));
    await run((bot) => bot.liquidatePosition(ACTOR));
    const placedAfterFirst = exchange.placed.length;

    // A second click while the first sell is still resting is an idempotent no-op.
    const second = await run((bot) => bot.liquidatePosition(ACTOR));
    expect(second.action).toBe("hold");
    expect(exchange.placed.length).toBe(placedAfterFirst);
  });

  it("leaves the position held and alerts when no current price can be read (section 5.6)", async () => {
    await dcaWithPosition("100");
    await run((bot) => bot.halt("manual", "review", ACTOR));

    // The exchange cannot be reached for a price. A liquidation must not sell at
    // a stale or unknown price, so nothing is placed and the position is held.
    exchange.currentPriceFailure = { kind: "transport", message: "timeout" };
    const result = await run((bot) => bot.liquidatePosition(ACTOR));
    expect(result.action).toBe("no_price");

    expect(exchange.placed.filter((o) => o.side === "sell")).toHaveLength(0);
    const snapshot = await run((bot) => bot.snapshot());
    expect(snapshot.state.position.quantity).toBe(m("1")); // still held
    expect(snapshot.state.exitOrderId).toBeNull();
    const alerts = await db.alerts.findMany({ where: { alert_type: "liquidation_no_price" } });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.severity).toBe("critical");
  });
});

// ---------------------------------------------------------------------------
// Grid: a real halted grid bot liquidated through the SAME unified call
// ---------------------------------------------------------------------------

describe("grid liquidation through the same call (section 6.2)", () => {
  /** Create, start, place the ladder at 100, and fill the buy at 95. */
  async function gridWithPosition(): Promise<void> {
    await run((bot) => bot.createGrid(gridCreation()));
    await run((bot) => bot.start(ACTOR));
    await run((bot) => bot.onPriceUpdate(priceAt("100")));
    const buyAt95 = exchange.placed.find((o) => o.price === m("95"))!.clientOrderId;
    await run((bot) => bot.onFill(buyAt95, exchange.fillFor(buyAt95)));
  }

  it("closes out a manually-halted grid bot with the identical liquidatePosition call", async () => {
    await gridWithPosition();
    // A manual halt cancels the ladder but does NOT liquidate (step 9, decision
    // 2): the held position remains.
    await run((bot) => bot.halt("manual", "operator review", ACTOR));
    let snapshot = await run((bot) => bot.snapshot());
    const held = snapshot.state.ladder!.heldQuantity;
    expect(held).toBeGreaterThan(ZERO);

    exchange.currentPrice = m("95");
    const result = await run((bot) => bot.liquidatePosition(ACTOR));
    expect(result.action).toBe("liquidating");
    expect(result.status).toBe("halted");

    const sell = lastPlaced();
    expect(sell.side).toBe("sell");
    expect(sell.quantity).toBe(held);
    snapshot = await run((bot) => bot.snapshot());
    expect(snapshot.state.exitKind).toBe("liquidation");
    // The stale ladder slots were cleared, so the liquidation sell is the only
    // live order.
    expect(snapshot.state.ladder!.slots.every((slot) => slot === null)).toBe(true);

    // Fill it: folds through the grid exit-fill path, position flat, still halted.
    await run((bot) => bot.onFill(sell.clientOrderId, exchange.fillFor(sell.clientOrderId)));
    snapshot = await run((bot) => bot.snapshot());
    expect(snapshot.state.status).toBe("halted");
    expect(snapshot.state.ladder!.heldQuantity).toBe(ZERO);
    expect(snapshot.state.exitOrderId).toBeNull();
  });

  it("refuses to liquidate a running grid bot", async () => {
    await run((bot) => bot.createGrid(gridCreation()));
    await run((bot) => bot.start(ACTOR));
    await run((bot) => bot.onPriceUpdate(priceAt("100"))); // running, ladder placed

    await expect(run((bot) => bot.liquidatePosition(ACTOR))).rejects.toBeInstanceOf(BotInstanceError);
  });
});
