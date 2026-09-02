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
  /**
   * This account's `capital_ledger` headroom, or NULL when the ledger read
   * FAILED. Null is never "this account has no capital" -- an account nobody has
   * seeded has no ledger rows and arrives as `{ rowsRead: 0, assets: [] }`,
   * which is a real state and a different fact. The dashboard must not render a
   * confident figure for either, and must not render the same figure for both.
   */
  readonly capital: AccountCapital | null;
}

/**
 * One `capital_ledger` row's three money figures, per (account, asset).
 *
 * `available` is `totalBalance - totalAllocated`, computed SERVER-SIDE by
 * `readAccountCapital` -- the dashboard never re-derives it. That subtraction is
 * not a display convenience: it is the identical arithmetic
 * `createBotInstanceWithCapital` runs as its binding gate, so this figure is
 * exactly what a new bot is allowed to reserve.
 *
 * ⚠ `available` CAN BE NEGATIVE, and is not clamped anywhere in this chain. An
 * account allocated beyond its balance is a real, representable state (migration
 * 0001 deliberately omits the CHECK that would forbid it), and it is the one
 * state a human most needs to see before allocating more. Rendered amber, in the
 * same spirit as the negative IDLE tile.
 */
export interface AccountAssetHeadroom {
  readonly asset: string;
  readonly totalBalance: string;
  readonly totalAllocated: string;
  /** `totalBalance - totalAllocated`. May be negative; see above. */
  readonly available: string;
  /** The LEDGER ROW's own `updated_at`, not when the read ran. */
  readonly updatedAt: number;
}

/**
 * The capital block on an `Account` (`accountCapitalView` in
 * src/api/serialize.ts).
 *
 * NEVER SUMMED ACROSS ASSETS OR ACROSS ACCOUNTS. A bot draws from exactly one
 * `capital_ledger` row, keyed (account_label, asset), so a blended total would
 * be a number nothing can actually spend -- the same rule `accountTotals.ts`
 * keeps for its per-asset grouping, applied one key wider.
 */
