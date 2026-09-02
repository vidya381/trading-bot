/**
 * 21.4 Stage 3 (Derive): the port a model would be reached through, the
 * determinism settings that would be requested, and the runner that joins the
 * prompt builder to the parser and the validators.
 *
 * ── NO MODEL IS CALLED FROM THIS FILE ──
 *
 * `DeriveModel` is an abstract port with no implementation behind it, exactly as
 * `AssessModel` was before `envAssessModel` (decision log 39) and exactly as
 * `TrendingSource` and `NewsSource` still are. When a real transport is written
 * it belongs in `src/workers/`, so everything under `src/research/` stays free
 * of bindings and testable without them.
 *
 * That ordering is the same one Stage 2 used and it is deliberate: the prompt
 * builder, the parser and the validators are the pieces whose correctness is
 * checkable WITHOUT a model, and they are the pieces that decide whether
 * requirement 1's grounding rule and requirement 6's fail-closed rule actually
 * hold. Wiring a live call first would mean the first real parameter set was
 * read by a validator nobody had adversarially tested.
 *
 * ── WHY THIS IS ITS OWN PORT AND NOT A WIDENED `AssessModel` ──
 *
 * `AssessModelRequest` carries `settings: AssessModelSettings`, whose
 * `responseFormat.json_schema` is typed as `typeof ASSESS_RESPONSE_SCHEMA` -- a
 * literal type, so Stage 2's schema cannot drift without the type system saying
 * so. Widening that to hold Derive's schema too means typing it `unknown`, which
 * throws away exactly the pinning that makes it worth having.
 *
 * There is a second and more important reason, and it is specific to this stage:
 * **Derive's schema depends on the strategy.** A `DeriveModelRequest` must
 * therefore carry which strategy it is for, so the wrong-schema-for-the-wrong-
 * strategy failure is a thing a type can express and a test can catch.
 * `AssessModelRequest` has no such field and should never grow one, because
 * Assess is the stage that DECIDES the strategy and cannot be told it.
 *
 * The transport is nonetheless shareable and is expected to be shared: the four
 * values `envAssessModel` forwards to `env.AI.run` (`prompt`, `temperature`,
 * `seed`, `max_tokens`, `response_format`) are read structurally off the
 * request, so a future `envDeriveModel` is the same handful of lines against
 * this request type. It is deliberately NOT written in this step -- there is no
 * live wiring here at all.
 *
 * ── ZERO RETRIES, FOR STAGE 2'S REASON, WHICH IS STRONGER HERE ──
 *
 * `deriveParameters` calls the model EXACTLY ONCE. A parse refusal or a
 * validation refusal is thrown to the caller and the run stops. There is no
 * retry, no back-off, no second sample and no "try again with a nudged prompt".
 *
 * A refusal IS the fail-closed mechanism working. "Retry until it validates"
 * converts that into "sample until one parameter set happens to satisfy the
 * validators" -- which is fail-OPEN wearing the costume of reliability, because
 * the accepted set is then selected FOR passing validation rather than for being
 * what the model proposed, and every rejected sample disappears silently.
 *
 * The reason is sharper for Derive than it was for Assess. Assess picks between
 * two words, so a resampling loop is at worst a biased coin. Derive proposes
 * NINE NUMBERS, and validation rejects the ones that do not fit inside the
 * account's capital and the venue's floors -- so a retry loop would be a search
 * procedure whose objective function is "parameters that squeeze through the
 * checks", run by something with no stake in whether they are good. The set it
 * eventually returned would look identical in an audit record to one the model
 * proposed cleanly on the first try, and those are very different facts.
 *
 * ── THE DETERMINISM STANCE ──
 *
 * Identical to Stage 2's and pinned for the same reasons (`DERIVE_MODEL_SETTINGS`).
 * Pinning is a REQUEST and Cloudflare guarantees nothing, so what makes a re-run
 * checkable rather than trusted is that the prompt text, the settings, the model
 * id and the raw response all travel on `DeriveResult` for 21.5 requirement 5's
 * audit record. Two runs are compared by recorded bytes, never assumed identical.
 *
 * ── WHAT THIS STAGE CANNOT DO, RESTATED WHERE A CALLER WILL SEE IT ──
 *
 * **A WELL-FORMED PROPOSAL IS NOT A GOOD ONE.** Every check in this stage --
 * grounding, the real decoders, the real validators, the venue floors, the
 * capital headroom -- answers questions about internal consistency and about
 * whether a bot COULD be created from these numbers. Not one of them answers
 * whether the numbers are worth creating a bot from, and none of them can look
 * upstream. Decision log 40 recorded a live Assess run whose grid recommendation
 * was correctly grounded in real fetched candles and financially meaningless,
 * because the sandbox those candles came from had sat at one price for five
 * hours. Derive, handed that judgement, would produce tight, plausible, fully
 * cited bounds around a frozen price and every check here would pass.
 *
 * Derive cannot detect a bad upstream judgement. It can only be well grounded in
 * whatever judgement it is given. The human in 21.1 is the only part of this
 * pipeline that can tell the two apart.
 */

