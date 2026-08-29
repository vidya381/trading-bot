/**
 * SPEC 22.3, END TO END: a dropped candle must not stop a trailing-stop bot
 * exiting.
 *
 * 22.3 is a HARD PRECONDITION -- "Do not build this strategy without addressing
 * this. It is a hard requirement, not a recommendation." It exists because
 * decision log 81 found a real defect: a fan-out failure drops a candle
 * PERMANENTLY, because `#forwardClosed` advances the watermark regardless of
 * delivery outcome and the dedup guard then suppresses that candle forever.
 *
 * ⚠ HOW THIS DIFFERS FROM `trailing-stop-decide.test.ts`, AND WHY BOTH EXIST.
 * That file drives `decide()` directly with candles omitted from an array; it
 * proves the DECISION RULE is a level test rather than a latched crossing event.
 * It cannot prove that the real feed drops candles the way the rule assumes, nor
 * that a real bot wired to a real feed survives it. THIS file uses the REAL
 * `PriceFeed` object -- its real socket handling, its real `#forwardClosed`, its
 * real fan-out, its real watermark and its real `price_feed_fanout_failed` alert
 * -- and a REAL `BotInstance` created through `createTrailingStop`. The delivery
 * failure is induced exactly as `price-feed.test.ts` induces one: the `deliver`
 * dependency throws for that bot on that candle.
 *
 * ⚠ THE ONE SEAM. The feed decides WHAT IS DELIVERED (including the drop, the
 * watermark advance and the alert); the prices it actually delivers are then
 * handed to the real bot in the order it delivered them. The bot cannot tell the
 * difference -- it receives exactly the `Price` objects the real fan-out
 * produced, and nothing else -- but the two objects are driven from the test
 * rather than through a live RPC hop, because a Durable Object cannot be entered
 * re-entrantly from inside another object's callback in this harness.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { seedPlaceholderTotalBalance } from "../capital";
import type { Database } from "../db/database";
import { freshDatabase } from "../db/test-helpers";
import { fromDecimalString as m, toDecimalString } from "../shared/money";
import type { Price } from "../shared/exchange-client";
import type { FeedSocket, SocketHandlers } from "./price-feed";
import { FakeExchange } from "./fake-exchange";
import { inBot, inFeed, noopFeed, rateLimiterStub } from "./test-helpers";
import type { BotInstance } from "./bot-instance";

const ACTOR = "owner@example.com";
const NOW = 1_785_354_250_000;
const PAIR = "BTCUSD";
const FEED_CONFIG = { exchange: "gemini", pair: PAIR } as const;

/** A single-row rollover message: introducing minute N finalises minute N-1. */
const candle = (openTime: number, close: string): string =>
  JSON.stringify({
    changes: [[openTime, Number(close), Number(close), Number(close), Number(close), 1]],
    symbol: PAIR,
    type: "candles_1m_updates",
  });

const T = (minute: number): number => 1_785_353_940_000 + minute * 60_000;

/** Primes the engine: newest row is the in-progress candle, nothing is forwarded. */
const PRIME = JSON.stringify({
  changes: [[T(0), 63718, 63718, 63718, 63718, 1]],
  symbol: PAIR,
  type: "candles_1m_updates",
});

let db: Database;
let exchange: FakeExchange;
let botName: string;
let counter = 0;

beforeEach(async () => {
  db = await freshDatabase();
  exchange = new FakeExchange();
  exchange.now = NOW;
  counter += 1;
  botName = `ts-drop-${counter}`;
  await seedPlaceholderTotalBalance(
    db,
    { accountLabel: "main", asset: "USD", totalBalance: m("100000"), note: "test fixture" },
    { actor: ACTOR, now: NOW },
  );
});

async function inThisBot<T>(body: (bot: BotInstance) => Promise<T>): Promise<T> {
  return await inBot(botName, async (instance) => {
    instance.attach({
      db,
      exchange,
      now: () => NOW,
      limiterFor: () => rateLimiterStub(`limiter-${botName}`),
      sleep: async () => undefined,
      feedFor: () => noopFeed,
    });
    return await body(instance);
  });
}

class FakeSocket implements FeedSocket {
  readonly #handlers: SocketHandlers;
  constructor(handlers: SocketHandlers) {
    this.#handlers = handlers;
  }
  send(): void {}
  close(): void {}
  async deliver(raw: string): Promise<void> {
    await this.#handlers.onMessage(raw);
  }
}

