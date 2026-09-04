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
import { botInstanceRow, freshDatabase } from "../db/test-helpers";
import type { AcquireRequest, AcquireResult } from "../durable-objects/rate-limiter";
import { FakeExchange } from "../durable-objects/fake-exchange";
import { inLimiter } from "../durable-objects/test-helpers";
import {
  BINANCE_METHOD_WEIGHTS,
  GEMINI_METHOD_WEIGHTS,
  type RateLimiterPort,
} from "../exchange/rate-limited";
import { fromDecimalString as m, type Money } from "../shared/money";
import { BLIND_AFTER_MS, runScheduledReconciliation } from "./reconciliation";

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
      cost: request.cost,
      usedWeight: request.cost.rest,
      usedTrading: request.cost.trading?.count ?? null,
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

  // The account must be REGISTERED, not merely present in the ledger. It used
  // not to matter, because every account got a Binance client regardless; now
  // the pass reads each account's exchange to decide where to look, and an
  // account with no registered venue is refused rather than guessed at. That is
  // the production requirement too (docs/d1-provisioning.md, step 11).
  await db.accounts.insert({
    account_label: ACCOUNT,
    exchange: "binance",
    created_at: T0,
    updated_at: T0,
  });

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
    expect(limiter.requests.some((request) => request.cost.rest === BINANCE_METHOD_WEIGHTS.getAccountBalances)).toBe(
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
    const total = limiter.requests.reduce((sum, request) => sum + request.cost.rest, 0);
    expect(total).toBe(BINANCE_METHOD_WEIGHTS.getAccountBalances);
  });
});

// ---------------------------------------------------------------------------
// Regression: the wrong-venue bug
// ---------------------------------------------------------------------------

const GEMINI_ACCOUNT = "recon-gemini";

/** Register a second account on Gemini, with funds, so a pass must visit both. */
async function seedGeminiAccount(): Promise<void> {
  await db.accounts.insert({
    account_label: GEMINI_ACCOUNT,
    exchange: "gemini",
    created_at: T0,
    updated_at: T0,
  });
  await seedPlaceholderTotalBalance(
    db,
    { accountLabel: GEMINI_ACCOUNT, asset: "USD", totalBalance: m("1000"), note: "test fixture" },
    { actor: ACTOR, now: T0 },
  );
}

