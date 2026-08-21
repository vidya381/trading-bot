/**
 * The account-level money rollup (step 25), rendered under the status strip's
 * count tiles on the main bot-list page.
 *
 * Every figure comes from `accountTotals.ts`, which folds the SAME `Bot[]` the
 * table below already renders -- one poll, one source, so a tile here can never
 * disagree with a row down there. This file only lays out and colours what that
 * module produced; it performs no arithmetic and constructs no float.
 *
 * GROSS AND NET SIT SIDE BY SIDE, and neither replaces the other. That is the
 * convention the per-bot view has kept since step 10.7 ("Realized (gross)"),
 * and it exists because the two answer different questions: gross is what the
 * strategies earned, net is what the account actually kept. Every label here
 * says which one it is -- there is no bare "P&L" tile, deliberately.
 *
 * ONE GROUP PER CAPITAL ASSET. With a single asset (today's case: every live
 * bot is on `gemini-main`) this renders as one unlabelled strip and reads as a
 * plain account summary. With more than one it grows a heading per asset,
 * because USD and USDT totals are not addable and a blended figure would be in
 * no currency at all.
 */

import type { ReactNode } from "react";
import type { AssetTotals } from "../accountTotals";
import { gapSummary } from "../accountTotals";
import type { AvailableCapital, AvailableCard } from "../availableCapital";
import { assetsWithoutTotals, cardsForAsset } from "../availableCapital";
import { formatMoney, signOf } from "../format";
import { Unit } from "./Unit";

const SIGN_CLASS: Record<ReturnType<typeof signOf>, string> = {
  positive: "text-emerald-300",
  negative: "text-red-300",
  zero: "text-zinc-400",
};

/** A leading "+" on a gain, so direction reads without relying on colour alone. */
function signed(value: string): string {
  return signOf(value) === "positive" ? `+${value}` : value;
}

function Tile({
  label,
  hint,
  emphasis,
  children,
}: {
  label: string;
  hint?: string;
  emphasis?: boolean;
  children: ReactNode;
}) {
  return (
    <div
      className={[
        "flex flex-col rounded-lg border px-4 py-3",
        emphasis
          ? "border-zinc-600 bg-zinc-900"
          : "border-zinc-800 bg-zinc-900/60",
      ].join(" ")}
    >
      <span className="text-xs font-medium uppercase tracking-wide text-zinc-500">{label}</span>
      <span className="tabular mt-1 text-lg font-semibold text-zinc-100">{children}</span>
      {hint !== undefined && <span className="mt-0.5 text-xs text-zinc-500">{hint}</span>}
    </div>
  );
}

/** A money figure with its capital asset attached. Never a bare number. */
function Money({ value, asset, tone }: { value: string; asset: string; tone?: "sign" }) {
  return (
    <span className={tone === "sign" ? SIGN_CLASS[signOf(value)] : undefined}>
      {tone === "sign" ? signed(formatMoney(value)) : formatMoney(value)}
      <Unit>{asset}</Unit>
    </span>
  );
}

/** An absent figure, with the reason it is absent carried as the tile's hint. */
function Unknown() {
  return <span className="text-zinc-600">—</span>;
}

/**
 * One AVAILABLE tile: `capital_ledger`'s `total_balance - total_allocated` for a
 * single (account, asset).
 *
 * The SAME `Tile` and the SAME label/value/hint arrangement as every figure
 * beside it -- this introduces no visual pattern of its own. Everything it shows
 * was decided in `availableCapital.ts`, including its label and both hint
 * sentences, so this function chooses nothing except the colour.
 *
 * NEGATIVE RENDERS AMBER, NOT RED, and is never clamped. Exactly the IDLE tile's
 * treatment and for its stated reason: red reads as "a loss" everywhere else on
 * this dashboard and this is not one. An over-allocated account wants attention,
 * not alarm -- and hiding it would suppress the single figure that reveals real
 * drift between the ledger and the bots.
 */
