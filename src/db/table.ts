/**
 * The typed table access layer.
 *
 * A `Repository` is the ONLY way application code touches D1. It offers no
 * method that takes SQL, and no method that takes bind parameters. Every
 * statement is generated from the table's declared columns, which means:
 *
 *   - Reads always use the generated select list, so a money column is always
 *     wrapped in CAST(... AS TEXT) and always decoded with `fromStorageString`.
 *     There is no `select(sql)` to route around it.
 *   - Writes always go through a column's `encode`, whose return type excludes
 *     bigint, so a raw bigint can never reach `.bind()`.
 *   - Filter values are encoded by the same codecs, so comparing against a
 *     money column works and compares numerically (SQLite applies the column's
 *     INTEGER affinity to the bound string).
 *
 * There is deliberately no `delete`. Section 8.7 retains all trade, order and
 * log data indefinitely, and a layer with no delete method cannot violate that
 * by accident.
 */

import {
  DatabaseError,
  type AnyColumn,
  type Bindable,
  type ColumnValue,
} from "./columns";
import { fromStorageString, ZERO, type Money } from "../shared/money";

/** A table's columns, keyed by column name. */
export type ColumnMap = Readonly<Record<string, AnyColumn>>;

/**
 * A fully decoded row: every column, with money as bigint and JSON parsed.
 *
 * This is also the insert type. Every column must be supplied, and a nullable
 * one must be given explicitly as `null` -- see the note on `Column` about why
 * there is no optionality here.
 */
export type Row<TColumns extends ColumnMap> = {
  readonly [K in keyof TColumns]: ColumnValue<TColumns[K]>;
};

/** A partial row, for updates. */
export type RowPatch<TColumns extends ColumnMap> = Partial<Row<TColumns>>;

/** The names of a table's money columns, for aggregate helpers. */
export type MoneyColumnName<TColumns extends ColumnMap> = {
  [K in keyof TColumns]: TColumns[K]["kind"] extends "money" ? K : never;
}[keyof TColumns];

/** Comparison operators. A bare value is shorthand for `{ eq: value }`. */
export type Comparison<TValue> =
  | { readonly eq: TValue }
  | { readonly ne: TValue }
  | { readonly gt: TValue }
  | { readonly gte: TValue }
  | { readonly lt: TValue }
  | { readonly lte: TValue }
  | { readonly in: readonly TValue[] }
  | { readonly isNull: true }
  | { readonly isNotNull: true };

const COMPARISON_KEYS = ["eq", "ne", "gt", "gte", "lt", "lte", "in", "isNull", "isNotNull"] as const;

/**
 * A filter. Every key must be a declared column; every value is encoded by
 * that column's codec, so a money filter is bound as a storage string exactly
 * like a money write.
 */
export type Where<TColumns extends ColumnMap> = {
  readonly [K in keyof TColumns]?:
    | ColumnValue<TColumns[K]>
    | Comparison<NonNullable<ColumnValue<TColumns[K]>>>;
};

export interface OrderBy<TColumns extends ColumnMap> {
  readonly column: keyof TColumns & string;
  readonly direction: "asc" | "desc";
}

export interface FindOptions<TColumns extends ColumnMap> {
  readonly where?: Where<TColumns>;
  readonly orderBy?: readonly OrderBy<TColumns>[];
  readonly limit?: number;
  readonly offset?: number;
}

export interface TableSpec<TColumns extends ColumnMap> {
  readonly name: string;
  readonly columns: TColumns;
}

// Identifiers only ever come from the literal table definitions in schema.ts,
// never from a request. Validating them anyway means no string that reaches
// the SQL builder can carry anything but [a-z0-9_], which makes injection
// through an identifier structurally impossible rather than merely unlikely.
const IDENTIFIER = /^[a-z][a-z0-9_]*$/;

