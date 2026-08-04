/**
 * The `RateLimiter` Durable Object (spec section 5.4), against real Durable
 * Object storage in the Workers runtime.
 *
 * Three kinds of test here, and the distinction is the same one step 5's
 * capital-ledger concurrency tests drew:
 *
 *   - ACCOUNTING tests drive `acquire` at chosen timestamps and assert on what
 *     was granted. Deterministic by construction, because nothing in this object
 *     reads a clock it was not given.
 *   - The DETERMINISTIC CONCURRENCY test forces a competing `acquire` to commit
 *     between the first one's budget decision and its storage write, which is
 *     the only interleaving this object has. A real race is observable but not
 *     schedulable; this one is.
 *   - The STORM test issues a full grid ladder's worth of cancellations at once
 *     and asserts they are throttled rather than all firing, which is the
 *     exposure step 7 measured and named.
 */

import { beforeEach, describe, expect, it } from "vitest";

import {
  DEFAULT_WEIGHT_LIMIT,
  DEFAULT_WINDOW_MS,
  RISK_EXIT_RESERVE_FRACTION,
  type AcquireResult,
  type RateLimiter,
} from "./rate-limiter";
import { inLimiter } from "./test-helpers";

const NOW = 1_760_000_000_000;

/**
 * A fresh account label per test.
 *
 * A Durable Object's storage outlives a single test, and its name is the
 * account label, so reusing one would let a previous test's spent budget leak
 * into the next. Cheaper and clearer than trying to wipe storage.
 */
let account = "";
let counter = 0;
beforeEach(() => {
  counter += 1;
  account = `acct-${counter}`;
});

/** Predictable ticket ids, so an assertion can name one. */
function ids(): () => string {
  let n = 0;
  return () => {
    n += 1;
    return `ticket-${n}`;
  };
}

interface Harness {
  readonly limiter: RateLimiter;
  readonly state: DurableObjectState;
  /** Move the injected clock. */
  setNow(at: number): void;
  acquire(
    weight: number,
    priority: "routine" | "risk-exit",
    ticketId?: string,
  ): Promise<AcquireResult>;
}

/**
 * Run a test body against a limiter with an injected clock and id source.
 *
 * `limit` is applied through `syncLimit`, which is the same path an
 * `exchangeInfo` response takes -- so every test below also exercises the fact
 * that a limit read from the exchange really does take effect.
 */
async function withLimiter(
  options: { limit?: number; windowMs?: number },
  body: (harness: Harness) => Promise<void>,
): Promise<void> {
  await inLimiter(account, async (limiter, state) => {
    let clock = NOW;
    limiter.attach({ now: () => clock, newId: ids() });
    if (options.limit !== undefined) {
      await limiter.syncLimit(options.limit, options.windowMs ?? DEFAULT_WINDOW_MS, NOW);
    }
    await body({
      limiter,
      state,
      setNow: (at) => {
        clock = at;
      },
      acquire: (weight, priority, ticketId) =>
        limiter.acquire({ weight, priority, ...(ticketId !== undefined ? { ticketId } : {}) }),
    });
  });
}

// ---------------------------------------------------------------------------
// Budget accounting
// ---------------------------------------------------------------------------

