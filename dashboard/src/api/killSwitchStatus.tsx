/**
 * The ONE kill-switch subscription for the whole app (step 47).
 *
 * WHY THIS EXISTS. `GET /api/kill-switch` was polled by three independent
 * `usePolling` call sites -- `KillSwitchBanner` (mounted outside the router in
 * App.tsx, so it never unmounts), `Dashboard`'s own `killSwitchPoll`, and
 * `KillSwitchPage`'s. Two of the three are mounted at once on `/` (banner +
 * dashboard) and on `/kill-switch` (banner + page), so the endpoint was polled
 * at twice the intended rate on both routes. The operator's HAR measured it:
 * 232 kill-switch requests in 609 s (~2.6 s apart) against 116 alerts requests
 * (~5.25 s apart) over the same window -- exactly double, from two 5 s timers
 * running at arbitrary phase. See docs/decision-log/47.md.
 *
 * All three read the SAME singleton row (`global_kill_switch`, migration 0005,
 * `id CHECK (id = 1)`). There is no per-account, per-bot or per-page variant to
 * poll for, so three subscriptions could only ever return the same answer at
 * three times the cost. One poll, shared, is not a cache -- it is the removal of
 * a duplicate.
 *
 * WHY A CONTEXT RATHER THAN A MODULE-LEVEL STORE. This codebase holds all
 * client state in React hooks and passes it down as props; there is no store
 * library and no global mutable singleton anywhere in /dashboard/src. A context
 * keeps the poll's lifetime tied to the component tree exactly as `usePolling`
 * already assumes (it aborts in-flight requests on unmount), so nothing here
 * has to reason about a subscription outliving the app.
 *
 * WHY THE WHOLE `PollState`, NOT JUST THE DATA. Consumers need more than the
 * status: `KillSwitchPage` shows a freshness indicator from `lastUpdated` and
 * `error`, a first-load state from `loading`, and -- critically -- hands
 * `refetch` to the trigger and reset actions so the view reflects a pull or a
 * re-arm at once instead of up to 5 s later. Exposing only `data` would have
 * silently dropped those three consumers.
 *
 * A REAL CORRECTNESS GAIN, NOT ONLY A COST ONE. Because `refetch` now refreshes
 * the single shared poll, pulling the switch on `/kill-switch` updates the page,
 * the dashboard tile AND the global banner in the same tick. Before, `refetch`
 * touched only the page's own poller, leaving the banner showing a stale armed
 * state for up to one interval after the switch had actually been pulled.
 */

import { createContext, useContext, type ReactNode } from "react";
import { fetchKillSwitch } from "./client";
import { usePolling, type PollState } from "./usePolling";
import type { KillSwitchStatus } from "./types";

/**
 * `null` means "no provider above me", which is a wiring bug rather than a
 * loading state -- `useKillSwitchStatus` throws on it. A default poll object
 * here would let a consumer mounted outside the provider silently render an
 * armed-looking banner forever, which is the one failure this element must
 * never have.
 */
const KillSwitchContext = createContext<PollState<KillSwitchStatus> | null>(null);

/**
 * Mounted once, in App.tsx, wrapping BOTH the banner and the routed area. It
 * sits outside `<Routes>` for the same reason the banner does: navigation must
 * not tear down and restart the poll, and a tripped switch must be visible on
 * every route.
 */
export function KillSwitchStatusProvider({ children }: { children: ReactNode }) {
  const poll = usePolling<KillSwitchStatus>(fetchKillSwitch);
  return <KillSwitchContext.Provider value={poll}>{children}</KillSwitchContext.Provider>;
}

/** The shared kill-switch poll. Throws if no provider is above the caller. */
export function useKillSwitchStatus(): PollState<KillSwitchStatus> {
  const poll = useContext(KillSwitchContext);
  if (poll === null) {
    throw new Error(
      "useKillSwitchStatus() was called outside <KillSwitchStatusProvider>. " +
        "The provider is mounted in App.tsx and must wrap every consumer.",
    );
  }
  return poll;
}
