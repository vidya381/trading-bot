/**
 * News and pre-scored sentiment for one asset (spec 21.4, Stage 1).
 *
 * Section 21 as a whole is still PLANNED, NOT YET BUILT -- no pipeline, no
 * prompt, no proposal record, no model call, no candidate selection. This is
 * the second bullet of Stage 1 and nothing else, the same category of thing as
 * `candles.ts`: read-only, deterministic, no LLM anywhere near it.
 *
 * ── Why a vendor's sentiment field at all ──
 *
 * 21.4 chooses the CoinDesk Data API "specifically for its pre-scored sentiment
 * field", and says why in the same breath: "taking a sentiment score computed
 * outside the model avoids asking the LLM to infer sentiment from raw
 * headlines, which is exactly the kind of unverifiable, ungrounded judgement
 * 21.5's grounding rule exists to prevent. The score is data the human can
 * check; an inferred mood is not."
 *
 * That reasoning survives one correction to its premise, which is recorded here
 * because it changes what a caller may do with the result. CoinDesk's sentiment
 * is REPORTED TO BE A LABEL, not a number -- one of POSITIVE, NEUTRAL or
 * NEGATIVE per article, and published descriptions of the feature say it is
 * produced by prompting a general-purpose language model to categorise the
 * article. So it is pre-computed and it is checkable, which is what 21.4
 * actually needs; it is NOT a calibrated score, it is not this system's
 * judgement, and averaging three labels into a mood number would manufacture
 * exactly the false precision 21.5 requirement 2 asks the human to be able to
 * verify against the source. What this module returns is therefore the labels
 * as reported plus their counts, and no derived index of any kind.
 *
 * ── UNVERIFIED, and stated first rather than in a footnote ──
 *
 * NO CALL TO COINDESK HAS EVER BEEN MADE FROM THIS REPOSITORY, by this session
 * or any other, and this project holds no CoinDesk key. Their reference docs
 * render client-side from a spec that could only be read by calling the API
 * host, which was not done. The endpoint paths (`workers/news.ts`), the
 * `Authorization: Apikey` scheme, the `{ Data, Err }` envelope and every field
 * name in `COINDESK_WIRE_FIELDS` below are drawn from CoinDesk's public
 * documentation index and from published descriptions of the API. They are
 * INFERENCES, not observations.
 *
 * The code is written to make that cheap rather than dangerous. Every one of
 * those assumptions is checked at parse time, and a violated one throws --
 * `unexpected_category_payload` or `unexpected_article_payload` -- carrying what
 * it expected and what it got. A wrong guess therefore produces a loud refusal
 * naming the field, not zero articles. Zero articles is the shape a silent
 * failure would take here, and 21.5 requirement 6 forbids precisely that.
 *
 * ── 21.7 open question 2, built in rather than bolted on ──
 *
 * "CoinDesk's coverage of newly listed coins is unverified ... If coverage is
 * empty, that is a fact the proposal must state, not a gap to paper over."
 *
 * An article-list request alone CANNOT answer that: an empty list means both
 * "this vendor has never heard of this coin" and "this vendor covers this coin
 * and published nothing recently", and those two facts belong in different
 * sentences of a proposal. So the coverage question is asked separately, of the
 * category listing, before any article is requested:
 *
 *   * the vendor lists no category for this asset  -> `not_covered`
 *   * it does, and returned nothing                -> `no_articles_in_window`
 *   * it does, and returned articles               -> `covered`
 *
 * THE DISTINCTION IS ONLY AS GOOD AS ITS PREMISE, which is that CoinDesk's
 * category list enumerates assets and is complete. That premise is unverified
 * like everything else above. If a live run shows the category list is a small
 * fixed taxonomy rather than an asset index, THIS DESIGN IS WRONG AND MUST BE
 * REPLACED BY A PLAIN STATEMENT THAT THE VENDOR CANNOT TELL THE TWO APART --
 * not by a heuristic that guesses which one happened.
 *
 * The three outcomes are separate variants rather than a flag beside an array,
 * so "covered with zero articles" is not a value that can be constructed. The
 * covered variant's `articles` is a non-empty tuple type; the other two carry no
 * `articles` field at all. A reader that forgets to check `coverage` cannot
 * reach an empty array and mistake it for a quiet market.
 *
 * ── Fail closed (21.5 requirement 6) ──
 *
 *   * a blank asset symbol             -> `invalid_asset`
 *   * a limit outside this system's bound -> `invalid_limit`
 *   * the category listing failed      -> `categories_unreadable`
 *   * the vendor's envelope carried an error -> `vendor_error`
 *   * a payload that is not the shape assumed -> `unexpected_*_payload`
 *   * the asset differs from the vendor's spelling only by case/space
 *                                      -> `asset_spelling_mismatch`
 *   * the article call failed          -> `news_unavailable`
 *
 * Every one throws. None returns an empty result, a partial list, or a
 * synthesised label. The spelling case is the one that would otherwise rot
 * quietly: reporting `not_covered` because a caller wrote "btc" where the
 * vendor writes "BTC" puts a FALSE claim about a real vendor into a proposal,
 * and a false "nobody is writing about this coin" is worse than no answer.
 * Section 5.6's rule, one layer out again -- "could not reach it" is never
 * "there was nothing there".
 */

