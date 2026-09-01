/**
 * Test-only helpers for the D1 access layer.
 *
 * Not exported from index.ts and never imported by a Worker, so esbuild never
 * bundles it. This is the one file allowed to run raw SQL outside the layer,
 * because emptying a table is precisely the operation the layer refuses to
 * offer (section 8.7 retains everything).
 */

import { applyD1Migrations, env } from "cloudflare:test";
import { Database } from "./database";
import type {
  AccountRow,
  AlertRow,
  AuditLogRow,
  BalanceSnapshotRow,
  BotInstanceRow,
  CapitalLedgerRow,
  CircuitBreakerRow,
  ManualAdjustmentRow,
  OrderRow,
  ProposalRow,
  TradeRow,
  WatchlistRow,
} from "./schema";

// Children before parents, so the deletes do not trip the foreign keys that D1
// enforces by default.
const TABLES_CHILDREN_FIRST = [
  // Migration 0009. First in the list because it is the only table with TWO
  // parents -- `account_label` REFERENCES accounts and `outcome_bot_instance_id`
  // REFERENCES bot_instances -- so it must go before either of them.
  "proposals",
  "trades",
  "orders",
  "alerts",
  "audit_log",
  "balance_snapshots",
  "manual_adjustments",
  "capital_ledger",
  "circuit_breakers",
  "global_kill_switch",
  "bot_instances",
  // Migration 0008 gave `accounts` its first child, so this is no longer free:
  // `watchlist.account_label` REFERENCES accounts, and D1 enforces it.
  "watchlist",
  "accounts",
] as const;

/**
 * The raw binding, for tests that must deliberately bypass the access layer.
 *
 * `wrangler types` emits `DB?: D1Database` on the base env, correctly: the base
 * config block in wrangler.jsonc has no D1 binding, so a Worker deployed
 * without `--env` genuinely has no database. Only the two named environments
 * declare one.
 *
 * Tests are pinned to the testnet environment (step 1, decision 6), where the
 * binding is always present. This is the single place that narrowing happens,
 * and it checks rather than asserts -- if the pinning is ever lost, this says
 * so in one line instead of surfacing as a null dereference somewhere further
 * in.
 */
export function rawD1(): D1Database {
  const binding = env.DB;
  if (binding === undefined) {
    throw new Error(
      "no DB binding in the test environment. vitest.config.ts pins tests to " +
        "the testnet environment, which declares one in wrangler.jsonc; check " +
        "that pinning is still in place.",
    );
  }
  return binding;
}

/**
 * Apply the real migrations to the real (local) D1 database and empty every
 * table. `applyD1Migrations` records what it has run, so repeated calls after
 * the first do nothing.
 */
export async function freshDatabase(): Promise<Database> {
  const d1 = rawD1();
  await applyD1Migrations(d1, env.TEST_MIGRATIONS);
  await d1.batch(TABLES_CHILDREN_FIRST.map((table) => d1.prepare(`DELETE FROM ${table}`)));
  return new Database(d1);
}

/**
 * What one query actually cost, as D1 itself reports it.
 *
 * `rows_read` is D1's billing unit, so a change that claims to read fewer rows
 * should be provable in the number D1 charges on rather than in a proxy for it.
 * Local D1 (miniflare) populates `meta.rows_read` the same way the real service
 * does, which makes the claim testable without a deploy.
 */
export interface ReadMeter {
  /** Every counted SELECT, in order, for asserting HOW MANY reads happened. */
  readonly statements: string[];
  /** D1's own `rows_read`, summed across those statements. */
  rowsRead: number;
  /** Forget everything so far -- call after seeding, before the measured act. */
  reset(): void;
}

/**
 * A `Database` that counts what its reads of ONE table cost.
 *
 * WHY IT LIVES HERE and not next to the test that uses it: `no-raw-d1.test.ts`
 * fails the build if any file outside /src/db names `D1Database` or calls
 * `.prepare(`, and wrapping the binding requires both. This file is already the
 * sanctioned exception, for the same reason -- it is the one place allowed to
 * reach past the layer.
 *
 * Only SELECTs against `table` are counted. Writes are excluded deliberately: a
 * resolve pass UPDATEs the rows it closes, and folding those into the number
 * would measure the outcome rather than the lookup that found them.
 */
