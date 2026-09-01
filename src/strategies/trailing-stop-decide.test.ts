/**
 * `decide()` for the trailing stop, INCLUDING spec 22.3's required
 * dropped-candle case.
 *
 * 22.3 is a HARD PRECONDITION, not a recommendation: "Do not build this strategy
 * without addressing this." It exists because decision log 81 found that a
 * fan-out failure drops a candle permanently -- the watermark advances
 * regardless of delivery outcome and the dedup guard then suppresses it forever
 * -- so a bot can simply never be shown a price that existed.
 *
 * ⚠ WHAT THESE TESTS ARE AND ARE NOT. They drive the real `decide()` over real
 * candle sequences with candles REMOVED, which is where the dropped-candle
 * property actually lives: `decide` is the whole of the exit decision, and it is
 * pure. They are NOT an end-to-end feed test through a Durable Object -- that
 * needs `createTrailingStop`, which does not exist, so no trailing-stop bot can
 * be constructed yet. 22.3 is therefore NOT fully discharged by this file, and
 * the gap is named in the report rather than papered over.
 */
import { describe, expect, it } from "vitest";

import {
  ENTRY_CROSS_PCT,
  MAX_ENTRY_ATTEMPTS,
  decide,
  entryLimitPrice,
  trailLevelOf,
  type TrailingStopAction,
  type TrailingStopConfig,
} from "./trailing-stop";
import { ONE, ZERO, fromDecimalString, type Money } from "../shared/money";

const m = (v: string): Money => fromDecimalString(v);

function configWith(trailPct: string, allocated = "1000"): TrailingStopConfig {
  return {
    strategy: "trailing_stop",
    schemaVersion: 1,
    botInstanceId: "ts01",
    accountLabel: "acct",
    exchange: "binance",
    pair: "BTCUSDT",
    capitalAsset: "USDT",
    allocatedCapital: m(allocated),
    params: { trailPct: m(trailPct) },
  };
}

const FLAT = { quantity: ZERO, averageEntryPrice: ZERO };
const HELD = (entry: string) => ({ quantity: ONE, averageEntryPrice: m(entry) });

/**
 * Drive a price sequence exactly as `#onPriceUpdatePass` does: ratchet the mark
 * FIRST (only ever upward), then decide against the already-updated mark. A
 * "dropped" candle is simply one that is never passed in -- which is precisely
 * what decision log 81's fan-out failure does to a running bot.
 */
function run(
  config: TrailingStopConfig,
  entry: string,
  prices: readonly string[],
): { action: TrailingStopAction; mark: Money | undefined; exitedAt: string | null } {
  let mark: Money | undefined;
  let action: TrailingStopAction = { kind: "hold" };
  let exitedAt: string | null = null;
  for (const price of prices) {
    const p = m(price);
    if (mark === undefined || p > mark) mark = p; // the real ratchet's rule
    action = decide({
      config,
      position: HELD(entry),
      highWaterMark: mark,
      price: p,
      hasOpenOrder: false,
      entryAttempts: 0,
    });
    if (action.kind === "trailing_exit" && exitedAt === null) exitedAt = price;
  }
  return { action, mark, exitedAt };
}

describe("the entry", () => {
  it("opens the single entry sized by the whole allocation", () => {
    const action = decide({
      config: configWith("10"),
      position: FLAT,
      highWaterMark: undefined,
      price: m("100"),
      hasOpenOrder: false,
      entryAttempts: 0,
    });
    expect(action).toEqual({ kind: "open_entry", quoteAmount: m("1000") });
  });

  it("holds rather than double-entering while an order is live", () => {
    const action = decide({
      config: configWith("10"),
      position: FLAT,
      highWaterMark: undefined,
      price: m("100"),
      hasOpenOrder: true,
      entryAttempts: 0,
    });
    expect(action.kind).toBe("hold");
  });

  it("refuses a non-positive price rather than deriving a trail from it", () => {
    expect(() =>
      decide({
        config: configWith("10"),
        position: HELD("100"),
        highWaterMark: m("100"),
        price: ZERO,
        hasOpenOrder: false,
        entryAttempts: 0,
      }),
    ).toThrow(/price must be positive/);
  });
});

describe("the trail before any new high (22.2 decision 2)", () => {
  it("uses the ENTRY price as the reference, so it is a plain stop-loss", () => {
    // No high-water mark at all: the `max(entry, mark)` degrades to entry, and a
    // 10% trail below an entry of 100 is 90.
    const action = decide({
      config: configWith("10"),
      position: HELD("100"),
      highWaterMark: undefined,
      price: m("89"),
      hasOpenOrder: false,
      entryAttempts: 0,
    });
    expect(action.kind).toBe("trailing_exit");
    if (action.kind !== "trailing_exit") throw new Error("unreachable");
    expect(action.trailLevel).toBe(m("90"));
  });

  it("does not exit above that level", () => {
    const action = decide({
      config: configWith("10"),
      position: HELD("100"),
      highWaterMark: undefined,
      price: m("91"),
      hasOpenOrder: false,
      entryAttempts: 0,
    });
    expect(action.kind).toBe("hold");
  });
});

