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
  accountCapitalView,
  alertView,
  botDetail,
  botSummary,
  candidateGatherBundleView,
  candidateSetGatherBundleView,
  candleWindowView,
  circuitBreakerView,
  killSwitchView,
  manualAdjustmentView,
  watchlistEntryView,
  assessResultView,
  assessProposalInputsView,
  assessProposalReasoningView,
  deriveContextView,
  deriveProposalInputsView,
  deriveProposalReasoningView,
  deriveResultView,
  proposalListEntryView,
  proposalRecordView,
  resubmittedAssessmentView,
  PROPOSAL_LIST_COLUMNS,
  type BotFees,
} from "./serialize";
import { replayProposal } from "./proposal-replay";
import { parseProposalQuery, proposalListWhere, proposalPage } from "./proposal-query";
import {
  addToWatchlist,
  checkSpotInstrument,
  checkTradable,
  fetchCandleWindow,
  gatherCandidateData,
  gatherCandidateSetData,
  readWatchlist,
  removeFromWatchlist,
  assessCandidate,
  AssessError,
  AssessParseError,
  AssessResubmitError,
  DeriveError,
  DeriveParseError,
  DeriveValidationError,
  deriveParameters,
  gatherDeriveContext,
  parseResubmittedAssessment,
  readAccountCapital,
  ResearchCapitalError,
  selectNamedCandidate,
  selectWatchlistCandidates,
  checkProposalCanTakeOutcome,
  logAssessProposal,
  logDeriveProposal,
  proposalRecordOf,
  recordProposalApproval,
  rejectProposal,
  type AssessResult,
  type CandidateEntryPoint,
  type CandleSource,
  type DeriveContextPorts,
  type DeriveResult,
  type GatherPorts,
  type GatherRequest,
  type ProposalLogPorts,
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
import { envAssessModel } from "../workers/assess";
import { envDeriveModel } from "../workers/derive";
import type { Asset, CandleInterval, Pair } from "../shared/exchange-client";
import { fromDecimalString, toDecimalString, ZERO, type Money } from "../shared/money";
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

/**
 * `POST /api/bots` -- create a bot, optionally recording which proposal suggested it.
 *
 * ── THE `proposalId` FIELD (21.5 requirement 5's outcome half) ──
 *
 * OPTIONAL, and every existing caller is unaffected: a request without it behaves
 * exactly as it did before, and the dashboard's create-bot form does not send one.
 *
 * It exists because before it, **nothing connected a real create-bot action back
 * to the proposal that suggested it** -- so `proposals.outcome` could only ever
 * hold `rejected` and NULL, and "the system kept proposing things nobody wanted"
 * would have had no way to distinguish a proposal nobody wanted from one that
 * became a real, profitable bot. A permanent record whose outcome column can never
 * say `approved` is permanently incomplete for its own stated purpose.
 *
 * ── IT IS NOT A NEW PATH TO A BOT, AND 21.1 IS UNTOUCHED ──
 *
 * This is worth stating precisely, because a field connecting a proposal to a bot
 * creation is exactly the shape 21.1 is suspicious of. `proposalId` changes
 * NOTHING about how the bot is created: every parameter still arrives in the body,
 * typed or confirmed by a human; every decoder, the mandatory stop-loss, the
 * tradability gate, the spot-instrument check and the ledger's binding capital
 * compare-and-swap all run unchanged and unweakened. NOTHING is read out of the
 * proposal record and used as an input -- the record is written to, never read
 * from, except to check it can take an outcome.
 *
 * A field that PREFILLED the form from a stored proposal would be the one-click
 * bridge 21.1 forbids. This one only records, after the fact, that a human did the
 * work themselves. The proposal cannot supply a value, so it cannot supply a wrong
 * one.
 *
 * ── EVERY CHECK ON IT RUNS BEFORE THE BOT EXISTS ──
 *
 * `checkProposalCanTakeOutcome` runs with the other free checks, before the
 * tradability gate and long before `create` -- `createBot`'s own "FREE CHECKS
 * FIRST, NETWORK LAST" rule. An unknown id, an already-resolved proposal, an
 * `assess` record (nothing to build from), or one belonging to a different account
 * therefore refuses the request while **nothing has happened**: no capital
 * reserved, no row written, no Durable Object brought into existence.
 *
 * ⚠ THE ONE FAILURE THAT CANNOT BE MOVED EARLIER, AND WHAT HAPPENS THEN. The
 * outcome WRITE can only run after `create` returns, because
 * `outcome_bot_instance_id` is a foreign key and `approval_names_a_bot` requires
 * it -- a link to a bot that does not exist yet is the fabricated audit fact this
 * project refuses to manufacture. If that last write fails, the bot IS created and
 * this endpoint still returns 201, with `proposalLink.recorded: false` and the real
 * error in the body. Failing the response instead would tell an operator that
 * creation failed when it did not, and the recovery they would attempt -- creating
 * it again -- is the worst available action. `undoReservation`
 * (`capital/ledger.ts`) treats a post-commit failure the same way.
 */
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

  // 21.5 requirement 5's outcome link, checked HERE -- with the free checks,
  // before the venue calls and long before anything is created. Every refusal
  // this can raise therefore leaves the request having done nothing at all. The
  // row is held rather than re-read after creation, so the checks and the write
  // are about the same row. See this handler's docblock.
  const proposalId = optionalString(body, "proposalId");
  const proposal =
    proposalId === undefined
      ? null
      : await checkProposalCanTakeOutcome(proposalLogPorts(ctx), proposalId, {
          accountLabel,
          forApproval: true,
        });

  // The gate. Throws before any capital is reserved and before `botStub` brings
  // a Durable Object into existence -- see `assertBotPairIsSpotTradable`.
  await assertBotPairIsSpotTradable(ctx, { label: accountLabel, exchange }, pair);

  await create(botStub(ctx, botInstanceId));

  // ⚠ PAST THE POINT OF NO RETURN. A real bot now exists and capital is reserved,
  // so nothing below may fail this request -- see the docblock's last paragraph.
  let proposalLink: { readonly proposalId: string; readonly recorded: boolean; readonly error: string | null } | null =
    null;
  if (proposal !== null) {
    try {
      await recordProposalApproval(proposalLogPorts(ctx), proposal, ctx.actor, botInstanceId);
      proposalLink = { proposalId: proposal.id, recorded: true, error: null };
    } catch (error) {
      // Reported, never swallowed and never rethrown. The operator needs to know
      // the link is missing -- it is the only thing that will ever connect this
      // bot back to the reasoning behind it -- and the bot's own creation is a
      // completed fact that this must not misreport.
      console.error("failed to record proposal approval", { proposalId: proposal.id, botInstanceId, error });
      proposalLink = {
        proposalId: proposal.id,
        recorded: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  // Return the created bot so the frontend reflects it without a second fetch.
  const row = await ctx.db.botInstances.findOne({ id: botInstanceId });
  const snapshot = await snapshotOf(ctx, botInstanceId);
  // `NO_FEES` for the same reason the three histories are empty literals: a bot
  // that came into existence in this request has no orders, no trades and no
  // alerts, so there is nothing to query for.
  const detail = botDetail(row!, snapshot, [], [], [], NO_FEES);
  // ABSENT rather than null when no proposal was named, so an ordinary creation's
  // response shape is byte-identical to what it was before this field existed.
  return ok(proposalLink === null ? detail : { ...detail, proposalLink }, 201);
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
 * POST /api/bots/:id/repair-position -- rebuild a DCA position from its orders.
 *
 * REPORT BY DEFAULT. `?commit=true` is the only thing that writes; without it
 * this is a pure read that computes the whole before/after diff, runs every gate,
 * and returns which one would block. That inversion is deliberate and matches how
 * the rest of this surface behaves: `check-open-orders` reports what it folded
 * and what it refused, `apply-missed-fills` reports what it could not attribute,
 * and section 9 halts and alerts rather than correcting. This is the only call in
 * the system that OVERWRITES a position, so the number is meant to be read before
 * it is trusted.
 *
 * `?commit=` rather than a body, for the reason `removeWatchlistEntry` gives: a
 * POST with no body is the normal case here and `readJsonObject` would turn one
 * into an `invalid_json` 400.
 *
 * REACHABLE WHILE A DRIFT ALERT STANDS, which is the whole point. Step 58 makes
 * `resume` refuse a bot with an open `order_state_drift` alert; this endpoint is
 * how that condition gets resolved, so it must not be gated behind the thing it
 * unblocks. It is independent of `resume` in both directions -- it never changes
 * status, and a halted bot stays halted.
 */
export async function repairPosition(ctx: ApiContext): Promise<Response> {
  const id = ctx.params.id!;
  const raw = ctx.url.searchParams.get("commit");
  if (raw !== null && raw !== "true" && raw !== "false") {
    throw badRequest(
      "invalid_field",
      `query parameter "commit", if given, must be "true" or "false"; got ${JSON.stringify(raw)}`,
    );
  }
  const commit = raw === "true";
  const result = await botStub(ctx, id).repairPosition(ctx.actor, { commit });
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

/**
 * POST /api/bots/:id/close -- close a bot and return its capital to the account.
 *
 * Calls `BotInstance.close(actor)`, which has existed and been tested since step
 * 6 and until now was reachable ONLY from the test suite -- there was no route,
 * no worker and no dashboard path to it, which meant `releaseBotCapital` (and
 * therefore the `stopped` status itself) could not be reached in production at
 * all. This is that route. Thin, the same shape as `startBot`, `haltBot`,
 * `resumeBot` and `liquidateBot`: `close()` owns the mechanics and they are not
 * re-implemented here.
 *
 * WHAT CLOSING DOES, from `#closePass`, read rather than assumed: it cancels any
 * open orders through the same path a halt uses, calls `releaseBotCapital`
 * (which owns the `stopped` transition and is the mutual exclusion against a
 * double release), clears `openOrderIds`, audits `bot.closed`, and unsubscribes
 * from the price feed. It does NOT sell anything.
 *
 * ⚠ IT IS THE POINT OF NO RETURN FOR THE ALLOCATION. A second close raises
 * `bot_already_stopped` from the ledger, and nothing in this system moves a bot
 * back out of `stopped` -- re-funding a closed bot is not built. So this ends
 * the bot for capital purposes even though its history, config and position all
 * survive intact.
 *
 * GATED ON A FLAT POSITION, exactly as `archive` is and through the same
 * function. This is a wider gate than `close()` itself imposes -- the object
 * would happily close over a held position -- and it is deliberate: releasing
 * capital from a bot still carrying inventory returns capital that is not cash
 * (see `assertFlatBeforeRelease`), and that hazard does not care which endpoint
 * the release came through. An ungated route beside a gated one would be a hole
 * straight through the gate. Loosening it later is deleting one line.
 *
 * Failures:
 *   - `unknown_bot` (404)         -- no such row. Raised here, before the object
 *                                    is woken, because the gate needs the row
 *                                    anyway and a close is not worth creating an
 *                                    object to refuse.
 *   - `position_held` (409)       -- still holding inventory; liquidate first.
 *   - `not_created` (404)         -- from the object: it holds no config.
 *   - `bot_already_stopped` (409) -- from the ledger: capital already released.
 * Deliberately NOT gated on `archived`: `assertNotArchived` exists to stop a
 * hidden bot TRADING, and closing is the opposite of trading. `halt` skips it
 * for the same reason.
 */
export async function closeBot(ctx: ApiContext): Promise<Response> {
  const id = ctx.params.id!;
  const row = await requireBotRow(ctx, id);
  assertFlatBeforeRelease(row, await snapshotOf(ctx, id), "closing it");

  const result = await botStub(ctx, id).close(ctx.actor);
  const [refreshed, snapshot, fees] = await Promise.all([
    ctx.db.botInstances.findOne({ id }),
    snapshotOf(ctx, id),
    feesFor(ctx, id),
  ]);
  return ok({
    result,
    bot: refreshed === null ? null : botSummary(refreshed, snapshot, fees),
  });
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
 * How much base asset this bot is still holding, from its OWN state.
 *
 * NOT from the `bot_instances` row, and that is the whole point: the row
 * carries `allocated_capital` (a reservation) and `status`, but the POSITION
 * lives only in Durable Object storage, which section 8.1 makes the source of
 * truth for it. `serialize.ts`'s `positionOf` already publishes exactly these
 * two fields to the dashboard, and `#liquidatePositionPass` already branches on
 * exactly this expression to decide whether there is anything to sell:
 *
 *   config.strategy === "grid" ? state.ladder.heldQuantity : state.position.quantity
 *
 * This is that expression, third copy, deliberately kept identical -- the gate
 * below must refuse precisely the bots Liquidate would accept, or the message it
 * prints ("liquidate it first") would name an action that then reports nothing
 * to do.
 *
 * The one difference from the DO's version is `ladder?.` rather than `ladder!`.
 * A grid bot that has never placed its ladder has no `ladder` at all, and
 * `positionOf` already treats that as "0" rather than asserting. A gate is the
 * wrong place to be the first caller that throws on it.
 */
function heldQuantityOf(snapshot: BotSnapshot): Money {
  const state = snapshot.state;
  if (snapshot.config.strategy === "grid") return state.ladder?.heldQuantity ?? ZERO;
  return state.position.quantity;
}

/**
 * Refuse to release a bot's capital while it is still holding inventory.
 *
 * THE PROBLEM THIS EXISTS FOR, stated as money rather than as a rule.
 * `releaseBotCapital` returns exactly `allocated_capital` to the account's
 * available pool -- the reservation, whatever the position ended up being worth
 * (ledger.ts's header). `close()` cancels open ORDERS but does not flatten the
 * POSITION: `#closePass` calls `#cancelOpenOrders` and nothing else, and
 * `accountTotals.ts` already documents the consequence ("a stopped bot can
 * genuinely still be holding inventory") and lets `idle` go negative to show it.
 *
 * So closing a bot that holds 0.4 BTC hands its full quote allocation back to
 * the pool as if it were cash. It is not cash; it is BTC. The next bot created
 * spends capital that exists only as somebody else's inventory, and nothing in
 * the ledger can tell -- `total_allocated` is a reservation count, not a
 * valuation, and reconciliation's `ledger_allocation_drift` compares it against
 * the SUM OF RESERVATIONS, so it agrees with itself and reports nothing wrong.
 *
 * IT REFUSES; IT NEVER SELLS. The operator liquidates by hand first, through the
 * existing control. Both strategies deliberately decline to sell a held position
 * on their own (DCA's `sellOnStopLoss` is refused outright, grid's stop-loss
 * liquidates only for its own three exit reasons), and `liquidatePosition`'s
 * header calls itself "the deliberate, human-triggered counterpart" to exactly
 * that. A gate that auto-sold to get itself unblocked would be the one thing
 * every one of those decisions was written to prevent.
 *
 * WHY IT IS SKIPPED FOR AN ALREADY-`stopped` BOT. There is nothing left to
 * protect: its capital was released when it stopped, so refusing could not
 * prevent a release, it could only strand the bot. And `liquidatePosition`
 * requires `halted` -- so a stopped bot cannot take the action this error tells
 * it to take, and gating it would print an instruction it is unable to follow.
 */
function assertFlatBeforeRelease(
  row: BotInstanceRow,
  snapshot: BotSnapshot | null,
  action: string,
): void {
  // Nothing to release, and no route to the remedy. See above.
  if (row.status === "stopped") return;
  // An orphan (a row whose object holds no state) cannot answer, and cannot be
  // closed either -- `close()` reaches `#config()`, which throws `not_created`.
  // The caller skips the release for one entirely; see `archiveBot`.
  if (snapshot === null) return;

  const held = heldQuantityOf(snapshot);
  if (held <= ZERO) return;

  throw new ApiError(
    409,
    "position_held",
    `bot instance ${JSON.stringify(row.id)} still holds ${toDecimalString(held)} of the base ` +
      `asset of ${row.pair}, so ${action} would return its full ` +
      `${toDecimalString(row.allocated_capital)} ${row.capital_asset} allocation to the account ` +
      `while that capital is still sitting in inventory rather than in cash. Liquidate the ` +
      `position first (the bot must be halted to do so), then try again. Nothing was changed, ` +
      `and nothing was sold -- selling is never done on your behalf.`,
  );
}

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
  capitalReleased = false,
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
    // `status` is the status the GATE WAS CHECKED AGAINST -- read before this
    // action ran, and deliberately not re-read. Since archiving now closes the
    // bot, the row is very often `stopped` by the time this row is written, and
    // recording that would lose the only evidence of what was actually gated.
    // `capital_released` is the other half: whether THIS action performed the
    // release, which `status` alone can no longer answer (a bot archived while
    // already stopped, and an orphan that could not be closed, both end at
    // `stopped`/`halted` with no release having happened here). The two together
    // are what makes an archive entry readable years later; neither is
    // recoverable from the row afterwards.
    details_json: {
      status: row.status,
      account_label: row.account_label,
      capital_released: capitalReleased,
    },
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
 * POST /api/bots/:id/archive -- retire a finished bot AND return its capital.
 *
 * ⚠ WHAT THIS ENDPOINT MEANS CHANGED HERE, ON PURPOSE. Until this step it wrote
 * one boolean and nothing else, and said so everywhere -- step 26's migration,
 * this handler's own header, and the dialog copy all promised that "archiving is
 * not closing" and that the allocation was untouched. That promise is now
 * DELIBERATELY BROKEN for the flat case, at the operator's decision: an archived
 * bot is a finished bot, and capital reserved for a finished bot is capital no
 * new bot can use. Archiving now performs the `stopped` transition through
 * `close()` and the allocation genuinely returns to the account.
 *
 * The old guarantee is not gone, it is SPLIT, and both halves are deliberate:
 *   - Nothing is DELETED, still, and still structurally: `Repository` exposes no
 *     `delete` and `no-raw-d1.test.ts` forbids routing around it. Every order,
 *     trade, alert, audit entry, and the object's own config, position and order
 *     history survive exactly as before. An archived bot is a permanent,
 *     read-only record. That half of "archiving removes nothing" is unchanged.
 *   - The STATUS and the ALLOCATION now do change, from `halted` to `stopped`
 *     and from reserved to returned. That half is new.
 * `api.test.ts` carries both halves as two named tests rather than one, so the
 * split reads as intent rather than as a test somebody weakened.
 *
 * THE ORDER IS: gate, then close, then set the flag. Never the reverse.
 * Every partial failure must leave the bot MORE visible, not less. If `close()`
 * succeeds and the flag write then fails, the operator sees a `stopped` bot
 * still on the list and clicking Archive again finishes the job (the close is
 * skipped for a bot that is already stopped, so the retry is safe). If the flag
 * were written first, a failed close would leave a HIDDEN bot silently still
 * holding its allocation -- capital lost from the pool with nothing on screen to
 * say so, which is precisely the outcome migration 0007 called "the one outcome
 * archiving must never produce".
 *
 * GATED ON A FLAT POSITION (`position_held`, 409). `close()` cancels open orders
 * but does not sell what the bot is holding, so releasing capital from a bot
 * still carrying inventory would return capital that is not cash. The operator
 * liquidates by hand first. See `assertFlatBeforeRelease` for the full argument;
 * nothing here ever sells.
 *
 * STILL GATED ON `halted` OR `stopped`, read from the D1 ROW rather than the
 * object's snapshot, unchanged from step 26 and for its original reason: an
 * ORPHANED bot (a row whose object holds no state) must stay archivable, and a
 * snapshot-authoritative gate could not answer for one.
 *
 * ⚠ AN ORPHAN IS ARCHIVED WITHOUT ITS CAPITAL BEING RELEASED, and that is a
 * known, deliberate gap rather than an oversight. `close()` reaches `#config()`,
 * which throws `not_created` when the object holds no state -- so an orphan
 * CANNOT be closed, and calling it would turn step 26's "an orphan must still be
 * archivable" guarantee into a 404. Its allocation therefore stays reserved.
 * That is the safe direction by this codebase's own rule (ledger.ts: "Every
 * partial failure then leaves capital over-reserved rather than under-reserved.
 * The bad outcome is losing access to capital you own, which a human can see in
 * the audit log and correct"), and `reconcileAllocations` keeps counting it
 * because the row is not `stopped`, so the books stay consistent. The response
 * says `capitalReleased: false` so the caller is never told otherwise.
 *
 * Idempotence is unchanged: a second archive reports `already_archived`, writes
 * no second audit entry, and -- because the bot is `stopped` by then -- attempts
 * no second release.
 *
 * Failures:
 *   - `unknown_bot` (404)     -- no such row.
 *   - `invalid_status` (409)  -- the bot is `running` or `created`.
 *   - `position_held` (409)   -- it still holds inventory; liquidate first.
 *   - anything `close()` raises, which reaches the operator unflattened.
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
        `bot can be archived. Archiving closes the bot and returns its capital, and doing that to ` +
        `a live bot would pull the funding out from under orders it is still placing.`,
    );
  }

  // Everything below is skipped for a bot that is ALREADY archived, so a repeat
  // stays the pure no-op it has always been: no snapshot read, no gate, no
  // second close, no second audit entry.
  let capitalReleased = false;
  if (!row.archived && row.status !== "stopped") {
    const snapshot = await snapshotOf(ctx, id);
    assertFlatBeforeRelease(row, snapshot, "archiving it");
    // An orphan is archived without a release; see the header. `snapshot` is the
    // only thing that can tell us, and it already told us.
    if (snapshot !== null) {
      await botStub(ctx, id).close(ctx.actor);
      capitalReleased = true;
    }
  }

  const changed = await setArchived(ctx, row, true, capitalReleased);
  return ok({
    result: {
      action: changed ? ("archived" as const) : ("already_archived" as const),
      /**
       * Whether THIS call returned the allocation to the account. False for a
       * repeat, for a bot that was already `stopped`, and for an orphan -- three
       * different reasons the caller must not have to infer from the status.
       */
      capitalReleased,
    },
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
 * One account's `capital_ledger` headroom, or null if the ledger could not be
 * read.
 *
 * NULL MEANS "UNREADABLE", NEVER "EMPTY". An account nobody has seeded has no
 * ledger rows at all and gets `{ rowsRead: 0, assets: [] }` -- a real, common
 * state (`ledger.ts` creates no row automatically), and a different fact from a
 * D1 failure. Collapsing the two would tell a human "this account can fund
 * nothing" about a read that never happened, which is section 5.6's rule and
 * the exact distinction `readAccountCapital` refuses to blur.
 *
 * The failure is swallowed rather than surfaced as a 502 because THIS ENDPOINT
 * IS THE CREATE-BOT FORM'S ACCOUNT DROPDOWN. An unreadable ledger is a reason
 * to withhold one display figure; it is not a reason to take bot creation
 * offline. Only `ResearchCapitalError` is caught -- anything else is a bug in
 * this layer and still escapes.
 */
async function accountCapitalOrNull(ctx: ApiContext, accountLabel: string) {
  try {
    return accountCapitalView(await readAccountCapital(ctx.db, accountLabel, ctx.now));
  } catch (cause) {
    if (cause instanceof ResearchCapitalError) return null;
    throw cause;
  }
}

/**
 * GET /api/accounts -- every registered account, its exchange, and its
 * `capital_ledger` headroom per asset.
 *
 * The registry the dashboard's create-bot dropdown reads: a real list of
 * accounts to choose from, each with the venue it trades on. Ordered by label so
 * the dropdown is stable.
 *
 * THE CAPITAL BLOCK IS READ-ONLY DISPLAY, and it reuses `readAccountCapital`
 * (`src/research/capital.ts`) rather than restating its arithmetic: that module
 * already performs exactly this read, already documents why `available` may be
 * negative, and -- as its header says in the plainest terms it has -- "writes no
 * row, takes no reservation, touches no `total_allocated`, and holds no lock".
 * Nothing here allocates, reserves or checks anything.
 *
 * `available = total_balance - total_allocated` is NOT a new calculation. It is
 * the same subtraction `createBotInstanceWithCapital` performs as its binding
 * gate, so the figure published here is precisely the one that decides whether a
 * new bot can be created -- which is what makes it worth showing rather than
 * making a human do it by hand.
 *
 * ⚠ TWO WAYS THIS FIGURE IS MOMENTARILY IMPRECISE, IN OPPOSITE DIRECTIONS.
 * Neither is a bug, and neither changes the formula; both are properties of what
 * the two columns MEAN. A future reader who finds the number slightly off should
 * read these before going looking for an arithmetic error.
 *
 *   A. IT CAN OVERSTATE. `reconcileBalances` folds `manual_adjustments` into
 *      `total_balance` only when it consumes them (it queries
 *      `reconciled_at: null` and marks them in the same batch). A withdrawal
 *      logged through `POST /api/manual-adjustments` is therefore invisible here
 *      until the next reconciliation run, and headroom reads high until then.
 *
 *   B. IT CAN UNDERSTATE. Reconciliation writes `total_balance` as the
 *      exchange's `free + locked` FOR THIS ASSET. Once a bot spends quote
 *      currency on inventory, that cash has left `total_balance` while the bot's
 *      full reservation still sits in `total_allocated` -- so the deployed
 *      portion is subtracted twice, and headroom reads low by that amount.
 *
 * The subtraction is per (account, asset) and is never summed across either: a
 * bot draws from one `capital_ledger` row, so a total spanning two accounts
 * would be a number nothing can spend.
 *
 * ONE LEDGER READ PER ACCOUNT, sequentially. `readAccountCapital` filters by
 * `account_label`, and the alternative -- one unfiltered `findMany` grouped here
 * -- would be this layer restating the read that module owns, which is the
 * duplication being avoided. The account registry is human-sized (section 4.4),
 * so the cost is bounded by how many accounts a person has registered.
 */
export async function listAccounts(ctx: ApiContext): Promise<Response> {
  const rows = await ctx.db.accounts.findMany({
    orderBy: [{ column: "account_label", direction: "asc" }],
  });

  const views = [];
  for (const row of rows) {
    views.push({
      accountLabel: row.account_label,
      exchange: row.exchange,
      createdAt: row.created_at,
      capital: await accountCapitalOrNull(ctx, row.account_label),
    });
  }
  return ok(views);
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
// Gather (section 21.4, Stage 1 assembly)
// ---------------------------------------------------------------------------

/** The three doors `CandidateEntryPoint` declares, for parsing a query string. */
const GATHER_ENTRY_POINTS: readonly CandidateEntryPoint[] = ["named", "general", "watchlist"];

/**
 * The ports Stage 1 assembly needs, wired to the SAME reals every other
 * research endpoint uses.
 *
 * `tradablePairsFor` is the cached `listAccountSymbols` the watchlist writes and
 * the candles endpoint read through; `candleSourceFor` is the uncached
 * per-account lister. Reused rather than reached for directly, so a gather and a
 * single-pair candle fetch cannot disagree about what the venue lists, and so N
 * candidates cost N candle requests and NOT N full-catalogue requests on top.
 *
 * That second point is the one this endpoint exists to measure: see the handler.
 */
function gatherPorts(ctx: ApiContext): GatherPorts {
  return {
    db: ctx.db,
    listTradablePairs: tradablePairsFor(ctx),
    getCandles: candleSourceFor(ctx),
    now: ctx.now,
  };
}

/**
 * The ports the permanent proposal record needs (21.5 requirement 5).
 *
 * `ctx.newId` and `ctx.now` -- the same injected clock and id source
 * `watchlistPorts` uses, so a test drives a deterministic proposal id and
 * timestamp exactly as it drives a watchlist entry's. Nothing here reaches for
 * `crypto.randomUUID` or `Date.now` directly.
 */
function proposalLogPorts(ctx: ApiContext): ProposalLogPorts {
  return { db: ctx.db, now: ctx.now, newId: ctx.newId };
}

/**
 * A comma-separated query parameter as a list, or undefined when absent.
 *
 * Blank entries are dropped rather than refused: `?quoteAssets=USD,` is a shell
 * artefact, not a request for a quote asset named "". A present-but-entirely-
 * blank value IS refused, because that is someone meaning something by it.
 */
function optionalCsv(ctx: ApiContext, name: string): readonly string[] | undefined {
  const raw = ctx.url.searchParams.get(name);
  if (raw === null) return undefined;
  const values = raw.split(",").map((value) => value.trim()).filter((value) => value !== "");
  if (values.length === 0) {
    throw badRequest(
      "invalid_field",
      `query parameter ${JSON.stringify(name)}, if given, must name at least one value`,
    );
  }
  return values;
}

/**
 * GET /api/accounts/:label/gather -- Stage 1's assembled bundle, over the wire.
 *
 * The curl-able surface over `gatherCandidateData` / `gatherCandidateSetData`
 * (section 21.4 Stage 1, `/src/research/gather.ts`), and like the candles
 * endpoint it exists for a reason beyond convenience: decision log 35 closed
 * with an open question that no test can answer, because every test in this
 * repository drives an injected `CandleSource`. `gatherCandidateSetData` is the
 * first thing here that issues N venue candle requests under ONE caller's
 * request, and whether that is survivable against a real venue is a fact about
 * production. This endpoint is how that gets measured. Log 35 deferred it until
 * a real caller existed rather than inventing one to generate load; this is that
 * caller, and the measurement is now against the shape that will actually run.
 *
 * A THIN WRAPPER in the strict sense this layer means it. The assembly, the
 * per-input isolation, the one-read-for-N-candidates design, the quote-asset
 * merge and every failure state live in `gather.ts` and candidate selection
 * lives in `candidates.ts`; none of it is re-implemented, re-ordered or
 * second-guessed here. What this adds is query parsing, the port wiring, and the
 * serialization of a shape that contains bigints in two places.
 *
 * READ-ONLY. No write, no audit entry, no state. The Access gate still applies.
 *
 * ── THE THREE DOORS ──
 *
 *   `?entryPoint=named&pair=X`  ONE candidate, through `selectNamedCandidate`,
 *                               then `gatherCandidateData`. `pair` required.
 *   `?entryPoint=watchlist`     The operators' watchlist, through
 *                               `selectWatchlistCandidates`, then
 *                               `gatherCandidateSetData`. THE ONE THAT ANSWERS
 *                               THE OPEN QUESTION: 21.3 bounds the watchlist at
 *                               5-10 coins, so this is the N-candidate run.
 *   `?entryPoint=general`       REFUSED, 503, before any work. See below.
 *
 * ── WHY `general` REFUSES RATHER THAN RUNS ──
 *
 * `selectGeneralCandidates` requires a `TrendingSource`, and NO VENDOR HAS BEEN
 * CHOSEN (decision logs 30 and 31): there is no trending client anywhere in this
 * repository outside a test stub. The refusal is raised HERE, before the
 * registry read and before anything else, rather than by handing the module a
 * stub that fails -- and that distinction is the same one `NEWS_NOT_YET_AVAILABLE`
 * draws one layer down. A stub that returned a failed `ExchangeOutcome` would
 * produce `trending_unavailable`, which says a pull was attempted and did not
 * answer. No pull was attempted. There is nothing to attempt it with, and a
 * message implying a transient vendor outage would send an operator to check a
 * vendor's status page for a vendor this project has never had.
 *
 * `interval` is NOT parsed before this refusal, deliberately: a general request
 * must fail for the reason it actually fails for, not for a missing parameter it
 * would also have needed.
 *
 * ── WHAT COMES BACK ──
 *
 * A discriminated shape keyed on `entryPoint`, so the two gather functions'
 * genuinely different return types stay distinguishable rather than being forced
 * into one flattened object:
 *
 *   `{ entryPoint: "named",     selectedAt, bundle: CandidateGatherBundle }`
 *   `{ entryPoint: "watchlist", set: CandidateSetGatherBundle }`
 *
 * EVERY INPUT'S OWN OUTCOME IS ON THE WIRE -- `ok` / `failed` /
 * `threw_unexpectedly` / `not_yet_available` -- with each failure carrying the
 * producing module's own `code` and each success carrying its own `fetchedAt` or
 * `readAt`. There is deliberately NO top-level success flag: a 200 here means
 * "assembly ran", never "every input worked", and the whole point of the shape
 * is that a human can see WHICH inputs succeeded. Collapsing that into a boolean
 * is the one thing this endpoint must not do.
 *
 * A 200 WITH EVERY SLOT FAILED IS A CORRECT RESPONSE, and callers must not treat
 * the status as the answer.
 *
 * Failures (the request itself, as opposed to an input):
 *   - `missing_field` (400)            -- no `entryPoint`, no `interval`, or a
 *                                         named request with no `pair`.
 *   - `invalid_filter` (400)           -- `entryPoint` or `interval` is not one.
 *   - `invalid_field` (400)            -- `since`/`quoteAssets` malformed, or a
 *                                         `pair` sent to a door that has no use
 *                                         for one (refused, never ignored).
 *   - `no_trending_vendor` (503)       -- `entryPoint=general`. See above.
 *   - `unknown_account` (404)          -- no such registered account.
 *   - `pair_not_tradable` (400)        -- named, and the venue does not list it.
 *   - `pair_not_spot_by_name` (400)    -- named, and its name says perp.
 *   - `tradable_set_unreadable` (503)  -- named, and the venue could not be asked.
 *
 * The candle and concentration codes are deliberately ABSENT from that list.
 * They are not request failures here: a failed candle fetch is a recorded state
 * on one slot of a 200, which is exactly what `gather.ts` exists to guarantee
 * and the opposite of what the candles endpoint does with the identical error.
 */
export async function getAccountGather(ctx: ApiContext): Promise<Response> {
  const label = ctx.params.label!;

  const entryPoint = ctx.url.searchParams.get("entryPoint");
  if (entryPoint === null || entryPoint.trim() === "") {
    throw badRequest(
      "missing_field",
      `query parameter "entryPoint" is required and must be one of ${GATHER_ENTRY_POINTS.join(", ")}`,
    );
  }
  if (!GATHER_ENTRY_POINTS.includes(entryPoint as CandidateEntryPoint)) {
    throw badRequest(
      "invalid_filter",
      `entryPoint must be one of ${GATHER_ENTRY_POINTS.join(", ")}, not ${JSON.stringify(entryPoint)}`,
    );
  }

  // Before the registry read, before the interval parse, before anything. See
  // the docblock: the honest refusal is "there is no vendor", and it must not be
  // reachable only after some other parameter happens to be well formed.
  if (entryPoint === "general") {
    throw new ApiError(
      503,
      "no_trending_vendor",
      `the general entry point needs a live trending pull (21.3) and NO TRENDING VENDOR HAS ` +
        `BEEN CHOSEN, so there is nothing to call: no client for any vendor exists in this ` +
        `system and this project holds no key for one (see docs/decision-log/30.md and 31.md). ` +
        `This is NOT a vendor outage and retrying will not help -- no request was attempted. ` +
        `selectGeneralCandidates deliberately refuses to fall back to the watchlist alone, ` +
        `because a general run that quietly becomes a watchlist re-read is a degraded result ` +
        `indistinguishable from a good one (21.5 requirement 6). To gather over the ` +
        `operators' watchlist, ask for it by name: entryPoint=watchlist.`,
    );
  }

  const interval = ctx.url.searchParams.get("interval");
  if (interval === null || interval.trim() === "") {
    throw badRequest(
      "missing_field",
      `query parameter "interval" is required and must be one of ${CANDLE_INTERVALS.join(", ")}. ` +
        `There is no default: a wrong interval returns correctly-shaped candles of a DIFFERENT ` +
        `duration, which passes every type check and which no downstream reader can detect.`,
    );
  }
  if (!CANDLE_INTERVALS.includes(interval as CandleInterval)) {
    throw badRequest(
      "invalid_filter",
      `interval must be one of ${CANDLE_INTERVALS.join(", ")}, not ${JSON.stringify(interval)}`,
    );
  }

  // The same strict parse the candles endpoint uses, and for the same reasons:
  // `Number("")` is 0, not NaN, so `?since=` would silently mean "since the
  // epoch"; `Number("12abc")` is NaN, which would filter every candle out and
  // blame the venue for the query.
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

  const quoteAssets = optionalCsv(ctx, "quoteAssets");
  const request: GatherRequest = {
    interval: interval as CandleInterval,
    ...(since === undefined ? {} : { since }),
    ...(quoteAssets === undefined ? {} : { quoteAssets }),
  };

  const pair = ctx.url.searchParams.get("pair");
  const ports = gatherPorts(ctx);

  if (entryPoint === "named") {
    if (pair === null || pair.trim() === "") {
      throw badRequest(
        "missing_field",
        `query parameter "pair" is required for entryPoint=named and must be the venue's own ` +
          `symbol, exactly as GET /api/accounts/${label}/symbols reports it`,
      );
    }
    const set = await selectNamedCandidate(ports, {
      accountLabel: label,
      pair,
      // The layer's standing rule: the actor is the email VERIFIED off the
      // Access token, never a caller-supplied string. It lands on the
      // candidate's own source as `requestedBy` (21.5 requirement 2).
      requestedBy: ctx.actor,
    });
    // `selectNamedCandidate` returns a one-candidate set by construction, and
    // this is the one place that fact is relied on. Read rather than asserted:
    // the set exists because selection succeeded, and selection's failures are
    // throws that never reach here.
    const bundle = await gatherCandidateData(ports, set.candidates[0]!, request);
    return ok({
      entryPoint: "named" as const,
      // The only set-level fact a single bundle does not already carry. The
      // rest -- account, exchange, who asked, when they asked -- is on the
      // candidate and its source.
      selectedAt: set.selectedAt,
      bundle: candidateGatherBundleView(bundle),
    });
  }

  // `pair` has no meaning for a watchlist run: the pairs ARE the watchlist. It
  // is refused rather than ignored, the same stance `addWatchlistEntry` takes
  // with a body-supplied `actor` -- silently dropping a parameter a caller
  // clearly meant something by is how someone concludes this endpoint filtered
  // when it did not.
  if (pair !== null) {
    throw badRequest(
      "invalid_field",
      `query parameter "pair" is only valid with entryPoint=named. A watchlist run gathers ` +
        `every live watchlist entry for this account, so a pair here would be ignored -- and ` +
        `an ignored parameter reads exactly like a filter that was applied.`,
    );
  }

  const set = await selectWatchlistCandidates(ports, {
    accountLabel: label,
    requestedBy: ctx.actor,
  });
  const bundle = await gatherCandidateSetData(ports, set, request);
  return ok({ entryPoint: "watchlist" as const, set: candidateSetGatherBundleView(bundle) });
}

// ---------------------------------------------------------------------------
// Section 21.4 Stage 2 (Assess)
// ---------------------------------------------------------------------------

/**
 * GET /api/accounts/:label/assess -- gather ONE named candidate and assess it.
 *
 * The first endpoint that runs a model. It is deliberately the SMALLEST one that
 * can: a single named pair, one gather, one assess, one response.
 *
 * ── WHY ONE CANDIDATE, AND NOT THE WATCHLIST ──
 *
 * Assess costs 10.5-20.3 s per call across the four live samples this project
 * has taken (decision logs 37, 39). A watchlist run is 5-10 candidates plus a
 * trending pull, so a synchronous multi-candidate request is minutes long and is
 * a DIFFERENT DESIGN PROBLEM -- queued, or streamed, or chunked -- rather than a
 * variant of this one. This endpoint answers "does one real candidate work end
 * to end". `entryPoint` is fixed to `named` and there is no batch parameter to
 * grow one accidentally.
 *
 * ── THE DURATION QUESTION, SETTLED BEFORE BUILDING ──
 *
 * A 10-20 s handler is safe here, and that is checked rather than assumed.
 * Cloudflare documents HTTP-triggered Workers as having **no wall-clock duration
 * limit** ("no hard limit ... as long as the client remains connected"), and CPU
 * time -- the limit that does exist, 30 s by default on Workers Paid -- excludes
 * time spent waiting on network requests. A Workers AI call is almost entirely
 * that wait. See the session notes for the full citation and the one real
 * caveat: a runtime update gives in-flight requests a 30-second grace period,
 * which a 20 s request could in principle collide with.
 *
 * ── WHAT FAILS THE REQUEST, AND WHAT MERELY GETS REPORTED ──
 *
 * The rule is: **the model is asked only when the question can be grounded, and
 * every other gather failure is REPORTED rather than propagated.**
 *
 *   * NO CANDLE WINDOW -> the request fails (`no_price_history`, 503).
 *     `assessCandidate` refuses before spending a model call, and this endpoint
 *     does not work around that. A strategy pick with no prices could only come
 *     from training knowledge, which 21.5 requirement 1 forbids.
 *   * CONCENTRATION FAILED, or the paused news slot -> the assessment RUNS, and
 *     the failure is stated to the model as missing (`buildAssessPrompt`) and
 *     returned verbatim in `bundle.concentration`. Refusing here would be the
 *     over-propagation `gather.ts` exists to avoid: losing a usable, grounded
 *     strategy assessment because an unrelated D1 read failed. The human still
 *     sees the gap, prominently, in the same response.
 *
 * A model that answers badly is NOT a degraded success: `AssessParseError`
 * becomes a 502 with the parser's own code, because the upstream answered and
 * its answer was unusable -- exactly what `candles_unavailable` means one stage
 * earlier.
 *
 * ── IT LOGS EVERY SUCCESSFUL CALL, AUTOMATICALLY (21.5 requirement 5) ──
 *
 * A real proposal record is written to `proposals` (migration 0009) with the FULL
 * gather bundle as its inputs and the prompt, settings, raw model response and
 * parsed answer as its reasoning, plus an `audit_log` entry, in one atomic batch.
 * There is no flag to turn it off and no separate action to invoke: the signal
 * 21.5 wants is a RATE over proposals GENERATED, and an opt-in denominator is a
 * biased one. `proposal-log.ts`'s header argues that in full.
 *
 * `proposalId` is on the response so a human can name this proposal later -- and,
 * for a `/derive` proposal, hand it to `POST /api/bots` as the outcome link.
 *
 * ⚠ A FAILED RECORD WRITE FAILS THIS REQUEST, and the model call has already been
 * paid for by then. That is requirement 6's terms applied to requirement 5:
 * returning a proposal that is not in the permanent record, to a human with no way
 * to tell, is a degraded result indistinguishable from a good one. The cost is
 * real and is stated rather than traded away.
 *
 * WHAT IS STILL NOT PERSISTED: nothing about a FAILED run. A parse refusal, a
 * missing precondition or an unusable answer writes no row, because 21.5 logs
 * every proposal GENERATED and a refusal generated none -- so the REFUSAL RATE is
 * not measurable from this table. See `proposal-log.ts`.
 */
export async function getAccountAssess(ctx: ApiContext): Promise<Response> {
  const label = ctx.params.label!;

  const pair = ctx.url.searchParams.get("pair");
  if (pair === null || pair.trim() === "") {
    throw badRequest(
      "missing_field",
      `query parameter "pair" is required and must be the venue's own symbol, exactly as ` +
        `GET /api/accounts/${label}/symbols reports it`,
    );
  }

  // Required with no default, for the reason `getAccountGather` and
  // `fetchCandleWindow` both give: a wrong interval does not error, it returns
  // correctly-shaped candles of a DIFFERENT duration that no reader downstream
  // can distinguish -- and here that would reach a model as fact.
  const interval = ctx.url.searchParams.get("interval");
  if (interval === null || interval.trim() === "") {
    throw badRequest(
      "missing_field",
      `query parameter "interval" is required and must be one of ${CANDLE_INTERVALS.join(", ")}. ` +
        `There is no default: a wrong interval returns correctly-shaped candles of a DIFFERENT ` +
        `duration, which passes every type check and which no downstream reader can detect.`,
    );
  }
  if (!CANDLE_INTERVALS.includes(interval as CandleInterval)) {
    throw badRequest(
      "invalid_filter",
      `interval must be one of ${CANDLE_INTERVALS.join(", ")}, not ${JSON.stringify(interval)}`,
    );
  }

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

  const request: GatherRequest = {
    interval: interval as CandleInterval,
    ...(since === undefined ? {} : { since }),
    ...(() => {
      const quoteAssets = optionalCsv(ctx, "quoteAssets");
      return quoteAssets === undefined ? {} : { quoteAssets };
    })(),
  };

  const ports = gatherPorts(ctx);
  const set = await selectNamedCandidate(ports, {
    accountLabel: label,
    pair,
    // The layer's standing rule: the actor is the email VERIFIED off the Access
    // token, never a caller-supplied string (21.5 requirement 2).
    requestedBy: ctx.actor,
  });
  const bundle = await gatherCandidateData(ports, set.candidates[0]!, request);

  const model = ctx.assessModel ?? envAssessModel(ctx.env);

  const startedAt = ctx.now();
  let result: AssessResult;
  try {
    result = await assessCandidate(model, bundle);
  } catch (error) {
    // The parser's twenty codes share one status but keep their OWN code on the
    // wire -- a second vocabulary restating them would drift, which is the rule
    // `GatheredInput` follows one layer down. 502 because the model answered and
    // its answer was unusable, the same distinction `candles_unavailable` draws
    // against `tradable_set_unreadable`.
    if (error instanceof AssessParseError) {
      throw new ApiError(502, error.code, error.message);
    }
    // `assessCandidate` refuses a bundle with no usable candle window, and its
    // code says only THAT -- `no_price_history` -- because at that layer the
    // reason is genuinely not known. Here it is: the candle slot is right there
    // carrying the producing module's own error. Reporting the proximate cause
    // when the real one is in hand would send an operator to look at prices when
    // the actual answer is "you asked for an interval this system has never
    // verified". So the underlying code and message are surfaced, with the
    // precondition itself UNCHANGED and unbypassed -- `assessCandidate` is still
    // what refused, and it still ran before any model call.
    if (error instanceof AssessError && bundle.candles.outcome === "failed") {
      const cause = bundle.candles.error;
      throw new ApiError(
        statusForCode(cause.code, 502),
        cause.code,
        `${cause.message} -- so no assessment was attempted for ${bundle.candidate.pair}: ${error.message}`,
      );
    }
    throw error;
  }
  const latencyMs = ctx.now() - startedAt;

  // ONE rendering, used for BOTH the record and the response, so what was stored
  // and what the human is shown cannot differ. See `assessProposalInputsView`.
  const inputs = assessProposalInputsView(result, set.selectedAt);
  const reasoning = assessProposalReasoningView(result, latencyMs);

  // 21.5 requirement 5. Automatic, unconditional, and fail-closed: a write that
  // throws fails this request rather than returning an unrecorded proposal.
  const record = await logAssessProposal(proposalLogPorts(ctx), result, {
    entryPoint: "named",
    actor: ctx.actor,
    inputs,
    reasoning,
  });

  return ok({
    entryPoint: "named" as const,
    selectedAt: set.selectedAt,
    /** The permanent record's id (21.5 requirement 5). Name it to reject this proposal. */
    proposalId: record.id,
    // The bundle travels WITH the assessment, never instead of it: every input's
    // real state, including any that failed, beside the answer drawn from them
    // (21.5 requirement 2's "display the actual raw data it used").
    bundle: inputs.bundle,
    assess: assessResultView(result, latencyMs),
  });
}

// ---------------------------------------------------------------------------
// Section 21.4 Stage 3 (Derive)
// ---------------------------------------------------------------------------

/**
 * Stage 3's ports: `gatherPorts` plus the one-symbol details read.
 *
 * COMPOSED from the real wiring rather than rebuilt. `gatherPorts` supplies the
 * cached `tradablePairsFor` and the uncached `candleSourceFor` that `/gather`,
 * `/candles` and `/assess` all go through, and `symbolDetailsFor` is the same
 * `SymbolDetailSource` bot creation's spot-instrument gate uses. So a derivation
 * cannot reach a different venue, a different cache or a different account
 * resolution than the assessment it is derived from did.
 *
 * The deleted Stage 3 probe rebuilt these three adapters locally, which was
 * correct FOR A PROBE -- it meant deleting the probe left nothing behind, since
 * exporting `handlers.ts`'s private adapters for a temporary file would have
 * been a permanent widening. A real endpoint has the opposite requirement and
 * uses the real thing.
 */
function deriveContextPortsFor(ctx: ApiContext): DeriveContextPorts {
  return { ...gatherPorts(ctx), getSymbolDetails: symbolDetailsFor(ctx) };
}

/**
 * GET /api/accounts/:label/derive -- derive parameters for a PREVIOUSLY-RETURNED
 * Stage 2 result, re-verified against evidence gathered now.
 *
 * ── THE ONE THING THIS ENDPOINT DOES THAT NOTHING ELSE HAS ──
 *
 * Every earlier exercise of Stage 3 fed Assess's output into Derive INSIDE ONE
 * REQUEST: step 41's probe made a real Assess call and passed the resulting
 * object straight down the call stack. This endpoint accepts an assessment that
 * came from an EARLIER, SEPARATE HTTP CALL -- the client held it, real time
 * passed, and it arrives as untrusted text. That is the whole of the new
 * surface; the prompt building, the citation machinery, the real decoders, the
 * real validators and the venue-floor check are all step 41's, unchanged.
 *
 * ── IT DOES NOT TRUST THE RESUBMISSION, AND IT DOES NOT PERSIST TO AVOID IT ──
 *
 * There are two ways to stop a caller inventing an assessment. One is to have
 * stored it, so the resubmission is only an id. The other is to re-verify it
 * against reality. **THIS ENDPOINT DOES THE SECOND, AND THE CHOICE IS
 * DELIBERATE.**
 *
 * `parseResubmittedAssessment` resolves every citation in the submitted claims
 * against the evidence set THIS run's freshly-gathered bundle emits -- not
 * against whatever existed when `/assess` ran. An id that was real then and is
 * not real now is refused exactly as a fabricated one is, because the guarantee
 * being offered is about the evidence a human will read on this screen, not
 * about the caller's honesty. The strategy is likewise re-checked against the
 * two literals `dca` and `grid` rather than trusted to be one of them.
 *
 * ── THE RECORD NOW EXISTS, AND IT STILL DOES NOT BRIDGE THE TWO CALLS ──
 *
 * 21.5 requirement 5's permanent proposal record is built (migration 0009,
 * `proposal-log.ts`), and this endpoint writes one row per successful call: the
 * full bundle, Stage 3's capital and filter reads, and the re-verified
 * resubmitted assessment as its INPUTS; the prompt, settings, raw response and
 * validated parameter set as its REASONING. Plus an `audit_log` entry, in one
 * atomic batch. `proposalId` comes back on the response, and it is what
 * `POST /api/bots` takes as its optional `proposalId` to record an approval.
 *
 * **AND STILL NO D1 ROW, NO KV KEY AND NO CACHE BRIDGES THE TWO CALLS.** The
 * client holds the Stage 2 result and hands it back, exactly as before. The
 * record is written AFTER the work, as an audit trail; it is not an input to the
 * next request, and there is deliberately no `?proposalId=` alternative to
 * `?assessment=` here.
 *
 * That is unchanged because the reason was never "the record does not exist yet".
 * There are two ways to stop a caller inventing an assessment -- store it so the
 * resubmission is only an id, or re-verify it against reality -- and this endpoint
 * does the second, so storage never answered a question this endpoint had.
 * Accepting a `proposalId` here would ALSO be strictly weaker: a stored
 * assessment's citations still have to be re-resolved against the evidence
 * gathered NOW (decision log 42, check 7 -- a real citation aged out of a real
 * shallower window, live and unprompted), so the id would replace an untrusted
 * payload with an untrusted pointer and change nothing about what must be checked.
 *
 * ⚠ WHAT IS NOT LINKED: the derive record does not carry the id of the assess
 * record it derives from, because nothing in the request carries that link and an
 * `assessProposalId` taken from the caller would be a client-asserted claim this
 * system cannot verify -- the same class as `envelope` and `duplicateKeyCheck`.
 * Each row is independently complete, so a trace never needs the join. Recorded in
 * migration 0009's header as a stated limitation rather than a gap discovered later.
 *
 * ⚠ A FAILED RECORD WRITE FAILS THIS REQUEST, after the inference is paid for.
 * See `getAccountAssess` and `proposal-log.ts` for why that is requirement 6's
 * terms rather than a harsh default.
 *
 * ── WRITES NOTHING, ALLOCATES NOTHING (21.1) ──
 *
 * `allocatedCapital` in the response is a PREFILL a human confirms. No capital
 * is reserved, `total_allocated` is untouched, no bot is created and no Durable
 * Object is brought into existence. The binding capital check is
 * `createBotInstanceWithCapital`'s, against the ledger as it stands at creation.
 *
 * ── THE PARAMETERS ──
 *
 *   `pair`, `interval`   required, no defaults, exactly as `/assess` -- a wrong
 *                        interval returns correctly-shaped candles of a
 *                        DIFFERENT duration that no reader downstream can
 *                        detect, and here it would reach a model as fact.
 *   `since`, `quoteAssets` optional, parsed by the same strict rules.
 *   `assessment`         REQUIRED. The URL-encoded JSON object a previous
 *                        `/assess` returned, carrying exactly `strategy`,
 *                        `claims`, `envelope` and `duplicateKeyCheck`, where
 *                        each claim's `citations` is an array of evidence id
 *                        STRINGS. See `parseResubmittedAssessment` for why ids
 *                        rather than the whole `EvidenceItem`s `/assess`
 *                        publishes: their rendered values are stale by
 *                        definition and this stage must ignore them, and a field
 *                        accepted and ignored reads exactly like one that was
 *                        used.
 *
 * ── WHAT FAILS THE REQUEST ──
 *
 *   A BAD OR STALE RESUBMISSION -> 400, or 409 for `citation_unknown`. 409
 *   because that submission was well formed and conflicts with CURRENT state,
 *   which is `duplicate_bot_instance`'s and `cap_exceeded`'s shape exactly: the
 *   caller fixes it by running `/assess` again, not by rephrasing.
 *
 *   A MODEL THAT ANSWERS BADLY -> 502 with the parser's or the validator's OWN
 *   code, never a degraded success. A `DeriveValidationError` reports
 *   `<layer>/<code>` so "the real decoder rejected this" stays distinguishable
 *   from "the real strategy validator rejected this" from "this stage's own
 *   bound rejected this" -- the same distinction `DeriveValidationError.layer`
 *   exists to preserve.
 *
 *   A MISSING PRECONDITION -> `DeriveError`'s own code and status: no candle
 *   window, an unreadable ledger, no headroom at all, unreadable venue filters.
 *   All four refuse BEFORE the paid inference.
 *
 * A failed CONCENTRATION read does NOT fail the request, exactly as in
 * `/assess`: it is stated to the model as missing and returned verbatim in
 * `bundle.concentration`.
 *
 * ⚠ DERIVE CANNOT DETECT A BAD UPSTREAM JUDGEMENT. A proposal that passes every
 * check here can still be financially meaningless, because the checks answer
 * "is this consistent and grounded?" and none answers "was the data worth
 * reasoning about?" (decision logs 40, 41). The human in 21.1 is the only part
 * of the loop that can tell the two apart.
 */
export async function getAccountDerive(ctx: ApiContext): Promise<Response> {
  const label = ctx.params.label!;

  const pair = ctx.url.searchParams.get("pair");
  if (pair === null || pair.trim() === "") {
    throw badRequest(
      "missing_field",
      `query parameter "pair" is required and must be the venue's own symbol, exactly as ` +
        `GET /api/accounts/${label}/symbols reports it -- and it must be the SAME pair the ` +
        `resubmitted assessment was made about.`,
    );
  }

  const interval = ctx.url.searchParams.get("interval");
  if (interval === null || interval.trim() === "") {
    throw badRequest(
      "missing_field",
      `query parameter "interval" is required and must be one of ${CANDLE_INTERVALS.join(", ")}. ` +
        `There is no default: a wrong interval returns correctly-shaped candles of a DIFFERENT ` +
        `duration, which passes every type check and which no downstream reader can detect.`,
    );
  }
  if (!CANDLE_INTERVALS.includes(interval as CandleInterval)) {
    throw badRequest(
      "invalid_filter",
      `interval must be one of ${CANDLE_INTERVALS.join(", ")}, not ${JSON.stringify(interval)}`,
    );
  }

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

  // Read BEFORE any venue or model work, so a caller who forgot it is told so
  // without this endpoint having spent a candle request first. It is NOT parsed
  // here: parsing needs the fresh bundle's evidence, which does not exist yet.
  const assessmentParam = ctx.url.searchParams.get("assessment");
  if (assessmentParam === null || assessmentParam.trim() === "") {
    throw badRequest(
      "missing_field",
      `query parameter "assessment" is required: it is the JSON object a previous ` +
        `GET /api/accounts/${label}/assess returned, carrying exactly "strategy", "claims", ` +
        `"envelope" and "duplicateKeyCheck", with each claim's "citations" as an array of ` +
        `evidence id strings. This endpoint derives parameters FOR an assessment and never ` +
        `makes one: it has no Stage 2 call in it, and there is no stored proposal to name by ` +
        `id (21.5 requirement 5's proposal record is future work). Every citation in it is ` +
        `re-resolved against the evidence gathered by THIS request, so an assessment whose ` +
        `data has aged out is refused rather than derived from.`,
    );
  }

  const request: GatherRequest = {
    interval: interval as CandleInterval,
    ...(since === undefined ? {} : { since }),
    ...(() => {
      const quoteAssets = optionalCsv(ctx, "quoteAssets");
      return quoteAssets === undefined ? {} : { quoteAssets };
    })(),
  };

  const ports = deriveContextPortsFor(ctx);
  const set = await selectNamedCandidate(ports, {
    accountLabel: label,
    pair,
    // The layer's standing rule: the actor is the email VERIFIED off the Access
    // token, never a caller-supplied string (21.5 requirement 2).
    requestedBy: ctx.actor,
  });
  const bundle = await gatherCandidateData(ports, set.candidates[0]!, request);
  const context = await gatherDeriveContext(ports, bundle);

  // THE RE-VERIFICATION, and the only genuinely new boundary in this endpoint.
  // It runs AFTER the fresh gather because it is checked AGAINST the fresh
  // gather, and BEFORE the model call because a stale assessment must never
  // reach a paid inference -- or a human -- dressed as reasoning about data this
  // run has.
  let assessment;
  try {
    assessment = parseResubmittedAssessment(assessmentParam, bundle);
  } catch (error) {
    if (error instanceof AssessResubmitError) {
      // 409 for the stale/unknown citation, 400 for everything else. See the
      // docblock: one is a conflict with current state that re-running /assess
      // fixes, the rest are malformed input the caller rewrites.
      throw new ApiError(error.code === "citation_unknown" ? 409 : 400, error.code, error.message);
    }
    throw error;
  }

  const model = ctx.deriveModel ?? envDeriveModel(ctx.env);

  const startedAt = ctx.now();
  let result: DeriveResult;
  try {
    result = await deriveParameters(model, context, assessment);
  } catch (error) {
    // The parser's and the validators' own codes travel on the wire, for
    // `getAccountAssess`'s reason: a second vocabulary restating them would
    // drift. 502 because the model answered and its answer was unusable.
    if (error instanceof DeriveParseError) {
      throw new ApiError(502, error.code, error.message);
    }
    if (error instanceof DeriveValidationError) {
      // `<layer>/<code>`, so "the real decoder refused" stays distinguishable
      // from "the real strategy validator refused" from "this stage's own bound
      // refused" -- the distinction `DeriveValidationError.layer` exists for.
      throw new ApiError(502, `${error.layer}/${error.code}`, error.message);
    }
    // `deriveParameters` refuses a context with no usable candle window, and its
    // code says only THAT. Here the candle slot is in hand carrying the
    // producing module's own error, so the real cause is surfaced with the
    // precondition itself UNCHANGED and unbypassed -- exactly as `/assess` does.
    if (
      error instanceof DeriveError &&
      error.code === "no_price_history" &&
      bundle.candles.outcome === "failed"
    ) {
      const cause = bundle.candles.error;
      throw new ApiError(
        statusForCode(cause.code, 502),
        cause.code,
        `${cause.message} -- so no parameters were derived for ${bundle.candidate.pair}: ${error.message}`,
      );
    }
    throw error;
  }
  const latencyMs = ctx.now() - startedAt;

  // ONE rendering for both the record and the response. See `deriveProposalInputsView`.
  const inputs = deriveProposalInputsView(result, set.selectedAt);
  const reasoning = deriveProposalReasoningView(result, latencyMs);

  // 21.5 requirement 5, automatic and fail-closed. THIS is the row a human can
  // approve, by handing `proposalId` to POST /api/bots.
  const record = await logDeriveProposal(proposalLogPorts(ctx), result, {
    entryPoint: "named",
    actor: ctx.actor,
    inputs,
    reasoning,
  });

  return ok({
    entryPoint: "named" as const,
    selectedAt: set.selectedAt,
    /**
     * The permanent record's id (21.5 requirement 5). Pass it as `proposalId` to
     * `POST /api/bots` to record that this proposal became a real bot, or to
     * `POST /api/proposals/:id/reject` to record that it did not.
     */
    proposalId: record.id,
    // Stage 1's bundle and Stage 3's own two reads travel WITH the proposal,
    // never instead of it: every input's real state, including any that failed,
    // beside the numbers drawn from them (21.5 requirement 2).
    bundle: inputs.bundle,
    context: inputs.context,
    // Labelled `client_resubmitted`, with the claims rendered against the
    // CURRENT evidence they were just re-verified against.
    assessment: inputs.assessment,
    derive: deriveResultView(result, latencyMs),
  });
}

/**
 * `POST /api/proposals/:id/reject` -- record that a human read a proposal and
 * decided against it (21.5 requirement 5's `rejected`).
 *
 * Curl-only, like every other section 21 surface (`/candles`, `/gather`,
 * `/assess`, `/derive`, all three watchlist endpoints). It exists NOW, with no
 * dashboard control, for a schema reason argued in `rejectProposal`: the
 * `outcome` CHECK constraint had to name its values at migration time because
 * SQLite cannot alter a CHECK without rebuilding the table, and a value nothing
 * could ever write would be the check-that-cannot-fire this project has already
 * refused twice.
 *
 * EITHER STAGE MAY BE REJECTED. Rejecting an `assess` record is the point of
 * keeping Stage 2 rows at all: it records that a human read a strategy judgement
 * and chose not to spend a Derive inference on it. Only an approval is restricted
 * to `derive` records, and that restriction is a database constraint.
 *
 * `note` is optional in the body; an absent note is recorded as absent, exactly as
 * `removeFromWatchlist` treats its own.
 *
 * IT WRITES NO OUTCOME TWICE. `outcome IS NULL` is in the UPDATE's WHERE clause,
 * so a second decision changes nothing and is refused with
 * `proposal_already_resolved` (409) rather than overwriting the first -- section
 * 8.7 keeps this data, and rewriting a recorded human decision is the one thing
 * that would make the record untrustworthy.
 */
export async function rejectProposalEntry(ctx: ApiContext): Promise<Response> {
  const id = ctx.params.id!;
  // A body is optional here: a rejection with no note is complete on its own. The
  // GET-shaped `ctx.request.body === null` case is what `readJsonObject` would
  // refuse, so it is checked rather than required.
  const raw = ctx.request.headers.get("content-type");
  const body =
    raw !== null && raw.includes("application/json") ? await readJsonObject(ctx.request) : {};

  const record = await rejectProposal(proposalLogPorts(ctx), id, {
    // The layer's standing rule: the verified Access email, never a body field.
    actor: ctx.actor,
    note: optionalString(body, "note"),
  });
  return ok({ proposal: proposalRecordView(record) });
}

/**
 * `GET /api/proposals` -- the permanent record, read (21.5 requirement 5).
 *
 * ── WHAT THIS CLOSES ──
 *
 * Decision logs 46, 48 and 49 each carried the same item, and 46 stated its shape
 * correctly: *"it reads like a missing feature and is actually a missing READ.
 * Entry 45 built the `proposals` table with everything required... What is missing
 * is a UI that reads it. Nothing needs designing at the storage layer."* This is
 * that read. No migration, no new column, no new write path: `proposal-log.ts` is
 * still the table's only writer, and this endpoint is the first reader that is not
 * a check on whether a row can take an outcome.
 *
 * ── ⚠ IT NEVER READS `inputs_json` OR `reasoning_json`, AND THAT IS THE DESIGN ──
 *
 * `PROPOSAL_LIST_COLUMNS` is handed to `Repository.findManyProjected`, so a page of
 * history reads sixteen short columns and not one candle. Migration 0009's THIRD
 * argument for giving proposals their own table was that `Repository.findMany`
 * always selects the full column list, so every unrelated read would pay for the
 * payload -- measured at a 290,459-byte ceiling. A list endpoint over this table
 * built on `findMany` would have reproduced, inside the table that exists because
 * of that argument, the exact cost the argument was about: a 25-row page could read
 * megabytes to render a table of short strings, and 100 rows could approach D1's
 * documented per-row limit a hundred times over. The projection was added to
 * /src/db for this and is a narrower READ, which is the one direction section 8.7's
 * retention promise does not constrain.
 *
 * ── READ-ONLY, AND STRUCTURALLY SO ──
 *
 * `GET`, one `findManyProjected` and one `COUNT(*)`. It writes no row, no
 * `audit_log` entry and no outcome; `proposals.outcome` still moves off NULL in
 * exactly two places in this system (`recordProposalApproval` from
 * `POST /api/bots`, `rejectProposal` from `POST /api/proposals/:id/reject`), and
 * neither is reachable from here.
 *
 * ── THE FILTERS ──
 *
 * `accountLabel`, `stage`, `outcome`, `limit`, `offset` -- all optional, all parsed
 * by `parseProposalQuery`, which owns every bound and every refusal and is unit
 * tested there rather than through this handler. `outcome=pending` is the one that
 * is not a column value: it is `outcome IS NULL`, 21.5's "ignored" read after the
 * fact, and the reason `idx_proposals_unresolved` exists.
 *
 * ⚠ NEWEST FIRST, AND `id` BREAKS THE TIE. `created_at` alone is not a total order
 * -- `/assess` and `/derive` write two rows that can share a millisecond, and
 * `proposal-log.test.ts` drives an injected clock that makes ties routine. Under
 * LIMIT/OFFSET an unstable sort does not merely reorder: a row can appear on two
 * consecutive pages while another appears on neither, which is a paging bug that
 * looks like data loss. `idx_proposals_created` and `idx_proposals_account_created`
 * cover the leading column.
 */
export async function listProposals(ctx: ApiContext): Promise<Response> {
  const parsed = parseProposalQuery(ctx.url.searchParams);
  if (!parsed.ok) throw badRequest(parsed.code, parsed.message);
  const query = parsed.query;
  const where = proposalListWhere(query);

  const rows = await ctx.db.proposals.findManyProjected(PROPOSAL_LIST_COLUMNS, {
    where,
    orderBy: [
      { column: "created_at", direction: "desc" },
      { column: "id", direction: "desc" },
    ],
    limit: query.limit,
    offset: query.offset,
  });
  const total = await ctx.db.proposals.count(where);

  return ok({
    proposals: rows.map(proposalListEntryView),
    page: proposalPage(query, total, rows.length),
    /**
     * The filters ACTUALLY APPLIED, echoed. A page that renders its own URL's
     * filters is describing what it asked for; this describes what was answered,
     * which is the difference that shows up the day a parameter is dropped.
     */
    filters: {
      accountLabel: query.accountLabel,
      stage: query.stage,
      outcome: query.outcome,
    },
  });
}

/**
 * `GET /api/proposals/:id` -- one whole record, rebuilt into the shape the live
 * endpoint returned.
 *
 * ── ⚠ THE RECONSTRUCTION IS EXACT, AND THAT WAS TRACED RATHER THAN HOPED ──
 *
 * `replay.response` is the object `GET /api/accounts/:label/derive` (or `/assess`)
 * really returned for this proposal, field for field, because the handler that
 * wrote the row stored the very object it put on the wire -- `serialize.ts` argues
 * that arrangement and `proposal-replay.ts`'s header traces it. `envelope`,
 * `duplicateKeyCheck`, `settings`, `latencyMs`, `promptChars` and `promptVersion`
 * are all in `reasoning_json`, because the reasoning view SPREADS the response
 * view. So the dashboard hands `replay.response` to the unchanged `ProposalView`
 * and a proposal from last week renders exactly as one from thirty seconds ago.
 *
 * ── THE TWO FIELDS THE RECORD HAS THAT THE WIRE NEVER DID ──
 *
 * `promptText` and the raw transport `response` are cut OUT of `replay.response`
 * -- "the same shape" has to mean the same shape -- and published beside it in
 * `recordOnly`. Withholding them would be the summarization section 8.7 forbids,
 * from the one endpoint that reads the record they exist for.
 *
 * ⚠ THAT MAKES THIS A LARGE RESPONSE, and it is the only endpoint here that is.
 * A `derive` record carries the full candle window plus a ~23 KB prompt. It is a
 * deliberate single-record read, never a list, and `GET /api/proposals` exists
 * precisely so nothing has to pay this cost to browse.
 *
 * ── WHAT A HISTORICAL RECORD CANNOT SHOW, PUBLISHED AS DATA ──
 *
 * `replay.fidelity` says so on the wire rather than leaving a reader to infer it:
 *
 *   * `assessResponseUnavailable` is ALWAYS true for a derive record. Nothing links
 *     a derive row to the assess row it derives from (migration 0009 records that
 *     as a decision), so Stage 2's own evidence table and the two-gather drift
 *     comparison cannot be rendered. `ProposalView` already supports that state --
 *     it is what a reviewer holding only the derive response has always seen.
 *   * `renderableByProposalView` is false for an ASSESS record, and that is
 *     structural rather than a storage gap: `ProposalView` is built around a
 *     derivation's parameters, and an assessment has none. Its payload is rebuilt
 *     exactly; what cannot be reused is the renderer.
 *
 * ── READ-ONLY ──
 *
 * `unknown_proposal` (404) is the only refusal, and it is already in `envelope.ts`'s
 * table with its reasoning. Nothing here writes, and in particular nothing here
 * touches `outcome`: reading a pending proposal leaves it pending, which is the
 * property decision log 48 verified live at 1m59s against the real database.
 */
export async function getProposal(ctx: ApiContext): Promise<Response> {
  const id = ctx.params.id!;
  const row = await ctx.db.proposals.findOne({ id });
  if (row === null) {
    // The same code and the same status `checkProposalCanTakeOutcome` raises, and
    // the same sentence it uses: section 8.7 means no id was ever deleted, so a
    // 404 here really does mean the id was never issued.
    throw notFound(
      "unknown_proposal",
      `no proposal with id ${JSON.stringify(id)}. Proposal ids come from the "proposalId" ` +
        `field a real /assess or /derive response carries; there is no way to mint one, and ` +
        `section 8.7 means none has ever been deleted.`,
    );
  }

  const record = proposalRecordOf(row);
  const replay = replayProposal(record);

  return ok({
    proposal: proposalRecordView(record),
    /**
     * ⚠ A REFUSED REPLAY IS REPORTED, NOT SWALLOWED, and the record still comes
     * back beside it. A row whose payload cannot be rebuilt is a real finding
     * about a permanent record, and the id, actor, model, timestamps and outcome
     * are all still true and still worth showing -- so the endpoint reports which
     * fields are missing rather than 500ing and taking the readable half with it.
     */
    replay,
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
