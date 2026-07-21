-- Migration 0001: initial schema (spec section 8.2).
--
-- The eight cross-bot reporting tables. Durable Object storage remains the
-- source of truth per bot instance (section 8.1); this database is the
-- mirrored, queryable copy that reporting, reconciliation and the dashboard
-- read.
--
-- ---------------------------------------------------------------------------
-- MONEY COLUMNS
-- ---------------------------------------------------------------------------
-- Every monetary column is INTEGER, holding a bigint scaled by 10^8 (step 2
-- decision 1). Never TEXT, never REAL.
--
--   Write: bind the decimal string from `toStorageString(value)`. D1's .bind()
--          rejects a bigint outright ("Type 'bigint' not supported"), and
--          SQLite's INTEGER affinity converts the string to a true integer.
--   Read:  SELECT CAST(col AS TEXT), then `fromStorageString`. A direct read
--          returns a JS `number` and silently loses precision above 2^53.
--
-- Both rules are enforced in code by /src/db, which is the only module allowed
-- to build SQL against these tables.
--
-- ---------------------------------------------------------------------------
-- WHY EVERY TABLE IS STRICT
-- ---------------------------------------------------------------------------
-- Verified against D1's SQLite in the Workers runtime:
--
--   Non-strict INTEGER column, bind "not-a-number"       -> stored, typeof = 'text'
--   STRICT     INTEGER column, bind "not-a-number"       -> rejected, SQLITE_CONSTRAINT_DATATYPE
--   STRICT     INTEGER column, bind "1.5"                -> rejected, "cannot store REAL value"
--   STRICT     INTEGER column, bind "100000000000000001" -> stored, typeof = 'integer'
--
-- Without STRICT, a money column that somehow received a formatted decimal
-- ("1.5") or a raw string accepts it silently, and it surfaces much later as a
-- wrong balance. STRICT makes that write fail at the database, a layer beneath
-- the type system and therefore unaffected by any bug in it.
--
-- ---------------------------------------------------------------------------
-- TIMESTAMPS
-- ---------------------------------------------------------------------------
-- All *_at columns are INTEGER Unix epoch MILLISECONDS, matching the
-- `now: number` parameter every module in /src/shared already takes.
-- Milliseconds stay far inside 2^53, so unlike money they are safe to read
-- directly.
--
-- ---------------------------------------------------------------------------
-- DELETION
-- ---------------------------------------------------------------------------
-- Section 8.7 retains all data indefinitely. Foreign keys are enforced by
-- default in D1 (PRAGMA foreign_keys = 1, verified), and every one here uses
-- the default ON DELETE RESTRICT: deleting a bot instance that has orders
-- fails loudly rather than cascading history away.

-- ---------------------------------------------------------------------------
-- bot_instances
-- ---------------------------------------------------------------------------
CREATE TABLE bot_instances (
  -- Step 2 decision 6: clientOrderId is `v1-{botInstanceId}-{sequence}` and
  -- must be parseable back to a bot, so ids are short slugs matching
  -- /^[a-z0-9][a-z0-9_-]{0,19}$/ -- NOT UUIDs. SQLite has no regex, but GLOB
  -- plus a length bound rejects a UUID (36 chars), which is the specific
  -- mistake step 2's open question 4 warned step 6 about.
  id                   TEXT    NOT NULL PRIMARY KEY
                               CHECK (id GLOB '[a-z0-9]*' AND length(id) BETWEEN 1 AND 20),
  account_label        TEXT    NOT NULL,
  exchange             TEXT    NOT NULL,
  pair                 TEXT    NOT NULL,
  strategy_type        TEXT    NOT NULL CHECK (strategy_type IN ('grid', 'dca')),
  strategy_params_json TEXT    NOT NULL,

  -- Money, scale 8. A percentage is stored as the percentage itself, not a
  -- rate: 2.5% is 250000000. `percentToRate` in money.ts converts.
  stop_loss_pct        INTEGER NOT NULL CHECK (stop_loss_pct > 0),
  -- Nullable: section 6.2 makes take-profit optional for grid, section 6.3
  -- makes it mandatory for DCA since it defines the cycle's exit. The
  -- constraint below is that rule, enforced rather than documented.
  take_profit_pct      INTEGER CHECK (take_profit_pct IS NULL OR take_profit_pct > 0),
  allocated_capital    INTEGER NOT NULL CHECK (allocated_capital > 0),

  status               TEXT    NOT NULL
                               CHECK (status IN ('created', 'running', 'halted', 'stopped')),

  -- Section 7.2 step 3: a halt marks the instance halted "with a recorded
  -- reason". Not in section 8.2's column list; without it a halted bot cannot
  -- explain itself to the human review section 7.2 requires before any resume.
  halt_reason          TEXT,
  halted_at            INTEGER,

  schema_version       INTEGER NOT NULL DEFAULT 1 CHECK (schema_version >= 1),
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL,

  CONSTRAINT dca_requires_take_profit
    CHECK (strategy_type <> 'dca' OR take_profit_pct IS NOT NULL),

  -- Deliberately one-directional. A halted row must carry a reason; a row that
  -- is no longer halted MAY keep the last one. Requiring it to be cleared on
  -- resume would force step 6 to null two columns on every restart in order to
  -- discard information that is occasionally worth having.
  CONSTRAINT halt_requires_reason
    CHECK (status <> 'halted' OR (halt_reason IS NOT NULL AND halted_at IS NOT NULL))
) STRICT;

