# Shared infrastructure modules

Built before any strategy logic and fully unit tested first
(spec sections 5 and 19 step 2).

| Module | Spec | What it does |
| --- | --- | --- |
| [`money.ts`](./money.ts) | 5.2 | Fixed-point arithmetic on `bigint` at scale 8 |
| [`exchange-client.ts`](./exchange-client.ts) | 4.1 | The `ExchangeClient` interface and its types. Type-only |
| [`order-state.ts`](./order-state.ts) | 5.3 | Order lifecycle and partial-fill accounting |
| [`idempotency.ts`](./idempotency.ts) | 5.1 | Deterministic `clientOrderId`s and attempt records |
| [`rate-limiter.ts`](./rate-limiter.ts) | 5.4 | Rolling request-weight budget with priority |
| [`fees.ts`](./fees.ts) | 5.5 | Fee conversion to the reporting currency, realized PnL |
| [`downtime.ts`](./downtime.ts) | 5.6 | Transport failure vs. valid response, retry with backoff |

None of these perform I/O, read a clock, or touch storage. Time is passed in as
a parameter and storage is injected as a port, so all of it is testable without
a Durable Object and reusable unchanged in backtest mode (section 13).

## The money convention

Every price, quantity, balance, and percentage is a `bigint` integer scaled by
10^8. Native `number` is never used for a monetary value anywhere.

Scale 8 is not arbitrary: Binance spot `tickSize` and `stepSize` never go below
1e-8, so every value the exchange accepts is exactly representable, and the
resulting range fits a signed 64-bit column with room to spare.

Two persistence rules, both verified against the real Workers runtime and local
D1 rather than assumed:

- **Writing.** `D1.bind()` rejects `bigint` outright. Bind
  `toStorageString(value)` instead; SQLite INTEGER affinity converts the decimal
  string to a true integer, so `SUM()` and `ORDER BY` stay numerically correct.
- **Reading.** D1 returns INTEGER to JavaScript as `number`, which silently
  loses precision above 2^53. Every read must use `CAST(col AS TEXT)` and parse
  with `fromStorageString`. Never read a money column directly.

Durable Object storage needs neither workaround: structured clone serializes
`bigint` natively.

## Rounding

No function in `money.ts` has a default rounding mode. Division always names its
direction at the call site, because the correct one is context-dependent --
quantities round down, since rounding up risks an insufficient-balance
rejection. Use `"exact"` where any precision loss would be a bug; it throws
rather than rounding.

## What is deliberately absent

- Binance request signing, endpoints, and payload shapes (section 4, step 3)
- Durable Object classes and storage implementations (step 6)
- Strategy logic, including average entry price and grid ladder maths
  (sections 6.2 and 6.3, steps 6 and 9)
