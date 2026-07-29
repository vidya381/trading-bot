/**
 * The gate in front of the exchange (spec section 5.4), build step 8.
 *
 * Section 5.4: "All order-execution requests for bots on that account request
 * 'budget' from this object before calling Binance." This is the thing that
 * makes that true. It wraps any `RestExchangeClient` and asks the account's
 * `RateLimiter` Durable Object for budget before every single call, so a caller
 * cannot reach the exchange without having been granted the weight first.
 *
 * ---------------------------------------------------------------------------
 * WHY A DECORATOR RATHER THAN A CHECK INSIDE THE CLIENT
 * ---------------------------------------------------------------------------
 * Step 3's decision 6 put the reporting half inside `BinanceClient` and left
 * gating out of it, on the grounds that a per-request client object cannot see
 * the other bots on the account. That reasoning still holds; what changed is
 * that there is now an object which CAN see them.
 *
 * Gating here rather than inside the client keeps `BinanceClient` exactly as
 * section 4.1 describes -- it signs, sends, parses -- and means the gate applies
 * to any future exchange implementation, and to the `FakeExchange` the tests
 * drive, without either of them knowing it exists. The decisive practical
 * reason is that `BinanceClient` is constructed per request while the budget is
 * per account: a check inside it would have to reach out to the same Durable
 * Object anyway, just from a less obvious place.
 *
 * ---------------------------------------------------------------------------
 * HOW PRIORITY IS CHOSEN
 * ---------------------------------------------------------------------------
 * By WHICH VIEW THE CALL SITE HOLDS, not by which method it calls.
 *
 * `withPriority("risk-exit")` returns a second view sharing the same limiter
 * and the same inner client. A caller on the halt path holds the risk-exit
 * view; a caller placing a routine ladder order holds the routine one. So the
 * priority of a request is visible in the diff at the point the decision is
 * actually made.
 *
 * The rejected alternative was deriving priority from the method -- "every
 * cancellation is risk-exit". It reads well and it is wrong in the direction
 * that matters: it makes the tag a property of the verb rather than of the
 * intent, so a strategy that cancels as part of ordinary rebalancing would draw
 * on the reserve that exists for stop-losses. The other alternative, an options
 * argument on all eight interface methods, would rewrite section 4.1's surface
 * to carry a concern none of its implementations share.
 *
 * ---------------------------------------------------------------------------
 * WAITING
 * ---------------------------------------------------------------------------
 * A refusal comes with a ticket and a delay. This sleeps and re-presents the
 * ticket, which is what keeps its place in the queue. `sleep` is injected, so
 * the whole loop -- including the throttling of a cancellation storm -- runs at
 * whatever speed a test wants.
 *
 * Waiting is bounded. Past the bound the call returns a `rate_limited` failure,
 * which section 5.6's outcome type carries and which means, precisely, that
 * NOTHING WAS SENT. That is a third thing from "sent, outcome unknown" and
 * "sent, refused", and it is why it needed its own kind rather than borrowing
 * one of theirs.
 */

import { rateLimited, type ExchangeOutcome } from "../shared/downtime";
import type {
  Balance,
  OrderRequest,
  OrderResult,
  OrderStatus,
  Pair,
  Price,
  RestExchangeClient,
  SymbolFilters,
  Timestamp,
} from "../shared/exchange-client";
import type { RequestPriority } from "../shared/rate-limiter";
import type { AcquireRequest, AcquireResult } from "../durable-objects/rate-limiter";
import { ENDPOINT_WEIGHTS } from "./binance/client";

/**
 * The part of the `RateLimiter` Durable Object this needs.
 *
 * Structural, so a `DurableObjectStub<RateLimiter>` satisfies it directly and a
 * test can pass a recording double without a namespace.
 */
export interface RateLimiterPort {
  acquire(request: AcquireRequest): Promise<AcquireResult>;
  release(ticketId: string): Promise<void>;
}