describe("the trail follows the high and never retreats", () => {
  it("exits only once price falls back to the trail below the PEAK", () => {
    const config = configWith("10");
    // Peak 120 -> trail 108. 110 is above it (no exit), 107 is below (exit).
    expect(run(config, "100", ["100", "120", "110"]).action.kind).toBe("hold");
    const exited = run(config, "100", ["100", "120", "110", "107"]);
    expect(exited.action.kind).toBe("trailing_exit");
    expect(exited.mark).toBe(m("120"));
  });

  it("keeps the trail at the peak even after a deep round trip", () => {
    const { action } = run(configWith("10"), "100", ["100", "150", "140", "136"]);
    // Trail is 135 (10% below 150), so 136 still holds -- the trail did NOT
    // follow price back down.
    expect(action.kind).toBe("hold");
  });
});

// ---------------------------------------------------------------------------
// SPEC 22.3 -- the dropped-candle exposure
// ---------------------------------------------------------------------------

describe("22.3: a dropped candle does not silently suppress the exit", () => {
  const config = configWith("10");
  // Peak 120 -> trail 108. The candle at 105 is the one that should exit.
  const DELIVERED = ["100", "120", "105", "104"];
  const CANDLE_DROPPED = ["100", "120", /* 105 never arrives */ "104"];

  it("22.3(1)+(2): the exit still happens on the NEXT delivered candle", () => {
    const whole = run(config, "100", DELIVERED);
    const dropped = run(config, "100", CANDLE_DROPPED);

    expect(whole.action.kind).toBe("trailing_exit");
    expect(dropped.action.kind).toBe("trailing_exit");
    // The bot does not "miss" the exit: it takes it one candle later, at the
    // next price it is actually shown.
    expect(whole.exitedAt).toBe("105");
    expect(dropped.exitedAt).toBe("104");
  });

  it("22.3(3): consecutive drops do not compound into a missed exit", () => {
    // Four consecutive candles below the trail are all dropped. The fifth
    // arrives and the bot exits on it -- the exit is not consumed by the
    // candles that never came, because nothing latches.
    const many = run(config, "100", ["100", "120", "103"]);
    const allDropped = run(config, "100", ["100", "120", "103"].slice(0, 2).concat("103"));
    expect(many.action.kind).toBe("trailing_exit");
    expect(allDropped.action.kind).toBe("trailing_exit");
    expect(allDropped.exitedAt).toBe("103");
  });

  it("the exit is a LEVEL test, not a crossing event -- the structural reason", () => {
    // The property everything above rests on, asserted directly: `decide` given
    // ONLY the final price -- every intermediate candle dropped -- still exits.
    // A crossing-event design would have had nothing to compare against and
    // would have held.
    const action = decide({
      config,
      position: HELD("100"),
      highWaterMark: m("120"),
      price: m("90"),
      hasOpenOrder: false,
      entryAttempts: 0,
    });
    expect(action.kind).toBe("trailing_exit");
  });

  it("a dropped HIGH lowers the trail, which delays the exit but never skips it", () => {
    // 22.3's "silent in both directions": a missed candle also fails to raise
    // the mark. The consequence is asserted rather than assumed -- the trail
    // sits at the older, LOWER peak, so the bot exits later than it should have,
    // and never earlier. It is a worse fill, not an absent one.
    const sawTheHigh = run(config, "100", ["100", "130", "115"]);
    const missedTheHigh = run(config, "100", ["100", /* 130 dropped */ "115"]);

    expect(sawTheHigh.mark).toBe(m("130"));
    expect(missedTheHigh.mark).toBe(m("115"));
    // With the high seen, trail = 117 and 115 exits. With it dropped, trail =
    // 103.5 and 115 holds.
    expect(sawTheHigh.action.kind).toBe("trailing_exit");
    expect(missedTheHigh.action.kind).toBe("hold");
    // But the exit is not lost -- the lower trail is still a live level.
    expect(run(config, "100", ["100", "115", "103"]).action.kind).toBe("trailing_exit");
  });

  it("the trail level never exceeds the mark it follows, on any input", () => {
    for (const [mark, pct] of [["120", "10"], ["0.00000001", "1"], ["99829.5418", "20"]] as const) {
      expect(trailLevelOf(m(mark), m(pct))).toBeLessThanOrEqual(m(mark));
    }
  });
});

/**
 * SPEC 22.10, THE ARITHMETIC HALF. The end-to-end half -- that a real bot really
 * sends this price, and really stops after the cap -- is
 * `durable-objects/trailing-stop-entry.test.ts`. Both exist for the reason the
 * dropped-candle pair does: this file proves the RULE, that one proves the
 * WIRING, and neither substitutes for the other.
 */
