/**
 * Order filter validation (spec section 4.3).
 *
 * Two responsibilities:
 *  1. Turn the exchange's `exchangeInfo` payload into `SymbolFilters`.
 *  2. Validate and round a price and quantity against those filters.
 *
 * Section 4.3 requires the check to happen twice, at two independent points:
 * once before an order is constructed, and again immediately before it is sent.
 * `validateOrder` is a pure function over explicit inputs precisely so both call
 * sites can use it -- there is no hidden state that would make a second call
 * behave differently from the first.
 *
 * The two calls are not identical, though, and the `rounding` mode is the
 * difference. At construction the job is to move a value onto the exchange's
 * grid; before sending, the job is to confirm it is still there. Rounding again
 * at send time would silently repair a corrupted price instead of reporting it,
 * which would defeat the point of checking twice.
 */

import type {
  OrderSide,
  Pair,
  SymbolFilters,
  SymbolStatus,
  Timestamp,
} from "../../shared/exchange-client";
import {
  fromDecimalString,
  isMultipleOf,
  mul,
  roundToStep,
  ZERO,
  type Money,
} from "../../shared/money";

export class FilterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FilterError";
  }
}

/** How long cached filters stay usable. Section 4.3: refresh periodically. */
export const DEFAULT_FILTER_MAX_AGE_MS = 3_600_000;

const SYMBOL_STATUSES: readonly SymbolStatus[] = [
  "TRADING",
  "END_OF_DAY",
  "HALT",
  "BREAK",
  "CANCEL_ONLY",
];

/**
 * A bound the exchange has switched off.
 *
 * The published filter rules state that a price bound of zero disables that
 * rule rather than setting it to zero. Treating a disabled bound as a real one
 * would reject every order on a symbol with no maximum price, since no price is
 * at or below zero.
 */
const DISABLED = ZERO;

/** Read a decimal-string field, defaulting to a disabled bound when absent. */
function optionalMoney(
  source: Record<string, unknown>,
  field: string,
  context: string,
): Money {
  const raw = source[field];
  if (raw === undefined || raw === null) return DISABLED;
  if (typeof raw !== "string") {
    throw new FilterError(
      `${context}: expected ${field} to be a decimal string, got ${typeof raw}`,
    );
  }
  try {
    return fromDecimalString(raw);
  } catch (cause) {
    throw new FilterError(
      `${context}: could not parse ${field}: ${(cause as Error).message}`,
    );
  }
}

function parseStatus(raw: unknown, pair: Pair): SymbolStatus {
  if (typeof raw === "string" && (SYMBOL_STATUSES as readonly string[]).includes(raw)) {
    return raw as SymbolStatus;
  }
  // Deliberately loud. An unrecognised status means the exchange has changed its
  // enum, and this code can no longer judge whether the symbol is tradable.
  // Quietly treating it as untradable would leave a bot permanently and
  // inexplicably idle; failing here surfaces as an alert with a real cause.
  throw new FilterError(
    `${pair}: unrecognised symbol status ${JSON.stringify(raw)}; ` +
      `refusing to guess whether the symbol is tradable`,
  );
}

/**
 * Build `SymbolFilters` from one entry of `exchangeInfo`'s `symbols` array.
 *
 * The payload carries filters as a heterogeneous array of tagged objects, of
 * which only three matter for the limit orders section 4.5 restricts v1 to:
 * the price rules, the quantity rules, and the notional range. Every other
 * filter type is ignored rather than rejected, since the exchange adds them
 * over time and an unknown one is not a reason to refuse to trade a symbol.
 *
 * Two notional filters exist. The older one sets only a floor; the current one
 * sets a range. Symbols carry one or the other depending on age, so both are
 * read and the current one wins if somehow both appear.
 */
