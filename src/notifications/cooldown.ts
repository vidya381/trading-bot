/**
 * The KV-based notification cooldown (spec sections 8.3, 10).
 *
 * Section 10: "whether an alert also sends a ... notification is throttled via
 * a KV-based cooldown key (default: 15 minutes per alert type per bot
 * instance)". Section 8.3: "one key per (alert type + bot instance), storing
 * last-notified timestamp, checked before sending".
 *
 * This throttles ONLY the outbound ping. The alert row itself is already in D1,
 * written unconditionally by the pipeline that raised it; nothing here reads or
 * writes that row. Recording and notifying are two separate concerns, and this
 * file is entirely on the notifying side.
 *
 * KV is the right store precisely because section 8.3 assigns it this job and
 * no other that matters: its eventual consistency costs, at worst, a duplicate
 * ping if two dispatch runs raced (they do not -- one cron, one account's
 * worth of alerts, processed in order). That is the one place in the system
 * where KV staleness is harmless, which is why the circuit breaker (migration
 * 0003) deliberately used D1 instead.
 */

/** Section 10's default: 15 minutes per (alert type, bot instance). */
export const DEFAULT_COOLDOWN_MS = 15 * 60_000;

/**
 * The cooldown key for one alert. Account-wide alerts (`botInstanceId === null`
 * -- the circuit breaker, an unattributed reconciliation finding) share a
 * single per-type bucket under `__account__`, so a storm of them is throttled
 * as one stream rather than escaping the cooldown on a null key.
 */
export function cooldownKey(alertType: string, botInstanceId: string | null): string {
  return `cooldown:${alertType}:${botInstanceId ?? "__account__"}`;
}

/**
 * The port the dispatcher depends on. Two methods, both keyed by the string
 * from `cooldownKey`. The window comparison lives in the dispatcher, not here:
 * a store only remembers when a ping last went out for a key.
 */
export interface CooldownStore {
  /** The last instant a ping was sent for this key, or null if never / expired. */
  lastSentAt(key: string): Promise<number | null>;
  /** Record that a ping just went out for this key at `at` (ms since epoch). */
  recordSent(key: string, at: number): Promise<void>;
}

/**
 * The real implementation, over a KV namespace.
 *
 * Each key is written with an `expirationTtl` at least as long as the cooldown
 * window, so keys self-delete once they can no longer suppress anything. That
 * keeps the namespace bounded even though the alerts table (section 8.7) grows
 * forever -- the cooldown is transient state, not history.
 */
export class KvCooldownStore implements CooldownStore {
  readonly #kv: KVNamespace;
  readonly #ttlSeconds: number;

  constructor(kv: KVNamespace, options: { windowMs?: number } = {}) {
    this.#kv = kv;
    // KV's minimum expirationTtl is 60s. A window shorter than that still gets
    // a 60s key, which only ever over-suppresses slightly -- never the reverse.
    this.#ttlSeconds = Math.max(60, Math.ceil((options.windowMs ?? DEFAULT_COOLDOWN_MS) / 1000));
  }

  async lastSentAt(key: string): Promise<number | null> {
    const raw = await this.#kv.get(key);
    if (raw === null) return null;
    const value = Number(raw);
    // A garbled value is treated as "no record" rather than trusted: at worst
    // one extra ping goes out, which is the safe direction for an alert.
    return Number.isFinite(value) ? value : null;
  }

  async recordSent(key: string, at: number): Promise<void> {
    await this.#kv.put(key, String(at), { expirationTtl: this.#ttlSeconds });
  }
}

/**
 * A deterministic in-memory store for tests. Holds only the last-sent instant
 * per key; the dispatcher's clock and window drive every timing decision, so a
 * test controls throttling entirely through the `now` it injects.
 */
export class InMemoryCooldownStore implements CooldownStore {
  readonly #sent = new Map<string, number>();

  async lastSentAt(key: string): Promise<number | null> {
    return this.#sent.get(key) ?? null;
  }

  async recordSent(key: string, at: number): Promise<void> {
    this.#sent.set(key, at);
  }
}
