/**
 * The staleness thresholds and the comparison that applies them (21.5
 * requirement 4's second half).
 *
 * Five properties, each one this module would look correct without:
 *
 *  1. THE NUMBERS ARE PINNED LITERALLY. They are policy with no backtest behind
 *     them, so the test asserts the exact values rather than relationships alone.
 *     A threshold silently changed is a verdict silently changed, on the screen
 *     read to decide whether to commit capital.
 *  2. THE PER-STRATEGY LOOKUP IS REAL. Grid and DCA get different price
 *     thresholds, and `priceThresholdFor` reads the one belonging to the strategy
 *     it was handed -- not a hardcoded arm.
 *  3. A SINGLE THRESHOLD WOULD GET TWO ORDINARY CASES BACKWARDS, and both are
 *     asserted directly, because "compare `oldest` against one number" is the
 *     cheap implementation this design exists to reject.
 *  4. `unknown` IS NOT `fresh`. An input with no fetch time cannot be compared,
 *     and the worst-of rules keep that visible.
 *  5. THE BOUNDARY IS EXACT, in both directions. The comparison direction is
 *     arbitrary, which is why it is tested rather than trusted.
 */

import { describe, expect, it } from "vitest";
import type { StrategyType } from "../db/schema";
import {
  DEFAULT_STALENESS_POLICY,
  priceThresholdFor,
  stalenessOf,
  verdictFor,
  worstVerdict,
  type InputStaleness,
  type StalenessInput,
  type StalenessStrategy,
} from "./staleness";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const NOW = 1_900_000_000_000;

/**
 * ⚠ THE TWO-WAY TYPE PIN the module header promises.
 *
 * `staleness.ts` deliberately imports NOTHING, so it cannot use `StrategyType` --
 * that import would pull the Worker's D1 types into the dashboard's `tsc -b` and
 * break it. These two assignments make the two unions a COMPILE ERROR to diverge,
 * in both directions: a third strategy added to `StrategyType` with no threshold
 * fails the first, and a key added here that is not a real strategy fails the
 * second.
 *
 * A runtime assertion below checks the same thing against the actual keys of the
 * policy object, since a type can be widened without the object following.
 */
const _strategiesAgree: StalenessStrategy = null as unknown as StrategyType;
const _strategiesAgreeBack: StrategyType = null as unknown as StalenessStrategy;
void _strategiesAgree;
void _strategiesAgreeBack;

// -- Property 1: the numbers themselves -------------------------------------

describe("the policy", () => {
  it("pins every threshold to the exact value the module argues for", () => {
    // Literal, not derived. A relationship-only assertion ("dca is looser than
    // grid") passes just as well if both are wrong by the same factor.
    expect(DEFAULT_STALENESS_POLICY.priceHistory.grid).toBe(15 * MINUTE);
    expect(DEFAULT_STALENESS_POLICY.priceHistory.dca).toBe(60 * MINUTE);
    expect(DEFAULT_STALENESS_POLICY.capitalLedger).toBe(1 * HOUR);
    expect(DEFAULT_STALENESS_POLICY.botList).toBe(1 * DAY);
    expect(DEFAULT_STALENESS_POLICY.venueRules).toBe(7 * DAY);
  });

  it("keeps the ordering and rough ratio the reasoning actually supports", () => {
    // The parts of the policy the argument defends, as opposed to the absolute
    // values: a grid's absolute bounds go stale fastest, and the venue's rules
    // slowest by a wide margin.
    const { priceHistory, capitalLedger, botList, venueRules } = DEFAULT_STALENESS_POLICY;
    expect(priceHistory.grid).toBeLessThan(priceHistory.dca);
    expect(priceHistory.dca / priceHistory.grid).toBe(4);
    expect(priceHistory.grid).toBeLessThan(capitalLedger);
    expect(capitalLedger).toBeLessThan(botList);
    expect(botList).toBeLessThan(venueRules);
  });

  it("is frozen, so nothing can retune it at runtime", () => {
    expect(Object.isFrozen(DEFAULT_STALENESS_POLICY)).toBe(true);
    expect(Object.isFrozen(DEFAULT_STALENESS_POLICY.priceHistory)).toBe(true);
  });

  it("has a threshold for every strategy and no extras", () => {
    // The runtime half of the type pin above: the object's real keys, so widening
    // the type without adding a number is caught here rather than at a call site.
    expect(Object.keys(DEFAULT_STALENESS_POLICY.priceHistory).sort()).toEqual([
      "dca",
      "grid",
      "trailing_stop",
    ]);
  });
});

// -- Property 2: the per-strategy lookup ------------------------------------

