/**
 * The strict reader and the three validation layers: what a clean proposal
 * resolves to, and every single way one is refused whole.
 *
 * Six properties, each one this module would look correct without:
 *
 *  1. A CLEAN PROPOSAL RESOLVES COMPLETELY, FOR BOTH STRATEGIES. Every required
 *     field present, every citation resolved to a real `EvidenceItem`, and the
 *     parameters coming out as the REAL `GridParams`/`DcaParams` the real
 *     decoder produced.
 *  2. THERE IS NO PARTIAL RESULT. Every refusal below is checked not only for
 *     throwing but for producing NOTHING -- no proposal object, no defaulted
 *     field, no corrected number. This is 21.5 requirement 6 and it is asserted
 *     positively rather than inferred from a thrown error.
 *  3. THE REAL DECODER AND THE REAL VALIDATOR DO THE REFUSING. A test that only
 *     asserted "it refuses" would pass equally well against a local lookalike
 *     copy, so every one of these asserts WHICH LAYER refused, and the real
 *     error is kept as `cause`.
 *  4. THE GROUNDING CHECK COVERS EVERY NUMBER, NOT JUST THE PROSE. A parameter
 *     with an empty citation list and a parameter citing an id this run never
 *     emitted are both fatal for the whole proposal.
 *  5. THE STRATEGY-CONDITIONAL FIELD SET IS ENFORCED IN BOTH DIRECTIONS. Grid's
 *     fields in a DCA proposal are refused as unexpected AND as missing, which
 *     is what makes serving the wrong schema catchable.
 *  6. THE MINIMUM-ORDER FLOOR IS CHECKED IN WHICHEVER DIMENSION THE VENUE
 *     PUBLISHES, and honestly reported as unavailable when it publishes none --
 *     never silently passed.
 *
 * NOTHING HERE CALLS A MODEL. Every "response" is a value a human wrote.
 */

import { describe, expect, it } from "vitest";

import { buildAssessPrompt, type EvidenceItem } from "./assess-prompt";
import type { ParsedAssessment } from "./assess-parse";
import {
  DeriveParseError,
  DeriveValidationError,
  parseDeriveResponse,
  plannedSpendOf,
  validateProposal,
  type ParsedProposal,
} from "./derive-parse";
import { buildDerivePrompt, type DerivePrompt } from "./derive-prompt";
import type { AccountCapital } from "./capital";
import { NEWS_NOT_YET_AVAILABLE, type CandidateGatherBundle, type DeriveContext } from "./gather";
import { assessConcentration, type AccountExposure } from "./concentration";
import type { Candidate } from "./candidates";
import type { CandleWindow } from "./candles";
import type { Candle, SymbolFilters, Timestamp } from "../shared/exchange-client";
import { ONE } from "../shared/money";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const T0 = 1_930_000_000_000;
const MINUTE = 60_000;
const PAIR = "ZZQUSD";
/** The newest close in the fixture window. Every price below is anchored on it. */
const LAST_CLOSE = 102n * ONE;

const candidate: Candidate = {
  accountLabel: "gemini-main",
  exchange: "gemini",
  pair: PAIR,
  sources: [
    {
      kind: "named",
      requestedAs: "zzq",
      requestedBy: "operator@example.com",
      requestedAt: T0,
    },
  ],
};

function candle(openTime: Timestamp, close: bigint): Candle {
  return {
    pair: PAIR,
    openTime,
    closeTime: openTime + MINUTE,
    open: close - ONE,
    high: close + 2n * ONE,
    low: close - 3n * ONE,
    close,
    volume: 4n * ONE,
    closed: true,
  };
}

const CANDLES = [candle(T0, 100n * ONE), candle(T0 + MINUTE, 101n * ONE), candle(T0 + 2 * MINUTE, LAST_CLOSE)];

const window: CandleWindow = {
  accountLabel: candidate.accountLabel,
  exchange: candidate.exchange,
  pair: PAIR,
  interval: "1m",
  candles: CANDLES,
  fetchedAt: T0 + 1,
  requestedSince: null,
  earliestOpenTime: CANDLES[0]!.openTime,
  earliestCloseTime: CANDLES[0]!.closeTime,
  latestCloseTime: CANDLES[2]!.closeTime,
  truncated: false,
  missingHistoryMs: null,
};

const exposure: AccountExposure = {
  accountLabel: candidate.accountLabel,
  readAt: T0,
  rowsRead: 0,
  committed: [],
  stopped: [],
  quoteAssetsObserved: ["USD"],
};

const bundle: CandidateGatherBundle = {
  candidate,
  candles: { outcome: "ok", value: window },
  news: NEWS_NOT_YET_AVAILABLE,
  concentration: { outcome: "ok", value: assessConcentration(exposure, candidate) },
  assembledAt: T0,
};

const capital: AccountCapital = {
  accountLabel: candidate.accountLabel,
  readAt: T0 + 5_000,
  rowsRead: 1,
  assets: [
    {
      asset: "USD",
      totalBalance: 5_000n * ONE,
      totalAllocated: 1_000n * ONE,
      available: 4_000n * ONE,
      updatedAt: T0,
    },
  ],
};

