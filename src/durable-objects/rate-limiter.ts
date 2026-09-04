/**
 * The `RateLimiter` Durable Object (spec section 5.4), build step 8.
 *
 * ONE OBJECT PER EXCHANGE ACCOUNT, named by the account label. That is the
 * whole reason it exists: a request-weight budget is an account-wide fact, and
 * a per-request client object -- which is what step 3 built -- can see its own
 * traffic and nothing else. Two bots on one account will happily spend the same
 * budget twice if neither can see the other. Section 3's isolation principle
 * puts one of these per account for the same reason it puts one `BotInstance`
 * per bot: it is the unit that owns the state.
 *
 * ---------------------------------------------------------------------------
 * HOW PRIORITY IS ENFORCED: two mechanisms, not one
 * ---------------------------------------------------------------------------
 * Section 5.4 says stop-loss and risk-exit orders are prioritised over routine
 * strategy orders. There are two different failures hiding in that sentence and
 * they need different answers, which is step 2's decision 10 and is why both
 * are here.
 *
 * 1. **A reserved slice.** Routine traffic may only draw on
 *    `limit - reserveForRiskExit`; risk-exit traffic may use the whole limit.
 *    This handles the case that actually matters and that ordering cannot
 *    touch: routine ladder maintenance spending the entire budget BEFORE the
 *    stop-loss is even created. Queue ordering decides who goes first among
 *    requests that are already waiting, and a stop-loss that does not exist yet
 *    is not waiting. The reservation makes that starvation structurally
 *    impossible rather than merely unlikely.
 *
 * 2. **A ticketed queue.** Among requests that ARE waiting, risk-exit goes
 *    first, then oldest-first within each class, with head-of-line blocking so
 *    a large risk-exit request cannot be starved by a stream of small ones
 *    slipping past it.
 *
 * ---------------------------------------------------------------------------
 * WHY TICKETS, AND NOT A PROMISE THAT RESOLVES WHEN BUDGET FREES
 * ---------------------------------------------------------------------------
 * The obvious API is `await limiter.acquire(...)`, with the object holding the
 * caller's promise until budget frees. Rejected deliberately.
 *
 * It would put unresolved promises and a timer inside a Durable Object, which
 * means: state that cannot be persisted (a promise is not `structuredClone`-
 * able), a caller whose wait silently dies if the object is evicted, and a
 * drain loop whose behaviour depends on a real clock -- so the priority
 * ordering, which is a risk control, could only be tested by waiting for it.
 *
 * Instead a refusal hands back a TICKET. The caller sleeps and re-presents it,
 * keeping its place in the queue. The object holds no timers, resolves no
 * promises, and every decision it makes is a pure function of (its budget, its
 * live tickets, the clock) -- so `acquire` can be driven directly in a test at
 * whatever timestamps the test chooses. `/src/exchange/rate-limited.ts` owns
 * the sleeping half and is the only thing that has to know about it.
 *
 * A ticket lost to eviction or to its TTL is treated as a new arrival: it goes
 * to the back of its priority class. That loses fairness, never safety -- the
 * failure direction is "waits longer", not "spends budget nobody granted".
 *
 * ---------------------------------------------------------------------------
 * WHY THE WINDOW IS PERSISTED
 * ---------------------------------------------------------------------------
 * A Durable Object is evicted after a short idle period; the rolling window is
 * 60 seconds. An object that kept its entries only in memory would wake with an
 * apparently untouched budget and permit a second full limit inside one window
 * -- precisely the double-rate failure that made this a sliding window rather
 * than a fixed one in the first place. So every grant persists, at the cost of
 * one storage write per exchange call.
 */

import { DurableObject } from "cloudflare:workers";

import type { Timestamp } from "../shared/exchange-client";
import {
  DecayingCounter,
  prioritize,
  RateLimiterError,
  WeightBudget,
  type Budget,
  type DecayingCounterSnapshot,
  type PendingRequest,
  type RateLimitDenialReason,
  type RequestPriority,
  type WeightBudgetSnapshot,
} from "../shared/rate-limiter";
import type { ExchangeId } from "../db/schema";
import {
  KRAKEN_DEFAULT_TIER,
  KRAKEN_REST_TIERS,
  KRAKEN_TRADING_TIERS,
} from "../exchange/kraken/rate-limits";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * The ceiling assumed before `exchangeInfo` has ever been read.
 *
 * There is a bootstrap gap here and it is worth naming: section 5.4 says the
 * budget mirrors the exchange's published limits, but reading those limits is
 * itself a request that costs budget. Refusing all traffic until the limit is
 * known would need an exemption for the very call that learns it, which is this
 * default under another name.
 *
 * So the object starts armed with the documented spot default and corrects
 * itself from the first `exchangeInfo` response (`syncLimit`). If the real
 * ceiling is LOWER, this over-spends for exactly one call -- and that call's
 * own response header then reports the true usage through `syncFromExchange`,
 * which only ever raises the local figure.
 */
export const DEFAULT_WEIGHT_LIMIT = 1200;

/** The exchange's request-weight window. */
export const DEFAULT_WINDOW_MS = 60_000;

/**
 * The share of the limit held back for risk-exit traffic.
 *
 * A FRACTION rather than a fixed number, so that a `syncLimit` raising the
 * ceiling raises the reserve with it. A fixed 200 would silently become a
 * proportionally smaller safety margin the moment the exchange published a
 * larger limit, which is the one direction nobody would notice.
 *
 * One sixth of 1200 is 200: enough for a grid halt cancelling a full ladder
 * (one weight per cancellation) several times over, with room for the status
 * reads around it.
 */
export const RISK_EXIT_RESERVE_FRACTION = 1 / 6;

