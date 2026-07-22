# Provisioning the D1 databases

> **Status: executed 2026-07-22.** Both databases exist; testnet is migrated
> through `0003`; production is created, bound, and deliberately empty. This
> document is now a record of what was run as much as a runbook. The parts
> still ahead are section 4 (production migrations, at go-live) and nothing
> else.
>
> | Environment | Database | `database_id` | Schema |
> | --- | --- | --- | --- |
> | testnet | `trading-bot-testnet` | `3f01f245-12b3-4b20-acf7-75b655da2bd7` | `0001`, `0002`, `0003` applied |
> | production | `trading-bot-production` | `4038bdd3-9715-4366-a6b4-d3b007df6258` | **none, on purpose** |
>
> Both were created in region `WNAM`, which was the default and was not
> specified.

> ### Standing convention: this document is not the source of truth
>
> **Before acting on any migration status written here, confirm it with a live
> query.** The database is authoritative; this file is a record of what someone
> believed at the time they last edited it.
>
> ```sh
> npx wrangler d1 execute DB --env testnet --remote \
>   --command "SELECT name, applied_at FROM d1_migrations ORDER BY id"
> ```
>
> This convention exists because the file has already been wrong once. See
> [section 3.1](#31-migrations-0002-and-0003--applied) for what happened. The
> failure mode is specific and worth naming: migrations get applied by a person
> at a terminal, in a minute, between sessions — while this file only gets
> edited during a session, by whoever happens to remember. Those two things
> drift apart by default, and nothing enforces otherwise.
>
> The same applies to production, where the check is the inverse — that it is
> still empty:
>
> ```sh
> npx wrangler d1 execute DB --env production --remote \
>   --command "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
> ```

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

Recorded results **at the time step 4.1 ran, with only `0001` applied**:
`strict_tables` 8, `idx` 17, `d1_migrations` holding exactly
`0001_initial_schema.sql`.

Those are a point-in-time record of this section, not the database's current
state — `0002` and `0003` have since been applied, so the live numbers are now
9 / 19 / three rows. Section 3.1 has the current figures, and the standing
convention at the top of this document applies: check, do not assume.

---

## 3.1 Migrations 0002 and 0003 — APPLIED

**Status: applied to remote testnet, confirmed 2026-07-22** by the account owner
via a direct `d1_migrations` query. Remote testnet is level with this
repository; there is no outstanding migration for that environment.

| Migration | Added by | What it does |
| --- | --- | --- |
| `0001_initial_schema.sql` | step 4 | the eight tables of section 8.2, 17 indexes |
| `0002_bot_instances_capital_asset.sql` | step 5 | `bot_instances.capital_asset` and one index |
| `0003_circuit_breakers.sql` | step 7 | the `circuit_breakers` table and one partial index |

Current expected state of remote testnet: **9** tables, **19** explicit
indexes, `d1_migrations` holding three rows.

To confirm — and per the standing convention at the top of this document, do
confirm rather than trusting the paragraph above:

```sh
npx wrangler d1 execute DB --env testnet --remote \
  --command "SELECT name, applied_at FROM d1_migrations ORDER BY id"

npx wrangler d1 execute DB --env testnet --remote \
  --command "SELECT name FROM pragma_table_info('bot_instances') WHERE name = 'capital_asset'"

npx wrangler d1 execute DB --env testnet --remote \
  --command "SELECT name FROM sqlite_master WHERE type='table' AND name='circuit_breakers'"
```

**Why `0003` mattered more than a schema change usually would.** Until it was
applied, `assertAccountArmed` — which `BotInstance.create` and
`BotInstance.resume` both call — queried a table that did not exist. Section 9's
severe tier cannot latch anything on a database without it, so a testnet deploy
before this migration would have had a circuit breaker that was not there. That
is now resolved, and it is left recorded because the same shape of problem
returns with every future migration that a risk control depends on.

Production is unaffected: it still has no schema at all, deliberately, and
section 4 below is still the only thing that would change that.

### Why this section was wrong, and for how long

Worth recording, because the fix is a habit rather than a command.

`0002` was written during step 5, which deliberately did not apply it — the
reasoning at the time was that "applying a migration to a real Cloudflare
database is a deliberate act, not a side effect of writing code", and that
reasoning is still right. It was then applied manually, at a terminal, outside
any session. **Nothing recorded that.** So this document went on asserting
"NOT YET APPLIED TO REMOTE TESTNET" through steps 5, 6 and 7 — across three
sessions — while the database had already moved on.

Step 7 then made it worse in a way worth noticing: it read this section, took
its status at face value, and *extended* the stale claim to cover `0003` as
well, producing a confident table listing two outstanding migrations of which
only one was real. A wrong document is not inert. It gets cited, and the
citation inherits the error and adds authority to it.

The structural cause is that the two events happen in different places at
different times: applying a migration takes one person one minute at a
terminal, while editing this file happens during a session, by whoever
remembers. Nothing connects them.

Three things reduce the chance of a repeat, in descending order of how much
they actually help:

1. **The standing convention at the top of this document**: confirm migration
   state with a live `d1_migrations` query before acting on anything written
   here. This is the only one that works even when the others are forgotten,
   because it treats the file as a claim rather than a fact.
2. **Apply and record in the same action.** If you run
   `wrangler d1 migrations apply` against a remote database, edit this section
   before closing the terminal. The command output is the evidence; a minute
   later it is gone.
3. **A migration a risk control depends on is not routine.** `0003` gates the
   circuit breaker; a future one may gate something similar. Those are worth
   confirming against the live database specifically, not just assuming the
   apply succeeded.

A CI check comparing `/migrations` against `d1_migrations` on testnet would
close this properly rather than by discipline. That belongs with step 13, where
step 4.1's open question 3 already warns that any CI migration step must be
testnet-only — production's emptiness is a safety property and nothing enforces
it.

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
