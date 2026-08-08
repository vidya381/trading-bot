/**
 * Groundwork for spec section 21's LLM-assisted research pipeline.
 *
 * Section 21 is PLANNED, NOT YET BUILT, and that is still true: there is no
 * pipeline, no prompt, no proposal record, no Workers AI call and no endpoint
 * anywhere in this folder. What exists is the storage for 21.3's fixed
 * watchlist -- the deliberate, human-chosen half of candidate selection -- and
 * the read path a later stage will consume.
 *
 * The trending pull, 21.3's other source, is not here and must not be added
 * here as a writer of the same table. See `watchlist.ts`'s header for why the
 * separation is structural rather than stylistic.
 */

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
