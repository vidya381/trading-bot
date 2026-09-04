import { describe, expect, it } from "vitest";
import { isUsable } from "../../shared/downtime";
import type { OrderRequest } from "../../shared/exchange-client";
import { fromDecimalString as m, ZERO } from "../../shared/money";
import { fakeKrakenCredentialProvider } from "../credentials";
import { METHOD_COSTS } from "../rate-limited";
import { KrakenCatalogueCache } from "./catalogue";
import {
  KrakenClient,
  KRAKEN_BASE_URLS,
  KRAKEN_ENDPOINTS,
  KRAKEN_REQUEST_COSTS,
  type FetchLike,
} from "./client";

/**
 * ── PROVENANCE OF EVERY FIXTURE BELOW, STATED RATHER THAN ASSUMED ──
 *
 * The same two-tier discipline `parse.test.ts`, `catalogue.test.ts` and
 * `filters.test.ts` use tonight, and for the same reason: the halves are not
 * equally trustworthy and are not presented as though they were.
 *
 * PULLED LIVE from `api.kraken.com` on 2026-09-03, verbatim, HTTP 200 on every
 * one of them:
 *
 *   AssetPairs   `GET /0/public/AssetPairs?pair=XBTUSD,ETHXBT`
 *   Assets       `GET /0/public/Assets?asset=XXBT,ZUSD,XETH`
 *                One edit to each, matching the other three Kraken test files:
 *                the `fees`, `fees_maker`, `leverage_buy` and `leverage_sell`
 *                arrays are dropped. Nothing this client reads is touched.
 *   Ticker       `GET /0/public/Ticker?pair=XBTUSD`.
 *   OHLC         `GET /0/public/OHLC?pair=XBTUSD&interval=1&since=1788415200`,
 *                rows and the `last` sibling exactly as returned.
 *   Time         `GET /0/public/Time`.
 *   Error bodies `EQuery:Unknown asset pair` (`Ticker?pair=NOTAPAIR`),
 *                `EGeneral:Invalid arguments` (`OHLC&interval=360` -- the
 *                six-hour interval Kraken does not have) and `EAPI:Invalid key`
 *                (`POST /0/private/BalanceEx` with a junk key). ALL THREE
 *                ARRIVED OVER HTTP 200, which is why `#request` reads the error
 *                array before the status.
 *
 *   Also live, and it is the evidence behind one assertion below: Kraken's OHLC
 *   `since` is INCLUSIVE on a candle's OPEN time. `?interval=1&since=1788414900`
 *   returned a first row of `1788414900` itself.
 *
 * FROM KRAKEN'S PUBLISHED REFERENCE (the OpenAPI document at
 * `docs.kraken.com/openapi/spot-rest.yaml`), NOT LIVE, AND SAID SO PLAINLY: the
 * private payloads -- `AddOrder`, `CancelOrder`, `OpenOrders`, `ClosedOrders`,
 * `BalanceEx`. They need credentials this session does not have. Probing them
 * unauthenticated settles nothing either: Kraken checks the key BEFORE the
 * parameters, verified this session -- `QueryOrders` with a `cl_ord_id` and no
 * `txid` answers `EAPI:Invalid key`, not an argument error. So the request
 * schemas this client depends on (`cl_ord_id` accepted by `CancelOrder`,
 * `OpenOrders` and `ClosedOrders`; NOT accepted by `QueryOrders`) are
 * DOCUMENTED, NOT LIVE-VERIFIED.
 *
 * CONSTRUCTED, AND MARKED AT THE POINT OF USE: the pending-cancel race, the
 * duplicate client order id, the cross-pair order and the non-envelope error
 * page. Each is one edited field of a real payload, because none can be
 * requested on demand.
 */

const AT = 1_788_415_303_000;
const BASE = KRAKEN_BASE_URLS.production;
const CLIENT_ORDER_ID = "v1-bot-1toiyz-7";

// --------------------------------------------------------------------------
// Fixtures
// --------------------------------------------------------------------------

/** Live: GET /0/public/AssetPairs?pair=XBTUSD,ETHXBT (fee arrays dropped). */
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
  XETHXXBT: {
    altname: "ETHXBT",
    wsname: "ETH/XBT",
    aclass_base: "currency",
    base: "XETH",
    aclass_quote: "currency",
    quote: "XXBT",
    lot: "unit",
    cost_decimals: 10,
    pair_decimals: 6,
    lot_decimals: 8,
    lot_multiplier: 1,
    fee_volume_currency: "ZUSD",
    margin_call: 80,
    margin_stop: 40,
    ordermin: "0.001",
    costmin: "0.00002",
    tick_size: "0.000001",
    status: "online",
    execution_venue: "international",
    long_position_limit: 1000,
    short_position_limit: 800,
  },
};

/** Live: GET /0/public/Assets?asset=XXBT,ZUSD,XETH. */
const ASSETS = {
  XETH: {
    aclass: "currency",
    altname: "ETH",
    decimals: 10,
    display_decimals: 5,
    collateral_value: 0.99,
    status: "enabled",
    margin_rate: "0.02",
  },
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

/** Live: GET /0/public/Time. `unixtime` is SECONDS. */
const TIME_RESULT = { unixtime: 1788415303, rfc1123: "Thu, 03 Sep 26 06:01:43 +0000" };

/** Live: GET /0/public/Ticker?pair=XBTUSD. Keyed by the CANONICAL name. */
const TICKER_RESULT = {
  XXBTZUSD: {
    a: ["77726.10000", "1", "1.000"],
    b: ["77726.00000", "5", "5.000"],
    c: ["77726.10000", "0.00001393"],
    v: ["615.68639239", "2388.56785114"],
    p: ["77491.92201", "77160.53032"],
    t: [22946, 103648],
    l: ["76949.60000", "76236.90000"],
    h: ["77868.00000", "77868.00000"],
    o: "77304.90000",
  },
};

/**
 * Live: GET /0/public/OHLC?pair=XBTUSD&interval=1&since=1788415200.
 *
 * Note `last` sitting BESIDE the pair key, and the eight columns with VWAP at
 * index 5 and VOLUME AT INDEX 6.
 */
const OHLC_RESULT = {
  XXBTZUSD: [
    [1788415200, "77776.4", "77800.0", "77717.8", "77736.8", "77777.6", "4.07649664", 167],
    [1788415260, "77736.7", "77741.5", "77714.0", "77714.7", "77727.6", "1.69139349", 65],
    [1788415320, "77714.7", "77730.3", "77682.0", "77707.9", "77694.0", "2.64594439", 90],
    [1788415380, "77703.2", "77703.2", "77690.9", "77701.7", "77698.6", "0.40658752", 58],
  ],
  last: 1788415380,
};

/** Kraken's published reference example for AddOrder, NOT a live capture. */
const ADD_ORDER_RESULT = {
  descr: { order: "buy 2.12340000 XBTUSD @ limit 25000.1" },
  txid: ["OUF4EM-FRGI2-MQMWZD"],
};

/**
 * Kraken's published reference shape for one order record, with `cl_ord_id`
 * added -- the field this system's own orders carry and the documented example
 * (an order Kraken placed for a different client) does not. NOT a live capture.
 */
function orderRecord(
  overrides: Partial<Record<string, unknown>> = {},
  descr: Partial<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    refid: "None",
    userref: 0,
    cl_ord_id: CLIENT_ORDER_ID,
    status: "open",
    opentm: 1688666559.8974,
    starttm: 0,
    expiretm: 0,
    descr: {
      pair: "XBTUSD",
      type: "buy",
      ordertype: "limit",
      price: "30010.0",
      price2: "0",
      leverage: "none",
      order: "buy 1.25000000 XBTUSD @ limit 30010.0",
      close: "",
      ...descr,
    },
    vol: "1.25000000",
    vol_exec: "0.37500000",
    cost: "11253.7",
    fee: "0.00000",
    price: "30010.0",
    stopprice: "0.00000",
    limitprice: "0.00000",
    misc: "",
    oflags: "fciq",
    trades: ["TCCCTY-WE2O6-P3NB37"],
    ...overrides,
  };
}

