/**
 * The contract between `reconcile.ts` (which WRITES `alerts.alert_type`) and the
 * dashboard's `driftAlerts.ts` (which READS it to decide whether to offer the
 * "Apply missed fills" repair control).
 *
 * WHY THIS FILE EXISTS. Both sides used to build `reconciliation_{tier}_{kind}`
 * independently, and a divergence between them fails in the one way this project
 * refuses everywhere else: silently. No test breaks, no request errors, nothing
 * is logged -- the repair button just stops appearing on a bot that has drift,
 * which is indistinguishable on screen from "there is no drift". Both sides now
 * go through `shared/alert-types.ts`, and these tests hold that in place.
 *
 * THE LISTS HERE ARE DERIVED, NEVER HAND-MAINTAINED. Every kind comes from
 * `TIER_FLOOR`, whose keys are the real `FindingKind` union, and every type
 * string is built by the same `reconciliationAlertType` the writer uses. A new
 * finding kind is therefore covered by these tests the moment it is added,
 * without anyone remembering to list it here -- a second hand-copied list would
 * reproduce the exact bug this closes.
 *
 * This file imports the DASHBOARD's module directly. That is the point: the
 * dashboard has no test runner of its own (typecheck and build only), so the
 * only place its predicate can be executed against the real writer is here.
 */

import { describe, expect, it } from "vitest";

import { alertView } from "../api/serialize";
import { alertRow } from "../db/test-helpers";
import {
  ALERTING_DRIFT_TIERS,
  ORDER_STATE_DRIFT_FINDING_KINDS,
  TIER_FLOOR,
  type FindingKind,
} from "../reconciliation/findings";
import {
  ALERTING_TIERS,
  ORDER_STATE_DRIFT_ALERT_TYPES,
  POLL_HEALTH_ALERT_TYPES,
  haltAlertType,
  isHaltAlertType,
  isReconciliationAlertType,
  reconciliationAlertType,
} from "./alert-types";
import type { HaltReason } from "../durable-objects/bot-instance";
import { DRIFT_ALERT_TYPES, isOpenDriftAlert } from "../../dashboard/src/driftAlerts";

/** Every finding kind that exists, read from the classification table itself. */
const EVERY_KIND = Object.keys(TIER_FLOOR) as FindingKind[];

/** An alert as the API serves it, from a row as reconciliation writes it. */
function servedAlert(alertType: string, resolved = false) {
  return alertView(alertRow({ id: `a-${alertType}`, alert_type: alertType, resolved }));
}

describe("the reconciliation alert-type contract", () => {
  it("covers every alerting tier the writer can use", () => {
    // If a third tier ever raises a row, `ALERTING_TIERS` is where it must be
    // added -- and `findings.ts` types this same array as DriftClassification[],
    // so a tier rename fails the typecheck before it reaches here.
    expect([...ALERTING_TIERS]).toEqual(["meaningful", "severe"]);
    expect([...ALERTING_DRIFT_TIERS]).toEqual([...ALERTING_TIERS]);
    // `minor` raises no alert row at all (section 9 auto-corrects and logs it),
    // so there is no such alert type to recognise.
    expect(isReconciliationAlertType("reconciliation_minor_mirror_drift")).toBe(false);
  });

  it("recognises a reconciliation alert type for EVERY finding kind", () => {
    for (const kind of EVERY_KIND) {
      for (const tier of ALERTING_TIERS) {
        expect(isReconciliationAlertType(reconciliationAlertType(tier, kind))).toBe(true);
      }
    }
    // And not the alert types this module writes with their own lifecycles.
    expect(isReconciliationAlertType("reconciliation_blind")).toBe(false);
    expect(isReconciliationAlertType("reconciliation_halt_failed")).toBe(false);
    expect(isReconciliationAlertType("orphaned_bot_row")).toBe(false);
  });
});

/**
 * Every halt reason that exists, as a value, tied to the type union.
 *
 * `HaltReason` is a union of string literals with no runtime list behind it, so
 * this Record IS the list -- and it is exhaustive by TYPECHECK: a reason added to
 * `DcaHaltReason` or `GridHaltReason` and not added here fails to compile, and a
 * key here that is not a real reason fails too. That is what makes the loop below
 * cover a new reason without anyone remembering this file exists, which is the
 * same property `EVERY_KIND` gives the tests above.
 */
const EVERY_HALT_REASON: Record<HaltReason, true> = {
  stop_loss: true,
  unhandled_error: true,
  order_rejected: true,
  take_profit_reached: true,
  take_profit: true,
  breakout_take_profit: true,
  trailing_stop_reached: true,
  manual: true,
};

