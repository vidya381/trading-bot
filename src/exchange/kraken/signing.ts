/**
 * Request signing for Kraken (spec section 23.3 touchpoint 1, decision log
 * entry 90).
 *
 * Kraken's scheme is a THIRD distinct mechanism, not a variation on either
 * existing signer. Confirmed against Kraken's own Spot REST authentication
 * reference (docs.kraken.com/api/docs/guides/spot-rest-auth) rather than
 * assumed from Binance's or Gemini's shape:
 *
 *   API-Sign = base64( HMAC-SHA512( uriPath + SHA256(nonce + body),
 *                                   base64_decode(apiSecret) ) )
 *
 * Read that as bytes, because it is a byte operation at every step:
 *
 *   1. `nonce + body` is STRING concatenation -- the decimal nonce written out,
 *      immediately followed by the URL-encoded POST body, which itself starts
 *      with `nonce=<the same nonce>`. The nonce therefore appears twice, and
 *      that is correct, not a transcription slip.
 *   2. That string is SHA-256'd to 32 RAW BYTES. The digest is never hex-encoded
 *      and never base64-encoded before the next step.
 *   3. The URI path's UTF-8 bytes are prepended to those 32 raw bytes. This is a
 *      byte concatenation, not a string one -- the digest is not text and has no
 *      valid string form to concatenate.
 *   4. Those bytes are HMAC-SHA512'd, and the resulting 64 bytes are base64'd.
 *
 * THREE DEPARTURES FROM BOTH EXISTING SIGNERS, each a silent-failure risk. Every
 * one of them produces a perfectly well-formed signature that Kraken simply
 * rejects with `EAPI:Invalid signature` -- an error that names none of them:
 *
 *   - TWO COMPOSED HASHES rather than one. Binance and Gemini each apply a
 *     single HMAC to a single string.
 *   - THE SECRET IS BASE64-DECODED TO RAW BYTES before it becomes the HMAC key.
 *     Binance and Gemini both `TextEncoder().encode()` the secret directly, i.e.
 *     they use the secret's own characters as key bytes. Doing that here yields
 *     an 88-byte key from the 88 base64 characters instead of the intended 64
 *     raw bytes, and every signature is wrong. `decodeApiSecret` below exists to
 *     make this step impossible to skip or misread.
 *   - THE OUTPUT IS BASE64, not hex. Both existing signers hex-encode.
 *
 * And one discipline shared with the Gemini side: the bytes that are SIGNED must
 * be byte-identical to the bytes that are SENT. `signedRequest` therefore returns
 * the body it signed, so a caller cannot rebuild the body independently and
 * drift from it.
 *
 * NONCE, NOT CLOCK DRIFT. Kraken authenticates with an increasing unsigned
 * 64-bit nonce per API key, which is Gemini's contract exactly, so section 4.2's
 * `ClockOffset` / `getServerTime` / safety-margin machinery has NO role here.
 * `NonceGenerator` is re-exported from the Gemini signer unchanged rather than
 * reimplemented -- entry 90 established the contracts match, and two copies of a
 * monotonic counter would be two things to keep in agreement. (Kraken does
 * publish `/0/public/Time`, unlike Gemini, so the client's `getServerTime` can
 * return a real value; that is a data endpoint, not a signing input.)
 *
 * Nothing in this file performs I/O.
 */

/**
 * A value that may appear in a Kraken POST body.
 *
 * Mirrors Binance's `QueryValue`: `number` is permitted only for genuinely
 * integral, non-monetary values -- the nonce, and nothing else in practice.
 * Prices and quantities arrive as strings already rendered from `Money`, exactly
 * as on both existing venues, so no monetary value ever passes through a float.
 */
export type BodyValue = string | number | boolean | undefined;

export class SigningError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SigningError";
  }
}

