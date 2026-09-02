/**
 * THE DISPATCH THAT MADE THE BOT DETAIL PAGE GO BLANK.
 *
 * `/bots/bot-ts1` rendered nothing at all -- no header, no banner, no layout --
 * because `StrategyState.tsx` dispatched with `if (grid) {...} else <DcaView>`.
 * A trailing-stop bot is not grid, so its `{ trailPct }` params reached a view
 * reading `params.baseOrderSize`, `formatMoney(undefined)` threw, and React
 * unmounted the whole tree.
 *
 * ⚠ NO TEST IN THIS REPOSITORY COULD HAVE CAUGHT THAT WHERE IT LIVED. The suite
 * runs inside the Workers runtime and a test importing a `.tsx` COLLECTS ZERO
 * TESTS RATHER THAN FAILING (docs/open-items/component-test-harness.md), so a
 * dispatch written inline in a component is a decision nothing can reach. That
 * is why `strategyView.ts` exists at all, and this file is the reason it was
 * worth extracting: every strategy, and every degenerate state, driven through
 * the real decision.
 *
 * THE PROPERTY THAT MATTERS MOST IS THE LAST ONE: every member of `STRATEGIES`
 * gets a view of its own, so adding a fourth strategy without a branch fails
 * HERE rather than as a blank screen in front of an operator.
 */

import { describe, expect, it } from "vitest";

import type { BotConfig, BotRuntimeState, Position, Strategy } from "./api/types";
import {
  STRATEGIES,
  entryPriceOf,
  strategyLabel,
  strategyViewFor,
  trailingStopFigures,
} from "./strategyView";

// ---------------------------------------------------------------------------
// Fixtures, shaped exactly as `botDetail` (src/api/serialize.ts) emits them.
// ---------------------------------------------------------------------------

const BASE = {
  schemaVersion: 1,
  botInstanceId: "bot-x",
  accountLabel: "acct",
  exchange: "gemini",
  pair: "BTCUSD",
  capitalAsset: "USD",
  allocatedCapital: "500.00000000",
} as const;

const DCA_PARAMS = {
  baseOrderSize: "100.00000000",
  additionalOrderSize: "100.00000000",
  stepMultiplier: "1.00000000",
  dropPct: "2.00000000",
  maxAdditionalBuys: 3,
  takeProfitPct: "5.00000000",
  stopLossPct: "20.00000000",
  autoRestart: false,
  sellOnStopLoss: false,
} as const;

const GRID_PARAMS = {
  upperBound: "12000.00000000",
  lowerBound: "10000.00000000",
  gridLines: 5,
  spacing: "arithmetic",
  orderSize: "100.00000000",
  stopLossPct: "20.00000000",
  breakoutTakeProfit: false,
  breakoutThresholdPct: null,
  takeProfitAmount: null,
} as const;

/** One config per strategy, keyed so the exhaustiveness test can iterate them. */
const CONFIGS: Readonly<Record<Strategy, BotConfig>> = {
  dca: { ...BASE, strategy: "dca", params: DCA_PARAMS },
  grid: { ...BASE, strategy: "grid", params: GRID_PARAMS },
  trailing_stop: { ...BASE, strategy: "trailing_stop", params: { trailPct: "10.00000000" } },
};

const EMPTY_POSITION = {
  quantity: "0.00000000",
  cost: "0.00000000",
  averageEntryPrice: "0.00000000",
  entries: [],
  additionalBuysUsed: 0,
  lastEntryPrice: "0.00000000",
} as const;

function stateOf(over: Partial<BotRuntimeState> = {}): BotRuntimeState {
  return {
    schemaVersion: 1,
    status: "running",
    cycleCount: 0,
    position: EMPTY_POSITION,
    nextSequence: 0,
    openOrderIds: [],
    haltReason: null,
    haltedAt: null,
    lastPrice: null,
    lastPriceAt: null,
    realizedGross: "0.00000000",
    filters: null,
    exitOrderId: null,
    ...over,
  };
}

const LADDER = {
  levels: ["10000.00000000", "11000.00000000"],
  slots: [null, null],
  heldQuantity: "0.00000000",
  heldCost: "0.00000000",
  realizedGross: "0.00000000",
  placed: false,
} as const;

