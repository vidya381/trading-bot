/**
 * `GET /api/proposals`' filters and paging, driven directly.
 *
 * These are the cases an end-to-end HTTP test is the wrong instrument for: six
 * spellings of a bad `limit` are six assertions against a function, not six round
 * trips against a database. `api.test.ts` still drives the endpoint for the wiring
 * and for the real SQL; this file owns the boundaries.
 */

import { describe, expect, it } from "vitest";
import {
  DEFAULT_PROPOSAL_LIMIT,
  MAX_PROPOSAL_LIMIT,
  PENDING_OUTCOME,
  PROPOSAL_OUTCOME_FILTERS,
  parseProposalQuery,
  proposalListWhere,
  proposalPage,
  type ProposalQuery,
} from "./proposal-query";
import { PROPOSAL_OUTCOMES, PROPOSAL_STAGES } from "../db/schema";

function parse(query: string) {
  return parseProposalQuery(new URLSearchParams(query));
}

function ok(query: string): ProposalQuery {
  const parsed = parse(query);
  if (!parsed.ok) throw new Error(`expected ${JSON.stringify(query)} to parse: ${parsed.message}`);
  return parsed.query;
}

function refusal(query: string): string {
  const parsed = parse(query);
  if (parsed.ok) throw new Error(`expected ${JSON.stringify(query)} to be refused`);
  expect(parsed.code).toBe("invalid_filter");
  return parsed.message;
}

describe("defaults", () => {
  it("no parameters means no filters and the first page", () => {
    expect(ok("")).toEqual({
      accountLabel: null,
      stage: null,
      outcome: null,
      limit: DEFAULT_PROPOSAL_LIMIT,
      offset: 0,
    });
  });

  it("the default page size is a page a human reads, not the maximum", () => {
    // If these were equal, "a caller may ask for more" would be meaningless and the
    // cap would be doing no work.
    expect(DEFAULT_PROPOSAL_LIMIT).toBeLessThan(MAX_PROPOSAL_LIMIT);
    expect(DEFAULT_PROPOSAL_LIMIT).toBeGreaterThan(0);
  });
});

describe("the closed enumerations refuse an unrecognised value rather than ignoring it", () => {
  it("accepts each real stage", () => {
    for (const stage of PROPOSAL_STAGES) {
      expect(ok(`stage=${stage}`).stage).toBe(stage);
    }
  });

  it("refuses a stage the column cannot hold", () => {
    /*
     * `listAlerts`' rule and its stated reason: a typo returning "nothing matched"
     * is indistinguishable from a real empty result, and the caller cannot tell.
     * `gather` is a plausible typo here precisely because `/gather` is a real
     * endpoint that deliberately writes NO row (migration 0009).
     */
    expect(refusal("stage=gather")).toContain("assess, derive");
    refusal("stage=");
    refusal("stage=Derive");
  });

  it("accepts each real outcome", () => {
    for (const outcome of PROPOSAL_OUTCOMES) {
      expect(ok(`outcome=${outcome}`).outcome).toBe(outcome);
    }
  });

  it("⚠ accepts `pending`, which is not a value the column can hold", () => {
    /*
     * THE FILTER 21.5 REQUIREMENT 5 EXISTS FOR. Migration 0009: *"`outcome IS NULL`
     * IS 21.5's 'ignored', read after the fact"*, and `idx_proposals_unresolved` is
     * the partial index that exists to count it. A history view that could filter to
     * `approved` and `rejected` but not to the rows in between would omit the one
     * question the table was built to answer — "the system kept proposing things
     * nobody wanted".
     */
    expect(ok(`outcome=${PENDING_OUTCOME}`).outcome).toBe(PENDING_OUTCOME);
    expect(PROPOSAL_OUTCOME_FILTERS).toEqual([...PROPOSAL_OUTCOMES, PENDING_OUTCOME]);
  });

  it("⚠ refuses `ignored`, the word migration 0009 refuses to store", () => {
    /*
     * 21.5 names three outcomes and this system stores two, because "ignored" is an
     * ABSENCE and nothing observes a human failing to act. Accepting the word here
     * would put it back into the vocabulary at the one layer a reader meets, and a
     * filter that answered to it would imply a stored value behind it.
     */
    const message = refusal("outcome=ignored");
    expect(message).toContain(PENDING_OUTCOME);
    expect(message).toContain("NULL");
  });

  it("refuses other near-misses", () => {
    refusal("outcome=");
    refusal("outcome=Approved");
    refusal("outcome=null");
  });
});

