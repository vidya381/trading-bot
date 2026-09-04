/**
 * Rate limiter (spec section 5.4).
 *
 * The rolling request-weight budget for ONE exchange account. Section 5.4 puts
 * this in a Durable Object; this module is the in-memory logic that object will
 * wrap at step 6, so it holds no storage and performs no I/O.
 *
 * Reading Binance's weight headers is section 4.2/4.3 work at step 3. This
 * module accepts an authoritative used-weight figure via `syncFromExchange` and
 * has no knowledge of where it came from.
 *
 * Time is always passed in. Nothing here calls Date.now(), so every window
 * boundary is exactly reproducible in a test.
 */

import type { Timestamp } from "./exchange-client";

/**
 * Request priority.
 *
 * Section 5.4 distinguishes exactly two classes. Getting out of a position is
 * never queued behind routine ladder maintenance.
 */
export type RequestPriority =
  /** Stop-loss, take-profit, halt-driven cancels: anything reducing risk. */
  | "risk-exit"
  /** Normal strategy traffic: placing ladder orders, polling status. */
  | "routine";

export interface WeightBudgetOptions {
  /** Total weight permitted within one window. */
  limit: number;
  /** Window length in milliseconds. Binance's request-weight window is 60s. */
  windowMs: number;
  /**
   * Weight held back for risk-exit traffic.
   *
   * Routine requests may only draw on `limit - reserveForRiskExit`. This is how
   * the priority in section 5.4 is enforced: a burst of routine orders cannot
   * consume the budget a stop-loss will need moments later.
   */
  reserveForRiskExit: number;
}

export type RateLimitDenialReason =
  /** The caller's share of the budget is exhausted for now. */
  | "budget_exhausted"
  /** A single request costs more than the whole limit; it can never succeed. */
  | "weight_exceeds_limit";

export type RateLimitDecision =
  | { allowed: true; remainingForPriority: number; usedWeight: number }
  | {
      allowed: false;
      reason: RateLimitDenialReason;
      /** How long until enough weight frees up, in milliseconds. */
      retryAfterMs: number;
      remainingForPriority: number;
      usedWeight: number;
    };

export class RateLimiterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RateLimiterError";
  }
}

export interface WeightEntry {
  at: Timestamp;
  weight: number;
}

/**
 * A budget's whole mutable state, for persisting and restoring it.
 *
 * Added at step 8, when the budget moved inside a Durable Object. A DO is
 * evicted after a short idle period, and this window is 60 seconds long: an
 * object that forgot its entries on eviction would wake believing the budget
 * untouched and permit a second full limit's worth of traffic inside one
 * window, which is the same failure a fixed window has and the reason this is
 * a sliding one.
 *
 * Plain data on purpose -- `structuredClone`-able, so it round-trips through
 * Durable Object storage with no encoding step (step 6, decision 4).
 */
export interface WeightBudgetSnapshot {
  readonly entries: readonly WeightEntry[];
  readonly exchangeReported: { usedWeight: number; at: Timestamp } | null;
}

/**
 * What the `RateLimiter` Durable Object needs from a budget, whichever shape it is.
 *
 * Introduced when Kraken's decaying counters arrived beside Binance's sliding
 * window. The Durable Object's grant logic -- ceiling, claims ahead, consume,
 * how long to wait -- is identical for both and should stay written once; the
 * ONLY thing that differs is how a charge stops counting over time.
 *
 * Deliberately structural rather than an inheritance hierarchy: `WeightBudget`
 * and `DecayingCounter` share no implementation, only an obligation, and a base
 * class would have nothing to put in it but the reserve arithmetic.
 */
