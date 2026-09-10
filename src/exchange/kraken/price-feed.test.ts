/**
 * `KrakenPriceFeedCodec`, against frames captured VERBATIM from the live
 * `wss://ws.kraken.com/v2` socket on 2026-09-10.
 *
 * Every raw string below was logged off a real, credential-free subscription --
 * not hand-written to match the implementation, and not copied from
 * documentation. That distinction is the point of this file: the bug it guards
 * against was a codec that parsed its input perfectly and was pointed at the
 * wrong exchange, which no amount of self-consistent fixture-writing would have
 * caught. The symbol table in `SYMBOL_CASES` was likewise validated by
 * subscribing to all 12 spellings live and observing `success:true` for each.
 */

import { describe, expect, it } from "vitest";
import { fromDecimalString as m } from "../../shared/money";
import type { FeedEvent } from "../price-feed-codec";
import { KrakenPriceFeedCodec, KRAKEN_WS_URL, toKrakenWsSymbol } from "./price-feed";

const codec = new KrakenPriceFeedCodec();
const PAIR = "BTCUSDT";

/** 2026-09-10T17:32:00Z, the first `interval_begin` in the captured snapshot. */
const OPEN_1732 = 1_789_061_520_000;
/** Receipt time inside 17:44, so everything up to 17:43 has closed. */
const AT_1744 = 1_789_062_260_000;

/** The `status` frame Kraken sends once, on connect. Captured verbatim. */
const STATUS =
  '{"channel":"status","type":"update","data":[{"version":"2.0.10","system":"online",' +
  '"api_version":"v2","connection_id":16174536464690282295,"upcoming_maintenance":[],"emergency":[]}]}';

/** A successful subscribe acknowledgement. Captured verbatim. */
const ACK_OK =
  '{"method":"subscribe","result":{"channel":"ohlc","interval":1,"snapshot":true,' +
  '"symbol":"BTC/USDT","warnings":["timestamp is deprecated, use interval_begin"]},' +
  '"success":true,"time_in":"2026-09-10T17:44:43.105193Z","time_out":"2026-09-10T17:44:43.105248Z"}';

/**
 * A REJECTED subscribe, captured verbatim by asking for `XBT/USDT` -- the
 * spelling `/public/AssetPairs` reports as this pair's `wsname`, and which the
 * v2 socket does not accept.
 */
const ACK_ERR =
  '{"error":"Currency pair not supported XBT/USDT","method":"subscribe","success":false,' +
  '"symbol":"XBT/USDT","time_in":"2026-09-10T17:44:44.609516Z","time_out":"2026-09-10T17:44:44.609555Z"}';

/** Kraken's heartbeat, in full. It carries no clock of its own. */
const HEARTBEAT = '{"channel":"heartbeat"}';

/**
 * The reconnect `snapshot`, captured verbatim: nine rows, oldest-first, with
 * 17:36/17:37 and 17:42 simply ABSENT because nothing traded in those minutes.
 */
