import { describe, expect, it } from "vitest";
import {
  abs,
  applyRate,
  clamp,
  div,
  divInt,
  divideRounded,
  fromDecimalString,
  fromStorageString,
  INT64_MAX,
  INT64_MIN,
  isMultipleOf,
  isStorable,
  max,
  min,
  MoneyError,
  mul,
  mulInt,
  ONE,
  percentToRate,
  roundDownToStep,
  roundToStep,
  signOf,
  sum,
  toDecimalString,
  toStorageString,
  toTrimmedString,
  type Money,
  type Rounding,
} from "./money";

describe("fromDecimalString", () => {
  it("scales a whole number by 10^8", () => {
    expect(fromDecimalString("1")).toBe(100_000_000n);
    expect(fromDecimalString("0")).toBe(0n);
    expect(fromDecimalString("43120")).toBe(4_312_000_000_000n);
  });

  it("pads a short fractional part to the full scale", () => {
    expect(fromDecimalString("43120.50")).toBe(4_312_050_000_000n);
    expect(fromDecimalString("0.1")).toBe(10_000_000n);
  });

  it("represents the smallest exchange increment exactly", () => {
    // Binance tickSize and stepSize never go below 1e-8.
    expect(fromDecimalString("0.00000001")).toBe(1n);
  });

  it("handles negatives, including sub-unit ones", () => {
    expect(fromDecimalString("-1")).toBe(-100_000_000n);
    expect(fromDecimalString("-0.00000001")).toBe(-1n);
    expect(fromDecimalString("-0")).toBe(0n);
  });

  it("accepts an explicit plus sign and leading zeros", () => {
    expect(fromDecimalString("+1.5")).toBe(150_000_000n);
    expect(fromDecimalString("007.5")).toBe(750_000_000n);
  });

  it("parses values far beyond Number.MAX_SAFE_INTEGER without loss", () => {
    // 1e9 tokens at scale 8 is 1e17, well past 2^53.
    expect(fromDecimalString("1000000000")).toBe(100_000_000_000_000_000n);
  });

  it("rejects more decimal places than the scale supports", () => {
    // Silently truncating here is the exact bug class this module prevents.
    expect(() => fromDecimalString("1.123456789")).toThrow(MoneyError);
    expect(() => fromDecimalString("1.123456789")).toThrow(/more than the supported 8/);
  });

  it("accepts exactly the scale's worth of decimals", () => {
    expect(fromDecimalString("1.12345678")).toBe(112_345_678n);
  });

  it.each([
    ["empty", ""],
    ["bare dot", "."],
    ["trailing dot", "1."],
    ["leading dot", ".5"],
    ["scientific notation", "1e8"],
    ["leading whitespace", " 1.5"],
    ["trailing whitespace", "1.5 "],
    ["comma separator", "1,000.5"],
    ["not a number", "abc"],
    ["NaN", "NaN"],
    ["Infinity", "Infinity"],
    ["double sign", "--1"],
  ])("rejects %s", (_label, input) => {
    expect(() => fromDecimalString(input)).toThrow(MoneyError);
  });

  it("refuses a non-string, so no float can enter through this door", () => {
    expect(() => fromDecimalString(1.5 as unknown as string)).toThrow(MoneyError);
  });
});

describe("toDecimalString", () => {
  it("always renders exactly SCALE decimal places", () => {
    expect(toDecimalString(4_312_050_000_000n)).toBe("43120.50000000");
    expect(toDecimalString(0n)).toBe("0.00000000");
    expect(toDecimalString(100_000_000n)).toBe("1.00000000");
  });

  it("renders sub-unit and negative values correctly", () => {
    expect(toDecimalString(1n)).toBe("0.00000001");
    expect(toDecimalString(-1n)).toBe("-0.00000001");
    expect(toDecimalString(-150_000_000n)).toBe("-1.50000000");
  });

  it("round-trips with fromDecimalString", () => {
    for (const input of ["0", "1", "43120.5", "-0.00000001", "999999.12345678"]) {
      expect(toDecimalString(fromDecimalString(input))).toBe(
        toDecimalString(fromDecimalString(toDecimalString(fromDecimalString(input)))),
      );
    }
  });
});

