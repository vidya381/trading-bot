/**
 * The account-wide circuit breaker (spec sections 7.3 and 9), build step 7.
 *
 * BUILT THIS SESSION, NOT DESCRIBED. Section 9's severe tier says "trigger the
 * account-wide circuit breaker, halt everything on that account, alert
 * immediately". Before this file, that control existed only as a paragraph in
 * section 7.3 -- so the severe tier could not have been implemented as anything
 * but a comment saying what should happen. It is real now, and this is the
 * minimal version of it: the mechanism plus section 9's trigger.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS AND IS NOT HERE
 * ---------------------------------------------------------------------------
 * Section 7.3 defines the breaker by ONE trigger: total realized and
 * unrealized loss across all bots on an account for the current day crossing a
 * threshold. Section 9 adds a SECOND trigger: severe drift. They share one
 * mechanism -- halt everything on the account, alert, and stay latched.
 *
 * The mechanism and section 9's trigger are built. Section 7.3's daily-loss
 * trigger is NOT, and this is the honest reason: computing unrealized loss
 * needs a live price for every open position, which means an exchange call per
 * pair on a schedule, and a decision about what "for the current day" means
 * across timezones. That is its own piece of work with its own questions, and
 * bolting a half-considered version onto this file would produce a risk control
 * nobody had thought about properly.
 *
 * `tripAccountCircuitBreaker` takes the reason as a string and does not care
 * which trigger produced it, so wiring the second trigger later is a caller
 * change, not a change here.
 *
 * ---------------------------------------------------------------------------
 * WHY IT LATCHES
 * ---------------------------------------------------------------------------
 * Halting every bot that exists at the moment of the trip is not a circuit
 * breaker; it is a broadcast. The next bot created on that account would start
 * trading straight into whatever unexplained state caused the trip.
 *
 * So the tripped state persists (migration 0003) and is checked by
 * `BotInstance.create` and `BotInstance.resume`. Only
 * `resetAccountCircuitBreaker` clears it, and that refuses an automated actor
 * -- the same guard, for the same reason, as step 5's
 * `seedPlaceholderTotalBalance`. A breaker a cron can reset is not a breaker.
 *
 * A reset re-arms the ACCOUNT. It does not resume a single bot: section 7.2
 * step 5 requires an explicit human action per bot after review, and one click
 * silently restarting eleven bots would defeat that.
 */

import { NON_HUMAN_ACTORS } from "../capital";
import type { Database } from "../db/database";
import type {
  AlertRow,
  AuditLogRow,
  BotInstanceRow,
  CircuitBreakerRow,
} from "../db/schema";

export type CircuitBreakerErrorCode =
  /** An action was attempted on an account whose breaker is tripped. */
  | "account_tripped"
  /** A reset was attempted by `system`, `cron`, `ci` or `reconciliation`. */
  | "reset_requires_human_actor"
  /** A reset was attempted without saying why it is safe to re-arm. */
  | "reset_requires_note"
  /** A reset was attempted on an account that is not tripped. */
  | "not_tripped";

export class CircuitBreakerError extends Error {
  readonly code: CircuitBreakerErrorCode;
  readonly accountLabel: string;

  constructor(code: CircuitBreakerErrorCode, accountLabel: string, message: string) {
    super(message);
    this.name = "CircuitBreakerError";
    this.code = code;
    this.accountLabel = accountLabel;
  }
}

/**
 * How the breaker halts a bot.
 *
 * An injected port rather than a Durable Object lookup done here, following
 * step 2's decision 12: this module states what it needs and the caller
 * supplies it. It keeps every path in this file testable without a Durable
 * Object namespace, and it means the breaker has no opinion about how a bot is
 * reached -- `reconcile.ts` supplies a real stub call, tests supply a fake.
 *
 * Implementations must be idempotent. `BotInstance.halt` already is: halting
 * an already-halted bot returns `already_halted` and changes nothing.
 */
