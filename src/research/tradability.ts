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
import type { ExchangeOutcome } from "../shared/downtime";
import type { InstrumentKind, Pair, SymbolFilters } from "../shared/exchange-client";
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

// ---------------------------------------------------------------------------
// "Is it SPOT?" -- a second question, at the same gate
// ---------------------------------------------------------------------------

/**
 * ── WHY THIS IS A SECOND FUNCTION AND NOT A WIDER `checkTradable` ──
 *
 * `checkTradable` answers "does this venue list this string", from the pair
 * CATALOGUE -- one full-catalogue request, KV-cached for an hour, shared by
 * every caller. This answers "what IS this instrument", from that symbol's own
 * DETAILS -- one uncached per-symbol request. Two different questions, two
 * different endpoints, two different costs, and two different refusals a caller
 * may want to act on differently.
 *
 * Folding them into one function would force every existing caller
 * (`addToWatchlist`, `fetchCandleWindow`, `selectNamedCandidate`,
 * `selectGeneralCandidates`) to start paying the per-symbol request whether or
 * not it wants the answer -- and `selectGeneralCandidates` checks up to fifteen
 * trending coins times each quote asset per run, which would turn one cached
 * catalogue read into dozens of live requests. So they stay separate and are
 * composed at the gate that wants both. Today that gate is bot creation, which
 * is the one place a wrong answer ends in a real order.
 *
 * It is NOT a second implementation of `checkTradable` in the sense 21.5 warns
 * about -- it does not re-answer the tradability question, it answers a
 * different one, and it lives in this file precisely so the two are read
 * together and neither grows a private copy elsewhere.
 */

/** How a caller reaches ONE symbol's details. See `SymbolDetailLister`. */
export type SymbolDetailSource = (
  account: VenueAccount,
  pair: Pair,
) => Promise<ExchangeOutcome<SymbolFilters>>;

export type InstrumentRefusalCode =
  /** The venue says this symbol is a swap/perpetual, not spot. */
  | "instrument_not_spot"
  /** The venue answered, and this code cannot tell what the instrument is. */
  | "instrument_type_unknown"
  /** The details could not be read at all. */
  | "instrument_unreadable";

/** Why the pair may not be traded by this system, in the caller's own words. */
export interface InstrumentRefusal {
  readonly code: InstrumentRefusalCode;
  readonly message: string;
}

/**
 * WHICH VENUES PUBLISH AN INSTRUMENT TYPE, stated once, per venue, explicitly.
 *
 * This is a `Record<ExchangeId, ...>` rather than a lookup with a default so
 * that adding a third exchange FAILS TO COMPILE here until someone answers the
 * question for it -- the same "a new value must be handled, not guessed"
 * property `exchange-dispatch.ts` gets from its exhaustive `switch`. A default
 * would silently pick one of the two answers below for a venue nobody checked,
 * and both answers are wrong for some venue.
 *
 *  - `gemini`  TRUE. `GET /v1/symbols/details/:symbol` documents `product_type`
 *    ("Instrument type spot / swap") and `contract_type`. Gemini lists spot and
 *    perpetuals in ONE catalogue on ONE host, so the field is the only thing
 *    that separates them and it must be present.
 *
 *  - `binance` FALSE, and this is a structural fact rather than a concession.
 *    `/api/v3/exchangeInfo` IS the spot API; Binance's perpetuals are a
 *    different product on a different host (`fapi.binance.com`, whose
 *    `exchangeInfo` carries `contractType: PERPETUAL`) that this system has no
 *    client for and cannot reach. There is no instrument-type field on the spot
 *    payload because there is no non-spot instrument in it to distinguish.
 *
 *    NOT CLAIMED, and explicitly still open: that everything on Binance's spot
 *    endpoint is something this system should trade. `parseTradablePairs`
 *    filters on `status === "TRADING"` alone and reads neither
 *    `isSpotTradingAllowed` nor `permissions` (documented values include
 *    `SPOT`, `MARGIN` and `LEVERAGED`), so a margin-only or leveraged-token
 *    symbol would pass it today. That is a REAL and SEPARATE gap, deferred
 *    deliberately and recorded here rather than in a comment nobody reads,
 *    because this table is exactly where a future reader will come looking for
 *    "what does this system believe about Binance instruments".
 */
const VENUE_PUBLISHES_INSTRUMENT_TYPE: Readonly<Record<ExchangeId, boolean>> = {
  gemini: true,
  binance: false,
};

/** How each mappable answer reads in a refusal message. */
function describeInstrument(kind: InstrumentKind | undefined): string {
  switch (kind) {
    case "derivative":
      return "a derivative (a perpetual swap or futures contract)";
    case "spot":
      return "spot";
    case "unknown":
      return "an instrument type this system does not recognise";
    case undefined:
      return "an instrument type the venue did not report at all";
  }
}

/**
 * Check that a pair is a SPOT instrument this system can actually model.
 *
 * Returns `null` when it is, and a refusal otherwise. Fails closed in all three
 * directions, which is the whole point:
 *
 *   * the venue says swap/perpetual   -> `instrument_not_spot`
 *   * the venue's answer is unmappable
 *     or absent on a venue that publishes it
 *                                     -> `instrument_type_unknown`
 *   * the details could not be read   -> `instrument_unreadable`
 *
 * The middle one is the one that will look wrong to whoever reads it next, so:
 * refusing when the field is MISSING on a venue that documents it is not
 * pedantry. Gemini lists perpetuals and spot pairs in the same catalogue, so on
 * that venue "no instrument type" and "this might be a perpetual" are the same
 * sentence. Section 5.6's rule is that a failed read is never data; this is that
 * rule one level up -- a field that did not arrive is not a field that said
 * "spot".
 *
 * `refusing` is the caller's own sentence about what it is declining to do,
 * appended for the same reason `checkTradable` takes one: the venue facts are
 * shared, but what is being refused is not.
 */
export async function checkSpotInstrument(
  getSymbolDetails: SymbolDetailSource,
  account: VenueAccount,
  pair: Pair,
  refusing: string,
): Promise<InstrumentRefusal | null> {
  if (!VENUE_PUBLISHES_INSTRUMENT_TYPE[account.exchange]) return null;

  const outcome = await getSymbolDetails(account, pair);
  if (!outcome.ok) {
    return {
      code: "instrument_unreadable",
      message:
        `cannot confirm ${JSON.stringify(pair)} is a spot instrument on ${account.exchange} ` +
        `for account ${JSON.stringify(account.label)}: ${outcome.kind} -- ${outcome.message}. ` +
        refusing,
    };
  }

  const instrument = outcome.value.instrument;
  if (instrument === "spot") return null;

  return {
    code: instrument === "derivative" ? "instrument_not_spot" : "instrument_type_unknown",
    message:
      `${JSON.stringify(pair)} is ${describeInstrument(instrument)} on ${account.exchange}, ` +
      `not a spot pair. Every order, fill, position and PnL path in this system is spot ` +
      `(section 4.5: limit orders only); nothing in it understands margin, funding or ` +
      `liquidation, so a derivative would trade under rules this system cannot model. ` +
      refusing,
  };
}
