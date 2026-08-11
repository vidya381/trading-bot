/**
 * Candidate selection for section 21's two entry points (21.2, 21.3).
 *
 * Section 21 as a whole is still PLANNED, NOT YET BUILT -- no pipeline, no
 * prompt, no proposal record, no Workers AI call, no Assess stage, no Derive
 * stage. This module is one more piece of Stage 1's deterministic groundwork
 * and nothing else: it answers "which coins does this run consider", and it
 * answers it with no model involved anywhere.
 *
 * ── 21.2's rule, and what it does and does not constrain here ──
 *
 * "This is ONE feature, not two ... The entry points differ ONLY in how the
 * candidate coin or coins are chosen." So both functions below return the same
 * `CandidateSet`, holding the same `Candidate` shape, and everything downstream
 * reads one type. What differs is which sources were consulted, which is the
 * one thing 21.2 explicitly says may differ.
 *
 * The two are kept from converging by their PORTS rather than by discipline:
 * `selectNamedCandidate` takes `NamedCandidatePorts`, which has no trending
 * source in it at all, so the named path cannot reach a vendor even by mistake.
 *
 * ── Provenance is not decoration (21.5 requirement 2) ──
 *
 * "Every proposal must display ... the real source the candidate came from
 * (WHICH watchlist entry, or WHICH trending pull, and when)."
 *
 * So the dedup here MERGES provenance instead of discarding it. A coin on both
 * the watchlist and the trending pull is ONE candidate carrying TWO sources,
 * and `Candidate.sources` is a non-empty tuple -- a candidate that came from
 * nowhere is unrepresentable, the same type discipline `news.ts` uses to make
 * "covered with zero articles" unrepresentable.
 *
 * Collapsing the two sources to a boolean, a set of strings, or a "first one
 * wins" would be smaller and would destroy exactly the fact 21.5 requires,
 * permanently and silently: nothing downstream can recover which watchlist
 * entry justified a coin once the entry id is gone.
 *
 * ── The hype hazard travels with the candidate (21.3) ──
 *
 * "Trending is a measure of attention, not of quality." A trending source keeps
 * the vendor's own `rank` and its raw item verbatim, and it keeps them under a
 * `kind: "trending"` discriminant, so the Explain stage can satisfy 21.3's
 * honest-limitation requirement by reading the candidate rather than by
 * remembering to. `rank` is the vendor's ordering position and NOTHING here or
 * downstream may read it as evidence in the coin's favour.
 *
 * ── Fail closed, and specifically about trending (21.5 requirement 6) ──
 *
 * 21.5 names "the trending source is unreachable" as one of the conditions that
 * must surface a clear failure. It does, by throwing: a failed trending pull
 * does not degrade this into a watchlist-only run.
 *
 * That is a deliberate and costly choice, so it is stated rather than assumed.
 * A watchlist-only set is not a smaller general run; it is a re-read of a list
 * someone already wrote, and 21.3 says the trending pull exists precisely
 * because "it is the only way the system can ever surface something the
 * operators did not already think to look for". Returning the watchlist half
 * under the name "general candidates" would be a degraded result
 * indistinguishable from a good one at a glance. An explicit watchlist-only
 * entry point is a thing an operator could be given later, ON PURPOSE and under
 * its own name; what must not exist is a general run that quietly becomes one.
 *
 * A tradable set that cannot be READ throws for the same reason it does in
 * `watchlist.ts` and `candles.ts`: "could not check" is never "checked and
 * fine" (section 5.6). It is NOT recorded as a rejection, because a rejection
 * list saying a coin is untradable when nobody could tell is a false record.
 *
 * ── What is a FACT rather than a FAILURE ──
 *
 * A trending pull that returns coins none of which this venue lists is not an
 * error. It is reported: `TrendingPullReport` carries what came back, what was
 * accepted, and every rejection with the exact pairs that were tried. So "zero
 * trending candidates" is always attributable -- to a venue that lists none of
 * them, or (the failure mode worth fearing) to a pair-spelling convention that
 * does not hold here. See `pairHypotheses` for why that distinction needs to be
 * visible rather than trusted.
 *
 * ── What this module deliberately does NOT do ──
 *
 *   * NO vendor. `TrendingSource` is an abstract port and there is no CoinGecko
 *     client, no URL, no wire-format parse, and no HTTP endpoint anywhere in
 *     this step. The trending vendor question was researched against primary
 *     sources and is recorded in the decision log; the seam is left where a
 *     vendor decision can land on it. Step 30's lesson, applied early rather
 *     than re-learned: designing the parse against the only vendor it has ever
 *     seen is how the wrong seam gets set in concrete.
 *   * NO persistence. Nothing here writes a row. The audit record 21.5
 *     requirement 5 wants belongs to the proposal, which does not exist yet --
 *     and every trending vendor surveyed so far has a data-storage clause that
 *     has to be read before raw vendor payloads are stored anywhere.
 *   * NO re-validation of watchlist entries. A watchlist pair was checked
 *     against the venue when it was added and is not checked again here. That
 *     is a deviation and is recorded as one: step 28 already logged that
 *     `readWatchlist` "says nothing about the tradable set having gone stale
 *     underneath" it, and closing that gap changes what the watchlist means,
 *     which is a decision rather than a detail.
 */

