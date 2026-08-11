/**
 * The strict reader: every way a model can answer badly, and the assertion that
 * each one FAILS rather than being coerced into an answer.
 *
 * This file is deliberately lopsided. Two tests cover the clean case; the rest
 * are adversarial, because the clean case is the one a permissive parser also
 * passes. The bug this file exists to prevent does not look like a crash -- it
 * looks like a proposal that says "grid" underneath reasoning that never said
 * grid, and no test that only feeds well-formed JSON can see it.
 *
 * The fixtures are constructed to be PLAUSIBLE rather than absurd. Every one of
 * them is a shape a real instruction-following model actually produces: a
 * markdown fence, a sentence of preamble before the JSON, an answer truncated
 * at `max_tokens`, a "confidence" field nobody asked for, a hedged strategy
 * value, an invented citation id that looks exactly like a real one, and a
 * self-contradictory object with the same key twice.
 *
 * Five properties:
 *
 *  1. EXACTLY TWO ANSWERS RESOLVE. "dca" and "grid". Everything else throws.
 *     No case folding, no trimming of the value, no nearest match.
 *  2. NOTHING IS EXTRACTED FROM PROSE. No fence stripping, no first-`{`-to-
 *     last-`}` scan. Text around the JSON is a refusal, not a parsing problem.
 *  3. GROUNDING IS ENFORCED, NOT REQUESTED. A citation naming an id this run's
 *     prompt never emitted fails the WHOLE response (21.5 requirement 1).
 *  4. A CONTRADICTION CANNOT PARSE CLEANLY. `{"strategy":"dca","strategy":
 *     "grid"}` is valid JSON that `JSON.parse` silently resolves to one value.
 *     It is refused.
 *  5. WHAT SURVIVES IS FULLY RESOLVED. A claim comes back with its real
 *     `EvidenceItem`s -- value and bundle path included -- not with id strings
 *     a human would have to look up (21.5 requirement 2).
 *
 * NOTHING HERE CALLS A MODEL. Every "response" below is a string literal
 * written by hand.
 */

import { describe, expect, it } from "vitest";

import { buildAssessPrompt, type AssessPrompt } from "./assess-prompt";
import { AssessParseError, findDuplicateKey, parseAssessResponse } from "./assess-parse";
import { CandleWindowError } from "./candles";
import { assessConcentration, type AccountExposure } from "./concentration";
import type { Candidate } from "./candidates";
import { NEWS_NOT_YET_AVAILABLE, type CandidateGatherBundle } from "./gather";
import type { Candle, Timestamp } from "../shared/exchange-client";
import { ONE } from "../shared/money";

// ---------------------------------------------------------------------------
// One real prompt, built from a real bundle
// ---------------------------------------------------------------------------

const T0 = 1_930_000_000_000;
const MINUTE = 60_000;
const PAIR = "ZZQUSD";

const candidate: Candidate = {
  accountLabel: "gemini-main",
  exchange: "gemini",
  pair: PAIR,
  sources: [{ kind: "named", requestedAs: " zzqusd ", requestedBy: "operator@example.com", requestedAt: T0 }],
};

const candles: Candle[] = Array.from({ length: 90 }, (_unused, index) => ({
  pair: PAIR,
  openTime: T0 + index * MINUTE,
  closeTime: T0 + (index + 1) * MINUTE,
  open: BigInt(100 + index) * ONE,
  high: BigInt(102 + index) * ONE,
  low: BigInt(97 + index) * ONE,
  close: BigInt(101 + index) * ONE,
  volume: 4n * ONE,
  closed: true,
}));

const exposure: AccountExposure = {
  accountLabel: candidate.accountLabel,
  readAt: T0 + 10 * MINUTE,
  rowsRead: 1,
  committed: [
    { id: "b-1", pair: "AAAUSD", capitalAsset: "USD", allocatedCapital: 50n * ONE, status: "running", archived: false },
  ],
  stopped: [],
  quoteAssetsObserved: ["USD"],
};

