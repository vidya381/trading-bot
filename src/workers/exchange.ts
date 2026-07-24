/**
 * Real, secret-backed exchange wiring (spec sections 4 and 16), step 3.2.
 *
 * This is the piece `src/exchange/credentials.ts` promised and deliberately did
 * NOT contain: "the real, secret-backed implementation is a thin wrapper over
 * `env`, added at the point this actually deploys." That point is now. It lives
 * here, in the binding-aware Worker shell, rather than in `/src/exchange`, for
 * the same reason everything in `/src/workers` does -- reading `env` is a
 * binding concern, and `/src/exchange` stays testable without one.
 *
 * ---------------------------------------------------------------------------
 * WHY testnet CAN NEVER HIT PRODUCTION (AND VICE VERSA)
 * ---------------------------------------------------------------------------
 * The base URL is NOT a setting. There is no `BINANCE_BASE_URL` var or secret
 * anywhere in this project, and there must never be one. The URL is a pure,
 * total function of `env.ENVIRONMENT` (`baseUrlForEnvironment` below):
 *
 *     testnet    -> https://testnet.binance.vision
 *     production -> https://api.binance.com
 *     anything else (incl. "unconfigured", "", undefined) -> throws
 *
 * `env.ENVIRONMENT` is a per-environment `var` in wrangler.jsonc, and Wrangler
 * `vars` are NON-INHERITABLE between environments -- the same property the
 * config already leans on to keep the two D1 `database_id`s from ever being
 * shared. So the testnet deploy carries `ENVIRONMENT: "testnet"` and the
 * production deploy carries `ENVIRONMENT: "production"`, and neither can carry
 * the other's value.
 *
 * Because the URL is DERIVED from that var rather than configured beside it,
 * there is no combination of settings that points the testnet Worker at real
 * Binance. To do it you would have to set `ENVIRONMENT: "production"` on the
 * testnet deploy -- which is not a quiet swap of one URL: it also flips what
 * `/health` reports, which D1 database is bound (a different `database_id`),
 * and the dashboard's environment banner. You would be deploying "production"
 * in every visible respect, not accidentally leaking into it.
 *
 * And the switch has NO default branch that yields a URL: an unrecognised
 * `ENVIRONMENT` throws rather than guessing, so a typo or a missing var fails
 * closed instead of silently choosing an exchange. `exchange.test.ts` pins the
 * mapping in both directions, so a future edit that swaps the two lines fails
 * CI rather than shipping.
 */

import { BinanceClient, BINANCE_BASE_URLS } from "../exchange/binance/client";
import { CredentialError, StaticCredentialProvider } from "../exchange/credentials";
import type { RateLimiter } from "../durable-objects/rate-limiter";
import type { RestExchangeClient, Timestamp } from "../shared/exchange-client";
import type { ExchangeFactory } from "./reconciliation";

declare global {
  interface Env {
    /**
     * The exchange API key/secret for THIS environment's account (section 4.4).
     * Optional because `wrangler types` cannot emit a secret and because the
     * base `unconfigured` deploy has neither; the shell treats their absence as
     * a reason to fail closed. Set per environment with
     * `wrangler secret put BINANCE_API_KEY --env <env>` (and the secret).
     * These must be TRADING-only keys, never withdrawal -- see section 4.4 and
     * the `ExchangeCredentials` doc comment.
     */
    readonly BINANCE_API_KEY?: string;
    readonly BINANCE_API_SECRET?: string;
  }
}

/**
 * The Binance REST base URL for an environment, chosen ONLY from `ENVIRONMENT`.
 *
 * Total on purpose: there is no default that returns a URL. An unrecognised
 * value throws, so a misconfiguration fails closed instead of silently picking
 * an exchange. See this file's header for why this is the whole safety story.
 */
export function baseUrlForEnvironment(environment: string | undefined): string {
  switch (environment) {
    case "testnet":
      return BINANCE_BASE_URLS.testnet;
    case "production":
      return BINANCE_BASE_URLS.production;
    default:
      throw new CredentialError(
        `cannot choose a Binance base URL: ENVIRONMENT is ${JSON.stringify(environment)}, ` +
          `not "testnet" or "production". Refusing rather than guessing which exchange to reach.`,
      );
  }
}

