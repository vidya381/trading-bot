/**
 * THE GRID CONFIGURATION BLOCK'S BREAKOUT FIELDS, enforced over source.
 *
 * ── WHY A SOURCE SCAN AND NOT A RENDER TEST ──
 *
 * The dashboard has no jsdom and no testing-library, and a test importing a `.tsx`
 * collects ZERO TESTS RATHER THAN FAILING inside the Workers pool this suite runs
 * in (decision logs 44, 45, 46, 48). So nothing here can mount `GridLadderView`
 * and read the text it renders. This is the pattern `proposal-summary-card.test.ts`
 * already uses, for decision log 45's reason: **a guard whose call site nothing can
 * check is most of the way to no guard.**
 *
 * ⚠ THAT IS A REAL GAP AND IT IS NOT CLOSED BY THIS FILE. Position, prominence and
 * colour are verified by the operator's eyes and by nothing else. What a source
 * scan CAN prove is the half that rots silently: the exact WORDS in the two labels
 * and the null-case hint, which is the entire substance of this change.
 *
 * The VALUE shown in the "Grid step" row is pinned separately and properly, by
 * `src/strategies/grid-dashboard-parity.test.ts`, which runs the dashboard's
 * `gridStepOf` and the backend's `topRungGap` over the same ladders.
 *
 * ── WHAT WENT WRONG, AND WHY THE WORDS ARE THE FIX ──
 *
 * `breakoutThresholdPct` is an OPTIONAL PERCENTAGE OVERRIDE. Null does not mean no
 * breakout threshold governs the bot -- it means `breakoutPrice`'s default branch
 * does: one grid step above the highest line (grid.ts, spec 6.2 step 5, decision
 * log 09's decision 4). The field nonetheless rendered "Not set" with the hint
 * "not set", on the detail page of a bot that was halting on a concrete trigger
 * price its own alert named and this page accounted for nowhere. The label had also
 * dropped the "%" that the create form's own label ("Breakout threshold %") carries,
 * so the field read as a missing THRESHOLD rather than an unset OVERRIDE.
 *
 * Every assertion below is one of those three defects, pinned so it cannot return.
 */

import { describe, expect, it } from "vitest";

// `import.meta.glob` is a Vite feature, declared here rather than by adding
// "vite/client" to tsconfig's `types` -- which would pull the DOM lib into scope
// while typechecking Worker source. Mirrors `proposal-summary-card.test.ts`.
declare global {
  interface ImportMeta {
    glob(
      pattern: string,
      options: { query: string; eager: true },
    ): Record<string, unknown>;
  }
}

const SOURCES = import.meta.glob("/dashboard/src/**/*.{ts,tsx}", {
  query: "?raw",
  eager: true,
}) as Record<string, { default: string }>;

const GRID_VIEW = "/dashboard/src/components/GridLadderView.tsx";
const DCA_VIEW = "/dashboard/src/components/DcaPositionView.tsx";
const DERIVE = "/dashboard/src/derive.ts";

function raw(path: string): string {
  const module = SOURCES[path];
  expect(module, `${path} is not in the scanned source set`).toBeDefined();
  return module!.default;
}

/**
 * Source lines only: prose ABOUT the rule is not an instance of it. Load-bearing
 * here more than anywhere -- the component's own comments quote the old "Not set"
 * wording verbatim to explain why it changed, and a naive substring search over
 * the whole file would read those quotes as the defect still being present.
 */
function code(path: string): string {
  return raw(path)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => !line.startsWith("//") && !line.startsWith("*") && !line.startsWith("/*"))
    .join("\n");
}

/**
 * The one `<ConfigItem>` whose `label` matches, as source text.
 *
 * Needed because the two nullable grid fields are worded DIFFERENTLY ON PURPOSE
 * (see the take-profit assertion below): "Not set" and the hint "not set" must
 * still appear in this file, just not in the breakout item. A whole-file search
 * for either phrase therefore proves nothing in the direction that matters, and
 * would fail on a correct component.
 */
function configItem(path: string, label: string): string {
  const source = code(path);
  const at = source.indexOf(`label="${label}"`);
  expect(at, `no ConfigItem labelled ${JSON.stringify(label)} in ${path}`).toBeGreaterThan(-1);
  const open = source.lastIndexOf("<ConfigItem", at);
  const close = source.indexOf("</ConfigItem>", at);
  expect(open, `ConfigItem ${JSON.stringify(label)} has no opening tag`).toBeGreaterThan(-1);
  expect(close, `ConfigItem ${JSON.stringify(label)} has no closing tag`).toBeGreaterThan(open);
  return source.slice(open, close);
}

