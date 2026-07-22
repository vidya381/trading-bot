import { describe, expect, it } from "vitest";
import { fromDecimalString as m, ZERO } from "../../shared/money";
import {
  classifyFailure,
  EXECUTION_STATUS_UNKNOWN_CODES,
  INVALID_TIMESTAMP_CODE,
  NO_SUCH_ORDER_CODE,
  ParseError,
  parseBalances,
  parseCancelledOrder,
  parseFills,
  parseOrderResult,
  parseOrderStatus,
  parseOrderStatusList,
  parsePrice,
  parseRequestWeightLimit,
  parseRetryAfterMs,
  parseServerTime,
  parseUsedWeight,
  readErrorBody,
  toOrderState,
} from "./parse";

const AT = 1_700_000_000_000;

/** The order-placement response for a fully filled limit order. */
function orderResultBody(overrides: Record<string, unknown> = {}) {
  return {
    symbol: "BTCUSDT",
    orderId: 28,
    orderListId: -1,
    clientOrderId: "v1-dca-btc-7",
    transactTime: 1507725176595,
    price: "43210.56000000",
    origQty: "0.00100000",
    executedQty: "0.00100000",
    origQuoteOrderQty: "0.000000",
    cummulativeQuoteQty: "43.21056000",
    status: "FILLED",
    timeInForce: "GTC",
    type: "LIMIT",
    side: "BUY",
    workingTime: 1507725176595,
    selfTradePreventionMode: "NONE",
    fills: [
      {
        price: "43210.56000000",
        qty: "0.00100000",
        commission: "0.00003200",
        commissionAsset: "BNB",
        tradeId: 56,
      },
    ],
    ...overrides,
  };
}

/** The order-status response, which carries no fills array. */
function orderStatusBody(overrides: Record<string, unknown> = {}) {
  return {
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
    stopPrice: "0.00000000",
    icebergQty: "0.00000000",
    time: 1499827319559,
    updateTime: 1499827319559,
    isWorking: true,
    workingTime: 1499827319559,
    origQuoteOrderQty: "0.000000",
    selfTradePreventionMode: "NONE",
    ...overrides,
  };
}

describe("parseUsedWeight", () => {
  it("reads the one-minute used-weight header", () => {
    const headers = new Headers({ "X-MBX-USED-WEIGHT-1M": "247" });

    expect(parseUsedWeight(headers)).toBe(247);
  });

  it("is case-insensitive about the header name", () => {
    expect(parseUsedWeight(new Headers({ "x-mbx-used-weight-1m": "12" }))).toBe(12);
  });

  it("ignores other intervals, which would misinform the one-minute budget", () => {
    // An hourly total fed into a 60-second window would look like a vastly
    // overspent minute and stall every request for a full window.
    const headers = new Headers({
      "X-MBX-USED-WEIGHT-1H": "9000",
      "X-MBX-USED-WEIGHT-1M": "42",
    });

    expect(parseUsedWeight(headers)).toBe(42);
  });

  it("returns undefined when only another interval is present", () => {
    expect(parseUsedWeight(new Headers({ "X-MBX-USED-WEIGHT-1H": "9000" }))).toBeUndefined();
  });

  it("can be asked for a different interval", () => {
    const headers = new Headers({ "X-MBX-USED-WEIGHT-5M": "500" });

    expect(parseUsedWeight(headers, { num: 5, unit: "m" })).toBe(500);
  });

  it("returns undefined when the header is absent", () => {
    expect(parseUsedWeight(new Headers())).toBeUndefined();
  });

  it("ignores an unparseable value rather than reporting NaN weight", () => {
    expect(parseUsedWeight(new Headers({ "X-MBX-USED-WEIGHT-1M": "lots" }))).toBeUndefined();
  });

  it("ignores the order-count header, which is not request weight", () => {
    expect(parseUsedWeight(new Headers({ "X-MBX-ORDER-COUNT-1M": "5" }))).toBeUndefined();
  });

  it("accepts a reported zero", () => {
    expect(parseUsedWeight(new Headers({ "X-MBX-USED-WEIGHT-1M": "0" }))).toBe(0);
  });
});

