/**
 * THE SUMMARY CARD'S STRUCTURAL PROPERTIES, enforced over source.
 *
 * ── WHY A SOURCE SCAN AND NOT A RENDER TEST ──
 *
 * The dashboard has no jsdom and no testing-library, and a test importing a `.tsx`
 * collects ZERO TESTS RATHER THAN FAILING inside the Workers pool this suite runs
 * in (decision logs 44, 45, 46, 48). So nothing in this repository can mount
 * `ProposalView`, read the DOM order of its children, or click a `<summary>`.
 *
 * ⚠ THAT IS A REAL GAP AND IT IS NOT CLOSED BY THIS FILE. Installing jsdom and
 * `@testing-library/react` behind a second vitest project is a live proposal,
 * deliberately scoped OUT of this step so a UI change did not silently become a
 * toolchain change. Until it lands, POSITION, PROMINENCE, COLOUR and the rendered
 * open/closed state are verified by the operator's eyes and by nothing else.
 *
 * What a source scan CAN prove is narrower and is worth having, because it is the
 * half that rots silently: the card is rendered, it is rendered FIRST, the link is
 * rendered exactly once and from the card, every `<details>` on the page ships
 * without an `open` attribute, and the two things that must never collapse have not
 * been swept into one. This is the pattern `no-raw-d1.test.ts`,
 * `single-kill-switch-poll.test.ts` and `prefill-does-not-approve.test.ts` already
 * use, for decision log 45's reason: **a guard whose call site nothing can check is
 * most of the way to no guard.**
 *
 * ── ⚠ WHY "DEFAULTS TO COLLAPSED" IS CHECKABLE AT ALL ──
 *
 * Because the collapse is a native `<details>` and not a `useState`. "Expands on
 * click" is then the browser's behaviour, which this project does not implement and
 * therefore cannot regress, and "defaults to collapsed" is the ABSENCE of an `open`
 * attribute — a property in the source text. A `useState(false)` toggle would have
 * put both halves in a `.tsx` where no test could reach either.
 */

import { describe, expect, it } from "vitest";

// `import.meta.glob` is a Vite feature, declared here rather than by adding
// "vite/client" to tsconfig's `types` — which would pull the DOM lib into scope
// while typechecking Worker source. Mirrors the three guards named above.
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

const VIEW = "/dashboard/src/components/ProposalView.tsx";
const CARD = "/dashboard/src/components/ProposalSummaryCard.tsx";
const LINK = "/dashboard/src/components/ProposalCreateBotLink.tsx";
const CITATIONS = "/dashboard/src/components/ProposalCitations.tsx";
const EVIDENCE = "/dashboard/src/components/ProposalEvidence.tsx";
const SUMMARY_LOGIC = "/dashboard/src/proposalSummary.ts";

/**
 * Every page that renders a proposal. None may grow its own renderer.
 *
 * ⚠ `pages/ProposalRecord.tsx` JOINED THIS LIST when the proposal history view was
 * built, and it is the reason the list is worth having: a history page that rendered
 * a stored proposal its own way would be a second proposal renderer, and *"the copy
 * that drifts is the one nobody is watching"* (decision log 46). It renders a
 * historical `derive` record through the unchanged `ProposalView` — same card, same
 * banner, same citation classification, same evidence tables — because the stored
 * payload rebuilds into the exact wire shape that component already takes.
 */
const PAGES = [
  "/dashboard/src/pages/Proposal.tsx",
  "/dashboard/src/pages/ProposalRun.tsx",
  "/dashboard/src/pages/ProposalRecord.tsx",
];

function raw(path: string): string {
  const module = SOURCES[path];
  expect(module, `${path} is not in the scanned source set`).toBeDefined();
  return module!.default;
}

/** Source lines only: prose about the rule is not a violation of it. */
function code(path: string): string {
  return raw(path)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => !line.startsWith("//") && !line.startsWith("*") && !line.startsWith("/*"))
    .join("\n");
}

/** Every `<details` opening tag in a file, with the rest of that tag. */
function detailsTags(source: string): string[] {
  return [...source.matchAll(/<details\b[^>]*>/g)].map((match) => match[0]);
}

