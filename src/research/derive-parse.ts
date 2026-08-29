/**
 * 21.4 Stage 3 (Derive), second half: the STRICT, FAIL-CLOSED reader of a
 * model's proposed parameter set, and the validation that decides whether a
 * human is ever shown it.
 *
 * NOTHING HERE CALLS A MODEL. Two pure functions from a raw response plus the
 * `DerivePrompt` that produced it, to either a fully-validated proposal or a
 * thrown error. There is no third outcome.
 *
 * ── A PROPOSAL IS ALL-OR-NOTHING. THIS IS THE WHOLE FILE. ──
 *
 * 21.5 requirement 6 forbids a partial or degraded proposal, and a parameter set
 * is where that rule has the most to lose. A strategy choice is one word and a
 * human can see it is wrong; a parameter set is nine numbers and a human reading
 * it is checking the REASONING, not re-deriving the arithmetic. So one bad field
 * in nine must discard all nine.
 *
 * **NOTHING IN THIS FILE EVER SUBSTITUTES, DEFAULTS, CLAMPS, ROUNDS, CORRECTS OR
 * DROPS A FIELD.** There is no "the model gave 0% so use 5%", no "the model's
 * orderSize was under the minimum so raise it", no "breakoutThresholdPct was
 * missing so use the documented default of null". Every one of those reads as a
 * kindness and every one produces a parameter set that no model proposed and no
 * human chose, presented under a heading that says a model proposed it. A
 * refusal costs a run. A silently corrected proposal costs whatever the bot
 * built from it costs.
 *
 * ── WHAT IS REUSED, AND WHAT IS DELIBERATELY NOT DUPLICATED ──
 *
 * 21.5 requirement 3 says the create-bot flow's own validation is "Reused, not
 * reimplemented -- a second implementation of a risk check drifts from the
 * first, and the copy that drifts is the one nobody is watching." Taken
 * literally, that means this file must import the real functions and must NOT
 * restate their rules. It does, in the real path's own order:
 *
 *   1. `decodeGridParams` / `decodeDcaParams` -- the exact decoders
 *      `POST /api/bots` runs on a human's own form submission (`handlers.ts`
 *      `createBot`). Handed the model's `parameters` object with NOTHING added,
 *      removed, renamed or coerced, plus the same two literals the handler adds
 *      (`strategy` and `schemaVersion`). They own every type check.
 *   2. `validateGridParams` / `validateDcaParams` -- the exact validators
 *      `BotInstance.createGrid` / `BotInstance.create` run before any capital is
 *      reserved. They own positivity, the below-100% percentage rules, the
 *      mandatory-stop-loss rule, `sellOnStopLoss` being unimplemented, the
 *      ladder's shape via `buildLevels`, and whether the configuration fits
 *      inside its own allocation.
 *   3. `checkDeriveSanityBounds` -- and ONLY the checks steps 1 and 2 genuinely
 *      do not make.
 *
 * **THAT THIRD LAYER IS DELIBERATELY SMALLER THAN IT LOOKS LIKE IT SHOULD BE,
 * AND THE OMISSIONS ARE THE POINT.** An inverted grid range and a zero
 * percentage are both named in 21.5 requirement 3 as sanity bounds -- and both
 * are ALREADY refused by step 2, by the real code: `buildLevels` throws
 * `upperBound ${hi} must be above lowerBound ${lo}` and
 * `validateGridParams`/`validateDcaParams` throw on every non-positive
 * percentage. Adding a second copy here would do two bad things at once. It
 * would be the duplicated risk check requirement 3's own first bullet forbids,
 * and -- because this layer runs AFTER them -- the copy could never fire, making
 * it exactly the check-that-cannot-fail this project has already refused once
 * (decision log 37's duplicate-key "theatre", where a guard that always returns
 * clean reads as protection while providing none).
 *
 * So the inverted range and the zero percentage ARE checked, by name, with
 * tests -- and the tests assert WHICH layer refused, so the day someone deletes
 * `validateGridParams` from this chain, the suite says so instead of a silent
 * second copy absorbing it.
 *
 * ── WHAT THE THIRD LAYER GENUINELY ADDS ──
 *
 *   * **The minimum order floor.** Neither decoder nor validator knows the pair
 *     exists. Section 4.3's filters are applied at ORDER time by
 *     `validateOrder`, which is far too late to be the thing that tells a human
 *     their proposed order size cannot be sent. This is the one check in
 *     requirement 3's list that nothing upstream performs.
 *   * **The capital headroom comparison.** `validateXParams` checks the
 *     configuration against its own `allocatedCapital`; nothing checks
 *     `allocatedCapital` against the ACCOUNT. The real check for that lives
 *     inside `createBotInstanceWithCapital`'s compare-and-swap and cannot be
 *     called without performing an allocation, which 21.1 forbids here. So the
 *     SUBTRACTION is restated (see `capital.ts`) and the binding refusal is
 *     still the ledger's, at creation.
 *   * **The capital asset.** That the named asset is one the account actually
 *     holds a ledger row for.
 *
 * ── THE MINIMUM-ORDER FLOOR IS REPORTED, NOT ASSUMED ──
 *
 * Gemini publishes no notional bounds at all: `parseSymbolDetails` sets
 * `minNotional: DISABLED`. A check written only against `minNotional` would
 * therefore be a no-op on the only venue this system runs against -- passing
 * every proposal forever while reading in review like a floor. It publishes
 * `min_order_size` instead, which lands on `minQuantity`.
 *
 * So the check runs in whichever dimension the venue actually publishes, and
 * `MinimumOrderCheck` records which one held FOR THIS PROPOSAL, the same way
 * `DuplicateKeyCheck` records which guarantee held for a given response. A venue
 * that publishes neither produces `none_published`, which is an honest "nothing
 * to check" rather than a silent pass.
 */

