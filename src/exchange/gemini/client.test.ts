import { afterEach, describe, expect, it, vi } from "vitest";
import { isUsable } from "../../shared/downtime";
import type { OrderRequest } from "../../shared/exchange-client";
import { fromDecimalString as m } from "../../shared/money";
import { fakeCredentialProvider } from "../credentials";
import { GeminiClient, GEMINI_BASE_URLS, type FetchLike } from "./client";
import { SymbolFilterCache } from "./filters";

const AT = 1_700_000_000_000;
const BASE = GEMINI_BASE_URLS.sandbox;

/** One recorded outbound request, with the parsed payload of a private call. */
interface Recorded {
  url: URL;
  method: string;
  headers: Record<string, string>;
  /** The decoded JSON of `X-GEMINI-PAYLOAD`, for a signed request. */
  payload: Record<string, unknown> | undefined;
  bodyText: string;
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

const SYMBOL_DETAILS = {
  symbol: "BTCUSD",
  base_currency: "BTC",
  quote_currency: "USD",
  tick_size: 1e-8,
  quote_increment: 0.01,
  min_order_size: "0.00001",
  status: "open",
};

const RESTING_ORDER = {
  order_id: 555,
  id: "555",
  symbol: "btcusd",
  avg_execution_price: "0.00",
  side: "buy",
  type: "exchange limit",
  timestampms: AT,
  is_live: true,
  is_cancelled: false,
  executed_amount: "0",
  remaining_amount: "0.001",
  original_amount: "0.001",
  price: "43210.56",
  client_order_id: "gemini-dca-btc-7",
};

/** Build a client whose fetch is driven by `handler`, recording each request. */
function clientWith(handler: Handler): { client: GeminiClient; requests: Recorded[] } {
  const requests: Recorded[] = [];
  const fetchLike: FetchLike = async (input, init) => {
    const url = new URL(input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const bodyText = typeof init?.body === "string" ? init.body : "";
    let payload: Record<string, unknown> | undefined;
    const rawPayload = headers["X-GEMINI-PAYLOAD"];
    if (rawPayload !== undefined) {
      payload = JSON.parse(atob(rawPayload)) as Record<string, unknown>;
    }
    const recorded: Recorded = { url, method: init?.method ?? "GET", headers, payload, bodyText };
    requests.push(recorded);
    return handler(url, recorded);
  };
  const client = new GeminiClient({
    baseUrl: BASE,
    credentials: fakeCredentialProvider(),
    fetch: fetchLike,
    now: () => AT,
    filterCache: new SymbolFilterCache(),
  });
  return { client, requests };
}

/**
 * The same harness, but with a MASTER key and a configured account nickname --
 * the configuration a Gemini sub-account group needs.
 */
function masterKeyClientWith(
  handler: Handler,
  // `null` means "no account name configured at all" -- distinct from omitting
  // the argument, which a JS default parameter cannot tell apart from `undefined`.
  accountName: string | null = "primary",
): { client: GeminiClient; requests: Recorded[] } {
  const requests: Recorded[] = [];
  const fetchLike: FetchLike = async (input, init) => {
    const url = new URL(input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const bodyText = typeof init?.body === "string" ? init.body : "";
    let payload: Record<string, unknown> | undefined;
    const rawPayload = headers["X-GEMINI-PAYLOAD"];
    if (rawPayload !== undefined) {
      payload = JSON.parse(atob(rawPayload)) as Record<string, unknown>;
    }
    const recorded: Recorded = { url, method: init?.method ?? "GET", headers, payload, bodyText };
    requests.push(recorded);
    return handler(url, recorded);
  };
  const client = new GeminiClient({
    baseUrl: BASE,
    credentials: fakeCredentialProvider({ apiKey: "master-abc123" }),
    accountName: accountName ?? undefined,
    fetch: fetchLike,
    now: () => AT,
    filterCache: new SymbolFilterCache(),
  });
  return { client, requests };
}

/** A recorded payload with its nonce removed, for exact-shape comparison. */
function payloadWithoutNonce(recorded: Recorded): Record<string, unknown> {
  const { nonce, ...rest } = recorded.payload!;
  expect(typeof nonce).toBe("number");
  return rest;
}

const ORDER: OrderRequest = {
  pair: "BTCUSD",
  clientOrderId: "gemini-dca-btc-7",
  side: "buy",
  type: "limit",
  price: m("43210.56"),
  quantity: m("0.001"),
};

afterEach(() => vi.restoreAllMocks());

describe("getServerTime", () => {
  it("fails closed: Gemini has no server-time endpoint and needs none", async () => {
    const { client, requests } = clientWith(() => json({}));
    const outcome = await client.getServerTime();
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.retryable).toBe(false);
      expect(outcome.message).toContain("nonce");
    }
    // It reaches no network at all.
    expect(requests).toHaveLength(0);
  });
});

describe("getCurrentPrice", () => {
  it("GETs the public pubticker and reads `last`", async () => {
    const { client, requests } = clientWith((url) => {
      expect(url.pathname).toBe("/v1/pubticker/btcusd");
      return json({ bid: "43000", ask: "43001", last: "43000.5" });
    });
    const outcome = await client.getCurrentPrice("BTCUSD");
    expect(isUsable(outcome)).toBe(true);
    if (isUsable(outcome)) expect(outcome.value.price).toBe(m("43000.5"));
    expect(requests[0]!.method).toBe("GET");
    expect(requests[0]!.headers["X-GEMINI-SIGNATURE"]).toBeUndefined();
  });
});

describe("getSymbolFilters", () => {
  it("GETs symbol details and caches the parsed filters", async () => {
    const { client, requests } = clientWith((url) => {
      expect(url.pathname).toBe("/v1/symbols/details/btcusd");
      return json(SYMBOL_DETAILS);
    });
    const outcome = await client.getSymbolFilters("BTCUSD");
    expect(isUsable(outcome)).toBe(true);
    if (isUsable(outcome)) {
      expect(outcome.value.stepSize).toBe(m("0.00000001"));
      expect(outcome.value.tickSize).toBe(m("0.01"));
    }
    expect(requests[0]!.method).toBe("GET");
    expect(client.filterCache.peek("BTCUSD")).toBeDefined();
  });
});

describe("placeOrder", () => {
  it("signs a POST with an empty body and the order in the base64 payload", async () => {
    const { client, requests } = clientWith((url) => {
      if (url.pathname === "/v1/symbols/details/btcusd") return json(SYMBOL_DETAILS);
      expect(url.pathname).toBe("/v1/order/new");
      return json(RESTING_ORDER);
    });

    const outcome = await client.placeOrder(ORDER);
    expect(isUsable(outcome)).toBe(true);
    if (isUsable(outcome)) {
      expect(outcome.value.state).toBe("pending");
      expect(outcome.value.exchangeOrderId).toBe("555");
      expect(outcome.value.fills).toEqual([]);
    }

    const orderReq = requests.find((r) => r.url.pathname === "/v1/order/new")!;
    expect(orderReq.method).toBe("POST");
    expect(orderReq.bodyText).toBe(""); // empty body: everything is in the header
    expect(orderReq.headers["X-GEMINI-APIKEY"]).toBeDefined();
    expect(orderReq.headers["X-GEMINI-SIGNATURE"]).toHaveLength(96); // SHA-384 hex
    expect(orderReq.payload).toMatchObject({
      request: "/v1/order/new",
      symbol: "btcusd",
      amount: "0.001",
      price: "43210.56",
      side: "buy",
      type: "exchange limit",
      client_order_id: "gemini-dca-btc-7",
    });
    expect(typeof orderReq.payload!["nonce"]).toBe("number");
  });

  it("does not send an order that fails the pre-send validation", async () => {
    const { client, requests } = clientWith((url) => {
      if (url.pathname === "/v1/symbols/details/btcusd") return json(SYMBOL_DETAILS);
      return json(RESTING_ORDER);
    });
    // Price off the 0.01 tick; verify mode reports it rather than rounding.
    const outcome = await client.placeOrder({ ...ORDER, price: m("43210.567") });
    expect(outcome.ok).toBe(false);
    expect(requests.some((r) => r.url.pathname === "/v1/order/new")).toBe(false);
  });

  it("increments the nonce across successive signed requests", async () => {
    const { client, requests } = clientWith((url) => {
      if (url.pathname === "/v1/symbols/details/btcusd") return json(SYMBOL_DETAILS);
      return json(RESTING_ORDER);
    });
    await client.placeOrder(ORDER);
    await client.placeOrder(ORDER);
    const nonces = requests
      .filter((r) => r.url.pathname === "/v1/order/new")
      .map((r) => r.payload!["nonce"] as number);
    expect(nonces).toHaveLength(2);
    expect(nonces[1]!).toBeGreaterThan(nonces[0]!);
  });
});

describe("cancelOrder", () => {
  it("looks up the order_id by client_order_id, then cancels by order_id", async () => {
    const { client, requests } = clientWith((url) => {
      if (url.pathname === "/v1/order/status") return json(RESTING_ORDER);
      expect(url.pathname).toBe("/v1/order/cancel");
      return json({ ...RESTING_ORDER, is_live: false, is_cancelled: true, executed_amount: "0.0004" });
    });

    const outcome = await client.cancelOrder("BTCUSD", "gemini-dca-btc-7");
    expect(isUsable(outcome)).toBe(true);
    if (isUsable(outcome)) {
      expect(outcome.value.state).toBe("cancelled");
      expect(outcome.value.filledQuantity).toBe(m("0.0004"));
      expect(outcome.value.updatedAt).toBe(AT); // receipt time
    }

    const status = requests.find((r) => r.url.pathname === "/v1/order/status")!;
    expect(status.payload).toMatchObject({ client_order_id: "gemini-dca-btc-7" });
    const cancel = requests.find((r) => r.url.pathname === "/v1/order/cancel")!;
    // Cancel is BY order_id, the numeric id learned from the lookup.
    expect(cancel.payload).toMatchObject({ order_id: "555" });
  });

  it("returns the lookup failure without attempting the cancel", async () => {
    const { client, requests } = clientWith((url) => {
      if (url.pathname === "/v1/order/status") {
        return json({ result: "error", reason: "OrderNotFound", message: "gone" }, { status: 400 });
      }
      return json({});
    });
    const outcome = await client.cancelOrder("BTCUSD", "missing");
    expect(outcome.ok).toBe(false);
    expect(requests.some((r) => r.url.pathname === "/v1/order/cancel")).toBe(false);
  });
});

describe("getOrderStatus", () => {
  it("asks for trades and parses fills", async () => {
    const { client, requests } = clientWith(() =>
      json({
        ...RESTING_ORDER,
        is_live: false,
        executed_amount: "0.001",
        avg_execution_price: "43000.00",
        trades: [
          { tid: 7, price: "43000.00", amount: "0.001", fee_amount: "0.43", fee_currency: "USD", timestampms: AT },
        ],
      }),
    );
    const outcome = await client.getOrderStatus("BTCUSD", "gemini-dca-btc-7");
    expect(isUsable(outcome)).toBe(true);
    if (isUsable(outcome)) {
      expect(outcome.value.state).toBe("filled");
      expect(outcome.value.fills).toHaveLength(1);
    }
    expect(requests[0]!.payload).toMatchObject({ include_trades: true });
  });
});

describe("getOpenOrders", () => {
  it("filters the account-wide active-orders list down to the requested pair", async () => {
    const { client } = clientWith(() =>
      json([
        RESTING_ORDER,
        { ...RESTING_ORDER, symbol: "ethusd", client_order_id: "other" },
      ]),
    );
    const outcome = await client.getOpenOrders("BTCUSD");
    expect(isUsable(outcome)).toBe(true);
    if (isUsable(outcome)) {
      expect(outcome.value).toHaveLength(1);
      expect(outcome.value[0]!.pair).toBe("btcusd");
    }
  });
});

describe("getAccountBalances", () => {
  it("POSTs to /v1/balances and derives locked", async () => {
    const { client, requests } = clientWith((url) => {
      expect(url.pathname).toBe("/v1/balances");
      return json([{ type: "exchange", currency: "USD", amount: "1000", available: "600" }]);
    });
    const outcome = await client.getAccountBalances();
    expect(isUsable(outcome)).toBe(true);
    if (isUsable(outcome)) expect(outcome.value[0]).toEqual({ asset: "USD", free: m("600"), locked: m("400") });
    expect(requests[0]!.method).toBe("POST");
  });
});

/**
 * The master-key `account` field (Gemini's sub-account rule).
 *
 * These assert the WHOLE payload with `toEqual`, not a subset with
 * `toMatchObject`: the bug being fixed was a MISSING key, which a subset match
 * cannot see. The expected objects are written from Gemini's own request-body
 * tables -- a top-level `account` string, and no other field gained or lost -- so
 * a payload that spelled it `accounts`, nested it, or sent it on only some
 * endpoints fails here.
 */
describe("the account field on signed requests", () => {
  it("places an order with a top-level account and nothing else changed", async () => {
    const { client, requests } = masterKeyClientWith((url) => {
      if (url.pathname === "/v1/symbols/details/btcusd") return json(SYMBOL_DETAILS);
      return json(RESTING_ORDER);
    });

    const outcome = await client.placeOrder(ORDER);
    expect(isUsable(outcome)).toBe(true);

    const orderReq = requests.find((r) => r.url.pathname === "/v1/order/new")!;
    expect(payloadWithoutNonce(orderReq)).toEqual({
      request: "/v1/order/new",
      account: "primary",
      symbol: "btcusd",
      amount: "0.001",
      price: "43210.56",
      side: "buy",
      type: "exchange limit",
      client_order_id: "gemini-dca-btc-7",
    });
    // The field is a plain top-level string, not an array and not `accounts`.
    expect(typeof orderReq.payload!["account"]).toBe("string");
    expect(orderReq.payload).not.toHaveProperty("accounts");
    // And the signature covers the payload that CARRIES it: the header the
    // exchange verifies is the base64 of exactly these bytes.
    expect(JSON.parse(atob(orderReq.headers["X-GEMINI-PAYLOAD"]!))).toEqual(orderReq.payload);
  });

  it("sends the account on balances, the endpoint that marks it required", async () => {
    const { client, requests } = masterKeyClientWith(() =>
      json([{ type: "exchange", currency: "USD", amount: "1000", available: "600" }]),
    );
    await client.getAccountBalances();
    expect(payloadWithoutNonce(requests[0]!)).toEqual({
      request: "/v1/balances",
      account: "primary",
    });
  });

  it("sends the account on the open-orders read", async () => {
    const { client, requests } = masterKeyClientWith(() => json([]));
    await client.getOpenOrders("BTCUSD");
    expect(payloadWithoutNonce(requests[0]!)).toEqual({
      request: "/v1/orders",
      account: "primary",
    });
  });

  it("sends the account on the order-status read", async () => {
    const { client, requests } = masterKeyClientWith(() => json(RESTING_ORDER));
    await client.getOrderStatus("BTCUSD", "gemini-dca-btc-7");
    expect(payloadWithoutNonce(requests[0]!)).toEqual({
      request: "/v1/order/status",
      account: "primary",
      client_order_id: "gemini-dca-btc-7",
      include_trades: true,
    });
  });

  it("sends the account on BOTH halves of a cancel, the lookup and the cancel", async () => {
    const { client, requests } = masterKeyClientWith((url) => {
      if (url.pathname === "/v1/order/status") return json(RESTING_ORDER);
      return json({ ...RESTING_ORDER, is_live: false, is_cancelled: true });
    });
    await client.cancelOrder("BTCUSD", "gemini-dca-btc-7");

    const lookup = requests.find((r) => r.url.pathname === "/v1/order/status")!;
    expect(payloadWithoutNonce(lookup)).toEqual({
      request: "/v1/order/status",
      account: "primary",
      client_order_id: "gemini-dca-btc-7",
    });
    const cancel = requests.find((r) => r.url.pathname === "/v1/order/cancel")!;
    expect(payloadWithoutNonce(cancel)).toEqual({
      request: "/v1/order/cancel",
      account: "primary",
      order_id: "555",
    });
  });

  it("adds nothing to an unsigned public request", async () => {
    const { client, requests } = masterKeyClientWith(() =>
      json({ bid: "1", ask: "2", last: "1.5" }),
    );
    await client.getCurrentPrice("BTCUSD");
    expect(requests[0]!.method).toBe("GET");
    expect(requests[0]!.payload).toBeUndefined();
    expect(requests[0]!.url.search).toBe("");
  });

  it("omits the field entirely when no account name is configured", async () => {
    // The single-account case: an `account` key here would be rejected by Gemini
    // with AccountsOnGroupOnlyApi, so it must be absent, not empty.
    const { client, requests } = clientWith((url) => {
      if (url.pathname === "/v1/symbols/details/btcusd") return json(SYMBOL_DETAILS);
      return json(RESTING_ORDER);
    });
    await client.placeOrder(ORDER);
    const orderReq = requests.find((r) => r.url.pathname === "/v1/order/new")!;
    expect(orderReq.payload).not.toHaveProperty("account");
    expect(Object.keys(orderReq.payload!)).toEqual([
      "request",
      "nonce",
      "symbol",
      "amount",
      "price",
      "side",
      "type",
      "client_order_id",
    ]);
  });

  it("refuses to send at all when a master key has no account name", async () => {
    const { client, requests } = masterKeyClientWith((url) => {
      if (url.pathname === "/v1/symbols/details/btcusd") return json(SYMBOL_DETAILS);
      return json(RESTING_ORDER);
    }, null);

    const outcome = await client.placeOrder(ORDER);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      // Not a transport unknown: nothing was sent, and re-sending is pointless.
      expect(outcome.kind).toBe("exchange_error");
      expect(outcome.retryable).toBe(false);
      expect(outcome.message).toContain("MissingAccounts");
    }
    // The order never left, so its fate is not in doubt.
    expect(requests.some((r) => r.url.pathname === "/v1/order/new")).toBe(false);
  });

  it("sends NO account field on the group-level /v1/account/list", async () => {
    // A group-level API acts on the master group, not on one account, and Gemini
    // documents no `account` field for it. Sending one anyway would be inventing
    // a parameter — the exact failure mode this whole area has already produced
    // once, in the other direction.
    const { client, requests } = masterKeyClientWith(() => json([]));
    await client.listMasterGroupAccounts();
    expect(payloadWithoutNonce(requests[0]!)).toEqual({ request: "/v1/account/list" });
    expect(requests[0]!.payload).not.toHaveProperty("account");
  });

  it("pairs each display name with the nickname the API actually wants", async () => {
    // Gemini's own published example response, verbatim.
    const { client } = masterKeyClientWith(() =>
      json([
        {
          name: "Primary",
          account: "primary",
          type: "exchange",
          counterparty_id: "EMONNYXH",
          created: 1495127793000,
          status: "open",
        },
        {
          name: "My Custody Account",
          account: "my-custody-account",
          type: "custody",
          counterparty_id: null,
          created: 1565970772000,
          status: "open",
        },
      ]),
    );
    const outcome = await client.listMasterGroupAccounts();
    expect(isUsable(outcome)).toBe(true);
    if (isUsable(outcome)) {
      expect(outcome.value).toEqual([
        { name: "Primary", account: "primary", type: "exchange", status: "open" },
        {
          name: "My Custody Account",
          account: "my-custody-account",
          type: "custody",
          status: "open",
        },
      ]);
      // The two names are NOT the same value, and the second is the one to send.
      expect(outcome.value[0]!.name).not.toBe(outcome.value[0]!.account);
    }
  });

  it("refuses an account-level key that was given an account name", async () => {
    const requests: Recorded[] = [];
    const client = new GeminiClient({
      baseUrl: BASE,
      credentials: fakeCredentialProvider({ apiKey: "account-abc123" }),
      accountName: "primary",
      fetch: async (input) => {
        requests.push({
          url: new URL(input),
          method: "POST",
          headers: {},
          payload: undefined,
          bodyText: "",
        });
        return json([]);
      },
      now: () => AT,
    });

    const outcome = await client.getAccountBalances();
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.retryable).toBe(false);
      expect(outcome.message).toContain("AccountsOnGroupOnlyApi");
    }
    expect(requests).toHaveLength(0);
  });
});

