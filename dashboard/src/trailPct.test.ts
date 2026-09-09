/**
 * The create-bot form's trail-percentage validation.
 *
 * ── WHAT IS ACTUALLY UNDER TEST, AND WHY IT IS NOT A TABLE OF EXPECTED STRINGS ──
 *
 * The property that matters is not "does `trailPctError` reject 0.5". It is that
 * **the form's accepted set and the server's accepted set are the same set** --
 * because every way they can differ is a real defect an operator meets:
 *
 *   * the form LOOSER than the server → a green field, a submit, and a 400 that
 *     the form has to translate. `botId.ts`'s docblock calls that "the worst shape
 *     for a client-side check, since it teaches the operator that the green field
 *     means nothing", and it is why that module exists.
 *   * the form STRICTER than the server → a configuration the system would happily
 *     run, refused in the field, with no way to find out that the refusal is the
 *     dashboard's own opinion.
 *
 * So the tests below run `validateTrailingStopParams` -- the REAL validator, the
 * one `POST /api/bots` calls -- over the same inputs and assert the two verdicts
 * agree, input by input. That is a check the type system cannot make and that a
 * hand-written expectation table would quietly stop making the moment 22.5's open
 * question 1 settles and the bounds move.
 *
 * ── AND WHY THIS FILE CAN EXIST AT ALL ──
 *
 * `trailPct.ts` is React-free. A test importing `CreateBot.tsx` would collect ZERO
 * TESTS rather than failing, inside the Workers pool this suite runs in
 * (docs/open-items/component-test-harness.md) -- so a rule written inline in the
 * component would be checked by nothing at all. `create-bot-trailing-stop.test.ts`
 * covers the other half: that the form really routes through this.
 */

import { describe, expect, it } from "vitest";
import { TRAIL_PCT_MAX_TEXT, TRAIL_PCT_MIN_TEXT, trailPctError } from "./trailPct";
import { ONE, fromDecimalString, toTrimmedString } from "../../src/shared/money";
import {
  TRAIL_PCT_MAX,
  TRAIL_PCT_MIN,
  validateTrailingStopParams,
} from "../../src/strategies/trailing-stop";

/**
 * A positive allocation, so the validator's `allocatedCapital` arm never fires.
 *
 * That arm is deliberately NOT this module's business: it is the allocated-capital
 * field's rule, and the form already applies `requirePositive` to that field. See
 * `trailPct.ts`'s closing note.
 */
const FUNDED = 1000n * ONE;

/** Does the SERVER take this value? The real validator, not a restatement of it. */
function serverAccepts(raw: string): boolean {
  try {
    validateTrailingStopParams({ trailPct: fromDecimalString(raw) }, FUNDED);
    return true;
  } catch {
    return false;
  }
}

/**
 * Every decimal string worth asking both sides about: the bounds themselves, one
 * step either side of each, the interior, and the two values the server refuses
 * with its own distinct messages (`<= 0` and `>= 100`).
 *
 * Built from the constants rather than typed out, so this table follows the range
 * when the range moves instead of pinning today's numbers into a second place.
 */
const CANDIDATES: readonly string[] = [
  "0",
  "0.00000001",
  "0.5",
  toTrimmedString(TRAIL_PCT_MIN - 1n), // one scaled unit below the floor
  toTrimmedString(TRAIL_PCT_MIN),
  toTrimmedString(TRAIL_PCT_MIN + 1n),
  "2",
  "5",
  "7.5",
  "12.34567891".slice(0, 10), // 8 fractional places, the scale's limit
  toTrimmedString(TRAIL_PCT_MAX - 1n),
  toTrimmedString(TRAIL_PCT_MAX),
  toTrimmedString(TRAIL_PCT_MAX + 1n), // one scaled unit above the ceiling
  "25",
  "99.99999999",
  "100",
  "150",
];

describe("the form and the server accept exactly the same trail percentages", () => {
  for (const raw of CANDIDATES) {
    it(`agrees on ${JSON.stringify(raw)}`, () => {
      const formTakesIt = trailPctError(raw) === null;
      expect(formTakesIt, `form ${formTakesIt ? "accepted" : "rejected"} it`).toBe(
        serverAccepts(raw),
      );
    });
  }

  it("the table really exercises both verdicts, rather than agreeing vacuously", () => {
    // Without this, a `trailPctError` that returned null for everything would pass
    // every case above the moment the candidate list drifted to accepted values only.
    const accepted = CANDIDATES.filter((raw) => serverAccepts(raw));
    const refused = CANDIDATES.filter((raw) => !serverAccepts(raw));
    expect(accepted.length).toBeGreaterThan(3);
    expect(refused.length).toBeGreaterThan(3);
  });
});

describe("the bounds are the backend's, not a copy of them", () => {
  it("accepts each endpoint of the permitted range", () => {
    expect(trailPctError(toTrimmedString(TRAIL_PCT_MIN))).toBeNull();
    expect(trailPctError(toTrimmedString(TRAIL_PCT_MAX))).toBeNull();
  });

  it("refuses the smallest representable step outside either end", () => {
    // One scaled unit -- 1e-8 -- so this pins the comparison as inclusive at both
    // ends rather than merely "roughly in range".
    expect(trailPctError(toTrimmedString(TRAIL_PCT_MIN - 1n))).not.toBeNull();
    expect(trailPctError(toTrimmedString(TRAIL_PCT_MAX + 1n))).not.toBeNull();
  });

  it("renders the range from the constants, with the scale's zeros trimmed", () => {
    expect(TRAIL_PCT_MIN_TEXT).toBe(toTrimmedString(TRAIL_PCT_MIN));
    expect(TRAIL_PCT_MAX_TEXT).toBe(toTrimmedString(TRAIL_PCT_MAX));
    // Not "1.00000000" and "20.00000000" under a form field.
    expect(TRAIL_PCT_MIN_TEXT).not.toContain(".");
    expect(TRAIL_PCT_MAX_TEXT).not.toContain(".");
  });

  it("names both numbers in the message, so the field says what to type", () => {
    const error = trailPctError("50");
    expect(error).not.toBeNull();
    expect(error).toContain(TRAIL_PCT_MIN_TEXT);
    expect(error).toContain(TRAIL_PCT_MAX_TEXT);
  });
});

describe("the shape rules the range check cannot reach", () => {
  it("requires a value", () => {
    expect(trailPctError("")).toBe("Required.");
    expect(trailPctError("   ")).toBe("Required.");
  });

  it("trims before judging, as the form submits trimmed", () => {
    expect(trailPctError("  5  ")).toBeNull();
  });

  it("refuses what the money parser would refuse, WITHOUT throwing", () => {
    /*
     * `fromDecimalString` throws on all of these, and an exception escaping
     * `validate()` would take the whole form down mid-keystroke rather than mark a
     * field. The grammar check has to come first, and this is what pins that
     * ordering -- it is not merely a nicer message.
     */
    for (const raw of ["abc", "5%", "1e1", "--5", "5.", ".5", "1,5", "5.123456789"]) {
      expect(() => fromDecimalString(raw)).toThrow();
      expect(trailPctError(raw), `for ${JSON.stringify(raw)}`).not.toBeNull();
    }
  });

  it("refuses a negative, which the parser accepts but the strategy cannot use", () => {
    // `-5` parses fine as Money, so the grammar alone would let it through; the
    // form's decimal pattern is deliberately the unsigned half. Either way it must
    // be refused, and the server refuses it too.
    expect(trailPctError("-5")).not.toBeNull();
    expect(serverAccepts("-5")).toBe(false);
  });
});
