/**
 * `proposalFieldsOf` — the guard AND the field list, together.
 *
 * ── WHY THIS FILE EXISTS AT ALL ──
 *
 * A mutation run against the first version of this fix found a **SURVIVING** mutant:
 * deleting the component's `shape.ok ?` guard and restoring the original crash broke
 * no test, because the guard's call site lived inside a `.tsx` that no test can
 * import (React's CJS build does not resolve in the Workers runtime). `checkParamsShape`
 * was covered exhaustively; the line that CALLED it was not, and a guard whose call
 * site nothing checks is most of the way to no guard.
 *
 * So the decision moved into a React-free module and this file drives it. The
 * property under test is the PAIRING: a failing check must come back with an EMPTY
 * field list, because that is what makes it impossible for the component to render
 * a field for params that did not hold up.
 *
 * ── ⚠ WHAT IS STILL NOT COVERED ──
 *
 * The JSX. `ProposalParameters` maps over `specs` and renders `shape` when it is not
 * ok, and that mapping is verified by the operator's eyes and by nothing else — as
 * decision log 44 records for every component here. What is no longer eye-verified is
 * every DECISION behind it.
 */

import { describe, expect, it } from "vitest";
import {
  DCA_PROPOSAL_FIELDS,
  GRID_PROPOSAL_FIELDS,
} from "../../src/research/proposal-shape";
import { proposalFieldsOf } from "./proposalFields";

/** A well-formed grid params object, exactly as `validatedProposalView` emits one. */
const GRID_PARAMS = {
  strategy: "grid",
  upperBound: "108.00000000",
  lowerBound: "96.00000000",
  gridLines: 5,
  spacing: "arithmetic",
  orderSize: "50.00000000",
  stopLossPct: "5.00000000",
  breakoutTakeProfit: true,
  breakoutThresholdPct: null,
  takeProfitAmount: null,
} as const;

/**
 * A well-formed DCA params object, built from `DCA_PROPOSAL_FIELDS` upward.
 *
 * ⚠ CONSTRUCTED WITH THE RIGHT DCA FIELDS, NOT EDITED FROM A GRID ONE — and it is
 * NOT verification of the DCA path. Every live derivation this project has produced
 * has been grid (decision logs 41, 42, 44); closing that needs a real Derive call
 * that answers dca, not a fixture. Tracked separately.
 */
const DCA_PARAMS = {
  strategy: "dca",
  baseOrderSize: "100.00000000",
  additionalOrderSize: "100.00000000",
  stepMultiplier: "1.50000000",
  dropPct: "5.00000000",
  maxAdditionalBuys: 2,
  takeProfitPct: "2.00000000",
  stopLossPct: "20.00000000",
  autoRestart: false,
  sellOnStopLoss: false,
} as const;

// ---------------------------------------------------------------------------
// THE CRASH, THROUGH THE PATH THE COMPONENT ACTUALLY TAKES
// ---------------------------------------------------------------------------

describe("⚠ the exact input that crashed the real page", () => {
  const CRASHER = { ...GRID_PARAMS, strategy: "dca" };

  it("returns a REFUSAL and NO FIELDS, so nothing can be rendered from it", () => {
    // THE PAIRING. This is the assertion the surviving mutant needed: a failing
    // check and a non-empty field list must be unrepresentable together.
    const { shape, specs } = proposalFieldsOf(CRASHER);
    expect(shape.ok).toBe(false);
    expect(specs).toEqual([]);
  });

  it("does not throw, which is the entire point", () => {
    // The old path threw `TypeError: undefined is not an object (evaluating
    // 'value.startsWith')` out of `roundDecimal` here and blanked the page.
    expect(() => proposalFieldsOf(CRASHER)).not.toThrow();
  });

  it("carries a message a human can act on", () => {
    const { shape } = proposalFieldsOf(CRASHER);
    if (shape.ok) throw new Error("expected a refusal");
    expect(shape.message).toContain("grid-shaped but labelled dca");
    expect(shape.message).toContain("Do not act on it");
  });
});

describe("⚠ every malformed shape returns no fields and never throws", () => {
  const BAD: readonly [string, unknown][] = [
    ["a dca label over grid params", { ...GRID_PARAMS, strategy: "dca" }],
    ["a grid label over dca params", { ...DCA_PARAMS, strategy: "grid" }],
    ["both strategies' fields at once", { ...GRID_PARAMS, ...DCA_PARAMS, strategy: "grid" }],
    ["a truncated grid params", { strategy: "grid", upperBound: "108.00000000" }],
    ["an unknown strategy", { ...GRID_PARAMS, strategy: "martingale" }],
    ["a field explicitly set to undefined", { ...GRID_PARAMS, orderSize: undefined }],
    ["null", null],
    ["undefined", undefined],
    ["a string", "grid"],
    ["an array", []],
    ["an empty object", {}],
    ["a params whose strategy is an object", { ...GRID_PARAMS, strategy: { evil: 1 } }],
  ];

  for (const [label, params] of BAD) {
    it(`handles ${label}`, () => {
      let result;
      expect(() => {
        result = proposalFieldsOf(params);
      }, `proposalFieldsOf threw on ${label} — that is the blank page`).not.toThrow();
      const { shape, specs } = result as ReturnType<typeof proposalFieldsOf>;
      expect(shape.ok, `${label} was accepted`).toBe(false);
      expect(specs, `${label} produced renderable fields`).toEqual([]);
    });
  }
});

