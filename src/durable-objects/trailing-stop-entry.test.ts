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
import { fromDecimalString as m, mul, ZERO, type Money } from "../shared/money";
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

/**
 * The venue takes the entry away with no request from this system, and the real
 * poll then discovers it -- which is what clears `openOrderIds` and lets
 * `decide` ask for the entry again.
 *
 * MODULE SCOPE rather than inside one `describe`: the resume block at the foot
 * of this file drives a bot to the cap the same way, and a second copy of this
 * would be a second definition of "the venue cancelled it" free to drift from
 * the one the cap tests use.
 */
async function loseEntryToTheVenue(name: string, clientOrderId: string): Promise<void> {
  const resting = exchange.resting.get(clientOrderId);
  if (resting === undefined) throw new Error(`no resting order ${clientOrderId}`);
  resting.cancelled = true;
  const pass = await inNamed(name, (bot) => bot.checkOpenOrders(ACTOR));
  expect(pass.closed).toContain(clientOrderId);
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

/**
 * SPEC 22.10, THE OTHER HALF: the cap must also be visible to `resume`.
 *
 * ⚠ WHAT PRODUCED THIS BLOCK, and like the file's own header it is an incident
 * rather than a design note. `bot-ts1` on gemini-main testnet halted
 * `entry_unfilled` on 2026-09-01 and was resumed repeatedly over the following
 * week. Every resume SUCCEEDED -- `{status: "running", action: "resumed"}`, a
 * `bot.resumed` audit row, `running` mirrored to D1 -- and every one of them was
 * undone by the next candle, which re-halted the bot for the same reason. The
 * orders table gained nothing after 2026-09-01T22:42.
 *
 * The cause is that `#resumePass` clears `status`, `haltReason`, `haltedAt` and
 * `postHaltEvents` AND NOTHING ELSE, so `entryAttempts` survives -- correctly,
 * since the field is documented "Never reset". `decide` then re-reads the
 * carried-over count and its 22.10 gate fires BEFORE `open_entry` can be
 * returned, so `#placeTrailingStopEntry` is never reached and no order is ever
 * sent. Everything there is behaving as designed except `resume`, which
 * advertised a retry it could not deliver.
 *
 * ⚠ WHY THE ASSERTIONS BELOW ARE ABOUT WHAT DID *NOT* HAPPEN. A test that only
 * checked `rejects` would also pass against the old code if the throw were moved
 * anywhere after the status writes -- which is the exact bug, one layer along:
 * a bot flipped to `running`, its halt alert closed, and then refused. So these
 * pin the absence of every side effect the successful-looking resume had.
 */
describe("resume respects the entry cap it cannot reset (22.10)", () => {
  /** Drive a fresh bot to the cap and leave it halted `entry_unfilled`. */
  async function haltedAtTheCap(name: string): Promise<void> {
    await startedTrailingStop(name);
    for (let candle = 0; candle < MAX_ENTRY_ATTEMPTS + 1; candle += 1) {
      const before = exchange.placed.length;
      await inNamed(name, (bot) => bot.onPriceUpdate(priceAt("100")));
      if (exchange.placed.length > before) {
        await loseEntryToTheVenue(name, exchange.placed[exchange.placed.length - 1]!.clientOrderId);
      }
    }
    const snap = await inNamed(name, (bot) => bot.snapshot());
    expect(snap.state.status).toBe("halted");
    expect(snap.state.entryAttempts).toBe(MAX_ENTRY_ATTEMPTS);
  }

  it("refuses the resume outright rather than accepting it and re-halting", async () => {
    const name = `ts-resume-cap-${counter}`;
    await haltedAtTheCap(name);
    const placedAtHalt = exchange.placed.length;

    await expect(inNamed(name, (bot) => bot.resume(ACTOR))).rejects.toMatchObject({
      code: "entry_budget_spent",
    });

    // THE REFUSAL IS BEFORE EVERY WRITE. Same property the drift gate has, and
    // it is what separates this fix from the bug: a gate that flipped the status
    // first would leave exactly the misleading `running` row the incident had.
    const snap = await inNamed(name, (bot) => bot.snapshot());
    expect(snap.state.status).toBe("halted");
    expect(snap.state.entryAttempts).toBe(MAX_ENTRY_ATTEMPTS);
    expect((await db.botInstances.findOne({ id: name }))!.status).toBe("halted");
    // The halt reason is NOT cleared, because the clear lives past the throw.
    expect(snap.state.haltReason ?? "").toContain("entry_unfilled");

    // The halt alert stays OPEN. `resolveHaltAlerts` runs after the status
    // writes, so a refused resume must not have closed it -- an operator
    // counting open criticals has to keep seeing this bot.
    expect(await db.alerts.count({ alert_type: "halt_entry_unfilled", resolved: false })).toBe(1);

    // No audit row claiming a resume that did not happen.
    expect(await db.auditLog.count({ target_bot_instance_id: name, action: "bot.resumed" })).toBe(0);

    // And the point of the whole exercise: still nothing on the exchange.
    expect(exchange.placed).toHaveLength(placedAtHalt);
  });

  it("says why, in terms an operator can act on -- including that retrying will not help", async () => {
    const name = `ts-resume-cap-msg-${counter}`;
    await haltedAtTheCap(name);

    const error = await inNamed(name, (bot) => bot.resume(ACTOR)).catch((e: unknown) => e);
    const message = error instanceof Error ? error.message : String(error);

    // What happened, and how many times.
    expect(message).toContain(`placed ${MAX_ENTRY_ATTEMPTS} times`);
    // That a resume would place nothing -- the fact the successful-looking
    // resume hid for a week.
    expect(message).toMatch(/place\s+NOTHING/);
    // That this is terminal, not a condition to clear and retry. This is the
    // sentence that distinguishes the message from `position_unverified`'s,
    // which correctly tells the operator to go and fix something.
    expect(message).toMatch(/create a new bot/);
    // And a pointer at the real open question, so the new bot is not started
    // blind into the same venue behaviour.
    expect(message).toMatch(/cancelled at the venue/);
  });

  it("resumes a bot at the cap that actually HOLDS a position (2026-09-11)", async () => {
    // ⚠ THE REFUSAL THIS PROVES WRONG, and it cost a real position. The gate
    // read `entryAttempts` and nothing else, and then SPOKE as though it had
    // checked the position: "without ever filling", "this bot never got it, so
    // there is no position to trail". Both are inferences from the counter, and
    // both are false for the bot below.
    //
    // `bot-x93xux` was refused this way on 2026-09-11 while holding 2.59420419
    // LINK worth 29.96 USDT. Its trailing stop could not run, so the stop was
    // unenforceable, and the only way out was to liquidate a position the
    // strategy was perfectly capable of managing.
    //
    // ⚠ AND THE SEQUENCE IS ORDINARY, not a legacy artefact. Two entries
    // cancelled at the venue is exactly what `MAX_ENTRY_ATTEMPTS = 3` was sized
    // to absorb ("Three allows two transient cancellations to be absorbed
    // silently"), and the third one filling is the strategy WORKING. Any
    // account-wide halt after that -- a circuit breaker, an operator pause --
    // then made the bot permanently unresumable.
    const name = `ts-cap-held-${counter}`;
    await startedTrailingStop(name);

    // Two entries lost to the venue: attempts 1 and 2, still flat.
    for (let i = 0; i < 2; i += 1) {
      await inNamed(name, (bot) => bot.onPriceUpdate(priceAt("100")));
      await loseEntryToTheVenue(name, exchange.placed[exchange.placed.length - 1]!.clientOrderId);
    }

    // The third entry is placed -- the cap is now spent -- and it FILLS.
    await inNamed(name, (bot) => bot.onPriceUpdate(priceAt("100")));
    const entryId = exchange.placed[exchange.placed.length - 1]!.clientOrderId;
    exchange.fillsByOrder.set(entryId, [exchange.fillFor(entryId)]);
    const pass = await inNamed(name, (bot) => bot.checkOpenOrders(ACTOR));
    expect(pass.applied.map((e) => e.clientOrderId)).toContain(entryId);

    // The state the gate has to reason about: cap spent AND a real position.
    const held = await inNamed(name, (bot) => bot.snapshot());
    expect(held.state.entryAttempts).toBe(MAX_ENTRY_ATTEMPTS);
    expect(held.state.position.quantity).toBeGreaterThan(ZERO);

    // Halted for an unrelated reason -- the account-wide breaker on the night.
    await inNamed(name, (bot) =>
      bot.halt("manual", "account circuit breaker tripped for this account", ACTOR),
    );

    // THE ASSERTION THE OLD GATE FAILS: this resume must be allowed.
    const resumed = await inNamed(name, (bot) => bot.resume(ACTOR));
    expect(resumed.status).toBe("running");

    // And it must actually TRAIL, not sit there or re-halt. `decide` checks
    // `position.quantity <= ZERO` first, so a bot holding something never
    // reaches the cap branch at all -- which is the whole reason the refusal's
    // prediction ("re-halts it with the same entry_unfilled reason") was wrong.
    const placedBefore = exchange.placed.length;
    const tick = await inNamed(name, (bot) => bot.onPriceUpdate(priceAt("101")));
    expect(tick.status).toBe("running");
    expect(tick.action).not.toBe("halt");
    // No new entry either: the cap still bars THAT, it just no longer bars the
    // bot from managing what it already owns.
    expect(exchange.placed).toHaveLength(placedBefore);

    // And the trail is live: a crash through it exits rather than being ignored.
    const exit = await inNamed(name, (bot) => bot.onPriceUpdate(priceAt("50")));
    expect(exit.action).toBe("placed-trailing-exit");
  });

  it("still refuses when the cap is spent AND the bot is genuinely flat", async () => {
    // The other half, so the fix does not simply delete the latch. This is the
    // case the gate was built for and it must be untouched.
    const name = `ts-cap-flat-${counter}`;
    await haltedAtTheCap(name);
    const snap = await inNamed(name, (bot) => bot.snapshot());
    expect(snap.state.position.quantity).toBe(ZERO);

    await expect(inNamed(name, (bot) => bot.resume(ACTOR))).rejects.toMatchObject({
      code: "entry_budget_spent",
    });
  });

  it("still resumes a trailing stop that has attempts left", async () => {
    // The gate is the CAP, not the counter being non-zero. A bot that used one
    // attempt and halted for some other reason must resume normally, or this
    // fix would quietly retire bots that are entitled to keep trying.
    const name = `ts-resume-under-${counter}`;
    await startedTrailingStop(name);
    await inNamed(name, (bot) => bot.onPriceUpdate(priceAt("100")));
    await loseEntryToTheVenue(name, exchange.placed[exchange.placed.length - 1]!.clientOrderId);
    await inNamed(name, (bot) => bot.halt("manual", "operator paused for review", ACTOR));

    const before = await inNamed(name, (bot) => bot.snapshot());
    expect(before.state.entryAttempts).toBe(1);

    const resumed = await inNamed(name, (bot) => bot.resume(ACTOR));
    expect(resumed.action).toBe("resumed");

    const after = await inNamed(name, (bot) => bot.snapshot());
    expect(after.state.status).toBe("running");
    // Carried over, NOT reset. The resume is allowed; the budget still shrinks.
    expect(after.state.entryAttempts).toBe(1);
  });

  it("never refuses a DCA bot, whose entries this counter does not describe", async () => {
    // The gate is strategy-scoped by construction rather than by arithmetic.
    // DCA's ladder places many buys and bounds them its own way; if this gate
    // ever read the field without checking the strategy, a busy DCA bot would
    // become unresumable for a reason that does not apply to it.
    const name = `dca-resume-${counter}`;
    await inNamed(name, (bot) =>
      bot.create({
        botInstanceId: name,
        accountLabel: "main",
        exchange: "gemini",
        pair: PAIR,
        capitalAsset: "USD",
        allocatedCapital: m("1000"),
        params: DCA_PARAMS,
        actor: ACTOR,
      }),
    );
    await inNamed(name, (bot) => bot.start(ACTOR));
    await inNamed(name, (bot) => bot.halt("manual", "operator paused for review", ACTOR));

    const resumed = await inNamed(name, (bot) => bot.resume(ACTOR));
    expect(resumed.action).toBe("resumed");
  });
});
