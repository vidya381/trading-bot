/**
 * The conditional-UPDATE concurrency behaviour, against real D1.
 *
 * Two kinds of test here, and the distinction matters:
 *
 *   - DETERMINISTIC ones force a losing race by committing a competing write
 *     between the read and the compare-and-swap, using a wrapped `findOne`.
 *     These prove the retry logic itself: that a stale swap changes no rows,
 *     that a retry re-runs the availability check against the NEW value rather
 *     than reapplying a stale decision, and that exhaustion is a clear error
 *     with nothing written.
 *   - RACING ones start two real operations with Promise.all and assert on the
 *     outcome. These prove the end-to-end property that matters -- capital
 *     cannot be allocated twice -- and one of them also checks that the two
 *     operations genuinely interleave, so the racing tests are not quietly
 *     passing because the runtime ran them one after the other.
 */

import { beforeEach, describe, expect, it } from "vitest";
import type { Database } from "../db/database";
import type { BotInstanceCreation } from "./ledger";
import { createBotInstanceWithCapital, releaseBotCapital, resizeBotCapital } from "./ledger";
import { capitalLedgerRow, freshDatabase } from "../db/test-helpers";
import { fromDecimalString, ZERO, type Money } from "../shared/money";

const NOW = 1_760_000_500_000;
const OPTIONS = { actor: "owner@example.com", now: NOW };

let db: Database;

beforeEach(async () => {
  db = await freshDatabase();
});