describe("budget accounting", () => {
  it("starts on the documented default before exchangeInfo has been read", async () => {
    await withLimiter({}, async ({ limiter }) => {
      const stats = await limiter.stats();
      expect(stats.limit).toBe(DEFAULT_WEIGHT_LIMIT);
      expect(stats.windowMs).toBe(DEFAULT_WINDOW_MS);
      expect(stats.limitSource).toBe("default");
      // The bootstrap gap, stated as an assertion: the object is usable before
      // it has ever been told the real ceiling, because reading that ceiling is
      // itself a request that needs budget.
      expect(stats.remainingRoutine).toBeGreaterThan(0);
    });
  });

  it("grants until the routine ceiling and then refuses", async () => {
    // 120 limit, one sixth reserved => routine may draw on 100.
    await withLimiter({ limit: 120 }, async ({ limiter, acquire }) => {
      const stats = await limiter.stats();
      expect(stats.reserveForRiskExit).toBe(20);
      expect(stats.remainingRoutine).toBe(100);

      for (let spent = 0; spent < 100; spent += 10) {
        expect((await acquire(10, "routine")).granted).toBe(true);
      }

      const denied = await acquire(10, "routine");
      expect(denied.granted).toBe(false);
      expect(denied).toMatchObject({ reason: "budget_exhausted" });
      expect((await limiter.stats()).usedWeight).toBe(100);
    });
  });

  it("charges the weight it was asked for, not one per request", async () => {
    await withLimiter({ limit: 120 }, async ({ limiter, acquire }) => {
      await acquire(20, "routine");
      await acquire(6, "routine");
      expect((await limiter.stats()).usedWeight).toBe(26);
    });
  });

  it("frees budget as entries age out of the rolling window", async () => {
    await withLimiter({ limit: 120, windowMs: 60_000 }, async ({ acquire, setNow }) => {
      for (let spent = 0; spent < 100; spent += 50) {
        expect((await acquire(50, "routine")).granted).toBe(true);
      }

      const denied = await acquire(50, "routine");
      expect(denied.granted).toBe(false);
      if (denied.granted) return;
      // The SAME ticket is re-presented, which is what a real caller does and
      // what keeps its queue place. Arriving fresh each time would correctly
      // queue behind the claim the previous denial left behind -- true, but a
      // different property from the one under test here.
      const ticket = denied.ticketId ?? undefined;

      // One millisecond before the first entry leaves the window.
      setNow(NOW + 59_999);
      expect((await acquire(50, "routine", ticket)).granted).toBe(false);
      setNow(NOW + 60_001);
      expect((await acquire(50, "routine", ticket)).granted).toBe(true);
    });
  });

  it("reports how long to wait, and the wait is actually long enough", async () => {
    await withLimiter({ limit: 120, windowMs: 60_000 }, async ({ acquire, setNow }) => {
      await acquire(100, "routine");
      const denied = await acquire(100, "routine");
      expect(denied.granted).toBe(false);
      if (denied.granted) return;

      // Not merely non-zero: waiting exactly this long must be enough, or the
      // caller loops and the retryAfterMs is decorative.
      setNow(NOW + denied.retryAfterMs);
      expect((await acquire(100, "routine", denied.ticketId ?? undefined)).granted).toBe(true);
    });
  });

  it("refuses a request larger than the whole budget without issuing a ticket", async () => {
    await withLimiter({ limit: 120 }, async ({ acquire }) => {
      const denied = await acquire(500, "risk-exit");
      expect(denied).toMatchObject({
        granted: false,
        reason: "weight_exceeds_limit",
        // No ticket: no amount of waiting fixes this, and a ticket would both
        // loop the caller forever and block everything queued behind it.
        ticketId: null,
      });
    });
  });

  it("rejects a non-positive weight rather than silently granting it", async () => {
    await withLimiter({}, async ({ limiter }) => {
      await expect(limiter.acquire({ weight: 0, priority: "routine" })).rejects.toThrow();
      await expect(limiter.acquire({ weight: -5, priority: "routine" })).rejects.toThrow();
    });
  });
});

// ---------------------------------------------------------------------------
// Priority: the reserved slice
// ---------------------------------------------------------------------------

