/**
 * Fixed-point money math (spec section 5.2).
 *
 * Monetary values are `bigint` integers scaled by 10^8. Native `number` is
 * never used for prices, quantities, or balances anywhere in this system.
 *
 * Why scale 8: Binance spot `tickSize` and `stepSize` never go below 1e-8, so
 * every price and quantity the exchange will accept is representable exactly.
 * It also fits SQLite's signed 64-bit INTEGER well -- the maximum storable
 * value is ~92 billion, which comfortably holds large-quantity positions.
 *
 * Why bigint rather than number: `price * quantity` scales the result by
 * 10^16, which exceeds Number.MAX_SAFE_INTEGER (9.007e15) immediately. Any
 * integer representation of money therefore has to be arbitrary-precision.
 *
 * Persistence rules, verified against the real runtime:
 *  - Durable Object storage serializes bigint natively (structured clone).
 *  - D1 `.bind()` REJECTS bigint, so writes bind `toStorageString(value)`;
 *    SQLite INTEGER affinity converts the decimal string to a true integer.
 *  - D1 returns INTEGER to JavaScript as `number`, which silently loses
 *    precision above 2^53. Reads must therefore use `CAST(col AS TEXT)` and
 *    parse with `fromStorageString`. Never read a money column directly.
 */

/** Number of decimal places every Money value is scaled by. */
export const SCALE = 8;

/** One whole unit: the scaling factor, 10^SCALE. */
export const ONE = 100_000_000n;

/** Zero, for readability at call sites. */
export const ZERO = 0n;

/**
 * A monetary value: an integer count of 10^-8 units.
 *
 * This is a transparent alias rather than a branded type. Branding would not
 * catch the error that actually matters here (mixing values of different
 * scales, which are all bigint regardless), and it would force casts through
 * every arithmetic expression at a real cost to readability.
 */
export type Money = bigint;

/** Signed 64-bit range, the limit of a SQLite INTEGER column. */
export const INT64_MIN = -(2n ** 63n);
export const INT64_MAX = 2n ** 63n - 1n;

/**
 * How to resolve a division that does not come out exact.
 *
 * There is deliberately no default anywhere in this module. The correct
 * direction is context-dependent: order quantities must round down, because
 * rounding up risks an insufficient-balance rejection, while a fee reserve
 * should round up. Forcing an explicit choice makes each of those decisions
 * visible in the diff.
 */
export type Rounding =
  /** Throw if the result is not exact. Use when precision loss is a bug. */
  | "exact"
  /** Toward zero. */
  | "trunc"
  /** Toward negative infinity. */
  | "floor"
  /** Toward positive infinity. */
  | "ceil"
  /** Nearest; exact halves go away from zero. */
  | "half-up"
  /** Nearest; exact halves go to the even neighbour (banker's rounding). */
  | "half-even";

export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MoneyError";
  }
}

// Optional sign, at least one integer digit, optionally a fractional part of
// 1..SCALE digits. Deliberately strict: no whitespace, no scientific notation,
// no bare "1." or ".5". Silent acceptance of a malformed value is exactly the
// failure mode this module exists to prevent.
const DECIMAL_PATTERN = /^([+-]?)(\d+)(?:\.(\d+))?$/;

/**
 * Parse a decimal string into Money.
 *
 * This is the only supported way to bring an external value (an exchange API
 * response, a dashboard form field) into the money system. There is no
 * conversion from `number`, by design -- that would reintroduce float error at
 * the boundary.
 *
 * @throws MoneyError on malformed input or more than SCALE decimal places.
 */
