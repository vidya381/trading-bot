/**
 * The Assess runner, exercised end to end against a FAKE model.
 *
 * There is no real model behind `AssessModel` anywhere in this repository, and
 * this file does not create one. Every "model" below is a recorded stub: it
 * captures the request it was handed and returns a string a human wrote. THE
 * SUITE MAKES NO NETWORK CALL AND NO WORKERS AI CALL, and two tests assert that
 * positively by counting invocations rather than by inspecting results --
 * `news.ts`'s mutation lesson (decision log 30), where a test asserted the right
 * conclusion for the wrong reason and, under mutation, pointed the suite at a
 * live vendor API.
 *
 * Five properties:
 *
 *  1. THE MODEL SEES THE PROMPT AND NOTHING ELSE. The request is exactly the
 *     model id, the built prompt text and the pinned settings -- no bundle, no
 *     account, no hidden context.
 *  2. THE DETERMINISM SETTINGS ARE PINNED, not defaulted. `temperature: 0` and a
 *     fixed `seed` are asserted by value, because the documented defaults (0.6,
 *     none) are exactly the ones that would make two runs on one coin disagree.
 *  3. A BUNDLE WITH NO PRICE HISTORY NEVER REACHES THE MODEL. The refusal
 *     happens first and spends nothing.
 *  4. NOTHING IS CAUGHT. A model that throws and a response the parser refuses
 *     both come out of `assessCandidate` as themselves. There is no default
 *     strategy, no retry, no degraded result.
 *  5. THE RESULT IS AUDITABLE. Prompt text, every evidence item offered (not
 *     only the cited ones), the raw response and the bundle itself all travel
 *     with the conclusion (21.5 requirements 2 and 5).
 */

import { describe, expect, it } from "vitest";

import {
  ASSESS_MODEL,
  ASSESS_MODEL_SETTINGS,
  AssessError,
  assessCandidate,
  type AssessModel,
  type AssessModelRequest,
} from "./assess";
import { ASSESS_RESPONSE_SCHEMA, AssessParseError } from "./assess-parse";
import { ASSESS_STRATEGIES, buildAssessPrompt } from "./assess-prompt";
import { CandleWindowError } from "./candles";
import { ConcentrationError, assessConcentration, type AccountExposure } from "./concentration";
import type { Candidate } from "./candidates";
import { NEWS_NOT_YET_AVAILABLE, type CandidateGatherBundle } from "./gather";
import type { Candle } from "../shared/exchange-client";
import { ONE } from "../shared/money";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const T0 = 1_930_000_000_000;
const MINUTE = 60_000;
const PAIR = "ZZQUSD";

const candidate: Candidate = {
  accountLabel: "gemini-main",
  exchange: "gemini",
  pair: PAIR,
  sources: [{ kind: "named", requestedAs: "ZZQUSD", requestedBy: "operator@example.com", requestedAt: T0 }],
};

const candles: Candle[] = Array.from({ length: 30 }, (_unused, index) => ({
  pair: PAIR,
  openTime: T0 + index * MINUTE,
  closeTime: T0 + (index + 1) * MINUTE,
  open: BigInt(100 + index) * ONE,
  high: BigInt(102 + index) * ONE,
  low: BigInt(97 + index) * ONE,
  close: BigInt(101 + index) * ONE,
  volume: 4n * ONE,
  closed: true,
}));

const exposure: AccountExposure = {
  accountLabel: candidate.accountLabel,
  readAt: T0,
  rowsRead: 1,
  committed: [
    { id: "b-1", pair: "AAAUSD", capitalAsset: "USD", allocatedCapital: 50n * ONE, status: "running", archived: false },
  ],
  stopped: [],
  quoteAssetsObserved: ["USD"],
};

function bundle(overrides: Partial<CandidateGatherBundle> = {}): CandidateGatherBundle {
  return {
    candidate,
    candles: {
      outcome: "ok",
      value: {
        accountLabel: candidate.accountLabel,
        exchange: "gemini",
        pair: PAIR,
        interval: "1m",
        candles,
        fetchedAt: T0 + 30 * MINUTE,
        requestedSince: null,
        earliestOpenTime: candles[0]!.openTime,
        earliestCloseTime: candles[0]!.closeTime,
        latestCloseTime: candles[candles.length - 1]!.closeTime,
        truncated: false,
        missingHistoryMs: null,
      },
    },
    news: NEWS_NOT_YET_AVAILABLE,
    concentration: { outcome: "ok", value: assessConcentration(exposure, candidate) },
    assembledAt: T0 + 31 * MINUTE,
    ...overrides,
  };
}

