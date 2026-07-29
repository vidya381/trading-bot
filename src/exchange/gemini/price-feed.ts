/**
 * Gemini's price-feed codec: the transport-free translation of Gemini's v2
 * marketdata framing (spec section 4.6, decision-log step 14, Session B).
 *
 * Pure and stateless. It knows Gemini's WebSocket URL, the `candles_1m` subscribe
 * frame, and how to read a `candles_1m_updates` payload -- and nothing about
 * sockets, reconnection, or state, all of which belong to the `PriceFeed` Durable
 * Object built in a later session.
 *
 * The shapes here were confirmed against the LIVE Gemini sandbox by the step 14
 * reachability probe, not read from documentation alone:
 *
 *  - The candle message type is `candles_1m_updates`, carrying a `changes` array
 *    of `[timeMs, open, high, low, close, volume]` rows -- the SAME row format the
 *    REST `/v2/candles` endpoint returns, so `parseCandles` (Session A) is reused
 *    verbatim: the same JSON-number->Money rounding and the same
 *    `closed = at > closeTime` inference, because Gemini sends no closed flag.
 *  - `heartbeat` messages also arrive; they carry no market data.
 *  - Closure is inferable ONLY by a newer candle timestamp appearing over time,
 *    which at this pure layer is captured by the time-based `closed` flag; the
 *    cross-message watermark that closes each candle exactly once is the Durable
 *    Object's job, not the codec's.
 */

import type { Pair, Timestamp } from "../../shared/exchange-client";
import type { FeedEvent, PriceFeedCodec } from "../price-feed-codec";
import { parseCandles } from "./parse";

/**
 * Gemini's marketdata WebSocket URLs, one per environment. Section 16 keeps the
 * two fully separate; the parallel of `GEMINI_BASE_URLS` for the socket.
 */
export const GEMINI_WS_URLS = {
  production: "wss://api.gemini.com/v2/marketdata",
  sandbox: "wss://api.sandbox.gemini.com/v2/marketdata",
} as const;

/** The candle interval this feed subscribes to, in milliseconds. */
const ONE_MINUTE_MS = 60_000;

export class GeminiPriceFeedCodec implements PriceFeedCodec {
  socketUrl(environment: string | undefined): string {
    switch (environment) {
      case "testnet":
        return GEMINI_WS_URLS.sandbox;
      case "production":
        return GEMINI_WS_URLS.production;
      default:
        throw new Error(
          `cannot choose a Gemini market-data WebSocket URL: ENVIRONMENT is ` +
            `${JSON.stringify(environment)}, not "testnet" or "production". ` +
            `Refusing rather than guessing which venue to reach.`,
        );
    }
  }

  /**
   * Subscribe to `pair`'s 1-minute candles.
   *
   * The pair is sent AS-IS (upper case): the step 14 probe subscribed with the
   * upper-case symbol and it worked. Note this differs from the REST path, where
   * `toGeminiSymbol` lower-cases the symbol into the URL -- v2 marketdata takes it
   * upper-cased in the frame instead.
   */
  subscribeMessage(pair: Pair): string {
    return JSON.stringify({
      type: "subscribe",
      subscriptions: [{ name: "candles_1m", symbols: [pair] }],
    });
  }

  parseMessage(raw: string, pair: Pair, at: Timestamp): FeedEvent[] {
    let msg: unknown;
    try {
      msg = JSON.parse(raw);
    } catch {
      return [{ kind: "malformed", reason: "frame was not valid JSON" }];
    }

    if (typeof msg !== "object" || msg === null) {
      return [
        {
          kind: "malformed",
          reason: `expected a JSON object, got ${msg === null ? "null" : typeof msg}`,
        },
      ];
    }

    const type = (msg as { type?: unknown }).type;
    if (typeof type !== "string") {
      return [{ kind: "malformed", reason: "message has no string `type` field" }];
    }

    switch (type) {
      case "heartbeat":
        return [{ kind: "heartbeat", at }];

      case "candles_1m_updates": {
        const changes = (msg as { changes?: unknown }).changes;
        try {
          // Reuse Session A's parser: `changes` is the same row shape as
          // `/v2/candles`. A malformed batch throws here and is surfaced as
          // `malformed` rather than crashing the feed.
          const candles = parseCandles(pair, changes, at, ONE_MINUTE_MS);
          return candles.map((candle) => ({ kind: "candle", candle }));
        } catch (error) {
          return [
            { kind: "malformed", reason: `candles_1m_updates: ${(error as Error).message}` },
          ];
        }
      }

      default:
        // A well-formed message of a type this feed did not subscribe to
        // (e.g. `l2_updates`). Benign -- not an error.
        return [{ kind: "ignored", reason: `unsubscribed message type ${JSON.stringify(type)}` }];
    }
  }
}
