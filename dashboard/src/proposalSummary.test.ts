/**
 * THE SUMMARY CARD'S DECISIONS, DRIVEN AGAINST THE REAL LOGIC THEY CLAIM TO REUSE.
 *
 * ── WHAT THESE TESTS ARE ACTUALLY FOR ──
 *
 * The card sits at the TOP of the proposal page, which is the most trusted position
 * on it and the one a hurried reviewer reads instead of scrolling. Two of the four
 * things it shows are VERDICTS, and a wrong verdict there is worse than no card:
 *
 *   "concentration: clean" beside a proposal the real check FLAGGED, or beside one
 *   whose check never ran at all, is a reassurance the page has not earned.
 *
 *   "data: fresh" beside a proposal the real policy calls STALE is the same fault
 *   on the axis decision log 48 PART 3 measured at 7h 46m live.
 *
 * Neither would throw, neither would fail a typecheck, and neither is visible to
 * anyone not already holding the real answer. So the tests below do not assert that
 * the card produces a plausible verdict — they assert it produces THE SAME verdict
 * the panels further down the page produce, from the same functions, on the same
 * data. Where a value is hardcoded in an assertion it is ALSO cross-checked against
 * the real computation, so a mutant that hardcodes a verdict in the source has
 * nowhere to hide.
 *
 * ── ⚠ THE DCA FIXTURE IS SYNTHETIC AND IS LABELLED AS SUCH ──
 *
 * No live derivation this project has ever produced has answered `dca` — decision
 * logs 44, 45, 46 and 48 all state it, and this step does not narrow it. `DCA_PARAMS`
 * below is hand-built to `DcaParams`. It pins the FIELD MAPPING and the headline
 * selection. It is explicitly NOT a claim that the DCA path works end to end.
 *
 * ── WHAT NO TEST HERE COVERS, STATED SO IT IS NOT ASSUMED ──
 *
 * Nothing here mounts a component. The dashboard has no jsdom and no
 * testing-library, and a test importing a `.tsx` collects ZERO TESTS rather than
 * failing inside the Workers pool (decision logs 44, 45, 46, 48). So POSITION,
 * PROMINENCE, COLOUR and the `<details>` collapse behaviour are covered by
 * `proposal-summary-card.test.ts`'s source guard and by the operator's eyes — not
 * by an assertion on a rendered DOM.
 */

import { describe, expect, it } from "vitest";
import type {
  ConcentrationResult,
  DcaParams,
  DeriveResponse,
  EvidenceItem,
  GatheredInput,
  GridParams,
} from "./api/research-types";
import {
  CONCENTRATION_BADGE,
  HEADLINE_FIELDS,
  STALENESS_BADGE,
  concentrationVerdictOf,
  stalenessVerdictOf,
  summarize,
} from "./proposalSummary";
import { freshnessOf, stalenessFor } from "./proposal";
import { proposalFieldsOf } from "./proposalFields";
import { formatMoney } from "./format";
import {
  DCA_PROPOSAL_FIELDS,
  GRID_PROPOSAL_FIELDS,
} from "../../src/research/proposal-shape";
import { DEFAULT_STALENESS_POLICY, priceThresholdFor } from "../../src/research/staleness";

// ---------------------------------------------------------------------------
// Fixtures -- the same real live values decision log 42's derivation produced
// ---------------------------------------------------------------------------

const CANDLES_FETCHED_AT = 1_755_000_000_000;
const CAPITAL_READ_AT = CANDLES_FETCHED_AT + 1_000;
const CONCENTRATION_READ_AT = CANDLES_FETCHED_AT + 2_000;
const FILTERS_FETCHED_AT = CANDLES_FETCHED_AT + 3_000;
const SELECTED_AT = CANDLES_FETCHED_AT + 4_000;

/** A clock a moment after the newest fetch: everything comfortably inside threshold. */
const FRESH_NOW = SELECTED_AT + 1_000;