const CLEAN_RESPONSE = JSON.stringify({
  strategy: "grid",
  claims: [
    { statement: "The window's range is wide relative to its close.", citations: ["candles.range_pct"] },
    { statement: "Only thirty minutes of history was returned.", citations: ["candles.count", "candles.earliest_close"] },
  ],
});

/** A model that records every call and answers with whatever it was given. */
function stubModel(answer: string | (() => never)) {
  const calls: AssessModelRequest[] = [];
  const model: AssessModel = async (request) => {
    calls.push(request);
    if (typeof answer !== "string") answer();
    return { text: answer, raw: { response: answer } };
  };
  return { model, calls };
}

// ---------------------------------------------------------------------------
// Property 1 and 5
// ---------------------------------------------------------------------------

describe("a successful assessment", () => {
  it("sends exactly the built prompt, the pinned model and the pinned settings", async () => {
    const input = bundle();
    const { model, calls } = stubModel(CLEAN_RESPONSE);

    await assessCandidate(model, input);

    expect(calls).toHaveLength(1);
    expect(Object.keys(calls[0]!).sort()).toEqual(["model", "prompt", "settings"]);
    expect(calls[0]!.model).toBe(ASSESS_MODEL);
    expect(calls[0]!.prompt).toBe(buildAssessPrompt(input).promptText);
    expect(calls[0]!.settings).toBe(ASSESS_MODEL_SETTINGS);
  });

  it("returns the strategy with its claims resolved to real evidence", async () => {
    const input = bundle();
    const { model } = stubModel(CLEAN_RESPONSE);

    const result = await assessCandidate(model, input);

    expect(result.strategy).toBe("grid");
    expect(result.claims).toHaveLength(2);
    expect(result.claims[0].citations[0].id).toBe("candles.range_pct");
    expect(result.claims[0].citations[0].value).toBe(
      buildAssessPrompt(input).evidence.find((item) => item.id === "candles.range_pct")!.value,
    );
  });

  it("carries the whole audit trail: prompt, ALL evidence, raw response, bundle", async () => {
    const input = bundle();
    const { model } = stubModel(CLEAN_RESPONSE);

    const result = await assessCandidate(model, input);

    expect(result.promptVersion).toBe(buildAssessPrompt(input).version);
    expect(result.promptText).toBe(buildAssessPrompt(input).promptText);
    expect(result.model).toBe(ASSESS_MODEL);
    expect(result.settings).toBe(ASSESS_MODEL_SETTINGS);
    expect(result.response.text).toBe(CLEAN_RESPONSE);
    expect(result.response.raw).toEqual({ response: CLEAN_RESPONSE });
    // The bundle by identity, so the raw candles and provenance travel with it.
    expect(result.bundle).toBe(input);

    // Everything the model was OFFERED, not only what it cited -- what it
    // ignored is a fact only visible from the difference.
    const cited = new Set(result.claims.flatMap((claim) => claim.citations.map((item) => item.id)));
    expect(result.evidence.length).toBeGreaterThan(cited.size);
    expect(result.evidence.some((item) => item.id === "concentration.status")).toBe(true);
  });

  it("accepts the REAL observed Workers AI envelope, and records which guarantees held", async () => {
    // The exact shape the first live probe returned: `.response` is an
    // already-parsed object, not the string Cloudflare's type declares.
    const model: AssessModel = async () => {
      const raw = {
        response: {
          strategy: "grid",
          claims: [{ statement: "The range is wide relative to the close.", citations: ["candles.range_pct"] }],
        },
        usage: { prompt_tokens: 4001, completion_tokens: 180, total_tokens: 4181 },
      };
      return { text: raw.response, raw };
    };

    const result = await assessCandidate(model, bundle());

    expect(result.strategy).toBe("grid");
    expect(result.claims[0].citations[0].id).toBe("candles.range_pct");
    expect(result.envelope).toBe("bare_object");
    // The honest half: on this path the duplicate-key protection could not run.
    expect(result.duplicateKeyCheck).toBe("unavailable_transport_parsed");
  });

  it("records that the duplicate-key protection DID run when the answer is text", async () => {
    const { model } = stubModel(CLEAN_RESPONSE);
    const result = await assessCandidate(model, bundle());
    expect(result.envelope).toBe("bare_string");
    expect(result.duplicateKeyCheck).toBe("performed");
  });

  it("sends a byte-identical prompt for the same bundle twice", async () => {
    const input = bundle();
    const { model, calls } = stubModel(CLEAN_RESPONSE);

    await assessCandidate(model, input);
    await assessCandidate(model, input);

    expect(calls[0]!.prompt).toBe(calls[1]!.prompt);
    expect(calls[0]!.settings).toBe(calls[1]!.settings);
  });
});

