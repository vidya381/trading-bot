/**
 * The persisted `AttemptStore`, tested against the same behaviours step 2's
 * in-memory one was -- including the mutation tests that caught its
 * reference-leak bug (step 2, decision 12).
 */

import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { IdempotencyGuard, type OrderAttempt } from "../shared/idempotency";
import { DurableObjectAttemptStore, attemptKey } from "./attempt-store";
import { botStub } from "./test-helpers";

let counter = 0;
function freshStub() {
  counter += 1;
  return botStub(`attempts-${counter}`);
}

/** Run `body` with a store over a real Durable Object's storage. */
async function withStore<T>(
  stub: DurableObjectStub,
  body: (store: DurableObjectAttemptStore, storage: DurableObjectStorage) => Promise<T>,
): Promise<T> {
  return await runInDurableObject(stub, async (_instance, state) =>
    body(new DurableObjectAttemptStore(state.storage), state.storage),
  );
}

function attempt(overrides: Partial<OrderAttempt> = {}): OrderAttempt {
  return {
    clientOrderId: "v1-dca-btc-1-0",
    botInstanceId: "dca-btc-1",
    sequence: 0,
    state: "attempting",
    recordedAt: 1_000,
    updatedAt: 1_000,
    ...overrides,
  };
}

let stub: DurableObjectStub;
beforeEach(() => {
  stub = freshStub();
});

describe("DurableObjectAttemptStore", () => {
  it("round-trips a record", async () => {
    await withStore(stub, async (store) => {
      await store.put(attempt());
      expect(await store.get("v1-dca-btc-1-0")).toEqual(attempt());
    });
  });

  it("returns undefined for an id it has never seen", async () => {
    await withStore(stub, async (store) => {
      expect(await store.get("v1-dca-btc-1-99")).toBeUndefined();
    });
  });

  it("overwrites a record with the same clientOrderId", async () => {
    await withStore(stub, async (store) => {
      await store.put(attempt());
      await store.put(attempt({ state: "placed", exchangeOrderId: "E1", updatedAt: 2_000 }));
      const read = await store.get("v1-dca-btc-1-0");
      expect(read?.state).toBe("placed");
      expect(read?.exchangeOrderId).toBe("E1");
    });
  });

  // The two tests that would have caught step 2's bug.
  it("is unaffected by a caller mutating the record it wrote", async () => {
    await withStore(stub, async (store) => {
      const written = attempt();
      await store.put(written);
      written.state = "failed";
      written.failureReason = "mutated after write";

      const read = await store.get("v1-dca-btc-1-0");
      expect(read?.state).toBe("attempting");
      expect(read?.failureReason).toBeUndefined();
    });
  });

  it("is unaffected by a caller mutating the record it read", async () => {
    await withStore(stub, async (store) => {
      await store.put(attempt());

      const first = await store.get("v1-dca-btc-1-0");
      first!.state = "failed";

      const second = await store.get("v1-dca-btc-1-0");
      expect(second?.state).toBe("attempting");
      expect(second).not.toBe(first);
    });
  });

  it("does not leak mutations through list() either", async () => {
    await withStore(stub, async (store) => {
      await store.put(attempt());
      const listed = await store.list();
      listed[0]!.state = "placed";
      expect((await store.list())[0]?.state).toBe("attempting");
    });
  });

  it("lists every attempt, in sequence-key order", async () => {
    await withStore(stub, async (store) => {
      await store.put(attempt({ clientOrderId: "v1-dca-btc-1-0", sequence: 0 }));
      await store.put(attempt({ clientOrderId: "v1-dca-btc-1-1", sequence: 1 }));
      await store.put(attempt({ clientOrderId: "v1-dca-btc-1-2", sequence: 2 }));

      const listed = await store.list();
      expect(listed.map((a) => a.sequence)).toEqual([0, 1, 2]);
    });
  });

  it("lists nothing when the object holds only non-attempt keys", async () => {
    await withStore(stub, async (store, storage) => {
      await storage.put("config", { pair: "BTCUSDT" });
      await storage.put("state", { status: "running" });
      expect(await store.list()).toEqual([]);
    });
  });

  it("namespaces its keys so it cannot collide with the object's own state", async () => {
    await withStore(stub, async (store, storage) => {
      await store.put(attempt());
      expect(await storage.get(attemptKey("v1-dca-btc-1-0"))).toBeDefined();
      expect(await storage.get("v1-dca-btc-1-0")).toBeUndefined();
    });
  });

  it("survives the object being evicted", async () => {
    await withStore(stub, async (store) => {
      await store.put(attempt({ state: "placed", exchangeOrderId: "E1" }));
    });

    await evictDurableObject(stub);

    await withStore(stub, async (store) => {
      const read = await store.get("v1-dca-btc-1-0");
      expect(read?.state).toBe("placed");
      expect(read?.exchangeOrderId).toBe("E1");
    });
  });
});

describe("IdempotencyGuard over persisted storage", () => {
  // Step 2 open question 8: nothing had exercised two modules together. This is
  // the idempotency module driving the real store rather than the fake.
  it("places once and recovers on every redelivery, across an eviction", async () => {
    const first = await withStore(stub, async (store) => {
      const guard = new IdempotencyGuard(store, "dca-btc-1");
      return await guard.beginAttempt(0, 1_000);
    });
    expect(first.action).toBe("place");

    await evictDurableObject(stub);

    const second = await withStore(stub, async (store) => {
      const guard = new IdempotencyGuard(store, "dca-btc-1");
      return await guard.beginAttempt(0, 2_000);
    });
    expect(second.action).toBe("recover");
    expect(second.clientOrderId).toBe(first.clientOrderId);
    expect(second.attempt.state).toBe("attempting");
  });

  it("recovers rather than re-sending an attempt whose outcome was never learned", async () => {
    await withStore(stub, async (store) => {
      const guard = new IdempotencyGuard(store, "dca-btc-1");
      await guard.beginAttempt(3, 1_000);
      // No markPlaced, no markFailed: the isolate died mid-flight.
      const retry = await guard.beginAttempt(3, 2_000);
      expect(retry.action).toBe("recover");
      expect(await guard.unresolvedAttempts()).toHaveLength(1);
    });
  });

  it("marks placed and failed, and reports the highest sequence used", async () => {
    await withStore(stub, async (store) => {
      const guard = new IdempotencyGuard(store, "dca-btc-1");
      await guard.beginAttempt(0, 1_000);
      await guard.markPlaced(guard.clientOrderIdFor(0), "E1", 1_100);
      await guard.beginAttempt(1, 1_200);
      await guard.markFailed(guard.clientOrderIdFor(1), "rejected by the exchange", 1_300);

      expect(await guard.highestSequence()).toBe(1);
      expect(await guard.unresolvedAttempts()).toEqual([]);
      expect((await store.get(guard.clientOrderIdFor(0)))?.exchangeOrderId).toBe("E1");
      expect((await store.get(guard.clientOrderIdFor(1)))?.failureReason).toBe(
        "rejected by the exchange",
      );
    });
  });

  it("reports -1 as the highest sequence before anything is attempted", async () => {
    await withStore(stub, async (store) => {
      expect(await new IdempotencyGuard(store, "dca-btc-1").highestSequence()).toBe(-1);
    });
  });
});
