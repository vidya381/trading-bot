/**
 * Re-verifying a Stage 2 result that arrived from OUTSIDE this system.
 *
 * THIS FILE TESTS THE ONE BOUNDARY NOTHING ELSE IN THIS REPOSITORY HAS EVER
 * CROSSED. Step 41's probe fed Assess's output into Derive inside one request,
 * so the assessment and the evidence were the same objects and drift was
 * impossible by construction. Here the assessment is untrusted text and the
 * evidence was gathered separately, later, and may not match.
 *
 * Five properties:
 *
 *  1. THE CHECK IS AGAINST *THIS RUN'S* EVIDENCE, NOT THE SUBMISSION'S. An
 *     assessment whose citations still resolve against a time-shifted bundle is
 *     accepted and re-resolved to the CURRENT items; one whose citation the
 *     current bundle does not emit is refused. Both directions, because a check
 *     that only ever accepts and a check that only ever refuses look identical
 *     from a single test.
 *  2. THE DRIFT IS REAL AND ORDINARY. The refusal is provoked by things that
 *     genuinely happen between two HTTP calls -- a shallower candle window, a
 *     candle fetch that now fails, a concentration flag that cleared -- and not
 *     only by a fabricated id. If the only way to trip this check were to invent
 *     an id, it would be a spelling check rather than a freshness check.
 *  3. THE STRATEGY IS TWO EXACT LITERALS. Not case-folded, not trimmed, not
 *     nearest-matched, and not a third strategy.
 *  4. THE EVIDENCE SET IS THE ASSESS SET, NOT DERIVE'S. An Assess claim cannot
 *     cite `capital.*`, `filters.*` or `assessment.*` -- the last of which would
 *     make the whole check circular.
 *  5. IT IS FAIL-CLOSED AND WHOLE-RESPONSE. One bad citation in a good
 *     assessment discards the assessment; nothing is dropped, defaulted or
 *     partially accepted.
 *
 * NOTHING HERE CALLS A MODEL, READS A DATABASE OR REACHES A VENUE.
 */

import { describe, expect, it } from "vitest";

import {
  AssessResubmitError,
  RESUBMITTED_ASSESSMENT_FIELDS,
  assessEvidenceOf,
  parseResubmittedAssessment,
} from "./assess-resubmit";
import { buildAssessPrompt } from "./assess-prompt";
import { CandleWindowError, type CandleWindow } from "./candles";
import {
  assessConcentration,
  type AccountExposure,
  type ExposureBot,
} from "./concentration";
import type { Candidate } from "./candidates";
import {
  NEWS_NOT_YET_AVAILABLE,
  type CandidateGatherBundle,
  type ConcentrationInput,
} from "./gather";
import type { Candle, Timestamp } from "../shared/exchange-client";
import { ONE } from "../shared/money";

