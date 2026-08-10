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
 * ── Fail closed in EVERY direction ──
 *
 *   * listed, and the pair is absent  -> `pair_not_tradable`
 *   * the listing itself failed       -> `tradable_set_unreadable`
 *   * listed, but the NAME says perp,
 *     and the call site asked         -> `pair_not_spot_by_name`
 *
 * The third is opt-in per call site and is an INFERENCE, not a venue statement.
 * It carries a long warning of its own further down; read that before treating
 * it as a spot check. The real one is `checkSpotInstrument`.
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

export type TradabilityRefusalCode =
  | "pair_not_tradable"
  | "tradable_set_unreadable"
  /** The venue lists it, and its NAME says derivative. An inference; see below. */
  | "pair_not_spot_by_name";

/** Why the pair may not be acted on, in the caller's own error's words. */
export interface TradabilityRefusal {
  readonly code: TradabilityRefusalCode;
  readonly message: string;
}

// ---------------------------------------------------------------------------
// The naming heuristic: A NAMING-CONVENTION INFERENCE, NOT A STRUCTURAL GUARANTEE
// ---------------------------------------------------------------------------

/**
 * ── READ THIS BEFORE TRUSTING ANYTHING BELOW ──
 *
 * `checkSpotInstrument`, further down this file, is the REAL spot-versus-
 * derivative check: it reads Gemini's documented `product_type` / `contract_type`
 * fields off that symbol's own details payload, and it is what stands between a
 * human's typo and a real order at `POST /api/bots` (step 32, verified live
 * against real sandbox data). This is not that, and it must never be described
 * as if it were.
 *
 * This is a SUFFIX MATCH ON A STRING. It exists because `checkSpotInstrument`
 * costs one uncached exchange request per symbol, and `checkTradable` is called
 * on every watchlist add, every candle fetch, and up to ~15 times (times each
 * quote asset) per candidate-selection run. Those paths cannot afford a
 * per-symbol network call, so before step 33 they had NO spot check at all --
 * `addToWatchlist`, `fetchCandleWindow` and `selectNamedCandidate` would each
 * accept `HYPEUSDCPERP` with zero resistance, because the venue genuinely does
 * list it (decision log 31's flagged gap; decision log 32 closed it only at the
 * order path and said so).
 *
 * ── WHAT THIS PROTECTS ──
 *
 *   * a perpetual cannot be WATCHLISTED (`addToWatchlist`)
 *   * a perpetual cannot have CANDLES FETCHED for it (`fetchCandleWindow`)
 *   * a perpetual cannot be selected as a NAMED research candidate
 *     (`selectNamedCandidate`)
 *   * nor as a GENERAL one (`selectGeneralCandidates`) -- where it was already
 *     structurally unreachable, since `${BASE}${QUOTE}` cannot construct a
 *     `PERP` suffix; opted in anyway so the four research paths do not differ
 *
 * ── WHAT THIS DOES NOT DO, STATED PLAINLY ──
 *
 *   * It does NOT replace `checkSpotInstrument`. The order path does not use it
 *     at all -- see `DerivativeNamePolicy` and `assertBotPairIsSpotTradable`.
 *   * It is NOT a structural guarantee. GEMINI PUBLISHES NO SUCH NAMING RULE:
 *     their derivatives reference states no naming convention whatsoever. This
 *     is an OBSERVATION about their current data -- `HYPEGUSDPERP` and
 *     `HYPEUSDCPERP` seen in the real catalogue (log 31), and `HYPEUSDCPERP`
 *     confirmed live to report `product_type: "swap"` (log 32) -- and an
 *     observation can stop being true without anyone announcing it.
 *   * RESIDUAL RISK, BOTH DIRECTIONS, NEITHER HYPOTHETICAL-ONLY:
 *       - FALSE ACCEPT: a real perpetual that does not end in `perp` sails
 *         through every research path. Nothing here would notice.
 *       - FALSE REJECT: a real spot pair whose symbol happens to end in these
 *         letters is refused. `PERPUSD` (Perpetual Protocol, a real token) is
 *         the known near-miss and is why the match is `endsWith` and not
 *         `includes` -- but a future venue pair literally ending in `PERP`
 *         would be wrongly blocked.
 *
 * ── WHICH FAILURE DIRECTION WAS CHOSEN, AND WHY IT IS THE SAFE ONE ──
 *
 * A FALSE REJECT is preferred, and it stays preferred because it is LOUD: an
 * operator tries to watchlist a pair, gets a refusal naming this exact heuristic
 * and this exact file, and the fix is one entry in the table below plus a test.
 * The pair is blocked from three research conveniences in the meantime and from
 * nothing else -- `POST /api/bots` never consults this, so a false reject cannot
 * stop a legitimate bot from being created.
 *
 * A FALSE ACCEPT is silent by construction: a perpetual on the watchlist looks
 * exactly like a spot pair on the watchlist, and it would be discovered by
 * something downstream mis-modelling margin, funding or liquidation. That is the
 * asymmetry section 5.6 keeps making -- a refusal is a fact, a wrong acceptance
 * is a fact nobody has yet.
 */

