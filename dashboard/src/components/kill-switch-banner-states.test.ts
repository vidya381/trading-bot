/**
 * THE BANNER MUST NOT DECIDE ITS OWN VERDICT.
 *
 * `killSwitchBannerState.test.ts` proves the RULE is right. It cannot prove the
 * component uses it: the dashboard has no component-test harness, and a test
 * importing a `.tsx` collects ZERO TESTS rather than failing inside the Workers
 * pool (docs/open-items/component-test-harness.md). That is the exact gap
 * `proposalFields.ts` was extracted after a mutation run exposed -- a guard's
 * CALL SITE, being one line inside a `.tsx`, was unreachable by any test, so a
 * mutant deleting it survived.
 *
 * So the call site is checked at the source level, the same way
 * `no-raw-d1.test.ts` and `single-kill-switch-poll.test.ts` check theirs: the
 * banner imports the shared rule, and the one-line conflation it replaced --
 * `status.state !== "tripped"` reached from a possibly-null status -- is not
 * anywhere in the file.
 *
 * ⚠ WHAT THIS PROVES AND WHAT IT DOES NOT. It proves the text of the component
 * routes its decision through the tested module and no longer contains the
 * defective expression. It proves NOTHING about colour, contrast, copy,
 * placement, or whether the amber band is actually legible on the deployed page.
 * Those are the operator's to verify, as every prior UI step in this arc has
 * been.
 */

import { describe, expect, it } from "vitest";

// `import.meta.glob` is a Vite feature. Declared here rather than by adding
// "vite/client" to tsconfig's `types`, which would also pull the DOM lib into
// scope while typechecking Worker source. Mirrors single-kill-switch-poll.test.ts.
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

const BANNER = "/dashboard/src/components/KillSwitchBanner.tsx";
const RULE = "/dashboard/src/killSwitchBannerState.ts";

describe("the kill-switch banner routes its verdict through the tested rule", () => {
  it("found the files to check", () => {
    // Without this, every assertion below would pass vacuously if the glob ever
    // stopped matching -- the one way a source guard rots unnoticed.
    expect(Object.keys(SOURCES)).toContain(BANNER);
    expect(Object.keys(SOURCES)).toContain(RULE);
    expect(SOURCES[BANNER]!.default.length).toBeGreaterThan(500);
  });

  it("the banner calls killSwitchBannerState", () => {
    expect(SOURCES[BANNER]!.default).toContain("killSwitchBannerState(poll)");
  });

  it("the banner no longer contains the conflating expression it replaced", () => {
    // The literal defect from `db52912`: `status.state !== "tripped"` used as the
    // render gate, reachable with `status === null`, which made "we do not know"
    // render exactly what "confirmed armed" renders. Prose about the rule is not
    // a violation of it, so comment lines are excluded.
    const offenders = SOURCES[BANNER]!.default
      .split("\n")
      .map((line, index) => ({ line: line.trim(), number: index + 1 }))
      .filter(({ line }) => !line.startsWith("//") && !line.startsWith("*") && !line.startsWith("/*"))
      .filter(({ line }) => /state\s*!==\s*"tripped"/.test(line));

    expect(
      offenders.map((o) => `${BANNER}:${o.number}: ${o.line}`),
      'reading "not tripped" as armed is the bug this step fixed: a null status ' +
        "would take that branch and render an all-clear for a state nobody knows. " +
        "Use killSwitchBannerState(poll) instead.",
    ).toEqual([]);
  });

  it("the rule module is React-free, so the suite can reach it", () => {
    // The constraint that forced the extraction. If this module ever imports
    // React or JSX, the tests importing it stop COLLECTING and report a green
    // suite -- the failure mode that makes this whole pattern necessary.
    //
    // Import lines only. This module's own header explains the JSX constraint in
    // prose, and prose about the rule is not a violation of it.
    const imports = SOURCES[RULE]!.default
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith("import "));

    expect(imports.filter((line) => /["']react/.test(line))).toEqual([]);
    expect(imports.filter((line) => /jsx/.test(line))).toEqual([]);
    expect(RULE.endsWith(".ts")).toBe(true);
  });

  it("the banner has a separate unknown branch, with both ARIA roles present", () => {
    const banner = SOURCES[BANNER]!.default;
    expect(banner).toContain('state === "unknown"');
    // Polite for unconfirmed, assertive for confirmed-tripped. Two assertive
    // bars is where alert habituation starts.
    expect(banner).toContain('role="status"');
    expect(banner).toContain('role="alert"');
  });

  it("the unknown branch uses NO red utility -- it is not a shade of the tripped bar", () => {
    // The one visual property a source scan CAN enforce, and the one that
    // matters: a third state styled as a lighter red would re-merge with the
    // state it exists to be distinguished from. The unknown branch is sliced out
    // by its own `if` block so the tripped bar's red classes below it are not
    // counted.
    const banner = SOURCES[BANNER]!.default;
    const start = banner.indexOf('if (state === "unknown") {');
    expect(start, "the unknown branch must exist as its own block").toBeGreaterThan(-1);
    const end = banner.indexOf("// `tripped`.", start);
    expect(end, "the tripped branch must follow it").toBeGreaterThan(start);
    const unknownBranch = banner.slice(start, end);

    expect(unknownBranch.match(/\b(?:bg|text|border|from|to)-red-\d+/g) ?? []).toEqual([]);
    // And it must actually be styled, rather than having lost its classes to a
    // refactor: a filled amber bar with a rule along one edge.
    expect(unknownBranch).toContain("bg-amber-900");
    expect(unknownBranch).toContain("border-amber-400");
  });
});
