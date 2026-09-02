/**
 * The `PriceFeed` Durable Object — the Session C1 STREAM ENGINE, against real
 * Durable Object storage in the Workers runtime.
 *
 * These drive `handleMessage` with the ACTUAL Gemini sandbox payloads the step 14
 * probe captured (the six single-row rollover messages, verbatim), plus a
 * realistic replay batch, and assert on what the engine forwards. The forward
 * seam is a collector here; Session C2 makes it a fan-out. No socket, no alarm,
 * no backfill yet — those are the later C1 layers that DRIVE this engine.
 *
 * The forwarding model under test is CURRENT-ONLY, which the probe confirmed 6/6:
 * a rollover message carries only the new candle, so the previous in-progress
 * candle is finalised the moment a newer openTime appears.
 */

import { beforeEach, describe, expect, it } from "vitest";

import type { Database } from "../db/database";
import { botInstanceRow, freshDatabase } from "../db/test-helpers";
import { fromDecimalString as m } from "../shared/money";
import type { Price } from "../shared/exchange-client";
import type { FeedSocket, PriceFeed, SocketHandlers } from "./price-feed";
import { httpUrlForWebSocket, openOutboundSocket } from "./price-feed";
import { inFeed } from "./test-helpers";

const NOW = 1_785_354_250_000; // receipt clock; Price.at is this, not the candle time
const CONFIG = { exchange: "gemini", pair: "BTCUSD" } as const;

/**
 * A realistic replay batch, newest row = 19:39:00 (one minute before the first
 * real rollover). Only the newest is the in-progress candle; the engine primes
 * from it and forwards none of the history.
 */
const BATCH = JSON.stringify({
  changes: [
    [1785353820000, 63710, 63715, 63705, 63712.5, 1.0], // 19:37:00
    [1785353880000, 63712.5, 63718, 63711, 63715.0, 1.2], // 19:38:00
    [1785353940000, 63715.0, 63720, 63713, 63718.0, 0.5], // 19:39:00 (current at connect)
  ],
  symbol: "BTCUSD",
  type: "candles_1m_updates",
});

/**
 * The six single-row rollover messages captured verbatim by the probe. Each
 * introduces a new minute's candle (and, being CURRENT-ONLY, nothing else), which
 * finalises the previous one. All OHLC are 63719.06 (a flat sandbox); volume
 * varies.
 */
const ROLLOVER = {
  "1940": '{"changes":[[1785354000000,63719.06,63719.06,63719.06,63719.06,0.0009]],"symbol":"BTCUSD","type":"candles_1m_updates"}',
  "1941": '{"changes":[[1785354060000,63719.06,63719.06,63719.06,63719.06,0.001603]],"symbol":"BTCUSD","type":"candles_1m_updates"}',
  "1942": '{"changes":[[1785354120000,63719.06,63719.06,63719.06,63719.06,0.002758]],"symbol":"BTCUSD","type":"candles_1m_updates"}',
  "1943": '{"changes":[[1785354180000,63719.06,63719.06,63719.06,63719.06,0.002482]],"symbol":"BTCUSD","type":"candles_1m_updates"}',
  "1944": '{"changes":[[1785354240000,63719.06,63719.06,63719.06,63719.06,0.001528]],"symbol":"BTCUSD","type":"candles_1m_updates"}',
};

/** A distinct feed key per test, so persisted watermarks never leak between them. */
let counter = 0;
const freshKey = () => `gemini:BTCUSD#${counter++}`;

let db: Database;
beforeEach(async () => {
  db = await freshDatabase();
});

/**
 * Give a bot a real `bot_instances` row.
 *
 * `alerts.bot_instance_id` is a FOREIGN KEY, so attribution is only observable
 * for a bot that actually exists — and the feed falls back to a null id rather
 * than losing the alert when it does not (see `PriceFeed.#alert`). A test that
 * asserts on attribution must therefore seed the row first; one that does not
 * seed it is asserting on the fallback.
 */
async function seedBot(id: string): Promise<void> {
  await db.botInstances.insert(botInstanceRow({ id, pair: "BTCUSD", exchange: "gemini" }));
}

/** Drive a fresh feed through `steps`, collecting everything it forwards. */
async function run(steps: (feed: PriceFeed) => Promise<void>): Promise<Price[]> {
  const forwarded: Price[] = [];
  await inFeed(freshKey(), async (feed) => {
    feed.attach({ now: () => NOW, forward: async (p) => void forwarded.push(p) });
    await feed.configure(CONFIG);
    feed.beginConnection();
    await steps(feed);
  });
  return forwarded;
}

/** A test double for the outbound socket, driven by the test. */
class FakeSocket implements FeedSocket {
  readonly sent: string[] = [];
  closed = false;
  readonly #handlers: SocketHandlers;
  constructor(handlers: SocketHandlers) {
    this.#handlers = handlers;
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.closed = true;
  }
  /** Simulate an inbound frame. */
  async deliver(raw: string): Promise<void> {
    await this.#handlers.onMessage(raw);
  }
  /** Simulate the socket closing/erroring. */
  async drop(): Promise<void> {
    await this.#handlers.onClose();
  }
}

/** An injectable `connect` whose success/failure the test controls. */
function fakeConnect() {
  const sockets: FakeSocket[] = [];
  let failing = 0;
  return {
    sockets,
    /** Make the next `n` connect attempts throw. */
    failNext(n: number): void {
      failing = n;
    },
    connect: async (_url: string, handlers: SocketHandlers): Promise<FeedSocket> => {
      if (failing > 0) {
        failing -= 1;
        throw new Error("connect failed");
      }
      const socket = new FakeSocket(handlers);
      sockets.push(socket);
      return socket;
    },
  };
}

describe("priming", () => {
  it("consumes the replay batch to set the current candle and forwards NO history", async () => {
    const forwarded = await run(async (feed) => {
      await feed.handleMessage(BATCH);
    });
    expect(forwarded).toEqual([]);
  });
});

describe("rollover forwarding (CURRENT-ONLY)", () => {
  it("finalises the previous candle on each newer openTime, close price and receipt time", async () => {
    const forwarded = await run(async (feed) => {
      await feed.handleMessage(BATCH);
      await feed.handleMessage(ROLLOVER["1940"]);
      await feed.handleMessage(ROLLOVER["1941"]);
      await feed.handleMessage(ROLLOVER["1942"]);
      await feed.handleMessage(ROLLOVER["1943"]);
      await feed.handleMessage(ROLLOVER["1944"]);
    });

    // Five finalised: 19:39 (from the batch), then 19:40..19:43. 19:44 is the new
    // current and stays unforwarded until it in turn rolls over.
    expect(forwarded).toHaveLength(5);
    expect(forwarded.map((p) => p.price)).toEqual([
      m("63718.00"),
      m("63719.06"),
      m("63719.06"),
      m("63719.06"),
      m("63719.06"),
    ]);
    expect(forwarded.every((p) => p.pair === "BTCUSD")).toBe(true);
    expect(forwarded.every((p) => p.at === NOW)).toBe(true);
  });

  it("keeps the LATEST OHLCV of an in-place update when it finalises", async () => {
    const inPlace = // same openTime as the batch's current (19:39:00), newer close
      '{"changes":[[1785353940000,63715,63722,63713,63999.00,0.9]],"symbol":"BTCUSD","type":"candles_1m_updates"}';
    const forwarded = await run(async (feed) => {
      await feed.handleMessage(BATCH); // current = 19:39 @ close 63718
      await feed.handleMessage(inPlace); // in-place: current 19:39 @ close 63999
      await feed.handleMessage(ROLLOVER["1940"]); // finalise 19:39
    });
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0]!.price).toBe(m("63999.00"));
  });
});