function AvailableTile({ card }: { card: AvailableCard }) {
  return (
    <Tile label={card.label} hint={card.hint}>
      <span className={card.overAllocated ? "text-amber-300" : undefined}>
        {formatMoney(card.value)}
        <Unit>{card.asset}</Unit>
      </span>
    </Tile>
  );
}

function AssetStrip({
  totals,
  showHeading,
  available,
}: {
  totals: AssetTotals;
  showHeading: boolean;
  /** This asset's AVAILABLE tiles, already ordered. Empty when the ledger has
   *  no row for it -- which is not an error, and renders as no tile. */
  available: readonly AvailableCard[];
}) {
  const gaps = gapSummary(totals.gaps);
  const asset = totals.capitalAsset;

  /*
   * Idle capital is allowed to be negative and is coloured amber rather than
   * red when it is. Red reads as "a loss" everywhere else on this dashboard,
   * and this is not one -- it means the fleet holds more cost basis than it has
   * committed capital, which a `stopped` bot still carrying inventory produces
   * legitimately (its basis counts, its released allocation does not). It wants
   * attention, not alarm.
   */
  const idleNegative = signOf(totals.idle) === "negative";

  return (
    <div className="space-y-2">
      {showHeading && (
        <div className="flex items-baseline gap-2">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-300">{asset}</h2>
          <span className="text-xs text-zinc-500">
            {totals.botCount} bot{totals.botCount === 1 ? "" : "s"}
          </span>
        </div>
      )}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <Tile label="Allocated" hint="committed; excludes stopped">
          <Money value={totals.allocated} asset={asset} />
        </Tile>
        {/*
         * AVAILABLE sits immediately beside ALLOCATED, because the two are the
         * question and its complement: what is committed, and what is left. One
         * tile per funding account, never summed -- see `availableCapital.ts`.
         *
         * ⚠ THE TWO TILES DO NOT COME FROM THE SAME PLACE, and are not expected
         * to reconcile digit-for-digit. ALLOCATED is this page's own sum over
         * the polled bot rows; AVAILABLE's subtrahend is `capital_ledger`'s
         * `total_allocated`. Those two agreeing is reconciliation's
         * `ledger_allocation_drift` check, which exists precisely because they
         * can diverge. Nothing here reconciles them, deliberately.
         */}
        {available.map((card) => (
          <AvailableTile key={`${card.accountLabel}:${card.asset}`} card={card} />
        ))}
        <Tile label="In position" hint="cost basis, gross of fees">
          <Money value={totals.inPosition} asset={asset} />
        </Tile>
        <Tile label="Idle" hint={idleNegative ? "basis exceeds committed capital" : undefined}>
          <span className={idleNegative ? "text-amber-300" : undefined}>
            {formatMoney(totals.idle)}
            <Unit>{asset}</Unit>
          </span>
        </Tile>
        <Tile label="Realized (gross)" hint="closed cycles, before fees">
          <Money value={totals.realizedGross} asset={asset} tone="sign" />
        </Tile>
        <Tile
          label="Fees paid"
          hint={totals.gaps.unpricedFills > 0 ? "a floor; some fees unpriced" : undefined}
        >
          <Money value={totals.feesReported} asset={asset} />
        </Tile>
        <Tile
          label="Unrealized (gross)"
          hint={
            totals.unrealized === null
              ? "a held position has no price yet"
              : "mark-to-market, before fees"
          }
        >
          {totals.unrealized === null ? (
            <Unknown />
          ) : (
            <Money value={totals.unrealized} asset={asset} tone="sign" />
          )}
        </Tile>
        {/*
         * The one figure on this page that is net of fees, and the only one that
         * can refuse to exist. `accountTotals` withholds it whenever any input
         * is incomplete rather than showing it with a caveat -- the same choice
         * `realizedPnl` in src/shared/fees.ts has always made, for the reason
         * written there: an overstated profit is the one error a trading system
         * must not make quietly. The hint says exactly what is missing.
         */}
        <Tile
          label="Net"
          emphasis
          hint={totals.net === null ? `withheld: ${gaps}` : "realized − fees + unrealized"}
        >
          {totals.net === null ? <Unknown /> : <Money value={totals.net} asset={asset} tone="sign" />}
        </Tile>
        <Tile label="Open positions">{totals.openPositions}</Tile>
        {/*
         * "DCA" is in the label, not the hint. `cycleCount` is incremented only
         * by DCA's `#completeCycle`, so a grid bot contributes 0 for its whole
         * life -- and under a bare "Cycles" heading that reads as grid bots
         * having achieved nothing, rather than as a counter that does not apply
         * to them.
         */}
        <Tile label="DCA cycles">{totals.cyclesCompleted}</Tile>
      </div>
      {gaps !== null && totals.net !== null && (
        <p className="text-xs text-amber-300/80">Some totals are a floor: {gaps}.</p>
      )}
    </div>
  );
}

