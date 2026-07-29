import { describe, expect, it } from "vitest";
import type { SymbolFilters } from "../../shared/exchange-client";
import { fromDecimalString as m, ZERO } from "../../shared/money";
import {
  DEFAULT_FILTER_MAX_AGE_MS,
  FilterError,
  parseExchangeInfo,
  parseSymbolFilters,
  parseTradablePairs,
  SymbolFilterCache,
  validateOrder,
} from "./filters";

const AT = 1_700_000_000_000;

/**
 * A symbol entry shaped exactly as `exchangeInfo` returns one, including the
 * filter types this code ignores, so the parser is exercised against realistic
 * noise rather than a trimmed-down ideal.
 */
function symbolEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    symbol: "BTCUSDT",
    status: "TRADING",
    baseAsset: "BTC",
    baseAssetPrecision: 8,
    quoteAsset: "USDT",
    quotePrecision: 8,
    quoteAssetPrecision: 8,
    orderTypes: ["LIMIT", "LIMIT_MAKER", "MARKET"],
    icebergAllowed: true,
    isSpotTradingAllowed: true,
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
      {
        filterType: "NOTIONAL",
        minNotional: "10.00000000",
        applyMinToMarket: true,
        maxNotional: "9000000.00000000",
        applyMaxToMarket: false,
        avgPriceMins: 5,
      },
      { filterType: "ICEBERG_PARTS", limit: 10 },
      {
        filterType: "PERCENT_PRICE_BY_SIDE",
        bidMultiplierUp: "5",
        bidMultiplierDown: "0.2",
        askMultiplierUp: "5",
        askMultiplierDown: "0.2",
        avgPriceMins: 1,
      },
      { filterType: "MAX_NUM_ORDERS", maxNumOrders: 200 },
    ],
    permissions: [],
    ...overrides,
  };
}

const FILTERS: SymbolFilters = parseSymbolFilters(symbolEntry(), AT);

describe("parseSymbolFilters", () => {
  it("reads the three filters that matter for a limit order", () => {
    expect(FILTERS).toStrictEqual({
      pair: "BTCUSDT",
      baseAsset: "BTC",
      quoteAsset: "USDT",
      status: "TRADING",
      tickSize: m("0.01"),
      minPrice: m("0.01"),
      maxPrice: m("1000000"),
      stepSize: m("0.00001"),
      minQuantity: m("0.00001"),
      maxQuantity: m("9000"),
      minNotional: m("10"),
      maxNotional: m("9000000"),
      fetchedAt: AT,
    });
  });

  it("ignores filter types it does not use rather than rejecting the symbol", () => {
    // ICEBERG_PARTS, PERCENT_PRICE_BY_SIDE and MAX_NUM_ORDERS are all present
    // above; the exchange adds new ones over time and an unknown one is not a
    // reason to refuse to trade.
    expect(FILTERS.pair).toBe("BTCUSDT");
  });

  it("reads the legacy notional filter, which has a floor but no ceiling", () => {
    const filters = parseSymbolFilters(
      symbolEntry({
        filters: [
          {
            filterType: "MIN_NOTIONAL",
            minNotional: "0.00100000",
            applyToMarket: true,
            avgPriceMins: 5,
          },
        ],
      }),
      AT,
    );

    expect(filters.minNotional).toBe(m("0.001"));
    expect(filters.maxNotional).toBe(ZERO);
  });

  it("prefers the current notional filter when a symbol somehow carries both", () => {
    const filters = parseSymbolFilters(
      symbolEntry({
        filters: [
          { filterType: "MIN_NOTIONAL", minNotional: "0.00100000" },
          { filterType: "NOTIONAL", minNotional: "10.00000000", maxNotional: "500.00000000" },
        ],
      }),
      AT,
    );

    expect(filters.minNotional).toBe(m("10"));
    expect(filters.maxNotional).toBe(m("500"));
  });

  it("treats every absent filter as a disabled bound", () => {
    const filters = parseSymbolFilters(symbolEntry({ filters: [] }), AT);

    expect(filters.tickSize).toBe(ZERO);
    expect(filters.minPrice).toBe(ZERO);
    expect(filters.maxPrice).toBe(ZERO);
    expect(filters.stepSize).toBe(ZERO);
    expect(filters.minNotional).toBe(ZERO);
    expect(filters.maxNotional).toBe(ZERO);
  });

  it("handles a symbol with no filters key at all", () => {
    const entry = symbolEntry();
    delete entry["filters"];

    expect(parseSymbolFilters(entry, AT).tickSize).toBe(ZERO);
  });

  it.each(["TRADING", "END_OF_DAY", "HALT", "BREAK", "CANCEL_ONLY"])(
    "accepts the documented status %s",
    (status) => {
      expect(parseSymbolFilters(symbolEntry({ status }), AT).status).toBe(status);
    },
  );

  it("refuses to guess about an unrecognised status", () => {
    expect(() => parseSymbolFilters(symbolEntry({ status: "SOMETHING_NEW" }), AT)).toThrow(
      FilterError,
    );
    expect(() => parseSymbolFilters(symbolEntry({ status: "SOMETHING_NEW" }), AT)).toThrow(
      /refusing to guess/,
    );
  });

  it("rejects a symbol entry with no name", () => {
    expect(() => parseSymbolFilters({ status: "TRADING" }, AT)).toThrow(FilterError);
  });

  it("rejects a symbol missing its assets", () => {
    const entry = symbolEntry();
    delete entry["quoteAsset"];

    expect(() => parseSymbolFilters(entry, AT)).toThrow(/baseAsset or quoteAsset/);
  });

  it("rejects a numeric filter value rather than coercing it into Money", () => {
    expect(() =>
      parseSymbolFilters(
        symbolEntry({
          filters: [{ filterType: "PRICE_FILTER", tickSize: 0.01 }],
        }),
        AT,
      ),
    ).toThrow(/decimal string/);
  });

  it("reports which field failed to parse", () => {
    expect(() =>
      parseSymbolFilters(
        symbolEntry({
          filters: [{ filterType: "LOT_SIZE", stepSize: "not-a-number" }],
        }),
        AT,
      ),
    ).toThrow(/stepSize/);
  });
});

