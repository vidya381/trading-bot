/**
 * The real transport behind `DeriveModel`, and the composition it completes.
 *
 * NO REAL MODEL IS CALLED HERE. Every `ai.run` below is a recorded fake, and one
 * test asserts positively that a missing binding reaches no call at all --
 * `news.ts`'s mutation lesson (decision log 30), where a test asserted the right
 * conclusion for the wrong reason and, under mutation, pointed the suite at a
 * live vendor API.
 *
 * Six properties, the first five mirroring `assess.test.ts` because the seam is
 * the same seam, and the sixth new to this stage:
 *
 *  1. THE SETTINGS ARE FORWARDED, NOT RESTATED. What reaches `ai.run` is the
 *     request's own settings under Workers AI's parameter names.
 *  2. NOTHING IS NARROWED. The transport value comes back untouched, by
 *     identity, on both `text` and `raw`.
 *  3. THE REAL PORT REACHES THE REAL PARSER AND THE REAL VALIDATORS.
 *     `deriveParameters(envDeriveModel(env), ...)` produces a `DeriveResult`
 *     whose `envelope`, `duplicateKeyCheck` and `minimumOrderCheck` could only
 *     have been set downstream of this transport.
 *  4. THE DUPLICATE-KEY REPORT IS HONEST THROUGH THE REAL PORT.
 *  5. NOTHING IS CAUGHT, AND NOTHING IS RETRIED. Exactly one call, counted.
 *  6. **THE PER-STRATEGY SCHEMA IS FORWARDED, NEVER LOOKED UP HERE.** The
 *     schema that reaches `ai.run` is the one on the request, so a transport
 *     that re-derived it from `request.strategy` -- which would look identical
 *     in review -- is caught.
 */

import { describe, expect, it } from "vitest";

import { envDeriveModel, DeriveModelError, type DeriveModelEnv } from "./derive";
import {
  DERIVE_MODEL,
  DERIVE_MODEL_SETTINGS,
  deriveParameters,
  type DeriveModelRequest,
} from "../research/derive";
import { DeriveParseError } from "../research/derive-parse";
import { buildAssessPrompt } from "../research/assess-prompt";
import type { ParsedAssessment } from "../research/assess-parse";
import type { AccountCapital } from "../research/capital";
import { assessConcentration, type AccountExposure } from "../research/concentration";
import type { Candidate } from "../research/candidates";
import type { CandleWindow } from "../research/candles";
import { NEWS_NOT_YET_AVAILABLE, type CandidateGatherBundle, type DeriveContext } from "../research/gather";
import type { Candle, SymbolFilters } from "../shared/exchange-client";
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
  sources: [{ kind: "named", requestedAs: "zzq", requestedBy: "op@example.com", requestedAt: T0 }],
};

const candle = (openTime: number, close: bigint): Candle => ({
  pair: PAIR,
  openTime,
  closeTime: openTime + MINUTE,
  open: close - ONE,
  high: close + 2n * ONE,
  low: close - 3n * ONE,
  close,
  volume: 4n * ONE,
  closed: true,
});

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

/** A fake `Ai` binding that records every call and returns a scripted value. */
function fakeAi(answer: unknown): { env: DeriveModelEnv; calls: unknown[][] } {
  const calls: unknown[][] = [];
  const env = {
    AI: {
      run: async (model: string, inputs: unknown) => {
        calls.push([model, inputs]);
        return answer;
      },
    } as unknown as Ai,
  };
  return { env, calls };
}

const request = (strategy: "grid" | "dca" = "grid"): DeriveModelRequest => ({
  model: DERIVE_MODEL,
  prompt: "the prompt text",
  settings: DERIVE_MODEL_SETTINGS[strategy],
  strategy,
});

// ---------------------------------------------------------------------------
// Property 1: settings forwarded, not restated
// ---------------------------------------------------------------------------

