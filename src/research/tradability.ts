/**
 * "Will this account's venue actually trade this pair?" -- asked once, here.
 *
 * This is `watchlist.ts`'s `assertTradable` lifted out unchanged in behaviour,
 * for the reason 21.5 gives about risk checks generally: "a second
 * implementation of a risk check drifts from the first, and the copy that
 * drifts is the one nobody is watching." Step 28 built the check for the
 * watchlist's write path; section 21.4's Stage 1 candle fetch needs the same
 * question answered before it spends an exchange request, and answering it a
 * second time is exactly how the two come to disagree about what a venue lists.
 *
 * It RETURNS a refusal rather than throwing one. Each caller owns its own error
 * type -- `WatchlistError` for a write that must not land, `CandleWindowError`
 * for a fetch that must not run -- and both take the code and the message from
 * here, so the two refusals are the same refusal wearing the caller's name.
 *
 * ── Fail closed in BOTH directions ──
 *
 *   * listed, and the pair is absent  -> `pair_not_tradable`
 *   * the listing itself failed       -> `tradable_set_unreadable`
 *
 * The second is the one that rots quietly. An exchange outage produces no
 * tradable set, and treating that as permission to proceed is the same
 * substitution section 5.6 forbids when it refuses to read "could not reach the
 * exchange" as a price move.
 *
 * ── The comparison is EXACT, and that was demonstrated, not argued ──
 *
 * What `listTradablePairs` reports is NOT the venue's wire format: Gemini's
 * `/v1/symbols` returns lowercase, separator-less symbols and `parseSymbolList`
 * upper-cases them to this system's `Pair` convention, so the real listing is
 * `BTCUSD` -- 392 of them, read live on 2026-08-08. A `btcusd` written from
 * memory of the Gemini API was refused at step 28, correctly. A case-folded
 * match would have accepted it and handed every later exchange call a symbol it
 * had to re-spell; the refusal carries near-matches so the caller is told the
 * venue's own spelling instead of guessing which convention applies.
 */

import type { ExchangeId } from "../db/schema";
import type { Pair } from "../shared/exchange-client";
import type { SymbolListing } from "../workers/symbols";

/** An account and therefore the venue whose catalogue decides the question. */
export interface VenueAccount {
  readonly label: string;
  readonly exchange: ExchangeId;
}

/**
 * How a caller reaches the tradable set.
 *
 * A port rather than a direct call, for the reason `SymbolLister` already is
 * one: tests exercise the refusals without a network call. In production this
 * is `(account) => listAccountSymbols({ account, env, now, lister:
 * envSymbolLister, cache })`, so the KV cache and the real `listTradablePairs`
 * are reused exactly as the symbols endpoint uses them, with no second path to
 * the venue.
 */
export type TradablePairSource = (account: VenueAccount) => Promise<SymbolListing>;

export type TradabilityRefusalCode = "pair_not_tradable" | "tradable_set_unreadable";

/** Why the pair may not be acted on, in the caller's own error's words. */
export interface TradabilityRefusal {
  readonly code: TradabilityRefusalCode;
  readonly message: string;
}

/**
 * Check one pair against the account's live catalogue.
 *
 * Returns `null` when the venue lists it, and a refusal otherwise. `refusing`
 * is the caller's own sentence about what it is declining to do, appended to
 * the unreadable-set message: the venue facts are shared, but "and so nothing
 * was stored" and "and so no candles were fetched" are not the same sentence
 * and a reader of either message deserves the accurate one.
 */
export async function checkTradable(
  listTradablePairs: TradablePairSource,
  account: VenueAccount,
  pair: Pair,
  refusing: string,
): Promise<TradabilityRefusal | null> {
  const listing = await listTradablePairs(account);
  if (!listing.ok) {
    return {
      code: "tradable_set_unreadable",
      message:
        `cannot confirm ${JSON.stringify(pair)} is tradable on ${account.exchange} for ` +
        `account ${JSON.stringify(account.label)}: ${listing.failure.message}. ${refusing}`,
    };
  }

  if (listing.pairs.includes(pair)) return null;

  const folded = pair.toLowerCase();
  const near = listing.pairs.filter((candidate) => candidate.toLowerCase() === folded);
  return {
    code: "pair_not_tradable",
    message:
      `${JSON.stringify(pair)} is not tradable on ${account.exchange} for account ` +
      `${JSON.stringify(account.label)}` +
      (near.length > 0
        ? `. That venue spells it ${near.map((c) => JSON.stringify(c)).join(" or ")}; ` +
          `the symbol must match the exchange's own spelling exactly.`
        : `. ${listing.pairs.length} pairs were listed${listing.cached ? " (from cache)" : ""}.`),
  };
}
