/**
 * The classification rule (spec section 9), tested as pure logic.
 *
 * No database and no exchange here -- `findings.ts` performs no I/O, so the
 * tiering can be pinned exactly rather than inferred from what a run happened
 * to do. The tests that check the three tiers ACT correctly live in
 * `reconcile.test.ts`.
 */

import { describe, expect, it } from "vitest";

import {
  classifyAll,
  classifyFinding,
  DEFAULT_DRIFT_THRESHOLDS,
  exceedsFraction,
  highestTier,
  INGESTED_ALERT_TYPES,
  TIER_CEILING,
  TIER_FLOOR,
  type Finding,
  type FindingKind,
} from "./findings";
import { fromDecimalString, ONE, ZERO } from "../shared/money";

function finding(overrides: Partial<Finding> & { kind: FindingKind }): Finding {
  return {
    scope: "bot",
    botInstanceId: "dca-btc-1",
    asset: null,
    detail: "test finding",
    ...overrides,
  };
}

describe("exceedsFraction", () => {
  it("is exact well past 2^53, where a division would not be", () => {
    // 1% of 10^18 (scale-8: ten billion units) is exactly 10^16.
    const reference = 10n ** 18n;
    const onePercent = ONE; // 1.0 as a scale-8 percentage
    expect(exceedsFraction(10n ** 16n, reference, onePercent)).toBe(true);
    // One unit below the threshold must be false. A float ratio could not
    // distinguish these two at all.
    expect(exceedsFraction(10n ** 16n - 1n, reference, onePercent)).toBe(false);
  });

  it("uses the absolute value, so a loss and a gain of equal size tier alike", () => {
    expect(exceedsFraction(-500n, 10_000n, 5n * ONE)).toBe(true);
    expect(exceedsFraction(500n, 10_000n, 5n * ONE)).toBe(true);
  });

  it("returns false for a non-positive reference rather than dividing by zero", () => {
    // A divergence on an asset with a zero balance is real, and must stay at
    // its kind's floor rather than being promoted to severe by a degenerate
    // ratio.
    expect(exceedsFraction(1_000n, ZERO, ONE)).toBe(false);
    expect(exceedsFraction(1_000n, -5n, ONE)).toBe(false);
  });
});

describe("tier floors", () => {
  it("puts both unexpected-order kinds at severe, with no threshold involved", () => {
    // Section 9 lists "unexpected orders" under severe with no size qualifier.
    expect(TIER_FLOOR.unknown_open_order).toBe("severe");
    expect(TIER_FLOOR.unknown_order_fill).toBe("severe");
  });

  it("classifies a tiny unknown order as severe anyway", () => {
    const classified = classifyFinding(
      finding({
        kind: "unknown_open_order",
        scope: "account",
        botInstanceId: null,
        magnitude: { amount: 1n, reference: 10n ** 18n },
      }),
    );
    expect(classified.tier).toBe("severe");
    expect(classified.escalated).toBe(false);
  });

  it("puts the mirror and the timing window at minor", () => {
    expect(TIER_FLOOR.mirror_drift).toBe("minor");
    expect(TIER_FLOOR.order_recently_terminated).toBe("minor");
  });

  it("puts a balance residual at minor, letting the numbers decide the tier", () => {
    // The one kind whose tier is genuinely a question of size, and the only
    // one whose amount and reference are the same asset at account scale.
    expect(TIER_FLOOR.balance_drift).toBe("minor");
    expect(TIER_CEILING.balance_drift).toBe("severe");
  });

  it("has a floor for every kind", () => {
    // A new FindingKind with no floor would classify as `undefined` and act on
    // nothing, silently. This fails the moment one is added without a decision.
    for (const kind of Object.keys(TIER_FLOOR) as FindingKind[]) {
      expect(TIER_FLOOR[kind]).toMatch(/^(minor|meaningful|severe)$/);
    }
  });
});

