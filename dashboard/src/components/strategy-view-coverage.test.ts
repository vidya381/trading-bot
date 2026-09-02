/**
 * ⚠ NO COMPONENT MAY DECIDE A STRATEGY BY FALLING THROUGH TO ANOTHER ONE.
 *
 * ── THE DEFECT, AND WHY A LOGIC TEST ALONE DOES NOT CLOSE IT ──
 *
 * `/bots/bot-ts1` rendered a completely blank page: `StrategyState.tsx` said
 * `if (strategy === "grid") { ... } return <DcaPositionView>`, a trailing-stop
 * bot took the `return`, `formatMoney(params.baseOrderSize)` was handed
 * `undefined`, and React unmounted the entire tree.
 *
 * `strategyView.test.ts` now covers the DECISION, exhaustively. It cannot cover
 * whether the components CALL it -- `proposalFields.ts`'s header records a
 * mutation run where a guard's call site was deleted and every test still passed,
 * because the call site was one line inside a `.tsx` and nothing could reach it.
 * That is exactly the shape of this bug: the fall-through was one line of JSX.
 *
 * ── WHY A SOURCE SCAN ──
 *
 * The dashboard has no jsdom and no testing-library, and a test importing a
 * `.tsx` COLLECTS ZERO TESTS RATHER THAN FAILING inside the Workers pool this
 * suite runs in (docs/open-items/component-test-harness.md). So nothing here can
 * mount a component. This is the pattern `grid-ladder-config.test.ts` and
 * `proposal-summary-card.test.ts` already use, for decision log 45's reason: a
 * guard whose call site nothing can check is most of the way to no guard.
 *
 * ⚠ ITS LIMIT, STATED PLAINLY: a source scan checks the text, not the behaviour.
 * It cannot prove the trailing-stop view renders the right numbers -- the
 * operator's eyes and `strategyView.test.ts` do that between them. What it CAN
 * prove is the half that rots silently: that the strategy-sensitive components
 * still route through the exhaustive helpers instead of growing a fresh
 * `=== "dca"` and quietly dropping the next strategy.
 */

import { describe, expect, it } from "vitest";

// `import.meta.glob` is a Vite feature, declared here rather than by adding
// "vite/client" to tsconfig's `types` -- which would pull the DOM lib into scope
// while typechecking Worker source. Mirrors `grid-ladder-config.test.ts`.
declare global {
  interface ImportMeta {
    glob(pattern: string, options: { query: string; eager: true }): Record<string, unknown>;
  }
}

const SOURCES = import.meta.glob("/dashboard/src/**/*.{ts,tsx}", {
  query: "?raw",
  eager: true,
}) as Record<string, { default: string }>;

const DISPATCHER = "/dashboard/src/components/StrategyState.tsx";
const DECISION = "/dashboard/src/strategyView.ts";
const TYPES = "/dashboard/src/api/types.ts";
const BOT_LIST = "/dashboard/src/components/BotList.tsx";
const BOT_SUMMARY = "/dashboard/src/components/BotSummary.tsx";
const START_ACTION = "/dashboard/src/components/StartAction.tsx";
const TRAILING_VIEW = "/dashboard/src/components/TrailingStopView.tsx";

function raw(path: string): string {
  const module = SOURCES[path];
  expect(module, `${path} is not in the scanned source set`).toBeDefined();
  return module!.default;
}

/**
 * Source lines only: prose ABOUT the rule is not an instance of it. Load-bearing
 * here more than anywhere -- every file below quotes the OLD fall-through
 * verbatim in a comment to explain why it changed, and a naive substring search
 * would read those explanations as the defect still being present.
 */
function code(path: string): string {
  return raw(path)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => !line.startsWith("//") && !line.startsWith("*") && !line.startsWith("/*"))
    .join("\n");
}

/** Every strategy named in the `Strategy` union, read out of the type mirror. */
function declaredStrategies(): readonly string[] {
  const source = code(TYPES);
  const at = source.indexOf("export type Strategy =");
  expect(at, "no `Strategy` union in the type mirror").toBeGreaterThan(-1);
  const line = source.slice(at, source.indexOf(";", at));
  const names = [...line.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]!);
  expect(names.length, "the Strategy union parsed to nothing").toBeGreaterThan(1);
  return names;
}

