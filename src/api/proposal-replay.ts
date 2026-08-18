/**
 * REBUILDING A STORED PROPOSAL INTO THE EXACT SHAPE THE LIVE ENDPOINTS RETURN.
 *
 * `GET /api/proposals/:id` answers with a historical row rendered as the very
 * object `GET /api/accounts/:label/assess` and `GET /api/accounts/:label/derive`
 * return, so that `ProposalView` renders a proposal from 2026-08-12 through the
 * same component, the same citation classification, the same staleness policy and
 * the same evidence diff as one produced thirty seconds ago. This module is that
 * rebuild, and it is a `.ts` with no framework in it for `proposalFields.ts`'s
 * reason: a decision that cannot be tested is a decision nobody is watching.
 *
 * ── ⚠ THE FIDELITY FINDING, STATED FIRST BECAUSE IT IS THE WHOLE DESIGN ──
 *
 * The brief that produced this module asked whether reconstruction is faithful,
 * and named `envelope` / `duplicateKeyCheck` as the kind of transient wire-only
 * field that might not have survived storage. **It was traced through source
 * rather than assumed, and the premise does not hold: nothing is lost.** The
 * record is a strict SUPERSET of the response, and the reason is mechanical
 * rather than lucky --
 *
 *   **THE HANDLER STORES THE VERY OBJECT IT PUT ON THE WIRE.**
 *
 * `getAccountDerive` calls `deriveProposalInputsView(result, selectedAt)` ONCE and
 * uses the result for BOTH `logDeriveProposal`'s `inputs` and the response's
 * `bundle`/`context`/`assessment`. `deriveProposalReasoningView(result, latencyMs)`
 * is `{ ...deriveResultView(result, latencyMs), promptText, response }` -- the
 * response's own `derive` object, spread, plus two fields. `getAccountAssess` does
 * the same with its two. `serialize.ts` argues that arrangement in its own words:
 * *"'what was stored differs from what the human was shown' is not a bug that can
 * be introduced here; it would take deleting a parameter."*
 *
 * So the reconstruction is not an approximation of a response; it is the response,
 * reassembled from the pieces it was split into:
 *
 * | wire field                  | where the row keeps it       |
 * | --------------------------- | ---------------------------- |
 * | `entryPoint`                | the `entry_point` COLUMN     |
 * | `proposalId`                | the `id` COLUMN              |
 * | `selectedAt`                | `inputs_json.selectedAt`     |
 * | `bundle`                    | `inputs_json.bundle`         |
 * | `context` (derive)          | `inputs_json.context`        |
 * | `assessment` (derive)       | `inputs_json.assessment`     |
 * | `derive` / `assess`         | `reasoning_json`, less the two record-only fields |
 *
 * ⚠ AND `envelope`, `duplicateKeyCheck`, `settings`, `latencyMs`, `promptChars`
 * AND `promptVersion` ARE ALL IN `reasoning_json`, because they are fields of
 * `assessResultView`/`deriveResultView` and the reasoning view SPREADS those.
 * `REPLAY_STAGE_FIELDS` below names every one of them, and a test drives a real
 * result through the real views and asserts the key sets agree -- so the claim in
 * this docblock is checked on every run rather than believed.
 *
 * ── THE TWO FIELDS THE RECORD HAS THAT THE WIRE NEVER DID, AND WHY THEY ARE CUT ──
 *
 * `promptText` (~16 KB Stage 2, ~23 KB Stage 3) and `response` (the transport's
 * answer, `text` and `raw`) are stored deliberately and are absent from both live
 * responses. They are REMOVED from the replayed stage object rather than left in,
 * because "the same shape" has to mean the same shape: an object carrying two keys
 * no live response ever carried is a different object, and a renderer that behaved
 * differently on their presence would behave differently on history than on live
 * data for a reason nobody would think to look for.
 *
 * ⚠ THEY ARE NOT DROPPED FROM THE ENDPOINT. They come back beside the replay, in
 * `recordOnly`, labelled -- because withholding them would be exactly the
 * SUMMARIZATION section 8.7 forbids, from the one endpoint that reads the record
 * they exist for, and because 21.7's open question 3 (which model, how
 * deterministic) cannot be settled without the bytes.
 *
 * ── ⚠ WHAT A HISTORICAL ROW GENUINELY CANNOT SUPPLY, AND IT IS NOT A FIELD ──
 *
 * Two real limits, stated here rather than discovered on the page:
 *
 * 1. **A `derive` row does not know its `assess` row.** `ProposalView` takes an
 *    OPTIONAL second argument, and with it renders Stage 2's own evidence table
 *    and the drift comparison between the two independent gathers. Migration
 *    0009's header records the absence of that link as a decision, not an
 *    oversight: nothing in the `/derive` request carries it, and an
 *    `assessProposalId` taken from the caller would be a client-asserted claim
 *    this system cannot verify. So a replayed derive proposal renders in the state
 *    `ProposalView` already supports and already handles -- `assess: null`, the
 *    state a reviewer who pasted only the derive response has always seen -- and
 *    not in a degraded one. It is the FULL Stage 3 proposal; what is absent is the
 *    second stage's raw evidence set, which was never on this row.
 *
 * 2. **An `assess` row is not a proposal `ProposalView` can render at all**, and
 *    that is structural rather than a storage gap. `ProposalView` is built around a
 *    `DeriveResponse`: parameters, allocated capital, a reference price, per-field
 *    citations. An assessment has none of those -- it is a strategy choice and its
 *    reasons, which is exactly why `only_a_derivation_can_be_approved` exists. Its
 *    replay is faithful and complete (this module rebuilds the real `AssessResponse`
 *    byte for byte); what cannot be reused is the RENDERER, and the endpoint says
 *    which kind of record it is returning so the page picks the right one.
 *
 * ── THE PARSE BOUNDARY IS REAL AND IS TREATED AS ONE ──
 *
 * `inputs_json` and `reasoning_json` are typed `unknown` in `schema.ts` on purpose
 * ("typing it as a hand-written interface here would mean a stored row could claim
 * a shape nothing validated"), and they arrive here through `JSON.parse`. This
 * module therefore CHECKS before it casts, and the checks follow entry 45's two
 * rules exactly: **`null` is present, `undefined` is missing**, and presence is
 * `Object.hasOwn` AND `!== undefined`, because `hasOwn` alone accepts
 * `{ bundle: undefined }` -- which is the value that would take `ProposalView`
 * straight to the blank screen entry 45 records.
 *
 * ⚠ AN UNEXPECTED EXTRA FIELD IS REPORTED, NOT REFUSED, and that asymmetry is
 * deliberate. A MISSING required field means the renderer would crash, so it
 * refuses. An EXTRA field means the row was written by a different version of
 * `serialize.ts` than is running now -- which is a normal thing to find in a table
 * with no delete path and indefinite retention (section 8.7), and refusing it would
 * make old records unreadable to protect against nothing.
 */