import {
  DCA_SCHEMA_VERSION,
  DcaError,
  decodeDcaParams,
  plannedTotalSpend,
  quantityForQuote,
  validateDcaParams,
  type DcaParams,
} from "../strategies/dca";
import {
  GRID_SCHEMA_VERSION,
  GridError,
  decodeGridParams,
  quantityForLevel,
  validateGridParams,
  type GridParams,
} from "../strategies/grid";
import type { StrategyType } from "../db/schema";
import {
  TRAILING_STOP_SCHEMA_VERSION,
  decodeTrailingStopParams,
  validateTrailingStopParams,
  type TrailingStopParams,
} from "../strategies/trailing-stop";
import type { SymbolFilters } from "../shared/exchange-client";
import { ONE, ZERO, fromDecimalString, toDecimalString, type Money } from "../shared/money";
import type { EvidenceItem } from "./assess-prompt";
import {
  readModelAnswer,
  requireExactFields,
  resolveCitations,
  type AssessEnvelopeShape,
  type CitedClaim,
  type DuplicateKeyCheck,
  type ParseRefusal,
  type SharedParseCode,
} from "./assess-parse";
import { DERIVE_CAPITAL_FIELDS, type DerivePrompt } from "./derive-prompt";
import { headroomFor, type AccountCapital } from "./capital";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type DeriveParseErrorCode =
  // Shared with Assess, one implementation (see `SharedParseCode`).
  | SharedParseCode
  /**
   * The response named a different strategy than the one this prompt was built
   * for.
   *
   * A HARD REFUSAL AND NEVER A SIGNAL. Stage 2 chose from this same data and
   * Stage 3 was told the choice; a response that disagrees means the two stages
   * of one pipeline reached different conclusions about one coin, which 21.2
   * says is a bug ("a divergence between them is a bug"). Weighing it -- taking
   * the later answer, or flagging it for the human as a disagreement to
   * consider -- would turn a fault into a feature and put a strategy choice in
   * front of a human that no stage is accountable for.
   */
  | "strategy_disagreement"
  /** `parameters` is present but not an object. */
  | "parameters_not_an_object"
  /** A `{value, citations}` wrapper is not an object. */
  | "cited_value_not_an_object"
  /** A `{value, citations}` wrapper has no `value` key at all. */
  | "cited_value_missing"
  /** `notes` is present but not an array. */
  | "notes_not_an_array"
  /** `notes` is an empty array: a parameter set with no stated reasoning. */
  | "notes_empty"
  /** A note is not an object. */
  | "note_not_an_object"
  /** A note's `statement` is absent, not a string, or blank. */
  | "note_statement_invalid";

export class DeriveParseError extends Error {
  readonly code: DeriveParseErrorCode;
  readonly received: unknown;
  constructor(code: DeriveParseErrorCode, message: string, received?: unknown) {
    super(message);
    this.name = "DeriveParseError";
    this.code = code;
    this.received = received;
  }
}

/** Derive's mapping of the shared failures onto its own class. See `SharedParseCode`. */
const refuseAsDerive: ParseRefusal = (code, message, received) =>
  new DeriveParseError(code, message, received);

export type DeriveValidationErrorCode =
  /**
   * The named capital asset is not one this account holds a ledger row for.
   *
   * Distinct from "the asset has no headroom": `headroomFor` returns null for an
   * asset with no row, and an account has never been funded in an asset it has
   * no row for. Telling a human "you have 0 XYZ spare" about an asset that does
   * not exist on their account would be a fabricated fact.
   */
  | "capital_asset_unknown"
  /** The proposed allocation is zero or negative. */
  | "allocated_capital_not_positive"
  /** The proposed allocation exceeds the account's real available headroom. */
  | "allocated_capital_exceeds_headroom"
  /** An order this configuration would place is below the venue's real floor. */
  | "order_size_below_minimum";

