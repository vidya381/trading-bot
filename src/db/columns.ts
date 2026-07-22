/**
 * Column kinds: the codecs that make the D1 money convention structural.
 *
 * Step 2's open question 5 asked for the CAST-on-read rule to be enforced
 * centrally, "impossible by construction, not by discipline". This file is
 * where that happens. Each column kind owns three things:
 *
 *   selectExpression -- how the column must appear in a SELECT list. For money
 *                       that is `CAST("col" AS TEXT)`, never the bare column.
 *   encode           -- decoded value -> something D1's .bind() accepts. The
 *                       return type is `Bindable`, which deliberately excludes
 *                       bigint, so a money encoder that forgot to stringify
 *                       would not compile.
 *   decode           -- raw D1 value -> decoded value.
 *
 * Nothing outside /src/db builds a SELECT list or calls .bind(), so there is
 * no code path that reads a money column as a JS number or writes one as a
 * raw bigint. Both mistakes are unrepresentable rather than merely discouraged.
 */

import { fromStorageString, toStorageString, type Money } from "../shared/money";

/**
 * The value types D1's `.bind()` actually accepts.
 *
 * `bigint` is absent on purpose -- D1 rejects it at runtime with
 * "Type 'bigint' not supported" (step 2's probe). Because every encoder is
 * typed to return this, the type checker refuses any encoder that would let a
 * bigint through.
 */
export type Bindable = string | number | null;

export type ColumnKind = "money" | "integer" | "text" | "boolean" | "json";

export class DatabaseError extends Error {
  readonly code: DatabaseErrorCode;
  constructor(code: DatabaseErrorCode, message: string) {
    super(message);
    this.name = "DatabaseError";
    this.code = code;
  }
}

/**
 * Typed codes rather than plain throws, following step 2's decision 8. Section
 * 7.5 escalates an unhandled exception to a halt plus alert, so a caller needs
 * to be able to tell a genuine data problem from a programming mistake.
 */
export type DatabaseErrorCode =
  /** A value did not match its column's kind on the way in. */
  | "encode_failed"
  /** A stored value did not match its column's kind on the way out. */
  | "decode_failed"
  /** A table or column name that is not a plain lowercase identifier. */
  | "invalid_identifier"
  /** A filter referenced a column the table does not declare. */
  | "unknown_column"
  /** A filter shape the query builder cannot express. */
  | "unsupported_filter"
  /** An update or insert with nothing in it. */
  | "empty_statement"
  /** The environment declares no `DB` binding. See `databaseFrom`. */
  | "missing_binding";

export interface ColumnDefinition<
  TKind extends ColumnKind,
  TValue,
  TNullable extends boolean,
> {
  readonly kind: TKind;
  readonly nullable: TNullable;
  /** SQL for reading this column, given its already-quoted name. */
  readonly selectExpression: (quotedName: string) => string;
  readonly encode: (value: unknown, column: string) => Bindable;
  readonly decode: (raw: unknown, column: string) => TValue | null;
}

/**
 * Any column, for use in generic constraints only.
 *
 * `any` in the value slot is load-bearing: `never` would break assignability
 * (a column's `decode` returns `TValue | null`, which is covariant), and
 * `unknown` would stop concrete columns matching the constraint at all.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyColumn = ColumnDefinition<ColumnKind, any, boolean>;

/** The decoded TypeScript type of a column, including its nullability. */
export type ColumnValue<TColumn> =
  TColumn extends ColumnDefinition<ColumnKind, infer TValue, infer TNullable>
    ? TNullable extends true
      ? TValue | null
      : TValue
    : never;

interface Codec<TKind extends ColumnKind, TValue> {
  readonly kind: TKind;
  readonly selectExpression: (quotedName: string) => string;
  readonly encode: (value: unknown, column: string) => Bindable;
  readonly decode: (raw: unknown, column: string) => TValue;
}

/**
 * A column, with `.nullable()` as the only modifier.
 *
 * There is no `.withDefault()`. Every column is required at insert time, and a
 * nullable one must be given explicitly as `null`. SQL DEFAULTs still exist in
 * the migration, but nothing in this layer relies on them: an omitted field
 * would be a silent NULL, and in a table of money and order states that is a
 * worse failure than a slightly longer insert call.
 */
