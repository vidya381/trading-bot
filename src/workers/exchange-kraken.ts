/**
 * Real, secret-backed Kraken wiring (spec sections 4 and 16, decision log entry
 * 90 PART 5, entry 94's remaining-work item 1).
 *
 * The Kraken counterpart of `exchange.ts` and `exchange-gemini.ts`: the
 * binding-aware shell that reads `env`, so `/src/exchange/kraken` stays testable
 * without a Worker runtime. It follows `exchange-gemini.ts` rather than
 * `exchange.ts` for the same reason `KrakenClient` follows `GeminiClient` --
 * Kraken authenticates with a monotonic nonce and sends no used-weight header,
 * so there is no `RateLimiter` binding to thread through and no reporting loop
 * to close here.
 *
 * ---------------------------------------------------------------------------
 * WHY THERE IS NO testnet BRANCH -- ENTRY 90 DECISION 1
 * ---------------------------------------------------------------------------
 * The other two venues derive a base URL as a pure, total function of
 * `env.ENVIRONMENT`, mapping `testnet` and `production` onto two real hosts.
 * That derivation is what makes it structurally impossible to point the testnet
 * Worker at production: there is no `*_BASE_URL` var or secret anywhere, and
 * there must never be one.
 *
 * KRAKEN HAS NO SANDBOX. Entry 89 PART 2 established this against the live
 * venue: `demo-futures.kraken.com` 301s every path including root to marketing,
 * and spot UAT is account-manager-only with no public host. So there is no
 * second host to map `testnet` onto, and entry 90 DECISION 1 settles what
 * happens instead:
 *
 *     production -> https://api.kraken.com
 *     testnet    -> REFUSED. No client is constructed.
 *     anything else (incl. "unconfigured", "", undefined) -> refused
 *
 * A Kraken account cannot exist in the testnet environment. The two options that
 * would have made one appear to work were both rejected on the record, and the
 * reasons are worth keeping next to the code:
 *
 *  - Pointing BOTH environments at `https://api.kraken.com` and relying on a
 *    separate low-limit key in testnet. This destroys the guarantee outright:
 *    safety would rest on WHICH KEY AN OPERATOR PASTED INTO WHICH ENVIRONMENT'S
 *    SECRET -- revocable by a typo -- instead of on a derivation with no branch
 *    capable of producing the wrong host.
 *  - Serving a `FakeExchange` under Kraken's name in testnet. Safe on the
 *    network and worse epistemically: entry 89 ruled OKX out precisely because
 *    its demo feed was "healthy, fresh and well-formed while describing a market
 *    that does not exist", and entry 86 built detectors for that condition.
 *
 * `KRAKEN_BASE_URLS` holds exactly one entry, so this file CANNOT accidentally
 * produce a testnet host -- there is not one to produce. What this file adds is
 * the refusal itself, in the place the refusal belongs.
 *
 * The accepted cost, stated plainly because entry 90 states it plainly: no
 * Kraken code path can be exercised end-to-end outside production. That does not
 * resolve entry 88's 22.7 observation-period dependency and does not claim to.
 */

import { KrakenClient, KRAKEN_BASE_URLS } from "../exchange/kraken/client";
import { KrakenCatalogueCache } from "../exchange/kraken/catalogue";
import { decodeApiSecret, SigningError } from "../exchange/kraken/signing";
import { CredentialError, StaticCredentialProvider } from "../exchange/credentials";
import type { RestExchangeClient, Timestamp } from "../shared/exchange-client";
import type { ExchangeFactory } from "./reconciliation";
// The type is IMPORTED rather than re-declared. `exchange.ts` and
// `exchange-gemini.ts` each carry their own structurally identical copy; a third
// would be the point at which the shape starts drifting between venues, and
// `exchange-dispatch.ts` already imports this one to type all three branches.
import type { ExchangeResolution } from "./exchange";