describe("the strategy dispatch cannot silently drop a strategy", () => {
  it("found the sources to check", () => {
    // Without this every assertion below passes vacuously, which is the one way a
    // source-scan guard rots with nobody noticing.
    const paths = Object.keys(SOURCES);
    expect(paths.length).toBeGreaterThan(20);
    for (const path of [DISPATCHER, DECISION, TYPES, BOT_LIST, BOT_SUMMARY, START_ACTION, TRAILING_VIEW]) {
      expect(paths).toContain(path);
    }
  });

  it("the comment-stripper really does strip prose, so the assertions below mean something", () => {
    // The guard on the guard. `StrategyState.tsx` deliberately quotes the old
    // dispatch in a comment; if `code()` stopped filtering comments, the
    // assertions below would read that explanation as the defect itself.
    expect(raw(DISPATCHER)).toContain("rendered a BLANK PAGE");
    expect(code(DISPATCHER)).not.toContain("rendered a BLANK PAGE");
  });

  it("⚠ the dispatcher renders an explicit arm for EVERY declared strategy", () => {
    /*
     * THE ASSERTION THAT FAILS WHEN A FOURTH STRATEGY IS ADDED. `strategyView.ts`
     * already makes an unhandled strategy a compile error in the decision; this
     * makes it a test failure in the RENDERER, which is the layer that went blank.
     */
    const source = code(DISPATCHER);
    for (const strategy of declaredStrategies()) {
      const kind = strategy.replace(/_/g, "-");
      expect(
        source.includes(`case "${kind}"`) || source.includes(`case "${strategy}"`),
        `StrategyState.tsx has no arm for the "${strategy}" strategy`,
      ).toBe(true);
    }
  });

  it("⚠ the dispatcher has an `unsupported` arm, so an unknown strategy is a message", () => {
    // Not a throw, and not a neighbouring strategy's view. The Worker can be a
    // deploy ahead of this bundle, so this arm is reachable in production.
    expect(code(DISPATCHER)).toContain('case "unsupported"');
  });

  it("⚠ the dispatcher decides through `strategyViewFor`, not with its own branches", () => {
    // The call site the mutation run showed a logic test cannot protect.
    const source = code(DISPATCHER);
    expect(source).toContain("strategyViewFor(config, state)");
    // And it no longer tests the raw strategy value to CHOOSE a view. The
    // `config.strategy === ...` guards that remain are type narrowings inside an
    // arm the dispatcher already chose, never the choice itself.
    expect(source).not.toContain('if (config.strategy === "grid")');
  });

  it("⚠ neither the list nor the summary carries its own entry-price strategy test", () => {
    /*
     * Both used to say `position.strategy === "dca"` inline, and both therefore
     * showed no entry price for a trailing-stop bot. One exhaustive helper now
     * answers for both; a second copy appearing here is the regression.
     */
    for (const path of [BOT_LIST, BOT_SUMMARY]) {
      const source = code(path);
      expect(source, `${path} should read the shared helper`).toContain("entryPriceOf(");
      expect(
        source.includes('position.strategy === "dca" &&'),
        `${path} has grown its own entry-price strategy test again`,
      ).toBe(false);
    }
  });

  it("⚠ the start dialog describes the order by switch, not by assuming grid", () => {
    /*
     * `plannedOrderSummary` was the SECOND blank page waiting to happen: it
     * destructured `gridLines, lowerBound, upperBound` for everything that was
     * not DCA, so a created trailing-stop bot would have thrown out of render
     * from a different component on the same page.
     */
    const source = code(START_ACTION);
    expect(source).toContain('case "trailing_stop"');
    expect(source).toContain("const unreachable: never = config;");
  });

  it("the trailing-stop view does not re-derive the trail level", () => {
    /*
     * The level shown must be the level the STRATEGY compares against.
     * `positionOf` computes it with the Worker's own `trailLevelOf`, pinned to
     * `stopLossPrice` by trailing-stop-dashboard-parity.test.ts. A copy of that
     * arithmetic here would not throw and would not fail to compile -- it would
     * quietly show a stop a rounding step off, on a screen read to decide
     * whether to intervene.
     */
    const source = code(TRAILING_VIEW);
    expect(source).not.toContain("trailLevelOf");
    expect(source).not.toContain("divideRounded");
    expect(source).not.toContain("applyPercent");
  });

  it("the decision module keeps its runtime strategy list pinned to the union", () => {
    // `STRATEGIES` is derived from a `Record<Strategy, true>` precisely so it
    // cannot drift from the type. A hand-written array would compile and rot.
    const source = code(DECISION);
    expect(source).toContain("Readonly<Record<Strategy, true>>");
    expect(source).toContain("Object.keys(STRATEGY_KEYS)");
  });
});