/**
 * Gemini's real shape: a quantity floor and NO notional floor.
 *
 * `minNotional: 0n` is not laziness -- `parseSymbolDetails` sets exactly that,
 * because Gemini publishes no notional bounds. The fixture matches the only
 * venue this system runs against, so the tests exercise the path that will
 * actually run.
 */
const filters: SymbolFilters = {
  pair: PAIR,
  baseAsset: "ZZQ",
  quoteAsset: "USD",
  status: "TRADING",
  tickSize: ONE / 100n,
  minPrice: 0n,
  maxPrice: 0n,
  stepSize: ONE / 1_000n,
  minQuantity: ONE / 1_000n, // 0.001 ZZQ
  maxQuantity: 0n,
  minNotional: 0n,
  maxNotional: 0n,
  fetchedAt: T0 + 2,
};

const context: DeriveContext = {
  bundle,
  capital: { outcome: "ok", value: capital },
  filters: { outcome: "ok", value: filters },
  gatheredAt: T0 + 9_000,
};

function assessment(strategy: "grid" | "dca"): ParsedAssessment {
  const item = buildAssessPrompt(bundle).evidence.find((e) => e.id === "candles.range_pct")!;
  return {
    strategy,
    claims: [{ statement: "the window is narrow", citations: [item] }],
    envelope: "envelope_object",
    duplicateKeyCheck: "unavailable_transport_parsed",
  };
}

const gridPrompt: DerivePrompt = buildDerivePrompt(context, assessment("grid"));
const dcaPrompt: DerivePrompt = buildDerivePrompt(context, assessment("dca"));

/** An id this run really emitted. Used everywhere a valid citation is needed. */
const REAL_ID = "candles.last_close";

const cite = (value: unknown, id: string = REAL_ID) => ({ value, citations: [id] });

function gridResponse(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    strategy: "grid",
    parameters: {
      upperBound: cite("108.00000000", "candles.high"),
      lowerBound: cite("96.00000000", "candles.low"),
      gridLines: cite(7, "candles.range_pct"),
      spacing: cite("arithmetic", "candles.range_pct"),
      orderSize: cite("50.00000000", "capital.row.01.available"),
      stopLossPct: cite("5.00000000", "candles.range_pct"),
      breakoutTakeProfit: cite(true, "assessment.strategy"),
      breakoutThresholdPct: cite(null, "candles.range_pct"),
      takeProfitAmount: cite(null, "capital.row.01.available"),
    },
    allocatedCapital: cite("400.00000000", "capital.row.01.available"),
    capitalAsset: cite("USD", "capital.row.01.asset"),
    notes: [{ statement: "the range is narrow, so the bounds sit around it", citations: ["candles.range_pct"] }],
    ...overrides,
  };
}

function dcaResponse(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    strategy: "dca",
    parameters: {
      baseOrderSize: cite("100.00000000", "capital.row.01.available"),
      additionalOrderSize: cite("100.00000000", "capital.row.01.available"),
      stepMultiplier: cite("1.00000000", "candles.range_pct"),
      dropPct: cite("2.00000000", "candles.range_pct"),
      maxAdditionalBuys: cite(2, "candles.range_pct"),
      takeProfitPct: cite("3.00000000", "candles.change_pct"),
      stopLossPct: cite("10.00000000", "candles.range_pct"),
      autoRestart: cite(true, "assessment.strategy"),
      sellOnStopLoss: cite(false, "assessment.strategy"),
    },
    allocatedCapital: cite("400.00000000", "capital.row.01.available"),
    capitalAsset: cite("USD", "capital.row.01.asset"),
    notes: [{ statement: "a modest drop step suits the observed range", citations: ["candles.range_pct"] }],
    ...overrides,
  };
}

/** Swap one parameter, keeping the rest of a valid response intact. */
function withParam(
  base: Record<string, unknown>,
  field: string,
  cited: unknown,
): Record<string, unknown> {
  return { ...base, parameters: { ...(base["parameters"] as object), [field]: cited } };
}

const parseGrid = (raw: unknown) => parseDeriveResponse(raw, gridPrompt);
const parseDca = (raw: unknown) => parseDeriveResponse(raw, dcaPrompt);
const validate = (proposal: ParsedProposal) =>
  validateProposal(proposal, capital, filters, LAST_CLOSE);

/**
 * Assert a refusal produced NOTHING -- not a partial proposal, not a defaulted
 * field. Property 2, asserted positively rather than inferred.
 */
function refusesWholly(run: () => unknown): unknown {
  let result: unknown = "NO THROW";
  let error: unknown = null;
  try {
    result = run();
  } catch (thrown) {
    error = thrown;
  }
  expect(error, "expected a refusal, but the call returned").not.toBeNull();
  expect(result).toBe("NO THROW");
  return error;
}

// ---------------------------------------------------------------------------
// Property 1: a clean proposal, both strategies
// ---------------------------------------------------------------------------