export function fromDecimalString(input: string): Money {
  if (typeof input !== "string") {
    throw new MoneyError(`expected a decimal string, got ${typeof input}`);
  }

  const match = DECIMAL_PATTERN.exec(input);
  if (match === null) {
    throw new MoneyError(`malformed decimal string: ${JSON.stringify(input)}`);
  }

  const [, sign, whole, fraction = ""] = match as unknown as [
    string,
    string,
    string,
    string | undefined,
  ];

  if (fraction.length > SCALE) {
    throw new MoneyError(
      `${JSON.stringify(input)} has ${fraction.length} decimal places, ` +
        `more than the supported ${SCALE}; rounding must be explicit`,
    );
  }

  const scaled = BigInt(whole + fraction.padEnd(SCALE, "0"));
  return sign === "-" ? -scaled : scaled;
}

/**
 * Parse a decimal string that may carry MORE precision than SCALE, resolving the
 * excess with an explicitly named `Rounding`.
 *
 * WHY THIS EXISTS. `fromDecimalString` throws on excess precision, and that is
 * right for anything this system *sends* -- a price or quantity we invented and
 * must not silently alter. It is wrong for a value an exchange *reports*, which
 * we do not control and cannot refuse. Gemini returns balances at higher
 * precision than 8 decimal places: a real sandbox response carried
 * `"99829.54180779832"` (11 places), the strict parser rejected it, and the
 * account became unreadable ENTIRELY -- no balance snapshot, no drift detection.
 * Representing it to 8 places while stating the direction is strictly better
 * than refusing to represent it at all.
 *
 * This does NOT weaken the no-silent-rounding discipline; it follows it. The
 * direction is a required argument reusing this module's existing `Rounding`
 * vocabulary (there is deliberately no default anywhere here), `"exact"` still
 * throws, and `fromDecimalString` is untouched and remains the only way to bring
 * in a value that is going back out to an exchange.
 *
 * Rounding is exact integer arithmetic on the digit string -- no float, no
 * `Number` -- so a 30-digit fraction resolves as precisely as a 9-digit one.
 *
 * @throws MoneyError on malformed input, or on excess precision when `"exact"`.
 */
export function fromDecimalStringRounded(input: string, rounding: Rounding): Money {
  if (typeof input !== "string") {
    throw new MoneyError(`expected a decimal string, got ${typeof input}`);
  }

  const match = DECIMAL_PATTERN.exec(input);
  if (match === null) {
    throw new MoneyError(`malformed decimal string: ${JSON.stringify(input)}`);
  }

  const [, sign, whole, fraction = ""] = match as unknown as [
    string,
    string,
    string,
    string | undefined,
  ];
  const negative = sign === "-";

  if (fraction.length <= SCALE) {
    // Nothing to resolve; identical to `fromDecimalString` on this input.
    const exact = BigInt(whole + fraction.padEnd(SCALE, "0"));
    return negative ? -exact : exact;
  }

  const kept = fraction.slice(0, SCALE);
  const discarded = fraction.slice(SCALE);
  const magnitude = BigInt(whole + kept);
  const lostSomething = /[1-9]/.test(discarded);

  if (!lostSomething) {
    // Trailing zeros beyond SCALE are not a loss of precision, so no rounding
    // rule may nudge the value -- and `"exact"` must NOT throw, because the
    // result IS exact. `"1.500000000"` is exactly `1.5`. This check therefore
    // comes BEFORE the `"exact"` refusal, not after it.
    return negative ? -magnitude : magnitude;
  }
  if (rounding === "exact") {
    throw new MoneyError(
      `${JSON.stringify(input)} has ${fraction.length} decimal places, more than ` +
        `the supported ${SCALE}, and "exact" rounding was requested`,
    );
  }

  // Compare the discarded tail against one half: -1 below, 0 exactly half, 1 above.
  const firstDigit = discarded.charCodeAt(0) - 48;
  const versusHalf =
    firstDigit > 5 ? 1 : firstDigit < 5 ? -1 : /[1-9]/.test(discarded.slice(1)) ? 1 : 0;

  let bumpMagnitude: boolean;
  switch (rounding) {
    case "trunc":
      bumpMagnitude = false;
      break;
    case "floor":
      // Toward negative infinity: away from zero only when negative.
      bumpMagnitude = negative;
      break;
    case "ceil":
      // Toward positive infinity: away from zero only when positive.
      bumpMagnitude = !negative;
      break;
    case "half-up":
      bumpMagnitude = versusHalf >= 0;
      break;
    case "half-even":
      bumpMagnitude = versusHalf > 0 || (versusHalf === 0 && magnitude % 2n === 1n);
      break;
  }

  const resolved = bumpMagnitude ? magnitude + 1n : magnitude;
  return negative ? -resolved : resolved;
}