/**
 * How long a ticket survives without being re-presented.
 *
 * Set from the budget's horizon plus a grace period, because a caller's longest
 * possible sleep is bounded by it -- everything in a rolling window has aged out
 * after one window, and a decaying counter at its ceiling is empty after one
 * drain. A caller that dies mid-wait therefore holds its claim for at most that
 * long plus a few seconds, and only against requests queued BEHIND it.
 */
function ticketTtlMs(horizonMs: number): number {
  return horizonMs + 5_000;
}

const STATE_KEY = "budget";

// ---------------------------------------------------------------------------
// Which budget shape a venue needs
// ---------------------------------------------------------------------------

/**
 * The account-wide counter's shape, and whether the venue also meters per pair.
 *
 * `Record<ExchangeId, ...>` with no default, for the reason `METHOD_COSTS` and
 * `resolveExchangeForAccount` are written that way: a fourth venue must FAIL TO
 * COMPILE here rather than silently inherit another venue's mechanics. Entry 94
 * records what a default cost the last time one existed.
 */
interface VenueBudgetModel {
  /**
   * How the account-wide counter forgets a charge.
   *
   * `sliding` -- Binance's published request-weight window: a charge counts in
   * full for `windowMs` and then vanishes.
   * `decaying` -- Kraken's call counter: a charge is shed continuously at a
   * fixed rate. Decision-log 90 PROBLEM 2 (a) on why these are different rules
   * rather than different constants.
   */
  readonly shape: "sliding" | "decaying";
  readonly limit: number;
  /** Sliding only. */
  readonly windowMs?: number;
  /** Decaying only. */
  readonly decayPerSecond?: number;
  /**
   * The per-pair matching-engine counter, when the venue has one.
   *
   * `null` for Binance and Gemini, which meter order traffic out of the same
   * account-wide budget as everything else. Kraken does not: decision-log 90
   * PROBLEM 2 (b), and it is why one counter was never going to be enough.
   */
  readonly trading: { readonly threshold: number; readonly decayPerSecond: number } | null;
}

const VENUE_BUDGET_MODELS: Readonly<Record<ExchangeId, VenueBudgetModel>> = {
  binance: {
    shape: "sliding",
    limit: DEFAULT_WEIGHT_LIMIT,
    windowMs: DEFAULT_WINDOW_MS,
    trading: null,
  },
  // Gemini publishes request counters rather than weights; `GEMINI_METHOD_WEIGHTS`
  // converts them into this budget's units, so the SHAPE it needs is Binance's.
  // See the conversion's docblock in `exchange/rate-limited.ts`.
  gemini: {
    shape: "sliding",
    limit: DEFAULT_WEIGHT_LIMIT,
    windowMs: DEFAULT_WINDOW_MS,
    trading: null,
  },
  kraken: {
    shape: "decaying",
    limit: KRAKEN_REST_TIERS[KRAKEN_DEFAULT_TIER].maxCounter,
    decayPerSecond: KRAKEN_REST_TIERS[KRAKEN_DEFAULT_TIER].decayPerSecond,
    trading: {
      threshold: KRAKEN_TRADING_TIERS[KRAKEN_DEFAULT_TIER].threshold,
      decayPerSecond: KRAKEN_TRADING_TIERS[KRAKEN_DEFAULT_TIER].decayPerSecond,
    },
  },
};

/** Every counter a cost vector touches, as (key, amount) pairs. */
function costKeys(cost: AcquireCost): [string, number][] {
  const keys: [string, number][] = [];
  if (cost.rest > 0) keys.push(["rest", cost.rest]);
  if (cost.trading !== undefined && cost.trading.count > 0) {
    keys.push([`trading:${cost.trading.pair}`, cost.trading.count]);
  }
  return keys;
}

/** Diagnostics only: a vector's components are different currencies. */
function totalCost(cost: AcquireCost): number {
  return cost.rest + (cost.trading?.count ?? 0);
}

/** The reserve for a ceiling, floored so it is always strictly below it. */
function reserveFor(limit: number): number {
  return Math.min(Math.floor(limit * RISK_EXIT_RESERVE_FRACTION), Math.max(0, limit - 1));
}

function buildAccountBudget(model: VenueBudgetModel): Budget {
  if (model.shape === "sliding") {
    return new WeightBudget({
      limit: model.limit,
      windowMs: model.windowMs ?? DEFAULT_WINDOW_MS,
      reserveForRiskExit: reserveFor(model.limit),
    });
  }
  return new DecayingCounter({
    limit: model.limit,
    decayPerSecond: model.decayPerSecond!,
    reserveForRiskExit: reserveFor(model.limit),
  });
}

// ---------------------------------------------------------------------------
// What survives eviction
// ---------------------------------------------------------------------------

type PersistedAccountBudget =
  | {
      readonly shape: "sliding";
      readonly limit: number;
      readonly windowMs: number;
      readonly reserveForRiskExit: number;
      readonly snapshot: WeightBudgetSnapshot;
    }
  | {
      readonly shape: "decaying";
      readonly limit: number;
      readonly decayPerSecond: number;
      readonly reserveForRiskExit: number;
      readonly snapshot: DecayingCounterSnapshot;
    };

interface PersistedTradingCounter {
  readonly pair: string;
  readonly limit: number;
  readonly decayPerSecond: number;
  readonly reserveForRiskExit: number;
  readonly snapshot: DecayingCounterSnapshot;
}

interface PersistedState {
  /** The venue this object has been serving. `null` before the first request. */
  readonly exchange: ExchangeId | null;
  readonly account: PersistedAccountBudget;
  /** One per pair that has actually traded. Absent pairs have spent nothing. */
  readonly trading: readonly PersistedTradingCounter[];
  /** Where the current limit came from, for the dashboard and for tests. */
  readonly limitSource: LimitSource;
}