import type {
  assessProposalInputsView,
  assessProposalReasoningView,
  assessResultView,
  deriveProposalInputsView,
  deriveProposalReasoningView,
  deriveResultView,
} from "./serialize";
import type { ProposalRecord } from "../research";

/**
 * The wire types, taken FROM the serializer rather than restated.
 *
 * Not a convenience: it makes this module's output type BE `serialize.ts`'s output
 * type, so a field added to or removed from a view is a compile error here rather
 * than a silent divergence between what history renders and what live data does.
 * The alternative -- a hand-written interface -- is the documented MIRROR shape
 * that `staleness.ts` and `resubmission.ts` both record as a cost they were forced
 * into, and nothing forces it here.
 */
type AssessInputs = ReturnType<typeof assessProposalInputsView>;
type AssessReasoning = ReturnType<typeof assessProposalReasoningView>;
type AssessStage = ReturnType<typeof assessResultView>;
type DeriveInputs = ReturnType<typeof deriveProposalInputsView>;
type DeriveReasoning = ReturnType<typeof deriveProposalReasoningView>;
type DeriveStage = ReturnType<typeof deriveResultView>;

/** The `GET /api/accounts/:label/assess` payload, rebuilt. `getAccountAssess`'s own `ok(...)`. */
export interface ReplayedAssessResponse {
  readonly entryPoint: ProposalRecord["entryPoint"];
  readonly selectedAt: number;
  readonly proposalId: string;
  readonly bundle: AssessInputs["bundle"];
  readonly assess: AssessStage;
}

