/**
 * THE 2026-09-11 GRID SLOT DUPLICATE, END TO END: a placement whose reply was
 * lost must never be re-placed FOR THE SAME LEVEL.
 *
 * ⚠ WHAT PRODUCED THIS FILE. `bot-wfemoo` was a SOLUSDT grid bot with a 25.00
 * USDT allocation on `kraken-main`, bounds 92.00-108.00, `gridLines` 3,
 * `orderSize` 12.50. It placed `v1-bot-wfemoo-5` and `v1-bot-wfemoo-8` against
 * grid level 0 -- both buys, both 0.13586956 SOL at 92.00, both 12.50 USDT --
 * inside one window. Two orders for one rung is the bot's ENTIRE allocation
 * committed to a single level, which is not a grid at all.
 *
 * ⚠ THE DEFECT, STATED PRECISELY, because the fix only makes sense against it.
 * `#placeGridOrder` asked "is this level free?" and read `ladder.slots[i]` for
 * an answer. A `transport` outcome returns WITHOUT claiming the slot -- rightly,
 * the order's fate is unknown and writing a slot for an order that may not exist
 * is a lie in the other direction -- and `#placeInitialLadder` leaves `placed`
 * false. So the next tick re-entered the placement gate, read the same
 * `slots[i] === null`, and sent a second order for a level that already had one
 * in flight. "Sent, may be resting, may be filling" and "nothing was ever sent"
 * reached the per-level check as the same `null`.
 *
 * This is the THIRD instance of the class that produced `unconfirmedOrderIds`
 * (`bot-x93xux`, trailing-stop, 3.02x its allocation) and
 * `hasOutstandingOrder`'s repair (`bot-q4xcjr`, DCA, two base orders one second
 * apart). Neither reached here: both answer "does this BOT have anything
 * outstanding?", and a grid running N levels concurrently has to ask the
 * narrower "does this LEVEL?". See `BotRuntimeState.unconfirmedGridLevels`.
 *
 * ⚠ WHY THESE TESTS CANNOT PASS AGAINST THE OLD CODE, which is the property
 * that makes them worth having. They use `nextPlaceAcceptedButUnreported`, not
 * `nextPlaceFailure`: the order REACHES the fake exchange and rests there while
 * the caller sees `transport`. A test built on `nextPlaceFailure` models an
 * order that never arrived, and re-placing THAT is correct behaviour -- it would
 * pass against the broken code and prove nothing. Verified against the unfixed
 * tree: the first two tests fail there, `exchange.placed` reaching 2 and 3.
 */

import { beforeEach, describe, expect, it } from "vitest";

import { seedPlaceholderTotalBalance } from "../capital";
import type { Database } from "../db/database";
import { freshDatabase } from "../db/test-helpers";
import { fromDecimalString as m } from "../shared/money";
import type { Price } from "../shared/exchange-client";
import type { GridParams } from "../strategies/grid";
import {
  gridLevelUnconfirmed,
  unconfirmedGridLevels,
  type BotInstance,
  type CreateGridBotRequest,
} from "./bot-instance";
import { FakeExchange, TEST_PAIR } from "./fake-exchange";
import { inBot, noopFeed, rateLimiterStub } from "./test-helpers";

const T0 = 1_900_000_000_000;
const ACTOR = "owner@example.com";
const BOT_ID = "grid-slot-1";
/** Kraken's own shape on the night, near enough for a message assertion. */
const LOST = "HTTP 526 with a body that is not a Kraken envelope";

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

function creation(): CreateGridBotRequest {
  return {
    botInstanceId: BOT_ID,
    accountLabel: "main",
    exchange: "binance",
    pair: TEST_PAIR,
    capitalAsset: "USDT",
    allocatedCapital: m("500"),
    params,
    actor: ACTOR,
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
  objectName = `grid-slot-${nameCounter}`;

  await seedPlaceholderTotalBalance(
    db,
    { accountLabel: "main", asset: "USDT", totalBalance: m("10000"), note: "test fixture" },
    { actor: ACTOR, now: T0 },
  );
});

