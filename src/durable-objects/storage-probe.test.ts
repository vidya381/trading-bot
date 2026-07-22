/**
 * What Durable Object storage actually does, measured rather than assumed.
 *
 * Two questions this step cannot answer from memory, both load-bearing for the
 * real `AttemptStore` implementation:
 *
 *  1. Does `get` after `put` hand back a reference to the object that was
 *     written? Step 2's `InMemoryAttemptStore` had exactly this bug -- it
 *     copied on write but not on read, so a caller mutating a returned record
 *     silently corrupted the store. Its decision-log entry claims the persisted
 *     implementation "will not share references either". That claim is
 *     plausible (storage serializes) but untested, and DO storage keeps an
 *     in-memory write cache in front of SQLite, which is precisely where a
 *     shared reference could survive.
 *
 *  2. Does `bigint` survive a round trip? Every money value in this codebase is
 *     a bigint (step 2, decision 1). Step 2 probed `structuredClone(bigint)`
 *     and found it round-trips, but never probed DO storage itself.
 *
 * Kept as a test rather than deleted after measuring, unlike step 2's D1 probe:
 * these are the assumptions `DurableObjectAttemptStore` is built on, so they
 * should fail loudly if a runtime upgrade changes them.
 */

import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { botStub } from "./test-helpers";

function stub(name: string) {
  return botStub(name);
}

describe("Durable Object storage semantics", () => {
  it("does not hand back a reference to the object that was written", async () => {
    await runInDurableObject(stub("probe-ref"), async (_instance, state) => {
      const written = { nested: { value: "original" }, list: ["a"] };
      await state.storage.put("probe", written);

      // Mutate the object we handed to `put`, after the write.
      written.nested.value = "mutated-after-write";
      written.list.push("b");

      const read = await state.storage.get<typeof written>("probe");
      expect(read?.nested.value).toBe("original");
      expect(read?.list).toEqual(["a"]);
    });
  });

  it("does not hand back the same reference twice", async () => {
    await runInDurableObject(stub("probe-ref2"), async (_instance, state) => {
      await state.storage.put("probe", { nested: { value: "original" } });

      const first = await state.storage.get<{ nested: { value: string } }>("probe");
      first!.nested.value = "mutated-after-read";

      const second = await state.storage.get<{ nested: { value: string } }>("probe");
      expect(second?.nested.value).toBe("original");
      expect(second).not.toBe(first);
    });
  });

  it("round-trips bigint exactly, including past 2^53", async () => {
    await runInDurableObject(stub("probe-bigint"), async (_instance, state) => {
      // 2^53 + 1, the first integer a JS number cannot represent, and a value
      // far beyond it. D1 loses both silently on a direct read; DO storage
      // should not, because it serializes with structuredClone semantics
      // rather than through SQLite's JS number binding.
      const values = {
        justPastSafe: 9_007_199_254_740_993n,
        large: 123_456_789_012_345_678n,
        negative: -98_765_432_109_876_543n,
        zero: 0n,
      };
      await state.storage.put("money", values);

      const read = await state.storage.get<typeof values>("money");
      expect(read).toEqual(values);
      expect(typeof read?.justPastSafe).toBe("bigint");
    });
  });

  it("lists by prefix in lexicographic key order", async () => {
    await runInDurableObject(stub("probe-list"), async (_instance, state) => {
      await state.storage.put("attempt:v1-bot-2", { sequence: 2 });
      await state.storage.put("attempt:v1-bot-1", { sequence: 1 });
      await state.storage.put("other:thing", { sequence: 99 });

      const listed = await state.storage.list<{ sequence: number }>({
        prefix: "attempt:",
      });
      expect([...listed.keys()]).toEqual(["attempt:v1-bot-1", "attempt:v1-bot-2"]);
    });
  });

  it("survives eviction, and in-memory fields do not", async () => {
    const target = stub("probe-evict");
    await runInDurableObject(target, async (instance, state) => {
      await state.storage.put("persisted", { kept: true });
      (instance as unknown as Record<string, unknown>).inMemoryOnly = "gone";
    });

    const { evictDurableObject } = await import("cloudflare:test");
    await evictDurableObject(target);

    await runInDurableObject(target, async (instance, state) => {
      expect(await state.storage.get("persisted")).toEqual({ kept: true });
      expect((instance as unknown as Record<string, unknown>).inMemoryOnly).toBeUndefined();
    });
  });
});
