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
 * `dca.ts` is build step 6. Grid (section 6.2) becomes a sibling at step 9.
 */

export * from "./dca";