describe("watermark / dedup", () => {
  it("never forwards a candle at or below the watermark (monotonic, out-of-order safe)", async () => {
    const stale = // 19:42:00, already forwarded, arriving again out of order
      '{"changes":[[1785354120000,63719.06,63719.06,63719.06,63719.06,0.5]],"symbol":"BTCUSD","type":"candles_1m_updates"}';
    const forwarded = await run(async (feed) => {
      await feed.handleMessage(BATCH);
      await feed.handleMessage(ROLLOVER["1940"]);
      await feed.handleMessage(ROLLOVER["1941"]);
      await feed.handleMessage(ROLLOVER["1942"]);
      await feed.handleMessage(ROLLOVER["1943"]); // watermark now past 19:42
      await feed.handleMessage(stale); // older than current, at/below watermark
    });
    // 19:39..19:42 forwarded (4); the stale 19:42 re-arrival is deduped.
    expect(forwarded).toHaveLength(4);
    expect(forwarded.map((p) => p.price)).toEqual([
      m("63718.00"),
      m("63719.06"),
      m("63719.06"),
      m("63719.06"),
    ]);
  });

  it("backfills the reconnect gap from the replay batch, deduping already-forwarded candles", async () => {
    // After forwarding through 19:42, a reconnect replays a fresh batch spanning
    // 19:41..19:45. The WS-batch backfill (14.3) forwards the closed candles newer
    // than the watermark — 19:43 and 19:44 (the outage gap) — and the watermark
    // dedups 19:41/19:42 (already sent). 19:45 is the new in-progress candle.
    const reconnectBatch = JSON.stringify({
      changes: [
        [1785354060000, 63719.06, 63719.06, 63719.06, 63719.06, 0.1], // 19:41 (already sent)
        [1785354120000, 63719.06, 63719.06, 63719.06, 63719.06, 0.2], // 19:42 (already sent)
        [1785354180000, 63719.06, 63719.06, 63719.06, 63719.06, 0.3], // 19:43 (gap)
        [1785354240000, 63719.06, 63719.06, 63719.06, 63719.06, 0.4], // 19:44 (gap)
        [1785354300000, 63719.06, 63720.0, 63719.0, 63719.5, 0.5], // 19:45 (new current)
      ],
      symbol: "BTCUSD",
      type: "candles_1m_updates",
    });

    const forwarded = await run(async (feed) => {
      await feed.handleMessage(BATCH);
      for (const k of ["1940", "1941", "1942", "1943"] as const) {
        await feed.handleMessage(ROLLOVER[k]); // forwards 19:39..19:42
      }
      feed.beginConnection(); // simulate reconnect
      await feed.handleMessage(reconnectBatch); // backfills 19:43, 19:44
    });

    // 19:39..19:42 live, then 19:43/19:44 from the batch backfill — 6 total, none
    // doubled, 19:45 held as the new current.
    expect(forwarded).toHaveLength(6);
    expect(forwarded.map((p) => p.price)).toEqual([
      m("63718.00"),
      m("63719.06"),
      m("63719.06"),
      m("63719.06"),
      m("63719.06"),
      m("63719.06"),
    ]);
  });
});

describe("non-candle and unconfigured frames", () => {
  it("records a system alert for a malformed message of a known type", async () => {
    const malformed = // candles_1m_updates with a too-short row
      '{"changes":[[1785354000000,1,2,3]],"symbol":"BTCUSD","type":"candles_1m_updates"}';
    const forwarded = await run(async (feed) => {
      await feed.handleMessage(malformed);
    });
    expect(forwarded).toEqual([]);
    const alerts = await db.alerts.findMany({ where: { alert_type: "price_feed_malformed" } });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.category).toBe("system");
    expect(alerts[0]!.bot_instance_id).toBeNull();
  });

  it("ignores a heartbeat (no candle, no alert, no throw)", async () => {
    const forwarded = await run(async (feed) => {
      await feed.handleMessage('{"timestamp":1785354088542,"type":"heartbeat"}');
    });
    expect(forwarded).toEqual([]);
    expect(await db.alerts.count({})).toBe(0);
  });

  it("does nothing when a message arrives before the feed is configured", async () => {
    const forwarded: Price[] = [];
    await inFeed(freshKey(), async (feed) => {
      feed.attach({ now: () => NOW, forward: async (p) => void forwarded.push(p) });
      // No configure() call.
      await feed.handleMessage(ROLLOVER["1940"]);
    });
    expect(forwarded).toEqual([]);
  });
});

