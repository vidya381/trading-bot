/**
 * Request signing for Gemini (spec section 4.2, Gemini's scheme).
 *
 * This is deliberately NOT a variation on Binance's signer -- Gemini's scheme is
 * a different mechanism, confirmed against Gemini's own published API reference
 * (developer.gemini.com) rather than assumed from Binance's shape:
 *
 *   1. The request parameters are collected into a JSON object that also carries
 *      the endpoint path under `request` and a `nonce` -- plus, for a MASTER key,
 *      a top-level `account` naming which account in the group to act on
 *      (`resolveAccountField` below).
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
 * Which kind of key a Gemini API key is, read off its documented prefix.
 *
 * Gemini's API-key reference states it plainly: "Master API keys are formatted
 * with a prepending `master-`, while account level API keys are formatted with a
 * prepending `account-`." That prefix is the ONLY local signal for whether the
 * `account` payload field (below) is required, forbidden, or unknowable, so it is
 * read here rather than inferred from a rejection.
 *
 * `"unknown"` is a real answer, not a failure: a key that carries neither prefix
 * cannot be classified locally, and this returns that rather than guessing.
 */
export type GeminiKeyScope = "master" | "account" | "unknown";

export function geminiKeyScope(apiKey: string): GeminiKeyScope {
  if (apiKey.startsWith("master-")) return "master";
  if (apiKey.startsWith("account-")) return "account";
  return "unknown";
}

/**
 * Gemini's own derivation of an account's API nickname from its display name.
 *
 * A Gemini account carries TWO different names, and the payload wants the second:
 *
 *   `name`    — the display name given at creation, e.g. `"Primary"`
 *   `account` — the API nickname, e.g. `"primary"`
 *
 * `/v1/account/list` documents exactly how the second is derived from the first:
 * *"Nickname of the specific account (will take the name given, remove all
 * symbols, replace all `" "` with `"-"` and make letters lowercase)"*, and its
 * example response shows all three of `"Primary"`->`"primary"`,
 * `"My Custody Account"`->`"my-custody-account"` and `"Other exchange account!"`
 * ->`"other-exchange-account"`.
 *
 * This function exists to CHECK a configured value, not to silently rewrite one:
 * a display name pasted where a nickname belongs is rejected with this as the
 * suggestion, rather than transformed behind the operator's back. Quietly
 * lower-casing a value that selects which real account gets traded is not a
 * correction this code is entitled to make on its own.
 *
 * Order matters and follows the sentence: symbols are removed FIRST, then spaces
 * become dashes, then letters are lower-cased. (Removing symbols after the space
 * substitution would strip the dashes it just inserted.)
 */
export function geminiAccountNickname(displayName: string): string {
  return displayName
    .replace(/[^A-Za-z0-9 ]/g, "")
    .replace(/ /g, "-")
    .toLowerCase();
}

/**
 * Whether a value could be a Gemini account nickname at all.
 *
 * Follows directly from the derivation above: a nickname is the output of that
 * function, so it can only contain lowercase letters, digits and dashes. Anything
 * else -- an upper-case letter, a space, punctuation -- cannot be a nickname
 * Gemini ever issued, which makes it locally detectable without a round trip.
 */
export function isGeminiAccountNickname(value: string): boolean {
  return /^[a-z0-9-]+$/.test(value);
}

/** Either the `account` value to send (or `undefined`: send none), or why not. */
export type AccountFieldResolution =
  | { readonly ok: true; readonly account: string | undefined }
  | { readonly ok: false; readonly reason: string };