describe("toTrimmedString", () => {
  it("drops trailing fractional zeros", () => {
    expect(toTrimmedString(fromDecimalString("43120.50"))).toBe("43120.5");
    expect(toTrimmedString(fromDecimalString("1"))).toBe("1");
    expect(toTrimmedString(fromDecimalString("1.10000000"))).toBe("1.1");
  });

  it("renders zero as a bare 0 rather than an empty string", () => {
    expect(toTrimmedString(0n)).toBe("0");
  });

  it("keeps significant trailing digits", () => {
    expect(toTrimmedString(1n)).toBe("0.00000001");
    expect(toTrimmedString(-1n)).toBe("-0.00000001");
  });
});

describe("storage encoding", () => {
  it("encodes the raw scaled integer, not the decimal form", () => {
    expect(toStorageString(fromDecimalString("43120.50"))).toBe("4312050000000");
  });

  it("round-trips exactly above 2^53, where a D1 number read would not", () => {
    const big = fromDecimalString("1000000000.00000001"); // 1e17 + 1
    expect(fromStorageString(toStorageString(big))).toBe(big);
    // Demonstrates why reads must CAST to TEXT: routing the same value
    // through a JS number, as a plain D1 INTEGER read does, loses the last
    // digit. This is the measured D1 behaviour, reproduced here as a guard.
    expect(BigInt(Number(big))).not.toBe(big);
    expect(BigInt(Number(big))).toBe(100_000_000_000_000_000n);
  });

  it("round-trips negatives", () => {
    const value = fromDecimalString("-7300000.00000003");
    expect(fromStorageString(toStorageString(value))).toBe(value);
  });

  it("accepts the exact signed 64-bit bounds", () => {
    expect(toStorageString(INT64_MAX)).toBe(INT64_MAX.toString());
    expect(toStorageString(INT64_MIN)).toBe(INT64_MIN.toString());
  });

  it("refuses a value D1 could not hold, rather than letting it corrupt", () => {
    expect(() => toStorageString(INT64_MAX + 1n)).toThrow(MoneyError);
    expect(() => toStorageString(INT64_MIN - 1n)).toThrow(/signed 64-bit/);
  });

  it("reports storability without throwing", () => {
    expect(isStorable(INT64_MAX)).toBe(true);
    expect(isStorable(INT64_MAX + 1n)).toBe(false);
  });

  it("rejects a malformed stored value", () => {
    expect(() => fromStorageString("12.5")).toThrow(MoneyError);
    expect(() => fromStorageString("")).toThrow(MoneyError);
    expect(() => fromStorageString("abc")).toThrow(MoneyError);
  });
});

describe("divideRounded", () => {
  it("returns an exact quotient regardless of mode", () => {
    const modes: Rounding[] = ["exact", "trunc", "floor", "ceil", "half-up", "half-even"];
    for (const mode of modes) {
      expect(divideRounded(10n, 2n, mode)).toBe(5n);
      expect(divideRounded(-10n, 2n, mode)).toBe(-5n);
    }
  });

  it('throws under "exact" when the result would lose precision', () => {
    expect(() => divideRounded(7n, 2n, "exact")).toThrow(MoneyError);
    expect(() => divideRounded(7n, 2n, "exact")).toThrow(/not exact/);
  });

  // 7/2 = 3.5 and -7/2 = -3.5, the case where every mode differs.
  it.each<[Rounding, bigint, bigint]>([
    ["trunc", 3n, -3n],
    ["floor", 3n, -4n],
    ["ceil", 4n, -3n],
    ["half-up", 4n, -4n],
    ["half-even", 4n, -4n],
  ])("%s rounds 3.5 to %s and -3.5 to %s", (mode, positive, negative) => {
    expect(divideRounded(7n, 2n, mode)).toBe(positive);
    expect(divideRounded(-7n, 2n, mode)).toBe(negative);
  });

  it("applies banker's rounding to the even neighbour on exact halves", () => {
    expect(divideRounded(5n, 2n, "half-even")).toBe(2n); // 2.5 -> 2, not 3
    expect(divideRounded(7n, 2n, "half-even")).toBe(4n); // 3.5 -> 4
    expect(divideRounded(-5n, 2n, "half-even")).toBe(-2n);
    expect(divideRounded(-7n, 2n, "half-even")).toBe(-4n);
  });

  it("rounds non-half remainders to the nearer side", () => {
    expect(divideRounded(1n, 3n, "half-up")).toBe(0n); // 0.33
    expect(divideRounded(2n, 3n, "half-up")).toBe(1n); // 0.67
    expect(divideRounded(-2n, 3n, "half-up")).toBe(-1n);
  });

  it("handles a negative denominator with the correct result sign", () => {
    // 7 / -2 = -3.5
    expect(divideRounded(7n, -2n, "floor")).toBe(-4n);
    expect(divideRounded(7n, -2n, "ceil")).toBe(-3n);
    expect(divideRounded(-7n, -2n, "floor")).toBe(3n);
  });

  it("throws on division by zero", () => {
    expect(() => divideRounded(1n, 0n, "trunc")).toThrow(MoneyError);
  });
});