/** Kraken's published reference example for BalanceEx. NOT a live capture. */
const BALANCE_EX_RESULT = {
  ZUSD: { balance: "25435.21", hold_trade: "8249.76" },
  XXBT: { balance: "1.2435", hold_trade: "0.8423" },
};

// --------------------------------------------------------------------------
// Harness
// --------------------------------------------------------------------------

/** One recorded outbound request, with a private call's body already decoded. */
interface Recorded {
  url: URL;
  path: string;
  method: string;
  headers: Record<string, string>;
  bodyText: string;
  /** The URL-encoded body parsed back into pairs, in the order it was written. */
  body: [string, string][];
}

type Handler = (recorded: Recorded) => Response | Promise<Response>;

function json(body: unknown, init: { status?: number } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json" },
  });
}

/** A Kraken success envelope. */
function envelope(result: unknown): Response {
  return json({ error: [], result });
}

/** A Kraken failure: HTTP 200, with the failure in the error array. */
function failure(...errors: string[]): Response {
  return json({ error: errors });
}

/**
 * The public routes every method with a pair behind it needs, so a test can
 * concentrate on the one call it is about.
 */
function publicRoutes(recorded: Recorded): Response | undefined {
  if (recorded.path === KRAKEN_ENDPOINTS.assetPairs) return envelope(ASSET_PAIRS);
  if (recorded.path === KRAKEN_ENDPOINTS.assets) return envelope(ASSETS);
  return undefined;
}

function clientWith(handler: Handler): { client: KrakenClient; requests: Recorded[] } {
  const requests: Recorded[] = [];
  const fetchLike: FetchLike = async (input, init) => {
    const url = new URL(input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const bodyText = typeof init?.body === "string" ? init.body : "";
    const recorded: Recorded = {
      url,
      path: url.pathname,
      method: init?.method ?? "GET",
      headers,
      bodyText,
      body: [...new URLSearchParams(bodyText).entries()],
    };
    requests.push(recorded);
    return handler(recorded);
  };
  const client = new KrakenClient({
    baseUrl: BASE,
    credentials: fakeKrakenCredentialProvider(),
    fetch: fetchLike,
    now: () => AT,
    catalogueCache: new KrakenCatalogueCache(),
  });
  return { client, requests };
}

/** Route the catalogue, then defer to `handler` for the call under test. */
function catalogued(handler: Handler): { client: KrakenClient; requests: Recorded[] } {
  return clientWith((recorded) => publicRoutes(recorded) ?? handler(recorded));
}

/** The failure half of an outcome, or a test failure that says which. */
function failureOf(outcome: { ok: boolean }): Extract<
  { ok: false; kind: string; message: string; retryable: boolean; status?: number; retryAfterMs?: number },
  { ok: false }
> {
  if (outcome.ok) throw new Error(`expected a failure, got a success: ${JSON.stringify(outcome)}`);
  return outcome as never;
}

function paths(requests: Recorded[]): string[] {
  return requests.map((request) => request.path);
}

function bodyOf(request: Recorded): Record<string, string> {
  return Object.fromEntries(request.body);
}

// --------------------------------------------------------------------------
// getServerTime -- a REAL value, unlike Gemini's refusal
// --------------------------------------------------------------------------

describe("getServerTime", () => {
  it("returns Kraken's own clock, converted from seconds to milliseconds", async () => {
    // Live: GET /0/public/Time. Gemini's client returns an honest refusal here
    // because Gemini has no such endpoint; Kraken has one, so this returns what
    // the interface says it returns rather than copying that refusal.
    const { client, requests } = clientWith(() => envelope(TIME_RESULT));
    const outcome = await client.getServerTime();

    expect(isUsable(outcome)).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value).toBe(1_788_415_303_000);
    expect(paths(requests)).toEqual([KRAKEN_ENDPOINTS.time]);
    expect(requests[0]!.method).toBe("GET");
  });

  it("needs no catalogue, so it sends exactly one request", async () => {
    const { client, requests } = clientWith(() => envelope(TIME_RESULT));
    await client.getServerTime();
    expect(requests).toHaveLength(1);
  });
});

// --------------------------------------------------------------------------
// The catalogue -- the fetch neither other venue needs
// --------------------------------------------------------------------------

