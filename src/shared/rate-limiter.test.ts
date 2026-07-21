import { describe, expect, it } from "vitest";
import {
  admit,
  prioritize,
  RateLimiterError,
  WeightBudget,
  type PendingRequest,
  type RequestPriority,
} from "./rate-limiter";

const AT = 1_700_000_000_000;
const WINDOW = 60_000;

function budget(overrides: Partial<ConstructorParameters<typeof WeightBudget>[0]> = {}) {
  return new WeightBudget({
    limit: 100,
    windowMs: WINDOW,
    reserveForRiskExit: 20,
    ...overrides,
  });
}

describe("construction", () => {
  it("exposes its configuration", () => {
    const b = budget();
    expect(b.limit).toBe(100);
    expect(b.windowMs).toBe(WINDOW);
    expect(b.reserveForRiskExit).toBe(20);
  });

  it.each([
    ["a zero limit", { limit: 0 }],
    ["a negative limit", { limit: -1 }],
    ["a zero window", { windowMs: 0 }],
    ["a negative reserve", { reserveForRiskExit: -1 }],
    ["a reserve equal to the limit", { reserveForRiskExit: 100 }],
    ["a reserve above the limit", { reserveForRiskExit: 200 }],
  ])("rejects %s", (_label, overrides) => {
    expect(() => budget(overrides)).toThrow(RateLimiterError);
  });

  it("explains why a reserve cannot swallow the whole limit", () => {
    expect(() => budget({ reserveForRiskExit: 100 })).toThrow(
      /routine traffic could never proceed/,
    );
  });
});

describe("ceilings by priority", () => {
  it("gives risk-exit the full limit and routine the rest", () => {
    const b = budget();
    expect(b.ceilingFor("risk-exit")).toBe(100);
    expect(b.ceilingFor("routine")).toBe(80);
  });
});

describe("consuming budget", () => {
  it("allows a request that fits and records its weight", () => {
    const b = budget();
    const decision = b.consume(10, "routine", AT);

    expect(decision.allowed).toBe(true);
    expect(b.usedWeight(AT)).toBe(10);
    expect(b.remainingFor("routine", AT)).toBe(70);
    expect(b.remainingFor("risk-exit", AT)).toBe(90);
  });

  it("does not consume anything when it denies", () => {
    const b = budget();
    b.consume(80, "routine", AT);
    const denied = b.consume(10, "routine", AT);

    expect(denied.allowed).toBe(false);
    expect(b.usedWeight(AT)).toBe(80);
  });

  it("check reports without consuming", () => {
    const b = budget();
    expect(b.check(10, "routine", AT).allowed).toBe(true);
    expect(b.usedWeight(AT)).toBe(0);
  });

  it("rejects a non-positive weight", () => {
    const b = budget();
    expect(() => b.consume(0, "routine", AT)).toThrow(RateLimiterError);
    expect(() => b.consume(-5, "routine", AT)).toThrow(RateLimiterError);
    expect(() => b.consume(Number.NaN, "routine", AT)).toThrow(RateLimiterError);
  });

  it("distinguishes a request that can never fit from one that must wait", () => {
    const b = budget();
    const impossible = b.check(200, "risk-exit", AT);

    expect(impossible.allowed).toBe(false);
    if (!impossible.allowed) {
      expect(impossible.reason).toBe("weight_exceeds_limit");
      // Retrying will never help, so no wait is suggested.
      expect(impossible.retryAfterMs).toBe(0);
    }
  });

  it("treats a routine request above the routine ceiling as impossible", () => {
    const b = budget();
    const decision = b.check(90, "routine", AT);
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.reason).toBe("weight_exceeds_limit");
    // The same request as risk-exit fits, because its ceiling is higher.
    expect(b.check(90, "risk-exit", AT).allowed).toBe(true);
  });
});