/**
 * The nonce generator, reused from the Gemini signer.
 *
 * Not a re-implementation: entry 90 established that Kraken's nonce rule ("an
 * always increasing, unsigned 64-bit integer", per API key) is the same contract
 * `NonceGenerator` already satisfies for Gemini, and the scope caveat documented
 * there applies here identically -- one generator instance orders the traffic
 * that passes through it, and two isolates sharing one key is a property of the
 * key rather than something a per-request object can guarantee.
 */
export { NonceGenerator } from "../gemini/signing";

/** The Content-Type a signed Kraken request must be sent with.
 *
 * Not one of the auth headers, but not optional either: the signature covers the
 * URL-encoded body, so sending those same characters under any other encoding
 * (JSON, multipart) means Kraken reconstructs different bytes and the signature
 * fails to verify. Named here, beside the code that builds the body, rather than
 * left as a literal at the call site. */
export const KRAKEN_FORM_CONTENT_TYPE = "application/x-www-form-urlencoded";

/**
 * Build the POST body that will be both sent and signed.
 *
 * `nonce` is written FIRST, then the remaining parameters in the order given.
 * Two reasons, and only the first is Kraken's:
 *
 *   - Kraken requires the nonce as a body parameter on every private request.
 *   - Writing it first matches Kraken's own worked example byte for byte, and
 *     lets `sign` cheaply verify that the nonce it was handed is the nonce the
 *     body carries (see there). Kraken accepts any parameter order; this file
 *     picks one and holds to it so that check is possible.
 *
 * Order is otherwise preserved exactly as given and deliberately not sorted, for
 * the same reason as on both existing venues: the signature covers the literal
 * string sent, so the string signed and the string sent must be byte-identical,
 * and building it once is the only way to guarantee that.
 *
 * `undefined` values are dropped, so an optional parameter can be passed through
 * without a conditional at every call site.
 */
export function buildBody(
  nonce: number,
  params: readonly (readonly [string, BodyValue])[] = [],
): string {
  const search = new URLSearchParams();
  search.append("nonce", String(nonce));
  for (const [key, value] of params) {
    if (value === undefined) continue;
    search.append(key, String(value));
  }
  // URLSearchParams percent-encodes UTF-8, which is what Kraken requires of any
  // non-ASCII character in the body before signing.
  return search.toString();
}

/**
 * Base64 alphabet with mandatory padding.
 *
 * Padding is REQUIRED rather than tolerated. Kraken issues 64-byte secrets, so a
 * correctly copied secret is always 88 characters ending in `==`; a value whose
 * length is not a multiple of four is a truncated or mis-pasted copy, and saying
 * so here is worth more than an `EAPI:Invalid signature` from the venue.
 */
const BASE64_SECRET_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * Decode a Kraken API secret to the raw bytes used as the HMAC key.
 *
 * THIS IS THE STEP THAT DIFFERS FROM EVERY OTHER SIGNER IN THIS CODEBASE, and it
 * fails silently if skipped: `TextEncoder().encode(secret)` -- what Binance and
 * Gemini do -- also returns a `Uint8Array`, also imports as a valid HMAC key, and
 * also produces a signature. Just not one Kraken accepts. So it is a named,
 * separately tested function rather than a line inside `#key()`.
 *
 * WHAT THIS CANNOT CATCH, stated so it is not mistaken for a guarantee: a secret
 * that is well-formed base64 but belongs to a different venue decodes perfectly
 * and signs perfectly, and only Kraken can tell you it is wrong. Binance's
 * example secret is 64 alphanumeric characters, so it IS valid base64 and decodes
 * (to 48 bytes, which is not the 64 Kraken issues). No decoded LENGTH is enforced
 * here: HMAC accepts a key of any length, and hard-coding today's Kraken key size
 * would reject a legitimately different secret if the venue ever changed it. This
 * function's job is to make the DECODE unmissable, not to authenticate the key.
 *
 * The secret's VALUE never appears in an error message here, matching the rule
 * `credentials.ts` states. The character COUNT does, because a truncated paste is
 * by far the most common cause of a malformed secret and the count is what
 * identifies it; a length is not the secret.
 */
