/**
 * The manual halt control on the bot detail view (this session's brief).
 *
 * The UI for `POST /api/bots/:id/halt`, which has existed since the manual-halt
 * session but has been reachable only by `curl`. Until now a human looking at
 * one misbehaving bot had two options, both wrong for the job: pull the GLOBAL
 * kill switch (every bot, every account -- section 7.4 is deliberately
 * all-or-nothing) or wait for reconciliation to react to drift the system
 * detected on its own. Neither is "stop THIS one, now, because I do not like
 * what I am seeing".
 *
 * It is also the precondition the controls below it assume. `LiquidateAction`
 * and `ApplyMissedFillsAction` both refuse a running bot and tell the operator
 * to halt it first; before this button, following that instruction meant
 * reaching for the systemwide switch.
 *
 * WHAT HALTING ACTUALLY DOES (confirmed from source, not assumed)
 * --------------------------------------------------------------
 * `BotInstance.#halt` marks the status `halted` FIRST and durably, then cancels
 * every open order, then mirrors to D1, alerts, audits, and unsubscribes from
 * the price feed. The order is deliberate and inverted from the spec's own
 * listing: cancelling first would mean a crash partway through leaves a bot
 * still marked `running` with some orders cancelled, which the next price update
 * would happily add to. Marking first means a crash leaves a halted bot with
 * live orders -- visible, alerted, and safe, because nothing will trade against
 * them.
 *
 * Two consequences the copy below states rather than glosses:
 *
 *   1. THE POSITION IS NOT SOLD. A halt stops trading and cancels resting
 *      orders; whatever the bot holds, it keeps, and its capital reservation is
 *      untouched (releasing it is a close, a different action entirely). Selling
 *      out is `LiquidateAction`, which becomes available precisely because this
 *      button ran.
 *   2. A 200 IS NOT PROOF THE EXCHANGE IS CLEAR. `#cancelOpenOrders` does not
 *      abort on the first failure -- a halt that stops at the first failure is a
 *      halt that half happened -- and an order whose cancellation cannot be
 *      confirmed is NOT assumed cancelled (section 5.6). It stays in
 *      `openOrderIds` with a `cancel_failed` critical alert, and the halt still
 *      returns 200. The success banner sends the operator to the alerts for
 *      exactly that reason instead of reporting a clean book it cannot verify.
 *
 * WHEN THIS RENDERS (brief item 1)
 * --------------------------------
 * Only while the bot is `running` -- enforced by the caller AND re-checked here,
 * never a shown-but-disabled button. The other three statuses are excluded for
 * three different reasons, and only one of them is a backend refusal:
 *
 *   - `halted`: already stopped. The endpoint would return 200 `already_halted`
 *     and change nothing, so a button here would teach an operator that the
 *     control does nothing.
 *   - `stopped`: the backend REFUSES it (`invalid_status`, 409) -- its capital is
 *     released, there is nothing left to halt.
 *   - `created`: the backend WOULD allow it (`#halt` accepts `created` and
 *     `running`), and this is a deliberate scope choice rather than a limit
 *     being mirrored. A created bot has placed nothing, holds nothing, and is
 *     subscribed to nothing; "halting" it would move it to a status whose only
 *     exit is `resume`, which is a heavier, latch-asserting action than the
 *     start it never took. The honest control for a bot that should not run is
 *     to simply not start it.
 *
 * THE REQUIRED REASON (brief item 2)
 * ----------------------------------
 * `reason` is a real free-text input the operator fills in, not a default and
 * not a placeholder: it is stored as `manual: <reason>` in `halt_reason`, it is
 * what the resume dialog shows the next person, and it is the difference between
 * a bot that says why it stopped and one that only says that it did. The backend
 * refuses a missing or whitespace-only value (`requireString` trims first), so
 * the confirm button stays disabled until the TRIMMED reason is non-empty --
 * this codebase does not ship buttons that can only ever error.
 *
 * A plain confirm dialog, NOT the kill switch's type-to-confirm phrase. That
 * pattern is reserved for the systemwide pull, whose blast radius is total.
 * Halting one bot is the same weight category as start, resume and liquidate:
 * consequential, reversible-with-deliberation, one bot.
 *
 * THE OUTCOMES (brief item 3)
 * ---------------------------
 * `already_halted` is reported as its own outcome rather than folded into
 * success, because the two are not the same event and the difference is visible
 * to the operator: the reason they just typed was NOT recorded, and the bot
 * keeps the reason from the halt that actually stopped it (`#halt` returns early
 * before writing anything). Reporting that as "halted, reason recorded" would be
 * a lie that only surfaces later, when someone reads the resume dialog and finds
 * a different explanation than the one they wrote.
 *
 * The rest map one-to-one onto what the endpoint can actually return: a stopped
 * bot (409), an object with no config (404), an expired Access session, and the
 * dropped request -- which is an explicit "outcome unknown" rather than a
 * failure, with the useful fact that retrying is safe because a second halt on
 * an already-halted bot changes nothing. Same in-flight/double-click guard as
 * every other write surface here.
 */

