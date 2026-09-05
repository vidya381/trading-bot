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
 * The one place `halt_{reason}` is spelled, and the predicate that reads it back.
 *
 * WHY IT MOVED HERE (step 27). The format had exactly one construction site --
 * `#halt` in `bot-instance.ts` -- and one is not a duplication problem, so it
 * stayed inline. Resolving these rows on a successful resume adds a SECOND place
 * that has to agree about what a halt alert looks like, which is the moment the
 * `reconciliationAlertType` treatment starts paying for itself: a rename now
 * moves both sides at once instead of leaving a resolver quietly matching
 * nothing. The failure it prevents is the silent one -- no error, no failing
 * request, just halt alerts that stop being closed.
 *
 * `reason` is a `HaltReason` (the union of `DcaHaltReason` and `GridHaltReason`)
 * at every real call site; it is `string` here so this file stays import-free for
 * the dashboard's toolchain, exactly as `reconciliationAlertType`'s `kind` is.
 * `alert-types.test.ts` pins the two together against the real union.
 *
 * PREFIX MATCHING IS SAFE HERE and is checked rather than assumed. No other
 * alert type in the system begins `halt_`: reconciliation's own
 * `reconciliation_halt_failed` begins `reconciliation_`, and the test above
 * asserts that specific non-match. A future alert type that is ABOUT halting
 * without BEING a halt must not be named `halt_*`, or `resolveHaltAlerts` would
 * close it on the next resume.
 */
export function haltAlertType(reason: string): string {
  return `halt_${reason}`;
}

