/**
 * Live tradable-pair listing for an account, cached in KV (sections 4.3, 8.3),
 * step 11.
 *
 * Backs `GET /api/accounts/:label/symbols`. Given a registered account, it
 * resolves the account's real exchange (`resolveExchangeForAccount`), gets a
 * real client, and calls the client's `listTradablePairs` -- the live set of
 * pairs the venue will actually trade -- so the create-bot form can offer real
 * pairs instead of a free-typed guess.
 *
 * ---------------------------------------------------------------------------
 * WHY CACHED, AND WHY KV
 * ---------------------------------------------------------------------------
 * The tradable set changes rarely (a venue lists or delists a pair occasionally,
 * not per second), while a dashboard dropdown might ask for it on every page
 * load, and the underlying call is a full-catalogue exchange request that spends
 * rate-limit budget. So the result is cached with a TTL, exactly the pattern
 * section 8.3 assigns KV and `cooldown.ts` already uses: a transient,
 * self-expiring value where eventual-consistency staleness costs at worst a
 * slightly out-of-date pair list -- never a trading decision. This is the second
 * place in the system where KV staleness is harmless (the first being the alert
 * cooldown), and for the same reason.
 *
 * The TTL matches the bot object's own symbol-filter cache age
 * (`FILTER_MAX_AGE_MS`, one hour): the two are the same kind of periodically
 * refreshed reference data (section 4.3), so they age on the same schedule.
 *
 * If the `SYMBOL_CACHE` binding is absent (not yet provisioned -- see
 * docs/kv-provisioning.md), the endpoint DEGRADES to a live call every time
 * rather than failing: a missing cache is a performance concern, not a
 * correctness one, so unlike a missing credential it is not a reason to refuse.
 * The response says `cached: false` so the degraded state is visible.
 */

import type { ExchangeOutcome } from "../shared/downtime";
import type { Pair, Timestamp } from "../shared/exchange-client";
import type { ExchangeId } from "../db/schema";
import { resolveExchangeForAccount } from "./exchange-dispatch";

declare global {
  interface Env {
    /**
     * KV cache for `listTradablePairs` results (section 8.3), keyed per account.
     * Optional because it is not provisioned in every environment yet; the
     * endpoint degrades to an uncached live call when it is absent. Provision as
     * in docs/kv-provisioning.md, then add the binding to wrangler.jsonc.
     */
    readonly SYMBOL_CACHE?: KVNamespace;
  }
}

/** One hour, matching `bot-instance.ts`'s `FILTER_MAX_AGE_MS`. */
export const SYMBOL_CACHE_TTL_MS = 3_600_000;

/** A cached pair list and when it was fetched from the exchange. */
export interface CachedSymbols {
  readonly pairs: Pair[];
  readonly fetchedAt: Timestamp;
}

/** The cache key for one account's pair list. */
export function symbolCacheKey(exchange: ExchangeId, accountLabel: string): string {
  return `symbols:${exchange}:${accountLabel}`;
}

/**
 * The cache port this module depends on. Two methods, keyed by `symbolCacheKey`.
 * Mirrors `CooldownStore`: a store only remembers a value and its freshness; the
 * TTL policy lives in the store implementation.
 */
export interface SymbolCacheStore {
  read(key: string): Promise<CachedSymbols | null>;
  write(key: string, value: CachedSymbols): Promise<void>;
}

/**
 * The real store, over a KV namespace. Each entry self-expires after the TTL, so
 * the namespace stays bounded and a stale list can never outlive its window.
 */
export class KvSymbolCacheStore implements SymbolCacheStore {
  readonly #kv: KVNamespace;
  readonly #ttlSeconds: number;

  constructor(kv: KVNamespace, options: { ttlMs?: number } = {}) {
    this.#kv = kv;
    // KV's minimum expirationTtl is 60s; a shorter window still gets 60s, which
    // only ever over-caches slightly -- the safe direction for reference data.
    this.#ttlSeconds = Math.max(60, Math.ceil((options.ttlMs ?? SYMBOL_CACHE_TTL_MS) / 1000));
  }

