/**
 * The params shape check (`proposal-shape.ts`), and the crash it exists for.
 *
 * ── THE TEST THAT MATTERS MOST IS THE FIRST ONE ──
 *
 * "⚠ THE EXACT INPUT THAT CRASHED THE REAL PAGE" reproduces the operator's
 * hand-edited file byte for byte in shape: `strategy: "dca"` over grid-shaped
 * params. Before this module that reached `formatMoney(undefined)` and threw
 * `TypeError: undefined is not an object (evaluating 'value.startsWith')` out of
 * `roundDecimal`, unmounting the tree and blanking the page.
 *
 * ── ⚠ WHAT THESE TESTS DO AND DO NOT COVER, STATED RATHER THAN IMPLIED ──
 *
 * They cover the DECISION LOGIC completely: every refusal code, the exact
 * crash-causing input, well-formed grid, well-formed DCA, and the `undefined`
 * -versus-`null` distinction that the whole fix turns on.
 *
 * They do NOT render `ProposalParameters`. The dashboard has no test runner of its
 * own, the root suite runs inside the Workers runtime, and `react-dom/server` does
 * not resolve there -- both `server.edge` and `server.browser` fail on their CJS
 * requires, VERIFIED BY PROBE rather than assumed. So the JSX that consumes these
 * results, and `ErrorBoundary`'s catching, are verified by the operator's eyes and
 * by nothing else, exactly as decision log 44 records for all eight proposal
 * components. That is why every decision the component makes was moved OUT of the
 * component and into this pure function.
 */

import { describe, expect, it } from "vitest";
import type { StrategyType } from "../db/schema";
import { validatedProposalView } from "../api/serialize";
import { fromDecimalString as m } from "../shared/money";
import { DCA_DERIVE_FIELDS, GRID_DERIVE_FIELDS } from "./derive-prompt";
import type { DeriveResult } from "./derive";
import {
  DCA_PROPOSAL_FIELDS,
  GRID_PROPOSAL_FIELDS,
  PROPOSAL_STRATEGIES,
  checkParamsShape,
  isProposalStrategy,
  proposalFieldsFor,
  type ProposalStrategy,
} from "./proposal-shape";

/**
 * ⚠ THE TWO-WAY TYPE PIN the module header promises.
 *
 * `proposal-shape.ts` imports nothing, so it cannot use `StrategyType` -- that
 * import would pull the Worker's D1 types into the dashboard's `tsc -b` and break
 * it. These assignments make the two unions a COMPILE ERROR to diverge in either
 * direction.
 */
const _strategiesAgree: ProposalStrategy = null as unknown as StrategyType;
const _strategiesAgreeBack: StrategyType = null as unknown as ProposalStrategy;
void _strategiesAgree;
void _strategiesAgreeBack;

/** A well-formed grid params object, exactly as `validatedProposalView` emits one. */
const GRID_PARAMS = {
  strategy: "grid",
  upperBound: "108.00000000",
  lowerBound: "96.00000000",
  gridLines: 5,
  spacing: "arithmetic",
  orderSize: "50.00000000",
  stopLossPct: "5.00000000",
  breakoutTakeProfit: true,
  // ⚠ BOTH NULLABLE FIELDS SET TO null, which is the state a real response
  // produces for an unset optional and which MUST count as present.
  breakoutThresholdPct: null,
  takeProfitAmount: null,
} as const;

/**
 * A well-formed DCA params object, built from `DCA_PROPOSAL_FIELDS` upward.
 *
 * ⚠ CONSTRUCTED WITH THE RIGHT DCA FIELDS, NOT EDITED FROM A GRID ONE. This is a
 * fixture for the SHAPE CHECK and nothing else: it is not, and must not be
 * presented as, verification of the DCA rendering path. Every live derivation this
 * project has produced has been grid (decision logs 41, 42, 44), and closing that
 * gap needs a real Derive call that happens to answer dca -- not a hand-built
 * object. Tracked separately; see decision log 44's assumption 1.
 */
const DCA_PARAMS = {
  strategy: "dca",
  baseOrderSize: "100.00000000",
  additionalOrderSize: "100.00000000",
  stepMultiplier: "1.50000000",
  dropPct: "5.00000000",
  maxAdditionalBuys: 2,
  takeProfitPct: "2.00000000",
  stopLossPct: "20.00000000",
  autoRestart: false,
  sellOnStopLoss: false,
} as const;

