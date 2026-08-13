/**
 * The two-call orchestration, driven entirely by an INJECTED fake.
 *
 * ⚠ NOTHING IN THIS FILE MAKES A NETWORK REQUEST OR A MODEL CALL, and that is the
 * whole reason `runProposal` takes a `ProposalClient` rather than importing
 * `fetchAssess`/`fetchDerive` directly. Every real run of this code costs two
 * paid inferences and writes two permanent, undeletable proposal rows; a test
 * suite that could accidentally trigger one would be a standing hazard, and this
 * project's rule since step 37 is that the session writing the code makes no real
 * call at all.
 *
 * ⚠ ONE CHECK HERE CROSSES INTO BACKEND SOURCE ON PURPOSE. The most important
 * property of this orchestration is not that it calls two functions in order --
 * it is that the STRING it hands to the second one is something the real
 * `parseResubmittedAssessment` accepts against a real bundle. So the fake
 * `derive` captures that string and the test feeds it to the real parser.
 * `resubmission.test.ts` proves the projection is right in isolation; this proves
 * the orchestration actually uses it.
 */

import { describe, expect, it } from "vitest";

import { parseResubmittedAssessment } from "../../../src/research/assess-resubmit";
import { buildAssessPrompt } from "../../../src/research/assess-prompt";
import type { CandleWindow } from "../../../src/research/candles";
import {
  assessConcentration,
  type AccountExposure,
  type ExposureBot,
} from "../../../src/research/concentration";
import type { Candidate } from "../../../src/research/candidates";
import { NEWS_NOT_YET_AVAILABLE, type CandidateGatherBundle } from "../../../src/research/gather";
import type { Candle, Timestamp } from "../../../src/shared/exchange-client";
import { ONE } from "../../../src/shared/money";