describe("a clean grid proposal", () => {
  it("parses and validates end to end, producing the REAL GridParams", () => {
    const parsed = parseGrid(gridResponse());
    const validated = validate(parsed);

    expect(validated.strategy).toBe("grid");
    expect(validated.params.strategy).toBe("grid");
    if (validated.params.strategy !== "grid") throw new Error("unreachable");

    // Money arrives as exact bigints from the real decoder's own codec.
    expect(validated.params.value.upperBound).toBe(108n * ONE);
    expect(validated.params.value.lowerBound).toBe(96n * ONE);
    expect(validated.params.value.gridLines).toBe(7);
    expect(validated.params.value.spacing).toBe("arithmetic");
    expect(validated.params.value.orderSize).toBe(50n * ONE);
    expect(validated.params.value.stopLossPct).toBe(5n * ONE);
    expect(validated.params.value.breakoutTakeProfit).toBe(true);
    expect(validated.params.value.breakoutThresholdPct).toBeNull();
    expect(validated.params.value.takeProfitAmount).toBeNull();

    expect(validated.allocatedCapital).toBe(400n * ONE);
    expect(validated.capitalAsset).toBe("USD");
    expect(validated.availableAtProposal).toBe(4_000n * ONE);
    // Gemini publishes a quantity floor and no notional floor.
    expect(validated.minimumOrderCheck).toBe("quantity");
    // Grid's reference price is the top of the ladder.
    expect(validated.referencePrice).toBe(108n * ONE);
  });

  it("resolves every field's citations to real EvidenceItems, not to id strings", () => {
    const parsed = parseGrid(gridResponse());
    for (const field of gridPrompt.parameterFields) {
      const cited = parsed.parameters[field]!;
      expect(cited.citations.length).toBeGreaterThan(0);
      for (const item of cited.citations) {
        const real: EvidenceItem | undefined = gridPrompt.evidence.find((e) => e.id === item.id);
        expect(real).toBeDefined();
        // The resolved item is the prompt's own, by identity.
        expect(item).toBe(real);
        expect(item.value.length).toBeGreaterThan(0);
      }
    }
  });

  it("computes the peak commitment with the strategy's own arithmetic", () => {
    const validated = validate(parseGrid(gridResponse()));
    // orderSize x (gridLines - 1) = 50 x 6
    expect(plannedSpendOf(validated.params, validated.allocatedCapital)).toBe(300n * ONE);
  });
});

describe("a clean DCA proposal", () => {
  it("parses and validates end to end, producing the REAL DcaParams", () => {
    const validated = validate(parseDca(dcaResponse()));

    expect(validated.strategy).toBe("dca");
    if (validated.params.strategy !== "dca") throw new Error("unreachable");

    expect(validated.params.value.baseOrderSize).toBe(100n * ONE);
    expect(validated.params.value.additionalOrderSize).toBe(100n * ONE);
    expect(validated.params.value.stepMultiplier).toBe(ONE);
    expect(validated.params.value.dropPct).toBe(2n * ONE);
    expect(validated.params.value.maxAdditionalBuys).toBe(2);
    expect(validated.params.value.takeProfitPct).toBe(3n * ONE);
    expect(validated.params.value.stopLossPct).toBe(10n * ONE);
    expect(validated.params.value.autoRestart).toBe(true);
    expect(validated.params.value.sellOnStopLoss).toBe(false);

    // DCA's reference price is the newest real close, not a ladder bound.
    expect(validated.referencePrice).toBe(LAST_CLOSE);
    expect(plannedSpendOf(validated.params, validated.allocatedCapital)).toBe(300n * ONE);
  });
});

// ---------------------------------------------------------------------------
// Property 5: the conditional field set, both directions
// ---------------------------------------------------------------------------

describe("the strategy-conditional field set", () => {
  it("refuses a DCA parameter set answered against a grid prompt", () => {
    const error = refusesWholly(() => parseGrid({ ...dcaResponse(), strategy: "grid" }));
    expect(error).toBeInstanceOf(DeriveParseError);
    // Missing is reported before unexpected, and either is fatal.
    expect((error as DeriveParseError).code).toBe("missing_field");
    expect((error as DeriveParseError).message).toContain("upperBound");
  });

  it("refuses a grid parameter set answered against a DCA prompt", () => {
    const error = refusesWholly(() => parseDca({ ...gridResponse(), strategy: "dca" }));
    expect(error).toBeInstanceOf(DeriveParseError);
    expect((error as DeriveParseError).code).toBe("missing_field");
    expect((error as DeriveParseError).message).toContain("baseOrderSize");
  });

  it("refuses a grid proposal carrying ONE extra DCA field", () => {
    const response = gridResponse();
    const error = refusesWholly(() =>
      parseGrid(withParam(response, "stepMultiplier", cite("1.00000000"))),
    );
    expect((error as DeriveParseError).code).toBe("unexpected_field");
    expect((error as DeriveParseError).message).toContain("stepMultiplier");
  });

  it("refuses a proposal missing exactly one field, however small", () => {
    const parameters = { ...(gridResponse()["parameters"] as Record<string, unknown>) };
    delete parameters["takeProfitAmount"];
    const error = refusesWholly(() => parseGrid({ ...gridResponse(), parameters }));
    expect((error as DeriveParseError).code).toBe("missing_field");
    expect((error as DeriveParseError).message).toContain("takeProfitAmount");
  });

  it("does NOT default the two optional grid fields the create-bot handler defaults", () => {
    // `handlers.ts` supplies `breakoutThresholdPct: null, takeProfitAmount: null`
    // so a human's FRONTEND may omit them. This stage must not: 21.4 forbids
    // leaving a field for the human to tune, so an omission is a refusal rather
    // than a silently invented parameter.
    const parameters = { ...(gridResponse()["parameters"] as Record<string, unknown>) };
    delete parameters["breakoutThresholdPct"];
    const error = refusesWholly(() => parseGrid({ ...gridResponse(), parameters }));
    expect((error as DeriveParseError).code).toBe("missing_field");
  });
});

