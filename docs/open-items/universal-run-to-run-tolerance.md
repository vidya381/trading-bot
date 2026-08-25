# Universal run-to-run terminated-order tolerance — implementation design

**Status:** approved design, NOT built. Design-only session; no implementation code
was written and no test was run.

**Decision, already made by the operator and NOT reopened here:** reconciliation's
terminated-order forgiveness stops branching on whether a venue reports a real
last-update time. Every exchange uses the same run-to-run confirmation mechanism —
first sighting recorded and not halted, second sighting escalates and halts. No
per-exchange trust, no timestamp fast path, for Binance or any future venue. This
document is HOW, not WHETHER.

**The split held.** No `wrangler`, no deploy, no HTTP call, no query against real
D1, no browser. Every line number, count and claim below was read out of the
working tree this session.

---

## PART 0 — THE BASELINE THIS DOCUMENT WAS WRITTEN AGAINST, AND PROOF IT WAS RE-READ

`HEAD` is **`c180f08`** ("Fix the actual root cause behind order-tracking
resurrection"). `git status --porcelain` is **empty** — clean tree. Entry 68's work
is committed as **`87a1924`**, so its code is in `HEAD` rather than sitting on disk.

A prior investigation session supplied approximate locations. They were NOT trusted.
Two of them had genuinely moved, which is the evidence that the re-read happened:

| Fact | Prior investigation said | Current source says |
| --- | --- | --- |
| `closeOrder(..., remote.updatedAt ?? …)` in `#foldTerminalState` | `bot-instance.ts:2771` | **`bot-instance.ts:2853`** |
| `closeOrder(..., remote.updatedAt ?? …)` in `#recordCancellation` | `bot-instance.ts:5173` | **`bot-instance.ts:5673`** |
| Tests pinning the timestamp branch (besides the Binance guard) | "approximately 3" | **4** — enumerated in PART 4 |

Tonight's grid/order-tracking commits (`09407ff`, `c180f08`) are what moved the
`bot-instance.ts` lines. **They did not touch `reconciliation/`**: every
`reconcile.ts` and `findings.ts` line number in this document is current as read.

The measured figure is what is recorded, in both directions — the "approximately 3"
is really 4, and this document uses 4.

### 0.1 The verified baseline a build session must measure against

Measured this session, on the clean tree at `c180f08`, after an interruption forced
a full re-verification rather than a carried-over description:

| | Result |
| --- | --- |
| `npm test` | **3191 passed (3191)** tests, **111 passed (112)** files |
| Errors | **1** |
| `npm run typecheck` (`tsc --noEmit`, Worker) | **clean** |

The single error is the long-standing teardown fault — `Worker exited unexpectedly`
/ vitest-pool `close timed out` — the same condition entries 27, 67 and 68 each
recorded and each verified identical before and after their changes. **It is
pre-existing and unrelated to this design.** A build session should expect it to
persist and should verify it is identical rather than treating it as new.

Entry 68 recorded 3126 after its work; tonight's grid and order-tracking commits
(`09407ff`, `c180f08`) account for the difference. **The dashboard's own toolchain
was NOT run this session.**

**Working tree state:** clean. `git status` shows exactly one untracked file — this
document. No source file was modified by the design session that produced it.

---

## PART 1 — THE PREREQUISITE: BOUND THE RUN-HISTORY SCAN BY TIME

Ships in the SAME change. Not a follow-up.

### 1.1 The defect, stated exactly

`unconfirmedDriftFromRecentRuns` (`reconcile.ts:749-780`) is the entire memory the
escalation depends on. Today:

```ts
// reconcile.ts:756-763
const rows = await db.auditLog.findMany({
  where: { action: "reconciliation.run" },
  orderBy: [{ column: "created_at", direction: "desc" }],
  limit: RECENT_RUN_SCAN,                       // reconcile.ts:317 — 20
});

for (const row of rows) {
  if (row.created_at < at - windowMs) break;    // Ordered, so nothing older follows.
  ...
  if (details.account_label !== accountLabel) continue;   // reconcile.ts:768
```

`where` is compiled into real SQL (`table.ts:385-394`), so `LIMIT 20` applies to
`reconciliation.run` rows **across every account**. The account filter is a
post-filter in JavaScript, on `details_json.account_label` — and `audit_log` has no
account column (`schema.ts:303-310`) for it to be anything else.

One cron tick writes **one row per account**: `workers/reconciliation.ts:293` loops
`for (const account of accounts)` and each `reconcileAccount` call writes its own
`reconciliation.run` row (`reconcile.ts:256-285`). So for `A` accounts, reaching
this account's previous run requires traversing up to **2A − 1** rows. At `A = 10`
that is 19 and it just fits. **At `A ≥ 11` the scan truncates before the prior
sighting**, `alreadySeen` is permanently `false`, every run re-records
`order_drift_unconfirmed`, and **nothing ever escalates** — with no alert, because a
minor finding raises no row by design.

That is the **"always applies / never halts"** mode entry 68's design explicitly
rejected receipt-time for, reachable by scale instead of by logic. Today only Gemini
depends on this memory. **Under universal run-to-run every venue does**, which is
why this cannot ship afterwards.

### 1.2 The query builder supports a time predicate — CONFIRMED THIS SESSION, not assumed

Re-read at current source rather than carried over:

- `Comparison<TValue>` declares `{ readonly gte: TValue }` — `table.ts:57`.
- `COMPARISON_KEYS` includes `"gte"` — `table.ts:64`.
- The `default:` arm of the operator switch maps `gte → ">="` and emits
  `` `${quoted} >= ?` `` — `table.ts:248-262`.
- Multiple `where` keys are **ANDed** into one clause list — `table.ts:266-268`.
- `audit_log.created_at` is `integer()` — `schema.ts:308` — so it is neither a JSON
  column (which `table.ts:201-210` refuses to filter on) nor a money column needing
  a storage-string encode.
- `INTEGER_CODEC.encode` requires `Number.isSafeInteger` — `columns.ts:196-207`.
  `at - windowMs` is integer-ms minus integer-ms, so it satisfies this. A build
  session does not need a cast or a guard.

**No migration is needed, and the new query is cheaper rather than more expensive.**
`migrations/0001_initial_schema.sql:345` already creates
`idx_audit_log_created ON audit_log (created_at)`, and there is **no index on
`action`**. Today's query therefore walks `created_at` backwards filtering on
`action` until it accumulates 20 matches — unbounded in how far it may walk. With
the predicate it becomes a bounded index range.

### 1.3 The change, specified

**(a) Add the time predicate to the WHERE clause.**

```
where: { action: "reconciliation.run", created_at: { gte: at - windowMs } },
```

**(b) Raise the cap. ⚠ THE TIME BOUND ALONE DOES NOT FIX THE DEFECT.**

This is the one place the prerequisite as briefed is incomplete, and a build session
that implements only (a) will ship a change that still fails at `A ≥ 11`.

`LIMIT` is applied *after* `WHERE` and *after* `ORDER BY created_at DESC`. Each tick
writes its `A` rows near-simultaneously, so with a 600s window holding two ticks
(`2A` rows), `LIMIT 20` at `A = 20` returns **the current tick's 20 rows and none of
the previous tick's** — the prior sighting is still missed, now for a different
reason. For time to be the real bound, the cap must be high enough that it never
binds in realistic operation.

- **`RECENT_RUN_SCAN` → `RECENT_RUN_SCAN_CAP`, value `500`.** The rename is
  load-bearing: the current name says "how far back we look", which is exactly the
  misreading that produced the defect. The new name says it is a ceiling, not a
  bound.
- **The headroom arithmetic, to be stated in the constant's comment:**
  rows in the window = `A × (unconfirmedWindowMs ÷ cron interval)` = `A × (600s ÷ 300s)`
  = `2A`. A cap of 500 therefore supports **250 accounts**, against the ~10 the old
  value supported.
- The cap's remaining job is a memory ceiling on a pathological `audit_log`, not a
  correctness bound.

**(c) Delete the `break` at `reconcile.ts:763`.**

With the predicate in SQL, that line is unreachable. Leaving it means two things
both claim to be the time bound and a reader cannot tell which one is real — the
precise confusion this fix exists to end. Its replacement comment must state that
the bound is now the SQL predicate. *(The alternative — keep it as belt-and-braces —
was considered and declined: mutant M-B in PART 8 covers the regression it would
guard against, and it covers it loudly, which a silent second bound does not.)*

**(d) Pin the headroom in a test, not only in a comment.** Specified in PART 7.3.

### 1.4 What is deliberately NOT done here

**No alert when the cap binds.** A finding fired on `rows.length === CAP` would
convert the residual silent failure into a loud one, and that is genuinely
attractive. It is declined because it requires a **new `FindingKind`**, which drags
in `TIER_FLOOR`, `TIER_CEILING`, a new `reconciliation_*` alert type and its
standing-alert lifecycle — a wider blast radius than a defect that now needs 250
accounts to reach. The headroom test in PART 7.3 is the cheaper guard, and it fails
at build time rather than in production. **Recorded here so a build session does not
re-decide it, and so a future reader knows it was considered rather than missed.**

---

## PART 2 — THE EXACT CODE TO REMOVE

All line numbers verified against `reconcile.ts` at `c180f08` (1770 lines).

### 2.1 The branch itself — `reconcile.ts:856-896`, one contiguous block

| Lines | What | Fate |
| --- | --- | --- |
| 856-864 | The `// THE BRANCH IS ON DATA PRESENCE…` comment | **Delete**, replaced per 2.3 |
| 865 | `if (status.updatedAt !== undefined) {` | **Delete** |
| 866-870 | The "A REAL LAST-UPDATE TIME (Binance's `updateTime`)" comment | **Delete** |
| 871 | `const age = at - status.updatedAt;` | **Delete** |
| 872-892 | `if (age >= 0 && age <= thresholds.timingWindowMs) { … continue; }` — the whole `order_recently_terminated` push | **Delete** |
| 894 | `pending.push(...driftAgainst(bot, local, status, \`it is no longer on the book\`));` | **Delete** |
| 895-896 | `continue;` and the closing `}` | **Delete** |

Everything from `reconcile.ts:933` (`const alreadySeenTerminated = …`) through `:946`
survives **unchanged in behaviour**, and becomes the only path. It is already correct
for every venue; nothing about it is Gemini-specific except the prose noted in 2.3.

### 2.2 The signature narrowing — this is the part that makes the invariant structural

After 2.1, two parameters of `liveOrderFindings` have **zero remaining readers**.
Verified by reading the whole function body (`reconcile.ts:780-950`), not by grep
over the file:

- **`at: Timestamp`** (`reconcile.ts:785`) — its only use in the entire function is
  line 871. Confirmed: an `awk` sweep of lines 780-950 finds `at` on exactly two
  lines, the parameter declaration and line 871.
- **`thresholds: DriftThresholds`** (`reconcile.ts:786`) — used only at lines 872
  and 885, both inside the deleted block.

So the signature goes from seven parameters to five:

```
liveOrderFindings(ports, bot, snapshot, remoteOpen, seenUnconfirmed)
```

and the call site at `reconcile.ts:528-537` drops the `at` and `thresholds`
arguments.

**Do this rather than leaving the parameters unused.** After it, the function that
decides whether to halt a bot over a terminated order **has no clock of any kind in
scope** — not the venue's, not the worker's. The invariant stops being a convention a
future edit could quietly violate and becomes something the compiler enforces:
reintroducing a timestamp comparison here requires first re-plumbing a clock in,
which is a visible, reviewable act rather than a one-line slip.

`reconcileOrders` keeps its `thresholds` parameter — it still reads
`thresholds.unconfirmedWindowMs` at `reconcile.ts:467`.

### 2.3 The comment that replaces both blocks — `reconcile.ts:898-932`

The surviving 35-line comment is written for a Gemini-only fallback and is now
wrong in three specific ways. It must be rewritten, not left:

1. It opens `// NO LAST-UPDATE TIME FROM THE VENUE (Gemini).` — the branch is no
   longer conditional and no longer about Gemini.
2. Lines 923-925 say the worst case is halting *"one five-minute cycle later than it
   would on Binance"* — there is no longer a Binance path to be later than.
3. Lines 927-932 present the loss of `order_recently_terminated` as specific to *"a
   clockless venue"* — it is now universal, and under PART 5 the kind ceases to exist.

**What the replacement must say**, so the reasoning survives the code that carried it:

- The rule, stated once and positively: **venue clocks may inform records, never
  decisions.** Reconciliation's halt/forgive outcome does not read `updatedAt` on any
  venue.
- Why *"how long ago did this terminate"* is not asked at all any more, retaining
  entry 68's two rejected substitutes (creation time → the window never applies;
  receipt time → it always applies, silencing real drift) as the record of why no
  timestamp answers it — these remain the reason the question was abandoned rather
  than re-answered.
