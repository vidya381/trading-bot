/**
 * The dashboard's derived take-profit price must equal the price the BOT
 * actually sells at.
 *
 * `dashboard/src/derive.ts` displays "Take-profit at: $X" on the bot detail
 * view. It cannot call `takeProfitPrice` below directly -- the dashboard's
 * `tsconfig.app.json` sets `noUnusedLocals`, which fails on a dead import in
 * `dca.ts` -- so it mirrors `applyPercent` in one documented line instead.
 *
 * A MIRROR IS EXACTLY WHAT FAILS SILENTLY. If the rounding mode or the formula
 * here changed, nothing would throw and nothing would fail to compile: the
 * detail view would simply show an operator a sell price a rounding step away
 * from the one the bot compares against, on a screen read to decide whether to
 * intervene. That is the same failure mode the `alert-types.ts` crossing was
 * made to close (18.1 addendum), and this test closes it the same way -- by
 * running BOTH implementations over the same inputs and asserting they agree.
 *
 * The test lives here, in the Worker's suite, importing the dashboard's module,
 * for the reason `shared/alert-types.test.ts` already established: the dashboard
 * has no test runner of its own. `derive.ts` is plain TypeScript with no React,
 * so it imports cleanly.
 */

import { describe, expect, it } from "vitest";
import { takeProfitPriceOf, unrealizedPnl } from "../../dashboard/src/derive";
import { takeProfitPrice, type DcaParams } from "./dca";
import { fromDecimalString, mul, toDecimalString, ZERO } from "../shared/money";

/** A full DcaParams carrying the one field the threshold reads. */
function paramsWithTakeProfit(pct: string): DcaParams {
  return {
    baseOrderSize: fromDecimalString("100"),
    additionalOrderSize: fromDecimalString("100"),
    stepMultiplier: fromDecimalString("1"),
    dropPct: fromDecimalString("2"),
    maxAdditionalBuys: 3,
    takeProfitPct: fromDecimalString(pct),
    stopLossPct: fromDecimalString("20"),
    autoRestart: false,
    sellOnStopLoss: false,
  };
}

/**
 * Deliberately awkward inputs, not round numbers: the whole risk being tested is
 * a LAST-DIGIT disagreement, which round numbers cannot expose. Includes the
 * 8-decimal minimum tick, a percentage below one, and a price large enough that
 * a float would already have lost the low digits.
 */
const CASES: readonly (readonly [avg: string, pct: string])[] = [
  ["100", "2"],
  ["0.00000001", "2"],
  ["99829.54180779", "1.5"],
  ["31415.92653589", "0.00000001"],
  ["1.00000001", "0.5"],
  ["67890.12345678", "3.33333333"],
  ["12345678.87654321", "12.5"],
  ["0.00012345", "100"],
  ["7.77777777", "0.07"],
];

describe("dashboard take-profit price parity", () => {
  it.each(CASES)("agrees with takeProfitPrice for avg=%s pct=%s", (avg, pct) => {
    const expected = toDecimalString(takeProfitPrice(paramsWithTakeProfit(pct), fromDecimalString(avg)));
    expect(takeProfitPriceOf(avg, pct)).toBe(expected);
  });

  it("rounds up rather than to nearest, so the gain is at least what was configured", () => {
    // Chosen so the exact product falls between two representable prices: a
    // half-even or floor mirror would return one tick lower and this fails.
    const avg = "1.00000001";
    const pct = "0.00000001";
    const exact = takeProfitPriceOf(avg, pct);
    expect(exact).toBe(toDecimalString(takeProfitPrice(paramsWithTakeProfit(pct), fromDecimalString(avg))));
    // And it is strictly above the entry, never equal to it.
    expect(fromDecimalString(exact!)).toBeGreaterThan(fromDecimalString(avg));
  });

  it("has no price to show before the first entry, rather than showing zero", () => {
    // A zero average entry is a bot holding nothing. Returning "0.00000000"
    // would render as "sells at any price".
    expect(takeProfitPriceOf("0.00000000", "2")).toBeNull();
  });
});

