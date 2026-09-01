/**
 * SPEC 22.10, END TO END: the trailing stop's single entry must actually fill,
 * and must give up rather than retry forever when it does not.
 *
 * ⚠ WHAT PRODUCED THIS FILE. Not a design record, and not a deferred item from
 * 22.4 -- the first live trailing-stop bot placed its entry, lost it, and placed
 * it again TEN times, always at the identical price, and would have continued
 * indefinitely. Two independent defects met there:
 *
 *  1. The entry reused `#placeBuy`, which prices a buy AT the last trade price.
 *     That is a MAKER order: correct for DCA's ladder, which is meant to rest
 *     and wait, and wrong for a trailing stop, whose one entry must fill before
 *     the strategy can start tracking anything at all.
 *  2. `decide` re-answers `open_entry` on every candle while the position is
 *     flat and no order is live, and NOTHING bounded that. DCA and grid are
 *     bounded by their own cycle and ladder logic; this strategy had no
 *     equivalent.
 *
 * ⚠ HOW THIS DIFFERS FROM `strategies/trailing-stop-decide.test.ts`, AND WHY
 * BOTH EXIST -- the same split the 22.3 pair uses. That file drives the pure
 * functions: the crossing arithmetic, and the cap as a rule. It cannot prove
 * that a real bot SENDS the crossed price rather than the last one, nor that a
 * real bot reaches the halt rather than looping. This file drives a real
 * `BotInstance` with real Durable Object storage and real D1, and asserts on
 * what actually reached the exchange.
 *
 * ⚠ THE CANCELLATION IS MODELLED THE WAY THE INCIDENT HAPPENED. Nothing in this
 * system cancelled that bot's entries; the venue did, and the cause is a
 * separate open investigation. So the test sets `cancelled` on the fake's
 * resting order DIRECTLY, without going through `cancelOrder` -- an order that
 * vanishes with no request from this system, which is exactly what was observed.
 * `checkOpenOrders` is then the real poll that discovers it.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { seedPlaceholderTotalBalance } from "../capital";
import type { Database } from "../db/database";
import { freshDatabase } from "../db/test-helpers";
import { fromDecimalString as m, mul, type Money } from "../shared/money";
import type { Price } from "../shared/exchange-client";
import { ENTRY_CROSS_PCT, MAX_ENTRY_ATTEMPTS, entryLimitPrice } from "../strategies/trailing-stop";
import type { DcaParams } from "../strategies/dca";
import { FakeExchange } from "./fake-exchange";
import { inBot, noopFeed, rateLimiterStub } from "./test-helpers";
import type { BotInstance } from "./bot-instance";

const ACTOR = "owner@example.com";
const NOW = 1_900_000_000_000;
const PAIR = "BTCUSD";
/** The fake's default tick, restated so the expected prices below are readable. */
const TICK = m("0.01");

let db: Database;
let exchange: FakeExchange;
let counter = 0;

beforeEach(async () => {
  db = await freshDatabase();
  exchange = new FakeExchange();
  exchange.now = NOW;
  counter += 1;
  await seedPlaceholderTotalBalance(
    db,
    { accountLabel: "main", asset: "USD", totalBalance: m("100000"), note: "test fixture" },
    { actor: ACTOR, now: NOW },
  );
});

/** Each bot gets its own Durable Object, so no state leaks between tests. */
async function inNamed<T>(name: string, body: (bot: BotInstance) => Promise<T>): Promise<T> {
  return await inBot(name, async (instance) => {
    instance.attach({
      db,
      exchange,
      now: () => NOW,
      limiterFor: () => rateLimiterStub(`limiter-${name}`),
      sleep: async () => undefined,
      feedFor: () => noopFeed,
    });
    return await body(instance);
  });
}

const priceAt = (value: string): Price => ({ pair: PAIR, price: m(value), at: NOW });

/** A started trailing-stop bot with a 10% trail and the given allocation. */
async function startedTrailingStop(name: string, allocated = "1000"): Promise<void> {
  await inNamed(name, (bot) =>
    bot.createTrailingStop({
      botInstanceId: name,
      accountLabel: "main",
      exchange: "gemini",
      pair: PAIR,
      capitalAsset: "USD",
      allocatedCapital: m(allocated),
      params: { trailPct: m("10") },
      actor: ACTOR,
    }),
  );
  await inNamed(name, (bot) => bot.start(ACTOR));
}