const bundle: CandidateGatherBundle = {
  candidate,
  candles: {
    outcome: "ok",
    value: {
      accountLabel: candidate.accountLabel,
      exchange: "gemini",
      pair: PAIR,
      interval: "1m",
      candles,
      fetchedAt: T0 + 90 * MINUTE,
      requestedSince: null,
      earliestOpenTime: candles[0]!.openTime,
      earliestCloseTime: candles[0]!.closeTime,
      latestCloseTime: candles[candles.length - 1]!.closeTime,
      truncated: false,
      missingHistoryMs: null,
    },
  },
  news: NEWS_NOT_YET_AVAILABLE,
  concentration: { outcome: "ok", value: assessConcentration(exposure, candidate) },
  assembledAt: (T0 + 91 * MINUTE) as Timestamp,
};

const prompt: AssessPrompt = buildAssessPrompt(bundle);

/** Two ids this prompt really emitted, used by the clean fixtures. */
const REAL_ID = "candles.range_pct";
const OTHER_REAL_ID = "candles.count";

/** Assert a refusal, by code, and return it so a test can check the message. */
function refuses(raw: unknown, code: string): AssessParseError {
  let thrown: unknown;
  try {
    parseAssessResponse(raw, prompt);
  } catch (error) {
    thrown = error;
  }
  expect(thrown, `expected a refusal with code ${code}, but the response parsed cleanly`).toBeInstanceOf(
    AssessParseError,
  );
  const error = thrown as AssessParseError;
  expect(error.code, `wrong refusal code (message: ${error.message})`).toBe(code);
  return error;
}

const clean = (strategy: string) =>
  JSON.stringify({
    strategy,
    claims: [
      { statement: "The window's high-to-low range is wide relative to its close.", citations: [REAL_ID] },
      { statement: "Ninety candles is a short window.", citations: [OTHER_REAL_ID, REAL_ID] },
    ],
  });

// ---------------------------------------------------------------------------
// Property 1 and 5: the clean case, fully resolved
// ---------------------------------------------------------------------------

describe("a clean response", () => {
  it("resolves 'dca' with its claims and their real evidence attached", () => {
    const result = parseAssessResponse(clean("dca"), prompt);

    expect(result.strategy).toBe("dca");
    expect(result.claims).toHaveLength(2);
    expect(result.claims[0].statement).toBe("The window's high-to-low range is wide relative to its close.");

    // The citation is the real EvidenceItem, by identity, not a copy and not a string.
    const cited = result.claims[0].citations[0];
    expect(cited).toBe(prompt.evidence.find((item) => item.id === REAL_ID));
    expect(cited.value).toBe(prompt.evidence.find((item) => item.id === REAL_ID)!.value);
    expect(cited.source).not.toBe("");
    expect(result.claims[1]!.citations).toHaveLength(2);
  });

  it("resolves 'grid'", () => {
    expect(parseAssessResponse(clean("grid"), prompt).strategy).toBe("grid");
  });

  it("accepts hedged PROSE inside a claim, because the CHOICE is what must be unambiguous", () => {
    // Deliberate, and the reasoning is in assess-parse.ts: the prompt REQUIRES
    // the model to say when evidence is thin, so a cautious sentence is a
    // required output, not a hedge. What may never be ambiguous is `strategy`.
    const response = JSON.stringify({
      strategy: "dca",
      claims: [{ statement: "The window is short, so this is a weak signal and may not hold.", citations: [OTHER_REAL_ID] }],
    });
    expect(parseAssessResponse(response, prompt).strategy).toBe("dca");
  });
});

// ---------------------------------------------------------------------------
// The transport envelope, as REALLY observed
// ---------------------------------------------------------------------------