export interface Budget {
  readonly limit: number;
  readonly reserveForRiskExit: number;
  readonly horizonMs: number;
  ceilingFor(priority: RequestPriority): number;
  usedWeight(now: Timestamp): number;
  remainingFor(priority: RequestPriority, now: Timestamp): number;
  check(weight: number, priority: RequestPriority, now: Timestamp): RateLimitDecision;
  consume(weight: number, priority: RequestPriority, now: Timestamp): RateLimitDecision;
  /**
   * Apply a charge THAT CANNOT BE REFUSED, even past the ceiling.
   *
   * ⚠ NOT A WAY AROUND `consume`, and the distinction is the venue's rather than
   * this system's. It exists for a call the EXCHANGE accepts unconditionally:
   * Kraken, beside its Batch Cancel cost row, "If the rate counter in the batch
   * exceeds maximum for a batch cancel, the requests in batch are still
   * accepted." For such a call, refusing locally would not protect the account
   * from anything -- the venue was never going to refuse it -- it would only stop
   * a halt from cancelling its orders, which is the risk control defeating
   * itself.
   *
   * The charge is still RECORDED, and that is the point of the method. Everything
   * issued after it must see the counter it left behind, including a counter it
   * pushed OVER the threshold: the next ordinary call then correctly waits for
   * the overshoot to decay rather than being granted budget the venue no longer
   * has.
   *
   * `consume` remains the only way an ordinary call spends anything, and the only
   * caller of this is the gate's batch-cancel path.
   */
  record(weight: number, now: Timestamp): void;
  syncFromExchange(value: number, at: Timestamp): void;
  reset(): void;
  waitFor(weight: number, priority: RequestPriority, now: Timestamp): number;
}

/**
 * A rolling request-weight budget.
 *
 * Sliding rather than fixed-window: entries are held with their timestamps and
 * expire individually. A fixed window would allow a full limit's worth of
 * traffic on either side of a boundary, i.e. double the intended rate across
 * the boundary, which is what gets an account rate-limited.
 */
export class WeightBudget implements Budget {
  readonly #limit: number;
  readonly #windowMs: number;
  readonly #reserve: number;
  #entries: WeightEntry[] = [];
  /** Weight the exchange itself reports, when it is ahead of local accounting. */
  #exchangeReported: { usedWeight: number; at: Timestamp } | null = null;

  constructor(options: WeightBudgetOptions) {
    const { limit, windowMs, reserveForRiskExit } = options;

    if (!Number.isFinite(limit) || limit <= 0) {
      throw new RateLimiterError(`limit must be positive, got ${limit}`);
    }
    if (!Number.isFinite(windowMs) || windowMs <= 0) {
      throw new RateLimiterError(`windowMs must be positive, got ${windowMs}`);
    }
    if (!Number.isFinite(reserveForRiskExit) || reserveForRiskExit < 0) {
      throw new RateLimiterError(
        `reserveForRiskExit must be non-negative, got ${reserveForRiskExit}`,
      );
    }
    if (reserveForRiskExit >= limit) {
      throw new RateLimiterError(
        `reserveForRiskExit (${reserveForRiskExit}) must be below limit (${limit}), ` +
          `otherwise routine traffic could never proceed`,
      );
    }

    this.#limit = limit;
    this.#windowMs = windowMs;
    this.#reserve = reserveForRiskExit;
  }

  get limit(): number {
    return this.#limit;
  }

  get windowMs(): number {
    return this.#windowMs;
  }

  get reserveForRiskExit(): number {
    return this.#reserve;
  }

  /**
   * How long until waiting stops being worth it.
   *
   * On a sliding window that is the window itself: everything inside one has
   * aged out after one. Named separately from `windowMs` so that callers which
   * only need "how long is the longest honest wait" -- the Durable Object's
   * ticket TTL, the gate's maximum wait -- can ask both budget shapes the same
   * question. `DecayingCounter` answers it with a drain time instead.
   */
  get horizonMs(): number {
    return this.#windowMs;
  }

  /** The ceiling a given priority may consume up to. */
  ceilingFor(priority: RequestPriority): number {
    return priority === "risk-exit" ? this.#limit : this.#limit - this.#reserve;
  }

