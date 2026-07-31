/**
 * The dashboard API layer (spec step 10, backend half), build step 10.
 *
 * `handleApiRequest` is the one entry point the Worker calls for every `/api/*`
 * request. It does three things and nothing else:
 *
 *   1. AUTHENTICATE. Build the Access verifier from the environment and verify
 *      the request's JWT (access.ts). This runs BEFORE routing, so an
 *      unauthenticated caller learns nothing about which routes exist, and an
 *      unconfigured verifier refuses everything with a 503 rather than falling
 *      back to trusting a header.
 *   2. ROUTE. Match the method and path against the table below.
 *   3. DISPATCH inside one try/catch, so every handler can simply `throw` and
 *      the failure becomes the right JSON envelope with the right status
 *      (envelope.ts).
 *
 * No business logic lives here or in any handler -- see handlers.ts. This file
 * is the wiring: verifier, router, context, error funnel.
 *
 * `/health` is deliberately NOT part of this surface. It is handled in the
 * Worker before delegation (src/workers/api.ts), unauthenticated, because it is
 * the post-deploy version/environment probe (sections 16, 11.3) and must be
 * reachable to confirm a deploy without a session.
 */

import { accessConfigFromEnv, authenticate, type AccessConfig } from "./access";
import { handleFeedCheck } from "./debug-feed-check"; // TEMPORARY DIAGNOSTIC — see block below.
import { errorResponse, fail, ApiError } from "./envelope";
import * as handlers from "./handlers";
import { resolveRoute, route, type ApiContext, type Route } from "./router";
import { databaseFrom, type Database } from "../db";
import type { BotInstance } from "../durable-objects/bot-instance";
import { envSymbolLister, type SymbolLister } from "../workers/symbols";

const ROUTES: readonly Route[] = [
  route("GET", "/api/bots", handlers.listBots),
  route("POST", "/api/bots", handlers.createBot),
  route("GET", "/api/bots/:id", handlers.getBot),
  route("POST", "/api/bots/:id/start", handlers.startBot),
  route("POST", "/api/bots/:id/liquidate", handlers.liquidateBot),
  route("GET", "/api/accounts", handlers.listAccounts),
  route("GET", "/api/accounts/:label/symbols", handlers.getAccountSymbols),
  route("GET", "/api/alerts", handlers.listAlerts),
  route("POST", "/api/manual-adjustments", handlers.createManualAdjustment),
  route("GET", "/api/circuit-breakers", handlers.listCircuitBreakers),
  route("POST", "/api/circuit-breakers/:accountLabel/reset", handlers.resetCircuitBreaker),
  route("GET", "/api/kill-switch", handlers.getKillSwitch),
  route("POST", "/api/kill-switch/trigger", handlers.triggerKillSwitch),
  route("POST", "/api/kill-switch/reset", handlers.resetKillSwitch),
  route("GET", "/api/reconciliation", handlers.listReconciliationRuns),
];

/**
 * What a caller may inject. The Worker leaves everything defaulted; tests supply
 * the clock, the id source, and -- crucially -- the Access verifier's JWKS
 * fetcher and clock via `access`, so a test signs its own tokens without a
 * network fetch. The `aud` and team domain are never injectable (see
 * `accessConfigFromEnv`): the code path that reads the real secret is always the
 * one under test.
 */
export interface ApiOptions {
  readonly now?: () => number;
  readonly newId?: () => string;
  readonly db?: Database;
  readonly botNamespace?: DurableObjectNamespace<BotInstance>;
  readonly access?: Pick<AccessConfig, "now" | "fetchJwks" | "jwksCache">;
  /** Injected by tests so the symbols endpoint makes no live exchange call. */
  readonly symbolLister?: SymbolLister;
}