/**
 * The pre-Kraken persisted shape, still on disk in every deployed environment.
 *
 * A Durable Object is not redeployed with the Worker -- it wakes up holding
 * whatever it last wrote. Reading only the new shape would make every live
 * limiter wake with an empty budget and grant a full ceiling it had already
 * spent, which is precisely the double-rate failure the persistence exists to
 * prevent. So the old shape is still understood, exactly once, on read.
 */
interface LegacyPersistedState {
  readonly limit: number;
  readonly windowMs: number;
  readonly reserveForRiskExit: number;
  readonly snapshot: WeightBudgetSnapshot;
  readonly limitSource: "default" | "exchangeInfo";
}

function isLegacy(
  stored: PersistedState | LegacyPersistedState,
): stored is LegacyPersistedState {
  return (stored as PersistedState).account === undefined;
}

/**
 * Where the ceiling in force came from.
 *
 * `exchangeCounter` is new with Kraken: the venue reports its own tier threshold
 * (`maxratecount`) alongside the counter value, so a limiter can learn the real
 * ceiling from traffic instead of being configured with it. See
 * `syncFromExchange`.
 */
export type LimitSource = "default" | "exchangeInfo" | "exchangeCounter";

// ---------------------------------------------------------------------------
// The RPC surface
// ---------------------------------------------------------------------------

/**
 * What one call costs, across every counter the venue meters it against.
 *
 * ---------------------------------------------------------------------------
 * WHY A VECTOR AND NOT A NUMBER
 * ---------------------------------------------------------------------------
 * Decision-log 90 PROBLEM 2 (b). This used to be a single `weight`, because
 * Binance meters everything against one account-wide counter and Gemini's two
 * counters were convertible into that one. Kraken's are not: `AddOrder` and
 * `CancelOrder` charge a matching-engine counter that is kept PER PAIR, and
 * charge the REST counter nothing at all, while the status read that follows a
 * cancel charges the REST counter and the engine nothing. One number cannot say
 * that, and the version of this that tried would have had to pick which of the
 * two truths to discard.
 *
 * A call may name either component, or both. A cancel on Kraken names both, and
 * is granted only if BOTH have room -- which is the property that matters,
 * because sending it when only one does is exactly the request the venue
 * rejects.
 */
export interface AcquireCost {
  /**
   * Units against the account-wide counter.
   *
   * Binance's request weight, Gemini's converted request units, Kraken's REST
   * call counter. May be 0 for a call the venue does not meter there -- Kraken's
   * `AddOrder` is the case -- provided `trading` is charged instead.
   */
  readonly rest: number;
  /**
   * Units against ONE pair's matching-engine counter.
   *
   * Absent for every non-trading call, and for every venue that has no such
   * counter. The pair is part of the cost because the counter is per pair: two
   * cancels on different markets do not compete, and a budget that pooled them
   * would refuse traffic the venue would have accepted.
   */
  readonly trading?: { readonly pair: string; readonly count: number };
}

export interface AcquireRequest {
  /**
   * WHICH VENUE this request is for.
   *
   * Required, and checked against the venue this object has already been serving
   * -- an account has exactly one exchange (`accounts.exchange`), so two venues
   * arriving at one limiter is a wiring bug and is refused rather than averaged.
   * It is what selects the budget SHAPE; the cost vector above only says how
   * much. Same value the gate was constructed with, so the table charged and the
   * mechanics charging it come from one fact rather than two that could disagree.
   */
  readonly exchange: ExchangeId;
  /** What the call costs, per counter. */
  readonly cost: AcquireCost;
  readonly priority: RequestPriority;
  /**
   * A ticket from an earlier refusal, re-presented to keep its queue place.
   * Absent on a first attempt.
   */
  readonly ticketId?: string;
  /** What is asking, e.g. `placeOrder BTCUSDT`. Diagnostics only. */
  readonly label?: string;
}

/** Why a request was not granted. */
export type AcquireDenialReason =
  | RateLimitDenialReason
  /** Budget exists, but something ahead of this request in the queue claims it. */
  | "queued_behind"
  /**
   * The request named a different venue than this object is serving.
   *
   * Not retryable and not a budget condition at all: it means an account's
   * limiter was handed a call for another exchange, which no amount of waiting
   * fixes. Distinguished so it reads as the wiring bug it is rather than as
   * throttling.
   */
  | "wrong_exchange";

export type AcquireResult =
  | {
      readonly granted: true;
      /** What was charged, echoed back so a caller can log what it spent. */
      readonly cost: AcquireCost;
      /** The account-wide counter after the charge. */
      readonly usedWeight: number;
      /** The pair counter after the charge, when one was charged. */
      readonly usedTrading: number | null;
      readonly remainingForPriority: number;
      readonly at: Timestamp;
    }
  | {
      readonly granted: false;
      readonly reason: AcquireDenialReason;
      /**
       * The ticket to re-present, or null when re-presenting is pointless
       * because no amount of waiting can satisfy this request.
       */
      readonly ticketId: string | null;
      readonly retryAfterMs: number;
      /** 0-based position among live tickets, in service order. */
      readonly queuePosition: number;
      readonly usedWeight: number;
      readonly remainingForPriority: number;
      readonly at: Timestamp;
    };

/** One pair's matching-engine counter, for the dashboard and for tests. */
export interface TradingCounterStats {
  readonly pair: string;
  readonly limit: number;
  readonly decayPerSecond: number;
  readonly usedWeight: number;
  readonly remainingRoutine: number;
  readonly remainingRiskExit: number;
}

