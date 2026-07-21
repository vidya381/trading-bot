import { describe, expect, it } from "vitest";
import {
  BOT_INSTANCE_ID_PATTERN,
  IdempotencyError,
  IdempotencyGuard,
  InMemoryAttemptStore,
  MAX_CLIENT_ORDER_ID_LENGTH,
  MAX_SEQUENCE,
  makeClientOrderId,
  parseClientOrderId,
} from "./idempotency";

const AT = 1_700_000_000_000;

describe("makeClientOrderId", () => {
  it("is deterministic: the same inputs always give the same id", () => {
    expect(makeClientOrderId("bot1", 7)).toBe("v1-bot1-7");
    expect(makeClientOrderId("bot1", 7)).toBe(makeClientOrderId("bot1", 7));
  });

  it("distinguishes bots and sequences", () => {
    expect(makeClientOrderId("bot1", 7)).not.toBe(makeClientOrderId("bot2", 7));
    expect(makeClientOrderId("bot1", 7)).not.toBe(makeClientOrderId("bot1", 8));
  });

  it("stays within the exchange length cap for every valid input", () => {
    // The worst case is the longest slug with the largest sequence. If this
    // fits, no valid input can produce an id the exchange would reject.
    const longest = makeClientOrderId("a".repeat(20), MAX_SEQUENCE);
    expect(longest.length).toBe(MAX_CLIENT_ORDER_ID_LENGTH);
    expect(longest).toBe("v1-aaaaaaaaaaaaaaaaaaaa-999999999999");
  });

  it("still round-trips at the length boundary", () => {
    const longest = makeClientOrderId("a".repeat(20), MAX_SEQUENCE);
    expect(parseClientOrderId(longest)).toEqual({
      botInstanceId: "a".repeat(20),
      sequence: MAX_SEQUENCE,
    });
  });

  it("accepts sequence zero", () => {
    expect(makeClientOrderId("bot1", 0)).toBe("v1-bot1-0");
  });

  it.each([
    ["uppercase", "Bot1"],
    ["too long", "a".repeat(21)],
    ["empty", ""],
    ["leading dash", "-bot"],
    ["a space", "bot 1"],
    ["a slash", "bot/1"],
    ["a UUID, which would not fit", "550e8400-e29b-41d4-a716-446655440000"],
  ])("rejects a bot instance id with %s", (_label, id) => {
    expect(() => makeClientOrderId(id, 1)).toThrow(IdempotencyError);
  });

  it("rejects a sequence outside the permitted range", () => {
    expect(() => makeClientOrderId("bot1", -1)).toThrow(IdempotencyError);
    expect(() => makeClientOrderId("bot1", 1.5)).toThrow(IdempotencyError);
    expect(() => makeClientOrderId("bot1", Number.NaN)).toThrow(IdempotencyError);
    expect(() => makeClientOrderId("bot1", MAX_SEQUENCE + 1)).toThrow(/in \[0, /);
    expect(() => makeClientOrderId("bot1", Number.MAX_SAFE_INTEGER)).toThrow(
      IdempotencyError,
    );
  });

  it("accepts the largest permitted sequence", () => {
    expect(() => makeClientOrderId("bot1", MAX_SEQUENCE)).not.toThrow();
  });
});

describe("parseClientOrderId", () => {
  it("round-trips a generated id, so reconciliation can attribute an order", () => {
    const id = makeClientOrderId("grid-btc", 42);
    expect(parseClientOrderId(id)).toEqual({ botInstanceId: "grid-btc", sequence: 42 });
  });

  it("handles a bot instance id containing separators", () => {
    const id = makeClientOrderId("a-b-c", 3);
    expect(parseClientOrderId(id)).toEqual({ botInstanceId: "a-b-c", sequence: 3 });
  });

  it("returns null for an order this system did not place", () => {
    // Exactly the case section 9 reconciliation must detect.
    expect(parseClientOrderId("web_abc123")).toBeNull();
    expect(parseClientOrderId("x-bot1-1")).toBeNull();
    expect(parseClientOrderId("")).toBeNull();
  });

  it("returns null for a malformed id in the right scheme", () => {
    expect(parseClientOrderId("v1-bot1")).toBeNull();
    expect(parseClientOrderId("v1-bot1-abc")).toBeNull();
    expect(parseClientOrderId("v1--1")).toBeNull();
    expect(parseClientOrderId("v1-BOT-1")).toBeNull();
  });

  it("agrees with the documented slug pattern", () => {
    expect(BOT_INSTANCE_ID_PATTERN.test("grid-btc")).toBe(true);
    expect(BOT_INSTANCE_ID_PATTERN.test("Grid")).toBe(false);
  });
});

describe("IdempotencyGuard", () => {
  function guard(botInstanceId = "bot1") {
    const store = new InMemoryAttemptStore();
    return { store, guard: new IdempotencyGuard(store, botInstanceId) };
  }

  it("rejects an invalid bot instance id at construction", () => {
    expect(() => new IdempotencyGuard(new InMemoryAttemptStore(), "BOT")).toThrow(
      IdempotencyError,
    );
  });

  it("places a first attempt and records it before returning", async () => {
    const { store, guard: g } = guard();
    const decision = await g.beginAttempt(1, AT);

    expect(decision.action).toBe("place");
    expect(decision.clientOrderId).toBe("v1-bot1-1");

    // The record must already exist by the time the caller is told to place:
    // if the isolate dies now, recovery still finds it.
    const stored = await store.get("v1-bot1-1");
    expect(stored?.state).toBe("attempting");
    expect(stored?.recordedAt).toBe(AT);
  });

  it("tells a redelivered message to recover rather than place again", async () => {
    const { guard: g } = guard();
    await g.beginAttempt(1, AT);

    const second = await g.beginAttempt(1, AT + 5000);
    expect(second.action).toBe("recover");
    expect(second.clientOrderId).toBe("v1-bot1-1");
    if (second.action === "recover") {
      expect(second.reason).toMatch(/look up its status by clientOrderId/);
    }
  });

  it("is stable across many redeliveries of the same sequence", async () => {
    const { store, guard: g } = guard();
    await g.beginAttempt(1, AT);
    for (let i = 0; i < 5; i++) {
      expect((await g.beginAttempt(1, AT + i)).action).toBe("recover");
    }
    expect(await store.list()).toHaveLength(1);
  });

  it("still recovers after the attempt was confirmed placed", async () => {
    const { guard: g } = guard();
    await g.beginAttempt(1, AT);
    await g.markPlaced("v1-bot1-1", "EX-999", AT + 100);

    const again = await g.beginAttempt(1, AT + 200);
    expect(again.action).toBe("recover");
    expect(again.attempt.state).toBe("placed");
    expect(again.attempt.exchangeOrderId).toBe("EX-999");
  });

  it("never reuses a sequence that previously failed", async () => {
    // A spent sequence stays spent; a fresh order needs a fresh sequence.
    const { guard: g } = guard();
    await g.beginAttempt(1, AT);
    await g.markFailed("v1-bot1-1", "rejected: below minNotional", AT + 100);

    const again = await g.beginAttempt(1, AT + 200);
    expect(again.action).toBe("recover");
    expect(again.attempt.state).toBe("failed");
    expect(again.attempt.failureReason).toMatch(/minNotional/);
  });

  it("allows a different sequence to proceed independently", async () => {
    const { guard: g } = guard();
    await g.beginAttempt(1, AT);
    expect((await g.beginAttempt(2, AT)).action).toBe("place");
  });

  it("refuses to resolve an attempt that was never recorded", async () => {
    const { guard: g } = guard();
    await expect(g.markPlaced("v1-bot1-9", "EX-1", AT)).rejects.toThrow(IdempotencyError);
    await expect(g.markPlaced("v1-bot1-9", "EX-1", AT)).rejects.toThrow(/no attempt/);
  });

  it("refuses to resolve the same attempt twice", async () => {
    const { guard: g } = guard();
    await g.beginAttempt(1, AT);
    await g.markPlaced("v1-bot1-1", "EX-1", AT);

    await expect(g.markPlaced("v1-bot1-1", "EX-2", AT)).rejects.toThrow(
      /already "placed"/,
    );
    await expect(g.markFailed("v1-bot1-1", "late", AT)).rejects.toThrow(
      IdempotencyError,
    );
  });

  it("lists unresolved attempts oldest first, as a recovery worklist", async () => {
    const { guard: g } = guard();
    await g.beginAttempt(3, AT);
    await g.beginAttempt(1, AT);
    await g.beginAttempt(2, AT);
    await g.markPlaced("v1-bot1-2", "EX-2", AT);

    const unresolved = await g.unresolvedAttempts();
    expect(unresolved.map((a) => a.sequence)).toEqual([1, 3]);
  });

  it("does not report another bot's attempts", async () => {
    const store = new InMemoryAttemptStore();
    const one = new IdempotencyGuard(store, "bot1");
    const two = new IdempotencyGuard(store, "bot2");

    await one.beginAttempt(1, AT);
    await two.beginAttempt(1, AT);

    expect(await one.unresolvedAttempts()).toHaveLength(1);
    expect((await one.unresolvedAttempts())[0]?.botInstanceId).toBe("bot1");
    expect(await two.highestSequence()).toBe(1);
  });

  it("reports the highest sequence used, or -1 when there are none", async () => {
    const { guard: g } = guard();
    expect(await g.highestSequence()).toBe(-1);
    await g.beginAttempt(0, AT);
    await g.beginAttempt(5, AT);
    expect(await g.highestSequence()).toBe(5);
  });

  it("does not leak internal state through the store", async () => {
    const { store, guard: g } = guard();
    await g.beginAttempt(1, AT);
    const first = await store.get("v1-bot1-1");
    first!.state = "placed"; // mutate the copy the caller received

    const second = await store.get("v1-bot1-1");
    expect(second?.state).toBe("attempting");
  });
});
