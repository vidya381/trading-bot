/**
 * Kraken's AssetPairs data as `SymbolFilters` (spec section 4.3, decision log
 * entry 90 section 2.1 and touchpoint 3).
 *
 * Two responsibilities, split exactly as on the Binance and Gemini sides:
 *
 *  1. Turn one AssetPairs entry into the shared `SymbolFilters`. That part is
 *     Kraken-specific and lives here.
 *  2. Validate and round a price and quantity against those filters. That part
 *     is NOT exchange-specific -- `validateOrder` and `SymbolFilterCache`
 *     operate purely on `SymbolFilters` and `Money`, so they are RE-EXPORTED
 *     from the Binance module rather than reimplemented, exactly as
 *     `gemini/filters.ts` does it. The Kraken client therefore imports
 *     everything filter-shaped from HERE and never reaches into `../binance`.
 *
 * NOTHING HERE FETCHES. `catalogue.ts` already holds the parsed `/0/public/
 * AssetPairs` document, and every `KrakenPair` carries its own unmodified entry
 * in `raw` for precisely this purpose -- so filters are built from the SAME
 * response the catalogue was built from. Fetching that 1.1MB document a second
 * time would cost nothing but risk everything: two views of one venue, a
 * catalogue that can name a pair whose filters disagree with it.
 *
 * ── THE THREE FIELDS THAT ARE NOT A TRANSCRIPTION ──
 *
 * `tick_size` -> `tickSize` is direct, and `pair_decimals` is NOT a substitute
 * for it. `pair_decimals` is display precision, and on four live pairs the two
 * genuinely disagree: `REQUSD` publishes `pair_decimals: 5` with `tick_size:
 * "0.0001"`. Deriving the price grid from `pair_decimals` there would build one
 * ten times finer than Kraken accepts, and every order on it would be rejected
 * for a reason nothing in the payload explains.
 *
 * `stepSize` has NO field at all and is derived from `lot_decimals` as 10^-n.
 *
 * `status` is mapped, and mapped to FAIL CLOSED. See `mapStatus`.
 *
 * ── WHAT KRAKEN DOES NOT PUBLISH ──
 *
 * No maximum price, quantity or notional, and no minimum price: verified absent
 * across all 1440 live pairs. All four are `ZERO`, which `SymbolFilters` already
 * defines as "this rule is disabled" -- the same state a Binance symbol carrying
 * no `PRICE_FILTER` ceiling is in. Inventing a ceiling would reject every order
 * on every pair, since no price is at or below zero.
 */

import type { Pair, SymbolFilters, SymbolStatus, Timestamp } from "../../shared/exchange-client";
import {
  fromDecimalString,
  fromDecimalStringRounded,
  SCALE,
  ZERO,
  type Money,
} from "../../shared/money";
import { type CatalogueOmission, type KrakenCatalogue, type KrakenPair } from "./catalogue";

// The exchange-agnostic validator and cache, re-exported so callers depend on
// this module rather than on Binance's. These operate on the shared
// `SymbolFilters`/`Money` and contain nothing Binance-specific. Same arrangement
// and same reasoning as `gemini/filters.ts` -- one implementation, not a copy.
export {
  validateOrder,
  SymbolFilterCache,
  DEFAULT_FILTER_MAX_AGE_MS,
  type OrderValidation,
  type OrderRejectionCode,
  type FilterRoundingMode,
  type ValidateOrderInput,
} from "../binance/filters";

export class FilterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FilterError";
  }
}

/**
 * A bound Kraken does not publish, expressed with the shared "zero disables"
 * convention so `validateOrder` skips it rather than enforcing a literal zero.
 */
const DISABLED = ZERO;

/**
 * The finest grid `Money` can express: 10^-SCALE, i.e. `1e-8`.
 *
 * Derived from `SCALE` rather than written as a literal so that it stays correct
 * if the money scale ever moves -- a hard-coded `1n` would quietly become the
 * wrong grid, and this is the value the coarsening below rounds onto.
 */
