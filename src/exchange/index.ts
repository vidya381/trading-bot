/**
 * Exchange integration layer (spec section 4), build step 3.
 *
 * The interface itself lives in `/src/shared/exchange-client.ts` with the other
 * types strategy code depends on. Everything here is the Binance-specific half:
 * signing, endpoints, payload shapes, and filter rules.
 *
 * Kept out of `/src/shared` because these modules perform real I/O, and the
 * shared modules' guarantee that they do not is what makes them reusable
 * unchanged in section 13's backtest mode.
 */

export * from "./credentials";
export * from "./binance/signing";
export * from "./binance/filters";
export * from "./binance/parse";
export * from "./binance/client";
// The second exchange implementation (step 3.4). Same `RestExchangeClient`
// interface, different transport and payloads; it coexists with Binance and
// changes nothing about how a strategy or BotInstance calls the interface.
// `gemini/filters` re-exports the exchange-agnostic `validateOrder`/
// `SymbolFilterCache` from `binance/filters`, so those names are already exported
// above; the Gemini barrel entries below deliberately do not re-export them a
// second time (only Gemini's own `parseSymbolDetails`, `toGeminiSymbol`, etc.).
export {
  buildPayload,
  GeminiSigner,
  NonceGenerator,
  toBase64Utf8,
  SigningError as GeminiSigningError,
  type PayloadValue,
  type GeminiAuthHeaders,
} from "./gemini/signing";
export {
  parseSymbolDetails,
  toGeminiSymbol,
  FilterError as GeminiFilterError,
} from "./gemini/filters";
export {
  classifyFailure as classifyGeminiFailure,
  readErrorBody as readGeminiErrorBody,
  parseOrderStatus as parseGeminiOrderStatus,
  parseOrderResult as parseGeminiOrderResult,
  parseCancelledOrder as parseGeminiCancelledOrder,
  parseBalances as parseGeminiBalances,
  parsePrice as parseGeminiPrice,
  parseFills as parseGeminiFills,
  toOrderState as geminiOrderState,
  ParseError as GeminiParseError,
  INVALID_NONCE_REASON,
  type GeminiErrorBody,
} from "./gemini/parse";
export { GeminiClient, GEMINI_BASE_URLS, type GeminiClientOptions } from "./gemini/client";
// Section 5.4's gate. Exchange-agnostic in shape, but it carries Binance's
// per-endpoint weight table, which is why it lives here and not in /src/shared
// -- and it performs I/O, which rules /src/shared out anyway.
export * from "./rate-limited";
