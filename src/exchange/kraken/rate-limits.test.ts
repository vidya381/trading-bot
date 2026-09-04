/**
 * Kraken's published rate-limit constants, pinned against the real documentation.
 *
 * ── WHAT "REAL DATA" MEANS IN THIS FILE, AND WHERE IT DOES NOT ──
 *
 * Every other Kraken test file here drives fixtures captured from live requests.
 * This one CANNOT, and saying so precisely matters more than the tests do:
 *
 *   - Kraken publishes no rate-limit headers. Confirmed live on 2026-09-03 on
 *     BOTH `GET /0/public/Time` and `POST /0/private/Balance` -- neither carried
 *     one, and `access-control-expose-headers` listed only `date`,
 *     `x-internal-auth` and `x-trace-id`, so there is not a hidden one either.
 *     There is therefore no response to capture a counter from.
 *   - Observing the counters directly means deliberately exceeding them on a
 *     real funded account, which is not something a test suite does.
 *
 * So these assertions pin the DOCUMENTED tables, re-read from the live sources on
 * 2026-09-03 rather than carried over from entry 90's research. Each block names
 * its source. Where Kraken's two sources CONTRADICT each other, the test asserts
 * the contradiction as well as the choice, so neither can be quietly dropped.
 *
 * The worked examples at the end are the strongest evidence available: they are
 * Kraken's OWN arithmetic, published alongside the tables, and they check the
 * ladder end to end rather than transcribing it twice.
 */

import { describe, expect, it } from "vitest";
import {
  KRAKEN_ADD_ORDER_COST,
  KRAKEN_AGE_SAFETY_MARGIN_MS,
  KRAKEN_CANCEL_AGE_COSTS,
  KRAKEN_CANCEL_COST_UNKNOWN_AGE,
  KRAKEN_DEFAULT_TIER,
  KRAKEN_REST_COUNTER_COSTS,
  KRAKEN_REST_TIERS,
  KRAKEN_TRADING_TIERS,
  krakenCancelCost,
} from "./rate-limits";

describe("the REST call counter, per tier", () => {
  it("matches docs.kraken.com/api/docs/guides/spot-rest-ratelimits verbatim", () => {
    // Re-read live 2026-09-03. CONFIRMED unchanged from entry 90's table, which
    // is the finding this session was asked to verify rather than assume.
    expect(KRAKEN_REST_TIERS).toEqual({
      starter: { maxCounter: 15, decayPerSecond: 0.33 },
      intermediate: { maxCounter: 20, decayPerSecond: 0.5 },
      pro: { maxCounter: 20, decayPerSecond: 1 },
    });
  });

  it("assumes Starter, the most conservative REAL tier, until an account says otherwise", () => {
    // ⚠ CHOSEN, NOT OBSERVED: no real Kraken account exists yet. Starter is the
    // smallest counter AND the slowest decay on both budgets, so every model
    // built on it over-estimates for a higher account and never under-estimates.
    expect(KRAKEN_DEFAULT_TIER).toBe("starter");

    for (const tier of ["intermediate", "pro"] as const) {
      expect(KRAKEN_REST_TIERS[tier].maxCounter).toBeGreaterThanOrEqual(
        KRAKEN_REST_TIERS.starter.maxCounter,
      );
      expect(KRAKEN_REST_TIERS[tier].decayPerSecond).toBeGreaterThanOrEqual(
        KRAKEN_REST_TIERS.starter.decayPerSecond,
      );
      expect(KRAKEN_TRADING_TIERS[tier].threshold).toBeGreaterThanOrEqual(
        KRAKEN_TRADING_TIERS.starter.threshold,
      );
      expect(KRAKEN_TRADING_TIERS[tier].decayPerSecond).toBeGreaterThanOrEqual(
        KRAKEN_TRADING_TIERS.starter.decayPerSecond,
      );
    }
  });

  it("charges account history 4, the expensive side of Kraken contradicting Kraken", () => {
    // ⚠ THE CONTRADICTION, ASSERTED RATHER THAN RESOLVED SILENTLY.
    //
    //   docs.kraken.com : "Ledger/trade history calls increase the counter by 2.
    //                      All other API calls increase this counter by 1."
    //   support.kraken.com article 206548367, updated 2026-08-10:
    //                     "Account history endpoints (Ledgers, TradesHistory,
    //                      ClosedOrders) -- +4".
    //
    // They differ on the multiplier AND on the membership: only support names
    // `ClosedOrders`, which this client really calls, on both the cancel path and
    // the status path. 4 is charged -- the higher figure, from the only source
    // that names the endpoint. This assertion exists so that changing it to the
    // docs' 2 is a deliberate edit against a stated reason, not a tidy-up.
    expect(KRAKEN_REST_COUNTER_COSTS.accountHistory).toBe(4);
    expect(KRAKEN_REST_COUNTER_COSTS.accountHistory).toBeGreaterThan(2);
    expect(KRAKEN_REST_COUNTER_COSTS.standardPrivate).toBe(1);
    // AddOrder/CancelOrder are excluded from this counter by BOTH sources.
    expect(KRAKEN_REST_COUNTER_COSTS.trading).toBe(0);
  });
});

