/**
 * The DCA position (this session's brief item 3, DCA arm).
 *
 * Shows every entry filled this cycle, the running average entry price, and how
 * many additional buys remain before the configured maximum (section 6.3).
 * `entries` are kept in fill order (base first) so the averaging progression
 * reads top-to-bottom. `additionalBuysUsed` and `maxAdditionalBuys` both exclude
 * the base order, so remaining is simply their difference.
 *
 * Genuinely different data from the grid ladder -- a list of executed buys, not
 * a ladder of resting price levels -- so it is its own component, dispatched by
 * `config.strategy` rather than shoehorned into a shared shape.
 */

import type { DcaParams, DcaPosition } from "../api/types";
import { formatTime, trimDecimal } from "../format";

function EntryRow({
  label,
  price,
  quantity,
  cost,
  at,
}: {
  label: string;
  price: string;
  quantity: string;
  cost: string;
  at: number;
}) {
  return (
    <div className="grid grid-cols-2 gap-x-4 gap-y-1 px-4 py-2 text-sm sm:grid-cols-5">
      <span className="font-medium text-zinc-300">{label}</span>
      <span className="tabular text-zinc-200 sm:text-right">{trimDecimal(price)}</span>
      <span className="tabular text-zinc-400 sm:text-right">{trimDecimal(quantity)}</span>
      <span className="tabular text-zinc-400 sm:text-right">{trimDecimal(cost)}</span>
      <span className="text-xs text-zinc-500 sm:text-right">{formatTime(at)}</span>
    </div>
  );
}

export function DcaPositionView({
  position,
  params,
}: {
  position: DcaPosition;
  params: DcaParams;
}) {
  const remaining = params.maxAdditionalBuys - position.additionalBuysUsed;
  const hasEntries = position.entries.length > 0;

  return (
    <section className="space-y-3">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-400">DCA position</h2>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 px-4 py-3">
          <div className="text-xs uppercase tracking-wide text-zinc-500">Average entry</div>
          <div className="tabular mt-1 text-lg font-semibold text-zinc-100">
            {position.averageEntryPrice === "0.00000000" ? (
              <span className="text-zinc-600">—</span>
            ) : (
              trimDecimal(position.averageEntryPrice)
            )}
          </div>
        </div>
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 px-4 py-3">
          <div className="text-xs uppercase tracking-wide text-zinc-500">Held quantity</div>
          <div className="tabular mt-1 text-lg font-semibold text-zinc-100">
            {trimDecimal(position.quantity)}
          </div>
        </div>
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 px-4 py-3">
          <div className="text-xs uppercase tracking-wide text-zinc-500">Total cost</div>
          <div className="tabular mt-1 text-lg font-semibold text-zinc-100">
            {trimDecimal(position.cost)}
          </div>
        </div>
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 px-4 py-3">
          <div className="text-xs uppercase tracking-wide text-zinc-500">Buys remaining</div>
          <div className="tabular mt-1 text-lg font-semibold text-zinc-100">
            {remaining}
            <span className="ml-1 text-xs font-normal text-zinc-500">
              of {params.maxAdditionalBuys} additional
            </span>
          </div>
        </div>
      </div>

      {hasEntries ? (
        <div className="overflow-hidden rounded-lg border border-zinc-800 divide-y divide-zinc-800/70">
          <div className="hidden grid-cols-5 gap-x-4 bg-zinc-900/60 px-4 py-2 text-xs uppercase tracking-wide text-zinc-500 sm:grid">
            <span>Entry</span>
            <span className="text-right">Price</span>
            <span className="text-right">Quantity</span>
            <span className="text-right">Cost</span>
            <span className="text-right">Filled</span>
          </div>
          {position.entries.map((entry, i) => (
            <EntryRow
              key={entry.clientOrderId}
              label={i === 0 ? "Base" : `Add ${i}`}
              price={entry.price}
              quantity={entry.quantity}
              cost={entry.cost}
              at={entry.at}
            />
          ))}
        </div>
      ) : (
        <div className="rounded-lg border border-dashed border-zinc-800 px-4 py-6 text-center text-sm text-zinc-500">
          No entries yet — the base order fires when the bot starts (section 6.3 step 2).
        </div>
      )}
    </section>
  );
}
