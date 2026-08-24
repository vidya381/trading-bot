# DESIGN — the terminated-order tolerance on Gemini

**Status:** designed, NOT built. Investigation and design only; no source file was
touched in the session that produced this document.
**Raised by:** entry 61, "The Gemini `updatedAt` gap — FOUND, NOT FIXED".
**The split held:** no `wrangler`, no deploy, no HTTP call, no real D1, no
browser. Every claim below is read off this repository's source.

---

## VERDICT, up front

**A safe signal exists, and it is not a timestamp.**

The recommendation is *not* to find a better clock. It is to stop asking the
clock question at all on a venue that cannot answer it, and to fall back to the
run-to-run memory **entry 61 already built, tested and shipped for the live-order
branch** — which entry 61's own Part 2 describes as *"venue-independent by
construction"*.

Two changes, both small:

1. `OrderStatus.updatedAt` becomes **optional**, and Gemini's `parseOrderStatus`
   **omits it** instead of fabricating `createdAt`. This is not a new principle;
   it is the principle already stated verbatim in `shared/exchange-client.ts:290-298`
   for `createdAt` on a cancellation response — *"left missing rather than filled
   in … which would be a fabricated value that looks authoritative."*
2. `liveOrderFindings`' terminated branch: when `updatedAt` is **present**, the
   existing 60-second window runs **exactly as it does today** (so Binance is
   untouched, bit for bit). When it is **absent**, the branch falls through to the
   same first-sighting / second-sighting escalation the live branch uses.

No new field on `TrackedOrder`. No new storage key. No new Durable Object write.
No new `FindingKind`. No new table, column or alert type. No exchange name is
branched on anywhere.

The rest of this document is the evidence for that conclusion, the alternatives
that were evaluated and rejected, the failure-mode trace the brief asked for, and
the test list.

---

## Q1 — What Gemini's order-status response actually contains

`parseOrderStatus` is at `src/exchange/gemini/parse.ts:550-563`, current on disk:

```ts
const createdAt = requireEpochMs(record, "timestampms", context);
...
  createdAt,
  updatedAt: createdAt,
```

