# `/src/research` — groundwork for section 21

Section 21 (LLM-assisted research and bot proposals) is **PLANNED, NOT YET
BUILT**, and that banner still holds. There is no pipeline, no prompt, no
proposal record and no Workers AI call in this folder.

What exists is the storage for **21.3's fixed watchlist**, **all three of 21.4
Stage 1's reads**, and **candidate selection for both of 21.2's entry points** —
the first thing in this folder that consumes the others.

| File | What it is |
| --- | --- |
| `watchlist.ts` | `addToWatchlist` / `removeFromWatchlist` / `readWatchlist`: the deliberate half of candidate selection, over `watchlist` (migration 0008) |
| `tradability.ts` | `checkTradable`: "will this account's venue trade this pair?", asked once and shared by every caller below, plus an **opt-in** naming heuristic for perpetuals; `checkSpotInstrument`: the structural "is it spot?" the order path uses |
| `candles.ts` | `fetchCandleWindow`: 21.4 Stage 1's candle fetch for **any** listed, tradable pair — no bot required — reporting how much history it actually got |
| `news.ts` | `fetchNewsSentiment`: 21.4 Stage 1's news and pre-scored sentiment for one asset, with 21.7 open question 2's coverage distinction built in. **Its wire format is assumed, not verified** — see below |
| `candidates.ts` | `selectNamedCandidate` / `selectGeneralCandidates`: 21.2's two entry points, feeding one `CandidateSet`. **No trending vendor is chosen** — `TrendingSource` is an abstract port with no client behind it |
| `concentration.ts` | `readAccountExposure` + `assessConcentration`: 21.4 Stage 1's third read — what the account already holds on a candidate's pair and asset. **A flag for a human, never a filter**, and its two thresholds are **policy choices verified against nothing** |

## Candidate selection: one shape, two entry points, merged provenance

21.2 says the entry points "differ **only** in how the candidate coin or coins
are chosen", so both functions return the same `CandidateSet` holding the same
`Candidate`. They are kept from converging by their ports rather than by
discipline: `NamedCandidatePorts` has no trending source in it, so the named
path cannot reach a vendor even by mistake.

Deduplication **merges provenance rather than dropping it**. A coin on both the
watchlist and the trending pull is one candidate carrying two sources, and
`Candidate.sources` is a non-empty tuple, so a candidate that came from nowhere
is unrepresentable. 21.5 requirement 2 needs "**which** watchlist entry, or
**which** trending pull, and when" — so the sources carry `entryId` and `pullId`
respectively, plus the vendor's raw item by identity.

**A failed trending pull is fatal, not a fall back to the watchlist.** 21.5
requirement 6 names "the trending source is unreachable" as a fail-closed
condition, and 21.3 says the trending pull exists because "it is the only way
the system can ever surface something the operators did not already think to
look for". A watchlist-only set returned under the name "general candidates"
would be a degraded result indistinguishable from a good one. An explicit
watchlist-only entry point could be added later, deliberately and under its own
name; what must not exist is a general run that quietly becomes one.

### Spot versus perpetual: closed twice, with two different strengths

Gemini's real catalogue carries **perpetual** pairs (`HYPEGUSDPERP`,
`HYPEUSDCPERP`) alongside spot, and `parseSymbolList` passes every string
through unfiltered. Until step 32 nothing in this repository knew what a
perpetual was, so `addToWatchlist`, `fetchCandleWindow` and
`selectNamedCandidate` all accepted one with zero resistance, while every order,
fill and PnL path here is spot. It is now checked in two places, and **the two
are not equally strong — that difference is the point, not an oversight**:

| where | what it reads | strength |
| --- | --- | --- |
| `POST /api/bots` (`checkSpotInstrument`) | Gemini's own `product_type` / `contract_type` fields, one uncached request per symbol | **structural.** The venue states it. Verified live, step 32 |
| watchlist, candles, both candidate entry points (`checkTradable`, opt-in) | the symbol's own last characters against `DERIVATIVE_NAME_SUFFIXES` | **an inference.** Free, and Gemini publishes no such naming rule |