/**
 * A validation refusal, carrying which LAYER refused.
 *
 * `layer` exists so a test -- and a human reading a refusal -- can tell "the
 * real decoder rejected this" from "the real strategy validator rejected this"
 * from "this stage's own extra bound rejected this". Without it, a future edit
 * that dropped `validateGridParams` from the chain and let a duplicated local
 * check absorb the same cases would be invisible: the same inputs would still be
 * refused, by different code, and every test asserting only "it refuses" would
 * still pass.
 *
 * `cause` is the real error the real code threw -- a `GridError` with its own
 * `invalid_parameter` code, a `DcaError` with its own -- kept whole rather than
 * re-described, exactly as `gather.ts` keeps a producing module's own error.
 */
export class DeriveValidationError extends Error {
  readonly layer: "decoder" | "strategy_validator" | "sanity_bound";
  readonly code: DeriveValidationErrorCode | "decoder_rejected" | "validator_rejected";
  constructor(
    layer: "decoder" | "strategy_validator" | "sanity_bound",
    code: DeriveValidationErrorCode | "decoder_rejected" | "validator_rejected",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "DeriveValidationError";
    this.layer = layer;
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// The parsed shape
// ---------------------------------------------------------------------------

/**
 * One proposed value with its evidence RESOLVED rather than referenced.
 *
 * `value` is the model's raw JSON value, UNTOUCHED: not coerced, not trimmed,
 * not parsed into a `Money`, not type-checked. That is deliberate and it is what
 * makes the decoder reuse real -- `decodeGridParams` is handed exactly what the
 * model wrote, so a `gridLines` of `"12"` (a string where a number is required)
 * is refused by the real decoder with the real message, rather than by a
 * lookalike check here that might one day be more forgiving than the real one.
 *
 * `citations` are the actual `EvidenceItem`s, so the datum sits beside the
 * number a human is being asked to approve (21.5 requirement 2).
 */
export interface CitedValue {
  readonly value: unknown;
  readonly citations: readonly [EvidenceItem, ...EvidenceItem[]];
}

/** What a structurally clean, fully-cited response resolves to. Not yet validated. */
export interface ParsedProposal {
  readonly strategy: StrategyType;
  /** Keyed by the exact field names `deriveFieldsFor(strategy)` requires. */
  readonly parameters: Readonly<Record<string, CitedValue>>;
  readonly allocatedCapital: CitedValue;
  readonly capitalAsset: CitedValue;
  readonly notes: readonly [CitedClaim, ...CitedClaim[]];
  readonly envelope: AssessEnvelopeShape;
  readonly duplicateKeyCheck: DuplicateKeyCheck;
}

/**
 * Which minimum-order floor the venue actually published, and therefore which
 * one was checked FOR THIS PROPOSAL.
 *
 * On the result rather than in a comment because it varies per venue and per
 * pair, and an audit record that cannot say which guarantees held is not an
 * audit record. See the module header for why a `minNotional`-only check would
 * be a permanent no-op on Gemini.
 */
export type MinimumOrderCheck =
  /** The venue published a notional floor and the order sizes cleared it. */
  | "notional"
  /** The venue published a quantity floor and the implied quantities cleared it. */
  | "quantity"
  /** The venue published both and both were checked. */
  | "both"
  /** The venue publishes NEITHER. Nothing was checked, and nothing pretends it was. */
  | "none_published";

/** A validated proposal: the real decoders' output, plus what a human needs to see. */
export interface ValidatedProposal {
  readonly strategy: StrategyType;
  /**
   * The real `GridParams`/`DcaParams`, as produced by the real decoder.
   *
   * A discriminated union rather than a shared supertype, so a caller cannot
   * read `upperBound` off a DCA proposal without the type system objecting.
   */
  readonly params:
    | { readonly strategy: "grid"; readonly value: GridParams }
    | { readonly strategy: "dca"; readonly value: DcaParams }
    | { readonly strategy: "trailing_stop"; readonly value: TrailingStopParams };
  readonly allocatedCapital: Money;
  readonly capitalAsset: string;
  /** The account's real headroom for that asset, as read. See `capital.ts`. */
  readonly availableAtProposal: Money;
  readonly minimumOrderCheck: MinimumOrderCheck;
  /**
   * The highest price an order of the proposed size would be placed at, which is
   * where the implied quantity is SMALLEST and the quantity floor bites hardest.
   */
  readonly referencePrice: Money;
}

// ---------------------------------------------------------------------------
// The response schemas
// ---------------------------------------------------------------------------

const CITED_VALUE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    // Deliberately UNTYPED. The per-field JSON type is stated in the prompt's
    // field contract and enforced by the real decoder; declaring it twice here
    // would be a third place for the grid/DCA field types to disagree, and
    // Cloudflare "can't guarantee that the model responds according to the
    // requested JSON Schema" anyway, so the schema is an optimisation on the
    // refusal rate and never a check.
    value: {},
    citations: { type: "array", minItems: 1, items: { type: "string" } },
  },
  required: ["value", "citations"],
} as const;

