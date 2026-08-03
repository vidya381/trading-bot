/**
 * Attaching a real exchange client to `BotInstance` in production (step 13).
 *
 * Step 6 built the object to REFUSE to trade with no exchange attached, because
 * no credentials existed. Step 3.2/3.4 built the secret-backed resolvers, and
 * step 11 built `resolveExchangeForAccount`, "the single dispatch home the future
 * execution path reuses" (its decision 7). This step wires that home into the
 * object: when nothing is injected, `#rawExchange` resolves the account's real
 * client from the bot's own stored `exchange`/`accountLabel`.
 *
 * These tests prove the wiring WITHOUT any live call, exactly as the rest of the
 * suite does -- the automated coverage is:
 *
 *   - an injected client still wins, so every existing test (which injects a
 *     `FakeExchange`) is unaffected and the resolution path is skipped;
 *   - with nothing injected, the object resolves through the REAL resolver on the
 *     testnet environment (no secrets set in the test bindings), so every
 *     fail-closed branch fires for real: a missing Binance secret, a missing
 *     Gemini secret (which also proves `config.exchange` is dispatched to the
 *     RIGHT resolver), and an unknown stored exchange value;
 *   - a running bot that cannot build a client HALTS loudly (section 7.5) and
 *     places nothing, rather than trading blind.
 *
 * The SUCCESS branch -- a resolved live client actually placing an order -- is
 * deliberately NOT exercised here: the suite makes no live call, and building a
 * real client and driving a real order is the tiered, read-only-first Gemini
 * sandbox verification this project uses for every real-exchange path. What the
 * automated suite owns is that the object reaches for the right client and fails
 * closed when it cannot have one.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { seedPlaceholderTotalBalance } from "../capital";
import type { Database } from "../db/database";
import { freshDatabase } from "../db/test-helpers";
import { fromDecimalString as m } from "../shared/money";
import type { Price } from "../shared/exchange-client";
import type { DcaParams } from "../strategies/dca";
import type { BotInstance, CreateDcaBotRequest } from "./bot-instance";
import { FakeExchange, TEST_PAIR } from "./fake-exchange";
import { inBot, noopFeed, rateLimiterStub } from "./test-helpers";

const T0 = 1_900_000_000_000; // future: an armed alarm must not already be overdue (step 20)
const ACTOR = "owner@example.com";
const BOT_ID = "attach-1";

let db: Database;
let clock: number;
let idCounter: number;
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
    allocatedCapital: m("400"),
    params,
    actor: ACTOR,
    ...overrides,
  };
}

function priceAt(value: string): Price {
  return { pair: TEST_PAIR, price: m(value), at: clock };
}

/** Dependencies MINUS the exchange, so `#rawExchange` takes the resolution path. */
function depsWithoutExchange() {
  return {
    db,
    now: () => clock,
    newId: () => {
      idCounter += 1;
      return `generated-${idCounter}`;
    },
    limiterFor: () => rateLimiterStub(`limiter-${objectName}`),
    sleep: async () => undefined,
    feedFor: () => noopFeed,
  };
}

/** Run `body` with an exchange INJECTED -- the ordinary test path. */
async function runInjected<T>(exchange: FakeExchange, body: (bot: BotInstance) => Promise<T>): Promise<T> {
  return await inBot(objectName, async (instance) => {
    instance.attach({ ...depsWithoutExchange(), exchange });
    return await body(instance);
  });
}

/** Run `body` with NOTHING injected -- the production resolution path. */
async function runResolving<T>(body: (bot: BotInstance) => Promise<T>): Promise<T> {
  return await inBot(objectName, async (instance) => {
    instance.attach(depsWithoutExchange());
    return await body(instance);
  });
}

beforeEach(async () => {
  db = await freshDatabase();
  clock = T0;
  idCounter = 0;
  nameCounter += 1;
  objectName = `attach-${nameCounter}`;

  await seedPlaceholderTotalBalance(
    db,
    { accountLabel: "main", asset: "USDT", totalBalance: m("10000"), note: "test fixture" },
    { actor: ACTOR, now: T0 },
  );
});