Its docblock already states the constraint honestly: *"Gemini reports a single
`timestampms` (the order's), so `createdAt` takes it and `updatedAt` defaults to
the same value — there is no separate last-update time in the payload."*

**This is confirmed against a real captured payload, not against documentation.**
`src/exchange/gemini/parse.test.ts:443-477` preserves the exact key set read off
a live sandbox response during the 2026-07-31 wrapped-array incident:

```
avg_execution_price, client_order_id, exchange, executed_amount, id,
is_cancelled, is_hidden, is_live, options, order_id, original_amount,
price, remaining_amount, side, symbol, timestamp, timestampms, trades,
type, was_forced
```

Field by field, against the brief's question "anything at all with real temporal
information tied to the order's **current state**":

| Field | Temporal? | Tied to current state? |
|---|---|---|
| `timestampms` / `timestamp` | Yes (ms / s) | **No** — order creation. Same instant, two units. |
| `order_id` / `id` | Monotonic-ish sequence | **No** — assigned at creation, never re-issued. Carries no wall clock and does not move when the order does. |
| `trades[].timestampms` | **Yes, real, exchange-issued** | **Partly** — see below. |
| `trades[].tid` | Trade sequence id | No wall clock. |
| `is_live`, `is_cancelled`, `is_hidden`, `was_forced` | Booleans | State without a time. `is_cancelled: true` says *that* it was cancelled and never *when*. |
| `remaining_amount`, `executed_amount`, `avg_execution_price` | Quantities | No time. |
| `options`, `type`, `side`, `symbol`, `price`, `exchange`, `client_order_id` | — | No time. |

**There is no update, cancel, or transition timestamp of any kind.** `updatedAt =
createdAt` is the only value this parser can produce from the payload as it
stands. Entry 61's finding is confirmed exactly.

### The one partial exception, and why it is not enough

`trades[].timestampms` is a genuine exchange-issued time, and this system does
receive it: `GeminiClient.getOrderStatus` sends `include_trades: true`
(`src/exchange/gemini/client.ts:339-353`), and `parseFills`
(`parse.ts:450-478`) reads each trade's own `timestampms` into `Fill.executedAt`.

So for an order that terminated **by filling**, `max(fills[].executedAt)` *is*
the termination instant — exactly, not approximately.

It fails for the other three terminal states. `cancelled`, `expired` and
`rejected` all arrive as `is_cancelled: true` (or as an error body, for a
rejection) with no time at all, and an order cancelled with zero fills has an
empty `trades` array. So a fills-derived `updatedAt` would cover *some* Gemini
terminations and silently keep today's behaviour for the rest — one venue with
two behaviours, and the harder case is the one it does not cover.

It is worth recording that this substitution is **provably conservative** if
anyone ever wants it: `max(fills[].executedAt)` is bounded above by the true last
update for every terminal state (equal to it for a fill-termination, earlier than
it for a cancel-after-partial-fill), so it can only ever move `updatedAt`
*earlier* than the truth, which can only ever make the tolerance *refuse* to
apply. It cannot over-forgive. It is rejected here as unnecessary rather than as
unsafe — the recommended design covers all four terminal states with one
mechanism, and adding this would be a second, partially-overlapping one.

### No websocket order feed exists

The brief asked about a websocket event time. There is none to read.
`grep -rn "wss://" src scripts` returns only `src/exchange/gemini/price-feed.ts`
(`/v2/marketdata`, public price candles) and its tests. Gemini's private
`/v1/order/events` socket is **not used anywhere in this system**. Order state is
obtained exclusively by REST polling.

---

## Q2 — Does this system have its own independent staleness signal?

**Today: no. Not at any granularity, for any exchange.**

`TrackedOrder` (`src/shared/order-state.ts:90-133`) carries exactly two
timestamps, `createdAt` and `updatedAt`, and neither records an *observation*:

- `createdAt` — set once by `createOrder` (`order-state.ts:209-233`) from the
  caller's `at`.
- `updatedAt` — set by `applyFill` to `fill.executedAt` (`order-state.ts:288`,
  an **exchange** time) and by `closeOrder` to the caller's `at`
  (`order-state.ts:314-319`).

And the two `closeOrder` call sites pass a **remote** timestamp:

- `bot-instance.ts:2771` — `closeOrder(order, remote.state, remote.updatedAt)`, in
  `#foldTerminalState`.
- `bot-instance.ts:5173` — `closeOrder(order, "cancelled", remote.updatedAt)`, in
  `#recordCancellation`.

So `TrackedOrder.updatedAt` is **not** a local-observation clock either. It is a
mirror of exchange-reported times, and on Gemini it inherits the same defect. It
cannot be repurposed as-is.

**Crucially, the poll writes nothing when it confirms an order is still open.**
`#pollOpenOrders` (`bot-instance.ts:2484-2650`) reads each id in
`state.openOrderIds` via `getOrderStatus`, applies any new fills, and calls
`#foldTerminalState`. On the overwhelmingly common pass — order still resting,
no new fill — it takes no branch that writes anything. `#observeOpenOrders`
(`bot-instance.ts:2415-2432`) states this as a deliberate property: *"The no-op
pass still writes nothing at all. On a timer it is the overwhelmingly common one,
and a row per pass would measure how long the bot has been running rather than
what happened to it."*

There is therefore **no existing record anywhere of "we saw this order open at
time T"**. It would have to be created.

### What the system *does* have, and why reconciliation cannot see it

`PollSchedule` (`bot-instance.ts:716-725`) holds `nextPollAt`, `failures`,
`blindSince`, `escalated`. It is a per-**bot** health record, not a per-order one,
and its own docblock says why it is kept out of the snapshot: *"Stored under its
own key rather than inside `BotRuntimeState` deliberately: that record is
mirrored, snapshotted, and compared against by reconciliation, and scheduling
bookkeeping is none of those things."*

`BotSnapshot` (`bot-instance.ts:571-575`) is `{ config, state, orders }` — which
is exactly why entry 61's Q2 concluded reconciliation is structurally blind to the
poll. That finding stands, unchanged.

Note in passing that `BotSnapshot` carrying `orders: readonly TrackedOrder[]`
means **any field added to `TrackedOrder` reaches reconciliation for free**, with
no snapshot change and no new port. That is what makes the local-timestamp
candidate in Q3 cheap enough to be worth evaluating seriously rather than
dismissing.

---

## Q3 — Evaluating a local-observation timestamp

**Candidate:** `TrackedOrder.lastObservedOpenAt?: Timestamp`, written from the
Durable Object's **own** clock (`this.#now()`) — never from any remote field —
on each poll read that reports a **non-terminal** state, and at placement.

Reconciliation would then compute
`age = at - (local.lastObservedOpenAt ?? local.createdAt)`.

### The definitional difference, and whether it matters

The two definitions genuinely differ:

- **Gemini/Binance `updatedAt`:** *time since the venue says the order changed.*
- **`lastObservedOpenAt`:** *time since we last confirmed it was still open.*

The second is always the larger of the two, by up to one poll interval (30s):
an order that terminated 1 second ago on a bot whose poll last ran 29 seconds ago
reads as `age = 29s`, not `1s`.

**For the purpose this tolerance actually serves, the difference does not matter —
and the local definition is the more directly relevant of the two.** Entry 61
states the purpose precisely: forgiving *"a race between the bot's own poll and
reconciliation's less-frequent check"*, and the 60s constant's own docblock
(`findings.ts:398-400`) sizes it as *"a comfortable multiple of the round trip to
the exchange plus one reconciliation pipeline."* That is a question about **our
observation cadence**, not about the venue's clock. `timingWindowMs` at 60s is
exactly two poll intervals, so `age_local ≤ 60s` means precisely *"the poll has
missed at most one turn on this order"* — which is a sharper statement of the
intent than the venue-clock version, not a looser one.

### Why it is nonetheless **not** the recommendation

Three reasons, in increasing order of weight.

1. **It costs a storage write per open order per poll pass.** Roughly `N` orders ×
   2 passes/minute per bot — for a grid ladder that is a few thousand writes a
   day per bot, and it converts the no-op pass from writing nothing into writing
   `N` records. That directly contradicts the property `#observeOpenOrders`
   states in as many words. Not fatal, but it is a real cost paid on the hot path
   for a tolerance that fires rarely.
2. **It is new persisted state on the one record the whole system treats as the
   source of truth** (section 8.1), added for the benefit of a single `if` in a
   different module. Optional-and-defaulted keeps old orders readable, but every
   order-writing path then has to remember to maintain it, and forgetting is
   silent — see the Q5 trace, where two of the four paths that write orders would
   have needed a deliberate decision about this field.
3. **A cheaper mechanism with the same safety properties already exists, is
   already tested, and was designed for exactly this problem** — see Q4.

**A coarser variant was considered and is UNSAFE — worth recording so nobody
re-proposes it.** Putting a single per-bot `lastCleanPassAt` on `PollSchedule`
(which the poll already rewrites every pass, so it would be free) and exposing it
on the snapshot would degenerate into the rejected "always applies" mode. Reason:
`#foldTerminalState`'s quantity gate (`bot-instance.ts:2760-2770`) refuses to
close an order that ended with more filled than the bot recorded, and leaves it in
`openOrderIds` forever. The poll then re-reads that order successfully every 30
seconds — a perfectly clean pass — while the order is permanently terminal on the
exchange and permanently disagreeing. A per-bot freshness clock would stay fresh
through all of it and forgive that drift indefinitely. **Only per-order
granularity, gated on the read reporting a non-terminal state, is safe.** That is
a hard requirement on any local-timestamp design, and it is what kills the cheap
version.

---

## Q4 — Gemini-specific, or universal?

**Neither, exactly.** The right axis is not the exchange and not a global switch:
it is **"did this payload carry a real last-update time?"** — a property of the
data, which the type system can carry.

The evidence that this is the right axis:

- `shared/exchange-client.ts:289-298` already applies precisely this reasoning to
  `createdAt`, which is optional *because* Binance's cancellation response has
  none, with the note that filling it in *"would be a fabricated value that looks
  authoritative."* `updatedAt` on Gemini's status response is that same
  fabrication, at the same severity, and it is the one this document exists about.
- Branching on `config.exchange === "gemini"` inside reconciliation would put a
  safety decision on a string, in a module that has twice now (entries 58 and 61)
  refused to put safety decisions on strings. It also fails silently the day a
  third venue is added.
- A **global** switch to local-observation semantics would change Binance's
  behaviour, which the brief forbids.

So: make the absence expressible, let the parser tell the truth, and let the
consumer branch on presence. Binance keeps its current path because it keeps
supplying the value. Gemini takes the fallback path because it genuinely cannot.

**Is the fallback "more correct universally", as the brief asks?** Yes — and this
is worth stating plainly, because it is the honest answer rather than the
convenient one. The run-to-run memory of entry 61 is a *better* mechanism than the
timestamp window on every venue: it needs no venue clock, no clock-skew tolerance,
and no assumption that the venue reports transitions honestly. Binance's real
`updateTime` is, as the brief suspected, an **accident that happened to work**
rather than the right design.

**It is still not recommended to unify immediately.** Retiring the window on
Binance too would delay a genuine, persistent Binance drift by one reconciliation
cycle (~5 minutes) — the same trade-off entry 61 accepted for the live branch, but
a behaviour change to a currently-working path, taken in the same step as a fix
for a broken one. The recommendation is to route on `updatedAt` presence now, note
in the code that the fallback is the better mechanism, and let a later step retire
the window on its own evidence if that is wanted. The design leaves that door open
and does not walk through it.

---

## Q5 — Failure modes, traced against real code paths

The two rejected modes, restated: **never applies** (the tolerance is dead, as it
is on Gemini today) and **always applies** (real persistent drift is silenced
unconditionally — strictly worse).

### The recommended signal

*"Did a run of mine, within `unconfirmedWindowMs` (600s), already record an
`order_drift_unconfirmed` finding for `${botInstanceId}::${clientOrderId}`?"*
Read by `unconfirmedDriftFromRecentRuns` (`reconcile.ts:720-748`) out of
`audit_log.details_json`, matched on the structural `client_order_id` field
(`reconcile.ts:276`), not on prose.

**Can it degenerate to "never applies"?** No. A first sighting has no prior row by
construction, so it is always classified `order_drift_unconfirmed` — floor and
ceiling both pinned `minor` (`findings.ts:135`), which raises no alert row and
halts nothing. The forgiveness cannot fail to fire.

**Can it degenerate to "always applies"?** No, and this is the property that
matters. Escalation on a second sighting is **unconditional** — no severity check,
no poll-health check, no retry budget, no back-off (entry 61, Q5). The
`order_state_drift` kind carries floor `meaningful`, which halts. So the worst
case for a genuine, persistent Gemini drift is that it halts **one reconciliation
cycle later than it would on a venue with a working clock** — bounded, and never
indefinite.

**Two real bounds, inherited from entry 61 rather than introduced here, stated
honestly:**

- `RECENT_RUN_SCAN = 20` (`reconcile.ts:316`) caps the audit scan. At the
  five-minute cron only ~2 rows fall inside a 600s window, so the cap is
  generous — but it is a **per-`action`** cap applied *before* the
  `account_label` filter (`reconcile.ts:726-740`). Many accounts, or many manual
  runs inside ten minutes, could push an account's own earlier sighting out of
  view and reset it to a first sighting. Extending the mechanism to the
  terminated branch inherits this; it does not worsen it.
- `unconfirmedWindowMs = 600_000` spans two turns of the cron, so **one** skipped
  run is tolerated and **two consecutive** skipped runs reset the escalation. The
  terminated branch is slightly more exposed to this than the live branch, because
  reaching it at all requires `getOpenOrders` to have succeeded
  (`reconcile.ts:520-533`) — so the runs that skip are correlated with the venue
  trouble that produces the drift. Still bounded, still non-silent (`skipped` is
  reported on the run), and not a new class of problem.

### Trace against the paths the brief named

Each is checked for whether it can reset, corrupt, or freeze the signal.

**`halt()` / `#cancelOpenOrders` (`bot-instance.ts:5030-5095`).**
Cancels each open order; removes from `openOrderIds` only the ids it *resolved*.
An order whose cancel could not be confirmed, or whose local record
`#recordCancellation` refused to close over an unrecorded fill
(`bot-instance.ts:5150-5175`), **stays in `openOrderIds`**. That is exactly right
for this signal: the order remains visible to reconciliation, keeps being
re-detected every run, and escalates on the second sighting. A halted bot is
still polled — `#pollArmed` (`bot-instance.ts:3037-3039`) excludes only
`stopped` — so the poll can still repair it in the meantime, which is the
outcome the forgiveness exists to allow. **No effect on the signal.**

**`resume()` (`bot-instance.ts:3080-3145+`).**
Writes no order records at all. It checks the three latches (global kill switch,
account breaker, and the step-58 gate that reads unresolved
`ORDER_STATE_DRIFT_ALERT_TYPES` rows) and flips status. **No effect on the
signal.** Note also that `order_drift_unconfirmed` is *not* a member of
`ORDER_STATE_DRIFT_KINDS` (`shared/alert-types.ts:111`) and, being `minor`, writes
no alert row at all — so a first sighting cannot accidentally start blocking
resume. Confirmed rather than assumed.

**`repairPosition` — fix #3, entry 59 (`bot-instance.ts:1785-2000+`).**
Reads the whole order history via `storage.list`, recomputes the DCA position,
and — only on `commit` — writes **`position` fields only**. There is no `#putOrder`
call anywhere in it (`#putOrder` call sites are lines 2772, 3736, 3871, 3904,
4384, 4459, 4921, 5174; none is inside the repair). It cannot touch order records,
`openOrderIds`, or anything the signal reads. **No effect on the signal.**

**`applyMissedFills` (`bot-instance.ts:1629-1715`).**
Iterates `openOrderIds`, applies genuinely new fills by their real `tid`. Two
outcomes matter: if it applies the missing fill, local and remote now agree and
`driftAgainst` returns `[]` — the finding stops recurring and never escalates,
which is correct because the drift is gone. If it cannot (no per-fill detail, or
the state machine refuses), it reports the gap and changes nothing — the finding
recurs and escalates on schedule. It never writes a timestamp the signal reads,
and it never removes an id from `openOrderIds`. **No effect on the signal, and
both of its outcomes drive the right result.**

**`close()` (entry 64, `bot-instance.ts:3380-3428`).**
Refuses outright while `openOrderIds` is non-empty after the sweep, so it cannot
strand an unresolved order in a `stopped` bot that reconciliation would never look
at (`RECONCILED_STATUSES` excludes `stopped`, `reconcile.ts:135`). **No effect on
the signal**, and it removes the one route by which an escalation could be lost
rather than delayed.

**The poll itself.** The only path that can end the recurrence is
`#foldTerminalState` succeeding, which requires `order.filledQuantity >=
remote.filledQuantity` — i.e. the drift is genuinely gone. Its refusal branch
leaves everything in place. **This is the "forgives again once the bot's own poll
has caught up" property, reached by the terminated door.**

### One degeneration path that is real, and the cheap guard for it

The terminated branch does **not** currently check that the order it fetched is
actually in a terminal state. `reconcile.ts:824-826` reads `getOrderStatus` and
goes straight to the age test. An order that is *absent from `getOpenOrders`* but
*still live per `getOrderStatus`* — e.g. a symbol-normalisation mismatch in
`GeminiClient.getOpenOrders`, which filters account-wide results by
`toGeminiSymbol(order.pair) === symbol` (`client.ts:355-368`) — would land here
while the bot's poll sees it live every 30 seconds forever.

Under **today's** code that is already a live-order drift reported through the
wrong door. Under the recommended fallback it would be forgiven on the first run
and escalated on the second, which is the correct and safe outcome — so the
fallback does not create the hazard and does contain it. Still, the design below
includes a one-line guard (`isTerminal(status.state)`) because the safety argument
reads better when the branch's precondition is asserted rather than assumed, and
because it costs nothing.

---

## Q6 — Other exchanges: what happens today, and what changes

**This system supports exactly two venues**, Binance and Gemini
(`src/exchange/index.ts`; there is no third client).

**Binance has a real `updatedAt`.** `binance/parse.ts:499-503`:

```ts
updatedAt:
  typeof record["updateTime"] === "number" ? record["updateTime"] : createdAt,
```

`updateTime` is present on both `/api/v3/order` and `/api/v3/openOrders`, so the
window operates on a genuine last-update time and the tolerance works as designed.
`parseCancelledOrder` uses `transactTime` — also real, and correctly documented at
`binance/parse.ts:521-524` as *"the cancellation instant … exactly the moment the
reported `filledQuantity` describes."*

**Would the proposed fix change Binance's behaviour? No — zero change.**
`updatedAt` stays present on every Binance payload, so `liveOrderFindings` takes
the identical `age <= timingWindowMs` branch it takes today, producing the
identical `order_recently_terminated` finding at the identical `minor` tier. The
fallback is unreachable on Binance. That is the point of routing on presence
rather than on a global switch, and it is directly testable (see test 4).

**One latent Binance defect, noted and deliberately not fixed here.** That
`: createdAt` fallback is the same fabrication as Gemini's, just on a branch that
has never been observed to fire. With `updatedAt` made optional, the honest form
is `...(typeof record["updateTime"] === "number" ? { updatedAt: record["updateTime"] } : {})`
— which would route a hypothetical `updateTime`-less Binance payload to the
fallback instead of silently measuring total order age. It changes nothing for any
payload Binance actually sends. **Recommended as an optional part of the same
change; flagged rather than assumed, because it touches a working venue.**

**Also affected, and worth recording as a finding entry 61 did not reach:** the
Gemini `updatedAt = createdAt` fabrication does not only disable the reconciliation
tolerance. `#foldTerminalState` stamps the local record with it
(`bot-instance.ts:2771`), and `#mirrorOrderUpdate` writes that into
`orders.updated_at` in D1 (`bot-instance.ts:5237`, `:5248`). So **every Gemini
order closed by the poll after an exchange-side cancel or expiry currently records
its own creation time as its last-update time**, in D1, where the dashboard reads
it. Narrow — it does not affect filled orders (`applyFill` uses the real
`fill.executedAt`) nor locally-cancelled ones (`parseCancelledOrder` uses receipt
time, `gemini/parse.ts:594`) — but real, and fixed for free by the same change,
since `#foldTerminalState` would take `remote.updatedAt ?? this.#now()`, i.e.
honest receipt time.

---

## Q7 — The specification

### 1. `src/shared/exchange-client.ts` — make the absence expressible

```ts
/**
 * Last change the exchange reported. For a cancellation this is the moment the
 * cancel took effect, which is exactly the instant `filledQuantity` describes.
 *
 * OPTIONAL, for the same reason `createdAt` above is: some venues do not report
 * one. Gemini's `/v1/order/status` carries a single `timestampms` — the order's
 * CREATION time — and no transition time of any kind, so its parser omits this
 * rather than echoing creation time back as though it were a last update. A
 * consumer measuring recency MUST handle its absence; see `liveOrderFindings`.
 */
updatedAt?: Timestamp;
```

### 2. `src/exchange/gemini/parse.ts` — stop fabricating

In `parseOrderStatus` (`:550-563`), delete `updatedAt: createdAt`. Rewrite the
docblock to say Gemini supplies no last-update time and that the field is
therefore absent, with a pointer to the fallback that handles it.

`parseCancelledOrder` (`:581-596`) is **unchanged**: its `updatedAt: at` is
receipt time for a cancel this system just issued, which is a real and correct
last-update instant, and its docblock already argues exactly that.

### 3. `src/durable-objects/bot-instance.ts` — two call sites absorb the absence

- `:2771` → `closeOrder(order, remote.state, remote.updatedAt ?? this.#now())`.
  Honest: the local record's "when we recorded this closed" *is* receipt time.
  Also fixes the D1 `updated_at` defect noted in Q6.
- `:5173` → `closeOrder(order, "cancelled", remote.updatedAt ?? now)`. The `now`
  parameter already exists on `#recordCancellation` and is currently discarded
  (`void now;` at `:5176`) — this is what it was for.

### 4. `src/reconciliation/reconcile.ts` — route on presence

In `liveOrderFindings`' terminated branch, replacing `:824-853`:

```ts
const status = outcome.value;

// Precondition, asserted rather than assumed: this branch exists for an order
// that LEFT the book. An order absent from getOpenOrders but still live per
// getOrderStatus is a different problem and must not be aged as a termination.
if (isTerminal(status.state) && status.updatedAt !== undefined) {
  const age = at - status.updatedAt;
  if (age >= 0 && age <= thresholds.timingWindowMs) {
    pending.push({ /* order_recently_terminated, exactly as today */ });
    continue;
  }
  pending.push(...driftAgainst(bot, local, status, `it is no longer on the book`));
  continue;
}

// NO LAST-UPDATE TIME FROM THE VENUE (Gemini). Age is not computable and must
// not be faked -- order-creation time makes the window dead, receipt time makes
// it universal. Fall through to the run-to-run memory instead, which is the
// same mechanism the live branch above uses and reads no venue clock at all.
const alreadySeen = seenUnconfirmed.has(`${bot.id}::${clientOrderId}`);
pending.push(
  ...driftAgainst(
    bot,
    local,
    status,
    alreadySeen
      ? `it is no longer on the book, and still disagreeing on a later run`
      : `it is no longer on the book`,
    alreadySeen ? "order_state_drift" : "order_drift_unconfirmed",
  ),
);
```

`isTerminal` is imported from `../shared/order-state`, which `reconcile.ts`
already imports from (`:109`).

**Nothing else changes.** `driftAgainst` (`:863-899`) already sets
`clientOrderId: local.clientOrderId` on every finding it produces, so the
structural cross-run key the memory matches on
(`reconcile.ts:276`, `:743`) is populated for terminated-branch findings with no
edit. `unconfirmedDriftFromRecentRuns` matches on `kind ===
"order_drift_unconfirmed"` without caring which branch emitted it.
`seenUnconfirmed` is already computed once per run and already passed into
`liveOrderFindings` (`:533-543`).

### The safety argument, stated as the brief asks

**It cannot become "never applies."** The first sighting of a Gemini terminated-order
disagreement is `order_drift_unconfirmed`, whose floor *and* ceiling are pinned
`minor` (`findings.ts:135`, `TIER_CEILING`). Minor raises no alert row
(`ALERTING_DRIFT_TIERS` excludes it) and halts nothing. There is no condition
under which the first sighting halts, because there is no prior audit row to find
on a first sighting.

**It cannot become "always applies."** Escalation is unconditional on the second
sighting inside the window: same order, same account, still disagreeing, becomes
`order_state_drift` at floor `meaningful`, and the bot halts. Nothing gates that
— not severity, not poll health, not magnitude, not a retry budget. The only way
to stop recurring is for the disagreement to actually go away, which requires the
bot's own poll to have applied the fill by its real id.

**It cannot be corrupted by the order-writing paths.** The signal is not stored on
the order, on the bot state, or in any Durable Object storage key. It lives in
`audit_log` rows this job writes itself, keyed on `(bot_instance_id,
client_order_id)`. `halt`, `resume`, `repairPosition`, `applyMissedFills`,
`close` and the poll can none of them write, reset, or reach it — the Q5 trace
walks each one. The only way to influence it is to make the disagreement stop
recurring, which is the intended exit.

**It reads no venue clock**, so it cannot be defeated by a venue that reports
times badly, reports them in the wrong zone, or reports none at all.

---

## Q8 — Test list

Matching the bar entries 57-61 set: each test names the condition it pins, and
the ones that matter assert the *tier* and the *halt*, not just the finding kind.

**The original bug, reproduced and fixed**

1. `reproduces the Gemini gap: a terminated order older than the window is NOT
   silently drifted past` — a Gemini-shaped status (no `updatedAt`), order
   terminated well outside 60s, first run. Assert: finding is
   `order_drift_unconfirmed` at `minor`, no `order_state_drift`, `haltedBotIds`
   empty, bot row still `running`, zero
   `reconciliation_meaningful_order_state_drift` rows — **and** the run's audit
   row carries the finding with `client_order_id` set structurally. This is the
   test that fails on today's code, where the same order produces an immediate
   meaningful halt.
2. `escalates a Gemini terminated-order disagreement on the second run` — the
   safety half. Same setup, second run inside `unconfirmedWindowMs`. Assert:
   `order_state_drift` at `meaningful`, bot halted, exactly one alert row.
3. `forgives again once the bot's own poll has caught up` — the disagreement
   resolves between runs (local `filledQuantity` now matches). Assert: no finding
   at any halting tier, however many runs follow.

**Other exchanges unaffected**

4. `leaves a venue that reports a real updatedAt exactly as it was` — Binance-shaped
   status with `updatedAt` inside the window: still `order_recently_terminated` at
   `minor` on the **first** run, never `order_drift_unconfirmed`. And outside the
   window: still `order_state_drift` at `meaningful` on the **first** run, bot
   halted — i.e. the fallback is provably unreachable when the venue supplies a
   clock. This is the regression guard the brief requires, and it should assert
   both halves in one test so a future edit cannot satisfy half of it.
5. `parseOrderStatus omits updatedAt for Gemini and keeps it for Binance` — unit
   tests in the two `parse.test.ts` files, against the captured payload
   (`gemini/parse.test.ts:455-477`) so the fixture stays the real one.

**Cannot degenerate into either rejected mode, under realistic sequences**

6. `a first sighting never halts, however large the disagreement` — the
   never-applies guard, pinning the `TIER_CEILING` pin: a full-order-quantity
   delta on a first sighting is still `minor`.
7. `a halted bot's retained order still escalates` — halt with
   `#recordCancellation` refusing (exchange reports more filled than recorded), so
   the id stays in `openOrderIds`; two reconciliation runs across the halt.
   Assert escalation still happens. Pins that the halt path cannot freeze the
   signal.
8. `applyMissedFills resolving the drift stops the escalation; failing to resolve
   it does not` — two variants in one test body, driving the repair between run 1
   and run 2. Pins both directions of fix #3/#4's repair interaction.
9. `resume does not clear an unconfirmed sighting` — halt, resume, run again
   inside the window: escalation still fires. Pins that no lifecycle transition
   launders the memory.
10. `an order the poll reads successfully but refuses to fold still escalates` —
    the `#foldTerminalState` quantity-gate case, which is the exact shape that
    would silence a real drift under any freshness-based signal. This is the test
    that would have caught the rejected per-bot `lastCleanPassAt` variant, and it
    is worth keeping even though the recommended design cannot fail it, because it
    pins the *requirement* rather than the implementation.
11. `two consecutive skipped runs reset to a first sighting, and the third run
    re-escalates` — the honest bound from Q5, asserted rather than left implicit,
    so a later change to `unconfirmedWindowMs` or `RECENT_RUN_SCAN` fails a test
    instead of quietly widening the gap.

**Harness note.** `FakeExchange` sets `updatedAt: this.now` unconditionally
(`fake-exchange.ts:249`, `:291`, `:327`), so it currently models a Binance-like
venue and **cannot express the Gemini case at all**. Tests 1-3 and 6-11 need it to
be able to omit the field — a `reportsUpdateTime = false` switch, defaulting to
today's behaviour so no existing test changes. That switch is a prerequisite for
this work, not an afterthought.

---

## Anything that contradicts entry 61

**Nothing contradicts it. Everything in it is confirmed.** `parseOrderStatus`
does set `updatedAt = createdAt`; Gemini does supply no last-update time; both
substitutes it names (creation time, receipt time) do fail in the two opposite
directions it describes; and the fix it built is genuinely venue-independent.

Three things **extend** it:

1. **The fix it built is the fix this gap needs.** Entry 61 recorded the
   terminated-order gap as needing *"a different staleness signal entirely,
   which is its own piece of work."* The investigation's conclusion is that it
   needs **no staleness signal at all** — the run-to-run memory entry 61 wrote in
   the same session, and explicitly noted as reading no venue timestamp, applies
   to the terminated branch essentially unchanged. The estimate of the work was
   larger than the work turns out to be.
2. **The gap is wider than the tolerance.** Entry 61 scoped it to reconciliation.
   The same fabricated `updatedAt` is also written into every Gemini order the
   poll closes after an exchange-side cancel or expiry, and mirrored into
   `orders.updated_at` in D1 (Q6). Narrow, but currently live, and fixed for free
   by the same change.
3. **Gemini is not entirely without temporal information.** `trades[].timestampms`
   is real, is already parsed, and would give an exact termination time for the
   fill-terminated case. Entry 61's "Gemini sends no last-update time" is correct
   about the order object and slightly overstated about the payload. It does not
   change the conclusion — the fills route covers only one of four terminal
   states — but it is the one factual detail worth correcting for the record.

---

## Rejected alternatives, with reasons

| Alternative | Rejected because |
|---|---|
| Order-creation time (today's behaviour) | Age = total order age. Window never applies to anything older than a minute. Entry 61's finding, confirmed. |
| Receipt time in reconciliation | Age ≈ 0 always. Silences real drift on every terminated Gemini order, unconditionally. Strictly worse than the bug. |
| `updatedAt = max(fills[].executedAt)` on Gemini | Provably conservative and genuinely correct for fill-terminations, but covers none of cancelled / expired / rejected-with-no-fills. One venue, two behaviours, and the harder case uncovered. Available later if ever wanted. |
| `TrackedOrder.lastObservedOpenAt`, per-order | Safe if and only if written from the DO's own clock on non-terminal reads only — but costs a storage write per open order per 30s pass, contradicts a stated design property of the no-op pass, and adds maintained state to the source-of-truth record. Superseded by a mechanism that already exists. |
| `PollSchedule.lastCleanPassAt`, per-bot | **Unsafe.** Degenerates into "always applies": `#foldTerminalState`'s refused-fold case produces clean poll passes forever on an order that is permanently terminal and permanently disagreeing. |
| Branch on `config.exchange === "gemini"` | Puts a safety decision on a string, in the module that refused exactly that twice (entries 58, 61). Fails silently on a third venue. |
| Retire the 60s window everywhere, unify on run-to-run memory | The right long-term design (Q4), and the brief's intuition about `updatedAt` being an accident is correct — but it delays a genuine Binance halt by one cron turn, which is a behaviour change to a working venue taken in the same step as a fix to a broken one. Left open, deliberately not taken. |
| Gemini private order-events websocket | Does not exist in this system. Only the public `/v2/marketdata` price socket is used. Building one to source a timestamp is far more surface than the problem justifies. |
