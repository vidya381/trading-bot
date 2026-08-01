/**
 * Which alerts mean "this bot has order-state drift a human could repair".
 *
 * Shared by the bot detail view's `ApplyMissedFillsAction` (which uses it to
 * decide whether to offer the action at all) and by `AlertList` (which uses it
 * to point an alert row straight at that action). One definition, so the feed
 * can never advertise a repair the bot page would not offer.
 *
 * WHY A GATE AT ALL. `POST /api/bots/:id/apply-missed-fills` writes trades and
 * moves a position away from what the system currently believes. Section 9 halts
 * and alerts on order-state drift and DELIBERATELY never auto-corrects it,
 * because that judgement is a human's -- and a permanently-visible button
 * invites the action without the finding that justifies it. So the control
 * appears only while this specific bot has an OPEN drift incident.
 *
 * WHERE THE TYPE STRINGS COME FROM. Not from here. `ORDER_STATE_DRIFT_ALERT_TYPES`
 * is imported from `src/shared/alert-types.ts` -- the SAME module
 * `reconcile.ts` builds every `reconciliation_{tier}_{kind}` string with. This is
 * the one place the dashboard reaches across into the Worker's source tree, and
 * it is deliberate: an independently-derived copy here would fail silently. A
 * rename that made the two disagree would produce no error, no failing request
 * and no log line -- just a repair button that quietly stops appearing on a bot
 * that has drift, which looks exactly like "nothing is wrong". The shared module
 * is dependency-free precisely so it can be imported by both toolchains, and
 * `src/shared/alert-types.test.ts` asserts the set covers every drift alert type
 * reconciliation can actually produce.
 *
 * THE FIVE TYPES it resolves to today:
 *
 *   - `order_state_drift` -- written by the bot's own object
 *     (`#onOrderStateError`) when the order state machine refused a fill
 *     (`overfill`, `invalid_quantity`, `invalid_transition`) and halted itself.
 *   - `reconciliation_meaningful_order_state_drift` -- reconciliation observed
 *     the exchange and the bot disagreeing about an order. THIS is the shape of
 *     the 2026-07-31 incident: three orders confirmed filled on Gemini while the
 *     bots still believed them `pending`.
 *   - `reconciliation_meaningful_reported_order_state_drift` -- the same finding
 *     reached by INGESTING the bot's own alert above (`INGESTED_ALERT_TYPES`).
 *   - the `reconciliation_severe_*` counterparts of both. Unreachable today:
 *     `TIER_CEILING.order_state_drift` is `meaningful`, so magnitude cannot push
 *     this kind to severe. They are listed anyway, because a future ceiling
 *     change should not silently stop the control appearing on the WORSE tier.
 *
 * DELIBERATELY NOT INCLUDED: `cancel_fill_discrepancy` and `cancel_failed`.
 * They describe the same family of problem -- this system's belief about an
 * order diverging from the exchange's -- and reconciliation even classifies them
 * alongside drift. But `applyMissedFills` iterates `state.openOrderIds` only, and
 * a cancelled order has already left that set, so the repair cannot reach them
 * (the step-18 entry records this as its open question 2). Offering the button
 * for an alert it provably cannot fix would be worse than not offering it: the
 * operator would run it, get an empty `applied` list, and have to work out why.
 */

import { ORDER_STATE_DRIFT_ALERT_TYPES } from "../../src/shared/alert-types";
import type { Alert } from "./api/types";

/**
 * The `id` of the action's section, and the hash an alert row links to. Shared
 * so the link target and the scroll anchor cannot drift apart.
 */
export const APPLY_MISSED_FILLS_ANCHOR = "apply-missed-fills";

/**
 * The alert types that mean "repairable order-state drift on this bot".
 *
 * Re-exported, not rebuilt: this is the backend's own set (see the header).
 */
export const DRIFT_ALERT_TYPES = ORDER_STATE_DRIFT_ALERT_TYPES;

/**
 * True for an OPEN drift incident. `resolved` is the whole point of the check:
 * since step 18's standing alerts, `alerts` holds one row per open incident and
 * `resolveClearedAlerts` closes it once the finding stops recurring, so an
 * unresolved row means the drift is still there RIGHT NOW rather than that it
 * happened once.
 */
export function isOpenDriftAlert(alert: Alert): boolean {
  return !alert.resolved && DRIFT_ALERT_TYPES.has(alert.alertType);
}

/** Every open drift alert in a bot's alert list, newest first (the API's order). */
export function openDriftAlerts(alerts: readonly Alert[]): readonly Alert[] {
  return alerts.filter(isOpenDriftAlert);
}
