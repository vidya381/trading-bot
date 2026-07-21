/**
 * The internal exchange interface (spec section 4.1).
 *
 * Type-only. There is no implementation here and no Binance-specific request
 * shape, signing, or endpoint. The Binance implementation arrives at build
 * step 3; a second exchange would be added later as another implementation of
 * this same interface, without touching strategy code.
 *
 * All strategy code and shared modules depend only on these types.
 */

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
 * A symbol's trading rules, cached and periodically refreshed (section 4.3).
 * Used to validate and round an order before it is constructed, and again
 * independently before it is sent.
 */
export interface SymbolFilters {
  pair: Pair;
  baseAsset: Asset;
  quoteAsset: Asset;
  /** Price increment. A price must be an exact multiple of this. */
  tickSize: Money;
  /** Quantity increment. A quantity must be an exact multiple of this. */
  stepSize: Money;
  minQuantity: Money;
  maxQuantity: Money;
  /** Minimum price x quantity. Below this the order must not be sent. */
  minNotional: Money;
  /** When these filters were fetched, so staleness can be judged. */
  fetchedAt: Timestamp;
}

/** A point-in-time price, carrying the time it was observed. */
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
  /** The exchange's own identifier for this execution, for deduplication. */
  fillId: string;
  price: Money;
  quantity: Money;
  /**
   * Fee amount in `feeAsset`, NOT in the quote currency. Section 5.5 is
   * explicit that fees must never be assumed to be paid in the quote currency.
   */
  feeAmount: Money;
  feeAsset: Asset;
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
  state: OrderState;
  fills: readonly Fill[];
  createdAt: Timestamp;
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
 * The exchange interface, exactly the surface named in section 4.1.
 *
 * Implementations are responsible for signing, clock-drift correction, and
 * translating exchange-specific payloads into the types above. Callers see none
 * of that.
 */
export interface ExchangeClient {
  /** Exchange server time, used to correct local clock drift (section 4.2). */
  getServerTime(): Promise<number>;

  /** Trading rules for a pair, for order validation and rounding (section 4.3). */
  getSymbolFilters(pair: Pair): Promise<SymbolFilters>;

  getCurrentPrice(pair: Pair): Promise<Price>;

  placeOrder(order: OrderRequest): Promise<OrderResult>;

  cancelOrder(pair: Pair, clientOrderId: string): Promise<void>;

  /** Look up an order by the bot's own id -- the idempotency recovery path. */
  getOrderStatus(pair: Pair, clientOrderId: string): Promise<OrderStatus>;

  getOpenOrders(pair: Pair): Promise<OrderStatus[]>;

  getAccountBalances(): Promise<Balance[]>;

  subscribeToPriceFeed(
    pair: Pair,
    onUpdate: (candle: Candle) => void,
  ): WebSocketHandle;
}