export async function meteredDatabase(
  table: string,
): Promise<{ readonly db: Database; readonly meter: ReadMeter }> {
  const d1 = rawD1();
  await applyD1Migrations(d1, env.TEST_MIGRATIONS);
  await d1.batch(TABLES_CHILDREN_FIRST.map((name) => d1.prepare(`DELETE FROM ${name}`)));

  const statements: string[] = [];
  const meter: ReadMeter = {
    statements,
    rowsRead: 0,
    reset() {
      statements.length = 0;
      meter.rowsRead = 0;
    },
  };

  const counted = (sql: string): boolean =>
    /^\s*SELECT/i.test(sql) && sql.includes(`FROM "${table}"`);

  const wrapStatement = (statement: D1PreparedStatement, sql: string): D1PreparedStatement =>
    new Proxy(statement, {
      get(target, property, receiver) {
        // `bind` returns a NEW statement, so the wrapper has to survive it or
        // every parameterised query would go uncounted -- which is all of them.
        if (property === "bind") {
          return (...values: unknown[]) => wrapStatement(target.bind(...values), sql);
        }
        if (property === "all") {
          return async () => {
            const result = await target.all<Record<string, unknown>>();
            if (counted(sql)) {
              statements.push(sql);
              meter.rowsRead += Number(result.meta.rows_read ?? 0);
            }
            return result;
          };
        }
        const value: unknown = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });

  const metered = new Proxy(d1, {
    get(target, property, receiver) {
      if (property === "prepare") {
        return (sql: string) => wrapStatement(target.prepare(sql), sql);
      }
      const value: unknown = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });

  return { db: new Database(metered), meter };
}

const T0 = 1_760_000_000_000;

export function botInstanceRow(overrides: Partial<BotInstanceRow> = {}): BotInstanceRow {
  return {
    id: "dca-btc-1",
    account_label: "main",
    exchange: "binance",
    pair: "BTCUSDT",
    strategy_type: "dca",
    strategy_params_json: { baseOrderSize: "100.0" },
    stop_loss_pct: 500_000_000n, // 5%
    take_profit_pct: 200_000_000n, // 2%
    allocated_capital: 100_000_000_000n, // 1000.0
    status: "created",
    halt_reason: null,
    halted_at: null,
    schema_version: 1,
    created_at: T0,
    updated_at: T0,
    capital_asset: "USDT",
    archived: false,
    ...overrides,
  };
}

export function orderRow(overrides: Partial<OrderRow> = {}): OrderRow {
  return {
    id: "ord-1",
    bot_instance_id: "dca-btc-1",
    client_order_id: "v1-dca-btc-1-1",
    exchange_order_id: "9001",
    side: "buy",
    price: 6_500_000_000_000n, // 65000.0
    quantity: 150_000n, // 0.0015
    filled_quantity: 0n,
    status: "pending",
    created_at: T0,
    updated_at: T0,
    ...overrides,
  };
}

export function tradeRow(overrides: Partial<TradeRow> = {}): TradeRow {
  return {
    id: "trd-1",
    order_id: "ord-1",
    bot_instance_id: "dca-btc-1",
    exchange_trade_id: "556677",
    price: 6_500_000_000_000n,
    quantity: 150_000n,
    fee_amount: 7_500_000n, // 0.075 BNB
    fee_asset: "BNB",
    fee_reporting_amount: 4_875_000_000n, // 48.75 USDT
    fee_reporting_asset: "USDT",
    fee_conversion_rate: 65_000_000_000n, // 650.0 USDT per BNB
    executed_at: T0,
    ...overrides,
  };
}

export function accountRow(overrides: Partial<AccountRow> = {}): AccountRow {
  return {
    account_label: "main",
    exchange: "binance",
    created_at: T0,
    updated_at: T0,
    ...overrides,
  };
}

export function watchlistRow(overrides: Partial<WatchlistRow> = {}): WatchlistRow {
  return {
    id: "wl-1",
    account_label: "main",
    pair: "BTCUSDT",
    note: "deep book, the reference pair for every comparison",
    added_by: "owner@example.com",
    added_at: T0,
    removed_by: null,
    removed_at: null,
    ...overrides,
  };
}

export function capitalLedgerRow(
  overrides: Partial<CapitalLedgerRow> = {},
): CapitalLedgerRow {
  return {
    id: "cl-1",
    account_label: "main",
    asset: "USDT",
    total_balance: 500_000_000_000n, // 5000.0
    total_allocated: 100_000_000_000n, // 1000.0
    updated_at: T0,
    ...overrides,
  };
}

export function balanceSnapshotRow(
  overrides: Partial<BalanceSnapshotRow> = {},
): BalanceSnapshotRow {
  return {
    id: "bs-1",
    reconciliation_run_id: "run-1",
    account_label: "main",
    asset: "USDT",
    exchange_reported_balance: 500_000_000_000n,
    internal_calculated_balance: 500_000_000_000n,
    discrepancy: 0n,
    classification: null,
    checked_at: T0,
    ...overrides,
  };
}

export function manualAdjustmentRow(
  overrides: Partial<ManualAdjustmentRow> = {},
): ManualAdjustmentRow {
  return {
    id: "ma-1",
    account_label: "main",
    asset: "USDT",
    amount: -20_000_000_000n, // withdrew 200.0
    note: "moved to cold storage",
    reconciled_at: null,
    created_at: T0,
    ...overrides,
  };
}

export function auditLogRow(overrides: Partial<AuditLogRow> = {}): AuditLogRow {
  return {
    id: "al-1",
    actor: "owner@example.com",
    action: "bot.create",
    target_bot_instance_id: null,
    details_json: null,
    created_at: T0,
    ...overrides,
  };
}

/**
 * A proposal record (migration 0009, spec 21.5 requirement 5).
 *
 * Defaults to an UNRESOLVED `derive` row -- `outcome` and its four companions
 * NULL -- because that is what every real write produces and what 21.5's own
 * measurement ("the proposals nobody acted on") counts. A test that wants an
 * outcome must set all of `outcome`, `outcome_actor`, `outcome_at` and (for an
 * approval) `outcome_bot_instance_id`, which is `outcome_is_recorded_whole`
 * refusing a half-recorded decision rather than this helper hiding one.
 */
export function proposalRow(overrides: Partial<ProposalRow> = {}): ProposalRow {
  return {
    id: "prop-1",
    stage: "derive",
    account_label: "main",
    pair: "BTCUSD",
    entry_point: "named",
    strategy_type: "grid",
    actor: "owner@example.com",
    model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    prompt_version: "derive/1",
    data_fetched_at: T0,
    inputs_json: { bundle: { candidate: { pair: "BTCUSD" } } },
    reasoning_json: { promptText: "PROMPT", strategy: "grid" },
    created_at: T0,
    outcome: null,
    outcome_bot_instance_id: null,
    outcome_actor: null,
    outcome_at: null,
    outcome_note: null,
    ...overrides,
  };
}

export function circuitBreakerRow(
  overrides: Partial<CircuitBreakerRow> = {},
): CircuitBreakerRow {
  return {
    account_label: "main",
    state: "armed",
    reason: null,
    run_id: null,
    tripped_at: null,
    tripped_by: null,
    reset_at: null,
    reset_by: null,
    updated_at: T0,
    ...overrides,
  };
}

export function alertRow(overrides: Partial<AlertRow> = {}): AlertRow {
  return {
    id: "alert-1",
    severity: "critical",
    category: "trading",
    alert_type: "stop_loss_fired",
    bot_instance_id: null,
    source: "bot-instance",
    message: "stop loss triggered",
    resolved: false,
    created_at: T0,
    notified_at: null,
    ...overrides,
  };
}