import type { Database } from "../db";
import type { ExchangeId } from "../db/schema";
import type { ExchangeOutcome } from "../shared/downtime";
import type { Pair, Timestamp } from "../shared/exchange-client";
import { checkTradable, type TradablePairSource, type VenueAccount } from "./tradability";
import { readWatchlist } from "./watchlist";

/**
 * Which door this run came through.
 *
 * 21.2 names TWO ("named coin" and "general"), and `watchlist` is a third that
 * the spec does not name. The deviation is deliberate and is argued where it is
 * introduced (`selectWatchlistCandidates`), but the one-line version belongs
 * here, beside the type it widens: 21.2's rule is that the entry points "differ
 * ONLY in how the candidate coin or coins are chosen", which is exactly and only
 * what this adds. Every door still produces the same `CandidateSet` holding the
 * same `Candidate` shape, and everything downstream still reads one type.
 *
 * What 21.2 forbids is a GENERAL run that quietly degrades into a watchlist-only
 * one when the trending pull is unavailable. That prohibition is untouched --
 * `selectGeneralCandidates` still throws `trending_unavailable` rather than
 * degrade -- and a separately named door an operator has to ask for by name is
 * the opposite of a silent degradation.
 */
export type CandidateEntryPoint = "named" | "general" | "watchlist";

/**
 * A human named this coin (21.2, "tell me about DOGE").
 *
 * `requestedAs` is what they actually typed, kept verbatim beside the validated
 * pair. The two differ whenever the input needed trimming, and a source record
 * that silently reports the cleaned-up version cannot answer "what did the
 * human ask for" -- which is the only question this source exists to answer.
 */
export interface NamedCandidateSource {
  readonly kind: "named";
  readonly requestedAs: string;
  readonly requestedBy: string;
  readonly requestedAt: Timestamp;
}

/**
 * 21.3's first source. `entryId` is 21.5 requirement 2's "WHICH watchlist
 * entry", and `note` is the human's stated reason, carried so the proposal can
 * show it without a second read of the table.
 */
export interface WatchlistCandidateSource {
  readonly kind: "watchlist";
  readonly entryId: string;
  readonly note: string;
  readonly addedBy: string;
  readonly addedAt: Timestamp;
}

/**
 * 21.3's second source. `pullId` is "WHICH trending pull" and `fetchedAt` is
 * the "when" -- the vendor's answer time, not a render time (21.5 requirement
 * 4).
 *
 * `raw` is the vendor's own item carried by identity, so 21.5 requirement 2's
 * "the actual raw data it used" is available rather than a rendering of it.
 * `rank` is the vendor's ordering position; see the module header.
 */
export interface TrendingCandidateSource {
  readonly kind: "trending";
  readonly pullId: string;
  readonly vendor: string;
  readonly fetchedAt: Timestamp;
  readonly coinId: string;
  readonly symbol: string;
  readonly name: string;
  readonly rank: number | null;
  readonly raw: unknown;
}

export type CandidateSource =
  | NamedCandidateSource
  | WatchlistCandidateSource
  | TrendingCandidateSource;

