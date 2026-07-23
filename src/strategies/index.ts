/**
 * Strategy logic (spec section 6), as pure functions.
 *
 * Nothing here performs I/O, reads a clock, or touches storage: a strategy
 * takes a configuration, a position and a price, and returns the action it
 * wants taken. The Durable Object carries that action out.
 *
 * That is section 13's requirement rather than a preference -- backtesting has
 * to run the same strategy code against historical candles "without
 * duplication", which is only possible if the strategy is separable from the
 * machinery that talks to an exchange.
 *
 * `dca.ts` is build step 6; `grid.ts` is build step 9.
 *
 * The two are re-exported as namespaces rather than flattened, because they
 * deliberately share names -- both have a `decide`, a `stopLossPrice`, an
 * `assertReadableSchema` -- which is the point: they are the same shape of pure
 * strategy module. Consumers import the specific module directly (as the Durable
 * Object does), so this barrel exists for discoverability, not as the main path.
 */

export * as dca from "./dca";
export * as grid from "./grid";
