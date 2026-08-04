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

/**
 * One registered account and the venue it trades on (`listAccounts` in
 * src/api/handlers.ts, `GET /api/accounts`). This is the authoritative list the
 * create-bot form's account dropdown reads: every selectable account is real and
 * carries its own exchange, so exchange is never a separately-typed value.
 */
export interface Account {
  readonly accountLabel: string;
  readonly exchange: string;
  readonly createdAt: number;
}

/**
 * An account's live tradable pairs (`getAccountSymbols` in src/api/handlers.ts,
 * `GET /api/accounts/:label/symbols`). `pairs` is the venue's real tradable set
 * (thousands on Binance, a few hundred on Gemini), so the create-bot pair field
 * offers real symbols instead of a free-typed guess. `cached` is true when served
 * from the KV cache rather than a fresh exchange call.
 *
 * FAILURES the caller must branch on (thrown as `ApiError`):
 *   - `exchange_unavailable` (502) -- the venue could not be reached; this is the
 *     Binance geo-block seen live in production. The message carries the reason;
 *     the form frames it as "our end", not the user's mistake.
 *   - `unknown_account` (404)      -- no such registered account. Rare from this
 *     form, since the dropdown only ever offers registered accounts.
 */
export interface AccountSymbols {
  readonly accountLabel: string;
  readonly exchange: string;
  readonly pairs: readonly string[];
  readonly cached: boolean;
  readonly fetchedAt: number;
}

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
// Bot creation REQUEST (`POST /api/bots`, `createBot` handler)
//
// The shape the create form SENDS -- mirrored from the backend handler's decode
// (`createBot` in src/api/handlers.ts) and the two strategy param decoders
// (`decodeDcaParams`/`decodeGridParams`). Money is a decimal string on the way
// IN too, exactly as it comes back out; a percentage is a plain decimal string
// ("20" = 20%). The strategy-specific `params` object is what each decoder
// expects, minus `strategy`/`schemaVersion`, which the backend stamps itself.
//
// A successful create answers 201 with the full `BotDetail` (above), so the
// caller navigates straight to the new bot without a second fetch.
// ---------------------------------------------------------------------------

/** The DCA `params` object `decodeDcaParams` expects (all money/percent strings). */
export interface DcaParamsInput {
  readonly baseOrderSize: string;
  readonly additionalOrderSize: string;
  readonly stepMultiplier: string;
  readonly dropPct: string;
  readonly maxAdditionalBuys: number;
  /** Mandatory for DCA -- defines the cycle's exit (spec 6.3 step 4). */
  readonly takeProfitPct: string;
  readonly stopLossPct: string;
  readonly autoRestart: boolean;
  /**
   * Always false. The backend rejects `true` as unimplemented (a stop-loss halt
   * cancels open orders and leaves the position held; a configured control that
   * silently did nothing is worse than none -- see the DcaParams.sellOnStopLoss
   * note and validateDcaParams). Sent explicitly so the decoder's required-
   * boolean check passes; the form offers no toggle for it.
   */
  readonly sellOnStopLoss: false;
}

/** The grid `params` object `decodeGridParams` expects. */
export interface GridParamsInput {
  readonly upperBound: string;
  readonly lowerBound: string;
  readonly gridLines: number;
  readonly spacing: "arithmetic" | "geometric";
  readonly orderSize: string;
  readonly stopLossPct: string;
  /** Cash out on an upside breakout (spec 6.2 step 5; defaults on). */
  readonly breakoutTakeProfit: boolean;
  /** Optional; the backend defaults an omitted value to null. */
  readonly breakoutThresholdPct?: string | null;
  /**
   * The grid take-profit -- an accumulated realized-profit AMOUNT, not a
   * percentage, and OPTIONAL for grid (spec 6.1/6.2). Null/omitted leaves the
   * bot relying on its stop-loss and breakout exit.
   */
  readonly takeProfitAmount?: string | null;
}

