/**
 * Capital ledger operations against real D1 (spec section 8.5).
 *
 * Concurrency lives in concurrency.test.ts; this file is the single-writer
 * behaviour: the availability check, what create/close/resize do to
 * total_allocated, and what each writes to audit_log.
 */

import { beforeEach, describe, expect, it } from "vitest";
import type { Database } from "../db/database";
import type { AllocationAuditDetails, BotInstanceCreation } from "./ledger";
import {
  CapitalError,
  createBotInstanceWithCapital,
  releaseBotCapital,
  resizeBotCapital,
} from "./ledger";
import { capitalLedgerRow, freshDatabase } from "../db/test-helpers";
import { fromDecimalString, ZERO } from "../shared/money";

const NOW = 1_760_000_500_000;
const OPTIONS = { actor: "owner@example.com", now: NOW };

let db: Database;

beforeEach(async () => {
  db = await freshDatabase();
});

/** A ledger row with the balance and allocation this test wants. */
async function seedLedger(balance: string, allocated: string, asset = "USDT"): Promise<void> {
  await db.capitalLedger.insert(
    capitalLedgerRow({
      id: `cl-${asset}`,
      asset,
      total_balance: fromDecimalString(balance),
      total_allocated: fromDecimalString(allocated),
    }),
  );
}

function creation(overrides: Partial<BotInstanceCreation> = {}): BotInstanceCreation {
  return {
    id: "dca-btc-1",
    accountLabel: "main",
    asset: "USDT",
    exchange: "binance",
    pair: "BTCUSDT",
    strategyType: "dca",
    strategyParams: { baseOrderSize: "100.0" },
    stopLossPct: fromDecimalString("5.0"),
    takeProfitPct: fromDecimalString("2.0"),
    requestedCapital: fromDecimalString("1000.0"),
    ...overrides,
  };
}

async function allocatedNow(asset = "USDT"): Promise<bigint> {
  const row = await db.capitalLedger.findOne({ account_label: "main", asset });
  return row?.total_allocated ?? -1n;
}

async function onlyAuditDetails(): Promise<AllocationAuditDetails> {
  const entries = await db.auditLog.findMany();
  expect(entries).toHaveLength(1);
  return entries[0]?.details_json as AllocationAuditDetails;
}

// ---------------------------------------------------------------------------

describe("bot instance id minting rule", () => {
  // The schema's GLOB check is the last line of defence; this is the first, and
  // the point is that a bad id costs no round trip and no reserved capital.
  it.each([
    ["a UUID", "3f8a1c2e-9b4d-4f11-8a7e-1d2c3b4a5e6f"],
    ["an uppercase letter", "DCA-btc-1"],
    ["a leading hyphen", "-dca-btc"],
    ["a leading underscore", "_dca"],
    ["21 characters", "a23456789012345678901"],
    ["an empty string", ""],
    ["a dot", "dca.btc"],
    ["a space", "dca btc"],
  ])("rejects %s", async (_label, id) => {
    await seedLedger("5000.0", "0.0");
    await expect(createBotInstanceWithCapital(db, creation({ id }), OPTIONS)).rejects.toMatchObject({
      code: "invalid_bot_instance_id",
    });
  });

  it.each([
    ["a plain slug", "dca-btc-1"],
    ["a single character", "a"],
    ["a leading digit", "1st-bot"],
    ["underscores", "dca_btc_1"],
    ["exactly 20 characters", "a2345678901234567890"],
  ])("accepts %s", async (_label, id) => {
    await seedLedger("5000.0", "0.0");
    await createBotInstanceWithCapital(db, creation({ id }), OPTIONS);
    expect(await db.botInstances.findOne({ id })).not.toBeNull();
  });

  it("reserves no capital and writes nothing when the id is rejected", async () => {
    await seedLedger("5000.0", "0.0");
    await expect(
      createBotInstanceWithCapital(db, creation({ id: "BAD" }), OPTIONS),
    ).rejects.toThrow(CapitalError);
    expect(await allocatedNow()).toBe(ZERO);
    expect(await db.botInstances.count()).toBe(0);
    expect(await db.auditLog.count()).toBe(0);
  });
});

