/**
 * Which exchange a given account resolves to (spec sections 4, 16), step 11.
 *
 * The piece step 3.4 (decision 0) deferred to "its own step": choosing the
 * Binance-vs-Gemini client for an account instead of always building a Binance
 * one. Both `exchange.ts` (`resolveDefaultExchange`, Binance) and
 * `exchange-gemini.ts` (`resolveGeminiExchange`, Gemini) were built symmetric
 * and left unwired on purpose; this is the single seam that dispatches to the
 * right one, keyed by the account's registered `ExchangeId`.
 *
 * Deliberately tiny and total: a `switch` over `ExchangeId` with no default
 * branch, so adding a third exchange fails to compile here until its resolver is
 * wired -- the same "a new value must be handled, not guessed" property the
 * `ExchangeId` union and its D1 CHECK give the data layer. It reuses the two
 * existing resolvers verbatim, so the "impossible to point testnet at production"
 * base-URL derivation and the fail-closed-on-missing-secret behaviour have ONE
 * home each and are not re-implemented here.
 *
 * This is the home the step 3.2 open question 2 asked for -- "when order
 * execution is wired, it should reuse `resolveDefaultExchange`'s base-URL
 * derivation rather than re-deriving it, so the 'impossible to get backwards'
 * property has a single home." Its callers are the account pair-listing
 * endpoint and section 21.4's candle fetch, both through `clientForAccount`
 * below; the future bot-execution wiring reaches for the same function.
 */

import type { ExchangeOutcome } from "../shared/downtime";
import type { RestExchangeClient, Timestamp } from "../shared/exchange-client";
import type { ExchangeId } from "../db/schema";
import { resolveDefaultExchange, type ExchangeResolution } from "./exchange";
import { resolveGeminiExchange } from "./exchange-gemini";

/**
 * Build the `exchangeFor` factory for an account's exchange, or say why it
 * cannot (missing secret, non-trading `ENVIRONMENT`). The reason string is the
 * resolver's own, so it names exactly which secret and how to set it.
 */
export function resolveExchangeForAccount(
  exchange: ExchangeId,
  env: Env,
  now: () => Timestamp,
): ExchangeResolution {
  switch (exchange) {
    case "binance":
      return resolveDefaultExchange(env, now);
    case "gemini":
      return resolveGeminiExchange(env, now);
  }
}

/**
 * A real, ready client for one registered account -- the whole no-bot-required
 * resolution path, in one place.
 *
 * This is the two-step `envSymbolLister` has performed since step 11 (resolve
 * the account's exchange, then ask the resolved factory for a client), named
 * and lifted here because section 21.4's candle fetch needs the SAME client for
 * the SAME reason: an account-scoped call with no bot instance to borrow an
 * attached client from. Written once so there is one answer to "which client
 * does this account get", not one per caller.
 *
 * A resolution failure (missing secret, non-trading `ENVIRONMENT`) is folded
 * into a non-retryable `exchange_error` outcome carrying the resolver's own
 * reason -- which names the exact secret and the command to set it -- so a
 * caller has ONE failure shape covering both "cannot build a client" and, once
 * it makes its call, "the client's call failed".
 */
export function clientForAccount(
  account: { readonly label: string; readonly exchange: ExchangeId },
  env: Env,
  now: () => Timestamp,
): ExchangeOutcome<RestExchangeClient> {
  const resolution = resolveExchangeForAccount(account.exchange, env, now);
  if (!resolution.ok) {
    return {
      ok: false,
      kind: "exchange_error",
      message: resolution.reason,
      retryable: false,
      at: now(),
    };
  }

  const client = resolution.exchangeFor(account.label);
  if (client === null) {
    // `ExchangeFactory` may return null for an account it declines to build a
    // client for. `ok:true` resolutions here always build one, so this is
    // belt-and-braces -- surfaced as a clear failure rather than a null deref.
    return {
      ok: false,
      kind: "exchange_error",
      message: `no exchange client could be built for account ${JSON.stringify(account.label)}`,
      retryable: false,
      at: now(),
    };
  }

  return { ok: true, value: client, at: now() };
}