  /** Weight consumed within the current window, as of `now`. */
  usedWeight(now: Timestamp): number {
    this.#expire(now);
    const local = this.#entries.reduce((total, entry) => total + entry.weight, 0);

    // Trust the exchange when it reports more than local accounting knows about
    // -- other clients, or requests whose weight was misjudged. Never trust it
    // to report less, or a stale low reading would re-open a spent budget.
    const reported = this.#exchangeReported;
    if (reported !== null && now - reported.at < this.#windowMs) {
      return Math.max(local, reported.usedWeight);
    }
    return local;
  }

  /** Weight still available to the given priority. Never negative. */
  remainingFor(priority: RequestPriority, now: Timestamp): number {
    return Math.max(0, this.ceilingFor(priority) - this.usedWeight(now));
  }

  /**
   * Ask whether a request may proceed, without consuming anything.
   *
   * Kept separate from `consume` so a caller can inspect the decision, and so
   * `consume` has one obvious place where budget is actually spent.
   */
  check(weight: number, priority: RequestPriority, now: Timestamp): RateLimitDecision {
    if (!Number.isFinite(weight) || weight <= 0) {
      throw new RateLimiterError(`weight must be positive, got ${weight}`);
    }

    const used = this.usedWeight(now);
    const ceiling = this.ceilingFor(priority);
    const remaining = Math.max(0, ceiling - used);

    if (weight > ceiling) {
      // No amount of waiting helps: the request is larger than this priority's
      // entire share. Surfaced distinctly so a caller does not retry forever.
      return {
        allowed: false,
        reason: "weight_exceeds_limit",
        retryAfterMs: 0,
        remainingForPriority: remaining,
        usedWeight: used,
      };
    }

    if (weight > remaining) {
      return {
        allowed: false,
        reason: "budget_exhausted",
        retryAfterMs: this.#waitFor(weight, ceiling, now),
        remainingForPriority: remaining,
        usedWeight: used,
      };
    }

    return { allowed: true, remainingForPriority: remaining - weight, usedWeight: used };
  }

  /**
   * Consume budget if available. Returns the same decision as `check`, and
   * records the weight only when it allows the request.
   */
  consume(weight: number, priority: RequestPriority, now: Timestamp): RateLimitDecision {
    const decision = this.check(weight, priority, now);
    if (decision.allowed) {
      this.#entries.push({ at: now, weight });
    }
    return decision;
  }

  /**
   * Charge unconditionally. See `Budget.record`.
   *
   * On a sliding window this is exactly `consume`'s effect without the check --
   * the entry ages out on the same schedule as any other, and no other part of
   * this class needs to know it arrived by a different door.
   *
   * Implemented here rather than left to throw because `Budget` is an obligation,
   * not a menu: a venue that gained an unconditional call on an account-wide
   * counter would otherwise fail at runtime instead of at the type. No venue does
   * today -- Kraken's is the only one, and it is on a `DecayingCounter`.
   */
  record(weight: number, now: Timestamp): void {
    if (!Number.isFinite(weight) || weight <= 0) {
      throw new RateLimiterError(`weight must be positive, got ${weight}`);
    }
    this.#entries.push({ at: now, weight });
  }

  /**
   * Record the exchange's own view of consumed weight (section 5.4: read from
   * response headers). Only ever raises the local figure -- see `usedWeight`.
   */
  syncFromExchange(usedWeight: number, at: Timestamp): void {
    if (!Number.isFinite(usedWeight) || usedWeight < 0) {
      throw new RateLimiterError(`usedWeight must be non-negative, got ${usedWeight}`);
    }
    const current = this.#exchangeReported;
    if (current === null || at >= current.at) {
      this.#exchangeReported = { usedWeight, at };
    }
  }

  /** Drop everything. For a hard reset after a ban or a window reset. */
  reset(): void {
    this.#entries = [];
    this.#exchangeReported = null;
  }