describe("downtime classification", () => {
  it("classifies a thrown transport error as retryable transport (unknown effect)", async () => {
    const { client } = clientWith(() => {
      throw new TypeError("network down");
    });
    const outcome = await client.getAccountBalances();
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.kind).toBe("transport");
      expect(outcome.retryable).toBe(true);
    }
  });

  it("treats a {result:error} body on a 200 as the refusal it is", async () => {
    const { client } = clientWith(() => json({ result: "error", reason: "System", message: "busy" }));
    const outcome = await client.getAccountBalances();
    expect(outcome.ok).toBe(false);
  });

  it("classifies a 5xx as retryable transport", async () => {
    const { client } = clientWith(() => json({ result: "error", reason: "System", message: "x" }, { status: 502 }));
    const outcome = await client.getCurrentPrice("BTCUSD");
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.kind).toBe("transport");
  });

  it("uses the runtime's global fetch when none is injected", async () => {
    const stub = vi.fn(async () => json({ bid: "1", ask: "2", last: "1.5" }));
    vi.stubGlobal("fetch", stub);
    const client = new GeminiClient({
      baseUrl: BASE,
      credentials: fakeCredentialProvider(),
      now: () => AT,
    });
    const outcome = await client.getCurrentPrice("BTCUSD");
    expect(isUsable(outcome)).toBe(true);
    expect(stub).toHaveBeenCalledOnce();
  });
});