describe("the per-pair matching-engine counter", () => {
  it("matches docs.kraken.com/api/docs/guides/spot-ratelimits verbatim", () => {
    // Re-read live 2026-09-03. CONFIRMED unchanged from entry 90's table.
    expect(KRAKEN_TRADING_TIERS).toEqual({
      starter: { threshold: 60, decayPerSecond: 1 },
      intermediate: { threshold: 125, decayPerSecond: 2.34 },
      pro: { threshold: 180, decayPerSecond: 3.75 },
    });
  });

  it("prices the cancel ladder exactly as the published table does", () => {
    // | Transaction  | Fixed | <5s | <10s | <15s | <45s | <90s | <300s |
    // | Cancel Order |   -   | +8  |  +6  |  +5  |  +4  |  +2  |  +1   |
    expect(KRAKEN_CANCEL_AGE_COSTS).toEqual([
      { underMs: 5_000, cost: 8 },
      { underMs: 10_000, cost: 6 },
      { underMs: 15_000, cost: 5 },
      { underMs: 45_000, cost: 4 },
      { underMs: 90_000, cost: 2 },
      { underMs: 300_000, cost: 1 },
    ]);
    expect(KRAKEN_ADD_ORDER_COST).toBe(1);
  });

  it("gets monotonically cheaper with age, which is the venue's whole incentive", () => {
    const costs = KRAKEN_CANCEL_AGE_COSTS.map((rung) => rung.cost);
    for (let i = 1; i < costs.length; i++) {
      expect(costs[i]!).toBeLessThan(costs[i - 1]!);
    }
    // And the rungs are in ascending age order, which `krakenCancelCost` relies
    // on: it returns the FIRST rung the age fits under.
    const bounds = KRAKEN_CANCEL_AGE_COSTS.map((rung) => rung.underMs);
    expect([...bounds].sort((a, b) => a - b)).toEqual(bounds);
  });
});

describe("krakenCancelCost", () => {
  // Ages are quoted as the TRUE age. The function biases them younger by the
  // safety margin before walking the ladder, so the expectations below are what
  // this system charges, which is at or above what Kraken charges -- never below.
  it.each([
    ["brand new", 0, 8],
    ["3s (entry 90's worst case)", 3_000, 8],
    ["8s", 8_000, 6],
    ["12s", 12_000, 5],
    ["30s", 30_000, 4],
    ["60s", 60_000, 2],
    ["200s", 200_000, 1],
    ["301s", 301_000, 0],
  ])("charges a %s order %d ms -> %d", (_label, ageMs, expected) => {
    expect(krakenCancelCost(ageMs)).toBe(expected);
  });

  it("charges the maximum when the age is unknown, so a failed lookup cannot be cheap", () => {
    // FAIL-CLOSED BY CONSTRUCTION. The path least likely to hold a local record
    // is reconciliation, which cancels orders this system has lost track of --
    // exactly where a cheap "we could not tell" would do the most damage.
    expect(krakenCancelCost(null)).toBe(KRAKEN_CANCEL_COST_UNKNOWN_AGE);
    expect(krakenCancelCost(null)).toBe(8);
    expect(krakenCancelCost(Number.NaN)).toBe(8);
    expect(krakenCancelCost(Number.POSITIVE_INFINITY)).toBe(8);

    // It is the most expensive rung there is, not merely a large number.
    const dearest = Math.max(...KRAKEN_CANCEL_AGE_COSTS.map((rung) => rung.cost));
    expect(KRAKEN_CANCEL_COST_UNKNOWN_AGE).toBe(dearest);
  });

  it("treats a backwards clock as brand new, not as ancient", () => {
    // A negative age means the clock disagrees with itself. Reading it as a very
    // old order would charge 0 for the cancel Kraken charges 8 for.
    expect(krakenCancelCost(-1)).toBe(8);
    expect(krakenCancelCost(-500_000)).toBe(8);
  });

  it("rounds an order near a boundary to the DEARER side, never the cheaper", () => {
    // `orders.created_at` is written before Kraken accepts the order, so the
    // measured age runs long and the ladder gets cheaper with age -- naive
    // measurement under-charges precisely at the boundaries.
    expect(KRAKEN_AGE_SAFETY_MARGIN_MS).toBe(1_000);

    // Exactly on Kraken's 5s boundary: the venue would say <10s (+6), this says
    // +8. Over-charging by one rung is the intended direction.
    expect(krakenCancelCost(5_000)).toBe(8);
    // Far enough past it that the margin cannot reach back.
    expect(krakenCancelCost(6_001)).toBe(6);

    // The property, at every published boundary: charging the true age is never
    // MORE than charging the margin-adjusted age.
    for (const rung of KRAKEN_CANCEL_AGE_COSTS) {
      const atBoundary = krakenCancelCost(rung.underMs);
      const justInside = krakenCancelCost(rung.underMs - 1);
      expect(atBoundary).toBeGreaterThanOrEqual(justInside === 0 ? 0 : 1);
      expect(atBoundary).toBeGreaterThanOrEqual(
        krakenCancelCost(rung.underMs + KRAKEN_AGE_SAFETY_MARGIN_MS + 1),
      );
    }
  });
});