describe("each account is reconciled against the exchange it is registered on", () => {
  it("routes per account, not to one hardcoded venue", async () => {
    // THE TEST THAT WAS MISSING. The old assertions checked that reconciliation
    // called "an" exchange client, which a single Binance client for every
    // account satisfies perfectly -- and did, in production, against a Gemini
    // account, for eleven hours. What has to be asserted is WHICH venue each
    // account was routed to, so the seam records the pair.
    await seedGeminiAccount();

    const routed: Array<{ label: string; exchange: string }> = [];
    const result = await runScheduledReconciliation(
      env,
      options({
        exchangeFor: (label: string, ex: string) => {
          routed.push({ label, exchange: ex });
          return exchange;
        },
      }),
    );

    expect(result.ran).toBe(true);
    expect(routed).toEqual(
      expect.arrayContaining([
        { label: ACCOUNT, exchange: "binance" },
        { label: GEMINI_ACCOUNT, exchange: "gemini" },
      ]),
    );
    // And specifically: the Gemini account was NOT handed a Binance client.
    expect(routed.find((r) => r.label === GEMINI_ACCOUNT)!.exchange).toBe("gemini");
  });

  it("gates each account with ITS OWN venue's weight table", async () => {
    // The venue bug, one layer below the one above. Routing the CLIENT per
    // account was fixed already; the BUDGET was still Binance's for everyone,
    // because this call site passed no weight table and the gate defaulted to
    // one. So a Gemini account's balance read was charged 20 (Binance's
    // `/api/v3/account`) against a budget that has nothing to do with Gemini,
    // instead of the 2 units one private Gemini request costs.
    //
    // A limiter PER ACCOUNT, because the shared spy the other tests use pools
    // both accounts' requests into one list and could not tell them apart --
    // which is exactly why nothing here noticed.
    await seedGeminiAccount();

    const limiters = new Map<string, SpyLimiter>();
    const limiterFor = (accountLabel: string): SpyLimiter => {
      const existing = limiters.get(accountLabel);
      if (existing !== undefined) return existing;
      const fresh = new SpyLimiter();
      limiters.set(accountLabel, fresh);
      return fresh;
    };

    const result = await runScheduledReconciliation(env, options({ limiterFor }));
    expect(result.ran).toBe(true);

    const weightsFor = (accountLabel: string): number[] =>
      (limiters.get(accountLabel)?.requests ?? []).map((request) => request.cost.rest);

    // One balance read per account (pinned by the budget test above), each
    // priced by the venue that account is registered on.
    expect(weightsFor(ACCOUNT)).toEqual([BINANCE_METHOD_WEIGHTS.getAccountBalances]);
    expect(weightsFor(GEMINI_ACCOUNT)).toEqual([GEMINI_METHOD_WEIGHTS.getAccountBalances]);

    // The assertion that fails against the old code, stated on its own so the
    // failure names the actual defect rather than an off-by-one in a list.
    expect(weightsFor(GEMINI_ACCOUNT)).not.toEqual([
      BINANCE_METHOD_WEIGHTS.getAccountBalances,
    ]);
  });

  it("reaches the Gemini resolver for a Gemini account, on the real dispatch path", async () => {
    // No injected factory: this exercises `resolveExchangeForAccount` itself.
    // The technique is the one exchange-attachment.test.ts uses -- withhold the
    // secret and read which one the failure names. No network call is made,
    // because resolution fails before any client is constructed.
    //
    // Under the old code this account would have been handed a Binance client
    // built from the BINANCE_* secrets below and the pass would have "succeeded"
    // while reading the wrong exchange. That is precisely the silent success
    // this asserts against.
    // A database holding ONLY the Gemini account, so the pass has exactly one
    // account to resolve and no secrets to resolve it with. Resolution fails
    // before any client is constructed, so nothing reaches the network.
    db = await freshDatabase();
    await seedGeminiAccount();

    const trading = { ...env, ENVIRONMENT: "testnet" } as unknown as Env;
    const result = await runScheduledReconciliation(trading, {
      now: () => T0,
      newId: () => crypto.randomUUID(),
      limiterFor: () => limiter,
      sleep: async () => undefined,
      db,
    });

    expect(result.ran).toBe(false);
    // Names the GEMINI secret, which it can only do if `resolveGeminiExchange`
    // was the resolver it reached. Under the old code this account would have
    // gone to `resolveDefaultExchange` and been given a Binance client.
    expect(result.reason).toContain("GEMINI_API_KEY");
    expect(result.reason).not.toContain("BINANCE_API_KEY");
    // It never got as far as spending budget against the wrong venue.
    expect(limiter.requests).toHaveLength(0);
  });

  it("visits every account, so one account's missing secret cannot abort the pass", async () => {
    // The old code resolved ONE client above the account loop and returned
    // `ran: false` for the WHOLE pass the moment that resolution failed --
    // every other account went unreconciled with no record naming it. Now each
    // account is resolved on its own and each failure is attributed.
    await seedGeminiAccount();

    const trading = { ...env, ENVIRONMENT: "testnet" } as unknown as Env;
    await runScheduledReconciliation(trading, {
      now: () => T0,
      newId: () => crypto.randomUUID(),
      limiterFor: () => limiter,
      sleep: async () => undefined,
      db,
    });

    const binanceAlert = await db.alerts.findMany({
      where: { alert_type: "reconciliation_blind", source: `reconciliation:${ACCOUNT}` },
    });
    const geminiAlert = await db.alerts.findMany({
      where: { alert_type: "reconciliation_blind", source: `reconciliation:${GEMINI_ACCOUNT}` },
    });

    // Both accounts were reached, and each failure names ITS OWN exchange's
    // secret rather than one generic reason for the pass.
    expect(binanceAlert).toHaveLength(1);
    expect(binanceAlert[0]!.message).toContain("BINANCE_API_KEY");
    expect(geminiAlert).toHaveLength(1);
    expect(geminiAlert[0]!.message).toContain("GEMINI_API_KEY");
  });

  it("prefers the accounts registry over an inference from the bots", async () => {
    // Registration is the authoritative record (migration 0006). A bot row's
    // own `exchange` is only a fallback for an account that was never
    // registered, and must not override a deliberate human registration.
    await seedGeminiAccount();

    const routed = new Map<string, string>();
    await runScheduledReconciliation(
      env,
      options({
        exchangeFor: (label: string, ex: string) => {
          routed.set(label, ex);
          return exchange;
        },
      }),
    );

    expect(routed.get(GEMINI_ACCOUNT)).toBe("gemini");
  });

  it("refuses an account with no registered exchange rather than guessing one", async () => {
    // A ledger-only account with nothing to infer from. Defaulting it to
    // Binance is exactly how a Gemini account came to be read from Binance, so
    // the safe answer is to refuse -- loudly.
    await seedPlaceholderTotalBalance(
      db,
      { accountLabel: "orphan-acct", asset: "USDT", totalBalance: m("500"), note: "test fixture" },
      { actor: ACTOR, now: T0 },
    );

    const routed: string[] = [];
    const result = await runScheduledReconciliation(
      env,
      options({
        exchangeFor: (label: string) => {
          routed.push(label);
          return exchange;
        },
      }),
    );

    expect(result.ran).toBe(true);
    expect(routed).not.toContain("orphan-acct");

    const alerts = await db.alerts.findMany({
      where: { alert_type: "reconciliation_blind", source: "reconciliation:orphan-acct" },
    });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.severity).toBe("critical");
    expect(alerts[0]!.message).toMatch(/no registered exchange/);
  });
});

