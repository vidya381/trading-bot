/**
 * THE POLLING DECISIONS, in a file with no React in it.
 *
 * ── HOW THIS FILE CAME TO EXIST, IN THE ORDER IT HAPPENED ──
 *
 * Decision log 54 deferred a confirmed, live-reproduced starvation bug on ONE
 * ground -- `usePolling` had six call sites and ZERO tests -- and named its own
 * expiry condition:
 *
 *   > "Reason 3 is the load-bearing one, and it names its own expiry condition.
 *   >  It is an argument about TEST COVERAGE, not about the defect's severity.
 *   >  COVER `usePolling` WITH TESTS AND REASON 3 EVAPORATES."
 *
 * So the work went in this order, and the order was the point:
 *
 *   1. This module was extracted from the hook with NO BEHAVIOUR CHANGE -- the
 *      unconditional `controller?.abort()` copied across verbatim, bug included.
 *   2. Group A of `pollEngine.test.ts` pinned the behaviour that existed then,
 *      including A7, which ASSERTED THE STARVATION HAPPENS: 13 requests
 *      dispatched over 60 s against a server answering every one, and zero
 *      answers surviving.
 *   3. The suite went green at 3,092 (3,085 + those 7), proving the extraction
 *      inert before anything trusted it.
 *   4. ONLY THEN did the three rules below replace the abort -- and A7 flipped
 *      from asserting starvation to asserting recovery. THAT FLIP IS THE FIX,
 *      stated as an executable assertion rather than as a commit message.
 *      (Decision log 54 PART 6 is a standing lesson about what commit messages
 *      are worth in this repository.)
 *
 * ── WHY A SEPARATE FILE AT ALL ──
 *
 * A test importing a `.tsx` COLLECTS ZERO TESTS RATHER THAN FAILING inside the
 * Workers pool this suite runs in (docs/open-items/component-test-harness.md;
 * decision logs 44, 45, 46, 48). React's CJS build does not resolve there, and
 * the failure is SILENT -- a component test added today reports "0 tests" and a
 * green suite. So the decisions live HERE, where a test can reach them, and
 * `usePolling.ts` keeps only the wiring. Same split as `statusCounts.ts`,
 * `accountTotals.ts`, `killSwitchBannerState.ts` and `availableCapital.ts`; the
 * fifth application of an established pattern, not a new idea.
 *
 * ── ⚠ NO FAKE TIMERS. THIS IS WHY THE PORTS EXIST ──
 *
 * `grep -rn "useFakeTimers\|advanceTimersByTime"` over this repository returns
 * NOTHING. Vitest's fake timers patch global `setTimeout`/`setInterval` via
 * `@sinonjs/fake-timers`, and whether that behaves correctly inside workerd is
 * UNPROVEN HERE. A polling test is the worst possible place to find out.
 *
 * So time is an INJECTED PORT, not a patched global. Tests drive a manual clock
 * by calling a function. Nothing in this module reads `Date.now()` or calls
 * `setInterval`; `usePolling.ts` supplies the real ones and is the only file that
 * does. `readonly now: () => Timestamp` is the convention
 * `src/research/candidates.ts:343`, `watchlist.ts:112`, `proposal-log.ts:171` and
 * `reconciliation/reconcile.ts:147` already use. `Timestamp` is `number` and is
 * deliberately NOT imported from `src/shared/exchange-client.ts`, which would
 * drag an exchange module into the dashboard bundle for one type alias.
 *
 * ── THE BUG THIS FIXES (decision log 54 PARTS 3 and 4) ──
 *
 * Every tick used to open by aborting the previous still-pending request. If the
 * API answers slower than the 5s interval, no request ever survives to resolve,
 * the `AbortError` is swallowed, and NO STATE UPDATE EVER RUNS. The operator
 * confirmed this live, twice, by delaying `window.fetch`: at 6,000 ms and at
 * 20,000 ms, ZERO successful responses in 60 s across three pollers. 6,000 ms is
 * only 1.2x the interval, and entry 47's HAR recorded a real SUCCESSFUL response
 * at ~4,957 ms -- under 43 ms of headroom.
 *
 * Two failure rows, and the second is the dangerous one:
 *
 *   COLD (no poll ever succeeded) -- `loading: true` FOREVER. "Loading..." forever.
 *   WARM (a poll succeeded earlier) -- stale `data`, `error: null`, `lastUpdated`
 *        FROZEN. Stale numbers behind a green dot still reading "Live".
 *
 * ── THE THREE RULES THAT REPLACE THE UNCONDITIONAL ABORT ──
 *
 *   1. AT MOST ONE REQUEST IN FLIGHT, EVER. An interval tick that finds a request
 *      already running DOES NOTHING -- it does not abort, and it does not start a
 *      second request. THIS IS WHAT FIXES THE STARVATION.
 *
 *      ⚠ THE RESULTING CADENCE IS QUANTISED, AND IT IS NOT max(interval, latency).
 *      A skipped tick does not fire the moment the in-flight request lands; it
 *      waits for the NEXT interval boundary. So a 6 s response on a 5 s interval
 *      polls every 10 s, not every 6 s -- ceil(latency / interval) * interval.
 *      Test A7 pins the exact number (7 requests in 60 s, not 10).
 *
 *      That is a deliberate choice of the simpler mechanism over a catch-up one
 *      that would re-fire on completion. It costs freshness in exactly the
 *      regime where the server is already struggling, and it buys a rule with no
 *      "did we owe a tick?" state to get wrong. If the quantisation ever matters
 *      more than the simplicity, firing a tick on settle when one was skipped is
 *      the change -- and A7, B3 and B4's request counts are what would move.
 *   2. EVERY REQUEST IS BOUNDED BY A TIMEOUT, and a timeout is an ERROR, not a
 *      silent abort. This restores the only useful thing the old abort did --
 *      bounding a request that will never answer -- without throwing away answers
 *      that were going to arrive. Without it, rule 1 would trade starvation for a
 *      permanent silent stall on a genuinely hung socket.
 *   3. `refetch` SUPERSEDES; THE INTERVAL DOES NOT. A manual refetch after a
 *      mutation is a deliberate "throw away the old answer, I changed the world"
 *      signal, so it may abort the in-flight poll and start its own.
 *
 * ⚠ RULE 3 IS NOT A DETAIL. `refetch` reaches this same code path, so before the
 * fix IT STARVED TOO -- and `refetch` is what runs immediately after a mutation
 * (`LiquidateAction`). The moment an operator most needs a confirmed fresh read,
 * just after moving money, was served by the same starving mechanism. Rule 1
 * fixes the interval; rule 3 is why the manual path is fixed by the same change
 * rather than left as a follow-up.
 *
 * The invariant the three preserve: A NEW REQUEST ONLY EVER STARTS BY REPLACING
 * THE OLD ONE, NEVER ALONGSIDE IT. Requests never overlap, so there is no second
 * response for an older one to arrive after -- the out-of-order hazard is closed
 * STRUCTURALLY rather than mitigated. That is why this is the skip-tick design
 * and not the "let both run" one, which would answer a slow server with MORE
 * concurrent load and guarantee stale responses overwriting fresh ones.
 *
 * ── ⚠ WHY THE TIMEOUT CANNOT BE A BARE `abort()` ──
 *
 * `client.ts:83` rethrows an `AbortError` UNWRAPPED while wrapping every other
 * rejection in an `ApiError`, specifically so this module can recognise it. The
 * consequence: EVERY abort looks identical here. A timeout implemented as a plain
 * `controller.abort()` would be caught by the same swallow that ignores unmount
 * and supersession, and THE FIX WOULD DO NOTHING AT ALL WHILE APPEARING TO WORK.
 *
 * So a timeout is not recognised by sniffing the `DOMException` -- the browser
 * gives ours and the lifecycle's the same `name`. It is recognised because THIS
 * MODULE RECORDED THAT IT TIMED THIS PARTICULAR REQUEST OUT (`timedOutSeq`), and
 * that record is what turns the abort into a `PollTimeoutError`. Tests B6 and B7
 * pin both halves: ours surfaces, the lifecycle's stays silent.
 *
 * ── THE SEQUENCE GUARD, AND WHY IT EXISTS WHEN OVERLAP IS ALREADY IMPOSSIBLE ──
 *
 * Every request carries a monotonically increasing sequence number, and ANY
 * settle -- success, error or timeout -- whose sequence is not the current one is
 * DROPPED at the single place state is written. Two reasons it is here even
 * though rule 1 already makes overlap structurally impossible:
 *
 *   * `controller.abort()` IS NOT SYNCHRONOUS CANCELLATION. Aborting a request
 *     whose response has ALREADY been received does not un-receive it. A
 *     superseded request (rule 3) can still resolve successfully and try to write
 *     older data over newer. This hazard existed in the original hook too.
 *   * AN INVARIANT MAINTAINED ONLY BY CAREFUL CONTROL FLOW IS INVISIBLE TO A
 *     TEST. A guard at the write boundary is an assertion a test can name and a
 *     mutation run can kill -- group C exists because of this line.
 */

