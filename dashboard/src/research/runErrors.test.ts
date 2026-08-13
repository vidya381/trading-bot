/**
 * The error-surfacing branch: every refusal keeps its real code, and the stage
 * that produced it is never lost.
 *
 * Four properties, and the second is the one this file exists for:
 *
 *  1. THE REAL CODE IS ALWAYS ON THE RESULT. Every branch, including the default
 *     one, carries the backend's own `code`, `status` and `message`. There is no
 *     path through this module that produces a description with the code stripped
 *     out, and the exhaustive sweep below asserts it over every code these two
 *     endpoints can emit rather than over a chosen handful.
 *  2. ⚠ THE SAME CODE AT TWO STATUSES IS TWO DIFFERENT FACTS. `missing_field`,
 *     `unexpected_field`, `duplicate_key`, `strategy_not_recognised` and
 *     `citation_unknown` all appear BOTH in `envelope.ts`'s 4xx table (a bad
 *     REQUEST) and in the parsers' vocabulary re-thrown at 502 (a bad MODEL
 *     ANSWER). A description that reads the code alone reports one as the other.
 *  3. THE STAGE DECIDES WHETHER MONEY WAS ALREADY SPENT. A derive-stage failure
 *     always means an Assess inference was paid for; an assess-stage failure never
 *     does.
 *  4. IT NEVER THROWS. It runs on a path where something has already gone wrong,
 *     so it is driven over non-Error throwables too.
 *
 * Pure: no network, no model, no DOM.
 */

import { describe, expect, it } from "vitest";

import { describeRunFailure, readFailure, type RunStage } from "./runErrors";

const api = (code: string, message: string, status: number) => ({
  name: "ApiError",
  code,
  message,
  status,
});

/** Every code `/assess` or `/derive` can really put on the wire. */
const REAL_CODES: readonly (readonly [string, number])[] = [
  // Request faults (envelope.ts).
  ["missing_field", 400],
  ["invalid_field", 400],
  ["invalid_filter", 400],
  ["pair_not_tradable", 400],
  ["pair_not_spot_by_name", 400],
  ["instrument_not_spot", 400],
  ["interval_not_verified", 400],
  ["unknown_account", 404],
  ["strategy_not_recognised", 400],
  ["citation_unknown", 409],
  ["no_capital_headroom", 409],
  // Preconditions and dependencies.
  ["no_price_history", 503],
  ["tradable_set_unreadable", 503],
  ["capital_unreadable", 503],
  ["symbol_filters_unreadable", 503],
  ["no_ai_binding", 503],
  ["candles_unavailable", 502],
  ["no_candles_returned", 502],
  // The model answered unusably (parser and validator codes, re-thrown at 502).
  ["not_json", 502],
  ["claims_empty", 502],
  ["citation_unknown", 502],
  ["missing_field", 502],
  ["unexpected_field", 502],
  ["strategy_not_recognised", 502],
  ["duplicate_key", 502],
  ["strategy_disagreement", 502],
  ["allocated_capital_exceeds_headroom", 502],
  ["decoder/invalid_parameter", 502],
  ["strategy_validator/invalid_parameter", 502],
  ["sanity_bound/invalid_parameter", 502],
  // Transport.
  ["unauthenticated", 401],
  ["bad_response", 500],
];

const STAGES: readonly RunStage[] = ["assess", "derive"];

// ---------------------------------------------------------------------------

describe("⚠ the real code survives every branch", () => {
  it("puts the code, the status and the message on the result for EVERY real code", () => {
    for (const stage of STAGES) {
      for (const [code, status] of REAL_CODES) {
        const message = `the endpoint's own words about ${code}`;
        const failure = describeRunFailure(stage, api(code, message, status));
        expect(failure.code).toBe(code);
        expect(failure.status).toBe(status);
        expect(failure.message).toBe(message);
      }
    }
  });

  it("never produces an empty title, and always names the stage in it", () => {
    for (const stage of STAGES) {
      for (const [code, status] of REAL_CODES) {
        const failure = describeRunFailure(stage, api(code, status === 0 ? "" : "x", status));
        expect(failure.title.length).toBeGreaterThan(0);
        // Either the stage word, or a title that only one stage can produce.
        const named = /Assess|Derive/.test(failure.title);
        expect(named || failure.title.includes("Cloudflare Access")).toBe(true);
      }
    }
  });

  it("says an inference was already spent for exactly the derive stage, on every code", () => {
    for (const [code, status] of REAL_CODES) {
      expect(describeRunFailure("assess", api(code, "x", status)).assessAlreadySpent).toBe(false);
      expect(describeRunFailure("derive", api(code, "x", status)).assessAlreadySpent).toBe(true);
    }
  });

  it("tags every result with the stage it was given", () => {
    for (const stage of STAGES) {
      expect(describeRunFailure(stage, api("no_price_history", "x", 503)).stage).toBe(stage);
    }
  });
});