/** The `GET /api/accounts/:label/derive` payload, rebuilt. `getAccountDerive`'s own `ok(...)`. */
export interface ReplayedDeriveResponse {
  readonly entryPoint: ProposalRecord["entryPoint"];
  readonly selectedAt: number;
  readonly proposalId: string;
  readonly bundle: DeriveInputs["bundle"];
  readonly context: DeriveInputs["context"];
  readonly assessment: DeriveInputs["assessment"];
  readonly derive: DeriveStage;
}

/**
 * The two fields the RECORD carries and no live response ever did.
 *
 * Named once, here, and used both to cut them out of the stage object and to build
 * `recordOnly` -- so "what was removed" and "what is published instead" cannot
 * disagree. `serialize.ts`'s `assessProposalReasoningView` / `deriveProposalReasoningView`
 * are the only writers of these two keys.
 */
export const RECORD_ONLY_FIELDS = ["promptText", "response"] as const;

/**
 * Everything `assessResultView` and `deriveResultView` put on the wire.
 *
 * ⚠ THIS LIST IS NOT A MIRROR THAT COULD DRIFT -- it is pinned in
 * `proposal-replay.test.ts` against the key set the REAL views emit when driven
 * over a real result, in both directions. It exists as data so the fidelity claim
 * is a value a test can assert about rather than a paragraph.
 *
 * `envelope` and `duplicateKeyCheck` are in it, and that is the specific answer to
 * "does a transient wire-only field survive storage?" -- they were never wire-only.
 */
export const REPLAY_STAGE_FIELDS = {
  assess: [
    "strategy",
    "claims",
    "evidence",
    "promptVersion",
    "promptChars",
    "model",
    "settings",
    "envelope",
    "duplicateKeyCheck",
    "latencyMs",
  ],
  derive: [
    "strategy",
    "proposal",
    "notes",
    "evidence",
    "promptVersion",
    "promptChars",
    "model",
    "settings",
    "envelope",
    "duplicateKeyCheck",
    "latencyMs",
  ],
} as const satisfies Record<ProposalRecord["stage"], readonly string[]>;

/** What `inputs_json` must carry for each stage, per `*ProposalInputsView`. */
export const REPLAY_INPUT_FIELDS = {
  assess: ["selectedAt", "bundle"],
  derive: ["selectedAt", "bundle", "context", "assessment"],
} as const satisfies Record<ProposalRecord["stage"], readonly string[]>;

export type ReplayRefusalCode =
  /** `inputs_json` did not parse to an object at all. */
  | "inputs_not_an_object"
  /** `reasoning_json` did not parse to an object at all. */
  | "reasoning_not_an_object"
  /** A field the renderer reads is absent from `inputs_json`. */
  | "inputs_incomplete"
  /** A field the renderer reads is absent from `reasoning_json`. */
  | "reasoning_incomplete"
  /** `selectedAt` is stored but is not a number, so it cannot be a timestamp. */
  | "selected_at_not_a_number";

export interface ReplayRefusal {
  readonly ok: false;
  readonly code: ReplayRefusalCode;
  readonly message: string;
  /** The exact field names, so a report never says "something is missing". */
  readonly fields: readonly string[];
}

/**
 * What the record holds and the live wire never did, published rather than cut.
 *
 * `unknown` because that is genuinely what they are: `response.raw` is the
 * transport's own payload carried by identity (`serialize.ts` keeps both `text` and
 * `raw` deliberately, so the record holds what an implementation narrowed FROM as
 * well as what it narrowed TO).
 */
export interface ProposalRecordOnly {
  readonly promptText: unknown;
  readonly response: unknown;
}

/**
 * How faithful this particular replay is, as data rather than as a claim.
 *
 * Published on the endpoint so a reader is never left to infer it, and so the
 * honest answer to "is this exactly what the operator saw?" travels WITH the
 * object rather than living only in a docblock.
 */
