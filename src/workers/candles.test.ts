/**
 * The real, account-scoped route to `getCandles`, and the client resolution it
 * shares with the symbol listing.
 *
 * Two things are worth asserting here and nothing else is:
 *
 *  1. `clientForAccount` DISPATCHES TO THE RIGHT RESOLVER. The test env has no
 *     BINANCE_/GEMINI_ secrets, so each resolver fails closed -- and which
 *     secret the refusal NAMES is what proves the dispatch went to the right
 *     one. This is the same technique `symbols.test.ts` already uses on
 *     `envSymbolLister`, which now goes through this function.
 *  2. `envCandleLister` RETURNS THAT REFUSAL AS AN `ExchangeOutcome` rather
 *     than throwing or returning an empty candle list. A caller must have one
 *     failure shape covering "no client could be built" and "the venue call
 *     failed", and section 5.6 forbids either being mistaken for candles.
 *
 * NO NETWORK IS TOUCHED: every case here fails before a request would be sent,
 * because there are no credentials to sign one with.
 */

import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { clientForAccount } from "./exchange-dispatch";
import { envCandleLister } from "./candles";

const AT = 1_700_000_000_000;
const now = () => AT;

describe("clientForAccount", () => {
  it("dispatches a binance account to the Binance resolver", async () => {
    const outcome = clientForAccount({ label: "main", exchange: "binance" }, env, now);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.message).toContain("BINANCE_API_KEY");
      expect(outcome.kind).toBe("exchange_error");
      // Not retryable: a missing secret is not fixed by trying again.
      expect(outcome.retryable).toBe(false);
      expect(outcome.at).toBe(AT);
    }
  });

  it("dispatches a gemini account to the Gemini resolver", async () => {
    const outcome = clientForAccount({ label: "main", exchange: "gemini" }, env, now);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.message).toContain("GEMINI_API_KEY");
  });

  it("returns a client, stamped with the caller's clock, when credentials resolve", async () => {
    // The SUCCESS branch, which no test reached before -- a mutation run proved
    // it. Reached with a synthetic env rather than by putting credentials in
    // the test config: the suite's standing rule is that it never depends on a
    // real secret, and these are not one. Building a client sends nothing, so
    // no network is touched here either. The key's "account-" prefix is what
    // makes it an account-level key, which needs no GEMINI_ACCOUNT_NAME.
    const credentialled = {
      ...env,
      ENVIRONMENT: "testnet",
      GEMINI_API_KEY: "account-not-a-real-key",
      GEMINI_API_SECRET: "not-a-real-secret",
    } as unknown as Env;

    const outcome = clientForAccount({ label: "gemini-main", exchange: "gemini" }, credentialled, now);

    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(typeof outcome.value.getCandles).toBe("function");
      expect(outcome.at).toBe(AT);
    }
  });
});

describe("envCandleLister", () => {
  it("reports a client-resolution failure as a failed outcome, not empty candles", async () => {
    const outcome = await envCandleLister(
      { label: "main", exchange: "gemini" },
      { pair: "BTCUSD", interval: "1m" },
      env,
      now,
    );

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.kind).toBe("exchange_error");
      expect(outcome.message).toContain("GEMINI_API_KEY");
    }
  });

  it("carries the account's own exchange into the resolution", async () => {
    // The same call on a binance account names the OTHER secret, which is the
    // only evidence available here that the account -- not a default -- picked
    // the venue.
    const outcome = await envCandleLister(
      { label: "main", exchange: "binance" },
      { pair: "BTCUSDT", interval: "1m" },
      env,
      now,
    );

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.message).toContain("BINANCE_API_KEY");
  });
});