describe("the real Workers AI envelope", () => {
  /**
   * THE EXACT SHAPE THE FIRST REAL CALL RETURNED, not a guess at it.
   *
   * `@cf/meta/llama-3.3-70b-instruct-fp8-fast`, `response_format:
   * {type: "json_schema"}`, `temperature: 0`, `seed: 20260811`: `.response` came
   * back as an ALREADY-PARSED OBJECT, though Cloudflare's generated type
   * declares that arm as `{ response: string }`.
   *
   * The original parser refused this, and the refusal was correct -- it was a
   * wrong assumption held to the right standard. The fix unwraps the envelope
   * and changes no content rule.
   */
  const REAL_ENVELOPE = {
    response: {
      strategy: "grid",
      claims: [
        {
          statement: "The high-to-low range across the window is wide relative to the last close.",
          citations: ["candles.range_pct", "candles.last_close"],
        },
        {
          statement: "News and sentiment were not collected for this run, so no sentiment evidence supports this choice.",
          citations: ["news.status"],
        },
      ],
    },
  };

  it("parses the observed object envelope", () => {
    const result = parseAssessResponse(REAL_ENVELOPE, prompt);

    expect(result.strategy).toBe("grid");
    expect(result.claims).toHaveLength(2);
    expect(result.envelope).toBe("envelope_object");
    // Citations still resolve to the real EvidenceItems, by identity.
    expect(result.claims[0]!.citations[0]).toBe(prompt.evidence.find((item) => item.id === "candles.range_pct"));
    expect(result.claims[1]!.citations[0]!.id).toBe("news.status");
  });

  it("reports that the duplicate-key check could NOT run on that path", () => {
    // The transport parsed the bytes before this module saw them, so the
    // protection is structurally unavailable. Reported, never faked.
    expect(parseAssessResponse(REAL_ENVELOPE, prompt).duplicateKeyCheck).toBe("unavailable_transport_parsed");
  });

  it("still runs the duplicate-key check when the answer arrives as text", () => {
    expect(parseAssessResponse(clean("dca"), prompt).duplicateKeyCheck).toBe("performed");
    expect(parseAssessResponse({ response: clean("dca") }, prompt).duplicateKeyCheck).toBe("performed");
  });

  it("parses a wrapped TEXT envelope, and says which shape it was", () => {
    const result = parseAssessResponse({ response: clean("dca") }, prompt);
    expect(result.strategy).toBe("dca");
    expect(result.envelope).toBe("envelope_string");
  });

  it("parses a bare string, and says which shape it was", () => {
    expect(parseAssessResponse(clean("grid"), prompt).envelope).toBe("bare_string");
  });

  it("accepts an answer object a caller already unwrapped", () => {
    const result = parseAssessResponse(REAL_ENVELOPE.response, prompt);
    expect(result.strategy).toBe("grid");
    expect(result.envelope).toBe("bare_object");
    expect(result.duplicateKeyCheck).toBe("unavailable_transport_parsed");
  });

  it("names the async-batch envelope rather than calling it a bad answer", () => {
    const error = refuses({ request_id: "abc-123" }, "async_batch_envelope");
    expect(error.message).toContain("not an answer");
    expect(error.message).toContain("queueRequest");
    expect(error.message).toContain("abc-123");
  });

  it("refuses an envelope whose `response` is neither text nor an object", () => {
    refuses({ response: 42 }, "envelope_response_unusable");
    refuses({ response: null }, "envelope_response_unusable");
    refuses({ response: ["grid"] }, "envelope_response_unusable");
  });

  it("carries the usage/tool_calls siblings without being confused by them", () => {
    const result = parseAssessResponse(
      { ...REAL_ENVELOPE, usage: { prompt_tokens: 4001, completion_tokens: 180 }, tool_calls: [] },
      prompt,
    );
    expect(result.strategy).toBe("grid");
  });
});

// ---------------------------------------------------------------------------
// The object path is held to EXACTLY the same content rules as the text path
// ---------------------------------------------------------------------------

