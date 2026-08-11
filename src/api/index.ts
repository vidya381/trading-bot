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
import { errorResponse, fail, ApiError } from "./envelope";
import * as handlers from "./handlers";
import { resolveRoute, route, type ApiContext, type Route } from "./router";
import { databaseFrom, type Database } from "../db";
import type { BotInstance } from "../durable-objects/bot-instance";
import {
  envSymbolLister,
  envSymbolDetailLister,
  type SymbolLister,
  type SymbolDetailLister,
} from "../workers/symbols";
import { envCandleLister, type CandleLister } from "../workers/candles";

const ROUTES: readonly Route[] = [
  route("GET", "/api/bots", handlers.listBots),
  route("POST", "/api/bots", handlers.createBot),
  route("GET", "/api/bots/:id", handlers.getBot),
  route("POST", "/api/bots/:id/start", handlers.startBot),
  route("POST", "/api/bots/:id/halt", handlers.haltBot),
  route("POST", "/api/bots/:id/resume", handlers.resumeBot),
  route("POST", "/api/bots/:id/liquidate", handlers.liquidateBot),
  route("POST", "/api/bots/:id/apply-missed-fills", handlers.applyMissedFills),
  route("POST", "/api/bots/:id/check-open-orders", handlers.checkOpenOrders),
  route("POST", "/api/bots/:id/archive", handlers.archiveBot),
  route("POST", "/api/bots/:id/unarchive", handlers.unarchiveBot),
  route("GET", "/api/accounts", handlers.listAccounts),
  route("GET", "/api/accounts/:label/symbols", handlers.getAccountSymbols),
  // Section 21.4 Stage 1's candle fetch (/src/research/candles.ts). Read-only,
  // and the only way its truncation reporting can be checked against a REAL
  // venue window rather than a modelled one.
  route("GET", "/api/accounts/:label/candles", handlers.getAccountCandles),
  // Section 21.4 Stage 1's ASSEMBLY (/src/research/gather.ts). Read-only, and
  // the only way decision log 35's open question can be answered: it is the
  // first caller in this system to issue N venue candle requests under one
  // request, which no test can measure because every test drives a stub.
  route("GET", "/api/accounts/:label/gather", handlers.getAccountGather),
  // Section 21.3's watchlist (migration 0008, /src/research/watchlist.ts). The
  // dashboard control for these is deliberately a later step; today they are the
  // curl-callable surface that replaces editing the table by hand.
  route("GET", "/api/watchlist", handlers.listWatchlist),
  route("POST", "/api/watchlist", handlers.addWatchlistEntry),
  route("DELETE", "/api/watchlist/:id", handlers.removeWatchlistEntry),
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
  /** Injected by tests so the candles endpoint makes no live exchange call. */
  readonly candleLister?: CandleLister;
  /**
   * Injected by tests so bot creation's spot-instrument check makes no live
   * exchange call.
   */
  readonly symbolDetailLister?: SymbolDetailLister;
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
      candleLister: options.candleLister ?? envCandleLister,
      symbolDetailLister: options.symbolDetailLister ?? envSymbolDetailLister,
      now: options.now ?? (() => Date.now()),
      newId: options.newId ?? (() => crypto.randomUUID()),
    };
    return await resolution.handler(ctx);
  } catch (error) {
    return errorResponse(error);
  }
}