export interface ReplayFidelity {
  /**
   * True when every field of the live wire shape was rebuilt from stored data.
   * It is `true` for every row this pipeline has ever written; it can only be
   * false for a row whose stored payload carries extra fields (see below).
   */
  readonly exact: boolean;
  /**
   * Fields present in `reasoning_json` that the CURRENT wire shape does not
   * declare -- i.e. this row was written by a different `serialize.ts`. Carried
   * through to the replay regardless; naming them is the point.
   */
  readonly unexpectedStageFields: readonly string[];
  /**
   * ⚠ ALWAYS TRUE FOR A `derive` REPLAY, and it is the one real limit. Nothing
   * links a derive row to the assess row it derives from (migration 0009), so
   * Stage 2's own evidence table and the two-gather drift comparison cannot be
   * rendered for a historical proposal. `ProposalView` already supports that
   * state; this says so out loud rather than letting a blank section imply
   * something was lost.
   */
  readonly assessResponseUnavailable: boolean;
  /**
   * ⚠ TRUE FOR AN `assess` REPLAY. The payload is complete and exact; what cannot
   * be reused is `ProposalView`, which is built around a derivation's parameters.
   */
  readonly renderableByProposalView: boolean;
}

export type ProposalReplay =
  | ({
      readonly ok: true;
      readonly stage: "assess";
      readonly response: ReplayedAssessResponse;
    } & ReplayCommon)
  | ({
      readonly ok: true;
      readonly stage: "derive";
      readonly response: ReplayedDeriveResponse;
    } & ReplayCommon)
  | ReplayRefusal;

interface ReplayCommon {
  readonly recordOnly: ProposalRecordOnly;
  readonly fidelity: ReplayFidelity;
}

// ---------------------------------------------------------------------------
// The checks. Entry 45's rules, applied to a different untrusted payload.
// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  // Arrays excluded explicitly: `Object.hasOwn([], "0")` is true, so an array of
  // the right length would satisfy a naive presence check. Entry 45's mutant C4
  // is the same fault one module over.
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The field names that are MISSING from `object`.
 *
 * ⚠ `null` IS PRESENT; `undefined` IS MISSING. Both halves of the test are
 * load-bearing and neither is redundant, which entry 45 established by mutation:
 * `hasOwn` alone accepts `{ bundle: undefined }` -- the exact value that reaches
 * `formatMoney` and takes the page black -- and `!== undefined` alone would accept
 * a value inherited from a prototype. The views emit `null` for a real absence
 * (`takeProfitAmount`, `breakoutThresholdPct`, `missingHistoryMs`) and never omit
 * the key, so a rule accepting "absent or null" would let a truncated payload
 * through.
 */
function missingFields(
  object: Record<string, unknown>,
  required: readonly string[],
): readonly string[] {
  return required.filter((field) => !Object.hasOwn(object, field) || object[field] === undefined);
}

/** Keys present that the current wire shape does not declare. Reported, never refused. */
function extraFields(
  object: Record<string, unknown>,
  declared: readonly string[],
): readonly string[] {
  const known = new Set<string>(declared);
  return Object.keys(object).filter((key) => !known.has(key));
}

/**
 * Split `reasoning_json` into the stage object the wire carried and the two fields
 * only the record has.
 *
 * The rest-spread is the mechanism and it matters: an extra field a future
 * `serialize.ts` adds travels into the stage object automatically, which is right
 * -- the stage object is defined as "whatever the response carried", and this row
 * IS a copy of that response. What is removed is exactly `RECORD_ONLY_FIELDS` and
 * nothing else.
 */
function splitReasoning(reasoning: Record<string, unknown>): {
  readonly stage: Record<string, unknown>;
  readonly recordOnly: ProposalRecordOnly;
} {
  const { promptText, response, ...stage } = reasoning;
  return { stage, recordOnly: { promptText, response } };
}

function refuse(
  code: ReplayRefusalCode,
  message: string,
  fields: readonly string[] = [],
): ReplayRefusal {
  return { ok: false, code, message, fields };
}

/**
 * Rebuild one stored proposal into the response the live endpoint returned.
 *
 * ⚠ IT READS ONLY THE RECORD. No clock, no database, no network, no policy: a
 * replay of a row must not depend on anything that has changed since the row was
 * written, or the two renderings diverge for reasons that are not in the record.
 * The staleness verdict on the rendered page is recomputed at RENDER time from the
 * stored fetch timestamps, exactly as decision log 48 PART 3 requires and by the
 * same code -- which is why a proposal from last week correctly reads `stale` on a
 * page this module knows nothing about.
 */
