import { describe, expect, it } from "vitest";
import { fromDecimalString as m, ZERO } from "../../shared/money";
import {
  classifyFailure,
  INVALID_NONCE_REASON,
  parseBalances,
  parseCancelledOrder,
  parseCandles,
  parseFills,
  parseOrderResult,
  parseOrderStatus,
  parseOrderStatusList,
  parsePrice,
  parseSymbolList,
  ParseError,
  readErrorBody,
  toOrderState,
} from "./parse";

const AT = 1_700_000_000_000;

/** A resting, unfilled order as `/v1/order/status` reports it. */
const RESTING_ORDER = {
  order_id: 1234567,
  id: "1234567",
  symbol: "btcusd",
  exchange: "gemini",
  avg_execution_price: "0.00",
  side: "buy",
  type: "exchange limit",
  timestamp: "1700000000",
  timestampms: 1_700_000_000_000,
  is_live: true,
  is_cancelled: false,
  is_hidden: false,
  was_forced: false,
  executed_amount: "0",
  remaining_amount: "0.001",
  original_amount: "0.001",
  price: "43210.56",
  client_order_id: "gemini-dca-btc-7",
};

describe("readErrorBody", () => {
  it("reads a Gemini error body keyed on result:error", () => {
    expect(
      readErrorBody({ result: "error", reason: "InvalidNonce", message: "Nonce too small" }),
    ).toEqual({ reason: "InvalidNonce", message: "Nonce too small" });
  });

  it("returns undefined for a success body", () => {
    expect(readErrorBody({ result: "ok", order_id: 1 })).toBeUndefined();
    expect(readErrorBody(RESTING_ORDER)).toBeUndefined();
  });

  it("returns undefined for a non-object", () => {
    expect(readErrorBody("nope")).toBeUndefined();
    expect(readErrorBody(null)).toBeUndefined();
  });
});

