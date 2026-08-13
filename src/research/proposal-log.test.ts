/**
 * The permanent proposal record's write path (21.5 requirement 5), against real
 * D1 in the Workers runtime.
 *
 * Six properties, each one this module would look correct without:
 *
 *  1. THE FULL INPUTS AND REASONING SURVIVE THE ROUND TRIP, unsummarised. The
 *     requirement's own words are "its full inputs, its reasoning", and a JSON
 *     column that silently dropped a nested field would be invisible at the write.
 *     One test drives a 1,440-candle window and measures the stored size, because
 *     "does the real payload fit in a D1 row" is a fact about production that no
 *     assertion about shape answers.
 *  2. EVERY SCALAR COMES OFF THE REAL RESULT, never off a parameter. A caller who
 *     passes the wrong payload cannot make the row claim the wrong pair, strategy,
 *     model or fetch time.
 *  3. THE ROW AND ITS AUDIT ENTRY ARE INSEPARABLE. One batch, so a record with no
 *     account of who caused it is not a reachable state -- and the entry carries a
 *     POINTER, not a second copy of the payload.
 *  4. AN OUTCOME IS WRITTEN ONCE AND NEVER OVERWRITTEN. The conditional UPDATE's
 *     `changes` is the decision, so a second attempt is refused rather than
 *     silently replacing a recorded human act.
 *  5. ONLY A DERIVATION CAN BE APPROVED, and it is a DATABASE constraint as well
 *     as a code path -- asserted by writing past the code path with a raw INSERT.
 *  6. THERE IS NO DELETE PATH (section 8.7). Asserted structurally, over the real
 *     source, rather than by trying and failing to call one.
 */

import { beforeEach, describe, expect, it } from "vitest";
import type { Database } from "../db";
import { freshDatabase, proposalRow } from "../db/test-helpers";
import type { ProposalRow } from "../db/schema";
import { fromDecimalString as m } from "../shared/money";
import type { Candle } from "../shared/exchange-client";
import {
  ProposalLogError,
  checkProposalCanTakeOutcome,
  logAssessProposal,
  logDeriveProposal,
  recordProposalApproval,
  rejectProposal,
  type ProposalLogPorts,
} from "./proposal-log";
import type { AssessResult } from "./assess";
import type { DeriveResult } from "./derive";
import type { CandidateGatherBundle, DeriveContext } from "./gather";

const T0 = 1_900_000_000_000;
const MINUTE = 60_000;
const HUMAN = "owner@example.com";
const FETCHED_AT = 1_899_000_000_000;

let db: Database;
let clock: number;
let ids: number;

function ports(): ProposalLogPorts {
  return { db, now: () => clock, newId: () => `id-${(ids += 1)}` };
}

beforeEach(async () => {
  db = await freshDatabase();
  clock = T0;
  ids = 0;
  await db.accounts.insert({
    account_label: "main",
    exchange: "gemini",
    created_at: T0,
    updated_at: T0,
  });
});

// ---------------------------------------------------------------------------
// Fixtures: real object SHAPES, minimal contents
// ---------------------------------------------------------------------------

/** One real evidence item, so every `citations` array is the non-empty tuple the type requires. */
const EVIDENCE = {
  id: "candles.range_pct",
  label: "Range",
  value: "1.98%",
  source: "candles.value.candles",
} as const;

function candle(openTime: number, close: bigint): Candle {
  return {
    pair: "BTCUSD",
    openTime,
    closeTime: openTime + MINUTE,
    open: close - 1n,
    high: close + 2n,
    low: close - 3n,
    close,
    volume: 400_000_000n,
    closed: true,
  };
}

