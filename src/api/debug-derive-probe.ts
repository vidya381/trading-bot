/**
 * ============================================================================
 * ⚠⚠⚠  TEMPORARY DIAGNOSTIC. DELETE THIS FILE AFTER THE STAGE 3 PROBE.  ⚠⚠⚠
 * ============================================================================
 *
 * This is NOT a feature, NOT the Derive endpoint, and NOT part of section 21's
 * pipeline. It is one-shot scaffolding whose entire purpose is to answer
 * questions that no test in this repository can answer, because every test in
 * this repository drives a stub:
 *
 *   1. Does `@cf/meta/llama-3.3-70b-instruct-fp8-fast` fill NINE cited numeric
 *      fields under a strategy-conditional JSON schema at all? Four live calls
 *      have shown it emit one exact literal and a handful of cited sentences
 *      (decision logs 37, 39, 40). Nothing has ever asked it for a complete
 *      parameter set.
 *   2. What is Derive's REAL latency and output-token cost? Every figure in the
 *      Stage 3 work is a character count and an estimate.
 *   3. Do the real decoders and the real validators accept what it produces, or
 *      is the refusal rate so high the stage is unusable as designed?
 *
 * It is modelled on step 29's Tier 0/Tier 1 pattern (decision log 14) and on the
 * Stage 2 probe of step 37, both of which were temporary in exactly this way.
 *
 * ── WHAT IT WRITES: NOTHING ──
 *
 * No D1 row. No KV key. No alert. No proposal record. No bot. No capital
 * reservation, no `total_allocated` touched, no Durable Object brought into
 * existence. It reads `capital_ledger`, it reads `bot_instances`, it asks the
 * venue for candles and symbol details, it calls Workers AI twice, and it
 * returns what happened. 21.1's boundary is not merely respected here, it is
 * unreachable: nothing in the call graph below can write.
 *
 * ── WHY IT RUNS THE WHOLE CHAIN RATHER THAN JUST STAGE 3 ──
 *
 * Derive's input is a REAL Stage 2 result, and a `ParsedAssessment` fabricated
 * by this file would be the one thing the probe must not test: the interesting
 * question is whether a real model's real strategy choice, with its real
 * claims as evidence, produces a usable parameter set. So the chain is
 * gather → gatherDeriveContext → REAL assess → REAL derive, and the Assess call
 * is a real call and not a replay.
 *
 * That is TWO paid inferences per request, and the response reports each one's
 * latency separately so the cost of Stage 3 can be told from the cost of
 * Stage 2.
 *
 * ── WHAT IT REPORTS ON FAILURE, AND WHY THAT IS THE POINT ──
 *
 * A refusal is a RESULT here, not an error. The probe returns HTTP 200 carrying
 * a structured description of where the chain stopped -- which stage, which
 * error class, which code -- because "the parser refused with
 * `citation_unknown`" is exactly as informative as a success and must not be
 * flattened into a 502 that loses the code. The one thing it never does is
 * report a partial proposal as a proposal: `derive.outcome` is `"proposed"` or
 * it is a named failure, and there is no third value.
 */

import { ApiError, badRequest, ok } from "./envelope";
import type { ApiContext } from "./router";
import { listAccountSymbols, KvSymbolCacheStore, type SymbolCacheStore } from "../workers/symbols";
import { envAssessModel } from "../workers/assess";
import { envDeriveModel } from "../workers/derive";
import { assessCandidate, AssessError, type AssessResult } from "../research/assess";
import { AssessParseError } from "../research/assess-parse";
import { selectNamedCandidate } from "../research/candidates";
import {
  gatherCandidateData,
  gatherDeriveContext,
  type DeriveContext,
  type DeriveContextPorts,
} from "../research/gather";
import { DeriveError, deriveParameters, type DeriveResult } from "../research/derive";
import { DeriveParseError, DeriveValidationError } from "../research/derive-parse";
import type { CandleSource } from "../research/candles";
import type { SymbolDetailSource, TradablePairSource } from "../research/tradability";
import type { CandleInterval, Pair } from "../shared/exchange-client";
import { toDecimalString } from "../shared/money";

