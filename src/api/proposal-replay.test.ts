/**
 * ⚠ THE FIDELITY TESTS — what a historical proposal preserves, and what it does not.
 *
 * The claim `proposal-replay.ts` makes is strong and is exactly the kind that reads
 * as true whether or not it is: that a row written days ago rebuilds into the
 * BYTE-IDENTICAL object the live endpoint returned. So it is not asserted against a
 * hand-typed expected object -- that would pin this module's BELIEF about the wire
 * shape rather than the wire shape, and would keep passing on the day
 * `serialize.ts` gained a field (`resubmission.test.ts`'s argument, one layer up).
 *
 * Instead the decisive tests here BUILD THE LIVE RESPONSE the way the handler
 * builds it, from the same functions, over the same result object, and compare.
 * `getAccountAssess` and `getAccountDerive` are three lines each in this respect:
 *
 *     const inputs    = deriveProposalInputsView(result, set.selectedAt);
 *     const reasoning = deriveProposalReasoningView(result, latencyMs);
 *     return ok({ entryPoint, selectedAt, proposalId, bundle: inputs.bundle,
 *                 context: inputs.context, assessment: inputs.assessment,
 *                 derive: deriveResultView(result, latencyMs) });
 *
 * and every test below reproduces that literally rather than describing it.
 *
 * ⚠ AND THE STORED PAYLOADS GO THROUGH `JSON.parse(JSON.stringify(...))` FIRST,
 * because that is not a formality -- it is precisely what `columns.ts`'s `json()`
 * codec does on the way into D1 and on the way out. A field holding `undefined`
 * disappears in that round trip and a field holding `null` does not, which is the
 * one class of loss that could exist here and is the reason the round trip is in
 * the test rather than assumed away.
 */

import { describe, expect, it } from "vitest";
import {
  assessProposalInputsView,
  assessProposalReasoningView,
  assessResultView,
  deriveProposalInputsView,
  deriveProposalReasoningView,
  deriveResultView,
} from "./serialize";
import {
  RECORD_ONLY_FIELDS,
  REPLAY_INPUT_FIELDS,
  REPLAY_STAGE_FIELDS,
  replayProposal,
} from "./proposal-replay";
import type {
  AssessResult,
  CandidateGatherBundle,
  DeriveContext,
  DeriveResult,
  ProposalRecord,
} from "../research";
import { fromDecimalString } from "../shared/money";

const T0 = 1_786_000_000_000;
const MINUTE = 60_000;
const FETCHED_AT = T0 - 30_000;
const SELECTED_AT = T0 - 90_000;
const LATENCY_MS = 14_428;
const HUMAN = "d.vidya381@gmail.com";

function m(value: string): bigint {
  return fromDecimalString(value);
}

const EVIDENCE = {
  id: "candles.range_pct",
  label: "Range",
  value: "1.98%",
  source: "candles.value.candles",
};

function candle(openTime: number, close: bigint) {
  return {
    pair: "BTCUSD",
    openTime,
    closeTime: openTime + MINUTE - 1,
    open: close - 1n,
    high: close + 2n,
    low: close - 3n,
    close,
    volume: 400_000_000n,
    closed: true,
  };
}

function bundle(): CandidateGatherBundle {
  return {
    candidate: {
      accountLabel: "gemini-main",
      exchange: "gemini",
      pair: "BTCUSD",
      sources: [{ kind: "named", requestedAs: "BTCUSD", requestedBy: HUMAN, requestedAt: T0 }],
    },
    candles: {
      outcome: "ok",
      value: {
        accountLabel: "gemini-main",
        exchange: "gemini",
        pair: "BTCUSD",
        interval: "1m",
        candles: [candle(T0 - 2 * MINUTE, m("62660.91")), candle(T0 - MINUTE, m("62912.34"))],
        fetchedAt: FETCHED_AT,
        requestedSince: null,
        earliestOpenTime: T0 - 2 * MINUTE,
        earliestCloseTime: T0 - MINUTE,
        latestCloseTime: T0,
        truncated: false,
        // ⚠ A REAL `null`, kept deliberately: it is the value that would vanish if
        // the storage round trip were lossy in the one direction it can be.
        missingHistoryMs: null,
      },
    },
    news: { outcome: "not_yet_available", reason: "no vendor chosen", decisionLogEntry: "30" },
    concentration: {
      outcome: "failed",
      error: { name: "ConcentrationError", code: "bot_list_unreadable", message: "D1 read failed" },
      failedAt: T0,
    },
    assembledAt: T0,
  } as CandidateGatherBundle;
}

