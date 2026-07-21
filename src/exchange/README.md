# Exchange integration layer

The Binance implementation of the interface in
[`../shared/exchange-client.ts`](../shared/exchange-client.ts)
(spec section 4, build step 3).

| Module | Spec | What it does |
| --- | --- | --- |
| [`credentials.ts`](./credentials.ts) | 4.4 | Injectable API key/secret port, plus a fake for tests |
| [`binance/signing.ts`](./binance/signing.ts) | 4.2 | HMAC-SHA256 via Web Crypto, and the clock-drift offset |
| [`binance/filters.ts`](./binance/filters.ts) | 4.3 | `exchangeInfo` parsing, order validation and rounding, filter cache |
| [`binance/parse.ts`](./binance/parse.ts) | 4.1, 5.4 | Payload parsing, weight headers, error classification |
| [`binance/client.ts`](./binance/client.ts) | 4.1 | The eight REST methods, each wrapped in downtime detection |

## Why this is not in `/src/shared`

Every module in `/src/shared` performs no I/O, reads no clock, and touches no
storage. That property is what makes them reusable unchanged in backtest mode
(section 13). These modules do perform I/O, so keeping them here leaves that
guarantee literally true rather than qualified.

The *interface* still lives in `/src/shared`, because strategy code depends on
it and must never depend on anything in this folder.

## REST only

`subscribeToPriceFeed` is deliberately absent. Section 4.6 puts the WebSocket
connection inside a Durable Object using the Hibernation API, so it cannot
belong to a client object a Worker constructs per request — the connection has
to outlive the request that opened it.

The interface is therefore split in two. `BinanceClient` implements
`RestExchangeClient`, the eight-method REST surface. `ExchangeClient` extends it
with the price feed, and step 6's Durable Object is what will implement that.

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
[decision log](../../docs/decision-log.md).

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
