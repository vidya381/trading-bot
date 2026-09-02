/**
 * The trailing-stop position (spec 22, 22.4 touchpoint 5).
 *
 * The third strategy view, beside `DcaPositionView` and `GridLadderView` and
 * built to the same shape: a heading with the configuration summary inline, a
 * row of stat cards, the fills that built the position, then the read-only
 * configuration block. Every shared piece -- `Card`-style tiles, `ConfigSection`,
 * `Unit`, `UnrealizedValue` -- is reused rather than reinvented, because the data
 * genuinely matches: a held quantity, a cost basis and a mark-to-market figure
 * mean exactly the same thing here as they do for DCA.
 *
 * WHAT IS GENUINELY DIFFERENT, and therefore has no shared component: the
 * HIGH-WATER MARK and the TRAIL LEVEL. No other strategy has a stop that moves,
 * and the pair only makes sense read together -- the mark is the highest price
 * seen since entry, and the level is the price the bot exits at, trailing that
 * mark by `trailPct`. They are rendered adjacent and the level carries the mark
 * in its hint for that reason.
 *
 * ⚠ THE TRAIL LEVEL IS THE BACKEND'S NUMBER, not one computed here. See
 * `trailingStopFigures` in ../strategyView.ts for why a second copy of that
 * arithmetic in the dashboard would be a worse bug than no figure at all.
 *
 * Money stays an exact decimal string end to end; `format.ts` rounds only the
 * rendered text and no float is ever constructed.
 */

import type { ReactNode } from "react";
import type { DcaPosition, TrailingStopParams } from "../api/types";
import type { TrailingStopFigures } from "../strategyView";
import { formatMoney, formatQuantity, formatTime } from "../format";
import { unrealizedPnl } from "../derive";
import { ConfigItem, ConfigSection, percent } from "./ConfigSection";
import { Unit } from "./Unit";
import { UnrealizedValue, unrealizedHint } from "./UnrealizedValue";

/** One stat card. Same shape as the DCA view's, so the two pages read alike. */
function Card({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 px-4 py-3">
      <div className="text-xs uppercase tracking-wide text-zinc-500">{label}</div>
      <div className="tabular mt-1 text-lg font-semibold text-zinc-100">{children}</div>
      {hint && <div className="mt-0.5 text-xs text-zinc-500">{hint}</div>}
    </div>
  );
}

/** The em dash every "no value" cell in this dashboard uses. */
function Absent() {
  return <span className="text-zinc-600">—</span>;
}

/**
 * One entry fill. A single-entry strategy (22.2 decision 4) normally has exactly
 * one, but a partially-filled entry appends more than one row, so this is a list
 * rather than a single line -- and the columns match the DCA view's exactly.
 */
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
      <span className="tabular text-zinc-200 sm:text-right">{formatMoney(price)}</span>
      <span className="tabular text-zinc-400 sm:text-right">{formatQuantity(quantity)}</span>
      <span className="tabular text-zinc-400 sm:text-right">{formatMoney(cost)}</span>
      <span className="text-xs text-zinc-500 sm:text-right">{formatTime(at)}</span>
    </div>
  );
}

