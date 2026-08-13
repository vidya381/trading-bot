/**
 * The proposal view's two deterministic reads over a real `/derive` response, and
 * the staleness verdict that now completes 21.5 requirement 4.
 *
 * The test lives in the ROOT vitest suite, importing the dashboard's module, for
 * the reason `citations.test.ts` and `dca-dashboard-parity.test.ts` already
 * established: the dashboard has no test runner of its own (`dashboard/package.json`
 * has only dev / build / preview / typecheck), and the root suite's default include
 * glob reaches `dashboard/src`. `proposal.ts` is plain TypeScript with no React, so
 * it imports cleanly.
 *
 * Four properties, each one this wiring would look correct without:
 *
 *  1. EACH INPUT IS PAIRED WITH ITS OWN THRESHOLD. This is the mutation that would
 *     be invisible: pairing the capital ledger's age against the price window's
 *     limit produces four plausible verdicts, three of them wrong, and no shape
 *     assertion notices.
 *  2. THE PRICE THRESHOLD FOLLOWS THE PROPOSAL'S STRATEGY. The same response with
 *     `derive.strategy` flipped gets a different limit.
 *  3. THE BACKEND'S POLICY IS THE ONE APPLIED, not a copy. Asserted by comparing
 *     against the imported constant rather than against literals typed here.
 *  4. THE THREE STATES SURVIVE TO THE RENDERER. A failed input is `unknown`, and
 *     the verdict a component reads says so.
 */

import { describe, expect, it } from "vitest";
import {
  DEFAULT_STALENESS_POLICY,
  priceThresholdFor,
} from "../../src/research/staleness";
import { dataLimits, freshnessOf, refreshAdvice, stalenessFor } from "./proposal";
import type {
  CandidateGatherBundle,
  DeriveContext,
  DeriveResponse,
} from "./api/research-types";

const NOW = 1_900_000_000_000;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Ages in ms; `null` means the input never produced a value. */
interface Ages {
  readonly candles: number | null;
  readonly capital: number | null;
  readonly concentration: number | null;
  readonly filters: number | null;
}

function bundleAt(ages: Ages): CandidateGatherBundle {
  return {
    candidate: {
      accountLabel: "main",
      exchange: "gemini",
      pair: "BTCUSD",
      sources: [{ kind: "named", requestedAs: "BTCUSD", requestedBy: "owner@example.com", requestedAt: NOW }],
    },
    candles:
      ages.candles === null
        ? { outcome: "failed", error: { code: "candles_unavailable", message: "venue timeout" }, failedAt: NOW }
        : {
            outcome: "ok",
            value: {
              accountLabel: "main",
              exchange: "gemini",
              pair: "BTCUSD",
              interval: "1m",
              fetchedAt: NOW - ages.candles,
              requestedSince: NOW - 2 * HOUR,
              count: 2,
              candles: [
                { openTime: NOW - 2 * MINUTE, closeTime: NOW - MINUTE, open: "100", high: "102", low: "99", close: "101", volume: "4", closed: true },
                { openTime: NOW - MINUTE, closeTime: NOW, open: "101", high: "103", low: "100", close: "102", volume: "4", closed: true },
              ],
              earliestOpenTime: NOW - 2 * MINUTE,
              earliestCloseTime: NOW - MINUTE,
              latestCloseTime: NOW,
              truncated: false,
              missingHistoryMs: null,
            },
          },
    news: { outcome: "not_yet_available", reason: "no vendor chosen", decisionLogEntry: "30" },
    concentration:
      ages.concentration === null
        ? { outcome: "failed", error: { code: "bot_list_unreadable", message: "D1 read failed" }, failedAt: NOW }
        : {
            outcome: "ok",
            value: {
              assessment: "no_concentration",
              readAt: NOW - ages.concentration,
              rowsRead: 3,
              committedBots: 3,
              stoppedBots: 0,
              policy: { samePairBotCountFlagAt: 2, assetCapitalShareFlagAtPct: "40.00000000" },
            },
          },
    assembledAt: NOW,
  } as unknown as CandidateGatherBundle;
}

function contextAt(ages: Ages): DeriveContext {
  return {
    capital:
      ages.capital === null
        ? { outcome: "failed", error: { code: "capital_unreadable", message: "D1 read failed" }, failedAt: NOW }
        : { outcome: "ok", value: { accountLabel: "main", readAt: NOW - ages.capital, assets: [{ asset: "USD" }] } },
    filters:
      ages.filters === null
        ? { outcome: "failed", error: { name: "Error", message: "filters unavailable" }, failedAt: NOW }
        : { outcome: "ok", value: { pair: "BTCUSD", status: "TRADING", fetchedAt: NOW - ages.filters } },
    gatheredAt: NOW,
  } as unknown as DeriveContext;
}

