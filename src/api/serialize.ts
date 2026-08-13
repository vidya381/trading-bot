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
import type {
  AccountExposure,
  AssessResult,
  Candidate,
  CandidateGatherBundle,
  CandidateSetGatherBundle,
  CandleWindow,
  CitedClaim,
  ConcentrationResult,
  DeriveContext,
  DeriveResult,
  EvidenceItem,
  GatheredInput,
  NewsInput,
  ParsedAssessment,
  ProposalRecord,
  WatchlistEntry,
} from "../research";
import type { Candle } from "../shared/exchange-client";
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
 * One OHLCV candle (section 21.4 Stage 1).
 *
 * The five money fields go through `money()` for the reason at the top of this
 * file, and it bites harder here than anywhere else: `Candle` carries five
 * bigints per row and a window is hundreds of rows, so a missed conversion is
 * not a wrong number -- `JSON.stringify` throws outright and the endpoint
 * returns a 500. An explicit view rather than `jsonSafe` because the shape is
 * fixed, small, and worth reading in one place.
 *
 * `closed` is carried through rather than filtered on. The in-progress candle
 * comes back `closed: false` when the venue sent one, and a consumer that must
 * drop it (a backfill) can, while one that wants the live partial (a volatility
 * read at this instant) still has it. Dropping it here would take that choice
 * away and silently shorten every window by one.
 */
export function candleView(candle: Candle) {
  return {
    openTime: candle.openTime,
    closeTime: candle.closeTime,
    open: money(candle.open),
    high: money(candle.high),
    low: money(candle.low),
    close: money(candle.close),
    volume: money(candle.volume),
    closed: candle.closed,
  };
}

/**
 * A candle window and its honest account of how much history it actually is
 * (section 21.4, and 21.7's open question 1 about Gemini's fixed window).
 *
 * EVERY DEPTH FIELD IS PUBLISHED, and that is the point of the endpoint rather
 * than a convenience. Gemini's `/v2/candles` takes no time-range parameter, so
 * a request for more history than its window holds comes back short; if the
 * only visible evidence of that were the length of the `candles` array, a
 * caller would have to know the interval, do the arithmetic, and think to do it
 * at all. `truncated` and `missingHistoryMs` say it outright, and
 * `earliestOpenTime`/`earliestCloseTime` say how far back the window really
 * reaches. 21.7: "the Assess stage must be told how much history it actually
 * received and must not reason as though it had more."
 *
 * `count` is published even though it equals `candles.length`, because the
 * cheapest possible check an operator makes against this endpoint -- and the
 * one a `curl | jq '.data | {count, truncated, missingHistoryMs}'` reaches for
 * -- should not require pulling the whole array down to perform.
 */
export function candleWindowView(window: CandleWindow) {
  return {
    accountLabel: window.accountLabel,
    exchange: window.exchange,
    pair: window.pair,
    interval: window.interval,
    // 21.5 requirement 4's fetch time: when the venue answered, not now.
    fetchedAt: window.fetchedAt,
    requestedSince: window.requestedSince,
    earliestOpenTime: window.earliestOpenTime,
    earliestCloseTime: window.earliestCloseTime,
    latestCloseTime: window.latestCloseTime,
    truncated: window.truncated,
    missingHistoryMs: window.missingHistoryMs,
    count: window.candles.length,
    candles: window.candles.map(candleView),
  };
}

// ---------------------------------------------------------------------------
// Stage 1 gather bundles (section 21.4, `/src/research/gather.ts`)
// ---------------------------------------------------------------------------

/**
 * A module's OWN error, as the two fields a caller can act on.
 *
 * WHY THIS FUNCTION HAS TO EXIST AT ALL, stated because the bug it prevents is
 * silent and total: `Error`'s `name`, `message` and `stack` are NON-ENUMERABLE,
 * so `JSON.stringify(new CandleWindowError("candles_unavailable", "..."))` is
 * `{}` -- not a throw, not a warning, an empty object. A bundle that put the
 * error object straight on the wire would return 200 with `"error": {}` in every
 * failed slot, which is precisely the "honestly reported" half of this endpoint
 * failing while the shape still looks right. `code` is a own-property and would
 * survive; `message` would not, so the failure would arrive coded and mute.
 *
 * `code` is carried verbatim -- `candles_unavailable`, `interval_not_verified`,
 * `pair_not_tradable`, `bot_list_unreadable`, `missing_field` -- because
 * `gather.ts` invents no error vocabulary and neither does this. The same code a
 * direct caller reads off `error.code`, and the same one `STATUS_BY_CODE` maps
 * when the SAME error reaches HTTP as a top-level refusal from the candles
 * endpoint. Two surfaces, one vocabulary.
 */