// ---------------------------------------------------------------------------
// The stage-agreement check
// ---------------------------------------------------------------------------

describe("a disagreement with Stage 2", () => {
  it("refuses the WHOLE proposal rather than treating it as a signal", () => {
    const error = refusesWholly(() => parseGrid({ ...gridResponse(), strategy: "dca" }));
    expect((error as DeriveParseError).code).toBe("strategy_disagreement");
    expect((error as DeriveParseError).message).toContain("a fault to surface, not a judgement to weigh");
  });

  it("refuses a near-miss on the strategy literal, with no case folding", () => {
    for (const near of ["Grid", "GRID", "grid ", "gridd"]) {
      const error = refusesWholly(() => parseGrid({ ...gridResponse(), strategy: near }));
      expect((error as DeriveParseError).code).toBe("strategy_disagreement");
    }
  });

  it("refuses a hedged strategy value", () => {
    for (const hedge of ["grid or dca", ["grid"], null, 1]) {
      const error = refusesWholly(() => parseGrid({ ...gridResponse(), strategy: hedge }));
      expect((error as DeriveParseError).code).toBe("strategy_disagreement");
    }
  });
});

// ---------------------------------------------------------------------------
// Property 4: the grounding check covers every number
// ---------------------------------------------------------------------------

describe("citations on every proposed value", () => {
  it("refuses a parameter with an EMPTY citation list", () => {
    const error = refusesWholly(() =>
      parseGrid(withParam(gridResponse(), "orderSize", { value: "50.00000000", citations: [] })),
    );
    expect((error as DeriveParseError).code).toBe("citations_invalid");
  });

  it("refuses a parameter with NO citations key at all", () => {
    const error = refusesWholly(() =>
      parseGrid(withParam(gridResponse(), "orderSize", { value: "50.00000000" })),
    );
    expect((error as DeriveParseError).code).toBe("missing_field");
  });

  it("refuses a parameter citing an id this run never emitted", () => {
    const error = refusesWholly(() =>
      parseGrid(withParam(gridResponse(), "upperBound", cite("108.00000000", "candles.rsi_14"))),
    );
    expect((error as DeriveParseError).code).toBe("citation_unknown");
    expect((error as DeriveParseError).message).toContain("candles.rsi_14");
  });

  it("refuses a PLAUSIBLE invented id, not just an obviously fake one", () => {
    // `news.sentiment_score` looks exactly like an id this system might emit,
    // and would if a news vendor existed. It does not exist in this run.
    const error = refusesWholly(() =>
      parseGrid(withParam(gridResponse(), "stopLossPct", cite("5.00000000", "news.sentiment_score"))),
    );
    expect((error as DeriveParseError).code).toBe("citation_unknown");
  });

  it("refuses when ONE citation among several good ones is invented", () => {
    const error = refusesWholly(() =>
      parseGrid(
        withParam(gridResponse(), "lowerBound", {
          value: "96.00000000",
          citations: ["candles.low", "candles.high", "candles.invented"],
        }),
      ),
    );
    expect((error as DeriveParseError).code).toBe("citation_unknown");
  });

  it("refuses a bare value that skipped the citation wrapper entirely", () => {
    const error = refusesWholly(() => parseGrid(withParam(gridResponse(), "gridLines", 7)));
    expect((error as DeriveParseError).code).toBe("cited_value_not_an_object");
  });

  it("refuses an uncited allocatedCapital", () => {
    const error = refusesWholly(() =>
      parseGrid({ ...gridResponse(), allocatedCapital: { value: "400.00000000", citations: [] } }),
    );
    expect((error as DeriveParseError).code).toBe("citations_invalid");
  });

  it("refuses an uncited capitalAsset", () => {
    const error = refusesWholly(() =>
      parseGrid({ ...gridResponse(), capitalAsset: { value: "USD", citations: ["capital.invented"] } }),
    );
    expect((error as DeriveParseError).code).toBe("citation_unknown");
  });

  it("ACCEPTS a repeated citation id, which is legitimate", () => {
    const parsed = parseGrid(
      withParam(gridResponse(), "upperBound", {
        value: "108.00000000",
        citations: ["candles.high", "candles.high"],
      }),
    );
    expect(parsed.parameters["upperBound"]!.citations).toHaveLength(2);
  });
});

