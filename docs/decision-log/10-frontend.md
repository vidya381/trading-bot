## Step 10.6: Dashboard frontend — scaffolding, status strip, and bot list
Date: 2026-07-23

The first UI of the project, the front half of spec step 10, built on the
backend API of steps 10.3–10.5. Deliberately narrow scope: project scaffolding,
the environment banner, the status strip, and the bot list, reading real data
from `GET /api/bots` and `GET /api/alerts` by polling. Explicitly NOT built this
session (each a follow-up): the bot detail view, the create-bot form, the alert
feed UI, the manual-adjustment form, and the kill-switch / liquidate controls.

Everything lives in `/dashboard`, previously a placeholder folder, now a React +
Vite + TypeScript app with its own toolchain (Tailwind v4, react-router),
separate from the Worker's, as step 1's decision 2 always intended. The dashboard
build typechecks and builds clean; the backend's 1098 tests still pass unchanged
after the `wrangler.jsonc` change below.

I was asked to stop and ask if the Tailwind setup or the static-assets binding
approach was ambiguous. Neither was, once checked against the installed tooling
rather than memory (decision 1), so I proceeded. The one thing the brief told me
to verify before committing to it — that serving the frontend from the same
Worker is straightforward on this Wrangler — is decision 1, and it is.

### What was built

- `dashboard/` toolchain: `package.json` (own deps, TS 5.7 not the Worker's TS
  7 — decision 3), `vite.config.ts`, three `tsconfig` files, `index.html`.
- `src/env.ts`: the build-time `ENVIRONMENT` constant (decision 2).
- `src/api/`: `types.ts` (the `Bot`/`Alert`/envelope shapes mirrored from
  `src/api/serialize.ts`), `client.ts` (same-origin fetch + envelope unwrap into
  a typed `ApiError`), `usePolling.ts` (a 5s poll that keeps last-good data).
- `src/components/`: `EnvironmentBanner`, `StatusStrip`, `StatusBadge`,
  `BotList` (a real `<table>` at `md`+, stacked cards below, one dataset).
- `src/pages/`: `Dashboard` (owns the polling, feeds strip + list) and
  `BotDetailPlaceholder` (the `/bots/:id` landing site for next session).
- `src/App.tsx` + `main.tsx`: the banner-outside-router shell and the routes.
- `wrangler.jsonc`: an `assets` block under BOTH environments (decision 1).
- `package.json` (root): `build:dashboard:{testnet,production}` and reworked
  `deploy:*` scripts that build the dashboard, with the environment baked in,
  before `wrangler deploy` (decision 10).

### Decisions made

**1. The frontend is served as static assets from the SAME Worker as `/api/*`,
via `run_worker_first`, not a separate Pages project.** *(the brief's deploy
question; confirmed straightforward before committing)*

The brief asked me to confirm this is clean on the current Wrangler (4.112.0)
before committing, and to propose the alternative if it is genuinely awkward. It
is clean. The installed `node_modules/wrangler/config-schema.json` shows
`assets.run_worker_first` accepts an ARRAY of route globs (not only a boolean),
so:

```jsonc
"assets": {
  "directory": "./dashboard/dist",
  "not_found_handling": "single-page-application",
  "run_worker_first": ["/api/*", "/health"]
}
```

routes `/api/*` and `/health` to the Worker's own fetch handler and serves every
other path from `dist/`, with SPA fallback to `index.html` so client-side routes
deep-link. One deployment per environment, one Worker, consistent with the rest
of the project. Declared under BOTH envs because binding keys are
non-inheritable (step 1, decision 1) — the same reasoning the two `database_id`s
already follow. Verified with `wrangler deploy --dry-run --env testnet` and
`--env production`: both read the 4-file assets directory and resolve every
binding. `src/workers/api.ts` was left BYTE-FOR-BYTE unchanged — the Worker
already 404s non-`/api/`, non-`/health` paths, and now simply never sees them.

*A separate Cloudflare Pages project — rejected.* It would be a second
deployment target, a second Access application to configure per environment, and
a second place the environment-to-URL mapping could drift. The brief preferred
one deployment per environment "consistent with everything else built so far",
and the config supports it with no contortion.

