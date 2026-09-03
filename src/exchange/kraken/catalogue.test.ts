import { describe, expect, it } from "vitest";
import {
  buildKrakenCatalogue,
  CatalogueError,
  DEFAULT_CATALOGUE_MAX_AGE_MS,
  KRAKEN_ASSET_TICKER_ALIASES,
  KrakenCatalogueCache,
  normaliseAssetName,
  normalisePairName,
  type KrakenCatalogue,
} from "./catalogue";

/**
 * REAL KRAKEN SHAPES, NOT INVENTED ONES.
 *
 * Every entry below was taken verbatim from a live `GET /0/public/AssetPairs`
 * and `GET /0/public/Assets` against `api.kraken.com` (1440 pairs, 839 assets),
 * as entry 90 PART 1 did. Field names, field order, the `X`/`Z` prefixes, the
 * decimal-string bounds and the `status` values are Kraken's own.
 *
 * ONE EDIT, AND ONLY ONE: the `fees`, `fees_maker`, `leverage_buy` and
 * `leverage_sell` arrays are dropped from each pair. They run to twelve tiers
 * apiece, this module reads none of them, and keeping them would bury the fields
 * that matter. Every field the catalogue touches -- `altname`, `wsname`, `base`,
 * `quote`, `status` -- is unedited.
 *
 * The selection is not arbitrary. It holds the three shapes that break a
 * substitution rule (`XXBTZUSD` prefixed on both sides, `WBTCUSD`/`TBTCUSD`
 * containing `BTC`, `AIXBTUSD` containing `XBT`), the per-field prefixing case
 * (`ARBUSD`, keyed plainly with a `ZUSD` quote), the second BTC book
 * (`XBTUSDT`), a crypto-quoted pair (`XETHXXBT`), the other legacy rename
 * (`XDGUSD`), and one pair in each non-`online` status Kraken currently
 * publishes.
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
  WBTCUSD: {
    altname: "WBTCUSD",
    wsname: "WBTC/USD",
    aclass_base: "currency",
    base: "WBTC",
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
    ordermin: "0.00006",
    costmin: "0.5",
    tick_size: "0.1",
    status: "online",
    execution_venue: "international",
  },
  TBTCUSD: {
    altname: "TBTCUSD",
    wsname: "TBTC/USD",
    aclass_base: "currency",
    base: "TBTC",
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
    ordermin: "0.00006",
    costmin: "0.5",
    tick_size: "0.1",
    status: "online",
    execution_venue: "international",
  },
  AIXBTUSD: {
    altname: "AIXBTUSD",
    wsname: "AIXBT/USD",
    aclass_base: "currency",
    base: "AIXBT",
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
    ordermin: "250",
    costmin: "0.5",
    tick_size: "0.00001",
    status: "online",
    execution_venue: "international",
  },
  XBTUSDT: {
    altname: "XBTUSDT",
    wsname: "XBT/USDT",
    aclass_base: "currency",
    base: "XXBT",
    aclass_quote: "currency",
    quote: "USDT",
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
    long_position_limit: 80,
    short_position_limit: 80,
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

/**
 * `/0/public/Assets`, verbatim and unedited, for every asset the pairs above
 * reference, plus the two suffixed codes a balance response can carry.
 *
 * Note what is NOT here, because it is the fact the alias table exists for:
 * no asset has the code `BTC` or the altname `BTC`. `XXBT`'s altname is `XBT`.
 * Checked across all 839 live assets, not just this excerpt.
 */
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
    collateral_value: 1.0,
    status: "enabled",
    margin_rate: "0.025",
  },
  ZEUR: {
    aclass: "currency",
    altname: "EUR",
    decimals: 4,
    display_decimals: 2,
    collateral_value: 1.0,
    status: "enabled",
    margin_rate: "0.02",
  },
  WBTC: {
    aclass: "currency",
    altname: "WBTC",
    decimals: 10,
    display_decimals: 5,
    status: "enabled",
  },
  TBTC: {
    aclass: "currency",
    altname: "TBTC",
    decimals: 10,
    display_decimals: 5,
    status: "enabled",
  },
  AIXBT: {
    aclass: "currency",
    altname: "AIXBT",
    decimals: 5,
    display_decimals: 3,
    status: "enabled",
    margin_rate: "0",
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
  UNI: {
    aclass: "currency",
    altname: "UNI",
    decimals: 10,
    display_decimals: 5,
    collateral_value: 0.9,
    status: "enabled",
    margin_rate: "0.022",
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
  USDT: {
    aclass: "currency",
    altname: "USDT",
    decimals: 8,
    display_decimals: 4,
    collateral_value: 0.995,
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
  ACX: {
    aclass: "currency",
    altname: "ACX",
    decimals: 10,
    display_decimals: 5,
    status: "enabled",
  },
  AIO: {
    aclass: "currency",
    altname: "AIO",
    decimals: 8,
    display_decimals: 5,
    status: "enabled",
  },
  "XBT.M": {
    aclass: "currency",
    altname: "XBT.M",
    decimals: 10,
    display_decimals: 8,
    status: "enabled",
  },
  "DOT.S": {
    aclass: "currency",
    altname: "DOT.S",
    decimals: 10,
    display_decimals: 8,
    status: "enabled",
  },
};

const FETCHED_AT = 1_756_800_000_000;

function build(): KrakenCatalogue {
  return buildKrakenCatalogue({
    assetPairs: ASSET_PAIRS,
    assets: ASSETS,
    fetchedAt: FETCHED_AT,
  });
}

describe("buildKrakenCatalogue", () => {
  it("indexes every pair in the response", () => {
    const catalogue = build();
    expect(catalogue.pairCount).toBe(Object.keys(ASSET_PAIRS).length);
    expect(catalogue.assetCount).toBe(Object.keys(ASSETS).length);
    expect(catalogue.omittedPairs).toEqual([]);
    expect(catalogue.omittedAssets).toEqual([]);
    expect(catalogue.fetchedAt).toBe(FETCHED_AT);
  });

  it("finds no ambiguous name across all four naming spaces", () => {
    // Not a vacuous assertion: the same check over the full live catalogue of
    // 1440 pairs and 839 assets also returns nothing, which is why the resolver
    // can index canonical keys, altnames, wsnames and tickers into ONE map.
    const catalogue = build();
    expect(catalogue.ambiguousPairNames).toEqual([]);
    expect(catalogue.ambiguousAssetNames).toEqual([]);
  });

  it("carries the raw AssetPairs entry through for filters.ts", () => {
    const catalogue = build();
    // Identity, not equality: filters.ts must build SymbolFilters from the same
    // document this catalogue was built from, not a second fetch of it.
    expect(catalogue.requirePair("BTCUSD").raw).toBe(ASSET_PAIRS["XXBTZUSD"]);
    expect(catalogue.requirePair("BTCUSD").raw["ordermin"]).toBe("0.00005");
  });

  it("keeps Kraken's raw status without mapping it", () => {
    const catalogue = build();
    expect(catalogue.requirePair("BTCUSD").status).toBe("online");
    expect(catalogue.requirePair("ACXUSD").status).toBe("cancel_only");
    expect(catalogue.requirePair("AIOEUR").status).toBe("post_only");
  });
});

/**
 * THE TEST THIS FILE EXISTS FOR (entry 90 PROBLEM 1, spec 23.1).
 *
 * `WBTCUSD` and `TBTCUSD` are live Kraken pairs. A `BTC` -> `XBT` substitution
 * turns them into `WXBTUSD` and `TXBTUSD`, which do not exist; the reverse
 * substitution turns the live `AIXBTUSD` into the nonexistent `AIBTCUSD`. Each
 * case below would pass on a catalogue that happened to answer `BTCUSD`
 * correctly while still corrupting these three, so they are asserted
 * individually and by identity of the resolved entry rather than by name alone.
 */
describe("the pairs a BTC/XBT substitution corrupts", () => {
  it("keeps WBTC distinct from BTC", () => {
    const catalogue = build();
    const wbtc = catalogue.requirePair("WBTCUSD");
    const btc = catalogue.requirePair("BTCUSD");

    expect(wbtc.canonical).toBe("WBTCUSD");
    expect(wbtc.base.code).toBe("WBTC");
    expect(wbtc.base.ticker).toBe("WBTC");
    expect(wbtc.ticker).toBe("WBTCUSD");
    // The whole point: same quote asset, different base, different book.
    expect(wbtc.quote.code).toBe("ZUSD");
    expect(btc.quote.code).toBe("ZUSD");
    expect(wbtc).not.toBe(btc);
    expect(wbtc.canonical).not.toBe(btc.canonical);
    // And the name the substitution would have produced is not a pair at all.
    expect(catalogue.resolvePair("WXBTUSD")).toBeUndefined();
  });

  it("keeps TBTC distinct from BTC", () => {
    const catalogue = build();
    const tbtc = catalogue.requirePair("TBTCUSD");

    expect(tbtc.canonical).toBe("TBTCUSD");
    expect(tbtc.altname).toBe("TBTCUSD");
    expect(tbtc.base.code).toBe("TBTC");
    expect(tbtc.ticker).toBe("TBTCUSD");
    expect(tbtc).not.toBe(catalogue.requirePair("BTCUSD"));
    expect(catalogue.resolvePair("TXBTUSD")).toBeUndefined();
  });

  it("keeps WBTC and TBTC distinct from each other", () => {
    // Both contain `BTC`, both are USD-quoted, both are keyed plainly. A rule
    // that normalised either onto "the BTC pair" would collapse them together.
    const catalogue = build();
    expect(catalogue.requirePair("WBTCUSD")).not.toBe(catalogue.requirePair("TBTCUSD"));
    expect(catalogue.requirePair("WBTCUSD").raw["ordermin"]).toBe("0.00006");
    expect(catalogue.requirePair("WBTCUSD").base.code).toBe("WBTC");
    expect(catalogue.requirePair("TBTCUSD").base.code).toBe("TBTC");
  });

  it("keeps AIXBT distinct from BTC, which the REVERSE substitution corrupts", () => {
    const catalogue = build();
    const aixbt = catalogue.requirePair("AIXBTUSD");

    expect(aixbt.canonical).toBe("AIXBTUSD");
    expect(aixbt.base.code).toBe("AIXBT");
    expect(aixbt.base.ticker).toBe("AIXBT");
    expect(aixbt.ticker).toBe("AIXBTUSD");
    expect(aixbt).not.toBe(catalogue.requirePair("BTCUSD"));
    expect(catalogue.resolvePair("AIBTCUSD")).toBeUndefined();
  });

  it("un-prefixes the three lookalike ASSET codes without aliasing them", () => {
    const catalogue = build();
    expect(catalogue.tickerForAsset("XXBT")).toBe("BTC");
    expect(catalogue.tickerForAsset("WBTC")).toBe("WBTC");
    expect(catalogue.tickerForAsset("TBTC")).toBe("TBTC");
    expect(catalogue.tickerForAsset("AIXBT")).toBe("AIXBT");
  });

  it("resolves every corruptible pair to its own entry, none to another's", () => {
    const catalogue = build();
    const resolved = ["BTCUSD", "WBTCUSD", "TBTCUSD", "AIXBTUSD"].map((name) =>
      catalogue.requirePair(name).canonical,
    );
    expect(resolved).toEqual(["XXBTZUSD", "WBTCUSD", "TBTCUSD", "AIXBTUSD"]);
    expect(new Set(resolved).size).toBe(4);
  });
});

describe("two-way pair lookup", () => {
  it("resolves all four of a pair's names to the one entry", () => {
    const catalogue = build();
    const entry = catalogue.requirePair("XXBTZUSD");
    for (const name of ["XXBTZUSD", "XBTUSD", "XBT/USD", "BTCUSD"]) {
      expect(catalogue.resolvePair(name)).toBe(entry);
    }
    expect(entry.canonical).toBe("XXBTZUSD");
    expect(entry.altname).toBe("XBTUSD");
    expect(entry.wsname).toBe("XBT/USD");
    expect(entry.ticker).toBe("BTCUSD");
  });

  it("gives the request name and the response key for a normal ticker", () => {
    const catalogue = build();
    // The asymmetry that makes this module necessary: what goes out is not what
    // comes back, and neither is what this codebase calls the pair.
    expect(catalogue.requestNameFor("BTCUSD")).toBe("XBTUSD");
    expect(catalogue.responseKeyFor("BTCUSD")).toBe("XXBTZUSD");
    expect(catalogue.tickerForPair("XXBTZUSD")).toBe("BTCUSD");
  });

  it("accepts separators and case in the caller's pair name", () => {
    const catalogue = build();
    const entry = catalogue.requirePair("BTCUSD");
    for (const name of ["btc-usd", "BTC/USD", "btc_usd", "BtcUsd"]) {
      expect(catalogue.resolvePair(name)).toBe(entry);
    }
  });

  it("un-prefixes per FIELD, not per pair", () => {
    // ARBUSD is keyed plainly and its altname is ARBUSD -- yet its quote is
    // still ZUSD. A plain key does not license the conclusion that the assets
    // are plainly named (spec 23.3 touchpoint 2).
    const catalogue = build();
    const arb = catalogue.requirePair("ARBUSD");
    expect(arb.canonical).toBe("ARBUSD");
    expect(arb.altname).toBe("ARBUSD");
    expect(arb.raw["quote"]).toBe("ZUSD");
    expect(arb.quote.code).toBe("ZUSD");
    expect(arb.quote.ticker).toBe("USD");
    expect(arb.ticker).toBe("ARBUSD");
  });

  it("resolves a plainly-keyed pair whose assets are plainly named", () => {
    const catalogue = build();
    const uni = catalogue.requirePair("UNIUSD");
    expect(uni.canonical).toBe("UNIUSD");
    expect(uni.base.ticker).toBe("UNI");
    expect(uni.quote.ticker).toBe("USD");
  });

  it("resolves the other legacy rename, XDG/DOGE", () => {
    const catalogue = build();
    const doge = catalogue.requirePair("DOGEUSD");
    expect(doge.canonical).toBe("XDGUSD");
    expect(doge.altname).toBe("XDGUSD");
    expect(doge.base.code).toBe("XXDG");
    expect(doge.base.altname).toBe("XDG");
    expect(doge.base.ticker).toBe("DOGE");
    expect(catalogue.resolvePair("XDGUSD")).toBe(doge);
  });

  it("resolves a crypto-quoted pair, prefixed on both sides", () => {
    const catalogue = build();
    const ethbtc = catalogue.requirePair("ETHBTC");
    expect(ethbtc.canonical).toBe("XETHXXBT");
    expect(ethbtc.altname).toBe("ETHXBT");
    expect(ethbtc.ticker).toBe("ETHBTC");
    expect(ethbtc.base.ticker).toBe("ETH");
    expect(ethbtc.quote.ticker).toBe("BTC");
    expect(catalogue.resolvePair("ETHXBT")).toBe(ethbtc);
    expect(catalogue.resolvePair("XETHXXBT")).toBe(ethbtc);
  });

  it("keeps BTC's three books separate", () => {
    // Entry 89's open question is pair SELECTION, not naming; the catalogue's
    // job is to make sure the two it can see are never confused for each other.
    const catalogue = build();
    const usd = catalogue.requirePair("BTCUSD");
    const usdt = catalogue.requirePair("BTCUSDT");
    expect(usd.canonical).toBe("XXBTZUSD");
    expect(usdt.canonical).toBe("XBTUSDT");
    expect(usdt.altname).toBe("XBTUSDT");
    expect(usdt.quote.code).toBe("USDT");
    expect(usd).not.toBe(usdt);
  });

  it("refuses an unknown pair by name instead of deriving one", () => {
    const catalogue = build();
    expect(catalogue.resolvePair("NOSUCHUSD")).toBeUndefined();
    expect(() => catalogue.requirePair("NOSUCHUSD")).toThrow(CatalogueError);
    expect(() => catalogue.requirePair("NOSUCHUSD")).toThrow(/not in Kraken's catalogue/);
    // The slash form Kraken itself rejects on input is still resolvable here,
    // because resolving is this module's job and sending is the client's.
    expect(catalogue.resolvePair("XBT/USD")?.canonical).toBe("XXBTZUSD");
  });
});

describe("asset un-prefixing", () => {
  it("un-prefixes the legacy X/Z codes balances arrive in", () => {
    const catalogue = build();
    expect(catalogue.tickerForAsset("ZUSD")).toBe("USD");
    expect(catalogue.tickerForAsset("ZEUR")).toBe("EUR");
    expect(catalogue.tickerForAsset("XXBT")).toBe("BTC");
    expect(catalogue.tickerForAsset("XETH")).toBe("ETH");
    expect(catalogue.tickerForAsset("XXDG")).toBe("DOGE");
  });

  it("leaves plainly-keyed codes alone", () => {
    const catalogue = build();
    for (const code of ["ARB", "UNI", "USDT", "WBTC", "TBTC", "AIXBT"]) {
      expect(catalogue.tickerForAsset(code)).toBe(code);
    }
  });

  it("maps a ticker back to the code Kraken wants", () => {
    const catalogue = build();
    expect(catalogue.assetCodeFor("BTC")).toBe("XXBT");
    expect(catalogue.assetCodeFor("USD")).toBe("ZUSD");
    expect(catalogue.assetCodeFor("DOGE")).toBe("XXDG");
    expect(catalogue.assetCodeFor("ARB")).toBe("ARB");
    // Kraken's own short name resolves too -- the same asset, a third name.
    expect(catalogue.assetCodeFor("XBT")).toBe("XXBT");
    expect(catalogue.assetCodeFor("XDG")).toBe("XXDG");
  });

  it("treats a suffixed earn/staking code as its own asset", () => {
    // XBT.M is bonded BTC and DOT.S is staked DOT. Neither is spot, and Kraken
    // lists them as separate assets; calling either one BTC or DOT would report
    // a locked balance as free. The catalogue answers with the code itself.
    const catalogue = build();
    expect(catalogue.tickerForAsset("XBT.M")).toBe("XBT.M");
    expect(catalogue.tickerForAsset("DOT.S")).toBe("DOT.S");
    expect(catalogue.resolveAsset("XBT.M")).not.toBe(catalogue.resolveAsset("XXBT"));
    // And the dot is load-bearing: stripping it must not reach the asset.
    expect(catalogue.resolveAsset("XBTM")).toBeUndefined();
    expect(catalogue.resolveAsset("DOTS")).toBeUndefined();
  });

  it("refuses an unknown asset code instead of guessing a ticker", () => {
    const catalogue = build();
    expect(catalogue.resolveAsset("ZZZZ")).toBeUndefined();
    expect(() => catalogue.tickerForAsset("ZZZZ")).toThrow(CatalogueError);
    expect(() => catalogue.tickerForAsset("ZZZZ")).toThrow(/refusing to guess a ticker/);
  });

  it("carries Kraken's own precision fields", () => {
    const catalogue = build();
    const btc = catalogue.requireAsset("BTC");
    expect(btc.code).toBe("XXBT");
    expect(btc.altname).toBe("XBT");
    expect(btc.decimals).toBe(10);
    expect(btc.displayDecimals).toBe(5);
    expect(btc.status).toBe("enabled");
  });

  it("aliases only the two codes Kraken renamed venue-wide", () => {
    expect(KRAKEN_ASSET_TICKER_ALIASES).toEqual({ XBT: "BTC", XDG: "DOGE" });
    // Frozen because a third entry is a venue fact, not a convenience: every
    // addition changes what `BTCUSD` resolves to for every bot.
    expect(Object.isFrozen(KRAKEN_ASSET_TICKER_ALIASES)).toBe(true);
  });
});

describe("selectPairResult", () => {
  it("reads a reply keyed by the canonical name the client never sent", () => {
    // The shape of an actual Ticker reply: requested as XBTUSD, keyed XXBTZUSD.
    const catalogue = build();
    const result = { XXBTZUSD: { c: ["109000.0", "0.001"] } };
    const selected = catalogue.selectPairResult(result, catalogue.requirePair("BTCUSD"));
    expect(selected?.key).toBe("XXBTZUSD");
    expect(selected?.matchedBy).toBe("canonical");
    expect(selected?.value).toBe(result["XXBTZUSD"]);
  });

  it("picks the right entry out of a multi-pair reply", () => {
    const catalogue = build();
    const result = {
      XXBTZUSD: { c: ["109000.0", "0.001"] },
      WBTCUSD: { c: ["108900.0", "0.010"] },
      TBTCUSD: { c: ["108800.0", "0.010"] },
    };
    expect(
      catalogue.selectPairResult(result, catalogue.requirePair("WBTCUSD"))?.key,
    ).toBe("WBTCUSD");
    expect(
      catalogue.selectPairResult(result, catalogue.requirePair("TBTCUSD"))?.key,
    ).toBe("TBTCUSD");
    expect(
      catalogue.selectPairResult(result, catalogue.requirePair("BTCUSD"))?.key,
    ).toBe("XXBTZUSD");
  });

  it("matches an altname-keyed reply, and a wsname-keyed one as the same name", () => {
    // `XBT/USD` and `XBTUSD` are one string once separators are stripped, which
    // is true of every live pair's wsname and altname -- so there is no separate
    // wsname arm to report. Both match, both say `altname`.
    const catalogue = build();
    const btc = catalogue.requirePair("BTCUSD");
    expect(catalogue.selectPairResult({ XBTUSD: 1 }, btc)?.matchedBy).toBe("altname");
    expect(catalogue.selectPairResult({ "XBT/USD": 1 }, btc)?.matchedBy).toBe("altname");
    expect(catalogue.selectPairResult({ "XBT/USD": 7 }, btc)?.value).toBe(7);
  });

  it("reports a sole-key fallback as a fallback rather than hiding it", () => {
    // Entry 90's "read the single key out of the map". Returning it silently
    // would let a caller price an order off a book it never asked for; the
    // caller decides whether `sole-key` is good enough for what it is doing.
    const catalogue = build();
    const selected = catalogue.selectPairResult(
      { SOMETHINGELSE: 42 },
      catalogue.requirePair("BTCUSD"),
    );
    expect(selected?.matchedBy).toBe("sole-key");
    expect(selected?.value).toBe(42);
  });

  it("returns undefined rather than pick from an unmatched multi-key reply", () => {
    const catalogue = build();
    const selected = catalogue.selectPairResult(
      { WBTCUSD: 1, TBTCUSD: 2 },
      catalogue.requirePair("BTCUSD"),
    );
    expect(selected).toBeUndefined();
  });

  it("returns undefined for an empty result map", () => {
    const catalogue = build();
    expect(catalogue.selectPairResult({}, catalogue.requirePair("BTCUSD"))).toBeUndefined();
  });
});

describe("malformed responses", () => {
  it("throws when the response is not an object at all", () => {
    expect(() =>
      buildKrakenCatalogue({ assetPairs: [], assets: ASSETS, fetchedAt: FETCHED_AT }),
    ).toThrow(CatalogueError);
    expect(() =>
      buildKrakenCatalogue({ assetPairs: ASSET_PAIRS, assets: null, fetchedAt: FETCHED_AT }),
    ).toThrow(/Assets result is not an object/);
  });

  it("throws rather than cache a catalogue that resolves nothing", () => {
    expect(() =>
      buildKrakenCatalogue({ assetPairs: {}, assets: ASSETS, fetchedAt: FETCHED_AT }),
    ).toThrow(/no usable pairs/);
  });

  it("omits one unusable entry and records it, keeping the rest", () => {
    const catalogue = buildKrakenCatalogue({
      assetPairs: { ...ASSET_PAIRS, BROKENUSD: { wsname: "BROKEN/USD" } },
      assets: ASSETS,
      fetchedAt: FETCHED_AT,
    });
    expect(catalogue.omittedPairs).toEqual([
      { key: "BROKENUSD", reason: "missing altname, base or quote" },
    ]);
    expect(catalogue.resolvePair("BROKENUSD")).toBeUndefined();
    // The other 11 pairs are unaffected: one bad listing is not a dead venue.
    expect(catalogue.requirePair("BTCUSD").canonical).toBe("XXBTZUSD");
    expect(catalogue.pairCount).toBe(Object.keys(ASSET_PAIRS).length);
  });

  it("omits a pair whose assets the Assets response does not carry", () => {
    const catalogue = buildKrakenCatalogue({
      assetPairs: {
        ...ASSET_PAIRS,
        GHOSTUSD: { altname: "GHOSTUSD", wsname: "GHOST/USD", base: "GHOST", quote: "ZUSD" },
      },
      assets: ASSETS,
      fetchedAt: FETCHED_AT,
    });
    expect(catalogue.omittedPairs).toEqual([
      { key: "GHOSTUSD", reason: "asset GHOST is not in the Assets response" },
    ]);
    expect(catalogue.resolvePair("GHOSTUSD")).toBeUndefined();
  });

  it("marks a name two different pairs claim as ambiguous, and refuses it", () => {
    // No such collision exists in the live catalogue, across all 1440 pairs and
    // all four naming spaces. This constructs one to pin the behaviour if
    // Kraken ever lists a pair whose altname is another pair's canonical key:
    // the answer is a loud refusal, not a precedence rule.
    const catalogue = buildKrakenCatalogue({
      assetPairs: {
        ...ASSET_PAIRS,
        IMPOSTORUSD: {
          altname: "XXBTZUSD",
          wsname: "IMPOSTOR/USD",
          base: "UNI",
          quote: "ZEUR",
        },
      },
      assets: ASSETS,
      fetchedAt: FETCHED_AT,
    });
    expect(catalogue.ambiguousPairNames).toEqual(["XXBTZUSD"]);
    expect(catalogue.resolvePair("XXBTZUSD")).toBeUndefined();
    expect(() => catalogue.requirePair("XXBTZUSD")).toThrow(/ambiguous on Kraken/);
    // The unambiguous names of both pairs still resolve.
    expect(catalogue.requirePair("BTCUSD").canonical).toBe("XXBTZUSD");
    expect(catalogue.requirePair("IMPOSTORUSD").canonical).toBe("IMPOSTORUSD");
  });

  it("tolerates a missing wsname without losing the pair", () => {
    const catalogue = buildKrakenCatalogue({
      assetPairs: { NOWSUSD: { altname: "NOWSUSD", base: "ARB", quote: "ZUSD" } },
      assets: ASSETS,
      fetchedAt: FETCHED_AT,
    });
    expect(catalogue.requirePair("NOWSUSD").wsname).toBe("");
    expect(catalogue.requirePair("ARBUSD").canonical).toBe("NOWSUSD");
  });
});

describe("name normalisation", () => {
  it("strips separators from pair names only", () => {
    expect(normalisePairName("xbt/usd")).toBe("XBTUSD");
    expect(normalisePairName("BTC-USD")).toBe("BTCUSD");
    expect(normaliseAssetName("xbt.m")).toBe("XBT.M");
    expect(normaliseAssetName("dot.s")).toBe("DOT.S");
  });
});

/**
 * The cache follows `SymbolFilterCache` (`binance/filters.ts`) deliberately:
 * same method names, same "reports staleness, never refetches" contract, same
 * `peek` escape hatch so using stale data is always a decision at the call site.
 * These tests mirror that module's cache tests for the same reasons.
 */
describe("KrakenCatalogueCache", () => {
  it("returns a fresh catalogue and drops a stale one", () => {
    const cache = new KrakenCatalogueCache({ maxAgeMs: 1000 });
    const catalogue = build();
    cache.put(catalogue);
    expect(cache.get(FETCHED_AT)).toBe(catalogue);
    expect(cache.get(FETCHED_AT + 999)).toBe(catalogue);
    // Boundary is inclusive, exactly as SymbolFilterCache's is.
    expect(cache.get(FETCHED_AT + 1000)).toBeUndefined();
    expect(cache.isStale(catalogue, FETCHED_AT + 1000)).toBe(true);
  });

  it("keeps a stale catalogue reachable only through peek", () => {
    const cache = new KrakenCatalogueCache({ maxAgeMs: 1000 });
    const catalogue = build();
    cache.put(catalogue);
    expect(cache.get(FETCHED_AT + 5000)).toBeUndefined();
    expect(cache.peek()).toBe(catalogue);
  });

  it("is empty before anything is put and after invalidate", () => {
    const cache = new KrakenCatalogueCache();
    expect(cache.get(FETCHED_AT)).toBeUndefined();
    expect(cache.peek()).toBeUndefined();
    cache.put(build());
    cache.invalidate();
    expect(cache.get(FETCHED_AT)).toBeUndefined();
    expect(cache.peek()).toBeUndefined();
  });

  it("replaces the whole catalogue on put, never merges", () => {
    // Kraken publishes the catalogue as one document; half a catalogue is not a
    // thing that can be fetched, so a refetch supersedes rather than tops up.
    const cache = new KrakenCatalogueCache();
    const first = build();
    const second = buildKrakenCatalogue({
      assetPairs: { ARBUSD: ASSET_PAIRS["ARBUSD"] },
      assets: ASSETS,
      fetchedAt: FETCHED_AT + 10,
    });
    cache.put(first);
    cache.put(second);
    expect(cache.peek()).toBe(second);
    expect(cache.peek()?.resolvePair("BTCUSD")).toBeUndefined();
  });

  it("defaults to the same hour the filter cache uses", () => {
    expect(new KrakenCatalogueCache().maxAgeMs).toBe(DEFAULT_CATALOGUE_MAX_AGE_MS);
    expect(DEFAULT_CATALOGUE_MAX_AGE_MS).toBe(3_600_000);
  });

  it("rejects a nonsensical max age at construction", () => {
    expect(() => new KrakenCatalogueCache({ maxAgeMs: 0 })).toThrow(CatalogueError);
    expect(() => new KrakenCatalogueCache({ maxAgeMs: -1 })).toThrow(/must be positive/);
    expect(() => new KrakenCatalogueCache({ maxAgeMs: Number.NaN })).toThrow(CatalogueError);
  });
});
