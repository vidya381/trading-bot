-- Migration 0012: `kraken` accepted by the accounts.exchange CHECK
-- (spec sections 4.4, 16; decision log 89, 90, 94).
--
-- Migration 0006's own header named this migration in advance: "Adding a third
-- exchange later is deliberately a VALUE change, not a restructuring: widen the
-- `ExchangeId` union by one member and widen this CHECK by one string in a
-- follow-up migration." `ExchangeId` was widened by entry 94. This is the CHECK,
-- and it is the last piece of entry 90's build order.
--
-- Until it runs, `accounts.exchange` refuses the string 'kraken' outright, so a
-- Kraken account cannot be registered and the registry path -- the one bot
-- creation derives the exchange FROM -- stays closed by SQL. Entry 94 put that
-- plainly: the registered-account creation path is closed by SQL, not by code.
--
-- ---------------------------------------------------------------------------
-- ORDERING: THIS IS DELIBERATELY LAST
-- ---------------------------------------------------------------------------
-- Entry 94 PART 6: the client (91-93), the resolver and dispatch case (95), and
-- the rate limiter (96) all come FIRST. They are all committed, and Kraken is
-- wired: `isWiredExchange('kraken')` is now true because BOTH of its derived
-- blockers are closed -- `EXCHANGE_RESOLVERS.kraken` is real (entry 95) and
-- `METHOD_COSTS.kraken` exists (entry 96). Nothing was flipped by hand; see
-- workers/venue-wiring.ts.
--
-- This migration is the step that makes the REGISTRY branch reachable -- the
-- path where `accounts` is authoritative and bot creation derives the exchange
-- from the row rather than the request. Running it before those steps would have
-- opened a door onto a venue that could not yet trade, on the path everything
-- downstream trusts most. `assertExchangeIsWired` is the guard standing at that
-- door once this is applied, which is why entry 94 had it check
-- `resolveBotExchange`'s RETURN VALUE rather than the request body: the value
-- read out of this table passes through it too.
--
-- ---------------------------------------------------------------------------
-- WHAT IS AND IS NOT IN SCOPE
-- ---------------------------------------------------------------------------
-- The CHECK, and nothing else. Three things were checked rather than assumed:
--
--   * THERE IS NO INDEX ON `accounts.exchange`. Entry 90 PART 5 said this
--     migration must widen "the CHECK and the partial index beside it"; entry 94
--     corrected it, and the live testnet schema confirms the correction --
--     `sqlite_master` for `accounts` holds the table and
--     `sqlite_autoindex_accounts_1` (the implicit PRIMARY KEY index, which the
--     PRIMARY KEY declaration below recreates on its own) and nothing else.
--     There is no index to rebuild here and no `CREATE INDEX` at the end of this
--     file, unlike 0010.
--
--   * `bot_instances.exchange` HAS NO CHECK AT ALL. 0006's header records why:
--     it is the denormalised copy, free-typed since 0001 and validated against
--     this table at create time. `accounts` is the only table in the schema
--     whose exchange column is constrained, so this is the only rebuild needed.
--
--   * MIGRATION 0006's BACKFILL `SELECT ... WHERE exchange IN ('binance',
--     'gemini')` IS NOT EDITED. It is a one-time statement inside an
--     already-applied migration; `applyD1Migrations` records applied migrations
--     by filename, so editing it would change nothing anywhere it has already
--     run and would only make the file lie about what was executed. The same
--     reason 0002, 0004, 0007 and 0011 all give for being separate files.
--
-- ---------------------------------------------------------------------------
-- WHY A REBUILD
-- ---------------------------------------------------------------------------
-- SQLite cannot alter a CHECK in place -- there is no `ALTER TABLE ... DROP
-- CONSTRAINT` -- so the only supported way to change one is to rebuild the
-- table. 0002 and 0007 are `ALTER TABLE ... ADD COLUMN`, which SQLite supports
-- directly; nothing here can be expressed that way. This is the second rebuild
-- in this project, after 0010.
--
-- ---------------------------------------------------------------------------
-- ⚠ THE DEFERRED FOREIGN-KEY COUNTER. READ DECISION LOG 83 BEFORE CHANGING THIS
-- ---------------------------------------------------------------------------
-- `accounts` HAS FOREIGN-KEY DEPENDENTS. This was checked against the schema
-- rather than assumed, because the naive shape below is wrong exactly and only
-- when it does:
--
--   watchlist.account_label  TEXT NOT NULL REFERENCES accounts (account_label)  -- 0008
--   proposals.account_label  TEXT NOT NULL REFERENCES accounts (account_label)  -- 0009, rebuilt by 0010
--
-- On testnet today that is 10 + 14 = 24 child rows against 2 account rows.
--
-- So the hazard entry 83 documented applies here in full. Restated, because it
-- is the part most likely to be undone by someone acting reasonably: SQLite's
-- deferred foreign-key enforcement is a violation COUNTER, not a re-check of the
-- data. `DROP TABLE accounts` performs an implicit delete of every parent row,
-- which INCREMENTS that counter once per orphaned child -- 24 times here.
-- `ALTER TABLE ... RENAME TO` is a SCHEMA operation: it puts the rows back where
-- the children can see them, but it NEVER decrements the counter. At COMMIT the
-- counter is still 24 and the whole transaction is refused with
--
--   FOREIGN KEY constraint failed: SQLITE_CONSTRAINT_FOREIGNKEY
--
-- even though the data is completely consistent at that moment. That is not a
-- hypothesis: 0010 revision 1 had this shape, passed every local test, and
-- failed three times against remote D1.
--
-- THE FIX, IDENTICAL TO 0010's: an INSERT into the parent is what DECREMENTS the
-- counter. The rows are parked in an unreferenced staging table, the replacement
-- is renamed into place EMPTY, and the rows are then returned by DML INSERT --
-- taking the counter back to zero before COMMIT.
--
-- ⚠ DO NOT "SIMPLIFY" THIS BACK INTO stage-drop-rename. It will pass every test
-- you can run against an empty or near-empty database and fail against a
-- populated one, which is exactly what happened to 0010.
--
-- ⚠ AND DO NOT CONCLUDE FROM "ONLY 24 ROWS" THAT IT IS SAFE. The counter does
-- not have a threshold. One orphaned child row is enough to refuse the commit,
-- and this table has 24.
--
-- `PRAGMA foreign_keys = OFF` is not an option: D1 rejects it explicitly and
-- documents that user queries cannot change it. `defer_foreign_keys` is the only
-- mechanism available and must stay.

PRAGMA defer_foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- accounts
-- ---------------------------------------------------------------------------
-- Column order is preserved EXACTLY -- account_label, exchange, created_at,
-- updated_at. `schema.test.ts` asserts "exactly the columns the spec declares,
-- in the same order" against a live database, and separately that every table
-- is STRICT, so a reordered or non-STRICT rebuild fails there loudly.

-- Park the rows somewhere nothing references, so the DROP below cannot take them
-- with it. Deliberately a bare `AS SELECT` copy, as in 0010: it needs no
-- constraints of its own, and restating them here would be a second place for
-- them to drift.
CREATE TABLE accounts_backup AS SELECT * FROM accounts;

CREATE TABLE accounts_new (
  -- The label bots and ledger rows already reference by `account_label`. Primary
  -- key, so it is unique and is the natural lookup for the registry.
  account_label TEXT    NOT NULL PRIMARY KEY,

  -- The one line this migration exists for: 'kraken' added, nothing else
  -- changed. The set mirrors `ExchangeId` in src/db/schema.ts, already widened
  -- by entry 94; widen both together to add a fourth.
  exchange      TEXT    NOT NULL CHECK (exchange IN ('binance', 'gemini', 'kraken')),

  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
) STRICT;

DROP TABLE accounts;
ALTER TABLE accounts_new RENAME TO accounts;

-- THE LINE THE STAGING TABLE EXISTS FOR. An INSERT into the parent decrements
-- the deferred counter that the DROP incremented; the RENAME above does not.
INSERT INTO accounts
  SELECT account_label, exchange, created_at, updated_at
    FROM accounts_backup;

DROP TABLE accounts_backup;

-- No `CREATE INDEX` here, and that is deliberate rather than forgotten: see the
-- header. `accounts` carries only its implicit PRIMARY KEY index, which the
-- declaration above recreates.