describe("creation-time availability check", () => {
  it("allows a request that exactly exhausts the available balance", async () => {
    await seedLedger("5000.0", "4000.0");
    const result = await createBotInstanceWithCapital(
      db,
      creation({ requestedCapital: fromDecimalString("1000.0") }),
      OPTIONS,
    );
    expect(result.newAllocated).toBe(fromDecimalString("5000.0"));
    expect(result.availableAfter).toBe(ZERO);
  });

  it("blocks a request one satoshi over the available balance", async () => {
    await seedLedger("5000.0", "4000.0");
    await expect(
      createBotInstanceWithCapital(
        db,
        creation({ requestedCapital: fromDecimalString("1000.0") + 1n }),
        OPTIONS,
      ),
    ).rejects.toMatchObject({ code: "insufficient_capital" });
    expect(await allocatedNow()).toBe(fromDecimalString("4000.0"));
    expect(await db.botInstances.count()).toBe(0);
  });

  it("blocks everything while the account is already over-allocated", async () => {
    // Migration 0001 permits allocated > balance on purpose: a losing position
    // or a manual withdrawal produces it, and reconciliation has to be able to
    // record it. What it must not do is permit further allocation.
    await seedLedger("1000.0", "1500.0");
    await expect(
      createBotInstanceWithCapital(
        db,
        creation({ requestedCapital: fromDecimalString("1.0") }),
        OPTIONS,
      ),
    ).rejects.toMatchObject({ code: "insufficient_capital" });
  });

  it("refuses when the account has no ledger row at all", async () => {
    await expect(createBotInstanceWithCapital(db, creation(), OPTIONS)).rejects.toMatchObject({
      code: "no_ledger_row",
    });
  });

  it("refuses a zero or negative request before touching the ledger", async () => {
    await seedLedger("5000.0", "0.0");
    for (const amount of [ZERO, fromDecimalString("-1.0")]) {
      await expect(
        createBotInstanceWithCapital(db, creation({ requestedCapital: amount }), OPTIONS),
      ).rejects.toMatchObject({ code: "invalid_capital_amount" });
    }
    expect(await allocatedNow()).toBe(ZERO);
  });

  it("refuses a duplicate bot instance id", async () => {
    await seedLedger("5000.0", "0.0");
    await createBotInstanceWithCapital(db, creation(), OPTIONS);
    await expect(createBotInstanceWithCapital(db, creation(), OPTIONS)).rejects.toMatchObject({
      code: "duplicate_bot_instance",
    });
    // And the second attempt reserved nothing.
    expect(await allocatedNow()).toBe(fromDecimalString("1000.0"));
  });

  it("keeps two assets on one account independent", async () => {
    await seedLedger("5000.0", "0.0", "USDT");
    await seedLedger("2.0", "0.0", "BTC");

    await createBotInstanceWithCapital(db, creation(), OPTIONS);
    await createBotInstanceWithCapital(
      db,
      creation({
        id: "grid-eth-btc",
        asset: "BTC",
        pair: "ETHBTC",
        requestedCapital: fromDecimalString("1.5"),
      }),
      OPTIONS,
    );

    expect(await allocatedNow("USDT")).toBe(fromDecimalString("1000.0"));
    expect(await allocatedNow("BTC")).toBe(fromDecimalString("1.5"));
  });
});

describe("creation writes", () => {
  beforeEach(async () => {
    await seedLedger("5000.0", "1000.0");
  });

  it("adds the request to total_allocated", async () => {
    const result = await createBotInstanceWithCapital(db, creation(), OPTIONS);
    expect(result.previousAllocated).toBe(fromDecimalString("1000.0"));
    expect(result.newAllocated).toBe(fromDecimalString("2000.0"));
    expect(result.availableAfter).toBe(fromDecimalString("3000.0"));
    expect(result.attempts).toBe(1);
    expect(await allocatedNow()).toBe(fromDecimalString("2000.0"));
  });

  it("writes the bot row, including the asset its capital came from", async () => {
    await createBotInstanceWithCapital(db, creation(), OPTIONS);
    const bot = await db.botInstances.findOne({ id: "dca-btc-1" });
    expect(bot).toMatchObject({
      status: "created",
      allocated_capital: fromDecimalString("1000.0"),
      capital_asset: "USDT",
      account_label: "main",
      schema_version: 1,
    });
  });

  it("writes one audit entry describing the allocation", async () => {
    await createBotInstanceWithCapital(db, creation(), OPTIONS);
    const entries = await db.auditLog.findMany();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      actor: "owner@example.com",
      action: "capital.allocated",
      target_bot_instance_id: "dca-btc-1",
      created_at: NOW,
    });
    expect(entries[0]?.details_json).toEqual({
      action: "capital.allocated",
      account_label: "main",
      asset: "USDT",
      allocation_delta: "1000.00000000",
      previous_allocated: "1000.00000000",
      new_allocated: "2000.00000000",
      total_balance: "5000.00000000",
      available_after: "3000.00000000",
      attempts: 1,
    });
  });

  it("does not touch total_balance", async () => {
    await createBotInstanceWithCapital(db, creation(), OPTIONS);
    const row = await db.capitalLedger.findOne({ account_label: "main", asset: "USDT" });
    expect(row?.total_balance).toBe(fromDecimalString("5000.0"));
  });

  it("survives a capital amount above 2^53, which a JS number would corrupt", async () => {
    // 100_000_000.00000001 in scale-8 is 10_000_000_000_000_001, past 2^53.
    await db.capitalLedger.update(
      { account_label: "main", asset: "USDT" },
      { total_balance: 20_000_000_000_000_002n, total_allocated: ZERO },
    );
    const requested = 10_000_000_000_000_001n;
    const result = await createBotInstanceWithCapital(
      db,
      creation({ requestedCapital: requested }),
      OPTIONS,
    );
    expect(result.newAllocated).toBe(requested);
    expect(await allocatedNow()).toBe(requested);
  });
});