describe("parseExchangeInfo", () => {
  it("parses every symbol in the response", () => {
    const filters = parseExchangeInfo(
      {
        timezone: "UTC",
        serverTime: AT,
        symbols: [symbolEntry(), symbolEntry({ symbol: "ETHUSDT", baseAsset: "ETH" })],
      },
      AT,
    );

    expect(filters.map((entry) => entry.pair)).toStrictEqual(["BTCUSDT", "ETHUSDT"]);
  });

  it("rejects a response with no symbols array", () => {
    expect(() => parseExchangeInfo({ timezone: "UTC" }, AT)).toThrow(FilterError);
  });
});

describe("validateOrder: rounding at construction", () => {
  it("rounds a buy price down to the tick", () => {
    const result = validateOrder(
      { pair: "BTCUSDT", side: "buy", price: m("43210.567"), quantity: m("0.001") },
      FILTERS,
    );

    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.price).toBe(m("43210.56"));
      expect(result.adjusted).toBe(true);
    }
  });

  it("rounds a sell price up to the tick", () => {
    const result = validateOrder(
      { pair: "BTCUSDT", side: "sell", price: m("43210.561"), quantity: m("0.001") },
      FILTERS,
    );

    if (result.valid) expect(result.price).toBe(m("43210.57"));
  });

  it("rounds quantity down on a buy", () => {
    const result = validateOrder(
      { pair: "BTCUSDT", side: "buy", price: m("43210"), quantity: m("0.00123456") },
      FILTERS,
    );

    expect(result.valid).toBe(true);
    if (result.valid) expect(result.quantity).toBe(m("0.00123"));
  });

  it("rounds quantity down on a sell too, never up", () => {
    // Rounding a quantity up can exceed the held balance and get the whole
    // order rejected, so the direction does not depend on side.
    const result = validateOrder(
      { pair: "BTCUSDT", side: "sell", price: m("43210"), quantity: m("0.00123456") },
      FILTERS,
    );

    expect(result.valid).toBe(true);
    if (result.valid) expect(result.quantity).toBe(m("0.00123"));
  });

  it("reports adjusted=false when nothing needed rounding", () => {
    const result = validateOrder(
      { pair: "BTCUSDT", side: "buy", price: m("43210.56"), quantity: m("0.001") },
      FILTERS,
    );

    expect(result.valid).toBe(true);
    if (result.valid) expect(result.adjusted).toBe(false);
  });

  it("computes the notional from the rounded values", () => {
    const result = validateOrder(
      { pair: "BTCUSDT", side: "buy", price: m("50000.004"), quantity: m("0.001") },
      FILTERS,
    );

    if (result.valid) {
      expect(result.price).toBe(m("50000"));
      expect(result.notional).toBe(m("50"));
    }
  });

  it("is idempotent: re-validating its own output changes nothing", () => {
    const first = validateOrder(
      { pair: "BTCUSDT", side: "buy", price: m("43210.567"), quantity: m("0.00123456") },
      FILTERS,
    );

    expect(first.valid).toBe(true);
    if (!first.valid) return;

    const second = validateOrder(
      { pair: "BTCUSDT", side: "buy", price: first.price, quantity: first.quantity },
      FILTERS,
    );

    expect(second.valid).toBe(true);
    if (second.valid) {
      expect(second.price).toBe(first.price);
      expect(second.quantity).toBe(first.quantity);
      expect(second.adjusted).toBe(false);
    }
  });
});

