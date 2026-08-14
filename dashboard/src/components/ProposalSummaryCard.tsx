/**
 * THE SUMMARY CARD — the fast path over a page that is long on purpose.
 *
 * ── ⚠ THIS IS ADDITIVE, AND THE DISTINCTION IS THE WHOLE DESIGN ──
 *
 * Decision log 44 made this page long DELIBERATELY: every evidence item listed,
 * cited or not, nothing behind a collapsed toggle, because *what the model ignored
 * is visible only from the difference*. Decision log 48 PART 10 then recorded the
 * cost of that after real use — 30+ printed pages, and the one control that leads
 * out of it at the very bottom — and named a summary card as the answer while
 * stating plainly that **a summary card is in tension with entry 44's decision, not
 * merely additional to it.**
 *
 * The reconciliation is that THIS CARD REMOVES NOTHING. Below it, in the same order
 * as before, sit the concentration banner, the data-limits panel, the freshness
 * table, the citation legend, the strategy, the parameters and the complete
 * evidence tables. A reviewer who scrolls sees exactly what they saw before this
 * component existed. What the card adds is an answer to four questions they
 * currently reconstruct by scrolling — what was suggested, how big, is the data
 * current, is the account already concentrated — and a place to act from.
 *
 * ⚠ AND THE CARD SAYS SO ON ITS FACE. The footer sentence is not decoration: a
 * summary at the top of a page whose length is the point must state that it is one,
 * or it becomes the page for anyone in a hurry.
 *
 * ── WHY THE BUTTON MOVED HERE, AND WHAT DID NOT CHANGE WITH IT ──
 *
 * `ProposalCreateBotLink` is rendered here INSTEAD OF in the footer, and that is
 * the entire change to it. The component is imported unmodified: same file, same
 * `createBotHref(derive)`, same `<a>` with no handler, same refusal branch when the
 * params fail the shape check, same copy about what it does and does not do. The
 * pre-fill mechanism (decision log 48's URL search params), the AI-sourced banner on
 * the destination page, and the navigation-does-not-approve guarantee are all
 * properties of that component and of `proposalPrefill.ts`, and **none of them is a
 * property of where on the page it sits.**
 *
 * That file's own header predicted this move and pre-authorised exactly this much
 * of it: *"When the summary card arrives, this moves into it; nothing else about
 * this component changes."*
 *
 * ⚠ THE ARGUMENT FOR THE OLD POSITION IS REAL AND IS BEING OVERRULED ON EVIDENCE,
 * NOT FORGOTTEN. Entry 48 put the link last on the grounds that position is
 * prominence and it should sit *after everything a reviewer is meant to have read*.
 * What live use showed is that 30+ pages of scrolling is not a reading requirement,
 * it is an obstacle to the primary action — and a reviewer who scrolls past
 * everything to reach a button has not read it either. The reading requirement is
 * enforced by what the card DOES NOT say (it summarises no reasoning and no
 * evidence) and by the copy beside the link, not by the distance to it.
 *
 * ── ⚠ NO DECISION IS MADE IN THIS FILE ──
 *
 * Every verdict, number and label comes from `proposalSummary.ts`, which is
 * React-free and exhaustively tested, for the reason `proposalFields.ts` records: a
 * mutation run proved that a decision living in a `.tsx` is reachable by NO test in
 * this repository. This component maps over what it is given. The one thing it does
 * decide is layout, and layout is the operator's eyes.
 */

import { useEffect, useState } from "react";
import type { DeriveResponse } from "../api/research-types";
import {
  CONCENTRATION_BADGE,
  STALENESS_BADGE,
  summarize,
  type ProposalSummary,
} from "../proposalSummary";
import { ProposalCreateBotLink } from "./ProposalCreateBotLink";

/**
 * A 1s tick so the staleness badge stays true while a reviewer reads.
 *
 * The same tick `ProposalFreshness` and `ProposalPrefillBanner` already run, and for
 * decision log 48 PART 3's reason: the verdict is a function of time, and a proposal
 * that goes stale WHILE the card is on screen must say so.
 */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

function Badge({
  label,
  title,
  className,
}: {
  label: string;
  title: string;
  className: string;
}) {
  return (
    <span
      title={title}
      className={[
        "inline-flex shrink-0 items-center rounded border px-2 py-0.5 text-[11px] uppercase tracking-wide",
        className,
      ].join(" ")}
    >
      {label}
    </span>
  );
}

