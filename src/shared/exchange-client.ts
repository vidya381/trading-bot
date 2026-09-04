/**
 * The internal exchange interface (spec section 4.1).
 *
 * Type-only. There is no implementation here and no Binance-specific request
 * shape, signing, or endpoint. The Binance implementation lives in
 * `/src/exchange/binance`; a second exchange would be added later as another
 * implementation of this same interface, without touching strategy code.
 *
 * All strategy code and shared modules depend only on these types.
 *
 * The supporting types below were designed at step 2 with no real payload to
 * check against, and step 3 corrected four of them against the exchange's
 * published reference. Those corrections are marked where they appear.
 *
 * Note the type-only cycle with `./downtime`: it imports `Timestamp` from here
 * and this imports `ExchangeOutcome` from there. Both are erased at compile
 * time under `verbatimModuleSyntax`, so no cycle exists at runtime.
 */

import type { ExchangeOutcome } from "./downtime";
import type { Money } from "./money";
import type { OrderState } from "./order-state";

/** A trading pair symbol as the exchange names it, e.g. "BTCUSDT". */
export type Pair = string;

/** An asset ticker, e.g. "BTC", "USDT", "BNB". */
export type Asset = string;

/** Milliseconds since the Unix epoch. */
export type Timestamp = number;

export type OrderSide = "buy" | "sell";

/**
 * Order type. Limit only: section 4.5 rules out market orders entirely in v1,
 * for price certainty. Declared as a union so adding a type later is a visible,
 * deliberate change rather than a silently widened string.
 */
export type OrderType = "limit";

/**
 * Whether a symbol is currently tradable.
 *
 * Taken from the exchange's own symbol status enum. Only `TRADING` permits an
 * order; the rest exist so a halted or delisted symbol is a value the code must
 * handle rather than an absent case.
 */
export type SymbolStatus =
  | "TRADING"
  | "END_OF_DAY"
  | "HALT"
  | "BREAK"
  | "CANCEL_ONLY";

/**
 * WHAT KIND OF INSTRUMENT a symbol names, as the VENUE ITSELF reports it.
 *
 * Every order, fill, position and PnL path in this system is SPOT (section 4.5:
 * "Grid and DCA strategies use limit orders exclusively"; nothing anywhere
 * understands margin, funding or liquidation). A venue that lists perpetual
 * futures in the same catalogue as its spot pairs will therefore hand this
 * system an instrument it cannot model, and decision log 31 found exactly that:
 * Gemini's live catalogue carries `HYPEGUSDPERP` and `HYPEUSDCPERP` alongside
 * `BTCUSD`, with nothing in this repository able to tell them apart.
 *
 * This is deliberately NOT derived from the symbol string. A `PERP` suffix is a
 * naming convention observed in Gemini's data and documented as a rule NOWHERE
 * in their reference, so inferring from it is a guess in both directions: a perp
 * named without the suffix passes, and a real spot pair whose base asset is
 * literally `PERP` (Perpetual Protocol is a real token) would be refused. The
 * three values below come from a real structured field or from nothing.
 *
 *  - `spot`       -- the venue said so, in a field meaning instrument type.
 *  - `derivative` -- the venue said this is a swap/perpetual/futures contract.
 *  - `unknown`    -- the venue sent a value this code cannot map. Distinct from
 *                    the field being ABSENT (which is `undefined` on
 *                    `SymbolFilters` below), because "Gemini changed its enum"
 *                    and "Binance publishes no such field" are different facts
 *                    and only one of them is a reason to stop trusting a
 *                    payload.
 */
export type InstrumentKind = "spot" | "derivative" | "unknown";

/**
 * A symbol's trading rules, cached and periodically refreshed (section 4.3).
 * Used to validate and round an order before it is constructed, and again
 * independently before it is sent.
 *
 * The price and notional bounds follow the exchange's convention that a bound
 * of ZERO means the rule is DISABLED, not that the bound is literally zero. A
 * validator must therefore check for ZERO before applying any of them -- and in
 * particular before passing a step to `roundToStep`, which rejects a
 * non-positive step.
 */