export function moduleErrorView(error: { readonly code: string; readonly message: string }) {
  return { code: error.code, message: error.message };
}

/**
 * A value that was THROWN rather than refused, described without trusting it.
 *
 * The `threw_unexpectedly` arm's `error` is typed `unknown` on purpose
 * (`gather.ts`: "a thrown non-Error is legal JavaScript"), so this must handle a
 * string, a null, a symbol, or an object whose `toString` throws. It has no
 * `code`, deliberately: inventing one would dress a port failure up as one of
 * the module's enumerated refusals, which is the exact distinction the third
 * arm exists to preserve.
 *
 * THE DESCRIPTION IS ITSELF FALLIBLE AND IS GUARDED. `String(Object.create(null))`
 * throws `TypeError: Cannot convert object to primitive value`. An endpoint
 * whose entire purpose is reporting failures must not fail while describing one,
 * so the conversion is wrapped and a value that will not describe itself is
 * reported as exactly that rather than taking the response down with it.
 */
export function thrownErrorView(error: unknown) {
  if (error instanceof Error) {
    return { name: error.name, message: error.message };
  }
  let message: string;
  try {
    message = String(error);
  } catch {
    message =
      "a thrown value that cannot be converted to a string (its toString threw, or it has " +
      "a null prototype). Reported rather than allowed to fail this response.";
  }
  return { name: typeof error, message };
}

/**
 * One `GatheredInput` arm, with the value rendered by the caller's own view.
 *
 * THE DISCRIMINANT IS CARRIED THROUGH UNCHANGED, and that is the whole contract
 * of this endpoint. A caller reads `outcome` and gets `ok` / `failed` /
 * `threw_unexpectedly` -- three distinguishable states, never collapsed into a
 * boolean, because "the venue refused for a reason it enumerated" and "something
 * beneath it broke" are different facts a human weighing a proposal needs apart
 * (`gather.ts`'s design note 2).
 *
 * `failedAt` rides on the failure arms and NOT on `ok`, mirroring the type
 * exactly: a slot that succeeded has a real fetch time inside its own value
 * (`fetchedAt`, `readAt`) and does not need an observation time, while a slot
 * that failed has no fetch time to report because no fetch succeeded to supply
 * one (21.5 requirement 4).
 */
export function gatheredInputView<T, E extends { readonly code: string; readonly message: string }, V>(
  input: GatheredInput<T, E>,
  valueView: (value: T) => V,
) {
  if (input.outcome === "ok") {
    return { outcome: "ok" as const, value: valueView(input.value) };
  }
  if (input.outcome === "failed") {
    return {
      outcome: "failed" as const,
      error: moduleErrorView(input.error),
      failedAt: input.failedAt,
    };
  }
  return {
    outcome: "threw_unexpectedly" as const,
    error: thrownErrorView(input.error),
    failedAt: input.failedAt,
  };
}

/**
 * The paused news slot (decision log 30), carried verbatim.
 *
 * Every field is already a string and there is nothing to convert, so this is an
 * explicit re-statement rather than a passthrough -- which is the point. It has
 * NO `error`, NO `failedAt` and NO `fetchedAt`, and listing the three fields it
 * DOES have makes that absence a property of this function rather than of the
 * object that happened to be passed in. A later edit that added a `failedAt`
 * here would have to be written on purpose.
 */
export function newsInputView(news: NewsInput) {
  return {
    outcome: news.outcome,
    reason: news.reason,
    decisionLogEntry: news.decisionLogEntry,
  };
}

/**
 * One candidate, with its provenance intact (21.5 requirement 2).
 *
 * `jsonSafe` rather than a field-by-field view, and the reason is `sources`:
 * a `TrendingCandidateSource` carries `raw`, the vendor's own item BY IDENTITY,
 * whose shape is by definition unknown to this layer. A hand-written view would
 * have to either drop it -- destroying exactly the "actual raw data it used"
 * requirement 2 asks for -- or copy it blind, which is what `jsonSafe` already
 * does correctly and with the bigint pass applied all the way down.
 *
 * The whole tuple is carried, never summarised: `sources` is the answer to
 * "WHICH watchlist entry, or WHICH trending pull, and when", and a coin on both
 * lists is one candidate with two sources.
 */
