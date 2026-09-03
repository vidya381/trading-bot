/**
 * The Gemini implementation of the exchange interface (spec section 4).
 *
 * A second `RestExchangeClient`, structurally parallel to `BinanceClient` but not
 * a copy of it -- Gemini's transport and payloads differ where step 3's task
 * warned they would. It coexists with Binance behind the identical interface;
 * nothing about BotInstance, the strategies or reconciliation changes, and no
 * caller can tell which exchange is underneath.
 *
 * Covers the whole `RestExchangeClient` interface. The live price feed is NOT a
 * client method -- section 4.6 puts that connection in a Durable Object, and step
 * 14 established it cannot hibernate (an outbound socket does not), so the feed
 * owns its own socket and this client stays purely request/response. `getCandles`
 * is the one method with a Gemini-specific wrinkle worth flagging up front: its
 * OHLCV arrive as JSON NUMBERS, not the decimal strings the rest of this API
 * uses, so `parse.ts` rounds them explicitly to the money scale.
 *
 * The shape of the differences from Binance:
 *
 *  - EVERY private call is a POST with an EMPTY body; the signed base64 payload
 *    and the signature ride in headers (`gemini/signing.ts`). There is no signed
 *    query string.
 *  - A MASTER key must name the account it acts on, in a top-level `account`
 *    field on every signed payload. That is a property of the KEY, not of the
 *    endpoint, so it is applied once in `#request` (`#accountParams`) and covers
 *    orders, cancels, status, open orders and balances alike. See
 *    `resolveAccountField` for the rule and for the two Gemini error codes that
 *    police it in both directions.
 *  - There is NO clock sync. Gemini authenticates with a monotonic nonce, so the
 *    `ClockOffset`/`getServerTime` machinery Binance needed does not exist here.
 *    `getServerTime` is implemented honestly (it reports that Gemini exposes no
 *    such endpoint) rather than by fabricating a value.
 *  - `cancelOrder` takes a `client_order_id` per the interface, but Gemini's
 *    cancel accepts only the numeric `order_id`. So a cancel is a lookup of the
 *    order by client id to learn its `order_id`, then the cancel itself.
 *  - Gemini reports used capacity as a REQUEST COUNT, not a weight, and sends no
 *    used-weight header, so there is no per-response weight to feed back. Gating
 *    (a request-count budget) belongs in the wrapper at dispatch time, as on the
 *    Binance side; this client only performs the calls.
 *
 * As with Binance, every method resolves to an `ExchangeOutcome` and nothing here
 * throws on a failed request, and retrying is the caller's job (`placeOrder` in
 * particular must be recovered by lookup, never re-sent).
 */

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
import type { ExchangeOutcome } from "../../shared/downtime";
import { classifyThrown, ok } from "../../shared/downtime";
import { toTrimmedString } from "../../shared/money";
import type { CredentialProvider } from "../credentials";
import {
  parseSymbolDetails,
  SymbolFilterCache,
  toGeminiSymbol,
  validateOrder,
  type OrderValidation,
} from "./filters";
import {
  classifyFailure,
  parseBalances,
  parseGroupAccounts,
  type GeminiGroupAccount,
  parseCancelledOrder,
  parseCandles,
  parseOrderResult,
  parseOrderStatus,
  parseOrderStatusList,
  parsePrice,
  parseSymbolList,
  readErrorBody,
} from "./parse";
import {
  GeminiSigner,
  NonceGenerator,
  resolveAccountField,
  type PayloadValue,
} from "./signing";

/** Base URLs, one per environment. Section 16 keeps the two fully separate. */
export const GEMINI_BASE_URLS = {
  production: "https://api.gemini.com",
  sandbox: "https://api.sandbox.gemini.com",
} as const;

/**
 * Gemini's published rate limits -- this venue's answer to Binance's
 * `ENDPOINT_WEIGHTS`, and the reason that constant could never stand in for it.
 *
 * Quoted from Gemini's own reference (developer.gemini.com/rate-limit, read
 * 2026-09-02): "For public API entry points, we limit requests to 120 requests
 * per minute, and recommend that you do not exceed 1 request per second. For
 * private API entry points, we limit requests to 600 requests per minute, and
 * recommend that you not exceed 5 requests per second."
 *
 * DOCUMENTED, NOT MEASURED -- the same standing `ENDPOINT_WEIGHTS` has, and
 * labelled the same way. Nothing here was probed against a live account.
 *
 * The shape of the difference from Binance, which is what actually matters to
 * the gate: Gemini counts REQUESTS, not weight, and it keeps TWO independent
 * counters (public and private), where Binance keeps one weight budget. So a
 * Gemini method's cost is "how many requests, against which of the two", not a
 * single published number per endpoint.
 */
