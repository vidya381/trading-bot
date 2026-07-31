/**
 * The resume-bot control on the bot detail view (this session's brief).
 *
 * `BotInstance.resume` was designed for exactly this from the first Durable
 * Object session -- section 7.2 step 5: a halt never auto-resumes, and coming
 * back requires an explicit human action after review -- but until now the only
 * caller was a test. This is that action's UI, and the only place that reaches
 * `POST /api/bots/:id/resume`.
 *
 * WHAT RESUMING ACTUALLY DOES (confirmed from source, not assumed)
 * ---------------------------------------------------------------
 * `resume` refuses a bot that is not `halted`, then asserts BOTH risk latches
 * (`assertGlobalArmed`, `assertAccountArmed`), then re-subscribes the bot to its
 * `PriceFeed` fail-closed, then flips `halted -> running`, mirrors to D1 and
 * audits `bot.resumed` carrying the previous halt reason. `halt_reason` is
 * deliberately NOT cleared, so the row keeps saying why it stopped.
 *
 * The re-subscribe is the same fail-closed call `start` makes, and it matters
 * more here: the halt path unsubscribed this bot, and if it was the pair's last
 * subscriber the feed closed its socket and reset its watermark. `subscribe`
 * seeing an empty registry brings the feed back up (`startFeed` -> connect ->
 * re-prime), so resuming genuinely re-enters the live price path rather than
 * returning to a dead one. Verified in `bot-instance.test.ts`
 * ("re-subscribes on resume after a halt") and `price-feed.test.ts`.
 *
 * WHAT THIS RENDERS AND WHEN (brief item 2)
 * -----------------------------------------
 * The trigger appears ONLY when the bot's status is `halted` -- enforced by the
 * caller AND re-checked here. Never a shown-but-disabled button for any other
 * status. Clicking opens a plain yes/no dialog (NOT the type-to-confirm pattern,
 * which is reserved for the systemwide kill switch): resuming is a real,
 * capital-committing action for ONE bot, the same weight category as start and
 * liquidate.
 *
 * WHY THE HALT REASON IS IN THE DIALOG (brief item 4)
 * --------------------------------------------------
 * Resuming should be an informed decision rather than a blind retry, so the
 * reason the bot stopped -- `order_rejected: ...`, `stop_loss: ...` -- is shown
 * in the dialog itself, not only on the page behind it. A halted bot whose cause
 * has not been fixed will simply halt again, and for a stop-loss halt it will do
 * so on the very next candle (see below).
 *
 * WHY THE "WHAT HAPPENS NEXT" COPY IS NOT START'S COPY
 * ---------------------------------------------------
 * Starting always places the base order (DCA) or the full ladder (grid), because
 * a created bot is flat by definition, and `StartAction` names those exact
 * numbers. A RESUMED bot is not flat by definition, and `decide()` is a function
 * of the CURRENT position: a resumed DCA bot may place an additional buy, a
 * take-profit sell, or nothing at all, and if it halted on `stop_loss` with the
 * price still below the stop, the next closed candle re-halts it immediately.
 * Naming a specific order here would therefore be a guess dressed as a fact, so
 * the dialog states the mechanism (the same live execution path, on the next
 * real closed candle) without inventing the order.
 *
 * THE OUTCOMES (brief items 5, 6, 7)
 * ---------------------------------
 * Resume's failure surface is WIDER than start's and each case gets its own
 * copy: `invalid_status` (409, no longer halted), `globally_tripped` (409) and
 * `account_tripped` (409) -- the two latches `start` never asserts, neither of
 * which a retry can fix -- `not_attached` (503, no PRICE_FEED binding), an
 * expired session, and a generic fallback. All of them are raised BEFORE the
 * status flip, so every failure message can truthfully say the bot is still
 * halted.
 *
 * Deliberately absent: a branch for "the price feed or exchange is still
 * unreachable". That is NOT an error this endpoint returns. `PriceFeed`'s
 * `#ensureConnected` catches a failed connect, schedules a backoff reconnect and
 * returns, so the subscribe succeeds and the bot enters `running` blind; the
 * feed's own `price_feed_blind` alert is the signal. The success banner says so
 * instead of a dead error branch pretending otherwise.
 *
 * On success the caller's `onResumed` refetches immediately (item 7) so the new
 * `running` status and any order activity show without waiting for the poll.
 * While a request is in flight both buttons are disabled and the confirm button
 * shows a loading state, so a double-click cannot fire two resumes (item 6).
 */

import { useEffect, useRef, useState } from "react";
import { ApiError, resumeBot } from "../api/client";
import type { BotDetail } from "../api/types";
import { formatTime } from "../format";

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

/** Map a thrown `ApiError` (or any error) to its distinct, honest message. */
function outcomeForError(error: unknown): Outcome {
  if (error instanceof ApiError) {
    if (error.code === "invalid_status") {
      return {
        tone: "error",
        title: "Bot is no longer halted",
        text:
          "This bot is not halted anymore — it may have been resumed already since the page loaded. " +
          "Only a halted bot can be resumed; nothing changed. The view will refresh to its current state.",
      };
    }
    if (error.code === "globally_tripped") {
      return {
        tone: "error",
        title: "Global kill switch is pulled",
        text:
          `${error.message} The bot is still halted. Resuming stays blocked until someone re-arms the ` +
          "kill switch on the kill-switch page — and re-arming resumes nothing on its own, so you " +
          "would come back here afterwards.",
      };
    }
    if (error.code === "account_tripped") {
      return {
        tone: "error",
        title: "This account’s circuit breaker is tripped",
        text:
          `${error.message} The bot is still halted. Resuming stays blocked until this account's ` +
          "breaker is reset; that reset re-arms the account but resumes no bot by itself.",
      };
    }
    if (error.code === "not_attached") {
      return {
        tone: "error",
        title: "No price feed in this environment",
        text:
          `${error.message} The subscribe runs before the status flip, so nothing changed — the bot ` +
          "is still halted.",
      };
    }
    if (error.code === "unauthenticated") {
      return {
        tone: "error",
        title: "Session expired",
        text:
          "Your Cloudflare Access session has expired — reload to sign in again. The bot is still halted.",
      };
    }
    return {
      tone: "error",
      title: "Couldn’t resume the bot",
      text: `${error.message} The bot is still halted.`,
    };
  }
  return {
    tone: "error",
    title: "Couldn’t resume the bot",
    text: `${error instanceof Error ? error.message : "unexpected error"}. The bot is still halted.`,
  };
}