describe("listTradablePairs", () => {
  it("GETs /v1/symbols (unsigned) and upper-cases the returned names", async () => {
    const { client, requests } = clientWith((url) => {
      expect(url.pathname).toBe("/v1/symbols");
      return json(["btcusd", "ethusd", "ethbtc"]);
    });

    const outcome = await client.listTradablePairs();

    expect(isUsable(outcome)).toBe(true);
    if (isUsable(outcome)) expect(outcome.value).toEqual(["BTCUSD", "ETHUSD", "ETHBTC"]);
    expect(requests[0]!.method).toBe("GET");
    expect(requests[0]!.headers["X-GEMINI-SIGNATURE"]).toBeUndefined();
  });

  it("surfaces a transport failure as a non-usable outcome", async () => {
    const { client } = clientWith(() => json({ result: "error" }, { status: 503 }));
    const outcome = await client.listTradablePairs();
    expect(isUsable(outcome)).toBe(false);
  });
});

describe("getCandles", () => {
  // Gemini renders candle OHLCV as JSON NUMBERS, most-recent-first, and reports
  // only the open time. These rows are 1-minute candles around AT.
  const CANDLE_ROWS = [
    [AT, 43000.5, 43010, 42990, 43005.25, 1.5], // in-progress: closeTime AT+59999 > AT
    [AT - 60_000, 42980, 43001, 42950, 43000.5, 0.000784],
    [AT - 120_000, 42900, 42985, 42890, 42980, 2.0],
  ];

  it("GETs the public /v2/candles endpoint, unsigned, oldest-first", async () => {
    const { client, requests } = clientWith((url) => {
      expect(url.pathname).toBe("/v2/candles/btcusd/1m");
      return json(CANDLE_ROWS);
    });

    const outcome = await client.getCandles("BTCUSD", "1m");

    expect(isUsable(outcome)).toBe(true);
    if (isUsable(outcome)) {
      const candles = outcome.value;
      // Sorted ascending by open time despite Gemini sending newest-first.
      expect(candles.map((c) => c.openTime)).toEqual([AT - 120_000, AT - 60_000, AT]);
      // OHLCV came in as numbers and became Money via explicit rounding.
      expect(candles[2]!.close).toBe(m("43005.25"));
      expect(candles[1]!.volume).toBe(m("0.000784"));
      // Close time derived from open time + 1m - 1ms.
      expect(candles[0]!.closeTime).toBe(AT - 120_000 + 60_000 - 1);
      // The current candle has not closed; the two older ones have.
      expect(candles[2]!.closed).toBe(false);
      expect(candles[0]!.closed).toBe(true);
      expect(candles[1]!.closed).toBe(true);
    }
    expect(requests[0]!.method).toBe("GET");
    expect(requests[0]!.headers["X-GEMINI-SIGNATURE"]).toBeUndefined();
  });

  it("maps the longer intervals to Gemini's own spelling", async () => {
    const { client } = clientWith((url) => {
      expect(url.pathname).toBe("/v2/candles/btcusd/1hr");
      return json([]);
    });
    await client.getCandles("BTCUSD", "1h");
  });

  it("honours `since` by filtering locally to candles that close after it", async () => {
    const { client } = clientWith(() => json(CANDLE_ROWS));
    // closeTimes are AT-60001, AT-1, AT+59999. since = AT-30000 drops the oldest.
    const outcome = await client.getCandles("BTCUSD", "1m", AT - 30_000);
    expect(isUsable(outcome)).toBe(true);
    if (isUsable(outcome)) {
      expect(outcome.value.map((c) => c.openTime)).toEqual([AT - 60_000, AT]);
    }
  });

  it("surfaces a transport failure as a non-usable outcome", async () => {
    const { client } = clientWith(() => json([], { status: 503 }));
    const outcome = await client.getCandles("BTCUSD", "1m");
    expect(isUsable(outcome)).toBe(false);
  });
});