function response(ages: Ages, strategy: "grid" | "dca" = "grid"): DeriveResponse {
  return {
    entryPoint: "named",
    selectedAt: NOW,
    proposalId: "prop-1",
    bundle: bundleAt(ages),
    context: contextAt(ages),
    assessment: {
      source: "client_resubmitted",
      citationsReverified: true,
      strategy,
      claims: [],
      unverifiedOriginalCall: { envelope: "envelope_object", duplicateKeyCheck: "performed" },
    },
    derive: { strategy, proposal: {}, notes: [], evidence: [], promptVersion: "derive/1", promptChars: 100, model: "m", settings: {}, envelope: "envelope_object", duplicateKeyCheck: "unavailable_transport_parsed", latencyMs: 1 },
  } as unknown as DeriveResponse;
}

const FRESH: Ages = { candles: MINUTE, capital: MINUTE, concentration: MINUTE, filters: MINUTE };

// -- Property 1: each input against its OWN threshold -----------------------

describe("freshnessOf pairs each input with its own threshold", () => {
  it("uses the price, ledger, bot-list and venue thresholds, keyed to the right input", () => {
    const freshness = freshnessOf(response(FRESH));
    const byKey = new Map(freshness.thresholds.map((t) => [t.key, t.thresholdMs]));

    // Compared against the BACKEND's constants, not literals retyped here -- so a
    // policy change moves both sides together and a mis-pairing moves only one.
    expect(byKey.get("candles")).toBe(priceThresholdFor("grid"));
    expect(byKey.get("capital")).toBe(DEFAULT_STALENESS_POLICY.capitalLedger);
    expect(byKey.get("concentration")).toBe(DEFAULT_STALENESS_POLICY.botList);
    expect(byKey.get("filters")).toBe(DEFAULT_STALENESS_POLICY.venueRules);
    // All four distinct, so a swap cannot hide behind two equal numbers.
    expect(new Set(byKey.values()).size).toBe(4);
  });

  it("gives every threshold the same fetch time the matching `fetches` row has", () => {
    // The pairing that actually matters: the threshold rows and the age rows must
    // be about the same reads. A mutant that read `capital.value.readAt` into the
    // candles slot produces four valid-looking verdicts.
    const freshness = freshnessOf(response({ candles: 5 * MINUTE, capital: 2 * HOUR, concentration: 3 * HOUR, filters: 4 * HOUR }));
    for (const threshold of freshness.thresholds) {
      const fetch = freshness.fetches.find((f) => f.key === threshold.key);
      expect(fetch, `no fetches row for threshold ${threshold.key}`).toBeDefined();
      expect(threshold.at, `threshold ${threshold.key} is about a different read`).toBe(fetch!.at);
    }
  });

  it("has one threshold per fetch row and no extras", () => {
    const freshness = freshnessOf(response(FRESH));
    expect(freshness.thresholds.map((t) => t.key)).toEqual(freshness.fetches.map((f) => f.key));
  });
});

// -- Properties 2, 3, 4: the verdict ---------------------------------------