export interface SymbolFilters {
  pair: Pair;
  baseAsset: Asset;
  quoteAsset: Asset;
  /** Orders may only be placed while this is `TRADING`. */
  status: SymbolStatus;
  /** Price increment. A price must be an exact multiple of this. ZERO disables. */
  tickSize: Money;
  /** Lowest permitted price. ZERO disables. */
  minPrice: Money;
  /** Highest permitted price. ZERO disables. */
  maxPrice: Money;
  /** Quantity increment. A quantity must be an exact multiple of this. ZERO disables. */
  stepSize: Money;
  minQuantity: Money;
  maxQuantity: Money;
  /** Minimum price x quantity. Below this the order must not be sent. ZERO disables. */
  minNotional: Money;
  /**
   * Maximum price x quantity. ZERO disables.
   *
   * Present because the exchange's current notional filter is a RANGE, not the
   * floor that section 4.3 describes. An order above the ceiling is rejected
   * just as firmly as one below the floor.
   */
  maxNotional: Money;
  /**
   * What kind of instrument this symbol names, when the venue publishes it.
   *
   * OPTIONAL, and the absence is meaningful rather than a gap to be filled in
   * later: it means THIS VENUE'S PAYLOAD CARRIES NO INSTRUMENT-TYPE FIELD AT
   * ALL. Binance's `/api/v3/exchangeInfo` is the spot API and its perpetuals
   * live behind a different host (`fapi.binance.com`, `contractType:
   * PERPETUAL`) that this system does not know exists, so there is no field to
   * read and no ambiguity to resolve. Gemini's `/v1/symbols/details/:symbol`
   * does publish one, and populates this.
   *
   * `undefined` is therefore NOT "we did not check" -- see
   * `checkSpotInstrument` in `/src/research/tradability.ts`, which turns the
   * distinction into a per-venue policy rather than letting each caller guess.
   */
  instrument?: InstrumentKind;
  /** When these filters were fetched, so staleness can be judged. */
  fetchedAt: Timestamp;
}

/**
 * A point-in-time price, carrying the time it was observed.
 *
 * `at` is when THIS system received the price, not when the exchange computed
 * it: the spot price ticker returns a symbol and a price and no timestamp at
 * all. That distinction matters to section 5.6's freshness checks, which use
 * this field to decide whether a stop-loss may evaluate against the value --
 * the age it measures is "how long since we heard", which is the right question
 * but is not the same as the price's own age on the exchange.
 */
export interface Price {
  pair: Pair;
  price: Money;
  at: Timestamp;
}

/** A single OHLCV candle, from the live feed or from historical REST data. */
export interface Candle {
  pair: Pair;
  openTime: Timestamp;
  closeTime: Timestamp;
  open: Money;
  high: Money;
  low: Money;
  close: Money;
  volume: Money;
  /**
   * Whether the candle is final. A live feed emits repeated updates for the
   * in-progress candle; strategy logic generally acts only on closed ones.
   */
  closed: boolean;
}

/**
 * A candle interval, in the canonical short form this system uses.
 *
 * The subset both Binance and Gemini support. Each implementation maps these to
 * the exchange's own spelling (Gemini writes "1hr"/"6hr"/"1day" for the last
 * three). Declared in full -- like `SymbolStatus` -- so the set is a closed
 * union the code handles rather than a free string, but only "1m" is exercised
 * and verified in v1: it is what the price feed's gap-backfill (section 4.6,
 * step 14) needs. The wider intervals are the declared extension surface for
 * section 13's backtest, and each must be verified per exchange before first use.
 */
export type CandleInterval = "1m" | "5m" | "15m" | "30m" | "1h" | "6h" | "1d";

/**
 * An order the bot wants to place.
 *
 * `clientOrderId` is generated deterministically by the bot (section 5.1) and
 * is the idempotency key: the exchange rejects a reused id, which is the second
 * layer of duplicate protection.
 */
export interface OrderRequest {
  pair: Pair;
  clientOrderId: string;
  side: OrderSide;
  type: OrderType;
  price: Money;
  quantity: Money;
}