export type HaltBotPort = (
  botInstanceId: string,
  detail: string,
) => Promise<HaltBotOutcome | void>;

/**
 * What a halt actually did, when the port bothers to say.
 *
 * `void` is still accepted, and that is deliberate rather than lax: a port that
 * does not report cannot be distinguished from one that halted something, so an
 * unreported halt is counted as a halt -- the meaning `haltedBotIds` has always
 * had. Production wiring returns the real answer; a test double that does not
 * care simply keeps returning nothing.
 */
export type HaltBotOutcome = "halted" | "already_halted";

/**
 * Statuses whose bots D1 believes are still capable of trading.
 *
 * NOT the set the sweep halts -- see `SWEPT_STATUSES`. This one answers "is
 * there anything here for a breaker to DO", which is a different question and
 * has two callers that depend on it staying narrow: the dashboard's "this will
 * halt N bots" preview, and `reconcile.ts`'s guard on re-sweeping an
 * already-latched account. Widening THIS constant would make that guard
 * permanently true on every latched account -- tripping halts every bot, so a
 * latched account always has halted bots -- and the five-minute re-sweep would
 * write a `circuit_breaker.swept` audit row forever, which is precisely what
 * the guard's own comment says it exists to prevent.
 */
const ACTIVE_STATUSES = ["created", "running"] as const;

/**
 * Statuses the sweep actually visits -- `ACTIVE_STATUSES` plus `halted`.
 *
 * WHY `halted` IS SWEPT despite D1 saying those bots are already stopped. D1's
 * status is a MIRROR of the bot's own, and tonight's `bot-gvtr1a` proved the
 * two can disagree: a bot whose row said `halted` was internally `running`,
 * receiving prices and able to trade. Selecting targets by the mirror alone
 * means an emergency stop is only as good as the mirror's accuracy, and the one
 * moment that matters is the moment you cannot afford to find out it was wrong.
 * Sweeping `halted` too costs one extra idempotent RPC per already-halted bot
 * and removes the dependency entirely.
 *
 * This is INSURANCE, not the fix. The known cause of that disagreement is fixed
 * (the resume write order) and detected (the bot-status comparison in
 * `reconcile.ts`); this covers causes not yet found, without waiting for a
 * detector pass to have run first.
 *
 * `stopped` is NOT here, and must not be: `BotInstance.#halt` THROWS on a
 * stopped bot ("its capital is released"), so sweeping one would not be a
 * harmless no-op -- it would land in `failures` and report a false alarm on
 * every pull. `archived` is not filtered on at all, in either direction: it is
 * orthogonal to status by design, and an archived bot whose object is secretly
 * live is exactly as dangerous as any other.
 */
export const SWEPT_STATUSES = ["created", "running", "halted"] as const;

/**
 * The sweep order: everything D1 believes is live FIRST.
 *
 * The loop below is sequential -- one awaited cross-object RPC per bot -- so
 * every bot visited before a genuinely running one delays stopping it. Adding
 * halted bots to the set must not slow down the emergency path, so they go
 * last. The row order the query returns is unspecified, which is why this is
 * not left to it.
 */
export function emergencySweepOrder(bots: readonly BotInstanceRow[]): BotInstanceRow[] {
  const live = (bot: BotInstanceRow): boolean =>
    (ACTIVE_STATUSES as readonly string[]).includes(bot.status);
  return [...bots.filter(live), ...bots.filter((bot) => !live(bot))];
}

export interface TripRequest {
  readonly accountLabel: string;
  /** Prose, for the human deciding whether to reset. Ends up in the alert. */
  readonly reason: string;
  /** The reconciliation run that concluded it, or null for a manual trip. */
  readonly runId: string | null;
  /** `reconciliation` for a section 9 trip, or an authenticated email. */
  readonly actor: string;
  readonly now: number;
  readonly haltBot: HaltBotPort;
  readonly newId: () => string;
}