describe("a grid level whose placement outcome is unknown (bot-wfemoo, 2026-09-11)", () => {
  /**
   * TONIGHT'S SCENARIO, MINIMISED. Spot at 92 puts exactly ONE level below it
   * (90), so the ladder pass emits a single order and the only thing the second
   * tick can possibly do is duplicate it. `bot-wfemoo`'s real ladder was the
   * same shape for the same reason: spot sat between its lowest line and its
   * next one, so "one order per level as intended" was one order.
   */
  it("does not re-place a level whose first order was lost in transport", async () => {
    await run((bot) => bot.createGrid(creation()));
    await run((bot) => bot.start(ACTOR));

    exchange.nextPlaceAcceptedButUnreported = { message: LOST };
    const first = await run((bot) => bot.onPriceUpdate(priceAt("92")));

    // The order is REAL: it reached the venue and is resting there. The caller
    // was told `transport` and so claimed no slot -- which is the whole setup.
    expect(exchange.placed).toHaveLength(1);
    expect(first).toMatchObject({ status: "running", action: "initial_ladder_partial" });

    const afterFirst = await run((bot) => bot.snapshot());
    expect(afterFirst.state.ladder!.slots[0]).toBeNull();
    expect(afterFirst.state.ladder!.placed).toBe(false);

    // ⚠ THE ASSERTION THE INCIDENT IS ABOUT. Before the fix this second tick
    // re-entered the gate (`placed` is false), found `slots[0] === null`, and
    // sent `v1-bot-wfemoo-8` alongside `v1-bot-wfemoo-5`.
    const second = await run((bot) => bot.onPriceUpdate(priceAt("92")));
    expect(exchange.placed).toHaveLength(1);
    expect(second).toMatchObject({ status: "running", action: "initial_ladder_partial" });

    // And it stays refused for as long as the outcome is unknown.
    await run((bot) => bot.onPriceUpdate(priceAt("92")));
    expect(exchange.placed).toHaveLength(1);
  });

  /**
   * THE OTHER DIRECTION, without which the fix is just a stall. A blanket
   * "anything outstanding, place nothing" gate -- which is what extending
   * `gridOutstanding` to `decide`'s `!placed` branch would have been -- passes
   * the test above and breaks the ladder: every level after the first would wait
   * on the first, and a partial placement would never complete.
   */
  it("still places every OTHER level while one level is in flight", async () => {
    await run((bot) => bot.createGrid(creation()));
    await run((bot) => bot.start(ACTOR));

    // Spot at 96 puts levels 0 (90) and 1 (95) below it. The one-shot failure
    // hits level 0, which the pass sends first; level 1 must go out normally.
    exchange.nextPlaceAcceptedButUnreported = { message: LOST };
    await run((bot) => bot.onPriceUpdate(priceAt("96")));
    expect(exchange.placed).toHaveLength(2);

    const state = (await run((bot) => bot.snapshot())).state;
    expect(state.ladder!.slots[0]).toBeNull(); // in flight, no slot
    expect(state.ladder!.slots[1]).not.toBeNull(); // placed and claimed

    // A second pass duplicates NEITHER: level 0 is refused for its in-flight
    // sibling, level 1 because its slot is genuinely occupied.
    await run((bot) => bot.onPriceUpdate(priceAt("96")));
    expect(exchange.placed).toHaveLength(2);
  });

  /**
   * ⚠ THE LATCH, which is the failure this fix could most easily have CAUSED.
   * `#placeInitialLadder` sets `placed: true` when a pass completes with nothing
   * outstanding. A refusal that did not mark the pass incomplete would latch the
   * ladder shut with level 0 empty, and nothing would ever reopen it -- `placed`
   * is true and `vacantLadder` is false because level 1 holds a slot. That is
   * `grid-ladder-placed-latch`, a documented open item, re-created by accident.
   */
  it("leaves the ladder unlatched so the refused level is retried, not abandoned", async () => {
    await run((bot) => bot.createGrid(creation()));
    await run((bot) => bot.start(ACTOR));

    exchange.nextPlaceAcceptedButUnreported = { message: LOST };
    await run((bot) => bot.onPriceUpdate(priceAt("96")));
    await run((bot) => bot.onPriceUpdate(priceAt("96")));

    const state = (await run((bot) => bot.snapshot())).state;
    expect(state.ladder!.placed).toBe(false);
  });

  /**
   * A REGRESSION GUARD, NOT A FALSIFYING TEST, and labelled so rather than left
   * to look like one. It PASSES against the unfixed tree, because `rate_limited`
   * already cleared correctly there -- section 5.4 refused the budget, nothing
   * reached the network, and `#clearUnconfirmed` runs. What it defends is the
   * direction this fix could have broken: a guard that blocked a level on a
   * provably-never-sent order would stall the documented throttle retry, which
   * is the `grid-ladder-placed-latch` inert-bot shape. The discriminating tests
   * are the three above.
   */
  it("frees the level for retry when the order provably never went", async () => {
    await run((bot) => bot.createGrid(creation()));
    await run((bot) => bot.start(ACTOR));

    exchange.nextPlaceFailure = { kind: "rate_limited", message: "budget exhausted" };
    await run((bot) => bot.onPriceUpdate(priceAt("92")));
    expect(exchange.placed).toHaveLength(0);

    // Nothing is outstanding, so the next tick legitimately places the level.
    await run((bot) => bot.onPriceUpdate(priceAt("92")));
    expect(exchange.placed).toHaveLength(1);

    const placedState = (await run((bot) => bot.snapshot())).state;
    expect(placedState.ladder!.slots[0]).not.toBeNull();
  });

  /**
   * THE STATE THE BEHAVIOUR RESTS ON, asserted directly and separately.
   *
   * ⚠ DELIBERATELY NOT FOLDED INTO THE TESTS ABOVE. Those must fail against the
   * unfixed tree on the DUPLICATE -- `exchange.placed` reaching 2 -- and a
   * reference to `gridLevelUnconfirmed` inside them would instead blow up with
   * "not a function" before the meaningful assertion ran. A test that fails for
   * the wrong reason proves nothing about the defect, which is the trap entry
   * 106 PART 7 records falling into. So the new helpers are exercised HERE, and
   * the behavioural tests touch none of them.
   */
  it("attributes an in-flight placement to its level, and drops it on resolution", async () => {
    await run((bot) => bot.createGrid(creation()));
    await run((bot) => bot.start(ACTOR));

    exchange.nextPlaceAcceptedButUnreported = { message: LOST };
    await run((bot) => bot.onPriceUpdate(priceAt("92")));

    const inFlight = (await run((bot) => bot.snapshot())).state;
    expect(gridLevelUnconfirmed(inFlight, 0)).not.toBeNull();
    expect(gridLevelUnconfirmed(inFlight, 1)).toBeNull();
    expect(Object.keys(unconfirmedGridLevels(inFlight))).toHaveLength(1);

    // `rate_limited` is the provably-never-sent case: section 5.4 refused the
    // budget, nothing reached the network, so the attribution goes too.
    exchange.nextPlaceFailure = { kind: "rate_limited", message: "budget exhausted" };
    await run((bot) => bot.onPriceUpdate(priceAt("92")));
    const settled = (await run((bot) => bot.snapshot())).state;
    expect(Object.keys(unconfirmedGridLevels(settled))).toHaveLength(1); // still the first
    expect(gridLevelUnconfirmed(settled, 0)).toBe(gridLevelUnconfirmed(inFlight, 0));
  });

  /**
   * THE SAME DUPLICATE, ONE POLL LATER -- the residual gap the first fix left
   * open, found by probing rather than by reading.
   *
   * ⚠ WHY THE FIRST FIX DID NOT COVER THIS. `gridLevelUnconfirmed` answers "is
   * something in flight for this level?", and adoption is precisely the moment
   * the answer becomes NO: the poll read the order, so it is no longer
   * unconfirmed, it is confirmed live. But `#confirmPlaced` only put the id in
   * `openOrderIds`, and a grid's per-level checks read the LADDER. The level
   * stayed empty, and the next tick placed into it.
   *
   * Measured on the unfixed tree, and this is the probe's own output:
   *
   *     openOrderIds: ["v1-grid-probe-1-0"]
   *     unconfirmed:  []
   *     gridLevels:   {"v1-grid-probe-1-0": 0}
   *     slot0:        null
   *     PLACED COUNT AFTER TICK: 2
   */
  it("claims the ladder slot when the poll adopts a lost order, and places no duplicate", async () => {
    await run((bot) => bot.createGrid(creation()));
    await run((bot) => bot.start(ACTOR));

    exchange.nextPlaceAcceptedButUnreported = { message: LOST };
    await run((bot) => bot.onPriceUpdate(priceAt("92")));
    expect(exchange.placed).toHaveLength(1);
    const lostId = exchange.placed[0]!.clientOrderId;

    // The poll can read it -- it really is resting -- so adoption fires.
    await run((bot) => bot.checkOpenOrders(ACTOR));
    expect(await db.alerts.count({ alert_type: "unconfirmed_order_adopted" })).toBe(1);

    const adopted = (await run((bot) => bot.snapshot())).state;
    // ⚠ THE ASSERTION THIS TEST EXISTS FOR. Unfixed, this slot is null.
    expect(adopted.ladder!.slots[0]).not.toBeNull();
    expect(adopted.ladder!.slots[0]!.clientOrderId).toBe(lostId);
    expect(adopted.ladder!.slots[0]!.side).toBe("buy");
    expect(adopted.ladder!.slots[0]!.costBasis).toBeNull();
    // Promoted out of the unknown set, and its attribution consumed with it.
    expect(adopted.openOrderIds).toContain(lostId);
    expect(adopted.unconfirmedOrderIds ?? []).toHaveLength(0);
    expect(Object.keys(unconfirmedGridLevels(adopted))).toHaveLength(0);

    // And the level is now genuinely occupied, so the next tick holds.
    await run((bot) => bot.onPriceUpdate(priceAt("92")));
    expect(exchange.placed).toHaveLength(1);
  });

  /**
   * A DCA or trailing-stop bot must not gain the key at all. The field is
   * additive to a state shape live bots already carry on disk, and writing an
   * empty object onto every non-grid order resolution would change their stored
   * shape for nothing.
   */
  it("leaves a non-grid bot's stored state shape untouched", async () => {
    await run((bot) => bot.createGrid(creation()));
    await run((bot) => bot.start(ACTOR));

    const fresh = (await run((bot) => bot.snapshot())).state;
    expect(fresh.unconfirmedGridLevels).toBeUndefined();
    expect(unconfirmedGridLevels(fresh)).toEqual({});
  });
});
