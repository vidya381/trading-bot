/**
 * Candles for ANY listed, tradable pair on an account (spec 21.4, Stage 1).
 *
 * Section 21 as a whole is still PLANNED, NOT YET BUILT -- no pipeline, no
 * prompt, no proposal record, no model call, no candidate selection, no news
 * fetch. This module is one more piece of its groundwork and nothing else: the
 * scoping limit 21.4 names on the very first bullet of Stage 1, removed.
 *
 * ── The limit this removes, precisely ──
 *
 * `getCandles` is a method on `RestExchangeClient`. Reaching it therefore means
 * holding a client, and until now every route to one ran through something that
 * already had a bot: the exchange attachment a `BotInstance` builds for the pair
 * it trades. 21.4 says the extension is needed "to work for ANY exchange-listed
 * pair on demand, not only pairs that already have a bot attached", and the
 * reason is structural rather than convenient -- a candidate coin has no bot BY
 * DEFINITION, because whether it should get one is the question the pipeline
 * exists to answer.
 *
 * What this adds is therefore not a new way to talk to a venue. It is an
 * account-scoped entry point that resolves a client the way the no-bot callers
 * already do (`clientForAccount`, shared with `envSymbolLister` and so with the
 * watchlist's tradability check), gates on the same tradable set the watchlist
 * gates on (`checkTradable`), and then calls the same `getCandles`.
 *
 * ── The limit this does NOT remove, and reports instead (21.7 open question 1) ──
 *
 * Gemini's `/v2/candles` takes NO time-range parameter. It returns a fixed
 * recent window, and the Gemini client honours `since` by filtering that window
 * locally, so it CANNOT reach candles older than the window covers. Extending
 * the reach to arbitrary pairs removes a SCOPING limit; the DEPTH limit is
 * untouched and is not worked around here -- no second data source, no stitched
 * history, no retry at a wider interval hoping for more.
 *
 * It is made OBSERVABLE instead. 21.7 states the consequence in one line: "the
 * Assess stage must be told how much history it actually received and must not
 * reason as though it had more." So `CandleWindow` reports the earliest candle
 * actually returned, and an explicit `truncated` flag with the size of the
 * shortfall whenever the requested range was not fully covered. A caller that
 * ignores those fields is choosing to; a caller that reads them cannot mistake
 * four hours of history for four days.
 *
 * ── Fail closed, in five places (21.5 requirement 6) ──
 *
 *   * the interval is not verified on a venue -> `interval_not_verified`
 *   * the account is not in the registry      -> `unknown_account`
 *   * the venue does not list the pair        -> `pair_not_tradable`
 *   * the tradable set could not be READ      -> `tradable_set_unreadable`
 *   * the candle call failed                  -> `candles_unavailable`
 *   * the call succeeded with nothing in it   -> `no_candles_returned`
 *
 * Every one of them throws. None returns an empty array, a partial window, or a
 * synthesized candle, because 21.5 forbids exactly that: "never fall back to
 * fewer candles and not say so". An empty array is the specific shape that
 * failure would take here -- it survives every type check, it flows into an
 * average or a volatility figure as though it meant something, and by the time
 * it reaches a human it is indistinguishable from a coin that simply did not
 * trade. Section 5.6's rule, one layer out: "could not reach the exchange" is
 * never a price that did not move.
 */

import type { Database } from "../db";
import type { ExchangeId } from "../db/schema";
import type { ExchangeOutcome } from "../shared/downtime";
import type { Candle, CandleInterval, Pair, Timestamp } from "../shared/exchange-client";
import type { CandleQuery } from "../workers/candles";
import { checkTradable, type TradablePairSource, type VenueAccount } from "./tradability";

/**
 * How this module reaches an account's candles.
 *
 * A port, for the same reason `TradablePairSource` is one: every test below
 * drives an injected client and nothing here has ever spoken to a venue. In
 * production this is `(account, query) => envCandleLister(account, query, env,
 * now)`.
 */
export type CandleSource = (
  account: VenueAccount,
  query: CandleQuery,
) => Promise<ExchangeOutcome<Candle[]>>;

export interface CandleWindowPorts {
  /** The account registry. The exchange comes from here, never from a caller. */
  readonly db: Database;
  readonly listTradablePairs: TradablePairSource;
  readonly getCandles: CandleSource;
}

