/**
 * Translating Kraken payloads into this system's types (decision log entry 90
 * PART 5, touchpoint 4).
 *
 * Structurally the third of `binance/parse.ts` and `gemini/parse.ts`, and it
 * diverges from both in four places that are not stylistic:
 *
 *  - ERROR CLASSIFICATION IS THE PRIMARY PATH, NOT AN EDGE CASE. Kraken answers
 *    HTTP 200 to a bad key, an unknown pair and a throttle alike; the failure
 *    lives in a top-level `error` ARRAY of `E<Category>:<Message>` strings. So
 *    `classifyFailure` here is driven by the string, not by `classifyStatus` --
 *    see its own docblock for why a synthetic status would be a lie.
 *  - EVERY REPLY IS A MAP KEYED BY A NAME THE CLIENT DID NOT CHOOSE (entry 90
 *    PROBLEM 1). `result[requestedPair]` is never valid, so pair-keyed payloads
 *    are read through `catalogue.selectPairResult` and asset-keyed ones through
 *    `catalogue.tickerForAsset`. Nothing here transforms a name with a string
 *    rule; `catalogue.ts` owns every such answer and this module only asks.
 *  - THE FEE ASSET IS NOT IN THE PAYLOAD. `QueryTrades` returns a bare `fee`
 *    with no currency field at all. DECISION 4 resolves that by asserting
 *    `oflags=fciq` on every order this system places; `feeAssetFor` carries the
 *    derivation anyway, for state this system did not place. See its docblock.
 *  - `descr.order` IS PROSE AND IS NEVER PARSED. `AddOrder` answers with
 *    `{descr: {order: "buy 1.25000000 XBTUSD @ limit 27500.0"}, txid: [...]}`
 *    and almost nothing structured. Recovering a price or a quantity by
 *    pattern-matching that sentence would be reading prose where a specification
 *    is required -- explicitly rejected in entry 90. `parseOrderResult` takes
 *    the identity it needs from the REQUEST and reads only `txid`.
 *
 * ── MONEY, AND A CORRECTION TO ENTRY 90 ──
 *
 * Entry 90's 2.1 table records that Kraken's monetary values "go straight onto
 * `fromDecimalString`, with none of the JSON-number exception `gemini/parse.ts`
 * needed for candle OHLCV". THE FORMAT HALF OF THAT IS RIGHT AND THE PRECISION
 * HALF IS NOT, and it was checked live rather than assumed:
 *
 *     GET /0/public/Ticker?pair=BONKUSD   ->  "a": ["0.000002926000", ...]   12dp
 *     GET /0/public/OHLC?pair=BONKUSD     ->  "0.000002924"                   9dp
 *     GET /0/public/Ticker?pair=ANKRXBT   ->  "b": ["0.0000000601", ...]      10dp
 *
 * `Money` carries 8 decimal places and `fromDecimalString` throws past that, so
 * the strict parser makes those markets unreadable ENTIRELY -- the same failure
 * `fromDecimalStringRounded` was written for when a Gemini balance arrived at 11
 * places, and the same one `filters.ts` already handles for `tick_size` on 45
 * live pairs. So every value Kraken REPORTS is read through
 * `fromDecimalStringRounded` with a direction named at the call site, exactly as
 * `filters.ts` does it. `fromDecimalString` remains untouched and remains the
 * only way a value this system SENDS is brought in -- nothing in this file is
 * sent anywhere.
 *
 * The directions are chosen per field rather than uniformly, and the two
 * balance fields are the case worth reading: see `parseBalances`.
 *
 * ⚠ ONE CHECK DELIBERATELY DOES NOT GO THROUGH `Money` AT ALL. The crossed-book
 * refusal compares the published bid and ask as EXACT DECIMAL STRINGS, because
 * rounding them to 8 places first would collapse `ANKRXBT`'s live
 * `0.0000000601 / 0.0000000607` onto one value and refuse every price on the
 * pair as crossed. See `compareDecimalStrings`.
 *
 * Timestamps are Kraken's other unit trap: `opentm`, `closetm`, `unixtime` and a
 * candle's leading field are all SECONDS -- floats, at that (`1688665496.7808`)
 * -- where this system's `Timestamp` is milliseconds. `secondsToMs` is the only
 * route, and it rounds rather than truncating.
 */

import type {
  Asset,
  Balance,
  Candle,
  CandleInterval,
  Fill,
  OrderResult,
  OrderSide,
  OrderStatus,
  Pair,
  Price,
  Timestamp,
} from "../../shared/exchange-client";
import type { ExchangeOutcome, FailureKind } from "../../shared/downtime";
import type { OrderState } from "../../shared/order-state";
import {
  fromDecimalStringRounded,
  ZERO,
  type Money,
  type Rounding,
} from "../../shared/money";
import type { KrakenCatalogue, KrakenPair } from "./catalogue";

export class ParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ParseError";
  }
}

// ---------------------------------------------------------------------------
// Shape helpers
// ---------------------------------------------------------------------------

/**
 * Describe an unexpected payload accurately enough to act on.
 *
 * Carried over from `gemini/parse.ts` for the reason recorded there: `typeof []`
 * is `"object"`, so a bare `typeof` once produced `expected an object, got
 * object` for an array and named nothing that could be fixed.
 */
