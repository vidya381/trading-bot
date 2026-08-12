/**
 * When this proposal's data was fetched (spec 21.5 requirement 4).
 *
 * ── WHY FOUR TIMESTAMPS AND NOT ONE ──
 *
 * A proposal is a claim about conditions at a moment, and four real fetches
 * stand behind it: the price window, the capital ledger, the account's bot list
 * and the venue's trading rules. They age at completely different rates, so
 * picking one and calling it "the" timestamp would be an arbitrary choice
 * presented as an answer. `freshnessOf` (src/proposal.ts) argues the ordering;
 * this renders it with the reason attached to each row, so a reviewer can see
 * not just when something was read but why that matters to them.
 *
 * The PRICE FETCH is the headline because every proposed number is denominated
 * against it. The OLDEST fetch is shown beside it because a proposal is no
 * fresher than its stalest input, and those two are frequently not the same row.
 *
 * ── ⚠ NO STALENESS THRESHOLD IS APPLIED, AND THAT IS DELIBERATE ──
 *
 * 21.5 requirement 4 also asks that a proposal be flagged stale and a refresh
 * prompted once "a meaningful delay" has passed. NOTHING IN THIS SYSTEM DEFINES
 * WHAT THAT DELAY IS -- not the spec, not any decision-log entry, not any
 * constant in the source. Choosing a number here would be a rendering layer
 * inventing a risk policy and then displaying its verdict as a finding, which is
 * the same objection `src/proposal.ts` raises against inventing a liquidity
 * threshold. So this component states the real ages plainly, prominently, and
 * without a verdict, and the threshold half of requirement 4 remains OPEN. It is
 * called out in the summary rather than left to look satisfied.
 *
 * The `/derive` endpoint does enforce the one freshness rule that IS defined:
 * every citation in a resubmitted assessment is re-resolved against evidence
 * gathered by that request, and an assessment whose data has aged out is refused
 * with `citation_unknown` rather than derived from (decision log 42, check 7).
 * That is a real, live-observed check, and it is not the same as a UI threshold.
 */

import { useEffect, useState } from "react";
import { formatAge, type FetchTimestamp, type Freshness } from "../proposal";
import { formatDateTime } from "../format";

/** A 1s tick so the ages on screen stay true while a reviewer reads. */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

function AgeReadout({ fetch, now }: { fetch: FetchTimestamp; now: number }) {
  if (fetch.at === null) {
    return <span className="text-amber-300">no fetch time — this input never produced a value</span>;
  }
  return (
    <>
      <span className="tabular text-zinc-100">{formatAge(now - fetch.at)} ago</span>
      <span className="tabular text-zinc-500"> · {formatDateTime(fetch.at)}</span>
    </>
  );
}

export function ProposalFreshness({ freshness }: { freshness: Freshness }) {
  const now = useNow();
  const { priceFetch, oldest } = freshness;

  return (
    <section className="space-y-3">
      <h3 className="text-sm font-semibold uppercase tracking-wide text-zinc-400">
        When this data was fetched
      </h3>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="rounded-lg border border-zinc-700 bg-zinc-900/60 px-4 py-3">
          <div className="text-xs uppercase tracking-wide text-zinc-500">Price history</div>
          <div className="mt-1 text-lg font-semibold">
            <AgeReadout fetch={priceFetch} now={now} />
          </div>
          <p className="mt-1 text-xs text-zinc-500">{priceFetch.why}</p>
        </div>
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 px-4 py-3">
          <div className="text-xs uppercase tracking-wide text-zinc-500">
            Oldest input behind this proposal
          </div>
          <div className="mt-1 text-lg font-semibold">
            {oldest === null ? (
              <span className="text-amber-300">no input produced a fetch time</span>
            ) : (
              <AgeReadout fetch={oldest} now={now} />
            )}
          </div>
          <p className="mt-1 text-xs text-zinc-500">
            {oldest === null
              ? "Every input failed to produce a value."
              : `${oldest.label}. A proposal is no fresher than its stalest input.`}
          </p>
        </div>
      </div>

      <div className="overflow-hidden rounded-lg border border-zinc-800">
        <table className="w-full text-left text-sm">
          <thead className="bg-zinc-900/60 text-xs uppercase tracking-wide text-zinc-500">
            <tr>
              <th className="px-4 py-2 font-medium">Input</th>
              <th className="px-4 py-2 font-medium">Fetched</th>
              <th className="hidden px-4 py-2 font-medium lg:table-cell">Why it matters now</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-800">
            {freshness.fetches.map((fetch) => (
              <tr key={fetch.key} className="align-top">
                <td className="px-4 py-2 text-zinc-200">
                  {fetch.label}
                  {fetch.note !== null && (
                    <div className="text-xs text-zinc-600">{fetch.note}</div>
                  )}
                </td>
                <td className="px-4 py-2 text-xs">
                  <AgeReadout fetch={fetch} now={now} />
                  {fetch.observedAt !== null && (
                    <div className="text-amber-300/70">
                      failure observed at {formatDateTime(fetch.observedAt)} — an observation time,
                      not a fetch time
                    </div>
                  )}
                  <div className="lg:hidden mt-1 text-zinc-500">{fetch.why}</div>
                </td>
                <td className="hidden px-4 py-2 text-xs text-zinc-500 lg:table-cell">{fetch.why}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <details className="rounded-lg border border-zinc-800 bg-zinc-900/20 px-4 py-2">
        <summary className="cursor-pointer text-xs uppercase tracking-wide text-zinc-500">
          Assembly times — these are NOT fetch times
        </summary>
        <dl className="mt-2 space-y-1.5">
          {freshness.assembly.map((stamp) => (
            <div key={stamp.key} className="text-xs">
              <dt className="inline text-zinc-400">{stamp.label}: </dt>
              <dd className="tabular inline text-zinc-300">{formatDateTime(stamp.at)}</dd>
              <div className="text-zinc-600">{stamp.note}</div>
            </div>
          ))}
        </dl>
      </details>

      <p className="text-xs text-zinc-600">
        No staleness threshold is applied here. Nothing in this system defines how old is too old,
        and this view does not invent one — the ages above are stated so you can decide.
      </p>
    </section>
  );
}
