/**
 * The dashboard API endpoint handlers, build step 10 (backend API layer).
 *
 * EVERY handler is a thin wrapper over functionality that already exists. This
 * layer adds no business logic: a create goes through the Durable Object's
 * `create`/`createGrid` (which already run section 8.5's capital-ledger check
 * and the mandatory stop-loss/take-profit validation); a liquidation calls the
 * unified `liquidatePosition` from step 10.3; a breaker or kill-switch reset
 * calls the same human-only reset the reconciliation and kill-switch modules
 * expose. What is new here is only the HTTP shape and the wiring.
 *
 * The actor for every write is `ctx.actor` -- the email VERIFIED off the Access
 * JWT (see access.ts), not the raw header. Each write returns enough of the new
 * state for the frontend to reflect it without a second fetch, per the brief.
 */

import { ApiError, badRequest, notFound, ok } from "./envelope";
import type { ApiContext } from "./router";
import {
  alertView,
  botDetail,
  botSummary,
  circuitBreakerView,
  killSwitchView,
  manualAdjustmentView,
} from "./serialize";
import type { BotInstance, BotSnapshot } from "../durable-objects/bot-instance";
import type {
  AlertCategory,
  AlertSeverity,
  ManualAdjustmentRow,
} from "../db/schema";
import type { Asset, Pair } from "../shared/exchange-client";
import { fromDecimalString, toDecimalString, type Money } from "../shared/money";
import { resetAccountCircuitBreaker } from "../reconciliation/circuit-breaker";
import { readGlobalKillSwitch } from "../reconciliation/kill-switch";
import {
  resetGlobalKillSwitchFromEnv,
  tripGlobalKillSwitchFromEnv,
} from "../workers/kill-switch";
import {
  DCA_SCHEMA_VERSION,
  decodeDcaParams,
} from "../strategies/dca";
import {
  GRID_SCHEMA_VERSION,
  decodeGridParams,
} from "../strategies/grid";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function botStub(ctx: ApiContext, id: string): DurableObjectStub<BotInstance> {
  return ctx.botNamespace.get(ctx.botNamespace.idFromName(id));
}

/** A bot's own state, or null when its object holds none (the step-6 orphan). */
async function snapshotOf(ctx: ApiContext, id: string): Promise<BotSnapshot | null> {
  return await botStub(ctx, id).snapshotIfCreated();
}

async function readJsonObject(request: Request): Promise<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    throw badRequest("invalid_json", "the request body is not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw badRequest("invalid_body", "the request body must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function requireString(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== "string" || value.trim() === "") {
    throw badRequest("missing_field", `field ${JSON.stringify(field)} must be a non-empty string`);
  }
  return value;
}

