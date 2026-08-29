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
export type StrategyType = "grid" | "dca" | "trailing_stop";

/**
 * The exchanges an account can trade on (sections 4.4, 16).
 *
 * The single source of the set. The `accounts.exchange` CHECK constraint
 * (migration 0006) is this union's shadow in SQL, exactly as
 * `strategy_type IN ('grid','dca')` shadows `StrategyType`. Adding a third
 * exchange is a deliberate value change here plus a one-string-wider CHECK in a
 * follow-up migration -- not a restructuring. `isExchangeId` is the runtime
 * guard for values arriving as free-typed strings (a stored `bot_instances.exchange`,
 * a request field).
 */
export type ExchangeId = "binance" | "gemini";

export const EXCHANGE_IDS: readonly ExchangeId[] = ["binance", "gemini"];

export function isExchangeId(value: unknown): value is ExchangeId {
  return typeof value === "string" && (EXCHANGE_IDS as readonly string[]).includes(value);
}

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
  // Added by migration 0007, and last for the same ALTER TABLE reason as
  // `capital_asset` above.
  //
  // Whether this bot is hidden from the bot list's DEFAULT view. NOT a delete
  // and not a status: it is orthogonal to `status`, written only by the
  // archive/unarchive endpoints, and read only by the dashboard's view filter.
  // Nothing in the trading path consults it. See the migration header.
  archived: boolean(),
});

/**
 * The account registry (migration 0006, step 11). One row per exchange account,
 * making "which exchange does this account belong to" a registered, validated
 * fact rather than a free-typed guess. `exchange` is an `ExchangeId`, so a
 * decoded row is already narrowed to the known set.
 */
export const accounts = defineTable("accounts", {
  account_label: text(),
  exchange: text<ExchangeId>(),
  created_at: integer(),
  updated_at: integer(),
});

/**
 * The section 21.3 fixed watchlist (migration 0008). A deliberately small,
 * human-chosen set of pairs for the research pipeline's general entry point to
 * consider -- storage only; nothing reads it yet.
 *
 * `removed_at`/`removed_by` make removal a soft delete, because `Repository`
 * offers no hard one (see /src/db/table.ts) -- the same shape as
 * `bot_instances.archived`. An entry is on the live list exactly while
 * `removed_at IS NULL`, which is also the scope of the migration's unique
 * index. `/src/research/watchlist.ts` is the only writer.
 */
export const watchlist = defineTable("watchlist", {
  id: text(),
  account_label: text(),
  pair: text(),
  note: text(),
  added_by: text(),
  added_at: integer(),
  removed_by: nullable(text()),
  removed_at: nullable(integer()),
});

/**
 * Section 21.4's four pipeline stages, as the two that produce a persisted
 * proposal record. Stage 1 (gather) deliberately produces none -- see
 * `/src/research/proposal-log.ts` on why a gather is not a proposal.
 */
export type ProposalStage = "assess" | "derive";

/**
 * The outcomes a human DECISION produces (21.5 requirement 5). `ignored` is
 * deliberately absent: it is an absence, represented by `outcome` staying NULL,
 * and nothing observes a human failing to act. See migration 0009's header.
 */
export type ProposalOutcome = "approved" | "rejected";

/**
 * Which door a proposal's candidate came through (21.2's two entry points, with
 * `watchlist` and `general` as the two halves of the second).
 *
 * This union is the `proposals.entry_point` CHECK constraint's shadow in SQL,
 * exactly as `ExchangeId` shadows `accounts.exchange` -- /src/db may not import
 * from /src/research, so it cannot BE `CandidateEntryPoint`. It is pinned to that
 * type by a compile-time assertion in `/src/research/proposal-log.ts` (both
 * directions, so neither side can gain a value the other lacks) and by a runtime
 * list-parity test, rather than by this comment.
 */
export type ProposalEntryPoint = "named" | "general" | "watchlist";

export const PROPOSAL_ENTRY_POINTS: readonly ProposalEntryPoint[] = [
  "named",
  "general",
  "watchlist",
];

export const PROPOSAL_OUTCOMES: readonly ProposalOutcome[] = ["approved", "rejected"];

export const PROPOSAL_STAGES: readonly ProposalStage[] = ["assess", "derive"];

/**
 * The permanent proposal record (migration 0009, spec 21.5 requirement 5). Every
 * real `/assess` and `/derive` call writes one row here, with its full inputs,
 * its full reasoning, and -- later, if a human acts -- its outcome.
 *
 * There is no delete method and no soft-delete column, per section 8.7. The one
 * mutation this table permits is NULL -> an outcome, once, and
 * `recordProposalOutcome` writes it with `outcome IS NULL` in the WHERE clause so
 * no stored fact is ever overwritten. `/src/research/proposal-log.ts` is the only
 * writer.
 */
export const proposals = defineTable("proposals", {
  id: text(),
  stage: text<ProposalStage>(),
  account_label: text(),
  pair: text(),
  entry_point: text<ProposalEntryPoint>(),
  strategy_type: text<StrategyType>(),
  actor: text(),
  model: text(),
  prompt_version: text(),
  /** 21.5 requirement 4: the price-history FETCH time, not the render time. */
  data_fetched_at: integer(),
  /**
   * Deliberately `unknown`, exactly as `bot_instances.strategy_params_json` is:
   * the stored shape is whatever `candidateGatherBundleView` and
   * `deriveContextView` render, those views are `/src/api/serialize.ts`'s to
   * define, and typing it as a hand-written interface here would mean a stored
   * row could claim a shape nothing validated.
   */
  inputs_json: json<unknown>(),
  reasoning_json: json<unknown>(),
  created_at: integer(),
  outcome: nullable(text<ProposalOutcome>()),
  outcome_bot_instance_id: nullable(text()),
  outcome_actor: nullable(text()),
  outcome_at: nullable(integer()),
  outcome_note: nullable(text()),
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
export type AccountRow = Row<typeof accounts.columns>;
export type WatchlistRow = Row<typeof watchlist.columns>;
export type CapitalLedgerRow = Row<typeof capitalLedger.columns>;
export type OrderRow = Row<typeof orders.columns>;
export type TradeRow = Row<typeof trades.columns>;
export type BalanceSnapshotRow = Row<typeof balanceSnapshots.columns>;
export type ManualAdjustmentRow = Row<typeof manualAdjustments.columns>;
export type AuditLogRow = Row<typeof auditLog.columns>;
export type ProposalRow = Row<typeof proposals.columns>;
export type AlertRow = Row<typeof alerts.columns>;
export type CircuitBreakerRow = Row<typeof circuitBreakers.columns>;
export type GlobalKillSwitchRow = Row<typeof globalKillSwitch.columns>;

/** Every table, for the schema-drift test and for Database's construction. */
export const ALL_TABLES = {
  botInstances,
  accounts,
  watchlist,
  capitalLedger,
  orders,
  trades,
  balanceSnapshots,
  manualAdjustments,
  auditLog,
  alerts,
  circuitBreakers,
  globalKillSwitch,
  proposals,
} as const;