function bundle(overrides: Partial<CandidateGatherBundle> = {}): CandidateGatherBundle {
  return {
    candidate: {
      accountLabel: "main",
      exchange: "gemini",
      pair: "BTCUSD",
      sources: [{ kind: "named", requestedAs: "BTCUSD", requestedBy: HUMAN, requestedAt: T0 }],
    },
    candles: {
      outcome: "ok",
      value: {
        accountLabel: "main",
        exchange: "gemini",
        pair: "BTCUSD",
        interval: "1m",
        candles: [candle(T0 - 2 * MINUTE, 100_000_000n), candle(T0 - MINUTE, 101_000_000n)],
        fetchedAt: FETCHED_AT,
        requestedSince: null,
        earliestOpenTime: T0 - 2 * MINUTE,
        earliestCloseTime: T0 - MINUTE,
        latestCloseTime: T0,
        truncated: false,
        missingHistoryMs: null,
      },
    },
    news: {
      outcome: "not_yet_available",
      reason: "no vendor chosen",
      decisionLogEntry: "30",
    },
    concentration: {
      outcome: "failed",
      error: { code: "bot_list_unreadable", message: "D1 read failed" },
      failedAt: T0,
    },
    assembledAt: T0,
    ...overrides,
  } as CandidateGatherBundle;
}

