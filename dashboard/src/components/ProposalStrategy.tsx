/**
 * Stage 2's answer: WHICH strategy, and WHY (spec 21.4 stage 4, requirement 1).
 *
 * Every claim below is the real Stage 2 result, rendered with its citations
 * resolved to whole evidence items and each one classified — so a reason resting
 * on a fetched price and a reason resting on the fact that no news was collected
 * do not read the same (decision log 43).
 *
 * ── WHAT IS VERIFIED HERE, AND WHAT IS TAKEN ON THE CLIENT'S WORD ──
 *
 * `/derive` takes its assessment from an EARLIER, SEPARATE HTTP call that this
 * system stores nothing about. That is a real trust boundary and the response
 * labels it rather than hiding it, so this component surfaces the label rather
 * than smoothing it away:
 *
 *   VERIFIED   — every citation was re-resolved against the evidence the derive
 *                request gathered FRESHLY. An assessment whose data has aged out
 *                is refused with `citation_unknown`, which was observed firing
 *                for real, unprompted, on a shallower candle window (decision
 *                log 42, check 7). The values shown beside each claim are the
 *                CURRENT ones, not the ones the assessment was written about.
 *   UNVERIFIED — the claim's prose, and the two audit facts about the original
 *                model call (`envelope`, `duplicateKeyCheck`). Nothing here
 *                witnessed that call. They are carried rather than dropped so
 *                the audit trail is not silently shortened, and labelled rather
 *                than published bare so a client-asserted fact is never read as
 *                an observed one.
 *
 * ── ⚠ A WELL-GROUNDED REASON IS NOT A GOOD REASON ──
 *
 * Carried forward from decision logs 40, 41 and 42 without dilution, because a
 * clean-looking proposal is exactly when it is most likely to be lost: every
 * check behind this section answers "is this internally consistent and currently
 * grounded?" and not one answers "was the data worth reasoning about?". The
 * human reading this page is the only part of the loop that can tell those apart.
 */

import type { ResubmittedAssessment, Strategy } from "../api/research-types";
import { CitationList } from "./ProposalCitations";

const STRATEGY_DESCRIPTION: Readonly<Record<Strategy, string>> = {
  dca: "Repeated buys of a base size, adding further buys as the price drops by a configured step, exiting at a take-profit percentage. It accumulates into weakness and needs a directional recovery to realise profit.",
  grid: "Buy and sell orders placed at intervals across a bounded price range, profiting from movement back and forth inside it. It needs the price to stay within a range and to oscillate inside it.",
};

export function ProposalStrategy({
  assessment,
  deriveStrategy,
}: {
  assessment: ResubmittedAssessment;
  /** Stage 3's echo. The backend refuses a derivation that disagrees. */
  deriveStrategy: Strategy;
}) {
  const agree = assessment.strategy === deriveStrategy;

  return (
    <section className="space-y-3">
      <h3 className="text-sm font-semibold uppercase tracking-wide text-zinc-400">
        Strategy choice, and why
      </h3>

      <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 px-4 py-4">
        <div className="flex flex-wrap items-baseline gap-3">
          <span className="rounded bg-zinc-100 px-2.5 py-1 text-lg font-bold uppercase tracking-wide text-zinc-900">
            {assessment.strategy}
          </span>
          <span className="text-xs text-zinc-500">
            chosen by Stage 2 from this same data · echoed by Stage 3
          </span>
        </div>
        <p className="mt-2 max-w-3xl text-sm text-zinc-400">
          {STRATEGY_DESCRIPTION[assessment.strategy]}
        </p>

        {!agree && (
          <p role="alert" className="mt-3 rounded border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-200">
            ⚠ The two stages disagree: Stage 2 said <strong>{assessment.strategy}</strong> and Stage
            3 answered <strong>{deriveStrategy}</strong>. The backend refuses this, so seeing it
            here means the response was assembled from two unrelated runs. Do not act on this
            proposal.
          </p>
        )}

        <dl className="mt-4 flex flex-wrap gap-x-6 gap-y-2 border-t border-zinc-800 pt-3 text-xs">
          <div>
            <dt className="text-zinc-500">Assessment came from</dt>
            <dd className="text-zinc-300">
              an earlier, separate call ({assessment.source})
            </dd>
          </div>
          <div>
            <dt className="text-zinc-500">Citations re-verified against fresh evidence</dt>
            <dd className="text-emerald-300">
              {assessment.citationsReverified ? "yes" : "no"}
            </dd>
          </div>
          <div>
            <dt className="text-zinc-500">Original call&rsquo;s transport envelope</dt>
            <dd className="text-amber-300">
              {assessment.unverifiedOriginalCall.envelope} (unverified)
            </dd>
          </div>
          <div>
            <dt className="text-zinc-500">Original call&rsquo;s duplicate-key scan</dt>
            <dd className="text-amber-300">
              {assessment.unverifiedOriginalCall.duplicateKeyCheck} (unverified)
            </dd>
          </div>
        </dl>
        <p className="mt-2 text-xs text-zinc-600">
          The claim text below is whatever the client submitted; nothing here witnessed the original
          model writing it. What IS guaranteed is narrower and is the part that matters: every claim
          arrives attached to an evidence id this derive run really emitted, so each sentence sits
          beside data that exists right now.
        </p>
      </div>

      <ol className="space-y-3">
        {assessment.claims.map((claim, index) => (
          <li
            key={index}
            className="rounded-lg border border-zinc-800 bg-zinc-900/40 px-4 py-3"
          >
            <div className="flex gap-3">
              <span className="tabular shrink-0 text-xs text-zinc-600">{index + 1}.</span>
              <p className="min-w-0 text-sm text-zinc-200">{claim.statement}</p>
            </div>
            <div className="mt-3 pl-6">
              <CitationList citations={claim.citations} />
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}
