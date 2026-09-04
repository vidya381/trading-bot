/**
 * The gate in front of the exchange (spec section 5.4).
 *
 * Two layers here:
 *
 *   - against a RECORDING limiter, which is where the weight table, the ticket
 *     loop, the bounded wait and the priority views are pinned exactly;
 *   - against the REAL `RateLimiter` Durable Object, because the property that
 *     actually matters -- a cancellation storm is throttled and then completes
 *     -- is a property of the two together, and a double could be made to agree
 *     with a wrapper that was wrong.
 */

import { beforeEach, describe, expect, it } from "vitest";

import type { AcquireRequest, AcquireResult } from "../durable-objects/rate-limiter";
import { FakeExchange, TEST_PAIR } from "../durable-objects/fake-exchange";
import { inLimiter, rateLimiterStub } from "../durable-objects/test-helpers";
import { isUsable } from "../shared/downtime";
import { fromDecimalString } from "../shared/money";
import { EXCHANGE_IDS } from "../db/schema";
import { DEFAULT_WEIGHT_LIMIT } from "../durable-objects/rate-limiter";
import { GEMINI_RATE_LIMITS, GEMINI_REQUEST_COSTS } from "./gemini/client";
import {
  BINANCE_METHOD_WEIGHTS,
  GEMINI_METHOD_WEIGHTS,
  METHOD_COSTS,
  methodCostsFor,
  withRateLimit,
  type MethodCosts,
  type MethodWeights,
  type RateLimitedExchangeOptions,
  type RateLimiterPort,
} from "./rate-limited";

const NOW = 1_760_000_000_000;

/**
 * A limiter that records what it was asked and answers from a script.
 *
 * Not a `vi.fn()` bag: it implements the port, so a change to `AcquireResult`
 * fails to compile here rather than being silently agreed with -- the same
 * reasoning `FakeExchange` was built on.
 */
class RecordingLimiter implements RateLimiterPort {
  readonly requests: AcquireRequest[] = [];
  readonly released: string[] = [];
  /** Answers, consumed in order. Anything past the end is granted. */
  script: AcquireResult[] = [];

  async acquire(request: AcquireRequest): Promise<AcquireResult> {
    this.requests.push(request);
    const scripted = this.script.shift();
    if (scripted !== undefined) return scripted;
    return {
      granted: true,
      cost: request.cost,
      usedWeight: request.cost.rest,
      usedTrading: request.cost.trading?.count ?? null,
      remainingForPriority: 1000,
      at: NOW,
    };
  }

  async release(ticketId: string): Promise<void> {
    this.released.push(ticketId);
  }
}

function denial(overrides: Partial<Extract<AcquireResult, { granted: false }>> = {}) {
  return {
    granted: false as const,
    reason: "budget_exhausted" as const,
    ticketId: "ticket-1",
    retryAfterMs: 250,
    queuePosition: 0,
    usedWeight: 1200,
    remainingForPriority: 0,
    at: NOW,
    ...overrides,
  };
}

let exchange: FakeExchange;
let limiter: RecordingLimiter;
let slept: number[];

beforeEach(() => {
  exchange = new FakeExchange();
  limiter = new RecordingLimiter();
  slept = [];
});

function gated(options: Partial<RateLimitedExchangeOptions> = {}) {
  return withRateLimit(exchange, limiter, {
    // Named explicitly, like every other call site must now. There is no
    // default venue to fall back on -- see the "which venue" block below.
    exchange: "binance",
    now: () => NOW,
    sleep: async (ms) => {
      slept.push(ms);
    },
    ...options,
  });
}

// ---------------------------------------------------------------------------

