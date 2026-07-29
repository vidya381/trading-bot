# Provisioning the alert-cooldown KV namespace and the Discord webhook secret

> **Status: NOT executed.** Neither the `ALERT_COOLDOWNS` KV namespace nor the
> `DISCORD_WEBHOOK_URL` secret exists in either environment. Until both exist,
> the step-8 notification dispatcher no-ops on every tick — the same way
> reconciliation no-ops without exchange credentials — and no alert leaves the
> system as a ping, though every alert is still recorded in D1.
>
> This document is a runbook, not a record. It parallels
> [`d1-provisioning.md`](./d1-provisioning.md), which deferred D1 provisioning
> out of the build session that wrote the schema; this defers KV and the secret
> out of the build session that wrote the dispatcher.

These are two separate resources with two different lifecycles:

| Resource | Kind | Per environment | Committed to `wrangler.jsonc`? |
| --- | --- | --- | --- |
| `ALERT_COOLDOWNS` | KV namespace | yes, separate ids | yes, once created (a real id) |
| `DISCORD_WEBHOOK_URL` | secret | yes, separate URLs | **never** — secrets are not config |

## Why neither is in the repo yet

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

---

## 4. (Step 11) The tradable-pair cache KV namespace `SYMBOL_CACHE`

> **Status: NOT executed.** The `SYMBOL_CACHE` namespace does not exist in either
> environment yet. Until it does, `GET /api/accounts/:label/symbols` still works
> but **degrades to a live exchange call on every request** (the response says
> `cached: false`) rather than serving a one-hour-cached list. A missing cache is
> a performance concern, not a correctness one — unlike a missing credential,
> which fails closed.

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
