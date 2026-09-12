/**
 * THE ORDER NOTHING OWNED, AND THE REMEDY THAT COULD NOT WORK.
 *
 * ⚠ WHAT PRODUCED THIS FILE. `bot-wfemoo`'s `v1-bot-wfemoo-5` was placed on
 * Kraken, claimed grid level 0, and was then DISPLACED from that level by
 * `v1-bot-wfemoo-8` when the two raced. The `grid_slot_collision` path drops an
 * evicted id from `openOrderIds` by design, and says so in as many words: "it is
 * no longer in openOrderIds and will not be polled or cancelled from the
 * ladder." The bot was halted at 00:02:30; the halt's sweep read
 * `openOrderIds`, which no longer named `-5`; `-8`, still tracked, was
 * cancelled. `-5` is `pending` on the venue to this day.
 *
 * ⚠ THE CONTRADICTION THIS FILE PINS DOWN, asserted rather than described.
 * `/api/integrity/inactive-bots-with-open-orders` reports exactly this state,
 * and its documented remedy was "an operator re-halting the bot, which now
 * completes the cleanup its first halt skipped". It does not. `#halt` on an
 * already-halted bot self-heals the feed subscription and returns
 * `already_halted`, having excluded the cancel sweep DELIBERATELY so that
 * kill-switch passes do not spend risk-exit budget on every halted bot. Both
 * halves are individually right. The remedy was the wrong half, and the test
 * below named `re-halting does NOT cancel it` is the proof -- it passes against
 * the code as it stands, because that behaviour is correct and is not what
 * changed.
 *
 * What changed is that there is now an owner for the gap:
 * `cancelOrphanedOrders`.
 */

import { beforeEach, describe, expect, it } from "vitest";

import { seedPlaceholderTotalBalance } from "../capital";
import type { Database } from "../db/database";
import { freshDatabase } from "../db/test-helpers";
import { fromDecimalString as m } from "../shared/money";
import type { Price } from "../shared/exchange-client";
import type { GridParams } from "../strategies/grid";
import { type BotInstance, type CreateGridBotRequest } from "./bot-instance";
import { FakeExchange, TEST_PAIR } from "./fake-exchange";
import { inBot, noopFeed, rateLimiterStub } from "./test-helpers";

const T0 = 1_900_000_000_000;
const ACTOR = "owner@example.com";
const BOT_ID = "grid-orphan-1";

let db: Database;
let exchange: FakeExchange;
let clock: number;
let idCounter: number;
let objectName: string;
let nameCounter = 0;

/** Levels 90, 95, 100, 105, 110. */
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
  objectName = `grid-orphan-${nameCounter}`;

  await seedPlaceholderTotalBalance(
    db,
    { accountLabel: "main", asset: "USDT", totalBalance: m("10000"), note: "test fixture" },
    { actor: ACTOR, now: T0 },
  );
});

/**
 * Place a REAL order at the venue, then strand it exactly as an eviction does:
 * off `openOrderIds`, off the ladder, but still resting and still recorded
 * locally as non-terminal.
 *
 * The order is placed through the ordinary path rather than written by hand, so
 * what is stranded is a genuine `TrackedOrder` against a genuine resting order
 * -- only the two list memberships are edited, which is precisely and only what
 * `grid_slot_collision` does to an evicted id.
 */
async function strandedOrder(): Promise<string> {
  await run((bot) => bot.createGrid(creation()));
  await run((bot) => bot.start(ACTOR));
  await run((bot) => bot.onPriceUpdate(priceAt("92")));
  const orphanId = exchange.placed[0]!.clientOrderId;

  await inBot(objectName, async (_bot, ctx) => {
    const state = (await ctx.storage.get("state")) as Record<string, unknown>;
    const ladder = state["ladder"] as { slots: unknown[] };
    await ctx.storage.put("state", {
      ...state,
      openOrderIds: [],
      ladder: { ...ladder, slots: ladder.slots.map(() => null) },
    });
  });

  return orphanId;
}

