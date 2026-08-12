/**
 * The Stage 3 runner: what it refuses BEFORE spending an inference, what it
 * sends, how many times it sends it, and what it refuses to hand back.
 *
 * Six properties, each one this module would look correct without:
 *
 *  1. THE MODEL IS ASKED EXACTLY ONCE, EVER. Not once per success -- once per
 *     call, including when the answer is refused. Asserted by counting calls
 *     positively, which is the assertion decision log 39's surviving mutant C9
 *     was closed by adding.
 *  2. THE PRECONDITIONS REFUSE WITHOUT CALLING. Four states -- no prices, an
 *     unreadable ledger, no headroom at all, unreadable filters -- each refuse
 *     with their own code and a call count of ZERO, so a refusal costs no money.
 *  3. THE STRATEGY-CONDITIONAL SCHEMA REACHES THE REQUEST. The settings sent
 *     with a grid prompt carry grid's schema and DCA's carry DCA's, checked at
 *     the request boundary where a transport would read it.
 *  4. THE STRATEGY COMES FROM THE ASSESSMENT AND NOWHERE ELSE. Same context,
 *     two assessments, two entirely different requests.
 *  5. NOTHING IS CAUGHT. A model that throws, a response that is refused and a
 *     parameter set that fails validation all propagate as themselves.
 *  6. THE RESULT CARRIES ITS OWN AUDIT TRAIL. Prompt text, settings, model id,
 *     the raw response, the assessment and the context all travel on it, so
 *     21.5 requirement 5's row can be written from the result alone.
 *
 * NOTHING HERE CALLS A MODEL: every `DeriveModel` is a stub that counts its
 * calls and returns a value a human wrote.
 */

import { describe, expect, it } from "vitest";

import { buildAssessPrompt } from "./assess-prompt";
import type { ParsedAssessment } from "./assess-parse";
import type { AccountCapital } from "./capital";
import {
  DERIVE_MODEL,
  DERIVE_MODEL_CONTEXT_TOKENS,
  DERIVE_MODEL_SETTINGS,
  DeriveError,
  deriveParameters,
  type DeriveModel,
  type DeriveModelRequest,
} from "./derive";
import { DeriveParseError, DeriveValidationError } from "./derive-parse";
import { DCA_DERIVE_FIELDS, GRID_DERIVE_FIELDS } from "./derive-prompt";
import { CandleWindowError, type CandleWindow } from "./candles";
import { ResearchCapitalError } from "./capital";
import { NEWS_NOT_YET_AVAILABLE, type CandidateGatherBundle, type DeriveContext } from "./gather";
import { assessConcentration, type AccountExposure } from "./concentration";
import type { Candidate } from "./candidates";
import type { Candle, SymbolFilters, Timestamp } from "../shared/exchange-client";
import { ONE } from "../shared/money";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const T0 = 1_930_000_000_000;
const MINUTE = 60_000;
const PAIR = "ZZQUSD";
const LAST_CLOSE = 102n * ONE;

const candidate: Candidate = {
  accountLabel: "gemini-main",
  exchange: "gemini",
  pair: PAIR,
  sources: [{ kind: "named", requestedAs: "zzq", requestedBy: "operator@example.com", requestedAt: T0 }],
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
    { asset: "USD", totalBalance: 5_000n * ONE, totalAllocated: 1_000n * ONE, available: 4_000n * ONE, updatedAt: T0 },
  ],
};

const filters: SymbolFilters = {
  pair: PAIR,
  baseAsset: "ZZQ",
  quoteAsset: "USD",
  status: "TRADING",
  tickSize: ONE / 100n,
  minPrice: 0n,
  maxPrice: 0n,
  stepSize: ONE / 1_000n,
  minQuantity: ONE / 1_000n,
  maxQuantity: 0n,
  minNotional: 0n,
  maxNotional: 0n,
  fetchedAt: T0 + 2,
};