/**
 * A real `DeriveResult` for one strategy, enough for `validatedProposalView`.
 *
 * ⚠ THIS IS NOT DCA VERIFICATION. It exists so the field lists can be pinned to the
 * REAL view's real output. Every live derivation this project has produced has been
 * grid (decision logs 41, 42, 44), and closing that gap needs an actual Derive call
 * that answers dca -- not a fixture. Tracked separately.
 */
function deriveResultFor(strategy: ProposalStrategy): DeriveResult {
  const params =
    strategy === "grid"
      ? {
          strategy: "grid" as const,
          value: {
            upperBound: m("108"),
            lowerBound: m("96"),
            gridLines: 5,
            spacing: "arithmetic" as const,
            orderSize: m("50"),
            stopLossPct: m("5"),
            breakoutTakeProfit: true,
            breakoutThresholdPct: null,
            takeProfitAmount: null,
          },
        }
      : {
          strategy: "dca" as const,
          value: {
            baseOrderSize: m("100"),
            additionalOrderSize: m("100"),
            stepMultiplier: m("1.5"),
            dropPct: m("5"),
            maxAdditionalBuys: 2,
            takeProfitPct: m("2"),
            stopLossPct: m("20"),
            autoRestart: false,
            sellOnStopLoss: false,
          },
        };

  const evidence = {
    id: "candles.last_close",
    label: "Last close",
    value: "101.00000000",
    source: "candles.value.candles",
  } as const;

  return {
    strategy,
    proposal: {
      // Every field `ValidatedProposal` declares, including the two the view reads
      // off the proposal rather than off the result -- filled properly rather than
      // cast away, so this fixture is a real one.
      strategy,
      params,
      allocatedCapital: m("400"),
      capitalAsset: "USD",
      availableAtProposal: m("10000"),
      minimumOrderCheck: "quantity",
      referencePrice: m("101"),
    },
    citations: {
      // A complete `ParsedProposal`, not a partial one -- all seven fields.
      strategy,
      parameters: Object.fromEntries(
        proposalFieldsFor(strategy).map((field) => [field, { value: "x", citations: [evidence] }]),
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
    // The one shortcut in this fixture, and stated rather than hidden:
    // `validatedProposalView` reads nothing off `context`, so building a whole
    // Stage 1 bundle plus two Stage 3 reads here would add no coverage. Every field
    // the view DOES read is real above -- there is no outer cast on the return.
    context: {} as DeriveResult["context"],
  };
}

// ---------------------------------------------------------------------------
// THE CRASH
// ---------------------------------------------------------------------------

describe("⚠ the exact input that crashed the real page", () => {
  /**
   * The operator's file: a `dca` label over grid-shaped params. An inconsistency a
   * real backend response can never produce -- the model is sent a per-strategy
   * JSON schema, `requireExactFields` refuses any field missing or extra, and
   * `validatedProposalView` builds from a discriminated union -- reached by a
   * hand edit.
   */
  const CRASHER = { ...GRID_PARAMS, strategy: "dca" };

  it("is REFUSED rather than rendered, with the right code", () => {
    const check = checkParamsShape(CRASHER);
    expect(check.ok).toBe(false);
    if (check.ok) throw new Error("unreachable");
    expect(check.code).toBe("fields_do_not_match_strategy");
  });

  it("names every missing DCA field, so the edit is visible from the warning alone", () => {
    const check = checkParamsShape(CRASHER);
    if (check.ok) throw new Error("expected a refusal");
    // EIGHT, not nine, and the arithmetic is worth stating: `stopLossPct` is the
    // one field BOTH strategies require (the intersection pinned below), so a grid
    // object labelled dca is missing the other eight and not all nine. Asserting
    // "nine" was this test's own first mistake.
    expect([...check.missing].sort()).toEqual(
      [...DCA_PROPOSAL_FIELDS].filter((field) => field !== "stopLossPct").sort(),
    );
    expect(check.missing).toHaveLength(8);
    expect(check.missing).not.toContain("stopLossPct");
    expect(check.claimedStrategy).toBe("dca");
  });

  it("also names the grid fields it carries that a DCA proposal does not have", () => {
    // Both halves of the mismatch, because `requireExactFields` treats extra as a
    // fault too and because the grid keys are the evidence for `looksLike: "grid"`.
    const check = checkParamsShape(CRASHER);
    if (check.ok) throw new Error("expected a refusal");
    expect([...check.unexpected].sort()).toEqual(
      [...GRID_PROPOSAL_FIELDS].filter((field) => field !== "stopLossPct").sort(),
    );
  });

  it("⚠ DIAGNOSES it as grid-shaped-but-labelled-dca, which is the useful answer", () => {
    // "9 fields are missing" is true and sends a reader to diff two documents by
    // hand. `looksLike` points straight at the edit that caused it.
    const check = checkParamsShape(CRASHER);
    if (check.ok) throw new Error("expected a refusal");
    expect(check.looksLike).toBe("grid");
    expect(check.message).toContain("grid-shaped but labelled dca");
    // And it says what to do, in the same terms the strategy-disagreement banner
    // uses: this document is not actionable.
    expect(check.message).toContain("Do not act on it");
  });

  it("⚠ and the MIRROR case is refused the same way: a grid label over DCA params", () => {
    const check = checkParamsShape({ ...DCA_PARAMS, strategy: "grid" });
    if (check.ok) throw new Error("expected a refusal");
    expect(check.code).toBe("fields_do_not_match_strategy");
    expect(check.looksLike).toBe("dca");
    expect(check.message).toContain("dca-shaped but labelled grid");
    expect([...check.missing].sort()).toEqual(
      [...GRID_PROPOSAL_FIELDS].filter((field) => field !== "stopLossPct").sort(),
    );
  });
});

// ---------------------------------------------------------------------------
// WELL-FORMED INPUT STILL RENDERS
// ---------------------------------------------------------------------------

describe("a genuinely well-formed proposal passes", () => {
  it("accepts a well-formed GRID params object and narrows the strategy", () => {
    const check = checkParamsShape(GRID_PARAMS);
    expect(check.ok).toBe(true);
    if (!check.ok) throw new Error(`unexpectedly refused: ${check.message}`);
    // The narrowed value is what the component dispatches on, so it is the thing
    // worth asserting rather than merely `ok`.
    expect(check.strategy).toBe("grid");
  });

  it("accepts a well-formed DCA params object (built from the DCA field list, not edited)", () => {
    const check = checkParamsShape(DCA_PARAMS);
    expect(check.ok).toBe(true);
    if (!check.ok) throw new Error(`unexpectedly refused: ${check.message}`);
    expect(check.strategy).toBe("dca");
  });

  it("⚠ accepts null in both nullable GRID fields, which is what a real response sends", () => {
    // THE DISTINCTION THE WHOLE FIX TURNS ON. `takeProfitAmount: null` is an unset
    // optional and is PRESENT; `takeProfitAmount: undefined` is missing and is the
    // value that crashed `roundDecimal`. A rule that accepted "absent or null"
    // would let the original crash straight through.
    expect(checkParamsShape({ ...GRID_PARAMS, takeProfitAmount: null }).ok).toBe(true);
    expect(checkParamsShape({ ...GRID_PARAMS, breakoutThresholdPct: null }).ok).toBe(true);

    const withUndefined = checkParamsShape({ ...GRID_PARAMS, takeProfitAmount: undefined });
    expect(withUndefined.ok).toBe(false);
    if (withUndefined.ok) throw new Error("unreachable");
    expect(withUndefined.missing).toEqual(["takeProfitAmount"]);
  });

  it("accepts falsy-but-present values without mistaking them for absent", () => {
    // 0, "", and false are all legitimate and all falsy. A presence check written
    // as `if (!params[field])` would refuse every one of them.
    expect(
      checkParamsShape({
        ...DCA_PARAMS,
        maxAdditionalBuys: 0,
        autoRestart: false,
        sellOnStopLoss: false,
        dropPct: "0.00000000",
      }).ok,
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// EVERY OTHER MALFORMED SHAPE
// ---------------------------------------------------------------------------

describe("the other ways a pasted params object can be wrong", () => {
  it("refuses a params that is not an object at all", () => {
    for (const value of [null, undefined, "grid", 42, true, []]) {
      const check = checkParamsShape(value);
      expect(check.ok, `${JSON.stringify(value ?? null)} was accepted`).toBe(false);
      if (check.ok) throw new Error("unreachable");
      expect(check.code).toBe("params_not_an_object");
    }
  });

  it("refuses an ARRAY specifically, which typeof calls an object", () => {
    // Named on its own because `typeof [] === "object"` is the classic hole here,
    // and an array's numeric keys would make every field read `undefined`.
    const check = checkParamsShape([]);
    if (check.ok) throw new Error("expected a refusal");
    expect(check.code).toBe("params_not_an_object");
    expect(check.message).toContain("an array");
  });

  it("refuses a strategy label that is not one of the two", () => {
    for (const label of ["martingale", "GRID", "", null, 7, {}]) {
      const check = checkParamsShape({ ...GRID_PARAMS, strategy: label });
      expect(check.ok, `${JSON.stringify(label)} was accepted as a strategy`).toBe(false);
      if (check.ok) throw new Error("unreachable");
      expect(check.code).toBe("strategy_not_recognised");
    }
  });

  it("⚠ still diagnoses the shape when the LABEL is the only broken part", () => {
    // A grid body under a nonsense label: the fields are fine, so the message says
    // the label is the wrong part rather than listing nine imaginary problems.
    const check = checkParamsShape({ ...GRID_PARAMS, strategy: "martingale" });
    if (check.ok) throw new Error("expected a refusal");
    expect(check.looksLike).toBe("grid");
    expect(check.message).toContain("exactly grid's");
    expect(check.missing).toEqual([]);
  });

  it("refuses a truncated params object and names exactly what is gone", () => {
    const { orderSize: _o, stopLossPct: _s, ...truncated } = GRID_PARAMS;
    const check = checkParamsShape(truncated);
    if (check.ok) throw new Error("expected a refusal");
    expect(check.code).toBe("fields_do_not_match_strategy");
    expect([...check.missing].sort()).toEqual(["orderSize", "stopLossPct"]);
    // Not the other strategy either -- so no misleading `looksLike`.
    expect(check.looksLike).toBeNull();
    expect(check.message).toContain("missing 2 of the 9 fields");
  });

  it("refuses a params carrying fields that belong to no strategy", () => {
    const check = checkParamsShape({ ...GRID_PARAMS, leverage: "3", martingaleFactor: "2" });
    if (check.ok) throw new Error("expected a refusal");
    expect([...check.unexpected].sort()).toEqual(["leverage", "martingaleFactor"]);
    // Nothing is MISSING -- the two faults are reported separately.
    expect(check.missing).toEqual([]);
  });

  it("⚠ refuses a params carrying BOTH strategies' fields at once", () => {
    // THE GAP THIS TEST FOUND IN ITS OWN IMPLEMENTATION. The shape a naive merge of
    // two responses produces. It satisfies grid's list completely and carries no
    // field from outside the two lists, so the first version of `unexpected` --
    // "belongs to neither strategy" -- returned ok:true and the reader would have
    // been shown a grid bot built from a document that also fully describes a DCA
    // one. `unexpected` is now measured against the CLAIMED strategy's list, which
    // is `requireExactFields`' own rule.
    const merged = { ...GRID_PARAMS, ...DCA_PARAMS, strategy: "grid" };
    const check = checkParamsShape(merged);
    expect(check.ok).toBe(false);
    if (check.ok) throw new Error("unreachable");
    expect(check.code).toBe("fields_do_not_match_strategy");
    // Nothing is MISSING -- the fault is entirely that a second strategy's fields
    // are present, so the refusal has to come from the extras.
    expect(check.missing).toEqual([]);
    expect([...check.unexpected].sort()).toEqual(
      [...DCA_PROPOSAL_FIELDS].filter((f) => !GRID_PROPOSAL_FIELDS.includes(f)).sort(),
    );
    // And the message names the actual problem rather than reporting a count.
    expect(check.message).toContain("describes two different bots at once");
    expect(check.message).toContain("silently drop the dca half");
  });

  it("never interpolates a pasted value into its own message", () => {
    // The message is rendered into the page. A pasted string reaching it verbatim
    // would be third-party text in a warning, which is the concern
    // `wrapUntrusted` exists for one layer down. `describe` names TYPES and quotes
    // strings; it never prints an object's contents.
    const check = checkParamsShape({ ...GRID_PARAMS, strategy: { evil: "<script>" } });
    if (check.ok) throw new Error("expected a refusal");
    expect(check.message).not.toContain("<script>");
    expect(check.message).toContain("an object");
    expect(check.claimedStrategy).toBe("an object");
  });
});

// ---------------------------------------------------------------------------
// THE FIELD LISTS ARE PINNED TWO WAYS
// ---------------------------------------------------------------------------

describe("the field lists are the backend's own, not a re-typed copy", () => {
  it("⚠ matches spec 21.4 Stage 3's field lists exactly (GRID_DERIVE_FIELDS / DCA_DERIVE_FIELDS)", () => {
    // PIN ONE: against the spec quotation the prompt builders are pinned to. This
    // is what stops the dashboard's belief about a proposal's fields from drifting
    // away from what the model was actually asked for.
    expect([...GRID_PROPOSAL_FIELDS]).toEqual([...GRID_DERIVE_FIELDS]);
    expect([...DCA_PROPOSAL_FIELDS]).toEqual([...DCA_DERIVE_FIELDS]);
  });

  it("intersects in exactly stopLossPct, the one field both strategies require", () => {
    // The same assertion `derive-prompt.test.ts` makes, for the same reason: a
    // growing intersection is the signature of the conditional design collapsing
    // into a universal one.
    const shared = GRID_PROPOSAL_FIELDS.filter((field) => DCA_PROPOSAL_FIELDS.includes(field));
    expect(shared).toEqual(["stopLossPct"]);
  });

  it("has a list for every strategy and no extras", () => {
    expect([...PROPOSAL_STRATEGIES]).toEqual(["grid", "dca"]);
    expect(proposalFieldsFor("grid")).toBe(GRID_PROPOSAL_FIELDS);
    expect(proposalFieldsFor("dca")).toBe(DCA_PROPOSAL_FIELDS);
    // Frozen, so nothing can extend a list at runtime.
    expect(Object.isFrozen(GRID_PROPOSAL_FIELDS)).toBe(true);
    expect(Object.isFrozen(DCA_PROPOSAL_FIELDS)).toBe(true);
  });

  it("⚠ PIN TWO, AND THE ONE THAT MATTERS: matches the key set `validatedProposalView` really emits", () => {
    // The component reads the VIEW's output, not the prompt's field list. Those two
    // happening to agree today is a fact worth checking rather than assuming --
    // `GRID_DERIVE_FIELDS` is the MODEL RESPONSE contract, and `validatedProposalView`
    // is a separately hand-written renderer over `GridParams`/`DcaParams`. If someone
    // adds a field to the view, the shape check must learn about it here rather than
    // by refusing a valid proposal in production.
    //
    // Driven through the REAL view over a REAL `DeriveResult`, for the reason
    // `citations.test.ts` drives the real prompt builders: a rule ABOUT the view's
    // output, tested against hand-typed keys, pins this module's BELIEF about the
    // backend rather than the backend.
    for (const strategy of PROPOSAL_STRATEGIES) {
      const view = validatedProposalView(deriveResultFor(strategy));
      const emitted = Object.keys(view.params)
        .filter((key) => key !== "strategy")
        .sort();
      expect(emitted, `validatedProposalView's ${strategy} keys drifted`).toEqual(
        [...proposalFieldsFor(strategy)].sort(),
      );
      // And the real view's output PASSES the check, which is the end-to-end
      // statement: a genuine response can never trip the guard.
      const check = checkParamsShape(view.params);
      expect(check.ok, `the real ${strategy} view was refused by the shape check`).toBe(true);
    }
  });

  it("guards the strategy union at runtime as well as in the type", () => {
    expect(isProposalStrategy("grid")).toBe(true);
    expect(isProposalStrategy("dca")).toBe(true);
    for (const value of ["GRID", "", "martingale", null, 1, {}, []]) {
      expect(isProposalStrategy(value), `${JSON.stringify(value)} passed`).toBe(false);
    }
  });
});