describe("the catalogue", () => {
  it("fetches AssetPairs and Assets once, then serves everything else from cache", async () => {
    const { client, requests } = catalogued(() => envelope(TICKER_RESULT));

    await client.getSymbolFilters("BTCUSD");
    expect(paths(requests)).toEqual([KRAKEN_ENDPOINTS.assetPairs, KRAKEN_ENDPOINTS.assets]);

    // Three more catalogue-backed calls, and NOT one more catalogue request.
    await client.getSymbolFilters("ETHBTC");
    await client.listTradablePairs();
    await client.getCurrentPrice("BTCUSD");
    expect(paths(requests)).toEqual([
      KRAKEN_ENDPOINTS.assetPairs,
      KRAKEN_ENDPOINTS.assets,
      KRAKEN_ENDPOINTS.ticker,
    ]);
  });

  it("stamps the catalogue with the OLDER of the two receipt times", async () => {
    // The catalogue is exactly as fresh as its staler half. Rounding that age
    // DOWN is the one direction that lets stale trading rules present themselves
    // as current, since SymbolFilters.fetchedAt is read straight off it.
    // A clock that advances one second per READING, so the two concurrent
    // fetches cannot land on the same receipt time. AssetPairs is dispatched
    // first and therefore reads the earlier one.
    let readings = 0;
    const client = new KrakenClient({
      baseUrl: BASE,
      credentials: fakeKrakenCredentialProvider(),
      now: () => AT + readings++ * 1000,
      fetch: async (input) =>
        new URL(input).pathname === KRAKEN_ENDPOINTS.assetPairs
          ? envelope(ASSET_PAIRS)
          : envelope(ASSETS),
    });

    const filters = await client.getSymbolFilters("BTCUSD");
    expect(filters.ok).toBe(true);
    if (!filters.ok) return;
    // Readings: [0] the cache check, [1] the AssetPairs receipt, [2] the Assets
    // receipt. The catalogue takes the EARLIER of the two receipts -- taking the
    // later one would be AT + 2000.
    expect(filters.value.fetchedAt).toBe(AT + 1000);
  });

  it("propagates a catalogue fetch failure rather than trading without one", async () => {
    const { client } = clientWith((recorded) =>
      recorded.path === KRAKEN_ENDPOINTS.assetPairs
        ? failure("EService:Unavailable")
        : envelope(ASSETS),
    );
    const outcome = await client.getCurrentPrice("BTCUSD");
    const error = failureOf(outcome);
    // EService:Unavailable is TRANSPORT: a server-side failure over HTTP 200.
    expect(error.kind).toBe("transport");
    expect(error.retryable).toBe(true);
  });

  it("does not cache a catalogue it could not build, so the next call refetches", async () => {
    let assetPairsBody: unknown = { NOTAPAIR: { altname: 1 } };
    const { client, requests } = clientWith((recorded) =>
      recorded.path === KRAKEN_ENDPOINTS.assetPairs
        ? envelope(assetPairsBody)
        : envelope(ASSETS),
    );

    const broken = await client.listTradablePairs();
    expect(failureOf(broken).kind).toBe("exchange_error");

    assetPairsBody = ASSET_PAIRS;
    const recovered = await client.listTradablePairs();
    expect(recovered.ok).toBe(true);
    // Four requests: the failed pair of fetches, then the successful pair.
    expect(requests).toHaveLength(4);
  });

  it("refetches after invalidateCatalogue -- the recovery parse.ts names but cannot perform", async () => {
    const { client, requests } = catalogued(() => envelope(TICKER_RESULT));
    await client.listTradablePairs();
    expect(requests).toHaveLength(2);

    await client.listTradablePairs();
    expect(requests).toHaveLength(2);

    client.invalidateCatalogue();
    await client.listTradablePairs();
    expect(requests).toHaveLength(4);
  });
});

// --------------------------------------------------------------------------
// getSymbolFilters / listTradablePairs
// --------------------------------------------------------------------------

describe("getSymbolFilters", () => {
  it("builds filters out of the catalogue, sending no request of its own", async () => {
    const { client, requests } = catalogued(() => {
      throw new Error("no further request should be made");
    });
    const outcome = await client.getSymbolFilters("BTCUSD");

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value).toMatchObject({
      pair: "BTCUSD",
      baseAsset: "BTC",
      quoteAsset: "USD",
      status: "TRADING",
      tickSize: m("0.1"),
      // Derived from lot_decimals: 8. There is no stepSize field on Kraken.
      stepSize: m("0.00000001"),
      minQuantity: m("0.00005"),
      minNotional: m("0.5"),
      // Kraken publishes no maxima and no price floor. ZERO is "rule disabled".
      minPrice: ZERO,
      maxPrice: ZERO,
      maxQuantity: ZERO,
      maxNotional: ZERO,
    });
    // `instrument` is ABSENT, not "unknown": Kraken's spot and futures live on
    // separate hosts, so there is no field to read.
    expect(outcome.value.instrument).toBeUndefined();
    expect(paths(requests)).toEqual([KRAKEN_ENDPOINTS.assetPairs, KRAKEN_ENDPOINTS.assets]);
  });

  it.each(["BTCUSD", "XBTUSD", "XXBTZUSD", "XBT/USD", "btc-usd"])(
    "resolves %s to the one XXBTZUSD market",
    async (name) => {
      const { client } = catalogued(() => {
        throw new Error("no further request should be made");
      });
      const outcome = await client.getSymbolFilters(name);
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      expect(outcome.value.pair).toBe("BTCUSD");
    },
  );

  it("refuses a pair Kraken does not list, non-retryably and without guessing a name", async () => {
    const { client } = catalogued(() => {
      throw new Error("no further request should be made");
    });
    const error = failureOf(await client.getSymbolFilters("WXBTUSD"));
    expect(error.kind).toBe("exchange_error");
    expect(error.retryable).toBe(false);
    expect(error.message).toMatch(/not in Kraken's catalogue/);
  });
});

describe("listTradablePairs", () => {
  it("returns this system's tickers for the pairs that are trading", async () => {
    const { client } = catalogued(() => {
      throw new Error("no further request should be made");
    });
    const outcome = await client.listTradablePairs();
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect([...outcome.value].sort()).toEqual(["BTCUSD", "ETHBTC"]);
  });

  it("excludes a pair whose status is not online", async () => {
    // CONSTRUCTED: one field of the live XXBTZUSD entry changed. Kraken's
    // `post_only` maps to a non-TRADING status here, deliberately unlike Gemini.
    const halted = {
      ...ASSET_PAIRS,
      XXBTZUSD: { ...ASSET_PAIRS.XXBTZUSD, status: "post_only" },
    };
    const { client } = clientWith((recorded) =>
      recorded.path === KRAKEN_ENDPOINTS.assetPairs ? envelope(halted) : envelope(ASSETS),
    );
    const outcome = await client.listTradablePairs();
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value).toEqual(["ETHBTC"]);
  });
});

// --------------------------------------------------------------------------
// getCurrentPrice
// --------------------------------------------------------------------------

