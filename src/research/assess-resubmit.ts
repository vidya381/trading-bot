/**
 * 21.4 Stage 2's result, arriving from OUTSIDE this system, and re-verified
 * against evidence gathered NOW.
 *
 * NOTHING HERE CALLS A MODEL, READS A DATABASE OR REACHES A VENUE. One pure
 * function from a string plus a freshly-gathered bundle, to either a
 * `ParsedAssessment` or a thrown `AssessResubmitError`. There is no third
 * outcome, no default, no partial acceptance.
 *
 * ── WHY THIS MODULE EXISTS AT ALL ──
 *
 * `deriveParameters` takes a `ParsedAssessment`. Until now the only way to get
 * one was `parseAssessResponse`, which builds it from a model's live answer
 * against the prompt that produced that answer IN THE SAME CALL. Both existing
 * callers work that way: `/api/accounts/:label/assess` returns one and forgets
 * it, and the deleted Stage 3 probe made a fresh Assess call and fed the result
 * straight into Derive without the value ever leaving the process.
 *
 * `GET /api/accounts/:label/derive` is the first caller where **the assessment
 * comes from an earlier, separate HTTP request**. The client held it, real time
 * passed, and it is now handed back as untrusted text. Two things are therefore
 * true that were never true before, and this module exists for the second:
 *
 *   1. The value is UNTRUSTED INPUT. It arrives as JSON a caller wrote, not as a
 *      typed object a parser produced, so it needs the same fail-closed reading
 *      any model response gets.
 *   2. **The evidence it cites may no longer exist.** Between the original
 *      `/assess` call and this one the venue answered again, the ledger moved,
 *      bots were created. `/derive` gathers its OWN bundle, and the citable id
 *      set that bundle produces is NOT guaranteed to be the one the original
 *      Assess prompt emitted.
 *
 * ── WHAT ACTUALLY DRIFTS, AND WHY THE CHECK IS NOT DECORATIVE ──
 *
 * Most evidence ids are stable strings (`candles.last_close`, `candles.high`,
 * `concentration.status`), so the naive reading is "the id set never changes and
 * this check can never fire". THAT READING IS WRONG, and the ways it is wrong
 * are ordinary rather than exotic. Reading `collectBundleEvidence`:
 *
 *   * `candles.bucket.NN` exists for `min(CANDLE_BUCKET_COUNT, n)` buckets,
 *     where `n` is how many candles the venue actually returned. A window that
 *     was 1,440 candles deep at `/assess` time and 12 deep now emits
 *     `candles.bucket.01`..`candles.bucket.12` and NOT `candles.bucket.19` --
 *     which the earlier claim may well have cited, because a bucket is exactly
 *     the kind of thing a claim about a price range rests on.
 *   * A candle fetch that succeeded then and fails now collapses NINETEEN ids
 *     (`candles.interval`, `candles.high`, `candles.range_pct`, every bucket)
 *     down to ONE: `candles.status`, carrying MISSING. Every price citation in
 *     the resubmitted assessment then names an id this run cannot emit.
 *   * `concentration.flag.N` exists only while the account is FLAGGED. Stopping
 *     one bot between the two calls removes the flag and its ids.
 *   * `candidate.source.N` follows how many sources the candidate has, which a
 *     watchlist edit changes.
 *
 * So the refusal is reachable through normal operation, and what it prevents is
 * specific: Stage 3's prompt renders each resubmitted claim into its DATA
 * section as citable evidence (`collectAssessment`), stating the ids that claim
 * rested on. Without this check, a claim resting on a 1,440-candle window would
 * be presented to the model -- and then to a human -- as reasoning about data
 * this run does not have, with ids naming values nothing here can show. That is
 * 21.5 requirement 2's failure exactly: the human is shown reasoning they cannot
 * check against the data beside it.
 *
 * ── THE GROUNDING CHECK IS NOT REIMPLEMENTED. THIS IS THE POINT. ──
 *
 * `resolveCitations` (assess-parse.ts) is THE grounding mechanism and there is
 * exactly one copy of it. It was already written as a set-membership test over
 * an INJECTED `ReadonlyMap`, with no opinion about where that map came from --
 * so verifying against an evidence set the caller has never seen before needs no
 * new logic, only a new call site handing it a different map. This module is
 * that call site and nothing more. A second "does this id exist" implementation
 * here would be the duplicated risk check 21.5 requirement 3 forbids, and the
 * copy that drifts is the one nobody is watching.
 *
 * The same reuse holds for `requireExactFields` (exact field sets, both
 * directions) and `findDuplicateKey` (the same-key-twice scan). Only the
 * VOCABULARY is new: `AssessResubmitError` maps the shared codes onto this
 * module's own class, exactly as `refuseAsAssess` and `refuseAsDerive` do, so a
 * caller can tell "the CLIENT's resubmission was bad" from "the MODEL's answer
 * was bad" -- two failures with very different owners that would otherwise share
 * a code and a class.
 *
 * ── THE EVIDENCE SET IS THE BUNDLE'S, NOT DERIVE'S ──
 *
 * The map is built from `collectBundleEvidence` over the fresh bundle -- which
 * is precisely and only what `buildAssessPrompt` emits -- rather than from
 * `buildDerivePrompt`'s wider set. Two reasons, and the second is the load-
 * bearing one:
 *
 *   1. An Assess claim could never legitimately have cited `capital.row.01.asset`
 *      or `filters.min_quantity`: those ids do not exist in Stage 2's prompt.
 *      Accepting them would be accepting a claim that could not have come from
 *      the stage this value claims to come from.
 *   2. **Derive's evidence set CONTAINS `assessment.claim.N`, built FROM the
 *      assessment being verified.** Checking the assessment against a set
 *      derived from itself is circular, and it would pass by construction --
 *      the check-that-cannot-fail this project has already refused once
 *      (decision log 37's duplicate-key "theatre").
 *
 * ── THE DUPLICATE-KEY SCAN GENUINELY RUNS HERE ──
 *
 * Unlike the model paths, where the transport parses the bytes before this
 * system sees them and `duplicateKeyCheck` has to report
 * `unavailable_transport_parsed`, THIS module holds the caller's own bytes. So
 * `findDuplicateKey` really runs, and `{"strategy":"dca","strategy":"grid"}` --
 * which `JSON.parse` would silently resolve to `grid` -- is refused rather than
 * quietly becoming a strategy nobody submitted.
 *
 * ── WHAT IS *NOT* VERIFIED, STATED PLAINLY ──
 *
 * `envelope` and `duplicateKeyCheck` are the ORIGINAL call's audit facts, and
 * this system did not witness that call and stores nothing about it. They are
 * checked against their literal unions and otherwise **taken on the client's
 * word**. They are carried so the audit trail is not silently invented -- see
 * `RESUBMITTED_ASSESSMENT_FIELDS` -- and any caller publishing them must label
 * them as client-asserted. Manufacturing a plausible value instead would be this
 * module fabricating an audit fact, which is worse than reporting an unverified
 * one.
 *
 * NOR IS THE STATEMENT TEXT VERIFIED. A claim's prose is whatever the client
 * sent; nothing here can know the original model wrote it. What IS guaranteed is
 * exactly what `resolveCitations` guarantees anywhere else, and it is narrower
 * than it looks and still the thing that matters: every claim arrives attached
 * to a real evidence id THIS RUN really emitted, so the human reads the sentence
 * beside data that actually exists right now.
 */