  async read(key: string): Promise<CachedSymbols | null> {
    const raw = await this.#kv.get(key);
    if (raw === null) return null;
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        Array.isArray((parsed as CachedSymbols).pairs) &&
        typeof (parsed as CachedSymbols).fetchedAt === "number"
      ) {
        const value = parsed as CachedSymbols;
        // Trust only string entries; a garbled array is treated as a miss.
        if (value.pairs.every((p) => typeof p === "string")) return value;
      }
    } catch {
      // Fall through: a corrupt value is a miss, not an error -- a re-fetch is
      // the safe recovery, exactly as KvCooldownStore treats a garbled number.
    }
    return null;
  }

  async write(key: string, value: CachedSymbols): Promise<void> {
    await this.#kv.put(key, JSON.stringify(value), { expirationTtl: this.#ttlSeconds });
  }
}

/** A deterministic in-memory store for tests. */
export class InMemorySymbolCacheStore implements SymbolCacheStore {
  readonly #map = new Map<string, CachedSymbols>();

  async read(key: string): Promise<CachedSymbols | null> {
    return this.#map.get(key) ?? null;
  }

  async write(key: string, value: CachedSymbols): Promise<void> {
    this.#map.set(key, value);
  }
}

/**
 * The port that actually reaches an exchange for an account's pairs.
 *
 * Injected so tests exercise `listAccountSymbols`' caching without a network
 * call -- the same reason the API layer injects `db` and the Access JWKS
 * fetcher. `envSymbolLister` is the real one.
 */
export type SymbolLister = (
  account: { readonly label: string; readonly exchange: ExchangeId },
  env: Env,
  now: () => Timestamp,
) => Promise<ExchangeOutcome<Pair[]>>;

/**
 * The real lister: dispatch to the account's exchange, build the client, call
 * `listTradablePairs`.
 *
 * A resolution failure (missing secret, non-trading `ENVIRONMENT`) is folded
 * into a non-retryable `exchange_error` outcome carrying the resolver's own
 * reason -- which names the exact secret and the command to set it -- so the one
 * return type covers both "cannot build a client" and "the client's call
 * failed", and the caller has one failure shape to map.
 */
export const envSymbolLister: SymbolLister = async (account, env, now) => {
  const resolution = resolveExchangeForAccount(account.exchange, env, now);
  if (!resolution.ok) {
    return { ok: false, kind: "exchange_error", message: resolution.reason, retryable: false, at: now() };
  }
  const client = resolution.exchangeFor(account.label);
  if (client === null) {
    // `ExchangeFactory` may return null for an account it declines to build a
    // client for. `ok:true` resolutions here always build one, so this is
    // belt-and-braces -- surfaced as a clear failure rather than a null deref.
    return {
      ok: false,
      kind: "exchange_error",
      message: `no exchange client could be built for account ${JSON.stringify(account.label)}`,
      retryable: false,
      at: now(),
    };
  }
  return client.listTradablePairs();
};

/** The result of a pair-listing: the pairs, whether it was served from cache. */
export type SymbolListing =
  | { readonly ok: true; readonly pairs: Pair[]; readonly cached: boolean; readonly fetchedAt: Timestamp }
  | { readonly ok: false; readonly failure: Extract<ExchangeOutcome<Pair[]>, { ok: false }> };

/**
 * Return an account's tradable pairs, cached.
 *
 * Cache first; on a hit, no exchange call is made. On a miss (or no cache
 * binding), the lister is called; a successful result is written back to the
 * cache (when there is one) and returned with `cached: false`; a failure is
 * returned as-is for the handler to map to an HTTP status, and is NOT cached --
 * a transient exchange outage must not be remembered for an hour.
 */
export async function listAccountSymbols(input: {
  readonly account: { readonly label: string; readonly exchange: ExchangeId };
  readonly env: Env;
  readonly now: () => Timestamp;
  readonly lister: SymbolLister;
  readonly cache: SymbolCacheStore | null;
}): Promise<SymbolListing> {
  const { account, env, now, lister, cache } = input;
  const key = symbolCacheKey(account.exchange, account.label);

  if (cache !== null) {
    const hit = await cache.read(key);
    if (hit !== null) {
      return { ok: true, pairs: hit.pairs, cached: true, fetchedAt: hit.fetchedAt };
    }
  }

  const outcome = await lister(account, env, now);
  if (!outcome.ok) {
    return { ok: false, failure: outcome };
  }

  const fetchedAt = outcome.at;
  if (cache !== null) {
    await cache.write(key, { pairs: outcome.value, fetchedAt });
  }
  return { ok: true, pairs: outcome.value, cached: false, fetchedAt };
}