const SNAPSHOT =
  '{"channel":"ohlc","type":"snapshot","timestamp":"2026-09-10T17:44:43.105760475Z","data":[' +
  '{"symbol":"BTC/USDT","open":77400.0,"high":77445.8,"low":77400.0,"close":77416.3,"trades":15,"volume":0.25302078,"vwap":77416.2,"interval_begin":"2026-09-10T17:32:00.000000000Z","interval":1,"timestamp":"2026-09-10T17:33:00.000000Z"},' +
  '{"symbol":"BTC/USDT","open":77415.4,"high":77415.4,"low":77397.1,"close":77397.1,"trades":5,"volume":0.03771523,"vwap":77414.0,"interval_begin":"2026-09-10T17:33:00.000000000Z","interval":1,"timestamp":"2026-09-10T17:34:00.000000Z"},' +
  '{"symbol":"BTC/USDT","open":77448.9,"high":77468.8,"low":77446.3,"close":77468.8,"trades":4,"volume":0.04470301,"vwap":77452.9,"interval_begin":"2026-09-10T17:34:00.000000000Z","interval":1,"timestamp":"2026-09-10T17:35:00.000000Z"},' +
  '{"symbol":"BTC/USDT","open":77499.9,"high":77509.2,"low":77467.5,"close":77509.2,"trades":15,"volume":0.58051276,"vwap":77482.2,"interval_begin":"2026-09-10T17:35:00.000000000Z","interval":1,"timestamp":"2026-09-10T17:36:00.000000Z"},' +
  '{"symbol":"BTC/USDT","open":77427.0,"high":77427.0,"low":77384.2,"close":77384.2,"trades":5,"volume":0.04314517,"vwap":77406.5,"interval_begin":"2026-09-10T17:38:00.000000000Z","interval":1,"timestamp":"2026-09-10T17:39:00.000000Z"},' +
  '{"symbol":"BTC/USDT","open":77369.7,"high":77369.7,"low":77369.7,"close":77369.7,"trades":1,"volume":0.01427209,"vwap":77369.7,"interval_begin":"2026-09-10T17:39:00.000000000Z","interval":1,"timestamp":"2026-09-10T17:40:00.000000Z"},' +
  '{"symbol":"BTC/USDT","open":77363.9,"high":77363.9,"low":77324.6,"close":77326.4,"trades":5,"volume":0.03288232,"vwap":77335.4,"interval_begin":"2026-09-10T17:40:00.000000000Z","interval":1,"timestamp":"2026-09-10T17:41:00.000000Z"},' +
  '{"symbol":"BTC/USDT","open":77357.1,"high":77370.1,"low":77357.1,"close":77370.1,"trades":2,"volume":0.00208254,"vwap":77369.2,"interval_begin":"2026-09-10T17:41:00.000000000Z","interval":1,"timestamp":"2026-09-10T17:42:00.000000Z"},' +
  '{"symbol":"BTC/USDT","open":77351.6,"high":77351.6,"low":77327.3,"close":77340.1,"trades":17,"volume":1.29749671,"vwap":77343.9,"interval_begin":"2026-09-10T17:43:00.000000000Z","interval":1,"timestamp":"2026-09-10T17:44:00.000000Z"}]}';

/** A single-row `update`, captured verbatim: the in-progress candle only. */
const UPDATE =
  '{"channel":"ohlc","type":"update","timestamp":"2026-09-10T17:35:52.114514810Z","data":[' +
  '{"symbol":"BTC/USDT","open":77499.9,"high":77509.2,"low":77467.5,"close":77509.2,"trades":15,' +
  '"volume":0.58051276,"vwap":77482.2,"interval_begin":"2026-09-10T17:35:00.000000000Z",' +
  '"interval":1,"timestamp":"2026-09-10T17:36:00.000000Z"}]}';

function candles(events: FeedEvent[]) {
  return events.flatMap((e) => (e.kind === "candle" ? [e.candle] : []));
}

describe("KrakenPriceFeedCodec.socketUrl", () => {
  it("uses the one real v2 socket in both environments -- Kraken has no sandbox", () => {
    expect(codec.socketUrl("production")).toBe(KRAKEN_WS_URL);
    expect(codec.socketUrl("testnet")).toBe(KRAKEN_WS_URL);
    expect(KRAKEN_WS_URL).toBe("wss://ws.kraken.com/v2");
  });

  it("throws on an unrecognised ENVIRONMENT rather than guessing a venue", () => {
    expect(() => codec.socketUrl("staging")).toThrow(/ENVIRONMENT/);
    expect(() => codec.socketUrl(undefined)).toThrow(/ENVIRONMENT/);
  });

  it("is NOT a Gemini URL -- the misrouting this codec exists to end", () => {
    expect(codec.socketUrl("production")).not.toContain("gemini");
    expect(codec.socketUrl("production")).toContain("kraken");
  });
});