describe("socket lifecycle, alarm, and backoff", () => {
  const SUBSCRIBE = JSON.stringify({
    type: "subscribe",
    subscriptions: [{ name: "candles_1m", symbols: ["BTCUSD"] }],
  });

  it("startFeed opens a socket, sends the subscribe frame, and forwards delivered frames", async () => {
    const forwarded: Price[] = [];
    const fake = fakeConnect();
    await inFeed(freshKey(), async (feed) => {
      feed.attach({ now: () => NOW, forward: async (p) => void forwarded.push(p), connect: fake.connect });
      await feed.startFeed(CONFIG);
      expect(fake.sockets).toHaveLength(1);
      expect(fake.sockets[0]!.sent).toEqual([SUBSCRIBE]);
      await fake.sockets[0]!.deliver(BATCH);
      await fake.sockets[0]!.deliver(ROLLOVER["1940"]);
    });
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0]!.price).toBe(m("63718.00"));
  });

  it("reconnects and re-subscribes when the socket closes", async () => {
    let clock = NOW;
    const fake = fakeConnect();
    await inFeed(freshKey(), async (feed) => {
      feed.attach({ now: () => clock, forward: async () => {}, connect: fake.connect });
      // A REAL SUBSCRIBER, not a bare startFeed: `alarm()` now stops any feed
      // whose registry is empty, so a reconnect/backoff test must have someone
      // listening or it is exercising the zero-subscriber backstop instead.
      await feed.subscribe("bot-a", CONFIG);
      await fake.sockets[0]!.deliver(BATCH);
      await fake.sockets[0]!.drop(); // schedules a reconnect on the alarm
      clock += 2_000;
      await feed.alarm(); // reconnect attempt
      expect(fake.sockets).toHaveLength(2);
      expect(fake.sockets[1]!.sent).toEqual([SUBSCRIBE]);
    });
  });

  it("treats a stale connection (no frames within the window) as dead and reconnects", async () => {
    let clock = NOW;
    const fake = fakeConnect();
    await inFeed(freshKey(), async (feed) => {
      feed.attach({ now: () => clock, forward: async () => {}, connect: fake.connect });
      // A REAL SUBSCRIBER, not a bare startFeed: `alarm()` now stops any feed
      // whose registry is empty, so a reconnect/backoff test must have someone
      // listening or it is exercising the zero-subscriber backstop instead.
      await feed.subscribe("bot-a", CONFIG);
      await fake.sockets[0]!.deliver(BATCH); // lastMessageAt = NOW
      clock += 25_000; // > STALENESS_MS, and no frames since
      await feed.alarm(); // stale: tear the dead socket down and schedule a reconnect
      expect(fake.sockets[0]!.closed).toBe(true);
      expect(fake.sockets).toHaveLength(1); // not reconnected yet — that is the next alarm
      clock += 2_000;
      await feed.alarm(); // reconnect
      expect(fake.sockets).toHaveLength(2);
      expect(fake.sockets[1]!.sent).toEqual([SUBSCRIBE]);
    });
  });

  it("stays connected on a healthy alarm (a recent frame within the window)", async () => {
    let clock = NOW;
    const fake = fakeConnect();
    await inFeed(freshKey(), async (feed) => {
      feed.attach({ now: () => clock, forward: async () => {}, connect: fake.connect });
      // A REAL SUBSCRIBER, not a bare startFeed: `alarm()` now stops any feed
      // whose registry is empty, so a reconnect/backoff test must have someone
      // listening or it is exercising the zero-subscriber backstop instead.
      await feed.subscribe("bot-a", CONFIG);
      clock += 5_000;
      await fake.sockets[0]!.deliver('{"timestamp":1,"type":"heartbeat"}'); // liveness
      clock += 10_000; // < STALENESS_MS since the heartbeat
      await feed.alarm();
      expect(fake.sockets[0]!.closed).toBe(false);
      expect(fake.sockets).toHaveLength(1); // no reconnect
    });
  });

  it("goes blind after 5 failed reconnects (alert once), then escalates past 30 minutes", async () => {
    let clock = NOW;
    const fake = fakeConnect();
    await inFeed(freshKey(), async (feed) => {
      feed.attach({ now: () => clock, forward: async () => {}, connect: fake.connect });
      // A REAL SUBSCRIBER, not a bare startFeed: `alarm()` now stops any feed
      // whose registry is empty, so a reconnect/backoff test must have someone
      // listening or it is exercising the zero-subscriber backstop instead.
      await feed.subscribe("bot-a", CONFIG);
      await fake.sockets[0]!.drop(); // attempts = 1
      fake.failNext(100); // every reconnect from here fails
      for (let i = 0; i < 5; i++) {
        clock += 20_000;
        await feed.alarm(); // attempts 2,3,4,5,6 — the 5th crosses the limit -> blind
      }
      clock += 31 * 60_000; // stay blind past the escalation window
      await feed.alarm();
    });
    expect(await db.alerts.count({ alert_type: "price_feed_blind" })).toBe(1);
    expect(await db.alerts.count({ alert_type: "price_feed_blind_escalated" })).toBe(1);
  });

  it("recovers on a successful reconnect: re-subscribes and does not re-alert", async () => {
    let clock = NOW;
    const fake = fakeConnect();
    await inFeed(freshKey(), async (feed) => {
      feed.attach({ now: () => clock, forward: async () => {}, connect: fake.connect });
      // A REAL SUBSCRIBER, not a bare startFeed: `alarm()` now stops any feed
      // whose registry is empty, so a reconnect/backoff test must have someone
      // listening or it is exercising the zero-subscriber backstop instead.
      await feed.subscribe("bot-a", CONFIG);
      await fake.sockets[0]!.drop();
      fake.failNext(5); // exactly enough to go blind
      for (let i = 0; i < 5; i++) {
        clock += 20_000;
        await feed.alarm();
      }
      clock += 60_000;
      await feed.alarm(); // this connect succeeds
      const last = fake.sockets[fake.sockets.length - 1]!;
      expect(last.sent).toEqual([SUBSCRIBE]);
    });
    expect(await db.alerts.count({ alert_type: "price_feed_blind" })).toBe(1); // not re-fired
  });

  /**
   * THE BLIND ALERT'S RESOLVE HALF.
   *
   * ⚠ WHAT THESE COVER. `price_feed_blind` was raised and closed by nothing --
   * entry 81 PART 6 confirmed by grep that none of the system's four resolving
   * paths reaches the `price-feed:*` source, and left it out of scope. The cost
   * was two 20-day-old open rows that read as a live outage and were not one.
   * The test above already proves the row is not RE-fired while blind; these
   * prove it stops being open once the feed is not.
   */
  describe("blind alerts resolve when the feed reconnects", () => {
    /** Every blind row in the table, warning and escalation alike. */
    const blindRows = async () =>
      await db.alerts.findMany({
        where: { alert_type: { in: ["price_feed_blind", "price_feed_blind_escalated"] } },
      });

    const rowsOfType = async (alertType: string) =>
      (await blindRows()).filter((row) => row.alert_type === alertType);

    it("closes BOTH the warning and the escalation on a successful reconnect", async () => {
      let clock = NOW;
      const fake = fakeConnect();
      await inFeed(freshKey(), async (feed) => {
        feed.attach({ now: () => clock, forward: async () => {}, connect: fake.connect });
        await feed.subscribe("bot-a", CONFIG);
        await fake.sockets[0]!.drop();
        fake.failNext(6); // five alarms to go blind, then one more to escalate
        for (let i = 0; i < 5; i++) {
          clock += 20_000;
          await feed.alarm();
        }
        clock += 31 * 60_000; // stay blind past the escalation window
        await feed.alarm(); // escalates
        clock += 60_000;
        await feed.alarm(); // this connect succeeds

        // The recovery really happened: a live socket, re-subscribed.
        const last = fake.sockets[fake.sockets.length - 1]!;
        expect(last.sent).toEqual([SUBSCRIBE]);
      });

      const rows = await blindRows();
      expect(rows).toHaveLength(2);
      // The escalation is the same incident grown louder, not a second one, so
      // it closes with the warning rather than outliving it.
      expect(rows.every((row) => row.resolved)).toBe(true);
      expect(await rowsOfType("price_feed_blind_escalated")).toHaveLength(1);
    });

    it("RE-ARMS: a second outage opens a new row rather than reusing the closed one", async () => {
      let clock = NOW;
      const fake = fakeConnect();
      await inFeed(freshKey(), async (feed) => {
        feed.attach({ now: () => clock, forward: async () => {}, connect: fake.connect });
        await feed.subscribe("bot-a", CONFIG);

        await fake.sockets[0]!.drop();
        fake.failNext(5); // exactly enough to go blind
        for (let i = 0; i < 5; i++) {
          clock += 20_000;
          await feed.alarm();
        }
        clock += 60_000;
        await feed.alarm(); // recovers -> the first row closes

        // Blind a second time. The raise is gated on `blindSince`, which the
        // recovery cleared, so this must produce a row of its own.
        await fake.sockets[fake.sockets.length - 1]!.drop();
        fake.failNext(100);
        for (let i = 0; i < 5; i++) {
          clock += 20_000;
          await feed.alarm();
        }
      });

      const rows = await rowsOfType("price_feed_blind");
      expect(rows).toHaveLength(2);
      expect(rows.filter((row) => row.resolved)).toHaveLength(1);
      // The second outage is still open, which is the point: closing the first
      // row must not suppress the alert for the next one.
      expect(rows.filter((row) => !row.resolved)).toHaveLength(1);
    });

    it("closes only ITS OWN market's row, never another feed's", async () => {
      const DOGE = { exchange: "gemini", pair: "DOGEUSD" } as const;
      let clock = NOW;

      // BTCUSD goes blind and STAYS blind.
      const btc = fakeConnect();
      await inFeed(freshKey(), async (feed) => {
        feed.attach({ now: () => clock, forward: async () => {}, connect: btc.connect });
        await feed.subscribe("bot-a", CONFIG);
        await btc.sockets[0]!.drop();
        btc.failNext(100);
        for (let i = 0; i < 5; i++) {
          clock += 20_000;
          await feed.alarm();
        }
      });

      // DOGEUSD goes blind and recovers.
      const doge = fakeConnect();
      await inFeed("gemini:DOGEUSD#resolve", async (feed) => {
        feed.attach({ now: () => clock, forward: async () => {}, connect: doge.connect });
        await feed.subscribe("bot-b", DOGE);
        await doge.sockets[0]!.drop();
        doge.failNext(5);
        for (let i = 0; i < 5; i++) {
          clock += 20_000;
          await feed.alarm();
        }
        clock += 60_000;
        await feed.alarm(); // recovers
      });

      const bySource = async (source: string) =>
        await db.alerts.findMany({ where: { alert_type: "price_feed_blind", source } });

      const btcRows = await bySource("price-feed:gemini:BTCUSD");
      const dogeRows = await bySource("price-feed:gemini:DOGEUSD");
      expect(btcRows).toHaveLength(1);
      expect(dogeRows).toHaveLength(1);
      // The one market that is still blind still says so.
      expect(btcRows[0]!.resolved).toBe(false);
      expect(dogeRows[0]!.resolved).toBe(true);
    });

    it("closes only the BLIND types, leaving this feed's other incidents open", async () => {
      // A frozen-value row on the same feed, under the same `source`. Prices
      // being fiction is a correctness problem; reconnecting says nothing about
      // it, and a resolve scoped by source alone would wrongly close it.
      await db.alerts.insert({
        id: "alert-frozen-open",
        severity: "critical",
        category: "system",
        alert_type: "price_feed_value_frozen",
        bot_instance_id: null,
        source: "price-feed:gemini:BTCUSD",
        message: "the value is frozen",
        resolved: false,
        created_at: NOW,
        notified_at: null,
      });

      let clock = NOW;
      const fake = fakeConnect();
      await inFeed(freshKey(), async (feed) => {
        feed.attach({ now: () => clock, forward: async () => {}, connect: fake.connect });
        await feed.subscribe("bot-a", CONFIG);
        await fake.sockets[0]!.drop();
        fake.failNext(5);
        for (let i = 0; i < 5; i++) {
          clock += 20_000;
          await feed.alarm();
        }
        clock += 60_000;
        await feed.alarm(); // recovers
      });

      expect((await rowsOfType("price_feed_blind"))[0]!.resolved).toBe(true);
      const frozen = await db.alerts.findOne({ id: "alert-frozen-open" });
      expect(frozen!.resolved).toBe(false);
    });
  });

  it("stopFeed closes the socket", async () => {
    const fake = fakeConnect();
    await inFeed(freshKey(), async (feed) => {
      feed.attach({ now: () => NOW, forward: async () => {}, connect: fake.connect });
      await feed.startFeed(CONFIG);
      await feed.stopFeed();
      expect(fake.sockets[0]!.closed).toBe(true);
    });
  });
});

