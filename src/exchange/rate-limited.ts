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
  BatchCancellingClient,
  BatchCancelResult,
  Candle,
  CandleInterval,
  OrderRequest,
  OrderResult,
  OrderStatus,
  Pair,
  Price,
  RestExchangeClient,
  SymbolFilters,
  Timestamp,
} from "../shared/exchange-client";
import { supportsBatchCancel } from "../shared/exchange-client";
import { RateLimiterError, type RequestPriority } from "../shared/rate-limiter";
import type { AcquireCost, AcquireRequest, AcquireResult } from "../durable-objects/rate-limiter";
import type { ExchangeId } from "../db/schema";
import { ENDPOINT_WEIGHTS } from "./binance/client";
import { GEMINI_REQUEST_COSTS, type GeminiRequestCost } from "./gemini/client";
import {
  KRAKEN_ADD_ORDER_COST,
  KRAKEN_REST_COUNTER_COSTS,
  krakenBatchCancelCost,
  krakenCancelCost,
} from "./kraken/rate-limits";

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
 * this purpose. They are Binance's -- which is why there is one table PER VENUE
 * below and why the gate is told which venue it is in front of rather than
 * defaulting to either.
 */
export type MethodWeights = Record<keyof RestExchangeClient, number>;

export const BINANCE_METHOD_WEIGHTS: MethodWeights = {
  getServerTime: ENDPOINT_WEIGHTS.time,
  getSymbolFilters: ENDPOINT_WEIGHTS.exchangeInfo,
  // The full-catalogue `exchangeInfo` (no symbol filter) carries the same
  // documented weight as the single-symbol form.
  listTradablePairs: ENDPOINT_WEIGHTS.exchangeInfo,
  getCurrentPrice: ENDPOINT_WEIGHTS.tickerPrice,
  getCandles: ENDPOINT_WEIGHTS.klines,
  placeOrder: ENDPOINT_WEIGHTS.placeOrder,
  cancelOrder: ENDPOINT_WEIGHTS.cancelOrder,
  getOrderStatus: ENDPOINT_WEIGHTS.orderStatus,
  getOpenOrders: ENDPOINT_WEIGHTS.openOrders,
  getAccountBalances: ENDPOINT_WEIGHTS.account,
};

/**
 * How many budget units one Gemini request costs, per counter.
 *
 * ---------------------------------------------------------------------------
 * WHY GEMINI'S TABLE IS A CONVERSION AND BINANCE'S IS A COPY
 * ---------------------------------------------------------------------------
 * Binance publishes a weight per endpoint and a weight ceiling per window, so
 * `BINANCE_METHOD_WEIGHTS` is a transcription. Gemini publishes neither: it
 * counts REQUESTS against two independent per-minute counters (120 public, 600
 * private -- see `GEMINI_RATE_LIMITS`). The `RateLimiter` Durable Object spends
 * ONE budget denominated in weight, so a Gemini request has to be priced in
 * that budget's units before the gate can charge for it.
 *
 * The price is chosen so that each of Gemini's two counters is respected on its
 * own, against the budget's own ceiling (`DEFAULT_WEIGHT_LIMIT`, 1200 per 60s):
 *
 *     private: 1200 / 600 = 2 units  -> at most 600 private requests a minute
 *     public:  1200 / 120 = 10 units -> at most 120 public requests a minute
 *
 * So a run made entirely of private calls stops at Gemini's private limit, and
 * a run made entirely of public calls stops at its public limit. A MIXED run
 * spends one shared pot, which is stricter than Gemini's two separate ones --
 * deliberately the conservative direction, since the failure this replaces was
 * a budget that had no relationship to Gemini at all.
 *
 * ⚠ WHAT THIS DOES NOT DO, stated rather than implied: it does not give Gemini
 * its own limit or its own second counter. `DEFAULT_WEIGHT_LIMIT` and the
 * single-budget shape are still Binance's, and modelling a venue whose limits
 * are structurally different is the dedicated rate-limiter work decision-log 90
 * separates out (the same work Kraken's decaying, per-pair counters need). This
 * is the seam correction: the gate now knows its venue and charges that venue's
 * real costs. `rate-limited.test.ts` pins the arithmetic above against the DO's
 * actual constant, so a change to either side fails rather than silently
 * re-pricing every Gemini call.
 */