import type { Timestamp } from "../shared/exchange-client";
import type { ExchangeOutcome } from "../shared/downtime";
import type { NewsQuery } from "../workers/news";

/**
 * How this module reaches the vendor.
 *
 * A port, for the same reason `CandleSource` and `TradablePairSource` are
 * ports: every test below drives an injected fetcher and NOTHING HERE HAS EVER
 * SPOKEN TO COINDESK. In production this is `(query) => envNewsFetcher(query,
 * env, now)`.
 *
 * It yields `unknown`, not a parsed article: the parse is this module's job
 * because the parse is the part most likely to be wrong.
 */
export type NewsSource = (query: NewsQuery) => Promise<ExchangeOutcome<unknown>>;

export interface NewsSentimentPorts {
  readonly fetchNews: NewsSource;
}

/**
 * The vendor's wire field names, ASSUMED (see the header), collected so that
 * correcting them after the first live run is one visible edit.
 *
 * Pinned by a test, for the reason `VERIFIED_INTERVALS` is pinned: a change
 * here is a change to what this system believes about an external API, and it
 * must appear in a diff rather than happen as a one-character fix.
 */
export const COINDESK_WIRE_FIELDS = {
  /** The envelope's payload key. */
  data: "Data",
  /** The envelope's error key. Populated even on a 200, hence checked always. */
  error: "Err",
  /** A category entry's own name, matched against the requested asset. */
  categoryName: "CATEGORY",
  articleId: "ID",
  articleGuid: "GUID",
  articleTitle: "TITLE",
  articleUrl: "URL",
  articleSourceId: "SOURCE_ID",
  /** Unix SECONDS by assumption. See `PUBLISHED_ON_IS_SECONDS`. */
  articlePublishedOn: "PUBLISHED_ON",
  /** The reason this vendor was chosen. Mandatory; a missing one is a refusal. */
  articleSentiment: "SENTIMENT",
} as const;

/**
 * Whether `PUBLISHED_ON` is unix seconds, ASSUMED true from the API's
 * CryptoCompare lineage, where it was.
 *
 * Called out separately from the other guesses because it is the only one that
 * fails QUIETLY if wrong. A wrong field NAME produces a missing value and a
 * refusal; a wrong UNIT produces a perfectly well-formed number that is off by
 * a factor of a thousand, and a proposal reasoning about "recent news" over
 * headlines dated 1970 or 58000 would look entirely normal.
 *
 * So it is not left to trust: `PLAUSIBLE_PUBLISH_WINDOW` below rejects both
 * directions of the mistake, and rejecting is all it does -- it never
 * auto-detects the unit and rescales, because a parser that repairs its own
 * input hides the very fact a first live run exists to establish.
 */
export const PUBLISHED_ON_IS_SECONDS: boolean = true;

/**
 * The earliest publication instant this module will believe: 2009-01-03, the
 * Bitcoin genesis block. A crypto news article predating it is not a date, it
 * is a unit error.
 */
const EARLIEST_PLAUSIBLE_PUBLISH = Date.UTC(2009, 0, 3);

