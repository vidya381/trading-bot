/**
 * The trailing-stop decoder and validator (spec 22.4 touchpoint 7).
 *
 * This is the pair `POST /api/bots` runs on a human's own submission AND that
 * Stage 3 reuses for its deterministic validation -- one implementation, two
 * callers, per 21.5 requirement 3. A bug here is a bug in both paths at once,
 * which is the argument for testing it directly rather than only through them.
 */
import { describe, expect, it } from "vitest";

import {
  TRAILING_STOP_SCHEMA_VERSION,
  TRAIL_PCT_MAX,
  TRAIL_PCT_MIN,
  TrailingStopError,
  decodeTrailingStopParams,
  encodeTrailingStopParams,
  validateTrailingStopParams,
} from "./trailing-stop";
import { ONE, ZERO, fromDecimalString } from "../shared/money";

const CAPITAL = 1000n * ONE;
const good = (pct: string) => ({
  strategy: "trailing_stop" as const,
  schemaVersion: TRAILING_STOP_SCHEMA_VERSION,
  trailPct: pct,
});

describe("decodeTrailingStopParams", () => {
  it("decodes the one field the strategy has", () => {
    expect(decodeTrailingStopParams(good("5")).trailPct).toBe(5n * ONE);
  });

  it("refuses params labelled for another strategy", () => {
    // The discriminator is checked FIRST, exactly as the DCA and grid decoders
    // do -- this is the check that stops a mislabelled params object being read
    // as though it were this strategy's.
    expect(() => decodeTrailingStopParams({ ...good("5"), strategy: "dca" })).toThrow(
      /not trailing_stop/,
    );
  });

  it("refuses a non-object and a non-string trailPct", () => {
    expect(() => decodeTrailingStopParams(null)).toThrow(/not an object/);
    expect(() => decodeTrailingStopParams({ ...good("5"), trailPct: 5 })).toThrow(
      /trailPct is number, not a string/,
    );
  });

  it("refuses a schema version it cannot read", () => {
    expect(() => decodeTrailingStopParams({ ...good("5"), schemaVersion: 99 })).toThrow(
      /schemaVersion 99/,
    );
  });

  it("round-trips through encode", () => {
    const params = decodeTrailingStopParams(good("12.5"));
    expect(decodeTrailingStopParams(encodeTrailingStopParams(params))).toEqual(params);
  });
});

describe("validateTrailingStopParams", () => {
  it("accepts a trail inside the provisional range, including both ends", () => {
    for (const pct of [TRAIL_PCT_MIN, 5n * ONE, TRAIL_PCT_MAX]) {
      expect(() => validateTrailingStopParams({ trailPct: pct }, CAPITAL)).not.toThrow();
    }
  });

  it("refuses a non-positive trail as meaningless, not as out-of-range", () => {
    // Two different faults deserve two different messages: "you typed something
    // that cannot be a trail" is not the same as "that is outside our range",
    // and only the second is provisional.
    for (const pct of [ZERO, -1n * ONE]) {
      expect(() => validateTrailingStopParams({ trailPct: pct }, CAPITAL)).toThrow(
        /must be positive/,
      );
    }
  });

  it("refuses a trail at or above 100%, where the stop can never be reached", () => {
    expect(() => validateTrailingStopParams({ trailPct: 100n * ONE }, CAPITAL)).toThrow(
      /at or below zero/,
    );
  });

  it("refuses a trail outside the provisional bounds, and SAYS they are provisional", () => {
    const tooTight = fromDecimalString("0.5");
    const tooLoose = fromDecimalString("25");
    for (const pct of [tooTight, tooLoose]) {
      let caught: unknown;
      try {
        validateTrailingStopParams({ trailPct: pct }, CAPITAL);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(TrailingStopError);
      // The message must carry the provisional flag: spec 22.5 open question 1
      // marks 1-20% UNCONFIRMED, and an operator refused by a number nobody has
      // justified is entitled to know that from the refusal itself.
      expect((caught as Error).message).toContain("PROVISIONAL");
      expect((caught as Error).message).toMatch(/1\.00000000 to 20\.00000000/);
    }
  });

  it("refuses a non-positive allocation, because the allocation IS the order size", () => {
    expect(() => validateTrailingStopParams({ trailPct: 5n * ONE }, ZERO)).toThrow(
      /single entry is sized by its allocation/,
    );
  });
});