const GEMINI_UNITS_PER_REQUEST: Readonly<Record<GeminiRequestCost["group"], number>> = {
  public: 10,
  private: 2,
  none: 0,
};

/**
 * The smallest weight the budget will accept.
 *
 * `WeightBudget.check` throws on a non-positive weight, so a method that sends
 * no request at all (Gemini's `getServerTime`) cannot be charged its true cost
 * of zero. One unit is the honest minimum: it over-charges a call that reaches
 * no network by half of one private request, which is cheaper than every
 * alternative and does not require the budget to grow a zero case.
 */
const MINIMUM_WEIGHT = 1;

export const GEMINI_METHOD_WEIGHTS: MethodWeights = Object.fromEntries(
  Object.entries(GEMINI_REQUEST_COSTS).map(([method, cost]) => [
    method,
    Math.max(MINIMUM_WEIGHT, cost.requests * GEMINI_UNITS_PER_REQUEST[cost.group]),
  ]),
) as MethodWeights;

/**
 * What the gate knows about a call when it has to price it.
 *
 * ---------------------------------------------------------------------------
 * WHY A COST IS NOW A FUNCTION AND NOT A NUMBER
 * ---------------------------------------------------------------------------
 * Decision-log 90 PROBLEM 2 (c). `MethodWeights` resolves a constant from the
 * method NAME, before the call is made. That is exactly right for Binance, whose
 * published weight is a property of the endpoint, and it cannot express Kraken's
 * cancel at all: Kraken prices a cancel by how long the order has been resting,
 * from +8 under five seconds down to nothing at all past five minutes. The same
 * method, the same arguments, eight times the cost.
 *
 * So the table holds functions of this context instead. The compile-time
 * property entry 90 asked to preserve is preserved -- it is still a `Record` over
 * `keyof RestExchangeClient`, so a new interface method still fails to compile
 * until its cost is declared -- and it is now general enough to say what Kraken
 * charges.
 */
export interface CostContext {
  /** The market the call concerns; `null` for account-wide calls. */
  readonly pair: Pair | null;
  /**
   * How long the order has been resting, in milliseconds, or `null` if unknown.
   *
   * Only ever populated for `cancelOrder`. `null` is charged the most expensive
   * rung -- see `krakenCancelCost` -- so a venue that prices by age can never be
   * made cheaper by failing to look the age up.
   */
  readonly orderAgeMs: number | null;
}

/** What one method costs, given what is known about the call. */
export type MethodCost = (context: CostContext) => AcquireCost;

/**
 * Documented cost per interface method, per venue.
 *
 * Keyed by method name rather than by endpoint so the mapping is checked by the
 * compiler against `RestExchangeClient` itself: adding a method to section 4.1's
 * interface will not compile until its cost is declared here, which is the only
 * way a new call could otherwise slip past the budget unmeasured.
 */
export type MethodCosts = Record<keyof RestExchangeClient, MethodCost>;

/**
 * A venue whose whole cost is a constant on the account-wide counter.
 *
 * Binance and Gemini both are. Their numbers are unchanged and still come from
 * the tables above -- this only re-expresses them in the shape the gate now
 * speaks, so that adding Kraken did not re-price a single existing call.
 */
function accountOnly(weights: MethodWeights): MethodCosts {
  // Built by walking the SOURCE table's own keys, so this stays total by
  // construction: a method missing from `weights` would already have failed to
  // compile there, and cannot go missing here without going missing there first.
  const costs = {} as Record<keyof RestExchangeClient, MethodCost>;
  for (const method of Object.keys(weights) as (keyof RestExchangeClient)[]) {
    const weight = weights[method];
    costs[method] = () => ({ rest: weight });
  }
  return costs;
}

export const BINANCE_METHOD_COSTS: MethodCosts = accountOnly(BINANCE_METHOD_WEIGHTS);
export const GEMINI_METHOD_COSTS: MethodCosts = accountOnly(GEMINI_METHOD_WEIGHTS);

