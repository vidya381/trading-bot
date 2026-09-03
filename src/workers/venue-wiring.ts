/**
 * WHICH VENUES THIS BUILD CAN ACTUALLY TRADE ON -- as opposed to which ones
 * `ExchangeId` can merely NAME.
 *
 * ── WHY THIS EXISTS ──
 *
 * `ExchangeId` and "a venue with a working client behind it" were the same set
 * until Kraken. Widening the union for Kraken (entry 90's wiring step) separated
 * them: `isExchangeId("kraken")` became true while no client existed for it at
 * all. A bot created on Kraken then would reserve capital, write a row, and halt
 * at its first trade on an opaque `TypeError` reading `.ok` of `undefined`.
 *
 * `resolveBotExchange`'s unregistered-account fallback validated the request
 * body with `isExchangeId` ALONE, so the moment the union widened, a
 * `POST /api/bots` naming an unregistered account and `exchange: "kraken"`
 * returned 201 and created exactly that bot. `accounts.exchange`'s D1 CHECK did
 * not stop it, because an unregistered account never reaches the accounts table.
 * This module is what that path checks now.
 *
 * ── THE ANSWER IS DERIVED, NOT DECLARED ──
 *
 * This began as a hand-maintained `Record<ExchangeId, boolean>` cross-checked by
 * a test, because "does a `case` exist in a `switch`" is not a question any code
 * can ask. That shape had a standing hazard: the boolean and the code could
 * disagree, and the ONLY thing preventing it was a person reading a failing test
 * and flipping the right row. It went stale on schedule -- the day
 * `exchange-kraken.ts` landed, the table still said Kraken had no resolver.
 *
 * So the question was made askable instead. `exchange-dispatch.ts` dispatches
 * through `EXCHANGE_RESOLVERS`, a total table whose entry is `null` when no
 * resolver exists, and wiredness is now COMPUTED from the two real conditions:
 *
 *     isWiredExchange(v)  ==  EXCHANGE_RESOLVERS[v] !== null   (blocker 1)
 *                             && METHOD_WEIGHTS[v] !== undefined  (blocker 2)
 *
 * There is no boolean to flip and nothing to remember. A venue becomes tradable
 * in the same commit that closes its last blocker, and a venue whose resolver is
 * deleted becomes untradable in the same commit, without a test having to catch
 * either. `venue-wiring.test.ts` no longer polices a table against the code; it
 * verifies the DERIVATION holds for every `ExchangeId`, which is a property that
 * stays true as venues come and go.
 *
 * Both compile-time guarantees survive intact, because both source tables are
 * still total `Readonly<Record<ExchangeId, ...>>`: widening `ExchangeId` again
 * fails to compile in `EXCHANGE_RESOLVERS` and in `METHOD_WEIGHTS` until the new
 * venue is answered for in each. What is gone is the third place that had to be
 * answered by hand, and could be answered wrongly.
 *
 * ── KRAKEN TODAY ──
 *
 * NOT WIRED, and this is a statement of the build's state rather than a policy
 * choice -- nobody has decided Kraken should not be traded. Blocker 1 is CLOSED:
 * `workers/exchange-kraken.ts` exists and `EXCHANGE_RESOLVERS.kraken` is real.
 * Blocker 2 is OPEN: `METHOD_WEIGHTS` has no `kraken` row, because Kraken's cost
 * model is a decaying counter, a SECOND per-pair budget, and a cancel price that
 * depends on the order's age -- it does not fit
 * `Record<keyof RestExchangeClient, number>` at all, and entry 90 step (d) makes
 * it its own session. Trading Kraken through another venue's weight table is the
 * exact bug commit `c43f40c` removed, so an ungated Kraken bot is not an
 * acceptable interim state either.
 *
 * The exchange CLIENT itself (`exchange/kraken/`) is complete and tested. That
 * is why this reads "not wired" and not "not built": the gap is the cost model,
 * and it closes on its own the moment that row lands.
 */

import { EXCHANGE_IDS, type ExchangeId } from "../db/schema";
import { METHOD_WEIGHTS } from "../exchange/rate-limited";
import { EXCHANGE_RESOLVERS } from "./exchange-dispatch";

/**
 * BLOCKER 1 -- is there a credentials resolver for this venue?
 *
 * Read off `EXCHANGE_RESOLVERS` (`exchange-dispatch.ts`), which is the table
 * `resolveExchangeForAccount` itself dispatches through. Not a copy of it, and
 * not a call to it: entry 94 rejected deriving this by CALLING dispatch,
 * because that made the guard depend on the very unsoundness it exists to fix
 * (a venue with no `case` returning `undefined`), and because the guard has no
 * `Env` to call it with. Reading the same table both answers the question and
 * makes the two physically incapable of disagreeing.
 */