describe("getCurrentPrice", () => {
  it("sends Kraken's ALTNAME and reads the reply keyed by its CANONICAL name", async () => {
    const { client, requests } = catalogued(() => envelope(TICKER_RESULT));
    const outcome = await client.getCurrentPrice("BTCUSD");

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    // `c[0]`, the last trade price.
    expect(outcome.value).toEqual({ pair: "BTCUSD", price: m("77726.1"), at: AT });

    const ticker = requests.at(-1)!;
    // XBTUSD going out; XXBTZUSD coming back. Neither is the caller's string.
    expect(ticker.url.searchParams.get("pair")).toBe("XBTUSD");
    expect(ticker.method).toBe("GET");
  });

  it("refuses an unknown pair BEFORE sending a ticker request", async () => {
    const { client, requests } = catalogued(() => envelope(TICKER_RESULT));
    const error = failureOf(await client.getCurrentPrice("NOTAPAIR"));
    expect(error.retryable).toBe(false);
    // Catalogue only. No ticker call was made for a pair that cannot exist.
    expect(paths(requests)).toEqual([KRAKEN_ENDPOINTS.assetPairs, KRAKEN_ENDPOINTS.assets]);
  });

  it("refuses a crossed book rather than pricing off one", async () => {
    // CONSTRUCTED from the live XXBTZUSD ticker: the bid raised above the ask.
    // A bid at or above its ask cannot happen on a venue that matches.
    const crossed = {
      XXBTZUSD: { ...TICKER_RESULT.XXBTZUSD, b: ["77726.20000", "5", "5.000"] },
    };
    const { client } = catalogued(() => envelope(crossed));
    const error = failureOf(await client.getCurrentPrice("BTCUSD"));
    expect(error.kind).toBe("exchange_error");
    expect(error.retryable).toBe(false);
    expect(error.message).toMatch(/could not read Kraken's response.*CROSSED book/s);
  });
});

// --------------------------------------------------------------------------
// Error classification -- HTTP 200 with the failure in the body
// --------------------------------------------------------------------------

describe("error classification (entry 90 PROBLEM 3)", () => {
  it("treats a 200 carrying EAPI:Invalid key as a definite, non-retryable refusal", async () => {
    // Live: POST /0/private/BalanceEx with a junk key answers HTTP 200 with
    // exactly this body. Anything reasoning from the status would call it a
    // success.
    const { client } = catalogued(() => failure("EAPI:Invalid key"));
    const error = failureOf(await client.getAccountBalances());
    expect(error.kind).toBe("exchange_error");
    expect(error.retryable).toBe(false);
    expect(error.message).toBe("EAPI:Invalid key");
  });

  it("invents NO synthetic HTTP status for a 200-with-error body", async () => {
    // GeminiClient converts its 200-with-error bodies by calling
    // classifyFailure(400, ...). Doing that here would put a number in
    // outcome.status that no Kraken response ever carried.
    const { client } = catalogued(() => failure("EQuery:Unknown asset pair"));
    const error = failureOf(await client.getCurrentPrice("BTCUSD"));
    expect(error.status).toBeUndefined();
  });

  it("treats EService:Unavailable as TRANSPORT, so an order's fate stays open", async () => {
    const { client } = catalogued(() => failure("EService:Unavailable"));
    const error = failureOf(await client.placeOrder(order()));
    expect(error.kind).toBe("transport");
    expect(error.retryable).toBe(true);
  });

  it("carries a real retryAfterMs off EService:Throttled", async () => {
    // Kraken states an absolute instant in SECONDS; the interface wants a wait.
    // It is the only venue of the three that supplies one at all.
    const { client } = catalogued(() => failure(`EService:Throttled:${AT / 1000 + 30}`));
    const error = failureOf(await client.getAccountBalances());
    expect(error.retryable).toBe(true);
    expect(error.retryAfterMs).toBe(30_000);
  });

  it("lets the status speak only when the body is NOT a Kraken envelope", async () => {
    // CONSTRUCTED: an edge/proxy error page that never reached Kraken's
    // application layer. 5xx means the effect is unknown, so it is transport.
    const { client } = catalogued(() => new Response("<html>502</html>", { status: 502 }));
    const error = failureOf(await client.getAccountBalances());
    expect(error.kind).toBe("transport");
    expect(error.retryable).toBe(true);
    expect(error.status).toBe(502);
    expect(error.message).toMatch(/not a Kraken envelope/);
  });

  it("calls a 200 with an unreadable body unreadable, not a status failure", async () => {
    const { client } = catalogued(() => json({ nonsense: true }));
    const error = failureOf(await client.getAccountBalances());
    expect(error.kind).toBe("exchange_error");
    expect(error.retryable).toBe(false);
    expect(error.status).toBeUndefined();
    expect(error.message).toMatch(/could not read Kraken's response/);
  });

  it("reports a thrown fetch as transport, with the effect unknown", async () => {
    const { client } = catalogued(() => {
      throw new Error("network down");
    });
    const error = failureOf(await client.getAccountBalances());
    expect(error.kind).toBe("transport");
    expect(error.retryable).toBe(true);
    expect(error.message).toBe("network down");
  });

  it("refuses a success that carried no result payload", async () => {
    const { client } = catalogued(() => json({ error: [] }));
    const error = failureOf(await client.getAccountBalances());
    expect(error.message).toMatch(/no result payload/);
    expect(error.retryable).toBe(false);
  });
});

// --------------------------------------------------------------------------
// placeOrder
// --------------------------------------------------------------------------

function order(overrides: Partial<OrderRequest> = {}): OrderRequest {
  return {
    pair: "BTCUSD",
    clientOrderId: CLIENT_ORDER_ID,
    side: "buy",
    type: "limit",
    // On the live tick grid (0.1) and above ordermin/costmin.
    price: m("77726.1"),
    quantity: m("0.001"),
    ...overrides,
  };
}

describe("placeOrder", () => {
  it("sends exactly the documented AddOrder parameters, oflags=fciq included", async () => {
    const { client, requests } = catalogued(() => envelope(ADD_ORDER_RESULT));
    const outcome = await client.placeOrder(order());

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value).toEqual({
      clientOrderId: CLIENT_ORDER_ID,
      exchangeOrderId: "OUF4EM-FRGI2-MQMWZD",
      pair: "BTCUSD",
      // Kraken's `open` in this system's vocabulary; AddOrder sends no status.
      state: "pending",
      // Genuinely none, not merely unreported.
      fills: [],
      // RECEIPT time: AddOrder carries no exchange timestamp of any kind.
      acceptedAt: AT,
    });

    const sent = requests.at(-1)!;
    expect(sent.path).toBe(KRAKEN_ENDPOINTS.addOrder);
    expect(sent.method).toBe("POST");
    expect(bodyOf(sent)).toMatchObject({
      pair: "XBTUSD",
      type: "buy",
      ordertype: "limit",
      price: "77726.1",
      volume: "0.001",
      cl_ord_id: CLIENT_ORDER_ID,
      // DECISION 4. This CHANGES the account's real behaviour on a sell, where
      // Kraken's own default is fcib -- deliberately, so the fee asset is a fact
      // the request establishes rather than a chain of inference.
      oflags: "fciq",
    });
  });

  it("sends oflags=fciq on a SELL too, which is where it changes behaviour", async () => {
    const { client, requests } = catalogued(() => envelope(ADD_ORDER_RESULT));
    await client.placeOrder(order({ side: "sell" }));
    expect(bodyOf(requests.at(-1)!)).toMatchObject({ type: "sell", oflags: "fciq" });
  });

  it("sends no timeinforce and no post flag, so the order rests as a GTC limit", async () => {
    // `post` would REJECT rather than rest if the price happened to cross, which
    // is a different behaviour from the GTC limit the other two venues place.
    const { client, requests } = catalogued(() => envelope(ADD_ORDER_RESULT));
    await client.placeOrder(order());
    const body = bodyOf(requests.at(-1)!);
    expect(body["timeinforce"]).toBeUndefined();
    expect(body["oflags"]).toBe("fciq");
  });

  it("accepts any of Kraken's four names for the pair, because it resolves before it validates", async () => {
    // validateOrder THROWS when filters.pair !== input.pair, and Kraken's filters
    // are keyed by the catalogue ticker. Resolving first is what stops XBTUSD --
    // a name Kraken itself uses -- from tripping that throw instead of trading.
    const { client, requests } = catalogued(() => envelope(ADD_ORDER_RESULT));
    const outcome = await client.placeOrder(order({ pair: "XXBTZUSD" }));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.pair).toBe("BTCUSD");
    expect(bodyOf(requests.at(-1)!)["pair"]).toBe("XBTUSD");
  });

  it("refuses an off-tick price BEFORE sending anything", async () => {
    // Section 4.3's second, independent check, in `verify` mode: a price no
    // longer on the grid is reported, never silently re-rounded.
    const { client, requests } = catalogued(() => envelope(ADD_ORDER_RESULT));
    const error = failureOf(await client.placeOrder(order({ price: m("77726.15") })));
    expect(error.kind).toBe("exchange_error");
    expect(error.retryable).toBe(false);
    expect(error.message).toMatch(/order rejected before sending \(price_off_tick\)/);
    // Catalogue only: nothing was sent to AddOrder.
    expect(paths(requests)).toEqual([KRAKEN_ENDPOINTS.assetPairs, KRAKEN_ENDPOINTS.assets]);
  });

  it("refuses a quantity under Kraken's ordermin before sending", async () => {
    const { client, requests } = catalogued(() => envelope(ADD_ORDER_RESULT));
    const error = failureOf(await client.placeOrder(order({ quantity: m("0.00001") })));
    expect(error.message).toMatch(/quantity_below_min/);
    expect(requests).toHaveLength(2);
  });

  it("refuses to place on a pair Kraken does not list", async () => {
    const { client, requests } = catalogued(() => envelope(ADD_ORDER_RESULT));
    const error = failureOf(await client.placeOrder(order({ pair: "WXBTUSD" })));
    expect(error.retryable).toBe(false);
    expect(requests).toHaveLength(2);
  });

  it("refuses an AddOrder reply that names no order, rather than reporting it as placed", async () => {
    // Kraken reporting success with no txid means an order that may exist and
    // cannot be found -- precisely what reconciliation exists to prevent.
    const { client } = catalogued(() => envelope({ descr: { order: "…" }, txid: [] }));
    const error = failureOf(await client.placeOrder(order()));
    expect(error.message).toMatch(/returned no txid/);
    expect(error.retryable).toBe(false);
  });

  it("does not re-check the 18-character client order id, which bot creation owns", async () => {
    // VENUE_ORDER_ID_BUDGETS.kraken caps the slug at 10 characters and
    // checkBotInstanceIdFitsVenue refuses an over-budget id before a bot exists.
    // Re-checking here would put one rule in two places and would refuse
    // mid-order something that should never have been creatable. Kraken's own
    // refusal is what this client reports.
    const { client, requests } = catalogued(() => failure("EGeneral:Invalid arguments"));
    const tooLong = "v1-grid-btcusd-01-7";
    const error = failureOf(await client.placeOrder(order({ clientOrderId: tooLong })));
    expect(bodyOf(requests.at(-1)!)["cl_ord_id"]).toBe(tooLong);
    expect(error.message).toBe("EGeneral:Invalid arguments");
    expect(error.retryable).toBe(false);
  });
});

