import { describe, expect, it, vi } from "vitest";
import {
  backoffDelayMs,
  classifyStatus,
  classifyThrown,
  DEFAULT_BACKOFF,
  DowntimeError,
  expectUsable,
  isUsable,
  LastGoodValue,
  ok,
  rateLimited,
  withRetry,
  type ExchangeOutcome,
} from "./downtime";
import { fromDecimalString as m } from "./money";

const AT = 1_700_000_000_000;

/** No-op sleep: the retry logic is tested without real delays. */
const noSleep = async () => {};

describe("outcome construction and gating", () => {
  it("wraps a successful value", () => {
    const outcome = ok(m("43120.50"), AT);
    expect(outcome.ok).toBe(true);
    expect(isUsable(outcome)).toBe(true);
    if (isUsable(outcome)) expect(outcome.value).toBe(m("43120.50"));
  });

  it("refuses to let a failure through the gate", () => {
    const outcome = classifyThrown<bigint>(new Error("connect timeout"), AT);
    expect(isUsable(outcome)).toBe(false);
    expect(() => expectUsable(outcome)).toThrow(DowntimeError);
    expect(() => expectUsable(outcome)).toThrow(/connect timeout/);
  });

  it("expectUsable returns the value on success", () => {
    expect(expectUsable(ok(m("1"), AT))).toBe(m("1"));
  });
});

describe("classifyThrown", () => {
  it("treats anything thrown as a transport failure with unknown effect", () => {
    const outcome = classifyThrown(new Error("network error"), AT);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.kind).toBe("transport");
      expect(outcome.retryable).toBe(true);
      expect(outcome.message).toBe("network error");
      expect(outcome.at).toBe(AT);
    }
  });

  it("handles a non-Error throw", () => {
    const outcome = classifyThrown("something odd", AT);
    if (!outcome.ok) expect(outcome.message).toBe("something odd");
  });
});

describe("classifyStatus", () => {
  it("groups 5xx with transport failures, as section 5.6 requires", () => {
    for (const status of [500, 502, 503, 504]) {
      const outcome = classifyStatus(status, AT);
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) {
        expect(outcome.kind).toBe("transport");
        expect(outcome.retryable).toBe(true);
      }
    }
  });

  it("marks rate limiting retryable but distinct from a transport failure", () => {
    for (const status of [429, 418]) {
      const outcome = classifyStatus(status, AT);
      if (!outcome.ok) {
        expect(outcome.kind).toBe("exchange_error");
        expect(outcome.retryable).toBe(true);
      }
    }
  });

  it("marks an ordinary 4xx non-retryable", () => {
    // The exchange understood and refused; the identical request will be
    // refused identically, so retrying only burns rate-limit budget.
    for (const status of [400, 401, 403, 404]) {
      const outcome = classifyStatus(status, AT);
      if (!outcome.ok) {
        expect(outcome.kind).toBe("exchange_error");
        expect(outcome.retryable).toBe(false);
      }
    }
  });

  it("carries through an exchange error code and message", () => {
    const outcome = classifyStatus(400, AT, {
      message: "Filter failure: MIN_NOTIONAL",
      code: -1013,
    });
    if (!outcome.ok) {
      expect(outcome.code).toBe(-1013);
      expect(outcome.message).toBe("Filter failure: MIN_NOTIONAL");
      expect(outcome.status).toBe(400);
    }
  });

  it("omits the code key entirely when there is none", () => {
    const outcome = classifyStatus(400, AT);
    if (!outcome.ok) expect("code" in outcome).toBe(false);
  });
});

describe("backoffDelayMs", () => {
  const noJitter = { ...DEFAULT_BACKOFF, jitter: 0 };

  it("grows exponentially", () => {
    expect(backoffDelayMs(0, noJitter)).toBe(1000);
    expect(backoffDelayMs(1, noJitter)).toBe(2000);
    expect(backoffDelayMs(2, noJitter)).toBe(4000);
    expect(backoffDelayMs(3, noJitter)).toBe(8000);
  });

  it("caps at maxDelayMs", () => {
    expect(backoffDelayMs(20, noJitter)).toBe(noJitter.maxDelayMs);
  });

  it("applies symmetric jitter so bots do not retry in lockstep", () => {
    const options = { ...DEFAULT_BACKOFF, jitter: 0.5 };
    // random() = 1 is the top of the range, 0 the bottom, 0.5 the midpoint.
    expect(backoffDelayMs(0, options, () => 1)).toBe(1500);
    expect(backoffDelayMs(0, options, () => 0)).toBe(500);
    expect(backoffDelayMs(0, options, () => 0.5)).toBe(1000);
  });

  it("never returns a negative delay", () => {
    const options = { ...DEFAULT_BACKOFF, jitter: 2 };
    expect(backoffDelayMs(0, options, () => 0)).toBeGreaterThanOrEqual(0);
  });

  it("rejects a negative or non-integer attempt", () => {
    expect(() => backoffDelayMs(-1)).toThrow(DowntimeError);
    expect(() => backoffDelayMs(1.5)).toThrow(DowntimeError);
  });
});