function assessResult(overrides: Partial<AssessResult> = {}): AssessResult {
  return {
    strategy: "grid",
    claims: [{ statement: "The range is wide relative to the close.", citations: [EVIDENCE] }],
    // ⚠ THE TWO FIELDS THE BRIEF SUSPECTED OF BEING WIRE-ONLY. They are set to
    // distinctive values here so a test asserting them cannot pass by coincidence.
    envelope: "envelope_object",
    duplicateKeyCheck: "unavailable_transport_parsed",
    promptVersion: "assess/1",
    promptText: "THE ASSESS PROMPT, ALL SIXTEEN KILOBYTES OF IT",
    evidence: [EVIDENCE],
    model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    settings: {
      temperature: 0,
      seed: 20_260_811,
      maxTokens: 2_048,
      responseFormat: { type: "json_schema", json_schema: { name: "assess" } },
    },
    response: { text: { strategy: "grid" }, raw: { response: { strategy: "grid" } } },
    bundle: bundle(),
    ...overrides,
  } as AssessResult;
}

function deriveContext(): DeriveContext {
  return {
    bundle: bundle(),
    capital: {
      outcome: "ok",
      value: {
        accountLabel: "gemini-main",
        readAt: FETCHED_AT + 1_000,
        rowsRead: 1,
        assets: [
          {
            asset: "USD",
            totalBalance: m("10000"),
            totalAllocated: m("400"),
            available: m("9600"),
            updatedAt: FETCHED_AT,
          },
        ],
      },
    },
    filters: {
      outcome: "failed",
      error: new Error("filters unavailable (transport): timeout"),
      failedAt: T0,
    },
    gatheredAt: T0,
  } as DeriveContext;
}

function deriveResult(overrides: Partial<DeriveResult> = {}): DeriveResult {
  return {
    strategy: "grid",
    proposal: {
      params: {
        strategy: "grid",
        value: {
          upperBound: m("62912.34"),
          lowerBound: m("62660.91"),
          gridLines: 5,
          spacing: "arithmetic",
          orderSize: m("50"),
          stopLossPct: m("5"),
          breakoutTakeProfit: true,
          // Both optionals unset, so the view emits real `null`s -- entry 45's
          // "null is present, undefined is missing" rule has something to bite on.
          breakoutThresholdPct: null,
          takeProfitAmount: null,
        },
      },
      allocatedCapital: m("400"),
      capitalAsset: "USD",
      availableAtProposal: m("9600"),
      referencePrice: m("62912.34"),
    },
    citations: {
      parameters: { upperBound: { value: "62912.34", citations: [EVIDENCE] } },
      allocatedCapital: { value: "400", citations: [EVIDENCE] },
      capitalAsset: { value: "USD", citations: [EVIDENCE] },
    },
    notes: [{ statement: "The observed range sets the bounds.", citations: [EVIDENCE] }],
    envelope: "envelope_object",
    duplicateKeyCheck: "unavailable_transport_parsed",
    minimumOrderCheck: "quantity",
    promptVersion: "derive/1",
    promptText: "THE DERIVE PROMPT, ALL TWENTY-THREE KILOBYTES OF IT",
    evidence: [EVIDENCE],
    model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    settings: {
      temperature: 0,
      seed: 20_260_811,
      maxTokens: 4_096,
      responseFormat: { type: "json_schema", json_schema: { name: "derive" } },
    },
    response: { text: { strategy: "grid" }, raw: { response: { strategy: "grid" } } },
    assessment: {
      strategy: "grid",
      claims: [{ statement: "Wide range.", citations: [EVIDENCE] }],
      envelope: "envelope_object",
      duplicateKeyCheck: "performed",
    },
    context: deriveContext(),
    ...overrides,
  } as DeriveResult;
}

/** Exactly what `columns.ts`'s `json()` codec does to a payload, both ways. */
function throughD1<T>(value: T): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown;
}