CREATE INDEX idx_bot_instances_account_status ON bot_instances (account_label, status);
CREATE INDEX idx_bot_instances_created_at ON bot_instances (created_at);

-- ---------------------------------------------------------------------------
-- capital_ledger
-- ---------------------------------------------------------------------------
-- Section 8.5: before creating a bot, check
--   total_balance - total_allocated >= requested_capital
-- and update total_allocated when bots are created, closed, or resized.
--
-- Named "ledger" but it holds current state -- one mutable row per (account,
-- asset), not an append-only entry log. That is what section 8.5's "update"
-- wording describes. The history of allocation changes lives in audit_log.
--
-- `asset` is not in section 8.2. Added because balance_snapshots is per-asset
-- and this table was not, which left the reporting currency as an unrecorded
-- system-wide assumption. The UNIQUE constraint is what makes the row
-- addressable for step 5's read-check-update.
CREATE TABLE capital_ledger (
  id              TEXT    NOT NULL PRIMARY KEY,
  account_label   TEXT    NOT NULL,
  asset           TEXT    NOT NULL,
  total_balance   INTEGER NOT NULL CHECK (total_balance >= 0),
  total_allocated INTEGER NOT NULL CHECK (total_allocated >= 0),
  updated_at      INTEGER NOT NULL,

  CONSTRAINT capital_ledger_account_asset UNIQUE (account_label, asset)
) STRICT;

-- Note there is deliberately NO `CHECK (total_allocated <= total_balance)`.
-- A balance can legitimately fall below what is already allocated: a losing
-- position, or funds moved manually on the exchange. An over-allocated account
-- is a real state reconciliation must be able to record and alert on, not one
-- the database should refuse to represent. The check that matters guards
-- *new* allocations, and belongs in step 5 where it can raise a useful error.

-- ---------------------------------------------------------------------------
-- orders
-- ---------------------------------------------------------------------------
CREATE TABLE orders (
  id                TEXT    NOT NULL PRIMARY KEY,
  bot_instance_id   TEXT    NOT NULL REFERENCES bot_instances (id),

  -- Section 5.1: deterministic, generated by us, never reused. Binance rejects
  -- a repeat; UNIQUE here is the second, local layer of that protection.
  client_order_id   TEXT    NOT NULL UNIQUE,
  -- Nullable: an order recorded as "attempting to place" (section 5.1) has no
  -- exchange id yet, and never gets one if the placement failed.
  exchange_order_id TEXT,

  side              TEXT    NOT NULL CHECK (side IN ('buy', 'sell')),

  -- Money, scale 8. No market orders in v1 (section 4.5), so a price is always
  -- present and positive.
  price             INTEGER NOT NULL CHECK (price > 0),
  quantity          INTEGER NOT NULL CHECK (quantity > 0),
  filled_quantity   INTEGER NOT NULL DEFAULT 0 CHECK (filled_quantity >= 0),

  -- Step 2 decision 5 added `rejected` and `expired` to section 5.3's four
  -- states, because getOrderStatus and reconciliation can both observe them
  -- and an unmapped state would escalate to a halt under section 7.5.
  status            TEXT    NOT NULL
                            CHECK (status IN ('pending', 'partially_filled', 'filled',
                                              'cancelled', 'rejected', 'expired')),

  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,

  -- The database-level counterpart of order-state.ts's `overfill` error code.
  CONSTRAINT no_overfill CHECK (filled_quantity <= quantity),

  -- Redundant on its own -- `id` is already the primary key -- and exists
  -- solely so `trades` can point a composite foreign key at (id,
  -- bot_instance_id). SQLite requires a UNIQUE constraint on the exact parent
  -- column list. See the note on trades.bot_instance_id.
  CONSTRAINT orders_id_bot_unique UNIQUE (id, bot_instance_id)
) STRICT;

CREATE INDEX idx_orders_bot_created ON orders (bot_instance_id, created_at);
CREATE INDEX idx_orders_exchange_order_id ON orders (exchange_order_id);
-- Partial: reconciliation (section 9) and the halt path (section 7.2) both ask
-- only for orders that are still live, which is a shrinking slice of a table
-- that grows forever under section 8.7's retain-everything rule.
CREATE INDEX idx_orders_open ON orders (bot_instance_id, status)
  WHERE status IN ('pending', 'partially_filled');

