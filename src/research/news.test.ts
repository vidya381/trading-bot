/**
 * The 21.4 Stage 1 news fetch: coverage, refusal, and the sentiment verbatim.
 *
 * Five properties, each one this module would look correct without:
 *
 *  1. "NOT COVERED" AND "COVERED, NOTHING PUBLISHED" ARE DIFFERENT ANSWERS.
 *     21.7's open question 2 is the whole reason this file's shape is what it
 *     is: "if coverage is empty, that is a fact the proposal must state, not a
 *     gap to paper over". A version returning `articles: []` for both would
 *     pass every other assertion here, so the distinction is asserted directly
 *     AND made unrepresentable in the type.
 *  2. A SPELLING DIFFERENCE IS NEVER REPORTED AS NO COVERAGE. The dangerous
 *     failure is not an error; it is a confident, false "nobody is writing
 *     about this coin" caused by "btc" not matching "BTC".
 *  3. THE SENTIMENT COMES BACK AS THE VENDOR WROTE IT. It is the field 21.4
 *     chose this vendor for, so an article missing it fails the fetch, and a
 *     label this code does not recognise is carried and counted rather than
 *     rounded to NEUTRAL.
 *  4. IT FAILS CLOSED, EVERY WAY. A failed call, an error envelope beside a
 *     200, an unreadable payload -- none of them yields an empty result.
 *  5. NOTHING IS CACHED. 21.5 requirement 4 times a proposal from its fetch
 *     moment; a second call must really go and ask again.
 *
 * The vendor is a stub throughout. NOTHING IN THIS REPOSITORY HAS EVER CALLED
 * COINDESK, this project holds no CoinDesk key, and the payload shapes below
 * are the SAME ASSUMPTION the module encodes -- written by the session that
 * wrote the module. They prove the module handles the shape it believes in;
 * they cannot prove the belief. That is what a live run is for.
 */

import { describe, expect, it } from "vitest";

import {
  COINDESK_WIRE_FIELDS,
  DEFAULT_ARTICLE_LIMIT,
  MAX_ARTICLES,
  NewsSentimentError,
  fetchNewsSentiment,
  type NewsSentimentPorts,
  type NewsSentimentResult,
} from "./news";
import type { ExchangeOutcome } from "../shared/downtime";
import type { NewsQuery } from "../workers/news";

const CATEGORIES_AT = 1_910_000_000_000;
const ARTICLES_AT = 1_910_000_005_000;
/** 2030-07-11T00:00:00Z in unix SECONDS, which is what the vendor is assumed to send. */
const PUBLISHED_S = 1_910_000_000;

/** A category-list row in the shape the module assumes. */
function categoryRow(name: string): Record<string, unknown> {
  return { TYPE: "121", ID: 1, [COINDESK_WIRE_FIELDS.categoryName]: name };
}

/** An article row in the shape the module assumes. */
function articleRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    [COINDESK_WIRE_FIELDS.articleId]: "12345",
    [COINDESK_WIRE_FIELDS.articleGuid]: "https://example.test/guid/12345",
    [COINDESK_WIRE_FIELDS.articleTitle]: "Bitcoin does a thing",
    [COINDESK_WIRE_FIELDS.articleUrl]: "https://example.test/article/12345",
    [COINDESK_WIRE_FIELDS.articleSourceId]: "coindesk",
    [COINDESK_WIRE_FIELDS.articlePublishedOn]: PUBLISHED_S,
    [COINDESK_WIRE_FIELDS.articleSentiment]: "POSITIVE",
    ...overrides,
  };
}

function envelope(rows: unknown[], err: unknown = {}): unknown {
  return { [COINDESK_WIRE_FIELDS.data]: rows, [COINDESK_WIRE_FIELDS.error]: err };
}

interface StubVendor {
  readonly ports: NewsSentimentPorts;
  readonly calls: NewsQuery[];
}

/**
 * A vendor answering the two questions independently.
 *
 * Both answers are given as whole `ExchangeOutcome`s so a test can make either
 * call fail, or hand back a payload of any shape at all, without a second stub.
 */
function vendor(
  categories: ExchangeOutcome<unknown>,
  articles: ExchangeOutcome<unknown> = { ok: true, value: envelope([articleRow()]), at: ARTICLES_AT },
): StubVendor {
  const calls: NewsQuery[] = [];
  return {
    calls,
    ports: {
      fetchNews: async (query) => {
        calls.push(query);
        return query.resource === "categories" ? categories : articles;
      },
    },
  };
}

