-- Migration 0009: the permanent proposal record (spec 21.5 requirement 5).
--
-- "Every proposal generated is permanently logged with its full inputs, its
-- reasoning, and its outcome -- approved, rejected, or ignored. Including the
-- ones nobody acts on, because 'the system kept proposing things nobody wanted'
-- is one of the two most important signals this feature can produce, and it is
-- invisible if only approvals are recorded."
--
-- Every prior step of the section 21 arc (decision logs 30-44) recorded that
-- requirement 5 was "NOT satisfied, NOT partially satisfied and NOT begun", and
-- steps 42 and 44 each declined to invent a throwaway store on the grounds that
-- the real record was coming and would have a different shape, lifetime and
-- owner. This table is that record.
--
-- ---------------------------------------------------------------------------
-- WHY A DEDICATED TABLE AND NOT ROWS IN audit_log
-- ---------------------------------------------------------------------------
-- 21.5 names `audit_log` (section 8.2) as the practice this mirrors, and the
-- obvious reading is that a proposal should simply BE an `audit_log` row with a
-- fat `details_json`. That was traced through the real code rather than assumed,
-- and it does not work -- for four reasons, in descending weight.
--
--   1. A PROPOSAL HAS A LIFECYCLE; AN AUDIT ENTRY IS AN EVENT. The outcome is
--      knowable only LATER, when a human acts (or never does). Recording it
--      means UPDATING the record. Nothing in this system has ever updated
--      `audit_log` -- every one of its writers (`capital.ts`, `watchlist.ts`,
--      `circuit-breaker.ts`, `kill-switch.ts`, `reconcile.ts`,
--      `bot-instance.ts`, `placeholder-balance.ts`) only ever INSERTs, and that
--      append-only property is exactly what makes the log trustworthy. Adding an
--      outcome by rewriting a past entry would break it for every other reader.
--
--   2. `Repository` CANNOT FILTER ON A JSON COLUMN, BY DESIGN. See
--      /src/db/table.ts: a JSON filter throws `unsupported_filter`. `audit_log`
--      has no `account_label`, no `pair` and no `stage` column, so "every
--      proposal for this account", "every proposal on this pair" and "every
--      proposal nobody acted on" would all be unaskable questions -- and the
--      last one is the specific measurement 21.5 exists to make possible.
--
--   3. EVERY READ OF audit_log WOULD PAY FOR THE PAYLOAD. `Repository.findMany`
--      always selects the full generated column list; there is no projection.
--      A proposal's full inputs are large -- decision log 41 measured the Derive
--      prompt alone at 23,383 characters over a 1,440-candle window, and the
--      bundle carries those candles too -- so proposals in `details_json` would
--      mean `listReconciliationRuns` (the one endpoint that already queries
--      `audit_log`, by `action`) dragging hundreds of kilobytes per unrelated
--      read. Every other `details_json` in this system is a handful of scalars.
--
--   4. THE OUTCOME LINK NEEDS SOMETHING TO POINT AT. `POST /api/bots` now
--      accepts an optional `proposalId`. A foreign key into `audit_log` would
--      point at a table where any row of any action could be named, so
--      "proposalId" would be a claim rather than a reference. Here it is a real
--      FK into a table whose every row is a proposal.
--
-- So: a dedicated table for the RECORD, and an `audit_log` row for the EVENT,
-- written through the existing `db.auditLog` path in ONE `Database.batch`. That
-- is exactly the shape migration 0008 established for the watchlist -- "the row
-- and its audit entry go in ONE batch, so a watchlist entry with no record of
-- who added it is not a state this table can reach" -- and there is deliberately
-- no second audit mechanism here.
--
-- ---------------------------------------------------------------------------
-- TWO ROWS PER PIPELINE RUN, NOT ONE, AND THAT IS THE TRUTHFUL SHAPE
-- ---------------------------------------------------------------------------
-- `/assess` and `/derive` are two separate HTTP calls that each perform their
-- OWN fresh gather (decision log 42's decisive check 5: the same evidence id
-- resolved to 63775.31 and 63757.71 ten minutes apart). Their inputs are
-- therefore genuinely different data, and one row carrying "the" inputs would
-- have to pick one gather and silently discard the other.
--
-- `stage` distinguishes them. Each row is INDEPENDENTLY COMPLETE -- its own
-- bundle, its own prompt, its own model response -- so 21.5's "any bad outcome
-- can be traced back to its exact cause" is satisfied by either row alone.
--
-- ⚠ WHAT IS NOT LINKED, STATED RATHER THAN LEFT TO BE FOUND: a `derive` row does
-- NOT carry the id of the `assess` row it derives from, because nothing in the
-- request carries that link. `/derive` takes the assessment as resubmitted TEXT
-- (decision log 42), and an `assessProposalId` accepted from the caller would be
-- a client-asserted claim this system cannot verify -- the same class as
-- `envelope` and `duplicateKeyCheck`, which `assess-resubmit.ts` carries only
-- because refusing to carry them would mean inventing an audit fact. Nothing
-- needs the join today, so no unverifiable field is added for it. The
-- resubmitted assessment is stored verbatim on the derive row, so the two are
-- reconstructable by content.
--
-- ---------------------------------------------------------------------------
-- `outcome` IS NULLABLE, AND 'ignored' IS DELIBERATELY NOT A STORED VALUE
-- ---------------------------------------------------------------------------
-- 21.5 names three outcomes: approved, rejected, ignored. Only the first two are
-- DECISIONS a human makes and a system can witness. "Ignored" is an ABSENCE --
-- nobody ever came back to it -- and nothing observes a human failing to act.
--
-- Storing 'ignored' would require either a cron sweep that flips pending rows
-- after some deadline (inventing a deadline nothing defines, and rewriting
-- history to record a non-event), or a human clicking "ignore", which is really
-- a rejection under a softer word.
--
-- So the column holds NULL until a decision is recorded, and
-- `outcome IS NULL` IS 21.5's "ignored", read after the fact. That needs no
-- threshold and no sweep: the signal the requirement asks for is "the system
-- kept proposing things nobody wanted", and a NULL that stays NULL is precisely
-- that. `idx_proposals_unresolved` below is the index for counting it.
--
-- ⚠ The honest qualification: a proposal made thirty seconds ago also has a NULL
-- outcome, so the count is only meaningful over rows old enough that a human
-- would have acted. NO THRESHOLD IS INVENTED FOR THAT EITHER -- the same stance
-- `dashboard/src/proposal.ts` takes on the absent liquidity test: a stated gap
-- is a limitation, an unstated one is the failure mode.
--
-- ---------------------------------------------------------------------------
-- WHY ONLY A `derive` ROW CAN BE APPROVED
-- ---------------------------------------------------------------------------
-- Approval means a human created a real bot from this proposal. An `assess` row
-- carries a strategy WORD and its reasons; it has no parameters, so there is
-- nothing to create a bot from and no `proposalId` a create-bot request could
-- meaningfully carry. `only_a_derivation_can_be_approved` makes that a database
-- fact rather than a convention -- without it, a mis-wired caller could mark an
-- assessment approved and the record would claim a bot was built from a
-- parameter set that never existed.
--
-- An `assess` row CAN be rejected: "I read this strategy judgement and did not
-- pursue it" is a real, recordable decision, and it is the one that makes the
-- Stage 2 half of the log worth keeping.
--
-- The consequence, stated: outcome counts are only meaningful GROUPED BY `stage`.
-- Pooling them would compare a population that can be approved against one that
-- structurally cannot.
--
-- ---------------------------------------------------------------------------
-- RETENTION: SECTION 8.7 APPLIES HERE UNCHANGED
-- ---------------------------------------------------------------------------
-- "All trade, order and log data is retained indefinitely (no automatic deletion
-- or summarization in v1)." This table is log data and follows it exactly:
--
--   * NO DELETE PATH EXISTS, and structurally so rather than by intention.
--     `Repository` (see the header of /src/db/table.ts) offers no `delete`
--     method at all, and `no-raw-d1.test.ts` fails the build if any file outside
--     /src/db reaches past it. There is no soft-delete column here either --
--     unlike `watchlist.removed_at` and `bot_instances.archived`, nothing about
--     a proposal record is ever meant to leave the set.
--   * NO SUMMARIZATION. The full inputs and the full reasoning are stored as
--     they were, not as a digest. That is the point of the record: 21.5
--     requirement 2's transparency is worthless against a summary whose accuracy
--     is the thing in question.
--   * The ONE mutation is NULL -> an outcome, once. `recordProposalOutcome`
--     writes it with `outcome IS NULL` in the WHERE clause, so a second decision
--     changes nothing (the `setArchived` / capital-ledger idiom). No stored fact
--     is ever overwritten.
--
-- ---------------------------------------------------------------------------
-- WHY account_label IS A FOREIGN KEY, AND WHY `pair` IS NOT NORMALISED
-- ---------------------------------------------------------------------------
-- The second FK pointing at `accounts` (migration 0008's `watchlist` was the
-- first), for the same reason: a `pair` has no meaning without the venue that
-- lists it, and the two venues do not spell one the same way. Storing the
-- exchange's own symbol verbatim, never normalised, matches `watchlist.pair`.
--
-- Every operational table here is account-scoped (`bot_instances`,
-- `capital_ledger`, `balance_snapshots`, `manual_adjustments`,
-- `circuit_breakers`, `watchlist`) and a proposal is too -- its capital figure
-- was read from that account's ledger and its concentration flag from that
-- account's bots.
--
-- ---------------------------------------------------------------------------
-- `entry_point` ALLOWS 'general' THOUGH NOTHING CAN PRODUCE IT TODAY
-- ---------------------------------------------------------------------------
-- `entryPoint=general` 503s (`no_trending_vendor`) because no trending vendor
-- has been chosen (decision logs 30, 31), and `watchlist` runs have no assess or
-- derive endpoint yet. So every row this migration can currently receive says
-- `named`. The CHECK still names all three, because in SQLite a CHECK cannot be
-- altered without rebuilding the table, and widening it later would mean
-- rebuilding a table that by then holds the permanent record this migration
-- exists to keep. The same reasoning `alerts.alert_type` records for going the
-- other way (no CHECK at all, because the list keeps growing).