function requireObject(body: Record<string, unknown>, field: string): Record<string, unknown> {
  const value = body[field];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw badRequest("missing_field", `field ${JSON.stringify(field)} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

/** Parse a signed decimal money string, or 400. */
function requireMoney(body: Record<string, unknown>, field: string): Money {
  const value = body[field];
  if (typeof value !== "string") {
    throw badRequest("missing_field", `field ${JSON.stringify(field)} must be a decimal string`);
  }
  try {
    return fromDecimalString(value);
  } catch (error) {
    throw badRequest("invalid_amount", `field ${JSON.stringify(field)}: ${(error as Error).message}`);
  }
}

// ---------------------------------------------------------------------------
// Bots
// ---------------------------------------------------------------------------

/**
 * GET /api/bots -- every bot instance across every account (endpoint 1).
 *
 * The D1 row is authoritative for status/strategy/allocation; the live position
 * and realized profit come from each bot's own object. That is one Durable
 * Object read per bot, run in parallel -- the same per-bot fan-out the kill
 * switch and circuit breaker already do, and acceptable at v1's bot count.
 */
export async function listBots(ctx: ApiContext): Promise<Response> {
  const rows = await ctx.db.botInstances.findMany({
    orderBy: [{ column: "created_at", direction: "desc" }],
  });
  const summaries = await Promise.all(
    rows.map(async (row) => botSummary(row, await snapshotOf(ctx, row.id))),
  );
  return ok(summaries);
}

/** GET /api/bots/:id -- full detail for one bot (endpoint 2). */
export async function getBot(ctx: ApiContext): Promise<Response> {
  const id = ctx.params.id!;
  const row = await ctx.db.botInstances.findOne({ id });
  if (row === null) {
    throw notFound("unknown_bot", `no bot instance ${JSON.stringify(id)}`);
  }
  const [snapshot, orders, trades, alerts] = await Promise.all([
    snapshotOf(ctx, id),
    ctx.db.orders.findMany({
      where: { bot_instance_id: id },
      orderBy: [{ column: "created_at", direction: "desc" }],
    }),
    ctx.db.trades.findMany({
      where: { bot_instance_id: id },
      orderBy: [{ column: "executed_at", direction: "desc" }],
    }),
    ctx.db.alerts.findMany({
      where: { bot_instance_id: id },
      orderBy: [{ column: "created_at", direction: "desc" }],
    }),
  ]);
  return ok(botDetail(row, snapshot, orders, trades, alerts));
}

/**
 * POST /api/bots -- create a bot instance (endpoint 3).
 *
 * Discriminated by `strategy`. The strategy params arrive as a JSON object with
 * money as decimal strings -- exactly `decodeDcaParams`/`decodeGridParams`'
 * input, so those own the parsing and per-field validation. The Durable
 * Object's `create`/`createGrid` then run the capital-ledger check and the
 * mandatory stop-loss/take-profit validation (reused, not reimplemented here);
 * an insufficient balance, a missing stop-loss, a tripped breaker or a pulled
 * kill switch all surface as their existing typed errors.
 */
export async function createBot(ctx: ApiContext): Promise<Response> {
  const body = await readJsonObject(ctx.request);

  const botInstanceId = requireString(body, "botInstanceId");
  const accountLabel = requireString(body, "accountLabel");
  const exchange = requireString(body, "exchange");
  const pair = requireString(body, "pair") as Pair;
  const capitalAsset = requireString(body, "capitalAsset") as Asset;
  const allocatedCapital = requireMoney(body, "allocatedCapital");
  const strategy = requireString(body, "strategy");
  const rawParams = requireObject(body, "params");

  const base = {
    botInstanceId,
    accountLabel,
    exchange,
    pair,
    capitalAsset,
    allocatedCapital,
    actor: ctx.actor,
  };
  const stub = botStub(ctx, botInstanceId);

  if (strategy === "dca") {
    const params = decodeDcaParams({ ...rawParams, strategy: "dca", schemaVersion: DCA_SCHEMA_VERSION });
    await stub.create({ ...base, params });
  } else if (strategy === "grid") {
    const params = decodeGridParams({
      // Default the two optional grid fields to null so the frontend may omit
      // them; decodeGridParams still validates everything else.
      breakoutThresholdPct: null,
      takeProfitAmount: null,
      ...rawParams,
      strategy: "grid",
      schemaVersion: GRID_SCHEMA_VERSION,
    });
    await stub.createGrid({ ...base, params });
  } else {
    throw badRequest("invalid_strategy", `strategy must be "dca" or "grid", got ${JSON.stringify(strategy)}`);
  }

  // Return the created bot so the frontend reflects it without a second fetch.
  const row = await ctx.db.botInstances.findOne({ id: botInstanceId });
  const snapshot = await snapshotOf(ctx, botInstanceId);
  return ok(botDetail(row!, snapshot, [], [], []), 201);
}

/**
 * POST /api/bots/:id/liquidate -- the unified human close-out (endpoint 4).
 *
 * Calls `liquidatePosition(actor)` from step 10.3 verbatim. It is valid only on
 * a halted bot and reuses that step's existing rejection for a running one
 * (`invalid_status`, surfaced as 409). Returns the pipeline result and the
 * refreshed bot so the dashboard shows the outcome immediately.
 */
export async function liquidateBot(ctx: ApiContext): Promise<Response> {
  const id = ctx.params.id!;
  const result = await botStub(ctx, id).liquidatePosition(ctx.actor);
  const [row, snapshot] = await Promise.all([
    ctx.db.botInstances.findOne({ id }),
    snapshotOf(ctx, id),
  ]);
  return ok({ result, bot: row === null ? null : botSummary(row, snapshot) });
}

// ---------------------------------------------------------------------------
// Alerts
// ---------------------------------------------------------------------------

const ALERT_CATEGORIES: readonly AlertCategory[] = ["trading", "system"];
const ALERT_SEVERITIES: readonly AlertSeverity[] = ["info", "warning", "critical"];
const DEFAULT_ALERT_LIMIT = 200;

/**
 * GET /api/alerts -- alerts, filterable by category, severity and resolved
 * status (endpoint 5). All three are query parameters; an unrecognised value is
 * a 400 rather than silently ignored.
 */
export async function listAlerts(ctx: ApiContext): Promise<Response> {
  const where: Record<string, unknown> = {};

  const category = ctx.url.searchParams.get("category");
  if (category !== null) {
    if (!ALERT_CATEGORIES.includes(category as AlertCategory)) {
      throw badRequest("invalid_filter", `category must be one of ${ALERT_CATEGORIES.join(", ")}`);
    }
    where.category = category;
  }

  const severity = ctx.url.searchParams.get("severity");
  if (severity !== null) {
    if (!ALERT_SEVERITIES.includes(severity as AlertSeverity)) {
      throw badRequest("invalid_filter", `severity must be one of ${ALERT_SEVERITIES.join(", ")}`);
    }
    where.severity = severity;
  }

  const resolved = ctx.url.searchParams.get("resolved");
  if (resolved !== null) {
    if (resolved !== "true" && resolved !== "false") {
      throw badRequest("invalid_filter", `resolved must be "true" or "false"`);
    }
    where.resolved = resolved === "true";
  }

  const rows = await ctx.db.alerts.findMany({
    where,
    orderBy: [{ column: "created_at", direction: "desc" }],
    limit: DEFAULT_ALERT_LIMIT,
  });
  return ok(rows.map(alertView));
}

// ---------------------------------------------------------------------------
// Manual adjustments
// ---------------------------------------------------------------------------

/**
 * POST /api/manual-adjustments -- log a manual balance change (endpoint 6),
 * the same shape as the `manual_adjustments` table (section 8.6).
 *
 * The amount is signed: a withdrawal is negative. The table has no actor
 * column, so the actor is recorded in a paired `audit_log` entry, keeping the
 * "who logged this" trail every other write in this system carries.
 */
export async function createManualAdjustment(ctx: ApiContext): Promise<Response> {
  const body = await readJsonObject(ctx.request);
  const accountLabel = requireString(body, "accountLabel");
  const asset = requireString(body, "asset");
  const note = requireString(body, "note");
  const amount = requireMoney(body, "amount");

  const now = ctx.now();
  const row: ManualAdjustmentRow = {
    id: ctx.newId(),
    account_label: accountLabel,
    asset,
    amount,
    note,
    reconciled_at: null,
    created_at: now,
  };

  await ctx.db.manualAdjustments.insert(row);
  await ctx.db.auditLog.insert({
    id: ctx.newId(),
    actor: ctx.actor,
    action: "manual_adjustment.logged",
    target_bot_instance_id: null,
    details_json: {
      manual_adjustment_id: row.id,
      account_label: accountLabel,
      asset,
      amount: toDecimalString(amount),
      note,
    },
    created_at: now,
  });

  return ok(manualAdjustmentView(row), 201);
}

// ---------------------------------------------------------------------------
// Circuit breakers (section 7.3)
// ---------------------------------------------------------------------------

/** Every account this system knows about: has bots, or has a ledger row, or has
 *  a breaker row. The union so an account that is only latched still appears. */
async function knownAccounts(ctx: ApiContext, extra: readonly string[] = []): Promise<string[]> {
  const bots = await ctx.db.botInstances.findMany();
  const ledger = await ctx.db.capitalLedger.findMany();
  return [
    ...new Set([
      ...bots.map((bot) => bot.account_label),
      ...ledger.map((row) => row.account_label),
      ...extra,
    ]),
  ].sort();
}

/** GET /api/circuit-breakers -- status per account (endpoint 7). */
export async function listCircuitBreakers(ctx: ApiContext): Promise<Response> {
  const breakers = await ctx.db.circuitBreakers.findMany();
  const byAccount = new Map(breakers.map((row) => [row.account_label, row]));
  const accounts = await knownAccounts(ctx, [...byAccount.keys()]);
  return ok(accounts.map((account) => circuitBreakerView(account, byAccount.get(account) ?? null)));
}

/**
 * POST /api/circuit-breakers/:accountLabel/reset -- human-only re-arm
 * (endpoint 8). Reuses `resetAccountCircuitBreaker`, which refuses an automated
 * actor and requires a note; `ctx.actor` is the verified human email.
 */
export async function resetCircuitBreaker(ctx: ApiContext): Promise<Response> {
  const accountLabel = ctx.params.accountLabel!;
  const body = await readJsonObject(ctx.request);
  const note = requireString(body, "note");

  await resetAccountCircuitBreaker(ctx.db, {
    accountLabel,
    actor: ctx.actor,
    note,
    now: ctx.now(),
    newId: ctx.newId,
  });

  const row = await ctx.db.circuitBreakers.findOne({ account_label: accountLabel });
  return ok(circuitBreakerView(accountLabel, row));
}

// ---------------------------------------------------------------------------
// Global kill switch (section 7.4)
// ---------------------------------------------------------------------------

/** GET /api/kill-switch -- global kill switch status (endpoint 9). */
export async function getKillSwitch(ctx: ApiContext): Promise<Response> {
  const row = await readGlobalKillSwitch(ctx.db);
  return ok(killSwitchView(row));
}

/**
 * POST /api/kill-switch/trigger -- pull the global kill switch (endpoint 10).
 *
 * Goes through `tripGlobalKillSwitchFromEnv`, the seam step 10.3 built for
 * exactly this button: it halts every active bot on every account through each
 * bot's own halt path and latches. Returns which bots were halted (and any it
 * could not reach) plus the new switch state.
 */
export async function triggerKillSwitch(ctx: ApiContext): Promise<Response> {
  const body = await readJsonObject(ctx.request);
  const reason = requireString(body, "reason");

  const outcome = await tripGlobalKillSwitchFromEnv(
    ctx.env,
    { reason, actor: ctx.actor },
    { now: ctx.now, newId: ctx.newId },
  );
  if (!outcome.ran) {
    // No binding or no schema in this environment (e.g. production before
    // go-live). Nothing to halt; surfaced rather than reported as success.
    throw new ApiError(503, "kill_switch_unavailable", outcome.reason);
  }

  const row = await readGlobalKillSwitch(ctx.db);
  return ok({ result: outcome.result, killSwitch: killSwitchView(row) });
}

/**
 * POST /api/kill-switch/reset -- human-only re-arm (endpoint 11). Reuses
 * `resetGlobalKillSwitchFromEnv`; the underlying reset refuses an automated
 * actor and requires a note. Re-arming resumes no bot -- each stays halted
 * until resumed individually (section 7.2 step 5).
 */
export async function resetKillSwitch(ctx: ApiContext): Promise<Response> {
  const body = await readJsonObject(ctx.request);
  const note = requireString(body, "note");

  await resetGlobalKillSwitchFromEnv(
    ctx.env,
    { actor: ctx.actor, note },
    { now: ctx.now, newId: ctx.newId },
  );

  const row = await readGlobalKillSwitch(ctx.db);
  return ok(killSwitchView(row));
}

// ---------------------------------------------------------------------------
// Reconciliation (section 9)
// ---------------------------------------------------------------------------

const DEFAULT_RECONCILIATION_LIMIT = 50;

/**
 * GET /api/reconciliation -- recent reconciliation runs and their
 * findings/classifications (endpoint 12).
 *
 * There is no `reconciliation_runs` table: each run records itself as an
 * `audit_log` entry (`action = "reconciliation.run"`) whose `details_json`
 * already carries the run id, the worst tier, every classified finding, what
 * was halted, whether the breaker tripped, and what was skipped -- all written
 * with `toDecimalString`, so it is already JSON-safe. This reads those entries
 * newest-first. (`balance_snapshots.classification` holds the same per-asset
 * tier for a deeper drill-down, left to a later view.)
 */
export async function listReconciliationRuns(ctx: ApiContext): Promise<Response> {
  const rows = await ctx.db.auditLog.findMany({
    where: { action: "reconciliation.run" },
    orderBy: [{ column: "created_at", direction: "desc" }],
    limit: DEFAULT_RECONCILIATION_LIMIT,
  });
  return ok(
    rows.map((row) => ({
      id: row.id,
      at: row.created_at,
      actor: row.actor,
      details: row.details_json ?? null,
    })),
  );
}