/** The common case: the vendor knows BTC and ETH, and answers with `rows`. */
function covering(rows: unknown[] = [articleRow()], names: string[] = ["BTC", "ETH"]): StubVendor {
  return vendor(
    { ok: true, value: envelope(names.map(categoryRow)), at: CATEGORIES_AT },
    { ok: true, value: envelope(rows), at: ARTICLES_AT },
  );
}

async function refusalOf(
  ports: NewsSentimentPorts,
  request: Parameters<typeof fetchNewsSentiment>[1],
): Promise<NewsSentimentError> {
  const thrown = await fetchNewsSentiment(ports, request).catch((error: unknown) => error);
  expect(thrown).toBeInstanceOf(NewsSentimentError);
  return thrown as NewsSentimentError;
}

describe("fetchNewsSentiment: the covered case", () => {
  it("returns the vendor's articles with the sentiment exactly as reported", async () => {
    const stub = covering([articleRow({ [COINDESK_WIRE_FIELDS.articleSentiment]: "NEGATIVE" })]);

    const result = await fetchNewsSentiment(stub.ports, { asset: "BTC" });

    expect(result.coverage).toBe("covered");
    if (result.coverage !== "covered") return;
    expect(result.articles).toHaveLength(1);
    expect(result.articles[0]).toEqual({
      id: "12345",
      guid: "https://example.test/guid/12345",
      title: "Bitcoin does a thing",
      url: "https://example.test/article/12345",
      sourceId: "coindesk",
      publishedAt: PUBLISHED_S * 1000,
      sentimentAsReported: "NEGATIVE",
      sentiment: "NEGATIVE",
    });
    expect(result.asset).toBe("BTC");
    expect(result.category).toBe("BTC");
    expect(result.requestedLimit).toBe(DEFAULT_ARTICLE_LIMIT);
  });

  it("stamps the result with the fetch moment, not a render moment (21.5 req 4)", async () => {
    const stub = covering();

    const result = await fetchNewsSentiment(stub.ports, { asset: "BTC" });

    // The articles' timestamp is the one 21.5 requirement 4 asks for, and the
    // coverage claim carries its own -- the two calls happened at different
    // instants and a result that reported one number for both would be
    // claiming something it did not observe.
    expect(result.fetchedAt).toBe(ARTICLES_AT);
    expect(result.coverageCheckedAt).toBe(CATEGORIES_AT);
    expect(result.fetchedAt).not.toBe(result.coverageCheckedAt);
  });

  it("carries the raw payload through by identity, not a rebuilt copy", async () => {
    // 21.5 requirement 2: the human must be able to verify the reasoning
    // against "the actual raw data it used", not this module's rendering of
    // it. Identity is the strongest available form of that assertion.
    const payload = envelope([articleRow()]);
    const stub = vendor(
      { ok: true, value: envelope([categoryRow("BTC")]), at: CATEGORIES_AT },
      { ok: true, value: payload, at: ARTICLES_AT },
    );

    const result = await fetchNewsSentiment(stub.ports, { asset: "BTC" });

    expect(result.coverage).toBe("covered");
    if (result.coverage !== "covered") return;
    expect(result.raw).toBe(payload);
  });

  it("counts each label and reports the span the articles actually cover", async () => {
    const stub = covering([
      articleRow({ [COINDESK_WIRE_FIELDS.articleId]: "1", [COINDESK_WIRE_FIELDS.articleSentiment]: "POSITIVE", [COINDESK_WIRE_FIELDS.articlePublishedOn]: PUBLISHED_S }),
      articleRow({ [COINDESK_WIRE_FIELDS.articleId]: "2", [COINDESK_WIRE_FIELDS.articleSentiment]: "NEGATIVE", [COINDESK_WIRE_FIELDS.articlePublishedOn]: PUBLISHED_S - 7200 }),
      articleRow({ [COINDESK_WIRE_FIELDS.articleId]: "3", [COINDESK_WIRE_FIELDS.articleSentiment]: "POSITIVE", [COINDESK_WIRE_FIELDS.articlePublishedOn]: PUBLISHED_S - 60 }),
      articleRow({ [COINDESK_WIRE_FIELDS.articleId]: "4", [COINDESK_WIRE_FIELDS.articleSentiment]: "NEUTRAL", [COINDESK_WIRE_FIELDS.articlePublishedOn]: PUBLISHED_S - 30 }),
    ]);

    const result = await fetchNewsSentiment(stub.ports, { asset: "BTC" });

    expect(result.coverage).toBe("covered");
    if (result.coverage !== "covered") return;
    expect(result.sentimentCounts).toEqual({
      POSITIVE: 2,
      NEUTRAL: 1,
      NEGATIVE: 1,
      unrecognized: 0,
    });
    // Derived from the articles, not from their order: the newest is first in
    // the list here and the oldest is second.
    expect(result.earliestPublishedAt).toBe((PUBLISHED_S - 7200) * 1000);
    expect(result.latestPublishedAt).toBe(PUBLISHED_S * 1000);
  });

  it("keeps an unrecognised label verbatim and never rounds it to NEUTRAL", async () => {
    // A vendor adding a fourth category is a fact about the data. Folding it
    // into the middle option would invent a reading of an article nobody here
    // has read -- and NEUTRAL is the one value that would look unremarkable.
    const stub = covering([
      articleRow({ [COINDESK_WIRE_FIELDS.articleSentiment]: "VERY_POSITIVE" }),
      articleRow({ [COINDESK_WIRE_FIELDS.articleId]: "2", [COINDESK_WIRE_FIELDS.articleSentiment]: "positive" }),
    ]);

    const result = await fetchNewsSentiment(stub.ports, { asset: "BTC" });

    expect(result.coverage).toBe("covered");
    if (result.coverage !== "covered") return;
    expect(result.articles[0].sentimentAsReported).toBe("VERY_POSITIVE");
    expect(result.articles[0].sentiment).toBeNull();
    // Case-sensitive on purpose: "positive" is not the documented label, and
    // accepting it would hide a contract change behind a normalisation.
    expect(result.articles[1]?.sentimentAsReported).toBe("positive");
    expect(result.articles[1]?.sentiment).toBeNull();
    expect(result.sentimentCounts).toEqual({
      POSITIVE: 0,
      NEUTRAL: 0,
      NEGATIVE: 0,
      unrecognized: 2,
    });
  });

  it("reports an absent GUID or SOURCE_ID as null rather than failing", async () => {
    const stub = covering([
      articleRow({
        [COINDESK_WIRE_FIELDS.articleGuid]: undefined,
        [COINDESK_WIRE_FIELDS.articleSourceId]: "",
      }),
    ]);

    const result = await fetchNewsSentiment(stub.ports, { asset: "BTC" });

    expect(result.coverage).toBe("covered");
    if (result.coverage !== "covered") return;
    expect(result.articles[0].guid).toBeNull();
    expect(result.articles[0].sourceId).toBeNull();
    // The fields that are NOT optional are still there.
    expect(result.articles[0].title).toBe("Bitcoin does a thing");
  });
});