/** One execution against an order, with the fee exactly as the exchange reported it. */
export interface Fill {
  /**
   * The exchange's own identifier for this execution, for deduplication.
   *
   * A string here, though the exchange sends a signed 64-bit integer. Kept as a
   * string so the identity comparison in `applyFill`'s duplicate check can never
   * be affected by JSON number precision.
   */
  fillId: string;
  price: Money;
  quantity: Money;
  /**
   * Fee amount in `feeAsset`, NOT in the quote currency. Section 5.5 is
   * explicit that fees must never be assumed to be paid in the quote currency.
   */
  feeAmount: Money;
  feeAsset: Asset;
  /**
   * When the execution happened.
   *
   * Inherited from the PARENT ORDER, not from the fill itself: the fills
   * attached to an order-placement response carry a price, a quantity, a
   * commission, a commission asset and a trade id, and no time field of any
   * kind. Every fill in one response therefore shares the parent's timestamp,
   * which is accurate to the moment the order was processed rather than to each
   * individual execution within it.
   *
   * This is precise enough for section 5.5's rule that a fee is converted at the
   * price at time of fill -- the executions in a single response are milliseconds
   * apart -- but it is an inherited value, not an observed one.
   */
  executedAt: Timestamp;
}

/** The exchange's acknowledgement of a newly placed order. */
export interface OrderResult {
  clientOrderId: string;
  exchangeOrderId: string;
  pair: Pair;
  state: OrderState;
  /** Fills already executed at acknowledgement time; usually empty for a limit order. */
  fills: readonly Fill[];
  acceptedAt: Timestamp;
}

/** The current state of an order as the exchange reports it. */
export interface OrderStatus {
  clientOrderId: string;
  exchangeOrderId: string;
  pair: Pair;
  side: OrderSide;
  price: Money;
  /** Quantity originally requested. */
  quantity: Money;
  /** Quantity executed so far; equals `quantity` only when fully filled. */
  filledQuantity: Money;
  /**
   * Cumulative quote-asset value of everything filled so far.
   *
   * The average fill price is this divided by `filledQuantity`. That derivation
   * is the only one available on the status endpoints, which is why the field is
   * carried rather than discarded -- see `fills` below.
   */
  cumulativeQuoteQuantity: Money;
  state: OrderState;
  /**
   * Individual executions, WHEN THE EXCHANGE SUPPLIED THEM -- optional, and
   * absent far more often than not.
   *
   * Only the order-placement response carries a fills array. The order-status
   * and open-orders endpoints return aggregate quantities and no per-fill
   * breakdown at all, so this key is genuinely missing on anything read back
   * later.
   *
   * Optional rather than defaulted to `[]`, because an empty array would assert
   * "this order has no executions" -- which, for a partially filled order read
   * from the status endpoint, is false. Distinguishing "no fills" from "fills
   * not reported" is the whole point. Per-fill history for an order the exchange
   * will not break down has to come from the account trade list, which is
   * reconciliation's concern at step 7, not this interface's.
   */
  fills?: readonly Fill[];
  /**
   * When the exchange first accepted the order -- WHEN IT REPORTED IT.
   *
   * Absent on the record returned by `cancelOrder`: a cancellation response
   * carries the time of the cancellation and no creation time at all. It is left
   * missing rather than filled in with the cancellation time, which would be a
   * fabricated value that looks authoritative.
   *
   * Nothing is lost by that. A caller cancelling an order placed it, so it
   * already holds the creation time in its own stored record; this field exists
   * for reconciliation reading back orders it did not necessarily place.
   */
  createdAt?: Timestamp;
  /**
   * Last change the exchange reported. For a cancellation this is the moment the
   * cancel took effect, which is exactly the instant `filledQuantity` describes.
   *
   * OPTIONAL, for exactly the reason `createdAt` above is: not every venue
   * reports one, and echoing a different timestamp back in its place is a
   * fabricated value that looks authoritative. Gemini's `/v1/order/status`
   * carries a single `timestampms` -- the order's CREATION time -- and no
   * transition time of any kind (confirmed field-by-field against a captured
   * live payload; see `gemini/parse.test.ts`), so its parser leaves this ABSENT
   * rather than reporting creation time as a last update.
   *
   * THE BUG THAT MADE THIS OPTIONAL. Until it was, Gemini's parser satisfied the
   * type by setting `updatedAt = createdAt`, and reconciliation's terminated-order
   * tolerance -- a 60-second window it no longer has -- computed `at - updatedAt`
   * against it. On Gemini that measured the order's TOTAL AGE, so no Gemini order
   * older than sixty seconds could ever qualify and the tolerance was silently
   * inoperative on the venue.
   *
   * NO SAFETY DECISION READS THIS FIELD ON ANY VENUE. Reconciliation no longer
   * asks "how long ago did this terminate" at all: both available substitutes
   * were evaluated and rejected -- creation time makes a window dead (the bug
   * above), receipt time makes it universal, silencing real drift on every
   * terminated order -- so the question was abandoned rather than re-answered.
   * `liveOrderFindings` in `reconciliation/reconcile.ts` decides entirely on a
   * run-to-run memory that reads no venue clock, for every exchange alike.
   *
   * The field is still parsed truthfully where a venue reports it, because it is
   * RECORDED: it is written to `orders.updated_at` and read by the dashboard. A
   * venue clock may inform records; it may not inform decisions.
   */
  updatedAt?: Timestamp;
}

