/**
 * The dashboard API endpoints, end to end (spec step 10, backend half), build
 * step 10.
 *
 * Real D1 and real Durable Objects in the Workers runtime, per section 14; only
 * the exchange is mocked (`FakeExchange`). Every request goes through the real
 * `handleApiRequest`, including the Access JWT verification -- tokens are signed
 * with a Web Crypto key (test-helpers.ts) and the JWKS is injected, so the auth
 * gate is exercised on live endpoints, not bypassed.
 *
 * Bot ids are unique per test: `freshDatabase` clears D1 each test but Durable
 * Object storage persists across a file, so a reused id would still hold a
 * previously-created object (the same reason the kill-switch e2e test suffixes
 * its ids).
 */

import { env, SELF } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { seedPlaceholderTotalBalance } from "../capital";
import type { Database } from "../db/database";
import { alertRow, freshDatabase } from "../db/test-helpers";
import { FakeExchange, TEST_PAIR } from "../durable-objects/fake-exchange";
import { inBot, rateLimiterStub } from "../durable-objects/test-helpers";
import type { BotInstance } from "../durable-objects/bot-instance";
import { tripAccountCircuitBreaker } from "../reconciliation/circuit-breaker";
import { isGloballyTripped } from "../reconciliation/kill-switch";
import type { DcaParams } from "../strategies/dca";
import type { GridParams } from "../strategies/grid";
import { fromDecimalString as m } from "../shared/money";
import type { Jwks } from "./access";
import { handleApiRequest } from "./index";
import { generateSigningKey, signAccessJwt, type SigningKey } from "./test-helpers";

const T0 = 1_760_000_000_000;
const HUMAN = "owner@example.com";

let db: Database;
let exchange: FakeExchange;
let clock: number;
let idCounter: number;
let suffix: number;
let fileCounter = 0;
let key: SigningKey;
let jwksCache: Map<string, Jwks>;

const dcaParamsJson = {
  baseOrderSize: "100",
  additionalOrderSize: "100",
  stepMultiplier: "1.5",
  dropPct: "5",
  maxAdditionalBuys: 2,
  takeProfitPct: "2",
  stopLossPct: "20",
  autoRestart: false,
  sellOnStopLoss: false,
};

const dcaParams: DcaParams = {
  baseOrderSize: m("100"),
  additionalOrderSize: m("100"),
  stepMultiplier: m("1.5"),
  dropPct: m("5"),
  maxAdditionalBuys: 2,
  takeProfitPct: m("2"),
  stopLossPct: m("20"),
  autoRestart: false,
  sellOnStopLoss: false,
};

const gridParams: GridParams = {
  upperBound: m("110"),
  lowerBound: m("90"),
  gridLines: 5,
  spacing: "arithmetic",
  orderSize: m("100"),
  stopLossPct: m("10"),
  breakoutTakeProfit: true,
  breakoutThresholdPct: null,
  takeProfitAmount: null,
};

beforeAll(async () => {
  key = await generateSigningKey();
});

beforeEach(async () => {
  db = await freshDatabase();
  exchange = new FakeExchange();
  clock = T0;
  idCounter = 0;
  fileCounter += 1;
  suffix = fileCounter;
  jwksCache = new Map();
});

/** Attach real deps (including the fake exchange) to a bot's own object. */
async function inBotId<T>(id: string, body: (bot: BotInstance) => Promise<T>): Promise<T> {
  return await inBot(id, async (instance) => {
    instance.attach({
      db,
      exchange,
      now: () => clock,
      newId: () => `gen-${(idCounter += 1)}`,
      limiterFor: () => rateLimiterStub(`limiter-${id}`),
      sleep: async () => undefined,
    });
    return await body(instance);
  });
}

interface ApiCall {
  readonly body?: unknown;
  /** Override the actor email in the token and header. */
  readonly email?: string;
  /** Explicit token: `null` sends none; a string sends it verbatim. */
  readonly token?: string | null;
  /** Override the email HEADER only (to force a mismatch); `null` sends none. */
  readonly headerEmail?: string | null;
}