/**
 * The pair a trading call charges, or a loud failure.
 *
 * A `null` pair on `placeOrder` or `cancelOrder` cannot happen -- both take one
 * and the gate passes it -- so this is defence against a future edit that stops
 * passing it, not a runtime condition. Charging the account counter instead and
 * carrying on is the outcome worth preventing: it would leave order traffic
 * spending a budget the matching engine does not use, which is the failure entry
 * 90 PROBLEM 2 (b) is about.
 */
function tradingPair(context: CostContext, method: string): Pair {
  if (context.pair === null) {
    throw new RateLimiterError(
      `${method} on Kraken charges a per-pair matching-engine counter, but the ` +
        `gate was given no pair to charge it against.`,
    );
  }
  return context.pair;
}

/**
 * Kraken's cost model. Both budgets, and the only age-dependent entry.
 *
 * The REST numbers come from `KRAKEN_REST_COUNTER_COSTS`, whose docblock records
 * the contradiction between Kraken's two published sources and why the expensive
 * reading was taken. The endpoint each method actually calls is what decides
 * which of those numbers applies, so the mapping is spelled out per method rather
 * than assumed from the method's name.
 */
export const KRAKEN_METHOD_COSTS: MethodCosts = {
  /** `GET /0/public/Time`. */
  getServerTime: () => ({ rest: KRAKEN_REST_COUNTER_COSTS.publicRequest }),
  /** `AssetPairs` + `Assets`, cached by the client; charged as one public call. */
  getSymbolFilters: () => ({ rest: KRAKEN_REST_COUNTER_COSTS.publicRequest }),
  listTradablePairs: () => ({ rest: KRAKEN_REST_COUNTER_COSTS.publicRequest }),
  /** `GET /0/public/Ticker`. */
  getCurrentPrice: () => ({ rest: KRAKEN_REST_COUNTER_COSTS.publicRequest }),
  /** `GET /0/public/OHLC`. */
  getCandles: () => ({ rest: KRAKEN_REST_COUNTER_COSTS.publicRequest }),

  /**
   * `POST /0/private/AddOrder`: the matching engine only.
   *
   * The REST component is genuinely zero -- Kraken's own docs exclude AddOrder
   * from the call counter -- and it stays zero rather than being floored, because
   * the trading charge already makes this call measured. The floor exists to stop
   * an UNMEASURED path through the gate, and there is none here.
   */
  placeOrder: (context) => ({
    rest: KRAKEN_REST_COUNTER_COSTS.trading,
    trading: { pair: tradingPair(context, "placeOrder"), count: KRAKEN_ADD_ORDER_COST },
  }),

  /**
   * `POST /0/private/CancelOrder`, then ONE `ClosedOrders` read.
   *
   * Both halves, because entry 90 DECISION 2 makes the status read part of what
   * `cancelOrder` does rather than something a caller may skip. The cancel
   * charges the engine by the order's age; the read charges the REST counter as
   * account history -- the endpoint at the centre of the +2/+4 contradiction, and
   * the reason that contradiction had to be resolved rather than noted.
   */
  cancelOrder: (context) => ({
    rest: KRAKEN_REST_COUNTER_COSTS.accountHistory,
    trading: {
      pair: tradingPair(context, "cancelOrder"),
      count: krakenCancelCost(context.orderAgeMs),
    },
  }),

  /**
   * `OpenOrders`, then `ClosedOrders` only if the order is no longer resting.
   *
   * Charged for BOTH every time. A gate prices a call before it is made and
   * cannot know which branch it will take, and the branch that costs more is the
   * one that runs when an order has just filled -- the moment a strategy is most
   * likely to be asking.
   */
  getOrderStatus: () => ({
    rest:
      KRAKEN_REST_COUNTER_COSTS.standardPrivate + KRAKEN_REST_COUNTER_COSTS.accountHistory,
  }),

  /** `POST /0/private/OpenOrders`. Not account history; the ordinary rate. */
  getOpenOrders: () => ({ rest: KRAKEN_REST_COUNTER_COSTS.standardPrivate }),
  /** `POST /0/private/BalanceEx`. */
  getAccountBalances: () => ({ rest: KRAKEN_REST_COUNTER_COSTS.standardPrivate }),
};