const evidence = (id: string): EvidenceItem => ({ id, label: id, value: "63757.71", source: id });

/** Decision log 42's real live derivation bracketed its own close: 62660.91 < 63757.71 < 64036.14. */
const GRID_PARAMS: GridParams = {
  strategy: "grid",
  upperBound: "64036.14",
  lowerBound: "62660.91",
  gridLines: 8,
  spacing: "geometric",
  orderSize: "60.00000000",
  stopLossPct: "5.00000000",
  breakoutTakeProfit: true,
  breakoutThresholdPct: "2.50000000",
  takeProfitAmount: null,
};

/** ⚠ SYNTHETIC. See the module header: no live run has ever produced a DCA derivation. */
const DCA_PARAMS: DcaParams = {
  strategy: "dca",
  baseOrderSize: "100.00000000",
  additionalOrderSize: "150.00000000",
  stepMultiplier: "1.50000000",
  dropPct: "3.00000000",
  maxAdditionalBuys: 4,
  takeProfitPct: "2.00000000",
  stopLossPct: "20.00000000",
  autoRestart: true,
  sellOnStopLoss: false,
};

const CLEAN_CONCENTRATION: GatheredInput<ConcentrationResult> = {
  outcome: "ok",
  value: {
    accountLabel: "gemini-main",
    exchange: "gemini",
    pair: "BTCUSD",
    readAt: CONCENTRATION_READ_AT,
    rowsRead: 12,
    committedBots: 12,
    stoppedBots: 0,
    samePairBots: 0,
    samePairStoppedBots: 0,
    assessment: "no_concentration",
  },
};

/** Decision log 44's real live figures: 11 bots, 94.29% capital share. */
const FLAGGED_CONCENTRATION: GatheredInput<ConcentrationResult> = {
  outcome: "ok",
  value: {
    accountLabel: "gemini-main",
    exchange: "gemini",
    pair: "BTCUSD",
    readAt: CONCENTRATION_READ_AT,
    rowsRead: 11,
    committedBots: 11,
    stoppedBots: 0,
    samePairBots: 11,
    samePairStoppedBots: 0,
    assessment: "flagged",
    flags: [
      {
        code: "same_pair_bot_count",
        statement: "11 other bots already run on this pair.",
        observed: "11",
        threshold: "3",
        capitalAsset: null,
        basis: "base_asset",
      },
    ],
  },
};

/** The D1 read refused. `/assess` and `/derive` both let this through rather than failing. */
const FAILED_CONCENTRATION: GatheredInput<ConcentrationResult> = {
  outcome: "failed",
  error: { code: "bot_list_read_failed", message: "D1_ERROR: no such table: bot_instances" },
  failedAt: CONCENTRATION_READ_AT,
} as GatheredInput<ConcentrationResult>;

/** Something beneath the check threw -- NOT one of its enumerated refusals. */
const THREW_CONCENTRATION: GatheredInput<ConcentrationResult> = {
  outcome: "threw_unexpectedly",
  error: { name: "TypeError", message: "Cannot read properties of undefined" },
  failedAt: CONCENTRATION_READ_AT,
} as GatheredInput<ConcentrationResult>;