describe("fetchNewsSentiment: 21.7 open question 2", () => {
  it("distinguishes an uncovered coin from a covered one with nothing published", async () => {
    // THE HEADLINE TEST. Both calls below would be `articles: []` in a design
    // that asked only the article endpoint, and a proposal built on that could
    // not tell a human which of two very different facts it had found.
    const uncovered = await fetchNewsSentiment(covering([], ["BTC", "ETH"]).ports, {
      asset: "NEWCOIN",
    });
    const quiet = await fetchNewsSentiment(covering([], ["BTC", "NEWCOIN"]).ports, {
      asset: "NEWCOIN",
    });

    expect(uncovered.coverage).toBe("not_covered");
    expect(quiet.coverage).toBe("no_articles_in_window");
    expect(uncovered.coverage).not.toBe(quiet.coverage);
  });

  it("spends no article request on a coin the vendor does not cover", async () => {
    const stub = covering([], ["BTC"]);

    const result = await fetchNewsSentiment(stub.ports, { asset: "NEWCOIN" });

    expect(result.coverage).toBe("not_covered");
    if (result.coverage !== "not_covered") return;
    expect(result.categoriesListed).toBe(1);
    // One call, and it was the coverage question. A "no articles" answer can
    // therefore never come from a request that was never going to match.
    expect(stub.calls).toEqual([{ resource: "categories" }]);
  });

  it("times an uncovered answer from the only fetch that happened", async () => {
    const stub = covering([], ["BTC"]);

    const result = await fetchNewsSentiment(stub.ports, { asset: "NEWCOIN" });

    expect(result.fetchedAt).toBe(CATEGORIES_AT);
    expect(result.coverageCheckedAt).toBe(CATEGORIES_AT);
  });

  it("gives an uncovered result no articles field to mistake for a quiet market", async () => {
    const uncovered = await fetchNewsSentiment(covering([], ["BTC"]).ports, { asset: "NEWCOIN" });
    const quiet = await fetchNewsSentiment(covering([], ["NEWCOIN"]).ports, { asset: "NEWCOIN" });

    // Not a stylistic assertion. A reader that forgets to check `coverage`
    // must not be able to reach an empty array and read it as "no news".
    expect("articles" in uncovered).toBe(false);
    expect("articles" in quiet).toBe(false);
    expect("category" in uncovered).toBe(false);
    expect("requestedLimit" in uncovered).toBe(false);
  });

  it("reports the quiet case with its category, limit and raw payload intact", async () => {
    const payload = envelope([]);
    const stub = vendor(
      { ok: true, value: envelope([categoryRow("NEWCOIN")]), at: CATEGORIES_AT },
      { ok: true, value: payload, at: ARTICLES_AT },
    );

    const result = await fetchNewsSentiment(stub.ports, { asset: "NEWCOIN", limit: 7 });

    expect(result.coverage).toBe("no_articles_in_window");
    if (result.coverage !== "no_articles_in_window") return;
    expect(result.category).toBe("NEWCOIN");
    expect(result.requestedLimit).toBe(7);
    // The empty payload is still evidence, and still shown (21.5 req 2).
    expect(result.raw).toBe(payload);
    expect(result.fetchedAt).toBe(ARTICLES_AT);
  });
});