// ---------------------------------------------------------------------------
// 1. ⚠ Coverage: no strategy may fall through to another strategy's view
// ---------------------------------------------------------------------------

describe("every strategy gets a view of its own", () => {
  it("lists every member of the Strategy union at runtime", () => {
    // The union cannot be iterated, so `STRATEGIES` is derived from a
    // `Record<Strategy, true>` -- adding a variant without extending it fails to
    // compile. This asserts the list is what that record produced, so a future
    // edit replacing the derivation with a hand-written array is caught too.
    expect([...STRATEGIES].sort()).toEqual(["dca", "grid", "trailing_stop"]);
  });

  it.each(STRATEGIES)("%s resolves to its OWN view, never another's", (strategy) => {
    /*
     * THE ASSERTION THE BUG WOULD HAVE FAILED. Before the fix, "trailing_stop"
     * resolved to the DCA view, which is not merely a missing feature -- the DCA
     * view then read money fields that do not exist on trailing-stop params and
     * threw during render.
     */
    const state = strategy === "grid" ? stateOf({ ladder: LADDER }) : stateOf();
    const view = strategyViewFor(CONFIGS[strategy], state);
    const expected: Record<Strategy, string> = {
      dca: "dca",
      grid: "grid",
      trailing_stop: "trailing-stop",
    };
    expect(view.kind).toBe(expected[strategy]);
    expect(view.kind).not.toBe("unsupported");

    /*
     * ⚠ AND THE CONFIG IT CARRIES IS THIS STRATEGY'S OWN. The verdict hands the
     * renderer a narrowed config so a view cannot receive another strategy's
     * params -- the exact substitution that threw. Asserting the tag alone would
     * leave that unchecked.
     */
    expect(view).toHaveProperty("config");
    expect((view as { config: { strategy: string } }).config.strategy).toBe(strategy);
    expect((view as { config: { params: object } }).config.params).toEqual(
      CONFIGS[strategy].params,
    );
  });

  it("gives each strategy a DISTINCT view, so no two share a renderer", () => {
    const kinds = STRATEGIES.map(
      (s) => strategyViewFor(CONFIGS[s], s === "grid" ? stateOf({ ladder: LADDER }) : stateOf()).kind,
    );
    expect(new Set(kinds).size).toBe(STRATEGIES.length);
  });
});

// ---------------------------------------------------------------------------
// 2. The degenerate states, each of which must be a MESSAGE and never a throw
// ---------------------------------------------------------------------------

