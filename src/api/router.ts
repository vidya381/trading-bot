/**
 * A minimal path router for the dashboard API, build step 10 (backend API
 * layer).
 *
 * No framework and no dependency: section 2's ethos is native `fetch` and a
 * small, auditable surface, and the routing this layer needs -- a dozen fixed
 * paths, one `:param` each at most -- is a few lines of string matching. A
 * pattern is `/api/bots/:id`; a `:segment` captures one path component,
 * URL-decoded.
 *
 * The matcher distinguishes "no such path" (404) from "path exists, wrong
 * method" (405) so a POST to a GET-only route says so, rather than looking like
 * a missing endpoint.
 */

import type { Database } from "../db/database";
import type { BotInstance } from "../durable-objects/bot-instance";
import type { SymbolLister, SymbolDetailLister } from "../workers/symbols";
import type { CandleLister } from "../workers/candles";
import type { AssessModel } from "../research/assess";

/** Everything a handler is given: the request, the verified actor, and ports. */
export interface ApiContext {
  readonly request: Request;
  readonly env: Env;
  readonly url: URL;
  /** Captured `:param` values, URL-decoded. */
  readonly params: Readonly<Record<string, string>>;
  /** The verified Access email (see access.ts). The `audit_log` actor. */
  readonly actor: string;
  readonly db: Database;
  readonly botNamespace: DurableObjectNamespace<BotInstance>;
  /**
   * Reaches an account's exchange for its tradable pairs. Injected (default
   * `envSymbolLister`) so a test exercises the symbols endpoint's caching
   * without a live exchange call -- the same seam `access.fetchJwks` gives the
   * JWT path.
   */
  readonly symbolLister: SymbolLister;
  /**
   * Reaches an account's exchange for its candles (section 21.4). Injected
   * (default `envCandleLister`) for the same reason `symbolLister` is: the
   * candles endpoint's tests drive every refusal and the truncation reporting
   * without a live exchange call. Separate from `symbolLister` because the two
   * answer different questions of the venue and only one of them is cached.
   */
  readonly candleLister: CandleLister;
  /**
   * Reaches Workers AI for the Assess stage (section 21.4). Injected for the
   * same reason `candleLister` is, and one reason stronger: a test that fell
   * through to the real binding would spend money at a paid vendor, so the
   * default is built from `env` only at the call site and every test supplies a
   * stub. `assess.test.ts` asserts the stub is called exactly once per request.
   */
  readonly assessModel?: AssessModel;
  /**
   * Reaches an account's exchange for ONE symbol's details, which is where a
   * venue that lists both says whether a symbol is spot or a perpetual.
   * Injected (default `envSymbolDetailLister`) for the same reason the two
   * above are. Separate from `symbolLister` because it is a per-symbol,
   * uncached request rather than a cached full-catalogue one.
   */
  readonly symbolDetailLister: SymbolDetailLister;
  readonly now: () => number;
  readonly newId: () => string;
}

export type RouteHandler = (ctx: ApiContext) => Promise<Response>;

export interface Route {
  readonly method: string;
  readonly segments: readonly string[];
  readonly handler: RouteHandler;
}

/** Declare a route. The pattern is split once, here. */
export function route(method: string, pattern: string, handler: RouteHandler): Route {
  return { method, segments: splitPath(pattern), handler };
}

function splitPath(path: string): string[] {
  // A leading "/" yields a leading "" segment; dropping empties makes
  // "/api/bots" and "api/bots/" match the same way.
  return path.split("/").filter((segment) => segment !== "");
}

export type RouteResolution =
  | { readonly kind: "match"; readonly handler: RouteHandler; readonly params: Record<string, string> }
  | { readonly kind: "method_not_allowed"; readonly allowed: readonly string[] }
  | { readonly kind: "not_found" };

/**
 * Resolve a method + pathname against the route table.
 *
 * A path that matches some route's shape but no route's method is
 * `method_not_allowed` with the methods that WOULD have matched; a path that
 * matches no shape is `not_found`.
 */
export function resolveRoute(routes: readonly Route[], method: string, pathname: string): RouteResolution {
  const requested = splitPath(pathname);
  const pathMatchedMethods: string[] = [];

  for (const candidate of routes) {
    const params = matchSegments(candidate.segments, requested);
    if (params === null) continue;
    pathMatchedMethods.push(candidate.method);
    if (candidate.method === method) {
      return { kind: "match", handler: candidate.handler, params };
    }
  }

  if (pathMatchedMethods.length > 0) {
    return { kind: "method_not_allowed", allowed: pathMatchedMethods };
  }
  return { kind: "not_found" };
}

/** Match one route's segments against a request's, capturing `:params`. */
function matchSegments(
  pattern: readonly string[],
  requested: readonly string[],
): Record<string, string> | null {
  if (pattern.length !== requested.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < pattern.length; i += 1) {
    const patternSegment = pattern[i]!;
    const requestedSegment = requested[i]!;
    if (patternSegment.startsWith(":")) {
      params[patternSegment.slice(1)] = decodeURIComponent(requestedSegment);
      continue;
    }
    if (patternSegment !== requestedSegment) return null;
  }
  return params;
}
