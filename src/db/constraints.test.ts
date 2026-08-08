/**
 * The migration's own guarantees, exercised against real D1.
 *
 * These sit underneath the type layer. Everything here would still hold if a
 * future bug let a bad value past the repository, which is the reason for
 * putting them in the schema rather than only in TypeScript.
 */

import { beforeEach, describe, expect, it } from "vitest";
import type { Database } from "./database";
import {
  accountRow,
  alertRow,
  auditLogRow,
  botInstanceRow,
  capitalLedgerRow,
  freshDatabase,
  orderRow,
  rawD1,
  tradeRow,
  watchlistRow,
} from "./test-helpers";

let db: Database;

beforeEach(async () => {
  db = await freshDatabase();
});

describe("bot_instances", () => {
  it("rejects a UUID id, which is the mistake step 2 warned about", async () => {
    // clientOrderId is `v1-{botInstanceId}-{sequence}` and must fit the
    // exchange's 36-character limit while staying parseable back to a bot.
    // Reaching for crypto.randomUUID() at step 6 now fails at the database.
    await expect(
      db.botInstances.insert(botInstanceRow({ id: "3f8a1c2e-9b4d-4f11-8a7e-1d2c3b4a5e6f" })),
    ).rejects.toThrow(/CHECK/);
  });

  it("rejects an id starting with an uppercase letter", async () => {
    await expect(db.botInstances.insert(botInstanceRow({ id: "Dca-btc-1" }))).rejects.toThrow(
      /CHECK/,
    );
  });

  it("accepts a 20-character slug and rejects a 21-character one", async () => {
    await db.botInstances.insert(botInstanceRow({ id: "a2345678901234567890" }));
    await expect(
      db.botInstances.insert(botInstanceRow({ id: "a23456789012345678901" })),
    ).rejects.toThrow(/CHECK/);
  });

  it("requires a take-profit for a DCA bot", async () => {
    // Section 6.3 step 4: take-profit defines the DCA cycle's exit.
    await expect(
      db.botInstances.insert(botInstanceRow({ take_profit_pct: null })),
    ).rejects.toThrow(/CHECK/);
  });

  it("allows a grid bot with no take-profit", async () => {
    await db.botInstances.insert(
      botInstanceRow({ id: "grid-eth-1", strategy_type: "grid", take_profit_pct: null }),
    );
    expect(await db.botInstances.count()).toBe(1);
  });

  it("refuses to mark a bot halted without recording a reason", async () => {
    // Section 7.2 step 3, enforced rather than documented.
    await db.botInstances.insert(botInstanceRow());
    await expect(
      db.botInstances.update({ id: "dca-btc-1" }, { status: "halted" }),
    ).rejects.toThrow(/CHECK/);

    await db.botInstances.update(
      { id: "dca-btc-1" },
      { status: "halted", halt_reason: "stop loss breached", halted_at: 1_760_000_001_000 },
    );
    const row = await db.botInstances.findOne({ id: "dca-btc-1" });
    expect(row?.status).toBe("halted");
    expect(row?.halt_reason).toBe("stop loss breached");
  });

  it("rejects an unknown status and an unknown strategy type", async () => {
    await expect(
      // @ts-expect-error -- BotStatus does not include this.
      db.botInstances.insert(botInstanceRow({ status: "paused" })),
    ).rejects.toThrow(/CHECK/);
    await expect(
      // @ts-expect-error -- StrategyType does not include this.
      db.botInstances.insert(botInstanceRow({ id: "x1", strategy_type: "scalp" })),
    ).rejects.toThrow(/CHECK/);
  });

  it("rejects a non-positive allocated capital", async () => {
    await expect(
      db.botInstances.insert(botInstanceRow({ allocated_capital: 0n })),
    ).rejects.toThrow(/CHECK/);
  });
});

describe("orders", () => {
  beforeEach(async () => {
    await db.botInstances.insert(botInstanceRow());
  });

  it("rejects a filled quantity above the order quantity", async () => {
    // The database-level counterpart of order-state.ts's `overfill` code.
    await expect(
      db.orders.insert(orderRow({ filled_quantity: 150_001n })),
    ).rejects.toThrow(/CHECK/);
  });

  it("allows filled_quantity to equal quantity", async () => {
    await db.orders.insert(orderRow({ filled_quantity: 150_000n, status: "filled" }));
    expect(await db.orders.count()).toBe(1);
  });

  it("rejects a duplicate client_order_id", async () => {
    // Section 5.1's second layer: Binance rejects a reused id, and so do we.
    await db.orders.insert(orderRow());
    await expect(db.orders.insert(orderRow({ id: "ord-2" }))).rejects.toThrow(/UNIQUE/);
  });

  it("rejects an order for a bot instance that does not exist", async () => {
    await expect(
      db.orders.insert(orderRow({ id: "ord-x", client_order_id: "v1-ghost-1", bot_instance_id: "ghost" })),
    ).rejects.toThrow(/FOREIGN KEY/);
  });

  it("rejects each of the six order states being wrong", async () => {
    await expect(
      // @ts-expect-error -- OrderState does not include this.
      db.orders.insert(orderRow({ status: "open" })),
    ).rejects.toThrow(/CHECK/);
  });

  it("accepts all six states the state machine knows about", async () => {
    const states = ["pending", "partially_filled", "filled", "cancelled", "rejected", "expired"] as const;
    for (const [index, status] of states.entries()) {
      await db.orders.insert(
        orderRow({
          id: `ord-${index}`,
          client_order_id: `v1-dca-btc-1-${index}`,
          status,
          filled_quantity: status === "filled" ? 150_000n : 0n,
        }),
      );
    }
    expect(await db.orders.count()).toBe(6);
  });
});