The research paths take the cheap one because they cannot afford the other:
`checkTradable` runs on every watchlist add, every candle fetch and up to ~15
times per candidate-selection run, and the structural check costs a request per
symbol. The match is `endsWith`, never `includes`, so `PERPUSD` — Perpetual
Protocol's real spot ticker — is not refused; a test pins exactly that.

**The order path deliberately opts OUT** of the naming heuristic
(`"structural-check-elsewhere"`). Letting a weaker inference answer first would
put a guess in the refusal message on the endpoint that reserves capital, and
would mask `checkSpotInstrument` from its own most realistic input — a regression
test in `api.test.ts` pins that `HYPEUSDCPERP` there is still refused by
`instrument_not_spot`. **Residual risk stays, in both directions**: a perpetual
that does not follow the naming convention passes the research paths silently,
and a future spot pair ending in those letters is wrongly refused. The false
reject is the preferred direction because it is loud, immediately fixable in one
table, and cannot block a legitimate bot. See decision logs 31 and 32.

Candidate selection's trending path was already structurally safe before any of
this, and only incidentally: `${BASE}${QUOTE}` cannot construct a `PERP` suffix,
and `checkTradable`'s near-match is an exact equality so no perp is ever offered
as "the venue's own spelling". Two tests pin both, and they are still what does
the work there.

A trending pull that matches nothing on the venue is a **fact**, not a failure,
and is reported as one: `TrendingPullReport` carries what came back, what was
accepted, and every rejection with the exact pairs that were tried. That last
field is load-bearing — without it, "the pair-spelling convention does not hold
on this venue" is indistinguishable from "a quiet day".

## The over-concentration flag is a flag, and structurally not a filter

21.4: *"This is a flag on the proposal for the human to weigh, presented
prominently, **not a silent filter**."*

So nothing in `concentration.ts` refuses, drops, reorders or scores a candidate.
`assessCandidateSetConcentration` returns exactly one result per candidate in the
candidate's own order, and there is no return value a caller could read as a
rejection. Its only two error codes are a blank field and a **failed read** —
never "this candidate is bad". That is a different shape from every other refusal
in this folder (`pair_not_tradable`, `interval_not_verified`, `not_covered`), and
deliberately: those answer *can this system honestly do this at all*, which is a
capability fact. This answers *should you want to*, which 21.1 puts on the
human's side of the boundary.

### The two thresholds are POLICY, not findings

21.4 names two cases and gives no numbers. `DEFAULT_CONCENTRATION_POLICY` holds
both, in the same category as `VERIFIED_INTERVALS` and
`DERIVATIVE_NAME_SUFFIXES` — **nothing has been verified against anything**, no
backtest supports them, and no operator has yet said they are right.

| | value | the judgement in it |
| --- | --- | --- |
| `samePairBotCountFlagAt` | **2** committed bots already on the pair | 21.4's own example ("a third bot on a pair that already has two") read as a *boundary* rather than an illustration. The looser of the two available readings of one sentence |
| `assetCapitalShareFlagAtPct` | **40%** of committed capital in the candidate's base asset | An argument, not evidence: 21.3 bounds the watchlist at 5–10 coins, so the design assumes a book spread over several, and at 40% one asset is more than two equal-weight positions' worth. 25% or 60% is equally defensible |

Both comparisons are **at or above** — exactly 2 flags, exactly 40.00000000%
flags — which the `FlagAt` in each name states and which is tested one step out
in both directions. The money boundary is decided by **cross-multiplied bigint**,
never by comparing a share already rounded to SCALE, so a value a hair under 40%
that *renders* as `40.00000000` does not flag. On today's real account (9 of 11
bots on `BTCUSD`) any threshold below ~80% fires identically, so **the live data
cannot discriminate between candidate values either**.

