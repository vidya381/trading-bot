# DESIGN — `GridLadder.placed` is a one-way latch, so a halted-then-resumed grid bot is permanently inert

**Status:** **DESIGNED, NOT BUILT.** No implementation code was written in the session
that produced this document. Every option below was reasoned through against current
source; PART 3 states the recommendation a build session should implement without
re-deciding anything substantive.

**Raised by:** two real, live testnet bots — `bot-qgo39d` and `bot-gvtr1a` — both
`status: RUNNING`, both with spot genuinely inside their configured grid range, both
with every ladder rung showing "no order", confirmed across checks minutes apart.
Not found by reading code.

**Investigation:** completed in the preceding session of the same evening. Its
conclusion is treated here as **settled, not re-derived** — but every line number and
structural claim below was **re-read against the working tree** at the baseline in
PART 0, and PART 1 records the re-verification.

**The split held.** No `wrangler`, no deploy, no HTTP call, no query against real D1,
no browser, and nothing whatsoever done to `bot-qgo39d`, `bot-gvtr1a` or any other
live bot. The only command run was the local `vitest` suite. Live facts are labelled
**[OPERATOR]** and were supplied from the operator's own reads.

---

## PART 0 — THE BASELINE THIS WAS DESIGNED AGAINST

`HEAD` is **`def1d68`** ("Show a live market price on halted bots, and correct entry
77's stale status"). `git status --short` was **empty** — a clean tree — when the
baseline was measured.

| Measurement | Figure |
| --- | --- |
| Baseline suite at `def1d68` | **116 test files passed (117) / 3227 tests passed** |
| Baseline `Errors` line | **1** — the pre-existing `vitest-pool` teardown artifact (entries 36, 55) |
| Exit code | **0** |

A build session must re-measure before starting; this is the number its delta is
against.

---

## PART 1 — ROOT CAUSE, RE-VERIFIED AGAINST CURRENT SOURCE

The prior session supplied locations. They were re-read rather than trusted. **All
held; none had moved.**

| Fact | Prior session said | Current source says |
| --- | --- | --- |
| `GridLadder.placed` declaration | `grid.ts:212` | **`:212` — unchanged** |
| `emptyLadder` sets `placed: false` | `grid.ts:593` | **`:593` — unchanged** |
| `decide`'s first gate `if (!ladder.placed)` | `grid.ts:730` | **`:730` — unchanged** |
| `emptyLadder`'s only call site | `bot-instance.ts:1486` | **`:1486` — unchanged** |
| `#placeInitialLadder` sets `placed: true` | `bot-instance.ts:4576` | **`:4576` — unchanged** |
| `#gridExit`'s wholesale clear | `bot-instance.ts:5280` | **`:5280` — unchanged** |
| `liquidatePosition`'s wholesale clear | `bot-instance.ts:3526` | **`:3526` — unchanged** |
| `#cancelOpenOrders`' rung clear | `bot-instance.ts:5627` | **`:5627` — unchanged** |
| `#foldTerminalState`'s single-rung clear | `bot-instance.ts:2885` | **`:2885` — unchanged** |

### The latch

`placed` is written in exactly **two** places in the entire non-test tree:

- `grid.ts:593` — `false`, inside `emptyLadder`, whose **only** call site is
  `createGrid` (`bot-instance.ts:1486`).
- `bot-instance.ts:4576` — `true`, inside `#placeInitialLadder`, once a placement pass
  completes with nothing throttled.

There is no third write. `false → true` happens once per bot, at most, and nothing
ever goes back.

### The gate

`decide` (`grid.ts:722`) checks `if (!ladder.placed)` **first**, ahead of stop-loss,
breakout and take-profit. It is the **only** condition in the system that produces a
`place_initial_ladder` action, and `#gridOnPrice` (`bot-instance.ts:4533`) is the only
price-driven order-placing path a grid bot has.

### The clears

| Path | Line | Clears | Resets `placed`? |
| --- | --- | --- | --- |
| `#gridExit` (stop_loss / breakout / take_profit) | `:5280` | all slots → `null` | **No** |
| `liquidatePosition` | `:3526` | all slots → `null` | **No** |
| `#cancelOpenOrders`, reached from **every** `#halt` | `:5627` | every *resolved* rung → `null` | **No** |
| `#foldTerminalState` | `:2885` | one rung | **No** (correct — per-order) |

`resume()` (`#resumePass`, `:3187`–`:3392`) does not touch the ladder at all.
`start()` requires `status === "created"` and is unreachable for a halted bot.

**Result:** slots empty + `placed: true` ⇒ `decide` returns `hold` on every tick,
forever. Replace-on-fill cannot help: it is driven by fills, and there are no orders
to fill.

### Blast radius

`#halt` is reached from manual halt, reconciliation's `haltBot`, the global kill
switch, the account circuit breaker, `order_rejected` and `unhandled_error`. Since
`c180f08` gave `#cancelOpenOrders` its rung clear, **every** grid bot halted for
**any** reason and later resumed lands in this state. This is the normal halt/resume
lifecycle, not an edge case.

Before `c180f08` the outcome was the same and merely better disguised: rungs were left
standing for orders already cancelled, so the ladder *displayed* as populated while
`#placeGridOrder`'s pre-send check refused every occupied level. `c180f08` converted a
lying display into an honest one; it did not cause the inertness.

### The third exposure — zero-order initial placement

`initialLadderOrders` (`grid.ts:685`) breaks on the first level whose price is `>=`
spot. If a grid is **started** while spot sits **below `levels[0]` but above
`stopLossPrice`** (`grid.ts:487`), it returns `[]`. `#placeInitialLadder` then loops
over nothing, `throttled` stays `false`, and it latches `placed: true` having placed
**zero** orders. Price later rising back into range hits `hold` forever.

**No clear, no halt and no resume are involved.** Flagged as real from source;
**not confirmed live**, and this document does not propose reproducing it live.

### Why nothing caught it — the mechanism was written down four times

Not out of scope. Observed, recorded, and each time treated as settled background:

1. `dashboard/src/components/ApplyMissedFillsAction.tsx:57` — *"the rung comes back
   EMPTY, and nothing places it later either, because `#placeInitialLadder` only ever
   runs once (`placed: true`)"* — stated for **one** rung, never generalised.
2. `src/durable-objects/liquidate-position.test.ts:660`, written the same evening as
   part of entry 74 — *"`decide` rebuilds only while `placed` is false, so a resumed
   grid does not re-place its rungs"* — used as a **premise** to set up a different
   assertion.
3. `src/reconciliation/findings.ts:219` — *"It cannot self-heal, because `decide` only
   places a ladder when `placed` is false, so this state persists until a human
   acts."*
4. `docs/decision-log/77.md`, PART 0 — *"It was inert only because its ladder was never
   rebuilt (all eight slots null) — not because any safeguard stopped it."*

Four accurate descriptions of the defect, none of which asked the next question: *then
what places the ladder after a wholesale clear?*

---

## PART 2 — THE SIX OPTIONS, EVALUATED

### (a) Reset `placed` at each of the three wholesale-clear sites

**How it would work.** Add `placed: false` to the spread at `:5280`, `:3526` and
`:5627`. All three clears happen during or after a halt, so nothing re-places
immediately; the rebuild fires on the first tick after a later `resume()`.

**It does work, for new occurrences.** The outcome for a bot halted *after* the fix is
correct.

**Four objections, in increasing order of weight:**

1. `#cancelOpenOrders` is not a wholesale clear in general — it clears only rungs whose
   orders this sweep **resolved**, deliberately retaining rungs for unconfirmed
   cancellations and for records the entry-57 gate refused to close. Setting
   `placed: false` there while rungs survive means the next tick re-enters
   `#placeInitialLadder` alongside live orders. That happens to be safe today —
   `:4566` skips levels whose slot is non-null — but the safety is incidental, resting
   on a guard written for a different purpose.
2. It leaves the latch a latch. A fourth clear site added later reintroduces the bug in
   full, silently. PART 4 examines whether that can be made a build failure.
3. It cannot address the third exposure. A zero-order initial placement latches
   `placed: true` with no clear ever occurring, so no reset at any clear site is
   reached.
4. **It is forward-only, and this is decisive.** `bot-qgo39d` and `bot-gvtr1a` already
   hold `placed: true` in Durable Object storage. Their clears are in the past. A fix
   that only runs *at clear time* never runs on them again, so both bots stay inert
   after deployment and need the clone-and-replace workaround regardless. See PART 7.

**Verdict: NOT RECOMMENDED as the primary fix.** Its enforcement idea is worth keeping
as insurance — see PART 4.

### (b) Derive the rebuild condition from actual state

**How it would work.** Stop treating `placed` as the authority on whether a ladder
needs building and ask the state directly: *is this ladder vacant, with nothing
outstanding?*

**Strengths.**

- **It is retroactive.** The condition is evaluated on every tick against live state,
  so a bot already in the broken condition self-corrects on its next price update with
  no operator action. This is the only option with that property.
- **It cannot be forgotten at a future clear site.** A new wholesale clear produces a
  vacant ladder, and a vacant ladder is the condition. Correctness is a property of the
  state, not of a developer remembering a companion write.
- **It subsumes the third exposure.** A zero-order initial placement leaves the ladder
  vacant and flat, which the condition matches.

**Weaknesses.**

- It needs three state fields the pure layer does not currently receive
  (`openOrderIds`, `exitOrderId`, `pendingReplacements`). There is precedent — DCA's
  `decide` already takes `hasOpenOrder: boolean`, computed by the caller at
  `bot-instance.ts:1577` — so this is an established shape, not a new coupling.
- **Replacing `placed` outright breaks the throttled-partial-placement case.** This is
  the real semantic dependency the investigation flagged. PART 5 traces it and shows
  the resolution: keep `placed` and make the derived condition an **additional
  disjunct**, not a replacement.
- It changes what a resumed bot does. That is the point, but it means the gate's
  position relative to the risk exits has to move; PART 3 covers this.

**Verdict: RECOMMENDED, in the additive form specified in PART 3.**

### (c) Rebuild directly in `resume()`

**How it would work.** `#resumePass` sets `placed: false`, or places the ladder itself,
before returning.

**The stated cost is real and this document does not wave it away.** Every
order-placing site in this system sits behind `#onPriceUpdatePass`'s read of the
object's own status (`bot-instance.ts:1560`). `resume()` today writes status, resolves
alerts and audits — it sends nothing to an exchange. Making it place orders moves it
into a category the codebase has kept it out of deliberately, and the reasoning is
visible in `#startPass`'s own comment (`:1511`): *"The order is not placed here because
placing it needs a price, and reading one is an exchange call that can fail."* `start`
declines to place for exactly this reason; `resume` inheriting the discipline is
consistent, not accidental.

**But there is a second objection that is disqualifying on its own, and it comes from
3a.** Under `eab337e`, `#resumePass` writes D1 **first** (`:3352`) and the object
**second** (`:3353`), because an interruption between them must leave the wreckage
pointing the safe way: D1 `running` / object `halted`, where the emergency sweeps still
see the bot and *nothing places an order*, because every placing site reads the
object's status.

Placing a ladder inside `#resumePass` puts **live orders on the exchange inside that
window**. An interruption after placement but before the object's status write leaves N
real resting orders belonging to a bot whose own state says `halted` — a bot that will
not poll them, will not fold their fills, and will not cancel them. That is strictly
worse than the wreckage 3a was built to produce, and it is manufactured by the fix. 3a
would be partially undone by (c).

**Verdict: REJECTED.** Not on style — on 3a.

### (d) A separate, explicit re-place-ladder action

**How it would work.** A new DO method plus a dashboard control, in the
`applyMissedFills` / `repairPosition` shape: `halted`-only, human-triggered, no
implicit trading.

**Strengths.** It matches the codebase's established stance that repair is a human
decision. It is the only option that can sensibly handle the case an automatic rebuild
must refuse — see below.

**Weaknesses as a primary fix.** It leaves the defect in place and adds a button an
operator must know to press. Every grid bot's normal halt/resume lifecycle would
continue to produce inert bots, each needing a manual click. That is a workflow, not a
fix.

**Where it is genuinely needed, and this is why it is not redundant.** The recommended
condition in PART 3 **refuses to rebuild while the bot holds base**
(`heldQuantity > ZERO`). A vacant ladder with held base is a bot carrying inventory
that has no sell against it; re-placing an initial ladder there would place *buys only*
(grid decision 1) and quietly resume trading around orphaned inventory the strategy has
stopped managing. `uncovered_held_inventory` already exists to report exactly that
condition and already classifies it as needing a human. Automatic rebuild must not
paper over it.

**Verdict: RECOMMENDED AS A SCOPED FOLLOW-UP, not part of this fix.** Build it when a
real bot presents vacant-and-holding. Recording the boundary here is what matters:
**(b) covers vacant-and-flat; (d) is the answer for vacant-and-holding.**

### (e) Detection-only — a reconciliation finding

**Correctly framed in the brief as complementary, never a substitute.** Detection
would not have placed a single order on either real bot.

**And it does not fit the tier machinery, which is worth stating precisely rather than
discovering at build time.** `act()` (`reconcile.ts:1823`) offers three tiers:

- `minor` — auto-correct, log, **no alert** (`:1841`, and section 9 is explicit).
- `meaningful` — alert **and `haltBot`** (`:1889`).
- `severe` — trip the account circuit breaker.

A "running grid, `placed`, vacant" finding registered as `meaningful` would **halt the
bot** — pointless for an already-inert bot, and actively harmful once (b) ships, since
it would halt the very bot the fix is about to revive and require another operator
resume. Registered as `minor` it would never alert, which defeats the purpose. The one
escape — `finding.scope !== "bot"` alerts without halting (`:1897`) — is unavailable
without lying about the scope of a plainly bot-scoped finding.

**Verdict: RECOMMENDED, but NOT as a reconciliation finding.** Raise it from the bot
itself through `#raiseStanding`, the mechanism `grid_replacement_queued` already uses
(`bot-instance.ts:5183`): a standing alert when a running grid bot completes a price
pass while vacant, flat and having placed nothing. Under (b) that state is transient by
construction, so the alert fires **only if the rebuild was refused, throttled or
skipped** — which is precisely the defense-in-depth wanted, with no halt side effect
and no new finding kind.

### (f) Guard the zero-order initial placement

**How it would work.** `#placeInitialLadder` does not latch `placed: true` when
`orders.length === 0` — it placed nothing, so claiming otherwise is false.

**Honest assessment: (b) already fixes the trading consequence.** A zero-order
placement leaves the ladder vacant and flat, which (b)'s condition matches, so the bot
re-evaluates every tick and places the moment price rises into range. (f) is not
required to make the third exposure trade correctly.

**It is still worth doing, for two reasons that are not "do everything":**

1. **The flag is reported.** `state.ladder.placed` is exposed on the API
   (`dashboard/src/api/types.ts:290`) and is what an operator reads to answer "did this
   ladder ever get built". A bot reporting `placed: true` having placed nothing is a
   lie in the one field a human uses to diagnose this class of fault.
2. **It is insurance against (b) being narrowed later.** If a future change tightens
   the vacancy condition, (f) keeps the third exposure closed independently.

**(f) forces a gate-ordering decision, and this is the interaction a build session must
not miss.** With (f) in place and the placement gate left **first**, a fresh bot started
below its stop-loss re-enters gate 1 on every tick with zero orders to place and
**never reaches the stop-loss check at all**. The bot is flat, so nothing is at risk,
but it sits `running` instead of halting. PART 3's gate reorder resolves this; (f) must
not ship without it.

**Verdict: RECOMMENDED, jointly with PART 3's reorder.**

---

## PART 3 — RECOMMENDATION

**Build (b) + (f) as one coherent change, plus (e) in its narrowed DO-side form.
Reject (a) and (c). Defer (d), with its boundary recorded.**

The combination is justified by what each part covers that the others do not:

- **(b)** is the only option that is retroactive, and the only one that cannot be
  forgotten at a future clear site. It fixes the defect and recovers both real bots.
- **(f)** is not needed for trading correctness once (b) ships — it is there so the
  reported flag stops lying, and so the third exposure stays closed independently of
  (b)'s exact wording. Small, and it forces a gate reorder that is an improvement in
  its own right.
- **(e)**, narrowed, costs one standing alert and fires only when (b) fails to place.
- **(a)** adds nothing (b) does not already give, and misses both real bots.
- **(c)** would partially undo 3a.
- **(d)** is a different problem — vacant *and holding* — and should be built when one
  appears.

### 3.1 — The gate reorder

`decide` (`grid.ts:722`) today evaluates:

```
1. !placed        -> place_initial_ladder
2. stop_loss
3. breakout_take_profit
4. take_profit
5. hold
```

**Change to:**

```
1. stop_loss
2. breakout_take_profit
3. take_profit
4. !placed || vacant  -> place_initial_ladder
5. hold
```

**This reverses a documented decision, so the reasoning is recorded rather than
assumed.** The comment at `grid.ts:711` justifies placement-first as *"There is no risk
exit to lose a race to before any order exists"* — an argument that placing first is
**harmless**, not that it is **necessary**. It stops being harmless the moment the gate
can fire on a bot that is not fresh:

- A bot halted on `take_profit` still has `realizedGross >= takeProfitAmount` after the
  clear. Resumed with the gate first, it rebuilds the whole ladder and re-exits on the
  next tick — N real orders placed and cancelled for nothing.
- A bot halted on `stop_loss` and resumed while price is still below the stop does the
  same.
- With (f), a fresh bot below its stop-loss never reaches the stop-loss check at all.

Moving the gate below the three exits fixes all three, and **improves the fresh-bot
case too**: a bot created with spot already past its breakout exits without first
placing and cancelling a full ladder.

### 3.2 — The vacancy condition

```
vacant  =  every slot is null
       AND ladder.heldQuantity == ZERO
       AND nothing outstanding
```

where `nothing outstanding` is supplied by the caller as a single boolean, following
DCA's `hasOpenOrder` precedent (`bot-instance.ts:1579`):

```
outstanding  =  openOrderIds.length > 0
            OR  exitOrderId !== null
            OR  (pendingReplacements ?? []).length > 0
```

`slots` and `heldQuantity` stay inside the pure layer where they already live; only
`outstanding` is added to `GridDecisionInput` (`grid.ts:345`). The pure layer gains no
storage, clock or exchange access — the separation the module header defends is
preserved.

**Each conjunct earns its place:**

| Conjunct | Why |
| --- | --- |
| every slot null | A partially-populated ladder is a working ladder; rebuilding it would double up levels. |
| `heldQuantity == ZERO` | Vacant **and holding** is `uncovered_held_inventory`'s condition — a human decision, option (d). An initial ladder is buys-only and would trade around orphaned inventory. |
| `openOrderIds` empty | Entry 74's retained orders — unconfirmed cancellations, records the entry-57 gate refused to close — mean this bot has unresolved exchange state. Do not trade on top of it. |
| `exitOrderId === null` | A resting liquidation or take-profit sell is live; rebuilding beneath it would place buys against a position being disposed of. |
| `pendingReplacements` empty | A queued replacement means the ladder is mid-repair, not dead. |

### 3.3 — Is `vacant` reachable on a *healthy* running grid?

Essentially no, and the check is worth showing because a false positive here places
real orders.

`planFill` (`grid.ts:888`) is symmetric: a filled buy at level `i` places a sell at
`i+1`; a filled sell at level `i` places a buy at `i-1`. Every fill produces exactly one
replacement, so the ladder sustains itself. There are exactly two branches that produce
none:

- **Top-level buy fills** (`sellIndex >= levels.length`, `grid.ts:947`) — no rung above.
  This leaves `heldQuantity > ZERO`, so the `heldQuantity == ZERO` conjunct excludes it.
- **Bottom-level sell fills** (`buyIndex < 0`, `grid.ts:986`) — no rung below. **This
  branch is unreachable via replace-on-fill:** a sell is only ever placed at
  `levelIndex + 1`, so a sell can never occupy level 0. It is defensive code.

Throttled or queued replacements are excluded by the `pendingReplacements` conjunct;
dropped replacements (the entry-70 class) leave `heldQuantity > ZERO`.

**Conclusion: `vacant` characterises a dead ladder and nothing else.** A build session
should still write the negative tests in PART 8.

### 3.4 — Capital

Re-placing the ladder spends quote capital, but not twice. `#placeGridOrder`'s header
(`bot-instance.ts:4600`) records that grid does no per-order allocation budgeting
because *"the whole ladder was validated to fit at creation"*. The previous orders are
gone — that is the precondition being detected — so the same allocation funds the same
ladder. No new budgeting is required, and none should be added.

---

## PART 4 — CAN A FUTURE CLEAR SITE BE MADE A BUILD FAILURE?

The brief asks this of option (a), and the project **does** have precedent for exactly
this pattern. Under the recommendation the question is insurance rather than load-
bearing — (b) is correct whether or not a new clear site remembers anything — but the
precedent is recorded because a build session may want it.

### The precedent

Three existing tests enforce invisible invariants by scanning source with
`import.meta.glob(..., { query: "?raw", eager: true })` and failing the build:

- `src/db/no-raw-d1.test.ts` — "no raw D1 outside `/src/db`". The backend example, and
  the closest fit.
- `dashboard/src/api/single-kill-switch-poll.test.ts` — "exactly one subscription".
- `dashboard/src/research/prefill-does-not-approve.test.ts` — which states the doctrine
  outright: *"a guard whose call site nothing can check is most of the way to no
  guard."*

`no-raw-d1.test.ts` also carries an **anti-vacuity guard** worth copying verbatim in
spirit — an `it("found the source files to check")` asserting the glob returned a
plausible number of paths and specific known files. Without it a glob that silently
matched nothing would make every assertion pass.

### What it would look like here

A scan flagging any wholesale null-write to a ladder's slots outside an allowlist —
`/\.slots\.map\(\s*\(\s*\)\s*=>\s*null\s*\)/` and similar — with the three known sites
allowlisted by file and line-adjacent comment. A new site fails the build and forces
its author to consciously confirm the rebuild condition covers it.

**Recommended as a small optional addition, not a requirement.** Its value is
documentary — it puts a tripwire on the concept — and it is honest about its limit: a
regex over source cannot prove a new clear site is *handled*, only that someone was
made to look. Under (b) they would be looking at a condition that already covers them.

---

## PART 5 — THE THROTTLED-PARTIAL-PLACEMENT CASE, TRACED

The investigation flagged this as a real semantic dependency on the stored flag. It is,
and it is the reason (b) must be **additive** rather than a replacement.

### What the code does today

`#placeInitialLadder` (`bot-instance.ts:4562`):

```
for each intent:
    skip if slots[levelIndex] != null          // already placed
    result = #placeGridOrder(...)
    if result.status == "halted": return
    if result.action in ("throttled","unresolved"): throttled = true

if (!throttled) -> set placed: true
return action: throttled ? "initial_ladder_partial" : "placed_initial_ladder"
```

Its own header (`:4559`) states the contract: *"`placed` is set true only once no order
was throttled; a throttle leaves it false so the next price update completes the
ladder."*

So the sequence is: some rungs place, others are refused budget, `placed` stays
`false`, and the **next tick** re-enters through `!placed`, recomputes
`initialLadderOrders` at the new price, skips the levels already holding orders, and
places the remainder.

### Whether a derived condition can replicate it exactly

**It cannot, and the failure is precise.** During a partial placement some slots are
non-null, so `every slot is null` is **false**. A derived-only condition would refuse to
re-enter, and the throttled rungs would never be placed — silently converting a
recoverable throttle into a permanently incomplete ladder. That is a *new* instance of
the same class of bug this document exists to fix.

**Could the condition be widened to cover it?** Only by asking "is any level below spot
empty?", and that is unsafe for an unrelated reason: on a healthy grid a level below
spot is *legitimately* empty whenever its buy has filled and its replacement sell rests
one level up. Re-placing a buy there would put a second order against base already
bought and already covered — more exposure than the allocation was validated for. A
per-level derived condition is therefore wrong; only the wholesale one is safe.

### The resolution

**Keep `placed`. Add vacancy as a disjunct:** `!placed || vacant`.

- `!placed` — unchanged, still the throttle-retry driver. The partial-placement contract
  at `:4559` keeps working byte-for-byte.
- `vacant` — the new disjunct, matching only a fully dead ladder, which a partial
  placement never is.

The two conditions are disjoint in practice and neither weakens the other. **The stored
flag is not removed; it is demoted from "the only rebuild condition" to "one of two",
and its remaining job — the one it does correctly — is the throttle retry.**

---

## PART 6 — THE INTERRUPTED-RESUME WINDOW (3a / 3b)

The brief asks that this be confirmed against 3a/3b's actual mechanics rather than
assumed fine. It was, and the recommendation is safe **by construction** — but the
reason matters, because two of the six options are not.

### 3a's window

`#resumePass` writes D1 first (`:3352`), the object second (`:3353`). An interruption
between them leaves **D1 `running` / object `halted`**. That direction was chosen so the
emergency sweeps still select the bot and — the load-bearing half — *nothing places an
order*, because every order-placing site reads the object's own status.

### Why the recommendation cannot misfire in it

The rebuild is evaluated inside `decide`, reached only from `#gridOnPrice`, reached only
from `#onPriceUpdatePass`, which returns `ignored` at `bot-instance.ts:1560` when
`state.status !== "running"` — **the object's own state, never D1's**. During 3a's
window the object still says `halted`, so the price pass returns before reaching any
grid code at all.

**The rebuild therefore cannot fire on a status read that is mid-transition, because it
never reads a status that can be mid-transition.** It reads the object's status, which
is the one 3a writes *last* and which is therefore never ahead of reality.

This is also why **(c) is rejected**: it would place orders *inside* that window. And it
is why **(a) is unaffected** — its writes happen at clear time, nowhere near a resume.

### 3b, and one real false-positive risk in (e)

3b's `botStatusFindings` (`reconcile.ts:785`) requires the **same disagreement on two
runs** and re-reads both halves before acting, precisely because a healthy in-flight
resume presents as a disagreement. The narrowed (e) must inherit that discipline for a
reason of its own:

**A legitimately resumed bot is `running` with a vacant ladder until its next price tick
arrives.** That is a correct, transient state, and a detector firing on a single
observation would alert on every healthy resume. The DO-side standing alert avoids this
naturally — it is raised at the **end of a price pass**, so by then the rebuild has
either happened or been refused — but a build session must not relocate it to a
snapshot-reading observer without adding two-sighting confirmation.

---

## PART 7 — WHAT RECOVERS THE TWO REAL BOTS

Stated plainly, because a forward-only fix would help neither.

### Under the recommendation: they self-correct, with no operator action

Both bots are **`RUNNING` now** — `bot-qgo39d` after its liquidation and resume,
`bot-gvtr1a` after the detector's halt and the operator's resume. Running means their
price feed is live and `#onPriceUpdatePass` reaches `#gridOnPrice` on every tick.

Once (b) is deployed, the next price update evaluates: no risk exit applies (spot is
inside the range **[OPERATOR]**), `vacant` is true, `place_initial_ladder` fires, and
the ladder is placed. **The first tick after deployment. No resume, no button, no clone.**

This is (b)'s decisive advantage over (a): the condition is evaluated against live state
on every tick, so it reaches bots whose damage is already done.

### The precondition, and the one bot it may not hold for

`vacant` requires `heldQuantity == ZERO`.

- **`bot-qgo39d`** — went through `liquidatePosition`, and `#applyGridExitFill`
  (`:5228`) decrements `heldQuantity` to zero on the exit's full fill. Expected flat.
  **[OPERATOR to confirm]** `state.ladder.heldQuantity == 0` and
  `state.exitOrderId == null`.
- **`bot-gvtr1a`** — entry 77 records that the detector's halt *"does NOT liquidate: the
  position is preserved for a human"*. **Whether it holds base is not knowable from
  source.** If it does, `vacant` is **false**, it does **not** self-correct, and it is
  the vacant-and-holding case option (d) exists for. It should also be raising
  `uncovered_held_inventory` on every reconciliation pass, which is the operator's
  quickest check.

**[OPERATOR] verification, before and after deploy — four fields from
`GET /api/bots/<id>`:**

| Field | Expected before fix | Expected after first tick post-deploy |
| --- | --- | --- |
| `state.ladder.placed` | `true` | `true` |
| `state.ladder.slots` | all `null` | buys at every level below spot |
| `state.ladder.heldQuantity` | `0` for qgo39d; **unknown** for gvtr1a | unchanged |
| `state.openOrderIds` | `[]` | the newly placed ids |

If `state.ladder.placed` reads `false` on either bot, the diagnosis is wrong and the
build session should stop and re-investigate — a `false` flag would have re-placed on
its own.

### If gvtr1a turns out to hold base

Options, in order of preference, none to be chosen by this document:

1. Build (d) and use it, having decided what the held base is for.
2. `liquidatePosition` it (it must be halted first), taking it flat — at which point
   (b) recovers it on resume like the other.
3. The clone-and-replace workaround: halt → liquidate → archive (releases capital;
   `archiveBot` is gated by `assertFlatBeforeRelease`, `api/handlers.ts:1336`) → clone
   via prefill (`dashboard/src/research/botClonePrefill.ts`) → start. A fresh bot gets
   `emptyLadder` and `placed: false`.

**The workaround is not needed for either bot if both are flat.** It stays documented
because it is the fallback if deployment is delayed.

---

## PART 8 — TEST PLAN

Against the PART 0 baseline (116 files / 3227 tests / `Errors 1`). Grid DO tests belong
in `src/durable-objects/grid-bot-instance.test.ts`; pure-layer tests in
`src/strategies/grid.test.ts`; the exit/liquidation scenarios have an established home
in `src/durable-objects/liquidate-position.test.ts`.

**Note for the build session:** `grid.test.ts:61`'s helper is
`{ ...emptyLadder(params), placed: true, ...overrides }` — every existing pure-layer
test constructs a `placed` ladder, so adding a `vacant`-triggering case needs the helper
extended rather than reused as-is.

### 8.1 — The core scenario, once per real trigger path

Each: drive a grid bot to a populated ladder, halt through the path under test, resume,
deliver one price update with spot inside the range, assert **a fresh ladder was
actually placed** — non-null slots, ids present in `openOrderIds`, and orders visible on
the fake exchange. Asserting the action string alone is not enough; the bug produced a
correct-looking `hold`.

| # | Halt path | Reached via |
| --- | --- | --- |
| 1 | Manual halt | `halt("manual", …)` → `#cancelOpenOrders` rung clear |
| 2 | Reconciliation `haltBot` | same entry point, `actor: "reconciliation"` |
| 3 | `#gridExit` — `stop_loss` | price below stop, then resume with price back in range |
| 4 | `#gridExit` — `breakout_take_profit` | price above breakout, then resume in range |
| 5 | `#gridExit` — `take_profit` | `realizedGross >= takeProfitAmount` |
| 6 | `liquidatePosition` | halt, liquidate, fill the exit, resume |
| 7 | `order_rejected` / `unhandled_error` | exchange refusal during placement |

Paths 3–5 additionally assert the **gate reorder**: on resume with price *still* in exit
territory the bot **re-exits without placing**, and `exchange.placed` gains nothing.
This is the churn regression and it is the reason the reorder exists.

### 8.2 — The third exposure

- Create and start a grid with spot **below `levels[0]` but above `stopLossPrice`**.
  Assert `#placeInitialLadder` placed zero orders and **`placed` stayed `false`** — (f).
- Move price into range. Assert the ladder places.
- **The interaction test (f) must not ship without:** with spot **below `stopLossPrice`**
  on a fresh bot, assert the bot **halts on `stop_loss`** rather than looping on the
  placement gate. This fails if the reorder is omitted.

### 8.3 — 3a's interruption window

Model on `src/durable-objects/resume-write-order.test.ts`, which already pins the write
order and already has the harness for observing between the two writes.

- Interrupt `#resumePass` between `#mirrorStatus` (`:3352`) and `#mutateState`
  (`:3353`), leaving D1 `running` / object `halted`.
- Deliver a price update. Assert it returns `ignored`, **`exchange.placed` is unchanged**,
  and the ladder is still vacant. The rebuild must not fire off D1's opinion.
- Complete the resume, deliver another price update, assert the ladder now places.

### 8.4 — Negative tests: `vacant` must not fire on a healthy grid

One per excluded conjunct, each asserting **no rebuild**:

- Partially populated ladder (some rungs live) — the throttled-partial case; assert the
  `!placed` path still completes the remaining levels and `vacant` never fires.
- Vacant slots, `heldQuantity > ZERO` — no rebuild; option (d)'s territory.
- Vacant slots, flat, but `openOrderIds` non-empty (entry 74's retained orders).
- Vacant slots, flat, but `exitOrderId !== null`.
- Vacant slots, flat, but `pendingReplacements` non-empty.
- Top-level buy filled with no rung above (`grid.ts:947`) — leaves held base; assert no
  rebuild.

### 8.5 — Standing alert (e)

Running grid, vacant, flat, rebuild refused (throttle every placement): assert
`#raiseStanding` raises once and keeps stating the condition while true; assert it does
**not** raise on the ordinary path where the rebuild succeeds.

### 8.6 — Optional: the source-scan tripwire (PART 4)

If built: the guard plus `no-raw-d1.test.ts`'s anti-vacuity `it("found the source files
to check")`.

### 8.7 — Mutation testing

This project's recent entries (74, 75) report mutants killed as part of the deliverable.
The mutants that matter here:

- Flip each conjunct of `vacant` to `true` — every one must be killed by an 8.4 test.
- Delete the `heldQuantity == ZERO` conjunct — killed by the vacant-and-holding test.
- Restore the gate to first position — killed by the 8.1 paths 3–5 churn assertions and
  by 8.2's stop-loss interaction.
- Restore `placed: true` on the zero-order path — killed by 8.2.

---

## PART 9 — WHAT THIS DESIGN DOES NOT DO

- **It does not repair a vacant ladder on a bot holding base.** Deliberate; that is
  option (d), deferred, boundary recorded in PART 2(d) and PART 7.
- **It does not touch `resume()`.** By decision, per PART 2(c) and PART 6.
- **It does not add a reconciliation finding.** Per PART 2(e) — the tier system cannot
  express "alert without halting" for a bot-scoped finding.
- **It does not change how capital is budgeted for a rebuilt ladder.** Per PART 3.4.
- **It does not reproduce the third exposure live**, and nothing in it has been
  exercised against a live bot. The two real bots' recovery in PART 7 is what is
  **EXPECTED**, not what has been confirmed.
- **`bot-gvtr1a`'s held quantity is unknown to this document**, and PART 7's
  self-correction claim is conditional on it being flat.
- **Nothing here is committed or built.** No implementation code was written.

---

## APPENDIX — FILES A BUILD SESSION WILL TOUCH

| File | Change |
| --- | --- |
| `src/strategies/grid.ts` | `GridDecisionInput` gains `outstanding: boolean` (`:345`); `decide`'s gate order and the `!placed \|\| vacant` condition (`:722`–`:760`); a `vacant` helper beside the other ladder-state helpers (`:580`–`:585`+) |
| `src/durable-objects/bot-instance.ts` | `#gridOnPrice` (`:4533`) computes and passes `outstanding`; `#placeInitialLadder` (`:4562`) zero-order guard (f); the standing alert (e) |
| `src/strategies/grid.test.ts` | pure-layer gate and `vacant` tests; helper at `:61` extended |
| `src/durable-objects/grid-bot-instance.test.ts` | 8.1 paths 1–2, 7; 8.2; 8.4; 8.5 |
| `src/durable-objects/liquidate-position.test.ts` | 8.1 paths 3–6 — note `:660`'s comment asserts the OLD behaviour in prose and must be rewritten, not left standing |
| `src/durable-objects/resume-write-order.test.ts` (or a sibling) | 8.3 |
| `dashboard/src/components/ApplyMissedFillsAction.tsx` | **comment only** (`:57`) — its "nothing places it later either" paragraph becomes false for the vacant-and-flat case and must be narrowed to the vacant-and-holding case it will still be true of |
| `src/reconciliation/findings.ts` | **comment only** (`:219`) — same correction to `uncovered_held_inventory`'s "cannot self-heal" rationale |

**Not to be touched:** DCA, `VERIFIED_INTERVALS`, `/health`, the kill-switch banner, the
grid breakout display, Stage 2, the AVAILABLE tile, `usePolling`, the Gemini timestamp
fix, and tonight's 3a/3b/3c and order-tracking fixes — referenced only, per PART 6.
