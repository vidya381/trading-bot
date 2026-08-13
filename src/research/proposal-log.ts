/**
 * THE PERMANENT PROPOSAL RECORD (spec 21.5 requirement 5).
 *
 *   > "Every proposal generated is permanently logged with its full inputs, its
 *   > reasoning, and its outcome -- approved, rejected, or ignored. Including the
 *   > ones nobody acts on, because 'the system kept proposing things nobody
 *   > wanted' is one of the two most important signals this feature can produce,
 *   > and it is invisible if only approvals are recorded."
 *
 * Every step of this arc from 30 to 44 closed with the same line -- requirement 5
 * is "NOT satisfied, NOT partially satisfied and NOT begun" -- and steps 42 and
 * 44 each declined to build a throwaway store on the explicit grounds that the
 * real record was coming. This module is that record's write path, and migration
 * 0009's header carries the storage-shape argument in full.
 *
 * `Database.proposals` has exactly one writer, and it is this file.
 *
 * ── WHEN A ROW IS WRITTEN: AUTOMATICALLY, ON EVERY REAL CALL, NO OPT-IN ──
 *
 * `/assess` and `/derive` write one row each on every successful call. There is
 * NO `?log=true`, no `logProposal` action a caller invokes, and no way to run
 * either endpoint without producing a record.
 *
 * That is the requirement read literally, and the reason is the requirement's own
 * stated reason. The signal 21.5 wants is *"the system kept proposing things
 * nobody wanted"*, which is a RATE: proposals nobody acted on, over proposals
 * generated. An opt-in flag makes the denominator "the runs someone chose to
 * log", and the runs someone chooses to log are systematically the interesting
 * ones -- so the measurement would be biased in exactly the direction that hides
 * the failure. It is the same objection `assess.ts` raises against a retry loop:
 * an answer selected FOR passing a check is fail-open wearing the costume of
 * reliability, and every discarded sample disappears silently.
 *
 * It is also the convention every other consequential write here already keeps.
 * `addToWatchlist`, `createBotInstanceWithCapital`, `releaseBotCapital`,
 * `tripAccountCircuitBreaker`, `resetGlobalKillSwitch` and `recordFill` all audit
 * themselves unconditionally, and not one of them takes a parameter that turns it
 * off.
 *
 * ── A FAILED WRITE FAILS THE REQUEST, AND THAT COSTS A PAID INFERENCE ──
 *
 * If the D1 write fails, the endpoint FAILS. The proposal is not returned.
 *
 * Stated plainly because the cost is real and unrecoverable: the model call has
 * already happened by then (the record cannot be written before the thing it
 * records exists), so a failed write means an inference was paid for and its
 * result discarded -- 10-47 s of latency and ~490-1,270 neurons, per decision log
 * 41's measurements.
 *
 * It is still the right answer, on requirement 6's terms. The alternative is
 * returning a proposal that is NOT in the permanent record, to a human who has no
 * way to tell -- which is a degraded result indistinguishable from a good one at a
 * glance, and "never silently produce a partial or degraded proposal" is what
 * requirement 6 says. Returning it with a warning is not available either:
 * requirement 3 already refuses that shape for validation ("not shown with a
 * warning, not shown greyed out with an 'approve anyway' affordance"), and the
 * same reasoning holds one requirement over. A failure is surfaced as a failure.
 *
 * ⚠ THE ONE PLACE THIS RULE IS DELIBERATELY REVERSED is the create-bot outcome
 * link, and `recordProposalApproval`'s docblock argues it there rather than here.
 *
 * ── WHY `/gather` DOES NOT WRITE A ROW, THOUGH THE BRIEF LISTED IT ──
 *
 * A DEVIATION, recorded as one rather than absorbed. `/gather` produces no
 * reasoning, no strategy, and nothing a human could approve or reject -- it is
 * Stage 1, deterministic, with no model in it (21.4). Three of this table's
 * columns (`strategy_type`, `reasoning_json`, and the whole outcome group) would
 * have nothing truthful to hold for it.
 *
 * The decisive argument is the measurement above. Gather rows could never be
 * acted on, so they would enter the "nobody acted" numerator forever and inflate
 * it without bound -- destroying the one signal this table exists to produce,
 * which is the same reason the numbers must be read grouped by `stage` (migration
 * 0009's header).
 *
 * NOTHING IS LOST BY THE OMISSION, and that is checkable rather than asserted:
 * every logged row carries the FULL gather bundle in `inputs_json`, because
 * `/assess` and `/derive` each perform their own gather and store it. A gather's
 * data is in the record; a gather is not a proposal.
 *
 * ── WHAT IS AND IS NOT LOGGED WHEN A RUN FAILS ──
 *
 * A refused run writes NO row. `assessCandidate` and `deriveParameters` catch
 * nothing (their own docblocks say so), so a parse refusal, a validator refusal,
 * a stale resubmission or a missing precondition throws out of the handler before
 * this module is reached -- and there is deliberately no `catch` here to change
 * that.
 *
 * That is 21.5's own wording followed exactly: "every PROPOSAL generated". A
 * refusal generated no proposal. It is also the honest boundary -- a row for a
 * refused run would have no reasoning to store and no outcome to reach, so it
 * would be a third kind of record wearing the shape of the first two.
 *
 * ⚠ THE CONSEQUENCE, STATED SO IT IS NOT DISCOVERED: **the refusal rate is not
 * measurable from this table.** How often the model answers unusably, or how often
 * a resubmission arrives stale, is invisible here. Those failures are real signals
 * -- they are the OTHER half of "how good is this feature" -- and recording them
 * is deliberately left to a later step, because a failure record has different
 * columns (a code, no strategy, no outcome) and would be a different table rather
 * than nullable fields on this one.
 */

