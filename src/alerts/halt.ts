/**
 * Closing a bot's halt alerts when the bot successfully resumes.
 *
 * ── The bug this closes ──
 *
 * `#halt` writes one `halt_{reason}` row through `#alert` -- an unconditional
 * insert, correctly, because a halt is a discrete EVENT and one row per halt is
 * exactly right. Nothing ever set `resolved` on it. So a bot halted on a rejected
 * order, fixed, and resumed left a `critical` row standing open forever,
 * describing a condition that had stopped applying the moment someone clicked
 * resume. "How many unresolved criticals are there" -- the number step 18 went to
 * some trouble to make meaningful again -- drifted upward by one per halt, and
 * every one of them was history.
 *
 * This is the same shape as step 16's bug 3, one layer out. That fixed
 * `bot_instances.halt_reason`, a CURRENT-STATE column that kept advertising a
 * resolved failure on a running bot; the alert ROW for the same halt was left
 * behind. 16 identified the shape and fixed one instance of it.
 *
 * ── Why this is not `resolveClearedStandingAlerts` ──
 *
 * The obvious move is to reuse the resolve half of `standing.ts` with an empty
 * `stillOpen`, and it would produce the right rows. It is still the wrong call.
 *
 * That function resolves what a DETECTION PASS looked for and did not find, and
 * its `observed` flag is the guard on the nastiest failure in that module: a pass
 * that could not reach the exchange found nothing because it SAW nothing, and
 * closing live incidents on the strength of an outage is section 5.6's exact
 * prohibition. A resume observes nothing and re-derives nothing -- it is a state
 * TRANSITION, not a pass -- so it would have to pass `observed: true` and mean
 * something different by it. One caller lying about that flag is how it stops
 * being a guard for everybody.
 *
 * The queries differ too, in a way that follows from the same distinction.
 * `standing.ts` reads every open row for a `source` and filters in memory,
 * because a cron pass legitimately spans an account's bots. This closes rows for
 * ONE bot, named up front, so the bot is part of the query.
 *
 * What it deliberately keeps from that module is the `source` scope: a writer may
 * only close an incident it was in a position to observe. The bot object owns its
 * own `halt_*` rows and nothing else's.
 *
 * ── Which rows this closes, and which it must not ──
 *
 * EVERY open `halt_*` row for the bot, not just the halt this resume ends. The
 * bot is `running` again; by definition no halt is current, so every open halt
 * row for it describes a past state. It also clears rows left by halts that
 * predate this fix, which the alternative -- matching the episode by re-parsing
 * `halt_{reason}` back out of `halt_reason`'s `"{reason}: {detail}"` text --
 * would strand permanently while reintroducing the hand-built format
 * `shared/alert-types.ts` exists to end.
 *
 * NOTHING ELSE ON THE BOT, and the exclusions are the point of the alert-type
 * filter:
 *
 *  - `cancel_failed` looks halt-adjacent -- it is raised BY the halt path -- and
 *    is the sharpest example of why "the bot resumed" is not "the problem went
 *    away". It means an order may still be live on the exchange. Resuming does
 *    not cancel it, and reconciliation already owns the row through
 *    `INGESTED_ALERT_TYPES`.
 *  - `poll_blind`, `poll_blind_escalated`, `price_updates_stale`,
 *    `unattributable_fill`, `grid_replacement_queued` are standing alerts owned
 *    by the poll's own resolve half. Closing them here would give one row two
 *    owners, which is the drift `/src/alerts` exists to prevent.
 *  - `order_state_drift` is reconciliation's, ingested.
 *  - `price_feed_fanout_failed` and `price_feed_subscriber_pruned` are the
 *    `PriceFeed` object's, under its own `source`. These USED to be excluded
 *    twice over -- by `source` and by carrying a null `bot_instance_id`. The
 *    second exclusion is gone: the feed now attributes them to the failing bot,
 *    so they DO appear on that bot's detail page and in a query by bot id. The
 *    `source` filter below is what still keeps them out of a resume's sweep, and
 *    it is now load-bearing on its own. `isHaltAlertType` excludes them a second
 *    time regardless, since neither starts with `halt_`.
 */

import type { Database } from "../db";
import { isHaltAlertType } from "../shared/alert-types";

/** Whose halt alerts, and which writer's. Both halves of the scope. */
export interface HaltAlertScope {
  /** The writer that owns these rows. See the header on ownership. */
  readonly source: string;
  /**
   * The bot that resumed. Never null: an account-scoped incident belongs to no
   * bot's lifecycle and no bot's resume may close it.
   */
  readonly botInstanceId: string;
}

/**
 * Resolve every open halt alert for one bot.
 *
 * Returns the ids closed, so the caller can record them in the resume's own
 * audit entry -- the same reason `resolveClearedStandingAlerts` returns them.
 */
export async function resolveHaltAlerts(db: Database, scope: HaltAlertScope): Promise<string[]> {
  const open = await db.alerts.findMany({
    where: {
      source: scope.source,
      bot_instance_id: scope.botInstanceId,
      resolved: false,
    },
  });

  const resolved: string[] = [];
  for (const row of open) {
    if (!isHaltAlertType(row.alert_type)) continue;
    await db.alerts.update({ id: row.id }, { resolved: true });
    resolved.push(row.id);
  }
  return resolved;
}
