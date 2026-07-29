/**
 * Translating exchange payloads into this system's types.
 *
 * The exchange renders every monetary value as a decimal string, which is the
 * one thing about its API that makes section 5.2 easy to honour: each of those
 * strings goes straight into `fromDecimalString`, and no price, quantity, fee or
 * balance is ever a JavaScript `number` at any point in this file. There is
 * deliberately no `Number(...)` call on any monetary field.
 *
 * Identifiers are the exception, and a deliberate one: order ids and trade ids
 * arrive as JSON numbers, so they have already passed through the float parser
 * before this code sees them. They are stringified immediately and only ever
 * compared, never summed, so precision beyond 2^53 would affect identity but not
 * arithmetic. The exchange's ids are far below that ceiling today.
 */

import type {
  Balance,
  Candle,
  Fill,
  OrderResult,
  OrderStatus,
  Price,
  Timestamp,
} from "../../shared/exchange-client";
import type { ExchangeOutcome } from "../../shared/downtime";
import { classifyStatus } from "../../shared/downtime";
import type { OrderSide } from "../../shared/exchange-client";
import type { OrderState } from "../../shared/order-state";
import { fromDecimalString, ZERO, type Money } from "../../shared/money";

export class ParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ParseError";
  }
}

// ---------------------------------------------------------------------------
// Rate-limit headers (section 5.4: "read from response headers")
// ---------------------------------------------------------------------------

/**
 * The used-weight header, e.g. `X-MBX-USED-WEIGHT-1M`.
 *
 * The suffix is an interval count followed by a unit letter, and the exchange
 * sends one header per configured limiter.
 */
const USED_WEIGHT_HEADER = /^x-mbx-used-weight-(\d+)([smhd])$/i;

/**
 * The account's used weight for the one-minute window, if the response carried
 * it.
 *
 * Specifically the one-minute figure, because that is the window `WeightBudget`
 * is configured with. Feeding it an hourly total would look like a vastly
 * overspent minute and stall every request for a full window.
 */
export function parseUsedWeight(
  headers: Headers,
  interval: { num: number; unit: "s" | "m" | "h" | "d" } = { num: 1, unit: "m" },
): number | undefined {
  for (const [name, value] of headers) {
    const match = USED_WEIGHT_HEADER.exec(name);
    if (match === null) continue;

    const [, num, unit] = match as unknown as [string, string, string];
    if (Number(num) !== interval.num) continue;
    if (unit.toLowerCase() !== interval.unit) continue;

    const weight = Number(value);
    if (!Number.isFinite(weight) || weight < 0) continue;
    return weight;
  }
  return undefined;
}

/**
 * How long each documented interval unit lasts, in milliseconds.
 *
 * The exchange spells the unit out in `interval` and gives a multiplier in
 * `intervalNum`, so a limit is "6000 per 1 MINUTE" rather than a raw duration.
 */
const INTERVAL_MS: Readonly<Record<string, number>> = {
  SECOND: 1_000,
  MINUTE: 60_000,
  HOUR: 3_600_000,
  DAY: 86_400_000,
};

/** A request-weight ceiling and the window it applies over. */
export interface RequestWeightLimit {
  readonly limit: number;
  readonly windowMs: number;
}

/**
 * The REQUEST_WEIGHT limit from an `exchangeInfo` body (section 5.4).
 *
 * This is the other half of "read from response headers and `exchangeInfo`".
 * `parseUsedWeight` above reads how much has been SPENT; this reads how much
 * there is to spend, which nothing had ever read.
 *
 * Returns `undefined` rather than throwing, on the same reasoning as
 * `parseUsedWeight`: the caller already has a valid `exchangeInfo` response it
 * asked for in order to get symbol filters, and failing that request because a
 * rate-limit block was shaped unexpectedly would turn a budget refinement into
 * an outage. The RateLimiter keeps its previous limit when this is absent.
 *
 * The SHORTEST window is chosen when several REQUEST_WEIGHT limits are
 * published. That is the binding constraint over any burst, and it is the one
 * `parseUsedWeight` reports usage for -- pairing a per-minute usage figure with
 * a per-day ceiling would let a minute's traffic look like nothing at all.
 */
