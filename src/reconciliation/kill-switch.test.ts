/**
 * The global kill switch module (spec section 7.4), build step 10.3.
 *
 * Real D1 in the Workers runtime, per section 14. The halt itself is an
 * injected port (step 7, decision 8), so this file drives the module's own
 * logic -- the latch, the cross-account sweep, the human-actor guards, the
 * independence from account breakers -- with a recording fake, and the real
 * Durable Object halt is exercised end to end in
 * `../durable-objects/global-kill-switch.test.ts`.
 */

import { beforeEach, describe, expect, it } from "vitest";
import type { Database } from "../db/database";
import { botInstanceRow, freshDatabase } from "../db/test-helpers";
import {
  assertGlobalArmed,
  GlobalKillSwitchError,
  isGloballyTripped,
  readGlobalKillSwitch,
  resetGlobalKillSwitch,
  tripGlobalKillSwitch,
} from "./kill-switch";
import { resetAccountCircuitBreaker, tripAccountCircuitBreaker } from "./circuit-breaker";

const T0 = 1_760_000_000_000;
const HUMAN = "owner@example.com";

let db: Database;
let halted: string[];
let idCounter: number;

/** A recording halt port; the account breaker's tests use the same shape. */
function recordingHalt() {
  return async (botInstanceId: string): Promise<void> => {
    halted.push(botInstanceId);
  };
}

function newId(): string {
  idCounter += 1;
  return `id-${idCounter}`;
}

async function insertBot(id: string, accountLabel: string, status: string, extra = {}): Promise<void> {
  await db.botInstances.insert(
    botInstanceRow({
      id,
      account_label: accountLabel,
      status: status as never,
      // A halted row must carry a reason (migration 0001 CHECK).
      halt_reason: status === "halted" ? "pre-existing" : null,
      halted_at: status === "halted" ? T0 : null,
      ...extra,
    }),
  );
}

beforeEach(async () => {
  db = await freshDatabase();
  halted = [];
  idCounter = 0;
});

// ---------------------------------------------------------------------------

describe("tripping the switch", () => {
  it("halts every active bot across every account and latches", async () => {
    await insertBot("a1", "acct-a", "running");
    await insertBot("a2", "acct-a", "created");
    await insertBot("b1", "acct-b", "running");
    // Neither of these is swept: a stopped bot is closed, a halted bot is
    // already stopped from trading.
    await insertBot("a3", "acct-a", "stopped");
    await insertBot("b2", "acct-b", "halted");

    const result = await tripGlobalKillSwitch(db, {
      reason: "suspected key compromise, everything down",
      actor: HUMAN,
      now: T0,
      haltBot: recordingHalt(),
      newId,
    });

    expect(result.newlyTripped).toBe(true);
    // Both accounts, only the active bots.
    expect(halted.sort()).toEqual(["a1", "a2", "b1"]);
    expect(result.haltedBotIds.slice().sort()).toEqual(["a1", "a2", "b1"]);

    // The latch is real and its own record.
    expect(await isGloballyTripped(db)).toBe(true);
    const row = await readGlobalKillSwitch(db);
    expect(row!.state).toBe("tripped");
    expect(row!.tripped_by).toBe(HUMAN);

    // A critical alert and an audit entry, both account-less.
    const alerts = await db.alerts.findMany({ where: { alert_type: "global_kill_switch_tripped" } });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.severity).toBe("critical");
    expect(alerts[0]!.bot_instance_id).toBeNull();
    const audit = await db.auditLog.findMany({ where: { action: "kill_switch.tripped" } });
    expect(audit).toHaveLength(1);
  });

  it("is idempotent: a repeat re-sweeps but does not re-latch or re-alert", async () => {
    await insertBot("a1", "acct-a", "running");
    await tripGlobalKillSwitch(db, { reason: "first", actor: HUMAN, now: T0, haltBot: recordingHalt(), newId });

    halted = [];
    const again = await tripGlobalKillSwitch(db, {
      reason: "second sweep", actor: HUMAN, now: T0 + 1, haltBot: recordingHalt(), newId,
    });

    expect(again.newlyTripped).toBe(false);
    expect(halted).toEqual(["a1"]); // still swept, so a bot missed the first time is caught
    // Only one critical alert for the one event.
    const alerts = await db.alerts.findMany({ where: { alert_type: "global_kill_switch_tripped" } });
    expect(alerts).toHaveLength(1);
  });

  it("reports a bot it could not halt without aborting the rest", async () => {
    await insertBot("a1", "acct-a", "running");
    await insertBot("a2", "acct-a", "running");

    const result = await tripGlobalKillSwitch(db, {
      reason: "emergency",
      actor: HUMAN,
      now: T0,
      haltBot: async (id: string) => {
        if (id === "a1") throw new Error("unreachable");
        halted.push(id);
      },
      newId,
    });

    expect(result.failures.map((f) => f.botInstanceId)).toEqual(["a1"]);
    expect(halted).toEqual(["a2"]); // the other bot was still halted
    expect(await isGloballyTripped(db)).toBe(true);
  });

  it("refuses a non-human actor and an empty reason", async () => {
    await expect(
      tripGlobalKillSwitch(db, { reason: "x", actor: "reconciliation", now: T0, haltBot: recordingHalt(), newId }),
    ).rejects.toMatchObject({ code: "requires_human_actor" });

    await expect(
      tripGlobalKillSwitch(db, { reason: "   ", actor: HUMAN, now: T0, haltBot: recordingHalt(), newId }),
    ).rejects.toMatchObject({ code: "requires_reason" });

    // Neither attempt latched anything.
    expect(await isGloballyTripped(db)).toBe(false);
  });
});