interface CreateBotBase {
  readonly botInstanceId: string;
  readonly accountLabel: string;
  // NOTE: `exchange` is deliberately NOT part of the request. The account
  // registry (step 11) is authoritative for which venue an account trades on --
  // `POST /api/bots` derives it from the selected account and REJECTS a body
  // `exchange` that disagrees (`exchange_mismatch`). Omitting it entirely makes
  // that disagreement structurally impossible: the form shows the account's real
  // exchange read-only, and never sends a separately-typed value that could drift
  // from it. See `resolveBotExchange` in src/api/handlers.ts.
  readonly pair: string;
  readonly capitalAsset: string;
  readonly allocatedCapital: string;
}

/** The discriminated body of `POST /api/bots`. */
export type CreateBotRequest =
  | (CreateBotBase & { readonly strategy: "dca"; readonly params: DcaParamsInput })
  | (CreateBotBase & { readonly strategy: "grid"; readonly params: GridParamsInput });

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
// Start (`POST /api/bots/:id/start`, `startBot` handler)
//
// The response is `{ result, bot }`, the same shape as liquidate. `result` is
// the bot object's own `PipelineResult` from `BotInstance.start` -- and the
// crucial fact, confirmed from source (src/durable-objects/bot-instance.ts): a
// successful start is ALWAYS `{ status: "running", action: "started" }`. It
// subscribes the bot to its live price feed (fail-closed) but places no order in
// this call: the base order (DCA) / ladder (grid) fires on the next
// `onPriceUpdate`, which since step 14 is a real closed candle roughly a minute
// out. So start still cannot return a price, reachability, or order-filter
// outcome, and has no success-with-a-different-action path to branch on the way
// liquidate has. Its named failure is a bot whose status is not `created`,
// arriving as a thrown `ApiError` with code `invalid_status` (409); a refused
// feed subscribe can also throw, and lands in the generic error branch.
// ---------------------------------------------------------------------------

/** The `PipelineResult` a start returns -- always `action: "started"` on success. */
export interface StartResult {
  readonly status: BotStatus;
  readonly action: string;
  readonly detail?: string;
}

/** The body of a successful `POST /api/bots/:id/start`. */
export interface StartResponse {
  readonly result: StartResult;
  /** The refreshed summary (now `running`), or null if the row vanished mid-call. */
  readonly bot: Bot | null;
}

// ---------------------------------------------------------------------------
// Resume (`POST /api/bots/:id/resume`, `resumeBot` handler)
//
// Section 7.2 step 5's explicit human action, the only path out of `halted`.
// Same `{ result, bot }` shape as start and liquidate, and like start there is
// no success-with-a-different-action to branch on: `BotInstance.resume` returns
// `{ status: "running", action: "resumed" }` or throws.
//
// ITS ERROR SURFACE IS WIDER THAN START'S, confirmed from
// src/durable-objects/bot-instance.ts rather than assumed by analogy. Resume
// asserts BOTH risk latches before it subscribes or flips (`assertGlobalArmed`,
// `assertAccountArmed`) — `start` asserts neither — so on top of start's
// `invalid_status` (409) and `not_attached` (503, no PRICE_FEED binding) it can
// also throw `globally_tripped` (409) and `account_tripped` (409). Every one of
// them is raised BEFORE the status flip, so a failed resume leaves the bot
// halted exactly as it was.
//
// What it CANNOT throw: an unreachable price feed or exchange. The subscribe
// bottoms out in `PriceFeed.#ensureConnected`, which catches a failed connect,
// schedules a backoff reconnect and returns — so that case is a 200 with the bot
// running blind, reported by the feed's own `price_feed_blind` alert, not by
// this endpoint.
//
// `halt_reason` and `halted_at` ARE cleared on resume, and this note used to say
// the opposite. Migration 0001's CHECK permits keeping the reason, but permitting
// is not requiring: `haltReason` is a CURRENT-state field, and a `running` bot
// that still carried it made the detail view advertise a failure the operator had
// already fixed. After a successful resume `bot.haltReason` is therefore null.
// The reason it stopped is preserved in the `bot.resumed` audit entry
// (`previous_halt_reason`), which is where a past event belongs.
//
// The resume dialog is unaffected: it reads the bot while it is still `halted`,
// so it shows the real reason at the moment it matters.
// ---------------------------------------------------------------------------