// ---------------------------------------------------------------------------
// Fixtures
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
    {
      kind: "named",
      requestedAs: PAIR,
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

/**
 * `n` minute candles, oldest first, drifting a little so nothing is degenerate.
 *
 * `offsetMinutes` shifts BOTH the times and the prices, so a "later window" is
 * genuinely different data rather than the same numbers at new timestamps --
 * which is what the current-rendering assertion needs in order to compare two
 * values instead of one value to itself.
 */
function candles(n: number, offsetMinutes = 0): Candle[] {
  return Array.from({ length: n }, (_, i) =>
    candle(T0 + (offsetMinutes + i) * MINUTE, (100n + BigInt((offsetMinutes + i) % 7)) * ONE),
  );
}

function window(series: Candle[], fetchedAt = FETCHED_AT): CandleWindow {
  const first = series[0]!;
  const last = series[series.length - 1]!;
  return {
    accountLabel: candidate.accountLabel,
    exchange: candidate.exchange,
    pair: PAIR,
    interval: "1m",
    candles: series,
    fetchedAt,
    requestedSince: null,
    earliestOpenTime: first.openTime,
    earliestCloseTime: first.closeTime,
    latestCloseTime: last.closeTime,
    truncated: false,
    missingHistoryMs: null,
  };
}

function exposure(bots: ExposureBot[]): AccountExposure {
  return {
    accountLabel: candidate.accountLabel,
    readAt: T0 + 10 * MINUTE,
    rowsRead: bots.length,
    committed: bots,
    stopped: [],
    quoteAssetsObserved: ["USD"],
  };
}

function bot(id: string, pair: string): ExposureBot {
  return {
    id,
    pair,
    capitalAsset: "USD",
    allocatedCapital: 50n * ONE,
    status: "running",
    archived: false,
  };
}

/** Two bots on the candidate's own pair: `samePairBotCountFlagAt`, so FLAGGED. */
const flagged: ConcentrationInput = {
  outcome: "ok",
  value: assessConcentration(exposure([bot("b-1", PAIR), bot("b-2", PAIR)]), candidate),
};

/** One bot elsewhere. Nothing to flag, so `concentration.flag.1` does NOT exist. */
const clean: ConcentrationInput = {
  outcome: "ok",
  value: assessConcentration(exposure([bot("b-1", "ETHUSD")]), candidate),
};

function bundle(overrides: Partial<CandidateGatherBundle> = {}): CandidateGatherBundle {
  return {
    candidate,
    candles: { outcome: "ok", value: window(candles(40)) },
    news: NEWS_NOT_YET_AVAILABLE,
    concentration: flagged,
    assembledAt: T0 + 11 * MINUTE,
    ...overrides,
  };
}

/**
 * The submission a client builds from a `/assess` response.
 *
 * Note the `.map(c => c.id)`: `/assess` publishes whole `EvidenceItem`s and this
 * endpoint takes ids. That projection is the client's whole job, and it is
 * written out here rather than hidden in a helper so a reader sees exactly how
 * small it is.
 */
function submission(
  claims: { statement: string; citations: string[] }[],
  overrides: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    strategy: "grid",
    claims,
    envelope: "envelope_object",
    duplicateKeyCheck: "unavailable_transport_parsed",
    ...overrides,
  });
}

const ONE_CLAIM = [
  { statement: "The range is wide relative to the close.", citations: ["candles.range_pct"] },
];

function refusal(run: () => unknown): AssessResubmitError {
  let thrown: unknown;
  try {
    run();
  } catch (error) {
    thrown = error;
  }
  expect(thrown, "expected a refusal, and nothing was thrown").toBeInstanceOf(AssessResubmitError);
  return thrown as AssessResubmitError;
}

// ---------------------------------------------------------------------------
// Property 1: the check is against THIS run's evidence
// ---------------------------------------------------------------------------

describe("the evidence set the check runs against", () => {
  it("is exactly the set buildAssessPrompt emits, so the two cannot drift", () => {
    const b = bundle();
    expect(assessEvidenceOf(b).map((item) => item.id)).toEqual(buildAssessPrompt(b).evidenceIds);
  });

  it("accepts a resubmission whose citations still resolve against a TIME-SHIFTED bundle", () => {
    // The original assessment was made against one window; this run fetched a
    // different, later, differently-priced one. Same ids, different data --
    // which is the ordinary case and must not be refused.
    const later = bundle({
      candles: { outcome: "ok", value: window(candles(40, 600), FETCHED_AT + 36 * 60 * 60_000) },
      assembledAt: T0 + 40 * 60 * MINUTE,
    });

    const parsed = parseResubmittedAssessment(submission(ONE_CLAIM), later);

    expect(parsed.strategy).toBe("grid");
    expect(parsed.claims).toHaveLength(1);
    expect(parsed.claims[0].statement).toBe("The range is wide relative to the close.");
    expect(parsed.claims[0].citations[0]!.id).toBe("candles.range_pct");
  });

  it("resolves citations to the CURRENT rendering, never the one the caller sent", () => {
    // THE ASSERTION THAT MAKES "re-verified" MEAN SOMETHING. The item handed
    // back must carry this run's value, so a human reads the sentence beside
    // data that exists now.
    const now = bundle({ candles: { outcome: "ok", value: window(candles(40, 600)) } });
    const current = assessEvidenceOf(now).find((item) => item.id === "candles.last_close")!;

    const parsed = parseResubmittedAssessment(
      submission([{ statement: "The last close anchors the range.", citations: ["candles.last_close"] }]),
      now,
    );

    expect(parsed.claims[0].citations[0]).toEqual(current);
    // And it is genuinely a different number than the default fixture's, so the
    // assertion above is not comparing a value to itself.
    const other = assessEvidenceOf(bundle()).find((item) => item.id === "candles.last_close")!;
    expect(current.value).not.toBe(other.value);
  });

  it("refuses a citation this run's bundle does not emit, and names it", () => {
    const error = refusal(() =>
      parseResubmittedAssessment(
        submission([{ statement: "RSI was oversold.", citations: ["candles.rsi_14"] }]),
        bundle(),
      ),
    );

    expect(error.code).toBe("citation_unknown");
    expect(error.message).toContain("candles.rsi_14");
    expect(error.received).toBe("candles.rsi_14");
  });
});

