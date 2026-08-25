/**
 * The bot detail summary (this session's brief item 2): identity + a small row
 * of stat cards above the strategy content.
 *
 * Everything here is strategy-agnostic -- it reads the shared summary fields
 * (`botSummary` in serialize.ts) plus `state.lastPrice`, both present for grid
 * and DCA alike. The strategy-specific state (ladder / entries) is rendered
 * separately by `StrategyState`; this header is shared by both, which is exactly
 * the "share a component shape where the data genuinely matches" the brief asks
 * for.
 *
 * Money stays a decimal string end to end (backend contract): the `format.ts`
 * helpers round only the rendered TEXT and `signOf` reads the string's sign --
 * no float is ever constructed and nothing here is written back.
 *
 * Every figure carries its unit (capital asset for money, base asset for a
 * quantity) through `Unit`, which supplies real whitespace rather than a margin.
 */

import type { ReactNode } from "react";
import type { BotDetail } from "../api/types";
import { StatusBadge } from "./StatusBadge";
import { Unit } from "./Unit";
import { baseAssetOf, formatMoney, formatQuantity, formatTime, signOf } from "../format";

const SIGN_CLASS: Record<ReturnType<typeof signOf>, string> = {
  positive: "text-emerald-300",
  negative: "text-red-300",
  zero: "text-zinc-400",
};

function Stat({
  label,
  children,
  hint,
}: {
  label: string;
  children: ReactNode;
  hint?: string;
}) {
  return (
    <div className="flex flex-col rounded-lg border border-zinc-800 bg-zinc-900/60 px-4 py-3">
      <span className="text-xs font-medium uppercase tracking-wide text-zinc-500">{label}</span>
      <span className="tabular mt-1 text-lg font-semibold text-zinc-100">{children}</span>
      {hint && <span className="mt-0.5 text-xs text-zinc-500">{hint}</span>}
    </div>
  );
}

/**
 * Held position, with DCA's average entry as secondary context. The hint spells
 * out the average entry's currency too: it is a price, and a bare number next to
 * a quantity in the asset above it is exactly the ambiguity this view had.
 */
function positionValue(bot: BotDetail): { value: string | null; hint?: string } {
  const position = bot.position;
  if (position === null) return { value: null, hint: "no object state (orphaned)" };
  const held = formatQuantity(position.heldQuantity);
  if (position.strategy === "dca" && position.averageEntryPrice !== "0.00000000") {
    return {
      value: held,
      hint: `avg entry ${formatMoney(position.averageEntryPrice)} ${bot.capitalAsset}`,
    };
  }
  return { value: held };
}

/**
 * What to say under the frozen price.
 *
 * A halted bot's `lastPrice` stopped advancing when it unsubscribed from its
 * feed, and saying so -- with the time -- is the difference between a number
 * that looks broken and one that is explained. `lastPriceAt` is the tick it
 * froze on, which is exactly the moment being described.
 */
function currentPriceHint(bot: BotDetail): string | undefined {
  if (bot.state?.lastPrice == null) return "no price yet";
  if (bot.status !== "halted") return undefined;
  const at = bot.state.lastPriceAt;
  return at === null ? "frozen at halt" : `frozen at halt · ${formatTime(at)}`;
}

export function BotSummary({ bot }: { bot: BotDetail }) {
  const realized = bot.position?.realizedGross ?? null;
  const position = positionValue(bot);
  const currentPrice = bot.state?.lastPrice ?? null;
  const heldAsset = baseAssetOf(bot.pair, bot.capitalAsset);

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="tabular truncate text-2xl font-semibold text-zinc-100">{bot.id}</h1>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-zinc-400">
            <span>{bot.accountLabel}</span>
            <span className="text-zinc-600">·</span>
            <span className="text-zinc-300">{bot.pair}</span>
            <span className="text-zinc-600">·</span>
            <span className="uppercase">{bot.strategy}</span>
            <span className="text-zinc-600">·</span>
            <span>{bot.exchange}</span>
          </div>
        </div>
        <StatusBadge status={bot.status} />
      </div>

      {bot.status === "halted" && bot.haltReason && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/5 px-4 py-2 text-sm text-red-300">
          Halted: <span className="font-medium">{bot.haltReason}</span>
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
        <Stat label="Realized (gross)">
          {realized === null ? (
            <span className="text-zinc-600">—</span>
          ) : (
            <span className={SIGN_CLASS[signOf(realized)]}>
              {formatMoney(realized)}
              <Unit>{bot.capitalAsset}</Unit>
            </span>
          )}
        </Stat>
        <Stat label="Position" hint={position.hint}>
          {position.value === null ? (
            <span className="text-zinc-600">—</span>
          ) : (
            <>
              {position.value}
              <Unit>{heldAsset}</Unit>
            </>
          )}
        </Stat>
        {/*
         * The capital asset moves from the hint line onto the value itself, here
         * and on every money card below. A unit sitting on its own line under a
         * number is separated, but it is not obviously PART of that number --
         * and these cards sit beside quantity cards denominated in a different
         * asset entirely.
         */}
        <Stat label="Allocated">
          {formatMoney(bot.allocatedCapital)}
          <Unit>{bot.capitalAsset}</Unit>
        </Stat>
        {/*
          * TWO PRICES, NEVER MERGED, and the labels do the work of keeping them
          * apart.
          *
          * "Current price" is `state.lastPrice` -- the price this bot last
          * TRADED against, and the number the PnL figures beside it are
          * computed from. On a halted bot it is correctly FROZEN at the moment
          * it stopped, which is deliberate design, not staleness.
          *
          * "Market price" is a separately fetched spot price, shown only for a
          * halted bot, so the operator can see where the market actually is
          * before deciding whether to resume. It feeds no calculation anywhere.
          *
          * The frozen one keeps its own hint saying WHEN it froze, because a
          * bare number with no "as of" beside a live one is precisely what made
          * a correctly-frozen price look broken.
          */}
        <Stat label="Current price" hint={currentPriceHint(bot)}>
          {currentPrice === null ? (
            <span className="text-zinc-600">—</span>
          ) : (
            <>
              {formatMoney(currentPrice)}
              <Unit>{bot.capitalAsset}</Unit>
            </>
          )}
        </Stat>
        {bot.marketPrice !== null && (
          <Stat label="Market price" hint={`as of ${formatTime(bot.marketPrice.at)}`}>
            {formatMoney(bot.marketPrice.price)}
            <Unit>{bot.capitalAsset}</Unit>
          </Stat>
        )}
      </div>
    </section>
  );
}
