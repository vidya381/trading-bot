/**
 * Durable Objects (spec section 3): the unit of state, risk and failure
 * isolation.
 *
 * `BotInstance` is one per (exchange account + strategy + trading pair). The
 * DCA half is build step 6; grid reuses the same object at step 9.
 *
 * `RateLimiter` (section 5.4) is one per exchange account, and is a different
 * kind of thing: not a unit of strategy state but a shared resource every bot
 * on the account contends for. Build step 8.
 */

export * from "./attempt-store";
export * from "./bot-instance";
export * from "./rate-limiter";