export const GEMINI_RATE_LIMITS = {
  publicRequestsPerMinute: 120,
  privateRequestsPerMinute: 600,
  windowMs: 60_000,
} as const;

/** Which of Gemini's two counters a request is charged against. */
export type GeminiRateLimitGroup = "public" | "private" | "none";

export interface GeminiRequestCost {
  readonly group: GeminiRateLimitGroup;
  /** HTTP requests this method sends -- Gemini's unit of cost, not a weight. */
  readonly requests: number;
}

/**
 * What each section 4.1 method actually costs on Gemini, counted from the
 * requests the methods above genuinely send.
 *
 * Keyed by method name against `RestExchangeClient` for the same reason
 * `MethodWeights` is: a method added to the interface will not compile until
 * its cost on this venue is declared, so no new call can slip past the budget
 * unmeasured. The gate turns this into the budget's units
 * (`GEMINI_METHOD_WEIGHTS` in `../rate-limited.ts`); the counting stays here,
 * beside the endpoints being counted, so it cannot drift from them.
 *
 * Two entries are not one-request-per-method, and both are read off the code
 * above rather than assumed:
 *
 *  - `cancelOrder` is TWO private requests. Gemini's `/v1/order/cancel` takes
 *    only the numeric `order_id`, so a cancel is a `/v1/order/status` lookup
 *    followed by the cancel itself. This is exactly the method a halt issues in
 *    bulk, so charging it one request would under-count the risk-exit path by
 *    half.
 *  - `getServerTime` is ZERO requests: Gemini exposes no server-time endpoint
 *    and the method above returns a failure without reaching the network.
 *
 * `placeOrder` is counted as its ONE order request. It also consults the symbol
 * filters, but through the client's own cache (`#filtersFor`), and a cache miss
 * there is a `getSymbolFilters` call that the gate charges in its own right --
 * so folding it in here would double-count it.
 */
export const GEMINI_REQUEST_COSTS: Readonly<Record<keyof RestExchangeClient, GeminiRequestCost>> = {
  getServerTime: { group: "none", requests: 0 },
  getSymbolFilters: { group: "public", requests: 1 },
  listTradablePairs: { group: "public", requests: 1 },
  getCurrentPrice: { group: "public", requests: 1 },
  getCandles: { group: "public", requests: 1 },
  placeOrder: { group: "private", requests: 1 },
  cancelOrder: { group: "private", requests: 2 },
  getOrderStatus: { group: "private", requests: 1 },
  getOpenOrders: { group: "private", requests: 1 },
  getAccountBalances: { group: "private", requests: 1 },
};

/**
 * Map the interface's canonical intervals to Gemini's own timeframe spelling and
 * the interval's length in milliseconds.
 *
 * Gemini writes the three longer intervals as "1hr"/"6hr"/"1day", not "1h"/"6h"/
 * "1d". The millisecond length is used to derive each candle's close time, since
 * Gemini reports only the open time. Only "1m" is exercised in v1 (the price
 * feed's gap-backfill); the rest are declared for the section 13 backtest and are
 * unverified against the live endpoint until then.
 */
const GEMINI_TIMEFRAMES: Record<CandleInterval, { timeframe: string; ms: number }> = {
  "1m": { timeframe: "1m", ms: 60_000 },
  "5m": { timeframe: "5m", ms: 300_000 },
  "15m": { timeframe: "15m", ms: 900_000 },
  "30m": { timeframe: "30m", ms: 1_800_000 },
  "1h": { timeframe: "1hr", ms: 3_600_000 },
  "6h": { timeframe: "6hr", ms: 21_600_000 },
  "1d": { timeframe: "1day", ms: 86_400_000 },
};

/**
 * How long to wait for a reply.
 *
 * Kept generous and equal to the Binance client's, for the same reason: a POST to
 * `/v1/order/new` that is aborted locally leaves the order's fate MORE uncertain,
 * not less -- the request may have been applied. A reply, even a slow one, is
 * strictly more information, so the local timeout is not the tool used to bound
 * an order.
 */
