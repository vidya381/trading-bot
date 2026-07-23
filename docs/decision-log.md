# Decision Log

A running record of decisions made while building this system, one entry per
build-order step (see section 19 of the technical specification). Append only.

---

## Step 1: Repository setup
Date: 2026-07-21

> Written retrospectively, during the step 2 session rather than at the time.
> It is reconstructed from that session's actual tool output and decisions, but
> it was not captured live, so treat it as slightly less complete than the
> entries written as work happened.

### What was built

`package.json` (v0.1.0, no runtime dependencies), `tsconfig.json`,
`wrangler.jsonc` with separate `testnet` and `production` environments, and
`vitest.config.ts` running tests inside `workerd`. Folder structure
`/src/durable-objects`, `/src/workers`, `/src/queues`, `/src/shared`,
`/dashboard`, each with a README naming what belongs there and which build step
delivers it.

A placeholder Worker at `src/workers/api.ts` serving only `/health`, which
reports the `package.json` version and `env.ENVIRONMENT`. Two tests, passing.
`.gitignore` extended for Node/Wrangler. No secrets, no `.env` files.

Resolved versions: wrangler 4.112.0, TypeScript 7.0.2, Vitest 4.1.10,
`@cloudflare/vitest-pool-workers` 0.18.6, workerd 1.20260714.1.

### Decisions made

**1. Resource bindings omitted from `wrangler.jsonc` until each is needed.**
*(asked, confirmed)*

`wrangler.jsonc` declares only name, main, compatibility date, observability and
per-environment `vars`. D1, KV, R2, Queues and Durable Object bindings get added
in the build-order step that introduces each one.

*Scaffolding all bindings now with placeholder IDs — rejected.* It would document
the intended shape from day one, but `wrangler deploy` fails until every
placeholder is replaced with a real resource ID, and fake IDs sitting in a config
file are easy to mistake for real ones later.

*Provisioning the real Cloudflare resources now — rejected.* It creates real
account resources, requires being logged in with a scoped token, and goes beyond
what step 1 asks for.

*Revisit if:* nothing. This resolves itself as later steps add bindings. Worth
noting that `vars` and all binding keys are **non-inheritable** in Wrangler — a
named environment does not inherit them from the top level — which is what makes
the two environments genuinely separate rather than one config with a flag, per
section 16.

**2. `/dashboard` is a placeholder folder only.** *(asked, confirmed)*

*A full React + Vite scaffold now — rejected.* The dashboard is build step 10. A
second toolchain and dependency tree would be maintained through steps 2 to 9
before anything used it.

**3. The Worker reads its version by importing `package.json`.** *(asked, confirmed)*

`import { version } from "../../package.json"` with `resolveJsonModule`; esbuild
inlines it at bundle time. Verified by reading the built bundle: it compiles to
exactly `var version = "0.1.0"`, with no dependency manifest leaked into the
deployed artifact.

*Duplicating `VERSION` into each environment's `vars` — rejected.* The version
would live in three places and drift silently the first time someone bumped
`package.json` without editing `wrangler.jsonc`. Section 16 requires bumping the
version on every deploy, so that would happen often.

*Injecting via a build-time `define` from an npm script — rejected.* Same single
source of truth, but adds a script layer and needs an extra ambient declaration
to stay visible to typechecking.

**4. A top-level `ENVIRONMENT: "unconfigured"` tripwire. (My call, not asked.)**

The base config block is not a deployable environment. A bare `wrangler deploy`
with no `--env` deploys a Worker named `trading-bot` whose `/health` reports
`unconfigured` — loud, and unable to overwrite either real environment because
those use different Worker names. All npm scripts pass `--env` explicitly.

*Making a bare deploy fail outright — considered, not implemented.* Arguably
better. I offered to change it and it was not taken up either way, so it stands.

*Revisit if:* the third Worker showing up in the Cloudflare dashboard is more
confusing than the tripwire is useful.

**5. No `nodejs_compat` compatibility flag.**

Section 2 requires native `fetch` and Web Crypto with no third-party exchange
library, specifically to avoid Node-compatibility risk. Nothing should need a
Node shim. Leaving the flag off means an accidental dependency on one fails at
build time rather than working quietly.

**6. Tests are pinned to the testnet environment.**

`vitest.config.ts` passes `environment: "testnet"`. Tests must never load
production config or production bindings, even locally.

**7. `wrangler types` is run unscoped, and the output is committed.**

Running it with `--env testnet` narrows `ENVIRONMENT` to the literal `"testnet"`,
which would make any later `=== "production"` comparison a type error. Unscoped,
it emits the union `"testnet" | "production" | "unconfigured"` plus per-
environment interfaces. `cf-typegen` therefore takes no `--env`.

The generated `worker-configuration.d.ts` is 14,713 lines and self-contained
(it includes runtime types), so no `@cloudflare/workers-types` dependency is
needed. Committed rather than gitignored, following Cloudflare's own templates.

**8. `compatibility_date` pinned to `2026-07-14`, the installed workerd build
date.** Today is 2026-07-21, but a date ahead of the runtime's support range
produces warnings.

**9. Tests are colocated in `/src` rather than a separate `/test` directory.**
Avoids inventing a top-level folder outside the agreed structure. esbuild only
bundles what `main` imports, so `*.test.ts` never reaches the Worker.

**10. The existing `docs/` ignore line was preserved rather than overwritten.**
It was a deliberate choice already in the repo, so `.gitignore` was extended
around it. *(Since superseded: `docs/` is now tracked and the spec has moved to
`planning/`, which is ignored instead.)*

### Deviations from the spec

- **`defineWorkersConfig` does not exist.** Cloudflare's published docs and most
  online examples show `import { defineWorkersConfig } from
  "@cloudflare/vitest-pool-workers/config"`. That subpath is not in the
  package's exports map at all in v0.18.6. The first `vitest.config.ts` was
  written against it and failed typecheck. The working API is a `cloudflareTest()`
  Vite plugin inside a standard `defineConfig`. Found by reading the shipped
  `dist/pool/index.d.mts` directly.
- **`cloudflare:test` types come from a subpath.** Related second failure:
  `"types": ["@cloudflare/vitest-pool-workers"]` in `tsconfig.json` resolves but
  does not provide `SELF`. It must be
  `"@cloudflare/vitest-pool-workers/types"`. Two attempts total before typecheck
  was clean.
- **Section 16 requires separate D1 databases per environment; none exist yet.**
  Deferred by decision 1. The separation is real but not yet visible in config.
- **Section 11.3's per-environment dashboards do not exist.** The dashboard is a
  placeholder folder; Cloudflare Access is step 11. The `/health` half of
  section 11.3 — confirming the environment programmatically — is implemented.
- **Section 16's "bump the version on every deploy" has no history yet.** Started
  at 0.1.0 with nothing deployed.

### Open questions carried forward

1. **The section 5.2 money representation decision.** *(Resolved in step 2,
   decision 1: `bigint` at scale 8.)*
2. **Whether the `unconfigured` tripwire should instead hard-fail** (decision 4).
3. **Cloudflare account access is not yet arranged.** Section 18 wants a scoped
   API token, revocable independently of the main login. Nothing in steps 1 or 2
   needed it, but step 4 cannot create a D1 database without it.
4. **Worker names `trading-bot-testnet` / `trading-bot-production` were chosen by
   me, not confirmed.** Cheap to change now, annoying after deploys exist.
5. **Access allow-lists are explicitly not the builder's call.** Section 11.2 is
   direct about this: the production allow-list determines who can act on real
   funds, and the builder should not assume their own email belongs on it. Needs
   an explicit decision from the account owner before step 11.

---

## Step 2: Shared infrastructure modules
Date: 2026-07-21

### What was built

Seven files in `/src/shared/`: `money.ts`, `order-state.ts`, `idempotency.ts`,
`rate-limiter.ts`, `fees.ts`, `downtime.ts`, and a type-only `exchange-client.ts`
holding the section 4.1 interface. Plus an `index.ts` barrel and a rewritten
module README. 219 unit tests across the six logic modules (221 including step
1's `/health` tests), all passing, typecheck clean.

No module performs I/O, reads a clock, or touches storage — time is a parameter
and storage is an injected port, so everything is testable without a Durable
Object and reusable unchanged in backtest mode (section 13).

### Decisions made

**1. Money is `bigint` scaled by 10^8, stored in D1 as INTEGER.**

Section 5.2 offered "integers in the smallest unit, or a decimal library". Chose
integers, specifically `bigint`.

Before deciding, I wrote a throwaway probe test against local D1 in the real
Workers runtime, because the decision rested on persistence behaviour I was not
willing to assert from memory. It measured:

- D1 returns INTEGER to JS as `number` — `100000000000000001` came back as
  `...000`. Silent precision loss above 2^53.
- `.bind(bigint)` throws `D1_TYPE_ERROR: Type 'bigint' not supported`.
- `.bind(String(bigint))` into an INTEGER column stores exactly, with `integer`
  affinity, and `ORDER BY` remains numeric (not lexicographic).
- `CAST(col AS TEXT)` reads back exactly, including `SUM()` over mixed signs.
- `structuredClone(bigint)` round-trips, so DO storage needs no workaround.

The probe was deleted and the config change reverted before any real code was
written; the findings live in `money.ts`'s header comment and the shared README.

*decimal.js — rejected.* It works in Workers (pure JS, no Node APIs), so section
2's Node-compat concern did not rule it out. It was rejected on persistence:
decimal.js values serialize to string, which forces TEXT columns in D1. That
kills the periodic summary aggregation job in section 3, because `SUM()` becomes
impossible and `ORDER BY` sorts `"9"` above `"10"`. Secondary reasons: it adds a
runtime dependency against section 2's auditability preference, and its precision
is a globally mutable config (`Decimal.set`), which is a poor fit for money.

*Plain `number` integers — rejected outright.* `price * quantity` with both sides
at scale 8 produces a result scaled by 10^16, past `Number.MAX_SAFE_INTEGER`
(9.007e15) on the very first notional calculation. Any integer representation
here has to be arbitrary-precision.

*`bigint` with TEXT columns in D1 — rejected.* Escapes the int64 ceiling, but
loses SQL-side aggregation and numeric ordering for a ceiling that scale 8 does
not come close to hitting.

*Revisit if:* a traded pair needs more than 8 decimal places on price or
quantity (Binance spot `tickSize`/`stepSize` never go below 1e-8 today, so this
means a change on their side); or a position exceeds ~92 billion units, the
int64 ceiling at this scale; or D1 gains a bigint-native read path, which would
make the CAST-on-read rule unnecessary; or reporting moves off SQL aggregation,
which would remove the main argument against decimal.js.

**2. Scale 8, not 10, and not per-value.**

*Scale 10 — rejected.* Two more digits of headroom for derived values like DCA
average entry price, but the int64 ceiling drops to ±922 million. A
billion-token position in a cheap asset would overflow on storage.

*Per-value scale (`{v: bigint, scale: number}`) — rejected.* Handles both
extremes, but doubles every money column in D1, requires every arithmetic
operation to reconcile scales first, and is substantially more code to get right
in the one area where correctness matters most.

*Revisit if:* the same conditions as decision 1.

**3. No default rounding mode anywhere in `money.ts`.**

Every `mul`, `div`, `roundToStep` and `percentToRate` call names its rounding
explicitly. There is also an `"exact"` mode that throws on any precision loss.

*A sensible default such as half-up — rejected.* The correct direction is
context-dependent: order quantities must round **down**, because rounding up
risks an insufficient-balance rejection from the exchange, while price rounding
to tick size depends on order side. A default would silently be wrong at some
call site, and that call site would look identical to a correct one.

Internal accounting functions that are not part of the generic maths surface
(`order-state.ts`'s notional, `fees.ts`'s conversion and PnL) do pick a mode:
half-even, chosen because it has no directional bias and these values accumulate
across many fills.

*Revisit if:* the explicitness proves noisy enough in strategy code that call
sites start getting it wrong out of fatigue — the opposite of the intent.

**4. `partially_filled -> cancelled` is a permitted transition.** *(asked, confirmed)*

Section 5.3 lists transitions as `pending -> partially_filled -> filled`, or
`pending -> cancelled`. Read literally, a partially filled order can never be
cancelled.

*The literal reading — rejected.* Section 6.2 step 4 and the section 7.2 halt
behaviour both cancel all open orders, and some of those will be partially filled
at that moment. The literal reading blocks a mandatory risk control. The
cancelled order retains its filled quantity, so the position stays correct.

*Revisit if:* never, realistically. This is a correction to the spec, not a
preference.

**5. `rejected` and `expired` added as terminal states.** *(asked, confirmed)*

*Keeping only section 5.3's four states — rejected.* `getOrderStatus` and the
section 9 reconciliation job can both observe these from the exchange. Without
them, a routine rejection becomes an unmapped-state error, which section 7.5
escalates to a halt plus alert. That is a false alarm on a normal event.

**6. `clientOrderId` is readable and parseable, not hashed. Bot instance IDs
must be slugs of at most 20 characters.**

Format is `v1-{botInstanceId}-{sequence}`, with `parseClientOrderId` recovering
both parts.

*Hashing an arbitrary bot instance ID (e.g. FNV-1a to 16 hex chars) — rejected.*
It would accept any ID format, including UUIDs, and fit comfortably inside the
exchange's 36-character limit. Rejected because section 9 reconciliation fetches
open orders from Binance and needs to attribute each one to a bot. A hash cannot
be reversed, so an unexpected or orphaned order would be untraceable — which is
precisely the case reconciliation exists to investigate.

The cost is a real constraint on step 6: **bot instance IDs cannot be UUIDs.**
They must match `/^[a-z0-9][a-z0-9_-]{0,19}$/`.

*Revisit if:* bot instance IDs need to be UUIDs for some other reason. That
would require a side lookup table from short slug to UUID, which is more moving
parts than it sounds.

**7. `MAX_SEQUENCE` bounded to 12 digits — a fix, not an original design.**

My first version validated only that the sequence was a non-negative safe
integer, then checked the assembled ID's length and threw if it exceeded 36. A
test caught that a 20-character slug plus `Number.MAX_SAFE_INTEGER` produces a
40-character ID. The generator refused it correctly, but that means the length
invariant held only if callers happened to keep sequences small — it was not
total.

Bounding sequences to 12 digits makes the worst case exactly 36 characters
(`3 + 20 + 1 + 12`), so no valid input can produce a rejected ID. The length
check remains as an unreachable guard against future changes to the scheme.

*Leaving it as a runtime check — rejected.* It would surface at the moment an
order was being placed, which is the worst possible time to discover an ID
format problem.

**8. State-machine anomalies are typed errors with a `code`, not a result union
and not plain throws.**

`OrderStateError` carries codes: `invalid_transition`, `duplicate_fill`,
`overfill`, `fill_after_terminal`, `invalid_quantity`.

Several of these describe races that genuinely happen: a fill crossing a
cancellation, or a redelivered queue message replaying a fill.

*Plain throws — rejected.* Section 7.5 turns unhandled exceptions into an
immediate halt. A redelivered queue message is routine, not an emergency.

*A discriminated-union return type — rejected.* More faithful, but it forces
every call site to destructure a result even in the overwhelmingly common
success path. Codes let step 6 catch and branch, routing these to reconciliation
(section 9) instead of a halt.

*Revisit if:* step 6 finds catch-and-branch awkward in practice, particularly
inside queue consumers.

**9. `realizedPnl` returns no `net` figure at all when any fee failed to
convert.**

The key is absent from the returned type, not zero and not a guess.

*Computing net from the fees that did convert — rejected.* It would overstate
profit while looking authoritative. The error would surface much later as a
balance discrepancy in reconciliation, by which point its cause is hard to find.

*Throwing — rejected.* The caller can still usefully display gross and a partial
fee total clearly marked incomplete; throwing discards that.

**10. Rate-limiter priority is a reserved budget slice, not just queue ordering.**

Routine requests may only draw on `limit - reserveForRiskExit`; risk-exit
requests may use the full limit.

*Priority queue ordering alone — rejected.* Ordering decides who goes first
among *waiting* requests. It does nothing about the case that actually matters:
routine ladder maintenance having already spent the entire budget before the
stop-loss is even created. A reservation makes starvation structurally
impossible.

*A fixed window rather than sliding — rejected.* A fixed window permits a full
limit's traffic on either side of a boundary, i.e. double the intended rate
across it, which is how an account gets rate-limited.

Both mechanisms are implemented: `admit()` also does head-of-line blocking so a
large risk-exit request cannot be starved by smaller ones queued behind it.

**11. Coverage tooling installed, found broken, and removed.**

I tried to measure line coverage per module and could not.
`@vitest/coverage-v8` does not run under `vitest-pool-workers` at all — 7 errors,
zero tests collected. `@vitest/coverage-istanbul` runs but silently omits
modules: running `downtime.test.ts` alone reported coverage for five *other*
modules and nothing for `downtime.ts` itself. The full run consistently listed
only 3 of 6 modules. Deterministic across runs, so not a race, but the numbers
are simply wrong.

Uninstalled both rather than leave misleading tooling in `package.json`. The
~98.6% figure istanbul briefly reported is discarded and should not be quoted.
Per-module test counts are the only coverage evidence currently available.

*Revisit at:* step 13 (CI/CD), where a coverage gate would otherwise be built on
numbers that do not mean what they appear to.

**12. Storage is an injected port (`AttemptStore`), not Durable Object code.**

Closer to routine, but recording it because it sets a pattern for steps 4 and 6:
shared modules define the interface they need, and the Durable Object supplies
an implementation. `InMemoryAttemptStore` copies records on both `get` and `put`
so that in-memory behaviour matches a persisted implementation, which does not
share references either.

That copy-on-read was itself a bug fix — the first version copied only on write,
so a caller mutating a returned record silently corrupted the store. A test
caught it. It would have passed every in-memory test and broken on the real DO
implementation at step 6.

### Deviations from the spec

- **Section 5.3's transition list is incomplete.** It omits
  `partially_filled -> cancelled`, which sections 6.2 and 7.2 require. Added.
- **Section 5.3 omits `rejected` and `expired`.** Both are observable from the
  exchange. Added as terminal states.
- **Section 4.1 names supporting types but never defines them.** `SymbolFilters`,
  `Price`, `Candle`, `OrderRequest`, `OrderResult`, `OrderStatus`, `Balance`,
  `Fill` and `WebSocketHandle` were all designed here from scratch. **These have
  not been checked against a single real Binance response** and are the most
  likely thing in this session's output to change at step 3.
- **Naming collision resolved:** section 4.1 uses `OrderStatus` for a record
  returned by `getOrderStatus`, while section 5.3 uses "order states". Kept
  `OrderStatus` as the record and named the enum `OrderState`.
- **Section 5.2's persistence guidance is less strict than reality requires.** It
  says to apply the convention "in Durable Object stored state, D1 columns, and
  all calculations". It does not anticipate that D1's JS binding rejects `bigint`
  on write and returns INTEGER lossily on read. The actual rules — bind
  `toStorageString`, read via `CAST(col AS TEXT)` — are stricter than the spec
  implies and must be enforced centrally in the D1 layer at step 4.
- **Section 5.4's header parsing deferred.** The spec says the budget is "read
  from response headers and `exchangeInfo`". Parsing Binance's
  `X-MBX-USED-WEIGHT` headers is Binance-specific and belongs to step 3; this
  module exposes `syncFromExchange(usedWeight, at)` and accepts an authoritative
  figure without knowing its origin.
- **`roundToStep` lives in `money.ts` though section 4.3 is what needs it.** It
  is generic fixed-point arithmetic with a caller-supplied step, not
  exchange-specific, so it sits with the rest of the maths. Applying actual
  symbol filters remains step 3's job.
- **`realizedPnl` lives in `fees.ts`.** Arguably borderline against "no strategy
  logic this session", but section 5.5 explicitly requires fees to be included in
  realized PnL, and the calculation is generic. Weighted average entry price was
  deliberately *not* built, as that is DCA-specific (step 6).

### Open questions carried forward

1. **API credentials in tests.** `wrangler secret` does not exist locally, so the
   Binance client needs an injectable credential source rather than reading
   `env` directly. Decide the shape before writing the client.
2. **Is `subscribeToPriceFeed` buildable at step 3 at all?** Section 4.6 puts the
   WebSocket inside a Durable Object using the Hibernation API, which is step 6
   work. The REST surface may be all that is realistic at step 3, leaving one
   interface method unimplemented in the interim.
3. **The `ExchangeClient` supporting types are unvalidated.** Expect to revise
   them against real payloads. Binance returns all numbers as decimal strings,
   which is convenient — they feed `fromDecimalString` directly with no float
   ever existing — but field names, nesting and the fill shape are guesses.
4. **Bot instance IDs must be short slugs** (see decision 6). Step 6 must honour
   `/^[a-z0-9][a-z0-9_-]{0,19}$/` when minting them. This is easy to get wrong by
   reaching for `crypto.randomUUID()`.
5. **The D1 access layer at step 4 must enforce CAST-on-read centrally.** If
   individual queries are written by hand, someone will eventually select a money
   column directly and silently lose precision above 2^53. This should be
   impossible by construction, not by discipline.
6. **Coverage measurement is unresolved** (decision 11). Needs a working approach
   before step 13 builds any gate on it.
7. **Are `realizedPnl` and `roundToStep` in the right modules?** Both sit near a
   scope boundary. Worth a second opinion before more code depends on their
   location.
8. **No integration test yet exercises two modules together.** Each module is
   tested in isolation. The first real composition — idempotency guard plus order
   state plus fee conversion driving a full order lifecycle — happens at step 6,
   and may surface interface friction that unit tests cannot.

---

## Step 3: Exchange integration layer
Date: 2026-07-21

### What was built

A new `/src/exchange` folder: `credentials.ts`, and `binance/` holding
`signing.ts`, `filters.ts`, `parse.ts` and `client.ts`, plus an `index.ts` barrel
and a folder README. `src/shared/exchange-client.ts` was revised in place.

`BinanceClient` implements the eight REST methods of section 4.1. 210 tests
across the five new modules (431 in total across the project), all passing,
typecheck clean.

Before writing anything, the exchange's published reference (`rest-api.md`,
`filters.md`, `enums.md`, `errors.md`) was fetched and read directly. Step 2's
open question 3 flagged the supporting types as guesses; four of them were wrong,
and the corrections below come from those documents rather than from memory.

### Decisions made

**1. Every interface method returns `Promise<ExchangeOutcome<T>>`.** *(asked, confirmed)*

Section 4.1 writes them as `Promise<Price>`, `Promise<OrderResult>` and so on.
That signature cannot express section 5.6's central rule.

*Keeping `Promise<T>` and throwing on failure — rejected.* A rejected promise
does not stop a caller from catching the error and carrying on with the value it
already had, which is exactly the confusion between "the price has not moved" and
"we cannot reach the exchange" that section 5.6 exists to prevent. Worse, section
7.5 escalates any unhandled exception to an immediate halt plus alert, so a
routine 503 would become a halt event.

*Adding parallel `try*` methods returning outcomes — rejected.* Doubles an
eight-method interface to sixteen, and leaves the unsafe variant with the
shorter, more inviting name.

With the outcome in the return type, `isUsable` is the only way to the value, so
a failed request cannot reach a stop-loss evaluation without the type system
objecting. Section 5.6 becomes structural rather than advisory.

*Revisit if:* never, realistically. This is the whole point of `downtime.ts`.

**2. The interface is split into `RestExchangeClient` and `ExchangeClient`.** *(asked, confirmed)*

`RestExchangeClient` holds the eight REST methods; `ExchangeClient` extends it
with `subscribeToPriceFeed`. `BinanceClient` implements the former.

*A throwing `subscribeToPriceFeed` stub — rejected.* Section 4.6 puts the
WebSocket inside a Durable Object using the Hibernation API, so the connection
must outlive the request that opened it and cannot belong to a per-request client
object. A stub would make the class *look* complete and fail at runtime; the
split records the boundary at compile time, and code that only reads prices and
places orders can depend on the narrower type.

*Revisit if:* step 6 finds the two-interface split awkward once the Durable
Object implements the second half.

**3. The Binance client lives in `/src/exchange`, a new top-level folder.** *(asked, confirmed)*

