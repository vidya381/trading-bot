/**
 * The global kill switch (spec section 7.4), build step 10.3.
 *
 * The global sibling of the account-wide circuit breaker in
 * `./circuit-breaker.ts`. Section 7.4: "a single dashboard control that halts
 * every bot, on every account, immediately ... a distinct, one-click action
 * separate from per-account circuit breakers, for use in a genuine emergency."
 *
 * ---------------------------------------------------------------------------
 * WHAT IT SHARES WITH THE ACCOUNT BREAKER, AND WHAT IT DOES NOT
 * ---------------------------------------------------------------------------
 * Shared, deliberately, so the two behave the same where they should:
 *
 *   - it LATCHES (migration 0005), for the same reason the account breaker does
 *     -- halting the bots that exist at the instant of the trip is a broadcast,
 *     not a switch, because the next bot created anywhere would trade straight
 *     back into the emergency;
 *   - the latch is written BEFORE any bot is halted, so a crash mid-sweep
 *     leaves everything latched with some bots still running (the next sweep
 *     fixes it) rather than bots halted while creation is still open;
 *   - the halt goes through each bot's OWN existing halt path via an injected
 *     `haltBot` port (step 7, decision 8), so this module knows nothing about
 *     Durable Object bindings and stays testable without a namespace;
 *   - a reset is human-only and refuses `system`/`ci`/`cron`/`reconciliation`.
 *
 * Different, and this is the whole point of it being a separate control:
 *
 *   - it has its OWN record (`global_kill_switch`, one row), so tripping or
 *     resetting it touches no `circuit_breakers` row and vice versa. The two
 *     latches are independent: a bot can create or resume only when BOTH are
 *     armed, which is why `BotInstance.create`/`.resume` assert both;
 *   - it sweeps EVERY account, not one. There is no `account_label` anywhere in
 *     this file;
 *   - a trip requires a HUMAN actor. The account breaker is trippable by
 *     `reconciliation` (section 9's severe tier); section 7.4 frames the kill
 *     switch as a manual dashboard control for a genuine emergency, with no
 *     automated trigger, so a trip always names a person. (Revisitable: if a
 *     future automated global-safety trigger is ever specified, relax this.)
 */

import { NON_HUMAN_ACTORS } from "../capital";
import type { Database } from "../db/database";
import type { AlertRow, AuditLogRow, BotInstanceRow, GlobalKillSwitchRow } from "../db/schema";
import { emergencySweepOrder, SWEPT_STATUSES, type HaltBotPort } from "./circuit-breaker";

/** The single row always lives at this id (migration 0005 pins it with CHECK). */
const SINGLETON_ID = 1;

export type GlobalKillSwitchErrorCode =
  /** An action was attempted while the global kill switch is tripped. */
  | "globally_tripped"
  /** A trip or reset was attempted by a non-human actor. */
  | "requires_human_actor"
  /** A trip or reset was attempted without saying why. */
  | "requires_reason"
  /** A reset was attempted while the switch was not tripped. */
  | "not_tripped";

export class GlobalKillSwitchError extends Error {
  readonly code: GlobalKillSwitchErrorCode;

  constructor(code: GlobalKillSwitchErrorCode, message: string) {
    super(message);
    this.name = "GlobalKillSwitchError";
    this.code = code;
  }
}

/** Statuses whose bots are still capable of trading and so must be halted. */
/**
 * What the switch reports as still capable of trading, for the dashboard's
 * "this will halt N bots" preview. NARROW on purpose -- see the same constant
 * in `circuit-breaker.ts` for why the sweep's own set is a different one.
 */
const ACTIVE_STATUSES = ["created", "running"] as const;

export interface GlobalTripRequest {
  /** Prose, for the human deciding whether to reset. Ends up in the alert. */
  readonly reason: string;
  /** An authenticated email. Automated actors are refused (see the header). */
  readonly actor: string;
  readonly now: number;
  readonly haltBot: HaltBotPort;
  readonly newId: () => string;
}

export interface GlobalTripResult {
  /** False when the switch was already tripped by an earlier call. */
  readonly newlyTripped: boolean;
  /**
   * Bots this call actually stopped, across every account. Unchanged in meaning
   * by the halted-bot sweep -- see `TripResult.haltedBotIds`.
   */
  readonly haltedBotIds: readonly string[];
  /** Bots the sweep visited and found ALREADY halted. */
  readonly alreadyHaltedBotIds: readonly string[];
  /**
   * Bots this call tried and failed to halt, with the failure. Non-empty is not
   * a reason to abort: a kill switch that stops at the first unreachable bot
   * leaves the rest trading. They are reported so the caller can alert, and a
   * repeat call sweeps them again.
   */
  readonly failures: readonly { readonly botInstanceId: string; readonly message: string }[];
}