describe("magnitude escalates but never downgrades", () => {
  it("leaves a sub-threshold balance residual at minor, so rounding is not an alert", () => {
    // A few satoshi of difference between this system's half-even
    // reconstruction and the exchange's own arithmetic. Alerting on it would
    // fire every run forever.
    const classified = classifyFinding(
      finding({
        kind: "balance_drift",
        scope: "account",
        asset: "USDT",
        magnitude: { amount: fromDecimalString("0.01"), reference: fromDecimalString("100") },
      }),
    );
    expect(classified.tier).toBe("minor");
    expect(classified.escalated).toBe(false);
  });

  it("escalates a balance residual to meaningful past meaningfulPct", () => {
    // 0.5 of 100 is 0.5%, above the 0.1% default and below the 2% one.
    const classified = classifyFinding(
      finding({
        kind: "balance_drift",
        scope: "account",
        asset: "USDT",
        magnitude: { amount: fromDecimalString("0.5"), reference: fromDecimalString("100") },
      }),
    );
    expect(classified.tier).toBe("meaningful");
    expect(classified.floor).toBe("minor");
    expect(classified.escalated).toBe(true);
  });

  it("escalates a balance drift to severe past severePct", () => {
    // 5 of 100 is 5%, above the 2% default. balance_drift is the one kind
    // whose ceiling is severe.
    const classified = classifyFinding(
      finding({
        kind: "balance_drift",
        scope: "account",
        asset: "USDT",
        magnitude: { amount: fromDecimalString("5"), reference: fromDecimalString("100") },
      }),
    );
    expect(classified.tier).toBe("severe");
    expect(classified.escalated).toBe(true);
  });

  it("will not carry an ORDER-level finding to severe, however large the ratio", () => {
    // The rule a test caught. An order that half-filled without the bot
    // hearing is a 50% divergence OF THAT ORDER -- which is an ordinary
    // unrecorded fill, not an account-threatening event. Without the ceiling
    // this tripped the circuit breaker and made `meaningful` unreachable.
    for (const kind of [
      "order_state_drift",
      "cancel_fill_discrepancy",
      "cancel_failed",
      "reported_order_state_drift",
    ] as FindingKind[]) {
      const classified = classifyFinding(
        finding({
          kind,
          magnitude: {
            amount: fromDecimalString("0.5"),
            reference: fromDecimalString("1"),
          },
        }),
      );
      expect(classified.tier, kind).toBe("meaningful");
    }
  });

  it("will not carry a ledger bookkeeping mismatch to severe either", () => {
    // A leaked reservation needs a human, but halting every bot on the
    // account over an internal disagreement would be worse than the mismatch.
    const classified = classifyFinding(
      finding({
        kind: "ledger_allocation_drift",
        scope: "account",
        asset: "USDT",
        magnitude: { amount: fromDecimalString("500"), reference: fromDecimalString("1000") },
      }),
    );
    expect(classified.tier).toBe("meaningful");
  });

  it("has a ceiling for every kind, and never below its floor", () => {
    const rank = { minor: 0, meaningful: 1, severe: 2 } as const;
    for (const kind of Object.keys(TIER_FLOOR) as FindingKind[]) {
      expect(TIER_CEILING[kind], kind).toBeDefined();
      // A ceiling below a floor would make the clamp a downgrade, which is
      // exactly what rule 3 forbids.
      expect(rank[TIER_CEILING[kind]], kind).toBeGreaterThanOrEqual(rank[TIER_FLOOR[kind]]);
    }
  });

  it("does NOT downgrade a meaningful floor because the amount is small", () => {
    // The rule that matters. A position mismatch of a hundredth of a percent
    // is still a position mismatch, and section 9 calls that meaningful.
    const classified = classifyFinding(
      finding({
        kind: "order_state_drift",
        magnitude: { amount: 1n, reference: fromDecimalString("1000") },
      }),
    );
    expect(classified.tier).toBe("meaningful");
    expect(classified.escalated).toBe(false);
  });

  it("does NOT downgrade a severe floor because the amount is small", () => {
    const classified = classifyFinding(
      finding({
        kind: "unknown_order_fill",
        scope: "account",
        magnitude: { amount: 1n, reference: fromDecimalString("1000000") },
      }),
    );
    expect(classified.tier).toBe("severe");
  });

  it("stays at the floor when a finding carries no magnitude at all", () => {
    // Every ingested step-6 alert is in this shape: prose, no number. So is
    // every order-level finding reconciliation raises itself -- see the note
    // on `Magnitude.reference` for why.
    expect(classifyFinding(finding({ kind: "cancel_fill_discrepancy" })).tier).toBe("meaningful");
    expect(classifyFinding(finding({ kind: "mirror_drift" })).tier).toBe("minor");
    expect(classifyFinding(finding({ kind: "order_recently_terminated" })).tier).toBe("minor");
    expect(classifyFinding(finding({ kind: "order_state_drift" })).tier).toBe("meaningful");
  });

  it("honours a tightened per-account threshold", () => {
    const strict = { ...DEFAULT_DRIFT_THRESHOLDS, severePct: fromDecimalString("0.5") };
    const drift = finding({
      kind: "balance_drift",
      scope: "account",
      asset: "USDT",
      magnitude: { amount: fromDecimalString("1"), reference: fromDecimalString("100") },
    });
    expect(classifyFinding(drift).tier).toBe("meaningful");
    expect(classifyFinding(drift, strict).tier).toBe("severe");
  });
});