/**
 * The intervals this system has actually verified against a real venue.
 *
 * `CandleInterval` declares all seven both exchanges nominally support, and its
 * own docblock is explicit about what that declaration is worth: "only '1m' is
 * exercised and verified in v1 ... The wider intervals are the declared
 * extension surface for section 13's backtest, and each MUST BE VERIFIED PER
 * EXCHANGE BEFORE FIRST USE."
 *
 * That sentence has been a comment since step 14 and nothing enforced it. Here
 * it has to be enforced, because 21.4 Stage 2 hands whatever comes back to a
 * model that will reason about volatility and trend from it. An unverified
 * interval fails in the worst available way: each venue spells these
 * differently (Gemini writes "1hr"/"6hr"/"1day"), so a wrong mapping does not
 * error -- it returns candles of a DIFFERENT duration, correctly shaped, which
 * every type check passes and no downstream reader can distinguish. A proposal
 * derived from six-hour candles believed to be one-hour candles is exactly the
 * "degraded proposal indistinguishable from a good one at a glance" 21.5
 * requirement 6 exists to prevent.
 *
 * So the refusal is hard, not a warning, and it is checked FIRST -- before the
 * registry read and before the tradability call, since it needs no I/O at all
 * to answer. The same "free checks first, exchange call last" ordering
 * `addToWatchlist` uses.
 *
 * WIDENING IT is this array plus the pin in `candles.test.ts` that asserts its
 * current contents, and neither is the hard part: an interval belongs here only
 * once someone has actually read that venue's candles at that timeframe and
 * confirmed the duration is what it claims. The pin exists so that widening
 * cannot happen as a silent one-character edit.
 */
export const VERIFIED_INTERVALS: readonly CandleInterval[] = ["1m"];

export type CandleWindowErrorCode =
  /** The interval is real but unverified on this system's venues. */
  | "interval_not_verified"
  /** No such row in `accounts`, so there is no venue to ask. */
  | "unknown_account"
  /** The account's venue does not list this pair. */
  | "pair_not_tradable"
  /** The tradable set could not be read, so tradability is unknown. */
  | "tradable_set_unreadable"
  /** The candle call failed: transport, exchange error, or rate limit. */
  | "candles_unavailable"
  /** The call succeeded and returned nothing. See the header. */
  | "no_candles_returned";

export class CandleWindowError extends Error {
  readonly code: CandleWindowErrorCode;
  constructor(code: CandleWindowErrorCode, message: string) {
    super(message);
    this.name = "CandleWindowError";
    this.code = code;
  }
}

export interface FetchCandleWindowRequest {
  /** A registered account label. Its exchange is read from the registry. */
  readonly accountLabel: string;
  /** The venue's own symbol, exactly as `listTradablePairs` reports it. */
  readonly pair: Pair;
  readonly interval: CandleInterval;
  /**
   * The oldest close time wanted, if any. Best-effort by the interface's own
   * contract; how well it was actually met is what `truncated` reports.
   */
  readonly since?: Timestamp;
}

/**
 * Candles, plus an honest account of how much history they actually are.
 *
 * The `candles` array is EXACTLY what `getCandles` returned -- oldest-first,
 * in-progress candle included when the venue sent one, no filtering of this
 * module's own. Everything else here describes that array rather than altering
 * it, so a caller that only wants candles is not made to unwrap anything, and a
 * caller that needs to know what it is missing does not have to re-derive it
 * from timestamps it may not think to check.
 *
 * NOTE ON `truncated` WHEN NOTHING WAS REQUESTED. With no `since`, the caller
 * asked for "the recent window" and got the recent window, so `truncated` is
 * false and `missingHistoryMs` is null. That is not a claim that the window is
 * deep -- there is simply no requested range for it to fall short of.
 * `earliestCloseTime` is the field that answers "how far back does this go",
 * and it is populated in every case.
 */
export interface CandleWindow {
  readonly accountLabel: string;
  readonly exchange: ExchangeId;
  readonly pair: Pair;
  readonly interval: CandleInterval;
  /** Oldest-first, exactly as the client returned them. Never empty. */
  readonly candles: Candle[];
  /** When the venue answered -- 21.5's fetch time, not a render time. */
  readonly fetchedAt: Timestamp;
  /** What was asked for, echoed so a stored window is self-describing. */
  readonly requestedSince: Timestamp | null;
  /** The open time of the oldest candle actually returned. */
  readonly earliestOpenTime: Timestamp;
  /** The close time of the oldest candle actually returned. */
  readonly earliestCloseTime: Timestamp;
  /** The close time of the newest candle actually returned. */
  readonly latestCloseTime: Timestamp;
  /**
   * Whether the requested range was NOT fully covered -- 21.7's constraint,
   * surfaced rather than worked around.
   */
  readonly truncated: boolean;
  /**
   * How much of the requested range is missing off the front, in ms; null when
   * nothing is missing or nothing was requested.
   */
  readonly missingHistoryMs: number | null;
}

/**
 * Fetch a candle window for any tradable pair on a registered account.
 *
 * The order of the checks is deliberate and matches `addToWatchlist`'s: the
 * interval gate first (pure, no I/O), then the registry lookup (one D1 read),
 * then tradability (a cached listing, usually free), and the candle request
 * LAST, so an unverified interval, an unknown account or an untradable pair
 * spends no venue request and no rate-limit budget on a question that was
 * already answered.
 *
 * The exchange is taken from the `accounts` row and never from the request --
 * the same derivation `createBot` and the watchlist endpoints use, and for the
 * reason step 11 gave: letting a caller name the venue lets them choose which
 * catalogue their pair is validated against, which is a validation that
 * validates nothing.
 */
