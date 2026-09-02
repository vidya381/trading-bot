/**
 * The bot list (this session's brief item 6): every bot across every account --
 * status, strategy, pair, P&L, position, allocated capital -- from GET /api/bots.
 *
 * ONE dataset, TWO layouts (brief item 3): a real <table> at `md` and up, stacked
 * cards below it, switched purely by Tailwind breakpoints. Both render from the
 * same `Bot[]`, so they cannot drift.
 *
 * Every row/card is a link to `/bots/:id`. That detail view does not exist yet
 * (it is next session); the navigation is wired now so the next session only has
 * to build the destination.
 *
 * P&L is labelled "Realized (gross)" on purpose: the backend's `realizedGross`
 * is gross of fees and it deliberately does not call the number "pnl" (see
 * serialize.ts). Showing it under an honest label keeps that promise.
 *
 * ARCHIVED BOTS (step 26) are filtered OUT BY THE CALLER, not here: this
 * component renders whatever list it is handed. `hiddenCount` is how many the
 * caller withheld, and it exists so the empty state can say "hidden" rather than
 * "none" -- an account whose every bot is archived must not be told it has no
 * bots. Rows that ARE archived carry an `archived` tag, since the toggle
 * otherwise just makes the table longer with nothing marking the new rows.
 */

import { Link } from "react-router-dom";
import type { Bot } from "../api/types";
import { StatusBadge } from "./StatusBadge";
import { Unit } from "./Unit";
import { baseAssetOf, formatMoney, formatQuantity, signOf } from "../format";
import { entryPriceOf, strategyLabel } from "../strategyView";

const SIGN_CLASS: Record<ReturnType<typeof signOf>, string> = {
  positive: "text-emerald-300",
  negative: "text-red-300",
  zero: "text-zinc-400",
};

/**
 * Realized-gross figure with sign colouring, or "—" for an orphaned bot.
 *
 * Carries its capital asset: this column stacks bots from different accounts and
 * pairs, so an unlabelled number here is a column of amounts in assets that need
 * not be the same one.
 */
function Pnl({ bot }: { bot: Bot }) {
  if (bot.position === null) return <span className="text-zinc-600">—</span>;
  const value = bot.position.realizedGross;
  return (
    <span className={`tabular ${SIGN_CLASS[signOf(value)]}`}>
      {formatMoney(value)}
      <Unit>{bot.capitalAsset}</Unit>
    </span>
  );
}

/**
 * Held quantity in the base asset, with the entry price as secondary context.
 *
 * ⚠ THE STRATEGY TEST WAS INLINE HERE (`position.strategy === "dca"`), duplicating
 * `BotSummary`'s -- so this column silently showed no entry price for a
 * trailing-stop bot, whose `averageEntryPrice` is a real single entry (22.2
 * decision 4). `entryPriceOf` is now the one exhaustive answer for both call
 * sites; a new `Position` variant fails to compile there rather than quietly
 * blanking a column here.
 */
function PositionCell({ bot }: { bot: Bot }) {
  const position = bot.position;
  if (position === null) return <span className="text-zinc-600">—</span>;
  const held = formatQuantity(position.heldQuantity);
  const asset = baseAssetOf(bot.pair, bot.capitalAsset);
  const entry = entryPriceOf(position);
  if (entry !== null) {
    return (
      <span className="tabular">
        {held}
        <Unit>{asset}</Unit>
        {/* The "@" is a real separator between the two numbers, spaced on both
            sides -- a quantity and a price abutting would read as one figure. */}
        <Unit>@ {formatMoney(entry)} {bot.capitalAsset}</Unit>
      </span>
    );
  }
  return (
    <span className="tabular">
      {held}
      <Unit>{asset}</Unit>
    </span>
  );
}

/**
 * Marks a row that is only on screen because "Show archived" is on (step 26).
 *
 * Without it the toggle simply grows the table and nothing says which rows are
 * the archived ones -- and "archived" is not visible in any other column, since
 * it is deliberately not a status.
 */
function ArchivedTag({ bot }: { bot: Bot }) {
  if (!bot.archived) return null;
  return (
    <span
      title="Archived: hidden from the default view. Nothing was deleted, and this bot still counts toward the account totals."
      className="ml-2 inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-zinc-400 ring-1 ring-inset ring-zinc-600/50"
    >
      archived
    </span>
  );
}

function OrphanTag({ bot }: { bot: Bot }) {
  if (!bot.orphaned) return null;
  return (
    <span
      title="This bot has a database row but its Durable Object holds no state."
      className="ml-2 inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-300 ring-1 ring-inset ring-amber-500/30"
    >
      orphaned
    </span>
  );
}

// ---------------------------------------------------------------------------
// Desktop: real table (md and up)
// ---------------------------------------------------------------------------

