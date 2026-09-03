/**
 * Exchange API credentials, as an injected port.
 *
 * The exchange client never reads `env` and never touches `wrangler secret`.
 * Two reasons, and the second is the one that matters:
 *
 *  1. `wrangler secret` values do not exist on a developer machine, so a client
 *     that read them directly could not be tested without either inventing fake
 *     secrets in local config or skipping the tests that need credentials.
 *  2. Depending on a binding would tie the client to the Worker runtime. Nothing
 *     about signing a request needs a Worker, and section 13's backtest mode has
 *     no `env` at all.
 *
 * The real, secret-backed implementation is a thin wrapper over `env`, added at
 * the point this actually deploys. It is deliberately not here: there is nothing
 * to test about it, and section 16.1 is explicit that production secrets are set
 * by hand and never live in a config file.
 */

/**
 * One exchange account's key pair.
 *
 * Per section 4.4 these keys must be created with TRADING permission only, never
 * withdrawal -- that restriction is the primary safeguard for v1, since Workers
 * have no static outbound IP to whitelist. Nothing in code can verify it; it is
 * enforced when the key is created on the exchange.
 */
export interface ExchangeCredentials {
  /** Sent as a header to identify the account. Not a secret in the same sense
   *  as the secret key, but still not something to log. */
  readonly apiKey: string;
  /** The HMAC signing key. Never logged, never included in an error message. */
  readonly apiSecret: string;
}

/**
 * Supplies credentials for one exchange account.
 *
 * Synchronous: every implementation either holds the values already or reads
 * them from a binding, and neither requires I/O. Keeping it synchronous means
 * the signing path has no await that exists purely to fetch a key.
 */
export interface CredentialProvider {
  getCredentials(): ExchangeCredentials;
}

export class CredentialError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CredentialError";
  }
}

/**
 * Reject a key that is missing or blank.
 *
 * An empty secret would otherwise produce a perfectly well-formed HMAC over an
 * empty key, and the request would fail at the exchange with a signature error
 * that says nothing about the real cause. Failing here names it.
 *
 * The value itself never appears in the error message.
 */
function requireNonBlank(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new CredentialError(
      `${field} is missing or blank; the exchange client cannot sign requests ` +
        `without it`,
    );
  }
  return value;
}

/**
 * Credentials held directly in memory.
 *
 * The implementation the fake and the eventual secret-backed wrapper both use:
 * the wrapper's whole job is to read two values off `env` and hand them here.
 */
export class StaticCredentialProvider implements CredentialProvider {
  readonly #credentials: ExchangeCredentials;

  constructor(credentials: { apiKey: string; apiSecret: string }) {
    this.#credentials = Object.freeze({
      apiKey: requireNonBlank(credentials.apiKey, "apiKey"),
      apiSecret: requireNonBlank(credentials.apiSecret, "apiSecret"),
    });
  }

  getCredentials(): ExchangeCredentials {
    return this.#credentials;
  }
}

/**
 * The example key pair from BINANCE's own signing documentation.
 *
 * Published by the exchange purely to illustrate the signing algorithm, and
 * accompanied there by a worked example with an expected signature. Using this
 * pair is what lets the signing tests assert against the exchange's own stated
 * output rather than against this implementation's -- a test that computes the
 * expected value the same way the code does would pass even if both were wrong.
 *
 * These are not credentials for any account.
 */
export const DOCUMENTED_EXAMPLE_CREDENTIALS: ExchangeCredentials = Object.freeze({
  apiKey: "vmPUZE6mv9SD5VNHk4HlWFsOr6aKE2zvsw0MuIgwCIPy6utIco14y7Ju91duEh8A",
  apiSecret: "NhqPtmdSJYdKjVHjA7PZj4Mge3R5YNiP1e3UZjInClVN65XAbvqqM6A7H5fATj0j",
});

/**
 * The example key pair from KRAKEN's own signing documentation.
 *
 * A separate constant rather than a reuse of the one above, because the two
 * venues' worked examples are not interchangeable: Kraken's secret is base64
 * that DECODES to the 64-byte HMAC key, while Binance's is used as its own
 * characters. Binance's example secret is not valid base64 at all, so it cannot
 * stand in here, and Kraken's expected signature only reproduces against Kraken's
 * own secret.
 *
 * `apiSecret` and the accompanying vector in `kraken/signing.test.ts` are quoted
 * verbatim from Kraken's Spot REST authentication guide
 * (docs.kraken.com/api/docs/guides/spot-rest-auth), where all three of its
 * language samples share these values so an implementer can check their output
 * before going near production. Confirmed against that page and against Kraken's
 * support article on the authentication algorithm, then reproduced independently
 * with `openssl` -- not taken from memory.
 *
 * `apiKey` is a PLACEHOLDER and is marked as one. Kraken publishes no example
 * public key, and unlike the secret it is not an input to the signature -- it
 * travels in the `API-Key` header and is never signed -- so a placeholder cannot
 * weaken the vector. Inventing a realistic-looking Kraken public key here would
 * only suggest a provenance it does not have.
 *
 * These are not credentials for any account.
 */
export const KRAKEN_DOCUMENTED_EXAMPLE_CREDENTIALS: ExchangeCredentials = Object.freeze({
  apiKey: "kraken-example-public-key-not-published-by-kraken",
  apiSecret:
    "kQH5HW/8p1uGOVjbgWA7FunAmGO8lsSUXNsu3eow76sz84Q18fWxnyRzBHCd3pd5nE9qa99HAZtuZuj6F1huXg==",
});

/**
 * A credential provider for tests.
 *
 * Defaults to the documented example pair so a test that does not care about
 * credentials does not have to invent any. Nothing here reaches for a real
 * secret, so the automated suite never depends on one existing.
 */
export function fakeCredentialProvider(
  overrides: Partial<ExchangeCredentials> = {},
): CredentialProvider {
  return new StaticCredentialProvider({
    apiKey: overrides.apiKey ?? DOCUMENTED_EXAMPLE_CREDENTIALS.apiKey,
    apiSecret: overrides.apiSecret ?? DOCUMENTED_EXAMPLE_CREDENTIALS.apiSecret,
  });
}

/**
 * A credential provider for Kraken tests.
 *
 * Separate from `fakeCredentialProvider` only because the default pair differs:
 * a Kraken signer handed Binance's example secret throws before it signs
 * anything, since that secret is not base64. Same shape, same intent, and it
 * reaches for no real secret either.
 */
export function fakeKrakenCredentialProvider(
  overrides: Partial<ExchangeCredentials> = {},
): CredentialProvider {
  return new StaticCredentialProvider({
    apiKey: overrides.apiKey ?? KRAKEN_DOCUMENTED_EXAMPLE_CREDENTIALS.apiKey,
    apiSecret: overrides.apiSecret ?? KRAKEN_DOCUMENTED_EXAMPLE_CREDENTIALS.apiSecret,
  });
}