export function parseRequestWeightLimit(body: unknown): RequestWeightLimit | undefined {
  const limits = (body as Record<string, unknown> | null)?.["rateLimits"];
  if (!Array.isArray(limits)) return undefined;

  let best: RequestWeightLimit | undefined;

  for (const entry of limits) {
    const record = entry as Record<string, unknown>;
    if (record["rateLimitType"] !== "REQUEST_WEIGHT") continue;

    const unitMs = INTERVAL_MS[String(record["interval"])];
    const intervalNum = Number(record["intervalNum"]);
    const limit = Number(record["limit"]);
    if (unitMs === undefined) continue;
    if (!Number.isFinite(intervalNum) || intervalNum <= 0) continue;
    if (!Number.isFinite(limit) || limit <= 0) continue;

    const windowMs = unitMs * intervalNum;
    if (best === undefined || windowMs < best.windowMs) {
      best = { limit, windowMs };
    }
  }

  return best;
}

/**
 * `Retry-After`, converted from seconds to milliseconds.
 *
 * Sent with a 429 to say how long to wait to avoid a ban, and with a 418 to say
 * how long the ban lasts.
 */
export function parseRetryAfterMs(headers: Headers): number | undefined {
  const raw = headers.get("retry-after");
  if (raw === null) return undefined;
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds < 0) return undefined;
  return Math.round(seconds * 1000);
}

// ---------------------------------------------------------------------------
// Error bodies
// ---------------------------------------------------------------------------

export interface BinanceErrorBody {
  code: number;
  msg: string;
}

/** Read the `{code, msg}` error body, if the response carried one. */
export function readErrorBody(body: unknown): BinanceErrorBody | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const record = body as Record<string, unknown>;
  if (typeof record["code"] !== "number") return undefined;
  return {
    code: record["code"],
    msg: typeof record["msg"] === "string" ? record["msg"] : "",
  };
}

/**
 * Error codes whose documented meaning is that the request's effect is UNKNOWN.
 *
 * The exchange's own wording is "Send status unknown; execution status unknown"
 * and "An unexpected response was received from the message bus. Execution
 * status unknown."
 *
 * These arrive with a 4xx-shaped body, which `classifyStatus` would otherwise
 * read as a refusal -- a definite "this did not happen". That reading is wrong
 * and dangerous here: an order may well be resting on the book. Section 5.6
 * treats an unknown effect the same as a transport failure, so these are
 * reclassified to match, and recovery goes through the section 5.1 idempotency
 * path rather than by re-sending.
 */
export const EXECUTION_STATUS_UNKNOWN_CODES: ReadonlySet<number> = new Set([
  -1006, // UNEXPECTED_RESP
  -1007, // TIMEOUT
]);

/** The clock is out of step with the exchange; the offset needs re-syncing. */
export const INVALID_TIMESTAMP_CODE = -1021;

/** The order is not on the exchange. The definitive answer for a status lookup. */
export const NO_SUCH_ORDER_CODE = -2013;

/** The matching engine refused a new order; `msg` says why. */
export const NEW_ORDER_REJECTED_CODE = -2010;

/** Server overloaded. A genuine "try again", unlike most 4xx codes. */
export const SERVER_BUSY_CODE = -1008;

/**
 * Classify a failed response into an `ExchangeOutcome`.
 *
 * Builds on the shared `classifyStatus` and then corrects it in the two places
 * where the exchange's error codes carry meaning the HTTP status alone does not.
 */