async function api(method: string, path: string, call: ApiCall = {}): Promise<{ status: number; body: any }> {
  const email = call.email ?? HUMAN;
  const token =
    call.token !== undefined
      ? call.token
      : await signAccessJwt(key, { email, exp: Math.floor(clock / 1000) + 3600 });

  const headers = new Headers();
  if (call.body !== undefined) headers.set("content-type", "application/json");
  if (token !== null) headers.set("Cf-Access-Jwt-Assertion", token);
  const headerEmail = call.headerEmail !== undefined ? call.headerEmail : email;
  if (headerEmail !== null) headers.set("Cf-Access-Authenticated-User-Email", headerEmail);

  const request = new Request(`https://dash.example.com${path}`, {
    method,
    headers,
    ...(call.body !== undefined ? { body: JSON.stringify(call.body) } : {}),
  });

  const response = await handleApiRequest(request, env, {
    now: () => clock,
    newId: () => `api-${(idCounter += 1)}`,
    access: { now: () => clock, fetchJwks: async () => key.jwks, jwksCache },
  });
  return { status: response.status, body: await response.json() };
}

async function seedBalance(account: string, total = "10000"): Promise<void> {
  await seedPlaceholderTotalBalance(
    db,
    { accountLabel: account, asset: "USDT", totalBalance: m(total), note: "test fixture" },
    { actor: HUMAN, now: T0 },
  );
}

async function createDcaBot(id: string, account: string, capital = "500"): Promise<void> {
  await inBotId(id, (bot) =>
    bot.create({
      botInstanceId: id,
      accountLabel: account,
      exchange: "binance",
      pair: TEST_PAIR,
      capitalAsset: "USDT",
      allocatedCapital: m(capital),
      params: dcaParams,
      actor: HUMAN,
    }),
  );
}

// ---------------------------------------------------------------------------
// Auth gate on a live endpoint
// ---------------------------------------------------------------------------

describe("Access verification gates every endpoint", () => {
  it("accepts a request with a valid token", async () => {
    const res = await api("GET", "/api/bots");
    expect(res.status).toBe(200);
    expect(res.body).toStrictEqual({ data: [], error: null });
  });

  it("rejects a request with no token (401)", async () => {
    const res = await api("GET", "/api/bots", { token: null });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("access_jwt_missing");
  });

  it("rejects a tampered token (401)", async () => {
    const good = await signAccessJwt(key, { email: HUMAN, exp: Math.floor(clock / 1000) + 3600 });
    const parts = good.split(".");
    // Flip the first signature char (see access.test.ts for why not the last).
    parts[2] = (parts[2]!.startsWith("A") ? "B" : "A") + parts[2]!.slice(1);
    const res = await api("GET", "/api/bots", { token: parts.join(".") });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("access_bad_signature");
  });

  it("rejects when the email header disagrees with the token (401)", async () => {
    const res = await api("GET", "/api/bots", { headerEmail: "someone-else@example.com" });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("access_email_mismatch");
  });

  it("404s an unknown API route (after auth)", async () => {
    const res = await api("GET", "/api/nope");
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("not_found");
  });

  it("405s a wrong method on a known route", async () => {
    const res = await api("DELETE", "/api/bots");
    expect(res.status).toBe(405);
    expect(res.body.error.code).toBe("method_not_allowed");
  });
});

// ---------------------------------------------------------------------------
// /health alias (unauthenticated, through the real Worker)
// ---------------------------------------------------------------------------

describe("health", () => {
  it("serves /api/health unauthenticated, like /health", async () => {
    const response = await SELF.fetch("https://dash.example.com/api/health");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ status: "ok", environment: "testnet" });
  });
});

// ---------------------------------------------------------------------------
// Bots (endpoints 1-4)
// ---------------------------------------------------------------------------

