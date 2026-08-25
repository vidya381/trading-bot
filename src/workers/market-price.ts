/**
 * A single spot price for one pair, for a bot that is NOT receiving prices.
 *
 * ── WHY THIS EXISTS AT ALL ──
 *
 * A bot's `state.lastPrice` is written in exactly one place
 * (`#onPriceUpdatePass`), behind a `status === "running"` guard, from its own
 * price-feed subscription. A halted bot has unsubscribed, so its price is frozen
 * at the instant it halted. That is DELIBERATE, DOCUMENTED DESIGN -- "a halted
 * bot's clock is frozen BY DESIGN" (`#checkPriceFreshness`) -- and nothing here
 * changes it.
 *
 * What the frozen price cannot answer is the question an operator actually has
 * in front of a halted bot: *where is the market right now, and should I
 * resume?* Today that means leaving the dashboard for an exchange. This answers
 * it in place.
 *
 * ── WHY A PERIODIC FETCH AND NOT A SUBSCRIPTION ──
 *
 * Keeping a halted bot subscribed would pin its pair's `PriceFeed` Durable
 * Object and its outbound socket alive indefinitely (that object cannot
 * hibernate while connected), for a bot that is not trading. This is one
 * unsigned public REST read, made only while a human is looking at that bot.
 *
 * ── THE ONE THING THIS MUST NEVER BECOME ──
 *
 * A trading input. The value never enters `BotRuntimeState`, never reaches
 * Durable Object storage, and never touches `lastPrice` or anything
 * `unrealizedPnl` or the grid ladder reads. It is assembled in the API layer,
 * per request, and travels no further than the screen.
 * `market-price-isolation.test.ts` pins that structurally rather than trusting
 * this paragraph.
 */

import { clientForAccount } from "./exchange-dispatch";
import type { ExchangeId } from "../db/schema";
import type { ExchangeOutcome } from "../shared/downtime";
import type { Pair, Price, Timestamp } from "../shared/exchange-client";

/**
 * The port shape, for the reason `CandleLister` and `SymbolLister` are ports:
 * **no test in this repository may fall through to a live venue call.** The
 * default is the real one; every test supplies a stub.
 */
export type MarketPriceLister = (
  account: { readonly label: string; readonly exchange: ExchangeId },
  pair: Pair,
  env: Env,
  now: () => Timestamp,
) => Promise<ExchangeOutcome<Price>>;

/**
 * The real lister: resolve the account's client, ask for the spot price.
 *
 * `getCurrentPrice` is UNSIGNED PUBLIC data on both venues -- Gemini's
 * `/v1/pubticker/{symbol}` and Binance's `/api/v3/ticker/price` -- so this needs
 * no credentials beyond whatever `clientForAccount` already resolves.
 *
 * A client-resolution failure comes back as `clientForAccount`'s own
 * `exchange_error` outcome, so the caller has ONE failure shape for both "no
 * client could be built" and "the venue call failed" -- and, per section 5.6,
 * no way to mistake either for a price.
 */
export const envMarketPriceLister: MarketPriceLister = async (account, pair, env, now) => {
  const client = clientForAccount(account, env, now);
  if (!client.ok) return client;
  return await client.value.getCurrentPrice(pair);
};