const FINEST_GRID: Money = fromDecimalString(`0.${"0".repeat(SCALE - 1)}1`);

/**
 * Map Kraken's pair status onto the shared `SymbolStatus`, FAILING CLOSED.
 *
 * Kraken publishes five states -- `online`, `cancel_only`, `post_only`,
 * `limit_only`, `reduce_only` -- and only the first is a clean "this market is
 * trading normally". EVERYTHING ELSE MAPS TO A NON-`TRADING` STATUS, which
 * `validateOrder` refuses outright.
 *
 * WHY `post_only` IS NOT `TRADING`, THOUGH GEMINI'S IS. `gemini/filters.ts` maps
 * its own `post_only` to `TRADING`, reasoning that the resting ladder orders of
 * sections 6.2/6.3 are makers and so are placeable. That reasoning is not wrong
 * about the ladder, but it is wrong as a GATE: `SymbolFilters.status` is checked
 * by one `validateOrder` that every order path shares, and it cannot see whether
 * the order in front of it is marketable. Mapping `post_only` to `TRADING` here
 * would let a crossing order through a check whose entire job is to stop it, and
 * the venue's rejection would arrive after the order was constructed and sent.
 * A confirmed decision, not a reading of Gemini's precedent (entry 90).
 *
 * `limit_only` and `reduce_only` follow for the same reason: both accept SOME
 * orders and refuse others, and neither distinction is one this gate can draw.
 *
 * WHY THREE STATES SHARE `BREAK`. The shared enum is Binance-derived and has no
 * member meaning "accepting only certain order types". `BREAK` is its nearest
 * true statement -- the venue is up, this market is not trading normally -- and
 * `CANCEL_ONLY` is reserved for the one Kraken state that means exactly that.
 * The cost is that `validateOrder`'s rejection says `BREAK` rather than naming
 * which Kraken state it was; the alternative, widening a shared cross-venue type
 * for one venue's vocabulary, is a larger change than this gate justifies.
 *
 * AN UNRECOGNISED STATUS THROWS, matching `parseStatus` on the Binance side and
 * `mapStatus` on Gemini's. A new Kraken state is a case this code has never seen
 * and cannot judge; guessing `TRADING` would trade a market on the strength of a
 * word nobody has read, and quietly guessing "untradable" would leave a bot
 * inexplicably idle. A throw becomes an alert with a real cause under section
 * 7.5. Note that today's live catalogue carries only `online` (1385 pairs),
 * `cancel_only` (38) and `post_only` (17) -- `limit_only` and `reduce_only` are
 * documented states with no live example, which is exactly why they are mapped
 * here explicitly rather than left to the `default` arm.
 */
function mapStatus(raw: unknown, pair: Pair): SymbolStatus {
  switch (raw) {
    case "online":
      return "TRADING";
    case "cancel_only":
      return "CANCEL_ONLY";
    case "post_only":
    case "limit_only":
    case "reduce_only":
      return "BREAK";
    default:
      throw new FilterError(
        `${pair}: unrecognised Kraken pair status ${JSON.stringify(raw)}; ` +
          `refusing to guess whether the market is tradable`,
      );
  }
}

/** The significant decimal places in a decimal string, ignoring trailing zeros. */
function significantDecimals(value: string): number {
  const dot = value.indexOf(".");
  if (dot === -1) return 0;
  return value.slice(dot + 1).replace(/0+$/, "").length;
}

/**
 * True for `0.1`, `0.0001`, `0.0000000001` -- a negative power of ten.
 *
 * BOTH ends of the fraction are stripped, and the leading end is the one that
 * matters: `0.000000001` has its significant `1` behind eight zeros, so
 * comparing the raw fraction against `"1"` would call it not-a-power-of-ten and
 * refuse every one of the 45 live pairs this check exists to admit.
 */