*Revisit if:* a future need to serve the dashboard and the API from genuinely
different origins appears (none is foreseen). The routing is validated by config
and dry-run this session, not yet by a live request against a deployed Access-
gated origin — that is a step-11 observation, the same shape of caveat the JWT
verifier carries (step 10.4, open question 1).

**2. The environment is baked in at BUILD time (`VITE_ENVIRONMENT`), never
detected at runtime.**

Section 11.3 requires the banner be driven by "a value baked in at deploy time,
not a runtime toggle, so it can never be wrong due to a runtime bug." So
`src/env.ts` reads `import.meta.env.VITE_ENVIRONMENT`, which Vite statically
inlines at build — confirmed by grepping the built bundle: the string
`VITE_ENVIRONMENT` does not appear in `dist` at all, and `"TESTNET — NOT REAL
MONEY"` does. There is no fetch, no host-sniffing, no `/health` read feeding the
banner. A testnet build cannot render a production banner because the value is a
compile-time constant, not a decision made in the browser.

The two real builds set it explicitly (`build:dashboard:testnet` /
`:production`). An unset value — a plain `vite dev` — resolves to `development`
and renders a distinct violet "LOCAL DEVELOPMENT" bar, so a local look is never
mistaken for a deployed environment either. Production's bar is deliberately
slim and neutral (present, so the environment is always labelled, but
undramatic); testnet's is the loud amber one, because testnet is the environment
one deploy away from real money.

*Reading the environment from `/health` at runtime — rejected outright.* It is
exactly what section 11.3 forbids: a runtime fetch that a bug, a cache, or a
proxy could make wrong, on the one indicator whose entire job is to be
trustworthy.

**3. The dashboard pins TypeScript 5.7, not the Worker's TypeScript 7.**

The Worker toolchain runs TS 7.0.2 (step 1). The React/Vite plugin ecosystem
targets the TS 5.x line, so the dashboard keeps its own `typescript` at ^5.7 in
its own `package.json`. This is the concrete payoff of step 1's decision 2 (the
dashboard has its own toolchain): the two can move independently, and a frontend
dependency that is not ready for TS 7 does not hold back the backend or vice
versa.

**4. Money stays a decimal string end to end; display trims cosmetically, never
parses to a float.**

The backend renders every money field as an exact decimal string precisely to
avoid float precision loss (step 10.4, decision 4). The frontend honours that:
`types.ts` types every money field as `string`, and `format.ts`'s `trimDecimal`
/ `signOf` operate on the string (drop trailing zeros, test for a sign) without
ever constructing a `Number`. No `parseFloat` exists in the codebase. A balance
past 2^53 or a fractional cent survives to the screen intact.

**5. Polling keeps LAST-GOOD data through a transient failure and reports the
error beside it, rather than blanking.**

`usePolling` fetches once immediately, then every 5s (brief item 7; no
WebSockets, the deliberate simplification decided earlier). On a failed poll it
retains the previous data and surfaces the error as a small "Update failed"
indicator; `loading` is true only until the first load resolves. A 5-second blip
on a money dashboard must not flash the screen empty and imply every bot
vanished. In-flight requests are aborted on unmount and on each new tick, so a
slow response cannot overwrite a newer one. The two endpoints poll
independently, so alerts failing does not blank the bot list.

**6. No auth code; the same-origin Access cookie is the whole mechanism.**

There is no login UI and no token handling (brief item 8). `client.ts` makes
plain same-origin `fetch("/api/...")` calls with `credentials: "same-origin"`;
Cloudflare Access gates the origin and the browser's existing session cookie
rides along. The one Access-aware touch is defensive: if a fetch comes back as
non-JSON with a 401/403 (Access serving a login redirect once a session
expires), `client.ts` surfaces a clear "session expired — reload" error instead
of crashing on a failed JSON parse. Building a login form would duplicate — and
weaken — what Access already does before the app is ever reached.

**7. Row/card navigation to `/bots/:id` is wired now, to a placeholder.**

