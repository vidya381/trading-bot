# `/src/research` — groundwork for section 21

Section 21 (LLM-assisted research and bot proposals) is **PLANNED, NOT YET
BUILT**, and that banner still holds. There is no pipeline, no prompt, no
proposal record and no Workers AI call in this folder.

What exists is the storage for **21.3's fixed watchlist**, **two of 21.4 Stage
1's three fetches**, and **candidate selection for both of 21.2's entry
points** — the first thing in this folder that consumes the others.

| File | What it is |
| --- | --- |
| `watchlist.ts` | `addToWatchlist` / `removeFromWatchlist` / `readWatchlist`: the deliberate half of candidate selection, over `watchlist` (migration 0008) |
| `tradability.ts` | `checkTradable`: "will this account's venue trade this pair?", asked once and shared by every caller below |
| `candles.ts` | `fetchCandleWindow`: 21.4 Stage 1's candle fetch for **any** listed, tradable pair — no bot required — reporting how much history it actually got |
| `news.ts` | `fetchNewsSentiment`: 21.4 Stage 1's news and pre-scored sentiment for one asset, with 21.7 open question 2's coverage distinction built in. **Its wire format is assumed, not verified** — see below |
| `candidates.ts` | `selectNamedCandidate` / `selectGeneralCandidates`: 21.2's two entry points, feeding one `CandidateSet`. **No trending vendor is chosen** — `TrendingSource` is an abstract port with no client behind it |

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

### Spot versus perpetual: a flagged gap, live today

Gemini's real catalogue carries **perpetual** pairs (`HYPEGUSDPERP`,
`HYPEUSDCPERP`) alongside spot, and `parseSymbolList` passes every string
through unfiltered. **Nothing in this repository knows what a perpetual is** —
`grep -rn "PERP" src/` returns nothing — so `addToWatchlist`,
`fetchCandleWindow` and `selectNamedCandidate` would all accept one with zero
resistance, while every order, fill and PnL path here is spot.

Candidate selection's trending path is the only place this is structurally safe,
and only incidentally: `${BASE}${QUOTE}` cannot construct a `PERP` suffix, and
`checkTradable`'s near-match is an exact equality so no perp is ever offered as
"the venue's own spelling". Two tests pin both. **The human-typed paths have no
protection**, and this needs its own decision — a spot-only filter at the shared
tradability level, or a recorded accepted-risk. See decision log 31.

A trending pull that matches nothing on the venue is a **fact**, not a failure,
and is reported as one: `TrendingPullReport` carries what came back, what was
accepted, and every rejection with the exact pairs that were tried. That last
field is load-bearing — without it, "the pair-spelling convention does not hold
on this venue" is indistinguishable from "a quiet day".

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
- **An HTTP endpoint for candidate selection**, and everything LLM-shaped —
  Assess, Derive, proposal assembly, the proposal record, the audit table.

`fetchCandleWindow`'s only caller is its endpoint. `fetchNewsSentiment` has **no
non-test caller at all**, and `envNewsFetcher`'s `fetch` call has never executed
against CoinDesk. `readWatchlist` finally has a non-test caller —
`selectGeneralCandidates` — which itself has none.

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