/**
 * Decide what the `account` payload field must be for this key (Gemini's
 * sub-account rule).
 *
 * Gemini groups multiple accounts under a master group. A MASTER key is not bound
 * to one account, so every single-account private API needs to be told which one
 * to act on: per Gemini's reference, "To invoke an API on behalf of an account,
 * add that account's nickname as an `account` parameter to your request payload",
 * and "The `account` parameter may be used on any API that performs an action for
 * or against a single account." Each endpoint's own request-body table repeats it
 * -- `account`, type `string`, "Required for Master API keys ... The name of the
 * account within the subaccount group" -- and it is a TOP-LEVEL sibling of
 * `request` and `nonce`, not a nested object and not an array.
 *
 * Both directions are errors, and Gemini has a distinct error code for each:
 *
 *  - master key WITHOUT the field -> `MissingAccounts`, "A required account field
 *    was not specified". This is exactly the rejection that halted the live DCA
 *    base order; the plural in Gemini's message names the error code, not the
 *    field, which is singular `account`.
 *  - account-level key WITH the field -> `AccountsOnGroupOnlyApi`, "The account
 *    field was specified on a non-master API key".
 *
 * So the field cannot simply be sent always, and a wrong nickname is its own
 * refusal (`InvalidAccountName`, "The specified name did not match any accounts
 * within the master group"). Hence: required for a `master-` key, refused for an
 * `account-` key, and for an unclassifiable key the caller's explicit
 * configuration is trusted -- there is nothing honest to derive.
 *
 * ON GEMINI'S PLURAL, MISLEADING MESSAGES. Two of these refusals SAY "accounts"
 * while the field is `account`:
 *
 *     MissingAccounts      "Expected a JSON payload with accounts"
 *     InvalidAccountName   "Expected a JSON array with valid accounts,
 *                           instead got: Primary"
 *
 * Neither is a statement about the field's type. The plural is the ERROR CODE's
 * name and an artefact of Gemini resolving the field into an internal list --
 * which is also why sibling codes `MoreThanOneAccount`, `AccountLimitExceeded`
 * and `NoAccountOfTypeRequired` are phrased as they are. The field itself is
 * documented as `account`, type `string`, on all 65 endpoint pages that carry it,
 * with a string in every request example and not one array anywhere in Gemini's
 * reference. The second message above was earned by sending the field CORRECTLY
 * (the first no longer fires) with a wrong VALUE: the account's display `name`
 * instead of its `account` nickname. Reading either message as "send an array"
 * would be pattern-matching the prose over the specification.
 *
 * Pure: this decides, and never sends anything.
 */
export function resolveAccountField(
  apiKey: string,
  accountName: string | undefined,
): AccountFieldResolution {
  const configured = accountName?.trim();
  const named = configured !== undefined && configured !== "" ? configured : undefined;

  // A value that is not a possible nickname is refused HERE, before it can be
  // signed and sent. Gemini answers a wrong one with `InvalidAccountName` -- and
  // its message, "Expected a JSON array with valid accounts, instead got: X",
  // describes Gemini's internal list-shaped validation rather than the field's
  // documented type, so it reads like a shape complaint when it is a name
  // complaint. Catching the common case (a DISPLAY name pasted in) locally, with
  // the derived nickname as the suggestion, is worth more than the round trip.
  if (named !== undefined && !isGeminiAccountNickname(named)) {
    const suggestion = geminiAccountNickname(named);
    return {
      ok: false,
      reason:
        `${JSON.stringify(named)} cannot be a Gemini account nickname. Gemini derives ` +
        `the nickname from the account's display name by removing symbols, replacing ` +
        `spaces with "-" and lower-casing, so a nickname only ever contains ` +
        `[a-z0-9-] -- and an account's display "name" (e.g. "Primary") is NOT its ` +
        `"account" nickname (e.g. "primary"). Gemini refuses the mismatch with ` +
        `InvalidAccountName.` +
        (suggestion !== "" && suggestion !== named
          ? ` Did you mean ${JSON.stringify(suggestion)}?`
          : "") +
        ` The authoritative list of nicknames is the "account" field of Gemini's ` +
        `/v1/account/list response.`,
    };
  }

  switch (geminiKeyScope(apiKey)) {
    case "master":
      if (named === undefined) {
        return {
          ok: false,
          reason:
            `this Gemini API key is a MASTER key (its name begins "master-"), so every ` +
            `private request must carry the top-level "account" field naming which ` +
            `account in the master group to act on, and none is configured. Gemini ` +
            `refuses the request otherwise with MissingAccounts ("A required account ` +
            `field was not specified"). Set GEMINI_ACCOUNT_NAME to the account's ` +
            `nickname (Gemini's own example value is "primary"; the exact nicknames in ` +
            `a group are listed by Gemini's Get Accounts endpoint).`,
        };
      }
      return { ok: true, account: named };

    case "account":
      if (named !== undefined) {
        return {
          ok: false,
          reason:
            `an account name (${JSON.stringify(named)}) is configured, but this Gemini ` +
            `API key is an ACCOUNT-LEVEL key (its name begins "account-"), which is ` +
            `already bound to one account. Sending the "account" field on it is refused ` +
            `by Gemini with AccountsOnGroupOnlyApi ("The account field was specified on ` +
            `a non-master API key"). Unset GEMINI_ACCOUNT_NAME, or use the master key ` +
            `the name belongs to.`,
        };
      }
      return { ok: true, account: undefined };

    case "unknown":
      // Neither documented prefix, so the key's scope cannot be established here.
      // The explicit configuration is the only information available; trust it
      // rather than overriding it on a guess.
      return { ok: true, account: named };
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