describe("priceThresholdFor", () => {
  it("returns the strategy's OWN threshold, not a fixed arm", () => {
    expect(priceThresholdFor("grid")).toBe(15 * MINUTE);
    expect(priceThresholdFor("dca")).toBe(60 * MINUTE);
    expect(priceThresholdFor("trailing_stop")).toBe(60 * MINUTE);
    // Asserted as different rather than only as two values: a mutant that returns
    // `priceHistory.grid` for every strategy passes any test that checks only one.
    expect(priceThresholdFor("grid")).not.toBe(priceThresholdFor("dca"));
    expect(priceThresholdFor("grid")).not.toBe(priceThresholdFor("trailing_stop"));
    /*
     * ⚠ DCA AND TRAILING STOP DELIBERATELY SHARE A VALUE, so no distinctness
     * assertion is available between those two -- and the reason is recorded
     * rather than left as an apparent omission. Both have percentage-only
     * parameters and one absolute quote size checked against the reference price
     * (see `DEFAULT_STALENESS_POLICY`'s note). If they are ever separated, this
     * is the line that should gain the assertion.
     */
  });

  it("reads from an injected policy rather than the module constant", () => {
    const policy = {
      ...DEFAULT_STALENESS_POLICY,
      priceHistory: { grid: 1_000, dca: 2_000, trailing_stop: 3_000 },
    };
    expect(priceThresholdFor("grid", policy)).toBe(1_000);
    expect(priceThresholdFor("dca", policy)).toBe(2_000);
    expect(priceThresholdFor("trailing_stop", policy)).toBe(3_000);
  });
});

// -- Property 5: the boundary ----------------------------------------------

describe("verdictFor", () => {
  const input = (at: number | null, thresholdMs = 15 * MINUTE): StalenessInput => ({
    key: "candles",
    at,
    thresholdMs,
  });

  it("calls EXACTLY the threshold fresh, and one millisecond past it stale", () => {
    // The direction is arbitrary and is therefore asserted rather than assumed.
    expect(verdictFor(input(NOW - 15 * MINUTE), NOW).verdict).toBe("fresh");
    expect(verdictFor(input(NOW - 15 * MINUTE - 1), NOW).verdict).toBe("stale");
  });

  it("reports the real age beside the threshold it was compared against", () => {
    const result = verdictFor(input(NOW - 20 * MINUTE), NOW);
    expect(result.ageMs).toBe(20 * MINUTE);
    expect(result.thresholdMs).toBe(15 * MINUTE);
    expect(result.key).toBe("candles");
  });

  it("treats a fetch time in the FUTURE as fresh, not stale", () => {
    // Ordinary clock skew between a Worker and a browser. Calling the future
    // stale would flag a proposal made seconds ago on a slightly slow clock.
    const result = verdictFor(input(NOW + 5_000), NOW);
    expect(result.verdict).toBe("fresh");
    expect(result.ageMs).toBe(-5_000);
  });

  it("reports NO fetch time as unknown, and keeps the threshold visible", () => {
    const result = verdictFor(input(null), NOW);
    expect(result.verdict).toBe("unknown");
    expect(result.ageMs).toBeNull();
    // The threshold rides along even when nothing was compared, so a reader can
    // see WHICH limit could not be applied.
    expect(result.thresholdMs).toBe(15 * MINUTE);
  });

  it("does NOT report an absent fetch time as fresh", () => {
    // Stated as its own test because it is the whole reason the third state
    // exists (section 5.6: a failed read is never data).
    expect(verdictFor(input(null), NOW).verdict).not.toBe("fresh");
  });
});

// -- Property 4: the worst-of rules ----------------------------------------

describe("worstVerdict", () => {
  const at = (verdict: InputStaleness["verdict"]): InputStaleness => ({
    key: verdict,
    verdict,
    ageMs: 0,
    thresholdMs: 0,
  });

  it("ranks stale above unknown above fresh", () => {
    expect(worstVerdict([at("fresh"), at("unknown"), at("stale")])).toBe("stale");
    expect(worstVerdict([at("fresh"), at("unknown")])).toBe("unknown");
    expect(worstVerdict([at("fresh"), at("fresh")])).toBe("fresh");
  });

  it("reports an EMPTY set as unknown rather than fresh", () => {
    // "Nothing was checked" answering "fresh" is the fail-open shape this module
    // is written against.
    expect(worstVerdict([])).toBe("unknown");
  });
});

// -- Property 3: what a single threshold would get backwards ----------------

