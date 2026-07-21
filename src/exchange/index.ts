/**
 * Exchange integration layer (spec section 4), build step 3.
 *
 * The interface itself lives in `/src/shared/exchange-client.ts` with the other
 * types strategy code depends on. Everything here is the Binance-specific half:
 * signing, endpoints, payload shapes, and filter rules.
 *
 * Kept out of `/src/shared` because these modules perform real I/O, and the
 * shared modules' guarantee that they do not is what makes them reusable
 * unchanged in section 13's backtest mode.
 */

export * from "./credentials";
export * from "./binance/signing";
export * from "./binance/filters";
export * from "./binance/parse";
export * from "./binance/client";
