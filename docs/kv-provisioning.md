# Provisioning the alert-cooldown KV namespace and the Discord webhook secret

> **Status (sections 1–3): EXECUTED. Verified live 2026-09-10.** Both the
> `ALERT_COOLDOWNS` KV namespace and the `DISCORD_WEBHOOK_URL` secret now exist
> in **both** environments, so the step-8 notification dispatcher no longer
> no-ops on missing configuration.
>
> | | testnet | production |
> | --- | --- | --- |
> | `ALERT_COOLDOWNS` KV | ✅ `bf4f637666bd42a09a25b729744a7c16` | ✅ `f62b31ae1787470ebc81b93f07d55521` |
> | `DISCORD_WEBHOOK_URL` secret | ✅ set | ✅ set |
> | Delivery confirmed end to end | ❌ **never exercised** | ✅ 2026-09-10 |
>
> **Read that last row carefully: provisioned in both, but delivery is confirmed
> in production ONLY.** Testnet's secret is set and has never been POSTed to, so
> whether that URL is valid is unknown. Do not quote this table as "both
> environments work" — that is the exact overclaim this header previously made
> in the other direction.
>
> **How production was confirmed:** the dispatcher sends only for alert rows with
> `notified_at IS NULL`, and production's `alerts` table is empty, so the cron
> can run forever without ever exercising the webhook. It was therefore proved
> with a temporary `POST /api/debug/notification-check` route that built the real
> `DiscordNotifier` from the real secret and sent one synthetic `system`/`info`
> alert, touching no table and no queue — built, run once (`200`,
> `delivered: true`, message seen in the channel), and **removed the same day**,
> per the `/api/debug/ws-check` and `/api/debug/feed-check` convention
> (decision-log 14.6, 14.7). The route is gone; do not look for it.
>
> **Still outstanding:** `npm run cf-typegen` has been run, so
> `ALERT_COOLDOWNS` is in `worker-configuration.d.ts` and the KV half of the
> `declare global` in `src/workers/notifications.ts` is now redundant. The
> `DISCORD_WEBHOOK_URL` half must **stay** — `wrangler types` cannot emit a
> secret, so nothing else declares it. Section 4's `SYMBOL_CACHE` is a separate
> resource with its own, different status; see there.
>
> This document is a runbook first and a record second. It parallels
> [`d1-provisioning.md`](./d1-provisioning.md), which deferred D1 provisioning
> out of the build session that wrote the schema; this deferred KV and the secret
> out of the build session that wrote the dispatcher. The commands below are kept
> as written so a third environment can be provisioned the same way.

These are two separate resources with two different lifecycles:

| Resource | Kind | Per environment | Committed to `wrangler.jsonc`? |
| --- | --- | --- | --- |
| `ALERT_COOLDOWNS` | KV namespace | yes, separate ids | yes, once created (a real id) |
| `DISCORD_WEBHOOK_URL` | secret | yes, separate URLs | **never** — secrets are not config |

## Why neither was in the repo at first (historical)

- The KV namespace is not in `wrangler.jsonc` because this project does not
  commit placeholder resource ids (step 4, decision 1): a fake id sitting in
  config is easy to mistake for a real one, and `wrangler deploy` fails on it
  anyway. Tests get a local KV from `vitest.config.ts`'s miniflare
  `kvNamespaces` instead, which needs no real resource.
- The secret is never in `wrangler.jsonc` by nature. It is set with
  `wrangler secret put` and lives only in Cloudflare's secret store.

## 1. Create the KV namespace (one per environment)

```sh
# Testnet
npx wrangler kv namespace create ALERT_COOLDOWNS --env testnet
# Production
npx wrangler kv namespace create ALERT_COOLDOWNS --env production
```

Each command prints an `id`. Add the binding under **both** environments in
`wrangler.jsonc` (binding keys are non-inheritable, so each environment must
declare its own, pointing at its own id — the same separation the two
`database_id` values already express):

