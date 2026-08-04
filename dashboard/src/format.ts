/**
 * Display helpers. Money arrives from the API as an exact decimal string
 * ("500.00000000"); these only touch presentation and never feed arithmetic, so
 * string trimming is safe and no float ever exists.
 */

/**
 * Trim a fixed-precision decimal string for display: drop trailing zeros and a
 * trailing dot, keeping at least the integer part. "500.00000000" -> "500";
 * "12.34500000" -> "12.345"; "-0.00010000" -> "-0.0001". Purely cosmetic; the
 * exact string is still what the API holds.
 */
export function trimDecimal(value: string): string {
  if (!value.includes(".")) return value;
  return value.replace(/\.?0+$/, "");
}

/**
 * Round a decimal string to `places` decimals, half-up, WITHOUT a float.
 *
 * For figures that are derived rather than held: an unrealized-profit percentage
 * comes back at SCALE 8 ("3.21400000"), and `trimDecimal` alone would render
 * "3.214" -- more precision than a percentage can honestly carry, and visual
 * noise on a number read at a glance. Money is deliberately NOT put through this;
 * money keeps `trimDecimal` and its full exactness, as everywhere else here.
 *
 * A value that rounds to nothing keeps its zero rather than gaining a "-0.00":
 * a loss too small to show at this precision is not a negative number on screen.
 */
export function roundDecimal(value: string, places: number): string {
  const negative = value.startsWith("-");
  const [whole, fraction = ""] = (negative ? value.slice(1) : value).split(".");
  if (fraction.length <= places) return value;

  const kept = fraction.slice(0, places);
  const roundUp = fraction.charCodeAt(places) - 48 >= 5;
  const scaled = BigInt(`${whole}${kept}`) + (roundUp ? 1n : 0n);

  const digits = scaled.toString().padStart(places + 1, "0");
  const cut = digits.length - places;
  const rounded = places === 0 ? digits : `${digits.slice(0, cut)}.${digits.slice(cut)}`;
  return negative && /[1-9]/.test(rounded) ? `-${rounded}` : rounded;
}

// ---------------------------------------------------------------------------
// DISPLAY ROUNDING
//
// `trimDecimal` alone is not a rounding rule: it drops trailing zeros, so a
// value that HAS eight significant decimals keeps all eight. A real price came
// out as "66116.13259921" on the detail view, which is not a number anyone
// reads at a glance. The three helpers below are the display-rounding rules,
// named for what the value MEANS rather than for a digit count, so a call site
// picks the rule by saying what it is showing.
//
// None of this touches a stored value. Money remains an exact decimal string
// end to end (`src/shared/money.ts`, SCALE 8); these functions produce TEXT and
// their output never feeds arithmetic. No float is constructed anywhere.
// ---------------------------------------------------------------------------

/** Quote-asset money -- prices, costs, allocations, P&L. Cents, as USD is read. */
const MONEY_PLACES = 2;

/**
 * Base-asset quantities. 8 is the stored scale (`SCALE` in money.ts), so this
 * rounds nothing that the API can actually send; trailing zeros are then
 * trimmed, which is where the readability comes from -- "1.50000000" is "1.5"
 * and "0.00123400" is "0.001234". Deliberately NOT a tighter fixed width: a
 * held quantity is the thing the bot would sell, and truncating its last digits
 * on screen invites an operator to reconcile against a number the exchange does
 * not have.
 */
const QUANTITY_PLACES = 8;

/** Percentages. Two places, then trimmed, so "20.00000000" reads "20%". */
const PERCENT_PLACES = 2;

/** True when a decimal string carries no significant digit ("0", "-0.0000"). */
function isZero(value: string): boolean {
  return !/[1-9]/.test(value);
}

/**
 * Pad a decimal string out to exactly `places` decimals ("500" -> "500.00").
 * Only ever called with an already-rounded value, so it never truncates; the
 * sign travels with the integer part and needs no special handling.
 */
function padFraction(value: string, places: number): string {
  const [whole, fraction = ""] = value.split(".");
  return `${whole}.${fraction.padEnd(places, "0")}`;
}

/**
 * Would rounding to `places` erase a real value?
 *
 * Two decimals is right for a USD price and wrong for an asset that trades
 * below a cent: at 2 places a SHIB/USD price of "0.00002341" renders "0.00",
 * which is not a rounded number but a false one -- and worse than the
 * over-precision this whole module exists to fix, because it reads as zero.
 * Every helper below widens to the exact figure rather than show that. A number
 * on this dashboard is allowed to be long; it is not allowed to be wrong.
 *
 * Only a NON-zero input can trigger this. A genuine zero still renders as zero.
 */
