import { describe, expect, it } from "vitest";
import { fromDecimalString as m, ZERO } from "../../shared/money";
import {
  FilterError,
  parseSymbolDetails,
  toGeminiSymbol,
  validateOrder,
} from "./filters";

const AT = 1_700_000_000_000;

/** The BTCUSD sample from Gemini's own reference, verbatim shapes. */
const BTCUSD_DETAILS = {
  symbol: "BTCUSD",
  base_currency: "BTC",
  quote_currency: "USD",
  tick_size: 1e-8, // base-currency increment  -> our stepSize (quantity)
  quote_increment: 0.01, // quote-currency increment -> our tickSize (price)
  min_order_size: "0.00001", // a STRING, unlike the two above
  status: "open",
  wrap_enabled: false,
};

describe("parseSymbolDetails", () => {
  it("applies the field-name inversion: tick_size->stepSize, quote_increment->tickSize", () => {
    const filters = parseSymbolDetails(BTCUSD_DETAILS, AT);
    expect(filters.stepSize).toBe(m("0.00000001")); // from tick_size 1e-8
    expect(filters.tickSize).toBe(m("0.01")); // from quote_increment 0.01
    expect(filters.minQuantity).toBe(m("0.00001")); // from min_order_size
  });

  it("converts a scientific-notation numeric increment exactly", () => {
    expect(parseSymbolDetails(BTCUSD_DETAILS, AT).stepSize).toBe(m("0.00000001"));
  });

  it("carries the base/quote assets and pair name", () => {
    const filters = parseSymbolDetails(BTCUSD_DETAILS, AT);
    expect(filters).toMatchObject({ pair: "BTCUSD", baseAsset: "BTC", quoteAsset: "USD", fetchedAt: AT });
  });

  it("leaves the bounds Gemini does not publish disabled (zero)", () => {
    const filters = parseSymbolDetails(BTCUSD_DETAILS, AT);
    expect(filters.minPrice).toBe(ZERO);
    expect(filters.maxPrice).toBe(ZERO);
    expect(filters.maxQuantity).toBe(ZERO);
    expect(filters.minNotional).toBe(ZERO);
    expect(filters.maxNotional).toBe(ZERO);
  });

  it("accepts a string increment too (defensive against a future API shape)", () => {
    const filters = parseSymbolDetails({ ...BTCUSD_DETAILS, quote_increment: "0.01" }, AT);
    expect(filters.tickSize).toBe(m("0.01"));
  });

  it("refuses an increment finer than the money scale rather than rounding it to a disabled grid", () => {
    expect(() => parseSymbolDetails({ ...BTCUSD_DETAILS, tick_size: 1e-12 }, AT)).toThrow(FilterError);
  });

  describe("status mapping", () => {
    it.each([
      ["open", "TRADING"],
      ["limit_only", "TRADING"],
      ["post_only", "TRADING"],
      ["cancel_only", "CANCEL_ONLY"],
      ["closed", "HALT"],
    ])("maps %s to %s", (gemini, expected) => {
      expect(parseSymbolDetails({ ...BTCUSD_DETAILS, status: gemini }, AT).status).toBe(expected);
    });

    it("throws on an unrecognised status rather than guessing tradability", () => {
      expect(() => parseSymbolDetails({ ...BTCUSD_DETAILS, status: "paused" }, AT)).toThrow(FilterError);
    });
  });

  it("throws on a missing symbol name", () => {
    expect(() => parseSymbolDetails({ ...BTCUSD_DETAILS, symbol: "" }, AT)).toThrow(FilterError);
  });

  it("throws on missing base/quote currency", () => {
    const { base_currency, ...rest } = BTCUSD_DETAILS;
    void base_currency;
    expect(() => parseSymbolDetails(rest, AT)).toThrow(FilterError);
  });
});

describe("toGeminiSymbol", () => {
  it("lower-cases and strips separators", () => {
    expect(toGeminiSymbol("BTCUSD")).toBe("btcusd");
    expect(toGeminiSymbol("BTC-USD")).toBe("btcusd");
    expect(toGeminiSymbol("eth_usd")).toBe("ethusd");
  });
});

describe("validateOrder (re-exported, exchange-agnostic) on Gemini-parsed filters", () => {
  const filters = parseSymbolDetails(BTCUSD_DETAILS, AT);

  it("rounds a buy price down onto the Gemini quote_increment grid", () => {
    const result = validateOrder(
      { pair: "BTCUSD", side: "buy", price: m("43210.567"), quantity: m("0.001") },
      filters,
    );
    expect(result.valid).toBe(true);
    if (result.valid) {
      // Floors to the 0.01 tick derived from quote_increment.
      expect(result.price).toBe(m("43210.56"));
    }
  });

  it("reports an off-grid price in verify mode instead of repairing it", () => {
    const result = validateOrder(
      { pair: "BTCUSD", side: "buy", price: m("43210.567"), quantity: m("0.001") },
      filters,
      { rounding: "verify" },
    );
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.code).toBe("price_off_tick");
  });

  it("rejects a quantity below Gemini's min_order_size", () => {
    const result = validateOrder(
      { pair: "BTCUSD", side: "buy", price: m("43210.56"), quantity: m("0.000001") },
      filters,
    );
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.code).toBe("quantity_below_min");
  });
});
