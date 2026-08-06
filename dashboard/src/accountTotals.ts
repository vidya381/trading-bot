/**
 * The account-level rollup of the bot list (step 25): what the whole fleet has
 * allocated, is holding, has made, and has paid -- derived from the one
 * `GET /api/bots` poll the dashboard page already runs.
 *
 * Read-only presentation, on the same terms as `derive.ts`: nothing here is
 * written back, sent, or acted on, and every value is exact `bigint` Money at
 * SCALE 8 from `src/shared/money.ts`. NO FLOAT IS EVER CONSTRUCTED -- there is
 * no `Number()`, no `parseFloat`, no `+` on a string, and the only division is
 * `divideRounded` inside the reused `unrealizedPnl`. `unpricedFills`,
 * `openPositions` and `cyclesCompleted` are the only JS `number`s in the file
 * and every one of them is a COUNT, never money.
 *
 * GROUPED BY CAPITAL ASSET, ALWAYS
 * --------------------------------
 * Every money figure a bot reports -- its allocation, its cost basis, its
 * realized profit, its converted fees -- is denominated in that bot's OWN
 * `capitalAsset`. Today every live bot is on `gemini-main` and that asset is
 * the same for all of them, so this will almost always produce exactly one
 * group. It still groups, because the alternative is a single blended number
 * that is in no currency at all the first time a USDT-denominated Binance bot
 * appears beside a USD-denominated Gemini one -- and that number would look
 * completely normal. One group renders as one strip; more than one renders as a
 * breakdown. Nothing is ever summed across the boundary.
 *
 * WHAT MAKES A FIGURE REFUSE TO EXIST
 * -----------------------------------
 * Three separate things can leave this rollup unable to state a total, and they
 * are tracked separately because they are separately fixable:
 *
 *   1. An ORPHANED bot -- a `bot_instances` row whose Durable Object holds no
 *      state. Its position, realized profit and cycle count are not zero, they
 *      are unknown.
 *   2. A held position with NO PRICE (`lastPrice === null`). Section 5.6: an
 *      unusable price is reported, never guessed at. What that position is
 *      worth right now is unknown, so the fleet's unrealized profit is too.
 *   3. An UNPRICED FEE -- a fill whose fee was charged in an asset with no
 *      available rate, so `fee_reporting_amount` is NULL (see `BotFees`).
 *      Fees are a cost, so an incomplete fee total OVERSTATES profit.
 *
 * `net` is withheld entirely when any of the three is present, rather than
 * shown with a caveat. That is not a new rule invented here: `realizedPnl` in
 * `src/shared/fees.ts` has always returned a `complete: false` arm carrying
 * `gross` and `fees` but deliberately NO `net`, for the reason written there --
 * "an overstated profit is exactly the error a trading system must not make
 * quietly". The gross figures stay visible throughout, which is also the
 * existing per-bot convention ("Realized (gross)").
 */

import type { Bot } from "./api/types";
import { parse, unrealizedPnl } from "./derive";
import { ZERO, toDecimalString, type Money } from "../../src/shared/money";

/**
 * Why a total is a floor rather than a total. Each carries its own count so the
 * UI can say how much is missing, not merely that something is.
 */
export interface Incompleteness {
  /** Bots whose object holds no state, so their position and profit are unknown. */
  readonly orphanedBots: number;
  /** Positions held with no usable price, so their current worth is unknown. */
  readonly unpricedPositions: number;
  /** Fills whose fee could not be priced, so the fee total understates cost. */
  readonly unpricedFills: number;
  /**
   * Money strings the backend sent in a form `fromDecimalString` refused.
   *
   * Should be structurally impossible -- every money field is `toDecimalString`
   * output by contract. It is counted rather than ignored because the failure
   * mode of ignoring it is a total that silently drops a term and still looks
   * like a total. Kept separate from the three real gaps above so a genuine
   * contract break is never mistaken for an orphan or a missing price.
   */
  readonly malformedValues: number;
}

function isComplete(gaps: Incompleteness): boolean {
  return (
    gaps.orphanedBots === 0 &&
    gaps.unpricedPositions === 0 &&
    gaps.unpricedFills === 0 &&
    gaps.malformedValues === 0
  );
}

/**
 * One capital asset's worth of fleet. Every money field is an exact decimal
 * string in `capitalAsset`, ready for `formatMoney`.
 */
export interface AssetTotals {
  readonly capitalAsset: string;
  readonly botCount: number;

