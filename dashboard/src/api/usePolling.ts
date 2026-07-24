/**
 * Poll a fetcher on a fixed interval (this session's brief item 7: refetch every
 * 5 seconds while the page is open; no WebSockets, a deliberate simplification).
 *
 * Behaviour that matters for a money dashboard:
 *   - Fetches once immediately, then every `intervalMs`.
 *   - Keeps the LAST GOOD data when a poll fails, and surfaces the error
 *     alongside it -- a transient blip must not blank the screen. `loading` is
 *     true only until the first successful (or failed) load.
 *   - Aborts an in-flight request on unmount and on each new tick, so a slow
 *     response cannot overwrite a newer one or leak past unmount.
 */

import { useCallback, useEffect, useRef, useState } from "react";

export const POLL_INTERVAL_MS = 5000;

interface PollData<T> {
  readonly data: T | null;
  readonly error: Error | null;
  readonly loading: boolean;
  /** Epoch ms of the last SUCCESSFUL load, or null before the first. */
  readonly lastUpdated: number | null;
}

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
  const [state, setState] = useState<PollData<T>>({
    data: null,
    error: null,
    loading: true,
    lastUpdated: null,
  });

  // Keep the fetcher in a ref so changing its identity does not restart the
  // interval; the polling loop reads the latest one each tick.
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  // The live `tick` for this mount, exposed through `refetch`. Reset to a no-op
  // on unmount so a forced refetch after unmount does nothing.
  const tickRef = useRef<() => Promise<void>>(() => Promise.resolve());

  useEffect(() => {
    let stopped = false;
    let controller: AbortController | null = null;

    const tick = async () => {
      controller?.abort();
      controller = new AbortController();
      try {
        const data = await fetcherRef.current(controller.signal);
        if (stopped) return;
        setState({ data, error: null, loading: false, lastUpdated: Date.now() });
      } catch (error) {
        if (stopped) return;
        if (error instanceof DOMException && error.name === "AbortError") return;
        // Keep last-good data; report the error next to it.
        setState((prev) => ({
          data: prev.data,
          error: error instanceof Error ? error : new Error(String(error)),
          loading: false,
          lastUpdated: prev.lastUpdated,
        }));
      }
    };

    tickRef.current = tick;
    void tick();
    const id = setInterval(() => void tick(), intervalMs);

    return () => {
      stopped = true;
      controller?.abort();
      clearInterval(id);
      tickRef.current = () => Promise.resolve();
    };
  }, [intervalMs]);

  const refetch = useCallback(() => tickRef.current(), []);

  return { ...state, refetch };
}