describe("parseRetryAfterMs", () => {
  it("converts the header from seconds to milliseconds", () => {
    expect(parseRetryAfterMs(new Headers({ "Retry-After": "30" }))).toBe(30_000);
  });

  it("returns undefined when absent or unparseable", () => {
    expect(parseRetryAfterMs(new Headers())).toBeUndefined();
    expect(parseRetryAfterMs(new Headers({ "Retry-After": "soon" }))).toBeUndefined();
  });
});

describe("readErrorBody", () => {
  it("reads the documented error shape", () => {
    expect(readErrorBody({ code: -1121, msg: "Invalid symbol." })).toStrictEqual({
      code: -1121,
      msg: "Invalid symbol.",
    });
  });

  it("tolerates a missing message", () => {
    expect(readErrorBody({ code: -1000 })).toStrictEqual({ code: -1000, msg: "" });
  });

  it("returns undefined for anything that is not an error body", () => {
    expect(readErrorBody(undefined)).toBeUndefined();
    expect(readErrorBody(null)).toBeUndefined();
    expect(readErrorBody({ serverTime: 1 })).toBeUndefined();
    expect(readErrorBody("not json")).toBeUndefined();
  });
});

describe("classifyFailure", () => {
  it("treats a 5xx as a transport failure, per section 5.6", () => {
    const outcome = classifyFailure(503, AT, undefined);

    expect(outcome.kind).toBe("transport");
    expect(outcome.retryable).toBe(true);
  });

  it("treats an ordinary 4xx as a refusal that will not change on retry", () => {
    const outcome = classifyFailure(400, AT, { code: -1121, msg: "Invalid symbol." });

    expect(outcome.kind).toBe("exchange_error");
    expect(outcome.retryable).toBe(false);
    expect(outcome.code).toBe(-1121);
    expect(outcome.message).toContain("Invalid symbol.");
  });

  it.each([...EXECUTION_STATUS_UNKNOWN_CODES])(
    "reclassifies code %i as transport, because the order's fate is unknown",
    (code) => {
      // These arrive with a 4xx-shaped body, which would otherwise read as a
      // definite "this did not happen". The exchange's own wording is
      // "execution status unknown", and an order may be resting on the book.
      const outcome = classifyFailure(400, AT, { code, msg: "unknown" });

      expect(outcome.kind).toBe("transport");
      expect(outcome.retryable).toBe(true);
    },
  );

  it("marks a busy server retryable despite its 4xx status", () => {
    const outcome = classifyFailure(400, AT, { code: -1008, msg: "Server is busy" });

    expect(outcome.retryable).toBe(true);
  });

  it("keeps a rate-limit response retryable", () => {
    expect(classifyFailure(429, AT, { code: -1003, msg: "Too many requests" }).retryable).toBe(
      true,
    );
  });

  it("keeps an invalid-timestamp rejection non-retryable as sent", () => {
    // Retrying the identical stale timestamp fails identically; the client
    // clears its offset and re-syncs instead.
    const outcome = classifyFailure(400, AT, {
      code: INVALID_TIMESTAMP_CODE,
      msg: "Timestamp for this request is outside of the recvWindow.",
    });

    expect(outcome.retryable).toBe(false);
    expect(outcome.code).toBe(INVALID_TIMESTAMP_CODE);
  });

  it("surfaces a missing-order code so recovery can act on it", () => {
    const outcome = classifyFailure(400, AT, {
      code: NO_SUCH_ORDER_CODE,
      msg: "Order does not exist.",
    });

    expect(outcome.code).toBe(NO_SUCH_ORDER_CODE);
    expect(outcome.retryable).toBe(false);
  });
});

