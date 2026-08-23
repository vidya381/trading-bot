/**
 * `pollEngine` — the first tests `usePolling`'s logic has ever had.
 *
 * Decision log 54 deferred a confirmed, live-reproduced starvation bug on ONE
 * ground: six call sites, zero tests. It named its own expiry condition -- "cover
 * `usePolling` with tests and reason 3 evaporates". This file is that condition
 * being met.
 *
 * ── ⚠ NO FAKE TIMERS ANYWHERE IN HERE ──
 *
 * This repository has never used `vi.useFakeTimers`, and a polling test is the
 * worst place to be the first to bet on `@sinonjs/fake-timers` behaving inside
 * workerd. Instead `manualClock()` below IS the clock: the engine's `now` and
 * `timers` ports are wired to it, the fetcher doubles resolve on it too, and
 * `advance()` moves time by calling a function. The only real asynchrony left is
 * the microtask queue, which `flush()` drains.
 *
 * That means these tests are DETERMINISTIC -- "6,000 ms of latency against a
 * 5,000 ms interval" is an exact statement here, not a race the CI machine's load
 * could change the outcome of.
 *
 * ── GROUP A ARE PINS, AND ONE OF THEM ASSERTS THE BUG ──
 *
 * A1-A6 pin behaviour that must survive the fix untouched. A7 pins the
 * STARVATION ITSELF -- it asserts that a slow-but-healthy server produces zero
 * updates forever, because that is what this code does today. It is a
 * characterization test, written to be INVERTED by the fix. That inversion is the
 * fix's entire claim, stated as an executable assertion instead of a commit
 * message (decision log 54 PART 6 is a standing lesson about what commit messages
 * are worth here).
 */

import { describe, expect, it } from "vitest";
import {
  createPollEngine,
  POLL_TIMEOUT_MS,
  PollTimeoutError,
  type PollData,
  type Timestamp,
} from "./pollEngine";

// ---------------------------------------------------------------------------
// The manual clock. Not a mock of a timer -- the only timer these tests have.
// ---------------------------------------------------------------------------

interface Task {
  readonly id: number;
  at: number;
  readonly fn: () => void;
  readonly everyMs: number | null;
}

/** Drain the microtask queue. Generous: promise chains here are ~3 deep. */
async function flush(): Promise<void> {
  for (let i = 0; i < 30; i += 1) await Promise.resolve();
}

function manualClock() {
  let now: Timestamp = 0;
  let nextId = 1;
  let tasks: Task[] = [];

  const cancel = (id: number) => {
    tasks = tasks.filter((task) => task.id !== id);
  };

  const schedule = (fn: () => void, ms: number, everyMs: number | null) => {
    const id = nextId;
    nextId += 1;
    tasks.push({ id, at: now + ms, fn, everyMs });
    return () => cancel(id);
  };

  return {
    now: () => now,
    /**
     * Both timer shapes. The engine's port only requires `repeat` today; `delay`
     * is here because the FETCHER DOUBLES need it (a "6 s response" is a
     * resolution scheduled 6 s out on this same clock), and because a structural
     * port means the fix can start requiring `delay` without these tests
     * changing shape.
     */
    timers: {
      repeat: (fn: () => void, ms: number) => schedule(fn, ms, ms),
      delay: (fn: () => void, ms: number) => schedule(fn, ms, null),
    },
    /** Move time forward, firing due tasks in order and draining microtasks. */
    advance: async (ms: number): Promise<void> => {
      const target = now + ms;
      for (;;) {
        const due = tasks.filter((task) => task.at <= target).sort((a, b) => a.at - b.at)[0];
        if (due === undefined) break;
        now = due.at;
        if (due.everyMs !== null) due.at = now + due.everyMs;
        else cancel(due.id);
        due.fn();
        await flush();
      }
      now = target;
      await flush();
    },
  };
}

type ManualClock = ReturnType<typeof manualClock>;

// ---------------------------------------------------------------------------
// Fetcher doubles
// ---------------------------------------------------------------------------

/** What a real aborted `fetch` rejects with, and what `client.ts:83` rethrows. */
function abortError(): DOMException {
  return new DOMException("The operation was aborted.", "AbortError");
}

