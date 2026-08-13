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
  proposalRow,
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

/**
 * The proposal record's constraints (migration 0009, spec 21.5 requirement 5).
 *
 * These live HERE rather than beside `proposal-log.ts`'s own tests, and the reason
 * is the guarantee they are about: each one must hold **even if a future bug let a
 * bad value past the repository**, which is only demonstrable by writing past the
 * repository. `no-raw-d1.test.ts` fails the build on `.prepare(` outside /src/db,
 * so /src/db is the one place that write can be made — the same reason every other
 * raw-SQL assertion in this file is in this file.
 *
 * The code paths that ALSO refuse these cases are tested in
 * `/src/research/proposal-log.test.ts`. Both halves are needed: without the code
 * test a refusal could come only from the database and produce an unhelpful error;
 * without these, deleting the code check would leave every test green.
 */
describe("proposals (migration 0009)", () => {
  const T = 1_760_000_000_000;

  async function seed(overrides: Record<string, unknown> = {}) {
    await db.accounts.insert(accountRow({ account_label: "main" }));
    await db.proposals.insert(proposalRow({ account_label: "main", ...overrides }));
  }

  async function seedBot(id: string) {
    await db.botInstances.insert(botInstanceRow({ id, account_label: "main" }));
  }

  /** A raw UPDATE, deliberately past the layer. See this block's docblock. */
  function rawUpdate(sql: string, ...binds: unknown[]) {
    return rawD1().prepare(sql).bind(...binds).run();
  }

  it("⚠ refuses to mark an ASSESS record approved: only a derivation can be", async () => {
    // An assessment carries a strategy word and its reasons, not the parameters a
    // bot needs, so no bot could have been created from one. Without this
    // constraint a mis-wired caller could record an approval naming a parameter set
    // that never existed.
    await seed({ id: "p-assess", stage: "assess", prompt_version: "assess/1" });
    await seedBot("bot-a");
    await expect(
      rawUpdate(
        `UPDATE proposals SET outcome = 'approved', outcome_actor = ?, outcome_at = ?,
           outcome_bot_instance_id = ? WHERE id = 'p-assess'`,
        "owner@example.com",
        T,
        "bot-a",
      ),
    ).rejects.toThrow(/CHECK/);
  });

  it("refuses an approval that names no bot, and a rejection that names one", async () => {
    await seed({ id: "p-1" });
    await expect(
      rawUpdate(
        `UPDATE proposals SET outcome = 'approved', outcome_actor = ?, outcome_at = ? WHERE id = 'p-1'`,
        "owner@example.com",
        T,
      ),
    ).rejects.toThrow(/CHECK/);

    await seedBot("bot-b");
    await expect(
      rawUpdate(
        `UPDATE proposals SET outcome = 'rejected', outcome_actor = ?, outcome_at = ?,
           outcome_bot_instance_id = ? WHERE id = 'p-1'`,
        "owner@example.com",
        T,
        "bot-b",
      ),
    ).rejects.toThrow(/CHECK/);
  });

  it("refuses a HALF-RECORDED decision, the shape halt_requires_reason already uses", async () => {
    await seed({ id: "p-2" });
    // An actor with no verdict.
    await expect(
      rawUpdate(`UPDATE proposals SET outcome_actor = ? WHERE id = 'p-2'`, "owner@example.com"),
    ).rejects.toThrow(/CHECK/);
    // A verdict with no time.
    await expect(
      rawUpdate(
        `UPDATE proposals SET outcome = 'rejected', outcome_actor = ? WHERE id = 'p-2'`,
        "owner@example.com",
      ),
    ).rejects.toThrow(/CHECK/);
    // A note with no decision at all.
    await expect(
      rawUpdate(`UPDATE proposals SET outcome_note = ? WHERE id = 'p-2'`, "changed my mind"),
    ).rejects.toThrow(/CHECK/);
  });

  it("refuses an outcome word that is neither approved nor rejected", async () => {
    // `ignored` in particular: it is an ABSENCE (outcome IS NULL), never a stored
    // value, because nothing observes a human failing to act. See migration 0009.
    await seed({ id: "p-3" });
    for (const word of ["ignored", "pending", "APPROVED", ""]) {
      await expect(
        rawUpdate(
          `UPDATE proposals SET outcome = ?, outcome_actor = ?, outcome_at = ? WHERE id = 'p-3'`,
          word,
          "owner@example.com",
          T,
        ),
        `${JSON.stringify(word)} was accepted as an outcome`,
      ).rejects.toThrow(/CHECK/);
    }
  });

  it("refuses an unknown stage, entry point or strategy", async () => {
    await db.accounts.insert(accountRow({ account_label: "main" }));
    await expect(db.proposals.insert(proposalRow({ account_label: "main", stage: "gather" as never }))).rejects.toThrow(/CHECK/);
    await expect(
      db.proposals.insert(proposalRow({ id: "p-e", account_label: "main", entry_point: "trending" as never })),
    ).rejects.toThrow(/CHECK/);
    await expect(
      db.proposals.insert(proposalRow({ id: "p-s", account_label: "main", strategy_type: "martingale" as never })),
    ).rejects.toThrow(/CHECK/);
  });

  it("accepts 'general' as an entry point, though nothing can produce one yet", async () => {
    // The CHECK names all three doors deliberately: `entryPoint=general` 503s today
    // (no trending vendor, logs 30/31), and in SQLite a CHECK cannot be widened
    // without rebuilding the table -- which for the permanent record would mean
    // rebuilding the thing it exists to keep.
    await db.accounts.insert(accountRow({ account_label: "main" }));
    await db.proposals.insert(proposalRow({ account_label: "main", entry_point: "general" }));
    expect((await db.proposals.findOne({ id: "prop-1" }))!.entry_point).toBe("general");
  });

  it("requires a registered account, and a real bot for an approval", async () => {
    // The FK to `accounts` -- the second one, after watchlist's.
    await expect(db.proposals.insert(proposalRow({ account_label: "ghost" }))).rejects.toThrow(
      /FOREIGN KEY/,
    );
    // And the FK to `bot_instances`: an approval cannot name a bot that does not
    // exist, which is what makes "approved" a fact rather than a claim.
    await seed({ id: "p-fk" });
    await expect(
      rawUpdate(
        `UPDATE proposals SET outcome = 'approved', outcome_actor = ?, outcome_at = ?,
           outcome_bot_instance_id = 'no-such-bot' WHERE id = 'p-fk'`,
        "owner@example.com",
        T,
      ),
    ).rejects.toThrow(/FOREIGN KEY/);
  });

  it("requires a fetch time: 21.5 requirement 4 has nothing to hold without one", async () => {
    await db.accounts.insert(accountRow({ account_label: "main" }));
    await expect(
      db.proposals.insert(proposalRow({ account_label: "main", data_fetched_at: null as never })),
    ).rejects.toThrow(/NOT NULL/);
  });
});