*Putting it under `/src/shared/binance/` — rejected.* It would honour step 1's
folder structure, but `/src/shared`'s single defining property is that nothing in
it performs I/O, reads a clock, or touches storage — which is what makes those
modules reusable unchanged in backtest mode (section 13). A module doing real
network I/O next to them would force that claim to be qualified. A second
exchange later becomes a sibling folder here.

This does contradict step 1's decision 9 preference against inventing top-level
folders, and that trade was made deliberately.

**4. Tests drive an injected `fetch` port; the documented `fetchMock` does not exist.** *(asked, confirmed)*

The client takes a `fetch`-shaped option defaulting to the global. The plan was
to test mostly through it and add a few tests through the pool's `fetchMock`, per
section 14's "the tool's request-mocking recipes".

**`fetchMock` is not exported by `@cloudflare/vitest-pool-workers` v0.18.6.** The
`cloudflare:test` module exports exactly nineteen names and `fetchMock` is not
among them; the `MockAgent` types are declared in the `.d.ts` but nothing exports
an instance. Verified against both the type declarations and the shipped runtime
module. This is the same class of problem as step 1's `defineWorkersConfig`
finding: the published docs describe an API the installed version does not have.

The default-wiring tests use `vi.stubGlobal("fetch", ...)` instead, which
establishes the same thing that mattered — that omitting the option really does
reach the runtime's own fetch.

*Revisit at:* any pool upgrade. If `fetchMock` appears, the three
`default fetch wiring` tests could move onto it.

**5. Retrying is the caller's job, not the client's.**

No method retries internally. `withRetry` in `downtime.ts` already takes an
operation of exactly the shape these methods have, so it composes for free.

*Retrying inside the client — rejected.* It would put a retry loop around
`placeOrder`, and section 5.1 is explicit that an order whose outcome is unknown
must be recovered by looking it up, never by re-sending. Making retry opt-in at
the call site keeps that decision visible in the diff.

**6. The rate limiter is a reporting sink, not a gate.**

The client parses `X-MBX-USED-WEIGHT-1M` and calls `syncFromExchange`. It does
not ask permission before a request.

Gating belongs in the RateLimiter Durable Object (section 5.4), which arrives at
step 6 and is the only thing that can see all bots on an account. A per-request
client object cannot. `ENDPOINT_WEIGHTS` is exported now so step 6 has a single
source for the documented per-endpoint costs.

Specifically the *one-minute* header, because `WeightBudget` is configured with a
60-second window; feeding it the hourly total would look like a vastly overspent
minute and stall everything for a full window.

**7. The clock offset is biased 500ms backwards.**

The exchange's timing rule is asymmetric: a request is rejected outright if its
timestamp is more than **one second ahead** of server time, but lateness is
tolerated all the way to `recvWindow`, default **five seconds**. Over-estimating
the offset is therefore five times more dangerous than under-estimating it.

The offset itself is computed against the midpoint of the round trip rather than
against the reply time, since the reported time was true at some unknown instant
between sending and receiving. The round trip is retained and exposed, because a
sample taken over a slow link is a less certain sample.

`timestampFor` **throws** rather than falling back to the raw local clock when
unsynced. A silent fallback would sign with a clock nothing has verified, and it
would surface as an authentication error that says nothing about drift.

**8. A `-1021` response clears the offset; `-1006`/`-1007` are reclassified as transport.**

`-1021 INVALID_TIMESTAMP` drops the offset so the next signed request re-syncs
instead of repeating a rejected timestamp.

`-1006` and `-1007` arrive with 4xx-shaped bodies, which `classifyStatus` would
read as a definite refusal. The exchange's own wording for both is "execution
status unknown" — the order may well be resting on the book. They are
reclassified to `transport`, matching how section 5.6 treats a dropped
connection, so recovery goes through the section 5.1 idempotency records rather
than concluding the order was never placed. This is the single most dangerous
misreading available in this file.

**9. The local timeout (15s) is deliberately longer than the exchange's (10s).**

When the exchange gives up it replies with `-1007`, which confirms the request
was *received* — strictly more information than a locally aborted request
provides. Aborting first would discard that and leave an order's fate less clear.

**10. A 200 whose body will not parse is a failure, not data.**

Non-retryable, since the same request returns the same unreadable body. Section
5.6 admits only valid, successful responses into strategy logic, and a
successfully delivered response this code cannot understand is not one.

**11. `validateOrder` takes a rounding mode, so the two checks genuinely differ.**

Section 4.3 requires validation twice, "as a second, independent check". A single
pure function serves both call sites, but the modes are not the same job:
`adjust` at construction moves values onto the grid; `verify` before sending
reports an off-grid value instead of repairing it.

*Rounding again at send time — rejected.* It would silently repair exactly the
corruption the second check exists to catch, making the second call decorative.

Price rounding is side-dependent (buy floors, sell ceils, each away from the
trader's own interest); quantity always floors regardless of side, because
rounding a quantity up risks an insufficient-balance rejection of the whole
order. This follows step 2's decision 3, which anticipated both.

**12. A filter bound of zero means the rule is disabled.**

The published filter rules state this explicitly for `PRICE_FILTER`. It matters
mechanically as well as semantically: `roundToStep` rejects a non-positive step,
so passing a zero `tickSize` straight through would throw rather than accept the
price unchanged. Applied uniformly to every bound, with tests for each.

**13. An unrecognised symbol status or order status throws.**

*Treating an unknown symbol status as "not tradable" — rejected.* It is the safer
default in isolation, but it would leave a bot permanently and inexplicably idle.
Throwing surfaces as a failed outcome with a real cause, and section 7.5 turns it
into an alert a person can act on. The same reasoning applies to an unmapped
order status: guessing which state an order is in is not acceptable.

Note this is narrower than step 2's decision 5, which added `rejected` and
`expired` precisely so that *documented* statuses never fall through. Every
status the exchange documents is now handled; only a genuine API change reaches
the throw.

### Deviations from the spec

Four of step 2's invented types were wrong against real payloads, exactly as its
open question 3 predicted:

- **`Fill` has no timestamp on the exchange's side.** A fill object is
  `{price, qty, commission, commissionAsset, tradeId}` — no time field at all.
  `Fill.executedAt` is now inherited from the parent order's `transactTime`, so
  every fill in one response shares it. Accurate enough for section 5.5's
  "price at time of fill" (the executions are milliseconds apart) but it is an
  inherited value, not an observed one, and the type says so.
- **`Fill.fillId` maps to `tradeId`, which is a JSON number**, not a string. It
  is stringified immediately so the duplicate-fill check in `applyFill` compares
  identity that cannot be affected by float precision.
- **`OrderStatus.fills` cannot be populated and is now optional.** Neither the
  order-status nor the open-orders endpoint returns a fills array; only the
  order-*placement* response does. A required `readonly Fill[]` could only ever be
  satisfied by `[]`, which would assert "this order has no executions" — false
  for a partially filled order read back later. `cumulativeQuoteQuantity` was
  added as the field that *is* available, and is the only route to an average
  fill price. Per-fill history for such an order must come from the account trade
  list, which is reconciliation's concern at step 7.
- **`SymbolFilters` was missing three order-rejecting rules.** Added `minPrice`
  and `maxPrice` (the price filter has three parts; step 2 modelled only
  `tickSize`), `maxNotional` (the current notional filter is a *range*, not the
  floor section 4.3 describes), and `status` (a symbol can be `HALT`, `BREAK`,
  `END_OF_DAY` or `CANCEL_ONLY`, and no order may be placed then). Both the
  current `NOTIONAL` filter and the legacy `MIN_NOTIONAL` are read, since symbols
  carry one or the other depending on age.

Also:

- **Section 4.1's signatures changed shape** (decision 1) and the interface was
  split in two (decision 2).
- **`Price` carries no exchange timestamp.** The price ticker returns a symbol
  and a price and nothing else, so `Price.at` is *receipt* time. Section 5.6's
  freshness checks key off this field, so what they actually measure is "how long
  since we heard", which is the right question but is not the price's own age.
  Documented on the type.
- **`subscribeToPriceFeed` not built**, per section 4.6 and this session's scope.
- **Section 14's `fetchMock` recipe does not exist** in the installed version
  (decision 4).
- **`cancelOrder` still returns `void`**, matching section 4.1 — but the
  exchange's cancel response actually echoes the cancelled order including how
  much of it had filled. That is discarded. See open question 1. *(Since
  superseded: it now returns `OrderStatus`. See the step 3.1 entry.)*
- **Time-in-force is hardcoded to GTC** rather than added to `OrderRequest`.
  Sections 6.2 and 6.3 place resting ladder orders, section 4.5 rules out market
  orders, and an immediate-or-cancel limit would defeat a grid.
- **No live network call anywhere in the suite**, per section 14. Binance's real
  testnet is deliberately not touched by CI; that remains a separate manual
  verification step.

### Open questions carried forward

Still open from step 2: bot instance ids must be short slugs (2.4); the D1 layer
must enforce CAST-on-read centrally (2.5); coverage measurement is unresolved
(2.6); no integration test yet exercises two modules together (2.8, now partly
addressed — `client.test.ts` drives the real `WeightBudget` from response
headers).

Resolved from step 2: the credential shape (2.1) and whether
`subscribeToPriceFeed` was buildable at step 3 (2.2).

New:

1. **`cancelOrder` discards the exchange's final filled quantity.** The response
   body carries it and section 7.2's halt path cancels orders that may be
   partially filled. Returning it would mean adding a type to section 4.1's
   surface, so it was left alone pending a decision. Worth settling before step 6
   builds the halt path. *(Resolved in step 3.1: it returns `OrderStatus`.)*
2. **The client reports rate-limit weight but does not gate on it.** Nothing yet
   refuses a request that would exceed the budget. Step 6's RateLimiter Durable
   Object closes this, and until then a runaway loop is limited only by the
   exchange.
3. **`Retry-After` is parsed but unused.** `parseRetryAfterMs` exists and is
   tested; no caller consumes it, because retry lives at the call site. Whoever
   wraps these calls in `withRetry` should prefer it over computed backoff when
   the exchange has stated a wait.
4. **A `tradeId` of `-1` would break fill deduplication.** The exchange uses it
   where a trade id does not apply. Normal spot limit fills carry real ids, so
   this is not reachable today, but `applyFill` would reject a second `"-1"` as a
   duplicate.
5. **`recvWindow` and the 500ms clock bias are untested against real latency.**
   Both are reasoned from the documented timing rules, not measured. The manual
   testnet trial is where a genuinely drifting or slow connection would show
   whether the margin is right.
6. **Nothing verifies the API key lacks withdrawal permission.** Section 4.4
   makes that the primary v1 safeguard, and it is enforced only when the key is
   created on the exchange. No code can check it.

---

## Step 3.1: `cancelOrder` returns the cancelled order
Date: 2026-07-21

A scoped fix between steps 3 and 4, not a build-order step of its own. Resolves
step 3's open question 1.

### What changed

`cancelOrder` returned `Promise<ExchangeOutcome<void>>` and threw away the
response body. It now returns `Promise<ExchangeOutcome<OrderStatus>>`.

Three files: `src/shared/exchange-client.ts` (the interface and the `OrderStatus`
type), `src/exchange/binance/parse.ts` (a new `parseCancelledOrder`), and
`src/exchange/binance/client.ts` (wiring). 445 tests, up from 431; typecheck
clean.

### Decisions made

**1. `cancelOrder` returns `OrderStatus`, not `void`.**

A second deliberate deviation from section 4.1's literal signature, of the same
category as step 3's decision 1.

Driven specifically by section 7.2. A halt cancels every open order for a bot
instance, and section 5.3 already accepts that some of those will be partially
filled at that moment — step 2's decision 4 added `partially_filled -> cancelled`
for exactly this reason. The filled quantity at the instant of cancellation is
what determines the position the halted bot is actually left holding, so it is
not incidental detail; it is the number that says what the bot still owns.

The exchange reports it in the cancellation response. Discarding it forced a
follow-up `getOrderStatus` per cancelled order, which is wrong three ways:

- **Slower**, during a halt, which is the one path where speed is a safety
  property rather than a nicety.
- **More weight** against the section 5.4 budget at the worst possible moment,
  and a halt that cancels a full grid ladder is many orders at once.
- **Racy.** The order is live until the cancel lands. A separate read afterwards
  is a different observation at a different instant, and while the window is
  small it is exactly the window in which a resting order fills. The cancellation
  response is the exchange's own account of where the order finished, taken from
  the same operation that ended it — there is no window at all.

*Returning `void` and reading status separately — rejected*, for the above.

*A new `CancelResult` type — rejected.* It would have carried the same fields
under a second name, leaving step 6 to handle two nearly identical shapes for
what is one concept: an order and where it ended up.

**2. `OrderStatus.createdAt` became optional.**

The cancellation payload carries `transactTime` and no creation time whatsoever.

*Filling `createdAt` from `transactTime` — rejected.* It is available and the
types would have been happy, which is what makes it dangerous: every cancelled
order would claim to have been created at the moment it was cancelled. That is a
fabricated value wearing an authoritative type, and section 9's reconciliation
compares timestamps.

*Keeping `createdAt` required by introducing a separate type — rejected*, per
decision 1.

Nothing is actually lost. A bot cancelling an order placed it, so it holds the
creation time in its own `TrackedOrder`. The field exists for reconciliation
reading back orders it did not necessarily place, and those come from the status
endpoints, which do report it.

**3. A separate `parseCancelledOrder`, because the payload has two client order ids.**

This is the part worth remembering.

The cancellation response contains BOTH `clientOrderId` and `origClientOrderId`.
They are not duplicates: `clientOrderId` is the id of the **cancel request**,
freshly generated by the exchange, while `origClientOrderId` is the order that
was actually cancelled. The status endpoints have no such split and correctly use
`clientOrderId`.

Reusing `parseOrderStatus` here would therefore have attributed the result to an
id this system never issued — and **nothing would have thrown**. The field is
present, it is a string, and the returned object would have type-checked
perfectly. A halt would have recorded a filled quantity against a nonexistent
order while the real order's final fill went unrecorded, surfacing much later as
an unexplained position discrepancy in section 9 reconciliation. The kind of bug
that is cheap to prevent and expensive to find.

The shared fields are factored into one `parseCommonOrderFields` so the two
parsers cannot drift, while identity and timestamps — precisely where the
payloads differ — stay explicit in each. There is a test asserting
`parseCancelledOrder` rejects a status-endpoint body outright, as a guard against
the two being used interchangeably later.

Secondary reason for the split: the cancellation payload has no `time` or
`updateTime`, so `parseOrderStatus` would have thrown on it regardless. Only the
id problem was silent.

**4. `updatedAt` is the cancellation instant.**

`transactTime`, which is exactly the moment the reported `filledQuantity`
describes. A caller reading the filled quantity knows precisely what instant it
was true at, which is what makes it safe to write straight into a position.

### Deviations from the spec

- **Section 4.1 writes `cancelOrder(...): Promise<void>`.** It now returns the
  cancelled order. Section 7.2 needs the data and the exchange already sends it.
- **`OrderStatus.createdAt` is optional**, so the one interface type covers both
  the status endpoints and cancellation without either fabricating or duplicating.

### Open questions carried forward

Step 3's open questions 2 through 6 stand unchanged. Question 1 is resolved here.

New:

1. **`state` on a cancelled partial fill comes from the exchange, not from the
   fill maths.** A cancellation of a partially filled order reports `CANCELED`,
   so `parseCancelledOrder` returns `cancelled` with a non-zero `filledQuantity`
   — consistent with step 2's decision 4, and `compareWithExchange` only looks at
   `state` and `filledQuantity`, so the two agree. Worth re-checking at step 6
   when the halt path actually drives `closeOrder` from this value.

---

## Step 4: D1 schema and migrations
Date: 2026-07-21

### What was built

`migrations/0001_initial_schema.sql`: the eight tables of section 8.2, plus 17
explicit indexes (this said 18 when first written; corrected during step 4.1
against the real database, which reports 17). Every table `STRICT`; every money
column `INTEGER`.

`/src/db/`: `columns.ts` (column kinds and their codecs), `table.ts`
(`defineTable` and `Repository`), `schema.ts` (the eight tables as typed specs),
`database.ts` (`Database`, which owns the binding), `index.ts`,
`test-helpers.ts`, and a folder README.

146 new tests across six files (591 in total across the project), all passing,
typecheck clean. Every one runs against real D1 in the Workers runtime, not a
mock — which mattered, see decision 9.

`docs/d1-provisioning.md`: the exact command sequence to create the real
databases, checked against wrangler 4.112.0's own `--help` rather than recalled.
**Not run.** No Cloudflare resource was created and no `database_id` was written
into `wrangler.jsonc` this session, per the session's scope.

### Schema questions asked before writing anything

Five columns in section 8.2 were missing something a later step needs. All were
put to the account owner and all were confirmed additive rather than kept
literal. Recording what each is for, since the reasons are not obvious from the
column names:

1. **`trades.exchange_trade_id`** (UNIQUE with `order_id`) **and
   `trades.bot_instance_id`.** Section 5.1 says queue messages get redelivered.
   Without a unique key on the exchange's own fill id, a redelivered fill
   inserts a second row and realized PnL doubles. This is the database-level
   counterpart of `order-state.ts`'s `duplicate_fill` code — two independent
   layers, because the consequence is a silently wrong money figure.
2. **`trades.fee_reporting_amount`, `fee_reporting_asset`, `fee_conversion_rate`.**
   Section 5.5 requires fees converted at the price *at time of fill*. That
   price is not recoverable afterwards, so a table storing only the raw fee
   makes realized PnL uncomputable from D1 alone — a later recomputation would
   silently use a different rate than the figure the dashboard already showed.
   The rate is stored, not just the result, so a disputed PnL number can be
   explained rather than only asserted.
3. **`manual_adjustments.reconciled_at`.** Section 8.6 says reconciliation
   subtracts *unreconciled* adjustments. With nothing to mark one consumed,
   every run subtracts every adjustment ever logged. The discrepancy maths is
   wrong from the second run onward and drifts further with each entry. Of the
   five this is the only one I would call a spec bug rather than a preference.
4. **`alerts.bot_instance_id`, `alert_type`, `category`.** Section 10 keys the
   KV notification cooldown on (alert type + bot instance) and requires the two
   alert kinds to be visually distinguishable on the dashboard. None of the
   three existed as a column; `source` was free text doing all three jobs.
5. **`bot_instances.halt_reason` + `halted_at`.** Section 7.2 step 3 says a halt
   marks the instance halted "with a recorded reason". Without a column, a
   halted bot cannot explain itself to the human review section 7.2 requires
   before any resume.
6. **`balance_snapshots.reconciliation_run_id` + `classification`**, and
   **`capital_ledger.asset`.** The first groups one reconciliation pass's
   per-asset rows so the dashboard can say "this run found X". The second closes
   a gap where `balance_snapshots` was per-asset and `capital_ledger` was not,
   leaving the reporting currency as an assumption nothing recorded.

### Decisions made

**1. No D1 binding in `wrangler.jsonc`; tests get one from vitest's miniflare
options instead.**

`vitest.config.ts` passes `miniflare: { d1Databases: ["DB"] }`. Miniflare needs
only a binding name to spin up local SQLite; a `d1_databases` block in
`wrangler.jsonc` additionally needs a real `database_id`.

*A placeholder `database_id` — rejected*, consistent with step 1's decision 1.
`wrangler deploy` fails until it is replaced, and a fake UUID in a config file
is easy to mistake for a real one later.

The cost is that the binding is declared in two places for as long as this state
lasts, and `docs/d1-provisioning.md` step 5 exists to make sure it does not
outlive the real database. Recorded as open question 4 below.

**2. Every table is `STRICT`. (My call, not asked. The strongest thing in this
session.)**

Probed against D1's SQLite in the real runtime, because the decision rested on
storage behaviour I was not willing to assert from memory:

| bind into an INTEGER column | non-strict | STRICT |
| --- | --- | --- |
| `"100000000000000001"` | stored, `typeof` = integer | stored, `typeof` = integer |
| `"not-a-number"` | **stored, `typeof` = text** | rejected, `SQLITE_CONSTRAINT_DATATYPE` |
| `"1.5"` | stored as REAL | rejected, "cannot store REAL value" |

The middle row is the reason. Without `STRICT`, a money column that received a
raw string accepts it silently, `SUM()` and `ORDER BY` stop meaning anything for
that row onward, and it surfaces much later as a wrong balance. The third row
catches a specific, plausible accident: binding `toDecimalString` (the
human-readable `"1234.50000000"`) where `toStorageString` was meant. Both are
now write failures.

This is a layer *beneath* the type system, so it survives any bug in the type
system. That is the whole argument for it.

*Relying on the access layer's encoders alone — rejected.* They are the primary
guard and they are good, but the session's brief was correctness by
construction, and "the only code that writes money is correct" is a weaker claim
than "an incorrect write is rejected by storage".

**3. One migration file, not eight.**

*Splitting per table or per concern — rejected.* The eight tables are created
together, deployed together, and have foreign keys between them. Separate files
would imply an independence that does not exist, and would have to be applied in
a fixed order anyway.

Worth knowing for later: `d1_migrations` records applied migrations **by
filename**. Editing `0001` after it has been applied anywhere does nothing on
that database. Nothing is deployed yet, so this session edited `0001` freely
(and deleted `.wrangler/state` to re-apply locally). After step 5, every schema
change is a new numbered file.

**4. The access layer offers no SQL surface at all.**

`Repository` has no method taking SQL and no method taking bind values.
Statements are generated from the declared columns. Four things make the money
convention structural rather than remembered:

- **Encoders are typed to return `Bindable` (`string | number | null`)**, which
  excludes `bigint`. A money encoder that forgot to stringify would not compile.
  This is the type-level version of the runtime `D1_TYPE_ERROR` step 2 found.
- **Select lists are generated**, so money columns are always
  `CAST(col AS TEXT) AS col`. There is no `select(sql)` to route around.
- **`decode` throws on a number** rather than accepting it, naming the missing
  CAST. Unreachable through the layer; it is the backstop for a future refactor.
- **`no-raw-d1.test.ts` fails the build** if any file outside `/src/db` calls
  `.prepare(`, names `D1Database`, or touches `env.DB`.

That last one is the honest part. The first three make the unsafe path
non-existent *within* the layer; nothing in TypeScript can stop a call site
reaching around it to the binding. So it is checked mechanically instead, by
globbing the source with Vite's `?raw` and scanning it. The test also asserts it
found more than twenty files, because a glob that silently returned nothing
would make every other assertion in it pass vacuously.

*A lint rule — considered.* Equivalent in effect, but there is no ESLint in this
project yet and adding one to enforce a single rule is a larger commitment than
a test.

**5. No `delete` method, and no unfiltered `UPDATE`.**

Section 8.7 retains all data indefinitely. A layer with no delete method cannot
violate that by accident, so there is not one. `test-helpers.ts` empties tables
with raw SQL and is the only place that does.

Separately, `update` raises `empty_statement` if given no `WHERE`, because an
unfiltered `UPDATE` rewrites every row in the table and that is never what a
caller meant to type.

**6. Every column is required at insert time. There is no `.withDefault()`.**

A nullable column must be passed an explicit `null`. SQL `DEFAULT`s still exist
in the migration but nothing in the layer relies on them.

*Making columns with SQL defaults optional — rejected.* It reads better at the
call site, but an omitted field then becomes a silent NULL or zero, and in a
table of money values and order states a slightly longer insert call is the
better trade. `filled_quantity: ZERO` at insert says something; an absent
`filled_quantity` does not.

**7. CHECK constraints encode the spec's rules, not just column types.**

Five that do real work:

- `strategy_type <> 'dca' OR take_profit_pct IS NOT NULL` — section 6.3 makes
  take-profit mandatory for DCA because it defines the cycle's exit.
- `status <> 'halted' OR halt_reason IS NOT NULL` — section 7.2 step 3.
  Deliberately one-directional: a halted row must carry a reason, a resumed row
  may keep the last one. Forcing it cleared on resume would make step 6 null two
  columns on every restart to discard occasionally useful information.
- `filled_quantity <= quantity` — the counterpart of `order-state.ts`'s
  `overfill`.
- `id GLOB '[a-z0-9]*' AND length(id) BETWEEN 1 AND 20` on `bot_instances` —
  step 2's decision 6 requires short parseable slugs, and step 2's open question
  4 specifically warned that step 6 would reach for `crypto.randomUUID()`. A
  UUID is 36 characters, so it now fails at the database. SQLite has no regex;
  `GLOB` plus a length bound covers the two ways to get it wrong that matter.
- The fee triple is all-NULL or all-present, matching step 2's decision 9.

The cost is real: a CHECK cannot be altered in SQLite without rebuilding the
table, so adding an order state or a bot status later is a migration rather than
a code change. Accepted, because every one of these guards a value that is
either money or a risk control.

**8. `trades.bot_instance_id` is denormalized but cannot drift.**

Denormalizing normally means the copy can disagree with the original. A
composite foreign key on `trades (order_id, bot_instance_id)` referencing
`orders (id, bot_instance_id)` makes a trade that names a different bot than its
own order a rejected write. That required adding a redundant
`UNIQUE (id, bot_instance_id)` to `orders` — redundant because `id` is already
the primary key — since SQLite requires a UNIQUE constraint on the exact parent
column list.

I added the denormalized column first and the composite key second, after
noticing while writing the log that nothing tied the two together. It is the
kind of gap that would have produced a per-bot PnL figure quietly attributed to
the wrong bot.

**9. `ORDER BY` is emitted qualified, and that was a bug I wrote.**

The first version emitted `ORDER BY "price"`. SQLite resolves a bare identifier
in `ORDER BY` against the **output column aliases** before the table's columns.
Since the select list aliases every money column back to its own name
(`CAST("price" AS TEXT) AS "price"`), the sort bound to the TEXT result and went
lexicographic: `1000000000` sorted before `80000000`.

This is precisely the failure decimal.js was rejected for in step 2 — numeric
ordering lost — reintroduced by the fix for the *other* half of the same
problem. It was caught by a test asserting real ordering against real D1 with
values chosen so that string and numeric order disagree. A mocked database would
have passed it, and it would have surfaced as a grid ladder processed in the
wrong order.

Now emitted as `ORDER BY "orders"."price"`. `WHERE` is unaffected — SQLite does
not resolve aliases there — and there is a test for that too.

**10. `capital_ledger` deliberately has no `total_allocated <= total_balance`
check.**

A balance can legitimately fall below what is already allocated: a losing
position, or funds moved manually on the exchange. An over-allocated account is
a real state section 9 reconciliation must be able to record and alert on, not
one the database should refuse to represent. The check that matters guards
*new* allocations and belongs in step 5, where it can raise a useful error.

**11. Routine, for completeness.** The `Repository` filter/order/limit builder,
the eight table specs, the fixture builders and the barrel file are ordinary
implementation with no decision behind them worth recording. The schema-drift
test (`schema.test.ts`, comparing each spec against `PRAGMA table_info` on the
live database) is the only part of that group with a real rationale: the
migration and `schema.ts` describe the same thing twice, and nothing but that
test keeps them honest.

### Deviations from the spec

- **Section 8.2's column list is missing eleven columns** that later steps need.
  All eleven listed above, all confirmed before writing.
- **`capital_ledger` is not a ledger.** Section 8.5's wording ("update
  `total_allocated` when bots are created, closed, or resized") describes one
  mutable row per account, not an append-only entry log. Kept as specified, with
  `UNIQUE (account_label, asset)` so the row is addressable; allocation history
  lives in `audit_log`. The name is misleading and was kept anyway, because
  renaming a table mid-build is worse than a misleading name.
- **`balance_snapshots.classification` is nullable and section 9 has no word for
  what NULL means.** Section 9 names three drift classes and no clean-run case.
  Nullable rather than inventing a fourth value. Step 7 owns this; see open
  question 3.
- **`alerts.severity` values (`info`/`warning`/`critical`) were chosen by me.**
  The spec never enumerates them. Section 17 refers to "critical alerts", which
  is the only anchor.
- **No Cloudflare resources exist.** Section 16 requires separate D1 databases
  per environment. The separation is real in the config's shape but there is
  still nothing behind it. Same status as step 1's decision 1, now with an exact
  runbook attached.
- **`ProvidedEnv` does not exist in `@cloudflare/vitest-pool-workers` 0.18.6.**
  Step 1 added a `declare module "cloudflare:test" { interface ProvidedEnv
  extends Env {} }` block to `vitest-env.d.ts`, following Cloudflare's docs. It
  compiled and did nothing: in this version `env` is typed as `Cloudflare.Env`
  directly, and nothing named `ProvidedEnv` is exported. Rewritten to augment
  the `Cloudflare.Env` namespace, deliberately not the global `Env`, so the test
  bindings stay invisible to the Worker's own handler. This is the third time
  the published docs have described an API this version does not have
  (`defineWorkersConfig`, `fetchMock`, now `ProvidedEnv`) — worth assuming, at
  this point, that any pool API taken from the docs needs checking against
  `dist/` before use.
- **`readD1Migrations` is exported from the package root**, not the documented
  `@cloudflare/vitest-pool-workers/config` subpath, which does not exist in the
  exports map. Same class of problem as step 1's `defineWorkersConfig` finding.
- **D1 blocks some SQLite introspection.** `sqlite_version()` and the
  `pragma_*` table-valued functions both return `SQLITE_AUTH`. `PRAGMA
  table_info`, `index_list`, `index_info` and `foreign_key_list` all work as
  ordinary statements, which is enough for the drift test; it just cannot join
  them in one query.

### Open questions carried forward

Still open from earlier steps: coverage measurement is unresolved (2.6, and now
more pressing since this session added six test files whose coverage nobody can
measure); `realizedPnl` and `roundToStep` module placement (2.7); no integration
test exercises two modules together (2.8, still true — the D1 layer is tested
against itself and the money module, not against the order state machine); the
client reports rate-limit weight but does not gate on it (3.2); `Retry-After` is
parsed but unused (3.3); a `tradeId` of `-1` would break fill deduplication
(3.4, and now also collides with `trades.exchange_trade_id`'s UNIQUE
constraint); `recvWindow` and the clock bias are untested against real latency
(3.5); nothing verifies the API key lacks withdrawal permission (3.6); and the
`state` of a cancelled partial fill comes from the exchange rather than the fill
maths (3.1.1).

Resolved from step 2: open question 5, the D1 layer enforcing CAST-on-read
centrally, is what this session built. Step 2's open question 4 (bot instance
ids must be short slugs) is now enforced by the schema rather than only
documented, though step 6 still has to honour it when minting them.

