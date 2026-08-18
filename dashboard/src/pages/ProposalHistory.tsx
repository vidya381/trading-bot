/**
 * `/proposals` — the permanent proposal record, browsable (spec 21.5 requirement 5).
 *
 * ── WHAT THIS CLOSES ──
 *
 * Decision logs 46, 48 and 49 each carried the same item forward, and entry 46
 * stated its shape correctly: *"it reads like a missing feature and is actually a
 * missing READ. Entry 45 built the `proposals` table with everything required…
 * What is missing is a UI that reads it."* Entry 49 put it most plainly: *"A human
 * who wants to know what was proposed last week queries D1 by hand."* This is the
 * screen that replaces the query.
 *
 * ── ⚠ IT IS READ-ONLY, AND THERE IS NOTHING ON IT THAT COULD CHANGE ANYTHING ──
 *
 * No approve, no reject, no create-bot link, no outcome control of any kind. The two
 * endpoints behind this page are `GET`; `proposals.outcome` still moves off NULL in
 * exactly two places in this system — `recordProposalApproval`, reached only from
 * `POST /api/bots` after a real bot exists, and `rejectProposal`, reached only from
 * `POST /api/proposals/:id/reject` — and neither is reachable from here.
 *
 * The one link that leads anywhere consequential goes to `/proposal/run`'s FORM for
 * a proposal nobody decided on, and it presses nothing: that page states the cost —
 * two paid inferences and two permanent rows — and requires a deliberate press,
 * which is decision log 46's whole design for it.
 *
 * ── FILTERING AND PAGING ARE THE BACKEND'S ──
 *
 * `GET /api/proposals` filters and pages in SQL, and this page never filters a
 * fetched array. That is `pages/Alerts.tsx`'s standing rule — *"never
 * fetch-everything-then-filter"* — and it is not optional here: this table has no
 * delete path (section 8.7) and gains two rows per real run, so "fetch everything"
 * has no ceiling at all. The chosen filters live in the URL (`useSearchParams`), so
 * a filtered view is deep-linkable and the back button works — which matters more
 * here than on the alert feed, because *"every proposal on this account that nobody
 * acted on"* is a question worth sending someone.
 *
 * ⚠ AND THE LIST READ NEVER TOUCHES THE TWO LARGE PAYLOADS. The backend projects
 * sixteen short columns and leaves `inputs_json` and `reasoning_json` in the table;
 * a page of 25 rows read whole would be up to ~7 MB of candle windows and prompts,
 * which is exactly the cost migration 0009's third argument was about.
 *
 * ── ⚠ IT DOES NOT POLL, AND THAT IS DELIBERATE ──
 *
 * Every other list view in this dashboard polls on a 5-second timer. This one does
 * not, for two reasons. A permanent, append-only record of past decisions does not
 * change while you read it — a new row appears only when a human presses a button
 * that costs two paid inferences — so a timer here would re-read the table
 * continuously to observe nothing. And decision log 46 left an OPEN, unresolved
 * investigation into this dashboard's polling frequency, with duplicate pollers
 * already suspected; adding a fifth timer while that is open would be the wrong
 * contribution to it. There is an explicit refresh instead.
 */