- Both failure modes closed, restated for the universal case: it cannot become
  "never applies" because a first sighting has no prior audit row by construction and
  `order_drift_unconfirmed`'s ceiling is **pinned** at minor (`findings.ts:248`); it
  cannot become "always applies" because the second sighting escalates with nothing
  gating it — no severity check, no poll-health check, no retry budget.
- The cost, stated plainly rather than elided: a genuine persistent drift now halts
  **at most one ~5-minute cycle later than the timestamp path did**, never
  indefinitely — the identical trade entry 61 already made for the live branch after
  zero-forgiveness halted two real bots (`reconcile.ts:729-733`).
- That `driftAgainst` returns `[]` on a match (`reconcile.ts:966-968`), so an order
  that terminated and AGREES still produces no finding at all. The tolerance is about
  disagreements only.

### 2.4 The detail string at `reconcile.ts:942-943`

The first-sighting prose currently reads *"…and this venue reports no last-update
time, so whether it terminated recently is decided by whether a later run still finds
it."* The first clause becomes false for Binance. Reword to drop the venue claim and
keep the mechanism: the sighting is unconfirmed and a later run decides.

**This string is human-facing only.** Nothing matches on it — the escalation matches
on the structural `client_order_id` field (`reconcile.ts:276`, read at
`reconcile.ts:772`), which is entries 58 and 61's refusal to put a safety decision on
prose. A build session may reword freely; it may **not** start matching on it.