describe("toKrakenWsSymbol", () => {
  /**
   * Each of these was sent to the live v2 socket and acknowledged
   * `success:true`. The five below the divider are the pairs no suffix rule
   * splits correctly, carried as explicit exceptions.
   */
  const SYMBOL_CASES: ReadonlyArray<readonly [string, string]> = [
    ["BTCUSDT", "BTC/USDT"],
    ["ETHUSDT", "ETH/USDT"],
    ["BTCUSD", "BTC/USD"],
    ["ADAUSD", "ADA/USD"],
    ["DOGEUSD", "DOGE/USD"],
    ["TRXUSDD", "TRX/USDD"],
    ["BTCUSDQ", "BTC/USDQ"],
    ["JITOSOLSOL", "JITOSOL/SOL"],
    // --- genuinely ambiguous: base ends in a more popular quote's text ---
    ["ETHPYUSD", "ETH/PYUSD"],
    ["BTCPYUSD", "BTC/PYUSD"],
    ["MONAUSD", "MON/AUSD"],
    ["BTCAUSD", "BTC/AUSD"],
    ["XRPRLUSD", "XRP/RLUSD"],
  ];

  it.each(SYMBOL_CASES)("maps %s to the live-accepted %s", (pair, expected) => {
    expect(toKrakenWsSymbol(pair)).toBe(expected);
  });

  it("does NOT produce the wsname spelling the v2 socket rejects", () => {
    // `/public/AssetPairs` calls this pair's wsname `XBT/USDT`; the live socket
    // answers that with "Currency pair not supported".
    expect(toKrakenWsSymbol("BTCUSDT")).not.toBe("XBT/USDT");
  });

  it("upper-cases, since the live socket rejects btc/usdt", () => {
    expect(toKrakenWsSymbol("btcusdt")).toBe("BTC/USDT");
  });

  it("refuses a pair whose quote asset this build does not know", () => {
    expect(() => toKrakenWsSymbol("BTCZZZZ")).toThrow(/quote assets this build knows/);
  });

  it("refuses rather than emitting a symbol with an empty base", () => {
    expect(() => toKrakenWsSymbol("USDT")).toThrow(/quote assets this build knows/);
  });
});

describe("KrakenPriceFeedCodec.subscribeMessage", () => {
  it("builds the real v2 ohlc subscribe frame, slashed and upper-cased", () => {
    expect(JSON.parse(codec.subscribeMessage(PAIR))).toStrictEqual({
      method: "subscribe",
      params: { channel: "ohlc", symbol: ["BTC/USDT"], interval: 1 },
    });
  });

  it("is NOT Gemini's frame -- the two are structurally different", () => {
    const frame = JSON.parse(codec.subscribeMessage(PAIR)) as Record<string, unknown>;
    expect(frame["type"]).toBeUndefined(); // Gemini's key
    expect(frame["subscriptions"]).toBeUndefined(); // Gemini's key
    expect(frame["method"]).toBe("subscribe"); // Kraken's
  });
});

describe("KrakenPriceFeedCodec.parseMessage — ohlc", () => {
  it("parses the real snapshot: 9 candles, oldest-first, numbers into Money", () => {
    const parsed = candles(codec.parseMessage(SNAPSHOT, PAIR, AT_1744));

    expect(parsed).toHaveLength(9);
    expect(parsed.map((c) => c.openTime)).toStrictEqual([...parsed.map((c) => c.openTime)].sort((a, b) => a - b));

    const first = parsed[0]!;
    expect(first.pair).toBe(PAIR);
    expect(first.openTime).toBe(OPEN_1732);
    // Inclusive last millisecond, derived -- not Kraken's deprecated per-row end.
    expect(first.closeTime).toBe(OPEN_1732 + 60_000 - 1);
    expect(first.open).toBe(m("77400.00000000"));
    expect(first.high).toBe(m("77445.80000000"));
    expect(first.low).toBe(m("77400.00000000"));
    expect(first.close).toBe(m("77416.30000000"));
    expect(first.volume).toBe(m("0.25302078"));
    expect(first.closed).toBe(true);
  });

  it("reads interval_begin, not the deprecated per-row timestamp", () => {
    // Row 0's `timestamp` is 17:33:00 -- one minute AFTER its `interval_begin`.
    // Taking it as the open time would shift every candle forward by a minute.
    const first = candles(codec.parseMessage(SNAPSHOT, PAIR, AT_1744))[0]!;
    expect(first.openTime).toBe(OPEN_1732);
    expect(first.openTime).not.toBe(OPEN_1732 + 60_000);
  });

  it("tolerates the gaps a quiet market leaves in the snapshot", () => {
    // 17:36, 17:37 and 17:42 had no trades and are simply absent.
    const opens = candles(codec.parseMessage(SNAPSHOT, PAIR, AT_1744)).map((c) => c.openTime);
    expect(opens).not.toContain(OPEN_1732 + 4 * 60_000); // 17:36
    expect(opens).toContain(OPEN_1732 + 6 * 60_000); // 17:38
  });

  it("parses a single-row update as the one in-progress candle", () => {
    // Receipt time inside 17:35, so its minute has not ended.
    const at = OPEN_1732 + 3 * 60_000 + 52_000;
    const parsed = candles(codec.parseMessage(UPDATE, PAIR, at));
    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.close).toBe(m("77509.20000000"));
    expect(parsed[0]!.closed).toBe(false);
  });

  it("marks a candle closed once its minute has ended at receipt time", () => {
    const at = OPEN_1732 + 4 * 60_000; // 17:36, so 17:35 has closed
    expect(candles(codec.parseMessage(UPDATE, PAIR, at))[0]!.closed).toBe(true);
  });

  it("refuses to attribute another market's candles to this pair (spec 5.7)", () => {
    const wrong = SNAPSHOT.replaceAll('"symbol":"BTC/USDT"', '"symbol":"ETH/USDT"');
    const events = codec.parseMessage(wrong, PAIR, AT_1744);
    expect(events).toHaveLength(1);
    expect(events[0]!.kind).toBe("malformed");
    expect(events[0]).toMatchObject({ reason: expect.stringContaining("ETH/USDT") });
  });

  it("rejects a candle of an interval it did not subscribe to", () => {
    const wrong = UPDATE.replace('"interval":1', '"interval":5');
    expect(codec.parseMessage(wrong, PAIR, AT_1744)[0]!.kind).toBe("malformed");
  });

  it("reports a non-numeric price as malformed rather than throwing", () => {
    const stringy = UPDATE.replace('"close":77509.2', '"close":"77509.2"');
    const events = codec.parseMessage(stringy, PAIR, AT_1744);
    expect(events[0]!.kind).toBe("malformed");
  });

  it("reports an unparseable interval_begin as malformed", () => {
    const broken = UPDATE.replace('"2026-09-10T17:35:00.000000000Z"', '"not-a-time"');
    expect(codec.parseMessage(broken, PAIR, AT_1744)[0]!.kind).toBe("malformed");
  });
});

