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
 * The example key pair from the exchange's own signing documentation.
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
