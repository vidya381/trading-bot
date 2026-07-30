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
import { freshDatabase } from "../db/test-helpers";
import { fromDecimalString as m } from "../shared/money";
import type { Price } from "../shared/exchange-client";
import type { FeedSocket, PriceFeed, SocketHandlers } from "./price-feed";
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
      await feed.startFeed(CONFIG);
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
      await feed.startFeed(CONFIG);
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
      await feed.startFeed(CONFIG);
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
      await feed.startFeed(CONFIG);
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
      await feed.startFeed(CONFIG);
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