/**
 * The cost table for each venue -- the whole of "which cost model is this?".
 *
 * A `Record<ExchangeId, ...>` rather than a lookup with a default, for the
 * reason `resolveExchangeForAccount`'s `default`-less switch and
 * `VENUE_PUBLISHES_INSTRUMENT_TYPE` are written that way: adding a fourth
 * exchange must FAIL TO COMPILE here until its table is declared, not fall back
 * to another venue's numbers. A default is precisely what made every Gemini
 * account spend Binance's weights.
 */
export const METHOD_COSTS: Readonly<Record<ExchangeId, MethodCosts>> = {
  binance: BINANCE_METHOD_COSTS,
  gemini: GEMINI_METHOD_COSTS,
  kraken: KRAKEN_METHOD_COSTS,
};

/** The cost model for one venue. Total over `ExchangeId`; never guesses. */
export function methodCostsFor(exchange: ExchangeId): MethodCosts {
  return METHOD_COSTS[exchange];
}

// ---------------------------------------------------------------------------
// Batch cancel: an OPTIONAL capability, so a table of its own
// ---------------------------------------------------------------------------

/** What is known about a batch cancellation, for pricing it. */
export interface BatchCancelContext {
  /** The one market every id in the batch rests on. */
  readonly pair: Pair;
  /**
   * One age per order, in the order requested; `null` where unknown.
   *
   * A LIST, not a count, and that is the whole reason this cost is not a
   * `MethodCost`. Kraken prices each cancelled order by its own age rung and
   * gives batches no discount, so a real ladder -- rungs laid minutes apart --
   * costs the SUM of its rungs, not `n` times any one of them. A count could
   * only be multiplied by a single rung, which would be wrong in both directions
   * depending on which one was picked.
   */
  readonly orderAgesMs: readonly (number | null)[];
}

/** What one batch cancellation costs, given what is known about it. */
export type BatchCancelCost = (context: BatchCancelContext) => AcquireCost;

/**
 * Kraken's batch cancel: one unconditional engine charge, one metered read.
 *
 * ⚠ THE TWO HALVES ARE TREATED DIFFERENTLY ON PURPOSE.
 *
 * The ENGINE half is `unconditional`. Kraken publishes, beside the Batch Cancel
 * row of its own cost table, "If the rate counter in the batch exceeds maximum
 * for a batch cancel, the requests in batch are still accepted." So the gate
 * records the charge and never refuses the call over it -- refusing would protect
 * nothing (the venue was not going to refuse) and would stop a halt from
 * cancelling its orders, which is entry 90's worst case arriving by the other
 * door.
 *
 * The REST half is `accountHistory`, ORDINARY and gated, and it is ONE read for
 * the whole batch rather than one per order -- `KrakenClient.cancelOrderBatch`
 * issues a single `ClosedOrders`. That single number is most of the point: eight
 * sequential `cancelOrder`s cost 8 x 4 = 32 on a counter of 15, and this costs 4.
 * Kraken's sentence says nothing about the REST counter, so nothing here claims
 * it does.
 */
export const KRAKEN_BATCH_CANCEL_COST: BatchCancelCost = (context) => ({
  rest: KRAKEN_REST_COUNTER_COSTS.accountHistory,
  trading: {
    pair: context.pair,
    count: krakenBatchCancelCost(context.orderAgesMs),
    unconditional: true,
  },
});

/**
 * Which venues can cancel a named set of orders, and what it costs them.
 *
 * ⚠ `null` MEANS "THIS VENUE HAS NO SUCH ENDPOINT", and is written out per venue
 * rather than left to a missing key, for the same reason `METHOD_COSTS` is a
 * total `Record` and `resolveExchangeForAccount`'s switch has no `default`: a
 * fourth exchange must FAIL TO COMPILE here until somebody has looked, instead of
 * silently inheriting Kraken's numbers or silently losing the capability.
 *
 * Both nulls are findings, not placeholders. Binance spot cancels one order, all
 * orders on a symbol, or one OCO list; Gemini cancels one order, all session
 * orders, or all active orders. Neither has an endpoint that takes a LIST of
 * ids, and their cancel-everything forms are not a substitute -- see
 * `BatchCancellingClient` for why one of those would be actively dangerous here.
 */