describe("exchange attachment (step 13)", () => {
  it("an injected client wins, so resolution is skipped even with no secrets set", async () => {
    // No BINANCE secret exists in the test env, so if resolution ran the bot
    // would halt. It does not: the injected FakeExchange short-circuits it.
    const exchange = new FakeExchange();
    await runInjected(exchange, (bot) => bot.create(creation()));
    await runInjected(exchange, (bot) => bot.start(ACTOR));
    const result = await runInjected(exchange, (bot) => bot.onPriceUpdate(priceAt("100")));

    expect(result.action).toBe("placed-base");
    expect(result.status).toBe("running");
    expect(exchange.placed).toHaveLength(1);
    expect((await db.botInstances.findOne({ id: BOT_ID }))!.status).toBe("running");
  });

  it("with no client injected and no Binance secret, halts loudly and places nothing", async () => {
    await runResolving((bot) => bot.create(creation()));
    await runResolving((bot) => bot.start(ACTOR));

    // The first price update would place the base order -- but building the
    // client fails closed, so section 7.5 halts the bot instead.
    const result = await runResolving((bot) => bot.onPriceUpdate(priceAt("100")));
    expect(result.status).toBe("halted");

    const row = await db.botInstances.findOne({ id: BOT_ID });
    expect(row!.status).toBe("halted");
    // The halt reason carries the resolver's OWN message, naming exactly which
    // secret is missing and how to set it.
    expect(row!.halt_reason).toMatch(/unhandled_error: BotInstanceError/);
    expect(row!.halt_reason).toMatch(/BINANCE_API_KEY/);

    // A system-classified alert, one per event.
    const alerts = await db.alerts.findMany({ where: { alert_type: "halt_unhandled_error" } });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.category).toBe("system");

    // Nothing was placed: no order row anywhere in this object's history.
    const snapshot = await runResolving((bot) => bot.snapshot());
    expect(snapshot.orders).toHaveLength(0);
    expect(snapshot.state.openOrderIds).toHaveLength(0);
  });

  it("dispatches to the RIGHT resolver: a Gemini bot fails on the Gemini secret, not the Binance one", async () => {
    // Same missing-secret path, but the bot's stored exchange is "gemini". The
    // reason must name GEMINI_*, proving config.exchange is threaded through
    // resolveExchangeForAccount to the Gemini resolver rather than always Binance.
    await runResolving((bot) => bot.create(creation({ exchange: "gemini" })));
    await runResolving((bot) => bot.start(ACTOR));

    const result = await runResolving((bot) => bot.onPriceUpdate(priceAt("100")));
    expect(result.status).toBe("halted");

    const row = await db.botInstances.findOne({ id: BOT_ID });
    expect(row!.halt_reason).toMatch(/GEMINI_API_KEY/);
    expect(row!.halt_reason).not.toMatch(/BINANCE/);
  });

  it("refuses a stored exchange value that is not a known exchange", async () => {
    // A corrupted or legacy exchange string must not reach a resolver at all;
    // isExchangeId guards it first. "kraken" is a valid TEXT value in D1 (the
    // column has no CHECK) but not a known ExchangeId.
    await runResolving((bot) => bot.create(creation({ exchange: "kraken" })));
    await runResolving((bot) => bot.start(ACTOR));

    const result = await runResolving((bot) => bot.onPriceUpdate(priceAt("100")));
    expect(result.status).toBe("halted");

    const row = await db.botInstances.findOne({ id: BOT_ID });
    expect(row!.halt_reason).toMatch(/"kraken"/);
    expect(row!.halt_reason).toMatch(/not a known exchange/);

    const snapshot = await runResolving((bot) => bot.snapshot());
    expect(snapshot.orders).toHaveLength(0);
  });
});
