/**
 * The notification dispatcher (section 10, step 8).
 *
 * Real D1 (per section 14), a recording mock notifier, and the in-memory
 * cooldown store so throttling is driven entirely by the injected clock. The
 * cooldown's own KV wiring is covered in cooldown.test.ts; here the store is a
 * deterministic double so the dispatcher's decisions are what is under test.
 *
 * The two things this file must establish, beyond the dispatcher's mechanics:
 *   - every alert type written anywhere in the codebase results in a
 *     notification attempt when unthrottled (the "no path left in isolation"
 *     requirement); and
 *   - an alert written by a REAL writer -- the circuit breaker -- is picked up,
 *     proving the write-then-dispatch wiring end to end, not just synthesized
 *     rows.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { freshDatabase, alertRow, botInstanceRow } from "../db/test-helpers";
import type { AlertRow, Database } from "../db";
import { tripAccountCircuitBreaker } from "../reconciliation/circuit-breaker";
import { InMemoryCooldownStore } from "./cooldown";
import { dispatchPendingAlerts } from "./dispatch";
import type { AlertNotifier, NotifiableAlert, NotifyResult } from "./notifier";

const T0 = 1_760_000_000_000;
const WINDOW = 15 * 60_000;

/** Records every alert it is asked to send; its result is configurable. */
class RecordingNotifier implements AlertNotifier {
  readonly sent: NotifiableAlert[] = [];
  result: NotifyResult = { delivered: true };
  throwOnce = false;

  async send(alert: NotifiableAlert): Promise<NotifyResult> {
    if (this.throwOnce) {
      this.throwOnce = false;
      throw new Error("provider blew up");
    }
    this.sent.push(alert);
    return this.result;
  }

  get types(): string[] {
    return this.sent.map((a) => a.alertType);
  }
}

let db: Database;
let notifier: RecordingNotifier;
let cooldown: InMemoryCooldownStore;
let clock: number;
let idSeq: number;

beforeEach(async () => {
  db = await freshDatabase();
  notifier = new RecordingNotifier();
  cooldown = new InMemoryCooldownStore();
  clock = T0;
  idSeq = 0;
  // `alerts.bot_instance_id` has a foreign key to `bot_instances`, so any bot a
  // test attributes an alert to must exist. The per-bot cooldown tests use
  // `bot-1` and `bot-2`; account-wide tests use a null bot and need no seed.
  await db.botInstances.insert(botInstanceRow({ id: "bot-1", account_label: "main" }));
  await db.botInstances.insert(botInstanceRow({ id: "bot-2", account_label: "main" }));
});

async function insert(overrides: Partial<AlertRow>): Promise<void> {
  idSeq += 1;
  await db.alerts.insert(alertRow({ id: `a${idSeq}`, created_at: T0, ...overrides }));
}

function dispatch(options: { limit?: number } = {}) {
  return dispatchPendingAlerts({
    db,
    notifier,
    cooldown,
    now: () => clock,
    windowMs: WINDOW,
    ...(options.limit !== undefined ? { limit: options.limit } : {}),
  });
}

describe("dispatching one alert", () => {
  it("sends it, marks it processed, and advances the cooldown", async () => {
    await insert({ id: "a1", alert_type: "halt_stop_loss", bot_instance_id: "bot-1" });

    const result = await dispatch();

    expect(result).toMatchObject({ scanned: 1, sent: 1, throttled: 0, failed: 0 });
    expect(notifier.types).toEqual(["halt_stop_loss"]);
    // Marked processed in D1.
    expect((await db.alerts.findOne({ id: "a1" }))!.notified_at).toBe(clock);
    // Cooldown advanced for this (type, bot).
    expect(await cooldown.lastSentAt("cooldown:halt_stop_loss:bot-1")).toBe(clock);
  });

  it("maps the row onto a storage-free NotifiableAlert", async () => {
    await insert({
      id: "a1",
      severity: "info",
      category: "system",
      alert_type: "orphaned_bot_row",
      bot_instance_id: null,
      source: "reconciliation",
      message: "a bot row with no object",
      created_at: T0,
    });
    await dispatch();
    expect(notifier.sent[0]).toEqual({
      id: "a1",
      severity: "info",
      category: "system",
      alertType: "orphaned_bot_row",
      botInstanceId: null,
      source: "reconciliation",
      message: "a bot row with no object",
      createdAt: T0,
    });
  });

  it("ignores rows already processed (notified_at set)", async () => {
    await insert({ id: "a1", alert_type: "take_profit", notified_at: T0 - 1 });
    const result = await dispatch();
    expect(result.scanned).toBe(0);
    expect(notifier.sent).toHaveLength(0);
  });
});