export interface AccountCapital {
  /** When the ledger was read. Stale from that instant on. */
  readonly readAt: number;
  readonly rowsRead: number;
  readonly assets: readonly AccountAssetHeadroom[];
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

/**
 * Every strategy a bot row can carry (`StrategyType` in the Worker).
 *
 * ⚠ `"trailing_stop"` WAS MISSING HERE, AND THAT ABSENCE IS WHAT MADE THE DETAIL
 * PAGE GO BLANK. `Position` below had already grown its third variant (spec 22),
 * but this union and `BotConfig` had not -- so `StrategyState`'s
 * `if (grid) ... else DCA` fall-through TYPE-CHECKED for a trailing-stop bot and
 * handed `{ trailPct }` to a component that reads `params.baseOrderSize`.
 * `formatMoney(undefined)` threw out of render, React unmounted the whole tree,
 * and the page rendered nothing at all.
 *
 * Adding the variant here is therefore not bookkeeping: it is what makes the
 * missing branch a COMPILE ERROR rather than a runtime blank. `strategyView.ts`
 * keeps the runtime list in step with this union, pinned by a type-level check
 * so a fourth strategy cannot be added to one and forgotten in the other.
 */
export type Strategy = "dca" | "grid" | "trailing_stop";

/**
 * The held position + realized profit, read from the bot's own Durable Object
 * state (`positionOf` in serialize.ts). `null` when the object holds no state
 * (an orphaned row). `realizedGross` is named honestly: gross realized profit
 * before fees -- the backend deliberately does not call it "pnl".
 *
 * `cost` IS ON BOTH ARMS as of step 25, and both arms mean the same thing by it:
 * the bare notional paid for what is STILL HELD, gross of fees. DCA's comes from
 * `position.cost`, grid's from `ladder.heldCost`; the backend renamed the latter
 * to match rather than the reverse, so a caller totalling what the fleet is
 * holding reads `position.cost` without branching on strategy.
 */
export type Position =
  | {
      readonly strategy: "grid";
      readonly heldQuantity: string;
      readonly cost: string;
      readonly realizedGross: string;
    }
  | {
      readonly strategy: "dca";
      readonly heldQuantity: string;
      readonly averageEntryPrice: string;
      readonly cost: string;
      readonly realizedGross: string;
    }
  | {
      /**
       * Spec 22. Mirrors `positionOf`'s trailing-stop branch EXACTLY -- pinned by
       * a two-way type assertion in `src/strategies/trailing-stop-dashboard-parity.test.ts`,
       * not by this comment, for the reason the other two parity tests give: this
       * file is a hand-written mirror across a `tsc` seam the root project does
       * not compile, so a drift here fails nothing anywhere without a pin.
       *
       * `averageEntryPrice` is a real entry price here, not an average of many:
       * 22.2 decision 4 makes this a single-entry strategy.
       */
      readonly strategy: "trailing_stop";
      readonly heldQuantity: string;
      readonly averageEntryPrice: string;
      readonly cost: string;
      readonly realizedGross: string;
      /** Highest price seen since entry (22.2 decision 3). Null before the first price. */
      readonly highWaterMark: string | null;
      /** `highWaterMark x (100 - trailPct) / 100`. Null before the first price. */
      readonly trailLevel: string | null;
    };

/**
 * What one bot has paid the venue, in ITS OWN `capitalAsset` (`BotFees` in
 * serialize.ts). Step 25.
 *
 * `reported` IS A FLOOR, NOT A TOTAL. It sums `trades.fee_reporting_amount`,
 * which the backend writes at fill time as the fee converted to the capital
 * asset -- and which is NULL whenever no rate was available, the common case
 * being a fee charged in the exchange's own token. Those fills are real costs
 * this number does not contain.
 *
 * `unpricedCount` is how many. Non-zero means any figure derived from
 * `reported` UNDERSTATES cost and therefore OVERSTATES profit, which is the one
 * direction a trading dashboard must never be wrong in. `shared/fees.ts`'s
 * `realizedPnl` has always answered this by withholding its `net` entirely
 * (`complete: false`); the account rollup does the same rather than showing a
 * net that quietly omits a known cost.
 */
export interface BotFees {
  /** Sum of the fees that could be PRICED, in `capitalAsset`. A floor. */
  readonly reported: string;
  /** Fills whose fee could not be priced. Non-zero means `reported` is partial. */
  readonly unpricedCount: number;
}

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
  /**
   * Hidden from the bot list's DEFAULT view (step 26). NOT a status and not a
   * deletion: an archived bot's row, object state, orders, trades and alerts are
   * all untouched and its detail page still renders in full.
   *
   * ⚠ IT NO LONGER STILL HOLDS ITS ALLOCATION (step 26.1). Archiving now closes
   * the bot, so a bot archived through the endpoint is `stopped` and its capital
   * has been returned. Two exceptions keep their reservation and are the reason
   * this flag still must not be read as "capital returned": a bot archived
   * BEFORE step 26.1 shipped, and an orphan (no object state, so it cannot be
   * closed). `status === "stopped"` is the only honest test for whether the
   * capital came back, exactly as it has always been.
   *
   * It is orthogonal to `status` and must not be derived from it -- an archived
   * bot is halted or stopped, but a halted bot is not archived by implication.
   * The backend never filters on it; hiding is this dashboard's job, and it
   * hides only the TABLE. Archived bots keep counting toward the account-level
   * totals, because a stopped bot can still be holding real inventory (see
   * `accountTotals.ts`) and an unclosed archived bot still holds its allocation.
   */
  readonly archived: boolean;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly position: Position | null;
  /**
   * The latest usable price this bot has seen, or null before its first (step
   * 25; the same `state.lastPrice` the detail view has always shown, lifted into
   * the summary so the list can mark positions to market without a fetch per
   * bot).
   *
   * NULL IS NOT ZERO. It means the current worth of anything held is UNKNOWN --
   * section 5.6's rule that an unusable price is reported, never guessed at. A
   * bot holding nothing and a bot holding 0.4 BTC it cannot value are different
   * situations, and only the second one poisons a total.
   */
  readonly lastPrice: string | null;
  /**
   * Completed cycles -- **DCA ONLY**, and null for an orphan.
   *
   * The backend increments this in exactly one place, `#completeCycle`, which
   * takes a `DcaConfig`. A grid bot has no cycle to complete and reports the 0
   * it was created with for its entire life. Summing this across a mixed fleet
   * gives a DCA cycle count, and it must be LABELLED as one; under a bare
   * "cycles" heading it reads as though the grid bots have done nothing.
   */
  readonly cycleCount: number | null;
  /** Fees paid, in this bot's capital asset. See `BotFees` -- `reported` is a floor. */
  readonly fees: BotFees;
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

/**
 * Section 22's trailing-stop parameters (`TrailingStopParams` in
 * src/strategies/trailing-stop.ts).
 *
 * ONE FIELD, AND THAT IS THE WHOLE SHAPE (22.2 decision 1). `trailPct` does
 * double duty: the trail distance below the high-water mark, and the initial
 * stop distance from entry before any new high is made.
 *
 * ⚠ NO ORDER SIZE, AND THAT IS NOT AN OMISSION IN THIS MIRROR. Per 22.2's
 * consequence of decisions 1 and 4 the single entry is sized by
 * `allocatedCapital`, so there is no field that could size it otherwise --
 * which is exactly why handing these params to `DcaPositionView` crashed:
 * every money field that view reads is absent here.
 *
 * Pinned against the Worker's own type in
 * `src/strategies/trailing-stop-dashboard-parity.test.ts`.
 */
export interface TrailingStopParams {
  readonly trailPct: string;
}

export type BotConfig =
  | (BotConfigBase & { readonly strategy: "dca"; readonly params: DcaParams })
  | (BotConfigBase & { readonly strategy: "grid"; readonly params: GridParams })
  | (BotConfigBase & { readonly strategy: "trailing_stop"; readonly params: TrailingStopParams });

/**
 * The bot's persisted runtime state (`BotRuntimeState`). `config.strategy` is
 * the authoritative discriminator for which strategy-specific state is live:
 * a DCA bot populates `position`, a grid bot populates `ladder`, and a
 * trailing-stop bot populates `position` plus `highWaterMark`.
 */
export interface BotRuntimeState {
  readonly schemaVersion: number;
  readonly status: BotStatus;
  readonly cycleCount: number;
  readonly position: DcaPosition;
  readonly ladder?: GridLadder;
  /**
   * Highest price seen since entry (22.2 decision 3, trailing stop only).
   *
   * ⚠ THREE STATES, NOT TWO, and the optional-plus-null type is deliberate:
   *   - ABSENT   -- never set. `createTrailingStop` omits the key entirely,
   *                 because "no high recorded yet" is what absent means to
   *                 `raisesHighWaterMark`.
   *   - a string -- a real mark.
   *   - `null`   -- explicitly cleared after an exit completes. The Worker
   *                 writes `highWaterMark: undefined`, which is an OWN KEY, and
   *                 `jsonSafe` narrows undefined to null on the way out.
   *
   * All three mean "there is no mark to show", and every reader here must treat
   * them the same. The FIGURE an operator reads comes from `position` (the
   * backend derives `trailLevel` from this mark with the strategy's own
   * arithmetic); this field is the raw state behind it.
   */
  readonly highWaterMark?: string | null;
  /**
   * How many times the single entry order has been placed (spec 22.10, trailing
   * stop only). The bound on an otherwise unbounded retry -- and the reason
   * `bot-ts1` halted with `entry_unfilled` (decision log 86).
   *
   * ABSENT MEANS ZERO, and absent is the normal case: the Worker adds the key
   * only for a trailing-stop bot, and only once it has placed an entry. Same
   * three-state caveat as `highWaterMark` above -- `jsonSafe` turns an
   * explicitly-undefined own key into `null` -- so every reader treats absent,
   * null and 0 alike.
   *
   * ⚠ THE CAP ITSELF IS NOT MIRRORED HERE. `MAX_ENTRY_ATTEMPTS` lives in the
   * Worker, and a copy of it in this file would be a number that can silently
   * disagree with the one the bot actually stops at -- the failure this whole
   * mirror is tested against. The count is shown; the limit is not invented.
   */
  readonly entryAttempts?: number | null;
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
  readonly exitKind?: "take_profit" | "liquidation" | "trailing_stop";
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
/**
 * A spot price fetched for a HALTED bot, so an operator can see where the
 * market is before deciding whether to resume.
 *
 * DELIBERATELY NOT `state.lastPrice`, and the two must never be conflated.
 * `lastPrice` is the price this bot last traded against -- what `unrealizedPnl`
 * and the grid ladder are computed from -- and it is correctly FROZEN at the
 * moment the bot halted. This is a separate, freshly-fetched number that feeds
 * no calculation at all.
 *
 * `at` is not optional. A price with no "as of" is what made a correctly-frozen
 * `lastPrice` look broken, which is why this feature exists at all.
 */
export interface MarketPrice {
  readonly price: string;
  readonly at: number;
}

export interface BotDetail extends Bot {
  readonly config: BotConfig | null;
  readonly state: BotRuntimeState | null;
  /**
   * Null for every bot that is not halted-and-unarchived, and null when the
   * fetch failed. Both mean the same thing to this screen: no current market
   * price is available, so do not render one.
   */
  readonly marketPrice: MarketPrice | null;
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
  /**
   * The permanent proposal record this creation came from (spec 21.5 requirement
   * 5, migration 0009). OPTIONAL, and OMITTED rather than null when absent.
   *
   * ── ⚠ WHAT IT IS AND WHAT IT IS NOT ──
   *
   * It is a RECORD, written after the fact: `POST /api/bots` reads nothing out of
   * the proposal row to build the bot, and refuses to before anything exists if
   * the row cannot take an outcome. Every parameter above still arrives in this
   * body, typed or confirmed by a human, and every decoder, the mandatory
   * stop-loss, the tradability gate, the spot-instrument check and the ledger's
   * binding compare-and-swap run unchanged (`createBot` in src/api/handlers.ts).
   * An `api.test.ts` test submits a body deliberately DISAGREEING with the
   * proposal and asserts the bot gets the BODY's numbers.
   *
   * ⚠ ABSENT, NOT NULL. `optionalString` distinguishes them, and decision log 45's
   * whole response-shape design turns on an ordinary creation being byte-identical
   * to what it was before this field existed. `withProposalId`
   * (`research/proposalPrefill.ts`) is the only thing in this dashboard that sets
   * it, and it sets it only inside the create-bot form's submit handler.
   */
  readonly proposalId?: string;
}

/**
 * Whether the proposal named by `proposalId` really took the outcome.
 *
 * Present on the 201 ONLY when a `proposalId` was sent. `recorded: false` means
 * decision log 45's deliberate soft failure: the bot exists and the capital is
 * reserved, and the outcome write afterwards failed. It is reported rather than
 * raised because failing the response would tell an operator that creation failed
 * when it did not.
 */
export interface ProposalLink {
  readonly proposalId: string;
  readonly recorded: boolean;
  readonly error: string | null;
}

/** The discriminated body of `POST /api/bots`. */
export type CreateBotRequest =
  | (CreateBotBase & { readonly strategy: "dca"; readonly params: DcaParamsInput })
  | (CreateBotBase & { readonly strategy: "grid"; readonly params: GridParamsInput });

/**
 * The 201 body of `POST /api/bots`: the created bot's full detail, plus
 * `proposalLink` when — and only when — the request named a proposal. Absent on
 * an ordinary creation, which is why it is optional here rather than on
 * `BotDetail`: no other endpoint that returns a `BotDetail` can carry it.
 */
export type CreateBotResponse = BotDetail & { readonly proposalLink?: ProposalLink };

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
// Halt (`POST /api/bots/:id/halt`, `haltBot` handler)
//
// Section 7.2 for ONE bot, on purpose, right now. Same `{ result, bot }` shape
// as start and resume, and like them there is no success-with-a-different-action
// to branch on -- but there ARE two success actions, and they mean different
// things: `halted` (this call stopped it) and `already_halted` (it was stopped
// before this call; `#halt` returns early and changes NOTHING, including the
// halt reason, which keeps the FIRST reason). That idempotence is what makes a
// double-click harmless, and it is why the caller must read `result.action`
// rather than reporting every 200 as "halted by you".
//
// IT IS THE ONLY BOT ACTION THAT TAKES A REQUEST BODY. `reason` is required
// free-text and is stored as `manual: <reason>` in `halt_reason` (the DO
// composes `${reason}: ${detail}`), so a halted bot always says why. The backend
// rejects a missing OR whitespace-only reason with `missing_field` (400) --
// `requireString` trims before testing -- so the form must gate on the trimmed
// value or it will send a request that can only fail.
//
// ITS ERROR SURFACE IS NARROWER THAN EVERY OTHER WRITE HERE, confirmed from
// src/durable-objects/bot-instance.ts rather than assumed by symmetry with
// resume:
//   - `not_created`   (404) -- the object holds no config.
//   - `invalid_status` (409) -- the bot is `stopped`. The ONLY status it refuses;
//     a stopped bot's capital is already released, so there is nothing to halt.
//     `created` and `running` both halt, and `halted` is the no-op above.
// It asserts NEITHER latch -- not `assertGlobalArmed`, not `assertAccountArmed`
// -- which is the exact inverse of resume and deliberate: a halt REDUCES risk
// and must stay available while the kill switch is pulled or an account's
// breaker is tripped (that is precisely the bot a sweep failed to reach).
//
// WHAT A 200 DOES NOT PROVE: that every open order is off the exchange. `#halt`
// marks the status halted FIRST (durably), then cancels; a cancellation whose
// outcome cannot be confirmed leaves that order in `openOrderIds`, raises a
// `cancel_failed` critical alert, and the halt still succeeds. Section 5.6
// forbids treating an unknown outcome as a cancellation. So the success copy
// must send the operator to the alerts rather than promising a clean book.
// ---------------------------------------------------------------------------

/** The `PipelineResult` a halt returns. `action` is `halted` or `already_halted`. */
export interface HaltResult {
  readonly status: BotStatus;
  readonly action: string;
  readonly detail?: string;
}

/** The body of a successful `POST /api/bots/:id/halt`. */
export interface HaltResponse {
  readonly result: HaltResult;
  /** The refreshed summary (now `halted`), or null if the row vanished mid-call. */
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
// Close (`POST /api/bots/:id/close`, step 26.1)
//
// The `{ result, bot }` shape every other action uses. `result` is the object's
// own `PipelineResult` and a successful close is always
// `{ status: "stopped", action: "closed" }`.
//
// ⚠ THIS IS THE ONE ACTION THAT RETURNS CAPITAL, and it is not reversible:
// nothing in this system moves a bot back out of `stopped`. It refuses a bot
// that still holds a position (`position_held`, 409) -- closing cancels orders
// but never sells, so releasing capital from a bot carrying inventory would hand
// back capital that is not cash. A SECOND close now succeeds (200) with
// `action: "already_stopped"` rather than raising `bot_already_stopped` (409):
// no capital moves twice, but the retry completes any cleanup the first close
// skipped. Read `action` to tell the two apart.
// ---------------------------------------------------------------------------

export interface CloseResult {
  readonly status: BotStatus;
  readonly action: string;
  readonly detail?: string;
}

export interface CloseResponse {
  readonly result: CloseResult;
  /** The refreshed summary (now `stopped`), or null if the row vanished. */
  readonly bot: Bot | null;
}

// ---------------------------------------------------------------------------
// Archive / unarchive (`POST /api/bots/:id/archive` and `/unarchive`, step 26,
// and step 26.1 which changed what archiving MEANS)
//
// The `{ result, bot }` shape every other action uses. Both are idempotent and
// report which of the two things happened rather than failing on a repeat, so a
// double-click is harmless: `already_archived` and `not_archived` are SUCCESSES,
// not errors, and both come back 200 with the current bot.
//
// ⚠ ARCHIVING NOW CLOSES THE BOT AND RETURNS ITS CAPITAL. Step 26 promised the
// opposite in so many words ("archiving is not closing"); step 26.1 reversed it
// deliberately, because capital reserved for a finished bot is capital no new
// bot can use. What is still true, and still structural, is that NOTHING IS
// DELETED -- history, config and strategy state all survive, permanently and
// read-only. What changed is that the status moves to `stopped` and the
// allocation comes back.
//
// `capitalReleased` says whether THIS call did the release. It is false for a
// repeat, for a bot that was already `stopped`, and for an orphan (a row whose
// object holds no state, which cannot be closed at all and keeps its
// reservation) -- three different reasons a caller must not have to infer.
//
// Archiving refuses a `running` or `created` bot with `invalid_status` (409),
// and one still holding a position with `position_held` (409).
// Unarchiving refuses nothing -- it is the reversing half, and a gate on it
// could only ever strand a bot in the hidden state. It does NOT re-allocate
// capital: an unarchived bot comes back `stopped` and stays that way.
// ---------------------------------------------------------------------------

export type ArchiveAction = "archived" | "already_archived";
export type UnarchiveAction = "unarchived" | "not_archived";

export interface ArchiveResponse {
  readonly result: {
    readonly action: ArchiveAction;
    /** Whether this call returned the allocation to the account. */
    readonly capitalReleased: boolean;
  };
  /** The refreshed summary, or null if the row vanished mid-call. */
  readonly bot: Bot | null;
}

export interface UnarchiveResponse {
  readonly result: { readonly action: UnarchiveAction };
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