---

## PART 3 — THE PINNED TEST THAT MUST DELIBERATELY BREAK

`reconcile.test.ts:1689` — `"BINANCE IS UNAFFECTED: a real updateTime keeps both
halves of its window"`. Entry 68 built it precisely so this change could not be made
silently. It has done its job. It is **rewritten, not deleted.**

### 3.1 The trap in the obvious rewrite

The original body runs `reconcileAccount` **twice** (`:1701` and `:1714`) against the
same bot and the same `clientOrderId`, relying on each run being independent because
the window decided each one from scratch.

Under run-to-run they are **not** independent: run 1 writes an
`order_drift_unconfirmed` finding into `audit_log`, and run 2 reads it back as a
second sighting. A rewrite that only flips the assertions in place would have half
two halt for the wrong reason — because it is the second sighting, not because of
anything a timestamp did — and would still pass. It would look like a test and assert
nothing about the change.

### 3.2 The fix: invert the order of the two halves

Run the **outside-the-old-window** case FIRST, on the fresh memory, then the
**inside-the-old-window** case as the second sighting. Both assertions then flip, and
the memory carry-over becomes the subject of the test instead of an obstacle to it.

The combination is what proves the property: **an old timestamp no longer condemns
the order, and a young one no longer saves it.**

### 3.3 The rewritten test, specified

**Name:** `BINANCE IS NOW LIKE EVERY VENUE: a real updateTime changes nothing, in
either direction`

**Placement:** stays in the `describe` at `reconcile.test.ts:1519`, whose title must
change from `"a terminated order on a venue that reports no last-update time"` to
something venue-neutral — the whole block is no longer about a venue class.

**Setup:** `exchange.reportsUpdateTime = true` — deliberately the timestamp-reporting
fake, because the point is that it now makes no difference. Reuse the existing
`driftingTerminatedOrder()` helper (`reconcile.test.ts:1551`) and the surrounding
`beforeEach` (`:1520-1548`) unchanged.

**HALF ONE — an OLD, real `updateTime`, far outside the retired 60s window. This
assertion flips: it used to halt on the first run.**

```
exchange.now = T0 - 600_000;          // ten minutes: the old window would condemn it
driftingTerminatedOrder();
const first = await reconcileAccount(ports(), ACCOUNT);
```

Assert:
- a finding of kind `order_drift_unconfirmed` exists, and its `tier` is `minor`
- no finding of kind `order_state_drift`
- `first.haltedBotIds` is `[]`, the `halted` port array is `[]`, and the bot row's
  `status` is still `"running"`