### Verified against real testnet state, 2026-08-10T20:35:36Z

The live `bot_instances` read, and what the fold produces from it. Every figure
below is real except where marked.

| | |
| --- | --- |
| bots on `gemini-main` | **13** — 11 `BTCUSD`, 2 `DOGEUSD` |
| statuses | 7 running, 1 halted, 1 halted+archived, 2 created, 2 running (DOGE). **None stopped** |
| capital assets | **`USD` only** |
| committed capital | **1750.00 USD** (all 13, since none are stopped) |
| BTC-derived | **1650.00 USD** across 11 bots |
| DOGE-derived | **100.00 USD** across 2 bots |

Computed output under `DEFAULT_CONCENTRATION_POLICY`, confirmed against by-hand
arithmetic before it was pinned:

| candidate | `samePairBots` | base-asset share | flags |
| --- | --- | --- | --- |
| `BTCUSD` | 11 | **94.28571429%** (1650/1750) | `same_pair_bot_count`, `asset_capital_share` |
| `DOGEUSD` | 2 | **5.71428571%** (100/1750) | `same_pair_bot_count` **only** |
| `LINKUSD` | 0 | 0.00000000% | none — `no_concentration` |

**`DOGEUSD` still flags**, on the count signal, at exactly the boundary: two
existing bots is the threshold, so a third DOGE proposal is flagged even though
its share is 5.7%. "DOGE does not flag" is the natural summary of the share
figure and it is wrong about the result; a test pins it.

**`v-perp-1` is a SPOT bot.** Its pair is `BTCUSD`; the name is leftover from a
rejected-then-reused botId in step 32's perpetual regression test. It counts as
one of the eleven, and a test says so by name — nothing in this repository infers
an instrument from a bot id, and a future reader grepping for "perp" will find
this.

**Two things in the pinned fixture are still not real, and are named in the
test:** the **per-bot split** of each pair total (the read gave pair totals, not
per-bot figures — distributed evenly, which is licensed by a test asserting the
report is *invariant* to the split given the same totals), and the **bot ids**
apart from `v-spot-1` and `v-perp-1`.

#### Two paths that are correct and unobserved

Same shape as step 31's merge/dedup path and step 32's Binance permission gap —
built, tested against fixtures, never exercised against real data. Not new kinds
of problem, and not fixed here:

1. **The stopped-bot exclusion.** The rule that makes `committed` something other
   than a plain `SUM` of the column exists because `releaseBotCapital` leaves
   `allocated_capital` behind. **No bot in this account has ever been stopped**, so
   the rule has only ever run against fixtures.
2. **The multi-quote-asset path.** Per-capital-asset grouping and the longest-first
   suffix strip both have real code. This account has only ever used `USD`, so one
   group is all that has ever been observed.

#### The bot count keeps moving, and this is the third correction