// ---------------------------------------------------------------------------
// WELL-FORMED INPUT STILL RENDERS, IN FULL
// ---------------------------------------------------------------------------

describe("a genuinely well-formed proposal still renders every field", () => {
  it("builds all nine GRID fields, in the create-bot form's own order", () => {
    const { shape, specs } = proposalFieldsOf(GRID_PARAMS);
    expect(shape.ok).toBe(true);
    // EVERY field, not merely some: 21.4 Stage 3 forbids "tune this yourself", and a
    // field silently dropped here would undo that at the last step.
    expect(specs.map((spec) => spec.field)).toEqual([
      "lowerBound",
      "upperBound",
      "gridLines",
      "spacing",
      "orderSize",
      "stopLossPct",
      "takeProfitAmount",
      "breakoutTakeProfit",
      "breakoutThresholdPct",
    ]);
    // The same SET the backend requires, order aside.
    expect([...specs.map((s) => s.field)].sort()).toEqual([...GRID_PROPOSAL_FIELDS].sort());
  });

  it("renders real grid values rather than placeholders", () => {
    const byField = new Map(proposalFieldsOf(GRID_PARAMS).specs.map((s) => [s.field, s.value]));
    expect(byField.get("lowerBound")).toBe("96.00");
    expect(byField.get("upperBound")).toBe("108.00");
    expect(byField.get("gridLines")).toBe("5");
    expect(byField.get("spacing")).toBe("arithmetic");
    expect(byField.get("orderSize")).toBe("50.00");
    expect(byField.get("breakoutTakeProfit")).toBe("Enabled");
    // The two nullable fields render as the honest "Not set", NOT as "0.00" — an
    // unset take-profit shown as zero would read as a target of nothing.
    expect(byField.get("takeProfitAmount")).toBe("Not set");
    expect(byField.get("breakoutThresholdPct")).toBe("Not set");
  });

  it("builds all nine DCA fields (from the DCA field list, not edited from a grid one)", () => {
    const { shape, specs } = proposalFieldsOf(DCA_PARAMS);
    expect(shape.ok).toBe(true);
    expect(specs.map((spec) => spec.field)).toEqual([
      "baseOrderSize",
      "additionalOrderSize",
      "stepMultiplier",
      "dropPct",
      "maxAdditionalBuys",
      "takeProfitPct",
      "stopLossPct",
      "autoRestart",
      "sellOnStopLoss",
    ]);
    expect([...specs.map((s) => s.field)].sort()).toEqual([...DCA_PROPOSAL_FIELDS].sort());
  });

  it("renders real DCA values, including the two booleans and the falsy ones", () => {
    const byField = new Map(proposalFieldsOf(DCA_PARAMS).specs.map((s) => [s.field, s.value]));
    expect(byField.get("baseOrderSize")).toBe("100.00");
    expect(byField.get("stepMultiplier")).toBe("1.50000000");
    expect(byField.get("maxAdditionalBuys")).toBe("2");
    // `false` must render as "Disabled", not as blank or "Not set": a falsy flag is a
    // real setting, and this is the class of bug a truthiness check introduces.
    expect(byField.get("autoRestart")).toBe("Disabled");
    expect(byField.get("sellOnStopLoss")).toBe("Disabled");
  });

  it("renders a zero and a false without mistaking either for absent", () => {
    const { shape, specs } = proposalFieldsOf({
      ...DCA_PARAMS,
      maxAdditionalBuys: 0,
      dropPct: "0.00000000",
    });
    expect(shape.ok).toBe(true);
    const byField = new Map(specs.map((s) => [s.field, s.value]));
    expect(byField.get("maxAdditionalBuys")).toBe("0");
    expect(byField.get("dropPct")).not.toBe("Not set");
  });

  it("gives every field a label, and never an empty value", () => {
    // A blank cell on this page is indistinguishable from a missing parameter, which
    // is what the whole fix is about.
    for (const params of [GRID_PARAMS, DCA_PARAMS]) {
      for (const spec of proposalFieldsOf(params).specs) {
        expect(typeof spec.label).toBe("string");
        expect(spec.label.length).toBeGreaterThan(0);
        expect(typeof spec.value).toBe("string");
        expect(spec.value.length, `${spec.field} rendered empty`).toBeGreaterThan(0);
      }
    }
  });
});