describe("the notes", () => {
  it("refuses an empty notes array: a parameter set with no stated reasoning", () => {
    const error = refusesWholly(() => parseGrid({ ...gridResponse(), notes: [] }));
    expect((error as DeriveParseError).code).toBe("notes_empty");
  });

  it("refuses a blank note statement", () => {
    const error = refusesWholly(() =>
      parseGrid({ ...gridResponse(), notes: [{ statement: "   ", citations: ["candles.high"] }] }),
    );
    expect((error as DeriveParseError).code).toBe("note_statement_invalid");
  });

  it("refuses a note citing an invented id", () => {
    const error = refusesWholly(() =>
      parseGrid({ ...gridResponse(), notes: [{ statement: "ok", citations: ["nope.nope"] }] }),
    );
    expect((error as DeriveParseError).code).toBe("citation_unknown");
  });

  it("ACCEPTS hedged prose in a note, which the prompt requires when evidence is thin", () => {
    const parsed = parseGrid({
      ...gridResponse(),
      notes: [
        {
          statement: "this window is only three candles and may not represent the pair's behaviour",
          citations: ["candles.count"],
        },
      ],
    });
    expect(parsed.notes[0].statement).toContain("may not represent");
  });
});

// ---------------------------------------------------------------------------
// The shared transport layer, reached through Derive's own vocabulary
// ---------------------------------------------------------------------------

describe("the transport envelope", () => {
  it("accepts the OBSERVED Workers AI shape, an already-parsed object", () => {
    const parsed = parseGrid({ response: gridResponse() });
    expect(parsed.envelope).toBe("envelope_object");
    expect(parsed.duplicateKeyCheck).toBe("unavailable_transport_parsed");
  });

  it("accepts an answer that arrived as text, and runs the duplicate scan on it", () => {
    const parsed = parseGrid(JSON.stringify(gridResponse()));
    expect(parsed.envelope).toBe("bare_string");
    expect(parsed.duplicateKeyCheck).toBe("performed");
  });

  it("refuses a duplicate key on the text path", () => {
    const text = JSON.stringify(gridResponse()).replace('"strategy":"grid"', '"strategy":"dca","strategy":"grid"');
    const error = refusesWholly(() => parseGrid(text));
    expect((error as DeriveParseError).code).toBe("duplicate_key");
  });

  it("refuses a markdown fence rather than stripping it", () => {
    const error = refusesWholly(() => parseGrid("```json\n" + JSON.stringify(gridResponse()) + "\n```"));
    expect((error as DeriveParseError).code).toBe("fenced_response");
  });

  it("refuses prose around the JSON rather than extracting it", () => {
    const error = refusesWholly(() => parseGrid("Here you go: " + JSON.stringify(gridResponse())));
    expect((error as DeriveParseError).code).toBe("not_json");
  });

  it("refuses a truncated answer", () => {
    const text = JSON.stringify(gridResponse()).slice(0, 200);
    expect((refusesWholly(() => parseGrid(text)) as DeriveParseError).code).toBe("not_json");
  });

  it("names an async batch envelope separately: queued is not answered", () => {
    const error = refusesWholly(() => parseGrid({ request_id: "abc" }));
    expect((error as DeriveParseError).code).toBe("async_batch_envelope");
  });

  it("throws DeriveParseError, never AssessParseError, for a shared failure", () => {
    const error = refusesWholly(() => parseGrid(""));
    expect(error).toBeInstanceOf(DeriveParseError);
    expect((error as Error).name).toBe("DeriveParseError");
  });
});

// ---------------------------------------------------------------------------
// Property 3: the REAL decoder refuses, and says so
// ---------------------------------------------------------------------------

describe("layer 1 -- the real decoders", () => {
  it("refuses a money value sent as a number instead of a decimal string", () => {
    const parsed = parseGrid(withParam(gridResponse(), "orderSize", cite(50)));
    const error = refusesWholly(() => validate(parsed)) as DeriveValidationError;
    expect(error.layer).toBe("decoder");
    expect(error.message).toContain("decodeGridParams");
    expect(error.message).toContain("orderSize is number, not a string");
  });

  it("refuses gridLines sent as a string instead of a number", () => {
    const parsed = parseGrid(withParam(gridResponse(), "gridLines", cite("7")));
    const error = refusesWholly(() => validate(parsed)) as DeriveValidationError;
    expect(error.layer).toBe("decoder");
    expect(error.message).toContain("gridLines is string, not a number");
  });

  it("refuses a spacing value outside the two the system implements", () => {
    const parsed = parseGrid(withParam(gridResponse(), "spacing", cite("logarithmic")));
    const error = refusesWholly(() => validate(parsed)) as DeriveValidationError;
    expect(error.layer).toBe("decoder");
    expect(error.message).toContain("not a grid spacing");
  });

  it("refuses a non-boolean autoRestart on the DCA side", () => {
    const parsed = parseDca(withParam(dcaResponse(), "autoRestart", cite("yes")));
    const error = refusesWholly(() => validate(parsed)) as DeriveValidationError;
    expect(error.layer).toBe("decoder");
    expect(error.message).toContain("decodeDcaParams");
  });

  it("keeps the real decoder's own error as `cause`, not a re-description", () => {
    const parsed = parseGrid(withParam(gridResponse(), "orderSize", cite(50)));
    const error = refusesWholly(() => validate(parsed)) as DeriveValidationError;
    expect((error as { cause?: unknown }).cause).toBeInstanceOf(Error);
    expect(((error as { cause?: Error }).cause as { name?: string }).name).toBe("GridError");
  });

  it("refuses an allocatedCapital that is not a decimal string", () => {
    const parsed = parseGrid({ ...gridResponse(), allocatedCapital: cite(400) });
    const error = refusesWholly(() => validate(parsed)) as DeriveValidationError;
    expect(error.layer).toBe("decoder");
    expect(error.message).toContain("not a decimal string");
  });
});

