/**
 * The enforcement half of "impossible by construction".
 *
 * The type layer makes the unsafe path non-existent WITHIN /src/db: no method
 * takes SQL, no method takes bind values, and money columns are always read
 * through CAST. What TypeScript cannot prevent is a call site reaching past the
 * layer entirely and using the `DB` binding itself -- at which point every
 * guarantee in this folder is off, silently, for any value above 2^53.
 *
 * So it is checked mechanically instead. This is a build failure, not something
 * a reviewer has to notice.
 */

import { describe, expect, it } from "vitest";

// `import.meta.glob` is a Vite feature. Declared here rather than by adding
// "vite/client" to tsconfig's `types`, which would also pull the DOM lib into
// scope while typechecking Worker source.
declare global {
  interface ImportMeta {
    glob(
      pattern: string,
      options: { query: string; eager: true },
    ): Record<string, unknown>;
  }
}

// Vite serves the raw file contents; the pool applies the same transform to
// test code as to source, so this works inside the Workers runtime.
const SOURCES = import.meta.glob("/src/**/*.ts", { query: "?raw", eager: true }) as Record<
  string,
  { default: string }
>;

/**
 * Only /src/db may touch the raw binding. `test-helpers.ts` lives there too and
 * is the deliberate exception: emptying tables between tests is exactly the
 * operation the layer refuses to offer.
 */
const ALLOWED_PREFIX = "/src/db/";

const FORBIDDEN: readonly { readonly pattern: RegExp; readonly why: string }[] = [
  {
    pattern: /\.prepare\s*\(/,
    why: "builds SQL directly; use a Repository method, which generates the CAST for money columns",
  },
  {
    pattern: /\bD1Database\b/,
    why: "names the raw binding type; take a `Database` instead",
  },
  {
    pattern: /\benv\s*\.\s*DB\b/,
    why: "reaches for the D1 binding; construct a `Database` once and pass that",
  },
  {
    pattern: /\.\s*batch\s*\(\s*\[/,
    why: "batches raw statements; use Database.batch with repository statement builders",
  },
];

describe("no raw D1 access outside /src/db", () => {
  it("found the source files to check", () => {
    // If the glob silently returned nothing, every assertion below would pass
    // vacuously, which is the one way this guard could rot without anyone
    // noticing.
    const paths = Object.keys(SOURCES);
    expect(paths.length).toBeGreaterThan(20);
    expect(paths).toContain("/src/db/table.ts");
    expect(paths).toContain("/src/workers/api.ts");
  });

  it.each(FORBIDDEN)("no file outside /src/db matches $pattern", ({ pattern, why }) => {
    const offenders: string[] = [];

    for (const [path, module] of Object.entries(SOURCES)) {
      if (path.startsWith(ALLOWED_PREFIX)) continue;
      const lines = module.default.split("\n");
      for (const [index, line] of lines.entries()) {
        // Skip comments: prose about the rule is not a violation of it.
        const trimmed = line.trim();
        if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue;
        if (pattern.test(line)) {
          offenders.push(`${path}:${index + 1}: ${trimmed}`);
        }
      }
    }

    expect(offenders, `${why}\n${offenders.join("\n")}`).toEqual([]);
  });
});
