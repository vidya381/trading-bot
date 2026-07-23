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
 * RATE LIMITING (section 5.4, added at step 8)
 * -------------------------------------------
 * This object never talks to the exchange client it was handed. Every call goes
 * through `#exchange()`, which wraps that client in the account's `RateLimiter`
 * Durable Object, so budget is requested before the request is made rather than
 * afterwards and hopefully.
 *
 * The wrapping happens HERE rather than being the caller's job, deliberately.
 * If `attach()` simply accepted an already-limited client, then routing through
 * the budget would be a property of how each caller happened to construct its
 * dependencies -- true in the wiring someone remembered and false in the one
 * they did not. Doing it inside means a bot cannot be given an ungated client
 * even on purpose.
 *
 * Which priority a call carries is chosen at the call site, by asking for
 * `#exchange(config, "risk-exit")` instead of `#exchange(config, "routine")`.
 * The risk-exit views are the halt path's cancellations, the take-profit exit
 * sell, and the filter read that exit needs in order to be constructible.
 * Everything else -- entry buys, their filter reads -- is routine and may only
 * draw on `limit - reserveForRiskExit`.
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
import { withRateLimit, type RateLimiterPort } from "../exchange/rate-limited";
import type { RequestPriority } from "../shared/rate-limiter";
import { convertFillFee, type RateLookup } from "../shared/fees";
import { assertAccountArmed } from "../reconciliation/circuit-breaker";
import { assertGlobalArmed } from "../reconciliation/kill-switch";
import { IdempotencyGuard } from "../shared/idempotency";
import { divideRounded, mul, toDecimalString, ZERO, type Money } from "../shared/money";
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
import {
  decide as gridDecide,
  emptyLadder,
  encodeGridParams,
  GRID_SCHEMA_VERSION,
  assertReadableSchema as assertReadableGridSchema,
  levelOf,
  openOrderIds as ladderOpenOrderIds,
  planFill,
  validateGridParams,
  withSlot,
  type GridConfig,
  type GridHaltReason,
  type GridLadder,
  type GridOrderIntent,
  type GridParams,
  type GridSlot,
} from "../strategies/grid";
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

/**
 * Read a stored config, treating an absent `strategy` as `"dca"`.
 *
 * The `strategy` discriminator was added at step 9; any config written by step 6
 * lacks it. Rather than a schema-version bump and a migration, absence is read
 * as DCA -- the section-16-additive treatment. There is no such stored state
 * today (no exchange client has ever run), so this is belt-and-braces for the
 * one field that would otherwise be `undefined` on a legacy row.
 */
function normalizeConfig(stored: BotConfig): BotConfig {
  if ((stored as { strategy?: string }).strategy === undefined) {
    return { ...(stored as DcaConfig), strategy: "dca" };
  }
  return stored;
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
  /**
   * Section 5.4 refused the budget for a request this action needed.
   *
   * A code rather than a plain throw for the reason step 2's decision 8 gives:
   * section 7.5 escalates an unhandled exception to a halt, and backpressure is
   * not an emergency. The code is what lets `onPriceUpdate` catch and branch.
   */
  | "throttled"
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
   *
   * This is the RAW client. It is never called directly -- `#exchange()` wraps
   * it in the account's rate limiter first (section 5.4).
   */
  readonly exchange: RestExchangeClient;
  readonly now: () => Timestamp;
  readonly newId: () => string;
  /**
   * The `RateLimiter` Durable Object for an account.
   *
   * Defaults to the `RATE_LIMITER` binding. Overridable so a test can supply a
   * recording double, and so a test that wants to observe throttling can drive
   * one with a controlled clock.
   */
  readonly limiterFor?: (accountLabel: string) => RateLimiterPort;
  /** How the rate-limit wait is performed. Injected so tests need no delay. */
  readonly sleep?: (ms: number) => Promise<void>;
}

/**
 * The two strategy configurations this one object serves (step 9).
 *
 * Reusing the existing `BotInstance` rather than building a second Durable
 * Object, per the note the RateLimiter session left: the lifecycle, halt, order
 * placement, mirroring and rate limiting are all strategy-agnostic and already
 * built. Only the planner and the stored strategy state differ, and both are
 * plumbed through here, discriminated by `config.strategy`.
 */
export type BotConfig = DcaConfig | GridConfig;

/**
 * The fields both strategy configs share, which every strategy-agnostic method
 * depends on. Both `DcaConfig` and `GridConfig` structurally satisfy this, so a
 * shared method can take `BotConfigBase` and be handed either.
 */
export interface BotConfigBase {
  readonly strategy: "dca" | "grid";
  readonly schemaVersion: number;
  readonly botInstanceId: string;
  readonly accountLabel: string;
  readonly exchange: string;
  readonly pair: string;
  readonly capitalAsset: string;
  readonly allocatedCapital: Money;
}

/** A halt reason from either strategy. `#halt` is shared, so it accepts both. */
export type HaltReason = DcaHaltReason | GridHaltReason;

/**
 * This object's persisted runtime state, beside its configuration.
 *
 * The lifecycle fields (status, sequence, open orders, halt, price, filters) are
 * shared by both strategies. `realizedGross` and `exitOrderId` are shared too --
 * grid accumulates realized profit in the same field and tracks its liquidation
 * order the same way. The strategy-specific state is:
 *
 *  - DCA: `position` and `cycleCount`;
 *  - grid: `ladder`.
 *
 * A given bot populates only its own strategy's state. `ladder` is optional
 * rather than a discriminated arm so the DCA state written by step 6 remains
 * valid unchanged; a DCA bot leaves it absent, a grid bot leaves `position` at
 * `EMPTY_POSITION` and `cycleCount` at 0. The authoritative discriminator is
 * always `config.strategy`, not the presence of a field here.
 */