describe("subscriber registry and fan-out (C2)", () => {
  it("fans a closed candle out to every subscriber", async () => {
    const delivered: Array<{ id: string; price: Price }> = [];
    const fake = fakeConnect();
    await inFeed(freshKey(), async (feed) => {
      feed.attach({
        now: () => NOW,
        connect: fake.connect,
        deliver: async (id, price) => void delivered.push({ id, price }),
      });
      await feed.subscribe("bot-a", CONFIG); // first subscriber opens the feed
      await feed.subscribe("bot-b", CONFIG);
      await fake.sockets[0]!.deliver(BATCH); // primes to 19:39
      await fake.sockets[0]!.deliver(ROLLOVER["1940"]); // finalises 19:39 -> fan-out
    });
    // One closed candle, delivered once to each bot.
    expect(delivered).toHaveLength(2);
    expect(delivered.map((d) => d.id).sort()).toEqual(["bot-a", "bot-b"]);
    expect(delivered.every((d) => d.price.price === m("63718.00"))).toBe(true);
  });

  it("isolates a failing subscriber, alerts (attributed), and does not prune it before the streak", async () => {
    const delivered: string[] = [];
    const fake = fakeConnect();
    await seedBot("bot-good");
    await seedBot("bot-bad");
    await inFeed(freshKey(), async (feed) => {
      feed.attach({
        now: () => NOW,
        connect: fake.connect,
        deliver: async (id) => {
          if (id === "bot-bad") throw new Error("bot gone");
          delivered.push(id);
        },
      });
      await feed.subscribe("bot-good", CONFIG);
      await feed.subscribe("bot-bad", CONFIG);
      await fake.sockets[0]!.deliver(BATCH);
      await fake.sockets[0]!.deliver(ROLLOVER["1940"]); // candle 1
      await fake.sockets[0]!.deliver(ROLLOVER["1941"]); // candle 2 — bot-bad still tried

      // Two failures is short of MAX_FANOUT_FAILURES, so bot-bad is still a
      // subscriber. Isolation, not pruning, is what protects a bot that is
      // merely having a bad minute.
      const status = await feed.status();
      expect(status.subscriberCount).toBe(2);
      expect(status.subscribers).toContainEqual({
        botInstanceId: "bot-bad",
        consecutiveFailures: 2,
      });
    });
    // The good bot received both candles; the bad one never blocked it.
    expect(delivered).toEqual(["bot-good", "bot-good"]);
    // A fanout-failure alert per candle, ATTRIBUTED to the failing bot on the
    // structured column — not only interpolated into the message.
    const alerts = await db.alerts.findMany({ where: { alert_type: "price_feed_fanout_failed" } });
    expect(alerts).toHaveLength(2);
    expect(alerts.every((a) => a.category === "system")).toBe(true);
    expect(alerts.every((a) => a.bot_instance_id === "bot-bad")).toBe(true);
    expect(alerts.every((a) => a.message.includes("bot-bad"))).toBe(true);
  });

  it("opens the connection on the first subscribe and closes it on the last unsubscribe", async () => {
    const fake = fakeConnect();
    await inFeed(freshKey(), async (feed) => {
      feed.attach({ now: () => NOW, connect: fake.connect, deliver: async () => {} });
      expect(fake.sockets).toHaveLength(0);
      await feed.subscribe("bot-a", CONFIG);
      expect(fake.sockets).toHaveLength(1); // first subscribe connected
      await feed.subscribe("bot-b", CONFIG);
      expect(fake.sockets).toHaveLength(1); // second did not reconnect
      await feed.unsubscribe("bot-a");
      expect(fake.sockets[0]!.closed).toBe(false); // bot-b still subscribed
      await feed.unsubscribe("bot-b");
      expect(fake.sockets[0]!.closed).toBe(true); // last unsubscribe closed it
    });
  });

  it("is idempotent: redelivered subscribe/unsubscribe do not double-open, double-close, or throw", async () => {
    const fake = fakeConnect();
    await inFeed(freshKey(), async (feed) => {
      feed.attach({ now: () => NOW, connect: fake.connect, deliver: async () => {} });
      await feed.subscribe("bot-a", CONFIG);
      await feed.subscribe("bot-a", CONFIG); // redelivered first-subscribe
      expect(fake.sockets).toHaveLength(1); // NOT a second connection
      await feed.unsubscribe("bot-never"); // unsubscribe of a non-member
      expect(fake.sockets[0]!.closed).toBe(false); // still has bot-a; no stop
      await feed.unsubscribe("bot-a");
      expect(fake.sockets[0]!.closed).toBe(true);
      await feed.unsubscribe("bot-a"); // redelivered unsubscribe of the last member
      expect(fake.sockets).toHaveLength(1); // no crash, no re-stop, no new socket
    });
  });

  it("resets the watermark on stop so a restart re-primes fresh (no stale-history flood)", async () => {
    const delivered: Price[] = [];
    const restartBatch = JSON.stringify({
      changes: [
        [1785354000000, 63719.06, 63719.06, 63719.06, 63719.06, 0.1], // 19:40
        [1785354060000, 63719.06, 63719.06, 63719.06, 63719.06, 0.2], // 19:41
        [1785354120000, 63719.06, 63719.06, 63719.06, 63719.06, 0.3], // 19:42
        [1785354180000, 63719.06, 63719.06, 63719.06, 63719.06, 0.4], // 19:43
        [1785354240000, 63719.06, 63719.06, 63719.06, 63719.06, 0.5], // 19:44
        [1785354300000, 63719.06, 63720.0, 63719.0, 63719.5, 0.6], // 19:45 (current)
      ],
      symbol: "BTCUSD",
      type: "candles_1m_updates",
    });
    const fake = fakeConnect();
    await inFeed(freshKey(), async (feed) => {
      feed.attach({
        now: () => NOW,
        connect: fake.connect,
        deliver: async (_id, price) => void delivered.push(price),
      });
      await feed.subscribe("bot-a", CONFIG);
      await fake.sockets[0]!.deliver(BATCH);
      await fake.sockets[0]!.deliver(ROLLOVER["1940"]); // forwards 19:39
      await feed.unsubscribe("bot-a"); // stopFeed: watermark reset

      await feed.subscribe("bot-a", CONFIG); // restart: new socket
      await fake.sockets[1]!.deliver(restartBatch); // primes; must forward NO history
    });
    // Only the single pre-stop candle. Had the stale watermark survived, the
    // restart batch would have "backfilled" 19:40..19:44 that nobody was listening for.
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.price).toBe(m("63718.00"));
  });
});

