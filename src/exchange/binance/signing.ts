/**
 * Request signing and clock-drift correction (spec section 4.2).
 *
 * HMAC-SHA256 over the request's own query string, via the Web Crypto API that
 * the Workers runtime provides natively. No polyfill and no dependency, per
 * section 2.
 *
 * Nothing here performs I/O. `ClockOffset` is fed samples by whoever fetched
 * them, so drift correction is exactly reproducible in a test.
 */

import type { Timestamp } from "../../shared/exchange-client";

/**
 * A query parameter value.
 *
 * `number` is permitted only for genuinely integral, non-monetary values --
 * timestamps, windows, limits. Prices and quantities arrive as strings already
 * rendered from `Money`, so no monetary value ever passes through a float.
 */
export type QueryValue = string | number | boolean | undefined;

export class SigningError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SigningError";
  }
}

/**
 * Build the query string that will be both sent and signed.
 *
 * Order is preserved exactly as given, and deliberately not sorted. The exchange
 * accepts parameters in any order, but the signature covers the literal string
 * sent -- so the string that gets signed and the string that gets sent must be
 * byte-identical, and the simplest way to guarantee that is to build it once.
 *
 * `undefined` values are dropped, so an optional parameter can be passed through
 * without a conditional at every call site.
 */
export function buildQueryString(
  params: readonly (readonly [string, QueryValue])[],
): string {
  const search = new URLSearchParams();
  for (const [key, value] of params) {
    if (value === undefined) continue;
    search.append(key, String(value));
  }
  // URLSearchParams percent-encodes UTF-8, which is what the exchange requires
  // of any non-ASCII character in the payload before signing.
  return search.toString();
}

/** Render an HMAC digest as lowercase hex, the encoding the exchange expects. */
function toHex(digest: ArrayBuffer): string {
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Signs query strings for one exchange account.
 *
 * Holds an imported `CryptoKey` rather than re-importing per request. The cache
 * is keyed on the credentials object's identity, so a provider that returns a
 * new object after a key rotation re-imports automatically instead of signing
 * with the retired key.
 */
export class RequestSigner {
  readonly #getCredentials: () => { apiKey: string; apiSecret: string };
  #cachedKey: Promise<CryptoKey> | null = null;
  #cachedFor: object | null = null;

  constructor(provider: { getCredentials(): { apiKey: string; apiSecret: string } }) {
    this.#getCredentials = () => provider.getCredentials();
  }

  /** The key identifying the account, sent as a header rather than signed. */
  get apiKey(): string {
    return this.#getCredentials().apiKey;
  }

  /**
   * HMAC-SHA256 the payload with the account's secret, hex-encoded.
   *
   * The payload is signed exactly as given -- no normalising, no reordering.
   */
  async sign(payload: string): Promise<string> {
    const key = await this.#key();
    const digest = await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(payload),
    );
    return toHex(digest);
  }

  /**
   * Build a signed query string: the payload with `signature` appended.
   *
   * Appended last because the signature covers everything before it. Anything
   * added after this returns would invalidate it.
   */
  async signQuery(
    params: readonly (readonly [string, QueryValue])[],
  ): Promise<string> {
    const payload = buildQueryString(params);
    const signature = await this.sign(payload);
    return `${payload}&signature=${signature}`;
  }

  #key(): Promise<CryptoKey> {
    const credentials = this.#getCredentials();
    if (this.#cachedKey !== null && this.#cachedFor === credentials) {
      return this.#cachedKey;
    }

    const imported = crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(credentials.apiSecret),
      { name: "HMAC", hash: "SHA-256" },
      false, // not extractable: the secret cannot be read back out of the key
      ["sign"],
    );

    this.#cachedKey = imported;
    this.#cachedFor = credentials;
    return imported;
  }
}

/** How often to re-fetch server time. Section 4.2: "every few minutes". */
export const DEFAULT_RESYNC_INTERVAL_MS = 300_000;

/**
 * How far back to bias every signed timestamp, in milliseconds.
 *
 * The exchange's own timing rule is asymmetric: a request is rejected outright
 * if its timestamp is more than one second AHEAD of server time, but it tolerates
 * lateness all the way out to `recvWindow`, which defaults to five seconds. The
 * penalty for over-estimating the offset is therefore five times closer than the
 * penalty for under-estimating it.
 *
 * Half a second of deliberate lateness costs nothing against a five-second
 * window and buys back half the margin on the side that actually bites.
 */
