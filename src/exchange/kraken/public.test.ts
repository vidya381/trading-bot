/**
 * The credential-free Kraken client (`public.ts`).
 *
 * Two properties, and the file exists for both:
 *
 *   1. Every PUBLIC endpoint works with no credentials whatsoever -- which is
 *      the claim `krakenPublicClient` rests on, and it is a claim about
 *      `KrakenSigner`'s laziness rather than about anything this file does, so
 *      it has to be exercised rather than reasoned about.
 *   2. Every PRIVATE endpoint fails LOCALLY, before anything is sent. A
 *      public-data client that quietly reached the network for a signed request
 *      would be a worse object than no object at all.
 *
 * ── PROVENANCE ──
 *
 * PULLED LIVE from `api.kraken.com` on 2026-09-04, verbatim, HTTP 200 on each:
 *
 *   AssetPairs  `GET /0/public/AssetPairs?pair=XBTUSD`. One edit, matching the
 *               other four Kraken test files: the `fees`, `fees_maker`,
 *               `leverage_buy` and `leverage_sell` arrays are dropped. Nothing
 *               this client reads is touched.
 *   Assets      `GET /0/public/Assets?asset=XXBT,ZUSD`.
 *   Ticker      `GET /0/public/Ticker?pair=XBTUSD`.
 *
 * The BTC price in the ticker below -- `80707.60000` -- is a real Kraken close
 * from that capture, and the tests that assert on it are asserting that this
 * client reads the venue's own number unaltered.
 */

import { describe, expect, it } from "vitest";

import { KrakenCatalogueCache } from "./catalogue";
import { KRAKEN_BASE_URLS, KRAKEN_ENDPOINTS, type FetchLike } from "./client";
import { krakenPublicClient, PublicOnlyCredentialProvider } from "./public";
import { CredentialError } from "../credentials";
import { fromDecimalString as m } from "../../shared/money";

const AT = 1_788_500_000_000;

// --- LIVE, 2026-09-04 -------------------------------------------------------

const ASSET_PAIRS = {
  XXBTZUSD: {
    altname: "XBTUSD",
    wsname: "XBT/USD",
    aclass_base: "currency",
    base: "XXBT",
    aclass_quote: "currency",
    quote: "ZUSD",
    lot: "unit",
    cost_decimals: 5,
    pair_decimals: 1,
    lot_decimals: 8,
    lot_multiplier: 1,
    fee_volume_currency: "ZUSD",
    margin_call: 80,
    margin_stop: 40,
    ordermin: "0.00005",
    costmin: "0.5",
    tick_size: "0.1",
    status: "online",
    execution_venue: "international",
    long_position_limit: 350,
    short_position_limit: 250,
  },
};

const ASSETS = {
  XXBT: {
    aclass: "currency",
    altname: "XBT",
    decimals: 10,
    display_decimals: 5,
    collateral_value: 0.99,
    status: "enabled",
    margin_rate: "0.01",
  },
  ZUSD: {
    aclass: "currency",
    altname: "USD",
    decimals: 4,
    display_decimals: 2,
    collateral_value: 1.0,
    status: "enabled",
    margin_rate: "0.025",
  },
};

const TICKER = {
  XXBTZUSD: {
    a: ["80707.70000", "1", "1.000"],
    b: ["80707.60000", "1", "1.000"],
    c: ["80707.60000", "0.01238904"],
    v: ["411.01436585", "4408.65714967"],
    p: ["81004.92146", "80497.44351"],
    t: [26115, 145071],
    l: ["80561.90000", "77448.40000"],
    h: ["81431.10000", "82288.10000"],
    o: "81276.10000",
  },
};

// ---------------------------------------------------------------------------

