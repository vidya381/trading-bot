/**
 * WHICH VENUES THIS BUILD CAN ACTUALLY TRADE ON -- as opposed to which ones
 * `ExchangeId` can merely NAME.
 *
 * ── WHY THIS EXISTS ──
 *
 * `ExchangeId` and "a venue with a working client behind it" were the same set
 * until Kraken. Widening the union for Kraken (entry 90's wiring step) separated
 * them: `isExchangeId("kraken")` is now true, but `resolveExchangeForAccount`
 * has no `case "kraken"`, `src/workers/exchange-kraken.ts` does not exist, and
 * `METHOD_WEIGHTS` has no Kraken cost model. A bot created on Kraken today would
 * reserve capital, write a row, and then fall off the end of a non-total
 * `switch` -- halting on an opaque `TypeError` reading `.ok` of `undefined`.
 *
 * `resolveBotExchange`'s unregistered-account fallback validated the request
 * body with `isExchangeId` ALONE, so the moment the union widened, a
 * `POST /api/bots` naming an unregistered account and `exchange: "kraken"`
 * returned 201 and created exactly that bot. `accounts.exchange`'s D1 CHECK did
 * not stop it, because an unregistered account never reaches the accounts table.
 * This table is what that path checks now.
 *
 * ── WHY A TABLE AND NOT `exchange === "kraken"` ──
 *
 * A hardcoded venue name is a rule about TODAY that silently becomes wrong on
 * the day Kraken is wired, and wrong again on the day a fourth venue is added
 * unwired. Two properties keep this honest instead, in both directions:
 *
 *   * COMPILE-TIME, no venue may be OMITTED. It is a total
 *     `Readonly<Record<ExchangeId, boolean>>`, exactly like `METHOD_WEIGHTS`
 *     (`exchange/rate-limited.ts`) and `VENUE_PUBLISHES_INSTRUMENT_TYPE`
 *     (`research/tradability.ts`): widening `ExchangeId` again fails to compile
 *     HERE until someone states whether the new venue can be traded.
 *
 *   * RUNTIME, no venue may be MISLABELLED. `venue-wiring.test.ts` calls the
 *     real `resolveExchangeForAccount` for every `ExchangeId` with every secret
 *     present, and asserts it hands back a resolution exactly for the venues
 *     marked `true` here. That is the half a table cannot assert about itself:
 *     the day the dispatch `switch` grows its `case "kraken"`, that test fails
 *     until this row is flipped, so the two cannot drift apart.
 *
 * Compile-time totality alone would let someone add `kraken: true` while the
 * dispatch stayed empty; the cross-check alone would let someone add a fourth
 * venue and never be asked. Together they are the closest this codebase can get
 * to DERIVING the answer, given that "does a `case` exist in a `switch`" is not
 * something TypeScript can be asked directly.
 */

import type { ExchangeId } from "../db/schema";

/**
 * Does this venue have a real, reachable exchange client behind it?
 *
 *  - `binance` TRUE. `resolveDefaultExchange` (`workers/exchange.ts`), a
 *    `case` in `resolveExchangeForAccount`, and a `METHOD_WEIGHTS` row.
 *
 *  - `gemini`  TRUE. `resolveGeminiExchange` (`workers/exchange-gemini.ts`),
 *    likewise.
 *
 *  - `kraken`  FALSE, and this is a STATEMENT OF THE BUILD'S STATE rather than
 *    a policy choice -- nobody has decided Kraken should not be traded. Three
 *    things are missing, each deliberately deferred to its own session by entry
 *    90's build order, and each blocking on its own merits:
 *
 *      1. `workers/exchange-kraken.ts` -- the resolver (`KRAKEN_API_KEY` /
 *         `KRAKEN_API_SECRET`, fail-closed on a missing secret, DECISION 1's
 *         testnet refusal). Not written.
 *      2. `resolveExchangeForAccount`'s third `case`, which cannot be written
 *         before (1) exists.
 *      3. `METHOD_WEIGHTS.kraken` -- entry 90 step (d). Kraken's cost model is a
 *         decaying counter, a SECOND per-pair budget, and a cancel price that
 *         depends on the order's age; it does not fit
 *         `Record<keyof RestExchangeClient, number>` at all. Trading Kraken
 *         through another venue's weight table is the exact bug commit
 *         `c43f40c` removed, so an ungated Kraken bot is not an acceptable
 *         interim state either.
 *
 *    The exchange CLIENT itself (`exchange/kraken/`) is complete and tested --
 *    signing, catalogue, filters, parsing, all ten section 4.1 methods. That is
 *    why the row reads "not wired" and not "not built": the gap is the wiring,
 *    and this flag flips when (1)-(3) close, not when the client lands.
 */
export const EXCHANGE_IS_WIRED: Readonly<Record<ExchangeId, boolean>> = {
  binance: true,
  gemini: true,
  kraken: false,
};

/** Whether a bot may be created on, and traded on, this venue today. */
export function isWiredExchange(exchange: ExchangeId): boolean {
  return EXCHANGE_IS_WIRED[exchange];
}

/**
 * Why this venue cannot be traded, in the operator's own terms.
 *
 * ONE message for both refusal sites -- `createBot`'s 400 and `BotInstance`'s
 * halt reason -- so an operator who hits the second after somehow getting past
 * the first reads the same fact rather than two half-explanations. It names the
 * venue and says the shortfall is this build's wiring, not their request: there
 * is nothing they can retype that would make it work.
 */
export function describeUnwiredExchange(exchange: ExchangeId): string {
  return (
    `${exchange} is a known exchange but has no exchange client wired into this build ` +
    `(no resolver in resolveExchangeForAccount and no rate-limit cost model), so a bot ` +
    `cannot trade on it. Enabling it is a deliberate, separate step; ` +
    `until then use one of: ${wiredExchanges().join(", ")}.`
  );
}

/** The venues a bot really can be created on, for messages and for tests. */
export function wiredExchanges(): readonly ExchangeId[] {
  return (Object.keys(EXCHANGE_IS_WIRED) as ExchangeId[]).filter(isWiredExchange);
}