describe("content strictness is identical on the object path", () => {
  const enveloped = (answer: unknown) => ({ response: answer });

  it("refuses 'DCA' -- no case folding, object path either", () => {
    refuses(enveloped({ strategy: "DCA", claims: [{ statement: "x", citations: [REAL_ID] }] }), "strategy_not_recognised");
  });

  it("refuses a hedged choice on the object path", () => {
    refuses(enveloped({ strategy: "dca or grid", claims: [{ statement: "x", citations: [REAL_ID] }] }), "strategy_not_recognised");
  });

  it("refuses an extra field on the object path", () => {
    refuses(
      enveloped({ strategy: "dca", claims: [{ statement: "x", citations: [REAL_ID] }], confidence: 0.9 }),
      "unexpected_field",
    );
  });

  it("refuses an invented citation on the object path", () => {
    refuses(
      enveloped({ strategy: "grid", claims: [{ statement: "RSI is low.", citations: ["candles.rsi_14"] }] }),
      "citation_unknown",
    );
  });

  it("refuses empty claims on the object path", () => {
    refuses(enveloped({ strategy: "grid", claims: [] }), "claims_empty");
  });

  it("refuses a blank statement on the object path", () => {
    refuses(enveloped({ strategy: "grid", claims: [{ statement: "  ", citations: [REAL_ID] }] }), "claim_statement_invalid");
  });

  it("refuses an uncited claim on the object path", () => {
    refuses(enveloped({ strategy: "grid", claims: [{ statement: "x", citations: [] }] }), "claim_citations_invalid");
  });

  it("refuses a missing field on the object path", () => {
    refuses(enveloped({ strategy: "grid" }), "missing_field");
  });
});

// ---------------------------------------------------------------------------
// Property 1: only two literals
// ---------------------------------------------------------------------------

describe("the strategy field", () => {
  it("refuses 'DCA' -- no case folding", () => {
    const error = refuses(clean("DCA"), "strategy_not_recognised");
    expect(error.message).toContain("No trimming, case folding or nearest-match");
    expect(error.received).toBe("DCA");
  });

  it("refuses 'Grid'", () => {
    refuses(clean("Grid"), "strategy_not_recognised");
  });

  it("refuses 'dca ' -- no trimming of the value", () => {
    refuses(clean("dca "), "strategy_not_recognised");
  });

  it("refuses a hedged choice: 'dca or grid'", () => {
    refuses(clean("dca or grid"), "strategy_not_recognised");
  });

  it("refuses 'either'", () => {
    refuses(clean("either"), "strategy_not_recognised");
  });

  it("refuses a qualified choice: 'dca (but grid would also work)'", () => {
    refuses(clean("dca (but grid would also work)"), "strategy_not_recognised");
  });

  it("refuses a strategy this system does not have", () => {
    refuses(clean("scalping"), "strategy_not_recognised");
  });

  it("refuses both strategies as an array", () => {
    const response = JSON.stringify({ strategy: ["dca", "grid"], claims: [{ statement: "x", citations: [REAL_ID] }] });
    refuses(response, "strategy_not_a_string");
  });

  it("refuses null", () => {
    const response = JSON.stringify({ strategy: null, claims: [{ statement: "x", citations: [REAL_ID] }] });
    refuses(response, "strategy_not_a_string");
  });

  it("refuses a whole sentence", () => {
    refuses(clean("I would recommend a grid strategy here."), "strategy_not_recognised");
  });
});

// ---------------------------------------------------------------------------
// Property 2: nothing is extracted from prose
// ---------------------------------------------------------------------------

