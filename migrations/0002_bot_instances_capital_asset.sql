-- Migration 0002: record which asset a bot instance's capital is denominated in.
--
-- Step 5 (capital ledger, section 8.5) needs this and cannot work without it.
--
-- `capital_ledger` is keyed by (account_label, asset) -- the UNIQUE constraint
-- migration 0001 added specifically so this step could address a row. But
-- `bot_instances` recorded only `account_label`, so closing or resizing a bot
-- had no way to find the ledger row its capital came from. The alternative was
-- to make the caller re-supply the asset on every close and resize, where
-- passing a different asset than creation used would move capital between
-- ledger rows silently and nothing would detect it.
--
-- Not derivable from `pair`: the quote asset of BTCUSDT is USDT and of BTCUSDC
-- is USDC, and reading it off the symbol string means reimplementing the
-- exchange's own symbol table in SQL. The bot's funding asset is a fact about
-- the allocation, not about the market it trades, so it is stored as one.
--
-- A separate migration rather than an edit to 0001, because 0001 has already
-- been applied to the real testnet database (step 4.1). `applyD1Migrations`
-- records what it has run, so an edited 0001 would never re-run there.
--
-- The DEFAULT exists only because SQLite requires one to add a NOT NULL column.
-- No code relies on it: /src/db has no `.withDefault()` and every column is
-- required at insert time, so there is no path that omits this and silently
-- gets 'USDT'. It applies to zero existing rows -- nothing has ever written to
-- this table outside tests.
ALTER TABLE bot_instances ADD COLUMN capital_asset TEXT NOT NULL DEFAULT 'USDT';

CREATE INDEX idx_bot_instances_account_asset ON bot_instances (account_label, capital_asset);