- **no alert row** of type `reconciliation_meaningful_order_state_drift`
- the run's `audit_log` details carry `client_order_id === "v1-dca-btc-1-0"` on the
  unconfirmed finding — asserted **structurally**, matching `:1615-1624`, because that
  field is what half two matches on

**HALF TWO — a YOUNG, real `updateTime`, well inside the retired 60s window. This
assertion also flips: it used to be forgiven as `order_recently_terminated` forever.**

```
exchange.now = T0 - 5_000;            // five seconds: the old window would forgive it
const second = await reconcileAccount(ports(), ACCOUNT);
```

Assert:
- a finding of kind `order_state_drift`, `second.tier === "meaningful"`
- `second.haltedBotIds` equals `["dca-btc-1"]` and the bot row's `status` is `"halted"`
- exactly **one** alert row of type `reconciliation_meaningful_order_state_drift`,
  whose message matches `/still disagreeing on a later run/`

**The assertion that ties both halves to the actual change, and must appear in
both:**

```
expect(first.findings.some((e) => e.kind === "order_recently_terminated")).toBe(false);
expect(second.findings.some((e) => e.kind === "order_recently_terminated")).toBe(false);
```

A fresh five-second-old termination on a venue reporting a real transition time is
the single strongest case the old window had. It must now produce a halt. If it does
not, the timestamp is still being consulted somewhere.

**Why both halves stay in one body**, exactly as entry 68 wrote it: a future edit
must not be able to satisfy half of this. Split into two tests, one could be deleted
or skipped while the other kept passing, and the property — *the outcome does not
depend on the timestamp* — is a statement about the pair, not about either half.

---

## PART 4 — THE OTHER TESTS THAT PINNED THE TIMESTAMP BRANCH

**Four, not the three the prior investigation estimated.** Each identified from
current source and each specified below. All four currently pass and all four will
fail after PART 2.

### 4.1 `reconcile.test.ts:332` — `"treats an order that left the book inside the timing window as a late fill"`

Sets `exchange.now = T0 - 5_000` and expects `order_recently_terminated` at `minor`
with no halt (`:369-372`).

**Becomes:** `"a terminated order is unconfirmed on its first sighting, whatever the
venue's clock says"`. Same setup, same 5-second age. Assertions change to
`order_drift_unconfirmed` / `minor` / `haltedBotIds === []`, plus an explicit
`order_recently_terminated` **absent** assertion. The tier and halt outcome are
unchanged, which is worth keeping visible: forgiveness on the first sighting is not
what this change takes away.

### 4.2 `reconcile.test.ts:375` — `"does NOT treat the same order as minor once it is outside the window"`

Sets `exchange.now = T0 - 600_000` and expects `order_state_drift` / `meaningful` /
`haltedBotIds === ["dca-btc-1"]` on the **first** run (`:412-414`). **This is a
genuine behaviour change, not a rename** — a first sighting no longer halts.

**Becomes:** `"a terminated order still halts, one run later"`. Keep the ten-minute
age. Add a second `reconcileAccount` call. Assert the first run is minor and does not
halt, and the second run carries `order_state_drift` / `meaningful` /
`haltedBotIds === ["dca-btc-1"]`. The original's whole point — that an old
termination is not forgiven indefinitely — survives intact; only *when* it is
enforced moves by one run.

### 4.3 `reconcile.test.ts:1498` — `"leaves the TERMINATED-order branch exactly as it was"`

Entry 61's own regression guard. Its comment (`:1499-1502`) asserts in words that
*"the 60s `timingWindowMs` and its `order_recently_terminated` finding are
deliberately untouched by this step"*, and it advances the clock by
`DEFAULT_DRIFT_THRESHOLDS.timingWindowMs + 1` (`:1504`) to prove drift on the first
run. **Its premise is exactly what this change reverses.**

**Becomes:** `"the terminated branch and the live branch now share one mechanism"`.
Drop the `timingWindowMs` clock advance entirely — there is no window to step over.
Keep what entry 61 actually cared about, which is that `driftAgainst` is shared and
that the terminated case is not silently inheriting a different tolerance from the
live case: assert that a terminated disagreement and a live disagreement produce the
**same** kind on the first sighting (`order_drift_unconfirmed`) and the **same** kind
on the second (`order_state_drift`). The test is strictly stronger after the rewrite
than before it, because sameness is now the property rather than difference.

### 4.4 `reconcile.test.ts:1559` — `"PINS THE BUG: a fabricated updatedAt halts on the first sighting, with no forgiveness"`

Entry 68 wrote this to *"pin the MECHANISM being replaced"* and noted it
**deliberately still passes** after that fix. Under this change it stops passing:
with `reportsUpdateTime = true` and a ten-minute-old fabricated timestamp, the first
sighting is now `order_drift_unconfirmed` and nothing halts.

**Becomes — and this is the most valuable rewrite of the four:**
`"THE BUG CLASS IS DEAD: a fabricated updatedAt is now harmless"`.

Same setup, byte for byte — `reportsUpdateTime = true`, `exchange.now = T0 - 600_000`,
which is the original Gemini payload exactly: a venue reporting a last-update time
whose value is really the creation instant. Assertions invert to: no halt on the
first sighting, `order_drift_unconfirmed` at `minor`, and escalation on a second run.

The test stops being a museum piece and becomes the direct proof of the change's
whole purpose: **the payload that caused the original defect is fed in unchanged, and
the outcome is now correct anyway.** That is the property that makes a new exchange
safe on day one, asserted against the exact payload that proved it was not.

---

## PART 5 — `timingWindowMs` AND `order_recently_terminated`

**Recommendation: remove both, entirely. No "no longer read" comment.**

### 5.1 Containment, reconfirmed this session

