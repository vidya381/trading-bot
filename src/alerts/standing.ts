/**
 * Standing alerts: one `alerts` row per OPEN INCIDENT, not one per detection.
 *
 * WHY THIS MODULE EXISTS AS A MODULE (step 20). The mechanism was built at step
 * 18 as two private functions inside `reconciliation/reconcile.ts`, which was
 * right while reconciliation was the only thing re-detecting a condition on a
 * schedule. Step 20 arms a 30-SECOND poll inside the `BotInstance` Durable
 * Object, so there is now a second such writer -- and at 30 seconds an
 * undeduplicated condition writes ~2,880 rows per bot per day, roughly 60x the
 * rate the 5-minute cron produced the measured 186-identical-criticals incident
 * at. Reimplementing the dedup in the Durable Object would have given the two
 * writers two lifecycles that could drift apart silently, which is the failure
 * mode `shared/alert-types.ts` already exists to prevent for the alert-type
 * FORMAT. This is the same discipline applied to the alert LIFECYCLE.
 *
 * WHY IT IS NOT IN `/src/shared`. That folder's contract is explicit -- nothing
 * in it performs I/O, reads a clock, or touches storage -- and `alert-types.ts`
 * earns its place there by being dependency-free so the DASHBOARD's separate
 * toolchain can compile it unchanged. This module writes D1 rows and takes a
 * `Database`. The boundary it crosses (a cron Worker and a Durable Object) is
 * inside one bundle and one toolchain, so that import costs nothing and the
 * dashboard never sees this file.
 *
 * ── The lifecycle, in two halves that must always be used together ──
 *
 * `raiseStandingAlert` writes at most one unresolved row per key.
 * `resolveClearedStandingAlerts` closes the rows whose condition did not recur.
 *
 * Taking only the first half is strictly WORSE than an unconditional insert:
 * one row that never clears, suppressing every future alert of that kind for
 * that bot, forever. Step 18 recorded that, and it is the reason both halves
 * live here rather than only the one a new caller happens to need first.
 *
 * ── The key, and why `source` is part of the query but not of the concept ──
 *
 * The incident key is `(alert_type, bot_instance_id)` -- deliberately the same
 * key the KV notification cooldown uses (`notifications/cooldown.ts`), so the
 * recording layer and the notifying layer agree on what "the same alert" is.
 * The MESSAGE is deliberately excluded: a re-detection whose wording drifts (a
 * run id, a changing quantity) is the same incident, and keying on text would
 * defeat the entire point.
 *
 * Both halves additionally scope to one `source`, and they scope IDENTICALLY.
 * That is not a second key; it is ownership. A writer may only close an incident
 * it was in a position to observe, so a writer that cannot resolve a row must
 * not dedup against it either -- otherwise it would suppress its own alert
 * behind a row it can never clear. Reconciliation's cron and the bot object's
 * poll therefore keep separate incident rows even in the (currently
 * non-existent) case of a shared `alert_type`.
 *
 * ── Nothing historical is lost, which is what makes any of this safe ──
 *
 * Every reconciliation run already writes its complete findings list to
 * `audit_log.details_json`, and the bot's poll audits every pass that moved
 * anything. The per-detection record still exists, in the table built for
 * history. `alerts` becomes what its own `resolved` column always implied: a
 * list of OPEN incidents, so that "how many unresolved criticals are there"
 * means something again.
 */

import type { Database } from "../db";
import type { AlertRow } from "../db/schema";
import type { Timestamp } from "../shared/exchange-client";

/** One standing condition, as its writer sees it. */
export interface StandingAlert {
  readonly alertType: string;
  /** null for an account-scoped incident that belongs to no single bot. */
  readonly botInstanceId: string | null;
  readonly severity: AlertRow["severity"];
  readonly category: AlertRow["category"];
  /** Which writer owns this incident. Scopes BOTH halves of the lifecycle. */
  readonly source: string;
  readonly message: string;
  readonly at: Timestamp;
}

