/**
 * 21.4 Stage 2 (Assess), second half: the STRICT, FAIL-CLOSED reader of a
 * model's raw response.
 *
 * NOTHING HERE CALLS A MODEL. This is a pure function from a string plus the
 * `AssessPrompt` that produced it, to either a fully-resolved assessment or a
 * thrown `AssessParseError`. There is no third outcome. There is no default,
 * no fallback strategy, no "best guess", no confidence score, and no partially
 * accepted response.
 *
 * ── Why the strictness is absolute rather than pragmatic ──
 *
 * The output of this stage decides which of two strategies a human is shown as
 * "the one the data supports", and a human reviewing a proposal is reviewing
 * the REASONING, not re-deriving the choice. So the failure that costs money is
 * not a rejected response -- that costs a retry -- it is an accepted response
 * that did not really say what this module decided it said.
 *
 * Every lenient convenience is therefore refused ON PURPOSE, and each refusal
 * is the kind that looks harmless in review:
 *
 *   * "DCA" is NOT accepted as "dca", and no case folding is performed. The
 *     prompt states the exact bytes required; a model that cannot emit two
 *     lowercase letters as instructed has not demonstrated it followed the
 *     instructions, and the value of case folding (one fewer retry) is smaller
 *     than the value of knowing that.
 *   * A markdown code fence is NOT stripped. Unwrapping ```json is the single
 *     most tempting "close enough" fix in this file, and every unwrap rule is a
 *     rule about text the model was told not to produce.
 *   * Prose around the JSON is NOT located and extracted. There is no
 *     first-`{`-to-last-`}` scan, because that scan is exactly how a hedged
 *     answer ("I'd lean DCA, though grid could work: {...}") becomes a clean
 *     one.
 *   * An unexpected field is NOT ignored. A response carrying "confidence" or
 *     "alternative" is a response to a different question than the one asked.
 *   * A claim with no citation is NOT kept as prose. 21.5 requirements 1 and 2
 *     exist so a human can check reasoning against real data; an uncited
 *     sentence is the exact thing they forbid, and keeping it "for context"
 *     would put ungrounded prose in front of the human under the same heading
 *     as grounded prose.
 *   * A citation naming an id the prompt did not emit is FATAL for the whole
 *     response, not skipped. An invented id is direct evidence that the model
 *     produced text not derived from the DATA section, which is requirement 1's
 *     failure. One such citation makes the whole answer untrustworthy, so the
 *     whole answer is refused.
 *
 * ── A REFUSAL IS NOT AN ERROR TO ROUTE AROUND ──
 *
 * Nothing in this repository retries a refused response, and `assess.ts` argues
 * that at length. Stated here too because THIS is the file where the temptation
 * appears: a caller staring at an `AssessParseError` will reach for a retry, and
 * "retry until it parses" is fail-closed converted into fail-open -- the
 * accepted answer becomes the one selected for passing the validator rather than
 * the one the model actually gave, with the disagreeing samples discarded
 * silently.
 *
 * ── What this module deliberately does NOT check ──
 *
 * IT DOES NOT DETECT HEDGING BY VOCABULARY. There is no list of words like
 * "maybe", "possibly" or "it depends", because a word list fails in both
 * directions at once: a hedge phrased around the list passes (fail-open, and
 * silently), while a legitimate claim that a window is thin -- which the prompt
 * REQUIRES the model to state -- would trip it (fail-closed, unpredictably).
 * The hedge that actually matters is a hedged CHOICE, and that is caught
 * exactly and without heuristics by the strategy field being an exact match
 * against two literals: "dca or grid", "either", "dca (but see below)" and
 * ["dca","grid"] are all rejected by construction.
 *
 * IT DOES NOT CHECK THAT A CLAIM'S PROSE IS TRUE OF THE DATUM IT CITES. Nothing
 * mechanical can. What it guarantees is narrower and is the guarantee 21.5
 * requirement 2 actually asks for: every claim arrives attached to a real,
 * fetched value, resolved to the exact `EvidenceItem` the prompt showed, so the
 * human checks prose against data rather than against a summary of the data.
 *
 * ── THE ENVELOPE IS UNWRAPPED; THE CONTENT RULES ARE NOT RELAXED ──
 *
 * The first real call to Workers AI showed that this model, in JSON-schema
 * mode, returns `{ response: { strategy: "grid", claims: [...] } }` -- an
 * ALREADY-PARSED OBJECT, not the JSON text Cloudflare's own type for that arm
 * declares (`{ response: string }`). The parser refused that response, and the
 * refusal was CORRECT: it was holding a wrong assumption to the right standard.
 *
 * The fix is confined to `unwrapModelEnvelope`, which recognises the transport
 * shapes and nothing else. Every content rule above is untouched and now runs
 * in ONE function (`validateAnswerObject`) shared by both paths, so a rule
 * relaxed for the object path would have to be relaxed for the text path in the
 * same edit, visibly. Unwrapping a known transport envelope and digging JSON
 * out of a model's prose are different acts; the second is still refused.
 *
 * ── TWO GAPS IN THE DUPLICATE-KEY PROTECTION, BOTH STATED RATHER THAN HIDDEN ──
 *
 * `JSON.parse` silently keeps the LAST of two duplicate keys, so
 * `{"strategy":"dca","strategy":"grid"}` parses to a clean, unambiguous-looking
 * object. `findDuplicateKey` closes that by scanning the source text. It has two
 * limits, and the second is the more serious:
 *
 *   1. Keys are compared in their SOURCE form, so a duplicate written with a
 *      unicode escape is not caught. Closing it means implementing JSON string
 *      unescaping -- a second parser, which this module refuses to have.
 *   2. **ON THE OBJECT PATH THE CHECK CANNOT RUN AT ALL**, because the
 *      transport parsed the bytes before this module saw them and the duplicate
 *      is already gone. It is NOT faked by re-stringifying; it is REPORTED, per
 *      response, as `ParsedAssessment.duplicateKeyCheck`. See that type for why
 *      a check that can never fail is worse than a missing one.
 */

