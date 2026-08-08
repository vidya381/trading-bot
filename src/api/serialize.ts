/**
 * Turning internal values into the JSON the dashboard reads, build step 10
 * (backend API layer).
 *
 * TWO CONCERNS, ONE FILE
 * ----------------------
 * 1. Money is `bigint` fixed-point (scale 8, `../shared/money`), and
 *    `JSON.stringify` throws outright on a bigint. So every money field MUST be
 *    rendered before it can leave. It is rendered as a DECIMAL STRING
 *    (`toDecimalString`), never a JS number: a balance past 2^53 or a fractional
 *    cent would lose precision as a number, and this is real-money data. The
 *    frontend parses the string when it needs arithmetic.
 *
 * 2. The two sources this layer reads speak different dialects. D1 rows are
 *    snake_case (`account_label`); a Durable Object's own config and state are
 *    camelCase (`accountLabel`). Rather than leak that seam to the frontend,
 *    the D1 rows get explicit camelCase views below, and the DO snapshot pieces
 *    (already camelCase) go through `jsonSafe`, which only has to fix the
 *    bigints. The result is one consistent camelCase contract.
 *
 * WHY `jsonSafe` IS SAFE TO USE ON WHOLE STRUCTURES
 * -------------------------------------------------
 * Every bigint in this codebase is a `Money` -- the money module owns the type,
 * and every other numeric (timestamps, sequence numbers, grid line counts) is a
 * JS `number` decoded from an INTEGER column or held as one in memory. So a deep
 * "bigint -> toDecimalString" pass over a config, a ladder, or a position
 * converts exactly the money and nothing else, with no field-by-field list to
 * fall out of date. It is used only for the DO snapshot shapes, whose nested
 * strategy state (`GridLadder`, `DcaPosition`, `TrackedOrder[]`) would otherwise
 * need a hand-written serializer per type that the strategy modules could
 * silently outgrow.
 */

import type {
  AlertRow,
  BotInstanceRow,
  CircuitBreakerRow,
  GlobalKillSwitchRow,
  ManualAdjustmentRow,
  OrderRow,
  TradeRow,
} from "../db/schema";
import type { BotSnapshot } from "../durable-objects/bot-instance";
import type { WatchlistEntry } from "../research";
import { toDecimalString, type Money } from "../shared/money";

/** A money value as the exact decimal string the API speaks. */
export function money(value: Money): string {
  return toDecimalString(value);
}

/** A money value, or null passed through (nullable columns, absent prices). */
export function moneyOrNull(value: Money | null): string | null {
  return value === null ? null : toDecimalString(value);
}

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

/**
 * Deep-render a value to JSON-safe form by converting every `bigint` to its
 * decimal string. Arrays and plain objects are recursed; everything else is
 * passed through. See the file header for why converting all bigints is exactly
 * right here.
 */
export function jsonSafe(value: unknown): Json {
  if (typeof value === "bigint") return toDecimalString(value);
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (value !== null && typeof value === "object") {
    const out: { [key: string]: Json } = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      out[key] = jsonSafe(inner);
    }
    return out;
  }
  // string | number | boolean | null | undefined. undefined is dropped by
  // JSON.stringify anyway; narrow it to null so the return type holds.
  return (value ?? null) as Json;
}

// ---------------------------------------------------------------------------
// D1 row views (snake_case row -> camelCase API object)
// ---------------------------------------------------------------------------