describe("asking before calling", () => {
  it("requests budget before every method, at that method's documented weight", async () => {
    const client = gated();

    await client.getServerTime();
    await client.getSymbolFilters(TEST_PAIR);
    await client.listTradablePairs();
    await client.getCurrentPrice(TEST_PAIR);
    await client.getOrderStatus(TEST_PAIR, "v1-bot-0");
    await client.getOpenOrders(TEST_PAIR);
    await client.getAccountBalances();
    await client.cancelOrder(TEST_PAIR, "v1-bot-0");

    expect(limiter.requests.map((request) => request.cost.rest)).toEqual([
      BINANCE_METHOD_WEIGHTS.getServerTime,
      BINANCE_METHOD_WEIGHTS.getSymbolFilters,
      BINANCE_METHOD_WEIGHTS.listTradablePairs,
      BINANCE_METHOD_WEIGHTS.getCurrentPrice,
      BINANCE_METHOD_WEIGHTS.getOrderStatus,
      BINANCE_METHOD_WEIGHTS.getOpenOrders,
      BINANCE_METHOD_WEIGHTS.getAccountBalances,
      BINANCE_METHOD_WEIGHTS.cancelOrder,
    ]);
  });

  it("does not reach the exchange at all when budget is refused for good", async () => {
    limiter.script = [denial({ reason: "weight_exceeds_limit", ticketId: null })];
    const client = gated();

    const outcome = await client.placeOrder({
      pair: TEST_PAIR,
      clientOrderId: "v1-bot-0",
      side: "buy",
      type: "limit",
      price: fromDecimalString("100"),
      quantity: fromDecimalString("1"),
    });

    expect(isUsable(outcome)).toBe(false);
    // The whole point of section 5.4: nothing was sent.
    expect(exchange.placed).toHaveLength(0);
  });

  it("reports a permanent refusal as non-retryable, so withRetry stops", async () => {
    limiter.script = [denial({ reason: "weight_exceeds_limit", ticketId: null })];
    const outcome = await gated().getAccountBalances();

    expect(outcome).toMatchObject({
      ok: false,
      kind: "rate_limited",
      retryable: false,
    });
    // No ticket was issued, so there is nothing to sleep on or release.
    expect(slept).toEqual([]);
    expect(limiter.released).toEqual([]);
  });
});

describe("waiting for budget", () => {
  it("sleeps for the stated delay and re-presents the same ticket", async () => {
    limiter.script = [denial({ retryAfterMs: 250 }), denial({ retryAfterMs: 400 })];
    const outcome = await gated().getOpenOrders(TEST_PAIR);

    expect(isUsable(outcome)).toBe(true);
    expect(slept).toEqual([250, 400]);
    // The first ask carries no ticket; every later one carries the ticket the
    // limiter issued, which is what preserves the queue place.
    expect(limiter.requests.map((request) => request.ticketId)).toEqual([
      undefined,
      "ticket-1",
      "ticket-1",
    ]);
  });

  it("gives up past maxWaitMs, releases its place, and sends nothing", async () => {
    limiter.script = [denial({ retryAfterMs: 400 }), denial({ retryAfterMs: 400 })];
    const outcome = await gated({ maxWaitMs: 500 }).cancelOrder(TEST_PAIR, "v1-bot-0");

    expect(outcome).toMatchObject({ ok: false, kind: "rate_limited", retryable: true });
    // Slept once (400 <= 500), refused to sleep a second time (800 > 500).
    expect(slept).toEqual([400]);
    // The abandoned place is handed back rather than left to claim weight for a
    // request nobody intends to send until its TTL expires.
    expect(limiter.released).toEqual(["ticket-1"]);
    expect(exchange.cancelled).toHaveLength(0);
  });

  it("says plainly, in the message, that the request was not sent", async () => {
    limiter.script = [denial({ retryAfterMs: 99_999 })];
    const outcome = await gated({ maxWaitMs: 10 }).getAccountBalances();
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    // The message is what a human reads off the dashboard when a bot did
    // nothing. "It was NOT sent" is the fact that distinguishes this from a
    // transport failure, and it should not require knowing the type system.
    expect(outcome.message).toContain("NOT sent");
    expect(outcome.retryAfterMs).toBe(99_999);
  });
});

