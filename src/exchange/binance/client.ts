/**
 * The Binance implementation of the exchange interface (spec section 4).
 *
 * Covers the REST surface only. The live price feed is deliberately absent:
 * section 4.6 puts that connection inside a Durable Object using the WebSocket
 * Hibernation API, so it cannot belong to a client object a Worker constructs
 * per request. This class implements `RestExchangeClient`, and the split is what
 * lets it be complete rather than a full `ExchangeClient` with one method that
 * throws.
 *
 * Every network call returns an `ExchangeOutcome`. Nothing in this file returns
 * a bare value, and nothing throws on a failed request -- section 5.6 requires
 * that "could not reach the exchange" be a value the caller must inspect, never
 * something a stop-loss could mistake for a real price or a real order state.
 *
 * Retrying is not done here. `withRetry` in the downtime module takes an
 * operation of exactly the shape these methods have, so a caller wraps the ones
 * that should be retried -- and, critically, leaves `placeOrder` alone, since
 * section 5.1 requires recovery by looking an order up rather than re-sending it.
 */

import type {
  Balance,
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
  parseSymbolFilters,
  parseTradablePairs,
  SymbolFilterCache,
  validateOrder,
  type OrderValidation,
} from "./filters";
import {
  classifyFailure,
  INVALID_TIMESTAMP_CODE,
  parseBalances,
  parseCancelledOrder,
  parseOrderResult,
  parseOrderStatus,
  parseOrderStatusList,
  parsePrice,
  parseRequestWeightLimit,
  parseServerTime,
  parseUsedWeight,
  readErrorBody,
  type RequestWeightLimit,
} from "./parse";
import {
  ClockOffset,
  DEFAULT_RESYNC_INTERVAL_MS,
  RequestSigner,
  type QueryValue,
} from "./signing";

/** Base URLs, one per environment. Section 16 keeps the two fully separate. */
export const BINANCE_BASE_URLS = {
  production: "https://api.binance.com",
  testnet: "https://testnet.binance.vision",
} as const;

/**
 * Documented request weights for the endpoints this client uses.
 *
 * Recorded now because section 5.4's budget is spent per endpoint, and step 6's
 * RateLimiter Durable Object will need these to reserve budget BEFORE a call. In
 * this step they are documentation and a single source of truth; the client
 * reports actual usage from response headers rather than estimating from these.
 */
export const ENDPOINT_WEIGHTS = {
  time: 1,
  exchangeInfo: 20,
  tickerPrice: 2,
  placeOrder: 1,
  cancelOrder: 1,
  orderStatus: 4,
  openOrders: 6,
  account: 20,
} as const;

/**
 * How long to wait for a reply.
 *
 * Longer than the exchange's own ten-second processing timeout, and that
 * ordering is deliberate. When the exchange gives up it replies with a code
 * meaning "send status unknown; execution status unknown" -- which is far more
 * informative than a locally aborted request, since it confirms the request was
 * received. Aborting first would discard that and leave an order's fate less
 * clear, not more.
 */
export const DEFAULT_TIMEOUT_MS = 15_000;

/** Default `recvWindow`. The exchange's own recommendation is 5000 or less. */
export const DEFAULT_RECV_WINDOW_MS = 5_000;

/** The subset of `fetch` this client uses, so a test can supply its own. */
export interface FetchLike {
  (input: string, init?: RequestInit): Promise<Response>;
}

/**
 * The part of the rate limiter this client touches (section 5.4).
 *
 * Narrowed to these two methods so the client can be given the real
 * `WeightBudget`, a `RateLimiter` Durable Object stub, or a recording stub. The
 * client only ever REPORTS; it does not ask permission. Gating belongs in the
 * object that can see every bot on the account, and it is applied by wrapping
 * this client (`/src/exchange/rate-limited.ts`) rather than by putting a check
 * inside a per-request object that cannot see the other bots' traffic.
 *
 * Both methods may return a promise, and the client awaits them. That is not
 * cosmetic: until step 8 the only implementation was the in-memory
 * `WeightBudget`, whose methods are synchronous, and the signature said so.
 * Reporting into a Durable Object is an RPC call, and a `void` signature would
 * have forced this file to either drop the promise on the floor -- a floating
 * promise in a Worker, which can be cancelled when the request ends -- or lie
 * about having recorded the weight.
 */
