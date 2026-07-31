/**
 * The start-bot control on the bot detail view (this session's brief).
 *
 * A newly created bot is idle: its config is saved and its Durable Object
 * exists, but no orders have been placed (spec 6.2/6.3 step 1). Starting is the
 * explicit step-2 action a human takes to move it to `running`. This is the only
 * UI that reaches `POST /api/bots/:id/start`.
 *
 * WHAT STARTING ACTUALLY DOES (confirmed from source, not assumed)
 * ---------------------------------------------------------------
 * `BotInstance.start` subscribes the bot to the live `PriceFeed` for its
 * (exchange, pair) -- fail-closed, BEFORE the flip, so an unreachable feed means
 * the bot does not start -- then moves the status `created -> running`, mirrors
 * it to D1, and audits `bot.started`. It places no order in this call itself:
 * the base order (DCA) or the full ladder (grid) fires on the NEXT
 * `onPriceUpdate`, because placing needs a price and reading one is an exchange
 * call that can fail (§5.6). That price now genuinely arrives -- the feed is
 * wired (step 14.1-14.5) and verified live (14.6 Tier 0, 14.7 Tier 1), and the
 * bot object resolves a real exchange client (step 13). So starting is a real,
 * capital-committing action whose order lands on the next closed 1-minute
 * candle, and the dialog says exactly that. It carried a "no order will be
 * placed yet" caveat through step 12; that caveat was removed, not softened,
 * once the price-feed arc landed, because it had become actively misleading.
 *
 * WHAT THIS RENDERS AND WHEN (brief items 2, 3)
 * ---------------------------------------------
 * The trigger button appears ONLY when the bot's status is `created` (enforced
 * by the caller AND re-checked here). Any other status shows nothing -- never a
 * shown-but-disabled button. Clicking opens a plain yes/no dialog (NOT the
 * type-to-confirm pattern, which is reserved for the systemwide kill switch):
 * starting is a real, per-bot capital-committing action, but it is one bot, not
 * every bot, so it sits in the same confirmation weight as liquidate.
 *
 * THE OUTCOMES (brief items 5, 6, 7)
 * ----------------------------------
 * `start`'s named failure is a bot that is no longer `created` (`invalid_status`,
 * 409); it still cannot return a price, reachability, or order-filter error,
 * because it places no order itself. Since step 14 the fail-closed feed subscribe
 * can also reject (e.g. `not_attached` where no PRICE_FEED binding exists), which
 * the generic branch reports verbatim with "Nothing was started" -- accurate,
 * because the subscribe runs before the status flip. So the honest set is
 * invalid_status, an expired session, a network drop, and the generic fallback
 * that now also covers a refused feed subscription. On success the
 * caller's `onStarted` refetches immediately so the new `running` status shows
 * without waiting for the poll. While a request is in flight both buttons are
 * disabled and the confirm button shows a loading state, so a double-click
 * cannot fire two requests.
 */

import { useEffect, useRef, useState } from "react";
import { ApiError, startBot } from "../api/client";
import type { BotDetail } from "../api/types";
import { trimDecimal } from "../format";

type OutcomeTone = "success" | "warning" | "info" | "error";

interface Outcome {
  readonly tone: OutcomeTone;
  readonly title: string;
  readonly text: string;
}

const OUTCOME_CLASS: Record<OutcomeTone, string> = {
  success: "border-emerald-500/30 bg-emerald-500/5 text-emerald-200",
  warning: "border-amber-500/30 bg-amber-500/5 text-amber-200",
  info: "border-zinc-700 bg-zinc-900/40 text-zinc-300",
  error: "border-red-500/30 bg-red-500/5 text-red-200",
};

/**
 * The base asset of a pair, given its quote (capital) asset. Binance symbols are
 * concatenated base+quote ("BTCUSDT"), so the base is the pair with the quote
 * suffix stripped. Falls back to the raw pair if it does not end in the quote.
 * (Same derivation as LiquidateAction -- kept local rather than shared for now.)
 */
function baseAsset(pair: string, quoteAsset: string): string {
  if (quoteAsset !== "" && pair.length > quoteAsset.length && pair.endsWith(quoteAsset)) {
    return pair.slice(0, pair.length - quoteAsset.length);
  }
  return pair;
}

/**
 * What the bot's REAL config will place once running, in one line, built from
 * the bot's own config values (brief item 4) -- never generic wording. Returns
 * null when the object holds no config (an orphaned created row), so the dialog
 * can fall back to honest generic copy rather than inventing numbers.
 */
function plannedOrderSummary(bot: BotDetail): string | null {
  const config = bot.config;
  if (config === null) return null;
  if (config.strategy === "dca") {
    const asset = baseAsset(bot.pair, bot.capitalAsset);
    return (
      `a real buy worth ${trimDecimal(config.params.baseOrderSize)} ${bot.capitalAsset} ` +
      `of ${asset} (the base order)`
    );
  }
  const { gridLines, lowerBound, upperBound } = config.params;
  return (
    `its full ladder — ${gridLines} orders across ` +
    `${trimDecimal(lowerBound)}–${trimDecimal(upperBound)} ${bot.capitalAsset}`
  );
}

