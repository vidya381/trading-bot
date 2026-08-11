/**
 * 21.4 Stage 2 (Assess): the port a model would be reached through, the
 * determinism settings that would be requested, and the thin runner that joins
 * the prompt builder to the parser.
 *
 * ── NO MODEL IS CALLED FROM THIS REPOSITORY, AND THAT IS THE POINT OF THIS FILE ──
 *
 * There is NO Workers AI binding in `wrangler.jsonc`, no `env.AI` reference
 * anywhere in `src/`, and no code path -- test or otherwise -- that reaches
 * Cloudflare's inference API. `AssessModel` is an abstract port with no
 * implementation behind it, exactly as `TrendingSource` is a port with no
 * vendor behind it (`candidates.ts`) and `NewsSource` is a port with no key
 * behind it (`news.ts`).
 *
 * This is not an unfinished edge. The prompt and the parser are the two pieces
 * whose correctness is checkable WITHOUT a model -- one is a pure function of a
 * bundle, the other a pure function of a string -- and they are the two pieces
 * that decide whether requirement 1's grounding rule and requirement 6's
 * fail-closed rule actually hold. Wiring a live call first would mean the first
 * real model response was read by a parser nobody had adversarially tested.
 *
 * ── WHAT IS VERIFIED ABOUT WORKERS AI, AND WHAT IS ASSUMED ──
 *
 * VERIFIED against Cloudflare's own documentation and against this repository's
 * generated `worker-configuration.d.ts` (produced by `wrangler types`,
 * wrangler ^4.112.0):
 *
 *   * The binding is `{ "ai": { "binding": "AI" } }` in the Wrangler config and
 *     arrives as `env.AI`, typed `Ai`.
 *     (developers.cloudflare.com/workers-ai/configuration/bindings/)
 *   * The call is `env.AI.run(model, inputs, options?)`. For
 *     `@cf/meta/llama-3.3-70b-instruct-fp8-fast` the `inputs` union accepts
 *     either `{ prompt: string, ... }` or `{ messages: [...], ... }`, and the
 *     prompt variant carries `temperature`, `seed`, `top_p`, `top_k`,
 *     `max_tokens`, `repetition_penalty`, `frequency_penalty`,
 *     `presence_penalty`, `raw`, `stream` and `response_format`.
 *     (`worker-configuration.d.ts`, interface
 *     `Ai_Cf_Meta_Llama_3_3_70B_Instruct_Fp8_Fast_Prompt`.)
 *   * `temperature` is documented `default: 0.6, minimum: 0, maximum: 5`;
 *     `seed` is `minimum: 1, maximum: 9999999999` and described as "Random seed
 *     for reproducibility of the generation"; `max_tokens` defaults to 256.
 *   * `response_format` is `{ type?: "json_object" | "json_schema";
 *     json_schema?: unknown }`, and Cloudflare's JSON Mode page states plainly
 *     that it "can't guarantee that the model responds according to the
 *     requested JSON Schema", returning an error `JSON Mode couldn't be met`
 *     when it cannot.
 *   * The output type is a UNION -- `{ response: string; usage?; tool_calls? }
 *     | string | { request_id?: string }` -- so a caller that reads `.response`
 *     without narrowing is reading a field that is sometimes absent.
 *
 * OBSERVED, by one real call on the first probe (and therefore stronger than
 * either category above):
 *
 *   * WITH `response_format: {type: "json_schema"}`, THIS MODEL RETURNS
 *     `{ response: { strategy: "grid", claims: [...] } }` -- `.response` is an
 *     ALREADY-PARSED OBJECT. **Cloudflare's own generated type declares that arm
 *     as `{ response: string }`, and for this model in this mode that type is
 *     wrong.** The parser refused the response on the first probe, which was
 *     correct behaviour against a wrong assumption rather than a bug in its
 *     strictness; the fix is confined to envelope unwrapping
 *     (`unwrapModelEnvelope`) and relaxes no content rule.
 *   * The model followed the response contract and the grounding rules on that
 *     one call: an exact strategy literal, every claim citing a real emitted
 *     evidence id, the missing news input reported as missing rather than
 *     ignored, and the concentration flags treated as account state rather than
 *     as evidence about the coin.
 *   * ONE CALL IS ONE CALL. It is not a compliance rate, and nothing here
 *     should be read as one.
 *   * Text-generation rate limit: 300 requests per minute by default.
 *     (workers-ai/platform/limits/)
 *   * Price: $0.011 per 1,000 Neurons, with 10,000 Neurons per day free;
 *     `llama-3.3-70b-instruct-fp8-fast` costs 26,668 neurons per M input tokens
 *     and 204,805 per M output tokens ($0.293/$2.253 per M).
 *     (workers-ai/platform/pricing/)
 *   * Context window: 24,000 tokens for this model. That number is the reason
 *     `assess-prompt.ts` buckets the candle series instead of sending 1,440
 *     candles verbatim.
 *
 * ASSUMED, and flagged as such:
 *
 *   * THAT ANY OF THIS WORKS AS DOCUMENTED. Nothing in this repository has ever
 *     called Workers AI. Every statement above is read from documentation and
 *     from a generated type file, which is the same epistemic position
 *     `news.ts` is in about CoinDesk (decision log 30) and it deserves the same
 *     caution.
 *   * THAT `temperature: 0` MEANS GREEDY DECODING. Cloudflare documents the
 *     range and not the semantics at the endpoint.
 *   * THAT A FIXED `seed` REPRODUCES A RESPONSE. "Reproducibility" is the
 *     word the docs use; no guarantee of bitwise determinism across requests,
 *     replicas or model revisions is given, and none should be assumed.
 *   * THAT THE MODEL ID REMAINS AVAILABLE. Cloudflare's catalogue marks models
 *     deprecated over time -- several models the JSON Mode page still lists as
 *     supported are marked deprecated in the model catalogue today, which is
 *     itself a reason not to trust a single documentation page.
 *
 * ── OPEN QUESTION: 13.5 SECONDS PER CALL, AND WHAT THAT DOES TO THE PIPELINE ──
 *
 * The first real call took **13,540 ms** end to end for a ~4,000-token prompt.
 * That is one measurement of one call and not a distribution, but it is large
 * enough to matter at the shape level rather than the tuning level:
 *
 *   * A 12-candidate general run (21.3's watchlist of 5-10 plus a trending
 *     pull), assessed SEQUENTIALLY as `gather.ts` already gathers, would spend
 *     **over two and a half minutes in model calls alone**, on top of the
 *     candle fetches decision log 36 measured at ~2 s for eight candidates.
 *   * Stage 3 (Derive) is a SECOND model call per candidate (21.4), so a full
 *     pipeline run is plausibly double that again.
 *
 * **Whether Assess can ever run synchronously inside an HTTP response, or
 * whether the pipeline needs to be queued or otherwise asynchronous, is now an
 * open question and is NOT answered here.** It is recorded rather than solved
 * because the answer changes the shape of everything above this stage -- the
 * endpoint, the proposal record, how a human is told a run is in progress --
 * and picking one now, from a single latency sample, would be choosing an
 * architecture from one data point.
 *
 * ── ZERO RETRIES, AS A DESIGN DECISION RATHER THAN AN OMISSION ──
 *
 * `assessCandidate` calls the model EXACTLY ONCE. A refusal from
 * `parseAssessResponse` is returned to the caller as a failure and the run
 * stops. There is no retry loop, no back-off, no second sample, and no
 * "try again with a nudged prompt", and adding one later would be a change of
 * safety posture rather than a robustness improvement.
 *
 * The reason is specific. A parse refusal IS the fail-closed mechanism working:
 * it means the model did not answer within the rules, which is information about
 * this run. "Retry until it parses" converts that into "sample until one
 * response happens to satisfy the validator" -- which is fail-OPEN wearing the
 * costume of reliability, because the accepted answer is then selected FOR
 * passing validation rather than for being right, and every rejected sample
 * (including ones that disagreed about the strategy) disappears silently. A
 * three-attempt loop that returns "grid" on the third try looks identical in the
 * audit record to a model that said "grid" cleanly the first time, and those are
 * very different facts.
 *
 * It also interacts badly with the determinism stance below: with `temperature:
 * 0` and a fixed `seed`, a retry SHOULD produce the same output, so a retry loop
 * that ever succeeds is evidence that the pinning did not hold -- and the loop
 * would be quietly consuming exactly the signal that would have told us.
 *
 * If refusals turn out to be common in practice, that is a fact about the model
 * or the prompt and it belongs in a decision log, fixed at the source. It is not
 * a reason to sample again.
 *
 * ── THE DETERMINISM STANCE ──
 *
 * A human re-running the same coin minutes later must not get a different
 * strategy on the same data, so every knob that can be pinned is pinned
 * (`ASSESS_MODEL_SETTINGS`) -- and the stance does not stop there, because
 * pinning is a REQUEST and Cloudflare guarantees nothing. What makes a
 * re-run checkable rather than trusted is that the prompt text, the settings,
 * the model id and the raw response are all carried on `AssessResult` for
 * 21.5 requirement 5's audit record: two runs are compared by their recorded
 * bytes, never assumed identical.
 */

