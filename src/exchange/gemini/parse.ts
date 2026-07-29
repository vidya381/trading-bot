/**
 * Translating Gemini payloads into this system's types.
 *
 * Confirmed field-by-field against Gemini's published REST reference, because
 * the task was explicit that Gemini's shapes do NOT translate directly from
 * Binance's -- and they do not. The corrections that matter:
 *
 *  - Order state is a pair of BOOLEAN FLAGS (`is_live`, `is_cancelled`), not a
 *    status string. There is no `"FILLED"`/`"NEW"` enum to map; `toOrderState`
 *    below derives the state from the flags plus fill progress.
 *  - A fill's fee is `fee_amount` in `fee_currency` (Binance: `commission` /
 *    `commissionAsset`), and its id is `tid` (Binance: `tradeId`).
 *  - A balance reports `amount` (total) and `available`; the reserved figure is
 *    `amount - available` (Binance reports `free`/`locked` directly).
 *  - There is no cumulative-quote field; it is derived as
 *    `avg_execution_price * executed_amount`.
 *
 * As on the Binance side, every monetary value Gemini sends is a decimal STRING
 * and goes straight into `fromDecimalString`; no price, quantity, fee or balance
 * is ever a JavaScript `number` in this file. Identifiers (`order_id`, `tid`) and
 * `nonce`/timestamp fields are the documented exception -- Gemini sends some of
 * those as JSON numbers, so they arrive already through the float parser; they
 * are stringified immediately and only ever compared, never summed.
 */

import type {
  Balance,
  Fill,
  OrderResult,
  OrderSide,
  OrderStatus,
  Pair,
  Price,
  Timestamp,
} from "../../shared/exchange-client";
import type { ExchangeOutcome } from "../../shared/downtime";
import { classifyStatus } from "../../shared/downtime";
import type { OrderState } from "../../shared/order-state";
import { fromDecimalString, mul, ZERO, type Money } from "../../shared/money";

export class ParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ParseError";
  }
}

// ---------------------------------------------------------------------------
// Error bodies
// ---------------------------------------------------------------------------

/**
 * A Gemini error body: `{ "result": "error", "reason": ..., "message": ... }`.
 *
 * Unlike Binance's `{code, msg}`, the discriminator is a `result` field and the
 * machine-readable part is a string `reason` (e.g. `"InvalidNonce"`,
 * `"RateLimit"`, `"InsufficientFunds"`), not a numeric code.
 */
export interface GeminiErrorBody {
  reason: string;
  message: string;
}

/** Read the `{result:"error", reason, message}` body, if the response was one. */
export function readErrorBody(body: unknown): GeminiErrorBody | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const record = body as Record<string, unknown>;
  if (record["result"] !== "error") return undefined;
  return {
    reason: typeof record["reason"] === "string" ? record["reason"] : "",
    message: typeof record["message"] === "string" ? record["message"] : "",
  };
}

/**
 * A stale nonce. Retryable: the next request generates a fresh, higher nonce.
 *
 * Called out by name because it is the one 4xx Gemini reason that a plain
 * `classifyStatus` would mark non-retryable but which genuinely clears on its
 * own -- the analogue of Binance's `-1021 INVALID_TIMESTAMP`, except Gemini fixes
 * it by advancing the nonce rather than by re-syncing a clock.
 */
export const INVALID_NONCE_REASON = "InvalidNonce";

/** The order was not found -- the definitive answer for a status lookup. */
export const ORDER_NOT_FOUND_REASONS: ReadonlySet<string> = new Set([
  "OrderNotFound",
]);

/**
 * Rate-limited. Gemini returns HTTP 429 with this reason; `classifyStatus`
 * already treats 429 as a retryable `exchange_error`, so this constant exists for
 * readability and for callers that want to branch on the reason.
 */
export const RATE_LIMIT_REASON = "RateLimit";

/**
 * Classify a failed Gemini response into an `ExchangeOutcome`.
 *
 * Builds on the shared `classifyStatus` (which already routes 5xx and 429
 * correctly) and then corrects the one 4xx reason whose HTTP status understates
 * how recoverable it is: a stale nonce is retryable once a higher nonce is used.
 *
 * Deliberately NARROWER than Binance's `classifyFailure`: Binance had `-1006`/
 * `-1007` codes meaning "execution status unknown" that had to be lifted to
 * `transport` so a possibly-resting order was recovered rather than assumed gone.
 * Gemini publishes no such ambiguous-execution reason -- a request that reaches
 * Gemini gets a definite answer, and a request that does NOT reach it throws and
 * is handled by `classifyThrown` (transport, unknown effect) in the client. So
 * there is no reclassification of a returned 4xx to `transport` here, and adding
 * one speculatively would be guessing.
 */