/** A balance for one asset on the exchange account. */
export interface Balance {
  asset: Asset;
  /** Available to trade. */
  free: Money;
  /** Reserved against open orders. */
  locked: Money;
}

/**
 * The exchange interface: everything reachable over REST, and the whole surface
 * a strategy needs in order to act.
 *
 * Every method resolves to an `ExchangeOutcome` rather than to a bare value.
 * Section 4.1 writes these as `Promise<Price>`, `Promise<OrderResult>` and so
 * on, but that signature cannot express section 5.6's central rule: a value
 * that never arrived must not be usable as though it had. A rejected promise
 * does not enforce it -- a caught exception leaves the caller holding whatever
 * it had before, and section 7.5 escalates anything uncaught to an immediate
 * halt, which turns a routine 503 into a halt-and-alert event.
 *
 * With the outcome in the return type, `isUsable` is the only way through, and
 * a failed request cannot reach a stop-loss evaluation without the type system
 * objecting. This is the deviation from section 4.1's literal signatures that
 * makes section 5.6 structural rather than advisory.
 *
 * Implementations are responsible for signing, clock-drift correction, and
 * translating exchange-specific payloads into the types above. Callers see none
 * of that.
 *
 * Retrying is deliberately NOT an implementation concern. `withRetry` in the
 * downtime module already takes an operation of exactly this shape, so a caller
 * composes it where a retry is appropriate -- and, just as importantly, does not
 * where it is not: section 5.1 is explicit that a placed order must never be
 * blindly re-sent.
 */
export interface RestExchangeClient {
  /** Exchange server time, used to correct local clock drift (section 4.2). */
  getServerTime(): Promise<ExchangeOutcome<number>>;

  /** Trading rules for a pair, for order validation and rounding (section 4.3). */
  getSymbolFilters(pair: Pair): Promise<ExchangeOutcome<SymbolFilters>>;

  /**
   * Every currently tradable pair on the exchange, as it names them.
   *
   * The registry-facing counterpart of `getSymbolFilters`: that one reads the
   * rules of a pair already known; this one answers "which pairs exist here at
   * all", so a pair can be offered/validated rather than free-typed. Only pairs
   * currently in `TRADING` status are returned -- a halted or delisted symbol is
   * not a tradable pair -- so the result is directly the set a create-bot form
   * may present. Unsigned public data on both exchanges; the caller is expected
   * to cache it (the set changes rarely) rather than call it per request.
   */
  listTradablePairs(): Promise<ExchangeOutcome<Pair[]>>;

  getCurrentPrice(pair: Pair): Promise<ExchangeOutcome<Price>>;

  placeOrder(order: OrderRequest): Promise<ExchangeOutcome<OrderResult>>;

  /**
   * Cancel an order and report its final state.
   *
   * Section 4.1 writes this as `Promise<void>`. It returns the cancelled order
   * instead, because section 7.2's halt behaviour cancels every open order for a
   * bot instance and some of those will be partially filled at that moment --
   * and the exact filled quantity at the instant of cancellation determines the
   * position the halted bot is actually left holding.
   *
   * The exchange already reports that in the cancellation response. Discarding
   * it to satisfy `void` would force a follow-up `getOrderStatus` per cancelled
   * order during a halt: slower when speed matters most, more rate-limit budget
   * at the worst moment, and racy besides, since a resting order can fill again
   * between the cancel and the follow-up read. The value returned here is the
   * exchange's own account of where the order finished, taken from the same
   * response that ended it.
   *
   * `createdAt` is absent on this record; see the note on `OrderStatus`.
   */
  cancelOrder(pair: Pair, clientOrderId: string): Promise<ExchangeOutcome<OrderStatus>>;

