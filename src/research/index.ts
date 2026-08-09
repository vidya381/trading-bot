/**
 * Groundwork for spec section 21's LLM-assisted research pipeline.
 *
 * Section 21 is PLANNED, NOT YET BUILT, and that is still true: there is no
 * pipeline, no prompt, no proposal record and no Workers AI call anywhere in
 * this folder. What exists is the storage for 21.3's fixed watchlist -- the
 * deliberate, human-chosen half of candidate selection -- the read path a later
 * stage will consume, 21.4 Stage 1's candle fetch for arbitrary tradable pairs,
 * and 21.4 Stage 1's news-and-sentiment fetch.
 *
 * The news fetch's wire format is ASSUMED, not verified: nothing here has ever
 * called CoinDesk and this project holds no key for it. See `news.ts`'s header
 * before relying on any of it.
 *
 * The trending pull, 21.3's other source, is not here and must not be added
 * here as a writer of the same table. See `watchlist.ts`'s header for why the
 * separation is structural rather than stylistic.
 */

export {
  fetchCandleWindow,
  CandleWindowError,
  type CandleSource,
  type CandleWindow,
  type CandleWindowErrorCode,
  type CandleWindowPorts,
  type FetchCandleWindowRequest,
} from "./candles";

export {
  fetchNewsSentiment,
  NewsSentimentError,
  COINDESK_WIRE_FIELDS,
  DEFAULT_ARTICLE_LIMIT,
  MAX_ARTICLES,
  type CoveredNewsSentiment,
  type FetchNewsSentimentRequest,
  type NewsArticle,
  type NewsSentimentErrorCode,
  type NewsSentimentPorts,
  type NewsSentimentResult,
  type NewsSource,
  type QuietNewsSentiment,
  type SentimentCounts,
  type SentimentLabel,
  type UncoveredNewsSentiment,
} from "./news";

export {
  checkTradable,
  type TradabilityRefusal,
  type TradabilityRefusalCode,
  type VenueAccount,
} from "./tradability";

export {
  addToWatchlist,
  readWatchlist,
  removeFromWatchlist,
  watchlistSize,
  WatchlistError,
  WATCHLIST_MAX_ENTRIES,
  type AddToWatchlistRequest,
  type RemoveFromWatchlistRequest,
  type TradablePairSource,
  type WatchlistAccount,
  type WatchlistEntry,
  type WatchlistErrorCode,
  type WatchlistPorts,
} from "./watchlist";
