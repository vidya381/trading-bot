import { describe, expect, it } from "vitest";
import {
  BOT_INSTANCE_ID_PATTERN,
  CLIENT_ORDER_ID_OVERHEAD,
  IdempotencyError,
  IdempotencyGuard,
  InMemoryAttemptStore,
  MAX_BOT_INSTANCE_ID_LENGTH,
  MAX_CLIENT_ORDER_ID_LENGTH,
  MAX_SEQUENCE,
  VENUE_ORDER_ID_BUDGETS,
  checkBotInstanceIdFitsVenue,
  describeVenueIdLengthViolation,
  makeClientOrderId,
  parseClientOrderId,
  venueOrderIdBudget,
  type VenueId,
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


/**
 * DECISION-LOG ENTRY 90, DECISION 3 -- the per-venue client-order-id budget.
 *
 * Entry 90 recorded the cap as CONDITIONAL: "It is not yet established that
 * real bot instance ids in the database fit, and if they do not, this decision
 * is not workable as stated." It has since been established, against the real
 * `bot_instances` rows on testnet -- 31 bots, longest id 11 characters, 27 of
 * them the 10-character `bot-xxxxxx` the dashboard generates -- so the decision
 * stands and these tests pin the arithmetic it rests on.
 *
 * The numbers below are Kraken's real rule, not a placeholder: `cl_ord_id`
 * accepts free-format text up to 18 characters, and `v1-<slug>-<sequence>` is
 * free-format text.
 */
describe("per-venue client-order-id budgets", () => {
  it("agrees with BOT_INSTANCE_ID_PATTERN about the scheme-wide maximum", () => {
    // MAX_BOT_INSTANCE_ID_LENGTH restates a regex quantifier as a number. If
    // one is ever changed without the other, the budget arithmetic silently
    // stops matching the ids the system actually accepts -- so assert both
    // directions, not just that a 20-character id passes.
    expect(BOT_INSTANCE_ID_PATTERN.test("a".repeat(MAX_BOT_INSTANCE_ID_LENGTH))).toBe(true);
    expect(BOT_INSTANCE_ID_PATTERN.test("a".repeat(MAX_BOT_INSTANCE_ID_LENGTH + 1))).toBe(false);
  });

  it("gives every venue a budget that its own ceiling can actually hold", () => {
    // The invariant that makes a budget a budget: prefix + slug + separator +
    // digits must fit the venue's ceiling, for every venue in the table.
    for (const [venue, budget] of Object.entries(VENUE_ORDER_ID_BUDGETS)) {
      const spent =
        CLIENT_ORDER_ID_OVERHEAD + budget.maxBotInstanceIdLength + budget.reservedSequenceDigits;
      expect(spent, `${venue} overspends its own ceiling`).toBeLessThanOrEqual(
        budget.maxClientOrderIdLength,
      );
    }
  });

  it("spends kraken's 18 characters exactly as entry 90 decided: 10 slug, 4 digits", () => {
    expect(VENUE_ORDER_ID_BUDGETS.kraken).toEqual({
      maxClientOrderIdLength: 18,
      maxBotInstanceIdLength: 10,
      reservedSequenceDigits: 4,
    });

    // The decision in its concrete form: the longest id this budget permits,
    // at the largest sequence it reserves room for, is exactly 18 characters.
    const longest = makeClientOrderId("a".repeat(10), 9_999);
    expect(longest).toBe("v1-aaaaaaaaaa-9999");
    expect(longest.length).toBe(18);
  });

  it("leaves a kraken bot 10,000 orders of sequence room, which is the point of 10 over 11", () => {
    // Sequences are allocated monotonically and never reused, so the reserved
    // digits are a lifetime order ceiling per bot. Entry 90 chose 10 characters
    // over the 11 the longest real id uses precisely to move this number from
    // 1,000 (reachable) to 10,000 (not).
    const budget = VENUE_ORDER_ID_BUDGETS.kraken;
    expect(10 ** budget.reservedSequenceDigits).toBe(10_000);

    const eleven = makeClientOrderId("a".repeat(11), 999);
    expect(eleven.length).toBe(18); // fits, but only 1,000 orders deep
    expect(makeClientOrderId("a".repeat(11), 1_000).length).toBe(19); // and then it does not
  });

  it("rejects a kraken bot id one character over the budget", () => {
    const violation = checkBotInstanceIdFitsVenue("kraken", "grid-btcusd");
    expect(violation).not.toBeNull();
    expect(violation).toMatchObject({
      venue: "kraken",
      botInstanceId: "grid-btcusd",
      actualLength: 11,
      maxBotInstanceIdLength: 10,
      maxClientOrderIdLength: 18,
    });
  });

  it("rejects entry 90's own worked example, which the id pattern still permits", () => {
    // `grid-btcusd-01` is 14 characters: valid under BOT_INSTANCE_ID_PATTERN,
    // valid under the D1 CHECK, typeable in the dashboard today -- and 19
    // characters once it becomes a clientOrderId. This is the exact id entry 90
    // used to show the problem, so it is the exact id the fix must refuse.
    expect(BOT_INSTANCE_ID_PATTERN.test("grid-btcusd-01")).toBe(true);
    expect(makeClientOrderId("grid-btcusd-01", 7).length).toBe(19);

    const violation = checkBotInstanceIdFitsVenue("kraken", "grid-btcusd-01");
    expect(violation).not.toBeNull();
    expect(describeVenueIdLengthViolation(violation!)).toContain("kraken");
    expect(describeVenueIdLengthViolation(violation!)).toContain("18");
  });

  it("accepts a kraken bot id at exactly the budget, and the generated shape", () => {
    expect(checkBotInstanceIdFitsVenue("kraken", "a".repeat(10))).toBeNull();
    // What `generatedId()` in the dashboard mints: "bot-" + 6 characters.
    expect(checkBotInstanceIdFitsVenue("kraken", "bot-1toiyz")).toBeNull();
    // And the real ids that are shorter still.
    expect(checkBotInstanceIdFitsVenue("kraken", "bot-ts1")).toBeNull();
    expect(checkBotInstanceIdFitsVenue("kraken", "v-spot-1")).toBeNull();
  });

  it("refuses the one real bot id that would not fit kraken, and accepts the other 30", () => {
    // The live testnet `bot_instances` ids, by length, as measured for this
    // change: one 11-character id, 27 at 10, two at 8, one at 7.
    const realIds = [
      "prop-live-1", // 11 -- the only one over the budget
      ...Array.from({ length: 27 }, (_, i) => `bot-${String(i).padStart(6, "0")}`), // 10
      "v-spot-1",
      "v-perp-1", // 8
      "bot-ts1", // 7
    ];
    expect(realIds).toHaveLength(31);

    const refused = realIds.filter((id) => checkBotInstanceIdFitsVenue("kraken", id) !== null);
    expect(refused).toEqual(["prop-live-1"]);
  });

  /**
   * THE BINANCE / GEMINI GUARANTEE. This change must not alter bot creation on
   * either working venue, and "must not" is stronger than "does not happen to":
   * the gate returns null for them unconditionally, so no input can make it
   * fire. These tests assert that, rather than sampling a few ids and hoping.
   */
  describe("is inert for binance and gemini", () => {
    const untouched: readonly VenueId[] = ["binance", "gemini"];

    it("keeps their budget at the scheme's original 36-character split", () => {
      for (const venue of untouched) {
        expect(VENUE_ORDER_ID_BUDGETS[venue]).toEqual({
          maxClientOrderIdLength: MAX_CLIENT_ORDER_ID_LENGTH,
          maxBotInstanceIdLength: MAX_BOT_INSTANCE_ID_LENGTH,
          reservedSequenceDigits: 12,
        });
      }
    });

    it("returns null for every id, including ones that are invalid for other reasons", () => {
      const ids = [
        "a",
        "bot-1toiyz",
        "grid-btcusd-01",
        "a".repeat(MAX_BOT_INSTANCE_ID_LENGTH),
        // Over the pattern's maximum. `assertBotInstanceId` in capital/ledger.ts
        // already refuses these with `invalid_bot_instance_id`; this gate must
        // not get there first and change that refusal's code or wording.
        "a".repeat(MAX_BOT_INSTANCE_ID_LENGTH + 1),
        "a".repeat(64),
        "",
      ];
      for (const venue of untouched) {
        for (const id of ids) {
          expect(
            checkBotInstanceIdFitsVenue(venue, id),
            `${venue} must not refuse ${JSON.stringify(id)}`,
          ).toBeNull();
        }
      }
    });
  });

  it("knows no ceiling for an unknown venue, and invents none", () => {
    expect(venueOrderIdBudget("coinbase")).toBeNull();
    expect(checkBotInstanceIdFitsVenue("coinbase", "a".repeat(64))).toBeNull();
    // Not fooled by inherited object properties.
    expect(venueOrderIdBudget("toString")).toBeNull();
    expect(venueOrderIdBudget("constructor")).toBeNull();
  });
});
