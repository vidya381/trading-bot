/**
 * Symbol details and order validation for Gemini (spec section 4.3).
 *
 * Two responsibilities, split exactly as on the Binance side:
 *
 *  1. Turn Gemini's `symbols/details` payload into the shared `SymbolFilters`.
 *     This part is Gemini-specific and lives here (`parseSymbolDetails`).
 *  2. Validate and round a price and quantity against those filters. This part
 *     is NOT exchange-specific -- `validateOrder` and `SymbolFilterCache` operate
 *     purely on `SymbolFilters` (a shared type) and `Money`. They are re-exported
 *     from the Binance module so there is a single implementation rather than a
 *     copy, and so the Gemini client imports everything filter-shaped from HERE
 *     and never reaches across into `../binance` directly.
 *
 * Placing that shared validator physically under `binance/` is a historical
 * accident of step 3 (there was only one exchange then). Hoisting it to a neutral
 * `src/exchange/filters.ts` is a clean future refactor, deliberately deferred so
 * this step stays purely additive and does not churn Binance's files or tests --
 * see the decision log.
 *
 * The trap this file exists to get right: Gemini's `symbols/details` field names
 * are INVERTED relative to intuition and to ours. Verified against Gemini's own
 * reference, `tick_size` is the increment of the BASE currency (the order amount)
 * and `quote_increment` is the increment of the QUOTE currency (the price). So
 * Gemini's `tick_size` maps to our `stepSize` (quantity), and Gemini's
 * `quote_increment` maps to our `tickSize` (price). Reading them the way the
 * names suggest would swap the price and quantity grids on every symbol.
 */

import type {
  Pair,
  SymbolFilters,
  SymbolStatus,
  Timestamp,
} from "../../shared/exchange-client";
import { fromDecimalString, ZERO, type Money } from "../../shared/money";

// Re-export the exchange-agnostic validator and cache so callers depend on this
// module, not on Binance's. These operate on the shared `SymbolFilters`/`Money`
// and contain nothing Binance-specific.
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

/** A bound Gemini does not publish, expressed with the shared "zero disables"
 *  convention so `validateOrder` skips it. */
const DISABLED = ZERO;

/**
 * Map Gemini's order-book status onto the shared `SymbolStatus`.
 *
 * Gemini's values (`open`, `closed`, `cancel_only`, `post_only`, `limit_only`)
 * do not match the exchange-neutral enum's Binance-derived names, so they are
 * translated rather than passed through:
 *
 *  - `open`       -> TRADING
 *  - `limit_only` -> TRADING. Only limit orders are accepted, which is all this
 *                    bot ever places (section 4.5), so orders can be placed.
 *  - `post_only`  -> TRADING. Only non-marketable (maker) limit orders are
 *                    accepted; the resting ladder orders sections 6.2/6.3 place
 *                    are makers, so they can be placed. A marketable order would
 *                    be refused by Gemini and surface as an `exchange_error`
 *                    outcome -- honest, not silent.
 *  - `cancel_only`-> CANCEL_ONLY. No new orders; the shared enum has this exact
 *                    state and `validateOrder` rejects any order under it.
 *  - `closed`     -> HALT. Not trading at all.
 *
 * An unrecognised status throws, matching the Binance filter parser: an unknown
 * value means Gemini changed its enum and this code can no longer judge whether
 * the symbol is tradable, which is not something to guess about (a quiet "assume
 * untradable" would leave a bot inexplicably idle; a loud failure becomes an
 * alert with a real cause under section 7.5).
 */
function mapStatus(raw: unknown, pair: Pair): SymbolStatus {
  switch (raw) {
    case "open":
    case "limit_only":
    case "post_only":
      return "TRADING";
    case "cancel_only":
      return "CANCEL_ONLY";
    case "closed":
      return "HALT";
    default:
      throw new FilterError(
        `${pair}: unrecognised Gemini symbol status ${JSON.stringify(raw)}; ` +
          `refusing to guess whether the symbol is tradable`,
      );
  }
}

