/**
 * THE POST-HALT NOTICE'S CALL SITES, checked at the source level.
 *
 * `postHaltEvents.test.ts` proves the RULES are right. It cannot prove any
 * component uses them, or that the notice is rendered anywhere at all: the
 * dashboard has no component-test harness, and a test importing a `.tsx`
 * collects ZERO TESTS rather than failing inside the Workers pool
 * (`docs/open-items/component-test-harness.md`). A notice nobody renders would
 * pass every test in that file.
 *
 * So the call sites are pinned here, the same way `kill-switch-banner-states.test.ts`,
 * `proposal-summary-card.test.ts` and `no-raw-d1.test.ts` pin theirs.
 *
 * ⚠ WHAT THIS PROVES AND WHAT IT DOES NOT. It proves the components route their
 * decisions through the tested module, that the notice is rendered on both
 * surfaces, that it sits below the halt banner rather than above or instead of
 * it, and that it does not wear the halt banner's colour. It proves NOTHING
 * about contrast, legibility, or whether the amber band actually reads as
 * secondary on the deployed page. Those are the operator's, as every UI step in
 * this project has been.
 */

import { describe, expect, it } from "vitest";

// `import.meta.glob` is a Vite feature. Declared here rather than by adding
// "vite/client" to tsconfig's `types`, which would also pull the DOM lib into
// scope while typechecking Worker source. Mirrors the guards named above.
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

const NOTICE = "/dashboard/src/components/PostHaltNotice.tsx";
const SUMMARY = "/dashboard/src/components/BotSummary.tsx";
const LIST = "/dashboard/src/components/BotList.tsx";
const ALERTS = "/dashboard/src/components/AlertList.tsx";
const RULE = "/dashboard/src/postHaltEvents.ts";

function raw(path: string): string {
  const module = SOURCES[path];
  expect(module, `${path} is not in the scanned source set`).toBeDefined();
  return module!.default;
}

/** Source lines only: prose about a rule is not a violation of it. */
function code(path: string): string {
  return raw(path)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => !line.startsWith("//") && !line.startsWith("*") && !line.startsWith("/*"))
    .join("\n");
}

describe("the files under guard", () => {
  it("found every one of them", () => {
    // Without this, every assertion below passes vacuously the moment the glob
    // stops matching -- the one way a source guard rots unnoticed.
    for (const path of [NOTICE, SUMMARY, LIST, ALERTS, RULE]) {
      expect(Object.keys(SOURCES)).toContain(path);
      expect(raw(path).length).toBeGreaterThan(500);
    }
  });
});

describe("the notice decides nothing itself", () => {
  it("routes its verdict through postHaltNotice", () => {
    expect(code(NOTICE)).toContain("postHaltNotice(bot)");
  });

  it("does not re-implement the empty check the rule already makes", () => {
    // The rule returns null for "nothing to say" precisely so this component has
    // one gate. A second, inline `events.length === 0` here is how the two drift:
    // one of them gets a new condition and the other does not.
    expect(code(NOTICE)).not.toMatch(/postHaltEvents\s*\.\s*length/);
  });

  it("does not decide from the status directly", () => {
    // `staleForStatus` is the rule's, and it deliberately does NOT hide the
    // events. An inline `status === "halted"` gate here would re-hide exactly the
    // inconsistency the rule exists to surface.
    const source = code(NOTICE);
    expect(source).not.toMatch(/bot\s*\.\s*status\s*===/);
    expect(source).not.toMatch(/bot\s*\.\s*status\s*!==/);
  });

  it("builds its pluralisation nowhere: the heading comes from the rule", () => {
    expect(code(NOTICE)).toContain("notice.heading");
    expect(code(NOTICE)).not.toMatch(/length\s*===\s*1\s*\?/);
  });
});

