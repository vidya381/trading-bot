-- Migration 0008: the section 21.3 fixed watchlist.
--
-- Spec section 21.3 names two candidate sources for the general entry point of
-- the (still unbuilt) research pipeline. This table is the FIRST of them, and
-- only the storage for it:
--
--   1. A fixed watchlist. "A small set of 5-10 coins, chosen deliberately by
--      the operators. Deliberately small: it bounds cost (each candidate costs
--      candle fetches, news fetches, and two LLM calls) and it keeps attention
--      focused. Expandable later by an explicit decision to expand it. This is
--      not, and must not become, an unbounded market-wide scan."
--
--   2. A live trending pull. NOT THIS TABLE, and see the section below.
--
-- Nothing else from section 21 exists yet: no pipeline, no prompt, no endpoint,
-- no proposal record, no model call. Section 21's own status banner ("PLANNED,
-- NOT YET BUILT") still holds for every part of it except the list of pairs.
--
-- ---------------------------------------------------------------------------
-- THE TRENDING SOURCE MUST NEVER WRITE HERE
-- ---------------------------------------------------------------------------
-- 21.3 keeps the two sources structurally separate, and the reason is not
-- tidiness. The trending pull exists because "it is the only way the system can
-- ever surface something the operators did not already think to look for"; the
-- watchlist exists because someone deliberately chose each entry and can be
-- asked why. A trending pull that wrote rows here would destroy both properties
-- at once -- the watchlist would stop being a deliberate list, and 21.5's
-- source-transparency requirement ("the real source the candidate came from --
-- which watchlist entry, or which trending pull, and when") would have no way
-- left to tell a chosen candidate from a popular one. 21.3's hype hazard is
-- precisely about not letting attention masquerade as evidence.
--
-- So: this table has exactly one writer, `/src/research/watchlist.ts`, whose
-- entry points both require a human `actor`, and the trending pull -- when it
-- is built -- gets its own path to the pipeline and never touches this table.
-- The cap below makes the merge unattractive as well as forbidden: a trending
-- pull emptying itself into a 10-row table would fail on the eleventh coin.
--
-- ---------------------------------------------------------------------------
-- WHY account_label, WHEN THE SPEC SKETCH SAYS ONLY (id, pair, ...)
-- ---------------------------------------------------------------------------
-- Because "validate the pair against `listTradablePairs`" has no meaning
-- without it. That call is per-account: `listAccountSymbols` resolves the
-- account's registered exchange (`accounts.exchange`, migration 0006), builds
-- that venue's client, and asks it. The two venues do not even spell a pair the
-- same way -- Gemini's BTC/USD is `BTCUSD`, Binance's is `BTCUSDT` -- so a bare
-- `pair` column carries a string that cannot be checked against anything, which
-- is exactly the "store it to fix later" this table is forbidden from doing.
--
-- It also matches every other operational table here: `bot_instances`,
-- `capital_ledger`, `balance_snapshots`, `manual_adjustments` and
-- `circuit_breakers` are all account-scoped. And 21.5's deterministic parameter
-- validation ends in "the capital-availability check against the real capital
-- ledger", which is account-scoped too, so the pipeline needs this column
-- regardless of what the watchlist did.
--
-- The FOREIGN KEY is the first one pointing at `accounts`. It is what makes the
-- exchange derivable: given a row, there is exactly one registered venue to
-- validate its pair against, and an unregistered account cannot get a row at
-- all rather than getting one nothing can check.
--
-- ---------------------------------------------------------------------------
-- REMOVAL IS A soft DELETE, BECAUSE THE ACCESS LAYER HAS NO HARD ONE
-- ---------------------------------------------------------------------------
-- `Repository` (see the header of /src/db/table.ts) offers no `delete` method
-- at all, deliberately, and `no-raw-d1.test.ts` fails the build if any file
-- outside /src/db reaches past it. So "remove a pair from the watchlist" could
-- not have been built as a row deletion without either widening the access
-- layer or routing around it -- and step 26 already established the shape for
-- this: `bot_instances.archived` is "explicitly not a delete, and structurally
-- so rather than by intention".
--
-- `removed_at`/`removed_by` are that, one table over. An entry that was on the
-- list in March and is not on it now is a fact worth keeping: it is the only
-- record that someone considered the coin and then changed their mind, which is
-- the same reason 21.5 requires logging the proposals nobody acted on.
--
-- The pair goes with it. `removed_by` without `removed_at` (or the reverse) is
-- a half-recorded removal, so the CHECK requires both or neither -- the same
-- shape as `halt_requires_reason` in 0001 and `tripped_requires_reason` in
-- 0003.
--
-- ---------------------------------------------------------------------------
-- WHAT THE CAP IS, AND WHERE IT IS NOT
-- ---------------------------------------------------------------------------
-- The 10-entry cap lives in `/src/research/watchlist.ts` as
-- `WATCHLIST_MAX_ENTRIES`, checked against a COUNT of active rows before an
-- insert. It is deliberately NOT also a database trigger, and that is a real
-- decision rather than an omission:
--
--   * This schema has no triggers anywhere. Adding the first one for a bound
--     that is a product decision (21.3's "5-10 coins", "expandable later by an
--     explicit decision") rather than a data-integrity invariant would put the
--     number in two places, and 21.5 is explicit about what happens then --
--     "a second implementation of a risk check drifts from the first, and the
--     copy that drifts is the one nobody is watching".
--   * Widening the list is meant to be a one-line change plus a test, not a
--     table rebuild. SQLite cannot ALTER a trigger in place.
--
-- The consequence is stated rather than hidden: while editing is done by hand
-- with `wrangler d1 execute` (which is the plan for now), the cap, the
-- tradability check and the audit entry are ALL bypassed, because a raw INSERT
-- runs none of the code that enforces them. The one guarantee that does survive
-- the manual path is the unique index below.
--
-- ---------------------------------------------------------------------------
-- THE UNIQUE INDEX IS PARTIAL, AND THAT IS WHY IT CAN EXIST AT ALL
-- ---------------------------------------------------------------------------
-- One active entry per (account, pair): a duplicate is not a second opinion,
-- it is one coin costing two pipeline runs. A plain UNIQUE would also forbid
-- re-adding a pair that was removed last month, which is an ordinary thing to
-- want. `WHERE removed_at IS NULL` scopes the constraint to the live list,
-- following the partial-index convention 0001 and 0003 already use
-- (`idx_manual_adjustments_unreconciled`, `idx_circuit_breakers_tripped`).

CREATE TABLE watchlist (
  id            TEXT    NOT NULL PRIMARY KEY,

  -- Which registered account's venue this pair is tradable on, and therefore
  -- which client validates it. See the header.
  account_label TEXT    NOT NULL REFERENCES accounts (account_label),

  -- The exchange's own symbol, exactly as `listTradablePairs` reports it.
  -- Stored verbatim and never normalised: the two venues disagree on case and
  -- on quote-asset spelling, and a normalised copy would be a string no
  -- exchange call could use.
  pair          TEXT    NOT NULL,

  -- Why this coin is on the list. NOT NULL for the reason `manual_adjustments`
  -- and the circuit-breaker reset note are: it is the only record of the
  -- reasoning, and 21.3's "chosen deliberately by the operators" is not a
  -- property a list of bare symbols can demonstrate.
  note          TEXT    NOT NULL,

  -- An authenticated email, per section 11. The writer refuses the automated
  -- actors for the same reason the circuit-breaker reset does.
  added_by      TEXT    NOT NULL,
  added_at      INTEGER NOT NULL,

  -- Both NULL while the entry is on the live list. See the header on soft
  -- deletion, and the CHECK below on why they move together.
  removed_by    TEXT,
  removed_at    INTEGER,

  CONSTRAINT removal_is_recorded_whole
    CHECK ((removed_at IS NULL AND removed_by IS NULL)
        OR (removed_at IS NOT NULL AND removed_by IS NOT NULL))
) STRICT;

-- One live entry per account and pair. Partial, so a removed pair can be added
-- again; see the header.
CREATE UNIQUE INDEX idx_watchlist_active_pair
  ON watchlist (account_label, pair)
  WHERE removed_at IS NULL;

-- The read path's only query: the live list, oldest first. Partial for the same
-- reason `idx_manual_adjustments_unreconciled` is -- the interesting set is the
-- small one, and it is the only one anything reads.
CREATE INDEX idx_watchlist_active
  ON watchlist (added_at)
  WHERE removed_at IS NULL;
