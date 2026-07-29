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
   */
  updatedAt: Timestamp;
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
 * Handle to a live price subscription. Section 4.6 keeps the underlying
 * connection inside a Durable Object using the WebSocket Hibernation API;
 * reconnection and gap backfill are that object's responsibility, at step 6.
 */
export interface WebSocketHandle {
  readonly pair: Pair;
  /** Close the subscription and stop delivering updates. */
  close(): void;
}

/**
 * The request/response half of the exchange interface: everything reachable
 * over REST, and the whole surface a strategy needs in order to act.
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
}

/**
 * The complete exchange interface: the REST surface plus the live price feed.
 *
 * Split from `RestExchangeClient` because the two halves are built at different
 * steps and, more importantly, live in different places. Section 4.6 puts the
 * WebSocket connection inside a Durable Object using the Hibernation API, so it
 * cannot be a method on a plain client object that a Worker constructs per
 * request -- the connection has to outlive the request that opened it.
 *
 * The split is what lets the Binance REST implementation at step 3 be complete
 * and honest rather than a full implementation with one method that throws.
 * Code needing only to read prices and place orders should depend on
 * `RestExchangeClient`; only step 6's Durable Object needs this.
 */
export interface ExchangeClient extends RestExchangeClient {
  subscribeToPriceFeed(
    pair: Pair,
    onUpdate: (candle: Candle) => void,
  ): WebSocketHandle;
}