describe("priority views", () => {
  it("tags requests routine by default", async () => {
    await gated().placeOrder({
      pair: TEST_PAIR,
      clientOrderId: "v1-bot-0",
      side: "buy",
      type: "limit",
      price: fromDecimalString("100"),
      quantity: fromDecimalString("1"),
    });
    expect(limiter.requests[0]?.priority).toBe("routine");
  });

  it("tags requests risk-exit through the risk-exit view, on the same limiter", async () => {
    const routine = gated();
    const risk = routine.withPriority("risk-exit");

    await routine.getOpenOrders(TEST_PAIR);
    await risk.cancelOrder(TEST_PAIR, "v1-bot-0");

    expect(limiter.requests.map((request) => request.priority)).toEqual([
      "routine",
      "risk-exit",
    ]);
  });

  it("carries the label through, so a queue entry can be attributed", async () => {
    await gated({ label: "dca-btc-1" }).cancelOrder(TEST_PAIR, "v1-bot-7");
    expect(limiter.requests[0]?.label).toBe("dca-btc-1 cancelOrder v1-bot-7");
  });
});

// ---------------------------------------------------------------------------
// Which venue's cost model gets charged
// ---------------------------------------------------------------------------

/**
 * The regression suite for a bug that ran in production and testnet.
 *
 * `RateLimitedExchange` used to default its weight table to
 * `BINANCE_METHOD_WEIGHTS`, and NEITHER call site passed one -- so every Gemini
 * account was gated against Binance's cost model. Nothing failed: a wrong
 * weight produces no error, only a budget that does not describe the venue it
 * is spending. That is exactly the class of bug a test has to catch, because
 * running the system will not.
 *
 * The first test below is the one that would have caught it. It fails against
 * the old code, because the old code had no way to be told a venue at all.
 */