function record(overrides: Partial<ProposalRecord> = {}): ProposalRecord {
  return {
    id: "prop-live-1",
    stage: "derive",
    accountLabel: "gemini-main",
    pair: "BTCUSD",
    entryPoint: "named",
    strategy: "grid",
    actor: HUMAN,
    model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    promptVersion: "derive/1",
    dataFetchedAt: FETCHED_AT,
    inputs: throughD1(deriveProposalInputsView(deriveResult(), SELECTED_AT)),
    reasoning: throughD1(deriveProposalReasoningView(deriveResult(), LATENCY_MS)),
    createdAt: T0,
    outcome: null,
    outcomeBotInstanceId: null,
    outcomeActor: null,
    outcomeAt: null,
    outcomeNote: null,
    ...overrides,
  };
}

function assessRecord(overrides: Partial<ProposalRecord> = {}): ProposalRecord {
  return record({
    id: "prop-assess-1",
    stage: "assess",
    promptVersion: "assess/1",
    inputs: throughD1(assessProposalInputsView(assessResult(), SELECTED_AT)),
    reasoning: throughD1(assessProposalReasoningView(assessResult(), LATENCY_MS)),
    ...overrides,
  });
}

/** The body `getAccountDerive` really returns, built the way that handler builds it. */
function liveDeriveResponse(result = deriveResult()): unknown {
  const inputs = deriveProposalInputsView(result, SELECTED_AT);
  return throughD1({
    entryPoint: "named" as const,
    selectedAt: SELECTED_AT,
    proposalId: "prop-live-1",
    bundle: inputs.bundle,
    context: inputs.context,
    assessment: inputs.assessment,
    derive: deriveResultView(result, LATENCY_MS),
  });
}

/** The body `getAccountAssess` really returns, built the way that handler builds it. */
function liveAssessResponse(result = assessResult()): unknown {
  const inputs = assessProposalInputsView(result, SELECTED_AT);
  return throughD1({
    entryPoint: "named" as const,
    selectedAt: SELECTED_AT,
    proposalId: "prop-assess-1",
    bundle: inputs.bundle,
    assess: assessResultView(result, LATENCY_MS),
  });
}

// ---------------------------------------------------------------------------
// THE DECISIVE TESTS: real response vs reconstructed response
// ---------------------------------------------------------------------------