function context(overrides: Partial<DeriveContext> = {}): DeriveContext {
  return {
    bundle,
    capital: { outcome: "ok", value: capital },
    filters: { outcome: "ok", value: filters },
    gatheredAt: T0 + 9_000,
    ...overrides,
  };
}

function assessment(strategy: "grid" | "dca"): ParsedAssessment {
  const item = buildAssessPrompt(bundle).evidence.find((e) => e.id === "candles.range_pct")!;
  return {
    strategy,
    claims: [{ statement: "the window is narrow", citations: [item] }],
    envelope: "envelope_object",
    duplicateKeyCheck: "unavailable_transport_parsed",
  };
}

const cite = (value: unknown, id = "candles.last_close") => ({ value, citations: [id] });

const GRID_ANSWER = {
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
  notes: [{ statement: "the range is narrow", citations: ["candles.range_pct"] }],
};

const DCA_ANSWER = {
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
  notes: [{ statement: "a modest drop step suits the range", citations: ["candles.range_pct"] }],
};

/** A stub that COUNTS its calls and records what it was sent. */
function stub(answer: unknown): { model: DeriveModel; calls: DeriveModelRequest[] } {
  const calls: DeriveModelRequest[] = [];
  const model: DeriveModel = async (request) => {
    calls.push(request);
    return { text: { response: answer }, raw: { response: answer } };
  };
  return { model, calls };
}

const NEVER_CALLED: { model: DeriveModel; calls: DeriveModelRequest[] } = (() => {
  const calls: DeriveModelRequest[] = [];
  return {
    calls,
    model: async (request) => {
      calls.push(request);
      throw new Error("the model must not have been called");
    },
  };
})();

// ---------------------------------------------------------------------------
// Property 2: the preconditions refuse without spending anything
// ---------------------------------------------------------------------------

describe("preconditions refuse BEFORE the model is called", () => {
  async function expectRefusedWithoutCalling(
    ctx: DeriveContext,
    code: string,
  ): Promise<DeriveError> {
    const calls: DeriveModelRequest[] = [];
    const model: DeriveModel = async (request) => {
      calls.push(request);
      return { text: { response: GRID_ANSWER }, raw: null };
    };
    const error = await deriveParameters(model, ctx, assessment("grid")).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DeriveError);
    expect((error as DeriveError).code).toBe(code);
    // The whole point: a refusal costs no inference.
    expect(calls).toHaveLength(0);
    return error as DeriveError;
  }

  it("refuses a bundle whose candle fetch failed", async () => {
    const error = await expectRefusedWithoutCalling(
      context({
        bundle: {
          ...bundle,
          candles: {
            outcome: "failed",
            error: new CandleWindowError("candles_unavailable", "venue down"),
            failedAt: T0,
          },
        },
      }),
      "no_price_history",
    );
    expect(error.message).toContain("21.5 requirement 1 forbids");
  });

  it("refuses a bundle whose candle window is empty", async () => {
    await expectRefusedWithoutCalling(
      context({ bundle: { ...bundle, candles: { outcome: "ok", value: { ...window, candles: [] } } } }),
      "no_price_history",
    );
  });

  it("refuses an UNREADABLE capital ledger rather than assuming none or plenty", async () => {
    const error = await expectRefusedWithoutCalling(
      context({
        capital: {
          outcome: "failed",
          error: new ResearchCapitalError("ledger_unreadable", "D1 down"),
          failedAt: T0,
        },
      }),
      "capital_unreadable",
    );
    expect(error.message).toContain("fabricated one");
  });

  it("refuses an account with NO headroom on any asset", async () => {
    const error = await expectRefusedWithoutCalling(
      context({
        capital: {
          outcome: "ok",
          value: {
            ...capital,
            assets: [{ ...capital.assets[0]!, totalAllocated: 5_000n * ONE, available: 0n }],
          },
        },
      }),
      "no_capital_headroom",
    );
    expect(error.message).toContain("no asset with capital available");
  });

  it("refuses an account whose ledger read found no rows at all", async () => {
    await expectRefusedWithoutCalling(
      context({ capital: { outcome: "ok", value: { ...capital, rowsRead: 0, assets: [] } } }),
      "no_capital_headroom",
    );
  });

  it("refuses UNREADABLE symbol filters, because then no order floor is checkable", async () => {
    const error = await expectRefusedWithoutCalling(
      context({ filters: { outcome: "failed", error: new Error("ETIMEDOUT"), failedAt: T0 } }),
      "symbol_filters_unreadable",
    );
    expect(error.message).toContain("degraded-but-indistinguishable");
  });

  it("refuses a non-positive newest close, rather than dividing by it", async () => {
    await expectRefusedWithoutCalling(
      context({
        bundle: {
          ...bundle,
          candles: {
            outcome: "ok",
            value: { ...window, candles: [candle(T0, 0n)] },
          },
        },
      }),
      "no_price_history",
    );
  });

  it("does NOT refuse for a failed concentration read, which is context not question", async () => {
    const { model, calls } = stub(GRID_ANSWER);
    const result = await deriveParameters(
      model,
      context({
        bundle: {
          ...bundle,
          concentration: { outcome: "threw_unexpectedly", error: new TypeError("boom"), failedAt: T0 },
        },
      }),
      assessment("grid"),
    );
    expect(calls).toHaveLength(1);
    expect(result.strategy).toBe("grid");
    // And the failure is still reported to the model rather than hidden.
    expect(result.promptText).toContain("NOT one of its enumerated refusals");
  });
});

