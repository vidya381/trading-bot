/**
 * Real, secret-backed Gemini wiring (spec sections 4 and 16).
 *
 * The Gemini counterpart of `exchange.ts`: the binding-aware shell that reads
 * `env`, so `/src/exchange/gemini` stays testable without a Worker runtime. It is
 * built and tested here now, but nothing DISPATCHES to it yet -- choosing Gemini
 * vs Binance for a given bot is a separate step, left unwired on purpose, exactly
 * as production Binance was left unwired at step 3.2 (its open question 1). This
 * module is the ready building block that step will reach for.
 *
 * ---------------------------------------------------------------------------
 * WHY sandbox CAN NEVER HIT PRODUCTION (AND VICE VERSA)
 * ---------------------------------------------------------------------------
 * Identical safety story to `exchange.ts`, and deliberately so. The base URL is
 * NOT a setting; there is no `GEMINI_BASE_URL` var or secret anywhere and there
 * must never be one. The URL is a pure, total function of `env.ENVIRONMENT`
 * (`geminiBaseUrlForEnvironment` below):
 *
 *     testnet    -> https://api.sandbox.gemini.com
 *     production -> https://api.gemini.com
 *     anything else (incl. "unconfigured", "", undefined) -> throws
 *
 * `env.ENVIRONMENT` is a per-environment, non-inheritable `var` in
 * wrangler.jsonc, so the testnet deploy carries `"testnet"` and production
 * carries `"production"`, and neither can carry the other's value. Because the
 * URL is DERIVED from that var rather than configured beside it, there is no
 * combination of settings that points the testnet Worker at real Gemini, and an
 * unrecognised value fails closed (throws) rather than guessing an exchange.
 *
 * Note the environment NAMES are the project's own (`testnet`/`production`),
 * mapped onto Gemini's own terms (`sandbox`/production). The project uses
 * `testnet` for the non-real environment across both exchanges, so the same
 * `ENVIRONMENT` value selects the sandbox host here and the testnet host on the
 * Binance side -- one environment concept, one derivation, per exchange.
 */

import { GeminiClient, GEMINI_BASE_URLS } from "../exchange/gemini/client";
import { resolveAccountField } from "../exchange/gemini/signing";
import { CredentialError, StaticCredentialProvider } from "../exchange/credentials";
import type { RestExchangeClient, Timestamp } from "../shared/exchange-client";
import type { ExchangeFactory } from "./reconciliation";

declare global {
  interface Env {
    /**
     * The Gemini API key/secret for THIS environment's account (section 4.4).
     * Optional because `wrangler types` cannot emit a secret and the base
     * `unconfigured` deploy has neither; absence is a reason to fail closed. Set
     * per environment with `wrangler secret put GEMINI_API_KEY --env <env>` (and
     * the secret). These must be TRADING-only keys, never withdrawal -- see
     * section 4.4 and the `ExchangeCredentials` doc comment. For Gemini, the key
     * should additionally be created with SESSION-SCOPED nonces (so the nonce need
     * only increase within a session), which is what makes the per-client
     * monotonic nonce in `gemini/signing.ts` sufficient.
     */
    readonly GEMINI_API_KEY?: string;
    readonly GEMINI_API_SECRET?: string;
    /**
     * The account nickname a MASTER Gemini key acts on, sent as the top-level
     * `account` field of every signed payload (`gemini/signing.ts`,
     * `resolveAccountField`).
     *
     * Not a secret -- it is a nickname within the group, not a credential -- but
     * it is set the same way for symmetry and because it is per-environment:
     * `wrangler secret put GEMINI_ACCOUNT_NAME --env <env>` (a per-environment
     * `var` works equally well). Required exactly when `GEMINI_API_KEY` is a
     * master key (`master-...`); it must NOT be set for an account-level key
     * (`account-...`), which Gemini refuses with `AccountsOnGroupOnlyApi`.
     */
    readonly GEMINI_ACCOUNT_NAME?: string;
  }
}

/**
 * The Gemini REST base URL for an environment, chosen ONLY from `ENVIRONMENT`.
 *
 * Total on purpose: no default returns a URL. An unrecognised value throws so a
 * misconfiguration fails closed instead of silently picking an exchange -- the
 * same guarantee, and the same enforcement, as `baseUrlForEnvironment` gives on
 * the Binance side.
 */
