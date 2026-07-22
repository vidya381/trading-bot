/**
 * The DCA `BotInstance` Durable Object (spec sections 6.3, 7.2, 8.1), step 6.
 *
 * One object per (exchange account + strategy + trading pair), which section 3
 * calls the unit of state, risk, and failure isolation. This object owns:
 *
 *  - its full configuration, including a `schemaVersion` (section 8.1);
 *  - its current status, position, and cycle count;
 *  - its own order history and idempotency records (section 5.1).
 *
 * It is the first place the idempotency module (step 2), the Binance client
 * (step 3), the D1 access layer (step 4) and the capital module (step 5) are
 * wired together.
 *
 * WHAT THIS OBJECT DOES NOT OWN
 * -----------------------------
 * Two things, both deliberate.
 *
 * 1. **Its own `bot_instances` row.** It comes into existence by calling
 *    `createBotInstanceWithCapital`, which reserves the capital and writes that
 *    row in one pipeline (step 5). This object never inserts it. A second
 *    writer to that row would mean an allocation could exist without a bot or a
 *    bot without an allocation, and step 5's ordering guarantees assume exactly
 *    one writer.
 *
 * 2. **The transition into `stopped`.** Status is otherwise this object's call
 *    -- `running` and `halted` are decided here and mirrored out. But `stopped`
 *    does double duty in step 5: it means "this bot is closed" AND it is the
 *    mutual exclusion that stops the same capital being released twice, via a
 *    conditional update on the row not already being stopped. If this object
 *    could also set it, that guarantee would break, and a bot could be marked
 *    stopped without its capital ever returning to the ledger. So `close()`
 *    calls `releaseBotCapital` and lets it own the transition, then follows.
 *
 *    `halted` touches no capital and needs no coordination at all.
 *
 * WHEN D1 IS WRITTEN
 * ------------------
 * In the same pipeline that processes the event, never on a timer or a
 * best-effort background write. This continues step 5's decision B and settles
 * step 4's open question 2 for mid-trade state, which is the half step 5 left
 * open.
 *
 * Within a single event the order is always: Durable Object storage first, D1
 * second. Section 8.1 makes this object's storage the source of truth and
 * section 8.2 calls D1 "mirrored from" it, so a crash between the two leaves
 * the authoritative store correct and the mirror behind -- which is exactly the
 * discrepancy section 9's reconciliation exists to find. The reverse ordering
 * would leave D1 asserting something that never happened.
 *
 * NO RATE LIMITING YET
 * --------------------
 * Section 5.4's RateLimiter Durable Object is not built (it was not in this
 * step's scope). `WeightBudget` exists and the Binance client reports weight
 * into it, but nothing gates a request. This object can therefore issue
 * unbounded calls during a halt that cancels many orders. See the decision log.
 */

import { DurableObject } from "cloudflare:workers";

import { createBotInstanceWithCapital, releaseBotCapital } from "../capital";
import { databaseFrom, type Database } from "../db";
import type { AlertRow, AuditLogRow, BotStatus, OrderRow, TradeRow } from "../db/schema";
import { validateOrder } from "../exchange/binance/filters";
import type {
  Asset,
  Fill,
  OrderStatus,
  Pair,
  Price,
  RestExchangeClient,
  SymbolFilters,
  Timestamp,
} from "../shared/exchange-client";
import { isUsable } from "../shared/downtime";
import { convertFillFee, type RateLookup } from "../shared/fees";
import { assertAccountArmed } from "../reconciliation/circuit-breaker";
import { IdempotencyGuard } from "../shared/idempotency";
import { mul, toDecimalString, ZERO, type Money } from "../shared/money";
import {
  applyFill,
  closeOrder,
  createOrder,
  isTerminal,
  OrderStateError,
  type TrackedOrder,
} from "../shared/order-state";
import {
  applyEntry,
  assertReadableSchema,
  decide,
  DCA_SCHEMA_VERSION,
  encodeDcaParams,
  EMPTY_POSITION,
  quantityForQuote,
  takeProfitPrice,
  validateDcaParams,
  type DcaConfig,
  type DcaHaltReason,
  type DcaParams,
  type DcaPosition,
} from "../strategies/dca";
import { DurableObjectAttemptStore } from "./attempt-store";

// ---------------------------------------------------------------------------
// Storage keys
// ---------------------------------------------------------------------------

const CONFIG_KEY = "config";
const STATE_KEY = "state";
const ORDER_KEY_PREFIX = "order:";

