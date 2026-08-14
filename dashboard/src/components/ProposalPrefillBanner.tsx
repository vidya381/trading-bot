/**
 * The banner on a PRE-FILLED create-bot form: where these numbers came from, when,
 * and whether the data behind them has gone stale since.
 *
 * ── WHY THIS EXISTS AT ALL ──
 *
 * Decision log 46 settled it as a hard constraint before any of this was built:
 * *"A visible AI-sourced banner is required on the form when it has been prefilled,
 * so nobody reviews model output believing they typed it."* That is the whole job.
 * A form whose boxes are already full looks exactly like a form somebody filled
 * in, and the difference between those two situations is the difference between a
 * human decision and a rubber stamp.
 *
 * ── WHAT IT SAYS, AND WHY EACH PART IS NOT OPTIONAL ──
 *
 *  1. THAT IT IS MODEL OUTPUT. First line, plain words, no euphemism.
 *  2. WHICH PROPOSAL — the real `proposalId` of the permanent record (migration
 *     0009). Not decoration: it is the id the reviewer needs to look the reasoning
 *     up, to reject this instead, or to trace a bad outcome back afterwards, and
 *     it is the id this form will send on submit.
 *  3. WHEN IT WAS MADE, labelled as the derive call's own `selectedAt` and NOT as
 *     a fetch time. `proposal.ts` keeps that distinction with a separate type and
 *     `serialize.ts` states it at each field; restating it here rather than
 *     printing one confident timestamp is the same discipline.
 *  4. THE STALENESS VERDICT, computed NOW, from the real fetch times.
 *  5. ANYTHING THE PREFILL COULD NOT CARRY.
 *
 * ── ⚠ THE STALENESS VERDICT IS THE REASON THIS IS A BANNER AND NOT A CAPTION ──
 *
 * A proposal flagged STALE on the proposal page must not arrive here looking
 * fresh. It cannot: `prefillStaleness` runs the BACKEND's own `stalenessOf` over
 * the four `{key, at, thresholdMs}` triples the proposal page paired, against this
 * browser's clock. Ages only increase, so a stale proposal is still stale here —
 * and a proposal that was fresh when the link was pressed and goes stale while the
 * form is being filled in gets flagged here too, which is the case decision log 45
 * actually observed happening (a control file that went stale by the passage of
 * real time while the operator worked, re-flagged unprompted). Nothing about the
 * policy, the thresholds or the comparison is decided or copied in this file.
 *
 * ⚠ AND IT IS STILL NOT A GATE. `ProposalFreshness` says the same thing on the
 * proposal page and it is worth repeating here, on the screen that actually
 * commits capital: a stale verdict flags and instructs. It disables nothing, and
 * nothing here refuses a submit. The binding checks are the server's — the
 * capital ledger's compare-and-swap, the tradability gate, the decoders — and they
 * run on this form's submission unchanged whatever colour this banner is. A UI
 * threshold that blocked would be a second, weaker risk control sitting in front
 * of the real ones.
 */

import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { fetchLabel, formatAge, refreshAdvice } from "../proposal";
import type { StalenessVerdict } from "../../../src/research/staleness";
import { prefillStaleness, type ProposalPrefill } from "../research/proposalPrefill";
import { formatDateTime } from "../format";

/** A 1s tick, so an age on screen stays true while a form is being filled in. */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

/**
 * Words as well as colour, for `ProposalCitations`' reason: a distinction a
 * colour-blind reviewer cannot make is the same as no distinction. The three
 * states and their wording match `ProposalFreshness` exactly, so a reviewer reads
 * the same verdict in the same words on both screens.
 */
const VERDICT: Readonly<
  Record<StalenessVerdict, { readonly label: string; readonly box: string }>
> = {
  fresh: {
    label: "data still within its thresholds",
    box: "border-zinc-700 bg-zinc-900/60",
  },
  stale: {
    label: "STALE",
    box: "border-amber-500/60 bg-amber-500/10",
  },
  unknown: {
    label: "age unknown",
    box: "border-amber-500/30 bg-amber-500/5",
  },
};