import { useEffect, useRef, useState } from "react";
import { ApiError, haltBot } from "../api/client";
import type { BotDetail, HaltResult } from "../api/types";

type OutcomeTone = "success" | "warning" | "info" | "error";

interface Outcome {
  readonly tone: OutcomeTone;
  readonly title: string;
  readonly text: string;
}

const OUTCOME_CLASS: Record<OutcomeTone, string> = {
  success: "border-emerald-500/30 bg-emerald-500/5 text-emerald-200",
  warning: "border-amber-500/40 bg-amber-500/10 text-amber-100",
  info: "border-zinc-700 bg-zinc-900/40 text-zinc-300",
  error: "border-red-500/30 bg-red-500/5 text-red-200",
};

/**
 * A 200, read for WHICH success it was. `already_halted` is not this call's
 * doing and did not record the operator's reason -- see the docblock above.
 */
function outcomeForResult(result: HaltResult, openOrders: number): Outcome {
  if (result.action === "already_halted") {
    return {
      tone: "info",
      title: "Already halted, nothing changed",
      text:
        "This bot was halted before this request arrived (something else stopped it, or an earlier " +
        "click did). Halting an already-halted bot does nothing, on purpose, so no order was " +
        "cancelled. The part worth knowing: the reason you just typed was NOT recorded. The bot keeps the " +
        `reason from the halt that actually stopped it${result.detail ? `: ${result.detail}` : "."}`,
    };
  }
  const orders =
    openOrders === 0
      ? "It had no open orders to cancel."
      : `Cancellation was issued for the ${openOrders} order${openOrders === 1 ? "" : "s"} it had open.`;
  return {
    tone: "success",
    title: "Bot halted",
    text:
      `The bot is stopped and will place no further orders. ${orders} Check the alerts below before ` +
      "assuming the exchange is clear: an order whose cancellation could not be confirmed is left " +
      "open with a cancel_failed alert rather than being assumed cancelled, and this response " +
      "succeeds either way. The position it was holding is untouched. Halting never sells.",
  };
}

/** Map a thrown `ApiError` (or any error) to its distinct, honest message. */
function outcomeForError(error: unknown): Outcome {
  if (error instanceof ApiError) {
    if (error.code === "invalid_status") {
      return {
        tone: "error",
        title: "Bot is stopped, so there is nothing to halt",
        text:
          "This bot is no longer running; it has been stopped since this page loaded, and a stopped " +
          "bot's capital is already released. Nothing was changed. The view will refresh to its " +
          "current state.",
      };
    }
    if (error.code === "missing_field") {
      return {
        tone: "error",
        title: "A reason is required",
        text:
          "The halt needs a real explanation. It becomes this bot's recorded halt reason and is what " +
          "the next person sees before resuming it. Nothing was changed.",
      };
    }
    if (error.code === "not_created") {
      return {
        tone: "error",
        title: "This bot object holds no state",
        text:
          `${error.message} There is a database row but no live object behind it, so there is nothing ` +
          "running to halt. Nothing was changed.",
      };
    }
    if (error.code === "unauthenticated") {
      return {
        tone: "error",
        title: "Session expired",
        text:
          "Your Cloudflare Access session has expired. Reload to sign in again. The bot is still " +
          "running.",
      };
    }
    if (error.code === "network_error" || error.code === "bad_response") {
      // The kill switch's "outcome unknown" honesty. A halt marks the status
      // before it cancels, so a request that died in flight may have stopped the
      // bot without reporting back.
      return {
        tone: "warning",
        title: "Outcome unknown, couldn’t confirm",
        text:
          `${error.message}. The request may or may not have reached the bot, so it may already be ` +
          "halted. Halting again is SAFE: a second halt on an already-halted bot changes nothing. " +
          "The status above will refresh to show the truth.",
      };
    }
    return {
      tone: "error",
      title: "Couldn’t halt the bot",
      text: `${error.message} The bot is still running.`,
    };
  }
  return {
    tone: "error",
    title: "Couldn’t halt the bot",
    text: `${error instanceof Error ? error.message : "unexpected error"}. The bot is still running.`,
  };
}