const NOTE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    statement: { type: "string", minLength: 1 },
    citations: { type: "array", minItems: 1, items: { type: "string" } },
  },
  required: ["statement", "citations"],
} as const;

/**
 * Build the JSON Schema for ONE strategy. THE CONDITIONAL SEAM, again.
 *
 * Built from `deriveFieldsFor`'s own output rather than from a hand-written
 * list, so the schema, the prompt's field contract and the parser's
 * `requireExactFields` all read the same array. A field added to
 * `GRID_DERIVE_FIELDS` appears in all three or in none.
 */
export function deriveResponseSchema(
  strategy: StrategyType,
  fields: readonly string[],
): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (const field of fields) properties[field] = CITED_VALUE_SCHEMA;

  return {
    type: "object",
    additionalProperties: false,
    properties: {
      strategy: { type: "string", enum: [strategy] },
      parameters: {
        type: "object",
        additionalProperties: false,
        properties,
        required: [...fields],
      },
      allocatedCapital: CITED_VALUE_SCHEMA,
      capitalAsset: CITED_VALUE_SCHEMA,
      notes: { type: "array", minItems: 1, items: NOTE_SCHEMA },
    },
    required: ["strategy", "parameters", ...DERIVE_CAPITAL_FIELDS, "notes"],
  };
}

// ---------------------------------------------------------------------------
// The parser
// ---------------------------------------------------------------------------

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function parseCitedValue(
  raw: unknown,
  where: string,
  evidenceById: ReadonlyMap<string, EvidenceItem>,
): CitedValue {
  if (!isPlainObject(raw)) {
    throw new DeriveParseError(
      "cited_value_not_an_object",
      `${where} must be an object of the form {"value": ..., "citations": [...]}. A bare value is refused rather than accepted uncited: 21.5 requirement 1 requires every proposed number to be traceable to a fetched datum, and a number with nowhere to trace to is exactly the one a human cannot check.`,
      raw,
    );
  }
  requireExactFields(raw, ["value", "citations"], where, refuseAsDerive);

  // `value` is read but NOT inspected. See `CitedValue`.
  if (!Object.prototype.hasOwnProperty.call(raw, "value")) {
    throw new DeriveParseError("cited_value_missing", `${where}.value is absent`, raw);
  }

  return {
    value: raw["value"],
    citations: resolveCitations(raw["citations"], where, evidenceById, refuseAsDerive),
  };
}

function parseNote(
  raw: unknown,
  position: number,
  evidenceById: ReadonlyMap<string, EvidenceItem>,
): CitedClaim {
  const where = `notes[${position}]`;
  if (!isPlainObject(raw)) {
    throw new DeriveParseError("note_not_an_object", `${where} is not an object`, raw);
  }
  requireExactFields(raw, ["statement", "citations"], where, refuseAsDerive);

  const statement = raw["statement"];
  if (typeof statement !== "string" || statement.trim() === "") {
    throw new DeriveParseError(
      "note_statement_invalid",
      `${where}.statement must be a non-blank string`,
      statement,
    );
  }

  return {
    statement,
    citations: resolveCitations(raw["citations"], where, evidenceById, refuseAsDerive),
  };
}

/**
 * Read a model's proposed parameter set, or refuse it.
 *
 * Structure and grounding only: this establishes that every required field is
 * present, that no field the contract does not define is present, that the
 * strategy matches the one the prompt was built for, and that every proposed
 * value cites an evidence id this run really emitted. It does NOT decide whether
 * the numbers are acceptable -- that is `validateProposal`, and the two are
 * separate because they fail for entirely different reasons and a caller should
 * be able to tell "the model answered the wrong shape" from "the model answered
 * the right shape with an unusable number".
 *
 * @param raw    the transport's value, exactly as it arrived.
 * @param prompt the prompt that produced it. Required, not optional: without the
 *               evidence ids there is no grounding check, and an optional
 *               parameter is how a grounding check becomes something a caller
 *               can forget.
 */