// ---------------------------------------------------------------------------
// Property 3: the REAL validators refuse, and say so
// ---------------------------------------------------------------------------

describe("layer 2 -- the real strategy validators", () => {
  it("refuses an INVERTED grid range, and the REAL buildLevels is what refuses it", () => {
    const parsed = parseGrid(
      withParam(
        withParam(gridResponse(), "upperBound", cite("96.00000000", "candles.low")),
        "lowerBound",
        cite("108.00000000", "candles.high"),
      ),
    );
    const error = refusesWholly(() => validate(parsed)) as DeriveValidationError;

    // The LAYER matters as much as the refusal. If a duplicated local check ever
    // absorbed this, the layer would change and this test would say so.
    expect(error.layer).toBe("strategy_validator");
    expect(error.message).toContain("validateGridParams");
    expect(error.message).toContain("must be above lowerBound");
  });

  it("refuses equal bounds, which are a degenerate ladder rather than a range", () => {
    const parsed = parseGrid(
      withParam(gridResponse(), "upperBound", cite("96.00000000", "candles.low")),
    );
    const error = refusesWholly(() => validate(parsed)) as DeriveValidationError;
    expect(error.layer).toBe("strategy_validator");
  });

  it("refuses a ZERO stop-loss percentage on grid", () => {
    const parsed = parseGrid(withParam(gridResponse(), "stopLossPct", cite("0.00000000")));
    const error = refusesWholly(() => validate(parsed)) as DeriveValidationError;
    expect(error.layer).toBe("strategy_validator");
    expect(error.message).toContain("stopLossPct must be positive");
  });

  it("refuses a 100%-or-more stop-loss, which a positive price can never reach", () => {
    const parsed = parseGrid(withParam(gridResponse(), "stopLossPct", cite("100.00000000")));
    const error = refusesWholly(() => validate(parsed)) as DeriveValidationError;
    expect(error.layer).toBe("strategy_validator");
    expect(error.message).toContain("below 100%");
  });

  it("refuses a ZERO order size", () => {
    const parsed = parseGrid(withParam(gridResponse(), "orderSize", cite("0.00000000")));
    const error = refusesWholly(() => validate(parsed)) as DeriveValidationError;
    expect(error.layer).toBe("strategy_validator");
    expect(error.message).toContain("orderSize must be positive");
  });

  it("refuses fewer than two grid lines", () => {
    const parsed = parseGrid(withParam(gridResponse(), "gridLines", cite(1)));
    const error = refusesWholly(() => validate(parsed)) as DeriveValidationError;
    expect(error.layer).toBe("strategy_validator");
    expect(error.message).toContain("gridLines must be an integer >= 2");
  });

  it("refuses a ladder that cannot fit inside its own allocation", () => {
    // 50 x (7-1) = 300, so an allocation of 100 cannot fund the ladder.
    const parsed = parseGrid({ ...gridResponse(), allocatedCapital: cite("100.00000000", "capital.row.01.available") });
    const error = refusesWholly(() => validate(parsed)) as DeriveValidationError;
    expect(error.layer).toBe("strategy_validator");
    expect(error.message).toContain("exceeds_allocated_capital");
  });

  it("refuses a ZERO dropPct on DCA", () => {
    const parsed = parseDca(withParam(dcaResponse(), "dropPct", cite("0.00000000")));
    const error = refusesWholly(() => validate(parsed)) as DeriveValidationError;
    expect(error.layer).toBe("strategy_validator");
    expect(error.message).toContain("dropPct must be positive");
  });

  it("refuses a 100% dropPct, which would put the trigger price at zero", () => {
    const parsed = parseDca(withParam(dcaResponse(), "dropPct", cite("100.00000000")));
    const error = refusesWholly(() => validate(parsed)) as DeriveValidationError;
    expect(error.layer).toBe("strategy_validator");
    expect(error.message).toContain("dropPct must be below 100%");
  });

  it("refuses sellOnStopLoss: true, which this system has not implemented", () => {
    const parsed = parseDca(withParam(dcaResponse(), "sellOnStopLoss", cite(true)));
    const error = refusesWholly(() => validate(parsed)) as DeriveValidationError;
    expect(error.layer).toBe("strategy_validator");
    expect(error.message).toContain("sellOnStopLoss is not implemented");
  });

  it("refuses a negative maxAdditionalBuys", () => {
    const parsed = parseDca(withParam(dcaResponse(), "maxAdditionalBuys", cite(-1)));
    const error = refusesWholly(() => validate(parsed)) as DeriveValidationError;
    expect(error.layer).toBe("strategy_validator");
  });

  it("refuses a DCA plan whose worst-case spend exceeds its allocation", () => {
    // base 100 + 2 additional x 100 = 300, against an allocation of 150.
    const parsed = parseDca({ ...dcaResponse(), allocatedCapital: cite("150.00000000", "capital.row.01.available") });
    const error = refusesWholly(() => validate(parsed)) as DeriveValidationError;
    expect(error.layer).toBe("strategy_validator");
    expect(error.message).toContain("exceeds_allocated_capital");
  });
});

