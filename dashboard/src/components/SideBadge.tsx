/**
 * Buy/sell pill, one place so the grid ladder and the order history colour a
 * side identically: buy is emerald (accumulating), sell is amber (distributing).
 */

import type { OrderSide } from "../api/types";

const SIDE_CLASS: Record<OrderSide, string> = {
  buy: "bg-emerald-500/15 text-emerald-300 ring-emerald-500/30",
  sell: "bg-amber-500/15 text-amber-300 ring-amber-500/30",
};

export function SideBadge({ side }: { side: OrderSide }) {
  return (
    <span
      className={`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ring-1 ring-inset ${SIDE_CLASS[side]}`}
    >
      {side}
    </span>
  );
}
