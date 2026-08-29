-- Migration 0010: `trailing_stop` accepted by both strategy_type CHECKs (spec 22).
--
-- Spec 22.4 touchpoint 9. Two constraints shadow `StrategyType` in SQL and are
-- invisible to TypeScript, so widening the union without this migration produces
-- a strategy the code can construct and the database refuses to store.
--
-- ---------------------------------------------------------------------------
-- ⚠ REVISION 2. THE FIRST VERSION OF THIS FILE FAILED THREE TIMES AGAINST
-- REMOTE D1 AND WAS ROLLED BACK EACH TIME. READ THIS BEFORE CHANGING IT.
-- ---------------------------------------------------------------------------
-- Revision 1 did: stage into `_new`, DROP the original, RENAME `_new` into
-- place. That passes against an EMPTY database (local D1, miniflare, the test
-- suite) and fails against a POPULATED one with:
--
--   FOREIGN KEY constraint failed: SQLITE_CONSTRAINT_FOREIGNKEY
--
-- THE CAUSE IS NOT BAD DATA, AND IT IS NOT THE PRAGMA. Both were checked:
-- `PRAGMA foreign_key_check` on a real testnet export is EMPTY, and D1 does
-- support `defer_foreign_keys` (it rejects `foreign_keys = OFF`, which is why
-- the deferred form is used here and must stay).
--
-- The cause is that SQLite's deferred foreign-key enforcement is a COUNTER, not
-- a re-check of the data. `DROP TABLE bot_instances` performs an implicit
-- delete of every parent row, which INCREMENTS that counter once per orphaned
-- child -- on the real testnet database, 1099 of them across orders, trades,
-- alerts, audit_log and proposals. `ALTER TABLE ... RENAME TO` is a SCHEMA
-- operation: it puts the rows back where children can see them, but it never
-- decrements the counter. At COMMIT the counter is still 1099 and the
-- transaction is refused.
--
-- This was reproduced locally against a real export, and the proof is worth
-- keeping: immediately before the failing COMMIT, the replacement table held
-- all 30 rows and a LEFT JOIN found ZERO actual orphans. The database was
-- consistent. The counter was not. That is why no amount of checking the data
-- explains the failure, and why the fix is not about the data either.
--
-- THE FIX: the rows must return to the table children reference by way of a
-- DML INSERT, because an INSERT into a parent is what DECREMENTS the deferred
-- counter. So the data is parked in an unreferenced staging table, the
-- replacement is renamed into place EMPTY, and the rows are then INSERTed --
-- taking the counter back to zero before COMMIT. Same end state, same column
-- order, one extra copy.
--
-- ⚠ DO NOT "SIMPLIFY" THIS BACK INTO stage-drop-rename. It will pass every test
-- you can run locally and fail in production, which is exactly what happened.
--
-- ---------------------------------------------------------------------------
-- WHY REBUILD AT ALL
-- ---------------------------------------------------------------------------
-- SQLite cannot alter a CHECK in place: there is no `ALTER TABLE ... DROP
-- CONSTRAINT`, and the only supported way to change one is to rebuild the
-- table. 0002 and 0007 are `ALTER TABLE ... ADD COLUMN`, which SQLite supports
-- directly; nothing here could have been expressed that way.
--
-- ---------------------------------------------------------------------------
-- THE ADJACENT QUESTION 22.4 TOUCHPOINT 9 RAISES: DOES `trailing_stop` NEED ITS
-- OWN MANDATORY-FIELD CHECK, LIKE `dca_requires_take_profit`?
-- ---------------------------------------------------------------------------
-- DECIDED: NO. `dca_requires_take_profit` exists because `take_profit_pct` is
-- NULLABLE -- optional for grid, mandatory for DCA where it defines the cycle's
-- exit. A trailing stop has no such field. Its stop is `stop_loss_pct`, which is
-- ALREADY `NOT NULL CHECK (> 0)` for every row (section 6.1), and it has no
-- take-profit to require: per 22.1 the strategy exists so that a profit target
-- does not have to be guessed in advance.
--
-- The real hazard is that `stop_loss_pct` and `trailPct` are ONE quantity with
-- two homes. That is settled in `createTrailingStop`, which writes the column
-- from `params.trailPct` and nowhere else, making the params authoritative and
-- the column its mirror. A CHECK could only express it via `json_extract`,
-- coupling the schema to the internal shape of a blob `schema.ts` deliberately
-- types as `unknown`.

PRAGMA defer_foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- bot_instances
-- ---------------------------------------------------------------------------
-- Column order is preserved EXACTLY, including the two appended by later
-- migrations (`capital_asset` from 0002, `archived` from 0007, in that order).
-- `schema.test.ts` asserts "exactly the columns the spec declares, in the same
-- order" against a live database, so a reordered rebuild fails there loudly.

-- Park the rows somewhere nothing references, so the DROP below cannot take
-- them with it. Deliberately a bare `AS SELECT` copy: it needs no constraints,
-- and restating them here would be a second place for them to drift.
CREATE TABLE bot_instances_backup AS SELECT * FROM bot_instances;

