/**
 * Kraken as a PUBLIC MARKET-DATA SOURCE, with no credentials at all.
 *
 * Every other way this system reaches Kraken goes through
 * `resolveKrakenExchange`, which reads two secrets and builds a client that can
 * place orders. This file builds one that provably cannot, for the one caller
 * that needs Kraken's numbers and must never be able to act on them: the
 * independent price cross-check (`/src/reconciliation/price-cross-check.ts`).
 *
 * ---------------------------------------------------------------------------
 * WHY A CREDENTIAL-FREE CLIENT IS POSSIBLE AT ALL
 * ---------------------------------------------------------------------------
 * `KrakenClient` takes a `CredentialProvider`, but it does not USE one until it
 * signs something. `KrakenSigner`'s constructor stores a closure
 * (`signing.ts:260`) and calls `getCredentials()` only inside `sign`/
 * `signedRequest`, and `#transport` reaches the signer only on the
 * `spec.signed === true` branch. A public GET -- `AssetPairs`, `Assets`,
 * `Ticker`, `OHLC`, `Time` -- never touches it.
 *
 * So a provider that THROWS is not a hack around a required argument; it is the
 * accurate statement of what this client holds, and it converts "a public-data
 * client was asked to sign" from a request that would leave the process with
 * some other account's key into a local, loud, nothing-was-sent failure.
 * `#transport` already classifies a throw from the signing branch as
 * `reached: false` with the reason stated -- "NOTHING WAS SENT, so no order
 * state is in doubt" -- so the refusal arrives as an ordinary failed outcome
 * naming the cause, not as an unhandled exception.
 *
 * ---------------------------------------------------------------------------
 * ⚠ WHY THIS DOES NOT RE-OPEN ENTRY 90 DECISION 1
 * ---------------------------------------------------------------------------
 * `resolveKrakenExchange` REFUSES to build a client in the testnet environment,
 * and the reason is precise: there is no Kraken sandbox, so a testnet client
 * pointed at `api.kraken.com` would trade real funds from the test environment.
 * That argument is about ORDERS. It is not an argument about reading a public
 * ticker, and this file must not be read as softening it:
 *
 *   * This client has NO CREDENTIALS, so every private endpoint is closed to it
 *     by construction rather than by policy. There is no key for Kraken to
 *     match an order to, and `getCredentials()` throws before a request is
 *     built.
 *   * The base URL is `KRAKEN_BASE_URLS.production` and there is deliberately no
 *     environment parameter. A REFERENCE PRICE THAT IS NOT THE REAL MARKET IS
 *     NOT A REFERENCE -- entry 86's whole finding is that a sandbox publishes
 *     fiction with a fresh timestamp, so pointing the cross-check at a simulator
 *     (if Kraken even had one) would rebuild the exact fault it exists to catch.
 *   * Nothing here decides WHETHER the cross-check runs in a given environment.
 *     That is `price-cross-check.ts`'s decision and it is made on other grounds
 *     entirely; see `CROSS_CHECK_ENVIRONMENTS` there.
 *
 * The property entry 90 protects -- no code path can send a testnet ORDER to a
 * real venue -- is untouched, and is stronger here than at any other Kraken call
 * site, because this client cannot sign one.
 */

import { KrakenCatalogueCache } from "./catalogue";
import { KrakenClient, KRAKEN_BASE_URLS } from "./client";
import { CredentialError, type CredentialProvider } from "../credentials";
import type { ExchangeCredentials } from "../credentials";
import type { Timestamp } from "../../shared/exchange-client";

/**
 * A provider that holds nothing and says so when asked.
 *
 * Not `StaticCredentialProvider` with blank strings: that constructor already
 * refuses blanks (`requireNonBlank`), and defeating it with a placeholder like
 * `"none"` would produce a client that signs a real request with a fake key --
 * a request that LEAVES this process and is rejected at the venue, which is the
 * failure mode `credentials.ts` exists to prevent. Throwing keeps it local.
 */
export class PublicOnlyCredentialProvider implements CredentialProvider {
  getCredentials(): ExchangeCredentials {
    throw new CredentialError(
      "this Kraken client is public-market-data only and holds no credentials, " +
        "so it cannot sign a request. A signed endpoint was reached on a client " +
        "built by `krakenPublicClient` -- that is a wiring bug, not a missing " +
        "secret, and setting KRAKEN_API_KEY will not fix it.",
    );
  }
}

export interface KrakenPublicClientOptions {
  /**
   * Shared so several callers do not each pull the 1.1MB AssetPairs document.
   * AssetPairs is public venue data and not account-scoped, so sharing it is
   * correct as well as cheaper -- the same argument `resolveKrakenExchange`
   * makes for sharing one cache behind every client it hands out.
   */
  readonly catalogueCache?: KrakenCatalogueCache;
  readonly now?: () => Timestamp;
  /** Injected so no test in this repository can fall through to a live venue. */
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}

/**
 * A `KrakenClient` that can read Kraken's public market data and nothing else.
 *
 * Total and un-refusable: it takes no `env`, reads no secret and has no failure
 * mode of its own, because there is no configuration it could be missing. That
 * matters for the caller -- a cross-check that could not tell "Kraken is
 * unreachable" from "this deploy has no Kraken secret" would have to treat both
 * the same way, and one of those is a fact about the venue while the other is a
 * fact about us.
 */
export function krakenPublicClient(options: KrakenPublicClientOptions = {}): KrakenClient {
  return new KrakenClient({
    baseUrl: KRAKEN_BASE_URLS.production,
    credentials: new PublicOnlyCredentialProvider(),
    catalogueCache: options.catalogueCache ?? new KrakenCatalogueCache(),
    ...(options.now !== undefined ? { now: options.now } : {}),
    ...(options.fetch !== undefined ? { fetch: options.fetch } : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
  });
}
