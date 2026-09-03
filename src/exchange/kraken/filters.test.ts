import { describe, expect, it } from "vitest";
import type { Timestamp } from "../../shared/exchange-client";
import { fromDecimalString as m, ZERO } from "../../shared/money";
import { buildKrakenCatalogue, type KrakenCatalogue } from "./catalogue";
import {
  allSymbolFilters,
  FilterError,
  lotDecimalsToStepString,
  parsePairFilters,
  symbolFiltersFor,
  tradablePairs,
  validateOrder,
} from "./filters";

/**
 * REAL KRAKEN DATA, PULLED LIVE, NOT INVENTED.
 *
 * Every entry below is verbatim from a live `GET /0/public/AssetPairs` and
 * `GET /0/public/Assets` against `api.kraken.com` -- 1440 pairs and 839 assets,
 * `error: []` on both -- taken the same way `catalogue.test.ts` took its own.
 * Field names, field order, the `X`/`Z` prefixes, the decimal-string bounds, the
 * integer `lot_decimals`/`pair_decimals` counts and the `status` values are
 * Kraken's own.
 *
 * ONE EDIT, AND ONLY ONE, matching `catalogue.test.ts`: the `fees`, `fees_maker`,
 * `leverage_buy` and `leverage_sell` arrays are dropped from each pair. Twelve
 * tiers apiece, read by nothing here, and they would bury the four fields this
 * module actually reads. Every field it touches -- `tick_size`, `lot_decimals`,
 * `ordermin`, `costmin`, `status` -- is unedited.
 *
 * THE SELECTION IS THE ARGUMENT. Each entry is here because it is the live
 * evidence for one claim in `filters.ts`:
 *
 *   XXBTZUSD   the ordinary case, prefixed on both sides. tick 0.1, lot_dec 8.
 *   ARBUSD     the other live `lot_decimals` (5), so both observed values appear.
 *   XDGUSD     a 7-decimal tick, the finest that still fits the money scale
 *              with room to spare, plus the XDG->DOGE legacy rename.
 *   XETHXXBT   crypto-QUOTED, so `costmin` is "0.00002" rather than a fiat 0.5.
 *   UNIUSD     a fractional `ordermin` ("1.5"), not the integer most pairs carry.
 *   REQUSD     `pair_decimals: 5` with `tick_size: "0.0001"`. THE COUNTEREXAMPLE
 *   VTHOUSD    that proves `pair_decimals` is display-only: deriving the grid
 *              from it would build one 10x finer than Kraken accepts.
 *   WINUSD     `tick_size` exactly AT the money scale (8dp), the boundary.
 *   BONKUSD    `tick_size` 9dp -- one past the scale. Coarsening case.
 *   ANKRXBT    `tick_size` 10dp -- the finest live. Coarsening case.
 *   ACXUSD     the only non-`online` state with an exact enum member
 *              (`cancel_only`).
 *   AIOEUR     `post_only`. The state this module refuses to call TRADING.
 *
 * WHAT IS NOT HERE, STATED PLAINLY RATHER THAN FAKED. Kraken documents
 * `limit_only` and `reduce_only`, and TODAY'S LIVE CATALOGUE CONTAINS NEITHER:
 * across all 1440 pairs the statuses are `online` (1385), `cancel_only` (38) and
 * `post_only` (17), and nothing else. So the two tests covering those states
 * build them by overriding `status` on a real entry, and say so at the point of
 * use. They are not presented as pulled fixtures, because they are not.
 */