export function parseDeriveResponse(raw: unknown, prompt: DerivePrompt): ParsedProposal {
  const { answer, envelope, duplicateKeyCheck } = readModelAnswer(raw, refuseAsDerive);

  requireExactFields(
    answer,
    ["strategy", "parameters", ...DERIVE_CAPITAL_FIELDS, "notes"],
    "the response",
    refuseAsDerive,
  );

  // THE STAGE-AGREEMENT CHECK. Compared against the prompt's own strategy, which
  // came from `assessment.strategy` and nowhere else.
  const strategy = answer["strategy"];
  if (strategy !== prompt.strategy) {
    throw new DeriveParseError(
      "strategy_disagreement",
      `this proposal was requested for the strategy ${JSON.stringify(prompt.strategy)}, which an earlier stage chose from this same data, and the response named ${JSON.stringify(strategy)} instead. The whole proposal is refused: two stages of one pipeline disagreeing about one coin is a fault to surface, not a judgement to weigh (21.2), and the parameters below it were written for a strategy nobody selected.`,
      strategy,
    );
  }

  const parameters = answer["parameters"];
  if (!isPlainObject(parameters)) {
    throw new DeriveParseError(
      "parameters_not_an_object",
      `the response's "parameters" must be an object carrying exactly the ${prompt.parameterFields.length} fields this strategy requires`,
      parameters,
    );
  }

  // THE CONDITIONAL FIELD SET. `prompt.parameterFields` is the list built for
  // THIS strategy by `deriveFieldsFor`, so a grid answer is checked against
  // grid's fields and a DCA answer against DCA's, by construction rather than by
  // a second lookup that could pick differently.
  requireExactFields(parameters, prompt.parameterFields, "the response's parameters", refuseAsDerive);

  const evidenceById = new Map(prompt.evidence.map((item) => [item.id, item] as const));

  const resolved: Record<string, CitedValue> = {};
  for (const field of prompt.parameterFields) {
    resolved[field] = parseCitedValue(parameters[field], `parameters.${field}`, evidenceById);
  }

  const notes = answer["notes"];
  if (!Array.isArray(notes)) {
    throw new DeriveParseError("notes_not_an_array", "notes must be an array", notes);
  }
  if (notes.length === 0) {
    throw new DeriveParseError(
      "notes_empty",
      "notes is empty: a parameter set proposed with no stated reasoning is not reviewable, and an unreviewable proposal is the thing 21.1 exists to prevent",
      notes,
    );
  }

  return {
    strategy: prompt.strategy,
    parameters: resolved,
    allocatedCapital: parseCitedValue(answer["allocatedCapital"], "allocatedCapital", evidenceById),
    capitalAsset: parseCitedValue(answer["capitalAsset"], "capitalAsset", evidenceById),
    notes: notes.map((note, position) => parseNote(note, position, evidenceById)) as [
      CitedClaim,
      ...CitedClaim[],
    ],
    envelope,
    duplicateKeyCheck,
  };
}

// ---------------------------------------------------------------------------
// Layer 1 and 2: the real decoders and the real validators
// ---------------------------------------------------------------------------

/** The model's values, unwrapped from their citations and otherwise untouched. */
function rawParameterObject(proposal: ParsedProposal): Record<string, unknown> {
  const raw: Record<string, unknown> = {};
  for (const [field, cited] of Object.entries(proposal.parameters)) raw[field] = cited.value;
  return raw;
}

/**
 * Run the REAL decoder, with the same two literals `createBot` supplies.
 *
 * `handlers.ts` calls `decodeDcaParams({ ...rawParams, strategy: "dca",
 * schemaVersion: DCA_SCHEMA_VERSION })` and the grid arm likewise. This is that
 * call, on the model's object, with nothing else changed. In particular the grid
 * arm does NOT copy the handler's `breakoutThresholdPct: null, takeProfitAmount:
 * null` defaults: the handler applies those so a human's FRONTEND may omit two
 * optional fields, and a model that omitted them has already been refused by
 * `requireExactFields` for not filling every field (21.4: nothing left as "tune
 * this yourself"). Silently defaulting them here would be this stage inventing
 * two parameters and presenting them as derived.
 */
/**
 * The decoder's name for a refusal message, as an exhaustive switch rather than a
 * ternary -- a fourth strategy must fail to compile here rather than silently be
 * reported as DCA's decoder, which is what the ternary this replaced did.
 */
function decoderNameFor(strategy: StrategyType): string {
  switch (strategy) {
    case "grid":
      return "decodeGridParams";
    case "dca":
      return "decodeDcaParams";
    case "trailing_stop":
      return "decodeTrailingStopParams";
  }
}