export interface BotRuntimeState {
  readonly schemaVersion: number;
  readonly status: BotStatus;
  /** DCA: completed take-profit cycles (section 6.3 step 6). Inert for grid. */
  readonly cycleCount: number;
  /** DCA position. `EMPTY_POSITION` and inert for a grid bot. */
  readonly position: DcaPosition;
  /**
   * Grid ladder (section 6.2), absent for a DCA bot. The grid-specific stored
   * state the step 9 brief calls for: level prices, per-level slots, held
   * position, and accumulated realized profit.
   */
  readonly ladder?: GridLadder;
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
  /** Gross realized profit: DCA cycles or grid round trips, before fees. */
  readonly realizedGross: Money;
  /** Cached symbol filters (section 4.3), refreshed when stale. */
  readonly filters: SymbolFilters | null;
  /**
   * Set while an exit sell is live, so its fill is attributed to the exit rather
   * than to strategy state. DCA: the take-profit sell, or a human liquidation.
   * Grid: the stop-loss, breakout, or take-profit liquidation sell, or a human
   * liquidation.
   */
  readonly exitOrderId: string | null;
  /**
   * Which KIND of exit `exitOrderId` is, so the fill can be completed correctly
   * (step 10.3). A DCA `take_profit` exit completes a cycle and may auto-restart
   * (section 6.3 step 6); a `liquidation` is a deliberate human close of a
   * halted bot and must stay halted. Grid ignores this -- its exit-fill folds
   * into the ladder and stays halted for every reason. Optional and defaulted to
   * `take_profit` on read, so DCA state written before this field remains valid
   * (the only exit that existed then was take-profit); nothing has ever run, so
   * this is belt-and-braces.
   */
  readonly exitKind?: "take_profit" | "liquidation";
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

export interface CreateGridBotRequest {
  readonly botInstanceId: string;
  readonly accountLabel: string;
  readonly exchange: string;
  readonly pair: Pair;
  /** The asset the allocation and every order size is denominated in. */
  readonly capitalAsset: Asset;
  readonly allocatedCapital: Money;
  readonly params: GridParams;
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
  readonly config: BotConfig;
  readonly state: BotRuntimeState;
  readonly orders: readonly TrackedOrder[];
}

const FILTER_MAX_AGE_MS = 3_600_000;

// ---------------------------------------------------------------------------

export class BotInstance extends DurableObject<Env> {
  #dependencies: BotInstanceDependencies | undefined;
  /**
   * The gated views of the exchange client, built once per attached client.
   *
   * Memoised rather than rebuilt per call so that the two views share one
   * inner client -- which matters, because `BinanceClient` holds the clock
   * offset and the symbol filter cache, and two views over two clients would
   * each re-sync the clock (section 4.2) at their own expense.
   */
  #gated: { routine: RestExchangeClient; riskExit: RestExchangeClient } | undefined;

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
      limiterFor: dependencies.limiterFor ?? this.#dependencies?.limiterFor,
      sleep: dependencies.sleep ?? this.#dependencies?.sleep,
    };
    // The gated views wrap a specific client and a specific limiter. Attaching
    // new ones must not leave the object still calling through the old pair.
    this.#gated = undefined;
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

  /**
   * The exchange, seen through section 5.4's budget at the given priority.
   *
   * The ONLY way this object reaches the exchange. `#deps().exchange` is the
   * raw client and is not called anywhere outside this method.
   */
  #exchange(config: BotConfigBase, priority: RequestPriority): RestExchangeClient {
    if (this.#gated === undefined) {
      const deps = this.#deps();
      const limiter = (deps.limiterFor ?? ((label) => this.#limiterFromEnv(label)))(
        config.accountLabel,
      );
      const routine = withRateLimit(deps.exchange, limiter, {
        priority: "routine",
        now: deps.now,
        label: config.botInstanceId,
        ...(deps.sleep !== undefined ? { sleep: deps.sleep } : {}),
      });
      this.#gated = { routine, riskExit: routine.withPriority("risk-exit") };
    }
    return priority === "risk-exit" ? this.#gated.riskExit : this.#gated.routine;
  }

