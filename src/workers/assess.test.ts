/**
 * The real transport behind `AssessModel`, and the composition it completes.
 *
 * NO REAL MODEL IS CALLED HERE. Every `ai.run` below is a recorded fake, and one
 * test asserts positively that a missing binding reaches no call at all --
 * `news.ts`'s mutation lesson (decision log 30), where a test asserted the right
 * conclusion for the wrong reason and, under mutation, pointed the suite at a
 * live vendor API. The one real call this step made was run once, by hand, from
 * temporary scaffolding that no longer exists; it is recorded in the session
 * notes, not here.
 *
 * Five properties:
 *
 *  1. THE SETTINGS ARE FORWARDED, NOT RESTATED. What reaches `ai.run` is
 *     `ASSESS_MODEL_SETTINGS` under Workers AI's own parameter names. A second
 *     copy of `temperature: 0` in the transport would be a second thing to keep
 *     in step.
 *  2. NOTHING IS NARROWED. The transport value comes back untouched, by
 *     identity, on both `text` and `raw`. Decision log 37's live probe found the
 *     bug that narrowing here causes, and this is the test that keeps it fixed.
 *  3. THE REAL PORT REACHES THE REAL PARSER. `assessCandidate(envAssessModel(env), bundle)`
 *     produces an `AssessResult` whose `envelope` and `duplicateKeyCheck` could
 *     only have been set by `parseAssessResponse`. That is the composition
 *     traced through the production path rather than asserted about it.
 *  4. THE DUPLICATE-KEY REPORT IS HONEST THROUGH THE REAL PORT. An object
 *     envelope must report `unavailable_transport_parsed`. A transport that
 *     stringified the answer would make it say `performed` for a scan over bytes
 *     this system generated -- the "theatre" failure, reintroduced one layer
 *     below where `assess-parse.test.ts` could see it.
 *  5. NOTHING IS CAUGHT, AND NOTHING IS RETRIED. One call per assessment, and
 *     transport errors and parse refusals both propagate as themselves.
 */

import { describe, expect, it } from "vitest";

import { envAssessModel, AssessModelError, type AssessModelEnv } from "./assess";
import {
  ASSESS_MODEL,
  ASSESS_MODEL_SETTINGS,
  assessCandidate,
} from "../research/assess";
import { AssessParseError } from "../research/assess-parse";
import { assessConcentration, type AccountExposure } from "../research/concentration";
import type { Candidate } from "../research/candidates";
import { NEWS_NOT_YET_AVAILABLE, type CandidateGatherBundle } from "../research/gather";
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
  sources: [{ kind: "named", requestedAs: PAIR, requestedBy: "operator@example.com", requestedAt: T0 }],
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

const bundle: CandidateGatherBundle = {
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
};

/** The answer, in the shape a real call really returns (decision log 37). */
const REAL_ANSWER = {
  strategy: "grid",
  claims: [
    { statement: "The high-to-low range is wide relative to the last close.", citations: ["candles.range_pct"] },
    { statement: "Only thirty candles of history were returned.", citations: ["candles.count"] },
  ],
};

/** A recorded fake binding. Never touches the network. */
function fakeAi(answer: unknown | (() => never)) {
  const calls: Array<{ model: unknown; inputs: Record<string, unknown> }> = [];
  const env: AssessModelEnv = {
    AI: {
      async run(model: unknown, inputs: Record<string, unknown>) {
        calls.push({ model, inputs });
        if (typeof answer === "function") (answer as () => never)();
        return answer;
      },
    } as unknown as Ai,
  };
  return { env, calls };
}

// ---------------------------------------------------------------------------
// Properties 1 and 2: forwarded, not restated; nothing narrowed
// ---------------------------------------------------------------------------