// ---------------------------------------------------------------------------
// Property 6: layer 3, only what the first two do not check
// ---------------------------------------------------------------------------

describe("layer 3 -- the capital headroom", () => {
  it("refuses an allocation above the account's REAL available headroom", () => {
    const parsed = parseGrid({ ...gridResponse(), allocatedCapital: cite("4000.00000001", "capital.row.01.available") });
    const error = refusesWholly(() => validate(parsed)) as DeriveValidationError;
    expect(error.layer).toBe("sanity_bound");
    expect(error.code).toBe("allocated_capital_exceeds_headroom");
    expect(error.message).toContain("4000.00000000");
  });

  it("ACCEPTS an allocation exactly at the headroom", () => {
    // orderSize must still fit: 4000 covers 50 x 6.
    const validated = validate(
      parseGrid({ ...gridResponse(), allocatedCapital: cite("4000.00000000", "capital.row.01.available") }),
    );
    expect(validated.allocatedCapital).toBe(4_000n * ONE);
  });

  it("says explicitly that clearing this check is NOT an entitlement", () => {
    const parsed = parseGrid({ ...gridResponse(), allocatedCapital: cite("9999.00000000", "capital.row.01.available") });
    const error = refusesWholly(() => validate(parsed)) as DeriveValidationError;
    expect(error.message).toContain("the binding check is createBotInstanceWithCapital's");
  });

  it("refuses a zero allocation", () => {
    const parsed = parseGrid({ ...gridResponse(), allocatedCapital: cite("0.00000000", "capital.row.01.available") });
    const error = refusesWholly(() => validate(parsed)) as DeriveValidationError;
    // The strategy validator sees a ladder that cannot fit in zero first, which
    // is the real path's own order. Either way it is refused whole.
    expect(["strategy_validator", "sanity_bound"]).toContain(error.layer);
  });

  it("refuses an allocation in an asset the account holds no ledger row for", () => {
    const parsed = parseGrid({ ...gridResponse(), capitalAsset: cite("GUSD", "capital.row.01.asset") });
    const error = refusesWholly(() => validate(parsed)) as DeriveValidationError;
    expect(error.layer).toBe("sanity_bound");
    expect(error.code).toBe("capital_asset_unknown");
    expect(error.message).toContain("holds no capital_ledger row");
  });

  it("refuses a non-string capitalAsset", () => {
    const parsed = parseGrid({ ...gridResponse(), capitalAsset: cite(null, "capital.row.01.asset") });
    const error = refusesWholly(() => validate(parsed)) as DeriveValidationError;
    expect(error.code).toBe("capital_asset_unknown");
  });

  it("does NOT trim an over-large allocation down to fit", () => {
    const parsed = parseGrid({ ...gridResponse(), allocatedCapital: cite("9999.00000000", "capital.row.01.available") });
    refusesWholly(() => validate(parsed));
    // Positively: nothing was mutated on the parsed proposal either.
    expect(parsed.allocatedCapital.value).toBe("9999.00000000");
  });
});