function response(
  params: GridParams | DcaParams,
  overrides: {
    concentration?: GatheredInput<ConcentrationResult>;
    candlesFetchedAt?: number | null;
    allocatedCapital?: string;
    capitalAsset?: string;
    rawParams?: unknown;
  } = {},
): DeriveResponse {
  const candlesAt = overrides.candlesFetchedAt === undefined ? CANDLES_FETCHED_AT : overrides.candlesFetchedAt;
  return {
    entryPoint: "named",
    selectedAt: SELECTED_AT,
    proposalId: "prop-01JABCDEF",
    bundle: {
      candidate: {
        accountLabel: "gemini-main",
        exchange: "gemini",
        pair: "BTCUSD",
        sources: [
          {
            kind: "named",
            requestedAs: "BTCUSD",
            requestedBy: "owner@example.com",
            requestedAt: SELECTED_AT,
          },
        ],
      },
      candles:
        candlesAt === null
          ? ({
              outcome: "failed",
              error: { code: "no_candles_returned", message: "the venue returned no window" },
              failedAt: CANDLES_FETCHED_AT,
            } as never)
          : {
              outcome: "ok",
              value: {
                accountLabel: "gemini-main",
                exchange: "gemini",
                pair: "BTCUSD",
                interval: "1m",
                fetchedAt: candlesAt,
                requestedSince: null,
                earliestOpenTime: candlesAt - 7_200_000,
                earliestCloseTime: candlesAt - 7_140_000,
                latestCloseTime: candlesAt,
                truncated: false,
                missingHistoryMs: null,
                count: 122,
                candles: [],
              },
            },
      news: {
        outcome: "not_yet_available",
        reason: "No news or sentiment vendor has been chosen.",
        decisionLogEntry: "30",
      },
      concentration: overrides.concentration ?? CLEAN_CONCENTRATION,
      assembledAt: SELECTED_AT,
    },
    context: {
      capital: {
        outcome: "ok",
        value: {
          accountLabel: "gemini-main",
          readAt: CAPITAL_READ_AT,
          rowsRead: 1,
          assets: [
            {
              asset: "USD",
              totalBalance: "10000.00000000",
              totalAllocated: "9500.00000000",
              available: "500.00000000",
              updatedAt: CAPITAL_READ_AT,
            },
          ],
        },
      },
      filters: {
        outcome: "ok",
        value: {
          pair: "BTCUSD",
          baseAsset: "BTC",
          quoteAsset: "USD",
          status: "TRADING",
          tickSize: "0.01000000",
          stepSize: "0.00000001",
          minQuantity: "0.00001000",
          minNotional: "0.00000000",
          fetchedAt: FILTERS_FETCHED_AT,
        },
      },
      gatheredAt: SELECTED_AT,
    },
    assessment: {
      source: "client_resubmitted",
      citationsReverified: true,
      strategy: params.strategy,
      claims: [
        {
          statement: "The range is wide relative to the close.",
          citations: [evidence("candles.range_pct")],
        },
      ],
      unverifiedOriginalCall: { envelope: "response_object", duplicateKeyCheck: "performed" },
    },
    derive: {
      strategy: params.strategy,
      proposal: {
        // `rawParams` exists so a deliberately malformed document can be driven
        // through the shape check, which is the branch that decides whether the
        // card prints numbers at all.
        params: (overrides.rawParams ?? params) as GridParams | DcaParams,
        allocatedCapital: overrides.allocatedCapital ?? "400.00000000",
        capitalAsset: overrides.capitalAsset ?? "USD",
        availableAtProposal: "500.00000000",
        referencePrice: "63757.71",
        minimumOrderCheck: "none_published",
        citations: {},
        allocatedCapitalCitations: [evidence("capital.row.01.available")],
        capitalAssetCitations: [evidence("capital.row.01.asset")],
      },
      notes: [],
      evidence: [evidence("candles.range_pct")],
      promptVersion: "derive/1",
      promptChars: 23_383,
      model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
      settings: { temperature: 0 },
      envelope: "response_object",
      duplicateKeyCheck: "performed",
      latencyMs: 77_344,
    },
  };
}

// ---------------------------------------------------------------------------
// Headline numbers
// ---------------------------------------------------------------------------