Every table row and mobile card is a react-router `<Link>` to
`/bots/{id}`, landing on `BotDetailPlaceholder`, which reads and shows the id so
the routing is demonstrably correct and says plainly the view is next session's
work (brief item 6). The next session builds only the destination; the
navigation, the id plumbing, and the SPA deep-link fallback are already done.

**8. Dark theme only, applied directly — no `dark:` variants, no toggle.**

Tailwind v4, configured CSS-first (`@import "tailwindcss"`, no `tailwind.config`
file, no PostCSS). Because there is exactly one theme (the decided dark-only), a
component uses dark palette utilities (`bg-zinc-900`, `text-zinc-100`) directly
rather than `dark:` variants that would imply a light mode that does not exist.
`color-scheme: dark` is set so native form controls and scrollbars match.

**9. The P&L column is labelled "Realized (gross)", following the backend's own
honesty.**

The backend deliberately names the field `realizedGross` and refuses to call it
"pnl" because it is gross of fees (step 10.4 / serialize.ts). The UI shows it
under an equally honest label rather than the brief's shorthand "PnL", so the
number on screen does not claim to be net profit. Sign colouring (green/red/
zinc) is by the string's sign.

**10. The deploy scripts build the dashboard first, per environment.**

`assets.directory` must exist at deploy time, and each environment's `dist` must
have that environment's banner baked in. So `deploy:testnet` is
`build:dashboard:testnet && wrangler deploy --env testnet` (and likewise
production), where the build script sets `VITE_ENVIRONMENT` inline. The two are
inseparable — deploying without rebuilding could ship the wrong environment's
banner, which is the one bug section 11.3 exists to prevent — so they live in
one script rather than as two things a person must remember to run in order.

### Deviations from the spec

- **Section 11.3 says the banner is driven by "the `ENVIRONMENT` variable".**
  On the backend that is the Worker `var` (`env.ENVIRONMENT`); the frontend
  cannot read a Worker var at runtime, and section 11.3 is emphatic the value be
  baked in at build, not read at runtime. So the frontend uses its own
  build-time `VITE_ENVIRONMENT`, set from the same environment name. Same value,
  same guarantee, honouring the "not a runtime toggle" clause literally rather
  than the variable's name.
- **Section 11.3's "one deployment per environment, each with its own URL and
  Access policy" is now half-real.** The build and serving are per-environment
  and the config is in place; the actual second Access application and the
  allow-lists are step 11, unbuilt. What exists is one Worker per environment
  that will serve its own dashboard behind its own Access app once configured.
- **The spec's step 10 bundles the dashboard as one step.** It is being built in
  halves — backend (10.3–10.5), then this UI slice, with the remaining forms and
  controls as named follow-ups — matching the project's one-slice-per-session
  cadence rather than landing all of step 10 at once.

### Open questions carried forward

Still open and unchanged: nothing has ever made a real exchange call (8.1); the
money/rate-limit and alert-delivery caveats of the section 17 amendments; the
production allow-list is empty and whose funds are at risk is unsettled (4.1);
the daily-loss circuit-breaker trigger (section 7.3) is unbuilt; the Access
verifier has never seen a real Cloudflare token (10.4, open question 1).

New:

1. **The static-asset routing is validated by config and `--dry-run`, not by a
   live request.** `run_worker_first: ["/api/*", "/health"]` resolves and both
   environments' dry-runs read the assets directory, but no deployed request has
   yet confirmed that `/api/*` reaches the Worker while `/bots/:id` serves
   `index.html` through the Access gate. That is a step-11 observation once an
   Access app fronts a real deploy — the same "claim about the code, not the
   wire" shape as the JWT verifier and the alert path before it.

2. **The dashboard consumes the API contract but shares no types with it.**
   `dashboard/src/api/types.ts` is hand-mirrored from `src/api/serialize.ts`.
   The two are separate toolchains (decision 3), so a backend field rename would
   not fail the dashboard's typecheck — it would surface as a runtime `undefined`
   in the UI. Acceptable at this size; a shared generated contract is the fix if
   the surface grows.

