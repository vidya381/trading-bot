/**
 * The cross-bot alert feed (`/alerts`): every alert across every bot and
 * account, not scoped to one bot the way the detail view's list is. The second
 * of step 10's two remaining dashboard pieces (the first was the bot detail
 * view; the manual-adjustment form is the last, built separately).
 *
 * It reuses `AlertList` -- the same renderer the detail view uses -- with
 * `linkToBot` on, so each alert that carries a `botInstanceId` links back to its
 * bot's detail page (the detail view links the other direction, into a bot; this
 * links out of one). No second, divergent alert component exists.
 *
 * FILTERING IS SERVER-SIDE. `GET /api/alerts` supports exactly three filters --
 * category, severity, resolved -- and validates each (src/api/handlers.ts). We
 * send only those, as query params, and never fetch-everything-then-filter. The
 * chosen filters live in the URL (`useSearchParams`), so a filtered view is
 * deep-linkable and the back button works; the status strip's unresolved-count
 * tile links here as `/alerts?resolved=false`.
 *
 * The feed polls `GET /api/alerts` every 5s (`usePolling`, item 4), the same
 * pattern as every other list view, and shows the same honest loading / empty /
 * error states (no_schema, unauthenticated, generic) as the rest of the app.
 */

import { useCallback } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { ApiError, fetchAlerts, type AlertFilters } from "../api/client";
import { usePolling } from "../api/usePolling";
import type { Alert, AlertCategory, AlertSeverity } from "../api/types";
import { AlertList } from "../components/AlertList";
import { formatTime } from "../format";

const CATEGORIES: readonly AlertCategory[] = ["trading", "system"];
const SEVERITIES: readonly AlertSeverity[] = ["info", "warning", "critical"];

/** Read the URL's filters, keeping only values the backend actually accepts. */
function filtersFromParams(params: URLSearchParams): AlertFilters {
  const category = params.get("category");
  const severity = params.get("severity");
  const resolved = params.get("resolved");
  return {
    category: CATEGORIES.includes(category as AlertCategory) ? (category as AlertCategory) : undefined,
    severity: SEVERITIES.includes(severity as AlertSeverity) ? (severity as AlertSeverity) : undefined,
    resolved: resolved === "true" ? true : resolved === "false" ? false : undefined,
  };
}

function BackLink() {
  return (
    <Link
      to="/"
      className="text-sm text-zinc-400 underline-offset-2 hover:text-zinc-200 hover:underline"
    >
      ← Back to bots
    </Link>
  );
}

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
        className={["inline-block h-2 w-2 rounded-full", error ? "bg-red-400" : "bg-emerald-400"].join(" ")}
        aria-hidden
      />
      <span>
        {error ? "Update failed" : "Live"} · updated {formatTime(lastUpdated)}
      </span>
    </div>
  );
}