/** Map a thrown `ApiError` (or any error) to its distinct, honest message. */
function outcomeForError(error: unknown): Outcome {
  if (error instanceof ApiError) {
    if (error.code === "invalid_status") {
      return {
        tone: "error",
        title: "Bot is no longer in the created state",
        text:
          "This bot is not newly created anymore — it may have been started already since the page " +
          "loaded. Only a created bot can be started (a halted one is resumed instead); nothing changed. " +
          "The view will refresh to its current state.",
      };
    }
    if (error.code === "unauthenticated") {
      return {
        tone: "error",
        title: "Session expired",
        text: "Your Cloudflare Access session has expired — reload to sign in again. Nothing was started.",
      };
    }
    return {
      tone: "error",
      title: "Couldn’t start the bot",
      text: `${error.message} Nothing was started.`,
    };
  }
  return {
    tone: "error",
    title: "Couldn’t start the bot",
    text: `${error instanceof Error ? error.message : "unexpected error"}. Nothing was started.`,
  };
}

function ConfirmDialog({
  planned,
  submitting,
  onConfirm,
  onCancel,
}: {
  /** The one-line plan built from the bot's real config, or null (orphaned). */
  planned: string | null;
  submitting: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);

  // Focus the safe (cancel) button on open, and close on Escape unless a
  // request is in flight (a mid-request Escape must not orphan the call).
  useEffect(() => {
    cancelRef.current?.focus();
  }, []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !submitting) onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [submitting, onCancel]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={submitting ? undefined : onCancel}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="start-title"
        className="w-full max-w-md rounded-xl border border-emerald-500/40 bg-zinc-900 p-5 shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 id="start-title" className="text-lg font-semibold text-emerald-200">
          Start this bot?
        </h2>

        <div className="mt-3 rounded-lg border border-emerald-500/20 bg-emerald-500/5 px-3 py-2">
          <div className="text-xs font-medium uppercase tracking-wide text-emerald-300/80">
            What starting will place
          </div>
          <div className="mt-0.5 text-sm text-zinc-100">
            {planned === null
              ? "This bot’s stored config could not be read, so the exact order can’t be shown here."
              : (
                <>
                  Once running, on the next price update it places{" "}
                  <span className="font-medium">{planned}</span>.
                </>
              )}
          </div>
        </div>

        <div className="mt-3 space-y-2 text-sm text-zinc-300">
          <p>
            Starting moves this bot from <span className="font-medium">created</span> to{" "}
            <span className="font-medium">running</span>. This is a real, capital-committing action for
            this one bot.
          </p>
          <div className="rounded-md border border-amber-500/25 bg-amber-500/5 px-3 py-2 text-[0.8125rem] text-amber-200/90">
            This commits real capital. Starting subscribes the bot to the live price feed, and the
            next closed 1-minute candle — normally within a minute — drives a real order on the real
            exchange. There is no dry run and no further prompt after this one.
          </div>
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <button
            ref={cancelRef}
            type="button"
            onClick={onCancel}
            disabled={submitting}
            className="rounded-md px-3 py-2 text-sm font-medium text-zinc-300 hover:bg-zinc-800 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={submitting}
            className="inline-flex items-center gap-2 rounded-md bg-emerald-600 px-3 py-2 text-sm font-semibold text-white hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {submitting && (
              <span
                className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/40 border-t-white"
                aria-hidden
              />
            )}
            {submitting ? "Starting…" : "Start bot"}
          </button>
        </div>
      </div>
    </div>
  );
}

export function StartAction({
  bot,
  onStarted,
}: {
  bot: BotDetail;
  /** Force an immediate refetch of the bot after a successful start. */
  onStarted: () => void;
}) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  // Guard state writes after unmount: a successful start triggers a refetch that
  // moves the bot to `running`, which removes this component from the
  // created-only caller entirely.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // Re-check status here as well as at the caller: only a created bot can start.
  const canStart = bot.status === "created";
  const planned = plannedOrderSummary(bot);

  async function confirm() {
    if (submitting) return; // double-click guard (brief item 6)
    setSubmitting(true);
    try {
      await startBot(bot.id);
      if (!mounted.current) return;
      setOutcome({
        tone: "success",
        title: "Bot started — now running",
        text:
          "The status moved to running and the bot is subscribed to the live price feed. Its first " +
          "order goes to the exchange on the next closed 1-minute candle — watch the orders and " +
          "alerts below.",
      });
      setDialogOpen(false);
      // A successful response is the one case we refresh immediately (item 7);
      // errors fall through to the existing 5s poll so their banner persists.
      onStarted();
    } catch (error) {
      if (!mounted.current) return;
      setOutcome(outcomeForError(error));
      setDialogOpen(false);
    } finally {
      if (mounted.current) setSubmitting(false);
    }
  }

  // Nothing to show: not a created bot and no lingering outcome.
  if (!canStart && outcome === null) return null;

  return (
    <section className="rounded-lg border border-emerald-500/20 bg-emerald-500/[0.03] px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-medium text-emerald-200">Start bot</div>
          <p className="mt-0.5 text-xs text-zinc-500">
            Move this created bot to running. Its first order fires on the next price update.
          </p>
        </div>
        {canStart && (
          <button
            type="button"
            onClick={() => setDialogOpen(true)}
            className="shrink-0 rounded-md border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-sm font-semibold text-emerald-200 hover:bg-emerald-500/20"
          >
            Start bot
          </button>
        )}
      </div>

      {outcome !== null && (
        <div className={["mt-3 rounded-md border px-3 py-2 text-sm", OUTCOME_CLASS[outcome.tone]].join(" ")}>
          <div className="font-medium">{outcome.title}</div>
          <p className="mt-0.5 text-[0.8125rem] leading-snug opacity-90">{outcome.text}</p>
        </div>
      )}

      {dialogOpen && (
        <ConfirmDialog
          planned={planned}
          submitting={submitting}
          onConfirm={confirm}
          onCancel={() => {
            if (!submitting) setDialogOpen(false);
          }}
        />
      )}
    </section>
  );
}