import { ASSESS_STRATEGIES, EvidenceCollector, collectBundleEvidence, type EvidenceItem } from "./assess-prompt";
import {
  findDuplicateKey,
  requireExactFields,
  resolveCitations,
  type AssessEnvelopeShape,
  type CitedClaim,
  type DuplicateKeyCheck,
  type ParseRefusal,
  type ParsedAssessment,
  type SharedParseCode,
} from "./assess-parse";
import type { StrategyType } from "../db/schema";
import type { CandidateGatherBundle } from "./gather";

// ---------------------------------------------------------------------------
// The contract
// ---------------------------------------------------------------------------

/**
 * The exact four fields a resubmitted Stage 2 result must carry, and no others.
 *
 * These are the four fields of `ParsedAssessment`, deliberately: the value being
 * resubmitted IS a `ParsedAssessment`, and a contract that accepted a subset
 * would mean this module inventing whatever it left out.
 *
 * `envelope` and `duplicateKeyCheck` are required rather than optional-with-a-
 * default for that reason. They are unverifiable here (see the module header),
 * but 21.5 requirement 5 wants a proposal traceable to its exact cause, and
 * "which transport shape the upstream answer arrived in" is one of those causes.
 * Defaulting them would put a value this system made up into an audit record
 * under a field name that reads as an observation.
 */
export const RESUBMITTED_ASSESSMENT_FIELDS: readonly string[] = Object.freeze([
  "strategy",
  "claims",
  "envelope",
  "duplicateKeyCheck",
]);