const ASSET_PAIRS: Record<string, unknown> = {
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
  ARBUSD: {
    altname: "ARBUSD",
    wsname: "ARB/USD",
    aclass_base: "currency",
    base: "ARB",
    aclass_quote: "currency",
    quote: "ZUSD",
    lot: "unit5",
    cost_decimals: 8,
    pair_decimals: 4,
    lot_decimals: 5,
    lot_multiplier: 1,
    fee_volume_currency: "ZUSD",
    margin_call: 80,
    margin_stop: 40,
    ordermin: "50",
    costmin: "0.5",
    tick_size: "0.0001",
    status: "online",
    execution_venue: "international",
    long_position_limit: 3200000,
    short_position_limit: 2300000,
  },
  XDGUSD: {
    altname: "XDGUSD",
    wsname: "XDG/USD",
    aclass_base: "currency",
    base: "XXDG",
    aclass_quote: "currency",
    quote: "ZUSD",
    lot: "unit",
    cost_decimals: 9,
    pair_decimals: 7,
    lot_decimals: 8,
    lot_multiplier: 1,
    fee_volume_currency: "ZUSD",
    margin_call: 80,
    margin_stop: 40,
    ordermin: "50",
    costmin: "0.5",
    tick_size: "0.0000001",
    status: "online",
    execution_venue: "international",
    long_position_limit: 30000000,
    short_position_limit: 30000000,
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
  UNIUSD: {
    altname: "UNIUSD",
    wsname: "UNI/USD",
    aclass_base: "currency",
    base: "UNI",
    aclass_quote: "currency",
    quote: "ZUSD",
    lot: "unit",
    cost_decimals: 5,
    pair_decimals: 4,
    lot_decimals: 8,
    lot_multiplier: 1,
    fee_volume_currency: "ZUSD",
    margin_call: 80,
    margin_stop: 40,
    ordermin: "1.5",
    costmin: "0.5",
    tick_size: "0.0001",
    status: "online",
    execution_venue: "international",
    long_position_limit: 150000,
    short_position_limit: 110000,
  },
  REQUSD: {
    altname: "REQUSD",
    wsname: "REQ/USD",
    aclass_base: "currency",
    base: "REQ",
    aclass_quote: "currency",
    quote: "ZUSD",
    lot: "unit",
    cost_decimals: 7,
    pair_decimals: 5,
    lot_decimals: 8,
    lot_multiplier: 1,
    fee_volume_currency: "ZUSD",
    margin_call: 80,
    margin_stop: 40,
    ordermin: "90",
    costmin: "0.5",
    tick_size: "0.0001",
    status: "online",
    execution_venue: "international",
  },
  VTHOUSD: {
    altname: "VTHOUSD",
    wsname: "VTHO/USD",
    aclass_base: "currency",
    base: "VTHO",
    aclass_quote: "currency",
    quote: "ZUSD",
    lot: "unit5",
    cost_decimals: 5,
    pair_decimals: 7,
    lot_decimals: 5,
    lot_multiplier: 1,
    fee_volume_currency: "ZUSD",
    margin_call: 80,
    margin_stop: 40,
    ordermin: "13000",
    costmin: "0.5",
    tick_size: "0.000001",
    status: "online",
    execution_venue: "international",
  },
  WINUSD: {
    altname: "WINUSD",
    wsname: "WIN/USD",
    aclass_base: "currency",
    base: "WIN",
    aclass_quote: "currency",
    quote: "ZUSD",
    lot: "unit5",
    cost_decimals: 5,
    pair_decimals: 9,
    lot_decimals: 5,
    lot_multiplier: 1,
    fee_volume_currency: "ZUSD",
    margin_call: 80,
    margin_stop: 40,
    ordermin: "150000",
    costmin: "0.5",
    tick_size: "0.00000001",
    status: "online",
    execution_venue: "international",
  },
  BONKUSD: {
    altname: "BONKUSD",
    wsname: "BONK/USD",
    aclass_base: "currency",
    base: "BONK",
    aclass_quote: "currency",
    quote: "ZUSD",
    lot: "unit5",
    cost_decimals: 5,
    pair_decimals: 9,
    lot_decimals: 5,
    lot_multiplier: 1,
    fee_volume_currency: "ZUSD",
    margin_call: 80,
    margin_stop: 40,
    ordermin: "1500000",
    costmin: "0.5",
    tick_size: "0.000000001",
    status: "online",
    execution_venue: "international",
    long_position_limit: 50000000000,
    short_position_limit: 24000000000,
  },
  ANKRXBT: {
    altname: "ANKRXBT",
    wsname: "ANKR/XBT",
    aclass_base: "currency",
    base: "ANKR",
    aclass_quote: "currency",
    quote: "XXBT",
    lot: "unit",
    cost_decimals: 10,
    pair_decimals: 10,
    lot_decimals: 8,
    lot_multiplier: 1,
    fee_volume_currency: "ZUSD",
    margin_call: 80,
    margin_stop: 40,
    ordermin: "1300",
    costmin: "0.00002",
    tick_size: "0.0000000001",
    status: "online",
    execution_venue: "international",
  },
  ACXUSD: {
    altname: "ACXUSD",
    wsname: "ACX/USD",
    aclass_base: "currency",
    base: "ACX",
    aclass_quote: "currency",
    quote: "ZUSD",
    lot: "unit5",
    cost_decimals: 5,
    pair_decimals: 5,
    lot_decimals: 5,
    lot_multiplier: 1,
    fee_volume_currency: "ZUSD",
    margin_call: 80,
    margin_stop: 40,
    ordermin: "130",
    costmin: "0.5",
    tick_size: "0.00001",
    status: "cancel_only",
    execution_venue: "international",
  },
  AIOEUR: {
    altname: "AIOEUR",
    wsname: "AIO/EUR",
    aclass_base: "currency",
    base: "AIO",
    aclass_quote: "currency",
    quote: "ZEUR",
    lot: "unit5",
    cost_decimals: 5,
    pair_decimals: 5,
    lot_decimals: 5,
    lot_multiplier: 1,
    fee_volume_currency: "ZUSD",
    margin_call: 80,
    margin_stop: 40,
    ordermin: "100",
    costmin: "0.45",
    tick_size: "0.00001",
    status: "post_only",
    execution_venue: "international",
  },
};

/** `/0/public/Assets`, verbatim, for every asset the pairs above reference. */
const ASSETS: Record<string, unknown> = {
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
    collateral_value: 1,
    status: "enabled",
    margin_rate: "0.025",
  },
  ZEUR: {
    aclass: "currency",
    altname: "EUR",
    decimals: 4,
    display_decimals: 2,
    collateral_value: 1,
    status: "enabled",
    margin_rate: "0.02",
  },
  ARB: {
    aclass: "currency",
    altname: "ARB",
    decimals: 5,
    display_decimals: 3,
    collateral_value: 0.9,
    status: "enabled",
    margin_rate: "0.02",
  },
  XXDG: {
    aclass: "currency",
    altname: "XDG",
    decimals: 8,
    display_decimals: 2,
    collateral_value: 0.925,
    status: "enabled",
    margin_rate: "0.02",
  },
  XETH: {
    aclass: "currency",
    altname: "ETH",
    decimals: 10,
    display_decimals: 5,
    collateral_value: 0.99,
    status: "enabled",
    margin_rate: "0.02",
  },
  UNI: {
    aclass: "currency",
    altname: "UNI",
    decimals: 10,
    display_decimals: 5,
    collateral_value: 0.9,
    status: "enabled",
    margin_rate: "0.022",
  },
  REQ: {
    aclass: "currency",
    altname: "REQ",
    decimals: 10,
    display_decimals: 5,
    status: "enabled",
  },
  VTHO: {
    aclass: "currency",
    altname: "VTHO",
    decimals: 10,
    display_decimals: 5,
    status: "enabled",
  },
  WIN: {
    aclass: "currency",
    altname: "WIN",
    decimals: 2,
    display_decimals: 1,
    status: "enabled",
    margin_rate: "0",
  },
  BONK: {
    aclass: "currency",
    altname: "BONK",
    decimals: 2,
    display_decimals: 0,
    status: "enabled",
    margin_rate: "0.02",
  },
  ANKR: {
    aclass: "currency",
    altname: "ANKR",
    decimals: 10,
    display_decimals: 5,
    status: "enabled",
  },
  ACX: {
    aclass: "currency",
    altname: "ACX",
    decimals: 5,
    display_decimals: 3,
    status: "enabled",
    margin_rate: "0",
  },
  AIO: {
    aclass: "currency",
    altname: "AIO",
    decimals: 5,
    display_decimals: 3,
    status: "enabled",
    margin_rate: "0",
  },
};

