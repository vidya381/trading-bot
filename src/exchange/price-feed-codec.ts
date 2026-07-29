/**
 * The price-feed codec: the exchange-specific, TRANSPORT-FREE half of the live
 * price feed (spec section 4.6, decision-log step 14).
 *
 * This is the WebSocket analogue of `parse.ts`: it turns one exchange's own
 * market-data framing into this system's types, and knows nothing about sockets,
 * reconnection, alarms, or Durable Objects. A `PriceFeedCodec` is pure and
 * stateless -- given the same inputs it returns the same events -- so it can be
 * unit-tested against captured real payloads with no network, exactly as the REST
 * parsers are. The `PriceFeed` Durable Object (a later step) owns the socket and
 * the state; it calls a codec for every exchange-specific decision.
 *
 * Why a codec at all, rather than methods on the exchange client: step 14
 * established that an OUTBOUND WebSocket does not hibernate and cannot be a client
 * method the way section 4.1 first imagined. The feed lives in its own object, and
 * the only per-exchange knowledge that object needs -- which URL, what to send,
 * how to read a frame -- is exactly these three pure functions.
 */

import type { Candle, Pair, Timestamp } from "../shared/exchange-client";

/**
 * One thing the feed learned from a single inbound frame.
 *
 * A frame can yield zero, one, or many events (a candle batch is many). The four
 * kinds are what the Durable Object switches on:
 *
 *  - `candle`  -- a candle to consider forwarding. `candle.closed` says whether
 *    its minute has ended at receipt time; the object forwards only closed ones
 *    and dedups them against its own watermark.
 *  - `heartbeat` -- a liveness ping. It carries no market data, but it is NOT
 *    silently dropped: the object uses it as evidence the socket is alive, which
 *    its staleness alarm cares about.
 *  - `ignored` -- a well-formed message of a type this feed did not subscribe to
 *    (e.g. an `l2` update). Benign; the object may debug-log it and move on.
 *  - `malformed` -- a message of a type we DID recognise but could not parse, or a
 *    frame that was not even JSON. Distinct from `ignored` on purpose: it is
 *    evidence of an API change, so the object can ALERT on it rather than swallow
 *    it. `parseMessage` never throws (one bad frame must not crash the feed), so
 *    this kind is how a parse failure travels instead.
 */
export type FeedEvent =
  | { readonly kind: "candle"; readonly candle: Candle }
  | { readonly kind: "heartbeat"; readonly at: Timestamp }
  | { readonly kind: "ignored"; readonly reason: string }
  | { readonly kind: "malformed"; readonly reason: string };

/**
 * The pure, per-exchange price-feed codec. One implementation per exchange, the
 * same shape the REST client split already uses.
 */
export interface PriceFeedCodec {
  /**
   * The market-data WebSocket URL for an environment, chosen ONLY from
   * `ENVIRONMENT` -- the same non-configurable, fail-closed derivation every REST
   * base URL in this project uses (`geminiBaseUrlForEnvironment`,
   * `baseUrlForEnvironment`). An unrecognised value throws rather than guessing
   * which venue to dial, so testnet can never reach production's feed.
   */
  socketUrl(environment: string | undefined): string;

  /** The frame to send once the socket opens, to subscribe to `pair`'s feed. */
  subscribeMessage(pair: Pair): string;

  /**
   * Turn one raw inbound frame into events.
   *
   * `pair` is the pair this connection is for -- a v1 feed socket carries exactly
   * one (exchange, pair), so the object supplies it rather than the codec having
   * to trust a `symbol` field on every message. `at` is receipt time, used to
   * derive each candle's `closed` flag (the same time-based inference
   * `getCandles` uses; the exchange sends no closed flag).
   *
   * Total: it NEVER throws. Anything unparseable becomes a `malformed` event.
   */
  parseMessage(raw: string, pair: Pair, at: Timestamp): FeedEvent[];
}
