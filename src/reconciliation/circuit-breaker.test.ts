/**
 * The account-wide circuit breaker (spec sections 7.3 and 9), against real D1.
 *
 * Section 14: these run inside the Workers runtime against the real (local) D1
 * database built from the migration files, so migration 0003's constraints are
 * part of what is under test -- not a hand-written copy of them.
 */

import { beforeEach, describe, expect, it } from "vitest";

import {
  activeBotsOnAccount,
  assertAccountArmed,
  CircuitBreakerError,
  isAccountTripped,
  readCircuitBreaker,
  resetAccountCircuitBreaker,
  tripAccountCircuitBreaker,
} from "./circuit-breaker";
import type { Database } from "../db/database";
import { botInstanceRow, freshDatabase } from "../db/test-helpers";

let db: Database;
let ids = 0;
const newId = (): string => `id-${(ids += 1)}`;
const T0 = 1_770_000_000_000;

beforeEach(async () => {
  db = await freshDatabase();
  ids = 0;
});

/** Two running bots on `main` and one on a different account. */
async function seedBots(): Promise<void> {
  await db.botInstances.insert(botInstanceRow({ id: "dca-btc-1", status: "running" }));
  await db.botInstances.insert(botInstanceRow({ id: "dca-eth-1", status: "running" }));
  await db.botInstances.insert(
    botInstanceRow({ id: "other-1", account_label: "secondary", status: "running" }),
  );
}

function recordingHalt(): { halted: string[]; port: (id: string, detail: string) => Promise<void> } {
  const halted: string[] = [];
  return {
    halted,
    port: async (id) => {
      halted.push(id);
    },
  };
}

describe("an account with no row", () => {
  it("is armed, so nothing has to seed a row first", async () => {
    expect(await readCircuitBreaker(db, "main")).toBeNull();
    expect(await isAccountTripped(db, "main")).toBe(false);
    await expect(assertAccountArmed(db, "main", "create a bot")).resolves.toBeUndefined();
  });
});