describe("states with no strategy view to show", () => {
  it("an orphan -- a row whose object holds no state -- is its own verdict", () => {
    expect(strategyViewFor(null, null).kind).toBe("orphan");
    expect(strategyViewFor(CONFIGS.dca, null).kind).toBe("orphan");
    expect(strategyViewFor(null, stateOf()).kind).toBe("orphan");
  });

  it("a grid bot with no ladder yet is distinguished from one with a ladder", () => {
    expect(strategyViewFor(CONFIGS.grid, stateOf()).kind).toBe("grid-no-ladder");
    expect(strategyViewFor(CONFIGS.grid, stateOf({ ladder: LADDER })).kind).toBe("grid");
  });

  it("⚠ a strategy from a NEWER Worker is named, not guessed at and not thrown on", () => {
    /*
     * The seam this whole fix is about: `config` crosses a network boundary from
     * a Worker that can be a deploy ahead of this bundle. The compiler cannot
     * help there, so the runtime arm must. It must not throw (that is the blank
     * page) and it must not silently pick a neighbouring strategy (that is the
     * blank page too, one step later).
     */
    const future = { ...BASE, strategy: "mean_reversion", params: { window: 20 } };
    const view = strategyViewFor(future as unknown as BotConfig, stateOf());
    expect(view.kind).toBe("unsupported");
    expect(view).toMatchObject({ strategy: "mean_reversion" });
  });

  it("never throws for any config/state combination it can be handed", () => {
    const configs = [null, ...STRATEGIES.map((s) => CONFIGS[s]), {} as unknown as BotConfig];
    const states = [null, stateOf(), stateOf({ ladder: LADDER })];
    for (const config of configs) {
      for (const state of states) {
        expect(() => strategyViewFor(config, state)).not.toThrow();
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 3. The entry price the list and the summary both read
// ---------------------------------------------------------------------------

const DCA_POSITION: Position = {
  strategy: "dca",
  heldQuantity: "0.50000000",
  averageEntryPrice: "100.00000000",
  cost: "50.00000000",
  realizedGross: "0.00000000",
};

const TS_POSITION: Position = {
  strategy: "trailing_stop",
  heldQuantity: "0.00639000",
  averageEntryPrice: "78172.34000000",
  cost: "499.52125260",
  realizedGross: "0.00000000",
  highWaterMark: "82500.10000000",
  trailLevel: "74250.09000000",
};

const GRID_POSITION: Position = {
  strategy: "grid",
  heldQuantity: "1.00000000",
  cost: "1000.00000000",
  realizedGross: "0.00000000",
};

describe("the entry price shown beside a held quantity", () => {
  it("⚠ a trailing-stop position HAS one, which both call sites used to drop", () => {
    // `averageEntryPrice` is a real entry price here: 22.2 decision 4 makes this
    // a single-entry strategy, so it averages one fill. `BotList` and
    // `BotSummary` each tested `strategy === "dca"` inline and therefore showed
    // nothing for this bot.
    expect(entryPriceOf(TS_POSITION)).toBe("78172.34000000");
  });

  it("a DCA position has one", () => {
    expect(entryPriceOf(DCA_POSITION)).toBe("100.00000000");
  });

  it("a grid position has none, because a ladder stores no average entry", () => {
    // Distinct from "an entry price of zero", which is why this is null.
    expect(entryPriceOf(GRID_POSITION)).toBeNull();
  });

  it("a flat position reports NO entry price rather than an entry price of zero", () => {
    expect(entryPriceOf({ ...DCA_POSITION, averageEntryPrice: "0.00000000" })).toBeNull();
    expect(entryPriceOf({ ...TS_POSITION, averageEntryPrice: "0.00000000" })).toBeNull();
  });

  it("an orphan's null position is null, not a throw", () => {
    expect(entryPriceOf(null)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 4. The trailing-stop figures, taken from the backend and never re-derived
// ---------------------------------------------------------------------------

describe("the three figures 22.4 touchpoint 5 requires", () => {
  it("passes through the mark and level the BACKEND derived, byte for byte", () => {
    /*
     * ⚠ THE POINT OF THIS TEST IS THAT NO ARITHMETIC HAPPENS HERE. `trailLevel`
     * is computed by `trailLevelOf` in the Worker and pinned against the
     * strategy's own `stopLossPrice` by trailing-stop-dashboard-parity.test.ts.
     * A dashboard-side re-derivation would not throw and would not fail to
     * compile; it would show a stop a rounding step away from the real one.
     */
    expect(trailingStopFigures(TS_POSITION)).toEqual({
      heldQuantity: "0.00639000",
      cost: "499.52125260",
      realizedGross: "0.00000000",
      entryPrice: "78172.34000000",
      highWaterMark: "82500.10000000",
      trailLevel: "74250.09000000",
    });
  });

  it("keeps both derived figures NULL before the first price, never zero", () => {
    // A trail level of "0" would render as a real stop that can never trigger.
    const figures = trailingStopFigures({
      ...TS_POSITION,
      averageEntryPrice: "0.00000000",
      highWaterMark: null,
      trailLevel: null,
    });
    expect(figures?.highWaterMark).toBeNull();
    expect(figures?.trailLevel).toBeNull();
    expect(figures?.entryPrice).toBeNull();
  });

  it("refuses a position of the wrong strategy rather than reading its fields", () => {
    // The mistake that started all of this, in miniature: reading trailing-stop
    // fields off a shape that has none.
    expect(trailingStopFigures(DCA_POSITION)).toBeNull();
    expect(trailingStopFigures(GRID_POSITION)).toBeNull();
    expect(trailingStopFigures(null)).toBeNull();
  });
});

describe("strategy labels", () => {
  it("names every strategy in the operator's words, not the wire's", () => {
    // "trailing_stop" under a CSS `uppercase` renders "TRAILING_STOP".
    expect(strategyLabel("trailing_stop")).toBe("Trailing stop");
    expect(strategyLabel("dca")).toBe("DCA");
    expect(strategyLabel("grid")).toBe("Grid");
  });

  it("passes an unknown strategy through rather than blanking it", () => {
    expect(strategyLabel("mean_reversion")).toBe("mean_reversion");
  });
});
