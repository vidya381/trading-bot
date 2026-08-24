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
    });
    expect(status.fills).toBeUndefined();
  });

  it("OMITS updatedAt entirely, rather than echoing creation time back as one", () => {
    // THE ASSERTION THAT FLIPPED. This used to read
    // `updatedAt: 1_700_000_000_000` -- the same value as `createdAt`, because
    // the parser fabricated one to satisfy the type. Gemini sends no last-update
    // time, and reconciliation's terminated-order tolerance computes
    // `at - updatedAt`: fed creation time it measured the order's TOTAL AGE, so
    // the tolerance never applied to any Gemini order older than sixty seconds.
    const status = parseOrderStatus(RESTING_ORDER);

    expect(status.updatedAt).toBeUndefined();
    // THE KEY IS ABSENT, not present-and-undefined. Asserted separately because
    // the two are different facts and only this one survives a JSON round trip
    // into a Durable Object or an audit row.
    expect("updatedAt" in status).toBe(false);
    // And `createdAt` is still reported, so this is a refusal to invent a value
    // rather than a loss of the one Gemini really does send.
    expect(status.createdAt).toBe(1_700_000_000_000);
  });

  it("still omits updatedAt on the captured live payload, fills and all", () => {
    // Against the REAL field set rather than a hand-written fixture, and with
    // trades present -- because `max(trades[].timestampms)` is a real exchange
    // time and the deliberate decision was NOT to derive `updatedAt` from it
    // (it covers a fill-termination and not a cancel or expiry with no fills).
    const withTrades = {
      ...CAPTURED_WRAPPED_STATUS[0],
      is_live: false,
      executed_amount: "0.00077893",
      avg_execution_price: "64190.42",
      trades: [
        {
          tid: 99,
          price: "64190.42",
          amount: "0.00077893",
          fee_amount: "0.01",
          fee_currency: "USD",
          timestampms: 1_785_484_999_999,
        },
      ],
    };

    const status = parseOrderStatus(withTrades);

    expect(status.state).toBe("filled");
    expect(status.fills).toHaveLength(1);
    expect(status.fills![0]!.executedAt).toBe(1_785_484_999_999);
    expect("updatedAt" in status).toBe(false);
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

  // -------------------------------------------------------------------------
  // Regression: the live 11-decimal balance that made the account unreadable
  // -------------------------------------------------------------------------

  it("accepts the REAL 11-decimal balance Gemini returned on 2026-07-31", () => {
    // Not a synthetic example. This is the exact string from the incident: the
    // strict parser threw `has 11 decimal places, more than the supported 8`,
    // no balance snapshot could be written, and the account was unobservable.
    const balances = parseBalances([
      {
        type: "exchange",
        currency: "USD",
        amount: "99829.54180779832",
        available: "99829.54180779832",
      },
    ]);

    // Truncated toward zero at 8 places: ...54180779|832 -> ...54180779.
    expect(balances).toEqual([
      { asset: "USD", free: m("99829.54180779"), locked: ZERO },
    ]);
  });

  it("rounds a reported balance DOWN, never up", () => {
    // Direction matters more than magnitude here: rounding up would overstate
    // the account by up to 1e-8 and let the capital ledger believe in money
    // that is not there. Down can only ever be over-cautious.
    const balances = parseBalances([
      { currency: "BTC", amount: "1.999999999", available: "1.999999999" },
    ]);
    expect(balances[0]!.free).toBe(m("1.99999999"));
    expect(balances[0]!.free).toBeLessThan(m("2"));
  });

  it("keeps locked correct when both fields are rounded", () => {
    // `locked = amount - available`, so both operands must round the same way
    // or the derived figure drifts. Rounding both down keeps the difference
    // within one unit and can never make it negative when amount >= available.
    const balances = parseBalances([
      { currency: "ETH", amount: "10.123456789123", available: "4.987654321987" },
    ]);
    expect(balances[0]!.free).toBe(m("4.98765432"));
    expect(balances[0]!.locked).toBe(m("10.12345678") - m("4.98765432"));
    expect(balances[0]!.locked).toBeGreaterThan(ZERO);
  });

  it("still refuses a genuinely malformed balance string", () => {
    // The rounding policy must not become a general-purpose "accept anything".
    expect(() =>
      parseBalances([{ currency: "USD", amount: "not-a-number", available: "1.0" }]),
    ).toThrow(ParseError);
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

describe("shape errors name the real shape", () => {
  it("says ARRAY, not 'got object', when handed an array", () => {
    // The message that halted both bots on 2026-07-31 read:
    //   "order status: expected an object, got object"
    // because `typeof []` is "object". It named nothing actionable. An array is
    // exactly what Gemini returned, so the message has to say so.
    // Asserted through `parsePrice`, whose pubticker payload is a single object
    // with no wrapped form -- `parseOrderStatus` now legitimately UNWRAPS a
    // one-element array, so it is no longer the right subject for this.
    let message = "";
    try {
      parsePrice("BTCUSD", [{ bid: "1", ask: "2", last: "1.5" }], AT);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("pubticker");
    expect(message).toContain("array of 1");
    expect(message).not.toContain("got object");
    // And it lists the keys, so the correct parse can be written from the alert.
    expect(message).toContain("bid");
    expect(message).toContain("last");
  });

  it("distinguishes null from an object", () => {
    // `typeof null` is also "object" -- the same trap, one layer along.
    expect(() => parsePrice("BTCUSD", null, AT)).toThrow(/got null/);
  });

  it("describes an empty array without inventing a first element", () => {
    expect(() => parsePrice("BTCUSD", [], AT)).toThrow(/an empty array/);
  });

  it("still names a plain scalar correctly", () => {
    expect(() => parsePrice("BTCUSD", "nope", AT)).toThrow(/got a string/);
  });
});

// ---------------------------------------------------------------------------
// Regression: /v1/order/status returning a ONE-ELEMENT ARRAY (2026-07-31)
// ---------------------------------------------------------------------------

/**
 * The exact key set captured from the live sandbox during the incident, read
 * off the alert text the improved shape message produced:
 *
 *   "expected a single object, got an array of 1 whose first element has keys
 *    [avg_execution_price, client_order_id, exchange, executed_amount, id,
 *     is_cancelled, is_hidden, is_live, options, order_id, original_amount,
 *     price, remaining_amount, side, symbol, timestamp, timestampms, trades,
 *     type, was_forced]"
 *
 * Keys are the real ones; values are representative of a resting buy.
 */
const CAPTURED_WRAPPED_STATUS = [
  {
    avg_execution_price: "0.00",
    client_order_id: "v1-bot-b23y63-1",
    exchange: "gemini",
    executed_amount: "0",
    id: "73798699082135660",
    is_cancelled: false,
    is_hidden: false,
    is_live: true,
    options: [],
    order_id: "73798699082135660",
    original_amount: "0.00077893",
    price: "64190.42",
    remaining_amount: "0.00077893",
    side: "buy",
    symbol: "btcusd",
    timestamp: "1785484088",
    timestampms: 1_785_484_088_705,
    trades: [],
    type: "exchange limit",
    was_forced: false,
  },
];

describe("parseOrderStatus accepts Gemini's real wrapped shape", () => {
  it("unwraps the captured one-element array from the live incident", () => {
    // This exact payload shape halted both bots. It must now parse.
    const status = parseOrderStatus(CAPTURED_WRAPPED_STATUS);
    expect(status.clientOrderId).toBe("v1-bot-b23y63-1");
    expect(status.exchangeOrderId).toBe("73798699082135660");
    expect(status.price).toBe(m("64190.42"));
    expect(status.quantity).toBe(m("0.00077893"));
    expect(status.state).toBe("pending");
  });

  it("parses the wrapped and unwrapped forms identically", () => {
    // Gemini's reference documents a bare object and it does return one for
    // some requests, so both shapes must work -- not one swapped for the other.
    expect(parseOrderStatus(CAPTURED_WRAPPED_STATUS)).toEqual(
      parseOrderStatus(CAPTURED_WRAPPED_STATUS[0]),
    );
  });

  it("carries an empty trades array through as no fills", () => {
    // `trades: []` is present in the captured keys. An empty array must not be
    // read as "no executions asserted" incorrectly -- it is an explicit empty.
    expect(parseOrderStatus(CAPTURED_WRAPPED_STATUS).fills).toEqual([]);
  });

  it("REFUSES an empty array instead of calling it 'no such order'", () => {
    // The dangerous silent success. An order that exists but cannot be found is
    // exactly what section 9 exists to catch.
    expect(() => parseOrderStatus([])).toThrow(/no order matched/);
  });

  it("REFUSES more than one order rather than picking the first", () => {
    expect(() =>
      parseOrderStatus([CAPTURED_WRAPPED_STATUS[0], CAPTURED_WRAPPED_STATUS[0]]),
    ).toThrow(/ambiguous/);
  });

  it("applies the same unwrap to a cancelled-order payload", () => {
    const cancelled = parseCancelledOrder(
      [{ ...CAPTURED_WRAPPED_STATUS[0], is_live: false, is_cancelled: true }],
      AT,
    );
    expect(cancelled.state).toBe("cancelled");
    expect(cancelled.clientOrderId).toBe("v1-bot-b23y63-1");
  });
});