describe("tripping", () => {
  it("latches the account and halts every bot on it, and only on it", async () => {
    await seedBots();
    const halt = recordingHalt();

    const result = await tripAccountCircuitBreaker(db, {
      accountLabel: "main",
      reason: "unexplained balance change",
      runId: "run-1",
      actor: "reconciliation",
      now: T0,
      haltBot: halt.port,
      newId,
    });

    expect(result.newlyTripped).toBe(true);
    expect([...result.haltedBotIds].sort()).toEqual(["dca-btc-1", "dca-eth-1"]);
    // The bot on `secondary` must be untouched: section 7.3's breaker is per
    // exchange account, not global. The global one is section 7.4.
    expect(halt.halted).not.toContain("other-1");

    const row = await readCircuitBreaker(db, "main");
    expect(row?.state).toBe("tripped");
    expect(row?.reason).toBe("unexplained balance change");
    expect(row?.run_id).toBe("run-1");
    expect(row?.tripped_by).toBe("reconciliation");
    expect(row?.tripped_at).toBe(T0);
  });

  it("writes exactly one critical alert and one audit entry", async () => {
    await seedBots();
    await tripAccountCircuitBreaker(db, {
      accountLabel: "main",
      reason: "suspected key compromise",
      runId: "run-1",
      actor: "reconciliation",
      now: T0,
      haltBot: recordingHalt().port,
      newId,
    });

    const alerts = await db.alerts.findMany({ where: { alert_type: "circuit_breaker_tripped" } });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.severity).toBe("critical");
    expect(alerts[0]!.category).toBe("trading");
    // Account-wide, so it belongs to no single bot.
    expect(alerts[0]!.bot_instance_id).toBeNull();
    expect(alerts[0]!.message).toContain("suspected key compromise");

    const audits = await db.auditLog.findMany({ where: { action: "circuit_breaker.tripped" } });
    expect(audits).toHaveLength(1);
  });

  it("is idempotent: a second trip does not re-alert", async () => {
    await seedBots();
    const request = {
      accountLabel: "main",
      reason: "unexplained balance change",
      runId: "run-1",
      actor: "reconciliation",
      now: T0,
      haltBot: recordingHalt().port,
      newId,
    };
    await tripAccountCircuitBreaker(db, request);
    const second = await tripAccountCircuitBreaker(db, { ...request, now: T0 + 300_000 });

    expect(second.newlyTripped).toBe(false);
    const alerts = await db.alerts.findMany({ where: { alert_type: "circuit_breaker_tripped" } });
    // A five-minute cron must not produce a critical alert every five minutes
    // for one event.
    expect(alerts).toHaveLength(1);
  });

  it("still sweeps a bot an earlier trip failed to halt", async () => {
    await seedBots();
    // First trip: halting dca-eth-1 fails.
    const failures: string[] = [];
    await tripAccountCircuitBreaker(db, {
      accountLabel: "main",
      reason: "drift",
      runId: "run-1",
      actor: "reconciliation",
      now: T0,
      haltBot: async (id) => {
        if (id === "dca-eth-1") throw new Error("object unreachable");
        failures.push(id);
        await db.botInstances.update(
          { id },
          { status: "halted", halt_reason: "breaker", halted_at: T0, updated_at: T0 },
        );
      },
      newId,
    });

    // dca-eth-1 is still running, so the next sweep must find and halt it.
    const halt = recordingHalt();
    const second = await tripAccountCircuitBreaker(db, {
      accountLabel: "main",
      reason: "drift",
      runId: "run-2",
      actor: "reconciliation",
      now: T0 + 300_000,
      haltBot: halt.port,
      newId,
    });

    expect(second.newlyTripped).toBe(false);
    expect(second.haltedBotIds).toEqual(["dca-eth-1"]);
  });

  it("does not abort the sweep when one bot cannot be halted", async () => {
    await seedBots();
    const result = await tripAccountCircuitBreaker(db, {
      accountLabel: "main",
      reason: "drift",
      runId: "run-1",
      actor: "reconciliation",
      now: T0,
      haltBot: async (id) => {
        if (id === "dca-btc-1") throw new Error("object unreachable");
      },
      newId,
    });

    // One unreachable bot must not leave the other one trading.
    expect(result.haltedBotIds).toEqual(["dca-eth-1"]);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]!.botInstanceId).toBe("dca-btc-1");

    const alerts = await db.alerts.findMany({ where: { alert_type: "circuit_breaker_tripped" } });
    expect(alerts[0]!.message).toContain("FAILED to halt 1");
  });

  it("does not try to halt a stopped bot, whose capital is already released", async () => {
    await db.botInstances.insert(botInstanceRow({ id: "dca-btc-1", status: "stopped" }));
    await db.botInstances.insert(botInstanceRow({ id: "dca-eth-1", status: "running" }));
    const halt = recordingHalt();
    await tripAccountCircuitBreaker(db, {
      accountLabel: "main",
      reason: "drift",
      runId: "run-1",
      actor: "reconciliation",
      now: T0,
      haltBot: halt.port,
      newId,
    });
    expect(halt.halted).toEqual(["dca-eth-1"]);
  });
});

describe("the latch", () => {
  beforeEach(async () => {
    await seedBots();
    await tripAccountCircuitBreaker(db, {
      accountLabel: "main",
      reason: "unexplained balance change",
      runId: "run-1",
      actor: "reconciliation",
      now: T0,
      haltBot: recordingHalt().port,
      newId,
    });
  });

  it("refuses an action on the tripped account, naming why and who tripped it", async () => {
    let error: CircuitBreakerError | null = null;
    try {
      await assertAccountArmed(db, "main", "create bot new-1");
    } catch (caught) {
      error = caught as CircuitBreakerError;
    }
    expect(error).toBeInstanceOf(CircuitBreakerError);
    expect(error!.code).toBe("account_tripped");
    // The message has to be enough for a human at 2am: what tripped it and
    // who to ask.
    expect(error!.message).toContain("unexplained balance change");
    expect(error!.message).toContain("reconciliation");
  });

  it("leaves a different account on the same database alone", async () => {
    await expect(assertAccountArmed(db, "secondary", "create a bot")).resolves.toBeUndefined();
  });
});

