import { describe, expect, it } from "vitest";
import { fromDecimalString as m } from "../../shared/money";
import type { FeedEvent } from "../price-feed-codec";
import { GeminiPriceFeedCodec, GEMINI_WS_URLS } from "./price-feed";

const codec = new GeminiPriceFeedCodec();
const PAIR = "BTCUSD";

/**
 * Real rows captured by the step 14 WS reachability probe against the Gemini
 * SANDBOX (`candles_1m_updates`, most-recent-first, OHLCV as JSON numbers). Not
 * invented -- these are the actual timestamps and values the probe logged.
 */
const REAL_CHANGES = [
  [1785346020000, 63610.21, 63610.21, 63610.21, 63610.21, 0.0],
  [1785345960000, 63610.21, 63610.21, 63610.21, 63610.21, 0.0],
  [1785345900000, 63610.21, 63610.21, 63610.21, 63610.21, 0.0],
  [1785345840000, 63610.21, 63610.21, 63610.21, 63610.21, 0.000784],
  [1785345780000, 63621.05, 63621.05, 63610.21, 63610.21, 0.003769],
];

/** The newest candle in the batch covers [1785346020000, 1785346080000). */
const NEWEST_OPEN = 1785346020000;
/** A receipt time WITHIN the newest candle's minute: it is still in-progress. */
const AT_IN_MINUTE = 1785346050000;

const candlesMessage = (changes: unknown[]) =>
  JSON.stringify({ type: "candles_1m_updates", symbol: "BTCUSD", changes });

/** Narrow to candle events for concise assertions. */
function candles(events: FeedEvent[]) {
  return events.flatMap((e) => (e.kind === "candle" ? [e.candle] : []));
}

describe("GeminiPriceFeedCodec.socketUrl", () => {
  it("derives the sandbox socket for testnet and production socket for production", () => {
    expect(codec.socketUrl("testnet")).toBe(GEMINI_WS_URLS.sandbox);
    expect(codec.socketUrl("production")).toBe(GEMINI_WS_URLS.production);
  });

  it("throws on an unrecognised ENVIRONMENT rather than guessing a venue", () => {
    expect(() => codec.socketUrl("staging")).toThrow(/ENVIRONMENT/);
    expect(() => codec.socketUrl(undefined)).toThrow(/ENVIRONMENT/);
  });
});

describe("GeminiPriceFeedCodec.subscribeMessage", () => {
  it("builds the real v2 candles_1m subscribe frame with the upper-case symbol", () => {
    expect(JSON.parse(codec.subscribeMessage(PAIR))).toStrictEqual({
      type: "subscribe",
      subscriptions: [{ name: "candles_1m", symbols: ["BTCUSD"] }],
    });
  });
});

