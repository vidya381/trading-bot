/**
 * Capital ledger and bot-creation validation (spec section 8.5), build step 5.
 *
 * The validation and ledger logic that step 6's Durable Object, step 7's
 * reconciliation, and step 10's dashboard form all call. It contains no
 * strategy logic and no Durable Object of its own.
 */

export * from "./ledger";
export * from "./placeholder-balance";
