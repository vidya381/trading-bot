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

// ---------------------------------------------------------------------------
// Liquidation (`POST /api/bots/:id/liquidate`, `liquidateBot` handler)
//
// The response is `{ result, bot }`. `result` is the bot object's own
// `PipelineResult` (mirrored from `src/durable-objects/bot-instance.ts`) -- and
// crucially, the PRICE-UNUSABLE outcome is NOT an HTTP error: when no current
// price can be read, `liquidatePosition` alerts, leaves the position held, and
// returns normally with `action: "no_price"` (a 200). So the frontend must
// branch on `result.action` within a success, not only on error codes. The
// error paths (`invalid_status` for a no-longer-halted bot, `not_attached` for
// an environment with no exchange wired) arrive as thrown `ApiError`s instead.
// ---------------------------------------------------------------------------

/** The `PipelineResult` a liquidation returns. */
export interface LiquidationResult {
  readonly status: BotStatus;
  /**
   * What the call did. The outcomes the dashboard distinguishes:
   *   - "liquidating"          -- a marketable limit sell was placed; the bot
   *                               stays halted (the fill may still rest).
   *   - "no_price"             -- no current price was readable; nothing sold,
   *                               the position is held, a critical alert fired.
   *   - "nothing_to_liquidate" -- the position was already flat.
   *   - "hold"                 -- an exit/liquidation order was already live;
   *                               nothing was placed (idempotent).
   */
  readonly action: string;
  readonly detail?: string;
}

/** The body of a successful `POST /api/bots/:id/liquidate`. */
export interface LiquidateResponse {
  readonly result: LiquidationResult;
  /** The refreshed summary, or null if the bot's row vanished mid-call. */
  readonly bot: Bot | null;
}

// ---------------------------------------------------------------------------
// Global kill switch (spec section 7.4; `killSwitchView` in serialize.ts,
// `GET /api/kill-switch`, `POST /api/kill-switch/{trigger,reset}`).
//
// The status view is the `global_kill_switch` row, camelCased; the `armed` shape
// (all-null trip/reset fields) is what the backend returns when the row has
// never been written, so `state` is the only field guaranteed to be present.
//
// A TRIGGER returns `{ result, killSwitch }`. `result` is the backend's
// `GlobalTripResult` (mirrored from `src/reconciliation/kill-switch.ts`): the
// sweep NEVER rethrows on an unreachable bot -- it halts what it can and reports
// the rest in `failures`, so a partial outcome is a normal 200, not an error.
// `haltedBotIds` and `failures` together are the honest record of what the pull
// actually did (this session's brief items 5 and 7).
// ---------------------------------------------------------------------------

export type KillSwitchState = "armed" | "tripped";

export interface KillSwitchStatus {
  readonly state: KillSwitchState;
  readonly reason: string | null;
  readonly trippedAt: number | null;
  readonly trippedBy: string | null;
  readonly resetAt: number | null;
  readonly resetBy: string | null;
}

/** One bot the sweep reached but could not halt (`failures[]` in the result). */
export interface KillSwitchHaltFailure {
  readonly botInstanceId: string;
  readonly message: string;
}

/** The backend's `GlobalTripResult`: what a single pull actually did. */
export interface GlobalTripResult {
  /** False when the switch was already tripped by an earlier call (a re-sweep). */
  readonly newlyTripped: boolean;
  /** Bots this call successfully halted, across every account. */
  readonly haltedBotIds: readonly string[];
  /** Bots this call reached but could NOT halt -- non-empty is a partial outcome. */
  readonly failures: readonly KillSwitchHaltFailure[];
}

/** The body of a successful `POST /api/kill-switch/trigger`. */
export interface TriggerKillSwitchResponse {
  readonly result: GlobalTripResult;
  readonly killSwitch: KillSwitchStatus;
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