function envelope(result: unknown): Response {
  return new Response(JSON.stringify({ error: [], result }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function publicClient(): { client: ReturnType<typeof krakenPublicClient>; urls: string[] } {
  const urls: string[] = [];
  const fetchLike: FetchLike = async (input) => {
    urls.push(input);
    const path = new URL(input).pathname;
    if (path === KRAKEN_ENDPOINTS.assetPairs) return envelope(ASSET_PAIRS);
    if (path === KRAKEN_ENDPOINTS.assets) return envelope(ASSETS);
    if (path === KRAKEN_ENDPOINTS.ticker) return envelope(TICKER);
    throw new Error(`unrouted path ${path}`);
  };
  return {
    client: krakenPublicClient({
      fetch: fetchLike as unknown as typeof fetch,
      now: () => AT,
      catalogueCache: new KrakenCatalogueCache(),
    }),
    urls,
  };
}

/** As `publicClient`, but recording the HTTP METHOD of every request sent. */
function publicClientRecording(methods: string[]): {
  client: ReturnType<typeof krakenPublicClient>;
} {
  const fetchLike: FetchLike = async (input, init) => {
    methods.push(init?.method ?? "GET");
    const path = new URL(input).pathname;
    if (path === KRAKEN_ENDPOINTS.assetPairs) return envelope(ASSET_PAIRS);
    if (path === KRAKEN_ENDPOINTS.assets) return envelope(ASSETS);
    return envelope({});
  };
  return {
    client: krakenPublicClient({
      fetch: fetchLike as unknown as typeof fetch,
      now: () => AT,
      catalogueCache: new KrakenCatalogueCache(),
    }),
  };
}

// ---------------------------------------------------------------------------

describe("public market data needs no credentials", () => {
  it("reads a live ticker and returns Kraken's own close", async () => {
    const { client } = publicClient();
    const outcome = await client.getCurrentPrice("BTCUSD");

    expect(outcome.ok).toBe(true);
    // `c[0]` from the live capture, unaltered. If this ever differs from the
    // fixture, this client is transforming a venue's price -- which is the one
    // thing a reference source must never do.
    expect(outcome.ok && outcome.value.price).toBe(m("80707.6"));
    expect(outcome.ok && outcome.value.pair).toBe("BTCUSD");
  });

  it("lists tradable pairs from the catalogue, with no key anywhere in the request", async () => {
    const { client, urls } = publicClient();
    const outcome = await client.listTradablePairs();

    expect(outcome.ok).toBe(true);
    expect(outcome.ok && outcome.value).toContain("BTCUSD");
    // Public GETs only. A signed request would have been a POST carrying an
    // `API-Key` header, and there is no key to put in one.
    expect(urls.every((url) => url.startsWith(KRAKEN_BASE_URLS.production))).toBe(true);
  });

  it("always reaches the real venue, because a simulated reference is not a reference", async () => {
    // Entry 86's finding, applied to this client's base URL: a sandbox publishes
    // fiction with a fresh timestamp, so a cross-check pointed at one would
    // rebuild the exact fault it exists to catch. There is deliberately no
    // environment parameter to get this wrong with.
    const { client, urls } = publicClient();
    await client.getCurrentPrice("BTCUSD");
    expect(urls[0]!.startsWith("https://api.kraken.com/")).toBe(true);
  });

  it("serves a second pair from the cached catalogue rather than refetching 1.1MB", async () => {
    const { client, urls } = publicClient();
    await client.getCurrentPrice("BTCUSD");
    const afterFirst = urls.length;
    await client.getCurrentPrice("BTCUSD");

    // One more request -- the ticker -- and no second AssetPairs/Assets pair.
    expect(urls.length - afterFirst).toBe(1);
    expect(urls.filter((url) => url.includes("AssetPairs"))).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------

describe("it cannot sign anything, and fails locally when asked to", () => {
  it("throws a CredentialError rather than handing out a placeholder key", () => {
    // NOT `StaticCredentialProvider` with blanks: that constructor refuses
    // blanks, and defeating it with a placeholder would produce a request that
    // LEAVES this process and is rejected at the venue.
    expect(() => new PublicOnlyCredentialProvider().getCredentials()).toThrow(CredentialError);
    expect(() => new PublicOnlyCredentialProvider().getCredentials()).toThrow(
      /public-market-data only/,
    );
  });

  it("names the failure as a wiring bug, not a missing secret", () => {
    // An operator sent to set KRAKEN_API_KEY over this would be fixing the
    // wrong thing, and would then have set a real trading key on a path built
    // to have none.
    try {
      new PublicOnlyCredentialProvider().getCredentials();
      expect.unreachable("expected a refusal");
    } catch (error) {
      expect((error as Error).message).toContain("wiring bug");
      expect((error as Error).message).toContain("setting KRAKEN_API_KEY will not fix it");
    }
  });

  it("⚠ SENDS NO SIGNED REQUEST when a private endpoint is reached", async () => {
    // The property that makes this object safe to hand to a periodic job. The
    // signing throw happens inside `#transport`'s try, which classifies it as
    // `reached: false` -- so this arrives as an ordinary failed outcome naming
    // the cause, and no signed bytes go to Kraken.
    //
    // ⚠ THE CLAIM IS "NO SIGNED REQUEST", NOT "NO REQUEST", and the distinction
    // was found by writing this test rather than assumed by writing this file.
    // `getAccountBalances` fetches the CATALOGUE first -- two public GETs it
    // needs to map Kraken's asset codes onto tickers -- and only then signs. So
    // a misrouted private call does emit public reads before it refuses. That is
    // harmless (they are unauthenticated market data this client is entitled to
    // make) and it is not what the guarantee is about: what must never leave is
    // a credential, and there is none to leave.
    const methods: string[] = [];
    const { client } = publicClientRecording(methods);

    const outcome = await client.getAccountBalances();

    expect(outcome.ok).toBe(false);
    expect(!outcome.ok && outcome.message).toContain("public-market-data only");
    expect(!outcome.ok && outcome.kind).toBe("transport");
    // Every request that went out was an unsigned GET. A signed one is a POST
    // carrying `API-Key`, and there is not one in the list.
    expect(methods).toEqual(["GET", "GET"]);
  });

  it("refuses an order without reaching the network for it", async () => {
    // The same property on the path that actually matters. `placeLimitOrder`
    // resolves the pair (public) and then signs, and the signing is where it
    // stops -- so this client cannot put an order on a real venue however it is
    // wired, which is the guarantee entry 90 DECISION 1 protects by refusing to
    // BUILD a testnet client. Here it holds by construction instead.
    //
    // `placeOrder` also runs section 4.3's second validation BEFORE signing, so
    // the values are real ones drawn from the live fixture's own grid (tick_size
    // 0.1, ordermin 0.00005) -- a request refused by the validator would prove
    // nothing about the credential path.
    const methods: string[] = [];
    const { client } = publicClientRecording(methods);

    const outcome = await client.placeOrder({
      pair: "BTCUSD",
      clientOrderId: "v1-should-never-be-sent",
      side: "buy",
      type: "limit",
      price: m("80000"),
      quantity: m("0.001"),
    });

    expect(outcome.ok).toBe(false);
    expect(!outcome.ok && outcome.message).toContain("public-market-data only");
    expect(methods.includes("POST")).toBe(false);
  });
});