const AT = 1_700_000_000_000;

function catalogue(
  overrides: Record<string, Record<string, unknown>> = {},
  fetchedAt: Timestamp = AT,
): KrakenCatalogue {
  const pairs: Record<string, unknown> = { ...ASSET_PAIRS };
  for (const [key, patch] of Object.entries(overrides)) {
    pairs[key] = { ...(ASSET_PAIRS[key] as Record<string, unknown>), ...patch };
  }
  return buildKrakenCatalogue({ assetPairs: pairs, assets: ASSETS, fetchedAt });
}

describe("parsePairFilters -- the fields Kraken publishes", () => {
  it("reads tick_size, ordermin and costmin straight off a real BTCUSD entry", () => {
    const filters = symbolFiltersFor(catalogue(), "BTCUSD");
    expect(filters.tickSize).toBe(m("0.1")); // tick_size: "0.1"
    expect(filters.minQuantity).toBe(m("0.00005")); // ordermin
    expect(filters.minNotional).toBe(m("0.5")); // costmin
  });

  it("names the pair and assets in THIS system's tickers, not Kraken's codes", () => {
    // The catalogue's whole purpose. `validateOrder` compares `filters.pair`
    // against the order's own `Pair`, so `XXBTZUSD` here would reject every
    // order ever built for `BTCUSD`.
    expect(symbolFiltersFor(catalogue(), "XXBTZUSD")).toMatchObject({
      pair: "BTCUSD",
      baseAsset: "BTC",
      quoteAsset: "USD",
      fetchedAt: AT,
    });
    // And the legacy rename on a crypto-quoted pair, both sides at once.
    expect(symbolFiltersFor(catalogue(), "XETHXXBT")).toMatchObject({
      pair: "ETHBTC",
      baseAsset: "ETH",
      quoteAsset: "BTC",
    });
    expect(symbolFiltersFor(catalogue(), "XDGUSD").pair).toBe("DOGEUSD");
  });

  it("reaches the same filters by any of the pair's four Kraken names", () => {
    const cat = catalogue();
    for (const name of ["BTCUSD", "XBTUSD", "XXBTZUSD", "XBT/USD", "btc-usd"]) {
      expect(symbolFiltersFor(cat, name).tickSize).toBe(m("0.1"));
    }
  });

  it("carries a crypto-quoted pair's own costmin, not a fiat-shaped assumption", () => {
    // ETH/XBT's costmin is "0.00002" BTC. A hard-coded 0.5 would be a minimum
    // notional ~25000x too large and would skip every order on the pair.
    expect(symbolFiltersFor(catalogue(), "ETHBTC").minNotional).toBe(m("0.00002"));
  });

  it("reads a fractional ordermin, not just the integer most pairs carry", () => {
    expect(symbolFiltersFor(catalogue(), "UNIUSD").minQuantity).toBe(m("1.5"));
  });

  it("takes a catalogued pair directly, reading its `raw` AssetPairs entry", () => {
    // The per-pair entry point, and the reason `KrakenPair` carries `raw` at all:
    // filters come from the SAME AssetPairs document the catalogue was built
    // from. Nothing here fetches, so the two views cannot disagree.
    const pair = catalogue().requirePair("BTCUSD");
    expect(parsePairFilters(pair, AT)).toEqual(symbolFiltersFor(catalogue(), "BTCUSD"));
    expect(parsePairFilters(pair, AT + 1).fetchedAt).toBe(AT + 1);
  });

  it("stamps the CATALOGUE's fetch time, so stale filters cannot look fresh", () => {
    const later = AT + 900_000;
    expect(symbolFiltersFor(catalogue({}, later), "BTCUSD").fetchedAt).toBe(later);
  });
});

