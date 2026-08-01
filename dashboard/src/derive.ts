/**
 * Derived figures for the bot detail view: the price a DCA cycle exits at, and
 * mark-to-market unrealized profit for a position the bot is still holding.
 *
 * Read-only presentation. Nothing here is written back, sent, or acted on -- the
 * bot computes its own thresholds from its own state and this module never feeds
 * that path. It exists so an operator can see, at a glance, the two numbers the
 * detail view previously made them work out in their head.
 *
 * WHY THIS IMPORTS FROM THE WORKER'S SOURCE TREE
 * ----------------------------------------------
 * `src/shared/money.ts` is the second file the dashboard imports across the
 * seam, after `src/shared/alert-types.ts` (18.1 addendum). It earns the crossing
 * on the same terms and for the same reason:
 *
 *   - Dependency-free by contract. `money.ts` has no imports at all, so both
 *     toolchains compile it unchanged despite the deliberate TypeScript 5.7 / 7
 *     split (10.6 decision 3). Verified by building, not assumed.
 *   - A re-derived copy is what fails SILENTLY. A second decimal parser in the
 *     dashboard would not fail to compile or throw; it would quietly disagree
 *     with the backend by a rounding step on a money figure an operator reads to
 *     decide whether to intervene. That is precisely the failure mode the
 *     alert-type crossing was made to close.
 *
 * So every value below is exact `bigint` Money at SCALE 8. No float is ever
 * constructed, which is the same discipline `format.ts` keeps for display.
 *
 * WHAT IS *NOT* IMPORTED, AND WHY
 * -------------------------------
 * The ideal would be to call `takeProfitPrice` from `src/strategies/dca.ts`
 * directly, so the price shown is produced by the very function the bot decides
 * with. That was tried and REJECTED for a concrete reason, not skipped: the
 * dashboard's `tsconfig.app.json` sets `noUnusedLocals: true` where the Worker's
 * does not, and `dca.ts` carries a dead `mulInt` import, so pulling it in fails
 * `tsc -b` on backend code. Correcting that is a backend edit and this session is
 * UI-only. `applyPercent` below is therefore a deliberate, DOCUMENTED mirror of
 * `applyPercent` in `src/strategies/dca.ts` -- the one re-derivation here, kept
 * to a single line and pinned to its original by this comment.
 */

import type { Money, Rounding } from "../../src/shared/money";
import { ONE, ZERO, divideRounded, fromDecimalString, mul, toDecimalString } from "../../src/shared/money";

/** 100%, in the same Money scale percentages arrive in ("20" = 20% = 20 * ONE). */
const HUNDRED_PERCENT = 100n * ONE;

/**
 * `base x (100 + pct) / 100`, in one rounding step.
 *
 * MIRROR of `applyPercent` in src/strategies/dca.ts (see the module note above).
 * One rounding step, not two, is load-bearing: multiplying and then dividing with
 * separate roundings gives a different answer at the last digit.
 */
function applyPercent(base: Money, pct: Money, rounding: Rounding): Money {
  return divideRounded(base * (HUNDRED_PERCENT + pct), HUNDRED_PERCENT, rounding);
}

/**
 * Every API money value is `toDecimalString` output -- exactly SCALE decimal
 * places -- so `fromDecimalString` cannot reject it. If that contract is ever
 * broken, a throw here would happen during render and take the WHOLE detail page
 * down, replacing a working page with a blank one. These figures are additive
 * context, so they degrade to "—" instead and leave everything else standing.
 */
function parse(value: string): Money | null {
  try {
    return fromDecimalString(value);
  } catch {
    return null;
  }
}

/**
 * The price at or above which a DCA cycle sells its whole position
 * (section 6.3 step 4): average entry x (1 + take-profit%).
 *
 * `null` when the bot holds nothing yet, because there is no average entry to
 * measure from -- NOT zero, which would read as "it sells at any price".
 *
 * Rounds CEIL, matching `takeProfitPrice` in src/strategies/dca.ts: the realised
 * gain must be at least the configured percentage, so the trigger is rounded
 * away from the operator's favour rather than to nearest.
 */
export function takeProfitPriceOf(averageEntryPrice: string, takeProfitPct: string): string | null {
  const avg = parse(averageEntryPrice);
  const pct = parse(takeProfitPct);
  if (avg === null || pct === null || avg <= ZERO) return null;
  return toDecimalString(applyPercent(avg, pct, "ceil"));
}

/**
 * Mark-to-market profit on a position the bot is STILL HOLDING -- what the
 * existing "Realized (gross)" card deliberately excludes, since that one counts
 * only closed cycles.
 */
export interface UnrealizedPnl {
  /** Held quantity valued at the current price, in the capital (quote) asset. */
  readonly value: string;
  /** Signed: `value - cost`. POSITIVE IS A GAIN. Capital asset, gross of fees. */
  readonly amount: string;
  /** Signed percentage OF THE COST BASIS, or null when the basis is zero. */
  readonly pct: string | null;
}

/**
 * Unrealized profit on `quantity` acquired for `cost`, valued at `currentPrice`.
 *
 * `null` -- rendered "—" -- when there is nothing meaningful to state: no price
 * has been seen yet (section 5.6: an unusable price is reported, never guessed
 * at), or the position is flat, where the honest reading is "no position" rather
 * than a profit of zero.
 *
 * THREE CONVENTIONS, EACH CHOSEN AGAINST BACKEND SOURCE RATHER THAN TASTE:
 *
 *  1. GROSS, not net. `cost` here is the bare notional: `applyFill` returns
 *     `quoteDelta = mul(price, quantity)` and carries `feeAmount` as a SEPARATE
 *     field which never enters the position (order-state.ts), and grid's
 *     `heldCost` accumulates the same bare product (grid.ts). Fees paid on the
 *     way in are therefore already excluded, and the fee that will be paid on
 *     the way out has not happened. So this is gross, exactly like the
 *     "Realized (gross)" figure beside it, and is labelled to say so instead of
 *     implying a net number the data cannot support.
 *
 *  2. VALUE USES `mul(price, qty, "half-even")` -- the same call AND the same
 *     rounding the books themselves use to record cost (`NOTIONAL_ROUNDING` in
 *     order-state.ts, and grid.ts's buy branch). Picking a different mode would
 *     make a flat position show a non-zero profit at the last digit.
 *
 *  3. THE PERCENTAGE IS OF COST BASIS: `(value - cost) / cost`, not
 *     `(price - averageEntry) / averageEntry`. The two differ by a rounding step,
 *     because `averageEntryPrice` is itself a stored `half-even` quotient of
 *     cost/quantity (dca.ts:409). Cost basis wins on two counts: it is exact
 *     against the money actually spent, and it is the ONLY form grid can use at
 *     all, since a ladder stores no average entry. One formula serves both views
 *     rather than two that could drift apart.
 */
export function unrealizedPnl(
  quantity: string,
  cost: string,
  currentPrice: string | null,
): UnrealizedPnl | null {
  if (currentPrice === null) return null;
  const qty = parse(quantity);
  const basis = parse(cost);
  const price = parse(currentPrice);
  if (qty === null || basis === null || price === null) return null;
  if (qty <= ZERO) return null;

  const value = mul(price, qty, "half-even");
  const amount = value - basis;
  const pct =
    basis === ZERO ? null : toDecimalString(divideRounded(amount * HUNDRED_PERCENT, basis, "half-even"));

  return { value: toDecimalString(value), amount: toDecimalString(amount), pct };
}
