/**
 * The point of build step 4, verified against real D1 rather than assumed.
 *
 * Step 2 chose bigint at scale 8 on the strength of a throwaway probe. That
 * probe was deleted. These tests are the permanent version: every claim the
 * money convention rests on, re-checked against the actual SQLite that ships
 * in the Workers runtime, through the access layer that callers will use.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { INT64_MAX, INT64_MIN, MoneyError } from "../shared/money";
import { DatabaseError } from "./columns";
import type { Database } from "./database";
import { capitalLedgerRow, freshDatabase, orderRow, rawD1, botInstanceRow } from "./test-helpers";

let db: Database;

beforeEach(async () => {
  db = await freshDatabase();
});

// A value with 18 significant digits: far past Number.MAX_SAFE_INTEGER
// (9,007,199,254,740,991), and the exact case that made step 2 reject reading
// D1 INTEGER columns directly.
const ABOVE_2_53 = 100_000_000_000_000_001n;

describe("precision through the access layer", () => {
  it("round-trips a value above 2^53 with no loss", async () => {
    await db.capitalLedger.insert(
      capitalLedgerRow({ total_balance: ABOVE_2_53, total_allocated: 0n }),
    );

    const row = await db.capitalLedger.findOne({ id: "cl-1" });
    expect(row?.total_balance).toBe(ABOVE_2_53);
    // Not merely "close": the last digit is the one a float would eat.
    expect(row?.total_balance.toString()).toBe("100000000000000001");
  });

  it("stores the full signed 64-bit range", async () => {
    await db.capitalLedger.insert(
      capitalLedgerRow({ id: "cl-max", total_balance: INT64_MAX, total_allocated: 0n }),
    );
    const row = await db.capitalLedger.findOne({ id: "cl-max" });
    expect(row?.total_balance).toBe(INT64_MAX);
  });

  it("stores large negative values", async () => {
    // manual_adjustments.amount is signed; a withdrawal is negative.
    await db.manualAdjustments.insert({
      id: "ma-neg",
      account_label: "main",
      asset: "USDT",
      amount: INT64_MIN + 1n,
      note: "boundary",
      reconciled_at: null,
      created_at: 1,
    });
    const row = await db.manualAdjustments.findOne({ id: "ma-neg" });
    expect(row?.amount).toBe(INT64_MIN + 1n);
  });

  it("refuses a value that would not survive the column, before writing", async () => {
    // toStorageString throws rather than letting SQLite mangle it, so nothing
    // reaches the database at all.
    await expect(
      db.capitalLedger.insert(capitalLedgerRow({ total_balance: 2n ** 63n })),
    ).rejects.toThrow(MoneyError);
    expect(await db.capitalLedger.count()).toBe(0);
  });

  it("keeps the value an INTEGER in SQLite, not text", async () => {
    await db.capitalLedger.insert(capitalLedgerRow({ total_balance: ABOVE_2_53 }));
    const typed = await rawD1()
      .prepare(`SELECT typeof(total_balance) AS t FROM capital_ledger WHERE id = 'cl-1'`)
      .first<{ t: string }>();
    // If this ever says "text", SUM() and ORDER BY below stop meaning anything.
    expect(typed?.t).toBe("integer");
  });
});

describe("why the CAST is load-bearing", () => {
  it("a direct read of the same column returns a WRONG number", async () => {
    await db.capitalLedger.insert(
      capitalLedgerRow({ total_balance: ABOVE_2_53, total_allocated: 0n }),
    );

    // Deliberately bypassing the access layer, which is the whole point: this
    // is what any hand-written query would silently do.
    const direct = await rawD1()
      .prepare(`SELECT total_balance FROM capital_ledger WHERE id = 'cl-1'`)
      .first<{ total_balance: number }>();

    expect(typeof direct?.total_balance).toBe("number");
    expect(direct?.total_balance).toBe(100_000_000_000_000_000); // note the final 0
    expect(BigInt(direct!.total_balance)).not.toBe(ABOVE_2_53);

    // And the layer's read of the same row is exact.
    const viaLayer = await db.capitalLedger.findOne({ id: "cl-1" });
    expect(viaLayer?.total_balance).toBe(ABOVE_2_53);
  });

  it("decoding refuses a number rather than accepting the lossy value", async () => {
    await db.capitalLedger.insert(capitalLedgerRow({ total_balance: ABOVE_2_53 }));
    const direct = await rawD1()
      .prepare(`SELECT total_balance FROM capital_ledger WHERE id = 'cl-1'`)
      .first<{ total_balance: number }>();

    // If a future refactor lost the CAST, this is the failure it would produce
    // -- an error naming the cause, not a quietly wrong balance.
    let code = "";
    try {
      db.capitalLedger.tableName; // touch, for readability
      const { money } = await import("./columns");
      money().decode(direct!.total_balance, "capital_ledger.total_balance");
    } catch (error) {
      code = error instanceof DatabaseError ? error.code : "wrong error type";
    }
    expect(code).toBe("decode_failed");
  });
});

describe("SQL-side operations stay numeric", () => {
  beforeEach(async () => {
    await db.botInstances.insert(botInstanceRow());
    // "9" would sort above "10" if the column were TEXT. Scale-8 values chosen
    // so the string ordering and numeric ordering genuinely disagree.
    const prices = [900_000_000n, 1_000_000_000n, 80_000_000n, 12_000_000_000n];
    for (const [index, price] of prices.entries()) {
      await db.orders.insert(
        orderRow({
          id: `ord-${index}`,
          client_order_id: `v1-dca-btc-1-${index}`,
          price,
          quantity: 100_000_000n,
        }),
      );
    }
  });

  it("ORDER BY sorts numerically, not lexicographically", async () => {
    const rows = await db.orders.findMany({
      orderBy: [{ column: "price", direction: "asc" }],
    });
    expect(rows.map((row) => row.price)).toEqual([
      80_000_000n,
      900_000_000n,
      1_000_000_000n,
      12_000_000_000n,
    ]);
  });

  it("comparison filters bind a string but compare as numbers", async () => {
    // The bound value is a decimal string; SQLite applies the column's INTEGER
    // affinity to the comparison. A TEXT column would return the wrong set.
    const rows = await db.orders.findMany({
      where: { price: { gt: 900_000_000n } },
      orderBy: [{ column: "price", direction: "asc" }],
    });
    expect(rows.map((row) => row.price)).toEqual([1_000_000_000n, 12_000_000_000n]);
  });

  it("SUM stays exact and is returned as a bigint", async () => {
    const total = await db.orders.sumMoney("price");
    expect(total).toBe(900_000_000n + 1_000_000_000n + 80_000_000n + 12_000_000_000n);
  });

  it("SUM respects a filter", async () => {
    const total = await db.orders.sumMoney("price", { price: { lt: 1_000_000_000n } });
    expect(total).toBe(980_000_000n);
  });
});

describe("SUM edge cases", () => {
  it("sums exactly across values that overflow a double", async () => {
    // Each addend is individually past 2^53; the running total is too. Summing
    // these in JavaScript numbers would drift.
    const values = [
      4_000_000_000_000_000_001n,
      4_000_000_000_000_000_003n,
      1_000_000_000_000_000_007n,
    ];
    for (const [index, amount] of values.entries()) {
      await db.manualAdjustments.insert({
        id: `ma-${index}`,
        account_label: "big",
        asset: "USDT",
        amount,
        note: "n",
        reconciled_at: null,
        created_at: index,
      });
    }
    const total = await db.manualAdjustments.sumMoney("amount", { account_label: "big" });
    expect(total).toBe(9_000_000_000_000_000_011n);
    expect(total).toBeLessThan(INT64_MAX);
  });

  it("sums mixed signs exactly", async () => {
    for (const [index, amount] of [ABOVE_2_53, -ABOVE_2_53, 7n].entries()) {
      await db.manualAdjustments.insert({
        id: `mix-${index}`,
        account_label: "mixed",
        asset: "USDT",
        amount,
        note: "n",
        reconciled_at: null,
        created_at: index,
      });
    }
    expect(await db.manualAdjustments.sumMoney("amount", { account_label: "mixed" })).toBe(7n);
  });

  it("returns 0n rather than null when nothing matches", async () => {
    // SQLite's SUM over an empty set is NULL. Zero is the right answer for an
    // empty allocation set, and step 5's capital check reads it directly.
    expect(await db.capitalLedger.sumMoney("total_allocated")).toBe(0n);
    expect(
      await db.manualAdjustments.sumMoney("amount", { account_label: "nobody" }),
    ).toBe(0n);
  });

  it("refuses to sum a column that is not money", async () => {
    let code = "";
    try {
      // @ts-expect-error -- created_at is an integer column, not money, and the
      // MoneyColumnName type rejects it at compile time. The runtime check
      // below is the backstop for a caller that casts around it.
      await db.orders.sumMoney("created_at");
    } catch (error) {
      code = error instanceof DatabaseError ? error.code : "wrong error type";
    }
    expect(code).toBe("unknown_column");
  });
});
