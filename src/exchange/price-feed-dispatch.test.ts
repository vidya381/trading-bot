/**
 * The venue -> price-feed-codec table, as a STRUCTURAL property rather than a
 * list of examples.
 *
 * These tests are written so that a fourth exchange cannot be added without
 * answering for its market-data feed. Two of them fail to COMPILE if
 * `ExchangeId` widens (the total `Record` literals below), and the rest fail at
 * runtime if a venue is given another venue's codec, or a codec whose socket
 * points somewhere its venue does not.
 *
 * The bug being fenced off: `PriceFeed` held one hardcoded
 * `GeminiPriceFeedCodec` and ignored its own `exchange` field, so `kraken:*`
 * feeds quoted Gemini's near-dead BTC/USDT and ETH/USDT books to bots trading
 * with real money on Kraken. Nothing in the type system objected, because
 * nothing had to.
 */

import { describe, expect, it } from "vitest";
import { EXCHANGE_IDS, type ExchangeId } from "../db/schema";
import { GeminiPriceFeedCodec } from "./gemini/price-feed";
import { KrakenPriceFeedCodec } from "./kraken/price-feed";
import { PRICE_FEED_CODECS, priceFeedCodecFor } from "./price-feed-dispatch";
import type { PriceFeedCodec } from "./price-feed-codec";

/**
 * COMPILE-TIME TOTALITY. A `Record<ExchangeId, ...>` cannot be built from a
 * table missing a key, so widening `ExchangeId` breaks this line until the new
 * venue has an entry -- the same forcing function `EXCHANGE_RESOLVERS` and
 * `METHOD_COSTS` rely on, asserted here as well so the property is visible in
 * the tests and not only in the implementation.
 */
const _totality: Readonly<Record<ExchangeId, PriceFeedCodec | null>> = PRICE_FEED_CODECS;
void _totality;

/**
 * The production market-data host each venue's feed MUST dial, stated
 * independently of the codecs themselves.
 *
 * ⚠ This is the test that would have caught the original bug on day one, and it
 * is deliberately a total `Record`: a fourth exchange does not compile until
 * someone writes down which host its feed talks to, and a codec that dials the
 * wrong venue fails here no matter how well it parses.
 *
 * `null` means the venue has no feed codec in this build.
 */
const EXPECTED_FEED_HOST: Readonly<Record<ExchangeId, string | null>> = {
  binance: null,
  gemini: "api.gemini.com",
  kraken: "ws.kraken.com",
};

describe("PRICE_FEED_CODECS — totality", () => {
  it("has an entry for every ExchangeId, with none missing or undefined", () => {
    for (const id of EXCHANGE_IDS) {
      expect(Object.hasOwn(PRICE_FEED_CODECS, id)).toBe(true);
      expect(PRICE_FEED_CODECS[id]).not.toBeUndefined();
    }
  });

  it("has no entries beyond the ExchangeId union", () => {
    expect(Object.keys(PRICE_FEED_CODECS).sort()).toStrictEqual([...EXCHANGE_IDS].sort());
  });
});

describe("PRICE_FEED_CODECS — no venue silently reuses another's codec", () => {
  it("gives each wired venue its OWN codec instance", () => {
    const wired = EXCHANGE_IDS.map((id) => PRICE_FEED_CODECS[id]).filter(
      (c): c is PriceFeedCodec => c !== null,
    );
    expect(new Set(wired).size).toBe(wired.length);
  });

  it("gives each wired venue a codec of its own CLASS", () => {
    const classes = EXCHANGE_IDS.map((id) => PRICE_FEED_CODECS[id])
      .filter((c): c is PriceFeedCodec => c !== null)
      .map((c) => c.constructor);
    expect(new Set(classes).size).toBe(classes.length);
  });

  it("maps kraken to the Kraken codec and gemini to the Gemini codec", () => {
    // Stated explicitly as well as structurally: this exact pair of assertions
    // is what was false in production.
    expect(PRICE_FEED_CODECS.kraken).toBeInstanceOf(KrakenPriceFeedCodec);
    expect(PRICE_FEED_CODECS.gemini).toBeInstanceOf(GeminiPriceFeedCodec);
    expect(PRICE_FEED_CODECS.kraken).not.toBeInstanceOf(GeminiPriceFeedCodec);
  });
});

describe("PRICE_FEED_CODECS — every codec dials its own venue", () => {
  it.each(EXCHANGE_IDS)("%s's feed points at the host that venue is meant to use", (id) => {
    const codec = PRICE_FEED_CODECS[id];
    const expected = EXPECTED_FEED_HOST[id];

    if (expected === null) {
      expect(codec).toBeNull();
      return;
    }
    expect(codec).not.toBeNull();
    expect(new URL(codec!.socketUrl("production")).host).toBe(expected);
  });

  it("gives no two venues the same production socket URL", () => {
    const urls = EXCHANGE_IDS.map((id) => PRICE_FEED_CODECS[id])
      .filter((c): c is PriceFeedCodec => c !== null)
      .map((c) => c.socketUrl("production"));
    expect(new Set(urls).size).toBe(urls.length);
  });
});

describe("priceFeedCodecFor", () => {
  it("returns the venue's own codec", () => {
    expect(priceFeedCodecFor("kraken")).toBeInstanceOf(KrakenPriceFeedCodec);
    expect(priceFeedCodecFor("gemini")).toBeInstanceOf(GeminiPriceFeedCodec);
  });

  it("THROWS for a venue with no codec, naming it — never substitutes another", () => {
    // The whole point. A missing codec is a visible outage; the alternative,
    // quietly handing back some other venue's codec, is the bug this replaces.
    expect(() => priceFeedCodecFor("binance")).toThrow(/binance/);
    expect(() => priceFeedCodecFor("binance")).toThrow(/no price-feed codec/);
  });

  it("does not fall back to Gemini for an unwired venue", () => {
    let returned: PriceFeedCodec | null = null;
    try {
      returned = priceFeedCodecFor("binance");
    } catch {
      returned = null;
    }
    expect(returned).toBeNull();
  });
});
