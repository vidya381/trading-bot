/**
 * Which alerts mean "this bot's own observation of itself has stopped working".
 *
 * The counterpart to `driftAlerts.ts`, and the distinction between the two is
 * worth stating because the controls they gate sit next to each other:
 *
 *   - a DRIFT alert says the books are wrong and a human must decide whether to
 *     repair them (`apply-missed-fills`, halted bots only, writes trades);
 *   - a POLL-HEALTH alert says nothing is currently checking whether the books
 *     are wrong (`check-open-orders`, any live bot, re-derives what is true).
 *
 * WHERE THE TYPE STRINGS COME FROM. Not from here, for exactly the reason
 * `driftAlerts.ts` gives: `POLL_HEALTH_ALERT_TYPES` is imported from
 * `src/shared/alert-types.ts`, the same module the Durable Object builds its
 * `POLL_STANDING_ALERT_TYPES` from. An independently-typed copy would fail in
 * the worst available way -- no error, no failing request, no 404, just a
 * control that quietly stops highlighting itself on a bot whose automatic
 * observation has died, which reads exactly like "nothing is wrong".
 *
 * THE THREE TYPES it resolves to today, all written by the bot's own object
 * through the standing-alert path (one row per open incident, resolved when a
 * pass reads cleanly again):
 *
 *   - `poll_blind` (warning) -- five consecutive passes could not read this
 *     bot's open orders. It is now retrying every five minutes.
 *   - `poll_blind_escalated` (critical) -- still blind after thirty minutes. Its
 *     position, take-profit target and stop-loss may all be computed from a
 *     quantity that is no longer true.
 *   - `price_updates_stale` (warning) -- the other direction: this bot has
 *     received no live price for over ten minutes while RUNNING, against a
 *     measured feed cadence of one closed candle every 35-70s. Its stop-loss is
 *     being evaluated on updates that are not arriving.
 *
 * DELIBERATELY NOT INCLUDED: `price_feed_blind` and `price_feed_blind_escalated`.
 * Same family of concern, but they are the FEED's, written with a null
 * `bot_instance_id` by design (the column is a foreign key, and a fan-out
 * failure attributed to a deleted bot would violate it), so they never appear in
 * a bot's alert list and could not gate anything here. They are also not
 * answerable by this control: re-reading open orders does not fix a socket.
 */

import { POLL_HEALTH_ALERT_TYPES } from "../../src/shared/alert-types";
import type { Alert } from "./api/types";

/**
 * The `id` of the control's section, and the hash an alert row links to. Shared
 * so the link target and the scroll anchor cannot drift apart -- the same
 * arrangement `APPLY_MISSED_FILLS_ANCHOR` uses.
 */
export const CHECK_OPEN_ORDERS_ANCHOR = "check-open-orders";

/** The alert types meaning "this bot's observation machinery is faulty". */
export const POLL_ALERT_TYPES: ReadonlySet<string> = new Set<string>(POLL_HEALTH_ALERT_TYPES);

/**
 * True for an OPEN poll-health incident. `resolved` is the whole check: these
 * are standing alerts, so an unresolved row means the condition holds RIGHT NOW
 * rather than that it happened once.
 */
export function isOpenPollAlert(alert: Alert): boolean {
  return !alert.resolved && POLL_ALERT_TYPES.has(alert.alertType);
}

/** Every open poll-health alert in a bot's alert list, newest first (the API's order). */
export function openPollAlerts(alerts: readonly Alert[]): readonly Alert[] {
  return alerts.filter(isOpenPollAlert);
}
