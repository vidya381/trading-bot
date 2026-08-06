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
import { compareDecimal, formatMoney, formatQuantity } from "../format";
import { unrealizedPnl } from "../derive";
import { SideBadge } from "./SideBadge";
import { ConfigItem, ConfigSection, enabled, percent } from "./ConfigSection";
import { Unit } from "./Unit";
import { UnrealizedValue, unrealizedHint } from "./UnrealizedValue";

interface Rung {
  readonly price: string;
  readonly slot: GridLadder["slots"][number];
}

function LadderRow({ rung, zone }: { rung: Rung; zone: "sell" | "buy" | null }) {
  const zoneTint =
    zone === "sell" ? "bg-amber-500/[0.04]" : zone === "buy" ? "bg-emerald-500/[0.04]" : "";
  return (
    <div className={`flex items-center justify-between gap-4 px-4 py-2 ${zoneTint}`}>
      <span className="tabular text-sm text-zinc-200">{formatMoney(rung.price)}</span>
      {rung.slot === null ? (
        <span className="text-xs text-zinc-600">no order</span>
      ) : (
        <span className="flex items-center gap-2">
          <SideBadge side={rung.slot.side} />
          <span className="tabular text-xs text-zinc-500">
            {formatQuantity(rung.slot.quantity)}
          </span>
        </span>
      )}
    </div>
  );
}

function CurrentPriceDivider({ price }: { price: string }) {
  return (
    <div className="flex items-center gap-3 bg-sky-500/10 px-4 py-1.5">
      <span className="h-px flex-1 bg-sky-500/40" aria-hidden />
      <span className="tabular text-xs font-medium text-sky-300">current {formatMoney(price)}</span>
      <span className="h-px flex-1 bg-sky-500/40" aria-hidden />
    </div>
  );
}

export function GridLadderView({
  ladder,
  currentPrice,
  params,
  capitalAsset,
  baseAsset,
}: {
  ladder: GridLadder;
  currentPrice: string | null;
  params: GridParams;
  capitalAsset: string;
  /** The asset the ladder's held quantity is denominated in, for labelling. */
  baseAsset: string;
}) {
  /*
   * Mark-to-market on the base the ladder is holding. `heldCost` is a true cost
   * basis for exactly `heldQuantity`: a buy fill adds the executed cost and a
   * sell fill subtracts the `releasedCost` of what it sold (grid.ts), so the two
   * stay paired and no closed round-trip leaks into this figure. That closed
   * profit is what "Realized (gross)" beside it already reports.
   *
   * NOTE there is no grid analogue of DCA's take-profit PRICE, and none is shown:
   * `takeProfitAmount` is an accumulated realized-profit AMOUNT, not a price
   * level (spec 6.1/6.2), so there is no single price at which a grid "sells".
   * It appears in the configuration block below, as the amount it is.
   */
  const pnl = unrealizedPnl(ladder.heldQuantity, ladder.heldCost, currentPrice);

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
          {/* An en dash between two prices, spaced -- "10000.00–12000.00" reads
              as one number, which is the same defect as an unspaced unit. */}
          <span className="tabular">
            {formatMoney(params.lowerBound)} – {formatMoney(params.upperBound)} {capitalAsset}
          </span>
          <span className="text-zinc-600">·</span>
          <span>{params.gridLines} lines</span>
          <span className="text-zinc-600">·</span>
          <span>{params.spacing}</span>
          <span className="text-zinc-600">·</span>
          <span className="tabular">
            size {formatMoney(params.orderSize)} {capitalAsset}
          </span>
        </div>
      </div>

      {!ladder.placed && (
        <div className="rounded-lg border border-dashed border-zinc-800 px-4 py-3 text-sm text-zinc-500">
          The initial ladder hasn’t been placed yet, because the bot hasn’t started.
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

      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div>
          <dt className="text-xs uppercase tracking-wide text-zinc-500">Held quantity</dt>
          <dd className="tabular text-sm text-zinc-200">
            {formatQuantity(ladder.heldQuantity)}
            <Unit>{baseAsset}</Unit>
          </dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-wide text-zinc-500">Held cost</dt>
          <dd className="tabular text-sm text-zinc-200">
            {formatMoney(ladder.heldCost)}
            <Unit>{capitalAsset}</Unit>
          </dd>
        </div>
        {/* Closed round-trips only -- the open position is the card beside it. */}
        <div>
          <dt className="text-xs uppercase tracking-wide text-zinc-500">Realized (gross)</dt>
          <dd className="tabular text-sm text-zinc-200">
            {formatMoney(ladder.realizedGross)}
            <Unit>{capitalAsset}</Unit>
          </dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-wide text-zinc-500">Unrealized (gross)</dt>
          <dd className="tabular text-sm text-zinc-200">
            <UnrealizedValue pnl={pnl} capitalAsset={capitalAsset} />
          </dd>
          {unrealizedHint(ladder.heldQuantity, currentPrice) && (
            <div className="text-xs text-zinc-600">
              {unrealizedHint(ladder.heldQuantity, currentPrice)}
            </div>
          )}
        </div>
      </dl>

      {/*
       * What this bot was created with (section 6.2). Read-only -- see
       * ConfigSection's note. The bounds/lines/spacing/size also appear in the
       * header line above; that summary is left exactly as it was, and this block
       * is the complete record beside it.
       */}
      <ConfigSection>
        <ConfigItem label="Lower bound">
          {formatMoney(params.lowerBound)}
          <Unit>{capitalAsset}</Unit>
        </ConfigItem>
        <ConfigItem label="Upper bound">
          {formatMoney(params.upperBound)}
          <Unit>{capitalAsset}</Unit>
        </ConfigItem>
        <ConfigItem label="Grid lines" hint="including both bounds">
          {params.gridLines}
        </ConfigItem>
        <ConfigItem label="Spacing">{params.spacing}</ConfigItem>
        {/* Quote spent per buy line, and recovered plus profit per sell line. */}
        <ConfigItem label="Order size per line">
          {formatMoney(params.orderSize)}
          <Unit>{capitalAsset}</Unit>
        </ConfigItem>
        <ConfigItem label="Stop-loss">{percent(params.stopLossPct)}</ConfigItem>
        {/*
         * An accumulated realized-profit AMOUNT, not a percentage, and OPTIONAL
         * for grid. Null is stated as what it means -- the bot then relies on its
         * stop-loss and breakout exit -- rather than shown as a bare "—".
         */}
        <ConfigItem
          label="Take-profit amount"
          hint={params.takeProfitAmount === null ? "not set" : "accumulated realized"}
        >
          {params.takeProfitAmount === null ? (
            <span className="text-zinc-600">Not set</span>
          ) : (
            <>
              {formatMoney(params.takeProfitAmount)}
              <Unit>{capitalAsset}</Unit>
            </>
          )}
        </ConfigItem>
        <ConfigItem label="Breakout take-profit" hint="cash out on an upside breakout">
          {enabled(params.breakoutTakeProfit)}
        </ConfigItem>
        <ConfigItem
          label="Breakout threshold"
          hint={params.breakoutThresholdPct === null ? "not set" : "above the upper bound"}
        >
          {params.breakoutThresholdPct === null ? (
            <span className="text-zinc-600">Not set</span>
          ) : (
            percent(params.breakoutThresholdPct)
          )}
        </ConfigItem>
      </ConfigSection>
    </section>
  );
}