/** Either a ready factory, or a specific reason the pass must not run. */
export type ExchangeResolution =
  | { readonly ok: true; readonly exchangeFor: ExchangeFactory }
  | { readonly ok: false; readonly reason: string };

/**
 * Build the production `exchangeFor` from `env`, or say why it cannot.
 *
 * Used only when nothing is injected -- tests supply their own `exchangeFor`
 * (a `FakeExchange`) and never reach this, so the automated suite never depends
 * on a real secret and never makes a network call.
 *
 * Fails closed, in the shape the other guards in `./reconciliation.ts` and the
 * `DISCORD_WEBHOOK_URL` check in `./notifications.ts` use: a clear reason and no
 * run, rather than a client built against absent credentials that would surface
 * later as an opaque signature error.
 */
export function resolveDefaultExchange(
  env: Env,
  now: () => Timestamp,
): ExchangeResolution {
  const environment = env.ENVIRONMENT;
  if (environment !== "testnet" && environment !== "production") {
    return {
      ok: false,
      reason:
        `ENVIRONMENT is ${JSON.stringify(environment)}, not a trading environment ` +
        `(\"testnet\" or \"production\"), so no exchange client can be built. This is ` +
        `expected for a bare \`wrangler deploy\` with no --env.`,
    };
  }

  // Derived from ENVIRONMENT alone -- see the header. `environment` is narrowed
  // to a known value here, so this cannot throw, but the throwing form is what
  // the eventual bot wiring and the tests use directly.
  const baseUrl = baseUrlForEnvironment(environment);

  const apiKey = env.BINANCE_API_KEY;
  const apiSecret = env.BINANCE_API_SECRET;
  const missing: string[] = [];
  if (apiKey === undefined || apiKey.trim() === "") missing.push("BINANCE_API_KEY");
  if (apiSecret === undefined || apiSecret.trim() === "") missing.push("BINANCE_API_SECRET");
  if (missing.length > 0) {
    return {
      ok: false,
      reason:
        `no ${missing.join(" or ")} secret in the ${environment} environment, so no ` +
        `exchange client can be built. Set ${missing.length === 2 ? "them" : "it"} with ` +
        `\`wrangler secret put ${missing[0]} --env ${environment}\`` +
        `${missing.length === 2 ? ` (and \`${missing[1]}\`)` : ""}.`,
    };
  }

  // StaticCredentialProvider re-checks blankness and throws CredentialError; the
  // check above returns a clean reason first, so it only ever sees good values.
  // The value itself never appears in any message here or there.
  const credentials = new StaticCredentialProvider({
    apiKey: apiKey!,
    apiSecret: apiSecret!,
  });

  // The account's section 5.4 budget. The caller's RATE_LIMITER guard already
  // returns before here when the binding is absent; this repeats the check so
  // the function is self-contained and fails closed rather than asserting.
  // Handed to the client as its weight REPORTER (not its gate -- the gate is
  // `withRateLimit`, applied by the caller). This closes the loop the
  // RateLimiter Durable Object was built to receive: the client feeds back the
  // exchange's own `X-MBX-USED-WEIGHT` header via `syncFromExchange`, so the
  // account-wide budget is corrected by real usage rather than running on
  // reserved estimates alone.
  const rateLimiterNamespace = env.RATE_LIMITER;
  if (rateLimiterNamespace === undefined) {
    return {
      ok: false,
      reason:
        `no RATE_LIMITER binding in the ${environment} environment, so an exchange ` +
        `client cannot report used weight into section 5.4's budget.`,
    };
  }
  const exchangeFor: ExchangeFactory = (accountLabel: string): RestExchangeClient => {
    const limiter = rateLimiterNamespace.get(
      rateLimiterNamespace.idFromName(accountLabel),
    ) as DurableObjectStub<RateLimiter>;
    return new BinanceClient({ baseUrl, credentials, now, rateLimiter: limiter });
  };

  return { ok: true, exchangeFor };
}