/**
 * How far past the fetch instant a publication timestamp may sit before it is
 * treated as nonsense: two days, which is clock skew and timezone confusion
 * with room to spare, and nowhere near the ~1000x error a unit mistake makes.
 */
const FUTURE_PUBLISH_TOLERANCE_MS = 48 * 60 * 60 * 1000;

/**
 * The most articles this system will ask for in one fetch.
 *
 * A bound this system imposes on itself, NOT a claim about the vendor's own
 * maximum, which is unverified like everything else here. It exists because
 * every article fetched is a headline a human is implicitly promised the
 * proposal used (21.5 requirement 2), and a proposal quoting five hundred
 * headlines is not reviewable by the human it exists to inform.
 */
export const MAX_ARTICLES = 100;

/** The default when a caller does not say. */
export const DEFAULT_ARTICLE_LIMIT = 50;

/** The three labels this vendor is reported to emit. */
export type SentimentLabel = "POSITIVE" | "NEUTRAL" | "NEGATIVE";

const SENTIMENT_LABELS: readonly SentimentLabel[] = ["POSITIVE", "NEUTRAL", "NEGATIVE"];

export type NewsSentimentErrorCode =
  /** The asset symbol was blank. */
  | "invalid_asset"
  /** The requested article count was not a whole number within the bound. */
  | "invalid_limit"
  /** The category listing could not be read, so coverage is unknown. */
  | "categories_unreadable"
  /** The article call failed: transport, vendor error, or rate limit. */
  | "news_unavailable"
  /** The vendor answered 200 with an error in the envelope. */
  | "vendor_error"
  /** The category listing was not the shape this module assumes. */
  | "unexpected_category_payload"
  /** The article listing was not the shape this module assumes. */
  | "unexpected_article_payload"
  /** The vendor spells this asset differently. Never reported as no coverage. */
  | "asset_spelling_mismatch";

export class NewsSentimentError extends Error {
  readonly code: NewsSentimentErrorCode;
  constructor(code: NewsSentimentErrorCode, message: string) {
    super(message);
    this.name = "NewsSentimentError";
    this.code = code;
  }
}

export interface FetchNewsSentimentRequest {
  /**
   * The asset, in the vendor's own spelling -- "BTC", not "BTCUSD".
   *
   * AN ASSET, NOT A PAIR, and this module deliberately does not derive one from
   * the other. Gemini's symbols are concatenated and separator-less (`BTCUSD`),
   * so splitting one into base and quote needs the venue's own symbol details,
   * and a guess at the split point is wrong for exactly the newly-listed,
   * unusually-named coins 21.3's trending source is for. The caller that knows
   * the asset passes the asset.
   */
  readonly asset: string;
  /** How many articles to ask for. Defaults to `DEFAULT_ARTICLE_LIMIT`. */
  readonly limit?: number;
}

/** One article, with its sentiment exactly as the vendor reported it. */
export interface NewsArticle {
  readonly id: string;
  readonly guid: string | null;
  readonly title: string;
  readonly url: string;
  readonly sourceId: string | null;
  /** Publication instant in ms, converted from the vendor's unit and checked. */
  readonly publishedAt: Timestamp;
  /**
   * The sentiment string VERBATIM, whatever it was.
   *
   * 21.5 requirement 2 wants "the real headlines and their real sentiment
   * scores ... not the model's prose summary of them", and the same reasoning
   * applies to this module's own tidying: a caller that shows a human
   * `sentiment` below is showing them a value this code produced, while this
   * field is a value CoinDesk produced.
   */
  readonly sentimentAsReported: string;
  /**
   * The recognised label, or null when the vendor reported something outside
   * the three known ones.
   *
   * NULL IS NOT NEUTRAL and must never be read as it. An unrecognised label is
   * counted under `unrecognized` and carried through unchanged, because a
   * vendor adding a fourth category is a fact about the data, and collapsing it
   * into the middle option would silently invent a reading of an article
   * nobody here has read.
   */
  readonly sentiment: SentimentLabel | null;
}

export interface SentimentCounts {
  readonly POSITIVE: number;
  readonly NEUTRAL: number;
  readonly NEGATIVE: number;
  /** Labels outside the three known ones. Never folded into NEUTRAL. */
  readonly unrecognized: number;
}

