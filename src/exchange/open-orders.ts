/**
 * The per-pair OPEN-ORDER CEILING: how many orders a venue lets rest at once.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS ITS OWN MODULE AND NOT PART OF `rate-limited.ts`
 * ---------------------------------------------------------------------------
 * `rate-limited.ts` is the section 5.4 gate: budgets that DEPLETE AND RECOVER.
 * Everything in it -- `WeightBudget`, `DecayingCounter`, `AcquireCost`, the
 * claims-ahead queue -- is built on the assumption that a refusal is temporary
 * and that waiting is the remedy.
 *
 * This is not that. A ceiling on the number of orders RESTING on the book is a
 * LEVEL. It does not decay. Waiting does not clear it; only a fill or a cancel
 * does. Entries 96 PART 5 and 98 PART 8 both deferred this work with exactly
 * that sentence, and modelling it here rather than in the limiter is that
 * decision carried out rather than reversed. A gate that queued a request
 * against a level that never falls would queue forever.
 *
 * The nearest RELATIVE in this codebase is not the rate limiter at all -- it is
 * `checkBotInstanceIdFitsVenue` in `shared/idempotency.ts`: a venue-keyed
 * budget, checked once, before anything is created, returning a violation the
 * caller turns into its own refusal. This module deliberately copies that shape,
 * down to the `describe...` function, so the two read the same way.
 *
 * ---------------------------------------------------------------------------
 * WHY THE CHECK IS AT CREATION AND NOT AT PLACEMENT
 * ---------------------------------------------------------------------------
 * The reachable failure is a CONFIGURATION fact, not a runtime one. `gridLines`
 * is bounded by `>= 2` and nothing else, so a grid can be configured with more
 * lines than the venue will hold; the ladder then places rungs until the venue
 * refuses one, and `bot-instance.ts` turns that refusal into a section 7.2 halt
 * -- with the rest of the ladder resting live on the book, requiring human
 * review, and halting again on every resume because the cause is a stored
 * parameter. That is the identical failure `validateGridParams`' own docblock
 * describes for `exceeds_allocated_capital` ("a bot is created happily and then
 * fails at the exchange when the ladder fills out, mid-run, with a position
 * open"), and it is fixed in the identical place: before any capital is
 * reserved.
 *
 * The rate limiter does NOT already prevent this, and it was checked rather than
 * assumed. On Starter the trading threshold and this ceiling are the same number
 * (60), and `KRAKEN_ADD_ORDER_COST` is 1, so a burst is refused at the
 * routine allowance of 50 -- but the counter decays at 1/s and the ladder is
 * built to re-enter on later ticks, so a rate limiter turns a burst into a
 * trickle and a trickle reaches the level anyway.
 */

import { isExchangeId, type ExchangeId } from "../db/schema";
import { krakenOpenOrderCeiling } from "./kraken/rate-limits";

/**
 * The most orders each venue lets rest on ONE pair at once.
 *
 * ⚠ `null` MEANS "THIS SYSTEM KNOWS OF NO CEILING FOR THIS VENUE", and it is
 * written out per venue rather than left to a missing key, for the same reason
 * `BATCH_CANCEL_COSTS` is a total `Record`: a fourth exchange must FAIL TO
 * COMPILE here until somebody has looked, instead of silently inheriting
 * Kraken's number or silently losing the limit.
 *
 * Both nulls are HONEST GAPS, and the distinction from `BATCH_CANCEL_COSTS`'
 * nulls matters. There, `null` is a finding: the venue has no such endpoint,
 * full stop. Here, `null` does not claim the venue is unlimited -- it claims
 * only that no figure has been verified for it:
 *
 *  - **binance** DOES publish a per-symbol ceiling, as the `MAX_NUM_ORDERS`
 *    filter on `/api/v3/exchangeInfo`. `binance/filters.ts` does not parse it
 *    and `SymbolFilters` has no field for it, so there is no verified number to
 *    put here. Wiring that filter through is its own session; inventing a
 *    constant in the meantime would be a fake stub, and a fake stub in a
 *    creation-time refusal rejects real, valid configurations.
 *  - **gemini** publishes no such limit that this system has confirmed.
 *
 * The direction of the resulting error is the safe one either way: a `null`
 * venue is not gated here, so it keeps exactly today's behaviour, which is the
 * reactive path -- the venue refuses the order and the bot halts. That is worse
 * than prevention and better than a wrong refusal.
 */
export const OPEN_ORDER_CEILINGS: Readonly<Record<ExchangeId, number | null>> = Object.freeze({
  binance: null,
  gemini: null,
  kraken: krakenOpenOrderCeiling(),
});

/**
 * This venue's per-pair open-order ceiling, or `null` if none is known.
 *
 * Takes a `string` rather than an `ExchangeId` because the values that reach it
 * are free-typed -- `CreateGridBotRequest.exchange` is a `string`, as is
 * `bot_instances.exchange` -- and `isExchangeId` is this codebase's guard for
 * exactly that. An unrecognised venue is `null` for the same reason binance and
 * gemini are: this module must not invent a limit for something it has never
 * read a number for.
 */
