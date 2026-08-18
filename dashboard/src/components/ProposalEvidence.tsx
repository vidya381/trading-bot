/**
 * The raw source data (spec 21.5 requirement 2), including what the model
 * IGNORED.
 *
 * ── WHY THE FULL SET, AND NOT ONLY THE CITED SUBSET ──
 *
 * `assessResultView` and `deriveResultView` both publish `evidence` as
 * everything the model was OFFERED, not only what it cited, and they say why in
 * their own docblocks: what a model ignored is visible only from the difference
 * between the two. A model that ignored the concentration flag, or reasoned
 * about a range while never once citing the truncation notice, is a fact worth
 * being able to see — and it is invisible if a proposal shows only the citations.
 *
 * So every item is listed with whether it was cited, and the uncited ones are
 * not hidden behind a toggle that defaults to closed.
 *
 * ── THE TWO GATHERS, AND WHY THEIR VALUES DIFFER ──
 *
 * When the original `/assess` response is supplied alongside, the drift table
 * appears. It exists because the two stages ran against two INDEPENDENT gathers
 * separated by real time: `/derive` re-fetches rather than replaying, and a real
 * ten-minute gap moved `candles.last_close` from 63775.31 to 63757.71 in the run
 * behind decision log 42. That is not a bug and not an inconsistency to
 * reconcile — it is the proof that the second call gathered fresh data. The
 * proposal's numbers were derived against the NEWER values, and the claims are
 * rendered beside the newer values too.
 */

import { useState } from "react";
import type { AssessResponse, DeriveResponse, EvidenceItem } from "../api/research-types";
import { CitationBadge } from "./ProposalCitations";
import { classifyCitation } from "../citations";

function EvidenceRow({ item, cited }: { item: EvidenceItem; cited: boolean }) {
  return (
    <tr className={cited ? "align-top" : "align-top bg-zinc-950/40"}>
      <td className="px-3 py-2">
        {cited ? (
          <span className="text-xs text-emerald-400">cited</span>
        ) : (
          <span className="text-xs text-zinc-600">not cited</span>
        )}
      </td>
      <td className="px-3 py-2">
        <CitationBadge citationClass={classifyCitation(item)} />
      </td>
      <td className="px-3 py-2">
        <code className="tabular text-xs text-zinc-400">{item.id}</code>
        <div className="text-[11px] text-zinc-600">{item.label}</div>
      </td>
      <td className="tabular px-3 py-2 text-xs text-zinc-200">
        <div className="break-words">{item.value}</div>
        <div className="mt-0.5 text-[11px] text-zinc-600">
          source: <code>{item.source}</code>
        </div>
      </td>
    </tr>
  );
}

/**
 * ⚠ EXPORTED, so the Stage 2 record view can render the SAME table.
 *
 * A historical `assess` record has an evidence set and a cited subset exactly as a
 * derivation does, and the one fact that matters about it — the DIFFERENCE between
 * offered and cited — is computed here and printed above the toggle. Copying this
 * component for the assess-only view would be a second place that count is computed
 * and a second place the collapse rule can drift from
 * `proposal-summary-card.test.ts`'s guard, which is the "copy that drifts is the one
 * nobody is watching" fault this project refuses everywhere else.
 *
 * Its parent `ProposalEvidence` still owns the two-gather drift comparison, which is
 * genuinely about having two responses and has nothing to render for one.
 */
