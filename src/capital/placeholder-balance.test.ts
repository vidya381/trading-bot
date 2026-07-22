/**
 * Seeding total_balance by hand, against real D1.
 *
 * Most of these assert that the placeholder announces itself -- in the action
 * name, in the audit details, and by refusing an automated actor. That is the
 * point of the file it tests: the number is asserted by a person, and nothing
 * downstream should be able to read it as observed.
 */

import { beforeEach, describe, expect, it } from "vitest";
import type { Database } from "../db/database";
import type { PlaceholderBalanceAuditDetails } from "./placeholder-balance";
import {
  NON_HUMAN_ACTORS,
  PLACEHOLDER_BALANCE_ACTION,
  seedPlaceholderTotalBalance,
} from "./placeholder-balance";
import { createBotInstanceWithCapital } from "./ledger";
import { freshDatabase } from "../db/test-helpers";
import { fromDecimalString, ZERO } from "../shared/money";

const NOW = 1_760_000_500_000;
const HUMAN = { actor: "owner@example.com", now: NOW };

let db: Database;

beforeEach(async () => {
  db = await freshDatabase();
});

const SEED = {
  accountLabel: "main",
  asset: "USDT",
  totalBalance: fromDecimalString("5000.0"),
  note: "read off the Binance testnet dashboard by hand",
};

describe("creating a ledger row", () => {
  it("creates it with the seeded balance and nothing allocated", async () => {
    const row = await seedPlaceholderTotalBalance(db, SEED, HUMAN);
    expect(row.total_balance).toBe(fromDecimalString("5000.0"));
    expect(row.total_allocated).toBe(ZERO);
    expect(row.updated_at).toBe(NOW);
  });

  it("is what makes bot creation possible at all", async () => {
    // The two halves of this step meeting: nothing else creates a ledger row,
    // so without a seed every creation fails with no_ledger_row.
    await expect(
      createBotInstanceWithCapital(
        db,
        {
          id: "dca-btc-1",
          accountLabel: "main",
          asset: "USDT",
          exchange: "binance",
          pair: "BTCUSDT",
          strategyType: "dca",
          strategyParams: {},
          stopLossPct: fromDecimalString("5.0"),
          takeProfitPct: fromDecimalString("2.0"),
          requestedCapital: fromDecimalString("100.0"),
        },
        HUMAN,
      ),
    ).rejects.toMatchObject({ code: "no_ledger_row" });

    await seedPlaceholderTotalBalance(db, SEED, HUMAN);

    const result = await createBotInstanceWithCapital(
      db,
      {
        id: "dca-btc-1",
        accountLabel: "main",
        asset: "USDT",
        exchange: "binance",
        pair: "BTCUSDT",
        strategyType: "dca",
        strategyParams: {},
        stopLossPct: fromDecimalString("5.0"),
        takeProfitPct: fromDecimalString("2.0"),
        requestedCapital: fromDecimalString("100.0"),
      },
      HUMAN,
    );
    expect(result.newAllocated).toBe(fromDecimalString("100.0"));
  });

  it("keeps assets on one account separate", async () => {
    await seedPlaceholderTotalBalance(db, SEED, HUMAN);
    await seedPlaceholderTotalBalance(
      db,
      { ...SEED, asset: "BTC", totalBalance: fromDecimalString("0.5") },
      HUMAN,
    );
    expect(await db.capitalLedger.count({ account_label: "main" })).toBe(2);
  });
});

describe("re-seeding an existing row", () => {
  it("overwrites total_balance and leaves total_allocated untouched", async () => {
    await seedPlaceholderTotalBalance(db, SEED, HUMAN);
    await db.capitalLedger.update(
      { account_label: "main", asset: "USDT" },
      { total_allocated: fromDecimalString("1200.0") },
    );

    const row = await seedPlaceholderTotalBalance(
      db,
      { ...SEED, totalBalance: fromDecimalString("4200.0"), note: "after a withdrawal" },
      { actor: "owner@example.com", now: NOW + 1000 },
    );

    expect(row.total_balance).toBe(fromDecimalString("4200.0"));
    expect(row.total_allocated).toBe(fromDecimalString("1200.0"));
  });

  it("reuses the row's id rather than creating a second row for the pair", async () => {
    const first = await seedPlaceholderTotalBalance(db, SEED, HUMAN);
    const second = await seedPlaceholderTotalBalance(
      db,
      { ...SEED, totalBalance: fromDecimalString("10.0") },
      HUMAN,
    );
    expect(second.id).toBe(first.id);
    expect(await db.capitalLedger.count()).toBe(1);
  });

  it("can seed a balance below what is already allocated", async () => {
    // An over-allocated account is a real state -- funds moved off the exchange
    // by hand. The ledger must be able to record it; only new allocations are
    // blocked, which is what the CHECK constraint was deliberately left out for.
    await seedPlaceholderTotalBalance(db, SEED, HUMAN);
    await db.capitalLedger.update(
      { account_label: "main", asset: "USDT" },
      { total_allocated: fromDecimalString("4000.0") },
    );
    const row = await seedPlaceholderTotalBalance(
      db,
      { ...SEED, totalBalance: fromDecimalString("100.0"), note: "moved to cold storage" },
      HUMAN,
    );
    expect(row.total_balance).toBe(fromDecimalString("100.0"));
    expect(row.total_allocated).toBe(fromDecimalString("4000.0"));
  });
});