3. **A local look shows chrome, not populated data.** `/api/*` is Access-gated,
   so `vite dev` against a local `wrangler dev` renders the banner, strip and
   empty/error states but no real bots unless the caller has a session and the
   local D1 has schema. Populated data needs the deployed, Access-gated origin.
   Expected, and stated in the dashboard README rather than papered over with a
   mock-data mode (which the brief's scope excludes).

## Step 10.8: Dashboard frontend — bot detail view
Date: 2026-07-23

The destination for the `/bots/:id` links step 10.6 wired. Read-only: a
summary, the strategy-specific state, and this bot's order/trade/alert history,
polling `GET /api/bots/:id` every 5s. Explicitly NOT built this session (each a
named later session): the liquidate button and its confirmation dialog, the
kill-switch controls, the create-bot form, the global alert-feed page, the
manual-adjustment form. The dashboard typechecks and builds clean; the backend
was not touched, so its 1098 tests are unaffected.

I was told to stop and ask only if `GET /api/bots/:id`'s response shape was
ambiguous for either strategy. It was not — I read it from source rather than
guessing: `botDetail` in `src/api/serialize.ts` spreads `botSummary` and adds
`config`/`state` (the `DcaConfig | GridConfig` union and `BotRuntimeState`,
deep-rendered by `jsonSafe` so every Money bigint is a decimal string and every
count/flag/timestamp keeps its native type) plus the D1 `orders`/`trades`/
`alerts` row views. The strategy shapes came from `src/strategies/{dca,grid}.ts`
(`DcaPosition`/`DcaEntry`/`DcaParams`, `GridLadder`/`GridSlot`/`GridParams`) and
`BotRuntimeState` from `src/durable-objects/bot-instance.ts`. So I proceeded
without asking.

### What was built

- `dashboard/src/api/types.ts`: the detail contract mirrored from the backend —
  `Order`, `Trade`, `DcaPosition`/`DcaEntry`/`DcaParams`,
  `GridLadder`/`GridSlot`/`GridParams`, `BotConfig` (discriminated union),
  `BotRuntimeState`, and `BotDetail extends Bot`. Money is `string` throughout,
  honouring the backend's decimal-string contract.
- `dashboard/src/api/client.ts`: `fetchBot(id)`.
- `dashboard/src/format.ts`: `compareDecimal(a, b)` — a float-free numeric
  comparison of two decimal strings (integer and fractional parts as `BigInt`),
  used only to position the current-price divider in the grid ladder.
- `dashboard/src/pages/BotDetail.tsx`: the page. Owns the poll, orders the view
  (summary → strategy state → orders → trades → alerts), and renders the honest
  failure states. The inner view is keyed by id so navigating between bots
  re-polls from scratch.
- Components: `BotSummary` (shared stat cards), `StrategyState` (the
  dispatcher), `GridLadderView`, `DcaPositionView`, `HistoryTable` (generic),
  `OrderHistory`, `TradeHistory`, `AlertList`, `SideBadge` (extracted so the
  ladder and the order table colour a side identically).
- `dashboard/src/App.tsx`: the `/bots/:id` route now renders `BotDetail`;
  `BotDetailPlaceholder.tsx` (step 10.6's landing stub) was deleted.

### Decisions made

**1. Grid and DCA state are rendered by two separate components, dispatched by
`config.strategy` — the authoritative discriminator, not the presence of a state
field.** *(the brief's central "how are you sharing or separating" question)*

`StrategyState` switches on `config.strategy` and renders `GridLadderView` or
`DcaPositionView`. This follows `BotRuntimeState`'s own note that
`config.strategy` is authoritative and `ladder?`/`position` presence is not: a
DCA bot leaves `ladder` absent and a grid bot leaves `position` at
`EMPTY_POSITION`, so branching on a field's presence would be the exact
status-implied coupling step 10.3's decision 2 and step 6's decision 2 warn
against. The two views take genuinely different data — an index-aligned ladder of
resting price levels versus a list of executed buys with a running average — so
forcing them into one shared shape would be a lie about the data. They are
separated where they differ.

*Where the data genuinely matches, it IS shared*, which is the other half of the
brief's instruction: `BotSummary` (identity + stat cards) reads only the
strategy-agnostic summary fields and `state.lastPrice`, so both strategies use
it unchanged; the order/trade/alert histories are identical D1 row shapes for
both strategies, so orders and trades run through ONE generic `HistoryTable`
(the responsive table-at-`md`/cards-below container written once, columns
supplied per caller) and share `SideBadge`. Share where the shape matches,
separate where it does not.

**2. The current price breaks the ladder with a float-free comparison.** The
grid brief wants "sells above, buys below" made visual by the current price
(section 6.2). `GridLadderView` pairs each `level` with its index-aligned `slot`,
sorts the pairs descending by price, and inserts a divider before the first rung
below `state.lastPrice`; rungs at/above the price carry a faint sell tint, below
a buy tint, so even orderless levels read as their zone. A resting order's own
side is shown as a badge where one exists, and "no order" where the slot is
`null` — the honest per-level fact, not an inferred one. The comparison uses the
new `compareDecimal`, not `Number()`: money precision is the whole reason the
backend speaks decimal strings (step 10.4, decision 4; step 10.6, decision 4),
and the frontend has no `parseFloat` anywhere — extending that discipline to a
comparison rather than breaking it for a divider position.

**3. DCA shows every entry, the running average, and buys remaining — computed,
not re-derived.** `DcaPositionView` renders `position.entries` in fill order
(base first, so the averaging progression reads top-down), the stored
`averageEntryPrice` (which the backend stores rather than recomputes, DCA
decision), and `maxAdditionalBuys - additionalBuysUsed` for buys remaining —
both fields exclude the base order, so the difference is exactly "how many buys
remain before the configured maximum" the brief asks for.

**4. The failure states are honest and distinct (brief item 6), keyed off the
backend's typed error code, not prose.** `LoadError` branches on
`ApiError.code`: `unknown_bot` (404) says the bot does not exist and echoes the
id; `no_schema` (503, production pre-go-live — the guard step 10.5 added) shows
the same honest "no schema yet, deferred to go-live" message pattern the list
uses; `unauthenticated` says the Access session expired. Anything else is the
generic bordered error with the session-expiry hint, matching `Dashboard`'s hard
error. None renders a blank or broken page. This reuses the `error.code`
contract step 10.4 decision 2 established end to end.

**5. `usePolling`, unchanged, keyed by id.** The detail view polls with the same
hook and 5s interval as the list (brief item 1), keeping last-good data through a
transient blip and surfacing "Update failed" beside it rather than blanking a
money screen (step 10.6, decision 5). Because `usePolling` deliberately does not
restart its interval when the fetcher identity changes, navigating between two
bots on the same route would otherwise show the previous bot for up to 5s; the
inner view is `key`ed by id so react-router remounts it and the immediate fetch
fires at once.

**6. Detail views carry density and stack vertically (brief item 7).** The
summary and strategy state stack at every width; only the order/trade histories
fall back to cards below `md`, consistent with the list's responsive pattern and
the earlier decision that detail views need not simplify to cards the way the
list does.

### Deviations from the spec

- **Section 7.4's "single dashboard control" and the liquidate button remain
  unbuilt as UI**, deliberately — this session is read-only. The backend they
  call exists (step 10.3/10.4); the controls are the next session.
- **The dashboard still mirrors the API contract by hand** (step 10.6, open
  question 2). This session added more mirrored types (`Order`, `Trade`, the
  config/state shapes) from `src/api/serialize.ts` and the strategy modules; a
  backend field rename would surface as a runtime `undefined`, not a failed
  dashboard typecheck. Acceptable at this size, same caveat as before.

### Open questions carried forward

Still open and unchanged: nothing has ever made a real exchange call (8.1); the
money/rate-limit and alert-delivery caveats of the section 17 amendments; the
production allow-list is empty and whose funds are at risk is unsettled (4.1);
the daily-loss circuit-breaker trigger (7.3) is unbuilt; the Access verifier has
never seen a real Cloudflare token (10.4, open question 1); the static-asset
routing and populated data are validated only by config/dry-run, not a live
Access-gated request (10.6, open questions 1 and 3).

New:

1. **The detail view is verified by typecheck and build, not by a live request
   against a deployed, Access-gated origin.** Same shape of caveat as the list
   (step 10.6): the components render the real contract, but no deployed request
   has confirmed a real bot's ladder or entries render as intended. A step-11
   observation once Access fronts a real deploy with schema and data.
2. **The current-price divider assumes `lastPrice` and the ladder levels share
   the money module's scale-8 decimal shape.** They do — both come from
   `toDecimalString` — and `compareDecimal` is scale-agnostic anyway (it pads
   fractional parts), so this is noted rather than a risk. When `lastPrice` is
   null (a bot that has not yet received a price) the ladder renders with no
   divider and no zone tint, which is the honest state.

## Step 10.9: Dashboard frontend — liquidate action on the bot detail view
Date: 2026-07-23

The first WRITE control the dashboard exposes: a liquidate button on the
otherwise read-only bot detail view (step 10.8), calling `POST
/api/bots/:id/liquidate` — the unified human close-out built at step 10.3 and
wrapped as an endpoint at step 10.4. Nothing else was built: no global kill
switch (a separate session, a different part of the app), no create-bot form,
no alert feed, no manual-adjustment form. Frontend only; the backend was not
touched, so its 1098 tests are unaffected. The dashboard typechecks and builds
clean.

I was told to stop and ask only if the exact shape of a failure response was
ambiguous. It was not — I read every outcome from source (`liquidatePosition`
in `bot-instance.ts`, the `liquidateBot` handler and `STATUS_BY_CODE` in
`src/api/{handlers,envelope}.ts`) rather than guessing, and the one non-obvious
shape (below, decision 1) is a fact in the code, not a judgement call. So I
proceeded without asking.

### What was built

- `dashboard/src/components/LiquidateAction.tsx`: the button, its confirmation
  dialog, the request, and the outcome banner. Owns the whole interaction.
- `dashboard/src/api/client.ts`: `liquidateBot(id)` — a `POST` with no body
  (the backend takes the actor from the verified Access identity); `getJson`
  generalised to `requestJson(path, method)` so the one response-envelope
  handling serves both verbs.
- `dashboard/src/api/types.ts`: `LiquidationResult` (the `PipelineResult`
  mirror) and `LiquidateResponse` (`{ result, bot }`).
- `dashboard/src/api/usePolling.ts`: an additive `refetch()` on the hook's
  return, so a write can force an immediate refresh instead of waiting up to one
  poll interval. The list page ignores it.
- `dashboard/src/pages/BotDetail.tsx`: renders `<LiquidateAction>` after the
  summary, only for a halted bot, wired to `poll.refetch`.

### Decisions made

**1. The price-unusable outcome is a SUCCESS to inspect, not an error to catch —
this is the crux of the failure handling (brief item 3).**

`liquidatePosition` does not throw when it cannot read a current price. It fires
the `liquidation_no_price` critical alert, leaves the position held on the
halted bot (section 5.6: an unreachable exchange is not data), and returns
normally with `{ action: "no_price" }`, which the handler wraps in `ok(...)` —
an HTTP 200. So the four backend outcomes split across two axes, not one:

- **200 + `result.action`:** `"liquidating"` (a marketable limit sell was
  placed — success), `"no_price"` (nothing sold, held, alerted — a warning, not
  a failure), `"nothing_to_liquidate"` (already flat), `"hold"` (an exit order
  was already live — idempotent no-op).
- **thrown `ApiError` by code:** `invalid_status` (409, the bot is no longer
  halted — the exact page-load-to-click race the brief names), `not_attached`
  (503, no exchange wired in this deployed environment — step 10.4's known gap),
  and everything else (network, 500, expired session) as a generic failure.

Each gets its own titled banner with distinct copy; there is no single
"something went wrong". A frontend that only awaited success and caught errors
would have silently treated `no_price` — a position still exposed to the market
— as "done", which is the specific failure this decision exists to prevent.

**2. `"liquidating"` means ATTEMPTED, and the copy says so.** A marketable limit
can still rest unfilled on a fast move, and `#placeLiquidationSell`'s internal
throttle/transport/refusal paths (step 10.3) alert and return without changing
the `"liquidating"` result. So the success message says the order was *placed*
and to watch order history and alerts to confirm it *completed*, rather than
claiming the position is gone. The honest state, matching step 9/10.3's open
question that the fill is a real-book behaviour verified only against the mock.

**3. The button renders only when halted AND holding a position > 0 — my
refinement of brief item 1, not a deviation from it.** The brief says show it
"only when the bot's status is halted"; I additionally hide it when the held
quantity is zero. A halted-but-flat bot has nothing to sell, so offering the
action would contradict item 1's own principle ("if it's not a valid action,
don't render it at all") and item 2's "show the actual amount" (there is no
real amount). `nothing_to_liquidate`/`hold` are still handled as result cases
for the race where the position empties between load and click. The halted gate
lives in `BotDetail`; the position gate lives in `LiquidateAction`, so the
component can still show a lingering outcome banner after a fill drops the
position to zero and hides the button.

**4. The asset shown is derived, honestly, from the pair minus the quote.** The
held amount is in the BASE asset; `capitalAsset` is the QUOTE. Binance symbols
are concatenated base+quote, so `baseAsset("BTCUSDT", "USDT") → "BTC"`, with a
fallback to the raw pair if it does not end in the quote. This is the "real
number in front of them" (item 2) named in its real unit, not "0.5 BTCUSDT".

**5. Immediate refresh only on a successful response (item 4); errors ride the
5s poll.** A success calls `onLiquidated` → `poll.refetch`, so the refreshed
position shows at once. Errors deliberately do NOT force a refetch: the next
poll tick updates the view within 5s anyway, and skipping the forced refetch
keeps the error banner visible rather than having a resumed-bot refetch unmount
the whole control before the message is read.

**6. Plain yes/no confirm, danger-styled — not type-to-confirm (item 6).** The
type-to-confirm pattern is reserved for the global kill switch specifically
(next session), so this dialog is a plain confirm. Weight is carried visually
instead: a red-bordered modal, a solid `red-600` confirm button (the point of
no return), a red-tinted trigger, and an explicit "real, irreversible order
once live funds are involved" line. The confirm button disables and shows a
spinner while in flight, and a `submitting` guard drops a second click, so a
double-click cannot fire two liquidations (item 5).

### Deviations from the spec

- **Section 7.4's global kill switch remains unbuilt as UI**, deliberately —
  it is the next session and touches a different part of the app. This session
  built only the per-bot liquidate control.
- **`POST /api/bots/:id/liquidate` still cannot actually sell in either deployed
  environment** (step 10.4's deviation, unchanged): `liquidatePosition` needs an
  exchange client and none is attached, so both environments return
  `not_attached` (503) until credentials are wired. The UI handles that code
  with its own honest message; it is verified against the mock exchange, exactly
  as section 14 prescribes.
- **The dashboard still mirrors the API contract by hand** (step 10.6/10.8, open
  question): `LiquidationResult`/`LiquidateResponse` were mirrored from
  `bot-instance.ts` and `handlers.ts`. A backend rename would surface as a
  runtime `undefined`, not a failed typecheck. Acceptable at this size.

### Open questions carried forward

Still open and unchanged: nothing has ever made a real exchange call (8.1); the
money/rate-limit and alert-delivery caveats of the section 17 amendments; the
production allow-list is empty and whose funds are at risk is unsettled (4.1);
the daily-loss circuit-breaker trigger (7.3) is unbuilt; the Access verifier has
never seen a real Cloudflare token (10.4, open question 1); the frontend is
validated by typecheck and build, not a live Access-gated request (10.6/10.8).

New:

1. **The liquidate flow has never run against a real deployed origin.** The
   button, the dialog, and all seven outcome branches render the real contract,
   but no Access-gated request has exercised one end to end — and because the
   endpoint returns `not_attached` until an exchange is wired, the only outcome
   reachable in a deployed environment today is the `not_attached` error itself.
   The `liquidating`/`no_price`/`nothing_to_liquidate`/`hold` branches and the
   `invalid_status` race are verified only by reading the backend that produces
   them. A step-11 observation once Access fronts a real deploy with an exchange
   attached.

2. **The `invalid_status` race is handled but hard to actually provoke.** It
   fires only if the bot resumes between page load and the click; the copy tells
   the user and the poll resolves the view. It is coded from the backend's
   guarantee, not from having seen the two events interleave.