describe("Kraken's own worked examples reproduce", () => {
  // These are published BESIDE the tables, so they check the ladder end to end
  // instead of transcribing it a second time. If a rung were mistyped, the
  // tables above would still agree with themselves and these would not.

  it("support 360045239571: place, then cancel after 8 seconds, costs 7", () => {
    // "60% of which were filled after 3 seconds, and 40% of which were cancelled
    // after 8 seconds: Order penalty = (1 * 60%) + (7 * 40%)". The 7 is one point
    // for the add plus six for a cancel in the <10s band -- which is also the
    // corroboration that Cancel Order has NO fixed component.
    const cancelledAt8s = KRAKEN_ADD_ORDER_COST + krakenCancelCost(8_000);
    expect(cancelledAt8s).toBe(7);

    const filledAt3s = KRAKEN_ADD_ORDER_COST;
    expect(filledAt3s).toBe(1);
  });

  it("docs spot-ratelimits: add, amend at 7s, cancel 36s later, totals 8", () => {
    // Kraken's table: add fixed +1, amend fixed +1, amend decay <15s +2, cancel
    // decay <45s +4 -- a total of 8 on that pair.
    //
    // ⚠ Amend Order is NOT modelled by this system (no `RestExchangeClient`
    // method amends), so its two components are the published constants written
    // out here rather than computed. The CANCEL is computed, and it is the half
    // this system is responsible for: the order was amended at 7s and cancelled
    // 36s after that, and age runs from the amend, so 43s -> the <45s rung.
    const addFixed = KRAKEN_ADD_ORDER_COST;
    const amendFixed = 1;
    const amendDecayUnder15s = 2;
    const cancelAt43sSinceAmend = krakenCancelCost(43_000);

    expect(cancelAt43sSinceAmend).toBe(4);
    expect(addFixed + amendFixed + amendDecayUnder15s + cancelAt43sSinceAmend).toBe(8);
  });

  it("support 360045239571: a pro account placing and cancelling 20 orders at 3s spends 180", () => {
    // "(20 orders x 1 order placing point) + (20 orders x 8 order cancellation
    // points) = 180 points" -- and 180 is exactly the Pro threshold, so the
    // example also pins that constant against the ladder.
    const perOrder = KRAKEN_ADD_ORDER_COST + krakenCancelCost(3_000);
    expect(perOrder).toBe(9);
    expect(20 * perOrder).toBe(180);
    expect(20 * perOrder).toBe(KRAKEN_TRADING_TIERS.pro.threshold);
  });

  it("entry 90's worst case still holds at the tier this system assumes", () => {
    // ⚠ The warning entry 90 raised, recomputed rather than repeated: cancelling
    // freshly-laid ladder orders is the most expensive thing this system can do,
    // and Starter's per-pair threshold is small enough that a handful exhausts it.
    const freshCancel = krakenCancelCost(3_000);
    expect(freshCancel).toBe(8);

    const starter = KRAKEN_TRADING_TIERS.starter.threshold;
    const cancelsBeforeRefusal = Math.floor(starter / freshCancel);
    expect(cancelsBeforeRefusal).toBe(7);

    // And the same cancels on five-minute-old orders cost nothing at all, which
    // is the eight-fold spread the age dependency exists to express.
    expect(krakenCancelCost(301_000)).toBe(0);
  });
});