describe("the summary card is rendered, and rendered first", () => {
  it("found the sources to check", () => {
    // Without this every assertion below passes vacuously, which is the one way a
    // source-scan guard rots with nobody noticing.
    const paths = Object.keys(SOURCES);
    expect(paths.length).toBeGreaterThan(20);
    for (const path of [VIEW, CARD, LINK, CITATIONS, EVIDENCE, SUMMARY_LOGIC, ...PAGES]) {
      expect(paths).toContain(path);
    }
  });

  it("`ProposalView` renders the card, exactly once", () => {
    const source = code(VIEW);
    expect(source).toContain("<ProposalSummaryCard");
    expect(source.match(/<ProposalSummaryCard\b/g)).toHaveLength(1);
  });

  it("⚠ the card is rendered BEFORE every other panel", () => {
    /*
     * THE POSITION ASSERTION. The card's entire purpose is that a reviewer sees it
     * without scrolling, and JSX child order is render order.
     *
     * This is checked against EVERY panel rather than only the concentration
     * banner, because a later edit that inserts a new section above the card would
     * be exactly as damaging and would not touch any line this file otherwise
     * names.
     */
    const source = code(VIEW);
    const card = source.indexOf("<ProposalSummaryCard");
    expect(card).toBeGreaterThan(-1);

    for (const panel of [
      "<ProposalConcentration",
      "<ProposalLimits",
      "<ProposalFreshness",
      "<CitationLegend",
      "<ProposalStrategy",
      "<ProposalParameters",
      "<ProposalEvidence",
    ]) {
      const at = source.indexOf(panel);
      expect(at, `${panel} is not rendered by ProposalView at all`).toBeGreaterThan(-1);
      expect(at, `${panel} renders ABOVE the summary card`).toBeGreaterThan(card);
    }
  });

  it("⚠ the panels the card summarises are all still rendered, in full", () => {
    /*
     * THE "ADDITIVE, NOT A REPLACEMENT" ASSERTION, and the one most likely to be
     * violated by a well-meaning future edit. A card at the top makes the panels
     * below it look redundant; they are not. The concentration banner carries
     * every finding with its rule, threshold and observed breakdown, and the
     * freshness table carries four separately-ranked timestamps — neither of which
     * a two-word badge can replace.
     */
    const source = code(VIEW);
    for (const panel of [
      "<ProposalConcentration",
      "<ProposalLimits",
      "<ProposalFreshness",
      "<ProposalStrategy",
      "<ProposalParameters",
      "<ProposalEvidence",
    ]) {
      expect(source, `${panel} was removed from the proposal`).toContain(panel);
    }
  });

  it("both proposal pages render through the one `ProposalView`", () => {
    // Decision log 46: *"a trigger that rendered its results its own way would be a
    // second proposal renderer, and the copy that drifts is the one nobody is
    // watching."* The card lands on both pages only because there is one renderer.
    for (const page of PAGES) {
      expect(code(page), `${page} does not render through ProposalView`).toContain(
        "<ProposalView",
      );
    }
  });

  it("⚠ neither page renders the card or the link itself", () => {
    // A page that mounted its own copy would put a second create-bot control on
    // screen, and the two would drift.
    for (const page of PAGES) {
      const source = code(page);
      expect(source).not.toContain("<ProposalSummaryCard");
      expect(source).not.toContain("<ProposalCreateBotLink");
    }
  });
});