  /**
   * This budget's mutable state, copied.
   *
   * Copied rather than handed out by reference, following step 2's decision 12:
   * the in-memory store's copy-on-read bug was exactly a caller mutating
   * something it was given and silently corrupting the source.
   */
  snapshot(): WeightBudgetSnapshot {
    return {
      entries: this.#entries.map((entry) => ({ ...entry })),
      exchangeReported:
        this.#exchangeReported === null ? null : { ...this.#exchangeReported },
    };
  }

  /**
   * Replace this budget's state with a previously taken snapshot.
   *
   * Entries outside the window are NOT filtered here; `#expire` does that on
   * the next read, against the clock the caller passes then rather than one
   * this method would have to invent.
   */
  restore(snapshot: WeightBudgetSnapshot): void {
    this.#entries = snapshot.entries.map((entry) => ({ ...entry }));
    this.#exchangeReported =
      snapshot.exchangeReported === null ? null : { ...snapshot.exchangeReported };
  }

  /**
   * How long until `weight` would fit under this priority's ceiling.
   *
   * Public because the RateLimiter Durable Object has to answer "come back in
   * N milliseconds" for a request it is holding in a queue, where the amount
   * that must free up is this request's weight PLUS everything queued ahead of
   * it -- a figure `check` cannot be asked for directly without pretending the
   * request is larger than it is.
   *
   * Returns 0 when it already fits.
   */
  waitFor(weight: number, priority: RequestPriority, now: Timestamp): number {
    if (!Number.isFinite(weight) || weight <= 0) {
      throw new RateLimiterError(`weight must be positive, got ${weight}`);
    }
    const ceiling = this.ceilingFor(priority);
    // Asking to wait for more than the ceiling can never be satisfied, so the
    // question is answered as "wait for the whole ceiling to free", which is
    // the longest honest answer rather than a misleading short one.
    const wanted = Math.min(weight, ceiling);
    if (this.usedWeight(now) + wanted <= ceiling) return 0;
    return this.#waitFor(wanted, ceiling, now);
  }

  /** Remove entries that have aged out of the rolling window. */
  #expire(now: Timestamp): void {
    const cutoff = now - this.#windowMs;
    if (this.#entries.length > 0 && this.#entries[0]!.at > cutoff) return;
    this.#entries = this.#entries.filter((entry) => entry.at > cutoff);
  }