async function seedLedger(balance: string, allocated: string): Promise<void> {
  await db.capitalLedger.insert(
    capitalLedgerRow({
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
    strategyParams: {},
    stopLossPct: fromDecimalString("5.0"),
    takeProfitPct: fromDecimalString("2.0"),
    requestedCapital: fromDecimalString("600.0"),
    ...overrides,
  };
}

async function ledgerState(): Promise<{ balance: Money; allocated: Money }> {
  const row = await db.capitalLedger.findOne({ account_label: "main", asset: "USDT" });
  if (row === null) throw new Error("no ledger row");
  return { balance: row.total_balance, allocated: row.total_allocated };
}

/**
 * Commit a competing change to total_allocated immediately after each of the
 * next `times` reads of the ledger, so the compare-and-swap that follows is
 * guaranteed to be operating on a value that is already stale.
 *
 * This is the only way to make a lost race deterministic: a real race is
 * observable but not schedulable. Returns a function that restores the
 * repository, which the test does not strictly need (each test gets a fresh
 * Database) but which keeps the wrapping visibly scoped.
 */
function conflictOnNextReads(times: number, step: Money): () => void {
  const ledger = db.capitalLedger;
  const original = ledger.findOne.bind(ledger);
  let remaining = times;

  Object.defineProperty(ledger, "findOne", {
    configurable: true,
    writable: true,
    value: async (where: Parameters<typeof original>[0]) => {
      const row = await original(where);
      if (remaining > 0 && row !== null && "total_allocated" in row) {
        remaining -= 1;
        // A competing writer commits between the read and the swap. Each one
        // moves the value again, so no later swap can match an earlier read.
        await db.capitalLedger.update(
          { account_label: "main", asset: "USDT" },
          { total_allocated: (row.total_allocated as Money) + step, updated_at: NOW },
        );
      }
      return row;
    },
  });

  return () => {
    Object.defineProperty(ledger, "findOne", {
      configurable: true,
      writable: true,
      value: original,
    });
  };
}

// ---------------------------------------------------------------------------

describe("the compare-and-swap primitive", () => {
  it("changes no rows when the observed total_allocated is stale", async () => {
    await seedLedger("5000.0", "1000.0");

    // What a caller observed.
    const observed = fromDecimalString("1000.0");
    // Somebody else got there first.
    await db.capitalLedger.update(
      { account_label: "main", asset: "USDT" },
      { total_allocated: fromDecimalString("1200.0"), updated_at: NOW },
    );

    const changes = await db.capitalLedger.update(
      { account_label: "main", asset: "USDT", total_allocated: observed },
      { total_allocated: fromDecimalString("2000.0"), updated_at: NOW },
    );

    expect(changes).toBe(0);
    expect((await ledgerState()).allocated).toBe(fromDecimalString("1200.0"));
  });

  it("changes exactly one row when the observed value still holds", async () => {
    await seedLedger("5000.0", "1000.0");
    const changes = await db.capitalLedger.update(
      { account_label: "main", asset: "USDT", total_allocated: fromDecimalString("1000.0") },
      { total_allocated: fromDecimalString("2000.0"), updated_at: NOW },
    );
    expect(changes).toBe(1);
  });
});

describe("retry on conflict", () => {
  it("retries and succeeds when the ledger moves under it once", async () => {
    await seedLedger("5000.0", "0.0");
    conflictOnNextReads(1, fromDecimalString("100.0"));

    const result = await createBotInstanceWithCapital(db, creation(), OPTIONS);

    // Attempt 1 read 0, the competing write made it 100, the swap missed.
    // Attempt 2 read 100 and swapped to 700.
    expect(result.attempts).toBe(2);
    expect(result.previousAllocated).toBe(fromDecimalString("100.0"));
    expect(result.newAllocated).toBe(fromDecimalString("700.0"));
    expect((await ledgerState()).allocated).toBe(fromDecimalString("700.0"));
  });

  it("re-runs the availability check against the new value, not the stale one", async () => {
    // Available is 700 at the first read, which covers the 600 requested. The
    // competing write takes 600 of it, so the retry must refuse -- a retry that
    // simply reapplied the first decision would over-allocate the account.
    await seedLedger("1000.0", "300.0");
    conflictOnNextReads(1, fromDecimalString("600.0"));

    await expect(createBotInstanceWithCapital(db, creation(), OPTIONS)).rejects.toMatchObject({
      code: "insufficient_capital",
    });
    expect((await ledgerState()).allocated).toBe(fromDecimalString("900.0"));
    expect(await db.botInstances.count()).toBe(0);
  });

  it("gives up with allocation_conflict after the attempt limit, having changed nothing", async () => {
    await seedLedger("5000000.0", "0.0");
    conflictOnNextReads(20, 1n);

    await expect(
      createBotInstanceWithCapital(db, creation(), { ...OPTIONS, maxAttempts: 3 }),
    ).rejects.toMatchObject({ code: "allocation_conflict" });

    // Only the competing writes landed: three reads, three conflicts, no
    // allocation, no bot, no audit entry.
    expect((await ledgerState()).allocated).toBe(3n);
    expect(await db.botInstances.count()).toBe(0);
    expect(await db.auditLog.count()).toBe(0);
  });

  it("reports the attempt count in the audit entry, so contention is visible later", async () => {
    await seedLedger("5000.0", "0.0");
    conflictOnNextReads(2, fromDecimalString("10.0"));

    await createBotInstanceWithCapital(db, creation(), OPTIONS);

    const entry = (await db.auditLog.findMany())[0];
    expect(entry?.details_json).toMatchObject({ attempts: 3 });
  });
});

describe("two near-simultaneous creations", () => {
  it("lets only one succeed when the account cannot fund both", async () => {
    // 1000 available, two bots wanting 600 each. Exactly one must win.
    await seedLedger("1000.0", "0.0");

    const outcomes = await Promise.allSettled([
      createBotInstanceWithCapital(db, creation({ id: "bot-a" }), OPTIONS),
      createBotInstanceWithCapital(db, creation({ id: "bot-b" }), OPTIONS),
    ]);

    const fulfilled = outcomes.filter((outcome) => outcome.status === "fulfilled");
    const rejected = outcomes.filter((outcome) => outcome.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
      code: "insufficient_capital",
    });

    // The ledger reflects one allocation, and so does everything else.
    expect((await ledgerState()).allocated).toBe(fromDecimalString("600.0"));
    expect(await db.botInstances.count()).toBe(1);
    expect(await db.auditLog.count()).toBe(1);
  });

  it("genuinely interleaves: both read before either writes", async () => {
    // Without this, the test above could pass simply because the runtime ran
    // the two creations end to end, which would prove nothing about
    // concurrency. Recording the order of reads and swaps shows the second
    // creation observed the ledger before the first had committed.
    await seedLedger("1000.0", "0.0");

    const events: string[] = [];
    const ledger = db.capitalLedger;
    const readOriginal = ledger.findOne.bind(ledger);
    const updateOriginal = ledger.update.bind(ledger);

    Object.defineProperty(ledger, "findOne", {
      configurable: true,
      writable: true,
      value: async (where: Parameters<typeof readOriginal>[0]) => {
        const row = await readOriginal(where);
        events.push("read");
        return row;
      },
    });
    Object.defineProperty(ledger, "update", {
      configurable: true,
      writable: true,
      value: async (
        where: Parameters<typeof updateOriginal>[0],
        patch: Parameters<typeof updateOriginal>[1],
      ) => {
        const changes = await updateOriginal(where, patch);
        events.push(changes === 1 ? "swap-won" : "swap-lost");
        return changes;
      },
    });

    await Promise.allSettled([
      createBotInstanceWithCapital(db, creation({ id: "bot-a" }), OPTIONS),
      createBotInstanceWithCapital(db, creation({ id: "bot-b" }), OPTIONS),
    ]);

    // Two reads before the first swap commits is the interleaving. If the
    // operations had run sequentially this would be read, swap-won, read.
    expect(events.slice(0, 2)).toEqual(["read", "read"]);
    expect(events).toContain("swap-won");
    expect((await ledgerState()).allocated).toBe(fromDecimalString("600.0"));
  });

  it("lets both succeed when the account can fund both, with no lost update", async () => {
    // The other half of the property: contention must not cost a valid
    // allocation. Both fit, both land, and the total is the sum -- not one of
    // the two, which is what a read-modify-write without the swap would give.
    await seedLedger("2000.0", "0.0");

    const outcomes = await Promise.allSettled([
      createBotInstanceWithCapital(db, creation({ id: "bot-a" }), OPTIONS),
      createBotInstanceWithCapital(db, creation({ id: "bot-b" }), OPTIONS),
    ]);

    expect(outcomes.every((outcome) => outcome.status === "fulfilled")).toBe(true);
    expect((await ledgerState()).allocated).toBe(fromDecimalString("1200.0"));
    expect(await db.botInstances.count()).toBe(2);
  });

  it("does not lose an allocation to a simultaneous release on the same account", async () => {
    await seedLedger("5000.0", "0.0");
    await createBotInstanceWithCapital(db, creation({ id: "old-bot" }), OPTIONS);

    const outcomes = await Promise.allSettled([
      releaseBotCapital(db, "old-bot", OPTIONS),
      createBotInstanceWithCapital(db, creation({ id: "new-bot" }), OPTIONS),
    ]);

    expect(outcomes.every((outcome) => outcome.status === "fulfilled")).toBe(true);
    // 600 in, 600 out, in some order: the survivor is the new bot's reservation.
    expect((await ledgerState()).allocated).toBe(fromDecimalString("600.0"));
  });
});

describe("two near-simultaneous closes of one bot", () => {
  it("releases the capital exactly once", async () => {
    await seedLedger("5000.0", "0.0");
    await createBotInstanceWithCapital(db, creation(), OPTIONS);

    const outcomes = await Promise.allSettled([
      releaseBotCapital(db, "dca-btc-1", OPTIONS),
      releaseBotCapital(db, "dca-btc-1", OPTIONS),
    ]);

    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(
      (outcomes.find((outcome) => outcome.status === "rejected") as PromiseRejectedResult).reason,
    ).toMatchObject({ code: "bot_already_stopped" });
    // Not -600: the status flip is the mutual exclusion, so only one release
    // reached the ledger at all.
    expect((await ledgerState()).allocated).toBe(ZERO);
    expect(await db.auditLog.count({ action: "capital.released" })).toBe(1);
  });

  it("does not let a resize and a close both spend the same bot's allocation", async () => {
    await seedLedger("5000.0", "0.0");
    await createBotInstanceWithCapital(db, creation(), OPTIONS);

    await Promise.allSettled([
      releaseBotCapital(db, "dca-btc-1", OPTIONS),
      resizeBotCapital(db, "dca-btc-1", fromDecimalString("900.0"), OPTIONS),
    ]);

    const bot = await db.botInstances.findOne({ id: "dca-btc-1" });
    const { allocated } = await ledgerState();
    // Whichever order they land in, the ledger must agree with the bot row:
    // either the bot is stopped and nothing is allocated, or it is not stopped
    // and exactly its allocated_capital is reserved.
    expect(bot).not.toBeNull();
    expect(allocated).toBe(bot?.status === "stopped" ? ZERO : (bot?.allocated_capital ?? -1n));
  });
});
