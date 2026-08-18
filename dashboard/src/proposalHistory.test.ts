/**
 * The proposal history view's decisions, driven directly.
 *
 * Everything the list page decides lives in `proposalHistory.ts` for the reason a
 * mutation run established in decision log 45: a decision living in a `.tsx` is
 * reachable by no test in this repository. So the filters, the paging arithmetic
 * and the row labels are here, and `pages/ProposalHistory.tsx` maps over what they
 * return.
 */

import { describe, expect, it } from "vitest";
import {
  HISTORY_OUTCOMES,
  HISTORY_PAGE_SIZE,
  HISTORY_STAGES,
  OUTCOME_CLASS,
  OUTCOME_LABEL,
  RERUN_HREF,
  historyFetchArgs,
  historyFiltersFrom,
  historyKey,
  historyOffsetFrom,
  historyPagination,
  historyQueryFrom,
  historyRowOf,
  outcomeDisplayOf,
  proposalRecordHref,
  rerunHref,
  withHistoryFilter,
  withHistoryOffset,
} from "./proposalHistory";
import type { ProposalPageInfo, ProposalRecordSummary } from "./api/research-types";

const T0 = 1_786_000_000_000;

function record(overrides: Partial<ProposalRecordSummary> = {}): ProposalRecordSummary {
  return {
    id: "prop-live-1",
    stage: "derive",
    accountLabel: "gemini-main",
    pair: "BTCUSD",
    entryPoint: "named",
    strategy: "grid",
    actor: "d.vidya381@gmail.com",
    model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    promptVersion: "derive/1",
    dataFetchedAt: T0 - 30_000,
    createdAt: T0,
    outcome: null,
    outcomeBotInstanceId: null,
    outcomeActor: null,
    outcomeAt: null,
    outcomeNote: null,
    pendingMs: null,
    ...overrides,
  };
}

function page(overrides: Partial<ProposalPageInfo> = {}): ProposalPageInfo {
  return { limit: 25, offset: 0, total: 0, returned: 0, hasMore: false, ...overrides };
}

function params(query: string): URLSearchParams {
  return new URLSearchParams(query);
}

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

describe("historyFiltersFrom", () => {
  it("an empty URL is an unfiltered view", () => {
    expect(historyFiltersFrom(params(""))).toEqual({
      accountLabel: null,
      stage: null,
      outcome: null,
    });
  });

  it("keeps every value the backend accepts", () => {
    for (const stage of HISTORY_STAGES) {
      expect(historyFiltersFrom(params(`stage=${stage}`)).stage).toBe(stage);
    }
    for (const outcome of HISTORY_OUTCOMES) {
      expect(historyFiltersFrom(params(`outcome=${outcome}`)).outcome).toBe(outcome);
    }
    expect(historyFiltersFrom(params("accountLabel=gemini-main")).accountLabel).toBe("gemini-main");
  });

  it("⚠ includes `pending`, the filter 21.5 requirement 5 exists for", () => {
    /*
     * Migration 0009: *"`outcome IS NULL` IS 21.5's 'ignored', read after the
     * fact"*, and `idx_proposals_unresolved` is the partial index that exists to
     * count it. A history view that could filter to `approved` and `rejected` but
     * not to the rows in between would omit the one question the table was built to
     * answer — "the system kept proposing things nobody wanted".
     */
    expect(HISTORY_OUTCOMES).toContain("pending");
    expect(historyFiltersFrom(params("outcome=pending")).outcome).toBe("pending");
  });

  it("⚠ DROPS an unrecognised value rather than sending it", () => {
    /*
     * The copy of the backend's vocabulary fails SAFE. The worst outcome of drift
     * between the two lists is an unfiltered page — never a 400 on load, and never
     * a filter the reader believes is applied and is not, because the select shows
     * "All" for a null. The backend is still the guard; this is the affordance.
     */
    expect(historyFiltersFrom(params("stage=gather")).stage).toBeNull();
    expect(historyFiltersFrom(params("outcome=ignored")).outcome).toBeNull();
    expect(historyFiltersFrom(params("stage=Derive")).stage).toBeNull();
  });

  it("treats an empty or whitespace accountLabel as no filter", () => {
    // The backend refuses an empty one outright (an empty filter is not the same
    // request as no filter), so sending one would be a 400 on load.
    expect(historyFiltersFrom(params("accountLabel=")).accountLabel).toBeNull();
    expect(historyFiltersFrom(params("accountLabel=%20%20")).accountLabel).toBeNull();
  });

  it("trims a real accountLabel", () => {
    expect(historyFiltersFrom(params("accountLabel=%20gemini-main%20")).accountLabel).toBe(
      "gemini-main",
    );
  });
});

