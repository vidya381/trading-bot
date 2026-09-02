/**
 * ⚠ NO STRATEGY SEAM IN THE PROPOSAL PATH MAY DECIDE BY FALLING THROUGH TO
 * ANOTHER STRATEGY.
 *
 * ── THE DEFECT ──
 *
 * `validatedProposalView` rendered a proposal's parameters with
 *
 *     params.strategy === "grid" ? { ...grid fields } : { ...nine DCA fields }
 *
 * That `:` was not a default case. It was an unstated claim that every non-grid
 * proposal is a DCA proposal, and it had been false since 22.4 touchpoint 8 gave
 * `ValidatedProposal["params"]` a third arm -- `decodeWithRealDecoder` decodes a
 * trailing-stop proposal and `validatorNamesFor` validates one, so the value
 * reaching this function really could be `{ trailPct }`.
 *
 * It is the identical bug class to the one that took the bot detail page to a
 * blank screen for `bot-ts1`, in the identical shape, one layer down. The RUNTIME
 * FAILURE IS DIFFERENT AND WORSE IN ONE RESPECT, which is why it is stated here
 * rather than assumed to match: `money(undefined)` is `toDecimalString(undefined)`,
 * which throws `TypeError: Cannot mix BigInt and other types, use explicit
 * conversions` inside the Worker. That happens in `deriveProposalReasoningView`,
 * BEFORE `logDeriveProposal` writes the row -- so `POST /api/proposals/run` would
 * answer 500 with two paid inferences already spent and no permanent record
 * written. Nothing renders blank because no response is ever built.
 *
 * ── WHY A SOURCE SCAN, WHEN THE COMPILER ALREADY CATCHES THIS ──
 *
 * It does, and that is the primary guard: `proposalParamsView` has an annotated
 * return type and an exhaustive `switch`, so a fourth strategy is a TS2366 at that
 * function. This test is the second layer, and it checks the thing the compiler
 * cannot: that the seam is still SHAPED as an exhaustive switch. An edit that
 * "fixes" a future compile error by restoring a ternary, or by adding a `default`
 * that silently reuses another strategy's arm, type-checks perfectly -- and is
 * exactly the edit that produced this bug. This is the same pattern
 * `dashboard/src/components/strategy-view-coverage.test.ts` uses for tonight's
 * dashboard fix, for decision log 45's reason: a guard whose call site nothing can
 * check is most of the way to no guard.
 *
 * ⚠ ITS LIMIT: a source scan checks text, not behaviour. What proves the arms are
 * CORRECT is the value-level section at the bottom, which drives the real view
 * over a real trailing-stop `DeriveResult` and hands the output to the real shape
 * check.
 */

import { describe, expect, it } from "vitest";

import type { StrategyType } from "../db/schema";
import { validatedProposalView } from "./serialize";
import { checkParamsShape, proposalFieldsFor } from "../research/proposal-shape";
import type { DeriveResult } from "../research";
import { fromDecimalString as m } from "../shared/money";

// `import.meta.glob` is a Vite feature, declared here rather than by adding
// "vite/client" to tsconfig's `types` -- which would pull the DOM lib into scope
// while typechecking Worker source. Mirrors `grid-ladder-config.test.ts` and
// `strategy-view-coverage.test.ts`.
declare global {
  interface ImportMeta {
    glob(pattern: string, options: { query: string; eager: true }): Record<string, unknown>;
  }
}

const SOURCES = import.meta.glob("/src/**/*.ts", {
  query: "?raw",
  eager: true,
}) as Record<string, { default: string }>;

const SERIALIZE = "/src/api/serialize.ts";
const SCHEMA = "/src/db/schema.ts";
const PROPOSAL_SHAPE = "/src/research/proposal-shape.ts";

function raw(path: string): string {
  const module = SOURCES[path];
  expect(module, `${path} is not in the scanned source set`).toBeDefined();
  return module!.default;
}

/**
 * Source lines only: prose ABOUT the rule is not an instance of it. Load-bearing
 * here -- `serialize.ts` quotes the old ternary verbatim in a comment to explain
 * why it changed, and a naive substring search would read that explanation as the
 * defect still being present.
 */
