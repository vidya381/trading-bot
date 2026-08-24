/**
 * A `RestExchangeClient` that answers from memory.
 *
 * Test-only, and not exported from `index.ts`. Section 14 is explicit that the
 * automated suite mocks outbound exchange calls and that Binance's real testnet
 * is a separate, manual verification step -- nothing here opens a socket.
 *
 * It implements the interface rather than being a loose object of `vi.fn()`s on
 * purpose: when step 3.1 changed `cancelOrder` from `void` to
 * `ExchangeOutcome<OrderStatus>`, a structural mock would have kept compiling
 * and kept returning the old shape.
 */

import type { ExchangeOutcome } from "../shared/downtime";
import type {
  Balance,
  Candle,
  CandleInterval,
  Fill,
  OrderRequest,
  OrderResult,
  OrderStatus,
  Pair,
  Price,
  RestExchangeClient,
  SymbolFilters,
  Timestamp,
} from "../shared/exchange-client";
import { fromDecimalString, ONE, ZERO, type Money } from "../shared/money";

export const TEST_PAIR = "BTCUSDT";

export function testFilters(overrides: Partial<SymbolFilters> = {}): SymbolFilters {
  return {
    pair: TEST_PAIR,
    baseAsset: "BTC",
    quoteAsset: "USDT",
    status: "TRADING",
    tickSize: fromDecimalString("0.01"),
    minPrice: fromDecimalString("0.01"),
    maxPrice: fromDecimalString("1000000"),
    stepSize: fromDecimalString("0.00001"),
    minQuantity: fromDecimalString("0.00001"),
    maxQuantity: fromDecimalString("9000"),
    minNotional: fromDecimalString("10"),
    maxNotional: fromDecimalString("9000000"),
    fetchedAt: 1_760_000_000_000,
    ...overrides,
  };
}

function failure<T>(message: string, kind: "transport" | "exchange_error", at: Timestamp): ExchangeOutcome<T> {
  return { ok: false, kind, message, retryable: kind === "transport", at };
}

/** A resting order, as this fake exchange sees it. */
interface RestingOrder {
  readonly request: OrderRequest;
  readonly exchangeOrderId: string;
  filledQuantity: Money;
  cancelled: boolean;
}

export class FakeExchange implements RestExchangeClient {
  filters: SymbolFilters = testFilters();
  now: Timestamp = 1_760_000_000_000;

  /** Every order this fake was asked to place, in order. */
  readonly placed: OrderRequest[] = [];
  /** Every clientOrderId this fake was asked to cancel, in order. */
  readonly cancelled: string[] = [];

  readonly resting = new Map<string, RestingOrder>();

