/**
 * The Kraken implementation of the exchange interface (spec section 4, decision
 * log entry 90 step (c), entry 92 PART 8 item 1).
 *
 * The THIRD `RestExchangeClient`. Structurally it follows `GeminiClient` rather
 * than `BinanceClient`, and that is a finding of entry 90 rather than a
 * preference: Kraken authenticates with a monotonic nonce (so section 4.2's
 * `ClockOffset` machinery has no role), every private call is a POST, and there
 * is no signed query string anywhere. Where Gemini's client would be the wrong
 * template, this file says so at the method.
 *
 * It ties together the four files that already exist and DUPLICATES NOTHING
 * FROM THEM:
 *
 *  - `signing.ts`   builds and signs every private body (`signedRequest`), and
 *                   owns the nonce.
 *  - `catalogue.ts` answers every "what is this pair/asset called" question.
 *                   NOTHING HERE TRANSFORMS A NAME WITH A STRING RULE -- entry
 *                   90 PROBLEM 1 -- so `toGeminiSymbol`'s one-line analogue does
 *                   not exist and must not be written.
 *  - `filters.ts`   builds `SymbolFilters` from the catalogue's own AssetPairs
 *                   entry, and re-exports the shared `validateOrder`.
 *  - `parse.ts`     reads every payload, and classifies every error string.
 *
 * ── THE FOUR THINGS THIS CLIENT DOES DIFFERENTLY FROM BOTH OTHERS ──
 *
 * 1. THE ERROR ARRAY IS CHECKED BEFORE THE HTTP STATUS, because on Kraken the
 *    status is 200 for a bad key, an unknown pair and a throttle alike (entry 90
 *    PROBLEM 3, live). `#request` therefore reads the envelope FIRST and only
 *    falls back to `classifyStatus` when the body is not a Kraken envelope at
 *    all -- which means an edge or proxy failure that never reached Kraken's
 *    application layer, the one case where a status genuinely carries the
 *    information. `GeminiClient` inverts this order, correctly for Gemini.
 *
 * 2. THERE IS A CATALOGUE FETCH BEHIND ALMOST EVERY METHOD. Neither existing
 *    venue needs one. `/0/public/AssetPairs` and `/0/public/Assets` are fetched
 *    together, cached for an hour by `KrakenCatalogueCache`, and every name in
 *    every request and reply is resolved through the result.
 *
 * 3. `cancelOrder` IS A CANCEL PLUS EXACTLY ONE READ (entry 90 DECISION 2).
 *    Kraken's `CancelOrder` answers `{count, pending}` and nothing else, so the
 *    filled quantity the interface promises has to be read back. It is read
 *    ONCE, never in a loop, and what that one read saw is reported honestly --
 *    including when it saw nothing.
 *
 * 4. `oflags=fciq` IS SENT ON EVERY ORDER (entry 90 DECISION 4), so
 *    `feeAssetFor`'s asserted branch is the one that fires and `Fill.feeAsset`
 *    is a fact the request established rather than a chain of inference.
 *
 * ── WHAT THIS FILE DELIBERATELY DOES NOT DO ──
 *
 * RATE LIMITING. `KRAKEN_REQUEST_COSTS` below counts the requests these methods
 * send and is explicitly NOT Kraken's cost model; see its docblock. Entry 90
 * PROBLEM 2 and PART 6 step (d) make the real model its own build session, and
 * this file does not pre-empt it.
 *
 * RETRYING, and GATING, for the reasons both existing clients record: `withRetry`
 * takes an operation of exactly this shape and the call site composes it (never
 * around `placeOrder`), and `RateLimitedExchange` is the gate.
 *
 * As on both other venues, every method resolves to an `ExchangeOutcome` and
 * nothing here throws on a failed request.
 */

import type { ExchangeOutcome } from "../../shared/downtime";
import { classifyStatus, classifyThrown, ok } from "../../shared/downtime";
import type {
  Balance,
  Candle,
  CandleInterval,
  OrderRequest,
  OrderResult,
  OrderStatus,
  Pair,
  Price,
  RestExchangeClient,
  SymbolFilters,
  Timestamp,
} from "../../shared/exchange-client";
import { toTrimmedString } from "../../shared/money";
import type { CredentialProvider } from "../credentials";
import {
  buildKrakenCatalogue,
  KrakenCatalogueCache,
  type KrakenCatalogue,
  type KrakenPair,
} from "./catalogue";
import {
  parsePairFilters,
  symbolFiltersFor,
  tradablePairs,
  validateOrder,
  type OrderValidation,
} from "./filters";
import {
  classifyFailure,
  FEE_IN_QUOTE_FLAG,
  krakenTimeframe,
  parseBalances,
  parseCancelResult,
  parseCandles,
  parseClosedOrders,
  parseOpenOrders,
  parseOrderResult,
  parseServerTime,
  parseTickerResult,
  readEnvelope,
  requireResult,
  type KrakenCancelResult,
} from "./parse";
import { KRAKEN_FORM_CONTENT_TYPE, KrakenSigner, NonceGenerator, type BodyValue } from "./signing";

/**
 * Base URLs, keyed by environment -- and there is exactly ONE key.
 *
 * `GEMINI_BASE_URLS` and its Binance counterpart both carry a production and a
 * testnet host. Kraken has no sandbox: entry 89 PART 2 established that
 * `demo-futures.kraken.com` 301s every path to marketing and that spot UAT is
 * account-manager-only with no public host. Entry 90 DECISION 1 therefore
 * refuses to construct a Kraken client in the testnet environment at all, rather
 * than pointing testnet at production and letting safety rest on which key an
 * operator pasted where.
 *
 * That refusal is the RESOLVER'S job (`src/workers/exchange-kraken.ts`, a later
 * wiring step) -- the same place `exchange.ts` and `exchange-gemini.ts` derive
 * their host as a pure total function of `env.ENVIRONMENT`. What this constant
 * contributes is that a resolver CANNOT accidentally produce a testnet host from
 * it, because there is not one to produce.
 */
export const KRAKEN_BASE_URLS = {
  production: "https://api.kraken.com",
} as const;

/**
 * Every Kraken path this client uses, named once.
 *
 * The full URI path, `/0/` prefix included, because that is what
 * `KrakenSigner.sign` folds into the signature literally -- a bare endpoint name
 * here would produce a well-formed signature Kraken rejects.
 */
