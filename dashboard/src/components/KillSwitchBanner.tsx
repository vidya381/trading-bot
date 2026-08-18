/**
 * The global kill-switch banner (kill-switch session's brief item 6; the third
 * state added in the step following decision log 47).
 *
 * A tripped global kill switch is the single most severe state the whole system
 * can be in: every bot on every account has been halted and none can be created
 * or resumed until a human resets it. That fact must be impossible to miss
 * ANYWHERE in the app, not only on the kill switch's own page -- so this banner
 * is mounted in `App.tsx` OUTSIDE the routed area, alongside the environment
 * banner, and therefore renders on every page including each bot's detail view.
 *
 * It reads the app's ONE shared kill-switch poll (`useKillSwitchStatus`, step
 * 47) rather than running its own, and it keeps last-good data through a
 * transient blip exactly as before, so a failed poll never makes a real tripped
 * state silently vanish.
 *
 * ── THE THIRD STATE, AND WHY IT EXISTS ──
 *
 * This file used to decide with one line:
 *
 *     if (status === null || status.state !== "tripped") return null;
 *
 * which rendered nothing for "armed", for "still loading", AND for "no poll has
 * ever succeeded". Decision log 47 section 8 named that last one as a real
 * safety-communication gap and deferred it to its own step, on the grounds that
 * a visible change to the loudest element in the system deserves a design pass
 * rather than a silent rider on a consolidation commit. This is that step.
 *
 * The verdict now comes from `killSwitchBannerState` (../killSwitchBannerState),
 * a React-free module the suite can actually reach -- this file holds only the
 * copy, the colour and the placement. Three of its four states are rendered:
 *
 *   tripped -- SOLID RED fill, `role="alert"`, a filled white button.
 *   unknown -- SOLID AMBER-900 fill, a 2px amber-400 rule along the BOTTOM
 *              edge, `role="status"`, a filled amber button.
 *   armed / pending -- nothing at all, exactly as before.
 *
 * ── ⚠ THE TONE, WHICH IS THE ACTUAL DESIGN DECISION ──
 *
 * Amber is the third colour rather than a second shade of red because decision
 * log 47 asked the right question about this bar: does it risk crying wolf often
 * enough to train the operator to ignore the RED one that matters. A different
 * HUE is what stops habituation to one bar from dulling the other.
 *
 * So the severity ordering is carried by WEIGHT rather than by hue, and the two
 * axes are kept independent on purpose:
 *
 *   HUE says which CATEGORY  -- red is "confirmed danger", amber is "caution".
 *   WEIGHT says how URGENT   -- amber-900 `oklch(41.4% 0.112)` against red-700
 *                               `oklch(50.5% 0.213)`. Red is 9 points lighter and
 *                               carries NEARLY TWICE the chroma, so it stays
 *                               unambiguously the louder bar even though both are
 *                               now solid fills.
 *
 * An earlier version of this bar used `bg-amber-950` with hairline rules, and it
 * under-communicated what the copy actually says: the operator cannot confirm the
 * fleet would stop. A bar that says that must not look purely informational. It
 * is now a real filled bar -- same geometry, same padding class scale and the
 * same filled call-to-action as the tripped bar -- one step below red rather than
 * one step above nothing.
 *
 * ⚠ THE BOTTOM RULE IS BOTTOM-ONLY, AND THAT IS NOT AN AESTHETIC CHOICE. On
 * testnet the `EnvironmentBanner` directly above this one is a solid
 * `bg-amber-400` bar -- the exact colour of this rule. A matching top rule would
 * abut it and simply read as the environment banner being 2px thicker. The band's
 * TOP edge needs no drawn rule anyway: amber-400 at 82.8% lightness against
 * amber-900 at 41.4% is a 41-point step, which is its own edge.
 *
 * `role="status"` (polite) against the tripped bar's `role="alert"` (assertive)
 * keeps the severity ordering for a screen reader, where the visual weight cannot
 * carry it. Two assertive bars is where alert habituation starts.
 *
 * It never appears during ordinary first-load latency -- `pending` is a distinct
 * state and renders nothing -- so the bar means "checks are failing", not "the
 * page is new".
 *
 * The copy states the consequence rather than the failure, because the
 * consequence is the part the operator cannot infer: a tripped switch would not
 * be shown here. It does not say anything is wrong with the bots, because this
 * banner does not know that and must not imply it.
 */

import { Link } from "react-router-dom";
import { useKillSwitchStatus } from "../api/killSwitchStatus";
import { killSwitchBannerState } from "../killSwitchBannerState";
import { formatDateTime } from "../format";

export function KillSwitchBanner() {
  const poll = useKillSwitchStatus();
  const status = poll.data;
  const state = killSwitchBannerState(poll);

  // Confirmed safe, or the first poll is still in flight. No chrome, and no red
  // flash on load. These are separate facts (see killSwitchBannerState.ts); they
  // happen to share a rendering.
  if (state === "armed" || state === "pending") return null;

  if (state === "unknown") {
    return (
      <div role="status" className="border-b-2 border-amber-400 bg-amber-900 text-amber-100">
        <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 sm:px-6 lg:px-8">
          <span className="inline-flex items-center gap-2 font-semibold uppercase tracking-wide text-amber-50">
            <span aria-hidden className="text-lg leading-none">
              ⚠
            </span>
            Kill-switch status unconfirmed
          </span>
          <span className="min-w-0 flex-1 text-sm">
            No kill-switch check has succeeded yet, so this bar cannot say whether the switch is
            armed or tripped.
            <span className="text-amber-200/80">
              {" A tripped switch would not be shown here until one does."}
              {poll.error !== null ? ` Last attempt: ${poll.error.message}.` : ""}
            </span>
          </span>
          <Link
            to="/kill-switch"
            className="shrink-0 rounded-md bg-amber-400 px-3 py-1 text-sm font-semibold text-amber-950 hover:bg-amber-300"
          >
            Check kill switch →
          </Link>
        </div>
      </div>
    );
  }

  // `tripped`. `status` is non-null here: "tripped" is only ever returned from a
  // real status object, and the narrowing below is the type system agreeing.
  if (status === null) return null;

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