import type { AssessResponse, DeriveResponse } from "../api/research-types";
import {
  MEASURED_LATENCY,
  observedRunRangeSeconds,
  observedStageRangeSeconds,
  runProposal,
  strategyInFlight,
  type ProposalClient,
  type ResearchRequest,
  type RunPhase,
} from "./proposalRun";

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
  sources: [
    { kind: "named", requestedAs: PAIR, requestedBy: "operator@example.com", requestedAt: T0 },
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

const CANDLES = Array.from({ length: 30 }, (_, i) =>
  candle(T0 + i * MINUTE, (100n + BigInt(i)) * ONE),
);

const windowValue: CandleWindow = {
  accountLabel: candidate.accountLabel,
  exchange: candidate.exchange,
  pair: PAIR,
  interval: "1m",
  candles: CANDLES,
  fetchedAt: 1_940_000_000_000,
  requestedSince: null,
  earliestOpenTime: CANDLES[0]!.openTime,
  earliestCloseTime: CANDLES[0]!.closeTime,
  latestCloseTime: CANDLES[CANDLES.length - 1]!.closeTime,
  truncated: false,
  missingHistoryMs: null,
};

const bots: ExposureBot[] = [
  { id: "b-1", pair: PAIR, capitalAsset: "USD", allocatedCapital: 50n * ONE, status: "running", archived: false },
];

const exposure: AccountExposure = {
  accountLabel: candidate.accountLabel,
  readAt: T0,
  rowsRead: 1,
  committed: bots,
  stopped: [],
  quoteAssetsObserved: ["USD"],
};

const realBundle: CandidateGatherBundle = {
  candidate,
  candles: { outcome: "ok", value: windowValue },
  news: NEWS_NOT_YET_AVAILABLE,
  concentration: { outcome: "ok", value: assessConcentration(exposure, candidate) },
  assembledAt: T0,
};

/** A wire-shaped `/assess` response built over REAL evidence ids. */
function assessResponse(overrides: Partial<AssessResponse["assess"]> = {}): AssessResponse {
  const evidence = buildAssessPrompt(realBundle).evidence.map((item) => ({
    id: item.id,
    label: item.label,
    value: item.value,
    source: item.source,
  }));
  const cite = (id: string) => evidence.find((item) => item.id === id)!;
  return {
    entryPoint: "named",
    selectedAt: T0,
    proposalId: "prop-assess-1",
    bundle: realBundle as unknown as AssessResponse["bundle"],
    assess: {
      strategy: "grid",
      claims: [
        { statement: "a narrow band", citations: [cite("candles.range_pct")] },
        { statement: "and a recent close", citations: [cite("candles.last_close")] },
      ],
      evidence,
      promptVersion: "assess/v1",
      promptChars: 16_000,
      model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
      settings: { temperature: 0 },
      envelope: "envelope_object",
      duplicateKeyCheck: "unavailable_transport_parsed",
      latencyMs: 17_622,
      ...overrides,
    },
  };
}

/** Only what `runProposal` touches: it passes this through untouched. */
const deriveResponse = { proposalId: "prop-derive-1" } as unknown as DeriveResponse;

const REQUEST: ResearchRequest = {
  accountLabel: "gemini-main",
  pair: PAIR,
  interval: "1m",
  since: 1_930_000_000_000,
  quoteAssets: ["USD"],
};

interface Recorded {
  readonly assessCalls: { request: ResearchRequest; signal?: AbortSignal }[];
  readonly deriveCalls: { request: ResearchRequest; assessment: string; signal?: AbortSignal }[];
}

function fakeClient(
  behaviour: {
    assess?: () => Promise<AssessResponse>;
    derive?: () => Promise<DeriveResponse>;
  } = {},
): { client: ProposalClient; recorded: Recorded } {
  const recorded: Recorded = { assessCalls: [], deriveCalls: [] };
  const client: ProposalClient = {
    async assess(request, signal) {
      recorded.assessCalls.push({ request, ...(signal === undefined ? {} : { signal }) });
      return behaviour.assess === undefined ? assessResponse() : behaviour.assess();
    },
    async derive(request, assessment, signal) {
      recorded.deriveCalls.push({
        request,
        assessment,
        ...(signal === undefined ? {} : { signal }),
      });
      return behaviour.derive === undefined ? deriveResponse : behaviour.derive();
    },
  };
  return { client, recorded };
}

const apiError = (code: string, message: string, status: number) => ({
  name: "ApiError",
  code,
  message,
  status,
});

// ---------------------------------------------------------------------------

describe("the happy path", () => {
  it("calls assess then derive and returns both real responses", async () => {
    const { client, recorded } = fakeClient();
    const outcome = await runProposal(client, REQUEST, () => {});

    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") throw new Error("unreachable");
    expect(outcome.assess.proposalId).toBe("prop-assess-1");
    expect(outcome.derive.proposalId).toBe("prop-derive-1");
    expect(recorded.assessCalls).toHaveLength(1);
    expect(recorded.deriveCalls).toHaveLength(1);
  });

  it("reports exactly two phases, each when a real call starts", async () => {
    const { client } = fakeClient();
    const phases: RunPhase[] = [];
    await runProposal(client, REQUEST, (phase) => phases.push(phase));

    expect(phases.map((phase) => phase.kind)).toEqual(["assessing", "deriving"]);
  });

  it("carries the completed assessment on the deriving phase, so the strategy shown is REAL", async () => {
    const { client } = fakeClient({ assess: async () => assessResponse({ strategy: "dca" }) });
    const phases: RunPhase[] = [];
    await runProposal(client, REQUEST, (phase) => phases.push(phase));

    expect(strategyInFlight(phases[0]!)).toBeNull();
    expect(strategyInFlight(phases[1]!)).toBe("dca");
  });
});

// ---------------------------------------------------------------------------

describe("the two calls cannot disagree about what they are about", () => {
  it("hands derive the SAME request object assess got", async () => {
    const { client, recorded } = fakeClient();
    await runProposal(client, REQUEST, () => {});

    expect(recorded.deriveCalls[0]!.request).toBe(recorded.assessCalls[0]!.request);
    expect(recorded.deriveCalls[0]!.request).toBe(REQUEST);
  });

  it("preserves every optional parameter on both calls rather than defaulting one", async () => {
    const { client, recorded } = fakeClient();
    await runProposal(client, REQUEST, () => {});

    for (const call of [recorded.assessCalls[0]!.request, recorded.deriveCalls[0]!.request]) {
      expect(call.pair).toBe(PAIR);
      expect(call.interval).toBe("1m");
      expect(call.since).toBe(1_930_000_000_000);
      expect(call.quoteAssets).toEqual(["USD"]);
    }
  });

  it("passes the abort signal to both calls", async () => {
    const { client, recorded } = fakeClient();
    const controller = new AbortController();
    await runProposal(client, REQUEST, () => {}, controller.signal);

    expect(recorded.assessCalls[0]!.signal).toBe(controller.signal);
    expect(recorded.deriveCalls[0]!.signal).toBe(controller.signal);
  });
});

// ---------------------------------------------------------------------------

describe("⚠ THE PROJECTION IS ACTUALLY USED, and the REAL parser accepts what it sends", () => {
  it("sends an assessment string the real parseResubmittedAssessment accepts", async () => {
    const { client, recorded } = fakeClient();
    await runProposal(client, REQUEST, () => {});

    const sent = recorded.deriveCalls[0]!.assessment;
    const parsed = parseResubmittedAssessment(sent, realBundle);
    expect(parsed.strategy).toBe("grid");
    expect(parsed.claims.map((claim) => claim.statement)).toEqual([
      "a narrow band",
      "and a recent close",
    ]);
  });

  it("sends bare id strings, not the whole EvidenceItems the response carried", async () => {
    const { client, recorded } = fakeClient();
    await runProposal(client, REQUEST, () => {});

    const sent = JSON.parse(recorded.deriveCalls[0]!.assessment) as {
      claims: { citations: unknown[] }[];
    };
    for (const claim of sent.claims) {
      for (const citation of claim.citations) {
        expect(typeof citation).toBe("string");
      }
    }
  });

  it("forwards the ORIGINAL call's envelope and duplicateKeyCheck rather than inventing them", async () => {
    const { client, recorded } = fakeClient({
      assess: async () =>
        assessResponse({ envelope: "bare_string", duplicateKeyCheck: "performed" }),
    });
    await runProposal(client, REQUEST, () => {});

    const sent = JSON.parse(recorded.deriveCalls[0]!.assessment) as Record<string, unknown>;
    expect(sent["envelope"]).toBe("bare_string");
    expect(sent["duplicateKeyCheck"]).toBe("performed");
  });
});

// ---------------------------------------------------------------------------

describe("an Assess refusal", () => {
  it("reports the assess stage with the real code and NEVER calls derive", async () => {
    const { client, recorded } = fakeClient({
      assess: async () => {
        throw apiError("pair_not_tradable", "gemini does not list ZZQUSD", 400);
      },
    });
    const outcome = await runProposal(client, REQUEST, () => {});

    expect(outcome.kind).toBe("failed");
    if (outcome.kind !== "failed") throw new Error("unreachable");
    expect(outcome.failure.stage).toBe("assess");
    expect(outcome.failure.code).toBe("pair_not_tradable");
    expect(outcome.failure.status).toBe(400);
    expect(outcome.failure.assessAlreadySpent).toBe(false);
    // ⚠ The decisive half: a refused Assess must not spend a Derive inference.
    expect(recorded.deriveCalls).toHaveLength(0);
  });

  it("carries no assessment through, because there is none", async () => {
    const { client } = fakeClient({
      assess: async () => {
        throw apiError("no_price_history", "no candles", 503);
      },
    });
    const outcome = await runProposal(client, REQUEST, () => {});
    if (outcome.kind !== "failed") throw new Error("unreachable");
    expect(outcome.assess).toBeNull();
  });

  it("does not report a deriving phase", async () => {
    const { client } = fakeClient({
      assess: async () => {
        throw apiError("no_ai_binding", "no AI binding", 503);
      },
    });
    const phases: RunPhase[] = [];
    await runProposal(client, REQUEST, (phase) => phases.push(phase));
    expect(phases.map((phase) => phase.kind)).toEqual(["assessing"]);
  });
});

// ---------------------------------------------------------------------------

describe("a Derive refusal after a SUCCESSFUL Assess", () => {
  it("reports the derive stage and says an inference was already spent", async () => {
    const { client } = fakeClient({
      derive: async () => {
        throw apiError("citation_unknown", "candles.bucket.19 is not in this run", 409);
      },
    });
    const outcome = await runProposal(client, REQUEST, () => {});

    if (outcome.kind !== "failed") throw new Error("unreachable");
    expect(outcome.failure.stage).toBe("derive");
    expect(outcome.failure.code).toBe("citation_unknown");
    expect(outcome.failure.status).toBe(409);
    expect(outcome.failure.assessAlreadySpent).toBe(true);
  });

  it("⚠ KEEPS the assessment that succeeded rather than discarding a paid answer", async () => {
    const { client } = fakeClient({
      derive: async () => {
        throw apiError("no_capital_headroom", "nothing available", 409);
      },
    });
    const outcome = await runProposal(client, REQUEST, () => {});

    if (outcome.kind !== "failed") throw new Error("unreachable");
    expect(outcome.assess).not.toBeNull();
    expect(outcome.assess!.proposalId).toBe("prop-assess-1");
    expect(outcome.assess!.assess.strategy).toBe("grid");
  });
});

// ---------------------------------------------------------------------------

describe("cancellation is not a failure", () => {
  const aborted = () => new DOMException("aborted", "AbortError");

  it("rethrows an AbortError from assess instead of describing it", async () => {
    const { client } = fakeClient({
      assess: async () => {
        throw aborted();
      },
    });
    await expect(runProposal(client, REQUEST, () => {})).rejects.toThrow(DOMException);
  });

  it("rethrows an AbortError from derive instead of describing it", async () => {
    const { client } = fakeClient({
      derive: async () => {
        throw aborted();
      },
    });
    await expect(runProposal(client, REQUEST, () => {})).rejects.toThrow(DOMException);
  });

  it("still describes an ordinary Error, which is NOT an abort", async () => {
    const { client } = fakeClient({
      assess: async () => {
        throw new Error("something in the dashboard threw");
      },
    });
    const outcome = await runProposal(client, REQUEST, () => {});
    if (outcome.kind !== "failed") throw new Error("unreachable");
    expect(outcome.failure.status).toBe(0);
    expect(outcome.failure.message).toBe("something in the dashboard threw");
  });
});

// ---------------------------------------------------------------------------

describe("the published latency figures are the REAL measurements", () => {
  it("reports min and max that are actually the min and max of the samples", () => {
    for (const stage of ["assess", "derive"] as const) {
      const measured = MEASURED_LATENCY[stage];
      expect(measured.minMs).toBe(Math.min(...measured.samplesMs));
      expect(measured.maxMs).toBe(Math.max(...measured.samplesMs));
    }
  });

  it("carries the nine Assess and four Derive samples the decision log records", () => {
    // Provenance in `MEASURED_LATENCY`'s header: entries 37, 39, 40, 41, 42, 46.
    expect(MEASURED_LATENCY.assess.samplesMs).toEqual([
      10_546, 10_614, 11_470, 13_080, 13_540, 14_428, 17_622, 20_326, 41_511,
    ]);
    expect(MEASURED_LATENCY.derive.samplesMs).toEqual([27_473, 28_632, 46_969, 77_344]);
    expect(MEASURED_LATENCY.totalObservedMs).toEqual([41_712, 45_095, 88_480, 91_772]);
  });

  it("⚠ INCLUDES ENTRY 46's LIVE SAMPLES, the ones that disproved the old ceiling", () => {
    // The stale constant claimed a 46,969 ms Derive maximum while a real run had
    // already taken 77,344 ms. A test naming both numbers is what stops that
    // being re-tightened by someone pruning an outlier.
    expect(MEASURED_LATENCY.assess.samplesMs).toContain(14_428);
    expect(MEASURED_LATENCY.derive.samplesMs).toContain(77_344);
    expect(MEASURED_LATENCY.derive.maxMs).toBe(77_344);
    expect(MEASURED_LATENCY.derive.maxMs).toBeGreaterThan(46_969);
  });

  it("⚠ never quotes a range narrower than what was really observed", () => {
    // A range that did not cover the 91,772 ms chain would tell an operator the
    // wait is shorter than this project has actually measured -- which is exactly
    // what the page did on its first real run.
    expect(observedRunRangeSeconds()).toEqual({ minS: 42, maxS: 92, runs: 4 });
    expect(observedStageRangeSeconds("assess")).toEqual({ minS: 11, maxS: 42, runs: 9 });
    expect(observedStageRangeSeconds("derive")).toEqual({ minS: 27, maxS: 77, runs: 4 });
  });

  it("⚠ publishes the SAMPLE COUNT with every range, so it cannot be rendered as a law", () => {
    // The count is the difference between "runs take 27-77s" and "4 runs took
    // 27-77s". The first is a claim about the future; only the second is true.
    for (const range of [
      observedRunRangeSeconds(),
      observedStageRangeSeconds("assess"),
      observedStageRangeSeconds("derive"),
    ]) {
      expect(range.runs).toBeGreaterThan(0);
    }
    expect(observedStageRangeSeconds("assess").runs).toBe(
      MEASURED_LATENCY.assess.samplesMs.length,
    );
    expect(observedStageRangeSeconds("derive").runs).toBe(
      MEASURED_LATENCY.derive.samplesMs.length,
    );
    expect(observedRunRangeSeconds().runs).toBe(MEASURED_LATENCY.totalObservedMs.length);
  });

  it("⚠ every whole-chain total is a real Assess sample plus a real Derive sample", () => {
    // Entry 42's table confirms model time for a chain IS the two stages summed
    // (13,080+28,632=41,712; 41,511+46,969=88,480; 17,622+27,473=45,095), and
    // entry 46's run continues it (14,428+77,344=91,772). Pinning it stops a
    // total ever being a figure no pair of real measured stages produced.
    for (const total of MEASURED_LATENCY.totalObservedMs) {
      const reachable = MEASURED_LATENCY.assess.samplesMs.some((assessMs) =>
        MEASURED_LATENCY.derive.samplesMs.some((deriveMs) => assessMs + deriveMs === total),
      );
      expect(reachable).toBe(true);
    }
  });
});