describe("parsePairFilters -- tick_size is authoritative, pair_decimals is not", () => {
  /**
   * The four live pairs where the two genuinely disagree. Two of them are here,
   * and they are the reason `filters.ts` reads `tick_size` and never
   * `pair_decimals`: on 1436 of 1440 pairs the two agree, which is exactly what
   * makes the shortcut tempting and the bug invisible.
   */
  it("uses tick_size where pair_decimals would build a 10x finer grid (REQUSD)", () => {
    const filters = symbolFiltersFor(catalogue(), "REQUSD");
    // pair_decimals: 5 would give 0.00001. tick_size says 0.0001.
    expect(filters.tickSize).toBe(m("0.0001"));
    expect(filters.tickSize).not.toBe(m("0.00001"));
  });

  it("uses tick_size where pair_decimals would build a 10x finer grid (VTHOUSD)", () => {
    const filters = symbolFiltersFor(catalogue(), "VTHOUSD");
    // pair_decimals: 7 would give 0.0000001. tick_size says 0.000001.
    expect(filters.tickSize).toBe(m("0.000001"));
    expect(filters.tickSize).not.toBe(m("0.0000001"));
  });

  it("rejects a price on the pair_decimals grid that tick_size does not allow", () => {
    // The failure the shortcut would cause, stated as an order rather than a
    // field: a REQUSD price at the 5th decimal is off Kraken's 4th-decimal grid.
    const filters = symbolFiltersFor(catalogue(), "REQUSD");
    const result = validateOrder(
      { pair: "REQUSD", side: "buy", price: m("0.12345"), quantity: m("100") },
      filters,
      { rounding: "verify" },
    );
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.code).toBe("price_off_tick");
  });
});