describe("toOrderState", () => {
  it.each([
    ["NEW", "pending"],
    ["PENDING_NEW", "pending"],
    ["PARTIALLY_FILLED", "partially_filled"],
    ["FILLED", "filled"],
    ["CANCELED", "cancelled"],
    ["REJECTED", "rejected"],
    ["EXPIRED", "expired"],
    ["EXPIRED_IN_MATCH", "expired"],
  ])("maps %s to %s", (raw, expected) => {
    expect(toOrderState(raw, ZERO, m("1"))).toBe(expected);
  });

  it("spells cancelled with the exchange's single L on input", () => {
    // Guards the easiest possible typo: the exchange sends CANCELED.
    expect(toOrderState("CANCELED", ZERO, m("1"))).toBe("cancelled");
    expect(() => toOrderState("CANCELLED", ZERO, m("1"))).toThrow(ParseError);
  });

  it("does not report a pending cancel as cancelled", () => {
    // The order is still live and can still fill, so calling it cancelled would
    // let the bot free up capital it has not actually recovered.
    expect(toOrderState("PENDING_CANCEL", ZERO, m("1"))).toBe("pending");
  });

  it("resolves a partially filled pending cancel to its fill progress", () => {
    expect(toOrderState("PENDING_CANCEL", m("0.5"), m("1"))).toBe("partially_filled");
  });

  it("refuses to guess at an unrecognised status", () => {
    expect(() => toOrderState("SOMETHING_NEW", ZERO, m("1"))).toThrow(/refusing to guess/);
  });
});

describe("parseServerTime", () => {
  it("reads the documented body", () => {
    expect(parseServerTime({ serverTime: 1499827319559 })).toBe(1499827319559);
  });

  it("rejects a body without a server time", () => {
    expect(() => parseServerTime({})).toThrow(ParseError);
    expect(() => parseServerTime(null)).toThrow(ParseError);
  });
});

describe("parsePrice", () => {
  it("parses the price and stamps it with receipt time", () => {
    // The ticker carries no timestamp of its own.
    expect(parsePrice({ symbol: "LTCBTC", price: "4.00000200" }, AT)).toStrictEqual({
      pair: "LTCBTC",
      price: m("4.000002"),
      at: AT,
    });
  });

  it("refuses a numeric price rather than letting a float into Money", () => {
    expect(() => parsePrice({ symbol: "LTCBTC", price: 4.000002 }, AT)).toThrow(
      /refusing to convert a non-string into Money/,
    );
  });

  it("rejects a price with more precision than the money scale supports", () => {
    expect(() => parsePrice({ symbol: "X", price: "1.000000001" }, AT)).toThrow(ParseError);
  });
});

describe("parseFills", () => {
  it("maps commission onto the fee fields and stamps the parent's time", () => {
    const fills = parseFills(orderResultBody().fills, 1507725176595);

    expect(fills).toStrictEqual([
      {
        fillId: "56",
        price: m("43210.56"),
        quantity: m("0.001"),
        feeAmount: m("0.000032"),
        // Charged in BNB, not the quote currency: exactly what section 5.5
        // insists must never be assumed.
        feeAsset: "BNB",
        executedAt: 1507725176595,
      },
    ]);
  });

  it("gives every fill in one response the parent order's timestamp", () => {
    // Fill objects carry no time field at all, so this is inherited rather than
    // observed.
    const fills = parseFills(
      [
        { price: "1.0", qty: "1.0", commission: "0.1", commissionAsset: "USDT", tradeId: 1 },
        { price: "2.0", qty: "1.0", commission: "0.2", commissionAsset: "USDT", tradeId: 2 },
      ],
      AT,
    );

    expect(fills.map((fill) => fill.executedAt)).toStrictEqual([AT, AT]);
  });

  it("stringifies the numeric trade id so identity never depends on float precision", () => {
    const fills = parseFills(
      [{ price: "1.0", qty: "1.0", commission: "0", commissionAsset: "USDT", tradeId: 9876543 }],
      AT,
    );

    expect(fills[0]?.fillId).toBe("9876543");
  });

  it("treats an absent fills array as no fills", () => {
    expect(parseFills(undefined, AT)).toStrictEqual([]);
    expect(parseFills(null, AT)).toStrictEqual([]);
  });

  it("rejects a fills value that is not an array", () => {
    expect(() => parseFills({ price: "1" }, AT)).toThrow(ParseError);
  });

  it("names which fill failed to parse", () => {
    expect(() =>
      parseFills([{ price: "1.0", qty: "1.0", commissionAsset: "USDT", tradeId: 1 }], AT),
    ).toThrow(/fill 0.*commission/);
  });
});