/** What every outcome carries, whatever the coverage turned out to be. */
interface NewsSentimentBase {
  /** The asset as requested, echoed so a stored result is self-describing. */
  readonly asset: string;
  /**
   * When the data this result reports was obtained -- 21.5 requirement 4's
   * fetch time, not a render time.
   *
   * For a covered asset this is the instant the ARTICLES came back. For an
   * uncovered one there are no articles, so it is the instant the coverage
   * question itself was answered, which is the only fetch that happened.
   */
  readonly fetchedAt: Timestamp;
  /** When the category listing came back. The coverage claim's own timestamp. */
  readonly coverageCheckedAt: Timestamp;
}

/** The vendor covers this asset and published articles. */
export interface CoveredNewsSentiment extends NewsSentimentBase {
  readonly coverage: "covered";
  /** The vendor's category, in the vendor's spelling. */
  readonly category: string;
  readonly requestedLimit: number;
  /** Non-empty BY TYPE: this variant cannot represent an empty result. */
  readonly articles: readonly [NewsArticle, ...NewsArticle[]];
  readonly sentimentCounts: SentimentCounts;
  readonly earliestPublishedAt: Timestamp;
  readonly latestPublishedAt: Timestamp;
  /** The article payload exactly as received, for 21.5 requirement 2. */
  readonly raw: unknown;
}

/** The vendor covers this asset and returned nothing for this request. */
export interface QuietNewsSentiment extends NewsSentimentBase {
  readonly coverage: "no_articles_in_window";
  readonly category: string;
  readonly requestedLimit: number;
  readonly raw: unknown;
}

/**
 * The vendor lists no category for this asset at all.
 *
 * 21.7's open question 2, answered as a fact rather than hidden as an empty
 * list. No article request was made, so there is no article payload and no
 * `requestedLimit`: nothing was requested.
 */
export interface UncoveredNewsSentiment extends NewsSentimentBase {
  readonly coverage: "not_covered";
  /** How many categories the vendor did list, so "none matched" is checkable. */
  readonly categoriesListed: number;
}

export type NewsSentimentResult =
  | CoveredNewsSentiment
  | QuietNewsSentiment
  | UncoveredNewsSentiment;

/**
 * Fetch news and pre-scored sentiment for one asset.
 *
 * The order of the work is deliberate and matches `fetchCandleWindow`'s "free
 * checks first, remote call last": the asset and limit are validated with no
 * I/O, then the coverage question is asked, and the article request is spent
 * ONLY when there is a category to spend it on. An asset the vendor has never
 * heard of costs one call, not two, and the saved call is not the point -- the
 * point is that a result claiming "no articles" can never come from a request
 * that was never going to match anything.
 */