describe("⚠ a stored derive row rebuilds into the response the live endpoint returned", () => {
  it("is deeply equal to the real /derive body, field for field", () => {
    const replay = replayProposal(record());
    expect(replay.ok).toBe(true);
    if (!replay.ok) return;
    expect(replay.response).toEqual(liveDeriveResponse());
  });

  it("carries the SAME TOP-LEVEL KEYS, in the same order, as the live body", () => {
    /*
     * `toEqual` above is order-insensitive and would pass on an object assembled in
     * a different order. Key order is not a correctness property of JSON, but it IS
     * the cheapest available proof that the reconstruction was written against the
     * handler's own literal rather than resembling it, and a reordering is the first
     * visible symptom of a field being rebuilt somewhere else.
     */
    const replay = replayProposal(record());
    if (!replay.ok) throw new Error("expected a replay");
    expect(Object.keys(replay.response)).toEqual(
      Object.keys(liveDeriveResponse() as Record<string, unknown>),
    );
  });

  it("⚠ preserves `envelope` and `duplicateKeyCheck` — the fields suspected of being wire-only", () => {
    /*
     * THE SPECIFIC CLAIM THE BRIEF ASKED TO BE CHECKED, and the answer is that the
     * premise does not hold: both are fields of `deriveResultView`, and
     * `deriveProposalReasoningView` is that view SPREAD plus two additions. They
     * were never wire-only, so there was never anything to lose.
     *
     * Named individually rather than left to the deep-equality test above, because
     * a future change that dropped one would fail here with a sentence that says
     * which, instead of a diff of a 300-key object.
     */
    const replay = replayProposal(record());
    if (!replay.ok || replay.stage !== "derive") throw new Error("expected a derive replay");
    expect(replay.response.derive.envelope).toBe("envelope_object");
    expect(replay.response.derive.duplicateKeyCheck).toBe("unavailable_transport_parsed");
  });

  it("preserves the other five fields a summary would have dropped", () => {
    const replay = replayProposal(record());
    if (!replay.ok || replay.stage !== "derive") throw new Error("expected a derive replay");
    expect(replay.response.derive.settings).toEqual({
      temperature: 0,
      seed: 20_260_811,
      maxTokens: 4_096,
      responseFormat: { type: "json_schema", json_schema: { name: "derive" } },
    });
    expect(replay.response.derive.latencyMs).toBe(LATENCY_MS);
    expect(replay.response.derive.promptVersion).toBe("derive/1");
    expect(replay.response.derive.promptChars).toBe(
      "THE DERIVE PROMPT, ALL TWENTY-THREE KILOBYTES OF IT".length,
    );
    expect(replay.response.derive.model).toBe("@cf/meta/llama-3.3-70b-instruct-fp8-fast");
  });

  it("preserves the full evidence set and the per-field citations, not a summary", () => {
    const replay = replayProposal(record());
    if (!replay.ok || replay.stage !== "derive") throw new Error("expected a derive replay");
    expect(replay.response.derive.evidence).toEqual([EVIDENCE]);
    expect(replay.response.derive.proposal.citations).toEqual({ upperBound: [EVIDENCE] });
    expect(replay.response.derive.notes).toEqual([
      { statement: "The observed range sets the bounds.", citations: [EVIDENCE] },
    ]);
  });

  it("preserves a `null` optional as null rather than losing the key", () => {
    /*
     * ⚠ THE ONE CLASS OF LOSS THE D1 ROUND TRIP COULD ACTUALLY CAUSE. `JSON.stringify`
     * drops a key whose value is `undefined` and keeps one whose value is `null`, and
     * entry 45's crash fix turns on exactly that difference: the view emits `null` for
     * an unset optional and never omits the key, and `ProposalParameters` reads
     * "absent" as a fault. If storage lost these two keys, a historical grid proposal
     * would render the shape-mismatch banner instead of its parameters.
     */
    const replay = replayProposal(record());
    if (!replay.ok || replay.stage !== "derive") throw new Error("expected a derive replay");
    const params = replay.response.derive.proposal.params as Record<string, unknown>;
    expect(Object.hasOwn(params, "breakoutThresholdPct")).toBe(true);
    expect(Object.hasOwn(params, "takeProfitAmount")).toBe(true);
    expect(params.breakoutThresholdPct).toBeNull();
    expect(params.takeProfitAmount).toBeNull();
    expect(
      (replay.response.bundle.candles as { value: { missingHistoryMs: unknown } }).value
        .missingHistoryMs,
    ).toBeNull();
  });

  it("preserves the resubmitted assessment with its provenance labels intact", () => {
    const replay = replayProposal(record());
    if (!replay.ok || replay.stage !== "derive") throw new Error("expected a derive replay");
    expect(replay.response.assessment.source).toBe("client_resubmitted");
    expect(replay.response.assessment.citationsReverified).toBe(true);
    expect(replay.response.assessment.unverifiedOriginalCall).toEqual({
      envelope: "envelope_object",
      duplicateKeyCheck: "performed",
    });
  });

  it("preserves Stage 3's own two reads (capital and filters), including the failed one", () => {
    const replay = replayProposal(record());
    if (!replay.ok || replay.stage !== "derive") throw new Error("expected a derive replay");
    expect(replay.response.context.capital.outcome).toBe("ok");
    expect(replay.response.context.filters).toEqual({
      outcome: "failed",
      error: { name: "Error", message: "filters unavailable (transport): timeout" },
      failedAt: T0,
    });
  });
});

describe("⚠ a stored assess row rebuilds into the response the live endpoint returned", () => {
  it("is deeply equal to the real /assess body, field for field", () => {
    const replay = replayProposal(assessRecord());
    expect(replay.ok).toBe(true);
    if (!replay.ok) return;
    expect(replay.response).toEqual(liveAssessResponse());
  });

  it("carries the same top-level keys, in the same order", () => {
    const replay = replayProposal(assessRecord());
    if (!replay.ok) throw new Error("expected a replay");
    expect(Object.keys(replay.response)).toEqual(
      Object.keys(liveAssessResponse() as Record<string, unknown>),
    );
  });

  it("preserves `envelope` and `duplicateKeyCheck` here too", () => {
    const replay = replayProposal(assessRecord());
    if (!replay.ok || replay.stage !== "assess") throw new Error("expected an assess replay");
    expect(replay.response.assess.envelope).toBe("envelope_object");
    expect(replay.response.assess.duplicateKeyCheck).toBe("unavailable_transport_parsed");
    expect(replay.response.assess.claims).toEqual([
      { statement: "The range is wide relative to the close.", citations: [EVIDENCE] },
    ]);
  });
});