-- ---------------------------------------------------------------------------
-- trades
-- ---------------------------------------------------------------------------
CREATE TABLE trades (
  id                   TEXT    NOT NULL PRIMARY KEY,
  order_id             TEXT    NOT NULL,

  -- Denormalized from orders. Per-bot PnL and reconciliation both scan by bot
  -- and time; without this every such query joins a table that, per section
  -- 8.7, is never pruned.
  --
  -- Denormalizing normally means the copy can disagree with the original. Here
  -- it cannot: the composite foreign key below points at orders (id,
  -- bot_instance_id) together, so a trade that names a different bot than its
  -- own order is rejected. The redundancy buys the query shape without buying
  -- the usual class of bug.
  bot_instance_id      TEXT    NOT NULL,

  -- The exchange's own `tradeId` for this fill, stringified (step 3: it
  -- arrives as a JSON number, and stringifying keeps identity comparisons off
  -- float precision). UNIQUE with order_id so a redelivered fill message
  -- (section 5.1) fails to insert instead of double-counting realized PnL --
  -- the database-level counterpart of order-state.ts's `duplicate_fill`.
  exchange_trade_id    TEXT    NOT NULL,

  -- Money, scale 8.
  price                INTEGER NOT NULL CHECK (price > 0),
  quantity             INTEGER NOT NULL CHECK (quantity > 0),

  -- Section 5.5: the fee exactly as the exchange charged it, in whatever asset
  -- it charged. Never assume it is the quote currency.
  fee_amount           INTEGER NOT NULL CHECK (fee_amount >= 0),
  fee_asset            TEXT    NOT NULL,

  -- Section 5.5's conversion into the reporting currency, recorded at fill
  -- time. Not in section 8.2. Stored rather than recomputed because the price
  -- at the instant of the fill is not recoverable afterwards, so a later
  -- recomputation would quietly use a different rate than the PnL figure the
  -- dashboard already showed. `fee_conversion_rate` is the price used, which
  -- is what makes a disputed PnL number explainable.
  --
  -- All three are NULL together when conversion failed, matching step 2
  -- decision 9's refusal to report a net PnL from a partial fee total.
  fee_reporting_amount INTEGER CHECK (fee_reporting_amount IS NULL OR fee_reporting_amount >= 0),
  fee_reporting_asset  TEXT,
  fee_conversion_rate  INTEGER CHECK (fee_conversion_rate IS NULL OR fee_conversion_rate > 0),

  -- Step 3: a fill object carries no time of its own. This is inherited from
  -- the parent order's transactTime, so every fill in one response shares it.
  executed_at          INTEGER NOT NULL,

  CONSTRAINT trades_exchange_id_unique UNIQUE (order_id, exchange_trade_id),

  CONSTRAINT fee_conversion_all_or_nothing CHECK (
    (fee_reporting_amount IS NULL) = (fee_reporting_asset IS NULL)
    AND (fee_reporting_amount IS NULL) = (fee_conversion_rate IS NULL)
  ),

  -- The pair together, so the denormalized bot cannot drift from the order's.
  FOREIGN KEY (order_id, bot_instance_id) REFERENCES orders (id, bot_instance_id),
  -- Kept as well as the composite, though transitively implied by it, so that
  -- a trade's bot reference stands on its own for anything reading trades
  -- without touching orders.
  FOREIGN KEY (bot_instance_id) REFERENCES bot_instances (id)
) STRICT;

CREATE INDEX idx_trades_order ON trades (order_id);
CREATE INDEX idx_trades_bot_executed ON trades (bot_instance_id, executed_at);

-- ---------------------------------------------------------------------------
-- balance_snapshots
-- ---------------------------------------------------------------------------
CREATE TABLE balance_snapshots (
  id                          TEXT    NOT NULL PRIMARY KEY,

  -- Not in section 8.2. One reconciliation pass (section 9) writes one row per
  -- asset; without a shared id the dashboard sees a flat stream of per-asset
  -- rows and cannot say "this run found X".
  reconciliation_run_id       TEXT    NOT NULL,

  account_label               TEXT    NOT NULL,
  asset                       TEXT    NOT NULL,

  -- Money, scale 8. `discrepancy` is redundant with the other two by
  -- subtraction, but section 8.2 lists it, and storing it records what the run
  -- actually concluded after subtracting unreconciled manual_adjustments
  -- (section 8.6) -- which is NOT a plain difference of these two columns.
  exchange_reported_balance   INTEGER NOT NULL,
  internal_calculated_balance INTEGER NOT NULL,
  discrepancy                 INTEGER NOT NULL,

  -- Section 9's three drift classes. NULL means the run found no drift to
  -- classify: section 9 names only the three drift cases and has no word for a
  -- clean result, so this stays nullable rather than inventing one. Step 7
  -- owns the semantics; see the decision log's open questions.
  classification              TEXT    CHECK (classification IS NULL
                                             OR classification IN ('minor', 'meaningful', 'severe')),

  checked_at                  INTEGER NOT NULL
) STRICT;