import type { StrategyType } from "../db/schema";
import { buildAssessPrompt, type AssessPrompt, type EvidenceItem } from "./assess-prompt";
import {
  ASSESS_RESPONSE_SCHEMA,
  parseAssessResponse,
  type AssessEnvelopeShape,
  type CitedClaim,
  type DuplicateKeyCheck,
} from "./assess-parse";
import type { CandidateGatherBundle } from "./gather";

// ---------------------------------------------------------------------------
// Model selection and determinism
// ---------------------------------------------------------------------------

/**
 * The model this stage would use.
 *
 * Chosen over the alternatives for one reason that outranks the others: it is
 * the only currently-listed, non-deprecated model that appears BOTH in
 * Cloudflare's JSON Mode supported list AND carries `response_format` in its own
 * documented parameter schema. Larger-context models (`gpt-oss-120b`,
 * `llama-4-scout-17b-16e-instruct`, both 128k) are cheaper per token and would
 * remove the need to bucket candles at all, but their JSON-mode support is not
 * stated on the JSON Mode page, and this stage's whole safety story rests on a
 * structured response.
 *
 * NOT VERIFIED BY A CALL. See the module header.
 */
export const ASSESS_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

/** The documented context window of `ASSESS_MODEL`, in tokens. Documentation, not measurement. */
export const ASSESS_MODEL_CONTEXT_TOKENS = 24_000;

