/**
 * The citation-classification rule, checked against the REAL evidence the
 * backend's two prompt builders actually emit.
 *
 * ── WHY THIS TEST IMPORTS BACKEND SOURCE ──
 *
 * `classifyCitation` is a rule ABOUT `EvidenceItem.source`, and its whole value
 * depends on that rule matching the strings `assess-prompt.ts` and
 * `derive-prompt.ts` really produce. A test written against hand-typed source
 * strings would pin the dashboard's belief about the backend rather than the
 * backend, and would keep passing on the day a new slot is added or a source
 * path is renamed -- while the UI silently started labelling a missing input as
 * fetched data. That is the exact failure decision log 43 placed this
 * requirement here to prevent, so the test drives the real builders over real
 * bundles in every outcome state they have.
 *
 * The crossing is read-only, test-only, and pure: `buildAssessPrompt` and
 * `buildDerivePrompt` take no ports, no clock and no I/O. The fixtures are
 * adapted from `src/research/assess-prompt.test.ts` and
 * `src/research/derive-prompt.test.ts`.
 *
 * ── WHICH RUNNER THIS RUNS UNDER ──
 *
 * The dashboard has NO test runner of its own -- `dashboard/package.json` has
 * only dev / build / preview / typecheck, and no vitest, jsdom or testing-library
 * dependency. This file is picked up by the ROOT vitest suite, whose default
 * include glob reaches `dashboard/src`, and it runs inside the Workers pool like
 * every other test here. That works because the two modules under test are pure
 * TypeScript with no React and no DOM. A COMPONENT test is still not possible in
 * this repository, and nothing here claims otherwise: what is covered below is
 * the classification logic, not the rendering.
 */

import { describe, expect, it } from "vitest";

import { buildAssessPrompt, type EvidenceItem } from "../../src/research/assess-prompt";
import { buildDerivePrompt } from "../../src/research/derive-prompt";
import type { ParsedAssessment } from "../../src/research/assess-parse";
import { CandleWindowError, type CandleWindow } from "../../src/research/candles";
import { ResearchCapitalError, type AccountCapital } from "../../src/research/capital";
import {
  ConcentrationError,
  assessConcentration,
  type AccountExposure,
  type ExposureBot,
} from "../../src/research/concentration";
import type { Candidate } from "../../src/research/candidates";
import {
  NEWS_NOT_YET_AVAILABLE,
  type CandidateGatherBundle,
  type DeriveContext,
} from "../../src/research/gather";
import type { Candle, SymbolFilters, Timestamp } from "../../src/shared/exchange-client";
import { ONE } from "../../src/shared/money";

import {
  classesIn,
  classifyCitation,
  noFetchedDataWarning,
  restsOnNoFetchedData,
  type CitationClass,
} from "./citations";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const T0 = 1_930_000_000_000;
const MINUTE = 60_000;
const FETCHED_AT = 1_940_000_000_000;
const PAIR = "ZZQUSD";

