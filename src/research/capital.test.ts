/**
 * The capital-ledger read, against the REAL migrations and the REAL repository.
 *
 * Four properties, each one this module would look correct without:
 *
 *  1. THE SUBTRACTION IS THE REAL ONE. `available` is `total_balance -
 *     total_allocated` exactly, at full scale, from rows written through the
 *     real codec -- not a float, not rounded, and not clamped.
 *  2. AN OVER-ALLOCATED ACCOUNT REPORTS A NEGATIVE FIGURE. Migration 0001
 *     deliberately permits `total_allocated > total_balance` (a losing bot), and
 *     clamping that to zero here would hide the exact state a human most needs
 *     to see before allocating more.
 *  3. "NO ROW" IS NOT "ZERO". An asset the account has never been funded in and
 *     an asset with nothing spare are different facts, and `headroomFor`
 *     answers `null` for the first.
 *  4. AN UNREADABLE LEDGER IS A REFUSAL, NEVER AN EMPTY RESULT. Section 5.6's
 *     rule applied to money: a read that did not happen must not be reported as
 *     "this account has nothing".
 *
 * NOTHING HERE CONTACTS ANYTHING. One real in-memory D1 and one stub that throws.
 */

import { beforeEach, describe, expect, it } from "vitest";

import {
  ResearchCapitalError,
  hasAnyHeadroom,
  headroomFor,
  readAccountCapital,
  type AccountCapital,
} from "./capital";
import type { Database } from "../db/database";
import type { Timestamp } from "../shared/exchange-client";
import { capitalLedgerRow, freshDatabase } from "../db/test-helpers";

const T0 = 1_930_000_000_000;
const ONE_UNIT = 100_000_000n;

let db: Database;
let clock: number;

beforeEach(async () => {
  db = await freshDatabase();
  clock = T0;
});

const now = (): Timestamp => (clock += 1_000);

describe("the real read", () => {
  it("returns every asset row for the account, with the subtraction done exactly", async () => {
    await db.capitalLedger.insert(
      capitalLedgerRow({
        id: "cl-usd",
        account_label: "gemini-main",
        asset: "USD",
        total_balance: 1_234_500_000n, // 12.345
        total_allocated: 234_500_000n, //  2.345
      }),
    );

    const capital = await readAccountCapital(db, "gemini-main", now);

    expect(capital.rowsRead).toBe(1);
    expect(capital.assets).toHaveLength(1);
    const usd = capital.assets[0]!;
    expect(usd.asset).toBe("USD");
    expect(usd.totalBalance).toBe(1_234_500_000n);
    expect(usd.totalAllocated).toBe(234_500_000n);
    // Exact bigint arithmetic, at scale 8. 12.345 - 2.345 = 10.00000000
    expect(usd.available).toBe(1_000_000_000n);
    expect(usd.available).toBe(usd.totalBalance - usd.totalAllocated);
  });

  it("returns several assets, in a stable order, so two runs are comparable", async () => {
    await db.capitalLedger.insert(
      capitalLedgerRow({ id: "cl-2", account_label: "gemini-main", asset: "USD" }),
    );
    await db.capitalLedger.insert(
      capitalLedgerRow({ id: "cl-1", account_label: "gemini-main", asset: "GUSD" }),
    );

    const first = await readAccountCapital(db, "gemini-main", now);
    const second = await readAccountCapital(db, "gemini-main", now);

    expect(first.assets.map((entry) => entry.asset)).toEqual(["GUSD", "USD"]);
    expect(second.assets.map((entry) => entry.asset)).toEqual(first.assets.map((e) => e.asset));
  });

  it("reads ONLY the named account's rows", async () => {
    await db.capitalLedger.insert(
      capitalLedgerRow({ id: "cl-mine", account_label: "gemini-main", asset: "USD" }),
    );
    await db.capitalLedger.insert(
      capitalLedgerRow({ id: "cl-theirs", account_label: "someone-else", asset: "USD" }),
    );

    const capital = await readAccountCapital(db, "gemini-main", now);
    expect(capital.rowsRead).toBe(1);
    expect(capital.accountLabel).toBe("gemini-main");
  });

  it("carries the ROW's own updated_at, not the time of this read", async () => {
    await db.capitalLedger.insert(
      capitalLedgerRow({ account_label: "gemini-main", asset: "USD", updated_at: 42 }),
    );

    const capital = await readAccountCapital(db, "gemini-main", now);
    expect(capital.assets[0]!.updatedAt).toBe(42);
    expect(capital.readAt).toBeGreaterThan(T0);
    expect(capital.readAt).not.toBe(42);
  });
});

