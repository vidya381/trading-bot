/**
 * The global tripped banner (this session's brief item 6).
 *
 * A tripped global kill switch is the single most severe state the whole system
 * can be in: every bot on every account has been halted and none can be created
 * or resumed until a human resets it. That fact must be impossible to miss
 * ANYWHERE in the app, not only on the kill switch's own page -- so this banner
 * is mounted in `App.tsx` OUTSIDE the routed area, alongside the environment
 * banner, and therefore renders on every page including each bot's detail view.
 *
 * It reads the app's ONE shared kill-switch poll (`useKillSwitchStatus`, step
 * 47) rather than running its own. It used to call `usePolling(fetchKillSwitch)`
 * directly, which meant that on `/` and on `/kill-switch` -- where a second
 * consumer is also mounted -- the endpoint was polled twice per interval for the
 * same singleton row. The shared poll keeps last-good data through a transient
 * blip exactly as before, so a failed poll never makes a real tripped state
 * silently vanish. When the switch is armed -- the normal case -- it renders
 * nothing, so it adds no chrome and cannot flash on first load (data is null
 * until the first poll resolves).
 *
 * It is deliberately loud (solid red, full width) and links straight to the
 * control page so the switch can be inspected or reset from wherever the reader
 * happens to be.
 */

import { Link } from "react-router-dom";
import { useKillSwitchStatus } from "../api/killSwitchStatus";
import { formatDateTime } from "../format";

export function KillSwitchBanner() {
  const poll = useKillSwitchStatus();
  const status = poll.data;

  // Armed (or not yet loaded): render nothing. Only a genuinely tripped switch
  // shows the bar. usePolling keeps the last-good status, so a failed poll while
  // tripped keeps the bar up rather than dropping it.
  if (status === null || status.state !== "tripped") return null;

  return (
    <div role="alert" className="bg-red-700 text-red-50">
      <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2.5 sm:px-6 lg:px-8">
        <span className="inline-flex items-center gap-2 font-semibold uppercase tracking-wide">
          <span aria-hidden>⛔</span>
          Global kill switch tripped
        </span>
        <span className="min-w-0 flex-1 text-sm text-red-100">
          {status.reason ?? "no reason recorded"}
          <span className="text-red-200/80">
            {". Pulled by "}
            {status.trippedBy ?? "unknown"} at {formatDateTime(status.trippedAt)}. Every bot is halted;
            none can create or resume until reset.
          </span>
        </span>
        <Link
          to="/kill-switch"
          className="shrink-0 rounded-md bg-red-50 px-3 py-1 text-sm font-semibold text-red-800 hover:bg-white"
        >
          Manage kill switch →
        </Link>
      </div>
    </div>
  );
}
