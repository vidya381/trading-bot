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

import type {
  BotConfig as DashboardBotConfig,
  Position,
  TrailingStopParams as DashboardTrailingStopParams,
} from "../../dashboard/src/api/types";
import { botSummary } from "../api/serialize";
import { encodeTrailingStopParams, trailLevelOf, type TrailingStopConfig } from "./trailing-stop";
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
// 1b. THE CONFIG MIRROR -- the half that was missing, and the blank page it cost
//
// Section 1 above pinned `Position` and nothing else, and `Position` was the one
// piece of the trailing-stop mirror that WAS correct. `Strategy` and `BotConfig`
// in the same file had never gained the variant, so `StrategyState.tsx`'s
// `if (grid) ... else <DcaPositionView>` type-checked for a trailing-stop bot.
// The DCA view then read `params.baseOrderSize` off `{ trailPct }`,
// `formatMoney(undefined)` threw during render, React unmounted the whole tree,
// and `/bots/bot-ts1` rendered NOTHING AT ALL -- no header, no layout.
//
// A parity test that pins one of three shapes is not a mirror guard, so the
// remaining two are pinned here on exactly the terms section 1 states: this file
// is a hand-written mirror across a `tsc` seam the root project does not
// compile, and a drift fails nothing anywhere without a pin.
// ---------------------------------------------------------------------------

describe("the dashboard's trailing-stop CONFIG mirror", () => {
  it("mirrors the params the Worker actually stores, in both directions", () => {
    /*
     * ⚠ THE TWO-WAY PIN, on the shape whose absence caused the crash.
     * `encodeTrailingStopParams` is what a stored config's params go through, and
     * `jsonSafe` leaves its strings alone -- so its output IS what the dashboard
     * receives. A field added to the params and not mirrored fails the first
     * assignment; a field invented in the dashboard's copy fails the second.
     */
    type WorkerParamsJson = Omit<ReturnType<typeof encodeTrailingStopParams>, "strategy" | "schemaVersion">;
    const _paramsAgree: DashboardTrailingStopParams = null as unknown as WorkerParamsJson;
    const _paramsAgreeBack: WorkerParamsJson = null as unknown as DashboardTrailingStopParams;
    void _paramsAgree;
    void _paramsAgreeBack;

    // The value-level half, so the shape is visible in test output rather than
    // only in a compile step.
    const encoded = encodeTrailingStopParams({ trailPct: fromDecimalString("10") });
    expect(Object.keys(encoded).sort()).toEqual(["schemaVersion", "strategy", "trailPct"]);
    expect(encoded.trailPct).toBe("10.00000000");
  });

  it("⚠ carries a trailing_stop arm on BotConfig at all -- the arm that was missing", () => {
    /*
     * The assignment below is the whole test. Before the fix `DashboardBotConfig`
     * had two arms and this line would not compile, which is precisely the state
     * the dashboard shipped in: the Worker could hand the detail page a config
     * the page's own types said could not exist, and the `else` swallowed it.
     */
    const config: TrailingStopConfig = {
      strategy: "trailing_stop",
      schemaVersion: 1,
      botInstanceId: "bot-ts1",
      accountLabel: "gemini-main",
      exchange: "gemini",
      pair: "BTCUSD",
      capitalAsset: "USD",
      allocatedCapital: fromDecimalString("500"),
      params: { trailPct: fromDecimalString("10") },
    };

    // What `jsonSafe` makes of it: every Money becomes its decimal string and
    // nothing else moves. Hand-applied here rather than imported, because the
    // point is the SHAPE the dashboard's type must accept.
    const published: DashboardBotConfig = {
      ...config,
      allocatedCapital: toDecimalString(config.allocatedCapital),
      params: { trailPct: toDecimalString(config.params.trailPct) },
    };

    expect(published.strategy).toBe("trailing_stop");
    // And the discriminator really does narrow to the trailing-stop params on
    // the dashboard side -- the narrowing `StrategyState` now depends on.
    if (published.strategy === "trailing_stop") {
      expect(published.params.trailPct).toBe("10.00000000");
    } else {
      expect.unreachable("the trailing_stop discriminator did not narrow");
    }
  });

  it("the dashboard's Strategy union admits trailing_stop", () => {
    // A list-view row, a detail page and the create form all key off this union.
    // It is asserted separately from `BotConfig` because the two were BOTH
    // missing the variant and either alone would have kept the page blank.
    const strategy: import("../../dashboard/src/api/types").Strategy = "trailing_stop";
    expect(strategy).toBe("trailing_stop");
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