describe("mul", () => {
  it("rescales the product back to SCALE", () => {
    const price = fromDecimalString("43120.50");
    const quantity = fromDecimalString("0.125");
    // 43120.50 * 0.125 = 5390.0625, exactly representable.
    expect(mul(price, quantity, "exact")).toBe(fromDecimalString("5390.0625"));
  });

  it("is exact for a notional that would overflow a float integer", () => {
    // Both operands at scale 8 make the intermediate product scale 16, which
    // is past Number.MAX_SAFE_INTEGER. bigint holds it exactly.
    const price = fromDecimalString("43120.50");
    const quantity = fromDecimalString("1000.00000000");
    expect(mul(price, quantity, "exact")).toBe(fromDecimalString("43120500"));
  });

  it("requires an explicit rounding mode when the product is inexact", () => {
    const a = fromDecimalString("0.00000001");
    const b = fromDecimalString("0.5");
    // 1e-8 * 0.5 = 5e-9, below the representable scale.
    expect(() => mul(a, b, "exact")).toThrow(MoneyError);
    expect(mul(a, b, "floor")).toBe(0n);
    expect(mul(a, b, "ceil")).toBe(1n);
    expect(mul(a, b, "half-up")).toBe(1n);
  });

  it("multiplying by one is the identity", () => {
    const value = fromDecimalString("123.456");
    expect(mul(value, ONE, "exact")).toBe(value);
  });

  it("handles sign correctly", () => {
    expect(mul(fromDecimalString("-2"), fromDecimalString("3"), "exact")).toBe(
      fromDecimalString("-6"),
    );
    expect(mul(fromDecimalString("-2"), fromDecimalString("-3"), "exact")).toBe(
      fromDecimalString("6"),
    );
  });
});

describe("div", () => {
  it("divides two Money values into a Money ratio", () => {
    expect(div(fromDecimalString("10"), fromDecimalString("4"), "exact")).toBe(
      fromDecimalString("2.5"),
    );
  });

  it("truncates a repeating result according to the named mode", () => {
    const third = div(fromDecimalString("1"), fromDecimalString("3"), "floor");
    expect(toDecimalString(third)).toBe("0.33333333");
    expect(div(fromDecimalString("1"), fromDecimalString("3"), "ceil")).toBe(third + 1n);
  });

  it("dividing by one is the identity", () => {
    const value = fromDecimalString("123.456");
    expect(div(value, ONE, "exact")).toBe(value);
  });

  it("throws on division by zero", () => {
    expect(() => div(ONE, 0n, "floor")).toThrow(MoneyError);
  });
});

describe("integer scaling helpers", () => {
  it("mulInt scales by an exact count without rescaling", () => {
    const orderSize = fromDecimalString("0.05");
    expect(mulInt(orderSize, 20n)).toBe(fromDecimalString("1"));
  });

  it("divInt splits into equal parts with explicit rounding", () => {
    expect(divInt(fromDecimalString("1"), 3n, "floor")).toBe(33_333_333n);
    expect(divInt(fromDecimalString("1"), 4n, "exact")).toBe(fromDecimalString("0.25"));
  });
});