export async function fetchNewsSentiment(
  ports: NewsSentimentPorts,
  request: FetchNewsSentimentRequest,
): Promise<NewsSentimentResult> {
  const asset = request.asset;
  if (asset.trim() === "") {
    throw new NewsSentimentError(
      "invalid_asset",
      `a blank asset symbol has no news and no coverage answer. Pass the vendor's own ` +
        `spelling of the asset -- "BTC", not "BTCUSD" and not "".`,
    );
  }

  const limit = request.limit ?? DEFAULT_ARTICLE_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_ARTICLES) {
    throw new NewsSentimentError(
      "invalid_limit",
      `${JSON.stringify(request.limit)} is not a usable article count: it must be a whole ` +
        `number between 1 and ${MAX_ARTICLES}. That ceiling is this system's own, not the ` +
        `vendor's -- every article fetched is a headline a human is promised the proposal ` +
        `actually used (21.5 requirement 2), and a proposal quoting hundreds is not ` +
        `reviewable by the human it exists to inform.`,
    );
  }

  // THE COVERAGE QUESTION, asked of the category listing and asked FIRST.
  const categoryOutcome = await ports.fetchNews({ resource: "categories" });
  if (!categoryOutcome.ok) {
    throw new NewsSentimentError(
      "categories_unreadable",
      `could not read the news vendor's category list, so whether ${JSON.stringify(asset)} ` +
        `is covered at all is unknown: ${categoryOutcome.kind} -- ${categoryOutcome.message}. ` +
        `Refusing rather than reporting no coverage: "could not check" and "checked, and the ` +
        `vendor does not cover this coin" are different facts and only one of them belongs ` +
        `in a proposal (section 5.6).`,
    );
  }
  const coverageCheckedAt = categoryOutcome.at;
  const categories = decodeCategoryList(categoryOutcome.value, asset);

  const category = categories.find((name) => name === asset);
  if (category === undefined) {
    // NEAR MATCHES BEFORE NO COVERAGE. Reporting "the vendor does not cover
    // this coin" because the caller wrote "btc" for the vendor's "BTC" would
    // put a false claim about a real vendor into a proposal, and a false "no
    // one is writing about this coin" reads as a finding rather than as the
    // mistake it is. Folded on case AND surrounding space, since both are
    // spelling, and neither is a coverage fact.
    const folded = fold(asset);
    const near = categories.filter((name) => fold(name) === folded);
    if (near.length > 0) {
      throw new NewsSentimentError(
        "asset_spelling_mismatch",
        `the news vendor spells ${JSON.stringify(asset)} as ` +
          `${near.map((n) => JSON.stringify(n)).join(" or ")}. Refusing rather than ` +
          `reporting no coverage, which would be a false claim about the vendor: the ` +
          `symbol must match its own spelling exactly.`,
      );
    }
    return {
      coverage: "not_covered",
      asset,
      categoriesListed: categories.length,
      fetchedAt: coverageCheckedAt,
      coverageCheckedAt,
    };
  }

  const articleOutcome = await ports.fetchNews({ resource: "articles", category, limit });
  if (!articleOutcome.ok) {
    throw new NewsSentimentError(
      "news_unavailable",
      `could not fetch news for ${JSON.stringify(asset)} under category ` +
        `${JSON.stringify(category)}: ${articleOutcome.kind} -- ${articleOutcome.message}. ` +
        `Refusing rather than returning no articles: a failed fetch and a quiet week are ` +
        `not the same fact (section 5.6).`,
    );
  }

  const raw = articleOutcome.value;
  const fetchedAt = articleOutcome.at;
  const articles = decodeArticleList(raw, asset, fetchedAt);

  const first = articles[0];
  if (first === undefined) {
    return {
      coverage: "no_articles_in_window",
      asset,
      category,
      requestedLimit: limit,
      fetchedAt,
      coverageCheckedAt,
      raw,
    };
  }

  const times = articles.map((article) => article.publishedAt);
  return {
    coverage: "covered",
    asset,
    category,
    requestedLimit: limit,
    articles: [first, ...articles.slice(1)],
    sentimentCounts: countSentiments(articles),
    earliestPublishedAt: Math.min(...times),
    latestPublishedAt: Math.max(...times),
    fetchedAt,
    coverageCheckedAt,
    raw,
  };
}

/** Case and surrounding space folded away; both are spelling, not coverage. */
function fold(value: string): string {
  return value.trim().toLowerCase();
}

function countSentiments(articles: readonly NewsArticle[]): SentimentCounts {
  let positive = 0;
  let neutral = 0;
  let negative = 0;
  let unrecognized = 0;
  for (const article of articles) {
    if (article.sentiment === "POSITIVE") positive += 1;
    else if (article.sentiment === "NEUTRAL") neutral += 1;
    else if (article.sentiment === "NEGATIVE") negative += 1;
    else unrecognized += 1;
  }
  return { POSITIVE: positive, NEUTRAL: neutral, NEGATIVE: negative, unrecognized };
}

/**
 * The vendor's envelope, unwrapped and checked in both directions.
 *
 * `Err` is checked BEFORE `Data` and checked at all because this API is
 * reported to answer some failures with HTTP 200 and the error in the body --
 * which the transport, reading only the status, would hand back as a success.
 * An unchecked error envelope is the exact shape of a silent failure: `Data`
 * absent or empty, every type check passed, zero articles delivered to a
 * proposal as though the week had simply been quiet.
 */
