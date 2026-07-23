/**
 * The eight tables of spec section 8.2, as typed specs.
 *
 * These mirror migrations/0001_initial_schema.sql exactly. The migration is
 * authoritative -- it is what a deploy actually runs -- and these definitions
 * are how TypeScript sees it. `schema.test.ts` compares the two against a live
 * database column by column, so the pair cannot drift silently.
 *
 * Every money column below is `money()`, which is the only thing a caller
 * needs for the CAST-on-read / decimal-string-on-write convention to apply.
 */

import { boolean, integer, json, money, nullable, text } from "./columns";
import { defineTable, type Row } from "./table";
import type { OrderState } from "../shared/order-state";

/** Section 8.1's bot instance status. */
export type BotStatus = "created" | "running" | "halted" | "stopped";

/** Section 6: the two strategies in v1. */
export type StrategyType = "grid" | "dca";

export type OrderSide = "buy" | "sell";

/** Section 9's drift classes. NULL where a run found no drift to classify. */
export type DriftClassification = "minor" | "meaningful" | "severe";

/** Section 10's two alert kinds, which the dashboard must show differently. */
export type AlertCategory = "trading" | "system";

export type AlertSeverity = "info" | "warning" | "critical";

// ---------------------------------------------------------------------------

export const botInstances = defineTable("bot_instances", {
  // A short slug, not a UUID -- see the migration and step 2's decision 6.
  id: text(),
  account_label: text(),
  exchange: text(),
  pair: text(),
  strategy_type: text<StrategyType>(),
  // Deliberately `unknown`: the parameter shape differs per strategy and is
  // step 6's to define. Typing it as a guessed interface now would mean a
  // stored row could claim a shape nothing validated.
  strategy_params_json: json<unknown>(),
  stop_loss_pct: money(),
  take_profit_pct: nullable(money()),
  allocated_capital: money(),
  status: text<BotStatus>(),
  halt_reason: nullable(text()),
  halted_at: nullable(integer()),
  schema_version: integer(),
  created_at: integer(),
  updated_at: integer(),
  // Last on purpose. Added by migration 0002, and ALTER TABLE ADD COLUMN
  // appends; schema.test.ts compares column ORDER against the live database,
  // so moving this up to sit beside account_label would fail the drift guard.
  //
  // The asset this bot's capital is denominated in, and therefore which
  // capital_ledger row (account_label, asset) its allocation lives in. Not the
  // pair's quote asset by definition, though in practice it will be.
  capital_asset: text(),
});

export const capitalLedger = defineTable("capital_ledger", {
  id: text(),
  account_label: text(),
  asset: text(),
  total_balance: money(),
  total_allocated: money(),
  updated_at: integer(),
});

export const orders = defineTable("orders", {
  id: text(),
  bot_instance_id: text(),
  client_order_id: text(),
  exchange_order_id: nullable(text()),
  side: text<OrderSide>(),
  price: money(),
  quantity: money(),
  filled_quantity: money(),
  // Reuses step 2's OrderState union, so the six states the state machine
  // knows about and the six the CHECK constraint allows are one list.
  status: text<OrderState>(),
  created_at: integer(),
  updated_at: integer(),
});

export const trades = defineTable("trades", {
  id: text(),
  order_id: text(),
  bot_instance_id: text(),
  exchange_trade_id: text(),
  price: money(),
  quantity: money(),
  fee_amount: money(),
  fee_asset: text(),
  fee_reporting_amount: nullable(money()),
  fee_reporting_asset: nullable(text()),
  fee_conversion_rate: nullable(money()),
  executed_at: integer(),
});

export const balanceSnapshots = defineTable("balance_snapshots", {
  id: text(),
  reconciliation_run_id: text(),
  account_label: text(),
  asset: text(),
  exchange_reported_balance: money(),
  internal_calculated_balance: money(),
  discrepancy: money(),
  classification: nullable(text<DriftClassification>()),
  checked_at: integer(),
});

export const manualAdjustments = defineTable("manual_adjustments", {
  id: text(),
  account_label: text(),
  asset: text(),
  amount: money(),
  note: text(),
  reconciled_at: nullable(integer()),
  created_at: integer(),
});

/**
 * Section 7.3's account-wide circuit breaker, added by migration 0003 at step
 * 7. A missing row means the account has never tripped, which is treated as
 * `armed` -- see `/src/reconciliation/circuit-breaker.ts`.
 */
export type CircuitBreakerState = "armed" | "tripped";

export const circuitBreakers = defineTable("circuit_breakers", {
  account_label: text(),
  state: text<CircuitBreakerState>(),
  reason: nullable(text()),
  run_id: nullable(text()),
  tripped_at: nullable(integer()),
  tripped_by: nullable(text()),
  reset_at: nullable(integer()),
  reset_by: nullable(text()),
  updated_at: integer(),
});

/**
 * Section 7.4's global kill switch, added by migration 0005 at step 10.3. A
 * missing row means it has never been pulled, which is treated as `armed` --
 * see `/src/reconciliation/kill-switch.ts`. At most one row, pinned to id 1.
 */
export type GlobalKillSwitchState = "armed" | "tripped";

export const globalKillSwitch = defineTable("global_kill_switch", {
  id: integer(),
  state: text<GlobalKillSwitchState>(),
  reason: nullable(text()),
  tripped_at: nullable(integer()),
  tripped_by: nullable(text()),
  reset_at: nullable(integer()),
  reset_by: nullable(text()),
  updated_at: integer(),
});

export const auditLog = defineTable("audit_log", {
  id: text(),
  actor: text(),
  action: text(),
  target_bot_instance_id: nullable(text()),
  details_json: nullable(json<unknown>()),
  created_at: integer(),
});

export const alerts = defineTable("alerts", {
  id: text(),
  severity: text<AlertSeverity>(),
  category: text<AlertCategory>(),
  alert_type: text(),
  bot_instance_id: nullable(text()),
  source: text(),
  message: text(),
  resolved: boolean(),
  created_at: integer(),
  // Step 8, migration 0004. When the notification dispatcher processed this
  // row (sent a ping, or deliberately skipped it on cooldown). NULL means it
  // has not been processed, or a send was attempted and failed and will be
  // retried. Recording is independent of `resolved`; see the migration header.
  // Last in the column list because ALTER TABLE ADD COLUMN appends and
  // schema.test.ts compares column order against the live database.
  notified_at: nullable(integer()),
});

// Decoded row types. Money columns are `bigint`, JSON columns are parsed, and
// every column is present -- these are also the insert types.
export type BotInstanceRow = Row<typeof botInstances.columns>;
export type CapitalLedgerRow = Row<typeof capitalLedger.columns>;
export type OrderRow = Row<typeof orders.columns>;
export type TradeRow = Row<typeof trades.columns>;
export type BalanceSnapshotRow = Row<typeof balanceSnapshots.columns>;
export type ManualAdjustmentRow = Row<typeof manualAdjustments.columns>;
export type AuditLogRow = Row<typeof auditLog.columns>;
export type AlertRow = Row<typeof alerts.columns>;
export type CircuitBreakerRow = Row<typeof circuitBreakers.columns>;
export type GlobalKillSwitchRow = Row<typeof globalKillSwitch.columns>;

/** Every table, for the schema-drift test and for Database's construction. */
export const ALL_TABLES = {
  botInstances,
  capitalLedger,
  orders,
  trades,
  balanceSnapshots,
  manualAdjustments,
  auditLog,
  alerts,
  circuitBreakers,
  globalKillSwitch,
} as const;