/**
 * The seven values `CandleInterval` declares, copied locally.
 *
 * `handlers.ts` keeps its own private copy of this list and exporting it for a
 * file that is about to be deleted would leave a permanent widening behind. The
 * copy cannot silently drift into accepting something real: `fetchCandleWindow`
 * refuses any interval outside `VERIFIED_INTERVALS` (which still holds only
 * `"1m"`), so this list only decides whether the refusal is a 400 here or a
 * `interval_not_verified` one layer down.
 */
const CANDLE_INTERVALS: readonly CandleInterval[] = ["1m", "5m", "15m", "30m", "1h", "6h", "1d"];

/**
 * The ports, rebuilt locally rather than imported from `handlers.ts`.
 *
 * Deliberate: `handlers.ts`'s own port adapters are private, and exporting them
 * for a file that is about to be deleted would leave a permanent widening behind
 * after the temporary thing is gone. Three small adapters here cost less than
 * that, and they are the SAME `ctx` fields the real handlers use -- so the probe
 * cannot accidentally reach a different venue or a different cache than
 * `/assess` does.
 */
function probePorts(ctx: ApiContext): DeriveContextPorts {
  const cache: SymbolCacheStore | null =
    ctx.env.SYMBOL_CACHE === undefined ? null : new KvSymbolCacheStore(ctx.env.SYMBOL_CACHE);

  const listTradablePairs: TradablePairSource = async (account) =>
    await listAccountSymbols({ account, env: ctx.env, now: ctx.now, lister: ctx.symbolLister, cache });

  const getCandles: CandleSource = async (account, query) =>
    await ctx.candleLister(account, query, ctx.env, ctx.now);

  const getSymbolDetails: SymbolDetailSource = async (account, pair) =>
    await ctx.symbolDetailLister(account, pair, ctx.env, ctx.now);

  return { db: ctx.db, listTradablePairs, getCandles, getSymbolDetails, now: ctx.now };
}

/** A thrown value described without trusting it to describe itself. */
function describe(error: unknown): { readonly kind: string; readonly code: string; readonly message: string } {
  if (error instanceof AssessParseError) return { kind: "AssessParseError", code: error.code, message: error.message };
  if (error instanceof AssessError) return { kind: "AssessError", code: error.code, message: error.message };
  if (error instanceof DeriveParseError) return { kind: "DeriveParseError", code: error.code, message: error.message };
  if (error instanceof DeriveValidationError) {
    return { kind: "DeriveValidationError", code: `${error.layer}/${error.code}`, message: error.message };
  }
  if (error instanceof DeriveError) return { kind: "DeriveError", code: error.code, message: error.message };
  if (error instanceof Error) return { kind: error.name, code: "(none)", message: error.message };
  try {
    return { kind: "non-Error", code: "(none)", message: String(error) };
  } catch {
    return { kind: "non-Error", code: "(none)", message: "(a value that cannot be converted to a string)" };
  }
}

/** The capital slot, summarised for a human reading the probe output. */
function capitalView(context: DeriveContext): unknown {
  if (context.capital.outcome !== "ok") {
    return { outcome: context.capital.outcome, error: describe(context.capital.error) };
  }
  return {
    outcome: "ok",
    readAt: context.capital.value.readAt,
    rowsRead: context.capital.value.rowsRead,
    assets: context.capital.value.assets.map((entry) => ({
      asset: entry.asset,
      totalBalance: toDecimalString(entry.totalBalance),
      totalAllocated: toDecimalString(entry.totalAllocated),
      available: toDecimalString(entry.available),
    })),
  };
}

function filtersView(context: DeriveContext): unknown {
  if (context.filters.outcome !== "ok") {
    return { outcome: context.filters.outcome, error: describe(context.filters.error) };
  }
  const value = context.filters.value;
  return {
    outcome: "ok",
    pair: value.pair,
    baseAsset: value.baseAsset,
    quoteAsset: value.quoteAsset,
    status: value.status,
    minQuantity: toDecimalString(value.minQuantity),
    minNotional: toDecimalString(value.minNotional),
    stepSize: toDecimalString(value.stepSize),
    tickSize: toDecimalString(value.tickSize),
    instrument: value.instrument ?? null,
  };
}