function unwrapEnvelope(
  payload: unknown,
  code: "unexpected_category_payload" | "unexpected_article_payload",
  describing: string,
): unknown[] {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new NewsSentimentError(
      code,
      `${describing}: expected a JSON object carrying ` +
        `${JSON.stringify(COINDESK_WIRE_FIELDS.data)}, got ${describe(payload)}. The vendor's ` +
        `wire format is ASSUMED, not verified -- if this is what it really returns, the ` +
        `assumption in COINDESK_WIRE_FIELDS is what needs correcting.`,
    );
  }
  const envelope = payload as Record<string, unknown>;

  const err = envelope[COINDESK_WIRE_FIELDS.error];
  if (err !== undefined && err !== null && !isEmptyObject(err)) {
    throw new NewsSentimentError(
      "vendor_error",
      `${describing}: the vendor answered with an error in its ` +
        `${JSON.stringify(COINDESK_WIRE_FIELDS.error)} envelope: ${JSON.stringify(err)}. ` +
        `Treated as a failed fetch even though the transport saw a success, because an ` +
        `error envelope beside an absent or empty payload is indistinguishable from a ` +
        `quiet week at every later reader (21.5 requirement 6).`,
    );
  }

  const data = envelope[COINDESK_WIRE_FIELDS.data];
  if (!Array.isArray(data)) {
    throw new NewsSentimentError(
      code,
      `${describing}: expected ${JSON.stringify(COINDESK_WIRE_FIELDS.data)} to be an array, ` +
        `got ${describe(data)}. Refusing rather than treating an unreadable payload as an ` +
        `empty one.`,
    );
  }
  return data;
}

function isEmptyObject(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === 0
  );
}

/** Every category name the vendor listed, in the vendor's own spelling. */
function decodeCategoryList(payload: unknown, asset: string): string[] {
  const rows = unwrapEnvelope(
    payload,
    "unexpected_category_payload",
    `cannot tell whether the vendor covers ${JSON.stringify(asset)}`,
  );

  return rows.map((row, index) => {
    if (typeof row !== "object" || row === null) {
      throw new NewsSentimentError(
        "unexpected_category_payload",
        `category entry ${index} is ${describe(row)}, not an object, so the vendor's ` +
          `coverage of ${JSON.stringify(asset)} cannot be established.`,
      );
    }
    const name = (row as Record<string, unknown>)[COINDESK_WIRE_FIELDS.categoryName];
    if (typeof name !== "string" || name === "") {
      throw new NewsSentimentError(
        "unexpected_category_payload",
        `category entry ${index} has no usable ` +
          `${JSON.stringify(COINDESK_WIRE_FIELDS.categoryName)} (got ${describe(name)}). ` +
          `Refusing rather than skipping it: a skipped category is a coin silently reported ` +
          `as uncovered, which is 21.7 open question 2 answered wrongly and confidently.`,
      );
    }
    return name;
  });
}

/**
 * Every article, with every field this module promises actually present.
 *
 * A malformed article fails the WHOLE fetch rather than being dropped. Dropping
 * would be the quiet degradation 21.5 requirement 6 forbids -- the caller would
 * receive a shorter list with no indication it was shortened, which is
 * "never fall back to fewer candles and not say so" wearing different clothes.
 */
function decodeArticleList(payload: unknown, asset: string, fetchedAt: Timestamp): NewsArticle[] {
  const rows = unwrapEnvelope(
    payload,
    "unexpected_article_payload",
    `cannot read the news the vendor returned for ${JSON.stringify(asset)}`,
  );

  return rows.map((row, index) => {
    if (typeof row !== "object" || row === null) {
      throw new NewsSentimentError(
        "unexpected_article_payload",
        `article ${index} is ${describe(row)}, not an object.`,
      );
    }
    const article = row as Record<string, unknown>;

    const id = requireString(article, COINDESK_WIRE_FIELDS.articleId, index);
    const title = requireString(article, COINDESK_WIRE_FIELDS.articleTitle, index);
    const url = requireString(article, COINDESK_WIRE_FIELDS.articleUrl, index);

    // THE SENTIMENT IS MANDATORY, and that is the strongest check here on
    // purpose. 21.4 chose this vendor "specifically for its pre-scored
    // sentiment field"; an article arriving without one means the premise of
    // that choice does not hold for this response, and the only honest
    // response to that is to say so loudly rather than to deliver a headline
    // with the one attribute it was fetched for missing.
    const sentimentAsReported = requireString(
      article,
      COINDESK_WIRE_FIELDS.articleSentiment,
      index,
      `That field is the entire reason 21.4 chose this vendor, so an article without one ` +
        `is not a usable input to a proposal.`,
    );

    return {
      id,
      guid: optionalString(article, COINDESK_WIRE_FIELDS.articleGuid),
      title,
      url,
      sourceId: optionalString(article, COINDESK_WIRE_FIELDS.articleSourceId),
      publishedAt: decodePublishedAt(article, index, fetchedAt),
      sentimentAsReported,
      sentiment: recognizeSentiment(sentimentAsReported),
    };
  });
}