import type { StrategyType } from "../db/schema";
import type { Money } from "../shared/money";
import { ZERO } from "../shared/money";
import type { EvidenceItem } from "./assess-prompt";
import type { AssessEnvelopeShape, CitedClaim, DuplicateKeyCheck, ParsedAssessment } from "./assess-parse";
import { hasAnyHeadroom } from "./capital";
import {
  deriveResponseSchema,
  parseDeriveResponse,
  validateProposal,
  type MinimumOrderCheck,
  type ParsedProposal,
  type ValidatedProposal,
} from "./derive-parse";
import {
  DCA_DERIVE_FIELDS,
  GRID_DERIVE_FIELDS,
  TRAILING_STOP_DERIVE_FIELDS,
  buildDerivePrompt,
  type DerivePrompt,
} from "./derive-prompt";
import type { DeriveContext } from "./gather";

// ---------------------------------------------------------------------------
// Model selection and determinism
// ---------------------------------------------------------------------------

/**
 * The model this stage would use: the same one Stage 2 uses.
 *
 * Deliberately the same, and named here rather than imported from `assess.ts`,
 * because "both stages happen to use one model" and "this stage is defined as
 * using whatever Assess uses" are different claims and only the first is true. A
 * later step may well want a larger-context model here -- this prompt is the
 * bigger of the two -- and that should be a one-line change to this constant
 * rather than a change that silently moves Stage 2 as well.
 *
 * Its selection is argued in `assess.ts`: it is the only currently-listed,
 * non-deprecated model appearing both on Cloudflare's JSON Mode supported list
 * and carrying `response_format` in its own documented parameter schema.
 */
export const DERIVE_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

/** The documented context window of `DERIVE_MODEL`, in tokens. Documentation, not measurement. */
export const DERIVE_MODEL_CONTEXT_TOKENS = 24_000;

export interface DeriveModelSettings {
  /** 0, the documented minimum. See `AssessModelSettings.temperature`. */
  readonly temperature: number;
  /**
   * The same fixed constant Stage 2 uses.
   *
   * The same value rather than a different one on purpose: nothing about this
   * stage depends on the two seeds differing, and a different number here would
   * imply a reason that does not exist. A random seed would make two runs on
   * identical data differ for a reason nobody could reconstruct from the audit
   * record.
   */
  readonly seed: number;
  /**
   * Higher than Stage 2's 2,048, because this answer is structurally bigger.
   *
   * A grid proposal carries nine `{value, citations}` objects plus two capital
   * fields plus a non-empty note list; Stage 2's carries a word and a few
   * sentences. `max_tokens` costs nothing when it is not reached (Workers AI
   * bills generated tokens, not the ceiling), and an answer cut off mid-object
   * fails closed as `not_json` -- safely, but on every single run, which is a
   * broken stage rather than a safe one.
   *
   * A CHOICE, NOT A MEASUREMENT. No real Derive response has been observed.
   */
  readonly maxTokens: number;
  /**
   * `top_p` and `top_k` are deliberately ABSENT rather than set, for
   * `AssessModelSettings`' reason: `top_p`'s documented minimum is 0.001, so it
   * cannot express "take the most likely token", and setting it alongside
   * `temperature: 0` would be a second sampling control fighting the first with
   * undocumented behaviour if they disagree.
   *
   * `json_schema` is `Record<string, unknown>` rather than a literal type
   * because IT DIFFERS PER STRATEGY -- that is the whole conditional-schema
   * design, and pinning it to one literal would make it impossible to express.
   * The pinning that replaces it is `DERIVE_MODEL_SETTINGS` being a frozen
   * record with one entry per strategy, tested field by field.
   */
  readonly responseFormat: {
    readonly type: "json_schema";
    readonly json_schema: Record<string, unknown>;
  };
}

