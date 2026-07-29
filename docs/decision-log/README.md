# Decision Log

A running record of decisions made while building this system, one entry per
build-order step (see section 19 of the technical specification). Append only.

---

This log was split from a single `docs/decision-log.md` file into one file per
major build-order step, so a session can read only the range it needs instead of
the whole history. No entry was reworded — this was a pure file split. Sub-steps
live in the same file as their parent step.

Order is preserved as written (append-only): within Step 10, entry **10.7**
appears before **10.6**, matching the order the work happened.

**Adding new entries:** append to the `NN.md` matching the step number (sub-steps
go in their parent's file); start a new `NN.md` for a new major step and add it to
the index below. Do not write to the old `docs/decision-log.md` stub.

## Index

| File | Steps | Title(s) |
| --- | --- | --- |
| [01.md](01.md) | 1 | Repository setup |
| [02.md](02.md) | 2 | Shared infrastructure modules |
| [03.md](03.md) | 3, 3.1, 3.2, 3.3, 3.4 | Exchange integration layer; `cancelOrder` returns the cancelled order; real credentials provider and testnet exchange wiring; temporary live reachability check from the deployed Worker; Gemini exchange implementation (second `RestExchangeClient`) |
| [04.md](04.md) | 4, 4.1 | D1 schema and migrations; D1 databases provisioned |
| [05.md](05.md) | 5 | Capital ledger and bot-creation validation |
| [06.md](06.md) | 6 | DCA BotInstance Durable Object |
| [07.md](07.md) | 7 | Reconciliation Cron Worker |
| [08.md](08.md) | 8 | RateLimiter Durable Object |
| [09.md](09.md) | 9 | Grid strategy |
| [10-backend.md](10-backend.md) | 10, 10.1–10.5, 10.7 | Alerts and outbound notification; no-schema guards; Discord timestamp investigation; human liquidation and the global kill switch; dashboard backend API; dashboard deploy guard |
| [10-frontend.md](10-frontend.md) | 10.6, 10.8, 10.9, 10.10, 10.11, 10.12 | Dashboard frontend scaffolding and bot list; bot detail view; liquidate action; global kill switch control; create-bot form; cross-bot alert feed |
| [11.md](11.md) | 11, 11.1 | Account registry (`accounts` table), live tradable-pair listing (`listTradablePairs` + KV cache), and the Binance-vs-Gemini exchange dispatch deferred from step 3.4; wiring the create-bot form's Account/Exchange/Pair fields to that registry (dropdown, read-only exchange, searchable pair typeahead) |
| [12.md](12.md) | 12 | Start-bot action: `POST /api/bots/:id/start` (thin wrapper over `BotInstance.start`) and the dashboard `StartAction` control; scoped to the honest `created -> running` status-flip, since `start` places no order until the execution path is wired |