describe("stalenessOf over a whole proposal", () => {
  /** The four real inputs, at the ages a caller supplies. */
  function fourInputs(ages: {
    candles: number | null;
    capital: number | null;
    concentration: number | null;
    filters: number | null;
  }, strategy: StalenessStrategy = "grid"): StalenessInput[] {
    return [
      { key: "candles", at: ages.candles === null ? null : NOW - ages.candles, thresholdMs: priceThresholdFor(strategy) },
      { key: "capital", at: ages.capital === null ? null : NOW - ages.capital, thresholdMs: DEFAULT_STALENESS_POLICY.capitalLedger },
      { key: "concentration", at: ages.concentration === null ? null : NOW - ages.concentration, thresholdMs: DEFAULT_STALENESS_POLICY.botList },
      { key: "filters", at: ages.filters === null ? null : NOW - ages.filters, thresholdMs: DEFAULT_STALENESS_POLICY.venueRules },
    ];
  }

  it("⚠ CASE ONE: the OLDEST input is fresh and the proposal is fresh", () => {
    // A 2-hour-old venue-rules fetch is by far the oldest of the four and is
    // nowhere near its 7-day threshold. A single-threshold implementation
    // comparing `oldest` against anything under 2 hours calls this stale.
    const result = stalenessOf(
      fourInputs({ candles: 2 * MINUTE, capital: 3 * MINUTE, concentration: 5 * MINUTE, filters: 2 * HOUR }),
      NOW,
    );
    expect(result.verdict).toBe("fresh");
    expect(result.staleInputs).toEqual([]);
    // And the oldest really is the filters read, so the case is the one described.
    expect(result.inputs.find((i) => i.key === "filters")!.ageMs).toBe(2 * HOUR);
  });

  it("⚠ CASE TWO: a NOT-oldest input is stale and the proposal is stale", () => {
    // The price fetch is 20 minutes old -- past grid's 15 -- while the venue
    // rules are 3 hours old and perfectly fresh. The stale input is not the
    // oldest, which is exactly what a single threshold cannot express.
    const result = stalenessOf(
      fourInputs({ candles: 20 * MINUTE, capital: 25 * MINUTE, concentration: 30 * MINUTE, filters: 3 * HOUR }),
      NOW,
    );
    expect(result.verdict).toBe("stale");
    expect(result.staleInputs.map((i) => i.key)).toEqual(["candles"]);
    // The oldest input is NOT the stale one. Asserted so the case cannot be
    // mistaken for an ordinary "everything is old" fixture.
    const oldest = [...result.inputs].sort((a, b) => (b.ageMs ?? 0) - (a.ageMs ?? 0))[0]!;
    expect(oldest.key).toBe("filters");
    expect(oldest.verdict).toBe("fresh");
  });

  it("⚠ THE SAME AGES ARE STALE FOR GRID AND FRESH FOR DCA", () => {
    // 21.7 open question 4's own hypothesis, as a single comparison: a 20-minute
    // price window is past grid's 15-minute threshold and inside DCA's 60.
    const ages = { candles: 20 * MINUTE, capital: 1 * MINUTE, concentration: 1 * MINUTE, filters: 1 * MINUTE };
    expect(stalenessOf(fourInputs(ages, "grid"), NOW).verdict).toBe("stale");
    expect(stalenessOf(fourInputs(ages, "dca"), NOW).verdict).toBe("fresh");
  });

  it("flags a stale capital read that the price threshold would have passed", () => {
    // 90 minutes: inside neither strategy's price threshold in DCA's case (60m)
    // and past the ledger's hour. Both fire, and both are named.
    const result = stalenessOf(
      fourInputs({ candles: 90 * MINUTE, capital: 90 * MINUTE, concentration: 1 * MINUTE, filters: 1 * MINUTE }, "dca"),
      NOW,
    );
    expect(result.staleInputs.map((i) => i.key).sort()).toEqual(["candles", "capital"]);
  });

  it("flags a day-old bot list, because the concentration flag may no longer hold", () => {
    const result = stalenessOf(
      fourInputs({ candles: 1 * MINUTE, capital: 1 * MINUTE, concentration: DAY + MINUTE, filters: 1 * MINUTE }),
      NOW,
    );
    expect(result.verdict).toBe("stale");
    expect(result.staleInputs.map((i) => i.key)).toEqual(["concentration"]);
  });

  it("reports an input that never produced a value as unknown, not stale", () => {
    const result = stalenessOf(
      fourInputs({ candles: 1 * MINUTE, capital: null, concentration: 1 * MINUTE, filters: 1 * MINUTE }),
      NOW,
    );
    expect(result.verdict).toBe("unknown");
    expect(result.unknownInputs.map((i) => i.key)).toEqual(["capital"]);
    expect(result.staleInputs).toEqual([]);
  });

  it("prefers STALE over unknown when both are present", () => {
    // A definite "too old" outranks a "cannot tell": the reviewer has a concrete
    // reason to refuse, and burying it under the softer message would lose it.
    const result = stalenessOf(
      fourInputs({ candles: 20 * MINUTE, capital: null, concentration: 1 * MINUTE, filters: 1 * MINUTE }),
      NOW,
    );
    expect(result.verdict).toBe("stale");
    expect(result.staleInputs.map((i) => i.key)).toEqual(["candles"]);
    expect(result.unknownInputs.map((i) => i.key)).toEqual(["capital"]);
  });

  it("keeps every input in the result, in the order it was given", () => {
    // The table renders these, so order is part of the contract.
    const result = stalenessOf(
      fourInputs({ candles: 1, capital: 1, concentration: 1, filters: 1 }),
      NOW,
    );
    expect(result.inputs.map((i) => i.key)).toEqual([
      "candles",
      "capital",
      "concentration",
      "filters",
    ]);
  });
});
