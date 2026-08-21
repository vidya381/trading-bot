/**
 * The "Grid step" figure on the bot detail view must equal the gap the BOT's own
 * default breakout threshold is measured in.
 *
 * `dashboard/src/derive.ts`'s `gridStepOf` displays the ladder's top rung gap in
 * the grid configuration block. It cannot call `topRungGap` below directly --
 * `tsc -b` on the dashboard fails with `error TS6196: 'Timestamp' is declared but
 * never used` in `grid.ts`, because the dashboard sets `noUnusedLocals` where the
 * Worker does not (verified by building, not assumed) -- so it mirrors the
 * subtraction instead.
 *
 * A MIRROR IS EXACTLY WHAT FAILS SILENTLY, which is why this file exists at all
 * and why it is a near-copy of `dca-dashboard-parity.test.ts`. The number matters
 * because of what it is shown NEXT TO: when `breakoutThresholdPct` is null the
 * bot halts at `highest line + topRungGap` (spec 6.2 step 5, decision log 09's
 * decision 4), and the detail view now words that null case as "one grid step
 * above the top line" and prints this figure beside it. An operator adds the two
 * to check a breakout halt alert against the page. A grid step that disagreed
 * with the backend's by a rounding step would make that addition wrong on the one
 * screen read to decide whether to intervene.
 *
 * ⚠ WHAT THIS DOES *NOT* PIN, deliberately. The dashboard has no copy of
 * `breakoutPrice`, so nothing here asserts a displayed breakout PRICE -- there
 * isn't one. Re-deriving that formula (an `applyPercent` with a ceil) client-side
 * was the option NOT taken; showing the gap and leaving the addition to the
 * reader is what replaced it. If a future change adds a "Breakout at $X" row,
 * this file is where its parity assertion belongs.
 *
 * The test lives here, in the Worker's suite, importing the dashboard's module,
 * for the reason `shared/alert-types.test.ts` and the DCA parity file already
 * established: the dashboard has no test runner of its own. `derive.ts` is plain
 * TypeScript with no React, so it imports cleanly.
 */

import { describe, expect, it } from "vitest";
import { gridStepOf } from "../../dashboard/src/derive";
import { buildLevels, topRungGap, type GridParams, type GridSpacing } from "./grid";
import { fromDecimalString, toDecimalString } from "../shared/money";

/** A full GridParams carrying the three fields `buildLevels` reads. */
function ladderParams(lower: string, upper: string, lines: number, spacing: GridSpacing): GridParams {
  return {
    upperBound: fromDecimalString(upper),
    lowerBound: fromDecimalString(lower),
    gridLines: lines,
    spacing,
    orderSize: fromDecimalString("50"),
    stopLossPct: fromDecimalString("10"),
    breakoutTakeProfit: true,
    breakoutThresholdPct: null,
    takeProfitAmount: null,
  };
}

/**
 * Deliberately awkward ladders, not round ones: the risk being tested is a
 * LAST-DIGIT disagreement, which evenly-divisible bounds cannot expose.
 * Geometric spacing is included because its interior levels are FLOORED at each
 * step while the endpoints stay pinned, so the undershoot is absorbed into the
 * top rung -- making the top gap the one least like the others, and the one a
 * naive `(upper - lower) / (lines - 1)` mirror would get wrong.
 */
const LADDERS: readonly (readonly [lower: string, upper: string, lines: number, spacing: GridSpacing])[] = [
  ["90", "110", 5, "arithmetic"],
  ["61992", "63252", 11, "arithmetic"],
  ["0.00000001", "0.00000009", 9, "arithmetic"],
  ["100", "100.00000007", 8, "arithmetic"],
  ["1234.56789012", "9876.54321098", 7, "arithmetic"],
  ["3", "7", 2, "arithmetic"],
  ["90", "110", 5, "geometric"],
  ["61992", "63252", 11, "geometric"],
  ["1", "1000", 13, "geometric"],
  ["0.00012345", "0.98765432", 6, "geometric"],
  ["19999.99999999", "20050.00000007", 4, "geometric"],
];

describe("dashboard grid step parity", () => {
  it.each(LADDERS)("agrees with topRungGap for %s..%s over %i %s lines", (lower, upper, lines, spacing) => {
    const levels = buildLevels(ladderParams(lower, upper, lines, spacing));
    const expected = toDecimalString(topRungGap(levels));
    expect(gridStepOf(levels.map(toDecimalString))).toBe(expected);
  });

  it("⚠ measures the TOP rung, not the average rung", () => {
    /*
     * The assertion that catches the most likely wrong mirror. On a geometric
     * ladder the rungs are not equal, so `(upper - lower) / (lines - 1)` -- the
     * arithmetic mean gap, and the obvious thing to write -- is a DIFFERENT
     * number from the one the breakout default uses. This case is chosen so the
     * two are far apart rather than adjacent.
     */
    const params = ladderParams("1", "1000", 13, "geometric");
    const levels = buildLevels(params);
    const meanGap = (params.upperBound - params.lowerBound) / BigInt(params.gridLines - 1);

    const step = gridStepOf(levels.map(toDecimalString));
    expect(step).toBe(toDecimalString(topRungGap(levels)));
    expect(step).not.toBe(toDecimalString(meanGap));
    // And it really is the last gap: the top two levels, subtracted.
    expect(step).toBe(toDecimalString(levels[levels.length - 1]! - levels[levels.length - 2]!));
  });

  it("⚠ reproduces the gap behind a real breakout halt", () => {
    /*
     * bot-ri6iml halted with `breakout 6337800000000, above the highest grid line
     * 6325200000000` -- raw Money at SCALE 8, i.e. 63378.00 and 63252.00, a gap
     * of 126.00. That bot's `breakoutThresholdPct` is null, so the trigger came
     * from this default branch, and the whole point of the "Grid step" row is
     * that an operator can now add it to the upper bound and land on the number
     * the alert names. The ladder below is one that produces exactly that gap.
     *
     * ⚠ THE LADDER IS RECONSTRUCTED, NOT READ FROM THE LIVE BOT. The bounds and
     * line count here reproduce the arithmetic; they are not asserted to be
     * bot-ri6iml's own, which lives in Durable Object storage this suite cannot
     * see. What is pinned is the RELATIONSHIP -- top line plus grid step equals
     * the breakout the halt-check computes -- not that bot's configuration.
     */
    const levels = buildLevels(ladderParams("61992", "63252", 11, "arithmetic"));
    expect(gridStepOf(levels.map(toDecimalString))).toBe("126.00000000");
    expect(toDecimalString(levels[levels.length - 1]!)).toBe("63252.00000000");
    // The addition the detail view now leaves to the reader.
    expect(toDecimalString(levels[levels.length - 1]! + topRungGap(levels))).toBe("63378.00000000");
  });

  it("has no gap to show for a ladder that cannot have one, rather than showing zero", () => {
    // A zero would render as "the top two lines sit on top of each other", which
    // `buildLevels` rejects as a degenerate ladder in the first place.
    expect(gridStepOf([])).toBeNull();
    expect(gridStepOf(["100.00000000"])).toBeNull();
  });

  it("degrades to null on an unparseable level rather than throwing mid-render", () => {
    // Same contract as `parse` above it: these figures are additive context, and
    // a throw here would take the whole detail page down. See derive.ts.
    expect(gridStepOf(["100.00000000", "not a number"])).toBeNull();
  });
});