const DCA_PARAMS: DcaParams = {
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

describe("the trailing-stop entry is priced to fill (22.10)", () => {
  it("sends a limit ABOVE the last price, not a maker order resting at it", async () => {
    const name = `ts-entry-${counter}`;
    await startedTrailingStop(name);

    await inNamed(name, (bot) => bot.onPriceUpdate(priceAt("100")));

    expect(exchange.placed).toHaveLength(1);
    const entry = exchange.placed[0]!;
    expect(entry.side).toBe("buy");
    expect(entry.type).toBe("limit");

    // THE ASSERTION THE OLD BEHAVIOUR FAILS. A maker entry would be at 100
    // exactly -- resting behind the ask, which is how ten of them were placed
    // and none filled.
    expect(entry.price).not.toBe(m("100"));
    expect(entry.price).toBeGreaterThan(m("100"));
    expect(entry.price).toBe(entryLimitPrice(m("100"), ENTRY_CROSS_PCT, TICK));
    expect(entry.price).toBe(m("100.25"));
  });

  it("sizes the order at the price it will actually pay, so the allocation still holds", async () => {
    // The half of the crossing that is easy to get wrong: quantity must be
    // computed from the CROSSED price, not the last one, or the notional
    // overshoots the allocation by the offset on every entry.
    const name = `ts-size-${counter}`;
    await startedTrailingStop(name, "1000");

    await inNamed(name, (bot) => bot.onPriceUpdate(priceAt("100")));

    const entry = exchange.placed[0]!;
    const notional: Money = mul(entry.price, entry.quantity, "floor");
    expect(notional).toBeLessThanOrEqual(m("1000"));
    // And not wildly under it either -- the step rounding is the only shortfall.
    expect(notional).toBeGreaterThan(m("999"));
  });

  it("still crosses on a price that is not already on the tick grid", async () => {
    const name = `ts-tick-${counter}`;
    await startedTrailingStop(name);

    // 63718 x 1.0025 = 63877.295, off the 0.01 grid. `validateOrder` rounds a
    // buy's price DOWN, so an unaligned crossing price would come back a tick
    // closer to the market; `entryLimitPrice` aligns it up first.
    await inNamed(name, (bot) => bot.onPriceUpdate(priceAt("63718")));

    const entry = exchange.placed[0]!;
    expect(entry.price).toBe(m("63877.30"));
    expect(entry.price).toBeGreaterThan(m("63718"));
  });

  it("fills on the first attempt and starts trailing, which is the point of all this", async () => {
    const name = `ts-fill-${counter}`;
    await startedTrailingStop(name);

    await inNamed(name, (bot) => bot.onPriceUpdate(priceAt("100")));
    const entryId = exchange.placed[0]!.clientOrderId;
    await inNamed(name, (bot) => bot.onFill(entryId, exchange.fillFor(entryId)));

    const snap = await inNamed(name, (bot) => bot.snapshot());
    expect(snap.state.position.quantity).toBeGreaterThan(0n);
    // One attempt, and no second one: a filled entry ends the entry phase.
    expect(snap.state.entryAttempts).toBe(1);

    await inNamed(name, (bot) => bot.onPriceUpdate(priceAt("120")));
    expect(exchange.placed.filter((o) => o.side === "buy")).toHaveLength(1);
    const trailing = await inNamed(name, (bot) => bot.snapshot());
    expect(trailing.state.highWaterMark).toBe(m("120"));
    expect(trailing.state.status).toBe("running");
  });

  it("leaves DCA's maker entry exactly as it was", async () => {
    // The blast-radius assertion. `#placeBuy` is shared, and the crossing lives
    // in the trailing stop's own shell around it -- so a DCA base order at the
    // same price must still rest AT that price. If this ever fails, the fix
    // leaked into a strategy whose retries are bounded by its own cycle logic
    // and whose ladder depends on being a maker.
    const name = `dca-maker-${counter}`;
    await inNamed(name, (bot) =>
      bot.create({
        botInstanceId: name,
        accountLabel: "main",
        exchange: "gemini",
        pair: PAIR,
        capitalAsset: "USD",
        allocatedCapital: m("400"),
        params: DCA_PARAMS,
        actor: ACTOR,
      }),
    );
    await inNamed(name, (bot) => bot.start(ACTOR));
    await inNamed(name, (bot) => bot.onPriceUpdate(priceAt("100")));

    expect(exchange.placed).toHaveLength(1);
    expect(exchange.placed[0]!.price).toBe(m("100"));
  });
});

describe("the entry retry cap halts instead of looping (22.10)", () => {
  /**
   * The venue takes the entry away with no request from this system, and the
   * real poll then discovers it -- which is what clears `openOrderIds` and lets
   * `decide` ask for the entry again.
   */
  async function loseEntryToTheVenue(name: string, clientOrderId: string): Promise<void> {
    const resting = exchange.resting.get(clientOrderId);
    if (resting === undefined) throw new Error(`no resting order ${clientOrderId}`);
    resting.cancelled = true;
    const pass = await inNamed(name, (bot) => bot.checkOpenOrders(ACTOR));
    expect(pass.closed).toContain(clientOrderId);
  }

  it(`places the entry ${MAX_ENTRY_ATTEMPTS} times, then halts with a reason a human can read`, async () => {
    const name = `ts-cap-${counter}`;
    await startedTrailingStop(name);

    // Drive MORE candles than the cap allows placements for. If the bound is
    // missing, this loop places an order on every one of them -- which is the
    // live incident, reproduced.
    const CANDLES = MAX_ENTRY_ATTEMPTS + 5;
    for (let candle = 0; candle < CANDLES; candle += 1) {
      const before = exchange.placed.length;
      await inNamed(name, (bot) => bot.onPriceUpdate(priceAt("100")));
      const placedThisCandle = exchange.placed.length > before;
      if (placedThisCandle) {
        await loseEntryToTheVenue(name, exchange.placed[exchange.placed.length - 1]!.clientOrderId);
      }
    }

    // THE BOUND. Not one order per candle -- exactly the cap, and then nothing.
    expect(exchange.placed.filter((o) => o.side === "buy")).toHaveLength(MAX_ENTRY_ATTEMPTS);

    const snap = await inNamed(name, (bot) => bot.snapshot());
    expect(snap.state.status).toBe("halted");
    expect(snap.state.entryAttempts).toBe(MAX_ENTRY_ATTEMPTS);
    expect(snap.state.position.quantity).toBe(0n);

    // Readable, in the way the stop-loss detail is: what happened, how many
    // times, and what to go and look at.
    const halt = snap.state.haltReason ?? "";
    expect(halt).toContain("entry_unfilled");
    expect(halt).toContain(`placed ${MAX_ENTRY_ATTEMPTS} times and never filled`);
    expect(halt).toMatch(/order-cancellation settings/);
  });

  it("mirrors the halt to D1 and alerts CRITICAL -- this is a failure, not an exit", async () => {
    const name = `ts-cap-alert-${counter}`;
    await startedTrailingStop(name);

    for (let candle = 0; candle < MAX_ENTRY_ATTEMPTS + 1; candle += 1) {
      const before = exchange.placed.length;
      await inNamed(name, (bot) => bot.onPriceUpdate(priceAt("100")));
      if (exchange.placed.length > before) {
        await loseEntryToTheVenue(name, exchange.placed[exchange.placed.length - 1]!.clientOrderId);
      }
    }

    const [row] = await db.botInstances.findMany({ where: { id: name } });
    expect(row!.status).toBe("halted");
    expect(row!.halt_reason).toMatch(/entry_unfilled/);

    // ⚠ NOT `info`. `trailing_stop_reached` is a positive exit and is in
    // `#halt`'s `positiveExit` list; this one deliberately is not. The strategy
    // never started, which is the opposite of it succeeding.
    const [alert] = await db.alerts.findMany({ where: { alert_type: "halt_entry_unfilled" } });
    expect(alert).toBeDefined();
    expect(alert!.severity).toBe("critical");
    expect(alert!.bot_instance_id).toBe(name);
  });

  it("stays halted: later candles place nothing, however many arrive", async () => {
    const name = `ts-cap-stays-${counter}`;
    await startedTrailingStop(name);

    for (let candle = 0; candle < MAX_ENTRY_ATTEMPTS + 1; candle += 1) {
      const before = exchange.placed.length;
      await inNamed(name, (bot) => bot.onPriceUpdate(priceAt("100")));
      if (exchange.placed.length > before) {
        await loseEntryToTheVenue(name, exchange.placed[exchange.placed.length - 1]!.clientOrderId);
      }
    }
    const atHalt = exchange.placed.length;

    for (const price of ["101", "99", "150", "70"]) {
      const result = await inNamed(name, (bot) => bot.onPriceUpdate(priceAt(price)));
      expect(result.action).toBe("ignored");
    }
    expect(exchange.placed).toHaveLength(atHalt);
  });

  it("does not count a placement the exchange never received", async () => {
    // Backpressure is not a failed attempt. A throttled pass sent NOTHING, so
    // counting it would spend the bot's three chances on a busy account -- the
    // same distinction `#placeBuy` already draws between `rate_limited` and a
    // refusal.
    const name = `ts-cap-throttle-${counter}`;
    await startedTrailingStop(name);

    exchange.nextPlaceFailure = { kind: "rate_limited", message: "budget spent" };
    const throttled = await inNamed(name, (bot) => bot.onPriceUpdate(priceAt("100")));
    expect(throttled.action).toBe("throttled");
    expect(exchange.placed).toHaveLength(0);

    const snap = await inNamed(name, (bot) => bot.snapshot());
    expect(snap.state.entryAttempts ?? 0).toBe(0);
    expect(snap.state.status).toBe("running");
  });
});