describe("parseOrderResult", () => {
  it("parses a filled limit order with its fills", () => {
    const result = parseOrderResult(orderResultBody());

    expect(result).toStrictEqual({
      clientOrderId: "v1-dca-btc-7",
      exchangeOrderId: "28",
      pair: "BTCUSDT",
      state: "filled",
      fills: [
        {
          fillId: "56",
          price: m("43210.56"),
          quantity: m("0.001"),
          feeAmount: m("0.000032"),
          feeAsset: "BNB",
          executedAt: 1507725176595,
        },
      ],
      acceptedAt: 1507725176595,
    });
  });

  it("parses a resting order that has not filled", () => {
    const result = parseOrderResult(
      orderResultBody({ status: "NEW", executedQty: "0.00000000", fills: [] }),
    );

    expect(result.state).toBe("pending");
    expect(result.fills).toStrictEqual([]);
  });

  it("parses a partially filled acknowledgement", () => {
    const result = parseOrderResult(
      orderResultBody({ status: "PARTIALLY_FILLED", executedQty: "0.00050000" }),
    );

    expect(result.state).toBe("partially_filled");
  });

  it("treats a bare acknowledgement with no status as pending", () => {
    const result = parseOrderResult({
      symbol: "BTCUSDT",
      orderId: 28,
      orderListId: -1,
      clientOrderId: "v1-dca-btc-7",
      transactTime: 1507725176595,
    });

    expect(result.state).toBe("pending");
    expect(result.fills).toStrictEqual([]);
  });

  it("rejects a response with no transaction time", () => {
    const body = orderResultBody();
    delete (body as Record<string, unknown>)["transactTime"];

    expect(() => parseOrderResult(body)).toThrow(ParseError);
  });
});

describe("parseOrderStatus", () => {
  it("parses a resting order", () => {
    expect(parseOrderStatus(orderStatusBody())).toStrictEqual({
      clientOrderId: "v1-dca-btc-7",
      exchangeOrderId: "12345",
      pair: "BTCUSDT",
      side: "buy",
      price: m("43210.56"),
      quantity: m("0.001"),
      filledQuantity: ZERO,
      cumulativeQuoteQuantity: ZERO,
      state: "pending",
      createdAt: 1499827319559,
      updatedAt: 1499827319559,
    });
  });

  it("leaves fills absent rather than asserting there were none", () => {
    // The status endpoint reports no per-fill breakdown, so an empty array
    // would be a claim the payload does not support.
    const status = parseOrderStatus(
      orderStatusBody({ status: "PARTIALLY_FILLED", executedQty: "0.00050000" }),
    );

    expect(status.fills).toBeUndefined();
    expect("fills" in status).toBe(false);
  });

  it("keeps the cumulative quote quantity, the only route to an average price", () => {
    const status = parseOrderStatus(
      orderStatusBody({
        status: "FILLED",
        executedQty: "0.00100000",
        cummulativeQuoteQty: "43.21056000",
      }),
    );

    expect(status.cumulativeQuoteQuantity).toBe(m("43.21056"));
    expect(status.filledQuantity).toBe(m("0.001"));
  });

  it("reads the exchange's misspelled cumulative field name", () => {
    // The payload really does spell it "cummulativeQuoteQty".
    const body = orderStatusBody();
    delete (body as Record<string, unknown>)["cummulativeQuoteQty"];

    expect(() => parseOrderStatus(body)).toThrow(/cummulativeQuoteQty/);
  });

  it("maps both sides", () => {
    expect(parseOrderStatus(orderStatusBody({ side: "SELL" })).side).toBe("sell");
    expect(parseOrderStatus(orderStatusBody({ side: "BUY" })).side).toBe("buy");
  });

  it("rejects an unrecognised side", () => {
    expect(() => parseOrderStatus(orderStatusBody({ side: "HOLD" }))).toThrow(ParseError);
  });

  it("falls back to creation time when no update time is present", () => {
    const body = orderStatusBody();
    delete (body as Record<string, unknown>)["updateTime"];

    expect(parseOrderStatus(body).updatedAt).toBe(1499827319559);
  });

  it("rejects a non-object payload", () => {
    expect(() => parseOrderStatus(null)).toThrow(ParseError);
    expect(() => parseOrderStatus([])).toThrow(ParseError);
  });
});