export function parseSymbolFilters(
  symbol: Record<string, unknown>,
  fetchedAt: Timestamp,
): SymbolFilters {
  const pair = symbol["symbol"];
  if (typeof pair !== "string" || pair === "") {
    throw new FilterError("exchangeInfo symbol entry has no usable symbol name");
  }

  const baseAsset = symbol["baseAsset"];
  const quoteAsset = symbol["quoteAsset"];
  if (typeof baseAsset !== "string" || typeof quoteAsset !== "string") {
    throw new FilterError(`${pair}: missing baseAsset or quoteAsset`);
  }

  const rawFilters = symbol["filters"];
  const filterList: Record<string, unknown>[] = Array.isArray(rawFilters)
    ? (rawFilters as Record<string, unknown>[])
    : [];

  const byType = new Map<string, Record<string, unknown>>();
  for (const filter of filterList) {
    const type = filter["filterType"];
    if (typeof type === "string") byType.set(type, filter);
  }

  const price = byType.get("PRICE_FILTER") ?? {};
  const lot = byType.get("LOT_SIZE") ?? {};
  const notional = byType.get("NOTIONAL");
  const legacyNotional = byType.get("MIN_NOTIONAL");

  const minNotional =
    notional !== undefined
      ? optionalMoney(notional, "minNotional", pair)
      : legacyNotional !== undefined
        ? optionalMoney(legacyNotional, "minNotional", pair)
        : DISABLED;

  // The legacy filter has no ceiling at all, so a symbol carrying only that one
  // is correctly left with no maximum.
  const maxNotional =
    notional !== undefined ? optionalMoney(notional, "maxNotional", pair) : DISABLED;

  return {
    pair,
    baseAsset,
    quoteAsset,
    status: parseStatus(symbol["status"], pair),
    tickSize: optionalMoney(price, "tickSize", pair),
    minPrice: optionalMoney(price, "minPrice", pair),
    maxPrice: optionalMoney(price, "maxPrice", pair),
    stepSize: optionalMoney(lot, "stepSize", pair),
    minQuantity: optionalMoney(lot, "minQty", pair),
    maxQuantity: optionalMoney(lot, "maxQty", pair),
    minNotional,
    maxNotional,
    fetchedAt,
  };
}

/** Build filters for every symbol in an `exchangeInfo` response. */
export function parseExchangeInfo(
  body: unknown,
  fetchedAt: Timestamp,
): SymbolFilters[] {
  const symbols = (body as Record<string, unknown> | null)?.["symbols"];
  if (!Array.isArray(symbols)) {
    throw new FilterError("exchangeInfo response has no symbols array");
  }
  return symbols.map((symbol) =>
    parseSymbolFilters(symbol as Record<string, unknown>, fetchedAt),
  );
}

/**
 * The names of every currently-tradable pair in an `exchangeInfo` response.
 *
 * Deliberately leaner than `parseExchangeInfo`: it reads only each entry's
 * `symbol` and `status`, not its filters or assets. A full catalogue runs to
 * thousands of symbols in every state the venue has, and `listTradablePairs`
 * wants the pair NAMES, not their order-validation rules -- forcing the whole
 * catalogue through `parseSymbolFilters` (which throws on any entry missing a
 * baseAsset, quoteAsset or recognised status) would let one odd delisted symbol
 * refuse the entire list. So a non-`TRADING` or nameless entry is simply
 * excluded -- it is not a tradable pair -- rather than throwing. Only the
 * top-level shape being wrong (`symbols` not an array) is loud, since that is a
 * genuine API change, not one bad row.
 */
export function parseTradablePairs(body: unknown): Pair[] {
  const symbols = (body as Record<string, unknown> | null)?.["symbols"];
  if (!Array.isArray(symbols)) {
    throw new FilterError("exchangeInfo response has no symbols array");
  }
  const pairs: Pair[] = [];
  for (const entry of symbols) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const name = record["symbol"];
    if (record["status"] === "TRADING" && typeof name === "string" && name !== "") {
      pairs.push(name);
    }
  }
  return pairs;
}

/**
 * Reason an order cannot be sent as specified.
 *
 * Each is a distinct, loggable cause rather than a generic rejection, because
 * section 4.3 requires the reason to be recorded when an action is skipped --
 * and "below minimum notional" calls for a different response from "the symbol
 * is halted".
 */
export type OrderRejectionCode =
  /** The symbol is not currently accepting orders. */
  | "symbol_not_trading"
  /** Price or quantity was zero or negative before any rounding. */
  | "non_positive_input"
  /** Rounding to the tick or step produced zero. */
  | "rounded_to_zero"
  | "price_below_min"
  | "price_above_max"
  | "quantity_below_min"
  | "quantity_above_max"
  | "notional_below_min"
  | "notional_above_max"
  /** In `verify` mode: the value is not on the exchange's grid. */
  | "price_off_tick"
  | "quantity_off_step";