export interface AssessModelSettings {
  /**
   * 0, the documented minimum.
   *
   * The default is 0.6, which is a sampling temperature chosen for conversation
   * and is exactly wrong for a question whose answer is one of two words. This
   * assumes -- see the header -- that 0 means greedy decoding at Cloudflare's
   * endpoint rather than merely "very low".
   */
  readonly temperature: number;
  /**
   * A fixed constant, not a per-run value.
   *
   * A random seed would make two runs on identical data differ for a reason
   * nobody could reconstruct from the audit record. A fixed one at least makes
   * "same data, same prompt, same settings" a repeatable experiment. The value
   * is arbitrary and inside the documented range (1..9,999,999,999).
   */
  readonly seed: number;
  /**
   * Well above the documented default of 256.
   *
   * A cited answer over a two-dozen-item evidence table does not fit 256
   * tokens, and an answer cut off mid-object is not valid JSON -- which fails
   * closed as `not_json` rather than truncating into something readable, but
   * fails on every run, which is a broken stage rather than a safe one.
   */
  readonly maxTokens: number;
  /**
   * `top_p` and `top_k` are deliberately ABSENT rather than set.
   *
   * `top_p`'s documented minimum is 0.001, so it cannot express "take the most
   * likely token"; setting it alongside `temperature: 0` would be a second
   * sampling control fighting the first, and if the two ever disagree the
   * behaviour is undocumented. One pinned knob whose meaning is stated beats
   * three whose interaction is not.
   */
  readonly responseFormat: {
    readonly type: "json_schema";
    readonly json_schema: typeof ASSESS_RESPONSE_SCHEMA;
  };
}

export const ASSESS_MODEL_SETTINGS: AssessModelSettings = Object.freeze({
  temperature: 0,
  seed: 20_260_811,
  maxTokens: 2_048,
  responseFormat: Object.freeze({ type: "json_schema", json_schema: ASSESS_RESPONSE_SCHEMA }),
} as const);

// ---------------------------------------------------------------------------
// The port
// ---------------------------------------------------------------------------

/** Exactly what would be sent, in this system's own terms rather than a vendor's. */
export interface AssessModelRequest {
  readonly model: string;
  readonly prompt: string;
  readonly settings: AssessModelSettings;
}

/**
 * What a model implementation must hand back.
 *
 * `text` is the model's answer as a string and `raw` is whatever the transport
 * really returned, kept by identity. Two fields rather than one because the
 * Workers AI output type is a union that includes a bare string and an
 * async-batch envelope: the narrowing from that union to a string is a decision
 * an implementation makes, and the audit record should hold the thing it
 * narrowed FROM as well as the thing it narrowed TO.
 */
export interface AssessModelResponse {
  readonly text: unknown;
  readonly raw: unknown;
}

/**
 * The seam a model sits behind. No implementation exists in this repository.
 *
 * When one is written it belongs in `src/workers/`, beside `envNewsFetcher` and
 * `envCandleLister`, so that everything under `src/research/` stays free of
 * bindings and testable without them.
 */
export type AssessModel = (request: AssessModelRequest) => Promise<AssessModelResponse>;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type AssessErrorCode =
  /** The bundle carries no usable candle window, so there is nothing to reason from. */
  | "no_price_history";