import type { Database } from "../db";
import type {
  AuditLogRow,
  ProposalEntryPoint,
  ProposalOutcome,
  ProposalRow,
  ProposalStage,
  StrategyType,
} from "../db/schema";
import type { Timestamp } from "../shared/exchange-client";
import type { AssessResult } from "./assess";
import type { CandidateEntryPoint } from "./candidates";
import type { DeriveResult } from "./derive";
import type { CandidateGatherBundle } from "./gather";

/**
 * ⚠ THE PIN BETWEEN /src/research's ENTRY-POINT UNION AND /src/db's.
 *
 * `ProposalEntryPoint` (schema.ts) is the `entry_point` CHECK constraint's shadow
 * in SQL and cannot BE `CandidateEntryPoint`, because /src/db may not import from
 * /src/research. These two assignments make the pair a COMPILE ERROR to break, in
 * BOTH directions -- one alone would let the other side quietly gain a value.
 *
 * Deliberately a type-level assertion rather than a comment: the failure mode is a
 * fourth entry point added to `candidates.ts` and stored as a string the CHECK
 * constraint rejects at runtime, in production, on the write that was supposed to
 * be the permanent record.
 */
const _entryPointsAgree: ProposalEntryPoint = null as unknown as CandidateEntryPoint;
const _entryPointsAgreeBack: CandidateEntryPoint = null as unknown as ProposalEntryPoint;
void _entryPointsAgree;
void _entryPointsAgreeBack;

export type ProposalLogErrorCode =
  /**
   * The result's bundle carries no candle fetch time, so `data_fetched_at` -- 21.5
   * requirement 4's whole point -- has nothing to hold.
   *
   * UNREACHABLE THROUGH THE REAL PIPELINE, and it is a type narrowing rather than
   * a protection: both `assessCandidate` and `deriveParameters` refuse with
   * `no_price_history` before the model call when the candle slot is not `ok`, so
   * a real `AssessResult`/`DeriveResult` always has one. It throws rather than
   * defaulting because reaching it means that precondition was removed, and a
   * fabricated or omitted fetch time is precisely the thing requirement 4 is
   * about. Reachable in a unit test by constructing a result directly, which is
   * how it is tested.
   */
  | "no_fetch_time"
  /** No such proposal id. */
  | "unknown_proposal"
  /** The proposal already carries an outcome; nothing is ever overwritten. */
  | "proposal_already_resolved"
  /** An assessment cannot be approved -- it has no parameters. See migration 0009. */
  | "proposal_not_derivable"
  /** The proposal belongs to a different account than the request. */
  | "proposal_account_mismatch";