export type OrderValidation =
  | {
      valid: true;
      /** Price to send, rounded onto the tick grid. */
      price: Money;
      /** Quantity to send, rounded down onto the step grid. */
      quantity: Money;
      /** price x quantity, the value checked against the notional bounds. */
      notional: Money;
      /** True if rounding changed either input. */
      adjusted: boolean;
    }
  | {
      valid: false;
      code: OrderRejectionCode;
      /** Human-readable cause, for the log line section 4.3 asks for. */
      reason: string;
      /** The values as they stood when the check failed, for that same log. */
      price: Money;
      quantity: Money;
      notional: Money;
    };

/**
 * What to do with a value that is not already on the exchange's grid.
 *
 * `adjust` rounds it on. `verify` reports it as invalid. Section 4.3's first
 * check wants the former and its second, independent check wants the latter.
 */
export type FilterRoundingMode = "adjust" | "verify";

export interface ValidateOrderInput {
  pair: Pair;
  side: OrderSide;
  price: Money;
  quantity: Money;
}

/**
 * Rounding direction for a price, by side.
 *
 * Each side rounds away from the trader's own interest in the price: a buy is
 * placed no higher than asked, a sell no lower. The alternative -- rounding both
 * to nearest -- would occasionally move a buy up and a sell down, paying a tick
 * for tidiness at every grid level.
 */
function priceRounding(side: OrderSide): "floor" | "ceil" {
  return side === "buy" ? "floor" : "ceil";
}

/**
 * Validate and round a price and quantity against a symbol's filters.
 *
 * Pure, and the same function for both of section 4.3's checks.
 */
export function validateOrder(
  input: ValidateOrderInput,
  filters: SymbolFilters,
  options: { rounding?: FilterRoundingMode } = {},
): OrderValidation {
  const mode = options.rounding ?? "adjust";

  if (filters.pair !== input.pair) {
    throw new FilterError(
      `filters are for ${filters.pair} but the order is for ${input.pair}`,
    );
  }

  // Quantity rounds DOWN unconditionally, on either side. Rounding a quantity up
  // can ask for more of the base asset than the account holds, and the exchange
  // rejects the whole order rather than trimming it.
  const reject = (
    code: OrderRejectionCode,
    reason: string,
    price: Money,
    quantity: Money,
    notional: Money,
  ): OrderValidation => ({ valid: false, code, reason, price, quantity, notional });

  const notionalOf = (price: Money, quantity: Money): Money =>
    // Floor: the conservative direction for the minimum-notional check, which is
    // the bound that actually rejects orders in practice. At scale 8 the
    // discarded remainder is below 1e-8 and cannot affect the maximum.
    mul(price, quantity, "floor");

  if (filters.status !== "TRADING") {
    return reject(
      "symbol_not_trading",
      `${input.pair} is ${filters.status}, not TRADING; no order may be placed`,
      input.price,
      input.quantity,
      notionalOf(input.price, input.quantity),
    );
  }

  if (input.price <= ZERO || input.quantity <= ZERO) {
    return reject(
      "non_positive_input",
      `price and quantity must both be positive, got price=${input.price} ` +
        `quantity=${input.quantity}`,
      input.price,
      input.quantity,
      ZERO,
    );
  }

  let price = input.price;
  let quantity = input.quantity;

  if (filters.tickSize > DISABLED) {
    if (mode === "verify") {
      if (!isMultipleOf(price, filters.tickSize)) {
        return reject(
          "price_off_tick",
          `price ${price} is not a multiple of tickSize ${filters.tickSize}; ` +
            `it was not rounded, or was altered after being rounded`,
          price,
          quantity,
          notionalOf(price, quantity),
        );
      }
    } else {
      price = roundToStep(price, filters.tickSize, priceRounding(input.side));
    }
  }

  if (filters.stepSize > DISABLED) {
    if (mode === "verify") {
      if (!isMultipleOf(quantity, filters.stepSize)) {
        return reject(
          "quantity_off_step",
          `quantity ${quantity} is not a multiple of stepSize ${filters.stepSize}; ` +
            `it was not rounded, or was altered after being rounded`,
          price,
          quantity,
          notionalOf(price, quantity),
        );
      }
    } else {
      quantity = roundToStep(quantity, filters.stepSize, "floor");
    }
  }

  const notional = notionalOf(price, quantity);

  // Rounding down can take a small quantity to nothing at all. Caught explicitly
  // so the log says the quantity vanished rather than reporting it as below the
  // minimum, which would suggest a different fix.
  if (price <= ZERO || quantity <= ZERO) {
    return reject(
      "rounded_to_zero",
      `rounding to the symbol's tick and step took price=${input.price} ` +
        `quantity=${input.quantity} down to price=${price} quantity=${quantity}`,
      price,
      quantity,
      notional,
    );
  }

  if (filters.minPrice > DISABLED && price < filters.minPrice) {
    return reject(
      "price_below_min",
      `price ${price} is below the symbol's minimum ${filters.minPrice}`,
      price,
      quantity,
      notional,
    );
  }

  if (filters.maxPrice > DISABLED && price > filters.maxPrice) {
    return reject(
      "price_above_max",
      `price ${price} is above the symbol's maximum ${filters.maxPrice}`,
      price,
      quantity,
      notional,
    );
  }

  if (filters.minQuantity > DISABLED && quantity < filters.minQuantity) {
    return reject(
      "quantity_below_min",
      `quantity ${quantity} is below the symbol's minimum ${filters.minQuantity}`,
      price,
      quantity,
      notional,
    );
  }

  if (filters.maxQuantity > DISABLED && quantity > filters.maxQuantity) {
    return reject(
      "quantity_above_max",
      `quantity ${quantity} is above the symbol's maximum ${filters.maxQuantity}`,
      price,
      quantity,
      notional,
    );
  }

  if (filters.minNotional > DISABLED && notional < filters.minNotional) {
    return reject(
      "notional_below_min",
      `notional ${notional} (price x quantity) is below the symbol's minimum ` +
        `${filters.minNotional}; section 4.3 requires this order be skipped, not sent`,
      price,
      quantity,
      notional,
    );
  }

  if (filters.maxNotional > DISABLED && notional > filters.maxNotional) {
    return reject(
      "notional_above_max",
      `notional ${notional} (price x quantity) is above the symbol's maximum ` +
        `${filters.maxNotional}`,
      price,
      quantity,
      notional,
    );
  }

  return {
    valid: true,
    price,
    quantity,
    notional,
    adjusted: price !== input.price || quantity !== input.quantity,
  };
}

