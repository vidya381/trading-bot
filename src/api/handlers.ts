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

import { ApiError, badRequest, notFound, ok, statusForCode } from "./envelope";
import type { ApiContext } from "./router";
import {
  alertView,
  botDetail,
  botSummary,
  candleWindowView,
  circuitBreakerView,
  killSwitchView,
  manualAdjustmentView,
  watchlistEntryView,
  type BotFees,
} from "./serialize";
import {
  addToWatchlist,
  checkSpotInstrument,
  checkTradable,
  fetchCandleWindow,
  readWatchlist,
  removeFromWatchlist,
  type CandleSource,
  type SymbolDetailSource,
  type TradablePairSource,
  type VenueAccount,
  type WatchlistAccount,
  type WatchlistPorts,
} from "../research";
import type { BotInstance, BotSnapshot } from "../durable-objects/bot-instance";
import type {
  AlertCategory,
  AlertSeverity,
  BotInstanceRow,
  BotStatus,
  ExchangeId,
  ManualAdjustmentRow,
} from "../db/schema";
import { EXCHANGE_IDS, isExchangeId } from "../db/schema";
import {
  KvSymbolCacheStore,
  listAccountSymbols,
  type SymbolCacheStore,
} from "../workers/symbols";
import type { Asset, CandleInterval, Pair } from "../shared/exchange-client";
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

/**
 * What one bot has paid the venue, in its own capital asset (step 25).
 *
 * TWO QUERIES, NOT ONE, AND THE SECOND IS NOT OPTIONAL. `sumMoney` is exact --
 * `CAST(SUM(col) AS TEXT)` keeps the total on SQLite's side as a 64-bit integer,
 * so no float exists on this path -- but SQLite's SUM silently SKIPS NULLs, and
 * `fee_reporting_amount` is NULL for every fill whose fee could not be priced
 * (see `BotFees` in serialize.ts). So the sum alone cannot tell "this bot has
 * paid 4.12 in fees" from "this bot has paid 4.12 PLUS an unknown amount of
 * BNB". The count is what makes that difference visible, and without it the
 * total would be a quietly understated cost -- the precise failure section 5.5
 * exists to prevent.
 *
 * Deliberately NOT `sumMoney(..., { fee_reporting_amount: { isNotNull: true } })`:
 * the filter would change nothing (SUM already skips them) while implying the
 * exclusion is a choice this function makes, rather than SQLite's behaviour the
 * count exists to compensate for.
 */
async function feesFor(ctx: ApiContext, id: string): Promise<BotFees> {
  const [reported, unpricedCount] = await Promise.all([
    ctx.db.trades.sumMoney("fee_reporting_amount", { bot_instance_id: id }),
    ctx.db.trades.count({ bot_instance_id: id, fee_reporting_amount: { isNull: true } }),
  ]);
  return { reported: toDecimalString(reported), unpricedCount };
}

/**
 * The fee figure for a bot that provably has no fills yet.
 *
 * Only for `createBot`, whose bot was created microseconds ago and cannot have
 * traded. Querying for it would be two round-trips to prove an empty table, and
 * writing the zero literal by hand in that handler would be a second place that
 * has to know what `BotFees` looks like when nothing has happened.
 */
const NO_FEES: BotFees = { reported: "0.00000000", unpricedCount: 0 };

/** The `bot_instances` row, or 404. The D1 row, not the object's own state. */
async function requireBotRow(ctx: ApiContext, id: string): Promise<BotInstanceRow> {
  const row = await ctx.db.botInstances.findOne({ id });
  if (row === null) {
    throw notFound("unknown_bot", `no bot instance ${JSON.stringify(id)}`);
  }
  return row;
}

/**
 * Refuse an action that would put an ARCHIVED bot back into trading (step 26).
 *
 * Archiving is only allowed from `halted` or `stopped`, which leaves one way
 * for an archived bot to become live again: `start` or `resume`. Without this,
 * a resumed archived bot would be RUNNING and hidden from the bot list's
 * default view -- a live bot placing real orders that an operator has to
 * remember to go looking for. Refusing here keeps the invariant that nothing
 * hidden by default is capable of trading, and says which action to take first
 * rather than silently unarchiving on the operator's behalf.
 *
 * A CHECK, NOT A LATCH, and the difference is worth stating. Both this and
 * `archiveBot` read state and then act, so two operators acting on one bot at
 * the same instant can interleave. One direction is closed properly: the
 * archive write is a conditional UPDATE on the status still being archivable,
 * so an archive that races a resume which has already flipped the status
 * changes nothing and reports why. The other direction -- an archive
 * committing in the window between this check and the object's status flip --
 * is open, and its worst outcome is one running bot hidden from the default
 * view. That is recoverable from the UI (the toggle shows it, unarchive is one
 * click), which is why it is documented rather than serialised behind a lock
 * this flag does not otherwise need.
 */