/**
 * The vendor's label, recognised or admitted to be unrecognised.
 *
 * The comparison is exact and case-sensitive against the three documented
 * labels. A vendor that starts emitting "Positive" has changed its contract,
 * and that shows up here as an `unrecognized` count a reader can see rather
 * than as a normalisation this code performed on their behalf.
 */
function recognizeSentiment(reported: string): SentimentLabel | null {
  return SENTIMENT_LABELS.find((label) => label === reported) ?? null;
}

/**
 * `PUBLISHED_ON` in ms, with the unit assumption checked rather than trusted.
 *
 * The window rejects BOTH directions of the mistake: seconds left unconverted
 * land in 1970, and milliseconds converted as though they were seconds land
 * tens of thousands of years out. Either way this refuses. It never rescales to
 * whichever unit would have looked plausible -- a parser that repairs its own
 * input destroys the evidence the first live run exists to gather.
 */
function decodePublishedAt(
  article: Record<string, unknown>,
  index: number,
  fetchedAt: Timestamp,
): Timestamp {
  const raw = article[COINDESK_WIRE_FIELDS.articlePublishedOn];
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    throw new NewsSentimentError(
      "unexpected_article_payload",
      `article ${index} has no usable ` +
        `${JSON.stringify(COINDESK_WIRE_FIELDS.articlePublishedOn)} (got ${describe(raw)}). ` +
        `A proposal is a claim about a moment (21.5 requirement 4), so an article with no ` +
        `readable publication time cannot support one.`,
    );
  }

  const publishedAt = PUBLISHED_ON_IS_SECONDS ? Math.round(raw * 1000) : raw;
  const latestPlausible = fetchedAt + FUTURE_PUBLISH_TOLERANCE_MS;
  if (publishedAt < EARLIEST_PLAUSIBLE_PUBLISH || publishedAt > latestPlausible) {
    throw new NewsSentimentError(
      "unexpected_article_payload",
      `article ${index} reports ${JSON.stringify(COINDESK_WIRE_FIELDS.articlePublishedOn)} ` +
        `${raw}, which this module read as ${publishedAt} ms -- outside the plausible range ` +
        `${EARLIEST_PLAUSIBLE_PUBLISH}..${latestPlausible}. The unit is ASSUMED to be unix ` +
        `seconds (PUBLISHED_ON_IS_SECONDS) and this refusal is what checks that assumption ` +
        `in both directions. Refusing rather than rescaling to whichever unit would have ` +
        `looked right, which would hide the very thing that needs correcting.`,
    );
  }
  return publishedAt;
}

function requireString(
  article: Record<string, unknown>,
  field: string,
  index: number,
  extra = "",
): string {
  const value = article[field];
  if (typeof value !== "string" || value === "") {
    throw new NewsSentimentError(
      "unexpected_article_payload",
      `article ${index} has no usable ${JSON.stringify(field)} (got ${describe(value)}). ` +
        `The vendor's wire format is ASSUMED, not verified -- if this is what it really ` +
        `returns, COINDESK_WIRE_FIELDS is what needs correcting.` +
        (extra === "" ? "" : ` ${extra}`),
    );
  }
  return value;
}

/** Absent, null, or blank all read as "the vendor did not say". */
function optionalString(article: Record<string, unknown>, field: string): string | null {
  const value = article[field];
  return typeof value === "string" && value !== "" ? value : null;
}

/** A value described for an error message, without dumping a whole payload. */
function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return `an array of ${value.length}`;
  if (typeof value === "object") return "an object";
  if (typeof value === "string") return JSON.stringify(value);
  return `${typeof value} ${String(value)}`;
}
