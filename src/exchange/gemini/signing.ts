/**
 * Request signing for Gemini (spec section 4.2, Gemini's scheme).
 *
 * This is deliberately NOT a variation on Binance's signer -- Gemini's scheme is
 * a different mechanism, confirmed against Gemini's own published API reference
 * (developer.gemini.com) rather than assumed from Binance's shape:
 *
 *   1. The request parameters are collected into a JSON object that also carries
 *      the endpoint path under `request` and a `nonce`.
 *   2. That JSON is UTF-8 encoded and base64-encoded -- this base64 string is the
 *      "payload".
 *   3. The signature is `hex(HMAC-SHA384(payload, apiSecret))` -- SHA-384, not
 *      SHA-256, and over the base64 payload STRING, not a query string.
 *   4. All three of the API key, the base64 payload and the hex signature travel
 *      as HTTP HEADERS (`X-GEMINI-APIKEY`, `X-GEMINI-PAYLOAD`,
 *      `X-GEMINI-SIGNATURE`). The request itself is a POST with an EMPTY body.
 *
 * The single largest divergence from Binance: there is NO clock-drift correction
 * here, and there is no `ClockOffset`. Binance signs a `timestamp` that the
 * exchange compares against its own clock, so a drifting Worker isolate is a hard
 * rejection and step 3 built an entire offset-estimator around it. Gemini instead
 * requires a `nonce` that need only "increase with respect to the session" -- a
 * monotonically rising number, not a value compared to server time. So the whole
 * of Binance's `getServerTime`/`ClockOffset`/500ms-bias machinery has no analogue
 * here; `NonceGenerator` replaces it, and it needs no I/O and no server clock.
 *
 * Nothing in this file performs I/O.
 */

import type { Timestamp } from "../../shared/exchange-client";

/**
 * A value that may appear in a signed payload.
 *
 * `readonly string[]` is admitted for Gemini's `options` array (e.g.
 * `["maker-or-cancel"]`). Prices and quantities arrive as strings already
 * rendered from `Money`, exactly as on the Binance side, so no monetary value
 * ever passes through a float here either. `number` is for integral, non-monetary
 * values only -- the nonce, and nothing else in practice.
 */
export type PayloadValue = string | number | boolean | readonly string[] | undefined;

export class SigningError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SigningError";
  }
}

/**
 * Base64-encode a UTF-8 string, the encoding Gemini expects for the payload.
 *
 * `btoa` operates on a "binary string" (one code unit per byte), so a UTF-8
 * multibyte character has to be flattened to bytes first or `btoa` throws on any
 * code point above 0xFF. Symbols and numbers are ASCII, but a client order id is
 * caller-supplied and could carry anything, so this is encoded properly rather
 * than assumed ASCII.
 */