describe("classifyFailure", () => {
  it("lifts a stale nonce (a 4xx) to retryable, since a fresh nonce fixes it", () => {
    const outcome = classifyFailure(400, AT, {
      result: "error",
      reason: INVALID_NONCE_REASON,
      message: "Nonce is too small",
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.retryable).toBe(true);
    expect(outcome.message).toContain("InvalidNonce");
  });

  it("leaves an ordinary 4xx refusal non-retryable", () => {
    const outcome = classifyFailure(400, AT, {
      result: "error",
      reason: "InsufficientFunds",
      message: "Not enough balance",
    });
    expect(outcome.retryable).toBe(false);
  });

  it("keeps a 5xx as a retryable transport failure", () => {
    const outcome = classifyFailure(503, AT, undefined);
    expect(outcome.kind).toBe("transport");
    expect(outcome.retryable).toBe(true);
  });

  it("keeps a 429 rate-limit retryable", () => {
    const outcome = classifyFailure(429, AT, {
      result: "error",
      reason: "RateLimit",
      message: "slow down",
    });
    expect(outcome.retryable).toBe(true);
  });
});

describe("toOrderState", () => {
  it("cancelled wins, even with a partial fill", () => {
    expect(toOrderState(false, true, m("0.5"), m("1"))).toBe("cancelled");
  });

  it("live and nothing filled is pending", () => {
    expect(toOrderState(true, false, ZERO, m("1"))).toBe("pending");
  });

  it("live and partly filled is partially_filled", () => {
    expect(toOrderState(true, false, m("0.4"), m("1"))).toBe("partially_filled");
  });

  it("not live and not cancelled is filled", () => {
    expect(toOrderState(false, false, m("1"), m("1"))).toBe("filled");
  });
});

describe("parsePrice", () => {
  it("reads `last` as the current price and stamps receipt time", () => {
    const price = parsePrice("BTCUSD", { bid: "43000.0", ask: "43001.0", last: "43000.5" }, AT);
    expect(price).toEqual({ pair: "BTCUSD", price: m("43000.5"), at: AT });
  });

  it("rejects a numeric price rather than putting a float in the money path", () => {
    expect(() => parsePrice("BTCUSD", { last: 43000.5 }, AT)).toThrow(ParseError);
  });
});

describe("parseOrderStatus", () => {
  it("maps the boolean flags and identity of a resting order", () => {
    const status = parseOrderStatus(RESTING_ORDER);
    expect(status).toMatchObject({
      clientOrderId: "gemini-dca-btc-7",
      exchangeOrderId: "1234567",
      pair: "btcusd",
      side: "buy",
      price: m("43210.56"),
      quantity: m("0.001"),
      filledQuantity: ZERO,
      cumulativeQuoteQuantity: ZERO,
      state: "pending",
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
    });
    expect(status.fills).toBeUndefined();
  });

  it("derives cumulative quote value from avg price x executed amount", () => {
    const status = parseOrderStatus({
      ...RESTING_ORDER,
      is_live: true,
      executed_amount: "0.0005",
      avg_execution_price: "43000.00",
    });
    // 0.0005 * 43000 = 21.5
    expect(status.cumulativeQuoteQuantity).toBe(m("21.5"));
    expect(status.state).toBe("partially_filled");
  });

  it("attaches fills only when trades are included", () => {
    const status = parseOrderStatus({
      ...RESTING_ORDER,
      is_live: false,
      executed_amount: "0.001",
      avg_execution_price: "43000.00",
      trades: [
        {
          tid: 999,
          price: "43000.00",
          amount: "0.001",
          fee_amount: "0.43",
          fee_currency: "USD",
          timestampms: 1_700_000_000_500,
        },
      ],
    });
    expect(status.state).toBe("filled");
    expect(status.fills).toEqual([
      {
        fillId: "999",
        price: m("43000.00"),
        quantity: m("0.001"),
        feeAmount: m("0.43"),
        feeAsset: "USD",
        executedAt: 1_700_000_000_500,
      },
    ]);
  });

  it("accepts an order_id sent as a string", () => {
    expect(parseOrderStatus({ ...RESTING_ORDER, order_id: "77" }).exchangeOrderId).toBe("77");
  });

  it("rejects a numeric monetary field", () => {
    expect(() => parseOrderStatus({ ...RESTING_ORDER, price: 43210.56 })).toThrow(ParseError);
  });

  it("rejects an unknown side", () => {
    expect(() => parseOrderStatus({ ...RESTING_ORDER, side: "long" })).toThrow(ParseError);
  });
});

describe("parseCancelledOrder", () => {
  it("reads the same client_order_id (no Binance-style two-id trap) and uses receipt time", () => {
    const cancelled = parseCancelledOrder(
      { ...RESTING_ORDER, is_live: false, is_cancelled: true, executed_amount: "0.0004" },
      AT + 5000,
    );
    expect(cancelled.clientOrderId).toBe("gemini-dca-btc-7");
    expect(cancelled.state).toBe("cancelled");
    expect(cancelled.filledQuantity).toBe(m("0.0004"));
    // createdAt is available on Gemini's cancel; updatedAt is observation time.
    expect(cancelled.createdAt).toBe(1_700_000_000_000);
    expect(cancelled.updatedAt).toBe(AT + 5000);
  });
});

describe("parseOrderResult", () => {
  it("acknowledges a resting order with empty fills", () => {
    const result = parseOrderResult(RESTING_ORDER);
    expect(result).toEqual({
      clientOrderId: "gemini-dca-btc-7",
      exchangeOrderId: "1234567",
      pair: "btcusd",
      state: "pending",
      fills: [],
      acceptedAt: 1_700_000_000_000,
    });
  });
});

describe("parseOrderStatusList", () => {
  it("parses an array of orders", () => {
    const list = parseOrderStatusList([RESTING_ORDER, { ...RESTING_ORDER, client_order_id: "x" }]);
    expect(list).toHaveLength(2);
    expect(list[1]!.clientOrderId).toBe("x");
  });

  it("rejects a non-array", () => {
    expect(() => parseOrderStatusList({})).toThrow(ParseError);
  });
});

describe("parseFills", () => {
  it("returns [] for an absent trades field", () => {
    expect(parseFills(undefined)).toEqual([]);
    expect(parseFills(null)).toEqual([]);
  });

  it("carries the fee currency verbatim, never assuming the quote asset", () => {
    const fills = parseFills([
      {
        tid: 1,
        price: "100.0",
        amount: "2",
        fee_amount: "0.001",
        fee_currency: "BTC",
        timestampms: AT,
      },
    ]);
    expect(fills[0]!.feeAsset).toBe("BTC");
    expect(fills[0]!.feeAmount).toBe(m("0.001"));
  });
});

describe("parseBalances", () => {
  it("derives locked as amount minus available", () => {
    const balances = parseBalances([
      { type: "exchange", currency: "USD", amount: "1000.00", available: "600.00" },
      { type: "exchange", currency: "BTC", amount: "0.5", available: "0.5" },
    ]);
    expect(balances).toEqual([
      { asset: "USD", free: m("600.00"), locked: m("400.00") },
      { asset: "BTC", free: m("0.5"), locked: ZERO },
    ]);
  });

  it("refuses a negative reserved balance rather than clamping it", () => {
    expect(() =>
      parseBalances([{ currency: "USD", amount: "1.0", available: "2.0" }]),
    ).toThrow(ParseError);
  });

  it("rejects a non-array", () => {
    expect(() => parseBalances({})).toThrow(ParseError);
  });
});

describe("parseSymbolList", () => {
  it("upper-cases Gemini's lowercase symbols into this system's Pair convention", () => {
    // The inverse of toGeminiSymbol, which lowercases "BTCUSD" -> "btcusd".
    expect(parseSymbolList(["btcusd", "ethusd", "ethbtc"])).toEqual([
      "BTCUSD",
      "ETHUSD",
      "ETHBTC",
    ]);
  });

  it("skips a non-string or empty entry rather than throwing", () => {
    expect(parseSymbolList(["btcusd", "", 123, null, "ethusd"])).toEqual(["BTCUSD", "ETHUSD"]);
  });

  it("throws when the body is not an array (a real API change)", () => {
    expect(() => parseSymbolList({ symbols: [] })).toThrow(ParseError);
    expect(() => parseSymbolList(null)).toThrow(ParseError);
  });

  it("returns an empty list for an empty response", () => {
    expect(parseSymbolList([])).toEqual([]);
  });
});

describe("parseCandles", () => {
  const MIN = 60_000;

  it("parses number OHLCV rows into Money, oldest-first, with derived close/closed", () => {
    // Gemini sends newest-first; values are JSON numbers.
    const body = [
      [AT, 43000.5, 43010, 42990, 43005.25, 1.5],
      [AT - MIN, 42980, 43001, 42950, 43000.5, 0.000784],
    ];
    const candles = parseCandles("BTCUSD", body, AT, MIN);

    expect(candles.map((c) => c.openTime)).toEqual([AT - MIN, AT]);
    expect(candles[1]!.close).toBe(m("43005.25"));
    expect(candles[0]!.volume).toBe(m("0.000784"));
    expect(candles[1]!.closeTime).toBe(AT + MIN - 1);
    // The candle whose close time has passed at `at` is closed; the current one is not.
    expect(candles[0]!.closed).toBe(true);
    expect(candles[1]!.closed).toBe(false);
  });

  it("rounds a value with more than SCALE decimals explicitly (toFixed at the money boundary)", () => {
    const candles = parseCandles("BTCUSD", [[AT, 1.123456789, 1, 1, 1, 0]], AT, MIN);
    // 1.123456789 -> toFixed(8) -> "1.12345679".
    expect(candles[0]!.open).toBe(m("1.12345679"));
  });

  it("throws on a non-array body (a real API change)", () => {
    expect(() => parseCandles("BTCUSD", { changes: [] }, AT, MIN)).toThrow(ParseError);
  });

  it("throws on a malformed row rather than guessing", () => {
    expect(() => parseCandles("BTCUSD", [[AT, 1, 2, 3]], AT, MIN)).toThrow(ParseError);
    // A monetary field that is a string, not the number Gemini's candle feed sends.
    expect(() => parseCandles("BTCUSD", [[AT, "1", 2, 3, 4, 5]], AT, MIN)).toThrow(ParseError);
  });
});