describe("roundToStep", () => {
  const tickSize = fromDecimalString("0.01");

  it("rounds to a multiple of the step in the named direction", () => {
    const value = fromDecimalString("1.23456789");
    expect(roundToStep(value, tickSize, "floor")).toBe(fromDecimalString("1.23"));
    expect(roundToStep(value, tickSize, "ceil")).toBe(fromDecimalString("1.24"));
    expect(roundToStep(value, tickSize, "half-up")).toBe(fromDecimalString("1.23"));
  });

  it("leaves an exact multiple untouched", () => {
    const value = fromDecimalString("1.23");
    expect(roundToStep(value, tickSize, "exact")).toBe(value);
  });

  it("rounds quantities down by default, so a fill cannot exceed the balance", () => {
    const stepSize = fromDecimalString("0.00001");
    expect(roundDownToStep(fromDecimalString("0.12345678"), stepSize)).toBe(
      fromDecimalString("0.12345"),
    );
  });

  it("rounds a negative value toward negative infinity under floor", () => {
    expect(roundToStep(fromDecimalString("-1.234"), tickSize, "floor")).toBe(
      fromDecimalString("-1.24"),
    );
  });

  it("rejects a non-positive step", () => {
    expect(() => roundToStep(ONE, 0n, "floor")).toThrow(MoneyError);
    expect(() => roundToStep(ONE, -1n, "floor")).toThrow(MoneyError);
  });

  it("isMultipleOf detects exact step alignment", () => {
    expect(isMultipleOf(fromDecimalString("1.23"), tickSize)).toBe(true);
    expect(isMultipleOf(fromDecimalString("1.234"), tickSize)).toBe(false);
    expect(() => isMultipleOf(ONE, 0n)).toThrow(MoneyError);
  });
});

describe("percentages", () => {
  it("converts a percentage to a rate", () => {
    expect(percentToRate(fromDecimalString("2.5"), "exact")).toBe(
      fromDecimalString("0.025"),
    );
    expect(percentToRate(fromDecimalString("100"), "exact")).toBe(fromDecimalString("1"));
  });

  it("applies a rate to a value", () => {
    const balance = fromDecimalString("1000");
    const rate = percentToRate(fromDecimalString("2.5"), "exact");
    expect(applyRate(balance, rate, "exact")).toBe(fromDecimalString("25"));
  });

  it("computes a stop-loss threshold exactly", () => {
    // A 5% stop below an average entry of 43120.50.
    const entry = fromDecimalString("43120.50");
    const rate = percentToRate(fromDecimalString("5"), "exact");
    const drop = applyRate(entry, rate, "half-up");
    expect(toDecimalString(entry - drop)).toBe("40964.47500000");
  });
});

describe("utilities", () => {
  it("abs and signOf", () => {
    expect(abs(-5n)).toBe(5n);
    expect(abs(5n)).toBe(5n);
    expect(signOf(-1n)).toBe(-1);
    expect(signOf(0n)).toBe(0);
    expect(signOf(1n)).toBe(1);
  });

  it("min, max and clamp", () => {
    expect(min(1n, 2n)).toBe(1n);
    expect(max(1n, 2n)).toBe(2n);
    expect(clamp(5n, 1n, 3n)).toBe(3n);
    expect(clamp(0n, 1n, 3n)).toBe(1n);
    expect(clamp(2n, 1n, 3n)).toBe(2n);
    expect(() => clamp(2n, 3n, 1n)).toThrow(MoneyError);
  });

  it("sums exactly, including an empty list", () => {
    const values: Money[] = [
      fromDecimalString("0.1"),
      fromDecimalString("0.2"),
      fromDecimalString("-0.05"),
    ];
    // The float equivalent of 0.1 + 0.2 is 0.30000000000000004.
    expect(sum(values)).toBe(fromDecimalString("0.25"));
    expect(sum([])).toBe(0n);
  });

  it("adds and subtracts exactly with native operators", () => {
    // Addition needs no wrapper: bigint + is already exact.
    expect(fromDecimalString("0.1") + fromDecimalString("0.2")).toBe(
      fromDecimalString("0.3"),
    );
  });
});