function decodeWithRealDecoder(
  proposal: ParsedProposal,
): ValidatedProposal["params"] {
  const raw = rawParameterObject(proposal);
  try {
    if (proposal.strategy === "grid") {
      return {
        strategy: "grid",
        value: decodeGridParams({ ...raw, strategy: "grid", schemaVersion: GRID_SCHEMA_VERSION }),
      };
    }
    // SPEC 22.4 TOUCHPOINT 8. This used to be `if grid ... else DCA`, which
    // handed a trailing-stop proposal to `decodeDcaParams` -- a real third branch,
    // not a fallback, because "not grid" has meant "DCA" only by accident of there
    // having been two strategies.
    if (proposal.strategy === "trailing_stop") {
      return {
        strategy: "trailing_stop",
        value: decodeTrailingStopParams({
          ...raw,
          strategy: "trailing_stop",
          schemaVersion: TRAILING_STOP_SCHEMA_VERSION,
        }),
      };
    }
    return {
      strategy: "dca",
      value: decodeDcaParams({ ...raw, strategy: "dca", schemaVersion: DCA_SCHEMA_VERSION }),
    };
  } catch (cause) {
    throw new DeriveValidationError(
      "decoder",
      "decoder_rejected",
      `the proposed parameters were rejected by ${decoderNameFor(proposal.strategy)}, the same decoder POST /api/bots runs on a human's own submission: ${cause instanceof Error ? cause.message : String(cause)}. The whole proposal is refused; no field is corrected or defaulted.`,
      { cause },
    );
  }
}

/**
 * Run the REAL validator the Durable Object runs before reserving capital.
 *
 * This is where an inverted grid range, a zero or 100%+ percentage, a
 * `sellOnStopLoss: true`, a degenerate ladder and a configuration that cannot
 * fit inside its own allocation are all refused -- by `grid.ts` and `dca.ts`
 * themselves, not by a copy. See the module header for why no copy exists here.
 */
/**
 * The validator and creation-method names for a refusal message, exhaustive so a
 * fourth strategy fails to compile rather than being misreported as DCA's.
 */
function validatorNamesFor(strategy: StrategyType): { validator: string; creator: string } {
  switch (strategy) {
    case "grid":
      return { validator: "validateGridParams", creator: "createGrid" };
    case "dca":
      return { validator: "validateDcaParams", creator: "create" };
    case "trailing_stop":
      return { validator: "validateTrailingStopParams", creator: "createTrailingStop (NOT BUILT)" };
  }
}

function validateWithRealValidator(
  params: ValidatedProposal["params"],
  allocatedCapital: Money,
): void {
  try {
    if (params.strategy === "grid") validateGridParams(params.value, allocatedCapital);
    else if (params.strategy === "trailing_stop") {
      validateTrailingStopParams(params.value, allocatedCapital);
    } else validateDcaParams(params.value, allocatedCapital);
  } catch (cause) {
    const code = cause instanceof GridError || cause instanceof DcaError ? cause.code : "unknown";
    const { validator, creator } = validatorNamesFor(params.strategy);
    throw new DeriveValidationError(
      "strategy_validator",
      "validator_rejected",
      `the proposed parameters were rejected by ${validator} (${code}), the same validator BotInstance.${creator} runs before any capital is reserved: ${cause instanceof Error ? cause.message : String(cause)}. The whole proposal is refused.`,
      { cause },
    );
  }
}

// ---------------------------------------------------------------------------
// Layer 3: only what layers 1 and 2 do not check
// ---------------------------------------------------------------------------

/**
 * The highest price an order of the proposed size would be placed at.
 *
 * Chosen because the implied base quantity is `size / price`, so the HIGHEST
 * price yields the SMALLEST quantity and therefore the strictest test against a
 * quantity floor. Picking the lowest price instead would let an order that
 * cannot be placed near the top of the range pass because it clears the floor at
 * the bottom.
 *
 *   * grid -- `upperBound`. Every ladder level sits at or below it
 *     (`buildLevels`), so no grid order is ever placed higher.
 *   * dca  -- the newest close in the candle window. The base order goes in at
 *     the market price and every additional buy is below the last entry, so the
 *     most recent real price is the highest one this system has evidence for.
 *
 * **THE DCA CASE CANNOT BE EXACT AND IS NOT CLAIMED TO BE.** A real price may
 * have moved above the last close by the time an order is placed. The binding
 * protection there is `validateOrder`'s own filter check at order time (section
 * 4.3), exactly as the binding capital protection is the ledger's at creation
 * time. This check exists to stop a proposal that is obviously unplaceable from
 * reaching a human, not to guarantee one that reaches them is placeable forever.
 */
function referencePriceFor(
  params: ValidatedProposal["params"],
  latestClose: Money,
): Money {
  return params.strategy === "grid" ? params.value.upperBound : latestClose;
}

