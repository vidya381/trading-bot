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
import { isGloballyTripped, tripGlobalKillSwitch } from "../reconciliation/kill-switch";
import type { DcaParams } from "../strategies/dca";
import type { GridParams } from "../strategies/grid";
import { fromDecimalString as m, toDecimalString } from "../shared/money";
import type { Jwks } from "./access";
import { handleApiRequest } from "./index";
import { generateSigningKey, signAccessJwt, type SigningKey } from "./test-helpers";
import type { SymbolLister } from "../workers/symbols";

const T0 = 1_900_000_000_000; // future: an armed alarm must not already be overdue (step 20)
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
  /** Inject the symbols endpoint's lister so no live exchange call is made. */
  readonly symbolLister?: SymbolLister;
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
    ...(call.symbolLister !== undefined ? { symbolLister: call.symbolLister } : {}),
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

  it("starts a created bot, moving it to running and auditing the human actor", async () => {
    const account = `acct-${suffix}`;
    await seedBalance(account);
    const id = `s${suffix}`;
    await createDcaBot(id, account);

    const res = await api("POST", `/api/bots/${id}/start`);
    expect(res.status).toBe(200);
    expect(res.body.data.result).toMatchObject({ status: "running", action: "started" });
    // The refreshed bot in the response already shows the new status.
    expect(res.body.data.bot).toMatchObject({ id, status: "running" });
    // start places no order in this call -- it subscribes and moves status; the
    // order comes on the next price update, so nothing hit the exchange here.
    expect(exchange.placed).toEqual([]);
    // The D1 row was mirrored and the start audited to the verified human actor.
    const row = await db.botInstances.findOne({ id });
    expect(row!.status).toBe("running");
    const audit = await db.auditLog.findMany({ where: { action: "bot.started" } });
    expect(audit[0]!.actor).toBe(HUMAN);
  });

  it("refuses to start a bot that is not created, surfacing invalid_status (409)", async () => {
    const account = `acct-${suffix}`;
    await seedBalance(account);
    const id = `sr${suffix}`;
    await createDcaBot(id, account);
    await inBotId(id, (bot) => bot.start(HUMAN)); // already running

    const res = await api("POST", `/api/bots/${id}/start`);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("invalid_status");
  });

  /**
   * `BotInstance.halt` has thorough tests of its own (bot-instance.test.ts: the
   * order of marking vs cancelling, idempotence, the stopped-bot refusal). These
   * are the ENDPOINT's, and the fact each one exists to pin is that a HUMAN can
   * now reach that path for ONE bot -- previously only the kill switch (all bots)
   * and reconciliation (automated) could.
   */
  it("halts a running bot, recording the operator's reason and the human actor", async () => {
    const account = `acct-${suffix}`;
    await seedBalance(account);
    const id = `h${suffix}`;
    await createDcaBot(id, account);
    await inBotId(id, (bot) => bot.start(HUMAN));

    const res = await api("POST", `/api/bots/${id}/halt`, {
      body: { reason: "spread looks wrong, stopping to look" },
    });
    expect(res.status).toBe(200);
    expect(res.body.data.result).toMatchObject({ status: "halted", action: "halted" });
    // The refreshed bot already shows the halt, so no second fetch is needed.
    expect(res.body.data.bot).toMatchObject({ id, status: "halted" });
    expect(res.body.data.bot.haltReason).toContain("spread looks wrong");

    // Mirrored to D1 as `manual: <reason>` -- the enum, then the operator's text.
    const row = await db.botInstances.findOne({ id });
    expect(row!.status).toBe("halted");
    expect(row!.halt_reason).toBe("manual: spread looks wrong, stopping to look");
    expect(row!.halted_at).toBe(clock);

    // The audit actor is the VERIFIED email, not "kill-switch" or
    // "reconciliation" -- the whole point of exposing this at the API layer.
    const audit = await db.auditLog.findMany({ where: { action: "bot.halted" } });
    expect(audit[0]!.actor).toBe(HUMAN);
    expect(audit[0]!.details_json).toMatchObject({ reason: "manual" });
  });

  it("requires a reason (400)", async () => {
    const account = `acct-${suffix}`;
    await seedBalance(account);
    const id = `hnr${suffix}`;
    await createDcaBot(id, account);
    await inBotId(id, (bot) => bot.start(HUMAN));

    const res = await api("POST", `/api/bots/${id}/halt`, { body: {} });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("missing_field");
    // Refused before anything happened: the bot is untouched.
    const row = await db.botInstances.findOne({ id });
    expect(row!.status).toBe("running");
  });

  /**
   * A double-click must not be a failure, and must not overwrite the first
   * halt's reason. This is `#halt`'s existing idempotence, over the wire.
   */
  it("is idempotent: halting an already-halted bot succeeds and changes nothing", async () => {
    const account = `acct-${suffix}`;
    await seedBalance(account);
    const id = `hh${suffix}`;
    await createDcaBot(id, account);
    await inBotId(id, (bot) => bot.start(HUMAN));

    const first = await api("POST", `/api/bots/${id}/halt`, { body: { reason: "first" } });
    expect(first.status).toBe(200);
    const second = await api("POST", `/api/bots/${id}/halt`, { body: { reason: "second" } });
    expect(second.status).toBe(200);
    expect(second.body.data.result).toMatchObject({ status: "halted", action: "already_halted" });

    const row = await db.botInstances.findOne({ id });
    expect(row!.halt_reason).toBe("manual: first");
  });

  /**
   * The composition this endpoint unblocks. `liquidate` refuses a running bot and
   * tells the caller to halt it first; before this endpoint existed, a caller
   * following that instruction had nowhere to go short of the global kill switch.
   */
  it("makes a running bot liquidatable, which is what the refusal tells you to do", async () => {
    const account = `acct-${suffix}`;
    await seedBalance(account);
    const id = `hl${suffix}`;
    await createDcaBot(id, account);
    await inBotId(id, (bot) => bot.start(HUMAN));
    await inBotId(id, (bot) => bot.onPriceUpdate({ pair: TEST_PAIR, price: m("100"), at: clock }));
    const base = exchange.placed[0]!.clientOrderId;
    await inBotId(id, (bot) => bot.onFill(base, exchange.fillFor(base)));

    const refused = await api("POST", `/api/bots/${id}/liquidate`);
    expect(refused.status).toBe(409);

    const halted = await api("POST", `/api/bots/${id}/halt`, { body: { reason: "closing out" } });
    expect(halted.status).toBe(200);

    exchange.currentPrice = m("100");
    const res = await api("POST", `/api/bots/${id}/liquidate`);
    expect(res.status).toBe(200);
    expect(res.body.data.result).toMatchObject({ status: "halted", action: "liquidating" });
  });

  /**
   * A halt is risk-REDUCING, so unlike `resume` it asserts neither latch. A
   * pulled kill switch must not block stopping a bot it somehow left running.
   */
  it("halts even while the global kill switch is pulled", async () => {
    const account = `acct-${suffix}`;
    await seedBalance(account);
    const id = `hks${suffix}`;
    await createDcaBot(id, account);
    await inBotId(id, (bot) => bot.start(HUMAN));
    // Latch the switch WITHOUT its sweep, the same way the resume test above
    // trips the account breaker: a real trip halts every running bot itself, so
    // it cannot produce the state under test. This is the bot the sweep failed to
    // reach (`failures`, section 7.4) -- still running, switch still pulled.
    await tripGlobalKillSwitch(db, {
      reason: "genuine emergency",
      actor: HUMAN,
      now: T0,
      haltBot: async () => undefined,
      newId: () => `ks-${(idCounter += 1)}`,
    });

    const res = await api("POST", `/api/bots/${id}/halt`, { body: { reason: "missed by the sweep" } });
    expect(res.status).toBe(200);
    expect(res.body.data.result).toMatchObject({ status: "halted", action: "halted" });
  });

  it("404s a halt on a bot that was never created", async () => {
    const res = await api("POST", `/api/bots/nosuch-${suffix}/halt`, { body: { reason: "x" } });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("not_created");
  });

  it("resumes a halted bot, clearing its halt reason and auditing the human actor", async () => {
    const account = `acct-${suffix}`;
    await seedBalance(account);
    const id = `rs${suffix}`;
    await createDcaBot(id, account);
    await inBotId(id, (bot) => bot.start(HUMAN));
    await inBotId(id, (bot) =>
      bot.halt("order_rejected", "exchange refused the order", HUMAN),
    );

    const res = await api("POST", `/api/bots/${id}/resume`);
    expect(res.status).toBe(200);
    expect(res.body.data.result).toMatchObject({ status: "running", action: "resumed" });
    // The refreshed bot in the response shows the new status AND a cleared
    // reason. This assertion was inverted before: resume used to keep the
    // reason, so the detail view showed a running bot still advertising the
    // failure it had already recovered from. The history lives in the audit
    // entry below, which is where a past event belongs.
    expect(res.body.data.bot).toMatchObject({ id, status: "running" });
    expect(res.body.data.bot.haltReason).toBeNull();
    // Resume places no order in this call, exactly like start: it re-subscribes
    // and moves the status; the order attempt comes on the next price update.
    expect(exchange.placed.filter((o) => o.side === "sell")).toEqual([]);
    const row = await db.botInstances.findOne({ id });
    expect(row!.status).toBe("running");
    expect(row!.halt_reason).toBeNull();
    expect(row!.halted_at).toBeNull();
    const audit = await db.auditLog.findMany({ where: { action: "bot.resumed" } });
    expect(audit[0]!.actor).toBe(HUMAN);
    expect(String((audit[0]!.details_json as unknown as Record<string, unknown>)["previous_halt_reason"]))
      .toContain("order_rejected");
  });

  it("refuses to resume a bot that is not halted, surfacing invalid_status (409)", async () => {
    const account = `acct-${suffix}`;
    await seedBalance(account);
    const id = `rr${suffix}`;
    await createDcaBot(id, account); // still `created`, never halted

    const res = await api("POST", `/api/bots/${id}/resume`);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("invalid_status");
  });

  /**
   * Resume asserts BOTH risk latches and `start` asserts neither, so these two
   * are the endpoint's genuinely distinct failures. Each also proves the refusal
   * happens BEFORE the status flip: the bot must still be halted afterwards, or
   * the latch would last exactly as long as it takes someone to click resume
   * (sections 7.3 step 7, 7.4).
   */
  it("refuses to resume while this account's circuit breaker is tripped (409)", async () => {
    const account = `acct-${suffix}`;
    await seedBalance(account);
    const id = `rcb${suffix}`;
    await createDcaBot(id, account);
    await inBotId(id, (bot) => bot.start(HUMAN));
    await inBotId(id, (bot) => bot.halt("manual", "operator review", HUMAN));
    await tripAccountCircuitBreaker(db, {
      accountLabel: account,
      reason: "severe drift",
      runId: null,
      actor: "reconciliation",
      now: T0,
      haltBot: async () => undefined,
      newId: () => `cb-${(idCounter += 1)}`,
    });

    const res = await api("POST", `/api/bots/${id}/resume`);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("account_tripped");
    // Nothing changed: the bot is still halted.
    const row = await db.botInstances.findOne({ id });
    expect(row!.status).toBe("halted");
  });

  it("refuses to resume while the global kill switch is pulled (409)", async () => {
    const account = `acct-${suffix}`;
    await seedBalance(account);
    const id = `rks${suffix}`;
    await createDcaBot(id, account);
    await inBotId(id, (bot) => bot.start(HUMAN));
    // The pull halts the bot itself, which is the realistic path to this state.
    const trip = await api("POST", "/api/kill-switch/trigger", {
      body: { reason: "genuine emergency" },
    });
    expect(trip.body.data.result.haltedBotIds).toContain(id);

    const res = await api("POST", `/api/bots/${id}/resume`);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("globally_tripped");
    const row = await db.botInstances.findOne({ id });
    expect(row!.status).toBe("halted");

    // And after a human re-arms the switch, the same request succeeds -- proof
    // the refusal was the latch and not a permanent block on the bot.
    await api("POST", "/api/kill-switch/reset", { body: { note: "resolved" } });
    const after = await api("POST", `/api/bots/${id}/resume`);
    expect(after.status).toBe(200);
    expect(after.body.data.result).toMatchObject({ status: "running", action: "resumed" });
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
// Apply missed fills (step 18's repair) -- the endpoint, over the wire
//
// `BotInstance.applyMissedFills` has its own tests (bot-instance.test.ts,
// grid-bot-instance.test.ts). These are the ENDPOINT's, added with its dashboard
// control: every one of them asserts a fact the UI states to an operator, so a
// backend change that made the copy a lie would fail here rather than silently
// on screen.
// ---------------------------------------------------------------------------

describe("apply missed fills", () => {
  /**
   * A halted DCA bot with one order it still believes open -- the shape of the
   * 2026-07-31 incident. The cancellation is forced to fail exactly as it did
   * live, so the order stays believed-open rather than being recorded cancelled.
   */
  async function haltedWithRestingOrder(id: string, account: string): Promise<string> {
    await seedBalance(account);
    await createDcaBot(id, account);
    await inBotId(id, (bot) => bot.start(HUMAN));
    await inBotId(id, (bot) => bot.onPriceUpdate({ pair: TEST_PAIR, price: m("100"), at: clock }));
    const clientOrderId = exchange.placed[0]!.clientOrderId;
    exchange.nextCancelFailure = { kind: "exchange_error", message: "could not read response" };
    await inBotId(id, (bot) => bot.halt("manual", "reconciliation found drift", HUMAN));
    return clientOrderId;
  }

  it("returns exactly what it corrected, leaves the bot halted, and audits the human", async () => {
    const account = `acct-${suffix}`;
    const id = `amf${suffix}`;
    const clientOrderId = await haltedWithRestingOrder(id, account);
    const resting = exchange.resting.get(clientOrderId)!.request;
    exchange.fillsByOrder.set(clientOrderId, [
      {
        // The exchange's OWN id, as `include_trades` reports it. Never synthesised.
        fillId: "gemini-tid-4242",
        price: resting.price,
        quantity: resting.quantity,
        feeAmount: 0n,
        feeAsset: "USDT",
        executedAt: clock + 1000,
      },
    ]);

    const res = await api("POST", `/api/bots/${id}/apply-missed-fills`);

    expect(res.status).toBe(200);
    // The dashboard renders these four fields per applied fill, and the two
    // money fields as decimal strings -- not numbers.
    expect(res.body.data.result.applied).toEqual([
      {
        clientOrderId,
        fillId: "gemini-tid-4242",
        quantity: toDecimalString(resting.quantity),
        price: toDecimalString(resting.price),
      },
    ]);
    expect(res.body.data.result.skipped).toEqual([]);
    // It never resumes: halted before, halted after, in the result AND the
    // refreshed bot the response carries.
    expect(res.body.data.result.status).toBe("halted");
    expect(res.body.data.bot).toMatchObject({ id, status: "halted" });

    // The books actually moved: the order is filled and the trade row exists.
    const row = await db.orders.findOne({ client_order_id: clientOrderId });
    expect(row!.status).toBe("filled");
    expect(await db.trades.count({ bot_instance_id: id })).toBe(1);

    // And the actor is the verified human, not "cron" -- the reason this is an
    // Access-gated endpoint rather than part of reconciliation.
    const audit = await db.auditLog.findMany({ where: { action: "bot.missed_fills_applied" } });
    expect(audit).toHaveLength(1);
    expect(audit[0]!.actor).toBe(HUMAN);
  });

  it("refuses on a bot that is not halted, surfacing invalid_status (409)", async () => {
    // The refusal the dashboard mirrors BEFORE sending: a repair must not race
    // the bot's own pipeline.
    const account = `acct-${suffix}`;
    await seedBalance(account);
    const id = `amfr${suffix}`;
    await createDcaBot(id, account);
    await inBotId(id, (bot) => bot.start(HUMAN)); // running

    const res = await api("POST", `/api/bots/${id}/apply-missed-fills`);

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("invalid_status");
    expect(await db.trades.count({ bot_instance_id: id })).toBe(0);
  });

  it("reports an unreadable order in `skipped` as a 200 -- a success is not a repair", async () => {
    // The distinction the UI must not flatten: this is HTTP 200 with nothing
    // applied. A frontend that only awaited success would call it done.
    const account = `acct-${suffix}`;
    const id = `amfu${suffix}`;
    await haltedWithRestingOrder(id, account);
    exchange.orderStatusFailure = { kind: "transport", message: "connection reset" };

    const res = await api("POST", `/api/bots/${id}/apply-missed-fills`);

    expect(res.status).toBe(200);
    expect(res.body.data.result.applied).toEqual([]);
    expect(res.body.data.result.skipped.join(" ")).toContain("connection reset");
    expect(await db.trades.count({ bot_instance_id: id })).toBe(0);
  });

  it("distinguishes 'no per-fill detail reported' from 'nothing filled'", async () => {
    // The venue answered, but carried no `trades`. There is no real fill id to
    // apply, so the order is reported as UNREAD rather than treated as unfilled.
    const account = `acct-${suffix}`;
    const id = `amfn${suffix}`;
    await haltedWithRestingOrder(id, account);

    const res = await api("POST", `/api/bots/${id}/apply-missed-fills`);

    expect(res.status).toBe(200);
    expect(res.body.data.result.applied).toEqual([]);
    expect(res.body.data.result.skipped.join(" ")).toContain("no per-fill detail");
  });

  it("is idempotent over the wire: a second call applies nothing and double-counts nothing", async () => {
    // The dashboard's "outcome unknown -- retrying is safe" copy is a claim about
    // this. It holds because `applyFill` deduplicates on the exchange's fill id.
    const account = `acct-${suffix}`;
    const id = `amfi${suffix}`;
    const clientOrderId = await haltedWithRestingOrder(id, account);
    exchange.fillsByOrder.set(clientOrderId, [
      exchange.fillFor(clientOrderId, { fillId: "gemini-tid-9" }),
    ]);

    const first = await api("POST", `/api/bots/${id}/apply-missed-fills`);
    const second = await api("POST", `/api/bots/${id}/apply-missed-fills`);

    expect(first.body.data.result.applied).toHaveLength(1);
    expect(second.status).toBe(200);
    expect(second.body.data.result.applied).toEqual([]);
    expect(await db.trades.count({ bot_instance_id: id })).toBe(1);
  });

  it("on a GRID bot, records the fill and places NO replacement order", async () => {
    // The claim the grid confirmation dialog makes, asserted through the real
    // endpoint: the paired sell a normal fill would have placed is suppressed,
    // because placing a live order from a correction path on a halted bot would
    // be resuming trading through the back door.
    const account = `acct-${suffix}`;
    await seedBalance(account);
    const id = `amfg${suffix}`;
    await inBotId(id, (bot) =>
      bot.createGrid({
        botInstanceId: id,
        accountLabel: account,
        exchange: "binance",
        pair: TEST_PAIR,
        capitalAsset: "USDT",
        allocatedCapital: m("500"),
        params: gridParams,
        actor: HUMAN,
      }),
    );
    await inBotId(id, (bot) => bot.start(HUMAN));
    await inBotId(id, (bot) => bot.onPriceUpdate({ pair: TEST_PAIR, price: m("100"), at: clock }));
    const buy = exchange.placed.find((order) => order.side === "buy")!.clientOrderId;
    // Every cancellation fails, as it did live, so the ladder stays intact.
    exchange.cancelFailure = { kind: "exchange_error", message: "could not read response" };
    await inBotId(id, (bot) => bot.halt("manual", "reconciliation found drift", HUMAN));

    const placedBefore = exchange.placed.length;
    exchange.fillsByOrder.set(buy, [exchange.fillFor(buy, { fillId: "gemini-tid-500" })]);

    const res = await api("POST", `/api/bots/${id}/apply-missed-fills`);

    expect(res.status).toBe(200);
    expect(res.body.data.result.applied).toHaveLength(1);
    expect(res.body.data.result.applied[0].fillId).toBe("gemini-tid-500");
    // Nothing new reached the exchange -- the ladder comes back a rung short.
    expect(exchange.placed).toHaveLength(placedBefore);
    expect(res.body.data.result.status).toBe("halted");
  });
});

// ---------------------------------------------------------------------------
// Check open orders (step 22): the manual observation pass
// ---------------------------------------------------------------------------

describe("check open orders", () => {
  /** A RUNNING bot with one resting, unfilled base order. */
  async function runningWithRestingOrder(id: string, account: string): Promise<string> {
    await seedBalance(account);
    await createDcaBot(id, account);
    await inBotId(id, (bot) => bot.start(HUMAN));
    await inBotId(id, (bot) => bot.onPriceUpdate({ pair: TEST_PAIR, price: m("100"), at: clock }));
    return exchange.placed[0]!.clientOrderId;
  }

  it("folds a resting fill on a RUNNING bot and audits the verified human", async () => {
    // The difference from `apply-missed-fills` that matters most: this one's
    // NORMAL case is a running bot. The repair refuses anything but halted.
    const account = `acct-${suffix}`;
    const id = `coc${suffix}`;
    const clientOrderId = await runningWithRestingOrder(id, account);
    const resting = exchange.resting.get(clientOrderId)!.request;
    exchange.fillsByOrder.set(clientOrderId, [
      {
        fillId: "gemini-tid-7788",
        price: resting.price,
        quantity: resting.quantity,
        feeAmount: 0n,
        feeAsset: "USDT",
        executedAt: clock + 1000,
      },
    ]);

    const res = await api("POST", `/api/bots/${id}/check-open-orders`);

    expect(res.status).toBe(200);
    expect(res.body.data.result.status).toBe("running");
    expect(res.body.data.result.applied).toEqual([
      {
        clientOrderId,
        fillId: "gemini-tid-7788",
        quantity: toDecimalString(resting.quantity),
        price: toDecimalString(resting.price),
      },
    ]);
    expect(res.body.data.result.skipped).toEqual([]);
    expect(res.body.data.result.closed).toEqual([]);
    // The field three empty arrays cannot otherwise be distinguished from.
    expect(res.body.data.result.deferred).toBe(false);
    expect(res.body.data.bot).toMatchObject({ id, status: "running" });

    // The books really moved, through the ordinary live path.
    const row = await db.orders.findOne({ client_order_id: clientOrderId });
    expect(row!.status).toBe("filled");
    expect(await db.trades.count({ bot_instance_id: id })).toBe(1);

    // A real person, not "system" -- the whole reason this is Access-gated
    // rather than only an alarm.
    const audit = await db.auditLog.findMany({ where: { action: "bot.open_orders_checked" } });
    expect(audit).toHaveLength(1);
    expect(audit[0]!.actor).toBe(HUMAN);
  });

  it("is allowed on a HALTED bot and places nothing", async () => {
    // Step 19: observing a halted bot is safe and useful, because a halt whose
    // cancellation failed leaves live orders on the exchange while a human is
    // deciding about exactly those books.
    const account = `acct-${suffix}`;
    const id = `coch${suffix}`;
    await runningWithRestingOrder(id, account);
    exchange.cancelFailure = { kind: "exchange_error", message: "could not read response" };
    await inBotId(id, (bot) => bot.halt("manual", "reconciliation found drift", HUMAN));
    exchange.cancelFailure = null;
    const placedBefore = exchange.placed.length;

    const res = await api("POST", `/api/bots/${id}/check-open-orders`);

    expect(res.status).toBe(200);
    expect(res.body.data.result.status).toBe("halted");
    expect(exchange.placed).toHaveLength(placedBefore);
  });

  it("refuses a STOPPED bot with invalid_status (409)", async () => {
    // Its capital is released, so a pass would be work whose result nothing may
    // use. This is the refusal the dashboard mirrors before sending.
    const account = `acct-${suffix}`;
    const id = `cocs${suffix}`;
    await runningWithRestingOrder(id, account);
    await inBotId(id, (bot) => bot.close(HUMAN));

    const res = await api("POST", `/api/bots/${id}/check-open-orders`);

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("invalid_status");
  });

  it("reports an unreadable order in `skipped` as a 200 -- a success is not a clean bill of health", async () => {
    const account = `acct-${suffix}`;
    const id = `cocu${suffix}`;
    await runningWithRestingOrder(id, account);
    exchange.orderStatusFailure = { kind: "transport", message: "connection reset" };

    const res = await api("POST", `/api/bots/${id}/check-open-orders`);

    expect(res.status).toBe(200);
    expect(res.body.data.result.applied).toEqual([]);
    expect(res.body.data.result.skipped.join(" ")).toContain("connection reset");
    expect(await db.trades.count({ bot_instance_id: id })).toBe(0);
  });

  it("surfaces the tick-staleness alert a pass raised, on the bot the operator is looking at", async () => {
    // The end-to-end shape of step 22: the alert is bot-scoped (unlike the
    // feed's own `price_feed_blind`, which carries a null bot id by design), so
    // it reaches the bot's detail payload and the control that answers it.
    const account = `acct-${suffix}`;
    const id = `cocp${suffix}`;
    await runningWithRestingOrder(id, account);
    clock += 600_000;
    exchange.now = clock;

    const res = await api("POST", `/api/bots/${id}/check-open-orders`);
    expect(res.status).toBe(200);

    const detail = await api("GET", `/api/bots/${id}`);
    const stale = detail.body.data.alerts.filter(
      (alert: { alertType: string }) => alert.alertType === "price_updates_stale",
    );
    expect(stale).toHaveLength(1);
    expect(stale[0].resolved).toBe(false);
    expect(stale[0].severity).toBe("warning");
  });

  it("405s on GET, so the wrong method is not a missing endpoint", async () => {
    const res = await api("GET", `/api/bots/whatever/check-open-orders`);
    expect(res.status).toBe(405);
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

describe("accounts (step 11)", () => {
  it("GET /api/accounts lists registered accounts and their exchange, ordered by label", async () => {
    await db.accounts.insert({ account_label: `z-${suffix}`, exchange: "gemini", created_at: T0, updated_at: T0 });
    await db.accounts.insert({ account_label: `a-${suffix}`, exchange: "binance", created_at: T0, updated_at: T0 });

    const res = await api("GET", "/api/accounts");

    expect(res.status).toBe(200);
    const mine = (res.body.data as { accountLabel: string; exchange: string }[]).filter((a) =>
      a.accountLabel.endsWith(`-${suffix}`),
    );
    expect(mine).toEqual([
      { accountLabel: `a-${suffix}`, exchange: "binance", createdAt: T0 },
      { accountLabel: `z-${suffix}`, exchange: "gemini", createdAt: T0 },
    ]);
  });

  it("GET /api/accounts/:label/symbols returns pairs, cached on the second call", async () => {
    const account = `sym-${suffix}`;
    await db.accounts.insert({ account_label: account, exchange: "binance", created_at: T0, updated_at: T0 });

    let calls = 0;
    const symbolLister: SymbolLister = async () => {
      calls += 1;
      return { ok: true, value: ["BTCUSDT", "ETHUSDT"], at: T0 };
    };

    const first = await api("GET", `/api/accounts/${account}/symbols`, { symbolLister });
    expect(first.status).toBe(200);
    expect(first.body.data).toEqual({
      accountLabel: account,
      exchange: "binance",
      pairs: ["BTCUSDT", "ETHUSDT"],
      cached: false,
      fetchedAt: T0,
    });

    const second = await api("GET", `/api/accounts/${account}/symbols`, { symbolLister });
    expect(second.status).toBe(200);
    expect(second.body.data.cached).toBe(true);
    // The second call was served from the KV cache; the exchange was hit once.
    expect(calls).toBe(1);
  });

  it("GET /api/accounts/:label/symbols is 404 for an unregistered account", async () => {
    const res = await api("GET", `/api/accounts/nope-${suffix}/symbols`, {
      symbolLister: async () => ({ ok: true, value: [], at: T0 }),
    });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("unknown_account");
  });

  it("GET /api/accounts/:label/symbols surfaces an exchange failure as 502", async () => {
    const account = `down-${suffix}`;
    await db.accounts.insert({ account_label: account, exchange: "gemini", created_at: T0, updated_at: T0 });

    const res = await api("GET", `/api/accounts/${account}/symbols`, {
      symbolLister: async () => ({
        ok: false,
        kind: "transport",
        message: "exchange unreachable",
        retryable: true,
        at: T0,
      }),
    });
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe("exchange_unavailable");
  });
});

describe("bot creation dispatches exchange from the account registry (step 11)", () => {
  async function createBotBody(account: string, id: string, exchange?: string) {
    const body: Record<string, unknown> = {
      botInstanceId: id,
      accountLabel: account,
      pair: TEST_PAIR,
      capitalAsset: "USDT",
      allocatedCapital: "500",
      strategy: "dca",
      params: dcaParamsJson,
    };
    if (exchange !== undefined) body.exchange = exchange;
    return api("POST", "/api/bots", { body });
  }

  it("derives the exchange from the registry when the account is registered, body exchange omitted", async () => {
    const account = `reg-${suffix}`;
    await seedBalance(account);
    await db.accounts.insert({ account_label: account, exchange: "gemini", created_at: T0, updated_at: T0 });

    const res = await createBotBody(account, `rb-${suffix}`);
    expect(res.status).toBe(201);

    const row = await db.botInstances.findOne({ id: `rb-${suffix}` });
    expect(row!.exchange).toBe("gemini");
  });

  it("rejects a body exchange that disagrees with the registry (400)", async () => {
    const account = `mis-${suffix}`;
    await seedBalance(account);
    await db.accounts.insert({ account_label: account, exchange: "gemini", created_at: T0, updated_at: T0 });

    const res = await createBotBody(account, `mb-${suffix}`, "binance");
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("exchange_mismatch");
  });

  it("soft-falls back to the body exchange for an unregistered account", async () => {
    const account = `unreg-${suffix}`;
    await seedBalance(account);

    const res = await createBotBody(account, `ub-${suffix}`, "binance");
    expect(res.status).toBe(201);
    const row = await db.botInstances.findOne({ id: `ub-${suffix}` });
    expect(row!.exchange).toBe("binance");
  });

  it("rejects an unregistered account with no exchange given (400)", async () => {
    const account = `bare-${suffix}`;
    await seedBalance(account);

    const res = await createBotBody(account, `bb-${suffix}`);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("unregistered_account");
  });

  it("rejects an unknown exchange value on the fallback path (400)", async () => {
    const account = `bad-${suffix}`;
    await seedBalance(account);

    const res = await createBotBody(account, `xb-${suffix}`, "kraken");
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("invalid_exchange");
  });
});
