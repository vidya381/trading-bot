/**
 * The path router (build step 10). Pure string matching, no runtime bindings.
 */

import { describe, expect, it } from "vitest";
import { resolveRoute, route, type ApiContext } from "./router";

const noop = async (_ctx: ApiContext): Promise<Response> => new Response();

const routes = [
  route("GET", "/api/bots", noop),
  route("POST", "/api/bots", noop),
  route("GET", "/api/bots/:id", noop),
  route("POST", "/api/bots/:id/liquidate", noop),
  route("POST", "/api/circuit-breakers/:accountLabel/reset", noop),
];

describe("resolveRoute", () => {
  it("matches a literal path", () => {
    const result = resolveRoute(routes, "GET", "/api/bots");
    expect(result.kind).toBe("match");
  });

  it("captures a :param, URL-decoded", () => {
    const result = resolveRoute(routes, "GET", "/api/bots/dca-btc-1");
    expect(result).toMatchObject({ kind: "match", params: { id: "dca-btc-1" } });

    const encoded = resolveRoute(routes, "POST", "/api/circuit-breakers/team%20a/reset");
    expect(encoded).toMatchObject({ kind: "match", params: { accountLabel: "team a" } });
  });

  it("distinguishes the two /api/bots methods", () => {
    expect(resolveRoute(routes, "GET", "/api/bots").kind).toBe("match");
    expect(resolveRoute(routes, "POST", "/api/bots").kind).toBe("match");
    expect(resolveRoute(routes, "DELETE", "/api/bots")).toMatchObject({
      kind: "method_not_allowed",
      allowed: ["GET", "POST"],
    });
  });

  it("is not_found for an unknown path", () => {
    expect(resolveRoute(routes, "GET", "/api/nope").kind).toBe("not_found");
    // A longer path than any route is not a match.
    expect(resolveRoute(routes, "GET", "/api/bots/x/y/z").kind).toBe("not_found");
  });

  it("ignores a trailing slash", () => {
    expect(resolveRoute(routes, "GET", "/api/bots/").kind).toBe("match");
  });
});
