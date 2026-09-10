/**
 * Kraken's price-feed codec: the transport-free translation of Kraken's
 * WebSocket **v2** market-data framing (spec section 4.6, decision-log step 14).
 *
 * ---------------------------------------------------------------------------
 * ⚠ WHY THIS FILE EXISTS -- THE BUG IT CLOSES
 * ---------------------------------------------------------------------------
 * `PriceFeed` hardcoded `new GeminiPriceFeedCodec()` as its only codec and used
 * the `exchange` half of its own `{exchange, pair}` config for NOTHING but the
 * alert `source` label. Every feed named `kraken:<PAIR>` therefore dialled
 * `wss://api.gemini.com/v2/marketdata` and subscribed to GEMINI's book, while
 * every bot on it placed real orders on Kraken through `kraken/client.ts`.
 *
 * It was invisible from the inside. The socket was healthy, heartbeats current,
 * frames well-formed, every price stamped with a fresh receipt time. What gave
 * it away was `price_feed_value_frozen` firing on `kraken:BTCUSDT` at
 * 77223.56 -- a number Kraken never printed, and Gemini's exact last trade.
 * Gemini's BTC/USDT and ETH/USDT markets carry ~2.4 BTC and ~1.0 ETH of daily
 * volume against Kraken's ~83 BTC, so the wrong venue was also a nearly dead
 * one, and the feed froze for hours at a time while Kraken traded normally.
 *
 * The independent cross-check (`reconciliation/price-cross-check.ts`) did not
 * catch it and was not going to: its `DIVERGENCE_THRESHOLD` is 2%, and the two
 * venues quote the same asset, so the readings sat 0.07%-1.07% apart -- well
 * inside a threshold set to catch an IMPLAUSIBLE price, not a stale one from
 * the wrong exchange. Widening that threshold would be treating the symptom.
 * The fix is that codec selection is now correct by construction; see
 * `../price-feed-dispatch.ts`.
 *
 * ---------------------------------------------------------------------------
 * EVERYTHING BELOW WAS CONFIRMED LIVE, 2026-09-10, NOT READ FROM DOCUMENTATION
 * ---------------------------------------------------------------------------
 * Against `wss://ws.kraken.com/v2` with a real, credential-free subscription.
 * This matters: several "documented" Kraken facts did not survive contact with
 * the live venue tonight, and one of them is load-bearing here (see SYMBOLS).
 *
 *  - SUBSCRIBE frame:
 *      {"method":"subscribe","params":{"channel":"ohlc","symbol":["BTC/USDT"],"interval":1}}
 *  - ACK:  {"method":"subscribe","result":{...,"symbol":"BTC/USDT"},"success":true,...}
 *    REJECTION: {"error":"Currency pair not supported XBT/USDT","method":"subscribe",
 *                "success":false,"symbol":"XBT/USDT",...}
 *  - `{"channel":"status","type":"update","data":[{...}]}` once on connect.
 *  - `{"channel":"heartbeat"}` -- and NOTHING ELSE. It carries no timestamp, so
 *    receipt time is the only clock available; the interface already passes it.
 *    Cadence measured at ~1/second (27 frames in 28s), four to five times
 *    faster than Gemini's, which is why `STALENESS_MS` (20s, "~4 missed
 *    heartbeats of headroom" for Gemini) needs no change -- for Kraken it is
 *    ~20 missed heartbeats of headroom. Strictly safer, so nothing in the
 *    Durable Object's reconnection or staleness handling is Gemini-specific.
 *  - `{"channel":"ohlc","type":"snapshot"|"update","timestamp":...,"data":[row,...]}`
 *    where each row is an OBJECT (not Gemini's positional array):
 *      {"symbol":"BTC/USDT","open":77400.0,"high":77445.8,"low":77400.0,
 *       "close":77416.3,"trades":15,"volume":0.25302078,"vwap":77416.2,
 *       "interval_begin":"2026-09-10T17:32:00.000000000Z","interval":1,
 *       "timestamp":"2026-09-10T17:33:00.000000Z"}
 *    Prices and volumes are JSON NUMBERS, so they take the same
 *    `toFixed(SCALE)` treatment `gemini/parse.ts` documents for candle fields:
 *    acceptable precisely because a candle drives a DECISION, never settlement.
 *
 *  - ⚠ `interval_begin`, NEVER `timestamp`. Kraken's own ack says so, in a
 *    `warnings` array it returns on every successful ohlc subscription:
 *      "timestamp is deprecated, use interval_begin"
 *    The per-row `timestamp` is the interval's END, one minute later, and
 *    reading it as an open time would shift every candle forward by a minute.
 *    `interval_begin` carries NANOSECOND precision (9 fractional digits);
 *    `Date.parse` truncates it to milliseconds correctly (verified) and returns
 *    NaN on anything malformed, which `candleTime` below turns into a
 *    `malformed` event rather than an `Invalid Date`.
 *
 *  - ROLLOVER IS CURRENT-ONLY, measured across two live minute boundaries: an
 *    `update` carries ONLY the in-progress candle and never re-sends the one
 *    that just closed. This is the SAME shape the step 14 probe found on Gemini,
 *    so `PriceFeed.#ingestCandles` -- which closes a candle when a newer
 *    `openTime` appears, rather than trusting any `closed` flag -- already
 *    handles Kraken unchanged. The reconnect `snapshot` (9 rows observed, empty
 *    minutes simply absent) is the gap-backfill batch that same method expects,
 *    oldest-first.
 */