// ---------------------------------------------------------------------------
// Property 2: the drift is real and ordinary
// ---------------------------------------------------------------------------

describe("evidence ids that genuinely stop existing between two calls", () => {
  it("refuses a bucket id from a DEEPER window than this run got", () => {
    // The original /assess saw 40 candles, so `collectBundleEvidence` emitted
    // buckets 01..24 and a claim could legitimately rest on bucket 19. This run
    // got 8 candles -- a venue that answered with less history -- so only
    // buckets 01..08 exist. Nothing was fabricated by anyone; the data got
    // shallower.
    const deep = assessEvidenceOf(bundle()).map((item) => item.id);
    expect(deep, "fixture no longer emits bucket 19").toContain("candles.bucket.19");

    const shallow = bundle({ candles: { outcome: "ok", value: window(candles(8)) } });
    expect(assessEvidenceOf(shallow).map((item) => item.id)).not.toContain("candles.bucket.19");

    const error = refusal(() =>
      parseResubmittedAssessment(
        submission([{ statement: "The mid-window bucket held the range.", citations: ["candles.bucket.19"] }]),
        shallow,
      ),
    );
    expect(error.code).toBe("citation_unknown");
  });

  it("refuses every price citation when the candle fetch now FAILS", () => {
    // 19 candle ids collapse to one MISSING marker. This is the case where the
    // resubmitted reasoning is most confidently about data this run does not
    // have at all.
    const broken = bundle({
      candles: {
        outcome: "failed",
        error: new CandleWindowError("candles_unavailable", "gemini did not answer"),
        failedAt: T0 + 5,
      },
    });
    const ids = assessEvidenceOf(broken).map((item) => item.id);
    expect(ids).toContain("candles.status");
    expect(ids).not.toContain("candles.range_pct");

    expect(refusal(() => parseResubmittedAssessment(submission(ONE_CLAIM), broken)).code).toBe(
      "citation_unknown",
    );
  });

  it("refuses a concentration FLAG id after the flag cleared", () => {
    // Stopping one bot between the two calls removes `concentration.flag.N`.
    expect(assessEvidenceOf(bundle()).map((i) => i.id)).toContain("concentration.flag.1");
    const unflagged = bundle({ concentration: clean });
    expect(assessEvidenceOf(unflagged).map((i) => i.id)).not.toContain("concentration.flag.1");

    const error = refusal(() =>
      parseResubmittedAssessment(
        submission([
          { statement: "The account is already concentrated here.", citations: ["concentration.flag.1"] },
        ]),
        unflagged,
      ),
    );
    expect(error.code).toBe("citation_unknown");
  });
});

// ---------------------------------------------------------------------------
// Property 3: the strategy is two exact literals
// ---------------------------------------------------------------------------