`timingWindowMs` — **11 references in `src`, 3 of them in tests**:
`findings.ts:372` (the `DriftThresholds` member), `findings.ts:405` (the 60_000
default), `findings.ts:121` and `findings.ts:398` (comments), `reconcile.ts:872` and
`reconcile.ts:885` (both deleted by PART 2), and `reconcile.test.ts:1499`, `:1504`,
`:1712` (all inside tests PART 3 and PART 4 already rewrite). **Zero references in
`dashboard/`. Zero in `migrations/`.**

`order_recently_terminated` — `findings.ts:63` (the union member), `findings.ts:123`
(`TIER_FLOOR`), `findings.ts:239` (`TIER_CEILING`), `reconcile.ts:878` and `:928`
(deleted by PART 2), `reconciliation/README.md:44` (a table row), and in tests
`findings.test.ts:83`, `findings.test.ts:227`, plus the reconcile tests already being
rewritten. **Zero references in `dashboard/`. Zero in `migrations/`.**

### 5.2 Why removal is safe against persisted data — checked, not assumed

- **No D1 CHECK constraint names either.** Neither string appears anywhere in
  `migrations/`.
- **No `alerts.alert_type` row can contain the kind.** `TIER_FLOOR` and
  `TIER_CEILING` both cap `order_recently_terminated` at `minor`/`meaningful`, and
  the raise path only calls `reconciliationAlertType` for `severe`
  (`reconcile.ts:1641`) and `meaningful` (`reconcile.ts:1670`) findings.
  `resolveClearedAlerts` filters `tier !== "minor"` before building its key set
  (`reconcile.ts:379-386`). A finding that reaches this kind is minor in practice and
  never produced a row.
- **Nothing maps a stored kind string back onto the union.** `FindingKind` is
  imported in exactly two places outside `findings.ts` — `reconcile.ts:120` and two
  doc-comment mentions in `shared/alert-types.ts:51,107`. Historical
  `audit_log.details_json` rows containing the string stay readable: that column is
  typed `unknown` and the only code that inspects finding kinds inside it compares
  against a string literal (`reconcile.ts:770`).

### 5.3 The reasoning

A dead threshold and an unreachable finding kind left in place inside a **safety**
module are worse than the deletion churn. `timingWindowMs` would sit in
`DriftThresholds` next to three live members, documented at `findings.ts:398` as *"a
comfortable multiple of the round trip … so a genuinely stuck order cannot hide
inside the window"* — a sentence describing a mechanism that no longer exists, in the
file a future reader opens to learn what the thresholds do. `order_recently_terminated`
would sit in the `FindingKind` union with entries in both classification tables,
indistinguishable from the kinds that actually fire.

The whole point of this change is that a new exchange integration has nothing to get
right. Leaving behind the vocabulary of the retired mechanism reintroduces exactly the
judgement call — "is this the live path or the dead one?" — one level down.

Both tables are `Readonly<Record<FindingKind, …>>`, so removal is compiler-checked:
delete the union member and `tsc --noEmit` names every table that still has an entry.

### 5.4 The removals, enumerated

| File | Change |
| --- | --- |
| `findings.ts:372` | remove `timingWindowMs` from `DriftThresholds` |
| `findings.ts:405` | remove `timingWindowMs: 60_000,` from `DEFAULT_DRIFT_THRESHOLDS` |
| `findings.ts:396-400` | remove the `timingWindowMs at 60s` paragraph from the defaults comment |
| `findings.ts:119-123` | remove the `order_recently_terminated` `TIER_FLOOR` entry and its justification |
| `findings.ts:237-239` | remove the `order_recently_terminated` `TIER_CEILING` entry and its justification |
| `findings.ts:63` | remove `\| "order_recently_terminated"` from `FindingKind` |
| `findings.test.ts:83, :227` | remove the two assertions naming the kind |
| `reconciliation/README.md:44` | remove the table row |

**One thing must NOT be removed:** `unconfirmedWindowMs` and its 600s default
(`findings.ts:412`). It becomes more load-bearing, not less — it is now the only
time bound in the mechanism, and PART 1 puts it into the SQL.

---

## PART 6 — THE BINANCE PARSER'S FABRICATION

```ts
// exchange/binance/parse.ts:499-502
// Present on both endpoints, but defaulted to creation time rather than
// failing: an order that has never been updated is not an error.
updatedAt:
  typeof record["updateTime"] === "number" ? record["updateTime"] : createdAt,
```

**Recommendation: SEPARATE change, shipped AFTER this one. Not bundled.**

### 6.1 Why not bundled — reasons of risk and evidence, not convenience

1. **Entry 68 measured that these two layers do not cover each other.** Its mutant M1
   (restore the Gemini fabrication) was killed by **2 tests, both parser-level**; the
   reconciliation tests did not catch it, because they drive `FakeExchange` rather
   than the real parser. The converse holds too. Bundling produces one commit whose
   blast radius spans two layers that provably cannot verify each other — and if a
   live problem follows, the bisect cannot separate "reconciliation stopped halting
   when it should" from "the parser changed what it reports".
2. **They surface in different places and the operator verifies them differently.**
   This change is observable as halt timing in alerts and audit rows. The parser fix
   is observable as `orders.updated_at` values in D1 and the dashboard column that
   reads them. One is a safety-behaviour verification; the other is a data-quality
   verification against live rows. They want separate live confirmations.
3. **Bundling undercuts the very independence being established.** The point of this
   change is that reconciliation no longer depends on what any parser reports about
   time. Shipping a parser correction inside it invites the reading that the parser
   fix was *needed* for the safety change. It is not — and shipping it separately is
   what demonstrates that.