describe("responses that are not exactly one JSON object", () => {
  it("refuses an empty response", () => {
    refuses("", "empty_response");
  });

  it("refuses a whitespace-only response", () => {
    refuses("   \n\t  ", "empty_response");
  });

  it("refuses a transport value that is neither answer text nor a known envelope", () => {
    refuses(undefined, "envelope_unrecognised");
    refuses(null, "envelope_unrecognised");
    refuses(42, "envelope_unrecognised");
    refuses([clean("dca")], "envelope_unrecognised");
  });

  it("refuses a markdown code fence rather than unwrapping it", () => {
    const error = refuses("```json\n" + clean("grid") + "\n```", "fenced_response");
    expect(error.message).toContain("deliberately NOT stripped");
  });

  it("refuses a bare fence with no language tag", () => {
    refuses("```\n" + clean("grid") + "\n```", "fenced_response");
  });

  it("refuses JSON with a sentence of preamble", () => {
    refuses("Based on the data provided, here is my assessment:\n" + clean("dca"), "not_json");
  });

  it("refuses JSON with a sentence appended after it", () => {
    refuses(clean("dca") + "\n\nLet me know if you want parameters as well.", "not_json");
  });

  it("refuses two JSON objects", () => {
    refuses(clean("dca") + clean("grid"), "not_json");
  });

  it("refuses a response truncated at max_tokens", () => {
    const truncated = clean("grid").slice(0, 60);
    const error = refuses(truncated, "not_json");
    expect(error.message).toContain("No attempt is made to locate JSON inside surrounding prose");
  });

  it("refuses a plain-language refusal from the model", () => {
    refuses("I cannot answer this without more information about the coin.", "not_json");
  });

  it("refuses a question asked back", () => {
    refuses("Which timeframe should I weight most heavily?", "not_json");
  });

  it("refuses Cloudflare's own JSON-mode failure text", () => {
    // Documented: JSON Mode "can't guarantee" compliance and returns an error
    // when it cannot be met. Whatever surfaces as text must not parse.
    refuses("JSON Mode couldn't be met", "not_json");
  });

  it("refuses a top-level array", () => {
    refuses(JSON.stringify([{ strategy: "dca", claims: [] }]), "not_an_object");
  });

  it("refuses a bare JSON string", () => {
    refuses(JSON.stringify("dca"), "not_an_object");
  });

  it("refuses JSON null", () => {
    refuses("null", "not_an_object");
  });

  it("refuses a number", () => {
    refuses("1", "not_an_object");
  });
});

// ---------------------------------------------------------------------------
// The field contract
// ---------------------------------------------------------------------------

describe("the response object's fields", () => {
  it("refuses a missing strategy", () => {
    refuses(JSON.stringify({ claims: [{ statement: "x", citations: [REAL_ID] }] }), "missing_field");
  });

  it("refuses missing claims", () => {
    refuses(JSON.stringify({ strategy: "dca" }), "missing_field");
  });

  it("refuses an extra field rather than ignoring it", () => {
    const response = JSON.stringify({
      strategy: "dca",
      claims: [{ statement: "x", citations: [REAL_ID] }],
      confidence: 0.82,
    });
    const error = refuses(response, "unexpected_field");
    expect(error.received).toBe("confidence");
    expect(error.message).toContain("answering a question that was not asked");
  });

  it("refuses an off-topic answer with entirely different fields", () => {
    refuses(JSON.stringify({ answer: "The asset looks strong.", sources: [] }), "missing_field");
  });

  it("refuses a __proto__ key, which JSON.parse makes an own property", () => {
    refuses('{"strategy":"dca","claims":[{"statement":"x","citations":["candles.count"]}],"__proto__":{"a":1}}', "unexpected_field");
  });

  it("refuses claims that are not an array", () => {
    refuses(JSON.stringify({ strategy: "dca", claims: { statement: "x" } }), "claims_not_an_array");
  });

  it("refuses an empty claims array: a choice with no stated reason", () => {
    const error = refuses(JSON.stringify({ strategy: "dca", claims: [] }), "claims_empty");
    expect(error.message).toContain("not reviewable");
  });
});