/**
 * A fetcher that answers after `latencyMs` OF CLOCK TIME, honouring its signal.
 * Counts requests started and tracks the high-water mark of concurrent ones --
 * "at most one in flight" is otherwise an invisible property.
 */
function latentFetcher<T>(clock: ManualClock, latencyMs: number, value: (n: number) => T) {
  let started = 0;
  let inFlight = 0;
  let maxInFlight = 0;

  const fetcher = (signal: AbortSignal): Promise<T> => {
    started += 1;
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    const n = started;
    let settled = false;
    const done = () => {
      if (settled) return false;
      settled = true;
      inFlight -= 1;
      return true;
    };
    return new Promise<T>((resolve, reject) => {
      const cancelDelay = clock.timers.delay(() => {
        if (done()) resolve(value(n));
      }, latencyMs);
      signal.addEventListener(
        "abort",
        () => {
          cancelDelay();
          if (done()) reject(abortError());
        },
        { once: true },
      );
    });
  };

  return {
    fetcher,
    get started() {
      return started;
    },
    get maxInFlight() {
      return maxInFlight;
    },
  };
}

/** Collects every snapshot the engine pushes. */
function recorder<T>() {
  const snapshots: PollData<T>[] = [];
  return {
    snapshots,
    onChange: (snapshot: PollData<T>) => void snapshots.push(snapshot),
    get last(): PollData<T> | undefined {
      return snapshots[snapshots.length - 1];
    },
  };
}

const INTERVAL = 5000;

// ---------------------------------------------------------------------------
// GROUP A — behaviour-preserving pins.
// ---------------------------------------------------------------------------