  /**
   * How long until `weight` fits under `ceiling`, given entries expiring in
   * order. Returns the window length if local entries alone cannot explain the
   * shortfall, which happens when the exchange reported more than we recorded.
   */
  #waitFor(weight: number, ceiling: number, now: Timestamp): number {
    const ordered = [...this.#entries].sort((a, b) => a.at - b.at);
    let used = this.usedWeight(now);

    for (const entry of ordered) {
      used -= entry.weight;
      if (ceiling - used >= weight) {
        // Available once this entry leaves the window.
        return Math.max(1, entry.at + this.#windowMs - now);
      }
    }
    return this.#windowMs;
  }
}

// ---------------------------------------------------------------------------
// The second budget shape: a counter that decays continuously
// ---------------------------------------------------------------------------

export interface DecayingCounterOptions {
  /** The value at or above which the venue starts refusing. */
  limit: number;
  /** How much the counter sheds per second. Kraken publishes this per tier. */
  decayPerSecond: number;
  /** Held back for risk-exit traffic, exactly as `WeightBudget` holds it back. */
  reserveForRiskExit: number;
}

/**
 * A decaying counter's whole mutable state, for persisting and restoring it.
 *
 * Two numbers and an optional report, against `WeightBudgetSnapshot`'s unbounded
 * list of entries. That is not an incidental saving: a sliding window has to
 * remember every request that is still inside it, and a decaying counter has to
 * remember only where the counter was and when. The Durable Object persists this
 * on every grant, so the difference is a storage write of constant size instead
 * of one that grows with traffic.
 */
export interface DecayingCounterSnapshot {
  readonly value: number;
  readonly at: Timestamp;
  readonly exchangeReported: { value: number; at: Timestamp } | null;
}

/**
 * A counter that rises on each charge and falls continuously with time.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS RATHER THAN A `WeightBudget` WITH DIFFERENT CONSTANTS
 * ---------------------------------------------------------------------------
 * Decision-log 90 PROBLEM 2 (a). Kraken's counters fall CONTINUOUSLY; a
 * `WeightBudget` holds each entry at full cost for a whole window and then drops
 * it all at once. Those are not the same rule with different numbers, and the
 * sliding window is not the conservative side of the difference in the way one
 * might assume:
 *
 *   - It UNDER-PERMITS in the middle of a window. Kraken has already shed part
 *     of a charge three seconds after it was made; the window still holds every
 *     unit of it for the full sixty.
 *   - Its `retryAfterMs` is arithmetic about something the venue is not doing.
 *     "When does the oldest entry leave the window" has no counterpart at a
 *     venue where nothing ever leaves and everything shrinks. A caller told to
 *     sleep on that figure sleeps for the wrong reason and usually too long.
 *
 * Here the wait is closed-form and exact, because the venue's own rule is:
 *
 *     wait = (used + wanted - ceiling) / decayPerSecond
 *
 * ---------------------------------------------------------------------------
 * WHY NO WINDOW GUARDS THE EXCHANGE-REPORTED FIGURE
 * ---------------------------------------------------------------------------
 * `WeightBudget.usedWeight` ignores a reported figure older than one window,
 * because a sliding window has no way to age one gradually. A decay does: a
 * stale report simply decays to zero on its own, at the same rate the venue
 * would have decayed it. So the report is decayed from the instant it was
 * observed and then compared, and there is no cutoff to choose or to get wrong.
 *
 * As on `WeightBudget`, a report only ever RAISES the local figure. A low
 * reading arriving late must never re-open a counter that has been spent.
 */
export class DecayingCounter implements Budget {
  readonly #limit: number;
  readonly #decayPerSecond: number;
  readonly #reserve: number;
  /** The counter's value as of `#at`. Not the value now; see `usedWeight`. */
  #value = 0;
  #at = 0;
  #exchangeReported: { value: number; at: Timestamp } | null = null;

  constructor(options: DecayingCounterOptions) {
    const { limit, decayPerSecond, reserveForRiskExit } = options;

    if (!Number.isFinite(limit) || limit <= 0) {
      throw new RateLimiterError(`limit must be positive, got ${limit}`);
    }
    if (!Number.isFinite(decayPerSecond) || decayPerSecond <= 0) {
      // A counter that never decays is one that permanently fills, and every
      // `waitFor` on it would divide by zero and answer `Infinity`.
      throw new RateLimiterError(
        `decayPerSecond must be positive, got ${decayPerSecond}`,
      );
    }
    if (!Number.isFinite(reserveForRiskExit) || reserveForRiskExit < 0) {
      throw new RateLimiterError(
        `reserveForRiskExit must be non-negative, got ${reserveForRiskExit}`,
      );
    }
    if (reserveForRiskExit >= limit) {
      throw new RateLimiterError(
        `reserveForRiskExit (${reserveForRiskExit}) must be below limit (${limit}), ` +
          `otherwise routine traffic could never proceed`,
      );
    }

    this.#limit = limit;
    this.#decayPerSecond = decayPerSecond;
    this.#reserve = reserveForRiskExit;
  }

  get limit(): number {
    return this.#limit;
  }

  get decayPerSecond(): number {
    return this.#decayPerSecond;
  }

  get reserveForRiskExit(): number {
    return this.#reserve;
  }