/** The row, or null if the switch has never been pulled. */
export async function readGlobalKillSwitch(db: Database): Promise<GlobalKillSwitchRow | null> {
  return await db.globalKillSwitch.findOne({ id: SINGLETON_ID });
}

/**
 * Is the global kill switch pulled?
 *
 * A missing row means never pulled, which is armed -- so nothing has to seed a
 * row for the system to work.
 */
export async function isGloballyTripped(db: Database): Promise<boolean> {
  const row = await readGlobalKillSwitch(db);
  return row !== null && row.state === "tripped";
}

/**
 * Refuse an action while the switch is pulled.
 *
 * Called by `BotInstance.create` and `BotInstance.resume` ALONGSIDE
 * `assertAccountArmed`. Both latches gate the two ways a bot could start
 * trading again; blocking on either is what makes the global switch mean
 * something independently of any account's breaker.
 */
export async function assertGlobalArmed(db: Database, action: string): Promise<void> {
  const row = await readGlobalKillSwitch(db);
  if (row === null || row.state !== "tripped") return;
  throw new GlobalKillSwitchError(
    "globally_tripped",
    `cannot ${action}: the global kill switch is pulled ` +
      `(${row.reason ?? "no reason recorded"}). It was pulled at ${row.tripped_at} by ` +
      `${row.tripped_by ?? "unknown"} and stays latched until a human resets it with ` +
      `resetGlobalKillSwitch. This is separate from every account's circuit breaker; ` +
      `both must be armed before any bot anywhere can create or resume. Section 7.4.`,
  );
}

/**
 * Pull the global kill switch and halt every bot on every account.
 *
 * Idempotent, and deliberately not a no-op when already tripped: if an earlier
 * pull failed to halt some bot, a repeat sweeps again and halts it. Only the
 * state write and the critical alert are suppressed on a repeat.
 *
 * ORDERING: the latch is written BEFORE any bot is halted (see the header).
 */