/**
 * WHICH VENUES NAME THEIR DERIVATIVES, and how -- stated once, per venue.
 *
 * A `Record<ExchangeId, ...>` for the same reason `VENUE_PUBLISHES_INSTRUMENT_TYPE`
 * below is one: a third exchange FAILS TO COMPILE here until someone answers the
 * question for it. Silently defaulting to "no perps on this venue" is exactly
 * the false accept described above, applied to an entire venue at once.
 *
 *  - `gemini`  `["perp"]`. Observed, not documented -- `HYPEGUSDPERP` and
 *    `HYPEUSDCPERP` in the real catalogue, alongside spot pairs on the same
 *    host. Lower-case because the comparison folds the pair, not the table.
 *
 *  - `binance` `[]`, and the empty array is an ANSWER rather than a blank:
 *    this system only reaches Binance's spot host (`/api/v3/exchangeInfo`), so
 *    there is no derivative catalogue to name-match against here. Binance's
 *    perpetuals live on `fapi.binance.com`, which this system has no client for
 *    and cannot reach. If a client for it is ever added, this row becomes wrong
 *    and must change -- it says "nothing to match", not "nothing exists".
 *
 * Suffixes only. A substring match would refuse `PERPUSD` -- Perpetual
 * Protocol's real spot ticker -- and the whole point of a cheap heuristic is
 * that it is cheap to be right about.
 */
const DERIVATIVE_NAME_SUFFIXES: Readonly<Record<ExchangeId, readonly string[]>> = {
  gemini: ["perp"],
  binance: [],
};

/**
 * Whether a CALL SITE wants the naming heuristic. Required, with no default.
 *
 * There is no default because the two answers are not "on" and "off by
 * accident" -- they are two different arguments, and a sixth call site added
 * later must make one of them rather than inherit whichever was convenient.
 */
export type DerivativeNamePolicy =
  /** Research paths: cheap, and the only spot check they can afford. */
  | "reject-derivative-names"
  /**
   * The order path. It runs `checkSpotInstrument` on the real `product_type`
   * field immediately afterwards, and letting this weaker inference answer
   * FIRST would do two bad things: replace real venue evidence with a guess in
   * the refusal a human reads, and mask the structural check from its own most
   * realistic input, so deleting that check would leave every test green.
   */
  | "structural-check-elsewhere";

/** The suffix that matched, so the refusal can name its own evidence. */
function derivativeNameSuffix(exchange: ExchangeId, pair: Pair): string | null {
  const folded = pair.toLowerCase();
  for (const suffix of DERIVATIVE_NAME_SUFFIXES[exchange]) {
    if (folded.endsWith(suffix)) return suffix;
  }
  return null;
}

/**
 * Check one pair against the account's live catalogue.
 *
 * Returns `null` when the venue lists it, and a refusal otherwise. `refusing`
 * is the caller's own sentence about what it is declining to do, appended to
 * the unreadable-set message: the venue facts are shared, but "and so nothing
 * was stored" and "and so no candles were fetched" are not the same sentence
 * and a reader of either message deserves the accurate one.
 *
 * `names` decides whether the naming heuristic above also applies. It runs
 * AFTER the catalogue answers, never before, for the ordering reason step 32
 * gave at the bot gate: the strongest TRUE fact should be the one that
 * surfaces. An unlisted `FOOPERP` is `pair_not_tradable` -- which is what is
 * actually wrong with it -- and only a pair the venue really does list can be
 * refused for looking like a derivative.
 */
export async function checkTradable(
  listTradablePairs: TradablePairSource,
  account: VenueAccount,
  pair: Pair,
  refusing: string,
  names: DerivativeNamePolicy,
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

  if (listing.pairs.includes(pair)) {
    if (names === "structural-check-elsewhere") return null;
    const suffix = derivativeNameSuffix(account.exchange, pair);
    if (suffix === null) return null;
    return {
      code: "pair_not_spot_by_name",
      message:
        `${JSON.stringify(pair)} is listed on ${account.exchange} for account ` +
        `${JSON.stringify(account.label)}, but its symbol ENDS IN ` +
        `${JSON.stringify(suffix.toUpperCase())}, which on that venue names a perpetual ` +
        `rather than a spot pair. Every order, fill, position and PnL path in this ` +
        `system is spot (section 4.5); nothing in it understands margin, funding or ` +
        `liquidation. ` +
        `THIS IS AN INFERENCE FROM A NAMING CONVENTION, NOT A STATEMENT FROM THE ` +
        `VENUE: ${account.exchange} publishes no such naming rule, and this is an ` +
        `observation about its current catalogue. If this pair really is spot, the ` +
        `refusal is wrong and the fix is DERIVATIVE_NAME_SUFFIXES in ` +
        `src/research/tradability.ts. ${refusing}`,
    };
  }

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
