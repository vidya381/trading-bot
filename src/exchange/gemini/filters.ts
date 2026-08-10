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
  InstrumentKind,
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
 * Read Gemini's INSTRUMENT TYPE off a `symbols/details` payload.
 *
 * These two fields are real structured data, documented by Gemini as such, and
 * this parser has been receiving them and throwing them away since step 3.4.
 * From their reference for `GET /v1/symbols/details/:symbol`:
 *
 *   product_type   "Instrument type `spot` / `swap`"   (swap == perpetual)
 *   contract_type  "`vanilla` / `linear` / `inverse`"
 *
 * and their own spot example is `"product_type": "spot", "contract_type":
 * "vanilla"` while a perpetual is `swap` + `linear`/`inverse`.
 *
 * ── WHY `product_type` DECIDES AND `contract_type` ONLY CORROBORATES ──
 *
 * `product_type` is the field that literally means "instrument type" and has
 * exactly two documented values, one of which is the question being asked.
 * `contract_type` describes a contract's settlement MATHS (linear settles in the
 * quote currency, inverse in the base), and `vanilla` is what Gemini writes for
 * the case where there is no contract at all. So `product_type` is the direct
 * answer and `contract_type` is a second opinion about it.
 *
 * They are still BOTH read, because a disagreement between them is information:
 * `product_type: "spot"` alongside `contract_type: "linear"` is a payload no
 * documented instrument produces, and mapping it to `spot` on the strength of
 * the first field would be this code deciding it understands Gemini better than
 * Gemini does. That maps to `unknown`, which refuses -- the same posture
 * `mapStatus` takes on an unrecognised status and `parseStatus` takes on the
 * Binance side.
 *
 * A MISSING `contract_type` is NOT a disagreement and does not refuse:
 * `product_type` alone is a complete answer. A missing `product_type` IS
 * refused, via `unknown`, because that is the field that answers the question.
 *
 * ── THE COMPARISON IS EXACT AND LOWER-CASE, AND THAT IS DELIBERATE ──
 *
 * Gemini documents these values in lower case (`spot`, `swap`, `vanilla`) and
 * this compares against them exactly, with no case folding. Step 28's live run
 * established the rule for the SYMBOL side -- `btcusd` was refused because the
 * catalogue spells it `BTCUSD` -- and the reasoning carries: a case-insensitive
 * match here would accept `"SPOT"`, `"Spot"` and `"sPoT"` as though this code
 * had seen them in a real payload, when it has seen none of them. If Gemini ever
 * changes the casing, the honest outcome is `unknown` and a loud refusal naming
 * the value received, not a silent acceptance.
 */
export function parseInstrumentKind(record: Record<string, unknown>): InstrumentKind {
  const productType = record["product_type"];
  const contractType = record["contract_type"];

  // A contract type that names a real contract settles the question on its own:
  // `linear` and `inverse` are Gemini's two perpetual settlement conventions and
  // neither exists for a spot pair.
  if (contractType === "linear" || contractType === "inverse") return "derivative";

  if (productType === "swap") return "derivative";

  if (productType === "spot") {
    // Absent is fine (see above); present-and-not-`vanilla` is a contradiction,
    // and `linear`/`inverse` have already been caught, so anything reaching here
    // that is not `undefined` and not `vanilla` is a value this code cannot map.
    if (contractType === undefined || contractType === "vanilla") return "spot";
    return "unknown";
  }

  return "unknown";
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
    // Read rather than discarded, as of the bot-creation tradability gate.
    // Unlike `mapStatus`, an unrecognised value here does NOT throw: the caller
    // that cares (`checkSpotInstrument`) refuses on `unknown` with a message
    // naming the instrument, and a throw would take down `getSymbolFilters` for
    // the order path too -- where these fields have never been needed and where
    // section 4.3's validation must keep working for every existing bot.
    instrument: parseInstrumentKind(record),
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