describe("each claim", () => {
  const withClaim = (claim: unknown) => JSON.stringify({ strategy: "grid", claims: [claim] });

  it("must be an object, not a bare sentence", () => {
    refuses(withClaim("The range is wide."), "claim_not_an_object");
  });

  it("must not carry an extra field", () => {
    refuses(withClaim({ statement: "x", citations: [REAL_ID], weight: 3 }), "unexpected_field");
  });

  it("must have a statement", () => {
    refuses(withClaim({ citations: [REAL_ID] }), "missing_field");
  });

  it("refuses a blank statement", () => {
    refuses(withClaim({ statement: "   ", citations: [REAL_ID] }), "claim_statement_invalid");
  });

  it("refuses a non-string statement", () => {
    refuses(withClaim({ statement: 12, citations: [REAL_ID] }), "claim_statement_invalid");
  });

  it("refuses a claim with no citations field", () => {
    refuses(withClaim({ statement: "The range is wide." }), "missing_field");
  });

  it("refuses an empty citations array -- uncited prose is not kept 'for context'", () => {
    const error = refuses(withClaim({ statement: "The range is wide.", citations: [] }), "claim_citations_invalid");
    expect(error.message).toContain("ungrounded prose");
  });

  it("refuses citations that are not an array", () => {
    refuses(withClaim({ statement: "x", citations: REAL_ID }), "claim_citations_invalid");
  });

  it("refuses a non-string citation", () => {
    refuses(withClaim({ statement: "x", citations: [7] }), "citation_not_a_string");
  });

  it("names the failing claim's position, so a refusal is diagnosable", () => {
    const response = JSON.stringify({
      strategy: "dca",
      claims: [
        { statement: "fine", citations: [REAL_ID] },
        { statement: "fine", citations: [REAL_ID] },
        { statement: "", citations: [REAL_ID] },
      ],
    });
    expect(refuses(response, "claim_statement_invalid").message).toContain("claims[2]");
  });
});

// ---------------------------------------------------------------------------
// Property 3: grounding is enforced
// ---------------------------------------------------------------------------

describe("citations", () => {
  it("refuses an invented id that looks exactly like a real one", () => {
    const response = JSON.stringify({
      strategy: "grid",
      claims: [{ statement: "RSI is oversold.", citations: ["candles.rsi_14"] }],
    });
    const error = refuses(response, "citation_unknown");
    expect(error.received).toBe("candles.rsi_14");
    expect(error.message).toContain("was not derived from the data provided");
  });

  it("refuses an id that is real in OTHER runs but was not emitted in this one", () => {
    // This bundle's concentration came back clean, so no flag id exists here.
    expect(prompt.evidenceIds).not.toContain("concentration.flag.1");
    const response = JSON.stringify({
      strategy: "dca",
      claims: [{ statement: "The account is already concentrated here.", citations: ["concentration.flag.1"] }],
    });
    refuses(response, "citation_unknown");
  });

  it("fails the WHOLE response for one bad citation among good ones", () => {
    const response = JSON.stringify({
      strategy: "grid",
      claims: [
        { statement: "good", citations: [REAL_ID] },
        { statement: "bad", citations: [OTHER_REAL_ID, "news.sentiment_score"] },
      ],
    });
    refuses(response, "citation_unknown");
  });

  it("refuses a citation to a plausible news id, since news was never collected", () => {
    const response = JSON.stringify({
      strategy: "dca",
      claims: [{ statement: "Sentiment is positive.", citations: ["news.sentiment"] }],
    });
    refuses(response, "citation_unknown");
  });
});

// ---------------------------------------------------------------------------
// Property 4: contradictions cannot parse cleanly
// ---------------------------------------------------------------------------

describe("duplicate keys", () => {
  it("refuses a response that names two strategies as two 'strategy' keys", () => {
    const raw = '{"strategy":"dca","claims":[{"statement":"x","citations":["candles.count"]}],"strategy":"grid"}';
    // Proof the hazard is real: JSON.parse resolves this to a clean object.
    expect((JSON.parse(raw) as { strategy: string }).strategy).toBe("grid");

    const error = refuses(raw, "duplicate_key");
    expect(error.received).toBe("strategy");
    expect(error.message).toContain("keeps the last value silently");
  });

  it("refuses a duplicate key nested inside a claim", () => {
    const raw =
      '{"strategy":"dca","claims":[{"statement":"x","citations":["candles.count"],"statement":"y"}]}';
    refuses(raw, "duplicate_key");
  });

  it("accepts the same citation id repeated within one claim -- a repeat is not a contradiction", () => {
    const raw = JSON.stringify({
      strategy: "dca",
      claims: [{ statement: "x", citations: [REAL_ID, REAL_ID, REAL_ID] }],
    });
    expect(parseAssessResponse(raw, prompt).claims[0]!.citations).toHaveLength(3);
  });

  it("does not confuse a repeated key in two SIBLING objects for a duplicate", () => {
    const raw = JSON.stringify({
      strategy: "dca",
      claims: [
        { statement: "one", citations: [REAL_ID] },
        { statement: "two", citations: [REAL_ID] },
      ],
    });
    expect(parseAssessResponse(raw, prompt).claims).toHaveLength(2);
  });
});