/** Every quote-denominated order size this configuration would ever place. */
function orderSizesOf(
  params: ValidatedProposal["params"],
  allocatedCapital: Money,
): readonly (readonly [string, Money])[] {
  if (params.strategy === "grid") {
    return [["orderSize", params.value.orderSize]];
  }
  // ONE ENTRY, SIZED BY THE ALLOCATION (22.2 decisions 1 and 4 -- see the
  // inference note on `validateTrailingStopParams`). Returning an empty
  // list here would be the dangerous shape: the venue-minimum check below would
  // silently pass a bot whose only order is too small for the venue to accept,
  // which is exactly the class of configuration this function exists to catch.
  if (params.strategy === "trailing_stop") {
    return [["allocatedCapital", allocatedCapital]];
  }
  const sizes: (readonly [string, Money])[] = [["baseOrderSize", params.value.baseOrderSize]];
  // Only when additional buys can actually happen. With `maxAdditionalBuys: 0`
  // the additional size is never spent, and `validateDcaParams` does not require
  // it to be positive in that case -- so requiring it to clear a venue floor
  // would refuse a configuration the real system accepts.
  if (params.value.maxAdditionalBuys > 0) {
    sizes.push(["additionalOrderSize", params.value.additionalOrderSize]);
  }
  return sizes;
}

/**
 * The checks steps 1 and 2 genuinely do not make, and no others.
 *
 * Returns which minimum-order floor was available rather than a boolean, because
 * "the order sizes cleared the floor" and "this venue publishes no floor" are
 * different facts and only one of them is a guarantee.
 */
export function checkDeriveSanityBounds(
  params: ValidatedProposal["params"],
  allocatedCapital: Money,
  capitalAsset: string,
  capital: AccountCapital,
  filters: SymbolFilters,
  latestClose: Money,
): { readonly minimumOrderCheck: MinimumOrderCheck; readonly referencePrice: Money; readonly available: Money } {
  // --- the capital asset, and the account's real headroom for it -------------
  const headroom = headroomFor(capital, capitalAsset);
  if (headroom === null) {
    throw new DeriveValidationError(
      "sanity_bound",
      "capital_asset_unknown",
      `the proposal names ${JSON.stringify(capitalAsset)} as its capital asset, and account ${JSON.stringify(capital.accountLabel)} holds no capital_ledger row for that asset. The account has rows for: ${capital.assets.length === 0 ? "(none at all)" : capital.assets.map((entry) => entry.asset).join(", ")}. An asset with no row has never been funded, so there is no headroom to propose within and no bot could be created against it.`,
    );
  }

  if (allocatedCapital <= ZERO) {
    throw new DeriveValidationError(
      "sanity_bound",
      "allocated_capital_not_positive",
      `the proposal allocates ${toDecimalString(allocatedCapital)} ${capitalAsset}, which is not a positive amount. createBotInstanceWithCapital refuses a non-positive request outright (invalid_capital_amount), so this could never become a bot.`,
    );
  }

  if (allocatedCapital > headroom.available) {
    throw new DeriveValidationError(
      "sanity_bound",
      "allocated_capital_exceeds_headroom",
      `the proposal allocates ${toDecimalString(allocatedCapital)} ${capitalAsset}, and account ${JSON.stringify(capital.accountLabel)} had ${toDecimalString(headroom.available)} available when the ledger was read (balance ${toDecimalString(headroom.totalBalance)} minus allocated ${toDecimalString(headroom.totalAllocated)}). Refused rather than trimmed to fit: a proposal is shown to a human as the model's, and silently reducing a number would present this system's arithmetic under the model's name. NOTE that clearing this check is NOT an entitlement -- the binding check is createBotInstanceWithCapital's, against the ledger as it stands at creation, and this figure may be out of date by then.`,
    );
  }

  // --- the venue's real minimum order floor ---------------------------------
  const referencePrice = referencePriceFor(params, latestClose);
  const sizes = orderSizesOf(params, allocatedCapital);

  const hasNotionalFloor = filters.minNotional > ZERO;
  const hasQuantityFloor = filters.minQuantity > ZERO;

  for (const [name, size] of sizes) {
    if (hasNotionalFloor && size < filters.minNotional) {
      throw new DeriveValidationError(
        "sanity_bound",
        "order_size_below_minimum",
        `the proposed ${name} of ${toDecimalString(size)} ${filters.quoteAsset} is below ${JSON.stringify(filters.pair)}'s minimum notional of ${toDecimalString(filters.minNotional)}. Every order this bot placed at that size would be refused by the venue, so the configuration cannot trade.`,
      );
    }
    if (hasQuantityFloor) {
      // The SAME arithmetic the order path uses, from the strategy's own module,
      // flooring exactly as it does -- so this check and the order it is about
      // cannot disagree by a rounding step.
      const quantity =
        params.strategy === "grid"
          ? quantityForLevel(size, referencePrice)
          : quantityForQuote(size, referencePrice);
      if (quantity < filters.minQuantity) {
        throw new DeriveValidationError(
          "sanity_bound",
          "order_size_below_minimum",
          `the proposed ${name} of ${toDecimalString(size)} ${filters.quoteAsset} buys ${toDecimalString(quantity)} ${filters.baseAsset} at ${toDecimalString(referencePrice)}, which is below ${JSON.stringify(filters.pair)}'s minimum order size of ${toDecimalString(filters.minQuantity)} ${filters.baseAsset}. The reference price is the highest price an order of this size would be placed at, where the quantity is smallest.`,
        );
      }
    }
  }

  const minimumOrderCheck: MinimumOrderCheck =
    hasNotionalFloor && hasQuantityFloor
      ? "both"
      : hasNotionalFloor
        ? "notional"
        : hasQuantityFloor
          ? "quantity"
          : "none_published";

  return { minimumOrderCheck, referencePrice, available: headroom.available };
}

