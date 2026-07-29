import { afterEach, describe, expect, it, vi } from "vitest";
import { isUsable } from "../../shared/downtime";
import type { OrderRequest } from "../../shared/exchange-client";
import { fromDecimalString as m, ZERO } from "../../shared/money";
import { WeightBudget } from "../../shared/rate-limiter";
import { fakeCredentialProvider } from "../credentials";
import { BinanceClient, BINANCE_BASE_URLS, type FetchLike } from "./client";
import { SymbolFilterCache } from "./filters";

const AT = 1_700_000_000_000;
const SERVER_TIME = AT + 1200;
const BASE = BINANCE_BASE_URLS.testnet;

/** One recorded outbound request. */
interface Recorded {
  url: URL;
  method: string;
  headers: Record<string, string>;
}

type Handler = (url: URL, request: Recorded) => Response | Promise<Response>;

function json(
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {},
): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...init.headers },
  });
}

const SYMBOL_ENTRY = {
  symbol: "BTCUSDT",
  status: "TRADING",
  baseAsset: "BTC",
  quoteAsset: "USDT",
  filters: [
    {
      filterType: "PRICE_FILTER",
      minPrice: "0.01000000",
      maxPrice: "1000000.00000000",
      tickSize: "0.01000000",
    },
    {
      filterType: "LOT_SIZE",
      minQty: "0.00001000",
      maxQty: "9000.00000000",
      stepSize: "0.00001000",
    },
    { filterType: "NOTIONAL", minNotional: "10.00000000", maxNotional: "9000000.00000000" },
  ],
};

const ORDER_ACK = {
  symbol: "BTCUSDT",
  orderId: 28,
  orderListId: -1,
  clientOrderId: "v1-dca-btc-7",
  transactTime: SERVER_TIME,
  price: "43210.56000000",
  origQty: "0.00100000",
  executedQty: "0.00000000",
  cummulativeQuoteQty: "0.00000000",
  status: "NEW",
  timeInForce: "GTC",
  type: "LIMIT",
  side: "BUY",
  fills: [],
};

const VALID_ORDER: OrderRequest = {
  pair: "BTCUSDT",
  clientOrderId: "v1-dca-btc-7",
  side: "buy",
  type: "limit",
  price: m("43210.56"),
  quantity: m("0.001"),
};

/**
 * A client wired to a routing fake `fetch`.
 *
 * The default routes cover server time and exchange info, because any signed
 * call syncs the clock first and `placeOrder` needs filters -- so a test that
 * cares about neither does not have to supply them.
 */