/**
 * Documented weight per interface method.
 *
 * Keyed by method name rather than by endpoint so the mapping is checked by the
 * compiler against `RestExchangeClient` itself: adding a method to section
 * 4.1's interface will not compile until its weight is declared here, which is
 * the only way a new call could otherwise slip past the budget unmeasured.
 *
 * The numbers come from `ENDPOINT_WEIGHTS`, which step 3 exported for exactly
 * this purpose. They are Binance's, which is why this file sits under
 * `/src/exchange` and takes them as an option -- a second exchange brings its
 * own table.
 */
export type MethodWeights = Record<keyof RestExchangeClient, number>;

export const BINANCE_METHOD_WEIGHTS: MethodWeights = {
  getServerTime: ENDPOINT_WEIGHTS.time,
  getSymbolFilters: ENDPOINT_WEIGHTS.exchangeInfo,
  // The full-catalogue `exchangeInfo` (no symbol filter) carries the same
  // documented weight as the single-symbol form.
  listTradablePairs: ENDPOINT_WEIGHTS.exchangeInfo,
  getCurrentPrice: ENDPOINT_WEIGHTS.tickerPrice,
  placeOrder: ENDPOINT_WEIGHTS.placeOrder,
  cancelOrder: ENDPOINT_WEIGHTS.cancelOrder,
  getOrderStatus: ENDPOINT_WEIGHTS.orderStatus,
  getOpenOrders: ENDPOINT_WEIGHTS.openOrders,
  getAccountBalances: ENDPOINT_WEIGHTS.account,
};

/**
 * The longest a single call will wait for budget before giving up.
 *
 * One window: everything in a rolling window has aged out after one, so a
 * request that still cannot be served after that long is not waiting on this
 * system's own traffic -- it is waiting on the exchange's own count, which
 * means something else is spending the account's budget. Continuing to hold the
 * caller at that point would block a Durable Object on a condition that is not
 * improving.
 */
export const DEFAULT_MAX_WAIT_MS = 60_000;

export interface RateLimitedExchangeOptions {
  readonly priority?: RequestPriority;
  readonly weights?: MethodWeights;
  readonly maxWaitMs?: number;
  /** Injected so tests need no real delay. */
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => Timestamp;
  /** Prefixed to the diagnostic label on every request, e.g. the bot's id. */
  readonly label?: string;
}

interface ResolvedOptions {
  readonly priority: RequestPriority;
  readonly weights: MethodWeights;
  readonly maxWaitMs: number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly now: () => Timestamp;
  readonly label: string;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export class RateLimitedExchange implements RestExchangeClient {
  readonly #inner: RestExchangeClient;
  readonly #limiter: RateLimiterPort;
  readonly #options: ResolvedOptions;

  constructor(
    inner: RestExchangeClient,
    limiter: RateLimiterPort,
    options: RateLimitedExchangeOptions = {},
  ) {
    this.#inner = inner;
    this.#limiter = limiter;
    this.#options = {
      priority: options.priority ?? "routine",
      weights: options.weights ?? BINANCE_METHOD_WEIGHTS,
      maxWaitMs: options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS,
      sleep: options.sleep ?? defaultSleep,
      now: options.now ?? (() => Date.now()),
      label: options.label ?? "",
    };
  }