import type { StrategyType } from "../db/schema";
import { ASSESS_STRATEGIES, type AssessPrompt, type EvidenceItem } from "./assess-prompt";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type AssessParseErrorCode =
  /** The transport returned neither answer text nor a recognised envelope. */
  | "envelope_unrecognised"
  /** `{response: ...}` was present but held neither text nor an object. */
  | "envelope_response_unusable"
  /** The request was queued as a batch job rather than answered. */
  | "async_batch_envelope"
  /** Empty, or nothing but whitespace. */
  | "empty_response"
  /** Wrapped in a markdown code fence. Deliberately not unwrapped. */
  | "fenced_response"
  /** `JSON.parse` refused it: prose, truncation, a trailing comma, two objects. */
  | "not_json"
  /** Valid JSON, but not a single object: an array, a string, a number, null. */
  | "not_an_object"
  /** The same key twice in one object. See the module header. */
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
  /** `claims` is an empty array: a choice with no stated reason. */
  | "claims_empty"
  /** An element of `claims` is not an object. */
  | "claim_not_an_object"
  /** A claim's `statement` is absent, not a string, or blank. */
  | "claim_statement_invalid"
  /** A claim's `citations` is absent, not an array, or empty. */
  | "claim_citations_invalid"
  /** A citation is not a string. */
  | "citation_not_a_string"
  /** A citation names an evidence id this run's prompt never emitted. */
  | "citation_unknown";

/**
 * Carries the code and, where it exists, the offending value.
 *
 * `received` is the raw thing that failed, kept so a human debugging a refusal
 * sees what the model actually said rather than a description of it. It is
 * `unknown` because that is what it genuinely is.
 */
export class AssessParseError extends Error {
  readonly code: AssessParseErrorCode;
  readonly received: unknown;
  constructor(code: AssessParseErrorCode, message: string, received?: unknown) {
    super(message);
    this.name = "AssessParseError";
    this.code = code;
    this.received = received;
  }
}

// ---------------------------------------------------------------------------
// The result
// ---------------------------------------------------------------------------

/**
 * One reason, with its evidence RESOLVED rather than referenced.
 *
 * `citations` holds the actual `EvidenceItem`s -- id, label, rendered value and
 * the bundle path it came from -- so a reader has the datum in hand beside the
 * sentence about it. A list of bare id strings would leave the human to look
 * each one up, which is the same as not having them (21.5 requirement 2).
 */
export interface CitedClaim {
  readonly statement: string;
  readonly citations: readonly [EvidenceItem, ...EvidenceItem[]];
}

/**
 * What a clean response resolves to. A non-empty claim list is a TYPE-level
 * guarantee, so "chose grid, said nothing" is unrepresentable rather than
 * checked for downstream.
 */
