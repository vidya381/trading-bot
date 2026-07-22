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
  prioritize,
  RateLimiterError,
  WeightBudget,
  type PendingRequest,
  type RateLimitDenialReason,
  type RequestPriority,
  type WeightBudgetSnapshot,
} from "../shared/rate-limiter";

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
 * Set from the window plus a grace period, because a caller's longest possible
 * sleep is bounded by the window -- everything in a rolling window has aged out
 * after one. A caller that dies mid-wait therefore holds its claim for at most
 * a window and a few seconds, and only against requests queued BEHIND it.
 */
function ticketTtlMs(windowMs: number): number {
  return windowMs + 5_000;
}

const STATE_KEY = "budget";

/** What survives eviction. */
interface PersistedState {
  readonly limit: number;
  readonly windowMs: number;
  readonly reserveForRiskExit: number;
  readonly snapshot: WeightBudgetSnapshot;
  /** Where the current limit came from, for the dashboard and for tests. */
  readonly limitSource: "default" | "exchangeInfo";
}

// ---------------------------------------------------------------------------
// The RPC surface
// ---------------------------------------------------------------------------

export interface AcquireRequest {
  /** Documented weight of the endpoint about to be called. */
  readonly weight: number;
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
  | "queued_behind";

export type AcquireResult =
  | {
      readonly granted: true;
      readonly weight: number;
      readonly usedWeight: number;
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

/** A read-only view, for the dashboard and for assertions in tests. */
export interface RateLimiterStats {
  readonly limit: number;
  readonly windowMs: number;
  readonly reserveForRiskExit: number;
  readonly limitSource: "default" | "exchangeInfo";
  readonly usedWeight: number;
  readonly remainingRoutine: number;
  readonly remainingRiskExit: number;
  readonly queued: number;
  readonly queuedRiskExit: number;
}

/** Overridable dependencies, following `BotInstance.attach`. */
export interface RateLimiterDependencies {
  readonly now: () => Timestamp;
  readonly newId: () => string;
}

interface Ticket {
  readonly id: string;
  readonly weight: number;
  readonly priority: RequestPriority;
  /** When it FIRST queued. This is what gives it its place; never updated. */
  readonly queuedAt: Timestamp;
  /** Last time the caller re-presented it, for TTL sweeping. */
  lastSeenAt: Timestamp;
  readonly label: string;
}

// ---------------------------------------------------------------------------

export class RateLimiter extends DurableObject<Env> {
  #budget: WeightBudget;
  #limitSource: "default" | "exchangeInfo" = "default";
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
    this.#budget = new WeightBudget({
      limit: DEFAULT_WEIGHT_LIMIT,
      windowMs: DEFAULT_WINDOW_MS,
      reserveForRiskExit: Math.floor(DEFAULT_WEIGHT_LIMIT * RISK_EXIT_RESERVE_FRACTION),
    });

    // Nothing may be granted against an empty budget before the persisted
    // window has been read back, so this blocks rather than racing the first
    // `acquire`.
    ctx.blockConcurrencyWhile(async () => {
      const stored = await ctx.storage.get<PersistedState>(STATE_KEY);
      if (stored === undefined) return;
      this.#budget = new WeightBudget({
        limit: stored.limit,
        windowMs: stored.windowMs,
        reserveForRiskExit: stored.reserveForRiskExit,
      });
      this.#budget.restore(stored.snapshot);
      this.#limitSource = stored.limitSource;
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
    this.#sweep(now);

    const { weight, priority } = request;
    if (!Number.isFinite(weight) || weight <= 0) {
      throw new RateLimiterError(`weight must be positive, got ${weight}`);
    }

    const ceiling = this.#budget.ceilingFor(priority);
    const used = this.#budget.usedWeight(now);
    const remaining = Math.max(0, ceiling - used);

    // A request larger than this priority's entire share can never succeed, so
    // it gets no ticket: queueing it would leave the caller retrying forever
    // and would block everything behind it while doing so.
    if (weight > ceiling) {
      this.#drop(request.ticketId);
      return {
        granted: false,
        reason: "weight_exceeds_limit",
        ticketId: null,
        retryAfterMs: 0,
        queuePosition: 0,
        usedWeight: used,
        remainingForPriority: remaining,
        at: now,
      };
    }

    const existing = this.#resolveTicket(request, now);
    const claimedBefore = this.#claimedAhead(existing, request);