describe("A. pins — behaviour that existed before any fix", () => {
  it("A1: fetches once IMMEDIATELY on start, not after one interval", async () => {
    const clock = manualClock();
    const net = latentFetcher(clock, 100, (n) => `v${n}`);
    const seen = recorder<string>();

    createPollEngine<string>({
      fetcher: net.fetcher,
      now: clock.now,
      timers: clock.timers,
      onChange: seen.onChange,
      intervalMs: INTERVAL,
    }).start();
    await flush();

    // Zero time has passed and a request is already out. A poll that waited one
    // interval would leave the dashboard blank for 5 s on every page load.
    expect(net.started).toBe(1);
    expect(clock.now()).toBe(0);
  });

  it("A2: a success sets data, clears error, ends loading, and stamps the INJECTED clock", async () => {
    const clock = manualClock();
    const net = latentFetcher(clock, 100, (n) => `v${n}`);
    const seen = recorder<string>();

    createPollEngine<string>({
      fetcher: net.fetcher,
      now: clock.now,
      timers: clock.timers,
      onChange: seen.onChange,
      intervalMs: INTERVAL,
    }).start();
    await clock.advance(100);

    expect(seen.snapshots).toHaveLength(1);
    expect(seen.last).toEqual({
      data: "v1",
      error: null,
      loading: false,
      // Not `Date.now()`. Proof the engine reads no ambient clock: if it did,
      // this would be a 13-digit epoch rather than 100.
      lastUpdated: 100,
    });
  });

  it("A3: a failure KEEPS the last good data and its timestamp, and reports the error beside them", async () => {
    const clock = manualClock();
    const seen = recorder<string>();
    let attempt = 0;
    const fetcher = (): Promise<string> => {
      attempt += 1;
      return attempt === 1 ? Promise.resolve("good") : Promise.reject(new Error("boom"));
    };

    const engine = createPollEngine<string>({
      fetcher,
      now: clock.now,
      timers: clock.timers,
      onChange: seen.onChange,
      intervalMs: INTERVAL,
    });
    engine.start();
    await flush();
    await clock.advance(INTERVAL);

    // The rule from decision logs 47 and 51 that must never regress: a blip does
    // not blank a money dashboard, and does not drop a TRIPPED kill-switch bar.
    expect(seen.last?.data).toBe("good");
    expect(seen.last?.lastUpdated).toBe(0);
    expect(seen.last?.error?.message).toBe("boom");
    expect(seen.last?.loading).toBe(false);
  });

  it("A4: an abort caused by stop() is SWALLOWED — it is not reported as an error", async () => {
    const clock = manualClock();
    const net = latentFetcher(clock, 1000, (n) => `v${n}`);
    const seen = recorder<string>();

    const engine = createPollEngine<string>({
      fetcher: net.fetcher,
      now: clock.now,
      timers: clock.timers,
      onChange: seen.onChange,
      intervalMs: INTERVAL,
    });
    engine.start();
    await flush();
    engine.stop();
    await clock.advance(5000);

    // An unmount is not a failure. Reporting it would flash "Update failed" on
    // every navigation.
    expect(seen.snapshots).toEqual([]);
  });

  it("A5: stop() aborts the in-flight request AND cancels the interval", async () => {
    const clock = manualClock();
    const net = latentFetcher(clock, 100, (n) => `v${n}`);
    const seen = recorder<string>();

    const engine = createPollEngine<string>({
      fetcher: net.fetcher,
      now: clock.now,
      timers: clock.timers,
      onChange: seen.onChange,
      intervalMs: INTERVAL,
    });
    engine.start();
    await flush();
    engine.stop();
    await clock.advance(60_000);

    // Twelve intervals passed. A leaked timer would have fired every one of them.
    expect(net.started).toBe(1);
    expect(seen.snapshots).toEqual([]);
  });

  it("A6: refetch() after stop() is a no-op that still resolves", async () => {
    const clock = manualClock();
    const net = latentFetcher(clock, 100, (n) => `v${n}`);
    const seen = recorder<string>();

    const engine = createPollEngine<string>({
      fetcher: net.fetcher,
      now: clock.now,
      timers: clock.timers,
      onChange: seen.onChange,
      intervalMs: INTERVAL,
    });
    engine.start();
    await flush();
    engine.stop();

    // Must RESOLVE, not hang: `LiquidateAction` awaits this, and an unmount
    // during the await would otherwise leave the caller pending forever.
    await expect(engine.refetch()).resolves.toBeUndefined();
    expect(net.started).toBe(1);
    expect(seen.snapshots).toEqual([]);
  });

  it("A7: ⚠ THE FLIP — a 6 s response against a 5 s interval now COMPLETES (decision log 54)", async () => {
    const clock = manualClock();
    // 6,000 ms is 1.2x the interval, exactly the operator's live reproduction.
    // Entry 47's HAR recorded a real SUCCESSFUL response at ~4,957 ms, so this is
    // not a pathological delay -- it is barely above normal.
    const net = latentFetcher(clock, 6000, (n) => `v${n}`);
    const seen = recorder<string>();

    createPollEngine<string>({
      fetcher: net.fetcher,
      now: clock.now,
      timers: clock.timers,
      onChange: seen.onChange,
      intervalMs: INTERVAL,
    }).start();
    await clock.advance(60_000);

    /*
     * ⚠ THIS TEST IS THE FIX.
     *
     * Before the three rules landed, this same test asserted the OPPOSITE and
     * passed:
     *
     *     expect(net.started).toBe(13);      // one per tick, every one aborted
     *     expect(seen.snapshots).toEqual([]); // not one answer survived
     *
     * Thirteen requests dispatched against a server that answered every one of
     * them, and zero answers surviving -- decision log 54's starvation, reproduced
     * mechanically. The fix turned that into `expected 7 to be 13`, and the two
     * numbers below are what replaced it. Nothing else in group A moved.
     */
    expect(net.started).toBe(7);
    expect(seen.snapshots).toHaveLength(6);

    // Rule 1 in one assertion: the cadence degraded to the honest one -- roughly
    // max(interval, latency) -- instead of collapsing to nothing.
    expect(seen.last?.data).toBe("v6");
    expect(seen.last?.lastUpdated).toBe(56_000);
    expect(seen.last?.error).toBeNull();
    expect(seen.last?.loading).toBe(false);

    // And the answers arrived in order, none of them dropped or reordered.
    expect(seen.snapshots.map((snapshot) => snapshot.data)).toEqual([
      "v1",
      "v2",
      "v3",
      "v4",
      "v5",
      "v6",
    ]);
  });
});

