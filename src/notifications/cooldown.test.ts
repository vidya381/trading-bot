/**
 * The KV-based notification cooldown (sections 8.3, 10).
 *
 * `InMemoryCooldownStore` and `cooldownKey` are pure and tested directly.
 * `KvCooldownStore` runs against the real miniflare KV binding
 * (`env.ALERT_COOLDOWNS`), per section 14 -- the store's whole job is talking to
 * KV, so a mock of KV would test nothing.
 */

import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  cooldownKey,
  DEFAULT_COOLDOWN_MS,
  InMemoryCooldownStore,
  KvCooldownStore,
} from "./cooldown";

describe("cooldownKey (section 8.3: per alert type + bot instance)", () => {
  it("keys on both the type and the bot", () => {
    expect(cooldownKey("halt_stop_loss", "dca-btc-1")).toBe(
      "cooldown:halt_stop_loss:dca-btc-1",
    );
  });

  it("distinguishes the same type on different bots", () => {
    expect(cooldownKey("take_profit", "bot-a")).not.toBe(cooldownKey("take_profit", "bot-b"));
  });

  it("distinguishes different types on the same bot", () => {
    expect(cooldownKey("halt_stop_loss", "bot-a")).not.toBe(
      cooldownKey("take_profit", "bot-a"),
    );
  });

  it("buckets account-wide alerts (null bot) under a shared per-type key", () => {
    expect(cooldownKey("circuit_breaker_tripped", null)).toBe(
      "cooldown:circuit_breaker_tripped:__account__",
    );
    // Two account-wide alerts of one type share a bucket, so a storm is
    // throttled as one stream rather than escaping on a null key.
    expect(cooldownKey("circuit_breaker_tripped", null)).toBe(
      cooldownKey("circuit_breaker_tripped", null),
    );
  });

  it("uses section 10's 15-minute default window", () => {
    expect(DEFAULT_COOLDOWN_MS).toBe(15 * 60_000);
  });
});

describe("InMemoryCooldownStore", () => {
  it("returns null for a key never recorded", async () => {
    const store = new InMemoryCooldownStore();
    expect(await store.lastSentAt("k")).toBeNull();
  });

  it("remembers the last-sent instant per key", async () => {
    const store = new InMemoryCooldownStore();
    await store.recordSent("k", 1000);
    expect(await store.lastSentAt("k")).toBe(1000);
    await store.recordSent("k", 2000);
    expect(await store.lastSentAt("k")).toBe(2000);
  });

  it("keeps keys independent", async () => {
    const store = new InMemoryCooldownStore();
    await store.recordSent("a", 1000);
    expect(await store.lastSentAt("b")).toBeNull();
  });
});

describe("KvCooldownStore (real KV)", () => {
  let unique = 0;
  let key: string;

  beforeEach(() => {
    // A distinct key per test so nothing leaks between them: the KV namespace
    // is shared across the file and has no per-test reset.
    unique += 1;
    key = `cooldown:test:${unique}`;
  });

  it("returns null before anything is recorded", async () => {
    const store = new KvCooldownStore(env.ALERT_COOLDOWNS);
    expect(await store.lastSentAt(key)).toBeNull();
  });

  it("round-trips the last-sent instant through KV", async () => {
    const store = new KvCooldownStore(env.ALERT_COOLDOWNS);
    await store.recordSent(key, 1_760_000_000_000);
    expect(await store.lastSentAt(key)).toBe(1_760_000_000_000);
  });

  it("treats a garbled stored value as no record (safe direction: one extra ping)", async () => {
    await env.ALERT_COOLDOWNS.put(key, "not-a-number");
    const store = new KvCooldownStore(env.ALERT_COOLDOWNS);
    expect(await store.lastSentAt(key)).toBeNull();
  });

  it("writes a self-expiring key at least as long as the window", async () => {
    // A window under KV's 60s floor still gets a 60s ttl, which only ever
    // over-suppresses -- never the reverse. The put must not throw for a short
    // window; a sub-60s expirationTtl would.
    const store = new KvCooldownStore(env.ALERT_COOLDOWNS, { windowMs: 1000 });
    await expect(store.recordSent(key, 1000)).resolves.toBeUndefined();
    expect(await store.lastSentAt(key)).toBe(1000);
  });
});
