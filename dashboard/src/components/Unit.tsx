/**
 * The currency or asset label that follows a number, and the separator between
 * two numbers that sit side by side.
 *
 * WHY THIS EXISTS AS A COMPONENT rather than a margin utility at each call site:
 * the unrealized figure rendered as "-0.05783555USD-0.12%". Its three parts were
 * separated only by Tailwind margins (`ml-1`, `ml-2`), and a margin is not a
 * separator. It puts space on screen while leaving the text nodes adjacent, so
 * the value reads as one run of characters at a glance, copies out of the page
 * glued together, and is announced by a screen reader with no break at all.
 *
 * Both parts below therefore emit a REAL space character as well as the visual
 * treatment. One component, so the two cannot drift apart again.
 */

import type { ReactNode } from "react";

/**
 * An asset or currency label after a figure: "10000.00 USD", "0.5 BTC".
 *
 * Sized and coloured down because the number is the thing being read and the
 * unit is what qualifies it -- but never so far down that it stops being part
 * of the same value.
 */
export function Unit({ children }: { children: ReactNode }) {
  return (
    <>
      {" "}
      <span className="text-xs font-normal text-zinc-500">{children}</span>
    </>
  );
}

/**
 * The break between two adjacent figures -- an amount and the percentage it
 * works out to, say. A bare space is not enough there: two numbers separated by
 * one space still read as a single quantity, so this puts a visible mark
 * between them, spaced on both sides. `aria-hidden` because it is punctuation,
 * not content: the spaces around it are what a screen reader needs.
 */
export function Separator() {
  return (
    <>
      {" "}
      <span aria-hidden className="font-normal text-zinc-600">
        ·
      </span>{" "}
    </>
  );
}