/** True for an alert row that records a bot entering `halted`. */
export function isHaltAlertType(alertType: string): boolean {
  return alertType.startsWith("halt_");
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

/**
 * RECEIPT alert types: an event that was already complete when it was recorded.
 *
 * THE DISTINCTION THIS ENCODES. `alerts.resolved` answers "is this still going
 * on?". Most types here describe a CONDITION -- drift that is still true, a
 * venue still unreachable, a bot still halted -- and something later closes
 * them. These four describe an EVENT: a cycle closed, a liquidation filled, a
 * repair committed, a click that found nothing to do. Nothing closes them
 * because there is nothing to close, so before step 72 every one sat
 * `resolved: false` forever, inflating the single number an operator reads to
 * decide what needs attention while describing things that had already
 * finished.
 *
 * WHY THE LIST LIVES HERE AND NOT AT THE CALL SITES. Step 72's forward fix marks
 * each of these `resolved: true` where it is raised, which is the right place to
 * make that decision but leaves no enumeration behind -- and step 73's backfill
 * needs exactly such an enumeration to find the rows written BEFORE that fix.
 * Spelling the list out a second time inside the backfill is the drift steps 57
 * and 61 were both built to end, so it is spelled once, here, beside the two
 * sets that already exist for the same reason. `alert-types.test.ts` pins it to
 * the call sites: every member must actually be raised resolved, so adding a
 * type here without marking it (or the reverse) fails the suite rather than
 * producing a backfill that quietly misses rows.
 *
 * DELIBERATELY ABSENT: `circuit_breaker_reset` and `global_kill_switch_reset`.
 * They are the same SHAPE -- info-severity receipts of a completed re-arm -- and
 * step 72 deliberately left them alone: they belong to a different subsystem
 * with its own alert conventions, they are account/global-scoped rather than
 * per-bot (`bot_instance_id` is null), and each records the resolution of a
 * prior critical, which is a lifecycle worth examining on its own terms rather
 * than assuming it matches. Since the forward fix does not mark them, the
 * backfill must not sweep them in by resemblance either -- the two halves have
 * to agree about what a receipt is.
 */
export const RECEIPT_ALERT_TYPES = [
  "liquidation_noop",
  "position_repaired",
  "take_profit",
  "liquidation_filled",
] as const;

/** True for an alert that records a completed event rather than an open condition. */
export function isReceiptAlertType(alertType: string): boolean {
  return (RECEIPT_ALERT_TYPES as readonly string[]).includes(alertType);
}

/**
 * The bot object's own POLL-HEALTH alert types: "this bot's observation of
 * itself has stopped working", as distinct from "this bot found something
 * wrong".
 *
 * WHY THESE LIVE HERE, in the one file both toolchains compile. Step 22 adds a
 * dashboard control (`CheckOpenOrdersAction`) whose whole reason to be prominent
 * is an OPEN alert of one of these kinds -- the operator seeing `poll_blind` and
 * reaching for the manual pass. Deciding that in the dashboard means a second,
 * hand-copied list of these strings, which is precisely the failure this module
 * was created to end: a rename would produce no error, no failing request and no
 * 404, just a control that quietly stops surfacing on a bot whose automatic
 * observation has died. That is the same silent-gap-on-a-correction-surface
 * problem `ORDER_STATE_DRIFT_ALERT_TYPES` above exists to prevent, and it gets
 * the same treatment.
 *
 * `unattributable_fill` is deliberately NOT here. It is also raised through the
 * bot's standing path, but it is a FINDING about the books rather than a fault
 * in the observation itself, and a manual re-check is not the response to it
 * (`applyMissedFills` is, and it has its own set above). The full standing set
 * the Durable Object owns is built from this one in `bot-instance.ts`.
 *
 * WHAT EACH ONE MEANS:
 *  - `poll_blind` / `poll_blind_escalated` (step 20) -- consecutive passes could
 *    not READ this bot's open orders. The venue is unreachable from here.
 *  - `price_updates_stale` (step 22) -- the opposite direction: this bot has not
 *    RECEIVED a live price for longer than the feed's measured cadence can
 *    explain. See `PRICE_STALENESS_MS` in `bot-instance.ts` for the number and
 *    where it comes from.
 */
export const POLL_HEALTH_ALERT_TYPES = [
  "poll_blind",
  "poll_blind_escalated",
  "price_updates_stale",
] as const;

/** True for an alert meaning this bot's own observation machinery is faulty. */
export function isPollHealthAlertType(alertType: string): boolean {
  return (POLL_HEALTH_ALERT_TYPES as readonly string[]).includes(alertType);
}

/**
 * "Something happened to this bot AFTER it halted, and its halt lifecycle did
 * not act on it."
 *
 * THE CONDITION. A halted bot can still have orders resting on the exchange --
 * `#halt` cancels, but a cancellation that cannot be confirmed keeps the id, and
 * step 82's incident left a sell live for ten days. When such an order finally
 * fills, the fill is recorded honestly (the books must stay right) but the
 * lifecycle transition it would normally drive is REFUSED, because the bot is
 * not in the state that transition acts on. That refusal is correct and it is
 * also invisible: `bot_instances.status` and `halt_reason` keep describing the
 * ORIGINAL halt, which is deliberate (see `BotRuntimeState.postHaltEvents`), so
 * without this row the only trace is an audit entry nobody is watching.
 *
 * ⚠ NOT A `halt_*` TYPE, and the name is chosen for that. `isHaltAlertType`
 * matches on the `halt_` PREFIX, and `resolveHaltAlerts` closes everything it
 * matches on any successful resume. This row is about a halt without being one,
 * which is precisely the case `haltAlertType`'s header warns must not be named
 * `halt_*`. It is still closed on resume -- by `#resumePass` naming it
 * explicitly, so it has ONE owner and gains nothing by resemblance.
 *
 * ⚠ NOT A RECEIPT either, so it is absent from `RECEIPT_ALERT_TYPES` and is
 * raised UNRESOLVED. The `take_profit` row beside it is a receipt: the cycle
 * closed, nothing is left to do. This one says a halted bot's books moved and
 * nobody has looked -- an open condition that resume or close ends, which is
 * exactly what `resolved` is for.
 */
export const POST_HALT_ACTIVITY_ALERT_TYPE = "post_halt_activity";