export interface WeightReporter {
  syncFromExchange(usedWeight: number, at: Timestamp): void | Promise<void>;
  /**
   * The account's ceiling, read from an `exchangeInfo` body (section 5.4).
   *
   * Optional so `WeightBudget` still satisfies this interface unchanged: it is
   * constructed with its limit and has no way to be told a new one.
   */
  syncLimit?(limit: number, windowMs: number, at: Timestamp): void | Promise<void>;
}

export interface BinanceClientOptions {
  /** One of `BINANCE_BASE_URLS`, or any override for testing. */
  baseUrl: string;
  credentials: CredentialProvider;
  /** Defaults to the runtime's global `fetch`. */
  fetch?: FetchLike;
  /** Injected so tests control time exactly. Defaults to `Date.now`. */
  now?: () => Timestamp;
  /** Told the used weight from every response's headers. */
  rateLimiter?: WeightReporter;
  filterCache?: SymbolFilterCache;
  recvWindowMs?: number;
  resyncIntervalMs?: number;
  timeoutMs?: number;
}

interface RequestSpec<T> {
  method: "GET" | "POST" | "DELETE";
  path: string;
  signed: boolean;
  params: readonly (readonly [string, QueryValue])[];
  parse: (body: unknown, at: Timestamp) => T;
}

/** Outcome of the raw transport step, before any status or body interpretation. */
type Transport =
  | { reached: true; response: Response; body: unknown; sentAt: Timestamp; receivedAt: Timestamp }
  | { reached: false; error: unknown; sentAt: Timestamp; receivedAt: Timestamp };

export class BinanceClient implements RestExchangeClient {
  readonly #baseUrl: string;
  readonly #fetch: FetchLike;
  readonly #now: () => Timestamp;
  readonly #signer: RequestSigner;
  readonly #clock = new ClockOffset();
  readonly #filters: SymbolFilterCache;
  readonly #rateLimiter: WeightReporter | undefined;
  readonly #recvWindowMs: number;
  readonly #resyncIntervalMs: number;
  readonly #timeoutMs: number;
  #syncInFlight: Promise<ExchangeOutcome<number>> | null = null;

  constructor(options: BinanceClientOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
    this.#now = options.now ?? (() => Date.now());
    this.#signer = new RequestSigner(options.credentials);
    this.#filters = options.filterCache ?? new SymbolFilterCache();
    this.#rateLimiter = options.rateLimiter;
    this.#recvWindowMs = options.recvWindowMs ?? DEFAULT_RECV_WINDOW_MS;
    this.#resyncIntervalMs = options.resyncIntervalMs ?? DEFAULT_RESYNC_INTERVAL_MS;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** Exposed so a caller can inspect drift without triggering a request. */
  get clock(): ClockOffset {
    return this.#clock;
  }

  /** Exposed so step 6 can share one filter cache across bots on a pair. */
  get filterCache(): SymbolFilterCache {
    return this.#filters;
  }

  // -------------------------------------------------------------------------
  // Section 4.1 surface
  // -------------------------------------------------------------------------

  async getServerTime(): Promise<ExchangeOutcome<number>> {
    return this.#syncClock();
  }

  /**
   * Symbol filters, and -- as a side effect -- the account's weight ceiling.
   *
   * `exchangeInfo` carries a top-level `rateLimits` block alongside the symbol
   * definitions, and section 5.4 names it as one of the two sources for the
   * budget. Reading it here rather than in a request of its own means the
   * ceiling is refreshed by traffic the system already had to send: the filter
   * cache expires hourly (section 4.3 requires periodic refresh), so the limit
   * is re-read on that same schedule for no additional weight.
   */
  async getSymbolFilters(pair: Pair): Promise<ExchangeOutcome<SymbolFilters>> {
    // Captured from inside `parse`, which is the only place the raw body is in
    // scope. `#request` hands back the parsed value alone, deliberately.
    let weightLimit: RequestWeightLimit | undefined;

    const outcome = await this.#request<SymbolFilters>({
      method: "GET",
      path: "/api/v3/exchangeInfo",
      signed: false,
      params: [["symbol", pair]],
      parse: (body, at) => {
        weightLimit = parseRequestWeightLimit(body);
        const symbols = (body as Record<string, unknown> | null)?.["symbols"];
        const entry = Array.isArray(symbols) ? symbols[0] : undefined;
        if (entry === undefined) {
          throw new Error(`exchangeInfo returned no entry for ${pair}`);
        }
        return parseSymbolFilters(entry as Record<string, unknown>, at);
      },
    });