export function ProposalPrefillBanner({
  prefill,
  /**
   * The strategy the form is CURRENTLY showing, which is not necessarily the
   * proposal's: the grid/DCA toggle is an ordinary editable control and switching
   * it is a legitimate thing to do.
   *
   * ⚠ IT IS PASSED IN RATHER THAN ASSUMED, BECAUSE THE BANNER GOES STALE OTHERWISE.
   * Switching the toggle mounts the other strategy's fieldset, whose inputs hold
   * the form's own empty defaults -- the prefill carried one strategy's fields and
   * only one. A banner still reading "these values came from a proposal" over a set
   * of boxes that came from nowhere is precisely the belief this banner exists to
   * prevent, so the mismatch is stated instead.
   */
  currentStrategy,
}: {
  prefill: ProposalPrefill;
  currentStrategy: "grid" | "dca";
}) {
  const now = useNow();
  // The backend's own comparison, over the triples the proposal page paired.
  const staleness = prefillStaleness(prefill, now);
  const style = VERDICT[staleness.verdict];

  return (
    <section
      // `region` + a heading rather than `alert`: this is standing context for the
      // whole form, not an event. The STALE case is loud by colour and wording,
      // which is what `ProposalFreshness` does for the same verdict.
      aria-labelledby="prefill-banner-heading"
      className={`space-y-3 rounded-xl border px-4 py-4 ${style.box}`}
    >
      <div>
        <h2 id="prefill-banner-heading" className="text-sm font-semibold text-zinc-100">
          These values came from an AI-generated proposal. You did not type them.
        </h2>
        <p className="mt-1 text-xs leading-relaxed text-zinc-400">
          This is the ordinary create-bot form with different starting numbers.{" "}
          <strong className="text-zinc-300">Every field below is editable</strong>, and whatever is
          in the boxes when you submit is what gets built — the proposal supplies nothing to the
          server. All the usual checks run on submit, against this account&rsquo;s state right now:
          the capital ledger, the venue&rsquo;s tradable list, the spot-instrument gate and the
          mandatory stop-loss. A proposal that was valid when it was made can fail them now, and
          that refusal is the check working rather than a bug.
        </p>
      </div>

      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
        <dt className="text-zinc-500">Proposal</dt>
        <dd className="tabular font-mono text-zinc-200">{prefill.proposalId}</dd>
        <dt className="text-zinc-500">Strategy</dt>
        <dd className="uppercase text-zinc-200">{prefill.strategy}</dd>
        <dt className="text-zinc-500">Proposal made</dt>
        <dd className="text-zinc-200">
          {prefill.generatedAt === null ? (
            <span className="text-amber-300">not recorded in this link</span>
          ) : (
            <>
              <span className="tabular">{formatAge(now - prefill.generatedAt)} ago</span>
              <span className="tabular text-zinc-500"> · {formatDateTime(prefill.generatedAt)}</span>
              {/*
               * ⚠ NAMED FOR WHAT IT IS. `selectedAt` is when the derive call
               * resolved this pair to a candidate -- the start of the call that
               * produced the proposal. It is NOT when any of the data was
               * fetched; those four times are below, and they are what the
               * verdict is computed from.
               */}
              <div className="text-zinc-600">
                when the derive request started (<code>selectedAt</code>) — not a data fetch time
              </div>
            </>
          )}
        </dd>
        <dt className="text-zinc-500">Data age</dt>
        <dd className={staleness.verdict === "fresh" ? "text-emerald-300" : "font-semibold text-amber-300"}>
          {style.label}
        </dd>
      </dl>

      {/*
       * The stale and unknown inputs, named individually with their own
       * thresholds and their own refresh instruction. "This is stale" without
       * saying WHICH input sends a reviewer to check all four -- the argument
       * ProposalFreshness makes for its per-row verdicts, and it matters more
       * here because this is the screen where the money moves.
       */}
      {staleness.staleInputs.length > 0 && (
        <ul className="space-y-1.5 border-t border-amber-500/20 pt-3 text-xs text-amber-100/90">
          {staleness.staleInputs.map((input) => (
            <li key={input.key}>
              <span className="font-medium">{fetchLabel(input.key)}</span> is{" "}
              <span className="tabular">{formatAge(input.ageMs ?? 0)}</span> old, past its{" "}
              <span className="tabular">{formatAge(input.thresholdMs)}</span> threshold.{" "}
              {refreshAdvice(input)}
            </li>
          ))}
        </ul>
      )}

      {staleness.unknownInputs.length > 0 && (
        <p className="border-t border-amber-500/20 pt-3 text-xs text-amber-100/80">
          {staleness.unknownInputs.map((input) => fetchLabel(input.key)).join(", ")} produced no
          fetch time, so there is no age to compare against a threshold.{" "}
          <strong>That is not the same as being fresh.</strong>
        </p>
      )}

      {currentStrategy !== prefill.strategy && (
        <p className="border-t border-amber-500/20 pt-3 text-xs leading-relaxed text-amber-100/90">
          <strong>You have switched this form to {currentStrategy.toUpperCase()}.</strong> This is a{" "}
          {prefill.strategy.toUpperCase()} proposal, so <strong>none</strong> of the{" "}
          {currentStrategy.toUpperCase()} parameters below came from it — they are the form&rsquo;s
          own empty defaults and are yours to fill in. The shared fields (account, pair, capital)
          are still the proposal&rsquo;s unless you have changed them. Submitting will still record
          this proposal as approved, because you reached the form from it — that is what the link
          records, not that you kept its numbers.
        </p>
      )}

      {prefill.incomplete.length > 0 && (
        <p className="border-t border-zinc-700 pt-3 text-xs text-amber-100/80">
          <strong>This link did not carry every value.</strong> These arrived missing or unreadable
          and the form is showing its own ordinary default for them, not the proposal&rsquo;s:{" "}
          <span className="font-mono">{prefill.incomplete.join(", ")}</span>. Check them against the
          proposal before submitting — nothing was guessed, but nothing was carried either.
        </p>
      )}

      {prefill.unrepresentable.length > 0 && (
        <p className="border-t border-amber-500/20 pt-3 text-xs text-amber-100/90">
          <strong>This form cannot express part of this proposal.</strong>{" "}
          <span className="font-mono">{prefill.unrepresentable.join(", ")}</span> was proposed with
          a value this form has no control for, so it is being submitted at the form&rsquo;s own
          fixed value. Do not submit this without understanding the difference.
        </p>
      )}

      <p className="border-t border-zinc-700 pt-3 text-[11px] leading-relaxed text-zinc-500">
        Nothing has been recorded against this proposal yet. Its <code>outcome</code> is still
        null, and it stays null if you leave this page, close the tab, or change your mind — it is
        set only when a bot is really created from this form.{" "}
        <Link to="/proposal" className="underline underline-offset-2 hover:text-zinc-300">
          Re-read the full proposal
        </Link>{" "}
        by pasting the saved response, or re-run it to get fresh data. The staleness thresholds
        behind the verdict above are policy choices with no backtest behind them
        (<code>src/research/staleness.ts</code>); they flag, and they block nothing.
      </p>
    </section>
  );
}
