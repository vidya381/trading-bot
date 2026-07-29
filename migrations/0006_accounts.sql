-- Migration 0006: the account registry (spec sections 4.4, 16).
--
-- The piece deferred from both exchange-integration sessions (step 3.4's
-- decision 0: "build Gemini fully behind the interface; DEFER the
-- Binance-vs-Gemini dispatch to its own step"). Until now "which exchange does
-- this account belong to" was a free-typed string on every `bot_instances` row
-- (`exchange TEXT NOT NULL`, no CHECK), supplied by the create-bot request and
-- trusted. This table makes the account -> exchange mapping a registered,
-- validated fact, so bot creation can DERIVE the exchange from the account
-- rather than believing whatever the request typed, and so the dashboard has a
-- real list of accounts to offer.
--
-- ---------------------------------------------------------------------------
-- WHY A SEPARATE TABLE, NOT A COLUMN
-- ---------------------------------------------------------------------------
-- The exchange is a property of the ACCOUNT, not of each bot. Recording it per
-- bot (as `bot_instances.exchange` did) let two bots on the same account
-- disagree about which exchange the account is on -- a contradiction nothing
-- could detect. One row per account, `account_label` the primary key, makes the
-- fact single-valued: an account is on exactly one exchange. `bot_instances`
-- keeps its own `exchange` column (it is denormalised, convenient, and now
-- validated against this table at create time), but this table is authoritative.
--
-- ---------------------------------------------------------------------------
-- THE exchange ENUM, AND ADDING A THIRD LATER
-- ---------------------------------------------------------------------------
-- `exchange` is constrained to the two exchanges that exist today, exactly as
-- `bot_instances.strategy_type` is constrained to ('grid', 'dca'). The app-side
-- `ExchangeId` union in src/db/schema.ts is the single source of that set and
-- this CHECK is its shadow, so the two cannot drift.
--
-- Adding a third exchange later is deliberately a VALUE change, not a
-- restructuring: widen the `ExchangeId` union by one member and widen this CHECK
-- by one string in a follow-up migration. SQLite cannot ALTER a CHECK in place,
-- so that follow-up is a standard table-rebuild (new table, copy, drop, rename)
-- -- but it touches only this one small table and changes no other structure.
--
-- ---------------------------------------------------------------------------
-- CREDENTIAL MAPPING IS BY CONVENTION, NOT STORED PER ROW
-- ---------------------------------------------------------------------------
-- There is deliberately no `api_key_name`/`secret_ref` column. Which secrets an
-- account's client is built from is decided by convention: a 'binance' account
-- resolves through `resolveDefaultExchange`, which reads the fixed
-- BINANCE_API_KEY / BINANCE_API_SECRET secrets; a 'gemini' account resolves
-- through `resolveGeminiExchange`, which reads GEMINI_API_KEY / GEMINI_API_SECRET.
-- Those resolvers are the single home for secret -> client, and they read fixed
-- names. A per-row secret name stored here would be metadata NOTHING reads --
-- precisely the "looks wired but isn't" gap steps 3.2 and 3.4 warn against.
--
-- This holds while there is at most one account per exchange per environment,
-- which is the case today. The moment two accounts on the SAME exchange need
-- DIFFERENT keys, convention breaks (both would map to the one BINANCE_API_KEY).
-- The forward path is then a plain append-only `ALTER TABLE accounts ADD COLUMN
-- credential_ref TEXT` (the same shape as capital_asset in 0002 and notified_at
-- in 0004) PLUS teaching the resolvers to honour it -- built at the point a
-- reader for it exists, not before.
--
-- ---------------------------------------------------------------------------
-- REGISTRATION IS A MANUAL INSERT, LIKE capital_ledger SEEDING
-- ---------------------------------------------------------------------------
-- There is no POST /api/accounts endpoint. Registering a real account is a
-- rare, high-privilege human act done a handful of times, mirroring how
-- `capital_ledger.total_balance` is seeded by hand today
-- (`seedPlaceholderTotalBalance`, step 5 decision 6). See docs/d1-provisioning.md
-- for the exact INSERT.

CREATE TABLE accounts (
  -- The label bots and ledger rows already reference by `account_label`. Primary
  -- key, so it is unique and is the natural lookup for the registry.
  account_label TEXT    NOT NULL PRIMARY KEY,

  -- Which exchange this account trades on. The set mirrors ExchangeId in
  -- src/db/schema.ts; widen both together to add an exchange (see the header).
  exchange      TEXT    NOT NULL CHECK (exchange IN ('binance', 'gemini')),

  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
) STRICT;

-- Backfill from bots that already exist, so no pre-existing account is left
-- unregistered by this migration (step 11: "backfill + soft-enforce"). Each
-- distinct account_label already on a bot becomes a registered account carrying
-- that bot's exchange.
--
--   * WHERE exchange IN (...) skips any bot whose free-typed exchange was never
--     a recognised value, so a junk string cannot abort the whole migration on
--     the CHECK. Such an account is simply left unregistered and falls into the
--     create-time soft-fallback path, which is exactly what soft-enforce means.
--   * INSERT OR IGNORE tolerates the pathological case of one label carrying two
--     different exchanges across bots: the first wins and the migration still
--     completes rather than failing on the primary key.
--   * The timestamp is the migration instant, in the milliseconds-since-epoch
--     the rest of the schema uses (unixepoch() is seconds; * 1000 for ms).
INSERT OR IGNORE INTO accounts (account_label, exchange, created_at, updated_at)
SELECT account_label, exchange,
       CAST(unixepoch() AS INTEGER) * 1000,
       CAST(unixepoch() AS INTEGER) * 1000
FROM bot_instances
WHERE exchange IN ('binance', 'gemini')
GROUP BY account_label;
