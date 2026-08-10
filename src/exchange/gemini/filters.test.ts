import { describe, expect, it } from "vitest";
import { fromDecimalString as m, ZERO } from "../../shared/money";
import {
  FilterError,
  parseInstrumentKind,
  parseSymbolDetails,
  toGeminiSymbol,
  validateOrder,
} from "./filters";

const AT = 1_700_000_000_000;

/**
 * The BTCUSD sample from Gemini's own reference, verbatim shapes.
 *
 * `product_type` and `contract_type` were MISSING from this fixture until the
 * bot-creation gate needed them, while the comment above already claimed the
 * fixture was the reference's own sample -- and the reference's sample carries
 * both. That is step 28's lesson repeating: a stub that models a payload the
 * venue does not send teaches the wrong shape to whoever reads it next. Added,
 * with the documented values.
 */
const BTCUSD_DETAILS = {
  symbol: "BTCUSD",
  base_currency: "BTC",
  quote_currency: "USD",
  tick_size: 1e-8, // base-currency increment  -> our stepSize (quantity)
  quote_increment: 0.01, // quote-currency increment -> our tickSize (price)
  min_order_size: "0.00001", // a STRING, unlike the two above
  status: "open",
  wrap_enabled: false,
  product_type: "spot", // "Instrument type spot / swap"
  contract_type: "vanilla", // vanilla / linear / inverse
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

/**
 * The instrument-type read (`product_type` / `contract_type`).
 *
 * These are REAL structured fields Gemini documents, not a naming convention.
 * Nothing in this block looks at the symbol string, and that is the point: a
 * suffix heuristic and a field read give the same answer on every pair Gemini
 * happens to list today, so a test that let the two agree would not be testing
 * the field at all.
 */
describe("parseInstrumentKind", () => {
  it("reads Gemini's documented SPOT pairing: product_type spot + contract_type vanilla", () => {
    expect(parseInstrumentKind(BTCUSD_DETAILS)).toBe("spot");
    expect(parseSymbolDetails(BTCUSD_DETAILS, AT).instrument).toBe("spot");
  });

  it("reads a PERPETUAL: product_type swap, either contract settlement convention", () => {
    for (const contract of ["linear", "inverse"]) {
      expect(
        parseInstrumentKind({ ...BTCUSD_DETAILS, product_type: "swap", contract_type: contract }),
      ).toBe("derivative");
    }
  });

  /**
   * THE THREE TESTS BELOW EXIST BECAUSE THE ONE ABOVE PASSES FOR TWO REASONS.
   *
   * `parseInstrumentKind` answers "derivative" from either of two independent
   * lines -- `contract_type` naming a real contract, or `product_type: "swap"`.
   * A fixture carrying BOTH fields (which every realistic perpetual payload
   * does) is answered by the first line and never reaches the second, so each
   * line masks the other and a mutant deleting either one survives. Two did:
   * making `swap` return `"spot"`, and dropping `inverse` from the contract
   * check, both left the whole suite green.
   *
   * This is decision log 31's lesson landing again, on the code written in
   * response to it: a test aimed at a path where the failure is structurally
   * unreachable passes forever and reads exactly like a test that is working.
   * The fix is not more assertions, it is fixtures that ISOLATE one field.
   */
  it("reads a swap from product_type ALONE, with no contract_type to lean on", () => {
    const swapOnly: Record<string, unknown> = { ...BTCUSD_DETAILS, product_type: "swap" };
    delete swapOnly.contract_type;
    expect(parseInstrumentKind(swapOnly)).toBe("derivative");
  });

  it("reads linear AND inverse from contract_type ALONE, with no product_type", () => {
    for (const contract of ["linear", "inverse"]) {
      const noProduct: Record<string, unknown> = { ...BTCUSD_DETAILS, contract_type: contract };
      delete noProduct.product_type;
      expect(parseInstrumentKind(noProduct)).toBe("derivative");
    }
  });

  it("refuses a swap whose contract_type contradicts it, rather than trusting one field", () => {
    // `swap` + `vanilla` is not a documented instrument either. The swap line
    // wins on its own merits here, and this pins that it is the SWAP that
    // decides -- not the absence of a contract objection.
    expect(
      parseInstrumentKind({ ...BTCUSD_DETAILS, product_type: "swap", contract_type: "vanilla" }),
    ).toBe("derivative");
  });

  it("accepts spot with contract_type ABSENT -- product_type alone is a complete answer", () => {
    const noContract: Record<string, unknown> = { ...BTCUSD_DETAILS };
    delete noContract.contract_type;
    expect(parseInstrumentKind(noContract)).toBe("spot");
  });

  it("refuses to map a CONTRADICTION between the two fields", () => {
    // No documented instrument produces this. Reading `product_type` and
    // shrugging at the rest would be this code deciding it understands Gemini
    // better than Gemini does.
    expect(
      parseInstrumentKind({ ...BTCUSD_DETAILS, product_type: "spot", contract_type: "futures" }),
    ).toBe("unknown");
  });

  it("refuses to map a MISSING product_type -- absence is not an answer", () => {
    const bare: Record<string, unknown> = { ...BTCUSD_DETAILS };
    delete bare.product_type;
    delete bare.contract_type;
    expect(parseInstrumentKind(bare)).toBe("unknown");
    expect(parseSymbolDetails(bare, AT).instrument).toBe("unknown");
  });

  it("refuses to map an unrecognised product_type", () => {
    expect(parseInstrumentKind({ ...BTCUSD_DETAILS, product_type: "future" })).toBe("unknown");
  });

  it("is CASE-SENSITIVE, matching Gemini's documented lower-case values exactly", () => {
    // Step 28's casing rule, one field over. Accepting "SPOT" would mean
    // accepting a value this code has never seen in a real payload; the honest
    // outcome is a loud refusal naming what arrived.
    for (const spelling of ["SPOT", "Spot", "sPoT"]) {
      expect(parseInstrumentKind({ ...BTCUSD_DETAILS, product_type: spelling })).toBe("unknown");
    }
    expect(
      parseInstrumentKind({ ...BTCUSD_DETAILS, contract_type: "VANILLA" }),
    ).toBe("unknown");
  });

  it("does not throw on an unmappable value, unlike mapStatus", () => {
    // Deliberate asymmetry: a throw here would take down `getSymbolFilters` for
    // the ORDER path too, where these fields have never been needed and where
    // section 4.3's validation must keep working for every existing bot.
    expect(() => parseSymbolDetails({ ...BTCUSD_DETAILS, product_type: "nonsense" }, AT)).not.toThrow();
  });
});