/** The proposal, rendered so every number sits beside the ids it was drawn from. */
function proposalView(result: DeriveResult): unknown {
  const params =
    result.proposal.params.strategy === "grid"
      ? {
          strategy: "grid" as const,
          upperBound: toDecimalString(result.proposal.params.value.upperBound),
          lowerBound: toDecimalString(result.proposal.params.value.lowerBound),
          gridLines: result.proposal.params.value.gridLines,
          spacing: result.proposal.params.value.spacing,
          orderSize: toDecimalString(result.proposal.params.value.orderSize),
          stopLossPct: toDecimalString(result.proposal.params.value.stopLossPct),
          breakoutTakeProfit: result.proposal.params.value.breakoutTakeProfit,
          breakoutThresholdPct:
            result.proposal.params.value.breakoutThresholdPct === null
              ? null
              : toDecimalString(result.proposal.params.value.breakoutThresholdPct),
          takeProfitAmount:
            result.proposal.params.value.takeProfitAmount === null
              ? null
              : toDecimalString(result.proposal.params.value.takeProfitAmount),
        }
      : {
          strategy: "dca" as const,
          baseOrderSize: toDecimalString(result.proposal.params.value.baseOrderSize),
          additionalOrderSize: toDecimalString(result.proposal.params.value.additionalOrderSize),
          stepMultiplier: toDecimalString(result.proposal.params.value.stepMultiplier),
          dropPct: toDecimalString(result.proposal.params.value.dropPct),
          maxAdditionalBuys: result.proposal.params.value.maxAdditionalBuys,
          takeProfitPct: toDecimalString(result.proposal.params.value.takeProfitPct),
          stopLossPct: toDecimalString(result.proposal.params.value.stopLossPct),
          autoRestart: result.proposal.params.value.autoRestart,
          sellOnStopLoss: result.proposal.params.value.sellOnStopLoss,
        };

  return {
    params,
    allocatedCapital: toDecimalString(result.proposal.allocatedCapital),
    capitalAsset: result.proposal.capitalAsset,
    availableAtProposal: toDecimalString(result.proposal.availableAtProposal),
    referencePrice: toDecimalString(result.proposal.referencePrice),
    minimumOrderCheck: result.minimumOrderCheck,
    // Which ids each number rests on -- the whole grounding story, per field.
    citations: Object.fromEntries(
      Object.entries(result.citations.parameters).map(([field, cited]) => [
        field,
        cited.citations.map((item) => item.id),
      ]),
    ),
    allocatedCapitalCitations: result.citations.allocatedCapital.citations.map((item) => item.id),
    capitalAssetCitations: result.citations.capitalAsset.citations.map((item) => item.id),
    notes: result.notes.map((note) => ({
      statement: note.statement,
      citations: note.citations.map((item) => item.id),
    })),
  };
}

/**
 * GET /api/debug/derive-probe?pair=&interval=[&since=][&raw=1]
 *
 * ONE candidate. TWO model calls. Zero writes.
 *
 * `raw=1` includes the two raw transport values verbatim, which is how step 37
 * settled the envelope-shape question at the wire level rather than by
 * inference. Off by default because the Derive answer is large.
 */