export class ProposalLogError extends Error {
  readonly code: ProposalLogErrorCode;
  constructor(code: ProposalLogErrorCode, message: string) {
    super(message);
    this.name = "ProposalLogError";
    this.code = code;
  }
}

export interface ProposalLogPorts {
  readonly db: Database;
  readonly now: () => Timestamp;
  readonly newId: () => string;
}

/**
 * One proposal record, in this system's own terms rather than the table's.
 *
 * The same shape `WatchlistEntry` takes for the same reason: nothing outside
 * /src/db should be reading snake_case column names, and the two large JSON
 * payloads are carried as `unknown` because that is genuinely what they are (see
 * `proposals.inputs_json` in schema.ts).
 */
export interface ProposalRecord {
  readonly id: string;
  readonly stage: ProposalStage;
  readonly accountLabel: string;
  readonly pair: string;
  readonly entryPoint: ProposalEntryPoint;
  readonly strategy: StrategyType;
  readonly actor: string;
  readonly model: string;
  readonly promptVersion: string;
  /** 21.5 requirement 4: when the price window was FETCHED. */
  readonly dataFetchedAt: Timestamp;
  readonly inputs: unknown;
  readonly reasoning: unknown;
  readonly createdAt: Timestamp;
  /**
   * The recorded human decision, or null.
   *
   * NULL IS 21.5's "ignored", read after the fact -- see migration 0009's header
   * on why nothing ever writes that word.
   */
  readonly outcome: ProposalOutcome | null;
  readonly outcomeBotInstanceId: string | null;
  readonly outcomeActor: string | null;
  readonly outcomeAt: Timestamp | null;
  readonly outcomeNote: string | null;
}

export function proposalRecordOf(row: ProposalRow): ProposalRecord {
  return {
    id: row.id,
    stage: row.stage,
    accountLabel: row.account_label,
    pair: row.pair,
    entryPoint: row.entry_point,
    strategy: row.strategy_type,
    actor: row.actor,
    model: row.model,
    promptVersion: row.prompt_version,
    dataFetchedAt: row.data_fetched_at,
    inputs: row.inputs_json,
    reasoning: row.reasoning_json,
    createdAt: row.created_at,
    outcome: row.outcome,
    outcomeBotInstanceId: row.outcome_bot_instance_id,
    outcomeActor: row.outcome_actor,
    outcomeAt: row.outcome_at,
    outcomeNote: row.outcome_note,
  };
}

// ---------------------------------------------------------------------------
// Writing a proposal
// ---------------------------------------------------------------------------

/**
 * The rendered payloads, supplied by the caller rather than built here.
 *
 * ── WHY THE CALLER RENDERS THEM, AND WHY THAT IS THE STRONGER DESIGN ──
 *
 * The two JSON blobs are produced by `/src/api/serialize.ts` -- the same
 * `candidateGatherBundleView`, `deriveContextView`, `citedClaimView` and
 * `evidenceItemView` that already put these objects on the wire. /src/research
 * cannot import them (the api layer imports research, not the other way), so they
 * arrive as parameters.
 *
 * That is not a compromise. It is what makes the record's central claim TRUE
 * BY CONSTRUCTION: **the handler passes the very object it puts in the response**,
 * so what is stored and what the human was shown cannot differ. A second
 * rendering here -- even a faithful one -- would be a copy that drifts, and 21.5
 * requirement 2 is specifically about being able to check reasoning against the
 * real source. A stored summary whose accuracy is the question is the thing that
 * requirement forbids.
 *
 * ⚠ WHAT THE STORED `reasoning` HAS THAT THE WIRE DOES NOT: `promptText` and the
 * raw transport response. `assessResultView` and `deriveResultView` deliberately
 * omit the prompt (~16KB and ~23KB, decision log 41) because `evidence` carries
 * the same values in a form a reader can actually compare. That omission is right
 * for a response and WRONG for this record: reconstructing what produced a given
 * answer is this row's entire job, and 21.7's open question 3 -- which model, and
 * how deterministic -- cannot be settled without the bytes.
 *
 * The SCALAR columns are NOT taken as parameters. They are read off the real
 * `AssessResult`/`DeriveResult` below, so a caller cannot mis-state the pair, the
 * strategy, the model or the fetch time while passing a correct payload.
 */