describe("KrakenPriceFeedCodec.parseMessage — control frames", () => {
  it("reads the bare heartbeat, stamping it with receipt time", () => {
    expect(codec.parseMessage(HEARTBEAT, PAIR, AT_1744)).toStrictEqual([
      { kind: "heartbeat", at: AT_1744 },
    ]);
  });

  it("ignores the status frame and a successful subscribe ack", () => {
    expect(codec.parseMessage(STATUS, PAIR, AT_1744)[0]!.kind).toBe("ignored");
    expect(codec.parseMessage(ACK_OK, PAIR, AT_1744)[0]!.kind).toBe("ignored");
  });

  it("surfaces a REJECTED subscribe as malformed, so it alerts instead of going quiet", () => {
    // This is the difference from the failure this codec was written to close:
    // Kraken answers a bad symbol with `success:false` and then sends nothing
    // forever, while heartbeats keep every liveness detector green.
    const events = codec.parseMessage(ACK_ERR, PAIR, AT_1744);
    expect(events).toHaveLength(1);
    expect(events[0]!.kind).toBe("malformed");
    expect(events[0]).toMatchObject({
      reason: expect.stringContaining("Currency pair not supported"),
    });
  });

  it("never throws on junk, per the codec contract", () => {
    expect(codec.parseMessage("not json{", PAIR, AT_1744)[0]!.kind).toBe("malformed");
    expect(codec.parseMessage("[1,2,3]", PAIR, AT_1744)[0]!.kind).toBe("malformed");
    expect(codec.parseMessage("null", PAIR, AT_1744)[0]!.kind).toBe("malformed");
    expect(codec.parseMessage('{"channel":"ohlc"}', PAIR, AT_1744)[0]!.kind).toBe("malformed");
    expect(codec.parseMessage('{"nope":1}', PAIR, AT_1744)[0]!.kind).toBe("malformed");
  });

  it("ignores a channel it did not subscribe to", () => {
    expect(codec.parseMessage('{"channel":"book","data":[]}', PAIR, AT_1744)[0]!.kind).toBe(
      "ignored",
    );
  });
});

describe("KrakenPriceFeedCodec — it is not Gemini's codec", () => {
  it("treats a Gemini candles_1m_updates frame as unrecognised, not as candles", () => {
    // The exact shape the Kraken feeds were being fed for their whole life.
    const geminiFrame = JSON.stringify({
      type: "candles_1m_updates",
      symbol: "BTCUSDT",
      changes: [[1_789_061_520_000, 77223.56, 77223.56, 77223.56, 77223.56, 0]],
    });
    const events = codec.parseMessage(geminiFrame, PAIR, AT_1744);
    expect(candles(events)).toHaveLength(0);
    expect(events[0]!.kind).toBe("malformed");
  });
});