describe("parseCancelledOrder", () => {
  /** The cancellation response, exactly as the exchange documents it. */
  function cancelBody(overrides: Record<string, unknown> = {}) {
    return {
      symbol: "BTCUSDT",
      origClientOrderId: "v1-dca-btc-7",
      orderId: 12345,
      orderListId: -1,
      clientOrderId: "cancel-request-generated-by-exchange",
      transactTime: 1684804350068,
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
      ...overrides,
    };
  }

  it("parses a cancellation into the same shape as any other order record", () => {
    expect(parseCancelledOrder(cancelBody())).toStrictEqual({
      clientOrderId: "v1-dca-btc-7",
      exchangeOrderId: "12345",
      pair: "BTCUSDT",
      side: "buy",
      price: m("43210.56"),
      quantity: m("0.001"),
      filledQuantity: ZERO,
      cumulativeQuoteQuantity: ZERO,
      state: "cancelled",
      updatedAt: 1684804350068,
    });
  });

  it("identifies the cancelled order, not the cancel request", () => {
    // The payload carries two client order ids. Reading the wrong one throws
    // nothing and returns a plausible string, so only a test catches it.
    const parsed = parseCancelledOrder(cancelBody());

    expect(parsed.clientOrderId).toBe("v1-dca-btc-7");
    expect(parsed.clientOrderId).not.toBe("cancel-request-generated-by-exchange");
  });

  it("keeps the filled quantity of a partially filled cancellation", () => {
    // The case section 7.2 exists for: a halt cancels a partially filled order
    // and the bot is left holding whatever had already executed.
    const parsed = parseCancelledOrder(
      cancelBody({ executedQty: "0.00060000", cummulativeQuoteQty: "25.92633600" }),
    );

    expect(parsed.filledQuantity).toBe(m("0.0006"));
    expect(parsed.cumulativeQuoteQuantity).toBe(m("25.926336"));
    // Still cancelled, not partially_filled: the exchange's own status wins.
    expect(parsed.state).toBe("cancelled");
  });

  it("omits createdAt rather than inventing it from the cancellation time", () => {
    const parsed = parseCancelledOrder(cancelBody());

    expect(parsed.createdAt).toBeUndefined();
    expect("createdAt" in parsed).toBe(false);
  });

  it("dates the record to when the cancel took effect", () => {
    const parsed = parseCancelledOrder(cancelBody({ transactTime: 1_700_000_009_999 }));

    expect(parsed.updatedAt).toBe(1_700_000_009_999);
  });

  it("handles a sell being cancelled", () => {
    expect(parseCancelledOrder(cancelBody({ side: "SELL" })).side).toBe("sell");
  });

  it("rejects a payload with no original client order id", () => {
    const body = cancelBody();
    delete (body as Record<string, unknown>)["origClientOrderId"];

    expect(() => parseCancelledOrder(body)).toThrow(/origClientOrderId/);
  });

  it("rejects a payload with no transaction time", () => {
    const body = cancelBody();
    delete (body as Record<string, unknown>)["transactTime"];

    expect(() => parseCancelledOrder(body)).toThrow(/transactTime/);
  });

  it("refuses a status-endpoint payload, which identifies orders differently", () => {
    // A guard against the two parsers being used interchangeably: the status
    // body has no origClientOrderId and no transactTime.
    expect(() => parseCancelledOrder(orderStatusBody())).toThrow(ParseError);
  });
});

describe("parseOrderStatusList", () => {
  it("parses every order in the array", () => {
    const orders = parseOrderStatusList([
      orderStatusBody(),
      orderStatusBody({ clientOrderId: "v1-dca-btc-8", orderId: 12346 }),
    ]);

    expect(orders.map((order) => order.clientOrderId)).toStrictEqual([
      "v1-dca-btc-7",
      "v1-dca-btc-8",
    ]);
  });

  it("parses an empty list", () => {
    expect(parseOrderStatusList([])).toStrictEqual([]);
  });

  it("rejects a non-array", () => {
    expect(() => parseOrderStatusList({})).toThrow(ParseError);
  });
});

