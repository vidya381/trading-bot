/**
 * The real transport to CoinDesk, and the assumptions baked into its URLs.
 *
 * Three things are worth asserting here and nothing else is:
 *
 *  1. THE URL AND HEADER ARE WHAT THIS SYSTEM BELIEVES THEY ARE. Every one of
 *     those constants is an INFERENCE from CoinDesk's public documentation
 *     index -- no call to their API has been made from this repository. Pinning
 *     them makes a correction after a live run a visible diff.
 *  2. A MISSING KEY IS A REFUSAL, NOT AN UNAUTHENTICATED REQUEST. The vendor's
 *     answer to a keyless call is an authentication error that reads like an
 *     outage; the configuration mistake would be discovered as a vendor
 *     problem.
 *  3. NOTHING BUT A USABLE 200 BECOMES A SUCCESS. A 5xx, a 4xx, a thrown fetch
 *     and a 200 carrying something that is not JSON all come back as failed
 *     outcomes, because section 5.6 forbids any of them being mistaken for
 *     "there was no news".
 *
 * NO NETWORK IS TOUCHED. The no-key cases return before a request would be
 * sent, and the rest drive an injected `fetch` that never leaves the process.
 */

import { env } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";

import { COINDESK_ENDPOINTS, envNewsFetcher, newsRequestUrl } from "./news";

const AT = 1_910_000_000_000;
const now = () => AT;

const keyed = { ...env, COINDESK_API_KEY: "not-a-real-key" } as unknown as Env;

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

interface Captured {
  readonly requests: Request[];
}

/** Replace `fetch` with one that records and answers. Never leaves the process. */
function stubFetch(respond: () => Response): Captured {
  const requests: Request[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push(new Request(input as RequestInfo, init));
    return respond();
  }) as typeof fetch;
  return { requests };
}

describe("newsRequestUrl", () => {
  it("pins the assumed host and paths", () => {
    expect(COINDESK_ENDPOINTS).toEqual({
      baseUrl: "https://data-api.coindesk.com",
      categories: "/news/v1/category/list",
      articles: "/news/v1/article/list",
    });
  });

  it("asks the category endpoint with no parameters at all", () => {
    expect(newsRequestUrl({ resource: "categories" })).toBe(
      "https://data-api.coindesk.com/news/v1/category/list",
    );
  });

  it("carries the category and limit as query parameters", () => {
    const url = new URL(newsRequestUrl({ resource: "articles", category: "BTC", limit: 25 }));

    expect(url.origin + url.pathname).toBe(
      "https://data-api.coindesk.com/news/v1/article/list",
    );
    expect(url.searchParams.get("categories")).toBe("BTC");
    expect(url.searchParams.get("limit")).toBe("25");
    expect(url.searchParams.get("lang")).toBe("EN");
  });

  it("escapes a category rather than pasting it into the URL", () => {
    const url = new URL(newsRequestUrl({ resource: "articles", category: "A&B C", limit: 1 }));

    expect(url.searchParams.get("categories")).toBe("A&B C");
  });
});

describe("envNewsFetcher", () => {
  it("refuses when no key is configured, without sending anything", async () => {
    const captured = stubFetch(() => new Response("{}"));

    const outcome = await envNewsFetcher({ resource: "categories" }, env, now);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.message).toContain("COINDESK_API_KEY");
    // Not retryable: a missing secret is not fixed by trying again.
    expect(outcome.retryable).toBe(false);
    expect(outcome.at).toBe(AT);
    expect(captured.requests).toHaveLength(0);
  });

  it("treats a blank key as no key, and still sends nothing", async () => {
    // The assertion that matters is `requests` being empty, not the outcome.
    // A mutation run proved it: with the blank-key branch deleted, a whitespace
    // key fell through to a REAL fetch against CoinDesk, and this test still
    // passed -- an outbound call that is blocked or refused also produces
    // `ok: false`. The test asserted the right conclusion for entirely the
    // wrong reason, and under mutation it pointed the suite at the live API.
    const captured = stubFetch(() => Response.json({ Data: [] }));
    const blank = { ...env, COINDESK_API_KEY: "   " } as unknown as Env;

    const outcome = await envNewsFetcher({ resource: "categories" }, blank, now);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.message).toContain("COINDESK_API_KEY");
    expect(outcome.retryable).toBe(false);
    expect(captured.requests).toHaveLength(0);
  });

  it("sends the key as an Apikey authorization header, never in the URL", async () => {
    // A key in a query string lands in every log, proxy and error message that
    // ever handles the request.
    const captured = stubFetch(() => Response.json({ Data: [] }));

    await envNewsFetcher({ resource: "articles", category: "BTC", limit: 3 }, keyed, now);

    const request = captured.requests[0];
    expect(request?.headers.get("authorization")).toBe("Apikey not-a-real-key");
    expect(request?.url).not.toContain("not-a-real-key");
    expect(request?.method).toBe("GET");
  });

  it("returns the decoded payload untouched, stamped with the caller's clock", async () => {
    const body = { Data: [{ ID: "1" }], Err: {} };
    stubFetch(() => Response.json(body));

    const outcome = await envNewsFetcher({ resource: "categories" }, keyed, now);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value).toEqual(body);
    expect(outcome.at).toBe(AT);
  });

  it("reports an error status as a failed outcome, not an empty payload", async () => {
    for (const [status, kind] of [
      [500, "transport"],
      [429, "exchange_error"],
      [401, "exchange_error"],
    ] as const) {
      stubFetch(() => new Response("nope", { status }));

      const outcome = await envNewsFetcher({ resource: "categories" }, keyed, now);

      expect(outcome.ok).toBe(false);
      if (outcome.ok) return;
      expect(outcome.kind).toBe(kind);
      expect(outcome.status).toBe(status);
    }
  });

  it("reports a thrown fetch as a transport failure", async () => {
    globalThis.fetch = (async () => {
      throw new Error("connect ETIMEDOUT");
    }) as typeof fetch;

    const outcome = await envNewsFetcher({ resource: "categories" }, keyed, now);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.kind).toBe("transport");
    expect(outcome.message).toContain("ETIMEDOUT");
  });

  it("reports a 200 that is not JSON as a failure rather than as no news", async () => {
    stubFetch(() => new Response("<html>maintenance</html>", { status: 200 }));

    const outcome = await envNewsFetcher({ resource: "categories" }, keyed, now);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.kind).toBe("transport");
  });
});
