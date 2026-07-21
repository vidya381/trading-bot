import { describe, expect, it } from "vitest";
import type { Fill } from "./exchange-client";
import { convertFee, convertFillFee, FeeError, rateLookupFrom, realizedPnl, totalFees, type ConvertedFee, type RateLookup } from "./fees";
import { fromDecimalString as m } from "./money";

const AT = 1_700_000_000_000;
const USDT = "USDT";

const noRates: RateLookup = () => undefined;

function fee(asset: string, amount: string) {
  return { asset, amount: m(amount) };
}

describe("convertFee", () => {
  it("passes a fee already in the reporting currency through untouched", () => {
    const result = convertFee(fee(USDT, "1.25"), AT, USDT, noRates);

    expect(result.converted).toBe(true);
    if (result.converted) {
      expect(result.reportingAmount).toBe(m("1.25"));
      // No rate lookup is needed, so this cannot fail for want of one.
      expect(result.rateUsed).toBe(m("1"));
    }
  });

  it("converts a fee paid in a different asset at the fill-time rate", () => {
    // Section 5.5's central case: Binance charges the fee in BNB.
    const lookup = rateLookupFrom([
      { asset: "BNB", priceInReporting: m("600"), at: AT },
    ]);
    const result = convertFee(fee("BNB", "0.001"), AT, USDT, lookup);

    expect(result.converted).toBe(true);
    if (result.converted) {
      expect(result.reportingAmount).toBe(m("0.6")); // 0.001 * 600
      expect(result.rateUsed).toBe(m("600"));
      expect(result.asset).toBe("BNB");
      expect(result.amount).toBe(m("0.001"));
    }
  });

  it("reports failure instead of assuming zero when no rate exists", () => {
    // A silently-zero fee would inflate reported profit.
    const result = convertFee(fee("BNB", "0.001"), AT, USDT, noRates);

    expect(result.converted).toBe(false);
    if (!result.converted) {
      expect(result.reason).toBe("missing_rate");
      // The original fee is preserved so it can be resolved later.
      expect(result.asset).toBe("BNB");
      expect(result.amount).toBe(m("0.001"));
    }
  });

  it("rejects a zero or negative rate rather than using it", () => {
    for (const bad of ["0", "-600"]) {
      const lookup = rateLookupFrom([
        { asset: "BNB", priceInReporting: m(bad), at: AT },
      ]);
      const result = convertFee(fee("BNB", "0.001"), AT, USDT, lookup);
      expect(result.converted).toBe(false);
      if (!result.converted) expect(result.reason).toBe("invalid_rate");
    }
  });

  it("converts a zero fee without needing a rate decision", () => {
    const lookup = rateLookupFrom([
      { asset: "BNB", priceInReporting: m("600"), at: AT },
    ]);
    const result = convertFee(fee("BNB", "0"), AT, USDT, lookup);
    expect(result.converted).toBe(true);
    if (result.converted) expect(result.reportingAmount).toBe(0n);
  });
});

describe("rateLookupFrom", () => {
  const rates = [
    { asset: "BNB", priceInReporting: m("500"), at: AT },
    { asset: "BNB", priceInReporting: m("600"), at: AT + 10_000 },
    { asset: "BTC", priceInReporting: m("43120"), at: AT },
  ];

  it("uses the price at the time of fill, not the latest price", () => {
    // Section 5.5 is explicit that the fill-time price is the correct one.
    const lookup = rateLookupFrom(rates);
    expect(lookup("BNB", AT + 5000)).toBe(m("500"));
    expect(lookup("BNB", AT + 20_000)).toBe(m("600"));
  });

  it("returns undefined before any rate is known", () => {
    expect(rateLookupFrom(rates)("BNB", AT - 1)).toBeUndefined();
  });

  it("returns undefined for an asset it has no rates for", () => {
    expect(rateLookupFrom(rates)("SOL", AT)).toBeUndefined();
  });

  it("does not mix rates between assets", () => {
    expect(rateLookupFrom(rates)("BTC", AT)).toBe(m("43120"));
  });
});

describe("convertFillFee", () => {
  it("uses the fill's own execution time for the rate", () => {
    const fill: Fill = {
      fillId: "f1",
      price: m("43120.50"),
      quantity: m("0.25"),
      feeAmount: m("0.002"),
      feeAsset: "BNB",
      executedAt: AT + 10_000,
    };
    const lookup = rateLookupFrom([
      { asset: "BNB", priceInReporting: m("500"), at: AT },
      { asset: "BNB", priceInReporting: m("600"), at: AT + 10_000 },
    ]);

    const result = convertFillFee(fill, USDT, lookup);
    expect(result.converted).toBe(true);
    if (result.converted) {
      expect(result.rateUsed).toBe(m("600")); // the rate at executedAt
      expect(result.reportingAmount).toBe(m("1.2"));
    }
  });
});