/**
 * Render Money as a decimal string with exactly SCALE decimal places.
 *
 * Use this for exchange request parameters, log lines, and anything a person
 * reads. Do NOT use it for persistence -- see toStorageString.
 */
export function toDecimalString(value: Money): string {
  const negative = value < ZERO;
  const magnitude = negative ? -value : value;
  const whole = magnitude / ONE;
  const fraction = magnitude % ONE;
  return `${negative ? "-" : ""}${whole}.${fraction.toString().padStart(SCALE, "0")}`;
}

/**
 * Render Money as a decimal string with trailing fractional zeros removed.
 *
 * Some exchange endpoints reject a quantity with more decimal places than the
 * symbol's stepSize allows, so a trimmed form is occasionally required.
 */
export function toTrimmedString(value: Money): string {
  const full = toDecimalString(value);
  const trimmed = full.replace(/0+$/, "").replace(/\.$/, "");
  return trimmed === "" || trimmed === "-" ? "0" : trimmed;
}

/**
 * Render Money for persistence: the raw scaled integer as a decimal string.
 *
 * Bind this into a D1 INTEGER column. SQLite's INTEGER affinity converts it to
 * a true integer, keeping SUM() and ORDER BY numerically correct.
 *
 * @throws MoneyError if the value will not fit a signed 64-bit column, so an
 * out-of-range value fails loudly here rather than being mangled by storage.
 */
export function toStorageString(value: Money): string {
  if (value < INT64_MIN || value > INT64_MAX) {
    throw new MoneyError(
      `${value} is outside the signed 64-bit range and cannot be stored in D1`,
    );
  }
  return value.toString();
}

/**
 * Parse a value read back from storage.
 *
 * The input must come from `CAST(col AS TEXT)`, never from a D1 INTEGER read
 * directly -- D1 hands large integers back as `number` and silently loses
 * precision above 2^53.
 */
export function fromStorageString(input: string): Money {
  if (!/^[+-]?\d+$/.test(input)) {
    throw new MoneyError(`malformed stored money value: ${JSON.stringify(input)}`);
  }
  return BigInt(input);
}

/**
 * Divide with an explicit rounding mode. The primitive the rest of the module
 * is built on; exported because callers occasionally need raw ratio division.
 */
export function divideRounded(
  numerator: bigint,
  denominator: bigint,
  rounding: Rounding,
): bigint {
  if (denominator === ZERO) {
    throw new MoneyError("division by zero");
  }

  // Normalize so the denominator is positive; this keeps the remainder's sign
  // equal to the numerator's, which the mode handling below relies on.
  const n = denominator < ZERO ? -numerator : numerator;
  const d = denominator < ZERO ? -denominator : denominator;

  const quotient = n / d; // bigint division truncates toward zero
  const remainder = n % d;
  if (remainder === ZERO) {
    return quotient;
  }

  const negative = n < ZERO;
  const away = negative ? quotient - 1n : quotient + 1n;
  const twiceRemainder = (negative ? -remainder : remainder) * 2n;

  switch (rounding) {
    case "exact":
      throw new MoneyError(
        `${numerator} / ${denominator} is not exact and rounding was "exact"`,
      );
    case "trunc":
      return quotient;
    case "floor":
      return negative ? away : quotient;
    case "ceil":
      return negative ? quotient : away;
    case "half-up":
      return twiceRemainder >= d ? away : quotient;
    case "half-even":
      if (twiceRemainder > d) return away;
      if (twiceRemainder < d) return quotient;
      return quotient % 2n === ZERO ? quotient : away;
  }
}