/** A read-only view, for the dashboard and for assertions in tests. */
export interface RateLimiterStats {
  readonly exchange: ExchangeId | null;
  readonly limit: number;
  /**
   * The account counter's horizon: the window on a sliding budget, the drain
   * time on a decaying one. Named as it always was so existing readers keep
   * working, but it is no longer always a window -- `shape` says which.
   */
  readonly windowMs: number;
  readonly shape: "sliding" | "decaying";
  readonly reserveForRiskExit: number;
  readonly limitSource: LimitSource;
  readonly usedWeight: number;
  readonly remainingRoutine: number;
  readonly remainingRiskExit: number;
  readonly queued: number;
  readonly queuedRiskExit: number;
  /** Empty on a venue with no per-pair counter, and before any order traffic. */
  readonly trading: readonly TradingCounterStats[];
}

/** Overridable dependencies, following `BotInstance.attach`. */
export interface RateLimiterDependencies {
  readonly now: () => Timestamp;
  readonly newId: () => string;
}

interface Ticket {
  readonly id: string;
  /** The whole vector, because a claim is held on every counter it names. */
  readonly cost: AcquireCost;
  readonly priority: RequestPriority;
  /** When it FIRST queued. This is what gives it its place; never updated. */
  readonly queuedAt: Timestamp;
  /** Last time the caller re-presented it, for TTL sweeping. */
  lastSeenAt: Timestamp;
  readonly label: string;
}

// ---------------------------------------------------------------------------