export interface ProposalPayload {
  /** 21.5's "full inputs": the real bundle, and on a derive row Stage 3's reads too. */
  readonly inputs: unknown;
  /** 21.5's "its reasoning": prompt, settings, model response, parsed answer. */
  readonly reasoning: unknown;
}

export interface LogProposalRequest extends ProposalPayload {
  /** Which door the candidate came through. */
  readonly entryPoint: CandidateEntryPoint;
  /** The email VERIFIED off the Access token (section 11), never caller-supplied. */
  readonly actor: string;
}

function fetchTimeOf(bundle: CandidateGatherBundle, stage: ProposalStage): Timestamp {
  if (bundle.candles.outcome !== "ok") {
    throw new ProposalLogError(
      "no_fetch_time",
      `cannot record a ${stage} proposal for ${bundle.candidate.pair}: its candle slot is ` +
        `${JSON.stringify(bundle.candles.outcome)}, so there is no fetch time to timestamp it ` +
        `with. 21.5 requirement 4 times a proposal from when its data was FETCHED, and a ` +
        `record with a fabricated or omitted fetch time cannot be staleness-checked at all. ` +
        `This is unreachable through the pipeline -- both stages refuse with no_price_history ` +
        `before the model call -- so reaching it means that precondition was removed.`,
    );
  }
  return bundle.candles.value.fetchedAt;
}

/**
 * Insert the row and its `audit_log` entry as ONE atomic batch.
 *
 * The shape `addToWatchlist` established, and for its stated reason: the INSERT
 * either lands or throws, so one batch keeps the record and the entry naming who
 * caused it inseparable. A proposal row with no audit entry is not a state this
 * table can reach.
 *
 * There is deliberately no second audit mechanism -- `db.auditLog` is the same
 * path every other consequential write in this system uses.
 */
async function insertProposal(
  ports: ProposalLogPorts,
  row: ProposalRow,
  action: "proposal.assessed" | "proposal.derived",
): Promise<ProposalRecord> {
  const audit: AuditLogRow = {
    id: ports.newId(),
    actor: row.actor,
    action,
    // NULL: no bot exists, and 21.1 guarantees this pipeline has no write path to
    // one. The kill switch and the section 16 deploy entries are account-less and
    // bot-less in the same way.
    target_bot_instance_id: null,
    // A POINTER AND THE FACTS THAT IDENTIFY IT -- deliberately not the payload.
    // The record itself holds the full inputs and reasoning; duplicating them
    // here would put megabytes in the path of every unrelated `audit_log` read
    // (see migration 0009's third reason for a dedicated table).
    details_json: {
      proposal_id: row.id,
      stage: row.stage,
      account_label: row.account_label,
      pair: row.pair,
      entry_point: row.entry_point,
      strategy_type: row.strategy_type,
      model: row.model,
      prompt_version: row.prompt_version,
      data_fetched_at: row.data_fetched_at,
    },
    created_at: row.created_at,
  };

  // Named rather than inlined: `no-raw-d1.test.ts` forbids `.batch([` outside
  // /src/db, because that pattern cannot tell this sanctioned call -- repository
  // statement builders handed to `Database.batch` -- from a raw one. The same
  // workaround `capital/ledger.ts` and `watchlist.ts` already use, for the same
  // reason.
  const statements = [
    ports.db.proposals.insertStatement(row),
    ports.db.auditLog.insertStatement(audit),
  ];
  await ports.db.batch(statements);

  return proposalRecordOf(row);
}

/**
 * Record a Stage 2 assessment.
 *
 * `strategy_type` is Stage 2's whole answer, so it is always present. There is no
 * outcome path that can APPROVE this row -- an assessment has no parameters and no
 * bot can be created from it (migration 0009's `only_a_derivation_can_be_approved`)
 * -- but it CAN be rejected, and that asymmetry is why the Stage 2 half of the log
 * is worth keeping: "I read this strategy judgement and did not pursue it" is the
 * cheapest real signal this feature produces.
 */