function quote(identifier: string): string {
  if (!IDENTIFIER.test(identifier)) {
    throw new DatabaseError(
      "invalid_identifier",
      `${JSON.stringify(identifier)} is not a valid lowercase SQL identifier`,
    );
  }
  return `"${identifier}"`;
}

/** Declare a table. Validates every identifier once, at module load. */
export function defineTable<TColumns extends ColumnMap>(
  name: string,
  columns: TColumns,
): TableSpec<TColumns> {
  quote(name);
  for (const column of Object.keys(columns)) {
    quote(column);
  }
  return { name, columns };
}

function isComparison(value: unknown): value is Comparison<unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const keys = Object.keys(value);
  return (
    keys.length === 1 &&
    (COMPARISON_KEYS as readonly string[]).includes(keys[0] as string)
  );
}

interface Fragment {
  readonly sql: string;
  readonly binds: readonly Bindable[];
}

/**
 * A repository over one table.
 *
 * Every method that runs SQL has a `*Statement` twin that returns an unbound
 * `D1PreparedStatement` instead, so several writes can be handed to
 * `Database.batch` and land atomically. Both share one builder, so the batched
 * form cannot drift from the executed one.
 */
export class Repository<TColumns extends ColumnMap> {
  readonly #db: D1Database;
  readonly #spec: TableSpec<TColumns>;
  readonly #columnNames: readonly (string & keyof TColumns)[];
  readonly #selectList: string;

  constructor(db: D1Database, spec: TableSpec<TColumns>) {
    this.#db = db;
    this.#spec = spec;
    this.#columnNames = Object.keys(spec.columns) as (string & keyof TColumns)[];
    // Built once. Note the alias: CAST(...) AS "col" keeps the result key equal
    // to the column name, so decoding stays a straight per-column lookup.
    this.#selectList = this.#columnNames
      .map((name) => {
        const column = this.#column(name);
        const quoted = quote(name);
        const expression = column.selectExpression(quoted);
        return expression === quoted ? quoted : `${expression} AS ${quoted}`;
      })
      .join(", ");
  }

  get tableName(): string {
    return this.#spec.name;
  }

