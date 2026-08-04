/**
 * The dashboard's DISPLAY-ROUNDING rules (`dashboard/src/format.ts`).
 *
 * Tested from the Worker's suite for the same reason
 * `strategies/dca-dashboard-parity.test.ts` is: the dashboard has no test runner
 * of its own, and `format.ts` is dependency-free, so it compiles unchanged in
 * this toolchain (the same terms on which `derive.ts` and `driftAlerts.ts`
 * already cross the seam -- 18.1 addendum).
 *
 * WHAT THESE PIN, and why it is worth pinning at all for a "cosmetic" module:
 * these functions decide what a human reads before deciding whether to
 * intervene on real money. Two properties in particular are load-bearing and
 * neither is obvious from the code:
 *
 *   1. NOTHING NON-ZERO EVER RENDERS AS ZERO. Two decimals is right for USD and
 *      catastrophic for an asset priced below a cent; the helpers widen rather
 *      than show "0.00" for a real value.
 *   2. NO FLOAT IS EVER CONSTRUCTED. Every case below is checked as an exact
 *      string, so a regression to `Number(...).toFixed(2)` -- which would agree
 *      on most of these -- fails on the large and half-way cases.
 */

import { describe, expect, it } from "vitest";
import {
  baseAssetOf,
  formatMoney,
  formatPercent,
  formatQuantity,
} from "../../dashboard/src/format";
import { toDecimalString } from "./money";

describe("formatMoney", () => {
  it("rounds a full-scale price to two places", () => {
    // The figure from the bug report: a real price rendered at SCALE 8.
    expect(formatMoney("66116.13259921")).toBe("66116.13");
  });

  it("pads to exactly two places so a column lines up", () => {
    expect(formatMoney("500.00000000")).toBe("500.00");
    expect(formatMoney("500")).toBe("500.00");
    expect(formatMoney("12.5")).toBe("12.50");
    expect(formatMoney("0")).toBe("0.00");
  });

  it("rounds half-up, and carries into the integer part", () => {
    expect(formatMoney("1.005")).toBe("1.01");
    expect(formatMoney("1.004")).toBe("1.00");
    expect(formatMoney("9.999")).toBe("10.00");
  });

  it("keeps the sign, and never renders a negative zero", () => {
    expect(formatMoney("-0.05783555")).toBe("-0.06");
    // Rounds to nothing at two places: a loss too small to show is not
    // displayed as "-0.00", but it is not hidden either (see the widening test).
    expect(formatMoney("-0.00000001")).toBe("-0.00000001");
  });

  it("WIDENS rather than render a real value as zero", () => {
    // A sub-cent asset. "0.00" here would be a false number, not a rounded one.
    expect(formatMoney("0.00002341")).toBe("0.00002341");
    expect(formatMoney("0.001")).toBe("0.001");
    // A genuine zero is still zero -- only non-zero inputs widen.
    expect(formatMoney("0.00000000")).toBe("0.00");
  });

  it("is exact past 2^53, where a float would not be", () => {
    // 9007199254740993 is Number.MAX_SAFE_INTEGER + 2; as a double it is
    // indistinguishable from ...992. The string path keeps every digit.
    expect(formatMoney("9007199254740993.00000000")).toBe("9007199254740993.00");
    expect(formatMoney("9007199254740993.999")).toBe("9007199254740994.00");
  });
});

describe("formatQuantity", () => {
  it("trims trailing zeros off the stored scale", () => {
    expect(formatQuantity("1.50000000")).toBe("1.5");
    expect(formatQuantity("0.00123400")).toBe("0.001234");
    expect(formatQuantity("500.00000000")).toBe("500");
  });

  it("keeps every significant digit the exchange can send", () => {
    // stepSize never goes below 1e-8 (money.ts), so 8 places rounds nothing
    // real -- a held quantity is what the bot would sell, and its last digits
    // must reconcile against the venue.
    expect(formatQuantity("12.34567891")).toBe("12.34567891");
    expect(formatQuantity("0.00000001")).toBe("0.00000001");
  });

  it("does not pad", () => {
    // Unlike a money column, quantities across assets share no width.
    expect(formatQuantity("2")).toBe("2");
  });

  it("keeps a negative sign", () => {
    expect(formatQuantity("-0.50000000")).toBe("-0.5");
  });
});

describe("formatPercent", () => {
  it("rounds to two places and attaches the sign", () => {
    expect(formatPercent("3.21400000")).toBe("3.21%");
    expect(formatPercent("-0.12345678")).toBe("-0.12%");
  });

  it("trims a whole percentage to its integer form", () => {
    // A configured "20%" should not read "20.00%".
    expect(formatPercent("20.00000000")).toBe("20%");
    expect(formatPercent("2.50000000")).toBe("2.5%");
  });

  it("widens rather than report a real move as no move", () => {
    expect(formatPercent("0.001")).toBe("0.001%");
    expect(formatPercent("0.00000000")).toBe("0%");
  });
});

describe("the money contract these rules consume", () => {
  it("accepts `toDecimalString` output, which is what the API sends", () => {
    // Every money value on the wire is exactly this shape (types.ts). The
    // display rules must handle it without a parse step of their own.
    expect(formatMoney(toDecimalString(66116_13259921n))).toBe("66116.13");
    expect(formatQuantity(toDecimalString(150000000n))).toBe("1.5");
    expect(formatMoney(toDecimalString(0n))).toBe("0.00");
    expect(formatMoney(toDecimalString(-5783555n))).toBe("-0.06");
  });
});

describe("baseAssetOf", () => {
  it("strips the quote suffix off a concatenated symbol", () => {
    expect(baseAssetOf("BTCUSDT", "USDT")).toBe("BTC");
    expect(baseAssetOf("ETHUSD", "USD")).toBe("ETH");
  });

  it("falls back to the raw pair when the suffix does not match", () => {
    // Never invent an asset name: showing the pair is honest, "BTC" would not be.
    expect(baseAssetOf("BTC-USD", "USD")).toBe("BTC-");
    expect(baseAssetOf("BTCUSDT", "EUR")).toBe("BTCUSDT");
    expect(baseAssetOf("USD", "USD")).toBe("USD");
    expect(baseAssetOf("BTCUSDT", "")).toBe("BTCUSDT");
  });
});
