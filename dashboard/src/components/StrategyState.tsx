/**
 * Strategy-specific state dispatcher.
 *
 * The one place that decides, from the AUTHORITATIVE discriminator
 * `config.strategy` (not the presence of a state field -- see BotRuntimeState's
 * note), which strategy-specific view to render. Grid, DCA and trailing-stop
 * state are genuinely different data, so each has its own component; this is how
 * the view "correctly renders whichever strategy the bot actually is" without
 * assuming one or duplicating logic. The shared summary and histories live
 * outside this dispatcher, in the detail page.
 *
 * ── ⚠ WHAT THIS FILE USED TO BE, AND WHY IT IS SHAPED LIKE THIS NOW ──
 *
 * It dispatched with `if (strategy === "grid") { ... } return <DcaPositionView>`.
 * That trailing `return` was not a default case -- it was an unstated claim that
 * every non-grid bot is a DCA bot. When the first trailing-stop bot went live it
 * fell straight into the DCA view, which read `params.baseOrderSize` off a
 * `{ trailPct }` object, `formatMoney(undefined)` threw, React unmounted the
 * entire tree, and `/bots/bot-ts1` rendered a BLANK PAGE -- no header, no banner,
 * nothing.
 *
 * So the decision itself now lives in `../strategyView.ts`, where the Workers
 * test pool can actually reach it (a test importing this `.tsx` collects zero
 * tests rather than failing -- docs/open-items/component-test-harness.md), and
 * this file holds only JSX. Every arm of `StrategyView` is rendered explicitly
 * and the `unsupported` arm renders a MESSAGE. Nothing here falls through, and
 * nothing here throws.
 */

import type { BotDetail } from "../api/types";
import { baseAssetOf } from "../format";
import { strategyLabel, strategyViewFor, trailingStopFigures } from "../strategyView";
import { GridLadderView } from "./GridLadderView";
import { DcaPositionView } from "./DcaPositionView";
import { TrailingStopView } from "./TrailingStopView";

export function StrategyState({ bot }: { bot: BotDetail }) {
  const { config, state } = bot;
  const view = strategyViewFor(config, state);

  // Orphaned: a bot_instances row whose Durable Object holds no state. Decided
  // by the dispatcher rather than inline, so this page's answer to "no object
  // state" is the same one `strategyView.test.ts` drives.
  if (view.kind === "orphan") {
    return (
      <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-4 py-4 text-sm text-amber-200">
        This bot has a database row but its Durable Object holds no state, so there is no live
        strategy state to show.
      </div>
    );
  }

  // Unreachable while `view.kind !== "orphan"` -- the dispatcher returns "orphan"
  // for exactly that condition. Written as a guard rather than `!` so the
  // narrowing is the compiler's, not an assertion of ours.
  if (state === null) return null;

  // Quantities below are held in the BASE asset while every money figure beside
  // them is in the capital (quote) asset. Every view labels its figures, so all
  // of them need this; derived once here rather than three times from the same
  // pair.
  const baseAsset = baseAssetOf(bot.pair, bot.capitalAsset);

  switch (view.kind) {
    case "grid-no-ladder":
      return (
        <div className="rounded-lg border border-dashed border-zinc-800 px-4 py-6 text-sm text-zinc-500">
          This grid bot has no ladder state yet.
        </div>
      );

    /*
     * ⚠ EVERY ARM BELOW READS `view.config`, NEVER `bot.config`. The verdict
     * carries the config already narrowed to its own strategy, so a view
     * physically cannot be handed another strategy's params -- which is the one
     * thing that went wrong. Reaching back to `bot.config` here would restore
     * the need to re-narrow, and a re-narrow has a failing branch that must
     * render something; this way there is no such branch to get wrong.
     */
    case "grid":
      return (
        <GridLadderView
          ladder={view.ladder}
          currentPrice={state.lastPrice}
          params={view.config.params}
          capitalAsset={bot.capitalAsset}
          baseAsset={baseAsset}
        />
      );

    case "dca":
      // `state.lastPrice` is the SAME value the summary's "Current price" card
      // reads (BotSummary), so the derived unrealized figure and the price it is
      // derived from can never disagree on one render -- both come from this one
      // fetch. The same holds for the trailing-stop arm below.
      return (
        <DcaPositionView
          position={state.position}
          params={view.config.params}
          currentPrice={state.lastPrice}
          capitalAsset={bot.capitalAsset}
          baseAsset={baseAsset}
        />
      );

    case "trailing-stop":
      return (
        <TrailingStopView
          /*
           * The high-water mark and trail level come from `bot.position` -- the
           * pair the BACKEND derived with the strategy's own `trailLevelOf`.
           * `state.highWaterMark` is the raw field behind the first of them and
           * is deliberately not read here; re-deriving the level from it would
           * put a second copy of that arithmetic on the screen an operator
           * reads to decide whether to intervene.
           */
          figures={trailingStopFigures(bot.position)}
          position={state.position}
          params={view.config.params}
          currentPrice={state.lastPrice}
          capitalAsset={bot.capitalAsset}
          baseAsset={baseAsset}
          allocatedCapital={bot.allocatedCapital}
          /* Absent, null and 0 are one fact here -- see the field in types.ts. */
          entryAttempts={state.entryAttempts ?? null}
        />
      );

    case "unsupported":
      /*
       * ⚠ THE ARM WHOSE ABSENCE CAUSED THE BLANK PAGE. A strategy this build has
       * no view for is a real possibility across a network seam -- the Worker can
       * be a deploy ahead of this bundle -- and the honest response is to say so.
       * Everything outside this dispatcher (summary, controls, order/trade/alert
       * history) is strategy-agnostic and still renders, so the operator gets a
       * working page with one stated gap instead of nothing at all.
       */
      return (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-4 py-4 text-sm text-amber-200">
          This bot runs the <span className="font-medium">{strategyLabel(view.strategy)}</span>{" "}
          strategy, which this version of the dashboard has no view for. Its summary, orders,
          trades and alerts above and below are complete; only the strategy-specific state is
          missing. Reload after the next deploy, or check that the dashboard build matches the
          Worker.
        </div>
      );
  }
}