describe("resetting", () => {
  beforeEach(async () => {
    await seedBots();
    await tripAccountCircuitBreaker(db, {
      accountLabel: "main",
      reason: "drift",
      runId: "run-1",
      actor: "reconciliation",
      now: T0,
      haltBot: recordingHalt().port,
      newId,
    });
  });

  it("re-arms the account and records who did it and why", async () => {
    await resetAccountCircuitBreaker(db, {
      accountLabel: "main",
      actor: "owner@example.com",
      note: "withdrawal was mine, logged it as a manual adjustment",
      now: T0 + 3_600_000,
      newId,
    });

    const row = await readCircuitBreaker(db, "main");
    expect(row?.state).toBe("armed");
    expect(row?.reset_by).toBe("owner@example.com");
    expect(row?.reset_at).toBe(T0 + 3_600_000);
    // Retained, not nulled: a re-armed account should still show it was tripped.
    expect(row?.reason).toBe("drift");

    await expect(assertAccountArmed(db, "main", "create a bot")).resolves.toBeUndefined();
  });

  it.each(["system", "cron", "ci", "reconciliation"])(
    "refuses %s, because a breaker an automation can reset is not a breaker",
    async (actor) => {
      await expect(
        resetAccountCircuitBreaker(db, {
          accountLabel: "main",
          actor,
          note: "automated recovery",
          now: T0,
          newId,
        }),
      ).rejects.toMatchObject({ code: "reset_requires_human_actor" });

      expect((await readCircuitBreaker(db, "main"))?.state).toBe("tripped");
    },
  );

  it("refuses a reset with no note", async () => {
    await expect(
      resetAccountCircuitBreaker(db, {
        accountLabel: "main",
        actor: "owner@example.com",
        note: "   ",
        now: T0,
        newId,
      }),
    ).rejects.toMatchObject({ code: "reset_requires_note" });
  });

  it("refuses to reset an account that is not tripped", async () => {
    await expect(
      resetAccountCircuitBreaker(db, {
        accountLabel: "secondary",
        actor: "owner@example.com",
        note: "nothing wrong here",
        now: T0,
        newId,
      }),
    ).rejects.toMatchObject({ code: "not_tripped" });
  });

  it("does NOT resume any bot it halted", async () => {
    // Section 7.2 step 5: resuming is an explicit human action per bot, after
    // review. Re-arming the account must not be a one-click restart of eleven.
    await db.botInstances.update(
      { id: "dca-btc-1" },
      { status: "halted", halt_reason: "breaker", halted_at: T0, updated_at: T0 },
    );
    await resetAccountCircuitBreaker(db, {
      accountLabel: "main",
      actor: "owner@example.com",
      note: "investigated",
      now: T0 + 1000,
      newId,
    });
    const bot = await db.botInstances.findOne({ id: "dca-btc-1" });
    expect(bot?.status).toBe("halted");
  });

  it("writes an info alert and an audit entry carrying the note", async () => {
    await resetAccountCircuitBreaker(db, {
      accountLabel: "main",
      actor: "owner@example.com",
      note: "confirmed with the exchange",
      now: T0 + 1000,
      newId,
    });
    const alerts = await db.alerts.findMany({ where: { alert_type: "circuit_breaker_reset" } });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.severity).toBe("info");

    const audits = await db.auditLog.findMany({ where: { action: "circuit_breaker.reset" } });
    expect(audits).toHaveLength(1);
    expect(JSON.stringify(audits[0]!.details_json)).toContain("confirmed with the exchange");
  });
});

describe("activeBotsOnAccount", () => {
  it("counts what the breaker would halt: created and running, not halted or stopped", async () => {
    await db.botInstances.insert(botInstanceRow({ id: "b-created", status: "created" }));
    await db.botInstances.insert(botInstanceRow({ id: "b-running", status: "running" }));
    await db.botInstances.insert(
      botInstanceRow({
        id: "b-halted",
        status: "halted",
        halt_reason: "stop loss",
        halted_at: T0,
      }),
    );
    await db.botInstances.insert(botInstanceRow({ id: "b-stopped", status: "stopped" }));

    const active = await activeBotsOnAccount(db, "main");
    expect(active.map((bot) => bot.id).sort()).toEqual(["b-created", "b-running"]);
  });
});
