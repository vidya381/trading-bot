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
 * property has a single home." Today its one caller is the account
 * pair-listing endpoint; the future bot-execution wiring reaches for the same
 * function.
 */

import type { Timestamp } from "../shared/exchange-client";
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
