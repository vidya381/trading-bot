/**
 * THE PROJECTION, CHECKED AGAINST THE REAL PARSER THAT HAS TO ACCEPT IT.
 *
 * ── WHY THIS TEST IMPORTS BACKEND SOURCE ──
 *
 * `projectResubmission` exists for exactly one consumer:
 * `parseResubmittedAssessment` in `src/research/assess-resubmit.ts`, reached over
 * HTTP as `GET /api/accounts/:label/derive?assessment=…`. Its correctness is not
 * a property of its own shape — it is the question "does the real parser accept
 * this, against a real freshly-gathered bundle, and resolve it to the claims that
 * were meant?"
 *
 * A test written against a hand-typed expected object would pin the dashboard's
 * BELIEF about the contract rather than the contract, and would keep passing on
 * the day `RESUBMITTED_ASSESSMENT_FIELDS` gains a fifth field — while every real
 * run started coming back 400. So this file does what `citations.test.ts` does
 * one layer up: it drives the REAL backend module over REAL evidence built by the
 * REAL `buildAssessPrompt`, and it asserts on what that module actually did.
 *
 * ⚠ THE MIRROR THIS PINS. `resubmission.ts` cannot import
 * `RESUBMITTED_ASSESSMENT_FIELDS` — `assess-resubmit.ts` pulls in the Worker's D1
 * and Workers types and breaks the dashboard's `tsc -b`. So the four field names
 * are written out twice, and the first test below is the thing that stops the two
 * copies drifting. Entry 45's rule for a mirror is that not-having-a-copy beats
 * testing one; where a copy is forced, the test has to compare the copies
 * directly rather than assert around them.
 *
 * ── WHICH RUNNER ──
 *
 * The root vitest suite, in the Workers pool, like `citations.test.ts`. Both
 * modules under test are pure TypeScript with no React and no DOM. Nothing here
 * calls a model, reads a database, reaches a venue or makes any network request.
 */

import { describe, expect, it } from "vitest";

import {
  AssessResubmitError,
  RESUBMITTED_ASSESSMENT_FIELDS,
  assessEvidenceOf,
  parseResubmittedAssessment,
} from "../../../src/research/assess-resubmit";
import { buildAssessPrompt } from "../../../src/research/assess-prompt";
import { CandleWindowError, type CandleWindow } from "../../../src/research/candles";
import {
  assessConcentration,
  type AccountExposure,
  type ExposureBot,
} from "../../../src/research/concentration";
import type { Candidate } from "../../../src/research/candidates";
import {
  NEWS_NOT_YET_AVAILABLE,
  type CandidateGatherBundle,
} from "../../../src/research/gather";
import type { Candle, Timestamp } from "../../../src/shared/exchange-client";
import { ONE } from "../../../src/shared/money";

import type { AssessResult, EvidenceItem } from "../api/research-types";
import { RESUBMITTED_FIELDS, encodeResubmission, projectResubmission } from "./resubmission";

// ---------------------------------------------------------------------------
// Fixtures -- a real bundle, so the evidence ids below are ones the system
// really emits rather than ones this file invented.
// ---------------------------------------------------------------------------

const T0 = 1_930_000_000_000;
const MINUTE = 60_000;
const FETCHED_AT = 1_940_000_000_000;
/** A pair on no real venue, so nothing here can accidentally be about BTC. */
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

/** 40 candles, so the window really produces the full 24 `candles.bucket.NN` ids. */
const DEEP = Array.from({ length: 40 }, (_, i) => candle(T0 + i * MINUTE, (100n + BigInt(i)) * ONE));
/** 3 candles, the "the venue answered shallower this time" window (entry 45 saw this live). */
const SHALLOW = DEEP.slice(0, 3);

function window(candles: readonly Candle[]): CandleWindow {
  return {
    accountLabel: candidate.accountLabel,
    exchange: candidate.exchange,
    pair: PAIR,
    interval: "1m",
    candles: [...candles],
    fetchedAt: FETCHED_AT,
    requestedSince: null,
    earliestOpenTime: candles[0]!.openTime,
    earliestCloseTime: candles[0]!.closeTime,
    latestCloseTime: candles[candles.length - 1]!.closeTime,
    truncated: false,
    missingHistoryMs: null,
  };
}