function roundsAwayToZero(value: string, rounded: string): boolean {
  return isZero(rounded) && !isZero(value);
}

/**
 * Quote-asset money for display: two decimals, zero-padded so a column of them
 * lines up under `tabular` ("500" -> "500.00", "66116.13259921" -> "66116.13").
 *
 * Padding is what `trimDecimal` deliberately does not do, and both are correct
 * for their own case: an exact-value readout wants "500", a money column wants
 * "500.00" beside "12.34". This is the money column.
 */
export function formatMoney(value: string): string {
  const rounded = roundDecimal(value, MONEY_PLACES);
  // The widened form is exact and longer than two places; padding it would be
  // meaningless, so it returns as it is.
  if (roundsAwayToZero(value, rounded)) return trimDecimal(value);
  return padFraction(rounded, MONEY_PLACES);
}

/**
 * A base-asset quantity for display: exact to the stored scale, with trailing
 * zeros trimmed. Not padded -- unlike a money column, quantities across
 * different assets have no shared width to line up to.
 */
export function formatQuantity(value: string): string {
  const rounded = roundDecimal(value, QUANTITY_PLACES);
  if (roundsAwayToZero(value, rounded)) return trimDecimal(value);
  return trimDecimal(rounded);
}

/**
 * A percentage for display, WITH its "%" sign attached, because a bare number
 * that means a percentage is exactly the kind of unlabelled figure this module
 * is meant to stop producing.
 */
export function formatPercent(value: string): string {
  const rounded = roundDecimal(value, PERCENT_PLACES);
  const shown = roundsAwayToZero(value, rounded) ? value : rounded;
  return `${trimDecimal(shown)}%`;
}

/**
 * The base asset of a pair, given its quote (capital) asset. Binance symbols are
 * concatenated base+quote ("BTCUSDT"), so the base is the pair with the quote
 * suffix stripped. Falls back to the raw pair if it does not end in the quote.
 *
 * Here rather than in a component because three call sites now need it to LABEL
 * a quantity -- the previous two private copies in StartAction and LiquidateAction
 * were already one duplication too many.
 */
export function baseAssetOf(pair: string, quoteAsset: string): string {
  if (quoteAsset !== "" && pair.length > quoteAsset.length && pair.endsWith(quoteAsset)) {
    return pair.slice(0, pair.length - quoteAsset.length);
  }
  return pair;
}

/** A signed decimal string's sign, for colouring gains/losses. */
export function signOf(value: string): "positive" | "negative" | "zero" {
  if (value.startsWith("-")) return "negative";
  // "0", "0.00000000", "0.0" are all zero.
  return /[1-9]/.test(value) ? "positive" : "zero";
}

/**
 * Compare two decimal strings numerically, returning -1 / 0 / 1, WITHOUT ever
 * constructing a float (the same discipline the rest of this module keeps).
 *
 * Used only for display positioning -- e.g. deciding where the current price
 * breaks a grid ladder into sells-above and buys-below. Integer and fractional
 * parts are compared as `BigInt`, so precision past 2^53 or on fractional cents
 * is exact.
 */
export function compareDecimal(a: string, b: string): number {
  const negA = a.startsWith("-");
  const negB = b.startsWith("-");
  if (negA !== negB) return negA ? -1 : 1;
  const sign = negA ? -1 : 1;
  const [ai, af = ""] = (negA ? a.slice(1) : a).split(".");
  const [bi, bf = ""] = (negB ? b.slice(1) : b).split(".");
  const intA = BigInt(ai || "0");
  const intB = BigInt(bi || "0");
  if (intA !== intB) return intA < intB ? -sign : sign;
  const len = Math.max(af.length, bf.length);
  const fa = BigInt(af.padEnd(len, "0") || "0");
  const fb = BigInt(bf.padEnd(len, "0") || "0");
  if (fa === fb) return 0;
  return fa < fb ? -sign : sign;
}

/** Epoch ms -> a short local time string, or "—" for null. */
export function formatTime(epochMs: number | null): string {
  if (epochMs === null) return "—";
  return new Date(epochMs).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

/**
 * Epoch ms -> a full local date + time string, or "—" for null. Used where the
 * WHEN matters as a record, not just a freshness tick -- e.g. when the global
 * kill switch was tripped.
 */
export function formatDateTime(epochMs: number | null): string {
  if (epochMs === null) return "—";
  return new Date(epochMs).toLocaleString([], {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}
