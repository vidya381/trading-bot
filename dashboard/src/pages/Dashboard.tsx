/**
 * The dashboard page: owns the polling and feeds both the status strip and the
 * bot list from it, so a single 5-second poll drives the whole view (brief item
 * 7). Bots and alerts are polled independently; each keeps its last-good data
 * across a transient failure and surfaces the error without blanking the screen.
 */

import { useState } from "react";
import { Link } from "react-router-dom";
import { fetchAlerts, fetchBots, fetchKillSwitch } from "../api/client";
import { usePolling } from "../api/usePolling";
import type { Alert, Bot, KillSwitchStatus } from "../api/types";
import { StatusStrip } from "../components/StatusStrip";
import { BotList } from "../components/BotList";
import { formatTime } from "../format";

function FreshnessIndicator({
  lastUpdated,
  error,
}: {
  lastUpdated: number | null;
  error: Error | null;
}) {
  return (
    <div className="flex items-center gap-2 text-xs text-zinc-500">
      <span
        className={[
          "inline-block h-2 w-2 rounded-full",
          error ? "bg-red-400" : "bg-emerald-400",
        ].join(" ")}
        aria-hidden
      />
      <span>
        {error ? "Update failed" : "Live"} · updated {formatTime(lastUpdated)}
      </span>
    </div>
  );
}

/**
 * The "Show archived" toggle (step 26).
 *
 * A real checkbox rather than a styled div, so it is keyboard-reachable and
 * announced as a checkbox without any ARIA of our own. It states the count it
 * would reveal, which is what keeps archiving from hiding anything silently: the
 * number is on screen even when the archived rows are not.
 */
function ShowArchivedToggle({
  checked,
  archivedCount,
  onChange,
}: {
  checked: boolean;
  archivedCount: number;
  onChange: (next: boolean) => void;
}) {
  // Nothing archived and nothing to reveal: the control would be a no-op with a
  // count of zero beside it.
  if (archivedCount === 0 && !checked) return null;
  return (
    <label className="flex cursor-pointer select-none items-center gap-2 text-xs text-zinc-400 hover:text-zinc-300">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="h-3.5 w-3.5 rounded border-zinc-600 bg-zinc-900 accent-zinc-400"
      />
      Show archived
      <span className="tabular text-zinc-500">({archivedCount})</span>
    </label>
  );
}

export function Dashboard() {
  const botsPoll = usePolling<Bot[]>(fetchBots);
  // Unfiltered: the status strip derives its unresolved-alert count from this
  // list. The cross-bot feed (/alerts) does its own filtered poll.
  const alertsPoll = usePolling<Alert[]>((signal) => fetchAlerts({}, signal));
  // The kill-switch state is polled independently (like bots and alerts), so it
  // keeps last-good through a blip and one endpoint failing never blanks another.
  const killSwitchPoll = usePolling<KillSwitchStatus>(fetchKillSwitch);

  const [showArchived, setShowArchived] = useState(false);

  const bots = botsPoll.data ?? [];
  const alerts = alertsPoll.data ?? [];
  /*
   * The archived filter is applied HERE and to the TABLE ONLY (step 26).
   *
   * `StatusStrip` -- and the account-level totals inside it -- is deliberately
   * given the FULL list. An archived bot is halted or stopped, not closed: it
   * still holds its capital allocation, and it may still hold inventory. A
   * total that changed when a view toggle flipped would silently under-report
   * committed capital, which is exactly the class of quiet omission step 25 was
   * built to avoid. Hiding is a view decision; the arithmetic is not.
   *
   * The backend agrees by doing nothing: `GET /api/bots` has no archived filter,
   * so this page always has every bot in hand.
   */
  const archivedCount = bots.filter((bot) => bot.archived).length;
  const visibleBots = showArchived ? bots : bots.filter((bot) => !bot.archived);
  const firstLoad = botsPoll.loading && botsPoll.data === null;
  const hardError = botsPoll.error !== null && botsPoll.data === null;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold text-zinc-100">Bots</h1>
        <div className="flex items-center gap-3">
          <ShowArchivedToggle
            checked={showArchived}
            archivedCount={archivedCount}
            onChange={setShowArchived}
          />
          <FreshnessIndicator
            lastUpdated={botsPoll.lastUpdated ?? alertsPoll.lastUpdated}
            error={botsPoll.error ?? alertsPoll.error}
          />
          <Link
            to="/alerts"
            className="inline-flex items-center rounded-md border border-zinc-700 px-3 py-1.5 text-sm font-medium text-zinc-300 hover:border-zinc-600 hover:text-zinc-100"
          >
            Alerts
          </Link>
          {/*
           * Spec 21.4 stage 4. Read-only and inert — it renders two responses
           * the operator already holds and calls nothing, so it sits with the
           * other navigation rather than with the actions.
           */}
          <Link
            to="/proposal"
            className="inline-flex items-center rounded-md border border-zinc-700 px-3 py-1.5 text-sm font-medium text-zinc-300 hover:border-zinc-600 hover:text-zinc-100"
          >
            Proposal
          </Link>
          <Link
            to="/manual-adjustments"
            className="inline-flex items-center rounded-md border border-zinc-700 px-3 py-1.5 text-sm font-medium text-zinc-300 hover:border-zinc-600 hover:text-zinc-100"
          >
            Log adjustment
          </Link>
          <Link
            to="/bots/new"
            className="inline-flex items-center gap-1.5 rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-emerald-500"
          >
            <span aria-hidden>＋</span> Create bot
          </Link>
        </div>
      </div>

      <StatusStrip bots={bots} alerts={alerts} killSwitch={killSwitchPoll.data} />

      {firstLoad ? (
        <div className="rounded-lg border border-zinc-800 px-4 py-10 text-center text-sm text-zinc-500">
          Loading bots…
        </div>
      ) : hardError ? (
        <div className="rounded-lg border border-red-500/30 bg-red-500/5 px-4 py-10 text-center text-sm text-red-300">
          Couldn’t load bots: {botsPoll.error?.message}
          <div className="mt-1 text-xs text-red-400/70">
            If this persists, your Cloudflare Access session may have expired. Reload to sign in again.
          </div>
        </div>
      ) : (
        <BotList bots={visibleBots} hiddenCount={bots.length - visibleBots.length} />
      )}
    </div>
  );
}