describe("trades", () => {
  beforeEach(async () => {
    await db.botInstances.insert(botInstanceRow());
    await db.orders.insert(orderRow());
  });

  it("rejects a redelivered fill with the same exchange trade id", async () => {
    // Section 5.1: queue messages get redelivered. Without this, the second
    // insert would double-count realized PnL.
    await db.trades.insert(tradeRow());
    await expect(db.trades.insert(tradeRow({ id: "trd-2" }))).rejects.toThrow(/UNIQUE/);
  });

  it("rejects a trade whose bot does not match its order's bot", async () => {
    // trades.bot_instance_id is denormalized from orders. The composite
    // foreign key on (order_id, bot_instance_id) is what stops the copy
    // disagreeing with the original -- the usual cost of denormalizing.
    await db.botInstances.insert(botInstanceRow({ id: "dca-eth-1" }));
    await expect(
      db.trades.insert(tradeRow({ bot_instance_id: "dca-eth-1" })),
    ).rejects.toThrow(/FOREIGN KEY/);
  });

  it("rejects a trade for an order that does not exist", async () => {
    await expect(db.trades.insert(tradeRow({ order_id: "ghost" }))).rejects.toThrow(
      /FOREIGN KEY/,
    );
  });

  it("allows the same exchange trade id under a different order", async () => {
    await db.orders.insert(orderRow({ id: "ord-2", client_order_id: "v1-dca-btc-1-2" }));
    await db.trades.insert(tradeRow());
    await db.trades.insert(tradeRow({ id: "trd-2", order_id: "ord-2" }));
    expect(await db.trades.count()).toBe(2);
  });

  it("accepts an unconverted fee only when all three columns are NULL", async () => {
    // Step 2's decision 9: no partial fee picture.
    await db.trades.insert(
      tradeRow({
        id: "trd-null",
        exchange_trade_id: "1",
        fee_reporting_amount: null,
        fee_reporting_asset: null,
        fee_conversion_rate: null,
      }),
    );
    expect(await db.trades.count()).toBe(1);
  });

  it("rejects a partially populated fee conversion", async () => {
    await expect(
      db.trades.insert(
        tradeRow({
          id: "trd-bad",
          exchange_trade_id: "2",
          fee_reporting_amount: 100n,
          fee_reporting_asset: "USDT",
          fee_conversion_rate: null,
        }),
      ),
    ).rejects.toThrow(/CHECK/);

    await expect(
      db.trades.insert(
        tradeRow({
          id: "trd-bad2",
          exchange_trade_id: "3",
          fee_reporting_amount: null,
          fee_reporting_asset: "USDT",
          fee_conversion_rate: 1n,
        }),
      ),
    ).rejects.toThrow(/CHECK/);
  });

  it("allows a zero fee but not a negative one", async () => {
    await db.trades.insert(tradeRow({ id: "t0", exchange_trade_id: "10", fee_amount: 0n }));
    await expect(
      db.trades.insert(tradeRow({ id: "t1", exchange_trade_id: "11", fee_amount: -1n })),
    ).rejects.toThrow(/CHECK/);
  });
});

describe("capital_ledger", () => {
  it("allows one row per account and asset, and no duplicates", async () => {
    await db.capitalLedger.insert(capitalLedgerRow());
    await db.capitalLedger.insert(capitalLedgerRow({ id: "cl-2", asset: "BTC" }));
    await expect(
      db.capitalLedger.insert(capitalLedgerRow({ id: "cl-3" })),
    ).rejects.toThrow(/UNIQUE/);
  });

  it("permits an over-allocated account", async () => {
    // Deliberately representable: a losing position or a manual withdrawal can
    // put allocation above balance, and reconciliation has to be able to
    // record that rather than be refused by the schema.
    await db.capitalLedger.insert(
      capitalLedgerRow({ total_balance: 100n, total_allocated: 900n }),
    );
    const row = await db.capitalLedger.findOne({ id: "cl-1" });
    expect(row!.total_allocated - row!.total_balance).toBe(800n);
  });
});

