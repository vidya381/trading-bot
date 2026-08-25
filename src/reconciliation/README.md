# `/src/reconciliation` — reconciliation and the circuit breaker

Spec section 9 (reconciliation) and section 7.3 (the account-wide circuit
breaker), build step 7. The job that compares what the exchange says against
what this system believes, decides how bad the difference is, and acts.

Nothing here reads a clock, a binding, or an environment. `reconcileAccount`
takes its database, exchange client, clock and Durable Object access as
parameters, so a test drives exactly the code path the cron does. The
binding-aware shell is `/src/workers/reconciliation.ts`.

## Files

| File | What it is |
| --- | --- |
| `findings.ts` | The three tiers, as pure logic. No I/O. |
| `circuit-breaker.ts` | Section 7.3's control: trip, latch, sweep, reset. |
| `reconcile.ts` | One pass over one account: observe, classify, act. |

## The classification rule

Section 9 names three tiers and gives no thresholds anywhere. The rule is:

1. The **kind** of finding sets a floor (`TIER_FLOOR`).
2. **Magnitude** may escalate above that floor, up to a per-kind ceiling
   (`TIER_CEILING`).
3. Magnitude may **never** lower a floor.

Rule 3 is why a tiny unexpected order is still severe — section 9 lists
"unexpected orders" under severe with no size qualifier, and something else
trading the account is the same event whatever the size.

`TIER_CEILING` exists because of a bug a test caught. The first version let any
finding escalate to severe, and for an order-level finding the only available
denominator is that order's own quantity — so a resting order that half-filled
without the bot hearing read as a 50% divergence and tripped the account-wide
breaker. "50% of one order" and "50% of the account" are not two points on one
scale. Only `balance_drift` can reach severe by magnitude; it is the one kind
whose amount and reference are the same asset at account scale.

| Kind | Floor | Ceiling |
| --- | --- | --- |
| `mirror_drift` | minor | meaningful |
| `balance_drift` | minor | **severe** |
| `order_state_drift` | meaningful | meaningful |
| `cancel_fill_discrepancy` | meaningful | meaningful |
| `cancel_failed` | meaningful | meaningful |
| `reported_order_state_drift` | meaningful | meaningful |
| `ledger_allocation_drift` | meaningful | meaningful |
| `unknown_open_order` | **severe** | severe |
| `unknown_order_fill` | **severe** | severe |

## What each tier does

| Tier | Action |
| --- | --- |
| minor | Auto-correct, log to `audit_log`, **no alert**. |
| meaningful | Halt that one bot, write a critical alert, **do not** auto-correct. |
| severe | Trip the account circuit breaker: halt every bot on the account, latch it, alert immediately. |

Those alerts are **standing** ones: one row per open incident, not one per
detection. The mechanism moved to [`/src/alerts/standing.ts`](../alerts) at step
20, when `BotInstance`'s 30-second open-order poll became a second writer that
re-detects conditions on a schedule; `raiseFindingAlert` and
`resolveClearedAlerts` here are now thin adapters that supply reconciliation's
own three answers (which rows it owns, which are in scope, and whether the pass
actually observed anything). Behaviour is unchanged — a private copy in this
file would have been a second lifecycle free to drift from the poll's.

Auto-correct only ever touches the **D1 mirror**. Section 8.1 makes each Durable
Object the source of truth for its own state; a cron writing into a running
bot's position would be a second writer, from outside the object that
serialises access, using a read that is already stale. A finding is therefore
only ever raised as `minor` when this job can actually fix it — where the
mirror is wrong in a way it cannot repair, the finding is `order_state_drift`
instead, because a minor finding nobody can correct would be silent by
construction.

## The balance model

`capital_ledger.total_balance` was a human-typed placeholder before this step
(`seedPlaceholderTotalBalance`), so comparing the exchange against it would
report a large discrepancy every run that is not drift. Balances are reconciled
as a **delta between runs** instead:

```
internal_calculated_balance = previous run's exchange balance
                            + this system's own recorded activity since
discrepancy                 = exchange_reported_balance
                            - internal_calculated_balance
                            - unreconciled manual adjustments
```

So `discrepancy` is the *unexplained* part of the change, which matches
migration 0001's note that it "is NOT a plain difference of these two columns".