/** Epoch milliseconds. The `readonly now: () => Timestamp` convention, locally. */
export type Timestamp = number;

/** Cancels a scheduled callback. Idempotent by contract. */
export type CancelTimer = () => void;

/**
 * The timer port. `usePolling.ts` supplies the platform's real ones; tests supply
 * a manual clock. NOTHING ELSE IN THIS MODULE TOUCHES TIME.
 *
 * `repeat` is `setInterval` and `delay` is `setTimeout`, kept as two members
 * rather than one self-rescheduling primitive: a chain of one-shots drifts by the
 * handler's own duration each cycle, which would have made the extraction a
 * behaviour change disguised as a refactor. `delay` arrived with rule 2 -- the
 * timeout -- and group A did not have to change to accommodate it.
 */
export interface PollTimers {
  readonly repeat: (fn: () => void, ms: number) => CancelTimer;
  readonly delay: (fn: () => void, ms: number) => CancelTimer;
}

/** The snapshot pushed to the consumer. Identical in shape to what the hook held. */
export interface PollData<T> {
  readonly data: T | null;
  readonly error: Error | null;
  readonly loading: boolean;
  /** Epoch ms of the last SUCCESSFUL load, or null before the first. */
  readonly lastUpdated: Timestamp | null;
}

/**
 * The state every poll starts in, exported so the engine and the React hook
 * cannot drift into two different definitions of "nothing has happened yet".
 */