export const KRAKEN_ENDPOINTS = {
  time: "/0/public/Time",
  assetPairs: "/0/public/AssetPairs",
  assets: "/0/public/Assets",
  ticker: "/0/public/Ticker",
  ohlc: "/0/public/OHLC",
  addOrder: "/0/private/AddOrder",
  cancelOrder: "/0/private/CancelOrder",
  openOrders: "/0/private/OpenOrders",
  closedOrders: "/0/private/ClosedOrders",
  balanceEx: "/0/private/BalanceEx",
} as const;

/**
 * ⚠ A PLACEHOLDER. THIS IS NOT KRAKEN'S RATE-LIMIT MODEL AND MUST NOT BE USED AS
 * ONE.
 *
 * What it is: an honest COUNT of the HTTP requests each interface method below
 * actually sends, read off the code rather than assumed, and keyed by
 * `keyof RestExchangeClient` so a method added to section 4.1 will not compile
 * until its request count is written down here.
 *
 * What it is NOT, and the gap is structural rather than numeric (entry 90
 * PROBLEM 2, all four points):
 *
 *  - Kraken's REST counter DECAYS CONTINUOUSLY; `WeightBudget` expires whole
 *    entries after a fixed window, which is not a conservative approximation of
 *    a decay in either direction.
 *  - `AddOrder` and `CancelOrder` do not charge that counter at all. They charge
 *    a SEPARATE matching-engine counter that is kept PER PAIR, while the
 *    `RateLimiter` Durable Object holds one budget per ACCOUNT.
 *  - A cancel's cost depends on THE ORDER'S AGE (+8 under five seconds, +1 past
 *    five minutes), which no `Record<keyof RestExchangeClient, number>` can
 *    express, because that table is resolved from a method name before the call.
 *  - Kraken sends NO rate-limit headers (live), so there is no feedback channel
 *    to correct local accounting against.
 *
 * ⚠ THEREFORE: this table is NOT converted into `MethodWeights` and Kraken is
 * NOT registered in `METHOD_WEIGHTS` in `../rate-limited.ts`. It cannot be,
 * today: `METHOD_WEIGHTS` is a total `Record<ExchangeId, …>` and `ExchangeId` is
 * still `"binance" | "gemini"`. That absence is the intended forcing function
 * (see the constant's own docblock) and widening it belongs to the wiring step,
 * NOT here -- a Kraken account gated against a table of these numbers would be
 * spending a currency Kraken's trading limiter does not use, on the risk-exit
 * path, which is the failure entry 90 separated this work out to avoid.
 *
 * Until the dedicated session lands (entry 90 PART 6 step (d)), a Kraken client
 * is ungated, and it is ungated VISIBLY -- an unwired venue -- rather than
 * quietly gated by numbers that do not describe it.
 */
export interface KrakenRequestCost {
  /**
   * Requests charged against the ACCOUNT-WIDE REST counter, worst case.
   * Worst case, because `getOrderStatus` sends one or two depending on whether
   * the order is still open (see the method).
   */
  readonly restRequests: number;
  /** Requests charged against the PER-PAIR matching-engine counter. */
  readonly tradingRequests: number;
  /**
   * The trading cost depends on the cancelled order's AGE, not on the method.
   * True for exactly one method, and it is the one a halt issues in bulk.
   */
  readonly ageDependent: boolean;
  /**
   * The method needs the catalogue, so a COLD CACHE adds two more public REST
   * requests (`AssetPairs` + `Assets`) that this row does not count. They are
   * excluded rather than folded in for the reason `GEMINI_REQUEST_COSTS` excludes
   * `placeOrder`'s filter lookup: the fetch happens at most once an hour and
   * charging it to every caller would over-count it roughly sixty-fold.
   */
  readonly needsCatalogue: boolean;
}

export const KRAKEN_REQUEST_COSTS: Readonly<
  Record<keyof RestExchangeClient, KrakenRequestCost>
> = Object.freeze({
  getServerTime: { restRequests: 1, tradingRequests: 0, ageDependent: false, needsCatalogue: false },
  getSymbolFilters: { restRequests: 0, tradingRequests: 0, ageDependent: false, needsCatalogue: true },
  listTradablePairs: { restRequests: 0, tradingRequests: 0, ageDependent: false, needsCatalogue: true },
  getCurrentPrice: { restRequests: 1, tradingRequests: 0, ageDependent: false, needsCatalogue: true },
  getCandles: { restRequests: 1, tradingRequests: 0, ageDependent: false, needsCatalogue: true },
  // The order itself charges the matching engine, not the REST counter.
  placeOrder: { restRequests: 0, tradingRequests: 1, ageDependent: false, needsCatalogue: true },
  // The cancel charges the matching engine (age-dependent); the ONE follow-up
  // read charges REST. Both, during a halt. See `cancelOrder`.
  cancelOrder: { restRequests: 1, tradingRequests: 1, ageDependent: true, needsCatalogue: true },
  getOrderStatus: { restRequests: 2, tradingRequests: 0, ageDependent: false, needsCatalogue: true },
  getOpenOrders: { restRequests: 1, tradingRequests: 0, ageDependent: false, needsCatalogue: true },
  getAccountBalances: { restRequests: 1, tradingRequests: 0, ageDependent: false, needsCatalogue: true },
});

/**
 * How long to wait for a reply.
 *
 * Equal to both existing clients', for the reason stated there: aborting a POST
 * to `/0/private/AddOrder` locally makes the order's fate MORE uncertain, not
 * less, so the local timeout is not the tool used to bound an order.
 */
export const DEFAULT_TIMEOUT_MS = 15_000;

/** The subset of `fetch` this client uses, so a test can supply its own. */
export interface FetchLike {
  (input: string, init?: RequestInit): Promise<Response>;
}

export interface KrakenClientOptions {
  /** `KRAKEN_BASE_URLS.production`, or any override for testing. */
  baseUrl: string;
  credentials: CredentialProvider;
  /** Defaults to the runtime's global `fetch`. */
  fetch?: FetchLike;
  /** Injected so tests control the nonce and timing exactly. Defaults to `Date.now`. */
  now?: () => Timestamp;
  /**
   * The catalogue cache. Injectable so several clients on one account share one
   * AssetPairs document rather than each pulling 1.1MB of it.
   *
   * There is deliberately no separate `SymbolFilterCache` option here, and the
   * absence is the point: on Kraken, filters are DERIVED from the catalogue
   * entry (`parsePairFilters` reads `pair.raw`) and carry the catalogue's own
   * `fetchedAt`. A second cache would give one document two staleness clocks,
   * and the newer of them would let an hour-old catalogue present itself as
   * fresh filters. `GeminiClient` needs its filter cache because Gemini fetches
   * filters per symbol from a separate endpoint; Kraken does not.
   */
  catalogueCache?: KrakenCatalogueCache;
  timeoutMs?: number;
}