    // Everything queued ahead has a claim on the budget. Ignoring those claims
    // is what would let a late routine request overtake a waiting risk-exit
    // one, and a stream of small requests overtake a large one -- the
    // head-of-line case.
    if (weight + claimedBefore > remaining) {
      const ticket = existing ?? this.#issue(request, now);
      const need = Math.min(weight + claimedBefore, ceiling);
      return {
        granted: false,
        // Distinguished so a caller can tell "the account is out of budget"
        // from "you are behind something", which read identically otherwise
        // and mean different things on a dashboard.
        reason: claimedBefore > 0 && weight <= remaining ? "queued_behind" : "budget_exhausted",
        ticketId: ticket.id,
        retryAfterMs: Math.max(1, this.#budget.waitFor(need, priority, now)),
        queuePosition: this.#positionOf(ticket),
        usedWeight: used,
        remainingForPriority: remaining,
        at: now,
      };
    }

    // Synchronous, before any await. See the method comment.
    const decision = this.#budget.consume(weight, priority, now);
    if (!decision.allowed) {
      // Unreachable: the arithmetic above already established it fits. Kept as
      // a guard so a future change to either side fails loudly here rather than
      // silently granting weight the budget refused.
      const ticket = existing ?? this.#issue(request, now);
      return {
        granted: false,
        reason: decision.reason,
        ticketId: ticket.id,
        retryAfterMs: Math.max(1, decision.retryAfterMs),
        queuePosition: this.#positionOf(ticket),
        usedWeight: decision.usedWeight,
        remainingForPriority: decision.remainingForPriority,
        at: now,
      };
    }

    this.#drop(existing?.id ?? request.ticketId);
    await this.#persist();

    return {
      granted: true,
      weight,
      usedWeight: this.#budget.usedWeight(now),
      remainingForPriority: decision.remainingForPriority,
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
  async syncFromExchange(usedWeight: number, at: Timestamp): Promise<void> {
    this.#budget.syncFromExchange(usedWeight, at);
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

    const unchanged =
      limit === this.#budget.limit &&
      windowMs === this.#budget.windowMs &&
      this.#limitSource === "exchangeInfo";
    if (unchanged) return;

    const snapshot = this.#budget.snapshot();
    this.#budget = new WeightBudget({
      limit,
      windowMs,
      reserveForRiskExit: Math.floor(limit * RISK_EXIT_RESERVE_FRACTION),
    });
    // The spend already made is still real, whatever the ceiling turned out to
    // be. Discarding it on a limit change would hand back a fresh budget to an
    // account that had just spent one.
    this.#budget.restore(snapshot);
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
      limit: this.#budget.limit,
      windowMs: this.#budget.windowMs,
      reserveForRiskExit: this.#budget.reserveForRiskExit,
      limitSource: this.#limitSource,
      usedWeight: this.#budget.usedWeight(now),
      remainingRoutine: this.#budget.remainingFor("routine", now),
      remainingRiskExit: this.#budget.remainingFor("risk-exit", now),
      queued: live.length,
      queuedRiskExit: live.filter((ticket) => ticket.priority === "risk-exit").length,
    };
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  async #persist(): Promise<void> {
    const state: PersistedState = {
      limit: this.#budget.limit,
      windowMs: this.#budget.windowMs,
      reserveForRiskExit: this.#budget.reserveForRiskExit,
      snapshot: this.#budget.snapshot(),
      limitSource: this.#limitSource,
    };
    await this.ctx.storage.put(STATE_KEY, state);
  }

  /** Forget tickets whose caller has stopped coming back. */
  #sweep(now: Timestamp): void {
    const ttl = ticketTtlMs(this.#budget.windowMs);
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
      weight: request.weight,
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
        weight: ticket.weight,
        priority: ticket.priority,
        queuedAt: ticket.queuedAt,
        payload: ticket,
      })),
    );
  }

  /**
   * Total weight claimed by everything that must be served before this request.
   *
   * A caller HOLDING a ticket is measured from its ticket's place. A caller
   * without one is a new arrival and therefore sorts behind every live ticket
   * of its own priority, so everything of equal or higher priority is ahead of
   * it. That asymmetry is the point: re-presenting a ticket is what preserves a
   * place, and arriving fresh is what forfeits one.
   */
  #claimedAhead(existing: Ticket | undefined, request: AcquireRequest): number {
    const rank = (priority: RequestPriority): number => (priority === "risk-exit" ? 0 : 1);
    const ordered = this.#ordered();
    let total = 0;

    for (const entry of ordered) {
      const ticket = entry.payload;
      if (existing !== undefined) {
        if (ticket.id === existing.id) break;
      } else {
        // A new arrival sorts after every live ticket at the same rank, so only
        // a strictly LOWER-ranked (i.e. lower priority) ticket is behind it.
        if (rank(ticket.priority) > rank(request.priority)) break;
      }
      total += ticket.weight;
    }

    return total;
  }

  #positionOf(ticket: Ticket): number {
    return this.#ordered().findIndex((entry) => entry.payload.id === ticket.id);
  }
}