export function candidateView(candidate: Candidate) {
  return jsonSafe(candidate);
}

/**
 * One concentration result, flagged or clean.
 *
 * `jsonSafe` for a REASON THAT IS EASY TO MISS AND HAS EXACTLY ONE INSTANCE:
 * `ConcentrationResult` renders its own money to decimal strings already
 * (`committed`, `samePairCommitted`, every `*SharePct`) -- but `facts.policy` is
 * the `ConcentrationPolicy` echoed verbatim so the numbers are reconstructable,
 * and its `assetCapitalShareFlagAtPct` is a raw `Money` bigint (`40n * ONE`).
 * That single field is the one thing standing between this endpoint and a
 * `TypeError: Do not know how to serialize a BigInt` on EVERY successful
 * response. A test and a mutant both pin it, because "the policy echo" is the
 * last place someone auditing money fields would look.
 */
export function concentrationResultView(result: ConcentrationResult) {
  return jsonSafe(result);
}

/**
 * The ONE `bot_instances` read a set-wide gather did, reported beside its results.
 *
 * Published for 21.5 requirement 2's reason -- "the actual raw data it used" --
 * and `jsonSafe` because `AccountExposure.committed[]`/`stopped[]` are
 * `ExposureBot`s carrying `allocatedCapital` as a raw `Money` bigint. That is
 * the second of the two bigint sites in a bundle, and unlike the policy echo it
 * is one per bot rather than one per result.
 */
export function accountExposureView(exposure: AccountExposure) {
  return jsonSafe(exposure);
}

/**
 * Everything Stage 1 gathered about ONE candidate.
 *
 * The four slots are INDEPENDENT FIELDS with no shared status and no "first
 * error", which is what makes "candles failed", "concentration failed" and
 * "everything succeeded" three distinguishable states over the wire rather than
 * one degraded one. Nothing here computes an overall success flag, deliberately:
 * a top-level boolean is precisely the summary that would let a reader stop
 * looking at which inputs actually worked, and deciding whether a bundle is fit
 * to use is Stage 4's judgement, which does not exist yet.
 *
 * `assembledAt` is published beside them and is NOT a fetch time -- it is when
 * assembly ran. The real fetch times are inside the slots
 * (`candles.value.fetchedAt`, `concentration.value.readAt`, each source's own),
 * and a caller timing staleness from `assembledAt` would be reading a render
 * time as a data time (21.5 requirement 4).
 */
export function candidateGatherBundleView(bundle: CandidateGatherBundle) {
  return {
    candidate: candidateView(bundle.candidate),
    candles: gatheredInputView(bundle.candles, candleWindowView),
    news: newsInputView(bundle.news),
    concentration: gatheredInputView(bundle.concentration, concentrationResultView),
    assembledAt: bundle.assembledAt,
  };
}

/**
 * A whole `CandidateSet`'s bundles, plus the one read behind them.
 *
 * `set` is carried whole so the SET-level provenance survives: 21.5 requirement
 * 2's "which trending pull, and when" lives on `set.trending.fetchedAt` and
 * `set.watchlist.readAt`, which are per-set facts and are deliberately not
 * copied onto each candidate.
 *
 * `bundles` has exactly `set.candidates.length` entries in the set's own order,
 * with NO filtering -- a candidate whose every input failed is still in its own
 * position, which is what makes position `i` meaningful against
 * `set.candidates[i]`. `count` is published for the same reason
 * `candleWindowView`'s is: the cheapest check an operator makes against this
 * endpoint should not require pulling every bundle down to perform.
 */