function ConfirmDialog({
  bot,
  reason,
  onReasonChange,
  submitting,
  onConfirm,
  onCancel,
}: {
  bot: BotDetail;
  reason: string;
  onReasonChange: (value: string) => void;
  submitting: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const reasonRef = useRef<HTMLTextAreaElement>(null);

  // Focus the REASON field on open rather than the cancel button. Unlike the
  // dialogs whose only inputs are the two buttons, the first thing to do here is
  // type, and the destructive button is unreachable until something is typed --
  // so this cannot turn a stray keystroke into a halt. Enter inside a textarea
  // inserts a newline; it does not submit the form.
  useEffect(() => {
    reasonRef.current?.focus();
  }, []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !submitting) onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [submitting, onCancel]);

  const strategyLabel = bot.strategy === "dca" ? "DCA" : "grid";
  const openOrders = bot.state?.openOrderIds.length ?? 0;
  const holdsPosition = bot.position !== null;
  const canSubmit = !submitting && reason.trim() !== "";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-black/60 p-4"
      onClick={submitting ? undefined : onCancel}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="halt-title"
        className="my-8 w-full max-w-lg rounded-xl border border-red-500/40 bg-zinc-900 p-5 shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 id="halt-title" className="text-lg font-semibold text-red-200">
          Halt this bot?
        </h2>

        <form
          className="mt-3 space-y-3 text-sm text-zinc-300"
          onSubmit={(event) => {
            event.preventDefault();
            onConfirm();
          }}
        >
          <p>
            This stops the bot immediately. Its status moves{" "}
            <span className="font-medium">running → halted</span>, it places no further orders, and it
            is unsubscribed from the live price feed, so the next closed candle drives nothing.
          </p>

          <div className="rounded-md border border-red-500/30 bg-red-500/[0.07] px-3 py-2 text-[0.8125rem]">
            <div className="font-medium text-red-100">
              {openOrders === 0
                ? "It has no open orders right now"
                : `Its ${openOrders} open ${openOrders === 1 ? "order is" : "orders are"} cancelled`}
            </div>
            <p className="mt-0.5 leading-snug text-red-100/85">
              {openOrders === 0
                ? "Nothing is resting on the exchange for this bot, so there is nothing to cancel. " +
                  "Halting still stops it from placing anything new."
                : `Halting cancels every order this ${strategyLabel} bot has resting on the exchange. ` +
                  "That is not reversible by resuming: resuming re-enters the execution path and " +
                  "decides afresh from the position the bot holds then. It does not put the " +
                  "cancelled orders back."}
            </p>
            {openOrders > 0 && (
              <p className="mt-2 leading-snug text-red-100/70">
                A cancellation whose outcome the exchange does not confirm is left open and alerted
                (<span className="tabular">cancel_failed</span>) rather than assumed cancelled, and
                the halt still succeeds. Read the alerts afterwards before treating the book as clear.
              </p>
            )}
          </div>

          {/*
           * The most likely wrong assumption about a control labelled "halt",
           * so it is stated whether or not there is a position to lose: this
           * stops trading, it does not exit.
           */}
          <div className="rounded-md border border-zinc-700 bg-zinc-950/40 px-3 py-2 text-[0.8125rem]">
            <div className="font-medium text-zinc-200">The position is NOT sold</div>
            <p className="mt-0.5 leading-snug text-zinc-400">
              {holdsPosition
                ? "This bot is holding a position, and it keeps it. Halting stops trading, it does " +
                  "not exit. The position stays exposed to the market with no bot managing it, and " +
                  "its capital stays reserved. Selling out is a separate action (Liquidate), which " +
                  "becomes available once the bot is halted."
                : "Halting stops trading; it never sells. This bot is flat right now, so there is " +
                  "nothing to exit, but its allocated capital stays reserved either way. Releasing " +
                  "it is a close, a different action again."}
            </p>
          </div>

          <div className="rounded-md border border-amber-500/25 bg-amber-500/5 px-3 py-2 text-[0.8125rem] text-amber-200/90">
            <span className="font-medium">Coming back is a separate, deliberate action.</span> A halt
            never auto-resumes. Resuming is its own decision, taken after review, and it commits real
            capital again: it re-subscribes the bot to the feed and re-enters the same live execution
            path. It also asserts both risk latches, so it is blocked entirely while the global kill
            switch is pulled or this account's circuit breaker is tripped. Halting is not.
          </div>

          <div>
            <label htmlFor="halt-reason" className="block text-sm font-medium text-zinc-300">
              Reason <span className="text-red-400">*</span>
            </label>
            <p className="mt-0.5 text-xs text-zinc-500">
              Recorded permanently as this bot's halt reason, and shown to whoever resumes it. Write
              what you actually saw.
            </p>
            <textarea
              id="halt-reason"
              ref={reasonRef}
              value={reason}
              onChange={(event) => onReasonChange(event.target.value)}
              disabled={submitting}
              rows={2}
              placeholder="e.g. spread looks wrong on this pair, stopping to look"
              className="mt-1.5 w-full resize-y rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-red-500/60 focus:outline-none disabled:opacity-50"
            />
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onCancel}
              disabled={submitting}
              className="rounded-md px-3 py-2 text-sm font-medium text-zinc-300 hover:bg-zinc-800 disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!canSubmit}
              className="inline-flex items-center gap-2 rounded-md bg-red-600 px-3 py-2 text-sm font-semibold text-white hover:bg-red-500 disabled:cursor-not-allowed disabled:bg-red-950 disabled:text-red-300/40"
            >
              {submitting && (
                <span
                  className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/40 border-t-white"
                  aria-hidden
                />
              )}
              {submitting ? "Halting…" : "Halt bot"}
            </button>
          </div>
          {!canSubmit && !submitting && (
            <p className="text-right text-xs text-zinc-600">
              Enter a reason to enable. An empty one won’t be accepted.
            </p>
          )}
        </form>
      </div>
    </div>
  );
}

