/**
 * Fee handling (spec section 5.5).
 *
 * Three rules from the spec, in order of importance:
 *  1. Read the ACTUAL fee asset and amount from each fill. Binance commonly
 *     charges in BNB, so assuming the quote currency silently understates cost.
 *  2. Convert to the reporting currency using the price at time of fill, not
 *     the current price.
 *  3. Include fees in realized PnL explicitly.
 *
 * When a conversion rate is unavailable this module reports failure rather than
 * substituting zero. A fee that quietly becomes zero inflates reported profit,
 * and the error would only surface much later as a balance discrepancy in
 * reconciliation -- by which point its cause is hard to find.
 */

import type { Asset, Fill, Timestamp } from "./exchange-client";
import { mul, ONE, sum, ZERO, type Money, type Rounding } from "./money";

/** The currency all reporting is denominated in, e.g. "USDT". */
export type ReportingCurrency = Asset;

/**
 * Rounding for fee conversion.
 *
 * Half-even, because fees are summed across many fills and a directionally
 * biased mode would accumulate a drift in reported cost.
 */
const FEE_ROUNDING: Rounding = "half-even";

/** A fee asset's price in the reporting currency, at a point in time. */
export interface ConversionRate {
  asset: Asset;
  /** Price of one unit of `asset` in the reporting currency. */
  priceInReporting: Money;
  at: Timestamp;
}

/**
 * Supplies the rate for an asset at the time of a fill.
 *
 * Synchronous and pure by design: converting a fee must not perform I/O, so
 * rates are gathered in advance. `undefined` means genuinely unknown, and the
 * caller must handle it rather than receiving a fabricated value.
 */
export interface RateLookup {
  (asset: Asset, at: Timestamp): Money | undefined;
}

export type FeeConversionFailure =
  /** No rate was available for the fee asset at that time. */
  | "missing_rate"
  /** A rate was supplied but was zero or negative. */
  | "invalid_rate";

export type ConvertedFee =
  | {
      converted: true;
      asset: Asset;
      /** The fee as the exchange reported it, in its own asset. */
      amount: Money;
      /** The same fee expressed in the reporting currency. */
      reportingAmount: Money;
      /** The rate used; ONE when the fee was already in the reporting currency. */
      rateUsed: Money;
      at: Timestamp;
    }
  | {
      converted: false;
      asset: Asset;
      amount: Money;
      reason: FeeConversionFailure;
      at: Timestamp;
    };

/** Build a lookup from a fixed set of rates. Nearest rate at or before the fill. */
export function rateLookupFrom(rates: readonly ConversionRate[]): RateLookup {
  return (asset, at) => {
    const candidates = rates
      .filter((rate) => rate.asset === asset && rate.at <= at)
      .sort((a, b) => b.at - a.at);
    return candidates[0]?.priceInReporting;
  };
}

/**
 * Convert one fee into the reporting currency.
 *
 * A fee already denominated in the reporting currency needs no rate and cannot
 * fail, which matters because that is the common case and it should not depend
 * on rate availability.
 */
export function convertFee(
  fee: { asset: Asset; amount: Money },
  at: Timestamp,
  reporting: ReportingCurrency,
  lookup: RateLookup,
): ConvertedFee {
  if (fee.asset === reporting) {
    return {
      converted: true,
      asset: fee.asset,
      amount: fee.amount,
      reportingAmount: fee.amount,
      rateUsed: ONE,
      at,
    };
  }

  const rate = lookup(fee.asset, at);
  if (rate === undefined) {
    return {
      converted: false,
      asset: fee.asset,
      amount: fee.amount,
      reason: "missing_rate",
      at,
    };
  }
  if (rate <= ZERO) {
    return {
      converted: false,
      asset: fee.asset,
      amount: fee.amount,
      reason: "invalid_rate",
      at,
    };
  }

  return {
    converted: true,
    asset: fee.asset,
    amount: fee.amount,
    reportingAmount: mul(fee.amount, rate, FEE_ROUNDING),
    rateUsed: rate,
    at,
  };
}

/**
 * Convert the fee attached to a fill, using the price at the time of that fill
 * rather than the current price.
 */
export function convertFillFee(
  fill: Fill,
  reporting: ReportingCurrency,
  lookup: RateLookup,
): ConvertedFee {
  return convertFee(
    { asset: fill.feeAsset, amount: fill.feeAmount },
    fill.executedAt,
    reporting,
    lookup,
  );
}

/** Total converted fees, plus whatever could not be converted. */
export interface FeeTotal {
  /** Sum of the fees that converted successfully. */
  total: Money;
  /** Fees that could not be converted. Non-empty means `total` is incomplete. */
  unconverted: readonly ConvertedFee[];
  /** True when every fee converted, so `total` is the complete cost. */
  complete: boolean;
}

/**
 * Sum converted fees, keeping any failures visible.
 *
 * The unconverted list is returned rather than thrown so a caller can still
 * display a partial figure -- clearly marked incomplete -- instead of showing
 * nothing at all.
 */
export function totalFees(fees: readonly ConvertedFee[]): FeeTotal {
  const converted = fees.filter((fee) => fee.converted);
  const unconverted = fees.filter((fee) => !fee.converted);

  return {
    total: sum(converted.map((fee) => fee.reportingAmount)),
    unconverted,
    complete: unconverted.length === 0,
  };
}

/** Inputs to a realized PnL calculation, all in the reporting currency. */
export interface RealizedPnlInput {
  /** Average price the position was entered at. */
  entryPrice: Money;
  /** Price the position was exited at. */
  exitPrice: Money;
  /** Quantity closed. Must be positive. */
  quantity: Money;
  /** Fees incurred across both entry and exit, already converted. */
  fees: readonly ConvertedFee[];
}

export type RealizedPnl =
  | {
      /** Every fee converted, so `net` is trustworthy. */
      complete: true;
      /** Price movement alone, before costs. */
      gross: Money;
      /** Total fees in the reporting currency. */
      fees: Money;
      /** Gross minus fees: the figure that matters. */
      net: Money;
    }
  | {
      complete: false;
      gross: Money;
      /** Fees that did convert; the true total is at least this. */
      fees: Money;
      /** Deliberately absent: a net figure computed from incomplete costs
       *  would overstate profit, so none is offered. */
      unconverted: readonly ConvertedFee[];
    };

export class FeeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FeeError";
  }
}

/**
 * Realized PnL with fees included explicitly, per section 5.5.
 *
 * When any fee failed to convert, no `net` is returned at all. Reporting a net
 * figure that omits a known-but-unquantified cost would overstate profit, and
 * an overstated profit is exactly the error a trading system must not make
 * quietly.
 */
export function realizedPnl(input: RealizedPnlInput): RealizedPnl {
  if (input.quantity <= ZERO) {
    throw new FeeError(`quantity must be positive, got ${input.quantity}`);
  }

  // Half-even for the same reason as elsewhere: no directional bias when
  // accumulated across many closed positions.
  const gross = mul(input.exitPrice - input.entryPrice, input.quantity, "half-even");
  const { total, unconverted, complete } = totalFees(input.fees);

  if (!complete) {
    return { complete: false, gross, fees: total, unconverted };
  }
  return { complete: true, gross, fees: total, net: gross - total };
}
