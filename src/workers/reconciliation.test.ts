/**
 * The reconciliation Cron Trigger's wiring (spec sections 9 and 5.4).
 *
 * `/src/reconciliation` is tested on its own against injected ports. This file
 * tests the thing those tests cannot see: that the real handler supplies the
 * ports the way it claims to, and specifically that the exchange client it
 * hands in has been routed through section 5.4's budget.
 *
 * That distinction is the point. `reconcile.ts` would work identically with an
 * ungated client, and its own tests would still pass, so "reconciliation is
 * rate limited" is a property of THIS file's code and has to be asserted here.
 */

import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { seedPlaceholderTotalBalance } from "../capital";
import type { Database } from "../db/database";
import { freshDatabase } from "../db/test-helpers";
import type { AcquireRequest, AcquireResult } from "../durable-objects/rate-limiter";
import { FakeExchange } from "../durable-objects/fake-exchange";
import { inLimiter } from "../durable-objects/test-helpers";
import { BINANCE_METHOD_WEIGHTS, type RateLimiterPort } from "../exchange/rate-limited";
import { fromDecimalString as m } from "../shared/money";
import { runScheduledReconciliation } from "./reconciliation";

const T0 = 1_760_000_000_000;
const ACTOR = "owner@example.com";
const ACCOUNT = "recon-main";

class SpyLimiter implements RateLimiterPort {
  readonly requests: AcquireRequest[] = [];
  refuse = false;

  async acquire(request: AcquireRequest): Promise<AcquireResult> {
    this.requests.push(request);
    if (this.refuse) {
      return {
        granted: false,
        reason: "budget_exhausted",
        ticketId: null,
        retryAfterMs: 0,
        queuePosition: 0,
        usedWeight: 1200,
        remainingForPriority: 0,
        at: T0,
      };
    }
    return {
      granted: true,
      weight: request.weight,
      usedWeight: request.weight,
      remainingForPriority: 1000,
      at: T0,
    };
  }

  async release(): Promise<void> {}
}

let db: Database;
let exchange: FakeExchange;
let limiter: SpyLimiter;

beforeEach(async () => {
  db = await freshDatabase();
  exchange = new FakeExchange();
  exchange.balances = [{ asset: "USDT", free: m("1000"), locked: m("0") }];
  limiter = new SpyLimiter();

  await seedPlaceholderTotalBalance(
    db,
    { accountLabel: ACCOUNT, asset: "USDT", totalBalance: m("1000"), note: "test fixture" },
    { actor: ACTOR, now: T0 },
  );
});

function options(overrides: Record<string, unknown> = {}) {
  return {
    exchangeFor: () => exchange,
    now: () => T0,
    newId: () => crypto.randomUUID(),
    limiterFor: () => limiter,
    sleep: async () => undefined,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------

describe("the reconciliation pass is routed through section 5.4", () => {
  it("requests budget for every exchange call it makes", async () => {
    const result = await runScheduledReconciliation(env, options());

    expect(result.ran).toBe(true);
    // The pass read the account balances, and it asked first. Without the
    // wiring in `runScheduledReconciliation` this list would be empty and
    // everything in /src/reconciliation would still behave identically -- which
    // is exactly why this assertion lives here.
    expect(limiter.requests).not.toHaveLength(0);
    expect(limiter.requests.some((request) => request.weight === BINANCE_METHOD_WEIGHTS.getAccountBalances)).toBe(
      true,
    );
  });

  it("tags the whole pass routine, so an audit cannot spend the risk-exit reserve", async () => {
    await runScheduledReconciliation(env, options());

    // Every call this job makes is a read on a schedule. Letting a periodic
    // audit draw on the slice reserved for getting OUT of positions would buy
    // nothing: if the budget is that tight, the right outcome is that this run
    // is throttled and reports what it could not check.
    expect(limiter.requests.every((request) => request.priority === "routine")).toBe(true);
  });

  it("reports what it could not check when the budget refuses, rather than inventing it", async () => {
    limiter.refuse = true;
    const result = await runScheduledReconciliation(env, options());

    expect(result.ran).toBe(true);
    const run = result.runs[0];
    expect(run).toBeDefined();
    // Section 5.6 applies to a budget refusal exactly as it does to an
    // unreachable exchange: an unread balance must never be recorded as an
    // unchanged one, or the next run measures its delta from a fiction.
    expect(run!.skipped.join(" ")).toMatch(/rate_limited/);
    expect(await db.balanceSnapshots.count()).toBe(0);
  });

  it("refuses to run at all with no RATE_LIMITER binding", async () => {
    // The same reasoning the bot object uses: the safe default for a risk
    // control is to stop, not to quietly do without it.
    const { RATE_LIMITER: _omitted, ...withoutBinding } = env as unknown as Record<string, unknown>;
    const result = await runScheduledReconciliation(
      withoutBinding as unknown as Env,
      // No `limiterFor` either, so nothing can substitute for the binding.
      { exchangeFor: () => exchange, now: () => T0 },
    );

    expect(result.ran).toBe(false);
    expect(result.reason).toMatch(/RATE_LIMITER/);
  });

  it("uses the binding, one limiter per account, when nothing is injected", async () => {
    // The production path. `limiterFor` is omitted, so the handler resolves the
    // account's own Durable Object -- which is what makes the budget shared
    // between this cron and the bots trading on the same account, rather than
    // two independent budgets that each think they have the whole limit.
    await runScheduledReconciliation(env, {
      exchangeFor: () => exchange,
      now: () => T0,
      newId: () => crypto.randomUUID(),
      sleep: async () => undefined,
    });

    await inLimiter(ACCOUNT, async (object) => {
      const stats = await object.stats();
      expect(stats.usedWeight).toBeGreaterThan(0);
    });
  });
});

describe("what the pass actually costs", () => {
  it("spends the weight step 7 measured, and no more", async () => {
    // Step 7 measured one pass at roughly 20 for balances plus 26 per distinct
    // pair. With no bots there is no pair, so it is the balance read alone.
    // Recorded as a test because that measurement is the entire argument for
    // reconciliation being routine rather than reserved, and an accidental
    // extra call per pass would quietly invalidate it.
    await runScheduledReconciliation(env, options());
    const total = limiter.requests.reduce((sum, request) => sum + request.weight, 0);
    expect(total).toBe(BINANCE_METHOD_WEIGHTS.getAccountBalances);
  });
});