export function classifyFailure<T>(
  status: number,
  at: Timestamp,
  body: unknown,
): Extract<ExchangeOutcome<T>, { ok: false }> {
  const error = readErrorBody(body);
  const outcome = classifyStatus<T>(status, at, {
    message:
      error === undefined ? undefined : `${error.message} (${error.reason})`,
  }) as Extract<ExchangeOutcome<T>, { ok: false }>;

  if (error === undefined) return outcome;

  if (error.reason === INVALID_NONCE_REASON) {
    return { ...outcome, retryable: true };
  }

  return outcome;
}

// ---------------------------------------------------------------------------
// Field readers
// ---------------------------------------------------------------------------

function asRecord(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ParseError(`${context}: expected an object, got ${typeof value}`);
  }
  return value as Record<string, unknown>;
}

function requireString(
  source: Record<string, unknown>,
  field: string,
  context: string,
): string {
  const value = source[field];
  if (typeof value !== "string") {
    throw new ParseError(
      `${context}: expected ${field} to be a string, got ${typeof value}`,
    );
  }
  return value;
}

function requireBoolean(
  source: Record<string, unknown>,
  field: string,
  context: string,
): boolean {
  const value = source[field];
  if (typeof value !== "boolean") {
    throw new ParseError(
      `${context}: expected ${field} to be a boolean, got ${typeof value}`,
    );
  }
  return value;
}

/**
 * Read an identifier that Gemini may send as a JSON number or a string.
 *
 * `order_id` and `tid` come back as numbers in some payloads and strings in
 * others; both are stringified so identity comparisons cannot be disturbed by
 * float precision. A number is accepted here precisely because it is NOT a
 * monetary value -- see the file header.
 */
function requireIdString(
  source: Record<string, unknown>,
  field: string,
  context: string,
): string {
  const value = source[field];
  if (typeof value === "string" && value !== "") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  throw new ParseError(
    `${context}: expected ${field} to be a non-empty id (string or number), got ${typeof value}`,
  );
}

/**
 * Read a millisecond timestamp that Gemini may send as a number or string.
 *
 * `timestampms` is documented as either; both resolve to a number of
 * milliseconds. A non-integral or non-numeric value throws rather than being
 * coerced.
 */
function requireEpochMs(
  source: Record<string, unknown>,
  field: string,
  context: string,
): Timestamp {
  const value = source[field];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
    return Number(value);
  }
  throw new ParseError(
    `${context}: expected ${field} to be epoch milliseconds, got ${typeof value}`,
  );
}

/**
 * Read a monetary field. The only route from a Gemini payload into `Money`.
 *
 * Rejects a JSON number outright rather than converting it, exactly as the
 * Binance parser does: Gemini sends decimal strings for every monetary field, so
 * a number here means the wrong field or a changed API, and silently accepting it
 * would put a float into the money path.
 */
function requireMoney(
  source: Record<string, unknown>,
  field: string,
  context: string,
): Money {
  const value = source[field];
  if (typeof value !== "string") {
    throw new ParseError(
      `${context}: expected ${field} to be a decimal string, got ${typeof value}; ` +
        `refusing to convert a non-string into Money`,
    );
  }
  try {
    return fromDecimalString(value);
  } catch (cause) {
    throw new ParseError(`${context}: ${field}: ${(cause as Error).message}`);
  }
}

/**
 * Gemini renders `side` in lower case already (`"buy"`/`"sell"`), unlike
 * Binance's `"BUY"`/`"SELL"`. Anything else throws rather than being guessed.
 */
function parseSide(raw: string, context: string): OrderSide {
  if (raw === "buy") return "buy";
  if (raw === "sell") return "sell";
  throw new ParseError(`${context}: unrecognised side ${JSON.stringify(raw)}`);
}

// ---------------------------------------------------------------------------
// Order state
// ---------------------------------------------------------------------------

/**
 * Derive `OrderState` from Gemini's boolean flags plus fill progress.
 *
 * Gemini has no order-status string; it reports `is_live` and `is_cancelled`, and
 * the amounts. The mapping:
 *
 *  - `is_cancelled` wins outright -> `cancelled`. A cancelled order can carry a
 *    non-zero `executed_amount` (it was partially filled before the cancel took
 *    effect); the state is still `cancelled`, and the filled quantity travels
 *    alongside it -- exactly the shape step 3.1's open question 1 relies on.
 *  - `is_live` and something filled but not all of it -> `partially_filled`.
 *  - `is_live` and nothing (or, defensively, everything) still on the book ->
 *    `pending`.
 *  - not live and not cancelled -> `filled`. The only way an order leaves the
 *    book other than cancellation is completion.
 *
 * There is deliberately no `rejected`/`expired` branch: Gemini reports a
 * rejection as an ERROR BODY (`{result:"error"}`), never as an order object with
 * a rejected flag, so a rejection never reaches this function -- it is handled by
 * `classifyFailure` before any order is parsed.
 */
