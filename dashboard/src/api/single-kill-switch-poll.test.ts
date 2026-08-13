/**
 * ONE kill-switch poll, enforced mechanically (step 47).
 *
 * The duplicate-poller bug this guards against was invisible to every other
 * check in this repository: three separate files each called
 * `usePolling(fetchKillSwitch)`, each one correct in isolation, and the only
 * symptom was a request rate in the operator's HAR (232 kill-switch requests in
 * 609 s, ~2.6 s apart, against alerts' ~5.25 s -- exactly double, from two 5 s
 * timers at arbitrary phase). Nothing typechecks wrong when a poll is duplicated,
 * and the dashboard has no component-test harness that could observe two timers.
 *
 * So it is checked at the source level instead, the same way `no-raw-d1.test.ts`
 * enforces "no raw D1 outside /src/db": a build failure, not something a reviewer
 * has to notice. The rule is narrow and stated as the thing that actually
 * matters -- `fetchKillSwitch` is subscribed to in exactly ONE place, and that
 * place is the shared provider.
 *
 * This does NOT prove one HTTP request leaves the browser per interval; only a
 * real HAR capture does that, and the operator does that half. What it proves is
 * the precondition: there is exactly one subscription in the source, so there is
 * exactly one timer to fire.
 */

import { describe, expect, it } from "vitest";

// `import.meta.glob` is a Vite feature. Declared here rather than by adding
// "vite/client" to tsconfig's `types`, which would also pull the DOM lib into
// scope while typechecking Worker source. Mirrors no-raw-d1.test.ts.
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

/** The one file allowed to subscribe. Everything else reads from it. */
const PROVIDER = "/dashboard/src/api/killSwitchStatus.tsx";

/** Where `fetchKillSwitch` is defined -- declaring it is not subscribing to it. */
const CLIENT = "/dashboard/src/api/client.ts";

/** Source lines only: prose about the rule is not a violation of it. */
function codeLines(source: string): { line: string; number: number }[] {
  return source
    .split("\n")
    .map((line, index) => ({ line: line.trim(), number: index + 1 }))
    .filter(({ line }) => !line.startsWith("//") && !line.startsWith("*") && !line.startsWith("/*"));
}

describe("exactly one kill-switch subscription", () => {
  it("found the dashboard sources to check", () => {
    // If the glob silently returned nothing, every assertion below would pass
    // vacuously -- the one way this guard could rot without anyone noticing.
    const paths = Object.keys(SOURCES);
    expect(paths.length).toBeGreaterThan(20);
    expect(paths).toContain(PROVIDER);
    expect(paths).toContain("/dashboard/src/App.tsx");
    expect(paths).toContain("/dashboard/src/components/KillSwitchBanner.tsx");
    expect(paths).toContain("/dashboard/src/pages/KillSwitchPage.tsx");
  });

  it("only the shared provider calls usePolling with fetchKillSwitch", () => {
    const offenders: string[] = [];

    for (const [path, module] of Object.entries(SOURCES)) {
      if (path === PROVIDER) continue;
      for (const { line, number } of codeLines(module.default)) {
        if (/usePolling\s*[<(][^;]*fetchKillSwitch/.test(line)) {
          offenders.push(`${path}:${number}: ${line}`);
        }
      }
    }

    expect(
      offenders,
      "a second kill-switch poll would double the request rate against the same " +
        "singleton row; read the shared one with useKillSwitchStatus() instead\n" +
        offenders.join("\n"),
    ).toEqual([]);
  });

  it("the provider subscribes exactly once", () => {
    const provider = SOURCES[PROVIDER]!.default;
    const subscriptions = codeLines(provider).filter(({ line }) =>
      /usePolling\s*[<(][^;]*fetchKillSwitch/.test(line),
    );
    expect(subscriptions).toHaveLength(1);
  });

  it("no component imports fetchKillSwitch directly", () => {
    // The stronger form of the rule: a consumer that imports the fetcher at all
    // is one line away from re-introducing a second poll, and has no reason to
    // hold it -- the shared PollState already carries `refetch`.
    const offenders: string[] = [];

    for (const [path, module] of Object.entries(SOURCES)) {
      if (path === PROVIDER || path === CLIENT) continue;
      if (path.endsWith(".test.ts") || path.endsWith(".test.tsx")) continue;
      for (const { line, number } of codeLines(module.default)) {
        if (/\bimport\b[^;]*\bfetchKillSwitch\b/.test(line)) {
          offenders.push(`${path}:${number}: ${line}`);
        }
      }
    }

    expect(
      offenders,
      "use useKillSwitchStatus() -- it exposes data, error, loading, lastUpdated " +
        "and refetch from the one shared poll\n" + offenders.join("\n"),
    ).toEqual([]);
  });

  it("every kill-switch consumer reads the shared hook", () => {
    // The completeness half: the three consumers that existed before the
    // consolidation must all still be wired to something. A consumer silently
    // dropped during the refactor would stop updating, which is exactly the
    // failure mode "consolidation" invites.
    const consumers = [
      "/dashboard/src/components/KillSwitchBanner.tsx",
      "/dashboard/src/pages/Dashboard.tsx",
      "/dashboard/src/pages/KillSwitchPage.tsx",
    ];

    for (const path of consumers) {
      const source = SOURCES[path]!.default;
      expect(source, `${path} must read the shared kill-switch poll`).toContain(
        "useKillSwitchStatus()",
      );
    }
  });

  it("the provider is mounted in App.tsx", () => {
    // A provider nobody mounts makes every consumer throw at runtime. Cheap to
    // assert, and the failure it prevents is a blank app.
    const app = SOURCES["/dashboard/src/App.tsx"]!.default;
    expect(app).toContain("KillSwitchStatusProvider");
  });
});