export async function getDeriveProbe(ctx: ApiContext): Promise<Response> {
  const accountLabel = ctx.url.searchParams.get("accountLabel");
  if (accountLabel === null || accountLabel.trim() === "") {
    throw badRequest(
      "missing_field",
      'query parameter "accountLabel" is required. It is a query parameter rather than a path ' +
        "segment only because this probe lives under /api/debug rather than under " +
        "/api/accounts/:label, and it is temporary.",
    );
  }

  // The parameter handling deliberately mirrors `getAccountAssess`: `pair` and
  // `interval` are required with no default, for `fetchCandleWindow`'s reason --
  // a wrong interval does not error, it returns correctly-shaped candles of a
  // DIFFERENT duration that no reader downstream can distinguish, and here that
  // would reach two models as fact.
  const pair = ctx.url.searchParams.get("pair");
  if (pair === null || pair.trim() === "") {
    throw new ApiError(400, "missing_field", 'query parameter "pair" is required');
  }
  const interval = ctx.url.searchParams.get("interval");
  if (interval === null || !CANDLE_INTERVALS.includes(interval as CandleInterval)) {
    throw new ApiError(
      400,
      "invalid_filter",
      `query parameter "interval" is required and must be one of ${CANDLE_INTERVALS.join(", ")}`,
    );
  }
  const sinceParam = ctx.url.searchParams.get("since");
  let since: number | undefined;
  if (sinceParam !== null) {
    const parsed = Number(sinceParam);
    if (!Number.isInteger(parsed) || parsed < 0) {
      throw new ApiError(400, "invalid_field", '"since" must be a non-negative integer of epoch milliseconds');
    }
    since = parsed;
  }
  const includeRaw = ctx.url.searchParams.get("raw") === "1";

  const ports = probePorts(ctx);

  // --- Stage 1 --------------------------------------------------------------
  const set = await selectNamedCandidate(ports, {
    accountLabel,
    pair: pair as Pair,
    // The layer's standing rule: the actor is the email VERIFIED off the Access
    // token, never a caller-supplied string.
    requestedBy: ctx.actor,
  });
  const bundle = await gatherCandidateData(ports, set.candidates[0]!, {
    interval: interval as CandleInterval,
    ...(since === undefined ? {} : { since }),
  });

  // --- Stage 3's extra reads, before either model call ----------------------
  const context = await gatherDeriveContext(ports, bundle);

  // --- Stage 2: a REAL assessment, not a fabricated one --------------------
  const assessModel = ctx.assessModel ?? envAssessModel(ctx.env);
  const assessStartedAt = ctx.now();
  let assess: AssessResult;
  try {
    assess = await assessCandidate(assessModel, bundle);
  } catch (error) {
    return ok({
      probe: "derive",
      accountLabel,
      pair,
      interval,
      capital: capitalView(context),
      filters: filtersView(context),
      assess: { outcome: "failed", latencyMs: ctx.now() - assessStartedAt, error: describe(error) },
      derive: { outcome: "not_attempted", reason: "the assessment failed, so there was no strategy to derive for" },
    });
  }
  const assessLatencyMs = ctx.now() - assessStartedAt;

  // --- Stage 3: the real thing ---------------------------------------------
  const deriveModel = ctx.deriveModel ?? envDeriveModel(ctx.env);
  const deriveStartedAt = ctx.now();
  let derive: DeriveResult;
  try {
    derive = await deriveParameters(deriveModel, context, {
      strategy: assess.strategy,
      claims: assess.claims,
      envelope: assess.envelope,
      duplicateKeyCheck: assess.duplicateKeyCheck,
    });
  } catch (error) {
    // A REFUSAL IS A RESULT. Reported at 200 with its real code, because "the
    // validator rejected this with strategy_validator/validator_rejected" is
    // exactly what the probe exists to find out, and a 502 would lose it.
    return ok({
      probe: "derive",
      accountLabel,
      pair,
      interval,
      capital: capitalView(context),
      filters: filtersView(context),
      assess: {
        outcome: "assessed",
        strategy: assess.strategy,
        latencyMs: assessLatencyMs,
        envelope: assess.envelope,
        duplicateKeyCheck: assess.duplicateKeyCheck,
        promptChars: assess.promptText.length,
        evidenceCount: assess.evidence.length,
        claims: assess.claims.map((claim) => ({
          statement: claim.statement,
          citations: claim.citations.map((item) => item.id),
        })),
      },
      derive: {
        outcome: "refused",
        latencyMs: ctx.now() - deriveStartedAt,
        error: describe(error),
        ...(includeRaw ? { rawAssess: assess.response.raw } : {}),
      },
    });
  }
  const deriveLatencyMs = ctx.now() - deriveStartedAt;

  return ok({
    probe: "derive",
    accountLabel,
    pair,
    interval,
    capital: capitalView(context),
    filters: filtersView(context),
    assess: {
      outcome: "assessed",
      strategy: assess.strategy,
      latencyMs: assessLatencyMs,
      envelope: assess.envelope,
      duplicateKeyCheck: assess.duplicateKeyCheck,
      promptChars: assess.promptText.length,
      evidenceCount: assess.evidence.length,
      claims: assess.claims.map((claim) => ({
        statement: claim.statement,
        citations: claim.citations.map((item) => item.id),
      })),
    },
    derive: {
      outcome: "proposed",
      strategy: derive.strategy,
      latencyMs: deriveLatencyMs,
      envelope: derive.envelope,
      duplicateKeyCheck: derive.duplicateKeyCheck,
      promptVersion: derive.promptVersion,
      promptChars: derive.promptText.length,
      evidenceCount: derive.evidence.length,
      model: derive.model,
      proposal: proposalView(derive),
      ...(includeRaw ? { rawDerive: derive.response.raw, promptText: derive.promptText } : {}),
    },
  });
}
