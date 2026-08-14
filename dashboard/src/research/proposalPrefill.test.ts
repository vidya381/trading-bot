/**
 * The proposal → create-bot prefill: the field mapping for BOTH strategies, the
 * all-or-nothing identity rule, the staleness carry-over, and the one function
 * that can ever attach a `proposalId` to a request.
 *
 * ── WHAT THESE TESTS ARE FOR, AND WHAT NO TEST HERE CAN DO ──
 *
 * This project still has no jsdom, no testing-library, and `react-dom/server`
 * does not resolve in the Workers pool this suite runs in, so a test importing a
 * `.tsx` collects ZERO tests rather than failing (decision logs 44, 45, 46). That
 * is exactly why every decision this feature makes lives in this `.ts` file and
 * none of it lives in a component: `proposalPrefill.ts` is React-free and fully
 * driven here, while `ProposalCreateBotLink.tsx`, `ProposalPrefillBanner.tsx` and
 * the seven changed lines of `CreateBot.tsx` are verified by typecheck, a real
 * Vite build, a source-level guard (`prefill-does-not-approve.test.ts`) and the
 * operator's eyes.
 *
 * ── ⚠ THE DCA FIXTURE IS SYNTHETIC AND IS NOT VERIFICATION OF THE DCA PATH ──
 *
 * Every live derivation this project has ever produced is GRID -- entry 41's two,
 * entry 42's one, entry 44's render, entry 45's, entry 46's. Six. The DCA response
 * below is HAND-BUILT and is used ONLY to pin the mapping and the field lists,
 * exactly as decision log 45 labelled its own synthetic DCA fixture in three
 * places. It is explicitly NOT a claim that the DCA path works end to end, and
 * closing that gap needs a real live Derive call that happens to answer `dca`.
 *
 * What the DCA fixture DOES establish is worth stating, because it is the specific
 * bug this step is most likely to ship: grid and DCA BOTH have a parameter called
 * `stopLossPct`, and they are two different inputs in two different fieldsets of
 * the create-bot form (`gridStopLossPct` / `dcaStopLossPct`). A mapping that is
 * right for one and wrong for the other typechecks, renders, and creates a bot
 * with no stop-loss where a human saw one. That is testable without a live model
 * and it is tested here.
 */

import { describe, expect, it } from "vitest";
import type {
  DcaParams,
  DeriveResponse,
  EvidenceItem,
  GridParams,
} from "../api/research-types";
import {
  CREATE_BOT_PATH,
  WIRE_FIELDS,
  createBotHref,
  prefillSearchParams,
  prefillStaleness,
  readProposalPrefill,
  withProposalId,
  type ProposalPrefill,
} from "./proposalPrefill";
import {
  DCA_PROPOSAL_FIELDS,
  GRID_PROPOSAL_FIELDS,
} from "../../../src/research/proposal-shape";
import { DEFAULT_STALENESS_POLICY, priceThresholdFor } from "../../../src/research/staleness";

// ---------------------------------------------------------------------------
// Fixtures -- realistic values, taken from this project's own live runs
// ---------------------------------------------------------------------------

/** Decision log 42's real live derivation bracketed its own close: 62660.91 < 63757.71 < 64036.14. */
const CANDLES_FETCHED_AT = 1_755_000_000_000;
const CAPITAL_READ_AT = CANDLES_FETCHED_AT + 1_000;
const CONCENTRATION_READ_AT = CANDLES_FETCHED_AT + 2_000;
const FILTERS_FETCHED_AT = CANDLES_FETCHED_AT + 3_000;
const SELECTED_AT = CANDLES_FETCHED_AT + 4_000;

const evidence = (id: string): EvidenceItem => ({
  id,
  label: id,
  value: "63757.71",
  source: id,
});

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