/** The four shapes `AssessEnvelopeShape` declares, as a runtime whitelist. */
const ENVELOPE_SHAPES: readonly AssessEnvelopeShape[] = Object.freeze([
  "bare_string",
  "envelope_string",
  "envelope_object",
  "bare_object",
]);

/** The two states `DuplicateKeyCheck` declares, as a runtime whitelist. */
const DUPLICATE_KEY_CHECKS: readonly DuplicateKeyCheck[] = Object.freeze([
  "performed",
  "unavailable_transport_parsed",
]);

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type AssessResubmitErrorCode =
  /** Empty, or nothing but whitespace. */
  | "empty_resubmission"
  /** `JSON.parse` refused it. No attempt is made to find JSON inside prose. */
  | "not_json"
  /** Valid JSON, but not a single object. */
  | "not_an_object"
  /** The same key twice in one object. The scan really runs here -- see the header. */
  | "duplicate_key"
  /** A required field is absent. */
  | "missing_field"
  /** A field the contract does not define is present. */
  | "unexpected_field"
  /** `strategy` is present but not a string. */
  | "strategy_not_a_string"
  /** `strategy` is a string but not exactly "dca" or "grid". */
  | "strategy_not_recognised"
  /** `claims` is present but not an array. */
  | "claims_not_an_array"
  /** `claims` is an empty array: a choice resubmitted with no stated reason. */
  | "claims_empty"
  /** An element of `claims` is not an object. */
  | "claim_not_an_object"
  /** A claim's `statement` is absent, not a string, or blank. */
  | "claim_statement_invalid"
  /** A claim's `citations` is absent, not an array, or empty. */
  | "claim_citations_invalid"
  /** A citation is not a string. See `parseResubmittedAssessment` on why ids, not objects. */
  | "citation_not_a_string"
  /**
   * THE RE-VERIFICATION REFUSAL, and the reason this module exists.
   *
   * A citation names an evidence id THIS RUN's freshly-gathered bundle does not
   * emit. It may have been real at the time of the original `/assess` call and
   * it is not real now, or it may never have been real at all -- this module
   * cannot and does not distinguish those, because the guarantee it offers is
   * about the CURRENT evidence set and nothing else.
   */
  | "citation_unknown"
  /** `envelope` is not one of the four `AssessEnvelopeShape` literals. */
  | "envelope_not_recognised"
  /** `duplicateKeyCheck` is not one of the two `DuplicateKeyCheck` literals. */
  | "duplicate_key_check_not_recognised";

/**
 * A refusal of a CLIENT's resubmission.
 *
 * Its own class rather than an `AssessParseError`, and that separation is
 * load-bearing rather than tidy: `AssessParseError` means A MODEL answered
 * badly and the correct response is a 502, while this means A CALLER sent
 * something bad or stale and the correct response is a 4xx. Sharing a class
 * would make a handler unable to tell the two apart, and the wrong one would end
 * up blaming the vendor for the caller's input.
 */
export class AssessResubmitError extends Error {
  readonly code: AssessResubmitErrorCode;
  readonly received: unknown;
  constructor(code: AssessResubmitErrorCode, message: string, received?: unknown) {
    super(message);
    this.name = "AssessResubmitError";
    this.code = code;
    this.received = received;
  }
}

/**
 * This module's mapping of the shared failures onto its own class.
 *
 * The one rename is Assess's: `citations_invalid` becomes
 * `claim_citations_invalid`, because here a citation list only ever hangs off a
 * claim. Every other shared code keeps its name, so a reader comparing a
 * resubmission refusal with an Assess refusal sees the same vocabulary.
 *
 * The shared codes that are unreachable from this module (`fenced_response`,
 * `async_batch_envelope`, the two envelope codes, `empty_response`) are still
 * accepted by the type because `ParseRefusal` is one signature for every stage.
 * They are mapped rather than thrown on: an unreachable branch that throws a
 * different kind of error would be a worse failure than one that reports
 * honestly, and `SharedParseCode` gaining a member should not silently compile
 * into a wrong code here.
 */
const refuseAsResubmission: ParseRefusal = (code, message, received) =>
  new AssessResubmitError(sharedCodeToOwn(code), message, received);

