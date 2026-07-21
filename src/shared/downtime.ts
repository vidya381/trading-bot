/**
 * Downtime detection (spec section 5.6).
 *
 * The rule this module exists to enforce: only a valid, successful response may
 * feed strategy logic or a risk check. "Could not reach the exchange" is never
 * equivalent to a price that did not move.
 *
 * That is enforced structurally rather than by convention. Every interaction
 * produces an `ExchangeOutcome<T>`, and the only way to read a value out is to
 * narrow to the `ok` variant, so a failed outcome cannot be passed into a
 * stop-loss evaluation without the type system objecting.
 */

import type { Timestamp } from "./exchange-client";

export type FailureKind =
  /** No usable reply: DNS, connection reset, timeout, aborted fetch. */
  | "transport"
  /** The exchange replied, but with an error status. */
  | "exchange_error";

/**
 * The result of one attempt to obtain something from the exchange.
 *
 * Deliberately not `T | null`: a null would be silently usable in arithmetic,
 * which is precisely the confusion between "unreachable" and "zero" that
 * section 5.6 forbids.
 */
export type ExchangeOutcome<T> =
  | { ok: true; value: T; at: Timestamp }
  | {
      ok: false;
      kind: FailureKind;
      /** HTTP status, when there was a response at all. */
      status?: number;
      /** Exchange-specific error code, when the body carried one. */
      code?: number;
      message: string;
      /** Whether retrying could plausibly succeed. */
      retryable: boolean;
      at: Timestamp;
    };

/**
 * The single permitted gate between an outcome and strategy or risk logic.
 *
 * Narrows the type, so code downstream of this check cannot see a failure.
 */
export function isUsable<T>(
  outcome: ExchangeOutcome<T>,
): outcome is Extract<ExchangeOutcome<T>, { ok: true }> {
  return outcome.ok;
}

/**
 * Read the value, or throw.
 *
 * For call sites that genuinely cannot proceed without it. Prefer `isUsable`
 * where a failure has a sensible handling path -- which, for anything touching
 * orders, it usually does.
 */
export function expectUsable<T>(outcome: ExchangeOutcome<T>): T {
  if (!outcome.ok) {
    throw new DowntimeError(
      `expected a usable exchange response but got ${outcome.kind}: ${outcome.message}`,
    );
  }
  return outcome.value;
}

export class DowntimeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DowntimeError";
  }
}

/** Build a successful outcome. */
export function ok<T>(value: T, at: Timestamp): ExchangeOutcome<T> {
  return { ok: true, value, at };
}

/**
 * Classify a thrown error from `fetch`.
 *
 * Anything that throws rather than returning a Response means no reply was
 * received, so the request's effect on the exchange is UNKNOWN -- it may have
 * been applied. Always retryable in the sense that the state is worth
 * re-establishing, but never by blindly re-sending an order: that is what the
 * idempotency records in section 5.1 are for.
 */
export function classifyThrown<T>(error: unknown, at: Timestamp): ExchangeOutcome<T> {
  const message = error instanceof Error ? error.message : String(error);
  return { ok: false, kind: "transport", message, retryable: true, at };
}

/**
 * Classify an HTTP response status.
 *
 * Section 5.6 groups 5xx with connection failures: the exchange did not give a
 * valid answer, so nothing may be inferred from it. 429 is separated out as
 * retryable because it is a rate-limit signal rather than a broken request.
 */
export function classifyStatus<T>(
  status: number,
  at: Timestamp,
  detail?: { message?: string; code?: number },
): ExchangeOutcome<T> {
  const message = detail?.message ?? `exchange responded with HTTP ${status}`;
  const base = { ok: false as const, status, message, at, ...(detail?.code !== undefined ? { code: detail.code } : {}) };

  if (status >= 500) {
    // A server-side failure. The request's effect is unknown, exactly as with
    // a transport failure, so it is classified the same way.
    return { ...base, kind: "transport", retryable: true };
  }
  if (status === 429 || status === 418) {
    // Rate limited, or banned for having ignored a rate limit.
    return { ...base, kind: "exchange_error", retryable: true };
  }
  // A 4xx means the exchange understood and refused. Retrying the identical
  // request will be refused identically.
  return { ...base, kind: "exchange_error", retryable: false };
}

export interface BackoffOptions {
  /** Delay before the first retry, in milliseconds. */
  baseDelayMs: number;
  /** Multiplier applied per attempt. */
  factor: number;
  /** Ceiling on any single delay. */
  maxDelayMs: number;
  /**
   * Random jitter as a fraction of the computed delay, 0 to 1.
   *
   * Without jitter, every bot that lost the connection at the same moment
   * retries at the same moment, which is how a recovering exchange gets
   * knocked over a second time.
   */
  jitter: number;
}

export const DEFAULT_BACKOFF: BackoffOptions = {
  baseDelayMs: 1000,
  factor: 2,
  maxDelayMs: 30_000,
  jitter: 0.2,
};

/**
 * Delay before retry number `attempt` (0-indexed).
 *
 * `random` is injected so tests are deterministic.
 */
