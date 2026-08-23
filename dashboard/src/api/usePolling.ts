/**
 * Poll a fetcher on a fixed interval (this session's brief item 7: refetch every
 * 5 seconds while the page is open; no WebSockets, a deliberate simplification).
 *
 * ── ⚠ THIS FILE IS WIRING. THE DECISIONS ARE IN `pollEngine.ts` ──
 *
 * Every branch that used to live here -- when to fetch, what to do with an
 * abort, how a failure combines with the last good data -- now lives in
 * `pollEngine.ts`, which imports no React and which the test suite can therefore
 * actually execute. A test importing a `.tsx` collects ZERO TESTS RATHER THAN
 * FAILING in the Workers pool this suite runs in, and this module is one import
 * away from that world; `pollEngine.ts` is not.
 *
 * What remains here is the three things only React can do: hold the state, tie
 * the poll's lifetime to the component's, and keep `refetch` callable across
 * renders. If a future edit adds an `if` to this file, it has put a decision
 * somewhere no test can reach -- `poll-structure.test.ts` fails the build for it.
 *
 * Behaviour that matters for a money dashboard, unchanged and now pinned by
 * tests rather than asserted in a comment:
 *   - Fetches once immediately, then every `intervalMs`.
 *   - Keeps the LAST GOOD data when a poll fails, and surfaces the error
 *     alongside it -- a transient blip must not blank the screen. `loading` is
 *     true only until the first successful (or failed) load.
 *   - Aborts an in-flight request on unmount, so a slow response cannot leak
 *     past unmount.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { createPollEngine, initialPollData, type PollData, type PollTimers } from "./pollEngine";

export const POLL_INTERVAL_MS = 5000;

/**
 * The platform's real timers, supplied to the engine here and NOWHERE ELSE.
 *
 * This is the only place in the dashboard that touches a real timer or a real
 * clock for polling purposes, which is what lets every test drive a manual one
 * without any global patching (see `pollEngine.ts`'s "NO FAKE TIMERS").
 */
const REAL_TIMERS: PollTimers = {
  repeat: (fn, ms) => {
    const id = setInterval(fn, ms);
    return () => clearInterval(id);
  },
  delay: (fn, ms) => {
    const id = setTimeout(fn, ms);
    return () => clearTimeout(id);
  },
};

export interface PollState<T> extends PollData<T> {
  /**
   * Force an immediate fetch, outside the interval, and resolve when it
   * settles. Used after a mutation (e.g. a liquidation) so the view reflects
   * the new state at once rather than after up to one poll interval. A no-op
   * after unmount.
   */
  readonly refetch: () => Promise<void>;
}

export function usePolling<T>(
  fetcher: (signal: AbortSignal) => Promise<T>,
  intervalMs: number = POLL_INTERVAL_MS,
): PollState<T> {
  const [state, setState] = useState<PollData<T>>(initialPollData<T>);

  // Keep the fetcher in a ref so changing its identity does not restart the
  // interval; the engine reads the latest one through this stable wrapper.
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  // What the engine RESUMES FROM if the effect re-runs. React's `useState` does
  // not reset across an effect restart, so the engine must not either -- see
  // `PollEnginePorts.initial`.
  const stateRef = useRef(state);
  stateRef.current = state;

  // The live engine's `refetch` for this mount. Reset to a no-op on unmount so a
  // forced refetch after unmount does nothing.
  const refetchRef = useRef<() => Promise<void>>(() => Promise.resolve());

  useEffect(() => {
    const engine = createPollEngine<T>({
      fetcher: (signal) => fetcherRef.current(signal),
      now: () => Date.now(),
      timers: REAL_TIMERS,
      onChange: setState,
      intervalMs,
      initial: stateRef.current,
    });
    refetchRef.current = engine.refetch;
    engine.start();

    return () => {
      engine.stop();
      refetchRef.current = () => Promise.resolve();
    };
  }, [intervalMs]);

  const refetch = useCallback(() => refetchRef.current(), []);

  return { ...state, refetch };
}