describe("headline numbers — grid", () => {
  it("shows the two bounds and the order size, in that order", () => {
    const summary = summarize(response(GRID_PARAMS), FRESH_NOW);

    expect(summary.ok).toBe(true);
    expect(summary.strategy).toBe("grid");
    expect(summary.headline.map((spec) => spec.field)).toEqual([
      "lowerBound",
      "upperBound",
      "orderSize",
    ]);
  });

  it("prints the real values off `GridParams`, formatted as the table below formats them", () => {
    const derive = response(GRID_PARAMS);
    const summary = summarize(derive, FRESH_NOW);
    const byField = new Map(summary.headline.map((spec) => [spec.field, spec.value]));

    // The literal strings a reviewer reads on the card...
    expect(byField.get("lowerBound")).toBe(formatMoney("62660.91"));
    expect(byField.get("upperBound")).toBe(formatMoney("64036.14"));
    expect(byField.get("orderSize")).toBe(formatMoney("60.00000000"));

    // ...and the same strings the full parameters table renders for the same
    // fields. THIS is the assertion that matters: a card formatting its own
    // numbers could print a different string for the same value than the table
    // forty lines below it, and the one a reviewer acted on would be whichever
    // they read first.
    const full = new Map(
      proposalFieldsOf(derive.derive.proposal.params).specs.map((spec) => [spec.field, spec]),
    );
    for (const spec of summary.headline) {
      expect(spec).toEqual(full.get(spec.field));
    }
  });

  it("carries the label and hint from the one field list, not a second copy", () => {
    const summary = summarize(response(GRID_PARAMS), FRESH_NOW);
    const lower = summary.headline.find((spec) => spec.field === "lowerBound");
    expect(lower?.label).toBe("Lower bound");
    const size = summary.headline.find((spec) => spec.field === "orderSize");
    expect(size?.label).toBe("Order size per line");
  });
});

describe("headline numbers — dca (⚠ synthetic fixture)", () => {
  it("shows base and additional order size and the drop percentage, in that order", () => {
    const summary = summarize(response(DCA_PARAMS), FRESH_NOW);

    expect(summary.ok).toBe(true);
    expect(summary.strategy).toBe("dca");
    expect(summary.headline.map((spec) => spec.field)).toEqual([
      "baseOrderSize",
      "additionalOrderSize",
      "dropPct",
    ]);
  });

  it("prints the real values off `DcaParams`, formatted as the table below formats them", () => {
    const derive = response(DCA_PARAMS);
    const summary = summarize(derive, FRESH_NOW);
    const byField = new Map(summary.headline.map((spec) => [spec.field, spec.value]));

    expect(byField.get("baseOrderSize")).toBe(formatMoney("100.00000000"));
    expect(byField.get("additionalOrderSize")).toBe(formatMoney("150.00000000"));
    // A PERCENT, not money -- the one headline field that is not a currency
    // amount, and the one a mutant swapping the two formatters would corrupt.
    expect(byField.get("dropPct")).toBe("3%");

    const full = new Map(
      proposalFieldsOf(derive.derive.proposal.params).specs.map((spec) => [spec.field, spec]),
    );
    for (const spec of summary.headline) {
      expect(spec).toEqual(full.get(spec.field));
    }
  });

  it("⚠ the two strategies do not share a single headline field", () => {
    // The failure this pins is a real one and it has a precedent: decision log
    // 48's mutant F4 swapped the two strategy branches of the prefill mapping and
    // was caught by 13 tests. A card reading grid's `orderSize` off a DCA proposal
    // would render nothing at all, which looks like a proposal with no numbers.
    const grid = new Set(HEADLINE_FIELDS.grid);
    for (const field of HEADLINE_FIELDS.dca) expect(grid.has(field)).toBe(false);
  });
});

describe("the headline field names are the backend's own", () => {
  it("every grid headline field exists in `GRID_PROPOSAL_FIELDS`", () => {
    // Driven off the BACKEND's list rather than a hand-typed one, for
    // `proposalFields.ts`'s reason: a headline field naming a key the backend
    // renamed would render nothing and would not fail to compile.
    for (const field of HEADLINE_FIELDS.grid) {
      expect(GRID_PROPOSAL_FIELDS).toContain(field);
    }
  });

  it("every dca headline field exists in `DCA_PROPOSAL_FIELDS`", () => {
    for (const field of HEADLINE_FIELDS.dca) {
      expect(DCA_PROPOSAL_FIELDS).toContain(field);
    }
  });

  it("no headline field is dropped for either real strategy", () => {
    // `summarize` drops a headline field `proposalFieldsOf` did not return, rather
    // than rendering it blank. That refusal must never actually fire on a real
    // response, and this is what says so.
    expect(summarize(response(GRID_PARAMS), FRESH_NOW).headline).toHaveLength(
      HEADLINE_FIELDS.grid.length,
    );
    expect(summarize(response(DCA_PARAMS), FRESH_NOW).headline).toHaveLength(
      HEADLINE_FIELDS.dca.length,
    );
  });
});

