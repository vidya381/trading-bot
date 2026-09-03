/**
 * THE CROSS-CHECK that makes `EXCHANGE_IS_WIRED` a derived fact rather than a
 * hand-maintained opinion.
 *
 * `EXCHANGE_IS_WIRED` is a total `Record<ExchangeId, boolean>`, so the compiler
 * already guarantees no venue is OMITTED from it. That is only half the
 * property. The other half -- no venue is MISLABELLED -- is not expressible in
 * the type system, because "does `resolveExchangeForAccount` have a `case` for
 * this venue" is not a question TypeScript can be asked. So it is asked here, of
 * the real function, at runtime.
 *
 * WHY THIS MATTERS MORE THAN IT LOOKS. The table gates bot creation
 * (`assertExchangeIsWired`) and the halt reason a stored venue produces
 * (`BotInstance#venue`). A table that says `kraken: true` while the dispatch
 * `switch` stays empty would re-open exactly the hole this all exists to close,
 * and would do it silently -- a green build, a 201, and a `TypeError` at the
 * first trade. The day someone adds `case "kraken":` to the dispatch and forgets
 * this row, THIS test fails, in the other direction, before that can ship.
 *
 * SECRETS ARE ALL PRESENT ON PURPOSE. The distinction under test is "is there a
 * resolver at all", not "is it configured". A missing secret makes a real
 * resolver return `{ ok: false, reason }` -- still a resolution, still not
 * `undefined` -- so a fully-populated env is what isolates the one difference
 * this table is about. `exchange.test.ts` and `exchange-gemini.test.ts` own the
 * fail-closed behaviour itself; nothing here duplicates it.
 */

import { describe, expect, it } from "vitest";
import { env as testEnv } from "cloudflare:test";
import { EXCHANGE_IDS, type ExchangeId } from "../db/schema";
import { EXCHANGE_IS_WIRED, isWiredExchange, wiredExchanges } from "./venue-wiring";
import { resolveExchangeForAccount } from "./exchange-dispatch";
import type { ExchangeResolution } from "./exchange";

const NOW = () => 1_700_000_000_000;

/**
 * Every secret and binding every resolver reads, so only the dispatch itself can
 * differ between venues. The real test `env` supplies the bindings (a resolver
 * also needs `RATE_LIMITER` before it will hand back a client); the secrets are
 * layered on top because the suite deliberately holds none.
 */
function fullyConfiguredEnv(): Env {
  return {
    ...testEnv,
    ENVIRONMENT: "testnet",
    BINANCE_API_KEY: "binance-key",
    BINANCE_API_SECRET: "binance-secret",
    GEMINI_API_KEY: "gemini-key",
    GEMINI_API_SECRET: "gemini-secret",
    KRAKEN_API_KEY: "kraken-key",
    KRAKEN_API_SECRET: "kraken-secret",
  } as unknown as Env;
}

/**
 * What dispatch REALLY does for a venue, `undefined` included.
 *
 * The declared return type is `ExchangeResolution`, but `resolveExchangeForAccount`
 * is a `switch` with no `default`, so a venue with no `case` falls off the end
 * and returns `undefined` -- a value its own signature says cannot happen. The
 * cast is that unsoundness stated openly; it is the exact gap this test measures
 * and the exact one `EXCHANGE_IS_WIRED` exists to keep out of the request path.
 */
function dispatchFor(exchange: ExchangeId): ExchangeResolution | undefined {
  return resolveExchangeForAccount(exchange, fullyConfiguredEnv(), NOW) as
    | ExchangeResolution
    | undefined;
}

describe("EXCHANGE_IS_WIRED agrees with the real dispatch, venue by venue", () => {
  it.each([...EXCHANGE_IDS])("%s: the table and resolveExchangeForAccount say the same thing", (exchange) => {
    const resolution = dispatchFor(exchange);
    expect(resolution !== undefined).toBe(isWiredExchange(exchange));
  });

  it("covers every ExchangeId, with no venue left unanswered", () => {
    // The runtime half of the compile-time totality: a `Record<ExchangeId, ...>`
    // cannot be missing a key, but this also catches a key added to the object
    // that is not an ExchangeId at all.
    expect(Object.keys(EXCHANGE_IS_WIRED).sort()).toEqual([...EXCHANGE_IDS].sort());
  });

  it("reports binance and gemini as wired, and both really resolve", () => {
    expect(wiredExchanges()).toEqual(["binance", "gemini"]);
    for (const exchange of wiredExchanges()) {
      const resolution = dispatchFor(exchange);
      expect(resolution).toBeDefined();
      // Configured secrets, so these resolve rather than fail closed -- which
      // proves the env above really is complete and the test is measuring
      // dispatch, not a missing variable.
      expect(resolution!.ok).toBe(true);
    }
  });

  it("reports kraken as unwired, and dispatch really does fall through", () => {
    // The specific unsoundness, pinned. This is what `#rawExchange` used to read
    // `.ok` off, producing `unhandled_error: TypeError: Cannot read properties
    // of undefined`. When Kraken's resolver lands, this assertion fails and is
    // the prompt to flip the table row.
    expect(isWiredExchange("kraken")).toBe(false);
    expect(dispatchFor("kraken")).toBeUndefined();
  });
});