// ---------------------------------------------------------------------------
// Property 2: the determinism settings
// ---------------------------------------------------------------------------

describe("the determinism settings", () => {
  it("pins temperature to 0 rather than the documented default of 0.6", () => {
    expect(ASSESS_MODEL_SETTINGS.temperature).toBe(0);
  });

  it("pins a fixed seed inside the documented range", () => {
    expect(ASSESS_MODEL_SETTINGS.seed).toBe(20_260_811);
    expect(ASSESS_MODEL_SETTINGS.seed).toBeGreaterThanOrEqual(1);
    expect(ASSESS_MODEL_SETTINGS.seed).toBeLessThanOrEqual(9_999_999_999);
  });

  it("raises max_tokens above the documented default of 256", () => {
    // A cited answer over a two-dozen-item evidence table does not fit 256, and
    // a cut-off answer is not valid JSON -- which fails closed, but on every run.
    expect(ASSESS_MODEL_SETTINGS.maxTokens).toBeGreaterThan(256);
  });

  it("requests a JSON schema, and the schema matches what the parser enforces", () => {
    expect(ASSESS_MODEL_SETTINGS.responseFormat.type).toBe("json_schema");
    expect(ASSESS_MODEL_SETTINGS.responseFormat.json_schema).toBe(ASSESS_RESPONSE_SCHEMA);
    expect(ASSESS_RESPONSE_SCHEMA.properties.strategy.enum).toEqual([...ASSESS_STRATEGIES]);
    expect(ASSESS_RESPONSE_SCHEMA.additionalProperties).toBe(false);
    expect(ASSESS_RESPONSE_SCHEMA.required).toEqual(["strategy", "claims"]);
  });

  it("is frozen, so one run cannot alter another's settings", () => {
    expect(Object.isFrozen(ASSESS_MODEL_SETTINGS)).toBe(true);
    expect(Object.isFrozen(ASSESS_MODEL_SETTINGS.responseFormat)).toBe(true);
  });

  it("pins the model id, so changing it is a deliberate edit", () => {
    expect(ASSESS_MODEL).toBe("@cf/meta/llama-3.3-70b-instruct-fp8-fast");
  });
});

// ---------------------------------------------------------------------------
// Property 3: no price history never reaches the model
// ---------------------------------------------------------------------------