// ---------------------------------------------------------------------------
// GROUP B — the fix. Rules 1, 2 and 3.
// ---------------------------------------------------------------------------

/** A request that never answers on its own. Only an abort ever settles it. */
function hangingFetcher(onStart?: () => void) {
  let started = 0;
  const fetcher = (signal: AbortSignal): Promise<string> => {
    started += 1;
    onStart?.();
    return new Promise<string>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(abortError()), { once: true });
    });
  };
  return {
    fetcher,
    get started() {
      return started;
    },
  };
}

describe("B. the fix — single-flight, and a timeout that is a real error", () => {
  it("B1: sustained slow responses keep `lastUpdated` ADVANCING — the frozen-timestamp WARM row is gone", async () => {
    const clock = manualClock();
    const net = latentFetcher(clock, 8000, (n) => `v${n}`);
    const seen = recorder<string>();

    createPollEngine<string>({
      fetcher: net.fetcher,
      now: clock.now,
      timers: clock.timers,
      onChange: seen.onChange,
      intervalMs: INTERVAL,
    }).start();
    await clock.advance(60_000);

    // Decision log 54 PART 3's dangerous row was `lastUpdated` FROZEN while the
    // page kept showing old numbers behind a green "Live" dot. The timestamp now
    // moves, so anything reading it -- the indicator, `pollFreshness` -- gets the
    // truth instead of a stopped clock.
    const stamps = seen.snapshots.map((snapshot) => snapshot.lastUpdated);
    expect(stamps.length).toBeGreaterThan(1);
    for (let i = 1; i < stamps.length; i += 1) {
      expect(stamps[i]!).toBeGreaterThan(stamps[i - 1]!);
    }
    // And a slow server is not an error. It is slow.
    expect(seen.snapshots.every((snapshot) => snapshot.error === null)).toBe(true);
  });

  it("B2: RULE 1 — never more than one request in flight, however slow the server is", async () => {
    const clock = manualClock();
    const net = latentFetcher(clock, 17_000, (n) => `v${n}`);
    const seen = recorder<string>();

    createPollEngine<string>({
      fetcher: net.fetcher,
      now: clock.now,
      timers: clock.timers,
      onChange: seen.onChange,
      intervalMs: INTERVAL,
    }).start();
    await clock.advance(120_000);

    // 17 s of latency against a 5 s interval: the "let both run" design would
    // have had three or four requests out at once here. The high-water mark is
    // the whole reason `latentFetcher` tracks concurrency at all.
    expect(net.maxInFlight).toBe(1);
    expect(seen.snapshots.length).toBeGreaterThan(0);
  });

  it("B3: NO PILEUP — a slow server receives fewer requests, not more", async () => {
    const clock = manualClock();
    const net = latentFetcher(clock, 6000, (n) => `v${n}`);
    const seen = recorder<string>();

    createPollEngine<string>({
      fetcher: net.fetcher,
      now: clock.now,
      timers: clock.timers,
      onChange: seen.onChange,
      intervalMs: INTERVAL,
    }).start();
    await clock.advance(60_000);

    // The old code dispatched 13 (one per tick) and threw all 13 away. Answering
    // a struggling server with MORE concurrent load is what the rejected
    // "let both run" variant would have done.
    expect(net.started).toBe(7);
    expect(net.started).toBeLessThanOrEqual(Math.ceil(60_000 / 6000) + 1);
  });

  it("B4: FAST PATH UNREGRESSED — a quick server is still polled once per interval, on the interval", async () => {
    const clock = manualClock();
    const net = latentFetcher(clock, 50, (n) => `v${n}`);
    const seen = recorder<string>();

    createPollEngine<string>({
      fetcher: net.fetcher,
      now: clock.now,
      timers: clock.timers,
      onChange: seen.onChange,
      intervalMs: INTERVAL,
    }).start();
    await clock.advance(60_000);

    // t=0 plus twelve intervals. A fix that turned polling into a hot loop, or
    // that skipped ticks it should not have, fails here.
    expect(net.started).toBe(13);
    // Twelve answered; the thirteenth went out AT t=60,000 and is still in flight
    // (it answers at 60,050, past the window). Stated exactly rather than rounded.
    expect(seen.snapshots).toHaveLength(12);
    expect(seen.snapshots.map((snapshot) => snapshot.lastUpdated).slice(0, 3)).toEqual([
      50, 5050, 10_050,
    ]);
    expect(net.maxInFlight).toBe(1);
  });

  it("B5: RULE 2 — a request that never answers is BOUNDED, and the poll carries on afterwards", async () => {
    const clock = manualClock();
    const net = hangingFetcher();
    const seen = recorder<string>();

    createPollEngine<string>({
      fetcher: net.fetcher,
      now: clock.now,
      timers: clock.timers,
      onChange: seen.onChange,
      intervalMs: INTERVAL,
    }).start();

    // Nineteen seconds in, the request is still out and nothing has been claimed.
    await clock.advance(19_000);
    expect(seen.snapshots).toEqual([]);
    expect(net.started).toBe(1);

    // At the timeout it is abandoned -- and a NEW request goes out. Without rule
    // 2, rule 1 would have traded starvation for a permanent silent stall.
    await clock.advance(2000);
    expect(seen.snapshots).toHaveLength(1);
    expect(net.started).toBe(2);
  });

  it("B6: ⚠ RULE 2's POINT — the timeout surfaces as a REAL error and is not swallowed", async () => {
    const clock = manualClock();
    const seen = recorder<string>();
    let attempt = 0;
    const fetcher = (signal: AbortSignal): Promise<string> => {
      attempt += 1;
      if (attempt === 1) return Promise.resolve("good");
      return new Promise<string>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(abortError()), { once: true });
      });
    };

    createPollEngine<string>({
      fetcher,
      now: clock.now,
      timers: clock.timers,
      onChange: seen.onChange,
      intervalMs: INTERVAL,
    }).start();
    await flush();
    await clock.advance(25_000);

    /*
     * THIS IS THE TEST THE DESIGN SAID COULD NOT BE SKIPPED.
     *
     * `client.ts:83` rethrows an AbortError UNWRAPPED, and the engine's catch
     * swallows AbortErrors. So a timeout implemented as a bare `controller.abort()`
     * is INDISTINGUISHABLE from an unmount, gets swallowed by that same line, and
     * the whole fix does nothing while appearing to work. The engine tells them
     * apart by remembering which sequence IT timed out -- not by inspecting the
     * DOMException, which is identical in both cases.
     */
    expect(seen.last?.error).toBeInstanceOf(PollTimeoutError);
    expect((seen.last?.error as PollTimeoutError).timeoutMs).toBe(20_000);
    expect(POLL_TIMEOUT_MS).toBe(20_000);

    // Last-good survives a timeout, exactly as it survives any other error.
    expect(seen.last?.data).toBe("good");
    expect(seen.last?.lastUpdated).toBe(0);
  });

  it("B7: THE COMPLEMENT — a supersession abort is still SWALLOWED, not reported", async () => {
    const clock = manualClock();
    const seen = recorder<string>();
    let attempt = 0;
    const fetcher = (signal: AbortSignal): Promise<string> => {
      attempt += 1;
      if (attempt === 1) {
        return new Promise<string>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(abortError()), { once: true });
        });
      }
      return Promise.resolve("fresh");
    };

    const engine = createPollEngine<string>({
      fetcher,
      now: clock.now,
      timers: clock.timers,
      onChange: seen.onChange,
      intervalMs: INTERVAL,
    });
    engine.start();
    await flush();
    await engine.refetch();

    // The refetch deliberately killed the in-flight request. That is not a
    // failure and must never render "Update failed" -- B6 and B7 together are
    // what make "distinguishable" a property rather than a claim.
    expect(seen.snapshots).toHaveLength(1);
    expect(seen.last?.error).toBeNull();
    expect(seen.last?.data).toBe("fresh");
  });

  it("B8: RECOVERY — a success after a timeout clears the error and advances the timestamp", async () => {
    const clock = manualClock();
    const seen = recorder<string>();
    let attempt = 0;
    const fetcher = (signal: AbortSignal): Promise<string> => {
      attempt += 1;
      if (attempt === 1) {
        return new Promise<string>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(abortError()), { once: true });
        });
      }
      return Promise.resolve(`v${attempt}`);
    };

    createPollEngine<string>({
      fetcher,
      now: clock.now,
      timers: clock.timers,
      onChange: seen.onChange,
      intervalMs: INTERVAL,
    }).start();
    await clock.advance(20_000);

    /*
     * Both the 20,000 ms timeout and the fourth interval tick fall on t=20,000,
     * and they fire in that order: the request is abandoned, then the very next
     * tick immediately succeeds. So the RECOVERY IS ASSERTED AS A SEQUENCE rather
     * than as a final state -- the error snapshot must actually have been emitted,
     * not skipped over.
     */
    expect(seen.snapshots).toHaveLength(2);
    expect(seen.snapshots[0]!.error).toBeInstanceOf(PollTimeoutError);
    expect(seen.snapshots[0]!.data).toBeNull();

    // A dashboard that stayed in an error state after the network came back would
    // be its own bug.
    expect(seen.last?.error).toBeNull();
    expect(seen.last?.data).toBe("v2");
    expect(seen.last?.lastUpdated).toBe(20_000);
  });
});

