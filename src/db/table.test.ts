/** Repository behaviour, against real D1. */

import { beforeEach, describe, expect, it } from "vitest";
import { DatabaseError, money, text } from "./columns";
import type { Database } from "./database";
import { defineTable, Repository } from "./table";
import {
  alertRow,
  auditLogRow,
  botInstanceRow,
  freshDatabase,
  orderRow,
  rawD1,
  tradeRow,
} from "./test-helpers";

let db: Database;

beforeEach(async () => {
  db = await freshDatabase();
});

async function codeOf(fn: () => unknown): Promise<string> {
  try {
    await fn();
  } catch (error) {
    if (error instanceof DatabaseError) return error.code;
    return `${(error as Error).name}: ${(error as Error).message}`;
  }
  return "no error thrown";
}

describe("insert and read", () => {
  it("round-trips every column kind in one row", async () => {
    await db.botInstances.insert(
      botInstanceRow({ strategy_params_json: { steps: 3, sizes: ["1.5", "2.5"] } }),
    );

    const row = await db.botInstances.findOne({ id: "dca-btc-1" });
    expect(row).not.toBeNull();
    expect(row?.strategy_type).toBe("dca"); // text union
    expect(row?.stop_loss_pct).toBe(500_000_000n); // money -> bigint
    expect(row?.schema_version).toBe(1); // integer
    expect(row?.strategy_params_json).toEqual({ steps: 3, sizes: ["1.5", "2.5"] }); // json
    expect(row?.halt_reason).toBeNull(); // nullable text
    expect(row?.created_at).toBe(1_760_000_000_000); // timestamp
  });

  it("round-trips a boolean column", async () => {
    await db.alerts.insert(alertRow({ resolved: false }));
    await db.alerts.insert(alertRow({ id: "alert-2", resolved: true }));

    expect((await db.alerts.findOne({ id: "alert-1" }))?.resolved).toBe(false);
    expect((await db.alerts.findOne({ id: "alert-2" }))?.resolved).toBe(true);

    // Stored as 0/1 in SQLite, per the CHECK constraint.
    const raw = await rawD1()
      .prepare(`SELECT resolved FROM alerts WHERE id = 'alert-2'`)
      .first<{ resolved: number }>();
    expect(raw?.resolved).toBe(1);
  });

  it("writes and reads NULL for nullable columns", async () => {
    await db.botInstances.insert(
      botInstanceRow({ id: "grid-eth-1", strategy_type: "grid", take_profit_pct: null }),
    );
    const row = await db.botInstances.findOne({ id: "grid-eth-1" });
    expect(row?.take_profit_pct).toBeNull();
  });

  it("returns null from findOne when nothing matches", async () => {
    expect(await db.botInstances.findOne({ id: "nope" })).toBeNull();
  });

  it("counts with and without a filter", async () => {
    await db.botInstances.insert(botInstanceRow());
    await db.botInstances.insert(
      botInstanceRow({ id: "dca-eth-1", account_label: "second", status: "running" }),
    );
    expect(await db.botInstances.count()).toBe(2);
    expect(await db.botInstances.count({ status: "running" })).toBe(1);
    expect(await db.botInstances.count({ status: "halted" })).toBe(0);
  });
});