export function HaltAction({
  bot,
  onHalted,
}: {
  bot: BotDetail;
  /** Force an immediate refetch of the bot after an attempt that may have halted it. */
  onHalted: () => void;
}) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  // Guard state writes after unmount: a successful halt triggers a refetch that
  // moves the bot to `halted`, which removes this component from the
  // running-only caller entirely.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // Re-check status here as well as at the caller: only a running bot is halted
  // from this control. See the docblock for why `created` is excluded even
  // though the backend would accept it.
  const canHalt = bot.status === "running";
  const openOrders = bot.state?.openOrderIds.length ?? 0;

  async function confirm() {
    if (submitting) return; // double-click guard
    const trimmed = reason.trim();
    // Mirrors the backend's own `requireString`, which trims before testing.
    // The button is already disabled on this condition; this is the guard for
    // the form's submit path.
    if (trimmed === "") return;

    setSubmitting(true);
    try {
      const { result } = await haltBot(bot.id, trimmed);
      if (!mounted.current) return;
      setOutcome(outcomeForResult(result, openOrders));
      setDialogOpen(false);
      setReason("");
      // The status, the open orders and the alerts below have all just changed,
      // and seeing that they did is the whole value of the control.
      onHalted();
    } catch (error) {
      if (!mounted.current) return;
      setOutcome(outcomeForError(error));
      setDialogOpen(false);
      // A dropped request may still have halted the bot. Refresh so the page
      // shows what actually happened rather than leaving a stale `running`
      // under an "outcome unknown" banner.
      if (error instanceof ApiError && (error.code === "network_error" || error.code === "bad_response")) {
        onHalted();
      }
    } finally {
      if (mounted.current) setSubmitting(false);
    }
  }

  // Nothing to show: not a running bot and no lingering outcome.
  if (!canHalt && outcome === null) return null;

  return (
    <section className="rounded-lg border border-red-500/20 bg-red-500/[0.03] px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-medium text-red-200">Halt bot</div>
          <p className="mt-0.5 text-xs text-zinc-500">
            Stop this one bot now and cancel its open orders. It keeps whatever position it holds, and
            resuming afterwards is a separate, deliberate action.
          </p>
        </div>
        {canHalt && (
          <button
            type="button"
            onClick={() => setDialogOpen(true)}
            className="shrink-0 rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm font-semibold text-red-200 hover:bg-red-500/20"
          >
            Halt bot
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
          reason={reason}
          onReasonChange={setReason}
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