/** The `PipelineResult` a resume returns -- always `action: "resumed"` on success. */
export interface ResumeResult {
  readonly status: BotStatus;
  readonly action: string;
  readonly detail?: string;
}

/** The body of a successful `POST /api/bots/:id/resume`. */
export interface ResumeResponse {
  readonly result: ResumeResult;
  /** The refreshed summary (now `running`), or null if the row vanished mid-call. */
  readonly bot: Bot | null;
}

// ---------------------------------------------------------------------------
// Apply missed fills (`POST /api/bots/:id/apply-missed-fills`, step 18)
//
// The order-state-drift REPAIR: section 9 halts and alerts on drift and
// deliberately never auto-corrects it, because correcting means writing trades
// and moving a position away from a belief the system has just proved wrong.
// This endpoint is that correction as a human action.
//
// Same `{ result, bot }` shape as start/resume/liquidate. `result` is the DO's
// own `MissedFillsResult`, mirrored from src/durable-objects/bot-instance.ts.
//
// THE CRUCIAL PROPERTY FOR A CALLER: a 200 does NOT mean everything was
// repaired. `skipped` carries every order or fill this pass could not read or
// could not apply, and it is a normal part of a success -- section 5.6 again:
// an unreadable order is REPORTED, never assumed to have not filled. A frontend
// that only awaited success would silently report a half-done repair as done.
//
// Two more facts the UI must not misstate:
//   - `status` is always the status the bot STARTED with. This never resumes a
//     bot; halted before, halted after.
//   - No order is ever placed. For a GRID bot that is load-bearing: a fill
//     normally places the paired replacement sell, and this path passes
//     `placeReplacement: false`, so the repaired rung comes back empty and
//     stays empty (`#placeInitialLadder` runs once, so a later resume does not
//     place it either).
// ---------------------------------------------------------------------------

/**
 * One execution the repair recorded. `fillId` is the EXCHANGE's own id (Gemini's
 * `tid`), never a synthesised one -- `applyFill` deduplicates on it, so a made-up
 * id would make the real fill either double-count or be silently swallowed. That
 * same identity check is what makes the whole operation idempotent: a second run
 * finds every id already applied and does nothing.
 */
export interface AppliedFill {
  readonly clientOrderId: string;
  readonly fillId: string;
  /** Decimal string, like every other quantity. */
  readonly quantity: string;
  /** Decimal string, like every other price. */
  readonly price: string;
}

/** The `MissedFillsResult` the repair returns. */
export interface MissedFillsResult {
  /** Always the status it started with -- this operation never resumes a bot. */
  readonly status: BotStatus;
  readonly applied: readonly AppliedFill[];
  /**
   * Orders or fills this pass could NOT account for, each with its reason, as
   * the backend worded it. Non-empty means the repair is INCOMPLETE. Two
   * distinct causes live in here and the backend words them differently on
   * purpose:
   *   - an unusable `getOrderStatus` read (transport/exchange error);
   *   - a response carrying no `trades` at all, which is NOT the same as "no
   *     executions" -- it means the per-fill detail was not reported, so there is
   *     no real fill id to apply and the order is reported as unread.
   * Rendered verbatim rather than parsed: the distinction lives in the prose,
   * and re-deriving it from string matching would be a second, weaker copy of a
   * judgement the backend already made.
   */
  readonly skipped: readonly string[];
}

/** The body of a successful `POST /api/bots/:id/apply-missed-fills`. */
export interface ApplyMissedFillsResponse {
  readonly result: MissedFillsResult;
  /** The refreshed summary -- still `halted` -- or null if the row vanished. */
  readonly bot: Bot | null;
}

