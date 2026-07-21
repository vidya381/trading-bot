# Provisioning the D1 databases

Build step 4 stopped one action short of creating real Cloudflare resources.
The schema, the migration and the access layer are finished and tested against
local D1 emulation; what is missing is two real databases and their IDs in
`wrangler.jsonc`.

This is the exact sequence to run once a scoped API token exists. Nothing here
has been run yet, so treat the output of each step as something to read rather
than skip.

Signatures below were checked against the installed wrangler (4.112.0), not
recalled.

---

## 0. Token scopes

Per spec section 18, prefer a scoped API Token over adding the builder as an
account Member — it is revocable on its own. The token needs:

| Scope | Level | Why |
| --- | --- | --- |
| Account → D1 | Edit | create the databases, apply migrations |
| Account → Workers Scripts | Edit | `wrangler deploy` (steps after this one) |
| Account → Account Settings | Read | lets wrangler resolve the account id |

Then, in the shell you will run these from:

```sh
export CLOUDFLARE_API_TOKEN="<the token>"
export CLOUDFLARE_ACCOUNT_ID="<account id>"   # only if the token can see >1 account
```

Do not put either in a file in this repository. `.env` and `.dev.vars` are
gitignored, but the token is account-wide and belongs in the shell session only.

Verify before doing anything that writes:

```sh
npx wrangler whoami
```

---

## 1. Create the two databases

Two separate databases, per spec section 16 — never one with a flag.

```sh
npx wrangler d1 create trading-bot-testnet
npx wrangler d1 create trading-bot-production
```

Each prints a `database_id` (a UUID). Keep both; step 2 needs them.

`--location` is available if you want to pin where the database lives. The
default is fine for v1: nothing here is latency-sensitive (section 1), and the
listing-snipe strategy that would care is explicitly out of scope (section 12).

---

## 2. Add the bindings to `wrangler.jsonc`

Add a `d1_databases` block inside **each** environment. Binding keys are
non-inheritable in Wrangler, which is what makes it impossible to point both
environments at one database by forgetting a line.

```jsonc
"env": {
  "testnet": {
    "name": "trading-bot-testnet",
    "workers_dev": true,
    "vars": {
      "ENVIRONMENT": "testnet"
    },
    "d1_databases": [
      {
        "binding": "DB",
        "database_name": "trading-bot-testnet",
        "database_id": "<id printed for trading-bot-testnet>",
        "migrations_dir": "migrations"
      }
    ]
  },

  "production": {
    "name": "trading-bot-production",
    "workers_dev": true,
    "vars": {
      "ENVIRONMENT": "production"
    },
    "d1_databases": [
      {
        "binding": "DB",
        "database_name": "trading-bot-production",
        "database_id": "<id printed for trading-bot-production>",
        "migrations_dir": "migrations"
      }
    ]
  }
}
```

Check the two `database_id` values are different before saving. This is the one
step in the sequence with no automated guard behind it.

---

## 3. Apply the migration to testnet

Dry-run against a local copy first — this costs nothing and catches a malformed
migration file:

```sh
npx wrangler d1 migrations apply DB --env testnet --local
```

Then for real:

```sh
npx wrangler d1 migrations apply DB --env testnet --remote
```

The command lists what it is about to apply and asks for confirmation. Expect
exactly one migration, `0001_initial_schema.sql`.

Confirm the result rather than trusting the exit code:

```sh
npx wrangler d1 execute DB --env testnet --remote \
  --command "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
```

Eight tables should be listed, plus `d1_migrations` and D1's own `_cf_METADATA`:
`alerts`, `audit_log`, `balance_snapshots`, `bot_instances`, `capital_ledger`,
`manual_adjustments`, `orders`, `trades`.

---

## 4. Production

Not yet. Section 16 requires testnet first, always. The production database can
be created now (step 1) so the config is complete, but running migrations
against it belongs with the first production deploy, alongside section 16.1's
checklist.

When that time comes it is the same command with `--env production`.

---

## 5. Afterwards, in this repository

Two clean-up edits, both of which will otherwise sit and rot:

1. **`vitest-env.d.ts`** — delete the `DB: D1Database` line. Once the binding is
   in `wrangler.jsonc`, `npm run cf-typegen` emits it into both `Env` and
   `Cloudflare.Env`, and two declarations that can disagree is worse than one.
   Keep `TEST_MIGRATIONS`; that one is test-only permanently.

2. **`vitest.config.ts`** — the `miniflare.d1Databases: ["DB"]` line can go,
   since the wrangler config now supplies the binding. Keep the
   `bindings.TEST_MIGRATIONS` entry.

Then re-run `npm test` and `npm run typecheck`. Both should still pass without
any change to `/src/db` — if they do not, the local and deployed schemas have
diverged, which is what the drift test in `src/db/schema.test.ts` is for.
