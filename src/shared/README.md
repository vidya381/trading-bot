# Shared infrastructure modules

Built before any strategy logic and fully unit tested first
(spec sections 5 and 19 step 2). Nothing implemented yet.

- Idempotency — deterministic `clientOrderId` generation and attempt records (5.1)
- Fixed-point money math — never native floats for price/quantity/balance (5.2)
- Order and fill state machine — partial fill accounting (5.3)
- Rate limiter client — request budget with priority tiers (5.4)
- Fee handling — read actual fee asset per fill, convert to reporting currency (5.5)
- Downtime detection — distinguish transport failure from a real price (5.6)

Also the home of the `ExchangeClient` interface (section 4.1). Strategy code
depends only on that interface, never on Binance-specific shapes.
