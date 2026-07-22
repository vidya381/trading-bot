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
 * A rolling request-weight budget.
 *
 * Sliding rather than fixed-window: entries are held with their timestamps and
 * expire individually. A fixed window would allow a full limit's worth of
 * traffic on either side of a boundary, i.e. double the intended rate across
 * the boundary, which is what gets an account rate-limited.
 */
export class WeightBudget {
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