// --------------------------------------------------------------------------
// cancelOrder -- entry 90 DECISION 2
// --------------------------------------------------------------------------

describe("cancelOrder", () => {
  /** Cancel, then the one ClosedOrders read. */
  function cancelRoutes(
    cancel: unknown,
    closed: unknown,
  ): { client: KrakenClient; requests: Recorded[] } {
    return catalogued((recorded) => {
      if (recorded.path === KRAKEN_ENDPOINTS.cancelOrder) return envelope(cancel);
      if (recorded.path === KRAKEN_ENDPOINTS.closedOrders) return envelope(closed);
      throw new Error(`unexpected path ${recorded.path}`);
    });
  }

  const CANCELLED_RECORD = orderRecord({
    status: "canceled",
    reason: "User requested",
    closetm: 1688666600.1234,
    vol_exec: "0.37500000",
  });

  it("is EXACTLY two private requests: the cancel, then ONE read. Never a loop.", async () => {
    const { client, requests } = cancelRoutes(
      { count: 1 },
      { closed: { "OQCLML-BW3P3-BUCMWZ": CANCELLED_RECORD }, count: 1 },
    );
    const outcome = await client.cancelOrder("BTCUSD", CLIENT_ORDER_ID);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(paths(requests)).toEqual([
      KRAKEN_ENDPOINTS.assetPairs,
      KRAKEN_ENDPOINTS.assets,
      KRAKEN_ENDPOINTS.cancelOrder,
      KRAKEN_ENDPOINTS.closedOrders,
    ]);
  });

  it("identifies the order by cl_ord_id on BOTH calls, never by a txid it does not hold", async () => {
    // Kraken's CancelOrder accepts cl_ord_id directly, so the Gemini-style
    // "look it up to learn the numeric id, then cancel" is a third request that
    // buys nothing on this venue.
    const { client, requests } = cancelRoutes(
      { count: 1 },
      { closed: { "OQCLML-BW3P3-BUCMWZ": CANCELLED_RECORD }, count: 1 },
    );
    await client.cancelOrder("BTCUSD", CLIENT_ORDER_ID);

    const [, , cancel, read] = requests;
    expect(bodyOf(cancel!)).toMatchObject({ cl_ord_id: CLIENT_ORDER_ID });
    expect(bodyOf(read!)).toMatchObject({ cl_ord_id: CLIENT_ORDER_ID, trades: "false" });
  });

  it("returns the filled quantity the one read observed, which is what a halt needs", async () => {
    const { client } = cancelRoutes(
      { count: 1 },
      { closed: { "OQCLML-BW3P3-BUCMWZ": CANCELLED_RECORD }, count: 1 },
    );
    const outcome = await client.cancelOrder("BTCUSD", CLIENT_ORDER_ID);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value).toMatchObject({
      clientOrderId: CLIENT_ORDER_ID,
      exchangeOrderId: "OQCLML-BW3P3-BUCMWZ",
      pair: "BTCUSD",
      state: "cancelled",
      quantity: m("1.25"),
      filledQuantity: m("0.375"),
      cumulativeQuoteQuantity: m("11253.7"),
      // Kraken is the one venue of the three that can populate this honestly:
      // closetm is a real transition time, not a creation time.
      updatedAt: 1_688_666_600_123,
    });
  });

  it("treats count: 0 as the ordinary answer it is, and still reports where the order finished", async () => {
    // Nothing matched: the order had already filled or already been cancelled,
    // which is normal during a halt racing its own fills.
    const filled = orderRecord({ status: "closed", closetm: 1688666600.1234, vol_exec: "1.25000000" });
    const { client } = cancelRoutes({ count: 0 }, { closed: { "OQCLML-BW3P3-BUCMWZ": filled }, count: 1 });
    const outcome = await client.cancelOrder("BTCUSD", CLIENT_ORDER_ID);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.state).toBe("filled");
    expect(outcome.value.filledQuantity).toBe(m("1.25"));
  });

  it("reports the accepted staleness honestly when the one read finds nothing", async () => {
    // CONSTRUCTED: pending: true and the order not yet closed. This is exactly
    // the tradeoff DECISION 2 accepted -- a bounded stale answer over an
    // unbounded read loop -- so it is REPORTED, not fabricated into "cancelled,
    // nothing filled", which would be a quantity nobody observed in the field
    // that determines the position a halted bot is left holding.
    const { client, requests } = cancelRoutes(
      { count: 1, pending: true },
      { closed: {}, count: 0 },
    );
    const error = failureOf(await client.cancelOrder("BTCUSD", CLIENT_ORDER_ID));

    expect(error.kind).toBe("exchange_error");
    // NOT retryable: re-cancelling an order that is already cancelling is not a
    // recovery, and the loop that would resolve it is what DECISION 2 refused.
    expect(error.retryable).toBe(false);
    expect(error.message).toMatch(/count=1, pending=true/);
    expect(error.message).toMatch(/never a loop/);
    expect(error.message).toMatch(/Section 9 reconciliation/);
    // And still exactly one read.
    expect(requests.filter((r) => r.path === KRAKEN_ENDPOINTS.closedOrders)).toHaveLength(1);
  });

  it("refuses when two closed orders carry the same client order id", async () => {
    // Kraken enforces cl_ord_id uniqueness only across OPEN orders, so a reused
    // id on closed orders is genuinely reachable rather than theoretical.
    const { client } = cancelRoutes(
      { count: 1 },
      {
        closed: {
          "OQCLML-BW3P3-BUCMWZ": CANCELLED_RECORD,
          "OB5VMB-B4U2U-DK2WRW": { ...CANCELLED_RECORD, opentm: 1688665899.5699 },
        },
        count: 2,
      },
    );
    const error = failureOf(await client.cancelOrder("BTCUSD", CLIENT_ORDER_ID));
    expect(error.retryable).toBe(false);
    expect(error.message).toMatch(/returned 2 orders carrying/);
    expect(error.message).toContain("OQCLML-BW3P3-BUCMWZ");
    expect(error.message).toContain("OB5VMB-B4U2U-DK2WRW");
  });

  it("refuses an order found on a DIFFERENT market than the caller named", async () => {
    // CONSTRUCTED: the same record moved to ETHXBT. Acting on one market's order
    // under another market's name is the worst failure available here.
    const elsewhere = orderRecord(
      { status: "canceled", closetm: 1688666600.1234 },
      { pair: "ETHXBT", price: "0.050000" },
    );
    const { client } = cancelRoutes(
      { count: 1 },
      { closed: { "OQCLML-BW3P3-BUCMWZ": elsewhere }, count: 1 },
    );
    const error = failureOf(await client.cancelOrder("BTCUSD", CLIENT_ORDER_ID));
    expect(error.retryable).toBe(false);
    expect(error.message).toMatch(/is on ETHBTC, not the BTCUSD the caller named/);
  });

  it("ignores an order Kraken returned that does not carry the requested id", async () => {
    // Defence against a cl_ord_id filter the venue ignored: without the local
    // re-check this would hand back a plausible-looking order from another bot.
    const someoneElses = orderRecord({ cl_ord_id: "v1-other-bot-3", status: "canceled", closetm: 1688666600.1 });
    const { client } = cancelRoutes(
      { count: 1 },
      { closed: { "OZZZZZ-ZZZZZ-ZZZZZZ": someoneElses }, count: 1 },
    );
    const error = failureOf(await client.cancelOrder("BTCUSD", CLIENT_ORDER_ID));
    expect(error.message).toMatch(/found no CLOSED order carrying/);
  });

  it("returns the cancel's own failure without attempting the read", async () => {
    const { client, requests } = catalogued((recorded) =>
      recorded.path === KRAKEN_ENDPOINTS.cancelOrder
        ? failure("EOrder:Unknown order")
        : envelope({ closed: {}, count: 0 }),
    );
    const error = failureOf(await client.cancelOrder("BTCUSD", CLIENT_ORDER_ID));
    expect(error.message).toBe("EOrder:Unknown order");
    expect(requests.some((r) => r.path === KRAKEN_ENDPOINTS.closedOrders)).toBe(false);
  });
});