export class RateLimiter extends DurableObject<Env> {
  /**
   * The account-wide counter. A `WeightBudget` or a `DecayingCounter` depending
   * on the venue; the grant logic below never asks which.
   */
  #budget: Budget;
  /**
   * The venue this object is serving, learned from the first request and then
   * enforced. `null` only before any request has arrived.
   */
  #exchange: ExchangeId | null = null;
  /**
   * One decaying counter per pair that has traded (decision-log 90 PROBLEM 2 b).
   *
   * Created lazily and never removed. Lazily, because an account may trade two
   * pairs out of a 1440-pair catalogue and pre-building the rest would persist a
   * map of empty counters on every grant; never removed, because a counter that
   * has decayed to zero is indistinguishable from one that was never charged,
   * and dropping it at the wrong moment forgets a spend.
   */
  readonly #trading = new Map<string, DecayingCounter>();
  #limitSource: LimitSource = "default";
  /**
   * Live tickets, in memory only and deliberately not persisted.
   *
   * A ticket represents a caller currently sleeping and about to come back. It
   * has no meaning once that caller is gone, and persisting it would mean an
   * evicted object waking up to enforce claims on behalf of callers that no
   * longer exist -- holding budget for nobody, which is worse than losing a
   * queue position.
   */
  readonly #tickets = new Map<string, Ticket>();
  #dependencies: RateLimiterDependencies = {
    now: () => Date.now(),
    newId: () => crypto.randomUUID(),
  };

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Binance's shape until a request says otherwise. The venue is not known
    // until the first `acquire`, and this object must hold SOMETHING in the
    // meantime; `#adoptExchange` replaces it before anything is granted.
    this.#budget = buildAccountBudget(VENUE_BUDGET_MODELS.binance);

    // Nothing may be granted against an empty budget before the persisted
    // state has been read back, so this blocks rather than racing the first
    // `acquire`.
    ctx.blockConcurrencyWhile(async () => {
      const stored = await ctx.storage.get<PersistedState | LegacyPersistedState>(STATE_KEY);
      if (stored === undefined) return;

      if (isLegacy(stored)) {
        // Written before Kraken existed, so it can only be a sliding budget and
        // the venue it belonged to is not recorded. Left as `null`, which the
        // first request then fills in -- and if that request names Kraken, the
        // spend is carried across rather than discarded. See `#adoptExchange`.
        const budget = new WeightBudget({
          limit: stored.limit,
          windowMs: stored.windowMs,
          reserveForRiskExit: stored.reserveForRiskExit,
        });
        budget.restore(stored.snapshot);
        this.#budget = budget;
        this.#limitSource = stored.limitSource;
        return;
      }

      this.#exchange = stored.exchange;
      this.#limitSource = stored.limitSource;

      if (stored.account.shape === "sliding") {
        const budget = new WeightBudget({
          limit: stored.account.limit,
          windowMs: stored.account.windowMs,
          reserveForRiskExit: stored.account.reserveForRiskExit,
        });
        budget.restore(stored.account.snapshot);
        this.#budget = budget;
      } else {
        const budget = new DecayingCounter({
          limit: stored.account.limit,
          decayPerSecond: stored.account.decayPerSecond,
          reserveForRiskExit: stored.account.reserveForRiskExit,
        });
        budget.restore(stored.account.snapshot);
        this.#budget = budget;
      }

      for (const entry of stored.trading) {
        const counter = new DecayingCounter({
          limit: entry.limit,
          decayPerSecond: entry.decayPerSecond,
          reserveForRiskExit: entry.reserveForRiskExit,
        });
        counter.restore(entry.snapshot);
        this.#trading.set(entry.pair, counter);
      }
    });
  }

  /** Override the clock and id source. Tests only; production uses defaults. */
  attach(dependencies: Partial<RateLimiterDependencies>): void {
    this.#dependencies = {
      now: dependencies.now ?? this.#dependencies.now,
      newId: dependencies.newId ?? this.#dependencies.newId,
    };
  }

  // -------------------------------------------------------------------------
  // Granting budget
  // -------------------------------------------------------------------------

  /**
   * Ask for budget. Section 5.4's "request budget from this object before
   * calling Binance".
   *
   * The ORDER of operations inside this method is the load-bearing part, and it
   * is why `WeightBudget.consume` is synchronous. The budget is consumed in
   * memory FIRST, and only then persisted. If it were the other way round --
   * check, await the write, then record -- two `acquire` calls could both pass
   * the check while the first was suspended on its storage write, and both be
   * granted the same weight. A Durable Object serialises nothing across an
   * `await`; that is the same class of race step 5 had to defeat in the capital
   * ledger, and `rate-limiter.test.ts` forces it deterministically rather than
   * trusting the reasoning.
   */
  async acquire(request: AcquireRequest): Promise<AcquireResult> {
    const now = this.#dependencies.now();

    // In memory only, and before the sweep, so that nothing below can be
    // granted against another venue's mechanics. No `await` on this path.
    if (!this.#adoptExchange(request.exchange)) {
      this.#drop(request.ticketId);
      return {
        granted: false,
        reason: "wrong_exchange",
        ticketId: null,
        retryAfterMs: 0,
        queuePosition: 0,
        usedWeight: this.#budget.usedWeight(now),
        remainingForPriority: this.#budget.remainingFor(request.priority, now),
        at: now,
      };
    }

    this.#sweep(now);

    const { priority } = request;
    const charges = this.#chargesFor(request);

    // A charge larger than its counter's entire share for this priority can
    // never succeed, so it gets no ticket: queueing it would leave the caller
    // retrying forever and would block everything behind it while doing so.
    for (const charge of charges) {
      if (charge.amount > charge.budget.ceilingFor(priority)) {
        this.#drop(request.ticketId);
        return {
          granted: false,
          reason: "weight_exceeds_limit",
          ticketId: null,
          retryAfterMs: 0,
          queuePosition: 0,
          usedWeight: this.#budget.usedWeight(now),
          remainingForPriority: this.#remainingAcross(charges, priority, now),
          at: now,
        };
      }
    }

    const existing = this.#resolveTicket(request, now);
    const claimed = this.#claimedAhead(existing, request);

    // Everything queued ahead has a claim, PER COUNTER. Ignoring those claims is
    // what would let a late routine request overtake a waiting risk-exit one,
    // and a stream of small requests overtake a large one -- the head-of-line
    // case. Two requests that share no counter do not block each other at all,
    // which is the whole point of keeping the pair counters apart.
    const blocked = charges.filter((charge) => {
      const ahead = claimed.get(charge.key) ?? 0;
      const remaining = Math.max(
        0,
        charge.budget.ceilingFor(priority) - charge.budget.usedWeight(now),
      );
      return charge.amount + ahead > remaining;
    });

    if (blocked.length > 0) {
      const ticket = existing ?? this.#issue(request, now);
      // The longest of the waits, because the call needs EVERY counter it names
      // and is not sendable until the last of them has room.
      const retryAfterMs = Math.max(
        ...blocked.map((charge) => {
          const ahead = claimed.get(charge.key) ?? 0;
          const ceiling = charge.budget.ceilingFor(priority);
          return charge.budget.waitFor(
            Math.min(charge.amount + ahead, ceiling),
            priority,
            now,
          );
        }),
      );
      const onlyQueued = blocked.every((charge) => {
        const ahead = claimed.get(charge.key) ?? 0;
        const remaining = Math.max(
          0,
          charge.budget.ceilingFor(priority) - charge.budget.usedWeight(now),
        );
        return ahead > 0 && charge.amount <= remaining;
      });
      return {
        granted: false,
        // Distinguished so a caller can tell "the account is out of budget"
        // from "you are behind something", which read identically otherwise
        // and mean different things on a dashboard.
        reason: onlyQueued ? "queued_behind" : "budget_exhausted",
        ticketId: ticket.id,
        retryAfterMs: Math.max(1, retryAfterMs),
        queuePosition: this.#positionOf(ticket),
        usedWeight: this.#budget.usedWeight(now),
        remainingForPriority: this.#remainingAcross(charges, priority, now),
        at: now,
      };
    }

    // Synchronous, and ALL OF THEM, before any await. See the method comment.
    // Partially charging and then suspending would leave one counter spent for a
    // call that never went, which is the one outcome worse than refusing it.
    for (const charge of charges) {
      const decision = charge.budget.consume(charge.amount, priority, now);
      if (!decision.allowed) {
        // Unreachable: the arithmetic above already established every charge
        // fits. Kept as a guard so a future change to either side fails loudly
        // here rather than silently granting budget a counter refused.
        throw new RateLimiterError(
          `internal inconsistency: ${charge.key} refused ${charge.amount} ` +
            `(${decision.reason}) after the grant check passed`,
        );
      }
    }

    this.#drop(existing?.id ?? request.ticketId);
    await this.#persist();

    const tradingCounter =
      request.cost.trading === undefined
        ? null
        : (this.#trading.get(request.cost.trading.pair) ?? null);

    return {
      granted: true,
      cost: request.cost,
      usedWeight: this.#budget.usedWeight(now),
      usedTrading: tradingCounter === null ? null : tradingCounter.usedWeight(now),
      remainingForPriority: this.#remainingAcross(charges, priority, now),
      at: now,
    };
  }

  /**
   * Give up a queue place without having been granted anything.
   *
   * Called by a caller that has stopped waiting. Without it the ticket lingers
   * until its TTL, claiming weight for a request nobody intends to send.
   */
  async release(ticketId: string): Promise<void> {
    this.#drop(ticketId);
  }

  // -------------------------------------------------------------------------
  // Learning the truth from the exchange (section 5.4)
  // -------------------------------------------------------------------------

  /**
   * The used weight the exchange itself reported, from a response header.
   *
   * This is the `WeightReporter` half of the contract, and it is the reason the
   * budget can be right about traffic this object never granted: another client
   * on the same API key, or a request whose weight this system misjudged. It
   * only ever RAISES the local figure -- a stale low reading must never re-open
   * a budget that has been spent.
   */
  /**
   * ⚠ THE SEAM FOR KRAKEN'S FEEDBACK CHANNEL. NOT WIRED IN THIS SESSION.
   *
   * Decision-log 90 recorded that Kraken offers no feedback at all. That is
   * CORRECT FOR REST and wrong as a general claim, and the re-verification this
   * session did is what caught it: Kraken sends no rate-limit headers on any
   * response -- confirmed live on both a public and an authenticated call, and
   * its `access-control-expose-headers` lists nothing rate-related, so there is
   * not even a hidden one -- but the TRADING counter is published. Subscribing
   * to WebSocket v2 `executions` with `ratecounter: true` yields:
   *
   *   `ratecount`    -- "the value of the user's trading rate-limit counter at
   *                     the time of the event, as evaluated by the trading
   *                     engine", per pair.
   *   `maxratecount` -- "the max rate counter value for the user transaction
   *                     rate. It is based on user tier", on the snapshot.
   *
   * `maxratecount` is the more valuable of the two: it means the tier does not
   * have to be configured or guessed. A limiter started on Starter's
   * conservative threshold learns the account's real one from its own traffic,
   * and `limitSource` becomes `exchangeCounter` to say so.
   *
   * The subscription itself is deliberately NOT built here -- it is a persistent
   * WebSocket held somewhere, which is real scope and its own decision. This
   * signature exists so that adding it later changes a caller and nothing else;
   * in particular `RateLimiterPort` is untouched by it.
   *
   * ---------------------------------------------------------------------------
   * WHY ONE UNION SIGNATURE AND NOT TWO OVERLOADS
   * ---------------------------------------------------------------------------
   * It WAS two overloads, which read far better. A `DurableObjectStub<T>` is
   * built by a mapped type, and a mapped type keeps only the LAST signature of
   * an overloaded method -- so the stub stopped satisfying `WeightReporter`, and
   * `workers/exchange.ts` would no longer hand the limiter to `BinanceClient`.
   * That is a real constraint of the platform's types, not a style choice, so
   * the two shapes share one signature and are told apart by the first argument:
   * a number is the account-wide counter, a pair is the per-pair one.
   */
  async syncFromExchange(
    first: number | string,
    second: number,
    third?: number | null,
    fourth?: Timestamp,
  ): Promise<void> {
    if (typeof first === "number") {
      // The account-wide counter: Binance's `X-MBX-USED-WEIGHT` header path,
      // unchanged. Kraken never reaches it, because Kraken sends no such header.
      this.#budget.syncFromExchange(first, second);
      await this.#persist();
      return;
    }

    if (fourth === undefined) {
      throw new RateLimiterError(
        `the per-pair form of syncFromExchange takes (pair, ratecount, ` +
          `maxratecount, at); no timestamp was given for ${first}`,
      );
    }
    const at = fourth;
    const counter = this.#tradingCounterFor(first);

    // A reported threshold is the venue telling us the tier we assumed was
    // wrong. Rebuild on it rather than mutate, for the reason `syncLimit` does:
    // a limit is taken at construction and treated as immutable, which is the
    // right call for a value that decides whether an order may be sent.
    const reportedLimit = third ?? null;
    if (
      reportedLimit !== null &&
      Number.isFinite(reportedLimit) &&
      reportedLimit > 0 &&
      reportedLimit !== counter.limit
    ) {
      const snapshot = counter.snapshot();
      const rebuilt = new DecayingCounter({
        limit: reportedLimit,
        decayPerSecond: counter.decayPerSecond,
        reserveForRiskExit: reserveFor(reportedLimit),
      });
      // The spend already made is still real, whatever the ceiling turned out
      // to be. Discarding it would hand a fresh counter to a pair that had just
      // spent one.
      rebuilt.restore(snapshot);
      rebuilt.syncFromExchange(second, at);
      this.#trading.set(first, rebuilt);
      this.#limitSource = "exchangeCounter";
      await this.#persist();
      return;
    }

    counter.syncFromExchange(second, at);
    await this.#persist();
  }

  /**
   * The account's ceiling, read from an `exchangeInfo` body.
   *
   * Rebuilds the budget rather than mutating it, carrying the current window
   * across, because `WeightBudget` takes its limit at construction and treats
   * it as immutable -- which is the right call for a value that decides whether
   * an order may be sent.
   */
  async syncLimit(limit: number, windowMs: number, at: Timestamp): Promise<void> {
    if (!Number.isFinite(limit) || limit <= 0) {
      throw new RateLimiterError(`limit must be positive, got ${limit}`);
    }
    if (!Number.isFinite(windowMs) || windowMs <= 0) {
      throw new RateLimiterError(`windowMs must be positive, got ${windowMs}`);
    }

    // `exchangeInfo` is Binance's shape. A venue whose account counter decays
    // publishes no such document, and rebuilding a decaying counter as a sliding
    // one would silently swap the mechanics underneath a live budget. A call
    // that gets here on Kraken is a wiring bug, so it fails loudly.
    const current = this.#budget;
    if (!(current instanceof WeightBudget)) {
      throw new RateLimiterError(
        `syncLimit describes a windowed weight budget, but this limiter is ` +
          `serving ${this.#exchange ?? "an unknown venue"}, whose account ` +
          `counter decays. Nothing was changed.`,
      );
    }

    const unchanged =
      limit === current.limit &&
      windowMs === current.windowMs &&
      this.#limitSource === "exchangeInfo";
    if (unchanged) return;

    const snapshot = current.snapshot();
    const rebuilt = new WeightBudget({
      limit,
      windowMs,
      reserveForRiskExit: reserveFor(limit),
    });
    this.#budget = rebuilt;
    // The spend already made is still real, whatever the ceiling turned out to
    // be. Discarding it on a limit change would hand back a fresh budget to an
    // account that had just spent one.
    rebuilt.restore(snapshot);
    this.#limitSource = "exchangeInfo";
    void at;
    await this.#persist();
  }

  // -------------------------------------------------------------------------
  // Reading
  // -------------------------------------------------------------------------

  async stats(): Promise<RateLimiterStats> {
    const now = this.#dependencies.now();
    this.#sweep(now);
    const live = [...this.#tickets.values()];
    return {
      exchange: this.#exchange,
      limit: this.#budget.limit,
      windowMs: this.#budget.horizonMs,
      shape: this.#budget instanceof WeightBudget ? "sliding" : "decaying",
      reserveForRiskExit: this.#budget.reserveForRiskExit,
      limitSource: this.#limitSource,
      usedWeight: this.#budget.usedWeight(now),
      remainingRoutine: this.#budget.remainingFor("routine", now),
      remainingRiskExit: this.#budget.remainingFor("risk-exit", now),
      queued: live.length,
      queuedRiskExit: live.filter((ticket) => ticket.priority === "risk-exit").length,
      trading: [...this.#trading.entries()]
        .map(([pair, counter]) => ({
          pair,
          limit: counter.limit,
          decayPerSecond: counter.decayPerSecond,
          usedWeight: counter.usedWeight(now),
          remainingRoutine: counter.remainingFor("routine", now),
          remainingRiskExit: counter.remainingFor("risk-exit", now),
        }))
        // Stable order, so a dashboard and a test assertion both see the same
        // list whatever order the pairs happened to first trade in.
        .sort((a, b) => a.pair.localeCompare(b.pair)),
    };
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  async #persist(): Promise<void> {
    const budget = this.#budget;
    const account: PersistedAccountBudget =
      budget instanceof WeightBudget
        ? {
            shape: "sliding",
            limit: budget.limit,
            windowMs: budget.windowMs,
            reserveForRiskExit: budget.reserveForRiskExit,
            snapshot: budget.snapshot(),
          }
        : {
            shape: "decaying",
            limit: budget.limit,
            decayPerSecond: (budget as DecayingCounter).decayPerSecond,
            reserveForRiskExit: budget.reserveForRiskExit,
            snapshot: (budget as DecayingCounter).snapshot(),
          };

    const state: PersistedState = {
      exchange: this.#exchange,
      account,
      trading: [...this.#trading.entries()].map(([pair, counter]) => ({
        pair,
        limit: counter.limit,
        decayPerSecond: counter.decayPerSecond,
        reserveForRiskExit: counter.reserveForRiskExit,
        snapshot: counter.snapshot(),
      })),
      limitSource: this.#limitSource,
    };
    await this.ctx.storage.put(STATE_KEY, state);
  }

  /** Forget tickets whose caller has stopped coming back. */
  #sweep(now: Timestamp): void {
    const ttl = ticketTtlMs(this.#budget.horizonMs);
    for (const [id, ticket] of this.#tickets) {
      if (now - ticket.lastSeenAt > ttl) this.#tickets.delete(id);
    }
  }

  /**
   * The caller's existing ticket, if it still holds one.
   *
   * An unrecognised ticket id is NOT an error. It is the ordinary consequence
   * of the object having been evicted, or of the TTL having swept it, and the
   * caller is simply treated as a new arrival -- which costs it its place and
   * nothing else.
   */
  #resolveTicket(request: AcquireRequest, now: Timestamp): Ticket | undefined {
    if (request.ticketId === undefined) return undefined;
    const ticket = this.#tickets.get(request.ticketId);
    if (ticket === undefined) return undefined;
    ticket.lastSeenAt = now;
    return ticket;
  }

  #issue(request: AcquireRequest, now: Timestamp): Ticket {
    const ticket: Ticket = {
      id: this.#dependencies.newId(),
      cost: request.cost,
      priority: request.priority,
      queuedAt: now,
      lastSeenAt: now,
      label: request.label ?? "unlabelled",
    };
    this.#tickets.set(ticket.id, ticket);
    return ticket;
  }

  #drop(ticketId: string | undefined): void {
    if (ticketId !== undefined) this.#tickets.delete(ticketId);
  }

  /** Live tickets in service order: risk-exit first, then oldest first. */
  #ordered(): PendingRequest<Ticket>[] {
    return prioritize(
      [...this.#tickets.values()].map((ticket) => ({
        // `prioritize` orders by priority then arrival and never reads this;
        // the total is carried only so the queue is inspectable in a debugger.
        weight: totalCost(ticket.cost),
        priority: ticket.priority,
        queuedAt: ticket.queuedAt,
        payload: ticket,
      })),
    );
  }

  /**
   * What everything served before this request claims, PER COUNTER.
   *
   * A caller HOLDING a ticket is measured from its ticket's place. A caller
   * without one is a new arrival and therefore sorts behind every live ticket
   * of its own priority, so everything of equal or higher priority is ahead of
   * it. That asymmetry is the point: re-presenting a ticket is what preserves a
   * place, and arriving fresh is what forfeits one.
   *
   * Keyed rather than totalled, which is the change the second budget forced. A
   * single total would have made a cancel queued on `BTC/USD` hold back a cancel
   * on `ARB/USD` that shares none of its counters -- refusing traffic the venue
   * would have taken, on the risk-exit path, which is the direction that costs
   * money rather than the direction that is merely slow.
   */
  #claimedAhead(existing: Ticket | undefined, request: AcquireRequest): Map<string, number> {
    const rank = (priority: RequestPriority): number => (priority === "risk-exit" ? 0 : 1);
    const claims = new Map<string, number>();

    for (const entry of this.#ordered()) {
      const ticket = entry.payload;
      if (existing !== undefined) {
        if (ticket.id === existing.id) break;
      } else {
        // A new arrival sorts after every live ticket at the same rank, so only
        // a strictly LOWER-ranked (i.e. lower priority) ticket is behind it.
        if (rank(ticket.priority) > rank(request.priority)) break;
      }
      for (const [key, amount] of costKeys(ticket.cost)) {
        claims.set(key, (claims.get(key) ?? 0) + amount);
      }
    }

    return claims;
  }

  // -------------------------------------------------------------------------
  // Venue and cost resolution
  // -------------------------------------------------------------------------

  /**
   * Bind this object to a venue, or report that it is already bound elsewhere.
   *
   * Returns `false` on a mismatch rather than throwing, because it is answering
   * a question about a request rather than about this object's own consistency,
   * and `acquire` turns it into an ordinary non-retryable refusal.
   *
   * Rebuilding on adoption is safe in the one case it can happen. A limiter is
   * named after an account label and an account has exactly one exchange, so the
   * only way an object holding a budget meets a new venue is a limiter restored
   * from the pre-Kraken persisted shape, which recorded no venue and could only
   * ever have been Binance's or Gemini's. Starting a Kraken counter at zero for
   * an account that has made no Kraken call is correct; carrying a spend across
   * would be nonsense, since 1200 units of Binance request weight and 15 units of
   * Kraken call counter are not the same currency.
   */
  #adoptExchange(exchange: ExchangeId): boolean {
    if (this.#exchange === exchange) return true;
    if (this.#exchange !== null) return false;

    this.#exchange = exchange;
    const model = VENUE_BUDGET_MODELS[exchange];
    const alreadyRightShape =
      model.shape === "sliding"
        ? this.#budget instanceof WeightBudget
        : this.#budget instanceof DecayingCounter;

    // ONLY on a genuine shape change. Rebuilding whenever the venue is first
    // named would throw away a budget restored from storage -- including one
    // restored from the legacy shape, which is exactly the state that has spend
    // in it and no venue recorded -- and hand a fresh ceiling to an account that
    // had already spent one. That is the double-rate failure the persistence
    // exists to prevent, arriving through the door built to prevent it.
    if (!alreadyRightShape) {
      this.#budget = buildAccountBudget(model);
      // The old source described the old budget. A ceiling read from Binance's
      // `exchangeInfo` says nothing about a Kraken counter.
      this.#limitSource = "default";
    }
    return true;
  }

  /**
   * The counter for one pair, created on first use.
   *
   * Throws if the venue has none: a trading charge arriving at a limiter for a
   * venue that meters order traffic out of the account budget means the cost
   * table and the venue model disagree, and inventing a counter to hold it would
   * hide that rather than surface it.
   */
  #tradingCounterFor(pair: string): DecayingCounter {
    const existing = this.#trading.get(pair);
    if (existing !== undefined) return existing;

    const model = VENUE_BUDGET_MODELS[this.#exchange ?? "binance"];
    if (model.trading === null) {
      throw new RateLimiterError(
        `a per-pair trading charge arrived for ${pair}, but ` +
          `${this.#exchange ?? "this venue"} has no matching-engine counter. ` +
          `The cost table and the venue model disagree.`,
      );
    }

    const counter = new DecayingCounter({
      limit: model.trading.threshold,
      decayPerSecond: model.trading.decayPerSecond,
      reserveForRiskExit: reserveFor(model.trading.threshold),
    });
    this.#trading.set(pair, counter);
    return counter;
  }

  /** The counters this request actually spends, with the amount for each. */
  #chargesFor(
    request: AcquireRequest,
  ): { key: string; budget: Budget; amount: number }[] {
    const { rest, trading } = request.cost;

    if (!Number.isFinite(rest) || rest < 0) {
      throw new RateLimiterError(`cost.rest must be non-negative, got ${rest}`);
    }
    if (trading !== undefined) {
      if (!Number.isFinite(trading.count) || trading.count < 0) {
        throw new RateLimiterError(
          `cost.trading.count must be non-negative, got ${trading.count}`,
        );
      }
      if (trading.pair === "") {
        throw new RateLimiterError("cost.trading.pair must not be empty");
      }
    }

    const charges: { key: string; budget: Budget; amount: number }[] = [];
    if (rest > 0) charges.push({ key: "rest", budget: this.#budget, amount: rest });
    if (trading !== undefined && trading.count > 0) {
      charges.push({
        key: `trading:${trading.pair}`,
        budget: this.#tradingCounterFor(trading.pair),
        amount: trading.count,
      });
    }

    if (charges.length === 0) {
      // Every counter priced this call at zero, so there is nothing to hold it
      // back and nothing to record. `METHOD_COSTS` floors the account component
      // at one unit for exactly this reason; reaching here means a table stopped
      // doing that, which is an unmeasured path through the gate.
      throw new RateLimiterError(
        `${request.label ?? "a request"} costs nothing on any counter, so the ` +
          `gate would not be measuring it. Every method needs a positive cost.`,
      );
    }
    return charges;
  }

  /**
   * The tightest headroom across the counters a request touches.
   *
   * The minimum rather than a sum, because a call is limited by whichever of its
   * counters has least room -- reporting anything else would tell a dashboard
   * there was budget for traffic that cannot go.
   */
  #remainingAcross(
    charges: readonly { budget: Budget; amount: number }[],
    priority: RequestPriority,
    now: Timestamp,
  ): number {
    if (charges.length === 0) return 0;
    return Math.min(...charges.map((charge) => charge.budget.remainingFor(priority, now)));
  }

  #positionOf(ticket: Ticket): number {
    return this.#ordered().findIndex((entry) => entry.payload.id === ticket.id);
  }
}