function isNegativePowerOfTen(value: string): boolean {
  const dot = value.indexOf(".");
  if (dot === -1) return false;
  const whole = value.slice(0, dot).replace(/^0+/, "");
  const fraction = value
    .slice(dot + 1)
    .replace(/0+$/, "")
    .replace(/^0+/, "");
  return whole === "" && fraction === "1";
}

/**
 * Convert Kraken's `tick_size` into `Money`, COARSENING a grid finer than the
 * money scale rather than throwing on it or disabling it.
 *
 * THE PROBLEM. `Money` carries 8 decimal places and `fromDecimalString` refuses
 * more. 45 of 1440 live pairs publish a finer `tick_size` than that: `BONKUSD`
 * is `"0.000000001"` and `ANKRXBT` is `"0.0000000001"`. Read strictly, those 45
 * markets become unreadable.
 *
 * WHY COARSENING IS SOUND HERE AND IS NOT A ROUNDING FUDGE. Every `tick_size`
 * Kraken publishes is an exact power of ten (checked, all 1440). When the
 * published tick is a power of ten FINER than `1e-8`, every multiple of `1e-8`
 * is also a multiple of that tick -- so prices rounded onto the `1e-8` grid are
 * still prices Kraken accepts, exactly. Nothing becomes invalid; the bot simply
 * cannot name the sub-`1e-8` prices between them, which `Money` could not
 * represent under any policy.
 *
 * WHAT IS STILL REFUSED, AND WHY THE POWER-OF-TEN CHECK IS NOT DECORATION. A
 * finer tick that is NOT a power of ten -- say `2.5e-9` -- has no such
 * guarantee: `1e-8` is not a multiple of it, and coarsening would put every
 * price off the venue's grid while this code reported them as on it. Kraken
 * publishes no such value today, so this arm is unreachable against live data
 * and is written for the day it is not.
 *
 * MAPPING TO `ZERO` IS NOT AN OPTION and is worth naming to rule out: `ZERO`
 * means "grid disabled", so it would send unrounded prices straight through the
 * one check meant to catch them. That is the fail-OPEN direction.
 * `gemini/filters.ts`'s `incrementToMoney` refuses its own version of this case
 * for precisely that reason.
 */
function tickSizeToMoney(raw: unknown, pair: Pair): Money {
  if (typeof raw !== "string" || raw === "") {
    throw new FilterError(
      `${pair}: expected tick_size to be a decimal string, got ${
        raw === undefined ? "undefined" : typeof raw
      }`,
    );
  }

  if (significantDecimals(raw) > SCALE) {
    if (!isNegativePowerOfTen(raw)) {
      throw new FilterError(
        `${pair}: tick_size ${JSON.stringify(raw)} is finer than the money scale of ` +
          `${SCALE} decimals and is not a power of ten, so it cannot be coarsened ` +
          `onto a grid Kraken would still accept; refusing to price on a grid this ` +
          `code cannot represent`,
      );
    }
    // Sound by the argument above: every multiple of 1e-8 is also a multiple of
    // a finer power of ten, so prices on this grid stay prices Kraken accepts.
    return FINEST_GRID;
  }

  let grid: Money;
  try {
    // `"exact"` rather than `fromDecimalString` only so that a value padded with
    // insignificant trailing zeros past the scale (`"0.100000000"`) is read as
    // the `0.1` it is. It still throws on real excess precision, which the
    // branch above has already handled, and on a malformed string.
    grid = fromDecimalStringRounded(raw, "exact");
  } catch (cause) {
    throw new FilterError(`${pair}: could not parse tick_size: ${(cause as Error).message}`);
  }
  if (grid <= ZERO) {
    throw new FilterError(
      `${pair}: tick_size ${JSON.stringify(raw)} is not positive; refusing to treat ` +
        `it as a disabled price grid, which would let unrounded prices through`,
    );
  }
  return grid;
}