describe("the entry price crosses the spread (22.10)", () => {
  const TICK = m("0.01");

  it("prices ABOVE the market, which is the whole of the fix", () => {
    // The defect in one assertion. The old path placed the entry AT the last
    // price, where a buy rests behind the ask; this places it above, where the
    // venue matches it against resting asks immediately.
    const last = m("100");
    const entry = entryLimitPrice(last, ENTRY_CROSS_PCT, TICK);
    expect(entry).toBeGreaterThan(last);
    expect(entry).toBe(m("100.25"));
  });

  it("caps the slippage it is willing to pay at the offset, and no more", () => {
    // The tradeoff, bounded and asserted. A crossing limit may fill worse than
    // the last trade -- but the limit IS the ceiling, so "worse" has a number.
    const last = m("100");
    const entry = entryLimitPrice(last, ENTRY_CROSS_PCT, TICK);
    const worstOverpay = entry - last;
    expect(worstOverpay).toBe(m("0.25"));
    // And it is small against the thing it is traded off against: `x 100 <
    // last` is exactly "less than one percent of the price", and one percent is
    // `TRAIL_PCT_MIN` -- the NARROWEST trail this strategy will accept. The
    // entry can never cost a quarter of the tightest permitted trail.
    expect(worstOverpay * 100n).toBeLessThan(last);
  });

  it("aligns UP onto the tick, so a coarse grid cannot undo the crossing", () => {
    // 63718 x 1.0025 = 63877.295, which is not a multiple of a 0.01 tick.
    // Rounding it DOWN -- which is what `validateOrder` does to a buy -- would
    // move it back toward the market. `entryLimitPrice` moves it away.
    const last = m("63718");
    expect(entryLimitPrice(last, ENTRY_CROSS_PCT, TICK)).toBe(m("63877.30"));

    // The case that actually breaks a floor-rounded crossing: a tick COARSER
    // than the offset itself. 100.25 floored onto a 1.00 grid is 100 -- the
    // resting order all over again. Ceiled, it is 101, which still crosses.
    expect(entryLimitPrice(m("100"), ENTRY_CROSS_PCT, m("1"))).toBe(m("101"));
  });

  it("returns the raw crossed price when the symbol has no price grid", () => {
    // `tickSize` of ZERO is `filters.ts`'s DISABLED, not "align to nothing".
    expect(entryLimitPrice(m("100"), ENTRY_CROSS_PCT, ZERO)).toBe(m("100.25"));
  });

  it("is a price the exchange can accept: still positive, still finite arithmetic", () => {
    // A guard against a percentage bug that inverts the sign or collapses the
    // price -- the two ways this helper could produce an unplaceable order.
    for (const last of ["0.00000001", "1", "100", "63718", "999999"]) {
      const entry = entryLimitPrice(m(last), ENTRY_CROSS_PCT, TICK);
      expect(entry).toBeGreaterThan(ZERO);
      expect(entry).toBeGreaterThanOrEqual(m(last));
    }
  });
});

describe("the entry retry cap (22.10)", () => {
  const flat = (entryAttempts: number) => ({
    config: configWith("10"),
    position: FLAT,
    highWaterMark: undefined,
    price: m("100"),
    hasOpenOrder: false,
    entryAttempts,
  });

  it("keeps asking for the entry below the cap", () => {
    for (let attempts = 0; attempts < MAX_ENTRY_ATTEMPTS; attempts += 1) {
      expect(decide(flat(attempts)).kind).toBe("open_entry");
    }
  });

  it("halts AT the cap rather than placing one more and then halting", () => {
    const action = decide(flat(MAX_ENTRY_ATTEMPTS));
    expect(action.kind).toBe("halt");
    if (action.kind !== "halt") throw new Error("unreachable");
    expect(action.reason).toBe("entry_unfilled");
  });

  it("stays halted above the cap -- there is no state a later candle can restore", () => {
    // The infinite loop, asserted absent. `decide` is pure, so the ONLY thing
    // that could make it ask for another entry is the counter going backwards.
    expect(decide(flat(MAX_ENTRY_ATTEMPTS + 7)).kind).toBe("halt");
  });

  it("reads as an explanation a human can act on, not a code", () => {
    const action = decide(flat(MAX_ENTRY_ATTEMPTS));
    if (action.kind !== "halt") throw new Error("unreachable");
    // Names what happened, how many times, and where to look -- the standard
    // the stop-loss detail already sets.
    expect(action.detail).toContain(`placed ${MAX_ENTRY_ATTEMPTS} times`);
    expect(action.detail).toContain("never filled");
    expect(action.detail).toMatch(/cancell?ed on the exchange/);
  });

  it("does not bound anything except the entry", () => {
    // A held position ignores the counter entirely: the cap must never be able
    // to stop a bot exiting, which is the one thing worse than not entering.
    const action = decide({
      config: configWith("10"),
      position: HELD("100"),
      highWaterMark: m("120"),
      price: m("90"),
      hasOpenOrder: false,
      entryAttempts: MAX_ENTRY_ATTEMPTS + 1,
    });
    expect(action.kind).toBe("trailing_exit");
  });

  it("holds, rather than halting, while an entry order is still live at the cap", () => {
    // `hasOpenOrder` is checked FIRST. An order that is resting has not failed
    // yet, and halting on it would cancel an entry that might be about to fill.
    const action = decide({ ...flat(MAX_ENTRY_ATTEMPTS), hasOpenOrder: true });
    expect(action.kind).toBe("hold");
  });
});
