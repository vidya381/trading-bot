/**
 * The `alerts.alert_type` naming contract, shared by BOTH toolchains.
 *
 * THIS FILE IS IMPORTED BY THE DASHBOARD as well as the Worker, and it is the
 * only file that is. That is deliberate and it constrains what may go in here:
 *
 *   **It must stay dependency-free.** No imports, no `bigint`, no Workers types,
 *   no DOM. The two toolchains are deliberately separate (the dashboard pins
 *   TypeScript 5.7 against the Worker's 7), so anything shared between them has
 *   to be plain, portable TypeScript that both compilers accept unchanged. Add a
 *   Worker-only import here and the dashboard build breaks -- loudly, which is
 *   better than the alternative this file exists to prevent, but still avoidable.
 *
 * WHY IT EXISTS
 * -------------
 * `reconciliation_{tier}_{kind}` was being built by string concatenation in
 * `reconcile.ts` (twice), matched by two `startsWith` prefix checks in the same
 * file's `resolveClearedAlerts`, and re-derived a third time in the dashboard's
 * `driftAlerts.ts` to decide whether to offer the "Apply missed fills" control.
 *
 * Four independent copies of one string format, and the dashboard's copy fails
 * in the worst available way: if a rename made it disagree, no test breaks, no
 * error is logged, and no request 404s -- the repair button simply stops
 * appearing on a bot that has drift, which reads exactly like "there is nothing
 * wrong". A silent gap on a correction surface is precisely the failure mode
 * this project refuses everywhere else (cf. step 16's bug 2: a blind
 * reconciliation that alerted nothing for 143 passes).
 *
 * So the format is written once, here, and constructed through
 * `reconciliationAlertType` on both sides. A rename now either updates every
 * caller automatically or fails `src/shared/alert-types.test.ts`, which checks
 * the two sides against the REAL finding kinds rather than a hand-copied list.
 */

/**
 * The two tiers that raise an alert row.
 *
 * `minor` is deliberately absent: section 9 auto-corrects minor drift, logs it,
 * and writes NO alert -- so there is no `reconciliation_minor_*` alert type and
 * constructing one would be inventing a row shape that never exists. Tied to the
 * real `DriftClassification` union in `reconciliation/findings.ts`, so dropping
 * or renaming a tier there fails the Worker typecheck here.
 */
export const ALERTING_TIERS = ["meaningful", "severe"] as const;

export type AlertingTier = (typeof ALERTING_TIERS)[number];

/**
 * The one place `reconciliation_{tier}_{kind}` is spelled.
 *
 * `kind` is a `FindingKind` on the Worker side; it is left as `string` here so
 * this file needs no import (see the header). The Worker's own call sites pass a
 * real `FindingKind`, and the shared test pins the two together.
 */
export function reconciliationAlertType(tier: AlertingTier, kind: string): string {
  return `reconciliation_${tier}_${kind}`;
}

/**
 * True for an alert type this naming scheme produced.
 *
 * Replaces the pair of hand-written `startsWith("reconciliation_severe_")` /
 * `startsWith("reconciliation_meaningful_")` checks in `resolveClearedAlerts`,
 * which is the other place a new tier would have had to be remembered.
 */
export function isReconciliationAlertType(alertType: string): boolean {
  return ALERTING_TIERS.some((tier) => alertType.startsWith(`reconciliation_${tier}_`));
}

/**
 * The finding kinds that mean "an order this system believes open may actually
 * have executed" -- the drift `applyMissedFills` repairs.
 *
 * Tied to the real `FindingKind` union by
 * `findings.ts`'s `ORDER_STATE_DRIFT_FINDING_KINDS`, so renaming a kind there
 * fails the Worker typecheck rather than silently emptying the set below.
 */
export const ORDER_STATE_DRIFT_KINDS = ["order_state_drift", "reported_order_state_drift"] as const;

/**
 * Every `alert_type` that means repairable order-state drift on a bot: the two
 * kinds above at both alerting tiers, plus the untiered `order_state_drift` the
 * bot object itself writes from `#onOrderStateError` (which reconciliation also
 * ingests under `INGESTED_ALERT_TYPES`).
 *
 * The `reconciliation_severe_*` members are unreachable today --
 * `TIER_CEILING.order_state_drift` is `meaningful` and order-level findings carry
 * no magnitude, so this kind cannot escalate. They are included so that raising
 * the ceiling later cannot silently stop the repair control appearing on the
 * WORSE tier, which is the same class of silent gap this module exists to close.
 *
 * DELIBERATELY ABSENT: `cancel_fill_discrepancy` and `cancel_failed`. Same
 * family of problem, but `applyMissedFills` iterates `openOrderIds` only and a
 * cancelled order has already left that set, so the repair cannot reach them
 * (step 18, open question 2). Offering a repair that provably cannot apply is
 * worse than offering none.
 */
export const ORDER_STATE_DRIFT_ALERT_TYPES: ReadonlySet<string> = new Set<string>([
  "order_state_drift",
  ...ORDER_STATE_DRIFT_KINDS.flatMap((kind) =>
    ALERTING_TIERS.map((tier) => reconciliationAlertType(tier, kind)),
  ),
]);