export function toOrderState(
  isLive: boolean,
  isCancelled: boolean,
  executedAmount: Money,
  originalAmount: Money,
): OrderState {
  if (isCancelled) return "cancelled";
  if (isLive) {
    return executedAmount > ZERO && executedAmount < originalAmount
      ? "partially_filled"
      : "pending";
  }
  return "filled";
}

// ---------------------------------------------------------------------------
// Payloads
// ---------------------------------------------------------------------------

/**
 * `{ "last": ..., "bid": ..., "ask": ... }` from `/v1/pubticker/:symbol`.
 *
 * `last` is the price of the most recent trade -- the direct analogue of the
 * Binance ticker's price. The ticker carries no timestamp this system trusts as
 * the price's own age, so `at` is receipt time, exactly as documented on `Price`
 * and handled identically on the Binance side.
 */
export function parsePrice(pair: string, body: unknown, at: Timestamp): Price {
  const record = asRecord(body, "pubticker");
  return {
    pair,
    price: requireMoney(record, "last", "pubticker"),
    at,
  };
}

/**
 * Parse Gemini's `/v1/symbols` response into this system's pair names.
 *
 * Gemini returns a bare array of symbol strings in ITS convention -- lowercase,
 * no separator (`"btcusd"`, `"ethusd"`). This system's `Pair` is the exchange's
 * name in the convention the rest of the code uses (uppercase, matching what
 * `toGeminiSymbol` lowercases FROM), so each is upper-cased back on the way in --
 * the inverse of `toGeminiSymbol`.
 *
 * DIVERGENCE FROM BINANCE, stated rather than hidden: `/v1/symbols` carries no
 * per-symbol status. Binance's `exchangeInfo` tags every symbol `TRADING` /
 * `HALT` / etc., so `parseTradablePairs` can filter to the tradable set; Gemini
 * exposes status only through the per-symbol `/v1/symbols/details/{symbol}`, so
 * filtering here would cost one request per symbol. `/v1/symbols` is Gemini's
 * own list of its supported trading symbols, and it is taken as the tradable set
 * directly. A symbol that is momentarily closed would still appear; confirming
 * it is `TRADING` remains `getSymbolFilters`' job at order time, exactly as it is
 * on the Binance side.
 */
export function parseSymbolList(body: unknown): Pair[] {
  if (!Array.isArray(body)) {
    throw new ParseError("/v1/symbols: expected an array of symbol strings");
  }
  const pairs: Pair[] = [];
  for (const entry of body) {
    if (typeof entry === "string" && entry !== "") {
      pairs.push(entry.toUpperCase());
    }
  }
  return pairs;
}

/**
 * Parse the `trades` array Gemini returns when `include_trades` is set.
 *
 * A trade carries its own `timestampms`, so -- unlike a Binance fill, which
 * inherits the parent order's time -- `executedAt` is the fill's OWN observed
 * time. `fee_amount`/`fee_currency` are Gemini's names for the commission and the
 * asset it was charged in; section 5.5's rule that a fee is never assumed to be
 * in the quote currency is honoured by carrying `fee_currency` through verbatim.
 */
export function parseFills(raw: unknown): Fill[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new ParseError("order trades: expected an array");
  }

  return raw.map((entry, index) => {
    const context = `trade ${index}`;
    const record = asRecord(entry, context);
    return {
      fillId: requireIdString(record, "tid", context),
      price: requireMoney(record, "price", context),
      quantity: requireMoney(record, "amount", context),
      feeAmount: requireMoney(record, "fee_amount", context),
      feeAsset: requireString(record, "fee_currency", context),
      executedAt: requireEpochMs(record, "timestampms", context),
    };
  });
}

/**
 * The fields shared by the order-new, order-status and order-cancel payloads.
 *
 * Gemini uses one shape for all three (a fortunate simplification over Binance,
 * whose cancellation payload carried a different identity field and forced a
 * separate parser). Identity and timestamps are factored out because callers set
 * them differently depending on which response this is.
 */
function parseCommonOrderFields(
  record: Record<string, unknown>,
  context: string,
): Omit<OrderStatus, "clientOrderId" | "createdAt" | "updatedAt" | "fills"> {
  const quantity = requireMoney(record, "original_amount", context);
  const filledQuantity = requireMoney(record, "executed_amount", context);
  const avgPrice = requireMoney(record, "avg_execution_price", context);

  return {
    exchangeOrderId: requireIdString(record, "order_id", context),
    pair: requireString(record, "symbol", context),
    side: parseSide(requireString(record, "side", context), context),
    price: requireMoney(record, "price", context),
    quantity,
    filledQuantity,
    // Gemini has no cumulative-quote field. The average execution price times the
    // executed amount is the quote value filled so far, and floor keeps it
    // conservative for the same reasons the Binance notional does. When nothing
    // has filled, `avg_execution_price` is "0.00", so this is ZERO.
    cumulativeQuoteQuantity: mul(avgPrice, filledQuantity, "floor"),
    state: toOrderState(
      requireBoolean(record, "is_live", context),
      requireBoolean(record, "is_cancelled", context),
      filledQuantity,
      quantity,
    ),
  };
}