  /** Look up an order by the bot's own id -- the idempotency recovery path. */
  getOrderStatus(
    pair: Pair,
    clientOrderId: string,
  ): Promise<ExchangeOutcome<OrderStatus>>;

  getOpenOrders(pair: Pair): Promise<ExchangeOutcome<OrderStatus[]>>;

  getAccountBalances(): Promise<ExchangeOutcome<Balance[]>>;

  /**
   * Historical OHLCV candles for a pair, returned OLDEST-FIRST.
   *
   * Public, unsigned data on both exchanges. The price feed's gap-backfill on
   * reconnect (section 4.6, step 14) and section 13's backtest both read it, and
   * neither needs credentials. Each returned candle's `closed` flag is set from
   * whether its close time has passed at request time, so the current
   * in-progress candle (close time still in the future) comes back
   * `closed: false` and a backfill consumer should drop it.
   *
   * `since`, WHEN SUPPLIED, asks for candles whose close time is AFTER it, and
   * is BEST-EFFORT, bounded by the window the exchange's endpoint returns. This
   * asymmetry is real and stated rather than hidden: Binance's klines endpoint
   * takes a start time and can reach deep history, but Gemini's `/v2/candles`
   * returns only a fixed recent window with no range parameter, so the Gemini
   * implementation fetches that window and filters locally and CANNOT serve
   * candles older than it covers. For the feed's short reconnect gaps this is
   * always sufficient; deep-history backtest on Gemini is a section 13 open
   * question, not something this method promises.
   *
   * Note the money exception this method introduces: Gemini renders candle
   * OHLCV as JSON NUMBERS, not the decimal strings the rest of its API uses (the
   * step 14 probe confirmed this on the live feed, and the REST endpoint matches
   * it). The Gemini implementation therefore rounds each value explicitly to the
   * money scale rather than assuming a string is available. Binance renders
   * klines as strings, so it stays on the ordinary `fromDecimalString` path.
   */
  getCandles(
    pair: Pair,
    interval: CandleInterval,
    since?: Timestamp,
  ): Promise<ExchangeOutcome<Candle[]>>;
}

// ---------------------------------------------------------------------------
// An OPTIONAL venue capability: cancelling several orders in one request
// ---------------------------------------------------------------------------

/**
 * WHERE ONE ORDER FINISHED, within a batch cancellation.
 *
 * A discriminated union rather than an optional `order`, for the reason section
 * 5.6 makes `ExchangeOutcome` one: a caller must not be able to read a final
 * state that nobody observed. `resolved: false` is an ORDINARY outcome here, not
 * an error -- see `BatchCancelResult.cancelledCount`.
 */
export type BatchCancelEntry =
  | {
      readonly clientOrderId: string;
      readonly resolved: true;
      /** The order's own account of where it finished, from the follow-up read. */
      readonly order: OrderStatus;
    }
  | {
      readonly clientOrderId: string;
      readonly resolved: false;
      /** Why this id could not be resolved. Never a fabricated quantity. */
      readonly reason: string;
    };

/**
 * The result of cancelling several orders in one request.
 *
 * ⚠ `cancelledCount` IS AN AGGREGATE AND CANNOT BE ATTRIBUTED TO ORDERS. This is
 * the venue's shape, not a simplification: Kraken's `CancelOrderBatch` answers
 * `{"count": 2}` and nothing else -- no per-order status, no ids, no filled
 * quantities. (Its sibling `AddOrderBatch` DOES return a per-order array, and the
 * contrast is what makes the absence deliberate rather than an oversight in the
 * reading.) So a caller learns "the venue cancelled two of the ids I named" and
 * cannot learn WHICH two from this field.
 *
 * `entries` is therefore NOT the venue's per-order breakdown -- there is none. It
 * is what a single follow-up read observed, one entry per requested id, in the
 * order requested. An implementation that cannot see where an order finished
 * says so in `resolved: false` rather than inventing a zero fill, exactly as
 * `cancelOrder` refuses to.
 */