/**
 * One coin this run will consider, and every source that put it there.
 *
 * `sources` is a NON-EMPTY tuple by construction. A candidate with no source is
 * a coin the system cannot explain proposing, and 21.5 requirement 2 makes that
 * a proposal that must not exist -- so it is made unrepresentable rather than
 * checked for.
 */
export interface Candidate {
  readonly accountLabel: string;
  readonly exchange: ExchangeId;
  readonly pair: Pair;
  readonly sources: readonly [CandidateSource, ...CandidateSource[]];
}

/**
 * One coin as a trending vendor reports it, normalised to the four facts every
 * such vendor has, plus its raw item.
 *
 * Deliberately NOT a wire format. No vendor has been chosen (see the module
 * header and the decision log), and the transport that fills this in does not
 * exist yet. What is fixed here is only what candidate selection needs: an
 * identifier to log, a symbol to map to a pair, a name to show a human, and the
 * vendor's ordering position.
 */
export interface TrendingCoin {
  /** The vendor's own identifier, verbatim. Logged, never interpreted. */
  readonly coinId: string;
  /** The vendor's ticker, e.g. "BTC". Mapped to a pair; see `pairHypotheses`. */
  readonly symbol: string;
  readonly name: string;
  /** The vendor's ordering position, or null when it publishes none. */
  readonly rank: number | null;
  /** The vendor's item, by identity (21.5 requirement 2). */
  readonly raw: unknown;
}

export interface TrendingPull {
  /** Which vendor answered, recorded on every candidate it produces. */
  readonly vendor: string;
  readonly coins: readonly TrendingCoin[];
}

/**
 * How this module reaches a trending pull.
 *
 * `ExchangeOutcome` rather than a bare array or a `T | null`, for section 5.6's
 * reason: the only way to read the value out is to narrow to the `ok` variant,
 * so "the vendor did not answer" cannot be read as "the vendor answered with
 * nothing". Those are the two facts this module must never confuse, and the
 * type system is a better guard on that than a comment. The success variant's
 * `at` is the fetch instant 21.5 requirement 4 times a proposal from.
 */
export type TrendingSource = () => Promise<ExchangeOutcome<TrendingPull>>;

export type TrendingRejectionReason =
  /** The vendor sent an item with no usable symbol, so no pair could be formed. */
  | "unusable_symbol"
  /** Every pair tried for this coin is absent from the venue's catalogue. */
  | "not_tradable";

/**
 * A trending coin that did not become a candidate, and exactly what was tried.
 *
 * `triedPairs` is the load-bearing field. Without it, "the trending pull
 * produced nothing" is one sentence covering two very different situations --
 * a venue that genuinely lists none of today's trending coins, and a
 * pair-spelling convention that does not hold on this venue, which would drop
 * EVERY coin forever while looking like a quiet day.
 */
export interface TrendingRejection {
  readonly coinId: string;
  readonly symbol: string;
  readonly name: string;
  readonly rank: number | null;
  readonly triedPairs: readonly Pair[];
  readonly reason: TrendingRejectionReason;
}

/** What the trending half of a general run actually did. */
export interface TrendingPullReport {
  readonly pullId: string;
  readonly vendor: string;
  /** When the vendor answered (21.5 requirement 4). */
  readonly fetchedAt: Timestamp;
  /** The quote assets pairs were formed against, normalised and deduplicated. */
  readonly quoteAssets: readonly string[];
  /** Coins the vendor returned. */
  readonly returned: number;
  /** Coins that yielded at least one tradable pair. `accepted + rejected.length === returned`. */
  readonly accepted: number;
  /** Distinct pairs the pull matched; more than `accepted` with several quote assets. */
  readonly pairsMatched: number;
  readonly rejected: readonly TrendingRejection[];
}

/** What the watchlist half of a general run actually did. */
export interface WatchlistReadReport {
  readonly readAt: Timestamp;
  readonly entriesRead: number;
}

/**
 * The output of both entry points.
 *
 * `watchlist` and `trending` are null on a named run, and that is a statement
 * rather than a gap: the named entry point consults neither source, and a
 * report of zero entries read would claim a read that never happened.
 */
