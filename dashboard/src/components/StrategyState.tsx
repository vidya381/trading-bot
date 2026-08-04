/**
 * Strategy-specific state dispatcher (this session's brief item 3).
 *
 * The one place that decides, from the AUTHORITATIVE discriminator
 * `config.strategy` (not the presence of a state field -- see BotRuntimeState's
 * note), which strategy-specific view to render. Grid and DCA state are
 * genuinely different data, so each has its own component; this switch is how
 * the view "correctly renders whichever strategy the bot actually is" without
 * assuming one or duplicating logic. The shared summary and histories live
 * outside this dispatcher, in the detail page.
 */

import type { BotDetail } from "../api/types";
import { baseAssetOf } from "../format";
import { GridLadderView } from "./GridLadderView";
import { DcaPositionView } from "./DcaPositionView";

export function StrategyState({ bot }: { bot: BotDetail }) {
  const { config, state } = bot;
  // Quantities below are held in the BASE asset while every money figure beside
  // them is in the capital (quote) asset. Both views label their figures, so
  // both need this; derived once here rather than twice from the same pair.
  const baseAsset = baseAssetOf(bot.pair, bot.capitalAsset);

  // Orphaned: a bot_instances row whose Durable Object holds no state.
  if (config === null || state === null) {
    return (
      <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-4 py-4 text-sm text-amber-200">
        This bot has a database row but its Durable Object holds no state, so there is no live
        strategy state to show.
      </div>
    );
  }

  if (config.strategy === "grid") {
    if (state.ladder === undefined) {
      return (
        <div className="rounded-lg border border-dashed border-zinc-800 px-4 py-6 text-sm text-zinc-500">
          This grid bot has no ladder state yet.
        </div>
      );
    }
    return (
      <GridLadderView
        ladder={state.ladder}
        currentPrice={state.lastPrice}
        params={config.params}
        capitalAsset={bot.capitalAsset}
        baseAsset={baseAsset}
      />
    );
  }

  // `state.lastPrice` is the SAME value the summary's "Current price" card reads
  // (BotSummary), so the derived unrealized figure and the price it is derived
  // from can never disagree on one render -- both come from this one fetch.
  return (
    <DcaPositionView
      position={state.position}
      params={config.params}
      currentPrice={state.lastPrice}
      capitalAsset={bot.capitalAsset}
      baseAsset={baseAsset}
    />
  );
}
