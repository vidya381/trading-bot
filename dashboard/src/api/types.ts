/**
 * The shapes the dashboard API returns, mirrored from the backend's
 * `src/api/serialize.ts` and `src/api/envelope.ts` (build step 10.4).
 *
 * Two conventions the backend fixes and this file must honour:
 *   - Every money value is a DECIMAL STRING ("500.00000000"), never a JS number
 *     -- real-money precision past 2^53 or on fractional cents. Kept as `string`
 *     here; parse only where arithmetic is genuinely needed.
 *   - Fields are camelCase; the snake_case D1 seam is hidden by the backend.
 */

/** The one envelope every endpoint answers in (`src/api/envelope.ts`). */
export type ApiEnvelope<T> =
  | { readonly data: T; readonly error: null }
  | { readonly data: null; readonly error: { readonly code: string; readonly message: string } };

/** A bot's lifecycle status (spec section 8.1). */
export type BotStatus = "created" | "running" | "halted" | "stopped";

export type Strategy = "dca" | "grid";

/**
 * The held position + realized profit, read from the bot's own Durable Object
 * state (`positionOf` in serialize.ts). `null` when the object holds no state
 * (an orphaned row). `realizedGross` is named honestly: gross realized profit
 * before fees -- the backend deliberately does not call it "pnl".
 */
export type Position =
  | {
      readonly strategy: "grid";
      readonly heldQuantity: string;
      readonly realizedGross: string;
    }
  | {
      readonly strategy: "dca";
      readonly heldQuantity: string;
      readonly averageEntryPrice: string;
      readonly cost: string;
      readonly realizedGross: string;
    };

/** One bot in the list view (`botSummary` in serialize.ts, `GET /api/bots`). */
export interface Bot {
  readonly id: string;
  readonly accountLabel: string;
  readonly exchange: string;
  readonly pair: string;
  readonly strategy: Strategy;
  readonly status: BotStatus;
  readonly allocatedCapital: string;
  readonly capitalAsset: string;
  readonly stopLossPct: string;
  readonly takeProfitPct: string | null;
  readonly haltReason: string | null;
  readonly haltedAt: number | null;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly position: Position | null;
  readonly orphaned: boolean;
}

// ---------------------------------------------------------------------------
// Bot detail (`botDetail` in serialize.ts, `GET /api/bots/:id`)
//
// The summary above, PLUS the bot's own Durable Object `config` and `state`
// (the grid ladder or the DCA entries live in `state`), and the D1 order, trade
// and alert history for this bot. `config`/`state` go through the backend's
// `jsonSafe`, which deep-renders every Money bigint to a decimal string and
// leaves everything else (numbers, booleans, timestamps) as-is -- so money is a
// `string` here exactly as in the summary, and counts/flags stay their native
// type. Both are `null` for an orphaned bot (a `bot_instances` row whose object
// holds no state).
// ---------------------------------------------------------------------------

export type OrderSide = "buy" | "sell";

/** One DCA entry filled in the current cycle (`DcaEntry`, spec 6.3). */
export interface DcaEntry {
  readonly clientOrderId: string;
  readonly price: string;
  readonly quantity: string;
  readonly cost: string;
  readonly at: number;
}

/** The position built up by the current DCA cycle (`DcaPosition`). */
export interface DcaPosition {
  readonly quantity: string;
  readonly cost: string;
  readonly averageEntryPrice: string;
  readonly entries: readonly DcaEntry[];
  /** Additional buys filled this cycle, excluding the base order. */
  readonly additionalBuysUsed: number;
  readonly lastEntryPrice: string;
}

/** Section 6.3's DCA parameters (`DcaParams`). */
export interface DcaParams {
  readonly baseOrderSize: string;
  readonly additionalOrderSize: string;
  readonly stepMultiplier: string;
  readonly dropPct: string;
  /** The configured maximum number of additional buys, excluding the base. */
  readonly maxAdditionalBuys: number;
  readonly takeProfitPct: string;
  readonly stopLossPct: string;
  readonly autoRestart: boolean;
  readonly sellOnStopLoss: boolean;
}

/** One grid level's resting order, or `null` for a level with no order (`GridSlot`). */
export interface GridSlot {
  readonly side: OrderSide;
  readonly clientOrderId: string;
  /** For a sell: the buy price it replaced. For a buy: null. */
  readonly costBasis: string | null;
  readonly quantity: string;
}