export interface CandidateSet {
  readonly entryPoint: CandidateEntryPoint;
  readonly accountLabel: string;
  readonly exchange: ExchangeId;
  readonly requestedBy: string;
  /** When this selection ran. Not a data-fetch time; see `TrendingPullReport.fetchedAt`. */
  readonly selectedAt: Timestamp;
  readonly candidates: readonly Candidate[];
  readonly watchlist: WatchlistReadReport | null;
  readonly trending: TrendingPullReport | null;
}

export type CandidateSelectionErrorCode =
  /** No such row in `accounts`, so there is no venue whose catalogue decides. */
  | "unknown_account"
  /** A blank pair, a blank requester, or an empty quote-asset list. */
  | "missing_field"
  /** The named pair is not listed on the account's venue. */
  | "pair_not_tradable"
  /** The tradable set could not be read, so tradability is unknown. */
  | "tradable_set_unreadable"
  /** Listed, but its NAME says perpetual. An inference; see `tradability.ts`. */
  | "pair_not_spot_by_name"
  /** The trending pull failed. See the module header for why this is fatal. */
  | "trending_unavailable";

export class CandidateSelectionError extends Error {
  readonly code: CandidateSelectionErrorCode;
  constructor(code: CandidateSelectionErrorCode, message: string) {
    super(message);
    this.name = "CandidateSelectionError";
    this.code = code;
  }
}

/**
 * The smallest port set any door needs: the registry, and a clock.
 *
 * The watchlist door needs exactly this and nothing more, and the absence of
 * `listTradablePairs` is load-bearing rather than incidental -- the same
 * technique `NamedCandidatePorts` uses to make the named door structurally
 * unable to reach a trending vendor. A watchlist entry's pair was checked
 * against the venue when it was added and is deliberately NOT re-checked here
 * (see the module header), so a door that held a catalogue port would be holding
 * one it must not use.
 */
export interface WatchlistCandidatePorts {
  /** The account registry. The exchange comes from here, never from a caller. */
  readonly db: Database;
  readonly now: () => Timestamp;
}

/** What the named entry point needs. Notably, no trending source. */
export interface NamedCandidatePorts extends WatchlistCandidatePorts {
  readonly listTradablePairs: TradablePairSource;
}

/** What the general entry point additionally needs. */
export interface GeneralCandidatePorts extends NamedCandidatePorts {
  readonly fetchTrending: TrendingSource;
  readonly newId: () => string;
}

export interface SelectNamedCandidateRequest {
  readonly accountLabel: string;
  /** The venue's own symbol, exactly as `listTradablePairs` reports it. */
  readonly pair: Pair;
  /** Who asked. Recorded on the candidate's source (21.5 requirement 2). */
  readonly requestedBy: string;
}

export interface SelectWatchlistCandidatesRequest {
  readonly accountLabel: string;
  /** Who asked. Recorded on the set, as the other two doors record it. */
  readonly requestedBy: string;
}

export interface SelectGeneralCandidatesRequest {
  readonly accountLabel: string;
  readonly requestedBy: string;
  /**
   * The quote assets a trending ticker may be paired against on this venue --
   * e.g. `["USD"]` on Gemini, `["USDT"]` on Binance.
   *
   * Required, with no default, because there is no honest one. It is an
   * operator's decision about what this account trades in, and a default would
   * make that decision silently and be wrong on the venue it was not written
   * for. An empty list is refused rather than treated as "all".
   */
  readonly quoteAssets: readonly string[];
}

function requireText(value: string, field: string): string {
  const trimmed = value.trim();
  if (trimmed === "") {
    throw new CandidateSelectionError("missing_field", `${field} must not be blank`);
  }
  return trimmed;
}

/**
 * Resolve the account, and therefore the venue whose catalogue decides.
 *
 * The exchange is read from the registry and never taken from the request --
 * the derivation `createBot`, the watchlist endpoints and `fetchCandleWindow`
 * all use, for step 11's reason: letting a caller name the venue lets them
 * choose which catalogue their pair is validated against, which is a validation
 * that validates nothing.
 */
async function resolveAccount(db: Database, accountLabel: string): Promise<VenueAccount> {
  const label = requireText(accountLabel, "accountLabel");
  const row = await db.accounts.findOne({ account_label: label });
  if (row === null) {
    throw new CandidateSelectionError(
      "unknown_account",
      `no registered account ${JSON.stringify(label)}, so there is no venue whose ` +
        `catalogue could decide which candidates are tradable`,
    );
  }
  return { label, exchange: row.exchange };
}