export const BATCH_CANCEL_COSTS: Readonly<Record<ExchangeId, BatchCancelCost | null>> = {
  binance: null,
  gemini: null,
  kraken: KRAKEN_BATCH_CANCEL_COST,
};

/** How this venue prices a batch cancel, or `null` if it cannot do one. */
export function batchCancelCostFor(exchange: ExchangeId): BatchCancelCost | null {
  return BATCH_CANCEL_COSTS[exchange];
}

/**
 * The longest a single call will wait for budget before giving up.
 *
 * One window: everything in a rolling window has aged out after one, so a
 * request that still cannot be served after that long is not waiting on this
 * system's own traffic -- it is waiting on the exchange's own count, which
 * means something else is spending the account's budget. Continuing to hold the
 * caller at that point would block a Durable Object on a condition that is not
 * improving.
 *
 * It still holds for a decaying counter, where the equivalent question is how
 * long a full counter takes to drain. Kraken's longest at the assumed Starter
 * tier is the per-pair trading counter, 60 units shedding 1 per second -- 60
 * seconds exactly. Its REST counter drains in 46. So this bound covers both
 * without being generous to either; a venue with a slower drain would need it
 * derived per venue rather than fixed.
 */
export const DEFAULT_MAX_WAIT_MS = 60_000;

export interface RateLimitedExchangeOptions {
  /**
   * WHICH VENUE this gate sits in front of. REQUIRED, and the whole options
   * object is required with it, so a call site cannot construct a gate without
   * saying what it is gating.
   *
   * There is no default, and that is the fix. This used to be a `weights`
   * option defaulting to `BINANCE_METHOD_WEIGHTS`; neither of the two call
   * sites passed one, so every Gemini account in production and testnet was
   * gated against Binance's cost model -- silently, because a wrong weight
   * produces no error, just a budget that does not describe the venue being
   * spent. A default here can only ever be right for one venue, so there is
   * none: an unnamed venue is a compile error rather than a wrong guess.
   *
   * It is an `ExchangeId` -- the same value `accounts.exchange` stores,
   * `bot_instances.exchange` stores and `resolveExchangeForAccount` dispatches
   * on -- so the table charged and the client underneath are selected from ONE
   * fact, not from two that could disagree.
   */
  readonly exchange: ExchangeId;
  readonly priority?: RequestPriority;
  readonly maxWaitMs?: number;
  /** Injected so tests need no real delay. */
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => Timestamp;
  /** Prefixed to the diagnostic label on every request, e.g. the bot's id. */
  readonly label?: string;
  /**
   * When an order was placed, for venues that price a cancel by the order's age.
   *
   * ⚠ OPTIONAL, AND ITS ABSENCE IS SAFE BY CONSTRUCTION. A gate with no resolver
   * reports every age as unknown, and an unknown age is charged the most
   * expensive rung Kraken publishes (+8, the under-five-seconds price). So a call
   * site that has not wired this up is throttled harder than it needs to be and
   * is never under-charged -- which is the only acceptable direction for a
   * default on a risk control.
   *
   * It returns the PLACEMENT TIME rather than an age because that is what the
   * caller actually holds: `orders.created_at`. Converting it here means the one
   * clock involved is this gate's own `now`.
   *
   * On the venues that price by method alone the value is never read at all.
   */
  readonly orderPlacedAt?: (
    pair: Pair,
    clientOrderId: string,
  ) => Promise<Timestamp | null> | Timestamp | null;
}