export async function logAssessProposal(
  ports: ProposalLogPorts,
  result: AssessResult,
  request: LogProposalRequest,
): Promise<ProposalRecord> {
  const row: ProposalRow = {
    id: ports.newId(),
    stage: "assess",
    // Every scalar off the REAL result, never off a parameter. See ProposalPayload.
    account_label: result.bundle.candidate.accountLabel,
    pair: result.bundle.candidate.pair,
    entry_point: request.entryPoint,
    strategy_type: result.strategy,
    actor: request.actor,
    model: result.model,
    prompt_version: result.promptVersion,
    data_fetched_at: fetchTimeOf(result.bundle, "assess"),
    inputs_json: request.inputs,
    reasoning_json: request.reasoning,
    created_at: ports.now(),
    outcome: null,
    outcome_bot_instance_id: null,
    outcome_actor: null,
    outcome_at: null,
    outcome_note: null,
  };
  return await insertProposal(ports, row, "proposal.assessed");
}

/**
 * Record a Stage 3 derivation -- the row a human can approve.
 *
 * `result.strategy` rather than `result.assessment.strategy`: they are the same
 * value by construction (`derive-parse.ts` refuses a response naming a different
 * strategy with `strategy_disagreement`, a total refusal), and taking it from the
 * derivation means the stored strategy is the one the PARAMETERS are for.
 */
export async function logDeriveProposal(
  ports: ProposalLogPorts,
  result: DeriveResult,
  request: LogProposalRequest,
): Promise<ProposalRecord> {
  const bundle = result.context.bundle;
  const row: ProposalRow = {
    id: ports.newId(),
    stage: "derive",
    account_label: bundle.candidate.accountLabel,
    pair: bundle.candidate.pair,
    entry_point: request.entryPoint,
    strategy_type: result.strategy,
    actor: request.actor,
    model: result.model,
    prompt_version: result.promptVersion,
    data_fetched_at: fetchTimeOf(bundle, "derive"),
    inputs_json: request.inputs,
    reasoning_json: request.reasoning,
    created_at: ports.now(),
    outcome: null,
    outcome_bot_instance_id: null,
    outcome_actor: null,
    outcome_at: null,
    outcome_note: null,
  };
  return await insertProposal(ports, row, "proposal.derived");
}

// ---------------------------------------------------------------------------
// The outcome
// ---------------------------------------------------------------------------

/**
 * Read a proposal and check it can still take an outcome, WITHOUT writing.
 *
 * Split out so `POST /api/bots` can run every check BEFORE it creates a bot.
 * That ordering is the whole reason this function exists separately, and it is
 * `createBot`'s own documented rule ("FREE CHECKS FIRST, NETWORK LAST"): a bad
 * `proposalId` must refuse the request while nothing has happened, rather than
 * after capital is reserved and a Durable Object exists.
 *
 * @param forApproval when true, also refuses a row no bot can be created from.
 */