describe("an order stranded off openOrderIds (bot-wfemoo v1-bot-wfemoo-5)", () => {
  it("survives the halt that was supposed to cancel it", async () => {
    const orphanId = await strandedOrder();

    await run((bot) => bot.halt("manual", "operator review", ACTOR));

    // The sweep read `openOrderIds` and found nothing to do.
    expect(exchange.cancelled).not.toContain(orphanId);
    expect(exchange.resting.get(orphanId)!.cancelled).toBe(false);
  });

  /**
   * ⚠ THE DOCUMENTED REMEDY, EXECUTED. This test asserts the BROKEN outcome on
   * purpose: it is what the integrity report told operators to do, and it does
   * nothing. It passes before and after this change, because `#halt`'s
   * behaviour is correct and deliberately unaltered -- what was wrong was the
   * documentation pointing at it. Without this test the correction is a claim;
   * with it, it is measured.
   */
  it("re-halting does NOT cancel it -- the remedy the report used to recommend", async () => {
    const orphanId = await strandedOrder();
    await run((bot) => bot.halt("manual", "operator review", ACTOR));

    const again = await run((bot) => bot.halt("manual", "trying the documented fix", ACTOR));

    expect(again.action).toBe("already_halted");
    expect(exchange.cancelled).not.toContain(orphanId);
    expect(exchange.resting.get(orphanId)!.cancelled).toBe(false);
  });

  it("is swept by cancelOrphanedOrders, which is the action that does work", async () => {
    const orphanId = await strandedOrder();
    await run((bot) => bot.halt("manual", "operator review", ACTOR));

    const result = await run((bot) => bot.cancelOrphanedOrders(ACTOR));

    expect(result.status).toBe("halted");
    expect(result.swept).toEqual([orphanId]);
    expect(result.unresolved).toEqual([]);
    expect(exchange.cancelled).toContain(orphanId);
    expect(exchange.resting.get(orphanId)!.cancelled).toBe(true);

    // Resolved, so it leaves the list the sweep put it on rather than lingering.
    const after = await run((bot) => bot.snapshot());
    expect(after.state.openOrderIds).not.toContain(orphanId);
  });

  /**
   * Section 5.6: an unconfirmed cancellation is NOT a cancellation. The orphan
   * stays tracked, which is what makes a retry meaningful -- and it is no longer
   * an orphan either way, because it is on `openOrderIds` from here on and the
   * poll reads that list.
   */
  it("keeps an orphan it could not confirm, and reports it rather than swallowing it", async () => {
    const orphanId = await strandedOrder();
    await run((bot) => bot.halt("manual", "operator review", ACTOR));
    exchange.cancelFailure = { kind: "transport", message: "cancel unreachable" };

    const result = await run((bot) => bot.cancelOrphanedOrders(ACTOR));

    expect(result.swept).toEqual([]);
    expect(result.unresolved).toEqual([orphanId]);
    expect(await db.alerts.count({ alert_type: "cancel_failed" })).toBeGreaterThan(0);

    const after = await run((bot) => bot.snapshot());
    expect(after.state.openOrderIds).toContain(orphanId);
  });

  it("refuses a running bot rather than cancelling under a live pipeline", async () => {
    await strandedOrder(); // left running on purpose

    await expect(run((bot) => bot.cancelOrphanedOrders(ACTOR))).rejects.toThrow(/halted or stopped/);
  });

  it("is a safe no-op on a halted bot whose orders are all properly tracked", async () => {
    await run((bot) => bot.createGrid(creation()));
    await run((bot) => bot.start(ACTOR));
    await run((bot) => bot.onPriceUpdate(priceAt("92")));
    await run((bot) => bot.halt("manual", "operator review", ACTOR));
    const cancelledByHalt = [...exchange.cancelled];

    const result = await run((bot) => bot.cancelOrphanedOrders(ACTOR));

    expect(result.swept).toEqual([]);
    expect(result.unresolved).toEqual([]);
    expect(exchange.cancelled).toEqual(cancelledByHalt);
  });
});
