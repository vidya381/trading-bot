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
import { resolveKrakenExchange } from "./exchange-kraken";

/** How every venue's credentials resolver is shaped. All three match already. */
export type ExchangeResolver = (env: Env, now: () => Timestamp) => ExchangeResolution;

/**
 * THE VENUE -> RESOLVER TABLE, and the single source of truth for the question
 * "does this build have a credentials resolver for this venue".
 *
 * This was a `default`-less `switch` until Kraken's resolver landed. It is a
 * table now for a reason that the `switch` could not serve: `venue-wiring.ts`
 * has to ASK that question, and "does a `case` exist in a `switch`" is not
 * something any code can be asked. A `null` entry is askable, so the wiring
 * gate DERIVES its answer from this table instead of restating it as a
 * hand-maintained boolean that can drift.
 *
 * The forcing function the `switch` provided is preserved exactly, because this
 * is a total `Readonly<Record<ExchangeId, ...>>`, like `METHOD_WEIGHTS` and
 * `VENUE_PUBLISHES_INSTRUMENT_TYPE`: widening `ExchangeId` again FAILS TO
 * COMPILE here until the new venue is given an entry. What changes is what an
 * honest answer looks like while a venue is mid-build. Under the `switch`, the
 * only way to compile was to write a `case`, so a half-built venue had to
 * either lie or block the build; here it is `null`, which is the truth, and
 * every downstream gate reads that truth automatically.
 *
 * `null` is NOT a policy statement that a venue should not be traded. It means
 * only that no resolver exists yet -- see `describeUnwiredExchange`.
 */
export const EXCHANGE_RESOLVERS: Readonly<Record<ExchangeId, ExchangeResolver | null>> = {
  binance: resolveDefaultExchange,
  gemini: resolveGeminiExchange,
  // Refuses outright in the testnet environment (entry 90 DECISION 1: Kraken
  // publishes no sandbox). That is a normal `ok: false` resolution and not a
  // special case for this table -- the refusal travels the same path as a
  // missing secret, and `clientForAccount` below turns both into the same
  // non-retryable `exchange_error`. Nothing here branches on the environment.
  kraken: resolveKrakenExchange,
};

/**
 * Build the `exchangeFor` factory for an account's exchange, or say why it
 * cannot (missing secret, non-trading `ENVIRONMENT`, no resolver at all). The
 * reason string is the resolver's own, so it names exactly which secret and how
 * to set it.
 *
 * TOTAL, which the `switch` this replaced was not. A venue with no `case` used
 * to fall off the end and return `undefined` -- a value this signature says
 * cannot happen -- and entry 94 PART 2 recorded what that cost: a bot on an
 * unwired venue halting at its first trade on `TypeError: Cannot read
 * properties of undefined (reading 'ok')`, with no venue named in the message.
 * A `null` entry now produces a real refusal that names the venue and the gap.
 * `venue-wiring.ts` still stops such a bot from being created at all; this is
 * the second line, so that the failure is legible if the first is ever bypassed.
 */
export function resolveExchangeForAccount(
  exchange: ExchangeId,
  env: Env,
  now: () => Timestamp,
): ExchangeResolution {
  const resolve = EXCHANGE_RESOLVERS[exchange];
  if (resolve === null) {
    return {
      ok: false,
      reason:
        `${exchange} has no credentials resolver in this build, so no exchange ` +
        `client can be built for it. This is a gap in the build, not something ` +
        `a setting can fix.`,
    };
  }
  return resolve(env, now);
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