function code(path: string): string {
  return raw(path)
    .split("\n")
    .filter((line) => {
      const trimmed = line.trim();
      return (
        !trimmed.startsWith("//") && !trimmed.startsWith("*") && !trimmed.startsWith("/*")
      );
    })
    .join("\n");
}

/**
 * ⚠ INDENTATION IS PRESERVED ABOVE, unlike the dashboard's version of this
 * helper, and the difference is load-bearing rather than stylistic:
 * `functionBody` finds a function's end by looking for a closing brace in COLUMN
 * ZERO. Trimming every line first put every nested `};` in column zero too, so
 * the first `return { ... };` inside the switch ended the "body" and the scan
 * silently checked a fragment. It failed loudly here only because the first arm
 * happens to be `grid`; a reordering would have made it pass while checking
 * almost nothing.
 */

/** Every strategy named in `StrategyType`, read out of the schema rather than typed here. */
function declaredStrategies(): readonly string[] {
  const source = code(SCHEMA);
  const at = source.indexOf("export type StrategyType =");
  expect(at, "no `StrategyType` union in db/schema.ts").toBeGreaterThan(-1);
  const line = source.slice(at, source.indexOf(";", at));
  const names = [...line.matchAll(/"([a-z_]+)"/g)].map((match) => match[1]!);
  expect(names.length, "the StrategyType union parsed to nothing").toBeGreaterThan(1);
  return names;
}

/** The body of one function, from its declaration to the next top-level `}`. */
function functionBody(path: string, declaration: string): string {
  const source = code(path);
  const at = source.indexOf(declaration);
  expect(at, `no ${JSON.stringify(declaration)} in ${path}`).toBeGreaterThan(-1);
  // Column zero, so a nested closing brace inside the function is not mistaken
  // for the end of it. See the note on `code`.
  const end = source.indexOf("\n}", at);
  expect(end, `${declaration} has no closing brace`).toBeGreaterThan(at);
  return source.slice(at, end);
}

describe("the proposal parameter seam cannot silently drop a strategy", () => {
  it("found the sources to check", () => {
    // Without this every assertion below passes vacuously, which is the one way a
    // source-scan guard rots with nobody noticing.
    const paths = Object.keys(SOURCES);
    expect(paths.length).toBeGreaterThan(50);
    for (const path of [SERIALIZE, SCHEMA, PROPOSAL_SHAPE]) {
      expect(paths).toContain(path);
    }
  });

  it("the comment-stripper really does strip prose, so the assertions below mean something", () => {
    // The guard on the guard. `serialize.ts` deliberately quotes the old ternary
    // and its failure in comments; if `code()` stopped filtering them, the
    // assertions below would read that explanation as the defect itself.
    expect(raw(SERIALIZE)).toContain("A TERNARY THAT LIED");
    expect(code(SERIALIZE)).not.toContain("A TERNARY THAT LIED");
  });

  it("⚠ `proposalParamsView` has an explicit arm for EVERY declared strategy", () => {
    // THE ASSERTION THAT FAILS WHEN A FOURTH STRATEGY IS ADDED, in the renderer
    // rather than only in the type.
    const body = functionBody(SERIALIZE, "function proposalParamsView(");
    for (const strategy of declaredStrategies()) {
      expect(body, `proposalParamsView has no arm for "${strategy}"`).toContain(
        `case "${strategy}"`,
      );
    }
  });

  it("⚠ `proposalParamsView` is a switch with no default, not a ternary", () => {
    /*
     * The SHAPE, which is what the compiler cannot check. An exhaustive switch
     * with no `default` is what makes a missing strategy a TS2366; a ternary or a
     * `default` arm restores the silent misroute while still compiling.
     */
    const body = functionBody(SERIALIZE, "function proposalParamsView(");
    expect(body).toContain("switch (params.strategy)");
    expect(body, "a `default` arm would silently absorb an unhandled strategy").not.toContain(
      "default:",
    );
    expect(body, "the ternary fall-through is back").not.toContain('params.strategy === "grid"');
  });

  it("⚠ `proposalFieldsFor` has an arm for every strategy, and no default", () => {
    // The consumer of the shape above: if the view can emit a strategy the shape
    // check does not know, a VALID proposal is refused with a red "do not act on
    // this" banner -- a false alarm on real data.
    const body = functionBody(PROPOSAL_SHAPE, "export function proposalFieldsFor(");
    for (const strategy of declaredStrategies()) {
      expect(body, `proposalFieldsFor has no arm for "${strategy}"`).toContain(
        `case "${strategy}"`,
      );
    }
    expect(body).not.toContain("default:");
  });

  it("the two-strategy `other` assumption is gone from the shape check", () => {
    // A third instance of the same bug class lived inside the module written to
    // catch it: `const other = claimed === "grid" ? "dca" : "grid"`.
    expect(code(PROPOSAL_SHAPE)).not.toContain('claimed === "grid" ? "dca" : "grid"');
  });
});

