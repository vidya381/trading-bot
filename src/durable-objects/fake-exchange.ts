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
import { fromDecimalString, ZERO, type Money } from "../shared/money";

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
  /** Set to force `getSymbolFilters` to fail. Stays set until cleared. */
  filtersFailure: { kind: "transport" | "exchange_error"; message: string } | null = null;
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

  async getCurrentPrice(pair: Pair): Promise<ExchangeOutcome<Price>> {
    return { ok: true, value: { pair, price: ZERO, at: this.now }, at: this.now };
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
    const order = this.resting.get(clientOrderId);
    if (order === undefined) {
      return failure(`unknown order ${clientOrderId}`, "exchange_error", this.now);
    }
    return {
      ok: true,
      value: {
        clientOrderId,
        exchangeOrderId: order.exchangeOrderId,
        pair,
        side: order.request.side,
        price: order.request.price,
        quantity: order.request.quantity,
        filledQuantity: order.filledQuantity,
        cumulativeQuoteQuantity: ZERO,
        state: order.cancelled ? "cancelled" : "pending",
        createdAt: this.now,
        updatedAt: this.now,
      },
      at: this.now,
    };
  }

  async getOpenOrders(pair: Pair): Promise<ExchangeOutcome<OrderStatus[]>> {
    void pair;
    return { ok: true, value: [], at: this.now };
  }

  async getAccountBalances(): Promise<ExchangeOutcome<Balance[]>> {
    return { ok: true, value: [], at: this.now };
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