// ---------------------------------------------------------------------------
// WHAT IS AND IS NOT ON THE WIRE: the two record-only fields
// ---------------------------------------------------------------------------

describe("⚠ the two fields the record has and no live response ever did", () => {
  it("are absent from the replayed stage object", () => {
    const replay = replayProposal(record());
    if (!replay.ok || replay.stage !== "derive") throw new Error("expected a derive replay");
    const stage = replay.response.derive as unknown as Record<string, unknown>;
    for (const field of RECORD_ONLY_FIELDS) {
      expect(Object.hasOwn(stage, field), `${field} leaked into the replayed wire shape`).toBe(
        false,
      );
    }
  });

  it("are published beside it, in full, rather than dropped", () => {
    // Withholding them would be the summarization section 8.7 forbids, from the one
    // endpoint that reads the record they exist for.
    const replay = replayProposal(record());
    if (!replay.ok) throw new Error("expected a replay");
    expect(replay.recordOnly.promptText).toBe(
      "THE DERIVE PROMPT, ALL TWENTY-THREE KILOBYTES OF IT",
    );
    expect(replay.recordOnly.response).toEqual({
      text: { strategy: "grid" },
      raw: { response: { strategy: "grid" } },
    });
  });

  it("are the assess row's own two, not the derive row's", () => {
    const replay = replayProposal(assessRecord());
    if (!replay.ok) throw new Error("expected a replay");
    expect(replay.recordOnly.promptText).toBe("THE ASSESS PROMPT, ALL SIXTEEN KILOBYTES OF IT");
  });
});

// ---------------------------------------------------------------------------
// THE FIELD LISTS ARE PINNED AGAINST THE REAL VIEWS, IN BOTH DIRECTIONS
// ---------------------------------------------------------------------------

describe("⚠ REPLAY_STAGE_FIELDS is pinned to what the real views emit", () => {
  it("equals `deriveResultView`'s own key set exactly", () => {
    /*
     * BOTH DIRECTIONS, and neither alone is enough. A missing name would make
     * `replayProposal` refuse a perfectly good record (it checks presence against
     * this list); an extra name would make it demand a field the view never emits.
     * The same two-way pin `staleness.ts` uses on its strategy union and
     * `resubmission.ts` uses on its four-field list.
     */
    expect([...REPLAY_STAGE_FIELDS.derive].sort()).toEqual(
      Object.keys(deriveResultView(deriveResult(), LATENCY_MS)).sort(),
    );
  });

  it("equals `assessResultView`'s own key set exactly", () => {
    expect([...REPLAY_STAGE_FIELDS.assess].sort()).toEqual(
      Object.keys(assessResultView(assessResult(), LATENCY_MS)).sort(),
    );
  });

  it("⚠ the reasoning view is exactly the stage view plus RECORD_ONLY_FIELDS", () => {
    /*
     * THE STRUCTURAL CLAIM THE WHOLE MODULE RESTS ON, asserted rather than argued:
     * `*ProposalReasoningView` is `{ ...*ResultView(...), promptText, response }`.
     * If a future edit added a third record-only field, this fails and the module's
     * "the record is a strict superset of the response" header stops being a claim
     * nobody checked.
     */
    for (const [stage, reasoningKeys, stageKeys] of [
      [
        "derive",
        Object.keys(deriveProposalReasoningView(deriveResult(), LATENCY_MS)),
        Object.keys(deriveResultView(deriveResult(), LATENCY_MS)),
      ],
      [
        "assess",
        Object.keys(assessProposalReasoningView(assessResult(), LATENCY_MS)),
        Object.keys(assessResultView(assessResult(), LATENCY_MS)),
      ],
    ] as const) {
      expect([...reasoningKeys].sort(), `${stage} reasoning view drifted`).toEqual(
        [...stageKeys, ...RECORD_ONLY_FIELDS].sort(),
      );
    }
  });

  it("REPLAY_INPUT_FIELDS equals what the real inputs views emit", () => {
    expect([...REPLAY_INPUT_FIELDS.derive].sort()).toEqual(
      Object.keys(deriveProposalInputsView(deriveResult(), SELECTED_AT)).sort(),
    );
    expect([...REPLAY_INPUT_FIELDS.assess].sort()).toEqual(
      Object.keys(assessProposalInputsView(assessResult(), SELECTED_AT)).sort(),
    );
  });
});

