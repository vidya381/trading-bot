-- Migration 0003: the account-wide circuit breaker (spec sections 7.3 and 9).
--
-- Step 7 needs this table to exist. Section 9's severe-drift tier says "trigger
-- the account-wide circuit breaker, halt everything on that account, alert
-- immediately", and until now that control existed only as a paragraph in
-- section 7.3. Without somewhere to record the tripped state, "trip the
-- breaker" could only ever mean "halt the bots that exist right now" -- which
-- is not a breaker, because the next bot created on that account would start
-- trading into the same unexplained state that caused the trip.
--
-- ---------------------------------------------------------------------------
-- WHY A LATCH, AND WHY IN D1
-- ---------------------------------------------------------------------------
-- The row is what makes this a control rather than a one-off action. While an
-- account is `tripped`:
--
--   - no bot on it can be created (BotInstance.create checks this);
--   - no halted bot on it can be resumed (BotInstance.resume checks this);
--   - reconciliation keeps sweeping for any bot that is not yet halted.
--
-- Only an explicit human reset re-arms it. `resetAccountCircuitBreaker`
-- refuses an automated actor for the same reason
-- `seedPlaceholderTotalBalance` does (step 5, decision 6): a breaker a cron
-- can reset is not a breaker.
--
-- D1 rather than KV: KV is eventually consistent, and a create-blocking check
-- that can read a stale "armed" seconds after a trip is a check with a hole in
-- it. KV's declared role in section 8.3 is alert-notification cooldowns, where
-- staleness costs a duplicate ping. Here it would cost a bot trading on an
-- account under suspected key compromise.
--
-- D1 rather than a Durable Object: a DO would serialise trips properly, but
-- trips are driven by one cron per account and the write is idempotent, so
-- there is no contention to serialise. This follows step 5's decision A -- the
-- same argument, for the same reason.
--
-- ---------------------------------------------------------------------------
-- ONE ROW PER ACCOUNT, MUTABLE
-- ---------------------------------------------------------------------------
-- Like `capital_ledger`, this is current state, not an append-only log. The
-- history of trips and resets lives in `audit_log` under the
-- `circuit_breaker.*` actions, and every trip also writes a row to `alerts`.
-- A row's absence means the account has never been tripped, which is
-- equivalent to `armed` and is treated as such.

CREATE TABLE circuit_breakers (
  account_label TEXT    NOT NULL PRIMARY KEY,

  state         TEXT    NOT NULL CHECK (state IN ('armed', 'tripped')),

  -- Why it tripped, in prose, for the human who has to decide whether to
  -- reset. NULL only while armed.
  reason        TEXT,
  -- Which reconciliation run concluded it, so the balance_snapshots rows and
  -- alerts for that run can be found from here.
  run_id        TEXT,
  tripped_at    INTEGER,
  -- 'reconciliation' for a section 9 trip, or an authenticated email for a
  -- manual one. Never a made-up value: this is who to ask.
  tripped_by    TEXT,

  -- Retained after a reset rather than nulled, so a re-armed account still
  -- shows that it was tripped once and by whom it was cleared.
  reset_at      INTEGER,
  reset_by      TEXT,

  updated_at    INTEGER NOT NULL,

  -- The counterpart of bot_instances' halt_requires_reason, and deliberately
  -- one-directional in the same way: a tripped row must explain itself, a
  -- re-armed row may keep the last explanation.
  CONSTRAINT tripped_requires_reason
    CHECK (state <> 'tripped' OR (reason IS NOT NULL AND tripped_at IS NOT NULL AND tripped_by IS NOT NULL))
) STRICT;

-- The dashboard's "is anything latched right now" query, and reconciliation's
-- sweep. Partial, because the interesting set is the small one.
CREATE INDEX idx_circuit_breakers_tripped ON circuit_breakers (account_label)
  WHERE state = 'tripped';
