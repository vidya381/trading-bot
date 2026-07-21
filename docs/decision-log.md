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

`migrations/0001_initial_schema.sql`: the eight tables of section 8.2, plus 18
indexes. Every table `STRICT`; every money column `INTEGER`.

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