describe("the halt alert-type contract", () => {
  it("recognises the alert type for EVERY halt reason either strategy can raise", () => {
    // The silent failure this closes: a new halt reason whose alert row
    // `resolveHaltAlerts` does not recognise is never closed on resume, and
    // nothing anywhere says so -- it just accumulates as an open critical, which
    // is the bug step 27 fixed in the first place.
    const reasons = Object.keys(EVERY_HALT_REASON) as HaltReason[];
    expect(reasons.length).toBeGreaterThan(0);
    for (const reason of reasons) {
      expect(isHaltAlertType(haltAlertType(reason))).toBe(true);
    }
  });

  it("recognises NOTHING else, which is what keeps a resume narrowly scoped", () => {
    // The over-broad half. Every one of these belongs to another lifecycle, and
    // closing any of them on resume would either hide a live problem
    // (`cancel_failed`: an order may still be on the exchange) or give one row
    // two owners (the poll's standing alerts, reconciliation's ingested ones).
    const notHalts = [
      "cancel_failed",
      "cancel_fill_discrepancy",
      "order_state_drift",
      "unknown_order_fill",
      "unattributable_fill",
      "grid_replacement_queued",
      "price_feed_fanout_failed",
      "liquidation_failed",
      // Reconciliation's own, which is the one string in the system that
      // contains "halt_" without being a halt alert. It does not START with it.
      "reconciliation_halt_failed",
      ...POLL_HEALTH_ALERT_TYPES,
    ];
    for (const alertType of notHalts) {
      expect(isHaltAlertType(alertType)).toBe(false);
    }

    for (const kind of EVERY_KIND) {
      for (const tier of ALERTING_TIERS) {
        expect(isHaltAlertType(reconciliationAlertType(tier, kind))).toBe(false);
      }
    }
  });
});

describe("the dashboard's drift gate against what reconciliation really writes", () => {
  it("offers the repair for EVERY drift alert type reconciliation can produce", () => {
    // The test that would have caught a rename on either side. Both loops are
    // derived: the kinds from `FindingKind`, the strings from the writer's own
    // constructor. Renaming `order_state_drift` in findings.ts now fails the
    // Worker typecheck at ORDER_STATE_DRIFT_FINDING_KINDS; renaming the format
    // in shared/alert-types.ts changes both sides at once; and unhooking the
    // dashboard from the shared module fails right here.
    expect(ORDER_STATE_DRIFT_FINDING_KINDS.length).toBeGreaterThan(0);
    for (const kind of ORDER_STATE_DRIFT_FINDING_KINDS) {
      for (const tier of ALERTING_TIERS) {
        const alertType = reconciliationAlertType(tier, kind);
        expect(isOpenDriftAlert(servedAlert(alertType))).toBe(true);
      }
    }
    // Plus the untiered alert the bot object writes itself from
    // `#onOrderStateError`, which is not a reconciliation type at all.
    expect(isOpenDriftAlert(servedAlert("order_state_drift"))).toBe(true);
  });

  it("does NOT offer the repair for any other finding kind", () => {
    // The other half: an over-broad match would offer a repair for findings
    // `applyMissedFills` cannot touch. `cancel_fill_discrepancy` and
    // `cancel_failed` are the deliberate exclusions -- the repair reads
    // `openOrderIds` only, and a cancelled order has left that set.
    const driftKinds = new Set<string>(ORDER_STATE_DRIFT_FINDING_KINDS);
    const others = EVERY_KIND.filter((kind) => !driftKinds.has(kind));
    expect(others).toContain("cancel_fill_discrepancy");
    expect(others).toContain("cancel_failed");

    for (const kind of others) {
      for (const tier of ALERTING_TIERS) {
        const alertType = reconciliationAlertType(tier, kind);
        expect(isOpenDriftAlert(servedAlert(alertType))).toBe(false);
      }
    }
  });

  it("contains nothing the writer cannot produce", () => {
    // The reverse direction, which catches a stale entry left behind by a
    // rename: every member of the gate's set must be a real, constructible type.
    const producible = new Set<string>(["order_state_drift"]);
    for (const kind of ORDER_STATE_DRIFT_FINDING_KINDS) {
      for (const tier of ALERTING_TIERS) producible.add(reconciliationAlertType(tier, kind));
    }
    expect([...DRIFT_ALERT_TYPES].sort()).toEqual([...producible].sort());
    // The dashboard re-exports the shared set rather than rebuilding it.
    expect(DRIFT_ALERT_TYPES).toBe(ORDER_STATE_DRIFT_ALERT_TYPES);
  });

  it("never offers the repair for a RESOLVED drift alert", () => {
    // The gate is "there is an OPEN incident", which only means anything because
    // step 18 made `alerts` one row per incident with `resolveClearedAlerts`
    // closing it. A resolved row is history, not a reason to write trades.
    expect(isOpenDriftAlert(servedAlert("reconciliation_meaningful_order_state_drift", true))).toBe(
      false,
    );
  });
});