// ---------------------------------------------------------------------------
// Properties 3 and 4: the conditional schema at the request boundary
// ---------------------------------------------------------------------------

describe("the request that would be sent", () => {
  it("carries GRID's schema and grid's fields for a grid assessment", async () => {
    const { model, calls } = stub(GRID_ANSWER);
    await deriveParameters(model, context(), assessment("grid"));

    const request = calls[0]!;
    expect(request.strategy).toBe("grid");
    expect(request.model).toBe(DERIVE_MODEL);
    expect(request.settings).toBe(DERIVE_MODEL_SETTINGS.grid);

    const schema = request.settings.responseFormat.json_schema as Record<string, unknown>;
    const properties = (schema["properties"] as Record<string, unknown>)["parameters"] as Record<string, unknown>;
    expect(properties["required"]).toEqual([...GRID_DERIVE_FIELDS]);
  });

  it("carries DCA's schema and DCA's fields for a DCA assessment", async () => {
    const { model, calls } = stub(DCA_ANSWER);
    await deriveParameters(model, context(), assessment("dca"));

    const request = calls[0]!;
    expect(request.strategy).toBe("dca");
    expect(request.settings).toBe(DERIVE_MODEL_SETTINGS.dca);

    const schema = request.settings.responseFormat.json_schema as Record<string, unknown>;
    const properties = (schema["properties"] as Record<string, unknown>)["parameters"] as Record<string, unknown>;
    expect(properties["required"]).toEqual([...DCA_DERIVE_FIELDS]);
  });

  it("NEVER sends one strategy's schema for the other's prompt", async () => {
    // The mutation this defends against is a `DERIVE_MODEL_SETTINGS.dca`
    // hardcoded where the strategy should be looked up. Checked from both
    // sides, since a hardcode is only wrong for one of them.
    const grid = stub(GRID_ANSWER);
    await deriveParameters(grid.model, context(), assessment("grid"));
    expect(grid.calls[0]!.settings).not.toBe(DERIVE_MODEL_SETTINGS.dca);

    const dca = stub(DCA_ANSWER);
    await deriveParameters(dca.model, context(), assessment("dca"));
    expect(dca.calls[0]!.settings).not.toBe(DERIVE_MODEL_SETTINGS.grid);
  });

  it("sends a prompt built for the SAME strategy as the schema", async () => {
    const { model, calls } = stub(DCA_ANSWER);
    await deriveParameters(model, context(), assessment("dca"));
    const request = calls[0]!;
    expect(request.prompt).toContain('THE STRATEGY IS ALREADY DECIDED AND IT IS "dca"');
    expect(request.prompt).not.toContain("upperBound");
  });

  it("takes the strategy from the assessment and nothing else", async () => {
    // Identical context, two assessments. If the strategy leaked in from the
    // bundle, these could not differ.
    const grid = stub(GRID_ANSWER);
    const dca = stub(DCA_ANSWER);
    const ctx = context();
    await deriveParameters(grid.model, ctx, assessment("grid"));
    await deriveParameters(dca.model, ctx, assessment("dca"));
    expect(grid.calls[0]!.strategy).toBe("grid");
    expect(dca.calls[0]!.strategy).toBe("dca");
  });
});

