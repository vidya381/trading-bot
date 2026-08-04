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

import { raiseStandingAlert, resolveClearedStandingAlerts, standingAlertKey } from "../alerts";
import { createBotInstanceWithCapital, releaseBotCapital } from "../capital";
import { databaseFrom, type Database } from "../db";
import type { AlertRow, AuditLogRow, BotStatus, OrderRow, TradeRow } from "../db/schema";
import { isExchangeId } from "../db/schema";
import { resolveExchangeForAccount } from "../workers/exchange-dispatch";
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
import { POLL_HEALTH_ALERT_TYPES } from "../shared/alert-types";
import { withRateLimit, type RateLimiterPort } from "../exchange/rate-limited";
import type { PriceFeedConfig, PriceFeedPort } from "./price-feed";
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
/** Slow retry once the reads are failing, so a long outage self-heals. */
const POLL_BACKOFF_CAP_MS = 300_000;
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

    if (!isExchangeId(config.exchange)) {
      throw new BotInstanceError(
        "not_attached",
        `bot ${config.botInstanceId}'s stored exchange ${JSON.stringify(config.exchange)} ` +
          `is not a known exchange ("binance" or "gemini"); refusing to build a client.`,
      );
    }

    const resolution = resolveExchangeForAccount(config.exchange, this.env, now);
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
      await this.#alert(config, {
        severity: "warning",
        category: "system",
        alertType: "price_feed_unsubscribe_failed",
        message:
          `could not unsubscribe bot ${config.botInstanceId} from its price feed ` +
          `(${config.exchange}:${config.pair}): ${(error as Error).message}. The bot ` +
          `has still left running; the stale subscriber is harmless and reconciliation-visible.`,
      });
    }
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

    state = await this.#mutateState((current) => ({
      ...current,
      lastPrice: price.price,
      lastPriceAt: price.at,
    }));

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
        inScope: (botInstanceId) => botInstanceId === config.botInstanceId,
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

    for (const clientOrderId of [...state.openOrderIds]) {
      reads += 1;
      const outcome = await exchange.getOrderStatus(config.pair, clientOrderId);

      // AND YIELD AGAIN HERE, which is the check that actually matters. The
      // read above suspends this object on the network, and step 21's section 0
      // probe measured that a price tick or an alarm is delivered into exactly
      // that window. So the pass may have been alone when it started and not be
      // alone now -- and the fill just read would be folded into a position
      // another pass is mid-way through acting on.
      //
      // Abandoning costs nothing: the fill is the exchange's own record, it is
      // still there on the next pass, and `applyFill` dedupes on its id. Not
      // applying something re-readable is always cheaper than applying it at
      // the wrong moment.
      //
      // `reads` deliberately KEEPS this read. It happened and it succeeded --
      // the venue answered. An earlier version decremented it here on the
      // reasoning that the result was discarded, and that quietly disabled both
      // of the guards `deferred` exists to feed: `observedEverything` starts
      // with `reads > 0`, and `#runScheduledPoll` treats `reads === 0` as
      // "nothing to read". Forcing the count to zero made a deferred pass
      // indistinguishable from an empty one, so two mutants that should have
      // failed a test survived instead. What a deferred pass did not do is
      // FINISH, and `deferred` is what says so.
      if (this.#passesInFlight > 0) {
        return { applied, skipped, closed, refused, standing, reads, unreadable, deferred: true };
      }

      if (!isUsable(outcome)) {
        // Section 5.6: an unreachable exchange is not data. The order keeps its
        // local state and stays open, to be read again on the next pass.
        unreadable += 1;
        skipped.push(`${clientOrderId}: ${outcome.kind} ${outcome.message}`);
        continue;
      }
      const remote = outcome.value;

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

    const ended = closeOrder(order, remote.state, remote.updatedAt);
    await this.#putOrder(ended);
    await this.#mirrorOrderUpdate(ended);

    const state = await this.#state();
    if (config.strategy === "grid" && state.ladder !== undefined) {
      // The ladder owns `openOrderIds` for a grid, so clearing the slot IS the
      // removal; filtering the array directly would be undone by the next fill.
      const levelIndex = levelOf(state.ladder, clientOrderId);
      if (levelIndex >= 0) {
        await this.#mutateState((current) => {
          const slots = current.ladder!.slots.map((slot, index) =>
            index === levelIndex ? null : slot,
          );
          const ladder: GridLadder = { ...current.ladder!, slots };
          return { ...current, ladder, openOrderIds: ladderOpenOrderIds(ladder) };
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
      nextPollAt = this.#now() + this.#pollDelay(schedule);
      await this.#putPollSchedule({ ...schedule, nextPollAt });
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

  /** 30s healthy; doubling to a 5-minute floor while the reads keep failing. */
  #pollDelay(schedule: PollSchedule): number {
    return Math.min(POLL_INTERVAL_MS * 2 ** schedule.failures, POLL_BACKOFF_CAP_MS);
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
    await this.#mutateState((current) => ({
      ...current,
      status: "running",
      haltReason: null,
      haltedAt: null,
    }));
    await this.#mirrorStatus(config, "running", null, null, now);
    await this.#audit(
      config,
      "bot.resumed",
      actor,
      { previous_halt_reason: state.haltReason, previous_halted_at: state.haltedAt },
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
      await this.#mutateState((current) => ({ ...current, ladder: cleared }));
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
    return await this.#outsidePoll(() => this.#closePass(actor));
  }

  async #closePass(actor: string): Promise<PipelineResult> {
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
    await this.#mutateState((current) => ({ ...current, status: "stopped", openOrderIds: [] }));
    await this.#audit(config, "bot.closed", actor, { cycles_completed: latest.cycleCount }, now);

    // Closing can go running -> stopped directly (bypassing #halt), so this is a
    // genuine "leaving running" point. Best-effort, like the halt path; a bot
    // closed from `created` (never subscribed) unsubscribes as a harmless no-op.
    await this.#unsubscribeFromFeed(config);

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

    await this.#mutateState((current) => ({ ...current, filters: outcome.value }));
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
    config: DcaConfig,
    state: BotRuntimeState,
    order: TrackedOrder,
    fill: Fill,
  ): Promise<PipelineResult> {
    const effect = applyFill(order, fill);
    await this.#putOrder(effect.order);

    const isExit = state.exitOrderId === order.clientOrderId;

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

    const completed = await this.#mutateState((current) => ({
      ...current,
      cycleCount: current.cycleCount + 1,
      position: EMPTY_POSITION,
      openOrderIds: [],
      exitOrderId: null,
      exitKind: undefined,
      realizedGross: current.realizedGross + gross,
    }));
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

    const completed = await this.#mutateState((current) => ({
      ...current,
      position: EMPTY_POSITION,
      openOrderIds: current.openOrderIds.filter((id) => id !== exit.clientOrderId),
      exitOrderId: null,
      exitKind: undefined,
      realizedGross: current.realizedGross + gross,
    }));
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
    });
    await this.#putOrder(order);

    const slot: GridSlot = {
      side: intent.side,
      clientOrderId: decision.clientOrderId,
      costBasis: intent.costBasis,
      quantity: adjusted.quantity,
    };
    await this.#mutateState((current) => {
      const ladder = withSlot(current.ladder!, intent.levelIndex, slot);
      return { ...current, ladder, openOrderIds: ladderOpenOrderIds(ladder) };
    });
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

    if (levelOf(state.ladder!, order.clientOrderId) < 0) {
      // The order is not on the ladder any more (its slot was cleared, e.g. by a
      // halt). Record the fill; there is no level to replace.
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
    const next = await this.#mutateState((current) => {
      const currentLevel = levelOf(current.ladder!, order.clientOrderId);
      if (currentLevel < 0) return current;
      plan = planFill(
        current.ladder!,
        config.params,
        currentLevel,
        fill.price,
        fill.quantity,
        effect.fullyFilled,
      );
      return {
        ...current,
        ladder: plan.ladder,
        realizedGross: plan.ladder.realizedGross,
        openOrderIds: ladderOpenOrderIds(plan.ladder),
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

    // The bot has left running: unsubscribe from the price feed (best-effort;
    // never blocks the halt). A DCA take-profit that AUTO-RESTARTS never reaches
    // here — it stays running — so it correctly stays subscribed.
    await this.#unsubscribeFromFeed(config);

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
    const resolved = new Set(state.openOrderIds.filter((id) => !stillOpen.includes(id)));
    await this.#mutateState((current) => ({
      ...current,
      openOrderIds: current.openOrderIds.filter((id) => !resolved.has(id)),
    }));
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
