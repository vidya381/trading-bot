# `/src/research` — groundwork for section 21

Section 21 (LLM-assisted research and bot proposals) is **PLANNED, NOT YET
BUILT**, and that banner still holds. There is no pipeline, no prompt, no
proposal record and no Workers AI call in this folder.

What exists is the storage for **21.3's fixed watchlist**, a read path for a
pipeline stage that does not exist yet, and **21.4 Stage 1's candle fetch**.

| File | What it is |
| --- | --- |
| `watchlist.ts` | `addToWatchlist` / `removeFromWatchlist` / `readWatchlist`: the deliberate half of candidate selection, over `watchlist` (migration 0008) |
| `tradability.ts` | `checkTradable`: "will this account's venue trade this pair?", asked once and shared by both callers below |
| `candles.ts` | `fetchCandleWindow`: 21.4 Stage 1's candle fetch for **any** listed, tradable pair — no bot required — reporting how much history it actually got |

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
- **Candidate selection, the trending pull, and everything LLM-shaped.** None of
  it exists.

`readWatchlist` currently has **no non-test caller**. It is the seam the
pipeline will consume. `fetchCandleWindow`'s only caller is its endpoint.

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

## What the manual edit path bypasses

While editing is a raw `wrangler d1 execute`, the cap, the tradability check and
the audit entry are all bypassed — none of that code runs on a raw `INSERT`. The
one guarantee that survives is the migration's unique partial index on
`(account_label, pair) WHERE removed_at IS NULL`. This is stated rather than
hidden; it is the strongest argument for building the dashboard control, and the
reason the SQL commands in the decision log write the paired `audit_log` row by
hand.