describe("accountLabel", () => {
  it("passes a real label through, trimmed", () => {
    expect(ok("accountLabel=gemini-main").accountLabel).toBe("gemini-main");
    expect(ok("accountLabel=%20gemini-main%20").accountLabel).toBe("gemini-main");
  });

  it("refuses an empty one rather than treating it as no filter", () => {
    // An empty filter is not the same request as no filter, and guessing which was
    // meant is what `researchParams` refuses one layer up.
    expect(refusal("accountLabel=")).toContain("omit it");
    refusal("accountLabel=%20%20");
  });

  it("⚠ does NOT require the account to still be registered", () => {
    /*
     * A DELIBERATE DIVERGENCE FROM `listWatchlist`, which 404s an unknown label.
     * The difference is a live set versus a permanent record: section 8.7 keeps
     * every proposal forever, an account can be de-registered, and a 404 driven by
     * today's registry would hide history that is deliberately undeletable.
     */
    expect(ok("accountLabel=an-account-retired-last-year").accountLabel).toBe(
      "an-account-retired-last-year",
    );
  });
});

describe("⚠ limit and offset are parsed strictly, and each rejected shape is a real one", () => {
  it("accepts a plain integer inside the bounds", () => {
    expect(ok("limit=1").limit).toBe(1);
    expect(ok("limit=50").limit).toBe(50);
    expect(ok(`limit=${MAX_PROPOSAL_LIMIT}`).limit).toBe(MAX_PROPOSAL_LIMIT);
    expect(ok("offset=0").offset).toBe(0);
    expect(ok("offset=1000").offset).toBe(1000);
  });

  it("refuses an empty value, which `Number(\"\")` would read as 0", () => {
    refusal("limit=");
    refusal("offset=");
  });

  it("refuses a float, which `Number(\"1.5\")` would happily return", () => {
    refusal("limit=1.5");
    refusal("offset=2.5");
  });

  it("⚠ refuses exponent notation AT THE PARSE, not merely at the cap", () => {
    /*
     * THE ONE THAT WAS PASSING FOR THE WRONG REASON. The first version of this test
     * asserted only `refusal("limit=1e3")` and it passed — but `Number("1e3")` is
     * exactly 1000, `Number.isInteger(1000)` is true, and it was the CAP refusing
     * it, not the parse. `offset` has no cap, so the same hole there had nothing
     * behind it and `offset=1e3` was accepted outright.
     *
     * Pinned at a value INSIDE the cap so only the parse can refuse it, and on
     * `offset` where no cap exists at all. Decision logs 45, 46, 48 and 49 each
     * record an instance of a test passing for a reason other than the one it
     * states; this is another, and it was found by its own sister test in the
     * dashboard rather than by review.
     */
    refusal("limit=1e1"); // 10 — well inside the cap of 100.
    refusal("offset=1e3");
    refusal("limit=5.0");
    refusal("limit=%2B5"); // "+5"
    refusal("limit=0x10");
  });

  it("refuses an integer past 2^53, where the arithmetic stops being exact", () => {
    // All digits, so the text match alone would pass it. `columns.ts` enforces the
    // same bound on every integer column.
    refusal("offset=99999999999999999999");
  });

  it("refuses a negative value", () => {
    refusal("limit=-1");
    refusal("offset=-1");
  });

  it("refuses text and other non-numbers", () => {
    refusal("limit=all");
    refusal("limit=NaN");
    refusal("limit=Infinity");
    refusal("offset=first");
  });

  it("⚠ refuses limit=0 rather than returning an empty page", () => {
    // A page of nothing cannot page forward, and it reports "no proposals" about a
    // table that may be full of them.
    expect(refusal("limit=0")).toContain("at least 1");
  });

  it("⚠ refuses a limit above the cap rather than silently clamping it", () => {
    /*
     * THE ASSERTION WORTH READING TWICE. A clamped page returns 100 rows to a caller
     * who asked for 500 and believes it has them all — a wrong answer wearing the
     * shape of a right one — and paging on from `offset=500` would then skip 400
     * records that were never shown. Saying so costs one 400 and no data.
     */
    const message = refusal(`limit=${MAX_PROPOSAL_LIMIT + 1}`);
    expect(message).toContain("refused rather than clamped");
    refusal("limit=1000");
  });

  it("has no upper bound on offset, because paging past the end is not an error", () => {
    // An offset beyond the table returns an empty page with a real `total`, which is
    // the correct answer to "show me page 900" and is how a reader discovers there
    // is no page 900.
    expect(ok("offset=999999").offset).toBe(999_999);
  });
});