describe("fetchNewsSentiment: a spelling difference is not a coverage fact", () => {
  it("refuses a case difference instead of reporting the coin uncovered", async () => {
    const stub = covering([], ["BTC", "ETH"]);

    const error = await refusalOf(stub.ports, { asset: "btc" });

    expect(error.code).toBe("asset_spelling_mismatch");
    expect(error.message).toContain('"BTC"');
    // And the article request was not spent on a symbol that would not match.
    expect(stub.calls).toEqual([{ resource: "categories" }]);
  });

  it("refuses surrounding whitespace the same way", async () => {
    const error = await refusalOf(covering([], ["BTC"]).ports, { asset: " BTC " });

    expect(error.code).toBe("asset_spelling_mismatch");
  });

  it("still reports genuinely uncovered coins as uncovered", async () => {
    // The guard above must not swallow the real answer: "PEPE" is not a
    // misspelling of anything the vendor lists.
    const result = await fetchNewsSentiment(covering([], ["BTC", "ETH"]).ports, { asset: "PEPE" });

    expect(result.coverage).toBe("not_covered");
  });
});

describe("fetchNewsSentiment: the request itself", () => {
  it("asks the coverage question first and the article question second", async () => {
    const stub = covering();

    await fetchNewsSentiment(stub.ports, { asset: "BTC", limit: 12 });

    expect(stub.calls).toEqual([
      { resource: "categories" },
      { resource: "articles", category: "BTC", limit: 12 },
    ]);
  });

  it("asks for DEFAULT_ARTICLE_LIMIT when the caller does not say", async () => {
    const stub = covering();

    await fetchNewsSentiment(stub.ports, { asset: "BTC" });

    expect(stub.calls[1]).toEqual({
      resource: "articles",
      category: "BTC",
      limit: DEFAULT_ARTICLE_LIMIT,
    });
  });

  it("refuses a blank asset before any request is made", async () => {
    for (const asset of ["", "   "]) {
      const stub = covering();
      const error = await refusalOf(stub.ports, { asset });
      expect(error.code).toBe("invalid_asset");
      expect(stub.calls).toEqual([]);
    }
  });

  it("refuses a limit outside the bound, before any request is made", async () => {
    for (const limit of [0, -1, 1.5, Number.NaN, MAX_ARTICLES + 1]) {
      const stub = covering();
      const error = await refusalOf(stub.ports, { asset: "BTC", limit });
      expect(error.code).toBe("invalid_limit");
      expect(stub.calls).toEqual([]);
    }
  });

  it("accepts both ends of the bound", async () => {
    for (const limit of [1, MAX_ARTICLES]) {
      const stub = covering();
      await fetchNewsSentiment(stub.ports, { asset: "BTC", limit });
      expect(stub.calls[1]).toMatchObject({ limit });
    }
  });

  it("does not cache: a second identical fetch really asks again", async () => {
    // 21.5 requirement 4 times a proposal from when its data was fetched, and
    // sentiment's entire value is that it is current. A cache here would make
    // that timestamp a lie that looks exactly like the truth.
    const stub = covering();

    await fetchNewsSentiment(stub.ports, { asset: "BTC" });
    await fetchNewsSentiment(stub.ports, { asset: "BTC" });

    expect(stub.calls).toHaveLength(4);
  });
});

