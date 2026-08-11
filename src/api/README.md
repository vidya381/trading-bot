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
| `POST /api/bots/:id/archive` | one boolean on the `bot_instances` row + an audit entry (step 26). `halted`/`stopped` only (`invalid_status`, 409); idempotent (`already_archived`). Touches no Durable Object, no history table and no ledger row — see below |
| `POST /api/bots/:id/unarchive` | the same boolean, back. Never status-gated; idempotent (`not_archived`) |
| `GET /api/accounts` | registered accounts and their exchange, from the `accounts` table (step 11) |
| `GET /api/accounts/:label/symbols` | the account's live tradable pairs via its real client's `listTradablePairs`, KV-cached (step 11) |
| `GET /api/accounts/:label/candles` | `fetchCandleWindow` (section 21.4 Stage 1, `/src/research`). `pair` and `interval` both required with no default; publishes every depth field (`truncated`, `missingHistoryMs`, `earliestOpenTime`) so a short venue window is stated rather than inferred from the array length |
| `GET /api/accounts/:label/gather` | `gatherCandidateData` / `gatherCandidateSetData` (section 21.4 Stage 1 assembly). `?entryPoint=named&pair=` gathers one candidate; `?entryPoint=watchlist` gathers the whole watchlist; `?entryPoint=general` is **503 `no_trending_vendor`** before any work, because no trending vendor exists. **A 200 means assembly ran, never that every input worked** — each input carries its own `ok`/`failed`/`threw_unexpectedly`/`not_yet_available` outcome and there is deliberately no top-level success flag |
| `GET /api/watchlist` | `readWatchlist` (section 21.3, `/src/research`); `?accountLabel=` narrows, an unregistered one is a 404 rather than an empty list |
| `POST /api/watchlist` | `addToWatchlist` — cap, fail-closed tradability, duplicate and audit all in the module. `TradablePairSource` is wired to the same cached `listAccountSymbols` the symbols endpoint uses. A body `actor` is **refused** (400), never ignored |
| `DELETE /api/watchlist/:id` | `removeFromWatchlist` (a soft delete). Addressed by id, so the handler adds one guard the module cannot: a non-live id is refused, because a removed row and a live row may share `(account, pair)`. Deliberately never re-checks tradability — see below |
| `GET /api/alerts` | `alerts`, filtered by category/severity/resolved |
| `POST /api/manual-adjustments` | `manual_adjustments` insert + audit entry |
| `GET /api/circuit-breakers` | `readCircuitBreaker` per account |
| `POST /api/circuit-breakers/:accountLabel/reset` | `resetAccountCircuitBreaker` |
| `GET /api/kill-switch` | `readGlobalKillSwitch` |
| `POST /api/kill-switch/trigger` | `tripGlobalKillSwitchFromEnv` |
| `POST /api/kill-switch/reset` | `resetGlobalKillSwitchFromEnv` |
| `GET /api/reconciliation` | `audit_log` `reconciliation.run` entries |
| `GET /api/health` (+ `/health`) | version/environment probe, unauthenticated |

## The watchlist endpoints (section 21.3)

Thin, in the strict sense this layer means it: the cap, the fail-closed
tradability check, the duplicate check, the human-actor rule and both audit
entries all live in `/src/research/watchlist.ts` and none of them are
re-implemented here. What this layer adds is the HTTP shape, the registry lookup
that turns an `accountLabel` into a `WatchlistAccount`, and the port wiring.

**The `TradablePairSource` port is the real one.** `tradablePairsFor` calls the
same `listAccountSymbols` as `GET /api/accounts/:label/symbols`, with the same
KV cache and the same `ctx.symbolLister` (defaulting to `envSymbolLister` →
`listTradablePairs`). Shared deliberately: the watchlist's idea of what a venue
lists cannot drift from the dropdown an operator reads, and a check does not
spend a full-catalogue exchange request per add. A read failure is never cached,
so the fail-closed refusal is always against a live attempt.

**A body `actor` is refused, not ignored.** The actor is always `ctx.actor`, the
email verified off the Access JWT. That is this layer's standing rule, and it
bites hardest here: the module refuses automated actors on purpose, so a
body-supplied actor would let any authenticated caller write "chosen
deliberately by the operators" under someone else's name — in the one table
whose entire value is that a named human vouched for each row. Silently
overriding it would record a different person than the caller believes they
recorded.

**Removal does not re-check tradability, deliberately.** Refusing to remove a
*delisted* pair would trap exactly the entry most in need of removing, and an
exchange outage would be enough to freeze the list. This is the same stance the
rest of this layer already takes on shrinking actions: `unarchive` is never
status-gated ("a gate here could only ever strand a bot"), and `halt` asserts
neither risk latch. A gate belongs on the action that adds risk, not on its
reversal.

**Status mapping** reuses codes with the same *shape* of refusal rather than
inventing per-endpoint ones — `cap_exceeded`/`already_watched` 409 (a conflict
with current state, like `duplicate_bot_instance`), `not_watched` 404,
`pair_not_tradable` 400, `tradable_set_unreadable` 503 (the "dependency is down"
tier with `not_attached`, and **not** the symbols endpoint's 502, because this is
a refusal to write on unverifiable input rather than a relayed read failure).

**No dashboard control yet** — deliberately a later step. These are the
curl-callable surface that replaces editing the table by hand.

## Archiving (`archived`, step 26)

Every bot summary carries `archived: boolean`, read straight off
`bot_instances.archived` (migration 0007). It is **orthogonal to `status`**: an
archived bot is halted or stopped, but a halted bot is not archived by
implication.

**Archiving is a view decision, and this layer does not act on it.** `GET
/api/bots` returns archived bots exactly as before — no filter, no query
parameter. The dashboard hides them from its default table and shows them behind
a "Show archived" toggle, and it keeps counting them in the account-level totals,
because an archived halted bot still holds its capital allocation and may still
hold inventory. A total that changed when a view toggle flipped would be the
silent-omission failure step 25 exists to prevent.

**No data is removed at any point, and that is structural.** `Repository` has no
`delete` method (see `/src/db/table.ts`), and `no-raw-d1.test.ts` fails the build
if anything outside `/src/db` reaches for the raw binding to route around it.
Archiving writes `archived` and `updated_at` on one row; it never calls a
mutating Durable Object method, and it never touches `orders`, `trades`,
`alerts`, `audit_log` or `capital_ledger`.

The one interaction with the rest of the system: `start` and `resume` refuse an
archived bot with `bot_archived` (409), raised in this layer before the object is
called. Otherwise a resumed archived bot would be **running and hidden from the
default view**.

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