CREATE INDEX idx_balance_snapshots_account_checked ON balance_snapshots (account_label, checked_at);
CREATE INDEX idx_balance_snapshots_run ON balance_snapshots (reconciliation_run_id);

-- ---------------------------------------------------------------------------
-- manual_adjustments
-- ---------------------------------------------------------------------------
CREATE TABLE manual_adjustments (
  id            TEXT    NOT NULL PRIMARY KEY,
  account_label TEXT    NOT NULL,
  asset         TEXT    NOT NULL,

  -- Money, scale 8. Signed and deliberately unconstrained: a deposit is
  -- positive, a withdrawal negative.
  amount        INTEGER NOT NULL,

  note          TEXT    NOT NULL,

  -- Not in section 8.2, and its absence is a spec bug rather than a
  -- preference. Section 8.6 says reconciliation subtracts *unreconciled*
  -- logged adjustments. With no way to mark one consumed, every run subtracts
  -- every adjustment ever logged, so the discrepancy maths is wrong from the
  -- second run onward and drifts further with each entry.
  reconciled_at INTEGER,

  created_at    INTEGER NOT NULL
) STRICT;

-- Partial index matching reconciliation's only query against this table: the
-- unreconciled entries for one account and asset.
CREATE INDEX idx_manual_adjustments_unreconciled
  ON manual_adjustments (account_label, asset, created_at)
  WHERE reconciled_at IS NULL;
CREATE INDEX idx_manual_adjustments_created ON manual_adjustments (created_at);

-- ---------------------------------------------------------------------------
-- audit_log
-- ---------------------------------------------------------------------------
CREATE TABLE audit_log (
  id                     TEXT    NOT NULL PRIMARY KEY,

  -- Section 11: the authenticated email from the Cloudflare Access header.
  -- Also carries non-human actors -- 'system' for automated halts, 'ci' for
  -- the section 16 deploy entries.
  actor                  TEXT    NOT NULL,
  action                 TEXT    NOT NULL,

  -- Nullable: the section 7.4 global kill switch and section 16's deploy
  -- entries target no single bot.
  target_bot_instance_id TEXT    REFERENCES bot_instances (id),

  details_json           TEXT,
  created_at             INTEGER NOT NULL
) STRICT;

CREATE INDEX idx_audit_log_created ON audit_log (created_at);
CREATE INDEX idx_audit_log_target ON audit_log (target_bot_instance_id, created_at);
CREATE INDEX idx_audit_log_actor ON audit_log (actor, created_at);

-- ---------------------------------------------------------------------------
-- alerts
-- ---------------------------------------------------------------------------
-- Section 10: every alert is written here regardless of notification
-- throttling, so the dashboard always shows a complete history. Only the
-- outbound Discord/Telegram ping is throttled, via a KV cooldown key.
CREATE TABLE alerts (
  id              TEXT    NOT NULL PRIMARY KEY,

  severity        TEXT    NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),

  -- Section 10 requires the two kinds of alert to be "visually
  -- distinguishable on the dashboard", but section 8.2 gives only free-text
  -- `source` to tell them apart. An explicit column makes that a filter rather
  -- than a guess.
  category        TEXT    NOT NULL CHECK (category IN ('trading', 'system')),

  -- Section 10 keys the KV notification cooldown on (alert type + bot
  -- instance); neither existed as a column. Deliberately NOT constrained to a
  -- fixed list -- alert types will keep being added, and in SQLite a CHECK
  -- cannot be altered without rebuilding the table.
  alert_type      TEXT    NOT NULL,
  -- Nullable: an account-wide or system alert belongs to no single bot.
  bot_instance_id TEXT    REFERENCES bot_instances (id),

  -- Which component raised it, e.g. 'reconciliation', 'order-execution'.
  source          TEXT    NOT NULL,
  message         TEXT    NOT NULL,

  resolved        INTEGER NOT NULL DEFAULT 0 CHECK (resolved IN (0, 1)),
  created_at      INTEGER NOT NULL
) STRICT;

CREATE INDEX idx_alerts_created ON alerts (created_at);
CREATE INDEX idx_alerts_bot_created ON alerts (bot_instance_id, created_at);
-- Partial: the go-live checklist (section 17) asks for unresolved critical
-- alerts, and the dashboard leads with what is still open.
CREATE INDEX idx_alerts_unresolved ON alerts (severity, created_at) WHERE resolved = 0;