function describeShape(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) {
    return value.length === 0
      ? "an empty array"
      : `an array of ${value.length}`;
  }
  if (typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    return `an object with keys [${keys.slice(0, 12).join(", ")}${
      keys.length > 12 ? ", ..." : ""
    }]`;
  }
  return `a ${typeof value}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown, context: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new ParseError(
      `${context}: expected a single object, got ${describeShape(value)}`,
    );
  }
  return value;
}

function requireString(
  source: Record<string, unknown>,
  field: string,
  context: string,
): string {
  const value = source[field];
  if (typeof value !== "string" || value === "") {
    throw new ParseError(
      `${context}: expected ${field} to be a non-empty string, got ${
        value === undefined ? "undefined" : typeof value
      }`,
    );
  }
  return value;
}

/**
 * Read a Kraken timestamp, which is SECONDS and often fractional, as
 * milliseconds.
 *
 * `opentm: 1688665496.7808` is a real live shape. Multiplying then ROUNDING
 * (rather than truncating) keeps the value within half a millisecond of what
 * Kraken reported in both directions; truncating would bias every timestamp in
 * the system earlier by up to a millisecond for no reason.
 */
function secondsToMs(value: unknown, field: string, context: string): Timestamp {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ParseError(
      `${context}: expected ${field} to be a numeric unix time in seconds, got ${
        value === undefined ? "undefined" : typeof value
      }`,
    );
  }
  return Math.round(value * 1000);
}

/**
 * Read a monetary field Kraken REPORTED, resolving excess precision in a named
 * direction.
 *
 * Never `fromDecimalString`: see the file header on `BONKUSD` and `ANKRXBT`. A
 * non-string still throws -- Kraken sends decimal strings for every monetary
 * field (entry 90, live), so a JSON number here means the wrong field or a
 * changed API, and converting it would put a float into the money path.
 */
function reportedMoney(
  source: Record<string, unknown>,
  field: string,
  context: string,
  rounding: Rounding,
): Money {
  const value = source[field];
  if (typeof value !== "string") {
    throw new ParseError(
      `${context}: expected ${field} to be a decimal string, got ${
        value === undefined ? "undefined" : typeof value
      }; refusing to convert a non-string into Money`,
    );
  }
  try {
    return fromDecimalStringRounded(value, rounding);
  } catch (cause) {
    throw new ParseError(`${context}: ${field}: ${(cause as Error).message}`);
  }
}

/** `reportedMoney` for a bare string rather than a field of a record. */
function reportedMoneyValue(
  value: unknown,
  field: string,
  context: string,
  rounding: Rounding,
): Money {
  if (typeof value !== "string") {
    throw new ParseError(
      `${context}: expected ${field} to be a decimal string, got ${
        value === undefined ? "undefined" : typeof value
      }; refusing to convert a non-string into Money`,
    );
  }
  try {
    return fromDecimalStringRounded(value, rounding);
  } catch (cause) {
    throw new ParseError(`${context}: ${field}: ${(cause as Error).message}`);
  }
}

/**
 * Nearest, halves to even, for every value this system OBSERVES but does not
 * settle against.
 *
 * Chosen for the reason `NOTIONAL_ROUNDING` in `order-state.ts` gives: it has no
 * directional bias, so representation error does not accumulate one way across
 * many candles or many reads. It is also MONOTONE, which is load-bearing in
 * `parseCommonOrderFields`: `vol_exec <= vol` on the wire therefore stays
 * `filledQuantity <= quantity` after rounding, so a fine-priced pair cannot
 * manufacture an overfill out of arithmetic.
 */
const OBSERVED: Rounding = "half-even";

// ---------------------------------------------------------------------------
// Exact decimal comparison, for the one check that must not round
// ---------------------------------------------------------------------------

const DECIMAL = /^([+-]?)(\d+)(?:\.(\d+))?$/;

/**
 * Compare two decimal strings EXACTLY, at whatever precision they carry.
 *
 * ⚠ THIS EXISTS BECAUSE THE CROSSED-BOOK CHECK CANNOT USE `Money`. Kraken
 * publishes `ANKRXBT` at ten decimal places -- live, `b: "0.0000000601"`,
 * `a: "0.0000000607"` -- and both collapse to `0.00000006` at the money scale.
 * A check written the way `gemini/parse.ts` writes it (parse both to `Money`,
 * then `bid >= ask`) would find them EQUAL, conclude the book was crossed, and
 * refuse every price on that pair and on every other sub-satoshi market Kraken
 * lists. The detector would go from having no false-positive case at all to
 * having one on a whole class of pairs.
 *
 * So the comparison is done on the digits: pad both fractions to a common
 * length, compare as `BigInt`. No float, no `Number`, no scale limit. Returns
 * `undefined` -- not a guess -- for anything that is not a plain decimal string,
 * which the caller treats as "no book to judge" rather than as a broken one.
 */
export function compareDecimalStrings(
  left: string,
  right: string,
): -1 | 0 | 1 | undefined {
  const a = DECIMAL.exec(left);
  const b = DECIMAL.exec(right);
  if (a === null || b === null) return undefined;

  const width = Math.max((a[3] ?? "").length, (b[3] ?? "").length);
  const scale = (match: RegExpExecArray): bigint => {
    const magnitude = BigInt(match[2]! + (match[3] ?? "").padEnd(width, "0"));
    return match[1] === "-" ? -magnitude : magnitude;
  };

  const x = scale(a);
  const y = scale(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

// ---------------------------------------------------------------------------
// The envelope: `{error: [...], result: {...}}`
// ---------------------------------------------------------------------------

/** Kraken's universal response envelope, both endpoints public and private. */
export interface KrakenEnvelope {
  /** `E<Category>:<Message>` strings. NON-EMPTY MEANS THE REQUEST FAILED. */
  readonly errors: readonly string[];
  /** The payload, when there was one. ABSENT on a failure, often. */
  readonly result: unknown;
}

/**
 * Read Kraken's envelope.
 *
 * `error` is required and must be an array; `result` is genuinely optional --
 * live, `GET /0/public/Ticker?pair=NOTAPAIR` answers HTTP 200 with
 * `{"error":["EQuery:Unknown asset pair"]}` and NO `result` KEY AT ALL. Treating
 * a missing `result` as a broken payload would report that as an unreadable
 * response rather than as the classified refusal it is.
 *
 * Non-string entries in the array are stringified rather than rejected. The
 * array is the only thing standing between a failed request and the caller
 * believing it succeeded, so a weird entry must still count as an error; the
 * classifier's fail-closed default then handles it.
 */
export function readEnvelope(body: unknown): KrakenEnvelope {
  const record = asRecord(body, "Kraken envelope");
  const errors = record["error"];
  if (!Array.isArray(errors)) {
    throw new ParseError(
      `Kraken envelope: expected a top-level "error" array, got ${describeShape(
        errors,
      )}; every Kraken reply carries one and its emptiness is the only signal ` +
        `that the request succeeded`,
    );
  }
  return {
    errors: errors.map((entry) => (typeof entry === "string" ? entry : String(entry))),
    result: record["result"],
  };
}

/**
 * The `result` of a SUCCESSFUL envelope, or a throw.
 *
 * Used by the client after `classifyFailure` has already handled a non-empty
 * error array, so reaching the second throw here means Kraken reported success
 * and sent no payload -- which is not a state to paper over with `{}`.
 */
export function requireResult(body: unknown, context: string): unknown {
  const envelope = readEnvelope(body);
  if (envelope.errors.length > 0) {
    throw new ParseError(
      `${context}: Kraken reported ${envelope.errors.length} error(s): ` +
        `${envelope.errors.join("; ")}`,
    );
  }
  if (envelope.result === undefined) {
    throw new ParseError(
      `${context}: Kraken reported no errors but sent no result payload`,
    );
  }
  return envelope.result;
}

// ---------------------------------------------------------------------------
// Error classification (entry 90 PROBLEM 3) -- the primary path
// ---------------------------------------------------------------------------

/** How one Kraken error string is to be treated. */
export interface KrakenErrorClass {
  readonly kind: FailureKind;
  readonly retryable: boolean;
  /**
   * Only ever set by `EService:Throttled:<unix ts>`, and computed against the
   * receipt time. Kraken is the FIRST venue in this codebase that supplies a
   * real figure here -- entry 90 PROBLEM 2(d): it sends no rate-limit headers of
   * any kind, and this string is the one compensation.
   */
  readonly retryAfterMs?: number;
}

/** A stale nonce. Retryable: the next request generates a higher one. */
export const INVALID_NONCE_ERROR = "EAPI:Invalid nonce";

/**
 * Errors that are RETRYABLE but still mean the exchange answered.
 *
 * `EAPI:Invalid nonce` mirrors Gemini's `INVALID_NONCE_REASON` exactly: a 4xx-
 * shaped refusal that genuinely clears on its own, because the fix is to advance
 * the nonce rather than to change the request.
 */
const RETRYABLE_EXCHANGE_ERRORS: ReadonlySet<string> = new Set([
  INVALID_NONCE_ERROR,
  "EAPI:Rate limit exceeded",
  "EOrder:Rate limit exceeded",
  "EGeneral:Too many requests",
]);

/**
 * Errors that mean THE REQUEST'S EFFECT IS UNKNOWN, not that it was refused.
 *
 * ⚠ THE MOST CONSEQUENTIAL ROW IN THE TABLE, and the reason the table exists at
 * all. Both of these arrive over HTTP 200, so any classifier reasoning from the
 * status would call them `exchange_error` -- telling section 5.1 that an order
 * was DEFINITELY refused when a server-side failure in fact leaves its fate
 * open. Section 5.6 groups exactly this with a connection failure, and
 * `classifyThrown` already classifies "no reply at all" as `transport` for the
 * same reason. An order whose effect is unknown must be recovered by looking it
 * up, never assumed gone.
 */
const TRANSPORT_ERRORS: ReadonlySet<string> = new Set([
  "EService:Unavailable",
  "EService:Busy",
  "EService:Market in cancel_only mode",
  "EService:Market in post_only mode",
  "EService:Deadline elapsed",
]);

/**
 * `EService:Throttled:<unix timestamp>`.
 *
 * The timestamp is a real time to wait until, in SECONDS. Both spellings are
 * accepted because entry 90 records the string both ways (`EService:Throttled:
 * <ts>` in prose, `EService:Throttled:<ts>` in the table) and the difference is
 * a space nobody should be able to get wrong.
 */
const THROTTLED = /^EService:Throttled:\s*(\d+)(?:\.\d+)?$/;

/**
 * Classify ONE Kraken error string.
 *
 * ⚠ THE DEFAULT ARM IS THE POINT OF THIS FUNCTION. An unrecognised string is a
 * NON-RETRYABLE `exchange_error` -- a definite, loud failure -- and never falls
 * through as anything a caller could mistake for success. Kraken publishes
 * dozens of `E<Category>:<Message>` values and adds to them; the tables above
 * hold the ones this system has confirmed, and everything else is treated as
 * "the exchange refused and this code does not know why", which is the only
 * honest reading. Guessing retryable would re-send an order into a refusal
 * nobody understands; guessing `transport` would send a definite refusal into
 * section 5.1's recovery path for an order that never existed.
 */
export function classifyKrakenError(error: string, at: Timestamp): KrakenErrorClass {
  const throttled = THROTTLED.exec(error);
  if (throttled !== null) {
    // Kraken states an absolute instant; the interface wants a duration. A
    // timestamp already in the past yields 0 rather than a negative wait.
    const untilMs = Number(throttled[1]!) * 1000;
    return {
      kind: "exchange_error",
      retryable: true,
      retryAfterMs: Math.max(0, untilMs - at),
    };
  }
  if (TRANSPORT_ERRORS.has(error)) {
    return { kind: "transport", retryable: true };
  }
  if (RETRYABLE_EXCHANGE_ERRORS.has(error)) {
    return { kind: "exchange_error", retryable: true };
  }
  // FAIL CLOSED. See the docblock.
  return { kind: "exchange_error", retryable: false };
}

/**
 * Classify a whole `error` array into an `ExchangeOutcome` failure.
 *
 * Kraken sends one error in every case observed live, but the field is an array
 * and nothing promises it stays singular, so the combination rule is stated
 * rather than left to `[0]`. PRECEDENCE, MOST CAUTIOUS FIRST:
 *
 *   1. any `transport` -> `transport`, retryable. "Effect unknown" cannot be
 *      overridden by a sibling that happens to be definite; that is the
 *      direction section 5.6 exists to protect.
 *   2. any non-retryable -> `exchange_error`, NOT retryable. One definite
 *      refusal in the array means re-sending is refused identically.
 *   3. otherwise -> `exchange_error`, retryable, carrying the LONGEST
 *      `retryAfterMs` any entry supplied. The longest, because waiting out the
 *      shorter of two stated throttles is waiting the wrong amount.
 *
 * NO SYNTHETIC HTTP STATUS IS INVENTED. `GeminiClient` converts a 200-with-error
 * body by calling `classifyFailure(400, ...)`, which works there because Gemini
 * uses status honestly everywhere else. Kraken answers 200 to everything, so a
 * fabricated 400 would put a number in `outcome.status` that no Kraken response
 * ever carried, and it would route through `classifyStatus`, whose entire rule
 * set ("5xx means unknown, 4xx means refused, 429 is retryable") cannot fire.
 * `status` is therefore left ABSENT unless the transport genuinely produced one.
 */
export function classifyFailure<T>(
  errors: readonly string[],
  at: Timestamp,
  options: { status?: number } = {},
): Extract<ExchangeOutcome<T>, { ok: false }> {
  const message =
    errors.length === 0
      ? "Kraken reported a failure with an empty error array"
      : errors.join("; ");

  const classes = errors.map((error) => classifyKrakenError(error, at));

  let kind: FailureKind = "exchange_error";
  let retryable = false;
  let retryAfterMs: number | undefined;

  if (classes.length === 0) {
    // An empty array reaching here means a caller decided the request failed on
    // some other ground. Fail closed, exactly as an unrecognised string does.
    kind = "exchange_error";
    retryable = false;
  } else if (classes.some((entry) => entry.kind === "transport")) {
    kind = "transport";
    retryable = true;
  } else if (classes.some((entry) => !entry.retryable)) {
    kind = "exchange_error";
    retryable = false;
  } else {
    kind = "exchange_error";
    retryable = true;
    for (const entry of classes) {
      if (entry.retryAfterMs === undefined) continue;
      retryAfterMs =
        retryAfterMs === undefined
          ? entry.retryAfterMs
          : Math.max(retryAfterMs, entry.retryAfterMs);
    }
  }

  return {
    ok: false,
    kind,
    message,
    retryable,
    ...(options.status !== undefined ? { status: options.status } : {}),
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    at,
  };
}

// ---------------------------------------------------------------------------
// Order state
// ---------------------------------------------------------------------------

/**
 * Map Kraken's order status onto `OrderState`, FAILING CLOSED.
 *
 * Kraken is the easiest of the three venues here: a real status enum, closer to
 * Binance's than to Gemini's `is_live`/`is_cancelled` booleans (entry 90, 2.1).
 * The five values and their mapping:
 *
 *   pending   -> `pending`            order received, not yet on the book
 *   open      -> `pending` /          on the book; `partially_filled` iff some
 *                `partially_filled`   but not all of `vol` has executed
 *   closed    -> `filled`             Kraken's "closed" means fully executed;
 *                                     a cancel is reported as `canceled`, not
 *                                     as a closed order, so this arm never
 *                                     hides a cancellation
 *   canceled  -> `cancelled`          note the spelling: ONE `l` on the wire,
 *                                     two in this system's enum
 *   expired   -> `expired`
 *
 * THERE IS NO `rejected` ARM, and its absence is a fact rather than a gap: a
 * Kraken rejection arrives as an `E<Category>:<Message>` string in the error
 * array (`EOrder:Insufficient funds`), never as an order record carrying a
 * rejected status. It is handled by `classifyFailure` before any order is
 * parsed -- the same shape `gemini/parse.ts` records for its own venue.
 *
 * AN UNRECOGNISED STATUS THROWS, matching `toOrderState` on the Binance side and
 * `mapStatus` in this venue's own `filters.ts`. A new Kraken status is a case
 * this code has never seen and cannot judge; guessing an open state would leave
 * a terminated order tracked as live, and guessing a terminal one would abandon
 * a live order. Under section 7.5 a throw becomes an alert with a real cause.
 */
export function toOrderState(
  raw: unknown,
  filledQuantity: Money,
  quantity: Money,
): OrderState {
  switch (raw) {
    case "pending":
      return "pending";
    case "open":
      return filledQuantity > ZERO && filledQuantity < quantity
        ? "partially_filled"
        : "pending";
    case "closed":
      return "filled";
    case "canceled":
      return "cancelled";
    case "expired":
      return "expired";
    default:
      throw new ParseError(
        `unrecognised Kraken order status ${JSON.stringify(raw)}; refusing to ` +
          `guess which state the order is in`,
      );
  }
}

function parseSide(raw: string, context: string): OrderSide {
  if (raw === "buy") return "buy";
  if (raw === "sell") return "sell";
  throw new ParseError(`${context}: unrecognised side ${JSON.stringify(raw)}`);
}

// ---------------------------------------------------------------------------
// Fee asset (entry 90 DECISION 4)
// ---------------------------------------------------------------------------

/** Fee charged in the QUOTE currency. What this system asserts on every order. */
export const FEE_IN_QUOTE_FLAG = "fciq";
/** Fee charged in the BASE currency. Kraken's default on a SELL. */
export const FEE_IN_BASE_FLAG = "fcib";

/** Split Kraken's comma-separated `oflags` string into its flags. */
export function parseOrderFlags(raw: unknown): readonly string[] {
  if (typeof raw !== "string" || raw === "") return [];
  return raw
    .split(",")
    .map((flag) => flag.trim().toLowerCase())
    .filter((flag) => flag !== "");
}

/**
 * Which asset a fee was charged in.
 *
 * ── THE ASSERTED PATH, WHICH IS THE ONLY ONE THIS SYSTEM'S OWN ORDERS TAKE ──
 *
 * DECISION 4 sends `oflags=fciq` on every order, so the fee asset is the QUOTE
 * asset on both sides, deterministically, and the first branch below is the one
 * that fires. That decision exists because section 5.5 forbids assuming a fee is
 * paid in the quote currency, and Kraken is the first venue here where the
 * assumption is literally wrong half the time AND the venue does not report the
 * answer -- `QueryTrades` returns a bare `fee` string with no currency field at
 * all, so "read it from the fill" has nothing to read. Setting the flag turns a
 * chain of inference into a fact the request itself establishes.
 *
 * ── THE DERIVED PATH, AND WHY IT IS STILL HERE ──
 *
 * Reconciliation (section 9) reads orders this system did not place: an order
 * entered in Kraken's own UI, or one predating this integration, carries
 * whatever `oflags` its author chose or none at all. For those, the fee asset is
 * reconstructed from Kraken's documented defaults -- `fciq` on a BUY, `fcib` on
 * a SELL -- against the pair's own tickers. It is a genuine inference and it is
 * confined to state this system did not create, which is the whole reason
 * DECISION 4 refused to rely on it for orders it does.
 *
 * The tickers come from the CATALOGUE, never from the pair name: `XXBTZUSD` has
 * no readable base and quote, and splitting the string to find them is exactly
 * the substring corruption entry 90 PROBLEM 1 documents.
 */
export function feeAssetFor(
  pair: KrakenPair,
  side: OrderSide,
  oflags: unknown,
): Asset {
  const flags = parseOrderFlags(oflags);
  if (flags.includes(FEE_IN_QUOTE_FLAG)) return pair.quote.ticker;
  if (flags.includes(FEE_IN_BASE_FLAG)) return pair.base.ticker;
  // No explicit flag: Kraken's own side-dependent default.
  return side === "buy" ? pair.quote.ticker : pair.base.ticker;
}

// ---------------------------------------------------------------------------
// Server time
// ---------------------------------------------------------------------------

/**
 * `GET /0/public/Time` -> `{unixtime: 1788406450, rfc1123: "..."}`.
 *
 * SECONDS, unlike Binance's `serverTime` in milliseconds. Kraken publishes this
 * where Gemini does not, so `getServerTime` can return a real value rather than
 * Gemini's honest refusal -- though, as on Gemini, authentication uses a nonce
 * and not a corrected clock, so nothing about signing depends on it.
 */
export function parseServerTime(result: unknown): number {
  const record = asRecord(result, "server time");
  return secondsToMs(record["unixtime"], "unixtime", "server time");
}

// ---------------------------------------------------------------------------
// Ticker / price
// ---------------------------------------------------------------------------

/**
 * `GET /0/public/Ticker` -> `{"XXBTZUSD": {a, b, c, v, p, t, l, h, o}}`.
 *
 * `c` is `[last trade price, last trade lot volume]`, so `c[0]` is the direct
 * analogue of Binance's ticker price and Gemini's `last`. `a` and `b` are the
 * ask and bid, each `[price, whole lot volume, lot volume]`.
 *
 * `at` is RECEIPT TIME, not exchange time: the ticker carries no timestamp for
 * the price at all. Exactly as documented on `Price` and handled identically on
 * both other venues.
 *
 * ── SPEC 5.7 DETECTOR 2: THE CROSSED-BOOK REFUSAL ──
 *
 * A bid at or above its ask is arithmetically impossible on a venue that
 * matches, so the check needs no threshold and has no false-positive case --
 * PROVIDED it is done at the precision the venue published. It is: see
 * `compareDecimalStrings`, and the `ANKRXBT` evidence in its docblock for what
 * comparing at the money scale would have cost here. Gemini's version of this
 * check parses to `Money` first and is correct THERE because no Gemini symbol
 * prices below the money scale; the difference is the data, not the intent.
 *
 * Refusing is a `ParseError`, deliberately, so the client turns it into the
 * definite, non-retryable failure every existing caller already handles.
 *
 * BOTH SIDES MUST BE PRESENT to be checked. A missing or malformed `a`/`b` means
 * no book was sent, which is not the same as a broken one.
 */
export function parsePrice(pair: Pair, entry: unknown, at: Timestamp): Price {
  const context = `ticker for ${pair}`;
  const record = asRecord(entry, context);

  const bid = firstOfArray(record["b"]);
  const ask = firstOfArray(record["a"]);
  if (bid !== undefined && ask !== undefined) {
    const order = compareDecimalStrings(bid, ask);
    if (order !== undefined && order >= 0) {
      throw new ParseError(
        `${context} reports a CROSSED book: bid ${bid} is at or above ask ${ask}, ` +
          `which cannot happen on a venue that matches orders. Refusing this ` +
          `price rather than trading on a book that is not real (spec 5.7).`,
      );
    }
  }

  const last = firstOfArray(record["c"]);
  if (last === undefined) {
    throw new ParseError(
      `${context}: expected "c" to be [last price, volume], got ${describeShape(
        record["c"],
      )}`,
    );
  }

  return {
    pair,
    // Rounded, not refused: `BONKUSD` publishes `c[0]` at 12 decimal places
    // (live). See the file header.
    price: reportedMoneyValue(last, "c[0]", context, OBSERVED),
    at,
  };
}

/** The leading string of one of Kraken's `[price, ...]` ticker arrays. */
function firstOfArray(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  const first = value[0];
  return typeof first === "string" && first !== "" ? first : undefined;
}

/**
 * Accept `selectPairResult`'s `sole-key` fallback ONLY when the single key is a
 * name this catalogue cannot place.
 *
 * ⚠ FOUND BY A TEST, AND IT IS A REAL HOLE, NOT A PEDANTIC ONE. The fallback
 * exists because Kraken keys every reply by a name the client did not choose, so
 * a one-entry map whose key nothing recognises is almost certainly the pair that
 * was asked about (entry 90's "or read the single key out of the map"). But
 * `selectPairResult` cannot tell that case apart from a map holding ONE entry
 * for a DIFFERENT, PERFECTLY RECOGNISABLE pair -- and it returns that one too.
 * A request for `ETHBTC` answered with a map keyed `BONKUSD` would come back as
 * ETHBTC's candles. That is entry 89 PART 5's "silently routing an order into
 * the wrong version of a market", arriving through the front door.
 *
 * So the fallback is narrowed here rather than in the catalogue: if the sole key
 * RESOLVES to a pair, it must be the pair that was requested. If it resolves to
 * nothing, it is the unrecognised-name case the fallback was written for and is
 * accepted, with the match reported as `sole-key` for a caller that wants to
 * insist on more.
 *
 * `catalogue.ts` is deliberately left alone. `selectPairResult` REPORTS how it
 * matched precisely so each caller can set its own bar -- the docblock there
 * says an order path may insist on `canonical` while a ticker read may accept
 * `sole-key` -- and turning the report into a refusal would take that choice
 * away from every caller at once.
 */
function requireIntendedPair(
  selected: { key: string; matchedBy: string },
  catalogue: KrakenCatalogue,
  pair: KrakenPair,
  context: string,
): void {
  if (selected.matchedBy !== "sole-key") return;
  const resolved = catalogue.resolvePair(selected.key);
  if (resolved === undefined || resolved.canonical === pair.canonical) return;
  throw new ParseError(
    `${context}: the only key in the result is ${selected.key}, which Kraken ` +
      `lists as ${resolved.ticker} (${resolved.canonical}) -- a DIFFERENT market ` +
      `from the ${pair.ticker} (${pair.canonical}) that was requested. Refusing ` +
      `to read one pair's data under another pair's name.`,
  );
}

/**
 * Pull the one entry for `pair` out of a pair-keyed result map, then parse it.
 *
 * The map is keyed by Kraken's canonical name, which the client did not send --
 * `?pair=BTCUSD` and `?pair=XBTUSD` both answer under `XXBTZUSD` (entry 90
 * PROBLEM 1, verified live). `selectPairResult` owns that resolution and reports
 * HOW it matched, so a `sole-key` fallback is a fact the caller can see rather
 * than an unreported guess.
 */
export function parseTickerResult(
  result: unknown,
  catalogue: KrakenCatalogue,
  name: string,
  at: Timestamp,
): Price {
  const pair = catalogue.requirePair(name);
  const record = asRecord(result, `ticker for ${pair.ticker}`);
  const selected = catalogue.selectPairResult(record, pair);
  if (selected === undefined) {
    throw new ParseError(
      `ticker for ${pair.ticker}: no entry keyed by ${pair.canonical} or ` +
        `${pair.altname} in a result carrying [${Object.keys(record).join(", ")}]`,
    );
  }
  requireIntendedPair(selected, catalogue, pair, `ticker for ${pair.ticker}`);
  return parsePrice(pair.ticker, selected.value, at);
}

// ---------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------

/**
 * Parse `POST /0/private/AddOrder`'s acknowledgement.
 *
 * ⚠ THE RESPONSE IS ALMOST ENTIRELY PROSE, AND THE PROSE IS NOT READ.
 *
 *     {"descr": {"order": "buy 1.25000000 XBTUSD @ limit 27500.0"},
 *      "txid":  ["OU22CG-KLAF2-FWUDD7"]}
 *
 * `descr.order` contains the side, the quantity, the pair and the price -- and
 * it is a SENTENCE. Recovering any of them by pattern-matching it would be
 * building a parser against a string Kraken has never specified the grammar of,
 * one that renders conditional closes, leverage and stop prices in forms nobody
 * here has enumerated. Entry 90 rejected it explicitly, and this function
 * therefore reads `txid` and nothing else.
 *
 * WHAT EACH FIELD IS, AND WHERE IT COMES FROM:
 *
 *  - `exchangeOrderId` = `txid[0]`. Kraken's transaction id, the key every
 *    later `QueryOrders` reply is keyed by.
 *  - `clientOrderId`, `pair` -- FROM THE REQUEST. The acknowledgement echoes
 *    neither, so they come from what was sent. Taking them from the caller is
 *    not a shortcut: it is the only source, and the alternative is the prose.
 *  - `state` = `pending`. A GTC limit order that Kraken has accepted and that
 *    has executed nothing is `open` in Kraken's vocabulary and `pending` in this
 *    system's -- `toOrderState`'s own mapping, applied by hand here because the
 *    acknowledgement carries no status field to feed it.
 *  - `fills` = `[]`. CORRECT HERE SPECIFICALLY, and for a narrower reason than
 *    it looks. `OrderStatus.fills` is left ABSENT elsewhere in this codebase
 *    because an empty array would falsely assert "this order has no executions"
 *    about an order whose executions merely were not reported. That is not the
 *    situation here: `OrderResult.fills` is required, and an order Kraken has
 *    just accepted genuinely has none. The assertion is true, which is exactly
 *    why the same value would be wrong on a status read.
 *  - `acceptedAt` = RECEIPT TIME. Stated because this codebase draws the
 *    distinction sharply and repeatedly: `Price.at` is "when THIS system
 *    received it", `OrderStatus.updatedAt` is omitted rather than filled with a
 *    creation time, and `parseCancelledOrder` on Gemini takes receipt time for
 *    the same reason. AddOrder returns NO TIMESTAMP OF ANY KIND, so there is no
 *    exchange time to prefer and none is invented. `opentm` on a later
 *    `QueryOrders` read is Kraken's own account of when it accepted the order,
 *    and that is where an exchange time comes from if one is wanted.
 *
 * `txid` MUST HOLD EXACTLY ONE ID. Zero means Kraken reported success without
 * naming the order it created -- an order that may exist and cannot be found,
 * which is precisely what reconciliation exists to prevent. More than one means
 * a single `AddOrder` produced several transactions, and picking `[0]` would
 * bury that under a plausible-looking result. Both throw, with the reason named.
 * This is the same discipline `unwrapSingleOrder` applies on the Gemini side.
 */
export function parseOrderResult(
  request: { clientOrderId: string; pair: Pair },
  result: unknown,
  at: Timestamp,
): OrderResult {
  const context = "AddOrder result";
  const record = asRecord(result, context);
  const txid = record["txid"];

  if (!Array.isArray(txid)) {
    throw new ParseError(
      `${context}: expected txid to be an array of transaction ids, got ${describeShape(
        txid,
      )}`,
    );
  }
  if (txid.length === 0) {
    throw new ParseError(
      `${context}: Kraken reported success but returned no txid, so the order it ` +
        `may have created cannot be named or looked up. Refusing to report this ` +
        `as a placed order.`,
    );
  }
  if (txid.length > 1) {
    throw new ParseError(
      `${context}: Kraken returned ${txid.length} transaction ids for a single ` +
        `order; refusing to guess which one names the order that was placed.`,
    );
  }

  const exchangeOrderId = txid[0];
  if (typeof exchangeOrderId !== "string" || exchangeOrderId === "") {
    throw new ParseError(
      `${context}: expected txid[0] to be a non-empty string, got ${
        exchangeOrderId === undefined ? "undefined" : typeof exchangeOrderId
      }`,
    );
  }

  return {
    clientOrderId: request.clientOrderId,
    exchangeOrderId,
    pair: request.pair,
    // Kraken's `open` in this system's vocabulary. See the docblock.
    state: "pending",
    // Genuinely none, not merely unreported. See the docblock.
    fills: [],
    // RECEIPT time. AddOrder carries no exchange timestamp at all.
    acceptedAt: at,
  };
}

/**
 * The fields shared by every order record Kraken returns -- `QueryOrders`,
 * `OpenOrders` and `ClosedOrders` all use one shape.
 *
 * ⚠ `price` AND `descr.price` ARE DIFFERENT NUMBERS AND THE OBVIOUS ONE IS
 * WRONG. On a Kraken order record, top-level `price` is the AVERAGE EXECUTION
 * price so far (`"0.00000"` while nothing has filled), and `descr.price` is the
 * LIMIT price the order was placed at. `OrderStatus.price` is documented as the
 * order's price, so it reads `descr.price`. Reading the top-level field would
 * make every unfilled order report a limit of zero, and every partially filled
 * one report a limit that moves as it fills.
 *
 * `cumulativeQuoteQuantity` reads `cost` DIRECTLY -- Kraken publishes it, so
 * unlike Gemini there is no `avg_execution_price * executed_amount` derivation
 * and no rounding decision to defend.
 */
function parseCommonOrderFields(
  record: Record<string, unknown>,
  pair: KrakenPair,
  context: string,
): Pick<
  OrderStatus,
  | "pair"
  | "side"
  | "price"
  | "quantity"
  | "filledQuantity"
  | "cumulativeQuoteQuantity"
  | "state"
> {
  const descr = asRecord(record["descr"], `${context} descr`);
  const quantity = reportedMoney(record, "vol", context, OBSERVED);
  const filledQuantity = reportedMoney(record, "vol_exec", context, OBSERVED);

  return {
    // The catalogue's ticker, never `descr.pair` verbatim: that is Kraken's
    // altname (`XBTUSD`), and `validateOrder` compares against this system's
    // `Pair` (`BTCUSD`). Resolved by lookup, never by rewriting the string.
    pair: pair.ticker,
    side: parseSide(requireString(descr, "type", `${context} descr`), context),
    // `descr.price`, NOT `price`. See the docblock.
    price: reportedMoney(descr, "price", `${context} descr`, OBSERVED),
    quantity,
    filledQuantity,
    cumulativeQuoteQuantity: reportedMoney(record, "cost", context, OBSERVED),
    state: toOrderState(record["status"], filledQuantity, quantity),
  };
}

/**
 * Parse one order record, keyed by its Kraken transaction id.
 *
 * `createdAt` is `opentm`, Kraken's own account of when it accepted the order.
 * `updatedAt` is `closetm` WHEN KRAKEN SENT ONE and it is non-zero -- which is a
 * genuine transition time, and makes Kraken the one venue of the three that can
 * populate the field honestly (`gemini/parse.ts` omits it because Gemini
 * publishes nothing but a creation time; Kraken reports the instant the order
 * left the book). A resting order has no `closetm`, and the key is then ABSENT
 * rather than set to `undefined` or backfilled from `opentm`: see
 * `OrderStatus.updatedAt` on what setting it to the creation time cost the last
 * time somebody did it.
 *
 * ⚠ `clientOrderId` FALLS BACK TO THE EMPTY STRING, DELIBERATELY. `cl_ord_id` is
 * present only on orders that were placed with one, so an order entered through
 * Kraken's own UI carries none -- and reconciliation reads exactly those. The
 * three options were: throw (one manual order in the account makes
 * `getOpenOrders` fail entirely, blinding the job that exists to find it),
 * substitute `userref` or the txid (an id that LOOKS like this system's scheme
 * and is not, which is the fabrication this codebase refuses elsewhere), or
 * report the absence. The empty string is the absence, and it is not inert:
 * `parseClientOrderId("")` returns `null`, so `reconcile.ts` classifies the
 * order as `unknown_open_order` and names its exchange id -- precisely the
 * finding an unmanaged live order should produce.
 *
 * `fills` is ABSENT, never `[]`. Kraken's `trades` field on an order record is
 * an array of trade IDS, not of executions -- there is no price, quantity or fee
 * in it. An empty array here would assert "this order has no executions" about a
 * partially filled order, which is false; per-fill detail comes from
 * `QueryTrades` and `parseTrades`, which is reconciliation's concern.
 */
export function parseOrderStatus(
  txid: string,
  record: unknown,
  catalogue: KrakenCatalogue,
): OrderStatus {
  const context = `order ${txid}`;
  const order = asRecord(record, context);
  const descr = asRecord(order["descr"], `${context} descr`);
  const pair = catalogue.requirePair(requireString(descr, "pair", `${context} descr`));

  const clOrdId = order["cl_ord_id"];
  const closetm = order["closetm"];
  const updatedAt =
    typeof closetm === "number" && Number.isFinite(closetm) && closetm > 0
      ? secondsToMs(closetm, "closetm", context)
      : undefined;

  return {
    ...parseCommonOrderFields(order, pair, context),
    // See the docblock on why an absent id becomes "" rather than a throw.
    clientOrderId: typeof clOrdId === "string" ? clOrdId : "",
    exchangeOrderId: txid,
    createdAt: secondsToMs(order["opentm"], "opentm", context),
    // Spread rather than assigned, so a resting order has NO `updatedAt` key at
    // all rather than one holding `undefined`.
    ...(updatedAt !== undefined ? { updatedAt } : {}),
    // No `fills` key. See the docblock.
  };
}

/**
 * Parse a `{txid: order}` map -- `QueryOrders`' whole result, and the inner
 * `open` / `closed` object of the list endpoints.
 *
 * Order is not promised by an object, so the result is sorted by `createdAt`
 * ascending for a stable, oldest-first list. That mirrors `parseCandles`'
 * refusal to trust the venue's ordering, and costs nothing.
 */
export function parseOrderStatusMap(
  result: unknown,
  catalogue: KrakenCatalogue,
  context = "orders",
): OrderStatus[] {
  const record = asRecord(result, context);
  const orders = Object.entries(record).map(([txid, entry]) =>
    parseOrderStatus(txid, entry, catalogue),
  );
  orders.sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
  return orders;
}

/**
 * `POST /0/private/OpenOrders` -> `{open: {txid: order}}`.
 *
 * The nesting is the only difference from `QueryOrders`. Kraken applies NO pair
 * filter to this endpoint -- exactly as Gemini's `/v1/orders` does not -- so
 * filtering to the requested pair is the client's job, done locally, on the same
 * reasoning recorded on the Gemini side.
 */
export function parseOpenOrders(
  result: unknown,
  catalogue: KrakenCatalogue,
): OrderStatus[] {
  const record = asRecord(result, "OpenOrders");
  return parseOrderStatusMap(record["open"], catalogue, "OpenOrders");
}

/** `POST /0/private/ClosedOrders` -> `{closed: {txid: order}, count: n}`. */
export function parseClosedOrders(
  result: unknown,
  catalogue: KrakenCatalogue,
): OrderStatus[] {
  const record = asRecord(result, "ClosedOrders");
  return parseOrderStatusMap(record["closed"], catalogue, "ClosedOrders");
}

/**
 * The one order in a single-order query, or a throw.
 *
 * Zero and several are both refused, in the same words and for the same reasons
 * `unwrapSingleOrder` refuses them on the Gemini side: an empty result would let
 * an order that exists but cannot be found be reported as "no such order", and
 * several answers to a one-order question means an assumption here is wrong.
 */
export function requireSingleOrder(orders: readonly OrderStatus[], context: string): OrderStatus {
  if (orders.length === 1) return orders[0]!;
  throw new ParseError(
    orders.length === 0
      ? `${context}: Kraken returned no orders, so none matched the request. ` +
        `Refusing to report this as "no such order" -- an order that exists but ` +
        `cannot be found is exactly what reconciliation must not miss.`
      : `${context}: Kraken returned ${orders.length} orders for a single-order ` +
        `request, which is ambiguous; refusing to guess which one is meant.`,
  );
}

// ---------------------------------------------------------------------------
// Cancellation
// ---------------------------------------------------------------------------

/**
 * `POST /0/private/CancelOrder` -> `{count: 1}`, sometimes `{count: 1, pending: true}`.
 *
 * NOTHING ELSE. No filled quantity, no state, no order id -- which is entry 90
 * PROBLEM 4, the sharpest conflict in the whole Kraken integration:
 * `cancelOrder` returns the cancelled order precisely so a halt does not need a
 * follow-up read, and on Kraken it must do one anyway. DECISION 2 resolves it as
 * cancel, then exactly one `QueryOrders`, never a loop.
 *
 * `pending` is surfaced rather than swallowed BECAUSE of that decision: it is
 * the venue telling the caller that the single following read may catch the
 * order mid-transition, which is the known, accepted staleness DECISION 2
 * records as a deliberate tradeoff. A caller that cannot see the flag cannot
 * report the tradeoff it is making.
 *
 * `count: 0` is not an error here. It means nothing matched -- an order already
 * filled or already cancelled -- and that is a real, ordinary answer during a
 * halt racing its own fills. Judging it belongs to the caller that knows what it
 * asked to cancel.
 */
export interface KrakenCancelResult {
  readonly count: number;
  /** Kraken set `pending: true`: the cancel had not taken effect at reply time. */
  readonly pending: boolean;
}

export function parseCancelResult(result: unknown): KrakenCancelResult {
  const context = "CancelOrder";
  const record = asRecord(result, context);
  const count = record["count"];
  if (typeof count !== "number" || !Number.isInteger(count) || count < 0) {
    throw new ParseError(
      `${context}: expected count to be a non-negative integer, got ${JSON.stringify(
        count,
      )}`,
    );
  }
  return { count, pending: record["pending"] === true };
}

// ---------------------------------------------------------------------------
// Trades (fills)
// ---------------------------------------------------------------------------

/**
 * Parse `POST /0/private/QueryTrades` -> `{trades: {txid: trade}, count: n}`,
 * or a bare `{txid: trade}` map.
 *
 * THE FEE ASSET IS SUPPLIED, NOT READ, and that is the venue's doing: a Kraken
 * trade record carries `fee` as a bare decimal string with NO currency field
 * anywhere in it. `feeAssetFor` answers the question instead -- from the
 * `oflags` this system asserted on the order (DECISION 4), or from Kraken's
 * side-dependent default for an order it did not place. `oflags` lives on the
 * ORDER record, not the trade, so the caller passes it down.
 *
 * `fillId` is the MAP KEY, Kraken's trade transaction id (`TZX2WP-XSEUP-...`), a
 * string. The record also carries a numeric `trade_id`; the key is preferred so
 * the identity comparison in `applyFill`'s duplicate check can never be
 * disturbed by JSON number precision -- the same rule `gemini/parse.ts` states
 * for `tid`.
 *
 * `executedAt` is the trade's OWN `time`, not a value inherited from the parent
 * order: Kraken publishes one per trade, so -- unlike a Binance fill -- there is
 * nothing to inherit and nothing to approximate.
 */
export function parseTrades(
  result: unknown,
  catalogue: KrakenCatalogue,
  options: { oflags?: unknown } = {},
): Fill[] {
  const outer = asRecord(result, "QueryTrades");
  const map = asRecord(
    outer["trades"] !== undefined ? outer["trades"] : outer,
    "QueryTrades trades",
  );

  const fills = Object.entries(map).map(([txid, entry]) => {
    const context = `trade ${txid}`;
    const record = asRecord(entry, context);
    const pair = catalogue.requirePair(requireString(record, "pair", context));
    const side = parseSide(requireString(record, "type", context), context);

    return {
      fillId: txid,
      price: reportedMoney(record, "price", context, OBSERVED),
      quantity: reportedMoney(record, "vol", context, OBSERVED),
      // A fee is money OWED. Rounding it up never understates what was paid,
      // which is the cautious direction for a cost -- the mirror of the reason
      // `filters.ts` rounds a venue minimum up rather than down.
      feeAmount: reportedMoney(record, "fee", context, "ceil"),
      feeAsset: feeAssetFor(pair, side, options.oflags),
      executedAt: secondsToMs(record["time"], "time", context),
    } satisfies Fill;
  });

  fills.sort((a, b) => a.executedAt - b.executedAt);
  return fills;
}

// ---------------------------------------------------------------------------
// Balances
// ---------------------------------------------------------------------------

/**
 * Parse `POST /0/private/BalanceEx` -> `{"ZUSD": {balance, hold_trade}, ...}`.
 *
 * ⚠ `BalanceEx`, NOT `Balance`. The plain endpoint returns a single total per
 * asset and nothing else; only the extended form reports `hold_trade`, and the
 * interface wants `free` and `locked` SEPARATELY (entry 90, 2.1). Reading the
 * plain endpoint would force `locked` to be invented as zero, which would tell
 * the capital ledger that money reserved against open orders is available to
 * spend -- the overspend direction.
 *
 * `locked` = `hold_trade`; `free` = `balance - hold_trade`. The same derivation
 * shape as Gemini's `locked = amount - available`, with the two roles swapped:
 * there the FREE figure is reported and the reserved one derived, here it is the
 * other way round.
 *
 * ── WHY THE TWO FIELDS ROUND IN OPPOSITE DIRECTIONS ──
 *
 * Kraken declares `XXBT` with `decimals: 10` (live), so balances genuinely carry
 * more precision than the money scale and must be rounded rather than refused --
 * the Gemini lesson, where an 11-place balance made an account unreadable
 * entirely. `gemini/parse.ts` floors both of its fields, and copying that here
 * would be copying the code rather than the reasoning, because the derived
 * quantity is not the same one.
 *
 * The cautious direction is: never overstate what can be spent, never understate
 * what is reserved. So `balance` FLOORS and `hold_trade` CEILS, and `free =
 * floor(balance) - ceil(hold_trade)` is understated by at most 2e-8 rather than
 * being rounded in whichever direction happened to fall out. Both errors are
 * sub-satoshi and both land on the side that cannot overspend.
 *
 * A NEGATIVE `free` IS REFUSED, NOT CLAMPED. It would mean Kraken reported more
 * on hold than the account holds, which is impossible; clamping it to zero would
 * turn a genuine API change into a plausible-looking wrong balance. The one
 * false positive this could produce is a balance within 2e-8 of being fully
 * reserved, where the opposed rounding could cross zero -- so the check permits
 * that margin explicitly and refuses anything beyond it, rather than being
 * loosened into meaninglessness.
 *
 * ASSET CODES GO THROUGH THE CATALOGUE, and an unknown one THROWS -- taking the
 * whole read with it. That is `tickerForAsset`'s own documented policy and it is
 * the right one here: a balance mislabelled with a guessed ticker is a wrong
 * number in exactly the place section 9 must reconcile, and an unknown code
 * means the catalogue is stale, which the caller can fix by refetching but only
 * if it is told. A failed read is a failed read; a wrong balance is silent.
 */
export function parseBalances(result: unknown, catalogue: KrakenCatalogue): Balance[] {
  const record = asRecord(result, "BalanceEx");

  return Object.entries(record).map(([code, entry]) => {
    const context = `balance ${code}`;
    const asset = asRecord(entry, context);
    const total = reportedMoney(asset, "balance", context, "floor");
    const locked = reportedMoney(asset, "hold_trade", context, "ceil");
    const free = total - locked;

    // The opposed rounding above can cost at most one unit in each direction.
    if (free < -ROUNDING_SLACK) {
      throw new ParseError(
        `${context}: hold_trade (${asset["hold_trade"]}) exceeds balance ` +
          `(${asset["balance"]}); refusing to report a negative free balance`,
      );
    }

    return {
      asset: catalogue.tickerForAsset(code),
      free: free < ZERO ? ZERO : free,
      locked,
    };
  });
}

/**
 * Two units at the money scale: the most `free` can be dragged below zero by
 * flooring the total and ceiling the hold. Anything past it is a real
 * contradiction in the payload, not a rounding artefact.
 */
const ROUNDING_SLACK: Money = 2n;

// ---------------------------------------------------------------------------
// Candles
// ---------------------------------------------------------------------------

/** Kraken's own spelling of an interval, and its length in milliseconds. */
export interface KrakenTimeframe {
  /** The `interval` query parameter, in MINUTES. */
  readonly minutes: number;
  readonly ms: number;
}

/**
 * The interface's canonical intervals mapped onto Kraken's OHLC `interval`
 * parameter.
 *
 * ⚠ `"6h"` IS `null`, AND THE NULL IS THE POINT. Kraken's OHLC endpoint accepts
 * 1, 5, 15, 30, 60, 240, 1440, 10080 and 21600 minutes -- 240 (4h) and 1440 (1d)
 * with NOTHING BETWEEN THEM. `CandleInterval` is a closed union that includes
 * `"6h"`, so this table cannot be total and truthful at the same time, and
 * `interval=360` is not silently ignored either: live, it answers
 * `{"error":["EGeneral:Invalid arguments"]}`.
 *
 * THERE IS NO EXISTING CONVENTION IN THIS CODEBASE FOR THIS CASE, and that was
 * checked rather than assumed -- `GEMINI_TIMEFRAMES` and Binance's pass-through
 * both cover all seven intervals, because both venues support all seven, and the
 * one `Partial<Record<...>>` in the repository (`reconcile.ts`) is a lookup
 * table, not a capability table. So the shape below is a choice, and these are
 * the three that were available:
 *
 *  - `Partial<Record<CandleInterval, KrakenTimeframe>>`, omitting the key.
 *    REJECTED: it drops the compile-time forcing function. Adding an interval to
 *    the union would leave every venue table silently incomplete rather than
 *    breaking the build, which is the property `SymbolStatus` and
 *    `CandleInterval` are declared as closed unions to get.
 *  - Map `"6h"` onto 240 or 1440 minutes. REJECTED OUTRIGHT: it answers a
 *    request for six-hour candles with four-hour or daily ones, and the caller
 *    cannot tell. That is a wrong number wearing the right label.
 *  - A TOTAL record whose unsupported member is explicitly `null`, read through
 *    `krakenTimeframe`, which throws naming the interval and the venue.
 *
 * The third is what this is. Totality is kept -- a new `CandleInterval` still
 * fails to compile until Kraken's answer for it is written down -- and the
 * absence is stated in the data rather than hidden in the type. Only `"1m"` is
 * exercised in v1 (the price feed's gap-backfill, section 4.6); the rest are the
 * declared extension surface for section 13's backtest and are unverified
 * against the live endpoint, exactly as on the other two venues.
 */
export const KRAKEN_TIMEFRAMES: Readonly<Record<CandleInterval, KrakenTimeframe | null>> =
  Object.freeze({
    "1m": { minutes: 1, ms: 60_000 },
    "5m": { minutes: 5, ms: 300_000 },
    "15m": { minutes: 15, ms: 900_000 },
    "30m": { minutes: 30, ms: 1_800_000 },
    "1h": { minutes: 60, ms: 3_600_000 },
    // Kraken jumps 240 -> 1440. See the docblock; this is not an oversight.
    "6h": null,
    "1d": { minutes: 1440, ms: 86_400_000 },
  });

/**
 * Kraken's timeframe for an interval, or a throw naming what the venue lacks.
 *
 * A `ParseError` rather than a silent substitution, so a `"6h"` request fails
 * loudly at the one venue that cannot serve it instead of quietly returning
 * candles of a different length.
 */
export function krakenTimeframe(interval: CandleInterval): KrakenTimeframe {
  const timeframe = KRAKEN_TIMEFRAMES[interval];
  if (timeframe === null) {
    throw new ParseError(
      `Kraken publishes no ${interval} OHLC interval (it offers 1, 5, 15, 30, 60, ` +
        `240, 1440, 10080 and 21600 minutes, with nothing between 240 and 1440); ` +
        `refusing to substitute a different candle length under the same name`,
    );
  }
  return timeframe;
}

/**
 * The sibling key Kraken puts NEXT TO the candle array in the same object.
 *
 * `{"XXBTZUSD": [[...], ...], "last": 1788406320}` -- verified live. It is an id
 * to pass back as `since`, not a pair, and a parser that iterates the result map
 * looking for candles will find it and try to read a NUMBER as an array of rows.
 */
export const OHLC_LAST_KEY = "last";

/**
 * Parse `GET /0/public/OHLC` into `Candle`s, oldest-first.
 *
 * ⚠ TWO TRAPS, BOTH LIVE-VERIFIED, NEITHER SHARED WITH THE OTHER VENUES.
 *
 * FIRST, THE `last` SIBLING. The result is
 * `{"<canonical pair>": [rows...], "last": <unix seconds>}`. `last` is removed
 * BEFORE the pair is resolved, for two reasons: parsing it as a candle would
 * fail on a number, and leaving it in defeats `selectPairResult`'s `sole-key`
 * fallback -- with `last` present the map always has at least two entries, so a
 * reply keyed by a name the catalogue cannot match would be refused outright
 * rather than resolved. Stripping it first restores the fallback entry 90
 * explicitly allows.
 *
 * SECOND, THE COLUMN ORDER. A row is
 *
 *     [time, open, high, low, close, VWAP, volume, count]
 *
 * -- EIGHT columns, with VWAP at index 5 and VOLUME AT INDEX 6. Binance's klines
 * and Gemini's `/v2/candles` both put volume at index 5, so the field that reads
 * across from both other venues is the wrong one, and it is wrong in a way that
 * looks plausible: VWAP is a price-shaped number in the right magnitude range.
 * Live evidence, `XBTUSD` 1m: `[..., "77188.6", "7.11779340", 154]` -- the VWAP
 * sits with the four OHLC prices near 77,000 and the volume is 7.1.
 *
 * `time` is UNIX SECONDS (an integer here, unlike the fractional order
 * timestamps) and is the OPEN time; Kraken publishes no close time, so it is
 * derived as `openTime + intervalMs - 1` -- the candle's last millisecond,
 * matching `GEMINI_TIMEFRAMES.ms`' approach and the inclusive convention Binance
 * reports directly. `closed` is set from whether that instant has passed at
 * request time, so the in-progress candle comes back `closed: false`.
 *
 * OHLCV are decimal STRINGS -- no `Number` anywhere, unlike Gemini's candles --
 * but they are NOT within the money scale on every pair: `BONKUSD` publishes 9
 * decimal places live. They are rounded half-even, not refused; see the file
 * header.
 *
 * Sorted ascending by open time rather than trusting Kraken's ordering, exactly
 * as the Gemini parser does, so a change in the venue's order cannot silently
 * reverse the series.
 */
export function parseCandles(
  result: unknown,
  catalogue: KrakenCatalogue,
  name: string,
  at: Timestamp,
  intervalMs: number,
): Candle[] {
  const pair = catalogue.requirePair(name);
  const context = `OHLC for ${pair.ticker}`;
  const record = asRecord(result, context);

  // Strip the `last` sibling before anything looks for a pair. See the docblock.
  const keyed: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (key === OHLC_LAST_KEY) continue;
    keyed[key] = value;
  }

  const selected = catalogue.selectPairResult(keyed, pair);
  if (selected === undefined) {
    throw new ParseError(
      `${context}: no candle array keyed by ${pair.canonical} or ${pair.altname} ` +
        `in a result carrying [${Object.keys(record).join(", ")}]`,
    );
  }
  requireIntendedPair(selected, catalogue, pair, context);

  const rows = selected.value;
  if (!Array.isArray(rows)) {
    throw new ParseError(
      `${context}: expected ${selected.key} to hold an array of candle rows, got ` +
        `${describeShape(rows)}`,
    );
  }

  const candles: Candle[] = rows.map((row, index) => {
    const rowContext = `${context} row ${index}`;
    if (!Array.isArray(row) || row.length < 7) {
      throw new ParseError(
        `${rowContext}: expected [time, open, high, low, close, vwap, volume, count], ` +
          `got ${describeShape(row)}`,
      );
    }
    const openTime = secondsToMs(row[0], "time", rowContext);
    const closeTime = openTime + intervalMs - 1;
    return {
      pair: pair.ticker,
      openTime,
      closeTime,
      open: reportedMoneyValue(row[1], "open", rowContext, OBSERVED),
      high: reportedMoneyValue(row[2], "high", rowContext, OBSERVED),
      low: reportedMoneyValue(row[3], "low", rowContext, OBSERVED),
      close: reportedMoneyValue(row[4], "close", rowContext, OBSERVED),
      // INDEX 6. Index 5 is VWAP. See the docblock.
      volume: reportedMoneyValue(row[6], "volume", rowContext, OBSERVED),
      closed: at > closeTime,
    };
  });

  candles.sort((a, b) => a.openTime - b.openTime);
  return candles;
}