  /** Set to force the next `placeOrder` to fail, then cleared. */
  nextPlaceFailure: { kind: "transport" | "exchange_error"; message: string } | null = null;
  /** Set to force the next `cancelOrder` to fail, then cleared. */
  nextCancelFailure: { kind: "transport" | "exchange_error"; message: string } | null = null;
  /** Set to force EVERY `cancelOrder` to fail. Stays set until cleared. */
  cancelFailure: { kind: "transport" | "exchange_error"; message: string } | null = null;
  /** Set to force `getSymbolFilters` to fail. Stays set until cleared. */
  filtersFailure: { kind: "transport" | "exchange_error"; message: string } | null = null;
  /** Set to force `getOpenOrders` to fail. Stays set until cleared. */
  openOrdersFailure: { kind: "transport" | "exchange_error"; message: string } | null = null;
  /** Set to force `getAccountBalances` to fail. Stays set until cleared. */
  balancesFailure: { kind: "transport" | "exchange_error"; message: string } | null = null;
  /** Set to force `getOrderStatus` to fail. Stays set until cleared. */
  orderStatusFailure: { kind: "transport" | "exchange_error"; message: string } | null = null;
  /**
   * clientOrderIds whose `getOrderStatus` fails while the rest succeed.
   *
   * The MIXED pass, which the all-or-nothing flag above cannot express and which
   * is the case several real distinctions turn on: step 20's backoff (a pass
   * that reads some orders and fails on others still writes state, so it must
   * still back off) and step 22's audit gate (`skipped` holds both an outage and
   * a refusal; only the refusal justifies a row).
   */
  readonly orderStatusFailureFor = new Set<string>();
  /**
   * Per-fill detail `getOrderStatus` reports for an order, keyed by
   * clientOrderId -- the `trades` array a real venue returns for
   * `include_trades`. An ABSENT entry means the venue reported no detail at all,
   * which `applyMissedFills` treats differently from an empty one.
   */
  readonly fillsByOrder = new Map<string, Fill[]>();
  /**
   * Whether this venue reports a last-update time on the ORDER-READING
   * endpoints -- `true` models Binance, `false` models Gemini.
   *
   * WHY THIS HAD TO EXIST BEFORE THE GEMINI FIX COULD BE TESTED. This fake set
   * `updatedAt` unconditionally on every response, so it could model only a venue
   * that reports one. The whole Gemini defect -- a payload carrying no
   * last-update time, and reconciliation deciding what to do about that -- was
   * therefore INEXPRESSIBLE in the suite: every test that thought it was
   * exercising the terminated-order tolerance was exercising the Binance path.
   *
   * DEFAULTS TO `true`, so every existing test keeps the venue it was written
   * against and nothing has to be touched to keep passing.
   *
   * IT DELIBERATELY DOES NOT REACH `cancelOrder`, and that asymmetry is the fake
   * being faithful rather than being lazy. Gemini has no last-update time in
   * `/v1/order/status` (`parseOrderStatus` omits it) but DOES have one on a
   * cancellation, because `parseCancelledOrder` stamps receipt time -- the
   * instant this system observed the cancel it issued. A switch that also
   * silenced `cancelOrder` would model a venue that does not exist and would let
   * `#recordCancellation`'s fallback be "covered" by a case it can never see.
   */
  reportsUpdateTime = true;
  /**
   * What `getCurrentPrice` returns, for the human-triggered liquidation path
   * (step 10.3), which fetches a fresh price rather than being driven by a price
   * event. Non-zero by default so a marketable limit is constructible; a test
   * that wants an unreachable exchange sets `currentPriceFailure`.
   */
  currentPrice: Money = 100n * ONE;
  /** Set to force `getCurrentPrice` to fail. Stays set until cleared. */
  currentPriceFailure: { kind: "transport" | "exchange_error"; message: string } | null = null;

  /**
   * What the account holds, for step 7's reconciliation.
   *
   * Deliberately NOT derived from the resting orders: the whole point of
   * section 9's balance check is to catch a change this system cannot explain
   * from its own records, so a fake that computed the balance from those
   * records could never express one.
   */
  balances: Balance[] = [];
  /**
   * Extra quantity the exchange reports as filled at CANCELLATION time, beyond
   * what the bot knew about -- the race step 3.1's open question 1 describes.
   */
  fillOnCancel: Money = ZERO;

  #nextExchangeOrderId = 1;

  async getServerTime(): Promise<ExchangeOutcome<number>> {
    return { ok: true, value: this.now, at: this.now };
  }

  async getSymbolFilters(pair: Pair): Promise<ExchangeOutcome<SymbolFilters>> {
    if (this.filtersFailure !== null) {
      return failure(this.filtersFailure.message, this.filtersFailure.kind, this.now);
    }
    return { ok: true, value: { ...this.filters, pair, fetchedAt: this.now }, at: this.now };
  }

  /** The pairs this fake reports as tradable. Defaults to its one test pair. */
  tradablePairs: Pair[] = [TEST_PAIR];
  /** Set to force `listTradablePairs` to fail. Stays set until cleared. */
  tradablePairsFailure: { kind: "transport" | "exchange_error"; message: string } | null = null;

  async listTradablePairs(): Promise<ExchangeOutcome<Pair[]>> {
    if (this.tradablePairsFailure !== null) {
      return failure(this.tradablePairsFailure.message, this.tradablePairsFailure.kind, this.now);
    }
    return { ok: true, value: [...this.tradablePairs], at: this.now };
  }