describe("it refuses to look like a balance feed", () => {
  it.each(NON_HUMAN_ACTORS)("rejects the actor %s", async (actor) => {
    await expect(
      seedPlaceholderTotalBalance(db, SEED, { actor, now: NOW }),
    ).rejects.toMatchObject({ code: "placeholder_requires_human_actor" });
    expect(await db.capitalLedger.count()).toBe(0);
  });

  it("rejects an empty actor", async () => {
    await expect(
      seedPlaceholderTotalBalance(db, SEED, { actor: "   ", now: NOW }),
    ).rejects.toMatchObject({ code: "placeholder_requires_human_actor" });
  });

  it("requires a note saying where the number came from", async () => {
    await expect(
      seedPlaceholderTotalBalance(db, { ...SEED, note: "  " }, HUMAN),
    ).rejects.toMatchObject({ code: "placeholder_requires_note" });
    expect(await db.capitalLedger.count()).toBe(0);
  });

  it("rejects a negative balance", async () => {
    await expect(
      seedPlaceholderTotalBalance(db, { ...SEED, totalBalance: -1n }, HUMAN),
    ).rejects.toMatchObject({ code: "invalid_capital_amount" });
  });

  it("accepts a zero balance, which is a meaningful thing to assert", async () => {
    const row = await seedPlaceholderTotalBalance(db, { ...SEED, totalBalance: ZERO }, HUMAN);
    expect(row.total_balance).toBe(ZERO);
  });
});

describe("the audit trail says the number was asserted, not observed", () => {
  it("marks the entry as a human-sourced placeholder", async () => {
    await seedPlaceholderTotalBalance(db, SEED, HUMAN);
    const entries = await db.auditLog.findMany();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      actor: "owner@example.com",
      action: PLACEHOLDER_BALANCE_ACTION,
      target_bot_instance_id: null,
    });
    expect(entries[0]?.details_json).toEqual({
      action: PLACEHOLDER_BALANCE_ACTION,
      placeholder: true,
      source: "human",
      account_label: "main",
      asset: "USDT",
      previous_balance: null,
      new_balance: "5000.00000000",
      total_allocated: "0.00000000",
      note: "read off the Binance testnet dashboard by hand",
    });
  });

  it("records the previous balance when overwriting one", async () => {
    await seedPlaceholderTotalBalance(db, SEED, HUMAN);
    await seedPlaceholderTotalBalance(
      db,
      { ...SEED, totalBalance: fromDecimalString("4200.0"), note: "after a withdrawal" },
      { actor: "owner@example.com", now: NOW + 1000 },
    );

    const entries = await db.auditLog.findMany({
      orderBy: [{ column: "created_at", direction: "asc" }],
    });
    expect(entries).toHaveLength(2);
    const details = entries[1]?.details_json as PlaceholderBalanceAuditDetails;
    expect(details.previous_balance).toBe("5000.00000000");
    expect(details.new_balance).toBe("4200.00000000");
    expect(details.note).toBe("after a withdrawal");
  });

  it("uses an action distinct from the allocation actions", async () => {
    // A dashboard filtering audit_log for allocation history must not pick this
    // up as one: no capital moved, only a claim about the balance.
    await seedPlaceholderTotalBalance(db, SEED, HUMAN);
    expect(PLACEHOLDER_BALANCE_ACTION.startsWith("capital.placeholder")).toBe(true);
    expect(await db.auditLog.count({ action: "capital.allocated" })).toBe(0);
  });
});
