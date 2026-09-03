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

import {
  raiseStandingAlert,
  resolveClearedStandingAlerts,
  resolveHaltAlerts,
  standingAlertKey,
} from "../alerts";
import { CapitalError, createBotInstanceWithCapital, releaseBotCapital } from "../capital";
import { databaseFrom, type Database } from "../db";
import type {
  AlertRow,
  AuditLogRow,
  BotStatus,
  ExchangeId,
  OrderRow,
  StrategyType,
  TradeRow,
} from "../db/schema";
import { isExchangeId } from "../db/schema";
import { resolveExchangeForAccount } from "../workers/exchange-dispatch";
import { validateOrder } from "../exchange/binance/filters";
import type {
  Asset,
  Fill,
  OrderSide,
  OrderStatus,
  Pair,
  Price,
  RestExchangeClient,
  SymbolFilters,
  Timestamp,
} from "../shared/exchange-client";
import { isUsable } from "../shared/downtime";
import {
  haltAlertType,
  ORDER_STATE_DRIFT_ALERT_TYPES,
  POLL_HEALTH_ALERT_TYPES,
} from "../shared/alert-types";
import { withRateLimit, type RateLimiterPort } from "../exchange/rate-limited";
import type { PriceFeedConfig, PriceFeedPort } from "./price-feed";
import type { RequestPriority } from "../shared/rate-limiter";
import { convertFillFee, type RateLookup } from "../shared/fees";
import { assertAccountArmed } from "../reconciliation/circuit-breaker";
import { assertGlobalArmed } from "../reconciliation/kill-switch";
import { IdempotencyGuard, parseClientOrderId } from "../shared/idempotency";
import { divideRounded, mul, ONE, toDecimalString, ZERO, type Money } from "../shared/money";
import {
  applyFill,
  closeOrder,
  createOrder,
  isTerminal,
  OrderStateError,
  type OrderState,
  type TrackedOrder,
} from "../shared/order-state";
import {
  applyEntry,
  applyExit,
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
  type DcaEntry,
  type DcaParams,
  type DcaPosition,
} from "../strategies/dca";
import {
  claimSlot,
  decide as gridDecide,
  emptyLadder,
  encodeGridParams,
  GRID_SCHEMA_VERSION,
  assertReadableSchema as assertReadableGridSchema,
  levelOf,
  openOrderIds as ladderOpenOrderIds,
  planFill,
  vacantLadder,
  validateGridParams,
  withSlot,
  type GridConfig,
  type GridHaltReason,
  type GridLadder,
  type GridOrderIntent,
  type GridParams,
  type GridSlot,
} from "../strategies/grid";
import {
  ENTRY_CROSS_PCT,
  MAX_ENTRY_ATTEMPTS,
  TRAILING_STOP_SCHEMA_VERSION,
  assertReadableSchema as assertReadableTrailingStopSchema,
  decide as trailingStopDecide,
  encodeTrailingStopParams,
  entryLimitPrice,
  validateTrailingStopParams,
  type TrailingStopConfig,
  type TrailingStopHaltReason,
  type TrailingStopParams,
} from "../strategies/trailing-stop";
import { DurableObjectAttemptStore } from "./attempt-store";

// ---------------------------------------------------------------------------
// Storage keys
// ---------------------------------------------------------------------------

const CONFIG_KEY = "config";
const STATE_KEY = "state";
const ORDER_KEY_PREFIX = "order:";

/** The position fields `repairPosition` reports on, as decimal strings. */
function repairFieldsOf(state: BotRuntimeState): PositionRepairFields {
  return {
    quantity: toDecimalString(state.position.quantity),
    cost: toDecimalString(state.position.cost),
    averageEntryPrice: toDecimalString(state.position.averageEntryPrice),
    lastEntryPrice: toDecimalString(state.position.lastEntryPrice),
    entryCount: state.position.entries.length,
    additionalBuysUsed: state.position.additionalBuysUsed,
    realizedGross: toDecimalString(state.realizedGross),
    exitOrderId: state.exitOrderId,
    exitKind: state.exitKind ?? null,
  };
}
/** Step 20's scheduling state. Deliberately NOT part of `BotRuntimeState`. */
const POLL_KEY = "poll-schedule";

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
  | "orphaned_bot_row"
  /**
   * `resume` on a bot whose own books are currently known to disagree with the
   * exchange (step 57's fix 2).
   *
   * A code of its own rather than `invalid_status`, because the status is not
   * the problem: the bot IS halted and resuming a halted bot is exactly what
   * this method is for. What is wrong is the state it would resume ONTO, and an
   * operator reading `invalid_status` on a correctly-halted bot would reasonably
   * conclude the request was malformed and retry it.
   */
  | "position_unverified"
  /**
   * `close` on a bot whose cancel sweep could not resolve every open order.
   *
   * Distinct from `position_unverified`, which is about the POSITION being
   * untrustworthy. This is about an ORDER whose fate is unresolved, on the one
   * transition after which nothing observes this bot ever again.
   */
  | "orders_unresolved";

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
   * The exchange client, section 4.1. The live price feed is NOT part of this
   * interface -- step 14 made it a separate Durable Object (an outbound feed
   * socket cannot hibernate, so it cannot be a client method), and this object
   * receives prices through its own `onPriceUpdate`, not a client callback.
   *
   * OPTIONAL in practice: `attach` takes a `Partial`, and when this is omitted
   * (the production path) `#rawExchange` resolves a real client from the
   * environment for the account's registered exchange (step 13). A test supplies
   * this to inject a `FakeExchange` and keep the suite free of any live call.
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
  /**
   * The `PriceFeed` Durable Object for a market (step 14 D).
   *
   * Defaults to the `PRICE_FEED` binding, keyed by `${exchange}:${pair}`.
   * Overridable so a test can supply a double — and MUST be in every test that
   * drives a status transition, since the real feed's `subscribe` opens a live
   * socket, exactly as the exchange client is faked everywhere.
   */
  readonly feedFor?: (exchange: string, pair: string) => PriceFeedPort;
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
export type BotConfig = DcaConfig | GridConfig | TrailingStopConfig;

/**
 * The fields both strategy configs share, which every strategy-agnostic method
 * depends on. Both `DcaConfig` and `GridConfig` structurally satisfy this, so a
 * shared method can take `BotConfigBase` and be handed either.
 */
export interface BotConfigBase {
  readonly strategy: StrategyType;
  readonly schemaVersion: number;
  readonly botInstanceId: string;
  readonly accountLabel: string;
  readonly exchange: string;
  readonly pair: string;
  readonly capitalAsset: string;
  readonly allocatedCapital: Money;
}

/**
 * Does this price set a new high-water mark for this bot? Spec 22.2 decision 3.
 *
 * PURE, EXPORTED AND SEPARATE FROM THE MUTATION so the ratchet can be tested as
 * arithmetic rather than through a Durable Object.
 *
 * Returns a BOOLEAN rather than the next value, deliberately: the caller uses it
 * to decide whether to add the key at all, so a DCA or grid bot's stored state
 * stays byte-identical to what it was before this field existed.
 *
 * STRICTLY GREATER, never `>=`: an equal price is not a new high, and re-writing
 * on equality would be a storage write per candle on a flat market.
 */
export function raisesHighWaterMark(
  strategy: StrategyType,
  currentHighWaterMark: Money | undefined,
  price: Money,
): boolean {
  if (strategy !== "trailing_stop") return false;
  return currentHighWaterMark === undefined || price > currentHighWaterMark;
}

/** A halt reason from any strategy. `#halt` is shared, so it accepts all of them. */
export type HaltReason = DcaHaltReason | GridHaltReason | TrailingStopHaltReason;

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
  /**
   * Spec 22.2 decision 3 / 22.5 open question 3, RESOLVED as Option 1: the
   * highest price seen since entry, PERSISTED rather than derived.
   *
   * Derivation is not available: decision log 81 established there is no
   * per-tick record anywhere, D1 or DO storage -- a `BotInstance` sees one
   * closed candle at a time and retains nothing of the previous one. The cost of
   * persisting is one overwritten field per bot, not a growing log.
   *
   * ⚠ OPTIONAL (`?`), NOT `Money | null`, and the difference is load-bearing.
   * `lastPrice` can be non-optional because it has existed since the state shape
   * did; this field is ADDITIVE to a shape live bots already have on disk. An
   * already-running bot's stored state has no such key, so a non-optional
   * declaration would be a type lie the moment `#state()` casts a stored object
   * -- and would need a `schemaVersion` bump and a migration to become true.
   * Optional is the section-16-additive treatment this codebase already uses for
   * exactly this: `exitKind`, `pendingReplacements`, and `unmodelledBase`
   * (decision log 69, which took this same decision for the same reason).
   *
   * ABSENT means "no high recorded yet". Written ONLY for a trailing-stop bot,
   * and only ever upward -- see `raisesHighWaterMark`.
   */
  readonly highWaterMark?: Money;
  /**
   * TRAILING STOP ONLY (spec 22.10): how many times the single entry order has
   * been placed on the exchange.
   *
   * The bound on `decide`'s `open_entry`, which is otherwise unbounded -- see
   * `MAX_ENTRY_ATTEMPTS`. Counted here rather than derived from the order
   * records, for the same reason `nextSequence` is: the derivation would be a
   * scan of every order this bot has ever written, on the order-placing path.
   *
   * ⚠ OPTIONAL (`?`) for exactly the reason `highWaterMark` above is: this is
   * ADDITIVE to a state shape live bots already have on disk, so a non-optional
   * declaration would be a type lie the moment `#state()` casts a stored object.
   * ABSENT means zero, and `#trailingStopOnPrice` is the one place that `?? 0`.
   *
   * Written ONLY for a trailing-stop bot. DCA's and grid's entry retries are
   * bounded by their own cycle and ladder logic and neither branch touches this,
   * so the key is never added to their state at all.
   */
  readonly entryAttempts?: number;
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
  readonly exitKind?: "take_profit" | "liquidation" | "trailing_stop";
  /**
   * DCA ONLY: base this bot bought, still owns on the exchange, and no longer
   * counts anywhere else. Cumulative across every cycle, and NEVER traded.
   *
   * A cycle's exit sell is sized from `position.quantity` through
   * `validateOrder`, whose quantity "rounds DOWN unconditionally, on either
   * side" -- the only safe direction, since rounding up would ask to sell more
   * base than the account holds and the exchange rejects the whole order rather
   * than trimming it. `#completeCycle` then clears the position. Whatever the
   * final exit fill did not remove was therefore discarded: real base, bought
   * with this bot's own capital, sitting in the account and modelled nowhere,
   * on every completed cycle, permanently.
   *
   * TWO THINGS LAND HERE, and they are different sizes. The rounding residue is
   * strictly smaller than one `stepSize` and is normally exactly ZERO -- every
   * buy is PLACED at a step-aligned quantity and a venue fills it in step-aligned
   * pieces, so `position.quantity` is already a multiple of the step and the
   * floor is a no-op. It becomes non-zero when the grid itself moves: filters are
   * refetched hourly, and a venue that COARSENS `stepSize` mid-cycle strands
   * everything below the new step. The second is not bounded by the step at all:
   * base acquired AFTER the exit was sized cannot be in an order whose quantity
   * was fixed at placement. `#placeTakeProfitSell` cancels resting buys first,
   * but a cancellation that cannot be confirmed leaves the buy live (it alerts
   * `cancel_failed` and keeps the id), and `#recordCancellation` deliberately
   * defers an under-recorded fill to the poll -- so a whole buy's worth can land
   * between the sizing and the completion. That is thousands of steps, not a few
   * sats.
   *
   * WHY ACCUMULATED RATHER THAN CARRIED FORWARD INTO THE NEXT CYCLE. `decide`
   * reads `position.quantity <= ZERO` as "fresh cycle, place the base order", so
   * a carried-forward remainder would stop the bot ever opening one again and
   * would immediately judge it against the PREVIOUS cycle's
   * `averageEntryPrice` -- take-profit or stop-loss on a quantity too small to
   * construct an order from, which halts. It would also make `position.quantity`
   * mean two things at once (this cycle's holdings plus prior cycles' orphans),
   * which is exactly the ambiguity the position-tracking fixes removed: the
   * repair action rebuilds the position as `bought - sold` over the LIVE cycle's
   * orders and would read a carried remainder as an overstatement to correct
   * away. Kept outside `position` entirely, it is inert to all of that.
   *
   * WHY NOT SOLD OFF. The rounding residue is by definition below one step, and
   * `minQuantity` is never finer than `stepSize` on a real symbol, so an order
   * for it cannot be constructed at all -- `validateOrder` answers
   * `rounded_to_zero` or `quantity_below_min`. It is reported so a human can
   * decide, which for a sub-lot amount usually means "sweep it by hand, or leave
   * it".
   *
   * Optional and defaulted to ZERO on read, so state written before this field
   * existed stays valid. Nothing in the trading path reads it.
   */
  readonly unmodelledBase?: Money;
  /**
   * GRID ONLY: replacement orders that could not be placed yet because their
   * target level was still occupied by a live order.
   *
   * Section 6.2 step 3 replaces a filled buy with a sell one level up (and a
   * filled sell with a buy one level down). When several ladder orders fill in
   * the same instant, the poll folds them one at a time, and the replacement
   * for the first can target a level whose own order has filled but has not
   * been folded yet. `claimSlot` refuses to overwrite it -- and the intent has
   * to go SOMEWHERE, or the ladder quietly loses a rung and the base that buy
   * acquired sits held with nothing resting against it.
   *
   * So it queues here and is drained once the level frees up: at the top of
   * each poll pass, and after each grid fill is folded. FIFO, and holding at
   * most one intent per level (a second intent for the same level would mean
   * the ladder had two live orders there, which is the state this prevents).
   *
   * Optional and defaulted to empty on read, so state written before this
   * field existed stays valid.
   */
  readonly pendingReplacements?: readonly GridOrderIntent[];
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

export interface CreateTrailingStopBotRequest {
  readonly botInstanceId: string;
  readonly accountLabel: string;
  readonly exchange: string;
  readonly pair: Pair;
  /** The asset the allocation -- and therefore the single entry -- is denominated in. */
  readonly capitalAsset: Asset;
  readonly allocatedCapital: Money;
  readonly params: TrailingStopParams;
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

/** One execution `applyMissedFills` recorded, as decimal strings for transport. */
export interface AppliedFill {
  readonly clientOrderId: string;
  /** The exchange's OWN fill id (Gemini's `tid`), never a synthesised one. */
  readonly fillId: string;
  readonly quantity: string;
  readonly price: string;
}

/** The outcome of a `applyMissedFills` repair. */
export interface MissedFillsResult {
  /** Always the status it started with: this operation never resumes a bot. */
  readonly status: BotStatus;
  readonly applied: readonly AppliedFill[];
  /**
   * Orders or fills this pass could NOT account for, each with its reason.
   * Non-empty means the repair is incomplete -- deliberately reported rather
   * than swallowed, per section 5.6.
   */
  readonly skipped: readonly string[];
}

/**
 * The outcome of one `checkOpenOrders` pass.
 *
 * Deliberately the same reporting shape as `MissedFillsResult`: `applied` is
 * what moved, `skipped` is what this pass could NOT account for, and a caller
 * has to read the second one. The two operations differ in when they may run
 * and in whether they place orders, not in how honestly they report.
 */
export interface OrderCheckResult {
  /** The status the bot holds after the pass. This operation never changes it. */
  readonly status: BotStatus;
  /** Executions newly folded into the position, each with the exchange's own id. */
  readonly applied: readonly AppliedFill[];
  /**
   * Orders this pass could not fully account for, each with its reason.
   * Non-empty means the bot's books are still behind the exchange.
   */
  readonly skipped: readonly string[];
  /** Orders whose local record was closed to match a terminal exchange state. */
  readonly closed: readonly string[];
  /**
   * True when this pass stood aside for another rather than completing.
   *
   * Reported rather than hidden, because the three empty arrays above are
   * otherwise indistinguishable from a clean pass that found nothing -- and
   * "your books are up to date" is a very different answer from "I did not
   * look". A caller that cares should try again.
   */
  readonly deferred: boolean;
}

/**
 * The DCA position fields `repairPosition` reads, recomputes and may write.
 *
 * Decimal strings for transport, matching `AppliedFill`: this crosses a Durable
 * Object RPC boundary and then a JSON response, and a scale-8 `bigint` survives
 * neither.
 */
export interface PositionRepairFields {
  readonly quantity: string;
  readonly cost: string;
  readonly averageEntryPrice: string;
  readonly lastEntryPrice: string;
  readonly entryCount: number;
  /** Carried through untouched. See `repairPosition` on why it is not rebuilt. */
  readonly additionalBuysUsed: number;
  readonly realizedGross: string;
  readonly exitOrderId: string | null;
  readonly exitKind: "take_profit" | "liquidation" | "trailing_stop" | null;
}

/** One order's local-versus-exchange comparison, the evidence behind gates 3-5. */
export interface PositionRepairEvidence {
  readonly clientOrderId: string;
  readonly sequence: number;
  readonly side: OrderSide;
  readonly state: OrderState;
  readonly localFilledQuantity: string;
  /** `null` when the exchange could not be read for this order (gate 4). */
  readonly remoteFilledQuantity: string | null;
  /** `null` when unread; otherwise whether the two quantities are equal. */
  readonly agrees: boolean | null;
}

/** What one `repairPosition` pass found, computed, and (maybe) wrote. */
export interface PositionRepairReport {
  /**
   * `no_change` -- the live cycle already agrees with its own orders.
   * `would_repair` -- a report-mode pass that found a difference and wrote nothing.
   * `repaired` -- a committing pass that wrote.
   * `refused` -- a gate blocked it. `blockedBy` names which.
   */
  readonly outcome: "no_change" | "would_repair" | "repaired" | "refused";
  /** True only when this pass actually wrote. Always false in report mode. */
  readonly committed: boolean;
  readonly status: BotStatus;
  /** The gate that refused, e.g. `"gate 5: local/remote fill disagreement"`. */
  readonly blockedBy: string | null;
  /** Every reason behind `blockedBy`, one per offending order or condition. */
  readonly reasons: readonly string[];
  readonly before: PositionRepairFields;
  /**
   * What the live cycle's own orders say the position SHOULD be. Computed on
   * every pass, including a refused one -- seeing the number is the point of
   * report mode, and a gate that blocks the write does not invalidate the
   * arithmetic that would have been written.
   */
  readonly after: PositionRepairFields;
  readonly evidence: readonly PositionRepairEvidence[];
  /** The live cycle: every order after the last fully-filled sell. */
  readonly liveCycleOrderIds: readonly string[];
  /** How many completed cycles the partition found ahead of the live one. */
  readonly closedCycleCount: number;
  /** Observations that are NOT gate failures and do not block a commit. */
  readonly findings: readonly string[];
}

/** What happened on one pass of the event pipeline, for tests and the dashboard. */
export interface PipelineResult {
  readonly status: BotStatus;
  readonly action: string;
  readonly detail?: string;
}

/**
 * The `action` prefix `#placeGridOrder` reports when an order is now RESTING on
 * the exchange, and the predicate that reads it back.
 *
 * Spelled once, in one place, because the whole of step 3's cover depends on
 * telling "placed" from "not placed" correctly and the two used to be told apart
 * by listing the failures. Listing failures fails OPEN: every outcome nobody
 * remembered to list read as success, which is precisely how `skipped`,
 * `throttled`, `unresolved`, `recover` and `aborted` were each dropped while
 * `replaced-sell` was reported to the caller. Recognising the one SUCCESS shape
 * fails closed instead -- an outcome this does not know is treated as "no order
 * is resting", which at worst re-queues an intent that a later drain finds its
 * level already occupied and leaves queued, visibly.
 */
const GRID_PLACED_ACTION_PREFIX = "placed-";

export function gridOrderWasPlaced(result: PipelineResult): boolean {
  return result.action.startsWith(GRID_PLACED_ACTION_PREFIX);
}

/**
 * The standing incident raised when a running grid bot's ladder is dead and the
 * rebuild could not revive it.
 *
 * DELIBERATELY NOT IN `POLL_STANDING_ALERT_TYPES`. That set names the conditions
 * the POLL re-derives on every pass, and is what licenses the poll to close
 * them. This one is re-derived by the PRICE PASS instead -- see
 * `#reportLadderVacancy` for why a snapshot observer is the wrong place for it
 * -- and its own site owns both halves of the lifecycle. Adding it to that set
 * would let a poll that never evaluated the condition close a live incident.
 */
const LADDER_VACANT_ALERT_TYPE = "grid_ladder_vacant";

/**
 * Whether a grid bot has unresolved exchange business outside its ladder.
 *
 * Read by `vacantLadder` through `GridDecisionInput.outstanding`, and computed
 * here rather than there because all three fields live in `BotRuntimeState`,
 * which the pure strategy layer cannot see. The mirror of the `hasOpenOrder`
 * expression the DCA branch of `#onPriceUpdatePass` passes to `decide`.
 *
 * EXPORTED FOR ITS OWN TESTS, and the reason is worth stating: only ONE of the
 * three terms is independently reachable end to end. On the grid path
 * `exitOrderId` is only ever set for a quantity that was held (`#gridExit`
 * places a liquidation sell only when `heldQuantity > ZERO`) and is cleared by
 * the same fill that takes the position flat; a queued replacement likewise
 * exists because a buy filled and its sell could not be placed, so base is
 * held. In both cases `heldQuantity` already refuses the rebuild and the term
 * is defence in depth. Testing them through a bot would mean contriving a state
 * this system cannot actually produce -- so they are tested here, directly,
 * against the contract this function states rather than against a fixture.
 *
 * The third term, `openOrderIds`, IS independently reachable: a `#gridExit`
 * clears every rung while a cancellation that could not be confirmed keeps its
 * id on the list, leaving a flat bot with no rungs and real unresolved business
 * on the exchange. That one has an end-to-end test.
 */
export function gridOutstanding(state: BotRuntimeState): boolean {
  return (
    state.openOrderIds.length > 0 ||
    state.exitOrderId !== null ||
    (state.pendingReplacements ?? []).length > 0
  );
}

export interface BotSnapshot {
  readonly config: BotConfig;
  readonly state: BotRuntimeState;
  readonly orders: readonly TrackedOrder[];
}

const FILTER_MAX_AGE_MS = 3_600_000;

// ---------------------------------------------------------------------------
// The scheduled open-order poll (step 20)
// ---------------------------------------------------------------------------

/**
 * How often a bot with resting orders re-reads them (step 19's open question 3:
 * a decision, not a measurement). Four bots make the rate-limit cost trivial --
 * one `getOrderStatus` per open order at ROUTINE priority, which may only draw
 * on `limit - reserveForRiskExit` and can never eat into the slice section 5.4
 * holds back for getting OUT of a position.
 */
const POLL_INTERVAL_MS = 30_000;
/**
 * The three looser bases, and the one thing to understand before reading them:
 * THE POLL DOES NOT EVALUATE STOP-LOSS OR TAKE-PROFIT. Those run in
 * `#onPriceUpdatePass`, through `decide()`, on price ticks forwarded by the
 * `PriceFeed`; the alarm never calls `decide()`. Step 21 settled this
 * deliberately -- a poll-observed fill does not act, because the poll has no
 * price and every action either strategy can take needs one.
 *
 * So a slower poll does not slow any risk control down directly. What it slows
 * is FILL DETECTION, which reaches a decision only through the next tick, and
 * the feed's own measured cadence is one closed candle every 35-70s (~130s
 * worst case -- the figure that sized `PRICE_STALENESS_MS`). A 30-second poll
 * is therefore sampling about twice as fast as the signal that can act on what
 * it finds, for every bot that is not in one of the two urgent states below.
 *
 * 45s FOR A RUNNING GRID, because replace-on-fill runs from the poll path
 * (`#applyGridFillToOrder` places the paired sell), so its latency is real
 * inventory exposure rather than bookkeeping -- less urgent than a queued
 * replacement, more urgent than a DCA bot's records.
 *
 * 60s FOR DCA AND TRAILING STOP, where the poll only maintains `position` and
 * `hasOpenOrder` for the next tick to read. 60s keeps the worst case fill-to-
 * decision path at ~130s, exactly the gap between two closed candles this
 * system already tolerates -- so the poll stays at parity with the feed rather
 * than becoming the slower half. That parity is the reason not to go further.
 *
 * 120s WHILE HALTED, the midpoint of the range this was proposed over. A halted
 * bot places nothing, so the poll exists only to keep the books current for the
 * operator who is about to make a decision about them (step 19). Five minutes
 * was the other candidate and was rejected as too stale for someone actively
 * reviewing; 120s still removes three quarters of the firings and leaves the
 * backoff room to climb 120 -> 240 -> the cap.
 */
const POLL_INTERVAL_GRID_MS = 45_000;
const POLL_INTERVAL_ROUTINE_MS = 60_000;
const POLL_INTERVAL_DORMANT_MS = 120_000;
/** Slow retry once the reads are failing, so a long outage self-heals. */
const POLL_BACKOFF_CAP_MS = 300_000;

/**
 * Which cadence this bot's CURRENT state earns.
 *
 * Exported and pure for the same reason `gridOutstanding` is: the interesting
 * cases are combinations of state fields, and contriving each one through a
 * live bot would test the fixture more than the rule.
 *
 * THE TWO URGENT CHECKS COME FIRST, AHEAD OF STATUS, and that order is the
 * whole safety of this function rather than a stylistic choice. A grid
 * stop-loss cancels every rung, places a liquidation sell, and halts -- leaving
 * a bot that is `halted` AND mid-exit. Testing status first would put exactly
 * that bot on the dormant interval and slow the poll for the one resting order
 * in the system that most needs watching. `grid-bot-instance.test.ts` locks
 * this ordering down end to end.
 *
 * `ladder !== undefined` IS THE GRID TEST, and it is sound because this is only
 * ever consulted for an ARMED bot: `#pollArmed` requires a resting order, a
 * grid's resting orders are placed by its ladder, and no other strategy writes
 * the key at all. It is also the one derivation here that could be wrong
 * without being dangerous -- misreading a strategy moves 45s to 60s and nothing
 * else. The two urgent conditions are read directly from the fields that define
 * them, with no derivation in between, because those are the ones where being
 * wrong would matter.
 */
export type PollTier = "urgent" | "grid" | "routine" | "dormant";

export function pollTierFor(state: BotRuntimeState): PollTier {
  if (state.exitOrderId !== null) return "urgent";
  if ((state.pendingReplacements ?? []).length > 0) return "urgent";
  if (state.status === "halted") return "dormant";
  if (state.ladder !== undefined) return "grid";
  return "routine";
}

export const POLL_TIER_INTERVAL_MS: Record<PollTier, number> = {
  urgent: POLL_INTERVAL_MS,
  grid: POLL_INTERVAL_GRID_MS,
  routine: POLL_INTERVAL_ROUTINE_MS,
  dormant: POLL_INTERVAL_DORMANT_MS,
};
/** Consecutive unreadable passes before the poll is declared blind. */
const MAX_POLL_FAILURES = 5;
/** A blind poll gets louder after this long, mirroring the price feed's policy. */
const POLL_BLIND_ESCALATION_MS = 30 * 60_000;

/**
 * How long a RUNNING bot may go without a live price before the poll says so.
 *
 * WHY THIS EXISTS AT ALL, AND WHY IT IS THE POLL'S JOB. Step 21 decided that a
 * poll-observed fill does not drive a decision: it waits for the next price
 * tick, because the poll has no price and every action either strategy can take
 * needs one. That is only SOUND if a next tick is actually coming, and until
 * this constant nothing anywhere verified that -- `lastPriceAt` was written by
 * `#onPriceUpdatePass` and read by nothing. "Wait for the next tick" was a hope.
 * The poll is the right place to check because it is the only thing that already
 * wakes up on a schedule while a bot has resting orders, which is exactly the
 * state in which a missing tick is dangerous.
 *
 * WHAT THE FEED'S OWN ALERTS STRUCTURALLY CANNOT SEE, which is why this is not a
 * duplicate of `price_feed_blind`:
 *
 *  - `PriceFeed`'s staleness clock advances on ANY inbound frame, and it treats
 *    a `heartbeat` as liveness (`#lastMessageAt` moves). A socket that
 *    heartbeats healthily every ~5s while delivering no candles is therefore
 *    permanently FRESH to the feed. That shape is not hypothetical: step 14's
 *    deployed live check has a verdict for precisely it (`connectionOpened`
 *    true, `candlesUpdateReceived` false).
 *  - Fan-out failure is invisible from there too: a subscriber whose RPC returns
 *    `"ignored"` is a SUCCESSFUL RPC, so a bot that has silently stopped
 *    consuming looks fine to the feed.
 *  - A bot missing from the subscriber registry gets nothing while the feed is
 *    entirely healthy.
 *  - And `price_feed_blind` carries `bot_instance_id: null` by design (it is a
 *    feed concern, and the column is a foreign key), so it can never appear on
 *    a bot's page at all.
 *
 * Every existing check is per-socket and account-level. This is the only
 * end-to-end, per-bot one: did THIS bot receive a price.
 *
 * THE NUMBER, from step 14's live probe (Q1/Q2) rather than a guess:
 *
 *  - Heartbeats arrive every ~5.0s (min 4.8 / max 5.2 over 71 samples) and
 *    carry no price.
 *  - Candle frames arrive ONLY ON ACTIVITY, 35-70s apart.
 *  - Q1 was unanimous 6/6 CURRENT-ONLY: a closed candle is forwarded only when
 *    a frame carrying a NEWER `openTime` arrives.
 *
 * So `lastPriceAt` advances once per forwarded closed candle, and the worst-case
 * gap between two forwards is the same arithmetic step 14 used to size its
 * deployed 120s live-check window: up to ~60s to the next minute boundary, plus
 * up to ~70s of quiet before a frame carries the new `openTime`, so ~130s.
 * Typical is 30-70s.
 *
 * Ten minutes is 4.6x that worst case -- the same headroom discipline
 * `PriceFeed`'s own `STALENESS_MS` uses (20s = ~4 missed 5s heartbeats) -- and
 * about ten consecutive one-minute boundaries with no forward. It also sits
 * deliberately ABOVE the feed's own recovery envelope: a dead socket is detected
 * at 20s and five reconnects run over ~31s, so a RECOVERABLE outage never
 * reaches this threshold and this alert fires only on something the feed's
 * machinery did not fix.
 *
 * Generous on purpose, because the costs are asymmetric. A late alert costs
 * minutes on a condition reconciliation is still backstopping; a false one on a
 * genuinely quiet pair costs the alert fatigue step 18 measured at 186 identical
 * criticals in four hours.
 */
const PRICE_STALENESS_MS = 600_000;

/** `audit_log.actor` for a pass the alarm drove rather than a human. */
const POLL_ACTOR = "system";

/**
 * The `alerts.source` this object writes under. Scopes BOTH halves of the
 * standing-alert lifecycle, so this object deduplicates against, and resolves,
 * only its own rows -- never reconciliation's.
 */
const BOT_ALERT_SOURCE = "bot-instance";

/**
 * The alert types the poll RE-DETECTS on every pass, and is therefore competent
 * to both raise once and resolve.
 *
 * Every other alert this object writes stays an unconditional insert, and that
 * is the right treatment for them: `unknown_order_fill`, `order_state_drift`,
 * `cancel_failed` and the rest mark DISCRETE EVENTS at the moment they happen.
 * Nothing re-derives them on a schedule, so they cannot accumulate duplicates,
 * and three of them are ingested and resolved by reconciliation's own loop
 * (`INGESTED_ALERT_TYPES`) -- taking them over here would give one row two
 * owners.
 *
 * BUILT FROM THE SHARED LIST, not spelled out again. The three poll-health types
 * are declared in `shared/alert-types.ts` because the dashboard needs them too
 * (step 22's manual-recheck control surfaces on exactly those), and a second
 * copy here would be the duplicated-format bug that module exists to end.
 * `unattributable_fill` is added locally because it is a finding about the books
 * rather than a fault in the observation, and nothing outside this object keys
 * off it.
 *
 * EXPORTED so `alerts/standing.test.ts`'s source-level guard checks the real set
 * rather than a hand-copied one. That guard's whole job is to catch a FOURTH
 * type being added next to these and raised through `#alert`; a list it had to
 * be told about separately would silently stop covering the new one, which is
 * the same class of rot it exists to prevent.
 */
export const POLL_STANDING_ALERT_TYPES: ReadonlySet<string> = new Set<string>([
  "unattributable_fill",
  // Also a finding about the books rather than a poll fault, and standing for
  // the same reason: `#drainReplacements` re-evaluates the queue on every pass,
  // so an unconditional insert would write one row per pass for as long as a
  // level stays occupied. It resolves through the same machinery -- a pass that
  // drains the queue does not re-raise it, and the open alert closes.
  "grid_replacement_queued",
  ...POLL_HEALTH_ALERT_TYPES,
]);

/**
 * When the alarm should next fire, and what the poll has been failing at.
 *
 * Stored under its own key rather than inside `BotRuntimeState` deliberately:
 * that record is mirrored, snapshotted, and compared against by reconciliation,
 * and scheduling bookkeeping is none of those things. Keeping it separate also
 * means no `schemaVersion` bump and no risk to state written before this step.
 */
interface PollSchedule {
  /** When the next poll is due; null means the poll is not armed. */
  readonly nextPollAt: Timestamp | null;
  /** Consecutive passes that could not read this bot's open orders at all. */
  readonly failures: number;
  /** When the poll first went blind, or null while it can still see. */
  readonly blindSince: Timestamp | null;
  /** Whether this blind episode has already escalated. */
  readonly escalated: boolean;
}

const INITIAL_POLL_SCHEDULE: PollSchedule = {
  nextPollAt: null,
  failures: 0,
  blindSince: null,
  escalated: false,
};

/**
 * One observation pass, plus the two things the alert lifecycle needs to know
 * about it that `OrderCheckResult` deliberately does not carry.
 *
 * `skipped` is not a substitute for `unreadable`: it also holds fills that were
 * read perfectly well and then refused (an unattributable quantity, a fill the
 * state machine would not accept). Gating the alert lifecycle on `skipped`
 * would mean a standing `unattributable_fill` kept `poll_blind` open forever,
 * conflating "we cannot see" with "we can see something wrong".
 */
interface PollPass {
  readonly applied: AppliedFill[];
  readonly skipped: string[];
  readonly closed: string[];
  /**
   * The subset of `skipped` this pass READ successfully and then REFUSED to act
   * on: the `#foldTerminalState` quantity gate, an unattributable fill, an
   * `OrderStateError`, a missing local record.
   *
   * THE SAME DISTINCTION STEP 20 DREW BETWEEN `skipped` AND `unreadable`, kept
   * structurally rather than by arithmetic. `skipped` deliberately holds both
   * kinds, so "the refusals" was previously only derivable as
   * `skipped.length - unreadable` -- true today purely because every unreadable
   * read happens to push exactly one line, which is an invariant nothing states
   * and nothing enforces. Every refusal now pushes through `refuse()`, which
   * writes both lists, so the two can never disagree.
   *
   * It exists because it is what step 22's audit gate turns on: a pass that
   * correctly identified a real problem and declined to act is the single most
   * important thing this object can record, and it used to write nothing at all.
   */
  readonly refused: string[];
  /** Open orders this pass attempted to read. */
  readonly reads: number;
  /** How many of those reads failed. Section 5.6: an unreachable venue is not data. */
  readonly unreadable: number;
  /** Standing incident keys this pass FOUND, for the resolve half. */
  readonly standing: Set<string>;
  /**
   * THE THIRD OUTCOME (step 21), and it is neither of the other two.
   *
   * A deferred pass stood aside for another pass rather than failing. It is not
   * `unreadable`: the venue answered, or was never asked. It is not `skipped`
   * either: nothing was read and refused. Folding it into either would break
   * one of the two lifecycles step 20 built --
   *
   *   - counted as a FAILURE, a busy bot would back off to the five-minute
   *     floor and eventually raise `poll_blind`, reporting an outage while the
   *     exchange was reachable the whole time;
   *   - counted as a SUCCESS, it would resolve standing alerts it never looked
   *     for, closing a live `unattributable_fill` on the strength of a pass
   *     that deliberately looked at nothing.
   *
   * So it is its own thing, exactly as step 20 kept `skipped` and `unreadable`
   * apart for the same class of reason.
   */
  deferred: boolean;
}

/**
 * True when a pass is entitled to close a standing alert it did not re-find.
 *
 * A DEFERRED pass never is. It stopped early by design, so the alerts it did
 * not re-find are alerts it did not look for -- section 5.6 applied to the
 * alert lifecycle, which is the same rule that already excludes a pass that
 * could not reach the venue.
 */
function observedEverything(pass: PollPass): boolean {
  return pass.reads > 0 && pass.unreadable === 0 && !pass.deferred;
}

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
   * How many non-poll passes are inside this object right now.
   *
   * The poll yields whenever this is above zero. See `#outsidePoll`.
   */
  #passesInFlight = 0;