export function EvidenceTable({
  evidence,
  cited,
}: {
  evidence: readonly EvidenceItem[];
  cited: ReadonlySet<string>;
}) {
  const usedCount = evidence.filter((item) => cited.has(item.id)).length;
  return (
    <div className="space-y-2">
      {/*
       * ⚠ THE COUNTS STAY VISIBLE. THE TABLE COLLAPSES. That split is the whole
       * reconciliation with decision log 44, which refused to put this table behind
       * a toggle at all.
       *
       * Entry 44's argument is specific and it is about a NUMBER, not about the
       * rows: *"`evidence` is everything the model was OFFERED, not only what it
       * cited... what the model ignored is visible only from the DIFFERENCE
       * between the two. That difference is only visible if something computes
       * it."* Live it read 31 of 75 on Derive and 9 of 56 on Assess — two facts
       * about two answers that no summary would have surfaced.
       *
       * That difference is computed here and printed here, unconditionally, above
       * the toggle. A reviewer who never opens the table still sees that Stage 3
       * left 44 of the 75 items it was handed untouched. What collapses is the
       * per-row detail, which is a lookup surface — the place you go to check a
       * specific evidence id against a citation — and not a fact that is lost by
       * being one click away.
       */}
      <p className="text-xs text-zinc-500">
        {evidence.length} item(s) offered · <span className="text-emerald-400">{usedCount} cited</span>{" "}
        · <span className="text-zinc-400">{evidence.length - usedCount} not cited</span>. What was
        ignored is only visible from this difference.
      </p>
      <details className="group">
        <summary className="cursor-pointer list-none text-xs text-zinc-500 hover:text-zinc-300">
          <span className="group-open:hidden">▸ Show </span>
          <span className="hidden group-open:inline">▾ Hide </span>
          all {evidence.length} row(s), cited and uncited
        </summary>
        <div className="mt-2 overflow-x-auto rounded-lg border border-zinc-800">
          <table className="w-full min-w-[40rem] text-left">
            <thead className="bg-zinc-900/60 text-xs uppercase tracking-wide text-zinc-500">
              <tr>
                <th className="px-3 py-2 font-medium">Used</th>
                <th className="px-3 py-2 font-medium">Kind</th>
                <th className="px-3 py-2 font-medium">Evidence id</th>
                <th className="px-3 py-2 font-medium">Value as the model read it</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800">
              {evidence.map((item) => (
                <EvidenceRow key={item.id} item={item} cited={cited.has(item.id)} />
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}

/** Ids present in both runs whose rendered value is not the same string. */
function driftBetween(
  earlier: readonly EvidenceItem[],
  later: readonly EvidenceItem[],
): readonly { readonly id: string; readonly before: string; readonly after: string }[] {
  const byId = new Map(earlier.map((item) => [item.id, item]));
  const drifted: { id: string; before: string; after: string }[] = [];
  for (const item of later) {
    const before = byId.get(item.id);
    if (before !== undefined && before.value !== item.value) {
      drifted.push({ id: item.id, before: before.value, after: item.value });
    }
  }
  return drifted;
}

/** Ids the assess run emitted that the derive run's fresh gather no longer has. */
function goneSince(
  earlier: readonly EvidenceItem[],
  later: readonly EvidenceItem[],
): readonly string[] {
  const laterIds = new Set(later.map((item) => item.id));
  return earlier.filter((item) => !laterIds.has(item.id)).map((item) => item.id);
}

export function ProposalEvidence({
  derive,
  deriveCited,
  assess,
  assessCited,
}: {
  derive: DeriveResponse;
  deriveCited: ReadonlySet<string>;
  /** The original Stage 2 response, when the reviewer has it. Optional. */
  assess: AssessResponse | null;
  assessCited: ReadonlySet<string>;
}) {
  const [showJson, setShowJson] = useState(false);

  const drift = assess === null ? [] : driftBetween(assess.assess.evidence, derive.derive.evidence);
  const gone = assess === null ? [] : goneSince(assess.assess.evidence, derive.derive.evidence);

  return (
    <section className="space-y-4">
      <h3 className="text-sm font-semibold uppercase tracking-wide text-zinc-400">
        Raw source data — everything both stages were offered
      </h3>

      {assess !== null && (drift.length > 0 || gone.length > 0) && (
        <div className="rounded-lg border border-zinc-700 bg-zinc-900/60 px-4 py-3">
          <h4 className="text-xs font-semibold uppercase tracking-wide text-zinc-400">
            The two calls gathered different data — this is expected
          </h4>
          <p className="mt-1 text-xs text-zinc-500">
            Stage 2 and Stage 3 ran against two independent gathers separated by real time. The
            proposal was derived against the newer values, and every claim above is rendered beside
            the newer values too.
          </p>
          {drift.length > 0 && (
            <div className="mt-3 overflow-x-auto">
              <table className="w-full min-w-[32rem] text-left text-xs">
                <thead className="text-zinc-500">
                  <tr>
                    <th className="py-1 pr-3 font-medium">Evidence id</th>
                    <th className="py-1 pr-3 font-medium">At assess time</th>
                    <th className="py-1 font-medium">At derive time</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-800">
                  {drift.map((row) => (
                    <tr key={row.id} className="align-top">
                      <td className="py-1.5 pr-3">
                        <code className="tabular text-zinc-400">{row.id}</code>
                      </td>
                      <td className="tabular py-1.5 pr-3 break-words text-zinc-500">{row.before}</td>
                      <td className="tabular py-1.5 break-words text-zinc-200">{row.after}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {gone.length > 0 && (
            <p className="mt-3 text-xs text-amber-300">
              {gone.length} evidence id(s) the assess run emitted no longer exist in the derive
              run&rsquo;s fresh gather: <code>{gone.join(", ")}</code>. A claim citing one of these
              would have been refused with <code>citation_unknown</code> rather than derived from.
            </p>
          )}
        </div>
      )}

      <div>
        <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">
          Stage 3 (Derive) — the evidence behind the parameters
        </h4>
        <EvidenceTable evidence={derive.derive.evidence} cited={deriveCited} />
      </div>

      {assess !== null && (
        <div>
          <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">
            Stage 2 (Assess) — the evidence behind the strategy choice, as it stood then
          </h4>
          <EvidenceTable evidence={assess.assess.evidence} cited={assessCited} />
        </div>
      )}

      <div className="rounded-lg border border-zinc-800 bg-zinc-900/20 px-4 py-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h4 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
              The complete responses, verbatim
            </h4>
            <p className="text-xs text-zinc-600">
              Including the full candle array, the candidate&rsquo;s provenance, the concentration
              facts and policy echo, the capital rows, the venue filters, and each stage&rsquo;s
              model id, settings and latency — none of which is summarised above.
            </p>
          </div>
          <button
            type="button"
            onClick={() => setShowJson((shown) => !shown)}
            className="shrink-0 rounded-md border border-zinc-700 px-3 py-1 text-xs text-zinc-300 hover:bg-zinc-800"
          >
            {showJson ? "Hide" : "Show"} raw JSON
          </button>
        </div>
        {showJson && (
          <pre className="mt-3 max-h-[32rem] overflow-auto rounded border border-zinc-800 bg-zinc-950 p-3 text-[11px] leading-relaxed text-zinc-400">
            {JSON.stringify(assess === null ? { derive } : { assess, derive }, null, 2)}
          </pre>
        )}
      </div>
    </section>
  );
}