function requireBotNamespace(
  env: Env,
  override?: DurableObjectNamespace<BotInstance>,
): DurableObjectNamespace<BotInstance> {
  const namespace = override ?? env.BOT_INSTANCE;
  if (namespace === undefined) {
    throw new ApiError(
      503,
      "no_bot_instance_binding",
      "no BOT_INSTANCE binding in this environment. Only testnet and production declare one; " +
        "a deploy with no --env has neither a database nor any bots.",
    );
  }
  return namespace;
}

/** Handle one `/api/*` request end to end. */
export async function handleApiRequest(
  request: Request,
  env: Env,
  options: ApiOptions = {},
): Promise<Response> {
  const url = new URL(request.url);

  try {
    // 1. Authenticate before anything else.
    const config = accessConfigFromEnv(env, options.access ?? {});
    const actor = await authenticate(request, config);

    // ─── TEMPORARY DIAGNOSTIC — /api/debug/feed-check (decision-log 14.7, Tier 1) ─
    // DELETE AFTER ONE CONFIRMING RUN. Removal = delete this block and the
    // `handleFeedCheck` import above, delete src/api/debug-feed-check.ts and its
    // test, and delete the marked `debugSnapshot` block in price-feed.ts.
    // Wired here — AFTER authenticate() (behind Access + the JWT re-check, exactly
    // like every real route, with no new Access surface) but BEFORE the schema guard
    // and ApiContext, because it needs neither the BOT_INSTANCE binding nor the
    // guard: it runs its OWN, narrower `alerts` table check and explains what a
    // missing schema would do to the result. Same placement as the removed
    // /api/debug/ws-check (14.6) and /api/debug/exchange-check (decision-log 03).
    // Read-only market data; no bot, no order path, no credentials.
    // NOTE: this route deliberately holds the request open for up to ~3 minutes.
    if (request.method === "GET" && url.pathname === "/api/debug/feed-check") {
      return await handleFeedCheck(url, env);
    }
    // ─── END TEMPORARY DIAGNOSTIC ───────────────────────────────────────────────

    // 2. Route.
    const resolution = resolveRoute(ROUTES, request.method, url.pathname);
    if (resolution.kind === "not_found") {
      return fail(404, "not_found", `no API route for ${request.method} ${url.pathname}`);
    }
    if (resolution.kind === "method_not_allowed") {
      const body = { data: null, error: { code: "method_not_allowed", message: `${request.method} is not allowed on ${url.pathname}` } };
      return new Response(JSON.stringify(body), {
        status: 405,
        headers: {
          "content-type": "application/json; charset=utf-8",
          Allow: resolution.allowed.join(", "),
        },
      });
    }

    // 3. Schema guard. Production is deployed with an empty D1 until go-live
    //    (section 16.1); without this, a data endpoint's first query throws a
    //    raw `no such table` that the catch below flattens into a generic 500,
    //    indistinguishable from a real bug. This is the SAME proactive
    //    `tableExists` check the cron Workers use (src/workers/reconciliation.ts,
    //    schema-guard.test.ts): a boolean gate, NOT a try/catch, so ONLY the
    //    missing-schema case is special-cased and any other D1 error still
    //    surfaces below as internal_error. `bot_instances` is the sentinel --
    //    every migration runs as one set, so if it is absent they all are.
    const db = options.db ?? databaseFrom(env);
    if (!(await db.tableExists("bot_instances"))) {
      return fail(
        503,
        "no_schema",
        "this environment has no database schema yet, migrations are deferred to go-live",
      );
    }

    // 4. Build the context and dispatch.
    const ctx: ApiContext = {
      request,
      env,
      url,
      params: resolution.params,
      actor,
      db,
      botNamespace: requireBotNamespace(env, options.botNamespace),
      symbolLister: options.symbolLister ?? envSymbolLister,
      now: options.now ?? (() => Date.now()),
      newId: options.newId ?? (() => crypto.randomUUID()),
    };
    return await resolution.handler(ctx);
  } catch (error) {
    return errorResponse(error);
  }
}