// --------------------------------------------------------------------------
// getOrderStatus
// --------------------------------------------------------------------------

describe("getOrderStatus", () => {
  it("finds a resting order in ONE request, from OpenOrders", async () => {
    const { client, requests } = catalogued((recorded) => {
      if (recorded.path === KRAKEN_ENDPOINTS.openOrders) {
        return envelope({ open: { "OQCLML-BW3P3-BUCMWZ": orderRecord() } });
      }
      throw new Error(`unexpected path ${recorded.path}`);
    });
    const outcome = await client.getOrderStatus("BTCUSD", CLIENT_ORDER_ID);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value).toMatchObject({
      clientOrderId: CLIENT_ORDER_ID,
      exchangeOrderId: "OQCLML-BW3P3-BUCMWZ",
      pair: "BTCUSD",
      side: "buy",
      // descr.price, NOT the top-level `price` (which is the average execution).
      price: m("30010.0"),
      quantity: m("1.25"),
      filledQuantity: m("0.375"),
      state: "partially_filled",
      createdAt: 1_688_666_559_897,
    });
    // A resting order has NO updatedAt key, rather than one holding the
    // creation time.
    expect("updatedAt" in outcome.value).toBe(false);
    expect(paths(requests).at(-1)).toBe(KRAKEN_ENDPOINTS.openOrders);
    expect(requests.filter((r) => r.path === KRAKEN_ENDPOINTS.closedOrders)).toHaveLength(0);
  });

  it("falls through to ClosedOrders for a terminated order -- open FIRST, and that ordering matters", async () => {
    // Closed-first would miss an order that is open at the first call and closes
    // before the second: reported as "no such order" for an order that exists.
    // Open-first has no such window.
    const { client, requests } = catalogued((recorded) => {
      if (recorded.path === KRAKEN_ENDPOINTS.openOrders) return envelope({ open: {} });
      if (recorded.path === KRAKEN_ENDPOINTS.closedOrders) {
        return envelope({
          closed: {
            "OQCLML-BW3P3-BUCMWZ": orderRecord({
              status: "closed",
              closetm: 1688666600.1234,
              vol_exec: "1.25000000",
            }),
          },
          count: 1,
        });
      }
      throw new Error(`unexpected path ${recorded.path}`);
    });
    const outcome = await client.getOrderStatus("BTCUSD", CLIENT_ORDER_ID);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.state).toBe("filled");
    expect(paths(requests).slice(-2)).toEqual([
      KRAKEN_ENDPOINTS.openOrders,
      KRAKEN_ENDPOINTS.closedOrders,
    ]);
  });

  it("refuses to report a missing order as \"no such order\"", async () => {
    const { client } = catalogued((recorded) =>
      recorded.path === KRAKEN_ENDPOINTS.openOrders
        ? envelope({ open: {} })
        : envelope({ closed: {}, count: 0 }),
    );
    const error = failureOf(await client.getOrderStatus("BTCUSD", CLIENT_ORDER_ID));
    expect(error.retryable).toBe(false);
    expect(error.message).toMatch(/reconciliation must not miss/);
  });

  it("asks for no trades, because Kraken's `trades` field is ids and not executions", async () => {
    const { client, requests } = catalogued(() =>
      envelope({ open: { "OQCLML-BW3P3-BUCMWZ": orderRecord() } }),
    );
    await client.getOrderStatus("BTCUSD", CLIENT_ORDER_ID);
    expect(bodyOf(requests.at(-1)!)).toMatchObject({
      cl_ord_id: CLIENT_ORDER_ID,
      trades: "false",
    });
  });

  it("leaves `fills` ABSENT rather than asserting an order has none", async () => {
    const { client } = catalogued(() =>
      envelope({ open: { "OQCLML-BW3P3-BUCMWZ": orderRecord() } }),
    );
    const outcome = await client.getOrderStatus("BTCUSD", CLIENT_ORDER_ID);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    // An empty array would be false about this partially filled order.
    expect("fills" in outcome.value).toBe(false);
  });
});