export function geminiBaseUrlForEnvironment(environment: string | undefined): string {
  switch (environment) {
    case "testnet":
      return GEMINI_BASE_URLS.sandbox;
    case "production":
      return GEMINI_BASE_URLS.production;
    default:
      throw new CredentialError(
        `cannot choose a Gemini base URL: ENVIRONMENT is ${JSON.stringify(environment)}, ` +
          `not "testnet" or "production". Refusing rather than guessing which exchange to reach.`,
      );
  }
}

/** Either a ready factory, or a specific reason it cannot be built. */
export type ExchangeResolution =
  | { readonly ok: true; readonly exchangeFor: ExchangeFactory }
  | { readonly ok: false; readonly reason: string };

/**
 * Build a Gemini `exchangeFor` from `env`, or say why it cannot.
 *
 * Mirrors `resolveDefaultExchange` for Binance: fails closed in the same shape --
 * a clear reason and no run -- rather than returning a client built against
 * absent credentials that would surface later as an opaque signature error. The
 * secret value never appears in a message.
 *
 * Unlike the Binance resolver, this takes no `RateLimiter` binding: Gemini sends
 * no used-weight header for a client to report, so there is no reporting loop to
 * close here. The request-count gate a Gemini account needs is applied by the
 * wrapper at dispatch time, which is out of scope for this step.
 */
export function resolveGeminiExchange(
  env: Env,
  now: () => Timestamp,
): ExchangeResolution {
  const environment = env.ENVIRONMENT;
  if (environment !== "testnet" && environment !== "production") {
    return {
      ok: false,
      reason:
        `ENVIRONMENT is ${JSON.stringify(environment)}, not a trading environment ` +
        `("testnet" or "production"), so no Gemini client can be built. This is ` +
        `expected for a bare \`wrangler deploy\` with no --env.`,
    };
  }

  // Derived from ENVIRONMENT alone -- `environment` is narrowed to a known value
  // here, so this cannot throw, but the throwing form is what a caller deriving
  // the URL directly would use.
  const baseUrl = geminiBaseUrlForEnvironment(environment);

  const apiKey = env.GEMINI_API_KEY;
  const apiSecret = env.GEMINI_API_SECRET;
  const missing: string[] = [];
  if (apiKey === undefined || apiKey.trim() === "") missing.push("GEMINI_API_KEY");
  if (apiSecret === undefined || apiSecret.trim() === "") missing.push("GEMINI_API_SECRET");
  if (missing.length > 0) {
    return {
      ok: false,
      reason:
        `no ${missing.join(" or ")} secret in the ${environment} environment, so no ` +
        `Gemini client can be built. Set ${missing.length === 2 ? "them" : "it"} with ` +
        `\`wrangler secret put ${missing[0]} --env ${environment}\`` +
        `${missing.length === 2 ? ` (and \`${missing[1]}\`)` : ""}.`,
    };
  }

  // The master-key `account` rule (section 4.2, Gemini's sub-account model),
  // checked HERE and not only inside the client: a resolution failure becomes a
  // `not_attached` halt naming the misconfiguration, which is what an operator
  // needs, whereas discovering it per-request means every order is refused one at
  // a time. `resolveAccountField` is the same pure decision the client applies, so
  // the two cannot disagree.
  const accountName = env.GEMINI_ACCOUNT_NAME;
  const account = resolveAccountField(apiKey!, accountName);
  if (!account.ok) {
    return {
      ok: false,
      reason:
        `Gemini credentials in the ${environment} environment cannot be used: ` +
        `${account.reason}`,
    };
  }

  // StaticCredentialProvider re-checks blankness and throws CredentialError; the
  // check above returns a clean reason first, so it only ever sees good values.
  const credentials = new StaticCredentialProvider({ apiKey: apiKey!, apiSecret: apiSecret! });

  const exchangeFor: ExchangeFactory = (_accountLabel: string): RestExchangeClient =>
    new GeminiClient({ baseUrl, credentials, accountName: account.account, now });

  return { ok: true, exchangeFor };
}
