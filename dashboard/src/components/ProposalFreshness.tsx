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
 * ── THE STALENESS VERDICT (21.5 requirement 4's second half) ──
 *
 * Requirement 4 asks that a proposal be flagged stale and a refresh prompted once
 * "a meaningful delay" has passed. Until now nothing in this system defined that
 * delay -- not the spec, not any decision-log entry, not any constant -- and this
 * component stated the absence rather than inventing a number in a rendering
 * layer. `src/research/staleness.ts` now defines it, as one named policy with its
 * reasoning attached, and this component renders the verdict that follows.
 *
 * WHAT IS RENDERED, AND WHY EACH PART:
 *
 *   * A VERDICT BANNER, above the numbers, when the proposal is stale or when any
 *     input's age is unknown. Position is prominence, the same argument
 *     `ProposalView` makes for putting the concentration flag first: a verdict
 *     below the table is a verdict read after the ages have already been
 *     interpreted.
 *   * PER-ROW verdicts, because the four thresholds span 15 minutes to 7 days and
 *     "this proposal is stale" without saying WHICH input is stale sends a reviewer
 *     to check all four.
 *   * A REFRESH INSTRUCTION per stale input (`refreshAdvice`), because requirement
 *     4 asks for a prompt to refresh and a flag with no instruction is half of
 *     that. There is deliberately no refresh BUTTON -- every research endpoint is
 *     curl-only (decision logs 42, 44) and a button here would be a trigger
 *     decision (21.6), not a rendering one.
 *
 * ── ⚠ THREE STATES, AND `unknown` IS NOT `fresh` ──
 *
 * An input that never produced a value has no age to compare, so its verdict is
 * `unknown` and the banner says so. Rendering it as fresh is how a proposal built
 * on a failed read reads as current -- section 5.6's rule, and the reason
 * `staleness.ts` refuses a two-state boolean.
 *
 * ── ⚠ THIS IS NOT A GATE, AND MUST NEVER BECOME ONE ──
 *
 * A stale verdict flags and instructs. It does not disable anything, because there
 * is nothing here to disable: 21.1 keeps the create-bot form as the only path to a
 * bot and this page has no approve button by design. The binding freshness rules
 * live in the backend, where they belong -- `/derive` re-resolves every resubmitted
 * citation against evidence gathered by that request and refuses a stale one with
 * `citation_unknown` (decision log 42, check 7, observed firing live and
 * unprompted), and the capital ledger's compare-and-swap re-checks headroom at
 * creation. A UI threshold is a reviewer's aid, not a control.
 */

import { useEffect, useState } from "react";
import {
  formatAge,
  refreshAdvice,
  stalenessFor,
  type FetchTimestamp,
  type Freshness,
} from "../proposal";
import type { InputStaleness, StalenessVerdict } from "../../../src/research/staleness";
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

/** Words as well as colour, for `ProposalCitations`' reason: a distinction a
 * colour-blind reviewer cannot make is the same as no distinction. */
const VERDICT_STYLE: Readonly<Record<StalenessVerdict, { label: string; className: string }>> = {
  fresh: { label: "fresh", className: "text-emerald-300" },
  stale: { label: "STALE", className: "text-amber-300 font-semibold" },
  unknown: { label: "age unknown", className: "text-amber-300" },
};

function VerdictBadge({ verdict }: { verdict: StalenessVerdict }) {
  const style = VERDICT_STYLE[verdict];
  return <span className={style.className}>{style.label}</span>;
}

/**
 * The banner, shown only when there is something to say.
 *
 * A "this proposal is fresh" banner would be a reassurance the page has not
 * earned: freshness says the data is recent, not that the reasoning over it was
 * any good, and every layer of this pipeline carries that limit forward
 * deliberately (decision logs 40-44). So a fresh proposal gets the ages and no
 * verdict banner, exactly as before this existed.
 */
function StalenessBanner({
  verdict,
  staleInputs,
  unknownInputs,
  labelOf,
}: {
  verdict: StalenessVerdict;
  staleInputs: readonly InputStaleness[];
  unknownInputs: readonly InputStaleness[];
  labelOf: (key: string) => string;
}) {
  if (verdict === "fresh") return null;

  const stale = verdict === "stale";
  return (
    <div
      className={`rounded-lg border px-4 py-3 ${
        stale ? "border-amber-500/60 bg-amber-500/10" : "border-amber-500/30 bg-amber-500/5"
      }`}
    >
      <div className="text-sm font-semibold text-amber-200">
        {stale
          ? "This proposal is STALE — do not act on it without refreshing."
          : "This proposal's age cannot be fully established."}
      </div>
      {staleInputs.length > 0 && (
        <ul className="mt-2 space-y-1.5 text-xs text-amber-100/90">
          {staleInputs.map((input) => (
            <li key={input.key}>
              <span className="font-medium">{labelOf(input.key)}</span> is{" "}
              <span className="tabular">{formatAge(input.ageMs ?? 0)}</span> old, past its{" "}
              <span className="tabular">{formatAge(input.thresholdMs)}</span> threshold.{" "}
              {refreshAdvice(input)}
            </li>
          ))}
        </ul>
      )}
      {unknownInputs.length > 0 && (
        <p className="mt-2 text-xs text-amber-100/80">
          {unknownInputs.map((input) => labelOf(input.key)).join(", ")} produced no value at all, so
          there is no age to compare against a threshold. That is NOT the same as being fresh — see
          the rows below for what failed.
        </p>
      )}
      <p className="mt-2 text-xs text-amber-100/60">
        These thresholds are policy choices with no backtest behind them
        (src/research/staleness.ts). They flag; they do not block. Nothing on this page can create a
        bot.
      </p>
    </div>
  );
}

export function ProposalFreshness({ freshness }: { freshness: Freshness }) {
  const now = useNow();
  const { priceFetch, oldest } = freshness;

  // The backend's own comparison, over the thresholds `freshnessOf` paired with
  // these same four inputs. Nothing about the policy is decided in this file.
  const staleness = stalenessFor(freshness, now);
  const verdictByKey = new Map(staleness.inputs.map((input) => [input.key, input]));
  const labelOf = (key: string) =>
    freshness.fetches.find((fetch) => fetch.key === key)?.label ?? key;

  return (
    <section className="space-y-3">
      <h3 className="text-sm font-semibold uppercase tracking-wide text-zinc-400">
        When this data was fetched
      </h3>

      {/*
       * FIRST, above the numbers: the verdict. Position is prominence -- a verdict
       * under the table is one read after the ages have been interpreted.
       */}
      <StalenessBanner
        verdict={staleness.verdict}
        staleInputs={staleness.staleInputs}
        unknownInputs={staleness.unknownInputs}
        labelOf={labelOf}
      />

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
              <th className="px-4 py-2 font-medium">Verdict</th>
              <th className="hidden px-4 py-2 font-medium lg:table-cell">Why it matters now</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-800">
            {freshness.fetches.map((fetch) => {
              const verdict = verdictByKey.get(fetch.key);
              return (
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
                  {/*
                   * Each row against its OWN threshold, printed beside the verdict.
                   * Showing the number is what makes the verdict checkable rather
                   * than an opinion the page asserts.
                   */}
                  <td className="px-4 py-2 text-xs">
                    {verdict === undefined ? (
                      <span className="text-zinc-500">—</span>
                    ) : (
                      <>
                        <VerdictBadge verdict={verdict.verdict} />
                        <div className="tabular text-zinc-600">
                          threshold {formatAge(verdict.thresholdMs)}
                        </div>
                      </>
                    )}
                  </td>
                  <td className="hidden px-4 py-2 text-xs text-zinc-500 lg:table-cell">
                    {fetch.why}
                  </td>
                </tr>
              );
            })}
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
        Each input is compared against its own threshold, not against a single one: they range from{" "}
        {formatAge(Math.min(...freshness.thresholds.map((t) => t.thresholdMs)))} to{" "}
        {formatAge(Math.max(...freshness.thresholds.map((t) => t.thresholdMs)))}, so the oldest
        fetch is frequently not the stale one. The numbers are policy choices with no backtest
        behind them — see src/research/staleness.ts before quoting any of them.
      </p>
    </section>
  );
}
