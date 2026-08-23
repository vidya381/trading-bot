/**
 * GROUP E — structural guards on the polling layer.
 *
 * The same mechanism as `single-kill-switch-poll.test.ts` and `no-raw-d1.test.ts`:
 * read the source and assert properties of it, so a violation is a build failure
 * rather than something a reviewer has to notice. Each of these three rules is
 * one an ordinary test cannot see, because each is about where code LIVES rather
 * than what it computes.
 *
 * A source scan checks the text, not the behaviour -- stated here as it is stated
 * in every other guard in this repository.
 */

import { describe, expect, it } from "vitest";

declare global {
  interface ImportMeta {
    glob(
      pattern: string,
      options: { query: string; eager: true },
    ): Record<string, unknown>;
  }
}

const DASHBOARD = import.meta.glob("/dashboard/src/**/*.{ts,tsx}", {
  query: "?raw",
  eager: true,
}) as Record<string, { default: string }>;

const WORKER = import.meta.glob("/src/**/*.ts", {
  query: "?raw",
  eager: true,
}) as Record<string, { default: string }>;

/** Source lines only: prose ABOUT a rule is not a violation OF it. */
function codeLines(source: string): { line: string; number: number }[] {
  return source
    .split("\n")
    .map((line, index) => ({ line: line.trim(), number: index + 1 }))
    .filter(({ line }) => !line.startsWith("//") && !line.startsWith("*") && !line.startsWith("/*"));
}

const ENGINE = "/dashboard/src/api/pollEngine.ts";
const FRESHNESS = "/dashboard/src/pollFreshness.ts";
const HOOK = "/dashboard/src/api/usePolling.ts";

describe("E. structural guards on the polling layer", () => {
  it("E1: NO FAKE TIMERS anywhere in the suite — the injected clock is the whole point", () => {
    // This repository has never used `@sinonjs/fake-timers`, and whether they
    // behave correctly inside workerd is UNPROVEN here. `pollEngine`'s timer port
    // exists precisely so a polling test never had to be the first to find out.
    // If someone reaches for them later, the port has stopped being enough and
    // that deserves a decision, not a quiet import.
    const offenders: string[] = [];
    for (const [path, module] of Object.entries({ ...DASHBOARD, ...WORKER })) {
      for (const { line, number } of codeLines(module.default)) {
        if (/useFakeTimers|advanceTimersByTime|vi\.setSystemTime/.test(line)) {
          offenders.push(`${path}:${number}: ${line}`);
        }
      }
    }

    expect(
      offenders,
      "inject a clock through a port instead (see pollEngine.ts)\n" + offenders.join("\n"),
    ).toEqual([]);
  });

  it("E2: the decision modules stay REACT-FREE, or no test in this repo can execute them", () => {
    // A test importing a `.tsx` COLLECTS ZERO TESTS RATHER THAN FAILING inside
    // the Workers pool (docs/open-items/component-test-harness.md). It reports a
    // green suite having run nothing. A single React import in either of these
    // files would silently delete this entire step's coverage.
    expect(Object.keys(DASHBOARD)).toContain(ENGINE);
    expect(Object.keys(DASHBOARD)).toContain(FRESHNESS);

    for (const path of [ENGINE, FRESHNESS]) {
      for (const { line, number } of codeLines(DASHBOARD[path]!.default)) {
        expect(line, `${path}:${number} imports React`).not.toMatch(/from ["']react/);
      }
    }
  });

  it("E3: usePolling is WIRING — every decision lives where a test can reach it", () => {
    const hook = codeLines(DASHBOARD[HOOK]!.default).map(({ line }) => line);
    const body = hook.join("\n");

    // The branches that used to live in the hook -- the abort, the AbortError
    // test, the last-good catch -- are what nothing could test. If any of them
    // comes back here, it has left the tested world.
    expect(body).not.toMatch(/\bcatch\b/);
    expect(body).not.toMatch(/instanceof/);
    expect(body).not.toMatch(/new AbortController/);
    expect(body).not.toMatch(/\.abort\(/);
    expect(body).toContain("createPollEngine");

    // And exactly one non-test file builds the engine with the real clock and the
    // real timers. A second one would be a second polling implementation, which
    // is how `single-kill-switch-poll.test.ts`'s duplicate-poller bug happened.
    const builders = Object.entries(DASHBOARD)
      .filter(([path]) => !path.endsWith(".test.ts") && !path.endsWith(".test.tsx"))
      // Defining it is not building one, so the engine's own file is not a
      // builder of itself.
      .filter(([path]) => path !== ENGINE)
      .filter(([, module]) =>
        codeLines(module.default).some(({ line }) => /createPollEngine\s*[<(]/.test(line)),
      )
      .map(([path]) => path);

    expect(builders).toEqual([HOOK]);
  });
});