describe("the reserved slice", () => {
  it("lets a risk-exit request through a budget routine traffic has exhausted", async () => {
    // This is the case queue ordering cannot help with, and the reason step 2's
    // decision 10 reserved a slice: the stop-loss does not exist yet while the
    // routine traffic is spending, so there is nothing to order it against.
    await withLimiter({ limit: 120 }, async ({ limiter, acquire }) => {
      for (let spent = 0; spent < 100; spent += 10) {
        expect((await acquire(10, "routine")).granted).toBe(true);
      }
      expect((await acquire(1, "routine")).granted).toBe(false);

      // The whole reserve is still there, untouched by the routine burst.
      expect((await limiter.stats()).remainingRiskExit).toBe(20);
      expect((await acquire(20, "risk-exit")).granted).toBe(true);
    });
  });

  it("never lets routine traffic reach into the reserve, even in one large request", async () => {
    await withLimiter({ limit: 120 }, async ({ acquire }) => {
      // 101 is within the limit but past the routine ceiling. It must be
      // refused as exceeding the ceiling, not shaved down to fit.
      const denied = await acquire(101, "routine");
      expect(denied).toMatchObject({ granted: false, reason: "weight_exceeds_limit" });
      expect((await acquire(101, "risk-exit")).granted).toBe(true);
    });
  });

  it("scales the reserve with a limit read from exchangeInfo", async () => {
    await withLimiter({}, async ({ limiter }) => {
      await limiter.syncLimit(6000, 60_000, NOW);
      const stats = await limiter.stats();
      expect(stats.limit).toBe(6000);
      expect(stats.limitSource).toBe("exchangeInfo");
      // A fixed 200 would have become a proportionally smaller margin here
      // without anyone noticing, which is the failure the fraction avoids.
      expect(stats.reserveForRiskExit).toBe(Math.floor(6000 * RISK_EXIT_RESERVE_FRACTION));
    });
  });

  it("carries the weight already spent across a limit change", async () => {
    await withLimiter({ limit: 1200 }, async ({ limiter, acquire }) => {
      await acquire(500, "routine");
      await limiter.syncLimit(6000, 60_000, NOW);
      // Handing back a fresh budget on a limit change would let an account that
      // had just spent one spend it again inside the same window.
      expect((await limiter.stats()).usedWeight).toBe(500);
    });
  });
});

// ---------------------------------------------------------------------------
// Priority: queue ordering
// ---------------------------------------------------------------------------