describe("priority reservation", () => {
  it("keeps a stop-loss viable after routine traffic exhausts its share", () => {
    // The core guarantee of section 5.4: risk-reducing traffic is never
    // starved by routine ladder maintenance.
    const b = budget();
    for (let i = 0; i < 8; i++) {
      expect(b.consume(10, "routine", AT).allowed).toBe(true);
    }

    expect(b.consume(10, "routine", AT).allowed).toBe(false);
    expect(b.consume(20, "risk-exit", AT).allowed).toBe(true);
  });

  it("exhausts the full limit only through risk-exit traffic", () => {
    const b = budget();
    b.consume(80, "routine", AT);
    b.consume(20, "risk-exit", AT);

    expect(b.usedWeight(AT)).toBe(100);
    expect(b.remainingFor("risk-exit", AT)).toBe(0);
    expect(b.remainingFor("routine", AT)).toBe(0);
  });

  it("never reports negative remaining budget", () => {
    const b = budget();
    b.consume(100, "risk-exit", AT);
    expect(b.remainingFor("routine", AT)).toBe(0);
  });
});

describe("the rolling window", () => {
  it("frees weight as individual entries age out", () => {
    const b = budget();
    b.consume(50, "routine", AT);
    b.consume(30, "routine", AT + 30_000);

    expect(b.usedWeight(AT + 30_000)).toBe(80);

    // The first entry leaves the window; the second has not yet.
    expect(b.usedWeight(AT + WINDOW + 1)).toBe(30);
    expect(b.usedWeight(AT + 30_000 + WINDOW + 1)).toBe(0);
  });

  it("slides rather than resetting on a fixed boundary", () => {
    // A fixed window would allow 80 + 80 across a boundary. A sliding one
    // does not, which is what keeps the account off the exchange's limit.
    const b = budget();
    b.consume(80, "routine", AT);
    expect(b.consume(80, "routine", AT + WINDOW - 1).allowed).toBe(false);
    expect(b.consume(80, "routine", AT + WINDOW + 1).allowed).toBe(true);
  });

  it("suggests a wait that is actually long enough", () => {
    const b = budget();
    b.consume(80, "routine", AT);
    const denied = b.check(10, "routine", AT);

    expect(denied.allowed).toBe(false);
    if (!denied.allowed) {
      expect(denied.retryAfterMs).toBeGreaterThan(0);
      // Waiting exactly that long must make the request succeed.
      expect(b.check(10, "routine", AT + denied.retryAfterMs).allowed).toBe(true);
    }
  });

  it("suggests waiting only for the entries it actually needs", () => {
    const b = budget();
    b.consume(40, "routine", AT);
    b.consume(40, "routine", AT + 10_000);

    const denied = b.check(30, "routine", AT + 20_000);
    expect(denied.allowed).toBe(false);
    if (!denied.allowed) {
      // Freeing the first 40 is enough; no need to wait for the second.
      expect(denied.retryAfterMs).toBe(AT + WINDOW - (AT + 20_000));
    }
  });

  it("reset clears everything", () => {
    const b = budget();
    b.consume(80, "routine", AT);
    b.reset();
    expect(b.usedWeight(AT)).toBe(0);
  });
});

describe("syncFromExchange", () => {
  it("raises the used figure when the exchange knows more than we do", () => {
    const b = budget();
    b.consume(10, "routine", AT);
    b.syncFromExchange(70, AT);

    expect(b.usedWeight(AT)).toBe(70);
    expect(b.remainingFor("routine", AT)).toBe(10);
  });

  it("never lowers the used figure, so a stale reading cannot reopen the budget", () => {
    const b = budget();
    b.consume(50, "routine", AT);
    b.syncFromExchange(5, AT);
    expect(b.usedWeight(AT)).toBe(50);
  });

  it("stops applying once the report itself ages out of the window", () => {
    const b = budget();
    b.syncFromExchange(90, AT);
    expect(b.usedWeight(AT)).toBe(90);
    expect(b.usedWeight(AT + WINDOW + 1)).toBe(0);
  });

  it("ignores a report older than one already recorded", () => {
    const b = budget();
    b.syncFromExchange(90, AT + 1000);
    b.syncFromExchange(10, AT);
    expect(b.usedWeight(AT + 1000)).toBe(90);
  });

  it("rejects a negative report", () => {
    expect(() => budget().syncFromExchange(-1, AT)).toThrow(RateLimiterError);
  });

  it("still denies routine traffic when only the exchange knows the budget is spent", () => {
    const b = budget();
    b.syncFromExchange(80, AT);
    expect(b.consume(5, "routine", AT).allowed).toBe(false);
    expect(b.consume(5, "risk-exit", AT).allowed).toBe(true);
  });
});