// ---------------------------------------------------------------------------
// THE SCALARS COME OFF THE ROW, NOT OFF THE PAYLOAD
// ---------------------------------------------------------------------------

describe("⚠ identity and entry point come off the COLUMNS", () => {
  it("takes `proposalId` from the row's id, so a copied payload cannot claim another id", () => {
    const replay = replayProposal(record({ id: "prop-different" }));
    if (!replay.ok) throw new Error("expected a replay");
    expect(replay.response.proposalId).toBe("prop-different");
  });

  it("⚠ takes `entryPoint` from the row, not from the live handler's hardcoded literal", () => {
    /*
     * `getAccountDerive` writes the LITERAL `"named"` into its response, because
     * that is the only door it serves. The COLUMN holds the real entry point, and
     * the CHECK constraint already names `watchlist` and `general` — deliberately,
     * because SQLite cannot widen a CHECK without rebuilding the permanent record.
     *
     * So a replay must read the column: if a watchlist or trending door is ever
     * opened, every row written through it replays truthfully, with no edit here.
     * Reading the literal instead would render every historical proposal as
     * "named" the day a second door produced one, and nothing would fail.
     */
    const replay = replayProposal(record({ entryPoint: "watchlist" }));
    if (!replay.ok) throw new Error("expected a replay");
    expect(replay.response.entryPoint).toBe("watchlist");
  });

  it("⚠ a stored payload carrying CONFLICTING scalars cannot override the row", () => {
    /*
     * ADDED TO CLOSE A GENUINE MUTATION SURVIVOR (mutant R2), and it is decision log
     * 45's mutant M3 in a new place, for exactly the same reason M3 was recorded:
     * that fixture put the wrong strategy only under `reasoning`, so a mutant
     * reading `inputs.strategy` found nothing to read and survived. The fix there
     * was *"putting a conflicting twin of every scalar where a mutant would look"*,
     * and this is that.
     *
     * R2 replaced `proposalId: record.id` with
     * `(inputs.proposalId as string) ?? record.id`. No real payload carries that
     * key, so the fallback always fired and every test still passed — a check with
     * no test behind it. This stores a payload that DOES carry conflicting twins of
     * both scalars the replay takes off the row, and asserts the row wins.
     *
     * ⚠ WHY IT MATTERS RATHER THAN BEING TIDINESS: `proposalId` on the rendered page
     * is what an operator copies into `POST /api/bots` and into the reject endpoint.
     * An id read out of a payload rather than off the row is an id that can be
     * WRONG — and acting on it would attach a decision to a different proposal in a
     * permanent, undeletable record.
     */
    const good = deriveProposalInputsView(deriveResult(), SELECTED_AT) as unknown as Record<
      string,
      unknown
    >;
    const replay = replayProposal(
      record({
        id: "prop-the-real-row",
        entryPoint: "named",
        inputs: throughD1({
          ...good,
          proposalId: "prop-a-payload-claimed-this",
          id: "prop-a-payload-claimed-this-too",
          entryPoint: "watchlist",
          stage: "assess",
        }),
      }),
    );
    if (!replay.ok) throw new Error("expected a replay");
    expect(replay.response.proposalId).toBe("prop-the-real-row");
    expect(replay.response.entryPoint).toBe("named");
    expect(replay.stage).toBe("derive");
  });

  it("⚠ the same conflict planted in the REASONING payload also loses to the row", () => {
    // The other half of M3's lesson: a mutant could read either payload, so a
    // conflicting twin goes in both. These land in the stage object as unexpected
    // fields, which is reported — but they must never become the response's own.
    const stored = deriveProposalReasoningView(deriveResult(), LATENCY_MS) as unknown as Record<
      string,
      unknown
    >;
    const replay = replayProposal(
      record({
        id: "prop-the-real-row",
        inputs: throughD1(deriveProposalInputsView(deriveResult(), SELECTED_AT)),
        reasoning: throughD1({
          ...stored,
          proposalId: "prop-reasoning-claimed-this",
          entryPoint: "general",
        }),
      }),
    );
    if (!replay.ok) throw new Error("expected a replay");
    expect(replay.response.proposalId).toBe("prop-the-real-row");
    expect(replay.response.entryPoint).toBe("named");
    expect([...replay.fidelity.unexpectedStageFields].sort()).toEqual(["entryPoint", "proposalId"]);
  });

  it("reads nothing from the clock, the database or the network", () => {
    // Two calls, two different moments, one identical answer. A replay that varied
    // with `Date.now()` would render one proposal two ways.
    const first = replayProposal(record());
    const second = replayProposal(record());
    expect(first).toEqual(second);
  });
});