function sharedCodeToOwn(code: SharedParseCode): AssessResubmitErrorCode {
  switch (code) {
    case "citations_invalid":
      return "claim_citations_invalid";
    case "not_json":
    case "not_an_object":
    case "duplicate_key":
    case "missing_field":
    case "unexpected_field":
    case "citation_not_a_string":
    case "citation_unknown":
      return code;
    // Transport-shaped failures. A resubmission has no Workers AI envelope
    // around it, so none of these is reachable; each is reported as what it
    // literally is rather than folded into a code that would mislead.
    case "empty_response":
      return "empty_resubmission";
    case "envelope_unrecognised":
    case "envelope_response_unusable":
    case "async_batch_envelope":
    case "fenced_response":
      return "not_json";
  }
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// ---------------------------------------------------------------------------
// The fresh evidence set
// ---------------------------------------------------------------------------

/**
 * Every id a freshly-gathered bundle can be cited for, RIGHT NOW.
 *
 * Exactly `buildAssessPrompt`'s evidence set, produced by the same
 * `collectBundleEvidence` call, because that is the set an Assess claim is
 * permitted to cite. See the module header for why Derive's wider set would be
 * both too permissive and circular.
 *
 * Exported so a test can assert what drifted between two bundles rather than
 * inferring it from a refusal.
 */
export function assessEvidenceOf(bundle: CandidateGatherBundle): readonly EvidenceItem[] {
  const collector = new EvidenceCollector();
  collectBundleEvidence(collector, bundle);
  return collector.all();
}

// ---------------------------------------------------------------------------
// The parser
// ---------------------------------------------------------------------------

function parseResubmittedClaim(
  raw: unknown,
  position: number,
  evidenceById: ReadonlyMap<string, EvidenceItem>,
): CitedClaim {
  const where = `claims[${position}]`;
  if (!isPlainObject(raw)) {
    throw new AssessResubmitError("claim_not_an_object", `${where} is not an object`, raw);
  }
  requireExactFields(raw, ["statement", "citations"], where, refuseAsResubmission);

  const statement = raw["statement"];
  if (typeof statement !== "string" || statement.trim() === "") {
    throw new AssessResubmitError(
      "claim_statement_invalid",
      `${where}.statement must be a non-blank string`,
      statement,
    );
  }

  // THE RE-VERIFICATION. One call, to the one implementation, against the ids
  // this run really emits.
  return {
    statement,
    citations: resolveCitations(raw["citations"], where, evidenceById, refuseAsResubmission),
  };
}

/**
 * Read a client's resubmitted Stage 2 result against evidence gathered NOW, or
 * refuse it.
 *
 * @param text   the resubmission, as the exact bytes the caller sent. A STRING
 *               rather than a parsed object on purpose: the duplicate-key scan
 *               can only run on source text (see `findDuplicateKey`), and a
 *               caller that parsed first would silently destroy the one
 *               contradiction this module is in a position to catch.
 * @param bundle the bundle THIS run just gathered. Required, not optional:
 *               without it there is no evidence set, and an optional parameter
 *               is how a grounding check becomes something a caller can forget.
 *
 * ── CITATIONS ARE BARE IDS, NOT THE OBJECTS `/assess` RETURNED ──
 *
 * `/api/accounts/:label/assess` publishes each citation as a whole
 * `EvidenceItem` -- `{id, label, value, source}` -- so a human reads the datum
 * beside the sentence. A resubmission sends the `id` STRINGS only, and an object
 * here is refused with `citation_not_a_string` rather than having its `id`
 * helpfully extracted.
 *
 * That is deliberate and it is the module's own logic applied to its own input.
 * The `label`, `value` and `source` in a resubmitted item are a rendering of
 * data as it stood at the ORIGINAL call, and every one of them may now be stale
 * -- `candles.last_close` is a different number than it was. This stage resolves
 * the id against the CURRENT evidence and uses the CURRENT rendering, so the
 * submitted rendering is something it must ignore entirely. Accepting a field
 * and ignoring it is how a caller concludes their data was used, which is the
 * same objection `getAccountGather` raises against silently dropping a `pair`
 * on a watchlist run. Requiring ids makes "your values are not used" visible in
 * the contract rather than buried in a comment.
 *
 * @throws AssessResubmitError on anything that is not exactly one clean,
 *         currently-grounded assessment. Never returns a default.
 */
export function parseResubmittedAssessment(
  text: string,
  bundle: CandidateGatherBundle,
): ParsedAssessment {
  const trimmed = text.trim();
  if (trimmed === "") {
    throw new AssessResubmitError(
      "empty_resubmission",
      "the resubmitted assessment is empty. It must be the JSON object a previous " +
        "GET /api/accounts/:label/assess returned, carrying its exact strategy and its exact claims.",
      text,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    throw new AssessResubmitError(
      "not_json",
      `the resubmitted assessment is not valid JSON (${error instanceof Error ? error.message : String(error)}). No attempt is made to locate JSON inside surrounding text.`,
      text,
    );
  }

  // On the CALLER's own bytes, so this genuinely runs -- unlike either model
  // path, where the transport had already parsed them. See the module header.
  const duplicate = findDuplicateKey(trimmed);
  if (duplicate !== null) {
    throw new AssessResubmitError(
      "duplicate_key",
      `the resubmitted assessment repeats the key ${JSON.stringify(duplicate)} in one object. JSON.parse keeps the last value silently, so a self-contradictory resubmission would otherwise look clean -- and for "strategy" that means deriving parameters for a strategy the caller did not unambiguously ask for.`,
      duplicate,
    );
  }

  if (!isPlainObject(parsed)) {
    throw new AssessResubmitError(
      "not_an_object",
      `the resubmitted assessment is valid JSON but not a single object (received ${Array.isArray(parsed) ? "an array" : parsed === null ? "null" : typeof parsed})`,
      parsed,
    );
  }

  requireExactFields(
    parsed,
    RESUBMITTED_ASSESSMENT_FIELDS,
    "the resubmitted assessment",
    refuseAsResubmission,
  );

  const strategy = parsed["strategy"];
  if (typeof strategy !== "string") {
    throw new AssessResubmitError("strategy_not_a_string", "strategy must be a string", strategy);
  }
  if (!(ASSESS_STRATEGIES as readonly string[]).includes(strategy)) {
    throw new AssessResubmitError(
      "strategy_not_recognised",
      `strategy must be exactly one of ${ASSESS_STRATEGIES.map((s) => JSON.stringify(s)).join(" or ")}; received ${JSON.stringify(strategy)}. No trimming, case folding or nearest-match is performed: these are the only two strategies this system implements, they are the two branches the conditional prompt and the conditional schema are built from, and a third value has no prompt to be built for it.`,
      strategy,
    );
  }

  const claims = parsed["claims"];
  if (!Array.isArray(claims)) {
    throw new AssessResubmitError("claims_not_an_array", "claims must be an array", claims);
  }
  if (claims.length === 0) {
    throw new AssessResubmitError(
      "claims_empty",
      "claims is empty: a strategy resubmitted with no stated reason is not reviewable, and Stage 3's prompt would carry a decision with nothing behind it into the parameters a human is asked to approve",
      claims,
    );
  }

  // THE FRESH SET. Built here, from this run's bundle, and never from the
  // submission -- see the module header on why Derive's wider set is circular.
  const evidenceById = new Map(assessEvidenceOf(bundle).map((item) => [item.id, item] as const));
  const parsedClaims = claims.map((claim, position) =>
    parseResubmittedClaim(claim, position, evidenceById),
  );

  const envelope = parsed["envelope"];
  if (!(ENVELOPE_SHAPES as readonly unknown[]).includes(envelope)) {
    throw new AssessResubmitError(
      "envelope_not_recognised",
      `envelope must be exactly one of ${ENVELOPE_SHAPES.map((s) => JSON.stringify(s)).join(", ")}; received ${JSON.stringify(envelope)}. This field is the ORIGINAL call's audit fact and this system cannot verify it -- it is checked against the union and otherwise taken on the caller's word, rather than defaulted, because a manufactured audit fact is worse than an unverified one.`,
      envelope,
    );
  }

  const duplicateKeyCheck = parsed["duplicateKeyCheck"];
  if (!(DUPLICATE_KEY_CHECKS as readonly unknown[]).includes(duplicateKeyCheck)) {
    throw new AssessResubmitError(
      "duplicate_key_check_not_recognised",
      `duplicateKeyCheck must be exactly one of ${DUPLICATE_KEY_CHECKS.map((s) => JSON.stringify(s)).join(" or ")}; received ${JSON.stringify(duplicateKeyCheck)}. As with "envelope", this describes the original call and is taken on the caller's word.`,
      duplicateKeyCheck,
    );
  }

  return {
    strategy: strategy as StrategyType,
    claims: parsedClaims as [CitedClaim, ...CitedClaim[]],
    envelope: envelope as AssessEnvelopeShape,
    duplicateKeyCheck: duplicateKeyCheck as DuplicateKeyCheck,
  };
}