export function orderView(row: OrderRow) {
  return {
    id: row.id,
    botInstanceId: row.bot_instance_id,
    clientOrderId: row.client_order_id,
    exchangeOrderId: row.exchange_order_id,
    side: row.side,
    price: money(row.price),
    quantity: money(row.quantity),
    filledQuantity: money(row.filled_quantity),
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function tradeView(row: TradeRow) {
  return {
    id: row.id,
    orderId: row.order_id,
    botInstanceId: row.bot_instance_id,
    exchangeTradeId: row.exchange_trade_id,
    price: money(row.price),
    quantity: money(row.quantity),
    feeAmount: money(row.fee_amount),
    feeAsset: row.fee_asset,
    feeReportingAmount: moneyOrNull(row.fee_reporting_amount),
    feeReportingAsset: row.fee_reporting_asset,
    feeConversionRate: moneyOrNull(row.fee_conversion_rate),
    executedAt: row.executed_at,
  };
}

export function alertView(row: AlertRow) {
  return {
    id: row.id,
    severity: row.severity,
    category: row.category,
    alertType: row.alert_type,
    botInstanceId: row.bot_instance_id,
    source: row.source,
    message: row.message,
    resolved: row.resolved,
    createdAt: row.created_at,
    notifiedAt: row.notified_at,
  };
}

export function manualAdjustmentView(row: ManualAdjustmentRow) {
  return {
    id: row.id,
    accountLabel: row.account_label,
    asset: row.asset,
    amount: money(row.amount),
    note: row.note,
    reconciledAt: row.reconciled_at,
    createdAt: row.created_at,
  };
}

/**
 * One live watchlist entry (section 21.3, migration 0008).
 *
 * The module's `WatchlistEntry` is already camelCase and carries no money, so
 * this is a rename rather than a conversion: `exchangePair` becomes `pair`,
 * which is what every other endpoint in this surface calls that field
 * (`bot.pair`, the symbols endpoint's `pairs`). The module keeps the longer name
 * because inside the research code it has to be unmistakable that the string is
 * the VENUE's spelling and not a normalised one; over HTTP the field sits beside
 * `accountLabel`, which already says which venue.
 *
 * `removed_at`/`removed_by` are deliberately not exposed. Every entry this view
 * ever sees is live -- `readWatchlist` returns nothing else -- so a `removedAt`
 * field would be `null` on every row the API has ever returned, which is a
 * column that teaches a frontend the wrong shape.
 */
export function watchlistEntryView(entry: WatchlistEntry) {
  return {
    id: entry.id,
    accountLabel: entry.accountLabel,
    pair: entry.exchangePair,
    note: entry.note,
    addedBy: entry.addedBy,
    addedAt: entry.addedAt,
  };
}

/**
 * One account's circuit-breaker status (section 7.3).
 *
 * An absent row means the account has never tripped, which the breaker module
 * treats as armed -- so this reports `armed` with no trip detail rather than
 * inventing a row. Mirrors `readCircuitBreaker`'s "null means armed".
 */
export function circuitBreakerView(accountLabel: string, row: CircuitBreakerRow | null) {
  if (row === null) {
    return {
      accountLabel,
      state: "armed" as const,
      reason: null,
      trippedAt: null,
      trippedBy: null,
      runId: null,
      resetAt: null,
      resetBy: null,
    };
  }
  return {
    accountLabel: row.account_label,
    state: row.state,
    reason: row.reason,
    trippedAt: row.tripped_at,
    trippedBy: row.tripped_by,
    runId: row.run_id,
    resetAt: row.reset_at,
    resetBy: row.reset_by,
  };
}

/**
 * The global kill switch status (section 7.4).
 *
 * An absent row means it has never been pulled, which is armed -- the same
 * "null means armed" as the account breaker, and the same reason nothing has to
 * seed a row.
 */
export function killSwitchView(row: GlobalKillSwitchRow | null) {
  if (row === null) {
    return {
      state: "armed" as const,
      reason: null,
      trippedAt: null,
      trippedBy: null,
      resetAt: null,
      resetBy: null,
    };
  }
  return {
    state: row.state,
    reason: row.reason,
    trippedAt: row.tripped_at,
    trippedBy: row.tripped_by,
    resetAt: row.reset_at,
    resetBy: row.reset_by,
  };
}

// ---------------------------------------------------------------------------
// Bots
// ---------------------------------------------------------------------------

/**
 * The held position and realized profit, read from the object's OWN state
 * (section 8.1), not from D1 -- position and realized profit are the object's
 * to know and are not fully mirrored. Null when the object holds no state (the
 * step 6 open-question-6 orphan: a `bot_instances` row whose object was never
 * written).
 *
 * `realizedGross` is named honestly: it is gross realized profit before fees,
 * which is the field the state actually carries (`BotRuntimeState.realizedGross`).
 * Netting fees is reconciliation's job against `total_balance`, not this
 * layer's, and calling a gross number "pnl" would overstate what it is.
 *
 * `cost` IS CARRIED BY BOTH STRATEGIES, and that is new as of step 25. It was
 * DCA-only, so the grid arm of this union published a held QUANTITY with no
 * basis to value it against -- fine for a per-bot row that only prints the
 * quantity, and useless the moment anything wants to know what the fleet is
 * holding. The two fields mean the same thing and are accumulated the same way:
 * DCA's `position.cost` and grid's `ladder.heldCost` are both the bare notional
 * (`mul(price, quantity)`) of what is STILL HELD, gross of fees -- `applyFill`
 * carries `feeAmount` as a separate field that never enters the position
 * (order-state.ts) and grid.ts's buy branch accumulates the same bare product.
 * So they share one name, and the account rollup adds them without branching on
 * strategy. Renaming grid's to match DCA's rather than the reverse keeps the
 * field the frontend has read since step 10.7 exactly where it was.
 */
function positionOf(snapshot: BotSnapshot | null) {
  if (snapshot === null) return null;
  const state = snapshot.state;
  if (snapshot.config.strategy === "grid") {
    const ladder = state.ladder;
    return {
      strategy: "grid" as const,
      heldQuantity: ladder === undefined ? "0" : money(ladder.heldQuantity),
      cost: ladder === undefined ? "0" : money(ladder.heldCost),
      realizedGross: money(state.realizedGross),
    };
  }
  return {
    strategy: "dca" as const,
    heldQuantity: money(state.position.quantity),
    averageEntryPrice: money(state.position.averageEntryPrice),
    cost: money(state.position.cost),
    realizedGross: money(state.realizedGross),
  };
}

/**
 * What one bot has paid the venue, in its OWN capital asset (step 25).
 *
 * WHY THIS IS NOT SIMPLY `SUM(fee_amount)`. A fee is charged in whatever asset
 * the venue chose, and `trades.fee_asset` records that honestly -- Binance
 * commonly charges in BNB (section 5.5 rule 1). Summing that column would add
 * BNB to USD and call the result money. The summable column is
 * `fee_reporting_amount`, which `#mirrorTrade` writes at fill time as the fee
 * converted to `config.capitalAsset` at the fill's own price.
 *
 * AND IT IS NULLABLE ON PURPOSE. The rate lookup at fill time knows only the
 * base asset's price, so a fee paid in the exchange's own token has no rate
 * available and all three reporting columns are left NULL rather than guessed
 * (step 2 decision 9; migration 0001's `fee_conversion_all_or_nothing` CHECK).
 * SQLite's SUM skips those rows, so `reported` is the total of the fees that
 * could be PRICED -- never the total that was PAID.
 *
 * `unpricedCount` is therefore load-bearing, not diagnostic. It is the count of
 * fills carrying a real fee this figure does not include, and a non-zero value
 * means `reported` is a floor. Any net figure derived from it must say so, or
 * suppress itself -- which is exactly what `realizedPnl` (shared/fees.ts) has
 * always done with its `complete: false` arm, and this mirrors that rule rather
 * than inventing a second one.
 */
export interface BotFees {
  /** Sum of the fees that CONVERTED, in the bot's capital asset. A floor. */
  readonly reported: string;
  /** Fills whose fee could not be priced. Non-zero means `reported` is partial. */
  readonly unpricedCount: number;
}

/**
 * The list-view of one bot (endpoint 1): status, strategy, pair, position, PnL,
 * allocated capital, plus the identity fields a dashboard row needs.
 *
 * The D1 row is authoritative for status, strategy and allocation (they are
 * mirrored on every transition); the DO snapshot supplies the live position and
 * realized profit. When the snapshot is null the bot row exists but its object
 * does not, which is surfaced with `orphaned: true` rather than shown as a flat,
 * zero-position bot.
 *
 * THREE FIELDS WERE ADDED IN STEP 25 so the bot LIST can be rolled up into an
 * account-level total without a second request per bot. Two of them cost
 * nothing: `lastPrice` and `cycleCount` were already sitting in the snapshot
 * this function is handed and were simply not published, so a caller wanting to
 * mark a position to market had to fetch `/api/bots/:id` for a number the list
 * had already read. The third, `fees`, is genuinely new work and is passed IN
 * rather than read here -- this module performs no I/O, and keeping it that way
 * is what lets every shape in it stay a pure function of its arguments.
 *
 * `cycleCount` IS DCA-ONLY, and the name does not say so because the field is
 * the DO's. It is incremented in exactly one place -- `#completeCycle(config:
 * DcaConfig, ...)` in bot-instance.ts -- and a grid bot, which has no notion of
 * a cycle to complete, holds the 0 it was created with forever. A caller
 * totalling this across a mixed fleet is counting DCA cycles and must label it
 * that way; summing it under a bare "cycles" heading silently reports grid bots
 * as having done nothing.
 */
export function botSummary(row: BotInstanceRow, snapshot: BotSnapshot | null, fees: BotFees) {
  return {
    id: row.id,
    accountLabel: row.account_label,
    exchange: row.exchange,
    pair: row.pair,
    strategy: row.strategy_type,
    status: row.status,
    allocatedCapital: money(row.allocated_capital),
    capitalAsset: row.capital_asset,
    stopLossPct: money(row.stop_loss_pct),
    takeProfitPct: moneyOrNull(row.take_profit_pct),
    haltReason: row.halt_reason,
    haltedAt: row.halted_at,
    // Step 26. Orthogonal to `status`, never derived from it: an archived bot
    // is halted or stopped, but a halted bot is not archived by implication.
    // The frontend hides these from the list's default view and shows them
    // behind its "Show archived" toggle; nothing here filters.
    archived: row.archived,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    position: positionOf(snapshot),
    // The latest usable price the bot has seen, or null before its first
    // (section 5.6: an unusable price is reported, never guessed at). Null is
    // NOT zero and NOT "no movement" -- it means a held position's current
    // worth is unknown, which is a different fact from a position worth
    // nothing, and a rollup must refuse to value it rather than treat it as 0.
    lastPrice: snapshot === null ? null : moneyOrNull(snapshot.state.lastPrice),
    // Null for an orphan, matching `position`: an object holding no state has
    // not completed zero cycles, it has no record of cycles at all.
    cycleCount: snapshot === null ? null : snapshot.state.cycleCount,
    fees,
    orphaned: snapshot === null,
  };
}

/**
 * The full detail of one bot (endpoint 2).
 *
 * The summary, plus the object's own configuration and runtime state (the grid
 * ladder or the DCA entries and average price live in `state`), and the D1
 * order, trade and alert history for this bot. `config`/`state` go through
 * `jsonSafe` because they are the camelCase strategy shapes whose money must be
 * rendered; the histories use the explicit row views.
 */
export function botDetail(
  row: BotInstanceRow,
  snapshot: BotSnapshot | null,
  orders: readonly OrderRow[],
  trades: readonly TradeRow[],
  alerts: readonly AlertRow[],
  fees: BotFees,
) {
  return {
    ...botSummary(row, snapshot, fees),
    config: snapshot === null ? null : jsonSafe(snapshot.config),
    state: snapshot === null ? null : jsonSafe(snapshot.state),
    orders: orders.map(orderView),
    trades: trades.map(tradeView),
    alerts: alerts.map(alertView),
  };
}