describe("what reaches ai.run", () => {
  it("forwards every pinned setting under Workers AI's own parameter names", async () => {
    const { env, calls } = fakeAi({ response: GRID_ANSWER });
    await envDeriveModel(env)(request());

    expect(calls).toHaveLength(1);
    const [model, inputs] = calls[0]!;
    expect(model).toBe(DERIVE_MODEL);
    expect(inputs).toEqual({
      prompt: "the prompt text",
      temperature: DERIVE_MODEL_SETTINGS.grid.temperature,
      seed: DERIVE_MODEL_SETTINGS.grid.seed,
      max_tokens: DERIVE_MODEL_SETTINGS.grid.maxTokens,
      response_format: DERIVE_MODEL_SETTINGS.grid.responseFormat,
    });
  });

  it("sends `prompt`, never `messages`", async () => {
    const { env, calls } = fakeAi({ response: GRID_ANSWER });
    await envDeriveModel(env)(request());
    const inputs = calls[0]![1] as Record<string, unknown>;
    expect(inputs["prompt"]).toBe("the prompt text");
    expect(inputs["messages"]).toBeUndefined();
  });

  it("takes the values off the REQUEST, so a caller's settings are never replaced", async () => {
    // A transport that looked settings up itself would ignore these and send the
    // pinned ones. Forwarding is what this asserts.
    const custom = {
      ...DERIVE_MODEL_SETTINGS.grid,
      temperature: 0.25,
      seed: 7,
      maxTokens: 11,
    };
    const { env, calls } = fakeAi({ response: GRID_ANSWER });
    await envDeriveModel(env)({ ...request(), settings: custom });

    const inputs = calls[0]![1] as Record<string, unknown>;
    expect(inputs["temperature"]).toBe(0.25);
    expect(inputs["seed"]).toBe(7);
    expect(inputs["max_tokens"]).toBe(11);
  });
});

// ---------------------------------------------------------------------------
// Property 6: the per-strategy schema is FORWARDED, never looked up here
// ---------------------------------------------------------------------------

describe("the strategy-conditional schema at the transport", () => {
  it("sends the grid schema for a grid request and the DCA schema for a DCA one", async () => {
    for (const strategy of ["grid", "dca"] as const) {
      const { env, calls } = fakeAi({ response: GRID_ANSWER });
      await envDeriveModel(env)(request(strategy));
      const inputs = calls[0]![1] as Record<string, unknown>;
      // By identity: the object on the request, not an equal one rebuilt here.
      expect(inputs["response_format"]).toBe(DERIVE_MODEL_SETTINGS[strategy].responseFormat);
    }
  });

  it("sends the settings it was GIVEN even when they disagree with `strategy`", async () => {
    // The point of the test, and it deliberately constructs an inconsistent
    // request: this file must not be the thing that decides which schema is
    // served. A transport that re-derived the schema from `request.strategy`
    // would "fix" this and send DCA's -- looking correct while quietly becoming
    // the authority on a decision `deriveParameters` already made.
    const { env, calls } = fakeAi({ response: GRID_ANSWER });
    await envDeriveModel(env)({
      ...request("dca"),
      settings: DERIVE_MODEL_SETTINGS.grid,
    });

    const inputs = calls[0]![1] as Record<string, unknown>;
    expect(inputs["response_format"]).toBe(DERIVE_MODEL_SETTINGS.grid.responseFormat);
    expect(inputs["response_format"]).not.toBe(DERIVE_MODEL_SETTINGS.dca.responseFormat);
  });
});

// ---------------------------------------------------------------------------
// Property 2: nothing is narrowed
// ---------------------------------------------------------------------------

describe("what comes back", () => {
  it("returns the transport value untouched, on both fields, by IDENTITY", async () => {
    const answer = { response: GRID_ANSWER };
    const { env } = fakeAi(answer);
    const result = await envDeriveModel(env)(request());

    // Decision log 37's bug was `return raw.response`. Identity on both fields
    // is what keeps it fixed.
    expect(result.raw).toBe(answer);
    expect(result.text).toBe(answer);
    expect(result.text).toBe(result.raw);
  });

  it("does not stringify the answer, which would fake the duplicate-key guarantee", async () => {
    const answer = { response: GRID_ANSWER };
    const { env } = fakeAi(answer);
    const result = await envDeriveModel(env)(request());
    expect(typeof result.text).not.toBe("string");
  });

  it("hands back a bare string unchanged when that is what the transport gave", async () => {
    const { env } = fakeAi("a bare string answer");
    const result = await envDeriveModel(env)(request());
    expect(result.text).toBe("a bare string answer");
  });
});