export interface ParsedAssessment {
  readonly strategy: StrategyType;
  readonly claims: readonly [CitedClaim, ...CitedClaim[]];
  /** How the answer arrived. See `AssessEnvelopeShape` -- this is observed behaviour. */
  readonly envelope: AssessEnvelopeShape;
  /**
   * Whether the duplicate-key protection could run for THIS response.
   *
   * On the result rather than in a comment because it varies per call and an
   * audit record that cannot say which guarantees held is not an audit record.
   */
  readonly duplicateKeyCheck: DuplicateKeyCheck;
}

/**
 * The JSON Schema handed to Workers AI as `response_format.json_schema`.
 *
 * Written from the same constants the prompt and the parser use, so the three
 * cannot disagree about the literals. It is a request, NOT a guarantee:
 * Cloudflare's own JSON Mode documentation states it "can't guarantee that the
 * model responds according to the requested JSON Schema". This module therefore
 * validates as though no schema had been sent, and the schema is an optimisation
 * on the retry rate rather than a check.
 */
export const ASSESS_RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    strategy: { type: "string", enum: [...ASSESS_STRATEGIES] },
    claims: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          statement: { type: "string", minLength: 1 },
          citations: { type: "array", minItems: 1, items: { type: "string" } },
        },
        required: ["statement", "citations"],
      },
    },
  },
  required: ["strategy", "claims"],
} as const;

// ---------------------------------------------------------------------------
// Duplicate-key detection
// ---------------------------------------------------------------------------

interface ScanFrame {
  readonly isObject: boolean;
  expectKey: boolean;
  readonly keys: Set<string>;
}

/**
 * Find a key that appears twice in the same object, at any depth.
 *
 * Run on the SOURCE TEXT after a successful `JSON.parse`, because by the time
 * there is a parsed object the duplicate is already gone -- the last value
 * silently won. A single-pass scanner rather than a regex: quoting, escapes and
 * nesting all matter, and a regex over JSON is the kind of near-enough parsing
 * this file exists to refuse.
 *
 * Returns the duplicated key, or null. Keys are compared in their source form;
 * see the module header for the escape-sequence limit that follows from that.
 */
export function findDuplicateKey(text: string): string | null {
  const stack: ScanFrame[] = [];
  let index = 0;

  while (index < text.length) {
    const char = text[index]!;

    if (char === '"') {
      let cursor = index + 1;
      let literal = "";
      while (cursor < text.length) {
        const inner = text[cursor]!;
        if (inner === "\\") {
          literal += inner + (text[cursor + 1] ?? "");
          cursor += 2;
          continue;
        }
        if (inner === '"') break;
        literal += inner;
        cursor += 1;
      }
      const frame = stack[stack.length - 1];
      if (frame !== undefined && frame.isObject && frame.expectKey) {
        if (frame.keys.has(literal)) return literal;
        frame.keys.add(literal);
      }
      index = cursor + 1;
      continue;
    }

    if (char === "{") {
      stack.push({ isObject: true, expectKey: true, keys: new Set() });
    } else if (char === "[") {
      stack.push({ isObject: false, expectKey: false, keys: new Set() });
    } else if (char === "}" || char === "]") {
      stack.pop();
    } else if (char === ":") {
      const frame = stack[stack.length - 1];
      if (frame !== undefined) frame.expectKey = false;
    } else if (char === ",") {
      const frame = stack[stack.length - 1];
      if (frame !== undefined && frame.isObject) frame.expectKey = true;
    }

    index += 1;
  }

  return null;
}

// ---------------------------------------------------------------------------
// The transport envelope
// ---------------------------------------------------------------------------

/**
 * How the answer actually arrived. Recorded on every result.
 *
 * OBSERVED, not guessed. The first real call to
 * `@cf/meta/llama-3.3-70b-instruct-fp8-fast` with
 * `response_format: {type: "json_schema", ...}` returned
 * `{ response: { strategy: "grid", claims: [...] } }` -- `.response` is an
 * ALREADY-PARSED OBJECT, not the JSON string the model emitted. Cloudflare's
 * own type for this model declares that arm as `{ response: string; ... }`, so
 * the documented type is wrong for this model in this mode, and the parser's
 * original refusal of the object was correct behaviour against a wrong
 * assumption rather than a bug in its strictness.
 */