/**
 * Multiply two Money values, rescaling the result back to SCALE.
 *
 * Use for price x quantity. The intermediate product is held at scale 16 in
 * bigint, which is arbitrary-precision in memory, so it cannot overflow.
 */
export function mul(a: Money, b: Money, rounding: Rounding): Money {
  return divideRounded(a * b, ONE, rounding);
}

/** Divide two Money values, producing a Money ratio at SCALE. */
export function div(a: Money, b: Money, rounding: Rounding): Money {
  return divideRounded(a * ONE, b, rounding);
}

/**
 * Multiply Money by an exact integer count. No rescaling and no rounding,
 * because the result is always exact -- e.g. order size x number of grid lines.
 */
export function mulInt(value: Money, count: bigint): Money {
  return value * count;
}

/** Divide Money into an exact integer number of parts. */
export function divInt(value: Money, count: bigint, rounding: Rounding): Money {
  return divideRounded(value, count, rounding);
}

/**
 * Round a value down to the nearest multiple of `step`, toward negative
 * infinity. This is the correct direction for order quantities: rounding a
 * quantity up can exceed the available balance and get the order rejected.
 */
export function roundDownToStep(value: Money, step: Money): Money {
  return roundToStep(value, step, "floor");
}

/**
 * Round a value to a multiple of `step` (a symbol's tickSize or stepSize).
 *
 * Generic fixed-point arithmetic, not exchange-specific: the caller supplies
 * the step. Applying the right filters is section 4.3's job, at step 3.
 */
export function roundToStep(value: Money, step: Money, rounding: Rounding): Money {
  if (step <= ZERO) {
    throw new MoneyError(`step must be positive, got ${step}`);
  }
  return divideRounded(value, step, rounding) * step;
}

/** True if `value` is an exact multiple of `step`. */
export function isMultipleOf(value: Money, step: Money): boolean {
  if (step <= ZERO) {
    throw new MoneyError(`step must be positive, got ${step}`);
  }
  return value % step === ZERO;
}

/**
 * Convert a percentage to a rate, e.g. 2.5% -> 0.025.
 *
 * Percentages (stop_loss_pct, take_profit_pct in section 8.2) are stored as
 * Money too, so they carry the same exactness guarantees.
 */
export function percentToRate(percent: Money, rounding: Rounding): Money {
  return div(percent, 100n * ONE, rounding);
}

/** Apply a rate to a value, e.g. applyRate(balance, rate(2.5%)). */
export function applyRate(value: Money, rate: Money, rounding: Rounding): Money {
  return mul(value, rate, rounding);
}

/** Absolute value. */
export function abs(value: Money): Money {
  return value < ZERO ? -value : value;
}

/** -1, 0, or 1 according to sign. */
export function signOf(value: Money): -1 | 0 | 1 {
  if (value < ZERO) return -1;
  if (value > ZERO) return 1;
  return 0;
}

/** Smaller of two values. */
export function min(a: Money, b: Money): Money {
  return a < b ? a : b;
}

/** Larger of two values. */
export function max(a: Money, b: Money): Money {
  return a > b ? a : b;
}

/** Clamp into [lower, upper]. */
export function clamp(value: Money, lower: Money, upper: Money): Money {
  if (lower > upper) {
    throw new MoneyError(`clamp bounds inverted: ${lower} > ${upper}`);
  }
  return min(max(value, lower), upper);
}

/** Sum a list exactly. Addition never rounds. */
export function sum(values: readonly Money[]): Money {
  return values.reduce<Money>((total, value) => total + value, ZERO);
}

/** True if the value fits a signed 64-bit D1 INTEGER column. */
export function isStorable(value: Money): boolean {
  return value >= INT64_MIN && value <= INT64_MAX;
}