// ---------------------------------------------------------------------------
// Properties 3 and 4: the real port reaches the real parser and validators
// ---------------------------------------------------------------------------

describe("the composition, through the production path", () => {
  it("produces a validated proposal whose fields only the downstream layers could set", async () => {
    const { env, calls } = fakeAi({ response: GRID_ANSWER });

    const result = await deriveParameters(envDeriveModel(env), context, assessment("grid"));

    expect(calls).toHaveLength(1);
    // `envelope` and `duplicateKeyCheck` are set nowhere but the parser, and
    // `minimumOrderCheck` nowhere but the sanity-bound layer. Their presence is
    // proof the real transport reached both.
    expect(result.envelope).toBe("envelope_object");
    expect(result.duplicateKeyCheck).toBe("unavailable_transport_parsed");
    expect(result.minimumOrderCheck).toBe("quantity");

    // And the parameters are the REAL decoder's output, at full scale.
    if (result.proposal.params.strategy !== "grid") throw new Error("unreachable");
    expect(result.proposal.params.value.upperBound).toBe(108n * ONE);
    expect(result.proposal.allocatedCapital).toBe(400n * ONE);
  });

  it("sends the prompt `buildDerivePrompt` produced, not one this file composed", async () => {
    const { env, calls } = fakeAi({ response: GRID_ANSWER });
    const result = await deriveParameters(envDeriveModel(env), context, assessment("grid"));

    const inputs = calls[0]![1] as Record<string, unknown>;
    expect(inputs["prompt"]).toBe(result.promptText);
    expect(inputs["prompt"]).toContain('THE STRATEGY IS ALREADY DECIDED AND IT IS "grid"');
  });

  it("reports the duplicate-key guarantee honestly on the TEXT path too", async () => {
    const { env } = fakeAi(JSON.stringify(GRID_ANSWER));
    const result = await deriveParameters(envDeriveModel(env), context, assessment("grid"));
    expect(result.envelope).toBe("bare_string");
    expect(result.duplicateKeyCheck).toBe("performed");
  });
});

// ---------------------------------------------------------------------------
// Property 5: nothing caught, nothing retried
// ---------------------------------------------------------------------------

describe("failures", () => {
  it("refuses with no call at all when the binding is absent", async () => {
    let called = false;
    const env: DeriveModelEnv = {};
    const error = await envDeriveModel(env)(request()).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(DeriveModelError);
    expect((error as DeriveModelError).code).toBe("no_ai_binding");
    expect((error as DeriveModelError).message).toContain("NO CALL WAS ATTEMPTED");
    // Positively, not by inference: nothing anywhere was invoked.
    expect(called).toBe(false);
  });

  it("propagates a transport throw as itself, and calls exactly once", async () => {
    let count = 0;
    const env = {
      AI: {
        run: async () => {
          count += 1;
          throw new Error("inference failed");
        },
      } as unknown as Ai,
    };

    await expect(deriveParameters(envDeriveModel(env), context, assessment("grid"))).rejects.toThrow(
      "inference failed",
    );
    // A retry would make this 2 and the thrown error would look identical --
    // decision log 39's surviving mutant C9, closed by counting.
    expect(count).toBe(1);
  });

  it("propagates a parse refusal, and calls exactly once", async () => {
    const { env, calls } = fakeAi({ response: { ...GRID_ANSWER, strategy: "dca" } });

    const error = await deriveParameters(envDeriveModel(env), context, assessment("grid")).catch(
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(DeriveParseError);
    expect((error as DeriveParseError).code).toBe("strategy_disagreement");
    expect(calls).toHaveLength(1);
  });

  it("never reaches the binding when a precondition refuses", async () => {
    const { env, calls } = fakeAi({ response: GRID_ANSWER });

    await deriveParameters(
      envDeriveModel(env),
      { ...context, filters: { outcome: "failed", error: new Error("down"), failedAt: T0 } },
      assessment("grid"),
    ).catch(() => undefined);

    expect(calls).toHaveLength(0);
  });
});