export type AssessEnvelopeShape =
  /** A bare string: the answer as text, no wrapper. */
  | "bare_string"
  /** `{ response: "<json text>" }` -- wrapped, still text. */
  | "envelope_string"
  /** `{ response: { ... } }` -- wrapped, already parsed. THE OBSERVED SHAPE. */
  | "envelope_object"
  /** The answer object itself, handed over already unwrapped by a caller. */
  | "bare_object";

/**
 * Whether the duplicate-key protection could run at all.
 *
 * ── A PROTECTION THAT IS SOMETIMES STRUCTURALLY UNAVAILABLE, SAID OUT LOUD ──
 *
 * `findDuplicateKey` works on the model's own bytes, because that is the only
 * place a duplicate key still exists: any JSON parser -- ours or the
 * transport's -- silently keeps the last value and the contradiction is gone
 * before any code can see it.
 *
 * So on the OBJECT path the check is not merely skipped, it is IMPOSSIBLE. The
 * bytes were consumed inside `env.AI.run` before this module was reached.
 *
 * **Re-stringifying the object and scanning that would be theatre**, and is
 * deliberately not done: `JSON.stringify` of an already-parsed object can never
 * contain a duplicate key, so the scan would return null every time and read as
 * protection while providing none. A check that cannot fail is worse than an
 * absent one, because only the absent one is visible.
 *
 * It is therefore reported on the result instead, so an audit record says which
 * guarantees actually held for that particular proposal.
 *
 * THE ONE ROUTE BACK TO THE BYTES, UNVERIFIED: `AiOptions.returnRawResponse`
 * makes `env.AI.run` return a `Response`, whose body could be read with
 * `.text()`. Whether the model's original bytes survive into that body -- or
 * whether Cloudflare has already parsed and re-serialised them upstream, which
 * is exactly what produces the object here -- is UNKNOWN and is a question for
 * the next probe, not an assumption to build on.
 */
export type DuplicateKeyCheck =
  /** The answer arrived as text; the scan ran. */
  | "performed"
  /** The answer arrived already parsed; the bytes were gone. See above. */
  | "unavailable_transport_parsed";

export interface UnwrappedAnswer {
  readonly shape: AssessEnvelopeShape;
  /** The answer: a string on the text paths, a plain object on the object paths. */
  readonly answer: unknown;
  /** The model's own bytes when they survived to here, else null. */
  readonly sourceText: string | null;
}

/**
 * Find the answer inside whatever the transport handed back.
 *
 * ONLY THE ENVELOPE IS UNWRAPPED HERE. Nothing in this function looks at the
 * answer's content, and nothing it accepts loosens a content rule: an
 * unrecognised envelope is a refusal, and every shape it does recognise leads to
 * the same `validateAnswerObject`.
 *
 * The distinction it exists to keep is between "the transport wrapped the
 * answer" -- a fact about Cloudflare's API that this system does not control --
 * and "the model wrote prose around its JSON", which is a rule violation and
 * still refused. Unwrapping a KNOWN, OBSERVED transport envelope is not the
 * same act as digging JSON out of a sentence, and the second is still refused
 * by `parseAnswerText`.
 */
export function unwrapModelEnvelope(raw: unknown): UnwrappedAnswer {
  if (typeof raw === "string") {
    return { shape: "bare_string", answer: raw, sourceText: raw };
  }

  if (!isPlainObject(raw)) {
    throw new AssessParseError(
      "envelope_unrecognised",
      `the model transport returned ${raw === null ? "null" : Array.isArray(raw) ? "an array" : typeof raw}, which is neither an answer string nor a recognised Workers AI envelope`,
      raw,
    );
  }

  if (!Object.prototype.hasOwnProperty.call(raw, "response")) {
    // The async-batch arm of the documented output union. Named rather than
    // folded into a generic refusal: it means the request was QUEUED, not
    // answered, so "the model gave a bad answer" would be the wrong sentence.
    if (Object.prototype.hasOwnProperty.call(raw, "request_id")) {
      throw new AssessParseError(
        "async_batch_envelope",
        `the transport returned an async batch envelope (request_id ${JSON.stringify(raw["request_id"])}), not an answer. This stage runs one synchronous call; queueRequest must not be set.`,
        raw,
      );
    }
    // A caller that already unwrapped. Accepted, and then held to exactly the
    // same content rules as every other path.
    return { shape: "bare_object", answer: raw, sourceText: null };
  }

  const response = raw["response"];
  if (typeof response === "string") {
    return { shape: "envelope_string", answer: response, sourceText: response };
  }
  if (isPlainObject(response)) {
    return { shape: "envelope_object", answer: response, sourceText: null };
  }

  throw new AssessParseError(
    "envelope_response_unusable",
    `the transport envelope's "response" field is ${response === null ? "null" : Array.isArray(response) ? "an array" : typeof response}, which is neither answer text nor an answer object`,
    response,
  );
}

