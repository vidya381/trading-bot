/**
 * The trailing stop's high-water mark ratchet (spec 22.2 decision 3).
 *
 * TESTED AS ARITHMETIC, NOT THROUGH A DURABLE OBJECT, and deliberately: no
 * trailing-stop bot can be CREATED yet -- `POST /api/bots` has no branch for one
 * and there is no strategy module -- so an end-to-end price-feed test of this
 * property is not writable until the strategy exists. `raisesHighWaterMark` is
 * the whole of the decision the price path makes, exported precisely so the
 * property can be pinned now rather than after the fact.
 *
 * ⚠ WHAT THIS DOES NOT COVER, stated so it is not mistaken for more than it is:
 * this is not 22.3's dropped-candle test. That one requires a real bot, a real
 * feed, and a simulated delivery failure, and 22.3 makes it a hard precondition
 * for shipping. Nothing here substitutes for it.
 */
import { describe, expect, it } from "vitest";

import { raisesHighWaterMark } from "./bot-instance";
import { fromDecimalString, type Money } from "../shared/money";

const m = (value: string): Money => fromDecimalString(value);

/**
 * The price path's own logic, folded over a sequence -- the same call the mutate
 * in `#onPriceUpdatePass` makes, so this walks the real decision rather than a
 * paraphrase of it.
 */
function markAfter(
  strategy: "trailing_stop" | "dca" | "grid",
  prices: readonly string[],
): Money | undefined {
  let mark: Money | undefined;
  for (const price of prices) {
    if (raisesHighWaterMark(strategy, mark, m(price))) mark = m(price);
  }
  return mark;
}

describe("the high-water mark ratchets up and never down", () => {
  it("takes the first price it ever sees, since there is no prior high", () => {
    expect(raisesHighWaterMark("trailing_stop", undefined, m("100"))).toBe(true);
    expect(markAfter("trailing_stop", ["100"])).toBe(m("100"));
  });

  it("rises on a genuine new high", () => {
    expect(raisesHighWaterMark("trailing_stop", m("100"), m("101"))).toBe(true);
  });

  it("does NOT move on a lower price -- the point of the whole field", () => {
    expect(raisesHighWaterMark("trailing_stop", m("100"), m("99"))).toBe(false);
  });

  it("does NOT rewrite on an equal price, so a flat market costs no writes", () => {
    expect(raisesHighWaterMark("trailing_stop", m("100"), m("100"))).toBe(false);
  });

  it("keeps the peak across a rise, a fall, and a partial recovery", () => {
    // Up to 120, down to 90, back to 110 -- the shape a trailing stop exists for.
    // The mark must still read 120: the recovery never exceeded the peak.
    expect(markAfter("trailing_stop", ["100", "105", "120", "90", "80", "110"])).toBe(m("120"));
  });

  it("only ever increases, checked step by step over a noisy sequence", () => {
    const prices = ["100", "98", "103", "101", "103", "99", "107", "107", "104", "112"];
    let mark: Money | undefined;
    const seen: Money[] = [];
    for (const price of prices) {
      const before = mark;
      if (raisesHighWaterMark("trailing_stop", mark, m(price))) mark = m(price);
      // The invariant, asserted on EVERY tick rather than only at the end: a
      // final-value check would pass even if the mark had dipped in between.
      if (before !== undefined) expect(mark!).toBeGreaterThanOrEqual(before);
      seen.push(mark!);
    }
    expect(mark).toBe(m("112"));
    // And it moved only on the four genuine new highs.
    expect(new Set(seen.map(String)).size).toBe(4);
  });
});

describe("dca and grid bots never carry the field", () => {
  it("refuses to raise a mark for a dca bot, even on a rising price", () => {
    expect(raisesHighWaterMark("dca", undefined, m("100"))).toBe(false);
    expect(raisesHighWaterMark("dca", m("100"), m("999"))).toBe(false);
  });

  it("refuses to raise a mark for a grid bot, even on a rising price", () => {
    expect(raisesHighWaterMark("grid", undefined, m("100"))).toBe(false);
    expect(raisesHighWaterMark("grid", m("100"), m("999"))).toBe(false);
  });

  it("leaves the mark ABSENT for both, so their stored state is unchanged", () => {
    // `undefined`, not null and not zero. The price path adds the key only when
    // this predicate is true, so a DCA or grid bot's state keeps exactly the
    // shape it had before this field existed.
    expect(markAfter("dca", ["100", "105", "120"])).toBeUndefined();
    expect(markAfter("grid", ["100", "105", "120"])).toBeUndefined();
  });
});