/**
 * ONE coin the human named (21.2's first entry point).
 *
 * The candidate set is that coin, validated against the account's REAL tradable
 * set through the same `checkTradable` the watchlist's write path and the
 * candle fetch use. Not a second implementation: 21.5's rule about risk checks
 * is that "a second implementation of a risk check drifts from the first, and
 * the copy that drifts is the one nobody is watching", and a candidate that
 * cannot become a bot is one 21.3 says "has no business consuming a pipeline
 * run or a human's attention".
 *
 * An untradable coin is a REFUSAL here rather than an empty candidate set. An
 * empty set is what the general entry point returns on a quiet day; returning
 * it for a coin the human explicitly named would answer a question they did not
 * ask, and would look identical to "nothing looks good right now".
 */
export async function selectNamedCandidate(
  ports: NamedCandidatePorts,
  request: SelectNamedCandidateRequest,
): Promise<CandidateSet> {
  const selectedAt = ports.now();
  const requestedBy = requireText(request.requestedBy, "requestedBy");
  const pair = requireText(request.pair, "pair");
  const account = await resolveAccount(ports.db, request.accountLabel);

  const refusal = await checkTradable(
    ports.listTradablePairs,
    account,
    pair,
    `Refusing rather than admitting it as a candidate -- a coin this account cannot ` +
      `trade cannot become a bot, so a proposal about it can only ever waste the ` +
      `human review it was written for.`,
    // Opted in. THIS is the path decision log 31 flagged: a human types a symbol
    // they saw on the venue's own listing, and `HYPEUSDCPERP` is on that listing.
    "reject-derivative-names",
  );
  if (refusal !== null) throw new CandidateSelectionError(refusal.code, refusal.message);

  const source: NamedCandidateSource = {
    kind: "named",
    requestedAs: request.pair,
    requestedBy,
    requestedAt: selectedAt,
  };

  return {
    entryPoint: "named",
    accountLabel: account.label,
    exchange: account.exchange,
    requestedBy,
    selectedAt,
    candidates: [
      { accountLabel: account.label, exchange: account.exchange, pair, sources: [source] },
    ],
    watchlist: null,
    trending: null,
  };
}

/**
 * Collect sources per pair, preserving first-seen order and MERGING duplicates.
 *
 * Shared by the watchlist and general doors rather than written twice, because
 * the merge rule is 21.5 requirement 2's ("which watchlist entry, or which
 * trending pull, and when") and a second copy of it is a second thing to drift.
 *
 * `order` is kept beside the map rather than relying on `Map` iteration order:
 * the ordering is a documented guarantee, and it should not rest on an
 * implementation detail of whatever key type a later change introduces.
 */
function sourceCollector() {
  const order: Pair[] = [];
  const sourcesByPair = new Map<Pair, CandidateSource[]>();

  return {
    contribute(pair: Pair, source: CandidateSource): void {
      const existing = sourcesByPair.get(pair);
      if (existing === undefined) {
        sourcesByPair.set(pair, [source]);
        order.push(pair);
        return;
      }
      existing.push(source);
    },
    candidates(account: VenueAccount): Candidate[] {
      return order.map((pair) => ({
        accountLabel: account.label,
        exchange: account.exchange,
        pair,
        sources: nonEmptySources(sourcesByPair.get(pair)),
      }));
    },
  };
}