describe("22.3: a fan-out delivery failure does not stop the exit", () => {
  it("drops the crossing candle for real, then exits on the next delivered one", async () => {
    // --- the bot: 10% trail, so a 70000 peak puts the trail at 63000 ---------
    await inThisBot((bot) =>
      bot.createTrailingStop({
        botInstanceId: botName,
        accountLabel: "main",
        exchange: "gemini",
        pair: PAIR,
        capitalAsset: "USD",
        allocatedCapital: m("1000"),
        params: { trailPct: m("10") },
        actor: ACTOR,
      }),
    );
    await inThisBot((bot) => bot.start(ACTOR));

    // A fresh trailing-stop bot carries NO high-water mark (22.2 decision 3's
    // optional field), no position and no orders.
    const fresh = await inThisBot((bot) => bot.snapshot());
    expect(fresh.state.highWaterMark).toBeUndefined();
    expect(fresh.state.position.quantity).toBe(0n);
    expect(fresh.state.openOrderIds).toEqual([]);
    expect(fresh.state.ladder).toBeUndefined(); // no grid ladder was seeded

    // --- the feed: real object, real fan-out, one delivery made to fail ------
    const sockets: FakeSocket[] = [];
    const delivered: Price[] = [];
    // The candle whose close is 62000 is the one that crosses the trail. It is
    // the one the fan-out will fail on -- the exact shape of decision log 81's
    // defect, applied to the candle that matters most.
    const DROP_AT = m("62000");
    let watermarkAfter: number | null = null;

    await inFeed(`gemini:${PAIR}#${counter}`, async (feed) => {
      feed.attach({
        now: () => NOW,
        connect: async (_url: string, handlers: SocketHandlers) => {
          const socket = new FakeSocket(handlers);
          sockets.push(socket);
          return socket;
        },
        deliver: async (_id, price) => {
          if (price.price === DROP_AT) {
            // The real failure path: a rejected delivery. The feed alerts,
            // counts the failure, and -- the part that matters -- advances its
            // watermark anyway, so this candle can never be redelivered.
            throw new Error("bot unreachable (simulated fan-out failure)");
          }
          delivered.push(price);
        },
      });
      await feed.subscribe(botName, FEED_CONFIG);
      const socket = sockets[0]!;

      await socket.deliver(PRIME);
      await socket.deliver(candle(T(1), "70000")); // finalises 63718 -> ENTRY
      await socket.deliver(candle(T(2), "62000")); // finalises 70000 -> NEW HIGH
      await socket.deliver(candle(T(3), "61000")); // finalises 62000 -> DROPPED
      await socket.deliver(candle(T(4), "61000")); // finalises 61000 -> DELIVERED

      watermarkAfter = (await feed.status()).watermark;
    });

    // --- the feed really dropped it -----------------------------------------
    const prices = delivered.map((p) => toDecimalString(p.price));
    expect(prices).toEqual(["63718.00000000", "70000.00000000", "61000.00000000"]);
    // The crossing candle is absent, and the watermark has advanced PAST it --
    // decision log 81's "suppressed forever". There is no retry to wait for.
    expect(prices).not.toContain("62000.00000000");
    expect(watermarkAfter).toBeGreaterThan(T(2));

    const fanoutAlerts = await db.alerts.findMany({
      where: { alert_type: "price_feed_fanout_failed" },
    });
    expect(fanoutAlerts).toHaveLength(1);
    expect(fanoutAlerts[0]!.bot_instance_id).toBe(botName);

    // --- the bot consumes exactly what the feed delivered --------------------
    // 1. The entry price opens the single entry, which is then filled.
    await inThisBot((bot) => bot.onPriceUpdate(delivered[0]!));
    const entryOrderId = exchange.placed[0]!.clientOrderId;
    expect(exchange.placed[0]!.side).toBe("buy");
    await inThisBot((bot) => bot.onFill(entryOrderId, exchange.fillFor(entryOrderId)));

    // 2. The new high ratchets the mark. No exit: 70000 is the peak itself.
    await inThisBot((bot) => bot.onPriceUpdate(delivered[1]!));
    const afterHigh = await inThisBot((bot) => bot.snapshot());
    expect(afterHigh.state.highWaterMark).toBe(m("70000"));
    expect(afterHigh.state.status).toBe("running");
    // Nothing was sold on the strength of a candle it never saw.
    expect(exchange.placed.filter((o) => o.side === "sell")).toHaveLength(0);

    // 3. THE POINT OF THE TEST. The 62000 candle never arrived. The next
    //    delivered candle is 61000, still below the 63000 trail, and the bot
    //    exits on it rather than sitting behind a crossing it never saw.
    await inThisBot((bot) => bot.onPriceUpdate(delivered[2]!));

    const sells = exchange.placed.filter((o) => o.side === "sell");
    expect(sells).toHaveLength(1);

    const afterExit = await inThisBot((bot) => bot.snapshot());
    expect(afterExit.state.exitKind).toBe("trailing_stop");
    // The mark did NOT follow price down through the drop.
    expect(afterExit.state.highWaterMark).toBe(m("70000"));
  });

  it("the schema-version assertion really runs on every read, not just on write", async () => {
    await inThisBot((bot) =>
      bot.createTrailingStop({
        botInstanceId: botName,
        accountLabel: "main",
        exchange: "gemini",
        pair: PAIR,
        capitalAsset: "USD",
        allocatedCapital: m("1000"),
        params: { trailPct: m("10") },
        actor: ACTOR,
      }),
    );

    // Creation stamped the strategy's OWN version, not DCA's or grid's.
    const snap = await inThisBot((bot) => bot.snapshot());
    expect(snap.config.schemaVersion).toBe(1);
    expect(snap.config.strategy).toBe("trailing_stop");

    // Now corrupt the stored config's version and confirm the NEXT read refuses
    // it. This is what proves `assertReadableTrailingStopSchema` is actually
    // invoked on the read path rather than merely existing -- a version the code
    // cannot read must not be operated on (section 16).
    await inBot(botName, async (_instance, state) => {
      const stored = (await state.storage.get("config")) as Record<string, unknown>;
      await state.storage.put("config", { ...stored, schemaVersion: 99 });
    });
    await expect(inThisBot((bot) => bot.snapshot())).rejects.toThrow(/schemaVersion 99/);
  });

  it("refuses creation with an invalid trailPct, using the real validator's message", async () => {
    // Touchpoint 7's validator, reached through the creation path rather than
    // called directly -- 25% is outside the provisional 1-20% range.
    await expect(
      inThisBot((bot) =>
        bot.createTrailingStop({
          botInstanceId: botName,
          accountLabel: "main",
          exchange: "gemini",
          pair: PAIR,
          capitalAsset: "USD",
          allocatedCapital: m("1000"),
          params: { trailPct: m("25") },
          actor: ACTOR,
        }),
      ),
    ).rejects.toThrow(/PROVISIONAL/);

    // And nothing was created: the refusal is before any capital is reserved.
    const rows = await db.botInstances.findMany({ where: { id: botName } });
    expect(rows).toHaveLength(0);
  });
});