describe("the strategy literal", () => {
  it("accepts exactly dca and exactly grid", () => {
    expect(parseResubmittedAssessment(submission(ONE_CLAIM, { strategy: "dca" }), bundle()).strategy).toBe("dca");
    expect(parseResubmittedAssessment(submission(ONE_CLAIM, { strategy: "grid" }), bundle()).strategy).toBe("grid");
  });

  it.each([
    ["GRID", "no case folding"],
    ["Dca", "no case folding"],
    [" grid", "no trimming"],
    ["grid ", "no trimming"],
    ["gird", "no nearest-match"],
    ["momentum", "no third strategy"],
    ["dca or grid", "no hedged choice"],
    ["", "not blank"],
  ])("refuses %s (%s)", (strategy) => {
    const error = refusal(() =>
      parseResubmittedAssessment(submission(ONE_CLAIM, { strategy }), bundle()),
    );
    expect(error.code).toBe("strategy_not_recognised");
  });

  it("refuses a non-string strategy: an array, a number, null, an object", () => {
    for (const strategy of [["dca"], 123, null, { value: "dca" }] as const) {
      const error = refusal(() =>
        parseResubmittedAssessment(submission(ONE_CLAIM, { strategy }), bundle()),
      );
      expect(error.code, `${JSON.stringify(strategy)} was not refused`).toBe("strategy_not_a_string");
    }
  });
});

// ---------------------------------------------------------------------------
// Property 4: the ASSESS evidence set, not Derive's
// ---------------------------------------------------------------------------

describe("which evidence set is used", () => {
  it.each(["capital.status", "filters.min_quantity", "context.gathered_at"])(
    "refuses %s -- a Stage 3 id no Assess claim could have cited",
    (id) => {
      const error = refusal(() =>
        parseResubmittedAssessment(
          submission([{ statement: "Capital allows it.", citations: [id] }]),
          bundle(),
        ),
      );
      expect(error.code).toBe("citation_unknown");
    },
  );

  it("refuses assessment.* -- the ids that would make the check circular", () => {
    // `buildDerivePrompt` emits `assessment.strategy` and `assessment.claim.N`
    // FROM the assessment being checked. Verifying against a set built from the
    // submission would pass by construction: a check that cannot fail.
    for (const id of ["assessment.strategy", "assessment.claim.1"]) {
      const error = refusal(() =>
        parseResubmittedAssessment(
          submission([{ statement: "As decided earlier.", citations: [id] }]),
          bundle(),
        ),
      );
      expect(error.code, `${id} resolved, so the check is circular`).toBe("citation_unknown");
    }
  });
});

// ---------------------------------------------------------------------------
// Property 5: fail-closed, whole-response
// ---------------------------------------------------------------------------