export async function fetchCandleWindow(
  ports: CandleWindowPorts,
  request: FetchCandleWindowRequest,
): Promise<CandleWindow> {
  if (!VERIFIED_INTERVALS.includes(request.interval)) {
    throw new CandleWindowError(
      "interval_not_verified",
      `the ${JSON.stringify(request.interval)} candle interval is declared but has not ` +
        `been verified against a real venue, so it must not feed a proposal. Verified: ` +
        `${VERIFIED_INTERVALS.map((i) => JSON.stringify(i)).join(", ")}. Each venue spells ` +
        `the wider intervals differently (Gemini writes "1hr"/"6hr"/"1day"), so a wrong ` +
        `mapping returns correctly-shaped candles of the WRONG duration rather than an ` +
        `error -- which nothing downstream can detect. Verify the interval against that ` +
        `venue first, then add it to VERIFIED_INTERVALS.`,
    );
  }

  const row = await ports.db.accounts.findOne({ account_label: request.accountLabel });
  if (row === null) {
    throw new CandleWindowError(
      "unknown_account",
      `no registered account ${JSON.stringify(request.accountLabel)}, so there is no ` +
        `venue to ask for ${JSON.stringify(request.pair)} candles`,
    );
  }
  const account: VenueAccount = { label: request.accountLabel, exchange: row.exchange };

  const refusal = await checkTradable(
    ports.listTradablePairs,
    account,
    request.pair,
    `Refusing rather than fetching candles for a symbol nothing validated -- an ` +
      `unlisted symbol either errors at the venue or returns a window for a pair ` +
      `this account cannot trade, and the second is worse.`,
  );
  if (refusal !== null) throw new CandleWindowError(refusal.code, refusal.message);

  const query: CandleQuery = {
    pair: request.pair,
    interval: request.interval,
    ...(request.since === undefined ? {} : { since: request.since }),
  };
  const outcome = await ports.getCandles(account, query);
  if (!outcome.ok) {
    throw new CandleWindowError(
      "candles_unavailable",
      `could not fetch ${request.interval} candles for ${JSON.stringify(request.pair)} on ` +
        `${account.exchange} (account ${JSON.stringify(account.label)}): ${outcome.kind} -- ` +
        `${outcome.message}. Refusing rather than returning an empty window: a failed ` +
        `fetch and a coin that did not trade are not the same fact (section 5.6).`,
    );
  }

  const candles = outcome.value;
  const earliest = candles[0];
  const latest = candles[candles.length - 1];
  if (earliest === undefined || latest === undefined) {
    throw new CandleWindowError(
      "no_candles_returned",
      `${account.exchange} returned no ${request.interval} candles at all for ` +
        `${JSON.stringify(request.pair)} (account ${JSON.stringify(account.label)})` +
        (request.since === undefined ? "" : ` since ${request.since}`) +
        `. The pair is listed, so an empty window is a fact about the request or the ` +
        `venue, not price history -- reported rather than passed on as zero candles.`,
    );
  }

  // TRUNCATION, measured against the client's own `since` contract rather than
  // guessed at. `getCandles` promises candles whose close time is AFTER
  // `since`, so the oldest candle a fully-satisfied request can return is the
  // one still open at that instant -- its open time is at or before `since`.
  // An open time strictly AFTER `since` therefore means the venue's window
  // began later than asked and the history in front of it is simply not
  // obtainable through this endpoint (21.7). Derived from the returned data,
  // not from the interval's length, so it holds for every interval and for a
  // venue that trims its window without telling anyone.
  //
  // `truncated` is DERIVED from the shortfall rather than computed beside it,
  // so the flag and the figure cannot disagree -- a `truncated: true` carrying
  // a null shortfall is the exact shape of a report that looks honest and says
  // nothing. The shortfall is strictly positive whenever it is set, so the two
  // are the same fact stated twice for the two ways a caller will read it.
  const requestedSince = request.since ?? null;
  const missingHistoryMs =
    requestedSince !== null && earliest.openTime > requestedSince
      ? earliest.openTime - requestedSince
      : null;
  const truncated = missingHistoryMs !== null;

  return {
    accountLabel: account.label,
    exchange: account.exchange,
    pair: request.pair,
    interval: request.interval,
    candles,
    fetchedAt: outcome.at,
    requestedSince,
    earliestOpenTime: earliest.openTime,
    earliestCloseTime: earliest.closeTime,
    latestCloseTime: latest.closeTime,
    truncated,
    missingHistoryMs,
  };
}