export function classifyFailure<T>(
  status: number,
  at: Timestamp,
  body: unknown,
): Extract<ExchangeOutcome<T>, { ok: false }> {
  const error = readErrorBody(body);
  const outcome = classifyStatus<T>(status, at, {
    message: error === undefined ? undefined : `${error.msg} (code ${error.code})`,
    ...(error !== undefined ? { code: error.code } : {}),
  }) as Extract<ExchangeOutcome<T>, { ok: false }>;

  if (error === undefined) return outcome;

  if (EXECUTION_STATUS_UNKNOWN_CODES.has(error.code)) {
    // The request may have been applied. Same handling as a dropped connection.
    return { ...outcome, kind: "transport", retryable: true };
  }

  if (error.code === SERVER_BUSY_CODE) {
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

function requireInteger(
  source: Record<string, unknown>,
  field: string,
  context: string,
): number {
  const value = source[field];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ParseError(
      `${context}: expected ${field} to be a number, got ${typeof value}`,
    );
  }
  return value;
}

/**
 * Read a monetary field. The only route from a payload into `Money`.
 *
 * Rejects a JSON number outright rather than converting it. The exchange sends
 * decimal strings for every monetary field, so a number here means either the
 * wrong field or a changed API, and silently accepting it would put a float into
 * the money path -- the one thing section 5.2 forbids.
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

function optionalMoney(
  source: Record<string, unknown>,
  field: string,
  context: string,
): Money {
  return source[field] === undefined ? ZERO : requireMoney(source, field, context);
}

function parseSide(raw: string, context: string): OrderSide {
  if (raw === "BUY") return "buy";
  if (raw === "SELL") return "sell";
  throw new ParseError(`${context}: unrecognised side ${JSON.stringify(raw)}`);
}

// ---------------------------------------------------------------------------
// Order state
// ---------------------------------------------------------------------------

/**
 * Map the exchange's order status onto this system's `OrderState`.
 *
 * `filledQuantity` and `quantity` are needed for one case: the exchange has a
 * status meaning "a cancel has been requested but is not yet confirmed", which
 * has no equivalent here. It must not be reported as `cancelled`, because the
 * order is still live and can still fill. It is therefore resolved to whichever
 * open state its fill progress implies, and the cancel is recognised on a later
 * poll once the exchange confirms it. That status is documented as currently
 * unused, so this is a guard rather than a hot path.
 *
 * An unrecognised status throws. Every status the exchange documents is handled,
 * so reaching the default means the API has changed and this code can no longer
 * say what state an order is in -- which is not something to guess about.
 */
export function toOrderState(
  raw: string,
  filledQuantity: Money,
  quantity: Money,
): OrderState {
  switch (raw) {
    case "NEW":
    case "PENDING_NEW":
      return "pending";
    case "PARTIALLY_FILLED":
      return "partially_filled";
    case "FILLED":
      return "filled";
    case "CANCELED":
      return "cancelled";
    case "REJECTED":
      return "rejected";
    case "EXPIRED":
    // Expired by self-trade prevention. Terminal in exactly the same way.
    case "EXPIRED_IN_MATCH":
      return "expired";
    case "PENDING_CANCEL":
      return filledQuantity > ZERO && filledQuantity < quantity
        ? "partially_filled"
        : "pending";
    default:
      throw new ParseError(
        `unrecognised order status ${JSON.stringify(raw)}; refusing to guess ` +
          `which state the order is in`,
      );
  }
}

// ---------------------------------------------------------------------------
// Payloads
// ---------------------------------------------------------------------------

/** `{ "serverTime": ... }` from the server-time endpoint. */
export function parseServerTime(body: unknown): number {
  const record = asRecord(body, "server time");
  return requireInteger(record, "serverTime", "server time");
}

/** `{ "symbol": ..., "price": ... }` from the price ticker. */
export function parsePrice(body: unknown, at: Timestamp): Price {
  const record = asRecord(body, "price ticker");
  return {
    pair: requireString(record, "symbol", "price ticker"),
    price: requireMoney(record, "price", "price ticker"),
    // The ticker carries no timestamp of its own, so this is receipt time. See
    // the note on `Price` in the shared interface.
    at,
  };
}

/**
 * Parse the fills attached to an order-placement response.
 *
 * `executedAt` is supplied by the caller from the parent order's transaction
 * time, because a fill object carries no time field. See the note on `Fill`.
 */
export function parseFills(raw: unknown, executedAt: Timestamp): Fill[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new ParseError("order fills: expected an array");
  }

  return raw.map((entry, index) => {
    const context = `fill ${index}`;
    const record = asRecord(entry, context);
    return {
      fillId: String(requireInteger(record, "tradeId", context)),
      price: requireMoney(record, "price", context),
      quantity: requireMoney(record, "qty", context),
      // The exchange calls the fee a commission, and reports the asset it was
      // actually charged in -- which section 5.5 insists must never be assumed
      // to be the quote currency.
      feeAmount: requireMoney(record, "commission", context),
      feeAsset: requireString(record, "commissionAsset", context),
      executedAt,
    };
  });
}