describe("an over-allocated account", () => {
  it("reports a NEGATIVE available figure rather than clamping it to zero", async () => {
    await db.capitalLedger.insert(
      capitalLedgerRow({
        account_label: "gemini-main",
        asset: "USD",
        total_balance: 100n * ONE_UNIT,
        total_allocated: 150n * ONE_UNIT,
      }),
    );

    const capital = await readAccountCapital(db, "gemini-main", now);
    expect(capital.assets[0]!.available).toBe(-50n * ONE_UNIT);
    expect(hasAnyHeadroom(capital)).toBe(false);
  });

  it("is not confused with a zero-headroom account, which is also not headroom", async () => {
    await db.capitalLedger.insert(
      capitalLedgerRow({
        account_label: "gemini-main",
        asset: "USD",
        total_balance: 100n * ONE_UNIT,
        total_allocated: 100n * ONE_UNIT,
      }),
    );

    const capital = await readAccountCapital(db, "gemini-main", now);
    expect(capital.assets[0]!.available).toBe(0n);
    expect(hasAnyHeadroom(capital)).toBe(false);
  });

  it("reports headroom when ANY asset has some, even if another has none", async () => {
    await db.capitalLedger.insert(
      capitalLedgerRow({
        id: "cl-a",
        account_label: "gemini-main",
        asset: "GUSD",
        total_balance: 10n * ONE_UNIT,
        total_allocated: 10n * ONE_UNIT,
      }),
    );
    await db.capitalLedger.insert(
      capitalLedgerRow({
        id: "cl-b",
        account_label: "gemini-main",
        asset: "USD",
        total_balance: 10n * ONE_UNIT,
        total_allocated: 1n * ONE_UNIT,
      }),
    );

    expect(hasAnyHeadroom(await readAccountCapital(db, "gemini-main", now))).toBe(true);
  });
});

describe("an account with no ledger rows", () => {
  it("is a successful read that found nothing, NOT a failure", async () => {
    const capital = await readAccountCapital(db, "never-seeded", now);
    expect(capital.rowsRead).toBe(0);
    expect(capital.assets).toEqual([]);
    expect(hasAnyHeadroom(capital)).toBe(false);
  });
});

describe("headroomFor", () => {
  const capital: AccountCapital = {
    accountLabel: "gemini-main",
    readAt: T0,
    rowsRead: 1,
    assets: [
      {
        asset: "USD",
        totalBalance: 0n,
        totalAllocated: 0n,
        available: 0n,
        updatedAt: T0,
      },
    ],
  };

  it("distinguishes an asset with no row from one with nothing spare", () => {
    // The row exists and has zero available.
    expect(headroomFor(capital, "USD")).not.toBeNull();
    expect(headroomFor(capital, "USD")!.available).toBe(0n);
    // No row at all. NOT zero -- there is nothing to be zero.
    expect(headroomFor(capital, "GUSD")).toBeNull();
  });

  it("matches the asset exactly, with no case folding", () => {
    expect(headroomFor(capital, "usd")).toBeNull();
  });
});

describe("an unreadable ledger", () => {
  /** A `Database` whose capital_ledger read throws, as a driver failure would. */
  function brokenDb(): Database {
    return {
      capitalLedger: {
        findMany: async () => {
          throw new Error("D1_ERROR: no such table: capital_ledger");
        },
      },
    } as unknown as Database;
  }

  it("refuses with its own code rather than returning an empty result", async () => {
    await expect(readAccountCapital(brokenDb(), "gemini-main", now)).rejects.toMatchObject({
      name: "ResearchCapitalError",
      code: "ledger_unreadable",
    });
  });

  it("keeps the underlying failure as `cause`, so nothing is lost", async () => {
    const error = await readAccountCapital(brokenDb(), "gemini-main", now).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ResearchCapitalError);
    expect((error as ResearchCapitalError).message).toContain("no such table");
    expect((error as { cause?: unknown }).cause).toBeInstanceOf(Error);
  });

  it("says WHY it refuses rather than reporting none, in the message a human reads", async () => {
    const error = (await readAccountCapital(brokenDb(), "gemini-main", now).catch(
      (e: unknown) => e,
    )) as ResearchCapitalError;
    expect(error.message).toContain("Refusing to report");
    expect(error.message).toContain("fabricated number");
  });
});
