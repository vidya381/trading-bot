import { describe, expect, it } from "vitest";
import { MoneyError } from "../shared/money";
import {
  boolean,
  DatabaseError,
  integer,
  json,
  money,
  nullable,
  text,
} from "./columns";

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof DatabaseError) return error.code;
    return `${(error as Error).name}: not a DatabaseError`;
  }
  return "no error thrown";
}

describe("money columns", () => {
  it("is the only kind that rewrites its select expression", () => {
    expect(money().selectExpression(`"price"`)).toBe(`CAST("price" AS TEXT)`);
    expect(integer().selectExpression(`"created_at"`)).toBe(`"created_at"`);
    expect(text().selectExpression(`"pair"`)).toBe(`"pair"`);
    expect(boolean().selectExpression(`"resolved"`)).toBe(`"resolved"`);
    expect(json().selectExpression(`"details_json"`)).toBe(`"details_json"`);
  });

  it("encodes a bigint to a decimal string, never a bigint", () => {
    const encoded = money().encode(123_456_789_012_345_678n, "orders.price");
    expect(encoded).toBe("123456789012345678");
    expect(typeof encoded).toBe("string");
  });

  it("encodes negative and zero values", () => {
    expect(money().encode(-1n, "x")).toBe("-1");
    expect(money().encode(0n, "x")).toBe("0");
  });

  it("refuses a number, even an integral one", () => {
    // The mistake this exists to catch: `price: 65000` instead of `65000n`.
    expect(codeOf(() => money().encode(65_000, "orders.price"))).toBe("encode_failed");
  });

  it("refuses a decimal string, which would silently become REAL", () => {
    expect(codeOf(() => money().encode("1.5", "orders.price"))).toBe("encode_failed");
  });

  it("refuses a value outside the signed 64-bit column range", () => {
    // Thrown by toStorageString, before D1 or SQLite ever see it.
    expect(() => money().encode(2n ** 63n, "orders.price")).toThrow(MoneyError);
  });

  it("decodes a CAST string back to an exact bigint", () => {
    expect(money().decode("100000000000000001", "orders.price")).toBe(
      100_000_000_000_000_001n,
    );
  });

  it("refuses to decode a number, naming the missing CAST", () => {
    // Only reachable if something bypassed the layer's select builder. By this
    // point the value is already wrong; the error says why rather than
    // returning a plausible-looking bigint built from a lossy number.
    let message = "";
    try {
      money().decode(100_000_000_000_000_001, "orders.price");
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("CAST");
    expect(codeOf(() => money().decode(1, "orders.price"))).toBe("decode_failed");
  });

  it("refuses a null into a NOT NULL column", () => {
    expect(codeOf(() => money().encode(null, "orders.price"))).toBe("encode_failed");
    expect(codeOf(() => money().encode(undefined, "orders.price"))).toBe("encode_failed");
  });

  it("refuses a null read back from a NOT NULL column", () => {
    expect(codeOf(() => money().decode(null, "orders.price"))).toBe("decode_failed");
  });
});

describe("nullable()", () => {
  it("passes null through in both directions", () => {
    const column = nullable(money());
    expect(column.encode(null, "x")).toBe(null);
    expect(column.decode(null, "x")).toBe(null);
  });

  it("keeps the underlying codec for non-null values", () => {
    const column = nullable(money());
    expect(column.encode(5n, "x")).toBe("5");
    expect(column.decode("5", "x")).toBe(5n);
    expect(column.selectExpression(`"x"`)).toBe(`CAST("x" AS TEXT)`);
  });

  it("does not mutate the column it wraps", () => {
    const base = money();
    nullable(base);
    expect(codeOf(() => base.encode(null, "x"))).toBe("encode_failed");
  });
});

describe("integer columns", () => {
  it("round-trips a safe integer", () => {
    expect(integer().encode(1_760_000_000_000, "t")).toBe(1_760_000_000_000);
    expect(integer().decode(1_760_000_000_000, "t")).toBe(1_760_000_000_000);
  });

  it("refuses a non-integer, a bigint, and a value past 2^53", () => {
    expect(codeOf(() => integer().encode(1.5, "t"))).toBe("encode_failed");
    expect(codeOf(() => integer().encode(5n, "t"))).toBe("encode_failed");
    expect(codeOf(() => integer().encode(2 ** 53, "t"))).toBe("encode_failed");
  });

  it("refuses a value past 2^53 on the way out too", () => {
    expect(codeOf(() => integer().decode(2 ** 53, "t"))).toBe("decode_failed");
  });
});

describe("text columns", () => {
  it("round-trips", () => {
    expect(text().encode("BTCUSDT", "pair")).toBe("BTCUSDT");
    expect(text().decode("BTCUSDT", "pair")).toBe("BTCUSDT");
  });

  it("refuses a non-string", () => {
    expect(codeOf(() => text().encode(5, "pair"))).toBe("encode_failed");
    expect(codeOf(() => text().decode(5, "pair"))).toBe("decode_failed");
  });
});

describe("boolean columns", () => {
  it("stores 1 and 0, reads true and false", () => {
    expect(boolean().encode(true, "resolved")).toBe(1);
    expect(boolean().encode(false, "resolved")).toBe(0);
    expect(boolean().decode(1, "resolved")).toBe(true);
    expect(boolean().decode(0, "resolved")).toBe(false);
  });

  it("refuses anything else in either direction", () => {
    expect(codeOf(() => boolean().encode(1, "resolved"))).toBe("encode_failed");
    expect(codeOf(() => boolean().decode(2, "resolved"))).toBe("decode_failed");
    expect(codeOf(() => boolean().decode("1", "resolved"))).toBe("decode_failed");
  });
});

describe("json columns", () => {
  it("round-trips an object", () => {
    const column = json<{ a: number }>();
    const encoded = column.encode({ a: 1 }, "params");
    expect(encoded).toBe(`{"a":1}`);
    expect(column.decode(encoded, "params")).toEqual({ a: 1 });
  });

  it("reports unserializable input and invalid stored JSON", () => {
    const circular: Record<string, unknown> = {};
    circular["self"] = circular;
    expect(codeOf(() => json().encode(circular, "params"))).toBe("encode_failed");
    expect(codeOf(() => json().decode("{not json", "params"))).toBe("decode_failed");
  });
});