describe("historyOffsetFrom", () => {
  it("defaults to the first page", () => {
    expect(historyOffsetFrom(params(""))).toBe(0);
  });

  it("reads a real non-negative integer", () => {
    expect(historyOffsetFrom(params("offset=0"))).toBe(0);
    expect(historyOffsetFrom(params("offset=50"))).toBe(50);
  });

  it("⚠ refuses every shape a bare Number() would have accepted", () => {
    /*
     * `Number("")` is 0, `Number("1.5")` is 1.5 and `Number("1e3")` is 1000. Sending
     * any of those to a backend that refuses them turns a mistyped URL into a 400 on
     * load rather than a first page.
     */
    for (const bad of ["offset=", "offset=1.5", "offset=1e3", "offset=-1", "offset=first", "offset=NaN"]) {
      expect(historyOffsetFrom(params(bad)), bad).toBe(0);
    }
  });
});

describe("historyFetchArgs", () => {
  it("sends no filter keys at all when nothing is filtered", () => {
    const args = historyFetchArgs(historyQueryFrom(params("")));
    expect(args).toEqual({ limit: HISTORY_PAGE_SIZE, offset: 0 });
    expect(Object.hasOwn(args, "accountLabel")).toBe(false);
    expect(Object.hasOwn(args, "stage")).toBe(false);
    expect(Object.hasOwn(args, "outcome")).toBe(false);
  });

  it("sends every filter that is set", () => {
    expect(
      historyFetchArgs(historyQueryFrom(params("accountLabel=gemini-main&stage=derive&outcome=pending&offset=50"))),
    ).toEqual({
      accountLabel: "gemini-main",
      stage: "derive",
      outcome: "pending",
      limit: HISTORY_PAGE_SIZE,
      offset: 50,
    });
  });

  it("asks for a page size well inside the backend's maximum", () => {
    // The backend REFUSES an oversized limit rather than clamping it, so a page
    // size that drifted past the cap would 400 on load rather than degrade.
    expect(HISTORY_PAGE_SIZE).toBeGreaterThan(0);
    expect(HISTORY_PAGE_SIZE).toBeLessThanOrEqual(100);
  });
});

describe("historyKey", () => {
  it("changes when any part of the query changes", () => {
    const base = historyKey(historyQueryFrom(params("")));
    expect(historyKey(historyQueryFrom(params("stage=derive")))).not.toBe(base);
    expect(historyKey(historyQueryFrom(params("outcome=pending")))).not.toBe(base);
    expect(historyKey(historyQueryFrom(params("accountLabel=a")))).not.toBe(base);
    expect(historyKey(historyQueryFrom(params("offset=25")))).not.toBe(base);
  });

  it("is stable for the same query written two ways", () => {
    expect(historyKey(historyQueryFrom(params("stage=derive&outcome=pending")))).toBe(
      historyKey(historyQueryFrom(params("outcome=pending&stage=derive"))),
    );
  });
});

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

describe("withHistoryFilter", () => {
  it("sets a filter and clears it with an empty value", () => {
    expect(withHistoryFilter(params(""), "stage", "derive").toString()).toBe("stage=derive");
    expect(withHistoryFilter(params("stage=derive"), "stage", "").toString()).toBe("");
  });

  it("⚠ resets the offset, so narrowing a filter never lands on an empty page", () => {
    /*
     * THE CLASSIC BUG IN THIS SHAPE. A reader on page 5 of 312 who narrows to one
     * account with 3 records would land on page 5 of 3 and see an empty table —
     * which reads as "this account has no proposals" about an account that has
     * three, and there is nothing on screen to say otherwise.
     */
    const next = withHistoryFilter(params("offset=100&stage=derive"), "accountLabel", "gemini-main");
    expect(next.get("offset")).toBeNull();
    expect(next.get("accountLabel")).toBe("gemini-main");
    expect(next.get("stage")).toBe("derive");

    // Including when the filter is being CLEARED, which widens the set and can
    // still leave the old offset pointing past a shorter one in the other order.
    expect(withHistoryFilter(params("offset=100&stage=derive"), "stage", "").get("offset")).toBeNull();
  });

  it("leaves the other filters alone", () => {
    const next = withHistoryFilter(params("stage=derive&outcome=pending"), "stage", "assess");
    expect(next.get("stage")).toBe("assess");
    expect(next.get("outcome")).toBe("pending");
  });
});