/** An honest, bordered message for a hard load failure (same pattern as BotDetail). */
function LoadError({ error }: { error: Error | null }) {
  const code = error instanceof ApiError ? error.code : null;

  if (code === "no_schema") {
    return (
      <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 px-4 py-10 text-center text-sm text-zinc-400">
        This environment has no database schema yet. Migrations are deferred to go-live, so there are
        no alerts to show.
      </div>
    );
  }

  if (code === "unauthenticated") {
    return (
      <div className="rounded-lg border border-red-500/30 bg-red-500/5 px-4 py-10 text-center text-sm text-red-300">
        Your Cloudflare Access session has expired. Reload to sign in again.
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-red-500/30 bg-red-500/5 px-4 py-10 text-center text-sm text-red-300">
      Couldn’t load alerts: {error?.message ?? "unknown error"}
      <div className="mt-1 text-xs text-red-400/70">
        If this persists, your Cloudflare Access session may have expired. Reload to sign in again.
      </div>
    </div>
  );
}

const SELECT_CLASS =
  "rounded-md border border-zinc-700 bg-zinc-900 px-2.5 py-1.5 text-sm text-zinc-200 " +
  "focus:border-zinc-500 focus:outline-none";

/** One labelled `<select>`; "" is the "all" option, mapped to `undefined`. */
function FilterSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: readonly { readonly value: string; readonly label: string }[];
  onChange: (value: string) => void;
}) {
  return (
    <label className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-zinc-500">
      {label}
      <select className={SELECT_CLASS} value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">All</option>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

/**
 * The polling feed itself. Kept as a child KEYED BY the active filters (see the
 * page below) so that changing a filter remounts it and refetches immediately,
 * rather than waiting up to one poll interval -- `usePolling` restarts only when
 * its interval changes, so this is the same `key`-to-refetch trick the bot
 * detail view uses to re-poll on navigation.
 */
function AlertFeed({ filters, anyFilterActive }: { filters: AlertFilters; anyFilterActive: boolean }) {
  const fetcher = useCallback(
    (signal: AbortSignal) => fetchAlerts(filters, signal),
    // The parent keys this component by the filter string, so these are constant
    // for a given mount; listing them keeps the dependency honest regardless.
    [filters.category, filters.severity, filters.resolved],
  );
  const poll = usePolling<Alert[]>(fetcher);

  const firstLoad = poll.loading && poll.data === null;
  const hardError = poll.error !== null && poll.data === null;
  const alerts = poll.data ?? [];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-end">
        <FreshnessIndicator lastUpdated={poll.lastUpdated} error={poll.error} />
      </div>

      {firstLoad ? (
        <div className="rounded-lg border border-zinc-800 px-4 py-10 text-center text-sm text-zinc-500">
          Loading alerts…
        </div>
      ) : hardError ? (
        <LoadError error={poll.error} />
      ) : (
        <AlertList
          alerts={alerts}
          linkToBot
          heading={`${alerts.length} shown`}
          emptyMessage={
            anyFilterActive
              ? "No alerts match these filters."
              : "No alerts recorded on any bot yet."
          }
        />
      )}
    </div>
  );
}

export function Alerts() {
  const [searchParams, setSearchParams] = useSearchParams();
  const filters = filtersFromParams(searchParams);
  const anyFilterActive =
    filters.category !== undefined || filters.severity !== undefined || filters.resolved !== undefined;

  // Update one filter in the URL; "" clears it. `replace` so filter changes do
  // not each add a history entry.
  function setFilter(key: string, value: string) {
    const next = new URLSearchParams(searchParams);
    if (value === "") next.delete(key);
    else next.set(key, value);
    setSearchParams(next, { replace: true });
  }

  const resolvedValue =
    filters.resolved === undefined ? "" : filters.resolved ? "true" : "false";

  return (
    <div className="space-y-6">
      <BackLink />

      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-zinc-100">Alerts</h1>
          <p className="mt-1 text-sm text-zinc-500">
            Every alert across every bot and account. Newest first.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <FilterSelect
            label="Category"
            value={filters.category ?? ""}
            options={[
              { value: "trading", label: "Trading" },
              { value: "system", label: "System" },
            ]}
            onChange={(value) => setFilter("category", value)}
          />
          <FilterSelect
            label="Severity"
            value={filters.severity ?? ""}
            options={[
              { value: "info", label: "Info" },
              { value: "warning", label: "Warning" },
              { value: "critical", label: "Critical" },
            ]}
            onChange={(value) => setFilter("severity", value)}
          />
          <FilterSelect
            label="Status"
            value={resolvedValue}
            options={[
              { value: "false", label: "Unresolved" },
              { value: "true", label: "Resolved" },
            ]}
            onChange={(value) => setFilter("resolved", value)}
          />
        </div>
      </div>

      <AlertFeed
        key={`${filters.category ?? ""}|${filters.severity ?? ""}|${resolvedValue}`}
        filters={filters}
        anyFilterActive={anyFilterActive}
      />
    </div>
  );
}