interface ResolvedOptions {
  readonly exchange: ExchangeId;
  readonly priority: RequestPriority;
  readonly costs: MethodCosts;
  readonly maxWaitMs: number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly now: () => Timestamp;
  readonly label: string;
  readonly orderPlacedAt:
    | ((pair: Pair, clientOrderId: string) => Promise<Timestamp | null> | Timestamp | null)
    | undefined;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export class RateLimitedExchange implements RestExchangeClient {
  readonly #inner: RestExchangeClient;
  readonly #limiter: RateLimiterPort;
  readonly #options: ResolvedOptions;

  /**
   * The batch-cancel capability, PRESENT ONLY WHEN THE WRAPPED CLIENT HAS IT.
   *
   * ⚠ These two are assigned in the constructor or not at all, and that
   * conditional definition is the design rather than an accident of it.
   * `supportsBatchCancel` is a runtime check on method presence, and every call
   * site holds a `RestExchangeClient` -- `withPriority` returns one, `#exchange`
   * on `BotInstance` returns one. If this class always defined the method, the
   * guard would answer TRUE for a Binance bot, whose client cannot do this at
   * all, and the caller would take the batch path into a `TypeError`.
   *
   * So the gate mirrors the venue: it can batch-cancel exactly when the thing it
   * wraps can, and it says so the same way. `withPriority` rebuilds a gate over
   * the same inner client, so the capability survives that seam by being
   * re-derived rather than by being copied.
   *
   * A venue whose cost table says `null` does NOT get the method even if its
   * client somehow offers one: an uncosted call through the gate is the failure
   * this file exists to prevent, and the fail-closed answer is to keep the
   * sequential path.
   */
  readonly batchCancelMaxOrders?: number;
  readonly cancelOrderBatch?: (
    pair: Pair,
    clientOrderIds: readonly string[],
  ) => Promise<ExchangeOutcome<BatchCancelResult>>;

  constructor(
    inner: RestExchangeClient,
    limiter: RateLimiterPort,
    options: RateLimitedExchangeOptions,
  ) {
    this.#inner = inner;
    this.#limiter = limiter;
    this.#options = {
      exchange: options.exchange,
      // Derived from the venue, never passed in beside it: a gate whose table
      // and whose client could name different exchanges is the bug this
      // replaces, one argument further along.
      costs: methodCostsFor(options.exchange),
      priority: options.priority ?? "routine",
      maxWaitMs: options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS,
      sleep: options.sleep ?? defaultSleep,
      now: options.now ?? (() => Date.now()),
      label: options.label ?? "",
      orderPlacedAt: options.orderPlacedAt,
    };

    const batchCost = batchCancelCostFor(options.exchange);
    if (batchCost !== null && supportsBatchCancel(inner)) {
      const capable: BatchCancellingClient = inner;
      this.batchCancelMaxOrders = capable.batchCancelMaxOrders;
      this.cancelOrderBatch = async (pair, clientOrderIds) =>
        await this.#gateBatchCancel(capable, batchCost, pair, clientOrderIds);
    }
  }