declare global {
  interface Env {
    /**
     * The Kraken API key/secret for THIS environment's account (section 4.4).
     * Optional because `wrangler types` cannot emit a secret and the base
     * `unconfigured` deploy has neither; absence is a reason to fail closed. Set
     * with `wrangler secret put KRAKEN_API_KEY --env production` (and the
     * secret). These must be TRADING-only keys, never withdrawal -- see section
     * 4.4 and the `ExchangeCredentials` doc comment.
     *
     * Only ever set on PRODUCTION. There is no Kraken testnet to set them for,
     * and `resolveKrakenExchange` refuses that environment before it reads them.
     *
     * `KRAKEN_API_SECRET` differs from both other venues' secrets in kind, not
     * just value: it is BASE64 that must DECODE to the raw HMAC key, so a
     * truncated or re-typed paste is detectable here rather than at the venue.
     * `decodeApiSecret` is what detects it, and this resolver runs it.
     */
    readonly KRAKEN_API_KEY?: string;
    readonly KRAKEN_API_SECRET?: string;
  }
}

/**
 * The Kraken REST base URL for an environment -- total over exactly ONE value.
 *
 * The same contract as `baseUrlForEnvironment` and `geminiBaseUrlForEnvironment`
 * (no default returns a URL, an unrecognised value throws rather than guessing
 * an exchange), with one venue-specific difference: `"testnet"` is a RECOGNISED
 * value that still has no URL, so it gets its own message naming the absence of
 * a Kraken sandbox instead of the generic "not a trading environment" one. An
 * operator who set `ENVIRONMENT: "testnet"` has not made a typo, and telling
 * them they have would send them looking for the wrong thing.
 */
export function krakenBaseUrlForEnvironment(environment: string | undefined): string {
  switch (environment) {
    case "production":
      return KRAKEN_BASE_URLS.production;
    case "testnet":
      throw new CredentialError(
        `cannot choose a Kraken base URL: Kraken has no sandbox or testnet host, ` +
          `so ENVIRONMENT "testnet" has no URL to map to. Refusing rather than ` +
          `returning the production host, which would make testnet trade real ` +
          `funds (decision log entry 90 DECISION 1).`,
      );
    default:
      throw new CredentialError(
        `cannot choose a Kraken base URL: ENVIRONMENT is ${JSON.stringify(environment)}, ` +
          `not "production". Refusing rather than guessing which exchange to reach.`,
      );
  }
}

/**
 * Build a Kraken `exchangeFor` from `env`, or say why it cannot.
 *
 * Mirrors `resolveDefaultExchange` and `resolveGeminiExchange`: fails closed in
 * the same shape -- a clear reason and no run -- rather than returning a client
 * built against absent credentials that would surface later as an opaque
 * signature error. The secret value never appears in a message.
 *
 * HOW A REFUSAL REACHES A CALLER. There is no separate error type for "this
 * venue is unavailable in this environment", and this file deliberately does not
 * introduce one: `{ ok: false, reason }` IS that pattern here. `clientForAccount`
 * folds any `ok: false` into a non-retryable `exchange_error` carrying this
 * reason verbatim, and `describeUnwiredExchange` states the neighbouring
 * "unavailable in this build" fact the same way -- as prose an operator reads,
 * not a code they branch on. A caller distinguishes the testnet refusal by the
 * fact that it is non-retryable and names the environment; nothing downstream
 * needs to branch on WHICH refusal it was, because the response to every one of
 * them is identical: do not trade, show the operator the reason.
 *
 * THE ORDER OF THE CHECKS IS LOAD-BEARING. The testnet refusal comes BEFORE the
 * secret checks, and must stay there. A testnet deploy that happens to carry
 * Kraken secrets would otherwise be told nothing at all is wrong until it looked
 * for a host, and a testnet deploy WITHOUT them would be told to go and set a
 * secret -- sending an operator to fix a missing credential when the real answer
 * is that this venue cannot be traded in this environment at any credential.
 */