import { useCallback, useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { ApiError, fetchAccounts, fetchProposals } from "../api/client";
import type { Account } from "../api/types";
import type { ProposalListResponse } from "../api/research-types";
import { formatDateTime } from "../format";
import {
  HISTORY_OUTCOMES,
  HISTORY_STAGES,
  OUTCOME_CLASS,
  OUTCOME_TITLE,
  RERUN_HREF,
  historyFetchArgs,
  historyKey,
  historyPagination,
  historyQueryFrom,
  historyRowOf,
  withHistoryFilter,
  withHistoryOffset,
  type HistoryRow,
} from "../proposalHistory";

const SELECT_CLASS =
  "rounded-md border border-zinc-700 bg-zinc-900 px-2.5 py-1.5 text-sm text-zinc-200 " +
  "focus:border-zinc-500 focus:outline-none";

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
      <select className={SELECT_CLASS} value={value} onChange={(event) => onChange(event.target.value)}>
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

/** The same honest failure branches every other page in this dashboard uses. */
function LoadError({ error }: { error: Error | null }) {
  const code = error instanceof ApiError ? error.code : null;

  if (code === "no_schema") {
    return (
      <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 px-4 py-10 text-center text-sm text-zinc-400">
        This environment has no database schema yet, so there is no proposal record to read.
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
  if (code === "invalid_filter") {
    /*
     * ⚠ WORTH ITS OWN BRANCH RATHER THAN THE GENERIC ONE. It means the URL carries
     * a value the backend refuses — a hand-edited `limit`, or a filter this build
     * still sends and that build no longer accepts. The message is the backend's
     * own and names the parameter, so it is shown verbatim rather than replaced
     * with prose about "a problem".
     */
    return (
      <div className="rounded-lg border border-amber-500/40 bg-amber-500/5 px-4 py-6 text-sm text-amber-200">
        <p className="font-semibold">The filters in this URL were refused.</p>
        <p className="mt-1 text-xs text-amber-200/80">{error?.message}</p>
        <p className="mt-2 text-xs">
          <Link to="/proposals" className="underline underline-offset-2">
            Start again with no filters
          </Link>
        </p>
      </div>
    );
  }
  return (
    <div className="rounded-lg border border-red-500/30 bg-red-500/5 px-4 py-10 text-center text-sm text-red-300">
      Couldn’t load the proposal record: {error?.message ?? "unknown error"}
    </div>
  );
}

function OutcomeCell({ row }: { row: HistoryRow }) {
  return (
    <div className="space-y-1">
      <span
        title={OUTCOME_TITLE[row.outcome]}
        className={[
          "inline-flex shrink-0 items-center rounded border px-2 py-0.5 text-[11px] uppercase tracking-wide",
          OUTCOME_CLASS[row.outcome],
        ].join(" ")}
      >
        {row.outcomeLabel}
      </span>
      {row.pendingLabel !== null && (
        <div className="text-[11px] text-zinc-600">
          decided after <span className="tabular text-zinc-500">{row.pendingLabel}</span>
        </div>
      )}
      {row.botInstanceId !== null && (
        <div className="text-[11px] text-zinc-600">
          became{" "}
          <Link
            to={`/bots/${encodeURIComponent(row.botInstanceId)}`}
            className="tabular text-zinc-400 underline underline-offset-2 hover:text-zinc-200"
          >
            {row.botInstanceId}
          </Link>
        </div>
      )}
    </div>
  );
}

function HistoryTableView({ rows }: { rows: readonly HistoryRow[] }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-zinc-800">
      <table className="w-full min-w-[48rem] text-left">
        <thead className="bg-zinc-900/60 text-xs uppercase tracking-wide text-zinc-500">
          <tr>
            <th className="px-3 py-2 font-medium">Pair</th>
            <th className="px-3 py-2 font-medium">Account</th>
            <th className="px-3 py-2 font-medium">Stage</th>
            <th className="px-3 py-2 font-medium">Strategy</th>
            <th className="px-3 py-2 font-medium">Made</th>
            <th className="px-3 py-2 font-medium">Outcome</th>
            <th className="px-3 py-2 font-medium" />
          </tr>
        </thead>
        <tbody className="divide-y divide-zinc-800">
          {rows.map((row) => (
            <tr key={row.id} className="align-top">
              <td className="px-3 py-2">
                <Link
                  to={row.href}
                  className="tabular text-sm text-zinc-100 underline-offset-2 hover:underline"
                >
                  {row.pair}
                </Link>
                <div className="text-[11px] text-zinc-600">
                  <code className="tabular">{row.id}</code>
                </div>
              </td>
              <td className="px-3 py-2 text-sm text-zinc-400">{row.accountLabel}</td>
              <td className="px-3 py-2">
                <span className="rounded border border-zinc-700 px-1.5 py-0.5 text-[11px] uppercase tracking-wide text-zinc-400">
                  {row.stage}
                </span>
              </td>
              <td className="px-3 py-2 text-sm uppercase text-zinc-300">{row.strategy}</td>
              <td className="px-3 py-2 text-xs text-zinc-400">
                <div className="tabular">{formatDateTime(row.createdAt)}</div>
                <div className="text-[11px] text-zinc-600">{row.ageLabel} ago</div>
              </td>
              <td className="px-3 py-2">
                <OutcomeCell row={row} />
              </td>
              <td className="px-3 py-2 text-right">
                <Link
                  to={row.href}
                  className="text-xs text-zinc-400 underline underline-offset-2 hover:text-zinc-200"
                >
                  Open →
                </Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function ProposalHistory() {
  const [searchParams, setSearchParams] = useSearchParams();
  const query = historyQueryFrom(searchParams);
  const key = historyKey(query);

  const [data, setData] = useState<ProposalListResponse | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(true);
  const [accounts, setAccounts] = useState<readonly Account[]>([]);
  const [reloads, setReloads] = useState(0);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    fetchProposals(historyFetchArgs(query), controller.signal)
      .then((response) => {
        setData(response);
        setError(null);
        // Read once per load rather than on a timer: the ages in this table are
        // "how long ago", and a record of past decisions does not need a
        // second-by-second clock the way a live staleness verdict does.
        setNow(Date.now());
      })
      .catch((cause: unknown) => {
        if (cause instanceof DOMException && cause.name === "AbortError") return;
        setError(cause instanceof Error ? cause : new Error(String(cause)));
        setData(null);
      })
      .finally(() => setLoading(false));
    return () => controller.abort();
    // `key` is the whole query, flattened. Listing it rather than the object keeps
    // the effect from re-running on every render for a query that did not change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, reloads]);

  useEffect(() => {
    const controller = new AbortController();
    fetchAccounts(controller.signal)
      .then(setAccounts)
      // ⚠ A FAILED ACCOUNT LOAD IS NOT AN ERROR ON THIS PAGE. The account filter is
      // an affordance; the history still lists every account without it, and
      // failing the whole page because a dropdown could not be populated would be
      // the "control that contradicts its own instructions" fault decision log 46
      // found live on the run page.
      .catch(() => setAccounts([]))
      .finally(() => undefined);
    return () => controller.abort();
  }, []);

  const setFilter = useCallback(
    (name: "accountLabel" | "stage" | "outcome", value: string) => {
      setSearchParams(withHistoryFilter(searchParams, name, value), { replace: true });
    },
    [searchParams, setSearchParams],
  );

  const goToOffset = useCallback(
    (offset: number) => {
      setSearchParams(withHistoryOffset(searchParams, offset), { replace: false });
    },
    [searchParams, setSearchParams],
  );

  const rows = (data?.proposals ?? []).map((record) => historyRowOf(record, now));
  const pagination = data === null ? null : historyPagination(data.page);
  const anyFilter =
    query.accountLabel !== null || query.stage !== null || query.outcome !== null;

  return (
    <div className="space-y-6">
      <Link
        to="/"
        className="text-sm text-zinc-400 underline-offset-2 hover:text-zinc-200 hover:underline"
      >
        ← Back to bots
      </Link>

      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-zinc-100">Proposal history</h1>
          <p className="mt-1 max-w-3xl text-sm text-zinc-500">
            Every proposal this system has generated, newest first — including the ones nobody acted
            on, which is the signal spec 21.5 exists to make visible. Nothing here has been deleted
            or summarised: there is no delete path and no soft-delete column (section 8.7).
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <FilterSelect
            label="Account"
            value={query.accountLabel ?? ""}
            options={accounts.map((account) => ({
              value: account.accountLabel,
              label: account.accountLabel,
            }))}
            onChange={(value) => setFilter("accountLabel", value)}
          />
          <FilterSelect
            label="Stage"
            value={query.stage ?? ""}
            options={HISTORY_STAGES.map((stage) => ({ value: stage, label: stage }))}
            onChange={(value) => setFilter("stage", value)}
          />
          <FilterSelect
            label="Outcome"
            value={query.outcome ?? ""}
            options={HISTORY_OUTCOMES.map((outcome) => ({
              value: outcome,
              label: outcome === "pending" ? "No decision" : outcome,
            }))}
            onChange={(value) => setFilter("outcome", value)}
          />
          <button
            type="button"
            onClick={() => setReloads((count) => count + 1)}
            className="rounded-md border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 hover:border-zinc-600 hover:text-zinc-100"
          >
            Refresh
          </button>
        </div>
      </div>

      {/*
       * ⚠ THE QUALIFICATION MIGRATION 0009 ATTACHED TO THIS COUNT, CARRIED ONTO THE
       * SCREEN THAT SHOWS IT. A proposal made thirty seconds ago also has no
       * decision, so "no decision" is only the signal 21.5 wants over rows old
       * enough that a human would have acted — and no threshold is invented here to
       * draw that line, exactly as none was invented there. The age beside each row
       * is what a reader uses instead.
       */}
      {query.outcome === "pending" && (
        <p className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-4 py-2.5 text-xs text-amber-200/90">
          <strong className="font-semibold">These are the proposals with no recorded decision.</strong>{" "}
          That is spec 21.5&rsquo;s &ldquo;ignored&rdquo;, read after the fact — nothing in this
          system ever writes that word. A proposal made moments ago is in this list too, so read the
          count beside the ages: no threshold has been invented to say how long counts as ignored.
        </p>
      )}

      {loading && data === null ? (
        <div className="rounded-lg border border-zinc-800 px-4 py-10 text-center text-sm text-zinc-500">
          Loading the proposal record…
        </div>
      ) : error !== null ? (
        <LoadError error={error} />
      ) : rows.length === 0 ? (
        <div className="rounded-lg border border-zinc-800 px-4 py-10 text-center text-sm text-zinc-500">
          {pagination !== null && pagination.total > 0
            ? `No proposals on this page — ${pagination.total} match these filters.`
            : anyFilter
              ? "No proposals match these filters."
              : "No proposals have been generated yet. Ask about a coin to make one."}
        </div>
      ) : (
        <>
          <HistoryTableView rows={rows} />
          {pagination !== null && (
            <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-zinc-500">
              <span className="tabular">
                {pagination.summary} · page {pagination.page} of {pagination.pages}
              </span>
              <span className="flex items-center gap-2">
                <button
                  type="button"
                  disabled={!pagination.hasPrevious}
                  onClick={() => goToOffset(pagination.previousOffset)}
                  className="rounded-md border border-zinc-700 px-3 py-1 text-zinc-300 disabled:opacity-40 hover:enabled:border-zinc-600 hover:enabled:text-zinc-100"
                >
                  ← Newer
                </button>
                <button
                  type="button"
                  disabled={!pagination.hasNext}
                  onClick={() => goToOffset(pagination.nextOffset)}
                  className="rounded-md border border-zinc-700 px-3 py-1 text-zinc-300 disabled:opacity-40 hover:enabled:border-zinc-600 hover:enabled:text-zinc-100"
                >
                  Older →
                </button>
              </span>
            </div>
          )}
        </>
      )}

      {/*
       * ⚠ THE REJECT ENDPOINT'S PATH IS DELIBERATELY NOT SPELLED OUT IN THIS PAGE'S
       * COPY, and that is not squeamishness. `prefill-does-not-approve.test.ts` fails
       * the build when a proposal PAGE contains `/reject`, because it cannot tell a
       * call from prose about a call — and loosening a guard so a sentence can pass is
       * how a guard stops being one. The exact path is named where it belongs, on the
       * record itself: `ProposalView`'s footer and `ProposalAssessRecord`'s both print
       * it with the real id, which is the form an operator can actually use.
       */}
      <p className="rounded-lg border border-zinc-800 bg-zinc-900/20 px-4 py-3 text-xs text-zinc-500">
        <strong className="text-zinc-400">This page is read-only.</strong> It reads{" "}
        <code>GET /api/proposals</code>, which writes nothing — no row, no{" "}
        <code>audit_log</code> entry, no outcome. A proposal&rsquo;s outcome moves off{" "}
        <code>null</code> in exactly two places in this system: a real completed bot creation, and
        the curl-only rejection endpoint, whose full path is printed on each proposal&rsquo;s own
        record page. Neither is reachable from here, and browsing history cannot make a proposal
        count as read, acted on, or ignored.{" "}
        <Link to={RERUN_HREF} className="underline underline-offset-2">
          Asking about a coin
        </Link>{" "}
        is where a new proposal comes from, and it costs two paid inferences per press.
      </p>
    </div>
  );
}