  async getCurrentPrice(pair: Pair): Promise<ExchangeOutcome<Price>> {
    if (this.currentPriceFailure !== null) {
      return failure(this.currentPriceFailure.message, this.currentPriceFailure.kind, this.now);
    }
    return { ok: true, value: { pair, price: this.currentPrice, at: this.now }, at: this.now };
  }

  /** Candles this fake returns, oldest-first. A test sets these directly. */
  candles: Candle[] = [];
  /** Set to force `getCandles` to fail. Stays set until cleared. */
  candlesFailure: { kind: "transport" | "exchange_error"; message: string } | null = null;

  async getCandles(
    _pair: Pair,
    _interval: CandleInterval,
    since?: Timestamp,
  ): Promise<ExchangeOutcome<Candle[]>> {
    if (this.candlesFailure !== null) {
      return failure(this.candlesFailure.message, this.candlesFailure.kind, this.now);
    }
    const value =
      since === undefined ? this.candles : this.candles.filter((c) => c.closeTime > since);
    return { ok: true, value: [...value], at: this.now };
  }

  async placeOrder(order: OrderRequest): Promise<ExchangeOutcome<OrderResult>> {
    const forced = this.nextPlaceFailure;
    if (forced !== null) {
      this.nextPlaceFailure = null;
      return failure(forced.message, forced.kind, this.now);
    }

    this.placed.push(order);
    const exchangeOrderId = `E${this.#nextExchangeOrderId}`;
    this.#nextExchangeOrderId += 1;
    this.resting.set(order.clientOrderId, {
      request: order,
      exchangeOrderId,
      filledQuantity: ZERO,
      cancelled: false,
    });

    return {
      ok: true,
      value: {
        clientOrderId: order.clientOrderId,
        exchangeOrderId,
        pair: order.pair,
        state: "pending",
        fills: [],
        acceptedAt: this.now,
      },
      at: this.now,
    };
  }

  async cancelOrder(pair: Pair, clientOrderId: string): Promise<ExchangeOutcome<OrderStatus>> {
    // Persistent form, for a halt that cancels a whole ladder and must see EVERY
    // cancellation fail -- the state the 2026-07-31 incident actually left behind
    // (all five cancellations failed on one parse bug). `nextCancelFailure` is
    // one-shot and cannot express that.
    if (this.cancelFailure !== null) {
      return failure(this.cancelFailure.message, this.cancelFailure.kind, this.now);
    }
    const forced = this.nextCancelFailure;
    if (forced !== null) {
      this.nextCancelFailure = null;
      return failure(forced.message, forced.kind, this.now);
    }

    this.cancelled.push(clientOrderId);
    const order = this.resting.get(clientOrderId);
    if (order === undefined) {
      return failure(`unknown order ${clientOrderId}`, "exchange_error", this.now);
    }
    order.cancelled = true;
    const filledQuantity = order.filledQuantity + this.fillOnCancel;

    return {
      ok: true,
      value: {
        clientOrderId,
        exchangeOrderId: order.exchangeOrderId,
        pair,
        side: order.request.side,
        price: order.request.price,
        quantity: order.request.quantity,
        filledQuantity,
        cumulativeQuoteQuantity: ZERO,
        state: "cancelled",
        // No `createdAt`, and no `fills` array: a cancellation response carries
        // neither (step 3.1). The fake is faithful about that, because the
        // halt path's handling of it is exactly what needs testing.
        updatedAt: this.now,
      },
      at: this.now,
    };
  }