/**
 * THE LEAK: a feed that stays awake with nothing listening.
 *
 * Measured in production as ~4.4 Durable Objects resident continuously (~47.4k
 * GB-s/day), traced to two causes that compound:
 *
 *   1. Fan-out never pruned a subscriber that failed forever, so six halted and
 *      stopped bots held live subscriber rows and their feeds' alarm chains
 *      never terminated.
 *   2. `stopFeed` closed its own socket, whose `close` event was wired straight
 *      back to `#scheduleReconnect` — re-arming the alarm after `deleteAlarm`
 *      had run, on a feed with zero subscribers, which then reconnected for
 *      real because the config was still set.
 *
 * Every test below pins one of those shut. The last one pins the thing that must
 * NOT change: a feed with a live bot on it keeps trying, however badly it is
 * going, because losing prices is a trading risk and a silently killed feed is
 * an unmonitored stop-loss.
 */
describe("subscriber pruning and feed teardown (the leak)", () => {
  /** Deliver a closed candle: prime from the batch, then roll over once. */
  async function oneCandle(socket: FakeSocket, rollover: string): Promise<void> {
    await socket.deliver(rollover);
  }

  it("prunes a subscriber after MAX_FANOUT_FAILURES consecutive failures, and stops the feed when it was the last", async () => {
    const fake = fakeConnect();
    await seedBot("bot-dead");
    let alarmAfter: number | null = null;
    let finalCount = 0;

    await inFeed(freshKey(), async (feed, state) => {
      feed.attach({
        now: () => NOW,
        connect: fake.connect,
        deliver: async () => {
          throw new Error("bot gone");
        },
      });
      await feed.subscribe("bot-dead", CONFIG);
      await fake.sockets[0]!.deliver(BATCH); // primes to 19:39

      // Five closed candles => five consecutive failures => pruned on the fifth.
      for (const k of ["1940", "1941", "1942", "1943", "1944"] as const) {
        await oneCandle(fake.sockets[0]!, ROLLOVER[k]);
      }

      finalCount = (await feed.status()).subscriberCount;
      alarmAfter = await state.storage.getAlarm();
    });

    // The registry is empty and the feed took itself down.
    expect(finalCount).toBe(0);
    expect(fake.sockets[0]!.closed).toBe(true);
    // THE POINT OF THE WHOLE CHANGE: no alarm left armed, so nothing wakes this
    // object again and it stops being billed.
    expect(alarmAfter).toBeNull();

    // One prune alert, attributed, naming the bot and the market.
    const pruned = await db.alerts.findMany({
      where: { alert_type: "price_feed_subscriber_pruned" },
    });
    expect(pruned).toHaveLength(1);
    expect(pruned[0]!.bot_instance_id).toBe("bot-dead");
    expect(pruned[0]!.message).toContain("bot-dead");
    expect(pruned[0]!.source).toBe("price-feed:gemini:BTCUSD");
  });

  it("does NOT prune a subscriber that fails once and then succeeds (the counter resets)", async () => {
    const fake = fakeConnect();
    await seedBot("bot-flaky");
    let status!: Awaited<ReturnType<PriceFeed["status"]>>;

    await inFeed(freshKey(), async (feed) => {
      let calls = 0;
      feed.attach({
        now: () => NOW,
        connect: fake.connect,
        deliver: async () => {
          calls += 1;
          // Fail every other delivery: a streak can never reach 5.
          if (calls % 2 === 1) throw new Error("transient");
        },
      });
      await feed.subscribe("bot-flaky", CONFIG);
      await fake.sockets[0]!.deliver(BATCH);
      // Ten closed candles, five of them failures — but never five IN A ROW.
      for (const k of ["1940", "1941", "1942", "1943", "1944"] as const) {
        await oneCandle(fake.sockets[0]!, ROLLOVER[k]);
      }
      status = await feed.status();
    });

    // Still subscribed, still connected, and its streak was reset by the
    // successful deliveries rather than accumulating toward a prune.
    expect(status.subscriberCount).toBe(1);
    expect(status.subscribers[0]!.botInstanceId).toBe("bot-flaky");
    expect(status.subscribers[0]!.consecutiveFailures).toBeLessThan(5);
    expect(fake.sockets[0]!.closed).toBe(false);
    expect(await db.alerts.count({ alert_type: "price_feed_subscriber_pruned" })).toBe(0);
  });

  it("leaves no alarm armed when the close event fires DURING stopFeed", async () => {
    const fake = fakeConnect();
    let alarmAfter: number | null = null;
    let socketCount = 0;

    await inFeed(freshKey(), async (feed, state) => {
      feed.attach({ now: () => NOW, connect: fake.connect, deliver: async () => {} });
      await feed.subscribe("bot-a", CONFIG);
      expect(await state.storage.getAlarm()).not.toBeNull(); // armed while running

      // A FakeSocket's close() does not dispatch anything, so drive the close
      // event by hand from inside the teardown — the ordering where the event
      // lands while stopFeed is still running.
      const socket = fake.sockets[0]!;
      const stopping = feed.unsubscribe("bot-a"); // last unsubscribe -> stopFeed
      await socket.drop(); // the close event, mid-teardown
      await stopping;

      alarmAfter = await state.storage.getAlarm();
      socketCount = fake.sockets.length;
    });

    expect(alarmAfter).toBeNull();
    expect(socketCount).toBe(1); // no reconnect was attempted
  });

  it("leaves no alarm armed when the close event fires AFTER stopFeed has finished", async () => {
    const fake = fakeConnect();
    let alarmAfter: number | null = null;
    let socketCount = 0;

    await inFeed(freshKey(), async (feed, state) => {
      feed.attach({ now: () => NOW, connect: fake.connect, deliver: async () => {} });
      await feed.subscribe("bot-a", CONFIG);
      const socket = fake.sockets[0]!;

      await feed.unsubscribe("bot-a"); // stopFeed completes, alarm deleted
      expect(await state.storage.getAlarm()).toBeNull();

      // THE RACE THIS FIX EXISTS FOR: the close event lands after deleteAlarm.
      // Before the `#stopped` latch this called #scheduleReconnect and re-armed.
      await socket.drop();

      alarmAfter = await state.storage.getAlarm();
      socketCount = fake.sockets.length;
    });

    expect(alarmAfter).toBeNull();
    expect(socketCount).toBe(1);
  });

  it("an alarm arriving at a zero-subscriber feed deletes the alarm and does not reconnect", async () => {
    const fake = fakeConnect();
    let alarmAfter: number | null = null;
    let socketCount = 0;

    await inFeed(freshKey(), async (feed, state) => {
      feed.attach({ now: () => NOW, connect: fake.connect, deliver: async () => {} });
      // Bring a feed up, then empty its registry WITHOUT going through the
      // stopFeed path — the shape any cleanup gap leaves behind: an armed alarm,
      // a live socket, a config, and nobody listening. (Emptying the table
      // directly rather than via `deleteAll`, which would drop the table itself
      // — something the constructor's CREATE makes impossible in production.)
      await feed.subscribe("bot-a", CONFIG);
      state.storage.sql.exec("DELETE FROM subscribers");
      await state.storage.setAlarm(NOW + 1_000);

      await feed.alarm();

      alarmAfter = await state.storage.getAlarm();
      socketCount = fake.sockets.length;
    });

    expect(alarmAfter).toBeNull(); // the backstop disarmed it
    expect(socketCount).toBe(1); // and did NOT open a second socket
  });

  it("keeps a feed with subscribers alive and retrying through repeated connection failures", async () => {
    let clock = NOW;
    const fake = fakeConnect();
    let alarmAfter: number | null = null;
    let status!: Awaited<ReturnType<PriceFeed["status"]>>;

    await inFeed(freshKey(), async (feed, state) => {
      feed.attach({ now: () => clock, connect: fake.connect, deliver: async () => {} });
      await feed.subscribe("bot-live", CONFIG);
      await fake.sockets[0]!.drop(); // attempts = 1
      fake.failNext(100); // every reconnect from here fails

      for (let i = 0; i < 8; i++) {
        clock += 20_000;
        await feed.alarm();
      }

      alarmAfter = await state.storage.getAlarm();
      status = await feed.status();
    });

    // A LIVE BOT MUST NOT BE SILENTLY CUT OFF. Eight failed reconnects is well
    // past the point where fan-out would prune a subscriber, but a connection
    // failure is the feed's problem, not the subscriber's: the bot stays
    // subscribed and the alarm stays armed so recovery is still possible.
    expect(status.subscriberCount).toBe(1);
    expect(alarmAfter).not.toBeNull();
    // The blind alerting is unchanged by this work.
    expect(await db.alerts.count({ alert_type: "price_feed_blind" })).toBe(1);
    expect(await db.alerts.count({ alert_type: "price_feed_subscriber_pruned" })).toBe(0);
  });

  it("re-subscribing after stopFeed re-establishes the config and reconnects", async () => {
    const fake = fakeConnect();
    const delivered: Price[] = [];
    let afterStop!: Awaited<ReturnType<PriceFeed["status"]>>;
    let afterRestart!: Awaited<ReturnType<PriceFeed["status"]>>;

    await inFeed(freshKey(), async (feed) => {
      feed.attach({
        now: () => NOW,
        connect: fake.connect,
        deliver: async (_id, price) => void delivered.push(price),
      });
      await feed.subscribe("bot-a", CONFIG);
      await fake.sockets[0]!.deliver(BATCH);
      await fake.sockets[0]!.deliver(ROLLOVER["1940"]); // one real candle out

      await feed.unsubscribe("bot-a"); // stopFeed: config AND watermark cleared
      afterStop = await feed.status();

      await feed.subscribe("bot-a", CONFIG); // restart
      afterRestart = await feed.status();
      await fake.sockets[1]!.deliver(BATCH); // must re-prime, forwarding nothing
    });

    // stopFeed clears the config, which is what stops a stray alarm reconnecting.
    expect(afterStop.config).toBeNull();
    expect(afterStop.connected).toBe(false);
    expect(afterStop.stopped).toBe(true);
    // A re-subscribe puts it back and opens a fresh socket — the clearing must
    // not have made the feed unusable.
    expect(afterRestart.config).toEqual(CONFIG);
    expect(afterRestart.connected).toBe(true);
    expect(afterRestart.stopped).toBe(false);
    expect(fake.sockets).toHaveLength(2);
    // And the watermark reset still holds: the restart primes rather than
    // backfilling history nobody was listening for.
    expect(delivered).toHaveLength(1);
  });

  it("status() reports the registry, the connection, and the alarm without changing any of them", async () => {
    const fake = fakeConnect();
    await seedBot("bot-a");
    await inFeed(freshKey(), async (feed, state) => {
      feed.attach({
        now: () => NOW,
        connect: fake.connect,
        deliver: async (id) => {
          if (id === "bot-a") throw new Error("down");
        },
      });
      await feed.subscribe("bot-a", CONFIG);
      await fake.sockets[0]!.deliver(BATCH);
      await fake.sockets[0]!.deliver(ROLLOVER["1940"]); // one failed delivery

      const armed = await state.storage.getAlarm();
      const first = await feed.status();
      const second = await feed.status();

      expect(first.config).toEqual(CONFIG);
      expect(first.connected).toBe(true);
      expect(first.alarmAt).toBe(armed);
      expect(first.subscriberCount).toBe(1);
      expect(first.subscribers).toEqual([
        { botInstanceId: "bot-a", consecutiveFailures: 1 },
      ]);
      // Read-only: asking twice changes nothing, and arms nothing.
      expect(second).toEqual(first);
      expect(await state.storage.getAlarm()).toBe(armed);
      expect(fake.sockets).toHaveLength(1);
    });
  });
});