/** A public (unsigned GET) or private (signed POST) request specification. */
interface RequestSpec<T> {
  /** The full URI path, e.g. `/0/private/AddOrder`. Signed literally. */
  path: string;
  signed: boolean;
  /** Query parameters for a public GET. */
  query?: readonly (readonly [string, string])[];
  /** Body parameters for a signed POST, beyond the nonce `buildBody` adds. */
  params?: readonly (readonly [string, BodyValue])[];
  /** Names the call in an error message, e.g. `"Ticker"`. */
  context: string;
  /**
   * Receives the envelope's `result`, NEVER the raw body.
   *
   * `#request` owns the envelope: the error array is classified before this runs
   * and a success with no payload is refused before this runs, so every parser
   * in `parse.ts` can be handed the thing it documents itself as taking.
   */
  parse: (result: unknown, at: Timestamp) => T;
}

/** Outcome of the raw transport step, before any body interpretation. */
type Transport =
  | { reached: true; response: Response; body: unknown; at: Timestamp }
  | { reached: false; error: unknown; at: Timestamp };

export class KrakenClient implements RestExchangeClient {
  readonly #baseUrl: string;
  readonly #fetch: FetchLike;
  readonly #now: () => Timestamp;
  readonly #signer: KrakenSigner;
  readonly #nonce = new NonceGenerator();
  readonly #catalogueCache: KrakenCatalogueCache;
  readonly #timeoutMs: number;

