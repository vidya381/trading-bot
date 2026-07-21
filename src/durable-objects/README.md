# Durable Objects

Stateful compute, one class per unit of state and failure isolation
(spec section 3).

Planned, none implemented yet:

- `BotInstance` — one per (exchange account + strategy + trading pair).
  Source of truth for that bot's config, status, position, and idempotency
  records (section 8.1). DCA first (build step 6), grid second (build step 9).
- `RateLimiter` — one per exchange account. Rolling request-weight budget
  with priority tiers (section 5.4).