function BotTable({ bots }: { bots: Bot[] }) {
  return (
    <div className="hidden overflow-x-auto rounded-lg border border-zinc-800 md:block">
      <table className="w-full text-left text-sm">
        <thead className="border-b border-zinc-800 bg-zinc-900/60 text-xs uppercase tracking-wide text-zinc-500">
          <tr>
            <th className="px-4 py-3 font-medium">Bot / Account</th>
            <th className="px-4 py-3 font-medium">Status</th>
            <th className="px-4 py-3 font-medium">Strategy</th>
            <th className="px-4 py-3 font-medium">Pair</th>
            <th className="px-4 py-3 text-right font-medium">Position</th>
            <th className="px-4 py-3 text-right font-medium">Realized (gross)</th>
            <th className="px-4 py-3 text-right font-medium">Allocated</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-zinc-800">
          {bots.map((bot) => (
            <tr key={bot.id} className="group transition-colors hover:bg-zinc-800/40">
              <td className="px-4 py-3">
                <Link
                  to={`/bots/${encodeURIComponent(bot.id)}`}
                  className="font-medium text-zinc-100 underline-offset-2 hover:text-white hover:underline focus:outline-none focus-visible:underline"
                >
                  {bot.id}
                </Link>
                <ArchivedTag bot={bot} />
                <OrphanTag bot={bot} />
                <div className="text-xs text-zinc-500">{bot.accountLabel}</div>
              </td>
              <td className="px-4 py-3">
                <StatusBadge status={bot.status} />
              </td>
              {/* `strategyLabel`, not the raw wire value -- `uppercase` would
                  otherwise render "trailing_stop" with its underscore. */}
              <td className="px-4 py-3 uppercase text-zinc-300">{strategyLabel(bot.strategy)}</td>
              <td className="px-4 py-3 text-zinc-300">{bot.pair}</td>
              <td className="px-4 py-3 text-right">
                <PositionCell bot={bot} />
              </td>
              <td className="px-4 py-3 text-right">
                <Pnl bot={bot} />
              </td>
              <td className="tabular px-4 py-3 text-right text-zinc-300">
                {formatMoney(bot.allocatedCapital)}
                <Unit>{bot.capitalAsset}</Unit>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Mobile: cards (below md)
// ---------------------------------------------------------------------------

function BotCard({ bot }: { bot: Bot }) {
  return (
    <Link
      to={`/bots/${encodeURIComponent(bot.id)}`}
      className="block rounded-lg border border-zinc-800 bg-zinc-900/60 p-4 transition-colors hover:bg-zinc-800/50 focus:outline-none focus-visible:ring-2 focus-visible:ring-zinc-500"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate font-medium text-zinc-100">
            {bot.id}
            <ArchivedTag bot={bot} />
            <OrphanTag bot={bot} />
          </div>
          <div className="text-xs text-zinc-500">{bot.accountLabel}</div>
        </div>
        <StatusBadge status={bot.status} />
      </div>
      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
        <div>
          <dt className="text-xs uppercase tracking-wide text-zinc-500">Strategy</dt>
          <dd className="uppercase text-zinc-300">{strategyLabel(bot.strategy)}</dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-wide text-zinc-500">Pair</dt>
          <dd className="text-zinc-300">{bot.pair}</dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-wide text-zinc-500">Position</dt>
          <dd>
            <PositionCell bot={bot} />
          </dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-wide text-zinc-500">Realized (gross)</dt>
          <dd>
            <Pnl bot={bot} />
          </dd>
        </div>
        <div className="col-span-2">
          <dt className="text-xs uppercase tracking-wide text-zinc-500">Allocated</dt>
          <dd className="tabular text-zinc-300">
            {formatMoney(bot.allocatedCapital)}
            <Unit>{bot.capitalAsset}</Unit>
          </dd>
        </div>
      </dl>
    </Link>
  );
}

export function BotList({ bots, hiddenCount = 0 }: { bots: Bot[]; hiddenCount?: number }) {
  if (bots.length === 0) {
    // The empty state has to know about the filter, or it lies. "No bots yet" on
    // an account whose every bot is archived is worse than unhelpful -- it says
    // the fleet is empty when it is merely hidden.
    return (
      <div className="rounded-lg border border-dashed border-zinc-800 px-4 py-10 text-center text-sm text-zinc-500">
        {hiddenCount > 0 ? (
          <>
            Nothing to show. {hiddenCount} archived {hiddenCount === 1 ? "bot is" : "bots are"} hidden
            — turn on <span className="font-medium text-zinc-400">Show archived</span> to see{" "}
            {hiddenCount === 1 ? "it" : "them"}.
          </>
        ) : (
          <>No bots yet. Any bot you create will show up here, across every account.</>
        )}
      </div>
    );
  }
  return (
    <>
      <BotTable bots={bots} />
      <div className="grid gap-3 md:hidden">
        {bots.map((bot) => (
          <BotCard key={bot.id} bot={bot} />
        ))}
      </div>
    </>
  );
}