import { fromDecimalString, SCALE, type Money } from "../../shared/money";
import type { Candle, Pair, Timestamp } from "../../shared/exchange-client";
import type { FeedEvent, PriceFeedCodec } from "../price-feed-codec";

/**
 * Kraken's market-data WebSocket. ONE URL, both environments, deliberately.
 *
 * This is `kraken/public.ts`'s decision verbatim and for its reasons: Kraken
 * publishes no sandbox, and entry 90 DECISION 1 -- `resolveKrakenExchange`
 * refusing to build a testnet client -- is an argument about ORDERS, not about
 * reading a public market. This codec holds no credentials, signs nothing, and
 * cannot place an order by construction; a feed is a read. The alternative,
 * pointing a testnet feed at a simulator, is the exact fault entry 86 recorded
 * (a sandbox publishes fiction with a fresh timestamp) and would rebuild in the
 * feed the very thing this file exists to remove from it.
 *
 * In practice no Kraken feed can exist in testnet anyway: `venue-wiring.ts`
 * refuses to create the bot and `resolveKrakenExchange` refuses to build its
 * client, so this is belt-and-braces rather than a live path.
 */
export const KRAKEN_WS_URL = "wss://ws.kraken.com/v2";

/** The candle interval this feed subscribes to. Kraken names it in MINUTES. */
const INTERVAL_MINUTES = 1;

/** The same interval in milliseconds, for deriving each candle's close time. */
const ONE_MINUTE_MS = 60_000;

/**
 * Kraken v2's quote assets, in this system's ticker convention, ORDERED BY HOW
 * MANY LIVE PAIRS USE EACH. Derived from `/public/AssetPairs` on 2026-09-10
 * (1449 pairs), then aliased through `KRAKEN_ASSET_TICKER_ALIASES`' rule so
 * `XBT` reads as `BTC` and `XDG` as `DOGE` -- the convention the rest of this
 * system already stores pairs in.
 *
 * ⚠ THE ORDER IS LOAD-BEARING AND IT IS NOT LENGTH. `concentration.ts` sorts
 * its quote suffixes longest-first, and for a general grouping key that is
 * right: with `["USD","USDT"]` the wrong way round, `BTCUSDT` strips `USD` and
 * yields `BTCT`. Applied to Kraken's real catalogue, though, longest-first is
 * WRONG 42 times out of 1449 -- because `AUSD` is a genuine Kraken quote asset,
 * so `ADAUSD` splits as `AD` + `AUSD` instead of `ADA` + `USD`, and likewise
 * for every base ending in A quoted in USD (`GALAUSD`, `KAVAUSD`, `ARPAUSD`...).
 *
 * Frequency ordering gets 1444/1449, because `USD` (666 pairs) is tried before
 * `AUSD` (2). The five it still gets wrong are pairs whose base genuinely ends
 * in the text of a more popular quote, and they are listed explicitly in
 * `SYMBOL_EXCEPTIONS` below. Together the two are exact on all 1449.
 */
const QUOTE_ASSETS: readonly string[] = [
  "USD", "EUR", "USDT", "USDC", "BTC", "GBP", "ETH", "AUD",
  "CAD", "JPY", "CHF", "SOFID", "EURC", "USD1", "SOL", "EUROP",
  "PYUSD", "AUSD", "FIDD", "DAI", "RLUSD", "USDD", "USDQ", "USDR",
];

/**
 * The pairs no suffix rule can split correctly, because their base asset ENDS
 * IN a more popular quote asset's text. Every one verified accepted by the live
 * v2 socket in the spelling given here.
 *
 * This is a snapshot of a catalogue that changes, and it is not the last line
 * of defence: a pair that splits wrongly produces a symbol Kraken REJECTS, and
 * `parseMessage` turns that rejection into a `malformed` event -- an alert on
 * connect, not a silent feed. That is the difference from the failure this file
 * exists to close, which had no signal at all.
 */
const SYMBOL_EXCEPTIONS: Readonly<Record<string, string>> = Object.freeze({
  ETHPYUSD: "ETH/PYUSD",
  BTCPYUSD: "BTC/PYUSD",
  MONAUSD: "MON/AUSD",
  BTCAUSD: "BTC/AUSD",
  XRPRLUSD: "XRP/RLUSD",
});