  /**
   * The account's limiter from the binding.
   *
   * Refuses rather than falling back to an ungated client. That mirrors the
   * exchange client's own treatment above and for the same reason: the safe
   * default for a risk control is to stop, not to quietly do without it. An
   * environment with no `RATE_LIMITER` binding is one deployed with no `--env`,
   * which already has no database and no bots.
   */
  #limiterFromEnv(accountLabel: string): RateLimiterPort {
    const namespace = this.env.RATE_LIMITER;
    if (namespace === undefined) {
      throw new BotInstanceError(
        "not_attached",
        "no RATE_LIMITER binding in this environment, so section 5.4's budget " +
          "cannot be enforced. Refusing to trade ungated. Only testnet and " +
          "production declare one; a deploy with no --env has neither.",
      );
    }
    return namespace.get(namespace.idFromName(accountLabel));
  }

  // -------------------------------------------------------------------------
  // Stored state
  // -------------------------------------------------------------------------

  async #config(): Promise<BotConfig> {
    const stored = await this.ctx.storage.get<BotConfig>(CONFIG_KEY);
    if (stored === undefined) {
      throw new BotInstanceError(
        "not_created",
        "this bot instance has no configuration; call create() first",
      );
    }
    const config = normalizeConfig(stored);
    // Section 16: stored state carries a schemaVersion and the check runs the
    // first time an object wakes under new code, which is here. Each strategy
    // versions its own state, so the assertion is dispatched by strategy.
    if (config.strategy === "grid") {
      assertReadableGridSchema(config.schemaVersion);
    } else {
      assertReadableSchema(config.schemaVersion);
    }
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

    // Section 7.4, added at step 10.3, and section 7.3 at step 7. Two
    // independent latches gate creation, and BOTH must be armed: the global
    // kill switch (any account) and this account's own circuit breaker.
    // Halting everything that existed at the moment either was pulled is not a
    // control if the next creation starts trading straight back into whatever
    // caused it. Checked before any capital is reserved, so a refusal costs
    // nothing to undo. Global first: it is the broader condition.
    await assertGlobalArmed(db, `create bot ${request.botInstanceId}`);
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
      strategy: "dca",
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

  /**
   * Bring a GRID bot into existence (section 6.2), the same way `create` does
   * for DCA.
   *
   * Identical ordering and invariants: circuit-breaker check, ladder validation
   * against the allocation, then `createBotInstanceWithCapital` writes the
   * `bot_instances` row (this object never does), then the object's own storage.
   * The ladder is built here from the params so its level prices are fixed once
   * and persisted (grid decision 3), matching how DCA stores `averageEntryPrice`.
   *
   * `take_profit_pct` is written NULL: a grid's take-profit is an accumulated
   * profit AMOUNT in the params, not a percentage, and section 6.1 makes
   * take-profit only "recommended" for grid, not mandatory. The schema's
   * DCA-only take-profit CHECK permits this.
   */
  async createGrid(request: CreateGridBotRequest): Promise<{ botInstanceId: string; status: BotStatus }> {
    if ((await this.ctx.storage.get(CONFIG_KEY)) !== undefined) {
      throw new BotInstanceError(
        "already_created",
        `bot instance ${JSON.stringify(request.botInstanceId)} already has a configuration`,
      );
    }

    const db = this.#db();
    const now = this.#now();

    await assertGlobalArmed(db, `create bot ${request.botInstanceId}`);
    await assertAccountArmed(db, request.accountLabel, `create bot ${request.botInstanceId}`);

    // Section 6.1 checks the allocation against the account; this checks the
    // bot's own ladder against its allocation (grid's peak buy-side exposure),
    // and also rejects a degenerate or out-of-order ladder before any capital
    // is reserved.
    validateGridParams(request.params, request.allocatedCapital);

    await createBotInstanceWithCapital(
      db,
      {
        id: request.botInstanceId,
        accountLabel: request.accountLabel,
        asset: request.capitalAsset,
        exchange: request.exchange,
        pair: request.pair,
        strategyType: "grid",
        strategyParams: encodeGridParams(request.params),
        stopLossPct: request.params.stopLossPct,
        // Grid take-profit is an amount in the params, not a pct; null here.
        takeProfitPct: null,
        requestedCapital: request.allocatedCapital,
      },
      { actor: request.actor, now },
    );

    const config: GridConfig = {
      strategy: "grid",
      schemaVersion: GRID_SCHEMA_VERSION,
      botInstanceId: request.botInstanceId,
      accountLabel: request.accountLabel,
      exchange: request.exchange,
      pair: request.pair,
      capitalAsset: request.capitalAsset,
      allocatedCapital: request.allocatedCapital,
      params: request.params,
    };

    const state: BotRuntimeState = {
      schemaVersion: GRID_SCHEMA_VERSION,
      status: "created",
      cycleCount: 0,
      position: EMPTY_POSITION,
      ladder: emptyLadder(request.params),
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
      if (config.strategy === "grid") {
        return await this.#gridOnPrice(config, price);
      }

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
      if (error instanceof BotInstanceError && error.code === "throttled") {
        // Section 5.4 refused budget somewhere inside this pass. Nothing was
        // sent, so there is nothing to recover and nothing to halt over. The
        // pass is abandoned and the next price update re-evaluates from
        // scratch, because `decide()` is a pure function of position and price.
        await this.#alert(config, {
          severity: "warning",
          category: "system",
          alertType: "order_throttled",
          message: error.message,
        });
        return { status: "running", action: "throttled", detail: error.message };
      }
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
      if (config.strategy === "grid") {
        return await this.#applyGridFillToOrder(config, state, order, fill);
      }
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
  async halt(reason: HaltReason, detail: string, actor: string): Promise<PipelineResult> {
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

    // Sections 7.3 (step 7) and 7.4 (step 10.3). The other half of both latches:
    // a bot halted BY the global kill switch or this account's breaker must not
    // be resumable while either is still latched, or the control lasts exactly
    // as long as it takes someone to click resume. Re-arming each is a separate,
    // explicit human action (`resetGlobalKillSwitch` / `resetAccountCircuitBreaker`),
    // and each bot still has to be resumed individually afterwards per section
    // 7.2 step 5. Global first: it is the broader condition.
    await assertGlobalArmed(this.#db(), `resume bot ${config.botInstanceId}`);
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
   * Liquidate the held position on a HALTED bot: the unified human close-out
   * (step 10.3), usable identically by both strategies.
   *
   * This is the deliberate, human-triggered counterpart to two things that are
   * deliberately NOT automatic. DCA's `sellOnStopLoss` is refused (step 6,
   * decision 14) precisely so an auto-sell at a loss is never implicit; grid's
   * stop-loss DOES liquidate, but only for its three exit reasons, never for a
   * manual halt (step 9, decision 2). So neither strategy will sell a held
   * position out from under a human on its own. This method is how a human asks
   * for exactly that, once they have looked at a halted bot and decided to close
   * it -- through the SAME mechanism grid's stop-loss already uses (cancel open
   * orders, marketable limit sell at the current price, alert and leave it
   * resting if it does not fill), so a future dashboard button does not need to
   * know which strategy it is talking to.
   *
   * THREE GUARDS, in order:
   *
   *  1. HALTED ONLY. A running bot is refused. Liquidating a bot that is
   *     actively trading would race its own order placement -- selling base a
   *     replace-on-fill is about to sell again, or dropping a position the
   *     strategy still intends to manage. A human must halt it first, which is
   *     itself an explicit action. This is the one place the "callable
   *     regardless of WHY it is halted" freedom is bounded: any halt reason is
   *     fine (stop-loss, manual, breaker, error), but `running` is not a halt.
   *  2. NO EXIT ALREADY LIVE. If a liquidation or take-profit sell is already
   *     resting, a second would double-sell. Idempotent no-op instead.
   *  3. SOMETHING TO SELL. A flat position is a no-op, alerted at info so the
   *     dashboard shows the click landed and found nothing to do.
   */
  async liquidatePosition(actor: string): Promise<PipelineResult> {
    const config = await this.#config();
    let state = await this.#state();

    if (state.status !== "halted") {
      throw new BotInstanceError(
        "invalid_status",
        `liquidatePosition requires a halted bot; this one is ${JSON.stringify(state.status)}. ` +
          `Halt it first: a human must not sell a position out from under a bot that is still ` +
          `actively trading.`,
      );
    }

    if (state.exitOrderId !== null) {
      return { status: "halted", action: "hold", detail: "a liquidation or exit order is already live" };
    }

    const heldQuantity =
      config.strategy === "grid" ? state.ladder!.heldQuantity : state.position.quantity;

    if (heldQuantity <= ZERO) {
      await this.#alert(config, {
        severity: "info",
        category: "trading",
        alertType: "liquidation_noop",
        message: "liquidatePosition was called but the position is already flat; nothing to sell",
      });
      return { status: "halted", action: "nothing_to_liquidate" };
    }

    // Cancel anything still believed live before selling. A halt normally
    // cancels already, but a failed cancel can leave orders open (see
    // `#cancelOpenOrders`), and a grid halted for a non-exit reason still has
    // ladder slots referencing now-cancelled orders. Clearing them mirrors
    // `#gridExit`, so the liquidation sell is the only live order afterwards.
    await this.#cancelOpenOrders(config, state);
    state = await this.#state();
    if (config.strategy === "grid") {
      const cleared: GridLadder = { ...state.ladder!, slots: state.ladder!.slots.map(() => null) };
      await this.#putState({ ...state, ladder: cleared });
    }

    // "At current price" (section 4.5's marketable limit) needs a price, and a
    // human liquidation is not driven by a price event the way a stop-loss is.
    // So it is fetched fresh at risk-exit priority. Section 5.6 forbids treating
    // an unreachable exchange as data: if the read fails, the position is left
    // held on the halted bot and alerted, rather than sold at a stale or
    // unknown price. The last-seen price is deliberately NOT used as a fallback
    // -- a marketable limit priced off a stale tick may not be marketable.
    const priceOutcome = await this.#exchange(config, "risk-exit").getCurrentPrice(config.pair);
    if (!isUsable(priceOutcome)) {
      await this.#alert(config, {
        severity: "critical",
        category: "trading",
        alertType: "liquidation_no_price",
        message:
          `could not read a current price to liquidate at (${priceOutcome.kind}: ` +
          `${priceOutcome.message}); the position is left held on the halted bot`,
      });
      return { status: "halted", action: "no_price", detail: priceOutcome.message };
    }

    await this.#audit(
      config,
      "bot.liquidated",
      actor,
      {
        quantity: toDecimalString(heldQuantity),
        price: toDecimalString(priceOutcome.value.price),
        halt_reason: state.haltReason,
      },
      this.#now(),
    );

    // The shared mechanism grid's stop-loss uses. It sets `exitOrderId` and
    // `exitKind: "liquidation"`; the fill is folded by grid's `#applyGridExitFill`
    // or DCA's `#completeLiquidation`, both of which keep the bot halted.
    await this.#placeLiquidationSell(config, heldQuantity, priceOutcome.value);

    return { status: "halted", action: "liquidating", detail: toDecimalString(heldQuantity) };
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
    const stored = await this.ctx.storage.get<BotConfig>(CONFIG_KEY);
    const state = await this.ctx.storage.get<BotRuntimeState>(STATE_KEY);
    if (stored === undefined || state === undefined) return null;
    const config = normalizeConfig(stored);
    if (config.strategy === "grid") {
      assertReadableGridSchema(config.schemaVersion);
    } else {
      assertReadableSchema(config.schemaVersion);
    }
    const entries = await this.ctx.storage.list<TrackedOrder>({ prefix: ORDER_KEY_PREFIX });
    return { config, state, orders: [...entries.values()] };
  }

  // -------------------------------------------------------------------------
  // Order placement
  // -------------------------------------------------------------------------

  /**
   * Section 4.3's cached filters.
   *
   * Takes a priority because the read inherits the priority of what it is FOR:
   * an exit order that cannot be constructed without fresh filters is still
   * part of the exit, and making this read routine would put a stop-loss behind
   * routine traffic through the back door -- the exit's own `placeOrder` would
   * never be reached to use its reserved budget.
   */
  async #ensureFilters(
    config: BotConfigBase,
    state: BotRuntimeState,
    now: Timestamp,
    priority: RequestPriority,
  ): Promise<SymbolFilters> {
    const cached = state.filters;
    if (cached !== null && now - cached.fetchedAt < FILTER_MAX_AGE_MS) {
      return cached;
    }

    const outcome = await this.#exchange(config, priority).getSymbolFilters(config.pair);
    if (!isUsable(outcome)) {
      if (cached !== null) {
        // Section 5.6: a failed request is not data. Stale filters are still
        // the exchange's own last word on the symbol, and refusing to trade
        // because a refresh failed would be a worse answer than trading on
        // rules that were true an hour ago. Using them is deliberate, which is
        // why `SymbolFilterCache` separates `get` from `peek`.
        return cached;
      }
      if (outcome.kind === "rate_limited") {
        // Distinguished from the two below, which mean the exchange could not
        // be reached or refused. Nothing was reached here -- the budget said
        // wait -- and without this branch section 7.5's catch-all would halt a
        // perfectly healthy bot for the crime of being busy. That halt would
        // then need a human to undo it, per section 7.2 step 5.
        throw new BotInstanceError(
          "throttled",
          `cannot read symbol filters for ${config.pair} and none are cached: ` +
            `${outcome.message}`,
        );
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
    // Routine: this is an entry, and section 5.4's reserve exists precisely so
    // that entries cannot spend what an exit will need.
    const filters = await this.#ensureFilters(config, state, now, "routine");
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

    const outcome = await this.#exchange(config, "routine").placeOrder({
      pair: config.pair,
      clientOrderId: decision.clientOrderId,
      side: "buy",
      type: "limit",
      price: adjusted.price,
      quantity: adjusted.quantity,
    });

    if (!isUsable(outcome)) {
      if (outcome.kind === "rate_limited") {
        // Section 5.4 refused the budget, so NOTHING was sent. That is a third
        // thing from the two cases below and needs its own handling:
        //
        //  - not `transport`, whose attempt stays `attempting` because the
        //    order may be resting on the book. This order provably is not, so
        //    marking the attempt failed is the truthful record and leaves
        //    nothing for reconciliation to chase.
        //  - not a halt, which is what an `exchange_error` gets. The exchange
        //    has not refused anything; this system declined to ask. Halting a
        //    bot because the account was briefly busy would turn backpressure
        //    into an incident requiring human review to undo.
        //
        // The action is simply skipped. `decide()` is a pure function of the
        // position and the price, so the next price update re-evaluates it and
        // places the order then if it is still the right thing to do.
        await guard.markFailed(decision.clientOrderId, outcome.message, now);
        await this.#alert(config, {
          severity: "warning",
          category: "system",
          alertType: "order_throttled",
          message: `${label} buy skipped: ${outcome.message}`,
        });
        return { status: "running", action: "throttled", detail: outcome.message };
      }
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

    // Risk-exit throughout: section 6.3 step 4 makes this the cycle's mandatory
    // exit, and section 5.4 names exactly this class of order as the one that
    // must not queue behind routine traffic.
    const filters = await this.#ensureFilters(config, state, now, "risk-exit");
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

    const outcome = await this.#exchange(config, "risk-exit").placeOrder({
      pair: config.pair,
      clientOrderId: decision.clientOrderId,
      side: "sell",
      type: "limit",
      price: adjusted.price,
      quantity: adjusted.quantity,
    });

    if (!isUsable(outcome)) {
      if (outcome.kind === "rate_limited") {
        // As in `#placeBuy`: nothing was sent, so the attempt is marked failed
        // and the bot is not halted. Alerted at `critical` rather than
        // `warning`, unlike an entry -- an exit that could not be placed even
        // out of the RESERVED slice means the reserve was not big enough, which
        // is the one thing section 5.4's priority scheme exists to prevent and
        // is worth a human seeing. The exit is re-attempted on the next price
        // update, because `decide()` will still return `take_profit`.
        await guard.markFailed(decision.clientOrderId, outcome.message, now);
        await this.#alert(config, {
          severity: "critical",
          category: "system",
          alertType: "exit_order_throttled",
          message:
            `the take-profit exit could not obtain risk-exit budget: ${outcome.message}. ` +
            `It will be retried on the next price update; if this recurs, the ` +
            `reserved slice is too small for this account's traffic.`,
        });
        return { status: "running", action: "throttled", detail: outcome.message };
      }
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
      exitKind: "take_profit",
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
      // A take-profit exit completes the cycle (and may auto-restart); a human
      // liquidation of a halted bot stays halted. `exitKind` distinguishes them
      // explicitly rather than inferring it from status, so the two paths cannot
      // be confused by a future change to how status is set.
      if (state.exitKind === "liquidation") {
        return await this.#completeLiquidation(config, effect.order, fill);
      }
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
      exitKind: undefined,
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
   * A DCA liquidation sell has fully filled (step 10.3).
   *
   * Unlike `#completeCycle`, this is NOT a cycle completion: the bot was halted
   * when a human triggered `liquidatePosition`, and it STAYS halted. There is no
   * auto-restart to consider. The position is now flat, the realized proceeds --
   * a loss, quite possibly, since a liquidation is often a deliberate cut, and
   * that is recorded honestly rather than hidden -- are folded into
   * `realizedGross`, and the capital reservation is left untouched (releasing it
   * is a `close`, a separate human decision, exactly as `#completeCycle` leaves
   * it).
   */
  async #completeLiquidation(config: DcaConfig, exit: TrackedOrder, fill: Fill): Promise<PipelineResult> {
    const state = await this.#state();
    // Half-even, matching `#completeCycle`: an internal accounting figure.
    const proceeds = mul(exit.filledQuantity, exit.price, "half-even");
    const gross = proceeds - state.position.cost;

    const completed: BotRuntimeState = {
      ...state,
      position: EMPTY_POSITION,
      openOrderIds: state.openOrderIds.filter((id) => id !== exit.clientOrderId),
      exitOrderId: null,
      exitKind: undefined,
      realizedGross: state.realizedGross + gross,
    };
    await this.#putState(completed);
    await this.#audit(
      config,
      "bot.liquidation_filled",
      "system",
      { gross_proceeds: toDecimalString(gross), quantity: toDecimalString(exit.filledQuantity) },
      fill.executedAt,
    );
    await this.#alert(config, {
      severity: "info",
      category: "trading",
      alertType: "liquidation_filled",
      message:
        `the human-triggered liquidation sold ${toDecimalString(exit.filledQuantity)} at ` +
        `${toDecimalString(exit.price)} for a gross ${toDecimalString(gross)} ${config.capitalAsset}. ` +
        `The bot stays halted.`,
    });

    return { status: "halted", action: "liquidation_filled", detail: exit.clientOrderId };
  }

  /**
   * Step 2's decision 8 in practice: these codes describe races that genuinely
   * happen, and section 7.5's halt-on-exception would turn a redelivered queue
   * message into an emergency.
   */
  async #onOrderStateError(
    config: BotConfigBase,
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
  // Grid (section 6.2)
  // -------------------------------------------------------------------------

  /**
   * One price update for a grid bot. The grid analogue of the DCA branch in
   * `onPriceUpdate`: it plans against the pure `grid.ts` decision function and
   * carries the action out.
   *
   * Everything fill-driven -- the replace-on-fill that builds and rebuilds the
   * ladder -- is handled in `#applyGridFillToOrder`, not here, because it is
   * triggered by a fill, not a price. This method handles only the price-driven
   * events: initial placement, the stop-loss, the breakout, and the accumulated
   * take-profit.
   */
  async #gridOnPrice(config: GridConfig, price: Price): Promise<PipelineResult> {
    const state = await this.#state();
    const ladder = state.ladder!;
    const action = gridDecide({ config, ladder, price: price.price });

    switch (action.kind) {
      case "hold":
        return { status: "running", action: "hold" };
      case "place_initial_ladder":
        return await this.#placeInitialLadder(config, action.orders);
      case "stop_loss":
        return await this.#gridExit(config, "stop_loss", action.detail, price);
      case "breakout_take_profit":
        return await this.#gridExit(config, "breakout_take_profit", action.detail, price);
      case "take_profit":
        return await this.#gridExit(config, "take_profit", action.detail, price);
    }
  }

  /**
   * Section 6.2 step 2: place the initial buy ladder.
   *
   * Buys only (grid decision 1). Each order is placed at a level whose slot is
   * still empty, so a re-entry after a partial placement (some orders throttled)
   * fills the remaining levels rather than double-placing the ones already live.
   * `placed` is set true only once no order was throttled; a throttle leaves it
   * false so the next price update completes the ladder.
   */
  async #placeInitialLadder(config: GridConfig, orders: readonly GridOrderIntent[]): Promise<PipelineResult> {
    let throttled = false;
    for (const intent of orders) {
      const current = await this.#state();
      if (current.ladder!.slots[intent.levelIndex] != null) continue; // already placed
      const result = await this.#placeGridOrder(config, intent, intent.price, "routine");
      if (result.status === "halted") return result; // a hard rejection halted the bot
      if (result.action === "throttled" || result.action === "unresolved") throttled = true;
    }

    if (!throttled) {
      const current = await this.#state();
      await this.#putState({ ...current, ladder: { ...current.ladder!, placed: true } });
    }
    return {
      status: "running",
      action: throttled ? "initial_ladder_partial" : "placed_initial_ladder",
      detail: `${orders.length} buy levels below spot`,
    };
  }

  /**
   * Place one grid ladder order and, on success, record its slot.
   *
   * The grid counterpart of `#placeBuy`, and it follows exactly the same
   * idempotency and validation discipline: sequence persisted before the attempt
   * (step 6, decision 7), `validateOrder` twice as the two independent checks of
   * section 4.3, and the three-way outcome handling of section 5.4/5.6 -- a
   * budget refusal marks the attempt failed and skips (nothing was sent), a
   * transport failure leaves it unresolved for recovery, and an outright refusal
   * halts. The price and quantity come pre-computed from the ladder, so unlike
   * `#placeBuy` there is no per-order allocation budgeting (the whole ladder was
   * validated to fit at creation).
   *
   * The order's LEVEL determines its slot. The pure layer never mints an id, so
   * a placement that fails simply leaves the level empty -- correct, and the next
   * price update or reconciliation handles it.
   */
  async #placeGridOrder(
    config: GridConfig,
    intent: GridOrderIntent,
    limitPrice: Money,
    priority: RequestPriority,
  ): Promise<PipelineResult> {
    let state = await this.#state();
    const now = this.#now();
    const filters = await this.#ensureFilters(config, state, now, priority);
    state = await this.#state();

    const adjusted = validateOrder(
      { pair: config.pair, side: intent.side, price: limitPrice, quantity: intent.quantity },
      filters,
      { rounding: "adjust" },
    );
    if (!adjusted.valid) {
      await this.#alert(config, {
        severity: "warning",
        category: "trading",
        alertType: "order_not_constructible",
        message: `${intent.side} at grid level ${intent.levelIndex} skipped: ${adjusted.reason}`,
      });
      return { status: "running", action: "skipped", detail: adjusted.code };
    }

    const sequence = state.nextSequence;
    state = { ...state, nextSequence: sequence + 1 };
    await this.#putState(state);

    const guard = this.#guard(config.botInstanceId);
    const decision = await guard.beginAttempt(sequence, now);
    if (decision.action === "recover") {
      return { status: "running", action: "recover", detail: decision.reason };
    }

    const verified = validateOrder(
      { pair: config.pair, side: intent.side, price: adjusted.price, quantity: adjusted.quantity },
      filters,
      { rounding: "verify" },
    );
    if (!verified.valid) {
      await guard.markFailed(decision.clientOrderId, `failed the pre-send check: ${verified.reason}`, now);
      return await this.#halt(config, "order_rejected", `pre-send validation failed: ${verified.reason}`, "system");
    }

    const outcome = await this.#exchange(config, priority).placeOrder({
      pair: config.pair,
      clientOrderId: decision.clientOrderId,
      side: intent.side,
      type: "limit",
      price: adjusted.price,
      quantity: adjusted.quantity,
    });

    if (!isUsable(outcome)) {
      if (outcome.kind === "rate_limited") {
        await guard.markFailed(decision.clientOrderId, outcome.message, now);
        await this.#alert(config, {
          severity: priority === "risk-exit" ? "critical" : "warning",
          category: "system",
          alertType: priority === "risk-exit" ? "exit_order_throttled" : "order_throttled",
          message: `${intent.side} at grid level ${intent.levelIndex} skipped: ${outcome.message}`,
        });
        return { status: "running", action: "throttled", detail: outcome.message };
      }
      if (outcome.kind === "transport") {
        return { status: "running", action: "unresolved", detail: outcome.message };
      }
      await guard.markFailed(decision.clientOrderId, outcome.message, now);
      return await this.#halt(config, "order_rejected", `exchange refused the order: ${outcome.message}`, "system");
    }

    const result = outcome.value;
    await guard.markPlaced(decision.clientOrderId, result.exchangeOrderId, now);

    const order = createOrder({
      clientOrderId: decision.clientOrderId,
      pair: config.pair,
      side: intent.side,
      price: adjusted.price,
      quantity: adjusted.quantity,
      at: result.acceptedAt,
    });
    await this.#putOrder(order);

    const current = await this.#state();
    const slot: GridSlot = {
      side: intent.side,
      clientOrderId: decision.clientOrderId,
      costBasis: intent.costBasis,
      quantity: adjusted.quantity,
    };
    const ladder = withSlot(current.ladder!, intent.levelIndex, slot);
    await this.#putState({ ...current, ladder, openOrderIds: ladderOpenOrderIds(ladder) });
    await this.#mirrorOrderInsert(config, order, result.exchangeOrderId);

    for (const fill of result.fills) {
      await this.onFill(decision.clientOrderId, fill);
    }
    return { status: "running", action: `placed-${intent.side}-${intent.levelIndex}`, detail: decision.clientOrderId };
  }

  /**
   * Apply a fill against a grid bot's order (section 6.2 step 3).
   *
   * Two cases. If the order is the liquidation sell of an exit (`exitOrderId`),
   * it is folded through `#applyGridExitFill`. Otherwise it is a ladder order:
   * `planFill` clears the filled slot, moves the held position, computes any
   * realized profit, and hands back the replacement to place one level over --
   * a sell above a filled buy, a buy below a filled sell.
   */
  async #applyGridFillToOrder(
    config: GridConfig,
    state: BotRuntimeState,
    order: TrackedOrder,
    fill: Fill,
  ): Promise<PipelineResult> {
    const effect = applyFill(order, fill);
    await this.#putOrder(effect.order);

    if (state.exitOrderId === order.clientOrderId) {
      return await this.#applyGridExitFill(config, state, effect.order, effect.fullyFilled, fill);
    }

    const ladder = state.ladder!;
    const levelIndex = levelOf(ladder, order.clientOrderId);
    if (levelIndex < 0) {
      // The order is not on the ladder any more (its slot was cleared, e.g. by a
      // halt). Record the fill; there is no level to replace.
      await this.#mirrorOrderUpdate(effect.order);
      await this.#mirrorTrade(config, effect.order, fill);
      return { status: state.status, action: "fill_off_ladder", detail: order.clientOrderId };
    }

    const plan = planFill(ladder, config.params, levelIndex, fill.price, fill.quantity, effect.fullyFilled);
    const next: BotRuntimeState = {
      ...state,
      ladder: plan.ladder,
      realizedGross: plan.ladder.realizedGross,
      openOrderIds: ladderOpenOrderIds(plan.ladder),
    };
    await this.#putState(next);
    await this.#mirrorOrderUpdate(effect.order);
    await this.#mirrorTrade(config, effect.order, fill);

    if (plan.replacement !== null) {
      // Place the replacement at the level's own price (a resting limit), routine
      // priority: rebuilding the ladder is ordinary work, not a risk exit.
      const placed = await this.#placeGridOrder(config, plan.replacement, plan.replacement.price, "routine");
      return placed.status === "halted"
        ? placed
        : { status: "running", action: `replaced-${plan.replacement.side}`, detail: order.clientOrderId };
    }
    return {
      status: next.status,
      action: effect.fullyFilled ? "filled" : "partially_filled",
      detail: order.clientOrderId,
    };
  }

  /**
   * Fold a fill against the liquidation sell placed by a grid exit.
   *
   * Realized profit for the liquidated slice is `proceeds - costPortion`, where
   * the cost portion is the held cost prorated by the fraction of the held
   * position this fill sold. On a full fill the exit is complete and its id is
   * cleared. The bot stays `halted` throughout -- the liquidation is the halt's
   * own action, not new trading.
   */
  async #applyGridExitFill(
    config: GridConfig,
    state: BotRuntimeState,
    order: TrackedOrder,
    fullyFilled: boolean,
    fill: Fill,
  ): Promise<PipelineResult> {
    const ladder = state.ladder!;
    const proceeds = mul(fill.price, fill.quantity, "half-even");
    const costPortion =
      ladder.heldQuantity > ZERO
        ? divideRounded(ladder.heldCost * fill.quantity, ladder.heldQuantity, "half-even")
        : ZERO;
    const realized = proceeds - costPortion;

    const nextLadder: GridLadder = {
      ...ladder,
      heldQuantity: ladder.heldQuantity - fill.quantity,
      heldCost: ladder.heldCost - costPortion,
      realizedGross: ladder.realizedGross + realized,
    };
    let next: BotRuntimeState = { ...state, ladder: nextLadder, realizedGross: nextLadder.realizedGross };
    if (fullyFilled) {
      next = {
        ...next,
        exitOrderId: null,
        exitKind: undefined,
        openOrderIds: next.openOrderIds.filter((id) => id !== order.clientOrderId),
      };
    }
    await this.#putState(next);
    await this.#mirrorOrderUpdate(order);
    await this.#mirrorTrade(config, order, fill);

    return {
      status: next.status,
      action: fullyFilled ? "grid_liquidated" : "partially_filled",
      detail: order.clientOrderId,
    };
  }

  /**
   * A grid exit (section 6.2 steps 4, 5, 6): cancel all, sell the held position,
   * halt.
   *
   * Built ON TOP of `#halt`, reusing its cancel-all and its step-6-decision-2
   * ordering (mark halted, THEN cancel) unchanged. The one thing grid adds over
   * a plain halt is the liquidation sell -- section 6.2 step 4's "sell any held
   * position" -- which a manual halt deliberately does not do (matching DCA,
   * whose `sellOnStopLoss` is refused). So the sell is layered here, only for the
   * three exit reasons, not baked into the shared `#halt`.
   */
  async #gridExit(
    config: GridConfig,
    reason: GridHaltReason,
    detail: string,
    price: Price,
  ): Promise<PipelineResult> {
    // Cancels every ladder order and marks the bot halted, in the safe order.
    await this.#halt(config, reason, detail, "system");

    // The cancelled orders leave the ladder slots stale; clear them. The held
    // position is untouched by cancellation (only unfilled orders were cancelled)
    // and is what the liquidation sell now disposes of.
    const state = await this.#state();
    const clearedLadder: GridLadder = { ...state.ladder!, slots: state.ladder!.slots.map(() => null) };
    await this.#putState({ ...state, ladder: clearedLadder });

    if (clearedLadder.heldQuantity > ZERO) {
      await this.#placeLiquidationSell(config, clearedLadder.heldQuantity, price);
    }

    return { status: "halted", action: reason, detail };
  }

  /**
   * Section 4.5-compliant liquidation: a LIMIT sell of the whole held position,
   * priced at the triggering price so it is marketable.
   *
   * Section 4.5 rules out market orders, so a stop-loss "sell any held position"
   * cannot be a market order -- it is a marketable limit at the current price. In
   * a fast drop that limit may not fill, in which case the bot is left halted
   * holding a resting sell; that is alerted rather than pretended away, and the
   * fill (whenever it lands) is folded through `#applyGridExitFill`. This is the
   * honest limit of a market-order-free stop-loss and is recorded as such in the
   * decision log.
   *
   * Risk-exit priority throughout: this is exactly the class of order section
   * 5.4's reserved slice exists for.
   *
   * Strategy-agnostic (widened to `BotConfigBase` at step 10.3): the body touches
   * only the pair, the guard, filters, `exitOrderId`/`exitKind` and
   * `openOrderIds`, never the ladder or the DCA position. Both the grid exit
   * (`#gridExit`) and the unified human `liquidatePosition` call it, so the two
   * strategies liquidate through one code path. The eventual fill is folded by
   * each strategy's own fill handler: grid's `#applyGridExitFill`, DCA's
   * `#completeLiquidation`.
   */
  async #placeLiquidationSell(config: BotConfigBase, quantity: Money, price: Price): Promise<void> {
    let state = await this.#state();
    const now = this.#now();
    const filters = await this.#ensureFilters(config, state, now, "risk-exit");
    state = await this.#state();

    const adjusted = validateOrder(
      { pair: config.pair, side: "sell", price: price.price, quantity },
      filters,
      { rounding: "adjust" },
    );
    if (!adjusted.valid) {
      await this.#alert(config, {
        severity: "critical",
        category: "trading",
        alertType: "liquidation_not_constructible",
        message:
          `the exit liquidation of ${toDecimalString(quantity)} could not be constructed: ` +
          `${adjusted.reason}. The position is left held on a halted bot; reconciliation owns it.`,
      });
      return;
    }

    const sequence = state.nextSequence;
    await this.#putState({ ...state, nextSequence: sequence + 1 });

    const guard = this.#guard(config.botInstanceId);
    const decision = await guard.beginAttempt(sequence, now);
    if (decision.action === "recover") return;

    const outcome = await this.#exchange(config, "risk-exit").placeOrder({
      pair: config.pair,
      clientOrderId: decision.clientOrderId,
      side: "sell",
      type: "limit",
      price: adjusted.price,
      quantity: adjusted.quantity,
    });

    if (!isUsable(outcome)) {
      if (outcome.kind === "rate_limited") {
        await guard.markFailed(decision.clientOrderId, outcome.message, now);
        await this.#alert(config, {
          severity: "critical",
          category: "system",
          alertType: "exit_order_throttled",
          message:
            `the exit liquidation could not obtain risk-exit budget: ${outcome.message}. It will ` +
            `not be retried automatically; the position is held on a halted bot and reconciliation ` +
            `owns it.`,
        });
        return;
      }
      if (outcome.kind === "transport") {
        // The sell may be resting on the book. Section 5.1: recover by lookup,
        // never re-send. Left for reconciliation; the attempt stays `attempting`.
        await this.#alert(config, {
          severity: "critical",
          category: "trading",
          alertType: "liquidation_unresolved",
          message: `the exit liquidation's outcome is unknown: ${outcome.message}. It may be resting on the book.`,
        });
        return;
      }
      await guard.markFailed(decision.clientOrderId, outcome.message, now);
      await this.#alert(config, {
        severity: "critical",
        category: "trading",
        alertType: "liquidation_failed",
        message: `the exit liquidation was refused: ${outcome.message}. The position is held on a halted bot.`,
      });
      return;
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
    const current = await this.#state();
    await this.#putState({
      ...current,
      exitOrderId: decision.clientOrderId,
      exitKind: "liquidation",
      openOrderIds: [...current.openOrderIds, decision.clientOrderId],
    });
    await this.#mirrorOrderInsert(config, order, outcome.value.exchangeOrderId);

    for (const fill of outcome.value.fills) {
      await this.onFill(decision.clientOrderId, fill);
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
    config: BotConfigBase,
    reason: HaltReason,
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
    // The "good news" halts -- a DCA cycle taken to profit, a grid cashed out on
    // its breakout or profit target -- are `info`, not `critical`. Only an
    // actual loss, error, or rejection is critical.
    const positiveExit = reason === "take_profit_reached" || reason === "take_profit" || reason === "breakout_take_profit";
    await this.#alert(config, {
      severity: positiveExit ? "info" : "critical",
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
   *
   * RISK-EXIT priority, and this is the call site section 5.4's reserved slice
   * was built for. Every caller of this method is getting out: a section 7.2
   * halt, a close, or the cancellation of a resting buy ahead of a take-profit
   * sell. For DCA that is at most one order, so the throttling is invisible;
   * for step 9's grid it is a full ladder cancelled in one pass, which is the
   * exposure step 7 measured and named as the real one.
   */
  async #cancelOpenOrders(config: BotConfigBase, state: BotRuntimeState): Promise<void> {
    if (state.openOrderIds.length === 0) return;
    const exchange = this.#exchange(config, "risk-exit");
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
    config: BotConfigBase,
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
  async #haltOnUnexpected(config: BotConfigBase, error: unknown): Promise<PipelineResult> {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    return await this.#halt(config, "unhandled_error", message, "system");
  }

  // -------------------------------------------------------------------------
  // The D1 mirror
  // -------------------------------------------------------------------------

  async #mirrorStatus(
    config: BotConfigBase,
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
    config: BotConfigBase,
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
  async #mirrorTrade(config: BotConfigBase, order: TrackedOrder, fill: Fill): Promise<void> {
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
    config: BotConfigBase,
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
      // Step 8: not yet seen by the notification dispatcher. Recording the
      // alert here is unconditional (section 10); the outbound ping is the
      // dispatcher's separate concern.
      notified_at: null,
    };
    await this.#db().alerts.insert(row);
  }

  async #audit(
    config: BotConfigBase,
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