describe("prioritize", () => {
  function request(
    priority: RequestPriority,
    queuedAt: number,
    label: string,
  ): PendingRequest<string> {
    return { weight: 10, priority, queuedAt, payload: label };
  }

  it("puts risk-exit ahead of routine regardless of queue order", () => {
    const ordered = prioritize([
      request("routine", AT, "first-routine"),
      request("risk-exit", AT + 5000, "later-risk-exit"),
    ]);
    expect(ordered.map((r) => r.payload)).toEqual(["later-risk-exit", "first-routine"]);
  });

  it("is FIFO within a priority class", () => {
    const ordered = prioritize([
      request("routine", AT + 200, "c"),
      request("routine", AT, "a"),
      request("routine", AT + 100, "b"),
    ]);
    expect(ordered.map((r) => r.payload)).toEqual(["a", "b", "c"]);
  });

  it("does not mutate its input", () => {
    const input = [request("routine", AT, "a"), request("risk-exit", AT, "b")];
    const snapshot = [...input];
    prioritize(input);
    expect(input).toEqual(snapshot);
  });
});

describe("admit", () => {
  function request(
    priority: RequestPriority,
    weight: number,
    label: string,
    queuedAt = AT,
  ): PendingRequest<string> {
    return { weight, priority, queuedAt, payload: label };
  }

  it("admits what fits and defers the rest", () => {
    const b = budget();
    const { admitted, deferred } = admit(
      b,
      [
        request("routine", 50, "a"),
        request("routine", 40, "b"),
        request("routine", 10, "c"),
      ],
      AT,
    );

    expect(admitted.map((r) => r.payload)).toEqual(["a"]);
    expect(deferred.map((r) => r.payload)).toEqual(["b", "c"]);
  });

  it("serves risk-exit first even when routine requests queued earlier", () => {
    const b = budget({ limit: 30, reserveForRiskExit: 10 });
    const { admitted } = admit(
      b,
      [
        request("routine", 20, "routine-first", AT),
        request("risk-exit", 20, "stop-loss", AT + 1000),
      ],
      AT,
    );
    expect(admitted.map((r) => r.payload)).toEqual(["stop-loss"]);
  });

  it("does not let a small request jump a deferred larger one", () => {
    // Head-of-line blocking is deliberate: otherwise a stream of cheap routine
    // requests could starve an expensive one indefinitely.
    const b = budget();
    b.consume(40, "routine", AT); // 40 of the routine ceiling of 80 left

    // "big" is under the ceiling, so it is merely waiting rather than
    // impossible. "small" would fit right now, but must not overtake it.
    const { admitted, deferred } = admit(
      b,
      [request("routine", 70, "big", AT), request("routine", 5, "small", AT + 1)],
      AT,
    );
    expect(admitted).toEqual([]);
    expect(deferred.map((r) => r.payload)).toEqual(["big", "small"]);
  });

  it("sets aside an impossible request without stalling the queue behind it", () => {
    const b = budget();
    const { admitted, deferred } = admit(
      b,
      [request("routine", 500, "impossible", AT), request("routine", 10, "fine", AT + 1)],
      AT,
    );
    expect(admitted.map((r) => r.payload)).toEqual(["fine"]);
    expect(deferred.map((r) => r.payload)).toEqual(["impossible"]);
  });

  it("admits nothing from an empty queue", () => {
    const { admitted, deferred } = admit(budget(), [], AT);
    expect(admitted).toEqual([]);
    expect(deferred).toEqual([]);
  });
});