describe("filters", () => {
  beforeEach(async () => {
    await db.botInstances.insert(botInstanceRow());
    for (let index = 0; index < 5; index += 1) {
      await db.orders.insert(
        orderRow({
          id: `ord-${index}`,
          client_order_id: `v1-dca-btc-1-${index}`,
          created_at: 1000 + index,
          status: index % 2 === 0 ? "pending" : "filled",
          exchange_order_id: index === 4 ? null : `ex-${index}`,
        }),
      );
    }
  });

  it("treats a bare value as equality", async () => {
    expect((await db.orders.findMany({ where: { status: "pending" } })).length).toBe(3);
  });

  it("supports in / ne / gte / lte", async () => {
    expect(
      (await db.orders.findMany({ where: { status: { in: ["pending", "filled"] } } })).length,
    ).toBe(5);
    expect((await db.orders.findMany({ where: { status: { ne: "pending" } } })).length).toBe(2);
    expect((await db.orders.findMany({ where: { created_at: { gte: 1003 } } })).length).toBe(2);
    expect((await db.orders.findMany({ where: { created_at: { lte: 1001 } } })).length).toBe(2);
  });

  it("supports isNull, isNotNull, and a bare null", async () => {
    expect(
      (await db.orders.findMany({ where: { exchange_order_id: { isNull: true } } })).length,
    ).toBe(1);
    expect(
      (await db.orders.findMany({ where: { exchange_order_id: { isNotNull: true } } })).length,
    ).toBe(4);
    expect((await db.orders.findMany({ where: { exchange_order_id: null } })).length).toBe(1);
  });

  it("ANDs multiple columns together", async () => {
    const rows = await db.orders.findMany({
      where: { status: "pending", created_at: { gt: 1000 } },
    });
    expect(rows.map((row) => row.id)).toEqual(["ord-2", "ord-4"]);
  });

  it("orders, limits and offsets", async () => {
    const rows = await db.orders.findMany({
      orderBy: [{ column: "created_at", direction: "desc" }],
      limit: 2,
      offset: 1,
    });
    expect(rows.map((row) => row.id)).toEqual(["ord-3", "ord-2"]);
  });

  it("orders by several columns", async () => {
    const rows = await db.orders.findMany({
      orderBy: [
        { column: "status", direction: "asc" },
        { column: "created_at", direction: "desc" },
      ],
    });
    expect(rows.map((row) => row.id)).toEqual(["ord-3", "ord-1", "ord-4", "ord-2", "ord-0"]);
  });

  it("rejects a column the table does not have", async () => {
    expect(
      await codeOf(() =>
        // @ts-expect-error -- rejected at compile time as well as at runtime.
        db.orders.findMany({ where: { nonexistent: 1 } }),
      ),
    ).toBe("unknown_column");
  });

  it("rejects an empty `in` rather than silently matching nothing", async () => {
    expect(await codeOf(() => db.orders.findMany({ where: { status: { in: [] } } }))).toBe(
      "unsupported_filter",
    );
  });

  it("rejects filtering on a JSON column", async () => {
    expect(
      await codeOf(() =>
        db.botInstances.findMany({ where: { strategy_params_json: { steps: 3 } } }),
      ),
    ).toBe("unsupported_filter");
  });

  it("rejects an offset with no limit", async () => {
    expect(await codeOf(() => db.orders.findMany({ offset: 2 }))).toBe("unsupported_filter");
  });

  it("rejects a negative limit", async () => {
    expect(await codeOf(() => db.orders.findMany({ limit: -1 }))).toBe("unsupported_filter");
  });

  it("ignores an explicitly undefined filter value", async () => {
    // Lets a caller build a filter object with optional parts without having to
    // conditionally spread it.
    const rows = await db.orders.findMany({ where: { status: "pending", exchange_order_id: undefined } });
    expect(rows.length).toBe(3);
  });
});

describe("update", () => {
  beforeEach(async () => {
    await db.botInstances.insert(botInstanceRow());
    await db.orders.insert(orderRow());
  });

  it("applies a partial patch and reports the row count", async () => {
    const changed = await db.orders.update(
      { id: "ord-1" },
      { filled_quantity: 50_000n, status: "partially_filled", updated_at: 1_760_000_000_500 },
    );
    expect(changed).toBe(1);

    const row = await db.orders.findOne({ id: "ord-1" });
    expect(row?.filled_quantity).toBe(50_000n);
    expect(row?.status).toBe("partially_filled");
    expect(row?.price).toBe(6_500_000_000_000n); // untouched
  });

  it("can set a nullable column back to null", async () => {
    await db.orders.update({ id: "ord-1" }, { exchange_order_id: null });
    expect((await db.orders.findOne({ id: "ord-1" }))?.exchange_order_id).toBeNull();
  });

  it("reports 0 when the filter matches nothing", async () => {
    expect(await db.orders.update({ id: "nope" }, { status: "filled" })).toBe(0);
  });

  it("refuses an update with no WHERE clause", async () => {
    // An unfiltered UPDATE rewrites every row. Being unable to express one is
    // the point.
    expect(await codeOf(() => db.orders.update({}, { status: "filled" }))).toBe(
      "empty_statement",
    );
    expect((await db.orders.findOne({ id: "ord-1" }))?.status).toBe("pending");
  });

  it("refuses an update with no fields", async () => {
    expect(await codeOf(() => db.orders.update({ id: "ord-1" }, {}))).toBe("empty_statement");
  });

  it("has no delete method at all", () => {
    // Section 8.7 retains everything. There is nothing to call.
    expect("delete" in db.orders).toBe(false);
    expect("deleteWhere" in db.orders).toBe(false);
  });
});