export function resolveKrakenExchange(
  env: Env,
  now: () => Timestamp,
): ExchangeResolution {
  const environment = env.ENVIRONMENT;
  if (environment !== "testnet" && environment !== "production") {
    return {
      ok: false,
      reason:
        `ENVIRONMENT is ${JSON.stringify(environment)}, not a trading environment ` +
        `("testnet" or "production"), so no Kraken client can be built. This is ` +
        `expected for a bare \`wrangler deploy\` with no --env.`,
    };
  }

  // Entry 90 DECISION 1, and the whole reason this file differs from its two
  // siblings. Checked before the secrets -- see the docblock.
  if (environment === "testnet") {
    return {
      ok: false,
      reason:
        `Kraken cannot be traded in the testnet environment: Kraken publishes no ` +
        `sandbox or testnet host (demo-futures.kraken.com serves marketing, and ` +
        `spot UAT is account-manager-only), so there is no non-real venue to ` +
        `reach. Refusing to build a client rather than pointing testnet at ` +
        `https://api.kraken.com, which would trade real funds from the test ` +
        `environment. Setting KRAKEN_API_KEY/KRAKEN_API_SECRET here will not ` +
        `change this. Use binance or gemini for testnet, and register Kraken ` +
        `accounts on production only.`,
    };
  }

  // Derived from ENVIRONMENT alone -- `environment` is narrowed to "production"
  // here, so this cannot throw, but the throwing form is what a caller deriving
  // the URL directly would use.
  const baseUrl = krakenBaseUrlForEnvironment(environment);

  const apiKey = env.KRAKEN_API_KEY;
  const apiSecret = env.KRAKEN_API_SECRET;
  const missing: string[] = [];
  if (apiKey === undefined || apiKey.trim() === "") missing.push("KRAKEN_API_KEY");
  if (apiSecret === undefined || apiSecret.trim() === "") missing.push("KRAKEN_API_SECRET");
  if (missing.length > 0) {
    return {
      ok: false,
      reason:
        `no ${missing.join(" or ")} secret in the ${environment} environment, so no ` +
        `Kraken client can be built. Set ${missing.length === 2 ? "them" : "it"} with ` +
        `\`wrangler secret put ${missing[0]} --env ${environment}\`` +
        `${missing.length === 2 ? ` (and \`${missing[1]}\`)` : ""}.`,
    };
  }

  // The base64 rule (`signing.ts`), checked HERE and not only at signing time.
  // This is the Kraken analogue of the master-key `account` check
  // `resolveGeminiExchange` hoists, and it is hoisted for the identical reason:
  // a resolution failure becomes ONE `not_attached` halt naming the
  // misconfiguration, which is what an operator needs, whereas discovering it
  // per-request means every order is refused one at a time by an
  // `EAPI:Invalid signature` that does not say the secret was mistyped.
  //
  // `decodeApiSecret` is the same pure decision the signer applies, so the two
  // cannot disagree. It THROWS -- that is the right shape at signing time, and
  // the wrong one here -- so it is converted, and only `SigningError` is
  // converted: anything else is a bug in this code, not a bad secret, and must
  // not be reported to an operator as one.
  try {
    decodeApiSecret(apiSecret!);
  } catch (error) {
    if (!(error instanceof SigningError)) throw error;
    return {
      ok: false,
      reason:
        `the KRAKEN_API_SECRET in the ${environment} environment is unusable: ` +
        `${error.message}`,
    };
  }

  // StaticCredentialProvider re-checks blankness and throws CredentialError; the
  // checks above return a clean reason first, so it only ever sees good values.
  const credentials = new StaticCredentialProvider({ apiKey: apiKey!, apiSecret: apiSecret! });

  // ONE catalogue cache behind every client this factory hands out, which is the
  // arrangement `KrakenClientOptions.catalogueCache` documents itself as
  // existing for. AssetPairs is ~1.1MB and is PUBLIC venue data -- not
  // account-scoped -- so sharing it across accounts is correct as well as
  // cheaper, and a per-client default cache would re-fetch it per account. There
  // is deliberately no second filter cache: on Kraken filters are derived from
  // this same document and carry its `fetchedAt`.
  const catalogueCache = new KrakenCatalogueCache();

  const exchangeFor: ExchangeFactory = (_accountLabel: string): RestExchangeClient =>
    new KrakenClient({ baseUrl, credentials, catalogueCache, now });

  return { ok: true, exchangeFor };
}