function assertNotArchived(row: BotInstanceRow, action: string): void {
  if (!row.archived) return;
  throw new ApiError(
    409,
    "bot_archived",
    `bot instance ${JSON.stringify(row.id)} is archived; unarchive it before ${action}. ` +
      `An archived bot is hidden from the bot list's default view, and a running bot must not be.`,
  );
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
 *
 * STEP 25 ADDED TWO D1 READS PER BOT (`feesFor`), and the cost is worth stating
 * plainly because this is the endpoint the dashboard polls every 5 seconds: at
 * v1's ten bots that is twenty extra reads per poll, joining the ten Durable
 * Object reads already there. They are issued inside the SAME per-bot
 * `Promise.all` fan-out rather than sequentially after it, so the added latency
 * is one round-trip, not twenty.
 *
 * The alternative -- one account-wide `SUM` over the whole `trades` table, two
 * queries total -- was considered and rejected on correctness, not cost. A
 * single SUM blends every bot's `fee_reporting_amount` into one number, and
 * those amounts are denominated in each bot's OWN `capital_asset`; a fleet
 * spanning a USDT account and a USD one would produce a total in no currency at
 * all. Per-bot keeps every figure attached to the asset it is denominated in,
 * which is what lets the caller group by capital asset instead of guessing that
 * they all match.
 */
export async function listBots(ctx: ApiContext): Promise<Response> {
  const rows = await ctx.db.botInstances.findMany({
    orderBy: [{ column: "created_at", direction: "desc" }],
  });
  const summaries = await Promise.all(
    rows.map(async (row) => {
      const [snapshot, fees] = await Promise.all([snapshotOf(ctx, row.id), feesFor(ctx, row.id)]);
      return botSummary(row, snapshot, fees);
    }),
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
  const [snapshot, orders, trades, alerts, fees] = await Promise.all([
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
    // Two more reads over `trades`, which this handler is ALREADY reading in
    // full one line above. Recomputing the totals from that array in JS would
    // save the round-trip -- and would be a second implementation of `feesFor`,
    // free to disagree with the list endpoint's about what a fee total is. The
    // number an operator sees on the detail page must be the number they saw on
    // the list page; one query path is how that stays true.
    feesFor(ctx, id),
  ]);
  return ok(botDetail(row, snapshot, orders, trades, alerts, fees));
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

/**
 * THE GATE: a new bot's pair must be one this venue lists, AND must be spot.
 *
 * Until this existed, `POST /api/bots` -- the endpoint that reserves capital and
 * eventually places real orders -- performed no tradability check of any kind.
 * `pair` was a free-typed string stored verbatim, and `bot-instance.ts` never
 * called `listTradablePairs`. A typo, a delisted symbol, a pair from the wrong
 * venue, or one of Gemini's perpetuals all reached bot creation identically, and
 * the first thing that would notice was an order failing at the exchange with
 * capital already reserved against it.
 *
 * ── WHY BOTH CHECKS, AND IN THIS ORDER ──
 *
 * `checkTradable` first: it is one KV-cached full-catalogue read shared with the
 * watchlist and the symbols dropdown, so in the ordinary case it costs no
 * exchange request at all, and it rejects the overwhelmingly common mistake (a
 * mistyped or non-existent pair) before anything is spent. `checkSpotInstrument`
 * second: it is one uncached per-symbol request, so it is only ever paid for a
 * pair the venue has already confirmed it lists.
 *
 * That ordering also makes the messages honest. A perpetual IS on the venue's
 * list, so it passes the first check and is refused by the second, by name --
 * "HYPEUSDCPERP is a derivative ... not a spot pair" rather than the flatly
 * untrue "not tradable".
 *
 * ── WHY THIS GATE OPTS **OUT** OF THE NAMING HEURISTIC ──
 *
 * `checkTradable` can also refuse a pair whose SYMBOL ends in a venue's
 * derivative suffix (`pair_not_spot_by_name`). The four research paths opt in,
 * because a cheap inference is the only spot check they can afford. THIS gate
 * passes `"structural-check-elsewhere"` and deliberately does not, for two
 * reasons that are both about keeping the real check real:
 *
 *  1. EVIDENCE. This is the endpoint that reserves capital. Its refusal should
 *     say "the venue reported product_type: swap", which is a fact Gemini
 *     stated, and not "the symbol ends in PERP", which is something this
 *     repository inferred. Running the heuristic first would downgrade the
 *     message a human reads on the one path where it matters most.
 *  2. MASKING. The heuristic runs before `checkSpotInstrument` and reaches the
 *     same conclusion about the same inputs, so it would answer for every
 *     realistic perpetual -- `HYPEUSDCPERP` included -- and `checkSpotInstrument`
 *     could be deleted outright with every test still green. That is precisely
 *     the multi-signal masking decision log 32 made a standing convention about,
 *     arriving one layer up: across two FUNCTIONS rather than two fields. A
 *     regression test in `api.test.ts` pins that `HYPEUSDCPERP` here is still
 *     answered by `instrument_not_spot`, never `pair_not_spot_by_name`.
 *
 * Nothing is lost by opting out: this gate's structural check is strictly
 * stronger than the heuristic, catching perpetuals the naming rule would miss.
 *
 * ── WHY HERE AND NOT INSIDE THE DURABLE OBJECT ──
 *
 * Both checks run in the HANDLER, before `botStub` is even asked for, because
 * the property that matters is not "creation is refused" but "NOTHING HAPPENED".
 * `BotInstance.create` reserves capital through `createBotInstanceWithCapital`
 * (the `bot_instances` row, the `capital_ledger` reservation and the
 * `capital.allocated` audit entry are one pipeline) and then writes the object's
 * own storage. A check inside that method would already have instantiated the
 * Durable Object; a check after the reservation would leave capital allocated to
 * a bot that was refused. Refusing out here means a rejected request touches no
 * ledger, writes no row, and brings no Durable Object into existence.
 *
 * Neither refusal re-implements anything: both come from
 * `/src/research/tradability.ts`, the same functions the watchlist write path,
 * the candle fetch and both candidate entry points already gate on, reached
 * through the same `tradablePairsFor` port wiring -- so bot creation and the
 * dropdown an operator picks a pair from cannot disagree about what the venue
 * lists.
 */
async function assertBotPairIsSpotTradable(
  ctx: ApiContext,
  account: VenueAccount,
  pair: Pair,
): Promise<void> {
  const refusing =
    `Refusing rather than creating a bot on it -- capital would be reserved and ` +
    `orders eventually placed against a symbol nothing validated.`;

  const listed = await checkTradable(
    tradablePairsFor(ctx),
    account,
    pair,
    refusing,
    "structural-check-elsewhere",
  );
  if (listed !== null) {
    throw new ApiError(statusForCode(listed.code), listed.code, listed.message);
  }

  const spot = await checkSpotInstrument(symbolDetailsFor(ctx), account, pair, refusing);
  if (spot !== null) {
    throw new ApiError(statusForCode(spot.code), spot.code, spot.message);
  }
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

  // FREE CHECKS FIRST, NETWORK LAST -- the order `addToWatchlist` documents and
  // for the same reason. Decoding the strategy parameters is pure and local, so
  // a request that is malformed in BOTH its params and its pair reports the
  // params and spends no exchange request. The decoded params are held rather
  // than sent so that nothing reaches the Durable Object until the venue checks
  // below have passed.
  let create: (stub: DurableObjectStub<BotInstance>) => Promise<unknown>;
  if (strategy === "dca") {
    const params = decodeDcaParams({ ...rawParams, strategy: "dca", schemaVersion: DCA_SCHEMA_VERSION });
    create = (stub) => stub.create({ ...base, params });
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
    create = (stub) => stub.createGrid({ ...base, params });
  } else {
    throw badRequest("invalid_strategy", `strategy must be "dca" or "grid", got ${JSON.stringify(strategy)}`);
  }

  // The gate. Throws before any capital is reserved and before `botStub` brings
  // a Durable Object into existence -- see `assertBotPairIsSpotTradable`.
  await assertBotPairIsSpotTradable(ctx, { label: accountLabel, exchange }, pair);

  await create(botStub(ctx, botInstanceId));

  // Return the created bot so the frontend reflects it without a second fetch.
  const row = await ctx.db.botInstances.findOne({ id: botInstanceId });
  const snapshot = await snapshotOf(ctx, botInstanceId);
  // `NO_FEES` for the same reason the three histories are empty literals: a bot
  // that came into existence in this request has no orders, no trades and no
  // alerts, so there is nothing to query for.
  return ok(botDetail(row!, snapshot, [], [], [], NO_FEES), 201);
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
 * untouched. Step 26 adds one more, raised here rather than by the object:
 * `bot_archived` (409), refused before `start` is called at all. Returns the
 * pipeline result and the refreshed bot so the new status shows immediately.
 */
export async function startBot(ctx: ApiContext): Promise<Response> {
  const id = ctx.params.id!;
  // Step 26's one addition to this handler. Read WITHOUT requiring the row:
  // a missing row is not this endpoint's error to raise (the `bot: null` branch
  // below has always covered an object with no row), and a bot with no row has
  // no archived flag to honour. `start` still owns every other rule.
  const existing = await ctx.db.botInstances.findOne({ id });
  if (existing !== null) assertNotArchived(existing, "starting it");

  const result = await botStub(ctx, id).start(ctx.actor);
  const [row, snapshot, fees] = await Promise.all([
    ctx.db.botInstances.findOne({ id }),
    snapshotOf(ctx, id),
    feesFor(ctx, id),
  ]);
  return ok({ result, bot: row === null ? null : botSummary(row, snapshot, fees) });
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
  const [row, snapshot, fees] = await Promise.all([
    ctx.db.botInstances.findOne({ id }),
    snapshotOf(ctx, id),
    feesFor(ctx, id),
  ]);
  return ok({ result, bot: row === null ? null : botSummary(row, snapshot, fees) });
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
 *   - `bot_archived` (409)     -- step 26, and the only one raised HERE rather
 *                                 than by the object: an archived bot must be
 *                                 unarchived before it can trade again. See
 *                                 `assertNotArchived`.
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
  // Step 26, and the same shape as `startBot`'s: refused BEFORE the object is
  // called, so a refusal leaves the bot exactly as halted as it was -- which is
  // the property every one of `resume`'s own refusals already has.
  const existing = await ctx.db.botInstances.findOne({ id });
  if (existing !== null) assertNotArchived(existing, "resuming it");

  const result = await botStub(ctx, id).resume(ctx.actor);
  const [row, snapshot, fees] = await Promise.all([
    ctx.db.botInstances.findOne({ id }),
    snapshotOf(ctx, id),
    feesFor(ctx, id),
  ]);
  return ok({ result, bot: row === null ? null : botSummary(row, snapshot, fees) });
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
  const [row, snapshot, fees] = await Promise.all([
    ctx.db.botInstances.findOne({ id }),
    snapshotOf(ctx, id),
    feesFor(ctx, id),
  ]);
  return ok({ result, bot: row === null ? null : botSummary(row, snapshot, fees) });
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
  const [row, snapshot, fees] = await Promise.all([
    ctx.db.botInstances.findOne({ id }),
    snapshotOf(ctx, id),
    feesFor(ctx, id),
  ]);
  return ok({ result, bot: row === null ? null : botSummary(row, snapshot, fees) });
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
  const [row, snapshot, fees] = await Promise.all([
    ctx.db.botInstances.findOne({ id }),
    snapshotOf(ctx, id),
    feesFor(ctx, id),
  ]);
  return ok({ result, bot: row === null ? null : botSummary(row, snapshot, fees) });
}

// ---------------------------------------------------------------------------
// Archiving (step 26)
// ---------------------------------------------------------------------------

/**
 * The statuses a bot may be archived FROM.
 *
 * `running` is excluded because archiving a live bot hides it from the page an
 * operator reads to see what is happening now. `created` is excluded too, and
 * that is a deliberate scope choice rather than an oversight -- the same one
 * step 23 made when `HaltAction` refused a `created` bot the backend would have
 * accepted. A bot that has never started is not finished with; it is not
 * started. Widening this later is a one-line change plus a test.
 */
const ARCHIVABLE_STATUSES: readonly BotStatus[] = ["halted", "stopped"];

/**
 * Write the archived flag and its audit entry. Returns whether it changed.
 *
 * THE CONDITIONAL UPDATE IS THE ONLY DECISION -- there is deliberately no
 * "already archived?" branch in the callers to duplicate it. The `WHERE`
 * carries the current value (and, when archiving, that the status is still
 * archivable), so inspecting `changes` answers both questions at once and
 * answers them against the database rather than against a row read a moment
 * ago. A second archive matches no row, writes no second audit entry, and
 * reports `already_archived`; an archive that races a `resume` which has
 * already flipped the status likewise matches nothing, rather than hiding a bot
 * that is now running.
 *
 * This is the same `update(...) -> inspect changes` idiom the capital ledger
 * uses for its `status <> 'stopped'` claims, for the same reason: a read
 * followed by an unconditional write is a lost update waiting for a second
 * caller.
 */
async function setArchived(
  ctx: ApiContext,
  row: BotInstanceRow,
  archived: boolean,
): Promise<boolean> {
  const now = ctx.now();
  const where =
    archived === true
      ? { id: row.id, archived: false, status: { in: [...ARCHIVABLE_STATUSES] } }
      : { id: row.id, archived: true };
  const changed = await ctx.db.botInstances.update(where, { archived, updated_at: now });
  if (changed !== 1) return false;

  await ctx.db.auditLog.insert({
    id: ctx.newId(),
    actor: ctx.actor,
    action: archived ? "bot.archived" : "bot.unarchived",
    target_bot_instance_id: row.id,
    // The status is recorded because it is the thing the gate was checked
    // against, and it is not otherwise recoverable from this entry later.
    details_json: { status: row.status, account_label: row.account_label },
    created_at: now,
  });
  return true;
}

/** The bot as the caller should now see it, with its fees and live position. */
async function refreshedBot(ctx: ApiContext, id: string) {
  const [row, snapshot, fees] = await Promise.all([
    ctx.db.botInstances.findOne({ id }),
    snapshotOf(ctx, id),
    feesFor(ctx, id),
  ]);
  return row === null ? null : botSummary(row, snapshot, fees);
}

/**
 * POST /api/bots/:id/archive -- hide a finished bot from the default list view.
 *
 * WHAT THIS IS NOT. It is not a delete, and that is structural rather than a
 * promise made in a comment: `Repository` exposes no `delete` method at all
 * (/src/db/table.ts's header explains why -- section 8.7 retains everything),
 * and `no-raw-d1.test.ts` fails the build if any file outside /src/db reaches
 * for the raw binding to route around it. There is no code path from this
 * endpoint to a removed row, because there is no code path from ANY endpoint to
 * one.
 *
 * What it writes is one boolean and `updated_at`, on the `bot_instances` row.
 * It does not touch the Durable Object -- the object is never asked to mutate
 * anything here, only read for the response -- so the bot's configuration,
 * position, ladder or DCA entries, order history and idempotency records are
 * exactly as they were. It does not touch `orders`, `trades`, `alerts` or
 * `capital_ledger` either: an archived bot still holds its allocation (only the
 * `stopped` transition releases capital, via `releaseBotCapital`), still counts
 * toward the account-level totals on the dashboard, and its detail page renders
 * identically before and after.
 *
 * GATED ON `halted` OR `stopped`, mirroring the status-gating every other
 * action here uses, and read from the D1 ROW rather than the object's snapshot.
 * That is deliberate: archived is a property of the row, and an ORPHANED bot --
 * a row whose object holds no state, which `botSummary` already surfaces as
 * `orphaned: true` -- must still be archivable. A snapshot-authoritative gate
 * could not answer for one, since there is no snapshot to ask.
 *
 * Failures:
 *   - `unknown_bot` (404)    -- no such row.
 *   - `invalid_status` (409) -- the bot is `running` or `created`.
 * Archiving an already-archived bot is NOT an error: it reports
 * `already_archived`, changes nothing and writes no second audit entry, which
 * is the same idempotence `halt` gives a double-click.
 */
export async function archiveBot(ctx: ApiContext): Promise<Response> {
  const id = ctx.params.id!;
  const row = await requireBotRow(ctx, id);

  // The status refusal is the ONE thing decided here, because it is the one
  // thing the conditional update cannot express: a `WHERE` that matches nothing
  // cannot say WHY, and "halt it first" is the whole point of the message.
  // Skipped for a bot that is already archived, so idempotence does not depend
  // on the status -- an already-hidden bot is reported as such whatever it is
  // doing, rather than being refused for a state it is already in.
  if (!row.archived && !ARCHIVABLE_STATUSES.includes(row.status)) {
    throw new ApiError(
      409,
      "invalid_status",
      `bot instance ${JSON.stringify(id)} is ${row.status}; only a ${ARCHIVABLE_STATUSES.join(" or ")} ` +
        `bot can be archived. Archiving removes nothing, but hiding a live bot from the default ` +
        `view would hide orders being placed with real capital.`,
    );
  }

  const changed = await setArchived(ctx, row, true);
  return ok({
    result: { action: changed ? ("archived" as const) : ("already_archived" as const) },
    bot: await refreshedBot(ctx, id),
  });
}

/**
 * POST /api/bots/:id/unarchive -- put a bot back in the default list view.
 *
 * Deliberately NOT status-gated. Every action in this system is reversible and
 * this is the reversing half; a gate here could only ever strand a bot in the
 * hidden state, which is the one outcome archiving must never produce. It is
 * also the risk-REDUCING direction (it makes a bot more visible, not less), and
 * this codebase already keeps such actions available unconditionally -- `halt`
 * asserts neither risk latch for the same reason.
 *
 * Unarchiving a bot that is not archived reports `not_archived` and changes
 * nothing, the mirror of `archive`'s `already_archived`. It never resumes
 * anything: a halted bot comes back halted, and resuming remains a separate,
 * explicit action (section 7.2 step 5).
 */
export async function unarchiveBot(ctx: ApiContext): Promise<Response> {
  const id = ctx.params.id!;
  const row = await requireBotRow(ctx, id);

  // No status branch of ANY kind, deliberately -- not even the one archiving
  // uses. A bot in a status archiving would refuse can still be unarchived, and
  // must be: that is precisely the bot for which being stuck hidden would be
  // unrecoverable.
  const changed = await setArchived(ctx, row, false);
  return ok({
    result: { action: changed ? ("unarchived" as const) : ("not_archived" as const) },
    bot: await refreshedBot(ctx, id),
  });
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
// Watchlist (section 21.3)
// ---------------------------------------------------------------------------

/**
 * The account, as the watchlist module wants it, or 404.
 *
 * `WatchlistAccount` is `{ label, exchange }` and the exchange comes from the
 * registry, never from the request -- the same derivation `createBot` uses and
 * for the same reason step 11 gave: a free-typed exchange on the request lets a
 * caller pick which venue their pair is validated against, which is a
 * validation that validates nothing.
 */
async function requireWatchlistAccount(
  ctx: ApiContext,
  label: string,
): Promise<WatchlistAccount> {
  const account = await ctx.db.accounts.findOne({ account_label: label });
  if (account === null) {
    throw notFound("unknown_account", `no registered account ${JSON.stringify(label)}`);
  }
  return { label, exchange: account.exchange };
}

/**
 * Wire the watchlist's `TradablePairSource` port to the REAL cached listing.
 *
 * This is the same `listAccountSymbols` call `getAccountSymbols` makes, with the
 * same KV cache and the same `ctx.symbolLister` (defaulting to
 * `envSymbolLister`, which resolves the account's exchange, builds a real
 * client, and calls `listTradablePairs`). Reused rather than reached for
 * directly, so the watchlist's tradability check and the dropdown the operator
 * reads cannot disagree about what the venue lists, and so a check does not
 * bypass the cache and spend a full-catalogue exchange request per add.
 *
 * The cache being shared has one consequence worth naming: a tradable set up to
 * an hour old can approve a pair the venue delisted in the meantime. That is the
 * safe direction -- the pipeline that consumes this list re-reads the venue
 * before it can propose anything, and a stale ACCEPT costs one wasted candidate
 * while a stale REJECT would block a real one. A read failure is never cached
 * (`listAccountSymbols` returns failures without writing), so the fail-closed
 * refusal is always against a live attempt.
 */
function tradablePairsFor(ctx: ApiContext): TradablePairSource {
  const cache: SymbolCacheStore | null =
    ctx.env.SYMBOL_CACHE === undefined ? null : new KvSymbolCacheStore(ctx.env.SYMBOL_CACHE);
  return async (account) =>
    await listAccountSymbols({
      account,
      env: ctx.env,
      now: ctx.now,
      lister: ctx.symbolLister,
      cache,
    });
}

/**
 * Wire the `SymbolDetailSource` port to the REAL per-symbol details call.
 *
 * The sibling of `tradablePairsFor` above, and deliberately NOT routed through
 * the same KV cache. That cache holds one array of pair NAMES per account; this
 * asks about one symbol and wants a different payload entirely. More to the
 * point, the asymmetry `tradablePairsFor` documents runs the other way here: a
 * stale ACCEPT from the pair listing costs one wasted candidate, because the
 * pipeline re-reads the venue before proposing anything. A stale accept from
 * THIS check would let a perpetual through the one gate standing between a
 * human's typo and a bot on an instrument this system cannot model, and nothing
 * downstream asks the question a second time.
 *
 * `ctx.symbolDetailLister` defaults to `envSymbolDetailLister`, which resolves
 * the account's client through the same `clientForAccount` the pair listing and
 * the candle fetch use. One resolution path, now four callers.
 */
function symbolDetailsFor(ctx: ApiContext): SymbolDetailSource {
  return async (account, pair) =>
    await ctx.symbolDetailLister(account, pair, ctx.env, ctx.now);
}

function watchlistPorts(ctx: ApiContext): WatchlistPorts {
  return {
    db: ctx.db,
    now: ctx.now,
    newId: ctx.newId,
    listTradablePairs: tradablePairsFor(ctx),
  };
}

/**
 * GET /api/watchlist -- the live section 21.3 watchlist.
 *
 * `?accountLabel=` narrows to one account; omitted, it spans every account,
 * which is what a general-entry-point pipeline run over the whole list wants.
 *
 * An UNREGISTERED `accountLabel` is a 404, not an empty list, following
 * `getAccountSymbols` rather than `listAlerts`. The difference is that
 * `listAlerts`' filters are closed enumerations where a typo cannot look like a
 * real value, whereas an account label is free text: returning `[]` for
 * `gemini-mian` reports "nothing is watched" about an account that does not
 * exist, and the caller cannot tell that from the truth.
 */
export async function listWatchlist(ctx: ApiContext): Promise<Response> {
  const accountLabel = ctx.url.searchParams.get("accountLabel");
  if (accountLabel !== null) {
    await requireWatchlistAccount(ctx, accountLabel);
  }
  const entries = await readWatchlist(
    ctx.db,
    accountLabel === null ? {} : { accountLabel },
  );
  return ok(entries.map(watchlistEntryView));
}

/**
 * POST /api/watchlist -- add one pair to the watchlist.
 *
 * A thin wrapper, in the strict sense this layer means it: the cap, the
 * tradability check, the duplicate check, the human-actor rule and the audit
 * entry all live in `addToWatchlist` and none of them are re-implemented,
 * re-ordered or second-guessed here. What this adds is the HTTP shape, the
 * registry lookup that turns a label into a `WatchlistAccount`, and the port
 * wiring above.
 *
 * THE ACTOR IS `ctx.actor` AND IS NEVER READ FROM THE BODY. That is this
 * layer's standing rule (see the file header) and it matters more than usual
 * here, because the module refuses automated actors on purpose: a body-supplied
 * actor would let any authenticated caller write "chosen deliberately by the
 * operators" under someone else's name, in the one table whose entire value is
 * that a named human vouched for each row. An `actor` field in the body is
 * therefore REFUSED rather than ignored -- silently overriding it would record a
 * different person than the caller believes they recorded, and the audit log is
 * the thing this refusal exists to keep true.
 *
 * Failures, all raised by the module and mapped in envelope.ts:
 *   - `cap_exceeded` (409)            -- the list already holds 10.
 *   - `already_watched` (409)         -- the pair is live on this account.
 *   - `pair_not_tradable` (400)       -- the venue does not list it.
 *   - `pair_not_spot_by_name` (400)   -- it IS listed, and its name says perp.
 *                                        An inference, not the venue's word.
 *   - `tradable_set_unreadable` (503) -- the venue could not be asked.
 *   - `requires_human_actor` (403)    -- unreachable over HTTP today, since
 *     `ctx.actor` is a verified Access email, but the module still checks and
 *     the mapping exists so it cannot become a silent 400 later.
 */
export async function addWatchlistEntry(ctx: ApiContext): Promise<Response> {
  const body = await readJsonObject(ctx.request);
  if (body.actor !== undefined) {
    throw badRequest(
      "actor_not_accepted",
      `field "actor" is not accepted: the actor is the email verified from the ` +
        `Cloudflare Access token, so a body-supplied one would be recorded as ` +
        `someone else. Remove the field.`,
    );
  }

  const accountLabel = requireString(body, "accountLabel");
  const pair = requireString(body, "pair");
  const note = requireString(body, "note");
  const account = await requireWatchlistAccount(ctx, accountLabel);

  const entry = await addToWatchlist(watchlistPorts(ctx), {
    account,
    pair,
    note,
    actor: ctx.actor,
  });
  return ok(watchlistEntryView(entry), 201);
}

/**
 * DELETE /api/watchlist/:id -- take one pair off the watchlist.
 *
 * Addressed by ENTRY ID where the module is addressed by (account, pair),
 * because an id is what `GET /api/watchlist` just handed the caller and it is
 * the only stable handle on a row. The adaptation is a lookup, and it carries
 * one guard that is NOT redundant with the module's own:
 *
 * A pair can be removed and later re-added, which the migration's PARTIAL unique
 * index exists to allow. So an old, already-removed row and a new, live row can
 * share `(account_label, pair)`. Passing the old row's pair straight through
 * would make `removeFromWatchlist` match the LIVE one and remove it -- a DELETE
 * on a dead id silently killing a different entry. Refusing a non-live id here
 * is what closes that; the module cannot, because by the time it sees the pair
 * the id is gone.
 *
 * What is deliberately NOT duplicated is the liveness DECISION itself: the
 * module still owns it (its `UPDATE` is conditional on `removed_at IS NULL`, so
 * a removal racing another loses properly). This guard answers a different
 * question -- "does this id name the live entry for that pair" -- and a test and
 * a mutant pin it.
 *
 * REMOVAL DOES NOT RE-CHECK TRADABILITY. Settled deliberately: refusing to
 * remove a delisted pair would trap exactly the entry most in need of removing,
 * and an exchange outage would be enough to freeze the list. It is the same
 * stance `unarchiveBot` takes ("the risk-REDUCING direction ... a gate here
 * could only ever strand a bot") and the same one `halt` takes in asserting
 * neither latch.
 *
 * Failures:
 *   - `unknown_watchlist_entry` (404) -- no row with that id.
 *   - `not_watched` (404)             -- the row exists but is not live.
 */
export async function removeWatchlistEntry(ctx: ApiContext): Promise<Response> {
  const id = ctx.params.id!;
  const row = await ctx.db.watchlist.findOne({ id });
  if (row === null) {
    throw notFound("unknown_watchlist_entry", `no watchlist entry ${JSON.stringify(id)}`);
  }
  if (row.removed_at !== null) {
    throw new ApiError(
      404,
      "not_watched",
      `watchlist entry ${JSON.stringify(id)} (${row.pair} on ${row.account_label}) was ` +
        `already removed by ${row.removed_by}. The pair may have been added again ` +
        `since, under a new id -- removing it is a separate request against that id.`,
    );
  }

  const account = await requireWatchlistAccount(ctx, row.account_label);

  // `?note=` rather than a body. A DELETE with no body is the normal case and
  // `readJsonObject` would turn one into an `invalid_json` 400, so an optional
  // body here would mean either a second body reader that tolerates emptiness or
  // a required body on a request that needs none. The note is optional in the
  // module too (see its header: the ADD's note is the justification nothing else
  // records; a removal's is usually "we are done with it"), so a query parameter
  // matches what it is -- a nicety, not a field.
  const note = ctx.url.searchParams.get("note");
  if (note !== null && note.trim() === "") {
    throw badRequest("invalid_field", `query parameter "note", if given, must not be blank`);
  }

  const removed = await removeFromWatchlist(watchlistPorts(ctx), {
    account,
    pair: row.pair,
    ...(note === null ? {} : { note }),
    actor: ctx.actor,
  });
  return ok(watchlistEntryView(removed));
}

// ---------------------------------------------------------------------------
// Candles (section 21.4, Stage 1)
// ---------------------------------------------------------------------------

/**
 * The seven values `CandleInterval` declares, for parsing a query string.
 *
 * NOT the same list as `VERIFIED_INTERVALS`, and the difference is the whole
 * point of having both. This one answers "is that string an interval at all"
 * (`1w` is not) and belongs to the HTTP layer, which has to turn free text into
 * a typed value before anything else can look at it. The module's list answers
 * "has that interval been verified against a real venue" (`6h` is real and
 * unverified), which is a POLICY the module owns and re-checks for every
 * caller, HTTP or not. Two different refusals, deliberately not merged: folding
 * them into one would either let the layer decide policy or make the module
 * parse strings.
 */
const CANDLE_INTERVALS: readonly CandleInterval[] = ["1m", "5m", "15m", "30m", "1h", "6h", "1d"];

/**
 * Wire the candle fetch's `CandleSource` port to the real per-account lister.
 *
 * `envCandleLister` resolves a client through `clientForAccount` -- the same
 * function `envSymbolLister` uses -- so the candle call and the tradability
 * check that gates it reach the venue through one resolution path.
 *
 * Unlike `tradablePairsFor` there is no cache here, deliberately: a tradable
 * set is reference data that ages well, while a candle's entire value is that
 * it is current, and 21.5 requirement 4 times a proposal from when its data was
 * fetched. See `workers/candles.ts`.
 */
function candleSourceFor(ctx: ApiContext): CandleSource {
  return async (account, query) => await ctx.candleLister(account, query, ctx.env, ctx.now);
}

/**
 * GET /api/accounts/:label/candles -- real candles for any tradable pair.
 *
 * The curl-able surface over `fetchCandleWindow` (section 21.4, Stage 1), and
 * it exists for one concrete reason beyond convenience: 21.7's open question 1
 * is a claim about how deep Gemini's `/v2/candles` window actually is, and that
 * claim cannot be settled by a test. Every candle in this repository's suite
 * comes from a stub modelling a fixed window; only a real request against a
 * real venue can say whether `truncated` and `missingHistoryMs` report the
 * truth. This endpoint is how that gets checked.
 *
 * A THIN WRAPPER in the strict sense this layer means it: the interval gate,
 * the registry lookup, the tradability check, the fail-closed refusals and the
 * truncation arithmetic all live in `fetchCandleWindow` and none of them is
 * re-implemented, re-ordered or second-guessed here. What this adds is query
 * parsing, the port wiring, and the serialization of `Candle`'s five bigints.
 *
 * READ-ONLY. No write, no audit entry, no state of any kind -- unlike the
 * watchlist endpoints, there is nothing here for an audit log to record. The
 * Access gate still applies, as it does to every route in this table.
 *
 * `pair` and `interval` are REQUIRED rather than defaulted. A default pair is
 * meaningless, and a default `interval=1m` would hide the one thing this
 * endpoint is for: making the interval an explicit, refusable choice.
 *
 * Failures:
 *   - `missing_field` (400)            -- no `pair`, or no `interval`.
 *   - `invalid_filter` (400)           -- `interval` is not an interval at all.
 *   - `invalid_field` (400)            -- `since` is not a non-negative integer.
 *   - `interval_not_verified` (400)    -- a real interval, unverified on a venue.
 *   - `unknown_account` (404)          -- no such registered account.
 *   - `pair_not_tradable` (400)        -- the venue does not list it.
 *   - `pair_not_spot_by_name` (400)    -- it IS listed, and its name says perp.
 *                                         An inference, not the venue's word.
 *   - `tradable_set_unreadable` (503)  -- the venue could not be asked.
 *   - `candles_unavailable` (502)      -- the venue was asked and failed.
 *   - `no_candles_returned` (502)      -- it answered, with nothing usable.
 *
 * The last six are the module's own codes, mapped in envelope.ts rather than
 * turned into statuses here, so a second caller of the module gets the same
 * statuses without this handler being involved.
 */
export async function getAccountCandles(ctx: ApiContext): Promise<Response> {
  const label = ctx.params.label!;

  const pair = ctx.url.searchParams.get("pair");
  if (pair === null || pair.trim() === "") {
    throw badRequest(
      "missing_field",
      `query parameter "pair" is required and must be the venue's own symbol, ` +
        `exactly as GET /api/accounts/${label}/symbols reports it`,
    );
  }

  const interval = ctx.url.searchParams.get("interval");
  if (interval === null || interval.trim() === "") {
    throw badRequest(
      "missing_field",
      `query parameter "interval" is required and must be one of ${CANDLE_INTERVALS.join(", ")}`,
    );
  }
  if (!CANDLE_INTERVALS.includes(interval as CandleInterval)) {
    throw badRequest(
      "invalid_filter",
      `interval must be one of ${CANDLE_INTERVALS.join(", ")}, not ${JSON.stringify(interval)}`,
    );
  }

  // `since` is an epoch-millisecond timestamp, parsed strictly, and the blank
  // case is checked SEPARATELY rather than left to `Number`. `Number("")` is
  // 0, not NaN -- so `?since=` with nothing after it would silently become
  // "since the epoch", which is a real and very different request from the one
  // a caller who fumbled the shell quoting meant to make. `Number("12abc")` is
  // NaN, which would reach `getCandles` and filter every candle out, producing
  // an empty window blamed on the venue rather than on the query.
  const sinceParam = ctx.url.searchParams.get("since");
  let since: number | undefined;
  if (sinceParam !== null) {
    const parsed = Number(sinceParam);
    if (sinceParam.trim() === "" || !Number.isInteger(parsed) || parsed < 0) {
      throw badRequest(
        "invalid_field",
        `query parameter "since", if given, must be a non-negative integer of ` +
          `epoch milliseconds, not ${JSON.stringify(sinceParam)}`,
      );
    }
    since = parsed;
  }

  const window = await fetchCandleWindow(
    {
      db: ctx.db,
      // The SAME port the watchlist endpoints use, so the candle fetch's
      // tradability gate and the dropdown an operator reads cannot disagree
      // about what the venue lists, and a fetch spends no extra full-catalogue
      // request.
      listTradablePairs: tradablePairsFor(ctx),
      getCandles: candleSourceFor(ctx),
    },
    {
      accountLabel: label,
      pair,
      interval: interval as CandleInterval,
      ...(since === undefined ? {} : { since }),
    },
  );

  return ok(candleWindowView(window));
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