  /**
   * Supply or override this object's dependencies.
   *
   * The database comes from the environment by default. The exchange client is
   * NOT built here: it is resolved lazily by `#rawExchange` the first time a call
   * needs it, from the bot's own stored `exchange`/`accountLabel` through
   * `resolveExchangeForAccount` (step 13). Attaching an exchange overrides that
   * resolution -- which is how tests inject a `FakeExchange` and keep the suite
   * free of any live call. Left unattached in production, the object resolves a
   * real client on demand and refuses (fails closed) if credentials or a trading
   * `ENVIRONMENT` are absent, rather than constructing a client against secrets
   * that do not exist.
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
      feedFor: dependencies.feedFor ?? this.#dependencies?.feedFor,
    };
    // The gated views wrap a specific client and a specific limiter. Attaching
    // new ones must not leave the object still calling through the old pair.
    this.#gated = undefined;
  }

  /**
   * This bot's venue, as an `ExchangeId`, or a refusal to trade.
   *
   * `BotConfigBase.exchange` is a free-typed `string` (it is read back from
   * storage), and TWO things now need it narrowed: the client dispatch below,
   * which has always validated it, and the gate in `#exchange`, which must
   * charge this venue's weights and cannot pick a table for a venue it cannot
   * name. Hoisted into one method so both get the same answer and the same
   * message rather than one of them re-deriving it.
   *
   * Refusing is the only safe move, and it is the move `#rawExchange` already
   * made: a bot whose stored exchange is not a known venue can neither have a
   * client built for it nor be gated against a real cost model, so it must not
   * trade. `#subscribeToFeed` deliberately does NOT use this -- it returns
   * quietly instead, because a corrupt exchange must halt the bot at its first
   * trade (here), not block a state transition.
   */
  #venue(config: BotConfigBase): ExchangeId {
    if (!isExchangeId(config.exchange)) {
      throw new BotInstanceError(
        "not_attached",
        `bot ${config.botInstanceId}'s stored exchange ${JSON.stringify(config.exchange)} ` +
          `is not a known exchange ("binance" or "gemini"); refusing to build a client.`,
      );
    }
    return config.exchange;
  }

  /**
   * The RAW exchange client for this bot: injected if a test attached one,
   * otherwise built from the environment for the account's registered exchange.
   *
   * An injected client always wins, so every test that `attach`es a `FakeExchange`
   * is unaffected and the automated suite still makes no live call. When nothing
   * is injected -- the production path -- the client is resolved from the bot's own
   * stored `exchange` and `accountLabel` through `resolveExchangeForAccount`, the
   * single dispatch home step 11 decision 7 built for exactly this: it derives the
   * base URL from `ENVIRONMENT` alone (impossible to point testnet at production),
   * reads the account's secrets, and hands back a `RestExchangeClient` already
   * wired to report used weight into section 5.4's budget. `now` is threaded so the
   * client's clock-drift correction (section 4.2) uses the same clock the object
   * does.
   *
   * Every fail-closed reason -- a non-trading `ENVIRONMENT`, a missing secret, an
   * unregistered/unknown exchange value, a null factory result -- becomes a
   * `not_attached` `BotInstanceError` carrying the resolver's own message, so the
   * object refuses to trade rather than constructing a client against credentials
   * that do not exist. This is the raw client; `#exchange` wraps it in the account
   * rate limiter (the gate) before any call.
   */
  #rawExchange(config: BotConfigBase, now: () => Timestamp): RestExchangeClient {
    const injected = this.#dependencies?.exchange as RestExchangeClient | undefined;
    if (injected !== undefined) return injected;

    const resolution = resolveExchangeForAccount(this.#venue(config), this.env, now);
    if (!resolution.ok) {
      throw new BotInstanceError("not_attached", resolution.reason);
    }

    const client = resolution.exchangeFor(config.accountLabel);
    if (client === null) {
      throw new BotInstanceError(
        "not_attached",
        `no exchange client could be built for account ${JSON.stringify(config.accountLabel)} ` +
          `on ${config.exchange}.`,
      );
    }
    return client;
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
   * The ONLY way this object reaches the exchange. `#rawExchange` supplies the
   * raw client (injected in tests, resolved from the environment in production)
   * and is not called anywhere outside this method.
   */
  #exchange(config: BotConfigBase, priority: RequestPriority): RestExchangeClient {
    if (this.#gated === undefined) {
      if (this.#dependencies === undefined) this.attach({});
      const deps = this.#dependencies!;
      const raw = this.#rawExchange(config, deps.now);
      const limiter = (deps.limiterFor ?? ((label) => this.#limiterFromEnv(label)))(
        config.accountLabel,
      );
      const routine = withRateLimit(raw, limiter, {
        // The venue, so the gate spends THIS exchange's cost model. Read from
        // the same stored `config.exchange` that chose the client above, so the
        // table charged and the client charged for cannot name different
        // exchanges. Before this was passed, the gate defaulted to Binance's
        // weights for every bot, including bots trading on Gemini.
        exchange: this.#venue(config),
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
  // Price feed (step 14 D): subscribe on entering `running`, unsubscribe on
  // leaving it. The registry is idempotent (C2), so no extra guard is needed
  // here against a redelivered transition.
  // -------------------------------------------------------------------------

  /** The `PriceFeed` port for a market, injected or from the binding. */
  #feed(exchange: string, pair: string): PriceFeedPort {
    if (this.#dependencies === undefined) this.attach({});
    const deps = this.#dependencies!;
    return (deps.feedFor ?? ((ex, pr) => this.#feedFromEnv(ex, pr)))(exchange, pair);
  }

  #feedFromEnv(exchange: string, pair: string): PriceFeedPort {
    const namespace = this.env.PRICE_FEED;
    if (namespace === undefined) {
      throw new BotInstanceError(
        "not_attached",
        "no PRICE_FEED binding in this environment, so a bot cannot subscribe to " +
          "its price feed. Only testnet and production declare one; a deploy with " +
          "no --env has neither.",
      );
    }
    return namespace.get(namespace.idFromName(`${exchange}:${pair}`));
  }

  /**
   * Subscribe this bot to its market's feed. FAIL-CLOSED: a bot must not enter
   * `running` without a confirmed subscription, so this is awaited BEFORE the
   * status flip in `start`/`resume` and any failure propagates — the bot stays
   * where it was and the operator retries. Safe, because a bot that does not
   * start takes no action and holds no position.
   */
  async #subscribeToFeed(config: BotConfigBase): Promise<void> {
    if (!isExchangeId(config.exchange)) {
      // A corrupt exchange the account registry prevents in practice (step 11).
      // Do NOT subscribe to a nonsense feed and do NOT block the transition here:
      // the existing exchange-resolution guard (step 13) is the single place that
      // halts such a bot, at its first trade. For every real bot the exchange is
      // valid and this always subscribes.
      return;
    }
    const feedConfig: PriceFeedConfig = { exchange: config.exchange, pair: config.pair };
    await this.#feed(config.exchange, config.pair).subscribe(config.botInstanceId, feedConfig);
  }

  /**
   * Unsubscribe this bot from its market's feed. BEST-EFFORT: leaving `running`
   * is a safety action (halt/close) that must never be blocked by a feed-registry
   * hiccup, and a stale subscriber is harmless — the feed's fan-out gets an
   * `"ignored"` from a non-running bot, and section 9 reconciliation sees the
   * drift. A failure is alerted, never thrown.
   */
  async #unsubscribeFromFeed(config: BotConfigBase): Promise<void> {
    try {
      await this.#feed(config.exchange, config.pair).unsubscribe(config.botInstanceId);
    } catch (error) {
      // THE REPORT GETS ITS OWN GUARD, and the reason is the whole point of the
      // method. This alert is a D1 INSERT, and D1 is exactly the dependency
      // most likely to be down at the moment a feed RPC has just failed -- a
      // storage timeout takes both. Without this catch the reporting failure
      // propagates out of a method whose contract is "never throws", and the
      // caller loses every cleanup step after it: the halt's audit row, its
      // status mirror, its cancellations. That is a strictly worse outcome
      // than an unreported stale subscriber, which reconciliation sees anyway.
      //
      // `console.error` rather than a second alert, because the thing that just
      // failed IS the alert path. There is nowhere left to write to.
      try {
        await this.#alert(config, {
          severity: "warning",
          category: "system",
          alertType: "price_feed_unsubscribe_failed",
          message:
            `could not unsubscribe bot ${config.botInstanceId} from its price feed ` +
            `(${config.exchange}:${config.pair}): ${(error as Error).message}. The bot ` +
            `has still left running; the stale subscriber is harmless and reconciliation-visible.`,
        });
      } catch (alertError) {
        console.error(
          `bot ${config.botInstanceId}: price-feed unsubscribe failed ` +
            `(${(error as Error).message}), AND the alert reporting it failed ` +
            `(${(alertError as Error).message}). Both are lost to D1; the bot has ` +
            `still left running.`,
        );
      }
    }
  }

  /**
   * Run one CLEANUP step so that its failure cannot cancel the steps after it.
   *
   * WHAT THIS IS FOR, from the incident that produced it. A stop-loss halt on
   * `bot-xs0ufw` wrote `status = 'halted'` and its `halt_reason` correctly and
   * then threw somewhere in the run of bare `await`s that followed, which left
   * that bot marked halted while a sell order stayed live on the exchange, no
   * `bot.halted` audit row was ever written, and the object stayed subscribed
   * to its `PriceFeed`. Every one of those steps is INDEPENDENT of the others
   * -- cancelling orders does not need the audit row, unsubscribing does not
   * need the mirror -- so sequencing them as bare `await`s made the first
   * failure decide how much of the halt happened, which is not a decision any
   * of them is entitled to make.
   *
   * THE DIVIDING LINE, and it is not "wrap everything". A step belongs here
   * only if the transition is already COMMITTED and correct without it. The
   * durable status write is therefore NOT wrapped on either path: on the halt
   * it is the ordering guarantee the `#halt` header argues for, and on the
   * close `releaseBotCapital` owns the point of no return. A bot that cannot
   * record that it halted must fail loudly rather than proceed to tidy up
   * after a halt that is not recorded anywhere.
   *
   * Returns the step's name when it failed and `undefined` when it did not, so
   * the caller can report WHICH steps were skipped in its `PipelineResult`
   * rather than reporting an unqualified success. The alert is best-effort in
   * the same nested way `#unsubscribeFromFeed`'s is, and for the same reason:
   * this is called on paths where D1 itself is a plausible culprit, and a
   * reporting failure here would re-create precisely the bug being fixed.
   */
  async #cleanupStep(
    config: BotConfigBase,
    step: string,
    run: () => Promise<void>,
  ): Promise<string | undefined> {
    try {
      await run();
      return undefined;
    } catch (error) {
      const message = (error as Error).message;
      try {
        await this.#alert(config, {
          severity: "critical",
          category: "system",
          alertType: "cleanup_step_failed",
          message:
            `the ${step} step of a halt or close on bot ${config.botInstanceId} failed: ` +
            `${message}. The transition itself stands and the remaining cleanup steps ` +
            `still ran; this step did not, and nothing retries it automatically.`,
        });
      } catch (alertError) {
        console.error(
          `bot ${config.botInstanceId}: cleanup step ${JSON.stringify(step)} failed ` +
            `(${message}), AND the alert reporting it failed ` +
            `(${(alertError as Error).message}).`,
        );
      }
      return step;
    }
  }

  /**
   * The `detail` a halt or close reports when some of its cleanup did not run.
   *
   * `undefined` when every step succeeded, so the ordinary result is unchanged
   * and no existing assertion on it moves. When something failed the caller
   * still reports the transition as having HAPPENED -- it did -- but says so
   * with the failed steps named, which is the difference between a caller that
   * knows cleanup was partial and one that has to infer it from the alerts.
   */
  #cleanupDetail(failed: readonly (string | undefined)[]): string | undefined {
    const steps = failed.filter((step): step is string => step !== undefined);
    if (steps.length === 0) return undefined;
    return `cleanup incomplete: ${steps.join(", ")} failed`;
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
    // SPEC 22.4 TOUCHPOINT 8. Binary until now, with "not grid" meaning DCA --
    // which would have validated a trailing-stop config against DCA's schema
    // version. No compile error was possible: `schemaVersion` is a `number` on
    // every strategy's config, so both arms type-check for all three.
    if (config.strategy === "grid") {
      assertReadableGridSchema(config.schemaVersion);
    } else if (config.strategy === "trailing_stop") {
      assertReadableTrailingStopSchema(config.schemaVersion);
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

  /**
   * Write this object's state, and keep the alarm consistent with it.
   *
   * The alarm is reconciled HERE rather than at each lifecycle method because
   * this is the single point every `openOrderIds` mutation already passes
   * through. See `#syncAlarm`.
   */
  async #putState(state: BotRuntimeState): Promise<void> {
    await this.ctx.storage.put(STATE_KEY, state);
    await this.#syncAlarm(state);
  }

  /**
   * Read this object's state and write a function of it, as one step.
   *
   * THE SINGLE-WRITER DISCIPLINE (step 21). Every write that spans an exchange
   * call, a D1 write, or a feed RPC must go through here rather than through
   * `#putState` with a snapshot taken before that await, because step 21's
   * section 0 probe MEASURED that this object is re-entered across exactly
   * those awaits: an `onPriceUpdate` RPC and a scheduled `alarm` were both
   * delivered while a poll sat parked inside an exchange read, with two
   * `getOrderStatus` calls outstanding at once.
   *
   * So `{ ...snapshotTakenEarlier, oneField: newValue }` is not a field update.
   * It is a whole-state overwrite that silently reverts every OTHER field a
   * concurrent pass wrote in the meantime -- a position, a ladder, an
   * `openOrderIds` entry, or a `status`. That last one is the worst of them: a
   * poll holding a pre-halt snapshot can write `running` back over a bot that
   * was halted while it was reading, or `close()`'s `stopped` can be undone by
   * a pass that started before it.
   *
   * `mutate` receives state read HERE, after the await rather than before it,
   * and must express its change as a delta on that value. It runs synchronously
   * and must stay pure: an await inside it would reopen the very window this
   * closes. Everything between this read and the write is storage-only, which
   * the same probe found to be atomic in practice (a two-pass race on one
   * `fillId` applied it exactly once, with the identity check isolated as the
   * only guard). That result is weak evidence rather than a guarantee, which is
   * why this re-reads regardless: it costs one storage read and is correct
   * under either model.
   */
  async #mutateState(
    mutate: (current: BotRuntimeState) => BotRuntimeState,
  ): Promise<BotRuntimeState> {
    const next = mutate(await this.#state());
    await this.#putState(next);
    return next;
  }

  /**
   * The same discipline for the poll's schedule, which has the same exposure.
   *
   * `#recordPollFailure` reads the schedule, raises a standing alert -- a D1
   * write, and therefore a re-entry point -- and only then writes back. Without
   * this, that write reverts any `nextPollAt` or cleared failure count a
   * concurrent pass set while the alert was in flight.
   */
  async #mutatePollSchedule(
    mutate: (current: PollSchedule) => PollSchedule,
  ): Promise<PollSchedule> {
    const next = mutate(await this.#pollSchedule());
    await this.#putPollSchedule(next);
    return next;
  }

  /**
   * Take the next order sequence, and advance it, in one step.
   *
   * The sequence IS the `clientOrderId` (`IdempotencyGuard.clientOrderIdFor`),
   * so two passes reading the same value mint the same id for two different
   * orders. Read-then-write on a snapshot allowed exactly that: the poll
   * placing a grid replacement while a price tick placed a rung would take the
   * same number twice.
   *
   * `beginAttempt` already caught it -- the second caller finds the attempt
   * recorded and answers `recover` rather than sending -- and step 21's probe
   * measured that defence to be sufficient, which is why it is untouched. But
   * being caught by the idempotency guard means the second order is SKIPPED,
   * not placed, so a rung silently goes missing and only reappears on the next
   * price update. Allocating atomically means the collision does not happen in
   * the first place, and `beginAttempt` stays the backstop it was built to be.
   *
   * Persisted BEFORE the attempt is recorded, as before: a crash here burns a
   * sequence number, which costs nothing, while the reverse ordering would let
   * a crash re-use a sequence whose attempt already existed.
   */
  /**
   * Run one non-poll pass, counted so the poll can see it is in flight.
   *
   * THE POLL IS THE DESIGNATED LOSER (step 21), and the asymmetry that makes
   * this the right shape is a property step 19 established rather than a
   * general principle: everything the poll does is RE-DERIVABLE. It invents
   * nothing, it dedupes on the exchange's own `fillId`, and abandoning a pass
   * costs thirty seconds and a re-read. Nothing else in this object has that
   * property -- a price tick that skipped its stop-loss check has simply not
   * checked it.
   *
   * So the rule is one-way. Every writer here proceeds exactly as before and is
   * never delayed by the poll; the poll yields to all of them. A symmetric lock
   * would have reintroduced, at the scheduling layer, precisely the
   * head-of-line blocking that section 5.4's reserved rate-limit slice exists
   * to prevent -- a stop-loss queued behind a routine status read is the one
   * outcome this system is built to avoid.
   *
   * IN MEMORY, DELIBERATELY. A Durable Object's alarm and its RPCs run in the
   * same instance, so a counter on the instance sees them all; and if the
   * object is evicted, the in-flight pass is gone with it, so there is nothing
   * to persist. It is a `finally` rather than a `try`/`catch` because a pass
   * that threw is still a pass that finished.
   *
   * Poll-vs-poll is NOT covered, and that is deliberate: step 21's section 0
   * probe raced two passes onto the same `fillId` and exactly one applied it,
   * so the idempotency already holds there. What it would cost is a duplicate
   * read, not a duplicate fill.
   */
  async #outsidePoll<T>(body: () => Promise<T>): Promise<T> {
    this.#passesInFlight += 1;
    try {
      return await body();
    } finally {
      this.#passesInFlight -= 1;
    }
  }

  /**
   * The status this object holds right now, if it is no longer what a decision
   * assumed. `null` means the decision still stands.
   *
   * THE POINT OF NO RETURN (step 21). A placement is decided from state read
   * before `#ensureFilters`, `beginAttempt` and the validation pass, and at
   * least one of those reaches the network -- so by the time the order is about
   * to be SENT, the status it was decided under may be several awaits old.
   * Step 21's section 0 probe measured that window to be genuinely re-entrant:
   * an RPC and an alarm were both delivered while this object sat inside an
   * exchange call.
   *
   * `#mutateState` cannot help here. That fixes writes that revert each other;
   * this is a decision taken against state that has since changed, and once the
   * order is on the exchange no amount of careful writing takes it back. The
   * only defence is to look again immediately before sending.
   *
   * This is what makes step 19's `placeReplacement: fresh.status === "running"`
   * mean what it says. That gate reads the status and then crosses two D1
   * writes (`#mirrorOrderUpdate`, `#mirrorTrade`) and a possible filter refresh
   * before `#placeGridOrder` sends -- so a halt landing in that window left the
   * derived-not-hardcoded gate deciding on a status that was no longer true,
   * and a halted bot put a live order on the exchange anyway. Steps 18 and 19
   * both worked hard for that invariant; this is the check that actually holds
   * it.
   *
   * Cancellation is deliberately NOT gated this way: cancelling an order is
   * safe under every status, and refusing to cancel because the bot changed
   * state is how orders get left live on the exchange.
   */
  async #statusChangedFrom(expected: BotStatus): Promise<BotStatus | null> {
    const current = (await this.#state()).status;
    return current === expected ? null : current;
  }

  async #allocateSequence(): Promise<number> {
    const advanced = await this.#mutateState((current) => ({
      ...current,
      nextSequence: current.nextSequence + 1,
    }));
    return advanced.nextSequence - 1;
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

  /**
   * Create a trailing-stop bot (spec section 22).
   *
   * Structurally `create()`, not `createGrid()`: 22.2 decision 4 gives this the
   * same single-position shape as DCA, so there is NO ladder to seed. The two
   * grid-specific steps are deliberately absent -- `emptyLadder(params)` in the
   * state, and grid's `takeProfitPct: null` reasoning, which here has a different
   * cause (see below).
   */
  async createTrailingStop(
    request: CreateTrailingStopBotRequest,
  ): Promise<{ botInstanceId: string; status: BotStatus }> {
    if ((await this.ctx.storage.get(CONFIG_KEY)) !== undefined) {
      throw new BotInstanceError(
        "already_created",
        `bot instance ${JSON.stringify(request.botInstanceId)} already has a configuration`,
      );
    }

    const db = this.#db();
    const now = this.#now();

    // Both latches, global first, exactly as the other two creation paths do.
    await assertGlobalArmed(db, `create bot ${request.botInstanceId}`);
    await assertAccountArmed(db, request.accountLabel, `create bot ${request.botInstanceId}`);

    // THE SAME VALIDATOR `POST /api/bots` RUNS, not a copy (21.5 requirement 3).
    // Reached again here because this object is callable by RPC and must not
    // depend on its caller having checked -- the same reason `create()` re-runs
    // `validateDcaParams`.
    validateTrailingStopParams(request.params, request.allocatedCapital);

    await createBotInstanceWithCapital(
      db,
      {
        id: request.botInstanceId,
        accountLabel: request.accountLabel,
        asset: request.capitalAsset,
        exchange: request.exchange,
        pair: request.pair,
        strategyType: "trailing_stop",
        strategyParams: encodeTrailingStopParams(request.params),
        // ⚠ THE TRAIL IS THE STOP-LOSS (22.4 touchpoint 9), so the column and
        // `params.trailPct` are ONE quantity with two homes. Written from
        // `trailPct` here and nowhere else, so the authoritative copy is the
        // params and the column is its mirror -- which is the decision migration
        // 0010's header left to this touchpoint. `stop_loss_pct` is NOT NULL and
        // CHECK > 0 for every strategy (section 6.1); the validator has already
        // guaranteed `trailPct` is positive, so this cannot violate it.
        stopLossPct: request.params.trailPct,
        // NULL, and for a different reason than grid's. Grid's take-profit is
        // optional; this strategy has none at all -- 22.1's whole point is that
        // gains are locked in progressively "without a fixed profit target
        // having to be guessed in advance". The `dca_requires_take_profit` CHECK
        // constrains only DCA, so NULL is accepted here (migration 0010).
        takeProfitPct: null,
        requestedCapital: request.allocatedCapital,
      },
      { actor: request.actor, now },
    );

    const config: TrailingStopConfig = {
      strategy: "trailing_stop",
      schemaVersion: TRAILING_STOP_SCHEMA_VERSION,
      botInstanceId: request.botInstanceId,
      accountLabel: request.accountLabel,
      exchange: request.exchange,
      pair: request.pair,
      capitalAsset: request.capitalAsset,
      allocatedCapital: request.allocatedCapital,
      params: request.params,
    };

    const state: BotRuntimeState = {
      schemaVersion: TRAILING_STOP_SCHEMA_VERSION,
      status: "created",
      // ⚠ REQUIRED BY `BotRuntimeState` AND NEVER INCREMENTED. This strategy has
      // exactly one cycle by construction, so the counter has no referent -- but
      // the field is not optional, and making it optional would be a state-shape
      // change affecting every existing DCA and grid bot for no gain. It is set
      // to 0 and left there; `#completeTrailingStopExit` deliberately does not
      // touch it (22.9).
      cycleCount: 0,
      position: EMPTY_POSITION,
      // NO `ladder` -- that is the grid-specific step this path excludes.
      nextSequence: 0,
      openOrderIds: [],
      haltReason: null,
      haltedAt: null,
      lastPrice: null,
      lastPriceAt: null,
      // `highWaterMark` is DELIBERATELY ABSENT rather than set to null. It is an
      // optional field (22.2 decision 3), and absent is what "no high recorded
      // yet" means everywhere else that reads it -- `raisesHighWaterMark` takes
      // `undefined` as "take the first price", and `decide`'s `max(entry, mark)`
      // needs no special case for it.
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
    return await this.#outsidePoll(() => this.#startPass(actor));
  }

  async #startPass(actor: string): Promise<PipelineResult> {
    const config = await this.#config();
    const state = await this.#state();
    if (state.status !== "created") {
      throw new BotInstanceError(
        "invalid_status",
        `cannot start a bot whose status is ${JSON.stringify(state.status)}; ` +
          `only a newly created bot can be started (a halted one is resumed)`,
      );
    }

    // Fail-closed: subscribe to the price feed BEFORE flipping to running. If the
    // feed is unreachable the bot does not start (nothing has changed yet), rather
    // than entering running with no price connection.
    await this.#subscribeToFeed(config);

    const now = this.#now();
    await this.#mutateState((current) => ({ ...current, status: "running" }));
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
    return await this.#outsidePoll(() => this.#onPriceUpdatePass(price));
  }

  async #onPriceUpdatePass(price: Price): Promise<PipelineResult> {
    const config = await this.#config();
    let state = await this.#state();

    if (state.status !== "running") {
      return { status: state.status, action: "ignored", detail: `status is ${state.status}` };
    }

    state = await this.#mutateState((current) => {
      const next: BotRuntimeState = {
        ...current,
        lastPrice: price.price,
        lastPriceAt: price.at,
      };
      // SPEC 22.2 DECISION 3. The trail's high-water mark ratchets UP and never
      // down, and it is updated HERE -- on the same write that records the price
      // -- because a mark updated anywhere else could miss a candle that the
      // price record saw, which is exactly the silent-in-both-directions failure
      // 22.3 is about.
      //
      // Strategy-gated the same way the dispatch below is (`config.strategy ===
      // "grid"`), not by a new mechanism. DCA and grid never take this branch, so
      // the key is never added to their state at all.
      if (raisesHighWaterMark(config.strategy, current.highWaterMark, price.price)) {
        return { ...next, highWaterMark: price.price };
      }
      return next;
    });

    try {
      if (config.strategy === "grid") {
        return await this.#gridOnPrice(config, price);
      }
      // SPEC 22.4 TOUCHPOINT 10. Its own branch, NOT the DCA fallback: before
      // this, "not grid" meant DCA, and a trailing-stop bot would have run DCA's
      // decision function against DCA's parameters on every candle.
      if (config.strategy === "trailing_stop") {
        return await this.#trailingStopOnPrice(config, state, price);
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
    return await this.#outsidePoll(() => this.#onFillPass(clientOrderId, fill));
  }

  async #onFillPass(clientOrderId: string, fill: Fill): Promise<PipelineResult> {
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
        return await this.#applyGridFillToOrder(config, state, order, fill, true);
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
   * Record fills the exchange already executed but this bot never saw.
   *
   * THE REPAIR PATH, and it exists because of a real incident: on 2026-07-31
   * two Gemini parsing bugs (step 17) meant reconciliation could not read order
   * status at all, so three orders filled on the exchange while this system went
   * on believing them `pending`. Section 9 deliberately never auto-corrects
   * order-state drift -- it halts and alerts and waits for a human -- so this is
   * that human's action, and nothing else calls it. No cron reaches it.
   *
   * WHAT IT REUSES, and why that mattered more than convenience. Every number it
   * writes comes from the SAME `applyFill` / `applyEntry` / `planFill` chain that
   * a live fill goes through, so a repaired position cannot disagree with a
   * normally-recorded one. It invents nothing.
   *
   * In particular it does NOT synthesise fill ids. `#recordCancellation`'s
   * docblock explains why that would be corrupting: `applyFill` deduplicates on
   * `fillId`, so a made-up id means the real fill either double-counts or is
   * silently swallowed. The ids here are Gemini's own `tid` values, read back via
   * `getOrderStatus`, which already asks for `include_trades` precisely so the
   * per-fill detail is available. That also makes this operation IDEMPOTENT for
   * free: a second run finds every id already applied and does nothing.
   *
   * TWO SAFETY PROPERTIES, both deliberate:
   *
   *   1. It refuses unless the bot is HALTED. Repairing the books under a bot
   *      that is actively trading would race its own pipeline.
   *   2. It never places an order. A grid fill normally places the paired sell
   *      (`#applyGridFillToOrder`), and doing that here would put live orders on
   *      the exchange from a halted bot -- resuming trading through the back
   *      door. `placeReplacement: false` suppresses exactly that and nothing
   *      else. This is clean rather than a fudge: `planFill` clears the FILLED
   *      level's slot itself and returns the replacement as a separate intent, so
   *      skipping placement leaves no phantom order -- the ladder honestly shows
   *      the acquired base, its cost, and an empty rung.
   *
   * It also never changes status. The bot is halted when this starts and halted
   * when it finishes; resuming stays a separate, explicit decision.
   *
   * A failed read is skipped and reported, never guessed at (section 5.6).
   */
  async applyMissedFills(actor: string): Promise<MissedFillsResult> {
    return await this.#outsidePoll(() => this.#applyMissedFillsPass(actor));
  }

  async #applyMissedFillsPass(actor: string): Promise<MissedFillsResult> {
    const config = await this.#config();
    const state = await this.#state();

    if (state.status !== "halted") {
      throw new BotInstanceError(
        "invalid_status",
        `missed fills can only be applied to a halted bot; this one is ` +
          `${JSON.stringify(state.status)}. Halt it first, or let reconciliation ` +
          `halt it, so the books are not repaired underneath a live pipeline.`,
      );
    }

    const applied: AppliedFill[] = [];
    const skipped: string[] = [];
    // ROUTINE: this is a read-driven repair on a stopped bot, not a risk exit.
    const exchange = this.#exchange(config, "routine");

    for (const clientOrderId of [...state.openOrderIds]) {
      const outcome = await exchange.getOrderStatus(config.pair, clientOrderId);
      if (!isUsable(outcome)) {
        skipped.push(`${clientOrderId}: ${outcome.kind} ${outcome.message}`);
        continue;
      }

      const remote = outcome.value;
      if (remote.fills === undefined) {
        // No `trades` in the response at all. That is NOT the same as "no
        // executions" -- it means the detail was not reported -- so it is
        // reported as unread rather than treated as nothing to do.
        skipped.push(
          `${clientOrderId}: the exchange reported no per-fill detail, so there ` +
            `is nothing with a real fill id to apply. Filled quantity is ` +
            `${toDecimalString(remote.filledQuantity)}.`,
        );
        continue;
      }

      for (const fill of remote.fills) {
        // Re-read each time: the previous fill mutated this order.
        const order = await this.#order(clientOrderId);
        if (order === undefined) {
          skipped.push(`${clientOrderId}: no local record of this order`);
          break;
        }
        if (order.fills.some((existing) => existing.fillId === fill.fillId)) {
          continue; // Already recorded. The idempotency this relies on.
        }

        const fresh = await this.#state();
        try {
          if (config.strategy === "grid") {
            await this.#applyGridFillToOrder(config, fresh, order, fill, false);
          } else {
            await this.#applyFillToOrder(config, fresh, order, fill);
          }
          applied.push({
            clientOrderId,
            fillId: fill.fillId,
            quantity: toDecimalString(fill.quantity),
            price: toDecimalString(fill.price),
          });
        } catch (error) {
          // An `OrderStateError` here (overfill, terminal order) means the local
          // record and the exchange genuinely disagree in a way this repair must
          // not paper over. Report it; do not halt (already halted) and do not
          // continue guessing at this order.
          skipped.push(
            `${clientOrderId} fill ${fill.fillId}: ` +
              `${error instanceof Error ? error.message : String(error)}`,
          );
          break;
        }
      }
    }

    await this.#audit(
      config,
      "bot.missed_fills_applied",
      actor,
      { applied, skipped },
      this.#now(),
    );

    return { status: (await this.#state()).status, applied, skipped };
  }

  // -------------------------------------------------------------------------
  // Position repair (fix 3): rebuild the live cycle's position from its orders
  // -------------------------------------------------------------------------

  /**
   * Recompute this DCA bot's position from its own order history, and -- only
   * on an explicit `commit` -- write it back.
   *
   * THE GAP THIS CLOSES, and it is the only one in the chain that looks
   * BACKWARDS. `applyEntry` has no inverse: within a cycle `quantity` and `cost`
   * only ever grow, and both are zeroed together by `#completeCycle` /
   * `#completeLiquidation`. So an exit sell that fills PARTIALLY and is then
   * cancelled leaves a position the model has no way to express -- the sold base
   * is still counted as held. Two live bots sat in exactly that state, one of
   * them believing it held 3.7x what it actually did, with its stop-loss and
   * take-profit both computed from the inflated number. Nothing automated was
   * ever going to revisit them: `ALLOWED_TRANSITIONS` gives every terminal state
   * an empty successor list, so `applyFill` refuses the order forever, and
   * `applyMissedFills` iterates `openOrderIds`, which a cancelled order has left.
   *
   * REPORT MODE IS THE DEFAULT, and that is a deliberate inversion of the usual
   * shape. This is the only operation in the system that OVERWRITES a position
   * rather than deriving one forward, and every neighbouring path here reports
   * rather than acts: `checkOpenOrders` hands back `applied`/`skipped`/`closed`,
   * `applyMissedFills` refuses to synthesise a fill id and reports the gap, and
   * section 9 halts and alerts and never auto-corrects. `commit: false` computes
   * everything, writes nothing, and returns the full before/after diff plus the
   * per-order evidence -- so the number can be read before it is trusted.
   *
   * THE COST MODEL IS PROPORTIONAL, and it is a decision rather than a
   * derivation, because the model has no defined meaning for a partially exited
   * position. `cost` serves four masters at once: capital headroom
   * (`allocatedCapital - position.cost`), `averageEntryPrice` and therefore BOTH
   * risk thresholds, realized PnL at cycle close, and the dashboard's unrealized
   * PnL. Leaving `cost` at the full buy notional while reducing `quantity` would
   * inflate `averageEntryPrice` by the inverse of the fraction still held -- 3.7x
   * on the bot that prompted this -- and move the stop-loss and take-profit with
   * it. So `cost` is scaled by the fraction still held, which holds
   * `averageEntryPrice` steady (the coin still held WAS bought at that average)
   * and restores headroom in proportion to what was sold. That is the continuous
   * form of a rule this system already applies discretely: a completed cycle
   * zeroes `cost` and restores the whole allocation.
   *
   * AND THE SOLD LEG'S PnL IS BOOKED IN THE SAME WRITE, because scaling `cost`
   * down without it would simply lose that leg: `realizedGross` is written only
   * by the two cycle-completion paths, and neither ran. It is computed from the
   * REAL fill notionals -- `sum(mul(fill.price, fill.quantity))` -- rather than
   * from `filledQuantity x order.price`, which is what `#completeCycle` uses. The
   * difference is deliberate and is an improvement on that path, not a drift from
   * it: the per-fill detail is right here in `order.fills`, and a limit price is
   * only an approximation of what the fills actually executed at.
   *
   * `additionalBuysUsed` IS CARRIED THROUGH UNTOUCHED. It counts entries taken
   * while `position.quantity > ZERO` -- a runtime observation at the moment of
   * each fill, not a property of any order -- so replaying it from history is
   * faithful only if every buy fill is present, which is precisely what this
   * repair cannot assume. Preserving the stored value keeps the bot's remaining
   * buy budget exactly as it was; recomputing it could silently hand back budget
   * that was already spent.
   *
   * TEN GATES, IN ORDER, AND IT REFUSES WHOLE. There is no partial apply: every
   * check runs before the single write, and the first failure returns a report
   * naming the gate and every reason behind it. This is fix 1's shape --
   * gate-before-write -- applied to a much larger write.
   */
  async repairPosition(
    actor: string,
    options: { commit: boolean } = { commit: false },
  ): Promise<PositionRepairReport> {
    return await this.#outsidePoll(() =>
      this.#repairPositionPass(actor, options.commit === true),
    );
  }

  async #repairPositionPass(actor: string, commit: boolean): Promise<PositionRepairReport> {
    const config = await this.#config();
    const state = await this.#state();
    const before = repairFieldsOf(state);

    /** A refusal that carries whatever was computed before the gate fired. */
    const refuse = (
      blockedBy: string,
      reasons: readonly string[],
      partial: Partial<PositionRepairReport> = {},
    ): PositionRepairReport => ({
      outcome: "refused",
      committed: false,
      status: state.status,
      blockedBy,
      reasons,
      before,
      after: before,
      evidence: [],
      liveCycleOrderIds: [],
      closedCycleCount: 0,
      findings: [],
      ...partial,
    });

    // --- Gate 1: DCA only. -------------------------------------------------
    // Grid's position is its `ladder` -- levels, slots, `heldQuantity`,
    // `heldCost` -- and rebuilding one is a different problem with a different
    // arithmetic. Refusing is honest; guessing at it would not be.
    if (config.strategy !== "dca") {
      return refuse("gate 1: strategy", [
        `this repair rebuilds a DCA position from its entries and exits; bot ` +
          `${config.botInstanceId} is a ${config.strategy} bot, whose position is its ladder`,
      ]);
    }

    // --- Gate 2: halted only. ----------------------------------------------
    // The same rule `applyMissedFills` states: repairing the books under a live
    // pipeline races it. `onPriceUpdate`, `#onFillPass` and the poll all read
    // `position` to decide whether to place an order. A `stopped` bot has
    // released its capital and nothing may act on a repaired number.
    if (state.status !== "halted") {
      return refuse("gate 2: status", [
        `a position can only be repaired on a halted bot; this one is ` +
          `${JSON.stringify(state.status)}. Halt it first, so the books are not ` +
          `rewritten underneath a running pipeline.`,
      ]);
    }

    // --- Load the whole order history, in sequence order. -------------------
    // Nothing ever deletes an order (`storage.delete` is used only for the
    // alarm), so this is the bot's complete lifetime. `nextSequence` is set to 0
    // at creation and only ever incremented -- never reset by `#completeCycle` --
    // so the sequence inside the clientOrderId is a total order ACROSS cycles,
    // which `createdAt` (an exchange timestamp) is not.
    const stored = await this.ctx.storage.list<TrackedOrder>({ prefix: ORDER_KEY_PREFIX });
    const history: { order: TrackedOrder; sequence: number }[] = [];
    const unparseable: string[] = [];
    for (const order of stored.values()) {
      const parsed = parseClientOrderId(order.clientOrderId);
      if (parsed === null) {
        unparseable.push(order.clientOrderId);
        continue;
      }
      history.push({ order, sequence: parsed.sequence });
    }
    history.sort((a, b) => a.sequence - b.sequence);

    // --- Partition into cycles. --------------------------------------------
    // A cycle ends at a fully-filled SELL, and that marker is trustworthy rather
    // than a heuristic: `position: EMPTY_POSITION` is written at runtime by
    // exactly `#completeCycle` and `#completeLiquidation`, both reached only from
    // `#applyFillToOrder`'s `isExit && effect.fullyFilled`, which is exactly the
    // transition to `filled`. And `filled` cannot be asserted over an order from
    // outside: `closeOrder` accepts only cancelled/rejected/expired, and
    // `#foldTerminalState` says in as many words that "an order is recorded as
    // filled by applying its fills, never by asserting the end state over them".
    // So a sell in `filled` means fills summing to its full quantity really were
    // applied, which means the position really was zeroed.
    const closeIndices: number[] = [];
    for (let i = 0; i < history.length; i++) {
      const order = history[i]!.order;
      if (order.side === "sell" && order.state === "filled") closeIndices.push(i);
    }
    const closedCycleCount = closeIndices.length;
    const liveFrom = closedCycleCount === 0 ? 0 : closeIndices[closedCycleCount - 1]! + 1;
    const live = history.slice(liveFrom);
    const liveCycleOrderIds = live.map((entry) => entry.order.clientOrderId);

    // Buy FILLS per closed cycle, for gate 7. Counted per fill rather than per
    // order because that is what `#completeCycle` audited: `entries` is
    // `position.entries.length`, and `entries` gains one element per applied buy
    // fill, not one per order.
    const closedBuyFillCounts: number[] = [];
    const closedDust: string[] = [];
    let sliceStart = 0;
    for (const end of closeIndices) {
      let fills = 0;
      let bought = ZERO;
      let soldInCycle = ZERO;
      for (let i = sliceStart; i <= end; i++) {
        const order = history[i]!.order;
        for (const fill of order.fills) {
          if (order.side === "buy") {
            fills += 1;
            bought += fill.quantity;
          } else {
            soldInCycle += fill.quantity;
          }
        }
      }
      closedBuyFillCounts.push(fills);
      if (bought > soldInCycle) closedDust.push(toDecimalString(bought - soldInCycle));
      sliceStart = end + 1;
    }

    // NOT a gate, and deliberately NOT folded into anything below. A completed
    // cycle can leave real base behind: `#placeTakeProfitSell` sizes the exit
    // from `position.quantity` through `validateOrder`, whose quantity "rounds
    // DOWN unconditionally, on either side", and `#completeCycle` then zeroes the
    // position regardless. That residue is a separate defect with its own
    // accounting, and absorbing it into THIS cycle's position would be inventing
    // base this cycle never bought. Reported so it is visible, and left alone.
    const findings: string[] = [];
    if (closedDust.length > 0) {
      findings.push(
        `${closedDust.length} completed cycle(s) left base unmodelled by the step-size ` +
          `rounding on their exit sells (${closedDust.join(", ")}). This is a SEPARATE ` +
          `defect, is not part of the live cycle, and is deliberately not folded into the ` +
          `numbers below. Gate 7 compares fill COUNTS, which this does not shift.`,
      );
    }

    // --- Read every live-cycle order back from the exchange. ---------------
    // ROUTINE priority: this is bookkeeping, and section 5.4's reserved slice is
    // for getting OUT of positions. The reads exist because the arithmetic below
    // is a subtraction over local records, and local records are exactly what
    // this chain of bugs corrupts -- a repair that trusted them could only
    // reproduce the drift it was built to remove, while looking authoritative.
    const exchange = this.#exchange(config, "routine");
    const evidence: PositionRepairEvidence[] = [];
    const unreadable: string[] = [];
    const disagreements: string[] = [];
    const unsettled: string[] = [];

    for (const { order, sequence } of live) {
      const outcome = await exchange.getOrderStatus(config.pair, order.clientOrderId);
      const remote = isUsable(outcome) ? outcome.value : null;
      const agrees = remote === null ? null : remote.filledQuantity === order.filledQuantity;

      evidence.push({
        clientOrderId: order.clientOrderId,
        sequence,
        side: order.side,
        state: order.state,
        localFilledQuantity: toDecimalString(order.filledQuantity),
        remoteFilledQuantity: remote === null ? null : toDecimalString(remote.filledQuantity),
        agrees,
      });

      if (remote === null) {
        unreadable.push(
          `${order.clientOrderId}: ${isUsable(outcome) ? "usable" : `${outcome.kind} ${outcome.message}`}`,
        );
      } else if (!agrees) {
        disagreements.push(
          `${order.clientOrderId}: the exchange reports ` +
            `${toDecimalString(remote.filledQuantity)} filled, this bot recorded ` +
            `${toDecimalString(order.filledQuantity)}`,
        );
      }

      // Gate 3's condition, gathered here because it needs the same read. An
      // order still open on the exchange may fill again at any moment, and a
      // position rebuilt underneath it is stale before it is written.
      if (!isTerminal(order.state) && (remote === null || agrees !== true)) {
        unsettled.push(
          `${order.clientOrderId} is ${order.state} (not terminal) and ` +
            (remote === null
              ? `could not be read back, so whether it has settled is unknown`
              : `the exchange reports ${toDecimalString(remote.filledQuantity)} against ` +
                `${toDecimalString(order.filledQuantity)} recorded, so it has not settled`),
        );
      }
    }

    const carry = { evidence, liveCycleOrderIds, closedCycleCount, findings };

    // --- Gate 3: nothing in the live cycle is still moving. ----------------
    if (unsettled.length > 0) return refuse("gate 3: unsettled orders", unsettled, carry);

    // --- Gate 4: the exchange answered for every one of them. --------------
    // Section 5.6: an unreachable exchange is not data. This is also where a
    // venue that no longer serves status for a long-cancelled order lands -- the
    // repair refuses rather than falling back to local-only arithmetic.
    if (unreadable.length > 0) return refuse("gate 4: unreadable orders", unreadable, carry);

    // --- Gate 5: local and remote agree, exactly. --------------------------
    // A disagreement means there IS an unrecorded execution, and this is not the
    // tool for it: applying a fill needs the exchange's own fill id, which
    // `checkOpenOrders` and `applyMissedFills` obtain and this repair does not.
    if (disagreements.length > 0) {
      return refuse("gate 5: local/remote fill disagreement", disagreements, carry);
    }

    // --- Gate 6: the partition is derivable and consistent with cycleCount. -
    if (unparseable.length > 0) {
      return refuse(
        "gate 6: partition sanity",
        [
          `${unparseable.length} order(s) do not parse as this system's clientOrderId ` +
            `scheme (${unparseable.join(", ")}), so the cycles cannot be ordered`,
        ],
        carry,
      );
    }
    if (closedCycleCount < state.cycleCount) {
      return refuse(
        "gate 6: partition sanity",
        [
          `the order history shows ${closedCycleCount} fully-filled sell(s) but this bot ` +
            `records ${state.cycleCount} completed cycle(s). Every completed cycle ends in a ` +
            `fully-filled exit, so fewer of those than cycles means the history is incomplete ` +
            `and the live cycle cannot be identified.`,
        ],
        carry,
      );
    }

    // --- Gate 7: the partition agrees with what the cycles audited. --------
    // An independent source, in D1 rather than in this object. `#completeCycle`
    // records `entries` (that cycle's buy-fill count) and `#completeLiquidation`
    // records a liquidation; each fully-filled sell produced exactly one of the
    // two, in time order, so the i-th closed cycle lines up with the i-th row.
    // A liquidation row carries no entry count, so it is aligned but not counted
    // against -- that is what can be checked, and no more.
    const cycleAudits = await this.#db().auditLog.findMany({
      where: {
        target_bot_instance_id: config.botInstanceId,
        action: { in: ["bot.cycle_completed", "bot.liquidation_filled"] },
      },
      orderBy: [{ column: "created_at", direction: "asc" }],
    });
    if (cycleAudits.length !== closedCycleCount) {
      return refuse(
        "gate 7: cycle audit cross-check",
        [
          `the order history shows ${closedCycleCount} completed cycle(s) but audit_log holds ` +
            `${cycleAudits.length} completion row(s) for this bot. The partition cannot be ` +
            `corroborated, so the live cycle's boundary is not trustworthy.`,
        ],
        carry,
      );
    }
    const auditMismatches: string[] = [];
    for (let i = 0; i < cycleAudits.length; i++) {
      const row = cycleAudits[i]!;
      if (row.action !== "bot.cycle_completed") continue;
      const recorded = (row.details_json as { entries?: unknown }).entries;
      if (typeof recorded !== "number") continue;
      const counted = closedBuyFillCounts[i] ?? -1;
      if (recorded !== counted) {
        auditMismatches.push(
          `cycle ${i + 1}: audit_log recorded ${recorded} entries, the partition counts ` +
            `${counted} buy fill(s) before its exit`,
        );
      }
    }
    if (auditMismatches.length > 0) {
      return refuse("gate 7: cycle audit cross-check", auditMismatches, carry);
    }

    // --- Compute the live cycle's position from its own fills. -------------
    // Per FILL, not per order, and with `mul(price, quantity, "half-even")` --
    // the same notional `applyFill` computes and `#applyFillToOrder` hands to
    // `applyEntry` as `cost`. So on a healthy bot this reproduces the stored
    // numbers exactly, which is what makes `no_change` meaningful.
    let bought = ZERO;
    let boughtCost = ZERO;
    let sold = ZERO;
    let soldProceeds = ZERO;
    const rebuilt: DcaEntry[] = [];

    for (const { order } of live) {
      for (const fill of order.fills) {
        const notional = mul(fill.price, fill.quantity, "half-even");
        if (order.side === "buy") {
          bought += fill.quantity;
          boughtCost += notional;
          rebuilt.push({
            clientOrderId: order.clientOrderId,
            price: fill.price,
            quantity: fill.quantity,
            cost: notional,
            at: fill.executedAt,
          });
        } else {
          sold += fill.quantity;
          soldProceeds += notional;
        }
      }
    }
    rebuilt.sort((a, b) => (a.at === b.at ? 0 : a.at < b.at ? -1 : 1));

    const quantity = bought - sold;
    // The cycle's average entry across everything it bought. Preserved by the
    // proportional model, and the basis the sold leg's PnL is measured against.
    const cycleAverageEntry =
      bought > ZERO ? divideRounded(boughtCost * ONE, bought, "half-even") : ZERO;

    // One rounding, not two: scaling by a pre-divided fraction would round the
    // fraction and then round the product.
    const cost =
      quantity > ZERO ? divideRounded(boughtCost * quantity, bought, "half-even") : ZERO;
    const averageEntryPrice =
      quantity > ZERO ? divideRounded(cost * ONE, quantity, "half-even") : ZERO;
    const lastEntryPrice =
      quantity > ZERO && rebuilt.length > 0 ? rebuilt[rebuilt.length - 1]!.price : ZERO;
    // Flat means flat: nothing is held, so nothing describes what is held.
    const entries = quantity > ZERO ? rebuilt : [];

    const soldPnl =
      sold > ZERO ? soldProceeds - mul(sold, cycleAverageEntry, "half-even") : ZERO;

    // --- Gate 8: the arithmetic produced a real position. ------------------
    if (quantity < ZERO) {
      return refuse(
        "gate 8: negative quantity",
        [
          `the live cycle's own orders sum to ${toDecimalString(quantity)} base ` +
            `(${toDecimalString(bought)} bought, ${toDecimalString(sold)} sold). A bot cannot ` +
            `hold less than nothing, so the order history is wrong rather than the position.`,
        ],
        carry,
      );
    }

    // --- Gate 9: the repaired cost fits inside the allocation. -------------
    // `#placeBuy` guards spending with `allocatedCapital - position.cost`, so a
    // repaired cost above the allocation would leave the bot's own budget
    // permanently negative.
    if (cost > config.allocatedCapital) {
      return refuse(
        "gate 9: cost exceeds allocation",
        [
          `the repaired cost ${toDecimalString(cost)} ${config.capitalAsset} exceeds this ` +
            `bot's allocation of ${toDecimalString(config.allocatedCapital)}`,
        ],
        carry,
      );
    }

    // --- Gate 10: the exit pointer is terminal AND accounted for. ----------
    // Terminal alone is NOT enough. Clearing the pointer while the sold quantity
    // is still counted as held re-arms `#placeTakeProfitSell` to sell base that
    // is already gone. The condition is that this repair's own `sold` includes it.
    if (state.exitOrderId !== null) {
      const exit = live.find((entry) => entry.order.clientOrderId === state.exitOrderId);
      if (exit === undefined) {
        return refuse(
          "gate 10: exit order",
          [
            `exitOrderId names ${state.exitOrderId}, which is not among the live cycle's ` +
              `orders, so its fills are not in the ${toDecimalString(sold)} this repair ` +
              `subtracted and clearing the pointer would drop them silently`,
          ],
          carry,
        );
      }
      if (!isTerminal(exit.order.state)) {
        return refuse(
          "gate 10: exit order",
          [
            `exitOrderId names ${state.exitOrderId}, which is still ${exit.order.state} on ` +
              `this bot's own books. A live exit may still fill; clearing it now would let a ` +
              `second exit be placed alongside it.`,
          ],
          carry,
        );
      }
    }

    // --- Every gate passed. What would change? -----------------------------
    const after: PositionRepairFields = {
      quantity: toDecimalString(quantity),
      cost: toDecimalString(cost),
      averageEntryPrice: toDecimalString(averageEntryPrice),
      lastEntryPrice: toDecimalString(lastEntryPrice),
      entryCount: entries.length,
      additionalBuysUsed: state.position.additionalBuysUsed,
      realizedGross: toDecimalString(state.realizedGross),
      exitOrderId: null,
      exitKind: null,
    };

    // THE IDEMPOTENCY HINGE. The sold leg's PnL is booked only when the position
    // is actually being reduced. After a successful commit the stored quantity
    // and cost already equal what this recomputes -- the orders did not change --
    // so a second run books nothing and `realizedGross` cannot double.
    const reducing =
      state.position.quantity !== quantity || state.position.cost !== cost;
    const realizedGross = reducing ? state.realizedGross + soldPnl : state.realizedGross;
    const withPnl: PositionRepairFields = { ...after, realizedGross: toDecimalString(realizedGross) };

    const changed =
      reducing ||
      state.position.averageEntryPrice !== averageEntryPrice ||
      state.position.lastEntryPrice !== lastEntryPrice ||
      state.position.entries.length !== entries.length ||
      state.exitOrderId !== null ||
      state.exitKind !== undefined;

    if (!changed) {
      return {
        outcome: "no_change",
        committed: false,
        status: state.status,
        blockedBy: null,
        reasons: [],
        before,
        after: withPnl,
        ...carry,
      };
    }

    if (!commit) {
      return {
        outcome: "would_repair",
        committed: false,
        status: state.status,
        blockedBy: null,
        reasons: [],
        before,
        after: withPnl,
        ...carry,
      };
    }

    // --- Commit: one write, guarded against the reads having gone stale. ---
    // Step 21's discipline. Every `getOrderStatus` above suspended this object,
    // and an RPC is delivered into exactly that window. `#mutateState` stops two
    // writes reverting each other; it cannot stop a DECISION taken against state
    // that has since moved, which is what this whole computation is. So the
    // mutate re-reads and refuses to apply if the position it measured is no
    // longer the position that is there.
    let raced = false;
    await this.#mutateState((current) => {
      if (
        current.position.quantity !== state.position.quantity ||
        current.position.cost !== state.position.cost ||
        current.realizedGross !== state.realizedGross ||
        current.exitOrderId !== state.exitOrderId ||
        current.status !== state.status
      ) {
        raced = true;
        return current;
      }
      return {
        ...current,
        position: {
          quantity,
          cost,
          averageEntryPrice,
          entries,
          // Carried, never rebuilt. See the docblock.
          additionalBuysUsed: current.position.additionalBuysUsed,
          lastEntryPrice,
        },
        realizedGross,
        exitOrderId: null,
        exitKind: undefined,
      };
    });

    if (raced) {
      return refuse(
        "concurrent state change during the exchange reads",
        [
          `this bot's position, realized total, exit pointer or status changed while the ` +
            `live-cycle orders were being read back, so the repair was computed against state ` +
            `that no longer exists. Nothing was written; run it again.`,
        ],
        carry,
      );
    }

    await this.#alert(config, {
      severity: "info",
      category: "trading",
      alertType: "position_repaired",
      message:
        `position rebuilt from the live cycle's own orders: quantity ${before.quantity} -> ` +
        `${after.quantity}, cost ${before.cost} -> ${after.cost}, average entry ` +
        `${before.averageEntryPrice} -> ${after.averageEntryPrice}. The sold leg's realized ` +
        `${toDecimalString(soldPnl)} ${config.capitalAsset} was booked; the stale exit pointer ` +
        `was cleared. Requested by ${actor}.`,
      // A receipt of a completed repair. The before/after it reports is a fact
      // about a write that already happened.
      resolved: true,
    });

    await this.#audit(
      config,
      "bot.position_repaired",
      actor,
      {
        before,
        after: withPnl,
        realized_delta: toDecimalString(soldPnl),
        live_cycle_order_ids: liveCycleOrderIds,
        closed_cycle_count: closedCycleCount,
        evidence,
        findings,
      },
      this.#now(),
    );

    return {
      outcome: "repaired",
      committed: true,
      status: (await this.#state()).status,
      blockedBy: null,
      reasons: [],
      before,
      after: withPnl,
      ...carry,
    };
  }

  /**
   * Observe this bot's own open orders and fold in anything it has not seen.
   *
   * THE GAP THIS CLOSES. `onFill` has exactly four callers, all of them the
   * order-placement sites, and each only drains `result.fills` -- the
   * executions attached to the placement RESPONSE. Nothing observes an order
   * that RESTS and fills later. A DCA base order that does not fill immediately
   * therefore leaves the position empty forever, `decide` returns `hold` on
   * every tick (it short-circuits on `position.quantity <= ZERO` before it ever
   * reaches the stop-loss or take-profit branches), and the bot does not
   * progress at all until section 9's reconciliation notices the drift and
   * halts it. Reconciliation is a BACKSTOP that halts and alerts; it
   * deliberately never auto-corrects. This is the path that actually keeps a
   * running bot's books current.
   *
   * THE THREE CALLERS, as of step 22: the 30-second alarm (step 20), a test,
   * and a human through `POST /api/bots/:id/check-open-orders`. The endpoint is
   * the operator's first move on a `poll_blind` or `price_updates_stale` alert,
   * which both mean the scheduled path has stopped working -- so the manual one
   * has to exist, or the response to "your bot stopped observing itself" is to
   * wait and hope. Interleaving with `onPriceUpdate` is real on all three paths
   * and is step 21's subject: this pass yields to any non-poll pass, before its
   * loop and again after each read.
   *
   * `routine` priority: keeping the books current is ordinary work. It must not
   * draw on the slice section 5.4 reserves for getting OUT of a position.
   *
   * IT IS NOT READ-ONLY, and a caller must not present it as such. On a RUNNING
   * grid bot a folded buy places its paired replacement sell, exactly as a live
   * fill would (`placeReplacement` is derived from `fresh.status === "running"`,
   * step 19). That is the grid working rather than a repair trading behind the
   * operator's back -- but it does mean this can put an order on the exchange.
   */
  async checkOpenOrders(actor: string): Promise<OrderCheckResult> {
    const config = await this.#config();
    const state = await this.#state();

    if (state.status === "stopped") {
      throw new BotInstanceError(
        "invalid_status",
        "a stopped bot has no open orders to check; its capital is released",
      );
    }

    const pass = await this.#observeOpenOrders(config, state, actor);

    return {
      status: (await this.#state()).status,
      applied: pass.applied,
      skipped: pass.skipped,
      closed: pass.closed,
      deferred: pass.deferred,
    };
  }

  /**
   * One observation pass, its audit row, and its half of the alert lifecycle.
   *
   * THE ONE BODY BOTH CALLERS RUN. `checkOpenOrders` (a human, through the DO's
   * RPC) and `alarm` (step 20's 30-second timer) reach the exchange through
   * here, so the manual and the scheduled path cannot disagree about what a
   * pass records, what it alerts, or what it closes. The alarm adds only
   * SCHEDULING on top -- backoff and the blind escalation -- which is the one
   * thing a manual call has no opinion about.
   */
  async #observeOpenOrders(
    config: BotConfig,
    state: BotRuntimeState,
    actor: string,
  ): Promise<PollPass> {
    const pass = await this.#pollOpenOrders(config, state);

    // Audited when something MOVED -- or when this pass identified a real
    // problem and refused to act on it.
    //
    // The `refused` half is step 22's correction to step 19's rule, and the gap
    // it closes is not theoretical. `applied || closed` alone means a pass that
    // hit `#foldTerminalState`'s quantity gate -- the exact bot-44400a
    // condition, an order that ended terminal on the exchange with more filled
    // than this bot recorded -- wrote NOTHING durable. Neither did an
    // `OrderStateError`, nor an unattributable fill. Those are the passes whose
    // reasoning an operator most needs to reconstruct afterwards, and the poll
    // was recording only the passes where everything went fine.
    //
    // UNREADABLE PASSES ARE STILL DELIBERATELY EXCLUDED, which is why `refused`
    // exists as its own list rather than the gate reading `skipped`. `skipped`
    // holds both, and gating on it would put a row on every pass of an outage --
    // at 30 seconds, ~2,880 a day per bot saying "the venue is still down". That
    // condition already has a lifecycle built for it: the backoff, and one
    // standing `poll_blind`. Step 20 separated these two for this class of
    // reason and the separation earns its keep again here.
    //
    // The no-op pass still writes nothing at all. On a timer it is the
    // overwhelmingly common one, and a row per pass would measure how long the
    // bot has been running rather than what happened to it.
    if (pass.applied.length > 0 || pass.closed.length > 0 || pass.refused.length > 0) {
      await this.#audit(
        config,
        "bot.open_orders_checked",
        actor,
        {
          applied: pass.applied,
          skipped: pass.skipped,
          closed: pass.closed,
          // The subset of `skipped` that made this row exist, named separately
          // so the row says WHY it was written. `skipped` stays whole because it
          // is the honest full account of what this pass could not do.
          refused: pass.refused,
        },
        this.#now(),
      );
    }

    // The other half of the standing-alert lifecycle, and it is gated on this
    // pass having actually READ every open order. A pass that could not reach
    // the venue found no unattributable fill because it looked at nothing, and
    // closing an incident on that basis would clear a live problem on the
    // strength of an outage -- section 5.6 applied to the alert lifecycle,
    // exactly as reconciliation applies it.
    if (observedEverything(pass)) {
      // A successful read is also proof that polling works, so the blind
      // episode ends here rather than only inside the alarm -- keeping the
      // persisted flags and the alert rows in lockstep. If the flags survived a
      // resolution, `poll_blind` could never be raised again.
      const schedule = await this.#pollSchedule();
      if (schedule.failures !== 0 || schedule.blindSince !== null || schedule.escalated) {
        await this.#mutatePollSchedule((current) => ({
          ...current,
          failures: 0,
          blindSince: null,
          escalated: false,
        }));
      }

      await resolveClearedStandingAlerts(this.#db(), {
        source: BOT_ALERT_SOURCE,
        owns: (alertType) => POLL_STANDING_ALERT_TYPES.has(alertType),
        stillOpen: pass.standing,
        observed: true,
        scope: { kind: "bot", botInstanceId: config.botInstanceId },
      });
    }

    return pass;
  }

  /**
   * One observation pass. Split from `checkOpenOrders` so the alarm calls the
   * same body without re-deciding the audit rule.
   *
   * Three cases per order, and the difference between them is entirely about
   * what the exchange was willing to tell us:
   *
   *  1. **Per-fill detail present** -- apply each unseen `fillId` through the
   *     ordinary live path. Gemini supplies this: `getOrderStatus` has always
   *     sent `include_trades: true`, so the ids are its own `tid` values.
   *  2. **No per-fill detail, but more filled than we recorded** -- alerted and
   *     SKIPPED. Binance's order-status endpoint carries no fills array at all,
   *     so there is no real id to apply and `applyFill` deduplicates on exactly
   *     that id. Synthesising one means the real execution later either
   *     double-counts or is silently swallowed. This is the same restraint
   *     `#recordCancellation` already exercises, for the same reason.
   *  3. **Nothing new** -- the common case, and it writes nothing.
   */
  async #pollOpenOrders(config: BotConfig, state: BotRuntimeState): Promise<PollPass> {
    const applied: AppliedFill[] = [];
    const skipped: string[] = [];
    const closed: string[] = [];
    const refused: string[] = [];
    const standing = new Set<string>();
    let reads = 0;
    let unreadable = 0;

    /**
     * Record something this pass READ and then declined to act on.
     *
     * Both lists, always, through one call -- see `PollPass.refused`. The
     * unreadable branch below deliberately does NOT come through here: it did
     * not read anything, and conflating the two is what step 20 spent a section
     * refusing to do.
     */
    const refuse = (reason: string): void => {
      skipped.push(reason);
      refused.push(reason);
    };

    // FIRST, and before every early return below, because it is derived from
    // this object's own state and clock and needs no exchange call at all. A
    // pass that stands aside for another, or finds nothing to read, has still
    // observed the tick clock perfectly well.
    await this.#checkPriceFreshness(config, state, standing);

    // BEFORE the empty-book early return, not after. A ladder can have every
    // rung filled and no open order left while replacements are still queued
    // waiting for those very levels -- which is the exact shape of the incident
    // this queue exists for. Returning early there would leave the queue
    // undrained for as long as the book stayed empty, i.e. forever.
    if (config.strategy === "grid" && state.status === "running") {
      await this.#drainReplacements(config, standing);
      state = await this.#state();
    }

    if (state.openOrderIds.length === 0) {
      return { applied, skipped, closed, refused, standing, reads, unreadable, deferred: false };
    }

    // Yield before starting. Another pass is already inside this object, and
    // anything read now would be applied against state it is in the middle of
    // changing. See `#outsidePoll`: the poll is the one writer that can always
    // afford to come back later.
    if (this.#passesInFlight > 0) {
      return { applied, skipped, closed, refused, standing, reads, unreadable, deferred: true };
    }

    const exchange = this.#exchange(config, "routine");
    const clientOrderIds = [...state.openOrderIds];

    // READ EVERY ORDER AT ONCE, then apply them one at a time. The split is the
    // whole of this change, and each half is load-bearing for its own reason.
    //
    // THE READS FAN OUT because they are independent, and each one is two
    // network round trips taken strictly after the last: a `RateLimiter` RPC for
    // budget, then the venue. A bot resting N orders therefore paid N times the
    // latency of a bot resting one -- measured as 780ms per alarm on a four-rung
    // ladder against 250-310ms for the single-order peers -- for reads that
    // never depended on each other. Concurrently they cost one round trip
    // regardless of N.
    //
    // CONCURRENT `acquire` IS SAFE, and that was checked rather than assumed.
    // `RateLimiter.acquire` reads the ceiling, sums the claims ahead of it, and
    // calls `WeightBudget.consume` in ONE synchronous run; its only await, the
    // persist, comes after the weight is already spent in memory. A Durable
    // Object yields only at an await, so no two acquires can pass the same
    // check. That ordering is deliberate -- the method says so, and
    // `rate-limiter.test.ts` forces the interleaving rather than reasoning about
    // it. Each caller queues its own ticket, exactly as the other bots on this
    // account already do, and step 21's probe already observed two
    // `getOrderStatus` calls outstanding here at once. Nothing about the budget
    // is changed by this.
    //
    // THE APPLICATION STAYS SEQUENTIAL, and must. `#applyGridFillToOrder` places
    // the paired sell for a filled buy, mutating the ladder and `openOrderIds`;
    // the inner fill loop below re-reads `#order` and `#state` on every
    // iteration for precisely that reason. Fanning the writes out would race the
    // ladder against itself. Only the reads are independent, so only the reads
    // are parallel.
    const outcomes = await Promise.all(
      clientOrderIds.map((clientOrderId) => exchange.getOrderStatus(config.pair, clientOrderId)),
    );
    reads = clientOrderIds.length;

    // CLASSIFIED BEFORE THE YIELD, so an unreadable order is still reported by a
    // pass that then stands aside. `#runScheduledPoll` documents the mixed case
    // -- failed to read A, then deferred on B -- as one whose failure must
    // survive, because it is real evidence the venue is unreachable and dropping
    // it suppresses the backoff and `poll_blind` for exactly the bot that needs
    // them. The sequential loop knew only about the unreadable orders it happened
    // to reach before deferring; this knows about all of them.
    const readable: { clientOrderId: string; remote: OrderStatus }[] = [];
    for (const [index, clientOrderId] of clientOrderIds.entries()) {
      const outcome = outcomes[index]!;
      if (!isUsable(outcome)) {
        // Section 5.6: an unreachable exchange is not data. The order keeps its
        // local state and stays open, to be read again on the next pass.
        unreadable += 1;
        skipped.push(`${clientOrderId}: ${outcome.kind} ${outcome.message}`);
        continue;
      }
      readable.push({ clientOrderId, remote: outcome.value });
    }

    // AND YIELD AGAIN HERE, which is the check that actually matters -- unchanged
    // in purpose, moved only in position. The reads above suspend this object on
    // the network, and step 21's section 0 probe measured that a price tick or an
    // alarm is delivered into exactly that window. So the pass may have been
    // alone when it started and not be alone now, and a fill just read would be
    // folded into a position another pass is mid-way through acting on.
    //
    // It still guards every write, because nothing above this line mutates
    // anything. What it no longer does is abandon the remaining READS -- they
    // have already happened, together, and cost nothing more to keep.
    //
    // Abandoning costs nothing: the fill is the exchange's own record, it is
    // still there on the next pass, and `applyFill` dedupes on its id. Not
    // applying something re-readable is always cheaper than applying it at the
    // wrong moment.
    //
    // `reads` deliberately KEEPS these reads. They happened and they succeeded --
    // the venue answered. An earlier version decremented here on the reasoning
    // that the result was discarded, and that quietly disabled both of the guards
    // `deferred` exists to feed: `observedEverything` starts with `reads > 0`,
    // and `#runScheduledPoll` treats `reads === 0` as "nothing to read". Forcing
    // the count to zero made a deferred pass indistinguishable from an empty one,
    // so two mutants that should have failed a test survived instead. What a
    // deferred pass did not do is FINISH, and `deferred` is what says so.
    if (this.#passesInFlight > 0) {
      return { applied, skipped, closed, refused, standing, reads, unreadable, deferred: true };
    }

    for (const { clientOrderId, remote } of readable) {

      if (remote.fills === undefined) {
        const local = await this.#order(clientOrderId);
        if (local !== undefined && remote.filledQuantity > local.filledQuantity) {
          refuse(
            `${clientOrderId}: the exchange reports ${toDecimalString(remote.filledQuantity)} ` +
              `filled against ${toDecimalString(local.filledQuantity)} recorded, but sent no ` +
              `per-fill detail, so there is no real fill id to apply.`,
          );
          // A STANDING alert, not an unconditional insert, and step 20 is where
          // that stopped being optional: this condition is re-detected on every
          // pass and is deliberately never auto-corrected, so at 30 seconds an
          // unconditional insert writes ~2,880 identical criticals per bot per
          // day -- step 18's measured 186-in-four-hours problem, 60x faster.
          // Through the SAME mechanism reconciliation uses, so the two writers
          // cannot drift apart.
          standing.add(standingAlertKey("unattributable_fill", config.botInstanceId));
          await this.#raiseStanding(config, {
            severity: "critical",
            category: "trading",
            alertType: "unattributable_fill",
            message:
              `${clientOrderId} has filled ${toDecimalString(remote.filledQuantity)} on the ` +
              `exchange but this bot recorded ${toDecimalString(local.filledQuantity)}, and the ` +
              `status response carries no per-fill breakdown and therefore no trade id. The ` +
              `difference is NOT applied here: a synthesised id would make the real execution ` +
              `either double-count or be silently swallowed. Reconciliation owns it.`,
          });
          // Deliberately NOT folded to its terminal state below: `#foldTerminalState`
          // would refuse this exact case anyway, and continuing here keeps the
          // order to one reported reason rather than two saying the same thing.
          continue;
        }
        // No per-fill detail AND no gap: there is no unattributed execution, so a
        // terminal exchange state can still be folded in safely below. Its own
        // quantity gate is what makes that true, not this branch.
      }

      for (const fill of remote.fills ?? []) {
        // Re-read both each time: the previous fill mutated this order, and a
        // grid replacement placement mutated the state.
        const order = await this.#order(clientOrderId);
        if (order === undefined) {
          refuse(`${clientOrderId}: no local record of this order`);
          break;
        }
        if (order.fills.some((existing) => existing.fillId === fill.fillId)) {
          continue; // Already recorded. Idempotent by real identity, not by a flag.
        }

        const fresh = await this.#state();
        try {
          if (config.strategy === "grid") {
            // TRUE here, unlike `applyMissedFills`. A buy filling on a running
            // bot's ladder SHOULD place its paired sell -- that is the grid
            // working, not a repair resuming trading behind the operator's
            // back. Gated on `running` all the same: a halted bot must not put
            // a live order on the exchange, which is the invariant the repair
            // path's `false` exists to protect.
            await this.#applyGridFillToOrder(config, fresh, order, fill, fresh.status === "running");
          } else {
            await this.#applyFillToOrder(config, fresh, order, fill);
          }
          applied.push({
            clientOrderId,
            fillId: fill.fillId,
            quantity: toDecimalString(fill.quantity),
            price: toDecimalString(fill.price),
          });
        } catch (error) {
          // An `OrderStateError` means the local record and the exchange
          // genuinely disagree in a way this pass must not paper over.
          refuse(
            `${clientOrderId} fill ${fill.fillId}: ` +
              `${error instanceof Error ? error.message : String(error)}`,
          );
          break;
        }
      }

      if (await this.#foldTerminalState(config, clientOrderId, remote, refuse)) {
        closed.push(clientOrderId);
      }
    }

    return { applied, skipped, closed, refused, standing, reads, unreadable, deferred: false };
  }

  /**
   * Raise or clear the "this bot has stopped receiving prices" condition.
   *
   * WHAT MAKES STEP 21's "WAIT FOR THE NEXT TICK" SOUND. A poll-observed fill
   * deliberately does not act: the poll has no price, and every action either
   * strategy can take needs one. That is a correct decision and an unverified
   * assumption at the same time, until something checks that a next tick is
   * actually coming. This is that check, and it is the first read of
   * `lastPriceAt` anywhere in the codebase.
   *
   * RUNNING ONLY, and that is not a convenience. `#onPriceUpdatePass` returns
   * `ignored` before it writes `lastPriceAt` for any other status, so a halted
   * bot's clock is frozen BY DESIGN -- checking one would alert on every halted
   * bot with a resting order, permanently, for doing exactly what it is supposed
   * to. The useful half falls out for free: a bot that halts while this
   * condition stands stops re-finding it, so its next pass resolves the row
   * through the ordinary lifecycle. A halted bot receiving no prices is not a
   * fault and the alert correctly stops claiming it is.
   *
   * That resolution needs a NEXT PASS, though, and a halt that cancels cleanly
   * empties `openOrderIds` and disarms the poll -- so the row can outlive the
   * condition, exactly as step 20's open question 2 records for `poll_blind`.
   * The rule is the same one and it is the safe direction: only a pass that
   * actually looked may close a row.
   *
   * A NULL `lastPriceAt` raises nothing, deliberately. It means "running, but no
   * tick has ever arrived", and there is no `startedAt` in this object's state
   * to measure that against -- an age is not computable, and inventing one from
   * the poll's own first sighting would restart on every eviction. It is also
   * unreachable from the SCHEDULED path, which is what makes leaving it
   * acceptable rather than a gap: every order-placing site sits inside
   * `#onPriceUpdatePass`, which writes `lastPriceAt` before it decides anything,
   * so a running bot with a resting order has provably seen at least one tick,
   * and a bot with no resting order arms no alarm. Only a manual
   * `checkOpenOrders` can reach it. See the step 22 log's open questions.
   */
  async #checkPriceFreshness(
    config: BotConfig,
    state: BotRuntimeState,
    standing: Set<string>,
  ): Promise<void> {
    if (state.status !== "running" || state.lastPriceAt === null) return;

    const age = this.#now() - state.lastPriceAt;
    if (age < PRICE_STALENESS_MS) return;

    standing.add(standingAlertKey("price_updates_stale", config.botInstanceId));
    await this.#raiseStanding(config, {
      severity: "warning",
      category: "system",
      alertType: "price_updates_stale",
      message:
        `bot ${config.botInstanceId} has received no live price for ` +
        `${Math.round(age / 60_000)} minutes (last at ${new Date(state.lastPriceAt).toISOString()}), ` +
        `against a measured feed cadence of one closed candle every 35-70s. It is RUNNING, so its ` +
        `stop-loss and take-profit are evaluated on price updates that are not arriving, and any ` +
        `fill this poll observes waits for a tick that may never come. The feed's own ` +
        `price_feed_blind alert cannot cover this: its staleness clock is advanced by heartbeats, ` +
        `so a socket that heartbeats while delivering no candles looks healthy from there. Check ` +
        `whether this bot is still subscribed to its price feed.`,
    });
  }

  /**
   * Close a local order whose exchange record has reached a terminal state.
   *
   * Without this, an order cancelled or expired ON THE EXCHANGE never leaves
   * `openOrderIds`, and every future pass re-reads it forever.
   *
   * GATED ON THE FILL QUANTITIES AGREEING, which is the whole safety of it. An
   * order that ended with more filled than this bot recorded is left OPEN and
   * reported, never closed. Closing it would bake a position that is known to
   * be understated into a terminal record -- and a terminal order can never
   * accept a fill afterwards (`ALLOWED_TRANSITIONS` gives every terminal state
   * an empty successor list), so the understatement would be permanent and
   * unrepairable. That is exactly how one incident's base order became
   * unrecoverable, and it is not repeated here.
   *
   * `filled` is deliberately not a case: an order is recorded as filled by
   * applying its fills, never by asserting the end state over them.
   */
  async #foldTerminalState(
    config: BotConfig,
    clientOrderId: string,
    remote: OrderStatus,
    /**
     * Takes the REFUSAL path, not a raw `skipped` array (step 22). The gate
     * below is the archetypal refusal -- read successfully, understood exactly,
     * and declined -- and it is the specific one that used to leave no durable
     * record at all.
     */
    refuse: (reason: string) => void,
  ): Promise<boolean> {
    if (remote.state !== "cancelled" && remote.state !== "expired" && remote.state !== "rejected") {
      return false;
    }

    const order = await this.#order(clientOrderId);
    if (order === undefined || isTerminal(order.state)) return false;

    if (order.filledQuantity < remote.filledQuantity) {
      refuse(
        `${clientOrderId}: ended ${remote.state} on the exchange with ` +
          `${toDecimalString(remote.filledQuantity)} filled against ` +
          `${toDecimalString(order.filledQuantity)} recorded. Left open rather than closed: a ` +
          `terminal order can never accept the missing fill afterwards.`,
      );
      return false;
    }

    // `?? this.#now()` is RECEIPT TIME, and it is the honest value rather than a
    // fallback of convenience. `OrderStatus.updatedAt` is optional because Gemini
    // reports no last-update time at all, and what this line is stamping is the
    // LOCAL record's "when this bot recorded the order closed" -- which receipt
    // time describes exactly. Before the field became optional, Gemini's parser
    // fabricated `updatedAt = createdAt`, so every Gemini order closed here --
    // and every `orders.updated_at` row mirrored from it -- permanently recorded
    // the order's CREATION time as its last update.
    const ended = closeOrder(order, remote.state, remote.updatedAt ?? this.#now());
    await this.#putOrder(ended);
    await this.#mirrorOrderUpdate(ended);

    const state = await this.#state();
    if (config.strategy === "grid" && state.ladder !== undefined) {
      // CLEAR THE RUNG, AND REMOVE THE ID BY NAME -- two effects of one
      // resolution, written as two, which is the change here.
      //
      // This used to say "the ladder owns `openOrderIds` for a grid, so
      // clearing the slot IS the removal; filtering the array directly would be
      // undone by the next fill", and it ASSIGNED the whole list from the slots
      // on that reasoning. The premise was true only while every other write
      // re-derived the same way; none of them do any more, so a direct filter is
      // now stable and the assignment is the only thing left putting ids back.
      //
      // AND IT DID PUT THEM BACK. Assigning from the slots means every rung the
      // ladder holds joins the tracked list, including rungs left standing for
      // orders a halt sweep had already resolved -- so folding ONE genuinely
      // unresolved order resurrected its long-dead neighbours. The sweep no
      // longer leaves those rungs behind (see `#cancelOpenOrders`), which
      // removes the source; this removes the mechanism, so neither alone has to
      // be trusted.
      //
      // A TERMINAL FOLD CREATES NOTHING. It resolves exactly one order, so the
      // list loses exactly one id and gains none -- the same maintained
      // discipline `#applyGridFillToOrder` and `#placeGridOrder` now use,
      // in its simplest possible form. Both branches below now treat
      // `openOrderIds` identically; only the rung is grid-specific.
      const levelIndex = levelOf(state.ladder, clientOrderId);
      if (levelIndex >= 0) {
        await this.#mutateState((current) => {
          const slots = current.ladder!.slots.map((slot, index) =>
            index === levelIndex ? null : slot,
          );
          const ladder: GridLadder = { ...current.ladder!, slots };
          return {
            ...current,
            ladder,
            openOrderIds: current.openOrderIds.filter((id) => id !== clientOrderId),
          };
        });
        return true;
      }
    }
    await this.#mutateState((current) => ({
      ...current,
      openOrderIds: current.openOrderIds.filter((id) => id !== clientOrderId),
    }));
    return true;
  }

  // -------------------------------------------------------------------------
  // The alarm (step 20): one timer, every scheduled concern
  // -------------------------------------------------------------------------

  /**
   * The single alarm handler, multiplexed from day one.
   *
   * ONE ALARM PER DURABLE OBJECT. That is the platform's rule and it is also
   * `PriceFeed`'s own hard-won lesson: its heartbeat check and its reconnect
   * backoff cannot each own a timer, so they are folded into one instant and
   * the handler works out what is due. This object has exactly one scheduled
   * concern today -- the open-order poll -- and is written as if it had
   * several, because the version that assumes one is the version where the
   * second one silently cancels the first by calling `setAlarm` again.
   *
   * IT NEVER THROWS. An alarm has no caller to report to; a handler that
   * throws is retried by the runtime on its own schedule, which would double
   * up on a poll that is already failing. Every failure path here ends in a
   * recorded failure and a re-armed alarm instead.
   */
  override async alarm(): Promise<void> {
    const schedule = await this.#pollSchedule();
    const now = this.#now();

    // Consume the firing FIRST. Everything this pass writes goes through
    // `#putState`, which re-arms -- and it must re-arm from a fresh instant
    // rather than reuse the one that has just fired, which is in the past and
    // would fire again immediately, forever.
    await this.#putPollSchedule({ ...schedule, nextPollAt: null });

    let config: BotConfig;
    let state: BotRuntimeState;
    try {
      config = await this.#config();
      state = await this.#state();
    } catch {
      // No config, no state, or a schema this build cannot read. Nothing to
      // schedule, and nothing to escalate: capital is reserved and the D1 row
      // written before this object's own storage (step 6, open question 6), so
      // an alarm can outlive a bot that was never finished. Leave it off.
      await this.#armAlarm(null);
      return;
    }

    const pollDue = schedule.nextPollAt !== null && now >= schedule.nextPollAt;
    if (pollDue && this.#pollArmed(state)) {
      await this.#runScheduledPoll(config, state);
    }

    // Re-read: the pass may have emptied `openOrderIds`, which disarms.
    await this.#syncAlarm(await this.#state());
  }

  /**
   * One scheduled pass, and what its outcome does to the schedule.
   *
   * The pass itself is `#observeOpenOrders`, byte for byte the one a human's
   * `checkOpenOrders` runs. What is added here is only scheduling: a pass that
   * could not read backs off, and a poll that has been unable to read for long
   * enough says so.
   *
   * A POLL ON A HALTED BOT IS DELIBERATELY ALLOWED (step 19): observing costs
   * nothing and keeps the books current for whoever is reviewing it. What it
   * must never do is place a replacement order, which is not defended here but
   * inside `#pollOpenOrders`, where `placeReplacement` is derived from
   * `fresh.status === "running"` rather than hardcoded.
   */
  async #runScheduledPoll(config: BotConfig, state: BotRuntimeState): Promise<void> {
    let pass: PollPass | null = null;
    let thrown: string | null = null;
    try {
      pass = await this.#observeOpenOrders(config, state, POLL_ACTOR);
    } catch (error) {
      // Anything at all: an unresolvable exchange client, a refused rate-limit
      // budget, a storage error. All of it means this pass did not observe.
      thrown = error instanceof Error ? error.message : String(error);
    }

    if (pass !== null && (pass.reads === 0 || pass.unreadable === 0)) {
      // Either there was nothing to read, or everything that was read came
      // back. `#observeOpenOrders` has already cleared the failure state.
      //
      // A DEFERRED PASS NEEDS NO BRANCH OF ITS OWN HERE, which is worth saying
      // because it had one and a surviving mutant proved it dead. Standing
      // aside is not a failure, and a pass that stood aside without any
      // unreadable order satisfies `unreadable === 0` already.
      //
      // The case that made the explicit branch actively WRONG is the mixed
      // one: a pass that failed to read order A, then deferred on order B.
      // That failure is real evidence the venue is unreachable, and returning
      // early on `deferred` would have thrown it away -- suppressing the
      // backoff and `poll_blind` for exactly the bot that needed them. Falling
      // through to record it is correct, and this condition does that.
      return;
    }

    await this.#recordPollFailure(
      config,
      thrown ??
        `${pass!.unreadable} of ${pass!.reads} open orders could not be read: ` +
          pass!.skipped.join("; "),
    );
  }

  /**
   * Count a failed pass, and go loud once the poll has been blind long enough.
   *
   * MIRRORS THE PRICE FEED'S BLIND POLICY, which is the closest precedent in
   * this system for "a thing that should be watching has stopped being able
   * to": fast backoff first, then one `warning` when the fast cycle is
   * exhausted, then one `critical` if the condition persists past the
   * escalation window, then a slow retry that keeps trying forever so a long
   * outage self-heals rather than dying silently.
   *
   * Both alerts go through the STANDING path, which the feed's do not. That is
   * belt and braces on purpose: the `blindSince` / `escalated` flags already
   * stop a re-raise, but they are this object's own bookkeeping, and if they
   * were ever reset while the condition persisted the alert would begin
   * repeating at the poll's cadence. The shared dedup makes a duplicate row
   * impossible independently of them, and gives both alerts a real resolution
   * the moment a pass reads cleanly again.
   */
  async #recordPollFailure(config: BotConfig, detail: string): Promise<void> {
    const schedule = await this.#pollSchedule();
    const now = this.#now();
    const failures = schedule.failures + 1;

    // DECIDED FIRST, RAISED SECOND, WRITTEN LAST, and the split exists because
    // the middle step is a D1 write and therefore a point at which this object
    // is re-entered. The old form built the whole next schedule up front and
    // wrote it after the alert, reverting anything a concurrent pass had
    // written meanwhile -- including a successful pass's cleared failure count.
    const goesBlind = failures >= MAX_POLL_FAILURES && schedule.blindSince === null;
    const escalates =
      failures >= MAX_POLL_FAILURES &&
      !goesBlind &&
      !schedule.escalated &&
      schedule.blindSince !== null &&
      now - schedule.blindSince >= POLL_BLIND_ESCALATION_MS;

    if (goesBlind) {
      await this.#raiseStanding(config, {
        severity: "warning",
        category: "system",
        alertType: "poll_blind",
        message:
          `bot ${config.botInstanceId} has failed to read its own open orders on ` +
          `${failures} consecutive passes (${detail}). Retrying every ` +
          `${POLL_BACKOFF_CAP_MS / 1000}s. Until it succeeds, a fill on a resting order ` +
          `reaches this bot's position through nothing at all, and reconciliation is the ` +
          `only thing that would notice.`,
      });
    } else if (escalates) {
      await this.#raiseStanding(config, {
        severity: "critical",
        category: "system",
        alertType: "poll_blind_escalated",
        message:
          `bot ${config.botInstanceId} has been unable to read its own open orders for over ` +
          `${Math.round(POLL_BLIND_ESCALATION_MS / 60_000)} minutes (${detail}). Its books ` +
          `have been unverified for that entire period, so its position, its take-profit ` +
          `target and its stop-loss may all be computed from a quantity that is no longer true.`,
      });
    }

    // `nextPollAt` is cleared as well as the count incremented, so the
    // re-arming that follows recomputes the delay from the NEW failure count.
    // A pass that read some orders and failed on others writes state, and that
    // write re-arms at the healthy 30s through `#putState` -- without this, the
    // backoff would silently not apply to exactly the mixed case.
    await this.#mutatePollSchedule((current) => ({
      ...current,
      nextPollAt: null,
      failures: current.failures + 1,
      blindSince: goesBlind ? now : current.blindSince,
      escalated: escalates ? true : current.escalated,
    }));
  }

  /**
   * Reconcile the single alarm with what this object currently needs scheduled.
   *
   * Called from `#putState`, which is the one choke point every mutation of
   * `openOrderIds` already passes through -- placement, fills, cancellation,
   * the ladder, halt, close. Arming at each of those call sites instead would
   * work exactly until someone adds a seventh and forgets, and the failure
   * would be silent: a bot with a resting order and no timer, which is the
   * precise condition step 19 exists to end.
   */
  async #syncAlarm(state: BotRuntimeState): Promise<void> {
    const schedule = await this.#pollSchedule();
    const armed = this.#pollArmed(state);
    let nextPollAt = schedule.nextPollAt;

    if (armed && nextPollAt === null) {
      nextPollAt = this.#now() + this.#pollDelay(schedule, state);
      await this.#putPollSchedule({ ...schedule, nextPollAt });
    } else if (armed && nextPollAt !== null) {
      // TIGHTEN, NEVER LOOSEN, and this branch exists because without it the
      // tier would apply a whole interval late. `nextPollAt` is recomputed only
      // when it is null -- i.e. after a firing -- so a bot that armed on a loose
      // tier holds that instant even once it goes urgent. The transition that
      // matters arrives on the PRICE-TICK path (a fill whose replacement could
      // not be placed, a stop-loss placing a liquidation sell), with no firing
      // in between to re-arm it, so up to a full loose interval could pass with
      // an uncovered position and no poll due. Pulling the instant in closes it.
      //
      // Only ever EARLIER. A tier that loosens leaves the tighter instant
      // standing until the next firing re-derives it, which costs one extra poll
      // and cannot cost anything else -- the safe direction to be wrong in. It
      // is also what keeps this from oscillating: once pulled in, `now + delay`
      // grows past the instant it just set, so it changes nothing on subsequent
      // passes.
      const tightened = this.#now() + this.#pollDelay(schedule, state);
      if (tightened < nextPollAt) {
        nextPollAt = tightened;
        await this.#putPollSchedule({ ...schedule, nextPollAt });
      }
    } else if (!armed && nextPollAt !== null) {
      // Disarmed: there are no open orders to read. The failure COUNT resets,
      // because a bot with nothing to poll is not failing to poll -- but a
      // standing `poll_blind` is deliberately NOT resolved here. Only a pass
      // that actually read cleanly can close it; "there is nothing to read any
      // more" is not evidence that reading works, and the orders may well have
      // left `openOrderIds` precisely because this object's view of them is
      // wrong.
      nextPollAt = null;
      await this.#putPollSchedule({ ...schedule, nextPollAt: null, failures: 0 });
    }

    await this.#armAlarm(this.#nextAlarmAt({ nextPollAt }));
  }

  /**
   * Fold every scheduled concern into the ONE instant this object may hold.
   *
   * The earliest wins; a concern that is not scheduled contributes nothing. Its
   * handler is responsible for noticing it was not the reason the alarm fired,
   * which is why `alarm()` checks `nextPollAt` against the clock rather than
   * assuming the poll is why it woke up.
   */
  #nextAlarmAt(concerns: { nextPollAt: Timestamp | null }): Timestamp | null {
    const due = [concerns.nextPollAt].filter((at): at is Timestamp => at !== null);
    return due.length === 0 ? null : Math.min(...due);
  }

  /**
   * Whether this bot needs its open orders polled at all.
   *
   * `openOrderIds` non-empty is the whole condition on the order side: no
   * resting order means nothing can fill unobserved, and a timer that keeps
   * firing against an empty list is a rate-limit cost with no possible finding.
   *
   * STATUS, deliberately, is only consulted to exclude `stopped`. A `halted`
   * bot is still polled -- step 19 established that observing a halted bot is
   * both safe and useful, since a halt that failed to cancel leaves live orders
   * on the exchange and a human is about to make a decision about exactly those
   * books. A `stopped` bot has released its capital and `checkOpenOrders`
   * refuses outright, so polling it would be work whose result nothing may use.
   */
  #pollArmed(state: BotRuntimeState): boolean {
    return state.openOrderIds.length > 0 && state.status !== "stopped";
  }

  /**
   * This bot's own healthy cadence, doubling to a 5-minute floor while the
   * reads keep failing.
   *
   * The backoff multiplies the TIER's base rather than a global 30s, so a
   * failing bot backs off from wherever it actually sits. A halted bot is
   * already at 120s and reaches the cap in one doubling, which is the intended
   * shape: nothing about it is urgent and the venue is not answering.
   */
  #pollDelay(schedule: PollSchedule, state: BotRuntimeState): number {
    const base = POLL_TIER_INTERVAL_MS[pollTierFor(state)];
    return Math.min(base * 2 ** schedule.failures, POLL_BACKOFF_CAP_MS);
  }

  async #armAlarm(at: Timestamp | null): Promise<void> {
    const current = await this.ctx.storage.getAlarm();
    if (at === null) {
      if (current !== null) await this.ctx.storage.deleteAlarm();
      return;
    }
    if (current !== at) await this.ctx.storage.setAlarm(at);
  }

  async #pollSchedule(): Promise<PollSchedule> {
    return (await this.ctx.storage.get<PollSchedule>(POLL_KEY)) ?? INITIAL_POLL_SCHEDULE;
  }

  async #putPollSchedule(schedule: PollSchedule): Promise<void> {
    await this.ctx.storage.put(POLL_KEY, schedule);
  }

  /**
   * Section 7.2, driven by a human or by a risk control outside this object
   * (the account circuit breaker of 7.3, the global kill switch of 7.4).
   */
  async halt(reason: HaltReason, detail: string, actor: string): Promise<PipelineResult> {
    return await this.#outsidePoll(() => this.#haltPass(reason, detail, actor));
  }

  async #haltPass(reason: HaltReason, detail: string, actor: string): Promise<PipelineResult> {
    const config = await this.#config();
    return await this.#halt(config, reason, detail, actor);
  }

  /**
   * Section 7.2 step 5: resuming requires an explicit human action after
   * review. This is that action, and it is the only path out of `halted`.
   */
  async resume(actor: string): Promise<PipelineResult> {
    return await this.#outsidePoll(() => this.#resumePass(actor));
  }

  async #resumePass(actor: string): Promise<PipelineResult> {
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

    // THE THIRD LATCH, and the narrowest: this bot's own books (step 57, fix 2).
    //
    // WHAT WENT WRONG WITHOUT IT. Reconciliation halted two real bots for a
    // meaningful `order_state_drift` finding -- their own fill counts
    // disagreeing with the exchange's -- and an operator resumed both. Resuming
    // cleared the halt and closed the halt alert and corrected nothing: the
    // wrong number was still the wrong number, and the bot went back to trading
    // on it. Section 9 halts and alerts and DELIBERATELY never auto-corrects, so
    // "reconciliation owns it" was never going to put the number back on its
    // own; the halt was the whole mechanism, and resume dismantled it in one
    // click while looking like an ordinary review.
    //
    // WHY THIS IS NOT A CHECK ON `haltReason`, which is where one would look
    // first and where it cannot work. Every reason in the `HaltReason` union is
    // a STRATEGY or ERROR reason -- `stop_loss`, `take_profit`,
    // `breakout_take_profit`, `take_profit_reached`, `order_rejected`,
    // `unhandled_error`, `manual`. There is no drift reason, because
    // reconciliation does not have one: `workers/reconciliation.ts` halts
    // through `haltBot`, which calls `halt("manual", detail, "reconciliation")`.
    // So does the global kill switch, and so does an operator clicking halt.
    // All three land as `manual`, and the only thing separating "reconciliation
    // found this bot untrustworthy" from "a human paused it" is the DETAIL
    // PROSE -- `haltReason` is the string `"manual: reconciliation run {id}
    // found meaningful drift: ..."`. Branching on that means matching a
    // sentence that nothing tests and any reword silently defeats, on the one
    // path where failing open means trading with known-wrong numbers.
    //
    // SO THE GATE READS THE CONDITION, NOT THE REASON, and the condition already
    // exists as durable, queryable, typecheck-tied state:
    // `ORDER_STATE_DRIFT_ALERT_TYPES` -- the same set `dashboard/src/driftAlerts.ts`
    // imports to decide whether to show the "Apply missed fills" control. An
    // unresolved row of one of those types IS "this bot's fill tracking is
    // currently known to be unreliable", written by whichever of the two writers
    // saw it. That makes the refusal and the repair control agree by
    // construction: the button is on screen exactly when resume is refused.
    //
    // Reading the condition is also STRICTLY WIDER than reading the reason, and
    // deliberately so. A bot halted on `stop_loss` while a drift row stands is
    // just as unsafe to resume as one halted by reconciliation -- the books are
    // in question either way, and why it stopped does not change that.
    //
    // NOT SCOPED BY `source`: both this object (`#onOrderStateError`) and
    // reconciliation write into this set, and either standing means the same
    // thing. Nor is it cleared here -- `resolveHaltAlerts` below owns only
    // `halt_*` rows and has always excluded these, which is what makes this a
    // condition resume cannot dismiss by running.
    const openDrift = await this.#db().alerts.findMany({
      where: {
        bot_instance_id: config.botInstanceId,
        alert_type: { in: [...ORDER_STATE_DRIFT_ALERT_TYPES] },
        resolved: false,
      },
    });
    if (openDrift.length > 0) {
      const types = [...new Set(openDrift.map((row) => row.alert_type))].sort().join(", ");
      throw new BotInstanceError(
        "position_unverified",
        `bot ${config.botInstanceId} cannot resume: ${openDrift.length} unresolved ` +
          `order-state-drift alert(s) (${types}) say this bot's own record of what it holds ` +
          `disagrees with the exchange. Resuming would put it back to trading -- sizing orders, ` +
          `and evaluating its stop-loss and take-profit -- against a quantity known to be ` +
          `wrong, and resume neither checks nor corrects that number. The drift has to be ` +
          `resolved first, by its own owner rather than by this call: reconciliation closes ` +
          `the row once it no longer re-finds the disagreement, and the ` +
          `apply-missed-fills repair can fold in executions the bot never recorded. ` +
          `Note that repair reaches only orders still in openOrderIds -- if the order has ` +
          `already gone terminal locally, there is no automated correction for it today and ` +
          `this needs a human decision about the position.`,
      );
    }

    // Fail-closed, as in `start`: re-subscribe to the feed before re-entering
    // running. A resume is another entry into the trading state, so it needs a
    // confirmed price connection just as much as a first start does.
    await this.#subscribeToFeed(config);

    const now = this.#now();
    // `halt_reason`/`halted_at` ARE cleared, and this is a reversal of the
    // previous comment here, which read: "deliberately NOT cleared: migration
    // 0001's halt_requires_reason CHECK is one-directional precisely so a
    // resumed row may keep the last reason rather than discarding why it
    // stopped." The CHECK does permit keeping it -- but permitting is not
    // requiring, and keeping it was wrong in practice. `halt_reason` is a
    // CURRENT-state column: the dashboard reads the row, sees a non-null
    // reason, and shows a resolved failure as if it were live. A real bot sat
    // `running` for hours advertising an `order_rejected ... MissingAccounts`
    // that had already been fixed.
    //
    // Nothing is discarded. The reason is written into this resume's own audit
    // entry as `previous_halt_reason` below, which is where the history of why
    // a bot stopped belongs -- an append-only log, not a mutable status column
    // that the next halt would overwrite anyway. `start` has always cleared
    // both (see above); resume was the inconsistent one.
    // D1 FIRST, THEN THE OBJECT -- and this is a REVERSAL of the order these two
    // writes were in, made deliberately, on the evidence of a real testnet bot.
    //
    // WHAT WENT WRONG WITH THE OTHER ORDER. `bot-gvtr1a` sat with
    // `bot_instances.status = 'halted'` in D1 while its own state said
    // `running` -- subscribed to its price feed, `lastPriceAt` advancing, no
    // `bot.resumed` audit row anywhere. That is this method, interrupted between
    // its two status writes. There is no transaction available to prevent it:
    // Durable Object storage and D1 are separate stores, `#mutateState` is
    // durable the moment it returns, and `#outsidePoll` is a counter with no
    // rollback. So the interruption cannot be prevented -- only AIMED.
    //
    // WHY THIS DIRECTION IS THE SAFE ONE, and it is not a matter of taste. Both
    // emergency stops -- the global kill switch (7.4) and the account circuit
    // breaker (7.3) -- choose whom to halt by reading D1 for
    // `status IN ('created','running')` (`kill-switch.ts`, `circuit-breaker.ts`).
    // `halted` is the ONE non-terminal status neither sweep selects. So the old
    // order's interruption left a bot that was genuinely live and genuinely
    // INVISIBLE to both of the controls that exist to stop it. This order's
    // interruption leaves D1 saying `running` and the object saying `halted`:
    // the sweeps still see it, halting it is a no-op because it already is, and
    // -- the part that actually matters -- NOTHING ANYWHERE STARTS TRADING
    // BECAUSE D1 SAYS SO. `#onPriceUpdatePass` reads this object's own state and
    // returns `ignored` before it reaches any order-placing site, and no code
    // outside this object reads `snapshot.state.status` at all. A stale
    // `running` row can mislead a human; it cannot place an order.
    //
    // The same interruption is already harmless on the two neighbouring
    // transitions, which is why only this one moved: `start` leaves D1 at
    // `created`, which both sweeps DO select, and `#halt` leaves D1 at
    // `running`, likewise. `resume` was the only transition that could aim the
    // failure at the one status neither sweep looks at.
    //
    // THIS ORDER IS PINNED BY A TEST (`resume-write-order.test.ts`), because it
    // is otherwise a property held by nothing: the two lines look
    // interchangeable, and swapping them back reopens the hole silently.
    //
    // WHAT THIS DOES NOT DO: it does not make a mismatch impossible, only
    // survivable, and nothing here DETECTS one. Reconciliation still never
    // compares `bot_instances.status` against `snapshot.state.status` --
    // `mirrorFindings` compares orders only -- so a bot already in the bad state
    // (`bot-gvtr1a` is one) is not repaired by this change and a mismatch in the
    // new, safe direction does not self-heal either: a sweep's `halt` on an
    // already-halted object returns `already_halted` BEFORE `#mirrorStatus`, so
    // it never converges the two stores. That detector is a separate, designed,
    // not-yet-built step -- `docs/open-items/resume-split-brain.md`, part 3b --
    // and convergence is deliberately left to it rather than widened into
    // `#halt` here.
    await this.#mirrorStatus(config, "running", null, null, now);
    await this.#mutateState((current) => ({
      ...current,
      status: "running",
      haltReason: null,
      haltedAt: null,
    }));

    // Step 27, and the same principle as the paragraph above applied one layer
    // out. Clearing `halt_reason` stopped the BOT ROW advertising a failure that
    // no longer applied; the ALERT ROW for that same halt was left standing
    // `unresolved` forever, which is where an operator counting open criticals
    // actually looks. Every open `halt_*` row for this bot is history the moment
    // the status is `running` -- and only those: `cancel_failed` may still mean a
    // live order, and the poll's standing alerts have their own owner. See
    // `/src/alerts/halt.ts` for the full exclusion list and why this is not
    // `resolveClearedStandingAlerts`.
    //
    // AFTER the status writes, deliberately. Everything above can refuse the
    // resume -- a latched kill switch, a latched breaker, a feed that will not
    // re-subscribe -- and a bot that stayed halted must keep its halt alert open.
    const resolvedAlertIds = await resolveHaltAlerts(this.#db(), {
      source: BOT_ALERT_SOURCE,
      botInstanceId: config.botInstanceId,
    });

    await this.#audit(
      config,
      "bot.resumed",
      actor,
      {
        previous_halt_reason: state.haltReason,
        previous_halted_at: state.haltedAt,
        // Which rows this resume closed, so the append-only log records the
        // alert-table effect and not just the status change.
        resolved_halt_alert_ids: resolvedAlertIds,
      },
      now,
    );

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
    return await this.#outsidePoll(() => this.#liquidatePositionPass(actor));
  }

  async #liquidatePositionPass(actor: string): Promise<PipelineResult> {
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

    // THE FIRST OF TWO READS OF THE SAME NUMBER, and they answer different
    // questions. This one is the CHEAP REFUSAL: a bot that is already flat
    // returns `nothing_to_liquidate` having cancelled nothing and written
    // nothing but its own receipt. That is the shape verified live on
    // `bot-4xcq8p` and `bot-3trlgb`, and it is why this check stays HERE rather
    // than moving after the sweep with the other one -- a no-op that cancels
    // orders on its way to doing nothing is not a no-op.
    if (this.#heldQuantityOf(config, state) <= ZERO) {
      await this.#alert(config, {
        severity: "info",
        category: "trading",
        alertType: "liquidation_noop",
        message: "liquidatePosition was called but the position is already flat; nothing to sell",
        // A receipt that the click landed and found nothing to do. The condition
        // it reports -- the position is flat -- was already true when it was
        // checked, and is not a problem to begin with.
        resolved: true,
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

    // REFUSE RATHER THAN SELL ALONGSIDE IT -- the gate entry 64 put on
    // `#closePass`, on the other action that acts on a swept list, for the same
    // reason and reusing the same code.
    //
    // The comment directly above asserts an outcome nothing was enforcing:
    // "so the liquidation sell is the only live order afterwards". It is not,
    // whenever `#cancelOpenOrders` leaves something behind -- and it leaves
    // exactly two classes behind, both deliberately:
    //
    //  - `cancel_failed`: the cancellation could not be CONFIRMED, so the order
    //    may still be resting on the exchange;
    //  - entry 57's gate refused to close the local record, because the venue
    //    reported more filled than this bot had recorded.
    //
    // THE FIRST CLASS IS WHY THIS IS A REFUSAL AND NOT A WARNING, and it is
    // worse here than on a close. `exitOrderId` above catches a live EXIT, but a
    // grid LADDER sell is not an exit order and that guard never sees it. So an
    // unconfirmed ladder sell for part of this position would still be resting
    // while this method sizes a fresh sell from the WHOLE of it. Both filling
    // sells more base than the bot holds -- real coin, sold twice, on a bot the
    // operator was trying to get flat.
    //
    // READING THE RESIDUAL LIST, not re-querying the venue, for the reason entry
    // 64 set out: `#cancelOpenOrders` has already done the local-versus-remote
    // comparison and removed everything it resolved, so the residue IS that
    // comparison's outcome. Asking again would be a second, independently
    // worded comparison of the same two quantities -- the drift entries 57 and
    // 61 both went out of their way not to introduce.
    //
    // BEFORE THE LADDER CLEAR BELOW, which is one step earlier than entry 64's
    // equivalent sits. There is no capital to release here, so the point of no
    // return is `#placeLiquidationSell`; refusing before the clear means this
    // pass has mutated NOTHING of its own, and the sweep's own writes are its
    // legitimate work either way. Recoverable exactly as a refused close is:
    // resolve the order, then call again.
    if (state.openOrderIds.length > 0) {
      throw new BotInstanceError(
        "orders_unresolved",
        `bot ${config.botInstanceId} cannot be liquidated: its cancel sweep could not resolve ` +
          `${state.openOrderIds.length} order(s) (${state.openOrderIds.join(", ")}). Either the ` +
          `exchange reported more filled than this bot recorded, or the cancellation could not ` +
          `be confirmed and the order may still be live. Selling now would place a liquidation ` +
          `sell for the WHOLE held position beside an order that may already be selling part of ` +
          `it, so both filling would dispose of more base than this bot holds. The bot stays ` +
          `halted and is still polled, so resolve them first: cancel the order, or let the 30s ` +
          `poll fold the outstanding fill, then liquidate again. Nothing was sold and nothing ` +
          `was changed.`,
      );
    }

    if (config.strategy === "grid") {
      const cleared: GridLadder = { ...state.ladder!, slots: state.ladder!.slots.map(() => null) };
      state = await this.#mutateState((current) => ({ ...current, ladder: cleared }));
    }

    // THE SECOND READ, and the one every number below is taken from. The first
    // was several awaits ago: `#cancelOpenOrders` is N network cancellations,
    // deliberately throttled, and `#outsidePoll` is a COUNTER rather than a
    // lock -- it delays no one. An `onFill` RPC or an alarm delivered into that
    // window folds a fill and moves the held position, and sizing the sell from
    // the pre-sweep snapshot would sell a quantity this bot no longer holds.
    const heldQuantity = this.#heldQuantityOf(config, state);

    if (heldQuantity <= ZERO) {
      // Flat between the two reads. The same receipt as the early return, for
      // the same condition read one moment later -- a fill that landed during
      // the sweep took the position to zero, and there is nothing left to sell.
      await this.#alert(config, {
        severity: "info",
        category: "trading",
        alertType: "liquidation_noop",
        message:
          "liquidatePosition was called but the position went flat while its cancel sweep ran; " +
          "nothing to sell",
        resolved: true,
      });
      return { status: "halted", action: "nothing_to_liquidate" };
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
   * What this bot actually holds, whichever strategy is holding it.
   *
   * One definition rather than the ternary written out at each read, because
   * `#liquidatePositionPass` now reads it TWICE -- once to refuse cheaply on a
   * flat bot, once after the cancel sweep to size the sell -- and two copies of
   * a strategy switch are two places for the grid and DCA branches to drift.
   * Takes the state as an argument rather than reading it, so the caller
   * controls WHICH read it is measuring; that is the whole point of there being
   * two.
   */
  #heldQuantityOf(config: BotConfigBase, state: BotRuntimeState): Money {
    return config.strategy === "grid" ? state.ladder!.heldQuantity : state.position.quantity;
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
    return await this.#outsidePoll(() => this.#closePass(actor));
  }

  async #closePass(actor: string): Promise<PipelineResult> {
    const config = await this.#config();
    const state = await this.#state();
    const now = this.#now();

    if (state.status !== "stopped") {
      await this.#cancelOpenOrders(config, state);

      // REFUSE RATHER THAN WIPE, and the write below is why it has to be a
      // refusal rather than the retention step 57 uses on the halt path.
      //
      // `#cancelOpenOrders` removes from `openOrderIds` every id this sweep
      // RESOLVED. Whatever is still on the list afterwards is there for one of
      // exactly two reasons, and both are reasons not to stop watching it:
      //
      //  - step 57's gate refused to close the local record, because the
      //    exchange reported more filled than this bot had recorded. Real base
      //    was bought or sold that this bot has not attributed.
      //  - the cancellation could not be CONFIRMED (`cancel_failed`), so the
      //    order may still be live on the exchange.
      //
      // The list is read rather than re-derived deliberately: `#cancelOpenOrders`
      // has already done the local-versus-remote comparison, and asking the
      // venue a second time here would be a second, independently-worded
      // comparison of the same two quantities -- the drift steps 57 and 61 both
      // went out of their way not to introduce.
      //
      // WHY NOT SIMPLY KEEP THE IDS, as the halt path does. Because on a halt
      // the bot stays observable and the retention hands the order to the poll,
      // which repairs it. After a close there is no one to hand it to:
      // `#pollArmed` excludes `stopped` outright, `checkOpenOrders` refuses a
      // stopped bot, `applyMissedFills` and `repairPosition` both require
      // `halted`, and reconciliation's `RECONCILED_STATUSES` is
      // `created`/`running`/`halted` -- it never looks at a stopped bot at all.
      // Retaining an id here would change nothing whatsoever; it would be a fix
      // in appearance only. So the choice is refuse or lose it, and refusing is
      // recoverable: cancel the order, or let the poll fold the fill, then close
      // again.
      //
      // BEFORE `releaseBotCapital`, which is the point of no return -- it flips
      // the row to `stopped` and returns the allocation. Refusing after it would
      // leave a half-closed bot, which is exactly what this is protecting
      // against.
      const swept = await this.#state();
      if (swept.openOrderIds.length > 0) {
        throw new BotInstanceError(
          "orders_unresolved",
          `bot ${config.botInstanceId} cannot be closed: its cancel sweep could not resolve ` +
            `${swept.openOrderIds.length} order(s) (${swept.openOrderIds.join(", ")}). Either the ` +
            `exchange reported more filled than this bot recorded, or the cancellation could not ` +
            `be confirmed and the order may still be live. Closing would release this bot's ` +
            `capital and mark it stopped, after which NOTHING observes it -- no poll, no ` +
            `reconciliation pass, no repair -- so whatever those orders are still carrying would ` +
            `be lost silently. Resolve them first: cancel the order, or let the 30s poll fold the ` +
            `outstanding fill, then close again. Nothing was released and nothing was changed.`,
        );
      }
    }

    // Step 5 owns this: it flips the row to `stopped` conditionally, inspects
    // the changes count, and only then releases the reservation.
    //
    // `bot_already_stopped` IS TOLERATED HERE, SPECIFICALLY, AND ONLY IT.
    //
    // That error means the `bot_instances` row is ALREADY `stopped` -- the
    // conditional update matched nothing. It is the ledger's mutual exclusion
    // against a double release doing precisely its job, and the capital
    // question is therefore already settled correctly: it was released once,
    // and it is not being released again. What is NOT settled is everything
    // below, and a previous close that threw partway through cleanup is one of
    // the two ways to arrive here. Rethrowing would guarantee that such a bot
    // can never finish closing, because every retry would die on the same line
    // before reaching the steps that were skipped.
    //
    // So this is the close-path counterpart of `#halt`'s re-halt self-heal: the
    // retry is what completes the cleanup. Both make an operator's obvious
    // corrective action -- do it again -- actually corrective.
    //
    // NARROW ON PURPOSE. `release_exceeds_allocated` means the ledger and the
    // bot rows disagree about real money and must NOT be swallowed;
    // `unknown_bot_instance` means the row is gone; `allocation_conflict` means
    // the write lost its race and the release genuinely has not happened. Each
    // still propagates untouched. Only the "already done" case continues.
    //
    // ⚠ THIS CHANGES AN API CONTRACT. A second `POST /bots/:id/close` now
    // returns 200 with `action: "already_stopped"` instead of 409
    // `bot_already_stopped`. See `closeBot` in `/src/api/handlers.ts`, whose
    // failure list is updated to match, and the decision-log entry for this
    // change.
    let alreadyStopped = false;
    try {
      await releaseBotCapital(this.#db(), config.botInstanceId, { actor, now });
    } catch (error) {
      if (!(error instanceof CapitalError) || error.code !== "bot_already_stopped") throw error;
      alreadyStopped = true;
    }

    const latest = await this.#state();

    // EVERY STEP BELOW IS INDEPENDENTLY BEST-EFFORT (see `#cleanupStep`), for
    // the same reason as on the halt path: the release above is the point of no
    // return, and everything after it is tidying up after a close that HAS
    // happened. On this path that matters more, not less -- a stopped bot is
    // observed by nothing at all (no poll, no reconciliation), so a cleanup step
    // skipped here is skipped permanently unless a human closes it again.
    const stateFailed = await this.#cleanupStep(config, "stopped_state_write", async () => {
      await this.#mutateState((current) => ({ ...current, status: "stopped", openOrderIds: [] }));
    });

    // THE SECOND TRIGGER FOR AN OLD LIFECYCLE (step 65), and the reason it needs
    // one. `resolveHaltAlerts` has always had exactly one caller -- `#resumePass`
    // -- because a halt alert describes a condition that resuming ends. But a
    // bot can also leave `halted` by being CLOSED, and that exit had no
    // counterpart: `resume()` requires `halted`, a stopped bot can never be
    // resumed, and nothing else in this system closes a `halt_*` row. So a bot
    // halted and then closed left its critical standing open FOREVER -- not
    // stale-until-someone-looks, but permanently unresolvable by any code path
    // that exists. Two real testnet bots are in exactly that state.
    //
    // Closing is the stronger claim of the two, which is why it belongs here: a
    // resumed bot might halt again for the same reason, while a stopped bot is
    // TERMINAL. Its halt is definitively over.
    //
    // TIED TO STATUS, NOT TO `archived`, deliberately. Archiving is a visibility
    // flag -- it hides a row from a list and can be undone by `unarchiveBot`,
    // which would leave the alerts closed and the bot back on screen. `stopped`
    // is the irreversible one, and it is the one that makes the halt past tense.
    //
    // THE SCOPE IS `resolveHaltAlerts`' OWN, reused rather than widened, and the
    // narrowness is the safety argument. It closes `halt_*` rows under this
    // object's own source and nothing else, so the exclusions its header spells
    // out hold here unchanged. That distinction matters more on this path than
    // on resume: a `halt_*` row on a stopped bot is STALE -- it describes a state
    // that is over. An `order_state_drift` or `unattributable_fill` row on the
    // same bot is UNRESOLVED -- it describes base that really moved and was
    // really never attributed, and that stays true forever. Closing the first
    // kind is bookkeeping; closing the second would be asserting a discrepancy
    // went away when nothing made it go away.
    //
    // AFTER the status write, for the same reason `#resumePass` puts it after
    // its own: everything above can refuse the close -- step 64's unresolved-
    // order gate, `releaseBotCapital`'s own guard -- and a bot that did NOT
    // close must keep its halt alert open.
    let resolvedAlertIds: string[] = [];
    const resolveFailed = await this.#cleanupStep(config, "resolve_halt_alerts", async () => {
      resolvedAlertIds = await resolveHaltAlerts(this.#db(), {
        source: BOT_ALERT_SOURCE,
        botInstanceId: config.botInstanceId,
      });
    });

    // The audit row is written whether or not the resolve above succeeded, and
    // it reports what was ACTUALLY resolved -- an empty list when the resolve
    // failed, never a guess. The `cleanup_step_failed` alert names that failure
    // separately; an audit entry claiming ids it did not close would be worse
    // than one that closed none.
    const auditFailed = await this.#cleanupStep(config, "close_audit", () =>
      this.#audit(
        config,
        "bot.closed",
        actor,
        {
          cycles_completed: latest.cycleCount,
          // Recorded in the EXISTING close entry rather than as a second audit
          // action, matching `bot.resumed`'s `resolved_halt_alert_ids`. One event
          // closed these rows; one row should say so.
          resolved_halt_alert_ids: resolvedAlertIds,
        },
        now,
      ),
    );

    // Closing can go running -> stopped directly (bypassing #halt), so this is a
    // genuine "leaving running" point. Best-effort, like the halt path; a bot
    // closed from `created` (never subscribed) unsubscribes as a harmless no-op.
    const unsubscribeFailed = await this.#cleanupStep(config, "unsubscribe_from_feed", () =>
      this.#unsubscribeFromFeed(config),
    );

    // `already_stopped` rather than `closed` when the ledger had nothing left to
    // release: the caller asked for a close and got one, but the capital moved
    // on an earlier call and this pass only finished the cleanup. Reporting
    // `closed` would tell an operator a release happened just now that did not.
    const incomplete = this.#cleanupDetail([
      stateFailed,
      resolveFailed,
      auditFailed,
      unsubscribeFailed,
    ]);
    return {
      status: "stopped",
      action: alreadyStopped ? "already_stopped" : "closed",
      ...(incomplete === undefined ? {} : { detail: incomplete }),
    };
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
    // SPEC 22.4 TOUCHPOINT 8. Binary until now, with "not grid" meaning DCA --
    // which would have validated a trailing-stop config against DCA's schema
    // version. No compile error was possible: `schemaVersion` is a `number` on
    // every strategy's config, so both arms type-check for all three.
    if (config.strategy === "grid") {
      assertReadableGridSchema(config.schemaVersion);
    } else if (config.strategy === "trailing_stop") {
      assertReadableTrailingStopSchema(config.schemaVersion);
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

    await this.#mutateState((current) => ({ ...current, filters: outcome.value }));
    return outcome.value;
  }

  async #placeBuy(
    // WIDENED FOR THE THIRD STRATEGY. Every field this method reads --
    // `allocatedCapital`, `pair`, `botInstanceId` -- is on `BotConfigBase`; it
    // never touched `params`. Trailing stop's single entry is the same
    // quote-denominated buy, so it reuses this rather than growing a copy.
    //
    // ⚠ WHAT THE WIDENING DID NOT CARRY, AND WHAT THAT COST (spec 22.10). This
    // method prices a buy AT `price`, where a maker order rests until the market
    // comes to it. DCA and grid pass the last trade price and want exactly that.
    // A trailing stop passed the same price and did NOT want it: its one entry
    // must fill before the strategy can begin, and a resting buy filled none of
    // ten attempts on the first live bot. Trailing stop now reaches this through
    // `#placeTrailingStopEntry`, which crosses the price first and counts the
    // attempt. NOTHING here changed -- the maker behaviour below is DCA's and
    // grid's, is still correct for them, and must stay the default.
    config: BotConfigBase,
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
    const sequence = await this.#allocateSequence();

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

    // The point of no return. See `#statusChangedFrom`: everything above this
    // line decided that a buy should exist; below it, one does.
    const abandoned = await this.#statusChangedFrom("running");
    if (abandoned !== null) {
      await guard.markFailed(
        decision.clientOrderId,
        `the bot became ${abandoned} before the ${label} buy was sent`,
        now,
      );
      return {
        status: abandoned,
        action: "aborted",
        detail: `${label} buy abandoned: the bot became ${abandoned} while it was being prepared`,
      };
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
    // APPENDED TO THE CURRENT LIST, not to the one read before `placeOrder`.
    // The old form re-read state for every other field but built `openOrderIds`
    // from the pre-send snapshot, so a poll that removed a filled order while
    // this was in flight had that removal undone -- and a `filled` order put
    // back into `openOrderIds` is unrecoverable: `#foldTerminalState` refuses a
    // terminal order, so it is re-read on every pass forever, the alarm never
    // disarms, and `hasOpenOrder` stays true so `decide` can never return
    // `open_base` or `additional_buy` again. A permanently wedged bot.
    await this.#mutateState((current) => ({
      ...current,
      openOrderIds: [...current.openOrderIds, decision.clientOrderId],
    }));
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

    const sequence = await this.#allocateSequence();

    const guard = this.#guard(config.botInstanceId);
    const decision = await guard.beginAttempt(sequence, now);
    if (decision.action === "recover") {
      return { status: "running", action: "recover", detail: decision.reason };
    }

    // The point of no return. A take-profit exit is still a decision taken
    // while running: if the bot halted meanwhile, the halt has already
    // cancelled and a liquidation is the human's call, not this path's.
    const abandoned = await this.#statusChangedFrom("running");
    if (abandoned !== null) {
      await guard.markFailed(
        decision.clientOrderId,
        `the bot became ${abandoned} before the take-profit sell was sent`,
        now,
      );
      return {
        status: abandoned,
        action: "aborted",
        detail: `take-profit sell abandoned: the bot became ${abandoned} while it was being prepared`,
      };
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
    // APPENDED rather than assigned. `openOrderIds: [exitId]` discarded
    // anything `#cancelOpenOrders` had just left open -- an order whose
    // cancellation could not be confirmed is still live on the exchange, and
    // dropping it here stopped it being polled or cancelled ever again, on the
    // one path where the bot is trying to get flat. That was reachable without
    // any concurrency at all: one failed cancel was enough.
    await this.#mutateState((current) => ({
      ...current,
      openOrderIds: [...current.openOrderIds, decision.clientOrderId],
      exitOrderId: decision.clientOrderId,
      exitKind: "take_profit",
    }));
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
    // SPEC 22.9. The fill APPLICATION is genuinely shared -- a trailing stop is a
    // single-position strategy and folds a fill exactly as DCA does. What is not
    // shared is the completion tail below.
    config: DcaConfig | TrailingStopConfig,
    state: BotRuntimeState,
    order: TrackedOrder,
    fill: Fill,
  ): Promise<PipelineResult> {
    const effect = applyFill(order, fill);
    await this.#putOrder(effect.order);

    const isExit = state.exitOrderId === order.clientOrderId;

    // Accumulated across the mutate below so the completion paths can REPORT
    // what this fill realized without re-deriving it.
    let realized = ZERO;

    // Both changes are DELTAS ON CURRENT STATE, not fields of a rebuilt
    // snapshot. `{ ...state, position }` would write back every other field as
    // this caller saw it, and the callers reach here holding a `state` read
    // before an exchange call -- so a poll folding a fill could revert a halt
    // that landed while it was reading, or `close()`'s `stopped`.
    const next = await this.#mutateState((current) => {
      let updated = current;

      if (!isExit) {
        // Section 6.3 step 3: recalculate the average entry on every entry. The
        // cost is what was actually executed (price x quantity of this fill),
        // not what was requested.
        const cost = -effect.quoteDelta;
        updated = {
          ...updated,
          position: applyEntry(
            updated.position,
            {
              clientOrderId: order.clientOrderId,
              price: fill.price,
              quantity: fill.quantity,
              cost,
              at: fill.executedAt,
            },
            updated.position.quantity > ZERO,
          ),
        };
      } else {
        // THE INVERSE, AND IT RUNS ON EVERY EXIT FILL -- partial, final, or one
        // that a cancellation is about to end. This branch used to be absent
        // entirely: an exit fill moved the ORDER and left the POSITION alone, so
        // a position was only ever corrected wholesale by `#completeCycle` on a
        // FULLY filled exit, and an exit that stopped short left the bot
        // counting coin it had already sold. Section 5.3 requires the position
        // to move incrementally on each partial fill; the entry side always did,
        // and this is the exit side finally doing the same.
        //
        // `effect.quoteDelta` is positive on a sell and is the notional at the
        // price the fill ACTUALLY executed at, which is exactly the proceeds
        // figure the accounting wants -- so nothing is re-derived here.
        const exited = applyExit(updated.position, {
          quantity: fill.quantity,
          proceeds: effect.quoteDelta,
        });
        realized += exited.realized;
        updated = {
          ...updated,
          position: exited.position,
          // BOOKED HERE, PER FILL, and it has to be: the cost basis that backed
          // this quantity leaves the position in the same step, so a realization
          // deferred to cycle completion would have nothing left to measure
          // against. It also means a cycle that never completes -- the exit
          // cancelled part-filled -- still books what it actually earned,
          // which is the case that had no home at all before.
          realizedGross: updated.realizedGross + exited.realized,
        };
      }

      if (effect.fullyFilled) {
        updated = {
          ...updated,
          openOrderIds: updated.openOrderIds.filter((id) => id !== order.clientOrderId),
        };
      }

      return updated;
    });

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
      // SPEC 22.9. Terminal by construction: one entry, one exit, no cycle to
      // complete and no `autoRestart` to consult.
      if (state.exitKind === "trailing_stop") {
        if (config.strategy !== "trailing_stop") {
          throw new Error(
            `bot ${config.botInstanceId} is a ${config.strategy} bot carrying exitKind ` +
              `"trailing_stop"; only a trailing-stop bot exits that way (spec 22.9).`,
          );
        }
        return await this.#completeTrailingStopExit(config, effect.order, fill);
      }
      // Everything else is DCA's cycle completion. The narrowing is asserted
      // rather than assumed: a trailing-stop bot reaching here would mean its
      // exit was recorded with the wrong `exitKind`, which is a bug to surface
      // and not to absorb into a strategy's completion path.
      if (config.strategy !== "dca") {
        throw new Error(
          `bot ${config.botInstanceId} is a ${config.strategy} bot whose exit reached DCA's ` +
            `cycle completion with exitKind ${JSON.stringify(state.exitKind)}; only a dca bot ` +
            `completes a cycle (spec 22.9).`,
        );
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
    // NO LONGER THE PLACE THE PROFIT IS BOOKED. `applyExit` realizes each exit
    // fill as it lands -- it has to, because the cost basis backing that
    // quantity leaves the position in the same step -- so `realizedGross` is
    // already complete by the time this runs, and adding a cycle total here
    // would count the whole exit twice.
    //
    // What is left for this method is CLEANUP and REPORTING. The position it
    // zeroes has USUALLY been reduced to ZERO by the final fill's `applyExit`,
    // so `EMPTY_POSITION` mostly just clears `entries`, `additionalBuysUsed` and
    // `lastEntryPrice` rather than performing the decrement itself.
    //
    // USUALLY, NOT ALWAYS, and the gap is real base. An exit is sized by rounding
    // `position.quantity` DOWN onto the symbol's step, and base acquired after
    // it was sized is not in it at all -- so what `applyExit` removed can be less
    // than what the position held. That remainder used to be discarded here in
    // silence. It is now accumulated into `unmodelledBase`, which documents both
    // shapes and why this is where they are caught.
    //
    // The reported figure is derived from the exit's OWN fills against the cost
    // that ACTUALLY BACKED THEM -- the cycle's total entry cost less the basis
    // still sitting against any remainder -- so the audit and the alert say what
    // this cycle earned, without re-deriving it, re-booking it, or expensing
    // coin the bot still owns.
    const proceeds = exit.fills.reduce(
      (total, each) => total + mul(each.price, each.quantity, "half-even"),
      ZERO,
    );

    // CAPTURED FROM INSIDE THE MUTATION, not from the `state` read above. Both
    // figures are properties of the position at the instant it is cleared, and
    // this write is the thing clearing it -- reading them from a snapshot taken
    // before the audit and alert below (each a D1 write, and therefore a
    // re-entry point) would report a position a concurrent pass had since moved.
    let stranded = ZERO;
    let spent = ZERO;
    let entryCount = 0;

    const completed = await this.#mutateState((current) => {
      // WHAT THE EXIT DID NOT SELL. `applyExit` has decremented the position on
      // every fill of this exit, so whatever is left is precisely the base this
      // cycle bought and did not dispose of -- see `unmodelledBase`. Zeroing the
      // position on top of it, which is what this method has always done, is
      // correct; DISCARDING it was not. Accumulated rather than dropped, and
      // deliberately not folded into `position`, `realizedGross` or the
      // allocation: it is base the bot owns and no longer trades.
      stranded = current.position.quantity;
      // NET OF THE COST BASIS THAT STAYED BEHIND. `entries` sums to what the
      // cycle SPENT in total, and while a clean exit leaves `position.cost` at
      // exactly ZERO -- `applyExit`'s remainder form guarantees that -- an exit
      // that stranded base leaves the basis backing it still sitting there. The
      // bare `entries` sum therefore expensed coin the cycle still owns, which
      // understated `gross_profit` by that basis and put the audited figure
      // permanently at odds with `realizedGross`, which only ever charged the
      // basis that actually left. Subtracting the retained basis is a no-op on
      // the ordinary path (it is ZERO) and makes the two agree on the other.
      spent = current.position.entries.reduce((total, each) => total + each.cost, ZERO) -
        current.position.cost;
      entryCount = current.position.entries.length;
      return {
        ...current,
        cycleCount: current.cycleCount + 1,
        unmodelledBase: (current.unmodelledBase ?? ZERO) + stranded,
        position: EMPTY_POSITION,
        openOrderIds: [],
        exitOrderId: null,
        exitKind: undefined,
      };
    });
    const gross = proceeds - spent;
    await this.#audit(
      config,
      "bot.cycle_completed",
      "system",
      {
        cycle: completed.cycleCount,
        gross_profit: toDecimalString(gross),
        entries: entryCount,
        // Unconditional, so "this cycle stranded nothing" is a recorded fact
        // rather than an absent key that could equally mean an older deploy.
        unmodelled_base: toDecimalString(stranded),
        unmodelled_base_total: toDecimalString(completed.unmodelledBase ?? ZERO),
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
      // A receipt: this cycle is closed. Deliberately NOT the same thing as the
      // `halt_take_profit_reached` row a non-auto-restarting bot also gets --
      // that one describes a bot sitting halted awaiting review, which resume or
      // close legitimately ends.
      resolved: true,
    });
    if (stranded > ZERO) {
      // SEPARATE FROM THE TAKE-PROFIT ALERT ABOVE, which is an `info` the
      // operator is expected to skim. This one says the account holds base the
      // bot has stopped modelling, which is a fact about the OPERATOR's
      // holdings and needs a decision from them -- sweep it by hand, or accept
      // it. Nothing here will ever trade it.
      await this.#alert(config, {
        severity: "warning",
        category: "trading",
        alertType: "cycle_unmodelled_base",
        message:
          `cycle ${completed.cycleCount} sold ${toDecimalString(exit.filledQuantity)} but held ` +
          `${toDecimalString(stranded)} more, which the exit could not be sized to include. ` +
          `That base is still in the account and this bot no longer counts it; it will not be ` +
          `traded. ${toDecimalString(completed.unmodelledBase ?? ZERO)} has accumulated this way ` +
          `across ${completed.cycleCount} cycle(s).`,
      });
    }

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
  async #completeLiquidation(config: BotConfigBase, exit: TrackedOrder, fill: Fill): Promise<PipelineResult> {
    // As in `#completeCycle`: `applyExit` has already realized every fill of
    // this liquidation as it landed, so this reports the total rather than
    // booking it a second time.
    const proceeds = exit.fills.reduce(
      (total, each) => total + mul(each.price, each.quantity, "half-even"),
      ZERO,
    );

    // THE SAME LEAK ON THE SAME SHAPE, and it is fixed the same way rather than
    // left for later. `#placeLiquidationSell` sizes through the identical
    // `validateOrder(..., { rounding: "adjust" })`, and this method clears the
    // position identically. A liquidation is a human getting a halted bot flat,
    // so base it could not be sized to include is exactly the thing that human
    // needs told about. See `unmodelledBase`.
    let stranded = ZERO;
    let spent = ZERO;

    const completed = await this.#mutateState((current) => {
      stranded = current.position.quantity;
      spent = current.position.entries.reduce((total, each) => total + each.cost, ZERO) -
        current.position.cost;
      return {
        ...current,
        unmodelledBase: (current.unmodelledBase ?? ZERO) + stranded,
        position: EMPTY_POSITION,
        openOrderIds: current.openOrderIds.filter((id) => id !== exit.clientOrderId),
        exitOrderId: null,
        exitKind: undefined,
      };
    });
    const gross = proceeds - spent;
    await this.#audit(
      config,
      "bot.liquidation_filled",
      "system",
      {
        gross_proceeds: toDecimalString(gross),
        quantity: toDecimalString(exit.filledQuantity),
        unmodelled_base: toDecimalString(stranded),
        unmodelled_base_total: toDecimalString(completed.unmodelledBase ?? ZERO),
      },
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
      // A receipt: the sell filled. That the bot stays halted is reported by its
      // own `halt_*` row, which has a real lifecycle; this one does not.
      resolved: true,
    });
    if (stranded > ZERO) {
      await this.#alert(config, {
        severity: "warning",
        category: "trading",
        alertType: "cycle_unmodelled_base",
        message:
          `the liquidation left ${toDecimalString(stranded)} of base it could not be sized to ` +
          `include. It is still in the account and this bot no longer counts it; it will not be ` +
          `traded. ${toDecimalString(completed.unmodelledBase ?? ZERO)} has accumulated this way.`,
      });
    }

    return { status: "halted", action: "liquidation_filled", detail: exit.clientOrderId };
  }

  /**
   * Step 2's decision 8 in practice: these codes describe races that genuinely
   * happen, and section 7.5's halt-on-exception would turn a redelivered queue
   * message into an emergency.
   */
  /**
   * The trailing stop's price pass (spec 22.4 touchpoint 10).
   *
   * Its OWN branch rather than DCA's. The shape is deliberately the same as the
   * DCA arm above -- pure `decide`, then an exhaustive switch -- so the two read
   * alike and neither grows behaviour the other lacks by accident.
   */
  async #trailingStopOnPrice(
    config: TrailingStopConfig,
    state: BotRuntimeState,
    price: Price,
  ): Promise<PipelineResult> {
    const action = trailingStopDecide({
      config,
      position: state.position,
      // READ, NOT RECOMPUTED. `#onPriceUpdatePass` has already ratcheted this on
      // the same write that recorded `lastPrice`, so `decide` sees the mark that
      // INCLUDES the current candle. Recomputing it here would be a second
      // implementation of the rule, free to disagree with the stored one.
      highWaterMark: state.highWaterMark,
      price: price.price,
      hasOpenOrder: state.openOrderIds.length > 0,
      // Spec 22.10. The ONE place the optional stored field is defaulted; the
      // rule itself takes a required number, so nothing else can forget it.
      entryAttempts: state.entryAttempts ?? 0,
    });

    switch (action.kind) {
      case "hold":
        return { status: "running", action: "hold" };

      case "open_entry":
        return await this.#placeTrailingStopEntry(config, action.quoteAmount, price);

      case "trailing_exit":
        return await this.#placeTrailingStopSell(config, action.quantity, action.trailLevel, price);

      case "halt":
        return await this.#halt(config, action.reason, action.detail, "system");
    }
  }

  /**
   * The trailing stop's SINGLE ENTRY, priced to fill instead of to rest
   * (spec 22.10).
   *
   * ⚠ WHY THIS IS NOT JUST `#placeBuy`, WHICH ITS OWN HEADER SAYS IT WIDENED
   * FOR. That widening was correct about the SHAPE of the order and wrong about
   * its PURPOSE, and the difference cost a live bot ten failed entries. Every
   * field `#placeBuy` reads really is on `BotConfigBase`, and a trailing-stop
   * entry really is the same quote-denominated buy -- so the reuse below is
   * kept, and this method is a thin shell around it. What `#placeBuy` also
   * carries, invisibly, is DCA's INTENT: it prices a buy at the last trade
   * price, where it rests as a maker order and waits for the market. A DCA
   * ladder wants that. A trailing stop cannot start until its one entry fills,
   * so it wants the opposite, and the two intents cannot both live in one
   * default. This method supplies the trailing stop's.
   *
   * ⚠ AND WHY IT IS A SHELL RATHER THAN A COPY. Everything below `#placeBuy`'s
   * price line -- the allocation guard, the sequence allocation, the idempotency
   * guard's `beginAttempt`/`markPlaced`, section 4.3's two independent
   * validations, the `#statusChangedFrom` point of no return, the four distinct
   * failure outcomes, the order record, the D1 mirror and the attached-fill
   * fold -- is transport and safety machinery that has nothing to do with which
   * strategy wanted the buy. A second copy of it would be a second place for
   * every one of those to drift, and the drifting copy would be the one on the
   * strategy nobody has run yet.
   *
   * So exactly two things change: the price is crossed rather than resting, and
   * the placement is counted.
   */
  async #placeTrailingStopEntry(
    config: TrailingStopConfig,
    quoteAmount: Money,
    price: Price,
  ): Promise<PipelineResult> {
    const state = await this.#state();
    // Read at ROUTINE priority, matching `#placeBuy`'s own read a moment later
    // (section 5.4: an entry must not spend the reserve an exit will need). The
    // tick size is needed HERE, before `#placeBuy` is called, because the
    // crossing price has to be aligned onto the grid in the crossing direction
    // -- see `entryLimitPrice` on why leaving that to `validateOrder` would
    // round the crossing back out again.
    const filters = await this.#ensureFilters(config, state, this.#now(), "routine");
    const limit = entryLimitPrice(price.price, ENTRY_CROSS_PCT, filters.tickSize);

    // The Price object is passed through with only its price replaced: `at` and
    // `pair` still describe the observation this entry is a response to, and
    // nothing downstream should think a different candle arrived.
    const result = await this.#placeBuy(config, quoteAmount, { ...price, price: limit }, "entry");

    // COUNTED ON WHAT REACHED THE EXCHANGE, not on every pass through here, and
    // the two members of this list are deliberate:
    //
    //  - `placed-entry` is an order now resting (or already filling) on the
    //    book. That is an attempt by any reading.
    //  - `unresolved` is a transport failure, where the order's fate is unknown
    //    and `#placeBuy` leaves the attempt open for recovery. It is counted
    //    because `openOrderIds` is NOT written on that path, so `hasOpenOrder`
    //    stays false and the next candle asks for the entry again -- an
    //    unbounded loop of its own, and the one an exchange that is failing
    //    consistently would produce.
    //
    // Everything else is excluded because nothing was sent and the condition
    // clears itself: `throttled` and `skipped` are backpressure and arithmetic,
    // `recover` means an earlier attempt is still being resolved (counting it
    // would count that attempt twice), and `aborted` means the bot left
    // `running` before the send.
    if (result.action === "placed-entry" || result.action === "unresolved") {
      await this.#mutateState((current) => ({
        ...current,
        entryAttempts: (current.entryAttempts ?? 0) + 1,
      }));
    }
    return result;
  }

  /**
   * Sell the whole position because the trail was crossed (spec 22.9).
   *
   * Marked `exitKind: "trailing_stop"` so the fill routes to
   * `#completeTrailingStopExit` and not to DCA's cycle completion. The order is
   * placed at the CURRENT price rather than at the trail level: the trail has
   * already been crossed, so the level is behind the market and quoting it would
   * be asking for a fill above where the book is.
   */
  async #placeTrailingStopSell(
    config: TrailingStopConfig,
    quantity: Money,
    trailLevel: Money,
    price: Price,
  ): Promise<PipelineResult> {
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
      // The position cannot be sold as a limit order at this size. That is a
      // risk exit that did not happen, so it halts rather than returning quietly.
      return await this.#halt(
        config,
        "order_rejected",
        `the trailing-stop exit of ${toDecimalString(quantity)} could not be constructed: ` +
          `${adjusted.reason}. The trail at ${toDecimalString(trailLevel)} was crossed and the ` +
          `position is still held.`,
        "system",
      );
    }

    const sequence = await this.#allocateSequence();
    const guard = this.#guard(config.botInstanceId);
    const decision = await guard.beginAttempt(sequence, now);
    if (decision.action === "recover") {
      return { status: "running", action: "recovering", detail: decision.clientOrderId };
    }

    const abandoned = await this.#statusChangedFrom("running");
    if (abandoned !== null) {
      await guard.markFailed(
        decision.clientOrderId,
        `the bot became ${abandoned} before the trailing-stop sell was sent`,
        now,
      );
      return { status: abandoned, action: "abandoned", detail: "status changed" };
    }

    const outcome = await this.#exchange(config, "risk-exit").placeOrder({
      pair: config.pair,
      clientOrderId: decision.clientOrderId,
      side: "sell",
      type: "limit",
      price: adjusted.price,
      quantity: adjusted.quantity,
    });
    if (!outcome.ok) {
      await guard.markFailed(decision.clientOrderId, outcome.message, now);
      return await this.#halt(
        config,
        "order_rejected",
        `the trailing-stop exit was refused by the exchange: ${outcome.message}`,
        "system",
      );
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
    await this.#mutateState((current) => ({
      ...current,
      exitOrderId: decision.clientOrderId,
      exitKind: "trailing_stop",
      openOrderIds: [...current.openOrderIds, decision.clientOrderId],
    }));
    await this.#mirrorOrderInsert(config, order, outcome.value.exchangeOrderId);

    for (const fill of outcome.value.fills) {
      await this.onFill(decision.clientOrderId, fill);
    }

    return { status: "running", action: "placed-trailing-exit", detail: decision.clientOrderId };
  }

  /**
   * The trailing-stop exit has fully filled (spec 22.9).
   *
   * Modelled on `#completeLiquidation`, NOT on `#completeCycle`, and that is the
   * whole of 22.9: there is no cycle to count and no `autoRestart` to consult,
   * so this cleans up and halts. `cycleCount` is deliberately NOT incremented --
   * a strategy with exactly one cycle by construction has no use for the counter,
   * and a `bot.cycle_completed` row would report a number with no referent.
   *
   * `unmodelledBase` IS accumulated, and that is not optional: exit sells are
   * sized by rounding the held quantity DOWN onto the symbol's step, so this
   * strands base exactly as decision log 69 found DCA's completion did. Skipping
   * it would reopen a closed leak in the one strategy with no later cycle
   * boundary at which anyone would notice.
   */
  async #completeTrailingStopExit(
    config: TrailingStopConfig,
    exit: TrackedOrder,
    fill: Fill,
  ): Promise<PipelineResult> {
    const proceeds = exit.fills.reduce(
      (total, each) => total + mul(each.price, each.quantity, "half-even"),
      ZERO,
    );

    let stranded = ZERO;
    let spent = ZERO;
    const completed = await this.#mutateState((current) => {
      stranded = current.position.quantity;
      spent = current.position.entries.reduce((total, each) => total + each.cost, ZERO) -
        current.position.cost;
      return {
        ...current,
        unmodelledBase: (current.unmodelledBase ?? ZERO) + stranded,
        position: EMPTY_POSITION,
        openOrderIds: current.openOrderIds.filter((id) => id !== exit.clientOrderId),
        exitOrderId: null,
        exitKind: undefined,
        // The mark belongs to the position that just closed. Left set, it would
        // be the starting high-water mark of a position this bot will never open
        // -- and would make 22.8's detector read a frozen trail on a flat bot.
        highWaterMark: undefined,
      };
    });
    const gross = proceeds - spent;

    await this.#audit(
      config,
      "bot.trailing_stop_exit",
      "system",
      {
        gross_profit: toDecimalString(gross),
        quantity: toDecimalString(exit.filledQuantity),
        unmodelled_base: toDecimalString(stranded),
        unmodelled_base_total: toDecimalString(completed.unmodelledBase ?? ZERO),
      },
      fill.executedAt,
    );

    if (stranded > ZERO) {
      await this.#alert(config, {
        severity: "warning",
        category: "trading",
        alertType: "cycle_unmodelled_base",
        message:
          `the trailing-stop exit sold ${toDecimalString(exit.filledQuantity)} but held ` +
          `${toDecimalString(stranded)} more, which the exit could not be sized to include. ` +
          `That base is still in the account and this bot no longer counts it.`,
      });
    }

    // The halt carries the receipt. `trailing_stop_reached` is in `#halt`'s
    // `positiveExit` list, so this alerts as `info` -- this is the strategy
    // working, not failing.
    return await this.#halt(
      config,
      "trailing_stop_reached",
      `the trail was crossed and the position exited at ${toDecimalString(exit.price)} for a ` +
        `gross ${toDecimalString(gross)} ${config.capitalAsset}`,
      "system",
    );
  }

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
    const action = gridDecide({
      config,
      ladder,
      price: price.price,
      outstanding: gridOutstanding(state),
    });

    switch (action.kind) {
      case "hold":
        return { status: "running", action: "hold" };
      case "place_initial_ladder": {
        const result = await this.#placeInitialLadder(config, action.orders);
        // THE ONLY SITE THAT OBSERVES THIS CONDITION, and deliberately so.
        //
        // The gate above fired, so at this instant the bot either had never
        // placed or had a dead ladder. `#reportLadderVacancy` re-reads what the
        // attempt actually achieved: rungs now resting closes any open incident,
        // a still-empty ladder opens one. Both halves of the standing lifecycle
        // in one owner, which `alerts/standing.ts` requires -- taking only the
        // raise half is strictly worse than an unconditional insert.
        //
        // NOT IN THE POLL, which is where `grid_replacement_queued`'s twin
        // lives. The poll is a repeated snapshot reader, and a legitimately
        // resumed bot is `running` with a vacant ladder until its first price
        // tick lands -- a correct, transient state a snapshot observer would
        // alert on every single healthy resume. Reached from here, the
        // condition is only ever evaluated AFTER a real price evaluation
        // declined to place, so that window does not exist.
        //
        // NOT ON THE `hold` PATH either: a healthy ladder cannot have raised
        // this, and calling the resolve half every tick for every grid bot
        // would put an `alerts` query on the hot path to close a row that is
        // never open.
        if (result.status === "running") await this.#reportLadderVacancy(config);
        return result;
      }
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
   *
   * AND ONLY IF SOMETHING WAS ACTUALLY PLACED. `initialLadderOrders` breaks at
   * the first level priced at or above spot, so a grid STARTED while spot sits
   * below its lowest line -- but above the stop-loss, which would otherwise have
   * exited it -- is handed an empty list. This used to run the loop zero times,
   * find `throttled` still false, and latch `placed: true` having placed
   * nothing: a bot advertising a ladder it had never built, in the one field
   * (`state.ladder.placed`, mirrored to the API) an operator reads to answer
   * that exact question.
   *
   * The trading consequence is separately covered -- a zero-order pass leaves
   * the ladder vacant and flat, which `vacantLadder` matches, so the bot
   * re-evaluates each tick and places the moment price rises into range. This
   * guard is about the flag telling the truth, and about the third exposure
   * staying closed if that condition is ever narrowed.
   *
   * IT REQUIRES `decide`'s REORDER TO SHIP WITH IT. While placement was the
   * FIRST gate, refusing to latch here meant a fresh bot below its stop-loss
   * re-entered this method on every tick with nothing to place and never reached
   * the stop-loss check at all. With the exits evaluated first, that bot halts.
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

    if (!throttled && orders.length > 0) {
      await this.#mutateState((latest) => ({
        ...latest,
        ladder: { ...latest.ladder!, placed: true },
      }));
    }
    return {
      status: "running",
      action: throttled ? "initial_ladder_partial" : "placed_initial_ladder",
      detail: `${orders.length} buy levels below spot`,
    };
  }

  /**
   * Raise or clear the standing incident for a running grid bot with a dead
   * ladder, from what a placement attempt ACTUALLY achieved.
   *
   * Called at exactly one site: immediately after `#placeInitialLadder` on the
   * price path. That timing is the whole design. `vacantLadder` normally lasts
   * microseconds -- the same tick that observes it rebuilds it -- so reaching
   * here with the ladder STILL vacant means the rebuild ran and put nothing on
   * the exchange. The reasons it can are all real and all worth a human's
   * attention:
   *
   *  - every order was throttled by section 5.4's budget;
   *  - every order was refused as unconstructible against the symbol filters;
   *  - the order list was EMPTY because spot sits below the lowest grid line,
   *    so the bot is genuinely idle until price comes back into range.
   *
   * The third is not a fault, which is why this is a `warning` and not a
   * `critical`: the bot is behaving correctly and has nothing to do. What makes
   * it worth stating is that from outside it is indistinguishable from the
   * defect this whole change exists to fix -- a running grid bot with an empty
   * ladder -- and an operator who has just been burned by that deserves to be
   * told which one they are looking at rather than left to infer it.
   *
   * BOTH HALVES, TOGETHER, ALWAYS. `alerts/standing.ts` is explicit that taking
   * only the raise half is worse than an unconditional insert: one row that
   * never clears suppresses every future alert of that type for that bot,
   * forever. So the recovering case resolves here rather than relying on some
   * other pass to notice.
   *
   * ── BEST-EFFORT, AND THIS METHOD THEREFORE NEVER THROWS ──
   *
   * A REAL INCIDENT, the night this was written. `raiseStandingAlert` reads
   * `alerts` from D1, and for a bot idle below its own range that read is the
   * ONLY D1 call in the entire price-update pass -- everything else the pass
   * touches (`#config`, `#state`, `#mutateState`) is `ctx.storage`. It sits
   * inside the `try` whose sole handler is `#haltOnUnexpected`. So when a
   * Cloudflare storage blip returned `D1_ERROR: D1 DB storage operation
   * exceeded timeout which caused object to be reset`, a healthy, correctly
   * idle grid bot was HALTED by the failure of the very alert whose only job
   * was to say "I am idle and this is fine".
   *
   * That is a severity inversion: an advisory status report must never have the
   * power to stop trading. So every failure here is swallowed and the pass
   * continues exactly as if the report had not been attempted. Nothing
   * downstream depends on it -- this is the terminal statement of the
   * `place_initial_ladder` branch, the `PipelineResult` was computed before it,
   * and this writes only to `alerts`: no DO storage, no ladder state, no
   * orders. Nothing is lost by skipping a tick either, because the vacancy gate
   * re-fires on EVERY tick while the condition holds, so the next minute tries
   * again.
   *
   * THE WHOLE BODY, not just the D1 line. `#state()` is a storage read that
   * cannot usefully halt a bot at this point -- the pass has already read it
   * successfully and already decided -- so narrowing the `catch` would only
   * leave a second way for a report to halt a bot it has no business halting.
   *
   * CAUGHT HERE AND NOT IN `standing.ts`, deliberately. `raiseStandingAlert`
   * and `resolveClearedStandingAlerts` are shared with `poll_blind`,
   * `poll_blind_escalated` and reconciliation's critical findings, and those
   * MUST keep failing loudly -- swallowing there would hide a bot that has gone
   * genuinely blind. The narrow fix is the call site, and only this call site.
   *
   * LOGGED, NOT ALERTED. An alert row is a D1 write, which is the thing that
   * just failed; raising one here would reintroduce exactly the risk this
   * `catch` exists to remove. `console.error` reaches Workers Logs
   * (`observability` is enabled) and cannot throw. The stack is included
   * because `#haltOnUnexpected` records only `name: message`, and its absence
   * is what made the original incident hard to place.
   */
  async #reportLadderVacancy(config: GridConfig): Promise<void> {
    try {
      const state = await this.#state();
      const ladder = state.ladder;
      if (ladder === undefined) return;

      if (!vacantLadder(ladder, gridOutstanding(state))) {
        // The rebuild worked (or the ladder was never the problem). Close any
        // incident this bot has open, and write nothing when there is none.
        await resolveClearedStandingAlerts(this.#db(), {
          source: BOT_ALERT_SOURCE,
          owns: (alertType) => alertType === LADDER_VACANT_ALERT_TYPE,
          stillOpen: new Set<string>(),
          observed: true,
          scope: { kind: "bot", botInstanceId: config.botInstanceId },
        });
        return;
      }

      await this.#raiseStanding(config, {
        severity: "warning",
        category: "trading",
        alertType: LADDER_VACANT_ALERT_TYPE,
        message:
          `grid bot ${config.botInstanceId} is running with an EMPTY ladder: every level is ` +
          `unoccupied, nothing is held, and nothing is outstanding. This pass tried to rebuild it ` +
          `and placed no orders -- either every order was throttled or unconstructible, or spot is ` +
          `below the lowest grid line so there is nothing to place yet. The bot is watching price ` +
          `and will place the moment that changes; until then it is not trading.`,
      });
    } catch (error) {
      console.error("grid_ladder_vacant reporting failed; the bot is unaffected", {
        botInstanceId: config.botInstanceId,
        error,
        stack: error instanceof Error ? error.stack : undefined,
      });
    }
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
   *
   * THE LEVEL IS CHECKED BEFORE ANYTHING IS SENT. A replacement can target a
   * level whose own order is still live (see `pendingReplacements`), and the
   * cheapest correct answer is to notice that before an order exists on the
   * exchange rather than after. `slot_occupied` is returned so the caller can
   * queue the intent; nothing has been sent and no id has been burned.
   */
  async #placeGridOrder(
    config: GridConfig,
    intent: GridOrderIntent,
    limitPrice: Money,
    priority: RequestPriority,
    /**
     * Whether an unconstructible order writes its own alert row.
     *
     * FALSE FOR THE DRAIN, and only for the drain. `order_not_constructible` is
     * an unconditional insert, which is right for a first attempt -- a discrete
     * event, one row. The queue now RETAINS an intent until it actually places,
     * so a replacement that is unconstructible for a lasting reason (dust under
     * the venue's minimum, most often) is re-attempted on every poll and after
     * every fold, and an unconditional insert there is step 18's measured
     * alert-flood at one row per attempt forever.
     *
     * Nothing is lost by silencing the retries: the first attempt already wrote
     * the row naming the reason, and the ONGOING condition is carried by
     * `grid_replacement_queued`, a standing alert that states itself once and
     * stays open while the queue is non-empty. The event and the condition are
     * reported by the mechanism suited to each.
     */
    alertOnUnconstructible = true,
  ): Promise<PipelineResult> {
    let state = await this.#state();
    const now = this.#now();

    // BEFORE the filter read and before the exchange call. A level occupied by
    // a live order is not a transient condition this pass can wait out -- the
    // occupant clears it when its own fill is folded -- so there is no reason
    // to spend a network round trip discovering it.
    const occupant = state.ladder?.slots[intent.levelIndex] ?? null;
    if (occupant !== null) {
      return {
        status: state.status,
        action: "slot_occupied",
        detail:
          `${intent.side} at grid level ${intent.levelIndex} not sent: the level still holds ` +
          `${occupant.side} ${occupant.clientOrderId}`,
      };
    }

    const filters = await this.#ensureFilters(config, state, now, priority);
    state = await this.#state();

    const adjusted = validateOrder(
      { pair: config.pair, side: intent.side, price: limitPrice, quantity: intent.quantity },
      filters,
      { rounding: "adjust" },
    );
    if (!adjusted.valid) {
      if (alertOnUnconstructible) {
        await this.#alert(config, {
          severity: "warning",
          category: "trading",
          alertType: "order_not_constructible",
          message: `${intent.side} at grid level ${intent.levelIndex} skipped: ${adjusted.reason}`,
        });
      }
      return { status: "running", action: "skipped", detail: adjusted.code };
    }

    const sequence = await this.#allocateSequence();

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

    // The point of no return, and the check that makes step 19's
    // `placeReplacement: fresh.status === "running"` true at the moment it
    // matters rather than several awaits earlier. See `#statusChangedFrom`.
    const abandoned = await this.#statusChangedFrom("running");
    if (abandoned !== null) {
      await guard.markFailed(
        decision.clientOrderId,
        `the bot became ${abandoned} before the ${intent.side} at level ` +
          `${intent.levelIndex} was sent`,
        now,
      );
      return {
        status: abandoned,
        action: "aborted",
        detail:
          `${intent.side} at grid level ${intent.levelIndex} abandoned: the bot became ` +
          `${abandoned} while it was being prepared`,
      };
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
      // The order's own copy of where it belongs on the ladder, so a fill
      // against it stays attributable even if its slot is taken. See
      // `TrackedOrder.levelIndex` for why this is not derived from the slots.
      levelIndex: intent.levelIndex,
      costBasis: intent.costBasis,
    });
    await this.#putOrder(order);

    const slot: GridSlot = {
      side: intent.side,
      clientOrderId: decision.clientOrderId,
      costBasis: intent.costBasis,
      quantity: adjusted.quantity,
    };
    // THE RACE THE PRE-SEND CHECK CANNOT CLOSE. Everything between that check
    // and here is awaited -- the filter read, the attempt record, the exchange
    // call -- and this object accepts a price tick, an alarm or a second
    // `onFill` into exactly those windows (see `#outsidePoll`). So the level
    // may have been taken while this order was in flight.
    //
    // The order is REAL by now: it is resting on the exchange. There is no
    // version of this where refusing the slot is safe, because for a grid
    // `openOrderIds` is derived from the slots -- an order with no slot is
    // never polled and never cancelled, which is how it would leak. So the
    // write wins, and the eviction is made LOUD instead of silent. The evicted
    // order carries its own `levelIndex` and `costBasis`, so its fill is still
    // attributable when it arrives.
    let evicted: GridSlot | null = null;
    await this.#mutateState((current) => {
      const claim = claimSlot(current.ladder!, intent.levelIndex, slot);
      const ladder =
        claim.kind === "claimed"
          ? claim.ladder
          : ((evicted = claim.by), withSlot(current.ladder!, intent.levelIndex, slot));
      // MAINTAINED, NOT RE-DERIVED -- the same rule `#applyGridFillToOrder` now
      // uses, for the same reason, on the other write that used to assign this
      // list from the ladder. See the long note there: an id with no rung is not
      // an id that ended, and after a `#gridExit` whose cancel sweep failed the
      // retained ones have no rung by construction.
      //
      // THIS SITE IS REACHABLE WHILE RUNNING, which is what makes it the more
      // dangerous of the two. A placement requires `running` -- `#placeGridOrder`
      // aborts at its point of no return otherwise -- so it cannot be reached
      // while a liquidation sell rests on a halted bot. But `#resumePass` never
      // clears `openOrderIds`, and its drift latch reads
      // `ORDER_STATE_DRIFT_ALERT_TYPES`, which contains neither `cancel_failed`
      // nor `cancel_fill_discrepancy`. So a bot that exited with orders it could
      // not resolve can be resumed carrying them, and the next replacement it
      // placed dropped every one -- silently, while actively trading.
      //
      // THE EVICTION STILL DROPS ITS ID, deliberately and unchanged. That is not
      // this list losing track of something; it is the documented outcome of a
      // slot collision, which `grid_slot_collision` below states in as many
      // words. Resolved BY NAME, from the claim itself rather than from the
      // outer `evicted` binding, so a retried mutation cannot read a previous
      // attempt's value.
      //
      // BYTE-IDENTICAL ON THE ORDINARY PATH: the placed order is in `ladder`, so
      // it is in `slotIds`; on a healthy running bot every other tracked id is
      // slot-backed too, `retained` is empty, and this writes exactly the ids in
      // exactly the level order it always did.
      const displaced = claim.kind === "occupied" ? claim.by.clientOrderId : null;
      const slotIds = ladderOpenOrderIds(ladder);
      const retained = current.openOrderIds.filter(
        (id) => id !== displaced && !slotIds.includes(id),
      );
      return { ...current, ladder, openOrderIds: [...slotIds, ...retained] };
    });
    if (evicted !== null) {
      const lost = evicted as GridSlot;
      await this.#alert(config, {
        severity: "critical",
        category: "trading",
        alertType: "grid_slot_collision",
        message:
          `${intent.side} ${decision.clientOrderId} was placed for grid level ` +
          `${intent.levelIndex}, but ${lost.side} ${lost.clientOrderId} took that level while ` +
          `it was in flight. The new order holds the slot; the displaced order keeps its own ` +
          `recorded level and cost basis, so a fill against it is still applied, but it is no ` +
          `longer in openOrderIds and will not be polled or cancelled from the ladder. ` +
          `Check it on the exchange.`,
      });
    }
    await this.#mirrorOrderInsert(config, order, result.exchangeOrderId);

    for (const fill of result.fills) {
      await this.onFill(decision.clientOrderId, fill);
    }
    return {
      status: "running",
      action: `${GRID_PLACED_ACTION_PREFIX}${intent.side}-${intent.levelIndex}`,
      detail: decision.clientOrderId,
    };
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
  /**
   * `placeReplacement` is false ONLY for `applyMissedFills`, which repairs the
   * books on a halted bot and must not put a live order on the exchange. Every
   * other caller passes true and behaves exactly as before.
   */
  async #applyGridFillToOrder(
    config: GridConfig,
    state: BotRuntimeState,
    order: TrackedOrder,
    fill: Fill,
    placeReplacement: boolean,
  ): Promise<PipelineResult> {
    const effect = applyFill(order, fill);
    await this.#putOrder(effect.order);

    if (state.exitOrderId === order.clientOrderId) {
      return await this.#applyGridExitFill(config, state, effect.order, effect.fullyFilled, fill);
    }

    // WHERE THIS ORDER BELONGS, and whether it still holds that level.
    //
    // These used to be one question answered by `levelOf`, which searches the
    // live slots for the order's id. That conflated "this order has no level"
    // with "this order's level was taken from it", and answered the second as
    // if it were the first: the fill was recorded, no replacement was placed,
    // and nothing was raised. Two of bot-4xcq8p's rungs were lost that way.
    //
    // `order.levelIndex` answers the first question from the order's own
    // record; the slot at that level answers the second. Orders written before
    // that field existed fall back to the old search, which is exactly as good
    // as it ever was for them.
    const level = this.#gridLevelOf(state.ladder!, order);
    if (level === null) {
      // Genuinely off the ladder: no recorded level, and no slot claims it.
      // A halt sweep cleared it, or an exit folded it. Record and stop.
      await this.#mirrorOrderUpdate(effect.order);
      await this.#mirrorTrade(config, effect.order, fill);
      return { status: state.status, action: "fill_off_ladder", detail: order.clientOrderId };
    }

    // PLANNED AGAINST THE CURRENT LADDER, inside the mutation. `planFill` is
    // pure, so running it here rather than against the caller's snapshot costs
    // nothing and means a rung another pass placed, cleared, or replaced while
    // this fill was being read is present in the ladder this plan is built
    // from. Planning outside and writing `{ ...state, ladder: plan.ladder }`
    // would have reverted that rung along with everything else on the snapshot.
    //
    // The level is re-derived for the same reason: the filled order's rung is
    // found in the current ladder, not the one read before the exchange call.
    let plan: ReturnType<typeof planFill> | undefined;
    let displaced = false;
    const next = await this.#mutateState((current) => {
      const currentLevel = this.#gridLevelOf(current.ladder!, order);
      if (currentLevel === null) return current;
      const occupant = current.ladder!.slots[currentLevel.index] ?? null;
      // Displaced: the level is real and recorded on the order, but a different
      // order holds it now. Fold the fill against the order's OWN slot, and
      // leave the level alone -- clearing it would evict the current holder,
      // which is the same silent loss in the opposite direction.
      displaced = occupant === null || occupant.clientOrderId !== order.clientOrderId;
      plan = planFill(
        current.ladder!,
        config.params,
        currentLevel.index,
        fill.price,
        fill.quantity,
        effect.fullyFilled,
        {
          // `effect.order`, not `order`: the post-application record, so the
          // execution being folded right now is already in the list. Reading
          // the pre-application `order` would leave the replacement short by
          // exactly the fill that triggered it -- the same undercover this
          // change exists to close, one slice smaller.
          orderFills: effect.order.fills,
          ...(displaced ? { slot: currentLevel.slot, ownsSlot: false } : {}),
        },
      );
      // MAINTAINED, NOT RE-DERIVED. This used to assign the whole list from the
      // ladder's slots, and for a grid that is USUALLY the same list -- which is
      // exactly what made it wrong in the cases where it is not.
      //
      // SLOT-ABSENCE IS NOT RESOLUTION. Nothing in this object signals "this
      // order is resolved" by removing its ladder slot; every real removal is by
      // NAME -- `#cancelOpenOrders`' resolved set, `#foldTerminalState`'s
      // by-name filter, `#completeLiquidation`'s `filter(id !== exit)`. There
      // are exactly two reasons a tracked id has no slot, and neither is that it
      // ended:
      //
      //  - `#placeLiquidationSell` appends its sell and grants it no rung, by
      //    design: it is strategy-agnostic and DCA, which shares it, has no
      //    ladder at all.
      //  - `#gridExit` and `liquidatePosition` null EVERY slot on their way out,
      //    while `#cancelOpenOrders` deliberately RETAINS what it could not
      //    resolve -- an unconfirmed cancellation (the order may still be live on
      //    the exchange) or entry 57's gate refusing to close over a fill the
      //    venue reported and this bot had not recorded.
      //
      // So after a grid exit whose sweep failed, the retained ids are on the list
      // with no rung, and re-deriving from the slots dropped every one of them --
      // from the only list the poll, `checkOpenOrders`, `applyMissedFills` and
      // `repairPosition` ever read. The 2026-07-31 incident ("all five
      // cancellations failed on one parse bug") is that shape exactly, and the
      // irony is precise: retention exists to hand the order to the poll, and the
      // poll's own fold is what dropped its siblings.
      //
      // THE DISCIPLINE IS ALREADY WRITTEN DOWN, in `#cancelOpenOrders`: "REMOVE
      // WHAT THIS SWEEP RESOLVED, rather than assigning the list it believed in
      // when it started." This is the assign-form of that same mistake, and it
      // takes the same cure rather than a second one that could drift from it.
      //
      // WHAT THIS FOLD RESOLVED, and nothing else: a rung the plan CLEARED
      // (`planFill` nulls a level only when the order that owns it completed),
      // plus the folded order itself if it completed. A partial fill resolves
      // nothing and the id stays, which is correct -- it is still live.
      //
      // NOTHING IS CREATED HERE. `planFill` returns a replacement as an INTENT
      // and never claims its slot; `#placeGridOrder` does that later, and does
      // its own maintenance of this list. So there is no "added" term to carry.
      //
      // BYTE-IDENTICAL ON THE ORDINARY PATH. On a running bot every tracked id
      // is slot-backed, so `retained` is empty and this is `slotIds` -- the same
      // ids in the same level order this always wrote. It can only ever DECLINE
      // to drop something; it never adds an id that was not already tracked, so
      // an order the sweep genuinely resolved cannot be resurrected here.
      const beforeSlots = ladderOpenOrderIds(current.ladder!);
      const slotIds = ladderOpenOrderIds(plan.ladder);
      const resolved = new Set(beforeSlots.filter((id) => !slotIds.includes(id)));
      if (effect.fullyFilled) resolved.add(order.clientOrderId);
      const retained = current.openOrderIds.filter(
        (id) => !resolved.has(id) && !slotIds.includes(id),
      );
      return {
        ...current,
        ladder: plan.ladder,
        realizedGross: plan.ladder.realizedGross,
        openOrderIds: [...slotIds, ...retained],
      };
    });

    await this.#mirrorOrderUpdate(effect.order);
    await this.#mirrorTrade(config, effect.order, fill);

    if (plan === undefined) {
      // The rung went away between the read above and the write: another pass
      // cleared it (a halt sweep, or a terminal fold). The fill is recorded on
      // the order and mirrored; there is no level left to replace.
      return { status: next.status, action: "fill_off_ladder", detail: order.clientOrderId };
    }

    if (plan.replacement !== null && placeReplacement) {
      // Place the replacement at the level's own price (a resting limit), routine
      // priority: rebuilding the ladder is ordinary work, not a risk exit.
      const placed = await this.#placeGridOrder(config, plan.replacement, plan.replacement.price, "routine");
      if (placed.status === "halted") return placed;
      if (!gridOrderWasPlaced(placed)) {
        // NOTHING IS RESTING, WHATEVER THE REASON. This used to queue only
        // `slot_occupied` and drop the rest -- `skipped` (the sell was not
        // constructible, typically dust under the venue's minimum),
        // `throttled`, `unresolved` (transport), `recover` (the idempotency
        // guard wants the previous attempt resolved first) and `aborted` (the
        // bot left `running` mid-flight) -- while still reporting
        // `replaced-sell` to the caller. Every one of those five is base the
        // buy acquired with no sell against it, and replace-on-fill is the only
        // thing that ever places a grid sell: it does not re-run for a rung
        // already missed, so a dropped intent is cover lost permanently.
        //
        // The queue is the right home for all of them and not a stretch of it:
        // its entries are already "a rung this bot owes the ladder", the drain
        // already retries them on every poll and after every fold, and
        // `grid_replacement_queued` already says out loud that base is held with
        // nothing resting against it. A reason that never clears stays queued
        // and stays alerted -- which is the honest end state for, say, dust
        // below the venue minimum, and is what Stage D's repair will act on.
        await this.#queueReplacement(config, plan.replacement);
        return {
          status: next.status,
          action: `queued-${plan.replacement.side}`,
          detail: `${order.clientOrderId}: ${placed.action}${placed.detail === undefined ? "" : ` -- ${placed.detail}`}`,
        };
      }
      // A fold may have freed a level that an earlier intent was waiting on.
      await this.#drainReplacements(config);
      return { status: "running", action: `replaced-${plan.replacement.side}`, detail: order.clientOrderId };
    }
    if (placeReplacement) await this.#drainReplacements(config);
    return {
      status: next.status,
      action: displaced
        ? "filled_displaced"
        : effect.fullyFilled
          ? "filled"
          : "partially_filled",
      detail: order.clientOrderId,
    };
  }

  /**
   * The ladder level an order belongs to, and the slot describing it.
   *
   * PREFERS THE ORDER'S OWN RECORD (`levelIndex`, written at placement) over
   * searching the ladder, because searching answers a subtly different
   * question: `levelOf` finds where the order is HELD, and returns -1 both when
   * the order never had a level and when its level was taken from it. Those
   * need different handling, and telling them apart is the point of this.
   *
   * The returned `slot` is the order's own -- reconstructed from the order
   * record when the ladder no longer holds it -- so a displaced sell keeps the
   * cost basis its round trip must be measured against.
   *
   * Falls back to the ladder search for orders placed before `levelIndex`
   * existed. Null means genuinely no level: nothing recorded, nothing holding.
   */
  #gridLevelOf(
    ladder: GridLadder,
    order: TrackedOrder,
  ): { readonly index: number; readonly slot: GridSlot } | null {
    const recorded = order.levelIndex;
    if (recorded !== undefined && recorded >= 0 && recorded < ladder.slots.length) {
      const held = ladder.slots[recorded] ?? null;
      if (held !== null && held.clientOrderId === order.clientOrderId) {
        return { index: recorded, slot: held };
      }
      return {
        index: recorded,
        slot: {
          side: order.side,
          clientOrderId: order.clientOrderId,
          costBasis: order.costBasis ?? null,
          quantity: order.quantity,
        },
      };
    }

    const found = levelOf(ladder, order.clientOrderId);
    if (found < 0) return null;
    return { index: found, slot: ladder.slots[found]! };
  }

  /**
   * Hold a replacement whose level was not free, for the drain to place later.
   *
   * At most one intent per level. A second intent for the same level would mean
   * two live orders were wanted at one rung, which is the state the ladder does
   * not have and `claimSlot` exists to keep it from reaching -- so the newer
   * intent is dropped rather than queued, and said so out loud.
   */
  async #queueReplacement(config: GridConfig, intent: GridOrderIntent): Promise<void> {
    let duplicate = false;
    await this.#mutateState((current) => {
      const queue = current.pendingReplacements ?? [];
      if (queue.some((pending) => pending.levelIndex === intent.levelIndex)) {
        duplicate = true;
        return current;
      }
      return { ...current, pendingReplacements: [...queue, intent] };
    });
    if (duplicate) {
      await this.#alert(config, {
        severity: "warning",
        category: "trading",
        alertType: "grid_replacement_duplicate",
        message:
          `a ${intent.side} replacement for grid level ${intent.levelIndex} was already queued; ` +
          `the second one is dropped. Two replacements wanting one rung means the ladder's ` +
          `held position and its slots disagree -- check the ladder against the exchange.`,
      });
    }
  }

  /**
   * Place every queued replacement whose level has since freed up.
   *
   * Called at the top of each poll pass and after each grid fill is folded --
   * the two moments a level can become free. An intent whose level is still
   * occupied stays queued; one that places is removed. Nothing here halts on a
   * placement failure that `#placeGridOrder` already handled its own way.
   *
   * A HALTED BOT DRAINS NOTHING. The queue is emptied instead: a halt cancels
   * the ladder and sweeps its slots, so every queued intent refers to a rung
   * that no longer exists, and placing one would put a live order on the
   * exchange from a bot a human has stopped.
   */
  async #drainReplacements(config: GridConfig, standing?: Set<string>): Promise<void> {
    let state = await this.#state();
    if ((state.pendingReplacements ?? []).length === 0) return;

    if (state.status !== "running") {
      await this.#mutateState((current) => ({ ...current, pendingReplacements: [] }));
      return;
    }

    for (const intent of [...(state.pendingReplacements ?? [])]) {
      const current = await this.#state();
      if (current.status !== "running") break;
      if ((current.ladder?.slots[intent.levelIndex] ?? null) !== null) continue;

      const placed = await this.#placeGridOrder(config, intent, intent.price, "routine", false);
      // REMOVED ONLY ONCE AN ORDER IS ACTUALLY RESTING. This used to remove on
      // every outcome except `slot_occupied`, on the reasoning that "the intent
      // has had its turn and must not be replayed" -- and that is reversed here
      // deliberately, because it made the queue a one-shot retry rather than an
      // obligation. A replacement throttled by the rate limiter, or skipped as
      // unconstructible, or left unresolved by a transport failure, was tried
      // once and then forgotten, and the base it was meant to sell stayed held
      // with nothing against it. That is the same loss the fold site was
      // dropping; fixing one door and leaving the other open fixes neither.
      //
      // REPLAY IS SAFE, which is what makes retention affordable: every attempt
      // goes through `#placeGridOrder`, whose pre-send check refuses an occupied
      // level before anything is sent, and whose idempotency guard answers
      // `recover` rather than sending a second order when a previous attempt is
      // unresolved. So a retried intent cannot become a duplicate resting order.
      //
      // A reason that never clears therefore stays queued forever, and that is
      // intended rather than tolerated: `grid_replacement_queued` below is a
      // STANDING alert, so it states the condition once and keeps stating it
      // while it is true, which is exactly the report a human needs in order to
      // act on inventory the ladder cannot cover by itself.
      if (!gridOrderWasPlaced(placed)) {
        if (placed.status === "halted") break;
        continue;
      }
      await this.#mutateState((cur) => ({
        ...cur,
        pendingReplacements: (cur.pendingReplacements ?? []).filter(
          (pending) => pending.levelIndex !== intent.levelIndex,
        ),
      }));
    }

    state = await this.#state();
    if ((state.pendingReplacements ?? []).length > 0) {
      standing?.add(standingAlertKey("grid_replacement_queued", config.botInstanceId));
      await this.#raiseStanding(config, {
        severity: "warning",
        category: "trading",
        alertType: "grid_replacement_queued",
        message:
          `${state.pendingReplacements!.length} grid replacement order(s) are waiting for their ` +
          `level to free up: ${state.pendingReplacements!.map((p) => `${p.side}@${p.levelIndex}`).join(", ")}. ` +
          `Base acquired by the filled buy is held with nothing resting against it until they place.`,
      });
    }
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
    const proceeds = mul(fill.price, fill.quantity, "half-even");

    // Prorated against the CURRENT held position, inside the mutation. The
    // cost portion is a fraction of what the ladder holds, so computing it from
    // a snapshot taken before an exchange call would prorate against a held
    // quantity that has since moved -- and then write that stale ladder back
    // over the one that moved it.
    const next = await this.#mutateState((current) => {
      const ladder = current.ladder!;
      const costPortion =
        ladder.heldQuantity > ZERO
          ? divideRounded(ladder.heldCost * fill.quantity, ladder.heldQuantity, "half-even")
          : ZERO;
      const nextLadder: GridLadder = {
        ...ladder,
        heldQuantity: ladder.heldQuantity - fill.quantity,
        heldCost: ladder.heldCost - costPortion,
        realizedGross: ladder.realizedGross + (proceeds - costPortion),
      };
      let updated: BotRuntimeState = {
        ...current,
        ladder: nextLadder,
        realizedGross: nextLadder.realizedGross,
      };
      if (fullyFilled) {
        updated = {
          ...updated,
          exitOrderId: null,
          exitKind: undefined,
          openOrderIds: updated.openOrderIds.filter((id) => id !== order.clientOrderId),
        };
      }
      return updated;
    });

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
    await this.#mutateState((current) => ({ ...current, ladder: clearedLadder }));

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

    const sequence = await this.#allocateSequence();

    const guard = this.#guard(config.botInstanceId);
    const decision = await guard.beginAttempt(sequence, now);
    if (decision.action === "recover") return;

    // The point of no return, and the expected status here is HALTED rather
    // than running: a liquidation is the halt's own action. If the bot is no
    // longer halted -- resumed by a human, or closed -- selling the position
    // out from under it is precisely what `liquidatePosition` refuses to do
    // when it is asked directly.
    const abandoned = await this.#statusChangedFrom("halted");
    if (abandoned !== null) {
      await guard.markFailed(
        decision.clientOrderId,
        `the bot became ${abandoned} before the liquidation sell was sent`,
        now,
      );
      await this.#alert(config, {
        severity: "critical",
        category: "trading",
        alertType: "liquidation_abandoned",
        message:
          `the liquidation of ${toDecimalString(quantity)} was abandoned: the bot became ` +
          `${abandoned} while the sell was being prepared, so it was never sent. The position ` +
          `is still held.`,
      });
      return;
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
    await this.#mutateState((current) => ({
      ...current,
      exitOrderId: decision.clientOrderId,
      exitKind: "liquidation",
      openOrderIds: [...current.openOrderIds, decision.clientOrderId],
    }));
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
      // SELF-HEAL THE SUBSCRIPTION BEFORE RETURNING, and this is deliberately
      // ABOVE the early return rather than below it.
      //
      // Re-halting an already-halted bot is not a mistake to be short-circuited:
      // the global kill switch and reconciliation both do it on purpose, sweeping
      // every bot they select without first asking which are already halted. That
      // makes this the one code path that runs repeatedly against a bot in the
      // broken state the incident produced -- halted, but still subscribed to its
      // feed because a throw skipped the unsubscribe. Returning `already_halted`
      // first meant those sweeps saw the leak and walked past it every time.
      //
      // Safe to repeat: `unsubscribe` is idempotent, and this method is
      // best-effort by contract, so a second call on a bot that is already gone
      // from the registry is a no-op that cannot throw.
      //
      // NOT `#mirrorStatus`, and NOT the cancel sweep, and both exclusions are
      // deliberate. The D1 status mirror has a documented owner: `#resumePass`
      // reserves that convergence for the detector described in
      // `docs/open-items/resume-split-brain.md` part 3b, and widening it into
      // `#halt` here is the exact change that comment declines to make. A cancel
      // sweep would spend risk-exit rate budget on every kill-switch pass over
      // every already-halted bot, and the 30-second poll already observes halted
      // bots' open orders. The subscription has no such observer, which is why it
      // is the one that moves.
      await this.#unsubscribeFromFeed(config);
      return { status: "halted", action: "already_halted", detail: state.haltReason ?? undefined };
    }
    if (state.status === "stopped") {
      throw new BotInstanceError("invalid_status", "a stopped bot cannot be halted; its capital is released");
    }

    const recorded = `${reason}: ${detail}`;
    await this.#mutateState((current) => ({
      ...current,
      status: "halted",
      haltReason: recorded,
      haltedAt: now,
    }));

    // EVERY STEP BELOW IS INDEPENDENTLY BEST-EFFORT (see `#cleanupStep`). The
    // status write above is not: it is the ordering guarantee this method's
    // header argues for, and a halt that cannot be recorded must fail loudly.
    // Everything after it is tidying up after a halt that HAS happened, and one
    // failing must not take the others down with it -- which is exactly what a
    // run of bare `await`s did on `bot-xs0ufw`.

    // 1. Cancel every open order.
    const cancelFailed = await this.#cleanupStep(config, "cancel_open_orders", () =>
      this.#cancelOpenOrders(config, state),
    );

    // 3. Mark the instance halted with a recorded reason, in D1 too.
    const mirrorFailed = await this.#cleanupStep(config, "mirror_status", () =>
      this.#mirrorStatus(config, "halted", recorded, now, now),
    );

    // 4. Fire an alert. Written to D1 unconditionally per section 10; the
    //    outbound Discord/Telegram notification and its KV cooldown are step 8.
    // The "good news" halts -- a DCA cycle taken to profit, a grid cashed out on
    // its breakout or profit target -- are `info`, not `critical`. Only an
    // actual loss, error, or rejection is critical.
    //
    // STILL AN UNCONDITIONAL INSERT, and still the right treatment: a halt is a
    // discrete event and one row per halt is exactly what history wants. What
    // changed at step 27 is only that the row now gets CLOSED -- `#resumePass`
    // resolves it, through `haltAlertType`'s counterpart predicate, once the bot
    // is running again. The two must stay together the way `standing.ts`'s two
    // halves do; see `/src/alerts/halt.ts`.
    // `trailing_stop_reached` is here per spec 22.9: a trailing-stop exit is the
    // strategy's intended, successful outcome, so it earns the same `info` receipt
    // the other positive exits get. Omitting it would make every healthy exit of
    // that strategy raise a `critical` alert.
    const positiveExit =
      reason === "take_profit_reached" ||
      reason === "take_profit" ||
      reason === "breakout_take_profit" ||
      reason === "trailing_stop_reached";
    const alertFailed = await this.#cleanupStep(config, "halt_alert", () =>
      this.#alert(config, {
        severity: positiveExit ? "info" : "critical",
        category: reason === "unhandled_error" ? "system" : "trading",
        alertType: haltAlertType(reason),
        message: recorded,
      }),
    );
    const auditFailed = await this.#cleanupStep(config, "halt_audit", () =>
      this.#audit(config, "bot.halted", actor, { reason, detail }, now),
    );

    // The bot has left running: unsubscribe from the price feed (best-effort;
    // never blocks the halt). A DCA take-profit that AUTO-RESTARTS never reaches
    // here — it stays running — so it correctly stays subscribed.
    const unsubscribeFailed = await this.#cleanupStep(config, "unsubscribe_from_feed", () =>
      this.#unsubscribeFromFeed(config),
    );

    // 5. Never auto-resume: there is no path from `halted` back to `running`
    //    except `resume()`, which takes an actor.
    //
    // The `detail` still carries the halt reason when everything ran, because
    // that is what every existing caller and test reads off it. It is REPLACED
    // -- not appended to -- when cleanup was partial, so a caller cannot read a
    // half-finished halt as an ordinary one; the reason is on the bot row and in
    // the alert either way.
    const incomplete = this.#cleanupDetail([
      cancelFailed,
      mirrorFailed,
      alertFailed,
      auditFailed,
      unsubscribeFailed,
    ]);
    return { status: "halted", action: "halted", detail: incomplete ?? recorded };
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

      // FALSE means the cancellation landed but this bot's own record was
      // deliberately NOT closed, because the exchange reported more filled than
      // it had recorded. That order must stay in `openOrderIds`: it is the poll
      // that repairs it (read with per-fill detail, apply by real id, then
      // `#foldTerminalState` closes it), and the poll only reads what is on
      // this list. Dropping it here would leave a non-terminal order that
      // nothing observes -- the understatement made permanent by a different
      // route than the one the gate just closed.
      if (!(await this.#recordCancellation(config, order, outcome.value, now))) {
        stillOpen.push(clientOrderId);
      }
    }

    // REMOVE WHAT THIS SWEEP RESOLVED, rather than assigning the list it
    // believed in when it started. `openOrderIds: stillOpen` was written after
    // N network cancellations -- a long window on a grid ladder, which is
    // throttled deliberately -- and it silently dropped any id added while the
    // sweep ran. The poll adding a grid replacement mid-halt was exactly that:
    // a live order on the exchange, no longer tracked, no longer polled, and
    // never cancelled, on a bot that had just been halted.
    //
    // "Resolved" is every id this sweep started with that is not still open:
    // the ones it cancelled, plus the ones already terminal or unknown, which
    // the loop skips and which must still leave the list.
    //
    // `stillOpen` now carries TWO kinds of unresolved order, and they are
    // unresolved in different senses: one whose fate on the exchange is unknown
    // (the cancel could not be confirmed), and one that IS cancelled on the
    // exchange but whose local record this sweep refused to close over a fill
    // it had not recorded. Both want exactly the same treatment here -- keep
    // the id, keep the poll on it -- which is why they share the list rather
    // than getting a second one.
    //
    // AND THE LADDER LEARNS OF IT TOO, which it never used to. This method
    // closed a grid order's record and left its RUNG STANDING: nothing here
    // touched the ladder, and the only thing that clears a single slot --
    // `#foldTerminalState` -- is reached solely from the poll, which reads only
    // `openOrderIds` and therefore never looks at an order this sweep just
    // removed from it. So a manually halted grid bot sat indefinitely with
    // rungs naming orders that were cancelled, resolved and gone.
    //
    // WHAT THAT STALE LADDER THEN LIED TO. Every consumer that reads the slots
    // as "what is live" read a ladder that was not:
    //
    //  - the three writes that build `openOrderIds` from the slots put those
    //    dead ids BACK on the tracked list -- resurrection, the exact opposite
    //    of the loss the same three writes were fixed for;
    //  - `uncoveredInventoryFindings` sums SELL slots as cover, so a cancelled
    //    sell's rung counted as protection that does not exist -- a false
    //    NEGATIVE in the one detector written to find uncovered inventory;
    //  - `#placeGridOrder`'s pre-send check reads an occupied level and refuses
    //    to replace a rung whose occupant is long gone.
    //
    // FIXING IT HERE RATHER THAN AT EACH READER is what makes the invariant
    // provable instead of assumed: `closeOrder` has exactly TWO call sites in
    // this object -- `#foldTerminalState`, which already clears the slot, and
    // this one, which now does. With both closed, a non-null slot names an
    // order this bot still believes is live, and every reader of the ladder
    // gets that for free without a fourth copy of the same guard.
    //
    // IT CANNOT REINTRODUCE ENTRY 57/64's PROBLEM, and the reason is that it
    // reuses THIS set rather than a second opinion about it. `resolved` is
    // precisely the ids `#recordCancellation` returned TRUE for, plus the ones
    // the loop skipped as already terminal. Everything in `stillOpen` -- the
    // unconfirmed cancellation, and the record the gate refused to close over
    // an unrecorded fill -- keeps its id on the list AND keeps its rung. The
    // slot follows the resolution; it never leads it.
    const resolved = new Set(state.openOrderIds.filter((id) => !stillOpen.includes(id)));
    await this.#mutateState((current) => {
      const openOrderIds = current.openOrderIds.filter((id) => !resolved.has(id));
      if (current.ladder === undefined) return { ...current, openOrderIds };
      const slots = current.ladder.slots.map((slot) =>
        slot !== null && resolved.has(slot.clientOrderId) ? null : slot,
      );
      return { ...current, ladder: { ...current.ladder, slots }, openOrderIds };
    });
  }

  /**
   * Fold a cancellation response into the local order.
   *
   * Returns whether the local record was actually CLOSED. `false` means this
   * sweep declined to close it and the caller must leave it in `openOrderIds`;
   * see the gate below.
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
   * THE GATE, AND WHY IT IS `#foldTerminalState`'s AND NOT A NEW ONE. That
   * answer was only half of one. Leaving the difference off the POSITION is
   * right and unchanged; going on to `closeOrder` the local record anyway was
   * not. A terminal order can never accept a fill afterwards
   * (`ALLOWED_TRANSITIONS` gives every terminal state an empty successor list,
   * and `applyFill` throws `fill_after_terminal`), so closing here at the
   * understated number is what made the understatement PERMANENT rather than
   * merely current -- the poll could no longer apply the real fill when
   * `getOrderStatus` finally handed it over with its real `tid`, and
   * `applyMissedFills` could not reach an order that had left `openOrderIds`.
   * "Reconciliation owns it" was true of the position and false of the record:
   * section 9 halts and alerts and deliberately never auto-corrects, so nothing
   * downstream was ever going to put the number back.
   *
   * `#foldTerminalState` already refuses exactly this, for the other trigger --
   * an order the EXCHANGE ended, read by the poll -- and its docblock states the
   * reasoning verbatim. This is the same order, in the same condition, reached
   * by the other door, so it takes the same comparison rather than a second one
   * that could drift from it: `order.filledQuantity < remote.filledQuantity`,
   * exact, no tolerance. Anything else (equal, or a local record AHEAD of the
   * cancellation response) closes as before -- a local record ahead of remote
   * loses nothing by being closed, which is why the gate is one-sided.
   *
   * What refusing leaves behind is deliberately the shape the poll can finish:
   * a non-terminal order still in `openOrderIds`, on a bot that is halted but
   * still polled (`#pollArmed` excludes only `stopped`). The next pass reads it
   * with per-fill detail, `applyFill` accepts the missing execution under its
   * real id, and `#foldTerminalState` -- whose gate now passes -- closes it
   * properly. The refusal is a deferral to the one path that can repair it, not
   * a dead end.
   *
   * THE ALERT IS UNCHANGED IN TYPE, deliberately: `cancel_fill_discrepancy` is
   * already this condition's signal, it is already ingested by reconciliation
   * (`INGESTED_ALERT_TYPES`), and a new alert type would be a second name for
   * one incident. Only its message changes, because what happens to the order
   * changed and the message said so.
   */
  async #recordCancellation(
    config: BotConfigBase,
    order: TrackedOrder,
    remote: OrderStatus,
    now: Timestamp,
  ): Promise<boolean> {
    if (order.filledQuantity < remote.filledQuantity) {
      await this.#alert(config, {
        severity: "warning",
        category: "trading",
        alertType: "cancel_fill_discrepancy",
        message:
          `${order.clientOrderId} was cancelled with ${toDecimalString(remote.filledQuantity)} ` +
          `filled, but this bot had recorded ${toDecimalString(order.filledQuantity)}. The ` +
          `cancellation response carries no per-fill breakdown and therefore no trade id, so ` +
          `the difference is NOT applied to the position here; reconciliation owns it. The ` +
          `local order is left OPEN rather than closed at the understated number: a terminal ` +
          `order can never accept the missing fill afterwards, so closing it now would make ` +
          `this permanent. The poll re-reads it and applies the fill by its real id.`,
      });
      return false;
    }

    // `now` finally does something. It has been a parameter this method took and
    // discarded (`void now;`) since it was written, and this is what it was for:
    // `OrderStatus.updatedAt` is optional, so a venue that reports no last-update
    // time falls back to this sweep's own clock.
    //
    // In practice the fallback does not fire on either venue today -- BOTH
    // cancellation parsers supply a real instant (Binance's `transactTime`,
    // Gemini's receipt time), because a cancellation this system issued is one
    // whose moment it necessarily observed. That is exactly why it is written as
    // a fallback and not as a replacement: the value the venue reports is better
    // than the value this clock holds, and it is still used whenever it exists.
    const cancelled = closeOrder(order, "cancelled", remote.updatedAt ?? now);
    await this.#putOrder(cancelled);
    await this.#mirrorOrderUpdate(cancelled);
    return true;
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

  /**
   * Raise a condition the poll RE-DETECTS, as one row per open incident.
   *
   * The counterpart to `#alert`, and the difference is entirely about what kind
   * of fact is being recorded. `#alert` records a discrete EVENT at the moment
   * it happens, and one row per event is exactly right. This records a
   * CONDITION that is re-derived on every 30-second pass and deliberately never
   * auto-corrected, where one row per detection would measure how long the
   * condition has persisted instead of what is wrong.
   *
   * The mechanism is `/src/alerts/standing.ts` -- the same one reconciliation's
   * cron uses, not a second copy of it. Its resolve half runs once per pass in
   * `#observeOpenOrders`; the two must never be separated (see that module's
   * header).
   */
  async #raiseStanding(
    config: BotConfigBase,
    alert: {
      severity: AlertRow["severity"];
      category: AlertRow["category"];
      alertType: string;
      message: string;
    },
  ): Promise<void> {
    await raiseStandingAlert(this.#db(), () => this.#newId(), {
      alertType: alert.alertType,
      botInstanceId: config.botInstanceId,
      severity: alert.severity,
      category: alert.category,
      source: BOT_ALERT_SOURCE,
      message: alert.message,
      at: this.#now(),
    });
  }

  async #alert(
    config: BotConfigBase,
    alert: {
      severity: AlertRow["severity"];
      category: AlertRow["category"];
      alertType: string;
      message: string;
      /**
       * Born resolved, for an alert that is a RECEIPT rather than an INCIDENT
       * (step 72). Defaults to false: an alert is an open condition unless it
       * says otherwise, which is what every existing caller means.
       *
       * WHAT THE DISTINCTION IS. `resolved` answers "is this still going on?".
       * Most alerts here describe a CONDITION -- drift that is still true, a
       * venue still unreachable, a bot still halted -- and something later
       * closes them. A few describe an EVENT that was already complete at the
       * instant it was recorded: a cycle closed, a liquidation filled, a repair
       * committed, a click that found nothing to do. Nothing closes those,
       * because there is nothing to close, and until this flag existed they sat
       * `resolved: false` forever -- inflating the one number an operator reads
       * to decide what is on fire, while describing things that had already
       * finished.
       *
       * NOT A SUPPRESSION, and the three consumers were checked rather than
       * assumed. The notification dispatcher selects on `notified_at IS NULL`
       * and never reads `resolved`, so the outbound ping is unaffected.
       * `GET /api/alerts` applies no default `resolved` filter, so the row is
       * still listed. `driftAlerts.ts` and `pollAlerts.ts` gate on their own
       * alert-type sets, neither of which contains any of these. What changes
       * is `statusCounts.ts`'s unresolved COUNT, which is exactly the number
       * that was wrong.
       */
      resolved?: boolean;
    },
  ): Promise<void> {
    const row: AlertRow = {
      id: this.#newId(),
      severity: alert.severity,
      category: alert.category,
      alert_type: alert.alertType,
      bot_instance_id: config.botInstanceId,
      source: BOT_ALERT_SOURCE,
      message: alert.message,
      resolved: alert.resolved ?? false,
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