/**
 * The incident key, spelled once.
 *
 * Used by the resolve half to compare "still found on this pass" against "open
 * in the table". A caller building this string by hand would be the same class
 * of duplicated-format bug `shared/alert-types.ts` closed.
 */
export function standingAlertKey(alertType: string, botInstanceId: string | null): string {
  return `${alertType}::${botInstanceId ?? ""}`;
}

/**
 * Raise a standing alert once per open incident.
 *
 * Returns whether a row was actually written, so a caller (and a test) can tell
 * "first detection" from "the same incident, seen again" without re-querying.
 *
 * THE NOTIFICATION COOLDOWN IS UNTOUCHED and remains a separate concern.
 * Section 10's KV cooldown throttles the outbound ping (15 minutes per alert
 * type per bot); it never governed row-writing, and `notifications/cooldown.ts`
 * says so. That layer keeps working exactly as before -- this only stops the
 * table itself from accumulating duplicates underneath it.
 */
export async function raiseStandingAlert(
  db: Database,
  newId: () => string,
  alert: StandingAlert,
): Promise<boolean> {
  const open = await db.alerts.findMany({
    where: {
      alert_type: alert.alertType,
      bot_instance_id: alert.botInstanceId,
      source: alert.source,
      resolved: false,
    },
    limit: 1,
  });
  if (open.length > 0) return false;

  await db.alerts.insert({
    id: newId(),
    severity: alert.severity,
    category: alert.category,
    alert_type: alert.alertType,
    bot_instance_id: alert.botInstanceId,
    source: alert.source,
    message: alert.message,
    resolved: false,
    created_at: alert.at,
    notified_at: null,
  } satisfies AlertRow);
  return true;
}

/** What one pass of a writer's own detection observed, for the resolve half. */
export interface StandingAlertPass {
  /** The `source` whose rows this pass may close. See the header on ownership. */
  readonly source: string;
  /**
   * Which alert types this writer is competent to open and close.
   *
   * Anything else with the same `source` is left alone: reconciliation's
   * `reconciliation_blind` and `reconciliation_halt_failed`, and the bot
   * object's own event-driven alerts, have their own lifecycles and are not
   * findings this pass re-derives.
   */
  readonly owns: (alertType: string) => boolean;
  /**
   * Incident keys (from `standingAlertKey`) this pass FOUND. Anything owned,
   * in scope, and absent from this set is closed.
   */
  readonly stillOpen: ReadonlySet<string>;
  /**
   * Whether this pass actually read the data its findings come from.
   *
   * SECTION 5.6 APPLIED TO THE ALERT LIFECYCLE, and the nastiest failure
   * available in this module. A pass that could not reach the exchange found
   * nothing because it SAW nothing; treating that as "resolved" would clear a
   * live incident on the strength of an outage. Passed in rather than inferred
   * from an empty findings list precisely because the two are indistinguishable
   * from here.
   */
  readonly observed: boolean;
  /**
   * Whether a row belongs to what this pass covered -- one account's bots, or
   * one bot. A row outside the pass's scope was not re-derived by it and its
   * absence from `stillOpen` means nothing.
   */
  readonly inScope: (botInstanceId: string | null) => boolean;
}

/**
 * Close the standing alerts whose condition did not recur on this pass.
 *
 * Returns the ids closed, so a caller can report or assert on them.
 */
export async function resolveClearedStandingAlerts(
  db: Database,
  pass: StandingAlertPass,
): Promise<string[]> {
  if (!pass.observed) return [];

  const open = await db.alerts.findMany({
    where: { source: pass.source, resolved: false },
  });

  const resolved: string[] = [];
  for (const row of open) {
    if (!pass.owns(row.alert_type)) continue;
    if (!pass.inScope(row.bot_instance_id)) continue;
    if (pass.stillOpen.has(standingAlertKey(row.alert_type, row.bot_instance_id))) continue;

    await db.alerts.update({ id: row.id }, { resolved: true });
    resolved.push(row.id);
  }
  return resolved;
}
