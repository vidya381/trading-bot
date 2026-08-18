/**
 * A HISTORICAL STAGE 2 RECORD, rendered — and the honest account of why it is not
 * rendered by `ProposalView`.
 *
 * ── ⚠ READ THIS FIRST: THIS IS NOT A DEGRADED PROPOSAL VIEW ──
 *
 * The obvious suspicion about a second component next to `ProposalView` is that it
 * is a lookalike that drifted, or a "history mode" that quietly shows less. It is
 * neither, and the distinction is structural rather than a matter of degree:
 *
 *   **`ProposalView` IS BUILT AROUND A DERIVATION, AND AN ASSESSMENT HAS NO
 *   PARAMETERS.** Its summary card prints headline numbers off `proposal.params`,
 *   its parameters section renders per-field citations, its create-bot link encodes
 *   an allocated capital and a reference price. A Stage 2 record has none of those,
 *   because Stage 2's whole answer is a STRATEGY CHOICE and its reasons. That is the
 *   same fact migration 0009 enforces in SQL as `only_a_derivation_can_be_approved`:
 *   *"an assessment carries a strategy choice and its reasons, not the parameters a
 *   bot needs, so no bot could have been created from it."*
 *
 * So the payload is NOT what is missing. `GET /api/proposals/:id` rebuilds an assess
 * record into the exact `AssessResponse` the live endpoint returned, field for
 * field, and `api.test.ts` asserts that against a real run. What cannot be reused is
 * the RENDERER, and the endpoint publishes `fidelity.renderableByProposalView: false`
 * so this page picks the right one rather than guessing.
 *
 * ── WHAT IS REUSED, RATHER THAN REBUILT ──
 *
 * Everything that is genuinely about a bundle or an evidence set:
 *
 *   * `ProposalConcentration` — the same banner, over the same
 *     `GatheredInput<ConcentrationResult>`, with the same three states. Decision log
 *     49 PART 3's `unknown` is preserved exactly, because it is the same component.
 *   * `CitationLegend` and `CitationList` — the same three-way citation
 *     classification, the same badges, the same never-collapsed
 *     "rests on no fetched data" warning that decision log 44's live check 4
 *     established the value of.
 *   * `EvidenceTable` — the same offered/cited difference, computed the same way,
 *     collapsed the same way.
 *
 * ⚠ WHAT IS NOT REUSED, AND WHY EACH IS ABSENT RATHER THAN EMPTY:
 *
 *   * `ProposalFreshness` takes a `Freshness` built by `freshnessOf(derive)`, which
 *     reads `derive.context.capital` and `derive.context.filters` — Stage 3's own
 *     two reads, which a Stage 2 record does not have. Rendering it with two of four
 *     rows blank would report "the capital ledger's age is unknown" about a stage
 *     that never read the capital ledger, which is a false negative in the exact
 *     shape decision log 49 PART 3 argues against.
 *   * `ProposalLimits` takes `dataLimits(bundle, context)` for the same reason.
 *   * `ProposalParameters`, `ProposalSummaryCard` and `ProposalCreateBotLink` have
 *     nothing to render and nothing to link to.
 *
 * Each of those absences is STATED on the page rather than left as a gap a reader
 * has to notice, which is entry 44's rule: an unstated gap is the failure mode; a
 * stated one is a limitation.
 *
 * ── ⚠ IT DECIDES NOTHING ──
 *
 * No verdict, no threshold, no re-validation. The staleness of the price window is
 * deliberately NOT computed here: `stalenessOf` is per-input and per-strategy, and a
 * partial freshness table over one of the four inputs would be a second, narrower
 * implementation of a policy that already exists — the "copy that drifts" fault. The
 * fetch time is printed as a time and the reader has the date.
 */

import type { AssessResponse } from "../api/research-types";
import { citedIds } from "../proposal";
import { formatDateTime } from "../format";
import { CitationLegend, CitationList } from "./ProposalCitations";
import { ProposalConcentration } from "./ProposalConcentration";
import { EvidenceTable } from "./ProposalEvidence";