describe("fail-closed reading", () => {
  it("discards the WHOLE assessment when one citation of many is unknown", () => {
    const error = refusal(() =>
      parseResubmittedAssessment(
        submission([
          { statement: "Good claim.", citations: ["candles.range_pct"] },
          { statement: "Good claim two.", citations: ["candles.high", "candles.low"] },
          { statement: "Stale claim.", citations: ["candles.bucket.19"] },
        ]),
        bundle({ candles: { outcome: "ok", value: window(candles(8)) } }),
      ),
    );
    expect(error.code).toBe("citation_unknown");
  });

  it("refuses a claim whose citation list is empty, and one that is not an array", () => {
    expect(
      refusal(() =>
        parseResubmittedAssessment(
          submission([{ statement: "Uncited.", citations: [] }]),
          bundle(),
        ),
      ).code,
    ).toBe("claim_citations_invalid");

    expect(
      refusal(() =>
        parseResubmittedAssessment(
          JSON.stringify({
            strategy: "grid",
            claims: [{ statement: "Uncited.", citations: "candles.range_pct" }],
            envelope: "envelope_object",
            duplicateKeyCheck: "unavailable_transport_parsed",
          }),
          bundle(),
        ),
      ).code,
    ).toBe("claim_citations_invalid");
  });

  it("refuses a citation sent as the whole EvidenceItem /assess published", () => {
    // THE CONTRACT, ASSERTED. The submitted `value` is a rendering of data as it
    // stood at the original call and this stage must ignore it entirely, so the
    // id is required rather than helpfully extracted -- a field accepted and
    // ignored reads exactly like one that was used.
    const item = assessEvidenceOf(bundle()).find((i) => i.id === "candles.range_pct")!;
    const error = refusal(() =>
      parseResubmittedAssessment(
        JSON.stringify({
          strategy: "grid",
          claims: [{ statement: "The range is wide.", citations: [item] }],
          envelope: "envelope_object",
          duplicateKeyCheck: "unavailable_transport_parsed",
        }),
        bundle(),
      ),
    );
    expect(error.code).toBe("citation_not_a_string");
  });

  it("refuses an empty claim list", () => {
    expect(refusal(() => parseResubmittedAssessment(submission([]), bundle())).code).toBe("claims_empty");
  });

  it("refuses a claim with a blank or non-string statement", () => {
    expect(
      refusal(() =>
        parseResubmittedAssessment(
          submission([{ statement: "   ", citations: ["candles.range_pct"] }]),
          bundle(),
        ),
      ).code,
    ).toBe("claim_statement_invalid");
  });

  it("requires EXACTLY the four contract fields, in both directions", () => {
    expect(RESUBMITTED_ASSESSMENT_FIELDS).toEqual([
      "strategy",
      "claims",
      "envelope",
      "duplicateKeyCheck",
    ]);

    // Missing one.
    const missing = refusal(() =>
      parseResubmittedAssessment(
        JSON.stringify({ strategy: "grid", claims: ONE_CLAIM, envelope: "envelope_object" }),
        bundle(),
      ),
    );
    expect(missing.code).toBe("missing_field");

    // One too many -- refused, never ignored.
    const extra = refusal(() =>
      parseResubmittedAssessment(submission(ONE_CLAIM, { latencyMs: 13_080 }), bundle()),
    );
    expect(extra.code).toBe("unexpected_field");
    expect(extra.message).toContain("latencyMs");
  });

  it("checks the two unverifiable audit fields against their unions", () => {
    expect(
      refusal(() =>
        parseResubmittedAssessment(submission(ONE_CLAIM, { envelope: "http" }), bundle()),
      ).code,
    ).toBe("envelope_not_recognised");

    expect(
      refusal(() =>
        parseResubmittedAssessment(submission(ONE_CLAIM, { duplicateKeyCheck: "skipped" }), bundle()),
      ).code,
    ).toBe("duplicate_key_check_not_recognised");
  });

  it("carries the two unverifiable audit fields through unchanged when they ARE valid", () => {
    const parsed = parseResubmittedAssessment(
      submission(ONE_CLAIM, { envelope: "bare_string", duplicateKeyCheck: "performed" }),
      bundle(),
    );
    expect(parsed.envelope).toBe("bare_string");
    expect(parsed.duplicateKeyCheck).toBe("performed");
  });

  it("runs the duplicate-key scan, which the model paths structurally cannot", () => {
    // The caller's own bytes are in hand, so `{"strategy":"dca","strategy":"grid"}`
    // is caught rather than silently resolving to "grid".
    const error = refusal(() =>
      parseResubmittedAssessment(
        '{"strategy":"dca","strategy":"grid","claims":' +
          JSON.stringify(ONE_CLAIM) +
          ',"envelope":"envelope_object","duplicateKeyCheck":"performed"}',
        bundle(),
      ),
    );
    expect(error.code).toBe("duplicate_key");
    expect(error.received).toBe("strategy");
  });

  it.each([
    ["", "empty_resubmission"],
    ["   ", "empty_resubmission"],
    ["not json at all", "not_json"],
    ['{"strategy":"grid",}', "not_json"],
    ["[]", "not_an_object"],
    ['"grid"', "not_an_object"],
    ["null", "not_an_object"],
    ["12", "not_an_object"],
  ])("refuses %s with %s", (text, code) => {
    expect(refusal(() => parseResubmittedAssessment(text, bundle())).code).toBe(code);
  });

  it("does not strip a markdown fence or dig JSON out of surrounding text", () => {
    const inner = submission(ONE_CLAIM);
    expect(refusal(() => parseResubmittedAssessment("```json\n" + inner + "\n```", bundle())).code).toBe(
      "not_json",
    );
    expect(
      refusal(() => parseResubmittedAssessment("here you go: " + inner, bundle())).code,
    ).toBe("not_json");
  });

  it("mutates neither the bundle nor the submitted text", () => {
    const b = bundle();
    const before = JSON.stringify(assessEvidenceOf(b));
    const text = submission(ONE_CLAIM);
    parseResubmittedAssessment(text, b);
    expect(JSON.stringify(assessEvidenceOf(b))).toBe(before);
    expect(text).toBe(submission(ONE_CLAIM));
  });
});
