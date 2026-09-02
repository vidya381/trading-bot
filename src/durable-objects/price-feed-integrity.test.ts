/**
 * SPEC 5.7 DETECTOR 1: the feed is delivering, and the value is fiction.
 *
 * ⚠ WHAT PRODUCED THIS FILE. On 2026-09-02 the `gemini:BTCUSD` feed spent eleven
 * hours forwarding the identical price to fourteen bots. It was connected. Its
 * heartbeats were current. Its watermark advanced every minute. Every price it
 * delivered carried a fresh receipt timestamp, because `#forwardClosed` stamps
 * `at` with receipt time by design (5.6, "when we heard"). Both existing
 * detectors were therefore perfectly satisfied:
 *
 *   - `price_feed_blind` watches heartbeats -- and they were arriving.
 *   - `price_updates_stale` watches `lastPriceAt` -- and that field is stamped
 *     from receipt time, so it can never go stale while deliveries continue.
 *
 * Both are LIVENESS checks. Neither could see a wrong value, and that was not an
 * oversight in either one: correctness had no detector at all. Four rounds of
 * investigation blamed the order type, then the venue, then the subscription,
 * before anyone thought to ask whether the price was real.
 *
 * ⚠ THE FIXTURES BELOW ARE THE REAL PAYLOAD, not an approximation. `78172.34`
 * with `O=H=L=C` and volume `0` is exactly what Gemini's sandbox published, 1439
 * times consecutively out of 1440 one-minute candles in a day.
 */
import { beforeEach, describe, expect, it } from "vitest";

import type { Database } from "../db/database";
import { freshDatabase } from "../db/test-helpers";
import { fromDecimalString as m } from "../shared/money";
import type { Price } from "../shared/exchange-client";
import type { PriceFeed } from "./price-feed";
import { inFeed } from "./test-helpers";

const NOW = 1_785_354_250_000;
const CONFIG = { exchange: "gemini", pair: "BTCUSD" } as const;

/** The value the sandbox was stuck on, to the cent. */
const STUCK = "78172.34";
/** The first minute of the run; each candle is one minute after the last. */
const T0 = 1_785_354_000_000;
const MINUTE = 60_000;

/**
 * One `candles_1m_updates` rollover, in the venue's real single-row shape.
 *
 * `O=H=L=C` and a volume the caller chooses -- the two axes this detector reads.
 */
const rollover = (minute: number, close: string, volume: number): string =>
  JSON.stringify({
    changes: [[T0 + minute * MINUTE, Number(close), Number(close), Number(close), Number(close), volume]],
    symbol: "BTCUSD",
    type: "candles_1m_updates",
  });

let db: Database;
let counter = 0;
const freshKey = () => `gemini:BTCUSD-integrity#${counter++}`;

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

/**
 * Deliver `count` rollovers starting at `fromMinute`.
 *
 * ⚠ FORWARDING LAGS BY ONE, and that is the engine's CURRENT-ONLY model, not an
 * off-by-one here: a rollover introduces a new in-progress candle, which is what
 * finalises the PREVIOUS one. So N delivered messages forward N-1 candles, and a
 * test wanting K forwarded candles delivers K+1 messages.
 */
const deliverRun = async (
  feed: PriceFeed,
  fromMinute: number,
  count: number,
  close: string,
  volume: number,
): Promise<void> => {
  for (let i = 0; i < count; i++) {
    await feed.handleMessage(rollover(fromMinute + i, close, volume));
  }
};

const frozenAlerts = async () =>
  await db.alerts.findMany({ where: { alert_type: "price_feed_value_frozen" } });

