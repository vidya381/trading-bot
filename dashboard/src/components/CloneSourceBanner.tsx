/**
 * The banner on a create-bot form pre-filled by CLONING an existing bot.
 *
 * ── WHY A BANNER AT ALL ──
 *
 * The same reason `ProposalPrefillBanner` exists, minus the AI: a form whose boxes
 * are already full looks exactly like a form somebody filled in, and an operator
 * who does not know where the numbers came from cannot check them. So provenance
 * travels with the values or the values do not travel — `readBotClonePrefill`
 * refuses everything unless the source bot's id is in the URL, so there is no
 * reload, no new tab and no hand-edited link that can produce pre-filled numbers
 * with nothing over them saying why.
 *
 * ── ⚠ WHAT THIS BANNER SAYS THAT THE PROPOSAL ONE DOES NOT, AND VICE VERSA ──
 *
 * They are deliberately different, and the differences are the reason this is a
 * separate component rather than a mode of that one:
 *
 *   * NO STALENESS VERDICT, AND NONE IS IMPLIED. A proposal's numbers were derived
 *     from four dated fetches and can rot; the create-bot form has to say so. A
 *     bot's configuration has no such inputs — it is a configuration, not a
 *     derivation, and it is as valid now as when it was written. Printing an
 *     "age unknown" verdict here would invent a doubt that does not exist, which
 *     is the same failure in the opposite direction.
 *   * IT SAYS WHAT DOES *NOT* COME ACROSS. A clone copies configuration and
 *     nothing else, and the two things an operator is most likely to assume are
 *     carried — the source bot's history, and its capital — are exactly the two
 *     that are not. The allocation figure is copied as a NUMBER, but the capital
 *     is reserved fresh: an account with no headroom will have this submission
 *     refused, and an operator who reads "clone" as "share the same money" would
 *     be surprised by that in the wrong direction.
 *   * NOTHING IS RECORDED AGAINST THE SOURCE. A proposal has an `outcome` this
 *     form writes on submit. A bot has nothing of the sort: the source bot's id is
 *     shown here and is never sent anywhere.
 */

import { Link } from "react-router-dom";
import type { BotClonePrefill } from "../research/botClonePrefill";

export function CloneSourceBanner({
  prefill,
  /**
   * The strategy the form is CURRENTLY showing, which is not necessarily the
   * source bot's: the grid/DCA toggle is an ordinary editable control.
   *
   * ⚠ PASSED IN RATHER THAN ASSUMED, because the banner goes stale otherwise.
   * Switching the toggle mounts the other strategy's fieldset, whose inputs hold
   * the form's own empty defaults — the prefill carried one strategy's fields and
   * only one. A banner still reading "these values came from a bot" over a set of
   * boxes that came from nowhere is the belief this banner exists to prevent.
   */
  currentStrategy,
}: {
  prefill: BotClonePrefill;
  currentStrategy: "grid" | "dca";
}) {
  return (
    <section
      // `region` + a heading rather than `alert`: standing context for the whole
      // form, not an event. Matches `ProposalPrefillBanner`'s stance.
      aria-labelledby="clone-banner-heading"
      className="space-y-3 rounded-xl border border-sky-500/40 bg-sky-500/5 px-4 py-4"
    >
      <div>
        <h2 id="clone-banner-heading" className="text-sm font-semibold text-zinc-100">
          These values were copied from an existing bot. You did not type them.
        </h2>
        <p className="mt-1 text-xs leading-relaxed text-zinc-400">
          This is the ordinary create-bot form with different starting numbers.{" "}
          <strong className="text-zinc-300">Every field below is editable</strong>, and whatever is
          in the boxes when you submit is what gets built. All the usual checks run on submit,
          against this account&rsquo;s state right now: the capital ledger, the venue&rsquo;s
          tradable list, the spot-instrument gate and the mandatory stop-loss. A configuration that
          was accepted when the source bot was created can fail them now, and that refusal is the
          check working rather than a bug.
        </p>
      </div>

      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
        <dt className="text-zinc-500">Copied from</dt>
        <dd className="font-mono text-zinc-200">
          <Link to={`/bots/${prefill.sourceBotId}`} className="underline hover:text-sky-200">
            {prefill.sourceBotId}
          </Link>
        </dd>
        <dt className="text-zinc-500">Strategy</dt>
        <dd className="uppercase text-zinc-200">{prefill.strategy}</dd>
      </dl>

      <p className="border-t border-sky-500/20 pt-3 text-xs leading-relaxed text-zinc-400">
        <strong className="text-zinc-300">This is a new bot, not a copy of that one.</strong> It
        gets a fresh id (already filled in below and editable), an empty order, trade and alert
        history, and its own Durable Object. Nothing links the two afterwards, and{" "}
        <strong className="text-zinc-300">the source bot is not touched</strong> — it is not
        halted, not changed, and nothing is recorded against it.
      </p>

      <p className="border-t border-sky-500/20 pt-3 text-xs leading-relaxed text-zinc-400">
        <strong className="text-zinc-300">The allocated capital is copied as a number, not
        shared.</strong> Submitting reserves that amount again, on top of whatever the source bot
        still holds. If the account does not have it available, the form will be refused — which is
        the ledger doing its job. Change the figure before submitting if that is not what you want.
      </p>

      {currentStrategy !== prefill.strategy && (
        <p className="border-t border-amber-500/30 pt-3 text-xs leading-relaxed text-amber-100/90">
          <strong>You have switched this form to {currentStrategy.toUpperCase()}.</strong> The
          source bot is {prefill.strategy.toUpperCase()}, so <strong>none</strong> of the{" "}
          {currentStrategy.toUpperCase()} parameters below came from it — they are the form&rsquo;s
          own empty defaults and are yours to fill in. The shared fields (account, pair, capital)
          are still the source bot&rsquo;s unless you have changed them.
        </p>
      )}

      {prefill.incomplete.length > 0 && (
        <p className="border-t border-zinc-700 pt-3 text-xs text-amber-100/80">
          <strong>This link did not carry every value.</strong> These arrived missing or unreadable
          and the form is showing its own ordinary default for them, not the source bot&rsquo;s:{" "}
          <span className="font-mono">{prefill.incomplete.join(", ")}</span>. Check them against the
          source bot before submitting — nothing was guessed, but nothing was carried either.
        </p>
      )}

      {prefill.unrepresentable.length > 0 && (
        <p className="border-t border-amber-500/30 pt-3 text-xs leading-relaxed text-amber-100/90">
          <strong>This form cannot express part of that bot&rsquo;s configuration.</strong> These
          were carried in the link but have no control here, so the new bot will be created with
          the form&rsquo;s own value for them, not the source bot&rsquo;s:{" "}
          <span className="font-mono">{prefill.unrepresentable.join(", ")}</span>.
        </p>
      )}
    </section>
  );
}