  /**
   * How long a counter sitting at the limit takes to drain to zero.
   *
   * The decaying counterpart of `WeightBudget.windowMs`, and it is what the
   * Durable Object's ticket TTL and the gate's maximum wait are derived from.
   * Both of those need one honest answer to "after how long is waiting
   * pointless", and on a sliding window that is the window; here it is this.
   */
  get horizonMs(): number {
    return Math.ceil((this.#limit / this.#decayPerSecond) * 1000);
  }

  /** The ceiling a given priority may consume up to. */
  ceilingFor(priority: RequestPriority): number {
    return priority === "risk-exit" ? this.#limit : this.#limit - this.#reserve;
  }

  /** The counter's value as of `now`, after decay. Never negative. */
  usedWeight(now: Timestamp): number {
    const local = this.#decayed(this.#value, this.#at, now);
    const reported = this.#exchangeReported;
    if (reported === null) return local;
    return Math.max(local, this.#decayed(reported.value, reported.at, now));
  }

  /** Counter headroom still available to the given priority. Never negative. */
  remainingFor(priority: RequestPriority, now: Timestamp): number {
    return Math.max(0, this.ceilingFor(priority) - this.usedWeight(now));
  }

  /**
   * Ask whether a charge may proceed, without applying it.
   *
   * Same decision type as `WeightBudget.check`, so the Durable Object's grant
   * logic reads identically whichever budget shape is underneath it.
   */
  check(weight: number, priority: RequestPriority, now: Timestamp): RateLimitDecision {
    if (!Number.isFinite(weight) || weight <= 0) {
      throw new RateLimiterError(`weight must be positive, got ${weight}`);
    }

    const used = this.usedWeight(now);
    const ceiling = this.ceilingFor(priority);
    const remaining = Math.max(0, ceiling - used);

    if (weight > ceiling) {
      return {
        allowed: false,
        reason: "weight_exceeds_limit",
        retryAfterMs: 0,
        remainingForPriority: remaining,
        usedWeight: used,
      };
    }

    if (weight > remaining) {
      return {
        allowed: false,
        reason: "budget_exhausted",
        retryAfterMs: this.#waitFor(used + weight - ceiling),
        remainingForPriority: remaining,
        usedWeight: used,
      };
    }

    return { allowed: true, remainingForPriority: remaining - weight, usedWeight: used };
  }

  /**
   * Apply a charge if there is room for it.
   *
   * The charge is applied to the DECAYED value, and `#at` moves to `now`, so the
   * counter carries forward exactly what the venue's own counter would carry.
   * This is also where an exchange-reported figure is absorbed: once it has been
   * taken as the truth it becomes the local value, and cannot later be undone by
   * the report expiring.
   */
  /**
   * Charge unconditionally, past the threshold if need be. See `Budget.record`.
   *
   * ⚠ THIS IS THE ONE PLACE THE COUNTER MAY EXCEED ITS OWN LIMIT, and it must be
   * able to: Kraken's engine counter really does go over when it accepts a batch
   * cancel that overshoots, and a local counter clamped at the threshold would
   * under-state the account's true position at the exact moment it matters --
   * granting the next call budget the venue does not have.
   *
   * Everything downstream already copes. `usedWeight` decays whatever value it
   * holds, `remainingFor` floors at zero, and `waitFor` walks the decay from the
   * real value, so an overshoot simply takes proportionally longer to drain --
   * which is what the venue's own counter does.
   */
  record(weight: number, now: Timestamp): void {
    if (!Number.isFinite(weight) || weight <= 0) {
      throw new RateLimiterError(`weight must be positive, got ${weight}`);
    }
    this.#value = this.usedWeight(now) + weight;
    this.#at = now;
  }

  consume(weight: number, priority: RequestPriority, now: Timestamp): RateLimitDecision {
    const decision = this.check(weight, priority, now);
    if (decision.allowed) {
      this.#value = this.usedWeight(now) + weight;
      this.#at = now;
    }
    return decision;
  }

  /**
   * The venue's own view of this counter.
   *
   * On Kraken this is the WebSocket `ratecount` field -- see the module note in
   * `exchange/kraken/rate-limits.ts`. NOT wired to a live subscription in this
   * session by decision; this is the seam it will arrive through.
   */
  syncFromExchange(value: number, at: Timestamp): void {
    if (!Number.isFinite(value) || value < 0) {
      throw new RateLimiterError(`reported counter must be non-negative, got ${value}`);
    }
    const current = this.#exchangeReported;
    if (current === null || at >= current.at) {
      this.#exchangeReported = { value, at };
    }
  }

  /** Drop everything. For a hard reset after a ban. */
  reset(): void {
    this.#value = 0;
    this.#at = 0;
    this.#exchangeReported = null;
  }

  snapshot(): DecayingCounterSnapshot {
    return {
      value: this.#value,
      at: this.#at,
      exchangeReported:
        this.#exchangeReported === null ? null : { ...this.#exchangeReported },
    };
  }

  restore(snapshot: DecayingCounterSnapshot): void {
    this.#value = snapshot.value;
    this.#at = snapshot.at;
    this.#exchangeReported =
      snapshot.exchangeReported === null ? null : { ...snapshot.exchangeReported };
  }

  /**
   * How long until `weight` would fit under this priority's ceiling.
   *
   * Public for the same reason `WeightBudget.waitFor` is: the Durable Object has
   * to answer for a queued request whose true requirement is its own charge PLUS
   * everything claimed ahead of it.
   */
  waitFor(weight: number, priority: RequestPriority, now: Timestamp): number {
    if (!Number.isFinite(weight) || weight <= 0) {
      throw new RateLimiterError(`weight must be positive, got ${weight}`);
    }
    const ceiling = this.ceilingFor(priority);
    // Asking for more than the ceiling can never be satisfied; answer with the
    // wait for the whole ceiling to free, which is the longest honest answer.
    const wanted = Math.min(weight, ceiling);
    return this.#waitFor(this.usedWeight(now) + wanted - ceiling);
  }

  /** Elapsed decay, clamped at zero in both directions. */
  #decayed(value: number, from: Timestamp, now: Timestamp): number {
    // A clock that has gone backwards decays nothing rather than accruing
    // negative time. The failure direction is "holds the charge longer".
    const elapsedMs = Math.max(0, now - from);
    return Math.max(0, value - (this.#decayPerSecond * elapsedMs) / 1000);
  }

  /** Milliseconds for `shortfall` units to decay away. Zero when none is owed. */
  #waitFor(shortfall: number): number {
    if (shortfall <= 0) return 0;
    return Math.ceil((shortfall / this.#decayPerSecond) * 1000);
  }
}

/**
 * Queue entry for a request waiting on budget.
 *
 * Section 5.4 requires requests to be tagged with a priority; this is the
 * ordering that tag produces once requests start queueing.
 */
export interface PendingRequest<T = unknown> {
  weight: number;
  priority: RequestPriority;
  /** When the request joined the queue, for FIFO ordering within a priority. */
  queuedAt: Timestamp;
  payload: T;
}

/**
 * Order pending requests: risk-exit first, then oldest first within each class.
 *
 * Pure and non-mutating so the ordering can be asserted directly.
 */
export function prioritize<T>(
  requests: readonly PendingRequest<T>[],
): PendingRequest<T>[] {
  const rank = (priority: RequestPriority): number =>
    priority === "risk-exit" ? 0 : 1;

  return [...requests].sort((a, b) => {
    const byPriority = rank(a.priority) - rank(b.priority);
    return byPriority !== 0 ? byPriority : a.queuedAt - b.queuedAt;
  });
}

/*
 * There was an `admit()` here, which took a whole queue and decided in one pass
 * how much of it could go, blocking everything behind the first request that
 * did not fit. It was superseded at step 8 by the RateLimiter Durable Object's
 * claim-based rule -- a waiting request reserves its weight, so a later one is
 * granted only if it fits IN ADDITION -- which gives the same protection
 * against a small request overtaking a large one without deferring a request
 * there was genuinely room for. Deleted rather than left unused; the step 8
 * decision-log entry (decision 6) is where that history belongs.
 */
