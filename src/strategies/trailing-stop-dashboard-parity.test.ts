/**
 * The dashboard's `Position` mirror must match what the Worker actually emits,
 * and the trail level it shows must be the level the strategy compares against.
 *
 * `dashboard/src/api/types.ts` hand-mirrors `positionOf`'s output. It cannot
 * import the Worker's types -- that pulls D1 types into the dashboard's `tsc -b`
 * and breaks it, the same seam `staleness.ts` and `proposal-shape.ts` document --
 * so the mirror is written out by hand.
 *
 * A MIRROR IS EXACTLY WHAT FAILS SILENTLY, and this seam is worse than the two
 * `*-dashboard-parity` tests beside it: `dashboard/` is EXCLUDED from the root
 * `tsconfig.json`, so a field added to `positionOf` and forgotten here produces no
 * error in either project. The dashboard would simply never show it, or would read
 * a key that is not there. This file is that seam's tripwire, in both directions.
 *
 * Lives in the Worker's suite, importing the dashboard's module, for the reason
 * `dca-dashboard-parity.test.ts` established: the dashboard has no test runner.
 */

import { describe, expect, it } from "vitest";

import type { Position } from "../../dashboard/src/api/types";
import { botSummary } from "../api/serialize";
import { trailLevelOf } from "./trailing-stop";
import { stopLossPrice, type DcaParams } from "./dca";
import { fromDecimalString, toDecimalString } from "../shared/money";

// ---------------------------------------------------------------------------
// 1. The type mirror, pinned in both directions
// ---------------------------------------------------------------------------

/** What the Worker really emits, taken from the real serializer's return type. */
type WorkerPosition = ReturnType<typeof botSummary>["position"];

/**
 * ⚠ THE TWO-WAY TYPE PIN this file exists for.
 *
 * These make the two shapes a COMPILE ERROR to diverge in either direction: a
 * variant or field added to `positionOf` and not mirrored fails the first, and a
 * variant or field invented in the dashboard's copy fails the second. Neither
 * project's own build would have caught either.
 */
const _positionsAgree: Position | null = null as unknown as WorkerPosition;
const _positionsAgreeBack: WorkerPosition = null as unknown as Position | null;
void _positionsAgree;
void _positionsAgreeBack;

describe("the dashboard's Position mirror", () => {
  it("carries a trailing_stop variant at all", () => {
    // A value-level assertion beside the type-level one, so the variant's
    // presence is visible in test output rather than only in a compile step.
    const sample: Position = {
      strategy: "trailing_stop",
      heldQuantity: "1.00000000",
      averageEntryPrice: "100.00000000",
      cost: "100.00000000",
      realizedGross: "0.00000000",
      highWaterMark: "120.00000000",
      trailLevel: "114.00000000",
    };
    expect(sample.strategy).toBe("trailing_stop");
  });

  it("allows the pre-first-price shape, where both derived figures are null", () => {
    const sample: Position = {
      strategy: "trailing_stop",
      heldQuantity: "0.00000000",
      averageEntryPrice: "0.00000000",
      cost: "0.00000000",
      realizedGross: "0.00000000",
      highWaterMark: null,
      trailLevel: null,
    };
    expect(sample.highWaterMark).toBeNull();
    expect(sample.trailLevel).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 2. The formula, cross-checked against the strategy module's own
// ---------------------------------------------------------------------------

/** A full DcaParams carrying the one field `stopLossPrice` reads. */
function paramsWithStopLoss(pct: string): DcaParams {
  return {
    baseOrderSize: fromDecimalString("100"),
    additionalOrderSize: fromDecimalString("100"),
    stepMultiplier: fromDecimalString("1"),
    dropPct: fromDecimalString("2"),
    maxAdditionalBuys: 3,
    takeProfitPct: fromDecimalString("5"),
    stopLossPct: fromDecimalString(pct),
    autoRestart: false,
    sellOnStopLoss: false,
  };
}

/**
 * Deliberately awkward inputs, not round numbers, matching the sibling parity
 * tests' reasoning: the risk is a LAST-DIGIT disagreement, which round numbers
 * cannot expose.
 */
const CASES: readonly (readonly [mark: string, pct: string])[] = [
  ["100", "2"],
  ["0.00000001", "2"],
  ["99829.54180779", "1.5"],
  ["31415.92653589", "0.00000001"],
  ["1.00000001", "0.5"],
  ["67890.12345678", "3.33333333"],
  ["12345678.87654321", "12.5"],
  ["7.77777777", "0.07"],
  ["0.00012345", "20"],
];

describe("the trail level is the same arithmetic the strategies use for a stop", () => {
  it("agrees with `stopLossPrice` on every case, to the last digit", () => {
    // `trailLevelOf` mirrors the private `applyPercent` that `dca.ts` and
    // `grid.ts` each carry their own copy of. `stopLossPrice` is that helper
    // applied as `applyPercent(base, -pct, "ceil")` -- exactly what a trail level
    // is. Running both over the same inputs is what makes the mirror safe.
    for (const [mark, pct] of CASES) {
      const trail = trailLevelOf(fromDecimalString(mark), fromDecimalString(pct));
      const stop = stopLossPrice(paramsWithStopLoss(pct), fromDecimalString(mark));
      expect(toDecimalString(trail)).toBe(toDecimalString(stop));
    }
  });

  it("never returns a level above the mark it trails, for any case", () => {
    // The property the formula exists for, asserted independently of the
    // cross-check: a trailing stop that sat ABOVE its own high-water mark would
    // trigger instantly on the candle that set the high.
    for (const [mark, pct] of CASES) {
      const markValue = fromDecimalString(mark);
      expect(trailLevelOf(markValue, fromDecimalString(pct))).toBeLessThanOrEqual(markValue);
    }
  });
});