export function initialPollData<T>(): PollData<T> {
  return { data: null, error: null, loading: true, lastUpdated: null };
}

/**
 * How long a single request may run before it is abandoned AS AN ERROR.
 *
 * ⚠ A POLICY NUMBER, in the category `VERIFIED_INTERVALS` (`candles.ts`) and the
 * staleness thresholds (`src/research/staleness.ts`) already occupy: no backtest
 * supports it and no measurement produced it. What it IS grounded in is a bound
 * it must clear. Entry 47's HAR recorded a REAL, SUCCESSFUL kill-switch response
 * at ~4,957 ms of server wait, and total elapsed was necessarily higher. A
 * timeout at or near the 5,000 ms poll interval would therefore abandon responses
 * that were about to arrive -- which is decision log 54's bug rewritten with a new
 * constant. 20,000 ms is four poll intervals, and roughly four times the slowest
 * response this system has ever been observed to produce.
 */
export const POLL_TIMEOUT_MS = 20_000;

/**
 * A request this engine gave up on.
 *
 * A REAL `Error` and deliberately NOT a `DOMException` -- see "WHY THE TIMEOUT
 * CANNOT BE A BARE abort()" above. It reaches the UI through `PollData.error`
 * like any other failure, so the last-good rule keeps the previous data on screen
 * beside it rather than blanking the page.
 */
export class PollTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`the request did not answer within ${timeoutMs} ms and was abandoned`);
    this.name = "PollTimeoutError";
  }
}

/**
 * Everything the engine needs from the outside world. All of it injected: no
 * ambient `Date`, no ambient timer, no React.
 */
export interface PollEnginePorts<T> {
  /**
   * The request. Called with a signal the engine owns.
   *
   * `usePolling` passes a STABLE wrapper that reads its own ref, preserving the
   * old behaviour exactly: a fetcher whose identity changes every render (e.g.
   * `Dashboard.tsx:79`'s inline arrow) must not restart the interval, and each
   * tick must use the latest one.
   */
  readonly fetcher: (signal: AbortSignal) => Promise<T>;
  readonly now: () => Timestamp;
  readonly timers: PollTimers;
  /** Pushed a COMPLETE snapshot on every state change. Never called after `stop`. */
  readonly onChange: (snapshot: PollData<T>) => void;
  readonly intervalMs: number;
  /** Rule 2's bound. Defaults to `POLL_TIMEOUT_MS`; injected by tests. */
  readonly timeoutMs?: number;
  /**
   * The state the engine resumes FROM.
   *
   * Not always `initialPollData()`. The old hook's `useEffect` re-ran when
   * `intervalMs` changed, and React's `useState` DOES NOT RESET across that --
   * previously fetched data survived. Seeding the engine preserves that; a fresh
   * engine resetting to `loading: true` would blank a populated screen on any
   * future interval change, a regression this refactor would have smuggled in.
   */
  readonly initial?: PollData<T>;
}