/**
 * This system's `BTCUSDT` -> Kraken v2's `BTC/USDT`.
 *
 * ⚠ NOT the `wsname` from `/public/AssetPairs`, and this is the fact that did
 * not survive contact with the venue. `AssetPairs` reports `XBTUSDT`'s wsname
 * as `XBT/USDT`, `catalogue.ts` records that "every live pair's wsname IS its
 * altname once separators are stripped", and the REST API genuinely wants
 * `XBTUSDT`. The v2 socket REFUSES `XBT/USDT` outright:
 *
 *     {"error":"Currency pair not supported XBT/USDT","success":false,...}
 *
 * v2 names assets in ISO-4217-A3 form -- `BTC`, not Kraken's historic `XBT` --
 * which is the convention this system already stores. So the translation is not
 * a venue lookup at all: split our own pair, insert a slash. Confirmed live
 * against 12 pairs including every exception above, all accepted.
 *
 * Also rejected live, and worth stating because each is a plausible mistake:
 * `BTCUSDT` with no slash ("not in ISO 4217-A3 format") and lower-case
 * `btc/usdt` ("not supported"). The symbol must be upper-case and slashed.
 *
 * @throws when the pair ends in no quote asset this build knows. Fail closed:
 *   a guessed symbol is how a feed ends up quoting something nobody asked for.
 */
export function toKrakenWsSymbol(pair: Pair): string {
  const upper = pair.trim().toUpperCase();

  const exception = SYMBOL_EXCEPTIONS[upper];
  if (exception !== undefined) return exception;

  for (const quote of QUOTE_ASSETS) {
    // `>` not `>=`, like `resolveBaseAsset`: a pair that IS its own quote asset
    // would otherwise yield an empty base and a symbol beginning with "/".
    if (upper.length > quote.length && upper.endsWith(quote)) {
      return `${upper.slice(0, upper.length - quote.length)}/${quote}`;
    }
  }

  throw new Error(
    `cannot build a Kraken v2 WebSocket symbol for pair ${JSON.stringify(pair)}: ` +
      `it ends in none of the ${QUOTE_ASSETS.length} quote assets this build knows. ` +
      `Refusing to guess a symbol rather than subscribing to a market nobody asked for.`,
  );
}