CREATE TABLE proposals (
  id                      TEXT    NOT NULL PRIMARY KEY,

  -- Which pipeline stage produced this record. See the header on why there are
  -- two rows per run rather than one.
  stage                   TEXT    NOT NULL CHECK (stage IN ('assess', 'derive')),

  -- The registered account whose ledger, bot list and venue this proposal was
  -- built against. See the header.
  account_label           TEXT    NOT NULL REFERENCES accounts (account_label),

  -- The exchange's own symbol, verbatim and never normalised, exactly as
  -- `watchlist.pair` stores it.
  pair                    TEXT    NOT NULL,

  entry_point             TEXT    NOT NULL CHECK (entry_point IN ('named', 'watchlist', 'general')),

  -- Stage 2's answer, or the strategy Stage 3 derived FOR. NOT NULL on both
  -- stages: an assessment whose whole output is a strategy choice always has
  -- one, and `derive-parse.ts` refuses a derivation that names a different one
  -- (`strategy_disagreement`), so the two can never disagree on a stored row.
  strategy_type           TEXT    NOT NULL CHECK (strategy_type IN ('grid', 'dca')),

  -- The email VERIFIED off the Access JWT (section 11), never a caller-supplied
  -- string. `ctx.actor`, the same value every other write in this system audits
  -- with.
  actor                   TEXT    NOT NULL,

  -- The model id and prompt version this answer was produced under. Columns
  -- rather than JSON keys because 21.7 open question 3 is "which Workers AI
  -- model, and its determinism characteristics" -- comparing two runs of the
  -- same prompt version on the same model is the experiment that answers it, and
  -- it has to be a query rather than a JSON scan.
  model                   TEXT    NOT NULL,
  prompt_version          TEXT    NOT NULL,

  -- 21.5 REQUIREMENT 4: "timestamped with when its underlying data was fetched
  -- -- the fetch time, not the render time." This is the price-history fetch
  -- (`candles.value.fetchedAt`), the fastest-moving of the four real fetch times
  -- and the one every proposed number is denominated against.
  --
  -- NOT NULL, and that states a real guarantee rather than a hope: both
  -- `assessCandidate` and `deriveParameters` refuse before the model call when
  -- the candle slot is not `ok`, so a row can only exist for a run that had a
  -- real window with a real fetch time. The other three fetch times are inside
  -- `inputs_json` with their own slots; they are not hoisted, because hoisting
  -- one timestamp per input would be four columns duplicating four JSON fields.
  data_fetched_at         INTEGER NOT NULL,

  -- THE FULL INPUTS (21.5 requirement 3, and the requirement's own wording:
  -- "its full inputs"). The real Stage 1 bundle -- every candle, the candidate's
  -- real provenance, the concentration read, the paused news slot -- plus, on a
  -- derive row, Stage 3's capital and venue-filter reads. Rendered by the SAME
  -- `candidateGatherBundleView` / `deriveContextView` the endpoints already put
  -- on the wire, so what is stored and what a human was shown cannot differ.
  -- NOT a summary: see the retention note in the header.
  inputs_json             TEXT    NOT NULL,

  -- THE REASONING. The prompt text in full, the settings, the raw transport
  -- response by identity, and the parsed answer with its citations resolved.
  --
  -- `promptText` is stored here even though `assessResultView` and
  -- `deriveResultView` deliberately OMIT it from the wire (it is ~16KB and
  -- ~23KB). That omission is right for a response and wrong for this record:
  -- reconstructing what produced a given answer is the whole job of an audit
  -- row, and 21.7 open question 3 cannot be settled without the bytes.
  reasoning_json          TEXT    NOT NULL,

  created_at              INTEGER NOT NULL,

  -- THE OUTCOME. NULL until a human records a decision; see the header on why
  -- 'ignored' is not a value here.
  outcome                 TEXT    CHECK (outcome IN ('approved', 'rejected')),

  -- The bot a human actually created from this proposal. This is what makes
  -- "approved" a fact about a real bot rather than a claim: it is set only by
  -- `POST /api/bots` after `create`/`createGrid` returned, so the row it names
  -- exists.
  outcome_bot_instance_id TEXT    REFERENCES bot_instances (id),
  outcome_actor           TEXT,
  outcome_at              INTEGER,
  -- Why, on a rejection. Optional for `removeFromWatchlist`'s reason: a
  -- rejection's reason is often "not now", and the created_at/outcome_at span
  -- already says how long it sat. An absent note is recorded as absent.
  outcome_note            TEXT,

  -- All-or-nothing, the shape `halt_requires_reason` (0001),
  -- `tripped_requires_reason` (0003) and `removal_is_recorded_whole` (0008)
  -- already use. A half-recorded decision -- an actor with no verdict, a verdict
  -- with no time -- is not a state this record may reach.
  CONSTRAINT outcome_is_recorded_whole
    CHECK ((outcome IS NULL     AND outcome_actor IS NULL     AND outcome_at IS NULL
                               AND outcome_bot_instance_id IS NULL AND outcome_note IS NULL)
        OR (outcome IS NOT NULL AND outcome_actor IS NOT NULL AND outcome_at IS NOT NULL)),

  -- An approval names the bot it produced; a rejection names none, because none
  -- was created. Without these two, "approved" could be recorded with no bot and
  -- would be indistinguishable from a rejection that filled the wrong column.
  CONSTRAINT approval_names_a_bot
    CHECK (outcome <> 'approved' OR outcome_bot_instance_id IS NOT NULL),
  CONSTRAINT rejection_names_no_bot
    CHECK (outcome <> 'rejected' OR outcome_bot_instance_id IS NULL),

  -- See the header: an assessment has no parameters, so no bot can be created
  -- from one.
  CONSTRAINT only_a_derivation_can_be_approved
    CHECK (outcome <> 'approved' OR stage = 'derive')
) STRICT;

-- The newest-first listing, the same read `idx_audit_log_created` serves.
CREATE INDEX idx_proposals_created ON proposals (created_at);

-- "Every proposal for this account, newest first" -- the account-scoped read
-- every other operational table indexes for.
CREATE INDEX idx_proposals_account_created ON proposals (account_label, created_at);

-- 21.5'S OWN MEASUREMENT: the proposals nobody acted on. Partial, following the
-- convention `idx_manual_adjustments_unreconciled` (0001),
-- `idx_circuit_breakers_tripped` (0003) and `idx_watchlist_active` (0008) set --
-- the interesting set is the one still waiting, and scoping the index to it
-- keeps the count cheap as the resolved history grows without bound (section
-- 8.7: nothing is ever deleted).
CREATE INDEX idx_proposals_unresolved ON proposals (stage, created_at) WHERE outcome IS NULL;

-- The reverse trace: given a bot that went wrong, the proposal that suggested
-- it. Partial for the same reason -- approvals are the small set.
CREATE INDEX idx_proposals_outcome_bot
  ON proposals (outcome_bot_instance_id)
  WHERE outcome_bot_instance_id IS NOT NULL;