// ---------------------------------------------------------------------------
// THE FIDELITY REPORT
// ---------------------------------------------------------------------------

describe("⚠ the fidelity report says what a historical record cannot show", () => {
  it("marks a derive replay as exact, and its assess response as unavailable", () => {
    const replay = replayProposal(record());
    if (!replay.ok) throw new Error("expected a replay");
    expect(replay.fidelity.exact).toBe(true);
    expect(replay.fidelity.unexpectedStageFields).toEqual([]);
    // ⚠ ALWAYS true. Migration 0009: a derive row does not carry the id of the
    // assess row it derives from, and that is a recorded decision rather than a gap.
    expect(replay.fidelity.assessResponseUnavailable).toBe(true);
    expect(replay.fidelity.renderableByProposalView).toBe(true);
  });

  it("⚠ marks an assess replay as NOT renderable by ProposalView, though it is exact", () => {
    /*
     * The distinction the whole endpoint turns on, and the one a reader would
     * otherwise get backwards: the assess payload is rebuilt completely and exactly.
     * What cannot be reused is the RENDERER — `ProposalView` is built around a
     * derivation's parameters, allocated capital and reference price, and an
     * assessment has none of those, which is the same fact
     * `only_a_derivation_can_be_approved` enforces in SQL.
     */
    const replay = replayProposal(assessRecord());
    if (!replay.ok) throw new Error("expected a replay");
    expect(replay.fidelity.exact).toBe(true);
    expect(replay.fidelity.renderableByProposalView).toBe(false);
    expect(replay.fidelity.assessResponseUnavailable).toBe(false);
  });

  it("⚠ reports an unexpected stage field rather than refusing the record", () => {
    /*
     * A row written by a different `serialize.ts` is a normal thing to find in a
     * table with no delete path and indefinite retention. Refusing it would make
     * old records unreadable to protect against nothing — so the extra field is
     * carried through AND named, which is the shape `MinimumOrderCheck`'s
     * `none_published` and `DuplicateKeyCheck`'s `unavailable_transport_parsed`
     * both take: a thing that could not be established is reported, never faked.
     */
    const stored = deriveProposalReasoningView(deriveResult(), LATENCY_MS) as unknown as Record<
      string,
      unknown
    >;
    const replay = replayProposal(
      record({ reasoning: throughD1({ ...stored, retiredFieldFromAnOlderBuild: "kept" }) }),
    );
    if (!replay.ok || replay.stage !== "derive") throw new Error("expected a derive replay");
    expect(replay.fidelity.exact).toBe(false);
    expect(replay.fidelity.unexpectedStageFields).toEqual(["retiredFieldFromAnOlderBuild"]);
    // And it really is carried through, not silently dropped.
    expect(
      (replay.response.derive as unknown as Record<string, unknown>).retiredFieldFromAnOlderBuild,
    ).toBe("kept");
  });
});

// ---------------------------------------------------------------------------
// THE REFUSALS
// ---------------------------------------------------------------------------