describe("stalenessFor", () => {
  it("calls a recent proposal fresh", () => {
    expect(stalenessFor(freshnessOf(response(FRESH)), NOW).verdict).toBe("fresh");
  });

  it("⚠ flags a 20-minute-old price window on a GRID proposal", () => {
    const staleness = stalenessFor(
      freshnessOf(response({ ...FRESH, candles: 20 * MINUTE }, "grid")),
      NOW,
    );
    expect(staleness.verdict).toBe("stale");
    expect(staleness.staleInputs.map((i) => i.key)).toEqual(["candles"]);
    // The age and the threshold both travel, so the banner can state them.
    expect(staleness.staleInputs[0]!.ageMs).toBe(20 * MINUTE);
    expect(staleness.staleInputs[0]!.thresholdMs).toBe(15 * MINUTE);
  });

  it("⚠ calls the SAME window fresh on a DCA proposal", () => {
    // Property 2: 21.7 open question 4's hypothesis, end to end through the
    // rendering path rather than only in the policy module.
    const staleness = stalenessFor(
      freshnessOf(response({ ...FRESH, candles: 20 * MINUTE }, "dca")),
      NOW,
    );
    expect(staleness.verdict).toBe("fresh");
  });

  it("⚠ does NOT flag a 2-hour-old venue-rules fetch, though it is the oldest input", () => {
    // The case a single threshold over `oldest` gets backwards.
    const freshness = freshnessOf(response({ candles: MINUTE, capital: 2 * MINUTE, concentration: 3 * MINUTE, filters: 2 * HOUR }));
    expect(freshness.oldest!.key).toBe("filters");
    expect(stalenessFor(freshness, NOW).verdict).toBe("fresh");
  });

  it("⚠ flags a price window that is NOT the oldest input", () => {
    const freshness = freshnessOf(response({ candles: 20 * MINUTE, capital: 25 * MINUTE, concentration: 30 * MINUTE, filters: 3 * HOUR }));
    expect(freshness.oldest!.key).toBe("filters");
    const staleness = stalenessFor(freshness, NOW);
    expect(staleness.verdict).toBe("stale");
    expect(staleness.staleInputs.map((i) => i.key)).toEqual(["candles"]);
  });

  it("flags a day-old bot list and a stale ledger read", () => {
    const staleness = stalenessFor(
      freshnessOf(response({ candles: MINUTE, capital: 2 * HOUR, concentration: DAY + MINUTE, filters: MINUTE })),
      NOW,
    );
    expect(staleness.staleInputs.map((i) => i.key).sort()).toEqual(["capital", "concentration"]);
  });

  it("⚠ reports a FAILED input as unknown, never as fresh (property 4)", () => {
    const staleness = stalenessFor(
      freshnessOf(response({ ...FRESH, capital: null })),
      NOW,
    );
    expect(staleness.verdict).toBe("unknown");
    expect(staleness.unknownInputs.map((i) => i.key)).toEqual(["capital"]);
    expect(staleness.inputs.find((i) => i.key === "capital")!.verdict).not.toBe("fresh");
  });

  it("prefers stale over unknown when both are present", () => {
    const staleness = stalenessFor(
      freshnessOf(response({ candles: 20 * MINUTE, capital: null, concentration: MINUTE, filters: MINUTE })),
      NOW,
    );
    expect(staleness.verdict).toBe("stale");
  });

  it("keeps every input in the verdict, so the table can render one row each", () => {
    const staleness = stalenessFor(freshnessOf(response(FRESH)), NOW);
    expect(staleness.inputs.map((i) => i.key)).toEqual(["candles", "capital", "concentration", "filters"]);
  });
});

// -- The refresh prompt requirement 4 asks for ------------------------------

describe("refreshAdvice", () => {
  it("names a distinct action for each input, and points at the two real endpoints", () => {
    const staleness = stalenessFor(
      freshnessOf(response({ candles: 20 * MINUTE, capital: 2 * HOUR, concentration: DAY + MINUTE, filters: 8 * DAY })),
      NOW,
    );
    expect(staleness.staleInputs).toHaveLength(4);
    const advice = staleness.staleInputs.map((input) => refreshAdvice(input));
    // Four genuinely different sentences, not one template with a name swapped:
    // refreshing a price window and re-reading a ledger are different actions.
    expect(new Set(advice).size).toBe(4);
    for (const line of advice) {
      expect(line).toContain("/assess");
      expect(line).toContain("/derive");
    }
    // Each one states the threshold it was measured against, so the number a
    // reviewer is being held to is on screen rather than implied.
    expect(advice[0]).toContain("15m 0s");
  });
});

// -- The step-44 behaviour this must not have broken ------------------------

describe("freshnessOf's existing output is unchanged", () => {
  it("still publishes four fetch rows, the price headline, and the oldest", () => {
    const freshness = freshnessOf(response({ candles: MINUTE, capital: 2 * MINUTE, concentration: 3 * MINUTE, filters: 4 * MINUTE }));
    expect(freshness.fetches.map((f) => f.key)).toEqual(["candles", "capital", "concentration", "filters"]);
    expect(freshness.priceFetch.key).toBe("candles");
    expect(freshness.oldest!.key).toBe("filters");
    // The three assembly times, still labelled as NOT fetch times.
    expect(freshness.assembly.map((a) => a.key)).toEqual(["selectedAt", "assembledAt", "gatheredAt"]);
  });

  it("still reports the data limits it did before, including the absent liquidity test", () => {
    const res = response(FRESH);
    const keys = dataLimits(res.bundle, res.context).map((limit) => limit.key);
    expect(keys).toContain("no_liquidity_test");
    expect(keys).toContain("no_news");
  });
});
