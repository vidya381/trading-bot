/**
 * The per-pair open-order ceiling, and the creation-time check built on it.
 *
 * ── WHAT "REAL DATA" MEANS IN THIS FILE ──
 *
 * The same limitation `rate-limits.test.ts` states applies here and is worth
 * repeating rather than cross-referencing: there is no live fixture to capture.
 * Kraken publishes no header carrying an open-order count, and observing the
 * ceiling means deliberately filling a real pair's book to 60 orders on a funded
 * account. So the VENUE half of these tests pins the documented table -- that is
 * done in `kraken/rate-limits.test.ts`, against the raw docs page and support's
 * worked example, and is not duplicated here.
 *
 * What IS tested here is the part that is this system's own and therefore fully
 * observable: the venue table's totality, the two deliberate nulls, the headroom
 * arithmetic, and the two failures the check is actually for -- the grid that
 * outgrows the ceiling, and the one it admits it cannot catch.
 */

import { describe, expect, it } from "vitest";
import { EXCHANGE_IDS } from "../db/schema";
import { ORDERS_LIMIT_EXCEEDED_ERROR, classifyKrakenError } from "./kraken/parse";
import { KRAKEN_OPEN_ORDER_CEILINGS, krakenOpenOrderCeiling } from "./kraken/rate-limits";
import {
  OPEN_ORDER_CEILINGS,
  OPEN_ORDER_HEADROOM,
  checkOpenOrderCeiling,
  describeOpenOrderCeilingViolation,
  openOrderCeilingFor,
} from "./open-orders";

describe("OPEN_ORDER_CEILINGS", () => {
  it("covers every ExchangeId, so a fourth venue fails to compile rather than inherit one", () => {
    expect(Object.keys(OPEN_ORDER_CEILINGS).sort()).toEqual([...EXCHANGE_IDS].sort());
  });

  it("takes Kraken's number from the tier table rather than restating it", () => {
    // Not `toBe(60)`. If this asserted the literal, confirming a real account's
    // tier would change `rate-limits.ts` and leave this file quietly claiming
    // the old ceiling -- the exact duplication `venueOrderIdBudget` avoids by
    // holding one table. The literal itself is pinned in `rate-limits.test.ts`
    // against the docs page, which is where a documentation claim belongs.
    expect(OPEN_ORDER_CEILINGS.kraken).toBe(krakenOpenOrderCeiling());
    expect(OPEN_ORDER_CEILINGS.kraken).toBe(KRAKEN_OPEN_ORDER_CEILINGS.starter);
  });

  it("is null for binance and gemini, and null means UNVERIFIED, not unlimited", () => {
    // ⚠ These two nulls are weaker claims than `BATCH_CANCEL_COSTS`' nulls, and
    // the difference is the reason this test names both venues separately.
    // There, null is a finding: no such endpoint exists. Here it says only that
    // no number has been read. Binance really does publish a per-symbol
    // MAX_NUM_ORDERS filter; `binance/filters.ts` does not parse it, so there is
    // nothing verified to put here and a guessed constant would refuse valid
    // bots at creation.
    expect(OPEN_ORDER_CEILINGS.binance).toBeNull();
    expect(OPEN_ORDER_CEILINGS.gemini).toBeNull();
  });
});

describe("openOrderCeilingFor", () => {
  it("returns null for an unrecognised venue rather than inventing a limit", () => {
    // Free-typed strings really do reach this: `CreateGridBotRequest.exchange`
    // and `bot_instances.exchange` are both `string`. Mirrors
    // `venueOrderIdBudget`, which returns null for the same reason.
    expect(openOrderCeilingFor("coinbase")).toBeNull();
    expect(openOrderCeilingFor("")).toBeNull();
    expect(openOrderCeilingFor("KRAKEN")).toBeNull(); // case-sensitive, like isExchangeId
  });
});

describe("checkOpenOrderCeiling", () => {
  const ceiling = KRAKEN_OPEN_ORDER_CEILINGS.starter; // 60
  const allowance = ceiling - OPEN_ORDER_HEADROOM; // 55

  it("admits a ladder exactly at the allowance and refuses the next rung", () => {
    // The boundary in both directions, because an off-by-one here either
    // refuses a legal 55-line grid or admits a 56-line one that eats the
    // headroom it was told to leave.
    expect(checkOpenOrderCeiling("kraken", allowance)).toBeNull();
    expect(checkOpenOrderCeiling("kraken", allowance + 1)).not.toBeNull();
  });

  it("refuses BELOW the venue's own ceiling, which is the headroom doing its job", () => {
    // A 58-line grid fits on Kraken and is still refused. That is deliberate and
    // is the whole content of OPEN_ORDER_HEADROOM: the venue counts across every
    // bot on the account and pair, and this check can only see one bot.
    const violation = checkOpenOrderCeiling("kraken", 58);
    expect(violation).not.toBeNull();
    expect(58).toBeLessThan(ceiling);
    expect(violation!.allowance).toBe(allowance);
    expect(violation!.headroom).toBe(OPEN_ORDER_HEADROOM);
    expect(violation!.ceiling).toBe(ceiling);
  });

  it("reports every number its message needs, so the caller composes no arithmetic", () => {
    expect(checkOpenOrderCeiling("kraken", 100)).toEqual({
      exchange: "kraken",
      peakOpenOrders: 100,
      ceiling: 60,
      headroom: 5,
      allowance: 55,
    });
  });

  it("passes every input on a venue with no known ceiling", () => {
    // NOT a silent hole: it keeps today's exact behaviour on those venues, which
    // is the reactive path. Refusing on a limit nobody has verified would be a
    // worse error than not preventing one.
    for (const peak of [2, 60, 1_000]) {
      expect(checkOpenOrderCeiling("binance", peak)).toBeNull();
      expect(checkOpenOrderCeiling("gemini", peak)).toBeNull();
      expect(checkOpenOrderCeiling("coinbase", peak)).toBeNull();
    }
  });

  it("does NOT catch two grids sharing one account and pair, and does not pretend to", () => {
    // The known gap, pinned so it is a recorded limitation rather than a bug
    // somebody discovers later. Two 40-line grids each pass; together they need
    // 80 orders on a pair that holds 60.
    expect(checkOpenOrderCeiling("kraken", 40)).toBeNull();
    expect(40 + 40).toBeGreaterThan(ceiling);
  });
});

describe("describeOpenOrderCeilingViolation", () => {
  it("names the venue's real error string, so an operator can search for it", () => {
    const violation = checkOpenOrderCeiling("kraken", 70)!;
    const message = describeOpenOrderCeilingViolation(violation);

    expect(message).toContain(ORDERS_LIMIT_EXCEEDED_ERROR);
    expect(message).toContain("70");
    expect(message).toContain("55");
    expect(message).toContain("60");
    expect(message).toContain("kraken");
  });
});

describe("the prevention and the backstop are aimed at the SAME refusal", () => {
  it("classifies the string this check exists to avoid as a definite, non-retryable refusal", () => {
    // The join between the two halves of this work, asserted in one place so
    // neither can drift from the other. If `parse.ts` ever reclassified this
    // string as retryable, a bot that slipped past the creation-time check would
    // re-send into an identical refusal instead of halting -- and the ceiling is
    // a level, so "identical" means forever.
    expect(classifyKrakenError(ORDERS_LIMIT_EXCEEDED_ERROR, 1_700_000_000_000)).toEqual({
      kind: "exchange_error",
      retryable: false,
    });
  });
});
