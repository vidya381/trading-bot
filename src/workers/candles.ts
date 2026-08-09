/**
 * The real, account-scoped route to `getCandles` (spec 21.4, Stage 1).
 *
 * `symbols.ts` one file over does this for `listTradablePairs`; this is the
 * same shape for candles, and exists for the same reason. Until now the only
 * way to reach `getCandles` was through a client someone else had already
 * built -- in practice a bot instance's attached client -- which made "fetch
 * candles for a pair" mean "fetch candles for a pair that already has a bot".
 * 21.4's Gather stage is the opposite case: a candidate coin has no bot, by
 * definition, because deciding whether it should get one is the point.
 *
 * So this resolves a client from the account registry entry alone, through
 * `clientForAccount` -- the same function `envSymbolLister` uses, which is the
 * same function the watchlist's tradability check reaches through. One
 * resolution path, three callers.
 *
 * ── NOT CACHED, unlike the symbol listing ──
 *
 * Deliberate, and the asymmetry is the point. A tradable set changes when a
 * venue lists or delists a coin, so an hour-old copy is nearly always right and
 * the cache buys a dropdown that does not spend a full-catalogue request per
 * page load. Candles are the opposite: their entire value is that they are
 * current, and 21.5's staleness requirement times a proposal from "when its
 * underlying data was fetched". A cache here would make that timestamp a lie
 * that looks exactly like the truth.
 *
 * ── What this does NOT do ──
 *
 * No tradability gate, no truncation reporting, no fail-closed policy. Those
 * are `research/candles.ts`'s, which is where the decisions live; this is the
 * transport, exactly as `envSymbolLister` is transport for the watchlist's
 * check. Nothing here interprets the result.
 */

import type { ExchangeOutcome } from "../shared/downtime";
import type { Candle, CandleInterval, Pair, Timestamp } from "../shared/exchange-client";
import type { ExchangeId } from "../db/schema";
import { clientForAccount } from "./exchange-dispatch";

/**
 * What to ask the venue for: the three arguments `RestExchangeClient.getCandles`
 * takes, as an object so the account/env/clock parameters around them stay
 * readable.
 *
 * `since` carries the interface's own contract unchanged -- it asks for candles
 * whose close time is AFTER it, and it is BEST-EFFORT, bounded by the window
 * the venue's endpoint returns. On Gemini that bound is the whole story: its
 * `/v2/candles` takes no time-range parameter at all, so the client fetches a
 * fixed recent window and filters locally. Measuring what that actually
 * returned is `research/candles.ts`'s job, not this one's.
 */
export interface CandleQuery {
  readonly pair: Pair;
  readonly interval: CandleInterval;
  readonly since?: Timestamp;
}

/**
 * The port that actually reaches an exchange for an account's candles.
 *
 * Injected so callers exercise their own logic without a network call -- the
 * same reason `SymbolLister` is a port. `envCandleLister` is the real one.
 */
export type CandleLister = (
  account: { readonly label: string; readonly exchange: ExchangeId },
  query: CandleQuery,
  env: Env,
  now: () => Timestamp,
) => Promise<ExchangeOutcome<Candle[]>>;

/**
 * The real lister: get the account's client, call `getCandles`.
 *
 * A client-resolution failure comes back as `clientForAccount`'s own
 * `exchange_error` outcome, so the caller has ONE failure shape covering both
 * "no client could be built for this account" and "the venue call failed" --
 * and, per section 5.6, no way to mistake either for candles that did not move.
 */
export const envCandleLister: CandleLister = async (account, query, env, now) => {
  const client = clientForAccount(account, env, now);
  if (!client.ok) return client;
  return client.value.getCandles(query.pair, query.interval, query.since);
};