describe("the notice is actually rendered, on both surfaces", () => {
  it("the bot detail summary renders it", () => {
    expect(code(SUMMARY)).toContain("<PostHaltNotice bot={bot} />");
  });

  it("renders BELOW the halt reason banner, never above it", () => {
    // The order is the argument: the red band is the primary safety fact and has
    // to be read first. Rendering this above it would put the incidental event
    // where the reason belongs.
    const source = code(SUMMARY);
    const halt = source.indexOf("bot.haltReason");
    const notice = source.indexOf("<PostHaltNotice");
    expect(halt).toBeGreaterThan(-1);
    expect(notice).toBeGreaterThan(-1);
    expect(notice).toBeGreaterThan(halt);
  });

  it("is NOT nested inside the halted-status condition", () => {
    // It carries its own gate, so events that outlive their halt are shown and
    // flagged rather than hidden by a condition that stopped being true.
    const source = code(SUMMARY);
    const conditional = source.indexOf('bot.status === "halted" && bot.haltReason');
    const closes = source.indexOf(")}", conditional);
    const notice = source.indexOf("<PostHaltNotice");
    expect(notice).toBeGreaterThan(closes);
  });

  it("the list renders the tag in BOTH layouts", () => {
    // The table (desktop) and the card (mobile) are separate renderers here, and
    // an indicator added to only one is invisible at the other width -- which is
    // the same invisibility this whole feature exists to end. `ArchivedTag`
    // appears twice for the same reason; this must match it.
    const source = code(LIST);
    const tags = source.match(/<PostHaltTag bot=\{bot\} \/>/g) ?? [];
    expect(tags).toHaveLength(2);
    const archived = source.match(/<ArchivedTag bot=\{bot\} \/>/g) ?? [];
    expect(tags.length).toBe(archived.length);
  });

  it("the list tag takes its words from the rule, not from inline prose", () => {
    expect(code(LIST)).toContain("postHaltTagTitle(bot)");
  });
});

describe("it is distinguishable from the halt banner", () => {
  it("wears no red anywhere", () => {
    // Red is the halt's, throughout this dashboard (`AlertList.tsx` fixes the
    // vocabulary: info sky, warning amber, critical red). This band is the
    // backend's `warning`, and a red one would read as a second halt reason --
    // exactly the conflation the backend refuses to write.
    const offenders = raw(NOTICE)
      .split("\n")
      .map((line, index) => ({ line: line.trim(), number: index + 1 }))
      .filter(({ line }) => !line.startsWith("//") && !line.startsWith("*") && !line.startsWith("/*"))
      .filter(({ line }) => /\bred-\d/.test(line));
    expect(offenders, `red styling in ${NOTICE}`).toEqual([]);
  });

  it("uses the amber the warning severity already means", () => {
    expect(code(NOTICE)).toMatch(/amber-\d/);
  });

  it("says in words that the transition did not happen", () => {
    // Colour is never the only carrier -- "a distinction a colour-blind reviewer
    // cannot make is the same as no distinction" (ProposalFreshness.tsx).
    expect(raw(NOTICE)).toContain("Did not happen:");
  });
});

describe("the pointers go somewhere real, or nowhere at all", () => {
  it("links the alert through the one shared anchor builder", () => {
    expect(code(NOTICE)).toContain("alertRowAnchor(item.alertId)");
  });

  it("the alert list puts that same anchor on its rows", () => {
    // Both halves through one function, so a rename cannot move only one side and
    // leave a link that silently scrolls nowhere.
    const source = code(ALERTS);
    expect(source).toContain("alertRowAnchor(alert.id)");
    // On BOTH branches -- the linked row and the plain one. The bot detail page
    // renders the plain branch, which is precisely the one the notice links to.
    expect((source.match(/id=\{rowId\}/g) ?? []).length).toBe(2);
  });

  it("neither side hand-builds the anchor string", () => {
    for (const path of [NOTICE, ALERTS]) {
      expect(code(path), path).not.toMatch(/["'`]#?alert-\$\{/);
    }
  });

  it("does NOT fabricate a link for the audit id", () => {
    // There is no audit-log route in this dashboard (`App.tsx`). A link to a page
    // that does not exist is the silent gap on a correction surface this project
    // refuses everywhere else, so the id is rendered as copyable text instead.
    const source = code(NOTICE);
    expect(source).toContain("item.auditId");
    expect(source).not.toMatch(/(href|to)=\{[^}]*auditId/);
  });
});