export function decodeApiSecret(apiSecret: string): Uint8Array {
  const trimmed = apiSecret.trim();

  if (trimmed === "") {
    throw new SigningError(
      "the Kraken API secret is blank; Kraken's signature is HMAC-SHA512 over " +
        "the base64-DECODED secret, and there is nothing to decode",
    );
  }

  if (trimmed.length % 4 !== 0 || !BASE64_SECRET_PATTERN.test(trimmed)) {
    throw new SigningError(
      `the Kraken API secret is not valid base64 (${trimmed.length} characters). ` +
        `Unlike the Binance and Gemini secrets, Kraken's is base64 that must ` +
        `DECODE to the raw HMAC key, so it can only contain A-Z a-z 0-9 + / and ` +
        `trailing "=" padding, and its length must be a multiple of 4. Kraken ` +
        `issues a 64-byte secret, so a correctly copied value is 88 characters ` +
        `ending in "==" -- a shorter one is usually a truncated paste. The secret ` +
        `itself is not shown here.`,
    );
  }

  let binary: string;
  try {
    binary = atob(trimmed);
  } catch {
    // Belt and braces: the pattern above should have caught anything atob
    // rejects, but a decode failure must not surface as a raw DOMException that
    // says nothing about which secret or why.
    throw new SigningError(
      `the Kraken API secret failed to base64-decode (${trimmed.length} ` +
        `characters). The secret itself is not shown here.`,
    );
  }

  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

/** Base64-encode raw digest bytes, the encoding Kraken's `API-Sign` uses. */
function toBase64(digest: ArrayBuffer): string {
  let binary = "";
  for (const byte of new Uint8Array(digest)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** Concatenate two byte runs. Used for `uriPath || SHA256(...)`, which cannot be
 *  done as a string: the digest is raw bytes with no valid text form. */
function concatBytes(head: Uint8Array, tail: Uint8Array): Uint8Array {
  const out = new Uint8Array(head.length + tail.length);
  out.set(head, 0);
  out.set(tail, head.length);
  return out;
}

/** The two authentication headers Kraken reads off a private request. */
export interface KrakenAuthHeaders {
  "API-Key": string;
  "API-Sign": string;
}

/**
 * A signed private request: the exact body that was signed, and its headers.
 *
 * The body is returned rather than left to the caller to rebuild, because the
 * signature covers those literal bytes. A caller that regenerated the body would
 * be one parameter-order change away from a signature that verifies against a
 * body it never sent.
 */
export interface SignedKrakenRequest {
  /** The URI path signed, e.g. `/0/private/AddOrder`. Also the path to POST to. */
  readonly path: string;
  /** The exact URL-encoded body that was signed. Send these bytes unmodified. */
  readonly body: string;
  /** The nonce carried in `body` and folded into the signature. */
  readonly nonce: number;
  readonly headers: KrakenAuthHeaders;
}

/**
 * Signs private requests for one Kraken account.
 *
 * Holds an imported `CryptoKey` rather than re-importing per request, keyed on
 * the credentials object's identity so a provider that returns a fresh object
 * after a key rotation re-imports automatically instead of signing with the
 * retired key. That much mirrors `RequestSigner` and `GeminiSigner` exactly. What
 * differs is what gets imported (raw bytes decoded FROM the secret, not the
 * secret's own characters), the hash (SHA-512), and the two-stage message.
 */
export class KrakenSigner {
  readonly #getCredentials: () => { apiKey: string; apiSecret: string };
  #cachedKey: Promise<CryptoKey> | null = null;
  #cachedFor: object | null = null;

  constructor(provider: { getCredentials(): { apiKey: string; apiSecret: string } }) {
    this.#getCredentials = () => provider.getCredentials();
  }

  /** The key identifying the account, sent in `API-Key`; never signed. */
  get apiKey(): string {
    return this.#getCredentials().apiKey;
  }

  /**
   * `base64(HMAC-SHA512(uriPath + SHA256(nonce + body), base64_decode(secret)))`.
   *
   * The body is signed exactly as given -- no re-encoding, no reordering, no
   * normalising.
   *
   * The nonce is passed separately from the body even though the body already
   * contains it, because Kraken's algorithm genuinely needs it twice (see this
   * file's header). Passing it twice creates one way to get it wrong -- signing
   * with a nonce the body does not carry, which yields a valid-looking signature
   * Kraken rejects -- so that specific mismatch is refused here rather than at
   * the venue.
   */
  async sign(uriPath: string, nonce: number, body: string): Promise<string> {
    // The boundary matters: `nonce=1616492376` is a prefix of
    // `nonce=1616492376594&...`, so a bare `startsWith` would accept a truncated
    // nonce and sign it against a body carrying a different one -- exactly the
    // mismatch this check exists to refuse. The field must end at `&` or at the
    // end of the body.
    const expectedPrefix = `nonce=${nonce}`;
    if (body !== expectedPrefix && !body.startsWith(`${expectedPrefix}&`)) {
      throw new SigningError(
        `the body to sign must begin with ${JSON.stringify(expectedPrefix)}: ` +
          `Kraken folds the nonce into the signature AND requires it as a body ` +
          `parameter, so signing with a nonce the body does not carry produces a ` +
          `well-formed signature that Kraken rejects with EAPI:Invalid signature. ` +
          `Build the body with buildBody(nonce, ...), or use signedRequest(), ` +
          `which cannot get this wrong.`,
      );
    }

    const key = await this.#key();
    const encoder = new TextEncoder();

    // Stage 1: SHA-256 over the nonce and body as one string, kept as RAW bytes.
    const inner = await crypto.subtle.digest(
      "SHA-256",
      encoder.encode(`${nonce}${body}`),
    );

    // Stage 2: HMAC-SHA512 over the path's bytes followed by those raw bytes.
    const message = concatBytes(encoder.encode(uriPath), new Uint8Array(inner));
    const digest = await crypto.subtle.sign("HMAC", key, message);

    return toBase64(digest);
  }

  /**
   * Build a private request's body and its two auth headers in one step.
   *
   * The path to sign is the full URI path Kraken serves the endpoint at
   * (`/0/private/AddOrder`), not a bare endpoint name -- it is signed literally.
   *
   * The nonce is generated by the caller and passed in, so the signing path has
   * no hidden clock and stays exactly reproducible in a test. This mirrors
   * `GeminiSigner.authHeaders`.
   */
  async signedRequest(
    path: string,
    nonce: number,
    params: readonly (readonly [string, BodyValue])[] = [],
  ): Promise<SignedKrakenRequest> {
    const body = buildBody(nonce, params);
    const signature = await this.sign(path, nonce, body);
    return {
      path,
      body,
      nonce,
      headers: {
        "API-Key": this.apiKey,
        "API-Sign": signature,
      },
    };
  }

  #key(): Promise<CryptoKey> {
    const credentials = this.#getCredentials();
    if (this.#cachedKey !== null && this.#cachedFor === credentials) {
      return this.#cachedKey;
    }

    // Decoded, NOT TextEncoder-encoded. See `decodeApiSecret`. This throws
    // synchronously on a malformed secret, before anything is cached, so a bad
    // secret never leaves a permanently rejected promise behind.
    const keyBytes = decodeApiSecret(credentials.apiSecret);

    const imported = crypto.subtle.importKey(
      "raw",
      keyBytes,
      { name: "HMAC", hash: "SHA-512" },
      false, // not extractable: the secret cannot be read back out of the key
      ["sign"],
    );

    this.#cachedKey = imported;
    this.#cachedFor = credentials;
    return imported;
  }
}