export interface BatchCancelResult {
  readonly pair: Pair;
  /** The ids the caller asked for, echoed so `entries` can be checked against it. */
  readonly requested: readonly string[];
  /** How many the venue said it cancelled. Aggregate; see above. */
  readonly cancelledCount: number;
  /** One per requested id, same order. */
  readonly entries: readonly BatchCancelEntry[];
}

/**
 * A venue that can cancel a NAMED SET of orders in one request.
 *
 * ── WHY THIS IS NOT A METHOD ON `RestExchangeClient` ──
 *
 * Because it is not a capability the other two venues have, and stubbing it on
 * them would be a lie with a signature. Checked against each venue's own current
 * reference rather than assumed:
 *
 *  - **Binance spot** has `DELETE /api/v3/order` (one order), `DELETE
 *    /api/v3/openOrders` ("Cancels all active orders on a symbol") and `DELETE
 *    /api/v3/orderList` (one OCO/OTO list, which this system never creates).
 *    There is no endpoint taking a list of order ids.
 *  - **Gemini** has `/v1/order/cancel` (one order), `cancel-all-session-orders`
 *    and `cancel-all-active-orders`. Again no list form.
 *
 * Both bulk forms they DO have are cancel-EVERYTHING, and that is not a weaker
 * version of this capability -- it is a different and dangerous one here.
 * `bot_instances` has no uniqueness constraint on (account_label, pair), so two
 * bots may run the same market on one account, and "cancel all open orders on
 * BTCUSD" during one bot's halt would cancel the other bot's ladder. Offering
 * that as this method's Binance implementation would put a foot-gun behind a
 * name that reads as safe.
 *
 * The alternative -- a REQUIRED method that Binance and Gemini implement by
 * looping `cancelOrder` -- is worse than either. It reads as one request and
 * costs N, so the gate would charge one call's budget for N calls' traffic, on
 * the risk-exit path, which is the exact class of failure decision log 90 PROBLEM
 * 2 is about. A capability a venue does not have should be ABSENT, so a caller
 * has to ask.
 *
 * So: an optional interface, a runtime guard, and a caller that keeps its
 * sequential path for every venue that does not answer the guard.
 */
export interface BatchCancellingClient {
  /**
   * The most ids one request may name, as the VENUE documents it.
   *
   * Published as data rather than left to the caller to know, so chunking a
   * longer list is the caller's arithmetic and not its guess. Kraken: 50.
   */
  readonly batchCancelMaxOrders: number;

  /**
   * Cancel the named orders on one pair, then report where each finished.
   *
   * All ids must be on `pair`: the implementation checks each returned order's
   * market against it, for the reason `cancelOrder` does.
   *
   * A failed outcome means the REQUEST failed, and says nothing about any
   * individual order -- which, on a venue with no per-order response, is the only
   * honest reading. A successful outcome may still carry unresolved entries.
   */
  cancelOrderBatch(
    pair: Pair,
    clientOrderIds: readonly string[],
  ): Promise<ExchangeOutcome<BatchCancelResult>>;
}

/**
 * Whether this client can cancel a named set of orders in one request.
 *
 * A runtime guard, because the capability is a property of the VENUE and the
 * call sites hold a `RestExchangeClient` that has already been through
 * `withRateLimit` and `withPriority` -- both of which are typed as the plain
 * interface. Checking the method's presence is what survives those seams.
 *
 * `RateLimitedExchange` defines `cancelOrderBatch` only when the client it wraps
 * does, so this answers for the VENUE underneath the gate rather than for the
 * gate itself.
 */
export function supportsBatchCancel(
  client: RestExchangeClient,
): client is RestExchangeClient & BatchCancellingClient {
  const candidate = client as Partial<BatchCancellingClient>;
  return (
    typeof candidate.cancelOrderBatch === "function" &&
    typeof candidate.batchCancelMaxOrders === "number" &&
    candidate.batchCancelMaxOrders >= 2
  );
}