const candidate: Candidate = {
  accountLabel: "gemini-main",
  exchange: "gemini",
  pair: PAIR,
  sources: [
    {
      kind: "watchlist",
      entryId: "wl-7",
      note: "operator wanted a second look",
      addedBy: "operator@example.com",
      addedAt: T0 - 3 * MINUTE,
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

const CANDLES = [candle(T0, 100n * ONE), candle(T0 + MINUTE, 101n * ONE)];

function window(candles: readonly Candle[]): CandleWindow {
  return {
    accountLabel: candidate.accountLabel,
    exchange: candidate.exchange,
    pair: PAIR,
    interval: "1m",
    candles: [...candles],
    fetchedAt: FETCHED_AT,
    requestedSince: null,
    earliestOpenTime: candles[0]?.openTime ?? T0,
    earliestCloseTime: candles[0]?.closeTime ?? T0,
    latestCloseTime: candles[candles.length - 1]?.closeTime ?? T0,
    truncated: false,
    missingHistoryMs: null,
  };
}

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

const flaggedBots: ExposureBot[] = [
  { id: "b-1", pair: PAIR, capitalAsset: "USD", allocatedCapital: 50n * ONE, status: "running", archived: false },
  { id: "b-2", pair: PAIR, capitalAsset: "USD", allocatedCapital: 50n * ONE, status: "running", archived: false },
];

function bundle(overrides: Partial<CandidateGatherBundle> = {}): CandidateGatherBundle {
  return {
    candidate,
    candles: { outcome: "ok", value: window(CANDLES) },
    news: NEWS_NOT_YET_AVAILABLE,
    concentration: { outcome: "ok", value: assessConcentration(exposure(flaggedBots), candidate) },
    assembledAt: T0,
    ...overrides,
  };
}

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
  fetchedAt: FETCHED_AT,
};

function context(overrides: Partial<DeriveContext> = {}): DeriveContext {
  return {
    bundle: bundle(),
    capital: { outcome: "ok", value: capital },
    filters: { outcome: "ok", value: filters },
    gatheredAt: T0 + 9_000,
    ...overrides,
  };
}

function assessment(): ParsedAssessment {
  const item = buildAssessPrompt(bundle()).evidence.find((e) => e.id === "candles.range_pct")!;
  return {
    strategy: "grid",
    claims: [
      { statement: "the window moves inside a narrow band", citations: [item] },
      { statement: "the window is short", citations: [item] },
    ],
    envelope: "envelope_object",
    duplicateKeyCheck: "unavailable_transport_parsed",
  };
}

/** Group a real evidence set by the class the dashboard rule assigns it. */
function idsByClass(evidence: readonly EvidenceItem[]): Record<CitationClass, string[]> {
  const grouped: Record<CitationClass, string[]> = {
    fetched_data: [],
    absence_marker: [],
    prior_stage_claim: [],
  };
  for (const item of evidence) grouped[classifyCitation(item)].push(item.id);
  return grouped;
}

const item = (source: string): EvidenceItem => ({ id: "x", label: "l", value: "v", source });

// ---------------------------------------------------------------------------
// The partition itself
// ---------------------------------------------------------------------------

describe("every real evidence item lands in exactly one class", () => {
  it("classifies a whole successful Assess prompt with no absence markers but news", () => {
    const grouped = idsByClass(buildAssessPrompt(bundle()).evidence);

    // The paused news slot is the ONLY absence marker when nothing failed. It is
    // permanent today: no news vendor has been chosen (decision log 30).
    expect(grouped.absence_marker).toEqual(["news.status"]);
    // Stage 2 has no earlier stage to cite.
    expect(grouped.prior_stage_claim).toEqual([]);
    // Everything else is real data, and there is plenty of it.
    expect(grouped.fetched_data).toContain("candles.last_close");
    expect(grouped.fetched_data).toContain("concentration.assessment");
    expect(grouped.fetched_data).toContain("bundle.assembled_at");
    expect(grouped.fetched_data.length).toBeGreaterThan(15);
  });

  it("counts every item exactly once, with no id in two classes", () => {
    const evidence = buildAssessPrompt(bundle()).evidence;
    const grouped = idsByClass(evidence);
    const total =
      grouped.fetched_data.length + grouped.absence_marker.length + grouped.prior_stage_claim.length;

    expect(total).toBe(evidence.length);
    expect(new Set([...grouped.fetched_data, ...grouped.absence_marker, ...grouped.prior_stage_claim]).size).toBe(
      evidence.length,
    );
  });
});

// ---------------------------------------------------------------------------
// (b) -- every failed-read arm the two builders can produce
// ---------------------------------------------------------------------------

describe("a failed read becomes an absence marker", () => {
  it("a refused candle fetch does", () => {
    const grouped = idsByClass(
      buildAssessPrompt(
        bundle({
          candles: {
            outcome: "failed",
            error: new CandleWindowError("candles_unavailable", "the venue refused"),
            failedAt: T0,
          },
        }),
      ).evidence,
    );

    expect(grouped.absence_marker).toContain("candles.status");
    expect(grouped.fetched_data).not.toContain("candles.status");
  });

  it("a candle fetch that THREW does, and is not dressed up as a refusal", () => {
    const prompt = buildAssessPrompt(
      bundle({
        candles: { outcome: "threw_unexpectedly", error: new Error("boom"), failedAt: T0 },
      }),
    );
    const status = prompt.evidence.find((e) => e.id === "candles.status")!;

    expect(classifyCitation(status)).toBe("absence_marker");
    expect(status.source).toBe("candles.error");
  });

  it("a failed concentration read does", () => {
    const grouped = idsByClass(
      buildAssessPrompt(
        bundle({
          concentration: {
            outcome: "failed",
            error: new ConcentrationError("bot_list_unreadable", "D1 said no"),
            failedAt: T0,
          },
        }),
      ).evidence,
    );

    expect(grouped.absence_marker).toEqual(
      expect.arrayContaining(["concentration.status", "news.status"]),
    );
  });

  it("a failed capital read and a failed filters read both do", () => {
    const grouped = idsByClass(
      buildDerivePrompt(
        context({
          capital: {
            outcome: "failed",
            error: new ResearchCapitalError("ledger_unreadable", "D1 said no"),
            failedAt: T0,
          },
          filters: { outcome: "failed", error: new Error("venue said no"), failedAt: T0 },
        }),
        assessment(),
      ).evidence,
    );

    expect(grouped.absence_marker).toEqual(
      expect.arrayContaining(["capital.status", "filters.status", "news.status"]),
    );
    expect(grouped.fetched_data).not.toContain("capital.status");
    expect(grouped.fetched_data).not.toContain("filters.status");
  });
});

// ---------------------------------------------------------------------------
// (c) -- the prior stage's own claims
// ---------------------------------------------------------------------------

describe("an earlier stage's claim is never mistaken for fetched data", () => {
  it("classifies assessment.strategy and every assessment.claim.N as (c)", () => {
    const grouped = idsByClass(buildDerivePrompt(context(), assessment()).evidence);

    expect(grouped.prior_stage_claim).toEqual([
      "assessment.strategy",
      "assessment.claim.1",
      "assessment.claim.2",
    ]);
  });

  it("keeps Stage 3's own real reads as (a) in the same prompt", () => {
    const grouped = idsByClass(buildDerivePrompt(context(), assessment()).evidence);

    expect(grouped.fetched_data).toEqual(
      expect.arrayContaining([
        "capital.status",
        "capital.row.01.available",
        "filters.min_quantity",
        "filters.fetched_at",
        "context.gathered_at",
      ]),
    );
  });
});

// ---------------------------------------------------------------------------
// The two precisions the rule is written around
// ---------------------------------------------------------------------------

describe("the two precisions, so a near-miss rule cannot creep back in", () => {
  it("matches the news slot by EXACT source, not by prefix", () => {
    // Today's real value.
    expect(classifyCitation(item("news"))).toBe("absence_marker");
    // What a chosen news vendor would emit for REAL fetched headlines. A prefix
    // test would call this an absence marker, which is the inversion this whole
    // module exists to prevent.
    expect(classifyCitation(item("news.value.articles[0].sentiment"))).toBe("fetched_data");
    // A future failed news read still lands correctly, via the suffix rule.
    expect(classifyCitation(item("news.error"))).toBe("absence_marker");
  });

  it("matches a failed read by the .error SUFFIX, so a fifth slot needs no edit here", () => {
    for (const source of ["candles.error", "concentration.error", "capital.error", "filters.error"]) {
      expect(classifyCitation(item(source))).toBe("absence_marker");
    }
    expect(classifyCitation(item("trending.error"))).toBe("absence_marker");
    // And nothing that merely CONTAINS the word is caught.
    expect(classifyCitation(item("candles.value.errorCount"))).toBe("fetched_data");
  });

  it("treats an unrecognised source as fetched data, which is the correct default", () => {
    // (a) is the large open-ended class -- every `*.value.*` path -- while (b)
    // and (c) are small and named.
    expect(classifyCitation(item("something.new.value.field"))).toBe("fetched_data");
  });
});

// ---------------------------------------------------------------------------
// ⚠ The two documented deviations, pinned rather than left to surprise someone
// ---------------------------------------------------------------------------

describe("the two branches that read as absence but classify as (a)", () => {
  it("candles ok-but-empty renders MISSING under a value source", () => {
    const prompt = buildAssessPrompt(bundle({ candles: { outcome: "ok", value: window([]) } }));
    const status = prompt.evidence.find((e) => e.id === "candles.status")!;

    // Documented in src/citations.ts. `assess-prompt.ts` states this branch is
    // unreachable in practice, and the rendered value still says MISSING in full
    // wherever it is shown -- but the source-based rule calls it (a).
    expect(status.value.startsWith("MISSING --")).toBe(true);
    expect(status.source).toBe("candles.value.candles");
    expect(classifyCitation(status)).toBe("fetched_data");
  });

  it("a capital read that succeeded and found no rows renders NONE under a value source", () => {
    const prompt = buildDerivePrompt(
      context({ capital: { outcome: "ok", value: { ...capital, rowsRead: 0, assets: [] } } }),
      assessment(),
    );
    const status = prompt.evidence.find((e) => e.id === "capital.status")!;

    // This one is arguably correctly (a): the read SUCCEEDED and found nothing,
    // and the value says "This is NOT a failed read" in its own words.
    expect(status.value.startsWith("NONE --")).toBe(true);
    expect(status.source).toBe("capital.value.assets");
    expect(classifyCitation(status)).toBe("fetched_data");
  });
});

// ---------------------------------------------------------------------------
// The field-level signal
// ---------------------------------------------------------------------------

describe("restsOnNoFetchedData", () => {
  const fetched = item("candles.value.candles[last].close");
  const absence = item("news");
  const prior = item("assessment.claims[0]");

  it("is false when any citation is real fetched data", () => {
    expect(restsOnNoFetchedData([fetched, absence, prior])).toBe(false);
    expect(restsOnNoFetchedData([fetched])).toBe(false);
  });

  it("is true for decision log 43's two live examples", () => {
    // "takeProfitAmount null -- because no news was collected"
    expect(restsOnNoFetchedData([absence])).toBe(true);
    // "gridLines 5 -- because an earlier stage judged the range tight"
    expect(restsOnNoFetchedData([prior])).toBe(true);
  });

  it("is false for an empty set, which the backend refuses before this layer", () => {
    expect(restsOnNoFetchedData([])).toBe(false);
  });

  it("names WHICH kind the reviewer is looking at", () => {
    expect(noFetchedDataWarning([absence])).toContain("MISSING or was NOT COLLECTED");
    expect(noFetchedDataWarning([prior])).toContain("earlier model stage's own claim");
    expect(noFetchedDataWarning([absence, prior])).toContain(
      "either a missing input or an earlier stage's judgement",
    );
  });
});

describe("classesIn", () => {
  it("returns the present classes in a fixed (a),(b),(c) order regardless of input order", () => {
    const a = item("candles.value.x");
    const b = item("news");
    const c = item("assessment.strategy");

    expect(classesIn([c, b, a])).toEqual(["fetched_data", "absence_marker", "prior_stage_claim"]);
    expect(classesIn([a, b, c])).toEqual(["fetched_data", "absence_marker", "prior_stage_claim"]);
    expect(classesIn([b])).toEqual(["absence_marker"]);
  });
});