// ---------------------------------------------------------------------------
// Field helpers
// ---------------------------------------------------------------------------

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Require an object's key set to be EXACTLY `allowed`.
 *
 * Both directions are errors and they are different errors: a missing field is
 * a response that did not answer, an extra field is a response to a different
 * question. Reported with the real key names so the failure is diagnosable from
 * the log alone.
 */
function requireExactFields(value: Record<string, unknown>, allowed: readonly string[], where: string): void {
  for (const field of allowed) {
    if (!Object.prototype.hasOwnProperty.call(value, field)) {
      throw new AssessParseError(
        "missing_field",
        `${where} is missing the required field ${JSON.stringify(field)}; the response contract has exactly the fields ${allowed.map((f) => JSON.stringify(f)).join(", ")}`,
        Object.keys(value),
      );
    }
  }
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw new AssessParseError(
        "unexpected_field",
        `${where} carries the field ${JSON.stringify(key)}, which the response contract does not define. It is refused rather than ignored: a response answering a question that was not asked has not answered the one that was.`,
        key,
      );
    }
  }
}

function parseClaim(raw: unknown, position: number, evidenceById: ReadonlyMap<string, EvidenceItem>): CitedClaim {
  const where = `claims[${position}]`;
  if (!isPlainObject(raw)) {
    throw new AssessParseError("claim_not_an_object", `${where} is not an object`, raw);
  }
  requireExactFields(raw, ["statement", "citations"], where);

  const statement = raw["statement"];
  if (typeof statement !== "string" || statement.trim() === "") {
    throw new AssessParseError(
      "claim_statement_invalid",
      `${where}.statement must be a non-blank string`,
      statement,
    );
  }

  const citations = raw["citations"];
  if (!Array.isArray(citations) || citations.length === 0) {
    throw new AssessParseError(
      "claim_citations_invalid",
      `${where}.citations must be a non-empty array of evidence ids. A claim with no citation is exactly the ungrounded prose 21.5 requirement 1 forbids, so it is refused rather than kept.`,
      citations,
    );
  }

  const resolved: EvidenceItem[] = [];
  for (const [citationIndex, citation] of citations.entries()) {
    if (typeof citation !== "string") {
      throw new AssessParseError(
        "citation_not_a_string",
        `${where}.citations[${citationIndex}] is not a string`,
        citation,
      );
    }
    const item = evidenceById.get(citation);
    if (item === undefined) {
      throw new AssessParseError(
        "citation_unknown",
        `${where}.citations[${citationIndex}] cites ${JSON.stringify(citation)}, which this run's prompt never emitted. An invented citation is direct evidence that the response was not derived from the data provided (21.5 requirement 1), so the whole response is refused rather than this citation dropped.`,
        citation,
      );
    }
    resolved.push(item);
  }

  return { statement, citations: resolved as [EvidenceItem, ...EvidenceItem[]] };
}

// ---------------------------------------------------------------------------
// The parser
// ---------------------------------------------------------------------------

/**
 * Read a model's raw response, or refuse it.
 *
 * @param raw    the model's response text, exactly as it arrived, untrimmed and
 *               unmodified. Typed `unknown` rather than `string` on purpose: the
 *               Workers AI output type is a union that includes a bare string
 *               and an async-batch envelope (see assess-model.ts), so "the
 *               caller definitely handed us a string" is an assumption this
 *               function refuses to make about a boundary it does not own.
 * @param prompt the prompt that produced it. Required, not optional: without
 *               the evidence ids there is no grounding check, and an optional
 *               parameter is how a grounding check becomes something a caller
 *               can forget.
 *
 * @throws AssessParseError on anything that is not exactly one clean, fully
 *         grounded answer. Never returns a default.
 */
