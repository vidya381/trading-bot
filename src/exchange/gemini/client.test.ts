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