/** Parse the acknowledgement of a newly placed order. */
export function parseOrderResult(body: unknown): OrderResult {
  const context = "order result";
  const record = asRecord(body, context);

  const quantity = optionalMoney(record, "origQty", context);
  const filledQuantity = optionalMoney(record, "executedQty", context);
  const acceptedAt = requireInteger(record, "transactTime", context);

  // A limit order defaults to the fullest response type, which includes both the
  // status and any fills. The status is read defensively all the same, since a
  // bare acknowledgement omits it and means the order was simply accepted.
  const rawStatus = record["status"];
  const state =
    typeof rawStatus === "string"
      ? toOrderState(rawStatus, filledQuantity, quantity)
      : "pending";

  return {
    clientOrderId: requireString(record, "clientOrderId", context),
    exchangeOrderId: String(requireInteger(record, "orderId", context)),
    pair: requireString(record, "symbol", context),
    state,
    fills: parseFills(record["fills"], acceptedAt),
    acceptedAt,
  };
}

/**
 * The fields every order-shaped payload carries identically.
 *
 * Shared by the status, open-orders and cancellation responses. Identity and
 * timestamps are excluded because those are exactly where the payloads differ,
 * and getting them wrong is silent rather than loud -- see `parseCancelledOrder`.
 */
type CommonOrderFields = Omit<
  OrderStatus,
  "clientOrderId" | "createdAt" | "updatedAt"
>;

function parseCommonOrderFields(
  record: Record<string, unknown>,
  context: string,
): CommonOrderFields {
  const quantity = requireMoney(record, "origQty", context);
  const filledQuantity = requireMoney(record, "executedQty", context);

  return {
    exchangeOrderId: String(requireInteger(record, "orderId", context)),
    pair: requireString(record, "symbol", context),
    side: parseSide(requireString(record, "side", context), context),
    price: requireMoney(record, "price", context),
    quantity,
    filledQuantity,
    cumulativeQuoteQuantity: requireMoney(record, "cummulativeQuoteQty", context),
    state: toOrderState(
      requireString(record, "status", context),
      filledQuantity,
      quantity,
    ),
  };
}

/**
 * Parse an order as reported by the status or open-orders endpoints.
 *
 * Neither carries a fills array, so `fills` is left absent rather than set to an
 * empty one -- see the note on `OrderStatus`. The cumulative quote quantity is
 * the only available route to an average fill price.
 */
export function parseOrderStatus(body: unknown): OrderStatus {
  const context = "order status";
  const record = asRecord(body, context);
  const createdAt = requireInteger(record, "time", context);

  return {
    ...parseCommonOrderFields(record, context),
    clientOrderId: requireString(record, "clientOrderId", context),
    createdAt,
    // Present on both endpoints, but defaulted to creation time rather than
    // failing: an order that has never been updated is not an error.
    updatedAt:
      typeof record["updateTime"] === "number" ? record["updateTime"] : createdAt,
  };
}

/**
 * Parse the order echoed back by a cancellation.
 *
 * Separate from `parseOrderStatus` for two reasons, and the first one is a trap.
 *
 * The cancellation response has TWO client order ids. `clientOrderId` is the id
 * of the CANCEL REQUEST -- a fresh id the exchange generates for the cancel
 * itself -- while `origClientOrderId` is the order that was actually cancelled.
 * Reading `clientOrderId` here, as the status endpoints correctly do, would
 * attribute the result to an id this system never issued. Nothing would throw:
 * the field is present and is a string, so a halt would simply record a filled
 * quantity against an order that does not exist, and the real order's final fill
 * would be lost. That is precisely the kind of silent mis-attribution section 9's
 * reconciliation would later surface as an unexplained discrepancy.
 *
 * Second, the payload has no `time` or `updateTime`, only `transactTime`. So the
 * order's creation time is genuinely unavailable and `createdAt` is left absent
 * rather than invented, while `updatedAt` is the cancellation instant -- exactly
 * the moment the reported `filledQuantity` describes, which is what section 7.2
 * needs.
 */