function settingsFor(strategy: StrategyType, fields: readonly string[]): DeriveModelSettings {
  return Object.freeze({
    temperature: 0,
    seed: 20_260_811,
    maxTokens: 4_096,
    responseFormat: Object.freeze({
      type: "json_schema" as const,
      json_schema: deriveResponseSchema(strategy, fields),
    }),
  });
}

/**
 * THE STRATEGY-CONDITIONAL SETTINGS. One entry per strategy, frozen.
 *
 * A record rather than a function call at request time so the two schemas are
 * built once, are inspectable by a test side by side, and cannot be built from a
 * strategy variable that a bug has already got wrong. `deriveParameters` indexes
 * it with `assessment.strategy` and nothing else.
 */
export const DERIVE_MODEL_SETTINGS: Readonly<Record<StrategyType, DeriveModelSettings>> =
  Object.freeze({
    grid: settingsFor("grid", GRID_DERIVE_FIELDS),
    dca: settingsFor("dca", DCA_DERIVE_FIELDS),
    // Spec 22. Built exactly like the other two -- same `settingsFor`, same
    // temperature, same seed -- so the one-field schema is the strategy's own
    // and not a special case. 22.4 touchpoint 4: one field does not make the
    // proposal easier to justify.
    trailing_stop: settingsFor("trailing_stop", TRAILING_STOP_DERIVE_FIELDS),
  });

// ---------------------------------------------------------------------------
// The port
// ---------------------------------------------------------------------------

/** Exactly what would be sent, in this system's own terms rather than a vendor's. */
export interface DeriveModelRequest {
  readonly model: string;
  readonly prompt: string;
  readonly settings: DeriveModelSettings;
  /**
   * Which strategy this request is for.
   *
   * Carried so a transport, a test double or an audit record can see that the
   * schema in `settings` is the schema for THIS strategy. It is the field that
   * makes "the wrong schema was served" observable rather than a difference
   * buried inside a JSON Schema object nobody reads.
   */
  readonly strategy: StrategyType;
}

/** What a model implementation must hand back. See `AssessModelResponse` -- same shape, same reason. */
export interface DeriveModelResponse {
  readonly text: unknown;
  readonly raw: unknown;
}

/** The seam a model sits behind. No implementation exists in this repository. */
export type DeriveModel = (request: DeriveModelRequest) => Promise<DeriveModelResponse>;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type DeriveErrorCode =
  /** The bundle carries no usable candle window, so there is no price to derive from. */
  | "no_price_history"
  /** `capital_ledger` could not be read, so no allocation figure could be grounded. */
  | "capital_unreadable"
  /** The read succeeded and the account can fund nothing. */
  | "no_capital_headroom"
  /** The pair's real trading filters could not be read, so no order floor is checkable. */
  | "symbol_filters_unreadable";