describe("parsePairFilters -- stepSize is DERIVED from lot_decimals", () => {
  /**
   * `stepSize` is the one filter with no field behind it. Both live
   * `lot_decimals` values are covered (5 on 896 pairs, 8 on 544), each against
   * a real pair, and the expected value is written as the decimal string 10^-n
   * denotes rather than as a computed expression -- so the test would catch the
   * derivation being inverted, off by a power of ten, or read off the wrong field.
   */
  it("derives 10^-8 for the lot_decimals: 8 pairs", () => {
    const cat = catalogue();
    for (const name of ["BTCUSD", "DOGEUSD", "ETHBTC", "UNIUSD", "REQUSD"]) {
      expect(symbolFiltersFor(cat, name).stepSize).toBe(m("0.00000001"));
    }
  });

  it("derives 10^-5 for the lot_decimals: 5 pairs", () => {
    const cat = catalogue();
    for (const name of ["ARBUSD", "VTHOUSD", "WINUSD", "BONKUSD"]) {
      expect(symbolFiltersFor(cat, name).stepSize).toBe(m("0.00001"));
    }
  });

  it("does not confuse lot_decimals with cost_decimals or pair_decimals", () => {
    // XDGUSD carries three DIFFERENT counts at once -- lot_decimals 8,
    // cost_decimals 9, pair_decimals 7 -- so reading the wrong one is visible.
    expect(symbolFiltersFor(catalogue(), "DOGEUSD").stepSize).toBe(m("0.00000001"));
    // ARBUSD's cost_decimals is 8 while its lot_decimals is 5: the same trap
    // with the two fields swapped, so neither ordering of the mistake passes.
    expect(symbolFiltersFor(catalogue(), "ARBUSD").stepSize).toBe(m("0.00001"));
  });

  it("rounds a quantity onto the derived step, per pair", () => {
    // ONE quantity, two pairs, two derived steps -- so the difference in the
    // result is attributable to `lot_decimals` and nothing else.
    const cat = catalogue();
    const quantity = m("100.12345678");
    const arb = validateOrder(
      { pair: "ARBUSD", side: "buy", price: m("0.5"), quantity },
      symbolFiltersFor(cat, "ARBUSD"),
    );
    expect(arb.valid).toBe(true);
    if (arb.valid) {
      expect(arb.quantity).toBe(m("100.12345")); // lot_decimals 5 -> floored to 1e-5
      expect(arb.adjusted).toBe(true);
    }
    const btc = validateOrder(
      { pair: "BTCUSD", side: "buy", price: m("60000"), quantity },
      symbolFiltersFor(cat, "BTCUSD"),
    );
    expect(btc.valid).toBe(true);
    if (btc.valid) {
      expect(btc.quantity).toBe(quantity); // lot_decimals 8 -> already on the grid
      expect(btc.adjusted).toBe(false);
    }
  });

  it("derives a whole-unit step from lot_decimals: 0", () => {
    // Not a value Kraken publishes today, and constructed here for that reason:
    // 10^-0 is the boundary the formula must not get wrong.
    expect(symbolFiltersFor(catalogue({ ARBUSD: { lot_decimals: 0 } }), "ARBUSD").stepSize).toBe(
      m("1"),
    );
  });

  it("refuses a lot_decimals that is not a non-negative integer", () => {
    for (const bad of [-1, 2.5, "5", null, undefined]) {
      expect(() =>
        symbolFiltersFor(catalogue({ ARBUSD: { lot_decimals: bad } }), "ARBUSD"),
      ).toThrow(FilterError);
    }
  });

  it("lotDecimalsToStepString states the derivation in Kraken's vocabulary", () => {
    expect(lotDecimalsToStepString(0)).toBe("1");
    expect(lotDecimalsToStepString(5)).toBe("0.00001");
    expect(lotDecimalsToStepString(8)).toBe("0.00000001");
  });
});