// ---------------------------------------------------------------------------

describe("⚠ THE STATUS COLLISION: the same code means two different things", () => {
  it("separates a bad REQUEST from a bad MODEL ANSWER for missing_field", () => {
    const request = describeRunFailure("assess", api("missing_field", "pair is required", 400));
    const model = describeRunFailure("assess", api("missing_field", "the answer had no claims", 502));

    expect(request.title).not.toBe(model.title);
    expect(request.title).toMatch(/request was rejected/);
    expect(model.title).toMatch(/model's answer was unusable/);
  });

  it("separates the STALE RESUBMISSION (409) from a model inventing an id (502)", () => {
    const stale = describeRunFailure("derive", api("citation_unknown", "not in this run", 409));
    const invented = describeRunFailure("derive", api("citation_unknown", "no such id", 502));

    expect(stale.title).toMatch(/no longer has/);
    expect(stale.tone).toBe("warning");
    // The stale one is expected drift and its copy says to run again.
    expect(stale.next).toMatch(/again/);

    expect(invented.title).toMatch(/model's answer was unusable/);
    expect(invented.tone).toBe("error");
    expect(invented.title).not.toBe(stale.title);
  });

  it("⚠ does NOT call a citation_unknown at a THIRD status expected drift", () => {
    // Found by a mutation run: dropping `status === 409` from that branch broke
    // nothing, because the 502 block above already handled the other meaning. It
    // is still load-bearing -- that branch is the only one in the file whose
    // advice is "this is normal, run it again", and a future fourth meaning of
    // this code must not inherit it. `envelope.ts` leaves `citation_unknown` out
    // of its status table on exactly this ground.
    const other = describeRunFailure("derive", api("citation_unknown", "some new meaning", 400));
    expect(other.code).toBe("citation_unknown");
    expect(other.title).not.toMatch(/no longer has/);
    expect(other.next).not.toMatch(/expected drift/);
    expect(other.title).toContain("400");
  });

  it("⚠ does not describe an ASSESS strategy_not_recognised as a resubmission fault", () => {
    // Also from a mutation run. `/assess` has no resubmission in it, so that
    // branch's copy would name a thing that does not exist on that call.
    const onAssess = describeRunFailure("assess", api("strategy_not_recognised", "x", 400));
    expect(onAssess.title).not.toMatch(/resubmitted assessment/);
    expect(onAssess.title).toMatch(/^Assess/);
    expect(onAssess.code).toBe("strategy_not_recognised");
  });

  it("separates a bad resubmitted strategy (400) from a model naming a third one (502)", () => {
    const resubmitted = describeRunFailure(
      "derive",
      api("strategy_not_recognised", "received \"scalp\"", 400),
    );
    const model = describeRunFailure(
      "derive",
      api("strategy_not_recognised", "received \"scalp\"", 502),
    );

    expect(resubmitted.title).toMatch(/resubmitted assessment/);
    expect(model.title).toMatch(/model's answer was unusable/);
  });

  it("separates duplicate_key and unexpected_field at 502 from the 4xx request table", () => {
    for (const code of ["duplicate_key", "unexpected_field"]) {
      const model = describeRunFailure("assess", api(code, "x", 502));
      expect(model.title).toMatch(/model's answer was unusable/);
      expect(model.code).toBe(code);
    }
  });
});

// ---------------------------------------------------------------------------

describe("DeriveValidationError's <layer>/<code> keeps the layer distinction", () => {
  it("names which layer refused, differently for each of the three", () => {
    const seen = new Set<string>();
    for (const layer of ["decoder", "strategy_validator", "sanity_bound"]) {
      const failure = describeRunFailure(
        "derive",
        api(`${layer}/invalid_parameter`, "upperBound below lowerBound", 502),
      );
      expect(failure.code).toBe(`${layer}/invalid_parameter`);
      seen.add(failure.title);
    }
    expect(seen.size).toBe(3);
  });

  it("distinguishes the real create-bot decoder from this stage's own sanity bound", () => {
    const decoder = describeRunFailure("derive", api("decoder/invalid_parameter", "x", 502));
    const sanity = describeRunFailure("derive", api("sanity_bound/invalid_parameter", "x", 502));
    expect(decoder.title).toMatch(/create-bot decoder/);
    expect(sanity.title).toMatch(/sanity bound/);
  });

  it("falls back to the plain model-answer description for an UNKNOWN layer prefix", () => {
    // A slash in a code this dashboard has never seen must not be guessed at.
    const failure = describeRunFailure("derive", api("something/else", "x", 502));
    expect(failure.code).toBe("something/else");
    expect(failure.title).toMatch(/model's answer was unusable/);
  });

  it("does not treat a leading slash as a layer", () => {
    const failure = describeRunFailure("derive", api("/decoder", "x", 502));
    expect(failure.title).toMatch(/model's answer was unusable/);
  });
});

// ---------------------------------------------------------------------------

describe("the request that never got an answer", () => {
  it("reports network_error as not-known-whether-it-ran, not as a refusal", () => {
    const failure = describeRunFailure("assess", api("network_error", "could not reach the API", 0));
    expect(failure.tone).toBe("warning");
    expect(failure.status).toBe(0);
    expect(failure.text).toMatch(/not known whether the call ran/);
  });

  it("warns that a derive-stage network failure has already cost an inference", () => {
    const failure = describeRunFailure("derive", api("network_error", "x", 0));
    expect(failure.assessAlreadySpent).toBe(true);
    expect(failure.next).toMatch(/already paid for/);
  });

  it("reports an expired Access session as exactly that", () => {
    const failure = describeRunFailure("assess", api("unauthenticated", "session expired", 401));
    expect(failure.title).toMatch(/Cloudflare Access session has expired/);
    expect(failure.next).toMatch(/Reload/);
  });
});

// ---------------------------------------------------------------------------

describe("an unrecognised code is reported IN FULL rather than swallowed", () => {
  it("puts the code and the status in the title and the message in the body", () => {
    const failure = describeRunFailure(
      "assess",
      api("a_code_this_dashboard_has_never_seen", "the endpoint's exact words", 418),
    );
    expect(failure.title).toContain("a_code_this_dashboard_has_never_seen");
    expect(failure.title).toContain("418");
    expect(failure.text).toBe("the endpoint's exact words");
  });

  it("says so plainly when the endpoint returned no message at all", () => {
    const failure = describeRunFailure("assess", api("weird_code", "", 500));
    expect(failure.text).toMatch(/returned no message/);
    expect(failure.code).toBe("weird_code");
  });

  it("never produces the words 'something went wrong'", () => {
    for (const stage of STAGES) {
      for (const [code, status] of [...REAL_CODES, ["unheard_of", 599] as const]) {
        const failure = describeRunFailure(stage, api(code, "m", status));
        const all = `${failure.title} ${failure.text} ${failure.next}`.toLowerCase();
        expect(all).not.toContain("something went wrong");
      }
    }
  });
});

// ---------------------------------------------------------------------------

describe("readFailure, on things that are not ApiError", () => {
  it("reads an ApiError-shaped object structurally, without importing the class", () => {
    expect(readFailure(api("pair_not_tradable", "nope", 400))).toEqual({
      code: "pair_not_tradable",
      message: "nope",
      status: 400,
    });
  });

  it("reports a plain Error as itself at status 0", () => {
    expect(readFailure(new Error("a dashboard bug"))).toEqual({
      code: "",
      message: "a dashboard bug",
      status: 0,
    });
  });

  it("does not mistake an object with a code but NO status for an ApiError", () => {
    expect(readFailure({ code: "looks_like_one" })).toEqual({
      code: "",
      message: "[object Object]",
      status: 0,
    });
  });

  it("survives a thrown string, a thrown null and a thrown number", () => {
    expect(readFailure("just a string").message).toBe("just a string");
    expect(readFailure(null).message).toBe("null");
    expect(readFailure(42).message).toBe("42");
  });

  it("uses an empty message when an ApiError-shaped object has a non-string message", () => {
    expect(readFailure({ code: "c", message: 7, status: 400 }).message).toBe("");
  });
});

describe("describeRunFailure never throws, whatever it is handed", () => {
  it("survives every non-Error throwable", () => {
    for (const thrown of [null, undefined, 0, "", "text", [], {}, new Error("e"), Symbol("s")]) {
      for (const stage of STAGES) {
        expect(() => describeRunFailure(stage, thrown)).not.toThrow();
      }
    }
  });
});
