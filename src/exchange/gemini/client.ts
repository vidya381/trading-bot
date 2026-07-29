/**
 * The Gemini implementation of the exchange interface (spec section 4).
 *
 * A second `RestExchangeClient`, structurally parallel to `BinanceClient` but not
 * a copy of it -- Gemini's transport and payloads differ where step 3's task
 * warned they would. It coexists with Binance behind the identical interface;
 * nothing about BotInstance, the strategies or reconciliation changes, and no
 * caller can tell which exchange is underneath.
 *
 * Covers the REST surface only. `subscribeToPriceFeed` is deliberately absent for
 * the same reason as on the Binance side -- section 4.6 puts that connection in a
 * Durable Object -- so this class implements `RestExchangeClient`, the narrower
 * half, and is complete rather than a full client with one throwing method.
 *
 * The shape of the differences from Binance:
 *
 *  - EVERY private call is a POST with an EMPTY body; the signed base64 payload
 *    and the signature ride in headers (`gemini/signing.ts`). There is no signed
 *    query string.
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
  parseCancelledOrder,
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
  type PayloadValue,
} from "./signing";

/** Base URLs, one per environment. Section 16 keeps the two fully separate. */
export const GEMINI_BASE_URLS = {
  production: "https://api.gemini.com",
  sandbox: "https://api.sandbox.gemini.com",
} as const;

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
  readonly #nonce = new NonceGenerator();
  readonly #filters: SymbolFilterCache;
  readonly #timeoutMs: number;

  constructor(options: GeminiClientOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
    this.#now = options.now ?? (() => Date.now());
    this.#signer = new GeminiSigner(options.credentials);
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

  async #request<T>(spec: RequestSpec<T>): Promise<ExchangeOutcome<T>> {
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
