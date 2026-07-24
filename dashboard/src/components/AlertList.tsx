/**
 * The shared alert renderer, used in TWO places from one definition:
 *   - the bot detail view, fed ONE bot's `alerts` array (the original caller);
 *   - the cross-bot alert feed (`/alerts`), fed every bot's alerts, filtered.
 *
 * The visual treatment is the spec's (section 10): severity drives the accent
 * (info sky, warning amber, critical red), category is a distinct chip (trading
 * vs system visually separated), and a RESOLVED alert is de-emphasised (dimmed,
 * with a resolved tag) rather than hidden -- the record stays visible, just
 * quieter. Newest first, ordered by the backend.
 *
 * The two callers differ only in three optional props, all defaulting to the
 * per-bot behaviour so the detail view is unchanged:
 *   - `linkToBot`     -- when true, a row that carries a `botInstanceId` becomes
 *                        a link to that bot's detail page (the cross-bot feed
 *                        links out; the per-bot list, already scoped to one bot,
 *                        does not). A system alert with no bot stays a plain row.
 *   - `emptyMessage`  -- what an empty list says (per-bot vs "no matches").
 *   - `heading`       -- the section label, or `null` to suppress it when the
 *                        page already provides its own title.
 */

import { Link } from "react-router-dom";
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

function AlertRow({ alert, linkToBot }: { alert: Alert; linkToBot: boolean }) {
  const linked = linkToBot && alert.botInstanceId !== null;

  const body = (
    <>
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
        <span className="ml-auto flex items-center gap-1 text-xs text-zinc-500">
          {formatTime(alert.createdAt)}
          {linked && (
            <span aria-hidden className="text-zinc-600 transition-colors group-hover:text-zinc-300">
              →
            </span>
          )}
        </span>
      </div>
      <p className={`mt-1 text-sm ${alert.resolved ? "text-zinc-400" : "text-zinc-200"}`}>
        {alert.message}
      </p>
    </>
  );

  const className = [
    "border-l-2 bg-zinc-900/60 px-4 py-3",
    SEVERITY_ACCENT[alert.severity],
    alert.resolved ? "opacity-60" : "",
  ].join(" ");

  if (linked) {
    return (
      <Link
        to={`/bots/${encodeURIComponent(alert.botInstanceId!)}`}
        className={`group block transition-colors hover:bg-zinc-900 ${className}`}
      >
        {body}
      </Link>
    );
  }

  return <div className={className}>{body}</div>;
}

export function AlertList({
  alerts,
  linkToBot = false,
  emptyMessage = "No alerts recorded for this bot.",
  heading = "Alerts",
}: {
  alerts: readonly Alert[];
  linkToBot?: boolean;
  emptyMessage?: string;
  heading?: string | null;
}) {
  return (
    <section className="space-y-3">
      {heading !== null && (
        <div className="flex items-baseline justify-between gap-2">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-400">{heading}</h2>
          <span className="tabular text-xs text-zinc-500">{alerts.length}</span>
        </div>
      )}
      {alerts.length === 0 ? (
        <div className="rounded-lg border border-dashed border-zinc-800 px-4 py-6 text-center text-sm text-zinc-500">
          {emptyMessage}
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-zinc-800 divide-y divide-zinc-800/70">
          {alerts.map((alert) => (
            <AlertRow key={alert.id} alert={alert} linkToBot={linkToBot} />
          ))}
        </div>
      )}
    </section>
  );
}
