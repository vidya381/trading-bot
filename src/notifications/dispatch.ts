/**
 * The notification dispatcher (spec section 10, step 8).
 *
 * Reads alert rows that have not yet been processed for notification, and for
 * each one decides -- under the KV cooldown -- whether to send a ping. This is
 * the "one place responsible" for turning recorded alerts into outbound
 * notifications, for every alert source at once (the BotInstance Durable
 * Object, reconciliation, the circuit breaker). It is deliberately NOT wired
 * inline at each write site:
 *
 *   - Section 10 makes recording and notifying two separate concerns. The
 *     alert row is the authoritative record and is already written by the
 *     pipeline that raised it. The ping is a downstream projection of that
 *     record, and this is the pipeline for the projection.
 *   - Alerts are raised from two execution contexts. A table-reading
 *     dispatcher is agnostic to who wrote the row; inline sending would thread
 *     a notifier and KV into three files.
 *   - An outbound webhook POST must never sit on the BotInstance halt path,
 *     where speed is a safety property (step 3.1). The protective action stays
 *     synchronous; only the human ping is deferred to here.
 *
 * Like `/src/reconciliation`, this module takes every dependency as a
 * parameter and knows nothing about bindings or crons. The worker shell in
 * `/src/workers/notifications.ts` supplies the real database, notifier, KV and
 * clock; a test supplies fakes.
 */

import type { AlertRow, Database } from "../db";
import { cooldownKey, DEFAULT_COOLDOWN_MS, type CooldownStore } from "./cooldown";
import type { AlertNotifier, NotifiableAlert, NotifyResult } from "./notifier";

export interface DispatchPorts {
  readonly db: Database;
  readonly notifier: AlertNotifier;
  readonly cooldown: CooldownStore;
  /** Ms since epoch. One value is taken for the whole run. */
  readonly now: () => number;
  /** Cooldown window; defaults to section 10's 15 minutes. */
  readonly windowMs?: number;
  /**
   * Safety bound on rows scanned per run, so a large backlog cannot make one
   * invocation run unbounded. The rest are picked up on the next tick.
   */
  readonly limit?: number;
}

export interface DispatchResult {
  /** Rows that were un-notified at the start of this run. */
  readonly scanned: number;
  /** Pings actually delivered. */
  readonly sent: number;
  /** Rows suppressed because their (type, bot) cooldown was still active. */
  readonly throttled: number;
  /** Rows whose send was attempted and failed; left for the next run. */
  readonly failed: number;
  /** Reasons for the failures, for logging. */
  readonly failures: readonly { readonly id: string; readonly reason: string }[];
}

const DEFAULT_LIMIT = 500;

/** The alert row as a provider needs it: camel-cased, storage-free. */
function toNotifiable(row: AlertRow): NotifiableAlert {
  return {
    id: row.id,
    severity: row.severity,
    category: row.category,
    alertType: row.alert_type,
    botInstanceId: row.bot_instance_id,
    source: row.source,
    message: row.message,
    createdAt: row.created_at,
  };
}

export async function dispatchPendingAlerts(ports: DispatchPorts): Promise<DispatchResult> {
  const windowMs = ports.windowMs ?? DEFAULT_COOLDOWN_MS;
  const limit = ports.limit ?? DEFAULT_LIMIT;
  // One instant for the whole run. This is what makes within-run throttling
  // deterministic: the first alert of a (type, bot) records `at`, and every
  // later one in the same run sees `at - at === 0 < windowMs` and is throttled.
  const at = ports.now();

  // Oldest first, id as a stable tiebreak, so that when several alerts of one
  // (type, bot) are pending together the EARLIEST is the one that sends and the
  // rest throttle -- not an arbitrary one. Only un-notified rows: `notified_at`
  // IS NULL is the dispatcher's queue, backed by a partial index.
  const rows = await ports.db.alerts.findMany({
    where: { notified_at: null },
    orderBy: [
      { column: "created_at", direction: "asc" },
      { column: "id", direction: "asc" },
    ],
    limit,
  });

  let sent = 0;
  let throttled = 0;
  let failed = 0;
  const failures: { id: string; reason: string }[] = [];

  for (const row of rows) {
    const key = cooldownKey(row.alert_type, row.bot_instance_id);
    const last = await ports.cooldown.lastSentAt(key);

    if (last !== null && at - last < windowMs) {
      // Within cooldown: do not send, but the alert is already recorded in D1,
      // so this is a completed decision. Stamp it so it is never reconsidered.
      await markProcessed(ports.db, row.id, at);
      throttled++;
      continue;
    }

    const result = await attemptSend(ports.notifier, toNotifiable(row));
    if (result.delivered) {
      // Advance the cooldown BEFORE stamping the row, so a crash between the
      // two re-sends (a duplicate ping) rather than losing the record that one
      // went out. Over-notifying is the safe direction for an alert.
      await ports.cooldown.recordSent(key, at);
      await markProcessed(ports.db, row.id, at);
      sent++;
    } else {
      // Attempted and failed. Deliberately NOT stamped and cooldown NOT
      // advanced, so the next run finds it again and retries. The alert is
      // still in D1 either way; only its ping is outstanding.
      failed++;
      failures.push({ id: row.id, reason: result.reason });
    }
  }

  return { scanned: rows.length, sent, throttled, failed, failures };
}

/** Send, treating a thrown provider as an ordinary failed delivery. */
async function attemptSend(
  notifier: AlertNotifier,
  alert: NotifiableAlert,
): Promise<NotifyResult> {
  try {
    return await notifier.send(alert);
  } catch (error) {
    return {
      delivered: false,
      reason: `notifier threw: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

async function markProcessed(db: Database, id: string, at: number): Promise<void> {
  await db.alerts.update({ id }, { notified_at: at });
}