describe("cooldown (section 10: per alert type, per bot instance)", () => {
  it("throttles a second alert of the same type on the same bot within the window", async () => {
    await insert({ id: "a1", alert_type: "order_throttled", bot_instance_id: "bot-1", created_at: T0 });
    await insert({ id: "a2", alert_type: "order_throttled", bot_instance_id: "bot-1", created_at: T0 + 1 });

    const result = await dispatch();

    expect(result).toMatchObject({ sent: 1, throttled: 1 });
    // The earliest of the burst is the one that sent.
    expect(notifier.sent.map((a) => a.id)).toEqual(["a1"]);
    // Both are marked processed -- the throttled one is a completed decision,
    // not a pending retry.
    expect((await db.alerts.findOne({ id: "a1" }))!.notified_at).toBe(clock);
    expect((await db.alerts.findOne({ id: "a2" }))!.notified_at).toBe(clock);
  });

  it("does not throttle the same type on a different bot", async () => {
    await insert({ id: "a1", alert_type: "halt_stop_loss", bot_instance_id: "bot-1" });
    await insert({ id: "a2", alert_type: "halt_stop_loss", bot_instance_id: "bot-2" });
    const result = await dispatch();
    expect(result).toMatchObject({ sent: 2, throttled: 0 });
  });

  it("buckets account-wide (null bot) alerts of one type together", async () => {
    await insert({ id: "a1", alert_type: "circuit_breaker_tripped", bot_instance_id: null, created_at: T0 });
    await insert({ id: "a2", alert_type: "circuit_breaker_tripped", bot_instance_id: null, created_at: T0 + 1 });
    const result = await dispatch();
    expect(result).toMatchObject({ sent: 1, throttled: 1 });
  });

  it("sends again once the window has elapsed", async () => {
    await insert({ id: "a1", alert_type: "take_profit", bot_instance_id: "bot-1" });
    await dispatch();
    expect(notifier.sent).toHaveLength(1);

    await insert({ id: "a2", alert_type: "take_profit", bot_instance_id: "bot-1" });
    clock = T0 + WINDOW; // exactly the window: no longer < window, so it sends
    await dispatch();
    expect(notifier.sent.map((a) => a.id)).toEqual(["a1", "a2"]);
  });

  it("still throttles just inside the window", async () => {
    await insert({ id: "a1", alert_type: "take_profit", bot_instance_id: "bot-1" });
    await dispatch();
    await insert({ id: "a2", alert_type: "take_profit", bot_instance_id: "bot-1" });
    clock = T0 + WINDOW - 1;
    const result = await dispatch();
    expect(result.throttled).toBe(1);
    expect(notifier.sent).toHaveLength(1);
  });
});

describe("failed sends are retried, not lost", () => {
  it("leaves a failed row unmarked and does not advance the cooldown", async () => {
    notifier.result = { delivered: false, reason: "Discord 503" };
    await insert({ id: "a1", alert_type: "halt_stop_loss", bot_instance_id: "bot-1" });

    const result = await dispatch();

    expect(result).toMatchObject({ sent: 0, failed: 1 });
    expect(result.failures[0]).toMatchObject({ id: "a1", reason: "Discord 503" });
    // Not marked -> the next run finds it again.
    expect((await db.alerts.findOne({ id: "a1" }))!.notified_at).toBeNull();
    // Cooldown NOT advanced, so the retry is not itself throttled.
    expect(await cooldown.lastSentAt("cooldown:halt_stop_loss:bot-1")).toBeNull();

    // Next run succeeds.
    notifier.result = { delivered: true };
    const retry = await dispatch();
    expect(retry).toMatchObject({ sent: 1, failed: 0 });
    expect((await db.alerts.findOne({ id: "a1" }))!.notified_at).toBe(clock);
  });

  it("treats a thrown provider as an ordinary failed delivery", async () => {
    notifier.throwOnce = true;
    await insert({ id: "a1", alert_type: "take_profit", bot_instance_id: "bot-1" });
    const result = await dispatch();
    expect(result).toMatchObject({ sent: 0, failed: 1 });
    expect(result.failures[0]!.reason).toContain("provider blew up");
    expect((await db.alerts.findOne({ id: "a1" }))!.notified_at).toBeNull();
  });

  it("one failing row does not stop the others", async () => {
    await insert({ id: "a1", alert_type: "take_profit", bot_instance_id: "bot-1" });
    await insert({ id: "a2", alert_type: "halt_stop_loss", bot_instance_id: "bot-2" });
    notifier.throwOnce = true; // fails a1 only
    const result = await dispatch();
    expect(result).toMatchObject({ sent: 1, failed: 1 });
    expect(notifier.types).toEqual(["halt_stop_loss"]);
  });
});

