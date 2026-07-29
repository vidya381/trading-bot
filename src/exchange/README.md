# Exchange integration layer

Two implementations of the interface in
[`../shared/exchange-client.ts`](../shared/exchange-client.ts)
(spec section 4): Binance (build step 3) and Gemini (build step 3.4). They
coexist behind the identical `RestExchangeClient`; strategy code and `BotInstance`
depend only on the interface and cannot tell which exchange is underneath.

| Module | Spec | What it does |
| --- | --- | --- |
| [`credentials.ts`](./credentials.ts) | 4.4 | Injectable API key/secret port, plus a fake for tests. Shared by both exchanges |
| [`binance/signing.ts`](./binance/signing.ts) | 4.2 | HMAC-SHA256 via Web Crypto, and the clock-drift offset |
| [`binance/filters.ts`](./binance/filters.ts) | 4.3 | `exchangeInfo` parsing, and the exchange-agnostic order validation and filter cache |
| [`binance/parse.ts`](./binance/parse.ts) | 4.1, 5.4 | Payload parsing, weight headers and limits, error classification |
| [`binance/client.ts`](./binance/client.ts) | 4.1 | The REST methods (eight + `listTradablePairs`), each wrapped in downtime detection |
| [`gemini/signing.ts`](./gemini/signing.ts) | 4.2 | HMAC-**SHA384** over a base64 JSON payload, and the monotonic **nonce** (no clock sync) |
| [`gemini/filters.ts`](./gemini/filters.ts) | 4.3 | `symbols/details` parsing (with the field-name inversion); re-exports the shared validator |
| [`gemini/parse.ts`](./gemini/parse.ts) | 4.1 | Payload parsing (boolean order-state flags, `fee_currency`, derived balances), error classification |
| [`gemini/client.ts`](./gemini/client.ts) | 4.1 | The same REST surface, POST-with-header-auth, and lookup-then-cancel |
| [`rate-limited.ts`](./rate-limited.ts) | 5.4 | Gate: asks the account's `RateLimiter` for budget before every call (Binance weight table) |

## The second exchange (`gemini/`, step 3.4)

Structurally parallel to `binance/`, but not a copy — Gemini's transport and
payloads differ where they actually differ, each verified against Gemini's own
published reference:

- **Signing is a different mechanism.** `hex(HMAC-SHA384(base64(JSON payload)))`,
  with the key, payload and signature in the `X-GEMINI-*` headers of a POST with
  an empty body — not a signed query string. And there is **no clock sync**:
  Gemini authenticates with a monotonic **nonce**, so the whole
  `getServerTime`/`ClockOffset` apparatus Binance needs has no analogue.
  `getServerTime` returns a clear failure rather than a fabricated value.
- **Order state is boolean flags** (`is_live`/`is_cancelled`), mapped to
  `OrderState` in `gemini/parse.ts`, not a status string.
- **The symbol-detail field names are inverted**: Gemini's `tick_size` is the
  *quantity* increment (our `stepSize`) and `quote_increment` is the *price*
  increment (our `tickSize`), and both arrive as JSON numbers (one in scientific
  notation). `gemini/filters.ts` is where that trap is handled.
- **Cancel is by numeric `order_id` only**, so `cancelOrder` resolves the
  `client_order_id` to an `order_id` first, then cancels — the cancel response
  still carries the final filled quantity.

`validateOrder` and `SymbolFilterCache` are exchange-agnostic and have one
implementation, physically under `binance/filters.ts` (a step-3 accident, when
there was one exchange); `gemini/filters.ts` re-exports them so the Gemini client
never reaches across into `binance/`. Hoisting them to a neutral module is a
deferred refactor.

The Gemini implementation is built and tested but **not yet dispatched to**:
nothing chooses Gemini over Binance for a bot yet, exactly as production Binance
was left unwired at step 3.2. `src/workers/exchange-gemini.ts` holds the ready
`ENVIRONMENT`-derived base URL and fail-closed `GEMINI_API_KEY`/`GEMINI_API_SECRET`
resolver for when that dispatch step arrives.

## The gate (`rate-limited.ts`, step 8)

