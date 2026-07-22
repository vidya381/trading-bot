# Durable Objects

Stateful compute, one class per unit of state and failure isolation
(spec section 3).

## `BotInstance` — built (DCA half, build step 6)

One object per (exchange account + strategy + trading pair). Source of truth
for that bot's config, status, position, and idempotency records
(section 8.1). DCA is step 6; grid reuses the same object at step 9.

| File | What it is |
| --- | --- |
| `bot-instance.ts` | The object: lifecycle, order placement, halt, D1 mirror |
| `attempt-store.ts` | The real `AttemptStore` (section 5.1), on DO storage |
| `storage-probe.test.ts` | What DO storage actually does, measured not assumed |
| `fake-exchange.ts` | Test-only `RestExchangeClient`; never opens a socket |
| `test-helpers.ts` | Test-only binding narrowing and the `inBot` helper |

Strategy *decisions* are not here. They live in `/src/strategies/dca.ts` as
pure functions, so section 13's backtest mode can drive the same logic with
historical candles and no Durable Object. This object carries the decisions
out: it places the orders, persists the state, and mirrors to D1.

### Three things worth knowing before changing it

**It does not write its own `bot_instances` row.** It calls
`createBotInstanceWithCapital`, which owns the capital-reservation-plus-row
pipeline from step 5. A second writer to that row breaks step 5's ordering
guarantees.

**It never writes `status = 'stopped'`.** That column is also step 5's mutual
exclusion against releasing the same capital twice. `close()` calls
`releaseBotCapital` and lets it own that transition. `running` and `halted` are
this object's own call, and `halted` touches no capital at all.

**D1 is written in the same pipeline as the event**, never on a timer. Within
one event: Durable Object storage first, D1 second — section 8.1 makes this
object's storage authoritative, so a crash between the two leaves the mirror
behind rather than ahead.

## `RateLimiter` — not built

One per exchange account. Rolling request-weight budget with priority tiers
(section 5.4). `WeightBudget` in `/src/shared/rate-limiter.ts` is the logic;
nothing gates a request on it yet.

## Not built here yet

`subscribeToPriceFeed` (section 4.6): the WebSocket Hibernation connection,
backoff reconnect, and REST gap backfill. Deferred to its own session — the
section 4.1 callback signature does not fit hibernation, since a callback
closure cannot survive the object being evicted.