describe("a payload that cannot be rebuilt is refused, by name", () => {
  it("refuses inputs_json that is not an object", () => {
    for (const stored of [null, 7, "a string", true]) {
      const replay = replayProposal(record({ inputs: stored }));
      expect(replay.ok).toBe(false);
      if (replay.ok) continue;
      expect(replay.code).toBe("inputs_not_an_object");
    }
  });

  it("⚠ refuses an ARRAY, which a naive presence check would accept", () => {
    /*
     * `Object.hasOwn([], "0")` is true, so a check written as "does it have the
     * keys?" over an array of the right length would pass. Entry 45's mutant C4 is
     * the same fault one module over, and it is refused here for the same reason.
     */
    const replay = replayProposal(record({ inputs: [1, 2, 3, 4] }));
    expect(replay.ok).toBe(false);
    if (replay.ok) return;
    expect(replay.code).toBe("inputs_not_an_object");
    expect(replay.message).toContain("an array");
  });

  it("refuses reasoning_json that is not an object", () => {
    const replay = replayProposal(record({ reasoning: "THE PROMPT" }));
    expect(replay.ok).toBe(false);
    if (replay.ok) return;
    expect(replay.code).toBe("reasoning_not_an_object");
  });

  it("⚠ names every missing input field rather than saying something is missing", () => {
    const replay = replayProposal(record({ inputs: { selectedAt: SELECTED_AT } }));
    expect(replay.ok).toBe(false);
    if (replay.ok) return;
    expect(replay.code).toBe("inputs_incomplete");
    expect(replay.fields).toEqual(["bundle", "context", "assessment"]);
    for (const field of ["bundle", "context", "assessment"]) {
      expect(replay.message).toContain(field);
    }
  });

  it("asks an assess row for its own three fields, not the derive row's five", () => {
    const replay = replayProposal(assessRecord({ inputs: { selectedAt: SELECTED_AT } }));
    expect(replay.ok).toBe(false);
    if (replay.ok) return;
    // `context` and `assessment` are NOT required of an assess record: that stage
    // has neither, and demanding them would refuse every assess row in the table.
    expect(replay.fields).toEqual(["bundle"]);
  });

  it("⚠ treats `undefined` as MISSING and `null` as PRESENT", () => {
    /*
     * ENTRY 45'S RULE, AND BOTH HALVES ARE LOAD-BEARING. `Object.hasOwn` alone
     * accepts `{ bundle: undefined }` — which is the exact value that reached
     * `formatMoney` and took the whole page to a blank black screen during that
     * step's live verification. `!== undefined` alone would accept a value
     * inherited from a prototype.
     *
     * ⚠ AND THE `null` HALF IS NOT SYMMETRY FOR ITS OWN SAKE: the views emit real
     * `null`s for genuine absences, so a rule reading "absent or null" as missing
     * would refuse good records.
     */
    const good = deriveProposalInputsView(deriveResult(), SELECTED_AT);
    const withUndefined = replayProposal(record({ inputs: { ...good, bundle: undefined } }));
    expect(withUndefined.ok).toBe(false);
    if (!withUndefined.ok) expect(withUndefined.fields).toEqual(["bundle"]);

    const withNull = replayProposal(record({ inputs: { ...good, bundle: null } }));
    expect(withNull.ok).toBe(true);
  });

  it("names a missing reasoning field", () => {
    const stored = deriveProposalReasoningView(deriveResult(), LATENCY_MS) as unknown as Record<
      string,
      unknown
    >;
    delete stored.envelope;
    delete stored.settings;
    const replay = replayProposal(record({ reasoning: throughD1(stored) }));
    expect(replay.ok).toBe(false);
    if (replay.ok) return;
    expect(replay.code).toBe("reasoning_incomplete");
    expect(replay.fields).toEqual(["settings", "envelope"]);
  });

  it("⚠ refuses a `selectedAt` that is not a number", () => {
    // It is epoch milliseconds on the wire, and the banner on the create-bot form
    // formats it as a date. A string here would print something that looks like a
    // time and is not one.
    const good = deriveProposalInputsView(deriveResult(), SELECTED_AT);
    const replay = replayProposal(record({ inputs: { ...good, selectedAt: "2026-08-14" } }));
    expect(replay.ok).toBe(false);
    if (replay.ok) return;
    expect(replay.code).toBe("selected_at_not_a_number");
    expect(replay.fields).toEqual(["selectedAt"]);
  });

  it("does not confuse the two stages' required field sets", () => {
    // A derive payload stored on a row labelled `assess` still rebuilds (a derive
    // inputs blob is a superset), but an assess payload on a `derive` row cannot.
    const onDeriveRow = replayProposal(
      record({ inputs: throughD1(assessProposalInputsView(assessResult(), SELECTED_AT)) }),
    );
    expect(onDeriveRow.ok).toBe(false);
    if (onDeriveRow.ok) return;
    expect(onDeriveRow.fields).toEqual(["context", "assessment"]);
  });
});