/**
 * Derive `stepSize` from `lot_decimals` as 10^-n.
 *
 * THERE IS NO STEP FIELD. Kraken publishes the quantity grid only as a count of
 * decimal places, so this is the one filter in this module that is arithmetic
 * rather than a read. Live values are 5 (896 pairs) and 8 (544) and nothing
 * else, both of which `Money` represents exactly.
 *
 * `lot_decimals` finer than the money scale is coarsened to `1e-8` on the same
 * argument `tickSizeToMoney` sets out, and here it needs no power-of-ten check
 * at all: 10^-n IS a power of ten by construction. A non-integer or negative
 * count is not a precision problem but a broken payload, and throws.
 */
function stepSizeFromLotDecimals(raw: unknown, pair: Pair): Money {
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0) {
    throw new FilterError(
      `${pair}: expected lot_decimals to be a non-negative integer, got ` +
        `${JSON.stringify(raw)}; the quantity grid cannot be derived without it`,
    );
  }
  if (raw > SCALE) return FINEST_GRID;
  return 10n ** BigInt(SCALE - raw);
}

/**
 * Read a MINIMUM (`ordermin`, `costmin`) into `Money`, rounding excess precision
 * UP.
 *
 * All 1440 live pairs publish both within the money scale, so this rounding is
 * unreachable against today's data. The direction is chosen for the day it is
 * not: a floor rounded UP is STRICTER than the venue's, so an order this code
 * accepts is one the venue accepts too. Rounding a floor down would be the
 * fail-open direction -- orders sent below a minimum Kraken enforces.
 *
 * `fromDecimalStringRounded` is the right parser here for the reason its own
 * comment gives: these are values the VENUE reports, not values this system
 * sends. `fromDecimalString` remains the only way a price or quantity going back
 * out to an exchange is brought in.
 */
function minimumToMoney(
  source: Readonly<Record<string, unknown>>,
  field: string,
  pair: Pair,
): Money {
  const raw = source[field];
  if (typeof raw !== "string" || raw === "") {
    throw new FilterError(
      `${pair}: expected ${field} to be a decimal string, got ${
        raw === undefined ? "undefined" : typeof raw
      }`,
    );
  }
  try {
    return fromDecimalStringRounded(raw, "ceil");
  } catch (cause) {
    throw new FilterError(`${pair}: could not parse ${field}: ${(cause as Error).message}`);
  }
}

/**
 * Build `SymbolFilters` from one catalogued Kraken pair.
 *
 * The `pair`, `baseAsset` and `quoteAsset` come from the CATALOGUE'S TICKER
 * NAMES, not from Kraken's raw fields: `BTCUSD`/`BTC`/`USD`, never
 * `XXBTZUSD`/`XXBT`/`ZUSD`. That is what makes the result usable by
 * `validateOrder`, which compares `filters.pair` against the order's own `Pair`
 * -- and the catalogue is the only thing that can make that translation without
 * the substring corruption entry 90 PROBLEM 1 documents.
 *
 * `instrument` IS DELIBERATELY ABSENT, not set to `unknown`. Kraken's spot and
 * futures markets live behind separate hosts and AssetPairs carries no field
 * distinguishing them, so there is no value to read and no ambiguity to resolve
 * -- which is the identical situation `binance/filters.ts` is in, and it handles
 * it by omitting the key entirely from the object it returns. `SymbolFilters`
 * documents that absence as meaning "this venue's payload carries no
 * instrument-type field at all", which is a different fact from `unknown` ("the
 * venue sent a value this code cannot map") and is the true one here.
 */
