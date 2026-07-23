# Durable Objects

Stateful compute, one class per unit of state and failure isolation
(spec section 3).

## `BotInstance` — built (DCA step 6, grid step 9)

One object per (exchange account + strategy + trading pair). Source of truth
for that bot's config, status, position/ladder, and idempotency records
(section 8.1). It serves BOTH strategies, discriminated by `config.strategy`:
DCA was step 6, grid reuses the same object at step 9 rather than a second
class, because the lifecycle, halt, order placement, mirroring and rate
limiting are all strategy-agnostic and already built. Only the planner and the
stored strategy state differ (`position`/`cycleCount` for DCA, `ladder` for
grid), and both are plumbed through here.

| File | What it is |
| --- | --- |
| `bot-instance.ts` | The object: lifecycle, order placement, halt, D1 mirror, both strategies |
| `attempt-store.ts` | The real `AttemptStore` (section 5.1), on DO storage |
| `storage-probe.test.ts` | What DO storage actually does, measured not assumed |
| `fake-exchange.ts` | Test-only `RestExchangeClient`; never opens a socket |
| `test-helpers.ts` | Test-only binding narrowing and the `inBot` helper |
| `grid-bot-instance.test.ts` | The grid branch, end to end (step 9) |

Strategy *decisions* are not here. They live in `/src/strategies/dca.ts` and
`/src/strategies/grid.ts` as pure functions, so section 13's backtest mode can
drive the same logic with historical candles and no Durable Object. This object
carries the decisions out: it places the orders, persists the state, and
mirrors to D1.

The one thing grid adds over DCA's halt is a **liquidation sell** on a
stop-loss, breakout, or take-profit exit (section 6.2 steps 4-6): the shared
`#halt` cancels and marks halted, and the grid exit then places a marketable
limit sell of the held position on top. Section 4.5 forbids market orders, so
that sell is a limit at the trigger price and may not fill in a fast drop; if it
rests unfilled the bot is left halted holding it, and that is alerted rather
than pretended away.

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

## `RateLimiter` (section 5.4, step 8)

One per exchange account, named by the account label. `WeightBudget` in
`/src/shared/rate-limiter.ts` is the accounting; this object owns it across
every bot on the account, which is the part a per-request client cannot do.

**Priority is two mechanisms, not one.** A *reserved slice* means routine
traffic may only draw on `limit - reserveForRiskExit`, so routine ladder
maintenance cannot spend the budget a stop-loss will need before that stop-loss
exists — which is the case ordering cannot help with, because nothing is
waiting yet. A *ticketed queue* then orders whatever is waiting: risk-exit
first, oldest first within a class, with a waiting request's weight claimed so
a later one cannot slip past it.

**Refusals hand back a ticket rather than blocking.** The caller sleeps and
re-presents it, keeping its place. No timers and no unresolved promises live
inside the object, so every decision is a pure function of (budget, live
tickets, clock) and the ordering — a risk control — is testable without waiting
for it. A ticket lost to eviction or TTL becomes a new arrival: it loses its
place, never its safety.

**The window is persisted.** A DO is evicted after a short idle period and the
window is 60 seconds; an object that forgot its entries would wake with an
apparently fresh budget and permit a second full limit inside one window.

Callers do not talk to it directly. `/src/exchange/rate-limited.ts` wraps any
`RestExchangeClient` so that asking for budget happens before the call, and
`BotInstance` does that wrapping itself rather than trusting whoever attached
its dependencies to have remembered.

## Not built here yet

`subscribeToPriceFeed` (section 4.6): the WebSocket Hibernation connection,
backoff reconnect, and REST gap backfill. Deferred to its own session — the
section 4.1 callback signature does not fit hibernation, since a callback
closure cannot survive the object being evicted.