describe("envAssessModel", () => {
  it("forwards the pinned settings under Workers AI's own parameter names", async () => {
    const { env, calls } = fakeAi({ response: REAL_ANSWER });

    await envAssessModel(env)({
      model: ASSESS_MODEL,
      prompt: "PROMPT TEXT",
      settings: ASSESS_MODEL_SETTINGS,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.model).toBe(ASSESS_MODEL);
    expect(calls[0]!.inputs).toEqual({
      prompt: "PROMPT TEXT",
      temperature: 0,
      seed: 20_260_811,
      max_tokens: 2048,
      response_format: ASSESS_MODEL_SETTINGS.responseFormat,
    });
    // The response_format object itself, not a copy -- so the schema the parser
    // enforces and the schema the model is asked for cannot drift.
    expect(calls[0]!.inputs["response_format"]).toBe(ASSESS_MODEL_SETTINGS.responseFormat);
  });

  it("sends no `messages`, no `stream`, and nothing the settings did not name", async () => {
    const { env, calls } = fakeAi({ response: REAL_ANSWER });
    await envAssessModel(env)({ model: ASSESS_MODEL, prompt: "P", settings: ASSESS_MODEL_SETTINGS });

    expect(Object.keys(calls[0]!.inputs).sort()).toEqual([
      "max_tokens",
      "prompt",
      "response_format",
      "seed",
      "temperature",
    ]);
  });

  it("returns the transport value UNNARROWED, by identity, on both fields", async () => {
    const envelope = { response: REAL_ANSWER, usage: { prompt_tokens: 4001 } };
    const { env } = fakeAi(envelope);

    const result = await envAssessModel(env)({
      model: ASSESS_MODEL,
      prompt: "P",
      settings: ASSESS_MODEL_SETTINGS,
    });

    // NOT `.response`. Extracting it here is the bug the live probe found.
    expect(result.text).toBe(envelope);
    expect(result.raw).toBe(envelope);
  });

  it("refuses without an `ai` binding, and attempts no call", async () => {
    const { calls } = fakeAi({ response: REAL_ANSWER });
    const model = envAssessModel({});

    await expect(
      model({ model: ASSESS_MODEL, prompt: "P", settings: ASSESS_MODEL_SETTINGS }),
    ).rejects.toBeInstanceOf(AssessModelError);
    await expect(
      model({ model: ASSESS_MODEL, prompt: "P", settings: ASSESS_MODEL_SETTINGS }),
    ).rejects.toMatchObject({ code: "no_ai_binding" });

    expect(calls, "a model call was attempted with no binding").toHaveLength(0);
  });

  it("says plainly that no call was attempted, rather than implying an outage", async () => {
    await expect(
      envAssessModel({})({ model: ASSESS_MODEL, prompt: "P", settings: ASSESS_MODEL_SETTINGS }),
    ).rejects.toThrow(/NO CALL WAS ATTEMPTED/);
  });
});

// ---------------------------------------------------------------------------
// Properties 3, 4 and 5: the composition, through the production path
// ---------------------------------------------------------------------------

describe("the real port composed with the real pipeline", () => {
  it("produces a full AssessResult end to end, with the parser's own fields set", async () => {
    const { env, calls } = fakeAi({ response: REAL_ANSWER });

    const result = await assessCandidate(envAssessModel(env), bundle);

    expect(result.strategy).toBe("grid");
    expect(result.claims).toHaveLength(2);
    // Citations resolved to real EvidenceItems -- only parseAssessResponse does this.
    expect(result.claims[0].citations[0].id).toBe("candles.range_pct");
    expect(result.claims[0].citations[0].value).not.toBe("");
    // Audit fields, carried by assessCandidate.
    expect(result.model).toBe(ASSESS_MODEL);
    expect(result.settings).toBe(ASSESS_MODEL_SETTINGS);
    expect(result.bundle).toBe(bundle);
    // And the prompt that was actually sent is the prompt on the result.
    expect(calls[0]!.inputs["prompt"]).toBe(result.promptText);
  });

  it("reports the OBSERVED envelope shape through the real port", async () => {
    const { env } = fakeAi({ response: REAL_ANSWER });
    const result = await assessCandidate(envAssessModel(env), bundle);

    // `envelope_object` is only reachable if the transport handed the whole
    // envelope over and `unwrapModelEnvelope` did the narrowing.
    expect(result.envelope).toBe("envelope_object");
  });

  it("reports the duplicate-key check as UNAVAILABLE for an object envelope", async () => {
    const { env } = fakeAi({ response: REAL_ANSWER });
    const result = await assessCandidate(envAssessModel(env), bundle);

    // The honest answer, and the one a transport that stringified the answer
    // would silently turn into "performed" for bytes we generated ourselves.
    expect(result.duplicateKeyCheck).toBe("unavailable_transport_parsed");
  });

  it("still reports `performed` when a transport really does return text", async () => {
    const { env } = fakeAi({ response: JSON.stringify(REAL_ANSWER) });
    const result = await assessCandidate(envAssessModel(env), bundle);

    expect(result.envelope).toBe("envelope_string");
    expect(result.duplicateKeyCheck).toBe("performed");
  });

  it("applies the parser's content rules through the real port, unchanged", async () => {
    const { env } = fakeAi({ response: { strategy: "GRID", claims: REAL_ANSWER.claims } });

    await expect(assessCandidate(envAssessModel(env), bundle)).rejects.toMatchObject({
      code: "strategy_not_recognised",
    });
  });

  it("refuses an invented citation through the real port", async () => {
    const { env } = fakeAi({
      response: { strategy: "dca", claims: [{ statement: "RSI is low.", citations: ["candles.rsi_14"] }] },
    });

    await expect(assessCandidate(envAssessModel(env), bundle)).rejects.toMatchObject({
      code: "citation_unknown",
    });
  });

  it("calls the model EXACTLY ONCE on a refusal -- no retry through the real port", async () => {
    const { env, calls } = fakeAi({ response: "not the contract" });

    await expect(assessCandidate(envAssessModel(env), bundle)).rejects.toBeInstanceOf(AssessParseError);

    expect(calls, "the transport sampled the model more than once").toHaveLength(1);
  });

  it("lets a transport error propagate unchanged, and does not retry it", async () => {
    // The call COUNT is the assertion that matters here, not just the error.
    // Without it, a transport that quietly retried a thrown call would still
    // propagate the same error object and look identical -- which is exactly
    // what a mutation run found surviving. Zero retries is a decision (log 37);
    // a retry on a *transport* failure is the same fail-open as a retry on a
    // parse refusal, just harder to see.
    let calls = 0;
    const boom = new Error("Workers AI returned 429");
    const env: AssessModelEnv = {
      AI: {
        async run() {
          calls += 1;
          throw boom;
        },
      } as unknown as Ai,
    };

    await expect(assessCandidate(envAssessModel(env), bundle)).rejects.toBe(boom);

    expect(calls, "the transport retried a thrown call").toBe(1);
  });

  it("never reaches the model when the bundle has no price history", async () => {
    const { env, calls } = fakeAi({ response: REAL_ANSWER });
    const noCandles: CandidateGatherBundle = {
      ...bundle,
      candles: { outcome: "failed", error: Object.assign(new Error("x"), { code: "candles_unavailable" }) as never, failedAt: T0 },
    };

    await expect(assessCandidate(envAssessModel(env), noCandles)).rejects.toMatchObject({
      code: "no_price_history",
    });
    expect(calls).toHaveLength(0);
  });
});
