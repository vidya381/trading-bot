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

import type { ReactNode } from "react";
import type { DcaParams, DcaPosition } from "../api/types";
import { formatTime, trimDecimal } from "../format";
import { takeProfitPriceOf, unrealizedPnl } from "../derive";
import { ConfigItem, ConfigSection, enabled, percent } from "./ConfigSection";
import { UnrealizedValue, unrealizedHint } from "./UnrealizedValue";

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

/** One stat card, matching the four this section already rendered inline. */
function Card({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 px-4 py-3">
      <div className="text-xs uppercase tracking-wide text-zinc-500">{label}</div>
      <div className="tabular mt-1 text-lg font-semibold text-zinc-100">{children}</div>
      {hint && <div className="mt-0.5 text-xs text-zinc-500">{hint}</div>}
    </div>
  );
}

export function DcaPositionView({
  position,
  params,
  currentPrice,
  capitalAsset,
}: {
  position: DcaPosition;
  params: DcaParams;
  /** `state.lastPrice` -- the same live price the summary above shows. */
  currentPrice: string | null;
  capitalAsset: string;
}) {
  const remaining = params.maxAdditionalBuys - position.additionalBuysUsed;
  const hasEntries = position.entries.length > 0;

  // The price this cycle exits at, and what the position is worth right now.
  // Both are derived, exact-decimal, and read-only -- see derive.ts for the
  // conventions and where each formula comes from in the backend.
  const takeProfitAt = takeProfitPriceOf(position.averageEntryPrice, params.takeProfitPct);
  const pnl = unrealizedPnl(position.quantity, position.cost, currentPrice);

  return (
    <section className="space-y-3">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-400">DCA position</h2>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <Card label="Average entry">
          {position.averageEntryPrice === "0.00000000" ? (
            <span className="text-zinc-600">—</span>
          ) : (
            trimDecimal(position.averageEntryPrice)
          )}
        </Card>
        {/*
         * The whole position sells at or above this price (section 6.3 step 4).
         * "—" while the bot holds nothing: with no average entry there is no
         * price to measure from, and showing 0 would read as "sells at any
         * price". The percentage is repeated in the hint so the number can be
         * checked against the configured parameter without scrolling.
         */}
        <Card
          label="Take-profit at"
          hint={takeProfitAt === null ? "no average entry yet" : `avg entry +${percent(params.takeProfitPct)}`}
        >
          {takeProfitAt === null ? (
            <span className="text-zinc-600">—</span>
          ) : (
            <span className="text-emerald-300">{trimDecimal(takeProfitAt)}</span>
          )}
        </Card>
        <Card label="Held quantity">{trimDecimal(position.quantity)}</Card>
        <Card label="Total cost" hint={capitalAsset}>
          {trimDecimal(position.cost)}
        </Card>
        {/*
         * Unrealized, and labelled "(gross)" for the same reason the summary's
         * realized figure is: cost carries no fees (see derive.ts). It sits next
         * to the realized card on purpose -- that one counts CLOSED cycles only,
         * this one counts what is still open, and an operator reading either in
         * isolation would draw the wrong conclusion about the bot's position.
         */}
        <Card
          label="Unrealized (gross)"
          hint={unrealizedHint(position.quantity, currentPrice)}
        >
          <UnrealizedValue pnl={pnl} capitalAsset={capitalAsset} />
        </Card>
        <Card label="Buys remaining">
          {remaining}
          <span className="ml-1 text-xs font-normal text-zinc-500">
            of {params.maxAdditionalBuys} additional
          </span>
        </Card>
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

      {/*
       * What this bot was created with (section 6.3). Read-only: these were
       * validated against allocated capital at creation and the running object
       * has been acting on them since -- see ConfigSection's note.
       */}
      <ConfigSection>
        <ConfigItem label="Base order size" hint={capitalAsset}>
          {trimDecimal(params.baseOrderSize)}
        </ConfigItem>
        <ConfigItem label="Additional order size" hint={capitalAsset}>
          {trimDecimal(params.additionalOrderSize)}
        </ConfigItem>
        {/* Each additional buy is the previous one x this, floored per step. */}
        <ConfigItem label="Step multiplier" hint="compounds each additional buy">
          {trimDecimal(params.stepMultiplier)}×
        </ConfigItem>
        {/*
         * Measured from the LAST ENTRY, not the average -- `nextBuyTriggerPrice`
         * in src/strategies/dca.ts is explicit that averaging the reference up
         * would make each successive buy fire sooner than configured.
         */}
        <ConfigItem label="Drop per buy" hint="from the last entry price">
          {percent(params.dropPct)}
        </ConfigItem>
        <ConfigItem label="Max additional buys" hint="excludes the base order">
          {params.maxAdditionalBuys}
        </ConfigItem>
        <ConfigItem label="Take-profit" hint="above average entry">
          {percent(params.takeProfitPct)}
        </ConfigItem>
        <ConfigItem label="Stop-loss" hint="below average entry">
          {percent(params.stopLossPct)}
        </ConfigItem>
        <ConfigItem label="Auto-restart" hint="new cycle after a take-profit">
          {enabled(params.autoRestart)}
        </ConfigItem>
        {/*
         * Shown although the brief listed eight parameters, because it is the one
         * config value whose meaning an operator is most likely to assume wrongly:
         * a stop-loss HALT cancels open orders and leaves the position held. The
         * backend rejects `true` as unimplemented, so this always reads Disabled
         * -- and saying so is the point.
         */}
        <ConfigItem label="Sell on stop-loss" hint="a stop-loss halts and holds the position">
          {enabled(params.sellOnStopLoss)}
        </ConfigItem>
      </ConfigSection>
    </section>
  );
}