/**
 * Convert a symbol-detail increment into `Money`, whether string or number.
 *
 * `min_order_size` is a decimal STRING (`"0.00001"`), but `tick_size` and
 * `quote_increment` are JSON NUMBERS, one of them in scientific notation
 * (`1e-8`) -- confirmed verbatim from Gemini's reference. A JSON number has
 * already been through the float parser, so to keep it out of the money path it
 * is re-rendered to a plain decimal string via `Number.prototype.toFixed` at the
 * money scale (8) and then parsed the normal way.
 *
 * This is safe for exactly the values Gemini publishes: grid increments at or
 * coarser than 1e-8, which `toFixed(8)` renders exactly (`1e-8` ->
 * `"0.00000001"`, `0.01` -> `"0.01000000"`). An increment FINER than the money
 * scale would render to `"0.00000000"`; that is refused rather than silently
 * treated as a disabled (zero) grid, because a zero step would make
 * `roundToStep` reject every order on the symbol and the cause would be invisible.
 *
 * A `number` is admitted here, unlike in `parse.ts`'s `requireMoney`, precisely
 * because Gemini genuinely sends these two metadata fields as numbers -- it is a
 * deliberate, narrow exception, not a monetary amount slipping through.
 */
function incrementToMoney(value: unknown, field: string, pair: Pair): Money {
  if (typeof value === "string") {
    try {
      return fromDecimalString(value);
    } catch (cause) {
      throw new FilterError(`${pair}: could not parse ${field}: ${(cause as Error).message}`);
    }
  }
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    const asMoney = fromDecimalString(value.toFixed(8));
    if (asMoney === ZERO) {
      throw new FilterError(
        `${pair}: ${field} (${value}) is finer than the money scale of 8 decimals; ` +
          `refusing to round it to a zero (disabled) grid`,
      );
    }
    return asMoney;
  }
  throw new FilterError(
    `${pair}: expected ${field} to be a positive decimal string or number, got ${typeof value}`,
  );
}

/**
 * Build `SymbolFilters` from a `GET /v1/symbols/details/:symbol` payload.
 *
 * The INVERSION is applied here and is the whole reason this function is worth
 * reading carefully:
 *
 *   Gemini `tick_size`       (base-currency increment) -> our `stepSize`  (quantity)
 *   Gemini `quote_increment` (quote-currency increment) -> our `tickSize` (price)
 *   Gemini `min_order_size`  (base-currency units)      -> our `minQuantity`
 *
 * Gemini publishes no price bounds, no quantity ceiling and no notional bounds in
 * symbol details, so those are left DISABLED (zero) under the shared convention,
 * exactly as a Binance symbol without those filters would be.
 */
export function parseSymbolDetails(body: unknown, fetchedAt: Timestamp): SymbolFilters {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    // Same defect `parse.ts`'s `describeShape` was written for: `typeof []` is
    // "object", so the old message here could also say the useless "expected an
    // object, got object". Naming the real shape is what makes such a failure
    // diagnosable from the alert text alone.
    const shape = Array.isArray(body)
      ? `an array of ${body.length}`
      : body === null
        ? "null"
        : `a ${typeof body}`;
    throw new FilterError(`symbol details: expected a single object, got ${shape}`);
  }
  const record = body as Record<string, unknown>;

  const pair = record["symbol"];
  if (typeof pair !== "string" || pair === "") {
    throw new FilterError("symbol details: missing symbol name");
  }

  const baseAsset = record["base_currency"];
  const quoteAsset = record["quote_currency"];
  if (typeof baseAsset !== "string" || typeof quoteAsset !== "string") {
    throw new FilterError(`${pair}: missing base_currency or quote_currency`);
  }

  return {
    pair,
    baseAsset,
    quoteAsset,
    status: mapStatus(record["status"], pair),
    // INVERTED on purpose -- see the function and file headers.
    tickSize: incrementToMoney(record["quote_increment"], "quote_increment", pair),
    stepSize: incrementToMoney(record["tick_size"], "tick_size", pair),
    minQuantity: incrementToMoney(record["min_order_size"], "min_order_size", pair),
    minPrice: DISABLED,
    maxPrice: DISABLED,
    maxQuantity: DISABLED,
    minNotional: DISABLED,
    maxNotional: DISABLED,
    fetchedAt,
  };
}

/**
 * The pair name Gemini expects in a request path/payload: lower case, no
 * separator (e.g. `BTCUSD` or `btc-usd` -> `btcusd`).
 *
 * Gemini's request side is case-insensitive but conventionally lower case, while
 * `symbols/details` echoes the symbol in upper case. Normalising at the edge lets
 * the rest of the system carry the `Pair` however a bot's config names it without
 * the client caring. Exported and pure so a test can pin it.
 */
export function toGeminiSymbol(pair: Pair): string {
  return pair.replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
}