// ---------------------------------------------------------------------------
// The value-level half: the arms are not merely present, they are right.
// ---------------------------------------------------------------------------

/** A real `DeriveResult` carrying trailing-stop params -- the object that threw. */
function trailingStopResult(): DeriveResult {
  const evidence = {
    id: "candles.last_close",
    label: "Last close",
    value: "101.00000000",
    source: "candles.value.candles",
  } as const;
  const strategy: StrategyType = "trailing_stop";

  return {
    strategy,
    proposal: {
      strategy,
      params: { strategy: "trailing_stop", value: { trailPct: m("10") } },
      allocatedCapital: m("400"),
      capitalAsset: "USD",
      availableAtProposal: m("10000"),
      minimumOrderCheck: "quantity",
      referencePrice: m("101"),
    },
    citations: {
      strategy,
      parameters: Object.fromEntries(
        proposalFieldsFor("trailing_stop").map((field) => [
          field,
          { value: "10", citations: [evidence] },
        ]),
      ),
      allocatedCapital: { value: "400", citations: [evidence] },
      capitalAsset: { value: "USD", citations: [evidence] },
      notes: [{ statement: "note", citations: [evidence] }],
      envelope: "envelope_object",
      duplicateKeyCheck: "unavailable_transport_parsed",
    },
    notes: [{ statement: "note", citations: [evidence] }],
    envelope: "envelope_object",
    duplicateKeyCheck: "unavailable_transport_parsed",
    minimumOrderCheck: "quantity",
    promptVersion: "derive/1",
    promptText: "PROMPT",
    evidence: [evidence],
    model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    settings: {
      temperature: 0,
      seed: 20_260_811,
      maxTokens: 4_096,
      responseFormat: { type: "json_schema", json_schema: {} },
    },
    response: { text: "{}", raw: {} },
    assessment: {
      strategy,
      claims: [{ statement: "c", citations: [evidence] }],
      envelope: "envelope_object",
      duplicateKeyCheck: "performed",
    },
    // `validatedProposalView` reads nothing off `context`; the same stated
    // shortcut `proposal-shape.test.ts`'s fixture takes, for the same reason.
    context: {} as DeriveResult["context"],
  };
}

describe("a trailing-stop proposal renders instead of throwing", () => {
  it("⚠ does not throw -- the exact call that answered 500 before", () => {
    // `money(undefined)` threw `TypeError: Cannot mix BigInt and other types`.
    expect(() => validatedProposalView(trailingStopResult())).not.toThrow();
  });

  it("emits the strategy's own single field, and no DCA field at all", () => {
    const view = validatedProposalView(trailingStopResult());
    expect(view.params).toEqual({ strategy: "trailing_stop", trailPct: "10.00000000" });
    // The nine fields the `else` branch used to read off this object. Named
    // individually rather than by a key count, because the failure was reading
    // them -- not emitting the wrong number of keys.
    for (const field of ["baseOrderSize", "additionalOrderSize", "stepMultiplier", "dropPct"]) {
      expect(view.params).not.toHaveProperty(field);
    }
  });

  it("and the real view's output PASSES the real shape check", () => {
    /*
     * The end-to-end statement, and the one that would have caught a half-fix:
     * teaching the view to emit a trailing-stop shape while leaving
     * `PROPOSAL_STRATEGIES` at two members would put a red "this params object
     * does not match its claimed strategy" banner over a perfectly valid
     * proposal. A guard that refuses genuine data is worse than the crash.
     */
    const check = checkParamsShape(validatedProposalView(trailingStopResult()).params);
    expect(check.ok, "the real trailing-stop view was refused by the shape check").toBe(true);
  });
});