export const DEFAULT_SAFETY_MARGIN_MS = 500;

/** A server-time observation, with the local clock either side of the request. */
export interface ClockSample {
  /** The time the exchange reported. */
  serverTimeMs: number;
  /** Local clock immediately before the request went out. */
  sentAt: Timestamp;
  /** Local clock immediately after the reply arrived. */
  receivedAt: Timestamp;
}

/**
 * The offset between the exchange's clock and the local one (section 4.2).
 *
 * Every signed request's timestamp is the local clock plus this offset. A
 * Worker isolate's clock is not guaranteed to agree with the exchange's, and
 * disagreement in the wrong direction is a hard rejection rather than a
 * degraded result.
 */
export class ClockOffset {
  readonly #safetyMarginMs: number;
  #offsetMs: number | null = null;
  #syncedAt: Timestamp | null = null;
  #roundTripMs: number | null = null;

  constructor(options: { safetyMarginMs?: number } = {}) {
    const margin = options.safetyMarginMs ?? DEFAULT_SAFETY_MARGIN_MS;
    if (!Number.isFinite(margin) || margin < 0) {
      throw new SigningError(
        `safetyMarginMs must be a non-negative number, got ${margin}`,
      );
    }
    this.#safetyMarginMs = margin;
  }

  /**
   * Fold in a server-time observation.
   *
   * The reported time was true at some unknown instant between sending and
   * receiving, so the local instant it is compared against is the midpoint of
   * those two. Assuming symmetric latency leaves an error of at most half the
   * round trip, which is why the round trip is retained and exposed: a sample
   * taken over a slow link is a less certain sample, and the caller can say so.
   */
  record(sample: ClockSample): void {
    const { serverTimeMs, sentAt, receivedAt } = sample;

    if (!Number.isFinite(serverTimeMs) || serverTimeMs <= 0) {
      throw new SigningError(
        `serverTimeMs must be a positive number, got ${serverTimeMs}`,
      );
    }
    if (!Number.isFinite(sentAt) || !Number.isFinite(receivedAt)) {
      throw new SigningError("sentAt and receivedAt must both be finite");
    }
    if (receivedAt < sentAt) {
      throw new SigningError(
        `receivedAt (${receivedAt}) precedes sentAt (${sentAt}); the sample is unusable`,
      );
    }

    this.#offsetMs = serverTimeMs - (sentAt + receivedAt) / 2;
    this.#roundTripMs = receivedAt - sentAt;
    this.#syncedAt = receivedAt;
  }

  /** True once at least one sample has been recorded. */
  get isSynced(): boolean {
    return this.#offsetMs !== null;
  }

  /** Milliseconds to add to the local clock, or null before the first sync. */
  get offsetMs(): number | null {
    return this.#offsetMs;
  }

  /** Round trip of the most recent sample; a measure of how certain it is. */
  get roundTripMs(): number | null {
    return this.#roundTripMs;
  }

  /** Local time of the most recent sync. */
  get syncedAt(): Timestamp | null {
    return this.#syncedAt;
  }

  /** How long since the last sync, or null if never synced. */
  ageMs(now: Timestamp): number | null {
    return this.#syncedAt === null ? null : now - this.#syncedAt;
  }

  /** Whether a re-sync is due. Always true before the first one. */
  needsRefresh(
    now: Timestamp,
    maxAgeMs: number = DEFAULT_RESYNC_INTERVAL_MS,
  ): boolean {
    const age = this.ageMs(now);
    return age === null || age >= maxAgeMs;
  }

  /**
   * The timestamp to sign a request with, given the local clock.
   *
   * Throws rather than falling back to the raw local clock when unsynced. A
   * silent fallback would sign with a clock nothing has verified, and the
   * failure would appear as an authentication error at the exchange with no
   * indication that the cause was drift. Callers sync before signing; the
   * client does this automatically.
   */
  timestampFor(localNow: Timestamp): number {
    if (this.#offsetMs === null) {
      throw new SigningError(
        "cannot produce a request timestamp before the exchange clock has been " +
          "synced; fetch server time first (section 4.2)",
      );
    }
    return Math.round(localNow + this.#offsetMs - this.#safetyMarginMs);
  }

  /** Forget the offset, forcing a fresh sync before the next signed request. */
  clear(): void {
    this.#offsetMs = null;
    this.#syncedAt = null;
    this.#roundTripMs = null;
  }
}