describe("the frozen-value detector (spec 5.7)", () => {
  it("REPRODUCES 2026-09-02: unchanged close, zero volume, and fires at ten in a row", async () => {
    // Eleven messages forward ten candles, every one at 78172.34 with no trades
    // -- the sandbox's exact signature, at the length the threshold names.
    const forwarded = await run(async (feed) => {
      await deliverRun(feed, 0, 11, STUCK, 0);
    });

    // The prices really were delivered. The detector observes; it never gates --
    // withholding prices from a bot holding a position would swap a reporting
    // problem for a risk one.
    expect(forwarded).toHaveLength(10);
    expect(new Set(forwarded.map((p) => p.price))).toEqual(new Set([m(STUCK)]));

    const alerts = await frozenAlerts();
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.severity).toBe("critical");
    expect(alerts[0]!.category).toBe("system");
    expect(alerts[0]!.resolved).toBe(false);

    // Names the market, the stuck value and the run length, per 5.7.
    const message = alerts[0]!.message;
    expect(message).toContain("gemini:BTCUSD");
    expect(message).toContain(STUCK);
    expect(message).toContain("10 consecutive candles");
  });

  it("does NOT fire before the threshold -- nine in a row is still quiet", async () => {
    const forwarded = await run(async (feed) => {
      await deliverRun(feed, 0, 10, STUCK, 0);
    });
    expect(forwarded).toHaveLength(9);
    expect(await frozenAlerts()).toHaveLength(0);
  });

  it("STANDS rather than repeats: 40 more frozen candles add no second row", async () => {
    // The failure this prevents is an alert surface nobody reads. The incident
    // that produced this detector ran 1439 frozen candles in one day; a row per
    // candle would have buried every other alert in the table.
    const alerts = await run(async (feed) => {
      await deliverRun(feed, 0, 51, STUCK, 0);
    }).then(frozenAlerts);
    expect(alerts).toHaveLength(1);
  });

  it("RESOLVES on the first differing close, and re-arms for the next incident", async () => {
    await run(async (feed) => {
      await deliverRun(feed, 0, 11, STUCK, 0); // fires
      // The market comes back: a different close ends the run.
      await feed.handleMessage(rollover(11, "76060.22", 0));
      await feed.handleMessage(rollover(12, "76060.22", 0));
    });

    const alerts = await frozenAlerts();
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.resolved).toBe(true);
  });

  it("a differing close RESETS the run, so two short runs never add up to one long one", async () => {
    // ⚠ MIND THE ONE-MESSAGE LAG. A rollover forwards the PREVIOUS candle, so
    // the message that introduces a new price still finalises the old one. The
    // run therefore ends one message after the market actually moves, and the
    // counts below are written against forwarded candles, not messages.
    const alerts = await run(async (feed) => {
      // 9 messages -> 8 forwarded, all frozen. Run reaches 8.
      await deliverRun(feed, 0, 9, STUCK, 0);
      // Introduces the new price; still forwards minute 8 at the OLD one. Run 9.
      await feed.handleMessage(rollover(9, "78100.00", 0));
      // Now the moved candle is forwarded. Run resets to zero.
      await feed.handleMessage(rollover(10, "78100.00", 0));
      // 8 messages -> 8 more forwarded at the new value. Run reaches 9, not 18.
      await deliverRun(feed, 11, 8, "78100.00", 0);
    }).then(frozenAlerts);

    // Without the reset these 17 frozen forwards would have fired twice over.
    expect(alerts).toHaveLength(0);
  });

  // --- the two false-positive cases the conjunction exists to exclude --------

  it("does NOT fire on an unchanged close that actually TRADED", async () => {
    // A quiet minute on a liquid pair closes where it opened. That is a real
    // price, produced by real trades, and must never be called frozen. These are
    // the step 14 probe's own captured volumes.
    const alerts = await run(async (feed) => {
      await deliverRun(feed, 0, 20, "63719.06", 0.0009);
    }).then(frozenAlerts);
    expect(alerts).toHaveLength(0);
  });

  it("does NOT fire on zero-volume candles whose price is MOVING", async () => {
    // A thin pair has minutes with no trades. As long as the quote moves, the
    // venue is still marking a market rather than repeating a memory.
    const alerts = await run(async (feed) => {
      for (let i = 0; i < 20; i++) {
        await feed.handleMessage(rollover(i, (78172 + i).toFixed(2), 0));
      }
    }).then(frozenAlerts);
    expect(alerts).toHaveLength(0);
  });

  it("survives an eviction: the run counter is persisted, not held in memory", async () => {
    // The counter lives in the same persisted blob as the watermark, because a
    // Durable Object that is evicted mid-run must not silently restart counting
    // -- which on a one-minute feed would mean never reaching ten.
    const key = freshKey();
    const drive = async (fromMinute: number, count: number): Promise<void> => {
      await inFeed(key, async (feed) => {
        feed.attach({ now: () => NOW, forward: async () => undefined });
        await feed.configure(CONFIG);
        feed.beginConnection();
        await deliverRun(feed, fromMinute, count, STUCK, 0);
      });
    };

    await drive(0, 6); // 5 frozen candles forwarded
    expect(await frozenAlerts()).toHaveLength(0);
    // A second entry re-reads persisted state. `beginConnection` re-primes the
    // in-memory current candle from the next message, but the RUN must carry.
    await drive(6, 6);

    expect(await frozenAlerts()).toHaveLength(1);
  });

  it("state written before 5.7 existed still counts, rather than going NaN", async () => {
    // Every feed running when this shipped has a stored blob with none of the
    // three new keys. `#state` is assigned from storage wholesale, so without a
    // spread over the defaults `frozenRun + 1` is NaN and the detector never
    // fires on exactly the longest-running feeds.
    const key = freshKey();
    await inFeed(key, async (feed, state) => {
      feed.attach({ now: () => NOW, forward: async () => undefined });
      await feed.configure(CONFIG);
      // A pre-5.7 blob: the fields that existed then, and nothing else.
      const stored = (await state.storage.get("feed-state")) as Record<string, unknown>;
      await state.storage.put("feed-state", {
        config: stored.config,
        watermark: null,
        reconnectAttempts: 0,
        blindSince: null,
        escalated: false,
      });
    });

    await inFeed(key, async (feed) => {
      feed.attach({ now: () => NOW, forward: async () => undefined });
      feed.beginConnection();
      await deliverRun(feed, 0, 11, STUCK, 0);
    });

    expect(await frozenAlerts()).toHaveLength(1);
  });
});
