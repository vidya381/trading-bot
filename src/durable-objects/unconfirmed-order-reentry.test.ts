/**
 * THE 2026-09-11 OVER-ENTRY, END TO END: a placement whose reply was lost must
 * never be re-placed.
 *
 * ⚠ WHAT PRODUCED THIS FILE. `bot-x93xux` was a trailing-stop bot with a
 * 10.00 USDT allocation on `kraken-main`. Kraken was returning HTTP 526. Its
 * single entry was placed THREE times in six seconds -- 07:19:09, 07:19:12,
 * 07:19:15 -- and all three filled, for 30.195234713 USDT against a 10.00 USDT
 * allocation, 3.02x. The account's circuit breaker tripped on the resulting
 * balance drift and halted six bots.
 *
 * `bot-q4xcjr`, a DCA bot on the same account, showed the smaller version of the
 * same defect in the same window: two base orders at an identical price one
 * second apart, both filled.
 *
 * ⚠ THE DEFECT, STATED PRECISELY, because the fix only makes sense against it.
 * `decide` asks "is anything outstanding?" and got `openOrderIds.length > 0` for
 * an answer. On a `transport` failure `#placeBuy` deliberately writes NO
 * `openOrderIds` entry -- correctly, because the order's fate is unknown and
 * inventing a live order would be a lie in the other direction. So "sent, may be
 * resting, may be filling" and "nothing was ever sent" arrived at the strategy
 * as the same `false`, and the strategy did the only thing it could with that.
 *
 * The 3-attempt cap (`MAX_ENTRY_ATTEMPTS`) is what stopped it at 3.02x rather
 * than running indefinitely. A damage cap is not a control, which is why these
 * tests assert ONE order rather than three.
 *
 * ⚠ WHY THESE TESTS CANNOT PASS AGAINST THE OLD CODE, which is the property that
 * makes them worth having. They use `nextPlaceAcceptedButUnreported`, not
 * `nextPlaceFailure`: the order REACHES the fake exchange, rests there, and is
 * fillable, while the caller sees `transport`. A test built on `nextPlaceFailure`
 * models an order that never arrived, and re-placing THAT is correct behaviour --
 * it would pass against the broken code and prove nothing.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { seedPlaceholderTotalBalance } from "../capital";
import type { Database } from "../db/database";
import { freshDatabase } from "../db/test-helpers";
import { fromDecimalString as m, mul, ZERO, type Money } from "../shared/money";
import type { Price } from "../shared/exchange-client";
import { MAX_ENTRY_ATTEMPTS } from "../strategies/trailing-stop";
import type { DcaParams } from "../strategies/dca";
import { FakeExchange } from "./fake-exchange";
import { inBot, noopFeed, rateLimiterStub } from "./test-helpers";
import type { BotInstance } from "./bot-instance";

const ACTOR = "owner@example.com";
const NOW = 1_900_000_000_000;
const PAIR = "BTCUSD";
/** Kraken's own body on the night, near enough for a message assertion. */
const LOST = "HTTP 526 with a body that is not a Kraken envelope";

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

/** The allocation bot-x93xux had, scaled to this fixture's price. */
const ALLOCATION = "1000";