describe("dashboard unrealized PnL", () => {
  it("values the position with the SAME call and rounding the books use for cost", () => {
    // `applyFill` records cost as mul(price, quantity, "half-even")
    // (NOTIONAL_ROUNDING in shared/order-state.ts) and grid.ts's buy branch does
    // the same. A different mode here would make a flat position show a
    // non-zero profit at the last digit.
    const quantity = "0.33333333";
    const price = "99829.54180779";
    const pnl = unrealizedPnl(quantity, "0", price);
    const booksWould = mul(fromDecimalString(price), fromDecimalString(quantity), "half-even");
    expect(pnl!.value).toBe(toDecimalString(booksWould));
  });

  /*
   * The case above does NOT actually pin the rounding mode -- its product is
   * exact, so every mode agrees on it. Found by mutation testing: swapping
   * half-even for floor left all sixteen tests green. These two do pin it, by
   * landing the product exactly ON a half, where the modes provably differ:
   *
   *   1.5 x 0.00000001 -> quotient 1 remainder 1/2  (quotient ODD)
   *   2.5 x 0.00000001 -> quotient 2 remainder 1/2  (quotient EVEN)
   *
   * half-even resolves the two ties in opposite directions relative to the
   * quotient (away on the odd one, stay on the even one), which is what lets
   * them exclude different wrong modes -- floor and trunc fail the odd case,
   * ceil and half-up fail the even one. Both happen to expect the same string;
   * that coincidence is why one case alone would not be enough.
   */
  it.each([
    ["1.50000000", "0.00000002"],
    ["2.50000000", "0.00000002"],
  ])("breaks a half-way product exactly as half-even does (price %s)", (price, expected) => {
    expect(unrealizedPnl("0.00000001", "0", price)!.value).toBe(expected);
  });

  it("reports exactly zero when the current price equals the average entry", () => {
    // The round-trip that would expose a rounding mismatch: buy at a price,
    // mark at the same price, and the profit must be 0 to the last digit.
    const quantity = "0.12345678";
    const price = "67890.12345678";
    const cost = toDecimalString(mul(fromDecimalString(price), fromDecimalString(quantity), "half-even"));
    const pnl = unrealizedPnl(quantity, cost, price);
    expect(pnl!.amount).toBe(toDecimalString(ZERO));
    expect(pnl!.pct).toBe(toDecimalString(ZERO));
  });

  it("is POSITIVE for a gain and NEGATIVE for a loss", () => {
    // The sign convention the detail view's colouring depends on. Asserted
    // rather than assumed, because an inverted sign is invisible in a build.
    const up = unrealizedPnl("2", "100", "60");
    expect(up!.amount).toBe(toDecimalString(fromDecimalString("20")));
    expect(up!.pct).toBe(toDecimalString(fromDecimalString("20")));

    const down = unrealizedPnl("2", "100", "40");
    expect(down!.amount).toBe(toDecimalString(fromDecimalString("-20")));
    expect(down!.pct).toBe(toDecimalString(fromDecimalString("-20")));
  });

  it("has nothing to state without a price or without a position", () => {
    // Section 5.6 applied to a derived figure: an unusable price is reported as
    // absent, never guessed at. And a flat bot has no profit to have.
    expect(unrealizedPnl("2", "100", null)).toBeNull();
    expect(unrealizedPnl("0.00000000", "0.00000000", "60")).toBeNull();
  });

  it("omits the percentage, but not the amount, when the cost basis is zero", () => {
    // Divide-by-zero is a real reachable state: a position acquired at a price
    // that rounds its notional to nothing. The amount is still meaningful.
    const pnl = unrealizedPnl("1", "0.00000000", "50");
    expect(pnl!.pct).toBeNull();
    expect(pnl!.amount).toBe(toDecimalString(fromDecimalString("50")));
  });
});