/**
 * The operators' watchlist ALONE, as a candidate set, under its own name.
 *
 * ── WHY THIS EXISTS, AND WHY IT IS NOT A DEGRADED GENERAL RUN ──
 *
 * `selectGeneralCandidates` refuses to return a watchlist-only set when the
 * trending pull fails, and that refusal is correct and is untouched: 21.3 says
 * the trending source exists because "it is the only way the system can ever
 * surface something the operators did not already think to look for", so a
 * general run without it is not a smaller general run. What must not exist is a
 * general run that QUIETLY BECOMES one.
 *
 * This is the other half of that sentence, which the module header has named
 * since the general door was written: "An explicit watchlist-only entry point is
 * a thing an operator could be given later, ON PURPOSE and under its own name."
 * A caller reaches this by asking for it by name; nothing routes here as a
 * fallback, and no failure anywhere degrades into it. The set it returns says
 * `entryPoint: "watchlist"` and `trending: null`, so a reader cannot mistake one
 * for the other even with the set alone in front of them.
 *
 * ── THE DEVIATION FROM 21.2, STATED RATHER THAN BURIED ──
 *
 * 21.2 names two entry points. This is a third, and the justification is that
 * 21.2's own rule is that the doors "differ ONLY in how the candidate coin or
 * coins are chosen" -- which is exactly and only what this differs in. It
 * produces the same `CandidateSet`, holding the same `Candidate` shape, feeding
 * the identical downstream. There is no second prompt set, no second proposal
 * format and no second code path below this function.
 *
 * ── NO TRADABILITY RE-CHECK, deliberately ──
 *
 * Matching `selectGeneralCandidates`' treatment of the same entries exactly. A
 * watchlist pair was checked against the venue by `addToWatchlist` when it was
 * added and is not re-checked here; the staleness that creates is real, is the
 * gap steps 28 and 31 both recorded, and is NOT closed here, because closing it
 * changes what the watchlist means and that is a decision rather than a detail.
 * Re-checking in this door but not in the general one would be worse than
 * either: two doors disagreeing about the same rows.
 *
 * That is also why `WatchlistCandidatePorts` holds no `TradablePairSource` --
 * the guarantee is structural, not a promise made in a comment.
 */
export async function selectWatchlistCandidates(
  ports: WatchlistCandidatePorts,
  request: SelectWatchlistCandidatesRequest,
): Promise<CandidateSet> {
  const selectedAt = ports.now();
  const requestedBy = requireText(request.requestedBy, "requestedBy");
  const account = await resolveAccount(ports.db, request.accountLabel);

  const readAt = ports.now();
  const entries = await readWatchlist(ports.db, { accountLabel: account.label });

  const collector = sourceCollector();
  for (const entry of entries) {
    collector.contribute(entry.exchangePair, {
      kind: "watchlist",
      entryId: entry.id,
      note: entry.note,
      addedBy: entry.addedBy,
      addedAt: entry.addedAt,
    });
  }

  return {
    entryPoint: "watchlist",
    accountLabel: account.label,
    exchange: account.exchange,
    requestedBy,
    selectedAt,
    candidates: collector.candidates(account),
    watchlist: { readAt, entriesRead: entries.length },
    // Null rather than an empty report, and the distinction is the same one
    // `selectNamedCandidate` draws: a report of zero coins returned would claim
    // a pull that never happened.
    trending: null,
  };
}

/**
 * Normalise the quote assets a ticker may be paired against.
 *
 * Trimmed, upper-cased and deduplicated, so `["usd", "USD", " usd "]` costs one
 * catalogue comparison rather than three and the report says which one asset
 * was actually used.
 */
function normaliseQuoteAssets(quoteAssets: readonly string[]): string[] {
  const seen = new Set<string>();
  for (const raw of quoteAssets) {
    const quote = raw.trim().toUpperCase();
    if (quote !== "") seen.add(quote);
  }
  if (seen.size === 0) {
    throw new CandidateSelectionError(
      "missing_field",
      `quoteAssets must name at least one quote asset (e.g. ["USD"] on Gemini, ` +
        `["USDT"] on Binance). There is no default: which quote asset an account ` +
        `trades in is an operator's decision, and guessing it would silently drop ` +
        `every trending coin on the venue the guess was not written for.`,
    );
  }
  return [...seen];
}