    if (outcome.ok) {
      this.#filters.put(outcome.value);
      if (weightLimit !== undefined) {
        await this.#rateLimiter?.syncLimit?.(
          weightLimit.limit,
          weightLimit.windowMs,
          outcome.at,
        );
      }
    }
    return outcome;
  }

  async getCurrentPrice(pair: Pair): Promise<ExchangeOutcome<Price>> {
    return this.#request<Price>({
      method: "GET",
      path: "/api/v3/ticker/price",
      signed: false,
      params: [["symbol", pair]],
      parse: (body, at) => parsePrice(body, at),
    });
  }

  /**
   * Every currently-tradable pair, from the full `exchangeInfo` catalogue.
   *
   * The SAME endpoint as `getSymbolFilters` but with no `symbol` parameter, so
   * the response carries every symbol on the venue rather than one. Unsigned,
   * like the other Tier 0 reads. `parseTradablePairs` keeps only `TRADING`
   * symbols, which is exactly the set a create-bot form may offer.
   */
  async listTradablePairs(): Promise<ExchangeOutcome<Pair[]>> {
    return this.#request<Pair[]>({
      method: "GET",
      path: "/api/v3/exchangeInfo",
      signed: false,
      params: [],
      parse: (body) => parseTradablePairs(body),
    });
  }

  /**
   * Place a limit order, re-validating it first.
   *
   * This is section 4.3's SECOND check, the one it calls independent and
   * requires immediately before the request goes out. It runs in `verify` mode,
   * so a price that is no longer on the tick grid is reported rather than
   * quietly re-rounded -- if the value changed between construction and here,
   * that is a bug to surface, and repairing it would hide it.
   *
   * If the filters cannot be obtained at all, the order is not sent. Sending an
   * unvalidatable order would mean guessing, and section 5.6 is explicit that an
   * unreachable exchange is not an answer.
   */
  async placeOrder(order: OrderRequest): Promise<ExchangeOutcome<OrderResult>> {
    const filters = await this.#filtersFor(order.pair);
    if (!filters.ok) return filters;

    const validation = validateOrder(
      {
        pair: order.pair,
        side: order.side,
        price: order.price,
        quantity: order.quantity,
      },
      filters.value,
      { rounding: "verify" },
    );

    if (!validation.valid) {
      return this.#rejectedLocally<OrderResult>(validation);
    }

    return this.#request<OrderResult>({
      method: "POST",
      path: "/api/v3/order",
      signed: true,
      params: [
        ["symbol", order.pair],
        ["side", order.side === "buy" ? "BUY" : "SELL"],
        ["type", "LIMIT"],
        // Good-til-cancelled, the only sensible force for the resting ladder
        // orders sections 6.2 and 6.3 place. Section 4.5 rules out market
        // orders, and an immediate-or-cancel limit would defeat a grid.
        ["timeInForce", "GTC"],
        ["quantity", toTrimmedString(validation.quantity)],
        ["price", toTrimmedString(validation.price)],
        // The deterministic id from section 5.1. The exchange rejects a reused
        // one, which is the second layer of duplicate protection.
        ["newClientOrderId", order.clientOrderId],
      ],
      parse: (body) => parseOrderResult(body),
    });
  }

  /**
   * Cancel an order and return where it finished.
   *
   * The reply echoes the cancelled order, including how much of it had filled at
   * the instant the cancel took effect. Section 7.2's halt cancels every open
   * order for a bot, and some will be partially filled at that moment, so that
   * quantity is what determines the position the halted bot is left holding.
   * Reading it from this response avoids a follow-up status call per order --
   * which would be slower exactly when speed matters, and racy, since a resting
   * order can fill again in between.
   */
  async cancelOrder(
    pair: Pair,
    clientOrderId: string,
  ): Promise<ExchangeOutcome<OrderStatus>> {
    return this.#request<OrderStatus>({
      method: "DELETE",
      path: "/api/v3/order",
      signed: true,
      params: [
        ["symbol", pair],
        ["origClientOrderId", clientOrderId],
      ],
      // Not parseOrderStatus: the cancellation payload identifies the cancelled
      // order by `origClientOrderId`, while its `clientOrderId` names the cancel
      // request itself. See parseCancelledOrder.
      parse: (body) => parseCancelledOrder(body),
    });
  }

  async getOrderStatus(
    pair: Pair,
    clientOrderId: string,
  ): Promise<ExchangeOutcome<OrderStatus>> {
    return this.#request<OrderStatus>({
      method: "GET",
      path: "/api/v3/order",
      signed: true,
      params: [
        ["symbol", pair],
        ["origClientOrderId", clientOrderId],
      ],
      parse: (body) => parseOrderStatus(body),
    });
  }

  async getOpenOrders(pair: Pair): Promise<ExchangeOutcome<OrderStatus[]>> {
    return this.#request<OrderStatus[]>({
      method: "GET",
      path: "/api/v3/openOrders",
      signed: true,
      params: [["symbol", pair]],
      parse: (body) => parseOrderStatusList(body),
    });
  }

  async getAccountBalances(): Promise<ExchangeOutcome<Balance[]>> {
    return this.#request<Balance[]>({
      method: "GET",
      path: "/api/v3/account",
      signed: true,
      params: [],
      parse: (body) => parseBalances(body),
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
   * Classified as an exchange error rather than a transport one, and explicitly
   * not retryable: the order is invalid as constructed, and re-sending the same
   * invalid order would fail identically while spending rate-limit budget.
   * Section 4.3 asks for the reason to be logged and the action skipped, and the
   * reason travels in the outcome for the caller to log.
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
   * Fetch server time and fold it into the offset (section 4.2).
   *
   * Concurrent callers share one in-flight request. Without that, a burst of
   * signed calls on a cold client would each fire their own sync, spending
   * weight on a value they would all compute identically.
   */
  #syncClock(): Promise<ExchangeOutcome<number>> {
    const existing = this.#syncInFlight;
    if (existing !== null) return existing;

    const run = (async (): Promise<ExchangeOutcome<number>> => {
      const transport = await this.#transport("GET", "/api/v3/time", "", false);

      if (!transport.reached) {
        return classifyThrown<number>(transport.error, transport.receivedAt);
      }

      await this.#reportWeight(transport.response, transport.receivedAt);

      if (!transport.response.ok) {
        return classifyFailure<number>(
          transport.response.status,
          transport.receivedAt,
          transport.body,
        );
      }

      try {
        const serverTimeMs = parseServerTime(transport.body);
        this.#clock.record({
          serverTimeMs,
          sentAt: transport.sentAt,
          receivedAt: transport.receivedAt,
        });
        return ok(serverTimeMs, transport.receivedAt);
      } catch (error) {
        return this.#unreadable<number>(error, transport.receivedAt);
      }
    })();

    this.#syncInFlight = run;
    // Cleared however it settles, so a failed sync does not pin a stale promise
    // and block every later attempt.
    return run.finally(() => {
      this.#syncInFlight = null;
    });
  }

  /** Ensure the clock is synced and fresh enough to sign with. */
  async #ensureClock(): Promise<ExchangeOutcome<number> | null> {
    if (!this.#clock.needsRefresh(this.#now(), this.#resyncIntervalMs)) {
      return null;
    }

    const synced = await this.#syncClock();
    if (synced.ok) return null;

    // Refuse to sign with an unverified clock. If a previous sync succeeded the
    // offset is still usable, so a failed REFRESH is not fatal -- only never
    // having synced at all is.
    return this.#clock.isSynced ? null : synced;
  }

  async #request<T>(spec: RequestSpec<T>): Promise<ExchangeOutcome<T>> {
    let query: string;

    if (spec.signed) {
      const blocked = await this.#ensureClock();
      if (blocked !== null) return blocked as ExchangeOutcome<T>;

      try {
        query = await this.#signer.signQuery([
          ...spec.params,
          ["recvWindow", this.#recvWindowMs],
          ["timestamp", this.#clock.timestampFor(this.#now())],
        ]);
      } catch (error) {
        // Signing failed locally: a blank secret, or an unsynced clock slipping
        // through. Nothing was sent, so the exchange state is untouched.
        return {
          ok: false,
          kind: "exchange_error",
          message: `could not sign the request: ${(error as Error).message}`,
          retryable: false,
          at: this.#now(),
        };
      }
    } else {
      query = new URLSearchParams(
        spec.params
          .filter(([, value]) => value !== undefined)
          .map(([key, value]) => [key, String(value)]),
      ).toString();
    }

    const transport = await this.#transport(spec.method, spec.path, query, spec.signed);

    if (!transport.reached) {
      // No reply at all. The request's effect is unknown, which for an order
      // means recovery goes through the section 5.1 idempotency records.
      return classifyThrown<T>(transport.error, transport.receivedAt);
    }

    await this.#reportWeight(transport.response, transport.receivedAt);

    if (!transport.response.ok) {
      const error = readErrorBody(transport.body);
      if (error?.code === INVALID_TIMESTAMP_CODE) {
        // The offset is wrong or has drifted. Drop it so the next signed
        // request re-syncs rather than repeating the same rejected timestamp.
        this.#clock.clear();
      }
      return classifyFailure<T>(
        transport.response.status,
        transport.receivedAt,
        transport.body,
      );
    }

    try {
      return ok(spec.parse(transport.body, transport.receivedAt), transport.receivedAt);
    } catch (error) {
      return this.#unreadable<T>(error, transport.receivedAt);
    }
  }

  /**
   * A successful response this code could not understand.
   *
   * Deliberately a failure. A 200 whose body does not parse tells us nothing
   * usable about a price or an order, and section 5.6 admits only valid,
   * successful responses into strategy logic. Not retryable: the same request
   * would return the same unreadable body.
   */
  #unreadable<T>(error: unknown, at: Timestamp): ExchangeOutcome<T> {
    return {
      ok: false,
      kind: "exchange_error",
      message: `could not read the exchange's response: ${(error as Error).message}`,
      retryable: false,
      at,
    };
  }

  /**
   * Feed the response's used-weight header to the rate limiter (section 5.4).
   *
   * Awaited rather than fired and forgotten. When the reporter is a Durable
   * Object stub this is a network call, and a dropped promise in a Worker can
   * be cancelled the moment the surrounding request finishes -- which would
   * lose exactly the correction that matters most, the one following a 429.
   */
  async #reportWeight(response: Response, at: Timestamp): Promise<void> {
    if (this.#rateLimiter === undefined) return;
    const used = parseUsedWeight(response.headers);
    // Reported for failures too, and especially for them: a 429 is precisely
    // when the exchange's own count matters more than local accounting.
    if (used !== undefined) await this.#rateLimiter.syncFromExchange(used, at);
  }

  /**
   * The single place a request actually leaves this process.
   *
   * Returns the timing either side of the call, because the clock sync needs
   * both to place the exchange's reported time against a local midpoint.
   */
  async #transport(
    method: "GET" | "POST" | "DELETE",
    path: string,
    query: string,
    signed: boolean,
  ): Promise<Transport> {
    const url = query === "" ? `${this.#baseUrl}${path}` : `${this.#baseUrl}${path}?${query}`;

    const headers: Record<string, string> = {};
    if (signed) headers["X-MBX-APIKEY"] = this.#signer.apiKey;

    const sentAt = this.#now();
    try {
      const response = await this.#fetch(url, {
        method,
        headers,
        signal: AbortSignal.timeout(this.#timeoutMs),
      });

      // Read the body before anything else can fail, so a non-JSON error page
      // becomes `undefined` rather than an exception that masks the status.
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        body = undefined;
      }

      return { reached: true, response, body, sentAt, receivedAt: this.#now() };
    } catch (error) {
      return { reached: false, error, sentAt, receivedAt: this.#now() };
    }
  }
}