  async getOrderStatus(pair: Pair, clientOrderId: string): Promise<ExchangeOutcome<OrderStatus>> {
    if (this.orderStatusFailure !== null) {
      return failure(this.orderStatusFailure.message, this.orderStatusFailure.kind, this.now);
    }
    if (this.orderStatusFailureFor.has(clientOrderId)) {
      return failure(`${clientOrderId} is unreadable`, "transport", this.now);
    }
    const order = this.resting.get(clientOrderId);
    if (order === undefined) {
      return failure(`unknown order ${clientOrderId}`, "exchange_error", this.now);
    }
    // Executions the exchange reports for this order, when a test has said what
    // they are. `undefined` means the venue reported no per-fill detail at all,
    // which is deliberately NOT the same as "no executions" -- `applyMissedFills`
    // distinguishes the two.
    const fills = this.fillsByOrder.get(clientOrderId);
    const filled = fills?.reduce((sum, fill) => sum + fill.quantity, ZERO) ?? order.filledQuantity;
    return {
      ok: true,
      value: {
        clientOrderId,
        exchangeOrderId: order.exchangeOrderId,
        pair,
        side: order.request.side,
        price: order.request.price,
        quantity: order.request.quantity,
        filledQuantity: filled,
        cumulativeQuoteQuantity: ZERO,
        state: order.cancelled
          ? "cancelled"
          : filled >= order.request.quantity
            ? "filled"
            : filled > ZERO
              ? "partially_filled"
              : "pending",
        createdAt: this.now,
        ...(this.reportsUpdateTime ? { updatedAt: this.now } : {}),
        ...(fills !== undefined ? { fills } : {}),
      },
      at: this.now,
    };
  }

  /**
   * Every resting order on the pair that is neither cancelled nor fully
   * filled -- derived from `resting` rather than from a separate list, so a
   * test cannot set up an exchange whose open orders contradict its own order
   * book. A test wanting an order this system never placed inserts it into
   * `resting` directly, which is exactly what step 7's severe tier looks for.
   */
  async getOpenOrders(pair: Pair): Promise<ExchangeOutcome<OrderStatus[]>> {
    if (this.openOrdersFailure !== null) {
      return failure(this.openOrdersFailure.message, this.openOrdersFailure.kind, this.now);
    }
    const open: OrderStatus[] = [];
    for (const [clientOrderId, order] of this.resting) {
      if (order.cancelled) continue;
      if (order.request.pair !== pair) continue;
      if (order.filledQuantity >= order.request.quantity) continue;
      open.push({
        clientOrderId,
        exchangeOrderId: order.exchangeOrderId,
        pair,
        side: order.request.side,
        price: order.request.price,
        quantity: order.request.quantity,
        filledQuantity: order.filledQuantity,
        cumulativeQuoteQuantity: ZERO,
        state: order.filledQuantity > ZERO ? "partially_filled" : "pending",
        // No `fills` array: the open-orders endpoint does not return one
        // (step 3). The fake stays faithful about that.
        createdAt: this.now,
        // Same venue, same endpoint family: Gemini's `/v1/orders` is parsed by
        // `parseOrderStatusList`, which maps `parseOrderStatus` over the array,
        // so a venue with no last-update time has none here either.
        ...(this.reportsUpdateTime ? { updatedAt: this.now } : {}),
      });
    }
    return { ok: true, value: open, at: this.now };
  }

  async getAccountBalances(): Promise<ExchangeOutcome<Balance[]>> {
    if (this.balancesFailure !== null) {
      return failure(this.balancesFailure.message, this.balancesFailure.kind, this.now);
    }
    return { ok: true, value: [...this.balances], at: this.now };
  }

  /** Put an order on the book that this system never placed. */
  injectForeignOrder(request: OrderRequest): void {
    this.resting.set(request.clientOrderId, {
      request,
      exchangeOrderId: `FOREIGN-${request.clientOrderId}`,
      filledQuantity: ZERO,
      cancelled: false,
    });
  }

  /** Build a fill against a resting order, as the exchange would report it. */
  fillFor(
    clientOrderId: string,
    overrides: Partial<Fill> & { quantity?: Money } = {},
  ): Fill {
    const order = this.resting.get(clientOrderId);
    if (order === undefined) throw new Error(`no resting order ${clientOrderId}`);
    const quantity = overrides.quantity ?? order.request.quantity;
    order.filledQuantity += quantity;
    return {
      fillId: `T${clientOrderId}-${order.filledQuantity}`,
      price: order.request.price,
      quantity,
      feeAmount: ZERO,
      feeAsset: "USDT",
      executedAt: this.now,
      ...overrides,
    };
  }
}