/**
 * The pairs a trending ticker MIGHT be, for this venue to accept or reject.
 *
 * A trending vendor reports a coin ("bitcoin", "BTC"); a venue lists a pair
 * ("BTCUSD"). Nothing in this system maps between the two -- `SymbolListing`
 * carries pair strings with no base/quote split, and the only decomposition
 * available (`getSymbolFilters`) costs one exchange request PER PAIR, which is
 * a poor trade for filtering a list of fifteen.
 *
 * So a pair is CONSTRUCTED as a hypothesis and then checked against the real
 * catalogue. That ordering is what makes it safe: the concatenation is never
 * stored or trusted, and a hypothesis that passes `checkTradable` is by
 * definition the catalogue's own spelling, character for character. Step 28's
 * finding survives intact -- the comparison stays exact and case-sensitive, and
 * nothing is case-folded on the venue's side.
 *
 * The ticker IS upper-cased, and that is a different act from case-folding a
 * comparison: it turns a vendor's vocabulary into a candidate in this system's,
 * where `parseSymbolList` has upper-cased every venue's catalogue since step 3.
 * A vendor that reports "btc" would otherwise contribute nothing at all.
 *
 * CoinGecko, specifically, was observed returning UPPERCASE symbols in a real
 * response (decision log 31), so for that vendor the upper-casing is a no-op
 * and is NOT load-bearing. It stays because this port is vendor-neutral, no
 * vendor is chosen, and the normalisation costs nothing -- but nobody should
 * read it as a fact about CoinGecko that something depends on.
 *
 * WHAT IT WILL NOT CONSTRUCT, and that is load-bearing: a venue's PERPETUAL
 * pairs. Gemini's live catalogue carries `HYPEGUSDPERP` and `HYPEUSDCPERP`
 * while listing no spot `HYPEUSD`, and a trending "HYPE" correctly matches
 * none of them -- a perp is a different instrument, not a spelling variant,
 * and every order and PnL path in this system is spot. `checkTradable`'s
 * near-match is an exact case-insensitive equality rather than a prefix match,
 * so no perp is ever offered as "the venue's own spelling" either. Both facts
 * are INCIDENTAL -- nothing in this repository knows what a perpetual is --
 * and a test pins them. See decision log 31's flagged gap: the human-typed
 * paths have no such protection.
 *
 * THE ASSUMPTION, stated so it can be checked rather than discovered:
 * base-then-quote with no separator holds for both venues this system speaks to
 * (Gemini "BTCUSD", Binance "BTCUSDT"). It is NOT universal -- venues exist
 * that write "BTC-USD" -- and on such a venue every hypothesis would fail and
 * the trending pull would contribute nothing while erroring about nothing. That
 * is why `TrendingRejection.triedPairs` exists: the failure is legible in the
 * report as fifteen coins rejected with the pairs that were tried, rather than
 * as a quiet day.
 */
function pairHypotheses(symbol: string, quoteAssets: readonly string[]): Pair[] {
  const base = symbol.trim().toUpperCase();
  if (base === "") return [];
  return quoteAssets.map((quote) => `${base}${quote}`);
}

/**
 * The candidate list for "what looks good right now" (21.2's second entry
 * point, sourced per 21.3).
 *
 * Both of 21.3's sources feed ONE list: the operators' watchlist, and a live
 * trending pull filtered to pairs this account's venue will actually trade.
 * Watchlist entries come first and in `readWatchlist`'s stable order, then
 * trending coins in the vendor's own order -- deterministic, so two runs over
 * the same inputs are comparable, and human-chosen candidates lead.
 *
 * DEDUPLICATION MERGES, IT DOES NOT DROP. A coin on both sources appears once,
 * in its watchlist position, carrying both sources. See the module header.
 *
 * The order of the work is the one `addToWatchlist` and `fetchCandleWindow`
 * both use -- free checks first, network last: shape, then the registry read,
 * then the watchlist read (one D1 query), then the trending pull, and the
 * catalogue checks after that, where the cached listing makes them nearly free.
 */
