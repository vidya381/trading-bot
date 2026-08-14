/**
 * STAGE 4 — EXPLAIN AND ASSEMBLE (spec 21.4).
 *
 * One complete, human-readable proposal assembled from the two real responses
 * the client already holds: a `GET /api/accounts/:label/assess` result and the
 * `GET /api/accounts/:label/derive` result derived from it.
 *
 * ── WHAT THIS STAGE IS, AND WHAT IT DELIBERATELY IS NOT ──
 *
 * IT IS: deterministic presentation over data that already exists and has
 * already been verified. Nothing here calls a model, calls a backend endpoint,
 * or performs a check the pipeline has not already performed.
 *
 * IT DOES NOT RE-VERIFY CITATIONS OR CLAIMS. `/assess` resolved every citation
 * against the evidence its run emitted, and `/derive` re-resolved every citation
 * in the resubmitted assessment against the evidence IT gathered freshly, before
 * spending an inference (`parseResubmittedAssessment`, decision log 42). Doing it
 * again here would duplicate that work for no reason and would invite the idea
 * that the backend's answer needs a second opinion from a rendering layer.
 *
 * IT DOES NOT VALIDATE PARAMETERS. The set below already passed the real
 * create-bot decoders, the mandatory stop-loss, the sanity bounds, the venue
 * floor and the capital-headroom check (21.5 requirement 3). A second
 * implementation of a risk check drifts from the first, and the copy that drifts
 * is the one nobody is watching.
 *
 * ── ⚠ SCOPE: THE PROPOSAL IS LOGGED, AND NOT BY THIS COMPONENT ──
 *
 * THIS COMPONENT STILL PERSISTS NOTHING — no D1 write, no `audit_log` entry, no
 * KV key, no local storage. What changed is upstream: 21.5 requirement 5's
 * permanent record now exists, and the BACKEND wrote it when `/assess` and
 * `/derive` ran (migration 0009, `src/research/proposal-log.ts`). Both responses
 * carry the `proposalId` of the row that holds their full inputs, their full
 * prompt and the raw model response.
 *
 * So "if you close this tab, this proposal is gone" is no longer true of the
 * RECORD, only of this rendering — and the footer says which is which. The
 * distinction matters: a reviewer who believes the record is in the page will
 * screenshot it, and one who believes the page is the record will not know an id
 * exists to reject or approve by.
 *
 * ── ⚠ 21.1: THIS IS A PROPOSAL, AND THE BOUNDARY IS NOT NEGOTIABLE ──
 *
 * Nothing on this page creates, starts or modifies a bot. There is no approve
 * button: the only way this output becomes a bot is a human reading it and going
 * to the create-bot form, which runs every check it runs today, unchanged and
 * unweakened.
 *
 * ⚠ THERE IS NOW A PREFILLED CREATE-BOT LINK, AND THIS PARAGRAPH USED TO SAY
 * THERE WAS NOT. Corrected in place rather than deleted, because the sentence it
 * replaces was true when written and the reasoning behind it did not stop being
 * right — decision log 44 refused to build a link at all, and decision log 46
 * settled the four constraints under which one is not the "one-click bridge" 21.1
 * forbids. `ProposalCreateBotLink` is built to those constraints and argues them
 * in its own header. What it does is NAVIGATE, carrying these values as a form's
 * starting numbers; the form is the same component, runs the same checks, keeps
 * every field editable, and this proposal's `outcome` stays null unless a real bot
 * is really created. Spec 21.1's own wording allows exactly this and no more:
 * *"a human reading it and filling in (or confirming a prefilled) create-bot
 * form"*.
 */

import type { AssessResponse, DeriveResponse } from "../api/research-types";
import { citedIds, dataLimits, freshnessOf } from "../proposal";
import { formatDateTime } from "../format";
import { ErrorBoundary } from "./ErrorBoundary";
import { CitationLegend } from "./ProposalCitations";
import { ProposalConcentration } from "./ProposalConcentration";
import { ProposalCreateBotLink } from "./ProposalCreateBotLink";
import { ProposalEvidence } from "./ProposalEvidence";
import { ProposalFreshness } from "./ProposalFreshness";
import { ProposalLimits } from "./ProposalLimits";
import { ProposalParameters } from "./ProposalParameters";
import { ProposalStrategy } from "./ProposalStrategy";