/**
 * Parse the acknowledgement of a newly placed order (`POST /v1/order/new`).
 *
 * Gemini's new-order response has no `trades` array (a resting limit order has
 * filled nothing yet, and even a marketable one returns its fills via
 * order-status, not here), so `OrderResult.fills` is `[]` -- which is what the
 * interface says a limit order's acknowledgement usually is.
 */
export function parseOrderResult(body: unknown): OrderResult {
  const context = "order result";
  const record = asRecord(body, context);
  const common = parseCommonOrderFields(record, context);

  return {
    clientOrderId: requireString(record, "client_order_id", context),
    exchangeOrderId: common.exchangeOrderId,
    pair: common.pair,
    state: common.state,
    fills: parseFills(record["trades"]),
    acceptedAt: requireEpochMs(record, "timestampms", context),
  };
}

/**
 * Parse an order as reported by `POST /v1/order/status`.
 *
 * Gemini reports a single `timestampms` (the order's), so `createdAt` takes it
 * and `updatedAt` defaults to the same value -- there is no separate last-update
 * time in the payload. `fills` is populated only when the caller asked for
 * `include_trades`; otherwise it is left absent, exactly as on the Binance side,
 * because an empty array would falsely assert "no executions".
 */
export function parseOrderStatus(body: unknown): OrderStatus {
  const context = "order status";
  const record = asRecord(body, context);
  const createdAt = requireEpochMs(record, "timestampms", context);
  const fills = record["trades"] !== undefined ? parseFills(record["trades"]) : undefined;

  return {
    ...parseCommonOrderFields(record, context),
    clientOrderId: requireString(record, "client_order_id", context),
    ...(fills !== undefined ? { fills } : {}),
    createdAt,
    updatedAt: createdAt,
  };
}

/**
 * Parse the order echoed back by `POST /v1/order/cancel`.
 *
 * Gemini returns the FULL order status from a cancel -- the same shape as
 * order-status, identified by the SAME `client_order_id`. So there is none of the
 * two-client-id trap Binance's cancellation payload carried (its `clientOrderId`
 * named the cancel request, not the order); reading `client_order_id` here is
 * correct.
 *
 * `createdAt` is therefore genuinely available (Gemini keeps the order's original
 * `timestampms` in the cancel response, unlike Binance's cancel, which dropped
 * it). `updatedAt` is set by the caller to RECEIPT time, because the response's
 * `timestampms` is the order's creation time, not the instant the cancel took
 * effect -- and `filledQuantity` here is final as of when we observed it, which
 * receipt time describes honestly.
 */
export function parseCancelledOrder(body: unknown, at: Timestamp): OrderStatus {
  const context = "cancelled order";
  const record = asRecord(body, context);

  return {
    ...parseCommonOrderFields(record, context),
    clientOrderId: requireString(record, "client_order_id", context),
    createdAt: requireEpochMs(record, "timestampms", context),
    updatedAt: at,
  };
}

/** Parse an array of orders, as `POST /v1/orders` (active orders) returns. */
export function parseOrderStatusList(body: unknown): OrderStatus[] {
  if (!Array.isArray(body)) {
    throw new ParseError("active orders: expected an array");
  }
  return body.map((entry) => parseOrderStatus(entry));
}

/**
 * Parse `POST /v1/balances`, an array of `{currency, amount, available, ...}`.
 *
 * Gemini reports `amount` (the total) and `available` (free to trade). The
 * interface wants `free` and `locked`, so `locked` is derived as
 * `amount - available` -- the quantity reserved against open orders. A negative
 * result would mean Gemini reported more available than total, which is
 * impossible and is refused rather than clamped, so a genuine API change surfaces
 * loudly instead of producing a plausible-looking wrong balance.
 */
export function parseBalances(body: unknown): Balance[] {
  if (!Array.isArray(body)) {
    throw new ParseError("balances: expected an array");
  }

  return body.map((entry, index) => {
    const context = `balance ${index}`;
    const record = asRecord(entry, context);
    const total = requireMoney(record, "amount", context);
    const free = requireMoney(record, "available", context);
    const locked = total - free;
    if (locked < ZERO) {
      throw new ParseError(
        `${context}: available (${free}) exceeds amount (${total}); refusing to ` +
          `report a negative reserved balance`,
      );
    }
    return {
      asset: requireString(record, "currency", context),
      free,
      locked,
    };
  });
}