/**
 * A strip for an asset that has ledger headroom but NO bots.
 *
 * Only the AVAILABLE tiles, and deliberately not a row of zeroes for the eight
 * bot-derived figures: there is no fleet here to have allocated, held or earned
 * anything, and "0.00 realized" would be an assertion about trading that never
 * happened. The heading is always shown, because a bare tile with no asset
 * beside it is the unlabelled figure this dashboard's money rules exist to
 * prevent.
 */
function CapitalOnlyStrip({ asset, available }: { asset: string; available: readonly AvailableCard[] }) {
  return (
    <div className="space-y-2">
      <div className="flex items-baseline gap-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-300">{asset}</h2>
        <span className="text-xs text-zinc-500">no bots</span>
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {available.map((card) => (
          <AvailableTile key={`${card.accountLabel}:${card.asset}`} card={card} />
        ))}
      </div>
    </div>
  );
}

export function AccountSummary({
  totals,
  capital,
}: {
  totals: readonly AssetTotals[];
  capital: AvailableCapital;
}) {
  const capitalOnly = assetsWithoutTotals(
    capital,
    totals.map((entry) => entry.capitalAsset),
  );

  /*
   * Nothing to say at all: no bot groups AND no ledger headroom. Render nothing
   * rather than a strip of confident zeroes -- the bot list below already says
   * the fleet is empty, and it says it better.
   *
   * The condition now includes the ledger, because an account that has been
   * funded but has no bots yet is NOT nothing: "how much can I start a bot with"
   * is the only interesting figure on that page, and the previous bots-only test
   * would have hidden exactly it. Unreadable accounts also count as something to
   * say -- their note is the admission that a figure is missing.
   */
  if (totals.length === 0 && capitalOnly.length === 0 && capital.unreadableAccounts.length === 0) {
    return null;
  }

  const multiAsset = totals.length + capitalOnly.length > 1;
  return (
    <section className="space-y-4">
      {multiAsset && (
        <p className="text-xs text-zinc-500">
          Totals are grouped per capital asset and never summed across them. Available capital is
          per account and asset, and is never summed across accounts either.
        </p>
      )}
      {totals.map((entry) => (
        <AssetStrip
          key={entry.capitalAsset}
          totals={entry}
          showHeading={multiAsset}
          available={cardsForAsset(capital, entry.capitalAsset)}
        />
      ))}
      {capitalOnly.map((asset) => (
        <CapitalOnlyStrip key={asset} asset={asset} available={cardsForAsset(capital, asset)} />
      ))}
      {/*
       * An unreadable ledger is SAID, not silently omitted. A missing AVAILABLE
       * tile would otherwise be indistinguishable from an account that genuinely
       * has no ledger row, and those are opposite facts -- one is "nothing is
       * funded here", the other is "this read did not happen" (section 5.6).
       */}
      {capital.unreadableAccounts.length > 0 && (
        <p className="text-xs text-amber-300/80">
          Available capital is unknown for {capital.unreadableAccounts.join(", ")}: the ledger could
          not be read.
        </p>
      )}
      {capital.malformedRows > 0 && (
        <p className="text-xs text-amber-300/80">
          {capital.malformedRows} ledger row{capital.malformedRows === 1 ? "" : "s"} could not be
          read and {capital.malformedRows === 1 ? "is" : "are"} not shown.
        </p>
      )}
    </section>
  );
}