  /** The venue whose cost model this gate is charging. */
  get exchange(): ExchangeId {
    return this.#options.exchange;
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
    const { exchange, maxWaitMs, sleep, now, label, orderPlacedAt } = this.#options;
    return new RateLimitedExchange(this.#inner, this.#limiter, {
      exchange,
      maxWaitMs,
      sleep,
      now,
      label,
      priority,
      // Carried across explicitly. A risk-exit view that lost the resolver would
      // silently start charging every cancel the unknown-age maximum, which is
      // safe but would throttle the halt path hardest of all.
      ...(orderPlacedAt === undefined ? {} : { orderPlacedAt }),
    });
  }

  get priority(): RequestPriority {
    return this.#options.priority;
  }

  // -------------------------------------------------------------------------
  // Section 4.1 surface, each one gated
  // -------------------------------------------------------------------------

  async getServerTime(): Promise<ExchangeOutcome<number>> {
    return this.#gate("getServerTime", "", null, () => this.#inner.getServerTime());
  }

  async getSymbolFilters(pair: Pair): Promise<ExchangeOutcome<SymbolFilters>> {
    return this.#gate("getSymbolFilters", pair, pair, () => this.#inner.getSymbolFilters(pair));
  }

  async listTradablePairs(): Promise<ExchangeOutcome<Pair[]>> {
    return this.#gate("listTradablePairs", "", null, () => this.#inner.listTradablePairs());
  }

  async getCurrentPrice(pair: Pair): Promise<ExchangeOutcome<Price>> {
    return this.#gate("getCurrentPrice", pair, pair, () => this.#inner.getCurrentPrice(pair));
  }

  async getCandles(
    pair: Pair,
    interval: CandleInterval,
    since?: Timestamp,
  ): Promise<ExchangeOutcome<Candle[]>> {
    return this.#gate("getCandles", `${pair} ${interval}`, pair, () =>
      this.#inner.getCandles(pair, interval, since),
    );
  }

  async placeOrder(order: OrderRequest): Promise<ExchangeOutcome<OrderResult>> {
    return this.#gate("placeOrder", order.clientOrderId, order.pair, () =>
      this.#inner.placeOrder(order),
    );
  }

  async cancelOrder(pair: Pair, clientOrderId: string): Promise<ExchangeOutcome<OrderStatus>> {
    return this.#gate(
      "cancelOrder",
      clientOrderId,
      pair,
      () => this.#inner.cancelOrder(pair, clientOrderId),
      // The ONLY call that asks for an age, because it is the only one any venue
      // here prices by one. Resolved lazily so the lookup is not paid for on the
      // venues that ignore it.
      () => this.#ageOf(pair, clientOrderId),
    );
  }

  async getOrderStatus(pair: Pair, clientOrderId: string): Promise<ExchangeOutcome<OrderStatus>> {
    return this.#gate("getOrderStatus", clientOrderId, pair, () =>
      this.#inner.getOrderStatus(pair, clientOrderId),
    );
  }

  async getOpenOrders(pair: Pair): Promise<ExchangeOutcome<OrderStatus[]>> {
    return this.#gate("getOpenOrders", pair, pair, () => this.#inner.getOpenOrders(pair));
  }

  async getAccountBalances(): Promise<ExchangeOutcome<Balance[]>> {
    return this.#gate("getAccountBalances", "", null, () => this.#inner.getAccountBalances());
  }

  // -------------------------------------------------------------------------

  /**
   * How long an order has been resting, or `null` if this gate cannot tell.
   *
   * `null` is returned for every reason it could be: no resolver wired, the
   * resolver not finding the order, or the resolver failing. All three mean the
   * same thing to the cost table -- charge the maximum -- and collapsing them
   * here keeps that decision in ONE place rather than three.
   *
   * A THROWING resolver is caught deliberately. It is a database read on the
   * halt path, and a halt that cannot cancel because its rate-limit gate could
   * not read a timestamp would be a risk control defeated by its own accounting.
   * Failing to the most expensive price is the honest degradation.
   */
  async #ageOf(pair: Pair, clientOrderId: string): Promise<number | null> {
    const { orderPlacedAt, now } = this.#options;
    if (orderPlacedAt === undefined) return null;
    try {
      const placedAt = await orderPlacedAt(pair, clientOrderId);
      if (placedAt === null || !Number.isFinite(placedAt)) return null;
      return now() - placedAt;
    } catch {
      return null;
    }
  }

  /**
   * Ask for budget, wait if refused, and only then make the call.
   *
   * The inner call happens exactly once and only after a grant. There is no
   * path through this function that reaches the exchange without one, which is
   * the property section 5.4 is actually asking for.
   *
   * The cost is computed ONCE, before the loop, and the same vector is
   * re-presented on every retry. Recomputing it per attempt would let an order
   * grow older while it waits and quietly get cheaper mid-queue -- so a caller
   * that waited long enough would be granted a charge smaller than the one it
   * queued for, and everything behind it would have been ordered against a claim
   * that no longer existed.
   */
  async #gate<T>(
    method: keyof RestExchangeClient,
    detail: string,
    pair: Pair | null,
    call: () => Promise<ExchangeOutcome<T>>,
    resolveAge?: () => Promise<number | null>,
  ): Promise<ExchangeOutcome<T>> {
    const { costs, label } = this.#options;
    const describe = `${label === "" ? "" : `${label} `}${method}${detail === "" ? "" : ` ${detail}`}`;

    const orderAgeMs = resolveAge === undefined ? null : await resolveAge();
    const cost = costs[method]({ pair, orderAgeMs });
    return await this.#spend(describe, cost, call);
  }

  /**
   * Cancel several orders in one request, charged as one.
   *
   * Present on this class only when the wrapped client offers it -- see the
   * fields at the top. The ages are resolved BEFORE the cost is computed and
   * every one of them individually, because Kraken prices each order in the batch
   * by its own rung; an id whose placement time this gate cannot read reports
   * `null` and is charged the dearest rung, which is `#ageOf`'s existing rule
   * applied per order rather than a second, laxer one.
   *
   * The ages are resolved SEQUENTIALLY rather than with `Promise.all`. The
   * resolver is a read against one Durable Object's own storage -- there is no
   * concurrency to win -- and doing them in order keeps the ages in the same
   * order as the ids, which is what makes the cost auditable against the list.
   */
  async #gateBatchCancel(
    inner: BatchCancellingClient,
    cost: BatchCancelCost,
    pair: Pair,
    clientOrderIds: readonly string[],
  ): Promise<ExchangeOutcome<BatchCancelResult>> {
    const { label } = this.#options;
    const describe =
      `${label === "" ? "" : `${label} `}cancelOrderBatch ${pair} ` +
      `(${clientOrderIds.length} orders)`;

    const orderAgesMs: (number | null)[] = [];
    for (const clientOrderId of clientOrderIds) {
      orderAgesMs.push(await this.#ageOf(pair, clientOrderId));
    }

    return await this.#spend(describe, cost({ pair, orderAgesMs }), () =>
      inner.cancelOrderBatch(pair, clientOrderIds),
    );
  }

  /**
   * Ask for budget, wait if refused, and only then make the call.
   *
   * Split out of `#gate` so the batch-cancel path -- whose cost is not a
   * `MethodCost` and whose method name is not a `keyof RestExchangeClient` --
   * shares the queueing, ticket and give-up behaviour exactly rather than
   * growing a second copy of it that could drift.
   */
  async #spend<T>(
    describe: string,
    cost: AcquireCost,
    call: () => Promise<ExchangeOutcome<T>>,
  ): Promise<ExchangeOutcome<T>> {
    const { exchange, priority, maxWaitMs, sleep, now } = this.#options;
    const priced = describeCost(cost);

    let ticketId: string | undefined;
    let waited = 0;

    for (;;) {
      const result = await this.#limiter.acquire({
        exchange,
        cost,
        priority,
        ...(ticketId !== undefined ? { ticketId } : {}),
        label: describe,
      });

      if (result.granted) return await call();

      if (result.ticketId === null) {
        // Either `weight_exceeds_limit` -- this request is bigger than its
        // priority's entire share -- or `wrong_exchange`, a mis-wired limiter.
        // No amount of waiting changes either, so both are reported as
        // non-retryable and a caller wrapping this in `withRetry` stops
        // immediately rather than looping on a condition that cannot improve.
        return rateLimited<T>(
          result.reason === "wrong_exchange"
            ? `${describe} was sent to a rate limiter serving a different ` +
                `exchange than ${exchange}. It was not sent, and retrying will not help.`
            : `${describe} needs ${priced}, which exceeds the whole ${priority} ` +
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
          `${describe} could not obtain ${priced} within ${maxWaitMs}ms ` +
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
 * A cost vector in words, for a message a human has to act on.
 *
 * The two components are different currencies and are never summed -- "9" would
 * be a number that exists on no counter at the venue. See `AcquireCost`.
 */
function describeCost(cost: AcquireCost): string {
  const parts: string[] = [];
  if (cost.rest > 0) parts.push(`${cost.rest} account-counter units`);
  if (cost.trading !== undefined && cost.trading.count > 0) {
    parts.push(`${cost.trading.count} trading units on ${cost.trading.pair}`);
  }
  return parts.length === 0 ? "no budget" : parts.join(" and ");
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
  options: RateLimitedExchangeOptions,
): RateLimitedExchange {
  return new RateLimitedExchange(inner, limiter, options);
}