describe("a params object that fails the shape check gets NO headline numbers", () => {
  it("renders no fields and reports the claimed strategy", () => {
    // The exact document that took the whole page to a blank black screen before
    // `checkParamsShape` existed: a `dca` label over grid-shaped params.
    const broken = summarize(
      response(DCA_PARAMS, { rawParams: { ...GRID_PARAMS, strategy: "dca" } }),
      FRESH_NOW,
    );

    expect(broken.ok).toBe(false);
    expect(broken.strategy).toBeNull();
    expect(broken.headline).toEqual([]);
    expect(broken.claimedStrategy).toBe("dca");
  });

  it("an unrecognised strategy label produces no fields either", () => {
    const broken = summarize(
      response(GRID_PARAMS, { rawParams: { ...GRID_PARAMS, strategy: "martingale" } }),
      FRESH_NOW,
    );
    expect(broken.ok).toBe(false);
    expect(broken.headline).toEqual([]);
  });
});

describe("allocated capital", () => {
  it("is the amount and the asset, formatted as the parameters table formats them", () => {
    const summary = summarize(
      response(GRID_PARAMS, { allocatedCapital: "400.00000000", capitalAsset: "USD" }),
      FRESH_NOW,
    );
    expect(summary.allocatedCapital).toBe(`${formatMoney("400.00000000")} USD`);
  });

  it("carries a non-USD asset through rather than assuming one", () => {
    const summary = summarize(
      response(GRID_PARAMS, { allocatedCapital: "0.25000000", capitalAsset: "BTC" }),
      FRESH_NOW,
    );
    expect(summary.allocatedCapital).toContain("BTC");
    expect(summary.allocatedCapital).not.toContain("USD");
  });

  it("is present even when the shape check failed", () => {
    // The capital figure does not come from `params` and is not gated on the
    // shape check. A malformed parameter set should not blank out the one number
    // on the page denominated in real money the account holds.
    const broken = summarize(
      response(GRID_PARAMS, { rawParams: { strategy: "grid" } }),
      FRESH_NOW,
    );
    expect(broken.ok).toBe(false);
    expect(broken.allocatedCapital).toBe(`${formatMoney("400.00000000")} USD`);
  });
});

// ---------------------------------------------------------------------------
// The concentration badge -- the verdict, not an approximation of it
// ---------------------------------------------------------------------------

