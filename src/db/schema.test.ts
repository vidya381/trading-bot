/**
 * Drift guard: the TypeScript table specs versus the real migrated database.
 *
 * The migration is authoritative -- it is what a deploy runs. schema.ts is how
 * TypeScript sees it. Nothing keeps the two in step except this file, which
 * reads the live schema out of D1 and compares it column by column.
 *
 * The failure mode it exists for: someone adds a column to the migration and
 * not to the spec (invisible to the layer, so silently unwritable) or to the
 * spec and not the migration (a runtime "no such column" at the worst moment).
 */

import { beforeAll, describe, expect, it } from "vitest";
import type { ColumnKind } from "./columns";
import { ALL_TABLES } from "./schema";
import { freshDatabase, rawD1 } from "./test-helpers";

interface TableInfoRow {
  cid: number;
  name: string;
  type: string;
  notnull: number;
  pk: number;
}

/** The SQLite declared type each column kind must map to. */
const EXPECTED_SQL_TYPE: Record<ColumnKind, string> = {
  money: "INTEGER",
  integer: "INTEGER",
  boolean: "INTEGER",
  text: "TEXT",
  json: "TEXT",
};

beforeAll(async () => {
  await freshDatabase();
});

async function tableInfo(table: string): Promise<TableInfoRow[]> {
  const result = await rawD1().prepare(`PRAGMA table_info("${table}")`).all<TableInfoRow>();
  return result.results;
}

async function createSql(table: string): Promise<string> {
  const row = await rawD1()
    .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .bind(table)
    .first<{ sql: string }>();
  return row?.sql ?? "";
}

describe.each(Object.values(ALL_TABLES).map((spec) => [spec.name, spec] as const))(
  "%s",
  (name, spec) => {
    it("exists", async () => {
      expect(await createSql(name)).not.toBe("");
    });

    it("has exactly the columns the spec declares, in the same order", async () => {
      const live = (await tableInfo(name)).map((column) => column.name);
      expect(live).toEqual(Object.keys(spec.columns));
    });

    it("stores each column as the SQLite type its kind requires", async () => {
      const live = await tableInfo(name);
      const actual = Object.fromEntries(live.map((column) => [column.name, column.type]));
      const expected = Object.fromEntries(
        Object.entries(spec.columns).map(([column, definition]) => [
          column,
          EXPECTED_SQL_TYPE[definition.kind as ColumnKind],
        ]),
      );
      expect(actual).toEqual(expected);
    });

    it("agrees with the spec on which columns are nullable", async () => {
      const live = await tableInfo(name);
      const actual = Object.fromEntries(
        // A PRIMARY KEY column is NOT NULL in a STRICT table regardless of
        // how it was declared, so read nullability from both flags.
        live.map((column) => [column.name, column.notnull === 0 && column.pk === 0]),
      );
      const expected = Object.fromEntries(
        Object.entries(spec.columns).map(([column, definition]) => [
          column,
          definition.nullable,
        ]),
      );
      expect(actual).toEqual(expected);
    });

    it("is a STRICT table", async () => {
      // Without STRICT, an INTEGER money column accepts and silently stores a
      // TEXT value. Asserted per table so a table added later cannot omit it.
      expect(await createSql(name)).toMatch(/\)\s*STRICT$/);
    });
  },
);