describe("validateOrder: rejections", () => {
  const order = (overrides: Partial<{ side: "buy" | "sell"; price: bigint; quantity: bigint }> = {}) => ({
    pair: "BTCUSDT" as const,
    side: overrides.side ?? ("buy" as const),
    price: overrides.price ?? m("43210"),
    quantity: overrides.quantity ?? m("0.001"),
  });

  it("refuses to place an order on a halted symbol", () => {
    const halted = parseSymbolFilters(symbolEntry({ status: "HALT" }), AT);
    const result = validateOrder(order(), halted);

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.code).toBe("symbol_not_trading");
      expect(result.reason).toContain("HALT");
    }
  });

  it.each(["END_OF_DAY", "BREAK", "CANCEL_ONLY"])(
    "refuses on a symbol that is %s",
    (status) => {
      const filters = parseSymbolFilters(symbolEntry({ status }), AT);
      const result = validateOrder(order(), filters);

      expect(result.valid).toBe(false);
    },
  );

  it("rejects a non-positive price before doing anything else", () => {
    const result = validateOrder(order({ price: ZERO }), FILTERS);

    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.code).toBe("non_positive_input");
  });

  it("rejects a negative quantity", () => {
    const result = validateOrder(order({ quantity: m("-1") }), FILTERS);

    if (!result.valid) expect(result.code).toBe("non_positive_input");
  });

  it("distinguishes a quantity that rounded away to nothing", () => {
    // Below one step, so flooring takes it to zero. Reported as its own cause
    // rather than as "below minimum", which would suggest a different fix.
    const result = validateOrder(order({ quantity: m("0.000001") }), FILTERS);

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.code).toBe("rounded_to_zero");
      expect(result.reason).toContain("quantity=0");
      expect(result.quantity).toBe(ZERO);
    }
  });

  it("rejects a notional below the symbol's minimum, per section 4.3", () => {
    // 43210 x 0.0001 = 4.32, below the 10 minimum.
    const result = validateOrder(order({ quantity: m("0.0001") }), FILTERS);

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.code).toBe("notional_below_min");
      expect(result.reason).toContain("skipped, not sent");
    }
  });

  it("rejects a notional above the symbol's maximum", () => {
    // 1001 x 9000 = 9,009,000, just past the 9,000,000 ceiling, while staying
    // inside both the price and quantity bounds.
    const result = validateOrder(
      order({ price: m("1001"), quantity: m("9000") }),
      FILTERS,
    );

    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.code).toBe("notional_above_max");
  });

  it("rejects a price below the minimum", () => {
    // minPrice is raised above the tick so a price can sit on the grid and
    // still be under the floor; with the default filters, flooring to the tick
    // would take it to zero first and report a different cause.
    const filters = {
      ...FILTERS,
      minPrice: m("1"),
      minNotional: ZERO,
      minQuantity: ZERO,
    };
    const result = validateOrder(order({ price: m("0.5") }), filters);

    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.code).toBe("price_below_min");
  });

  it("rejects a price above the maximum", () => {
    const result = validateOrder(order({ price: m("2000000") }), FILTERS);

    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.code).toBe("price_above_max");
  });

  it("rejects a quantity below the minimum", () => {
    const filters = { ...FILTERS, minQuantity: m("1"), minNotional: ZERO };
    const result = validateOrder(order({ quantity: m("0.5") }), filters);

    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.code).toBe("quantity_below_min");
  });

  it("rejects a quantity above the maximum", () => {
    const filters = { ...FILTERS, maxNotional: ZERO };
    const result = validateOrder(order({ quantity: m("9001") }), filters);

    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.code).toBe("quantity_above_max");
  });

  it("carries the failing values so the skip can be logged with numbers", () => {
    const result = validateOrder(order({ quantity: m("0.0001") }), FILTERS);

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.price).toBe(m("43210"));
      expect(result.quantity).toBe(m("0.0001"));
      expect(result.notional).toBe(m("4.321"));
    }
  });

  it("throws if the filters are for a different pair", () => {
    expect(() =>
      validateOrder({ ...order(), pair: "ETHUSDT" }, FILTERS),
    ).toThrow(FilterError);
  });
});

