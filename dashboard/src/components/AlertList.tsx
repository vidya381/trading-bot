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
 *
 * One row type carries an extra affordance: an OPEN order-state-drift alert on a
 * linked row points at the bot detail view's "Apply missed fills" control
 * (`#apply-missed-fills`) rather than the top of the page, because seeing that
 * alert and wanting to act on it is one motion. See `driftAlerts.ts` for which
 * types qualify; nothing is triggered by the link itself.
 */

import { Link } from "react-router-dom";
import type { Alert, AlertCategory, AlertSeverity } from "../api/types";
import { APPLY_MISSED_FILLS_ANCHOR, isOpenDriftAlert } from "../driftAlerts";
import { CHECK_OPEN_ORDERS_ANCHOR, isOpenPollAlert } from "../pollAlerts";
import { alertRowAnchor } from "../postHaltEvents";
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
  /*
   * The natural real-world path is "see an alert, act on it", so an OPEN
   * order-state-drift alert in the cross-bot feed links to the repair control
   * itself rather than to the top of the bot page. The chip only renders on a
   * LINKED row: on the per-bot list the control is already on the same page, and
   * a chip that looks like an action but is not a link would be a lie.
   *
   * It links, and deliberately does not act: the hash scrolls the control into
   * view, and the confirmation dialog still has to be opened by hand. A
   * confirmation a link can open is not a confirmation.
   */
  const repairable = linked && isOpenDriftAlert(alert);
  /**
   * The same arrangement for POLL-HEALTH alerts (step 22): a `poll_blind`,
   * `poll_blind_escalated` or `price_updates_stale` row in the cross-bot feed
   * links to the manual observation control rather than to the top of the bot
   * page. Those alerts all mean the bot's automatic 30-second pass has stopped
   * working, and running it by hand is the operator's first move -- so the feed
   * should point at it, exactly as it already points drift at the repair.
   *
   * `repairable` wins where both somehow apply: a bot with an open drift finding
   * has a decision waiting on it, and that outranks re-observing.
   */
  const observable = linked && !repairable && isOpenPollAlert(alert);
  const anchor = repairable
    ? `#${APPLY_MISSED_FILLS_ANCHOR}`
    : observable
      ? `#${CHECK_OPEN_ORDERS_ANCHOR}`
      : "";

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
      {repairable && (
        <span className="mt-1.5 inline-flex items-center gap-1 rounded border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[11px] font-medium text-amber-200">
          Apply missed fills →
        </span>
      )}
      {observable && (
        <span className="mt-1.5 inline-flex items-center gap-1 rounded border border-sky-500/40 bg-sky-500/10 px-1.5 py-0.5 text-[11px] font-medium text-sky-200">
          Check open orders →
        </span>
      )}
    </>
  );

  const className = [
    "border-l-2 bg-zinc-900/60 px-4 py-3",
    SEVERITY_ACCENT[alert.severity],
    alert.resolved ? "opacity-60" : "",
  ].join(" ");

  /*
   * THE ROW'S OWN ANCHOR, so something on the page can link to THIS alert rather
   * than to the top of the list.
   *
   * `PostHaltNotice` is the first caller: a post-halt event names the exact
   * `alerts.id` it raised, and "see the alert below" has to land on that row and
   * not on a list the operator then has to search. Same arrangement as
   * `APPLY_MISSED_FILLS_ANCHOR` and `CHECK_OPEN_ORDERS_ANCHOR`, and built through
   * the same one shared function so a rename cannot move only one side.
   *
   * Harmless where nothing links to it: an unreferenced id costs nothing, and
   * every row carrying one means a future linker needs no change here.
   */
  const rowId = alertRowAnchor(alert.id);

  if (linked) {
    return (
      <Link
        id={rowId}
        to={`/bots/${encodeURIComponent(alert.botInstanceId!)}${anchor}`}
        className={`group block transition-colors hover:bg-zinc-900 ${className}`}
      >
        {body}
      </Link>
    );
  }

  return (
    <div id={rowId} className={className}>
      {body}
    </div>
  );
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
