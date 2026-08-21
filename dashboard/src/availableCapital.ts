/**
 * AVAILABLE capital, per (account, asset), for the bot list's stat row.
 *
 * The figure this answers is the one an operator previously had to compute by
 * hand: how much capital is actually FREE to fund a new bot. It is
 * `totalBalance - totalAllocated`, computed server-side by `readAccountCapital`
 * and merely carried here -- this module performs NO ARITHMETIC ON MONEY at all,
 * constructs no float, and re-derives nothing. It groups, labels, orders, and
 * decides which of two hint sentences applies.
 *
 * WHY THIS IS A `.ts` AND NOT PART OF THE COMPONENT
 * ------------------------------------------------
 * The dashboard has no jsdom and no testing-library, and a test importing a
 * `.tsx` collects ZERO TESTS RATHER THAN FAILING inside the Workers pool this
 * suite runs in (decision logs 44, 45, 46, 48). So every decision worth testing
 * -- how many cards there are, which account each belongs to, what its label and
 * hint say, whether it is flagged over-allocated -- is made HERE, where a test
 * can reach it, and `AccountSummary.tsx` only places what this produced. That is
 * the same split `accountTotals.ts`, `statusCounts.ts` and
 * `killSwitchBannerState.ts` already keep.
 *
 * NEVER SUMMED ACROSS ACCOUNTS. NOT ONCE, NOT ANYWHERE
 * ---------------------------------------------------
 * `capital_ledger` is keyed (account_label, asset) and
 * `createBotInstanceWithCapital` draws from exactly ONE of those rows. Two
 * accounts each holding 50,000 USD do not give you 100,000 USD to spend on one
 * bot -- they give you two separate 50,000 limits. A blended total would look
 * completely normal and be unspendable, which is the same trap `accountTotals.ts`
 * documents for blending USD with USDT, one key wider. So this emits one card
 * per row and provides no total.
 *
 * ⚠ WHY THIS NUMBER CAN LOOK SLIGHTLY OFF WITHOUT BEING WRONG
 * ----------------------------------------------------------
 * Two real effects move it in OPPOSITE directions, and both are properties of
 * what the two ledger columns mean rather than faults in the subtraction. They
 * are written out in full at `listAccounts` in `src/api/handlers.ts`, where the
 * figure is built; in short:
 *
 *   A. It can OVERSTATE, because a manual adjustment (e.g. a logged withdrawal)
 *      does not reach `total_balance` until reconciliation consumes it.
 *   B. It can UNDERSTATE, because cash already spent on inventory has left
 *      `total_balance` while that bot's full reservation remains in
 *      `total_allocated` -- so the deployed portion is subtracted twice.
 *
 * This is exactly why the hint says "what a new bot can reserve" and not
 * "spendable cash". The claim it makes is the one that is precisely true: this
 * is the arithmetic the creation gate itself runs.
 */

import type { Account, AccountAssetHeadroom } from "./api/types";
import { parse } from "./derive";

/**
 * The subtext under a healthy AVAILABLE figure.
 *
 * "what a new bot can reserve" rather than "free cash", deliberately -- see the
 * two caveats in the module header. The typographic minus matches the Net tile's
 * existing "realized − fees + unrealized" rather than introducing a second
 * convention into the same row.
 */
export const AVAILABLE_HINT = "balance − allocated; what a new bot can reserve";

/**
 * The subtext when `available` is negative.
 *
 * Shown INSTEAD of the figure's usual explanation, because at that point the
 * arithmetic is no longer the interesting fact about the number. It is the same
 * treatment the IDLE tile gives its own negative case: state the condition, in
 * amber, and do not clamp it away. An over-allocated account is real drift
 * somewhere else in the system, and this row is where a human sees it first.
 */
export const OVER_ALLOCATED_HINT = "over-allocated: allocated exceeds balance";

/** One AVAILABLE tile: exactly one `capital_ledger` row, ready to place. */
export interface AvailableCard {
  readonly accountLabel: string;
  readonly asset: string;
  /**
   * The tile's label. Plain "Available" when this asset has only one funding
   * account -- today's case, and identical in effect to a single AVAILABLE tile
   * -- and "Available · <account>" when two accounts fund the same asset, where
   * an unlabelled pair of tiles would be two numbers with no way to tell which
   * is which.
   */
  readonly label: string;
  /** The exact decimal string from the server. Unclamped; may be negative. */
  readonly value: string;
  readonly totalBalance: string;
  readonly totalAllocated: string;
  /** `value` is negative: allocated exceeds balance. Renders amber. */
  readonly overAllocated: boolean;
  readonly hint: string;
  /** The ledger row's own `updated_at`, not when the poll ran. */
  readonly updatedAt: number;
}