New:

1. **Nothing writes to these tables yet, so none of the schema has met real
   data.** Every constraint here is reasoned from the spec and tested against
   values I chose. Step 6 is the first time a Durable Object mirrors real state
   into D1, and that is when a CHECK constraint being slightly too strict will
   show up — as a rejected write in a path that was mid-trade at the time.
2. **`bot_instances` mirrors Durable Object state, and nothing defines when.**
   Section 8.2 calls this data "mirrored from Durable Object storage" and says
   nothing about whether the mirror is written in the same operation as the
   authoritative state, or asynchronously, or reconciled. The two can therefore
   disagree, and section 9's reconciliation compares the exchange against "what
   each relevant Durable Object **and D1** believe is true" — three sources, not
   two. Worth settling before step 6 rather than during it.
3. **`balance_snapshots.classification` semantics on a clean run.** NULL was
   chosen over inventing a `'none'` value. Step 7 should confirm that, or add
   the value, before the first row is written.
4. **The `DB` binding is declared in two places** until the real database
   exists: `vitest.config.ts` for tests and, eventually, `wrangler.jsonc` for
   deploys. `docs/d1-provisioning.md` step 5 says exactly what to delete.
5. **`orders` has no `cumulative_quote_quantity`.** Step 3 found it is the only
   route to an average fill price for an order read back from the status
   endpoints, since those never return a fills array. `trades` covers this for
   any fill this system recorded itself; it does not cover an order
   reconciliation discovers after the fact. Not added, because nothing needs it
   before step 7, and it is cheap to add while the tables are still empty —
   which will stop being true.
6. **`audit_log.details_json` and `strategy_params_json` are typed `unknown`.**
   Deliberate: the shapes are step 5's and step 6's to define, and typing them
   as a guess now would let a stored row claim a shape nothing validated. They
   should be narrowed when those steps define the shapes, not left as `unknown`
   permanently.

---

## Step 4.1: D1 databases provisioned
Date: 2026-07-22

Completes step 4. Not a build-order step of its own — step 4 deliberately
stopped short of creating real Cloudflare resources, and this is that one
remaining action, plus two facts about ownership that turned out to matter more
than the provisioning did.

### What was done

Both databases created in the Cloudflare account `Vidya`
(`991af2ea1a58d7a2bb148f7269f635b9`), region `WNAM`:

| Environment | Database | `database_id` | Schema |
| --- | --- | --- | --- |
| testnet | `trading-bot-testnet` | `3f01f245-12b3-4b20-acf7-75b655da2bd7` | applied |
| production | `trading-bot-production` | `4038bdd3-9715-4366-a6b4-d3b007df6258` | **none, deliberately** |

Both `d1_databases` blocks added to `wrangler.jsonc` under their own
environments, binding `DB` in each. Migration `0001_initial_schema.sql` applied
to testnet, local first then remote: 26 commands, 8 tables, 17 indexes, all 8
tables confirmed `STRICT` on the real database.

Production is created and bound and contains no schema at all — only D1's
internal `_cf_KV`. That is a safety property, not an oversight: nothing can
write real trading data there, whatever else goes wrong, until someone
deliberately runs the migration.

Both cleanup edits made, so the `DB` binding is declared once. 591 tests still
passing, typecheck clean.

### Decisions made

**1. The Cloudflare account is the builder's own, not a delegated one.**

The originally planned account (a family member's) turned out to already be in
use for other purposes, so this project is hosted on the builder's own
Cloudflare account, authenticated with `wrangler login` (OAuth) rather than a
scoped API token.

Spec section 18 prefers a scoped token specifically because it is revocable
independently of the main login — an argument about *delegated* access. With the
account being the builder's own there is currently nobody to revoke it from, so
the preference does not apply as written. Recorded rather than silently skipped,
because the moment anyone else needs access this reverts to being the right
answer.

*Note this does not resolve the question below; it makes it sharper.* Owning the
infrastructure account is now decoupled from owning the money, and those two
things being the same person was an unstated assumption running through sections
11.2 and 18.

**2. Whose exchange account and funds will be used in production is undecided.**

It may be the builder's own Binance India account, or a family member's.
Undecided as of this entry, and nothing in the system depends on it yet —
exchange API keys are not needed until the testnet-to-production transition
(section 18), so this can stay open through steps 5 to 13 without blocking
anything.

**3. Authority over production follows the money, not the infrastructure.**

The principle, to be settled explicitly before production is used:

> Whoever's real capital is actually at risk in production holds final authority
> over that environment's Cloudflare Access allow-list (section 11.3) and the
> global kill switch (section 7.4) — not whoever happens to own the Cloudflare
> account hosting the infrastructure.

Section 11.2 already says the account owner has final say over the production
allow-list, and that the builder should not assume their own email belongs on
it. What section 11.2 does not anticipate is the two roles coming apart. It uses
"the account owner" for both the Cloudflare account holder and the person whose
funds are at risk, because it was written assuming one person. Decision 1 has
made that assumption false for the Cloudflare half, and decision 2 leaves the
exchange half open.

The resolution is that "account owner" in sections 11.2, 11.3 and 18 should be
read as **the person whose funds are at risk**, in every case where the two
readings differ. Holding the Cloudflare credentials is an implementation detail;
being the one who loses money is not.

*Deciding it the other way — infrastructure owner holds authority — rejected.*
It would mean whoever set up the hosting can add themselves to the production
allow-list and trade someone else's capital. Technically true today regardless,
since the Cloudflare account holder can change any Access policy. That is
exactly why it has to be an explicit agreement rather than a technical control:
the technical control does not exist and cannot be built at this layer.

*Revisit if:* the exchange account decision (2) lands on the builder's own
account, in which case the two roles recombine and this becomes moot — but it
should be recorded as settled here even then, not left implied.

### Deviations from the spec

- **Section 18's scoped API token was not used** (decision 1). OAuth via
  `wrangler login`, on the builder's own account.
- **Section 17's go-live checklist was amended.** A ninth item was added, per
  decision 3 — see below. This is the first time this project has edited
  `planning/spec.md` rather than recording a deviation against it; flagged here
  because it changes the source of truth rather than annotating it.
- **`_cf_KV`, not `_cf_METADATA`.** The runbook guessed the name of D1's own
  internal table. Corrected against real output.
- **The step 4 entry said 18 indexes; there are 17.** Corrected in place. Miscount
  when writing the entry, not a change to the migration — the local test suite
  had reported 17 all along.

### Go-live checklist amendment

Added to spec section 17, and repeated here because a checklist item that lives
only in a spec file nobody re-reads at 2am is not a control:

> - Ownership and authority explicitly settled and recorded in the decision log:
>   whose exchange account and funds are being used, and confirmation that that
>   person — not the Cloudflare account holder, if they differ — holds final
>   authority over the production Access allow-list and the global kill switch.

The checklist's own preamble says these must be "explicitly satisfied, not
assumed", and this is the item most likely to be assumed, because it is the only
one that is a conversation between people rather than an observation about the
system. It cannot be satisfied by anything the code does.

### Open questions carried forward

All of step 4's open questions stand. Question 4 (the `DB` binding declared in
two places) is resolved here.

New:

1. **Whose exchange account and funds** (decision 2). Not blocking until the
   testnet-to-production transition, but it gates the go-live checklist item
   above, and therefore gates production entirely.
2. **The production allow-list still has no names on it**, and now cannot until
   question 1 is answered, since decision 3 makes the answer determine who
   decides. This was step 1's open question 5, still open, and now with a
   prerequisite in front of it.
3. **Nothing enforces the empty production database.** It is empty because
   nobody ran one command. A deploy pipeline that runs migrations automatically
   would fill it without anyone deciding to; if CI ever grows a migration step
   at step 13, it must be testnet-only.
4. **Backups.** D1 captures a backup on `migrations apply`, per wrangler's own
   output, but nothing in the spec or this project defines a backup or restore
   posture for real trading data under section 8.7's retain-everything rule.
   Worth deciding before production, separately from go-live.

---

## Step 5: Capital ledger and bot-creation validation
Date: 2026-07-22

### What was built

`/src/capital/`: `ledger.ts` (the section 8.5 availability check, the
compare-and-swap loop, and create/close/resize), `placeholder-balance.ts`
(seeding `total_balance` by hand until reconciliation exists), `index.ts`, and a
folder README.

`migrations/0002_bot_instances_capital_asset.sql`: one column and one index.
Step 5 could not work without it — see decision 1.

72 new tests across three files (663 in total across the project), all passing,
typecheck clean. All against real D1 in the Workers runtime.