describe("validateOrder: the second, independent check before sending", () => {
  it("accepts values already on the grid without changing them", () => {
    const result = validateOrder(
      { pair: "BTCUSDT", side: "buy", price: m("43210.56"), quantity: m("0.001") },
      FILTERS,
      { rounding: "verify" },
    );

    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.price).toBe(m("43210.56"));
      expect(result.adjusted).toBe(false);
    }
  });

  it("reports an off-tick price instead of silently repairing it", () => {
    const result = validateOrder(
      { pair: "BTCUSDT", side: "buy", price: m("43210.567"), quantity: m("0.001") },
      FILTERS,
      { rounding: "verify" },
    );

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.code).toBe("price_off_tick");
      // The whole point of a second check is to surface a value that changed
      // after being rounded, not to round it again.
      expect(result.reason).toContain("altered after being rounded");
    }
  });

  it("reports an off-step quantity", () => {
    const result = validateOrder(
      { pair: "BTCUSDT", side: "buy", price: m("43210.56"), quantity: m("0.0010001") },
      FILTERS,
      { rounding: "verify" },
    );

    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.code).toBe("quantity_off_step");
  });

  it("still enforces the notional and status rules in verify mode", () => {
    const result = validateOrder(
      { pair: "BTCUSDT", side: "buy", price: m("43210.56"), quantity: m("0.0001") },
      FILTERS,
      { rounding: "verify" },
    );

    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.code).toBe("notional_below_min");
  });
});

describe("validateOrder: disabled bounds", () => {
  it("treats a zero tick size as no tick rule rather than a zero step", () => {
    // roundToStep rejects a non-positive step, so a naive implementation throws
    // here instead of accepting the price unchanged.
    const filters: SymbolFilters = { ...FILTERS, tickSize: ZERO };
    const result = validateOrder(
      { pair: "BTCUSDT", side: "buy", price: m("43210.5678"), quantity: m("0.001") },
      filters,
    );

    expect(result.valid).toBe(true);
    if (result.valid) expect(result.price).toBe(m("43210.5678"));
  });

  it("treats a zero step size as no quantity grid", () => {
    const filters: SymbolFilters = { ...FILTERS, stepSize: ZERO };
    const result = validateOrder(
      { pair: "BTCUSDT", side: "buy", price: m("43210"), quantity: m("0.0012345") },
      filters,
    );

    expect(result.valid).toBe(true);
    if (result.valid) expect(result.quantity).toBe(m("0.0012345"));
  });

  it("treats a zero maximum price as no ceiling, not a ceiling of zero", () => {
    const filters: SymbolFilters = { ...FILTERS, maxPrice: ZERO, maxNotional: ZERO };
    const result = validateOrder(
      { pair: "BTCUSDT", side: "buy", price: m("99999999"), quantity: m("0.001") },
      filters,
    );

    expect(result.valid).toBe(true);
  });

  it("treats a zero minimum notional as no floor", () => {
    const filters: SymbolFilters = { ...FILTERS, minNotional: ZERO };
    const result = validateOrder(
      { pair: "BTCUSDT", side: "buy", price: m("43210"), quantity: m("0.00001") },
      filters,
    );

    expect(result.valid).toBe(true);
  });

  it("passes verify mode when both grids are disabled", () => {
    const filters: SymbolFilters = { ...FILTERS, tickSize: ZERO, stepSize: ZERO };
    const result = validateOrder(
      { pair: "BTCUSDT", side: "buy", price: m("43210.5678"), quantity: m("0.0012345") },
      filters,
      { rounding: "verify" },
    );

    expect(result.valid).toBe(true);
  });
});

