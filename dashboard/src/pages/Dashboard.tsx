/**
 * The dashboard page: owns the polling and feeds both the status strip and the
 * bot list from it, so a single 5-second poll drives the whole view (brief item
 * 7). Bots and alerts are polled independently; each keeps its last-good data
 * across a transient failure and surfaces the error without blanking the screen.
 */

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

export function Dashboard() {
  const botsPoll = usePolling<Bot[]>(fetchBots);
  const alertsPoll = usePolling<Alert[]>(fetchAlerts);
  // The kill-switch state is polled independently (like bots and alerts), so it
  // keeps last-good through a blip and one endpoint failing never blanks another.
  const killSwitchPoll = usePolling<KillSwitchStatus>(fetchKillSwitch);

  const bots = botsPoll.data ?? [];
  const alerts = alertsPoll.data ?? [];
  const firstLoad = botsPoll.loading && botsPoll.data === null;
  const hardError = botsPoll.error !== null && botsPoll.data === null;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold text-zinc-100">Bots</h1>
        <div className="flex items-center gap-3">
          <FreshnessIndicator
            lastUpdated={botsPoll.lastUpdated ?? alertsPoll.lastUpdated}
            error={botsPoll.error ?? alertsPoll.error}
          />
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
            If this persists, your Cloudflare Access session may have expired — reload to sign in again.
          </div>
        </div>
      ) : (
        <BotList bots={bots} />
      )}
    </div>
  );
}