export interface PollEngine {
  /** Fetch once immediately, then every `intervalMs`. */
  readonly start: () => void;
  /** Abort in flight, cancel the timer, and emit nothing further. */
  readonly stop: () => void;
  /**
   * Force an immediate fetch outside the interval, resolving when it settles.
   * Used after a mutation (e.g. a liquidation) so the view reflects the new state
   * at once. A no-op that resolves immediately after `stop`.
   */
  readonly refetch: () => Promise<void>;
}

/** A lifecycle abort, not a real failure. The old `catch`'s test, unchanged. */
function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

export function createPollEngine<T>(ports: PollEnginePorts<T>): PollEngine {
  const timeoutMs = ports.timeoutMs ?? POLL_TIMEOUT_MS;

  let current: PollData<T> = ports.initial ?? initialPollData<T>();
  let stopped = false;
  let started = false;
  let controller: AbortController | null = null;
  let cancelInterval: CancelTimer | null = null;
  let cancelTimeout: CancelTimer | null = null;

  /** Rule 1's state: is a request out right now? */
  let inFlight = false;

  /**
   * The sequence of the request whose settle is allowed to write. Incremented
   * when a request STARTS, so a superseded one can never match again.
   */
  let seq = 0;
  /** The sequence THIS ENGINE timed out. The abort's only distinguishing mark. */
  let timedOutSeq: number | null = null;

  const emit = (next: PollData<T>) => {
    current = next;
    ports.onChange(next);
  };

  /**
   * `reason` is the whole of rule 1 versus rule 3: an `interval` tick yields to a
   * request already in flight, while a `refetch` (or the very first fetch)
   * supersedes it.
   */
  const tick = async (reason: "initial" | "interval" | "refetch"): Promise<void> => {
    if (stopped) return;

    // ── RULE 1 ── The line decision log 54's bug lived in. This used to be an
    // unconditional `controller?.abort()`, so a slow-but-healthy server never got
    // to answer. Now a tick that finds a request already out simply yields: no
    // abort, no second request, and the answer in flight is allowed to arrive.
    if (inFlight && reason === "interval") return;

    // ── RULE 3 ── Only a deliberate refetch supersedes, and only when there is
    // something to supersede. Its abort stays swallowed: superseding is
    // intentional, so it is not a failure to report.
    if (inFlight) controller?.abort();
    cancelTimeout?.();
    cancelTimeout = null;

    const mine = new AbortController();
    controller = mine;
    seq += 1;
    const mySeq = seq;
    inFlight = true;

    // ── RULE 2 ── Bounded, and RECORDED, so the resulting AbortError is
    // recognisable as ours rather than as an unmount.
    cancelTimeout = ports.timers.delay(() => {
      if (stopped || mySeq !== seq) return;
      timedOutSeq = mySeq;
      mine.abort();
    }, timeoutMs);

    try {
      const data = await ports.fetcher(mine.signal);
      // THE WRITE BOUNDARY. A superseded request that won the abort race still
      // resolves with real -- and older -- data. It is dropped here.
      if (stopped || mySeq !== seq) return;
      emit({ data, error: null, loading: false, lastUpdated: ports.now() });
    } catch (error) {
      if (stopped || mySeq !== seq) return;
      const timedOut = timedOutSeq === mySeq;
      // A lifecycle or supersession abort is not a failure to report. OURS is.
      if (isAbortError(error) && !timedOut) return;
      const reported = timedOut
        ? new PollTimeoutError(timeoutMs)
        : error instanceof Error
          ? error
          : new Error(String(error));
      // THE LAST-GOOD RULE (decision logs 47, 51), UNCHANGED BY THIS FIX: keep
      // the previous data and its timestamp, report the error beside them. A
      // transient blip must not blank a money dashboard, and must not drop a
      // TRIPPED kill-switch bar.
      emit({
        data: current.data,
        error: reported,
        loading: false,
        lastUpdated: current.lastUpdated,
      });
    } finally {
      // Only the CURRENT request may release the in-flight latch; a superseded
      // one settling later must not open the door for a second concurrent
      // request behind the one that replaced it.
      if (mySeq === seq) {
        inFlight = false;
        cancelTimeout?.();
        cancelTimeout = null;
      }
    }
  };

  return {
    start: () => {
      if (stopped || started) return;
      started = true;
      void tick("initial");
      cancelInterval = ports.timers.repeat(() => void tick("interval"), ports.intervalMs);
    },
    stop: () => {
      stopped = true;
      controller?.abort();
      cancelInterval?.();
      cancelInterval = null;
      cancelTimeout?.();
      cancelTimeout = null;
    },
    refetch: () => (stopped ? Promise.resolve() : tick("refetch")),
  };
}