/**
 * Cached symbol filters, with an age (section 4.3: refresh periodically).
 *
 * Holds no timer and fetches nothing. It reports staleness and the client
 * decides to refetch, which keeps every expiry boundary reproducible in a test
 * and keeps the one place that performs I/O in the client.
 */
export class SymbolFilterCache {
  readonly #entries = new Map<Pair, SymbolFilters>();
  readonly #maxAgeMs: number;

  constructor(options: { maxAgeMs?: number } = {}) {
    const maxAge = options.maxAgeMs ?? DEFAULT_FILTER_MAX_AGE_MS;
    if (!Number.isFinite(maxAge) || maxAge <= 0) {
      throw new FilterError(`maxAgeMs must be positive, got ${maxAge}`);
    }
    this.#maxAgeMs = maxAge;
  }

  get maxAgeMs(): number {
    return this.#maxAgeMs;
  }

  put(filters: SymbolFilters): void {
    this.#entries.set(filters.pair, filters);
  }

  /** Cached filters if present AND still fresh; otherwise undefined. */
  get(pair: Pair, now: Timestamp): SymbolFilters | undefined {
    const entry = this.#entries.get(pair);
    if (entry === undefined) return undefined;
    return this.isStale(entry, now) ? undefined : entry;
  }

  /**
   * Cached filters regardless of age.
   *
   * Separate from `get` so that using stale filters is always a deliberate act
   * at the call site rather than something that happens by default.
   */
  peek(pair: Pair): SymbolFilters | undefined {
    return this.#entries.get(pair);
  }

  isStale(filters: SymbolFilters, now: Timestamp): boolean {
    return now - filters.fetchedAt >= this.#maxAgeMs;
  }

  /** Drop one pair, or everything. */
  invalidate(pair?: Pair): void {
    if (pair === undefined) this.#entries.clear();
    else this.#entries.delete(pair);
  }
}