export interface TripResult {
  /** False when the account was already tripped by an earlier run. */
  readonly newlyTripped: boolean;
  /**
   * Bots this call actually stopped -- ones that were still live when it
   * reached them. UNCHANGED IN MEANING by the halted-bot sweep, deliberately:
   * this number is read by a human deciding whether an emergency is contained,
   * and quietly folding already-stopped bots into it would inflate the one
   * figure that answers "how much was still running".
   */
  readonly haltedBotIds: readonly string[];
  /**
   * Bots the sweep visited and found ALREADY halted.
   *
   * Reported separately rather than merged above, and rather than not reported
   * at all: it is the evidence that the insurance pass actually ran and covered
   * them, which is otherwise invisible.
   */
  readonly alreadyHaltedBotIds: readonly string[];
  /**
   * Bots this call tried and failed to halt, with the failure.
   *
   * Non-empty is not a reason to abort: a breaker that stops at the first
   * unreachable bot leaves the rest trading. They are reported so the caller
   * can alert, and the next run's sweep tries them again.
   */
  readonly failures: readonly { readonly botInstanceId: string; readonly message: string }[];
}

/** The row, or null if this account has never been tripped. */
export async function readCircuitBreaker(
  db: Database,
  accountLabel: string,
): Promise<CircuitBreakerRow | null> {
  return await db.circuitBreakers.findOne({ account_label: accountLabel });
}

/**
 * Is this account latched?
 *
 * A missing row means never tripped, which is armed. Treating absence as
 * "armed" rather than as an error is what lets every account work without
 * anything having to seed a row first.
 */
export async function isAccountTripped(db: Database, accountLabel: string): Promise<boolean> {
  const row = await readCircuitBreaker(db, accountLabel);
  return row !== null && row.state === "tripped";
}

/**
 * Refuse an action on a latched account.
 *
 * Called by `BotInstance.create` and `BotInstance.resume`. Those are the two
 * ways a bot on a tripped account could start trading again, and blocking both
 * is what makes the latch mean something.
 */
export async function assertAccountArmed(
  db: Database,
  accountLabel: string,
  action: string,
): Promise<void> {
  const row = await readCircuitBreaker(db, accountLabel);
  if (row === null || row.state !== "tripped") return;
  throw new CircuitBreakerError(
    "account_tripped",
    accountLabel,
    `cannot ${action}: the account-wide circuit breaker for ` +
      `${JSON.stringify(accountLabel)} is tripped (${row.reason ?? "no reason recorded"}). ` +
      `It was tripped at ${row.tripped_at} by ${row.tripped_by ?? "unknown"} and stays ` +
      `latched until a human resets it with resetAccountCircuitBreaker. Section 7.3.`,
  );
}

/**
 * Trip the breaker and halt everything on the account.
 *
 * Idempotent by design, and deliberately not a no-op when already tripped. If
 * an earlier trip failed to halt some bot -- unreachable object, transient D1
 * failure -- the next call sweeps again and halts it. Only the state write and
 * the alert are suppressed on a repeat, so a five-minute cron does not produce
 * a critical alert every five minutes for one event.
 *
 * ORDERING: the latch is written BEFORE any bot is halted. That follows step
 * 6's decision 2 exactly -- mark the stop durably first, then carry it out --
 * so a crash partway through leaves an account that is latched with some bots
 * still running, which the next sweep fixes. The reverse leaves bots halted on
 * an account that still accepts new ones.
 */