describe("the relocated create-bot link is the same link", () => {
  it("⚠ the history view suppresses the link rather than growing a second one", () => {
    /*
     * THE HISTORY VIEW'S ONE DEVIATION FROM A LIVE PROPOSAL'S RENDERING, pinned so
     * it stays a suppression rather than becoming a fork.
     *
     * A historical record is a thing that already happened. The path from a proposal
     * to a bot exists ONCE, through a live proposal, built to decision log 46's four
     * constraints — and a second entry point from a history page would be a second
     * place the copy that stops a human mistaking a prefill for an approval lives
     * and drifts. So the record page passes `offerCreateBot={false}` to the SAME
     * `ProposalView`, rather than rendering a variant of it.
     *
     * ⚠ IT SUPPRESSES AN AFFORDANCE, NOT A GUARANTEE, and the two assertions below
     * are the mechanical statement of that: the flag is passed exactly where it is
     * expected, and it is the ONLY place in the dashboard that passes it — every
     * other render of a proposal still offers the link.
     */
    const record = code("/dashboard/src/pages/ProposalRecord.tsx");
    expect(record).toContain("offerCreateBot={false}");

    const suppressors: string[] = [];
    for (const [path, module] of Object.entries(SOURCES)) {
      if (path.endsWith(".test.ts") || path.endsWith(".test.tsx")) continue;
      if (/offerCreateBot=\{false\}/.test(module.default)) suppressors.push(path);
    }
    expect(suppressors).toEqual(["/dashboard/src/pages/ProposalRecord.tsx"]);

    // And the live pages do NOT pass it, so they keep the link by default rather
    // than by a flag someone has to remember.
    for (const page of ["/dashboard/src/pages/Proposal.tsx", "/dashboard/src/pages/ProposalRun.tsx"]) {
      expect(code(page)).not.toContain("offerCreateBot");
    }
  });

  it("⚠ is rendered in exactly ONE place in the whole dashboard, and that place is the card", () => {
    /*
     * THE RELOCATION REGRESSION. The failure this catches is not hypothetical: the
     * obvious way to "add the button to the card" is to add it to the card and
     * forget the footer, leaving two controls whose copy drifts apart — and the
     * copy on this one is decision log 46's fourth constraint, the text that stops
     * a human mistaking a prefill for an approval.
     */
    const renders: string[] = [];
    for (const [path, module] of Object.entries(SOURCES)) {
      if (path === LINK) continue; // its own definition, not a render of it.
      if (/<ProposalCreateBotLink\b/.test(module.default)) renders.push(path);
    }
    expect(renders, renders.join("\n")).toEqual([CARD]);
  });

  it("⚠ `ProposalView` no longer renders it", () => {
    // The other half of the move, stated positively so a re-added footer copy
    // fails here rather than being noticed by eye.
    expect(code(VIEW)).not.toContain("<ProposalCreateBotLink");
  });

  it("⚠ the link component itself is UNCHANGED in what it does", () => {
    /*
     * The step's own claim, mechanised: this was a position change and nothing
     * else. The three properties decision log 48 built and that a relocation could
     * plausibly have disturbed:
     *
     *   1. the href comes from `createBotHref(derive)` — the pre-fill mechanism,
     *   2. it is an `<a>` (react-router `Link`) with no `onClick` — navigation only,
     *   3. it still refuses to offer a link it cannot build honestly.
     */
    const source = code(LINK);
    expect(source).toContain("createBotHref(derive)");
    expect(source).toContain("<Link");
    expect(source).not.toMatch(/\bonClick\b/);
    expect(source).toContain("href === null");
  });

  it("⚠ the card passes the whole response through, inventing no prefill of its own", () => {
    // `<ProposalCreateBotLink derive={derive} />` and nothing else. A card that
    // built its own href would be a second encoder of the URL contract decision
    // log 48's 21 mutants were aimed at.
    expect(code(CARD)).toMatch(/<ProposalCreateBotLink\s+derive=\{derive\}\s*\/>/);
    expect(code(CARD)).not.toContain("createBotHref");
    expect(code(CARD)).not.toContain("prefillSearchParams");
  });
});