describe("the JSON schema actually sent to the model", () => {
  /**
   * Found by a surviving mutant: widening the schema's `strategy` enum to
   * accept BOTH strategies broke no test.
   *
   * The blast radius is real but bounded, and worth stating exactly. The schema
   * is a REQUEST -- Cloudflare "can't guarantee that the model responds
   * according to the requested JSON Schema" -- so the enforcement is the
   * parser's `strategy_disagreement` refusal, which its own tests cover and
   * which a separate mutant confirms is caught. A loosened enum therefore
   * cannot make a wrong-strategy proposal pass; it can only make the model more
   * likely to produce one that is then refused.
   *
   * It is still tested, for two reasons: the schema travels on the audit record
   * (21.5 requirement 5), so "which schema did this run ask for" must be
   * answerable, and a check nobody asserts is a check that quietly drifts.
   */
  it("constrains `strategy` to the ONE strategy this request is for", () => {
    for (const strategy of ["grid", "dca"] as const) {
      const schema = DERIVE_MODEL_SETTINGS[strategy].responseFormat.json_schema as Record<string, unknown>;
      const properties = schema["properties"] as Record<string, unknown>;
      const strategyProperty = properties["strategy"] as Record<string, unknown>;
      expect(strategyProperty["enum"]).toEqual([strategy]);
    }
  });

  it("requires the top-level fields the parser requires, and forbids extras", () => {
    for (const strategy of ["grid", "dca"] as const) {
      const schema = DERIVE_MODEL_SETTINGS[strategy].responseFormat.json_schema as Record<string, unknown>;
      expect(schema["additionalProperties"]).toBe(false);
      expect(schema["required"]).toEqual([
        "strategy",
        "parameters",
        "allocatedCapital",
        "capitalAsset",
        "notes",
      ]);
    }
  });

  it("forbids extra parameters, so the schema and requireExactFields agree", () => {
    for (const strategy of ["grid", "dca"] as const) {
      const schema = DERIVE_MODEL_SETTINGS[strategy].responseFormat.json_schema as Record<string, unknown>;
      const parameters = (schema["properties"] as Record<string, unknown>)["parameters"] as Record<string, unknown>;
      expect(parameters["additionalProperties"]).toBe(false);
      expect(Object.keys(parameters["properties"] as object)).toEqual([
        ...(strategy === "grid" ? GRID_DERIVE_FIELDS : DCA_DERIVE_FIELDS),
      ]);
    }
  });

  it("requires a non-empty citation array on every parameter, in the schema too", () => {
    const schema = DERIVE_MODEL_SETTINGS.grid.responseFormat.json_schema as Record<string, unknown>;
    const parameters = (schema["properties"] as Record<string, unknown>)["parameters"] as Record<string, unknown>;
    const upper = (parameters["properties"] as Record<string, unknown>)["upperBound"] as Record<string, unknown>;
    const citations = (upper["properties"] as Record<string, unknown>)["citations"] as Record<string, unknown>;
    expect(citations["minItems"]).toBe(1);
    expect(upper["required"]).toEqual(["value", "citations"]);
  });
});