`docs/d1-provisioning.md` gained section 3.1: migration 0002 has **not** been
applied to the remote testnet database. That is a deliberate omission, not an
oversight — see deviations. *(Since superseded: 0002 was applied manually
outside a session and nothing recorded it at the time, so section 3.1 went on
claiming otherwise until 2026-07-22. All three migrations are now applied and
confirmed. See that section's "Why this section was wrong" note.)*

### Two decisions taken as settled going in

The session brief described these as already settled in this log. They were
not — neither appears anywhere before this entry, and the second is recorded at
step 4 as an *open question* (step 4's open question 2), not an answer. They are
recorded here as decided, and the discrepancy is noted because a decision that
everyone believes is written down and is not is worse than one nobody has made.

**A. Conditional `UPDATE ... WHERE total_allocated = <observed>`, retry on
conflict — not a Durable Object.** A DO would serialise allocation properly.
There is no Durable Object anywhere in this codebase until step 6, and making
the validation layer that step 6 calls into depend on the project's first DO is
backwards. Revisit if contention ever becomes real, which at one human creating
bots it is not.

**B. The D1 mirror is written by the same pipeline that processes the underlying
event**, not by a separate sync process. This is what makes
`createBotInstanceWithCapital` write the `bot_instances` row itself rather than
leaving it to a later reconcile. It also resolves step 4's open question 2, at
least for creation, closure and resize; it says nothing yet about mid-trade
state, which is step 6's version of the same question.

### Decisions made

**1. `bot_instances` gained a `capital_asset` column (migration 0002).**

`capital_ledger` is keyed by `(account_label, asset)` — the UNIQUE constraint
step 4 added specifically so this step could address a row. But `bot_instances`
recorded only `account_label`. A close or a resize therefore had no way to find
the ledger row whose capital the bot was holding.

The alternative was to make every caller re-supply the asset on close and
resize. Rejected: passing a different asset than creation used would move
capital between ledger rows, silently, and nothing would ever detect it. The
funding asset is a fact about the allocation, so it is stored as one.

*Deriving it from `pair` — rejected.* The quote asset of `BTCUSDT` is USDT and
of `BTCUSDC` is USDC; reading it off the symbol string means reimplementing
Binance's symbol table in SQL, and being wrong there means releasing capital
into the wrong ledger row.

A second migration rather than an edit to 0001, because 0001 has already been
applied to the real testnet database and `applyD1Migrations` records what it has
run — an edited 0001 would never re-run there. The column is last in `schema.ts`
because `ALTER TABLE ADD COLUMN` appends and `schema.test.ts` compares column
order against the live database.

**2. An allocation is a reservation, not a valuation.**

Closing a bot releases exactly the amount recorded in its `allocated_capital`,
whatever the position ended up being worth. A bot that lost 40% still frees its
full reservation. Profit and loss never touch `total_allocated`; they reach
`total_balance`, which reconciliation writes at step 7.

*Releasing the position's realised value instead — rejected.* It would keep
`total_allocated` closer to reality between reconciliation runs, but it requires
this module to know P&L, which lives in a Durable Object that does not exist,
and a single mis-valued close would corrupt `total_allocated` permanently with
no way to notice. Under the reservation model the two numbers are independently
derivable, which is exactly what lets reconciliation compare them.

This is the model migration 0001 already assumed when it deliberately omitted
`CHECK (total_allocated <= total_balance)`. An over-allocated account is now a
recordable state that blocks new allocation and nothing else.

**3. `status = 'stopped'` is the marker that capital has been released, and the
mutual exclusion that stops a double release.**

`allocated_capital` has a `CHECK (> 0)` and so cannot be zeroed to mean
"returned". So the release flips the bot to `stopped` *first*, with a
conditional update on it not already being stopped, and inspects the changes
count. Of two concurrent closes only one changes a row, and only one reaches the
ledger. Verified with two real `Promise.all` closes: one succeeds, one raises
`bot_already_stopped`, and `total_allocated` falls by the reservation once.

*Trusting the caller to close once — rejected.* Section 5.1 already establishes
that queue messages get redelivered, and section 7.2's halt path can be
re-entered. "Called exactly once" is not a property this system has anywhere
else, so assuming it here would be assuming the one thing already known to be
false.

**4. Resize checks the delta, not the new size, and refuses to reach zero.**

The bot's current allocation is already inside `total_allocated`, so only the
increase has to fit in available balance. A resize to the current size succeeds
and writes nothing at all, including no audit entry — a redelivered message is
then harmless rather than a source of phantom history. A resize to zero or below
is refused with a message pointing at close instead, since releasing capital is
what that means and the schema forbids the row it would produce.

**5. Every partial failure over-reserves rather than under-reserves.**

D1 has no interactive transaction, only `batch`, and a batch cannot contain a
conditional update whose `changes` count decides what happens next. So each of
these operations is two or three statements with interruptible gaps, and the
ordering rule is: **grow the reservation before the bot row, shrink it after.**

Concretely: creation reserves, then writes the bot row and audit entry as one
batch. A resize up reserves, then updates the bot row. A resize down updates the
bot row, then releases. A close marks the bot stopped, then releases.

The worst outcome is therefore capital reserved for a bot that is not using it —
visible in `audit_log`, correctable by a human, and it fails *closed* in the
sense that it only ever refuses allocations. The outcome this prevents is the
same capital allocated to two bots, which is money actually lost. Where a
reservation is taken and the write that justified it then fails, it is released
again; if that release also fails, the error code is `reservation_leaked` and it
names the amount and account, because nothing automatic will fix it.

**6. `total_balance` is seeded by a human and says so in the data.**

`seedPlaceholderTotalBalance` refuses an automated actor (`system`, `ci`,
`cron`, `reconciliation`), demands a note saying where the number came from, and
writes `"placeholder": true, "source": "human"` into every `audit_log` entry.
The action is `capital.placeholder_balance_seeded`, deliberately not one of the
`capital.allocated` / `released` / `resized` family, so a dashboard filtering
for allocation history cannot pick it up as one.

The refusal of an automated actor is the load-bearing part. The failure this
guards against is not someone misreading a variable name in six months; it is
step 7 being built, pointed at this function because it already writes the right
column, and quietly inheriting a "balance" that is whatever someone last typed.

It never touches `total_allocated`, on either path, which is also why it needs
no compare-and-swap: a seed and an allocation write different columns, so an
allocation landing mid-seed keeps its reservation.

**7. Bot instance ids are validated in three places, on purpose.**

`BOT_INSTANCE_ID_PATTERN` in `/src/shared/idempotency.ts` remains the single
owner of `/^[a-z0-9][a-z0-9_-]{0,19}$/` — the id is embedded verbatim in every
`clientOrderId`, so it is that module's 36-character budget being spent.
`assertBotInstanceId` here is the first check, before any round trip and before
any capital is reserved, and raises a `CapitalError` naming the rule rather than
a `SQLITE_CONSTRAINT` string. The migration's GLOB check is the last.

`CapitalError` rather than reusing `IdempotencyError`: the project already gives
each module its own error type with its own codes (`DatabaseError`,
`MoneyError`, `IdempotencyError`), and a caller catching a capital failure
should not have to know that the id rule is owned by the idempotency module.

**8. `audit_log.details_json` now has a defined shape for capital changes.**

`AllocationAuditDetails` carries the action, account, asset, signed delta,
before, after, the `total_balance` observed at the winning read, the resulting
available balance, and the number of compare-and-swap attempts. Money is written
with `toDecimalString`, which is readable in a dashboard *and* exactly parseable
back by `fromDecimalString`, so no precision is traded for legibility.

This partly answers step 4's open question 6. The `strategy_params_json` half is
still `unknown` and still step 6's.

The attempt count is in there because contention is otherwise invisible after
the fact: if allocations start routinely taking three attempts, that is the
signal that decision A's "no Durable Object" needs revisiting, and it should be
in the data before anyone has to ask.

### Deviations from the spec

- **Section 8.5 does not mention `asset`, `audit_log` entries, or any of the
  close/resize semantics in decisions 2 to 4.** It is three sentences. Everything
  beyond "check availability, block if it fails, update on create/close/resize"
  was decided here.
- **`bot_instances` gained a column not in section 8.2** (decision 1). The
  second such addition, after step 4's five.
- **`createBotInstanceWithCapital` writes the `bot_instances` row**, which
  section 8.2 describes as "mirrored from Durable Object storage" — a Durable
  Object that does not exist yet. Forced by `audit_log.target_bot_instance_id`
  being a foreign key: an audit entry for a creation is not writable until the
  bot row exists. Step 6 must call this to be born rather than writing that row
  itself, or there will be two writers for one row.
- **Migration 0002 was not applied to the remote testnet database.** Applying a
  migration to a real Cloudflare database is a deliberate act, not a side effect
  of a coding session. The repository is therefore one migration ahead of remote
  testnet until someone runs it; `docs/d1-provisioning.md` section 3.1 is the
  command. Nothing is broken meanwhile — nothing deploys yet, and the test suite
  builds its own local database from the migration files.
- **No Durable Object, no strategy logic, no dashboard form**, per the session's
  scope.

### On the test for concurrency

The brief asked for a test that simulates two near-simultaneous creation
attempts and confirms only one can succeed. That test exists, and so does
something less obvious that it needs: a test that the two attempts *actually
interleave*.

A `Promise.all` of two creations passes the "only one succeeds" assertion
whether or not the runtime interleaved them — if it ran them end to end, the
second would fail the availability check on its own, and the test would prove
nothing about concurrency while looking like it had. So the interleaving is
asserted directly, by recording the order of ledger reads and swaps: two reads
must land before the first swap commits. That assertion was checked by
temporarily making the two creations sequential and confirming it fails
(`['read', 'swap-won']` instead of `['read', 'read']`).

The retry logic itself is tested deterministically instead of by racing, by
committing a competing write between the read and the swap. That is the only way
to make a *lost* race reproducible — a real race is observable but not
schedulable — and it is what pins the behaviour that matters most: a retry
re-runs the availability check against the new value rather than reapplying a
stale decision.

### Open questions carried forward

Still open from earlier steps: coverage measurement (2.6); `realizedPnl` and
`roundToStep` module placement (2.7); the client reports rate-limit weight but
does not gate on it (3.2); `Retry-After` parsed but unused (3.3); a `tradeId` of
`-1` (3.4); `recvWindow` and clock bias untested against real latency (3.5);
nothing verifies the API key lacks withdrawal permission (3.6); the state of a
cancelled partial fill (3.1.1); no schema has met real data (4.1);
`balance_snapshots.classification` on a clean run (4.3); `orders` has no
`cumulative_quote_quantity` (4.5); whose exchange account and funds (4.1.1); the
production allow-list is empty (4.1.2); nothing enforces the empty production
database (4.1.3); backups (4.1.4).

Step 2's open question 8 (no integration test exercises two modules together) is
partly resolved: this step's tests exercise the capital module, the D1 layer and
the money module together against real D1. Nothing yet exercises the order state
machine against anything.

New:

1. **An audit entry can be lost on the capital-releasing paths.** A close and a
   downward resize end with the ledger swap, whose `changes` count has to be
   inspected and therefore cannot be batched with the audit insert. A crash in
   that gap leaves the allocation correct and the history missing a line. The
   growing paths do not have this problem, because their final write is a batch.
   Closing it properly needs either a conditional insert built inside `/src/db`
   or the allocation moving into a Durable Object where storage transactions are
   real. Neither is worth doing before step 6 decides whether the DO is coming.
2. **Nothing reconciles `sum(bot_instances.allocated_capital)` against
   `capital_ledger.total_allocated`.** They are maintained together by this
   module and can only diverge through the gaps in decision 5, but there is no
   check that they agree, and `release_exceeds_allocated` is the only place the
   divergence would ever surface — at which point a close is already failing.
   Step 7 should compare them; it is a cheap query and it is the only detector
   of a leaked reservation.
3. **`MAX_ALLOCATION_ATTEMPTS` is five with no backoff, and untested under real
   contention.** Five losses in a row against a single human creating bots means
   something is wrong that waiting would not fix, so no sleep was added. That
   reasoning stops holding the moment anything automated allocates capital.
4. **Nothing prevents a bot being created against an account/asset whose
   placeholder balance was never meant to authorise it.** The ledger row is the
   only authority on how much capital exists, and right now its value is
   whatever a human last typed. Until step 7, the capital ramp-up of section 7.6
   is enforced by nothing but that number being small.
5. **`releaseBotCapital` sets `status = 'stopped'` directly**, which is a status
   transition, and section 7.2's halt behaviour also owns status transitions.
   Step 6 needs to decide whether the Durable Object drives status and calls
   this, or this drives status and the DO follows. Two writers to one status
   column with no agreement between them is how a halted bot ends up marked
   stopped, or worse, a stopped bot marked running.

---

## Step 6: DCA BotInstance Durable Object
Date: 2026-07-22

### What was built

`/src/strategies/` (new): `dca.ts`, the whole of section 6.3 as pure functions,
plus `index.ts` and a folder README.

`/src/durable-objects/`: `bot-instance.ts` (the object), `attempt-store.ts` (the
real `AttemptStore`), `fake-exchange.ts` and `test-helpers.ts` (test-only,
neither exported from the barrel), `index.ts`, and a rewritten README.

`wrangler.jsonc` gained a `BOT_INSTANCE` binding and a `new_sqlite_classes`
migration under both environments. `src/workers/api.ts` re-exports the class,
because a Durable Object must be exported from the Worker named by `main`.
`src/db/database.ts` gained `databaseFrom`.

108 new tests across four files (771 in total across the project), all passing,
typecheck clean. Real D1 and real Durable Object storage in the Workers runtime;
the exchange is the only thing mocked.

This is the first code in the project where step 2, step 3, step 4 and step 5
all run together. Step 2's open question 8 -- "no integration test yet exercises
two modules together" -- is closed by `bot-instance.test.ts`.

### The two decisions taken as settled going in

Both were genuinely open in this log, and both are now answered. Recording that
they were open, because step 5's entry had to note the opposite situation.

**A. This object calls `createBotInstanceWithCapital` and never writes its own
`bot_instances` row.** Step 5's deviations already said "Step 6 must call this
to be born rather than writing that row itself, or there will be two writers for
one row." Confirmed and implemented.

**B. Status ownership splits by transition.** This closes step 5's open question
5, which asked exactly this and warned that "two writers to one status column
with no agreement between them is how a halted bot ends up marked stopped". The
split: this object owns `running` and `halted`; `stopped` is written only by
`releaseBotCapital`. `#mirrorStatus` carries the guarantee mechanically -- every
status write it makes is conditional on `status <> 'stopped'`, so the object
cannot write that value even by mistake, and cannot overwrite it either.

Step 4's open question 2 (nothing defines when the D1 mirror is written) is also
closed here for mid-trade state, which is the half step 5 left open: the mirror
is written by the same pipeline that processes the event.

### Three questions asked before writing anything

**1. Take-profit is a cycle completion, not a section 7.2 halt.** *(asked,
confirmed)*

Section 7.2's header lists take-profit among the halt triggers and says a halt
never auto-resumes. Section 6.3 step 6 says that after a take-profit exit the
bot may auto-restart a fresh cycle. Those cannot both be true, and the session
brief inherited the tension -- it put "optional auto-restart" after halt in the
same arrow chain.

Resolved as: 6.3 step 6 is the specific rule for DCA and 7.2's list is the
general one. `autoRestart` on begins a fresh cycle with status staying
`running`; `autoRestart` off halts with reason `take_profit_reached`. That keeps
7.2's "never auto-resume" true for every path that does not have 6.3 step 6's
explicit permission, rather than making it a rule with an undocumented hole.

Either way the capital reservation is untouched. *Releasing capital on a
completed cycle -- considered, rejected.* It would return capital to the ledger
with no human in the loop, and a bot that has finished a cycle profitably is the
last thing that should quietly close itself.

**2. Exhausting max buys is not its own halt trigger.** *(asked, confirmed)*

Section 6.3 step 5 halts when "maximum buys are exhausted and price continues
falling", and defines "continues falling" nowhere. The mandatory stop-loss,
measured from average entry, already is that threshold.

*A separate post-exhaustion threshold -- rejected.* It would mean two downside
thresholds where the spec funds one, and the second would have to be invented
from nothing. The bot now stops buying, keeps watching, and halts on the
stop-loss.

**3. `subscribeToPriceFeed` deferred to its own session.** *(asked, confirmed)*

Section 4.6 deferred it to this step. It is not built, and the reason is more
than session size: **the section 4.1 signature does not fit the Hibernation
API.** `subscribeToPriceFeed(pair, onUpdate)` returns a handle synchronously and
holds a callback closure. Hibernation requires `ctx.acceptWebSocket()` plus
`webSocketMessage` handlers on the class, precisely so the connection can
outlive the isolate -- and a callback closure cannot survive the object being
evicted. So building it means redesigning that signature, which is its own
design problem rather than a wiring job.

The object exposes `onPriceUpdate(price)` instead, which is what the feed will
call, and is also exactly what section 13's backtest mode needs.

### Decisions made

**1. Strategy logic lives in `/src/strategies`, pure, separate from the object.**

`decide()` takes a config, a position and a price, and returns an action. The
Durable Object carries it out.

Section 13 requires backtesting to run "the same strategy code ... without
duplication" against historical candles. That is only possible if the strategy
does not depend on the machinery that talks to an exchange. Putting the state
machine inside the object would have made the backtest either a second
implementation or a fake Durable Object.

This is a second new top-level folder, after step 3's `/src/exchange`, and the
same trade: step 1's decision 9 preferred not to invent folders, and a module
with a genuinely different dependency profile is worth one.

**2. The halt marks the bot halted BEFORE cancelling, inverting section 7.2's
listed order.**

Section 7.2 lists cancellation first and "mark the bot instance status as
halted" third. Implemented the other way round, and this is the most deliberate
deviation in the session.

The list's step 2 is "stop placing any new orders", and that is only in force
once the status says so *durably*. Cancelling first means a crash partway
through leaves a bot still marked `running` with some orders cancelled -- and
the next price update will happily add to it. Marking first means a crash leaves
a halted bot with orders still live: visible, alerted on, and safe, because
nothing will trade against them.

The cancellations are unchanged and still immediate; only the persistence
ordering moved. Read as implementing 7.2's intent rather than its sequence.

**3. A fill discovered at cancellation is alerted, never applied.** *(resolves
step 3.1's open question 1)*

Step 3.1 returned `OrderStatus` from `cancelOrder` specifically so the halt path
would know the filled quantity at the instant of cancellation, and its open
question asked to re-check that "when the halt path actually drives `closeOrder`
from this value". Doing so surfaced something step 3.1 did not anticipate.

When the exchange reports MORE filled at cancellation than this bot knew about
-- a resting order filling in the window before the cancel lands -- that
quantity cannot be folded into the position. A cancellation response carries no
fills array and therefore **no `tradeId`**, and `applyFill` deduplicates on
exactly that id. Synthesising one would mean that when the real fill later
arrives from the account trade list, it either double-counts or is silently
swallowed by the fake id.

So the position is left understating what the bot holds, both numbers go into a
`cancel_fill_discrepancy` alert, and section 9's reconciliation closes it. That
is not a workaround; reconciling the exchange against what the bot believes is
the job section 9 exists for. But it does mean **step 3.1's stated benefit is
only half-realised**: the number arrives, and it cannot be used where it
matters. The honest summary is that the filled quantity at cancellation is
usable for the ORDER record and not for the POSITION.

*Synthesising a fill id such as `cancel:{clientOrderId}` -- rejected*, for the
double-count above. *Following each cancel with a `getOrderStatus` -- rejected*:
it is what step 3.1 removed, and it would not help, since the status endpoints
also return no fills array.

**4. Durable Object storage keeps `bigint`; D1 does not. Two conventions, each
matched to what its storage can represent.**

Probed rather than assumed, following steps 2 and 4. `storage-probe.test.ts`
measures, in the real runtime:

| | Durable Object storage | D1 |
| --- | --- | --- |
| `bigint` write | stored as bigint | `.bind()` throws outright |
| read past 2^53 | exact | silently truncated |
| `get` after `put` | fresh structure | n/a |
| two `get`s of one key | two structures | n/a |

So DO state stores `Money` as the bigint it is, and the decimal-string encoding
is applied only at the D1 boundary. The probe was kept as a test rather than
deleted, unlike step 2's D1 probe, because `DurableObjectAttemptStore` is built
on these results and a runtime change should fail here rather than as a
corrupted idempotency record.

**5. The reference-leak bug from step 2 does not exist in the real store, and
that is now measured.**

Step 2's decision 12 fixed an `InMemoryAttemptStore` that copied on write but
not on read, and asserted that "the persisted implementation at step 6 will not
share references either". That was a reasonable expectation, not a fact, and DO
storage keeps an in-memory write cache in front of SQLite -- which is exactly
where a shared reference could have survived.

It does not. Storage returns a fresh structure from every `get`, both after a
`put` in the same context and across two reads. `DurableObjectAttemptStore`
therefore needs no defensive copying, and `attempt-store.test.ts` runs the same
mutation tests against it that caught the original bug.

**6. `AttemptStore.list()` is a full scan, so the sequence counter moved into
the object's state.**

The port returns every attempt, and both `highestSequence()` and
`unresolvedAttempts()` filter it in JavaScript. That is free for a `Map` and is
not free for storage that, under section 8.7's retain-everything rule, grows for
the life of the bot -- and `highestSequence()` would have sat on the
order-placing path.

`BotRuntimeState.nextSequence` is persisted with everything else, so the scan
happens only on the recovery path, where reading every unresolved attempt is the
actual point.

*Widening the port with narrower query methods -- rejected for now.* It would
have to be implemented by the in-memory store and by whatever backtesting uses,
for a problem the object can avoid entirely. Recorded as friction rather than
fixed; see open question 2.

**7. The sequence number is persisted BEFORE the attempt record.**

Both orderings lose something on a crash in the gap. Persisting the sequence
first burns a sequence number, which costs nothing. The reverse lets a crash
re-use a sequence whose attempt record already exists, at which point
`beginAttempt` answers `recover` for an order that was never placed -- a bot
stuck waiting to reconcile an order that does not exist.

**8. A definite refusal from the exchange halts; a transport failure does not.**

`placeOrder` returning `exchange_error` marks the attempt failed and halts with
`order_rejected`: a validly constructed order the exchange refused outright is
not something to retry into.

`transport` leaves the attempt `attempting`, returns `unresolved`, and halts
nothing. Section 5.6 and 5.1 together: the order may be resting on the book, and
it must be recovered by lookup, never re-sent. The sequence is spent either way,
so the next attempt uses a fresh id -- there is a test asserting the retry
places `v1-{id}-1` rather than re-sending `v1-{id}-0`.

**9. `strategy_params_json` is decimal strings, and that is forced, not
stylistic.** *(answers step 4's open question 6, strategy half)*

`JSON.stringify` throws on a `bigint`, so a `DcaParams` cannot be written to a
JSON column at all -- the D1 layer's codec would wrap it as `encode_failed`.
`encodeDcaParams` / `decodeDcaParams` are the gate, using `toDecimalString` to
match step 5's `AllocationAuditDetails`. `decodeDcaParams` validates rather than
casts, including the `strategy: "dca"` discriminator, because the column is
`unknown` by design and grid will write a different shape at step 9.

The column stays `unknown` in `schema.ts` for that reason.

**10. Order sizes are denominated in the quote asset, and a config must fund its
own ladder.**

Section 6.3 says "base order size" and never says in what. Quote, because
`allocated_capital` and the whole capital ledger are denominated that way, so a
size can be checked against the allocation directly; a size in base could not
be, without a price that does not exist at configuration time.

The check itself is new: section 6.1 checks the requested allocation against the
account's free balance, and **nothing anywhere checked that a bot's own
parameters fit inside its own allocation.** Without it, a bot allocated 100 with
five 50-unit buys configured is created happily and fails at the exchange on its
third buy, mid-cycle, with a position open -- which section 7.5 turns into a
halt. `validateDcaParams` refuses it at creation, before any capital is
reserved.

`plannedTotalSpend` sums exactly the values `additionalOrderSizeFor` returns,
rather than recomputing the compounding, so the check and the run-time request
cannot disagree by a rounding step.

**11. `orders.id` is the `clientOrderId`, and `trades.id` is
`{clientOrderId}:{fillId}`.**

Deterministic on purpose. These rows are written from a pipeline section 5.1
says can be redelivered, and a generated id would insert a second row on a
replay. With deterministic ids the replay collides with the PRIMARY KEY, which
is the same protection `client_order_id UNIQUE` and
`UNIQUE (order_id, exchange_trade_id)` already give, extended to the identity
column.

**12. Fee conversion uses the fill itself as the rate source, or writes
nothing.**

Fee in the quote asset: no rate needed. Fee in the base asset: the fill's own
price. Anything else -- a fee in the exchange's own token, which is the common
third case -- has no rate available in this object, and step 2's decision 9
applies: all three reporting columns are NULL rather than guessed. Migration
0001's `fee_conversion_all_or_nothing` CHECK enforces the triple.

This is a real gap, not a complete implementation of section 5.5. See open
question 3.

**13. There is no default exchange client, and the object refuses to trade
without one.**

`attach()` defaults the database from the environment and deliberately does not
default the exchange. Building a Binance client needs live API credentials, and
step 4.1's decision 2 recorded that whose exchange account will be used is still
undecided. A default would be a client constructed against credentials that do
not exist, failing at the first signed request with an authentication error that
says nothing about the real cause.

**14. `sellOnStopLoss` exists in the config and is REJECTED if set to true.**

Section 6.3 step 5 requires that any auto-sell at a loss be "an explicit,
configured behavior the account owner has chosen", so the option belongs in the
model. The selling half is not built.

A field that reads as a risk control and silently does nothing is worse than an
absent field: someone sets it and believes the position will be closed. So
`validateDcaParams` refuses `true` with a message saying why. This was caught
while writing this entry, not while writing the code -- the field had been
sitting there accepted and inert.

**15. `databaseFrom(env)` was added to `/src/db`.**

Step 4's `no-raw-d1.test.ts` fails the build on any `env.DB` outside `/src/db`,
and its message says "construct a `Database` once and pass that" -- which needs
one sanctioned place to do the constructing. The guard did its job here: the
first version of the object reached for `this.env.DB` directly and the test
caught it.

**16. Routine, for completeness.** The `PipelineResult` shape, the storage key
prefixes, the barrel files and the READMEs are ordinary implementation with no
decision behind them worth recording. `FakeExchange` implements the interface
rather than being a loose object of `vi.fn()`s, which is the one part of the
test scaffolding with a reason: when step 3.1 changed `cancelOrder` from `void`
to `ExchangeOutcome<OrderStatus>`, a structural mock would have kept compiling
against the old shape.

### Integration friction found between existing modules

The session brief asked for this explicitly. Six, in rough order of how much
they matter.

1. **`cancelOrder`'s filled quantity cannot reach the position** (decision 3).
   The most consequential. Step 3.1's whole argument for returning `OrderStatus`
   was that the filled quantity at cancellation "is the number that says what
   the bot still owns" -- and the missing `tradeId` means it cannot be applied
   there. It reaches the order record and stops.

2. **`AttemptStore.list()` does not survive contact with persistent storage**
   (decision 6). The port was designed against a `Map`. Worked around in the
   object rather than in the port.

3. **`JSON.stringify` cannot serialize the money types the whole codebase uses**
   (decision 9). Every module produces `bigint`; the one JSON column in the
   schema cannot hold one. Nothing had hit this before because nothing had
   written a strategy's own parameters.

4. **`RateLookup` is synchronous and pure, and the rate is not available**
   (decision 12). `fees.ts` was deliberately built so converting a fee performs
   no I/O, with rates "gathered in advance". Nothing gathers them. For a fee in
   a third asset the object would have to fetch a price mid-fill, which the
   interface correctly refuses to let it do -- so it writes NULL.

5. **`ExchangeOutcome`'s failure carries `message`, not `reason`.** Trivial, and
   noted only because the first draft of the object used `reason` throughout and
   compiled fine everywhere the value was interpolated into a template string.
   Caught by typecheck, not by tests.

6. **`BotInstance extends DurableObject<Env>` does not satisfy
   `runInDurableObject`'s constraint**, which is typed against `Cloudflare.Env`.
   That is a consequence of step 4's deliberate choice to augment the
   `Cloudflare.Env` namespace rather than the global `Env`, so test-only
   bindings stay invisible while typechecking Worker source. The property is
   worth keeping; the cast is isolated in `inBot`.

None of these were "fixed" by quietly changing an existing module. The only
edits outside the new folders were adding `databaseFrom` and one error code to
`/src/db`, and re-exporting the class from `api.ts`.

### Deviations from the spec

- **Section 7.2's step order is inverted** (decision 2). Halted is marked before
  orders are cancelled.
- **Section 7.2 lists take-profit as a halt trigger; section 6.3 step 6 lets it
  auto-restart.** Resolved in favour of 6.3 step 6 for DCA (question 1). This is
  a genuine contradiction in the spec, not an ambiguity, and the spec has not
  been edited to record it -- only this log.
- **Section 6.3 step 5's "maximum buys are exhausted and price continues
  falling" is not implemented as a distinct trigger** (question 2).
- **Section 6.3 step 5's configurable auto-sell is refused, not implemented**
  (decision 14).
- **Section 4.1's `subscribeToPriceFeed` is still not built** (question 3). The
  interface split from step 3's decision 2 held up well: the object depends on
  `RestExchangeClient`, so the gap is visible at compile time rather than as a
  method that throws.
- **Section 5.4's rate limiter still does not gate anything.** `WeightBudget`
  exists and the client reports into it; nothing asks permission. A halt that
  cancels many orders issues them unthrottled, which is the worst moment for it.
  This was step 3's open question 2 and was expected to close at step 6; it did
  not, because the RateLimiter object was out of scope.
- **Section 10's outbound notification does not exist.** Alerts are written to
  D1 on every path that section 7.2 requires, and nothing sends a Discord or
  Telegram message. That is step 8, and until then a halt is silent unless
  someone looks.
- **Section 9's reconciliation is relied on by three paths here** (the
  cancellation discrepancy, an unknown-order fill, and an order-state drift
  halt) **and does not exist yet.** Those alerts currently go into a table
  nobody reads automatically.
- **Section 8.1's "order history" is stored twice**, once in the object and once
  in D1. That is what "mirrored" means, but worth stating: the object's copy is
  authoritative and the D1 copy is what every other component reads.
- **No live network call anywhere in the suite**, per section 14. Binance's
  testnet remains a separate manual step.

### Open questions carried forward

Still open from earlier steps: coverage measurement (2.6); `realizedPnl` and
`roundToStep` module placement (2.7); the client reports rate-limit weight but
does not gate on it (3.2); `Retry-After` parsed but unused (3.3); a `tradeId` of
`-1` (3.4); `recvWindow` and clock bias untested against real latency (3.5);
nothing verifies the API key lacks withdrawal permission (3.6);
`balance_snapshots.classification` on a clean run (4.3); `orders` has no
`cumulative_quote_quantity` (4.5); whose exchange account and funds (4.1.1); the
production allow-list is empty (4.1.2); nothing enforces the empty production
database (4.1.3); backups (4.1.4); an audit entry can be lost on the
capital-releasing paths (5.1); nothing reconciles
`sum(allocated_capital)` against `total_allocated` (5.2);
`MAX_ALLOCATION_ATTEMPTS` untested under real contention (5.3); nothing prevents
a bot created against an unauthorised placeholder balance (5.4).

Resolved: step 2's open question 8 (no integration test across modules) -- this
step's tests drive four modules together. Step 3.1's open question 1 (the state
of a cancelled partial fill) -- re-checked as it asked, and the answer is
decision 3, which is less useful than step 3.1 hoped. Step 4's open question 1
(no schema had met real data) -- it has now, and no CHECK constraint turned out
to be too strict; the one that fired during development was
`alerts.id`'s PRIMARY KEY, from a test that supplied a constant id generator.
Step 4's open question 6 is half-resolved: `strategy_params_json` has a defined
shape for DCA (decision 9); `audit_log.details_json` gained four more actions
here but is still typed `unknown`. Step 5's open question 5 (status ownership)
-- settled, see B above.

New:

1. **The position understates what the bot holds after a halt that raced a
   fill** (decision 3). Nothing closes the gap until section 9 exists. A halted
   bot is not trading, so the exposure is bounded, but a human closing that bot
   manually will see a smaller position than the exchange does.
2. **`AttemptStore` has one implementation that scans and one that cannot avoid
   scanning** (decision 6). The port should probably grow a
   `listUnresolved()` and a `highestSequence()` before a third implementation
   exists. Cheap now, three call sites later.
3. **Fees in a third asset are never converted** (decision 12), so realized PnL
   is incomplete for any account paying fees in the exchange's own token --
   which is the default for most Binance accounts, and is exactly the case
   section 5.5 says never to assume away. Needs a rate source gathered before
   the fill is processed, which is a shape `fees.ts` already anticipates and
   nothing supplies.
4. **`sellOnStopLoss` is refused rather than implemented** (decision 14).
   Section 6.3 step 5 offers it; a bot cannot currently be configured to close a
   losing position automatically.
5. **Nothing drives `onPriceUpdate` yet.** The state machine is complete and has
   no input in production: the WebSocket feed is deferred, and no cron or queue
   calls it either. The object is fully built and, deployed today, would sit
   idle.
6. **`create()` can leave a bot row with no Durable Object state.** Capital is
   reserved and the row written before this object's storage is written (per
   step 5's ordering rule), so a crash in that gap leaves a `created` bot whose
   object is empty -- and a retry of `create` fails with
   `duplicate_bot_instance` rather than completing it. Over-reserved and safe,
   which is the right direction, but the recovery is manual and undocumented.
7. **A halt cancels orders one at a time, sequentially.** For DCA that is at
   most one open order, so it does not matter. For step 9's grid, a halt cancels
   a full ladder, and doing that serially with no rate-limit budget is the exact
   scenario step 2's decision 10 reserved budget for.
8. **Nothing tests two concurrent events on one object.** Durable Objects
   serialize by default, so the interleavings step 5 had to test for do not
   arise here -- but that is an assumption about the runtime this session did not
   probe, unlike the storage questions it did.

## Step 7: Reconciliation Cron Worker
Date: 2026-07-22

### What was built

`/src/reconciliation/` (new): `findings.ts` (section 9's three tiers, pure),
`circuit-breaker.ts` (section 7.3's control, built rather than described),
`reconcile.ts` (one pass over one account), plus `index.ts` and a folder README.

`src/workers/reconciliation.ts`: the `scheduled` handler, wired into
`api.ts`'s default export. `wrangler.jsonc` gained `triggers.crons` under both
environments.

`migrations/0003_circuit_breakers.sql`: one table, one partial index. The
ninth table, and the third not in section 8.2.

Edits outside the new folder, all small and all listed here so none is
invisible: `src/db/schema.ts`, `database.ts` and `test-helpers.ts` learned the
new table; `bot-instance.ts` gained `snapshotIfCreated()` and two
`assertAccountArmed` calls; `fake-exchange.ts` gained the two surfaces
reconciliation reads; `schema.test.ts`'s two whole-schema expectations were
updated.

81 new tests across three files (852 in total across the project), all passing,
typecheck clean. Real D1 and, in three tests, a real Durable Object; the
exchange is the only thing mocked, per section 14.

### Four questions asked before writing anything

Section 9 is six lines and every one of them turned out to be underspecified in
a way that changes what gets built. All four were put to the account owner and
all four confirmed the recommended reading.

**1. What "what D1 believes" means for a BALANCE.** *(asked, confirmed)*

Nothing in this system maintained an internal balance. `capital_ledger.total_balance`
was whatever a human typed into `seedPlaceholderTotalBalance`, and step 5's own
header says total_balance is "reconciliation's to write". Comparing the exchange
against that placeholder reports a large discrepancy on every run that is not
drift — it is the placeholder being a guess.

Resolved as a DELTA between runs: `internal_calculated_balance` is the previous
run's exchange balance plus this system's own recorded activity since, and
`discrepancy` is what remains after subtracting unreconciled manual
adjustments. That is the unexplained part of the change, and it is also what
migration 0001's own comment already assumed when it said `discrepancy` "is NOT
a plain difference of these two columns".

*Comparing against `capital_ledger.total_balance` — rejected.* The literal
reading of section 8.2, and it makes run one of every account a large false
positive that repeats forever until someone re-seeds by hand.

*Rebuilding the balance from `trades` — rejected.* Self-contained and needs no
baseline, but it can only describe assets this system traded. It is structurally
blind to a deposit, a withdrawal, or a pre-existing balance — which is exactly
the "unexplained balance change" the severe tier exists to catch.

The first run for an (account, asset) has no baseline and ADOPTS the exchange's
balance, classifying `minor` and raising nothing. There is no honest
alternative: with no prior observation there is no change to explain.

**2. How the three tiers are decided.** *(asked, confirmed)*

Section 9 describes them qualitatively and supplies no thresholds. Resolved as:
the KIND of finding sets a floor, magnitude may escalate above it, and magnitude
may never lower it.

*Pure magnitude — rejected.* One numeric ladder makes a small unexpected order
"minor", and section 9 lists unexpected orders under severe alongside suspected
key compromise. Something else trading the account is the same event whatever
the size.

*Pure kind — rejected.* Fully deterministic, but then a rounding difference and
a 20% unexplained balance drop classify identically.

**3. How much of the circuit breaker to build.** *(asked, confirmed)*

The mechanism plus section 9's trigger. Section 7.3's daily-loss trigger is
not built — see decision 2.

**4. Whether auto-correct may write Durable Object state.** *(asked, confirmed)*

No. D1 mirror only. See decision 3.

### Decisions made

**1. The account-wide circuit breaker is REAL, and that is the main thing this
session added beyond section 9 itself.**

Before this, section 7.3 was a paragraph. Section 9's severe tier says "trigger
the account-wide circuit breaker, halt everything on that account, alert
immediately", so implementing that tier as anything other than a comment
required building the control first.

`circuit_breakers` is one mutable row per account, like `capital_ledger`. While
tripped: no bot on the account can be created, no halted bot can be resumed, and
every run keeps sweeping for anything still active. Only
`resetAccountCircuitBreaker` clears it, and it refuses `system`, `ci`, `cron`
and `reconciliation` — importing step 5's `NON_HUMAN_ACTORS` rather than
re-declaring the list, so the two cannot drift.

*Halting the bots that exist at the moment of the trip, without a latch —
rejected.* That is a broadcast, not a breaker. The next bot created on the
account would start trading straight into whatever caused it.

*KV rather than D1 — rejected.* KV is eventually consistent, and a
create-blocking check that can read a stale "armed" seconds after a trip has a
hole in it. Section 8.3 gives KV alert cooldowns, where staleness costs a
duplicate ping; here it would cost a bot trading on an account under suspected
key compromise.

*A Durable Object — rejected*, following step 5's decision A. A DO would
serialise trips properly, but trips come from one cron per account and the write
is idempotent, so there is no contention to serialise.

The latch is written BEFORE any bot is halted, inverting the obvious order for
the same reason step 6's decision 2 did: a crash partway through then leaves an
account latched with some bots still running, which the next sweep fixes. The
reverse leaves bots halted on an account that still accepts new ones.

**2. Section 7.3's daily-loss trigger is NOT built, and this is a real gap.**

Section 7.3 defines the breaker by one trigger: total realized and unrealized
loss across all bots on the account for the current day. Section 9 adds a
second: severe drift. They share one mechanism.

Only the mechanism and section 9's trigger exist. Unrealized loss needs a live
price for every open position, which means an exchange call per pair on a
schedule, plus a decision about what "for the current day" means across
timezones. Bolting a half-considered version of that onto this file would have
produced a risk control nobody had thought about properly.

`tripAccountCircuitBreaker` takes the reason as a string and has no opinion
about which trigger produced it, so wiring the second one is a caller change.
**Stated plainly: an account can currently lose money faster than any per-bot
stop-loss catches, and nothing account-wide will stop it.** That is section 7.3
unimplemented, not section 9 unimplemented, but it is the same paragraph.

**3. Auto-correct touches the D1 mirror and nothing else — and that changes
which findings can be minor.**

Section 8.1 makes each Durable Object the source of truth and section 8.2 calls
D1 "mirrored from" it. A cron writing a running bot's position would be a second
writer to that number, from outside the object that serialises access to it,
using a read already stale by the time the write lands.

The consequence is not just a restriction, and it is the more interesting half:
a finding is only ever raised as `minor` for something this job can actually
fix. Where the mirror is wrong in a way it cannot repair — an order in the
object with no `orders` row at all, which would need a fabricated
`exchange_order_id` — the finding is raised as `order_state_drift` instead.
Section 9 defines minor by its ACTION ("auto-correct, log, no alert"), so a
minor finding nobody can correct would be silent by construction.

*Adding a `BotInstance.applyReconciliation` — rejected.* It would close step 6's
decision 3 gap, where a fill discovered at cancellation cannot reach the
position. It also introduces a second writer to the source of truth, from a
cron, racing live price updates. Step 6 open question 1 stays open.

**4. `TIER_CEILING` — a bug the tests caught, and the most substantive thing I
got wrong this session.**

The first version of `classifyFinding` let any finding escalate to severe past
`severePct`. Five tests failed, all reporting `severe` where a lower tier was
expected, and the reason was the same each time: for an ORDER-level finding the
only denominator available is that order's own quantity.

A resting order that half-filled without the bot hearing is a 50% divergence of
that order. A D1 mirror lagging by a whole order is 100%. A fill recorded late —
section 9's own named example of MINOR drift — is usually the entire order. So
every ordinary event escalated to severe and tripped the account-wide breaker,
and `meaningful` had become unreachable in practice. The three-tier scheme had
silently collapsed into one.

The underlying error was treating one ratio as comparable across kinds when the
denominators are different things. "50% of one order" and "50% of the account's
balance" are not two points on one scale.

The fix has two parts. `TIER_CEILING` caps how far each kind may be escalated,
and `reconcile.ts` now attaches a magnitude only where amount and reference are
the same asset at account scale — which is `balance_drift` and
`ledger_allocation_drift`, and nothing else. Every order-level finding is
classified by kind alone, which is section 9 honoured literally: it calls a
position mismatch meaningful and puts no size on it.

Worth being clear that the tests caught this, not review. Each of the five
failures looked like bad test data at first glance, and the first one was
partly that; it took the third and fourth to show the denominator was wrong
rather than the numbers.

**5. `balance_drift` has a MINOR floor, which reads wrong until you consider
rounding.**

Every other exchange-facing kind floors at meaningful or above. This one floors
at minor and is escalated by the numbers.

The reason is that this job reconstructs the expected balance change from
recorded trades, rounding notionals half-even at scale 8, while the exchange did
its own arithmetic. A residual of a few satoshi is that difference, plus any fee
paid in a third asset that step 6's decision 12 could not convert. With a
meaningful floor, every run would halt a bot on rounding — a false-positive
machine, and the fastest way to teach whoever reads the dashboard to ignore it.

So `meaningfulPct` (0.1%) is the line between noise and a real question, and
`severePct` (2%) between that and latching the account. Both numbers were chosen
here; the spec contains none. Both are per-account configurable specifically so
the section 17 testnet period can tune them against real observations rather
than leaving them at values nobody has tested.

**6. Marking manual adjustments reconciled is BATCHED with the snapshot that
consumed them.**

Section 8.6 subtracts unreconciled adjustments, and step 4 added
`reconciled_at` so the second run does not subtract the same one again.

The ordering question is nastier than it looks. Mark first and crash: the
adjustment is consumed with its explanation lost, so the next run over-alerts.
Write the snapshot first and crash: the same adjustment is subtracted again next
run, explaining away a real discrepancy — which UNDER-alerts, and is the
direction that loses money.

D1's `batch` is a transaction, so both go in one and neither happens. This is
the one place in the project where step 5's "every partial failure fails in the
safe direction" reasoning was avoidable rather than merely managed, because the
two statements involved need no `changes` inspection between them.

**7. Reconciliation writes `capital_ledger.total_balance`, finally giving it a
real source.**

Step 5's `placeholder-balance.ts` exists only because nothing maintained this
column, and its header says so. Every run now writes the observed exchange
balance into it — but only for an asset that ALREADY has a ledger row. Creating
one would declare capital available for allocation, and that is a human's
decision, not a cron's.

Note the discrepancy maths deliberately does not read this column. It measures
from the previous `balance_snapshots` row, so writing the ledger cannot
influence what the next run detects.

**8. The `scheduled` handler lives on the existing Worker, not a second one.**

Section 3's diagram draws "Cron Trigger Worker: reconciliation job" as its own
box. Cloudflare's model is that a cron trigger is a HANDLER on a Worker, not a
kind of Worker, so a genuinely separate deployment would need its own name, its
own D1 and Durable Object bindings, its own CI step and its own place in section
16's version tracking — all so two handlers on the same codebase could run in
different processes.

The separation section 3 is drawing is of concerns, and that is preserved:
`/src/reconciliation` takes every dependency as a parameter and knows nothing
about crons.

The cron is declared on production as well as testnet, which is safe for a
non-obvious reason worth recording: `runScheduledReconciliation` checks for an
exchange client BEFORE touching D1, and none exists, so it fires and returns
without querying production's deliberately empty database. Declaring it on only
one environment would have been the more dangerous choice — section 16 wants the
two configured identically.

**9. There is still no exchange client, so this is deployed-and-inert.**

Same position as step 6's decision 13, for the same reason: building a Binance
client needs live credentials and step 4.1's decision 2 left whose exchange
account will be used undecided. `exchangeFor` returns null, every run is
skipped, and the handler logs why.

Deliberately NOT an alert. Nothing is wrong — no credentials have been created
yet, it is a recorded state, and a critical alert every five minutes for it
would train whoever reads the dashboard to ignore the table.

**10. `snapshotIfCreated()` was added to `BotInstance` rather than matching on
an error message.**

`snapshot()` throws `BotInstanceError("not_created")` when the object holds no
state — step 6's open question 6, where capital is reserved and the row written
before the object's storage is. Reconciliation must distinguish "nothing to
compare" from "reading it failed", and it reaches the object over RPC, across
which a thrown error arrives without its `code` property. The caller would have
had to match on message text.

**11. An orphaned bot row is a system alert, not a drift tier.**

Following from 10: section 9's tiers are about a divergence between belief and
reality, and a bot whose object was never written has no belief to diverge. It
is reported as `orphaned_bot_row` (system category) and listed in the run's
`skipped`, rather than forced into a tier it does not fit.

**12. Routine, for completeness.** The `PendingFinding` / `ClassifiedEntry`
pairing, the run result shape, the barrel and the README are ordinary
implementation. One part had a real reason: `classifyAll` is a `map`, so its
output is index-aligned with its input, and the orchestrator pairs corrections
back by index. The first draft looked the correction up by matching kind, bot,
asset and detail — which works until two findings look alike, at which point it
silently applies the wrong correction. Replaced before it was ever run.

### Closing step 6's loop — explicitly

Step 6's deviations recorded: *"Section 9's reconciliation is relied on by three
paths here and does not exist yet. Those alerts currently go into a table nobody
reads automatically."*

**That loop is now closed, and here is exactly how**, since "closed the loop" is
the sort of claim worth being able to check:

| `alerts.alert_type` written by step 6 | Read as | Tier | Action |
| --- | --- | --- | --- |
| `cancel_fill_discrepancy` | `cancel_fill_discrepancy` | meaningful | halt that bot, alert |
| `unknown_order_fill` | `unknown_order_fill` | **severe** | trip the breaker, halt everything |
| `order_state_drift` | `reported_order_state_drift` | meaningful | halt that bot, alert |
| `cancel_failed` | `cancel_failed` | meaningful | halt that bot, alert |

Each run reads UNRESOLVED alerts of these types for bots on the account, turns
each into a finding, classifies it with everything else, acts on its tier, and
then sets `alerts.resolved` — which is the only place in the codebase that ever
writes that column true.

Four rather than step 6's three. `cancel_failed` was not on its list but
describes the same class of problem — this system's belief about an order
diverging from the exchange's — and reading its three neighbours while ignoring
it would have been an arbitrary line.

An alert is resolved only if the tier's action actually landed. If the halt
throws, the source alert stays unresolved, a `reconciliation_halt_failed` system
alert is written, and the next run finds it again. There is a test for that
specifically, because "we acted on it" and "we tried to act on it" being the
same code path is how an alert gets silently discarded.

Two honest qualifications:

- **Ingested findings carry no magnitude.** The alert's payload is prose in
  `message`. Re-deriving a number by parsing that prose would be a guess wearing
  a threshold's authority, so they classify by kind alone. This is fine for
  three of the four; for `cancel_fill_discrepancy` it means a one-satoshi race
  and a large one both halt the bot.
- **Resolving the source alert does not mean the underlying problem is fixed.**
  It means reconciliation consumed it and escalated. The new alert it writes
  stays unresolved for a human. Step 6's decision 3 gap — a position
  understating what the bot holds — is still not repaired by this, only
  detected and halted on.

### Deviations from the spec

- **Section 9 gives no thresholds; three numbers were chosen here**
  (`meaningfulPct` 0.1%, `severePct` 2%, `timingWindowMs` 60s). All reasoned,
  none measured against a real account.
- **Section 9's "compare against what each relevant Durable Object and D1
  believe" is not a two-way comparison but a three-way one**, and the three
  disagree in different ways. Object-vs-D1 is `mirror_drift` (minor,
  correctable); object-vs-exchange is `order_state_drift` (meaningful). Section
  9 does not distinguish them.
- **Section 9's balance comparison had no defined "internal" value** and one was
  designed here (question 1).
- **Section 7.3's circuit breaker was built** — it did not exist as code — and
  only one of its two triggers is wired (decision 2).
- **Section 3's "Cron Trigger Worker" is a handler on the existing Worker**
  (decision 8).
- **`circuit_breakers` is not in section 8.2.** The ninth table; the third
  addition after step 4's five columns and step 5's one.
- **Section 9's "auto-correct" is narrower than it sounds** (decision 3).
- **`getOpenOrders` takes a pair**, so an unexpected order is only visible on a
  pair some bot on the account already trades. An order on an untraded symbol —
  a plausible shape for the key-compromise case section 9 names — is invisible.
  Widening it means changing section 4.1's interface, which is a step 3 edit.
- **Section 5.4's rate limiter still gates nothing.** Measured rather than
  asserted this time: one pass is ~20 weight plus ~26 per distinct pair per 5
  minutes against 1200/minute, so this job is not the problem. A severe trip
  cancelling many orders at once is, and that is step 6's open question 7.
- **Section 10's outbound notification still does not exist.** Every alert this
  session writes, including a tripped circuit breaker, is silent unless someone
  looks at the table. That is step 8.
- **No live network call anywhere in the suite**, per section 14.

### Open questions carried forward

Still open from earlier steps: coverage measurement (2.6); `realizedPnl` and
`roundToStep` module placement (2.7); `Retry-After` parsed but unused (3.3); a
`tradeId` of `-1` (3.4); `recvWindow` and clock bias untested against real
latency (3.5); nothing verifies the API key lacks withdrawal permission (3.6);
whose exchange account and funds (4.1.1); the production allow-list is empty
(4.1.2); nothing enforces the empty production database (4.1.3); backups
(4.1.4); an audit entry can be lost on the capital-releasing paths (5.1);
`MAX_ALLOCATION_ATTEMPTS` untested under real contention (5.3); the position
understates what the bot holds after a halt that raced a fill (6.1);
`AttemptStore` needs `listUnresolved()` (6.2); fees in a third asset are never
converted (6.3); `sellOnStopLoss` is refused rather than implemented (6.4);
nothing drives `onPriceUpdate` (6.5); `create()` can leave a bot row with no
object state (6.6, now at least DETECTED — see decision 11); a halt cancels
orders one at a time (6.7); nothing tests two concurrent events on one object
(6.8).

Resolved: step 4's open question 3 (`balance_snapshots.classification` on a
clean run) — confirmed NULL rather than adding a fourth value, since section 9
names three drift classes and has no word for a clean result. Step 5's open
question 2 (nothing reconciles `sum(allocated_capital)` against
`total_allocated`) — `ledger_allocation_drift` is that check, and it is
meaningful-tier and deliberately not auto-corrected. Step 3's open question 2
and step 5's open question 4 are partly addressed: the client still does not
gate on rate limit, but the cron's own contribution is now measured rather than
unknown, and `total_balance` now has a real source rather than only a
placeholder.

New:

1. **The daily-loss half of section 7.3 does not exist** (decision 2). The
   breaker can be tripped by drift and by hand, and by nothing else. An account
   bleeding steadily within every per-bot stop-loss will not trip it.
2. **`orders` has no `cumulative_quote_quantity`** (step 4's open question 5,
   which said "nothing needs it before step 7"). Step 7 did not need it either,
   because reconciliation compares `filledQuantity` and `state` rather than
   average fill price. It would be needed to reconcile the VALUE of a partial
   fill, which nothing does yet. Still cheap to add; the tables are no longer
   empty in testing but are still empty in production.
3. **The balance delta is computed from the OLDEST snapshot across assets**, and
   each asset's arithmetic then measures from its own baseline. That is correct
   when every asset was snapshotted in the same run, which is true today because
   every run writes all of them. A future partial run — one asset skipped
   because its pair's filters could not be read — would leave the baselines at
   different times, and the trade window would be wider than one asset needed.
   The maths still works, because a trade before an asset's own baseline is
   already inside that baseline, but this has not been tested and I would want
   it tested before trusting it.
4. **Nothing tests two reconciliation runs racing.** The cron is one invocation
   per schedule and D1 has no lock, so two overlapping runs on one account would
   both read the same baseline and both write snapshots. `latch` is
   compare-and-swap and the adjustment consumption is batched, so the dangerous
   parts are safe, but the duplicate snapshots would make the NEXT run's
   baseline ambiguous — it takes the most recent by `checked_at`, and two rows
   would share it. Step 5 had to test interleaving explicitly; this session did
   not.
5. **The three thresholds are guesses** (decision 5). The section 17 testnet
   period is where they get real values, and nothing currently records what a
   typical residual actually looks like — the data will be in
   `balance_snapshots.discrepancy`, but nobody has looked at a real one.
6. **`assertAccountArmed` adds a D1 read to every `create` and `resume`.**
   Cheap and correct, but it means those two paths now fail if the
   `circuit_breakers` table is missing — which is true of any database that has
   not had migration 0003 applied. See `docs/d1-provisioning.md` section 3.1.
   *(Corrected same day: this originally read "including remote testnet right
   now", which was already false when written. All three migrations were
   applied to remote testnet and confirmed on 2026-07-22. The claim came from
   reading section 3.1's stale status rather than querying the database — the
   exact mistake that section now carries a standing convention against.)*

---

## Step 8: RateLimiter Durable Object
Date: 2026-07-22

Out of build-order. Section 19 puts alerts at step 8 and the grid at step 9;
this is section 5.4's rate limiter, taken first because the grid is what makes
its absence dangerous — step 6's open question 7 and step 7's own measurement
both point at a grid halt cancelling a full ladder serially, and building that
ladder before the thing that throttles it would mean shipping the exposure and
then fixing it. Alerts (step 8 proper) and the grid (step 9) both still stand.

### What was built

`src/durable-objects/rate-limiter.ts`: the `RateLimiter` Durable Object, one per
exchange account. `src/exchange/rate-limited.ts`: `RateLimitedExchange`, the
decorator that asks it for budget before every call.

Edits outside those two files, all listed so none is invisible:
`src/shared/downtime.ts` gained a third `FailureKind`; `src/shared/rate-limiter.ts`
gained `snapshot`/`restore` and a public `waitFor`; `src/exchange/binance/parse.ts`
gained `parseRequestWeightLimit`; `src/exchange/binance/client.ts`'s
`WeightReporter` became awaitable and gained an optional `syncLimit`, and
`getSymbolFilters` now reports the account's ceiling; `bot-instance.ts` routes
every exchange call through the limiter and handles a refusal explicitly;
`src/workers/reconciliation.ts` wraps its client the same way; `api.ts`
re-exports the class; `wrangler.jsonc` gained a `RATE_LIMITER` binding and a
`v2` migration under both environments; four folder READMEs corrected.

71 new tests (923 in total across the project), all passing, typecheck clean.
Real Durable Object storage and real D1 in the Workers runtime; the exchange is
still the only thing mocked, per section 14.

### First, the thing that was asked for explicitly

**The `syncFromExchange` wiring did not reach anything, and it was worse than
"goes nowhere".** The session brief asked me to confirm whether the Binance
client's header parsing actually reaches this object. It did not, and neither
end existed: `BinanceClient` parses `X-MBX-USED-WEIGHT-1M` and calls
`syncFromExchange` correctly, but **nothing in `src/` constructs a
`BinanceClient` outside `client.test.ts`**. There is no production exchange
client at all — step 6's decision 13 and step 7's decision 9 both declined to
build one without credentials — so the reporting path ran only in its own tests,
into a `WeightBudget` the test created.

That is now fixed at both ends in shape, and still unexercised in fact. See
decision 8 and open question 1: the limiter is wired, and nothing has ever made
a real exchange call through it.

### Four questions asked before writing anything

All four were put up front and all four confirmed the recommended reading.

**1. What a refused budget means for an order.** *(asked, confirmed)*

Step 6's decision 8 halts a bot on any failure that is not `transport`. A budget
refusal is neither of the two existing kinds, and both available answers were
wrong: as `transport` the attempt record sits `attempting` forever waiting to
reconcile an order that was never sent; as `exchange_error` a busy minute halts
bots, requiring a human to undo per section 7.2 step 5. Resolved by adding a
third kind. See decision 1.

**2. What counts as risk-exit.** *(asked, confirmed)*

Halt-path cancellations, the take-profit exit sell, and the filter read that
exit needs. Entries, their filter reads, and every reconciliation read are
routine. Rejected: tagging by METHOD ("every cancellation is risk-exit"), which
makes priority a property of the verb rather than of the intent.

**3. The bootstrap limit.** *(asked, confirmed)*

Assume 1200/minute, correct from the first `exchangeInfo`. Rejected: refusing
all traffic until the real limit is known, which needs an exemption for the call
that learns it — the assumed default under another name.

**4. How a caller waits.** *(asked, confirmed)*

A ticketed queue in the object; the caller sleeps and re-presents. Rejected:
stateless deny-and-retry, which leaves ordering to whoever retries first and
turns a storm into a thundering herd.

### Decisions made

**1. `rate_limited` is a third `FailureKind`, and this is the widest change in
the session.**

`ExchangeOutcome`'s failure union has meant two things since step 3: the request
was sent and its effect is unknown (`transport`), or it was sent and refused
(`exchange_error`). A budget refusal is a third thing — **it was never sent** —
and every consequence downstream turns on that.

Because the order provably does not exist, `#placeBuy` marks the idempotency
attempt `failed` rather than leaving it unresolved. Section 5.1's recovery-by-
lookup exists for orders that might be resting on the book; there is nothing to
look up here, and leaving it `attempting` would have reconciliation chasing a
ghost.

*Reusing `transport` — rejected*, for exactly that.
*Reusing `exchange_error` — rejected*: the exchange refused nothing. This system
declined to ask. Turning backpressure into a halted bot needing human review is
a worse outcome than the throttling it was reacting to.

The cost is real and worth stating: this widened a type every module in the
project handles. Typecheck found the call sites that switch exhaustively; it
could NOT find the two `outcome.kind === "transport"` comparisons in
`bot-instance.ts`, which still compile and would silently have taken the
else-branch into a halt. Those were found by reading, and are now pinned by
tests.

**2. Priority is two mechanisms, and the reservation is the load-bearing one.**

Step 2's decision 10 already argued this and now it is enforced. The reserved
slice handles the case ordering CANNOT touch — routine traffic spending the
whole budget before the stop-loss exists, so there is nothing to order it
against. The queue handles the case ordering is for.

Worth being precise about which does the work: with a reserve, a risk-exit
request is only ever blocked by other risk-exit traffic or by weight the
exchange reported that this system did not spend. The queue matters within a
cancellation storm, not between routine and risk-exit traffic.

**3. Priority is chosen by which client VIEW a call site holds.**

`withPriority("risk-exit")` returns a second `RestExchangeClient` over the same
budget and the same inner client, and it returns the narrow type deliberately —
a call site that has chosen cannot choose again, and a
`riskExchange.withPriority("routine")` in a halt path would be easy to miss.

*An options argument on all eight interface methods — rejected.* It would put a
rate-limiting concern into section 4.1's surface, which no implementation of
that interface shares.
*Deriving priority from the method — rejected*, per question 2.

**4. The bot object wraps its own exchange client. A caller cannot hand it an
ungated one.**

`attach()` takes the RAW client and `#exchange(config, priority)` is the only
route to the exchange in the file. Had `attach` simply accepted an
already-limited client, routing through the budget would be a property of how
each caller happened to wire its dependencies — true in the wiring someone
remembered and false in the one they did not, with nothing failing.

Same reasoning gives `#limiterFromEnv` its refusal: no `RATE_LIMITER` binding
means no trading, not ungated trading. The safe default for a risk control is to
stop.

**5. Tickets, not promises.**

The obvious API is `await limiter.acquire(...)` with the object holding the
caller until budget frees. That puts unresolved promises and a timer inside a
Durable Object: state that cannot be persisted, a wait that dies silently on
eviction, and a drain loop whose behaviour depends on a real clock — meaning the
priority ordering, a risk control, could only be tested by waiting for it.

A refusal returns a ticket instead. The object holds no timers and every
decision is a pure function of (budget, live tickets, clock), so `acquire` is
driven directly in tests at chosen timestamps. An unknown ticket is treated as a
new arrival rather than an error, which is the ordinary consequence of eviction
or of the TTL: it costs a queue place and never grants weight nobody asked for.

**6. A waiting ticket CLAIMS its weight, which turns out to be better than
step 2's `admit()`.**

`admit()` defers everything behind a request that does not fit. The object
instead counts the weight claimed by everything ahead of a request and grants
only if this request fits IN ADDITION. Same protection against a small request
overtaking a large one, without needlessly blocking a later request when there
is genuinely room for both.

I found this out from a failing test rather than by design: the head-of-line
test asserted a small request would be deferred, and it was granted, because the
window had freed enough for both. The behaviour was right and the test was
wrong. **Consequence worth recording: `admit()` is now dead code in production**
— only `prioritize` is used — and it is still covered by its own unit tests,
which is the shape that makes dead code look maintained.

**7. The window is persisted; the queue is not.**

A DO is evicted after a short idle period and the window is 60 seconds. An
object that forgot its entries would wake with an apparently untouched budget
and permit a second full limit inside one window — the double-rate failure that
made this a sliding window rather than a fixed one. So every grant costs one
storage write.

Tickets are deliberately NOT persisted. A ticket represents a caller currently
sleeping; persisting it would mean an evicted object waking to enforce claims on
behalf of callers that no longer exist, holding budget for nobody.

Verified rather than assumed, following steps 2, 4 and 6: `state.abort()` really
does tear the instance down, and the restore path really does run. The test
distinguishes the two cases by leaving a QUEUED TICKET behind as well as spent
budget — the ticket is memory-only, so its absence after the teardown is what
proves a new instance was constructed. Without that discriminator the test would
have passed vacuously had `abort` been a no-op.

Also worth recording against three previous sessions' findings: the pool's
`abort` behaves as documented. That is the first time in this project a
Cloudflare API has.

**8. Both existing callers are routed, and this is the part to check rather than
believe.**

- **The DCA `BotInstance`**: `#deps().exchange` appears in exactly one place,
  inside `#exchange()`. Tested by attaching NO limiter and asserting the real
  Durable Object named after the ACCOUNT recorded 21 weight (one `exchangeInfo`
  at 20, one `placeOrder` at 1) after a base order.
- **The reconciliation worker**: `runScheduledReconciliation` wraps the client
  before `reconcileAccount` sees it, so `/src/reconciliation` needed no change
  and still knows nothing about bindings. Tested the same way, including that
  the whole pass is routine and that its total cost is exactly the balance read.

That second test exists because `reconcile.ts` would behave identically with an
ungated client and its own 81 tests would still pass. "Reconciliation is rate
limited" is a property of the WORKER file, so it has to be asserted there.

**9. A bug I introduced, caught by the tests, worth recording because it is the
exact failure mode question 1 was asked to avoid.**

The first version routed `#ensureFilters` through the limiter and stopped there.
`#ensureFilters` throws when it cannot read filters and has no cache, and
section 7.5 turns an unhandled exception into a halt — so a throttled FILTER
read halted the bot, having carefully avoided halting on a throttled ORDER.

Fixed with a `throttled` error code and a branch in `onPriceUpdate`'s catch,
following step 2's decision 8: typed errors with codes exist precisely so a
routine condition does not reach section 7.5's escalation.

Two tests came out of it that were not planned, both pinning where in a pass the
refusal lands: on the filter read it costs nothing at all (no sequence taken, no
attempt record); on the placement the sequence is already spent and the attempt
is marked failed.

**10. `WeightReporter` became awaitable.**

`syncFromExchange` was declared `void` and synchronous, which was correct when
the only implementation was an in-memory budget. Reporting into a Durable Object
is an RPC call, and the old signature left the client either dropping the
promise — a floating promise in a Worker can be cancelled when the request ends,
losing precisely the correction that follows a 429 — or lying about having
recorded it. `syncLimit` is optional so `WeightBudget` still satisfies the
interface unchanged.

**11. The reserve is a FRACTION of the limit, not a fixed number.**

One sixth: 200 of 1200. A fixed 200 would have become a proportionally smaller
margin the moment `syncLimit` raised the ceiling — the one direction nobody
would notice. `syncLimit` also carries the already-spent weight across, since a
limit change is not a reason to hand an account a second budget inside one
window.

**12. Reading the limit from `exchangeInfo` costs nothing extra.**

`getSymbolFilters` already fetches that body for section 4.3, and the ceiling is
in it. The filter cache expires hourly, so the limit is re-read on the same
schedule for no additional weight. `parseRequestWeightLimit` returns `undefined`
rather than throwing on anything it cannot read — deliberately more lenient than
the order parsers, because failing a filter request over a malformed rate-limit
block would turn a budget refinement into an outage. It takes the SHORTEST
published window, which is the binding constraint and the one the used-weight
header reports against.

### Deviations from the spec

- **Section 5.4 says requests are "tagged with a priority level"; the tag is
  carried by the client view, not by the request.** Same effect, different
  shape, and the reason is decision 3.
- **Section 5.4 says "all order-execution requests ... request budget".** Every
  exchange call now does, not only order execution — a status poll spends weight
  too, and exempting reads would leave the budget wrong.
- **The default limit is 1200/minute.** That is what this project's earlier
  entries assume; Binance's published spot figure has been higher for some time.
  It is corrected by the first `exchangeInfo`, so the number matters only until
  the first filter read.
- **`admit()` from step 2 is now unused in production** (decision 6).
- **Section 19's step 8 is alerts; this is not that.** Section 10's outbound
  Discord/Telegram notification still does not exist, so every alert this
  session adds — `order_throttled`, `exit_order_throttled` — is silent unless
  someone looks at the table, exactly as step 6's and step 7's are.
- **`ENDPOINT_WEIGHTS` are the documented figures, not measured ones.** The
  budget consumes the estimate; the response header corrects it afterwards. A
  weight judged too low over-grants until the next response arrives.
- **No live network call anywhere in the suite**, per section 14.

### Open questions carried forward

Still open from earlier steps: coverage measurement (2.6); `realizedPnl` and
`roundToStep` module placement (2.7); `Retry-After` parsed but unused (3.3, and
now more pointed — the limiter computes its own `retryAfterMs` and still nothing
consumes the exchange's stated wait); a `tradeId` of `-1` (3.4); `recvWindow`
and clock bias untested against real latency (3.5); nothing verifies the API key
lacks withdrawal permission (3.6); whose exchange account and funds (4.1.1); the
production allow-list is empty (4.1.2); nothing enforces the empty production
database (4.1.3); backups (4.1.4); an audit entry can be lost on the
capital-releasing paths (5.1); `MAX_ALLOCATION_ATTEMPTS` untested under real
contention (5.3); the position understates what the bot holds after a halt that
raced a fill (6.1); `AttemptStore` needs `listUnresolved()` (6.2); fees in a
third asset are never converted (6.3); `sellOnStopLoss` is refused rather than
implemented (6.4); nothing drives `onPriceUpdate` (6.5); `create()` can leave a
bot row with no object state (6.6); the daily-loss half of section 7.3 does not
exist (7.1); `orders` has no `cumulative_quote_quantity` (7.2); the balance
delta is computed from the oldest snapshot across assets (7.3); nothing tests
two reconciliation runs racing (7.4); the three drift thresholds are guesses
(7.5); `assertAccountArmed` adds a D1 read to create and resume (7.6).

Resolved: step 3's open question 2 (the client reports weight but does not gate
on it) — it gates now. Step 6's open question 7 (a halt cancels orders one at a
time with no budget) — still serial, but now throttled, and the storm test is
the evidence. Step 6's open question 8 (nothing tests two concurrent events on
one object) — partly: `rate-limiter.test.ts` forces a real interleaving on one
object and asserts the ordering, which is the probe step 6 said it had not done.

New:

1. **Nothing has ever made a real exchange call through this.** The limiter is
   wired to both callers and every test drives it, but there is still no
   exchange client in either environment (step 4.1's decision 2). Deployed
   today, the whole path is exercised by nothing. The weights, the 1200 default
   and the one-sixth reserve are all reasoned, none measured against a real
   account, and the section 17 testnet period is where that changes.
2. **A grid halt is still SERIAL, and throttling makes that slower, not
   faster.** Cancellations go out one at a time (step 6's open question 7,
   unchanged) and each now waits for budget when the account is busy. That is
   the correct trade — an unthrottled storm earns a 429 and then a ban, during a
   halt — but a full ladder halting on a busy account takes longer to complete
   than it did yesterday, and nothing batches those cancels. Binance has a
   cancel-all-open-orders-on-a-symbol endpoint that would make this one request;
   it is not in section 4.1's interface. Worth considering at step 9.
3. **`maxWaitMs` is one window, and exceeding it is reported but not escalated.**
   A routine order that cannot get budget in 60 seconds is skipped with a
   warning; an exit that cannot is skipped with a critical alert. Neither trips
   anything. If an account is persistently at its ceiling, the honest signal is
   that alert, and nobody is watching the alerts table automatically until
   section 10's notifications exist.
4. **Two Durable Object round trips per exchange call**: one to acquire, one for
   the client to report the header. They could be one if the acquire response
   carried the previous call's usage, which is a refinement nobody needs before
   there is real traffic to measure.
5. **Budget is consumed on grant and never given back if the call then fails
   locally.** The gap between the grant and the request leaving is a few
   statements, so the over-accounting is small and fails in the safe direction.
   `release` exists only for abandoning a queue place, not for returning spent
   weight.
6. **A re-presented ticket keeps its ORIGINAL weight for the purpose of other
   requests' claims.** A caller that re-presented a ticket with a different
   weight would be checked against the new one while others queue behind the
   old. No caller does this — the wrapper's weight is fixed per method — but
   nothing prevents it.
7. **The reserve is one sixth for every account, with no per-account
   configuration.** Step 7's drift thresholds were made per-account
   configurable specifically so the testnet period could tune them; this was
   not, and the same argument applies to it.

---

## Step 9: Grid strategy
Date: 2026-07-22

> This entry was opened at the START of the step 9 session, after the four
> questions below were answered but before any code was written, and completed at
> the end. The four-questions section is the design decided up front; the "what
> was built" section onward is the record of the work.
>
> A note on test counts, since this entry has to pick numbers. Step 8's entry
> claims 923 tests; the measured baseline at the start of this session was **918
> across 31 files**. The discrepancy predates this session and nobody has
> established which figure was wrong, so it is recorded rather than silently
> reconciled. This session's figures are all measured: it ended at **971 tests
> across 33 files, passing, typecheck clean** — 918 baseline, plus 39 pure grid
> tests and 14 grid Durable Object tests.

### What was built

`src/strategies/grid.ts`: the whole of section 6.2 as pure functions, a sibling
to `dca.ts` with the same no-I/O separation so section 13's backtest can reuse
it. Ladder construction for both spacing types, the replace-on-fill rule, the
stop-loss / breakout / accumulated-take-profit thresholds, validation, and the
D1 `encodeGridParams` / `decodeGridParams` gate. `src/strategies/grid.test.ts`:
39 pure tests.

`src/durable-objects/bot-instance.ts`: made strategy-polymorphic rather than
forked into a second Durable Object, per the note the RateLimiter session left.
The config is now `DcaConfig | GridConfig`, discriminated by a `strategy` field;
`onPriceUpdate`, `onFill` and creation branch on it; every strategy-agnostic
method (`#halt`, `#cancelOpenOrders`, `#ensureFilters`, the mirrors, `#alert`,
`#audit`) was widened to a shared `BotConfigBase` and is reused unchanged. The
grid branch adds `#gridOnPrice`, `#placeInitialLadder`, `#placeGridOrder`,
`#applyGridFillToOrder`, `#applyGridExitFill`, `#gridExit` and
`#placeLiquidationSell`. `src/durable-objects/grid-bot-instance.test.ts`: 14
tests against real D1 and real Durable Object storage, mocked exchange, per
section 14.

Small edits outside the new files, listed so none is invisible: `dca.ts` gained
a required `strategy: "dca"` on `DcaConfig`; `strategies/index.ts` re-exports the
two strategies as namespaces (they deliberately share names); two test fixtures
(`dca.test.ts`, `reconcile.test.ts`) and one DCA assertion
(`bot-instance.test.ts`) gained the `strategy` discriminator; the two folder
READMEs were updated. No migration, no schema change: grid reuses
`bot_instances.strategy_type` (already `'grid' | 'dca'`) and the `unknown`
`strategy_params_json` column, exactly as step 6 anticipated when it kept that
column `unknown` "because grid will write a different shape at step 9".

### Reusing the object, not forking it — and what that cost

The RateLimiter session's closing note said grid "needs a grid-specific planner
and grid-specific stored state, plumbed through the same object." That is what
was done. The judgement worth recording is where the seam fell.

`DcaConfig` had no `strategy` field. Adding a required one is the clean
discriminator, but it means `#config()` reads a config that legacy stored state
would lack. Rather than a schema-version bump, an ABSENT `strategy` is read as
`"dca"` (`normalizeConfig`) — the section-16-additive treatment, and safe
because no exchange client has ever run, so there is no stored state to be wrong
about. Recorded so the one untested read path is visible.

The runtime state was the harder call. `BotRuntimeState` gains an OPTIONAL
`ladder?: GridLadder` rather than becoming a discriminated union. A union is
cleaner in the abstract, but it would have forced ~20 DCA test accesses to
`state.position` and the reconciliation fixture to narrow on a discriminator,
which is churn on working tests for a type-level nicety. Instead a grid bot
leaves `position` at `EMPTY_POSITION` and `cycleCount` at 0, a DCA bot leaves
`ladder` absent, and the authoritative discriminator is always
`config.strategy`. The honest cost: two inert fields on a grid bot, and a
`state` shape that permits combinations `config.strategy` forbids. The
alternative's cost was higher and fell on code that already works.

### Decisions made

**1. Buys-only initial ladder, and it is idempotent by slot occupancy.**

Question 2 settled that a started grid places only the buy ladder below spot.
`#placeInitialLadder` places at each below-spot level whose slot is still empty,
and marks the ladder `placed` only once no order was throttled. The
slot-occupancy check is load-bearing: without it, a throttled partial placement
would re-enter with `placed` still false and mint fresh sequences for levels
already live, double-placing them. With it, a re-entry fills only the holes. A
hard rejection (a filter failure the exchange refuses) halts, as everywhere
else.

**2. The grid exit is built ON TOP of the shared `#halt`, not beside it.**

Section 6.2 step 4 is "cancel all open orders, sell any held position, halt."
The cancel-and-halt is exactly `#halt`, including step 6's decision-2 ordering
(mark halted BEFORE cancelling, so a crash mid-cancel leaves a halted bot with
live orders — visible and safe — rather than a running bot with some cancelled).
So `#gridExit` calls `#halt` unchanged and layers only the liquidation sell on
top. The consequence worth stating: a MANUAL halt (section 7.2) does NOT
liquidate — only the three grid exit reasons (stop-loss, breakout, take-profit)
do. That matches DCA, whose `sellOnStopLoss` is refused precisely so an auto-sell
at a loss is never implicit. The grid genuinely differs from DCA here, and it
differs because section 6.2 step 4 says to sell where section 6.3 step 5 says to
halt-and-hold; the two strategies were specified differently and are built
differently.

**3. The liquidation is a marketable LIMIT, and it can fail to fill. Stated,
not hidden.**

Section 4.5 rules out market orders. So "sell any held position" cannot be a
market sell; it is a limit at the triggering price, which is marketable (it
crosses the spread) and fills immediately in a normal book. In a fast drop —
which is exactly when a stop-loss fires — that limit may not fill, and the bot
is then left halted holding a resting sell. This is alerted
(`liquidation_unresolved` / `_throttled` / `_not_constructible`) and the fill,
whenever it lands, is folded through `#applyGridExitFill`; it is never pretended
to have happened. This is the real limit of a market-order-free stop-loss on a
falling market, and it is the one place in this strategy where the safe-by-
default posture (section 4.5) and the risk control (section 6.2 step 4) are in
genuine tension. See open question 1.

**4. Each sell carries its buy's cost basis; realized profit is exact per round
trip.**

Per question 3's ladder model. `planFill` on a sell that completes a round trip
realizes `(sellPrice - costBasis) x quantity` and nothing else, where
`costBasis` is the price of the buy that funded that sell, recorded on the slot
when the replacement was created. The alternative — one blended average cost —
was rejected because section 6.2 step 6's take-profit triggers on "accumulated
realized profit", and a blended figure would make that an average-cost artefact
rather than the sum of what the grid actually earned. Realized profit lives in
`ladder.realizedGross`, and `state.realizedGross` (the field DCA also uses) is
kept equal to it, so the shared field is meaningful for both strategies and
nothing is double-counted.

**5. Geometric spacing uses an integer root, not `Math.pow`.**

`(upper/lower)^(1/(n-1))` needs an nth root, which `money.ts` does not have.
Using `Math.pow` and snapping to `Money` would put a float in the middle of a
price calculation, which section 5.2 exists to forbid. Instead the ratio is
found by binary search over bigint — the largest `r` with `r^(n-1) <= target`,
rounded to nearest — and the interior levels are built by repeated
multiplication with BOTH bounds pinned exactly. The pinning means the small
undershoot a floored ratio produces is absorbed into the top rung rather than
walking the grid off the bounds a human chose. `buildLevels` is deterministic,
which is what lets the creation-time capital check and run-time placement agree
on where the lines are. The root helper is private to `grid.ts`, following the
precedent that `additionalOrderSizeFor` (compounding, strategy-shaped) lives in
`dca.ts` rather than `money.ts`.

**6. The capital check is peak buy-side exposure, `orderSize x (gridLines - 1)`.**

The grid analogue of DCA's `plannedTotalSpend`. The most quote a buys-only grid
can commit at once is every buy level live simultaneously; the top line only
ever holds a sell, so that is `gridLines - 1` levels. `validateGridParams`
refuses a ladder that cannot cover that from its allocation, before any capital
is reserved — the same failure DCA's check prevents, a bot created happily that
then cannot fund an order mid-run with a position open (section 7.5 → halt).

**7. Point 6 answered here, not decided here.** The session brief asked me to
recommend rather than decide whether to add Binance's cancel-all-orders-on-
symbol endpoint. My recommendation is question 1 above: **do not add it now.**
The reasons in full are in that question; the short form is that throttling is
not the binding cost (a 20-line ladder is 20 weight against a 200/minute
reserve), the endpoint's blast radius is the whole account's orders on the
symbol — which section 3 permits a second bot to share — and nothing has ever
made a real exchange call, so the latency being optimised is unmeasured and
section 17 already schedules a real cancellation-storm measurement before
go-live. Serial-but-throttled cancellation is correct and acceptable for a first
version. This remains the account owner's call to confirm.

### Deviations from the spec

- **Section 6.2 step 2's "sell orders above" at start is not implemented as
  written** (decision 1 / question 2). A quote-funded bot has no base to sell;
  the sell side is built by replace-on-fill.
- **Section 6.2 step 5's "significantly above" was given a threshold the spec
  omits** — one grid step by default (question 4) — and the cash-out defaults
  ON as the spec directs.
- **Section 6.2 step 4's "sell any held position" is a limit, not a market,
  order** (decision 3), because section 4.5 forbids market orders. It can rest
  unfilled.
- **`take_profit_pct` is written NULL for a grid bot.** Grid take-profit is an
  accumulated profit AMOUNT in the params, not a percentage, and section 6.1
  makes it only "recommended" for grid. Migration 0001's DCA-only take-profit
  CHECK permits this.
- **Section 5.4's rate limiter still gates every grid order**, including the
  serial halt cancellations (unchanged from step 8) and now the liquidation
  sell, all at risk-exit priority.
- **Section 10's outbound notification still does not exist**, so every grid
  alert added here — `liquidation_unresolved`, `liquidation_failed`,
  `liquidation_not_constructible` — is silent unless someone reads the table.
  That is step 8 proper (alerts), still not built.
- **No live network call anywhere in the suite**, per section 14.

### Open questions carried forward

Still open from earlier steps, unchanged: coverage measurement (2.6);
`realizedPnl`/`roundToStep` placement (2.7); `Retry-After` unused (3.3); a
`tradeId` of `-1` (3.4); `recvWindow`/clock bias untested against real latency
(3.5); nothing verifies the API key lacks withdrawal permission (3.6); whose
exchange account and funds (4.1.1); the production allow-list is empty (4.1.2);
nothing enforces the empty production database (4.1.3); backups (4.1.4); an
audit entry can be lost on the capital-releasing paths (5.1);
`MAX_ALLOCATION_ATTEMPTS` untested under real contention (5.3); the position
understates what the bot holds after a halt that raced a fill (6.1);
`AttemptStore` needs `listUnresolved()` (6.2); fees in a third asset are never
converted (6.3); `sellOnStopLoss` is refused rather than implemented for DCA
(6.4); nothing drives `onPriceUpdate` (6.5); `create()` can leave a bot row with
no object state (6.6); the daily-loss half of section 7.3 does not exist (7.1);
`orders` has no `cumulative_quote_quantity` (7.2); the balance delta from the
oldest snapshot across assets (7.3); nothing tests two reconciliation runs
racing (7.4); the drift thresholds are guesses (7.5); the rate-limit reserve is
one sixth for every account with no per-account config (8.7); nothing has ever
made a real exchange call (8.1); a grid halt is serial and throttling makes it
slower (8.2, and see decision 7 — now a considered decision rather than an open
question, pending the account owner's confirmation); `maxWaitMs` exceeded is
reported but not escalated (8.3); two DO round trips per exchange call (8.4);
budget consumed on grant is not returned on a local failure (8.5); a
re-presented ticket keeps its original weight (8.6).

New:

1. **A grid stop-loss liquidation can fail to fill, and the position is then
   held on a halted bot** (decision 3). The limit is marketable but a fast drop
   can outrun it, and section 4.5 leaves no market-order fallback. It is alerted
   and reconciliation-visible, not silently dropped, but "the stop-loss sold the
   position" is only true when the limit fills. The section 17 testnet period,
   which must see the stop-loss fire at least once, is where this gets observed
   against a real book — and it is the specific thing to watch, because a
   stop-loss that halts but does not sell is the failure a stop-loss exists to
   prevent.
2. **The liquidation order lives in `openOrderIds` but not in a ladder slot**,
   because it is a whole-position sell, not a level order. Nothing recomputes
   `openOrderIds` from the ladder after an exit (the bot is halted and only the
   liquidation fill arrives), so this is safe today, but it is a latent coupling:
   a future code path that rederived `openOrderIds` from the ladder slots would
   silently drop the liquidation order. Worth a guard if the ladder ever drives
   `openOrderIds` on a halted bot.
3. **Grid is not exercised by reconciliation's tests.** `reconcile.ts` reads
   only base state (`openOrderIds`, `orders`) and a grid `BotSnapshot` satisfies
   that, so it should work, but no test drives a grid bot through a reconciliation
   run. The interaction is untested, not known-broken.
4. **The initial ladder places serially, like the halt cancels serially.** A
   wide grid starting on a busy account issues N buys one at a time through the
   budget. Decision 7's reasoning about the halt applies symmetrically to the
   start, and the same measurement resolves both.
5. **A geometric ladder's interior levels drift slightly high** because the
   floored ratio undershoots and the top bound is pinned, widening the top rung.
   Deterministic and small, but the rungs are not exactly equal-ratio; the test
   asserts they are equal to within a few satoshi rather than exactly. A real
   grid's tickSize rounding at placement dwarfs this, but it is a real property
   of the construction and is recorded rather than smoothed over.

### Four questions asked before writing anything

Section 6.2 is eleven lines and three of them turned out to be underspecified in
a way that changes what gets built. The fourth question is the rate-limiting
concern step 8's open question 2 explicitly deferred to this step. All four were
put to the account owner up front and all four confirmed the recommended
reading.

**1. A grid halt stays SERIAL; the cancel-all endpoint is not added.** *(asked,
confirmed)*

Step 8's open question 2 left this for step 9: cancellations go out one at a
time, each now correctly waiting for risk-exit budget, and Binance has a
cancel-all-open-orders-on-a-symbol endpoint that would make a ladder halt one
request instead of many. It is not in section 4.1's interface. The
recommendation was to leave it there, for three reasons, in ascending order of
how much they matter.

- **Throttling is not the binding cost, and saying it is would be wrong.** A
  cancellation is weight 1. A twenty-line ladder is twenty weight against a
  risk-exit reserve of two hundred per minute, so the reserve absorbs an entire
  ladder several times over and the budget refuses nothing. What actually makes
  a serial halt slow is the round trips — two Durable Object hops plus one HTTPS
  request per order, at the 100–250ms Cloudflare-to-Binance latency section 12
  quotes. Framing this as a rate-limiting problem would be optimising the wrong
  thing.
- **The endpoint's blast radius is wider than a bot.** It cancels every open
  order on the symbol for the whole ACCOUNT, and section 3's isolation principle
  permits two bots on one account and one pair — a grid and a DCA on BTCUSDT is
  exactly the two-strategy arrangement v1 is designed around. One bot halting
  would silently cancel the other's orders, with nothing in the second bot's
  state recording that it happened; it would surface as order-state drift in
  section 9 reconciliation, one halt later. The per-order path structurally
  cannot do this. Making the batch path safe means a guard proving this bot is
  the only one on that (account, pair), which is a D1 read and more moving parts
  than the loop it replaces.
- **Nothing has ever made a real exchange call** (step 8's open question 1). The
  latency being optimised is unmeasured, and section 17's checklist already
  requires a real cancellation storm to be observed against testnet before
  go-live. Building the optimisation first means choosing it over a measurement
  that is already scheduled.

*Adding it now — rejected*, per the above. *Revisit at:* the section 17 testnet
verification, which is where a real ladder halt gets timed. If a full ladder
takes long enough to matter, this is the fix, and the blast-radius guard is what
it needs to ship with.

**2. A started grid places BUYS ONLY; every sell is created by replace-on-fill.**
*(asked, confirmed)*

Section 6.2 step 2 says a started bot "places the full ladder of buy orders
below and sell orders above". It cannot. Step 6's decision 10 denominated order
sizes and `allocated_capital` in the QUOTE asset, so a freshly created bot holds
no base asset and has nothing to sell. The literal reading is unfundable on the
first pass.

Resolved as: the buy ladder goes out below spot, and a sell exists only once the
buy one level below it has filled and paid for it. That is self-funding by
construction — the replace-on-fill rule of section 6.2 step 3 is what builds the
upper half of the ladder — and it is ordinary long-grid behaviour for a
quote-funded bot.

*Buying the initial inventory at start — rejected.* It satisfies the sentence
literally, and it does so by spending a large part of the allocation at spot the
moment the bot starts, which is a directional bet the strategy is otherwise not
making. A grid's premise is that it profits from oscillation without taking a
view; opening it with a single large market-adjacent buy takes one.

*Requiring pre-existing base holdings via an `initialBaseInventory` parameter —
rejected.* It would make the bot's stored state depend on an operator assertion
nothing verifies, and section 9's reconciliation would report the mismatch as
drift the first time the claim was wrong — which is a risk control firing
because of a configuration field, not because of a trading event.

**3. Ladder state is a stored levels array plus one slot per level, and each
sell carries the cost basis of the buy that funded it.** *(asked, confirmed)*

The prices are constructed once when the bot starts and persisted, rather than
recomputed from the parameters on each pass. This follows the reasoning DCA used
for storing `averageEntryPrice` even though it is derivable: the number the bot
placed orders against is the number that was recorded, not one re-derived later
from rounded inputs.

Beside them sits one slot per level holding `{side, clientOrderId, costBasis}`.
Section 6.2 step 3's rule — a filled buy places a sell one level above, a filled
sell places a buy one level below — is then a change of two adjacent slots
rather than a search through a list, and "at most one live order per level" is
true by construction rather than by check.

`costBasis` is what makes realized profit exact. A grid's profit is inherently
per round trip: a sell at level i+1 that replaced a buy at level i earns
`(price[i+1] - price[i]) x quantity` and nothing else. Pairing them at the
moment the replacement sell is created records that directly.

*Deriving the level prices and storing only the live orders — rejected.* Less
stored state, but the one-order-per-level invariant becomes a runtime assertion,
and profit needs a separate cost model bolted on beside it.

*A single weighted-average inventory cost instead of per-level pairing —
rejected.* One number is simpler and it blends levels, so per-round-trip profit
stops being exact — which matters because section 6.2 step 6's optional
take-profit triggers on "accumulated realized profit", and that figure would
then be an average-cost artefact rather than the sum of what the grid actually
earned.

**4. "Significantly above the highest grid line" means one grid step above it,
by default.** *(asked, confirmed)*

Section 6.2 step 5 defines the upside breakout qualitatively and supplies no
threshold, unlike step 4's stop-loss, which is explicitly "by the configured
percentage". Resolved by defaulting the threshold to the ladder's own spacing:
one full level above the top line, configurable to override.

The ladder's spacing is the only scale section 6.2 actually supplies, and it
carries the right meaning — price has moved past the point where the grid could
have placed another sell, which is precisely the "idle with no sell orders
remaining" state step 5 exists to avoid.

*A fixed default percentage — rejected.* Predictable, and a number invented here
with nothing behind it. Step 7's entry already criticised its own drift
thresholds on exactly this ground; repeating it deliberately would be worse than
doing it once by accident.

*Making it a mandatory parameter with no default — rejected.* Nothing is
guessed, but it adds a required field the spec never asks for, and whoever
creates the bot still has to invent the number — the same guess, relocated to
someone with less context.

### The default itself, stated plainly

Section 6.2 step 5 says the cash-out behaviour "should be configurable but
defaults to on", and the session brief asked for the spec's stated default to be
followed exactly. So: **`breakoutTakeProfit` defaults to TRUE.** A strong break
above the highest line cancels the remaining ladder, sells the held position and
halts, as a take-profit event. Configured off, the bot takes no special action
and is left idle above its own ladder, which is the state the default exists to
prevent.

---

## Step 10: Alerts and outbound notification
Date: 2026-07-22

Section 19's **step 8**. The header is 10, not 8, because the log's sequential
numbering already spent 8 on the RateLimiter Durable Object (taken out of order,
see that entry) and 9 on the grid. Every code comment touching this work says
"step 8", meaning section 19's step 8, and that reference is stable regardless
of the log's own counter. This is that step, built after the grid it will report
on.

The recording half of section 10 already existed: every alert in the system is
written to the D1 `alerts` table by the pipeline that raises it, always and
unthrottled, and has been since step 6. This session built the **notifying**
half — the outbound Discord ping and its KV cooldown — and wired it to fire for
every alert already being written.

### What was built

`migrations/0004_alerts_notified_at.sql`: `alerts.notified_at` (nullable) plus a
partial index on the un-notified rows.

`/src/notifications/`: `notifier.ts` (the `AlertNotifier` interface,
`NotifiableAlert`, `NotifyResult`), `discord.ts` (`DiscordNotifier`, the one
provider), `cooldown.ts` (`CooldownStore`, `KvCooldownStore`,
`InMemoryCooldownStore`, `cooldownKey`), `dispatch.ts` (`dispatchPendingAlerts`),
`index.ts`, and a folder README.

`/src/workers/notifications.ts`: the binding-aware shell, `runNotificationDispatch`.
`api.ts` now routes two crons by `controller.cron`; `wrangler.jsonc` gained a
second `* * * * *` cron under both environments; `vitest.config.ts` gained an
`ALERT_COOLDOWNS` miniflare KV; `vitest-env.d.ts` declares it on `Cloudflare.Env`
for tests.

Seven `alerts.insert` sites gained `notified_at: null` — the whole of the wiring
change. All sixteen BotInstance alert types funnel through one `#alert` helper
(one edit); `reconcile.ts` has four direct inserts; `circuit-breaker.ts` has two.
`src/db/schema.ts` and `src/db/test-helpers.ts`'s `alertRow` gained the column.

`docs/kv-provisioning.md`: the exact commands to create the KV namespace and set
the Discord secret per environment. **Not run.** No Cloudflare resource was
created and no secret was set this session.

39 new tests across four new files (1010 in total across the project), all
passing, typecheck clean. Real D1 and real KV in the Workers runtime per section
14; only the notifier and its `fetch` are mocked, and the webhook URL in every
test is a mock, never a real one.

### Decisions made

**1. The dispatcher is a Cron Trigger that reads the alerts table, not an inline
send at each write site.** *(the session's item 5; my call, reasoned against the
D1-mirror principle it asked me to weigh)*

Step 5's decision B established that the D1 mirror is written by the same
pipeline that processes the event — "one place responsible for it" — and the
brief asked whether that argues for inline sends. It does not, once the right
"event" is named. That principle governs the **authoritative record**. Section
10 and the brief both state recording and notifying are two separate concerns;
the alert row *is* the record and is already written by the event pipeline. The
ping is a downstream projection of it. For the projection, the event is "an
un-notified alert row exists", the pipeline is the dispatcher, and the dispatcher
owns both the send and the cooldown write together — so the principle holds
*within* the notification concern: one place responsible, for all three alert
sources at once.

*Inline sending at each write site — rejected*, for three specific reasons.
It would put an outbound Discord `fetch` on the BotInstance halt path, where step
3.1 established that speed is a safety property — a slow or hung webhook would
delay a halt, and the halt is the one path where latency is a risk, not a
nicety. Alerts are raised from two execution contexts (the Durable Object and the
reconciliation Worker); a table-reading dispatcher is agnostic to who wrote the
row, where inline sending would thread a notifier and a KV binding into three
files. And it would scatter the "one place responsible" across those files rather
than concentrate it.

*Revisit if:* never, realistically. The separation is the point.

**2. A separate one-minute cron, not folded into reconciliation's five-minute
pass.** Both are `scheduled` handlers on the same Worker, routed by
`controller.cron`.

*Folding dispatch into the reconciliation tick — rejected.* Simpler, but a halt
or stop-loss ping would then wait up to five minutes behind reconciliation. One
minute is well inside section 10's fifteen-minute cooldown, and the protective
action already happened synchronously in the object — only the human ping is
paced here. The cost is that at minutes divisible by five both crons fire; that
is two separate `scheduled` invocations with different `controller.cron`, routed
correctly (open question 5).

**3. A `notified_at` column is the dispatcher's queue marker, distinct from
`resolved`.**

The dispatcher needs a durable, per-row record of "already acted on", to scan
`WHERE notified_at IS NULL` and never re-process across restarts.

*Reusing `resolved` — rejected.* It already means something else: section 9's
reconciliation is the one writer of `resolved = true`, closing step 6's alert
loop, and a step-6 alert can be resolved long before or without ever being
notified. Two independent lifecycles, two columns.

*A KV high-water-mark cursor instead of a column — rejected, and this is the
load-bearing part.* Alerts are stamped `created_at` by whichever of two contexts
wrote them, each with its own clock. A cursor advancing past a `created_at` could
skip a row written slightly behind it by a skewed clock — silently, forever. A
per-row flag has no such hole. The cost is that adding a required column forced
`notified_at: null` onto all seven insert sites; that churn IS the wiring the
brief asked for (item 4), and it means a future alert writer cannot exist without
confronting the field.

**4. The notifier depends on `NotifiableAlert`, never on a D1 row or a Discord
payload.** The dispatcher maps `AlertRow` onto a camel-cased, storage-free shape
before handing it over, so `DiscordNotifier` sees neither the money/CAST
conventions of `/src/db` nor is the dispatcher aware Discord exists. A Telegram
provider (section 2 allows either) is a new class implementing `AlertNotifier`,
changing nothing in `dispatch.ts` or `cooldown.ts`.

**5. `send` returns a `NotifyResult`, and a failed send is left un-stamped for
retry.** A 503 or a 429 is a routine, expected outcome, not an exception —
returning a result rather than throwing keeps the dispatcher's control flow
linear, and it still guards against a provider that throws anyway by treating a
throw as `delivered: false`. A failed row is deliberately NOT stamped and its
cooldown NOT advanced, so the next run finds it and retries; the alert is in D1
regardless. The cooldown is advanced *before* the row is stamped, so a crash
between the two re-sends a duplicate ping rather than losing the record that one
went out — over-notifying is the safe direction for an alert.

**6. Account-wide alerts (null bot) share one per-type cooldown bucket
(`__account__`).**

*Keying the cooldown on a null bot directly — rejected.* The circuit breaker and
unattributed reconciliation findings carry `bot_instance_id = null`; a null in
the key would let a storm of them escape the cooldown. Bucketing per type under a
shared sentinel throttles them as one stream, which is what section 10 wants.

**7. KV keys self-expire at a TTL at least as long as the window; a garbled value
is treated as no record.** The alerts table grows forever (section 8.7); the
cooldown is transient, so its keys are written with `expirationTtl` and clean
themselves up. A non-numeric stored value is read as "never sent" rather than
trusted — worst case one extra ping, the safe direction. KV's job here is exactly
the one section 8.3 assigns it and the one place its eventual consistency is
harmless, which is why the circuit breaker (migration 0003) used D1 instead.

**8. One timestamp for the whole dispatch run, making within-run throttling
deterministic.** The first alert of a `(type, bot)` records the run's instant;
every later one in the same run sees a zero delta and throttles. Combined with
oldest-first ordering, the *earliest* of a simultaneous burst is the one that
sends — not an arbitrary one. This is what the cooldown tests pin.

**9. Every alert type flows through; no per-type or per-severity filter.**

The brief (item 4) and section 10 both say every alert type notifies, throttled
only by the cooldown. So `order_throttled` and the other high-frequency,
low-value types are not filtered out — they are self-limited by their own
fifteen-minute cooldown. Adding a severity gate would contradict "every alert
type" and section 10's "no escalation logic in v1". If the noise proves real in a
testnet run, the cooldown window per type is the dial to turn, not a filter.

**10. Cooldown duration and category distinction were checked for ambiguity and
found specified, so neither was asked.** The brief said to stop and ask only if
one of these two was ambiguous. Neither is: section 10 gives the cooldown as
"default 15 minutes per alert type per bot instance", and the `category`
(`trading`/`system`) column has been set at every write site since step 4 — the
distinction is already data, not a judgement this step had to invent. The
dispatcher renders it in the Discord embed both visually (colour family by
category, shade by severity, plus a `[TRADING]`/`[SYSTEM]` label) and
structurally (Category and Severity as their own fields), so it survives either
being missed.

**11. KV namespace and Discord secret provisioning deferred, and the shell
no-ops until they exist.** This mirrors step 4 deferring D1 provisioning to step
5: no placeholder resource id is committed to `wrangler.jsonc` (step 4, decision
1), tests get a local KV from miniflare, and `runNotificationDispatch` returns
`ran: false` — before any D1 access — when either the `ALERT_COOLDOWNS` binding
or the `DISCORD_WEBHOOK_URL` secret is absent. It is the same shape as
reconciliation no-opping without an exchange client. The binding is declared in
two typing places for now (`Cloudflare.Env` in `vitest-env.d.ts` for tests, the
global `Env` via a `declare global` in `notifications.ts` for the Worker),
exactly the split step 4 made for `TEST_MIGRATIONS`, and both go away when the
namespace enters `wrangler.jsonc`.

### Deviations from the spec

- **Section 8.3 describes only the KV last-notified timestamp; there is now also
  a D1 `notified_at` per row.** The spec did not anticipate that the dispatcher
  needs a durable, per-*event* record of what it has acted on — the KV cooldown
  is per `(type, bot)`, not per row, and cannot answer "which rows are still
  outstanding". The column is that answer. See decision 3.
- **Section 10's "visually distinguishable on the dashboard" is delivered in the
  Discord message, not the dashboard,** which is section 19's step 10 and not
  built. The `category` column that backs the dashboard already exists (step 4),
  so nothing here blocks it.
- **Section 10 lists "Queue dead-letter events" as a system alert; no such writer
  exists.** Queues arrive with order execution, a later step, so there is nothing
  to wire yet. The dispatcher will cover dead-letter alerts for free the moment
  that writer inserts a row with `notified_at: null`, because it is type-agnostic.
  "Unhandled exceptions" and "Worker errors" (the other two section-10 system
  examples) *are* wired: an unhandled exception halts with reason
  `unhandled_error`, whose alert `#halt` already classifies as `system`.
- **Section 2 allows Discord or Telegram; only Discord is built,** per the brief.
- **The one-minute cron fires and no-ops in every environment until KV and the
  secret exist,** the same accepted state as reconciliation's cron without
  credentials.

### Open questions carried forward

1. **Nothing in this project has ever sent a real notification.** The entire path
   is tested against a mocked notifier and a mocked `fetch`; `DiscordNotifier`'s
   payload is reasoned from Discord's webhook documentation, not seen to arrive in
   a real channel. This is the same class of gap as step 7's circuit breaker and
   step 8's rate limiter, and it fails the same way: a control that has tests is
   the easiest to assume verified. The failure this raises is specific — a
   misconfigured webhook is a *silent* failure of the exact channel by which a
   human is meant to learn a bot halted. **A go-live checklist item has been added
   for it** (section 17 amendment, 2026-07-22, build step 8): at least one alert of
   each category seen to actually arrive in the destination channel during
   testnet. Recorded here and in the checklist deliberately, for the reason the
   step 7 and 8 amendments give: a gap that lives only in a decision-log entry is
   one nobody re-reads at the moment it matters.
2. **A permanently-failing webhook is retried every minute forever.** No attempt
   cap, no dead-letter. Acceptable for v1 (section 10: no escalation), but it
   hammers a broken endpoint and grows the per-run `failed` count without bound.
   The fix, if a real outage shows it is needed, is a small max-attempts stamp
   that marks a row processed after N failures rather than retrying endlessly.
3. **Provisioning is not done.** The `ALERT_COOLDOWNS` KV namespace and the
   `DISCORD_WEBHOOK_URL` secret must be created per environment before any ping
   fires; `docs/kv-provisioning.md` has the commands, unrun. A go-live dependency.
4. **`created_at` is stamped by whichever context wrote the alert, and the
   dispatcher orders by it.** The `notified_at` flag removes the missed-row risk a
   cursor would have had (decision 3), but the "earliest of a burst sends first"
   guarantee is only as good as the two contexts' clocks agreeing. The
   consequence of disagreement is merely *which* of a same-key burst is the one
   ping that goes out — harmless — but it is noted rather than hidden.
5. **The two crons both fire at minutes divisible by five.** Routing on
   `controller.cron` handles it as two separate invocations, tested by the routing
   logic but, like every cron and binding in this project, not yet verified
   against the real Cloudflare platform.

---

## Step 10.1: no-schema guard on the cron Workers
Date: 2026-07-23

A scoped fix between build steps, not a step of its own, like step 3.1.

### What changed

The production Worker is now deployed, but its D1 database is intentionally
empty — migrations are deferred to go-live (section 16.1). Both cron handlers
fire on that schedule regardless, and both reached D1 before anything told them
the schema was absent: reconciliation at `accountLabels` (which reads
`bot_instances`), notification dispatch at `dispatchPendingAlerts` (which reads
`alerts`). Each threw a raw `D1_ERROR: no such table` — reconciliation every five
minutes, dispatch every minute — logged as a real error against a state that is
expected and correct.

`Database.tableExists(name)` was added (a `sqlite_master` lookup, inside /src/db
so `no-raw-d1` still passes; `sqlite_master` exists even on an empty database, so
the check itself never throws). Both Workers now call it before their first real
query and return the same `ran: false` + reason shape already used for a missing
binding or secret — logged by the existing handlers as "did not run: …".
`runScheduledReconciliation` gained a `db?` option, symmetric with dispatch's,
for the propagation test and eventual dashboard reuse. The reconciliation
header's claim that the exchange-client check already guarded D1 was corrected:
it never did — `accountLabels` runs before the per-account exchange check — so
this guard is what actually delivers the "clean no-op, not a failing query"
the header had promised.

Three files changed (`src/db/database.ts`, `src/workers/reconciliation.ts`,
`src/workers/notifications.ts`), one test file added. 1017 tests (up from 1010),
typecheck clean.

### Decisions made

**1. A proactive `tableExists` check, not a try/catch around the D1 work.**

A specific check reads better against the brief's own warning and matches every
other guard in these two Workers — the missing-binding and missing-secret checks
are all proactive and all return `ran: false` with a reason. More importantly, it
cannot swallow anything: there is no catch block, so a genuine D1 error — a
constraint or type failure — propagates untouched. Only `tableExists === false`
produces the no-op.

*A `try { … } catch (e) { if (isMissingTableError(e)) … }` — rejected.* It would
work, and re-throwing everything but the classified case is not "swallowing", but
it inverts the safe default: a catch wide enough to see the missing-table error is
wide enough to mis-handle a future error someone forgets to re-throw. Matching a
raw D1 error string (`/no such table/`) is also more brittle than asking
`sqlite_master` a direct question.

**2. Each Worker checks the specific table it is about to read** (`bot_instances`
for reconciliation, `alerts` for dispatch), not a shared "is the schema there"
sentinel. Migration 0001 creates every table at once, so any one is
representative — but naming the table each Worker actually depends on makes the
no-op reason say exactly what was missing, and keeps the two Workers independent.

### Confirmed unchanged

Where the schema exists — testnet, and production after go-live — `tableExists`
returns true and both Workers proceed exactly as before; the only added cost is
one `sqlite_master` lookup per cron fire. Tested directly: the schema-present
cases assert both Workers run (`ran: true`), and the whole prior suite is
unchanged at 1017 passing.

### Test coverage

`src/workers/schema-guard.test.ts`, seven tests. The no-schema cases run first,
against a genuinely empty `env.DB` (a test file starts schema-less; verified with
a throwaway probe before writing these), and assert each Worker returns the clean
no-op reason rather than throwing. The schema-present cases assert `tableExists`
is true/false correctly and both Workers proceed. The propagation cases inject a
`Database` whose `tableExists` passes but whose first query throws a
non-missing-table error, and assert it surfaces — proving the guard suppresses
only the missing-schema case.

### Open questions carried forward

1. **The guard is verified against miniflare's D1, not the real empty production
   database.** The failure it fixes was observed in production logs; the fix is
   tested locally. Confirming the production cron logs now show the clean no-op
   instead of the raw error is a one-look check against the deployed Worker's
   logs, not something the suite can assert.

---

## Step 10.2: Discord timestamp showing 1970 -- investigated, not a code bug
Date: 2026-07-23

A test alert manually inserted to verify the newly-provisioned Discord webhook
(the go-live item added at step 10) landed showing `1/21/70` instead of the real
date -- the classic seconds-vs-milliseconds tell.

### What was found

The formatter at `src/notifications/discord.ts` renders
`new Date(alert.createdAt).toISOString()`, treating `created_at` as
milliseconds. That is correct for this system, and the investigation confirmed
it rather than assuming it: `Timestamp` is documented as milliseconds since the
epoch, every alert writer stamps `created_at` with `Date.now()` (the BotInstance
`#now`, reconciliation's `now`, the circuit breaker), the column has no
`unixepoch()`/`strftime()` default, and nothing in the dispatch path divides or
scales the value -- the dispatcher passes `row.created_at` straight through.

A real alert therefore carries `created_at ~= 1.76e12`, which renders 2025. The
`1/21/70` corresponds to `~1.76e9` reaching `new Date` -- the current time in
**seconds**. So the value in that particular row was seconds, and the manual
insert that produced the test alert had used a Unix-seconds value (an
`unixepoch()` / 10-digit number) rather than the milliseconds the system uses.

### Decision: the formatter was NOT changed

The reported symptom is real, but the cause is the test row's data, not the
formatter. "Fixing the conversion" by scaling `createdAt` in the notifier would
have rendered every genuine (millisecond) alert as roughly the year 57700 and
broken the existing assertion. So the unit handling was left exactly as it is.

This is recorded deliberately, because the instinct the bug invites -- "the date
is wrong, multiply by 1000 where it is formatted" -- is precisely the change that
would turn one wrong test row into every real alert being wrong. The formatter
reflecting the system's own convention is the property to protect, and the fix
belongs at the insert (use milliseconds, e.g. `unixepoch() * 1000`).

### What changed

One test only, in `src/notifications/discord.test.ts`: a regression test
asserting the rendered embed timestamp round-trips to the exact `created_at`
instant AND lands in the real year, so a future seconds-vs-ms slip in either
direction -- a stray `/1000` (-> 1970) or `* 1000` (-> ~57700) -- fails loudly
here rather than surfacing as a wrong date in a real Discord alert. 1018 tests,
typecheck clean. The notifier itself is untouched.

---

## Step 10.3: Human liquidation and the global kill switch
Date: 2026-07-23

Backend only, and a deliberate precursor to the dashboard (spec step 10) and
Cloudflare Access (step 11), both of which stay unbuilt. Two risk controls that
a human triggers: a unified `liquidatePosition` both strategies expose
identically, and section 7.4's global kill switch, the account-spanning sibling
of step 7's per-account breaker. 1041 tests, up from 1018; typecheck clean.

I was asked to stop and ask if the strategy-unification or the
global-vs-account relationship was ambiguous. I judged neither was -- the brief
is prescriptive (the global switch halts bots *directly* through their own halt
path, keeps its *own* record, has its *own* reset; both latches independently
gate create and resume) -- and proceeded without asking. Two forks I decided
rather than surfaced are called out below (decisions 2 and 5), because "I did
not ask" is only honest if it says what I decided in the silence.

### What was built

- `BotInstance.liquidatePosition(actor)`: the unified human close-out, callable
  on a bot in ANY halted state, refused on a running one.
- A new `exitKind` field on the object's runtime state (`take_profit` |
  `liquidation`), and a DCA `#completeLiquidation` that keeps the bot halted
  where `#completeCycle` would auto-restart.
- `#placeLiquidationSell` widened from `GridConfig` to `BotConfigBase`, so
  grid's stop-loss and the new human path share one liquidation mechanism.
- `migrations/0005_global_kill_switch.sql`: a one-row `global_kill_switch`
  latch, its own record separate from `circuit_breakers`.
- `src/reconciliation/kill-switch.ts`: `tripGlobalKillSwitch`,
  `resetGlobalKillSwitch`, `assertGlobalArmed`, mirroring the account breaker's
  shape (latch-before-sweep, injected `haltBot` port, human-only reset).
- `BotInstance.create`/`createGrid`/`resume` now assert BOTH latches armed.
- `src/workers/kill-switch.ts`: `tripGlobalKillSwitchFromEnv` /
  `resetGlobalKillSwitchFromEnv`, the binding-aware seam the dashboard button
  will call, building the real halt port from the `BOT_INSTANCE` namespace.
- Three test files (real D1 + real Durable Objects, only the exchange mocked):
  DCA and grid liquidation through the one call, a running bot rejected, and a
  global pull that halts real bots across two different accounts.

### Decisions made

**1. The liquidation mechanism is grid's, reused verbatim, not a second one.**

Section 6.2 step 4's "cancel all, sell any held position, alert if it does not
fill" was already built at step 9 as `#placeLiquidationSell`, and its body was
already strategy-agnostic -- it touches the pair, the idempotency guard, the
filters, `exitOrderId`/`openOrderIds`, and never the ladder or the DCA position.
So the unification is a type widening (`GridConfig` -> `BotConfigBase`) plus a
public entry point, not a new sell path. That is the whole point of the brief's
"a future dashboard button doesn't need to know which strategy it's talking to":
there is now exactly one place a position is liquidated, and both strategies and
both trigger reasons (grid's automatic stop-loss, the human's deliberate call)
go through it.

*A separate DCA liquidation sell -- rejected.* It would have duplicated the
marketable-limit construction, the three-way outcome handling (throttle /
transport / refusal), and the alert taxonomy, and the two would have drifted the
first time one was touched.

**2. A DCA liquidation is distinguished from a take-profit by an explicit
`exitKind`, not by inferring it from status. (My call, not asked.)**

This is the one place the reuse was not free. Both a take-profit sell and a
liquidation sell set `exitOrderId`, and DCA's `#applyFillToOrder` routed EVERY
fully-filled exit into `#completeCycle` -- which zeroes the position and then
either auto-restarts a fresh cycle or halts with `take_profit_reached` (section
6.3 step 6). That is exactly wrong for a human liquidation of an already-halted
bot: it must stay halted, and there is no cycle to complete or restart. So a
liquidation fill now routes to `#completeLiquidation`, which records the
realized proceeds -- a loss, quite possibly, and recorded honestly rather than
hidden, since a liquidation is often a deliberate cut -- and leaves the bot
halted, capital reservation untouched (releasing it is a `close`, a separate
human decision).

The fork: I could have branched on `state.status` (a take-profit only happens
while `running`, a liquidation only while `halted`), avoiding a new field. I
chose the explicit marker instead, following this log's repeated finding that
status-implied behaviour is the kind of coupling that breaks silently when a
future change moves where status is set (step 6's decision 2 inverted the halt
ordering; step 3.1's decision 3 is a whole entry about a value that type-checked
while meaning the wrong thing). `exitKind` is optional and read as `take_profit`
when absent, so it is additive to stored state with no schema-version bump --
the same treatment grid's `ladder?` got at step 9. Grid needs none of this: its
exit-fill folds into the ladder and stays halted for every reason, so it ignores
`exitKind` entirely.

**3. The held position is refused to a RUNNING bot, per the brief.**

`liquidatePosition` throws `invalid_status` unless the bot is halted. Selling a
position out from under a bot that is still placing orders would race its own
logic -- grid's replace-on-fill is about to sell that base again a level up; DCA
still intends to manage it toward take-profit. A human must halt first, itself
an explicit act. This is the single bound on the brief's "callable regardless of
why it is halted": any halt reason qualifies (stop-loss, manual, breaker, error,
the kill switch itself), because `running` is not a halt.

**4. A human liquidation fetches a FRESH price; it does not reuse the last one.
(My call, not asked.)**

Grid's stop-loss liquidation is driven by a price event and prices the
marketable limit at that event's price. A human liquidation has no such event,
so the price is fetched via `getCurrentPrice` at risk-exit priority. If that
read fails, section 5.6 governs: nothing is sold, the position is left held on
the halted bot, and it is alerted (`liquidation_no_price`, critical). The
last-seen `lastPrice` is deliberately NOT a fallback -- a limit priced off a
stale tick may not be marketable, which defeats the point of pricing it at
"current price" at all. This is a decision, not an ambiguity: the brief says
"marketable limit order at current price", and the current price is the one the
exchange reports now, not the one it reported whenever the bot last heard.

**5. The global kill switch requires a HUMAN actor to TRIP, not only to reset.
(My call, not asked.)**

The account breaker (step 7) accepts any actor on a trip, because
`reconciliation` trips it on section 9's severe drift. The global switch has no
such automated trigger: section 7.4 frames it as "a single dashboard control ...
for use in a genuine emergency", human by construction. So both the trip and the
reset refuse `system`/`ci`/`cron`/`reconciliation`. The fork is real -- a kill
switch is arguably the one control you might want an automated catastrophe
detector to pull -- and I came down on human-only because no such detector is
specified and the spec's own framing is a manual control. It is recorded as
revisitable in the module header: if a global-safety trigger is ever specified,
relaxing the trip guard is a one-line change and the sweep already takes its
actor as a string.

**6. A separate table, not a sentinel row in `circuit_breakers`.**

The brief wants the switch to have "its own record of globally tripped, separate
from any single account's breaker", so that resetting one account's breaker
cannot clear the global switch and vice versa. A reserved-`account_label`
sentinel row in `circuit_breakers` would have collided with the account
namespace and quietly changed what `assertAccountArmed` reads. `global_kill_switch`
is one row (`CHECK (id = 1)`), latching in the same D1-not-KV way and for the
same reason as migration 0003 (a create-blocking check that can read a stale
"armed" seconds after a global stop is a hole in the one control that exists for
an emergency). The two latches are genuinely independent: `create` and `resume`
assert BOTH armed, tested directly (`kill-switch.test.ts`'s "independence"
block: a global trip writes no `circuit_breakers` row, and each resets without
touching the other).

**7. Both create/resume guards are two calls, global first.**

`assertGlobalArmed` then `assertAccountArmed`, at each of the three sites. Global
first because it is the broader condition and the more urgent message. I did not
fold them into one combined helper: the two are genuinely separate controls with
separate error codes (`globally_tripped` vs `account_tripped`), and a caller --
eventually the dashboard -- will want to tell a user *which* latch blocked them.

**8. The env wrappers exist, but nothing calls them yet, and that is correct for
this session.**

`tripGlobalKillSwitchFromEnv` builds the real halt port from the `BOT_INSTANCE`
namespace exactly as the reconciliation worker does, with the same
no-binding/no-schema clean refusals. It is the callable seam, tested end to end
against real Durable Objects. But no HTTP route or UI invokes it: that is the
dashboard (step 10), gated behind Cloudflare Access (step 11), both explicitly
out of scope here. So the control is complete and exercisable from code, and has
no trigger surface a person can reach until those are built -- stated plainly so
it is not mistaken for finished.

### Deviations from the spec

- **Section 7.4 says "a single dashboard control".** The control is built; the
  dashboard is not (step 10). What exists is the backend it will call.
- **Section 6.3 step 5's `sellOnStopLoss` remains refused** (step 6, decision
  14). This session does NOT implement it -- `liquidatePosition` is a human
  action, not a config flag that fires on its own. The gap that refusal leaves
  (a DCA bot halts at a stop-loss holding its position) is now closable by a
  human, deliberately, which is precisely what section 6.3 step 5 asks for: an
  auto-sell at a loss must be "an explicit, configured behavior the account
  owner has chosen", and a human clicking liquidate is more explicit than a
  config field, not less.
- **`exitKind` is a new field on Durable Object runtime state**, additive and
  optional, no schema-version bump (decision 2). It is DO storage, not a D1
  column, so it touches no migration.

### Open questions carried forward

Still open and unchanged from earlier steps: nothing has ever made a real
exchange call (8.1); the money/rate-limit caveats of the section 17 amendments;
the production allow-list is empty (4.1.2); whose funds are at risk (4.1.1).

New:

1. **A human liquidation's marketable limit can fail to fill, exactly as grid's
   stop-loss can** (step 9, open question 1, now shared by both paths). On a
   fast drop the limit rests unfilled and the position stays held on the halted
   bot, alerted, not pretended away. This inherits grid's honest limit of a
   market-order-free close, and it is verified only against the mock: the fill
   behaviour against a real book is a section 17 testnet observation, and now
   there are two callers of it to watch, not one.

2. **A DCA liquidation that PARTIALLY fills does not decrement the position
   until it fully fills**, matching DCA's take-profit semantics exactly
   (`#completeCycle` and `#completeLiquidation` both act only on a full fill).
   Grid's `#applyGridExitFill` decrements per partial fill; DCA does not. The
   position therefore overstates what the bot holds between a partial exit fill
   and the full one, with the resting sell accounting for the difference, and
   reconciliation owns any discrepancy. Consistent with what was already there,
   but it is a real asymmetry between the two strategies' exit-fill handling and
   is recorded rather than smoothed over.

3. **Nothing reaches `tripGlobalKillSwitchFromEnv` yet** (decision 8). The
   control has no human-reachable trigger until the dashboard and Access exist.
   Its correctness is a claim about the code and its tests, not about a button
   anyone has pressed.

4. **The global sweep reads every active bot in one query and halts them
   serially over RPC.** For the account breaker this was step 7's shape and step
   8/9's serial-cancellation caveat applies per bot; across every account at
   once the fan-out is larger. It is failure-tolerant (one unreachable bot does
   not stop the rest) and idempotent (a repeat re-sweeps), but on a large
   deployment a single pull is N sequential halts. Acceptable for v1's single
   user and small bot count; worth revisiting if that grows.

## Step 10.4: Dashboard backend API — REST endpoints and Access JWT verification
Date: 2026-07-23

The backend half of spec step 10 (the dashboard): the HTTP API the React
frontend will call, and the Cloudflare Access verification (section 11) in front
of it. Backend only — no React, no styling, no WebSocket/real-time (the frontend
polls next session). Thirteen endpoints, every one a thin wrapper over
functionality built in earlier steps; the only genuinely new logic is the JWT
verification and the JSON envelope. 1093 tests, up from 1041; typecheck clean.

Everything lives in a new `/src/api` folder that takes its dependencies as
parameters, with `handleApiRequest` as the one binding-aware entry the Worker
calls for `/api/*`. Same shape as `/src/reconciliation` + `/src/workers`: the
decisions are testable without a live environment, the wiring is thin.

### Three questions asked before writing anything

The brief said to stop and ask on any ambiguity about endpoint shape, the JWT
approach, or response format rather than guess. Three were worth asking:

1. **Where the Access team domain comes from.** `ACCESS_AUD` was named in the
   brief, but verifying a JWT also needs the issuer and the JWKS URL, which
   derive from the Zero Trust team domain, and only the account owner has it.
   Answer: a non-secret `ACCESS_TEAM_DOMAIN` var in wrangler.jsonc (the AUD tag
   stays a secret; the domain is not sensitive).
2. **How money is serialized.** Answer: decimal strings, not JS numbers — real
   money must not lose precision past 2^53 or on fractional cents.
3. **Whether to require the JWT `email` claim to equal the
   `Cf-Access-Authenticated-User-Email` header.** Answer: yes, require the
   match. The two Access-provided values cannot be allowed to disagree.

### What was built

- `src/api/access.ts`: Access JWT verification with the Web Crypto API — no
  library, no `nodejs_compat` (section 2). Verifies the RS256 signature against
  Cloudflare's JWKS, checks `aud`/`iss`/`exp`/`nbf`, and requires the email
  header to match the verified `email` claim. Fails closed (503) if `ACCESS_AUD`
  or `ACCESS_TEAM_DOMAIN` is unset.
- `src/api/{envelope,serialize,router,handlers,index}.ts`: the envelope
  (`{ data, error }`) and its error→status map; money→decimal-string and
  camelCase row views; a dependency-free path router; the thirteen handlers; and
  `handleApiRequest` (authenticate → route → dispatch in one try/catch).
- `src/workers/api.ts`: `/api/*` delegated to `handleApiRequest`; `/health` kept
  byte-for-byte, plus an unauthenticated `/api/health` alias.
- Config: `ACCESS_TEAM_DOMAIN` var added to both environments (empty, fail
  closed, with an instruction to set it); `ACCESS_AUD`/`ACCESS_TEAM_DOMAIN` typed
  via a `declare global` in access.ts (the DISCORD_WEBHOOK_URL pattern) and
  supplied to tests via vitest.config.ts.
- Tests: `access.test.ts` (real Web Crypto signatures — a valid one accepted, a
  tampered/expired/wrong-aud/wrong-issuer/unknown-kid/none-alg one rejected, plus
  the email-mismatch guard); `api.test.ts` (every endpoint end to end against
  real D1 and real Durable Objects, only the exchange mocked, auth exercised on
  live routes); `router.test.ts`.

### Decisions made

**1. Every handler wraps an existing call; the layer adds no business logic.**

A create goes through `BotInstance.create`/`createGrid`, which already run
section 8.5's capital-ledger check and the mandatory stop-loss/take-profit
validation — so "validate against the capital ledger, reuse the existing check,
don't duplicate its logic" is satisfied by *not reimplementing it*: the handler
decodes the body and calls in, and `insufficient_capital`/`invalid_parameter`
surface as the modules' own typed errors. Likewise liquidate → `liquidatePosition`
(step 10.3, including its running-bot rejection verbatim), the breaker/kill-switch
resets → the same human-only resets, reconciliation → the `audit_log` entries
runs already write.

**2. The error code is the contract; the envelope maps it to a status.**

The wrapped modules already throw typed codes. `envelope.ts` carries the code
through verbatim (`insufficient_capital`, `invalid_status`, `globally_tripped`,
…) and maps it to an HTTP status in one table, so the frontend branches on a
code, not on prose, and a handler only ever `throw`s. An error with no `.code`
is a 500 with a generic message — an unreasoned error's text is not echoed.

**3. `GET /api/bots` reads each bot's Durable Object, N times.**

Status, strategy and allocation are authoritative in D1 (mirrored on every
transition), but the live position and realized profit are the object's own
(section 8.1) and are not fully mirrored. So the list is one DO snapshot per bot,
run in parallel. This is the same per-bot fan-out the kill switch and circuit
breaker already accept, and fine at v1's bot count; a large deployment would want
the position mirrored to D1 instead. Recorded, not hidden.

**4. Money is the canonical fixed-precision decimal string, verbose and all.**

`toDecimalString`, so allocated capital is `"500.00000000"`, not `"500"`. It is
exact, always the same shape, and matches how `audit_log` details are already
written — one money format across the system. The prettier `toTrimmedString`
exists but a fixed-precision contract is the safer one for the frontend to parse.

**5. `/health` is unchanged and outside the auth surface; `/api/health` is an
alias.**

The brief listed the health check as `/api/health`; the endpoint that exists is
`/health`. Rather than move a contract other things may already probe, `/health`
is kept byte-for-byte and `/api/health` added as an alias returning the same
payload. Both are unauthenticated on purpose — post-deploy verification (section
16.1 step 6) reads the version and environment without a dashboard session, so
putting health behind the JWT gate would break exactly the check it exists for.

**6. The verifier fails closed, and the team domain ships empty.**

`ACCESS_TEAM_DOMAIN` is committed as `""` in both environments with an
instruction to set it. Until it (and the `ACCESS_AUD` secret) exist, every
`/api/*` request is refused with a 503 rather than falling back to trusting the
email header. An empty config value is not a committed placeholder resource id
(step 4, decision 1) — it is a deliberate blank that makes the safe state the
default state. The account owner must set the domain and put the secret before
the API answers anything.

**7. JWKS is cached per isolate, refetched once on an unknown `kid`.**

Access rotates signing keys rarely, so the key set is cached in module state and
a `kid` miss triggers a single forced refetch before the token is rejected as
`access_unknown_key`. The cache and the fetcher are injectable, which is what
lets the tests sign their own tokens and serve their own key with no network.

### Deviations from the spec

- **Section 7.4 "a single dashboard control" and step 10's dashboard form remain
  unbuilt as UI.** This is the backend they call. `POST /api/kill-switch/trigger`
  and the create/liquidate/reset endpoints exist and are tested; the buttons do
  not.
- **The brief says create "requires stop-loss and take-profit".** For DCA both
  are mandatory and enforced (decode + `validateDcaParams`). For **grid**,
  section 6.1 makes take-profit only *recommended*, and a grid's take-profit is
  an optional accumulated-profit *amount*, not a percentage — so the grid create
  requires a stop-loss and leaves `takeProfitAmount` optional, deferring to the
  existing validation rather than adding a stricter rule the spec does not want.
  The brief's wording is the general DCA case; grid genuinely differs, as it does
  throughout.
- **`POST /api/bots/:id/liquidate` cannot actually sell in either deployed
  environment yet.** `liquidatePosition` fetches a current price, which needs an
  exchange client, and none exists (step 4.1: whose account is undecided). So in
  testnet/production the endpoint returns `not_attached` (503) until credentials
  are wired — the same project-wide gap as everything else that touches the
  exchange. It is verified here only against the mocked exchange, exactly as
  section 14 prescribes; the endpoint is correct, the exchange behind it is
  absent.

### Open questions carried forward

Still open and unchanged: nothing has ever made a real exchange call (8.1); the
money/rate-limit and alert-delivery caveats of the section 17 amendments; the
production allow-list is empty and whose funds are at risk is unsettled (4.1);
the daily-loss circuit-breaker trigger (section 7.3) is unbuilt.

New:

1. **The Access verifier has never seen a real Cloudflare token.** Every test
   signs with a key this suite minted and serves it through an injected JWKS, so
   what is proven is that the RS256 verification, the claim checks and the
   email-match are correct against tokens shaped like Access's — not that they
   match a token Access actually issues, nor that `ACCESS_TEAM_DOMAIN` and
   `ACCESS_AUD` are set to the right values. That is a testnet observation once
   Access is configured (step 11): log in for real and confirm a genuine token
   verifies and a request without one is refused. Until then, "the JWT check
   works" is a claim about the code, the same shape of caveat as the rate
   limiter and the alert path before them.

2. **`GET /api/bots` is N Durable Object reads per call** (decision 3). Fine now;
   a candidate for mirroring position/PnL to D1 if the bot count grows.

3. **Error paths through a real Durable Object log an "uncaught (in promise)"
   line to stderr.** When the object throws across RPC (insufficient capital, a
   running-bot liquidation), the rejection is caught by `handleApiRequest` and
   returned as the right 4xx, but the runtime still logs the crossing. Cosmetic,
   present in the reconciliation/kill-switch tests too, and not worth suppressing
   by swallowing errors closer to the object.

4. **The kill-switch trigger/reset endpoints build their own database and
   namespace from `env`** (via `tripGlobalKillSwitchFromEnv`), ignoring any `db`
   injected into `handleApiRequest`. Harmless — both point at the same bindings —
   but it means those two endpoints are not reroutable to an alternate database
   the way the others are. Consistent with how step 10.3 built those seams.