describe("totalFees", () => {
  const lookup = rateLookupFrom([
    { asset: "BNB", priceInReporting: m("600"), at: AT },
  ]);

  it("sums converted fees exactly", () => {
    const fees = [
      convertFee(fee(USDT, "1.25"), AT, USDT, lookup),
      convertFee(fee("BNB", "0.001"), AT, USDT, lookup),
    ];
    const result = totalFees(fees);

    expect(result.total).toBe(m("1.85")); // 1.25 + 0.60
    expect(result.complete).toBe(true);
    expect(result.unconverted).toEqual([]);
  });

  it("marks the total incomplete and lists what is missing", () => {
    const fees = [
      convertFee(fee(USDT, "1.25"), AT, USDT, lookup),
      convertFee(fee("SOL", "0.5"), AT, USDT, lookup),
    ];
    const result = totalFees(fees);

    expect(result.complete).toBe(false);
    expect(result.total).toBe(m("1.25")); // partial, and flagged as such
    expect(result.unconverted).toHaveLength(1);
    expect(result.unconverted[0]?.asset).toBe("SOL");
  });

  it("treats an empty fee list as complete and zero", () => {
    expect(totalFees([])).toEqual({ total: 0n, unconverted: [], complete: true });
  });
});

describe("realizedPnl", () => {
  const lookup = rateLookupFrom([
    { asset: "BNB", priceInReporting: m("600"), at: AT },
  ]);

  it("subtracts fees from the gross price movement", () => {
    const result = realizedPnl({
      entryPrice: m("40000"),
      exitPrice: m("41000"),
      quantity: m("0.5"),
      fees: [convertFee(fee(USDT, "20"), AT, USDT, lookup)],
    });

    expect(result.complete).toBe(true);
    if (result.complete) {
      expect(result.gross).toBe(m("500")); // 1000 * 0.5
      expect(result.fees).toBe(m("20"));
      expect(result.net).toBe(m("480"));
    }
  });

  it("includes a fee paid in a third asset, converted", () => {
    const result = realizedPnl({
      entryPrice: m("40000"),
      exitPrice: m("41000"),
      quantity: m("0.5"),
      fees: [convertFee(fee("BNB", "0.01"), AT, USDT, lookup)], // 6 USDT
    });

    expect(result.complete).toBe(true);
    if (result.complete) expect(result.net).toBe(m("494"));
  });

  it("reports a loss as a negative net", () => {
    const result = realizedPnl({
      entryPrice: m("41000"),
      exitPrice: m("40000"),
      quantity: m("0.5"),
      fees: [convertFee(fee(USDT, "20"), AT, USDT, lookup)],
    });

    expect(result.complete).toBe(true);
    if (result.complete) {
      expect(result.gross).toBe(m("-500"));
      expect(result.net).toBe(m("-520")); // fees deepen the loss
    }
  });

  it("turns a small gross profit negative once fees are counted", () => {
    // The case where ignoring fees would report a winning trade.
    const result = realizedPnl({
      entryPrice: m("40000"),
      exitPrice: m("40010"),
      quantity: m("0.5"),
      fees: [convertFee(fee(USDT, "20"), AT, USDT, lookup)],
    });

    expect(result.complete).toBe(true);
    if (result.complete) {
      expect(result.gross).toBe(m("5"));
      expect(result.net).toBe(m("-15"));
    }
  });

  it("refuses to report a net figure when a fee could not be converted", () => {
    const result = realizedPnl({
      entryPrice: m("40000"),
      exitPrice: m("41000"),
      quantity: m("0.5"),
      fees: [
        convertFee(fee(USDT, "20"), AT, USDT, lookup),
        convertFee(fee("SOL", "0.5"), AT, USDT, lookup),
      ],
    });

    expect(result.complete).toBe(false);
    if (!result.complete) {
      expect(result.gross).toBe(m("500"));
      expect(result.fees).toBe(m("20")); // at least this much
      expect(result.unconverted).toHaveLength(1);
      // No `net` key at all, so a caller cannot read an overstated profit.
      expect("net" in result).toBe(false);
    }
  });

  it("handles a position closed with no fees", () => {
    const result = realizedPnl({
      entryPrice: m("40000"),
      exitPrice: m("41000"),
      quantity: m("1"),
      fees: [],
    });
    expect(result.complete).toBe(true);
    if (result.complete) expect(result.net).toBe(m("1000"));
  });

  it("rejects a non-positive quantity", () => {
    const base = { entryPrice: m("1"), exitPrice: m("2"), fees: [] as ConvertedFee[] };
    expect(() => realizedPnl({ ...base, quantity: 0n })).toThrow(FeeError);
    expect(() => realizedPnl({ ...base, quantity: m("-1") })).toThrow(FeeError);
  });

  it("stays exact across a fractional quantity", () => {
    const result = realizedPnl({
      entryPrice: m("43120.50"),
      exitPrice: m("43220.50"),
      quantity: m("0.125"),
      fees: [],
    });
    expect(result.complete).toBe(true);
    if (result.complete) expect(result.gross).toBe(m("12.5"));
  });
});