function ConfirmDialog({
  bot,
  submitting,
  onConfirm,
  onCancel,
}: {
  bot: BotDetail;
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

  const strategyLabel = bot.strategy === "dca" ? "DCA" : "grid";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={submitting ? undefined : onCancel}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="resume-title"
        className="w-full max-w-md rounded-xl border border-emerald-500/40 bg-zinc-900 p-5 shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 id="resume-title" className="text-lg font-semibold text-emerald-200">
          Resume this bot?
        </h2>

        {/*
         * Brief item 4: the REAL halt reason, in the dialog, so the decision is
         * informed rather than a blind retry. `resume` never clears it, and the
         * backend serves it on the detail payload already.
         */}
        <div className="mt-3 rounded-lg border border-red-500/25 bg-red-500/5 px-3 py-2">
          <div className="text-xs font-medium uppercase tracking-wide text-red-300/80">
            Why it halted
          </div>
          <div className="mt-0.5 text-sm text-zinc-100">
            {bot.haltReason === null ? (
              <span className="text-zinc-400">
                No halt reason was recorded for this bot. Check the alerts below before resuming.
              </span>
            ) : (
              <span className="font-medium break-words">{bot.haltReason}</span>
            )}
          </div>
          {bot.haltedAt !== null && (
            <div className="mt-0.5 text-xs text-zinc-500">Halted at {formatTime(bot.haltedAt)}</div>
          )}
        </div>

        <div className="mt-3 space-y-2 text-sm text-zinc-300">
          <p>
            Resuming moves this bot from <span className="font-medium">halted</span> back to{" "}
            <span className="font-medium">running</span>. This is a real, capital-committing action for
            this one bot.
          </p>
          <div className="rounded-md border border-amber-500/25 bg-amber-500/5 px-3 py-2 text-[0.8125rem] text-amber-200/90">
            This commits real capital. Resuming re-subscribes the bot to the live price feed and
            re-enters the same execution path starting does, so for this {strategyLabel} bot the next
            real closed 1-minute candle — normally within a minute — drives a real order attempt on
            the real exchange. There is no dry run and no further prompt after this one.
          </div>
          {/*
           * Honest and deliberately NOT start's copy: a resumed bot is not flat
           * by definition, so which order fires depends on its current position.
           * A stop-loss halt whose price has not recovered re-halts at once.
           */}
          <p className="text-[0.8125rem] text-zinc-400">
            Exactly which order that is depends on the position this bot is holding now, not on a
            fresh cycle. If the condition that halted it has not actually been fixed, it will halt
            again — a stop-loss halt with the price still below the stop halts on that first candle.
          </p>
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
            {submitting ? "Resuming…" : "Resume bot"}
          </button>
        </div>
      </div>
    </div>
  );
}

export function ResumeAction({
  bot,
  onResumed,
}: {
  bot: BotDetail;
  /** Force an immediate refetch of the bot after a successful resume. */
  onResumed: () => void;
}) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  // Guard state writes after unmount: a successful resume triggers a refetch
  // that moves the bot to `running`, which removes this component from the
  // halted-only caller entirely.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // Re-check status here as well as at the caller: only a halted bot can resume.
  const canResume = bot.status === "halted";

  async function confirm() {
    if (submitting) return; // double-click guard (brief item 6)
    setSubmitting(true);
    try {
      await resumeBot(bot.id);
      if (!mounted.current) return;
      setOutcome({
        tone: "success",
        title: "Bot resumed — now running",
        text:
          "The status moved back to running and the bot is re-subscribed to the live price feed. Its " +
          "next order attempt goes to the exchange on the next closed 1-minute candle — watch the " +
          "orders and alerts below. If nothing appears within a few minutes, check the alerts for " +
          "price_feed_blind: an unreachable feed does not fail this action, it reconnects in the " +
          "background.",
      });
      setDialogOpen(false);
      // A successful response is the one case we refresh immediately (item 7);
      // errors fall through to the existing 5s poll so their banner persists.
      onResumed();
    } catch (error) {
      if (!mounted.current) return;
      setOutcome(outcomeForError(error));
      setDialogOpen(false);
    } finally {
      if (mounted.current) setSubmitting(false);
    }
  }

  // Nothing to show: not a halted bot and no lingering outcome.
  if (!canResume && outcome === null) return null;

  return (
    <section className="rounded-lg border border-emerald-500/20 bg-emerald-500/[0.03] px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-medium text-emerald-200">Resume bot</div>
          <p className="mt-0.5 text-xs text-zinc-500">
            Move this halted bot back to running. Its next order attempt fires on the next closed
            candle.
          </p>
        </div>
        {canResume && (
          <button
            type="button"
            onClick={() => setDialogOpen(true)}
            className="shrink-0 rounded-md border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-sm font-semibold text-emerald-200 hover:bg-emerald-500/20"
          >
            Resume bot
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
          bot={bot}
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