describe("findDuplicateKey", () => {
  it("returns null for well-formed JSON", () => {
    expect(findDuplicateKey('{"a":1,"b":{"a":2},"c":[{"a":3},{"a":4}]}')).toBeNull();
  });

  it("finds a duplicate at the top level", () => {
    expect(findDuplicateKey('{"a":1,"a":2}')).toBe("a");
  });

  it("finds a duplicate nested in an array element", () => {
    expect(findDuplicateKey('{"c":[{"a":3,"a":4}]}')).toBe("a");
  });

  it("is not fooled by braces, colons or commas inside string VALUES", () => {
    expect(findDuplicateKey('{"a":"{\\"a\\": 1, \\"a\\": 2}","b":2}')).toBeNull();
  });

  it("is not fooled by an escaped quote inside a value", () => {
    expect(findDuplicateKey('{"a":"he said \\"a\\" twice","b":2}')).toBeNull();
  });

  it("does not treat array string ELEMENTS as keys", () => {
    // Three elements, with the repeat NOT in first position, because a scanner
    // that lost its array/object distinction only starts recording after the
    // first comma -- so a two-element repeat would leave that bug alive.
    expect(findDuplicateKey('{"citations":["candles.count","candles.count","candles.count"]}')).toBeNull();
    expect(findDuplicateKey('{"citations":["a","b","b"]}')).toBeNull();
  });

  /**
   * THE KNOWN GAP, PINNED RATHER THAN LEFT TO BE DISCOVERED.
   *
   * Keys are compared in their source form, so a duplicate written with a
   * unicode escape is not detected. Closing it means implementing JSON string
   * unescaping, which is a second parser -- the thing `assess-parse.ts` refuses
   * to have. This test asserts the CURRENT behaviour so the gap is visible in
   * the suite; if someone later closes it, this test fails and they will find
   * the reasoning here rather than assuming a regression.
   */
  it("does NOT catch a duplicate written with a unicode escape (known gap)", () => {
    expect(findDuplicateKey('{"a":1,"\\u0061":2}')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The prompt is a required argument, not an optional one
// ---------------------------------------------------------------------------

describe("the grounding check cannot be skipped", () => {
  it("validates against the prompt it is given, not against a global vocabulary", () => {
    // A bundle with a failed candle fetch emits no `candles.count`, so a
    // response citing it must fail against THAT prompt even though it passes
    // against this file's main one.
    const otherPrompt = buildAssessPrompt({
      ...bundle,
      candles: {
        outcome: "failed",
        error: new CandleWindowError("candles_unavailable", "the venue did not answer"),
        failedAt: T0,
      },
    });
    expect(otherPrompt.evidenceIds).not.toContain("candles.count");

    expect(() =>
      parseAssessResponse(
        JSON.stringify({ strategy: "dca", claims: [{ statement: "x", citations: ["candles.count"] }] }),
        otherPrompt,
      ),
    ).toThrow(AssessParseError);

    // ... and the same response is fine against the prompt that DID emit it.
    expect(
      parseAssessResponse(
        JSON.stringify({ strategy: "dca", claims: [{ statement: "x", citations: ["candles.count"] }] }),
        prompt,
      ).strategy,
    ).toBe("dca");
  });
});