export const DEFAULT_TIMEOUT_MS = 15_000;

/** The subset of `fetch` this client uses, so a test can supply its own. */
export interface FetchLike {
  (input: string, init?: RequestInit): Promise<Response>;
}

export interface GeminiClientOptions {
  /** One of `GEMINI_BASE_URLS`, or any override for testing. */
  baseUrl: string;
  credentials: CredentialProvider;
  /**
   * The account nickname to act on, sent as the top-level `account` field of
   * every signed payload (see `resolveAccountField` in `signing.ts`).
   *
   * REQUIRED when the API key is a master key (`master-...`), and must be absent
   * for an account-level key (`account-...`). Left undefined for the ordinary
   * single-account case.
   */
  accountName?: string;
  /** Defaults to the runtime's global `fetch`. */
  fetch?: FetchLike;
  /** Injected so tests control the nonce and timing exactly. Defaults to `Date.now`. */
  now?: () => Timestamp;
  filterCache?: SymbolFilterCache;
  timeoutMs?: number;
}

/** A public (unsigned) or private (signed) request specification. */
interface RequestSpec<T> {
  /** The Gemini endpoint path, e.g. `/v1/order/new`. Also the payload `request`. */
  path: string;
  signed: boolean;
  /**
   * A GROUP-level API: one that acts on the master group itself rather than on a
   * single account, so it takes NO `account` field and must not be given one.
   * `/v1/account/list` is the only such endpoint here; every other signed call is
   * per-account and gets the field (see `#accountParams`).
   */
  groupLevel?: boolean;
  /** Extra payload params for a signed request, beyond `request` and `nonce`. */
  params?: readonly (readonly [string, PayloadValue])[];
  parse: (body: unknown, at: Timestamp) => T;
}

/** Outcome of the raw transport step, before any status or body interpretation. */
type Transport =
  | { reached: true; response: Response; body: unknown; at: Timestamp }
  | { reached: false; error: unknown; at: Timestamp };

export class GeminiClient implements RestExchangeClient {
  readonly #baseUrl: string;
  readonly #fetch: FetchLike;
  readonly #now: () => Timestamp;
  readonly #signer: GeminiSigner;
  readonly #accountName: string | undefined;
  readonly #nonce = new NonceGenerator();
  readonly #filters: SymbolFilterCache;
  readonly #timeoutMs: number;