describe("the collapsible sections default to collapsed", () => {
  it("⚠ every `<details>` in the dashboard ships without an `open` attribute", () => {
    /*
     * "DEFAULTS TO COLLAPSED", checked the only way this repository can check it.
     * `open` is the entire mechanism — a `<details open>` renders expanded — so
     * its absence across every tag is the property.
     *
     * Scanned dashboard-wide rather than in the two files this step touched,
     * because the rule is about the page a reviewer sees, not about which commit
     * added the tag.
     */
    const offenders: string[] = [];
    for (const [path, module] of Object.entries(SOURCES)) {
      for (const tag of detailsTags(module.default)) {
        if (/\bopen\b/.test(tag)) offenders.push(`${path}: ${tag}`);
      }
    }
    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  it("the per-claim citation rows are inside a `<details>`", () => {
    const source = code(CITATIONS);
    const details = source.indexOf("<details");
    const rows = source.indexOf("<CitationRow");
    expect(details).toBeGreaterThan(-1);
    expect(rows).toBeGreaterThan(details);
    expect(source.indexOf("</details>")).toBeGreaterThan(rows);
  });

  it("⚠ the `rests on no fetched data` warning is OUTSIDE the `<details>`, never collapsed", () => {
    /*
     * THE ONE THING IN THE CITATION BLOCK THAT MUST STAY VISIBLE.
     *
     * Decision log 44's live check 4: on the first real proposal this layer ever
     * rendered, three parameters at once rested on `assessment.strategy` alone,
     * and the operator identified all three IMMEDIATELY from this field-level
     * line — which is the observation entry 44 offers as evidence that entry 43's
     * "hard to verify in practice" reopening condition was NOT met.
     *
     * Behind a closed toggle it would create that condition exactly, and every
     * other test in this repository would still pass.
     */
    const source = code(CITATIONS);
    const warning = source.indexOf("restsOnNoFetchedData(citations)");
    const details = source.indexOf("<details");
    expect(warning).toBeGreaterThan(-1);
    expect(details).toBeGreaterThan(-1);
    expect(warning, "the no-fetched-data warning is inside the collapsed block").toBeLessThan(
      details,
    );
  });

  it("⚠ the offered/cited counts are OUTSIDE the `<details>`, never collapsed", () => {
    /*
     * THE RECONCILIATION WITH DECISION LOG 44, mechanised.
     *
     * That entry refused to put this table behind a toggle, and its argument is
     * about the DIFFERENCE — *"what the model ignored is visible only from the
     * difference between the two... that difference is only visible if something
     * computes it"* — which live read 31 of 75 and 9 of 56. The difference is
     * computed and printed above the toggle; the per-row lookup surface collapses.
     * Sweeping the counts inside would undo entry 44's requirement while looking
     * like a tidy-up.
     */
    const source = code(EVIDENCE);
    const counts = source.indexOf("item(s) offered");
    const details = source.indexOf("<details");
    expect(counts).toBeGreaterThan(-1);
    expect(details).toBeGreaterThan(-1);
    expect(counts, "the offered/cited counts are inside the collapsed block").toBeLessThan(details);
  });

  it("⚠ the panels most reviewers read are NOT collapsed", () => {
    /*
     * The other half of the brief, and the half a "collapse the long page" edit
     * would overshoot on. Only the dense raw-data surfaces collapse. The
     * concentration banner, the data-limits panel, the strategy and the parameters
     * carry no `<details>` at all — a reader scrolling past them must not be able
     * to miss them because they were closed.
     */
    for (const path of [
      "/dashboard/src/components/ProposalConcentration.tsx",
      "/dashboard/src/components/ProposalLimits.tsx",
      "/dashboard/src/components/ProposalStrategy.tsx",
      "/dashboard/src/components/ProposalParameters.tsx",
      "/dashboard/src/components/ProposalSummaryCard.tsx",
    ]) {
      expect(detailsTags(raw(path)), `${path} collapses a section it should not`).toEqual([]);
    }
  });
});

describe("the card makes no decision of its own", () => {
  it("⚠ decides no verdict in the `.tsx`", () => {
    /*
     * `proposalFields.ts` was extracted after a mutation run proved that a decision
     * living in a `.tsx` is reachable by NO test in this repository. The same rule
     * applies here and is enforced rather than trusted: the card may not contain a
     * verdict string, a threshold, or a comparison that produces one. It reads
     * `summarize()` and maps over the result.
     */
    const source = code(CARD);
    for (const forbidden of [
      /"flagged"/,
      /"clean"/,
      /"no_concentration"/,
      /"stale"/,
      /"fresh"/,
      /\bassessment\b/,
      /thresholdMs/,
      /DEFAULT_STALENESS_POLICY/,
    ]) {
      expect(source, `the card decides a verdict itself: ${forbidden}`).not.toMatch(forbidden);
    }
  });

  it("⚠ the logic module applies no threshold and counts no bots", () => {
    /*
     * The same rule on the other side. `concentrationVerdictOf` must READ the
     * backend's `assessment` field, never recompute it — a second implementation
     * of `src/research/concentration.ts`'s policy would drift, and the copy that
     * drifts is the one nobody is watching.
     */
    const source = code(SUMMARY_LOGIC);
    for (const forbidden of [/samePairBots/, /committedBots/, /capitalShare/, /\bflags\b/]) {
      expect(source, `the summary module recomputes concentration: ${forbidden}`).not.toMatch(
        forbidden,
      );
    }
    // And the staleness side composes the backend's own function rather than
    // comparing ages itself.
    expect(source).toContain("stalenessFor(freshnessOf(derive), now)");
  });
});