describe("the concentration badge matches the real verdict", () => {
  it("a flagged read is `flagged`", () => {
    expect(concentrationVerdictOf(FLAGGED_CONCENTRATION)).toBe("flagged");
    expect(summarize(response(GRID_PARAMS, { concentration: FLAGGED_CONCENTRATION }), FRESH_NOW)
      .concentration).toBe("flagged");
  });

  it("a clean read is `clean`", () => {
    expect(concentrationVerdictOf(CLEAN_CONCENTRATION)).toBe("clean");
    expect(summarize(response(GRID_PARAMS, { concentration: CLEAN_CONCENTRATION }), FRESH_NOW)
      .concentration).toBe("clean");
  });

  it("⚠ A FAILED READ IS `unknown`, AND IS NEVER `clean`", () => {
    /*
     * THE ASSERTION THIS WHOLE FILE EXISTS FOR, and the one the operator named by
     * hand when commissioning the card.
     *
     * `/assess` and `/derive` both let a failed concentration read through rather
     * than failing the request — a usable, grounded proposal should not be lost to
     * an unrelated D1 error — so this state reaches the page in ordinary
     * operation. `ProposalConcentration` has rendered it as a LOUD "NOT CHECKED"
     * since step 44 for exactly one reason, in its own words: *an unknown is not a
     * clean result.*
     *
     * A card that collapsed it into `clean` would put a green reassurance at the
     * top of the page precisely when nothing had established that it was true, and
     * the panel forty lines below would say the opposite. Both directions are
     * asserted: it IS unknown, and it is NOT clean.
     */
    expect(concentrationVerdictOf(FAILED_CONCENTRATION)).toBe("unknown");
    expect(concentrationVerdictOf(FAILED_CONCENTRATION)).not.toBe("clean");

    const summary = summarize(
      response(GRID_PARAMS, { concentration: FAILED_CONCENTRATION }),
      FRESH_NOW,
    );
    expect(summary.concentration).toBe("unknown");
    expect(summary.concentration).not.toBe("clean");
  });

  it("⚠ A READ THAT THREW IS `unknown`, AND IS NEVER `clean`", () => {
    // The second non-ok outcome, and the one that is not an enumerated refusal.
    // Tested separately rather than assumed to follow, because `outcome !== "ok"`
    // is one line and a mutant narrowing it to `=== "failed"` would let this
    // branch fall through to `clean`.
    expect(concentrationVerdictOf(THREW_CONCENTRATION)).toBe("unknown");
    expect(concentrationVerdictOf(THREW_CONCENTRATION)).not.toBe("clean");

    const summary = summarize(
      response(GRID_PARAMS, { concentration: THREW_CONCENTRATION }),
      FRESH_NOW,
    );
    expect(summary.concentration).toBe("unknown");
    expect(summary.concentration).not.toBe("clean");
  });

  it("the badge tracks the response rather than a constant", () => {
    // Four responses differing ONLY in the concentration slot must produce three
    // different verdicts. A hardcoded verdict passes every single-case assertion
    // above and fails this one.
    const verdicts = [
      CLEAN_CONCENTRATION,
      FLAGGED_CONCENTRATION,
      FAILED_CONCENTRATION,
      THREW_CONCENTRATION,
    ].map((concentration) => summarize(response(GRID_PARAMS, { concentration }), FRESH_NOW).concentration);

    expect(verdicts).toEqual(["clean", "flagged", "unknown", "unknown"]);
    expect(new Set(verdicts).size).toBe(3);
  });

  it("the verdict is read off the backend's own `assessment` field", () => {
    // Not recomputed from the counts. `samePairBots: 11` on a result the backend
    // called `no_concentration` must still read `clean` — this file applies no
    // threshold of its own and must never grow one, because the copy that drifts
    // from `src/research/concentration.ts` is the one nobody is watching.
    const contradictory: GatheredInput<ConcentrationResult> = {
      outcome: "ok",
      value: { ...FLAGGED_CONCENTRATION.value, assessment: "no_concentration" },
    } as GatheredInput<ConcentrationResult>;
    expect(concentrationVerdictOf(contradictory)).toBe("clean");
  });
});

// ---------------------------------------------------------------------------
// The staleness badge -- the backend's policy, recomputed at render
// ---------------------------------------------------------------------------

const GRID_PRICE_THRESHOLD = priceThresholdFor("grid");
const DCA_PRICE_THRESHOLD = priceThresholdFor("dca");

