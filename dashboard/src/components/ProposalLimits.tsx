/**
 * What the data behind this proposal does not cover — spec 21.3's hype hazard,
 * stated by this stage rather than relayed from the model.
 *
 * ── WHY THIS IS A PANEL AND NOT JUST ONE OF STAGE 2'S CLAIMS ──
 *
 * 21.3 puts the duty on the Explain stage in its own words: it "must STATE
 * PLAINLY when a coin has limited price history, thin liquidity, or interest
 * that looks hype-driven, and must never treat 'trending' as evidence in the
 * coin's favour." That is a duty on this layer to state it — not a duty to
 * forward it if an upstream model happened to mention it.
 *
 * The Assess prompt does ask for it ("If the evidence is thin, shallow, or
 * partly missing, SAY SO as one of your claims"), and Stage 2's claims are
 * rendered in full elsewhere on this page. But a prompt instruction is a thing a
 * model may or may not follow — the same reason `assess-prompt.ts` pairs its
 * grounding rule with a mechanical citation check rather than trusting the rule
 * alone. So the facts below are read from the fetched data directly and appear
 * whether or not any claim mentions them.
 *
 * THE ANSWER TO "SHOULD IT ALSO BE VISUALLY DISTINGUISHED?" IS YES, and the
 * reason is 21.3's own stated failure mode: "a proposal that reads as confident
 * because the input was loud". A limitation rendered as claim number four of six,
 * in the same weight as "the range is tight, so grid fits", is a limitation a
 * confident-sounding proposal absorbs. It sits directly under the concentration
 * flag, above the strategy and the parameters, for that reason.
 *
 * ── WHAT THIS DOES NOT DO ──
 *
 * It does not try to work out WHICH of Stage 2's prose claims is the honest one.
 * That would be classifying model prose by meaning — a judgement, and exactly
 * the kind of thing this project refuses to mechanise (decision log 43's
 * rejection of option C). The claims are shown; these facts are shown; a reader
 * compares them, and a model that ignored a limitation this panel names is a
 * fact worth being able to see.
 *
 * It also invents no threshold. `dataLimits` explains why liquidity in
 * particular is surfaced as raw data with the absence of a test stated outright.
 */

import type { DataLimit } from "../proposal";

export function ProposalLimits({ limits }: { limits: readonly DataLimit[] }) {
  if (limits.length === 0) {
    return (
      <section className="rounded-lg border border-zinc-800 bg-zinc-900/40 px-4 py-2.5 text-xs text-zinc-500">
        No limited-history, missing-input or provenance caveats were found in this run's data.
      </section>
    );
  }

  return (
    <section className="overflow-hidden rounded-lg border-2 border-sky-500/50 bg-sky-500/5">
      <div className="bg-sky-500/15 px-4 py-2">
        <h2 className="text-sm font-bold uppercase tracking-wide text-sky-200">
          What this proposal&rsquo;s data does not cover — {limits.length} item
          {limits.length === 1 ? "" : "s"}
        </h2>
      </div>
      <div className="px-4 py-3">
        <p className="text-xs text-sky-200/70">
          Read from the fetched data by this view, not taken from the model&rsquo;s prose. Each
          names the evidence ids that show it, so you can check it in the raw data below.
        </p>
        <ul className="mt-3 space-y-2.5">
          {limits.map((limit) => (
            <li key={limit.key} className="border-l-2 border-sky-500/40 pl-3">
              <div className="text-sm font-medium text-sky-100">{limit.headline}</div>
              <p className="mt-0.5 text-xs text-zinc-400">{limit.detail}</p>
              <div className="mt-1 flex flex-wrap gap-1.5">
                {limit.evidenceIds.map((id) => (
                  <code
                    key={id}
                    className="tabular rounded border border-zinc-700 bg-zinc-800/60 px-1.5 py-0.5 text-[10px] text-zinc-400"
                  >
                    {id}
                  </code>
                ))}
              </div>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