// --------------------------------------------------------------------------
// getOpenOrders
// --------------------------------------------------------------------------

describe("getOpenOrders", () => {
  it("filters to the requested pair LOCALLY, because Kraken applies no pair filter", async () => {
    const { client, requests } = catalogued(() =>
      envelope({
        open: {
          "OQCLML-BW3P3-BUCMWZ": orderRecord(),
          "OB5VMB-B4U2U-DK2WRW": orderRecord(
            { cl_ord_id: "v1-eth-bot-2", opentm: 1688665899.5699 },
            { pair: "ETHXBT", price: "0.050000" },
          ),
        },
      }),
    );
    const outcome = await client.getOpenOrders("BTCUSD");

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.map((o) => o.exchangeOrderId)).toEqual(["OQCLML-BW3P3-BUCMWZ"]);
    // No pair parameter went out: Kraken's OpenOrders has none.
    expect(bodyOf(requests.at(-1)!)["pair"]).toBeUndefined();
  });

  it("compares on the catalogue's ticker, so every Kraken spelling selects one market", async () => {
    const { client } = catalogued(() =>
      envelope({ open: { "OQCLML-BW3P3-BUCMWZ": orderRecord() } }),
    );
    for (const name of ["BTCUSD", "XBTUSD", "XXBTZUSD"]) {
      const outcome = await client.getOpenOrders(name);
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      expect(outcome.value).toHaveLength(1);
    }
  });

  it("returns an empty list when nothing rests on the pair", async () => {
    const { client } = catalogued(() => envelope({ open: {} }));
    const outcome = await client.getOpenOrders("BTCUSD");
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value).toEqual([]);
  });
});

// --------------------------------------------------------------------------
// getAccountBalances
// --------------------------------------------------------------------------

describe("getAccountBalances", () => {
  it("reads BalanceEx and un-prefixes every asset code through the catalogue", async () => {
    const { client, requests } = catalogued(() => envelope(BALANCE_EX_RESULT));
    const outcome = await client.getAccountBalances();

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value).toEqual([
      // free = balance - hold_trade, derived here rather than reported.
      { asset: "USD", free: m("17185.45"), locked: m("8249.76") },
      { asset: "BTC", free: m("0.4012"), locked: m("0.8423") },
    ]);
    // BalanceEx, not Balance: only the extended form reports hold_trade, and the
    // interface wants free and locked separately.
    expect(paths(requests).at(-1)).toBe(KRAKEN_ENDPOINTS.balanceEx);
  });

  it("fails the whole read on an asset code the catalogue does not know", async () => {
    // A balance mislabelled with a guessed ticker is a wrong number in exactly
    // the place section 9 must reconcile. A failed read is a failed read; a
    // wrong balance is silent.
    const { client } = catalogued(() => envelope({ NEWCOIN: { balance: "1.0", hold_trade: "0.0" } }));
    const error = failureOf(await client.getAccountBalances());
    expect(error.message).toMatch(/not in Kraken's catalogue/);
  });
});

// --------------------------------------------------------------------------
// getCandles
// --------------------------------------------------------------------------

describe("getCandles", () => {
  it("reads volume from index 6, not the VWAP at index 5", async () => {
    // Binance and Gemini both put volume at index 5, so the field that reads
    // across from both is the wrong one -- and wrong plausibly, since VWAP is a
    // price-shaped number in the right magnitude range.
    const { client } = catalogued(() => envelope(OHLC_RESULT));
    const outcome = await client.getCandles("BTCUSD", "1m");

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value[0]).toEqual({
      pair: "BTCUSD",
      openTime: 1_788_415_200_000,
      // Kraken publishes no close time; it is the candle's last millisecond.
      closeTime: 1_788_415_259_999,
      open: m("77776.4"),
      high: m("77800.0"),
      low: m("77717.8"),
      close: m("77736.8"),
      // 4.076…, not the 77777.6 VWAP beside it.
      volume: m("4.07649664"),
      closed: true,
    });
  });

  it("sends Kraken's interval in MINUTES and returns candles oldest-first", async () => {
    const { client, requests } = catalogued(() => envelope(OHLC_RESULT));
    const outcome = await client.getCandles("BTCUSD", "1m");

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.map((c) => c.openTime)).toEqual([
      1_788_415_200_000, 1_788_415_260_000, 1_788_415_320_000, 1_788_415_380_000,
    ]);
    const sent = requests.at(-1)!;
    expect(sent.url.searchParams.get("pair")).toBe("XBTUSD");
    expect(sent.url.searchParams.get("interval")).toBe("1");
    expect(sent.url.searchParams.get("since")).toBeNull();
  });

  it("marks the in-progress candle closed: false", async () => {
    // `at` here is AT = 1788415303000, which is inside the 1788415260 candle.
    const { client } = catalogued(() => envelope(OHLC_RESULT));
    const outcome = await client.getCandles("BTCUSD", "1m");
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.map((c) => c.closed)).toEqual([true, false, false, false]);
  });

  it("ignores the `last` sibling sitting beside the candle array", async () => {
    const { client } = catalogued(() => envelope(OHLC_RESULT));
    const outcome = await client.getCandles("BTCUSD", "1m");
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value).toHaveLength(4);
  });

  describe("since", () => {
    it("backs the sent `since` off by one interval, because Kraken's is INCLUSIVE on the open time", async () => {
      // Live evidence: ?interval=1&since=1788414900 returned a first row of
      // 1788414900 itself. The interface's `since` is on the CLOSE time, so
      // sending it unmodified would drop the candle that opened before it and
      // closes after it -- for a gap-backfill, the candle in progress when the
      // connection dropped.
      const { client, requests } = catalogued(() => envelope(OHLC_RESULT));
      await client.getCandles("BTCUSD", "1m", 1_788_415_260_000);
      expect(requests.at(-1)!.url.searchParams.get("since")).toBe("1788415200");
    });

    it("applies the exact close-time contract locally on top of it", async () => {
      const { client } = catalogued(() => envelope(OHLC_RESULT));
      const outcome = await client.getCandles("BTCUSD", "1m", 1_788_415_260_000);
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      // The 1788415200 candle closes at ...259999, which is NOT after `since`.
      expect(outcome.value.map((c) => c.openTime)).toEqual([
        1_788_415_260_000, 1_788_415_320_000, 1_788_415_380_000,
      ]);
    });

    it("keeps the boundary candle that opened before `since` and closes after it", async () => {
      const { client } = catalogued(() => envelope(OHLC_RESULT));
      // One millisecond into the first candle: it closes after this, so it stays.
      const outcome = await client.getCandles("BTCUSD", "1m", 1_788_415_200_001);
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      expect(outcome.value[0]!.openTime).toBe(1_788_415_200_000);
    });

    it("omits `since` rather than sending a non-positive one", async () => {
      const { client, requests } = catalogued(() => envelope(OHLC_RESULT));
      await client.getCandles("BTCUSD", "1m", 0);
      expect(requests.at(-1)!.url.searchParams.get("since")).toBeNull();
    });
  });

  describe("the 6h interval Kraken does not have", () => {
    it("REFUSES BEFORE SENDING ANYTHING, rather than surfacing as an unreadable response", async () => {
      // The client-level half of entry 92's open question. `#unreadable` says
      // "Kraken answered and this code could not read the answer" -- which would
      // be false here, and would send an operator looking for a payload change
      // at the venue. The fact is local, constant and known before any I/O.
      const { client, requests } = catalogued(() => envelope(OHLC_RESULT));
      const error = failureOf(await client.getCandles("BTCUSD", "6h"));

      expect(error.kind).toBe("exchange_error");
      // No amount of waiting grows Kraken a six-hour candle.
      expect(error.retryable).toBe(false);
      expect(error.message).not.toMatch(/could not read Kraken's response/);
      // NOTHING was sent -- not even the catalogue fetch.
      expect(requests).toHaveLength(0);
    });

    it("reports parse.ts's own message, naming the interval and Kraken's real set", async () => {
      // Written as a try/catch around krakenTimeframe rather than its own null
      // test, so exactly one place knows which intervals this venue lacks.
      const { client } = catalogued(() => envelope(OHLC_RESULT));
      const error = failureOf(await client.getCandles("BTCUSD", "6h"));
      expect(error.message).toMatch(/Kraken publishes no 6h OHLC interval/);
      expect(error.message).toMatch(/nothing between 240 and 1440/);
      expect(error.message).toMatch(/refusing to substitute a different candle length/);
    });

    it.each(["1m", "5m", "15m", "30m", "1h", "1d"] as const)(
      "still serves %s, so the refusal is about the one gap and not the feature",
      async (interval) => {
        const { client, requests } = catalogued(() => envelope(OHLC_RESULT));
        const outcome = await client.getCandles("BTCUSD", interval);
        expect(outcome.ok).toBe(true);
        expect(requests.at(-1)!.url.searchParams.get("interval")).not.toBeNull();
      },
    );
  });
});

