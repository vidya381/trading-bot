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