describe("fetchNewsSentiment: fail closed", () => {
  const failure: ExchangeOutcome<unknown> = {
    ok: false,
    kind: "transport",
    message: "connect ETIMEDOUT",
    retryable: true,
    at: CATEGORIES_AT,
  };

  it("refuses when the coverage question itself could not be answered", async () => {
    const stub = vendor(failure);

    const error = await refusalOf(stub.ports, { asset: "BTC" });

    expect(error.code).toBe("categories_unreadable");
    expect(error.message).toContain("connect ETIMEDOUT");
    // Never "not covered": a coverage claim nobody could check is not a fact.
    expect(stub.calls).toEqual([{ resource: "categories" }]);
  });

  it("refuses when the article call failed", async () => {
    const stub = vendor({ ok: true, value: envelope([categoryRow("BTC")]), at: CATEGORIES_AT }, failure);

    const error = await refusalOf(stub.ports, { asset: "BTC" });

    expect(error.code).toBe("news_unavailable");
  });

  it("treats an error envelope beside a 200 as a failure, on either call", async () => {
    // The specific silent failure this vendor's envelope invites: the
    // transport sees a success, `Data` is absent or empty, and the result
    // reads as a quiet week.
    const err = { type: 1, message: "rate limit exceeded" };

    const onCategories = await refusalOf(
      vendor({ ok: true, value: envelope([], err), at: CATEGORIES_AT }).ports,
      { asset: "BTC" },
    );
    const onArticles = await refusalOf(
      vendor(
        { ok: true, value: envelope([categoryRow("BTC")]), at: CATEGORIES_AT },
        { ok: true, value: envelope([], err), at: ARTICLES_AT },
      ).ports,
      { asset: "BTC" },
    );

    expect(onCategories.code).toBe("vendor_error");
    expect(onCategories.message).toContain("rate limit exceeded");
    expect(onArticles.code).toBe("vendor_error");
  });

  it("accepts the empty and absent error envelopes the vendor sends on success", async () => {
    for (const err of [{}, null, undefined]) {
      const stub = vendor(
        { ok: true, value: envelope([categoryRow("BTC")], err), at: CATEGORIES_AT },
        { ok: true, value: envelope([articleRow()], err), at: ARTICLES_AT },
      );
      const result = await fetchNewsSentiment(stub.ports, { asset: "BTC" });
      expect(result.coverage).toBe("covered");
    }
  });

  it("refuses a category payload that is not the assumed shape", async () => {
    // The MESSAGE is asserted, not just the code, and a mutation run is why.
    // Weakening the top-level envelope check changed nothing observable --
    // a bare string or array still got refused, by the `Data`-is-an-array check
    // one line down. Behaviour identical, diagnostic degraded. That diagnostic
    // is what a first live run reads to find out WHICH assumption was wrong:
    // "the whole payload was an array" and "Data was not an array" call for
    // different corrections.
    const cases: [unknown, string][] = [
      [null, "expected a JSON object"],
      ["a string", "expected a JSON object"],
      [[categoryRow("BTC")], "an array of 1"],
      [{ [COINDESK_WIRE_FIELDS.data]: "not an array" }, "to be an array"],
      [envelope(["not an object"]), "category entry 0"],
      [envelope([{ ID: 1 }]), "CATEGORY"],
      [envelope([{ [COINDESK_WIRE_FIELDS.categoryName]: "" }]), "CATEGORY"],
      [envelope([{ [COINDESK_WIRE_FIELDS.categoryName]: 42 }]), "CATEGORY"],
    ];

    for (const [value, fragment] of cases) {
      const error = await refusalOf(vendor({ ok: true, value, at: CATEGORIES_AT }).ports, {
        asset: "BTC",
      });
      expect(error.code).toBe("unexpected_category_payload");
      expect(error.message).toContain(fragment);
    }
  });

  it("refuses an article payload that is not the assumed shape", async () => {
    const cases: unknown[] = [
      null,
      [articleRow()],
      { [COINDESK_WIRE_FIELDS.data]: { nested: true } },
      envelope([42]),
      envelope([articleRow({ [COINDESK_WIRE_FIELDS.articleId]: undefined })]),
      envelope([articleRow({ [COINDESK_WIRE_FIELDS.articleTitle]: "" })]),
      envelope([articleRow({ [COINDESK_WIRE_FIELDS.articleUrl]: 7 })]),
    ];

    for (const value of cases) {
      const stub = vendor(
        { ok: true, value: envelope([categoryRow("BTC")]), at: CATEGORIES_AT },
        { ok: true, value, at: ARTICLES_AT },
      );
      const error = await refusalOf(stub.ports, { asset: "BTC" });
      expect(error.code).toBe("unexpected_article_payload");
    }
  });

  it("refuses an article with no sentiment, naming why that field is mandatory", async () => {
    // 21.4 chose this vendor "specifically for its pre-scored sentiment
    // field". An article without one means that premise does not hold for this
    // response, and delivering the headline anyway would hand a proposal the
    // one attribute it was fetched for, missing.
    const stub = vendor(
      { ok: true, value: envelope([categoryRow("BTC")]), at: CATEGORIES_AT },
      {
        ok: true,
        value: envelope([articleRow({ [COINDESK_WIRE_FIELDS.articleSentiment]: undefined })]),
        at: ARTICLES_AT,
      },
    );

    const error = await refusalOf(stub.ports, { asset: "BTC" });

    expect(error.code).toBe("unexpected_article_payload");
    expect(error.message).toContain(COINDESK_WIRE_FIELDS.articleSentiment);
    expect(error.message).toContain("21.4");
  });

  it("fails the whole fetch on one malformed article rather than dropping it", async () => {
    // Dropping would hand back a shorter list with nothing saying it was
    // shortened -- "never fall back to fewer candles and not say so" in
    // different clothes (21.5 requirement 6).
    const stub = vendor(
      { ok: true, value: envelope([categoryRow("BTC")]), at: CATEGORIES_AT },
      {
        ok: true,
        value: envelope([
          articleRow({ [COINDESK_WIRE_FIELDS.articleId]: "1" }),
          articleRow({ [COINDESK_WIRE_FIELDS.articleId]: "2", [COINDESK_WIRE_FIELDS.articleTitle]: null }),
          articleRow({ [COINDESK_WIRE_FIELDS.articleId]: "3" }),
        ]),
        at: ARTICLES_AT,
      },
    );

    const error = await refusalOf(stub.ports, { asset: "BTC" });

    expect(error.code).toBe("unexpected_article_payload");
    expect(error.message).toContain("article 1");
  });

  it("throws NewsSentimentError, with the code on the error, for every refusal", async () => {
    const results = await Promise.all(
      (
        [
          [{ asset: "" }, covering(), "invalid_asset"],
          [{ asset: "BTC", limit: 0 }, covering(), "invalid_limit"],
          [{ asset: "btc" }, covering([], ["BTC"]), "asset_spelling_mismatch"],
          [{ asset: "BTC" }, vendor(failure), "categories_unreadable"],
          [
            { asset: "BTC" },
            vendor({ ok: true, value: envelope([categoryRow("BTC")]), at: CATEGORIES_AT }, failure),
            "news_unavailable",
          ],
          [
            { asset: "BTC" },
            vendor({ ok: true, value: envelope([], { message: "nope" }), at: CATEGORIES_AT }),
            "vendor_error",
          ],
          [{ asset: "BTC" }, vendor({ ok: true, value: null, at: CATEGORIES_AT }), "unexpected_category_payload"],
        ] as const
      ).map(async ([request, stub, code]) => {
        const error = await refusalOf(stub.ports, request);
        return [error.name, error.code, code] as const;
      }),
    );

    for (const [name, actual, expected] of results) {
      expect(name).toBe("NewsSentimentError");
      expect(actual).toBe(expected);
    }
  });
});