// --------------------------------------------------------------------------
// Transport and signing
// --------------------------------------------------------------------------

describe("transport", () => {
  it("signs a private request and POSTs the exact bytes it signed", async () => {
    const { client, requests } = catalogued(() => envelope(BALANCE_EX_RESULT));
    await client.getAccountBalances();

    const signed = requests.at(-1)!;
    expect(signed.method).toBe("POST");
    expect(signed.headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    expect(signed.headers["API-Key"]).toBe(
      "kraken-example-public-key-not-published-by-kraken",
    );
    expect(signed.headers["API-Sign"]).toMatch(/^[A-Za-z0-9+/]+=*$/);
    // The nonce is written first, matching Kraken's own worked example and
    // letting the signer verify the body carries the nonce it was handed.
    expect(signed.bodyText).toMatch(/^nonce=\d+/);
  });

  it("sends public requests as unsigned GETs with no auth headers", async () => {
    const { client, requests } = clientWith(() => envelope(TIME_RESULT));
    await client.getServerTime();
    const sent = requests[0]!;
    expect(sent.method).toBe("GET");
    expect(sent.headers["API-Key"]).toBeUndefined();
    expect(sent.bodyText).toBe("");
  });

  it("draws a strictly increasing nonce per private request", async () => {
    const { client, requests } = catalogued(() => envelope(BALANCE_EX_RESULT));
    await client.getAccountBalances();
    await client.getAccountBalances();

    const nonces = requests
      .filter((r) => r.method === "POST")
      .map((r) => Number(bodyOf(r)["nonce"]));
    expect(nonces).toHaveLength(2);
    expect(nonces[1]!).toBeGreaterThan(nonces[0]!);
  });

  it("reports a local signing failure as a definite non-send", async () => {
    // A malformed secret throws before anything leaves, so no order state is in
    // doubt -- and no request is recorded.
    const requests: string[] = [];
    const client = new KrakenClient({
      baseUrl: BASE,
      credentials: fakeKrakenCredentialProvider({ apiSecret: "not-base64-at-all-!!" }),
      now: () => AT,
      fetch: async (input) => {
        const url = new URL(input);
        requests.push(url.pathname);
        return url.pathname === KRAKEN_ENDPOINTS.assetPairs
          ? envelope(ASSET_PAIRS)
          : envelope(ASSETS);
      },
    });

    const error = failureOf(await client.getAccountBalances());
    expect(error.kind).toBe("transport");
    // Only the two public catalogue fetches went out.
    expect(requests).toEqual([KRAKEN_ENDPOINTS.assetPairs, KRAKEN_ENDPOINTS.assets]);
  });
});

// --------------------------------------------------------------------------
// The rate-limit placeholder -- pinned as a placeholder, deliberately
// --------------------------------------------------------------------------

describe("KRAKEN_REQUEST_COSTS", () => {
  it("covers every interface method, so a new one cannot be added uncounted", async () => {
    const client = new KrakenClient({
      baseUrl: BASE,
      credentials: fakeKrakenCredentialProvider(),
      fetch: async () => envelope({}),
    });
    const methods = [
      "getServerTime",
      "getSymbolFilters",
      "listTradablePairs",
      "getCurrentPrice",
      "placeOrder",
      "cancelOrder",
      "getOrderStatus",
      "getOpenOrders",
      "getAccountBalances",
      "getCandles",
    ] as const;
    expect(Object.keys(KRAKEN_REQUEST_COSTS).sort()).toEqual([...methods].sort());
    for (const method of methods) {
      expect(typeof client[method]).toBe("function");
    }
  });

  it("records the two facts no MethodWeights table can express", async () => {
    // A cancel charges the PER-PAIR matching-engine counter at a price that
    // depends on the ORDER'S AGE (+8 under five seconds), while its follow-up
    // read charges the account-wide REST counter. Both, during a halt.
    expect(KRAKEN_REQUEST_COSTS.cancelOrder).toEqual({
      restRequests: 1,
      tradingRequests: 1,
      ageDependent: true,
      needsCatalogue: true,
    });
    expect(KRAKEN_REQUEST_COSTS.placeOrder).toMatchObject({
      restRequests: 0,
      tradingRequests: 1,
    });
  });

  it("IS wired into the gate: Kraken has its own row in METHOD_COSTS", async () => {
    // This assertion is the replacement the placeholder above asked for. It used
    // to read `not.toHaveProperty("kraken")` and said, in as many words, "if this
    // test ever fails, that session has begun and this expectation is what it
    // should replace". Entry 90 PART 6 step (d) is that session; the row it
    // landed is a decaying account counter, a second PER-PAIR counter, and a
    // cancel priced by the order's age.
    expect(METHOD_COSTS).toHaveProperty("kraken");
    expect(Object.keys(METHOD_COSTS).sort()).toEqual(["binance", "gemini", "kraken"]);
  });
});