describe("the breakout threshold field says what actually governs the bot", () => {
  it("found the sources to check", () => {
    // Without this every assertion below passes vacuously, which is the one way a
    // source-scan guard rots with nobody noticing.
    const paths = Object.keys(SOURCES);
    expect(paths.length).toBeGreaterThan(20);
    for (const path of [GRID_VIEW, DCA_VIEW, DERIVE]) {
      expect(paths).toContain(path);
    }
  });

  it("the comment-stripper really does strip prose, so the assertions below mean something", () => {
    /*
     * The guard on the guard. `GridLadderView.tsx` deliberately explains the old
     * wording in a comment, and if `code()` ever stopped filtering comments the
     * assertions below would read those explanations as the defect itself. The
     * phrase chosen appears ONLY in comment prose, nowhere in rendered source.
     */
    expect(raw(GRID_VIEW)).toContain("NULL HERE IS A DEFAULT IN FORCE");
    expect(code(GRID_VIEW)).not.toContain("NULL HERE IS A DEFAULT IN FORCE");
  });

  it('⚠ the label carries the "%" unit the create form has always carried', () => {
    const source = code(GRID_VIEW);
    expect(source).toContain('label="Breakout threshold %"');
    // And the unitless label is gone, not merely joined by a second one.
    expect(source).not.toContain('label="Breakout threshold"');
  });

  it('⚠ null renders "Default", never "Not set"', () => {
    const item = configItem(GRID_VIEW, "Breakout threshold %");
    expect(item).toContain(">Default<");
    expect(item).not.toContain("Not set");
  });

  it("⚠ the null hint states the rule in force rather than an absence", () => {
    const item = configItem(GRID_VIEW, "Breakout threshold %");
    expect(item).toContain('"one grid step above the top line"');
    expect(item).not.toContain('"not set"');
  });

  it('⚠ the take-profit AMOUNT still says "Not set", because there null really is nothing', () => {
    /*
     * THE SCOPE ASSERTION, and the one most likely to be violated by a well-meaning
     * future edit that "makes the block consistent". `takeProfitAmount` and
     * `breakoutThresholdPct` are both nullable and they do NOT mean the same thing:
     * a null take-profit amount means no accumulated-profit target exists at all
     * (the bot then relies on its stop-loss and breakout exit -- decision log
     * 10-frontend), while a null breakout threshold means a DEFAULT COMPUTES ONE.
     * Wording them identically in either direction would be wrong about one of them.
     */
    const source = code(GRID_VIEW);
    expect(source).toContain('label="Take-profit amount"');
    expect(source).toContain('hint={params.takeProfitAmount === null ? "not set" : "accumulated realized"}');
  });
});

describe("the grid step row", () => {
  it("⚠ is rendered, with a label and a hint that say what the number is", () => {
    const source = code(GRID_VIEW);
    expect(source).toContain('label="Grid step"');
    expect(source).toContain('hint="gap between the top two lines"');
  });

  it("⚠ shows the ladder's own gap, from the shared helper rather than inline arithmetic", () => {
    /*
     * The row must render `gridStepOf(ladder.levels)` -- the function the parity
     * test pins to the backend's `topRungGap`. Arithmetic written inline in the
     * `.tsx` would be unreachable by every test in this repository, which is the
     * whole reason the helper lives in `derive.ts` at all.
     */
    const source = code(GRID_VIEW);
    expect(source).toContain("gridStepOf(ladder.levels)");
    expect(source).toMatch(/import \{[^}]*\bgridStepOf\b[^}]*\} from "\.\.\/derive"/);
    expect(source).toContain("{formatMoney(gridStep)}");
  });

  it("the helper it calls is exported from derive.ts", () => {
    expect(code(DERIVE)).toContain("export function gridStepOf(");
  });

  it("sits beside the threshold it explains, not somewhere else in the block", () => {
    // The default is stated as "one grid step above the top line"; the number that
    // phrase refers to has to be readable in the same glance or the wording is a
    // riddle. JSX child order is render order.
    const source = code(GRID_VIEW);
    const threshold = source.indexOf('label="Breakout threshold %"');
    const step = source.indexOf('label="Grid step"');
    const takeProfit = source.indexOf('label="Take-profit amount"');
    expect(threshold).toBeGreaterThan(-1);
    expect(step).toBeGreaterThan(threshold);
    // Nothing else was inserted between them.
    expect(takeProfit).toBeLessThan(threshold);
  });
});

describe("⚠ what this change deliberately did NOT add", () => {
  it("no resolved breakout PRICE is computed or shown anywhere in the dashboard", () => {
    /*
     * THE NOT-CHOSEN-OPTION ASSERTION. Re-deriving `breakoutPrice` client-side --
     * an `applyPercent` with a ceil on one branch, an addition on the other -- was
     * considered and rejected: this project has twice recorded that a second
     * implementation of a backend formula is free to drift a rounding step
     * (`feesFor` in api/handlers.ts, decision log 44's re-validation note), and the
     * copy that drifts is the one nobody is watching. Showing the GAP and leaving
     * the addition to the reader is what replaced it.
     *
     * This is pinned rather than merely written down, because "add the price too,
     * it's one line" is the obvious next edit and it is the one that reintroduces
     * the risk. Adding it deliberately means deleting this test and writing its
     * parity assertion in `grid-dashboard-parity.test.ts` instead.
     */
    const grid = code(GRID_VIEW);
    expect(grid).not.toContain("breakoutPrice");
    expect(grid).not.toContain("Breakout at");
    expect(code(DERIVE)).not.toContain("breakoutPrice");
  });

  it("DCA's config block was not touched", () => {
    // A parallel gap (DCA shows no stop-loss PRICE either) was noted and left
    // alone. Its take-profit price row is the one derived figure it has, and it
    // still comes from the same helper.
    const source = code(DCA_VIEW);
    expect(source).toContain("takeProfitPriceOf(position.averageEntryPrice, params.takeProfitPct)");
    expect(source).not.toContain("gridStepOf");
  });
});