export function toBase64Utf8(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** Render an HMAC digest as lowercase hex, the encoding Gemini's signature uses. */
function toHex(digest: ArrayBuffer): string {
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Build the base64 payload that will be both sent (in `X-GEMINI-PAYLOAD`) and
 * signed.
 *
 * `request` and `nonce` are written first and in that order, then the remaining
 * parameters in the order given. Order is preserved deliberately: the signature
 * covers the exact bytes of the base64 payload, so the JSON that is signed and
 * the JSON that is sent must be byte-identical, and building the object once from
 * an ordered list is the simplest way to guarantee that. `JSON.stringify`
 * serialises string keys in insertion order, so this order is the wire order.
 *
 * `undefined` values are dropped, so an optional parameter (a `client_order_id`,
 * an `options` array) can be passed through without a conditional at the call
 * site.
 */
export function buildPayload(
  request: string,
  nonce: number,
  params: readonly (readonly [string, PayloadValue])[] = [],
): string {
  const object: Record<string, string | number | boolean | readonly string[]> = {
    request,
    nonce,
  };
  for (const [key, value] of params) {
    if (value === undefined) continue;
    object[key] = value;
  }
  return toBase64Utf8(JSON.stringify(object));
}

/**
 * Produces strictly increasing nonces (spec section 4.2, Gemini's rule).
 *
 * Gemini requires that "the nonce has to be a number that will never be repeated
 * and must increase between requests". Milliseconds since the epoch satisfy that
 * naturally, but two requests issued inside the same millisecond would collide,
 * so the generator floors to the last-issued value plus one whenever the clock
 * has not advanced. The result is always at least the wall-clock time in ms and
 * always strictly greater than the previous nonce from this generator.
 *
 * Scope note: Gemini enforces nonce ordering per API key. A single generator
 * instance orders every request that passes through it, which covers one client
 * object's traffic. Two client objects sharing one key from separate Worker
 * isolates could still interleave -- that is an operational property of the key,
 * not something a per-request object can guarantee, and it is called out in the
 * decision log (the key should be created with session-scoped nonces, so the
 * requirement is only "increasing within a session").
 */
export class NonceGenerator {
  #last = 0;

  /** The next nonce, given the current local clock in milliseconds. */
  next(nowMs: Timestamp): number {
    const flooredNow = Math.floor(nowMs);
    const candidate = flooredNow > this.#last ? flooredNow : this.#last + 1;
    this.#last = candidate;
    return candidate;
  }

  /** The most recently issued nonce, or 0 before the first. */
  get last(): number {
    return this.#last;
  }
}

/** The three authentication headers Gemini reads off a private request. */
export interface GeminiAuthHeaders {
  "X-GEMINI-APIKEY": string;
  "X-GEMINI-PAYLOAD": string;
  "X-GEMINI-SIGNATURE": string;
}

/**
 * Signs payloads for one Gemini account.
 *
 * Holds an imported `CryptoKey` rather than re-importing per request, keyed on
 * the credentials object's identity so a provider that returns a fresh object
 * after a key rotation re-imports automatically instead of signing with the
 * retired key. This mirrors the Binance `RequestSigner` exactly, differing only
 * in the hash (SHA-384) and in what gets signed (a base64 payload, not a query
 * string).
 */
export class GeminiSigner {
  readonly #getCredentials: () => { apiKey: string; apiSecret: string };
  #cachedKey: Promise<CryptoKey> | null = null;
  #cachedFor: object | null = null;

  constructor(provider: { getCredentials(): { apiKey: string; apiSecret: string } }) {
    this.#getCredentials = () => provider.getCredentials();
  }

  /** The key identifying the account, sent in `X-GEMINI-APIKEY`; never signed. */
  get apiKey(): string {
    return this.#getCredentials().apiKey;
  }

  /**
   * `hex(HMAC-SHA384(payload, apiSecret))` over the base64 payload string.
   *
   * The payload is signed exactly as given -- the base64 string's own bytes, no
   * re-decoding, no normalising.
   */
  async sign(payloadBase64: string): Promise<string> {
    const key = await this.#key();
    const digest = await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(payloadBase64),
    );
    return toHex(digest);
  }

  /**
   * Build the base64 payload and the three headers a private request carries.
   *
   * The nonce is generated by the caller and passed in, so the signing path has
   * no hidden clock and stays exactly reproducible in a test.
   */
  async authHeaders(
    request: string,
    nonce: number,
    params: readonly (readonly [string, PayloadValue])[] = [],
  ): Promise<GeminiAuthHeaders> {
    const payload = buildPayload(request, nonce, params);
    const signature = await this.sign(payload);
    return {
      "X-GEMINI-APIKEY": this.apiKey,
      "X-GEMINI-PAYLOAD": payload,
      "X-GEMINI-SIGNATURE": signature,
    };
  }

  #key(): Promise<CryptoKey> {
    const credentials = this.#getCredentials();
    if (this.#cachedKey !== null && this.#cachedFor === credentials) {
      return this.#cachedKey;
    }

    const imported = crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(credentials.apiSecret),
      { name: "HMAC", hash: "SHA-384" },
      false, // not extractable: the secret cannot be read back out of the key
      ["sign"],
    );

    this.#cachedKey = imported;
    this.#cachedFor = credentials;
    return imported;
  }
}
