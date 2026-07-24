/**
 * The grid ladder (this session's brief item 3, grid arm).
 *
 * Renders the ladder highest price at the top, lowest at the bottom. Each level
 * shows its price and, if an order currently rests there, that order's side
 * (buy / sell) -- a level with no resting order is dimmed. The CURRENT PRICE
 * (`state.lastPrice`) is drawn as a divider inserted at its place in the ladder,
 * so the structure the spec describes reads visually: sells rest above it, buys
 * below (section 6.2). A subtle zone tint reinforces that even for orderless
 * levels.
 *
 * `levels` is ascending and index-aligned with `slots` (GridLadder). We keep
 * that alignment while sorting for display by pairing each level with its slot
 * first, then sorting the pairs descending by price with the float-free
 * `compareDecimal`.
 */

import type { GridLadder, GridParams } from "../api/types";
import { compareDecimal, trimDecimal } from "../format";
import { SideBadge } from "./SideBadge";

interface Rung {
  readonly price: string;
  readonly slot: GridLadder["slots"][number];
}

function LadderRow({ rung, zone }: { rung: Rung; zone: "sell" | "buy" | null }) {
  const zoneTint =
    zone === "sell" ? "bg-amber-500/[0.04]" : zone === "buy" ? "bg-emerald-500/[0.04]" : "";
  return (
    <div className={`flex items-center justify-between gap-4 px-4 py-2 ${zoneTint}`}>
      <span className="tabular text-sm text-zinc-200">{trimDecimal(rung.price)}</span>
      {rung.slot === null ? (
        <span className="text-xs text-zinc-600">no order</span>
      ) : (
        <span className="flex items-center gap-2">
          <SideBadge side={rung.slot.side} />
          <span className="tabular text-xs text-zinc-500">{trimDecimal(rung.slot.quantity)}</span>
        </span>
      )}
    </div>
  );
}

function CurrentPriceDivider({ price }: { price: string }) {
  return (
    <div className="flex items-center gap-3 bg-sky-500/10 px-4 py-1.5">
      <span className="h-px flex-1 bg-sky-500/40" aria-hidden />
      <span className="tabular text-xs font-medium text-sky-300">current {trimDecimal(price)}</span>
      <span className="h-px flex-1 bg-sky-500/40" aria-hidden />
    </div>
  );
}

export function GridLadderView({
  ladder,
  currentPrice,
  params,
}: {
  ladder: GridLadder;
  currentPrice: string | null;
  params: GridParams;
}) {
  // Pair each level with its slot, then sort descending (highest at top),
  // keeping the level<->slot alignment intact.
  const rungs: Rung[] = ladder.levels
    .map((price, i) => ({ price, slot: ladder.slots[i] ?? null }))
    .sort((a, b) => compareDecimal(b.price, a.price));

  // Where does the current price sit? The divider goes before the first rung
  // that is below it; a rung at/above the price is in the sell zone, below is buy.
  const dividerBefore =
    currentPrice === null
      ? -1
      : rungs.findIndex((r) => compareDecimal(r.price, currentPrice) < 0);

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-400">Grid ladder</h2>
        <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-zinc-500">
          <span>
            {trimDecimal(params.lowerBound)}–{trimDecimal(params.upperBound)}
          </span>
          <span className="text-zinc-600">·</span>
          <span>{params.gridLines} lines</span>
          <span className="text-zinc-600">·</span>
          <span>{params.spacing}</span>
          <span className="text-zinc-600">·</span>
          <span>size {trimDecimal(params.orderSize)}</span>
        </div>
      </div>

      {!ladder.placed && (
        <div className="rounded-lg border border-dashed border-zinc-800 px-4 py-3 text-sm text-zinc-500">
          The initial ladder has not been placed yet (the bot has not started, section 6.2 step 2).
        </div>
      )}

      <div className="overflow-hidden rounded-lg border border-zinc-800 divide-y divide-zinc-800/70">
        <div className="flex items-center justify-between bg-zinc-900/60 px-4 py-2 text-xs uppercase tracking-wide text-zinc-500">
          <span>Price</span>
          <span>Resting order</span>
        </div>
        {rungs.map((rung, i) => {
          const zone =
            currentPrice === null ? null : compareDecimal(rung.price, currentPrice) >= 0 ? "sell" : "buy";
          return (
            <div key={`${rung.price}-${i}`}>
              {i === dividerBefore && <CurrentPriceDivider price={currentPrice!} />}
              <LadderRow rung={rung} zone={zone} />
            </div>
          );
        })}
        {/* Current price sits below every level: divider at the very bottom. */}
        {currentPrice !== null && dividerBefore === -1 && rungs.length > 0 && (
          <CurrentPriceDivider price={currentPrice} />
        )}
      </div>

      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <div>
          <dt className="text-xs uppercase tracking-wide text-zinc-500">Held quantity</dt>
          <dd className="tabular text-sm text-zinc-200">{trimDecimal(ladder.heldQuantity)}</dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-wide text-zinc-500">Held cost</dt>
          <dd className="tabular text-sm text-zinc-200">{trimDecimal(ladder.heldCost)}</dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-wide text-zinc-500">Realized (gross)</dt>
          <dd className="tabular text-sm text-zinc-200">{trimDecimal(ladder.realizedGross)}</dd>
        </div>
      </dl>
    </section>
  );
}