export function openOrderCeilingFor(exchange: string): number | null {
  return isExchangeId(exchange) ? OPEN_ORDER_CEILINGS[exchange] : null;
}

/**
 * Orders left free on the pair for everything that is not the bot being created.
 *
 * ---------------------------------------------------------------------------
 * ⚠ THIS IS A POLICY NUMBER, NOT A VENUE FACT. IT COMPENSATES FOR A REAL GAP.
 * ---------------------------------------------------------------------------
 * The venue counts open orders PER PAIR PER ACCOUNT, across every bot. This
 * check is per BOT, because a per-account count is not available to it:
 * `orders` has no `pair` column (pair lives on `bot_instances`), `idx_orders_open`
 * is keyed `(bot_instance_id, status)`, and nothing forbids two bots sharing an
 * account and pair -- there is no `UNIQUE (account_label, exchange, pair)` and
 * Durable Objects are addressed by `idFromName(botInstanceId)`. Counting across
 * bots would need a JOIN, a new index, and a D1 read on the order-placement path
 * from inside a Durable Object, and the count would still lag the exchange.
 *
 * So the residual risk is real and this constant is what absorbs the small end
 * of it. Five is sized against what the OTHER strategies can actually hold on a
 * shared pair, which is one resting order each: DCA gates every additional buy
 * on `hasOpenOrder`, and a trailing stop has a single entry. Five leaves room
 * for several such bots and is small enough that it does not meaningfully narrow
 * a legitimate grid -- a Starter-tier grid may still be 55 lines.
 *
 * IT DOES NOT MAKE THE CHECK SOUND FOR TWO GRIDS ON ONE PAIR. Two 40-line grids
 * on the same account and pair each pass this and together exceed 60. That case
 * is not covered, is not claimed to be, and is what a cross-bot count would be
 * for.
 */
export const OPEN_ORDER_HEADROOM = 5;

/** Why one configuration does not fit one venue's open-order ceiling. */
export interface OpenOrderCeilingViolation {
  readonly exchange: ExchangeId;
  /** The most orders this configuration can have resting at once. */
  readonly peakOpenOrders: number;
  /** The venue's own per-pair ceiling. */
  readonly ceiling: number;
  /** `OPEN_ORDER_HEADROOM` at the time of the check. */
  readonly headroom: number;
  /** `ceiling - headroom`: the most this check will allow one bot. */
  readonly allowance: number;
}

/**
 * Does a configuration whose peak is `peakOpenOrders` fit this venue?
 *
 * Returns the violation rather than throwing, so the caller decides what kind of
 * refusal it is -- `bot-instance.ts` raises a `GridError` the API already
 * surfaces, and a dashboard could render the same numbers as field text from one
 * rule. Exactly `checkBotInstanceIdFitsVenue`'s contract.
 *
 * STRATEGY-AGNOSTIC ON PURPOSE. It takes a NUMBER, not `GridParams`. Grid is the
 * only strategy that can currently approach a ceiling of 60 -- DCA and trailing
 * stop hold one order each -- but "how many orders can this configuration have
 * resting at once" is a question every strategy can answer about itself, and
 * keeping the ceiling module ignorant of grids means the next strategy that
 * needs this does not have to edit it. It is also what keeps `strategies/grid.ts`
 * free of any import from `/src/exchange`, which section 13's backtest
 * requirement depends on.
 *
 * A venue with no known ceiling returns null for every input. It is not a
 * silent pass: `OPEN_ORDER_CEILINGS` says per venue why there is no number, and
 * refusing on a limit this system has not verified would reject valid bots.
 */
export function checkOpenOrderCeiling(
  exchange: string,
  peakOpenOrders: number,
): OpenOrderCeilingViolation | null {
  const ceiling = openOrderCeilingFor(exchange);
  // `ceiling !== null` implies `isExchangeId(exchange)`, since every other
  // string takes the null branch above. The narrowing is not visible to the
  // compiler through the helper, hence the cast on the way into the violation.
  if (ceiling === null) return null;

  // Floored at zero so a venue whose ceiling is ever smaller than the headroom
  // refuses everything rather than producing a negative allowance that every
  // comparison below would pass.
  const allowance = Math.max(0, ceiling - OPEN_ORDER_HEADROOM);
  if (peakOpenOrders <= allowance) return null;

  return {
    exchange: exchange as ExchangeId,
    peakOpenOrders,
    ceiling,
    headroom: OPEN_ORDER_HEADROOM,
    allowance,
  };
}

/**
 * The violation as one sentence, so an operator reads the same explanation
 * wherever it surfaces. Mirrors `describeVenueIdLengthViolation`.
 */
export function describeOpenOrderCeilingViolation(violation: OpenOrderCeilingViolation): string {
  return (
    `this configuration can have up to ${violation.peakOpenOrders} orders resting on one pair ` +
    `at once, over the ${violation.allowance} this system allows on ${violation.exchange}: ` +
    `the venue caps open orders at ${violation.ceiling} per pair and refuses the next one with ` +
    `"EOrder:Orders limit exceeded", which halts the bot mid-run with the rest of its orders ` +
    `live. ${violation.headroom} of the ${violation.ceiling} are held back for other bots ` +
    `trading the same pair on this account.`
  );
}
