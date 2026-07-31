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
| [12.md](12.md) | 12, 12.1 | Start-bot action: `POST /api/bots/:id/start` (thin wrapper over `BotInstance.start`) and the dashboard `StartAction` control; scoped to the honest `created -> running` status-flip, since `start` placed no order until the execution path was wired; **12.1** — that caveat **deleted, not softened**, once the price-feed arc landed: with step 13's exchange attachment and 14.1–14.5's feed (verified live at **14.6 Tier 0** and **14.7 Tier 1**, both PASS 2026-07-30), "no order will be placed yet" had become a false reassurance on a capital-committing dialog, so the dialog, the success banner, and the three stale docblocks now say starting drives a real order on the next closed 1-minute candle; the fail-closed feed subscribe means `invalid_status` is no longer `start`'s only failure (generic branch already covers it) |
| [13.md](13.md) | 13 | Execution wiring, part 1 of 2: attaching a live exchange client to `BotInstance` in production via `resolveExchangeForAccount` (lazy in `#exchange`, injected-wins for tests, fail-closed on missing credentials); the price feed / hibernation redesign is deferred to part 2 |
| [14.md](14.md) | 14, 14.1–14.7 | Price feed design (execution wiring, part 2 of 2) — the outbound-WebSocket-does-not-hibernate correction (spec §4.6 deviation), shared `PriceFeed` DO keyed by (exchange, pair), `subscribeToPriceFeed`/`WebSocketHandle` deletion + `getCandles` addition, closed-1m-candle→Price, Gemini-first, and single-alarm reconnect/backoff/backfill with an alert-only blind-feed policy; the Gemini-WS reachability probe (PASS: `candles_1m_updates`, no closed flag, OHLCV as JSON numbers); **14.1 Session A** — the interface reshape + `getCandles`/`parseCandles`/`parseKlines` build; **14.2 Session B** — the pure `GeminiPriceFeedCodec` (`socketUrl`/`subscribeMessage`/`parseMessage`, `FeedEvent` 4-way, reusing `parseCandles`) tested against real captured payloads; the deliberate multi-boundary probe (Q1 **CURRENT-ONLY** 6/6, Q2 **~5s heartbeat**); and **14.3 Session C1** — the `PriceFeed` Durable Object (CURRENT-ONLY stream engine, outbound socket lifecycle, single multiplexed alarm, backoff, **WS-batch gap-backfill deviating from decision 5**, blind-feed + 30-min escalation), 15 tests; **14.4 Session C2** — the durable SQLite subscriber registry + `allSettled` fan-out (`subscribe` carries config, `idFromName` cross-DO calls, first-open/last-close gating, `stopFeed` watermark reset, no-auto-prune on fanout failure), 20 tests total; **14.5 Session D** — wiring `BotInstance` status transitions to the feed (subscribe fail-closed in `start`/`resume`, unsubscribe best-effort in `#halt`/`close`, DCA auto-restart stays subscribed), 7 wiring tests. **The price-feed arc (14.1–14.5) is complete**; a live end-to-end sandbox run remains a deployed, manual step; **14.6** — the temporary `GET /api/debug/ws-check` **Tier 0** edge→Gemini WebSocket reachability diagnostic: confirmed **PASS** live (2026-07-30, `candles_1m_updates` received) and removed the same day, but it caught a real feed-transport bug (`wss://` passed to `fetch`) whose fix — the shared `httpUrlForWebSocket` scheme translation + handshake tests in `price-feed.ts` — stays permanently; **14.7** — the temporary `GET /api/debug/feed-check` **Tier 1** diagnostic verifying the REAL `PriceFeed` DO live (throwaway `debug-check` subscriber, watermark-advance as fan-out evidence via a temporary read-only `debugSnapshot()`, `price_feed_fanout_failed` in D1 as per-subscriber attribution, 120s bounded wait with an `inconclusive` verdict for a quiet market, unsubscribe in a `finally`), 14 tests: confirmed **PASS** live (2026-07-30, watermark 1785463079999→1785463139999 — exactly one 60s candle — with D1's `price_feed_fanout_failed` corroborating the fan-out to `debug-check`) and fully removed the same day, route AND read path, leaving the DO exactly as it was. **The feed itself is now proven live**; only feed→bot→order and the ~15-minute eviction ceiling remain unobserved |