describe("the ingested alert map", () => {
  it("covers all three alert paths step 6 writes, plus cancel_failed", () => {
    // Step 6's deviations named three paths whose alerts "go into a table
    // nobody reads automatically". This is the read side; the fourth is
    // cancel_failed, which describes the same class of divergence.
    expect(Object.keys(INGESTED_ALERT_TYPES).sort()).toEqual([
      "cancel_failed",
      "cancel_fill_discrepancy",
      "order_state_drift",
      "unknown_order_fill",
    ]);
  });

  it("maps every ingested type to a kind that has a floor", () => {
    for (const kind of Object.values(INGESTED_ALERT_TYPES)) {
      expect(TIER_FLOOR[kind]).toBeDefined();
    }
  });

  it("sends an unknown-order fill straight to severe and a cancel race to meaningful", () => {
    expect(TIER_FLOOR[INGESTED_ALERT_TYPES.unknown_order_fill!]).toBe("severe");
    expect(TIER_FLOOR[INGESTED_ALERT_TYPES.cancel_fill_discrepancy!]).toBe("meaningful");
    expect(TIER_FLOOR[INGESTED_ALERT_TYPES.cancel_failed!]).toBe("meaningful");
    expect(TIER_FLOOR[INGESTED_ALERT_TYPES.order_state_drift!]).toBe("meaningful");
  });
});

describe("highestTier", () => {
  it("is null for a clean run, confirming the nullable classification column", () => {
    // Step 4's open question 3 asked step 7 to confirm NULL or add a fourth
    // value. Confirmed: section 9 names three drift classes and no clean case.
    expect(highestTier([])).toBeNull();
  });

  it("returns the worst tier present, not the last or the most common", () => {
    const classified = classifyAll([
      finding({ kind: "mirror_drift" }),
      finding({ kind: "unknown_open_order", scope: "account" }),
      finding({ kind: "mirror_drift" }),
      finding({ kind: "mirror_drift" }),
    ]);
    expect(highestTier(classified)).toBe("severe");
  });

  it("preserves input order, which the orchestrator relies on to pair corrections", () => {
    const input = [
      finding({ kind: "mirror_drift", detail: "a" }),
      finding({ kind: "balance_drift", detail: "b", scope: "account", asset: "USDT" }),
      finding({ kind: "unknown_open_order", detail: "c", scope: "account" }),
    ];
    const classified = classifyAll(input);
    expect(classified.map((entry) => entry.detail)).toEqual(["a", "b", "c"]);
  });
});
