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
import { BINANCE_METHOD_WEIGHTS, withRateLimit, type RateLimiterPort } from "./rate-limited";

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
      weight: request.weight,
      usedWeight: request.weight,
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

function gated(options: Parameters<typeof withRateLimit>[2] = {}) {
  return withRateLimit(exchange, limiter, {
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
    await client.getCurrentPrice(TEST_PAIR);
    await client.getOrderStatus(TEST_PAIR, "v1-bot-0");
    await client.getOpenOrders(TEST_PAIR);
    await client.getAccountBalances();
    await client.cancelOrder(TEST_PAIR, "v1-bot-0");

    expect(limiter.requests.map((request) => request.weight)).toEqual([
      BINANCE_METHOD_WEIGHTS.getServerTime,
      BINANCE_METHOD_WEIGHTS.getSymbolFilters,
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
        await object.acquire({ weight: 1, priority: "routine" });
      }
    });

    const client = withRateLimit(exchange, rateLimiterStub(account), {
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