4. **It is not urgent.** `updateTime` is documented as present on both Binance
   endpoints, and the fallback has never been observed to fire. Entry 68 reached the
   same conclusion and deliberately left it.

### 6.2 What the separate change looks like, so it is not lost

- `binance/parse.ts:499-502`: omit the key when `updateTime` is absent, exactly as
  `gemini/parse.ts` does — `...(typeof record["updateTime"] === "number" ? { updatedAt: record["updateTime"] } : {})`
  — with the `shared/exchange-client.ts:299-327` reasoning cited rather than restated.
- **Both consumers already tolerate absence**, verified this session:
  `bot-instance.ts:2853` and `bot-instance.ts:5673` both read
  `remote.updatedAt ?? <receipt time>`. That is entry 68's PART 4 fix, and it is
  already venue-agnostic.
- `binance/parse.test.ts:474-478` — `"falls back to creation time when no update time
  is present"` — is the test pinning the fabrication. It **inverts** to assert the key
  is absent, and must assert `"updatedAt" in status === false` as well as
  `toBeUndefined()`, because absent and present-and-undefined differ across a JSON
  round trip into storage (entry 68's reasoning, applied to the other venue).

### 6.3 ⚠ One thing this change MUST do to `binance/parse.test.ts`, even though the parser is untouched

`binance/parse.test.ts:481` — `"REPORTS A REAL updateTime, distinct from creation
time"` — keeps passing and should be kept: a parser reporting a real value truthfully
is still correct and still worth pinning.

But its comment (`:486-491`) says *"Binance is the venue whose behaviour must not
change: it reports its transitions honestly, so reconciliation keeps computing a real
age from this value and keeps its 60-second window. Whether that window should
eventually be retired … is a live design question and deliberately NOT decided here."*

**Every clause of that is false after this change.** The comment must be rewritten in
this change — a passing test carrying a false explanation is how the next reader
learns something wrong from a green suite. The replacement should say that the value
is parsed truthfully because it is written to `orders.updated_at` as a record, and
that **no safety decision reads it on any venue.**

---

## PART 7 — TEST COVERAGE FOR THE PREREQUISITE

The memory scan has **no test today** — `RECENT_RUN_SCAN` appears exactly twice in
`src`, at its declaration (`reconcile.ts:317`) and its use (`reconcile.ts:759`), and
nowhere in any test.

### 7.0 The method: prove the bug before proving the fix

Following this project's established pattern, and note the difference from entry 68's
`PINS THE BUG` test, which was written to keep passing because it pinned a mechanism
being *replaced*. These pin a defect being *removed*, so they must **fail before the
fix and pass after it**.

**Required of the build session:** write 7.1 first, run it against unmodified source,
and **record the actual failure output** in the decision-log entry. A test that has
never been seen to fail has not been shown to test anything.

All three tests use direct `db.auditLog.insert` with `auditLogRow` overrides
(`db/test-helpers.ts:218`) to synthesise other accounts' run rows. Driving real
`reconcileAccount` calls for filler accounts would work but would couple the test to
everything else reconciliation does; the scan reads only `action`, `created_at` and
`details_json`, so synthesising rows tests the bound and nothing else.

The exact `details_json` shape the scan reads (`reconcile.ts:764-773`, written at
`reconcile.ts:262-277`):

```
{ account_label: "<label>", findings: [ { kind, bot_instance_id, client_order_id, … } ] }
```

### 7.1 `PINS THE PREREQUISITE: escalation survives other accounts filling the row budget`

The core test, and the one that must be watched failing first.

1. `seedBot("dca-btc-1")` and set up a terminated disagreement via the existing
   `driftingTerminatedOrder()` shape.
2. Run `reconcileAccount(ports(), ACCOUNT)` once — the genuine first sighting, which
   writes this account's real `order_drift_unconfirmed` row.
3. Insert **30 filler `reconciliation.run` rows** for other accounts
   (`account_label: "other-1" … "other-30"`), each with `created_at` set **strictly
   newer** than the real run's row and **inside** `unconfirmedWindowMs`. Thirty
   comfortably exceeds the old cap of 20 and models an 11+ account deployment.
4. Advance `clock` by one cron interval (300_000) and run `reconcileAccount` again.

**Assert the escalation happened:** `order_state_drift` present, `tier` is
`"meaningful"`, `haltedBotIds` is `["dca-btc-1"]`, and one alert row matching
`/still disagreeing on a later run/`.

**Before the fix this fails**, with the second run producing `order_drift_unconfirmed`
and no halt, because the filler rows push the real sighting past `LIMIT 20`. That
failure is the defect, reproduced.

### 7.2 `the time bound still has an upper edge, at high row counts`

Guards the opposite direction: that the fix did not simply widen the scan until
nothing ever ages out. `reconcile.test.ts:1484` covers the window's upper edge for the
live branch today, but only at low row counts and only through the JS `break` that
PART 1 deletes.

Same shape as 7.1, but advance the clock past `unconfirmedWindowMs + 1` before the
second run. Assert the second run produces `order_drift_unconfirmed` and does **not**
halt — an ancient sighting must not escalate a fresh disagreement.

This is what proves the SQL predicate carries the semantics the deleted `break`
carried, rather than the bound simply being gone.

### 7.3 `the scan cap does not bind at the documented supported account count`

Pins PART 1's headroom arithmetic in a test rather than only in a comment, so raising
the account count past what the cap supports fails the suite instead of failing
silently in production.

Export `RECENT_RUN_SCAN_CAP` for the test (or assert against it via a small exported
helper), and assert the relationship directly:

```
SUPPORTED_ACCOUNTS × (unconfirmedWindowMs ÷ CRON_INTERVAL_MS) ≤ RECENT_RUN_SCAN_CAP
```

with `SUPPORTED_ACCOUNTS` a named constant in the test carrying the documented figure
(250) and a comment saying that lowering the cap or raising the window means raising
the cap. Pure arithmetic, no D1 needed.

*(The cron interval is `*/5 * * * *` in `wrangler.jsonc:167` and `:283`. It is not a
TypeScript constant today; the test should carry it as a named local with a comment
pointing at those lines rather than inventing a shared constant for this alone.)*

---

## PART 8 — THE MUTATION SET

Six mutants. For each: what to change, and which tests must kill it. Entry 68's
convention applies — apply one mutant at a time and **restore it before applying the
next**, since that entry recorded a doubly-mutated file overstating coverage
fivefold in the flattering direction.

### M-A — restore the timestamp-presence branch

Reinstate `if (status.updatedAt !== undefined) { … }` with its window, verbatim from
`c180f08`.

**Must be killed by:** PART 3's rewritten Binance test (both halves — half one would
halt on the first run again, half two would be forgiven as
`order_recently_terminated`), PART 4.1, PART 4.2 and PART 4.4. Expect **at least 4**
killers. If PART 3's test alone does not kill it, the rewrite has the ordering wrong —
go back to 3.1.