describe("charging the venue it is actually in front of", () => {
  /** Every method except `placeOrder`, which needs a live order to send. */
  async function callEachMethod(client: ReturnType<typeof withRateLimit>): Promise<void> {
    await client.getServerTime();
    await client.getSymbolFilters(TEST_PAIR);
    await client.listTradablePairs();
    await client.getCurrentPrice(TEST_PAIR);
    await client.getCandles(TEST_PAIR, "1m");
    await client.getOrderStatus(TEST_PAIR, "v1-bot-0");
    await client.getOpenOrders(TEST_PAIR);
    await client.getAccountBalances();
    await client.cancelOrder(TEST_PAIR, "v1-bot-0");
  }

  const CALLED: readonly (keyof MethodWeights)[] = [
    "getServerTime",
    "getSymbolFilters",
    "listTradablePairs",
    "getCurrentPrice",
    "getCandles",
    "getOrderStatus",
    "getOpenOrders",
    "getAccountBalances",
    "cancelOrder",
  ];

  it("charges GEMINI's weights for a Gemini-gated call, not Binance's", async () => {
    await callEachMethod(gated({ exchange: "gemini" }));

    expect(limiter.requests.map((request) => request.cost.rest)).toEqual(
      CALLED.map((method) => GEMINI_METHOD_WEIGHTS[method]),
    );

    // And say it the other way round too, so this cannot pass by the two tables
    // happening to agree: the weights actually sent are NOT Binance's.
    expect(limiter.requests.map((request) => request.cost.rest)).not.toEqual(
      CALLED.map((method) => BINANCE_METHOD_WEIGHTS[method]),
    );
  });

  it("still charges Binance's weights for a Binance-gated call", async () => {
    await callEachMethod(gated({ exchange: "binance" }));

    expect(limiter.requests.map((request) => request.cost.rest)).toEqual(
      CALLED.map((method) => BINANCE_METHOD_WEIGHTS[method]),
    );
  });

  it("has two tables that genuinely disagree, so the assertions above bite", () => {
    // Without this, both tests above could pass against a single shared table.
    // Named methods rather than a count, because WHICH ones differ is the part
    // that matters: a Gemini `getAccountBalances` is one cheap private request,
    // where Binance's `/api/v3/account` is the most expensive call it makes.
    const disagreeing = CALLED.filter(
      (method) => GEMINI_METHOD_WEIGHTS[method] !== BINANCE_METHOD_WEIGHTS[method],
    );
    expect(disagreeing).toContain("getAccountBalances");
    expect(disagreeing).toContain("getSymbolFilters");
    expect(disagreeing).toContain("cancelOrder");
  });

  it("keeps the venue when a call site takes the risk-exit view", async () => {
    // `withPriority` rebuilds the wrapper. A venue dropped there would restore
    // the original bug on exactly the path that matters most -- the halt.
    const routine = gated({ exchange: "gemini" });
    await routine.withPriority("risk-exit").cancelOrder(TEST_PAIR, "v1-bot-0");

    expect(limiter.requests[0]).toMatchObject({
      priority: "risk-exit",
      cost: { rest: GEMINI_METHOD_WEIGHTS.cancelOrder },
    });
  });

  it("declares a table for every known exchange", () => {
    // A `Record<ExchangeId, ...>`, so widening `ExchangeId` for Kraken breaks
    // the map rather than silently handing it another venue's numbers. This
    // asserts the runtime half: no venue resolves to `undefined`. It was RED for
    // five entries while Kraken's row was deliberately withheld; the
    // rate-limiter session is what turned it green.
    for (const exchange of EXCHANGE_IDS) {
      expect(methodCostsFor(exchange)).toBe(METHOD_COSTS[exchange]);
      expect(methodCostsFor(exchange)).toBeDefined();
    }
  });

  it("gives every method in every table a cost the budget will accept", () => {
    // A budget refuses a non-positive charge, so every method has to cost
    // SOMETHING on at least one counter -- Gemini's `getServerTime` sends no
    // request at all and is floored to one unit for exactly that reason.
    //
    // The check is now "positive on some counter" rather than "positive", which
    // is the change Kraken forced: its `placeOrder` genuinely costs ZERO on the
    // account counter, because Kraken's REST counter excludes AddOrder, and is
    // measured entirely by its per-pair trading charge. Demanding a positive
    // account cost would have meant inventing one.
    for (const exchange of EXCHANGE_IDS) {
      for (const [method, cost] of Object.entries(methodCostsFor(exchange))) {
        // Every table is priced with an age of `null` here -- the unknown-age
        // case, which is the most expensive one any venue charges.
        const charged = cost({ pair: TEST_PAIR, orderAgeMs: null });
        const total = charged.rest + (charged.trading?.count ?? 0);
        expect(
          total,
          `${exchange}.${method} costs nothing on any counter`,
        ).toBeGreaterThan(0);
        expect(Number.isFinite(charged.rest)).toBe(true);
        expect(charged.rest).toBeGreaterThanOrEqual(0);
      }
    }
  });
});