/**
 * The outbound-socket TRANSPORT (`openOutboundSocket`), which the stream-engine and
 * lifecycle tests above all bypass with an injected `connect`. That injection is why
 * a real bug survived here until the live Tier 0 run: `fetch` REJECTS a `ws(s)://`
 * URL ("Fetch API cannot load"), so the handshake must use an `http(s)://` URL with
 * an `Upgrade` header and read the socket off `response.webSocket`. These lock in the
 * fix so the feed's own transport is proven, not just its engine.
 */
describe("openOutboundSocket transport (Cloudflare handshake)", () => {
  it("translates ws(s):// to http(s):// for the fetch upgrade", () => {
    expect(httpUrlForWebSocket("wss://api.sandbox.gemini.com/v2/marketdata")).toBe(
      "https://api.sandbox.gemini.com/v2/marketdata",
    );
    expect(httpUrlForWebSocket("ws://localhost:8787/feed")).toBe("http://localhost:8787/feed");
    // An already-http URL is left untouched.
    expect(httpUrlForWebSocket("https://example.com/x")).toBe("https://example.com/x");
  });

  it("fetches the https URL with an Upgrade header, reads webSocket, and accepts it", async () => {
    const listeners: Record<string, ((ev: unknown) => void)[]> = {};
    const ws = {
      accepted: false,
      sent: [] as string[],
      closed: false,
      accept() {
        this.accepted = true;
      },
      addEventListener(type: string, fn: (ev: unknown) => void) {
        (listeners[type] ??= []).push(fn);
      },
      send(data: string) {
        this.sent.push(data);
      },
      close() {
        this.closed = true;
      },
    };
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    const fakeFetch = (async (url: unknown, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return { status: 101, webSocket: ws } as unknown as Response;
    }) as unknown as typeof fetch;

    const received: string[] = [];
    const handlers: SocketHandlers = {
      onMessage: (raw) => {
        received.push(raw);
      },
      onClose: () => {},
    };
    const socket = await openOutboundSocket(
      "wss://api.sandbox.gemini.com/v2/marketdata",
      handlers,
      fakeFetch,
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.sandbox.gemini.com/v2/marketdata");
    expect((calls[0]!.init!.headers as Record<string, string>).Upgrade).toBe("websocket");
    expect(ws.accepted).toBe(true);

    for (const fn of listeners.message ?? []) fn({ data: '{"type":"heartbeat"}' });
    expect(received).toStrictEqual(['{"type":"heartbeat"}']);
    socket.send("SUBSCRIBE");
    expect(ws.sent).toStrictEqual(["SUBSCRIBE"]);
  });

  it("throws when the upgrade response has no webSocket", async () => {
    const fakeFetch = (async () =>
      ({ status: 200, webSocket: null }) as unknown as Response) as unknown as typeof fetch;
    await expect(
      openOutboundSocket("wss://x/y", { onMessage: () => {}, onClose: () => {} }, fakeFetch),
    ).rejects.toThrow(/no WebSocket in the upgrade response/);
  });
});

/**
 * THE RESOLVE HALF FOR THE TWO PER-BOT FEED ALERTS.
 *
 * ⚠ THE SAME DEFECT `price_feed_blind` HAD, twice more. `price_feed_fanout_failed`
 * and `price_feed_subscriber_pruned` were raised under the `price-feed:*` source
 * that none of the system's other resolvers reach, and nothing closed either one.
 * Entry 81 made both rows joinable to the failing bot, so an unresolved row does
 * not merely inflate a count -- it sits on that bot's detail page asserting,
 * permanently, that its stop-loss is not being evaluated.
 *
 * WHAT SEPARATES THESE FROM THE BLIND TESTS ABOVE is the scope. A blind feed is
 * ONE incident belonging to the market, ended for everybody by one reconnect.
 * These are attributed to a single subscriber while the feed delivers perfectly
 * to every other one, so the tests below are mostly about what a recovery must
 * NOT close.
 */
describe("per-bot feed alerts resolve when the subscriber recovers", () => {
  const rowsFor = async (alertType: string, botInstanceId: string | null = null) =>
    await db.alerts.findMany({
      where: { alert_type: alertType, ...(botInstanceId === null ? {} : { bot_instance_id: botInstanceId }) },
    });

  describe("price_feed_fanout_failed", () => {
    it("closes every row of a failed RUN when delivery to that bot succeeds again", async () => {
      const fake = fakeConnect();
      await seedBot("bot-flaky");
      let attempts = 0;

      await inFeed(freshKey(), async (feed) => {
        feed.attach({
          now: () => NOW,
          connect: fake.connect,
          // Three failures, then it comes back -- short of the prune threshold.
          deliver: async () => {
            attempts += 1;
            if (attempts <= 3) throw new Error("bot unreachable");
          },
        });
        await feed.subscribe("bot-flaky", CONFIG);
        await fake.sockets[0]!.deliver(BATCH); // primes to 19:39, forwards nothing
        for (const k of ["1940", "1941", "1942", "1943", "1944"] as const) {
          await fake.sockets[0]!.deliver(ROLLOVER[k]);
        }
      });

      const rows = await rowsFor("price_feed_fanout_failed", "bot-flaky");
      // Raised per ATTEMPT, not latched per incident: three failures, three rows.
      expect(rows).toHaveLength(3);
      // All three describe one run, and the run is over. Closing the newest only
      // would leave two rows open for a bot that is being delivered to fine.
      expect(rows.every((row) => row.resolved)).toBe(true);
      // It was never pruned -- this is recovery, not the teardown path.
      expect(await db.alerts.count({ alert_type: "price_feed_subscriber_pruned" })).toBe(0);
    });

    it("closes ONLY the recovering bot's rows, never a still-failing sibling's", async () => {
      // THE TEST THAT JUSTIFIES THE PER-BOT SCOPE. Both bots are on one market
      // and one feed; a feed-scoped resolve would pass every other assertion in
      // this file and silently close a live incident here.
      const fake = fakeConnect();
      await seedBot("bot-recovers");
      await seedBot("bot-stays-broken");
      let attempts = 0;

      await inFeed(freshKey(), async (feed) => {
        feed.attach({
          now: () => NOW,
          connect: fake.connect,
          deliver: async (id) => {
            if (id === "bot-stays-broken") throw new Error("gone for good");
            attempts += 1;
            if (attempts <= 2) throw new Error("transient");
          },
        });
        await feed.subscribe("bot-recovers", CONFIG);
        await feed.subscribe("bot-stays-broken", CONFIG);
        await fake.sockets[0]!.deliver(BATCH);
        // Four candles: under MAX_FANOUT_FAILURES, so nobody is pruned and the
        // only thing under test is which rows got closed.
        for (const k of ["1940", "1941", "1942", "1943"] as const) {
          await fake.sockets[0]!.deliver(ROLLOVER[k]);
        }
      });

      const recovered = await rowsFor("price_feed_fanout_failed", "bot-recovers");
      const broken = await rowsFor("price_feed_fanout_failed", "bot-stays-broken");
      expect(recovered).toHaveLength(2);
      expect(broken).toHaveLength(4);
      expect(recovered.every((row) => row.resolved)).toBe(true);
      // The bot that is still failing is still open on every one of its rows.
      expect(broken.every((row) => !row.resolved)).toBe(true);
    });

    it("re-arms: a later failure opens a new row rather than reusing the closed one", async () => {
      const fake = fakeConnect();
      await seedBot("bot-flaky");
      let attempts = 0;

      await inFeed(freshKey(), async (feed) => {
        feed.attach({
          now: () => NOW,
          connect: fake.connect,
          // fail, succeed (closing the first row), fail again.
          deliver: async () => {
            attempts += 1;
            if (attempts === 1 || attempts === 3) throw new Error("transient");
          },
        });
        await feed.subscribe("bot-flaky", CONFIG);
        await fake.sockets[0]!.deliver(BATCH);
        for (const k of ["1940", "1941", "1942"] as const) {
          await fake.sockets[0]!.deliver(ROLLOVER[k]);
        }
      });

      const rows = await rowsFor("price_feed_fanout_failed", "bot-flaky");
      expect(rows).toHaveLength(2);
      expect(rows.filter((row) => row.resolved)).toHaveLength(1);
      // The second failure is still open: closing the first must not suppress it.
      expect(rows.filter((row) => !row.resolved)).toHaveLength(1);
    });

    it("leaves a NULL-attributed row open, because no bot's recovery can own it", async () => {
      // `bot-nobody` has no `bot_instances` row, so `#alert`'s FK fallback writes
      // `bot_instance_id: null` -- the same shape as the historical `debug-check`
      // rows. A row that names nobody cannot be shown to be THIS bot's incident,
      // and closing it on this bot's recovery would be the unobserved-resolve
      // that scoping exists to prevent. Deliberate, and pinned so a future
      // "helpful" widening of the scope has to argue with this test.
      const fake = fakeConnect();
      let attempts = 0;

      await inFeed(freshKey(), async (feed) => {
        feed.attach({
          now: () => NOW,
          connect: fake.connect,
          deliver: async () => {
            attempts += 1;
            if (attempts <= 2) throw new Error("unreachable");
          },
        });
        await feed.subscribe("bot-nobody", CONFIG);
        await fake.sockets[0]!.deliver(BATCH);
        for (const k of ["1940", "1941", "1942", "1943"] as const) {
          await fake.sockets[0]!.deliver(ROLLOVER[k]);
        }
      });

      const rows = await rowsFor("price_feed_fanout_failed");
      expect(rows).toHaveLength(2);
      // The fallback really did fire; this is not a test of attribution working.
      expect(rows.every((row) => row.bot_instance_id === null)).toBe(true);
      expect(rows.every((row) => !row.resolved)).toBe(true);
    });
  });

  describe("price_feed_subscriber_pruned", () => {
    /** Fail five deliveries to `id`, which is exactly what gets it pruned. */
    async function pruneBot(socket: FakeSocket): Promise<void> {
      await socket.deliver(BATCH);
      for (const k of ["1940", "1941", "1942", "1943", "1944"] as const) {
        await socket.deliver(ROLLOVER[k]);
      }
    }

    it("closes the prune row when the bot subscribes again", async () => {
      // The row says the bot "receives no further prices until it is resumed,
      // which re-subscribes it". This is that sentence coming true.
      const fake = fakeConnect();
      await seedBot("bot-dead");
      let deliveries = 0;

      await inFeed(freshKey(), async (feed) => {
        feed.attach({
          now: () => NOW,
          connect: fake.connect,
          deliver: async () => {
            deliveries += 1;
            throw new Error("bot gone");
          },
        });
        await feed.subscribe("bot-dead", CONFIG);
        await pruneBot(fake.sockets[0]!);

        // Pruned, and it was the last subscriber, so the feed took itself down.
        expect((await feed.status()).subscriberCount).toBe(0);
        expect(deliveries).toBe(5);
        const pruned = await db.alerts.findMany({
          where: { alert_type: "price_feed_subscriber_pruned" },
        });
        expect(pruned).toHaveLength(1);
        expect(pruned[0]!.resolved).toBe(false); // open, until the bot comes back

        // The human resumes the bot, which re-subscribes it.
        await feed.subscribe("bot-dead", CONFIG);
      });

      const rows = await rowsFor("price_feed_subscriber_pruned", "bot-dead");
      expect(rows).toHaveLength(1);
      expect(rows[0]!.resolved).toBe(true);
    });

    it("re-arms: a bot pruned a second time gets a second row, the first still closed", async () => {
      // Re-subscribing claims only that the bot is subscribed, never that it is
      // healthy. A bot that comes back and fails again must alert again.
      const fake = fakeConnect();
      await seedBot("bot-dead");

      await inFeed(freshKey(), async (feed) => {
        feed.attach({
          now: () => NOW,
          connect: fake.connect,
          deliver: async () => {
            throw new Error("bot gone");
          },
        });
        await feed.subscribe("bot-dead", CONFIG);
        await pruneBot(fake.sockets[0]!);
        await feed.subscribe("bot-dead", CONFIG); // resumed -> first row closes
        await pruneBot(fake.sockets[fake.sockets.length - 1]!); // and dies again
      });

      const rows = await rowsFor("price_feed_subscriber_pruned", "bot-dead");
      expect(rows).toHaveLength(2);
      expect(rows.filter((row) => row.resolved)).toHaveLength(1);
      expect(rows.filter((row) => !row.resolved)).toHaveLength(1);
    });

    it("closes only the returning bot's row, leaving the other pruned bot's open", async () => {
      const fake = fakeConnect();
      await seedBot("bot-returns");
      await seedBot("bot-still-gone");

      await inFeed(freshKey(), async (feed) => {
        feed.attach({
          now: () => NOW,
          connect: fake.connect,
          deliver: async () => {
            throw new Error("bot gone");
          },
        });
        await feed.subscribe("bot-returns", CONFIG);
        await feed.subscribe("bot-still-gone", CONFIG);
        await pruneBot(fake.sockets[0]!); // both hit five in a row
        expect((await feed.status()).subscriberCount).toBe(0);

        await feed.subscribe("bot-returns", CONFIG); // only one comes back
      });

      const returned = await rowsFor("price_feed_subscriber_pruned", "bot-returns");
      const gone = await rowsFor("price_feed_subscriber_pruned", "bot-still-gone");
      expect(returned).toHaveLength(1);
      expect(gone).toHaveLength(1);
      expect(returned[0]!.resolved).toBe(true);
      // Nobody resumed this one, so its row still says so.
      expect(gone[0]!.resolved).toBe(false);
    });
  });
});