describe("the price-history precondition", () => {
  it("refuses a failed candle fetch WITHOUT calling the model", async () => {
    const { model, calls } = stubModel(CLEAN_RESPONSE);
    const input = bundle({
      candles: {
        outcome: "failed",
        error: new CandleWindowError("candles_unavailable", "the venue did not answer"),
        failedAt: T0,
      },
    });

    await expect(assessCandidate(model, input)).rejects.toThrow(AssessError);
    await expect(assessCandidate(model, input)).rejects.toThrow(/no usable price history/);
    expect(calls, "the model was called for a bundle with no prices").toHaveLength(0);
  });

  it("refuses a raw throw beneath the candle fetch, without calling the model", async () => {
    const { model, calls } = stubModel(CLEAN_RESPONSE);
    const input = bundle({ candles: { outcome: "threw_unexpectedly", error: new TypeError("d1"), failedAt: T0 } });

    await expect(assessCandidate(model, input)).rejects.toMatchObject({ code: "no_price_history" });
    expect(calls).toHaveLength(0);
  });

  it("refuses an ok-but-empty window, without calling the model", async () => {
    const { model, calls } = stubModel(CLEAN_RESPONSE);
    const ok = bundle().candles;
    if (ok.outcome !== "ok") throw new Error("fixture is not an ok window");
    const input = bundle({ candles: { outcome: "ok", value: { ...ok.value, candles: [] } } });

    await expect(assessCandidate(model, input)).rejects.toMatchObject({ code: "no_price_history" });
    expect(calls).toHaveLength(0);
  });

  it("names the pair and the reason, so the refusal is readable in a log", async () => {
    const { model } = stubModel(CLEAN_RESPONSE);
    const input = bundle({
      candles: { outcome: "failed", error: new CandleWindowError("pair_not_tradable", "not listed"), failedAt: T0 },
    });

    await expect(assessCandidate(model, input)).rejects.toThrow(new RegExp(PAIR));
    await expect(assessCandidate(model, input)).rejects.toThrow(/requirement 1 forbids/);
  });

  it("does NOT block on a failed concentration read -- that is context, not the question", async () => {
    const { model, calls } = stubModel(CLEAN_RESPONSE);
    const input = bundle({
      concentration: {
        outcome: "failed",
        error: new ConcentrationError("bot_list_unreadable", "D1 refused the read"),
        failedAt: T0,
      },
    });

    const result = await assessCandidate(model, input);

    expect(result.strategy).toBe("grid");
    expect(calls).toHaveLength(1);
    // ... and the model was told it was missing, rather than not told at all.
    expect(calls[0]!.prompt).toContain("bot_list_unreadable");
  });

  it("does NOT block on the paused news slot", async () => {
    const { model, calls } = stubModel(CLEAN_RESPONSE);
    await assessCandidate(model, bundle());
    expect(calls[0]!.prompt).toContain("NOT COLLECTED");
  });
});

// ---------------------------------------------------------------------------
// Property 4: nothing is caught, nothing is defaulted
// ---------------------------------------------------------------------------

describe("failures propagate", () => {
  it("lets a refused response throw out of the runner, with no fallback strategy", async () => {
    const { model } = stubModel("Sure! I'd go with a grid here.");
    await expect(assessCandidate(model, bundle())).rejects.toThrow(AssessParseError);
  });

  it("refuses a response whose citations are invented, rather than dropping them", async () => {
    const { model } = stubModel(
      JSON.stringify({ strategy: "dca", claims: [{ statement: "RSI is low.", citations: ["candles.rsi_14"] }] }),
    );
    await expect(assessCandidate(model, bundle())).rejects.toMatchObject({ code: "citation_unknown" });
  });

  it("calls the model EXACTLY ONCE on a refused response -- there is no retry", async () => {
    // The deliberate design, argued in assess.ts: "retry until it parses" is
    // fail-closed converted into fail-open, because the accepted answer becomes
    // the one selected for passing the validator rather than the one given.
    const { model, calls } = stubModel("Sure! I'd go with a grid here.");

    await expect(assessCandidate(model, bundle())).rejects.toThrow(AssessParseError);

    expect(calls, "the runner sampled the model more than once").toHaveLength(1);
  });

  it("calls the model exactly once on an ungrounded citation too", async () => {
    const { model, calls } = stubModel(
      JSON.stringify({ strategy: "grid", claims: [{ statement: "x", citations: ["candles.made_up"] }] }),
    );

    await expect(assessCandidate(model, bundle())).rejects.toMatchObject({ code: "citation_unknown" });

    expect(calls).toHaveLength(1);
  });

  it("lets a model implementation's own error through unchanged", async () => {
    const boom = new Error("Workers AI returned 429");
    const model: AssessModel = async () => {
      throw boom;
    };
    await expect(assessCandidate(model, bundle())).rejects.toBe(boom);
  });

  it("refuses a transport value that is not a recognised envelope", async () => {
    const model: AssessModel = async () => ({ text: 42, raw: null });
    await expect(assessCandidate(model, bundle())).rejects.toMatchObject({ code: "envelope_unrecognised" });
  });

  it("refuses an envelope whose text is not the JSON contract, even wrapped", async () => {
    // `{response: "grid"}` is a well-formed envelope carrying a badly-formed
    // answer. The envelope fix must not make the CONTENT any more acceptable.
    const model: AssessModel = async () => ({ text: { response: "grid" }, raw: null });
    await expect(assessCandidate(model, bundle())).rejects.toMatchObject({ code: "not_json" });
  });
});