  /**
   * The same client and the same budget, at a different priority.
   *
   * Returns `RestExchangeClient` rather than `RateLimitedExchange`: a call site
   * that has chosen its priority should not be able to choose again, and a
   * `riskExchange.withPriority("routine")` sitting in a halt path would be very
   * easy to miss in review.
   */
  withPriority(priority: RequestPriority): RestExchangeClient {
    return new RateLimitedExchange(this.#inner, this.#limiter, {
      ...this.#options,
      priority,
    });
  }

  get priority(): RequestPriority {
    return this.#options.priority;
  }

  // -------------------------------------------------------------------------
  // Section 4.1 surface, each one gated
  // -------------------------------------------------------------------------

  async getServerTime(): Promise<ExchangeOutcome<number>> {
    return this.#gate("getServerTime", "", () => this.#inner.getServerTime());
  }

  async getSymbolFilters(pair: Pair): Promise<ExchangeOutcome<SymbolFilters>> {
    return this.#gate("getSymbolFilters", pair, () => this.#inner.getSymbolFilters(pair));
  }

  async listTradablePairs(): Promise<ExchangeOutcome<Pair[]>> {
    return this.#gate("listTradablePairs", "", () => this.#inner.listTradablePairs());
  }

  async getCurrentPrice(pair: Pair): Promise<ExchangeOutcome<Price>> {
    return this.#gate("getCurrentPrice", pair, () => this.#inner.getCurrentPrice(pair));
  }

  async placeOrder(order: OrderRequest): Promise<ExchangeOutcome<OrderResult>> {
    return this.#gate("placeOrder", order.clientOrderId, () => this.#inner.placeOrder(order));
  }

  async cancelOrder(pair: Pair, clientOrderId: string): Promise<ExchangeOutcome<OrderStatus>> {
    return this.#gate("cancelOrder", clientOrderId, () =>
      this.#inner.cancelOrder(pair, clientOrderId),
    );
  }

  async getOrderStatus(pair: Pair, clientOrderId: string): Promise<ExchangeOutcome<OrderStatus>> {
    return this.#gate("getOrderStatus", clientOrderId, () =>
      this.#inner.getOrderStatus(pair, clientOrderId),
    );
  }

  async getOpenOrders(pair: Pair): Promise<ExchangeOutcome<OrderStatus[]>> {
    return this.#gate("getOpenOrders", pair, () => this.#inner.getOpenOrders(pair));
  }

  async getAccountBalances(): Promise<ExchangeOutcome<Balance[]>> {
    return this.#gate("getAccountBalances", "", () => this.#inner.getAccountBalances());
  }

  // -------------------------------------------------------------------------

  /**
   * Ask for budget, wait if refused, and only then make the call.
   *
   * The inner call happens exactly once and only after a grant. There is no
   * path through this function that reaches the exchange without one, which is
   * the property section 5.4 is actually asking for.
   */
  async #gate<T>(
    method: keyof RestExchangeClient,
    detail: string,
    call: () => Promise<ExchangeOutcome<T>>,
  ): Promise<ExchangeOutcome<T>> {
    const { priority, weights, maxWaitMs, sleep, now, label } = this.#options;
    const weight = weights[method];
    const describe = `${label === "" ? "" : `${label} `}${method}${detail === "" ? "" : ` ${detail}`}`;

    let ticketId: string | undefined;
    let waited = 0;

    for (;;) {
      const result = await this.#limiter.acquire({
        weight,
        priority,
        ...(ticketId !== undefined ? { ticketId } : {}),
        label: describe,
      });

      if (result.granted) return await call();

      if (result.ticketId === null) {
        // `weight_exceeds_limit`: this request is bigger than its priority's
        // entire share and no amount of waiting changes that. Reported as
        // non-retryable so a caller wrapping this in `withRetry` stops
        // immediately rather than looping on a condition that cannot improve.
        return rateLimited<T>(
          `${describe} needs ${weight} weight, which exceeds the whole ${priority} ` +
            `budget for this account. It was not sent, and retrying will not help.`,
          now(),
          { retryable: false },
        );
      }

      ticketId = result.ticketId;

      if (waited + result.retryAfterMs > maxWaitMs) {
        // Stop holding a queue place for a request that is being abandoned;
        // otherwise the claim blocks everything behind it until its TTL.
        await this.#limiter.release(ticketId);
        return rateLimited<T>(
          `${describe} could not obtain ${weight} weight within ${maxWaitMs}ms ` +
            `(${result.reason}, ${result.usedWeight} used, queue position ` +
            `${result.queuePosition}). It was NOT sent.`,
          now(),
          { retryAfterMs: result.retryAfterMs, retryable: true },
        );
      }

      await sleep(result.retryAfterMs);
      waited += result.retryAfterMs;
    }
  }
}

/**
 * Wrap a client so every call goes through one account's budget.
 *
 * The one obvious way to compose these, so that a future step wiring live
 * credentials has somewhere to put the limiter rather than deciding again.
 */
export function withRateLimit(
  inner: RestExchangeClient,
  limiter: RateLimiterPort,
  options: RateLimitedExchangeOptions = {},
): RateLimitedExchange {
  return new RateLimitedExchange(inner, limiter, options);
}