// ---------------------------------------------------------------------------
// GROUP C — ordering. The sequence guard at the write boundary.
// ---------------------------------------------------------------------------

/**
 * A request that IGNORES ITS ABORT SIGNAL and settles on its own schedule.
 *
 * This is not a contrived double. `controller.abort()` is not synchronous
 * cancellation: a request whose response has ALREADY been received does not
 * un-receive it, so a superseded request really can come back with a full,
 * successful, STALE answer. That is the race these tests force to happen.
 */
function stubbornFetcher<T>(clock: ManualClock, plan: readonly { at: number; settle: () => Promise<T> }[]) {
  let started = 0;
  const fetcher = (): Promise<T> => {
    const step = plan[started];
    started += 1;
    if (step === undefined) return new Promise<T>(() => {});
    return new Promise<T>((resolve, reject) => {
      clock.timers.delay(() => void step.settle().then(resolve, reject), step.at);
    });
  };
  return {
    fetcher,
    get started() {
      return started;
    },
  };
}

/** Far enough out that the interval never interferes with a race under test. */
const NO_INTERVAL = 100_000;

describe("C. ordering — a stale answer can never overwrite a fresh one", () => {
  it("C1: an OUT-OF-ORDER success is dropped — the newer answer wins", async () => {
    const clock = manualClock();
    const seen = recorder<string>();
    // The superseded request answers LAST, and answers successfully.
    const net = stubbornFetcher<string>(clock, [
      { at: 10_000, settle: () => Promise.resolve("STALE") },
      { at: 1000, settle: () => Promise.resolve("fresh") },
    ]);

    const engine = createPollEngine<string>({
      fetcher: net.fetcher,
      now: clock.now,
      timers: clock.timers,
      onChange: seen.onChange,
      intervalMs: NO_INTERVAL,
    });
    engine.start();
    await flush();
    void engine.refetch();
    await clock.advance(10_000);

    // Without the guard the screen would end on "STALE" -- older data, written
    // over newer, carrying a NEWER timestamp and no error. Invisible on the page.
    expect(seen.last?.data).toBe("fresh");
    expect(seen.snapshots.map((snapshot) => snapshot.data)).toEqual(["fresh"]);
  });

  it("C2: a superseded FAILURE cannot overwrite a newer success", async () => {
    const clock = manualClock();
    const seen = recorder<string>();
    const net = stubbornFetcher<string>(clock, [
      { at: 10_000, settle: () => Promise.reject(new Error("late failure")) },
      { at: 1000, settle: () => Promise.resolve("fresh") },
    ]);

    const engine = createPollEngine<string>({
      fetcher: net.fetcher,
      now: clock.now,
      timers: clock.timers,
      onChange: seen.onChange,
      intervalMs: NO_INTERVAL,
    });
    engine.start();
    await flush();
    void engine.refetch();
    await clock.advance(10_000);

    // "Update failed" appearing beside data that loaded perfectly well, because
    // a request abandoned ten seconds ago finally gave up.
    expect(seen.last?.error).toBeNull();
    expect(seen.last?.data).toBe("fresh");
  });

  it("C3: ⚠ a superseded success cannot silently ERASE a newer error", async () => {
    const clock = manualClock();
    const seen = recorder<string>();
    const net = stubbornFetcher<string>(clock, [
      { at: 10_000, settle: () => Promise.resolve("STALE") },
      { at: 1000, settle: () => Promise.reject(new Error("boom")) },
    ]);

    const engine = createPollEngine<string>({
      fetcher: net.fetcher,
      now: clock.now,
      timers: clock.timers,
      onChange: seen.onChange,
      intervalMs: NO_INTERVAL,
    });
    engine.start();
    await flush();
    void engine.refetch();
    await clock.advance(10_000);

    /*
     * The nastiest ordering in the set, and the reason C3 is not a duplicate of
     * C1. A dropped stale SUCCESS landing on top of a real ERROR would read as a
     * RECOVERY THAT NEVER HAPPENED: the error clears, ten-second-old data appears
     * with a brand-new `lastUpdated`, and the indicator goes green. Every visible
     * signal would say "Live" about a request that failed.
     */
    expect(seen.snapshots).toHaveLength(1);
    expect(seen.last?.error?.message).toBe("boom");
    expect(seen.last?.data).toBeNull();
  });

  it("C4: RULE 3 — a MANUAL REFETCH supersedes, survives the interval, and resolves on its OWN settle", async () => {
    const clock = manualClock();
    const seen = recorder<string>();
    // Slower than the interval: before the fix this is precisely the condition
    // under which a refetch could never complete.
    const net = latentFetcher(clock, 12_000, (n) => `v${n}`);

    const engine = createPollEngine<string>({
      fetcher: net.fetcher,
      now: clock.now,
      timers: clock.timers,
      onChange: seen.onChange,
      intervalMs: INTERVAL,
    });
    engine.start();
    await flush();

    let settled = false;
    const pending = engine.refetch().then(() => {
      settled = true;
    });

    /*
     * ⚠ THE LIQUIDATION PATH, WHICH STARVED TOO.
     *
     * `refetch` reaches the same code that the interval reaches, so before the
     * fix it was subject to the same abort chain -- and `refetch` is what runs
     * immediately after a mutation (`LiquidateAction`). The moment an operator
     * most needs a confirmed fresh read, just after moving money, was served by
     * the starving mechanism.
     *
     * Two interval ticks pass here while the refetch's own request is in flight.
     * Rule 1 makes them yield to it REGARDLESS OF WHO STARTED IT -- which is why
     * the manual path is fixed by the same change rather than needing its own.
     */
    await clock.advance(11_999);
    expect(settled).toBe(false);
    expect(net.started).toBe(2);

    await clock.advance(1);
    await pending;

    // It resolves on ITS OWN request's settle. Resolving on the SUPERSEDED
    // request's settle would resolve against data fetched BEFORE the mutation --
    // the exact staleness `refetch` exists to avoid.
    expect(settled).toBe(true);
    expect(net.maxInFlight).toBe(1);
    expect(seen.last?.data).toBe("v2");
    expect(seen.last?.error).toBeNull();
  });

  it("C5: RULE 1's other half — an interval tick does NOT supersede; it starts nothing and aborts nothing", async () => {
    const clock = manualClock();
    const seen = recorder<string>();
    const net = latentFetcher(clock, 12_000, (n) => `v${n}`);

    createPollEngine<string>({
      fetcher: net.fetcher,
      now: clock.now,
      timers: clock.timers,
      onChange: seen.onChange,
      intervalMs: INTERVAL,
    }).start();

    // Two interval ticks pass while the first request is still out.
    await clock.advance(11_000);
    expect(net.started).toBe(1);
    expect(seen.snapshots).toEqual([]);

    // And the request they declined to kill answers normally. This single
    // assertion is decision log 54's whole defect, inverted.
    await clock.advance(1000);
    expect(seen.last?.data).toBe("v1");
    expect(seen.last?.error).toBeNull();
  });
});
