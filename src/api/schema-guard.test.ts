/**
 * The no-schema guard on the dashboard API layer (build step 10.5).
 *
 * The same gap the cron Workers had (src/workers/schema-guard.test.ts), now on
 * the HTTP surface: production is deployed with an empty D1 (migrations deferred
 * to go-live, section 16.1), so a data endpoint's first query throws a raw
 * `no such table: bot_instances` -- which `handleApiRequest`'s catch flattened
 * into a generic `internal_error` 500, indistinguishable from a real bug. The
 * guard is a proactive `db.tableExists("bot_instances")` check: a missing schema
 * returns a specific `no_schema` 503, and any OTHER D1 error still surfaces as
 * internal_error because nothing widened the catch.
 *
 * ORDERING MATTERS IN THIS FILE, exactly as in the Workers version. A test file
 * starts with an empty D1, and within a file the schema persists once
 * `freshDatabase` applies migrations. So the no-schema describe is defined
 * FIRST, before any `freshDatabase` call, which is the only way env.DB is
 * genuinely schema-less. The assertions are self-verifying regardless: if schema
 * had leaked in, the endpoint would return 200 and the `no_schema` check would
 * fail loudly rather than pass silently.
 */

import { env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "../db";
import { freshDatabase } from "../db/test-helpers";
import { handleApiRequest } from "./index";
import { generateSigningKey, signAccessJwt, type SigningKey } from "./test-helpers";

const T0 = 1_900_000_000_000; // future: an armed alarm must not already be overdue (step 20)
const HUMAN = "owner@example.com";

let key: SigningKey;

beforeAll(async () => {
  key = await generateSigningKey();
});

/** A GET through the real `handleApiRequest`, with a valid injected token. */
async function apiGet(path: string, dbOverride?: Database): Promise<{ status: number; body: any }> {
  const token = await signAccessJwt(key, { email: HUMAN, exp: Math.floor(T0 / 1000) + 3600 });
  const request = new Request(`https://dash.example.com${path}`, {
    method: "GET",
    headers: {
      "Cf-Access-Jwt-Assertion": token,
      "Cf-Access-Authenticated-User-Email": HUMAN,
    },
  });
  const response = await handleApiRequest(request, env, {
    now: () => T0,
    access: { now: () => T0, fetchJwks: async () => key.jwks, jwksCache: new Map() },
    ...(dbOverride !== undefined ? { db: dbOverride } : {}),
  });
  return { status: response.status, body: await response.json() };
}

/**
 * A Database whose schema check passes but whose first real query throws a
 * given (non-missing-table) D1 error -- the same double the Workers guard test
 * uses. Proves the guard is a boolean gate that does not intercept a thrown
 * error; it acts ONLY on `tableExists === false`.
 */
function throwingDb(message: string): Database {
  const boom = async (): Promise<never> => {
    throw new Error(message);
  };
  return {
    tableExists: async () => true,
    botInstances: { findMany: boom },
  } as unknown as Database;
}

// ---------------------------------------------------------------------------
// No schema yet -- defined FIRST so env.DB is empty for these.
// ---------------------------------------------------------------------------

describe("no schema yet (production before go-live)", () => {
  it("returns a specific no_schema 503, not a generic internal_error", async () => {
    const res = await apiGet("/api/bots");
    expect(res.status).toBe(503);
    expect(res.body.data).toBeNull();
    expect(res.body.error.code).toBe("no_schema");
    expect(res.body.error.message).toMatch(/migrations are deferred to go-live/i);
  });

  it("guards a different data endpoint too (the check is layer-wide)", async () => {
    // The sentinel is bot_instances, but every migration is one set -- so an
    // endpoint that reads a different table is gated the same way.
    const res = await apiGet("/api/kill-switch");
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe("no_schema");
  });
});

// ---------------------------------------------------------------------------
// Schema present -- testnet, and production after go-live. Behaviour unchanged.
// ---------------------------------------------------------------------------

describe("schema present: behaviour is unchanged", () => {
  beforeEach(async () => {
    await freshDatabase();
  });

  it("GET /api/bots proceeds past the guard and returns data", async () => {
    const res = await apiGet("/api/bots");
    expect(res.status).toBe(200);
    expect(res.body).toStrictEqual({ data: [], error: null });
  });

  it("GET /api/kill-switch proceeds past the guard", async () => {
    const res = await apiGet("/api/kill-switch");
    expect(res.status).toBe(200);
    expect(res.body.data.state).toBe("armed");
  });
});

// ---------------------------------------------------------------------------
// Any other D1 error still surfaces -- the guard suppresses ONLY missing-schema.
// ---------------------------------------------------------------------------

describe("a genuine (non-missing-table) D1 error still surfaces", () => {
  it("does not mask a constraint error as no_schema; it stays internal_error", async () => {
    const res = await apiGet(
      "/api/bots",
      throwingDb("D1_ERROR: NOT NULL constraint failed: SQLITE_CONSTRAINT"),
    );
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe("internal_error");
  });
});