describe("how Gemini's request counts become budget units", () => {
  it("prices a request so neither of Gemini's published limits can be exceeded", () => {
    // Gemini publishes no weights: it counts REQUESTS against two independent
    // per-minute counters. The gate spends one weight budget, so a request has
    // to be priced in that budget's units -- and the price is only defensible
    // if it lands each counter exactly on Gemini's own published figure.
    //
    // This pins the arithmetic against the REAL constants on both sides, so a
    // change to the DO's ceiling or to Gemini's documented limits fails here
    // rather than silently re-pricing every Gemini call in production.
    const requestsPerWindow = (method: keyof MethodWeights): number =>
      DEFAULT_WEIGHT_LIMIT / GEMINI_METHOD_WEIGHTS[method];

    // `/v1/balances` is private: 1200 / 2 = 600 = Gemini's private limit.
    expect(requestsPerWindow("getAccountBalances")).toBe(
      GEMINI_RATE_LIMITS.privateRequestsPerMinute,
    );
    // `/v1/pubticker` is public: 1200 / 10 = 120 = Gemini's public limit.
    expect(requestsPerWindow("getCurrentPrice")).toBe(
      GEMINI_RATE_LIMITS.publicRequestsPerMinute,
    );
    // Both are stated per MINUTE, which is the window the budget runs on.
    expect(GEMINI_RATE_LIMITS.windowMs).toBe(60_000);
  });

  it("charges a Gemini cancel for BOTH requests it sends", () => {
    // Gemini's cancel takes only a numeric `order_id`, so `cancelOrder` is a
    // status lookup plus the cancel. Charging it one request would under-count
    // the halt path -- the ladder-wide cancellation storm -- by half, on the
    // one path the risk-exit reserve exists to protect.
    expect(GEMINI_REQUEST_COSTS.cancelOrder.requests).toBe(2);
    expect(GEMINI_METHOD_WEIGHTS.cancelOrder).toBe(
      2 * GEMINI_METHOD_WEIGHTS.getOrderStatus,
    );
  });

  it("charges the smallest accepted weight for a call that sends nothing", () => {
    // Gemini exposes no server-time endpoint; the method returns a failure
    // without reaching the network. Its true cost is zero requests, and the
    // budget refuses a non-positive weight, so one unit is the floor.
    expect(GEMINI_REQUEST_COSTS.getServerTime.requests).toBe(0);
    expect(GEMINI_METHOD_WEIGHTS.getServerTime).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Against the real Durable Object
// ---------------------------------------------------------------------------

describe("against the real RateLimiter", () => {
  it("throttles a cancellation storm and then completes every one of them", async () => {
    // The end-to-end version of the storm: a grid halt cancelling a full ladder
    // through the wrapper, against a real budget. Nothing here is scripted --
    // the throttling is whatever the object decides, and the wrapper's job is
    // to wait it out rather than to give up or to hammer.
    const account = "storm-account";
    let clock = NOW;

    await inLimiter(account, async (object) => {
      object.attach({ now: () => clock });
      await object.syncLimit(60, 60_000, NOW);
      // Routine traffic has already spent its whole ceiling (60 - 10 = 50).
      for (let i = 0; i < 50; i++) {
        await object.acquire({ exchange: "binance", cost: { rest: 1 }, priority: "routine" });
      }
    });

    const client = withRateLimit(exchange, rateLimiterStub(account), {
      exchange: "binance",
      priority: "risk-exit",
      now: () => clock,
      // Sleeping advances the shared clock, which is what makes a wait
      // deterministic without one actually elapsing.
      sleep: async (ms) => {
        slept.push(ms);
        clock += ms;
      },
    });

    // A 30-line ladder, all resting, all being cancelled at once.
    const LADDER = 30;
    for (let i = 0; i < LADDER; i++) {
      await exchange.placeOrder({
        pair: TEST_PAIR,
        clientOrderId: `v1-grid-${i}`,
        side: "buy",
        type: "limit",
        price: fromDecimalString("100"),
        quantity: fromDecimalString("1"),
      });
    }

    const outcomes = await Promise.all(
      Array.from({ length: LADDER }, (_, i) => client.cancelOrder(TEST_PAIR, `v1-grid-${i}`)),
    );

    // Every cancellation eventually happened -- a halt that gave up halfway is
    // a halt that half happened (step 6), and throttling must not cause that.
    expect(outcomes.every((outcome) => isUsable(outcome))).toBe(true);
    expect(exchange.cancelled).toHaveLength(LADDER);

    // But they did NOT all fire at once: the reserve covered 10 of them and the
    // rest had to wait for the window. That waiting is the throttling.
    expect(slept.length).toBeGreaterThan(0);
    expect(clock).toBeGreaterThan(NOW);
  });

  it("is one budget per account: two clients on one account contend", async () => {
    const account = "shared-account";
    await inLimiter(account, async (object) => {
      object.attach({ now: () => NOW });
      await object.syncLimit(24, 60_000, NOW);
    });

    const options = {
      exchange: "binance" as const,
      now: () => NOW,
      sleep: async (ms: number) => {
        slept.push(ms);
      },
      maxWaitMs: 0,
    };
    const botA = withRateLimit(exchange, rateLimiterStub(account), options);
    const botB = withRateLimit(new FakeExchange(), rateLimiterStub(account), options);

    // Routine ceiling is 24 - 4 = 20, and `getAccountBalances` costs 20. The
    // first client takes the lot; the second finds nothing left, which is the
    // entire reason this is one object per account rather than per caller.
    expect(isUsable(await botA.getAccountBalances())).toBe(true);
    expect(await botB.getAccountBalances()).toMatchObject({
      ok: false,
      kind: "rate_limited",
    });
  });
});

// ---------------------------------------------------------------------------
// Kraken: two counters, and a price that depends on the order's age
// ---------------------------------------------------------------------------

/**
 * What the gate charges on Kraken, and where the age comes from.
 *
 * The constants are pinned against Kraken's published tables in
 * `kraken/rate-limits.test.ts`; these assert that the GATE reaches for the right
 * ones and puts them in the right component of the cost vector.
 */
describe("the Kraken cost model, through the gate", () => {
  it("charges an order to the matching engine only, and names the pair", async () => {
    // Kraken's REST counter excludes AddOrder entirely, so `rest` is genuinely
    // zero rather than floored -- the trading charge is what measures this call.
    const client = gated({ exchange: "kraken" });
    await client.placeOrder({
      pair: TEST_PAIR,
      side: "buy",
      type: "limit",
      price: fromDecimalString("100"),
      quantity: fromDecimalString("1"),
      clientOrderId: "bot-1toiyz-0001",
    });

    expect(limiter.requests[0]!.cost).toEqual({
      rest: 0,
      trading: { pair: TEST_PAIR, count: 1 },
    });
    expect(limiter.requests[0]!.exchange).toBe("kraken");
  });

  it("charges a cancel to BOTH counters: the engine, and its one status read", async () => {
    // Entry 90 DECISION 2 makes the follow-up `ClosedOrders` read part of what
    // `cancelOrder` does, so the gate prices both halves. The 4 is the account
    // history rate -- the constant sitting on Kraken's own +2/+4 contradiction.
    const client = gated({ exchange: "kraken" });
    await client.cancelOrder(TEST_PAIR, "bot-1toiyz-0001");

    expect(limiter.requests[0]!.cost).toEqual({
      rest: 4,
      trading: { pair: TEST_PAIR, count: 8 },
    });
  });

  it("charges the status read for both endpoints it may call, not just the first", async () => {
    // `OpenOrders` always, `ClosedOrders` only if the order has stopped resting.
    // A gate prices a call before it is made and cannot know which branch runs --
    // and the dearer branch is the one that runs when an order has just filled,
    // which is when a strategy is most likely to be asking.
    const client = gated({ exchange: "kraken" });
    await client.getOrderStatus(TEST_PAIR, "bot-1toiyz-0001");

    expect(limiter.requests[0]!.cost).toEqual({ rest: 5 });
  });

  it("prices the public market-data calls at the honest minimum", async () => {
    const client = gated({ exchange: "kraken" });
    await client.getCurrentPrice(TEST_PAIR);
    await client.getCandles(TEST_PAIR, "1m");
    await client.getOpenOrders(TEST_PAIR);
    await client.getAccountBalances();

    expect(limiter.requests.map((request) => request.cost.rest)).toEqual([1, 1, 1, 1]);
    // None of them touches the matching engine.
    expect(limiter.requests.every((request) => request.cost.trading === undefined)).toBe(true);
  });
});

describe("the cancel price depends on the order's age, which is the whole reason costs are functions", () => {
  /** A gate that knows when the order was placed, as a call site with D1 would. */
  function withAge(placedAt: number | null) {
    return gated({
      exchange: "kraken",
      orderPlacedAt: () => placedAt,
    });
  }

  it.each([
    ["3 seconds old (a ladder just laid)", NOW - 3_000, 8],
    ["8 seconds old", NOW - 8_000, 6],
    ["30 seconds old", NOW - 30_000, 4],
    ["2 minutes old", NOW - 120_000, 1],
    ["10 minutes old", NOW - 600_000, 0],
  ])("charges a cancel on an order %s -> %d engine units", async (_label, placedAt, expected) => {
    const client = withAge(placedAt);
    await client.cancelOrder(TEST_PAIR, "bot-1toiyz-0001");
    expect(limiter.requests[0]!.cost.trading!.count).toBe(expected);
  });

  it("charges the same method eight times as much on a young order as on an old one", async () => {
    // THE PROPERTY `Record<keyof RestExchangeClient, number>` COULD NOT EXPRESS.
    // Same method, same arguments, eight times the price.
    const young = withAge(NOW - 3_000);
    await young.cancelOrder(TEST_PAIR, "bot-1toiyz-0001");
    const youngCost = limiter.requests[0]!.cost.trading!.count;

    limiter.requests.length = 0;
    const old = withAge(NOW - 200_000);
    await old.cancelOrder(TEST_PAIR, "bot-1toiyz-0001");
    const oldCost = limiter.requests[0]!.cost.trading!.count;

    expect(youngCost).toBe(8);
    expect(oldCost).toBe(1);
    expect(youngCost).toBe(oldCost * 8);
  });

  it("charges the maximum when no resolver is wired at all", async () => {
    // ⚠ THE FAIL-CLOSED DEFAULT. A call site that has not wired the lookup is
    // throttled harder than it needs to be and is never under-charged, which is
    // the only acceptable direction for a default on a risk control.
    const client = gated({ exchange: "kraken" });
    await client.cancelOrder(TEST_PAIR, "bot-1toiyz-0001");
    expect(limiter.requests[0]!.cost.trading!.count).toBe(8);
  });

  it("charges the maximum when the resolver cannot find the order", async () => {
    // The path most likely to lack a local record is reconciliation, which
    // cancels orders this system has lost track of.
    const client = withAge(null);
    await client.cancelOrder(TEST_PAIR, "bot-1toiyz-0001");
    expect(limiter.requests[0]!.cost.trading!.count).toBe(8);
  });

  it("charges the maximum when the resolver THROWS, rather than failing the cancel", async () => {
    // A halt that could not cancel because its rate-limit gate could not read a
    // timestamp would be a risk control defeated by its own accounting.
    const client = gated({
      exchange: "kraken",
      orderPlacedAt: () => {
        throw new Error("D1 unavailable");
      },
    });
    const result = await client.cancelOrder(TEST_PAIR, "bot-1toiyz-0001");

    expect(limiter.requests[0]!.cost.trading!.count).toBe(8);
    // And the cancel was SENT -- the gate granted and called through. Whether
    // the fake exchange knows this order is beside the point; what matters is
    // that a failed timestamp lookup did not become a rate-limit refusal.
    expect(limiter.requests).toHaveLength(1);
    expect(result.ok === false && result.kind).not.toBe("rate_limited");
  });

  it("keeps the fail-closed maximum on a record MISS, which is the call site's exact shape", async () => {
    // `bot-instance.ts` installs `(await this.#order(id))?.createdAt ?? null`,
    // and the branch that matters is the miss: `#cancelOpenOrders` iterates
    // `state.openOrderIds` and has its own `order === undefined` case for an id
    // the object has lost the record of. This drives that exact expression.
    const records = new Map<string, { createdAt: number }>([["known-0001", { createdAt: NOW - 30_000 }]]);
    const client = gated({
      exchange: "kraken",
      orderPlacedAt: (_pair, clientOrderId) => records.get(clientOrderId)?.createdAt ?? null,
    });

    await client.cancelOrder(TEST_PAIR, "known-0001");
    expect(limiter.requests[0]!.cost.trading!.count).toBe(4);

    await client.cancelOrder(TEST_PAIR, "never-recorded-0001");
    expect(limiter.requests[1]!.cost.trading!.count).toBe(8);
  });

  it("⚠ would charge NOTHING if a miss resolved to 0 instead of null, which is why it is null", async () => {
    // The trap this pins. `?? 0` reads as the Unix epoch, making every unknown
    // order fifty-odd years old and its cancel FREE -- the exact inversion of
    // fail-closed, and silent. Asserted so nobody "tidies" the null away.
    const client = gated({ exchange: "kraken", orderPlacedAt: () => 0 });
    await client.cancelOrder(TEST_PAIR, "bot-1toiyz-0001");
    expect(limiter.requests[0]!.cost.trading!.count).toBe(0);
  });

  it("accepts an async resolver, since a real call site reads D1", async () => {
    const client = gated({
      exchange: "kraken",
      orderPlacedAt: async () => NOW - 30_000,
    });
    await client.cancelOrder(TEST_PAIR, "bot-1toiyz-0001");
    expect(limiter.requests[0]!.cost.trading!.count).toBe(4);
  });

  it("asks the resolver for the pair and id it is actually cancelling", async () => {
    const asked: [string, string][] = [];
    const client = gated({
      exchange: "kraken",
      orderPlacedAt: (pair, clientOrderId) => {
        asked.push([pair, clientOrderId]);
        return NOW - 30_000;
      },
    });
    await client.cancelOrder(TEST_PAIR, "bot-1toiyz-0001");
    expect(asked).toEqual([[TEST_PAIR, "bot-1toiyz-0001"]]);
  });

  it("does not consult the resolver for any method but cancelOrder", async () => {
    let calls = 0;
    const client = gated({
      exchange: "kraken",
      orderPlacedAt: () => {
        calls += 1;
        return NOW;
      },
    });
    await client.getCurrentPrice(TEST_PAIR);
    await client.getOrderStatus(TEST_PAIR, "bot-1toiyz-0001");
    await client.placeOrder({
      pair: TEST_PAIR,
      side: "buy",
      type: "limit",
      price: fromDecimalString("100"),
      quantity: fromDecimalString("1"),
      clientOrderId: "bot-1toiyz-0001",
    });
    expect(calls).toBe(0);
  });

  it("carries the resolver across withPriority, so the halt path is not the one that loses it", async () => {
    // A risk-exit view that dropped the resolver would silently start charging
    // every cancel the unknown-age maximum -- safe, but throttling hardest of
    // all on exactly the path that can least afford it.
    const client = gated({ exchange: "kraken", orderPlacedAt: () => NOW - 200_000 });
    await client.withPriority("risk-exit").cancelOrder(TEST_PAIR, "bot-1toiyz-0001");

    expect(limiter.requests[0]).toMatchObject({
      priority: "risk-exit",
      cost: { rest: 4, trading: { pair: TEST_PAIR, count: 1 } },
    });
  });

  it("prices the cancel ONCE, so an order cannot get cheaper while it waits in the queue", async () => {
    // Recomputing per attempt would let a caller be granted a charge smaller than
    // the one it queued for, and everything behind it would have been ordered
    // against a claim that no longer existed.
    let clock = NOW;
    const client = withRateLimit(exchange, limiter, {
      exchange: "kraken",
      now: () => clock,
      sleep: async (ms) => {
        slept.push(ms);
        clock += ms;
      },
      orderPlacedAt: () => NOW - 4_000,
    });

    limiter.script = [
      denial({ reason: "budget_exhausted", ticketId: "t1", retryAfterMs: 20_000 }),
      denial({ reason: "budget_exhausted", ticketId: "t1", retryAfterMs: 20_000 }),
    ];
    await client.cancelOrder(TEST_PAIR, "bot-1toiyz-0001");

    // Three attempts, ONE price. The order was 4 seconds old at the first
    // attempt and 44 seconds old by the third -- two rungs cheaper on the ladder
    // (8 -> 4) had the gate re-priced it. It did not.
    expect(slept).toEqual([20_000, 20_000]);
    expect(clock - NOW).toBe(40_000);
    expect(limiter.requests).toHaveLength(3);
    expect(limiter.requests.map((request) => request.cost.trading!.count)).toEqual([8, 8, 8]);
  });
});