  /**
   * Capital currently COMMITTED, which deliberately EXCLUDES `stopped` bots.
   *
   * This is not a filter for tidiness. `releaseBotCapital` (capital/ledger.ts)
   * subtracts a closed bot's allocation from the ledger's `total_allocated` but
   * leaves `bot_instances.allocated_capital` on the row as the historical record
   * of what it once held. So summing the column across every bot would report
   * capital that has already been returned to the account as still committed --
   * an overstatement that grows monotonically with every bot ever closed.
   */
  readonly allocated: string;
  /**
   * Cost basis of everything still held, gross of fees, across EVERY bot
   * including stopped ones -- `close` cancels open orders and returns the
   * capital but does NOT flatten the position, so a stopped bot can genuinely
   * still be holding inventory. That is worth seeing, not hiding.
   */
  readonly inPosition: string;
  /**
   * `allocated - inPosition`. CAN BE NEGATIVE, and is not clamped.
   *
   * A negative value is real information, not an error to be tidied away: it
   * means the fleet is holding more cost basis than it currently has committed,
   * which is exactly what a stopped-but-still-holding bot produces (its basis
   * counts above, its allocation does not). Clamping to zero would erase the
   * one figure that reveals it.
   */
  readonly idle: string;

  /** Realized profit across closed cycles, BEFORE fees. A floor if orphans exist. */
  readonly realizedGross: string;
  /** Fees that could be priced. A floor whenever `gaps.unpricedFills` is non-zero. */
  readonly feesReported: string;
  /**
   * Mark-to-market profit on everything still held, or null when any held
   * position has no usable price. Null means UNKNOWN, never zero.
   */
  readonly unrealized: string | null;
  /**
   * `realizedGross - feesReported + unrealized`, or null when any of the three
   * gaps above is present. See the module note: this withholds rather than
   * caveats, matching `realizedPnl`.
   */
  readonly net: string | null;

  /** Bots holding a non-zero quantity right now. */
  readonly openPositions: number;
  /**
   * Completed cycles. **DCA only** -- a grid bot has no cycle to complete and
   * reports 0 forever (see `Bot.cycleCount`). Summed as reported rather than
   * filtered to DCA bots, so the figure stays correct if grid ever gains them.
   */
  readonly cyclesCompleted: number;

  readonly gaps: Incompleteness;
}

/** True when a decimal string carries a significant digit and no leading "-". */
function isPositive(value: string): boolean {
  return !value.startsWith("-") && /[1-9]/.test(value);
}

interface Accumulator {
  capitalAsset: string;
  botCount: number;
  allocated: Money;
  inPosition: Money;
  realizedGross: Money;
  feesReported: Money;
  /** Null once any held position has proved unvaluable; never recovers. */
  unrealized: Money | null;
  openPositions: number;
  cyclesCompleted: number;
  orphanedBots: number;
  unpricedPositions: number;
  unpricedFills: number;
  malformedValues: number;
}

function emptyAccumulator(capitalAsset: string): Accumulator {
  return {
    capitalAsset,
    botCount: 0,
    allocated: ZERO,
    inPosition: ZERO,
    realizedGross: ZERO,
    feesReported: ZERO,
    unrealized: ZERO,
    openPositions: 0,
    cyclesCompleted: 0,
    orphanedBots: 0,
    unpricedPositions: 0,
    unpricedFills: 0,
    malformedValues: 0,
  };
}

/**
 * Fold one bot into its asset's accumulator.
 *
 * Every `parse` failure lands in `malformedValues` and NOWHERE else. An earlier
 * draft routed an unreadable allocation into `orphanedBots`, which both
 * mislabelled a contract break as a missing Durable Object and double-counted
 * any bot that was genuinely orphaned as well. A count that can be reached by
 * two unrelated causes cannot be acted on by whoever reads it.
 */