  constructor(options: KrakenClientOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
    this.#now = options.now ?? (() => Date.now());
    this.#signer = new KrakenSigner(options.credentials);
    this.#catalogueCache = options.catalogueCache ?? new KrakenCatalogueCache();
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** Exposed so several clients on one account can share one catalogue. */
  get catalogueCache(): KrakenCatalogueCache {
    return this.#catalogueCache;
  }

  /**
   * Drop the cached catalogue, so the next call refetches it.
   *
   * Exists because `parse.ts` names the recovery and cannot perform it:
   * `tickerForAsset` throws on an asset code the catalogue does not know, and
   * its docblock says an unknown code "means the catalogue is stale, which the
   * caller can fix by refetching, but only if it is told". This is the telling.
   */
  invalidateCatalogue(): void {
    this.#catalogueCache.invalidate();
  }

  // -------------------------------------------------------------------------
  // Section 4.1 surface
  // -------------------------------------------------------------------------

  /**
   * `GET /0/public/Time` -- a REAL value, unlike Gemini's honest refusal.
   *
   * Kraken publishes a server-time endpoint (live, confirmed again this session:
   * `{"error":[],"result":{"unixtime":1788415303,"rfc1123":"…"}}`), so this
   * method returns what it says it returns. `GeminiClient.getServerTime` refuses
   * because Gemini has no such endpoint and fabricating one from the local clock
   * would be an authoritative-looking lie; that reasoning does not apply here and
   * copying it would be copying the code rather than the reason.
   *
   * NOTHING ABOUT SIGNING DEPENDS ON IT. Kraken authenticates with a monotonic
   * nonce, exactly as Gemini does, so section 4.2's `ClockOffset` correction has
   * no role on this venue either -- this is a data endpoint, not a signing input.
   * `unixtime` is SECONDS; `parseServerTime` converts.
   */
  async getServerTime(): Promise<ExchangeOutcome<number>> {
    return this.#request<number>({
      path: KRAKEN_ENDPOINTS.time,
      signed: false,
      context: "Time",
      parse: (result) => parseServerTime(result),
    });
  }

  /**
   * Trading rules for one pair, read out of the cached catalogue.
   *
   * Sends NO request of its own on a warm cache: `AssetPairs` is where Kraken
   * publishes `tick_size`, `ordermin` and `costmin`, and the catalogue already
   * holds that document. `fetchedAt` is the catalogue's, honestly, so the filters
   * are exactly as old as the response they came out of.
   */
  async getSymbolFilters(pair: Pair): Promise<ExchangeOutcome<SymbolFilters>> {
    const catalogue = await this.#catalogue();
    if (!catalogue.ok) return catalogue;
    try {
      return ok(symbolFiltersFor(catalogue.value, pair), this.#now());
    } catch (error) {
      return this.#refused<SymbolFilters>((error as Error).message);
    }
  }

  /**
   * Every pair currently trading normally, from the cached catalogue.
   *
   * Status-filtered, unlike the Gemini implementation -- and that difference is
   * the venues', not a policy change: Kraken publishes a per-pair `status` in the
   * same document, so "which markets are open" is answerable without a second
   * request. `tradablePairs` maps it through the same fail-closed `mapStatus` the
   * order path uses.
   */
  async listTradablePairs(): Promise<ExchangeOutcome<Pair[]>> {
    const catalogue = await this.#catalogue();
    if (!catalogue.ok) return catalogue;
    return ok(tradablePairs(catalogue.value), this.#now());
  }

  /**
   * `GET /0/public/Ticker?pair=<altname>`.
   *
   * The NAME SENT is the catalogue's altname (`BTCUSD` -> `XBTUSD`) and the name
   * the reply is KEYED BY is the canonical (`XXBTZUSD`), which the client never
   * chose. Both come from the catalogue; neither is derived by rewriting a
   * string. `parseTickerResult` owns the resolution and the crossed-book refusal.
   */
  async getCurrentPrice(pair: Pair): Promise<ExchangeOutcome<Price>> {
    const resolved = await this.#resolvePair<Price>(pair);
    if (!resolved.ok) return resolved.outcome;
    const { catalogue, kraken } = resolved;

    return this.#request<Price>({
      path: KRAKEN_ENDPOINTS.ticker,
      signed: false,
      query: [["pair", kraken.altname]],
      context: `Ticker for ${kraken.ticker}`,
      parse: (result, at) => parseTickerResult(result, catalogue, kraken.ticker, at),
    });
  }

  /**
   * Place a limit order.
   *
   * Section 4.3's SECOND, independent check runs first, in `verify` mode, using
   * the same shared `validateOrder` both other venues use -- validation is a
   * property of the order and the symbol grid, not of the transport.
   *
   * ⚠ THE PAIR IS RESOLVED BEFORE IT IS VALIDATED, and that ordering is
   * load-bearing rather than tidy. `validateOrder` THROWS a `FilterError` when
   * `filters.pair !== input.pair`, and Kraken's filters are keyed by the
   * catalogue's ticker (`BTCUSD`). A caller that passes `XBTUSD` or `XXBTZUSD` --
   * both perfectly valid names for the same market, and both names Kraken itself
   * uses -- would trip that throw rather than place an order. Resolving first
   * makes every one of the four names mean the market it names.
   *
   * ── THE TWO PARAMETERS THAT ARE DECISIONS, NOT TRANSCRIPTION ──
   *
   * `oflags=fciq` (entry 90 DECISION 4) asserts the fee is charged in the QUOTE
   * asset on BOTH sides. Kraken's own default is `fcib` when selling, so this
   * CHANGES the account's real behaviour on a sell -- deliberately. Section 5.5
   * forbids assuming a fee is paid in the quote currency, and Kraken is the venue
   * where that assumption is wrong half the time AND where `QueryTrades` carries
   * no currency field to read the answer from. The flag turns a chain of
   * inference into a fact the request establishes; `feeAssetFor` reads it back.
   *
   * `cl_ord_id` carries the section 5.1 id verbatim. Kraken caps free-format
   * client order ids at 18 characters, and THAT CEILING IS ENFORCED AT BOT
   * CREATION, not here -- `VENUE_ORDER_ID_BUDGETS.kraken` gives Kraken a 10-char
   * slug budget and `checkBotInstanceIdFitsVenue` refuses an over-budget id
   * before a bot exists. Re-checking it here would put the same rule in two
   * places to drift, and would refuse at the worst possible moment (mid-order)
   * something that should never have been creatable.
   *
   * ⚠ AND NOTE WHAT THE ID DOES NOT BUY ON THIS VENUE. Kraken enforces
   * `cl_ord_id` uniqueness only ACROSS OPEN ORDERS, so section 5.1's second layer
   * -- "the exchange rejects a reused id" -- is true on Binance and Gemini and
   * FALSE here once an order has closed (entry 90 DECISION 3). The Durable Object
   * attempt records remain the primary layer and are unaffected; the exchange-side
   * backstop simply is not there.
   *
   * `timeinforce` is not sent: Kraken's documented default is GTC, which is the
   * resting maker ladder sections 6.2/6.3 want. `post` is deliberately NOT set,
   * for the reason the Gemini client gives for not setting `maker-or-cancel`: it
   * would reject rather than rest if the price happened to cross, which is a
   * different behaviour from the GTC limit the other venues place.
   */
  async placeOrder(order: OrderRequest): Promise<ExchangeOutcome<OrderResult>> {
    const resolved = await this.#resolvePair<OrderResult>(order.pair);
    if (!resolved.ok) return resolved.outcome;
    const { catalogue, kraken } = resolved;

    let validation: OrderValidation;
    try {
      validation = validateOrder(
        { pair: kraken.ticker, side: order.side, price: order.price, quantity: order.quantity },
        parsePairFilters(kraken, catalogue.fetchedAt),
        { rounding: "verify" },
      );
    } catch (error) {
      // A malformed AssetPairs entry for this one pair. Definite and local.
      return this.#refused<OrderResult>((error as Error).message);
    }
    if (!validation.valid) return this.#rejectedLocally<OrderResult>(validation);

    return this.#request<OrderResult>({
      path: KRAKEN_ENDPOINTS.addOrder,
      signed: true,
      context: "AddOrder",
      params: [
        ["pair", kraken.altname],
        ["type", order.side],
        ["ordertype", "limit"],
        ["price", toTrimmedString(validation.price)],
        ["volume", toTrimmedString(validation.quantity)],
        ["cl_ord_id", order.clientOrderId],
        // DECISION 4. Not an unremarked parameter -- see the docblock.
        ["oflags", FEE_IN_QUOTE_FLAG],
      ],
      parse: (result, at) =>
        parseOrderResult({ clientOrderId: order.clientOrderId, pair: kraken.ticker }, result, at),
    });
  }

  /**
   * Cancel an order, then read ONCE where it finished (entry 90 DECISION 2).
   *
   * ── WHY THERE IS A FOLLOW-UP READ AT ALL ──
   *
   * Kraken's `CancelOrder` answers `{count, pending}`. No filled quantity, no
   * state, no order id. The interface returns the cancelled order precisely so a
   * halt does NOT need a follow-up -- and on this venue it must do one anyway.
   * Every objection in that interface comment applies, and one is worse here than
   * when it was written: the cancel has just charged the per-pair matching-engine
   * counter (up to +8 for a young order) and the read charges the account REST
   * counter, both during a halt.
   *
   * ── WHY EXACTLY ONE READ, AND NEVER A LOOP ──
   *
   * `pending: true` means the cancel had not taken effect when the reply
   * arrived, so a single immediate read can catch the order mid-transition.
   * Reading in a loop until certain spends the budget that is scarcest at exactly
   * that moment -- competing with the REMAINING cancellations of the same halt,
   * so a bot could confirm its first cancel and fail to issue its last. DECISION
   * 2 accepts a bounded, occasionally stale answer over an unbounded chase, on
   * the grounds that section 9's reconciliation already catches this class of
   * drift. That is a knowing inaccuracy in a safety path, and it is recorded as
   * one rather than papered over.
   *
   * ── ⚠ A CORRECTION TO ENTRY 90'S NAMED ENDPOINT ──
   *
   * DECISION 2 says "cancel, then a single `QueryOrders` read". `QueryOrders`
   * CANNOT SERVE THAT READ: its request schema requires `txid` and accepts only
   * `txid` and `userref` -- there is no `cl_ord_id` parameter on it (Kraken's
   * published OpenAPI document, `docs.kraken.com/openapi/spot-rest.yaml`, read
   * this session; DOCUMENTED, NOT LIVE, because a private endpoint needs
   * credentials this session does not have and Kraken checks the key before it
   * checks parameters -- verified: `QueryOrders` with `cl_ord_id` and no `txid`
   * answers `EAPI:Invalid key`, so live probing cannot settle it). The interface
   * hands this method a `clientOrderId`, not a txid.
   *
   * `ClosedOrders` DOES take `cl_ord_id`, and it is the right one of the two
   * endpoints that do: a cancel that took effect puts the order there, which is
   * the case the read exists to serve. So the SUBSTANCE of DECISION 2 is kept
   * exactly -- one cancel, one read, no loop, no chase -- and only the endpoint
   * changes, because the named one cannot be reached from a client order id.
   *
   * The rejected alternative was Gemini's shape: look the order up first to learn
   * its txid, then cancel by txid, then read. That is THREE private requests on
   * the halt path instead of two, to reach an endpoint with no advantage over
   * `ClosedOrders`, and Kraken's `CancelOrder` accepts `cl_ord_id` directly so the
   * lookup buys nothing at all.
   *
   * ── WHAT EACH OUTCOME MEANS ──
   *
   * `count: 0` is NOT an error: it means nothing matched, i.e. the order had
   * already filled or already been cancelled, which is an ordinary answer during
   * a halt racing its own fills. The read then finds the terminal order and
   * returns it, which is the right answer to "where did this order finish".
   *
   * A read that finds NOTHING is the accepted staleness above, and it is reported
   * as a NON-RETRYABLE failure naming the `count`/`pending` the cancel returned.
   * Not retryable, because re-cancelling an order that is already cancelling is
   * not a recovery, and the loop that would resolve it is the thing DECISION 2
   * refused. Not fabricated into "cancelled, nothing filled" either: that would
   * be a quantity nobody observed, in the field that determines the position a
   * halted bot is left holding.
   */
  async cancelOrder(
    pair: Pair,
    clientOrderId: string,
  ): Promise<ExchangeOutcome<OrderStatus>> {
    const resolved = await this.#resolvePair<OrderStatus>(pair);
    if (!resolved.ok) return resolved.outcome;
    const { catalogue, kraken } = resolved;

    const cancelled = await this.#request<KrakenCancelResult>({
      path: KRAKEN_ENDPOINTS.cancelOrder,
      signed: true,
      context: "CancelOrder",
      params: [["cl_ord_id", clientOrderId]],
      parse: (result) => parseCancelResult(result),
    });
    if (!cancelled.ok) return cancelled;

    // THE ONE READ. Not a loop, not conditional on `pending`.
    const read = await this.#request<OrderStatus[]>({
      path: KRAKEN_ENDPOINTS.closedOrders,
      signed: true,
      context: "ClosedOrders",
      params: [
        ["cl_ord_id", clientOrderId],
        // `trades` is not asked for: Kraken's `trades` field on an order record
        // is an array of trade IDs, not executions, so `parseOrderStatus` leaves
        // `fills` absent either way. Per-fill detail comes from `QueryTrades`,
        // which is reconciliation's concern.
        ["trades", false],
      ],
      parse: (result) => parseClosedOrders(result, catalogue),
    });
    if (!read.ok) return read;

    const found = this.#singleOrder(read.value, clientOrderId, kraken, read.at);
    if (found !== undefined) return found;

    const { count, pending } = cancelled.value;
    return this.#refused<OrderStatus>(
      `Kraken's cancel reported count=${count}, pending=${pending}, and the single ` +
        `follow-up read (entry 90 DECISION 2 -- one read, never a loop) found no ` +
        `CLOSED order carrying ${JSON.stringify(clientOrderId)}. The cancel was ` +
        `accepted; where the order finished is NOT known, and no filled quantity is ` +
        `being invented for it. Section 9 reconciliation is the mechanism that ` +
        `settles this.`,
      read.at,
    );
  }

  /**
   * Look up an order by the bot's own id -- section 5.1's recovery path.
   *
   * TWO endpoints, tried in an order that is a correctness argument rather than a
   * preference. Neither `QueryOrders` nor any single Kraken endpoint can answer
   * this: `QueryOrders` is keyed by txid (see `cancelOrder`), and `OpenOrders`
   * and `ClosedOrders` each cover one half of an order's life. Both accept a
   * `cl_ord_id` filter (Kraken's published OpenAPI document; documented, not
   * live).
   *
   * ⚠ OPEN IS READ FIRST BECAUSE THE OTHER ORDER HAS A HOLE. Read closed-first
   * and an order that is open at the first call and closes before the second is
   * missed by BOTH -- reported as "no such order" for an order that exists, which
   * is precisely the failure section 9 exists to prevent. Open-first has no such
   * window: an order open at the first call is returned by it, and an order
   * already closed is found by the second. The race that costs nothing is the one
   * to take.
   *
   * One request when the order is resting, two when it has terminated.
   */
  async getOrderStatus(
    pair: Pair,
    clientOrderId: string,
  ): Promise<ExchangeOutcome<OrderStatus>> {
    const resolved = await this.#resolvePair<OrderStatus>(pair);
    if (!resolved.ok) return resolved.outcome;
    const { catalogue, kraken } = resolved;

    const open = await this.#request<OrderStatus[]>({
      path: KRAKEN_ENDPOINTS.openOrders,
      signed: true,
      context: "OpenOrders",
      params: [
        ["cl_ord_id", clientOrderId],
        ["trades", false],
      ],
      parse: (result) => parseOpenOrders(result, catalogue),
    });
    if (!open.ok) return open;
    const resting = this.#singleOrder(open.value, clientOrderId, kraken, open.at);
    if (resting !== undefined) return resting;

    const closed = await this.#request<OrderStatus[]>({
      path: KRAKEN_ENDPOINTS.closedOrders,
      signed: true,
      context: "ClosedOrders",
      params: [
        ["cl_ord_id", clientOrderId],
        ["trades", false],
      ],
      parse: (result) => parseClosedOrders(result, catalogue),
    });
    if (!closed.ok) return closed;

    const terminated = this.#singleOrder(closed.value, clientOrderId, kraken, closed.at);
    if (terminated !== undefined) return terminated;

    return this.#refused<OrderStatus>(
      `no order carrying ${JSON.stringify(clientOrderId)} is open on Kraken, and none ` +
        `is among its closed orders either. Refusing to report this as "no such ` +
        `order": an order that exists but cannot be found is exactly what ` +
        `reconciliation must not miss.`,
      closed.at,
    );
  }

  /**
   * Every open order on the account, filtered to one pair LOCALLY.
   *
   * Kraken applies no pair filter to `OpenOrders` -- exactly as Gemini's
   * `/v1/orders` does not -- so the interface's per-pair contract is honoured
   * here, on the same reasoning recorded on the Gemini side.
   *
   * The comparison is against the catalogue's TICKER on both sides, never against
   * the raw `descr.pair` string: `parseOrderStatus` already resolves each order's
   * pair through the catalogue, and the requested pair is resolved the same way,
   * so `XBTUSD`, `XXBTZUSD` and `BTCUSD` all select the same market instead of
   * three different-looking ones.
   */
  async getOpenOrders(pair: Pair): Promise<ExchangeOutcome<OrderStatus[]>> {
    const resolved = await this.#resolvePair<OrderStatus[]>(pair);
    if (!resolved.ok) return resolved.outcome;
    const { catalogue, kraken } = resolved;

    const outcome = await this.#request<OrderStatus[]>({
      path: KRAKEN_ENDPOINTS.openOrders,
      signed: true,
      context: "OpenOrders",
      params: [["trades", false]],
      parse: (result) => parseOpenOrders(result, catalogue),
    });
    if (!outcome.ok) return outcome;
    return ok(
      outcome.value.filter((order) => order.pair === kraken.ticker),
      outcome.at,
    );
  }

  /**
   * `POST /0/private/BalanceEx` -- the EXTENDED form, not `/private/Balance`.
   *
   * Only the extended endpoint reports `hold_trade`, and the interface wants
   * `free` and `locked` separately. Reading the plain one would force `locked` to
   * be invented as zero, telling the capital ledger that money reserved against
   * open orders is available to spend. `parseBalances` owns the
   * `free = balance - hold_trade` derivation and its opposed rounding.
   *
   * The catalogue is needed here for the ASSET side rather than the pair side:
   * `ZUSD` -> `USD` and `XXBT` -> `BTC` are lookups, and `XBT.M` (bonded BTC) is
   * an asset in its own right that must NOT resolve to `BTC`.
   */
  async getAccountBalances(): Promise<ExchangeOutcome<Balance[]>> {
    const catalogue = await this.#catalogue();
    if (!catalogue.ok) return catalogue;

    return this.#request<Balance[]>({
      path: KRAKEN_ENDPOINTS.balanceEx,
      signed: true,
      context: "BalanceEx",
      parse: (result) => parseBalances(result, catalogue.value),
    });
  }

  /**
   * `GET /0/public/OHLC`, oldest-first.
   *
   * ── ⚠ THE `"6h"` DECISION, WHICH ENTRY 92 LEFT OPEN AT THIS LEVEL ──
   *
   * Kraken's OHLC intervals are 1, 5, 15, 30, 60, 240, 1440, 10080 and 21600
   * minutes: 240 then 1440, with nothing between. `CandleInterval` includes
   * `"6h"`. `KRAKEN_TIMEFRAMES` records the absence as an explicit `null` and
   * `krakenTimeframe` throws on it -- that is settled (entry 92 PART 5). What was
   * left open is what a CALLER sees, and there were two candidates: let the
   * throw surface from the parse step as an `#unreadable` failure, or refuse
   * before the request is built.
   *
   * DECIDED: REFUSE BEFORE THE REQUEST, as a definite, non-retryable
   * `exchange_error`. Three reasons, in the order that decided it:
   *
   *  1. `#unreadable` MEANS SOMETHING, AND IT WOULD BE FALSE HERE. It says
   *     "Kraken answered and this code could not read the answer". Kraken would
   *     never have been asked. An operator reading that goes looking for a
   *     payload change at the venue, which is the wrong place entirely -- the
   *     fact is local, constant, and known before any I/O.
   *  2. IT IS KNOWABLE WITHOUT SPENDING ANYTHING. `KRAKEN_TIMEFRAMES` is a frozen
   *     constant. Sending a request to discover what it already states costs a
   *     REST request and, when the gate exists, budget -- to be told
   *     `EGeneral:Invalid arguments` (live, confirmed: `OHLC&interval=360`
   *     answers exactly that), which names neither the interval nor the venue's
   *     real set.
   *  3. IT IS THE SHAPE THIS CODEBASE ALREADY USES for a locally-decidable
   *     refusal. `#rejectedLocally` returns a non-retryable `exchange_error`
   *     before sending when `validateOrder` refuses an order, on both existing
   *     venues. Same situation, same answer.
   *
   * NON-retryable, because no amount of waiting grows Kraken a six-hour candle.
   * And the check is written as a try/catch around `krakenTimeframe` rather than
   * as its own `=== null` test, so the message a caller sees is the one `parse.ts`
   * wrote -- naming the interval AND Kraken's real set -- and there is exactly one
   * place that knows which intervals this venue lacks.
   *
   * ── `since`, AND A LIVE-VERIFIED BOUNDARY ──
   *
   * Unlike Gemini's `/v2/candles`, Kraken's OHLC TAKES a `since`, so the window
   * is narrowed at the venue rather than only locally. Two things about it, both
   * checked rather than assumed:
   *
   *  - `since` is INCLUSIVE and filters on the candle's OPEN time. Live:
   *    `?interval=1&since=1788414900` returned a first row of `1788414900`
   *    itself. The interface's `since` means "candles whose CLOSE time is after
   *    it", so sending it unmodified would DROP the candle that opened before
   *    `since` and closes after it -- which, for the price feed's gap-backfill,
   *    is the candle that was in progress when the connection dropped. So one
   *    interval is subtracted before the value is sent, and the exact contract is
   *    then applied locally.
   *  - Kraken returns AT MOST 720 entries and older data cannot be retrieved
   *    regardless of `since` (its own documentation). The same window asymmetry
   *    the interface already documents for Gemini therefore applies here: short
   *    reconnect gaps are always covered, deep-history backtest is a section 13
   *    question this method does not promise to answer.
   *
   * The in-progress candle is always present in Kraken's reply and comes back
   * `closed: false`; a backfill consumer drops it.
   */
  async getCandles(
    pair: Pair,
    interval: CandleInterval,
    since?: Timestamp,
  ): Promise<ExchangeOutcome<Candle[]>> {
    let minutes: number;
    let intervalMs: number;
    try {
      ({ minutes, ms: intervalMs } = krakenTimeframe(interval));
    } catch (error) {
      // Before the catalogue, before the request. See the docblock.
      return this.#refused<Candle[]>((error as Error).message);
    }

    const resolved = await this.#resolvePair<Candle[]>(pair);
    if (!resolved.ok) return resolved.outcome;
    const { catalogue, kraken } = resolved;

    const query: [string, string][] = [
      ["pair", kraken.altname],
      ["interval", String(minutes)],
    ];
    if (since !== undefined) {
      // Back off one interval, because Kraken's `since` is inclusive on the OPEN
      // time and the contract is on the CLOSE time. See the docblock.
      const fromSeconds = Math.floor((since - intervalMs) / 1000);
      if (fromSeconds > 0) query.push(["since", String(fromSeconds)]);
    }

    const outcome = await this.#request<Candle[]>({
      path: KRAKEN_ENDPOINTS.ohlc,
      signed: false,
      query,
      context: `OHLC for ${kraken.ticker}`,
      parse: (result, at) => parseCandles(result, catalogue, kraken.ticker, at, intervalMs),
    });
    if (!outcome.ok || since === undefined) return outcome;
    return ok(
      outcome.value.filter((candle) => candle.closeTime > since),
      outcome.at,
    );
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * The cached catalogue, or a fetch of `AssetPairs` and `Assets`.
   *
   * Both documents, together, always: `buildKrakenCatalogue` needs the asset
   * table to un-prefix the pair table's `base`/`quote` codes, and half a
   * catalogue is not a thing that can be built. They are fetched CONCURRENTLY
   * because both are public GETs with no nonce to order, so nothing is serialised
   * by doing them one at a time except the latency.
   *
   * ⚠ `fetchedAt` IS THE OLDER OF THE TWO RECEIPT TIMES, not `now`. The catalogue
   * is exactly as fresh as its staler half, and `SymbolFilters.fetchedAt` is read
   * from it -- so rounding the age down would be the one direction that lets
   * stale trading rules present themselves as current.
   *
   * No request is sent at all when the cache is warm.
   */
  async #catalogue(): Promise<ExchangeOutcome<KrakenCatalogue>> {
    const cached = this.#catalogueCache.get(this.#now());
    if (cached !== undefined) return ok(cached, this.#now());

    const [pairs, assets] = await Promise.all([
      this.#request<unknown>({
        path: KRAKEN_ENDPOINTS.assetPairs,
        signed: false,
        context: "AssetPairs",
        parse: (result) => result,
      }),
      this.#request<unknown>({
        path: KRAKEN_ENDPOINTS.assets,
        signed: false,
        context: "Assets",
        parse: (result) => result,
      }),
    ]);
    if (!pairs.ok) return pairs;
    if (!assets.ok) return assets;

    try {
      const catalogue = buildKrakenCatalogue({
        assetPairs: pairs.value,
        assets: assets.value,
        // The staler half. See the docblock.
        fetchedAt: Math.min(pairs.at, assets.at),
      });
      this.#catalogueCache.put(catalogue);
      return ok(catalogue, this.#now());
    } catch (error) {
      // A catalogue that cannot be built is not cached, so the next call retries
      // the fetch rather than inheriting a broken view of the venue.
      return this.#unreadable<KrakenCatalogue>(error, this.#now());
    }
  }

  /**
   * The catalogue plus one resolved pair, or the failure that stopped it.
   *
   * Every pair-taking method begins with these two steps and they fail in two
   * genuinely different ways -- the catalogue could not be FETCHED (which may be
   * transport, and may be retryable) versus the pair is not IN it (which is
   * definite and local) -- so both are kept distinct rather than collapsed into
   * one message.
   */
  async #resolvePair<T>(
    pair: Pair,
  ): Promise<
    | { readonly ok: true; readonly catalogue: KrakenCatalogue; readonly kraken: KrakenPair }
    | { readonly ok: false; readonly outcome: ExchangeOutcome<T> }
  > {
    const catalogue = await this.#catalogue();
    if (!catalogue.ok) return { ok: false, outcome: catalogue };
    try {
      return { ok: true, catalogue: catalogue.value, kraken: catalogue.value.requirePair(pair) };
    } catch (error) {
      return { ok: false, outcome: this.#refused<T>((error as Error).message) };
    }
  }

  /**
   * The one order in a list that must hold exactly one, with the pair checked --
   * or `undefined` when the list holds NONE of it.
   *
   * `undefined` rather than a failure for the empty case, because "no match" means
   * something different at each of the three call sites (a cancel whose effect is
   * not yet visible, an order that may still be closed, an order that is nowhere
   * at all), and a single message here could only be wrong at two of them.
   *
   * ⚠ THE `clientOrderId` FILTER IS APPLIED LOCALLY EVEN THOUGH KRAKEN WAS ASKED
   * TO APPLY IT. `OpenOrders` and `ClosedOrders` without a matching `cl_ord_id`
   * filter return the account's recent orders WHOLESALE, so a filter Kraken
   * ignored -- an API change, a typo'd parameter name -- would hand this code a
   * plausible-looking order belonging to a different bot. Re-checking costs
   * nothing and converts that from a wrong answer into no answer.
   *
   * THE PAIR IS CHECKED TOO, which is what makes `cancelOrder`'s and
   * `getOrderStatus`' `pair` argument load-bearing rather than decorative. An
   * order found under the requested client id but resting on a DIFFERENT market
   * than the caller named means one of the two is wrong about which order this
   * is, and cancelling or reporting on the wrong market is the exact failure
   * entry 89 named as the worst available.
   *
   * Zero and several are both refused, in the spirit of `requireSingleOrder` --
   * and several is genuinely reachable here rather than theoretical: Kraken
   * enforces `cl_ord_id` uniqueness only across OPEN orders, so a closed-order
   * search can legitimately return two orders that reused one id.
   */
  #singleOrder(
    orders: readonly OrderStatus[],
    clientOrderId: string,
    kraken: KrakenPair,
    at: Timestamp,
  ): ExchangeOutcome<OrderStatus> | undefined {
    const matches = orders.filter((order) => order.clientOrderId === clientOrderId);

    if (matches.length === 0) return undefined;
    if (matches.length > 1) {
      return this.#refused<OrderStatus>(
        `Kraken returned ${matches.length} orders carrying ` +
          `${JSON.stringify(clientOrderId)} (${matches
            .map((order) => order.exchangeOrderId)
            .join(", ")}); Kraken enforces client-order-id uniqueness only across ` +
          `OPEN orders, so a reused id is possible. Refusing to guess which one is meant.`,
        at,
      );
    }

    const found = matches[0]!;
    if (found.pair !== kraken.ticker) {
      return this.#refused<OrderStatus>(
        `order ${found.exchangeOrderId} carries ${JSON.stringify(clientOrderId)} but ` +
          `is on ${found.pair}, not the ${kraken.ticker} the caller named. Refusing to ` +
          `act on one market's order under another market's name.`,
        at,
      );
    }
    return ok(found, at);
  }

  /**
   * Turn a local filter rejection into a failed outcome.
   *
   * Identical policy to both existing clients: a non-retryable `exchange_error`
   * carrying the validation reason for the section 4.3 log. The order is invalid
   * as constructed, and re-sending it would fail identically.
   */
  #rejectedLocally<T>(
    validation: Extract<OrderValidation, { valid: false }>,
  ): ExchangeOutcome<T> {
    return this.#refused<T>(
      `order rejected before sending (${validation.code}): ${validation.reason}`,
    );
  }

  /**
   * A definite refusal decided HERE, without a request or from a local reading.
   *
   * Always non-retryable, and that is the common property of everything routed
   * through it: an interval Kraken does not publish, a pair Kraken does not list,
   * an order the filters reject, a follow-up read that found nothing. Every one of
   * them answers identically on a second attempt.
   *
   * `exchange_error` rather than `transport`: `transport` means "sent, effect
   * unknown", which would push section 5.1 into recovering an order that, in
   * these cases, provably does not exist.
   */
  #refused<T>(message: string, at: Timestamp = this.#now()): ExchangeOutcome<T> {
    return { ok: false, kind: "exchange_error", message, retryable: false, at };
  }

  /**
   * A successful reply this code could not understand.
   *
   * Deliberately a failure, and not retryable: the same request returns the same
   * unreadable body, and section 5.6 admits only valid, successful responses into
   * strategy logic. Distinct from `#refused` in what it CLAIMS -- this one says
   * Kraken answered and the answer was unreadable, which is a statement about the
   * venue rather than about this system, and it must not be used where no request
   * was made (see `getCandles` on `"6h"`).
   */
  #unreadable<T>(error: unknown, at: Timestamp): ExchangeOutcome<T> {
    return {
      ok: false,
      kind: "exchange_error",
      message: `could not read Kraken's response: ${(error as Error).message}`,
      retryable: false,
      at,
    };
  }

  /**
   * One request, from dispatch to a parsed outcome.
   *
   * ⚠ THE ORDER OF THE CHECKS IS THE WHOLE POINT, and it is the reverse of
   * `GeminiClient.#request` (entry 90 PROBLEM 3):
   *
   *   1. No reply at all -> `classifyThrown`. The effect is unknown.
   *   2. THE ERROR ARRAY, FIRST. Kraken answers HTTP 200 to a bad key, an unknown
   *      pair and a throttle alike, so the status carries nothing and the array
   *      carries everything. `classifyFailure` reads the strings.
   *   3. Only if the body is NOT a Kraken envelope does the status get a say --
   *      and then only when it is itself a failure. A non-envelope body with a
   *      failing status is an edge or proxy error that never reached Kraken's
   *      application layer, which is the one case where `classifyStatus`'s rules
   *      ("5xx means the effect is unknown, 4xx means refused") genuinely apply.
   *   4. `requireResult` then refuses a success that carried no payload, and the
   *      spec's parser sees only a real `result`.
   *
   * NO SYNTHETIC STATUS IS INVENTED anywhere in this path -- `parse.ts`'s
   * `classifyFailure` docblock explains at length why Gemini's
   * `classifyFailure(400, …)` trick would be a lie here. A real HTTP status is
   * passed through only when the transport genuinely produced a failing one.
   */
  async #request<T>(spec: RequestSpec<T>): Promise<ExchangeOutcome<T>> {
    const transport = await this.#transport(spec);

    if (!transport.reached) {
      // No reply. For an order this means recovery goes through the section 5.1
      // idempotency records, never a blind re-send.
      return classifyThrown<T>(transport.error, transport.at);
    }

    const { response, body, at } = transport;
    const failedStatus = response.ok ? undefined : response.status;

    let errors: readonly string[];
    try {
      errors = readEnvelope(body).errors;
    } catch (error) {
      // Not a Kraken envelope at all. See check 3 in the docblock.
      if (failedStatus !== undefined) {
        return classifyStatus<T>(failedStatus, at, {
          message:
            `${spec.context}: HTTP ${failedStatus} with a body that is not a Kraken ` +
            `envelope (${(error as Error).message})`,
        });
      }
      return this.#unreadable<T>(error, at);
    }

    if (errors.length > 0) {
      return classifyFailure<T>(errors, at, failedStatus === undefined ? {} : { status: failedStatus });
    }

    if (failedStatus !== undefined) {
      // A failing status with an EMPTY error array: Kraken's two channels
      // disagree. Trust the status, which is the one reporting a failure.
      return classifyStatus<T>(failedStatus, at, {
        message: `${spec.context}: HTTP ${failedStatus} with an empty Kraken error array`,
      });
    }

    try {
      // `requireResult` re-reads the envelope. That is exactly what its docblock
      // describes it as being for -- "used by the client after `classifyFailure`
      // has already handled a non-empty error array" -- and it keeps the "success
      // with no payload" message in one place rather than restating it here.
      return ok(spec.parse(requireResult(body, spec.context), at), at);
    } catch (error) {
      return this.#unreadable<T>(error, at);
    }
  }

  /**
   * The single place a request actually leaves this process.
   *
   * A public request is a GET with a query string and no auth. A private request
   * is a POST of the URL-encoded body `signedRequest` BUILT AND SIGNED -- those
   * exact bytes, never rebuilt here, because the signature covers them and a body
   * regenerated at the call site is one parameter-order change away from a
   * signature that verifies against something else. The nonce is drawn once per
   * request from the monotonic generator.
   */
  async #transport<T>(spec: RequestSpec<T>): Promise<Transport> {
    let url = `${this.#baseUrl}${spec.path}`;
    let init: RequestInit;

    try {
      if (spec.signed) {
        const nonce = this.#nonce.next(this.#now());
        const signed = await this.#signer.signedRequest(spec.path, nonce, spec.params ?? []);
        init = {
          method: "POST",
          headers: {
            ...signed.headers,
            "Content-Type": KRAKEN_FORM_CONTENT_TYPE,
          },
          // The bytes that were signed. Not rebuilt. See the docblock.
          body: signed.body,
          signal: AbortSignal.timeout(this.#timeoutMs),
        };
      } else {
        if (spec.query !== undefined && spec.query.length > 0) {
          const search = new URLSearchParams();
          for (const [key, value] of spec.query) search.append(key, value);
          url = `${url}?${search.toString()}`;
        }
        init = { method: "GET", signal: AbortSignal.timeout(this.#timeoutMs) };
      }
    } catch (error) {
      // Signing failed locally -- a malformed secret, or a nonce/body mismatch
      // the signer refuses. NOTHING WAS SENT, so no order state is in doubt.
      return { reached: false, error, at: this.#now() };
    }

    try {
      const response = await this.#fetch(url, init);

      // Read the body before anything else can fail, so a non-JSON error page
      // becomes `undefined` rather than an exception that masks the status.
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        body = undefined;
      }

      return { reached: true, response, body, at: this.#now() };
    } catch (error) {
      return { reached: false, error, at: this.#now() };
    }
  }
}