describe("fetchNewsSentiment: the publication-time unit assumption", () => {
  it("reads PUBLISHED_ON as unix seconds", async () => {
    const stub = covering([articleRow({ [COINDESK_WIRE_FIELDS.articlePublishedOn]: PUBLISHED_S })]);

    const result = await fetchNewsSentiment(stub.ports, { asset: "BTC" });

    expect(result.coverage).toBe("covered");
    if (result.coverage !== "covered") return;
    expect(result.articles[0].publishedAt).toBe(PUBLISHED_S * 1000);
  });

  it("refuses a value that was already in milliseconds instead of rescaling it", async () => {
    // The unit is ASSUMED. If the vendor really sends milliseconds, this
    // refusal is how that is discovered -- silently rescaling would hide the
    // one fact a first live run exists to establish.
    const stub = covering([
      articleRow({ [COINDESK_WIRE_FIELDS.articlePublishedOn]: PUBLISHED_S * 1000 }),
    ]);

    const error = await refusalOf(stub.ports, { asset: "BTC" });

    expect(error.code).toBe("unexpected_article_payload");
    expect(error.message).toContain("PUBLISHED_ON_IS_SECONDS");
  });

  it("refuses a value far in the past, which is the other half of the same mistake", async () => {
    const stub = covering([articleRow({ [COINDESK_WIRE_FIELDS.articlePublishedOn]: 1_000 })]);

    const error = await refusalOf(stub.ports, { asset: "BTC" });

    expect(error.code).toBe("unexpected_article_payload");
  });

  it("allows clock skew but not a future publication date", async () => {
    const withinSkew = covering([
      articleRow({
        [COINDESK_WIRE_FIELDS.articlePublishedOn]: Math.round(ARTICLES_AT / 1000) + 3600,
      }),
    ]);
    const beyondSkew = covering([
      articleRow({
        [COINDESK_WIRE_FIELDS.articlePublishedOn]: Math.round(ARTICLES_AT / 1000) + 3 * 86_400,
      }),
    ]);

    const ok = await fetchNewsSentiment(withinSkew.ports, { asset: "BTC" });
    const error = await refusalOf(beyondSkew.ports, { asset: "BTC" });

    expect(ok.coverage).toBe("covered");
    expect(error.code).toBe("unexpected_article_payload");
  });

  it("refuses a missing or unreadable PUBLISHED_ON", async () => {
    for (const value of [undefined, "2030-07-11", Number.NaN, null]) {
      const stub = covering([articleRow({ [COINDESK_WIRE_FIELDS.articlePublishedOn]: value })]);
      const error = await refusalOf(stub.ports, { asset: "BTC" });
      expect(error.code).toBe("unexpected_article_payload");
    }
  });
});