export async function tripGlobalKillSwitch(
  db: Database,
  request: GlobalTripRequest,
): Promise<GlobalTripResult> {
  const { reason, actor, now, haltBot, newId } = request;

  const trimmedActor = actor.trim();
  if (trimmedActor === "" || NON_HUMAN_ACTORS.includes(trimmedActor)) {
    throw new GlobalKillSwitchError(
      "requires_human_actor",
      `pulling the global kill switch requires a human actor, got ${JSON.stringify(actor)}. ` +
        `Section 7.4 is a manual dashboard control for a genuine emergency; there is no ` +
        `automated trigger for it.`,
    );
  }
  if (reason.trim() === "") {
    throw new GlobalKillSwitchError(
      "requires_reason",
      `pulling the global kill switch requires a reason recording the emergency. It is what ` +
        `the human deciding whether to reset reads.`,
    );
  }

  const newlyTripped = await latch(db, reason.trim(), trimmedActor, now);

  // Sweep every bot still capable of trading, across EVERY account. Read AFTER
  // the latch is written, so a bot created in the gap is either blocked by
  // `assertGlobalArmed` or already visible here.
  // `SWEPT_STATUSES`, not `ACTIVE_STATUSES`: `halted` is swept too, because D1's
  // status is a mirror and a bot whose row says `halted` can be internally
  // running (tonight's `bot-gvtr1a`). An emergency stop must not depend on the
  // mirror being right. `emergencySweepOrder` keeps the bots D1 believes are
  // live at the front, so the insurance never delays the real work.
  const bots = emergencySweepOrder(
    await db.botInstances.findMany({
      where: { status: { in: [...SWEPT_STATUSES] } },
    }),
  );

  const haltedBotIds: string[] = [];
  const alreadyHaltedBotIds: string[] = [];
  const failures: { botInstanceId: string; message: string }[] = [];

  for (const bot of bots) {
    try {
      const outcome = await haltBot(bot.id, `global kill switch pulled: ${reason.trim()}`);
      if (outcome === "already_halted") alreadyHaltedBotIds.push(bot.id);
      else haltedBotIds.push(bot.id);
    } catch (error) {
      // Does not rethrow: one unreachable bot must not leave the rest running.
      failures.push({
        botInstanceId: bot.id,
        message: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      });
    }
  }

  if (newlyTripped) {
    const alert: AlertRow = {
      id: newId(),
      severity: "critical",
      category: "trading",
      alert_type: "global_kill_switch_tripped",
      // Spans every account, so it belongs to no single bot.
      bot_instance_id: null,
      source: "dashboard",
      message:
        `GLOBAL KILL SWITCH PULLED by ${trimmedActor}: ${reason.trim()}. ` +
        `Halted ${haltedBotIds.length} bot(s) across every account` +
        (failures.length > 0
          ? `; FAILED to halt ${failures.length}: ${failures
              .map((failure) => `${failure.botInstanceId} (${failure.message})`)
              .join(", ")}`
          : "") +
        `. No bot on any account can be created or resumed until a human resets it.`,
      resolved: false,
      created_at: now,
      notified_at: null,
    };
    await db.alerts.insert(alert);
  }

  const audit: AuditLogRow = {
    id: newId(),
    actor: trimmedActor,
    action: newlyTripped ? "kill_switch.tripped" : "kill_switch.swept",
    // Spans every account, so it names no single bot.
    target_bot_instance_id: null,
    details_json: {
      reason: reason.trim(),
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
 * Write the latch. Returns whether THIS call was the one that pulled it.
 *
 * Conditional on the current state so two concurrent pulls cannot both report
 * `newlyTripped` and therefore cannot both raise a critical alert for one
 * event. An insert that loses a race to the PRIMARY KEY is caught and falls
 * through to the conditional update -- the same compare-and-swap shape as the
 * account breaker's `latch`.
 */
async function latch(db: Database, reason: string, actor: string, now: number): Promise<boolean> {
  const existing = await readGlobalKillSwitch(db);

  if (existing === null) {
    const row: GlobalKillSwitchRow = {
      id: SINGLETON_ID,
      state: "tripped",
      reason,
      tripped_at: now,
      tripped_by: actor,
      reset_at: null,
      reset_by: null,
      updated_at: now,
    };
    try {
      await db.globalKillSwitch.insert(row);
      return true;
    } catch {
      const changes = await db.globalKillSwitch.update(
        { id: SINGLETON_ID, state: "armed" },
        { state: "tripped", reason, tripped_at: now, tripped_by: actor, updated_at: now },
      );
      return changes === 1;
    }
  }

  if (existing.state === "tripped") return false;

  const changes = await db.globalKillSwitch.update(
    { id: SINGLETON_ID, state: "armed" },
    { state: "tripped", reason, tripped_at: now, tripped_by: actor, updated_at: now },
  );
  return changes === 1;
}

export interface GlobalResetRequest {
  /** An authenticated email. Automated actors are refused. */
  readonly actor: string;
  /** Why it is safe to re-arm. Required, and stored in `audit_log`. */
  readonly note: string;
  readonly now: number;
  readonly newId: () => string;
}

/**
 * Re-arm the global kill switch. Human action only, distinct from resetting any
 * account's circuit breaker.
 *
 * Refuses `system`, `ci`, `cron` and `reconciliation` -- the same list the
 * account breaker's reset uses, imported rather than re-declared so the two
 * cannot drift. Re-arming does NOT resume any bot and does NOT touch any
 * account breaker: every bot halted by the pull stays halted until someone
 * resumes it individually (section 7.2 step 5), and an account whose own
 * breaker is tripped stays blocked until that too is reset.
 */
export async function resetGlobalKillSwitch(db: Database, request: GlobalResetRequest): Promise<void> {
  const { now, newId } = request;
  const actor = request.actor.trim();
  const note = request.note.trim();

  if (actor === "" || NON_HUMAN_ACTORS.includes(actor)) {
    throw new GlobalKillSwitchError(
      "requires_human_actor",
      `resetting the global kill switch requires a human actor, got ${JSON.stringify(request.actor)}. ` +
        `An automated reset would defeat the one control that exists for a genuine emergency.`,
    );
  }
  if (note === "") {
    throw new GlobalKillSwitchError(
      "requires_reason",
      `resetting the global kill switch requires a note recording what was resolved and why it is ` +
        `safe to re-arm. It is the only record of that reasoning.`,
    );
  }

  const changes = await db.globalKillSwitch.update(
    { id: SINGLETON_ID, state: "tripped" },
    { state: "armed", reset_at: now, reset_by: actor, updated_at: now },
  );

  if (changes !== 1) {
    throw new GlobalKillSwitchError(
      "not_tripped",
      `the global kill switch is not pulled, so there is nothing to reset.`,
    );
  }

  const audit: AuditLogRow = {
    id: newId(),
    actor,
    action: "kill_switch.reset",
    target_bot_instance_id: null,
    details_json: { note },
    created_at: now,
  };
  await db.auditLog.insert(audit);

  const alert: AlertRow = {
    id: newId(),
    severity: "info",
    category: "trading",
    alert_type: "global_kill_switch_reset",
    bot_instance_id: null,
    source: "dashboard",
    message:
      `Global kill switch re-armed by ${actor}: ${note}. Bots halted by the pull remain halted and ` +
      `must each be resumed explicitly, and any account whose own circuit breaker is tripped stays ` +
      `blocked until that too is reset.`,
    resolved: false,
    created_at: now,
    notified_at: null,
  };
  await db.alerts.insert(alert);
}

/** Every bot the switch would halt right now, across all accounts. For the dashboard. */
export async function activeBotsEverywhere(db: Database): Promise<BotInstanceRow[]> {
  return await db.botInstances.findMany({ where: { status: { in: [...ACTIVE_STATUSES] } } });
}