export function parseAssessResponse(raw: unknown, prompt: AssessPrompt): ParsedAssessment {
  const unwrapped = unwrapModelEnvelope(raw);

  let answer: Record<string, unknown>;
  let duplicateKeyCheck: DuplicateKeyCheck;

  if (unwrapped.sourceText !== null) {
    // The TEXT path. Every byte the model produced is in hand, so every check
    // this module has is available -- including the duplicate-key scan.
    answer = parseAnswerText(unwrapped.sourceText);
    duplicateKeyCheck = "performed";
  } else {
    // The OBJECT path. See `DuplicateKeyCheck` for what is lost and why it is
    // reported rather than faked.
    answer = unwrapped.answer as Record<string, unknown>;
    duplicateKeyCheck = "unavailable_transport_parsed";
  }

  const { strategy, claims } = validateAnswerObject(answer, prompt);

  return { strategy, claims, envelope: unwrapped.shape, duplicateKeyCheck };
}

/**
 * The TEXT path: a string in, a validated-as-an-object-shaped value out.
 *
 * Unchanged from the original implementation, and deliberately so -- the
 * envelope fix touches how the answer is REACHED, never what is accepted once
 * it is. Empty, fenced, prose-wrapped, truncated and duplicate-keyed responses
 * all fail here exactly as they always did.
 */
function parseAnswerText(raw: string): Record<string, unknown> {
  const trimmed = raw.trim();
  if (trimmed === "") {
    throw new AssessParseError("empty_response", "the model returned an empty response", raw);
  }

  if (trimmed.startsWith("```")) {
    throw new AssessParseError(
      "fenced_response",
      "the model wrapped its answer in a markdown code fence, which the prompt forbade. The fence is deliberately NOT stripped: every unwrapping rule added here is a rule about text the model was told not to produce, and unwrapping is the first step toward extracting JSON out of prose.",
      raw,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    throw new AssessParseError(
      "not_json",
      `the model response is not valid JSON (${error instanceof Error ? error.message : String(error)}). No attempt is made to locate JSON inside surrounding prose.`,
      raw,
    );
  }

  const duplicate = findDuplicateKey(trimmed);
  if (duplicate !== null) {
    throw new AssessParseError(
      "duplicate_key",
      `the model response repeats the key ${JSON.stringify(duplicate)} in one object. JSON.parse keeps the last value silently, so a self-contradictory response would otherwise look clean.`,
      duplicate,
    );
  }

  if (!isPlainObject(parsed)) {
    throw new AssessParseError(
      "not_an_object",
      `the model response is valid JSON but not a single object (received ${Array.isArray(parsed) ? "an array" : parsed === null ? "null" : typeof parsed})`,
      parsed,
    );
  }

  return parsed;
}

/**
 * The CONTENT rules, applied identically however the answer was reached.
 *
 * This is the whole of the strictness: exact field set, exact strategy literal,
 * non-empty claims, claim shape, and the grounding check on every citation. It
 * is one function rather than two so that the text path and the object path
 * CANNOT diverge -- a rule relaxed for one would have to be relaxed for both,
 * visibly, in this function.
 */
function validateAnswerObject(
  answer: Record<string, unknown>,
  prompt: AssessPrompt,
): { strategy: StrategyType; claims: readonly [CitedClaim, ...CitedClaim[]] } {
  requireExactFields(answer, ["strategy", "claims"], "the response");

  const strategy = answer["strategy"];
  if (typeof strategy !== "string") {
    throw new AssessParseError("strategy_not_a_string", "strategy must be a string", strategy);
  }
  if (!(ASSESS_STRATEGIES as readonly string[]).includes(strategy)) {
    throw new AssessParseError(
      "strategy_not_recognised",
      `strategy must be exactly one of ${ASSESS_STRATEGIES.map((s) => JSON.stringify(s)).join(" or ")}; received ${JSON.stringify(strategy)}. No trimming, case folding or nearest-match is performed -- see the module header.`,
      strategy,
    );
  }

  const claims = answer["claims"];
  if (!Array.isArray(claims)) {
    throw new AssessParseError("claims_not_an_array", "claims must be an array", claims);
  }
  if (claims.length === 0) {
    throw new AssessParseError(
      "claims_empty",
      "claims is empty: a strategy chosen with no stated reason is not reviewable, and an unreviewable proposal is the thing 21.1 exists to prevent",
      claims,
    );
  }

  const evidenceById = new Map(prompt.evidence.map((item) => [item.id, item] as const));
  const parsedClaims = claims.map((claim, position) => parseClaim(claim, position, evidenceById));

  return {
    strategy: strategy as StrategyType,
    claims: parsedClaims as [CitedClaim, ...CitedClaim[]],
  };
}
