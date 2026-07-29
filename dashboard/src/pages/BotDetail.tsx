/**
 * The bot detail view (this session): the destination for the `/bots/:id` links
 * the bot-list session wired. Read-only -- no liquidate button, no kill switch,
 * no confirmation dialogs; those are explicit later sessions.
 *
 * Layout order (brief items 2–5): a summary of stat cards, then the
 * strategy-specific state (grid ladder OR DCA position, dispatched by
 * `StrategyState`), then this bot's order, trade and alert history. Detail views
 * carry more density and stack vertically at every width (brief item 7) rather
 * than collapsing to cards the way the list does.
 *
 * Data comes from `GET /api/bots/:id`, fetched on load and polled every 5s while
 * open -- the same `usePolling` pattern as the list (brief item 1). The inner
 * view is keyed by id (see the route), so navigating between bots re-fetches
 * immediately instead of showing the previous bot for up to a poll interval.
 *
 * Honest failure states (brief item 6): a 404 (`unknown_bot`) says the bot does
 * not exist; a schema-less environment (`no_schema`, production pre-go-live)
 * shows the same honest message pattern as the list; an expired Access session
 * says to reload. None of these shows a blank or broken page.
 */

import { useCallback } from "react";
import { Link, useParams } from "react-router-dom";
import { ApiError, fetchBot } from "../api/client";
import { usePolling } from "../api/usePolling";
import type { BotDetail as BotDetailData } from "../api/types";
import { BotSummary } from "../components/BotSummary";
import { StartAction } from "../components/StartAction";
import { LiquidateAction } from "../components/LiquidateAction";
import { StrategyState } from "../components/StrategyState";
import { OrderHistory } from "../components/OrderHistory";
import { TradeHistory } from "../components/TradeHistory";
import { AlertList } from "../components/AlertList";
import { formatTime } from "../format";

function BackLink() {
  return (
    <Link
      to="/"
      className="text-sm text-zinc-400 underline-offset-2 hover:text-zinc-200 hover:underline"
    >
      ← Back to bots
    </Link>
  );
}

function FreshnessIndicator({
  lastUpdated,
  error,
}: {
  lastUpdated: number | null;
  error: Error | null;
}) {
  return (
    <div className="flex items-center gap-2 text-xs text-zinc-500">
      <span
        className={["inline-block h-2 w-2 rounded-full", error ? "bg-red-400" : "bg-emerald-400"].join(" ")}
        aria-hidden
      />
      <span>
        {error ? "Update failed" : "Live"} · updated {formatTime(lastUpdated)}
      </span>
    </div>
  );
}

/** An honest, bordered message for a hard load failure (brief item 6). */
function LoadError({ id, error }: { id: string; error: Error | null }) {
  const code = error instanceof ApiError ? error.code : null;

  if (code === "unknown_bot") {
    return (
      <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 px-4 py-10 text-center">
        <div className="text-sm font-medium text-zinc-200">No such bot</div>
        <p className="mx-auto mt-1 max-w-md text-sm text-zinc-500">
          There is no bot instance with id <span className="tabular text-zinc-300">{id}</span>. It may
          have been removed, or the link may be wrong.
        </p>
      </div>
    );
  }

  if (code === "no_schema") {
    return (
      <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 px-4 py-10 text-center text-sm text-zinc-400">
        This environment has no database schema yet — migrations are deferred to go-live, so there is
        no bot data to show.
      </div>
    );
  }

  if (code === "unauthenticated") {
    return (
      <div className="rounded-lg border border-red-500/30 bg-red-500/5 px-4 py-10 text-center text-sm text-red-300">
        Your Cloudflare Access session has expired — reload to sign in again.
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-red-500/30 bg-red-500/5 px-4 py-10 text-center text-sm text-red-300">
      Couldn’t load this bot: {error?.message ?? "unknown error"}
      <div className="mt-1 text-xs text-red-400/70">
        If this persists, your Cloudflare Access session may have expired — reload to sign in again.
      </div>
    </div>
  );
}

function BotDetailView({ id }: { id: string }) {
  const fetcher = useCallback((signal: AbortSignal) => fetchBot(id, signal), [id]);
  const poll = usePolling<BotDetailData>(fetcher);

  const firstLoad = poll.loading && poll.data === null;
  const hardError = poll.error !== null && poll.data === null;
  const bot = poll.data;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <BackLink />
        {bot !== null && <FreshnessIndicator lastUpdated={poll.lastUpdated} error={poll.error} />}
      </div>

      {firstLoad ? (
        <div className="rounded-lg border border-zinc-800 px-4 py-10 text-center text-sm text-zinc-500">
          Loading bot…
        </div>
      ) : hardError ? (
        <LoadError id={id} error={poll.error} />
      ) : bot !== null ? (
        <>
          <BotSummary bot={bot} />
          {/*
           * The start control renders only for a created bot (this session's
           * brief item 2); any other status shows nothing. Its confirm dialog
           * spells out what the bot's real config will place once running, and
           * is honest that no order fires until the execution path is wired. A
           * successful start refetches immediately (item 7) via `poll.refetch`.
           */}
          {bot.status === "created" && <StartAction bot={bot} onStarted={poll.refetch} />}
          {/*
           * The liquidate control renders only for a halted bot (brief item 1);
           * the component itself further hides the button when the position is
           * flat, so a halted-but-empty bot shows no action. A successful
           * response refetches immediately (item 4) via `poll.refetch`.
           */}
          {bot.status === "halted" && <LiquidateAction bot={bot} onLiquidated={poll.refetch} />}
          <StrategyState bot={bot} />
          <OrderHistory orders={bot.orders} />
          <TradeHistory trades={bot.trades} />
          <AlertList alerts={bot.alerts} />
        </>
      ) : null}
    </div>
  );
}

export function BotDetail() {
  const { id } = useParams<{ id: string }>();
  // id is always present for the /bots/:id route. Keying the view by it makes
  // navigation between bots re-poll from scratch.
  return <BotDetailView key={id} id={id ?? ""} />;
}