describe("parsePairFilters -- a tick finer than the money scale", () => {
  it("reads a tick exactly AT the scale unchanged (WINUSD, 8dp)", () => {
    expect(symbolFiltersFor(catalogue(), "WINUSD").tickSize).toBe(m("0.00000001"));
  });

  it("coarsens a 9dp tick onto the finest representable grid (BONKUSD)", () => {
    expect(symbolFiltersFor(catalogue(), "BONKUSD").tickSize).toBe(m("0.00000001"));
  });

  it("coarsens a 10dp tick onto the finest representable grid (ANKRXBT)", () => {
    expect(symbolFiltersFor(catalogue(), "ANKRBTC").tickSize).toBe(m("0.00000001"));
  });

  it("never coarsens to ZERO, which would DISABLE the price grid", () => {
    // THE FAIL-OPEN OUTCOME THIS CASE EXISTS TO AVOID. `ZERO` means "no price
    // grid", so `validateOrder` would skip the tick check entirely and wave
    // through whatever price it was handed. Asserted as an inequality against
    // ZERO rather than as a rejected order, deliberately: every `Money` value is
    // a whole number of 1e-8 units, so once the grid IS 1e-8 no representable
    // price can be off it -- which is the same fact that makes the coarsening
    // lossless, and it means an off-tick order is not constructible here.
    expect(symbolFiltersFor(catalogue(), "ANKRBTC").tickSize).toBe(m("0.00000001"));
    expect(symbolFiltersFor(catalogue(), "ANKRBTC").tickSize).not.toBe(ZERO);
    expect(symbolFiltersFor(catalogue(), "BONKUSD").tickSize).not.toBe(ZERO);
  });

  it("prices a coarsened pair without adjusting or rejecting it", () => {
    // The soundness argument as behaviour: a representable ANKR/XBT price is
    // already on the coarsened grid, so it passes both of section 4.3's checks
    // untouched. Kraken's own tick is 1e-10 and every multiple of 1e-8 is a
    // multiple of that, which is why coarsening keeps the price legal.
    const filters = symbolFiltersFor(catalogue(), "ANKRBTC");
    const order = { pair: "ANKRBTC", side: "buy" as const, price: m("0.00000123"), quantity: m("1300") };
    const adjusted = validateOrder(order, filters);
    expect(adjusted.valid).toBe(true);
    if (adjusted.valid) {
      expect(adjusted.price).toBe(m("0.00000123"));
      expect(adjusted.adjusted).toBe(false);
    }
    // And the second, independent check agrees -- the point of `verify` mode.
    expect(validateOrder(order, filters, { rounding: "verify" }).valid).toBe(true);
  });

  it("refuses a finer tick that is NOT a power of ten, rather than coarsening it", () => {
    // Unreachable against live data -- all 1440 published ticks are powers of
    // ten -- and written for the day it is not. 1e-8 is not a multiple of
    // 2.5e-9, so coarsening would report off-grid prices as on-grid.
    expect(() =>
      symbolFiltersFor(catalogue({ BONKUSD: { tick_size: "0.0000000025" } }), "BONKUSD"),
    ).toThrow(/not a power of ten/);
  });

  it("reads a tick padded with insignificant trailing zeros as the value it is", () => {
    expect(
      symbolFiltersFor(catalogue({ ARBUSD: { tick_size: "0.000100000000" } }), "ARBUSD").tickSize,
    ).toBe(m("0.0001"));
  });

  it("refuses a non-positive or non-string tick_size", () => {
    for (const bad of ["0", "0.0", "-0.1", 0.0001, null, undefined, ""]) {
      expect(() =>
        symbolFiltersFor(catalogue({ ARBUSD: { tick_size: bad } }), "ARBUSD"),
      ).toThrow(FilterError);
    }
  });
});

describe("parsePairFilters -- the bounds Kraken does not publish", () => {
  it("leaves minPrice, maxPrice, maxQuantity and maxNotional DISABLED (zero)", () => {
    // Verified absent across all 1440 live pairs. ZERO is the shared "rule
    // disabled"; inventing a ceiling would reject every order on every pair.
    for (const name of ["BTCUSD", "ARBUSD", "ETHBTC", "BONKUSD"]) {
      const filters = symbolFiltersFor(catalogue(), name);
      expect(filters.minPrice).toBe(ZERO);
      expect(filters.maxPrice).toBe(ZERO);
      expect(filters.maxQuantity).toBe(ZERO);
      expect(filters.maxNotional).toBe(ZERO);
    }
  });

  it("does not reject a large order for exceeding a maximum that does not exist", () => {
    const result = validateOrder(
      { pair: "BTCUSD", side: "buy", price: m("60000"), quantity: m("1000") },
      symbolFiltersFor(catalogue(), "BTCUSD"),
    );
    expect(result.valid).toBe(true);
  });

  it("leaves `instrument` ABSENT rather than setting it to `unknown`", () => {
    // Kraken's spot and futures are separate hosts and AssetPairs carries no
    // field distinguishing them -- the identical situation `binance/filters.ts`
    // is in, handled the identical way. `undefined` means "this venue publishes
    // no such field"; `unknown` would mean "it sent a value we cannot map".
    const filters = symbolFiltersFor(catalogue(), "BTCUSD");
    expect(filters.instrument).toBeUndefined();
    expect("instrument" in filters).toBe(false);
  });

  it("still enforces the two minimums that DO exist", () => {
    const filters = symbolFiltersFor(catalogue(), "BTCUSD");
    const belowQty = validateOrder(
      { pair: "BTCUSD", side: "buy", price: m("60000"), quantity: m("0.00001") },
      filters,
    );
    expect(belowQty.valid).toBe(false);
    if (!belowQty.valid) expect(belowQty.code).toBe("quantity_below_min");

    // Above ordermin (0.00005) but priced so the cost falls under costmin (0.5).
    const belowCost = validateOrder(
      { pair: "BTCUSD", side: "buy", price: m("0.1"), quantity: m("0.0001") },
      filters,
    );
    expect(belowCost.valid).toBe(false);
    if (!belowCost.valid) expect(belowCost.code).toBe("notional_below_min");
  });
});