export class DeriveError extends Error {
  readonly code: DeriveErrorCode;
  constructor(code: DeriveErrorCode, message: string) {
    super(message);
    this.name = "DeriveError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// The result
// ---------------------------------------------------------------------------

/**
 * One derivation, carrying everything needed to check it (21.5 requirements 2
 * and 5) rather than just its conclusion.
 *
 * `proposal` is the validated parameter set -- the real `GridParams`/`DcaParams`
 * the real decoder produced. `citations` is the model's own per-field grounding,
 * resolved to real `EvidenceItem`s, so a human reads each number beside the
 * datum it was drawn from. `evidence` is EVERYTHING the model was offered, not
 * only what it cited, so a reader can see what it ignored.
 */
export interface DeriveResult {
  readonly strategy: StrategyType;
  readonly proposal: ValidatedProposal;
  /** The model's per-field citations, by field name, plus the two capital fields. */
  readonly citations: ParsedProposal;
  readonly notes: readonly [CitedClaim, ...CitedClaim[]];
  readonly envelope: AssessEnvelopeShape;
  readonly duplicateKeyCheck: DuplicateKeyCheck;
  /** Which venue floor was actually available to check. See `MinimumOrderCheck`. */
  readonly minimumOrderCheck: MinimumOrderCheck;
  readonly promptVersion: string;
  readonly promptText: string;
  readonly evidence: readonly EvidenceItem[];
  readonly model: string;
  readonly settings: DeriveModelSettings;
  readonly response: DeriveModelResponse;
  /** Stage 2's result by identity: the strategy this was derived FOR, with its reasons. */
  readonly assessment: ParsedAssessment;
  /** Stage 1's bundle plus Stage 3's extra reads, by identity. */
  readonly context: DeriveContext;
}

// ---------------------------------------------------------------------------
// The runner
// ---------------------------------------------------------------------------

/**
 * Build the prompt, ask the model, refuse anything that is not a clean,
 * fully-grounded, fully-valid parameter set.
 *
 * IT CATCHES NOTHING. A model implementation that throws throws out of here, a
 * response the parser refuses throws `DeriveParseError` out of here, a parameter
 * set any validator rejects throws `DeriveValidationError` out of here, and the
 * preconditions below throw `DeriveError`. There is no partial result and no
 * degraded one, because 21.5 requirement 6 forbids one and because a `catch`
 * here is the only place a fail-open default could ever be introduced.
 *
 * ── THE PRECONDITIONS, AND WHY EACH IS BEFORE THE CALL RATHER THAN AFTER ──
 *
 * All four refuse BEFORE a paid inference is spent, and each one is the absence
 * of something the question is ABOUT rather than a judgement about quality
 * (which remains Stage 4's, and is deliberately absent here):
 *
 *  1. **No price history.** `assessCandidate` refuses this too, so a bundle that
 *     reached Stage 2 has already passed it -- but this stage is callable
 *     independently and must not depend on having been called in order. Every
 *     grid bound and every DCA drop is a price, and a model asked for prices
 *     with no prices could only answer from the training knowledge 21.5
 *     requirement 1 forbids.
 *  2. **Capital unreadable.** Not "assume none" and not "assume plenty": section
 *     5.6's rule that a failed read is never data, applied to money.
 *  3. **No headroom at all.** The read succeeded and every asset is at or below
 *     zero available. There is no figure `allocatedCapital` could take that a
 *     human could act on, so producing one would be producing a proposal that
 *     cannot become a bot.
 *  4. **Filters unreadable.** This is the one that would be easiest to wave
 *     through, and it is refused for `checkSpotInstrument`'s reason: a floor
 *     that did not arrive is not a floor that said zero. Proceeding would put a
 *     parameter set in front of a human under a heading saying it was validated,
 *     when the one check 21.5 requirement 3 names that nothing else in this
 *     system performs could not run at all.
 *
 * A failed NEWS or CONCENTRATION slot does NOT block, exactly as in Stage 2:
 * both are context around the question rather than the question, both are stated
 * to the model as missing, and blocking on them would be the over-propagation
 * `gather.ts` was built to avoid.
 *
 * @param model      the port. One call, no retries.
 * @param context    Stage 1's bundle plus Stage 3's two extra real reads.
 * @param assessment Stage 2's REAL result. The strategy comes from here and from
 *                   nowhere else; this function never infers, defaults or
 *                   re-decides it.
 */
export async function deriveParameters(
  model: DeriveModel,
  context: DeriveContext,
  assessment: ParsedAssessment,
): Promise<DeriveResult> {
  const { bundle, capital, filters } = context;

  if (bundle.candles.outcome !== "ok" || bundle.candles.value.candles.length === 0) {
    throw new DeriveError(
      "no_price_history",
      `this candidate has no usable price history (candles: ${bundle.candles.outcome}), so no parameter could be grounded in a fetched price. Every bound, every drop percentage and every order size this stage would propose is a claim about prices, and a model asked for them without prices could only answer from training knowledge about ${bundle.candidate.pair}, which 21.5 requirement 1 forbids.`,
    );
  }

  if (capital.outcome !== "ok") {
    throw new DeriveError(
      "capital_unreadable",
      `the account's capital_ledger could not be read (${capital.outcome}), so the account's real headroom is UNKNOWN. Refusing rather than proposing an allocation figure anyway: a number suggested without knowing what is available is a fabricated one, and it would be shown to a human immediately before they commit real capital (section 5.6; 21.5 requirement 6).`,
    );
  }

  if (!hasAnyHeadroom(capital.value)) {
    throw new DeriveError(
      "no_capital_headroom",
      `account ${JSON.stringify(bundle.candidate.accountLabel)} has no asset with capital available: the capital_ledger read succeeded and found ${capital.value.rowsRead} row(s), none with a positive balance minus allocation. There is no allocation this proposal could suggest that could become a bot, so none is proposed.`,
    );
  }

  if (filters.outcome !== "ok") {
    throw new DeriveError(
      "symbol_filters_unreadable",
      `the real trading filters for ${JSON.stringify(bundle.candidate.pair)} could not be read (${filters.outcome}), so the venue's minimum order size is UNKNOWN and cannot be checked. Refusing rather than skipping the check: this is the one validation 21.5 requirement 3 names that no other part of this system performs before an order is actually placed, and a proposal presented as validated with it silently skipped is exactly the degraded-but-indistinguishable result requirement 6 forbids.`,
    );
  }

  const candles = bundle.candles.value.candles;
  const latestClose: Money = candles[candles.length - 1]!.close;
  if (latestClose <= ZERO) {
    // Unreachable through `fetchCandleWindow`, which validates its candles, but
    // it divides by this to imply a quantity. Refused as missing price history
    // rather than allowed to produce a division by zero, for the reason
    // `collectCandles` refuses to render zeroes from an empty window: a
    // fabricated price is a worse failure than an unreachable branch is a cost.
    throw new DeriveError(
      "no_price_history",
      `the newest candle for ${JSON.stringify(bundle.candidate.pair)} closes at ${latestClose}, which is not a positive price. No order quantity can be implied from it, so no order size could be checked against the venue's floor.`,
    );
  }

  const prompt: DerivePrompt = buildDerivePrompt(context, assessment);

  // THE CONDITIONAL SEAM AT THE REQUEST BOUNDARY. Indexed by the strategy Stage
  // 2 chose, so the schema sent with the prompt is the schema for the prompt
  // that was built.
  const settings = DERIVE_MODEL_SETTINGS[assessment.strategy];

  const response = await model({
    model: DERIVE_MODEL,
    prompt: prompt.promptText,
    settings,
    strategy: assessment.strategy,
  });

  const parsed = parseDeriveResponse(response.text, prompt);
  const validated = validateProposal(parsed, capital.value, filters.value, latestClose);

  return {
    strategy: validated.strategy,
    proposal: validated,
    citations: parsed,
    notes: parsed.notes,
    envelope: parsed.envelope,
    duplicateKeyCheck: parsed.duplicateKeyCheck,
    minimumOrderCheck: validated.minimumOrderCheck,
    promptVersion: prompt.version,
    promptText: prompt.promptText,
    evidence: prompt.evidence,
    model: DERIVE_MODEL,
    settings,
    response,
    assessment,
    context,
  };
}