export function replayProposal(record: ProposalRecord): ProposalReplay {
  const inputs: unknown = record.inputs;
  const reasoning: unknown = record.reasoning;

  if (!isPlainObject(inputs)) {
    return refuse(
      "inputs_not_an_object",
      `proposal ${JSON.stringify(record.id)} stored inputs_json as ${
        Array.isArray(inputs) ? "an array" : typeof inputs
      }, not an object. Every row this pipeline writes stores the assess/derive ` +
        `handler's own inputs view, which is always an object.`,
    );
  }
  if (!isPlainObject(reasoning)) {
    return refuse(
      "reasoning_not_an_object",
      `proposal ${JSON.stringify(record.id)} stored reasoning_json as ${
        Array.isArray(reasoning) ? "an array" : typeof reasoning
      }, not an object.`,
    );
  }

  const stageName = record.stage;
  const missingInputs = missingFields(inputs, REPLAY_INPUT_FIELDS[stageName]);
  if (missingInputs.length > 0) {
    return refuse(
      "inputs_incomplete",
      `proposal ${JSON.stringify(record.id)} is a ${stageName} record whose inputs_json is ` +
        `missing ${missingInputs.join(", ")}. The proposal cannot be rebuilt into the shape the ` +
        `live endpoint returned, and rendering it part-built is how a truncated document comes to ` +
        `look like a half-specified proposal.`,
      missingInputs,
    );
  }

  const { stage, recordOnly } = splitReasoning(reasoning);
  const missingStage = missingFields(stage, REPLAY_STAGE_FIELDS[stageName]);
  if (missingStage.length > 0) {
    return refuse(
      "reasoning_incomplete",
      `proposal ${JSON.stringify(record.id)} is a ${stageName} record whose reasoning_json is ` +
        `missing ${missingStage.join(", ")}.`,
      missingStage,
    );
  }

  const selectedAt: unknown = inputs.selectedAt;
  if (typeof selectedAt !== "number") {
    return refuse(
      "selected_at_not_a_number",
      `proposal ${JSON.stringify(record.id)} stored selectedAt as ${typeof selectedAt}. It is ` +
        `epoch milliseconds on the wire, and a renderer that formatted a string as a date would ` +
        `print something that looks like a time and is not one.`,
      ["selectedAt"],
    );
  }

  const unexpectedStageFields = extraFields(stage, REPLAY_STAGE_FIELDS[stageName]);

  if (stageName === "assess") {
    return {
      ok: true,
      stage: "assess",
      response: {
        // Off the COLUMN, not off the payload. `getAccountAssess` writes the literal
        // `"named"` into its response and the real entry point into the row, and the
        // row is the one that stays true if a second door is ever opened.
        entryPoint: record.entryPoint,
        selectedAt,
        // Off the COLUMN as well: the id IS the row's identity, and taking it from
        // a payload would let a copied inputs blob claim another proposal's id.
        proposalId: record.id,
        bundle: inputs.bundle as ReplayedAssessResponse["bundle"],
        assess: stage as unknown as AssessStage,
      },
      recordOnly,
      fidelity: {
        exact: unexpectedStageFields.length === 0,
        unexpectedStageFields,
        assessResponseUnavailable: false,
        renderableByProposalView: false,
      },
    };
  }

  return {
    ok: true,
    stage: "derive",
    response: {
      entryPoint: record.entryPoint,
      selectedAt,
      proposalId: record.id,
      bundle: inputs.bundle as ReplayedDeriveResponse["bundle"],
      context: inputs.context as ReplayedDeriveResponse["context"],
      assessment: inputs.assessment as ReplayedDeriveResponse["assessment"],
      derive: stage as unknown as DeriveStage,
    },
    recordOnly,
    fidelity: {
      exact: unexpectedStageFields.length === 0,
      unexpectedStageFields,
      // ⚠ ALWAYS. Migration 0009: nothing links a derive row to its assess row.
      assessResponseUnavailable: true,
      renderableByProposalView: true,
    },
  };
}

/** Type-level acknowledgement that the reasoning views really are the stage views plus two fields. */
type _AssessReasoningIsStagePlusRecordOnly = AssessReasoning extends AssessStage ? true : never;
type _DeriveReasoningIsStagePlusRecordOnly = DeriveReasoning extends DeriveStage ? true : never;
const _assessReasoningExtends: _AssessReasoningIsStagePlusRecordOnly = true;
const _deriveReasoningExtends: _DeriveReasoningIsStagePlusRecordOnly = true;
void _assessReasoningExtends;
void _deriveReasoningExtends;
