import { describe, expect, it } from "vitest";
import {
  DecayingCounter,
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

/*
 * The `admit` tests that stood here went with the function at step 8. Every
 * behaviour they pinned is now asserted against the RateLimiter Durable Object
 * instead, where the claim-based rule that replaced it actually lives:
 * risk-exit served before an earlier routine request, a small request not
 * overtaking a larger waiting one, a request too big to ever fit set aside
 * without stalling the queue, and the ceiling refusing once spent. See
 * `src/durable-objects/rate-limiter.test.ts`.
 */

// ---------------------------------------------------------------------------
// Added at step 8, when the budget moved inside a Durable Object
// ---------------------------------------------------------------------------

describe("snapshot and restore", () => {
  it("round-trips the spent window", () => {
    const source = budget();
    source.consume(30, "routine", AT);
    source.consume(10, "routine", AT + 1000);

    const restored = budget();
    restored.restore(source.snapshot());

    expect(restored.usedWeight(AT + 2000)).toBe(40);
    // And the entries kept their individual timestamps, so they still expire
    // one at a time rather than all at once -- which is the whole difference
    // between a sliding window and a fixed one.
    expect(restored.usedWeight(AT + WINDOW + 1)).toBe(10);
    expect(restored.usedWeight(AT + WINDOW + 1001)).toBe(0);
  });

  it("round-trips the exchange's own reported figure", () => {
    const source = budget();
    source.syncFromExchange(85, AT);

    const restored = budget();
    restored.restore(source.snapshot());
    // An object that forgot this on eviction would wake believing the account
    // idle when the exchange had just said otherwise.
    expect(restored.usedWeight(AT)).toBe(85);
  });

  it("copies rather than sharing, so a restored budget cannot corrupt its source", () => {
    const source = budget();
    source.consume(30, "routine", AT);

    const snapshot = source.snapshot();
    const restored = budget();
    restored.restore(snapshot);
    restored.consume(10, "routine", AT);

    // Step 2's decision 12 in another form: the in-memory attempt store's bug
    // was exactly a caller mutating something it had been handed.
    expect(source.usedWeight(AT)).toBe(30);
    expect(restored.usedWeight(AT)).toBe(40);
  });
});

describe("waitFor", () => {
  it("is zero when the weight already fits", () => {
    expect(budget().waitFor(50, "routine", AT)).toBe(0);
  });

  it("reports when enough weight will have aged out", () => {
    const b = budget();
    b.consume(40, "routine", AT);
    b.consume(40, "routine", AT + 10_000);

    // Routine ceiling is 80 and all of it is spent. 40 frees when the first
    // entry leaves the window.
    expect(b.waitFor(40, "routine", AT + 20_000)).toBe(AT + WINDOW - (AT + 20_000));
  });

  it("answers for more than the ceiling as 'wait for the whole ceiling'", () => {
    const b = budget();
    b.consume(80, "routine", AT);
    // Asking to wait for 200 against a ceiling of 80 can never be satisfied.
    // The longest honest answer beats a misleadingly short one: a caller that
    // waits too long retries; one that waits too little spins.
    expect(b.waitFor(200, "routine", AT + 1)).toBeGreaterThan(0);
  });

  it("rejects a non-positive weight", () => {
    expect(() => budget().waitFor(0, "routine", AT)).toThrow(RateLimiterError);
  });
});

// ---------------------------------------------------------------------------
// DecayingCounter -- the second budget shape (decision-log 90 PROBLEM 2 (a))
// ---------------------------------------------------------------------------

/**
 * Kraken's real published numbers are used throughout, not round ones.
 *
 * A fractional decay is not an incidental detail of Kraken's model, it IS the
 * model -- 0.33/sec on Starter's REST counter and 2.34/sec on Intermediate's
 * trading counter -- and a test suite built on a tidy 1.0 would not have
 * exercised the arithmetic that actually runs. Several assertions below are
 * Kraken's own worked examples, which is the closest thing to real data
 * available for a mechanism that reports nothing over the wire.
 */
function counter(overrides: Partial<ConstructorParameters<typeof DecayingCounter>[0]> = {}) {
  return new DecayingCounter({
    limit: 60,
    decayPerSecond: 1,
    reserveForRiskExit: 10,
    ...overrides,
  });
}

describe("DecayingCounter construction", () => {
  it("exposes its configuration", () => {
    const c = counter();
    expect(c.limit).toBe(60);
    expect(c.decayPerSecond).toBe(1);
    expect(c.reserveForRiskExit).toBe(10);
  });

  it.each([
    ["a zero limit", { limit: 0 }],
    ["a negative limit", { limit: -1 }],
    ["a zero decay", { decayPerSecond: 0 }],
    ["a negative decay", { decayPerSecond: -1 }],
    ["a negative reserve", { reserveForRiskExit: -1 }],
    ["a reserve equal to the limit", { reserveForRiskExit: 60 }],
    ["a reserve above the limit", { reserveForRiskExit: 100 }],
  ])("rejects %s", (_label, overrides) => {
    expect(() => counter(overrides)).toThrow(RateLimiterError);
  });

  it("rejects a zero decay specifically, because it makes every wait infinite", () => {
    // Not a tidy validation: `waitFor` divides by this. A counter that never
    // decays fills permanently and would answer `Infinity` to "come back when?".
    expect(() => counter({ decayPerSecond: 0 })).toThrow(/decayPerSecond must be positive/);
  });

  it("reports a horizon of the time a full counter takes to drain", () => {
    // The decaying counterpart of `windowMs`, and what the Durable Object's
    // ticket TTL and the gate's maximum wait are derived from.
    expect(counter({ limit: 60, decayPerSecond: 1 }).horizonMs).toBe(60_000);
    // Kraken Starter's REST counter: 15 units at 0.33/sec is a little over 45s.
    expect(counter({ limit: 15, decayPerSecond: 0.33, reserveForRiskExit: 2 }).horizonMs).toBe(
      45_455,
    );
  });
});

describe("DecayingCounter decays continuously rather than expiring in a block", () => {
  it("sheds the decay rate every second, and partial seconds pro rata", () => {
    const c = counter();
    c.consume(30, "routine", AT);

    expect(c.usedWeight(AT)).toBe(30);
    // THE DIFFERENCE FROM A SLIDING WINDOW, stated as an assertion: a window
    // would still be holding all 30 at every timestamp below, and would then
    // drop the lot at once. This is what makes a window's `retryAfterMs` describe
    // something the venue is not doing.
    expect(c.usedWeight(AT + 1_000)).toBe(29);
    expect(c.usedWeight(AT + 5_500)).toBe(24.5);
    expect(c.usedWeight(AT + 30_000)).toBe(0);
  });

  it("never decays below zero, however long it has been idle", () => {
    const c = counter();
    c.consume(5, "routine", AT);
    expect(c.usedWeight(AT + 3_600_000)).toBe(0);
  });

  it("reproduces Kraken's own worked example: 50 orders, intermediate tier, 10 seconds", () => {
    // docs.kraken.com/api/docs/guides/spot-ratelimits, verbatim:
    //   "rate counter = (50 orders * add order) - (10 seconds * intermediate
    //    decay rate) = (50 * 1) - (10 * 2.34) = 26.6"
    const c = new DecayingCounter({
      limit: 125,
      decayPerSecond: 2.34,
      reserveForRiskExit: 20,
    });
    for (let i = 0; i < 50; i++) c.consume(1, "risk-exit", AT);

    expect(c.usedWeight(AT)).toBe(50);
    expect(c.usedWeight(AT + 10_000)).toBeCloseTo(26.6, 10);
  });

  it("reproduces Kraken's worked example for clearing a full pro counter: 48 seconds", () => {
    // support 360045239571: "180 points / 3.75 points per second = 48 seconds".
    const c = new DecayingCounter({
      limit: 180,
      decayPerSecond: 3.75,
      reserveForRiskExit: 30,
    });
    for (let i = 0; i < 20; i++) c.consume(9, "risk-exit", AT);
    expect(c.usedWeight(AT)).toBe(180);

    expect(c.usedWeight(AT + 47_000)).toBeGreaterThan(0);
    expect(c.usedWeight(AT + 48_000)).toBe(0);
  });

  it("carries the decayed value forward when it is charged again, not the raw one", () => {
    const c = counter();
    c.consume(40, "routine", AT);
    // 10 seconds later 30 remain; adding 10 gives 40, not 50.
    c.consume(10, "routine", AT + 10_000);
    expect(c.usedWeight(AT + 10_000)).toBe(40);
  });

  it("does not accrue negative time when the clock goes backwards", () => {
    // Reading a backwards clock as decay would shed budget that was never spent.
    const c = counter();
    c.consume(20, "routine", AT);
    expect(c.usedWeight(AT - 30_000)).toBe(20);
  });
});

describe("DecayingCounter reserves and refusals", () => {
  it("holds the reserve back from routine traffic and grants it to risk-exit", () => {
    const c = counter();
    expect(c.ceilingFor("routine")).toBe(50);
    expect(c.ceilingFor("risk-exit")).toBe(60);

    for (let i = 0; i < 50; i++) expect(c.consume(1, "routine", AT).allowed).toBe(true);

    expect(c.check(1, "routine", AT).allowed).toBe(false);
    // The reserve is exactly what a halt needs and routine traffic cannot touch.
    expect(c.check(10, "risk-exit", AT).allowed).toBe(true);
  });

  it("refuses a charge larger than the whole ceiling as unsatisfiable, not as busy", () => {
    const c = counter();
    const decision = c.check(61, "risk-exit", AT);
    expect(decision).toMatchObject({ allowed: false, reason: "weight_exceeds_limit" });
    // No wait is offered, because no wait helps.
    expect(decision.allowed === false && decision.retryAfterMs).toBe(0);
  });

  it("rejects a non-positive charge rather than silently accepting it", () => {
    const c = counter();
    expect(() => c.check(0, "routine", AT)).toThrow(RateLimiterError);
    expect(() => c.check(-1, "routine", AT)).toThrow(RateLimiterError);
  });

  it("records nothing when it refuses", () => {
    const c = counter();
    c.consume(50, "routine", AT);
    expect(c.consume(5, "routine", AT).allowed).toBe(false);
    expect(c.usedWeight(AT)).toBe(50);
  });
});

describe("DecayingCounter answers 'come back when' in closed form", () => {
  it("computes the wait from the shortfall and the decay rate, exactly", () => {
    const c = counter();
    for (let i = 0; i < 50; i++) c.consume(1, "routine", AT);

    // Routine ceiling 50, all spent. One more unit needs one unit to decay, and
    // the decay is 1/sec.
    expect(c.waitFor(1, "routine", AT)).toBe(1_000);
    expect(c.waitFor(10, "routine", AT)).toBe(10_000);
    // THE PROPERTY A SLIDING WINDOW CANNOT HAVE: waiting the quoted time really
    // does make room, because the quote describes the venue's own arithmetic.
    expect(c.check(10, "routine", AT + c.waitFor(10, "routine", AT)).allowed).toBe(true);
  });

  it("rounds the wait up, so the caller never returns one millisecond early", () => {
    const c = new DecayingCounter({ limit: 15, decayPerSecond: 0.33, reserveForRiskExit: 2 });
    c.consume(13, "routine", AT);
    // Routine ceiling is 13, fully spent; one unit at 0.33/sec is 3030.30...ms.
    const wait = c.waitFor(1, "routine", AT);
    expect(wait).toBe(3_031);
    expect(c.check(1, "routine", AT + wait).allowed).toBe(true);
    expect(c.check(1, "routine", AT + wait - 2).allowed).toBe(false);
  });

  it("answers zero when the charge already fits", () => {
    expect(counter().waitFor(5, "routine", AT)).toBe(0);
  });

  it("quotes the wait for the whole ceiling when asked for more than it", () => {
    // The longest honest answer, rather than a misleadingly short one.
    const c = counter();
    c.consume(60, "risk-exit", AT);
    expect(c.waitFor(1_000, "risk-exit", AT)).toBe(60_000);
  });
});

describe("DecayingCounter and the venue's own view", () => {
  it("raises the local figure but never lowers it", () => {
    const c = counter();
    c.consume(10, "routine", AT);

    // The venue knows about traffic this object never granted -- another client
    // on the same key, or a charge this system misjudged.
    c.syncFromExchange(40, AT);
    expect(c.usedWeight(AT)).toBe(40);

    // A NEWER, LOWER report replaces the older one, but the counter still cannot
    // fall below what local accounting knows was really spent. At AT + 1s that
    // is 10 units minus one second of decay, and the report's 5 is disregarded
    // for being under it -- exactly the same rule `WeightBudget` follows.
    c.syncFromExchange(5, AT + 1_000);
    expect(c.usedWeight(AT + 1_000)).toBe(9);

    // And an OLDER report than the one already held is dropped, so a message
    // arriving out of order cannot resurrect a superseded figure.
    c.syncFromExchange(55, AT - 5_000);
    expect(c.usedWeight(AT + 1_000)).toBe(9);
  });

  it("decays a reported figure at the same rate, so it needs no expiry rule", () => {
    // `WeightBudget` has to ignore a report older than one window, because a
    // window cannot age one gradually. A decay can, and does.
    const c = counter();
    c.syncFromExchange(40, AT);
    expect(c.usedWeight(AT + 10_000)).toBe(30);
    expect(c.usedWeight(AT + 40_000)).toBe(0);
  });

  it("absorbs the reported figure once it is charged against, so it cannot be undone", () => {
    const c = counter();
    c.syncFromExchange(40, AT);
    c.consume(5, "risk-exit", AT);
    expect(c.usedWeight(AT)).toBe(45);
  });

  it("rejects a negative report", () => {
    expect(() => counter().syncFromExchange(-1, AT)).toThrow(RateLimiterError);
  });
});

describe("DecayingCounter survives eviction", () => {
  it("round-trips its whole state through a snapshot", () => {
    const c = counter();
    c.consume(30, "routine", AT);
    c.syncFromExchange(35, AT);

    const restored = counter();
    restored.restore(c.snapshot());

    expect(restored.usedWeight(AT)).toBe(35);
    expect(restored.usedWeight(AT + 10_000)).toBe(25);
  });

  it("takes a snapshot of two numbers, not a list that grows with traffic", () => {
    // The practical reason this shape matters: the Durable Object persists on
    // every grant, and a sliding window's snapshot grows with the traffic inside
    // it while this one does not.
    const c = counter();
    for (let i = 0; i < 40; i++) c.consume(1, "routine", AT + i);

    const snapshot = c.snapshot();
    expect(Object.keys(snapshot).sort()).toEqual(["at", "exchangeReported", "value"]);
    expect(typeof snapshot.value).toBe("number");
  });

  it("resets to empty", () => {
    const c = counter();
    c.consume(30, "routine", AT);
    c.syncFromExchange(50, AT);
    c.reset();
    expect(c.usedWeight(AT)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// record(): the charge that cannot be refused
// ---------------------------------------------------------------------------

/**
 * ⚠ WHAT THIS METHOD IS FOR, SO IT IS NOT MISTAKEN FOR A BACK DOOR AROUND
 * `consume`.
 *
 * It exists for a call the EXCHANGE accepts unconditionally, and exactly one
 * does. Kraken, beside the Batch Cancel row of its own cost table
 * (`docs.kraken.com/api/docs/guides/spot-ratelimits`, re-read 2026-09-04):
 * **"If the rate counter in the batch exceeds maximum for a batch cancel, the
 * requests in batch are still accepted."**
 *
 * Refusing such a call locally protects nothing -- the venue was never going to
 * refuse it -- and would stop a halt from cancelling its ladder, which is the
 * risk control defeating itself. So the charge is APPLIED and never checked.
 *
 * The counter still has to carry it. Not refusing is not the same as not
 * counting: everything issued afterwards must see the counter this left behind,
 * including one pushed OVER its threshold, which is where the venue's own
 * counter will also be.
 */
describe("DecayingCounter.record", () => {
  it("applies a charge that consume would have refused", () => {
    const c = counter();
    // 56 of 60 spent: an 8-unit cancel does not fit and is refused.
    c.consume(56, "risk-exit", AT);
    expect(c.consume(8, "risk-exit", AT).allowed).toBe(false);
    expect(c.usedWeight(AT)).toBe(56);

    // The same 8 units, recorded rather than consumed, go on.
    c.record(8, AT);
    expect(c.usedWeight(AT)).toBe(64);
  });

  it("⚠ carries the counter PAST its own limit, which nothing else here may do", () => {
    // A ladder of ten fresh rungs is 80 engine units against a Starter threshold
    // of 60. Clamping at 60 would under-state the account's true position at the
    // exact moment it matters -- granting the next call budget the venue does not
    // have. This is the one place the overshoot is allowed to be real.
    const c = counter();
    c.record(80, AT);
    expect(c.usedWeight(AT)).toBe(80);
    expect(c.usedWeight(AT)).toBeGreaterThan(c.limit);
  });

  it("leaves remainingFor and check coherent above the limit rather than negative", () => {
    const c = counter();
    c.record(80, AT);
    expect(c.remainingFor("risk-exit", AT)).toBe(0);
    expect(c.remainingFor("routine", AT)).toBe(0);
    const decision = c.check(1, "risk-exit", AT);
    expect(decision.allowed).toBe(false);
    if (decision.allowed) return;
    expect(decision.reason).toBe("budget_exhausted");
  });

  it("drains from the REAL overshoot, not from a value clipped at the threshold", () => {
    // 80 shedding 1/second. A counter clipped at 60 would claim room 20 seconds
    // early, which is under-counting on the very counter the escape hatch just
    // overshot.
    const c = counter();
    c.record(80, AT);
    expect(c.usedWeight(AT + 20_000)).toBe(60);
    expect(c.usedWeight(AT + 79_000)).toBe(1);
    expect(c.usedWeight(AT + 100_000)).toBe(0);
    // Only once it has decayed below the ceiling does an ordinary charge fit.
    expect(c.check(1, "risk-exit", AT + 19_000).allowed).toBe(false);
    expect(c.check(1, "risk-exit", AT + 21_000).allowed).toBe(true);
  });

  it("stacks on top of what is already there, decayed to the moment it is applied", () => {
    const c = counter();
    c.consume(30, "risk-exit", AT);
    // Ten seconds later the 30 has decayed to 20; recording 8 makes it 28.
    c.record(8, AT + 10_000);
    expect(c.usedWeight(AT + 10_000)).toBe(28);
  });

  it("refuses a non-positive or non-finite weight, like every other charge here", () => {
    const c = counter();
    for (const weight of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => c.record(weight, AT)).toThrow(RateLimiterError);
    }
  });
});

describe("WeightBudget.record", () => {
  /**
   * ⚠ NO VENUE REACHES THIS TODAY, AND THAT IS WHY IT IS TESTED HERE.
   *
   * `record` is only ever called for an unconditional charge, only the per-pair
   * TRADING counter carries one, and every trading counter is a
   * `DecayingCounter`. So this implementation exists because `Budget` is an
   * obligation rather than a menu -- a venue that later gained an unconditional
   * call on an account-wide counter must fail at the type, not at runtime.
   *
   * Untested, it would be a method nothing runs and nothing checks. These pin
   * the behaviour it is obliged to have.
   */
  it("applies a charge that consume would have refused", () => {
    const b = budget();
    b.consume(95, "risk-exit", AT);
    expect(b.consume(10, "risk-exit", AT).allowed).toBe(false);
    b.record(10, AT);
    expect(b.usedWeight(AT)).toBe(105);
    expect(b.usedWeight(AT)).toBeGreaterThan(b.limit);
  });

  it("ages out of the rolling window on the same schedule as any other entry", () => {
    // No second lifetime for a recorded charge: it arrived by a different door
    // and is otherwise an ordinary entry.
    const b = budget();
    b.record(50, AT);
    expect(b.usedWeight(AT + WINDOW - 1)).toBe(50);
    expect(b.usedWeight(AT + WINDOW)).toBe(0);
  });

  it("refuses a non-positive or non-finite weight, like every other charge here", () => {
    const b = budget();
    for (const weight of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => b.record(weight, AT)).toThrow(RateLimiterError);
    }
  });
});