describe("ordering and bounds", () => {
  it("respects the scan limit and leaves the rest for the next run", async () => {
    for (let i = 0; i < 5; i++) {
      await insert({ id: `a${i}`, alert_type: `type_${i}`, bot_instance_id: "bot-1", created_at: T0 + i });
    }
    const result = await dispatch({ limit: 2 });
    expect(result.scanned).toBe(2);
    expect(result.sent).toBe(2);
    // Oldest first.
    expect(notifier.sent.map((a) => a.id)).toEqual(["a0", "a1"]);
  });
});

// ---------------------------------------------------------------------------
// Coverage: every alert type the codebase writes, notified when unthrottled.
// ---------------------------------------------------------------------------

/**
 * Every distinct alert_type any writer in the codebase produces, compiled from
 * a sweep of every `alerts.insert` / `#alert` call:
 *   - the BotInstance Durable Object (src/durable-objects/bot-instance.ts),
 *     including `halt_${reason}` for every DcaHaltReason and GridHaltReason;
 *   - reconciliation (src/reconciliation/reconcile.ts), including
 *     `reconciliation_{severe,meaningful}_${FindingKind}`;
 *   - the circuit breaker (src/reconciliation/circuit-breaker.ts).
 *
 * If a new alert type is added anywhere without a ping going out, that is a
 * bug this list is meant to catch -- but the real guarantee is structural: the
 * dispatcher reads the alerts table and is type-agnostic, so every writer that
 * inserts a row (with notified_at NULL, which they all now do) is covered.
 */
const EVERY_ALERT_TYPE: readonly string[] = [
  // BotInstance, fixed types
  "order_throttled",
  "unknown_order_fill",
  "order_not_constructible",
  "exit_order_throttled",
  "take_profit",
  "order_state_drift",
  "liquidation_not_constructible",
  "liquidation_unresolved",
  "liquidation_failed",
  "cancel_failed",
  "cancel_fill_discrepancy",
  // BotInstance, halt_${reason} for every reason (dca + grid)
  "halt_stop_loss",
  "halt_unhandled_error",
  "halt_order_rejected",
  "halt_take_profit_reached",
  "halt_manual",
  "halt_take_profit",
  "halt_breakout_take_profit",
  // Reconciliation
  "orphaned_bot_row",
  "reconciliation_halt_failed",
  "reconciliation_severe_unknown_order_fill",
  "reconciliation_severe_balance_drift",
  "reconciliation_meaningful_order_state_drift",
  "reconciliation_meaningful_ledger_allocation_drift",
  // Circuit breaker
  "circuit_breaker_tripped",
  "circuit_breaker_reset",
];

describe("every alert type in the codebase notifies", () => {
  it("attempts a notification for each known alert type", async () => {
    for (const [i, alertType] of EVERY_ALERT_TYPE.entries()) {
      // Null bot avoids seeding 26 bot_instances rows for the FK; the types are
      // all distinct, so every cooldown key is distinct and nothing throttles.
      await insert({ id: `t${i}`, alert_type: alertType, bot_instance_id: null });
    }

    const result = await dispatch({ limit: EVERY_ALERT_TYPE.length });

    expect(result.sent).toBe(EVERY_ALERT_TYPE.length);
    expect(result.throttled).toBe(0);
    expect(result.failed).toBe(0);
    expect(new Set(notifier.types)).toEqual(new Set(EVERY_ALERT_TYPE));
  });
});

describe("a real writer's alert is picked up (end to end)", () => {
  it("delivers an alert written by the circuit breaker", async () => {
    // Drive the actual section 7.3/9 writer, not a synthesized row. It inserts
    // a `circuit_breaker_tripped` alert with notified_at NULL, exactly as it
    // does in production.
    await tripAccountCircuitBreaker(db, {
      accountLabel: "main",
      reason: "severe reconciliation drift (test)",
      runId: "run-1",
      actor: "reconciliation",
      now: T0,
      haltBot: async () => undefined,
      newId: (() => {
        let n = 0;
        return () => `cb-${(n += 1)}`;
      })(),
    });

    // Confirm the writer really produced a dispatcher-visible row.
    const written = await db.alerts.findMany({
      where: { alert_type: "circuit_breaker_tripped" },
    });
    expect(written).toHaveLength(1);
    expect(written[0]!.notified_at).toBeNull();

    const result = await dispatch();

    expect(result.sent).toBe(1);
    expect(notifier.types).toEqual(["circuit_breaker_tripped"]);
    expect(notifier.sent[0]!.category).toBe("trading");
    expect((await db.alerts.findOne({ id: written[0]!.id }))!.notified_at).toBe(clock);
  });
});
