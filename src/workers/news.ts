/**
 * The real transport to the CoinDesk Data API's news endpoints (spec 21.4,
 * Stage 1, second bullet).
 *
 * `candles.ts` one file over is this shape for candles and `symbols.ts` for the
 * tradable set; this is the same shape again, and it does the same amount of
 * thinking, which is none. It builds a URL, attaches the key, and hands back
 * whatever JSON came out, wrapped in the same `ExchangeOutcome` every other
 * remote call in this system produces. Every decision -- what counts as
 * coverage, what an unrecognised sentiment means, when to refuse -- lives in
 * `research/news.ts`, which is where it can be tested without a network.
 *
 * ── UNVERIFIED. READ THIS BEFORE TRUSTING ANY CONSTANT BELOW ──
 *
 * NOTHING IN THIS FILE HAS EVER BEEN RUN AGAINST THE REAL COINDESK API, and
 * this project has no CoinDesk key. The host, the paths, the header, the query
 * parameter names and the envelope are drawn from CoinDesk's public
 * documentation index and from published descriptions of the API -- not from a
 * response anyone here has seen. `developers.coindesk.com` renders its
 * reference pages client-side from a spec this session could not read without
 * calling the API host itself, which it did not do.
 *
 * What that means concretely: the FIRST live call is a test of these constants
 * as much as of the code. `research/news.ts` is written so a wrong guess here
 * surfaces as a loud `unexpected_category_payload` / `unexpected_article_payload`
 * refusal rather than as zero articles, which is the specific failure 21.5
 * requirement 6 exists to prevent -- but the guess is still a guess, and it is
 * collected in ONE place (`COINDESK_ENDPOINTS`, and `COINDESK_WIRE_FIELDS` in
 * `research/news.ts`) so correcting it after the first live run is a small,
 * visible diff rather than an archaeology exercise.
 *
 * ── NOT CACHED, and that is the same decision candles took ──
 *
 * Deliberate, for the reason `envCandleLister` gives: 21.5 requirement 4 times a
 * proposal from "when its underlying data was fetched", and news whose entire
 * claim is "this is the current mood" is worth exactly as much as its
 * freshness. A cache here would make that timestamp a lie that looks precisely
 * like the truth. The symbol listing is cached because a venue's catalogue
 * barely moves; sentiment is the opposite case.
 */

import type { Timestamp } from "../shared/exchange-client";
import { classifyStatus, classifyThrown, type ExchangeOutcome } from "../shared/downtime";

/**
 * What to ask the news API for.
 *
 * Two resources, because answering 21.7's open question 2 honestly takes two
 * questions: "does this vendor have a category for this asset at all" and "what
 * has it published under that category". A single article request cannot
 * distinguish the two, and inventing the distinction downstream would be
 * exactly the papering-over that open question forbids.
 */
export type NewsQuery =
  /** Every news category the vendor knows about. The coverage question. */
  | { readonly resource: "categories" }
  /** Articles filed under one category, newest first. The content question. */
  | { readonly resource: "articles"; readonly category: string; readonly limit: number };

/**
 * The port that actually reaches the vendor.
 *
 * Returns the decoded JSON as `unknown` and nothing more. Deliberately NOT a
 * parsed article list: the parse is the part most likely to be wrong (see the
 * header), so it belongs where tests can drive every malformed shape through
 * it, not in a transport no test in this repository can execute.
 */
export type NewsFetcher = (
  query: NewsQuery,
  env: Env,
  now: () => Timestamp,
) => Promise<ExchangeOutcome<unknown>>;

/**
 * The vendor's host and paths, ASSUMED, collected here so a correction is one
 * edit. See the header: none of these has been confirmed against a live call.
 */
export const COINDESK_ENDPOINTS = {
  baseUrl: "https://data-api.coindesk.com",
  categories: "/news/v1/category/list",
  articles: "/news/v1/article/list",
} as const;

/**
 * Build the request URL for a query.
 *
 * Exported so its assumptions are assertable without a network: the parameter
 * names below (`categories`, `limit`, `lang`) are part of the same unverified
 * guess as the paths, and a test pinning them makes a later correction visible
 * in a diff rather than silent.
 */
export function newsRequestUrl(query: NewsQuery): string {
  if (query.resource === "categories") {
    return `${COINDESK_ENDPOINTS.baseUrl}${COINDESK_ENDPOINTS.categories}`;
  }
  const url = new URL(`${COINDESK_ENDPOINTS.baseUrl}${COINDESK_ENDPOINTS.articles}`);
  url.searchParams.set("categories", query.category);
  url.searchParams.set("limit", String(query.limit));
  url.searchParams.set("lang", "EN");
  return url.toString();
}

/**
 * The real fetcher.
 *
 * The key is a secret and is never a query parameter: a key in a URL lands in
 * every log, proxy and error message that ever handles the request. Absence of
 * the key is a refusal, not a request sent unauthenticated -- an unauthenticated
 * call would come back as some vendor-shaped 401 that reads like an outage
 * rather than like the missing configuration it is.
 */
export const envNewsFetcher: NewsFetcher = async (query, env, now) => {
  const key = env.COINDESK_API_KEY;
  if (key === undefined || key.trim() === "") {
    return {
      ok: false,
      kind: "exchange_error",
      message:
        "no COINDESK_API_KEY secret in this environment, so no news or sentiment can be " +
        "fetched. Set it with `wrangler secret put COINDESK_API_KEY --env <env>`. Refusing " +
        "rather than calling unauthenticated: the vendor's answer to a keyless request is " +
        "an authentication error that reads like an outage.",
      retryable: false,
      at: now(),
    };
  }

  let response: Response;
  try {
    response = await fetch(newsRequestUrl(query), {
      method: "GET",
      headers: {
        // CoinDesk's documented scheme, and the one their docs' own examples
        // use: the literal word `Apikey`, then a space, then the key.
        authorization: `Apikey ${key}`,
        accept: "application/json",
      },
    });
  } catch (error) {
    return classifyThrown(error, now());
  }

  if (!response.ok) {
    return classifyStatus(response.status, now(), {
      message: `CoinDesk responded with HTTP ${response.status} for ${query.resource}`,
    });
  }

  try {
    return { ok: true, value: await response.json(), at: now() };
  } catch (error) {
    // A 200 whose body is not JSON. Classified as a transport failure for the
    // same reason section 5.6 groups 5xx with connection failures: nothing
    // usable arrived, so nothing may be inferred from it.
    return classifyThrown(error, now());
  }
};

// The one secret this module reads, declared optional for the reason
// src/api/access.ts declares ACCESS_AUD optional: a deploy with no --env has
// no secrets at all, and the absence is handled above with a refusal rather
// than a type assertion. Secrets never appear in wrangler.jsonc, so
// `wrangler types` cannot emit this.
declare global {
  interface Env {
    readonly COINDESK_API_KEY?: string;
  }
}