describe("the pinned determinism settings", () => {
  it("pins temperature, seed and max_tokens for BOTH strategies", () => {
    for (const strategy of ["grid", "dca"] as const) {
      const settings = DERIVE_MODEL_SETTINGS[strategy];
      expect(settings.temperature).toBe(0);
      expect(settings.seed).toBe(20_260_811);
      expect(settings.maxTokens).toBe(4_096);
      expect(settings.responseFormat.type).toBe("json_schema");
    }
  });

  it("is frozen, so a drift back to defaults fails the suite rather than a proposal", () => {
    expect(Object.isFrozen(DERIVE_MODEL_SETTINGS)).toBe(true);
    expect(Object.isFrozen(DERIVE_MODEL_SETTINGS.grid)).toBe(true);
    expect(Object.isFrozen(DERIVE_MODEL_SETTINGS.dca)).toBe(true);
  });

  it("records the model's documented context window, unchanged from Stage 2's", () => {
    expect(DERIVE_MODEL_CONTEXT_TOKENS).toBe(24_000);
    expect(DERIVE_MODEL).toBe("@cf/meta/llama-3.3-70b-instruct-fp8-fast");
  });

  it("asks for MORE output room than Stage 2, because the answer is structurally bigger", () => {
    // Stage 2 asks for 2,048. A nine-field cited proposal does not fit in that,
    // and an answer cut off mid-object fails closed on EVERY run.
    expect(DERIVE_MODEL_SETTINGS.grid.maxTokens).toBeGreaterThan(2_048);
  });
});

// ---------------------------------------------------------------------------
// Property 1: exactly one call, ever
// ---------------------------------------------------------------------------