export async function checkProposalCanTakeOutcome(
  ports: ProposalLogPorts,
  proposalId: string,
  options: { readonly accountLabel?: string; readonly forApproval: boolean },
): Promise<ProposalRow> {
  const row = await ports.db.proposals.findOne({ id: proposalId });
  if (row === null) {
    throw new ProposalLogError(
      "unknown_proposal",
      `no proposal with id ${JSON.stringify(proposalId)}. Proposal ids come from the ` +
        `"proposalId" field a real /assess or /derive response carries; there is no way to ` +
        `mint one, and section 8.7 means none has ever been deleted.`,
    );
  }

  if (options.accountLabel !== undefined && row.account_label !== options.accountLabel) {
    throw new ProposalLogError(
      "proposal_account_mismatch",
      `proposal ${JSON.stringify(proposalId)} was made for account ` +
        `${JSON.stringify(row.account_label)}, not ${JSON.stringify(options.accountLabel)}. ` +
        `Its capital figure was read from that account's ledger and its concentration flag ` +
        `from that account's bots, so recording it as the reason for a bot on a different ` +
        `account would attach reasoning to numbers it was never about.`,
    );
  }

  if (row.outcome !== null) {
    throw new ProposalLogError(
      "proposal_already_resolved",
      `proposal ${JSON.stringify(proposalId)} was already recorded as ${row.outcome} by ` +
        `${JSON.stringify(row.outcome_actor)} at ${row.outcome_at}. Nothing overwrites a ` +
        `recorded outcome: section 8.7 retains this data indefinitely and a second decision ` +
        `replacing the first would be rewriting the record this table exists to be trusted about.`,
    );
  }

  if (options.forApproval && row.stage !== "derive") {
    throw new ProposalLogError(
      "proposal_not_derivable",
      `proposal ${JSON.stringify(proposalId)} is a ${row.stage} record, and only a derive ` +
        `record can be approved: an assessment carries a strategy choice and its reasons, not ` +
        `the parameters a bot needs, so no bot could have been created from it. Run ` +
        `GET /api/accounts/${row.account_label}/derive for that assessment and approve the ` +
        `proposal it returns.`,
    );
  }

  return row;
}

/**
 * Write the outcome, once, and audit it.
 *
 * ── THE UPDATE IS CONDITIONAL AND ITS `changes` IS THE DECISION ──
 *
 * `where: { id, outcome: null }` is `removeFromWatchlist`'s and `setArchived`'s
 * idiom, and it is what makes "an outcome is written once" true against the
 * DATABASE rather than against a row read a moment earlier. Two concurrent
 * decisions cannot both land, and the loser is told so rather than silently
 * overwriting the winner.
 *
 * The audit entry is written SEQUENTIALLY, after the update, where
 * `insertProposal` above batches. The asymmetry is deliberate and is
 * `removeFromWatchlist`'s reasoning exactly: an INSERT either lands or throws, so
 * batching keeps it inseparable from its entry -- but here the UPDATE's `changes`
 * IS the decision, and a batch would commit an audit entry claiming a human
 * resolved a proposal in the case where the update matched nothing. Of the two
 * failure shapes, "no audit row for an outcome that happened" is recoverable from
 * the proposal row itself; "an audit row for an outcome that did not" is a false
 * record of a human act.
 */
async function writeOutcome(
  ports: ProposalLogPorts,
  row: ProposalRow,
  outcome: ProposalOutcome,
  actor: string,
  botInstanceId: string | null,
  note: string | null,
): Promise<ProposalRecord> {
  const now = ports.now();
  const changed = await ports.db.proposals.update(
    { id: row.id, outcome: null },
    {
      outcome,
      outcome_actor: actor,
      outcome_at: now,
      outcome_bot_instance_id: botInstanceId,
      outcome_note: note,
    },
  );
  if (changed !== 1) {
    // Lost the race. Reported rather than swallowed, for `removeFromWatchlist`'s
    // reason: the proposal IS resolved, but not by this caller, and no audit entry
    // naming this actor should claim otherwise.
    throw new ProposalLogError(
      "proposal_already_resolved",
      `proposal ${JSON.stringify(row.id)} was resolved by someone else first; nothing was ` +
        `changed by this request.`,
    );
  }

  await ports.db.auditLog.insert({
    id: ports.newId(),
    actor,
    action: outcome === "approved" ? "proposal.approved" : "proposal.rejected",
    // THE ONE audit entry in this module that names a bot, and the only sense in
    // which section 21 ever touches one: this records that a HUMAN created it
    // through the ordinary create-bot flow. The pipeline still has no write path
    // to a bot (21.1).
    target_bot_instance_id: botInstanceId,
    details_json: {
      proposal_id: row.id,
      stage: row.stage,
      account_label: row.account_label,
      pair: row.pair,
      strategy_type: row.strategy_type,
      outcome,
      note,
      // How long the proposal sat before anyone acted -- the figure 21.5's
      // "proposals nobody wanted" signal is measured against, on the rows where
      // someone did.
      proposed_at: row.created_at,
      pending_ms: now - row.created_at,
      /**
       * ⚠ THE HUMAN AND THE PROPOSAL'S OWN ACTOR ARE RECORDED SEPARATELY, and
       * they are genuinely allowed to differ: one operator can act on a proposal
       * another generated, and collapsing them would lose which is which.
       */
      proposed_by: row.actor,
    },
    created_at: now,
  } satisfies AuditLogRow);

  return proposalRecordOf({
    ...row,
    outcome,
    outcome_actor: actor,
    outcome_at: now,
    outcome_bot_instance_id: botInstanceId,
    outcome_note: note,
  });
}

