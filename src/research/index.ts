/**
 * Groundwork for spec section 21's LLM-assisted research pipeline.
 *
 * Section 21 is PLANNED, NOT YET BUILT, and that is still true: there is no
 * pipeline, no prompt, no proposal record and no Workers AI call anywhere in
 * this folder. What exists is the storage for 21.3's fixed watchlist -- the
 * deliberate, human-chosen half of candidate selection -- the read path a later
 * stage will consume, 21.4 Stage 1's candle fetch for arbitrary tradable pairs,
 * 21.4 Stage 1's news-and-sentiment fetch, and 21.2/21.3's candidate selection
 * for both entry points, 21.4 Stage 1's over-concentration FLAG, and the
 * assembly that collects those inputs into one bundle per candidate.
 *
 * The assembly (`gather.ts`) reads nothing new. It returns an HONEST PARTIAL
 * bundle: each input's real success or failure is recorded on its own slot, and
 * one input's failure never removes another's result. Whether a bundle is fit to
 * show a human is Stage 4's judgement and is NOT made here.
 *
 * The news slot in every bundle is `NEWS_NOT_YET_AVAILABLE` -- a deliberate
 * paused state, never a failed fetch. See decision log 30.
 *
 * The concentration check is a flag for a human, never a filter: it reads
 * `bot_instances` and states what an account already holds. Its two thresholds
 * are POLICY CHOICES verified against nothing -- see
 * `DEFAULT_CONCENTRATION_POLICY` before quoting either number.
 *
 * The news fetch's wire format is ASSUMED, not verified: nothing here has ever
 * called CoinDesk and this project holds no key for it. See `news.ts`'s header
 * before relying on any of it.
 *
 * The trending pull, 21.3's other source, has a PORT (`TrendingSource`) and no
 * vendor: no trending API has been chosen, no client exists, and nothing here
 * has ever called one. It also must never be added as a writer of the watchlist
 * table -- see `watchlist.ts`'s header for why that separation is structural
 * rather than stylistic, and `candidates.ts`'s for how the two sources are
 * merged at read time without losing which is which.
 */

export {
  selectGeneralCandidates,
  selectNamedCandidate,
  selectWatchlistCandidates,
  CandidateSelectionError,
  type Candidate,
  type CandidateEntryPoint,
  type CandidateSelectionErrorCode,
  type CandidateSet,
  type CandidateSource,
  type GeneralCandidatePorts,
  type NamedCandidatePorts,
  type NamedCandidateSource,
  type SelectGeneralCandidatesRequest,
  type SelectNamedCandidateRequest,
  type SelectWatchlistCandidatesRequest,
  type WatchlistCandidatePorts,
  type TrendingCandidateSource,
  type TrendingCoin,
  type TrendingPull,
  type TrendingPullReport,
  type TrendingRejection,
  type TrendingRejectionReason,
  type TrendingSource,
  type WatchlistCandidateSource,
  type WatchlistReadReport,
} from "./candidates";

export {
  assessCandidateSetConcentration,
  assessConcentration,
  checkCandidateConcentration,
  readAccountExposure,
  ConcentrationError,
  DEFAULT_CONCENTRATION_POLICY,
  type AccountExposure,
  type AssessConcentrationOptions,
  type AssetConcentrationFacts,
  type AssetSignalBasis,
  type BaseAssetResolution,
  type CandidateSetConcentration,
  type ConcentrationErrorCode,
  type ConcentrationFacts,
  type ConcentrationFlag,
  type ConcentrationFlagCode,
  type ConcentrationPolicy,
  type ConcentrationPorts,
  type ConcentrationResult,
  type ExposureBot,
  type PairHolding,
} from "./concentration";

export {
  gatherCandidateData,
  gatherCandidateSetData,
  NEWS_NOT_YET_AVAILABLE,
  type CandidateGatherBundle,
  type CandidateSetGatherBundle,
  type CandleInput,
  type ConcentrationInput,
  type ExposureInput,
  type GatherPorts,
  type GatherRequest,
  type GatheredInput,
  type NewsInput,
  type NewsNotYetAvailable,
} from "./gather";

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
  checkSpotInstrument,
  type DerivativeNamePolicy,
  type InstrumentRefusal,
  type InstrumentRefusalCode,
  type SymbolDetailSource,
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
