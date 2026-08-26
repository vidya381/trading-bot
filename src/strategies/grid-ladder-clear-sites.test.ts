/**
 * A TRIPWIRE ON WHOLESALE LADDER CLEARS, not a proof that any of them is right.
 *
 * ── WHAT WENT WRONG, AND WHY A REGEX IS THE HONEST TOOL FOR IT ──
 *
 * `GridLadder.placed` was a one-way latch. Three separate paths nulled every
 * rung on a ladder -- `#gridExit`, `liquidatePosition`, and the
 * `#cancelOpenOrders` sweep that every `#halt` runs -- and not one of them
 * touched the latch, because nothing connected "I am emptying this ladder" to
 * "something has to decide to build it again". Two live testnet bots came back
 * from a halt running, watching price, and permanently unable to trade.
 *
 * The FIX for that is not this file. `decide` now asks `vacantLadder` on every
 * tick, so a wholesale clear is self-correcting whether or not its author
 * remembered anything -- correctness is a property of the state, which is
 * exactly what a fourth clear site cannot silently break. See
 * `docs/open-items/grid-ladder-placed-latch.md`.
 *
 * So this is INSURANCE, and its value is documentary. It fails the build when a
 * new site starts nulling a whole slots array, which puts the question
 * ("is the rebuild condition still true of what you just created?") in front of
 * whoever adds it, at the moment they add it. It follows the pattern this
 * repository already uses for invariants no type can express --
 * `src/db/no-raw-d1.test.ts` and `dashboard/src/api/single-kill-switch-poll.test.ts`
 * -- including their anti-vacuity guard, without which a glob that matched
 * nothing would make the whole file pass while checking nothing.
 *
 * ⚠ WHAT IT DOES NOT PROVE, stated plainly because a guard that oversells
 * itself is worse than none: a regex over source cannot tell whether a new
 * clear site is HANDLED. It can only tell that someone was made to look.
 */

import { describe, expect, it } from "vitest";

// `import.meta.glob` is a Vite feature. Declared here rather than by adding
// "vite/client" to tsconfig's `types`, which would pull the DOM lib into scope
// while typechecking Worker source. Mirrors `no-raw-d1.test.ts`.
declare global {
  interface ImportMeta {
    glob(pattern: string, options: { query: string; eager: true }): Record<string, unknown>;
  }
}

const SOURCES = import.meta.glob("/src/**/*.ts", { query: "?raw", eager: true }) as Record<
  string,
  { default: string }
>;

/**
 * Writing `null` into EVERY slot at once -- `slots.map(() => null)` and its
 * spacing variants. A per-rung clear (`map((slot, index) => ...)`) is a
 * different operation and is deliberately not matched: it leaves a working
 * ladder behind, which is the ordinary business of folding one order.
 */
const WHOLESALE_CLEAR = /\.slots\s*\.\s*map\s*\(\s*\(\s*\)\s*=>\s*null\s*\)/;

/**
 * The sites that existed when the rebuild condition was designed, each one
 * checked against `vacantLadder` at that time.
 *
 * A new entry here is not forbidden -- it is a decision. Adding one means
 * confirming that the state the clear leaves behind is either matched by
 * `vacantLadder` (so the next tick rebuilds) or deliberately excluded by one of
 * its conjuncts, and saying which in the code you are adding.
 */
const KNOWN_SITES: readonly string[] = [
  // `liquidatePosition`: clears the ladder before sizing the liquidation sell.
  // Leaves `exitOrderId` set, so `vacantLadder` is false until that sell fills.
  "/src/durable-objects/bot-instance.ts",
];

describe("wholesale ladder clears are enumerated", () => {
  it("found the source files to check", () => {
    // Without this, every assertion below passes vacuously -- the one way a
    // source-level guard rots without anyone noticing.
    const paths = Object.keys(SOURCES);
    expect(paths.length).toBeGreaterThan(20);
    expect(paths).toContain("/src/durable-objects/bot-instance.ts");
    expect(paths).toContain("/src/strategies/grid.ts");
  });

  it("still matches the clears it was written against", () => {
    // Proves the pattern itself has not gone stale. If a refactor reformats
    // those two lines out of the regex's reach, this fails rather than the
    // guard quietly covering nothing.
    const source = SOURCES["/src/durable-objects/bot-instance.ts"]!.default;
    const hits = source.split("\n").filter((line) => WHOLESALE_CLEAR.test(line));
    expect(hits).toHaveLength(2);
  });

  it("no file outside the known list clears a whole slots array", () => {
    const offenders: string[] = [];

    for (const [path, module] of Object.entries(SOURCES)) {
      if (path.endsWith(".test.ts")) continue;
      if (KNOWN_SITES.includes(path)) continue;
      for (const [index, line] of module.default.split("\n").entries()) {
        const trimmed = line.trim();
        // Prose about the rule is not a violation of it.
        if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue;
        if (WHOLESALE_CLEAR.test(line)) offenders.push(`${path}:${index + 1}: ${trimmed}`);
      }
    }

    expect(
      offenders,
      "a new wholesale ladder clear appeared. Confirm `vacantLadder` still " +
        "describes the state it leaves behind -- either it matches (the next " +
        "tick rebuilds) or one of its conjuncts deliberately excludes it -- " +
        "then add the file to KNOWN_SITES with that reasoning.\n" +
        offenders.join("\n"),
    ).toEqual([]);
  });
});