describe("queue ordering", () => {
  it("serves a risk-exit request before a routine one that queued first", async () => {
    await withLimiter({ limit: 120, windowMs: 60_000 }, async ({ acquire, setNow }) => {
      // Spend the routine ceiling, then the reserve, so everything must queue.
      expect((await acquire(100, "routine")).granted).toBe(true);
      expect((await acquire(20, "risk-exit")).granted).toBe(true);

      const routine = await acquire(20, "routine");
      expect(routine.granted).toBe(false);
      if (routine.granted) return;

      // Queued LATER than the routine request, and must still go first.
      const risk = await acquire(20, "risk-exit");
      expect(risk.granted).toBe(false);
      if (risk.granted) return;
      expect(risk.queuePosition).toBe(0);

      // The routine request's position is read again rather than compared
      // against the value it was given while it was alone in the queue: a
      // position is a fact about the queue at a moment, not a property the
      // ticket carries around.
      const routineAgain = await acquire(20, "routine", routine.ticketId ?? undefined);
      expect(routineAgain).toMatchObject({ granted: false, queuePosition: 1 });

      // The whole window rolls over; both re-present at the same instant.
      setNow(NOW + 60_001);
      expect((await acquire(20, "risk-exit", risk.ticketId ?? undefined)).granted).toBe(true);
      expect((await acquire(20, "routine", routine.ticketId ?? undefined)).granted).toBe(true);
    });
  });

  it("blocks head-of-line: a small request cannot slip past a large one ahead of it", async () => {
    // Two separate spends at different instants, so the window frees in two
    // steps. With one big entry expiring at once there is enough for both
    // requests the moment it goes, and nothing needs to be deferred -- which is
    // correct behaviour, and would make this test pass without testing
    // anything.
    await withLimiter({ limit: 120, windowMs: 60_000 }, async ({ acquire, setNow }) => {
      expect((await acquire(50, "routine")).granted).toBe(true);
      setNow(NOW + 30_000);
      expect((await acquire(50, "routine")).granted).toBe(true);

      // Queues first, wanting 60. Only 20 is free.
      const big = await acquire(60, "risk-exit");
      expect(big.granted).toBe(false);
      if (big.granted) return;

      // The first 50 ages out: 70 free. A 15 would fit on its own -- but
      // granting it would leave 55, and starve the 60 that has been waiting.
      // Deferring it is the head-of-line rule doing its job.
      setNow(NOW + 60_001);
      const small = await acquire(15, "risk-exit");
      expect(small).toMatchObject({ granted: false, reason: "queued_behind" });
      if (small.granted) return;

      // The one that waited goes first.
      expect((await acquire(60, "risk-exit", big.ticketId ?? undefined)).granted).toBe(true);

      // And the small one follows once there is room for it too.
      setNow(NOW + 90_002);
      expect((await acquire(15, "risk-exit", small.ticketId ?? undefined)).granted).toBe(true);
    });
  });

  it("keeps a re-presented ticket's place, and sends a fresh arrival to the back", async () => {
    await withLimiter({ limit: 120, windowMs: 60_000 }, async ({ acquire, setNow }) => {
      expect((await acquire(100, "routine")).granted).toBe(true);

      const waiting = await acquire(60, "routine");
      expect(waiting.granted).toBe(false);
      if (waiting.granted) return;

      setNow(NOW + 60_001);

      // A brand-new request of the same priority arriving after the window
      // rolled must not overtake the one that has been waiting.
      const latecomer = await acquire(60, "routine");
      expect(latecomer).toMatchObject({ granted: false, reason: "queued_behind" });

      expect((await acquire(60, "routine", waiting.ticketId ?? undefined)).granted).toBe(true);
    });
  });

  it("treats an unknown ticket as a new arrival rather than an error", async () => {
    // The eviction case, stated as behaviour: losing a ticket costs a queue
    // place and never grants weight nobody asked for.
    await withLimiter({ limit: 120 }, async ({ acquire }) => {
      const result = await acquire(10, "routine", "ticket-from-a-previous-life");
      expect(result.granted).toBe(true);
    });
  });

  it("releases a queue place so it stops claiming weight", async () => {
    await withLimiter({ limit: 120, windowMs: 60_000 }, async ({ limiter, acquire, setNow }) => {
      expect((await acquire(100, "routine")).granted).toBe(true);
      const abandoned = await acquire(60, "routine");
      expect(abandoned.granted).toBe(false);
      if (abandoned.granted) return;

      setNow(NOW + 60_001);
      // While the abandoned ticket is live, a later request is behind it.
      expect((await acquire(60, "routine")).granted).toBe(false);

      await limiter.release(abandoned.ticketId!);
      expect((await limiter.stats()).queued).toBe(1); // only the later one
      expect((await acquire(60, "routine")).granted).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// Learning from the exchange
// ---------------------------------------------------------------------------

describe("syncFromExchange", () => {
  it("raises usage to the exchange's own figure, shutting the budget early", async () => {
    await withLimiter({ limit: 120 }, async ({ limiter, acquire }) => {
      // The account is busier than this object knows -- another client on the
      // same key, or a weight this system misjudged.
      await limiter.syncFromExchange(115, NOW);
      expect((await limiter.stats()).usedWeight).toBe(115);
      expect((await acquire(10, "routine")).granted).toBe(false);
      // The reserve still works off the same corrected figure.
      expect((await acquire(5, "risk-exit")).granted).toBe(true);
    });
  });

  it("never lowers usage on a stale low reading", async () => {
    await withLimiter({ limit: 120 }, async ({ limiter, acquire }) => {
      await acquire(80, "routine");
      await limiter.syncFromExchange(3, NOW);
      // A low report must not re-open a budget that has been spent.
      expect((await limiter.stats()).usedWeight).toBe(80);
    });
  });
});

// ---------------------------------------------------------------------------
// Concurrency, forced rather than raced
// ---------------------------------------------------------------------------

describe("two acquires interleaving", () => {
  it("cannot grant the same weight twice when one is suspended on its storage write", async () => {
    // The object's only await inside `acquire` is the persist. If the budget
    // were consumed AFTER that write instead of before it, both callers would
    // pass the check while the first was suspended and both be granted -- the
    // same shape as the lost update step 5's compare-and-swap defeats.
    //
    // A Durable Object serialises nothing across a NETWORK await, so this is a
    // real interleaving and not a hypothetical one. Forcing it is the only way
    // to make it reproducible.
    //
    // That sentence was carried here from step 8 as an assumption, and step 21
    // finally measured it: `concurrency-model.test.ts` shows an RPC and an
    // alarm both being delivered while a Durable Object sits suspended inside
    // an exchange call. The conclusion was right. The wording was not, and the
    // difference matters -- the same probe found a storage-only
    // read-modify-write surviving a two-pass race, so "nothing" overstated it.
    // What is unserialised is the await that leaves the object: a fetch, a
    // cross-object RPC, a D1 write.
    //
    // Note also what this test does NOT establish, since it reads like it
    // might: the competitor below is a direct in-process method call, not a
    // call through the stub, so it exercises the lost-update arithmetic rather
    // than the runtime's delivery. The probe is what covers delivery.
    await withLimiter({ limit: 120 }, async ({ limiter, state }) => {
      const events: string[] = [];
      const original = state.storage.put.bind(state.storage);
      let competed = false;
      let competitor: AcquireResult | undefined;

      Object.defineProperty(state.storage, "put", {
        configurable: true,
        writable: true,
        value: async (...args: unknown[]) => {
          if (!competed) {
            competed = true;
            events.push("first-persist-begins");
            // A second caller arrives while the first has decided but not yet
            // written.
            competitor = await limiter.acquire({ weight: 60, priority: "routine" });
            events.push(`competitor-${competitor.granted ? "granted" : "denied"}`);
          }
          const result = await (original as (...a: unknown[]) => Promise<unknown>)(...args);
          events.push("first-persist-ends");
          return result;
        },
      });

      const first = await limiter.acquire({ weight: 60, priority: "routine" });

      // Routine ceiling is 100. Two 60s do not both fit, and exactly one won.
      expect(first.granted).toBe(true);
      expect(competitor?.granted).toBe(false);
      expect((await limiter.stats()).usedWeight).toBe(60);

      // The interleaving genuinely happened. Without this the test could pass
      // simply because the competitor ran after the first had finished, which
      // would prove nothing -- the same trap step 5's ledger test had to close.
      expect(events).toEqual([
        "first-persist-begins",
        "competitor-denied",
        "first-persist-ends",
      ]);
    });
  });

  it("does not lose a grant when both requests fit", async () => {
    // The other half: contention must not cost a valid grant, and the total
    // must be the sum rather than one of the two.
    await withLimiter({ limit: 1200 }, async ({ limiter }) => {
      const results = await Promise.all([
        limiter.acquire({ weight: 20, priority: "routine" }),
        limiter.acquire({ weight: 30, priority: "routine" }),
        limiter.acquire({ weight: 6, priority: "risk-exit" }),
      ]);
      expect(results.every((result) => result.granted)).toBe(true);
      expect((await limiter.stats()).usedWeight).toBe(56);
    });
  });
});

// ---------------------------------------------------------------------------
// The cancellation storm (step 6's open question 7)
// ---------------------------------------------------------------------------

describe("a cancellation storm", () => {
  it("throttles a full grid ladder's cancellations instead of firing them all", async () => {
    // Step 6's open question 7: "a halt cancels orders one at a time... for
    // step 9's grid, a halt cancels a full ladder, and doing that serially with
    // no rate-limit budget is the exact scenario step 2's decision 10 reserved
    // budget for." This is that scenario, with the budget in place.
    //
    // 60 cancellations at 1 weight each, against a limit of 60 whose risk-exit
    // ceiling is the whole 60 -- but with 45 already spent by routine traffic.
    await withLimiter({ limit: 60, windowMs: 60_000 }, async ({ limiter, acquire, setNow }) => {
      expect((await acquire(45, "routine")).granted).toBe(true);

      const LADDER = 60;
      const first: AcquireResult[] = [];
      for (let i = 0; i < LADDER; i++) {
        first.push(await acquire(1, "risk-exit"));
      }

      const granted = first.filter((result) => result.granted);
      const deferred = first.filter((result) => !result.granted);

      // Exactly the remaining budget went out, and the rest were held. NOT all
      // 60 firing at once, which is what would earn the account a 429 and then
      // a ban -- during a halt, which is the worst possible moment.
      expect(granted).toHaveLength(15);
      expect(deferred).toHaveLength(45);
      expect((await limiter.stats()).usedWeight).toBe(60);

      // Every deferred cancellation holds a ticket, so its place is kept and it
      // is not competing from scratch with the others.
      expect(deferred.every((result) => !result.granted && result.ticketId !== null)).toBe(true);
      expect((await limiter.stats()).queued).toBe(45);

      // The window rolls; the held cancellations go through, in order, without
      // any of them having been dropped.
      setNow(NOW + 60_001);
      const second: AcquireResult[] = [];
      for (const result of deferred) {
        if (result.granted) continue;
        second.push(await acquire(1, "risk-exit", result.ticketId ?? undefined));
      }
      expect(second.every((result) => result.granted)).toBe(true);
      expect((await limiter.stats()).queued).toBe(0);
    });
  });

  it("does not let a storm of routine orders touch the reserve", async () => {
    // The same shape from the other side: a grid STARTING places a full ladder
    // of routine orders. That burst must not be able to spend what a halt of
    // the same ladder would need moments later.
    await withLimiter({ limit: 120, windowMs: 60_000 }, async ({ limiter, acquire }) => {
      const results: AcquireResult[] = [];
      for (let i = 0; i < 120; i++) {
        results.push(await acquire(1, "routine"));
      }
      expect(results.filter((result) => result.granted)).toHaveLength(100);

      const stats = await limiter.stats();
      expect(stats.usedWeight).toBe(100);
      expect(stats.remainingRiskExit).toBe(20);
    });
  });
});

// ---------------------------------------------------------------------------
// Surviving eviction
// ---------------------------------------------------------------------------

describe("persistence", () => {
  it("persists the spent window, so an evicted object does not wake up with a fresh budget", async () => {
    await withLimiter({ limit: 120 }, async ({ acquire, state }) => {
      await acquire(70, "routine");
      const stored = await state.storage.get<{
        limit: number;
        snapshot: { entries: readonly { weight: number }[] };
      }>("budget");
      expect(stored?.limit).toBe(120);
      expect(
        stored?.snapshot.entries.reduce((total, entry) => total + entry.weight, 0),
      ).toBe(70);
    });
  });

  it("restores the spent window after the object is torn down", async () => {
    await withLimiter({ limit: 120 }, async ({ limiter, acquire }) => {
      expect((await acquire(70, "routine")).granted).toBe(true);
      // Also leave a QUEUED ticket behind. Tickets live in memory only, so
      // whether one survives is what distinguishes a genuinely new instance
      // from the same one still being handed back -- without it this test would
      // pass vacuously if the teardown below did nothing.
      expect((await acquire(50, "routine")).granted).toBe(false);
      expect((await limiter.stats()).queued).toBe(1);
    });

    // Force the instance away. The next call constructs a new one, which must
    // read its window back rather than starting from zero -- otherwise an
    // object idle for ten seconds would permit a second full limit inside one
    // 60-second window, which is the double-rate failure a sliding window
    // exists to prevent.
    await inLimiter(account, async (_limiter, state) => {
      state.abort("evicting for the test");
    }).catch(() => undefined);

    await inLimiter(account, async (limiter) => {
      limiter.attach({ now: () => NOW, newId: ids() });
      const stats = await limiter.stats();

      // A new instance: the in-memory queue is gone...
      expect(stats.queued).toBe(0);
      // ...and the persisted budget is not.
      expect(stats.limit).toBe(120);
      expect(stats.limitSource).toBe("exchangeInfo");
      expect(stats.usedWeight).toBe(70);
      expect(stats.remainingRoutine).toBe(30);
    });
  });
});

// ---------------------------------------------------------------------------
// One object per account
// ---------------------------------------------------------------------------

describe("one budget per exchange account", () => {
  it("keeps two accounts' budgets entirely separate", async () => {
    await inLimiter("account-a", async (limiter) => {
      limiter.attach({ now: () => NOW, newId: ids() });
      await limiter.syncLimit(120, 60_000, NOW);
      expect((await limiter.acquire({ weight: 100, priority: "routine" })).granted).toBe(true);
    });

    await inLimiter("account-b", async (limiter) => {
      limiter.attach({ now: () => NOW, newId: ids() });
      await limiter.syncLimit(120, 60_000, NOW);
      // Section 3's isolation principle: one account's spend is not the
      // other's, and the object name is what guarantees it.
      expect((await limiter.stats()).usedWeight).toBe(0);
      expect((await limiter.acquire({ weight: 100, priority: "routine" })).granted).toBe(true);
    });
  });
});
