# `/src/alerts` — the recording half of section 10

What goes **into** the `alerts` table, and when a row is one *incident* rather
than one *detection*. [`/src/notifications`](../notifications) is the notifying
half and deliberately writes no alert row; this is its counterpart.

| File | What it is |
| --- | --- |
| `standing.ts` | `raiseStandingAlert` / `resolveClearedStandingAlerts`: one row per open incident |

## What a standing alert is for

Most alerts in this system mark a **discrete event** — a fill for an unknown
order, a cancellation that failed, an order the state machine refused. One row
per event is exactly right for those, and they are written unconditionally by
`BotInstance.#alert` and friends.

A standing alert is for the other kind: a **condition that is re-detected on a
schedule and deliberately never auto-corrected**. There the row count measures
how long the condition has persisted rather than what is wrong. Measured, on
2026-07-31: 186 identical unresolved criticals in four hours from reconciliation
alone. Step 20's open-order poll runs every 30 seconds, which is ~2,880 per bot
per day for one unchanged fact.

## Two halves, never separated

`raiseStandingAlert` writes at most one unresolved row per
`(alert_type, bot_instance_id)` — deliberately the same key
`notifications/cooldown.ts` throttles on, so the recording and notifying layers
agree on what "the same alert" is. The message is **not** part of the key: a
re-detection whose wording drifts is the same incident.

`resolveClearedStandingAlerts` closes the incidents a pass did not re-find, and
is gated on that pass having **actually observed** the data. A pass that could
not reach the exchange found nothing because it saw nothing; resolving on that
basis clears a live incident on the strength of an outage (section 5.6).

Taking only the raise half is strictly worse than an unconditional insert: one
row that never clears, suppressing every future alert of that kind forever.

## Ownership: why `source` scopes both halves

A writer may only close an incident it was in a position to observe, so a writer
that cannot resolve a row must not deduplicate against it either — it would
suppress its own alert behind a row it can never clear. Both halves therefore
scope to one `source`, identically.

Three independent things keep the two current writers apart, and the tests pin
each one separately:

| | reconciliation's cron | `BotInstance`'s poll |
| --- | --- | --- |
| `source` | `reconciliation` | `bot-instance` |
| `owns` | `isReconciliationAlertType` | `unattributable_fill`, `poll_blind`, `poll_blind_escalated` |
| `scope` | `{ kind: "account" }` — the account's bots, plus the rows belonging to no bot | `{ kind: "bot" }` — this bot |

`scope` is a descriptor rather than the `inScope` predicate it replaced, because
a predicate cannot be pushed into a `WHERE` clause and this one had to be. Every
`BotInstance` writes under the single `source` `bot-instance`, so a poll that
filtered in JS read the whole fleet's open rows to act on its own — on a
30-second timer. `standing.ts` derives both the SQL filter and the row test from
the one descriptor, so the read and the check cannot disagree about what a pass
owns. Migration 0011 adds the index the narrowed read seeks on.

`owns` matters most for the poll: `order_state_drift` and `cancel_failed` are
written by the same object under the same source, and are reconciliation's to
ingest and close. A poll that claimed them would close incidents it never
observed — and, since step 18.1 gates the "Apply missed fills" control on an
**unresolved** drift row, would make the repair control disappear from a bot
that still needs it.

## Nothing historical is lost

Every reconciliation run writes its complete findings list to
`audit_log.details_json`, and the poll audits every pass that moved anything.
The per-detection record still exists, in the table built for history. `alerts`
becomes what its `resolved` column always implied: a list of open incidents.