describe("bots", () => {
  it("lists every bot with status, strategy, pair, position and allocation", async () => {
    const account = `acct-${suffix}`;
    await seedBalance(account);
    const dcaId = `d${suffix}`;
    const gridId = `g${suffix}`;
    await createDcaBot(dcaId, account);
    await inBotId(gridId, (bot) =>
      bot.createGrid({
        botInstanceId: gridId,
        accountLabel: account,
        exchange: "binance",
        pair: TEST_PAIR,
        capitalAsset: "USDT",
        allocatedCapital: m("500"),
        params: gridParams,
        actor: HUMAN,
      }),
    );

    const res = await api("GET", "/api/bots");
    expect(res.status).toBe(200);
    const ids = res.body.data.map((b: any) => b.id).sort();
    expect(ids).toEqual([dcaId, gridId].sort());
    const dca = res.body.data.find((b: any) => b.id === dcaId);
    expect(dca).toMatchObject({
      strategy: "dca",
      status: "created",
      pair: TEST_PAIR,
      // Money is serialized as the canonical fixed-precision decimal string
      // (toDecimalString), matching how audit_log details are written.
      allocatedCapital: "500.00000000",
      capitalAsset: "USDT",
    });
    expect(dca.position).toMatchObject({ strategy: "dca", heldQuantity: "0.00000000" });
  });

  it("returns full detail for one bot, including config and state", async () => {
    const account = `acct-${suffix}`;
    await seedBalance(account);
    const id = `d${suffix}`;
    await createDcaBot(id, account);

    const res = await api("GET", `/api/bots/${id}`);
    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe(id);
    expect(res.body.data.config.strategy).toBe("dca");
    expect(res.body.data.state.status).toBe("created");
    expect(res.body.data.orders).toEqual([]);
    expect(res.body.data.alerts).toEqual([]);
  });

  it("404s an unknown bot", async () => {
    const res = await api("GET", `/api/bots/missing${suffix}`);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("unknown_bot");
  });

  it("creates a bot, reusing the capital-ledger check, and returns it (201)", async () => {
    const account = `acct-${suffix}`;
    await seedBalance(account);
    const id = `c${suffix}`;

    const res = await api("POST", "/api/bots", {
      body: {
        botInstanceId: id,
        accountLabel: account,
        exchange: "binance",
        pair: TEST_PAIR,
        capitalAsset: "USDT",
        allocatedCapital: "500",
        strategy: "dca",
        params: dcaParamsJson,
      },
    });

    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ id, status: "created", strategy: "dca" });

    // The bot row and the reservation really landed.
    const row = await db.botInstances.findOne({ id });
    expect(row!.status).toBe("created");
    const ledger = await db.capitalLedger.findOne({ account_label: account, asset: "USDT" });
    expect(ledger!.total_allocated).toBe(m("500"));
    // The creation was audited to the verified human actor.
    const audit = await db.auditLog.findMany({ where: { target_bot_instance_id: id } });
    expect(audit.some((a) => a.action === "capital.allocated" && a.actor === HUMAN)).toBe(true);
  });

  it("rejects a create missing a stop-loss (400)", async () => {
    const account = `acct-${suffix}`;
    await seedBalance(account);
    const noStop: Record<string, unknown> = { ...dcaParamsJson };
    delete noStop.stopLossPct;
    const res = await api("POST", "/api/bots", {
      body: {
        botInstanceId: `n${suffix}`,
        accountLabel: account,
        exchange: "binance",
        pair: TEST_PAIR,
        capitalAsset: "USDT",
        allocatedCapital: "500",
        strategy: "dca",
        params: noStop,
      },
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("invalid_parameter");
  });

  it("rejects a create that exceeds available capital (400)", async () => {
    const account = `acct-${suffix}`;
    await seedBalance(account, "100"); // less than the requested 500
    const res = await api("POST", "/api/bots", {
      body: {
        botInstanceId: `x${suffix}`,
        accountLabel: account,
        exchange: "binance",
        pair: TEST_PAIR,
        capitalAsset: "USDT",
        allocatedCapital: "500",
        strategy: "dca",
        params: dcaParamsJson,
      },
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("insufficient_capital");
  });

  it("refuses to liquidate a RUNNING bot, reusing the existing rejection (409)", async () => {
    const account = `acct-${suffix}`;
    await seedBalance(account);
    const id = `r${suffix}`;
    await createDcaBot(id, account);
    await inBotId(id, (bot) => bot.start(HUMAN)); // now running

    const res = await api("POST", `/api/bots/${id}/liquidate`);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("invalid_status");
  });

  it("liquidates a halted bot holding a position through the unified path", async () => {
    const account = `acct-${suffix}`;
    await seedBalance(account);
    const id = `l${suffix}`;
    await createDcaBot(id, account);
    await inBotId(id, (bot) => bot.start(HUMAN));
    // Place and fill the base order so a real position is held.
    await inBotId(id, (bot) => bot.onPriceUpdate({ pair: TEST_PAIR, price: m("100"), at: clock }));
    const base = exchange.placed[0]!.clientOrderId;
    await inBotId(id, (bot) => bot.onFill(base, exchange.fillFor(base)));
    await inBotId(id, (bot) => bot.halt("manual", "operator review", HUMAN));

    exchange.currentPrice = m("100");
    const res = await api("POST", `/api/bots/${id}/liquidate`);
    expect(res.status).toBe(200);
    expect(res.body.data.result).toMatchObject({ status: "halted", action: "liquidating" });
    // A sell was placed and the human actor is on the audit entry.
    expect(exchange.placed.some((o) => o.side === "sell")).toBe(true);
    const audit = await db.auditLog.findMany({ where: { action: "bot.liquidated" } });
    expect(audit[0]!.actor).toBe(HUMAN);
  });
});

// ---------------------------------------------------------------------------
// Alerts (endpoint 5)
// ---------------------------------------------------------------------------

describe("alerts", () => {
  beforeEach(async () => {
    await db.alerts.insert(alertRow({ id: `al1-${suffix}`, category: "trading", severity: "critical", resolved: false, created_at: T0 + 1 }));
    await db.alerts.insert(alertRow({ id: `al2-${suffix}`, category: "system", severity: "warning", resolved: true, created_at: T0 + 2 }));
    await db.alerts.insert(alertRow({ id: `al3-${suffix}`, category: "trading", severity: "info", resolved: false, created_at: T0 + 3 }));
  });

  it("lists all alerts newest-first", async () => {
    const res = await api("GET", "/api/alerts");
    expect(res.status).toBe(200);
    expect(res.body.data.map((a: any) => a.id)).toEqual([`al3-${suffix}`, `al2-${suffix}`, `al1-${suffix}`]);
  });

  it("filters by category, severity and resolved", async () => {
    expect((await api("GET", "/api/alerts?category=system")).body.data).toHaveLength(1);
    expect((await api("GET", "/api/alerts?severity=critical")).body.data).toHaveLength(1);
    expect((await api("GET", "/api/alerts?resolved=false")).body.data.map((a: any) => a.id).sort()).toEqual(
      [`al1-${suffix}`, `al3-${suffix}`].sort(),
    );
  });

  it("400s an unknown filter value", async () => {
    const res = await api("GET", "/api/alerts?severity=nope");
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("invalid_filter");
  });
});

// ---------------------------------------------------------------------------
// Manual adjustments (endpoint 6)
// ---------------------------------------------------------------------------

describe("manual adjustments", () => {
  it("logs an adjustment and audits the actor (201)", async () => {
    const account = `acct-${suffix}`;
    const res = await api("POST", "/api/manual-adjustments", {
      body: { accountLabel: account, asset: "USDT", amount: "-200.5", note: "moved to cold storage" },
    });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ accountLabel: account, asset: "USDT", amount: "-200.50000000" });

    const rows = await db.manualAdjustments.findMany({ where: { account_label: account } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.amount).toBe(m("-200.5"));
    expect(rows[0]!.reconciled_at).toBeNull();

    const audit = await db.auditLog.findMany({ where: { action: "manual_adjustment.logged" } });
    expect(audit[0]!.actor).toBe(HUMAN);
  });

  it("400s a missing note", async () => {
    const res = await api("POST", "/api/manual-adjustments", {
      body: { accountLabel: `acct-${suffix}`, asset: "USDT", amount: "10" },
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("missing_field");
  });
});

// ---------------------------------------------------------------------------
// Circuit breakers (endpoints 7-8)
// ---------------------------------------------------------------------------

describe("circuit breakers", () => {
  it("reports armed by default and tripped after a trip", async () => {
    const account = `acct-${suffix}`;
    await seedBalance(account);

    let res = await api("GET", "/api/circuit-breakers");
    expect(res.body.data.find((b: any) => b.accountLabel === account)).toMatchObject({ state: "armed" });

    await tripAccountCircuitBreaker(db, {
      accountLabel: account,
      reason: "severe drift",
      runId: null,
      actor: "reconciliation",
      now: T0,
      haltBot: async () => undefined,
      newId: () => `cb-${(idCounter += 1)}`,
    });

    res = await api("GET", "/api/circuit-breakers");
    expect(res.body.data.find((b: any) => b.accountLabel === account)).toMatchObject({
      state: "tripped",
      reason: "severe drift",
    });
  });

  it("resets a tripped breaker (human-only) and re-arms it", async () => {
    const account = `acct-${suffix}`;
    await tripAccountCircuitBreaker(db, {
      accountLabel: account,
      reason: "severe drift",
      runId: null,
      actor: "reconciliation",
      now: T0,
      haltBot: async () => undefined,
      newId: () => `cb-${(idCounter += 1)}`,
    });

    const res = await api("POST", `/api/circuit-breakers/${account}/reset`, {
      body: { note: "investigated, keys rotated" },
    });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ accountLabel: account, state: "armed", resetBy: HUMAN });
  });

  it("409s a reset of an un-tripped breaker", async () => {
    const res = await api("POST", `/api/circuit-breakers/acct-${suffix}/reset`, {
      body: { note: "nothing to do" },
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("not_tripped");
  });
});

// ---------------------------------------------------------------------------
// Global kill switch (endpoints 9-11)
// ---------------------------------------------------------------------------

describe("global kill switch", () => {
  it("is armed by default", async () => {
    const res = await api("GET", "/api/kill-switch");
    expect(res.status).toBe(200);
    expect(res.body.data.state).toBe("armed");
  });

  it("trips, halting active bots on every account, then reads tripped, then resets", async () => {
    const account = `acct-${suffix}`;
    await seedBalance(account);
    const id = `k${suffix}`;
    await createDcaBot(id, account);
    await inBotId(id, (bot) => bot.start(HUMAN)); // running -> will be halted

    const trip = await api("POST", "/api/kill-switch/trigger", {
      body: { reason: "genuine emergency" },
    });
    expect(trip.status).toBe(200);
    expect(trip.body.data.result.haltedBotIds).toContain(id);
    expect(trip.body.data.killSwitch.state).toBe("tripped");
    expect(await isGloballyTripped(db)).toBe(true);

    const status = await api("GET", "/api/kill-switch");
    expect(status.body.data).toMatchObject({ state: "tripped", trippedBy: HUMAN });

    const reset = await api("POST", "/api/kill-switch/reset", { body: { note: "resolved" } });
    expect(reset.status).toBe(200);
    expect(reset.body.data.state).toBe("armed");
    expect(await isGloballyTripped(db)).toBe(false);
  });

  it("400s a trigger with no reason", async () => {
    const res = await api("POST", "/api/kill-switch/trigger", { body: {} });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("missing_field");
  });

  it("409s a reset when not tripped", async () => {
    const res = await api("POST", "/api/kill-switch/reset", { body: { note: "n" } });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("not_tripped");
  });
});

// ---------------------------------------------------------------------------
// Reconciliation (endpoint 12)
// ---------------------------------------------------------------------------

describe("reconciliation", () => {
  it("lists recent runs with their findings and classifications", async () => {
    // A reconciliation run records itself as an audit_log entry.
    await db.auditLog.insert({
      id: `rec-${suffix}`,
      actor: "reconciliation",
      action: "reconciliation.run",
      target_bot_instance_id: null,
      details_json: {
        run_id: `run-${suffix}`,
        account_label: `acct-${suffix}`,
        tier: "meaningful",
        findings: [{ kind: "balance_drift", tier: "meaningful", detail: "20 USDT unexplained" }],
        halted: [`b-${suffix}`],
        circuit_breaker_tripped: false,
        skipped: [],
      },
      created_at: T0 + 5,
    });

    const res = await api("GET", "/api/reconciliation");
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0]).toMatchObject({
      id: `rec-${suffix}`,
      actor: "reconciliation",
      details: { tier: "meaningful", run_id: `run-${suffix}` },
    });
  });
});
