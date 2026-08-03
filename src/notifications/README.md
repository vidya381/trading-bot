# `/src/notifications` — alerts outbound notification (section 10, step 8)

The **notifying** half of section 10. The **recording** half is the pipeline
that raises each alert (the `BotInstance` Durable Object, reconciliation, the
circuit breaker) plus [`/src/alerts`](../alerts), which owns the one case where
a row is written *conditionally*: a condition re-detected on a schedule gets one
row per open incident rather than one per detection, keyed on the same
`(alert type, bot instance)` the cooldown here uses. Everything else is written
unconditionally. Nothing here writes an alert row; this code reads recorded
alerts and turns them into outbound pings, subject to a cooldown.

## Files

- `notifier.ts` — `AlertNotifier`, the provider-agnostic seam, plus
  `NotifiableAlert` (an alert as a fact to announce, not a DB row) and
  `NotifyResult`. The dispatcher depends on nothing else.
- `discord.ts` — `DiscordNotifier`, the one provider built at step 8. Reads the
  webhook from the `DISCORD_WEBHOOK_URL` secret (passed in, never hard-coded).
  Makes the two section-10 categories distinguishable both visually (embed
  colour + emoji + label) and structurally (Category/Severity fields).
- `cooldown.ts` — the KV-based cooldown (sections 8.3, 10): one key per
  `(alert type, bot instance)`, default 15-minute window. `KvCooldownStore` is
  real; `InMemoryCooldownStore` is for deterministic tests.
- `dispatch.ts` — `dispatchPendingAlerts`, the "one place responsible". Scans
  `alerts WHERE notified_at IS NULL`, applies the cooldown, sends, and stamps
  `notified_at`. Ports-only; no bindings.

## Where it runs

A Cron Trigger (`scheduled` handler on the main Worker, distinct 1-minute cron),
wired in `/src/workers/notifications.ts`. A cron rather than inline sends
because recording and notifying are separate concerns (section 10), alerts come
from two execution contexts, and an outbound webhook must never sit on the
BotInstance halt path where speed is a safety property. See `dispatch.ts`.

## Recording vs notifying

`alerts.notified_at` (migration 0004) is the dispatcher's per-row queue marker,
independent of `resolved` (which reconciliation owns). A row is stamped when the
dispatcher sends OR deliberately throttles it, and left NULL when a send was
attempted and failed, so the next run retries. The alert is in D1 regardless.

## Not built yet

- **Provisioning.** The `ALERT_COOLDOWNS` KV namespace and the
  `DISCORD_WEBHOOK_URL` secret are not created in either environment. Until they
  are, the dispatcher no-ops (the same way reconciliation no-ops without exchange
  credentials). See `docs/kv-provisioning.md`. Tests use a miniflare KV and a
  mocked webhook URL only — never a real one.
- **Telegram.** Section 2 allows either provider; only Discord is built. A second
  is a new class implementing `AlertNotifier`, changing nothing else here.