function HeadlineNumbers({ summary }: { summary: ProposalSummary }) {
  if (!summary.ok) {
    /*
     * The same refusal `ProposalParameters` and `ProposalCreateBotLink` make, at
     * the same severity, for the same reason: printing blanks for values that are
     * not there is how a malformed document comes to look like a half-specified
     * proposal. The card does not get a softer version of that rule for being at
     * the top.
     */
    return (
      <div
        role="alert"
        className="rounded border border-red-500/40 bg-red-500/5 px-3 py-2 text-xs text-red-200"
      >
        <strong className="font-semibold">No headline numbers can be shown.</strong> This
        proposal&rsquo;s parameters do not match the strategy they are labelled with (
        <code>{summary.claimedStrategy}</code>), so there is nothing coherent to summarise. The
        parameters section below states exactly what is wrong.
      </div>
    );
  }

  return (
    <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2 lg:grid-cols-4">
      {summary.headline.map((spec) => (
        <div key={spec.field}>
          <dt className="text-[11px] uppercase tracking-wide text-zinc-500">{spec.label}</dt>
          <dd className="tabular text-lg font-semibold text-zinc-100">{spec.value}</dd>
        </div>
      ))}
      {/*
       * Capital last of the four and visually identical to the rest, deliberately.
       * It is the one number denominated in real money the account holds, and
       * `ProposalParameters` already states the necessary correction beside it:
       * it is a PREFILL a human confirms, not a reservation. The hint carries here
       * too rather than being dropped for space.
       */}
      <div>
        <dt className="text-[11px] uppercase tracking-wide text-zinc-500">
          Allocated capital
        </dt>
        <dd className="tabular text-lg font-semibold text-zinc-100">{summary.allocatedCapital}</dd>
        <dd className="text-[11px] text-zinc-600">suggested — nothing is allocated</dd>
      </div>
    </dl>
  );
}

export function ProposalSummaryCard({ derive }: { derive: DeriveResponse }) {
  const now = useNow();
  const summary = summarize(derive, now);
  const candidate = derive.bundle.candidate;

  const concentration = CONCENTRATION_BADGE[summary.concentration];
  const staleness = STALENESS_BADGE[summary.staleness];

  return (
    <section
      aria-label="Proposal summary"
      className="overflow-hidden rounded-lg border border-zinc-700 bg-zinc-900/70"
    >
      <div className="space-y-4 px-4 py-4">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          {/*
           * The strategy badge, from the CHECKED value where there is one. A
           * `claimedStrategy` is rendered only when the shape check failed, and the
           * refusal block below says so — the same discipline `ProposalParameters`
           * keeps about never re-reading `params.strategy` raw.
           */}
          <span className="rounded bg-zinc-100 px-2.5 py-1 text-sm font-bold uppercase tracking-wide text-zinc-900">
            {summary.strategy ?? summary.claimedStrategy}
          </span>
          <span className="tabular text-sm text-zinc-300">{candidate.pair}</span>
          <span className="text-xs text-zinc-500">
            {candidate.accountLabel} on {candidate.exchange}
          </span>
          <div className="flex flex-wrap items-center gap-2">
            <Badge {...concentration} />
            <Badge {...staleness} />
          </div>
        </div>

        <HeadlineNumbers summary={summary} />

        {/*
         * ⚠ THE RELOCATED CONTROL. Decision log 48 built this; this step changed
         * only where it is rendered. See this file's header — the pre-fill
         * mechanism, the destination banner and the navigation-does-not-approve
         * guarantee are properties of the component and of `proposalPrefill.ts`,
         * not of its position, and the component itself is imported unmodified.
         */}
        <ProposalCreateBotLink derive={derive} />
      </div>

      <p className="border-t border-zinc-800 bg-zinc-950/40 px-4 py-2.5 text-xs text-zinc-500">
        <strong className="text-zinc-400">This is a summary, not the proposal.</strong> It shows{" "}
        {summary.ok ? summary.headline.length : 0} of the parameters and none of the reasoning,
        the citations or the evidence. The two badges are the real verdicts, computed from the same
        logic as the panels below — but a verdict is not its reasons, and the full concentration
        findings, the data limits, every timestamp and every evidence item both stages were offered
        are all below, unchanged. Nothing has been created or modified by viewing this.
      </p>
    </section>
  );
}