describe("withRetry", () => {
  it("returns immediately on success without sleeping", async () => {
    const sleep = vi.fn(noSleep);
    const result = await withRetry(async () => ok("value", AT), {
      maxAttempts: 5,
      sleep,
    });

    expect(result.ok).toBe(true);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("retries a transport failure and succeeds", async () => {
    let calls = 0;
    const result = await withRetry<string>(
      async () => {
        calls++;
        return calls < 3 ? classifyThrown("timeout", AT) : ok("recovered", AT);
      },
      { maxAttempts: 5, sleep: noSleep, random: () => 0.5 },
    );

    expect(calls).toBe(3);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe("recovered");
  });

  it("stops after maxAttempts and returns the last failure", async () => {
    let calls = 0;
    const result = await withRetry<string>(
      async () => {
        calls++;
        return classifyThrown("timeout", AT);
      },
      // Section 4.6 uses 5 attempts for a reconnect.
      { maxAttempts: 5, sleep: noSleep, random: () => 0.5 },
    );

    expect(calls).toBe(5);
    expect(result.ok).toBe(false);
    // Crucially, exhausting retries does not synthesise a value.
    if (!result.ok) expect(result.kind).toBe("transport");
  });

  it("does not retry a failure the exchange will refuse identically", async () => {
    let calls = 0;
    const result = await withRetry<string>(
      async () => {
        calls++;
        return classifyStatus(400, AT, { message: "MIN_NOTIONAL", code: -1013 });
      },
      { maxAttempts: 5, sleep: noSleep },
    );

    expect(calls).toBe(1);
    expect(result.ok).toBe(false);
  });

  it("sleeps for a growing delay between attempts", async () => {
    const delays: number[] = [];
    await withRetry<string>(async () => classifyThrown("timeout", AT), {
      maxAttempts: 4,
      sleep: async (ms) => {
        delays.push(ms);
      },
      backoff: { ...DEFAULT_BACKOFF, jitter: 0 },
    });

    // Three sleeps for four attempts: none after the last.
    expect(delays).toEqual([1000, 2000, 4000]);
  });

  it("reports each retry for logging and alerting", async () => {
    const seen: number[] = [];
    await withRetry<string>(async () => classifyThrown("timeout", AT), {
      maxAttempts: 3,
      sleep: noSleep,
      backoff: { ...DEFAULT_BACKOFF, jitter: 0 },
      onRetry: ({ attempt, delayMs, outcome }) => {
        seen.push(attempt);
        expect(delayMs).toBeGreaterThan(0);
        expect(outcome.kind).toBe("transport");
      },
    });
    expect(seen).toEqual([0, 1]);
  });

  it("passes the attempt number to the operation", async () => {
    const attempts: number[] = [];
    await withRetry<string>(
      async (attempt) => {
        attempts.push(attempt);
        return classifyThrown("timeout", AT);
      },
      { maxAttempts: 3, sleep: noSleep },
    );
    expect(attempts).toEqual([0, 1, 2]);
  });

  it("rejects a maxAttempts below one", async () => {
    await expect(
      withRetry(async () => ok("v", AT), { maxAttempts: 0, sleep: noSleep }),
    ).rejects.toThrow(DowntimeError);
  });
});

describe("LastGoodValue", () => {
  const MAX_AGE = 60_000;

  it("reports never_recorded before anything arrives", () => {
    const held = new LastGoodValue<bigint>();
    expect(held.hasValue).toBe(false);
    expect(held.recordedAt).toBeNull();
    expect(held.ageMs(AT)).toBeNull();
    expect(held.get(AT, MAX_AGE)).toEqual({ fresh: false, reason: "never_recorded" });
  });

  it("serves a value that is still fresh", () => {
    const held = new LastGoodValue<bigint>();
    held.recordValue(m("43120.50"), AT);

    const verdict = held.get(AT + 1000, MAX_AGE);
    expect(verdict.fresh).toBe(true);
    if (verdict.fresh) {
      expect(verdict.value).toBe(m("43120.50"));
      expect(verdict.ageMs).toBe(1000);
    }
  });

  it("refuses to serve a stale value as fresh", () => {
    // The heart of section 5.6: an unreachable exchange must not look like a
    // calm market to a stop-loss check.
    const held = new LastGoodValue<bigint>();
    held.recordValue(m("43120.50"), AT);

    const verdict = held.get(AT + MAX_AGE + 1, MAX_AGE);
    expect(verdict.fresh).toBe(false);
    if (!verdict.fresh && verdict.reason === "stale") {
      // The value is still available for display, but flagged.
      expect(verdict.value).toBe(m("43120.50"));
      expect(verdict.ageMs).toBe(MAX_AGE + 1);
    }
  });

  it("treats exactly maxAge as still fresh", () => {
    const held = new LastGoodValue<bigint>();
    held.recordValue(m("1"), AT);
    expect(held.get(AT + MAX_AGE, MAX_AGE).fresh).toBe(true);
  });

  it("ignores a failed outcome entirely", () => {
    const held = new LastGoodValue<bigint>();
    held.recordValue(m("43120.50"), AT);

    const failure: ExchangeOutcome<bigint> = classifyThrown(new Error("down"), AT + 5000);
    expect(held.record(failure)).toBe(false);

    // Age keeps growing from the last GOOD value, not from the failed attempt.
    expect(held.recordedAt).toBe(AT);
    expect(held.ageMs(AT + 5000)).toBe(5000);
  });

  it("goes stale while the exchange is unreachable", () => {
    const held = new LastGoodValue<bigint>();
    held.recordValue(m("43120.50"), AT);

    for (let i = 1; i <= 5; i++) {
      held.record(classifyThrown(new Error("down"), AT + i * 20_000));
    }

    const verdict = held.get(AT + 100_000, MAX_AGE);
    expect(verdict.fresh).toBe(false);
    if (!verdict.fresh) expect(verdict.reason).toBe("stale");
  });

  it("does not let an out-of-order arrival move the clock backwards", () => {
    const held = new LastGoodValue<bigint>();
    held.recordValue(m("2"), AT + 5000);
    expect(held.recordValue(m("1"), AT)).toBe(false);

    const verdict = held.get(AT + 5000, MAX_AGE);
    if (verdict.fresh) expect(verdict.value).toBe(m("2"));
  });

  it("accepts a newer value and refreshes the age", () => {
    const held = new LastGoodValue<bigint>();
    held.recordValue(m("1"), AT);
    expect(held.recordValue(m("2"), AT + 30_000)).toBe(true);

    const verdict = held.get(AT + 30_000, MAX_AGE);
    expect(verdict.fresh).toBe(true);
    if (verdict.fresh) {
      expect(verdict.value).toBe(m("2"));
      expect(verdict.ageMs).toBe(0);
    }
  });

  it("clears back to never_recorded", () => {
    const held = new LastGoodValue<bigint>();
    held.recordValue(m("1"), AT);
    held.clear();
    expect(held.hasValue).toBe(false);
    expect(held.get(AT, MAX_AGE)).toEqual({ fresh: false, reason: "never_recorded" });
  });
});

// ---------------------------------------------------------------------------
// The third failure kind (section 5.4), added at step 8
// ---------------------------------------------------------------------------

describe("rateLimited", () => {
  it("is not usable, so it cannot reach strategy or risk logic", () => {
    const outcome = rateLimited<number>("budget refused", 1000);
    expect(isUsable(outcome)).toBe(false);
    expect(outcome).toMatchObject({ ok: false, kind: "rate_limited", retryable: true });
  });

  it("is a distinct kind from transport, and that distinction is the point", () => {
    // `transport` means the request LEFT this process and its effect is
    // unknown, so section 5.1 requires recovery by looking the order up.
    // `rate_limited` means it never left, so there is nothing to look up. A
    // caller branching on `kind` must be able to tell them apart.
    const thrown = classifyThrown<number>(new Error("socket hang up"), 1000);
    const refused = rateLimited<number>("budget refused", 1000);
    expect(thrown.ok).toBe(false);
    expect(refused.ok).toBe(false);
    if (thrown.ok || refused.ok) return;
    expect(thrown.kind).toBe("transport");
    expect(refused.kind).not.toBe(thrown.kind);
    expect(refused.kind).not.toBe("exchange_error");
  });

  it("carries the wait the budget computed", () => {
    const outcome = rateLimited<number>("budget refused", 1000, { retryAfterMs: 4200 });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.retryAfterMs).toBe(4200);
  });

  it("can be non-retryable, and withRetry then stops immediately", async () => {
    const sleep = vi.fn(async () => undefined);
    let calls = 0;
    const result = await withRetry<number>(
      async () => {
        calls += 1;
        // A request larger than the whole budget: waiting cannot help.
        return rateLimited<number>("exceeds the whole budget", 1000, { retryable: false });
      },
      { maxAttempts: 5, sleep },
    );

    expect(result.ok).toBe(false);
    expect(calls).toBe(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("is retried by withRetry when it is temporary", async () => {
    const sleep = vi.fn(async () => undefined);
    let calls = 0;
    const result = await withRetry<number>(
      async () => {
        calls += 1;
        if (calls < 3) return rateLimited<number>("busy", 1000, { retryAfterMs: 500 });
        return ok(7, 1000);
      },
      { maxAttempts: 5, sleep, random: () => 0.5 },
    );

    expect(result).toMatchObject({ ok: true, value: 7 });
    expect(calls).toBe(3);
  });
});
