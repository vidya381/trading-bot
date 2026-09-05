/**
 * The amber band on a bot whose books moved AFTER it halted.
 *
 * ── ⚠ WHY IT IS NOT THE HALT BANNER, AND MUST NEVER LOOK LIKE IT ──
 *
 * `BotSummary` renders a RED band directly above this one carrying
 * `bot.haltReason`. That is the primary, safety-relevant fact: why the bot
 * stopped. This band is a different kind of thing and the two are deliberately
 * unmistakable:
 *
 *   RED   -- why this bot is halted. The first reason wins and is never
 *            overwritten by anything that happens afterwards.
 *   AMBER -- and then this happened underneath it.
 *
 * The colours are not a choice made here. `AlertList.tsx` fixes the dashboard's
 * severity vocabulary -- info sky, warning amber, critical red -- and the backend
 * raises the matching `post_halt_activity` row at `warning`. Amber is that
 * severity rendered consistently, not a new convention.
 *
 * ── WHY IT EXISTS AT ALL ──
 *
 * The backend records these events and deliberately writes NOTHING to the bot
 * row: no status change, no new halt reason, no `updated_at`. That is correct --
 * the earlier halt reason stays primary -- and it means that on every other field
 * this screen can see, a bot whose take-profit filled days after halting looks
 * exactly like one that has sat untouched. This band is the only thing that says
 * otherwise, which is why it is here and in the list rather than buried in the
 * detail view's raw `state`.
 *
 * ── ⚠ THE AUDIT ID IS SHOWN, NOT LINKED, AND THAT IS DELIBERATE ──
 *
 * The alert id links: that row is in this very page's `AlertList`, at
 * `alertRowAnchor(...)`, the same arrangement `APPLY_MISSED_FILLS_ANCHOR` uses.
 * The audit id does NOT link, because THIS DASHBOARD HAS NO AUDIT-LOG SCREEN --
 * `App.tsx` has no such route. A link to a page that does not exist would be the
 * silent-gap-on-a-correction-surface failure this project refuses everywhere
 * else, so the id is rendered as text an operator can copy into a query, with the
 * table named beside it.
 *
 * ── WHAT THIS COMPONENT DECIDES ──
 *
 * Nothing. Every verdict, label, count and pluralisation comes from
 * `postHaltNotice` in `../postHaltEvents`, which is React-free and tested. This
 * file places strings. See `docs/open-items/component-test-harness.md` for why
 * that split is not optional here.
 */

import { alertRowAnchor, postHaltNotice } from "../postHaltEvents";
import type { Bot } from "../api/types";
import { formatMoney, formatTime } from "../format";
import { Unit } from "./Unit";

export function PostHaltNotice({ bot }: { bot: Bot }) {
  const notice = postHaltNotice(bot);
  if (notice === null) return null;

  return (
    <section
      // `region` + a heading rather than `alert`: standing context about the
      // bot's history, not an event firing now. Matches `CloneSourceBanner` and
      // `ProposalPrefillBanner`.
      aria-labelledby="post-halt-heading"
      className="space-y-3 rounded-lg border border-amber-500/30 bg-amber-500/5 px-4 py-3"
    >
      <div>
        <h2 id="post-halt-heading" className="text-sm font-semibold text-amber-200">
          {notice.heading}
        </h2>
        <p className="mt-1 text-xs leading-relaxed text-zinc-400">
          The halt reason above is unchanged, deliberately &mdash; the first reason a bot stopped
          stays the one you see. These landed afterwards, on orders that were still resting when it
          halted.{" "}
          <strong className="text-zinc-300">The money below is real and already booked.</strong> The
          transition each one would normally have triggered is not: nothing restarted, and nothing
          will without you.
        </p>
      </div>

      {notice.staleForStatus && (
        <p className="rounded border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs leading-relaxed text-amber-100/90">
          <strong>This bot is {bot.status}, not halted, and these are still attached to it.</strong>{" "}
          Resuming clears them, so either this page is showing a reading from before that happened,
          or the two stores disagree. Reload before acting on what is below.
        </p>
      )}

      <ul className="space-y-3">
        {notice.items.map((item) => (
          <li
            key={item.alertId}
            className="border-l-2 border-amber-500/50 pl-3 text-xs leading-relaxed"
          >
            <div className="font-medium text-zinc-200">
              {item.label}
              <span className="ml-2 font-normal text-zinc-500">{formatTime(item.at)}</span>
            </div>

            {item.grossProfit !== null && (
              <div className="tabular mt-1 text-zinc-300">
                Booked{" "}
                <span className="font-semibold text-emerald-300">
                  {formatMoney(item.grossProfit)}
                  <Unit>{item.capitalAsset}</Unit>
                </span>{" "}
                <span className="text-zinc-500">
                  gross, on {item.clientOrderId} &mdash; already in this bot&rsquo;s realized total.
                </span>
              </div>
            )}

            {/* THE COUNTERFACTUAL, kept visually apart from the figure above it.
                One is what happened; the other is what did not. */}
            <div className="mt-1 text-zinc-400">
              <span className="text-zinc-500">Did not happen:</span> {item.suppressed}.
            </div>

            {item.haltReasonAtTime !== null && (
              <div className="mt-1 text-zinc-500">
                It landed under: <span className="text-zinc-400">{item.haltReasonAtTime}</span>
              </div>
            )}

            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-zinc-500">
              <a
                href={`#${alertRowAnchor(item.alertId)}`}
                className="underline underline-offset-2 hover:text-amber-200"
              >
                See the alert below
              </a>
              {/* Text, not a link. There is no audit screen to link to. */}
              <span title="audit_log.id — query the audit_log table with this id.">
                audit_log <span className="tabular text-zinc-400">{item.auditId}</span>
              </span>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