export async function selectGeneralCandidates(
  ports: GeneralCandidatePorts,
  request: SelectGeneralCandidatesRequest,
): Promise<CandidateSet> {
  const selectedAt = ports.now();
  const requestedBy = requireText(request.requestedBy, "requestedBy");
  const quoteAssets = normaliseQuoteAssets(request.quoteAssets);
  const account = await resolveAccount(ports.db, request.accountLabel);

  const readAt = ports.now();
  const entries = await readWatchlist(ports.db, { accountLabel: account.label });

  const outcome = await ports.fetchTrending();
  if (!outcome.ok) {
    throw new CandidateSelectionError(
      "trending_unavailable",
      `the trending pull failed (${outcome.kind}): ${outcome.message}. Refusing to ` +
        `return a watchlist-only candidate set: 21.3 says the trending source exists ` +
        `because "it is the only way the system can ever surface something the ` +
        `operators did not already think to look for", so a general run without it is ` +
        `not a smaller general run -- it is a re-read of a list someone already wrote. ` +
        `${entries.length} watchlist entries were read and are discarded with this ` +
        `refusal rather than presented as a complete candidate set (21.5 requirement 6).`,
    );
  }

  // Insertion-ordered and merging, so "which pair came first" and "and from
  // where" stay two separate answers. Shared with the watchlist door, which
  // collects the identical entries the identical way.
  const collector = sourceCollector();
  const contribute = collector.contribute;

  for (const entry of entries) {
    contribute(entry.exchangePair, {
      kind: "watchlist",
      entryId: entry.id,
      note: entry.note,
      addedBy: entry.addedBy,
      addedAt: entry.addedAt,
    });
  }

  const pullId = ports.newId();
  const pull = outcome.value;
  const rejected: TrendingRejection[] = [];
  let accepted = 0;
  let pairsMatched = 0;

  for (const coin of pull.coins) {
    const tried = pairHypotheses(coin.symbol, quoteAssets);
    if (tried.length === 0) {
      rejected.push({
        coinId: coin.coinId,
        symbol: coin.symbol,
        name: coin.name,
        rank: coin.rank,
        triedPairs: [],
        reason: "unusable_symbol",
      });
      continue;
    }

    let matched = false;
    for (const pair of tried) {
      const refusal = await checkTradable(
        ports.listTradablePairs,
        account,
        pair,
        `Refusing the whole selection rather than recording this coin as untradable -- ` +
          `"could not check" is not "checked and not listed", and a rejection list that ` +
          `cannot tell them apart is a false record of what this venue offers.`,
        // Opted in although it is INERT here, and deliberately so: `${BASE}${QUOTE}`
        // cannot construct a `PERP` suffix, so this path was already structurally
        // safe (log 31). Opting out would make the four research paths differ on a
        // risk check for a reason that is true today and true by accident.
        "reject-derivative-names",
      );
      if (refusal === null) {
        matched = true;
        pairsMatched += 1;
        contribute(pair, {
          kind: "trending",
          pullId,
          vendor: pull.vendor,
          fetchedAt: outcome.at,
          coinId: coin.coinId,
          symbol: coin.symbol,
          name: coin.name,
          rank: coin.rank,
          raw: coin.raw,
        });
        continue;
      }
      // An UNREADABLE catalogue aborts the run; an ABSENT pair is just this
      // quote asset not being the one. Collapsing the two would let an exchange
      // outage report fifteen coins as untradable, which is the shape of a
      // wrong answer that looks exactly like a right one (section 5.6).
      if (refusal.code === "tradable_set_unreadable") {
        throw new CandidateSelectionError(refusal.code, refusal.message);
      }
    }

    if (matched) {
      accepted += 1;
    } else {
      rejected.push({
        coinId: coin.coinId,
        symbol: coin.symbol,
        name: coin.name,
        rank: coin.rank,
        triedPairs: tried,
        reason: "not_tradable",
      });
    }
  }

  return {
    entryPoint: "general",
    accountLabel: account.label,
    exchange: account.exchange,
    requestedBy,
    selectedAt,
    candidates: collector.candidates(account),
    watchlist: { readAt, entriesRead: entries.length },
    trending: {
      pullId,
      vendor: pull.vendor,
      fetchedAt: outcome.at,
      quoteAssets,
      returned: pull.coins.length,
      accepted,
      pairsMatched,
      rejected,
    },
  };
}

/**
 * Narrow a source list to the non-empty tuple `Candidate` requires.
 *
 * The throw is unreachable by construction -- a pair only enters `order` at the
 * moment its first source is recorded -- and is written rather than cast so
 * that a future change which breaks that invariant fails loudly instead of
 * producing a candidate with no provenance, which is the one thing 21.5
 * requirement 2 forbids outright.
 */
function nonEmptySources(
  sources: CandidateSource[] | undefined,
): readonly [CandidateSource, ...CandidateSource[]] {
  const [first, ...rest] = sources ?? [];
  if (first === undefined) {
    throw new CandidateSelectionError(
      "missing_field",
      `a candidate was assembled with no source, which 21.5 requirement 2 makes ` +
        `unproposable. This is a bug in candidate assembly, not a condition a caller ` +
        `can reach.`,
    );
  }
  return [first, ...rest];
}