"Since" means **since that asset's own baseline**, and step 24 had to make it
true: `recordedActivity` was windowing from the account's oldest snapshot and
handing every asset one lifetime sum, which the caller added to a five-minute-old
baseline that already contained it. The discrepancy it produced was the account's
lifetime trading, negated, on every pass. Contributions now carry their
timestamps and are summed per asset by `activitySince`; the `attributed` flag is
per contribution for the same reason, so one unattributable trade no longer
blinds an asset permanently.

The first run for an (account, asset) has no baseline. It **adopts** the
exchange's balance and raises nothing: with no prior observation there is no
change to explain, and treating the whole balance as unexplained would trip the
breaker on the first run of every account, forever.

An exchange that answers successfully with **no holdings at all** is a third
case, and step 24 separated it from the second. It used to share the
`assets.size === 0` early return with "this account has nothing to check", which
made a venue mid-transition look like a clean pass — no snapshot, no `skipped`
entry, no alert, and (worse) an observation entitled to resolve live standing
alerts. `auditEmptyBalanceSet` now raises `reconciliation_empty_balance_set` and
records the set as **unread**, so the baseline survives. The discriminator is
whether this account has ever been observed holding anything; it deliberately is
not `capital_ledger` expectations, which an empty union already proves absent.

Base and quote assets come from the exchange's own symbol filters, never from
slicing the pair string — step 5's decision 1 rejected that, and being wrong
there moves money between the wrong ledger rows.

## Closing step 6's loop

Step 6's Durable Object writes alerts that, until this step, nothing read. Its
own deviations said so: *"section 9's reconciliation is relied on by three paths
here and does not exist yet. Those alerts currently go into a table nobody reads
automatically."*

`INGESTED_ALERT_TYPES` is the read side. Every run picks up **unresolved**
alerts of these types for bots on the account, turns each into a finding, acts
on its tier, and then sets `alerts.resolved` — the only place in the codebase
that does.

| `alerts.alert_type` | Becomes | Tier |
| --- | --- | --- |
| `cancel_fill_discrepancy` | `cancel_fill_discrepancy` | meaningful → halt the bot |
| `cancel_failed` | `cancel_failed` | meaningful → halt the bot |
| `order_state_drift` | `reported_order_state_drift` | meaningful → halt the bot |
| `unknown_order_fill` | `unknown_order_fill` | **severe** → trip the breaker |

An alert is resolved only when its tier's action actually landed. If the halt
fails, the source alert stays unresolved so the next run finds it again.

Ingested findings carry **no magnitude**: the alert's payload is prose, and
re-deriving a number by parsing it would be a guess wearing a threshold's
authority. They classify by kind alone.

## The circuit breaker

Built this session because section 9's severe tier is not implementable without
it. It is the **mechanism** plus section 9's trigger:

```ts
await tripAccountCircuitBreaker(db, {
  accountLabel, reason, runId, actor: "reconciliation", now, haltBot, newId,
});
// -> latch written first, then every active bot on the account halted
// -> one critical alert, one audit entry, idempotent on repeat

await resetAccountCircuitBreaker(db, {
  accountLabel, actor: "owner@example.com", note: "why it is safe", now, newId,
});
// -> human actors only; re-arms the ACCOUNT, resumes no bot
```

Section 7.3's **daily-loss trigger is not built**. It needs a live price per
open position and a decision about what "for the current day" means across
timezones, which is its own piece of work. `tripAccountCircuitBreaker` takes the
reason as a string and does not care which trigger produced it, so wiring the
second one later is a caller change.

The latch is what makes it a control rather than a broadcast: `BotInstance.create`
and `BotInstance.resume` both call `assertAccountArmed`, so a tripped account
cannot gain a new bot or restart an old one until a human resets it.

## Known limitations

- **`getOpenOrders` takes a pair**, so an unexpected order can only be seen on a
  pair some bot on the account already trades. Widening this means changing
  section 4.1's interface.
- **Rate limiting is applied from outside this folder.** Nothing here knows
  about section 5.4. `/src/workers/reconciliation.ts` wraps the exchange client
  in the account's `RateLimiter` Durable Object at **routine** priority before
  passing it in, so every read below is gated while this module still takes all
  its dependencies as parameters. Routine because one pass costs ~20 weight plus
  ~26 per distinct pair every 5 minutes against 1200/minute — a periodic audit
  has no business drawing on the slice reserved for exiting positions. The halts
  this job performs are not affected: they go through `haltBot` into each bot's
  own object, which cancels at risk-exit priority.
- **No exchange client exists**, in either environment. Deployed today the cron
  fires and returns without touching D1.