// ---------------------------------------------------------------------------
// The whole chain
// ---------------------------------------------------------------------------

/**
 * Validate a parsed proposal, or refuse the whole thing.
 *
 * The three layers run in the real path's own order -- decode, validate,
 * then only what neither of those does -- and ANY refusal is total. There is no
 * `catch` that continues, no field-level result, no list of warnings, and no
 * partially-valid return.
 *
 * `allocatedCapital` is read through the real `fromDecimalString`, the same
 * codec the decoders use for every other money value, so a malformed amount
 * fails the same way a malformed `orderSize` does rather than through a second
 * number parser with its own opinions.
 */
export function validateProposal(
  proposal: ParsedProposal,
  capital: AccountCapital,
  filters: SymbolFilters,
  latestClose: Money,
): ValidatedProposal {
  const rawAsset = proposal.capitalAsset.value;
  if (typeof rawAsset !== "string" || rawAsset.trim() === "") {
    throw new DeriveValidationError(
      "sanity_bound",
      "capital_asset_unknown",
      `the proposal's capitalAsset is ${typeof rawAsset}, not a non-blank string naming one of the account's ledger assets`,
    );
  }

  const rawCapital = proposal.allocatedCapital.value;
  if (typeof rawCapital !== "string") {
    throw new DeriveValidationError(
      "decoder",
      "decoder_rejected",
      `the proposal's allocatedCapital is ${typeof rawCapital}, not a decimal string. Money crosses this boundary as a decimal string everywhere in this system, exactly as DcaParamsJson and GridParamsJson require.`,
    );
  }
  let allocatedCapital: Money;
  try {
    allocatedCapital = fromDecimalString(rawCapital);
  } catch (cause) {
    throw new DeriveValidationError(
      "decoder",
      "decoder_rejected",
      `the proposal's allocatedCapital ${JSON.stringify(rawCapital)} is not a readable decimal amount: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
  }

  const params = decodeWithRealDecoder(proposal);
  validateWithRealValidator(params, allocatedCapital);
  const { minimumOrderCheck, referencePrice, available } = checkDeriveSanityBounds(
    params,
    allocatedCapital,
    rawAsset,
    capital,
    filters,
    latestClose,
  );

  return {
    strategy: proposal.strategy,
    params,
    allocatedCapital,
    capitalAsset: rawAsset,
    availableAtProposal: available,
    minimumOrderCheck,
    referencePrice,
  };
}

/**
 * The planned worst-case spend, for the audit record. The strategy's own arithmetic.
 *
 * ⚠ TAKES `allocatedCapital` AS OF THE THIRD STRATEGY. A trailing stop has no
 * size parameter to compute a spend from -- its one entry is its allocation
 * (22.2 decisions 1 and 4) -- so the figure is not derivable from `params` alone.
 * Required rather than optional: a defaulted allocation would silently report a
 * worst-case spend of zero into an audit record.
 *
 * Note this branches on `dca` FIRST and grid last, which is not cosmetic: the old
 * two-arm form ended `return params.value.orderSize * ...`, so a trailing-stop
 * proposal would have fallen into GRID's arithmetic and read `gridLines`.
 */
export function plannedSpendOf(
  params: ValidatedProposal["params"],
  allocatedCapital: Money,
): Money {
  if (params.strategy === "dca") return plannedTotalSpend(params.value);
  if (params.strategy === "trailing_stop") return allocatedCapital;
  return params.value.orderSize * BigInt(params.value.gridLines - 1);
}