export interface AvailableCapital {
  /** Ordered by asset, then account. Stable across polls. */
  readonly cards: readonly AvailableCard[];
  /**
   * Accounts whose ledger read FAILED (`capital: null`), by label.
   *
   * Tracked rather than ignored, and kept apart from "this account has no ledger
   * row" -- which is not a failure and produces no card and no entry here. The
   * UI says which accounts it could not answer for, so a missing tile is never
   * silently indistinguishable from an account with nothing in it.
   */
  readonly unreadableAccounts: readonly string[];
  /**
   * Ledger rows whose money strings the parser refused, counted and dropped.
   *
   * Should be structurally impossible -- every money field is `toDecimalString`
   * output by contract. Counted anyway for `accountTotals.ts`'s reason: the
   * failure mode of ignoring it is a row that quietly vanishes from a capital
   * readout while everything still looks fine.
   */
  readonly malformedRows: number;
}

/** Every money field on the row parses. Validation only -- nothing is computed. */
function isReadable(row: AccountAssetHeadroom): boolean {
  return (
    parse(row.totalBalance) !== null &&
    parse(row.totalAllocated) !== null &&
    parse(row.available) !== null
  );
}

/**
 * Build the AVAILABLE tiles from the polled account list.
 *
 * `null` (no successful load yet) yields NOTHING -- no cards, no failures, no
 * zeroes. "NULL IS NOT ZERO" as `StatusStrip` and `accountTotals` both state it:
 * a confident "0.00 available" for a fleet whose ledger has not loaded is the
 * one output this module must never produce, because it is indistinguishable
 * from a genuinely exhausted account.
 */
export function availableCapital(accounts: readonly Account[] | null): AvailableCapital {
  if (accounts === null) return { cards: [], unreadableAccounts: [], malformedRows: 0 };

  const unreadableAccounts: string[] = [];
  let malformedRows = 0;
  const rows: { account: string; row: AccountAssetHeadroom }[] = [];

  for (const account of accounts) {
    if (account.capital === null) {
      // The read failed. Not an empty account; see `Account.capital`.
      unreadableAccounts.push(account.accountLabel);
      continue;
    }
    for (const row of account.capital.assets) {
      if (!isReadable(row)) {
        malformedRows += 1;
        continue;
      }
      rows.push({ account: account.accountLabel, row });
    }
  }

  // How many accounts fund each asset, which decides whether a tile needs to
  // name its account. Counted over the READABLE rows only, so a dropped row
  // cannot leave a lone tile wearing a disambiguating label for a sibling that
  // is not on screen.
  const accountsPerAsset = new Map<string, number>();
  for (const { row } of rows) {
    accountsPerAsset.set(row.asset, (accountsPerAsset.get(row.asset) ?? 0) + 1);
  }

  const cards = rows
    // Asset first, then account: the tiles for one asset stay together, and
    // neither key reshuffles under a live 5-second poll.
    .sort((a, b) => a.row.asset.localeCompare(b.row.asset) || a.account.localeCompare(b.account))
    .map(({ account, row }): AvailableCard => {
      // The server's own string, read for its sign only -- never re-derived.
      const overAllocated = row.available.startsWith("-");
      return {
        accountLabel: account,
        asset: row.asset,
        label: (accountsPerAsset.get(row.asset) ?? 0) > 1 ? `Available · ${account}` : "Available",
        value: row.available,
        totalBalance: row.totalBalance,
        totalAllocated: row.totalAllocated,
        overAllocated,
        hint: overAllocated ? OVER_ALLOCATED_HINT : AVAILABLE_HINT,
        updatedAt: row.updatedAt,
      };
    });

  return { cards, unreadableAccounts, malformedRows };
}

/** The cards for one capital asset, in order. Used to place them per strip. */
export function cardsForAsset(
  capital: AvailableCapital,
  asset: string,
): readonly AvailableCard[] {
  return capital.cards.filter((card) => card.asset === asset);
}

/**
 * Assets that have ledger headroom but NO bots, in order.
 *
 * These get a strip of their own. A freshly funded account with nothing running
 * is precisely when "what is free to use" is the most useful number on the page,
 * and it is also exactly when `accountTotals` produces no group to hang it from
 * -- so keying the tiles solely off the bot list would hide the figure in the
 * one situation it exists for.
 */
export function assetsWithoutTotals(
  capital: AvailableCapital,
  assetsWithTotals: readonly string[],
): readonly string[] {
  const covered = new Set(assetsWithTotals);
  const out: string[] = [];
  for (const card of capital.cards) {
    if (covered.has(card.asset) || out.includes(card.asset)) continue;
    out.push(card.asset);
  }
  return out;
}