async function startedTrailingStop(name: string, allocated = ALLOCATION): Promise<void> {
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

async function startedDca(name: string): Promise<void> {
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
}

/** Total quote value of everything that actually reached the exchange. */
function notionalSent(): Money {
  return exchange.placed.reduce<Money>(
    (sum, order) => sum + mul(order.price, order.quantity, "floor"),
    ZERO,
  );
}

describe("a placement whose reply was lost is not re-placed (2026-09-11)", () => {
  it("places the trailing-stop entry ONCE when the ack is lost but the order rests", async () => {
    const name = `ts-lost-${counter}`;
    await startedTrailingStop(name);

    // 07:19:09 -- the entry reaches Kraken and rests. The reply does not come back.
    exchange.nextPlaceAcceptedButUnreported = { message: LOST };
    const first = await inNamed(name, (bot) => bot.onPriceUpdate(priceAt("100")));
    expect(first.action).toBe("unresolved");
    expect(exchange.placed).toHaveLength(1);

    // 07:19:12 -- the next candle. THE ASSERTION THE INCIDENT FAILS: the bot
    // still holds no recorded position and has no `openOrderIds` entry, and it
    // must STILL not place a second entry, because one is outstanding.
    const second = await inNamed(name, (bot) => bot.onPriceUpdate(priceAt("100.5")));
    expect(second.action).toBe("hold");
    expect(exchange.placed).toHaveLength(1);
  });

  it("does not merely stop at the 3-attempt cap -- it stops at one", async () => {
    const name = `ts-cap-${counter}`;
    await startedTrailingStop(name);

    exchange.nextPlaceAcceptedButUnreported = { message: LOST };
    await inNamed(name, (bot) => bot.onPriceUpdate(priceAt("100")));

    // Six more candles: more than twice the cap. The old behaviour placed one
    // per candle until `MAX_ENTRY_ATTEMPTS` halted it, so this would be 3.
    for (let i = 0; i < 6; i += 1) {
      await inNamed(name, (bot) => bot.onPriceUpdate(priceAt(`10${i}`)));
    }

    expect(exchange.placed).toHaveLength(1);
    expect(exchange.placed.length).toBeLessThan(MAX_ENTRY_ATTEMPTS);
  });

  it("never commits more than the allocation, which is what the incident cost", async () => {
    const name = `ts-money-${counter}`;
    await startedTrailingStop(name, ALLOCATION);

    exchange.nextPlaceAcceptedButUnreported = { message: LOST };
    await inNamed(name, (bot) => bot.onPriceUpdate(priceAt("100")));
    for (let i = 0; i < 4; i += 1) {
      await inNamed(name, (bot) => bot.onPriceUpdate(priceAt("100")));
    }

    // bot-x93xux committed 3.02x its allocation here.
    expect(notionalSent()).toBeLessThanOrEqual(m(ALLOCATION));
  });

  it("places the DCA base order ONCE when its ack is lost (bot-q4xcjr)", async () => {
    const name = `dca-lost-${counter}`;
    await startedDca(name);

    exchange.nextPlaceAcceptedButUnreported = { message: LOST };
    const first = await inNamed(name, (bot) => bot.onPriceUpdate(priceAt("100")));
    expect(first.action).toBe("unresolved");
    expect(exchange.placed).toHaveLength(1);

    // The second decision, one candle later -- the shape that put two identical
    // base orders on XRPUSDT a second apart.
    const second = await inNamed(name, (bot) => bot.onPriceUpdate(priceAt("100")));
    expect(second.action).toBe("hold");
    expect(exchange.placed).toHaveLength(1);
  });
});

describe("the gate distinguishes the three failure kinds", () => {
  it("DOES retry when the order was provably never sent (rate_limited)", async () => {
    // THE OTHER DIRECTION, and it has to be tested or the fix is just a bot that
    // stops trading. `rate_limited` means section 5.4 refused the budget and
    // nothing reached the network, so the order provably does not exist and
    // re-placing it is correct. `FailureKind` has three values rather than two
    // precisely so this case can be told apart from `transport`.
    const name = `ts-throttled-${counter}`;
    await startedTrailingStop(name);

    exchange.nextPlaceFailure = { kind: "rate_limited", message: "budget_exhausted" };
    const first = await inNamed(name, (bot) => bot.onPriceUpdate(priceAt("100")));
    expect(first.action).toBe("throttled");
    expect(exchange.placed).toHaveLength(0);

    const second = await inNamed(name, (bot) => bot.onPriceUpdate(priceAt("100")));
    expect(second.action).toBe("placed-entry");
    expect(exchange.placed).toHaveLength(1);
  });
});

describe("an unconfirmed order is recovered, not left to stall the bot", () => {
  it("adopts the lost order on the next poll and applies the fill it already took", async () => {
    const name = `ts-adopt-${counter}`;
    await startedTrailingStop(name);

    exchange.nextPlaceAcceptedButUnreported = { message: LOST };
    await inNamed(name, (bot) => bot.onPriceUpdate(priceAt("100")));
    const lostId = exchange.placed[0]!.clientOrderId;

    // It filled on the exchange while this object did not know it existed --
    // exactly TA3MMX-FZX5E-X7IZ2D on the night.
    exchange.fillsByOrder.set(lostId, [exchange.fillFor(lostId)]);

    const pass = await inNamed(name, (bot) => bot.checkOpenOrders(ACTOR));
    expect(pass.applied.map((entry) => entry.clientOrderId)).toContain(lostId);

    // The position is now real and the bot can trail it. Still ONE order.
    const snapshot = await inNamed(name, (bot) => bot.snapshot());
    expect(snapshot.state.position.quantity).toBeGreaterThan(ZERO);
    expect(exchange.placed).toHaveLength(1);
  });

  it("says so, once, when it is holding because of an order it cannot read", async () => {
    // THE STALL MUST NOT BE SILENT. Converting an over-entry into a hold is the
    // right trade, but a bot that quietly declines to trade and says nothing is
    // its own failure mode -- and a harder one to diagnose than the loud
    // overspend it replaced.
    const name = `ts-alert-${counter}`;
    await startedTrailingStop(name);

    exchange.nextPlaceAcceptedButUnreported = { message: LOST };
    await inNamed(name, (bot) => bot.onPriceUpdate(priceAt("100")));
    const lostId = exchange.placed[0]!.clientOrderId;

    // The venue stays unreadable, so the pass cannot adopt it either.
    exchange.orderStatusFailureFor.add(lostId);
    await inNamed(name, (bot) => bot.checkOpenOrders(ACTOR));

    const open = await db.alerts.findMany({
      where: { alert_type: "entry_suppressed_unconfirmed", resolved: false },
    });
    expect(open).toHaveLength(1);
    expect(open[0]!.message).toContain(lostId);

    // STANDING, not one row per pass: three more passes, still one open row.
    for (let i = 0; i < 3; i += 1) {
      await inNamed(name, (bot) => bot.checkOpenOrders(ACTOR));
    }
    const afterRepeats = await db.alerts.findMany({
      where: { alert_type: "entry_suppressed_unconfirmed", resolved: false },
    });
    expect(afterRepeats).toHaveLength(1);

    // And it closes itself once the venue answers, with no human action.
    exchange.orderStatusFailureFor.delete(lostId);
    await inNamed(name, (bot) => bot.checkOpenOrders(ACTOR));
    const afterResolve = await db.alerts.findMany({
      where: { alert_type: "entry_suppressed_unconfirmed", resolved: false },
    });
    expect(afterResolve).toHaveLength(0);
  });

  it("reopens the gate once the unknown order is resolved", async () => {
    const name = `ts-reopen-${counter}`;
    await startedTrailingStop(name);

    exchange.nextPlaceAcceptedButUnreported = { message: LOST };
    await inNamed(name, (bot) => bot.onPriceUpdate(priceAt("100")));
    const lostId = exchange.placed[0]!.clientOrderId;

    // The venue cancelled it instead of filling it: the order is resolved, the
    // bot holds nothing, and a fresh entry is now the RIGHT answer.
    const resting = exchange.resting.get(lostId)!;
    resting.cancelled = true;
    await inNamed(name, (bot) => bot.checkOpenOrders(ACTOR));

    const after = await inNamed(name, (bot) => bot.onPriceUpdate(priceAt("100")));
    expect(after.action).toBe("placed-entry");
    expect(exchange.placed).toHaveLength(2);
  });
});
