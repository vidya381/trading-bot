/**
 * Alert history (this session's brief item 5).
 *
 * The visual treatment the brief describes for the global alert feed, applied
 * here to ONE bot's alerts: severity drives the accent (info sky, warning amber,
 * critical red), category is a distinct chip (trading vs system visually
 * separated), and a RESOLVED alert is de-emphasised (dimmed, with a resolved
 * tag) rather than hidden -- the record stays visible, just quieter. This is a
 * standalone `AlertList` so the later global-feed session can reuse the exact
 * treatment; here it is fed this bot's own `alerts` array. Newest first.
 */

import type { Alert, AlertCategory, AlertSeverity } from "../api/types";
import { formatTime } from "../format";

const SEVERITY_ACCENT: Record<AlertSeverity, string> = {
  info: "border-l-sky-500/60",
  warning: "border-l-amber-500/60",
  critical: "border-l-red-500/70",
};

const SEVERITY_TEXT: Record<AlertSeverity, string> = {
  info: "text-sky-300",
  warning: "text-amber-300",
  critical: "text-red-300",
};

const CATEGORY_CLASS: Record<AlertCategory, string> = {
  trading: "bg-violet-500/15 text-violet-300 ring-violet-500/30",
  system: "bg-cyan-500/15 text-cyan-300 ring-cyan-500/30",
};

function AlertRow({ alert }: { alert: Alert }) {
  return (
    <div
      className={[
        "border-l-2 bg-zinc-900/60 px-4 py-3",
        SEVERITY_ACCENT[alert.severity],
        alert.resolved ? "opacity-60" : "",
      ].join(" ")}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span
          className={`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ring-1 ring-inset ${CATEGORY_CLASS[alert.category]}`}
        >
          {alert.category}
        </span>
        <span className={`text-xs font-medium uppercase tracking-wide ${SEVERITY_TEXT[alert.severity]}`}>
          {alert.severity}
        </span>
        <span className="tabular text-xs text-zinc-500">{alert.alertType}</span>
        {alert.resolved && (
          <span className="inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-zinc-400 ring-1 ring-inset ring-zinc-600/40">
            resolved
          </span>
        )}
        <span className="ml-auto text-xs text-zinc-500">{formatTime(alert.createdAt)}</span>
      </div>
      <p className={`mt-1 text-sm ${alert.resolved ? "text-zinc-400" : "text-zinc-200"}`}>
        {alert.message}
      </p>
    </div>
  );
}

export function AlertList({ alerts }: { alerts: readonly Alert[] }) {
  return (
    <section className="space-y-3">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-400">Alerts</h2>
        <span className="tabular text-xs text-zinc-500">{alerts.length}</span>
      </div>
      {alerts.length === 0 ? (
        <div className="rounded-lg border border-dashed border-zinc-800 px-4 py-6 text-center text-sm text-zinc-500">
          No alerts recorded for this bot.
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-zinc-800 divide-y divide-zinc-800/70">
          {alerts.map((alert) => (
            <AlertRow key={alert.id} alert={alert} />
          ))}
        </div>
      )}
    </section>
  );
}
