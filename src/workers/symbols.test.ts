/**
 * The tradable-pair listing and its KV cache (step 11).
 *
 * `KvSymbolCacheStore` is tested against the REAL local KV namespace
 * (`env.SYMBOL_CACHE`, supplied by miniflare), per section 14 -- the store's
 * whole job is talking to KV, so a fake store would test nothing. The
 * orchestration in `listAccountSymbols` is tested through an in-memory store and
 * an injected lister, so the caching decisions are deterministic and no network
 * is touched.
 */

import { env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import type { ExchangeOutcome } from "../shared/downtime";
import type { Pair } from "../shared/exchange-client";
import {
  InMemorySymbolCacheStore,
  KvSymbolCacheStore,
  envSymbolLister,
  listAccountSymbols,
  symbolCacheKey,
  type SymbolLister,
} from "./symbols";

const AT = 1_700_000_000_000;
const ACCOUNT = { label: "main", exchange: "binance" as const };

function ok(pairs: Pair[], at = AT): ExchangeOutcome<Pair[]> {
  return { ok: true, value: pairs, at };
}

/** A lister that records its calls and returns a scripted outcome. */
function scriptedLister(outcome: ExchangeOutcome<Pair[]>): SymbolLister & { calls: number } {
  const lister = vi.fn(async () => outcome) as unknown as SymbolLister & { calls: number };
  const wrapped: SymbolLister & { calls: number } = Object.assign(
    async (a: Parameters<SymbolLister>[0], e: Env, n: () => number) => {
      wrapped.calls += 1;
      return lister(a, e, n);
    },
    { calls: 0 },
  );
  return wrapped;
}

describe("symbolCacheKey", () => {
  it("namespaces by exchange and label", () => {
    expect(symbolCacheKey("binance", "main")).toBe("symbols:binance:main");
    expect(symbolCacheKey("gemini", "main")).toBe("symbols:gemini:main");
  });
});

describe("KvSymbolCacheStore", () => {
  it("round-trips a cached list through the real KV namespace", async () => {
    const store = new KvSymbolCacheStore(env.SYMBOL_CACHE);
    const key = symbolCacheKey("binance", "kv-roundtrip");
    await store.write(key, { pairs: ["BTCUSDT", "ETHUSDT"], fetchedAt: AT });

    const read = await store.read(key);
    expect(read).toEqual({ pairs: ["BTCUSDT", "ETHUSDT"], fetchedAt: AT });
  });

  it("treats a missing key as a miss", async () => {
    const store = new KvSymbolCacheStore(env.SYMBOL_CACHE);
    expect(await store.read(symbolCacheKey("binance", "never-written"))).toBeNull();
  });

  it("treats a corrupt value as a miss rather than throwing", async () => {
    const key = symbolCacheKey("binance", "corrupt");
    await env.SYMBOL_CACHE.put(key, "{not json");
    const store = new KvSymbolCacheStore(env.SYMBOL_CACHE);
    expect(await store.read(key)).toBeNull();
  });

  it("treats a structurally wrong value as a miss", async () => {
    const key = symbolCacheKey("binance", "wrong-shape");
    await env.SYMBOL_CACHE.put(key, JSON.stringify({ pairs: [1, 2], fetchedAt: "soon" }));
    const store = new KvSymbolCacheStore(env.SYMBOL_CACHE);
    expect(await store.read(key)).toBeNull();
  });
});

describe("listAccountSymbols", () => {
  it("on a cache miss, calls the lister, caches the result, and reports cached:false", async () => {
    const cache = new InMemorySymbolCacheStore();
    const lister = scriptedLister(ok(["BTCUSDT", "ETHUSDT"]));

    const result = await listAccountSymbols({ account: ACCOUNT, env, now: () => AT, lister, cache });

    expect(result).toEqual({ ok: true, pairs: ["BTCUSDT", "ETHUSDT"], cached: false, fetchedAt: AT });
    expect(lister.calls).toBe(1);
    // The next call is served from cache without touching the lister.
    const again = await listAccountSymbols({ account: ACCOUNT, env, now: () => AT, lister, cache });
    expect(again).toEqual({ ok: true, pairs: ["BTCUSDT", "ETHUSDT"], cached: true, fetchedAt: AT });
    expect(lister.calls).toBe(1);
  });

  it("degrades to a live call every time when there is no cache binding", async () => {
    const lister = scriptedLister(ok(["BTCUSDT"]));

    const first = await listAccountSymbols({ account: ACCOUNT, env, now: () => AT, lister, cache: null });
    const second = await listAccountSymbols({ account: ACCOUNT, env, now: () => AT, lister, cache: null });

    expect(first).toEqual({ ok: true, pairs: ["BTCUSDT"], cached: false, fetchedAt: AT });
    expect(second.ok && second.cached).toBe(false);
    expect(lister.calls).toBe(2);
  });

  it("returns a failure as-is and does NOT cache it", async () => {
    const cache = new InMemorySymbolCacheStore();
    const lister = scriptedLister({
      ok: false,
      kind: "transport",
      message: "exchange unreachable",
      retryable: true,
      at: AT,
    });

    const result = await listAccountSymbols({ account: ACCOUNT, env, now: () => AT, lister, cache });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.message).toBe("exchange unreachable");

    // Nothing was written, so a retry re-attempts rather than serving a cached error.
    expect(await cache.read(symbolCacheKey("binance", "main"))).toBeNull();
  });
});

describe("envSymbolLister", () => {
  // The test env has no BINANCE_/GEMINI_ secrets, so each resolver fails closed;
  // this proves the dispatch reaches the RIGHT resolver by the secret it names.
  it("dispatches a binance account to the Binance resolver (names BINANCE secrets on failure)", async () => {
    const outcome = await envSymbolLister({ label: "main", exchange: "binance" }, env, () => AT);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.message).toContain("BINANCE_API_KEY");
  });

  it("dispatches a gemini account to the Gemini resolver (names GEMINI secrets on failure)", async () => {
    const outcome = await envSymbolLister({ label: "main", exchange: "gemini" }, env, () => AT);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.message).toContain("GEMINI_API_KEY");
  });
});
