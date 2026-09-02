/**
 * "Clone this bot" — the link on the bot detail page.
 *
 * ── IT RENDERS FOR EVERY BOT, WHATEVER ITS STATUS ──
 *
 * ⚠ NO STATUS GATE, DELIBERATELY, AND THIS IS THE ONE CONTROL ON THIS PAGE THAT
 * HAS NONE. Every other action here is gated because it DOES something to this
 * bot: start, halt, resume, liquidate and archive all change its state, so
 * offering them when they cannot apply would be offering a button that can only
 * fail. This one changes nothing about this bot at all — it reads its
 * configuration and navigates. A stopped bot's config is as copyable as a running
 * one's, and the moment an operator most wants to run "another one like that" is
 * usually just after watching one finish. Gating on status would remove the
 * feature exactly when it is most useful, for no safety gained.
 *
 * ── IT IS AN `<a>`, NOT A BUTTON ──
 *
 * It navigates and nothing else. There is no handler, no state change, no
 * request: this file imports nothing from `api/client` and cannot, and
 * `prefill-does-not-approve.test.ts` holds it to that over source. The source bot
 * is never written to, and the create-bot form it leads to is the ordinary one at
 * `/bots/new` with every check intact.
 *
 * ── THE ONE CASE IT CANNOT OFFER A LINK FOR, AND WHY IT SAYS SO ──
 *
 * `cloneBotHref` returns null when the bot's Durable Object holds no config (an
 * orphan) or when the stored params do not match their own strategy label. That is
 * not a status gate — it is "there is nothing here to copy". `LiquidateAction`'s
 * rule is "if it's not a valid action, don't render it", and this deliberately
 * breaks that rule the way `ArchiveAction`'s held-position case does: an operator
 * who expects a Clone control on every bot and finds nothing on one of them reads
 * it as a broken page. The reason is stated instead.
 */

import { Link } from "react-router-dom";
import type { BotDetail } from "../api/types";
import { cloneBotHref, cloneRefusal, type CloneRefusal } from "../research/botClonePrefill";
import { strategyLabel } from "../strategyView";

/**
 * ⚠ THE THIRD REASON IS THE POINT, AND ITS ABSENCE WAS LIVE ON `bot-ts1`.
 * The component used to infer the reason from `bot.config === null`, so every
 * non-orphan refusal claimed the bot's parameters were incoherent — including a
 * trailing-stop bot whose parameters are exactly right and which simply has no
 * form to be built in. `cloneRefusal` decides; this only words it.
 */
function refusalText(reason: CloneRefusal, bot: BotDetail) {
  switch (reason) {
    case "no_config":
      return (
        <>
          This bot cannot be cloned, because there is no configuration to copy. Its row exists but
          its object holds no state, so the parameters a new bot would start from are not recorded
          anywhere.
        </>
      );
    case "incoherent_config":
      return (
        <>
          This bot cannot be cloned, because there is no configuration to copy. Its stored
          parameters do not match the strategy they are labelled with, so there is nothing
          coherent to put in a form.
        </>
      );
    case "strategy_not_creatable":
      return (
        <>
          This bot cannot be cloned yet, and{" "}
          <strong className="text-zinc-300">its configuration is fine</strong> — the create-bot
          form simply has no controls for the{" "}
          <span className="font-medium">{strategyLabel(bot.strategy)}</span> strategy, so there is
          nowhere to put the values. Nothing is wrong with this bot.
        </>
      );
  }
}

export function CloneBotLink({ bot }: { bot: BotDetail }) {
  const href = cloneBotHref(bot);
  const reason = cloneRefusal(bot);

  if (href === null || reason !== null) {
    return (
      <section className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-5">
        <h2 className="text-base font-semibold text-zinc-200">Clone</h2>
        <p className="mt-2 text-sm leading-relaxed text-zinc-400">
          {/* `?? "incoherent_config"` is unreachable: `cloneBotHref` is null for
              exactly the cases `cloneRefusal` names. Written rather than
              asserted so the narrowing is the compiler's. */}
          {refusalText(reason ?? "incoherent_config", bot)}{" "}
          The create-bot form is still reachable on its own and can be filled in by hand.
        </p>
      </section>
    );
  }

  return (
    <section className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-5">
      <h2 className="text-base font-semibold text-zinc-200">Clone</h2>
      <Link
        to={href}
        className="mt-3 inline-flex items-center gap-2 rounded-md border border-sky-600/60 bg-sky-600/10 px-4 py-2 text-sm font-semibold text-sky-200 hover:bg-sky-600/20"
      >
        Open the create-bot form, pre-filled from this bot →
      </Link>
      <p className="mt-2 text-xs leading-relaxed text-zinc-400">
        <strong className="text-zinc-300">This creates nothing and changes nothing here.</strong>{" "}
        It opens <em>the</em> create-bot form — the same one at <code>/bots/new</code>, with the
        same validation — carrying this bot&rsquo;s current configuration as its starting values,
        including its allocated capital.{" "}
        <strong className="text-zinc-300">Every field stays editable</strong> before you submit,
        and the form re-checks everything against the account&rsquo;s state right now: the capital
        ledger, the venue&rsquo;s tradable list, the mandatory stop-loss.
      </p>
      <p className="mt-1.5 text-xs leading-relaxed text-zinc-500">
        The new bot gets its own id, its own empty history and its own capital reservation. This
        bot is only read from — nothing links the two afterwards, and{" "}
        <strong className="text-zinc-400">its allocation is not shared</strong>: the clone reserves
        its own capital on top, which the form&rsquo;s availability check will refuse if the
        account does not have it.
      </p>
    </section>
  );
}