function harness(routes: Record<string, Handler> = {}, options: { now?: () => number } = {}) {
  const calls: Recorded[] = [];
  const weightSyncs: { usedWeight: number; at: number }[] = [];

  const defaults: Record<string, Handler> = {
    "/api/v3/time": () =>
      json({ serverTime: SERVER_TIME }, { headers: { "X-MBX-USED-WEIGHT-1M": "1" } }),
    "/api/v3/exchangeInfo": () => json({ symbols: [SYMBOL_ENTRY] }),
  };
  const table = { ...defaults, ...routes };

  const fetchImpl: FetchLike = async (input, init) => {
    const url = new URL(input);
    const headers = Object.fromEntries(
      Object.entries((init?.headers ?? {}) as Record<string, string>),
    );
    const record: Recorded = { url, method: init?.method ?? "GET", headers };
    calls.push(record);

    const handler = table[url.pathname];
    if (handler === undefined) {
      throw new Error(`no route for ${url.pathname}`);
    }
    return handler(url, record);
  };

  const rateLimiter = {
    syncFromExchange: (usedWeight: number, at: number) => {
      weightSyncs.push({ usedWeight, at });
    },
  };

  const client = new BinanceClient({
    baseUrl: BASE,
    credentials: fakeCredentialProvider(),
    fetch: fetchImpl,
    now: options.now ?? (() => AT),
    rateLimiter,
  });

  return {
    client,
    calls,
    weightSyncs,
    callsTo: (pathname: string) => calls.filter((call) => call.url.pathname === pathname),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("getServerTime and clock drift", () => {
  it("fetches server time and reports it", async () => {
    const { client, calls } = harness();

    const outcome = await client.getServerTime();

    expect(isUsable(outcome)).toBe(true);
    if (isUsable(outcome)) expect(outcome.value).toBe(SERVER_TIME);
    expect(calls[0]?.url.pathname).toBe("/api/v3/time");
  });

  it("records the offset so later requests can be timestamped", async () => {
    const { client } = harness();

    await client.getServerTime();

    expect(client.clock.isSynced).toBe(true);
    expect(client.clock.offsetMs).toBe(SERVER_TIME - AT);
  });

  it("sends no api key header on an unsigned request", async () => {
    const { client, calls } = harness();

    await client.getServerTime();

    expect(calls[0]?.headers["X-MBX-APIKEY"]).toBeUndefined();
  });

  it("shares one in-flight sync between concurrent callers", async () => {
    const { client, callsTo } = harness();

    await Promise.all([client.getServerTime(), client.getServerTime(), client.getServerTime()]);

    // Three callers, one request: a cold client hit by a burst of signed calls
    // must not spend weight computing the same offset three times.
    expect(callsTo("/api/v3/time")).toHaveLength(1);
  });

  it("syncs the clock before the first signed request", async () => {
    const { client, calls } = harness({
      "/api/v3/account": () => json({ balances: [] }),
    });

    await client.getAccountBalances();

    expect(calls.map((call) => call.url.pathname)).toStrictEqual([
      "/api/v3/time",
      "/api/v3/account",
    ]);
  });

  it("does not re-sync for a second signed request inside the interval", async () => {
    const { client, callsTo } = harness({
      "/api/v3/account": () => json({ balances: [] }),
    });

    await client.getAccountBalances();
    await client.getAccountBalances();

    expect(callsTo("/api/v3/time")).toHaveLength(1);
  });

  it("re-syncs once the offset is stale", async () => {
    let now = AT;
    const { client, callsTo } = harness(
      { "/api/v3/account": () => json({ balances: [] }) },
      { now: () => now },
    );

    await client.getAccountBalances();
    now = AT + 400_000; // past the five-minute refresh interval
    await client.getAccountBalances();

    expect(callsTo("/api/v3/time")).toHaveLength(2);
  });

  it("refuses to sign at all if the clock has never synced", async () => {
    const { client, callsTo } = harness({
      "/api/v3/time": () => json({ code: -1000, msg: "unavailable" }, { status: 503 }),
      "/api/v3/account": () => json({ balances: [] }),
    });

    const outcome = await client.getAccountBalances();

    expect(isUsable(outcome)).toBe(false);
    // Never sent: signing with an unverified clock would fail at the exchange
    // with an error that says nothing about the real cause.
    expect(callsTo("/api/v3/account")).toHaveLength(0);
  });

  it("keeps working on a failed REFRESH, since the existing offset is still usable", async () => {
    let now = AT;
    let timeAvailable = true;
    const { client, callsTo } = harness(
      {
        "/api/v3/time": () =>
          timeAvailable
            ? json({ serverTime: SERVER_TIME })
            : json({ code: -1000, msg: "down" }, { status: 503 }),
        "/api/v3/account": () => json({ balances: [] }),
      },
      { now: () => now },
    );

    await client.getAccountBalances();
    timeAvailable = false;
    now = AT + 400_000;

    const outcome = await client.getAccountBalances();

    expect(isUsable(outcome)).toBe(true);
    expect(callsTo("/api/v3/account")).toHaveLength(2);
  });

  it("clears the offset when the exchange rejects the timestamp", async () => {
    const { client } = harness({
      "/api/v3/account": () =>
        json(
          { code: -1021, msg: "Timestamp for this request is outside of the recvWindow." },
          { status: 400 },
        ),
    });

    await client.getAccountBalances();

    // Dropped, so the next signed request re-syncs rather than repeating the
    // same rejected timestamp.
    expect(client.clock.isSynced).toBe(false);
  });
});

describe("signing", () => {
  it("signs a private request and sends the api key header", async () => {
    const { client, calls } = harness({
      "/api/v3/account": () => json({ balances: [] }),
    });

    await client.getAccountBalances();
    const request = calls[1]!;

    expect(request.headers["X-MBX-APIKEY"]).toBe(
      fakeCredentialProvider().getCredentials().apiKey,
    );
    expect(request.url.searchParams.get("signature")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("includes recvWindow and a drift-corrected timestamp", async () => {
    const { client, calls } = harness({
      "/api/v3/account": () => json({ balances: [] }),
    });

    await client.getAccountBalances();
    const params = calls[1]!.url.searchParams;

    expect(params.get("recvWindow")).toBe("5000");
    // Local clock plus the offset, less the safety margin.
    expect(Number(params.get("timestamp"))).toBe(SERVER_TIME - 500);
  });

  it("puts the signature last, after every other parameter", async () => {
    const { client, calls } = harness({
      "/api/v3/account": () => json({ balances: [] }),
    });

    await client.getAccountBalances();

    expect(calls[1]!.url.search).toMatch(/&signature=[0-9a-f]{64}$/);
  });

  it("does not sign public market-data requests", async () => {
    const { client, calls } = harness({
      "/api/v3/ticker/price": () => json({ symbol: "BTCUSDT", price: "43210.56000000" }),
    });

    await client.getCurrentPrice("BTCUSDT");

    expect(calls[0]!.url.searchParams.get("signature")).toBeNull();
    expect(calls[0]!.headers["X-MBX-APIKEY"]).toBeUndefined();
  });
});

describe("getCurrentPrice", () => {
  it("returns the parsed price stamped with receipt time", async () => {
    const { client } = harness({
      "/api/v3/ticker/price": () => json({ symbol: "BTCUSDT", price: "43210.56000000" }),
    });

    const outcome = await client.getCurrentPrice("BTCUSDT");

    expect(isUsable(outcome)).toBe(true);
    if (isUsable(outcome)) {
      expect(outcome.value).toStrictEqual({
        pair: "BTCUSDT",
        price: m("43210.56"),
        at: AT,
      });
    }
  });

  it("requests the pair it was asked for", async () => {
    const { client, calls } = harness({
      "/api/v3/ticker/price": () => json({ symbol: "ETHUSDT", price: "2000.00000000" }),
    });

    await client.getCurrentPrice("ETHUSDT");

    expect(calls[0]!.url.searchParams.get("symbol")).toBe("ETHUSDT");
  });
});

describe("getCandles", () => {
  // Binance klines: [openTime, open, high, low, close, volume, closeTime, ...],
  // OHLCV as STRINGS, oldest-first, close time reported directly.
  const KLINES = [
    [AT - 120_000, "42900.00", "42985.00", "42890.00", "42980.00", "2.00000000", AT - 60_001, "x", 5, "0", "0", "0"],
    [AT - 60_000, "42980.00", "43001.00", "42950.00", "43000.50", "0.00078400", AT - 1, "x", 5, "0", "0", "0"],
    [AT, "43000.50", "43010.00", "42990.00", "43005.25", "1.50000000", AT + 59_999, "x", 5, "0", "0", "0"],
  ];

  it("GETs /api/v3/klines unsigned and parses oldest-first with the reported close time", async () => {
    const { client, calls } = harness({ "/api/v3/klines": () => json(KLINES) });

    const outcome = await client.getCandles("BTCUSDT", "1m");

    expect(isUsable(outcome)).toBe(true);
    if (isUsable(outcome)) {
      const candles = outcome.value;
      expect(candles.map((c) => c.openTime)).toEqual([AT - 120_000, AT - 60_000, AT]);
      expect(candles[2]!.close).toBe(m("43005.25"));
      expect(candles[1]!.volume).toBe(m("0.000784"));
      // Reported, not derived.
      expect(candles[0]!.closeTime).toBe(AT - 60_001);
      expect(candles[2]!.closed).toBe(false);
      expect(candles[0]!.closed).toBe(true);
    }
    expect(calls[0]!.url.pathname).toBe("/api/v3/klines");
    expect(calls[0]!.url.searchParams.get("interval")).toBe("1m");
    // Unsigned: no signature query parameter.
    expect(calls[0]!.url.searchParams.get("signature")).toBeNull();
  });

  it("pushes `since` to the exchange as startTime and filters the result", async () => {
    const { client, calls } = harness({ "/api/v3/klines": () => json(KLINES) });
    const outcome = await client.getCandles("BTCUSDT", "1m", AT - 30_000);
    expect(calls[0]!.url.searchParams.get("startTime")).toBe(String(AT - 30_000));
    expect(isUsable(outcome)).toBe(true);
    // closeTimes AT-60001, AT-1, AT+59999; since=AT-30000 drops the oldest.
    if (isUsable(outcome)) expect(outcome.value.map((c) => c.openTime)).toEqual([AT - 60_000, AT]);
  });
});

describe("getSymbolFilters", () => {
  it("parses and caches the symbol's filters", async () => {
    const { client } = harness();

    const outcome = await client.getSymbolFilters("BTCUSDT");

    expect(isUsable(outcome)).toBe(true);
    if (isUsable(outcome)) {
      expect(outcome.value.tickSize).toBe(m("0.01"));
      expect(outcome.value.minNotional).toBe(m("10"));
      expect(outcome.value.status).toBe("TRADING");
    }
    expect(client.filterCache.peek("BTCUSDT")).toBeDefined();
  });

  it("reports a symbol the exchange does not return", async () => {
    const { client } = harness({
      "/api/v3/exchangeInfo": () => json({ symbols: [] }),
    });

    const outcome = await client.getSymbolFilters("NOPEUSDT");

    expect(isUsable(outcome)).toBe(false);
    if (!isUsable(outcome)) expect(outcome.message).toContain("no entry for NOPEUSDT");
  });
});

describe("placeOrder", () => {
  it("sends a signed limit order with the bot's own client order id", async () => {
    const { client, calls } = harness({
      "/api/v3/order": () => json(ORDER_ACK),
    });

    const outcome = await client.placeOrder(VALID_ORDER);

    expect(isUsable(outcome)).toBe(true);
    const request = calls.find((call) => call.url.pathname === "/api/v3/order")!;
    expect(request.method).toBe("POST");
    expect(Object.fromEntries(request.url.searchParams)).toMatchObject({
      symbol: "BTCUSDT",
      side: "BUY",
      type: "LIMIT",
      timeInForce: "GTC",
      quantity: "0.001",
      price: "43210.56",
      newClientOrderId: "v1-dca-btc-7",
    });
  });

  it("maps a sell to the exchange's own side spelling", async () => {
    const { client, calls } = harness({
      "/api/v3/order": () => json({ ...ORDER_ACK, side: "SELL" }),
    });

    await client.placeOrder({ ...VALID_ORDER, side: "sell" });

    const request = calls.find((call) => call.url.pathname === "/api/v3/order")!;
    expect(request.url.searchParams.get("side")).toBe("SELL");
  });

  it("returns the parsed acknowledgement", async () => {
    const { client } = harness({ "/api/v3/order": () => json(ORDER_ACK) });

    const outcome = await client.placeOrder(VALID_ORDER);

    if (isUsable(outcome)) {
      expect(outcome.value.exchangeOrderId).toBe("28");
      expect(outcome.value.clientOrderId).toBe("v1-dca-btc-7");
      expect(outcome.value.state).toBe("pending");
    }
  });

  it("re-validates before sending and refuses an order below minimum notional", async () => {
    const { client, callsTo } = harness({ "/api/v3/order": () => json(ORDER_ACK) });

    // 43210.56 x 0.0001 = 4.32, under the symbol's minimum of 10.
    const outcome = await client.placeOrder({ ...VALID_ORDER, quantity: m("0.0001") });

    expect(isUsable(outcome)).toBe(false);
    if (!isUsable(outcome)) {
      expect(outcome.message).toContain("notional_below_min");
      expect(outcome.retryable).toBe(false);
    }
    // Section 4.3: log the reason and skip the action, do not send it.
    expect(callsTo("/api/v3/order")).toHaveLength(0);
  });

  it("refuses an order whose price drifted off the tick grid after construction", async () => {
    const { client, callsTo } = harness({ "/api/v3/order": () => json(ORDER_ACK) });

    const outcome = await client.placeOrder({ ...VALID_ORDER, price: m("43210.567") });

    expect(isUsable(outcome)).toBe(false);
    if (!isUsable(outcome)) {
      // Reported rather than silently re-rounded: this is the second check's
      // whole purpose.
      expect(outcome.message).toContain("price_off_tick");
    }
    expect(callsTo("/api/v3/order")).toHaveLength(0);
  });

  it("refuses to place an order on a halted symbol", async () => {
    const { client, callsTo } = harness({
      "/api/v3/exchangeInfo": () => json({ symbols: [{ ...SYMBOL_ENTRY, status: "HALT" }] }),
      "/api/v3/order": () => json(ORDER_ACK),
    });

    const outcome = await client.placeOrder(VALID_ORDER);

    expect(isUsable(outcome)).toBe(false);
    if (!isUsable(outcome)) expect(outcome.message).toContain("symbol_not_trading");
    expect(callsTo("/api/v3/order")).toHaveLength(0);
  });

  it("does not send an order it could not validate", async () => {
    const { client, callsTo } = harness({
      "/api/v3/exchangeInfo": () => json({ code: -1000, msg: "down" }, { status: 503 }),
      "/api/v3/order": () => json(ORDER_ACK),
    });

    const outcome = await client.placeOrder(VALID_ORDER);

    expect(isUsable(outcome)).toBe(false);
    // Section 5.6: an unreachable exchange is not an answer, so an unvalidatable
    // order is not sent on the assumption the filters probably still hold.
    expect(callsTo("/api/v3/order")).toHaveLength(0);
  });

  it("reuses cached filters across orders rather than refetching", async () => {
    const { client, callsTo } = harness({ "/api/v3/order": () => json(ORDER_ACK) });

    await client.placeOrder(VALID_ORDER);
    await client.placeOrder({ ...VALID_ORDER, clientOrderId: "v1-dca-btc-8" });

    expect(callsTo("/api/v3/exchangeInfo")).toHaveLength(1);
    expect(callsTo("/api/v3/order")).toHaveLength(2);
  });

  it("refetches filters once the cache goes stale", async () => {
    let now = AT;
    const { client, callsTo } = harness(
      { "/api/v3/order": () => json(ORDER_ACK) },
      { now: () => now },
    );

    await client.placeOrder(VALID_ORDER);
    now = AT + 7_200_000; // past the one-hour filter lifetime
    await client.placeOrder({ ...VALID_ORDER, clientOrderId: "v1-dca-btc-8" });

    expect(callsTo("/api/v3/exchangeInfo")).toHaveLength(2);
  });

  it("accepts a shared filter cache, as step 6 will need across bots", async () => {
    const shared = new SymbolFilterCache();
    const client = new BinanceClient({
      baseUrl: BASE,
      credentials: fakeCredentialProvider(),
      now: () => AT,
      filterCache: shared,
      fetch: async (input) => {
        const url = new URL(input);
        if (url.pathname === "/api/v3/time") return json({ serverTime: SERVER_TIME });
        return json({ symbols: [SYMBOL_ENTRY] });
      },
    });

    await client.getSymbolFilters("BTCUSDT");

    expect(shared.get("BTCUSDT", AT)).toBeDefined();
  });
});

describe("cancelOrder, getOrderStatus, getOpenOrders, getAccountBalances", () => {
  const STATUS_BODY = {
    symbol: "BTCUSDT",
    orderId: 12345,
    orderListId: -1,
    clientOrderId: "v1-dca-btc-7",
    price: "43210.56000000",
    origQty: "0.00100000",
    executedQty: "0.00000000",
    cummulativeQuoteQty: "0.00000000",
    status: "NEW",
    timeInForce: "GTC",
    type: "LIMIT",
    side: "BUY",
    time: AT,
    updateTime: AT,
    isWorking: true,
  };

  /**
   * The cancellation payload, which differs from the status one in two ways that
   * matter: it identifies the cancelled order by `origClientOrderId` (its own
   * `clientOrderId` names the cancel request), and it carries `transactTime`
   * rather than `time`/`updateTime`.
   */
  const CANCEL_BODY = {
    symbol: "BTCUSDT",
    origClientOrderId: "v1-dca-btc-7",
    orderId: 12345,
    orderListId: -1,
    clientOrderId: "cancel-request-generated-by-exchange",
    transactTime: AT + 5000,
    price: "43210.56000000",
    origQty: "0.00100000",
    executedQty: "0.00000000",
    origQuoteOrderQty: "0.000000",
    cummulativeQuoteQty: "0.00000000",
    status: "CANCELED",
    timeInForce: "GTC",
    type: "LIMIT",
    side: "BUY",
    selfTradePreventionMode: "NONE",
  };

  it("cancels by the bot's own client order id", async () => {
    const { client, calls } = harness({
      "/api/v3/order": () => json(CANCEL_BODY),
    });

    const outcome = await client.cancelOrder("BTCUSDT", "v1-dca-btc-7");

    expect(isUsable(outcome)).toBe(true);
    const request = calls.find((call) => call.url.pathname === "/api/v3/order")!;
    expect(request.method).toBe("DELETE");
    expect(request.url.searchParams.get("origClientOrderId")).toBe("v1-dca-btc-7");
  });

  it("returns the order's final state instead of discarding it", async () => {
    const { client } = harness({ "/api/v3/order": () => json(CANCEL_BODY) });

    const outcome = await client.cancelOrder("BTCUSDT", "v1-dca-btc-7");

    expect(isUsable(outcome)).toBe(true);
    if (isUsable(outcome)) {
      expect(outcome.value.state).toBe("cancelled");
      expect(outcome.value.filledQuantity).toBe(ZERO);
      expect(outcome.value.exchangeOrderId).toBe("12345");
    }
  });

  it("reports how much filled before the cancel took effect (section 7.2)", async () => {
    const { client } = harness({
      "/api/v3/order": () =>
        json({
          ...CANCEL_BODY,
          executedQty: "0.00060000",
          cummulativeQuoteQty: "25.92633600",
        }),
    });

    const outcome = await client.cancelOrder("BTCUSDT", "v1-dca-btc-7");

    if (isUsable(outcome)) {
      // The position a halted bot is actually left holding, from the same
      // response that ended the order -- no follow-up status call needed.
      expect(outcome.value.filledQuantity).toBe(m("0.0006"));
      expect(outcome.value.cumulativeQuoteQuantity).toBe(m("25.926336"));
      expect(outcome.value.quantity).toBe(m("0.001"));
    }
  });

  it("attributes the result to the cancelled order, not to the cancel request", async () => {
    const { client } = harness({ "/api/v3/order": () => json(CANCEL_BODY) });

    const outcome = await client.cancelOrder("BTCUSDT", "v1-dca-btc-7");

    if (isUsable(outcome)) {
      // Reading the payload's own `clientOrderId` would silently return
      // "cancel-request-generated-by-exchange" -- an id this system never
      // issued -- and the real order's final fill would be lost.
      expect(outcome.value.clientOrderId).toBe("v1-dca-btc-7");
    }
  });

  it("dates the record to the cancellation, and omits an unknown creation time", async () => {
    const { client } = harness({ "/api/v3/order": () => json(CANCEL_BODY) });

    const outcome = await client.cancelOrder("BTCUSDT", "v1-dca-btc-7");

    if (isUsable(outcome)) {
      expect(outcome.value.updatedAt).toBe(AT + 5000);
      // The payload carries no creation time; inventing one from transactTime
      // would look authoritative and be wrong.
      expect(outcome.value.createdAt).toBeUndefined();
    }
  });

  it("reports a cancel the exchange refused, rather than assuming it worked", async () => {
    const { client } = harness({
      "/api/v3/order": () =>
        json({ code: -2011, msg: "Unknown order sent." }, { status: 400 }),
    });

    const outcome = await client.cancelOrder("BTCUSDT", "v1-dca-btc-7");

    expect(isUsable(outcome)).toBe(false);
    if (!isUsable(outcome)) expect(outcome.code).toBe(-2011);
  });

  it("looks an order up by client order id, the idempotency recovery path", async () => {
    const { client, calls } = harness({
      "/api/v3/order": () => json(STATUS_BODY),
    });

    const outcome = await client.getOrderStatus("BTCUSDT", "v1-dca-btc-7");

    expect(isUsable(outcome)).toBe(true);
    if (isUsable(outcome)) {
      expect(outcome.value.state).toBe("pending");
      expect(outcome.value.exchangeOrderId).toBe("12345");
    }
    const request = calls.find((call) => call.url.pathname === "/api/v3/order")!;
    expect(request.method).toBe("GET");
  });

  it("reports a missing order as a failure carrying the exchange's code", async () => {
    const { client } = harness({
      "/api/v3/order": () => json({ code: -2013, msg: "Order does not exist." }, { status: 400 }),
    });

    const outcome = await client.getOrderStatus("BTCUSDT", "v1-dca-btc-7");

    expect(isUsable(outcome)).toBe(false);
    if (!isUsable(outcome)) {
      expect(outcome.code).toBe(-2013);
      expect(outcome.retryable).toBe(false);
    }
  });

  it("lists open orders for a pair", async () => {
    const { client } = harness({
      "/api/v3/openOrders": () => json([STATUS_BODY, { ...STATUS_BODY, orderId: 12346 }]),
    });

    const outcome = await client.getOpenOrders("BTCUSDT");

    expect(isUsable(outcome)).toBe(true);
    if (isUsable(outcome)) expect(outcome.value).toHaveLength(2);
  });

  it("returns an empty list when nothing is open", async () => {
    const { client } = harness({ "/api/v3/openOrders": () => json([]) });

    const outcome = await client.getOpenOrders("BTCUSDT");

    if (isUsable(outcome)) expect(outcome.value).toStrictEqual([]);
  });

  it("reads account balances", async () => {
    const { client } = harness({
      "/api/v3/account": () =>
        json({
          balances: [
            { asset: "BTC", free: "0.50000000", locked: "0.10000000" },
            { asset: "USDT", free: "1000.00000000", locked: "0.00000000" },
          ],
        }),
    });

    const outcome = await client.getAccountBalances();

    expect(isUsable(outcome)).toBe(true);
    if (isUsable(outcome)) {
      expect(outcome.value).toStrictEqual([
        { asset: "BTC", free: m("0.5"), locked: m("0.1") },
        { asset: "USDT", free: m("1000"), locked: ZERO },
      ]);
    }
  });
});

describe("downtime detection wraps every call (section 5.6)", () => {
  it("turns a thrown fetch into a transport failure, not a price", async () => {
    const { client } = harness({
      "/api/v3/ticker/price": () => {
        throw new Error("connection reset");
      },
    });

    const outcome = await client.getCurrentPrice("BTCUSDT");

    expect(isUsable(outcome)).toBe(false);
    if (!isUsable(outcome)) {
      expect(outcome.kind).toBe("transport");
      expect(outcome.retryable).toBe(true);
      expect(outcome.message).toContain("connection reset");
    }
  });

  it("treats a 5xx as a transport failure", async () => {
    const { client } = harness({
      "/api/v3/ticker/price": () => json({ code: -1000, msg: "oops" }, { status: 503 }),
    });

    const outcome = await client.getCurrentPrice("BTCUSDT");

    if (!isUsable(outcome)) {
      expect(outcome.kind).toBe("transport");
      expect(outcome.retryable).toBe(true);
    }
  });

  it("treats an ordinary 4xx as a refusal that will not change on retry", async () => {
    const { client } = harness({
      "/api/v3/ticker/price": () => json({ code: -1121, msg: "Invalid symbol." }, { status: 400 }),
    });

    const outcome = await client.getCurrentPrice("NOPE");

    if (!isUsable(outcome)) {
      expect(outcome.kind).toBe("exchange_error");
      expect(outcome.retryable).toBe(false);
      expect(outcome.code).toBe(-1121);
    }
  });

  it("treats an order timeout as unknown execution, never as a refusal", async () => {
    const { client } = harness({
      "/api/v3/order": () =>
        json(
          {
            code: -1007,
            msg: "Timeout waiting for response from backend server. Send status unknown; execution status unknown.",
          },
          { status: 400 },
        ),
    });

    const outcome = await client.placeOrder(VALID_ORDER);

    expect(isUsable(outcome)).toBe(false);
    if (!isUsable(outcome)) {
      // The order may be resting on the book. Classifying this as a plain 4xx
      // refusal would let a caller conclude it definitely was not placed.
      expect(outcome.kind).toBe("transport");
      expect(outcome.retryable).toBe(true);
    }
  });

  it("treats a 200 with an unreadable body as a failure, not as data", async () => {
    const { client } = harness({
      "/api/v3/ticker/price": () => json({ symbol: "BTCUSDT" }),
    });

    const outcome = await client.getCurrentPrice("BTCUSDT");

    expect(isUsable(outcome)).toBe(false);
    if (!isUsable(outcome)) {
      expect(outcome.kind).toBe("exchange_error");
      expect(outcome.retryable).toBe(false);
      expect(outcome.message).toContain("could not read the exchange's response");
    }
  });

  it("handles a non-JSON error page without masking the status", async () => {
    const { client } = harness({
      "/api/v3/ticker/price": () =>
        new Response("<html>blocked by WAF</html>", {
          status: 403,
          headers: { "content-type": "text/html" },
        }),
    });

    const outcome = await client.getCurrentPrice("BTCUSDT");

    expect(isUsable(outcome)).toBe(false);
    if (!isUsable(outcome)) {
      expect(outcome.status).toBe(403);
      expect(outcome.retryable).toBe(false);
    }
  });

  it("stamps every failure with the time it happened", async () => {
    const { client } = harness({
      "/api/v3/ticker/price": () => json({ code: -1121, msg: "bad" }, { status: 400 }),
    });

    const outcome = await client.getCurrentPrice("NOPE");

    expect(outcome.at).toBe(AT);
  });
});

describe("rate-limit reporting (section 5.4)", () => {
  it("feeds the used-weight header to the rate limiter", async () => {
    const { client, weightSyncs } = harness({
      "/api/v3/ticker/price": () =>
        json(
          { symbol: "BTCUSDT", price: "43210.56000000" },
          { headers: { "X-MBX-USED-WEIGHT-1M": "247" } },
        ),
    });

    await client.getCurrentPrice("BTCUSDT");

    expect(weightSyncs).toContainEqual({ usedWeight: 247, at: AT });
  });

  it("reports weight from a failed response too", async () => {
    const { client, weightSyncs } = harness({
      "/api/v3/ticker/price": () =>
        json(
          { code: -1003, msg: "Too many requests" },
          { status: 429, headers: { "X-MBX-USED-WEIGHT-1M": "6000", "Retry-After": "30" } },
        ),
    });

    await client.getCurrentPrice("BTCUSDT");

    // A 429 is precisely when the exchange's own count matters more than local
    // accounting.
    expect(weightSyncs).toContainEqual({ usedWeight: 6000, at: AT });
  });

  it("drives the real WeightBudget from response headers", async () => {
    const budget = new WeightBudget({ limit: 6000, windowMs: 60_000, reserveForRiskExit: 1000 });
    const client = new BinanceClient({
      baseUrl: BASE,
      credentials: fakeCredentialProvider(),
      now: () => AT,
      rateLimiter: budget,
      fetch: async () =>
        json(
          { symbol: "BTCUSDT", price: "43210.56000000" },
          { headers: { "X-MBX-USED-WEIGHT-1M": "5500" } },
        ),
    });

    await client.getCurrentPrice("BTCUSDT");

    expect(budget.usedWeight(AT)).toBe(5500);
    expect(budget.remainingFor("routine", AT)).toBe(0);
    expect(budget.remainingFor("risk-exit", AT)).toBe(500);
  });

  it("reports the account's weight LIMIT from an exchangeInfo body", async () => {
    // Section 5.4 names two sources for the budget: response headers, tested
    // above, and `exchangeInfo`. Only the first existed until step 8.
    const limits: { limit: number; windowMs: number }[] = [];
    const client = new BinanceClient({
      baseUrl: BASE,
      credentials: fakeCredentialProvider(),
      now: () => AT,
      rateLimiter: {
        syncFromExchange: () => undefined,
        syncLimit: (limit, windowMs) => {
          limits.push({ limit, windowMs });
        },
      },
      fetch: async () =>
        json({
          rateLimits: [
            { rateLimitType: "REQUEST_WEIGHT", interval: "MINUTE", intervalNum: 1, limit: 6000 },
            { rateLimitType: "ORDERS", interval: "SECOND", intervalNum: 10, limit: 100 },
          ],
          symbols: [SYMBOL_ENTRY],
        }),
    });

    await client.getSymbolFilters("BTCUSDT");

    // Read off a request the system had to make anyway: the filter cache
    // expires hourly per section 4.3, so the ceiling is refreshed on that same
    // schedule for no additional weight.
    expect(limits).toEqual([{ limit: 6000, windowMs: 60_000 }]);
  });

  it("says nothing about the limit when exchangeInfo carries no rateLimits block", async () => {
    const limits: unknown[] = [];
    const client = new BinanceClient({
      baseUrl: BASE,
      credentials: fakeCredentialProvider(),
      now: () => AT,
      rateLimiter: {
        syncFromExchange: () => undefined,
        syncLimit: (limit, windowMs) => {
          limits.push({ limit, windowMs });
        },
      },
      fetch: async () => json({ symbols: [SYMBOL_ENTRY] }),
    });

    await client.getSymbolFilters("BTCUSDT");

    // Silence rather than a guess. The limiter keeps whatever limit it had.
    expect(limits).toEqual([]);
  });

  it("tolerates a reporter that has no syncLimit at all", async () => {
    // `WeightBudget` is exactly this: constructed with its limit, with no way
    // to be told a new one. The method is optional so it still satisfies the
    // reporter interface unchanged.
    const budget = new WeightBudget({ limit: 6000, windowMs: 60_000, reserveForRiskExit: 1000 });
    const client = new BinanceClient({
      baseUrl: BASE,
      credentials: fakeCredentialProvider(),
      now: () => AT,
      rateLimiter: budget,
      fetch: async () =>
        json({
          rateLimits: [
            { rateLimitType: "REQUEST_WEIGHT", interval: "MINUTE", intervalNum: 1, limit: 6000 },
          ],
          symbols: [SYMBOL_ENTRY],
        }),
    });

    await expect(client.getSymbolFilters("BTCUSDT")).resolves.toMatchObject({ ok: true });
  });

  it("works without a rate limiter attached", async () => {
    const client = new BinanceClient({
      baseUrl: BASE,
      credentials: fakeCredentialProvider(),
      now: () => AT,
      fetch: async () => json({ symbol: "BTCUSDT", price: "1.00000000" }),
    });

    await expect(client.getCurrentPrice("BTCUSDT")).resolves.toMatchObject({ ok: true });
  });
});

describe("default fetch wiring", () => {
  // The pool's documented `fetchMock` helper does not exist in the installed
  // version, so the default path is exercised by stubbing the global directly.
  // What matters is the same either way: that omitting the `fetch` option
  // really does reach the runtime's own fetch.
  it("uses the global fetch when none is injected", async () => {
    const seen: string[] = [];
    vi.stubGlobal("fetch", async (input: string) => {
      seen.push(String(input));
      return json({ symbol: "BTCUSDT", price: "43210.56000000" });
    });

    const client = new BinanceClient({
      baseUrl: BASE,
      credentials: fakeCredentialProvider(),
      now: () => AT,
    });

    const outcome = await client.getCurrentPrice("BTCUSDT");

    expect(isUsable(outcome)).toBe(true);
    expect(seen[0]).toBe(`${BASE}/api/v3/ticker/price?symbol=BTCUSDT`);
  });

  it("builds urls against the configured base, keeping environments separate", async () => {
    const seen: string[] = [];
    vi.stubGlobal("fetch", async (input: string) => {
      seen.push(String(input));
      return json({ serverTime: SERVER_TIME });
    });

    const client = new BinanceClient({
      baseUrl: BINANCE_BASE_URLS.production,
      credentials: fakeCredentialProvider(),
      now: () => AT,
    });
    await client.getServerTime();

    expect(seen[0]).toBe("https://api.binance.com/api/v3/time");
  });

  it("tolerates a base url with a trailing slash", async () => {
    vi.stubGlobal("fetch", async (input: string) => {
      expect(String(input)).toBe(`${BASE}/api/v3/time`);
      return json({ serverTime: SERVER_TIME });
    });

    const client = new BinanceClient({
      baseUrl: `${BASE}/`,
      credentials: fakeCredentialProvider(),
      now: () => AT,
    });

    await client.getServerTime();
  });
});

describe("listTradablePairs", () => {
  it("hits the full exchangeInfo catalogue (no symbol param) and returns TRADING pairs", async () => {
    const { client, callsTo } = harness({
      "/api/v3/exchangeInfo": () =>
        json({
          symbols: [
            { symbol: "BTCUSDT", status: "TRADING" },
            { symbol: "ETHUSDT", status: "TRADING" },
            { symbol: "LUNAUSDT", status: "HALT" },
          ],
        }),
    });

    const outcome = await client.listTradablePairs();

    expect(isUsable(outcome)).toBe(true);
    if (isUsable(outcome)) expect(outcome.value).toEqual(["BTCUSDT", "ETHUSDT"]);

    // The catalogue request carries no `symbol` filter -- that is what makes it
    // the whole list rather than one entry.
    const call = callsTo("/api/v3/exchangeInfo").at(-1)!;
    expect(call.url.searchParams.has("symbol")).toBe(false);
  });

  it("surfaces a transport failure as a non-usable outcome", async () => {
    const { client } = harness({
      "/api/v3/exchangeInfo": () => json({ msg: "down" }, { status: 503 }),
    });

    const outcome = await client.listTradablePairs();
    expect(isUsable(outcome)).toBe(false);
  });
});