describe("alerts and audit_log", () => {
  it("allows an alert with no bot instance", async () => {
    // Section 7.4's global kill switch and system health alerts belong to no
    // single bot.
    await db.alerts.insert(alertRow({ category: "system", bot_instance_id: null }));
    expect(await db.alerts.count()).toBe(1);
  });

  it("rejects an alert pointing at a bot that does not exist", async () => {
    await expect(
      db.alerts.insert(alertRow({ bot_instance_id: "ghost" })),
    ).rejects.toThrow(/FOREIGN KEY/);
  });

  it("rejects an unknown severity or category", async () => {
    await expect(
      // @ts-expect-error -- AlertSeverity does not include this.
      db.alerts.insert(alertRow({ severity: "fatal" })),
    ).rejects.toThrow(/CHECK/);
    await expect(
      // @ts-expect-error -- AlertCategory does not include this.
      db.alerts.insert(alertRow({ id: "a2", category: "ops" })),
    ).rejects.toThrow(/CHECK/);
  });

  it("does not constrain alert_type, which will keep growing", async () => {
    await db.alerts.insert(alertRow({ id: "a3", alert_type: "some_future_type" }));
    expect(await db.alerts.count()).toBe(1);
  });

  it("allows an audit entry with no target bot", async () => {
    await db.auditLog.insert(auditLogRow({ actor: "ci", action: "deploy" }));
    expect(await db.auditLog.count()).toBe(1);
  });

  it("keeps details_json round-tripping as structured data", async () => {
    await db.auditLog.insert(
      auditLogRow({ id: "al-2", details_json: { version: "0.1.0", environment: "testnet" } }),
    );
    const row = await db.auditLog.findOne({ id: "al-2" });
    expect(row?.details_json).toEqual({ version: "0.1.0", environment: "testnet" });
  });
});

describe("watchlist", () => {
  // These are the guarantees that survive a RAW `wrangler d1 execute`, which is
  // how the list is edited for now. The cap, the tradability check and the audit
  // entry all live in /src/research/watchlist.ts and none of them run on a hand-
  // written INSERT -- so what the schema itself enforces is the whole of what a
  // manual edit cannot get wrong, and it is worth knowing exactly.
  beforeEach(async () => {
    await db.accounts.insert(accountRow());
  });

  it("refuses an entry for an account that is not registered", async () => {
    // Without a registered account there is no `accounts.exchange`, so there is
    // no venue to validate the pair against -- an unvalidatable row.
    await expect(
      db.watchlist.insert(watchlistRow({ account_label: "never-registered" })),
    ).rejects.toThrow(/FOREIGN KEY/);
  });

  it("refuses a second LIVE entry for the same account and pair", async () => {
    await db.watchlist.insert(watchlistRow({ id: "wl-1" }));
    await expect(db.watchlist.insert(watchlistRow({ id: "wl-2" }))).rejects.toThrow(/UNIQUE/);
  });

  it("allows re-adding a pair whose earlier entry was removed", async () => {
    // Why the unique index is PARTIAL. A plain UNIQUE would forbid this
    // forever, and changing your mind twice about a coin is ordinary.
    await db.watchlist.insert(
      watchlistRow({ id: "wl-1", removed_by: "owner@example.com", removed_at: 1_760_000_100_000 }),
    );
    await db.watchlist.insert(watchlistRow({ id: "wl-2" }));
    expect(await db.watchlist.count()).toBe(2);
  });

  it("refuses a half-recorded removal in either direction", async () => {
    await db.watchlist.insert(watchlistRow({ id: "wl-1" }));
    await expect(
      db.watchlist.update({ id: "wl-1" }, { removed_at: 1_760_000_100_000 }),
    ).rejects.toThrow(/CHECK/);
    await expect(
      db.watchlist.update({ id: "wl-1" }, { removed_by: "owner@example.com" }),
    ).rejects.toThrow(/CHECK/);
  });
});

describe("STRICT tables", () => {
  it("refuse a text value in a money column, even bypassing the access layer", async () => {
    // The layer's encoder would never produce this. STRICT is the backstop for
    // if it ever did: without it, SQLite stores the string and typeof becomes
    // 'text', which silently breaks SUM() and ORDER BY for that row onward.
    await expect(
      rawD1()
        .prepare(
          `INSERT INTO capital_ledger (id, account_label, asset, total_balance, total_allocated, updated_at)
           VALUES ('x', 'main', 'USDT', ?, '0', 1)`,
        )
        .bind("not-a-number")
        .run(),
    ).rejects.toThrow(/cannot store TEXT value/);
  });

  it("refuse a formatted decimal in a money column", async () => {
    // The specific accident this catches: binding toDecimalString (a
    // human-readable "1234.50000000") where toStorageString was meant.
    await expect(
      rawD1()
        .prepare(
          `INSERT INTO capital_ledger (id, account_label, asset, total_balance, total_allocated, updated_at)
           VALUES ('y', 'main', 'USDT', ?, '0', 1)`,
        )
        .bind("1234.50000000")
        .run(),
    ).rejects.toThrow(/cannot store REAL value/);
  });
});
