-- Migration 0005: the global kill switch (spec section 7.4).
--
-- Section 7.4 describes "a single dashboard control that halts every bot, on
-- every account, immediately ... a distinct, one-click action separate from
-- per-account circuit breakers, for use in a genuine emergency." Migration
-- 0003 built the per-account breaker (section 7.3); this is its global sibling.
--
-- ---------------------------------------------------------------------------
-- WHY A SEPARATE TABLE, NOT A ROW IN circuit_breakers
-- ---------------------------------------------------------------------------
-- The kill switch needs "its own record of globally tripped, separate from any
-- single account's breaker" (the build brief) so that the two latches are
-- genuinely independent: resetting one account's breaker must not clear the
-- global switch, and resetting the global switch must not clear an account's
-- breaker. A sentinel row in circuit_breakers keyed on a reserved account_label
-- would collide with the account namespace and quietly change what
-- assertAccountArmed means. A dedicated table keeps the boundary sharp.
--
-- ---------------------------------------------------------------------------
-- SINGLE ROW, MUTABLE, ABSENCE MEANS ARMED
-- ---------------------------------------------------------------------------
-- Global state is one thing, so this table holds at most one row, pinned by
-- CHECK (id = 1). Like circuit_breakers, the row's absence is equivalent to
-- `armed` and is treated as such, so nothing has to seed it. The history of
-- trips and resets lives in audit_log under `kill_switch.*`, and every trip
-- also writes a row to `alerts`.
--
-- ---------------------------------------------------------------------------
-- WHY IN D1, AND WHY A LATCH
-- ---------------------------------------------------------------------------
-- The same two arguments as the account breaker (migration 0003). A latch,
-- because halting the bots that exist at the instant of the trip is not a kill
-- switch -- the next bot created anywhere would start trading straight back
-- into the emergency. D1 rather than KV, because BotInstance.create and
-- .resume read this on the create/resume path and an eventually-consistent
-- read that still says "armed" seconds after a global stop is a hole in the
-- one control that exists for a genuine emergency. Only an explicit human reset
-- (`resetGlobalKillSwitch`, which refuses an automated actor) re-arms it.

CREATE TABLE global_kill_switch (
  -- Pinned to a single row. Global state is not per-anything.
  id            INTEGER NOT NULL PRIMARY KEY CHECK (id = 1),

  state         TEXT    NOT NULL CHECK (state IN ('armed', 'tripped')),

  -- Why it was pulled, in prose, for whoever decides it is safe to re-arm.
  -- NULL only while armed.
  reason        TEXT,
  tripped_at    INTEGER,
  -- An authenticated email. Section 7.4 is a human dashboard control, so unlike
  -- the account breaker there is no automated trigger; a trip always names a
  -- person. Never a made-up value: this is who pulled it.
  tripped_by    TEXT,

  -- Retained after a reset rather than nulled, so a re-armed switch still shows
  -- it was pulled once and by whom it was cleared.
  reset_at      INTEGER,
  reset_by      TEXT,

  updated_at    INTEGER NOT NULL,

  -- The counterpart of circuit_breakers' tripped_requires_reason, and
  -- one-directional in the same way: a tripped row must explain itself, a
  -- re-armed row may keep the last explanation.
  CONSTRAINT tripped_requires_reason
    CHECK (state <> 'tripped' OR (reason IS NOT NULL AND tripped_at IS NOT NULL AND tripped_by IS NOT NULL))
) STRICT;
