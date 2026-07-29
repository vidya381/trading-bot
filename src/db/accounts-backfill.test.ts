/**
 * The account-registry backfill in migration 0006 (step 11).
 *
 * The migration's `INSERT ... SELECT ... FROM bot_instances` cannot be exercised
 * by simply applying migrations: `applyD1Migrations` runs them all against an
 * EMPTY database, so `bot_instances` has no rows when 0006 runs and nothing is
 * backfilled. This test therefore seeds `bot_instances` and then runs the same
 * backfill statement, so its behaviour -- which pre-existing accounts get
 * registered, and which junk is left out -- is pinned. The statement below
 * mirrors the one in migrations/0006_accounts.sql; keep them in step.
 */

import { describe, expect, it } from "vitest";
import { botInstanceRow, freshDatabase, rawD1 } from "./test-helpers";

// The backfill SELECT from migration 0006, with a fixed timestamp for the test.
const BACKFILL = `
  INSERT OR IGNORE INTO accounts (account_label, exchange, created_at, updated_at)
  SELECT account_label, exchange, 111, 111
  FROM bot_instances
  WHERE exchange IN ('binance', 'gemini')
  GROUP BY account_label
`;

describe("migration 0006 backfill", () => {
  it("registers one account per distinct label, skipping junk exchanges", async () => {
    const db = await freshDatabase();

    await db.botInstances.insert(botInstanceRow({ id: "bka", account_label: "acctA", exchange: "binance" }));
    await db.botInstances.insert(botInstanceRow({ id: "bkb", account_label: "acctB", exchange: "gemini" }));
    // A second bot on acctA, same exchange -- must not create a duplicate account.
    await db.botInstances.insert(botInstanceRow({ id: "bka2", account_label: "acctA", exchange: "binance" }));
    // A free-typed exchange that was never a recognised value -- must be skipped,
    // not abort the whole backfill on the CHECK constraint.
    await db.botInstances.insert(botInstanceRow({ id: "bkc", account_label: "acctC", exchange: "weird-testnet" }));

    await rawD1().prepare(BACKFILL).run();

    const accounts = await db.accounts.findMany({ orderBy: [{ column: "account_label", direction: "asc" }] });
    expect(accounts.map((a) => ({ label: a.account_label, exchange: a.exchange }))).toEqual([
      { label: "acctA", exchange: "binance" },
      { label: "acctB", exchange: "gemini" },
    ]);
    // acctC (junk exchange) is left unregistered -- it falls into the create-time
    // soft-fallback path, exactly what "soft-enforce" means.
    expect(accounts.some((a) => a.account_label === "acctC")).toBe(false);
  });

  it("is idempotent: re-running keeps the first exchange and adds no duplicates", async () => {
    const db = await freshDatabase();
    await db.botInstances.insert(botInstanceRow({ id: "bka", account_label: "acctA", exchange: "binance" }));

    await rawD1().prepare(BACKFILL).run();
    await rawD1().prepare(BACKFILL).run();

    const accounts = await db.accounts.findMany({ where: { account_label: "acctA" } });
    expect(accounts).toHaveLength(1);
    expect(accounts[0]!.exchange).toBe("binance");
  });
});