// ---------------------------------------------------------------------------
// Regression: reconciliation failing silently
// ---------------------------------------------------------------------------

describe("a pass that runs but observes nothing says so", () => {
  const BLIND = { kind: "exchange_error" as const, message: "Service unavailable from a restricted location" };

  it("raises a critical alert when it cannot read an account at all", async () => {
    // THE ELEVEN-HOUR BUG. `reconcile.ts` correctly declines to invent a
    // balance it could not read -- but the only trace was a string in the run's
    // audit `details_json`. 143 consecutive passes read nothing, wrote nothing,
    // and alerted nothing. This is the assertion whose absence allowed that.
    exchange.balancesFailure = BLIND;

    const result = await runScheduledReconciliation(env, options());

    expect(result.ran).toBe(true);
    expect(await db.balanceSnapshots.count()).toBe(0); // still refuses to invent

    const alerts = await db.alerts.findMany({
      where: { alert_type: "reconciliation_blind", source: `reconciliation:${ACCOUNT}` },
    });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.severity).toBe("critical");
    expect(alerts[0]!.category).toBe("system");
    expect(alerts[0]!.resolved).toBe(false);
    // It carries the exchange's own reason, so the alert is actionable rather
    // than just "something is wrong".
    expect(alerts[0]!.message).toContain("restricted location");
  });

  it("stays quiet for a single transient failure", async () => {
    // One failed read is a blip, not an incident: the account was observed
    // moments ago. Alerting on every transient error is how an alert channel
    // becomes something people mute, which is its own way of failing silently.
    await runScheduledReconciliation(env, options()); // a good observation at T0
    exchange.balancesFailure = BLIND;

    await runScheduledReconciliation(env, options({ now: () => T0 + 5 * 60_000 }));

    const alerts = await db.alerts.findMany({ where: { alert_type: "reconciliation_blind" } });
    expect(alerts).toHaveLength(0);
  });

  it("escalates once the account has been unobserved past the threshold", async () => {
    await runScheduledReconciliation(env, options()); // good observation at T0
    exchange.balancesFailure = BLIND;

    await runScheduledReconciliation(env, options({ now: () => T0 + BLIND_AFTER_MS + 1 }));

    const alerts = await db.alerts.findMany({ where: { alert_type: "reconciliation_blind" } });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.message).toMatch(/minute\(s\) ago/);
  });

  it("opens ONE incident, not one alert per pass", async () => {
    // At a five-minute cron an alert per pass is 288 rows a day for one
    // incident. The dispatcher's cooldown throttles the pings; this keeps the
    // table itself readable as a list of incidents.
    exchange.balancesFailure = BLIND;

    for (let i = 0; i < 5; i++) {
      await runScheduledReconciliation(env, options({ now: () => T0 + i * 5 * 60_000 }));
    }

    const alerts = await db.alerts.findMany({ where: { alert_type: "reconciliation_blind" } });
    expect(alerts).toHaveLength(1);
  });

  it("resolves the incident when observation resumes", async () => {
    exchange.balancesFailure = BLIND;
    await runScheduledReconciliation(env, options());

    const opened = await db.alerts.findMany({ where: { alert_type: "reconciliation_blind" } });
    expect(opened).toHaveLength(1);
    expect(opened[0]!.resolved).toBe(false);

    // The exchange comes back.
    exchange.balancesFailure = null;
    await runScheduledReconciliation(env, options({ now: () => T0 + 5 * 60_000 }));

    const after = await db.alerts.findMany({ where: { alert_type: "reconciliation_blind" } });
    expect(after).toHaveLength(1);
    // Closed, not deleted: the incident stays in the record, but the dashboard
    // no longer shows a resolved failure as if it were current.
    expect(after[0]!.resolved).toBe(true);
    expect(await db.balanceSnapshots.count()).toBeGreaterThan(0);
  });

  it("reopens if the account goes blind again after recovering", async () => {
    exchange.balancesFailure = BLIND;
    await runScheduledReconciliation(env, options());
    exchange.balancesFailure = null;
    await runScheduledReconciliation(env, options({ now: () => T0 + 5 * 60_000 }));

    exchange.balancesFailure = BLIND;
    await runScheduledReconciliation(env, options({ now: () => T0 + 5 * 60_000 + BLIND_AFTER_MS + 1 }));

    const alerts = await db.alerts.findMany({
      where: { alert_type: "reconciliation_blind", resolved: false },
    });
    expect(alerts).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// The independent price cross-check (entry 86 PART 6's open item)
// ---------------------------------------------------------------------------

/**
 * `/src/reconciliation/price-cross-check.ts` tests every decision the check
 * makes against injected numbers. This file tests the thing those tests cannot
 * see: that the cron actually RUNS it, for the right pairs, from the right two
 * sources, and that it cannot take reconciliation down with it.
 */
describe("the price cross-check rides the 5-minute reconciliation cron", () => {
  const KRAKEN_BTC = m("80707.6"); // live Kraken close, 2026-09-04
  const GEMINI_BTC = m("80760.01"); // live Gemini last, same capture

  function crossCheckPorts(
    reference: Record<string, Money>,
    listing: readonly string[] = ["BTCUSD"],
  ) {
    const asked: string[] = [];
    return {
      asked,
      portsFor: () => ({
        primaryPrice: async (pair: string) => {
          asked.push(`primary:${pair}`);
          return {
            ok: true as const,
            value: { pair, price: exchange.currentPrice, at: T0 },
            at: T0,
          };
        },
        referenceListing: async () => ({ ok: true as const, value: listing, at: T0 }),
        referencePrice: async (pair: string) => {
          asked.push(`reference:${pair}`);
          const price = reference[pair];
          if (price === undefined) {
            return {
              ok: false as const,
              kind: "transport" as const,
              message: `no fixture for ${pair}`,
              retryable: true,
              at: T0,
            };
          }
          return { ok: true as const, value: { pair, price, at: T0 }, at: T0 };
        },
      }),
    };
  }

  async function runningBot(overrides: Record<string, unknown> = {}): Promise<void> {
    await db.botInstances.insert(
      botInstanceRow({
        id: "grid-btc-1",
        account_label: ACCOUNT,
        exchange: "binance",
        pair: "BTCUSD",
        status: "running",
        ...overrides,
      }),
    );
  }

  it("does not run outside production, even with running bots", async () => {
    // ⚠ The gate, asserted from the cron's side. On testnet the primary feed IS
    // a simulator (entry 86), so every pair would diverge on every pass forever.
    await runningBot();
    const { asked, portsFor } = crossCheckPorts({ BTCUSD: KRAKEN_BTC });

    const result = await runScheduledReconciliation(
      env,
      options({ environment: "testnet", crossCheckPortsFor: portsFor }),
    );

    expect(result.ran).toBe(true);
    expect(result.crossChecks).toEqual([]);
    expect(asked).toEqual([]);
  });

  it("checks each running pair against both sources on production", async () => {
    await runningBot();
    exchange.currentPrice = GEMINI_BTC;
    const { asked, portsFor } = crossCheckPorts({ BTCUSD: KRAKEN_BTC });

    const result = await runScheduledReconciliation(
      env,
      options({ environment: "production", crossCheckPortsFor: portsFor }),
    );

    expect(result.crossChecks).toHaveLength(1);
    expect(result.crossChecks[0]!.observed).toBe(true);
    // Both venues were asked, for the pair the bot is actually on.
    expect(asked).toEqual(["primary:BTCUSD", "reference:BTCUSD"]);
    // Two live closes 0.065% apart: ordinary spread, no alert.
    expect(result.crossChecks[0]!.outcomes[0]!.status).toBe("agreed");
  });

  it("alerts when the primary feed diverges, without halting the bot", async () => {
    // ⚠ The 2026-09-02 shape, end to end through the cron: a frozen sandbox
    // value against a live Kraken close. Entry 92's observe-don't-gate rule is
    // the second half of the assertion and is the more important half.
    await runningBot();
    exchange.currentPrice = m("78172.34");
    const { portsFor } = crossCheckPorts({ BTCUSD: KRAKEN_BTC });

    await runScheduledReconciliation(
      env,
      options({ environment: "production", crossCheckPortsFor: portsFor }),
    );

    const alerts = await db.alerts.findMany({
      where: { alert_type: "price_feed_reference_divergence" },
    });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.severity).toBe("critical");
    expect(alerts[0]!.message).toContain("BTCUSD");

    const bot = await db.botInstances.findOne({ id: "grid-btc-1" });
    expect(bot!.status).toBe("running");
    expect(bot!.halt_reason).toBeNull();
  });

  it("only looks at RUNNING bots", async () => {
    // A halted bot has unsubscribed and its price is frozen by design, so it
    // would diverge permanently and mean nothing. A created one never traded.
    // `halt_requires_reason` is a real CHECK constraint, so a halted row must
    // carry one -- the same shape a real halt writes.
    await runningBot({
      id: "grid-halted",
      status: "halted",
      pair: "ETHUSD",
      halt_reason: "manual",
      halted_at: T0,
    });
    await runningBot({ id: "grid-created", status: "created", pair: "SOLUSD" });
    const { asked, portsFor } = crossCheckPorts({ BTCUSD: KRAKEN_BTC });

    const result = await runScheduledReconciliation(
      env,
      options({ environment: "production", crossCheckPortsFor: portsFor }),
    );

    expect(result.crossChecks).toEqual([]);
    expect(asked).toEqual([]);
  });

  it("checks a pair once however many bots are on it", async () => {
    await runningBot({ id: "grid-btc-1" });
    await runningBot({ id: "grid-btc-2" });
    await runningBot({ id: "grid-btc-3" });
    const { asked, portsFor } = crossCheckPorts({ BTCUSD: KRAKEN_BTC });

    await runScheduledReconciliation(
      env,
      options({ environment: "production", crossCheckPortsFor: portsFor }),
    );

    // Three bots, one pair, one pair of reads.
    expect(asked).toEqual(["primary:BTCUSD", "reference:BTCUSD"]);
  });

  it("skips a pair Kraken does not list, and says so without alerting", async () => {
    await runningBot({ pair: "PONSUSD" });
    const { portsFor } = crossCheckPorts({}, ["BTCUSD", "ETHUSD"]);

    const result = await runScheduledReconciliation(
      env,
      options({ environment: "production", crossCheckPortsFor: portsFor }),
    );

    expect(result.ran).toBe(true);
    expect(result.crossChecks[0]!.outcomes[0]!.status).toBe("skipped");
    expect(result.crossChecks[0]!.outcomes[0]!.reason).toContain("not listed on kraken");
    expect(await db.alerts.count({ alert_type: "price_feed_reference_divergence" })).toBe(0);
  });

  it("⚠ cannot take reconciliation down with it", async () => {
    // The whole reason `crossCheckAccountPrices` wraps itself. This is a SANITY
    // CHECK riding on a RISK CONTROL: section 9's drift detection must not stop
    // because the observer threw. Reconciliation still runs, still reconciles,
    // and the cross-check simply reports nothing for the pass.
    await runningBot();
    const result = await runScheduledReconciliation(
      env,
      options({
        environment: "production",
        crossCheckPortsFor: () => {
          throw new Error("a bug in the cross-check");
        },
      }),
    );

    expect(result.ran).toBe(true);
    expect(result.runs).toHaveLength(1);
    expect(result.crossChecks).toEqual([]);
  });

  it("does nothing for an account whose bots are all stopped", async () => {
    await runningBot({ status: "stopped" });
    const { portsFor } = crossCheckPorts({ BTCUSD: KRAKEN_BTC });

    const result = await runScheduledReconciliation(
      env,
      options({ environment: "production", crossCheckPortsFor: portsFor }),
    );

    expect(result.ran).toBe(true);
    expect(result.crossChecks).toEqual([]);
  });
});