### M-B — remove the SQL time predicate, reverting to row-count-only

Drop `created_at: { gte: at - windowMs }` from the `where`.

**Must be killed by:** PART 7.1. Should also be killed by PART 7.2 **only if** the JS
`break` was deleted per PART 1(c) — with the `break` still present, the upper edge
survives and 7.2 passes. **This is the measurement that proves the `break` really was
redundant**, and its result should be recorded either way.

### M-C — restore the cap to 20

`RECENT_RUN_SCAN_CAP = 20`, time predicate left in place.

**Must be killed by:** PART 7.1 and PART 7.3. This is the mutant that exists because
the brief's framing was incomplete: it is the proof that the time predicate alone
does not fix the defect, and it must be run and recorded even though it looks
redundant next to M-B.

### M-D — re-fabricate Binance's `updatedAt` from creation time

Assuming PART 6's parser fix has NOT shipped, this mutant instead **removes** the
`?? createdAt` fallback's alternative — i.e. force `updatedAt: createdAt`
unconditionally in `binance/parse.ts:501-502`.

**Expected result is deliberately asymmetric, and the asymmetry is the point:**

- **Killed by parser tests** — `binance/parse.test.ts:481` (`"REPORTS A REAL
  updateTime, distinct from creation time"`), which is exactly the layering entry 68
  measured for M1.
- **NOT killed by any reconciliation test**, and it must not be. **A reconciliation
  test killing this mutant would be a FAILURE of this design**, because it would mean
  a halt decision still depends on what the parser reports about time. Surviving the
  reconciliation suite is the positive proof that the change achieved its purpose.

Record both halves of that result explicitly. This is the one mutant whose *survival*
in one suite is the desired outcome.

### M-E — always escalate on the first sighting

Replace `alreadySeenTerminated ? "order_state_drift" : "order_drift_unconfirmed"`
(`reconcile.ts:944`) with `"order_state_drift"` unconditionally — entry 61's
false-halt failure mode, reintroduced.

**Must be killed by:** PART 3's half one, PART 4.1, PART 4.2's first-run assertion,
PART 4.4, and the surviving entry-68 tests at `reconcile.test.ts:1589` and `:1670`.

### M-F — never escalate

Replace the same expression with `"order_drift_unconfirmed"` unconditionally — the
"silences real drift forever" mode.

**Must be killed by:** PART 3's half two, PART 4.2's second-run assertion, PART 4.4's
escalation assertion, PART 7.1, and `reconcile.test.ts:1627`.

M-E and M-F together are the pair that proves the mechanism cannot collapse in either
direction. Both must be run; a design that only closes one of them is the failure
entry 68 spent a section describing.

---

## PART 9 — THE SAFETY ARGUMENT

Does this reintroduce anything the project has already fixed? Taken one at a time,
argued rather than asserted.

### 9.1 Entry 61's false-halt problem — NOT reintroduced; extended to cover more cases

Entry 61 fixed live-order drift halting a bot on the first sighting of a
disagreement the bot's own 30-second poll was about to resolve. That is the failure
that halted `bot-b23y63` and `bot-bl4e7c` (`reconcile.ts:729-733`).

This change **removes the last remaining first-sighting halt** in
`liveOrderFindings`. Today the terminated branch on a timestamp-reporting venue still
halts on the first sighting whenever `age > timingWindowMs` — `reconcile.test.ts:375`
and `:1498` both assert exactly that, and PART 4 rewrites both because it stops being
true. After this change no path in the function halts a bot on a first sighting.

**It also closes a false-halt case the window could not.** `age = at - status.updatedAt`
subtracts a venue clock from the worker clock, and the guard is `age >= 0 && age <= …`
(`reconcile.ts:872`). A venue clock running **fast** yields a negative age, fails the
guard, and halts immediately — on precisely the fresh termination the window exists to
forgive. A skewed venue clock therefore converts the tolerance into its opposite, and
`ClockOffset` does not help: it corrects request timestamps for signing, not parsed
`updateTime`. The run-to-run mechanism reads no venue clock and cannot be skewed.

Direction of travel: **strictly fewer false halts than today, on every venue.**

### 9.2 Entry 68's rejected "silent forgiveness forever" mode — NOT reintroduced, and this is the load-bearing argument

Entry 68 rejected receipt-time because `age` would always be ≈ 0, the window would
**always** apply, and real persistent drift would be silenced on every terminated
order, unconditionally — *"strictly worse than the bug it would replace, because the
bug is loud and this is silent."*