  #column(name: string & keyof TColumns): AnyColumn {
    const column = this.#spec.columns[name];
    if (column === undefined) {
      throw new DatabaseError(
        "unknown_column",
        `${this.#spec.name} has no column ${JSON.stringify(name)}`,
      );
    }
    return column;
  }

  #encode(name: string & keyof TColumns, value: unknown): Bindable {
    return this.#column(name).encode(value, `${this.#spec.name}.${name}`);
  }

  #where(where: Where<TColumns> | undefined): Fragment {
    if (where === undefined) {
      return { sql: "", binds: [] };
    }
    const clauses: string[] = [];
    const binds: Bindable[] = [];

    for (const key of Object.keys(where)) {
      const name = key as string & keyof TColumns;
      const column = this.#column(name);
      const quoted = quote(name);
      const raw: unknown = (where as Record<string, unknown>)[key];

      if (raw === undefined) continue;

      if (column.kind === "json") {
        // JSON columns hold arbitrary objects, so a bare object filter value is
        // ambiguous with a comparison operator. Nothing needs to filter on one,
        // so this refuses rather than guessing.
        throw new DatabaseError(
          "unsupported_filter",
          `${this.#spec.name}.${name} is a JSON column and cannot be filtered on`,
        );
      }

      if (raw === null) {
        clauses.push(`${quoted} IS NULL`);
        continue;
      }

      if (!isComparison(raw)) {
        clauses.push(`${quoted} = ?`);
        binds.push(this.#encode(name, raw));
        continue;
      }

      const operator = Object.keys(raw)[0] as (typeof COMPARISON_KEYS)[number];
      const operand: unknown = (raw as Record<string, unknown>)[operator];

      switch (operator) {
        case "isNull":
          clauses.push(`${quoted} IS NULL`);
          break;
        case "isNotNull":
          clauses.push(`${quoted} IS NOT NULL`);
          break;
        case "in": {
          if (!Array.isArray(operand) || operand.length === 0) {
            // `IN ()` is a syntax error in SQLite, and silently rewriting it to
            // "match nothing" would hide a caller bug -- an empty id list is
            // almost always an upstream mistake, not an intentional query.
            throw new DatabaseError(
              "unsupported_filter",
              `${this.#spec.name}.${name}: "in" needs a non-empty array`,
            );
          }
          const values: unknown[] = operand;
          clauses.push(`${quoted} IN (${values.map(() => "?").join(", ")})`);
          for (const value of values) binds.push(this.#encode(name, value));
          break;
        }
        default: {
          const sqlOperator = {
            eq: "=",
            ne: "<>",
            gt: ">",
            gte: ">=",
            lt: "<",
            lte: "<=",
          }[operator];
          clauses.push(`${quoted} ${sqlOperator} ?`);
          binds.push(this.#encode(name, operand));
          break;
        }
      }
    }

    return clauses.length === 0
      ? { sql: "", binds: [] }
      : { sql: ` WHERE ${clauses.join(" AND ")}`, binds };
  }

  #tail(options: FindOptions<TColumns>): Fragment {
    let sql = "";
    const binds: Bindable[] = [];

    if (options.orderBy !== undefined && options.orderBy.length > 0) {
      sql += ` ORDER BY ${options.orderBy
        .map((clause) => {
          this.#column(clause.column);
          // Qualified with the table name, and that is load-bearing.
          //
          // SQLite resolves a BARE identifier in ORDER BY against the output
          // column aliases first, and only then against the table. The select
          // list aliases every money column back to its own name
          // (`CAST("price" AS TEXT) AS "price"`), so `ORDER BY "price"` binds
          // to the TEXT result and sorts lexicographically: 1000000000 before
          // 80000000. Qualifying forces resolution to the INTEGER table column.
          //
          // Found by money-precision.test.ts, which is the regression guard.
          return (
            `${quote(this.#spec.name)}.${quote(clause.column)} ` +
            `${clause.direction === "desc" ? "DESC" : "ASC"}`
          );
        })
        .join(", ")}`;
    }

    if (options.limit !== undefined) {
      if (!Number.isSafeInteger(options.limit) || options.limit < 0) {
        throw new DatabaseError("unsupported_filter", `limit must be a non-negative integer`);
      }
      sql += ` LIMIT ?`;
      binds.push(options.limit);
      if (options.offset !== undefined) {
        if (!Number.isSafeInteger(options.offset) || options.offset < 0) {
          throw new DatabaseError("unsupported_filter", `offset must be a non-negative integer`);
        }
        sql += ` OFFSET ?`;
        binds.push(options.offset);
      }
    } else if (options.offset !== undefined) {
      // SQLite requires LIMIT before OFFSET. Rather than silently inserting
      // `LIMIT -1`, say so.
      throw new DatabaseError("unsupported_filter", `offset requires limit`);
    }

    return { sql, binds };
  }

  #decode(raw: Record<string, unknown>): Row<TColumns> {
    const decoded: Record<string, unknown> = {};
    for (const name of this.#columnNames) {
      decoded[name] = this.#column(name).decode(raw[name], `${this.#spec.name}.${name}`);
    }
    return decoded as Row<TColumns>;
  }

  // -------------------------------------------------------------------------
  // Statement builders. Hand these to Database.batch for an atomic write.
  // -------------------------------------------------------------------------

  insertStatement(row: Row<TColumns>): D1PreparedStatement {
    const names = this.#columnNames;
    const binds = names.map((name) => this.#encode(name, (row as Record<string, unknown>)[name]));
    const sql =
      `INSERT INTO ${quote(this.#spec.name)} ` +
      `(${names.map(quote).join(", ")}) VALUES (${names.map(() => "?").join(", ")})`;
    return this.#db.prepare(sql).bind(...binds);
  }

  updateStatement(where: Where<TColumns>, patch: RowPatch<TColumns>): D1PreparedStatement {
    const assignments: string[] = [];
    const binds: Bindable[] = [];

    for (const key of Object.keys(patch)) {
      const name = key as string & keyof TColumns;
      const value: unknown = (patch as Record<string, unknown>)[key];
      if (value === undefined) continue;
      assignments.push(`${quote(name)} = ?`);
      binds.push(this.#encode(name, value));
    }

    if (assignments.length === 0) {
      // An update with nothing to set is always a caller bug, and running it
      // would report a misleading `changes` count.
      throw new DatabaseError("empty_statement", `update on ${this.#spec.name} has no fields`);
    }

    const filter = this.#where(where);
    if (filter.sql === "") {
      // An unfiltered UPDATE rewrites every row in the table. Requiring a
      // filter makes that impossible to do by forgetting one.
      throw new DatabaseError(
        "empty_statement",
        `update on ${this.#spec.name} needs a WHERE clause; ` +
          `an unfiltered update would rewrite the whole table`,
      );
    }

    const sql = `UPDATE ${quote(this.#spec.name)} SET ${assignments.join(", ")}${filter.sql}`;
    return this.#db.prepare(sql).bind(...binds, ...filter.binds);
  }

  // -------------------------------------------------------------------------
  // Executing methods.
  // -------------------------------------------------------------------------

  async insert(row: Row<TColumns>): Promise<void> {
    await this.insertStatement(row).run();
  }

  /** Returns how many rows were changed. */
  async update(where: Where<TColumns>, patch: RowPatch<TColumns>): Promise<number> {
    const result = await this.updateStatement(where, patch).run();
    return result.meta.changes;
  }

  async findMany(options: FindOptions<TColumns> = {}): Promise<Row<TColumns>[]> {
    const filter = this.#where(options.where);
    const tail = this.#tail(options);
    const sql = `SELECT ${this.#selectList} FROM ${quote(this.#spec.name)}${filter.sql}${tail.sql}`;
    const result = await this.#db
      .prepare(sql)
      .bind(...filter.binds, ...tail.binds)
      .all<Record<string, unknown>>();
    return result.results.map((raw) => this.#decode(raw));
  }

  async findOne(where: Where<TColumns>): Promise<Row<TColumns> | null> {
    const rows = await this.findMany({ where, limit: 1 });
    return rows[0] ?? null;
  }

  async count(where?: Where<TColumns>): Promise<number> {
    const filter = this.#where(where);
    const sql = `SELECT COUNT(*) AS n FROM ${quote(this.#spec.name)}${filter.sql}`;
    const row = await this.#db
      .prepare(sql)
      .bind(...filter.binds)
      .first<{ n: number }>();
    return row?.n ?? 0;
  }

  /**
   * SUM a money column, exactly.
   *
   * `CAST(SUM(col) AS TEXT)` keeps the total on SQLite's side as a 64-bit
   * integer and hands it back as a string, so the result is exact past 2^53 in
   * the same way a single-row read is. Summing in JavaScript instead would
   * require reading every row.
   *
   * SUM over no rows returns NULL in SQLite; that becomes 0n here, which is
   * the arithmetically right answer for an empty set and saves every caller a
   * null check.
   */
  async sumMoney(column: MoneyColumnName<TColumns> & string, where?: Where<TColumns>): Promise<Money> {
    const definition = this.#column(column);
    if (definition.kind !== "money") {
      throw new DatabaseError(
        "unknown_column",
        `${this.#spec.name}.${column} is not a money column`,
      );
    }
    const filter = this.#where(where);
    const sql =
      `SELECT CAST(SUM(${quote(column)}) AS TEXT) AS total ` +
      `FROM ${quote(this.#spec.name)}${filter.sql}`;
    const row = await this.#db
      .prepare(sql)
      .bind(...filter.binds)
      .first<{ total: string | null }>();
    const total = row?.total;
    return total === null || total === undefined ? ZERO : fromStorageString(total);
  }
}