export function backoffDelayMs(
  attempt: number,
  options: BackoffOptions = DEFAULT_BACKOFF,
  random: () => number = Math.random,
): number {
  if (!Number.isInteger(attempt) || attempt < 0) {
    throw new DowntimeError(`attempt must be a non-negative integer, got ${attempt}`);
  }

  const raw = options.baseDelayMs * options.factor ** attempt;
  const capped = Math.min(raw, options.maxDelayMs);
  if (options.jitter <= 0) return Math.round(capped);

  // Symmetric jitter around the capped delay, never negative.
  const spread = capped * options.jitter;
  const offset = (random() * 2 - 1) * spread;
  return Math.max(0, Math.round(capped + offset));
}

export interface RetryOptions<T> {
  /** Maximum attempts INCLUDING the first. Section 4.6 uses 5 for reconnects. */
  maxAttempts: number;
  backoff?: BackoffOptions;
  random?: () => number;
  /** Injected so tests need no real delay. */
  sleep: (ms: number) => Promise<void>;
  /** Called before each retry, for logging and alerting. */
  onRetry?: (info: {
    attempt: number;
    delayMs: number;
    outcome: Extract<ExchangeOutcome<T>, { ok: false }>;
  }) => void;
}

/**
 * Run an operation, retrying only failures that are worth retrying.
 *
 * A non-retryable failure returns immediately: re-sending a request the
 * exchange has already refused wastes rate-limit budget and delays the alert.
 */
export async function withRetry<T>(
  operation: (attempt: number) => Promise<ExchangeOutcome<T>>,
  options: RetryOptions<T>,
): Promise<ExchangeOutcome<T>> {
  if (!Number.isInteger(options.maxAttempts) || options.maxAttempts < 1) {
    throw new DowntimeError(
      `maxAttempts must be at least 1, got ${options.maxAttempts}`,
    );
  }

  let last: ExchangeOutcome<T> | undefined;

  for (let attempt = 0; attempt < options.maxAttempts; attempt++) {
    last = await operation(attempt);
    if (last.ok || !last.retryable) return last;

    const isFinalAttempt = attempt === options.maxAttempts - 1;
    if (isFinalAttempt) break;

    const delayMs = backoffDelayMs(attempt, options.backoff ?? DEFAULT_BACKOFF, options.random);
    options.onRetry?.({ attempt, delayMs, outcome: last });
    await options.sleep(delayMs);
  }

  // Unreachable with maxAttempts >= 1, which the guard above enforces.
  return last as ExchangeOutcome<T>;
}

export type FreshnessVerdict<T> =
  | { fresh: true; value: T; at: Timestamp; ageMs: number }
  | { fresh: false; reason: "never_recorded" }
  | { fresh: false; reason: "stale"; value: T; at: Timestamp; ageMs: number };

/**
 * Holds the most recent value that actually came from a successful response.
 *
 * This is the concrete form of section 5.6's warning. A bot that merely caches
 * the last price cannot distinguish "the price has not moved" from "we have not
 * heard from the exchange in five minutes" -- the two look identical. Recording
 * WHEN the value arrived makes the difference explicit, so a stop-loss can
 * decline to evaluate against a stale price instead of concluding the market is
 * calm.
 */
export class LastGoodValue<T> {
  #recorded: { value: T; at: Timestamp } | null = null;

  /** Record a value from a successful outcome only. Failures are ignored. */
  record(outcome: ExchangeOutcome<T>): boolean {
    if (!outcome.ok) return false;
    // Out-of-order arrivals must not move the clock backwards.
    if (this.#recorded !== null && outcome.at < this.#recorded.at) return false;
    this.#recorded = { value: outcome.value, at: outcome.at };
    return true;
  }

  /** Record a value directly, when the caller has already checked the outcome. */
  recordValue(value: T, at: Timestamp): boolean {
    return this.record(ok(value, at));
  }

  /** True if anything has ever been recorded. */
  get hasValue(): boolean {
    return this.#recorded !== null;
  }

  /** When the last good value arrived, or null. */
  get recordedAt(): Timestamp | null {
    return this.#recorded?.at ?? null;
  }

  /** Age of the held value in milliseconds, or null if there is none. */
  ageMs(now: Timestamp): number | null {
    return this.#recorded === null ? null : now - this.#recorded.at;
  }

  /**
   * The value, but only if it is fresh enough to act on.
   *
   * A stale verdict still carries the value and its age, so a caller can log or
   * display it -- while the `fresh: false` discriminant keeps it out of any
   * calculation that requires a current price.
   */
  get(now: Timestamp, maxAgeMs: number): FreshnessVerdict<T> {
    if (this.#recorded === null) return { fresh: false, reason: "never_recorded" };

    const { value, at } = this.#recorded;
    const ageMs = now - at;
    if (ageMs > maxAgeMs) {
      return { fresh: false, reason: "stale", value, at, ageMs };
    }
    return { fresh: true, value, at, ageMs };
  }

  /** Forget the held value, e.g. after a halt. */
  clear(): void {
    this.#recorded = null;
  }
}
