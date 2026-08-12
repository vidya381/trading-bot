/**
 * Rendering one citation, a list of them, and the legend that explains the three
 * kinds -- decision log 43's requirement made visible.
 *
 * THE ONE RULE THIS FILE ENFORCES: no citation is ever rendered as a bare
 * "source". Every one carries its class badge, and the badge carries WORDS as
 * well as a colour. A reviewer who cannot tell that a value rests on a
 * non-observation, or on an earlier model's judgement rather than on a fetched
 * number, is being shown a proposal that looks better grounded than it is -- and
 * a presentation layer that rendered all three identically would itself create
 * the "hard to verify in practice" condition entry 43 lists as grounds to reopen
 * the whole decision.
 *
 * The full rendered `value` is shown beside every citation, never a summary of
 * it. That is 21.5 requirement 2's actual ask: the human verifies the reasoning
 * against the real source, which is impossible if the only account of the source
 * is the summary whose accuracy is in question. It is also what makes the two
 * documented edge branches safe (see `src/citations.ts`) -- a `candles.status`
 * carrying "MISSING -- ..." reads as missing even where the source-based rule
 * classifies it as fetched data.
 */

import {
  CITATION_CLASS_COPY,
  CITATION_CLASS_STYLE,
  classifyCitation,
  noFetchedDataWarning,
  restsOnNoFetchedData,
  type CitationClass,
} from "../citations";
import type { EvidenceItem } from "../api/research-types";

export function CitationBadge({ citationClass }: { citationClass: CitationClass }) {
  const copy = CITATION_CLASS_COPY[citationClass];
  return (
    <span
      title={copy.explanation}
      className={[
        "inline-flex shrink-0 items-center rounded border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
        CITATION_CLASS_STYLE[citationClass],
      ].join(" ")}
    >
      {copy.short}
    </span>
  );
}

/**
 * One citation: its class, its id, the label the model read, and the exact
 * rendered value.
 *
 * The id is shown in full because it is the token that ties this row to the raw
 * evidence panel below and to the model's own answer; shortening it would break
 * the only cheap check a reviewer has.
 */
export function CitationRow({ item }: { item: EvidenceItem }) {
  const citationClass = classifyCitation(item);
  return (
    <li className="flex min-w-0 flex-col gap-1 border-l-2 border-zinc-800 py-1 pl-3 sm:flex-row sm:items-start sm:gap-3">
      <div className="flex shrink-0 items-center gap-2">
        <CitationBadge citationClass={citationClass} />
        <code className="tabular text-xs text-zinc-400">{item.id}</code>
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-xs text-zinc-500">{item.label}</div>
        <div className="tabular mt-0.5 break-words text-sm text-zinc-200">{item.value}</div>
        <div className="mt-0.5 text-[11px] text-zinc-600">
          source: <code>{item.source}</code>
        </div>
      </div>
    </li>
  );
}

/**
 * A set of citations, with the field-level warning when NOT ONE of them is
 * fetched data.
 *
 * The warning exists because reading three badges and noticing that none says
 * "Fetched data" is work, and entry 43's condition 3 is precisely a reviewer
 * unable to tell in reasonable time what a value rests on. It is amber, not red:
 * these are not errors, and both live examples were sound on inspection.
 */
export function CitationList({ citations }: { citations: readonly EvidenceItem[] }) {
  if (citations.length === 0) {
    return (
      <div className="text-xs text-amber-300">
        No citations on this item. The backend refuses an uncited claim or value, so this should be
        unreachable — treat it as a fault in the response, not as an ungrounded value shown on
        purpose.
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {restsOnNoFetchedData(citations) && (
        <div className="rounded border border-amber-500/40 bg-amber-500/10 px-2.5 py-1.5 text-xs text-amber-200">
          <span className="font-semibold">⚠ {noFetchedDataWarning(citations)}</span>{" "}
          <span className="text-amber-200/80">
            That is not automatically wrong, and it is not a refusal — it is the thing to read
            carefully before approving.
          </span>
        </div>
      )}
      <ul className="space-y-1.5">
        {citations.map((item) => (
          <CitationRow key={item.id} item={item} />
        ))}
      </ul>
    </div>
  );
}

/**
 * The legend, shown once near the top of the proposal.
 *
 * Placed ABOVE the reasoning rather than in a footnote: the badges are only
 * useful if a reader knows what they mean before reading the claims, and a key
 * discovered after the fact does not undo a paragraph already read as
 * well-grounded.
 */
export function CitationLegend() {
  const classes: readonly CitationClass[] = ["fetched_data", "absence_marker", "prior_stage_claim"];
  return (
    <section className="rounded-lg border border-zinc-800 bg-zinc-900/40 px-4 py-3">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-400">
        What a citation points at
      </h3>
      <p className="mt-1 text-xs text-zinc-500">
        Every value below cites the evidence it rests on. The three kinds are not interchangeable
        and none of them is a refusal — the second and third are honest citations that simply do
        not mean what the first means.
      </p>
      <dl className="mt-3 space-y-2">
        {classes.map((citationClass) => (
          <div key={citationClass} className="flex flex-col gap-1 sm:flex-row sm:gap-3">
            <dt className="shrink-0 sm:w-36">
              <CitationBadge citationClass={citationClass} />
            </dt>
            <dd className="min-w-0 text-xs text-zinc-400">
              {CITATION_CLASS_COPY[citationClass].explanation}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