describe("parsePairFilters -- status FAILS CLOSED", () => {
  it("maps online to TRADING", () => {
    expect(symbolFiltersFor(catalogue(), "BTCUSD").status).toBe("TRADING");
  });

  it("maps cancel_only onto the enum's own CANCEL_ONLY", () => {
    expect(symbolFiltersFor(catalogue(), "ACXUSD").status).toBe("CANCEL_ONLY");
  });

  /**
   * THE `post_only` CASE. This is the confirmed decision the module exists to
   * hold, and it deliberately DIVERGES from `gemini/filters.ts`, which maps its
   * own `post_only` to TRADING on the grounds that the ladder places makers.
   *
   * The divergence is not a disagreement about post-only markets; it is about
   * what a shared gate can know. `validateOrder` sees a price and a quantity and
   * cannot tell whether the order is marketable, so calling the market TRADING
   * would let a crossing order past the one check meant to stop it.
   */
  it("does NOT map post_only to TRADING, even though makers would be accepted", () => {
    const filters = symbolFiltersFor(catalogue(), "AIOEUR");
    expect(filters.status).not.toBe("TRADING");
    expect(filters.status).toBe("BREAK");
  });

  it("refuses an order on a post_only market instead of letting it cross", () => {
    const result = validateOrder(
      { pair: "AIOEUR", side: "buy", price: m("0.5"), quantity: m("100") },
      symbolFiltersFor(catalogue(), "AIOEUR"),
    );
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.code).toBe("symbol_not_trading");
      expect(result.reason).toContain("not TRADING");
    }
  });

  it("does not map limit_only or reduce_only to TRADING either", () => {
    // CONSTRUCTED, NOT PULLED. Kraken documents both states and today's live
    // catalogue contains neither -- 1440 pairs carry only online, cancel_only
    // and post_only -- so each is built by overriding `status` on a real ARBUSD
    // entry. That is also why `mapStatus` names them explicitly instead of
    // letting them reach its `default` arm: a documented state must be a
    // decision, not an accident of an unrecognised-value path.
    for (const status of ["limit_only", "reduce_only"]) {
      const filters = symbolFiltersFor(catalogue({ ARBUSD: { status } }), "ARBUSD");
      expect(filters.status).not.toBe("TRADING");
      const result = validateOrder(
        { pair: "ARBUSD", side: "buy", price: m("0.5"), quantity: m("100") },
        filters,
      );
      expect(result.valid).toBe(false);
      if (!result.valid) expect(result.code).toBe("symbol_not_trading");
    }
  });

  it("THROWS on an unrecognised or future status rather than passing it", () => {
    // The case the whole fail-closed posture is for: a state Kraken has not
    // published yet. It must not become TRADING, and it must not be quietly
    // downgraded either -- a silent "assume untradable" leaves a bot
    // inexplicably idle, while a throw is an alert naming the value received.
    for (const status of ["auction_only", "maintenance", "ONLINE", "Online", "", 1, null]) {
      expect(() =>
        symbolFiltersFor(catalogue({ ARBUSD: { status } }), "ARBUSD"),
      ).toThrow(FilterError);
    }
  });

  it("names the unrecognised value in the error, so the alert is diagnosable", () => {
    expect(() =>
      symbolFiltersFor(catalogue({ ARBUSD: { status: "auction_only" } }), "ARBUSD"),
    ).toThrow(/ARBUSD.*auction_only/s);
  });

  it("is CASE-SENSITIVE, matching Kraken's documented lower-case values", () => {
    // The same rule `gemini/filters.ts` applies to its own enums: accepting
    // "ONLINE" would mean accepting a spelling this code has never seen in a
    // real payload, and trading a market on the strength of it.
    expect(() =>
      symbolFiltersFor(catalogue({ ARBUSD: { status: "ONLINE" } }), "ARBUSD"),
    ).toThrow(FilterError);
  });

  it("refuses a missing status field", () => {
    const pairs: Record<string, unknown> = { ...ASSET_PAIRS };
    const bare = { ...(ASSET_PAIRS.ARBUSD as Record<string, unknown>) };
    delete bare.status;
    pairs.ARBUSD = bare;
    const cat = buildKrakenCatalogue({ assetPairs: pairs, assets: ASSETS, fetchedAt: AT });
    expect(() => symbolFiltersFor(cat, "ARBUSD")).toThrow(FilterError);
  });
});