/**
 * APPROVED: a human created a real bot from this proposal.
 *
 * ── CALLED AFTER THE BOT EXISTS, AND THAT IS WHY IT IS ALLOWED TO FAIL SOFTLY ──
 *
 * This is the one place the module header's fail-closed rule is reversed, and the
 * reversal is principled rather than convenient.
 *
 * At `/assess` and `/derive` the write happens before anything irreversible, so
 * failing the request loses an inference and leaves no wrong state behind. HERE
 * the write can only happen after `create`/`createGrid` has returned: the row it
 * names must exist for `approval_names_a_bot` and the foreign key to hold, and
 * `outcome_bot_instance_id` pointing at a bot that was never created is exactly
 * the fabricated audit fact `assess-resubmit.ts` refuses to manufacture.
 *
 * So by the time this runs, a real bot exists, capital is reserved, and orders may
 * follow within the minute. Failing the HTTP response at that point would tell an
 * operator that creation failed when it did not -- and the recovery they would
 * attempt (create it again) is the worst available action. `createBot` therefore
 * REPORTS the link failure in the response body instead, and this function's
 * caller is the only caller allowed to do that. `undoReservation`
 * (`capital/ledger.ts`) handles a post-commit failure the same way and for the
 * same reason.
 */
export async function recordProposalApproval(
  ports: ProposalLogPorts,
  row: ProposalRow,
  actor: string,
  botInstanceId: string,
): Promise<ProposalRecord> {
  return await writeOutcome(ports, row, "approved", actor, botInstanceId, null);
}

export interface RejectProposalRequest {
  readonly actor: string;
  /** Optional. An absent note is recorded as absent -- `removeFromWatchlist`'s stance. */
  readonly note?: string | undefined;
}

/**
 * REJECTED: a human read this proposal and decided against it.
 *
 * ── WHY THIS EXISTS NOW RATHER THAN WITH A UI ──
 *
 * `proposals.outcome`'s CHECK constraint names two values, and in SQLite a CHECK
 * cannot be altered without rebuilding the table -- which for THIS table would
 * mean rebuilding the permanent record. So the value set had to be decided at
 * migration time, and a value with no possible writer would be exactly the check
 * that cannot fire: decision log 37 refused one ("theatre"), and decision log 41
 * refused another (a `minNotional`-only floor that would have passed every
 * proposal forever on the only venue this system runs against, while reading in
 * review like a floor). A `rejected` state nothing could ever produce would read
 * in the schema like a recorded decision and be unreachable in fact.
 *
 * It is reachable by curl and nothing else, which is the established norm here,
 * not a gap: `/candles`, `/gather`, `/assess`, `/derive` and all three watchlist
 * endpoints have no dashboard control either (decision logs 42, 44).
 *
 * ⚠ AN ASSESSMENT MAY BE REJECTED; only a derivation may be approved. That is
 * `checkProposalCanTakeOutcome`'s `forApproval: false` here, and it is the point
 * of keeping Stage 2 rows: rejecting an assessment records that a human read a
 * strategy judgement and chose not to spend a Derive inference on it.
 */
export async function rejectProposal(
  ports: ProposalLogPorts,
  proposalId: string,
  request: RejectProposalRequest,
): Promise<ProposalRecord> {
  const row = await checkProposalCanTakeOutcome(ports, proposalId, { forApproval: false });
  const note = request.note === undefined || request.note.trim() === "" ? null : request.note.trim();
  return await writeOutcome(ports, row, "rejected", request.actor, null, note);
}