describe("GeminiPriceFeedCodec.parseMessage — candles", () => {
  it("parses a real candles_1m_updates batch oldest-first, numbers into Money", () => {
    const events = codec.parseMessage(candlesMessage(REAL_CHANGES), PAIR, AT_IN_MINUTE);

    expect(events.every((e) => e.kind === "candle")).toBe(true);
    const parsed = candles(events);
    // Sorted ascending despite Gemini sending newest-first.
    expect(parsed.map((c) => c.openTime)).toEqual([
      1785345780000, 1785345840000, 1785345900000, 1785345960000, 1785346020000,
    ]);
    // JSON numbers became Money via the reused getCandles rounding.
    expect(parsed[0]!.close).toBe(m("63610.21"));
    expect(parsed[1]!.volume).toBe(m("0.000784"));
    expect(parsed[4]!.pair).toBe(PAIR);
  });

  it("marks the in-progress candle open and the earlier ones closed (stateless, by time)", () => {
    const parsed = candles(codec.parseMessage(candlesMessage(REAL_CHANGES), PAIR, AT_IN_MINUTE));
    const newest = parsed.find((c) => c.openTime === NEWEST_OPEN)!;
    const earlier = parsed.find((c) => c.openTime === 1785345960000)!;
    // At a receipt time inside the newest candle's minute, it has not closed.
    expect(newest.closed).toBe(false);
    // The prior minute has ended.
    expect(earlier.closed).toBe(true);
  });

  it("identifies a rollover: as time advances into the next minute the previous candle closes", () => {
    // The probe observed candle 1785346080000 appear while 1785346020000 became
    // the previous. A later update carries the new current candle (and the
    // just-ended one); parsed at the heartbeat's receipt time (17:28:08), the new
    // minute is open and 1785346020000 is now closed.
    const AT_NEXT_MINUTE = 1785346088542;
    const rolloverChanges = [
      [1785346080000, 63612.0, 63612.0, 63611.0, 63611.5, 0.01], // new current minute
      [1785346020000, 63610.21, 63610.21, 63610.21, 63610.21, 0.0], // now closed
    ];
    const parsed = candles(codec.parseMessage(candlesMessage(rolloverChanges), PAIR, AT_NEXT_MINUTE));

    const current = parsed.find((c) => c.openTime === 1785346080000)!;
    const previous = parsed.find((c) => c.openTime === 1785346020000)!;
    expect(current.closed).toBe(false);
    expect(previous.closed).toBe(true);

    // The same candle 1785346020000, parsed earlier (inside its own minute), was
    // still open -- closure is purely a function of receipt time at this layer.
    const earlierView = candles(
      codec.parseMessage(candlesMessage([[1785346020000, 63610.21, 63610.21, 63610.21, 63610.21, 0.0]]), PAIR, AT_IN_MINUTE),
    );
    expect(earlierView[0]!.closed).toBe(false);
  });
});

describe("GeminiPriceFeedCodec.parseMessage — non-candle frames", () => {
  it("recognises a real heartbeat and yields no candle, without throwing", () => {
    const raw = JSON.stringify({ timestamp: 1785346088542, type: "heartbeat" });
    const events = codec.parseMessage(raw, PAIR, AT_IN_MINUTE);
    expect(events).toStrictEqual([{ kind: "heartbeat", at: AT_IN_MINUTE }]);
    expect(candles(events)).toHaveLength(0);
  });

  it("ignores a well-formed message of an unsubscribed type gracefully", () => {
    const raw = JSON.stringify({ type: "l2_updates", symbol: "BTCUSD", changes: [["buy", "63000", "1"]] });
    const events = codec.parseMessage(raw, PAIR, AT_IN_MINUTE);
    expect(events).toHaveLength(1);
    expect(events[0]!.kind).toBe("ignored");
  });

  it("returns `malformed` (never throws) for a known type it cannot parse", () => {
    // A candles_1m_updates whose row is too short: an API change to surface.
    const short = candlesMessage([[1785346020000, 1, 2, 3]]);
    const events = codec.parseMessage(short, PAIR, AT_IN_MINUTE);
    expect(events).toHaveLength(1);
    expect(events[0]!.kind).toBe("malformed");

    // A candles_1m_updates whose OHLCV is a string, not the number Gemini sends.
    const stringy = candlesMessage([[1785346020000, "63610.21", 63610.21, 63610.21, 63610.21, 0]]);
    expect(codec.parseMessage(stringy, PAIR, AT_IN_MINUTE)[0]!.kind).toBe("malformed");
  });

  it("returns `malformed` for a non-JSON frame or a message with no type", () => {
    expect(codec.parseMessage("this is not json{", PAIR, AT_IN_MINUTE)[0]!.kind).toBe("malformed");
    expect(codec.parseMessage(JSON.stringify({ changes: [] }), PAIR, AT_IN_MINUTE)[0]!.kind).toBe(
      "malformed",
    );
    expect(codec.parseMessage(JSON.stringify(42), PAIR, AT_IN_MINUTE)[0]!.kind).toBe("malformed");
  });
});