describe("layer 3 -- the venue's real minimum order floor", () => {
  it("refuses an order size whose implied QUANTITY is below the venue's floor", () => {
    // minQuantity is 0.001 ZZQ; at a reference price of 108, an order of
    // 0.05 USD buys 0.00046..., which is below it.
    const parsed = parseGrid({
      ...withParam(gridResponse(), "orderSize", cite("0.05000000", "capital.row.01.available")),
      allocatedCapital: cite("400.00000000", "capital.row.01.available"),
    });
    const error = refusesWholly(() => validate(parsed)) as DeriveValidationError;
    expect(error.layer).toBe("sanity_bound");
    expect(error.code).toBe("order_size_below_minimum");
    expect(error.message).toContain("minimum order size");
  });

  it("uses the HIGHEST price an order would be placed at, where the quantity is smallest", () => {
    const validated = validate(parseGrid(gridResponse()));
    expect(validated.referencePrice).toBe(108n * ONE); // upperBound, not lowerBound
  });

  it("checks a NOTIONAL floor when the venue publishes one", () => {
    const withNotional: SymbolFilters = { ...filters, minQuantity: 0n, minNotional: 100n * ONE };
    const parsed = parseGrid(gridResponse()); // orderSize 50, below a 100 floor
    const error = refusesWholly(() =>
      validateProposal(parsed, capital, withNotional, LAST_CLOSE),
    ) as DeriveValidationError;
    expect(error.code).toBe("order_size_below_minimum");
    expect(error.message).toContain("minimum notional");
  });

  it("reports which floor was checked, per proposal", () => {
    expect(validate(parseGrid(gridResponse())).minimumOrderCheck).toBe("quantity");

    const both: SymbolFilters = { ...filters, minNotional: ONE };
    expect(validateProposal(parseGrid(gridResponse()), capital, both, LAST_CLOSE).minimumOrderCheck).toBe("both");

    const notionalOnly: SymbolFilters = { ...filters, minQuantity: 0n, minNotional: ONE };
    expect(
      validateProposal(parseGrid(gridResponse()), capital, notionalOnly, LAST_CLOSE).minimumOrderCheck,
    ).toBe("notional");
  });

  it("reports `none_published` rather than silently passing when the venue publishes NEITHER floor", () => {
    const noFloors: SymbolFilters = { ...filters, minQuantity: 0n, minNotional: 0n };
    const validated = validateProposal(parseGrid(gridResponse()), capital, noFloors, LAST_CLOSE);
    // The proposal is accepted -- there is genuinely nothing to check -- and the
    // result SAYS that no floor was checked, rather than implying one held.
    expect(validated.minimumOrderCheck).toBe("none_published");
  });

  it("checks DCA's base order size against the floor", () => {
    const parsed = parseDca(
      withParam(dcaResponse(), "baseOrderSize", cite("0.01000000", "capital.row.01.available")),
    );
    const error = refusesWholly(() => validate(parsed)) as DeriveValidationError;
    expect(error.code).toBe("order_size_below_minimum");
    expect(error.message).toContain("baseOrderSize");
  });

  it("checks DCA's ADDITIONAL order size too, when additional buys can happen", () => {
    const parsed = parseDca(
      withParam(dcaResponse(), "additionalOrderSize", cite("0.01000000", "capital.row.01.available")),
    );
    const error = refusesWholly(() => validate(parsed)) as DeriveValidationError;
    expect(error.code).toBe("order_size_below_minimum");
    expect(error.message).toContain("additionalOrderSize");
  });

  it("does NOT check the additional size when maxAdditionalBuys is zero", () => {
    // With no additional buys the size is never spent, and `validateDcaParams`
    // does not require it to be positive -- so requiring it to clear a venue
    // floor would refuse a configuration the real system accepts.
    const parsed = parseDca(
      withParam(
        withParam(dcaResponse(), "maxAdditionalBuys", cite(0)),
        "additionalOrderSize",
        cite("0.00000001", "capital.row.01.available"),
      ),
    );
    expect(validate(parsed).minimumOrderCheck).toBe("quantity");
  });
});

// ---------------------------------------------------------------------------
// Property 2: no partial results, stated once more as a whole-object property
// ---------------------------------------------------------------------------

describe("nothing is ever partially accepted", () => {
  it("produces NO value at all for every refusal mode, across both strategies", () => {
    const cases: readonly (readonly [string, () => unknown])[] = [
      ["missing field", () => parseGrid({ ...gridResponse(), parameters: {} })],
      ["extra field", () => parseGrid(withParam(gridResponse(), "nonsense", cite("x")))],
      ["strategy disagreement", () => parseGrid({ ...gridResponse(), strategy: "dca" })],
      ["invented citation", () => parseGrid(withParam(gridResponse(), "orderSize", cite("50.00000000", "made.up")))],
      ["missing citation", () => parseGrid(withParam(gridResponse(), "orderSize", { value: "50.00000000", citations: [] }))],
      ["decoder rejection", () => validate(parseGrid(withParam(gridResponse(), "orderSize", cite(50))))],
      ["inverted range", () =>
        validate(
          parseGrid(
            withParam(
              withParam(gridResponse(), "upperBound", cite("1.00000000", "candles.low")),
              "lowerBound",
              cite("2.00000000", "candles.high"),
            ),
          ),
        )],
      ["zero percentage", () => validate(parseGrid(withParam(gridResponse(), "stopLossPct", cite("0.00000000"))))],
      ["below minimum order", () =>
        validate(parseGrid(withParam(gridResponse(), "orderSize", cite("0.05000000", "capital.row.01.available"))))],
      ["capital over headroom", () =>
        validate(parseGrid({ ...gridResponse(), allocatedCapital: cite("99999.00000000", "capital.row.01.available") }))],
      ["unknown capital asset", () =>
        validate(parseGrid({ ...gridResponse(), capitalAsset: cite("NOPE", "capital.row.01.asset") }))],
      ["dca sellOnStopLoss true", () =>
        validate(parseDca(withParam(dcaResponse(), "sellOnStopLoss", cite(true))))],
      ["dca decoder rejection", () =>
        validate(parseDca(withParam(dcaResponse(), "maxAdditionalBuys", cite("2"))))],
    ];

    for (const [name, run] of cases) {
      let returned: unknown = "NO THROW";
      let threw = false;
      try {
        returned = run();
      } catch {
        threw = true;
      }
      expect(threw, `${name} did not refuse`).toBe(true);
      expect(returned, `${name} returned a partial result`).toBe("NO THROW");
    }
  });
});
