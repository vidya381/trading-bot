/**
 * Durable Objects (spec section 3): the unit of state, risk and failure
 * isolation.
 *
 * `BotInstance` is one per (exchange account + strategy + trading pair). The
 * DCA half is build step 6; grid reuses the same object at step 9. The
 * `RateLimiter` object of section 5.4 does not exist yet.
 */

export * from "./attempt-store";
export * from "./bot-instance";