class Column<TKind extends ColumnKind, TValue, TNullable extends boolean>
  implements ColumnDefinition<TKind, TValue, TNullable>
{
  readonly kind: TKind;
  readonly nullable: TNullable;
  readonly selectExpression: (quotedName: string) => string;
  readonly encode: (value: unknown, column: string) => Bindable;
  readonly decode: (raw: unknown, column: string) => TValue | null;

  constructor(codec: Codec<TKind, TValue>, nullable: TNullable) {
    this.kind = codec.kind;
    this.nullable = nullable;
    this.selectExpression = codec.selectExpression;
    this.encode = (value, column) => {
      if (value === null || value === undefined) {
        if (!nullable) {
          throw new DatabaseError(
            "encode_failed",
            `${column} is NOT NULL but was given ${String(value)}`,
          );
        }
        return null;
      }
      return codec.encode(value, column);
    };
    this.decode = (raw, column) => {
      if (raw === null || raw === undefined) {
        if (!nullable) {
          throw new DatabaseError(
            "decode_failed",
            `${column} is NOT NULL but read back ${String(raw)}`,
          );
        }
        return null;
      }
      return codec.decode(raw, column);
    };
    this.#codec = codec;
  }

  readonly #codec: Codec<TKind, TValue>;

  /** Widen this column to allow NULL. */
  asNullable(): Column<TKind, TValue, true> {
    return new Column(this.#codec, true);
  }
}

const MONEY_CODEC: Codec<"money", Money> = {
  kind: "money",
  // The entire point of this file. A money column is never selected bare.
  selectExpression: (quotedName) => `CAST(${quotedName} AS TEXT)`,
  encode: (value, column) => {
    if (typeof value !== "bigint") {
      throw new DatabaseError(
        "encode_failed",
        `${column} is a money column and takes a bigint, got ${typeof value}`,
      );
    }
    // Throws if the value will not fit a signed 64-bit column, so an
    // out-of-range balance fails here rather than being mangled by storage.
    return toStorageString(value);
  },
  decode: (raw, column) => {
    if (typeof raw === "number") {
      // Only reachable if something bypassed this layer's SELECT builder.
      // Loud on purpose: a money column read without CAST is already wrong by
      // the time it gets here, silently, for any value above 2^53.
      throw new DatabaseError(
        "decode_failed",
        `${column} came back as a JS number, which means it was read without ` +
          `CAST(${column} AS TEXT) and has already lost precision`,
      );
    }
    if (typeof raw !== "string") {
      throw new DatabaseError(
        "decode_failed",
        `${column} is a money column and expected a string from CAST, got ${typeof raw}`,
      );
    }
    return fromStorageString(raw);
  },
};

const INTEGER_CODEC: Codec<"integer", number> = {
  kind: "integer",
  selectExpression: (quotedName) => quotedName,
  encode: (value, column) => {
    if (typeof value !== "number" || !Number.isSafeInteger(value)) {
      throw new DatabaseError(
        "encode_failed",
        `${column} is an integer column and takes a safe integer, got ${String(value)}`,
      );
    }
    return value;
  },
  decode: (raw, column) => {
    if (typeof raw !== "number" || !Number.isSafeInteger(raw)) {
      throw new DatabaseError(
        "decode_failed",
        `${column} read back ${String(raw)}, which is not a safe integer`,
      );
    }
    return raw;
  },
};

function textCodec<TValue extends string>(): Codec<"text", TValue> {
  return {
    kind: "text",
    selectExpression: (quotedName) => quotedName,
    encode: (value, column) => {
      if (typeof value !== "string") {
        throw new DatabaseError(
          "encode_failed",
          `${column} is a text column and takes a string, got ${typeof value}`,
        );
      }
      return value;
    },
    decode: (raw, column) => {
      if (typeof raw !== "string") {
        throw new DatabaseError(
          "decode_failed",
          `${column} is a text column and read back ${typeof raw}`,
        );
      }
      return raw as TValue;
    },
  };
}

const BOOLEAN_CODEC: Codec<"boolean", boolean> = {
  kind: "boolean",
  selectExpression: (quotedName) => quotedName,
  encode: (value, column) => {
    if (typeof value !== "boolean") {
      throw new DatabaseError(
        "encode_failed",
        `${column} is a boolean column and takes a boolean, got ${typeof value}`,
      );
    }
    return value ? 1 : 0;
  },
  decode: (raw, column) => {
    if (raw !== 0 && raw !== 1) {
      throw new DatabaseError(
        "decode_failed",
        `${column} is a boolean column and read back ${String(raw)}, expected 0 or 1`,
      );
    }
    return raw === 1;
  },
};

function jsonCodec<TValue>(): Codec<"json", TValue> {
  return {
    kind: "json",
    selectExpression: (quotedName) => quotedName,
    encode: (value, column) => {
      try {
        return JSON.stringify(value);
      } catch (cause) {
        throw new DatabaseError(
          "encode_failed",
          `${column} could not be serialized to JSON: ${String(cause)}`,
        );
      }
    },
    decode: (raw, column) => {
      if (typeof raw !== "string") {
        throw new DatabaseError(
          "decode_failed",
          `${column} is a JSON column and read back ${typeof raw}`,
        );
      }
      try {
        return JSON.parse(raw) as TValue;
      } catch (cause) {
        throw new DatabaseError(
          "decode_failed",
          `${column} did not contain valid JSON: ${String(cause)}`,
        );
      }
    },
  };
}

/**
 * A monetary column: a bigint at scale 8, stored as INTEGER.
 *
 * Reads are wrapped in CAST(... AS TEXT) automatically; writes go through
 * `toStorageString`. Neither is optional and neither is the caller's problem.
 */
export function money(): Column<"money", Money, false> {
  return new Column(MONEY_CODEC, false);
}

/**
 * A plain integer column: row counts, `schema_version`, and every `*_at`
 * timestamp (Unix epoch milliseconds).
 *
 * Safe to read directly, unlike money -- milliseconds and version numbers stay
 * far inside 2^53. `Number.isSafeInteger` is enforced on both sides anyway, so
 * a value that ever approached the ceiling would fail loudly.
 */
export function integer(): Column<"integer", number, false> {
  return new Column(INTEGER_CODEC, false);
}

/** A text column, optionally narrowed to a union: `text<OrderState>()`. */
export function text<TValue extends string = string>(): Column<"text", TValue, false> {
  return new Column(textCodec<TValue>(), false);
}

/** An INTEGER column holding 0 or 1, decoded as a boolean. */
export function boolean(): Column<"boolean", boolean, false> {
  return new Column(BOOLEAN_CODEC, false);
}

/** A TEXT column holding JSON, decoded to `TValue` without validation. */
export function json<TValue>(): Column<"json", TValue, false> {
  return new Column(jsonCodec<TValue>(), false);
}

/** Wrap any column to allow NULL, both in and out. */
export function nullable<TKind extends ColumnKind, TValue>(
  column: Column<TKind, TValue, false>,
): Column<TKind, TValue, true> {
  return column.asNullable();
}

export type { Column };