```jsonc
"kv_namespaces": [
  { "binding": "ALERT_COOLDOWNS", "id": "<the id printed for that environment>" }
]
```

Then regenerate types so `env.ALERT_COOLDOWNS` is known to the compiler and the
manual `declare global` augmentation in `src/workers/notifications.ts` can be
removed (it exists only to bridge the gap until this step is done):

```sh
npm run cf-typegen
```

## 2. Set the Discord webhook secret (one per environment)

Create an incoming webhook in the destination Discord channel
(Server Settings → Integrations → Webhooks → New Webhook → Copy Webhook URL),
then:

```sh
npx wrangler secret put DISCORD_WEBHOOK_URL --env testnet
# paste the testnet channel's webhook URL when prompted

npx wrangler secret put DISCORD_WEBHOOK_URL --env production
# paste the production channel's webhook URL when prompted
```

Use a **different channel per environment**, for the same reason the two
environments are separate everywhere else (section 16): a production halt alert
must not be indistinguishable from a testnet one. A testnet-vs-production label
is already on every message (the embed fields), but separate channels make it
unmissable.

The secret is never committed, never passed to a build step, and never printed
in a test — tests use a mocked URL only.

## 3. Verify

After both resources exist in an environment, the every-minute cron stops
no-opping. Confirm by checking the Worker's logs (observability is on) for a
line like `notification dispatch: scanned=… sent=… throttled=… failed=…`
instead of `notification dispatch did not run: …`.

**⚠ That log line does NOT prove the webhook works.** In production it currently
reads `scanned=0 sent=0 throttled=0 failed=0` every minute, because the `alerts`
table is empty and the dispatcher only sends for rows with `notified_at IS NULL`.
A perfectly healthy-looking cron log is therefore compatible with a completely
invalid webhook URL: with nothing to send, `DiscordNotifier` is never handed an
alert and never POSTs. Proving delivery needs an actual send — see the header for
how that was done on 2026-09-10, and note that the route used was removed the
same day.

---

## 4. (Step 11) The tradable-pair cache KV namespace `SYMBOL_CACHE`

> **Status: PARTIALLY executed, as of 2026-09-10 — testnet only.**
> `SYMBOL_CACHE` exists and is bound for **testnet**
> (`987f8b7b34c747be94652ba6d23dcfd6`); it does **not** exist for **production**,
> which has no such namespace on the account and no binding in `wrangler.jsonc`.
> So testnet serves the one-hour-cached list, and production still
> **degrades to a live exchange call on every request** (the response says
> `cached: false`). A missing cache is a performance concern, not a correctness
> one — unlike a missing credential, which fails closed.
>
> To finish, run only the production half of the commands below.

Same kind of resource, same reason it is not in the repo yet, and the same
handling as `ALERT_COOLDOWNS`: it is a second KV namespace (step 11, section
8.3), declared for tests via `vitest.config.ts`'s miniflare `kvNamespaces` and
kept out of `wrangler.jsonc` until a real id exists (no placeholder ids — step 4,
decision 1). The Worker's optional view of it is the `declare global`
augmentation in `src/workers/symbols.ts`.

```sh
# Testnet
npx wrangler kv namespace create SYMBOL_CACHE --env testnet
# Production
npx wrangler kv namespace create SYMBOL_CACHE --env production
```

Add the binding under **both** environments' `kv_namespaces` in `wrangler.jsonc`
(alongside `ALERT_COOLDOWNS`), each pointing at its own printed id:

```jsonc
"kv_namespaces": [
  { "binding": "ALERT_COOLDOWNS", "id": "<that environment's cooldown id>" },
  { "binding": "SYMBOL_CACHE",    "id": "<that environment's symbol-cache id>" }
]
```

Then `npm run cf-typegen`, after which the `declare global` in
`src/workers/symbols.ts` can be removed. Confirm by calling the endpoint twice
for one account: the second response should report `cached: true`.