const flaggedBots: ExposureBot[] = [
  { id: "b-1", pair: PAIR, capitalAsset: "USD", allocatedCapital: 50n * ONE, status: "running", archived: false },
  { id: "b-2", pair: PAIR, capitalAsset: "USD", allocatedCapital: 50n * ONE, status: "running", archived: false },
];

function exposure(bots: ExposureBot[]): AccountExposure {
  return {
    accountLabel: candidate.accountLabel,
    readAt: T0,
    rowsRead: bots.length,
    committed: bots,
    stopped: [],
    quoteAssetsObserved: ["USD"],
  };
}

function bundle(overrides: Partial<CandidateGatherBundle> = {}): CandidateGatherBundle {
  return {
    candidate,
    candles: { outcome: "ok", value: window(DEEP) },
    news: NEWS_NOT_YET_AVAILABLE,
    concentration: { outcome: "ok", value: assessConcentration(exposure(flaggedBots), candidate) },
    assembledAt: T0,
    ...overrides,
  };
}

/** A real evidence item off the real Assess prompt, by id. */
function evidenceItem(from: CandidateGatherBundle, id: string): EvidenceItem {
  const found = buildAssessPrompt(from).evidence.find((item) => item.id === id);
  if (found === undefined) throw new Error(`fixture error: no evidence id ${id}`);
  return { id: found.id, label: found.label, value: found.value, source: found.source };
}

/**
 * A wire-shaped `/assess` result, built from REAL evidence.
 *
 * This is the `assess` member of the response `assessResultView` serialises, with
 * every field it really publishes present -- including the six the projection
 * must DROP. A fixture carrying only the four wanted fields would let a
 * pass-everything projection look correct.
 */