describe("SymbolFilterCache", () => {
  it("returns filters that are still fresh", () => {
    const cache = new SymbolFilterCache();
    cache.put(FILTERS);

    expect(cache.get("BTCUSDT", AT + 1000)).toBe(FILTERS);
  });

  it("returns undefined for a pair it has never seen", () => {
    expect(new SymbolFilterCache().get("BTCUSDT", AT)).toBeUndefined();
  });

  it("withholds filters once they are stale, so section 4.3's refresh happens", () => {
    const cache = new SymbolFilterCache({ maxAgeMs: 1000 });
    cache.put(FILTERS);

    expect(cache.get("BTCUSDT", AT + 999)).toBe(FILTERS);
    expect(cache.get("BTCUSDT", AT + 1000)).toBeUndefined();
  });

  it("peek returns a stale entry, so using one is always deliberate", () => {
    const cache = new SymbolFilterCache({ maxAgeMs: 1000 });
    cache.put(FILTERS);

    expect(cache.get("BTCUSDT", AT + 5000)).toBeUndefined();
    expect(cache.peek("BTCUSDT")).toBe(FILTERS);
  });

  it("reports staleness directly", () => {
    const cache = new SymbolFilterCache({ maxAgeMs: 1000 });

    expect(cache.isStale(FILTERS, AT + 999)).toBe(false);
    expect(cache.isStale(FILTERS, AT + 1001)).toBe(true);
  });

  it("invalidates one pair or all of them", () => {
    const cache = new SymbolFilterCache();
    const eth = { ...FILTERS, pair: "ETHUSDT" };
    cache.put(FILTERS);
    cache.put(eth);

    cache.invalidate("BTCUSDT");
    expect(cache.get("BTCUSDT", AT)).toBeUndefined();
    expect(cache.get("ETHUSDT", AT)).toBe(eth);

    cache.invalidate();
    expect(cache.get("ETHUSDT", AT)).toBeUndefined();
  });

  it("uses an hour by default", () => {
    expect(new SymbolFilterCache().maxAgeMs).toBe(DEFAULT_FILTER_MAX_AGE_MS);
  });

  it("rejects a non-positive max age", () => {
    expect(() => new SymbolFilterCache({ maxAgeMs: 0 })).toThrow(FilterError);
  });
});

describe("parseTradablePairs", () => {
  it("returns only the names of TRADING symbols", () => {
    const body = {
      symbols: [
        { symbol: "BTCUSDT", status: "TRADING" },
        { symbol: "ETHUSDT", status: "TRADING" },
        { symbol: "LUNAUSDT", status: "HALT" },
        { symbol: "OLDUSDT", status: "BREAK" },
      ],
    };
    expect(parseTradablePairs(body)).toEqual(["BTCUSDT", "ETHUSDT"]);
  });

  it("skips a nameless or malformed entry rather than throwing", () => {
    const body = {
      symbols: [
        { symbol: "BTCUSDT", status: "TRADING" },
        { status: "TRADING" }, // no symbol
        null,
        "nonsense",
        { symbol: "", status: "TRADING" },
        { symbol: "ETHUSDT", status: "TRADING" },
      ],
    };
    expect(parseTradablePairs(body)).toEqual(["BTCUSDT", "ETHUSDT"]);
  });

  it("throws only when the top-level symbols array is absent (a real API change)", () => {
    expect(() => parseTradablePairs({})).toThrow(FilterError);
    expect(() => parseTradablePairs(null)).toThrow(FilterError);
  });

  it("returns an empty list when nothing is TRADING", () => {
    expect(parseTradablePairs({ symbols: [{ symbol: "X", status: "HALT" }] })).toEqual([]);
  });
});