describe("withHistoryOffset", () => {
  it("omits the first page's offset rather than writing offset=0", () => {
    // A clean URL for the default view, and it round-trips: `historyOffsetFrom`
    // reads an absent offset as 0.
    expect(withHistoryOffset(params("offset=25"), 0).toString()).toBe("");
    expect(withHistoryOffset(params(""), 0).toString()).toBe("");
  });

  it("writes a real offset and keeps the filters", () => {
    const next = withHistoryOffset(params("stage=derive"), 50);
    expect(next.get("offset")).toBe("50");
    expect(next.get("stage")).toBe("derive");
  });

  it("treats a negative offset as the first page", () => {
    expect(withHistoryOffset(params(""), -25).toString()).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

describe("historyPagination", () => {
  it("describes a first page of many", () => {
    expect(historyPagination(page({ total: 312, returned: 25, hasMore: true }))).toEqual({
      page: 1,
      pages: 13,
      from: 1,
      to: 25,
      total: 312,
      hasPrevious: false,
      hasNext: true,
      previousOffset: 0,
      nextOffset: 25,
      summary: "1–25 of 312",
    });
  });

  it("describes a middle page", () => {
    const info = historyPagination(page({ offset: 50, total: 312, returned: 25, hasMore: true }));
    expect(info.page).toBe(3);
    expect(info.summary).toBe("51–75 of 312");
    expect(info.hasPrevious).toBe(true);
    expect(info.previousOffset).toBe(25);
    expect(info.nextOffset).toBe(75);
  });

  it("describes a short last page", () => {
    const info = historyPagination(page({ offset: 300, total: 312, returned: 12, hasMore: false }));
    expect(info).toMatchObject({
      page: 13,
      pages: 13,
      from: 301,
      to: 312,
      hasNext: false,
      summary: "301–312 of 312",
    });
  });

  it("⚠ takes hasNext from the BACKEND rather than recomputing it", () => {
    /*
     * The backend computes it from `offset + returned < total` — what actually came
     * back, not what was asked for — and the two formulas differ on exactly the case
     * that occurs on every complete browse: the last page. A second implementation
     * here would be a duplicate whose failure mode is a next button that returns
     * nothing, which is the class `proposalSummary.ts` refuses for concentration.
     *
     * Driven with a `hasMore` that DISAGREES with what a local recomputation would
     * produce, so a version that recomputed would fail here.
     */
    expect(historyPagination(page({ offset: 0, total: 100, returned: 25, hasMore: false })).hasNext).toBe(
      false,
    );
    expect(historyPagination(page({ offset: 0, total: 25, returned: 25, hasMore: true })).hasNext).toBe(
      true,
    );
  });

  it("describes an empty table honestly", () => {
    const info = historyPagination(page({ total: 0, returned: 0 }));
    expect(info.summary).toBe("no proposals");
    expect(info.pages).toBe(1);
    expect(info.from).toBe(0);
    expect(info.to).toBe(0);
    expect(info.hasPrevious).toBe(false);
    expect(info.hasNext).toBe(false);
  });

  it("⚠ distinguishes an empty TABLE from an empty PAGE past the end", () => {
    // "No proposals match" and "you have paged past the end of 312 that do" are
    // different facts, and a reader who sees the first about the second concludes
    // the filter found nothing.
    const past = historyPagination(page({ offset: 999, total: 312, returned: 0, hasMore: false }));
    expect(past.summary).toBe("no proposals on this page — 312 in total");
    expect(past.total).toBe(312);
    expect(past.hasPrevious).toBe(true);
  });

  it("never reports zero pages, so a pager always has a page 1", () => {
    expect(historyPagination(page({ total: 0 })).pages).toBe(1);
    expect(historyPagination(page({ total: 1, returned: 1 })).pages).toBe(1);
    expect(historyPagination(page({ total: 26, returned: 25, hasMore: true })).pages).toBe(2);
  });

  it("survives a limit of zero without dividing by it", () => {
    // Unreachable through this dashboard (the backend refuses limit=0), but the
    // arithmetic must not produce Infinity or NaN if it ever arrives.
    const info = historyPagination(page({ limit: 0, total: 10, returned: 0 }));
    expect(Number.isFinite(info.pages)).toBe(true);
    expect(Number.isFinite(info.page)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

describe("outcomeDisplayOf", () => {
  it("reads the three states", () => {
    expect(outcomeDisplayOf(record({ outcome: null }))).toBe("pending");
    expect(outcomeDisplayOf(record({ outcome: "approved" }))).toBe("approved");
    expect(outcomeDisplayOf(record({ outcome: "rejected" }))).toBe("rejected");
  });

  it("⚠ tests `outcome !== null` FIRST, so an unrecognised value is not read as pending", () => {
    /*
     * `concentrationVerdictOf`'s ordering rule, for its reason: the fail-safe
     * direction is the one that does not report an unresolved proposal about a
     * resolved one. A future third outcome value would show as a recorded decision
     * rather than joining the "nobody acted" count — which is the signal 21.5
     * exists to produce and must not be inflated by a value nobody has mapped yet.
     */
    const strange = record({ outcome: "withdrawn" as never });
    expect(outcomeDisplayOf(strange)).not.toBe("pending");
  });

  it("⚠ pending has a word and a colour of its own, not an empty cell", () => {
    /*
     * Decision log 49 PART 3's pattern: an unestablished state rendering as an
     * established one, or as nothing at all. "Nobody acted" is the finding, not the
     * absence of one, so it is amber rather than grey and it says "no decision".
     */
    expect(OUTCOME_LABEL.pending).toBe("no decision");
    expect(OUTCOME_LABEL.pending).not.toBe("");
    expect(OUTCOME_CLASS.pending).toContain("amber");
    expect(OUTCOME_CLASS.pending).not.toBe(OUTCOME_CLASS.rejected);
  });
});

describe("historyRowOf", () => {
  it("renders a pending row with its age and no pending duration", () => {
    const row = historyRowOf(record(), T0 + 3 * 60_000);
    expect(row.outcome).toBe("pending");
    expect(row.outcomeLabel).toBe("no decision");
    expect(row.pendingLabel).toBeNull();
    expect(row.ageLabel).toBe("3m 0s");
    expect(row.botInstanceId).toBeNull();
    expect(row.href).toBe("/proposals/prop-live-1");
  });

  it("⚠ renders a resolved row's pendingMs from the RECORD, never recomputed", () => {
    /*
     * `outcome_at - created_at` is the record's own arithmetic, published by the
     * backend. A second computation here could disagree with the figure the detail
     * page shows about the same proposal, and the reader would have no way to know
     * which was right. Decision log 48 measured a real one at 38,669 ms and entry 45
     * measured a real one at 28,013,070 ms; both are driven here.
     */
    const quick = historyRowOf(
      record({ outcome: "approved", outcomeBotInstanceId: "bot-9wzfci", pendingMs: 38_669 }),
      T0,
    );
    expect(quick.pendingLabel).toBe("38s");
    expect(quick.botInstanceId).toBe("bot-9wzfci");

    // Entry 45's real 7h 46m gap, unstaged when it was measured.
    const slow = historyRowOf(record({ outcome: "approved", pendingMs: 28_013_070 }), T0);
    expect(slow.pendingLabel).toBe("7h 46m");
  });

  it("carries the identifying facts a reader scans for", () => {
    const row = historyRowOf(record({ stage: "assess", strategy: "dca", pair: "ETHUSD" }), T0);
    expect(row).toMatchObject({
      pair: "ETHUSD",
      stage: "assess",
      strategy: "dca",
      accountLabel: "gemini-main",
    });
  });

  it("escapes an id in the link rather than interpolating it raw", () => {
    expect(proposalRecordHref("a/b?c")).toBe("/proposals/a%2Fb%3Fc");
  });
});

describe("⚠ rerunHref", () => {
  it("offers a fresh run for a pending proposal", () => {
    expect(rerunHref(record({ outcome: null }))).toBe(RERUN_HREF);
  });

  it("offers nothing for a resolved one", () => {
    // The decision is made and this system will not record a second one:
    // `outcome IS NULL` is in the UPDATE's WHERE clause.
    expect(rerunHref(record({ outcome: "approved" }))).toBeNull();
    expect(rerunHref(record({ outcome: "rejected" }))).toBeNull();
  });

  it("⚠ carries NO query parameters, because the run page reads none", () => {
    /*
     * `pages/ProposalRun.tsx` starts its account, pair and interval at `useState("")`
     * and never reads `useSearchParams`. A prefill-looking URL that lands on an
     * empty form is a field accepted and ignored — the fault
     * `parseResubmittedAssessment` refuses an object citation over, in its own
     * words: *"a field accepted and ignored reads exactly like one that was used."*
     */
    expect(RERUN_HREF).not.toContain("?");
    expect(rerunHref(record())).not.toContain("=");
  });

  it("⚠ is a link to a form, never an action", () => {
    // It leads to the page that states the cost — two paid inferences and two
    // permanent rows per press — and requires a deliberate press there.
    expect(rerunHref(record())).toBe("/proposal/run");
  });
});