export function hasCredentialsResolver(exchange: ExchangeId): boolean {
  return EXCHANGE_RESOLVERS[exchange] !== null;
}

/**
 * BLOCKER 2 -- is there a rate-limit cost model for this venue?
 *
 * A runtime presence check rather than a type-level one, and that is deliberate:
 * `METHOD_WEIGHTS` is DECLARED as a total `Record<ExchangeId, MethodWeights>`
 * while its object literal is missing the `kraken` key. The type currently
 * lies -- that mismatch IS the open `tsc` error at `rate-limited.ts:196`, left
 * standing on purpose as entry 90 step (d)'s forcing function. So the type
 * cannot be trusted to answer this and the object is asked instead, which is
 * correct both today and after the row lands.
 *
 * Trading a venue with no cost model is not an acceptable interim state: it is
 * the bug commit `c43f40c` removed, where every Gemini account spent Binance's
 * weights. An absent row must gate the venue, not fall back to another's numbers.
 */
export function hasRateLimitCostModel(exchange: ExchangeId): boolean {
  return METHOD_WEIGHTS[exchange] !== undefined;
}

/**
 * Whether a bot may be created on, and traded on, this venue today.
 *
 * DERIVED, never declared. There is no boolean to flip: the day
 * `METHOD_WEIGHTS` grows its `kraken` row, `hasRateLimitCostModel("kraken")`
 * becomes true, and Kraken becomes wired in the same commit, with nothing else
 * to remember. That is the whole point of the change -- the previous
 * hand-maintained row had to be flipped by someone who noticed, and the test
 * that would have told them was the only thing standing between "wired" and "a
 * green build, a 201, and a TypeError at the first trade".
 *
 * BOTH conjuncts are required, and neither is redundant. A resolver with no cost
 * model gives an ungated bot on a live venue; a cost model with no resolver
 * gives a bot that cannot authenticate. Kraken is exactly the first case today.
 */
export function isWiredExchange(exchange: ExchangeId): boolean {
  return hasCredentialsResolver(exchange) && hasRateLimitCostModel(exchange);
}

/**
 * Why this venue cannot be traded, in the operator's own terms.
 *
 * ONE message for both refusal sites -- `createBot`'s 400 and `BotInstance`'s
 * halt reason -- so an operator who hits the second after somehow getting past
 * the first reads the same fact rather than two half-explanations. It names the
 * venue and says the shortfall is this build's wiring, not their request: there
 * is nothing they can retype that would make it work.
 *
 * BUILT FROM THE SAME TWO CHECKS `isWiredExchange` USES, so it can only ever
 * name what is actually missing. The previous version was one fixed sentence
 * asserting both gaps at once ("no resolver in resolveExchangeForAccount and no
 * rate-limit cost model"), which went stale the moment `exchange-kraken.ts`
 * landed and closed the first half -- it would have sent an operator looking for
 * a resolver that was sitting right there. A message that restates a condition
 * cannot drift from it.
 */
export function describeUnwiredExchange(exchange: ExchangeId): string {
  const missing: string[] = [];
  if (!hasCredentialsResolver(exchange)) {
    missing.push(
      "no credentials resolver (no entry in EXCHANGE_RESOLVERS, so no API key " +
        "can be read and no client built)",
    );
  }
  if (!hasRateLimitCostModel(exchange)) {
    missing.push(
      "no rate-limit cost model (no METHOD_WEIGHTS row, so its calls cannot be " +
        "gated, and trading it would either run ungated or spend another " +
        "venue's weights)",
    );
  }

  if (missing.length === 0) {
    // Unreachable through either call site, which both check `isWiredExchange`
    // first. Stated rather than assumed: a caller that got here has a bug, and
    // silently returning a refusal for a venue that IS wired would send an
    // operator hunting for a gap that does not exist.
    return (
      `${exchange} is fully wired in this build; describeUnwiredExchange was ` +
      `called for a venue that is not unwired, which is a bug in the caller.`
    );
  }

  return (
    `${exchange} is a known exchange but is not fully wired into this build: ` +
    `${missing.join(", and ")}. A bot cannot trade on it. Enabling it is a ` +
    `deliberate, separate step; until then use one of: ${wiredExchanges().join(", ")}.`
  );
}

/** The venues a bot really can be created on, for messages and for tests. */
export function wiredExchanges(): readonly ExchangeId[] {
  return EXCHANGE_IDS.filter(isWiredExchange);
}
