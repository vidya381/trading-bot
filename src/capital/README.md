# `/src/capital` — capital ledger and bot-creation validation

Spec section 8.5, build step 5. The gate every bot passes through before it
exists, and the only code that changes `capital_ledger.total_allocated`.

No Durable Object, no strategy logic, no HTTP surface. Step 6's `BotInstance`
Durable Object, step 7's reconciliation, and step 10's dashboard form all call
into here.

## Files

| File | What it is |
| --- | --- |
| `ledger.ts` | Create, close, resize. The availability check and the compare-and-swap loop. |
| `placeholder-balance.ts` | Seeding `total_balance` by hand, until reconciliation exists. **Read its header before using it.** |

## The three operations

```ts
// Section 8.5's check, plus the bot_instances row and its audit entry.
await createBotInstanceWithCapital(db, {
  id: "dca-btc-1",              // /^[a-z0-9][a-z0-9_-]{0,19}$/, checked first
  accountLabel: "main",
  asset: "USDT",                // which capital_ledger row funds this bot
  exchange: "binance",
  pair: "BTCUSDT",
  strategyType: "dca",
  strategyParams: { /* step 6's shape */ },
  stopLossPct: fromDecimalString("5.0"),
  takeProfitPct: fromDecimalString("2.0"),
  requestedCapital: fromDecimalString("1000.0"),
}, { actor: "owner@example.com", now: Date.now() });

await resizeBotCapital(db, "dca-btc-1", fromDecimalString("1500.0"), options);
await releaseBotCapital(db, "dca-btc-1", options);
```

Every failure is a `CapitalError` with a `code`, so a caller can tell
`insufficient_capital` (a decision) from `allocation_conflict` (retry this) from
`reservation_leaked` (get a human).

## An allocation is a reservation, not a valuation

Closing a bot releases exactly what was reserved for it, whatever the position
turned out to be worth. Profit and loss never touch `total_allocated`; they
reach `total_balance`, which reconciliation writes.

This is why migration 0001 has no `CHECK (total_allocated <= total_balance)`. A
losing bot legitimately leaves an account allocated beyond its balance, and that
state must be recordable so reconciliation can alert on it. What is blocked is
*new* allocation while the account is in it.

## Concurrency

Read, decide, then `UPDATE ... WHERE total_allocated = <the value that was
read>`. No rows changed means someone moved it in between: re-read, decide
again, up to five attempts, then `allocation_conflict`.

Deciding again rather than retrying the write is the point. Two creations that
each fit but do not both fit cannot both succeed, because the loser's retry
re-runs the availability check against what is now true.

A Durable Object would serialise this properly. There is not one in this
codebase until step 6, and making the validation layer that step 6 calls depend
on the project's first Durable Object is backwards.

## Why partial failures always over-reserve

D1 has no interactive transaction, only `batch`, which cannot span a conditional
update whose `changes` count has to be inspected. So each operation is two or
three statements that can be interrupted between them, and the ordering rule is:

> **grow the reservation before the bot row, shrink it after.**

Every partial failure then leaves capital reserved for a bot that is not using
it, never the same capital allocated to two bots. The first is visible in the
audit log and correctable by a human; the second is money actually lost.

## Allocation history lives in `audit_log`

`capital_ledger` is one mutable row per (account, asset) — current state, not an
event log. So `audit_log` is the only record that an allocation ever changed,
and every create, close and resize writes one entry with the before, the after,
the delta, and how many compare-and-swap attempts it took.

A resize to the size a bot already is writes nothing at all, including no audit
entry, because nothing changed.

## `total_balance` is not real yet

Nothing in this system observes the exchange's balance until step 7. Until then
`seedPlaceholderTotalBalance` is a human typing a number, and it says so: it
refuses an automated actor, demands a note, and stamps `"placeholder": true`
into every audit entry it writes.