export function ProposalAssessRecord({ assess }: { assess: AssessResponse }) {
  const cited = citedIds(...assess.assess.claims.map((claim) => claim.citations));
  const candidate = assess.bundle.candidate;
  const candles = assess.bundle.candles;

  return (
    <article className="space-y-6">
      <header className="rounded-lg border border-zinc-800 bg-zinc-900/40 px-4 py-4">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2">
          <div>
            <h2 className="text-xl font-semibold text-zinc-100">
              Strategy assessment — <span className="tabular">{candidate.pair}</span>
            </h2>
            <div className="mt-0.5 text-sm text-zinc-500">
              account <span className="text-zinc-300">{candidate.accountLabel}</span> on{" "}
              <span className="text-zinc-300">{candidate.exchange}</span> · entry point{" "}
              {assess.entryPoint}
            </div>
          </div>
          <div className="text-right text-xs text-zinc-500">
            <div>
              Stage 2 model: <span className="text-zinc-300">{assess.assess.model}</span> ·{" "}
              {assess.assess.latencyMs} ms
            </div>
            <div>
              prompt {assess.assess.promptVersion} · {assess.assess.promptChars} chars ·{" "}
              {assess.assess.envelope} · duplicate-key scan {assess.assess.duplicateKeyCheck}
            </div>
          </div>
        </div>

        {/*
         * ⚠ THE SENTENCE THAT STOPS A READER LOOKING FOR PARAMETERS THAT WERE NEVER
         * THERE. It is the first thing after the header for the reason the
         * concentration banner used to be first: a limitation placed below the
         * reasoning is a limitation the reasoning has already been read without.
         */}
        <p className="mt-3 border-t border-zinc-800 pt-3 text-xs text-zinc-400">
          <strong className="text-zinc-200">This is a Stage 2 record, not a bot proposal.</strong>{" "}
          Stage 2 answers one question — which strategy fits this pair — and produces no bounds, no
          order size and no allocation. There are no parameters here because none were ever derived,
          not because this view is showing less than the record holds: the stored payload is rebuilt
          in full, and the database itself refuses to let an assessment be approved (
          <code>only_a_derivation_can_be_approved</code>). Deriving parameters is a second, separate
          paid call.
        </p>
      </header>

      {/* Reused unchanged: the same three states, including "the check did not run". */}
      <ProposalConcentration concentration={assess.bundle.concentration} />

      <section className="rounded-lg border border-zinc-800 bg-zinc-900/40 px-4 py-3">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-400">
          What this record does not carry, stated rather than left blank
        </h3>
        <ul className="mt-2 space-y-1 text-xs text-zinc-500">
          <li>
            <strong className="text-zinc-400">No freshness table.</strong> The four-timestamp
            verdict is computed over Stage 3&rsquo;s reads as well as Stage 1&rsquo;s — the capital
            ledger and the venue filters — and Stage 2 read neither. A table with two of four rows
            blank would report the capital ledger&rsquo;s age as unknown about a stage that never
            looked at it.
          </li>
          <li>
            <strong className="text-zinc-400">No data-limits panel</strong>, for the same reason: it
            is built from the bundle and Stage 3&rsquo;s context together.
          </li>
          <li>
            <strong className="text-zinc-400">The price window was fetched at</strong>{" "}
            {candles.outcome === "ok" ? (
              <span className="text-zinc-300">{formatDateTime(candles.value.fetchedAt)}</span>
            ) : (
              <span className="text-amber-300">
                — the candle fetch did not succeed ({candles.error.message})
              </span>
            )}
            . That is spec 21.5 requirement 4&rsquo;s fetch time, printed rather than judged: no
            staleness verdict is computed here, because the policy is per-input and per-strategy and
            a narrower second copy of it would drift from the one the proposal view uses.
          </li>
        </ul>
      </section>

      <CitationLegend />

      <section className="space-y-3">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-zinc-400">
          The strategy it chose, and why
        </h3>
        <div className="flex flex-wrap items-center gap-3">
          <span className="rounded bg-zinc-100 px-2.5 py-1 text-sm font-bold uppercase tracking-wide text-zinc-900">
            {assess.assess.strategy}
          </span>
          <span className="text-xs text-zinc-500">
            {assess.assess.claims.length} claim(s), each with its citations resolved
          </span>
        </div>
        <ul className="space-y-3">
          {assess.assess.claims.map((claim, index) => (
            <li key={index} className="rounded-lg border border-zinc-800 bg-zinc-900/20 px-4 py-3">
              <p className="text-sm text-zinc-200">{claim.statement}</p>
              <div className="mt-2">
                <CitationList citations={claim.citations} />
              </div>
            </li>
          ))}
        </ul>
      </section>

      <section className="space-y-2">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-zinc-400">
          Raw source data — everything Stage 2 was offered
        </h3>
        {/* The same table, the same difference, the same collapse rule. */}
        <EvidenceTable evidence={assess.assess.evidence} cited={cited} />
      </section>

      <footer className="space-y-2 rounded-lg border border-zinc-800 bg-zinc-900/20 px-4 py-3 text-xs text-zinc-500">
        <p>
          <strong className="text-zinc-400">What the checks behind this record do and do not say.</strong>{" "}
          Every one answers &ldquo;is this internally consistent and grounded in the fetched
          data?&rdquo; Not one answers &ldquo;was the data worth reasoning about?&rdquo; An
          assessment can cite every number correctly and still be a strategy nobody should run.
        </p>
        <p>
          <strong className="text-zinc-400">This view changes nothing.</strong> It is a read of the
          permanent record, which writes no row and no <code>audit_log</code> entry. Rejecting an
          assessment is still <code>POST /api/proposals/{assess.proposalId}/reject</code>, and it is
          deliberately not a control on this page.
        </p>
      </footer>
    </article>
  );
}
