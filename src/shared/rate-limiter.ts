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

interface WeightEntry {
  at: Timestamp;
  weight: number;
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

/**
 * Admit as many queued requests as the budget allows, in priority order.
 *
 * A request that does not fit is deferred rather than skipped over, so a large
 * risk-exit request cannot be starved by smaller routine ones queued behind it.
 */
export function admit<T>(
  budget: WeightBudget,
  requests: readonly PendingRequest<T>[],
  now: Timestamp,
): { admitted: PendingRequest<T>[]; deferred: PendingRequest<T>[] } {
  const admitted: PendingRequest<T>[] = [];
  const deferred: PendingRequest<T>[] = [];
  let blocked = false;

  for (const request of prioritize(requests)) {
    if (blocked) {
      deferred.push(request);
      continue;
    }
    const decision = budget.consume(request.weight, request.priority, now);
    if (decision.allowed) {
      admitted.push(request);
    } else {
      deferred.push(request);
      // Only head-of-line block on a temporary shortfall. A request that can
      // never fit is set aside without stalling everything behind it.
      blocked = decision.reason === "budget_exhausted";
    }
  }

  return { admitted, deferred };
}