describe("closing a bot releases its reservation", () => {
  beforeEach(async () => {
    await seedLedger("5000.0", "0.0");
    await createBotInstanceWithCapital(db, creation(), OPTIONS);
  });

  it("subtracts exactly what was reserved and marks the bot stopped", async () => {
    const result = await releaseBotCapital(db, "dca-btc-1", OPTIONS);
    expect(result.newAllocated).toBe(ZERO);
    expect(await allocatedNow()).toBe(ZERO);
    expect((await db.botInstances.findOne({ id: "dca-btc-1" }))?.status).toBe("stopped");
  });

  it("releases the reservation, not the position's value", async () => {
    // The decision this test exists to pin: the bot lost 40% of its capital,
    // and the close still frees the full 1000 that was reserved. The loss shows
    // up as total_balance falling when reconciliation writes it -- which is why
    // total_balance is deliberately left alone here.
    await db.capitalLedger.update(
      { account_label: "main", asset: "USDT" },
      { total_balance: fromDecimalString("4600.0") },
    );

    await releaseBotCapital(db, "dca-btc-1", OPTIONS);

    const row = await db.capitalLedger.findOne({ account_label: "main", asset: "USDT" });
    expect(row?.total_allocated).toBe(ZERO);
    expect(row?.total_balance).toBe(fromDecimalString("4600.0"));
  });

  it("refuses a second close and frees nothing the second time", async () => {
    await releaseBotCapital(db, "dca-btc-1", OPTIONS);
    await db.capitalLedger.update(
      { account_label: "main", asset: "USDT" },
      { total_allocated: fromDecimalString("2500.0") },
    );

    await expect(releaseBotCapital(db, "dca-btc-1", OPTIONS)).rejects.toMatchObject({
      code: "bot_already_stopped",
    });
    expect(await allocatedNow()).toBe(fromDecimalString("2500.0"));
  });

  it("refuses an unknown bot", async () => {
    await expect(releaseBotCapital(db, "no-such-bot", OPTIONS)).rejects.toMatchObject({
      code: "unknown_bot_instance",
    });
  });

  it("refuses to drive total_allocated negative when the ledger disagrees", async () => {
    // The bot claims 1000 but the ledger only shows 400 allocated. Forcing this
    // through would invent 600 of headroom out of an inconsistency.
    await db.capitalLedger.update(
      { account_label: "main", asset: "USDT" },
      { total_allocated: fromDecimalString("400.0") },
    );
    await expect(releaseBotCapital(db, "dca-btc-1", OPTIONS)).rejects.toMatchObject({
      code: "release_exceeds_allocated",
    });
    expect(await allocatedNow()).toBe(fromDecimalString("400.0"));
  });

  it("writes an audit entry with a negative delta", async () => {
    await releaseBotCapital(db, "dca-btc-1", { actor: "owner@example.com", now: NOW + 1000 });
    const entries = await db.auditLog.findMany({ where: { action: "capital.released" } });
    expect(entries).toHaveLength(1);
    expect(entries[0]?.details_json).toMatchObject({
      action: "capital.released",
      allocation_delta: "-1000.00000000",
      previous_allocated: "1000.00000000",
      new_allocated: "0.00000000",
      available_after: "5000.00000000",
    });
  });
});

