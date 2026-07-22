# Provisioning the D1 databases

> **Status: executed 2026-07-22.** Both databases exist; testnet is migrated;
> production is created, bound, and deliberately empty. This document is now a
> record of what was run as much as a runbook. The parts still ahead are
> section 4 (production migrations, at go-live) and nothing else.
>
> | Environment | Database | `database_id` | Schema |
> | --- | --- | --- | --- |
> | testnet | `trading-bot-testnet` | `3f01f245-12b3-4b20-acf7-75b655da2bd7` | applied |
> | production | `trading-bot-production` | `4038bdd3-9715-4366-a6b4-d3b007df6258` | **none, on purpose** |
>
> Both were created in region `WNAM`, which was the default and was not
> specified.

Build step 4 stopped one action short of creating real Cloudflare resources.
The schema, the migration and the access layer were finished and tested against
local D1 emulation; what was missing was two real databases and their IDs in
`wrangler.jsonc`.

Signatures below were checked against the installed wrangler (4.112.0), not
recalled.

---

## 0. Authentication

**What actually happened:** `wrangler login` (OAuth), not a scoped API token.
The account is the builder's own — see the step 4.1 decision log entry for why
that changed — so the delegation argument for a scoped token does not currently
apply. The OAuth token carries `d1 (write)`, which is what this needed.

If a scoped API Token is used instead (spec section 18 prefers one where access
is delegated, since it is revocable on its own), it needs:

| Scope | Level | Why |
| --- | --- | --- |
| Account → D1 | Edit | create the databases, apply migrations |
| Account → Workers Scripts | Edit | `wrangler deploy` (steps after this one) |
| Account → Account Settings | Read | lets wrangler resolve the account id |

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

This confirms both the identity and that `d1 (write)` is in scope. It printed a
single account, so `CLOUDFLARE_ACCOUNT_ID` was not needed.

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
Both landed in `WNAM`.

**One thing to watch.** After creating each database, wrangler offers to add the
binding to `wrangler.jsonc` for you, and the snippet it proposes uses a binding
name derived from the database name — `trading_bot_testnet`, not `DB`. Accepting
it would give the two environments *different* binding names, so `env.DB` would
be undefined in one of them and the access layer would fail at runtime rather
than at build time. Decline and write the block by hand, as step 2 does. In a
non-interactive shell wrangler defaults to declining, which is the safe default.

Confirm both exist and are distinct before continuing:

```sh
npx wrangler d1 list
```

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

Eight tables should be listed: `alerts`, `audit_log`, `balance_snapshots`,
`bot_instances`, `capital_ledger`, `manual_adjustments`, `orders`, `trades`.

Alongside them will be `d1_migrations`, `sqlite_sequence`, and D1's own internal
table — which is named **`_cf_KV`**, not `_cf_METADATA` as this document
originally guessed. Corrected from the real output.

Two further checks worth running, because they verify the properties the whole
schema rests on rather than just that something was created:

```sh
# All 8 tables must be STRICT. Without it an INTEGER money column silently
# accepts and stores a TEXT value.
npx wrangler d1 execute DB --env testnet --remote \
  --command "SELECT COUNT(*) AS strict_tables FROM sqlite_master WHERE type='table' AND sql LIKE '%STRICT'"

# 17 explicit indexes.
npx wrangler d1 execute DB --env testnet --remote \
  --command "SELECT COUNT(*) AS idx FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%'"
```

Recorded results: `strict_tables` 8, `idx` 17, `d1_migrations` holding exactly
`0001_initial_schema.sql`.

---

## 4. Production — NOT YET

Deliberately not done. Section 16 requires testnet first, always. The production
database is created and bound so the config is complete and correct, and it
contains no schema at all.

Verified as of 2026-07-22: `SELECT name FROM sqlite_master WHERE type='table'`
against production returns only `_cf_KV`, D1's own internal table. No
`d1_migrations`, no application tables.

Applying the schema there is one command, and it belongs with the first
production deploy alongside section 16.1's checklist — not with provisioning:

```sh
npx wrangler d1 migrations apply DB --env production --remote
```

Do not run it to "get it out of the way". An empty production database is a
useful safety property in itself: nothing can write real trading data to it,
whatever else goes wrong, until someone deliberately runs that line.

---

## 5. Afterwards, in this repository — DONE

Both clean-up edits were made on 2026-07-22:

1. **`vitest-env.d.ts`** — the `DB: D1Database` line is gone. The binding now
   comes from `wrangler types` via `worker-configuration.d.ts`. Only
   `TEST_MIGRATIONS` is declared by hand; that one is test-only permanently.

2. **`vitest.config.ts`** — `miniflare.d1Databases: ["DB"]` is gone, since the
   wrangler config supplies the binding. The `bindings.TEST_MIGRATIONS` entry
   stays.

One consequence worth knowing about, which was not anticipated when this
document was written. `wrangler types` emits `DB?: D1Database` — **optional** —
on the base env, and it is right to: the base config block has no D1 binding, so
a Worker deployed with no `--env` genuinely has no database. Tests are pinned to
the testnet environment where it always exists, so `test-helpers.ts` narrows it
in exactly one place (`rawD1()`) with a runtime check and a real error message,
rather than asserting non-null at each use.

### Tests still run locally

Worth stating explicitly, because it is the kind of assumption that is expensive
to get wrong: declaring the binding in `wrangler.jsonc` does **not** point the
test suite at the remote database. Miniflare creates a local SQLite database
from the binding, and `remoteBindings` defaults to off.

This was verified rather than assumed. A sentinel row was inserted into the
remote testnet database, the full suite was run — every test calls
`freshDatabase()`, which does `DELETE FROM` on all eight tables — and the
sentinel was still there afterwards. It was then removed, and all eight tables
confirmed at zero rows.

Re-run this check if the pool version or `remoteBindings` ever changes. A test
suite that silently truncates a real database is a bad thing to discover late.