export async function tripAccountCircuitBreaker(
  db: Database,
  request: TripRequest,
): Promise<TripResult> {
  const { accountLabel, reason, runId, actor, now, haltBot, newId } = request;

  const newlyTripped = await latch(db, request);

  // Sweep every bot still capable of trading. Read AFTER the latch is written,
  // so a bot created in the gap is either blocked by `assertAccountArmed` or
  // already visible here.
  const bots = emergencySweepOrder(
    await db.botInstances.findMany({
      where: { account_label: accountLabel, status: { in: [...SWEPT_STATUSES] } },
    }),
  );

  const haltedBotIds: string[] = [];
  const alreadyHaltedBotIds: string[] = [];
  const failures: { botInstanceId: string; message: string }[] = [];

  for (const bot of bots) {
    try {
      const outcome = await haltBot(
        bot.id,
        `account circuit breaker tripped for ${accountLabel}: ${reason}`,
      );
      if (outcome === "already_halted") alreadyHaltedBotIds.push(bot.id);
      else haltedBotIds.push(bot.id);
    } catch (error) {
      // Deliberately does not rethrow. One unreachable bot must not leave the
      // other ten running -- the same reasoning as step 6's cancel loop.
      failures.push({
        botInstanceId: bot.id,
        message: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      });
    }
  }

  if (newlyTripped) {
    // Section 10: written to D1 unconditionally. The outbound notification and
    // its KV cooldown are step 8, so today this is loud only to the dashboard.
    const alert: AlertRow = {
      id: newId(),
      severity: "critical",
      category: "trading",
      alert_type: "circuit_breaker_tripped",
      // Account-wide, so it belongs to no single bot. `alerts.bot_instance_id`
      // is nullable for exactly this case.
      bot_instance_id: null,
      source: "reconciliation",
      message:
        `ACCOUNT-WIDE CIRCUIT BREAKER TRIPPED for ${accountLabel}: ${reason}. ` +
        `Halted ${haltedBotIds.length} bot(s)` +
        (failures.length > 0
          ? `; FAILED to halt ${failures.length}: ${failures
              .map((failure) => `${failure.botInstanceId} (${failure.message})`)
              .join(", ")}`
          : "") +
        `. No bot on this account can be created or resumed until a human resets it.`,
      resolved: false,
      created_at: now,
      notified_at: null,
    };
    await db.alerts.insert(alert);
  }

  const audit: AuditLogRow = {
    id: newId(),
    actor,
    action: newlyTripped ? "circuit_breaker.tripped" : "circuit_breaker.swept",
    // Account-wide, like section 7.4's kill switch. The column is nullable for
    // exactly this.
    target_bot_instance_id: null,
    details_json: {
      account_label: accountLabel,
      reason,
      run_id: runId,
      newly_tripped: newlyTripped,
      halted: haltedBotIds,
      already_halted: alreadyHaltedBotIds,
      failed: failures,
    },
    created_at: now,
  };
  await db.auditLog.insert(audit);

  return { newlyTripped, haltedBotIds, alreadyHaltedBotIds, failures };
}

/**
 * Write the latch. Returns whether THIS call was the one that tripped it.
 *
 * Conditional on the current state so two concurrent trips cannot both report
 * `newlyTripped` and therefore cannot both raise a critical alert for one
 * event. An insert that loses a race to the PRIMARY KEY is caught and re-read,
 * which is the same shape as step 5's compare-and-swap, in miniature.
 */
async function latch(db: Database, request: TripRequest): Promise<boolean> {
  const { accountLabel, reason, runId, actor, now } = request;
  const existing = await readCircuitBreaker(db, accountLabel);

  if (existing === null) {
    const row: CircuitBreakerRow = {
      account_label: accountLabel,
      state: "tripped",
      reason,
      run_id: runId,
      tripped_at: now,
      tripped_by: actor,
      reset_at: null,
      reset_by: null,
      updated_at: now,
    };
    try {
      await db.circuitBreakers.insert(row);
      return true;
    } catch {
      // Someone inserted between the read and the write. Fall through to the
      // conditional update, which will report false if they tripped it too.
      const changes = await db.circuitBreakers.update(
        { account_label: accountLabel, state: "armed" },
        {
          state: "tripped",
          reason,
          run_id: runId,
          tripped_at: now,
          tripped_by: actor,
          updated_at: now,
        },
      );
      return changes === 1;
    }
  }

  if (existing.state === "tripped") return false;

  const changes = await db.circuitBreakers.update(
    { account_label: accountLabel, state: "armed" },
    {
      state: "tripped",
      reason,
      run_id: runId,
      tripped_at: now,
      tripped_by: actor,
      updated_at: now,
    },
  );
  return changes === 1;
}