// ---------------------------------------------------------------------------
// Check open orders (`POST /api/bots/:id/check-open-orders`, step 22)
//
// The observation pass, run on demand. Mirrored from the DO's `OrderCheckResult`.
//
// HOW IT DIFFERS FROM apply-missed-fills, which is directly above it on the bot
// page and which the UI must not blur into it:
//   - It runs on a RUNNING bot; that is its normal case. The repair refuses
//     anything but `halted`.
//   - It is not gated on a finding. It is the SAME pass the alarm has run every
//     30 seconds since step 20, so a human triggering it introduces no operation
//     the system was not already performing unattended. What a human adds is
//     running it NOW -- which is the whole point when the scheduled path has
//     backed off or gone blind.
//   - IT CAN PLACE AN ORDER. On a running grid bot a folded buy places its
//     paired replacement sell, exactly as a live fill would. The repair path
//     passes `placeReplacement: false` unconditionally; this one derives it from
//     `status === "running"`. So this is NOT a books-only action and must never
//     be described as one.
//
// `status` is whatever the bot holds after the pass -- this never changes it.
// ---------------------------------------------------------------------------

/** The `OrderCheckResult` one observation pass returns. */
export interface OrderCheckResult {
  /** The status the bot holds after the pass. This operation never changes it. */
  readonly status: BotStatus;
  /** Executions newly folded in, each with the exchange's own fill id. */
  readonly applied: readonly AppliedFill[];
  /**
   * Orders this pass could not fully account for, each with its reason, worded
   * by the backend. Non-empty means the books are still behind the exchange.
   * Rendered verbatim, for the same reason as the repair's: the distinction
   * between "could not read" and "read, and refused to act" lives in the prose,
   * and re-deriving it here by string matching would be a weaker second copy of
   * a judgement already made.
   */
  readonly skipped: readonly string[];
  /** Orders whose local record was closed to match a terminal exchange state. */
  readonly closed: readonly string[];
  /**
   * True when the pass STOOD ASIDE for a concurrent pass rather than completing
   * (step 21: the poll yields one-way, since everything it does is re-derivable).
   *
   * The UI must surface this rather than treating it as success. Three empty
   * arrays are otherwise indistinguishable from a clean pass, and "your books
   * are up to date" is a very different claim from "I did not look". Trying
   * again is the correct response and is always safe.
   */
  readonly deferred: boolean;
}

/** The body of a successful `POST /api/bots/:id/check-open-orders`. */
export interface CheckOpenOrdersResponse {
  readonly result: OrderCheckResult;
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

// ---------------------------------------------------------------------------
// Manual adjustments (spec 8.6; `manualAdjustmentView` in serialize.ts,
// `POST /api/manual-adjustments`, `createManualAdjustment` handler).
//
// The account owner logs a fund movement they made on the exchange OUTSIDE any
// bot (a deposit or a withdrawal) so reconciliation can subtract it from any
// detected discrepancy before deciding whether to alert (section 9). The
// `amount` is SIGNED: negative is a withdrawal, positive a deposit. It is a
// decimal string in and out, exactly like every other money value.
//
// There is NO read endpoint: the route table exposes only the POST. So there is
// no `fetchManualAdjustments` here and no client-side list -- the honest
// single-action confirmation from the 201 response is all this surface offers.
// ---------------------------------------------------------------------------

/** The body of `POST /api/manual-adjustments`. `amount` is a SIGNED decimal
 *  string (leading "-" for a withdrawal); the backend parses it with the same
 *  money parser as every other amount. All four fields are required. */
export interface ManualAdjustmentRequest {
  readonly accountLabel: string;
  readonly asset: string;
  /** Signed: "-250.5" withdraws, "250.5" deposits. */
  readonly amount: string;
  readonly note: string;
}

/** The saved adjustment the 201 echoes back (`manualAdjustmentView`). The
 *  server's authoritative record of what was written -- used as the confirmation
 *  receipt. `reconciledAt` is null until a reconciliation run consumes it. */
export interface ManualAdjustment {
  readonly id: string;
  readonly accountLabel: string;
  readonly asset: string;
  readonly amount: string;
  readonly note: string;
  readonly reconciledAt: number | null;
  readonly createdAt: number;
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
