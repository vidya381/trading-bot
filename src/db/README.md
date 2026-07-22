# `/src/db` — D1 access layer

Spec section 8.2, build step 4. The eight cross-bot reporting tables and the
only code permitted to talk to D1.

Durable Object storage stays the source of truth per bot instance (section 8.1).
This is the mirrored, queryable copy that reporting, reconciliation and the
dashboard read.

## Files

| File | What it is |
| --- | --- |
| `columns.ts` | Column kinds and their codecs. Where the money convention is enforced. |
| `table.ts` | `defineTable` and `Repository`: SQL generation, filters, ordering. |
| `schema.ts` | The eight tables as typed specs, plus their row types. |
| `database.ts` | `Database`: wraps the binding, exposes one repository per table. |
| `test-helpers.ts` | Test-only. Applies migrations, empties tables, builds fixture rows. |

The migrations themselves live in `/migrations`, not here. They are
authoritative — they are what a deploy runs — and `schema.test.ts` compares them
against `schema.ts` column by column, including column *order*, so the two
cannot drift. That order check is why `bot_instances.capital_asset`, added by
migration 0002 for step 5, sits last in the spec rather than beside
`account_label`: `ALTER TABLE ADD COLUMN` appends.

## Using it

```ts
const db = new Database(env.DB);

await db.orders.insert({
  id: "ord-1",
  bot_instance_id: "dca-btc-1",
  client_order_id: "v1-dca-btc-1-1",
  exchange_order_id: null,
  side: "buy",
  price: fromDecimalString("65000.0"),   // bigint, scale 8
  quantity: fromDecimalString("0.0015"),
  filled_quantity: ZERO,
  status: "pending",
  created_at: now,
  updated_at: now,
});

const open = await db.orders.findMany({
  where: { bot_instance_id: "dca-btc-1", status: { in: ["pending", "partially_filled"] } },
  orderBy: [{ column: "created_at", direction: "asc" }],
});

const allocated = await db.capitalLedger.sumMoney("total_allocated", { account_label: "main" });
```

Every column is required at insert time; a nullable one must be given as an
explicit `null`. There is no `.withDefault()` and nothing relies on the SQL
DEFAULTs, because an omitted field would be a silent NULL, and in a table of
money and order states that is worse than a longer call.

Writes that must land together go through `db.batch([...])` with the
`insertStatement` / `updateStatement` builders. D1 rolls a failed batch back
whole, which is what recording a fill needs: the trade row and the order's new
`filled_quantity` both land or neither does.

## Why the money rules are structural rather than documented

D1 has two sharp edges around 64-bit integers, both verified in this runtime
rather than assumed:

- `.bind(someBigint)` throws `D1_TYPE_ERROR: Type 'bigint' not supported`.
- A D1 `INTEGER` read comes back as a JavaScript `number`, which silently loses
  precision above 2^53. `100000000000000001` returns as `100000000000000000`.

So money is written as the decimal string from `toStorageString` and read via
`CAST(col AS TEXT)` then `fromStorageString`. Step 2's open question 5 asked for
that to be impossible to bypass rather than a rule people remember. Four things
make it so:

1. **No SQL surface.** `Repository` has no method that takes SQL and no method
   that takes bind values. Statements are generated from the declared columns.
2. **Encoders cannot return a bigint.** `encode` is typed to return `Bindable`
   (`string | number | null`). A money encoder that forgot to stringify would
   not compile.
3. **Select lists are generated.** Money columns are always wrapped in `CAST`.
   Reading one as a number is not an available code path; if a value somehow
   arrives as a number anyway, `decode` throws rather than accepting it.
4. **`no-raw-d1.test.ts` fails the build** if any file outside this folder calls
   `.prepare(`, names `D1Database`, or reaches for `env.DB`. That covers the one
   bypass the type system cannot: going around the layer entirely.

Underneath all of that, every table is `STRICT`. Without it, an `INTEGER` column
accepts `"not-a-number"` and stores it as text; with it, that write fails, and so
does a formatted decimal like `"1234.50000000"` — the specific accident of
binding `toDecimalString` where `toStorageString` was meant.

## Deliberate omissions

- **No `delete`.** Section 8.7 retains all data indefinitely. A layer with no
  delete method cannot violate that by accident. `test-helpers.ts` empties
  tables with raw SQL, and is the only place that does.
- **No unfiltered `UPDATE`.** An update with no `WHERE` rewrites every row, so
  it raises `empty_statement` instead.
- **No filtering on JSON columns.** A bare object filter value is ambiguous with
  a comparison operator, and nothing needs it.

## One non-obvious thing

`ORDER BY` is emitted qualified (`"orders"."price"`), and that is load-bearing.
SQLite resolves a bare identifier in `ORDER BY` against the *output column
aliases* first. Since the select list aliases each money column back to its own
name, `ORDER BY "price"` would bind to the `CAST`ed TEXT result and sort
lexicographically — `1000000000` before `80000000`. This was a real bug, caught
by a test running against real D1; a mocked database would have passed it.