describe("batch", () => {
  beforeEach(async () => {
    await db.botInstances.insert(botInstanceRow());
    await db.orders.insert(orderRow());
  });

  it("applies several statements across tables", async () => {
    await db.batch([
      db.trades.insertStatement(tradeRow()),
      db.orders.updateStatement(
        { id: "ord-1" },
        { filled_quantity: 150_000n, status: "filled" },
      ),
      db.auditLog.insertStatement(auditLogRow({ action: "fill.recorded" })),
    ]);

    expect(await db.trades.count()).toBe(1);
    expect((await db.orders.findOne({ id: "ord-1" }))?.status).toBe("filled");
    expect(await db.auditLog.count()).toBe(1);
  });

  it("rolls the whole batch back if any statement fails", async () => {
    // The reason recording a fill must be batched: the trade row and the
    // order's new filled_quantity have to land together or not at all.
    await expect(
      db.batch([
        db.trades.insertStatement(tradeRow()),
        // Violates the no_overfill CHECK: 999999 > quantity 150000.
        db.orders.updateStatement({ id: "ord-1" }, { filled_quantity: 999_999n }),
      ]),
    ).rejects.toThrow();

    expect(await db.trades.count()).toBe(0);
    expect((await db.orders.findOne({ id: "ord-1" }))?.filled_quantity).toBe(0n);
  });

  it("accepts an empty batch", async () => {
    await expect(db.batch([])).resolves.toBeUndefined();
  });
});

describe("identifier validation", () => {
  it("rejects a table name that is not a plain lowercase identifier", () => {
    let code = "";
    try {
      defineTable(`orders"; DROP TABLE orders; --`, { id: text() });
    } catch (error) {
      code = error instanceof DatabaseError ? error.code : "wrong type";
    }
    expect(code).toBe("invalid_identifier");
  });

  it("rejects a column name that is not a plain lowercase identifier", () => {
    let code = "";
    try {
      defineTable("orders", { "id; --": text() });
    } catch (error) {
      code = error instanceof DatabaseError ? error.code : "wrong type";
    }
    expect(code).toBe("invalid_identifier");
  });

  it("accepts the eight real tables", () => {
    // defineTable validates at module load, so importing schema.ts at all is
    // most of this assertion; naming it keeps the guarantee visible.
    expect(db.orders.tableName).toBe("orders");
    expect(db.botInstances.tableName).toBe("bot_instances");
  });
});

describe("select-list generation", () => {
  it("wraps only money columns in CAST", async () => {
    // Asserted through behaviour elsewhere; here directly, because this single
    // string is what the whole precision guarantee rests on.
    const spec = defineTable("probe_table", { id: text(), amount: money() });
    const captured: string[] = [];
    const fakeD1 = {
      prepare(sql: string) {
        captured.push(sql);
        return {
          bind: () => ({ all: async () => ({ results: [] }) }),
        };
      },
    } as unknown as D1Database;

    await new Repository(fakeD1, spec).findMany();
    expect(captured[0]).toBe(
      `SELECT "id", CAST("amount" AS TEXT) AS "amount" FROM "probe_table"`,
    );
  });
});