export function candidateSetGatherBundleView(bundle: CandidateSetGatherBundle) {
  return {
    set: jsonSafe(bundle.set),
    exposure: gatheredInputView(bundle.exposure, accountExposureView),
    count: bundle.bundles.length,
    bundles: bundle.bundles.map(candidateGatherBundleView),
    assembledAt: bundle.assembledAt,
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

// ---------------------------------------------------------------------------
// Section 21.4 Stage 2 (Assess)
// ---------------------------------------------------------------------------

/**
 * One citable datum, exactly as the model was shown it.
 *
 * All four fields, and each is load-bearing for 21.5 requirement 2: `id` is
 * what a claim cites, `label` is what the model read beside it, `value` is the
 * rendered datum BYTE-IDENTICAL to what went into the prompt, and `source` is
 * the path into the gather bundle it came from. Dropping `source` would leave a
 * reader able to see the number but not to check where it came from, which is
 * the difference between evidence and assertion.
 */
export function evidenceItemView(item: EvidenceItem) {
  return { id: item.id, label: item.label, value: item.value, source: item.source };
}

/**
 * One claim, with its citations RESOLVED rather than referenced.
 *
 * The citations are whole `EvidenceItem`s, not id strings. A list of bare ids
 * would make a human look each one up to check the reasoning, which is the same
 * as not shipping them (21.5 requirement 2 wants the reasoning checkable
 * against the real source, not merely traceable to it).
 */
export function citedClaimView(claim: CitedClaim) {
  return {
    statement: claim.statement,
    citations: claim.citations.map(evidenceItemView),
  };
}

/**
 * A whole assessment, over the wire.
 *
 * WHAT IS DELIBERATELY HERE:
 *
 *   * `evidence` is EVERYTHING the model was offered, not only what it cited.
 *     What a model IGNORED is only visible from the difference between this and
 *     the citations, and a model that ignored the concentration flag is a fact
 *     worth being able to see.
 *   * `envelope` and `duplicateKeyCheck` are published because they vary per
 *     call and say WHICH GUARANTEES ACTUALLY HELD for this particular answer
 *     (decision log 37): on the object path the duplicate-key protection is
 *     structurally unavailable, and a response that hid that would be claiming
 *     a check it never ran.
 *   * `settings` is echoed whole, `response_format` schema included, so the
 *     determinism stance a given answer was produced under is reconstructable
 *     rather than assumed from today's constants.
 *
 * WHAT IS DELIBERATELY ABSENT: `promptText`. It is ~16KB and, for the one job a
 * reader needs it for -- checking a claim against the datum it cites -- the
 * `evidence` array carries the same values in a form that is actually
 * comparable. `promptChars` is published so the size is still visible.
 * The bundle travels beside this in the response, so the raw source is not lost.
 */
export function assessResultView(result: AssessResult, latencyMs: number) {
  return {
    strategy: result.strategy,
    claims: result.claims.map(citedClaimView),
    evidence: result.evidence.map(evidenceItemView),
    promptVersion: result.promptVersion,
    promptChars: result.promptText.length,
    model: result.model,
    settings: jsonSafe(result.settings),
    envelope: result.envelope,
    duplicateKeyCheck: result.duplicateKeyCheck,
    latencyMs,
  };
}

// ---------------------------------------------------------------------------
// Section 21.4 Stage 3 (Derive)
// ---------------------------------------------------------------------------

/**
 * Stage 3's two extra real reads, over the wire.
 *
 * The SAME `gatheredInputView` the bundle's slots use, so a failed capital read
 * and a failed candle fetch are reported in one shape with one discriminant, and
 * a caller does not have to learn a second convention for a second gather.
 *
 * `jsonSafe` on each value for `accountExposureView`'s reason: `AccountCapital`
 * carries three raw `Money` bigints per asset row and `SymbolFilters` carries
 * eight, and a hand-written view is a list that the producing modules can
 * silently outgrow. `gatheredAt` is published beside them and is NOT a fetch
 * time -- `capital.value.readAt` and `filters.value.fetchedAt` are (21.5
 * requirement 4).
 */
export function deriveContextView(context: DeriveContext) {
  return {
    capital: gatheredInputView(context.capital, jsonSafe),
    filters: symbolFiltersInputView(context.filters),
    gatheredAt: context.gatheredAt,
  };
}

/**
 * The filters slot, which cannot go through `gatheredInputView` and must not be
 * forced to.
 *
 * `SymbolFiltersInput` is `GatheredInput<SymbolFilters, Error>` -- a PLAIN
 * `Error`, not a coded one -- because the venue's own refusal arrives as an
 * `ExchangeOutcome` and `gatherDeriveContext` turns it into a
 * `SymbolFiltersUnavailableError` carrying the outcome's `kind` rather than a
 * `code`. That is `gather.ts`'s standing rule working correctly: it invents no
 * error vocabulary, so it does not mint a `code` the producing layer never
 * spoke.
 *
 * So the `failed` arm is rendered with `thrownErrorView` (name + message), the
 * same reporter the `threw_unexpectedly` arm uses everywhere. WIDENING
 * `gatheredInputView`'s constraint to accept an uncoded error would have been
 * the tempting fix and is the wrong one: it would let a genuinely coded slot --
 * candles, concentration, capital -- silently start publishing `{}` for `error`
 * the day someone passed it something without a `code`, which is exactly the
 * "coded and mute" failure `moduleErrorView` exists to prevent.
 *
 * `failedAt` still rides on both failure arms and not on `ok`, mirroring the
 * type exactly, as it does in `gatheredInputView`.
 */
export function symbolFiltersInputView(input: DeriveContext["filters"]) {
  if (input.outcome === "ok") {
    return { outcome: "ok" as const, value: jsonSafe(input.value) };
  }
  return {
    outcome: input.outcome,
    error: thrownErrorView(input.error),
    failedAt: input.failedAt,
  };
}

/**
 * A resubmitted Stage 2 result, echoed back with its provenance stated.
 *
 * `source: "client_resubmitted"` IS THE POINT OF THIS VIEW and is not decoration.
 * `/derive` takes its assessment from an earlier, separate HTTP call that this
 * system stores nothing about, so the value looks in every other respect exactly
 * like one `/assess` produced a moment ago. A reader who cannot tell those apart
 * cannot weigh the proposal, and 21.5 requirement 5 wants a proposal traceable
 * to its exact cause.
 *
 * `citationsReverified: true` says what this system DID check: every id below
 * resolved against the evidence THIS run gathered, not against whatever existed
 * when the assessment was made (`parseResubmittedAssessment`). The claims are
 * therefore rendered with the CURRENT `EvidenceItem`s -- current label, current
 * value -- and not with the ones the caller sent, which is why `citedClaimView`
 * is reused unchanged.
 *
 * `envelope` and `duplicateKeyCheck` are flagged UNVERIFIED because they are:
 * they describe the original model call, which this system did not witness. They
 * are carried rather than dropped so the audit trail is not silently shortened,
 * and labelled rather than published bare so nothing downstream reads a
 * client-asserted fact as an observed one.
 */
export function resubmittedAssessmentView(assessment: ParsedAssessment) {
  return {
    source: "client_resubmitted" as const,
    citationsReverified: true as const,
    strategy: assessment.strategy,
    claims: assessment.claims.map(citedClaimView),
    /** The ORIGINAL call's audit facts, taken on the caller's word. */
    unverifiedOriginalCall: {
      envelope: assessment.envelope,
      duplicateKeyCheck: assessment.duplicateKeyCheck,
    },
  };
}

/**
 * The validated parameter set, rendered so every number sits beside the ids it
 * was drawn from.
 *
 * A discriminated union on `strategy`, mirroring `ValidatedProposal.params`
 * rather than flattening it: a DCA proposal must not be able to carry an
 * `upperBound` key at all, which is the same reason `derive-prompt.ts` builds
 * two prompts instead of one with optional fields.
 *
 * `citations` is keyed by field name and holds whole `EvidenceItem`s, NOT bare
 * ids. A human approving `orderSize: "50.00"` reads the datum it rests on in the
 * same object, which is 21.5 requirement 2's actual ask -- a list of ids would
 * leave them to look each one up, which is the same as not shipping them.
 */
export function validatedProposalView(result: DeriveResult) {
  const params =
    result.proposal.params.strategy === "grid"
      ? {
          strategy: "grid" as const,
          upperBound: money(result.proposal.params.value.upperBound),
          lowerBound: money(result.proposal.params.value.lowerBound),
          gridLines: result.proposal.params.value.gridLines,
          spacing: result.proposal.params.value.spacing,
          orderSize: money(result.proposal.params.value.orderSize),
          stopLossPct: money(result.proposal.params.value.stopLossPct),
          breakoutTakeProfit: result.proposal.params.value.breakoutTakeProfit,
          breakoutThresholdPct: moneyOrNull(result.proposal.params.value.breakoutThresholdPct),
          takeProfitAmount: moneyOrNull(result.proposal.params.value.takeProfitAmount),
        }
      : {
          strategy: "dca" as const,
          baseOrderSize: money(result.proposal.params.value.baseOrderSize),
          additionalOrderSize: money(result.proposal.params.value.additionalOrderSize),
          stepMultiplier: money(result.proposal.params.value.stepMultiplier),
          dropPct: money(result.proposal.params.value.dropPct),
          maxAdditionalBuys: result.proposal.params.value.maxAdditionalBuys,
          takeProfitPct: money(result.proposal.params.value.takeProfitPct),
          stopLossPct: money(result.proposal.params.value.stopLossPct),
          autoRestart: result.proposal.params.value.autoRestart,
          sellOnStopLoss: result.proposal.params.value.sellOnStopLoss,
        };

  return {
    params,
    allocatedCapital: money(result.proposal.allocatedCapital),
    capitalAsset: result.proposal.capitalAsset,
    /**
     * The account's headroom AS READ, and a PREFILL rather than a reservation:
     * nothing was allocated, and the binding check is
     * `createBotInstanceWithCapital`'s against the ledger at creation time
     * (`capital.ts`). It may be out of date by the time a human acts on it.
     */
    availableAtProposal: money(result.proposal.availableAtProposal),
    referencePrice: money(result.proposal.referencePrice),
    /** WHICH venue floor actually existed to check. `none_published` is honest, not a pass. */
    minimumOrderCheck: result.minimumOrderCheck,
    citations: Object.fromEntries(
      Object.entries(result.citations.parameters).map(([field, cited]) => [
        field,
        cited.citations.map(evidenceItemView),
      ]),
    ),
    allocatedCapitalCitations: result.citations.allocatedCapital.citations.map(evidenceItemView),
    capitalAssetCitations: result.citations.capitalAsset.citations.map(evidenceItemView),
  };
}

/**
 * A whole derivation, over the wire. The shape step 41's probe proved live.
 *
 * WHAT IS DELIBERATELY HERE, on `assessResultView`'s own reasoning:
 *
 *   * `evidence` is EVERYTHING the model was offered, not only what it cited.
 *     What Stage 3 IGNORED is only visible from the difference between this and
 *     the per-field citations, and step 41 found the model citing an ABSENCE
 *     marker (`news.status`) as grounds for a null parameter -- a pattern nobody
 *     designed for and which is only noticeable because the full set ships.
 *   * `envelope` and `duplicateKeyCheck` say WHICH GUARANTEES ACTUALLY HELD for
 *     this particular answer. Seven live observations now show this model
 *     answering on the object path, where the duplicate-key scan is structurally
 *     impossible; a response that hid that would claim a check it never ran.
 *   * `settings` is echoed whole, per-strategy `response_format` schema included,
 *     so the determinism stance a given answer was produced under is
 *     reconstructable rather than assumed from today's constants.
 *
 * WHAT IS DELIBERATELY ABSENT: `promptText`, which is larger here than Stage 2's
 * ~16KB. For the one job a reader needs it for -- checking a number against the
 * datum it cites -- `evidence` carries the same values in a comparable form.
 * `promptChars` is published so the size stays visible.
 *
 * ⚠ A WELL-FORMED PROPOSAL IS NOT A GOOD ONE, and nothing in this object can
 * tell a reader which it has. Every check behind these fields answers "is this
 * internally consistent, grounded in the fetched data, and acceptable to the
 * real create-bot validators?" and not one answers "was the data worth reasoning
 * about?" (decision logs 40 and 41). The human is the only part of the loop that
 * can tell those apart.
 */
export function deriveResultView(result: DeriveResult, latencyMs: number) {
  return {
    strategy: result.strategy,
    proposal: validatedProposalView(result),
    notes: result.notes.map(citedClaimView),
    evidence: result.evidence.map(evidenceItemView),
    promptVersion: result.promptVersion,
    promptChars: result.promptText.length,
    model: result.model,
    settings: jsonSafe(result.settings),
    envelope: result.envelope,
    duplicateKeyCheck: result.duplicateKeyCheck,
    latencyMs,
  };
}

// ---------------------------------------------------------------------------
// Section 21.5 requirement 5: the permanent proposal record
// ---------------------------------------------------------------------------

/**
 * WHAT GETS STORED, AND WHY IT IS BUILT HERE RATHER THAN IN /src/research.
 *
 * `proposal-log.ts` writes the row but does NOT render these payloads: /src/api
 * imports /src/research, never the reverse, so the views live here and travel as
 * parameters. That is the stronger arrangement rather than a compromise, and the
 * reason is one property it makes true by construction --
 *
 *   **THE HANDLER STORES THE VERY OBJECT IT PUTS IN THE RESPONSE.**
 *
 * `candidateGatherBundleView`, `deriveContextView`, `resubmittedAssessmentView`,
 * `assessResultView` and `deriveResultView` below are the SAME functions, called
 * once, with the result used for both the wire and the record. So "what was stored
 * differs from what the human was shown" is not a bug that can be introduced
 * here; it would take deleting a parameter. A second rendering for storage -- even
 * a faithful one -- is a copy that drifts, and 21.5 requirement 2 is precisely
 * about being able to check reasoning against the real source.
 *
 * ⚠ THE TWO FIELDS THE RECORD HAS THAT THE WIRE DELIBERATELY LACKS:
 *
 *   * `promptText`, in full. `assessResultView` and `deriveResultView` omit it
 *     (~16KB and ~23KB, decision log 41) because for a READER's job -- checking a
 *     claim against the datum it cites -- `evidence` carries the same values in a
 *     comparable form. That trade is right for a response and wrong for a record:
 *     reconstructing what produced a given answer is the row's entire job, and
 *     21.7's open question 3 (which model, how deterministic) cannot be settled
 *     without the bytes.
 *   * `response`, the transport's answer BY IDENTITY -- both `text` and `raw`.
 *     Two fields rather than one for `AssessModelResponse`'s own stated reason:
 *     the narrowing from Workers AI's output union to a string is a decision an
 *     implementation makes, and the record should hold the thing it narrowed FROM
 *     as well as the thing it narrowed TO. `jsonSafe` for the bigint reason
 *     everything else here uses it.
 */
export function assessProposalInputsView(result: AssessResult, selectedAt: number) {
  return {
    /** NOT a fetch time -- see `candidateGatherBundleView`. The fetch times are in the slots. */
    selectedAt,
    bundle: candidateGatherBundleView(result.bundle),
  };
}

export function assessProposalReasoningView(result: AssessResult, latencyMs: number) {
  return {
    ...assessResultView(result, latencyMs),
    promptText: result.promptText,
    response: { text: jsonSafe(result.response.text), raw: jsonSafe(result.response.raw) },
  };
}

/**
 * Stage 3's inputs: BOTH upstream inputs, and Stage 3's own two extra reads.
 *
 * The resubmitted assessment is an INPUT here, not reasoning, and that placement
 * is the point: it is what Stage 3 was given (via a client, re-verified against
 * this run's evidence -- decision log 42), exactly as the bundle is. It is stored
 * rendered against the CURRENT evidence it was re-verified against, because that
 * is what `resubmittedAssessmentView` publishes and what the human was shown.
 */
export function deriveProposalInputsView(result: DeriveResult, selectedAt: number) {
  return {
    selectedAt,
    bundle: candidateGatherBundleView(result.context.bundle),
    context: deriveContextView(result.context),
    assessment: resubmittedAssessmentView(result.assessment),
  };
}

export function deriveProposalReasoningView(result: DeriveResult, latencyMs: number) {
  return {
    ...deriveResultView(result, latencyMs),
    promptText: result.promptText,
    response: { text: jsonSafe(result.response.text), raw: jsonSafe(result.response.raw) },
  };
}

/**
 * A proposal record over the wire, WITHOUT its two large payloads.
 *
 * `inputs` and `reasoning` are deliberately absent and their sizes published
 * instead -- `promptChars`' precedent one section up. A `derive` record's inputs
 * carry every candle of the window; returning them from an endpoint whose job is
 * to report an outcome would make a small acknowledgement a large download. The
 * payloads are in D1 and are read from there.
 *
 * `outcome: null` is published as null rather than omitted, and it is 21.5's
 * "ignored" read after the fact: nothing ever writes that word (see migration
 * 0009). `pendingMs` is only present once a decision exists, because "how long it
 * sat" is not a finished quantity while it is still sitting.
 */
export function proposalRecordView(record: ProposalRecord) {
  return {
    id: record.id,
    stage: record.stage,
    accountLabel: record.accountLabel,
    pair: record.pair,
    entryPoint: record.entryPoint,
    strategy: record.strategy,
    actor: record.actor,
    model: record.model,
    promptVersion: record.promptVersion,
    /** 21.5 requirement 4: when the price window was FETCHED, not when this was rendered. */
    dataFetchedAt: record.dataFetchedAt,
    createdAt: record.createdAt,
    outcome: record.outcome,
    outcomeBotInstanceId: record.outcomeBotInstanceId,
    outcomeActor: record.outcomeActor,
    outcomeAt: record.outcomeAt,
    outcomeNote: record.outcomeNote,
    pendingMs: record.outcomeAt === null ? null : record.outcomeAt - record.createdAt,
  };
}