This change does not substitute any timestamp. It removes the age computation. The
escalation is gated on one fact only: whether a run of this account inside
`unconfirmedWindowMs` already recorded an `order_drift_unconfirmed` finding for the
same `${botInstanceId}::${clientOrderId}`. Two properties close the mode, and both are
enforced rather than intended:

- **A first sighting cannot halt** — `order_drift_unconfirmed`'s ceiling is **pinned**
  at `minor` (`findings.ts:248`), so magnitude cannot promote it. `reconcile.test.ts:1670`
  asserts this at `floor`, `tier` and `escalated` on a disagreement that is the whole
  order quantity.
- **A second sighting halts unconditionally** — no severity check, no poll-health
  check, no retry budget (`reconcile.ts:933-946`).

So the worst case for a genuine persistent drift is **one ~5-minute cycle of delay**,
never forgiveness twice. M-F in PART 8 exists to keep that true.

### 9.3 The one place this design DID find that mode reachable — and closes it

Honest statement of the real risk, which is not in entry 68 or in the prior design
document.

The "never escalates" mode **is** reachable today, not through the timestamp but
through the memory. PART 1.1 traces it: at `A ≥ 11` accounts the row-limited scan
cannot see the prior sighting, `alreadySeen` is permanently `false`, and escalation
stops with no alert. That is entry 68's rejected mode, arrived at by a different road.

Two facts make this a prerequisite rather than a nice-to-have:

1. **Today only Gemini rides the memory. After this change every venue does.** The
   change removes Binance's independent escalation path, so a defect currently
   affecting one venue's terminated orders would become the only escalation path there
   is.
2. **Adding exchanges is what triggers it.** Accounts are registered per exchange
   (`accounts.exchange`, `schema.ts:100`; dispatch at `workers/reconciliation.ts:293-334`),
   so the account count grows exactly as the operator adds the venues this whole change
   is being made for. The failure would arrive on the same day as the thing it was
   meant to make safe.

With PART 1 (time predicate **and** raised cap) and PART 7's three tests, the bound
is the documented 600s window, the cap has 25× headroom, and the headroom is pinned
by a test rather than by a comment.

### 9.4 What is genuinely given up, stated plainly

An accurate timestamp measures *"has the other observer had its turn yet"* directly,
at 60-second granularity, on the first sighting. Run-to-run buys the same information
indirectly, by waiting one 300-second cron cycle. For a terminated order first seen
more than 60 seconds after it left the book — with terminations arriving roughly
uniformly across the cycle, most of them — **a genuine persistent drift now halts one
cycle later than it does today on Binance.**

That is the whole cost. It is bounded at one cycle (never two —
`unconfirmedWindowMs` is 600s, two cron turns, so a run that could not read the venue
cannot silently reset the count), one-sided, and identical to the trade entry 61 made
deliberately for the live branch on the evidence of two real bots halted for nothing.
The operator has accepted it in exchange for one behaviour across N exchanges and no
per-integration judgement call. It is recorded here so the build session states it
rather than discovers it.

---

## PART 10 — FILES CHANGED, AND WHAT IS NOT TOUCHED

| File | Change | Size |
| --- | --- | --- |
| `reconciliation/reconcile.ts` | PART 1 query fix + cap rename; PART 2 branch removal, signature narrowing, comment rewrite | ~45 removed, ~25 added |
| `reconciliation/findings.ts` | PART 5 removals (2 union/table members, 1 threshold, 3 comment blocks) | ~25 removed |
| `reconciliation/reconcile.test.ts` | PART 3 rewrite, PART 4's four rewrites, PART 7's three new tests | largest chunk |
| `reconciliation/findings.test.ts` | 2 assertions removed (`:83`, `:227`) | 2 lines |
| `exchange/binance/parse.test.ts` | PART 6.3 comment rewrite only — **no assertion changes, parser untouched** | comment only |
| `reconciliation/README.md` | remove the `order_recently_terminated` row (`:44`) | 1 line |

**No migration. No new table, column, index, `FindingKind`, alert type or storage
key.** `binance/parse.ts`, `gemini/parse.ts`, `shared/exchange-client.ts`,
`shared/order-state.ts`, `durable-objects/bot-instance.ts` and everything under
`dashboard/` are **untouched** by this change.

`durable-objects/fake-exchange.ts`'s `reportsUpdateTime` (`:138`) **stays**. It is
now the thing that lets a test assert the timestamp makes no difference — PART 3 sets
it `true` deliberately. Removing it would delete the ability to express the property
this change is about.

**Explicitly out of scope, and not to be touched by the build session:** DCA code,
`VERIFIED_INTERVALS`, `/health`, the kill-switch banner, the grid breakout display,
Stage 2, the AVAILABLE tile, `usePolling`, and tonight's grid-tracking fixes
(`09407ff`, `c180f08`).

---

## PART 11 — WHAT THIS DOCUMENT DOES NOT ESTABLISH

- **No implementation was written and no mutant was applied.** Every count in
  PART 5 is from reading source. The suite and typecheck WERE run, but only to
  establish the baseline in PART 0.1 — they verify the tree this design was written
  against, not the design itself, which has never been executed in any form.
- **No live verification.** No deploy, no `wrangler`, no HTTP call, no real D1. No
  Binance order has been observed through the run-to-run path on any venue. That half
  is the operator's.
- **The one-cycle delay in 9.4 has not been observed**, only reasoned. Its real-world
  frequency depends on when terminations land within the cron cycle, which no figure
  in this repository measures.
- **PART 6's parser fix is specified but deliberately not scheduled.** It needs its
  own change and its own entry.
- **No decision-log entry was written**, per the session's instruction.