export function parseCancelledOrder(body: unknown): OrderStatus {
  const context = "cancelled order";
  const record = asRecord(body, context);

  return {
    ...parseCommonOrderFields(record, context),
    // NOT `clientOrderId` -- see above.
    clientOrderId: requireString(record, "origClientOrderId", context),
    updatedAt: requireInteger(record, "transactTime", context),
  };
}

/** Parse the `balances` array from the account endpoint. */
export function parseBalances(body: unknown): Balance[] {
  const record = asRecord(body, "account");
  const balances = record["balances"];
  if (!Array.isArray(balances)) {
    throw new ParseError("account: expected a balances array");
  }

  return balances.map((entry, index) => {
    const context = `balance ${index}`;
    const balance = asRecord(entry, context);
    return {
      asset: requireString(balance, "asset", context),
      free: requireMoney(balance, "free", context),
      locked: requireMoney(balance, "locked", context),
    };
  });
}

/** Parse an array of orders, as the open-orders endpoint returns. */
export function parseOrderStatusList(body: unknown): OrderStatus[] {
  if (!Array.isArray(body)) {
    throw new ParseError("open orders: expected an array");
  }
  return body.map((entry) => parseOrderStatus(entry));
}

// ---------------------------------------------------------------------------
// Candles (klines)
// ---------------------------------------------------------------------------

/** One string monetary field of a kline row, by position. */
function klineMoney(row: unknown[], index: number, field: string, context: string): Money {
  const value = row[index];
  if (typeof value !== "string") {
    throw new ParseError(
      `${context}: expected ${field} (field ${index}) to be a decimal string, got ${typeof value}`,
    );
  }
  try {
    return fromDecimalString(value);
  } catch (cause) {
    throw new ParseError(`${context}: ${field}: ${(cause as Error).message}`);
  }
}

/** One millisecond-timestamp field of a kline row, by position. */
function klineTime(row: unknown[], index: number, context: string): Timestamp {
  const value = row[index];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ParseError(`${context}: expected a numeric ms timestamp at field ${index}`);
  }
  return value;
}

/**
 * Parse `/api/v3/klines` into `Candle`s, oldest-first.
 *
 * Unlike Gemini, Binance renders each kline's OHLCV as decimal STRINGS, so they
 * stay on the ordinary `fromDecimalString` path with no number->Money boundary.
 * A kline row is `[openTime, open, high, low, close, volume, closeTime, ...]`;
 * the close time is REPORTED (field 6), not derived, and `closed` is set from
 * whether it has passed at request time. Binance returns klines oldest-first
 * already, but this sorts ascending rather than relying on that.
 */
export function parseKlines(pair: string, body: unknown, at: Timestamp): Candle[] {
  if (!Array.isArray(body)) {
    throw new ParseError("klines: expected an array of kline rows");
  }

  const candles: Candle[] = body.map((row, index) => {
    const context = `klines row ${index}`;
    if (!Array.isArray(row) || row.length < 7) {
      throw new ParseError(
        `${context}: expected [openTime, open, high, low, close, volume, closeTime, ...]`,
      );
    }
    const closeTime = klineTime(row, 6, context);
    return {
      pair,
      openTime: klineTime(row, 0, context),
      closeTime,
      open: klineMoney(row, 1, "open", context),
      high: klineMoney(row, 2, "high", context),
      low: klineMoney(row, 3, "low", context),
      close: klineMoney(row, 4, "close", context),
      volume: klineMoney(row, 5, "volume", context),
      closed: at > closeTime,
    };
  });

  candles.sort((a, b) => a.openTime - b.openTime);
  return candles;
}
