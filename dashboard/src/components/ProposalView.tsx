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
import { ProposalEvidence } from "./ProposalEvidence";
import { ProposalFreshness } from "./ProposalFreshness";
import { ProposalLimits } from "./ProposalLimits";
import { ProposalParameters } from "./ProposalParameters";
import { ProposalStrategy } from "./ProposalStrategy";
import { ProposalSummaryCard } from "./ProposalSummaryCard";

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
  offerCreateBot = true,
}: {
  derive: DeriveResponse;
  /**
   * The original Stage 2 response, when the reviewer still has it. Optional.
   *
   * ⚠ IT IS NEVER AVAILABLE FOR A HISTORICAL PROPOSAL, and that is a recorded
   * decision rather than a gap in the record. Migration 0009: a `derive` row does
   * NOT carry the id of the `assess` row it derives from, because nothing in the
   * request carries that link and an `assessProposalId` taken from the caller would
   * be a client-asserted claim this system cannot verify. So `/proposals/:id`
   * renders with `assess={null}` — which is not a degraded mode invented for
   * history, it is the state this component has supported since step 44 and the one
   * a reviewer who pasted only the derive response has always seen. What is absent
   * is Stage 2's own evidence table and the two-gather drift comparison; the full
   * Stage 3 proposal is entirely present.
   */
  assess?: AssessResponse | null;
  /**
   * Whether to offer the create-bot link. ⚠ FALSE ONLY ON THE HISTORY VIEW.
   *
   * The path from a proposal to a bot exists once, through a LIVE proposal, built
   * to decision log 46's four constraints. A history page is a record of what
   * happened, and a second entry point into that flow would be a second place its
   * copy — the text that stops a human mistaking a prefill for an approval — lives
   * and drifts. It suppresses an AFFORDANCE, never a guarantee:
   * `prefill-does-not-approve.test.ts` holds identically either way.
   */
  offerCreateBot?: boolean;
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
          created, started or modified anything, and no capital has been reserved.{" "}
          {offerCreateBot ? (
            <>
              To act on it, go to the create-bot form — it runs every check it always runs. The link
              in the summary card below opens that form with these values already in it; it is a
              starting point you can edit, not an approval, and there is deliberately no approve
              button anywhere on this page (spec 21.1).
            </>
          ) : (
            /*
             * ⚠ THE HISTORY VIEW'S OWN SENTENCE, and it is not the live one with a
             * clause deleted. A reader arriving at a record from last week needs a
             * different true statement: the proposal was made then, this is what it
             * said, and the way to act on a proposal is to have a live one. Leaving
             * the live copy in place would point at a link that is not on the page.
             */
            <>
              This is a <strong className="text-zinc-200">record of a past proposal</strong>,
              rebuilt from the permanent log. Its outcome — recorded or not — is stated above the
              proposal, and this view cannot change it. There is deliberately no create-bot link
              here: the path from a proposal to a bot runs through a live proposal and its own
              form, which runs every check it always runs (spec 21.1).
            </>
          )}
        </p>
      </header>

      {/*
       * ⚠ FIRST AMONG THE PANELS: the summary card.
       *
       * This position is a change, and the argument it overrules is worth keeping
       * visible rather than deleting. Until this step the concentration flag was
       * first, on spec 21.4's requirement that it be "presented prominently, not a
       * silent filter" — and prominence is a position as much as a colour.
       *
       * THAT REQUIREMENT IS NOT WEAKENED BY THIS, and the reason is mechanical
       * rather than a matter of emphasis: the card carries the REAL concentration
       * verdict as one of its two badges, computed by `concentrationVerdictOf` off
       * the same `ConcentrationResult.assessment` the banner reads, with a flagged
       * or unchecked result rendered as loudly as the banner renders it. So the
       * flag is now the FIRST thing on the page rather than the second, and the
       * banner below still carries every finding in full — the rule, the threshold,
       * the observed breakdown — which is the part a card must not try to
       * summarise.
       *
       * ⚠ AND THE CARD IS NOT ALLOWED TO BE THE ONLY PLACE IT APPEARS. If the card
       * ever stops rendering the verdict, the banner below is still there and still
       * first among the panels a reviewer scrolls to. The summary is a fast path,
       * not a replacement, and nothing below it was removed or shortened.
       */}
      {/*
       * ⚠ ITS OWN BOUNDARY, and this one is load-bearing rather than defensive.
       * The card is now the FIRST thing rendered and it holds the only control that
       * leads off this page. React's default on an uncaught render error is to
       * unmount the whole tree — which is what turned a single TypeError into a
       * blank black page during step 44's operator verification. A card that
       * throws must cost a reviewer the card, not the proposal.
       */}
      <ErrorBoundary where="The summary card">
        <ProposalSummaryCard derive={derive} offerCreateBot={offerCreateBot} />
      </ErrorBoundary>

      {/*
       * The over-concentration flag in full: every finding, with its rule, its
       * threshold and its observed breakdown. Spec 21.4's "presented prominently"
       * requirement is carried by this AND by the card's badge above.
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
        {offerCreateBot ? (
          <p>
            <strong className="text-zinc-400">The outcome is still unrecorded.</strong> Creating a
            bot through the link in the summary card carries <code>proposalId</code> in the{" "}
            <code>POST /api/bots</code> body for you, so the record says a human acted on it — but
            only on a real, completed creation. If you decide against it, post to{" "}
            <code>/api/proposals/{derive.proposalId}/reject</code>. A proposal nobody records a
            decision on counts as ignored, which is exactly the signal requirement 5 exists to
            measure. <strong className="text-zinc-400">This page itself stores nothing</strong> — if
            you close the tab this rendering is gone, though the record is not.
          </p>
        ) : (
          /*
           * ⚠ THE HISTORY VIEW MUST NOT SAY "THE OUTCOME IS STILL UNRECORDED", because
           * for a resolved record that is simply false, and it is the one sentence on
           * this page a reader would act on. The outcome is a fact the record holds and
           * the page above prints it; this footer says only what is true of the RENDERING.
           */
          <p>
            <strong className="text-zinc-400">This view changes nothing.</strong> It is a read of{" "}
            <code>GET /api/proposals/{derive.proposalId}</code>, which writes no row, no{" "}
            <code>audit_log</code> entry and no outcome. A proposal&rsquo;s outcome moves off{" "}
            <code>null</code> in exactly two places in this system — a real completed bot creation,
            and <code>POST /api/proposals/{derive.proposalId}/reject</code> — and neither is
            reachable from here.
          </p>
        )}
        {/*
         * ⚠ THE CREATE-BOT LINK USED TO BE HERE, LAST, AND IS NOW IN THE SUMMARY
         * CARD AT THE TOP. The comment that stood here argued the old position:
         * that the one control leading out of this page belonged below everything
         * a reviewer is meant to have read, because position is prominence.
         *
         * It is recorded rather than deleted because the argument was sound and
         * was not abandoned for convenience. What live use showed is that the
         * premise had stopped holding: the page runs 30+ printed pages, and a
         * reviewer who scrolls past all of it to reach a button has not read it
         * either — the distance was buying nothing. The reading requirement is
         * now carried by what the card DOES NOT show (no reasoning, no citations,
         * no evidence, and a footer that says so) rather than by how far the
         * button is from the top.
         *
         * ⚠ THERE IS EXACTLY ONE `ProposalCreateBotLink` ON THIS PAGE. Two would
         * be two places for the copy about "this is not an approve button" to
         * drift apart, and `proposal-summary-card.test.ts` pins the count.
         */}
      </footer>
    </article>
  );
}