function orderKey(clientOrderId: string): string {
  return `${ORDER_KEY_PREFIX}${clientOrderId}`;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type BotInstanceErrorCode =
  /** An operation that needs a created bot, on one that has none. */
  | "not_created"
  /** `create` on an object that already holds a configuration. */
  | "already_created"
  /** A lifecycle action that the current status does not permit. */
  | "invalid_status"
  /** No exchange client or database was attached. */
  | "not_attached"
  /** The bot row exists in D1 but this object holds no state. */
  | "orphaned_bot_row";

export class BotInstanceError extends Error {
  readonly code: BotInstanceErrorCode;

  constructor(code: BotInstanceErrorCode, message: string) {
    super(message);
    this.name = "BotInstanceError";
    this.code = code;
  }
}

/** Everything the object needs from outside itself, so tests can supply it. */
export interface BotInstanceDependencies {
  readonly db: Database;
  /**
   * The REST half of section 4.1. Deliberately `RestExchangeClient` and not
   * `ExchangeClient`: `subscribeToPriceFeed` is not wired in this step (see the
   * decision log), and depending on the narrower type keeps that honest at
   * compile time rather than by comment.
   */
  readonly exchange: RestExchangeClient;
  readonly now: () => Timestamp;
  readonly newId: () => string;
}

/** This object's persisted runtime state, beside its configuration. */
export interface BotRuntimeState {
  readonly schemaVersion: number;
  readonly status: BotStatus;
  /** Completed take-profit cycles (section 6.3 step 6). */
  readonly cycleCount: number;
  readonly position: DcaPosition;
  /**
   * Next idempotency sequence number to use.
   *
   * Kept here rather than derived from `IdempotencyGuard.highestSequence()`,
   * which scans every attempt this bot has ever recorded. Under section 8.7's
   * retain-everything rule that scan grows without bound, and it would sit on
   * the order-placing path. The guard's scan is still used for recovery, where
   * reading every unresolved attempt is the actual point.
   */
  readonly nextSequence: number;
  /** clientOrderIds of orders believed live on the exchange. */
  readonly openOrderIds: readonly string[];
  readonly haltReason: string | null;
  readonly haltedAt: Timestamp | null;
  readonly lastPrice: Money | null;
  readonly lastPriceAt: Timestamp | null;
  /** Gross realized profit across completed cycles, before fees. */
  readonly realizedGross: Money;
  /** Cached symbol filters (section 4.3), refreshed when stale. */
  readonly filters: SymbolFilters | null;
  /** Set while a take-profit sell is live, so a fill is attributed correctly. */
  readonly exitOrderId: string | null;
}

export interface CreateDcaBotRequest {
  readonly botInstanceId: string;
  readonly accountLabel: string;
  readonly exchange: string;
  readonly pair: Pair;
  /** The asset the allocation and every order size is denominated in. */
  readonly capitalAsset: Asset;
  readonly allocatedCapital: Money;
  readonly params: DcaParams;
  /** `audit_log.actor`: an authenticated email, or 'system'. */
  readonly actor: string;
}

/** What happened on one pass of the event pipeline, for tests and the dashboard. */
export interface PipelineResult {
  readonly status: BotStatus;
  readonly action: string;
  readonly detail?: string;
}

export interface BotSnapshot {
  readonly config: DcaConfig;
  readonly state: BotRuntimeState;
  readonly orders: readonly TrackedOrder[];
}

const FILTER_MAX_AGE_MS = 3_600_000;

// ---------------------------------------------------------------------------

export class BotInstance extends DurableObject<Env> {
  #dependencies: BotInstanceDependencies | undefined;

  /**
   * Supply or override this object's dependencies.
   *
   * The database comes from the environment by default. The exchange client
   * does NOT, and cannot yet: it needs live API credentials, and step 4.1
   * recorded that whose exchange account will be used is still undecided. So
   * there is no default, and the object refuses to trade rather than silently
   * constructing a client against credentials that do not exist. Wiring it from
   * secrets is the job of whichever step creates them.
   */
  attach(dependencies: Partial<BotInstanceDependencies>): void {
    this.#dependencies = {
      db: dependencies.db ?? databaseFrom(this.env),
      exchange:
        dependencies.exchange ??
        this.#dependencies?.exchange ??
        (undefined as unknown as RestExchangeClient),
      now: dependencies.now ?? (() => Date.now()),
      newId: dependencies.newId ?? (() => crypto.randomUUID()),
    };
  }

  #deps(): BotInstanceDependencies {
    if (this.#dependencies === undefined) {
      this.attach({});
    }
    const deps = this.#dependencies!;
    if (deps.exchange === undefined) {
      throw new BotInstanceError(
        "not_attached",
        "no exchange client attached. There is no default: it needs live API " +
          "credentials, and none exist in this project yet (step 4.1).",
      );
    }
    return deps;
  }

  #db(): Database {
    if (this.#dependencies === undefined) this.attach({});
    return this.#dependencies!.db;
  }

  #now(): Timestamp {
    if (this.#dependencies === undefined) this.attach({});
    return this.#dependencies!.now();
  }

  #newId(): string {
    if (this.#dependencies === undefined) this.attach({});
    return this.#dependencies!.newId();
  }

  // -------------------------------------------------------------------------
  // Stored state
  // -------------------------------------------------------------------------

  async #config(): Promise<DcaConfig> {
    const config = await this.ctx.storage.get<DcaConfig>(CONFIG_KEY);
    if (config === undefined) {
      throw new BotInstanceError(
        "not_created",
        "this bot instance has no configuration; call create() first",
      );
    }
    // Section 16: stored state carries a schemaVersion and the check runs the
    // first time an object wakes under new code, which is here.
    assertReadableSchema(config.schemaVersion);
    return config;
  }

  async #state(): Promise<BotRuntimeState> {
    const state = await this.ctx.storage.get<BotRuntimeState>(STATE_KEY);
    if (state === undefined) {
      throw new BotInstanceError("not_created", "this bot instance has no state; call create() first");
    }
    return state;
  }

  async #putState(state: BotRuntimeState): Promise<void> {
    await this.ctx.storage.put(STATE_KEY, state);
  }

  async #order(clientOrderId: string): Promise<TrackedOrder | undefined> {
    return await this.ctx.storage.get<TrackedOrder>(orderKey(clientOrderId));
  }

  async #putOrder(order: TrackedOrder): Promise<void> {
    await this.ctx.storage.put(orderKey(order.clientOrderId), order);
  }

  #guard(botInstanceId: string): IdempotencyGuard {
    return new IdempotencyGuard(new DurableObjectAttemptStore(this.ctx.storage), botInstanceId);
  }

  // -------------------------------------------------------------------------
  // Creation (section 6.1, section 8.5)
  // -------------------------------------------------------------------------

  /**
   * Bring this bot into existence.
   *
   * Order: reserve capital and write the `bot_instances` row FIRST, then this
   * object's own storage. That follows step 5's rule -- grow the reservation
   * before the thing that spends it -- so an interruption between the two
   * leaves capital reserved for a bot that cannot trade, rather than a bot
   * trading against capital nothing reserved. The first is visible in
   * `audit_log` and correctable; the second is the same capital allocated
   * twice.
   */
  async create(request: CreateDcaBotRequest): Promise<{ botInstanceId: string; status: BotStatus }> {
    if ((await this.ctx.storage.get(CONFIG_KEY)) !== undefined) {
      throw new BotInstanceError(
        "already_created",
        `bot instance ${JSON.stringify(request.botInstanceId)} already has a configuration`,
      );
    }

    const db = this.#db();
    const now = this.#now();

    // Section 7.3, added at step 7. An account whose circuit breaker is
    // tripped must not gain a new bot: halting everything that existed at the
    // moment of the trip is not a breaker if the next creation starts trading
    // straight back into whatever caused it. Checked before any capital is
    // reserved, so a refusal costs nothing to undo.
    await assertAccountArmed(db, request.accountLabel, `create bot ${request.botInstanceId}`);

    // Before any capital is touched. Section 6.1 checks the allocation against
    // the account; this checks the bot's own ladder against its allocation.
    validateDcaParams(request.params, request.allocatedCapital);

    // Step 5 owns this pipeline entirely: availability check, reservation,
    // bot_instances row and audit entry. This object writes none of it.
    await createBotInstanceWithCapital(
      db,
      {
        id: request.botInstanceId,
        accountLabel: request.accountLabel,
        asset: request.capitalAsset,
        exchange: request.exchange,
        pair: request.pair,
        strategyType: "dca",
        strategyParams: encodeDcaParams(request.params),
        stopLossPct: request.params.stopLossPct,
        // Mandatory for DCA (section 6.3 step 4); the schema enforces it too.
        takeProfitPct: request.params.takeProfitPct,
        requestedCapital: request.allocatedCapital,
      },
      { actor: request.actor, now },
    );

    const config: DcaConfig = {
      schemaVersion: DCA_SCHEMA_VERSION,
      botInstanceId: request.botInstanceId,
      accountLabel: request.accountLabel,
      exchange: request.exchange,
      pair: request.pair,
      capitalAsset: request.capitalAsset,
      allocatedCapital: request.allocatedCapital,
      params: request.params,
    };

    const state: BotRuntimeState = {
      schemaVersion: DCA_SCHEMA_VERSION,
      status: "created",
      cycleCount: 0,
      position: EMPTY_POSITION,
      nextSequence: 0,
      openOrderIds: [],
      haltReason: null,
      haltedAt: null,
      lastPrice: null,
      lastPriceAt: null,
      realizedGross: ZERO,
      filters: null,
      exitOrderId: null,
    };

    // One `put` of both keys, so the object cannot end up holding a config with
    // no state or the reverse.
    await this.ctx.storage.put({ [CONFIG_KEY]: config, [STATE_KEY]: state });

    return { botInstanceId: request.botInstanceId, status: "created" };
  }

  // -------------------------------------------------------------------------
  // Lifecycle (section 6.3)
  // -------------------------------------------------------------------------

  /**
   * Section 6.3 step 2: the explicit start. The base order fires on the first
   * usable price, which is the next call to `onPriceUpdate`.
   *
   * The order is not placed here because placing it needs a price, and reading
   * one is an exchange call that can fail. Section 5.6 forbids treating an
   * unreachable exchange as data, so `start` moves the status and the pipeline
   * places the order the moment a price actually arrives.
   */
  async start(actor: string): Promise<PipelineResult> {
    const config = await this.#config();
    const state = await this.#state();
    if (state.status !== "created") {
      throw new BotInstanceError(
        "invalid_status",
        `cannot start a bot whose status is ${JSON.stringify(state.status)}; ` +
          `only a newly created bot can be started (a halted one is resumed)`,
      );
    }

    const now = this.#now();
    await this.#putState({ ...state, status: "running" });
    await this.#mirrorStatus(config, "running", null, null, now);
    await this.#audit(config, "bot.started", actor, { cycle: state.cycleCount + 1 }, now);

    return { status: "running", action: "started" };
  }

  /**
   * The main event pipeline: one price update in, whatever section 6.3 says
   * should happen out, with D1 mirrored as part of the same pass.
   *
   * Section 7.5 governs the outer `catch`: any unexpected exception in code
   * that can place or modify orders halts this specific bot and alerts, rather
   * than failing silently or retrying into an unknown state.
   */
  async onPriceUpdate(price: Price): Promise<PipelineResult> {
    const config = await this.#config();
    let state = await this.#state();

    if (state.status !== "running") {
      return { status: state.status, action: "ignored", detail: `status is ${state.status}` };
    }

    state = { ...state, lastPrice: price.price, lastPriceAt: price.at };
    await this.#putState(state);

    try {
      const action = decide({
        config,
        position: state.position,
        price: price.price,
        hasOpenOrder: state.openOrderIds.length > 0,
      });

      switch (action.kind) {
        case "hold":
          return { status: "running", action: "hold" };

        case "open_base":
          return await this.#placeBuy(config, action.quoteAmount, price, "base");

        case "additional_buy":
          return await this.#placeBuy(config, action.quoteAmount, price, `additional-${action.index}`);

        case "take_profit":
          return await this.#placeTakeProfitSell(config, price);

        case "halt":
          return await this.#halt(config, action.reason, action.detail, "system");
      }
    } catch (error) {
      return await this.#haltOnUnexpected(config, error);
    }
  }

  /**
   * Apply an execution the exchange reported against one of this bot's orders.
   *
   * Section 5.3 requires the position to move incrementally on each partial
   * fill, so this is per-fill rather than per-order.
   */
  async onFill(clientOrderId: string, fill: Fill): Promise<PipelineResult> {
    const config = await this.#config();
    const state = await this.#state();

    const order = await this.#order(clientOrderId);
    if (order === undefined) {
      // An execution against an order this bot has no record of. Not an
      // exception to escalate -- it is precisely the "unexpected order" case
      // section 9 exists to investigate -- so it is recorded and alerted.
      await this.#alert(config, {
        severity: "critical",
        category: "trading",
        alertType: "unknown_order_fill",
        message:
          `fill ${fill.fillId} arrived for ${clientOrderId}, which this bot has ` +
          `no record of placing`,
      });
      return { status: state.status, action: "unknown_order", detail: clientOrderId };
    }

    try {
      return await this.#applyFillToOrder(config, state, order, fill);
    } catch (error) {
      if (error instanceof OrderStateError) {
        return await this.#onOrderStateError(config, state, error, clientOrderId);
      }
      return await this.#haltOnUnexpected(config, error);
    }
  }

  /**
   * Section 7.2, driven by a human or by a risk control outside this object
   * (the account circuit breaker of 7.3, the global kill switch of 7.4).
   */
  async halt(reason: DcaHaltReason, detail: string, actor: string): Promise<PipelineResult> {
    const config = await this.#config();
    return await this.#halt(config, reason, detail, actor);
  }

  /**
   * Section 7.2 step 5: resuming requires an explicit human action after
   * review. This is that action, and it is the only path out of `halted`.
   */
  async resume(actor: string): Promise<PipelineResult> {
    const config = await this.#config();
    const state = await this.#state();
    if (state.status !== "halted") {
      throw new BotInstanceError(
        "invalid_status",
        `only a halted bot can be resumed; this one is ${JSON.stringify(state.status)}`,
      );
    }

    // Section 7.3, added at step 7. The other half of the latch: a bot halted
    // BY the circuit breaker must not be resumable while the account is still
    // tripped, or the breaker lasts exactly as long as it takes someone to
    // click resume. Re-arming the account is a separate, explicit human action
    // (`resetAccountCircuitBreaker`), and each bot still has to be resumed
    // individually afterwards per section 7.2 step 5.
    await assertAccountArmed(this.#db(), config.accountLabel, `resume bot ${config.botInstanceId}`);

    const now = this.#now();
    // `halt_reason` is deliberately NOT cleared: migration 0001's
    // halt_requires_reason CHECK is one-directional precisely so a resumed row
    // may keep the last reason rather than discarding why it stopped.
    await this.#putState({ ...state, status: "running" });
    await this.#mirrorStatus(config, "running", state.haltReason, state.haltedAt, now);
    await this.#audit(config, "bot.resumed", actor, { previous_halt_reason: state.haltReason }, now);

    return { status: "running", action: "resumed" };
  }

  /**
   * Close the bot and return its capital.
   *
   * `releaseBotCapital` performs the transition into `stopped` -- this object
   * never writes that status to D1 itself. See the note at the top of the file:
   * that column is also step 5's mutual exclusion against a double release, and
   * a second writer would break it.
   *
   * Open orders are cancelled first, through the same path a halt uses. A bot
   * whose capital has been returned must not still have live orders against it.
   */
  async close(actor: string): Promise<PipelineResult> {
    const config = await this.#config();
    const state = await this.#state();
    const now = this.#now();

    if (state.status !== "stopped") {
      await this.#cancelOpenOrders(config, state);
    }

    // Step 5 owns this: it flips the row to `stopped` conditionally, inspects
    // the changes count, and only then releases the reservation.
    await releaseBotCapital(this.#db(), config.botInstanceId, { actor, now });

    const latest = await this.#state();
    await this.#putState({ ...latest, status: "stopped", openOrderIds: [] });
    await this.#audit(config, "bot.closed", actor, { cycles_completed: latest.cycleCount }, now);

    return { status: "stopped", action: "closed" };
  }

  /** Everything this object knows about itself, for the dashboard and tests. */
  async snapshot(): Promise<BotSnapshot> {
    const config = await this.#config();
    const state = await this.#state();
    const entries = await this.ctx.storage.list<TrackedOrder>({ prefix: ORDER_KEY_PREFIX });
    return { config, state, orders: [...entries.values()] };
  }

  /**
   * `snapshot()`, but null instead of throwing when this object holds no state.
   *
   * Added at step 7. Reconciliation must be able to tell "this bot has nothing
   * to compare" from "reading it failed", and it reaches this object over RPC,
   * across which a thrown `BotInstanceError` arrives without its `code`
   * property -- so the caller would have to match on message text to
   * distinguish the two. That is exactly the sort of check that keeps working
   * until someone rewords an error string.
   *
   * The null case is real and already documented: step 6's open question 6
   * describes a `bot_instances` row whose object was never written, because
   * capital is reserved and the row inserted before this object's storage is.
   */
  async snapshotIfCreated(): Promise<BotSnapshot | null> {
    const config = await this.ctx.storage.get<DcaConfig>(CONFIG_KEY);
    const state = await this.ctx.storage.get<BotRuntimeState>(STATE_KEY);
    if (config === undefined || state === undefined) return null;
    assertReadableSchema(config.schemaVersion);
    const entries = await this.ctx.storage.list<TrackedOrder>({ prefix: ORDER_KEY_PREFIX });
    return { config, state, orders: [...entries.values()] };
  }

  // -------------------------------------------------------------------------
  // Order placement
  // -------------------------------------------------------------------------

  async #ensureFilters(config: DcaConfig, state: BotRuntimeState, now: Timestamp): Promise<SymbolFilters> {
    const cached = state.filters;
    if (cached !== null && now - cached.fetchedAt < FILTER_MAX_AGE_MS) {
      return cached;
    }

    const outcome = await this.#deps().exchange.getSymbolFilters(config.pair);
    if (!isUsable(outcome)) {
      if (cached !== null) {
        // Section 5.6: a failed request is not data. Stale filters are still
        // the exchange's own last word on the symbol, and refusing to trade
        // because a refresh failed would be a worse answer than trading on
        // rules that were true an hour ago. Using them is deliberate, which is
        // why `SymbolFilterCache` separates `get` from `peek`.
        return cached;
      }
      throw new BotInstanceError(
        "not_attached",
        `cannot read symbol filters for ${config.pair} and none are cached: ` +
          `${outcome.kind} ${outcome.message}`,
      );
    }

    await this.#putState({ ...(await this.#state()), filters: outcome.value });
    return outcome.value;
  }

  async #placeBuy(
    config: DcaConfig,
    quoteAmount: Money,
    price: Price,
    label: string,
  ): Promise<PipelineResult> {
    let state = await this.#state();
    const now = this.#now();
    const filters = await this.#ensureFilters(config, state, now);
    // Re-read: a filter refresh writes state, and continuing from the copy
    // taken before it would silently discard the filters just cached.
    state = await this.#state();

    // Guard the bot's own allocation, independently of the ledger. The ledger
    // reserves headroom for this bot; nothing there stops the bot spending more
    // than its own reservation.
    const remaining = config.allocatedCapital - state.position.cost;
    const budgeted = quoteAmount > remaining ? remaining : quoteAmount;
    if (budgeted <= ZERO) {
      return { status: "running", action: "skipped", detail: "allocation exhausted" };
    }

    const requested = quantityForQuote(budgeted, price.price);

    // Section 4.3, first check: round onto the symbol's grid.
    const adjusted = validateOrder(
      { pair: config.pair, side: "buy", price: price.price, quantity: requested },
      filters,
      { rounding: "adjust" },
    );
    if (!adjusted.valid) {
      // "If an order cannot be constructed validly, do not send it; log the
      // reason and skip that action."
      await this.#alert(config, {
        severity: "warning",
        category: "trading",
        alertType: "order_not_constructible",
        message: `${label} buy skipped: ${adjusted.reason}`,
      });
      return { status: "running", action: "skipped", detail: adjusted.code };
    }

    // The sequence is persisted BEFORE the attempt is recorded. A crash here
    // burns a sequence number, which costs nothing. The reverse ordering would
    // let a crash re-use a sequence whose attempt already existed, and
    // `beginAttempt` would answer `recover` for an order that was never placed.
    const sequence = state.nextSequence;
    state = { ...state, nextSequence: sequence + 1 };
    await this.#putState(state);

    const guard = this.#guard(config.botInstanceId);
    const decision = await guard.beginAttempt(sequence, now);
    if (decision.action === "recover") {
      return { status: "running", action: "recover", detail: decision.reason };
    }

    // Section 4.3, second check: independent, and deliberately not a re-round.
    // `verify` reports an off-grid value instead of repairing it, so the second
    // call cannot silently fix what it exists to catch.
    const verified = validateOrder(
      { pair: config.pair, side: "buy", price: adjusted.price, quantity: adjusted.quantity },
      filters,
      { rounding: "verify" },
    );
    if (!verified.valid) {
      await guard.markFailed(decision.clientOrderId, `failed the pre-send check: ${verified.reason}`, now);
      return await this.#halt(config, "order_rejected", `pre-send validation failed: ${verified.reason}`, "system");
    }

    const outcome = await this.#deps().exchange.placeOrder({
      pair: config.pair,
      clientOrderId: decision.clientOrderId,
      side: "buy",
      type: "limit",
      price: adjusted.price,
      quantity: adjusted.quantity,
    });

    if (!isUsable(outcome)) {
      if (outcome.kind === "transport") {
        // Section 5.6 and 5.1 together: the order's fate is unknown, so the
        // attempt record stays `attempting` and recovery looks it up by
        // clientOrderId. It must never be re-sent.
        return {
          status: "running",
          action: "unresolved",
          detail: `placement outcome unknown: ${outcome.message}`,
        };
      }
      await guard.markFailed(decision.clientOrderId, outcome.message, now);
      return await this.#halt(config, "order_rejected", `exchange refused the order: ${outcome.message}`, "system");
    }

    const result = outcome.value;
    await guard.markPlaced(decision.clientOrderId, result.exchangeOrderId, now);

    const order = createOrder({
      clientOrderId: decision.clientOrderId,
      pair: config.pair,
      side: "buy",
      price: adjusted.price,
      quantity: adjusted.quantity,
      at: result.acceptedAt,
    });
    await this.#putOrder(order);
    await this.#putState({
      ...(await this.#state()),
      openOrderIds: [...state.openOrderIds, decision.clientOrderId],
    });
    await this.#mirrorOrderInsert(config, order, result.exchangeOrderId);

    // A limit order can come back with executions already attached.
    for (const fill of result.fills) {
      await this.onFill(decision.clientOrderId, fill);
    }

    return { status: "running", action: `placed-${label}`, detail: decision.clientOrderId };
  }

  /** Section 6.3 step 4: sell the whole position. The mandatory DCA exit. */
  async #placeTakeProfitSell(config: DcaConfig, price: Price): Promise<PipelineResult> {
    let state = await this.#state();
    const now = this.#now();

    if (state.exitOrderId !== null) {
      return { status: "running", action: "hold", detail: "exit order already live" };
    }

    // Cancel any resting buy first: the position is about to be sold whole, and
    // a buy filling behind the sell would leave base the bot no longer intends
    // to hold.
    await this.#cancelOpenOrders(config, state);
    state = await this.#state();

    const filters = await this.#ensureFilters(config, state, now);
    state = await this.#state();
    const target = takeProfitPrice(config.params, state.position.averageEntryPrice);
    const limit = price.price > target ? price.price : target;

    const adjusted = validateOrder(
      { pair: config.pair, side: "sell", price: limit, quantity: state.position.quantity },
      filters,
      { rounding: "adjust" },
    );
    if (!adjusted.valid) {
      // The exit is mandatory, so an unsendable exit is not something to skip
      // and carry on from -- it means the position cannot be closed by the
      // configured rule, which a human has to see.
      return await this.#halt(
        config,
        "order_rejected",
        `take-profit sell could not be constructed: ${adjusted.reason}`,
        "system",
      );
    }

    const sequence = state.nextSequence;
    await this.#putState({ ...state, nextSequence: sequence + 1 });

    const guard = this.#guard(config.botInstanceId);
    const decision = await guard.beginAttempt(sequence, now);
    if (decision.action === "recover") {
      return { status: "running", action: "recover", detail: decision.reason };
    }

    const outcome = await this.#deps().exchange.placeOrder({
      pair: config.pair,
      clientOrderId: decision.clientOrderId,
      side: "sell",
      type: "limit",
      price: adjusted.price,
      quantity: adjusted.quantity,
    });

    if (!isUsable(outcome)) {
      if (outcome.kind === "transport") {
        return { status: "running", action: "unresolved", detail: outcome.message };
      }
      await guard.markFailed(decision.clientOrderId, outcome.message, now);
      return await this.#halt(config, "order_rejected", `exit order refused: ${outcome.message}`, "system");
    }

    await guard.markPlaced(decision.clientOrderId, outcome.value.exchangeOrderId, now);

    const order = createOrder({
      clientOrderId: decision.clientOrderId,
      pair: config.pair,
      side: "sell",
      price: adjusted.price,
      quantity: adjusted.quantity,
      at: outcome.value.acceptedAt,
    });
    await this.#putOrder(order);
    await this.#putState({
      ...(await this.#state()),
      openOrderIds: [decision.clientOrderId],
      exitOrderId: decision.clientOrderId,
    });
    await this.#mirrorOrderInsert(config, order, outcome.value.exchangeOrderId);

    for (const fill of outcome.value.fills) {
      await this.onFill(decision.clientOrderId, fill);
    }

    return { status: "running", action: "placed-take-profit", detail: decision.clientOrderId };
  }

  // -------------------------------------------------------------------------
  // Fills
  // -------------------------------------------------------------------------

  async #applyFillToOrder(
    config: DcaConfig,
    state: BotRuntimeState,
    order: TrackedOrder,
    fill: Fill,
  ): Promise<PipelineResult> {
    const effect = applyFill(order, fill);
    await this.#putOrder(effect.order);

    const isExit = state.exitOrderId === order.clientOrderId;
    let next: BotRuntimeState = { ...state };

    if (!isExit) {
      // Section 6.3 step 3: recalculate the average entry on every entry. The
      // cost is what was actually executed (price x quantity of this fill),
      // not what was requested.
      const cost = -effect.quoteDelta;
      next = {
        ...next,
        position: applyEntry(
          next.position,
          {
            clientOrderId: order.clientOrderId,
            price: fill.price,
            quantity: fill.quantity,
            cost,
            at: fill.executedAt,
          },
          next.position.quantity > ZERO,
        ),
      };
    }

    if (effect.fullyFilled) {
      next = { ...next, openOrderIds: next.openOrderIds.filter((id) => id !== order.clientOrderId) };
    }

    await this.#putState(next);

    // Mirror the order's new state and the trade, in the same pass.
    await this.#mirrorOrderUpdate(effect.order);
    await this.#mirrorTrade(config, effect.order, fill);

    if (isExit && effect.fullyFilled) {
      return await this.#completeCycle(config, effect.order, fill.executedAt);
    }

    return {
      status: next.status,
      action: effect.fullyFilled ? "filled" : "partially_filled",
      detail: order.clientOrderId,
    };
  }

  /**
   * Section 6.3 step 6: the cycle's exit has fully filled.
   *
   * Take-profit is treated as a CYCLE COMPLETION, not as a section 7.2 halt.
   * Section 7.2's header lists take-profit among the halt triggers and says a
   * halt never auto-resumes, while section 6.3 step 6 says the bot may
   * auto-restart a fresh cycle after a take-profit exit. Both cannot hold. The
   * reading taken is that 6.3 step 6 is the specific rule for DCA and 7.2's
   * list is the general one, so:
   *
   *   - autoRestart on  -> a fresh cycle begins, status stays `running`, and
   *     the next price update places a new base order;
   *   - autoRestart off -> the bot halts with reason `take_profit_reached`,
   *     which keeps 7.2's "never auto-resume" true for every path that does not
   *     have 6.3 step 6's explicit permission.
   *
   * Either way the capital reservation is untouched. Releasing it is a close,
   * and a close is a human decision.
   */
  async #completeCycle(config: DcaConfig, exit: TrackedOrder, at: Timestamp): Promise<PipelineResult> {
    const state = await this.#state();
    // Half-even, matching the notional rounding in `order-state.ts`: this is an
    // internal accounting figure that accumulates across cycles, so it should
    // carry no directional bias (step 2, decision 3).
    const proceeds = mul(exit.filledQuantity, exit.price, "half-even");
    const gross = proceeds - state.position.cost;

    const completed: BotRuntimeState = {
      ...state,
      cycleCount: state.cycleCount + 1,
      position: EMPTY_POSITION,
      openOrderIds: [],
      exitOrderId: null,
      realizedGross: state.realizedGross + gross,
    };
    await this.#putState(completed);
    await this.#audit(
      config,
      "bot.cycle_completed",
      "system",
      {
        cycle: completed.cycleCount,
        gross_profit: toDecimalString(gross),
        entries: state.position.entries.length,
      },
      at,
    );
    await this.#alert(config, {
      severity: "info",
      category: "trading",
      alertType: "take_profit",
      message:
        `cycle ${completed.cycleCount} closed at ${toDecimalString(exit.price)} for a gross ` +
        `${toDecimalString(gross)} ${config.capitalAsset}`,
    });

    if (config.params.autoRestart) {
      return { status: "running", action: "cycle_completed", detail: "auto-restarting" };
    }
    return await this.#halt(
      config,
      "take_profit_reached",
      `cycle ${completed.cycleCount} closed for a gross ${toDecimalString(gross)} ` +
        `${config.capitalAsset}; autoRestart is off, so it is awaiting review`,
      "system",
    );
  }

  /**
   * Step 2's decision 8 in practice: these codes describe races that genuinely
   * happen, and section 7.5's halt-on-exception would turn a redelivered queue
   * message into an emergency.
   */
  async #onOrderStateError(
    config: DcaConfig,
    state: BotRuntimeState,
    error: OrderStateError,
    clientOrderId: string,
  ): Promise<PipelineResult> {
    switch (error.code) {
      case "duplicate_fill":
      case "fill_after_terminal":
        // Routine. A redelivered fill, or an execution crossing a
        // cancellation. Recorded, not escalated.
        return { status: state.status, action: error.code, detail: clientOrderId };

      case "overfill":
      case "invalid_quantity":
      case "invalid_transition":
        // The exchange and this bot disagree about an order. Section 9 calls
        // that meaningful drift and halts the specific bot.
        await this.#alert(config, {
          severity: "critical",
          category: "trading",
          alertType: "order_state_drift",
          message: `${error.code} on ${clientOrderId}: ${error.message}`,
        });
        return await this.#halt(config, "unhandled_error", `${error.code}: ${error.message}`, "system");
    }
  }

  // -------------------------------------------------------------------------
  // Halt (section 7.2)
  // -------------------------------------------------------------------------

  /**
   * Section 7.2, in the order that is actually safe.
   *
   * The spec lists cancellation first and marking halted third. This marks
   * halted first, then cancels. The reason is step 2 of the same list -- "stop
   * placing any new orders" -- which is only effective once the status says so
   * and, more importantly, once it says so DURABLY. Cancelling first means a
   * crash partway through leaves a bot still marked `running`, with some orders
   * cancelled, which the next price update would happily add to. Marking first
   * means a crash leaves a halted bot with orders still live: visible, alerted
   * on, and safe, because nothing will trade against them.
   *
   * The cancellations themselves are unchanged and still immediate.
   */
  async #halt(
    config: DcaConfig,
    reason: DcaHaltReason,
    detail: string,
    actor: string,
  ): Promise<PipelineResult> {
    const now = this.#now();
    const state = await this.#state();

    if (state.status === "halted") {
      return { status: "halted", action: "already_halted", detail: state.haltReason ?? undefined };
    }
    if (state.status === "stopped") {
      throw new BotInstanceError("invalid_status", "a stopped bot cannot be halted; its capital is released");
    }

    const recorded = `${reason}: ${detail}`;
    await this.#putState({ ...state, status: "halted", haltReason: recorded, haltedAt: now });

    // 1. Cancel every open order.
    await this.#cancelOpenOrders(config, state);

    // 3. Mark the instance halted with a recorded reason, in D1 too.
    await this.#mirrorStatus(config, "halted", recorded, now, now);

    // 4. Fire an alert. Written to D1 unconditionally per section 10; the
    //    outbound Discord/Telegram notification and its KV cooldown are step 8.
    await this.#alert(config, {
      severity: reason === "take_profit_reached" ? "info" : "critical",
      category: reason === "unhandled_error" ? "system" : "trading",
      alertType: `halt_${reason}`,
      message: recorded,
    });
    await this.#audit(config, "bot.halted", actor, { reason, detail }, now);

    // 5. Never auto-resume: there is no path from `halted` back to `running`
    //    except `resume()`, which takes an actor.
    return { status: "halted", action: "halted", detail: recorded };
  }

  /**
   * Cancel every order believed live, and reconcile what the exchange says
   * about each one on the way out.
   *
   * Uses the `OrderStatus` that `cancelOrder` returns (step 3.1) rather than a
   * follow-up `getOrderStatus` per order: during a halt that is faster, costs
   * less rate-limit budget, and is not racy, because the cancellation response
   * is the same operation that ended the order.
   */
  async #cancelOpenOrders(config: DcaConfig, state: BotRuntimeState): Promise<void> {
    if (state.openOrderIds.length === 0) return;
    const exchange = this.#deps().exchange;
    const now = this.#now();
    const stillOpen: string[] = [];

    for (const clientOrderId of state.openOrderIds) {
      const outcome = await exchange.cancelOrder(config.pair, clientOrderId);
      const order = await this.#order(clientOrderId);
      if (order === undefined || isTerminal(order.state)) continue;

      if (!isUsable(outcome)) {
        // The order's fate is unknown. Section 5.6 forbids treating that as a
        // cancellation, so it stays open and is alerted on. Deliberately does
        // not abort the loop: the remaining orders still need cancelling, and a
        // halt that stops at the first failure is a halt that half happened.
        stillOpen.push(clientOrderId);
        await this.#alert(config, {
          severity: "critical",
          category: "trading",
          alertType: "cancel_failed",
          message:
            `could not confirm cancellation of ${clientOrderId} during a halt ` +
            `(${outcome.kind}: ${outcome.message}); it may still be live on the exchange`,
        });
        continue;
      }

      await this.#recordCancellation(config, order, outcome.value, now);
    }

    await this.#putState({ ...(await this.#state()), openOrderIds: stillOpen });
  }

  /**
   * Fold a cancellation response into the local order.
   *
   * Step 3.1's open question 1 asked what happens when the exchange reports
   * MORE filled at cancellation than this bot knew about. It happens: a resting
   * order can fill in the window before the cancel lands. The answer here is to
   * record the difference and alert, NOT to fold it into the position, because
   * a cancellation response carries no fills array and therefore no `fillId` --
   * and `applyFill` deduplicates on exactly that id. Synthesising one would
   * mean that when the real fill arrives from the account trade list, it either
   * double-counts or is silently swallowed.
   *
   * So the position is left understating what the bot holds, the discrepancy is
   * alerted with both numbers, and section 9's reconciliation is what closes it
   * -- which is the job it already exists to do.
   */
  async #recordCancellation(
    config: DcaConfig,
    order: TrackedOrder,
    remote: OrderStatus,
    now: Timestamp,
  ): Promise<void> {
    const cancelled = closeOrder(order, "cancelled", remote.updatedAt);
    await this.#putOrder(cancelled);
    await this.#mirrorOrderUpdate(cancelled);

    if (remote.filledQuantity > order.filledQuantity) {
      await this.#alert(config, {
        severity: "warning",
        category: "trading",
        alertType: "cancel_fill_discrepancy",
        message:
          `${order.clientOrderId} was cancelled with ${toDecimalString(remote.filledQuantity)} ` +
          `filled, but this bot had recorded ${toDecimalString(order.filledQuantity)}. The ` +
          `cancellation response carries no per-fill breakdown and therefore no trade id, so ` +
          `the difference is NOT applied to the position here; reconciliation owns it.`,
      });
    }
    void now;
  }

  /**
   * Section 7.5: an unexpected exception halts this bot and alerts.
   *
   * The alert is left to `#halt`, which already raises one carrying this
   * message and classifies `unhandled_error` as a `system` alert rather than a
   * trading one. Raising a second here would put two rows in `alerts` for one
   * event, and section 10 wants the table to be the dashboard's complete
   * history -- duplicates make it a less useful one, not a more complete one.
   */
  async #haltOnUnexpected(config: DcaConfig, error: unknown): Promise<PipelineResult> {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    return await this.#halt(config, "unhandled_error", message, "system");
  }

  // -------------------------------------------------------------------------
  // The D1 mirror
  // -------------------------------------------------------------------------

  async #mirrorStatus(
    config: DcaConfig,
    status: BotStatus,
    haltReason: string | null,
    haltedAt: Timestamp | null,
    now: Timestamp,
  ): Promise<void> {
    // Never `stopped`: that transition belongs to releaseBotCapital alone.
    await this.#db().botInstances.update(
      { id: config.botInstanceId, status: { ne: "stopped" } },
      { status, halt_reason: haltReason, halted_at: haltedAt, updated_at: now },
    );
  }

  /**
   * `orders.id` is the clientOrderId.
   *
   * Deterministic on purpose. The row is written from a pipeline that section
   * 5.1 says can be redelivered, and a generated id would insert a second row
   * for the same order on a replay. With this, the replay collides with the
   * PRIMARY KEY instead -- the same protection `client_order_id UNIQUE` already
   * gives, applied to the identity column as well.
   */
  async #mirrorOrderInsert(
    config: DcaConfig,
    order: TrackedOrder,
    exchangeOrderId: string,
  ): Promise<void> {
    const row: OrderRow = {
      id: order.clientOrderId,
      bot_instance_id: config.botInstanceId,
      client_order_id: order.clientOrderId,
      exchange_order_id: exchangeOrderId,
      side: order.side,
      price: order.price,
      quantity: order.quantity,
      filled_quantity: order.filledQuantity,
      status: order.state,
      created_at: order.createdAt,
      updated_at: order.updatedAt,
    };
    await this.#db().orders.insert(row);
  }

  async #mirrorOrderUpdate(order: TrackedOrder): Promise<void> {
    await this.#db().orders.update(
      { id: order.clientOrderId },
      {
        filled_quantity: order.filledQuantity,
        status: order.state,
        updated_at: order.updatedAt,
      },
    );
  }

  /**
   * One `trades` row per fill, with section 5.5's fee conversion done at fill
   * time rather than recomputed later.
   *
   * The rate source is the fill itself, which covers the two cases that
   * actually occur on a spot limit order: a fee in the quote asset needs no
   * rate at all, and a fee in the base asset converts at the fill's own price.
   * Anything else -- a fee paid in the exchange's own token, which is the
   * common third case -- has no rate available here, and step 2's decision 9
   * applies: all three reporting columns are left NULL rather than guessing.
   * Migration 0001's `fee_conversion_all_or_nothing` CHECK enforces that.
   */
  async #mirrorTrade(config: DcaConfig, order: TrackedOrder, fill: Fill): Promise<void> {
    const state = await this.#state();
    const baseAsset = state.filters?.baseAsset;

    const lookup: RateLookup = (asset) => {
      if (asset === baseAsset) return fill.price;
      return undefined;
    };
    const converted = convertFillFee(fill, config.capitalAsset, lookup);

    const row: TradeRow = {
      id: `${order.clientOrderId}:${fill.fillId}`,
      order_id: order.clientOrderId,
      bot_instance_id: config.botInstanceId,
      exchange_trade_id: fill.fillId,
      price: fill.price,
      quantity: fill.quantity,
      fee_amount: fill.feeAmount,
      fee_asset: fill.feeAsset,
      fee_reporting_amount: converted.converted ? converted.reportingAmount : null,
      fee_reporting_asset: converted.converted ? config.capitalAsset : null,
      fee_conversion_rate: converted.converted ? converted.rateUsed : null,
      executed_at: fill.executedAt,
    };
    await this.#db().trades.insert(row);
  }

  async #alert(
    config: DcaConfig,
    alert: {
      severity: AlertRow["severity"];
      category: AlertRow["category"];
      alertType: string;
      message: string;
    },
  ): Promise<void> {
    const row: AlertRow = {
      id: this.#newId(),
      severity: alert.severity,
      category: alert.category,
      alert_type: alert.alertType,
      bot_instance_id: config.botInstanceId,
      source: "bot-instance",
      message: alert.message,
      resolved: false,
      created_at: this.#now(),
    };
    await this.#db().alerts.insert(row);
  }

  async #audit(
    config: DcaConfig,
    action: string,
    actor: string,
    details: Record<string, unknown>,
    now: Timestamp,
  ): Promise<void> {
    const row: AuditLogRow = {
      id: this.#newId(),
      actor,
      action,
      target_bot_instance_id: config.botInstanceId,
      details_json: details,
      created_at: now,
    };
    await this.#db().auditLog.insert(row);
  }
}