function response(params: GridParams | DcaParams, overrides: Partial<DeriveResponse> = {}): DeriveResponse {
  const base: DeriveResponse = {
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
      candles: {
        outcome: "ok",
        value: {
          accountLabel: "gemini-main",
          exchange: "gemini",
          pair: "BTCUSD",
          interval: "1m",
          fetchedAt: CANDLES_FETCHED_AT,
          requestedSince: null,
          earliestOpenTime: CANDLES_FETCHED_AT - 7_200_000,
          earliestCloseTime: CANDLES_FETCHED_AT - 7_140_000,
          latestCloseTime: CANDLES_FETCHED_AT,
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
      concentration: {
        outcome: "ok",
        value: {
          accountLabel: "gemini-main",
          exchange: "gemini",
          pair: "BTCUSD",
          readAt: CONCENTRATION_READ_AT,
          rowsRead: 12,
          committedBots: 12,
          stoppedBots: 0,
          samePairBots: 12,
          samePairStoppedBots: 0,
          assessment: "no_concentration",
        },
      },
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
      claims: [{ statement: "The range is wide relative to the close.", citations: [evidence("candles.range_pct")] }],
      unverifiedOriginalCall: { envelope: "response_object", duplicateKeyCheck: "performed" },
    },
    derive: {
      strategy: params.strategy,
      proposal: {
        params,
        allocatedCapital: "400.00000000",
        capitalAsset: "USD",
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
  return { ...base, ...overrides };
}

/** The whole round trip a human's click really performs: encode, then decode. */
function roundTrip(derive: DeriveResponse): ProposalPrefill {
  const params = prefillSearchParams(derive);
  expect(params, "this fixture should produce a link").not.toBeNull();
  const prefill = readProposalPrefill(params!);
  expect(prefill, "the encoded link should decode").not.toBeNull();
  return prefill!;
}

// ---------------------------------------------------------------------------

describe("the wire field lists are the backend's own", () => {
  /*
   * The one place this module could silently drop a parameter. A field added to
   * the backend's list -- which is spec 21.4 Stage 3's own quotation, and is what
   * `checkParamsShape` requires to be present -- and not added to the encoder's
   * loop would simply never reach the form, and every other test here would still
   * pass because they all drive the encoder.
   */
  it("grid's wire fields equal GRID_PROPOSAL_FIELDS, element for element", () => {
    expect([...WIRE_FIELDS.grid].sort()).toEqual([...GRID_PROPOSAL_FIELDS].sort());
  });

  it("dca's wire fields equal DCA_PROPOSAL_FIELDS, element for element", () => {
    expect([...WIRE_FIELDS.dca].sort()).toEqual([...DCA_PROPOSAL_FIELDS].sort());
  });
});

describe("a GRID proposal pre-fills the form correctly", () => {
  it("maps every grid parameter to the form's own field name", () => {
    const prefill = roundTrip(response(GRID_PARAMS));

    expect(prefill.strategy).toBe("grid");
    expect(prefill.fields).toEqual({
      strategy: "grid",
      lowerBound: "62660.91",
      upperBound: "64036.14",
      gridLines: "8",
      spacing: "geometric",
      orderSize: "60.00000000",
      // ⚠ THE MAPPING THAT MATTERS. Grid's `stopLossPct` is `gridStopLossPct`.
      gridStopLossPct: "5.00000000",
      takeProfitAmount: "",
      breakoutTakeProfit: true,
      breakoutThresholdPct: "2.50000000",
    });
    // Nothing was missing and nothing was guessed.
    expect(prefill.incomplete).toEqual([]);
    expect(prefill.unrepresentable).toEqual([]);
  });

  it("carries the shared fields and the proposal's identity", () => {
    const prefill = roundTrip(response(GRID_PARAMS));
    expect(prefill.proposalId).toBe("prop-01JABCDEF");
    expect(prefill.accountLabel).toBe("gemini-main");
    expect(prefill.pair).toBe("BTCUSD");
    expect(prefill.capitalAsset).toBe("USD");
    expect(prefill.allocatedCapital).toBe("400.00000000");
    expect(prefill.generatedAt).toBe(SELECTED_AT);
  });

  it("⚠ a null optional is carried as UNSET, not as missing and not as a number", () => {
    // `takeProfitAmount` is null in the fixture: the proposal really did leave it
    // unset. That is a present value (`checkParamsShape`'s null-is-present rule),
    // so it must arrive as "" -- the form's own blank optional -- and must NOT be
    // reported as an incomplete prefill.
    const prefill = roundTrip(response(GRID_PARAMS));
    expect(prefill.fields.strategy === "grid" && prefill.fields.takeProfitAmount).toBe("");
    expect(prefill.incomplete).not.toContain("takeProfitAmount");
  });

  it("does not silently flip breakoutTakeProfit when the proposal turned it off", () => {
    // `Boolean("false")` is `true`, which is why the decoder is strict. A grid bot
    // quietly gaining an exit its proposal did not have is not a rounding error.
    const off: GridParams = { ...GRID_PARAMS, breakoutTakeProfit: false };
    const prefill = roundTrip(response(off));
    expect(prefill.fields.strategy === "grid" && prefill.fields.breakoutTakeProfit).toBe(false);
    expect(prefill.incomplete).toEqual([]);
  });

  it("keeps geometric spacing rather than falling back to the form's default", () => {
    const prefill = roundTrip(response(GRID_PARAMS));
    expect(prefill.fields.strategy === "grid" && prefill.fields.spacing).toBe("geometric");
    expect(prefill.incomplete).not.toContain("spacing");
  });
});

describe("a DCA proposal pre-fills the form correctly", () => {
  it("maps every DCA parameter to the form's own field name", () => {
    const prefill = roundTrip(response(DCA_PARAMS));

    expect(prefill.strategy).toBe("dca");
    expect(prefill.fields).toEqual({
      strategy: "dca",
      baseOrderSize: "100.00000000",
      additionalOrderSize: "150.00000000",
      stepMultiplier: "1.50000000",
      dropPct: "3.00000000",
      maxAdditionalBuys: "4",
      // ⚠ THE TWO MAPPINGS THAT MATTER. DCA's take-profit and stop-loss are
      // DIFFERENT form inputs from grid's, and its `stopLossPct` shares a name
      // with grid's while meaning a different box.
      dcaTakeProfitPct: "2.00000000",
      dcaStopLossPct: "20.00000000",
      autoRestart: true,
    });
    expect(prefill.incomplete).toEqual([]);
    expect(prefill.unrepresentable).toEqual([]);
  });

  it("⚠ the two strategies' `stopLossPct` reach DIFFERENT form fields", () => {
    /*
     * The decisive pairing, asserted together in one place rather than left to be
     * inferred from the two tests above. A single shared `stopLossPct` variable in
     * the mapping would pass one of those and fail here.
     */
    const grid = roundTrip(response(GRID_PARAMS)).fields;
    const dca = roundTrip(response(DCA_PARAMS)).fields;

    expect(grid.strategy).toBe("grid");
    expect(dca.strategy).toBe("dca");
    expect("gridStopLossPct" in grid).toBe(true);
    expect("dcaStopLossPct" in grid).toBe(false);
    expect("dcaStopLossPct" in dca).toBe(true);
    expect("gridStopLossPct" in dca).toBe(false);
  });

  it("carries maxAdditionalBuys as a string the form can hold, not a number", () => {
    // Every input on the create-bot form holds a string, and the form's own
    // `requireInteger` is what judges it. A number here would be a type error at
    // the call site and a `[object Object]`-class bug if it were not.
    const prefill = roundTrip(response(DCA_PARAMS));
    expect(prefill.fields.strategy === "dca" && prefill.fields.maxAdditionalBuys).toBe("4");
  });

  it("⚠ names a sellOnStopLoss the form cannot express rather than dropping it", () => {
    // The backend rejects `true` as unimplemented, so a real proposal cannot carry
    // it -- but "cannot legitimately" is not "cannot", and a value silently lost on
    // the way to a form is the failure this module is written against.
    const odd: DcaParams = { ...DCA_PARAMS, sellOnStopLoss: true };
    const prefill = roundTrip(response(odd));
    expect(prefill.unrepresentable).toEqual(["sellOnStopLoss"]);
  });

  it("does not report sellOnStopLoss when it is false, as every real proposal is", () => {
    expect(roundTrip(response(DCA_PARAMS)).unrepresentable).toEqual([]);
  });

  it("⚠ a DCA take-profit of null arrives EMPTY and flagged, so the form refuses it", () => {
    /*
     * FOUND BY INVESTIGATING A REPORTED FAULT THAT TURNED OUT NOT TO EXIST, and
     * kept because the underlying asymmetry it exposed is real and was previously
     * covered only by accident.
     *
     * `checkParamsShape`'s rule is "null is PRESENT, undefined is MISSING" — right
     * for grid, whose `takeProfitAmount` and `breakoutThresholdPct` are genuinely
     * optional and are emitted as null when unset (decision log 45 PART 5). DCA has
     * no such field: `decodeDcaParams` reads `takeProfitPct` with `money(...)`,
     * non-nullable, and spec 6.1/6.3 make it mandatory because it defines the
     * cycle's exit. So the shape check is STRICTLY MORE PERMISSIVE than the DCA
     * decoder for that field, and a hand-built DCA proposal carrying null passes it.
     *
     * That is not a hole here, and this test is what says so rather than leaving it
     * to be assumed: the null encodes to "", `text()` reports it as incomplete
     * rather than substituting anything, the banner names it, and the form's own
     * `requirePercentPositive` refuses to submit with "Required.". It fails closed
     * at three layers. Verified by running it, not by reading it.
     */
    const nullTakeProfit = { ...DCA_PARAMS, takeProfitPct: null } as unknown as DcaParams;
    const prefill = roundTrip(response(nullTakeProfit));
    expect(prefill.fields.strategy === "dca" && prefill.fields.dcaTakeProfitPct).toBe("");
    expect(prefill.incomplete).toContain("takeProfitPct");
  });
});

describe("the identity rule: values and their banner arrive together or not at all", () => {
  it("an ordinary /bots/new visit produces no prefill", () => {
    expect(readProposalPrefill(new URLSearchParams())).toBeNull();
  });

  it("⚠ refuses a URL carrying every parameter but no proposalId", () => {
    // The failure that would put model-derived numbers in front of a human with
    // nothing on screen saying where they came from.
    const params = prefillSearchParams(response(GRID_PARAMS))!;
    params.delete("proposalId");
    expect(readProposalPrefill(params)).toBeNull();
  });

  it("refuses an empty proposalId as firmly as a missing one", () => {
    const params = prefillSearchParams(response(GRID_PARAMS))!;
    params.set("proposalId", "   ");
    expect(readProposalPrefill(params)).toBeNull();
  });

  it("refuses a strategy that is not one of the two real ones", () => {
    const params = prefillSearchParams(response(GRID_PARAMS))!;
    params.set("strategy", "martingale");
    expect(readProposalPrefill(params)).toBeNull();
  });

  it("refuses a missing strategy", () => {
    const params = prefillSearchParams(response(GRID_PARAMS))!;
    params.delete("strategy");
    expect(readProposalPrefill(params)).toBeNull();
  });
});

describe("an unreadable field is left empty and NAMED, never guessed", () => {
  it("reports a missing required parameter instead of inventing one", () => {
    const params = prefillSearchParams(response(GRID_PARAMS))!;
    params.delete("orderSize");
    const prefill = readProposalPrefill(params)!;
    expect(prefill.fields.strategy === "grid" && prefill.fields.orderSize).toBe("");
    expect(prefill.incomplete).toContain("orderSize");
  });

  it("reports an unreadable spacing rather than letting the default read as chosen", () => {
    const params = prefillSearchParams(response(GRID_PARAMS))!;
    params.set("spacing", "logarithmic");
    const prefill = readProposalPrefill(params)!;
    expect(prefill.fields.strategy === "grid" && prefill.fields.spacing).toBe("arithmetic");
    expect(prefill.incomplete).toContain("spacing");
  });

  it("reports an unreadable boolean rather than treating it as false", () => {
    const params = prefillSearchParams(response(GRID_PARAMS))!;
    params.set("breakoutTakeProfit", "yes");
    const prefill = readProposalPrefill(params)!;
    expect(prefill.incomplete).toContain("breakoutTakeProfit");
  });

  it("passes a junk NUMBER through verbatim so the form's own validator refuses it", () => {
    // Deliberate: dropping it would hide from the human that the URL claimed it.
    // `requirePositive` on the form is the thing that judges values.
    const params = prefillSearchParams(response(GRID_PARAMS))!;
    params.set("orderSize", "not-a-number");
    const prefill = readProposalPrefill(params)!;
    expect(prefill.fields.strategy === "grid" && prefill.fields.orderSize).toBe("not-a-number");
    expect(prefill.incomplete).not.toContain("orderSize");
  });

  it("falls back to the form's own USDT for a missing capital asset, and says so", () => {
    const params = prefillSearchParams(response(GRID_PARAMS))!;
    params.delete("capitalAsset");
    const prefill = readProposalPrefill(params)!;
    expect(prefill.capitalAsset).toBe("USDT");
    expect(prefill.incomplete).toContain("capitalAsset");
  });
});

describe("the link itself", () => {
  it("points at the real create-bot route", () => {
    const href = createBotHref(response(GRID_PARAMS))!;
    expect(href.startsWith(`${CREATE_BOT_PATH}?`)).toBe(true);
  });

  it("⚠ offers NO link when the params disagree with their own strategy label", () => {
    /*
     * The exact shape that took the proposal page to a blank black screen in
     * decision log 45: a `dca` label over grid-shaped params. Here it would prefill
     * `baseOrderSize` with `undefined` on the screen that commits capital, so the
     * same `checkParamsShape` guard refuses to build a link at all.
     */
    const mislabelled = response(GRID_PARAMS);
    const broken: DeriveResponse = {
      ...mislabelled,
      derive: {
        ...mislabelled.derive,
        proposal: {
          ...mislabelled.derive.proposal,
          params: { ...GRID_PARAMS, strategy: "dca" } as unknown as DcaParams,
        },
      },
    };
    expect(prefillSearchParams(broken)).toBeNull();
    expect(createBotHref(broken)).toBeNull();
  });
});

describe("staleness carries over, and is re-judged against the current clock", () => {
  const GRID_PRICE_THRESHOLD = priceThresholdFor("grid");
  const DCA_PRICE_THRESHOLD = priceThresholdFor("dca");

  it("carries all four real fetch times with their own thresholds", () => {
    const prefill = roundTrip(response(GRID_PARAMS));
    expect(prefill.stalenessInputs).toEqual([
      { key: "candles", at: CANDLES_FETCHED_AT, thresholdMs: GRID_PRICE_THRESHOLD },
      { key: "capital", at: CAPITAL_READ_AT, thresholdMs: DEFAULT_STALENESS_POLICY.capitalLedger },
      { key: "concentration", at: CONCENTRATION_READ_AT, thresholdMs: DEFAULT_STALENESS_POLICY.botList },
      { key: "filters", at: FILTERS_FETCHED_AT, thresholdMs: DEFAULT_STALENESS_POLICY.venueRules },
    ]);
  });

  it("⚠ carries the PER-STRATEGY price threshold, not always grid's", () => {
    // 15 minutes for grid, 60 for DCA. A call site that indexed `priceHistory.grid`
    // while holding a strategy variable would compile and read correctly in review.
    const dca = roundTrip(response(DCA_PARAMS));
    expect(dca.stalenessInputs[0]).toEqual({
      key: "candles",
      at: CANDLES_FETCHED_AT,
      thresholdMs: DCA_PRICE_THRESHOLD,
    });
    expect(DCA_PRICE_THRESHOLD).not.toBe(GRID_PRICE_THRESHOLD);
  });

  it("a proposal that was fresh at the click is fresh on arrival", () => {
    const prefill = roundTrip(response(GRID_PARAMS));
    expect(prefillStaleness(prefill, CANDLES_FETCHED_AT + 60_000).verdict).toBe("fresh");
  });

  it("⚠ a STALE-flagged proposal cannot arrive here looking fresh", () => {
    // The requirement this step was given in as many words. Ages only increase, so
    // a proposal past its price threshold on the proposal page is past it here.
    const prefill = roundTrip(response(GRID_PARAMS));
    const past = CANDLES_FETCHED_AT + GRID_PRICE_THRESHOLD + 1;
    const staleness = prefillStaleness(prefill, past);
    expect(staleness.verdict).toBe("stale");
    expect(staleness.staleInputs.map((i) => i.key)).toEqual(["candles"]);
  });

  it("⚠ flags a proposal that goes stale WHILE the form is being filled in", () => {
    // The half a carried verdict word could not do, and the case decision log 45
    // observed for real: a control file that went stale by the passage of real
    // time while the operator worked, re-flagged unprompted.
    const prefill = roundTrip(response(GRID_PARAMS));
    expect(prefillStaleness(prefill, CANDLES_FETCHED_AT + GRID_PRICE_THRESHOLD).verdict).toBe("fresh");
    expect(prefillStaleness(prefill, CANDLES_FETCHED_AT + GRID_PRICE_THRESHOLD + 1).verdict).toBe("stale");
  });

  it("⚠ THE 7.8-HOUR CASE: fresh at generation, opened much later, reads STALE", () => {
    /*
     * The scenario decision log 45 measured for real rather than a constructed
     * one: `pendingMs: 28013070` -- 7 hours 46 minutes 53 seconds between a real
     * proposal and the human decision on it, on the operator's own live run.
     *
     * This is the failure mode the whole carry-the-fetch-times-not-the-verdict
     * design exists to prevent. A banner that displayed a verdict computed when
     * `/derive` ran would say "fresh" here -- because the proposal genuinely WAS
     * fresh when it was generated -- on the screen where capital is committed,
     * nearly eight hours after the price window behind every bound stopped being
     * current. The verdict must be a function of the clock at RENDER time.
     */
    const PENDING_MS = 28_013_070; // entry 45's real, unstaged figure.
    const prefill = roundTrip(response(GRID_PARAMS));

    // At generation time it was genuinely fresh, so this test is not vacuous:
    // the "stale" below is the passage of time, not a proposal that was always bad.
    expect(prefillStaleness(prefill, CANDLES_FETCHED_AT).verdict).toBe("fresh");

    const openedLater = CANDLES_FETCHED_AT + PENDING_MS;
    const staleness = prefillStaleness(prefill, openedLater);
    expect(staleness.verdict).toBe("stale");
    // And it names the price window specifically, with a real elapsed age --
    // not a flag, an actual measurement against the current clock.
    expect(staleness.staleInputs.map((i) => i.key)).toContain("candles");
    expect(staleness.staleInputs.find((i) => i.key === "candles")!.ageMs).toBe(PENDING_MS);

    // ⚠ THE CAPITAL LEDGER TRIPS TOO, and the bot list and venue rules do NOT --
    // 1 hour, 24 hours and 7 days. Four inputs against four different thresholds
    // at one instant, which is the whole reason a single verdict word could not
    // have been carried even if it were recomputed.
    expect(staleness.staleInputs.map((i) => i.key).sort()).toEqual(["candles", "capital"]);
  });

  it("⚠ the verdict tracks the clock, so the SAME prefill answers differently over time", () => {
    // Nothing is memoised, frozen or cached on the prefill: one object, four
    // instants, four honest answers. A snapshot implementation returns the same
    // verdict for every `now` and fails here.
    const prefill = roundTrip(response(GRID_PARAMS));
    const at = (ms: number) => prefillStaleness(prefill, CANDLES_FETCHED_AT + ms).verdict;
    expect([at(0), at(14 * 60_000), at(16 * 60_000), at(28_013_070)]).toEqual([
      "fresh",
      "fresh",
      "stale",
      "stale",
    ]);
  });

  it("a DCA proposal at 20 minutes is FRESH where a grid one would be stale", () => {
    // The pair of cases a single shared threshold gets exactly backwards.
    const at20m = CANDLES_FETCHED_AT + 20 * 60_000;
    expect(prefillStaleness(roundTrip(response(DCA_PARAMS)), at20m).verdict).toBe("fresh");
    expect(prefillStaleness(roundTrip(response(GRID_PARAMS)), at20m).verdict).toBe("stale");
  });

  it("⚠ a stripped freshness parameter reads as UNKNOWN, never as fresh", () => {
    // Fail closed. `worstVerdict` answers `unknown` for an empty set precisely so
    // that removing the evidence cannot launder a stale proposal into a clean one.
    const params = prefillSearchParams(response(GRID_PARAMS))!;
    params.delete("freshness");
    const prefill = readProposalPrefill(params)!;
    expect(prefill.stalenessInputs).toEqual([]);
    expect(prefill.incomplete).toContain("freshness");
    expect(prefillStaleness(prefill, CANDLES_FETCHED_AT).verdict).toBe("unknown");
  });

  it("a mangled freshness triple is dropped rather than half-read", () => {
    const params = prefillSearchParams(response(GRID_PARAMS))!;
    params.set("freshness", `candles:${CANDLES_FETCHED_AT}:not-a-number,capital::3600000`);
    const prefill = readProposalPrefill(params)!;
    // The candles triple had an unreadable threshold, so there is nothing to
    // compare it against and it is not among the inputs at all. The capital one
    // has a real threshold and a null fetch time, which is `unknown`.
    expect(prefill.stalenessInputs).toEqual([{ key: "capital", at: null, thresholdMs: 3_600_000 }]);
    expect(prefillStaleness(prefill, CANDLES_FETCHED_AT).verdict).toBe("unknown");
  });

  it("an input that never fetched is unknown, and unknown is not fresh", () => {
    const noCandles = response(GRID_PARAMS);
    const failed: DeriveResponse = {
      ...noCandles,
      bundle: {
        ...noCandles.bundle,
        candles: {
          outcome: "failed",
          error: { code: "no_candles_returned", message: "the venue returned an empty window" },
          failedAt: CANDLES_FETCHED_AT,
        },
      },
    };
    const prefill = roundTrip(failed);
    expect(prefillStaleness(prefill, CANDLES_FETCHED_AT).verdict).toBe("unknown");
  });

  it("a fetch time ahead of this browser's clock is fresh, not stale", () => {
    // Ordinary Worker/browser clock skew. Treating the future as stale would flag a
    // proposal made seconds ago on a machine whose clock is a second behind.
    const prefill = roundTrip(response(GRID_PARAMS));
    expect(prefillStaleness(prefill, CANDLES_FETCHED_AT - 5_000).verdict).toBe("fresh");
  });
});

describe("withProposalId -- the ONLY thing that attaches the outcome link", () => {
  const body = { botInstanceId: "bot-abc123", accountLabel: "gemini-main" } as const;

  it("attaches the id for a real submission", () => {
    expect(withProposalId(body, "prop-01JABCDEF")).toEqual({
      botInstanceId: "bot-abc123",
      accountLabel: "gemini-main",
      proposalId: "prop-01JABCDEF",
    });
  });

  it("⚠ OMITS the field entirely for a manual creation -- absent, not null", () => {
    /*
     * `POST /api/bots` reads it with `optionalString`, and decision log 45's whole
     * response-shape design turns on an ordinary creation being byte-identical to
     * what it was before this field existed. `proposalId: null` is a DIFFERENT
     * request from no `proposalId`.
     */
    const result = withProposalId(body, null);
    expect(result).toEqual(body);
    expect("proposalId" in result).toBe(false);
  });

  it("treats a blank id as no id rather than sending an empty string", () => {
    expect("proposalId" in withProposalId(body, "   ")).toBe(false);
  });

  it("does not mutate the request it is given", () => {
    const original = { ...body };
    withProposalId(original, "prop-01JABCDEF");
    expect(original).toEqual(body);
    expect("proposalId" in original).toBe(false);
  });
});
