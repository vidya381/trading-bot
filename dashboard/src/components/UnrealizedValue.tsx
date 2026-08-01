/**
 * The unrealized (mark-to-market) profit figure, shared by the DCA position and
 * the grid ladder because the number means exactly the same thing in both:
 * what the position the bot is STILL HOLDING is worth at the current price,
 * against what was paid for it.
 *
 * Deliberately distinct from "Realized (gross)", which counts only closed
 * cycles. The two are read side by side, so this one says "unrealized" in its
 * label and never borrows the other's wording.
 *
 * Every value arrives as an exact decimal string from `derive.ts`; this file
 * only colours and trims it (`format.ts` discipline -- no float, ever).
 */

import type { UnrealizedPnl } from "../derive";
import { roundDecimal, signOf, trimDecimal } from "../format";

const SIGN_CLASS: Record<ReturnType<typeof signOf>, string> = {
  positive: "text-emerald-300",
  negative: "text-red-300",
  zero: "text-zinc-400",
};

/** A leading "+" on a gain, so direction reads without relying on colour alone. */
function signed(value: string): string {
  return signOf(value) === "positive" ? `+${value}` : value;
}

/**
 * Why there is no figure to show, or `undefined` when there is one. The two
 * causes are genuinely different and an operator needs to tell them apart: a bot
 * holding nothing has no profit to have, while a bot that has seen no usable
 * price has a position whose worth is simply not known (section 5.6 -- an
 * unusable price is reported, never guessed at).
 */
export function unrealizedHint(quantity: string, currentPrice: string | null): string | undefined {
  if (signOf(quantity) === "zero") return "no position held";
  if (currentPrice === null) return "no price yet";
  return undefined;
}

export function UnrealizedValue({
  pnl,
  capitalAsset,
}: {
  pnl: UnrealizedPnl | null;
  capitalAsset: string;
}) {
  if (pnl === null) return <span className="text-zinc-600">—</span>;

  return (
    <span className={SIGN_CLASS[signOf(pnl.amount)]}>
      {signed(trimDecimal(pnl.amount))}
      <span className="ml-1 text-xs font-normal text-zinc-500">{capitalAsset}</span>
      {pnl.pct !== null && (
        <span className="ml-2 text-sm font-medium">{signed(roundDecimal(pnl.pct, 2))}%</span>
      )}
    </span>
  );
}