Log 32 recorded 11 bots against a prediction of 0. This read found **13** — two
more (`v-spot-1`, `v-perp-1`) created by steps 32/33's own live verification runs.
Step 28 hit the same class of surprise on the watchlist. **Verification runs
create real bots, so the count is stale the moment it is written down**, which is
exactly what 10.14 says ("anything which can change after an entry is written must
be read from the system, never quoted from this log"). Any future step that needs
a bot count must run the `SELECT`. Stating it plainly here because three
occurrences is a pattern, not a run of bad luck.

### It reports facts, not a verdict

Every result — flagged or clean — carries the counts, exact `bigint` money
totals, the **bot ids**, the pairs held, the quote assets used and the policy
applied, so a human can re-run the same `SELECT` and get the same numbers (21.5
requirement 2). The flag's `statement` renders those facts and adds nothing to
them. `"3 existing bots on BTCUSD"` is checkable only if you can go and look at
which three.

### Three states, never two

| | |
| --- | --- |
| the `bot_instances` read **failed** | throws `bot_list_unreadable` |
| the account has **no bot rows at all** | clean, `rowsRead: 0` |
| it has rows and **all are stopped** | clean, `rowsRead > 0`, `committedBots: 0` |

The first is the whole point. A check built to surface risk that reports *no
concentration* because it could not look would hide exactly the risk it exists to
catch, inside a proposal that then reads as reassuring (§5.6, 21.5 requirement
6). The last two are both clean and are **not the same sentence** — step 24's
`audit_empty_balance_set` distinction, step 30's coverage variants. And clean is
a **variant** (`assessment: "no_concentration"`), not an empty flag array: the
flagged variant's `flags` is a non-empty tuple, so "flagged with nothing to show"
cannot be constructed.

### What it borrows from step 25, and why not by calling it

`dashboard/src/accountTotals.ts` is **dashboard-side**: it folds a `Bot[]` the
page already fetched over HTTP, imports `./api/types` and `./derive`, and
**touches no database at all**. There was nothing here it could have been called
for. Two of its *rules* are reused, as rules:

1. **`stopped` bots are excluded from committed capital**, because
   `releaseBotCapital` subtracts a closed bot's allocation from the ledger but
   **leaves `bot_instances.allocated_capital` on the row** as history. Summing
   every row reports returned capital as still committed — an overstatement
   growing with every bot ever closed. Stopped bots are still **counted and
   reported beside** the figures, because `close` does not flatten a position, so
   one can genuinely still hold inventory.
2. **Grouped by capital asset, always.** A share over a total blending USD and
   USDT is a percentage of nothing, and it looks completely normal.

**Archived bots count**, exactly as step 26 settled for the account totals:
`archived` is a view flag orthogonal to `status`, and a concentration figure that
moved when someone flipped a dashboard toggle would be step 25's silent omission
in a new place. Pinned by a test.

### The base asset is a naming inference, and says so

21.4's second case is about an **asset**, and `bot_instances` has **no base-asset
column** — only `pair` and `capital_asset`. Neither is the asset in question: by
pair, `BTCUSD` and `BTCUSDT` are two unrelated things; by capital asset, every
bot on the real account is `USD`, so the share is 100% for every candidate
forever and **a flag that always fires is not a flag**.

`news.ts` refuses to split `BTCUSD` into `BTC` — *"a guess at the split point is
wrong for exactly the newly-listed, oddly-named coins 21.3's trending source
exists to surface"* — and that refusal stands. This does something narrower: the
quote assets are **observed**, not guessed (the distinct `capital_asset` values on
the account's own bots, plus any the caller states, the same list
`selectGeneralCandidates` already takes from an operator), and a pair is split
only when it **ends in one of them, longest first** so `BTCUSDT` strips `USDT`
rather than becoming `BTCT`. A pair matching none is **not** split and is
**counted**, which makes every base-asset figure that had one a stated **floor**.

It is safe here in a way it would not be in `news.ts` because **the output cannot
block anything**: a wrong split yields a sentence a human can see is wrong — the
report names the suffix it stripped — never a refused pair or an order. Known
limits, both real: a venue writing `BTC-USD` splits to nothing (neither venue
here does), and a ticker ending in a quote asset's letters would mis-split. When
no split is possible the signal **degrades to the exact pair and says so**, never
to silence.

### The same-pair match is case-insensitive, unlike `checkTradable`

Deliberately the opposite rule, because the string is a **grouping key that never
leaves the process** rather than a symbol about to be sent to a venue. The two
failure directions are not equal: folding when it was unnecessary over-counts a
flag a human weighs and dismisses, while **not** folding when it was necessary
reports "0 bots on `BTCUSD`" with nine `btcusd` rows in the table — a false clean
result. `samePairSpellings` reports every spelling matched, so the fold is never
silent.

## The two candidate sources stay apart

21.3 feeds the general entry point from two sources, and this folder holds one
of them:

1. **A fixed watchlist** — 5–10 coins *chosen deliberately by the operators*.
2. **A live trending pull** — *the only way the system can ever surface
   something the operators did not already think to look for*.

**The trending pull must never write to the `watchlist` table.** The merge is
tempting because both produce pairs and both feed one pipeline (21.2: "one
feature, not two"), and it is still wrong twice over:

- 21.5 requires every proposal to display *the real source the candidate came
  from — which watchlist entry, or which trending pull, and when*. One table
  destroys that distinction at the moment of writing, and nothing downstream
  recovers it.
- 21.3's **hype hazard**: trending measures attention, not quality. A watchlist
  entry carries a human's stated reason (`note`, NOT NULL); a trending hit
  carries a popularity number. Stored together they are indistinguishable to
  every later reader, which is how a proposal comes to read as confident because
  its input was loud.

The cap makes the merge unattractive as well as forbidden: a trending pull
emptying itself into a 10-row table fails on the eleventh coin.

## What a write checks

| Check | Why | On failure |
| --- | --- | --- |
| Human actor | The list's value is that someone chose each row | `requires_human_actor` |
| Non-blank pair and note | The note is the only record of the reasoning | `missing_field` |
| Not already live | A duplicate is one coin costing two pipeline runs | `already_watched` |
| `WATCHLIST_MAX_ENTRIES` (10) | 21.3's bound, enforced not documented | `cap_exceeded` |
| Tradable on the account's venue | An untradable coin cannot become a bot | `pair_not_tradable` |
| The tradable set was **readable** | "could not check" ≠ "checked and fine" (§5.6) | `tradable_set_unreadable` |

The tradable set comes from `listTradablePairs` through step 11's cached
`listAccountSymbols`, injected as the `TradablePairSource` port — 21.3 is
explicit that it "is the authority, not a hardcoded list", and there is no
second path to the venue here.

Every write also lands an `audit_log` row through `db.auditLog`, the same path
every other consequential write in this system uses. The add batches its row and
its audit entry together; the removal does not, deliberately — see the comment
at that call site.

## Removal does not re-check tradability

Deliberate, and a departure from applying the write-side rule symmetrically.
Refusing to remove a **delisted** pair would trap exactly the entry most in need
of removing, and an exchange outage would be enough to freeze the list. The
failure runs the wrong way. Removal checks the precondition that actually
matters — that the pair is on the live list — and audits itself.

## Removal is a soft delete

`removed_at` / `removed_by`, not a row deletion. `Repository` offers no `delete`
method at all (see `/src/db/table.ts`) and this does not reach past it. Step 26
established the shape for `bot_instances.archived`; this is the same one table
over. The history is worth keeping on its own terms: *someone considered this
coin and then changed their mind* is the same kind of negative signal 21.5 wants
recorded about proposals nobody acted on.

## Deliberately deferred

- **A dashboard control for either the list or the candle window.** Not built,
  on purpose. Both have a curl-able endpoint instead; a UI is its own step.
- **An HTTP endpoint for the news fetch.** Deliberately not built yet, pending a
  decision on how (and whether) to verify it against the real CoinDesk API — the
  same order the candle step took, where the endpoint existed to make the
  function checkable and was written once there was something to check.
- **A trending vendor, and any transport for one.** `TrendingSource` is a port
  and nothing implements it. No trending API has been called from this
  repository, and the vendor research is in decision log 31.
- **An HTTP endpoint for candidate selection or the concentration flag**, and
  everything LLM-shaped — Assess, Derive, proposal assembly, the proposal record,
  the audit table.
- **A stopped bot, and a second capital asset, on the real account.** Both code
  paths exist and are fixture-tested; neither has ever been observed live. See
  the two unobserved paths above.

`fetchCandleWindow`'s only caller is its endpoint. `fetchNewsSentiment` has **no
non-test caller at all**, and `envNewsFetcher`'s `fetch` call has never executed
against CoinDesk. `readWatchlist` finally has a non-test caller —
`selectGeneralCandidates` — which itself has none. `concentration.ts` has **no
non-test caller either**: it consumes `candidates.ts`'s `Candidate` and
`CandidateSet` types, but nothing yet calls both in sequence, because the thing
that would is the proposal pipeline.

**Watchlist entries are not re-checked against the venue at selection time.**
A pair delisted after it was added stays a candidate until someone removes it.
This is the gap step 28 already recorded on `readWatchlist` ("says nothing about
the tradable set having gone stale underneath" it); closing it changes what
membership of the watchlist means, which is a decision rather than a detail.

## `fetchCandleWindow` removes a scoping limit, not the depth limit

Reaching `getCandles` used to mean holding a client, and every route to one ran
through a bot's attached client — so "candles for a pair" meant "candles for a
pair that already has a bot". A candidate coin has no bot by definition. This
resolves a client from the account registry instead, through the same
`clientForAccount` the symbol listing uses.

What it does **not** do is reach deeper history. Gemini's `/v2/candles` takes no
time-range parameter and returns a fixed recent window (spec 21.7, open question
1). That is reported rather than worked around: `earliestCloseTime` says how far
back the window actually goes, and `truncated` / `missingHistoryMs` say when the
requested range was not fully covered. 21.7's requirement is that "the Assess
stage must be told how much history it actually received and must not reason as
though it had more".

Every failure throws a `CandleWindowError` — unverified interval, unknown
account, untradable pair, unreadable tradable set, failed candle call, and a
call that succeeded with an empty array. None returns an empty window, because
an empty array flows into an average as though it meant something (§5.6, 21.5
requirement 6).

## Only `1m` is a verified interval

`VERIFIED_INTERVALS` is `["1m"]`, and anything else is refused with
`interval_not_verified` before any I/O happens. `CandleInterval` declares all
seven both venues nominally support, and its own docblock has said since step 14
that each "must be verified per exchange before first use" — a comment nothing
enforced. It has to be enforced here because the failure is silent: the venues
spell the wider intervals differently (Gemini writes `1hr`/`6hr`/`1day`), so a
wrong mapping returns correctly-shaped candles of the **wrong duration**, which
every type check passes and no later reader can detect.

Widening it is one line in `candles.ts` plus the pin in `candles.test.ts` that
asserts its current contents — the pin exists so widening cannot happen as a
silent one-character edit. Neither is the hard part: an interval belongs on that
list only once someone has read that venue's candles at that timeframe and
confirmed the duration.

## `GET /api/accounts/:label/candles`

Read-only, behind Access like every other route, taking `?pair=`, `?interval=`
and an optional `?since=`. It publishes the whole `CandleWindow` — including
`truncated`, `missingHistoryMs`, `earliestOpenTime` and `count` — because the
depth limit above is a claim about a real venue that no test in this repository
can settle. Every candle in the suite comes from a stub modelling a fixed
window; only a real request can say whether the truncation reporting is
accurate.

The module's codes map to statuses in `api/envelope.ts`, reusing existing tiers:
`interval_not_verified` and `pair_not_tradable` 400, `unknown_account` 404,
`candles_unavailable` and `no_candles_returned` 502 (a read the caller asked for
that the venue failed to serve — the symbols endpoint's tier),
`tradable_set_unreadable` 503 (a refusal to act on input that could not be
verified — a different thing, deliberately a different status).

## `fetchNewsSentiment` is written against an **unverified** wire format

**No call to CoinDesk has ever been made from this repository, and this project
holds no CoinDesk key.** Their reference docs render client-side from a spec
that can only be read by calling the API host, which was not done. The host, the
paths, the `Authorization: Apikey` scheme, the `{ Data, Err }` envelope, the
`PUBLISHED_ON`-is-seconds assumption and every field name in
`COINDESK_WIRE_FIELDS` are **inferences from CoinDesk's public documentation
index and published descriptions of the API** — not observations.

What *is* established from public sources: the sentiment is a **label**
(`POSITIVE` / `NEUTRAL` / `NEGATIVE`), not a number, and it is produced by
prompting a general-purpose language model to categorise each article. 21.4's
reasoning for choosing this vendor survives that — the label is computed outside
*this* system and a human can check it against the headline — but nothing may
treat it as a calibrated score. `fetchNewsSentiment` therefore returns the
labels and their counts and **no derived sentiment index of any kind**.

Every assumption is checked at parse time and a violated one **throws**, so a
wrong guess surfaces as `unexpected_category_payload` /
`unexpected_article_payload` naming the field, not as zero articles. The
assumptions are collected in `COINDESK_WIRE_FIELDS` (pinned by a test, like
`VERIFIED_INTERVALS`) and `COINDESK_ENDPOINTS` in `src/workers/news.ts`, so
correcting them after a live run is one visible diff.

## Coverage is asked as its own question (21.7 open question 2)

> "CoinDesk's coverage of newly listed coins is unverified… If coverage is
> empty, that is a fact the proposal must state, not a gap to paper over."

An article request alone **cannot** answer that: an empty list means both "this
vendor has never heard of this coin" and "this vendor covers it and published
nothing recently". So the category listing is asked **first**, and the article
request is spent only when there is a category to spend it on.

| result | means |
| --- | --- |
| `not_covered` | the vendor lists no category for this asset. No article request was made |
| `no_articles_in_window` | it does, and returned nothing |
| `covered` | it does, and returned articles |

They are **separate variants**, not a flag beside an array: the covered variant's
`articles` is a non-empty tuple type and the other two carry no `articles` field
at all, so "covered with zero articles" cannot be constructed and a reader that
forgets to check `coverage` cannot reach an empty array.

**The distinction is only as good as its premise** — that the category list
enumerates assets. That premise is unverified like the rest. If a live run shows
the category list is a small fixed taxonomy rather than an asset index, **this
design is wrong and must be replaced by a plain statement that the vendor cannot
tell the two apart**, not by a heuristic that guesses.

A spelling difference is **never** reported as no coverage. `"btc"` against a
vendor writing `"BTC"` throws `asset_spelling_mismatch` carrying the vendor's
own spelling — the same exact-match discipline `checkTradable` uses, and for a
sharper reason: a false "nobody is writing about this coin" reads like a finding
rather than like the mistake it is.

## The news fetch takes an **asset**, not a pair, and never caches

`fetchNewsSentiment({ asset: "BTC" })`. It does not derive `BTC` from `BTCUSD`:
Gemini's symbols are concatenated and separator-less, so splitting one needs the
venue's own symbol details, and a guess at the split point is wrong for exactly
the newly-listed, oddly-named coins 21.3's trending source exists to surface.

Nothing is cached, matching `envCandleLister`'s reasoning: 21.5 requirement 4
times a proposal from when its data was fetched, and a cache would make that
timestamp a lie that looks exactly like the truth. Every result carries
`fetchedAt` and `coverageCheckedAt` — the two calls happen at different instants
and one number for both would claim something nothing observed.

Every failure throws a `NewsSentimentError`: `invalid_asset`, `invalid_limit`,
`asset_spelling_mismatch`, `categories_unreadable`, `news_unavailable`,
`vendor_error` (an error in the envelope beside an HTTP 200 — the shape a silent
failure takes with this vendor), `unexpected_category_payload`,
`unexpected_article_payload`. One malformed article fails the whole fetch rather
than being dropped, and an article with no `SENTIMENT` is refused outright,
because that field is the entire reason 21.4 chose this vendor.

## What the manual edit path bypasses

While editing is a raw `wrangler d1 execute`, the cap, the tradability check and
the audit entry are all bypassed — none of that code runs on a raw `INSERT`. The
one guarantee that survives is the migration's unique partial index on
`(account_label, pair) WHERE removed_at IS NULL`. This is stated rather than
hidden; it is the strongest argument for building the dashboard control, and the
reason the SQL commands in the decision log write the paired `audit_log` row by
hand.