/** A candle field arriving as a JSON number, converted the way Gemini's does. */
function candleMoney(value: unknown, field: string, context: string): Money {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${context}: expected ${field} to be a finite number, got ${typeof value}`);
  }
  // `toFixed(SCALE)` both rounds to this system's 8 decimals and removes the
  // scientific notation `String(1e-7)` would produce, which `fromDecimalString`
  // rejects. Same rule, same reason, as `gemini/parse.ts`.
  return fromDecimalString(value.toFixed(SCALE));
}

/** `interval_begin` -- an ISO-8601 instant with nanosecond precision -- as ms. */
function candleTime(value: unknown, context: string): Timestamp {
  if (typeof value !== "string") {
    throw new Error(`${context}: expected interval_begin to be a string, got ${typeof value}`);
  }
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) {
    throw new Error(`${context}: interval_begin ${JSON.stringify(value)} is not a valid instant`);
  }
  return ms;
}

export class KrakenPriceFeedCodec implements PriceFeedCodec {
  socketUrl(environment: string | undefined): string {
    switch (environment) {
      case "testnet":
      case "production":
        return KRAKEN_WS_URL;
      default:
        throw new Error(
          `cannot choose a Kraken market-data WebSocket URL: ENVIRONMENT is ` +
            `${JSON.stringify(environment)}, not "testnet" or "production". ` +
            `Refusing rather than guessing which venue to reach.`,
        );
    }
  }

  subscribeMessage(pair: Pair): string {
    return JSON.stringify({
      method: "subscribe",
      params: {
        channel: "ohlc",
        symbol: [toKrakenWsSymbol(pair)],
        interval: INTERVAL_MINUTES,
      },
    });
  }

  parseMessage(raw: string, pair: Pair, at: Timestamp): FeedEvent[] {
    let msg: unknown;
    try {
      msg = JSON.parse(raw);
    } catch {
      return [{ kind: "malformed", reason: "frame was not valid JSON" }];
    }

    if (typeof msg !== "object" || msg === null || Array.isArray(msg)) {
      return [
        {
          kind: "malformed",
          reason: `expected a JSON object, got ${msg === null ? "null" : typeof msg}`,
        },
      ];
    }

    const record = msg as Record<string, unknown>;

    // ── METHOD REPLIES ──
    //
    // A REJECTED subscribe is `malformed`, NOT `ignored`, and that is the whole
    // point of reading these at all. Kraken answers an unknown or misspelled
    // symbol with `success:false` and then simply sends nothing, forever: the
    // socket stays open, heartbeats keep arriving, and every liveness detector
    // in spec 5.7 stays green over a feed that will never deliver a price.
    // Surfacing it as `malformed` puts a `price_feed_malformed` alert on the
    // board within a second of connecting, which is the signal the Gemini
    // misrouting never had.
    if (typeof record["method"] === "string") {
      if (record["success"] === false) {
        const error = typeof record["error"] === "string" ? record["error"] : "no reason given";
        const symbol = typeof record["symbol"] === "string" ? ` for ${record["symbol"]}` : "";
        return [
          {
            kind: "malformed",
            reason:
              `Kraken refused the ${String(record["method"])} request${symbol}: ${error}. ` +
              `This feed is connected but will receive no candles until it is fixed.`,
          },
        ];
      }
      return [{ kind: "ignored", reason: `${String(record["method"])} acknowledgement` }];
    }

    const channel = record["channel"];
    if (typeof channel !== "string") {
      return [{ kind: "malformed", reason: "message has no string `channel` or `method` field" }];
    }

    switch (channel) {
      case "heartbeat":
        // Kraken's heartbeat is the bare `{"channel":"heartbeat"}` -- no clock
        // of its own, so receipt time is the only honest answer.
        return [{ kind: "heartbeat", at }];

      case "ohlc": {
        const rows = record["data"];
        if (!Array.isArray(rows)) {
          return [{ kind: "malformed", reason: "ohlc message has no `data` array" }];
        }
        try {
          const candles = rows.map((row, index) =>
            this.#parseRow(row, pair, at, `ohlc data row ${index}`),
          );
          // Oldest-first is what `PriceFeed.#ingestCandles` relies on to treat
          // the last row of a reconnect batch as the in-progress candle. The
          // live snapshot already arrives ascending; sorting says so rather than
          // assuming it, exactly as `parseCandles` does for Gemini.
          candles.sort((a, b) => a.openTime - b.openTime);
          return candles.map((candle) => ({ kind: "candle", candle }));
        } catch (error) {
          return [{ kind: "malformed", reason: `ohlc: ${(error as Error).message}` }];
        }
      }

      default:
        // `status` on connect, and any channel this feed did not subscribe to.
        return [{ kind: "ignored", reason: `unsubscribed channel ${JSON.stringify(channel)}` }];
    }
  }

  /** One `ohlc` data object -> a `Candle`. Throws; the caller maps to malformed. */
  #parseRow(row: unknown, pair: Pair, at: Timestamp, context: string): Candle {
    if (typeof row !== "object" || row === null || Array.isArray(row)) {
      return (() => {
        throw new Error(`${context}: expected an object`);
      })();
    }
    const r = row as Record<string, unknown>;

    // SPEC 5.7 DETECTOR 3, the same guard `gemini/price-feed.ts` carries and for
    // the same reason: one socket per (exchange, pair) makes a mismatch
    // impossible today, and the day it stops being true an unchecked
    // attribution is SILENT PRICE CORRUPTION -- every bot on this pair trading
    // another market's candles, well-formed and freshly stamped. Compared
    // against the symbol we asked for, so `BTC/USDT` matches `BTCUSDT`.
    const symbol = r["symbol"];
    if (typeof symbol === "string" && symbol.toUpperCase() !== toKrakenWsSymbol(pair)) {
      throw new Error(
        `${context}: carried symbol ${JSON.stringify(symbol)} on the feed subscribed to ` +
          `${JSON.stringify(toKrakenWsSymbol(pair))}. Refusing to attribute another ` +
          `market's candles to this one (spec 5.7).`,
      );
    }

    // The interval is asserted, not assumed. A candle of a different width
    // silently treated as one minute would misdate every close time it derives.
    const interval = r["interval"];
    if (interval !== undefined && interval !== INTERVAL_MINUTES) {
      throw new Error(
        `${context}: interval is ${JSON.stringify(interval)}, not the ` +
          `${INTERVAL_MINUTES}-minute candles this feed subscribed to`,
      );
    }

    const openTime = candleTime(r["interval_begin"], context);
    return {
      pair,
      openTime,
      // The candle's last millisecond, the inclusive convention the rest of this
      // system uses. Kraken's own per-row `timestamp` is the EXCLUSIVE end and
      // is deprecated besides; deriving is both correct and futureproof.
      closeTime: openTime + ONE_MINUTE_MS - 1,
      open: candleMoney(r["open"], "open", context),
      high: candleMoney(r["high"], "high", context),
      low: candleMoney(r["low"], "low", context),
      close: candleMoney(r["close"], "close", context),
      volume: candleMoney(r["volume"], "volume", context),
      closed: at > openTime + ONE_MINUTE_MS - 1,
    };
  }
}