`BinanceClient` reports weight; it does not ask permission. `RateLimitedExchange`
wraps any `RestExchangeClient` and requests budget from the account's
`RateLimiter` Durable Object before each call, so no path reaches the exchange
without a grant. It lives here rather than in `/src/shared` because it carries
Binance's per-endpoint weight table and because it performs I/O.

**Priority is chosen by which view a call site holds**, not by which method it
calls: `withPriority("risk-exit")` returns a second view over the same client
and the same budget. Deriving it from the verb — "every cancellation is
risk-exit" — was rejected because it makes the tag a property of the operation
rather than of the intent, so ordinary rebalancing would draw on the slice
reserved for stop-losses.

A refusal returns a `rate_limited` failure, which means precisely that **nothing
was sent** — a third thing from "sent, outcome unknown" (`transport`) and "sent,
refused" (`exchange_error`), and the reason it needed its own `FailureKind`.

## Why this is not in `/src/shared`

Every module in `/src/shared` performs no I/O, reads no clock, and touches no
storage. That property is what makes them reusable unchanged in backtest mode
(section 13). These modules do perform I/O, so keeping them here leaves that
guarantee literally true rather than qualified.

The *interface* still lives in `/src/shared`, because strategy code depends on
it and must never depend on anything in this folder.

## Request/response only — the feed is not a client method

There is no `subscribeToPriceFeed` and no live socket here. Section 4.6 puts the
price feed inside a Durable Object, and step 14 established the harder fact: an
**outbound** WebSocket (our object dialling out to the exchange) does **not**
hibernate, so the feed cannot be a hibernating client method the way the spec
first imagined. The feed is its own Durable Object that owns its socket
lifecycle; `BinanceClient` and `GeminiClient` stay purely request/response.

`getCandles` (added at step 14) is the one REST method the feed leans on: its
gap-backfill on reconnect reads historical candles through it, and section 13's
backtest reads the same method. It is public/unsigned on both venues. Note the
Gemini wrinkle — its candle OHLCV arrive as JSON numbers, not decimal strings —
handled in `gemini/parse.ts`, and the `since` asymmetry between the two venues,
documented on the interface itself.

## Every call returns an outcome

No method here returns a bare value and none throws on a failed request. Each
resolves to an `ExchangeOutcome<T>`, so section 5.6's rule is enforced by the
type system: a failed request cannot reach a stop-loss evaluation without
`isUsable` narrowing it first.

```typescript
const outcome = await client.getCurrentPrice("BTCUSDT");
if (!isUsable(outcome)) return;   // narrowed; failure cannot leak past here
evaluateStopLoss(outcome.value);
```

This is a deliberate deviation from section 4.1's literal `Promise<Price>`
signatures. See decision 1 in the step 3 entry of the
[decision log](../../docs/decision-log/03.md).

## Retrying happens at the call site

`withRetry` in the downtime module takes an operation of exactly the shape these
methods have, so a caller composes it where a retry is right:

```typescript
await withRetry((attempt) => client.getCurrentPrice("BTCUSDT"), { maxAttempts: 3, sleep });
```

And, more importantly, does not where it is wrong. Section 5.1 requires a placed
order to be recovered by looking it up, never by re-sending it, so `placeOrder`
must not be wrapped this way.

## Validating an order twice

Section 4.3 requires two independent checks. `validateOrder` serves both, and
the mode is the difference:

- `{ rounding: "adjust" }` — at construction, moves price and quantity onto the
  exchange's grid. Buy prices floor, sell prices ceil, quantities always floor.
- `{ rounding: "verify" }` — immediately before sending, reports an off-grid
  value instead of repairing it. `placeOrder` does this itself.

Rounding again at send time would silently fix the corruption the second check
exists to catch.

## Credentials in tests

Nothing in the automated suite needs a real key. `fakeCredentialProvider()`
returns the example pair published in the exchange's own signing documentation,
which is also what lets `signing.test.ts` assert against *their* stated
signature rather than against this implementation's own output.

The real secret-backed provider is a thin wrapper over `env`, added when this
first deploys. Section 16.1 sets those secrets by hand, never in CI.