export class AssessError extends Error {
  readonly code: AssessErrorCode;
  constructor(code: AssessErrorCode, message: string) {
    super(message);
    this.name = "AssessError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// The result
// ---------------------------------------------------------------------------

/**
 * One assessment, carrying everything needed to check it (21.5 requirements 2
 * and 5) rather than just its conclusion.
 *
 * The shape is chosen so that no part of it is a claim a reader must take on
 * trust:
 *
 *   * `claims[i].citations` are resolved `EvidenceItem`s -- id, label, the
 *     exact rendered value and the path into the bundle it came from -- so the
 *     model's reasoning sits beside the data it cites rather than beside a
 *     summary of it.
 *   * `evidence` is EVERYTHING the model was offered, not only what it cited,
 *     so a reader can see what it ignored. A model that ignored the
 *     concentration flag is a fact only visible from the difference.
 *   * `promptText` and `response` are the literal bytes in and out.
 *   * `bundle` is the Stage 1 bundle by identity, so the raw candles, the real
 *     provenance and the paused news slot travel with the conclusion.
 */
export interface AssessResult {
  readonly strategy: StrategyType;
  readonly claims: readonly [CitedClaim, ...CitedClaim[]];
  /** Which transport shape the answer arrived in (observed, see assess-parse.ts). */
  readonly envelope: AssessEnvelopeShape;
  /** Whether the duplicate-key protection could run for THIS response. */
  readonly duplicateKeyCheck: DuplicateKeyCheck;
  readonly promptVersion: string;
  readonly promptText: string;
  readonly evidence: readonly EvidenceItem[];
  readonly model: string;
  readonly settings: AssessModelSettings;
  readonly response: AssessModelResponse;
  readonly bundle: CandidateGatherBundle;
}

// ---------------------------------------------------------------------------
// The runner
// ---------------------------------------------------------------------------

/**
 * Build the prompt, ask the model, refuse anything that is not a clean answer.
 *
 * IT CATCHES NOTHING. A model implementation that throws throws out of here, a
 * response the parser refuses throws `AssessParseError` out of here, and the
 * precondition below throws `AssessError`. There is no partial result and no
 * degraded one, because 21.5 requirement 6 forbids one and because a `catch`
 * here is the only place a fail-open default could ever be introduced.
 *
 * ── The one precondition, and why it is not Stage 4's judgement ──
 *
 * A bundle whose candle slot is not `ok` -- or is `ok` and empty -- is refused
 * BEFORE the model is called, and this is the single place in the research
 * folder that refuses a bundle rather than reporting its state.
 *
 * It is not a quality judgement ("these candles are too shallow", "this coin is
 * too new"), which genuinely is Stage 4's and is deliberately absent. It is the
 * absence of the only input the question is ABOUT: asked to judge volatility
 * and trend character with no prices at all, a model can only answer from
 * general knowledge of the coin, which is precisely what 21.5 requirement 1
 * forbids. Refusing costs a run; asking would invite the exact failure the
 * grounding rule exists to prevent, and would spend a paid inference to do it.
 *
 * A failed NEWS slot or a failed CONCENTRATION slot does NOT block the call.
 * Both are context around the question rather than the question, both are
 * stated to the model as missing by `buildAssessPrompt`, and blocking on them
 * would be exactly the over-propagation `gather.ts` was built to avoid.
 */
export async function assessCandidate(
  model: AssessModel,
  bundle: CandidateGatherBundle,
): Promise<AssessResult> {
  if (bundle.candles.outcome !== "ok" || bundle.candles.value.candles.length === 0) {
    throw new AssessError(
      "no_price_history",
      `this candidate has no usable price history (candles: ${bundle.candles.outcome}), so no strategy judgement could be grounded in fetched data. A model asked this question without prices could only answer from training knowledge about ${bundle.candidate.pair}, which 21.5 requirement 1 forbids.`,
    );
  }

  const prompt: AssessPrompt = buildAssessPrompt(bundle);

  const response = await model({
    model: ASSESS_MODEL,
    prompt: prompt.promptText,
    settings: ASSESS_MODEL_SETTINGS,
  });

  const parsed = parseAssessResponse(response.text, prompt);

  return {
    strategy: parsed.strategy,
    claims: parsed.claims,
    envelope: parsed.envelope,
    duplicateKeyCheck: parsed.duplicateKeyCheck,
    promptVersion: prompt.version,
    promptText: prompt.promptText,
    evidence: prompt.evidence,
    model: ASSESS_MODEL,
    settings: ASSESS_MODEL_SETTINGS,
    response,
    bundle,
  };
}