describe("the schema as a whole", () => {
  it("declares section 8.2's eight tables, plus the circuit breaker", async () => {
    const result = await rawD1()
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'table'
           AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'd1_%' AND name NOT LIKE '_cf_%'
         ORDER BY name`,
      )
      .all<{ name: string }>();

    expect(result.results.map((row) => row.name)).toEqual([
      // Not in section 8.2. Added by migration 0006 at step 11: the account
      // registry, making account -> exchange a validated fact so bot creation
      // can dispatch to the right exchange client instead of trusting a
      // free-typed string.
      "accounts",
      "alerts",
      "audit_log",
      "balance_snapshots",
      "bot_instances",
      "capital_ledger",
      // Not in section 8.2. Added by migration 0003 at step 7, because
      // section 9's severe tier requires the section 7.3 circuit breaker to
      // exist as a real, latching control rather than a paragraph.
      "circuit_breakers",
      // Not in section 8.2. Added by migration 0005 at step 10.3, the global
      // sibling of circuit_breakers: section 7.4's kill switch needs its own
      // latch, separate from any account's breaker.
      "global_kill_switch",
      "manual_adjustments",
      "orders",
      // Not in section 8.2. Added by migration 0009: spec 21.5 requirement 5's
      // permanent proposal record. Section 8.2 names `audit_log` as the audit
      // practice this mirrors, and the migration's header argues at length why a
      // proposal cannot BE an `audit_log` row -- an audit entry is an immutable
      // event, a proposal has a lifecycle whose outcome arrives later.
      "proposals",
      "trades",
      // Not in section 8.2. Added by migration 0008: the section 21.3 fixed
      // watchlist, moved out of code/config so the research pipeline's
      // candidate list is editable without a deploy. Storage only -- nothing
      // in section 21 beyond this table exists yet.
      "watchlist",
    ]);
  });

  it("has a money column wherever the spec describes a monetary value", async () => {
    // Named explicitly rather than derived, so adding a money column to the
    // migration without adding it here is a visible diff rather than a silent
    // pass. Every one of these must be INTEGER, never TEXT and never REAL.
    const expected: Record<string, readonly string[]> = {
      // The account registry holds a label, an exchange, and timestamps -- no
      // amount of any kind (step 11).
      accounts: [],
      bot_instances: ["stop_loss_pct", "take_profit_pct", "allocated_capital"],
      capital_ledger: ["total_balance", "total_allocated"],
      orders: ["price", "quantity", "filled_quantity"],
      trades: [
        "price",
        "quantity",
        "fee_amount",
        "fee_reporting_amount",
        "fee_conversion_rate",
      ],
      balance_snapshots: [
        "exchange_reported_balance",
        "internal_calculated_balance",
        "discrepancy",
      ],
      manual_adjustments: ["amount"],
      audit_log: [],
      alerts: [],
      // No money at all: it records a latch, not an amount. Section 7.3's
      // daily-loss THRESHOLD would be a money column, and it is deliberately
      // not built yet -- see circuit-breaker.ts's header.
      circuit_breakers: [],
      // Also a latch, not an amount. Section 7.4 is a one-click emergency stop,
      // with no threshold of its own.
      global_kill_switch: [],
      // A list of pairs and who chose them. The one bound it carries -- 21.3's
      // 10 entries -- is a ROW COUNT, not a monetary amount, and lives in
      // /src/research/watchlist.ts.
      watchlist: [],
      // NO MONEY COLUMN, AND THAT IS A DECISION RATHER THAN AN OVERSIGHT
      // (migration 0009). A proposal certainly contains monetary values -- the
      // proposed `allocatedCapital`, `orderSize`, the bounds, the headroom read --
      // but every one of them lives inside `reasoning_json` / `inputs_json`,
      // rendered by the SAME `serialize.ts` views that put them on the wire, as
      // exact decimal strings.
      //
      // Hoisting one into a column would create a SECOND copy of a figure whose
      // first copy is the audit record itself, and the copy that drifts is the one
      // nobody is watching. There is also nothing to hoist it FOR: no query needs
      // to sum or filter proposals by amount, and 21.5's own measurement is a
      // count of unresolved rows.
      proposals: [],
    };

    for (const spec of Object.values(ALL_TABLES)) {
      const declared = Object.entries(spec.columns)
        .filter(([, definition]) => definition.kind === "money")
        .map(([column]) => column);
      expect({ [spec.name]: declared }).toEqual({ [spec.name]: expected[spec.name] });

      const live = await tableInfo(spec.name);
      for (const column of declared) {
        expect(live.find((info) => info.name === column)?.type).toBe("INTEGER");
      }
    }
  });

  it("indexes the child side of every foreign key", async () => {
    // SQLite indexes the parent's key automatically but not the child's, so an
    // unindexed FK column means a full scan of a table that section 8.7 never
    // prunes, on every join.
    //
    // D1 refuses the pragma_* table-valued functions (SQLITE_AUTH), so this
    // walks index_list/index_info per table instead of joining them.
    for (const table of ["orders", "trades", "audit_log", "alerts"]) {
      const indexes = await rawD1()
        .prepare(`PRAGMA index_list("${table}")`)
        .all<{ name: string }>();

      const leadingColumns = new Set<string>();
      for (const index of indexes.results) {
        const info = await rawD1()
          .prepare(`PRAGMA index_info("${index.name}")`)
          .all<{ seqno: number; name: string | null }>();
        for (const column of info.results) {
          // Only the leading column: an index on (b, c) does not help a lookup
          // on c alone.
          if (column.seqno === 0 && column.name !== null) leadingColumns.add(column.name);
        }
      }

      const foreignKeys = await rawD1()
        .prepare(`PRAGMA foreign_key_list("${table}")`)
        .all<{ from: string }>();
      expect(foreignKeys.results.length).toBeGreaterThan(0);
      for (const key of foreignKeys.results) {
        expect(`${table}: ${key.from} indexed`).toBe(
          `${table}: ${leadingColumns.has(key.from) ? key.from : "MISSING"} indexed`,
        );
      }
    }
  });
});