function ProvenanceLine({ derive }: { derive: DeriveResponse }) {
  return (
    <ul className="mt-2 space-y-1 text-xs text-zinc-500">
      {derive.bundle.candidate.sources.map((source, index) => (
        <li key={index}>
          {source.kind === "named" && (
            <>
              Named by a human: requested as <span className="text-zinc-300">{source.requestedAs}</span>{" "}
              by {source.requestedBy} at {formatDateTime(source.requestedAt)}
            </>
          )}
          {source.kind === "watchlist" && (
            <>
              Watchlist entry {source.entryId}: &ldquo;
              <span className="text-zinc-300">{source.note}</span>&rdquo;, added by {source.addedBy}{" "}
              at {formatDateTime(source.addedAt)}
            </>
          )}
          {source.kind === "trending" && (
            <>
              Trending pull {source.pullId} from {source.vendor} at{" "}
              {formatDateTime(source.fetchedAt)}: {source.name} ({source.symbol}), rank{" "}
              {source.rank === null ? "not published" : source.rank}
            </>
          )}
        </li>
      ))}
    </ul>
  );
}

export function ProposalView({
  derive,
  assess,
}: {
  derive: DeriveResponse;
  /** The original Stage 2 response, when the reviewer still has it. Optional. */
  assess?: AssessResponse | null;
}) {
  const assessResponse = assess ?? null;
  const freshness = freshnessOf(derive);
  const limits = dataLimits(derive.bundle, derive.context);

  // What each stage actually cited, so the evidence panel can show the
  // difference between offered and used (21.5 requirement 2).
  const deriveCited = citedIds(
    ...Object.values(derive.derive.proposal.citations),
    derive.derive.proposal.allocatedCapitalCitations,
    derive.derive.proposal.capitalAssetCitations,
    ...derive.derive.notes.map((note) => note.citations),
  );
  const assessCited =
    assessResponse === null
      ? new Set<string>()
      : citedIds(...assessResponse.assess.claims.map((claim) => claim.citations));

  const candidate = derive.bundle.candidate;

  return (
    <article className="space-y-6">
      <header className="rounded-lg border border-zinc-800 bg-zinc-900/40 px-4 py-4">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2">
          <div>
            <h2 className="text-xl font-semibold text-zinc-100">
              Bot proposal — <span className="tabular">{candidate.pair}</span>
            </h2>
            <div className="mt-0.5 text-sm text-zinc-500">
              account <span className="text-zinc-300">{candidate.accountLabel}</span> on{" "}
              <span className="text-zinc-300">{candidate.exchange}</span> · entry point{" "}
              {derive.entryPoint}
            </div>
          </div>
          <div className="text-right text-xs text-zinc-500">
            <div>
              Stage 2 model: <span className="text-zinc-300">{derive.assessment.strategy}</span> from
              a previous call
            </div>
            <div>
              Stage 3 model: <span className="text-zinc-300">{derive.derive.model}</span> ·{" "}
              {derive.derive.latencyMs} ms
              {assessResponse !== null && (
                <>
                  {" · Stage 2: "}
                  <span className="text-zinc-300">{assessResponse.assess.model}</span> ·{" "}
                  {assessResponse.assess.latencyMs} ms
                </>
              )}
            </div>
          </div>
        </div>
        <ProvenanceLine derive={derive} />
        <p className="mt-3 border-t border-zinc-800 pt-3 text-xs text-zinc-400">
          <strong className="text-zinc-200">This is a proposal, not a bot.</strong> Nothing here has
          created, started or modified anything, and no capital has been reserved. To act on it, go
          to the create-bot form — it runs every check it always runs. The link at the bottom of
          this page opens that form with these values already in it; it is a starting point you can
          edit, not an approval, and there is deliberately no approve button anywhere on this page
          (spec 21.1).
        </p>
      </header>

      {/*
       * FIRST, and above everything a reader might scroll past: the
       * over-concentration flag. Spec 21.4 requires it "presented prominently,
       * not a silent filter", and prominence is a position as much as a colour.
       */}
      <ProposalConcentration concentration={derive.bundle.concentration} />

      {/*
       * SECOND: what the data does not cover. 21.3's failure mode is a proposal
       * that reads as confident because the input was loud, and a limitation
       * placed below the reasoning is a limitation the reasoning has already
       * been read without.
       */}
      <ProposalLimits limits={limits} />

      {/*
       * THIRD: how old the data is. "Is this still true?" is a gate question —
       * it comes before the reasoning is worth reading, not after.
       */}
      <ProposalFreshness freshness={freshness} />

      <CitationLegend />
      <ProposalStrategy assessment={derive.assessment} deriveStrategy={derive.derive.strategy} />
      {/*
       * ⚠ EACH SECTION IN ITS OWN BOUNDARY, and the parameters one is not there
       * because it is suspect — it is there because it is where a real crash
       * happened, and because a boundary per section is what makes a failure
       * CONTAINED rather than total. React's default on an uncaught render error is
       * to unmount the whole tree, which is what turned a single TypeError into a
       * blank black page during operator verification.
       *
       * `checkParamsShape` fixes that specific crash at its cause; these catch the
       * next shape nobody anticipated. A reviewer who loses the parameters block
       * still has the concentration flag, the limits, the freshness verdict and the
       * evidence — and can see, in place, exactly which part failed.
       */}
      <ErrorBoundary where="The parameters section">
        <ProposalParameters derive={derive.derive} />
      </ErrorBoundary>
      <ErrorBoundary where="The evidence section">
        <ProposalEvidence
          derive={derive}
          deriveCited={deriveCited}
          assess={assessResponse}
          assessCited={assessCited}
        />
      </ErrorBoundary>

      <footer className="space-y-2 rounded-lg border border-zinc-800 bg-zinc-900/20 px-4 py-3 text-xs text-zinc-500">
        <p>
          <strong className="text-zinc-400">What the checks behind this page do and do not say.</strong>{" "}
          Every one answers &ldquo;is this internally consistent, currently grounded, and acceptable
          to the real create-bot validators?&rdquo; Not one answers &ldquo;was the data worth
          reasoning about?&rdquo; A proposal can pass all of them and still be financially
          meaningless. You are the only part of this loop that can tell the two apart.
        </p>
        <p>
          <strong className="text-zinc-400">This proposal is permanently logged.</strong> The
          backend wrote a record when <code>/assess</code> and <code>/derive</code> ran, holding
          the full inputs, the full prompt and the raw model response (spec 21.5 requirement 5).
          Its id is{" "}
          <code className="tabular text-zinc-300">{derive.proposalId}</code>
          {assessResponse !== null && (
            <>
              {" "}
              and the assessment&rsquo;s is{" "}
              <code className="tabular text-zinc-300">{assessResponse.proposalId}</code>
            </>
          )}
          . Nothing is retained indefinitely by accident — section 8.7 keeps it on purpose, and
          there is no delete path.
        </p>
        <p>
          <strong className="text-zinc-400">The outcome is still unrecorded.</strong> Creating a bot
          through the link below carries <code>proposalId</code> in the{" "}
          <code>POST /api/bots</code> body for you, so the record says a human acted on it — but
          only on a real, completed creation. If you decide against it, post to{" "}
          <code>/api/proposals/{derive.proposalId}/reject</code>. A proposal nobody records a
          decision on counts as ignored, which is exactly the signal requirement 5 exists to
          measure. <strong className="text-zinc-400">This page itself stores nothing</strong> — if
          you close the tab this rendering is gone, though the record is not.
        </p>
        {/*
         * ⚠ LAST, DELIBERATELY. The one control that leads out of this page sits
         * below the concentration flag, the data limits, the freshness verdict,
         * the reasoning, the parameters and the evidence — after everything a
         * reviewer is meant to have read, not above it. Position is prominence,
         * which is the argument `ProposalView` already makes for putting the
         * concentration banner FIRST; the same argument puts this one last.
         */}
        <ErrorBoundary where="The create-bot link">
          <ProposalCreateBotLink derive={derive} />
        </ErrorBoundary>
      </footer>
    </article>
  );
}