  constructor(options: GeminiClientOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
    this.#now = options.now ?? (() => Date.now());
    this.#signer = new GeminiSigner(options.credentials);
    this.#accountName = options.accountName;
    this.#filters = options.filterCache ?? new SymbolFilterCache();
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** Exposed so step 6 can share one filter cache across bots on a pair. */
  get filterCache(): SymbolFilterCache {
    return this.#filters;
  }

  // -------------------------------------------------------------------------
  // Section 4.1 surface
  // -------------------------------------------------------------------------

  /**
   * Gemini exposes no server-time endpoint, and needs none.
   *
   * This method exists because the interface (section 4.1) declares it -- Binance
   * uses it to correct clock drift before signing a timestamp. Gemini signs with
   * a monotonic nonce instead, so there is nothing to correct and nothing to
   * fetch. Rather than fabricate a "server time" from the local clock -- an
   * authoritative-looking value that is not what the type promises, exactly the
   * kind of thing this codebase refuses elsewhere -- it returns a clear,
   * non-retryable failure. Nothing in the system calls it on a Gemini client (it
   * was only ever the Binance client's own clock-sync helper), so this is safe.
   */
  async getServerTime(): Promise<ExchangeOutcome<number>> {
    return {
      ok: false,
      kind: "exchange_error",
      message:
        "Gemini exposes no server-time endpoint; its requests are authenticated " +
        "with a monotonic nonce, so no clock synchronisation is required or possible.",
      retryable: false,
      at: this.#now(),
    };
  }

  async getSymbolFilters(pair: Pair): Promise<ExchangeOutcome<SymbolFilters>> {
    const outcome = await this.#request<SymbolFilters>({
      path: `/v1/symbols/details/${toGeminiSymbol(pair)}`,
      signed: false,
      parse: (body, at) => parseSymbolDetails(body, at),
    });
    if (outcome.ok) this.#filters.put(outcome.value);
    return outcome;
  }

  async getCurrentPrice(pair: Pair): Promise<ExchangeOutcome<Price>> {
    return this.#request<Price>({
      path: `/v1/pubticker/${toGeminiSymbol(pair)}`,
      signed: false,
      parse: (body, at) => parsePrice(pair, body, at),
    });
  }

  /**
   * Every trading pair Gemini lists, from `/v1/symbols`.
   *
   * Unsigned public data. Gemini returns its symbols lowercase and
   * separator-less; `parseSymbolList` upper-cases them back to this system's
   * `Pair` convention. See that function for why -- unlike Binance -- the list
   * is not status-filtered here (Gemini exposes status only per symbol).
   */
  async listTradablePairs(): Promise<ExchangeOutcome<Pair[]>> {
    return this.#request<Pair[]>({
      path: "/v1/symbols",
      signed: false,
      parse: (body) => parseSymbolList(body),
    });
  }

  /**
   * Place a limit order, re-validating it first.
   *
   * Section 4.3's SECOND, independent check, in `verify` mode -- identical to the
   * Binance client, and using the same shared `validateOrder`, because validation
   * is a property of the order and the symbol grid, not of the exchange's
   * transport. A price no longer on the grid is reported, not silently re-rounded.
   *
   * The order is a plain `"exchange limit"` with no `options`, which on Gemini is
   * a standard good-til-cancelled resting order -- the maker ladder orders
   * sections 6.2/6.3 want. `"maker-or-cancel"` is deliberately NOT set: it would
   * reject rather than rest if the price happened to cross, which is a different
   * behaviour from the GTC limit the Binance side places.
   */
  async placeOrder(order: OrderRequest): Promise<ExchangeOutcome<OrderResult>> {
    const filters = await this.#filtersFor(order.pair);
    if (!filters.ok) return filters;

    const validation = validateOrder(
      { pair: order.pair, side: order.side, price: order.price, quantity: order.quantity },
      filters.value,
      { rounding: "verify" },
    );
    if (!validation.valid) return this.#rejectedLocally<OrderResult>(validation);

    return this.#request<OrderResult>({
      path: "/v1/order/new",
      signed: true,
      params: [
        ["symbol", toGeminiSymbol(order.pair)],
        ["amount", toTrimmedString(validation.quantity)],
        ["price", toTrimmedString(validation.price)],
        ["side", order.side],
        ["type", "exchange limit"],
        // The deterministic id from section 5.1. Gemini rejects a reused
        // client_order_id, the second layer of duplicate protection.
        ["client_order_id", order.clientOrderId],
      ],
      parse: (body) => parseOrderResult(body),
    });
  }

  /**
   * Cancel an order and return where it finished.
   *
   * The interface identifies an order by `clientOrderId`, but Gemini's
   * `/v1/order/cancel` accepts ONLY the numeric `order_id`. So this is two calls:
   * a status lookup by `client_order_id` to learn the `order_id`, then the cancel.
   * The cancel response still echoes the final `executed_amount`, so the
   * halt-time filled quantity step 3.1 cares about comes from the cancel itself,
   * not a follow-up -- the extra call is the id resolution, not a second read of
   * the result.
   *
   * If the lookup fails, the failure is returned as-is: cancelling an order whose
   * `order_id` could not be established is not something to attempt blindly.
   */
  async cancelOrder(
    pair: Pair,
    clientOrderId: string,
  ): Promise<ExchangeOutcome<OrderStatus>> {
    const looked = await this.#request<OrderStatus>({
      path: "/v1/order/status",
      signed: true,
      params: [["client_order_id", clientOrderId]],
      parse: (body) => parseOrderStatus(body),
    });
    if (!looked.ok) return looked;

    return this.#request<OrderStatus>({
      path: "/v1/order/cancel",
      signed: true,
      params: [["order_id", looked.value.exchangeOrderId]],
      parse: (body, at) => parseCancelledOrder(body, at),
    });
  }

  async getOrderStatus(
    pair: Pair,
    clientOrderId: string,
  ): Promise<ExchangeOutcome<OrderStatus>> {
    return this.#request<OrderStatus>({
      path: "/v1/order/status",
      signed: true,
      params: [
        ["client_order_id", clientOrderId],
        // Ask for the executions, so a partially or fully filled order read back
        // carries its per-fill fee detail rather than only aggregate amounts.
        ["include_trades", true],
      ],
      parse: (body) => parseOrderStatus(body),
    });
  }

  async getOpenOrders(pair: Pair): Promise<ExchangeOutcome<OrderStatus[]>> {
    const symbol = toGeminiSymbol(pair);
    return this.#request<OrderStatus[]>({
      // `/v1/orders` returns every active order on the account; Gemini has no
      // per-symbol variant, so it is filtered here to match the interface's
      // per-pair contract.
      path: "/v1/orders",
      signed: true,
      parse: (body) =>
        parseOrderStatusList(body).filter((order) => toGeminiSymbol(order.pair) === symbol),
    });
  }

  async getAccountBalances(): Promise<ExchangeOutcome<Balance[]>> {
    return this.#request<Balance[]>({
      path: "/v1/balances",
      signed: true,
      parse: (body) => parseBalances(body),
    });
  }

  /**
   * Historical candles from `/v2/candles/:symbol/:timeframe`.
   *
   * Unsigned public data. Gemini's endpoint takes NO time-range parameter -- it
   * returns a fixed recent window -- so `since` is honoured by filtering the
   * parsed window locally, and this client cannot reach candles older than the
   * window covers (the asymmetry documented on the interface). For the feed's
   * short reconnect gaps the window always covers the missed candles; deep
   * history is a section 13 concern this does not claim to serve.
   *
   * The in-progress candle (`closed: false`) is returned when its close time is
   * after `since`; a gap-backfill consumer drops it and waits for the live feed
   * to close it. OHLCV arrive as JSON numbers here, not strings -- see
   * `candleMoney` in `parse.ts`.
   */
  async getCandles(
    pair: Pair,
    interval: CandleInterval,
    since?: Timestamp,
  ): Promise<ExchangeOutcome<Candle[]>> {
    const { timeframe, ms } = GEMINI_TIMEFRAMES[interval];
    const outcome = await this.#request<Candle[]>({
      path: `/v2/candles/${toGeminiSymbol(pair)}/${timeframe}`,
      signed: false,
      parse: (body, at) => parseCandles(pair, body, at, ms),
    });
    if (!outcome.ok || since === undefined) return outcome;
    return ok(
      outcome.value.filter((candle) => candle.closeTime > since),
      outcome.at,
    );
  }

  /**
   * The accounts in this master key's group, from `/v1/account/list`.
   *
   * NOT part of `RestExchangeClient` and not used in trading -- it exists so the
   * `account` nickname a master key must send can be LOOKED UP instead of
   * guessed. That mattered: a wrong nickname is refused with `InvalidAccountName`,
   * whose message ("Expected a JSON array with valid accounts, instead got: X")
   * invites exactly the wrong fix. Each entry pairs the display `name` an
   * operator recognises with the `account` nickname the API actually wants.
   *
   * Group-level, so it sends no `account` field of its own. Read-only.
   */
  async listMasterGroupAccounts(): Promise<ExchangeOutcome<GeminiGroupAccount[]>> {
    return this.#request<GeminiGroupAccount[]>({
      path: "/v1/account/list",
      signed: true,
      groupLevel: true,
      parse: (body) => parseGroupAccounts(body),
    });
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /** Cached filters if fresh, otherwise a fetch. */
  async #filtersFor(pair: Pair): Promise<ExchangeOutcome<SymbolFilters>> {
    const cached = this.#filters.get(pair, this.#now());
    if (cached !== undefined) return ok(cached, this.#now());
    return this.getSymbolFilters(pair);
  }

  /**
   * Turn a local filter rejection into a failed outcome.
   *
   * Identical policy to the Binance client: an `exchange_error`, explicitly not
   * retryable, carrying the validation reason for the section 4.3 log. The order
   * is invalid as constructed, and re-sending it would fail identically.
   */
  #rejectedLocally<T>(validation: Extract<OrderValidation, { valid: false }>) {
    const at = this.#now();
    return {
      ok: false as const,
      kind: "exchange_error" as const,
      message: `order rejected before sending (${validation.code}): ${validation.reason}`,
      retryable: false,
      at,
    } satisfies Extract<ExchangeOutcome<T>, { ok: false }>;
  }

  /**
   * The `account` field this key must send, or a refusal to send anything.
   *
   * Applied to EVERY signed request, in one place, rather than at the five call
   * sites -- the field is a property of the key, not of the endpoint, and Gemini
   * documents it on all of `/v1/order/new`, `/v1/order/status`,
   * `/v1/order/cancel`, `/v1/orders` and `/v1/balances` (marked required on
   * `/v1/balances`). Adding it per call site would leave the next signed endpoint
   * to remember it; adding it here means it cannot be forgotten.
   *
   * A misconfiguration is a NON-RETRYABLE `exchange_error` returned before the
   * request leaves: the same request would be refused identically, and routing it
   * through the thrown-error path would classify it as a retryable transport
   * fault, which it is not. Nothing is sent, so no order state is in doubt.
   */
  #accountParams<T>():
    | { readonly ok: true; readonly params: readonly (readonly [string, PayloadValue])[] }
    | { readonly ok: false; readonly outcome: ExchangeOutcome<T> } {
    const resolved = resolveAccountField(this.#signer.apiKey, this.#accountName);
    if (!resolved.ok) {
      return {
        ok: false,
        outcome: {
          ok: false,
          kind: "exchange_error",
          message: `Gemini account field misconfigured: ${resolved.reason}`,
          retryable: false,
          at: this.#now(),
        },
      };
    }
    // Written FIRST, so it lands immediately after `request` and `nonce` -- the
    // position in Gemini's own documented example bodies.
    return {
      ok: true,
      params: resolved.account === undefined ? [] : [["account", resolved.account]],
    };
  }

  async #request<T>(spec: RequestSpec<T>): Promise<ExchangeOutcome<T>> {
    if (spec.signed && spec.groupLevel !== true) {
      const account = this.#accountParams<T>();
      if (!account.ok) return account.outcome;
      spec = { ...spec, params: [...account.params, ...(spec.params ?? [])] };
    }

    const transport = await this.#transport(spec);

    if (!transport.reached) {
      // No reply at all. The request's effect is unknown, which for an order
      // means recovery goes through the section 5.1 idempotency records, never a
      // blind re-send.
      return classifyThrown<T>(transport.error, transport.at);
    }

    if (!transport.response.ok) {
      return classifyFailure<T>(transport.response.status, transport.at, transport.body);
    }

    // A 200 can still carry a Gemini error body in some edge cases; treat a
    // `{result:"error"}` on a 200 as the refusal it is rather than parsing it as
    // an order.
    const error = readErrorBody(transport.body);
    if (error !== undefined) {
      return classifyFailure<T>(400, transport.at, transport.body);
    }

    try {
      return ok(spec.parse(transport.body, transport.at), transport.at);
    } catch (error) {
      return this.#unreadable<T>(error, transport.at);
    }
  }

  /**
   * A successful response this code could not understand.
   *
   * Deliberately a failure, and not retryable: the same request returns the same
   * unreadable body, and section 5.6 admits only valid, successful responses into
   * strategy logic.
   */
  #unreadable<T>(error: unknown, at: Timestamp): ExchangeOutcome<T> {
    return {
      ok: false,
      kind: "exchange_error",
      message: `could not read Gemini's response: ${(error as Error).message}`,
      retryable: false,
      at,
    };
  }

  /**
   * The single place a request actually leaves this process.
   *
   * A public request is a GET with no auth. A private request is a POST with an
   * empty body and the three `X-GEMINI-*` headers; the nonce is drawn here, once
   * per request, from the monotonic generator.
   */
  async #transport<T>(spec: RequestSpec<T>): Promise<Transport> {
    const url = `${this.#baseUrl}${spec.path}`;

    let init: RequestInit;
    try {
      if (spec.signed) {
        const nonce = this.#nonce.next(this.#now());
        const headers = await this.#signer.authHeaders(spec.path, nonce, spec.params ?? []);
        init = {
          method: "POST",
          headers: {
            ...headers,
            "Content-Type": "text/plain",
            "Content-Length": "0",
            "Cache-Control": "no-cache",
          },
          signal: AbortSignal.timeout(this.#timeoutMs),
        };
      } else {
        init = { method: "GET", signal: AbortSignal.timeout(this.#timeoutMs) };
      }
    } catch (error) {
      // Signing failed locally (a blank secret slipping through, say). Nothing was
      // sent, so the exchange state is untouched; report it as a definite,
      // non-retryable refusal rather than a transport unknown.
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