describe("zero retries", () => {
  it("calls the model exactly once on success", async () => {
    const { model, calls } = stub(GRID_ANSWER);
    await deriveParameters(model, context(), assessment("grid"));
    expect(calls).toHaveLength(1);
  });

  it("calls the model exactly once when the response is REFUSED by the parser", async () => {
    const { model, calls } = stub({ ...GRID_ANSWER, strategy: "dca" });
    await expect(deriveParameters(model, context(), assessment("grid"))).rejects.toBeInstanceOf(
      DeriveParseError,
    );
    // A retry loop would make this 2 or 3 and the thrown error would look the
    // same. Counting is the only assertion that can tell them apart -- decision
    // log 39's C9.
    expect(calls).toHaveLength(1);
  });

  it("calls the model exactly once when VALIDATION rejects the parameters", async () => {
    const badAnswer = {
      ...GRID_ANSWER,
      parameters: { ...GRID_ANSWER.parameters, stopLossPct: cite("0.00000000", "candles.range_pct") },
    };
    const { model, calls } = stub(badAnswer);
    await expect(deriveParameters(model, context(), assessment("grid"))).rejects.toBeInstanceOf(
      DeriveValidationError,
    );
    expect(calls).toHaveLength(1);
  });

  it("calls the model exactly once when the model itself throws", async () => {
    let count = 0;
    const model: DeriveModel = async () => {
      count += 1;
      throw new Error("transport exploded");
    };
    await expect(deriveParameters(model, context(), assessment("grid"))).rejects.toThrow(
      "transport exploded",
    );
    expect(count).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Property 5: nothing is caught
// ---------------------------------------------------------------------------

describe("nothing is caught, and nothing is degraded", () => {
  it("propagates a transport failure as itself", async () => {
    const boom = new Error("no ai binding");
    const model: DeriveModel = async () => {
      throw boom;
    };
    await expect(deriveParameters(model, context(), assessment("grid"))).rejects.toBe(boom);
  });

  it("propagates a parse refusal with its own code", async () => {
    const { model } = stub("not json at all");
    const error = await deriveParameters(model, context(), assessment("grid")).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DeriveParseError);
    expect((error as DeriveParseError).code).toBe("not_json");
  });

  it("propagates a validation refusal naming the layer that refused", async () => {
    const { model } = stub({
      ...GRID_ANSWER,
      parameters: { ...GRID_ANSWER.parameters, orderSize: cite(50, "capital.row.01.available") },
    });
    const error = await deriveParameters(model, context(), assessment("grid")).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DeriveValidationError);
    expect((error as DeriveValidationError).layer).toBe("decoder");
  });

  it("returns NOTHING when it refuses -- no partial result of any kind", async () => {
    const { model } = stub({ ...GRID_ANSWER, notes: [] });
    let returned: unknown = "NO RESOLVE";
    await deriveParameters(model, context(), assessment("grid")).then(
      (value) => {
        returned = value;
      },
      () => undefined,
    );
    expect(returned).toBe("NO RESOLVE");
  });
});

// ---------------------------------------------------------------------------
// Property 6: the audit trail
// ---------------------------------------------------------------------------

describe("the result", () => {
  it("carries everything 21.5 requirement 5's audit row would need", async () => {
    const ctx = context();
    const assessed = assessment("grid");
    const raw = { response: GRID_ANSWER };
    const model: DeriveModel = async () => ({ text: raw, raw });

    const result = await deriveParameters(model, ctx, assessed);

    expect(result.promptVersion).toBe("derive/1");
    expect(result.promptText.length).toBeGreaterThan(1_000);
    expect(result.model).toBe(DERIVE_MODEL);
    expect(result.settings).toBe(DERIVE_MODEL_SETTINGS.grid);
    expect(result.response.raw).toBe(raw);
    // Both upstream inputs travel by identity, so the whole chain is
    // reconstructable from the result alone.
    expect(result.context).toBe(ctx);
    expect(result.assessment).toBe(assessed);
  });

  it("publishes EVERY evidence item offered, not only the cited ones", async () => {
    const { model } = stub(GRID_ANSWER);
    const result = await deriveParameters(model, context(), assessment("grid"));

    const citedIds = new Set(
      Object.values(result.citations.parameters).flatMap((cited) => cited.citations.map((c) => c.id)),
    );
    // A reader can see what the model IGNORED, which is only visible from the
    // difference between what it was offered and what it used.
    expect(result.evidence.length).toBeGreaterThan(citedIds.size);
    expect(result.evidence.some((item) => !citedIds.has(item.id))).toBe(true);
  });

  it("reports which venue floor actually held, per proposal", async () => {
    const { model } = stub(GRID_ANSWER);
    const result = await deriveParameters(model, context(), assessment("grid"));
    expect(result.minimumOrderCheck).toBe("quantity");
  });

  it("reports the transport shape and the duplicate-key guarantee that held", async () => {
    const { model } = stub(GRID_ANSWER);
    const result = await deriveParameters(model, context(), assessment("grid"));
    expect(result.envelope).toBe("envelope_object");
    expect(result.duplicateKeyCheck).toBe("unavailable_transport_parsed");
  });

  it("produces a fully specified parameter set for DCA too", async () => {
    const { model } = stub(DCA_ANSWER);
    const result = await deriveParameters(model, context(), assessment("dca"));
    expect(result.strategy).toBe("dca");
    if (result.proposal.params.strategy !== "dca") throw new Error("unreachable");
    expect(result.proposal.params.value.maxAdditionalBuys).toBe(2);
    expect(result.proposal.allocatedCapital).toBe(400n * ONE);
    expect(result.proposal.capitalAsset).toBe("USD");
    // Every one of the nine fields carries at least one resolved citation.
    for (const field of DCA_DERIVE_FIELDS) {
      expect(result.citations.parameters[field]!.citations.length).toBeGreaterThan(0);
    }
  });
});

describe("the never-called stub", () => {
  it("is genuinely never reached by any precondition path", async () => {
    await deriveParameters(
      NEVER_CALLED.model,
      context({ capital: { outcome: "failed", error: new ResearchCapitalError("ledger_unreadable", "x"), failedAt: T0 } }),
      assessment("grid"),
    ).catch(() => undefined);
    expect(NEVER_CALLED.calls).toHaveLength(0);
  });
});
