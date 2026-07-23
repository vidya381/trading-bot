/**
 * The no-schema guard on both cron Workers (post-step-8 fix).
 *
 * Production is deployed with an empty D1 database (migrations deferred to
 * go-live, section 16.1). Before the guard, the reconciliation and notification
 * crons threw a raw `no such table` error every time they fired. The guard is a
 * proactive `db.tableExists(...)` check: a missing schema is a clean no-op, and
 * any OTHER D1 error still surfaces because nothing catches it.
 *
 * ORDERING MATTERS IN THIS FILE. A test file starts with an empty D1 (verified:
 * schema-probe), and within a file the schema persists once `freshDatabase`
 * applies migrations. So the no-schema describe is defined FIRST, before any
 * `freshDatabase` call, which is the only way env.DB is genuinely schema-less.
 * The assertions are self-verifying regardless: if schema had leaked in, the
 * Workers would proceed (ran: true) and these `ran === false` checks would fail
 * loudly rather than pass silently.
 */

import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { freshDatabase } from "../db/test-helpers";
import type { Database } from "../db";
import { InMemoryCooldownStore } from "../notifications";
import type { AlertNotifier, NotifyResult } from "../notifications";
import { runScheduledReconciliation } from "./reconciliation";
import { runNotificationDispatch } from "./notifications";

const T0 = 1_760_000_000_000;

/** A notifier that never touches the network; delivery is irrelevant here. */
class NoopNotifier implements AlertNotifier {
  async send(): Promise<NotifyResult> {
    return { delivered: true };
  }
}

/** An env with no bindings of its own; used where every dependency is injected. */
const bareEnv = { ENVIRONMENT: "testnet" } as unknown as Env;

/**
 * A Database whose schema check passes but whose first real query throws a
 * given (non-missing-table) D1 error. Proves the guard is a boolean gate that
 * does not intercept a thrown error -- it only acts on `tableExists === false`.
 */
function throwingDb(message: string): Database {
  const boom = async (): Promise<never> => {
    throw new Error(message);
  };
  return {
    tableExists: async () => true,
    botInstances: { findMany: boom },
    capitalLedger: { findMany: boom },
    alerts: { findMany: boom },
  } as unknown as Database;
}

// ---------------------------------------------------------------------------
// No schema yet -- defined FIRST so env.DB is empty for these.
// ---------------------------------------------------------------------------

describe("no schema yet (production before go-live)", () => {
  it("reconciliation logs a clean no-op, not a raw D1 error", async () => {
    const result = await runScheduledReconciliation(env);
    expect(result.ran).toBe(false);
    expect(result.reason).toMatch(/no schema/i);
    expect(result.reason).toContain("bot_instances");
    expect(result.reason).toContain("docs/d1-provisioning.md");
  });

  it("notification dispatch logs a clean no-op, not a raw D1 error", async () => {
    // Notifier and cooldown injected so the secret/KV checks pass and execution
    // reaches the D1 schema guard; db comes from env.DB, which is empty here.
    const result = await runNotificationDispatch(env, {
      notifier: new NoopNotifier(),
      cooldown: new InMemoryCooldownStore(),
    });
    expect(result.ran).toBe(false);
    expect(result.reason).toMatch(/no schema/i);
    expect(result.reason).toContain("alerts");
    expect(result.reason).toContain("docs/d1-provisioning.md");
  });
});

// ---------------------------------------------------------------------------
// Schema present -- testnet, and production after go-live. Behaviour unchanged.
// ---------------------------------------------------------------------------

describe("schema present: behaviour is unchanged", () => {
  let db: Database;

  beforeEach(async () => {
    db = await freshDatabase();
  });

  it("tableExists reports true for real tables and false for a missing one", async () => {
    expect(await db.tableExists("bot_instances")).toBe(true);
    expect(await db.tableExists("alerts")).toBe(true);
    expect(await db.tableExists("does_not_exist")).toBe(false);
  });

  it("reconciliation proceeds past the guard and runs", async () => {
    const result = await runScheduledReconciliation(env);
    expect(result.ran).toBe(true);
  });

  it("notification dispatch proceeds past the guard and runs", async () => {
    const result = await runNotificationDispatch(bareEnv, {
      db,
      notifier: new NoopNotifier(),
      cooldown: new InMemoryCooldownStore(),
      now: () => T0,
    });
    expect(result.ran).toBe(true);
    expect(result.result?.scanned).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Any other D1 error still surfaces -- the guard suppresses ONLY missing-schema.
// ---------------------------------------------------------------------------

describe("a genuine (non-missing-table) D1 error still surfaces", () => {
  it("reconciliation lets a constraint error propagate", async () => {
    await expect(
      runScheduledReconciliation(env, {
        db: throwingDb("D1_ERROR: FOREIGN KEY constraint failed: SQLITE_CONSTRAINT"),
      }),
    ).rejects.toThrow(/FOREIGN KEY/);
  });

  it("notification dispatch lets a constraint error propagate", async () => {
    await expect(
      runNotificationDispatch(bareEnv, {
        db: throwingDb("D1_ERROR: NOT NULL constraint failed: SQLITE_CONSTRAINT"),
        notifier: new NoopNotifier(),
        cooldown: new InMemoryCooldownStore(),
      }),
    ).rejects.toThrow(/NOT NULL/);
  });
});