describe("allSymbolFilters and tradablePairs", () => {
  it("builds filters for every catalogued pair", () => {
    const cat = catalogue();
    const { filters, omitted } = allSymbolFilters(cat);
    expect(omitted).toEqual([]);
    expect(filters).toHaveLength(cat.pairCount);
    expect(filters.map((f) => f.pair)).toContain("BTCUSD");
  });

  it("OMITS AND RECORDS one unusable entry instead of refusing the rest", () => {
    // The same failure split `buildKrakenCatalogue` makes: one malformed listing
    // out of 1440 must not take down the other 1439, and must not vanish either.
    const { filters, omitted } = allSymbolFilters(catalogue({ ARBUSD: { status: "nonsense" } }));
    expect(omitted).toHaveLength(1);
    expect(omitted[0]!.key).toBe("ARBUSD");
    expect(omitted[0]!.reason).toContain("nonsense");
    expect(filters.map((f) => f.pair)).not.toContain("ARBUSD");
    expect(filters.map((f) => f.pair)).toContain("BTCUSD");
  });

  it("still throws loudly for that pair on the order path", () => {
    // Leniency belongs to the bulk listing, never to the call that is about to
    // place an order.
    expect(() =>
      symbolFiltersFor(catalogue({ ARBUSD: { status: "nonsense" } }), "ARBUSD"),
    ).toThrow(FilterError);
  });

  it("lists only the pairs that map to TRADING", () => {
    const open = tradablePairs(catalogue());
    expect(open).toContain("BTCUSD");
    expect(open).not.toContain("ACXUSD"); // cancel_only
    expect(open).not.toContain("AIOEUR"); // post_only
  });

  it("excludes an unrecognised status from the tradable list without throwing", () => {
    const cat = catalogue({ ARBUSD: { status: "auction_only" } });
    expect(() => tradablePairs(cat)).not.toThrow();
    const open = tradablePairs(cat);
    expect(open).not.toContain("ARBUSD");
    expect(open).toContain("BTCUSD");
  });
});

describe("the re-exported validator is the shared one, not a copy", () => {
  it("validates and rounds a Kraken order end to end", () => {
    const filters = symbolFiltersFor(catalogue(), "BTCUSD");
    const result = validateOrder(
      { pair: "BTCUSD", side: "buy", price: m("60123.456"), quantity: m("0.00123456") },
      filters,
    );
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.price).toBe(m("60123.4")); // buy floors onto the 0.1 tick
      expect(result.quantity).toBe(m("0.00123456")); // already on the 1e-8 step
      expect(result.adjusted).toBe(true);
    }
  });

  it("rounds a sell price the other way, as the shared validator does", () => {
    const result = validateOrder(
      { pair: "BTCUSD", side: "sell", price: m("60123.456"), quantity: m("0.001") },
      symbolFiltersFor(catalogue(), "BTCUSD"),
    );
    expect(result.valid).toBe(true);
    if (result.valid) expect(result.price).toBe(m("60123.5"));
  });

  it("refuses filters belonging to a different pair", () => {
    expect(() =>
      validateOrder(
        { pair: "ARBUSD", side: "buy", price: m("1"), quantity: m("100") },
        symbolFiltersFor(catalogue(), "BTCUSD"),
      ),
    ).toThrow();
  });
});
