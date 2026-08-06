# `/src/api` — the dashboard HTTP API

Spec step 10 (the dashboard's backend half) and section 11 (Cloudflare Access),
build step 10. The REST endpoints the React dashboard will call. **No business
logic lives here**: every handler is a thin wrapper over functionality built in
earlier steps (the capital ledger, the `BotInstance` object, the account circuit
breaker, the global kill switch, reconciliation). What is new is the HTTP shape,
the JSON envelope, and the Access JWT verification.

The binding-aware entry is `handleApiRequest`, called by `/src/workers/api.ts`
for every `/api/*` request. `/health` (and its `/api/health` alias) is handled
in the Worker, unauthenticated, and is deliberately outside this surface.

## Files

| File | What it is |
| --- | --- |
| `index.ts` | `handleApiRequest`: authenticate → route → dispatch, in one try/catch. |
| `access.ts` | Cloudflare Access JWT verification (RS256 via Web Crypto). |
| `router.ts` | A minimal path matcher (`/api/bots/:id`) and the request context. |
| `handlers.ts` | The endpoint handlers, one thin wrapper each. |
| `serialize.ts` | Money → decimal string, and the camelCase row/detail views. |
| `envelope.ts` | The `{ data, error }` envelope and the error → HTTP-status map. |

## The envelope

Every endpoint answers `{ data, error: null }` on success and
`{ data: null, error: { code, message } }` on failure. The `code` is the typed
error code the wrapped modules already throw (`insufficient_capital`,
`invalid_status`, `globally_tripped`, …), carried through verbatim so the
frontend can branch on it. `envelope.ts` maps those codes to HTTP statuses.

## Money

Serialized as the canonical fixed-precision **decimal string**
(`toDecimalString`, e.g. `"500.00000000"`), never a JS number — a real-money API
must not lose precision past 2^53 or on fractional cents. Request bodies carry
money the same way and are parsed with `fromDecimalString`.

## Authentication (section 11)

Cloudflare Access gates the Worker at the edge; this layer is the defensive
second check. Before any handler runs, `access.ts`:

1. verifies the `Cf-Access-Jwt-Assertion` JWT's RS256 signature against
   Cloudflare's JWKS (fetched from `<team-domain>/cdn-cgi/access/certs`, cached
   per isolate, refetched once on an unknown `kid`);
2. checks `aud` (== `ACCESS_AUD`), `iss` (== `https://<team-domain>`), `exp`
   and `nbf`;
3. requires the `Cf-Access-Authenticated-User-Email` header to MATCH the
   verified token's `email` claim.

The **verified** email is the `audit_log` actor for every write. Config comes
from `ACCESS_AUD` (a secret, per environment) and `ACCESS_TEAM_DOMAIN` (a
wrangler.jsonc var). If either is absent the layer **fails closed** with a 503
rather than trusting the header alone.

## Endpoints

| Method & path | Wraps |
| --- | --- |
| `GET /api/bots` | D1 rows + each bot's DO snapshot (position, PnL) + per-bot fee totals from `trades` (step 25) |
| `GET /api/bots/:id` | DO snapshot + D1 order/trade/alert history + the same fee totals |
| `POST /api/bots` | `BotInstance.create`/`createGrid` (ledger check + SL/TP reused); exchange derived from the `accounts` registry (step 11) |
| `POST /api/bots/:id/start` | `BotInstance.start` (step 6); `created -> running` only, its `invalid_status` refusal surfaced as 409 |
| `POST /api/bots/:id/halt` | `BotInstance.halt("manual", …)` (section 7.2) for ONE bot, with a required free-text `reason` and the verified human as actor. Idempotent (`already_halted`); asserts neither latch, since a halt reduces risk |
| `POST /api/bots/:id/apply-missed-fills` | `BotInstance.applyMissedFills` (step 18's order-state-drift repair); halted bots only |
| `POST /api/bots/:id/resume` | `BotInstance.resume` (section 7.2 step 5); `halted -> running` only. Refuses with `invalid_status` (409), and — unlike `start` — also `globally_tripped` / `account_tripped` (409), since resume asserts both latches |
| `POST /api/bots/:id/liquidate` | `BotInstance.liquidatePosition` (step 10.3) |
| `GET /api/accounts` | registered accounts and their exchange, from the `accounts` table (step 11) |
| `GET /api/accounts/:label/symbols` | the account's live tradable pairs via its real client's `listTradablePairs`, KV-cached (step 11) |
| `GET /api/alerts` | `alerts`, filtered by category/severity/resolved |
| `POST /api/manual-adjustments` | `manual_adjustments` insert + audit entry |
| `GET /api/circuit-breakers` | `readCircuitBreaker` per account |
| `POST /api/circuit-breakers/:accountLabel/reset` | `resetAccountCircuitBreaker` |
| `GET /api/kill-switch` | `readGlobalKillSwitch` |
| `POST /api/kill-switch/trigger` | `tripGlobalKillSwitchFromEnv` |
| `POST /api/kill-switch/reset` | `resetGlobalKillSwitchFromEnv` |
| `GET /api/reconciliation` | `audit_log` `reconciliation.run` entries |
| `GET /api/health` (+ `/health`) | version/environment probe, unauthenticated |

## The bot summary's fee figure (`fees`, step 25)

Every bot summary carries `fees: { reported, unpricedCount }`, denominated in
**that bot's own `capitalAsset`**.

`reported` is a **floor, not a total**. It sums `trades.fee_reporting_amount` —
the fee converted to the capital asset at fill time by `#mirrorTrade` — and that
column is NULL for every fill whose fee could not be priced. Section 5.5 rule 1:
a venue charges in whatever asset it likes (Binance commonly charges in BNB),
and when no rate is available all three reporting columns are left NULL rather
than guessed (step 2 decision 9; migration 0001's `fee_conversion_all_or_nothing`
CHECK). SQLite's `SUM` skips those rows silently, so **`unpricedCount` is what
makes the omission visible** and is not optional context.

A non-zero `unpricedCount` means any net figure derived from `reported`
understates cost and therefore **overstates profit**. `realizedPnl` in
`shared/fees.ts` answers this by withholding its `net` entirely (`complete:
false`), and the dashboard's account rollup does the same rather than showing a
caveated number.

Three more summary fields exist for the same rollup: `position.cost` (now on the
grid arm too, from `ladder.heldCost`), `lastPrice`, and `cycleCount`. The last
two are **null for an orphan** — an object holding no state has not seen a price
of zero and has not completed zero cycles; both are unknown. And `cycleCount` is
**DCA-only**: it is incremented solely by `#completeCycle`, so a grid bot reports
0 for its entire life.
