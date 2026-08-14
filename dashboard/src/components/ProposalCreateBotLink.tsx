/**
 * "Create a bot from this proposal" — the link, and everything it is careful NOT
 * to be.
 *
 * ── ⚠ THIS IS NOT AN APPROVE BUTTON, AND THE COPY ON IT SAYS SO ──
 *
 * Decision log 44 refused to build even a link toward this, on the grounds that
 * *"a one-click bridge from a proposal to a creation is the affordance that turns
 * 'the human approves' into a rubber stamp"*. Decision log 46 then settled the four
 * constraints that make a prefill something other than that bridge, and this
 * component is built to the fourth of them: a human must never be able to mistake
 * this for approval, or mistake the form it leads to for anything other than the
 * ordinary create-bot form.
 *
 * Four things follow, and each is a deliberate refusal of an easier design:
 *
 *  1. IT IS AN `<a>`, NOT A BUTTON WITH AN `onClick`. It navigates and nothing
 *     else. There is no handler, no state change, no request — this file imports
 *     nothing from `api/client` and cannot. A reviewer checking "does pressing
 *     this do anything" has one line of JSX to read.
 *  2. THE LABEL NAMES THE DESTINATION, NOT AN OUTCOME. "Open the create-bot form,
 *     pre-filled" — not "Approve", not "Create this bot", not "Accept". A verb
 *     that names a result is a promise this link does not keep.
 *  3. THE COPY BESIDE IT STATES THE THREE FACTS A HUMAN MIGHT OTHERWISE ASSUME:
 *     that the form runs every check it always runs, that every field is editable,
 *     and that nothing is recorded against this proposal until a bot is really
 *     created. All three are true, and all three are the sort of thing that is
 *     believed to be false in exactly the direction that makes people careless.
 *  4. IT REFUSES TO OFFER A LINK IT CANNOT BUILD HONESTLY. `createBotHref` returns
 *     null when the params object does not pass `checkParamsShape` — the same
 *     guard the parameters table above is gated on — and this renders the refusal
 *     in place rather than a link that would prefill fields with `undefined`.
 *
 * ── WHY IT LIVES IN `ProposalView` RATHER THAN ON EACH PAGE ──
 *
 * Two pages render a proposal: `/proposal` (pasted, decision log 44) and
 * `/proposal/run` (the trigger, decision log 46). Both render through the SAME
 * `ProposalView`, and entry 46 was explicit about why the trigger did not grow its
 * own renderer: *"a trigger that rendered its results its own way would be a second
 * proposal renderer, and the copy that drifts is the one nobody is watching."* The
 * same argument applies to the one control that leads out of a proposal.
 *
 * ⚠ THE SUMMARY CARD IS NOT BEING BUILT IN THIS STEP (entry 46 PART 6 defers it),
 * so this sits in the footer — the block whose existing job is already "what to do
 * about this proposal", where the text about `proposalId` and the reject endpoint
 * already is. When the summary card arrives, this moves into it; nothing else about
 * this component changes.
 */

import { Link } from "react-router-dom";
import type { DeriveResponse } from "../api/research-types";
import { createBotHref } from "../research/proposalPrefill";

export function ProposalCreateBotLink({ derive }: { derive: DeriveResponse }) {
  const href = createBotHref(derive);

  if (href === null) {
    /*
     * The same fault `ProposalParameters` renders above, at the same severity and
     * for the same reason: a params object whose fields disagree with its own
     * strategy label is not a proposal that can be acted on. Offering a link that
     * would fill the form with `undefined` is worse than offering none, and
     * offering none silently is worse than saying why.
     */
    return (
      <div role="alert" className="rounded-md border border-red-500/40 bg-red-500/5 px-3 py-2 text-xs text-red-200">
        <strong className="font-semibold">No pre-filled form is offered for this proposal.</strong>{" "}
        Its parameters do not match the strategy they are labelled with, so there is nothing
        coherent to put in a form — see the parameters section above for what is wrong. The
        create-bot form is still reachable on its own and can be filled in by hand.
      </div>
    );
  }

  return (
    <div className="rounded-md border border-zinc-700 bg-zinc-900/60 px-4 py-3">
      <Link
        to={href}
        className="inline-flex items-center gap-2 rounded-md border border-emerald-600/60 bg-emerald-600/10 px-4 py-2 text-sm font-semibold text-emerald-200 hover:bg-emerald-600/20"
      >
        Open the create-bot form, pre-filled →
      </Link>
      <p className="mt-2 text-xs leading-relaxed text-zinc-400">
        <strong className="text-zinc-300">This is not an approve button.</strong> It opens{" "}
        <em>the</em> create-bot form — the same one at <code>/bots/new</code>, with the same
        validation — carrying these values as its starting numbers.{" "}
        <strong className="text-zinc-300">Every field stays editable</strong>, and the form
        re-checks everything for itself against the account&rsquo;s state right now: the capital
        ledger, the venue&rsquo;s tradable list, the spot-instrument gate, the mandatory stop-loss.
        Values that were fine when this proposal was made can fail there, and that is the check
        working.
      </p>
      <p className="mt-1.5 text-xs leading-relaxed text-zinc-500">
        Opening it records <strong className="text-zinc-400">nothing</strong>. This proposal stays
        unresolved — <code>outcome</code> is still null — unless and until you actually submit that
        form and a real bot is created. Close the tab or walk away and nothing about this proposal
        changes.
      </p>
    </div>
  );
}
