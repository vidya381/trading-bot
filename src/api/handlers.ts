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
  ExchangeId,
  ManualAdjustmentRow,
} from "../db/schema";
import { EXCHANGE_IDS, isExchangeId } from "../db/schema";
import {
  KvSymbolCacheStore,
  listAccountSymbols,
  type SymbolCacheStore,
} from "../workers/symbols";
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

/** A non-empty string field, or undefined when absent. Rejects a present-but-empty value. */
function optionalString(body: Record<string, unknown>, field: string): string | undefined {
  const value = body[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || value.trim() === "") {
    throw badRequest("invalid_field", `field ${JSON.stringify(field)}, if given, must be a non-empty string`);
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
/**
 * The exchange a new bot will be wired to -- the actual dispatch fix (step 11),
 * deferred from both exchange-integration sessions.
 *
 * Before this, `POST /api/bots` trusted whatever `exchange` string the request
 * body typed and stored it. Now the account registry is authoritative:
 *
 *   - Account IS registered -> its `exchange` is used, full stop. A body value
 *     that disagrees is a client bug, so it is REJECTED rather than silently
 *     overridden -- a bot quietly wired to the wrong venue is exactly the
 *     "looks right, isn't" failure this step exists to remove.
 *   - Account is NOT registered -> soft fallback to the body's `exchange`
 *     (pre-registry behaviour), validated to be a known `ExchangeId`. This is
 *     the "soft-enforce" half: creation still works for an un-backfilled or
 *     not-yet-registered account, so existing bots and tests are undisturbed,
 *     while a registered account becomes authoritative the moment it exists.
 *
 * The returned `ExchangeId` is what selects the client implementation the bot is
 * wired to when order execution runs (via `resolveExchangeForAccount`); until
 * then it is stored on the `bot_instances` row as the authoritative record of
 * which venue this bot belongs to.
 */
async function resolveBotExchange(
  ctx: ApiContext,
  accountLabel: string,
  bodyExchange: string | undefined,
): Promise<ExchangeId> {
  const account = await ctx.db.accounts.findOne({ account_label: accountLabel });
  if (account !== null) {
    if (bodyExchange !== undefined && bodyExchange !== account.exchange) {
      throw badRequest(
        "exchange_mismatch",
        `account ${JSON.stringify(accountLabel)} is registered on ${account.exchange}, ` +
          `not ${JSON.stringify(bodyExchange)}; omit "exchange" or match the registry`,
      );
    }
    return account.exchange;
  }

  if (bodyExchange === undefined) {
    throw badRequest(
      "unregistered_account",
      `account ${JSON.stringify(accountLabel)} is not registered and no "exchange" was given; ` +
        `register the account (see docs/d1-provisioning.md) or supply "exchange"`,
    );
  }
  if (!isExchangeId(bodyExchange)) {
    throw badRequest(
      "invalid_exchange",
      `exchange must be one of ${EXCHANGE_IDS.join(", ")}, got ${JSON.stringify(bodyExchange)}`,
    );
  }
  return bodyExchange;
}

export async function createBot(ctx: ApiContext): Promise<Response> {
  const body = await readJsonObject(ctx.request);

  const botInstanceId = requireString(body, "botInstanceId");
  const accountLabel = requireString(body, "accountLabel");
  const exchange = await resolveBotExchange(ctx, accountLabel, optionalString(body, "exchange"));
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
 * POST /api/bots/:id/start -- the explicit start (spec 6.2/6.3 step 2).
 *
 * Calls `BotInstance.start(actor)` from step 6 verbatim. Deliberately a thin
 * wrapper, the same shape as `liquidateBot`: `start` is the ONLY authority on
 * whether the transition is allowed, and its one refusal -- a bot whose status
 * is not `created` -- is its own `invalid_status`, surfaced here as 409 by the
 * envelope's code map, NOT flattened into a generic failure.
 *
 * WHAT `start` DOES AND DOES NOT DO (confirmed from source, not assumed):
 * `start` subscribes the bot to its `PriceFeed` fail-closed, then moves the
 * status `created -> running`, mirrors it to D1, and audits `bot.started`. It
 * places no order in this call -- the base order (DCA) or the ladder (grid)
 * fires on the next `onPriceUpdate`, because placing needs a price and reading
 * one is an exchange call that can fail (§5.6). Since step 14 that next price is
 * real: the feed is wired and verified live, so this endpoint returning 200 means
 * a real order attempt follows within about a minute. It still cannot return a
 * price-unusable, unreachable-exchange, or order-filter error, but its failures
 * are no longer only `invalid_status` -- a fail-closed feed subscribe can also
 * reject (e.g. `not_attached` with no PRICE_FEED binding), leaving the bot
 * untouched. Returns the pipeline result and the refreshed bot so the new status
 * shows immediately.
 */
export async function startBot(ctx: ApiContext): Promise<Response> {
  const id = ctx.params.id!;
  const result = await botStub(ctx, id).start(ctx.actor);
  const [row, snapshot] = await Promise.all([
    ctx.db.botInstances.findOne({ id }),
    snapshotOf(ctx, id),
  ]);
  return ok({ result, bot: row === null ? null : botSummary(row, snapshot) });
}

/**
 * POST /api/bots/:id/halt -- halt ONE bot, on purpose, right now.
 *
 * Calls `BotInstance.halt("manual", reason, actor)` -- the same public method the
 * kill-switch and reconciliation Workers already call, with the same `"manual"`
 * halt reason, differing only in that the actor is a verified human rather than
 * `"kill-switch"` or `"reconciliation"`. Thin, the same shape as `startBot`,
 * `resumeBot` and `liquidateBot`: `halt` owns every rule.
 *
 * WHY IT EXISTS SEPARATELY FROM THE OTHER TWO HALT PATHS. Section 7.4's kill
 * switch is deliberately all-or-nothing -- "a single dashboard control that halts
 * every bot, on every account" -- and section 9's halts are reactions to drift
 * the system detected. Neither covers a human looking at one misbehaving bot and
 * wanting it stopped, which until now meant either halting everything or waiting
 * for an automated trigger. It is also the precondition the other endpoints
 * assume: `liquidate` and `apply-missed-fills` both refuse a running bot and tell
 * the caller to "halt it first", which was, until this endpoint, not something a
 * caller could actually do.
 *
 * `reason` is the operator's free-text explanation and is REQUIRED. It is stored
 * as `manual: <reason>` in `halt_reason` (the DO composes `${reason}: ${detail}`),
 * so a halted bot always says why it stopped, not just that it did.
 *
 * Failure surface, all from the DO (confirmed from source, not assumed):
 *   - `not_created` (404)    -- the object holds no config.
 *   - `invalid_status` (409) -- the bot is `stopped`; its capital is already
 *     released, so there is nothing to halt.
 * An ALREADY-HALTED bot is NOT an error: `#halt` returns `already_halted` and
 * changes nothing, which is the idempotence the circuit breaker relies on and
 * which makes a double-click here harmless. `created` and `running` both halt.
 *
 * Unlike `resume`, this asserts NEITHER latch. A halt is a risk-reducing action
 * and must stay available while the kill switch is pulled or an account's breaker
 * is tripped.
 */
export async function haltBot(ctx: ApiContext): Promise<Response> {
  const id = ctx.params.id!;
  const body = await readJsonObject(ctx.request);
  const reason = requireString(body, "reason");

  const result = await botStub(ctx, id).halt("manual", reason, ctx.actor);
  const [row, snapshot] = await Promise.all([
    ctx.db.botInstances.findOne({ id }),
    snapshotOf(ctx, id),
  ]);
  return ok({ result, bot: row === null ? null : botSummary(row, snapshot) });
}

/**
 * POST /api/bots/:id/resume -- section 7.2 step 5's explicit human action.
 *
 * Calls `BotInstance.resume(actor)`, designed for exactly this from the first
 * Durable Object session and until now reachable only from a test. Thin, the
 * same shape as `startBot` and `liquidateBot`: `resume` is the ONLY authority on
 * whether the transition is allowed, and each of its typed refusals is surfaced
 * with its own code rather than flattened.
 *
 * ITS FAILURE SURFACE IS WIDER THAN `start`'s (confirmed from source, not
 * assumed by analogy). In order, all BEFORE the status flip, so every one of
 * them leaves the bot halted and untouched:
 *   - `not_created` (404)      -- the object holds no config.
 *   - `invalid_status` (409)   -- the bot is not `halted`. `start`'s mirror.
 *   - `globally_tripped` (409) -- section 7.4's kill switch is pulled. NOT a
 *                                 failure `start` can produce: `resume` calls
 *                                 `assertGlobalArmed`, `start` does not, because
 *                                 resume is the other way a latched account's
 *                                 bot could trade again.
 *   - `account_tripped` (409)  -- section 7.3's breaker for this bot's account.
 *                                 Also unique to resume, same reason.
 *   - `not_attached` (503)     -- no PRICE_FEED binding in this environment.
 *
 * WHAT IT IS *NOT*: an unreachable feed or exchange is NOT a failure here. The
 * fail-closed subscribe reaches `PriceFeed.subscribe`, whose `#ensureConnected`
 * CATCHES a failed connect, schedules a backoff reconnect and returns normally.
 * So a resume with Gemini unreachable returns 200 and the bot enters `running`
 * blind, with the feed's own `price_feed_blind` alert as the signal. No error
 * branch is written for a failure that cannot arrive.
 *
 * `halt_reason` is deliberately NOT cleared by `resume`, so the refreshed bot in
 * the response still carries why it stopped.
 */
export async function resumeBot(ctx: ApiContext): Promise<Response> {
  const id = ctx.params.id!;
  const result = await botStub(ctx, id).resume(ctx.actor);
  const [row, snapshot] = await Promise.all([
    ctx.db.botInstances.findOne({ id }),
    snapshotOf(ctx, id),
  ]);
  return ok({ result, bot: row === null ? null : botSummary(row, snapshot) });
}

/**
 * POST /api/bots/:id/apply-missed-fills -- the order-state-drift repair.
 *
 * Calls `BotInstance.applyMissedFills(actor)`, which owns every rule; this is a
 * thin wrapper in the same shape as `startBot`, `resumeBot` and `liquidateBot`.
 *
 * WHY THIS IS AN ENDPOINT AND NOT PART OF RECONCILIATION. Section 9 halts and
 * alerts on order-state drift and deliberately never auto-corrects it, because
 * correcting means writing trades and moving a position from a belief the system
 * has just proved wrong. That judgement is a human's. Putting it behind an
 * Access-authenticated POST is what makes `ctx.actor` a real person's identity in
 * the audit entry rather than "cron".
 *
 * Failure surface, all from the DO:
 *   - `invalid_status` (409) -- the bot is not halted. The repair is refused on a
 *     live bot so it cannot race the bot's own pipeline.
 *   - `not_attached` (503) -- no exchange client could be built.
 *
 * A 200 does NOT mean everything was repaired: `skipped` carries whatever could
 * not be read or could not be applied, and a caller must look at it. It also does
 * not resume the bot -- the response's `bot` still shows `halted`, and resuming
 * remains a separate, explicit action.
 */
export async function applyMissedFills(ctx: ApiContext): Promise<Response> {
  const id = ctx.params.id!;
  const result = await botStub(ctx, id).applyMissedFills(ctx.actor);
  const [row, snapshot] = await Promise.all([
    ctx.db.botInstances.findOne({ id }),
    snapshotOf(ctx, id),
  ]);
  return ok({ result, bot: row === null ? null : botSummary(row, snapshot) });
}

/**
 * POST /api/bots/:id/check-open-orders -- observe this bot's resting orders NOW.
 *
 * Calls `BotInstance.checkOpenOrders(actor)`, built at step 19 and until now
 * reachable only from the alarm and the test suite. Thin, the same shape as
 * `startBot`, `resumeBot`, `applyMissedFills` and `liquidateBot`: the DO owns
 * every rule.
 *
 * WHY A HUMAN NEEDS THIS WHEN A TIMER ALREADY RUNS IT. Precisely because the
 * timer might not be. The conditions this endpoint answers are `poll_blind`
 * (five consecutive passes could not read the venue, now retrying at the
 * five-minute floor) and `price_updates_stale` (step 22 -- no live price for
 * over ten minutes on a running bot). Both mean the SCHEDULED observation has
 * stopped working, and without a manual trigger the operator's only move on
 * either is to wait for a backed-off timer and hope. It is also the honest first
 * move for the whole class: it costs one `getOrderStatus` per open order at
 * routine priority and reports exactly what it found.
 *
 * HOW IT DIFFERS FROM `apply-missed-fills`, since the two are adjacent on the
 * bot page and confusing them matters:
 *   - This one runs on a RUNNING bot (that is its normal case); the repair
 *     refuses anything but `halted`.
 *   - This one is not gated on a finding. It re-derives whatever is true right
 *     now, and it is the same pass the alarm has been running every 30 seconds
 *     anyway -- so a human pressing it introduces no operation the system was
 *     not already performing unattended.
 *   - It CAN place an order. On a running grid bot a folded buy places its
 *     paired replacement sell (step 19's `placeReplacement: fresh.status ===
 *     "running"`), where the repair path passes `false` unconditionally. That is
 *     the grid working normally, but it means this is not a books-only action
 *     and the dashboard must not describe it as one.
 *
 * Failure surface, all from the DO (read from source, not assumed):
 *   - `not_created` (404)    -- the object holds no config.
 *   - `invalid_status` (409) -- the bot is `stopped`. Its capital is released,
 *     so a pass would be work whose result nothing may use.
 *   - `not_attached` (503)   -- no exchange client could be built here.
 * A `halted` bot is explicitly NOT an error: observing costs nothing and a halt
 * whose cancellation failed leaves live orders on the exchange while a human is
 * deciding about exactly those books (step 19).
 *
 * A 200 does NOT mean the books are clean. `skipped` carries every order this
 * pass could not read or could not apply, `closed` what it folded to a terminal
 * state, and `deferred` says the pass stood aside for another rather than
 * completing -- which three empty arrays alone cannot distinguish from a clean
 * result, and "I did not look" is a very different answer from "nothing moved".
 */
export async function checkOpenOrders(ctx: ApiContext): Promise<Response> {
  const id = ctx.params.id!;
  const result = await botStub(ctx, id).checkOpenOrders(ctx.actor);
  const [row, snapshot] = await Promise.all([
    ctx.db.botInstances.findOne({ id }),
    snapshotOf(ctx, id),
  ]);
  return ok({ result, bot: row === null ? null : botSummary(row, snapshot) });
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
// Accounts (section 4.4, step 11)
// ---------------------------------------------------------------------------

/**
 * GET /api/accounts -- every registered account and its exchange.
 *
 * The registry the dashboard's future create-bot dropdown reads: a real list of
 * accounts to choose from, each with the venue it trades on. Ordered by label so
 * the dropdown is stable.
 */
export async function listAccounts(ctx: ApiContext): Promise<Response> {
  const rows = await ctx.db.accounts.findMany({
    orderBy: [{ column: "account_label", direction: "asc" }],
  });
  return ok(
    rows.map((row) => ({
      accountLabel: row.account_label,
      exchange: row.exchange,
      createdAt: row.created_at,
    })),
  );
}

/**
 * GET /api/accounts/:label/symbols -- the account's live tradable pairs, cached.
 *
 * Resolves the account's real exchange from the registry, gets a real client for
 * it (`resolveExchangeForAccount`, reusing the Binance and Gemini resolvers), and
 * returns the venue's live tradable pairs -- cached in KV (`SYMBOL_CACHE`) for an
 * hour so a dropdown does not hit the exchange on every open. See
 * `workers/symbols.ts` for the caching and degradation behaviour.
 *
 * A live-call failure (unreachable exchange, missing credentials) surfaces as a
 * 502 carrying the reason, rather than being cached or reported as success.
 */
export async function getAccountSymbols(ctx: ApiContext): Promise<Response> {
  const label = ctx.params.label!;
  const account = await ctx.db.accounts.findOne({ account_label: label });
  if (account === null) {
    throw notFound("unknown_account", `no registered account ${JSON.stringify(label)}`);
  }

  const cache: SymbolCacheStore | null =
    ctx.env.SYMBOL_CACHE === undefined ? null : new KvSymbolCacheStore(ctx.env.SYMBOL_CACHE);

  const listing = await listAccountSymbols({
    account: { label, exchange: account.exchange },
    env: ctx.env,
    now: ctx.now,
    lister: ctx.symbolLister,
    cache,
  });

  if (!listing.ok) {
    throw new ApiError(502, "exchange_unavailable", listing.failure.message);
  }

  return ok({
    accountLabel: label,
    exchange: account.exchange,
    pairs: listing.pairs,
    cached: listing.cached,
    fetchedAt: listing.fetchedAt,
  });
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