describe("parseBalances", () => {
  it("parses the balances array", () => {
    const balances = parseBalances({
      makerCommission: 15,
      canTrade: true,
      balances: [
        { asset: "BTC", free: "4723846.89208129", locked: "0.00000000" },
        { asset: "USDT", free: "1000.50000000", locked: "250.00000000" },
      ],
      permissions: ["SPOT"],
    });

    expect(balances).toStrictEqual([
      { asset: "BTC", free: m("4723846.89208129"), locked: ZERO },
      { asset: "USDT", free: m("1000.5"), locked: m("250") },
    ]);
  });

  it("rejects an account payload with no balances array", () => {
    expect(() => parseBalances({ canTrade: true })).toThrow(ParseError);
  });

  it("names which balance failed to parse", () => {
    expect(() =>
      parseBalances({ balances: [{ asset: "BTC", free: "1.0", locked: 0 }] }),
    ).toThrow(/balance 0.*locked/);
  });
});

// ---------------------------------------------------------------------------
// The other half of section 5.4's "read from response headers and exchangeInfo"
// ---------------------------------------------------------------------------

describe("parseRequestWeightLimit", () => {
  /** An exchangeInfo body carries rateLimits alongside its symbols. */
  function body(rateLimits: unknown): unknown {
    return { timezone: "UTC", serverTime: 1_760_000_000_000, rateLimits, symbols: [] };
  }

  it("reads the REQUEST_WEIGHT limit and converts its interval to milliseconds", () => {
    expect(
      parseRequestWeightLimit(
        body([
          { rateLimitType: "REQUEST_WEIGHT", interval: "MINUTE", intervalNum: 1, limit: 6000 },
        ]),
      ),
    ).toEqual({ limit: 6000, windowMs: 60_000 });
  });

  it("multiplies the interval by intervalNum", () => {
    expect(
      parseRequestWeightLimit(
        body([
          { rateLimitType: "REQUEST_WEIGHT", interval: "SECOND", intervalNum: 10, limit: 50 },
        ]),
      ),
    ).toEqual({ limit: 50, windowMs: 10_000 });
  });

  it("ignores limits that are not about request weight", () => {
    // ORDERS limits are a different budget with a different meaning, and
    // spending one against the other would be wrong in both directions.
    expect(
      parseRequestWeightLimit(
        body([
          { rateLimitType: "ORDERS", interval: "SECOND", intervalNum: 10, limit: 100 },
          { rateLimitType: "RAW_REQUESTS", interval: "MINUTE", intervalNum: 5, limit: 61_000 },
        ]),
      ),
    ).toBeUndefined();
  });

  it("takes the SHORTEST window when several are published", () => {
    // The binding constraint over any burst, and the one `parseUsedWeight`
    // reports against. Pairing a per-minute usage figure with a per-day ceiling
    // would make a minute's traffic look like nothing at all.
    expect(
      parseRequestWeightLimit(
        body([
          { rateLimitType: "REQUEST_WEIGHT", interval: "DAY", intervalNum: 1, limit: 500_000 },
          { rateLimitType: "REQUEST_WEIGHT", interval: "MINUTE", intervalNum: 1, limit: 6000 },
        ]),
      ),
    ).toEqual({ limit: 6000, windowMs: 60_000 });
  });

  it("returns undefined rather than throwing on anything it cannot read", () => {
    // Deliberately lenient, unlike the order parsers. The caller already has a
    // valid exchangeInfo response it asked for in order to get symbol filters;
    // failing that request because a rate-limit block was shaped unexpectedly
    // would turn a budget refinement into an outage.
    expect(parseRequestWeightLimit(body(undefined))).toBeUndefined();
    expect(parseRequestWeightLimit({})).toBeUndefined();
    expect(parseRequestWeightLimit(null)).toBeUndefined();
    expect(
      parseRequestWeightLimit(
        body([{ rateLimitType: "REQUEST_WEIGHT", interval: "FORTNIGHT", intervalNum: 1, limit: 5 }]),
      ),
    ).toBeUndefined();
    expect(
      parseRequestWeightLimit(
        body([{ rateLimitType: "REQUEST_WEIGHT", interval: "MINUTE", intervalNum: 1, limit: 0 }]),
      ),
    ).toBeUndefined();
  });
});
