# DESIGN — `resume()` can leave D1 and the Durable Object permanently disagreeing

**Status:** part **3a BUILT** in the session that produced this document (write-order
reversal plus its four tests, NOT committed). Part **3b BUILT AND TESTED, NOT
DEPLOYED** — the detector, its three finding kinds and its eleven tests exist; it has
never run against a live account. Part **3c NAMED, NOT RECOMMENDED FOR THIS WORK** —
it changes kill-switch semantics and deserves its own call.

**⚠ ONE PART OF 3b's DESIGN BELOW IS SUPERSEDED BY 3b's OWN BUILD, and is left
standing as written rather than quietly edited.** PART 4 specifies that the SAFE
polarity (object not running, D1 says running) auto-corrects on FIRST sighting.
Building it showed that to be unsafe: under 3a's write order a healthy in-flight
resume presents as exactly that polarity, so correcting on sight would overwrite a
live resume and leave `running`/`halted` — the detector manufacturing the very state
it exists to find. As built, BOTH directions require two-sighting confirmation. The
reasoning is in `botStatusFindings`' own comment in `reconcile.ts`; PART 4's table is
the design as briefed, not as shipped.

**Decision log:** [entry 77](../decision-log/77.md) — the combined entry, covering
3a, 3b **and 3c** (the emergency-stop sweeps were widened in the same session,
after this document was written; see that entry's PART 4).

**Raised by:** a real, live testnet bot — `bot-gvtr1a` — not by reading code.

**The split held.** No `wrangler`, no deploy, no HTTP call, no query against real D1,
no browser, and nothing whatsoever done to `bot-gvtr1a` or any other live bot. Every
line number, count and claim below was read out of the working tree. The live facts
in PART 1 were supplied by the operator from their own reads and are labelled as such.

---

## PART 0 — THE BASELINE THIS WAS WRITTEN AND BUILT AGAINST

`HEAD` is **`b727dad`** ("Make reconciliation's terminated-order tolerance
venue-independent"). `git status --porcelain` was **empty** — a clean tree — when the
baseline suite was measured, so the baseline is the committed state with no stash
round-trip involved.

| Measurement | Figure |
| --- | --- |
| Baseline suite at `b727dad` | **111 test files passed (112) / 3195 tests passed** |
| Baseline `Errors` line | **1** — the pre-existing `vitest-pool` teardown artifact (entries 36, 55) |
| After 3a | **112 passed (113) / 3199 tests passed**, `Errors 1` |
| Delta | **+1 file, +4 tests, zero failures in either run** |

A prior investigation session supplied locations for this work. They were re-read
rather than trusted, and one had moved:

| Fact | Prior session said | Current source says |
| --- | --- | --- |
| `#resumePass`'s two status writes | `bot-instance.ts:3305` / `:3310` | **`:3305` / `:3310` — unchanged** |
| `mirrorFindings` | `reconcile.ts:653` | **`:653` — unchanged** |
| `#halt`'s already-halted early return | `bot-instance.ts:5412` | **`:5412` — unchanged** |
| The two status writes after 3a | — | **`:3352` (D1) / `:3353` (object)** |

---

## PART 1 — THE LIVE EVIDENCE

Confirmed by the operator against real testnet data. Recorded here because the whole
design rests on it and it is not reproducible from source:

- `bot_instances.status = 'halted'` in D1 for **`bot-gvtr1a`**.
- `GET /api/bots/bot-gvtr1a` returns `state.status = "running"`, `state.haltReason =
  null`, `state.haltedAt = null`, and a **current** `state.lastPriceAt` — it is
  subscribed to its price feed and receiving live prices.
- **No orders with `created_at > halted_at`.** It has placed nothing since the
  mismatch began.
- It is inert **only** because its ladder was never rebuilt (all 8 slots null). No
  safeguard is responsible for that. See PART 6 for why that is not reassuring.

This is one bot's state, but it is not one bot's bug: it is the ordinary outcome of an
interruption on a code path every halted bot goes through to come back.

---

## PART 2 — ROOT CAUSE, CONFIRMED AGAINST CURRENT SOURCE

`#resumePass` (`bot-instance.ts:3191`) wrote, in this order, before 3a:

| # | Write | Store |
| --- | --- | --- |
| 1 | `#subscribeToFeed` — fail-closed, before any status write | PriceFeed DO |
| 2 | `#mutateState → status: "running"`, `haltReason: null`, `haltedAt: null` | **Object storage** |
| 3 | `#mirrorStatus(config, "running", null, null, now)` | **D1** |
| 4 | `resolveHaltAlerts` | D1 |
| 5 | `#audit("bot.resumed", …)` | D1 |

**There is no transactional guarantee and no rollback, and none is available.**
`#mutateState` is a read-mutate-`ctx.storage.put` that is durable the moment it
returns. `#outsidePoll` (`:3187`) is a bare in-flight counter — no `try/catch`, no
compensating write. Object storage and D1 are separate systems with no cross-store
transaction on this platform. An interruption between 2 and 3 is therefore permanent
by construction, and `bot-gvtr1a`'s missing `bot.resumed` audit row (written at step 5,
after the failed step 3) is exactly the signature that predicts.

### Why THAT polarity was the dangerous one

Both emergency stops select their targets by reading D1:

- global kill switch — `kill-switch.ts:70`, `:171` — `status IN ('created','running')`
- account circuit breaker — `circuit-breaker.ts:95`, `:196` — same set

**`halted` is the one non-terminal status neither sweep selects.** So the old order's
interruption produced a bot that was genuinely live and genuinely invisible to both
controls that exist to stop it.

The two neighbouring transitions are already safe, which is why only `resume` moved:

| Transition | Interrupted state | Swept? |
| --- | --- | --- |
| `start` | object `running` / D1 `created` | **Yes** — `created` is in the set |
| `#halt` | object `halted` / D1 `running` | **Yes** — `running` is in the set |
| `resume` (old order) | object `running` / D1 `halted` | **NO** |

`resume` was the only transition able to aim its failure at the one status nothing
looks at.

---

## PART 3 — RECONCILIATION'S BLIND SPOT, RE-VERIFIED

`mirrorFindings` (`reconcile.ts:653`) iterates `snapshot.orders` and compares
`row.status === local.state && row.filled_quantity === local.filledQuantity`
(`:695`). **Per-order state only. Bot status is never compared.**

A grep of `state.status` across all non-test source returns 29 hits, **every one of
them inside `bot-instance.ts` reading its own state**. `snapshot.state.status` is read
by nothing outside the Durable Object — not reconciliation, not the API, not the
dashboard. The comparison does not exist anywhere in the repository.

This is not missing data. Reconciliation already includes halted bots
(`RECONCILED_STATUSES = created/running/halted`, `:135`) and already fetches their
snapshots. Both values are in hand on every pass; nothing compares them.

---

## PART 4 — THE FIX SHAPES, AND WHY IT IS BOTH

### 3a — reorder: D1 first, then the object *(BUILT)*

Swap steps 2 and 3. An interruption then lands on object `halted` / D1 `running`.

**Does reordering alone eliminate the dangerous direction? Yes — as of today's code,
and that is precisely why it is not enough on its own.** It holds only because `start`
and `#halt` happen to fail safe and because `halted` happens to be the excluded
status. Nothing checked any of that before this work; the two lines look
interchangeable and a reasonable person tidying up would swap them back. Hence the
ordering pin (PART 7, test 3): the invariant is now enforced by a failing test rather
than by a comment.

**It does nothing for bots already in the bad state.** `bot-gvtr1a` is unaffected by it.

### 3b — detector: compare D1 status against object status *(BUILT; see the ⚠ above — the safe polarity shipped differently)*

A new `FindingKind` raised from a bot-level comparison beside `mirrorFindings`. Closes
the blind spot regardless of write ordering, covers transitions that do not exist yet,
and repairs bots already broken.

**Alone it leaves a window.** Reconciliation runs `*/5 * * * *` (`wrangler.jsonc:167`),
so a kill-switch-invisible live bot could persist up to five minutes — and the five
minutes that matter are the ones during which someone is pulling the kill switch.

**What it does on a match — converge on the more restrictive state, always.** Never
resume from D1's opinion: that would let a mirror re-arm a bot no human authorised.

| Polarity | Action | Tier |
| --- | --- | --- |
| object `running` / D1 `halted` (dangerous) | call the existing `haltBot` port → object `halt()` → cancels orders, marks halted, mirrors D1, alerts, audits as `reconciliation` | meaningful |
| object `halted` / D1 `running` (3a's polarity) | correct **D1 from the snapshot**, object untouched — exactly what `mirror_drift`'s `correct()` already does for orders, per section 8.1 | minor |

Force-halting an object that believes it is running is **safe even when it holds a
real position**: `#halt` cancels resting orders and marks halted, and there is no
liquidating branch to reach. The position is preserved for a human, which is the same
treatment the kill switch gives every running bot in a genuine emergency.

**The real risk is the false positive, and it has a house pattern.** Reconciliation
reads D1 rows (`:211`) and object snapshots afterwards. **A healthy resume in flight
between those two reads presents as exactly this mismatch.** Halting on first sighting
would halt bots a human resumed seconds earlier — the same failure entry 57 records,
and the reason `order_drift_unconfirmed` (`findings.ts:70`) exists. So the detector
must:

1. **First sighting → an `unconfirmed` finding.** Logged into the run's findings; no
   alert, no halt.
2. **Second sighting on a later run → escalate, halt, alert.** Memory read back from
   prior runs' `audit_log.details_json`, as `seenUnconfirmed` does (`reconcile.ts:770`).
3. **Re-read the D1 row immediately before acting**, closing the narrowest version of
   the race for free.

Implementation note for that session: `seenUnconfirmed` currently hard-filters
`kind !== "order_drift_unconfirmed"` and requires a `client_order_id`. It needs a
generalisation or a parallel reader keyed on bot id — prefer the generalisation, so
there is one memory mechanism rather than two.

### 3c — widen `ACTIVE_STATUSES` to include `halted` *(NAMED, NOT FOLDED IN)*

Halting an already-halted object is a documented no-op returning `already_halted`
(`bot-instance.ts:5412`), so both sweeps could simply cover halted bots and stop
depending on mirror accuracy in either polarity. Cheap, and it targets the consequence
rather than the cause. **Costs:** every sweep touches every halted bot, and
`haltedBotIds` counts inflate, so the kill-switch result an operator reads changes
meaning. That is a semantics change to an emergency control and deserves its own
decision rather than riding along on this one.

### Verdict

**3a + 3b, in that order, as separate steps.** 3a makes the failure mode safe and
pins the invariant. 3b makes it visible and self-correcting, and is the only one of
the two that does anything for the bot that already exists.

---

## PART 5 — DOES D1-FIRST REINTRODUCE A DIFFERENT PROBLEM?

Every reader of `bot_instances.status` was traced. The question: under 3a's failure
mode — **D1 `running`, object `halted`** — does anything act wrongly?

**The load-bearing fact first: nothing anywhere flips an object to `running` because
D1 says so.** The object reads its status only from its own storage, and every
order-placing site in the system sits inside `#onPriceUpdatePass`, which returns
`ignored` before touching anything when its own state is not `running`. **D1 saying
`running` can never cause a trade.** That is structural, not incidental, and it is what
makes this the safe polarity. PART 7's test 2 asserts it behaviourally rather than by
reading a field.

| Reader | Behaviour under D1 `running` / object `halted` | Verdict |
| --- | --- | --- |
| Kill switch / circuit breaker sweeps | call `halt()` → `already_halted`, no-op | Safe — but see the wrinkle |
| `reconcile.ts` `RECONCILED_STATUSES` | includes both statuses | Unaffected |
| `startBot` / `haltBot` / `resumeBot` / `liquidateBot` / `closeBot` / `applyMissedFills` / `repairPosition` | **not gated on D1 status at all** — the object is sole authority and refuses on its own real state | Safe |
| `archiveBot` | gated on D1 `ARCHIVABLE_STATUSES`; **refuses** to archive a bot that is actually halted | Inconvenient, safe, clears once 3b converges it |
| Capital ledger (`ledger.ts:502`, `:620`, `:676`) | only ever discriminates `stopped` vs not | Unaffected |
| Research/assess concentration | counts a phantom `running` bot toward exposure | Over-counts — conservative direction |
| Dashboard | shows `running`, offers a Halt button | Cosmetic; see the wrinkle |

**The wrinkle, recorded and deliberately not fixed here.** `#halt`'s already-halted
branch returns *before* `#mirrorStatus` (`:5412`), so neither a sweep nor an operator
clicking Halt converges the two stores — D1 stays `running`. **3a's failure mode is
safe but not self-healing.** That is a second independent argument for 3b, and
convergence is left to 3b rather than widening `#halt`'s contract in the same change.

**Two further checks on the reorder itself, both clear.** `#mirrorStatus` writes
`halt_reason: null` alongside `status: 'running'`, and migration 0001's
`halt_requires_reason` CHECK is one-directional, so D1-first violates no constraint.
And steps 4–5 stay **last**, after the object write — so an interrupted resume leaves
a row saying `running` beside an unresolved critical halt alert and no audit entry:
**a visible contradiction rather than a silent one.**

---

## PART 6 — WHAT HAPPENS TO `bot-gvtr1a`

**It self-corrects on the second reconciliation pass after 3b deploys** — roughly ten
minutes at the `*/5` cadence. Pass 1 records `unconfirmed`; pass 2 confirms, halts the
object via the existing `haltBot` port, mirrors D1 (already `halted`, so the row is
unchanged), fires a halt alert with actor `reconciliation`, writes a `bot.halted`
audit row, and unsubscribes it from the price feed. **No manual action, and no new
repair tool.**

**A dedicated repair endpoint is NOT needed, and would be awkward.** The correcting
action in the dangerous polarity *is* `haltBot`, which reconciliation already holds
and already calls. And `repairPosition` / `applyMissedFills` are both halted-gated
(`:1906` — "repairing the books under a live pipeline races it"); a status-repair tool
cannot use that gate, because the object it must fix believes it is running.

Three things that are true **before** 3b exists:

1. **It may self-heal first, and silently.** Its ladder has `placed: true` with all
   slots null, and `gridDecide` (`grid.ts:721`) evaluates stop-loss and breakout from
   `ladder.levels` **before** any slot is consulted. If price crosses either level,
   `#gridExit → #halt` runs, mirrors D1 `halted`, and both stores converge on their
   own — taking the evidence with them. `heldQuantity` is zero so no liquidation sell
   would be placed. This confirms the object is live and **will act**, not merely idle.
2. **Do not archive it as a workaround.** Archive is *permitted* today because D1 says
   `halted`, and `archiveBot` then calls `close()` on an object that believes it is
   running — releasing capital under a bot that thinks it is live. It is the one
   operator action currently available that would do real damage in this state.
3. **Do not click Resume.** The object would throw `invalid_status` ("only a halted bot
   can be resumed; this one is `running`"). Harmless, but it is an action against live
   state.

---

## PART 7 — WHAT 3a ACTUALLY SHIPPED

**One source change**, `bot-instance.ts` — the two awaits swapped so `#mirrorStatus`
(D1) is observed before `#mutateState` (object), plus the comment recording the
evidence, the polarity argument, and the pointer to this document for 3b. Steps 4–5
(`resolveHaltAlerts`, the `bot.resumed` audit row) **stayed last**, unmoved.
`#halt`'s already-halted branch was **not touched**, per PART 5.

**One new test file**, `resume-write-order.test.ts` — deliberately its own file, so
`bot-instance.test.ts` is not edited at all and "every existing resume test passes
unchanged" is verifiable by the file being untouched rather than by reading a diff.

| # | Test | What it pins |
| --- | --- | --- |
| 1 | `fails closed when the D1 write fails: the object stays halted and nothing is claimed` | With D1 first, the first write's failure leaves the object `halted`, its halt reason intact, **both stores still agreeing**, the halt alert open, and no `bot.resumed` row |
| 2 | `leaves the safe direction when the object write fails: D1 running, object halted, and it trades nothing` | The aimed failure mode, with the safety claim asserted **behaviourally** — a price arrives and nothing is placed — plus a non-vacuousness control proving the same fixture DOES place an order once the object really is running |
| 3 | `pins the D1 write before the object write` | **THE ORDERING PIN.** A recording `Database` double and a `storage.put` hook capture the sequence, and independently capture what the object's own storage said at the instant of the D1 write |
| 4 | `resolves the halt alert and audits only after both status writes` | Steps 4–5 stay last: the full observed sequence is `d1:running → object:running → alert:resolved → audit:resumed` |

**Mutant: `writes swapped back to object-first`** — the exact regression 3a prevents.
**Caught, 4 of 4 tests failing.** Test 3 failed with
`expected [ 'object:running', 'd1:running' ] to deeply equal [ 'd1:running', 'object:running' ]`,
and test 1 failed with `expected 'running' to be 'halted'` — which is `bot-gvtr1a`'s
condition reproduced in a unit test.

---

## PART 8 — WHAT IS STILL NOT DONE

- **NOTHING IS DEPLOYED, and nothing is committed.** 3a and 3b both sit in the working
  tree. Until a deploy, `resume` still writes the object first on the live Worker and
  no run compares the two statuses — so every claim below about self-correction is
  about what WILL happen, not what has.
- **`bot-gvtr1a` has not been observed self-correcting.** PART 6 says it converges on
  the second reconciliation pass after 3b deploys; that has never been watched
  happening. It also remains subject to PART 6's three caveats, which are unchanged —
  in particular it may still converge on its own first, taking the evidence with it.
- **The post-collection timing gap is real and open.** `act()` runs after every
  finding is collected and classified, so a status transition landing between
  `botStatusFindings`' re-read and `act()`'s call is still possible. It is bounded by
  having had to present the identical disagreement a full run earlier, which a
  transition in flight cannot do, and it is recorded in the function's own comment —
  but it is not closed.
- **3c is not decided.** Both emergency sweeps still select on D1 status alone, so
  their correctness still depends on the mirror being right rather than being
  independent of it.
- **Neither part has ever run against a live bot.** 3a's failure paths are exercised
  by injected faults and 3b's by fake ports and one real `BotInstance`, all inside the
  Workers pool. No real interrupted resume, and no real split-brain bot, has been
  observed by either.