function assessResult(overrides: Partial<AssessResult> = {}): AssessResult {
  const source = bundle();
  const evidence = buildAssessPrompt(source).evidence.map((item) => ({
    id: item.id,
    label: item.label,
    value: item.value,
    source: item.source,
  }));
  return {
    strategy: "grid",
    claims: [
      {
        statement: "the window moves inside a narrow band",
        citations: [evidenceItem(source, "candles.range_pct"), evidenceItem(source, "candles.high")],
      },
      {
        statement: "this account already holds this pair twice",
        citations: [evidenceItem(source, "concentration.assessment")],
      },
      {
        statement: "the deepest bucket is still recent",
        citations: [evidenceItem(source, "candles.bucket.19")],
      },
    ],
    evidence,
    promptVersion: "assess/v1",
    promptChars: 16_384,
    model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    settings: { temperature: 0 },
    envelope: "envelope_object",
    duplicateKeyCheck: "unavailable_transport_parsed",
    latencyMs: 17_622,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// The mirror
// ---------------------------------------------------------------------------

describe("the four-field contract is the BACKEND's, not this dashboard's belief about it", () => {
  it("names exactly the fields RESUBMITTED_ASSESSMENT_FIELDS names, in the same order", () => {
    expect(RESUBMITTED_FIELDS).toEqual(RESUBMITTED_ASSESSMENT_FIELDS);
  });

  it("projects exactly those four keys and no others", () => {
    expect(Object.keys(projectResubmission(assessResult()))).toEqual([
      ...RESUBMITTED_ASSESSMENT_FIELDS,
    ]);
  });

  it("drops every field /assess publishes that the contract does not name", () => {
    const projected = projectResubmission(assessResult()) as Record<string, unknown>;
    for (const dropped of [
      "evidence",
      "promptVersion",
      "promptChars",
      "model",
      "settings",
      "latencyMs",
    ]) {
      expect(projected[dropped]).toBeUndefined();
    }
  });

  it("gives each claim exactly statement and citations", () => {
    for (const claim of projectResubmission(assessResult()).claims) {
      expect(Object.keys(claim)).toEqual(["statement", "citations"]);
    }
  });
});

// ---------------------------------------------------------------------------
// THE DECISIVE CHECK: the real parser accepts it, against a real bundle
// ---------------------------------------------------------------------------

describe("the REAL /derive parser accepts what this projects", () => {
  it("round-trips a whole assessment through parseResubmittedAssessment", () => {
    const source = bundle();
    const parsed = parseResubmittedAssessment(
      encodeResubmission(projectResubmission(assessResult())),
      source,
    );

    expect(parsed.strategy).toBe("grid");
    expect(parsed.envelope).toBe("envelope_object");
    expect(parsed.duplicateKeyCheck).toBe("unavailable_transport_parsed");
    expect(parsed.claims).toHaveLength(3);
    expect(parsed.claims.map((claim) => claim.statement)).toEqual([
      "the window moves inside a narrow band",
      "this account already holds this pair twice",
      "the deepest bucket is still recent",
    ]);
    // Every citation resolved to a WHOLE item off this run's own evidence set.
    expect(parsed.claims[0]!.citations.map((item) => item.id)).toEqual([
      "candles.range_pct",
      "candles.high",
    ]);
    for (const claim of parsed.claims) {
      for (const citation of claim.citations) {
        expect(assessEvidenceOf(source).some((item) => item.id === citation.id)).toBe(true);
      }
    }
  });

  it("accepts both strategies, all four envelope shapes and both duplicate-key states", () => {
    const source = bundle();
    for (const strategy of ["dca", "grid"] as const) {
      for (const envelope of [
        "bare_string",
        "envelope_string",
        "envelope_object",
        "bare_object",
      ]) {
        for (const duplicateKeyCheck of ["performed", "unavailable_transport_parsed"] as const) {
          const projected = projectResubmission(
            assessResult({ strategy, envelope, duplicateKeyCheck }),
          );
          const parsed = parseResubmittedAssessment(encodeResubmission(projected), source);
          expect(parsed.strategy).toBe(strategy);
          expect(parsed.envelope).toBe(envelope);
          expect(parsed.duplicateKeyCheck).toBe(duplicateKeyCheck);
        }
      }
    }
  });

  it("survives a claim citing the same id twice, and one with a single citation", () => {
    const source = bundle();
    const item = evidenceItem(source, "candles.last_close");
    const projected = projectResubmission(
      assessResult({
        claims: [
          { statement: "twice over", citations: [item, item] },
          { statement: "once", citations: [item] },
        ],
      }),
    );
    const parsed = parseResubmittedAssessment(encodeResubmission(projected), source);
    expect(parsed.claims[0]!.citations).toHaveLength(2);
    expect(parsed.claims[1]!.citations).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// THE RE-RESOLUTION: ids in, CURRENT values out
// ---------------------------------------------------------------------------

describe("the ids are re-resolved against the bundle /derive gathered, not the one /assess saw", () => {
  it("returns the NEW value for the same id when the price moved between the two calls", () => {
    const older = bundle();
    const moved = [...DEEP.slice(0, DEEP.length - 1), candle(T0 + 39 * MINUTE, 999n * ONE)];
    const newer = bundle({ candles: { outcome: "ok", value: window(moved) } });

    const oldValue = evidenceItem(older, "candles.last_close").value;
    const newValue = evidenceItem(newer, "candles.last_close").value;
    expect(oldValue).not.toBe(newValue);

    // Projected from the OLD response, parsed against the NEW bundle.
    const projected = projectResubmission(
      assessResult({
        claims: [
          {
            statement: "the last close is where it is",
            citations: [evidenceItem(older, "candles.last_close")],
          },
        ],
      }),
    );
    const parsed = parseResubmittedAssessment(encodeResubmission(projected), newer);
    expect(parsed.claims[0]!.citations[0]!.value).toBe(newValue);
    expect(parsed.claims[0]!.citations[0]!.value).not.toBe(oldValue);
  });

  it("is refused with citation_unknown when the new window is too shallow for the cited bucket", () => {
    // Ordinary drift, not a fabricated id: 40 candles emit bucket.19, 3 do not.
    const shallower = bundle({ candles: { outcome: "ok", value: window(SHALLOW) } });
    expect(assessEvidenceOf(shallower).some((item) => item.id === "candles.bucket.19")).toBe(false);

    let thrown: unknown;
    try {
      parseResubmittedAssessment(
        encodeResubmission(projectResubmission(assessResult())),
        shallower,
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(AssessResubmitError);
    expect((thrown as AssessResubmitError).code).toBe("citation_unknown");
  });

  it("is refused with citation_unknown when the candle fetch now fails outright", () => {
    const broken = bundle({
      candles: {
        outcome: "failed",
        error: new CandleWindowError("candles_unavailable", "the venue refused"),
        failedAt: FETCHED_AT,
      },
    });
    let thrown: unknown;
    try {
      parseResubmittedAssessment(
        encodeResubmission(projectResubmission(assessResult())),
        broken,
      );
    } catch (error) {
      thrown = error;
    }
    expect((thrown as AssessResubmitError).code).toBe("citation_unknown");
  });
});

// ---------------------------------------------------------------------------
// The refusals a WRONG projection would produce -- each provoked for real
// ---------------------------------------------------------------------------

describe("what the real parser does to the projections this module deliberately does NOT make", () => {
  const source = bundle();
  const project = () => projectResubmission(assessResult()) as unknown as Record<string, unknown>;

  function refusalFor(payload: unknown): AssessResubmitError {
    try {
      parseResubmittedAssessment(JSON.stringify(payload), source);
    } catch (error) {
      if (error instanceof AssessResubmitError) return error;
      throw error;
    }
    throw new Error("expected a refusal, got an acceptance");
  }

  it("refuses whole EvidenceItems as citations -- so reducing to ids is required, not tidier", () => {
    const payload = project();
    payload["claims"] = [
      {
        statement: "the window moves inside a narrow band",
        citations: [evidenceItem(source, "candles.range_pct")],
      },
    ];
    expect(refusalFor(payload).code).toBe("citation_not_a_string");
  });

  it("refuses a projection that dropped envelope", () => {
    const payload = project();
    delete payload["envelope"];
    expect(refusalFor(payload).code).toBe("missing_field");
  });

  it("refuses a projection that dropped duplicateKeyCheck", () => {
    const payload = project();
    delete payload["duplicateKeyCheck"];
    expect(refusalFor(payload).code).toBe("missing_field");
  });

  it("refuses a projection that helpfully forwarded the evidence array too", () => {
    const payload = project();
    payload["evidence"] = [];
    expect(refusalFor(payload).code).toBe("unexpected_field");
  });

  it("refuses a projection that forwarded latencyMs", () => {
    const payload = project();
    payload["latencyMs"] = 17_622;
    expect(refusalFor(payload).code).toBe("unexpected_field");
  });

  it("refuses a claim carrying anything beyond statement and citations", () => {
    const payload = project();
    payload["claims"] = [
      { statement: "a claim", citations: ["candles.high"], confidence: 0.9 },
    ];
    expect(refusalFor(payload).code).toBe("unexpected_field");
  });

  it("refuses an invented citation id", () => {
    const payload = project();
    payload["claims"] = [{ statement: "a claim", citations: ["candles.definitely_not_real"] }];
    expect(refusalFor(payload).code).toBe("citation_unknown");
  });
});

// ---------------------------------------------------------------------------
// The bytes
// ---------------------------------------------------------------------------

describe("encodeResubmission produces the exact text the query parameter carries", () => {
  it("is JSON that parses back to the projected object", () => {
    const projected = projectResubmission(assessResult());
    expect(JSON.parse(encodeResubmission(projected))).toEqual(projected);
  });

  it("emits no duplicate key, so the scan /derive runs on these bytes always passes", () => {
    // `findDuplicateKey` is the one check that can only run on source text. This
    // client cannot trip it -- a fresh object literal has unique keys -- and the
    // assertion pins that rather than leaving it as an assumption.
    const text = encodeResubmission(projectResubmission(assessResult()));
    expect(text.match(/"strategy":/g)).toHaveLength(1);
    expect(text.match(/"envelope":/g)).toHaveLength(1);
    expect(text.match(/"duplicateKeyCheck":/g)).toHaveLength(1);
  });

  it("survives a round trip through URLSearchParams, which is how it reaches the endpoint", () => {
    const text = encodeResubmission(projectResubmission(assessResult()));
    const encoded = new URLSearchParams({ assessment: text }).toString();
    const decoded = new URLSearchParams(encoded).get("assessment");
    expect(decoded).toBe(text);
    expect(parseResubmittedAssessment(decoded!, source()).strategy).toBe("grid");
  });

  function source(): CandidateGatherBundle {
    return bundle();
  }
});