describe("proposalListWhere", () => {
  it("an unfiltered query has no keys at all", () => {
    // Not `undefined` values: "the key is not there" is the property, so a filter
    // cannot be half-applied by a value that stringifies to nothing.
    expect(proposalListWhere(ok(""))).toEqual({});
    expect(Object.keys(proposalListWhere(ok("")))).toEqual([]);
  });

  it("maps camelCase filters onto the real column names", () => {
    expect(proposalListWhere(ok("accountLabel=gemini-main&stage=derive"))).toEqual({
      account_label: "gemini-main",
      stage: "derive",
    });
  });

  it("passes a real outcome through as a column value", () => {
    expect(proposalListWhere(ok("outcome=approved"))).toEqual({ outcome: "approved" });
    expect(proposalListWhere(ok("outcome=rejected"))).toEqual({ outcome: "rejected" });
  });

  it("⚠ turns `pending` into a NULL comparison, never into the string \"pending\"", () => {
    /*
     * THE MECHANISM. `Repository.#where` spells `IS NULL` as a bare `null` value on
     * a nullable column. If `pending` reached the column encoder as a string it
     * would be bound as a literal and match nothing — an empty page reported about
     * every unresolved proposal in the table, with no error anywhere.
     */
    const where = proposalListWhere(ok(`outcome=${PENDING_OUTCOME}`));
    expect(where).toEqual({ outcome: null });
    expect(where.outcome).not.toBe(PENDING_OUTCOME);
    expect(Object.hasOwn(where, "outcome")).toBe(true);
  });

  it("combines all three", () => {
    expect(
      proposalListWhere(ok(`accountLabel=gemini-main&stage=assess&outcome=${PENDING_OUTCOME}`)),
    ).toEqual({ account_label: "gemini-main", stage: "assess", outcome: null });
  });
});

describe("⚠ proposalPage", () => {
  it("reports the page it was asked for and the total behind it", () => {
    const page = proposalPage(ok("limit=25&offset=50"), 312, 25);
    expect(page).toEqual({ limit: 25, offset: 50, total: 312, returned: 25, hasMore: true });
  });

  it("⚠ computes hasMore from what came back, not from the limit asked for", () => {
    /*
     * ⚠ THIS TEST'S FIRST VERSION WAS PASSING WITHOUT DISCRIMINATING, AND A MUTANT
     * PROVED IT. Recorded here rather than quietly rewritten, because it is the
     * pattern decision logs 45, 46, 48 and 49 each record an instance of.
     *
     * The original three cases were `(312, 12) @300`, `(325, 25) @300` and
     * `(325, 25) @299` — and `offset + limit` gives the SAME answer as
     * `offset + returned` on all three. The test asserted the right property against
     * inputs that could not tell the two formulas apart, so mutant Q1 (which swapped
     * one for the other) SURVIVED while a test named for catching it was green.
     *
     * The two formulas differ on exactly one region, and it is a real one: a page
     * that comes back SHORTER than the limit while more rows still match, i.e.
     * `offset + returned < total <= offset + limit`. There the wrong formula reports
     * "you have reached the end" while `total` on screen says otherwise, hiding the
     * remaining rows behind a disabled next button. `total` is a second query at a
     * slightly different instant from the page read, so the two really can disagree.
     *
     * The first assertion below is that case, and it is the only one here that
     * catches Q1. The rest are kept because they pin ordinary behaviour.
     */
    // THE DISCRIMINATING CASE: 10 rows came back of a possible 25, and 20 match.
    // Correct: 0 + 10 < 20 → there is more. `offset + limit`: 0 + 25 < 20 → false.
    expect(proposalPage(ok("limit=25&offset=0"), 20, 10).hasMore).toBe(true);
    // A second one, away from offset 0.
    expect(proposalPage(ok("limit=25&offset=50"), 90, 30).hasMore).toBe(true);

    // Ordinary behaviour, kept: a short last page and two full pages.
    expect(proposalPage(ok("limit=25&offset=300"), 312, 12).hasMore).toBe(false);
    expect(proposalPage(ok("limit=25&offset=300"), 325, 25).hasMore).toBe(false);
    expect(proposalPage(ok("limit=25&offset=299"), 325, 25).hasMore).toBe(true);
  });

  it("an empty table has no more pages", () => {
    expect(proposalPage(ok(""), 0, 0)).toEqual({
      limit: DEFAULT_PROPOSAL_LIMIT,
      offset: 0,
      total: 0,
      returned: 0,
      hasMore: false,
    });
  });

  it("an offset past the end reports the real total and no more pages", () => {
    // How a reader discovers there is no page 900, rather than being told nothing.
    const page = proposalPage(ok("offset=999999"), 312, 0);
    expect(page.total).toBe(312);
    expect(page.returned).toBe(0);
    expect(page.hasMore).toBe(false);
  });

  it("a single full page that is the whole table has no more", () => {
    expect(proposalPage(ok("limit=25&offset=0"), 25, 25).hasMore).toBe(false);
  });

  it("a single full page with one row behind it has more", () => {
    expect(proposalPage(ok("limit=25&offset=0"), 26, 25).hasMore).toBe(true);
  });
});