function assessResult(overrides: Partial<AssessResult> = {}): AssessResult {
  return {
    strategy: "grid",
    claims: [
      {
        statement: "The range is wide relative to the close.",
        citations: [
          { id: "candles.range_pct", label: "Range", value: "1.98%", source: "candles.value.candles" },
        ],
      },
    ],
    envelope: "envelope_object",
    duplicateKeyCheck: "unavailable_transport_parsed",
    promptVersion: "assess/1",
    promptText: "THE ASSESS PROMPT",
    evidence: [
      { id: "candles.range_pct", label: "Range", value: "1.98%", source: "candles.value.candles" },
    ],
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

function deriveContext(inner = bundle()): DeriveContext {
  return {
    bundle: inner,
    capital: {
      outcome: "ok",
      value: { accountLabel: "main", readAt: FETCHED_AT + 1_000, rowsRead: 0, assets: [] },
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
          upperBound: m("108"),
          lowerBound: m("96"),
          gridLines: 5,
          spacing: "arithmetic",
          orderSize: m("50"),
          stopLossPct: m("5"),
          breakoutTakeProfit: true,
          breakoutThresholdPct: null,
          takeProfitAmount: null,
        },
      },
      allocatedCapital: m("400"),
      capitalAsset: "USD",
      availableAtProposal: m("10000"),
      referencePrice: m("108"),
    },
    citations: {
      parameters: {},
      allocatedCapital: { value: "400", citations: [EVIDENCE] },
      capitalAsset: { value: "USD", citations: [EVIDENCE] },
    },
    notes: [{ statement: "The observed range sets the bounds.", citations: [EVIDENCE] }],
    envelope: "envelope_object",
    duplicateKeyCheck: "unavailable_transport_parsed",
    minimumOrderCheck: "quantity",
    promptVersion: "derive/1",
    promptText: "THE DERIVE PROMPT",
    evidence: [],
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

// -- Properties 1 and 2: the row -------------------------------------------

describe("logAssessProposal", () => {
  it("writes one row carrying the full inputs and reasoning, unsummarised", async () => {
    const inputs = { selectedAt: T0, bundle: { deeply: { nested: ["a", "b"], count: 2 } } };
    const reasoning = { promptText: "THE ASSESS PROMPT", response: { raw: { response: "grid" } } };

    const record = await logAssessProposal(ports(), assessResult(), {
      entryPoint: "named",
      actor: HUMAN,
      inputs,
      reasoning,
    });

    const rows = await db.proposals.findMany({});
    expect(rows).toHaveLength(1);
    const row = rows[0]!;

    expect(row.id).toBe(record.id);
    expect(row.stage).toBe("assess");
    // ── Property 2: every scalar off the real result ──
    expect(row.account_label).toBe("main");
    expect(row.pair).toBe("BTCUSD");
    expect(row.strategy_type).toBe("grid");
    expect(row.model).toBe("@cf/meta/llama-3.3-70b-instruct-fp8-fast");
    expect(row.prompt_version).toBe("assess/1");
    // 21.5 requirement 4: the FETCH time, not the write time. Asserted as
    // different from `created_at`, because equal values would let a mutant that
    // stamps `now()` here pass.
    expect(row.data_fetched_at).toBe(FETCHED_AT);
    expect(row.created_at).toBe(T0);
    expect(row.data_fetched_at).not.toBe(row.created_at);
    // The actor is the caller's verified email.
    expect(row.actor).toBe(HUMAN);
    expect(row.entry_point).toBe("named");

    // ── Property 1: the payloads round-trip DEEP, not shallow ──
    expect(row.inputs_json).toEqual(inputs);
    expect(row.reasoning_json).toEqual(reasoning);
    // Named explicitly: the prompt text is the field the WIRE deliberately omits
    // and the record must keep (21.7 open question 3).
    expect((row.reasoning_json as { promptText: string }).promptText).toBe("THE ASSESS PROMPT");

    // And it starts UNRESOLVED, which is 21.5's "ignored" until someone acts.
    expect(row.outcome).toBeNull();
    expect(row.outcome_actor).toBeNull();
    expect(row.outcome_at).toBeNull();
    expect(row.outcome_bot_instance_id).toBeNull();
  });

  it("⚠ stores EVERY scalar from the RESULT even when the payload disagrees on all of them", async () => {
    // A caller cannot make the row claim the wrong thing by passing a wrong
    // payload -- the scalars are read off the real object. This is what makes
    // "every scalar off the real result" a property rather than a coincidence.
    //
    // ⚠ THE DISAGREEING VALUES ARE PLACED WHERE A MUTANT WOULD LOOK, at the top
    // level of BOTH payloads and nested where the real bundle keeps them. An
    // earlier version of this test put the wrong strategy only under `reasoning`,
    // and a mutant reading `inputs.strategy` survived because nothing was there
    // to read. Every scalar the row holds now has a conflicting twin in reach.
    const wrong = {
      pair: "ETHUSD",
      accountLabel: "other",
      account_label: "other",
      fetchedAt: 1_234_000_000_000,
      strategy: "dca",
      strategy_type: "dca",
      model: "@cf/wrong/model",
      promptVersion: "assess/999",
      prompt_version: "assess/999",
      dataFetchedAt: 1_234_000_000_000,
      data_fetched_at: 1_234_000_000_000,
      entryPoint: "watchlist",
      entry_point: "watchlist",
      actor: "impostor@example.com",
    };
    await logAssessProposal(ports(), assessResult(), {
      entryPoint: "named",
      actor: HUMAN,
      inputs: { ...wrong, bundle: { ...wrong, candidate: { pair: "ETHUSD", accountLabel: "other" } } },
      reasoning: { ...wrong },
    });

    const row = (await db.proposals.findMany({}))[0]!;
    expect(row.pair).toBe("BTCUSD");
    expect(row.account_label).toBe("main");
    expect(row.strategy_type).toBe("grid");
    expect(row.model).toBe("@cf/meta/llama-3.3-70b-instruct-fp8-fast");
    expect(row.prompt_version).toBe("assess/1");
    expect(row.data_fetched_at).toBe(FETCHED_AT);
    // These two DO come from the request, and correctly so: the entry point and
    // the actor are the handler's verified facts, not the model result's. Asserted
    // so the split between "off the result" and "off the request" is deliberate
    // and visible rather than a thing a reader has to infer.
    expect(row.entry_point).toBe("named");
    expect(row.actor).toBe(HUMAN);
  });

  it("refuses to record a result whose candle slot produced no fetch time", async () => {
    // Unreachable through the pipeline -- `assessCandidate` refuses first -- and
    // reachable here by building the result directly, which is what makes the
    // narrowing testable rather than dead. It THROWS rather than defaulting,
    // because a fabricated fetch time cannot be staleness-checked at all.
    const broken = assessResult({
      bundle: bundle({
        candles: {
          outcome: "failed",
          error: { code: "candles_unavailable", message: "venue timeout" },
          failedAt: T0,
        },
      } as Partial<CandidateGatherBundle>),
    });

    await expect(
      logAssessProposal(ports(), broken, { entryPoint: "named", actor: HUMAN, inputs: {}, reasoning: {} }),
    ).rejects.toThrow(ProposalLogError);
    await expect(
      logAssessProposal(ports(), broken, { entryPoint: "named", actor: HUMAN, inputs: {}, reasoning: {} }),
    ).rejects.toMatchObject({ code: "no_fetch_time" });
    // AND NOTHING WAS WRITTEN. A refusal that left a partial row behind would be
    // worse than no check at all.
    expect(await db.proposals.count()).toBe(0);
    expect(await db.auditLog.count()).toBe(0);
  });
});

// -- Property 3: the row and its audit entry -------------------------------

describe("the audit entry", () => {
  it("lands in the SAME batch as the row, naming the actor and pointing at it", async () => {
    const record = await logAssessProposal(ports(), assessResult(), {
      entryPoint: "named",
      actor: HUMAN,
      inputs: { a: 1 },
      reasoning: { b: 2 },
    });

    const audits = await db.auditLog.findMany({ where: { action: "proposal.assessed" } });
    expect(audits).toHaveLength(1);
    const audit = audits[0]!;
    expect(audit.actor).toBe(HUMAN);
    // No bot exists and 21.1 guarantees this pipeline has no write path to one.
    expect(audit.target_bot_instance_id).toBeNull();
    expect(audit.created_at).toBe(record.createdAt);

    const details = audit.details_json as Record<string, unknown>;
    expect(details.proposal_id).toBe(record.id);
    expect(details.stage).toBe("assess");
    expect(details.pair).toBe("BTCUSD");
    expect(details.strategy_type).toBe("grid");
    expect(details.data_fetched_at).toBe(FETCHED_AT);

    // ⚠ A POINTER, NOT A SECOND COPY. The whole reason `proposals` is its own
    // table is that `audit_log` is read in full by unrelated endpoints
    // (`listReconciliationRuns`), so the payload must not be duplicated here.
    expect(details.inputs_json).toBeUndefined();
    expect(details.reasoning_json).toBeUndefined();
    expect(details.promptText).toBeUndefined();
    expect(JSON.stringify(details).length).toBeLessThan(600);
  });

  it("uses a distinct action per stage", async () => {
    await logAssessProposal(ports(), assessResult(), { entryPoint: "named", actor: HUMAN, inputs: {}, reasoning: {} });
    await logDeriveProposal(ports(), deriveResult(), { entryPoint: "named", actor: HUMAN, inputs: {}, reasoning: {} });
    const actions = (await db.auditLog.findMany({ orderBy: [{ column: "created_at", direction: "asc" }] })).map(
      (row) => row.action,
    );
    expect(actions).toEqual(["proposal.assessed", "proposal.derived"]);
  });
});

describe("logDeriveProposal", () => {
  it("writes a derive row from the CONTEXT's bundle, with the derivation's strategy", async () => {
    const record = await logDeriveProposal(ports(), deriveResult(), {
      entryPoint: "named",
      actor: HUMAN,
      inputs: { bundle: {}, context: {}, assessment: {} },
      reasoning: { promptText: "THE DERIVE PROMPT" },
    });

    const row = (await db.proposals.findMany({}))[0]!;
    expect(row.stage).toBe("derive");
    expect(row.pair).toBe("BTCUSD");
    expect(row.account_label).toBe("main");
    expect(row.prompt_version).toBe("derive/1");
    expect(row.data_fetched_at).toBe(FETCHED_AT);
    expect(record.stage).toBe("derive");
  });

  it("records the DERIVATION's strategy, not a value taken from elsewhere", async () => {
    // They agree by construction (`derive-parse.ts` refuses a disagreement), and
    // this pins WHICH field is read: the one the parameters are for.
    await logDeriveProposal(
      ports(),
      deriveResult({
        strategy: "dca",
        assessment: {
          strategy: "grid",
          claims: [{ statement: "x", citations: [EVIDENCE] }],
          envelope: "envelope_object",
          duplicateKeyCheck: "performed",
        },
      } as Partial<DeriveResult>),
      { entryPoint: "named", actor: HUMAN, inputs: {}, reasoning: {} },
    );
    expect((await db.proposals.findMany({}))[0]!.strategy_type).toBe("dca");
  });
});

// -- Property 1 continued: does the REAL payload fit in a D1 row? -----------

describe("⚠ the real payload size, measured rather than assumed", () => {
  it("stores a 1,440-candle bundle and a full prompt, and reports the row size", async () => {
    // THE FACT THIS TEST EXISTS FOR: D1 limits a row to 2,000,000 bytes, and the
    // record stores the whole window plus both prompt texts unsummarised. Whether
    // the real worst case fits is a fact about production, and the only honest way
    // to know it is to build the biggest payload this pipeline can produce and
    // measure the bytes.
    //
    // 1,440 candles is the deepest window decision log 41 measured its prompt
    // sizes against, and 23,383 characters is the real Derive prompt length it
    // recorded there.
    const candles = Array.from({ length: 1_440 }, (_, i) =>
      candle(T0 - (1_440 - i) * MINUTE, BigInt(100_000_000 + i * 1_000)),
    );
    const deep = bundle({
      candles: {
        outcome: "ok",
        value: {
          accountLabel: "main",
          exchange: "gemini",
          pair: "BTCUSD",
          interval: "1m",
          candles,
          fetchedAt: FETCHED_AT,
          requestedSince: T0 - 1_440 * MINUTE,
          earliestOpenTime: T0 - 1_440 * MINUTE,
          earliestCloseTime: T0 - 1_439 * MINUTE,
          latestCloseTime: T0,
          truncated: false,
          missingHistoryMs: null,
        },
      },
    } as Partial<CandidateGatherBundle>);

    // The candles as the wire renders them: decimal STRINGS, which is the larger
    // form and the one actually stored.
    const inputs = {
      selectedAt: T0,
      bundle: {
        candidate: deep.candidate,
        candles: {
          outcome: "ok",
          value: {
            // Narrowed through the discriminant rather than cast: the fixture
            // above builds the `ok` arm, and asserting that is the assertion.
            ...(deep.candles.outcome === "ok" ? deep.candles.value : {}),
            candles: candles.map((c) => ({
              ...c,
              open: c.open.toString(),
              high: c.high.toString(),
              low: c.low.toString(),
              close: c.close.toString(),
              volume: c.volume.toString(),
            })),
          },
        },
      },
    };
    const reasoning = {
      promptText: "X".repeat(23_383),
      evidence: Array.from({ length: 75 }, (_, i) => ({
        id: `evidence.${i}`,
        label: `Item ${i}`,
        value: "63757.71000000",
        source: "candles.value.candles",
      })),
      response: { text: "{}", raw: { response: {} } },
    };

    await logDeriveProposal(ports(), deriveResult({ context: deriveContext(deep) }), {
      entryPoint: "named",
      actor: HUMAN,
      inputs,
      reasoning,
    });

    const row = (await db.proposals.findMany({}))[0]!;
    // It round-tripped intact -- every candle, not a truncated prefix.
    const stored = row.inputs_json as typeof inputs;
    expect(stored.bundle.candles.value.candles).toHaveLength(1_440);
    expect((row.reasoning_json as { promptText: string }).promptText).toHaveLength(23_383);

    const bytes = JSON.stringify(row.inputs_json).length + JSON.stringify(row.reasoning_json).length;
    // The measured figure, asserted against D1's documented 2,000,000-byte row
    // limit with room to spare. Printed so the real number is on the record and
    // not only the fact that it passed.
    console.log(`measured worst-case proposal payload: ${bytes} bytes (D1 row limit 2,000,000)`);
    expect(bytes).toBeLessThan(2_000_000);
    // A floor as well as a ceiling: a mutant that stored a summary would pass a
    // ceiling-only assertion trivially.
    expect(bytes).toBeGreaterThan(200_000);
  });
});

// -- Properties 4 and 5: the outcome ---------------------------------------

describe("the outcome", () => {
  async function seedBot(id: string) {
    await db.botInstances.insert({
      id,
      account_label: "main",
      exchange: "gemini",
      pair: "BTCUSD",
      strategy_type: "grid",
      strategy_params_json: {},
      stop_loss_pct: m("5"),
      take_profit_pct: null,
      allocated_capital: m("400"),
      status: "created",
      halt_reason: null,
      halted_at: null,
      schema_version: 1,
      created_at: T0,
      updated_at: T0,
      capital_asset: "USD",
      archived: false,
    });
  }

  async function seedDerive(overrides: Partial<ProposalRow> = {}) {
    // `created_at` restated on this file's own clock: `proposalRow`'s default is
    // test-helpers' T0, a different epoch, and `pending_ms` is measured against it.
    const row = proposalRow({
      id: `p-${(ids += 1)}`,
      account_label: "main",
      created_at: T0,
      data_fetched_at: FETCHED_AT,
      ...overrides,
    });
    await db.proposals.insert(row);
    return row;
  }

  it("records an approval naming the real bot, and audits it", async () => {
    const row = await seedDerive();
    await seedBot("bot-1");
    clock = T0 + 5 * MINUTE;

    const record = await recordProposalApproval(ports(), row, "other@example.com", "bot-1");

    expect(record.outcome).toBe("approved");
    expect(record.outcomeBotInstanceId).toBe("bot-1");
    expect(record.outcomeActor).toBe("other@example.com");
    expect(record.outcomeAt).toBe(T0 + 5 * MINUTE);

    const stored = (await db.proposals.findOne({ id: row.id }))!;
    expect(stored.outcome).toBe("approved");
    expect(stored.outcome_bot_instance_id).toBe("bot-1");

    const audits = await db.auditLog.findMany({ where: { action: "proposal.approved" } });
    expect(audits).toHaveLength(1);
    // THE ONE audit entry in this module that names a bot: it records that a HUMAN
    // created it through the ordinary flow.
    expect(audits[0]!.target_bot_instance_id).toBe("bot-1");
    const details = audits[0]!.details_json as Record<string, unknown>;
    expect(details.pending_ms).toBe(5 * MINUTE);
    // The proposal's own actor and the deciding human are kept SEPARATE, because
    // one operator may act on another's proposal.
    expect(details.proposed_by).toBe("owner@example.com");
    expect(audits[0]!.actor).toBe("other@example.com");
  });

  it("records a rejection with no bot, and an absent note as absent", async () => {
    const row = await seedDerive();
    const record = await rejectProposal(ports(), row.id, { actor: HUMAN });
    expect(record.outcome).toBe("rejected");
    expect(record.outcomeBotInstanceId).toBeNull();
    expect(record.outcomeNote).toBeNull();
    expect((await db.auditLog.findMany({ where: { action: "proposal.rejected" } }))).toHaveLength(1);
  });

  it("records a rejection note, trimmed", async () => {
    const row = await seedDerive();
    const record = await rejectProposal(ports(), row.id, { actor: HUMAN, note: "  bounds too tight  " });
    expect(record.outcomeNote).toBe("bounds too tight");
    // A blank note is an absent note, not an empty string pretending to be a reason.
    const other = await seedDerive();
    expect((await rejectProposal(ports(), other.id, { actor: HUMAN, note: "   " })).outcomeNote).toBeNull();
  });

  it("⚠ REJECTS AN ASSESSMENT, which is the point of keeping Stage 2 rows", async () => {
    const row = await seedDerive({ stage: "assess", prompt_version: "assess/1" });
    const record = await rejectProposal(ports(), row.id, { actor: HUMAN, note: "not pursuing" });
    expect(record.outcome).toBe("rejected");
    expect(record.stage).toBe("assess");
  });

  // ── Property 4: written once, never overwritten ──

  it("refuses a SECOND outcome rather than overwriting the first", async () => {
    const row = await seedDerive();
    await rejectProposal(ports(), row.id, { actor: HUMAN, note: "first" });

    await expect(rejectProposal(ports(), row.id, { actor: "someone@else.com" })).rejects.toMatchObject({
      code: "proposal_already_resolved",
    });

    // The FIRST decision is intact, actor and note included.
    const stored = (await db.proposals.findOne({ id: row.id }))!;
    expect(stored.outcome_actor).toBe(HUMAN);
    expect(stored.outcome_note).toBe("first");
    // And no second audit entry claims a human act that did not happen.
    expect(await db.auditLog.findMany({ where: { action: "proposal.rejected" } })).toHaveLength(1);
  });

  it("refuses an approval on an already-rejected proposal", async () => {
    const row = await seedDerive();
    await seedBot("bot-2");
    await rejectProposal(ports(), row.id, { actor: HUMAN });
    await expect(
      checkProposalCanTakeOutcome(ports(), row.id, { forApproval: true }),
    ).rejects.toMatchObject({ code: "proposal_already_resolved" });
  });

  it("⚠ the UPDATE's `changes` is the decision, not a prior read", async () => {
    // Drives the compare-and-swap directly: hold a row object that says unresolved
    // while the database has moved on. `recordProposalApproval` must lose, because
    // `outcome IS NULL` is in the WHERE clause rather than only in a check above it.
    const row = await seedDerive();
    await seedBot("bot-3");
    await rejectProposal(ports(), row.id, { actor: "faster@example.com" });

    await expect(
      recordProposalApproval(ports(), row, HUMAN, "bot-3"),
    ).rejects.toMatchObject({ code: "proposal_already_resolved" });
    expect((await db.proposals.findOne({ id: row.id }))!.outcome).toBe("rejected");
    expect(await db.auditLog.findMany({ where: { action: "proposal.approved" } })).toHaveLength(0);
  });

  // ── Property 5: only a derivation can be approved ──

  it("refuses to approve an ASSESS record, by code path", async () => {
    const row = await seedDerive({ stage: "assess", prompt_version: "assess/1" });
    await expect(
      checkProposalCanTakeOutcome(ports(), row.id, { forApproval: true }),
    ).rejects.toMatchObject({ code: "proposal_not_derivable" });
  });

  /**
   * ⚠ THE DATABASE-LEVEL HALF OF THESE GUARANTEES LIVES IN
   * `/src/db/constraints.test.ts`, and had to.
   *
   * `only_a_derivation_can_be_approved`, `approval_names_a_bot`,
   * `rejection_names_no_bot` and `outcome_is_recorded_whole` are only
   * demonstrable by writing PAST the repository -- otherwise deleting the code
   * check above would leave every test green. That needs raw SQL, and
   * `no-raw-d1.test.ts` fails the build on `.prepare(` outside /src/db, so
   * /src/db is the one place it can be written. Both halves exist and neither is
   * sufficient alone: without the code tests a refusal would arrive as an opaque
   * SQLite error; without the constraint tests the code check would be the only
   * thing standing between a mis-wired caller and a false record.
   */

  // ── The other refusals ──

  it("refuses an unknown proposal id", async () => {
    await expect(
      checkProposalCanTakeOutcome(ports(), "nope", { forApproval: true }),
    ).rejects.toMatchObject({ code: "unknown_proposal" });
  });

  it("refuses a proposal made for a DIFFERENT account", async () => {
    // Its capital figure came from that account's ledger and its concentration
    // flag from that account's bots, so the reasoning is not about this account.
    const row = await seedDerive();
    await expect(
      checkProposalCanTakeOutcome(ports(), row.id, { accountLabel: "other", forApproval: true }),
    ).rejects.toMatchObject({ code: "proposal_account_mismatch" });
  });

  it("accepts a matching account", async () => {
    const row = await seedDerive();
    const checked = await checkProposalCanTakeOutcome(ports(), row.id, {
      accountLabel: "main",
      forApproval: true,
    });
    expect(checked.id).toBe(row.id);
  });

  it("writes NOTHING when a check refuses", async () => {
    const row = await seedDerive({ stage: "assess", prompt_version: "assess/1" });
    await expect(
      checkProposalCanTakeOutcome(ports(), row.id, { forApproval: true }),
    ).rejects.toThrow();
    expect((await db.proposals.findOne({ id: row.id }))!.outcome).toBeNull();
    expect(await db.auditLog.count()).toBe(0);
  });
});

// -- Property 6: retention (section 8.7) -----------------------------------

describe("retention: section 8.7 applies here unchanged", () => {
  it("has no delete method to call at all", () => {
    // Structural, not behavioural: `Repository` offers no `delete`, so there is
    // nothing to try and fail at. Asserted on the real repository object so a
    // future widening of the access layer fails HERE, where the retention promise
    // is written down, and not only wherever someone first used it.
    const repository = db.proposals as unknown as Record<string, unknown>;
    expect(repository.delete).toBeUndefined();
    expect(repository.deleteMany).toBeUndefined();
    expect(repository.truncate).toBeUndefined();
    expect(repository.remove).toBeUndefined();
  });

  it("has no soft-delete column either, unlike watchlist and bot_instances", async () => {
    // `watchlist.removed_at` and `bot_instances.archived` exist because those rows
    // are meant to be able to leave a live set. Nothing about a proposal record is,
    // so there is deliberately no equivalent -- and this asserts the absence rather
    // than leaving it to be noticed.
    const row = await db.proposals.insert(proposalRow({ id: "p-ret", account_label: "main" }));
    void row;
    const stored = (await db.proposals.findOne({ id: "p-ret" }))!;
    expect(Object.keys(stored)).not.toContain("removed_at");
    expect(Object.keys(stored)).not.toContain("archived");
    expect(Object.keys(stored)).not.toContain("deleted_at");
  });

  it("keeps a resolved proposal in the table forever, rather than retiring it", async () => {
    // The one mutation this table permits is NULL -> an outcome. The row itself
    // stays in every unfiltered read, before and after.
    await db.proposals.insert(proposalRow({ id: "p-keep", account_label: "main" }));
    await rejectProposal(ports(), "p-keep", { actor: HUMAN });
    expect(await db.proposals.count()).toBe(1);
    expect((await db.proposals.findMany({}))[0]!.id).toBe("p-keep");
  });

  it("no source file outside /src/db mentions deleting from this table", async () => {
    // The mechanical half. `no-raw-d1.test.ts` already fails the build on any
    // `.prepare(` outside /src/db, so a hand-written DELETE cannot exist -- this
    // asserts the narrower, more specific thing: that nothing anywhere reaches for
    // one against `proposals`.
    const sources = import.meta.glob("/src/**/*.ts", { query: "?raw", eager: true }) as Record<
      string,
      { default: string }
    >;
    const offenders = Object.entries(sources)
      .filter(([path]) => !path.startsWith("/src/db/") && !path.endsWith(".test.ts"))
      .filter(([, file]) => /DELETE\s+FROM\s+proposals/i.test(file.default));
    expect(offenders.map(([path]) => path)).toEqual([]);
  });
});