CREATE TABLE bot_instances_new (
  id                   TEXT    NOT NULL PRIMARY KEY
                               CHECK (id GLOB '[a-z0-9]*' AND length(id) BETWEEN 1 AND 20),
  account_label        TEXT    NOT NULL,
  exchange             TEXT    NOT NULL,
  pair                 TEXT    NOT NULL,
  strategy_type        TEXT    NOT NULL CHECK (strategy_type IN ('grid', 'dca', 'trailing_stop')),
  strategy_params_json TEXT    NOT NULL,
  stop_loss_pct        INTEGER NOT NULL CHECK (stop_loss_pct > 0),
  take_profit_pct      INTEGER CHECK (take_profit_pct IS NULL OR take_profit_pct > 0),
  allocated_capital    INTEGER NOT NULL CHECK (allocated_capital > 0),
  status               TEXT    NOT NULL
                               CHECK (status IN ('created', 'running', 'halted', 'stopped')),
  halt_reason          TEXT,
  halted_at            INTEGER,
  schema_version       INTEGER NOT NULL DEFAULT 1 CHECK (schema_version >= 1),
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL,
  capital_asset        TEXT    NOT NULL DEFAULT 'USDT',
  archived             INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),

  CONSTRAINT dca_requires_take_profit
    CHECK (strategy_type <> 'dca' OR take_profit_pct IS NOT NULL),

  CONSTRAINT halt_requires_reason
    CHECK (status <> 'halted' OR (halt_reason IS NOT NULL AND halted_at IS NOT NULL))
) STRICT;

DROP TABLE bot_instances;
ALTER TABLE bot_instances_new RENAME TO bot_instances;

-- THE LINE THE WHOLE REVISION EXISTS FOR. An INSERT into the parent is what
-- decrements the deferred counter the DROP incremented; a RENAME is not.
INSERT INTO bot_instances
  SELECT id, account_label, exchange, pair, strategy_type, strategy_params_json,
         stop_loss_pct, take_profit_pct, allocated_capital, status, halt_reason,
         halted_at, schema_version, created_at, updated_at, capital_asset, archived
    FROM bot_instances_backup;

DROP TABLE bot_instances_backup;

CREATE INDEX idx_bot_instances_account_status ON bot_instances (account_label, status);
CREATE INDEX idx_bot_instances_created_at ON bot_instances (created_at);
CREATE INDEX idx_bot_instances_account_asset ON bot_instances (account_label, capital_asset);

-- ---------------------------------------------------------------------------
-- proposals
-- ---------------------------------------------------------------------------
-- Nothing references `proposals`, so its DROP orphans nothing and the counter
-- hazard above does not arise here. It is rebuilt by the identical procedure
-- anyway: two procedures for one problem in one file is how the second one
-- drifts. Rebuilt AFTER `bot_instances`, because its rows reference that table
-- and it must be whole before they are re-inserted.
CREATE TABLE proposals_backup AS SELECT * FROM proposals;

CREATE TABLE proposals_new (
  id                      TEXT    NOT NULL PRIMARY KEY,
  stage                   TEXT    NOT NULL CHECK (stage IN ('assess', 'derive')),
  account_label           TEXT    NOT NULL REFERENCES accounts (account_label),
  pair                    TEXT    NOT NULL,
  entry_point             TEXT    NOT NULL CHECK (entry_point IN ('named', 'watchlist', 'general')),
  strategy_type           TEXT    NOT NULL CHECK (strategy_type IN ('grid', 'dca', 'trailing_stop')),
  actor                   TEXT    NOT NULL,
  model                   TEXT    NOT NULL,
  prompt_version          TEXT    NOT NULL,
  data_fetched_at         INTEGER NOT NULL,
  inputs_json             TEXT    NOT NULL,
  reasoning_json          TEXT    NOT NULL,
  created_at              INTEGER NOT NULL,
  outcome                 TEXT    CHECK (outcome IN ('approved', 'rejected')),
  outcome_bot_instance_id TEXT    REFERENCES bot_instances (id),
  outcome_actor           TEXT,
  outcome_at              INTEGER,
  outcome_note            TEXT,

  CONSTRAINT outcome_is_recorded_whole
    CHECK ((outcome IS NULL     AND outcome_actor IS NULL     AND outcome_at IS NULL
                               AND outcome_bot_instance_id IS NULL AND outcome_note IS NULL)
        OR (outcome IS NOT NULL AND outcome_actor IS NOT NULL AND outcome_at IS NOT NULL)),
  CONSTRAINT approval_names_a_bot
    CHECK (outcome <> 'approved' OR outcome_bot_instance_id IS NOT NULL),
  CONSTRAINT rejection_names_no_bot
    CHECK (outcome <> 'rejected' OR outcome_bot_instance_id IS NULL),
  CONSTRAINT only_a_derivation_can_be_approved
    CHECK (outcome <> 'approved' OR stage = 'derive')
) STRICT;

DROP TABLE proposals;
ALTER TABLE proposals_new RENAME TO proposals;

INSERT INTO proposals
  SELECT id, stage, account_label, pair, entry_point, strategy_type, actor, model,
         prompt_version, data_fetched_at, inputs_json, reasoning_json, created_at,
         outcome, outcome_bot_instance_id, outcome_actor, outcome_at, outcome_note
    FROM proposals_backup;

DROP TABLE proposals_backup;

CREATE INDEX idx_proposals_created ON proposals (created_at);
CREATE INDEX idx_proposals_account_created ON proposals (account_label, created_at);
CREATE INDEX idx_proposals_unresolved ON proposals (stage, created_at) WHERE outcome IS NULL;
CREATE INDEX idx_proposals_outcome_bot
  ON proposals (outcome_bot_instance_id)
  WHERE outcome_bot_instance_id IS NOT NULL;