export function parsePairFilters(pair: KrakenPair, fetchedAt: Timestamp): SymbolFilters {
  const entry = pair.raw;
  const name = pair.ticker;

  return {
    pair: name,
    baseAsset: pair.base.ticker,
    quoteAsset: pair.quote.ticker,
    status: mapStatus(entry["status"], name),
    tickSize: tickSizeToMoney(entry["tick_size"], name),
    stepSize: stepSizeFromLotDecimals(entry["lot_decimals"], name),
    minQuantity: minimumToMoney(entry, "ordermin", name),
    minNotional: minimumToMoney(entry, "costmin", name),
    // Kraken publishes none of these four. ZERO is the shared "disabled".
    minPrice: DISABLED,
    maxPrice: DISABLED,
    maxQuantity: DISABLED,
    maxNotional: DISABLED,
    fetchedAt,
  };
}

/**
 * Filters for one pair, by ANY of its four Kraken names.
 *
 * `fetchedAt` is the CATALOGUE's fetch time, and honestly so: these filters are
 * exactly as old as the AssetPairs document they were read out of. Stamping them
 * `now` would make an hour-old catalogue present itself as fresh filters and
 * defeat `SymbolFilterCache`'s staleness check.
 *
 * Throws via `requirePair` on a name Kraken does not list -- see `catalogue.ts`
 * on why that is never softened into a derived name.
 */
export function symbolFiltersFor(catalogue: KrakenCatalogue, name: string): SymbolFilters {
  return parsePairFilters(catalogue.requirePair(name), catalogue.fetchedAt);
}

/**
 * Filters for every catalogued pair, with the unusable ones RECORDED rather than
 * thrown or hidden.
 *
 * The same failure split `buildKrakenCatalogue` makes, for the same reason: one
 * malformed listing out of 1440 must not take down the other 1439, and it must
 * not vanish silently either. A caller that wants a specific pair still gets a
 * loud throw from `symbolFiltersFor`.
 */
export function allSymbolFilters(catalogue: KrakenCatalogue): {
  filters: SymbolFilters[];
  omitted: CatalogueOmission[];
} {
  const filters: SymbolFilters[] = [];
  const omitted: CatalogueOmission[] = [];
  for (const pair of catalogue.pairs()) {
    try {
      filters.push(parsePairFilters(pair, catalogue.fetchedAt));
    } catch (cause) {
      omitted.push({ key: pair.canonical, reason: (cause as Error).message });
    }
  }
  return { filters, omitted };
}

/**
 * The tickers of every pair currently trading normally.
 *
 * Leaner than `allSymbolFilters` and lenient in the same way `binance/filters.ts`
 * `parseTradablePairs` is: a pair whose status this code cannot map is EXCLUDED
 * rather than thrown over, because one unrecognised state among 1440 listings
 * must not refuse the whole list, and a pair that cannot be judged tradable is
 * not a pair to report as tradable. That leniency is safe HERE and only here --
 * this function answers "which markets are open", where omission is the
 * fail-closed direction. The order path calls `symbolFiltersFor`, which throws.
 */
export function tradablePairs(catalogue: KrakenCatalogue): Pair[] {
  const open: Pair[] = [];
  for (const pair of catalogue.pairs()) {
    // Deliberately routed through `mapStatus` rather than comparing to `"online"`
    // directly. The two are equivalent today, and that is exactly the trap: the
    // fail-closed policy would then live in two places and could drift in one.
    try {
      if (mapStatus(pair.raw["status"], pair.ticker) === "TRADING") open.push(pair.ticker);
    } catch {
      // Unrecognised state: not reportable as tradable, not a reason to refuse
      // the other 1439. See the note above.
    }
  }
  return open;
}

/**
 * `10^-n` as a decimal string, for tests and logs that want to state the derived
 * quantity grid in Kraken's own vocabulary.
 *
 * Exported because `stepSize` is the one filter with no field behind it, so the
 * derivation is the thing a reader will want to check.
 */
export function lotDecimalsToStepString(lotDecimals: number): string {
  if (!Number.isInteger(lotDecimals) || lotDecimals < 0) {
    throw new FilterError(`lot_decimals must be a non-negative integer, got ${lotDecimals}`);
  }
  if (lotDecimals === 0) return "1";
  return `0.${"0".repeat(lotDecimals - 1)}1`;
}