export interface ResetRequest {
  readonly accountLabel: string;
  /** An authenticated email. Automated actors are refused. */
  readonly actor: string;
  /** Why it is safe to re-arm. Required, and stored in `audit_log`. */
  readonly note: string;
  readonly now: number;
  readonly newId: () => string;
}

/**
 * Re-arm an account. Human action only.
 *
 * Refuses `system`, `ci`, `cron` and `reconciliation` -- the same list step 5
 * uses for seeding a placeholder balance, imported rather than re-declared so
 * the two cannot drift. The failure this guards against is not somebody being
 * careless in six months; it is a future retry-or-recovery path being pointed
 * at this function because it already writes the right column, and quietly
 * clearing a breaker nobody investigated.
 *
 * Re-arming does NOT resume any bot. Every bot halted by the trip stays halted
 * until someone resumes it individually, per section 7.2 step 5.
 */
export async function resetAccountCircuitBreaker(
  db: Database,
  request: ResetRequest,
): Promise<void> {
  const { accountLabel, now, newId } = request;
  const actor = request.actor.trim();
  const note = request.note.trim();

  if (actor === "" || NON_HUMAN_ACTORS.includes(actor)) {
    throw new CircuitBreakerError(
      "reset_requires_human_actor",
      accountLabel,
      `resetting the circuit breaker for ${JSON.stringify(accountLabel)} requires ` +
        `a human actor, got ${JSON.stringify(request.actor)}. The breaker exists to ` +
        `stop automated trading on an account whose state is not understood; an ` +
        `automated reset would defeat it entirely.`,
    );
  }

  if (note === "") {
    throw new CircuitBreakerError(
      "reset_requires_note",
      accountLabel,
      `resetting the circuit breaker for ${JSON.stringify(accountLabel)} requires a ` +
        `note recording what was investigated and why it is safe to re-arm. It is ` +
        `the only record of that reasoning.`,
    );
  }

  const changes = await db.circuitBreakers.update(
    { account_label: accountLabel, state: "tripped" },
    { state: "armed", reset_at: now, reset_by: actor, updated_at: now },
  );

  if (changes !== 1) {
    throw new CircuitBreakerError(
      "not_tripped",
      accountLabel,
      `the circuit breaker for ${JSON.stringify(accountLabel)} is not tripped, so ` +
        `there is nothing to reset`,
    );
  }

  const audit: AuditLogRow = {
    id: newId(),
    actor,
    action: "circuit_breaker.reset",
    target_bot_instance_id: null,
    details_json: { account_label: accountLabel, note },
    created_at: now,
  };
  await db.auditLog.insert(audit);

  // Info rather than critical: the dashboard's alert history should show the
  // re-arm beside the trip, but nothing needs waking up for it.
  const alert: AlertRow = {
    id: newId(),
    severity: "info",
    category: "trading",
    alert_type: "circuit_breaker_reset",
    bot_instance_id: null,
    source: "dashboard",
    message:
      `Account-wide circuit breaker for ${accountLabel} re-armed by ${actor}: ${note}. ` +
      `Bots halted by the trip remain halted and must each be resumed explicitly.`,
    resolved: false,
    created_at: now,
    notified_at: null,
  };
  await db.alerts.insert(alert);
}

/** Bots the breaker would halt right now. Exported for the dashboard. */
export async function activeBotsOnAccount(
  db: Database,
  accountLabel: string,
): Promise<BotInstanceRow[]> {
  return await db.botInstances.findMany({
    where: { account_label: accountLabel, status: { in: [...ACTIVE_STATUSES] } },
  });
}