/**
 * The grid ladder state (`GridLadder`, spec 6.2). `levels` is ascending
 * (`levels[0]` is the lower bound) and index-aligned with `slots`.
 */
export interface GridLadder {
  readonly levels: readonly string[];
  readonly slots: readonly (GridSlot | null)[];
  readonly heldQuantity: string;
  readonly heldCost: string;
  readonly realizedGross: string;
  /** Whether the initial buy ladder has been placed (section 6.2 step 2). */
  readonly placed: boolean;
}

/** Section 6.2's grid parameters (`GridParams`). */
export interface GridParams {
  readonly upperBound: string;
  readonly lowerBound: string;
  readonly gridLines: number;
  readonly spacing: "arithmetic" | "geometric";
  readonly orderSize: string;
  readonly stopLossPct: string;
  readonly breakoutTakeProfit: boolean;
  readonly breakoutThresholdPct: string | null;
  readonly takeProfitAmount: string | null;
}

interface BotConfigBase {
  readonly schemaVersion: number;
  readonly botInstanceId: string;
  readonly accountLabel: string;
  readonly exchange: string;
  readonly pair: string;
  readonly capitalAsset: string;
  readonly allocatedCapital: string;
}

export type BotConfig =
  | (BotConfigBase & { readonly strategy: "dca"; readonly params: DcaParams })
  | (BotConfigBase & { readonly strategy: "grid"; readonly params: GridParams });

/**
 * The bot's persisted runtime state (`BotRuntimeState`). `config.strategy` is
 * the authoritative discriminator for which strategy-specific state is live:
 * a DCA bot populates `position`, a grid bot populates `ladder`.
 */
export interface BotRuntimeState {
  readonly schemaVersion: number;
  readonly status: BotStatus;
  readonly cycleCount: number;
  readonly position: DcaPosition;
  readonly ladder?: GridLadder;
  readonly nextSequence: number;
  readonly openOrderIds: readonly string[];
  readonly haltReason: string | null;
  readonly haltedAt: number | null;
  /** The latest usable price the bot has seen, or null before its first. */
  readonly lastPrice: string | null;
  readonly lastPriceAt: number | null;
  readonly realizedGross: string;
  readonly filters: unknown;
  readonly exitOrderId: string | null;
  readonly exitKind?: "take_profit" | "liquidation";
}

/** One order from D1 (`orderView` in serialize.ts). */
export interface Order {
  readonly id: string;
  readonly botInstanceId: string;
  readonly clientOrderId: string;
  readonly exchangeOrderId: string | null;
  readonly side: OrderSide;
  readonly price: string;
  readonly quantity: string;
  readonly filledQuantity: string;
  /** pending | partially_filled | filled | cancelled (kept loose, mirrored). */
  readonly status: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** One trade (fill) from D1 (`tradeView` in serialize.ts). */
export interface Trade {
  readonly id: string;
  readonly orderId: string;
  readonly botInstanceId: string;
  readonly exchangeTradeId: string | null;
  readonly price: string;
  readonly quantity: string;
  readonly feeAmount: string;
  readonly feeAsset: string;
  readonly feeReportingAmount: string | null;
  readonly feeReportingAsset: string | null;
  readonly feeConversionRate: string | null;
  readonly executedAt: number;
}

/** The full detail of one bot (`botDetail` in serialize.ts). */
export interface BotDetail extends Bot {
  readonly config: BotConfig | null;
  readonly state: BotRuntimeState | null;
  readonly orders: readonly Order[];
  readonly trades: readonly Trade[];
  readonly alerts: readonly Alert[];
}

export type AlertSeverity = "info" | "warning" | "critical";
export type AlertCategory = "trading" | "system";

/** One alert (`alertView` in serialize.ts, `GET /api/alerts`). */
export interface Alert {
  readonly id: string;
  readonly severity: AlertSeverity;
  readonly category: AlertCategory;
  readonly alertType: string;
  readonly botInstanceId: string | null;
  readonly source: string;
  readonly message: string;
  readonly resolved: boolean;
  readonly createdAt: number;
  readonly notifiedAt: number | null;
}
