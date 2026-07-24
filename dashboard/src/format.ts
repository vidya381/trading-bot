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

/** Epoch ms -> a short local time string, or "—" for null. */
export function formatTime(epochMs: number | null): string {
  if (epochMs === null) return "—";
  return new Date(epochMs).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}