describe("resizing a bot's allocation", () => {
  beforeEach(async () => {
    await seedLedger("5000.0", "0.0");
    await createBotInstanceWithCapital(db, creation(), OPTIONS);
  });

  it("reserves only the difference when growing", async () => {
    const result = await resizeBotCapital(db, "dca-btc-1", fromDecimalString("1500.0"), OPTIONS);
    expect(result.newAllocated).toBe(fromDecimalString("1500.0"));
    expect((await db.botInstances.findOne({ id: "dca-btc-1" }))?.allocated_capital).toBe(
      fromDecimalString("1500.0"),
    );
  });

  it("checks the difference against available balance, not the whole new size", async () => {
    // 4500 more would not fit if the check used the new size against a balance
    // already carrying this bot's 1000; the delta is what has to fit.
    await resizeBotCapital(db, "dca-btc-1", fromDecimalString("5000.0"), OPTIONS);
    expect(await allocatedNow()).toBe(fromDecimalString("5000.0"));
  });

  it("blocks a growth that does not fit and leaves the bot row alone", async () => {
    await expect(
      resizeBotCapital(db, "dca-btc-1", fromDecimalString("5000.0") + 1n, OPTIONS),
    ).rejects.toMatchObject({ code: "insufficient_capital" });
    expect(await allocatedNow()).toBe(fromDecimalString("1000.0"));
    expect((await db.botInstances.findOne({ id: "dca-btc-1" }))?.allocated_capital).toBe(
      fromDecimalString("1000.0"),
    );
  });

  it("frees the difference when shrinking", async () => {
    const result = await resizeBotCapital(db, "dca-btc-1", fromDecimalString("250.0"), OPTIONS);
    expect(result.newAllocated).toBe(fromDecimalString("250.0"));
    expect(await allocatedNow()).toBe(fromDecimalString("250.0"));
    expect((await db.botInstances.findOne({ id: "dca-btc-1" }))?.allocated_capital).toBe(
      fromDecimalString("250.0"),
    );
  });

  it("treats a resize to the current size as a no-op with no audit entry", async () => {
    const before = await db.auditLog.count();
    const result = await resizeBotCapital(db, "dca-btc-1", fromDecimalString("1000.0"), OPTIONS);
    expect(result.newAllocated).toBe(fromDecimalString("1000.0"));
    expect(await db.auditLog.count()).toBe(before);
  });

  it("refuses a non-positive size and says to close the bot instead", async () => {
    await expect(resizeBotCapital(db, "dca-btc-1", ZERO, OPTIONS)).rejects.toMatchObject({
      code: "invalid_capital_amount",
    });
  });

  it("refuses to resize a stopped bot", async () => {
    await releaseBotCapital(db, "dca-btc-1", OPTIONS);
    await expect(
      resizeBotCapital(db, "dca-btc-1", fromDecimalString("500.0"), OPTIONS),
    ).rejects.toMatchObject({ code: "bot_already_stopped" });
    expect(await allocatedNow()).toBe(ZERO);
  });

  it("refuses an unknown bot", async () => {
    await expect(
      resizeBotCapital(db, "nope", fromDecimalString("500.0"), OPTIONS),
    ).rejects.toMatchObject({ code: "unknown_bot_instance" });
  });

  it("writes one audit entry per direction", async () => {
    await resizeBotCapital(db, "dca-btc-1", fromDecimalString("1500.0"), OPTIONS);
    await resizeBotCapital(db, "dca-btc-1", fromDecimalString("600.0"), OPTIONS);
    const entries = await db.auditLog.findMany({
      where: { action: "capital.resized" },
      orderBy: [{ column: "created_at", direction: "asc" }],
    });
    expect(entries).toHaveLength(2);
    expect(entries.map((entry) => (entry.details_json as AllocationAuditDetails).allocation_delta)).toEqual([
      "500.00000000",
      "-900.00000000",
    ]);
  });
});

describe("audit_log is where allocation history lives", () => {
  it("records every change to one bot in order, since the ledger row only shows the latest", async () => {
    await seedLedger("5000.0", "0.0");
    await createBotInstanceWithCapital(db, creation(), { actor: "owner@example.com", now: NOW });
    await resizeBotCapital(db, "dca-btc-1", fromDecimalString("2000.0"), {
      actor: "owner@example.com",
      now: NOW + 1,
    });
    await releaseBotCapital(db, "dca-btc-1", { actor: "system", now: NOW + 2 });

    const entries = await db.auditLog.findMany({
      where: { target_bot_instance_id: "dca-btc-1" },
      orderBy: [{ column: "created_at", direction: "asc" }],
    });
    expect(entries.map((entry) => entry.action)).toEqual([
      "capital.allocated",
      "capital.resized",
      "capital.released",
    ]);
    expect(entries.map((entry) => entry.actor)).toEqual([
      "owner@example.com",
      "owner@example.com",
      "system",
    ]);
    // The deltas sum to zero: everything reserved was eventually released.
    const deltas = entries.map((entry) =>
      fromDecimalString((entry.details_json as AllocationAuditDetails).allocation_delta),
    );
    expect(deltas.reduce((total, delta) => total + delta, ZERO)).toBe(ZERO);
    expect(await allocatedNow()).toBe(ZERO);
  });

  it("leaves one audit entry per operation and nothing else", async () => {
    await seedLedger("5000.0", "0.0");
    await createBotInstanceWithCapital(db, creation(), OPTIONS);
    const details = await onlyAuditDetails();
    expect(details.attempts).toBe(1);
  });
});