describe("the staleness badge matches the real verdict", () => {
  it("everything inside its own threshold is `fresh`", () => {
    expect(stalenessVerdictOf(response(GRID_PARAMS), FRESH_NOW)).toBe("fresh");
  });

  it("a price window past the grid threshold is `stale`", () => {
    const now = CANDLES_FETCHED_AT + GRID_PRICE_THRESHOLD + 1;
    expect(stalenessVerdictOf(response(GRID_PARAMS), now)).toBe("stale");
    expect(summarize(response(GRID_PARAMS), now).staleness).toBe("stale");
  });

  it("⚠ the boundary belongs to fresh, in both directions", () => {
    // `staleness.ts` states this and tests it; the card must not shift it by a
    // millisecond in either direction.
    const at = CANDLES_FETCHED_AT + GRID_PRICE_THRESHOLD;
    expect(stalenessVerdictOf(response(GRID_PARAMS), at)).toBe("fresh");
    expect(stalenessVerdictOf(response(GRID_PARAMS), at + 1)).toBe("stale");
  });

  it("⚠ the price threshold is the PROPOSAL'S strategy's, not a single number", () => {
    /*
     * Grid's price window goes stale at 15 minutes and DCA's at 60. A card that
     * looked the threshold up itself — or looked it up once — would call a
     * 20-minute-old DCA proposal stale and a 20-minute-old grid proposal fresh, one
     * of which is wrong whichever single number it picked.
     *
     * This is decision log 41's mutant D3 in a new place, and `priceThresholdFor`
     * exists so the lookup has one implementation.
     */
    expect(DCA_PRICE_THRESHOLD).toBeGreaterThan(GRID_PRICE_THRESHOLD);
    const between = CANDLES_FETCHED_AT + GRID_PRICE_THRESHOLD + 1_000;

    expect(stalenessVerdictOf(response(GRID_PARAMS), between)).toBe("stale");
    expect(stalenessVerdictOf(response(DCA_PARAMS), between)).toBe("fresh");
  });

  it("an input that never produced a fetch time is `unknown`, not `fresh`", () => {
    // The candle fetch failed, so there is no age to compare. `worstVerdict` ranks
    // unknown above fresh precisely so this cannot read as a clean bill of health.
    const summary = summarize(response(GRID_PARAMS, { candlesFetchedAt: null }), FRESH_NOW);
    expect(summary.staleness).toBe("unknown");
    expect(summary.staleness).not.toBe("fresh");
  });

  it("`stale` outranks `unknown` when both are present", () => {
    // A known-too-old input is a definite reason to refuse, so it wins. Driven at a
    // clock well past the capital ledger's own hour threshold with the candle slot
    // failed.
    const now = CAPITAL_READ_AT + DEFAULT_STALENESS_POLICY.capitalLedger + 1;
    const summary = summarize(response(GRID_PARAMS, { candlesFetchedAt: null }), now);
    expect(summary.staleness).toBe("stale");
  });

  it("⚠ a clock ahead of the fetch times is fresh, not stale", () => {
    // Ordinary Worker/browser skew. Treating the future as stale would flag a
    // proposal made seconds ago on a machine a second behind — decision log 48
    // PART 3's stated behaviour, held here too.
    expect(stalenessVerdictOf(response(GRID_PARAMS), CANDLES_FETCHED_AT - 5_000)).toBe("fresh");
  });

  it("⚠ IS THE SAME FUNCTION THE FRESHNESS PANEL BELOW RENDERS FROM", () => {
    /*
     * THE ANTI-DRIFT ASSERTION. The card and `ProposalFreshness` must never
     * disagree about the same proposal at the same instant, and the only way to
     * guarantee that is for the card to call what the panel calls.
     *
     * Swept across the whole interesting range rather than spot-checked, so a
     * mutant that is right at one clock and wrong at another has nowhere to sit.
     */
    for (const params of [GRID_PARAMS, DCA_PARAMS]) {
      const derive = response(params);
      for (const offset of [
        -5_000,
        0,
        1_000,
        GRID_PRICE_THRESHOLD - 1,
        GRID_PRICE_THRESHOLD,
        GRID_PRICE_THRESHOLD + 1,
        DCA_PRICE_THRESHOLD,
        DCA_PRICE_THRESHOLD + 1,
        DEFAULT_STALENESS_POLICY.capitalLedger + 1,
        DEFAULT_STALENESS_POLICY.botList + 1,
        DEFAULT_STALENESS_POLICY.venueRules + 1,
        28_013_070, // decision log 45's real measured proposal-to-decision gap.
      ]) {
        const now = CANDLES_FETCHED_AT + offset;
        expect(summarize(derive, now).staleness).toBe(stalenessFor(freshnessOf(derive), now).verdict);
      }
    }
  });

  it("⚠ the verdict is recomputed from `now`, never frozen", () => {
    /*
     * Decision log 48's mutant S4 in a new place: a verdict computed once and
     * carried would say "fresh" to the human decision entry 45 measured at 7h 46m
     * after generation, on the screen where capital is committed.
     *
     * One response, three clocks, three different answers.
     */
    const derive = response(GRID_PARAMS);
    expect(summarize(derive, FRESH_NOW).staleness).toBe("fresh");
    expect(summarize(derive, CANDLES_FETCHED_AT + 28_013_070).staleness).toBe("stale");
    expect(summarize(derive, CANDLES_FETCHED_AT).staleness).toBe("fresh");
  });
});