describe("assertGlobalArmed", () => {
  it("passes when never tripped, throws when tripped", async () => {
    await assertGlobalArmed(db, "create bot x"); // absent row -> armed, no throw

    await tripGlobalKillSwitch(db, { reason: "down", actor: HUMAN, now: T0, haltBot: recordingHalt(), newId });
    await expect(assertGlobalArmed(db, "create bot x")).rejects.toBeInstanceOf(GlobalKillSwitchError);
  });
});

describe("resetting the switch", () => {
  it("re-arms only for a human with a note, and is distinct from an account reset", async () => {
    await tripGlobalKillSwitch(db, { reason: "down", actor: HUMAN, now: T0, haltBot: recordingHalt(), newId });

    await expect(
      resetGlobalKillSwitch(db, { actor: "cron", note: "ok", now: T0, newId }),
    ).rejects.toMatchObject({ code: "requires_human_actor" });
    await expect(
      resetGlobalKillSwitch(db, { actor: HUMAN, note: "  ", now: T0, newId }),
    ).rejects.toMatchObject({ code: "requires_reason" });

    await resetGlobalKillSwitch(db, { actor: HUMAN, note: "investigated, keys rotated", now: T0 + 5, newId });
    expect(await isGloballyTripped(db)).toBe(false);
    const row = await readGlobalKillSwitch(db);
    expect(row!.reset_by).toBe(HUMAN);
    const alerts = await db.alerts.findMany({ where: { alert_type: "global_kill_switch_reset" } });
    expect(alerts[0]!.severity).toBe("info");
  });

  it("errors when nothing is tripped", async () => {
    await expect(
      resetGlobalKillSwitch(db, { actor: HUMAN, note: "n", now: T0, newId }),
    ).rejects.toMatchObject({ code: "not_tripped" });
  });
});

describe("independence from the account-wide circuit breaker", () => {
  it("a global trip touches no circuit_breakers row, and the two reset separately", async () => {
    await insertBot("a1", "acct-a", "running");

    // Trip both, independently.
    await tripGlobalKillSwitch(db, { reason: "global", actor: HUMAN, now: T0, haltBot: recordingHalt(), newId });
    await tripAccountCircuitBreaker(db, {
      accountLabel: "acct-a", reason: "account", runId: null, actor: HUMAN, now: T0,
      haltBot: async () => undefined, newId,
    });

    // Global trip wrote no account breaker row of its own.
    const breaker = await db.circuitBreakers.findOne({ account_label: "acct-a" });
    expect(breaker!.reason).toBe("account"); // only the explicit account trip is here

    // Resetting the account breaker leaves the global switch pulled.
    await resetAccountCircuitBreaker(db, { accountLabel: "acct-a", actor: HUMAN, note: "acct ok", now: T0 + 1, newId });
    expect(await isGloballyTripped(db)).toBe(true);

    // Resetting the global switch leaves the (already-reset) account breaker
    // untouched -- and if the account were still tripped, it would stay so.
    await resetGlobalKillSwitch(db, { actor: HUMAN, note: "global ok", now: T0 + 2, newId });
    expect(await isGloballyTripped(db)).toBe(false);
    const breakerAfter = await db.circuitBreakers.findOne({ account_label: "acct-a" });
    expect(breakerAfter!.state).toBe("armed"); // unchanged by the global reset
  });
});
