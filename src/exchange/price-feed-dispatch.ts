/**
 * Which price-feed codec a venue gets -- the seam that decides which EXCHANGE a
 * `PriceFeed` Durable Object actually dials.
 *
 * ---------------------------------------------------------------------------
 * ⚠ THE BUG THIS EXISTS TO MAKE IMPOSSIBLE
 * ---------------------------------------------------------------------------
 * `PriceFeed` used to hold ONE codec, built eagerly in a field initialiser:
 *
 *     codec: new GeminiPriceFeedCodec(),
 *
 * and its `{exchange, pair}` config -- the object's own identity, the thing its
 * Durable Object name is derived from -- was consulted for the alert `source`
 * string and nothing else. So `kraken:BTCUSDT` opened Gemini's socket, asked
 * Gemini for candles, and forwarded Gemini's prices to bots placing real orders
 * on Kraken. There was no fallback, no default branch, no warning: the wrong
 * answer was the ONLY answer, and every layer downstream was working correctly
 * on it. It ran that way until a frozen-value alert happened to fire on a
 * number Kraken had never printed.
 *
 * The lesson is not "remember to add a codec". It is that the question "which
 * venue does this feed talk to" must be answered by a TOTAL FUNCTION OF THE
 * VENUE, checked by the compiler, in one place -- so that a fourth exchange
 * cannot silently inherit a third one's socket the way Kraken inherited
 * Gemini's.
 *
 * ---------------------------------------------------------------------------
 * THE SHAPE, AND WHY IT MATCHES `EXCHANGE_RESOLVERS`
 * ---------------------------------------------------------------------------
 * This is deliberately the same construction as `workers/exchange-dispatch.ts`'
 * `EXCHANGE_RESOLVERS`, and `METHOD_COSTS`, and `VENUE_PUBLISHES_INSTRUMENT_TYPE`:
 * a total `Readonly<Record<ExchangeId, T | null>>`.
 *
 *   * TOTAL, so widening `ExchangeId` FAILS TO COMPILE here until the new venue
 *     is answered for. That is the forcing function a `switch` with a `default`
 *     -- or a hardcoded field -- does not have.
 *   * `null` rather than a missing key, so "does this build have a feed codec
 *     for this venue" is a question code can ASK. `venue-wiring.ts` learned the
 *     hard way that "does a `case` exist in a `switch`" is not askable, and a
 *     hand-maintained boolean alongside it goes stale.
 *   * `null` is the honest answer for a venue mid-build, and it FAILS LOUDLY at
 *     the point of use (`priceFeedCodecFor` throws, naming the venue). What it
 *     must never do is quietly resolve to some other venue's codec.
 *
 * `null` is NOT a policy statement that a venue should not be traded. Binance
 * has no market-data codec in this build -- only its REST client exists -- so
 * `null` is simply true. A Binance bot cannot get a live feed, and it now says
 * so instead of receiving Gemini's.
 */

import type { ExchangeId } from "../db/schema";
import { GeminiPriceFeedCodec } from "./gemini/price-feed";
import { KrakenPriceFeedCodec } from "./kraken/price-feed";
import type { PriceFeedCodec } from "./price-feed-codec";

/**
 * THE VENUE -> PRICE-FEED-CODEC TABLE, and the single source of truth for the
 * question "whose market data does a feed on this venue receive".
 *
 * Codecs are pure and stateless (the interface says so, and both implementations
 * hold no fields), so one shared instance per venue is correct and cheap. It
 * also makes "are these two venues sharing a codec" answerable by identity,
 * which `price-feed-dispatch.test.ts` asserts they are not.
 */
export const PRICE_FEED_CODECS: Readonly<Record<ExchangeId, PriceFeedCodec | null>> =
  Object.freeze({
    // No market-data codec in this build. Binance's REST client exists, but
    // nothing translates its WebSocket framing, and inventing an answer here is
    // precisely the failure this table exists to prevent.
    binance: null,
    gemini: new GeminiPriceFeedCodec(),
    kraken: new KrakenPriceFeedCodec(),
  });

/**
 * The codec for a venue, or a refusal that names the venue and the gap.
 *
 * @throws when the venue has no codec in this build. Throwing is the point: the
 *   caller is a Durable Object about to open a socket, and there is no safe
 *   default for "which exchange should this feed connect to". A feed that
 *   refuses to start is a visible outage; a feed connected to the wrong venue is
 *   an invisible one, and the second is what cost real capital.
 */
export function priceFeedCodecFor(exchange: ExchangeId): PriceFeedCodec {
  const codec = PRICE_FEED_CODECS[exchange];
  if (codec === null) {
    throw new Error(
      `${exchange} has no price-feed codec in this build, so no market-data ` +
        `socket can be opened for it. This is a gap in the build, not something ` +
        `a setting can fix -- and it is deliberately not satisfied by another ` +
        `venue's codec.`,
    );
  }
  return codec;
}