export function TrailingStopView({
  figures,
  position,
  params,
  currentPrice,
  capitalAsset,
  baseAsset,
  allocatedCapital,
  entryAttempts,
}: {
  /**
   * The published position's figures, or `null` when the payload's position is
   * not a trailing-stop one -- a seam mismatch the panel states rather than
   * reading fields off the wrong variant.
   */
  figures: TrailingStopFigures | null;
  /** The raw runtime position, for the entry fills. Shared with DCA (`applyEntry`). */
  position: DcaPosition;
  params: TrailingStopParams;
  /** `state.lastPrice` -- the same live price the summary above shows. */
  currentPrice: string | null;
  capitalAsset: string;
  /** The asset the position is HELD in, for labelling quantities. */
  baseAsset: string;
  allocatedCapital: string;
  /**
   * Entry-order placements so far (spec 22.10), or null when the state carries
   * none -- which is both "not placed yet" and state written before the field
   * existed. Shown only when it is a real, non-zero count.
   */
  entryAttempts: number | null;
}) {
  if (figures === null) {
    return (
      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-400">
          Trailing stop
        </h2>
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-4 py-4 text-sm text-amber-200">
          This bot is configured as a trailing stop, but the position the API published is not a
          trailing-stop one. Nothing is shown rather than a figure read off the wrong shape.
        </div>
      </section>
    );
  }

  const pnl = unrealizedPnl(figures.heldQuantity, figures.cost, currentPrice);
  const hasEntries = position.entries.length > 0;

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-400">
          Trailing stop
        </h2>
        <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-zinc-500">
          <span className="tabular">trailing {percent(params.trailPct)} below the high</span>
          <span className="text-zinc-600">·</span>
          <span className="tabular">
            single entry sized by {formatMoney(allocatedCapital)} {capitalAsset}
          </span>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {/*
         * A REAL entry price, not an average of many: 22.2 decision 4 makes this
         * a single-entry strategy, so the stored `averageEntryPrice` averages one
         * fill (or the parts of one). The label says "Entry price" for that
         * reason -- calling it an average would imply a position built in steps,
         * which is the neighbouring strategy.
         */}
        <Card label="Entry price" hint={figures.entryPrice === null ? "not entered yet" : undefined}>
          {figures.entryPrice === null ? (
            <Absent />
          ) : (
            <>
              {formatMoney(figures.entryPrice)}
              <Unit>{capitalAsset}</Unit>
            </>
          )}
        </Card>
        {/*
         * THE TWO FIGURES THIS STRATEGY EXISTS FOR, side by side and in this
         * order: the mark is what has been achieved, the level is what will be
         * given back. Both are null until the first price arrives, and null is
         * rendered as "—" rather than 0 -- a trail level of zero would read as a
         * stop that can never trigger, which is the opposite of the truth.
         */}
        <Card
          label="High-water mark"
          hint={figures.highWaterMark === null ? "no price seen yet" : "highest since entry"}
        >
          {figures.highWaterMark === null ? (
            <Absent />
          ) : (
            <>
              {formatMoney(figures.highWaterMark)}
              <Unit>{capitalAsset}</Unit>
            </>
          )}
        </Card>
        <Card
          label="Trail level"
          hint={
            figures.trailLevel === null
              ? "no high-water mark yet"
              : `high-water mark −${percent(params.trailPct)}`
          }
        >
          {figures.trailLevel === null ? (
            <Absent />
          ) : (
            /* Amber, not red: this is a live exit threshold, not an error. */
            <span className="text-amber-300">
              {formatMoney(figures.trailLevel)}
              <Unit>{capitalAsset}</Unit>
            </span>
          )}
        </Card>
        <Card label="Held quantity">
          {formatQuantity(figures.heldQuantity)}
          <Unit>{baseAsset}</Unit>
        </Card>
        <Card label="Total cost">
          {formatMoney(figures.cost)}
          <Unit>{capitalAsset}</Unit>
        </Card>
        {/*
         * Gross for the same reason it is on the other two views: `cost` is the
         * bare notional and carries no fees (derive.ts). It sits beside the
         * summary's "Realized (gross)" card, which counts only a COMPLETED exit
         * -- this one counts what is still open.
         */}
        <Card label="Unrealized (gross)" hint={unrealizedHint(figures.heldQuantity, currentPrice)}>
          <UnrealizedValue pnl={pnl} capitalAsset={capitalAsset} />
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
              /* One entry by design; extra rows are parts of that one fill. */
              label={i === 0 ? "Entry" : `Part ${i + 1}`}
              price={entry.price}
              quantity={entry.quantity}
              cost={entry.cost}
              at={entry.at}
            />
          ))}
        </div>
      ) : (
        <div className="rounded-lg border border-dashed border-zinc-800 px-4 py-6 text-center text-sm text-zinc-500">
          No entry filled yet. The single entry order goes in when the bot starts, and the trail
          only begins once it fills.
        </div>
      )}

      {/*
       * What this bot was created with. Short by design -- 22.2 decision 1 gives
       * the strategy exactly one parameter, and the two rows beside it are shown
       * because an operator reading a halted bot needs them and would otherwise
       * have to infer them.
       */}
      <ConfigSection>
        <ConfigItem label="Trail %" hint="below the high-water mark">
          {percent(params.trailPct)}
        </ConfigItem>
        {/*
         * The SAME percentage, and saying so is the point. Before any new high is
         * made the trail sits `trailPct` below the ENTRY, so this strategy's one
         * parameter is also its initial stop distance (22.2 decision 1). An
         * operator who read only the row above could reasonably assume the
         * position was unprotected until a high was set.
         */}
        <ConfigItem label="Initial stop" hint="below entry, until a high is set">
          {percent(params.trailPct)}
        </ConfigItem>
        {/*
         * There is no order-size parameter to show and its absence is
         * deliberate, not missing data (22.2, consequence of decisions 1 and 4).
         */}
        <ConfigItem label="Entry size" hint="the whole allocation; no size parameter">
          {formatMoney(allocatedCapital)}
          <Unit>{capitalAsset}</Unit>
        </ConfigItem>
        {/*
         * 22.1: gains are locked in progressively, so there is no fixed target to
         * guess in advance. Stated rather than omitted -- a blank where the other
         * two strategies show a take-profit reads as an unconfigured bot.
         */}
        <ConfigItem label="Take-profit" hint="the trail is the exit; no fixed target">
          None
        </ConfigItem>
        {/*
         * Spec 22.10, and shown only once there is something to show. This is
         * the number that explains an `entry_unfilled` halt: the entry order was
         * placed, repriced and replaced this many times without filling, and the
         * cap stopped it. An operator reading the halt reason above has no other
         * way to see how hard the bot tried.
         *
         * ⚠ NO "of N" HERE. The cap is a Worker constant and a copy of it in
         * this bundle could disagree with the one the bot actually stopped at,
         * which is worse than not stating it -- see the field's note in types.ts.
         */}
        {entryAttempts !== null && entryAttempts > 0 && (
          <ConfigItem label="Entry attempts" hint="placements of the single entry order">
            {entryAttempts}
          </ConfigItem>
        )}
      </ConfigSection>
    </section>
  );
}