describe("the assumed wire format is pinned", () => {
  it("names every field this module reads off CoinDesk's payloads", async () => {
    // NOT a tautology, and not a shape check either. Every name here is an
    // INFERENCE from CoinDesk's public documentation index -- no call to their
    // API has ever been made from this repository. This pin exists so that
    // correcting one after a live run appears in a diff and earns a
    // decision-log line, exactly as VERIFIED_INTERVALS is pinned.
    expect(COINDESK_WIRE_FIELDS).toEqual({
      data: "Data",
      error: "Err",
      categoryName: "CATEGORY",
      articleId: "ID",
      articleGuid: "GUID",
      articleTitle: "TITLE",
      articleUrl: "URL",
      articleSourceId: "SOURCE_ID",
      articlePublishedOn: "PUBLISHED_ON",
      articleSentiment: "SENTIMENT",
    });
  });

  it("bounds how much this system will ask for", async () => {
    expect(DEFAULT_ARTICLE_LIMIT).toBe(50);
    expect(MAX_ARTICLES).toBe(100);
    expect(DEFAULT_ARTICLE_LIMIT).toBeLessThanOrEqual(MAX_ARTICLES);
  });

  it("gives every result the three fields a later stage reads without narrowing", async () => {
    const results: NewsSentimentResult[] = [
      await fetchNewsSentiment(covering().ports, { asset: "BTC" }),
      await fetchNewsSentiment(covering([]).ports, { asset: "BTC" }),
      await fetchNewsSentiment(covering([], ["ETH"]).ports, { asset: "BTC" }),
    ];

    expect(results.map((result) => result.coverage)).toEqual([
      "covered",
      "no_articles_in_window",
      "not_covered",
    ]);
    for (const result of results) {
      expect(result.asset).toBe("BTC");
      expect(typeof result.fetchedAt).toBe("number");
      expect(typeof result.coverageCheckedAt).toBe("number");
    }
  });
});