// ---------------------------------------------------------------------------
// The badge copy
// ---------------------------------------------------------------------------

describe("badge copy", () => {
  it("every concentration verdict has copy, and each says a different thing", () => {
    const labels = (["flagged", "clean", "unknown"] as const).map(
      (verdict) => CONCENTRATION_BADGE[verdict].label,
    );
    expect(new Set(labels).size).toBe(3);
    for (const label of labels) expect(label.length).toBeGreaterThan(0);
  });

  it("every staleness verdict has copy, and each says a different thing", () => {
    const labels = (["fresh", "stale", "unknown"] as const).map(
      (verdict) => STALENESS_BADGE[verdict].label,
    );
    expect(new Set(labels).size).toBe(3);
    for (const label of labels) expect(label.length).toBeGreaterThan(0);
  });

  it("⚠ `unknown` is styled exactly as loudly as `flagged` / `stale`, never as `clean` / `fresh`", () => {
    /*
     * WORDS AS WELL AS COLOUR, and the same colour weight for both non-clean
     * states. `ProposalConcentration`'s header makes the argument in full: the
     * failure mode is *a reviewer glancing at a quiet strip and reading "nothing
     * shown" as "nothing there"*. A quieter style on `unknown` would reintroduce
     * that in the most prominent position on the page, without changing a single
     * verdict — which is why the STYLE is asserted and not only the label.
     */
    expect(CONCENTRATION_BADGE.unknown.className).toBe(CONCENTRATION_BADGE.flagged.className);
    expect(CONCENTRATION_BADGE.unknown.className).not.toBe(CONCENTRATION_BADGE.clean.className);

    expect(STALENESS_BADGE.unknown.className).toBe(STALENESS_BADGE.stale.className);
    expect(STALENESS_BADGE.unknown.className).not.toBe(STALENESS_BADGE.fresh.className);
  });

  it("the two non-clean concentration labels carry a word, not only a colour", () => {
    expect(CONCENTRATION_BADGE.flagged.label).toContain("FLAGGED");
    expect(CONCENTRATION_BADGE.unknown.label).toContain("NOT CHECKED");
    expect(CONCENTRATION_BADGE.clean.label).toContain("clean");
  });

  it("the staleness labels match the words the freshness panel already uses", () => {
    expect(STALENESS_BADGE.stale.label).toContain("STALE");
    expect(STALENESS_BADGE.unknown.label.toLowerCase()).toContain("unknown");
    expect(STALENESS_BADGE.fresh.label).toContain("fresh");
  });

  it("⚠ the `unknown` copy states that it is not the same as being fine", () => {
    // The one sentence that does the work. `ProposalConcentration` and
    // `ProposalFreshness` both carry it below; a card that showed the badge
    // without it would be a shorter way to reach the same wrong conclusion.
    expect(CONCENTRATION_BADGE.unknown.title.toLowerCase()).toContain("not the same");
    expect(STALENESS_BADGE.unknown.title.toLowerCase()).toContain("not the same");
  });
});