function fold(into: Accumulator, bot: Bot): void {
  into.botCount += 1;

  // Committed capital only. See `AssetTotals.allocated`.
  if (bot.status !== "stopped") {
    const allocated = parse(bot.allocatedCapital);
    if (allocated === null) into.malformedValues += 1;
    else into.allocated += allocated;
  }

  // Fees are D1-sourced and exist even for an orphan, whose object state is
  // gone but whose trade history is not -- so this runs before the orphan check
  // rather than inside the healthy-bot path.
  const fees = parse(bot.fees.reported);
  if (fees === null) into.malformedValues += 1;
  else into.feesReported += fees;
  into.unpricedFills += bot.fees.unpricedCount;

  const position = bot.position;
  if (position === null) {
    // An orphan. Its position, realized profit and cycle count are unknown, so
    // nothing is added and the gap is recorded. `unrealized` is NOT poisoned
    // here -- `net` is already suppressed by `orphanedBots`, and zeroing the
    // mark-to-market figure too would hide the one number the healthy bots can
    // still legitimately produce.
    into.orphanedBots += 1;
    return;
  }

  const cost = parse(position.cost);
  const realized = parse(position.realizedGross);
  if (cost === null || realized === null) {
    into.malformedValues += 1;
    return;
  }
  into.inPosition += cost;
  into.realizedGross += realized;
  into.cyclesCompleted += bot.cycleCount ?? 0;

  if (!isPositive(position.heldQuantity)) return;

  into.openPositions += 1;
  // Reuses the detail view's audited formula rather than restating it: the
  // `mul(price, qty, "half-even")` rounding there is chosen to match the
  // rounding the books themselves record cost with, and a second
  // mark-to-market with a different mode would make a flat position show a
  // profit at the last digit. The string round-trip through `unrealizedPnl` is
  // the deliberate price of having exactly one such formula.
  const pnl = unrealizedPnl(position.heldQuantity, position.cost, bot.lastPrice);
  if (pnl === null) {
    // `unrealizedPnl` returns null for an absent price OR an unparseable one,
    // and this branch is only reachable with a non-zero held quantity (the
    // third null cause, a flat position, returned above). Both remaining causes
    // mean the same thing here: this position's current worth is unknown.
    into.unpricedPositions += 1;
    into.unrealized = null;
    return;
  }
  const amount = parse(pnl.amount);
  if (amount === null) {
    into.malformedValues += 1;
    into.unrealized = null;
    return;
  }
  if (into.unrealized !== null) into.unrealized += amount;
}

function finish(acc: Accumulator): AssetTotals {
  const gaps: Incompleteness = {
    orphanedBots: acc.orphanedBots,
    unpricedPositions: acc.unpricedPositions,
    unpricedFills: acc.unpricedFills,
    malformedValues: acc.malformedValues,
  };
  const net =
    acc.unrealized !== null && isComplete(gaps)
      ? acc.realizedGross - acc.feesReported + acc.unrealized
      : null;

  return {
    capitalAsset: acc.capitalAsset,
    botCount: acc.botCount,
    allocated: toDecimalString(acc.allocated),
    inPosition: toDecimalString(acc.inPosition),
    idle: toDecimalString(acc.allocated - acc.inPosition),
    realizedGross: toDecimalString(acc.realizedGross),
    feesReported: toDecimalString(acc.feesReported),
    unrealized: acc.unrealized === null ? null : toDecimalString(acc.unrealized),
    net: net === null ? null : toDecimalString(net),
    openPositions: acc.openPositions,
    cyclesCompleted: acc.cyclesCompleted,
    gaps,
  };
}

/**
 * Roll the whole bot list up, one entry per capital asset.
 *
 * Ordered by committed capital descending, then by asset name, so the biggest
 * exposure leads and the order is stable across polls (an order that reshuffled
 * under a live 5-second poll would be unreadable). An empty list yields an
 * empty array, which the caller renders as nothing at all rather than as a
 * strip of zeroes.
 */
export function accountTotals(bots: readonly Bot[]): readonly AssetTotals[] {
  const byAsset = new Map<string, Accumulator>();
  for (const bot of bots) {
    let acc = byAsset.get(bot.capitalAsset);
    if (acc === undefined) {
      acc = emptyAccumulator(bot.capitalAsset);
      byAsset.set(bot.capitalAsset, acc);
    }
    fold(acc, bot);
  }

  // Sorted as `bigint` Money, BEFORE rendering to strings -- comparing the
  // decimal strings would be a lexicographic comparison wearing a numeric
  // costume ("9" > "10"), and re-parsing them back would be work already done.
  return [...byAsset.values()]
    .sort((a, b) => {
      if (a.allocated !== b.allocated) return a.allocated < b.allocated ? 1 : -1;
      return a.capitalAsset.localeCompare(b.capitalAsset);
    })
    .map(finish);
}

/**
 * The human sentence for why a total is a floor, or null when nothing is
 * missing. Built here rather than in the component so the wording travels with
 * the rule that produced it.
 */
export function gapSummary(gaps: Incompleteness): string | null {
  const parts: string[] = [];
  if (gaps.orphanedBots > 0) {
    parts.push(`${gaps.orphanedBots} orphaned bot${gaps.orphanedBots === 1 ? "" : "s"}`);
  }
  if (gaps.unpricedPositions > 0) {
    parts.push(
      `${gaps.unpricedPositions} position${gaps.unpricedPositions === 1 ? "" : "s"} with no price yet`,
    );
  }
  if (gaps.unpricedFills > 0) {
    parts.push(
      `${gaps.unpricedFills} fill${gaps.unpricedFills === 1 ? "" : "s"} whose fee could not be priced`,
    );
  }
  if (gaps.malformedValues > 0) {
    parts.push(
      `${gaps.malformedValues} unreadable value${gaps.malformedValues === 1 ? "" : "s"}`,
    );
  }
  if (parts.length === 0) return null;
  return parts.join(", ");
}
