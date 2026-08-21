/**
 * The archive / unarchive control on the bot detail view (step 26).
 *
 * The one place that reaches `POST /api/bots/:id/archive` and its inverse. Both
 * directions live in one component because they are one control in two states:
 * the bot is either in the default view or hidden from it, and the button
 * offered is whichever one moves it.
 *
 * WHAT ARCHIVING IS, AND THE THING THE COPY MUST NOT LET AN OPERATOR ASSUME
 * ------------------------------------------------------------------------
 * ⚠ THIS CHANGED AT STEP 26.1 AND THE COPY BELOW CHANGED WITH IT. Step 26's
 * archive wrote one boolean and this file said so at length: "archiving is NOT
 * closing", the allocation "is untouched". That is no longer true and the old
 * wording is not merely stale, it is the exact reassurance an operator would now
 * act on wrongly. Archiving CLOSES the bot: it moves to `stopped` and its
 * allocated capital genuinely returns to the account, where the next bot can
 * spend it. That is the point -- capital reserved for a finished bot is capital
 * nothing can use.
 *
 * WHAT IS STILL TRUE, and still structural rather than a promise: nothing is
 * DELETED. The backend's storage layer has no delete method at all, so there is
 * no path from here to a removed row. The bot's configuration, position, ladder
 * or DCA entries, order history, idempotency records, orders, trades, alerts and
 * audit entries all survive, permanently, and the detail page still renders. An
 * archived bot is a finished bot, not an erased one.
 *
 * So the dialog still spends most of its words on what does NOT happen -- an
 * operator who reads "archive" as "delete" will either avoid the action or use
 * it believing they have cleaned something up -- but it now has to say plainly
 * that the capital comes back and that the bot cannot be restarted afterwards.
 *
 * THE POSITION GATE, AND WHY IT IS SHOWN RATHER THAN HIDDEN
 * --------------------------------------------------------
 * Closing cancels open orders but never SELLS, so archiving a bot that still
 * holds base asset would hand its full quote allocation back to the account
 * while that capital is still sitting in inventory. The backend refuses this
 * (`position_held`, 409) and never sells on the operator's behalf; the operator
 * clicks Liquidate first, on the halted bot, and archives once it is flat.
 *
 * `LiquidateAction` renders nothing at all when its action is unavailable ("if
 * it's not a valid action, don't render it") and this component has followed the
 * same rule for `running`/`created`. THE HELD-POSITION CASE DELIBERATELY BREAKS
 * THAT RULE and renders a disabled button with the reason. The difference is
 * that the other unavailable states are self-evident from the page -- a running
 * bot obviously cannot be retired yet -- whereas "halted, finished, and still
 * refusing to archive" looks like a broken button. The operator needs the
 * sentence that names Liquidate as the next step, and a component that rendered
 * nothing could not give it to them.
 *
 * WHY ARCHIVING GETS A DIALOG AND UNARCHIVING DOES NOT
 * ---------------------------------------------------
 * Not risk -- neither direction commits capital, which is what `HaltAction`,
 * `StartAction` and `ResumeAction`'s dialogs exist for. It is surprise:
 * archiving makes a bot vanish from the page the operator was just looking at,
 * and the dialog is where "it is still on the list behind Show archived, and
 * here is the button that brings it back" gets said. Unarchiving surprises
 * nobody: it only makes something visible, so it is one click.
 *
 * WHEN IT RENDERS
 * ---------------
 * Only when there is something to do: the bot is `halted` or `stopped` (it can
 * be archived), or it is archived (it can be unarchived). A `running` or
 * `created` bot that is not archived gets nothing at all -- not a disabled
 * button, matching how every other control here handles a status it cannot act
 * on. The gate is re-checked here as well as at the caller.
 *
 * THE ONE INTERACTION WITH THE REST OF THE SYSTEM is on the resume path, not
 * here: `start` and `resume` refuse an archived bot with `bot_archived` (409),
 * so a hidden bot cannot quietly become a running one. This component's copy
 * says so, because the operator's next question after archiving a halted bot is
 * how to bring it back to life.
 */

import { useEffect, useRef, useState } from "react";
import { ApiError, archiveBot, unarchiveBot } from "../api/client";
import type { BotDetail } from "../api/types";
import { baseAssetOf, formatMoney, formatQuantity, signOf } from "../format";

type OutcomeTone = "success" | "info" | "error";

interface Outcome {
  readonly tone: OutcomeTone;
  readonly title: string;
  readonly text: string;
}

const OUTCOME_CLASS: Record<OutcomeTone, string> = {
  success: "border-emerald-500/30 bg-emerald-500/5 text-emerald-200",
  info: "border-zinc-700 bg-zinc-900/40 text-zinc-300",
  error: "border-red-500/30 bg-red-500/5 text-red-200",
};

/** Map a thrown error to its own honest message. Nothing was changed in any case. */
function outcomeForError(error: unknown, archiving: boolean): Outcome {
  const nothingChanged = archiving
    ? "Nothing changed and the bot is still on the list."
    : "Nothing changed and the bot is still archived.";
  if (error instanceof ApiError) {
    // The gate this step exists for. The backend's message already names the
    // exact held amount and the remedy, so it is shown rather than replaced --
    // but the title has to say which of the two 409s this is, because "wrong
    // status" and "still holding" need completely different next moves.
    if (error.code === "position_held") {
      return {
        tone: "error",
        title: "This bot still holds a position",
        text:
          `${error.message} ${nothingChanged}`,
      };
    }
    if (error.code === "invalid_status") {
      return {
        tone: "error",
        title: "This bot isn’t halted or stopped",
        text:
          `${error.message} Only a halted or stopped bot can be archived, so that a live bot is ` +
          `never hidden from the default view. ${nothingChanged}`,
      };
    }
    if (error.code === "unauthenticated") {
      return {
        tone: "error",
        title: "Session expired",
        text: `Your Cloudflare Access session has expired. Reload to sign in again. ${nothingChanged}`,
      };
    }
    return {
      tone: "error",
      title: archiving ? "Couldn’t archive the bot" : "Couldn’t unarchive the bot",
      text: `${error.message} ${nothingChanged}`,
    };
  }
  return {
    tone: "error",
    title: archiving ? "Couldn’t archive the bot" : "Couldn’t unarchive the bot",
    text: `${error instanceof Error ? error.message : "unexpected error"}. ${nothingChanged}`,
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

  // Focus the safe button on open; close on Escape unless a request is in
  // flight, so a mid-request Escape cannot orphan the call.
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
        aria-labelledby="archive-title"
        className="w-full max-w-md rounded-xl border border-zinc-700 bg-zinc-900 p-5 shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 id="archive-title" className="text-lg font-semibold text-zinc-100">
          Archive this bot?
        </h2>

        <div className="mt-3 space-y-2 text-sm text-zinc-300">
          <p>
            This retires <span className="font-medium text-zinc-100">{bot.id}</span> for good: it is
            closed, its capital is returned to the account, and it is hidden from the bot list’s
            default view.
          </p>
          {/*
           * The paragraph the operator must not skim. Step 26's dialog promised
           * the opposite of this in so many words ("archiving is not closing"),
           * so anyone who learned the old behaviour is carrying exactly the
           * wrong model. It leads with the irreversible half.
           */}
          <div className="rounded-md border border-amber-500/30 bg-amber-500/[0.06] px-3 py-2 text-[0.8125rem] text-amber-100">
            <span className="font-medium">
              {formatMoney(bot.allocatedCapital)} {bot.capitalAsset} goes back to the account
            </span>{" "}
            and becomes available for new bots. The bot’s status becomes stopped, and a stopped bot
            cannot be started or resumed — not even after unarchiving it. This part cannot be undone.
          </div>
          {/*
           * Still load-bearing, and still true: "archive" reads as "delete" to
           * most people. Every fact here is about what is not touched.
           */}
          <div className="rounded-md border border-zinc-700 bg-zinc-800/40 px-3 py-2 text-[0.8125rem] text-zinc-300">
            <span className="font-medium text-zinc-100">Nothing is deleted.</span> This bot’s full
            history — every order, trade and alert — its strategy state and its configuration are all
            kept exactly as they are, and this page will still render afterwards. Archiving retires a
            bot; it never erases one.
          </div>
          <p className="text-[0.8125rem] text-zinc-400">
            You can find it again with <span className="font-medium">Show archived</span> on the bot
            list, and unarchive it from here at any time — that puts it back in the default view, but
            it stays stopped and its capital stays returned.
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
            className="inline-flex items-center gap-2 rounded-md bg-zinc-200 px-3 py-2 text-sm font-semibold text-zinc-900 hover:bg-white disabled:cursor-not-allowed disabled:opacity-60"
          >
            {submitting && (
              <span
                className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-zinc-500/40 border-t-zinc-700"
                aria-hidden
              />
            )}
            {submitting ? "Archiving…" : "Archive bot"}
          </button>
        </div>
      </div>
    </div>
  );
}

export function ArchiveAction({
  bot,
  onChanged,
}: {
  bot: BotDetail;
  /** Force an immediate refetch after either direction succeeds. */
  onChanged: () => void;
}) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  // Guard state writes after unmount: either direction triggers a refetch that
  // can re-render this section into its other half.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // Re-checked here as well as at the caller. Same list as the backend's
  // ARCHIVABLE_STATUSES; a `created` bot is deliberately not archivable.
  const statusAllows = !bot.archived && (bot.status === "halted" || bot.status === "stopped");

  /*
   * The position gate, mirroring the backend's `assertFlatBeforeRelease` field
   * for field -- including the part that is easy to miss: it is SKIPPED for a
   * bot that is already `stopped`. Such a bot's capital has already been
   * returned, so blocking it could not prevent a release, and Liquidate needs a
   * HALTED bot, so the message would name an action it cannot take. Getting this
   * wrong in either direction shows the operator a button whose enabled state
   * disagrees with what the server will do.
   *
   * `bot.position?.heldQuantity ?? "0"` is the same expression `LiquidateAction`
   * uses to decide whether there is anything to sell, deliberately -- this must
   * block exactly the bots that one offers.
   */
  const held = bot.position?.heldQuantity ?? "0";
  const holdsPosition = bot.status !== "stopped" && signOf(held) === "positive";
  const canArchive = statusAllows && !holdsPosition;
  const blocked = statusAllows && holdsPosition;

  async function run(archiving: boolean) {
    if (submitting) return; // double-click guard
    setSubmitting(true);
    try {
      if (archiving) {
        const response = await archiveBot(bot.id);
        if (!mounted.current) return;
        setOutcome(
          response.result.action === "archived"
            ? {
                tone: "success",
                title: response.result.capitalReleased
                  ? "Bot closed and archived"
                  : "Bot archived",
                text:
                  (response.result.capitalReleased
                    ? `Its ${formatMoney(bot.allocatedCapital)} ${bot.capitalAsset} allocation has been ` +
                      "returned to the account and is available for new bots. The bot is now stopped " +
                      "and cannot be started or resumed again. "
                    : "Its capital allocation was not released by this action — it had already been " +
                      "returned, or this bot's object holds no state to close. ") +
                  "Nothing was deleted: its full history, strategy state and configuration are kept " +
                  "exactly as they are. Use Show archived on the bot list to see it, or unarchive it " +
                  "here to put it back in the default view.",
              }
            : {
                // A repeat is a success, not an error -- the backend reports it
                // rather than failing, and so does this.
                tone: "info",
                title: "Already archived",
                text: "This bot was already archived, so nothing changed.",
              },
        );
      } else {
        const response = await unarchiveBot(bot.id);
        if (!mounted.current) return;
        setOutcome(
          response.result.action === "unarchived"
            ? {
                tone: "success",
                title: "Bot unarchived",
                text:
                  "It is back in the bot list’s default view. Its status is unchanged — unarchiving " +
                  "resumes nothing, so a halted bot comes back halted.",
              }
            : {
                tone: "info",
                title: "Not archived",
                text: "This bot was not archived, so nothing changed.",
              },
        );
      }
      setDialogOpen(false);
      onChanged();
    } catch (error) {
      if (!mounted.current) return;
      setOutcome(outcomeForError(error, archiving));
      setDialogOpen(false);
    } finally {
      if (mounted.current) setSubmitting(false);
    }
  }

  // Nothing to offer and nothing to report: a running or created bot that is
  // not archived. A HELD POSITION is deliberately excluded from this early
  // return -- that is the one unavailable state that gets a shown-but-disabled
  // button, because it is the only one whose reason is not obvious from the rest
  // of the page. See the header.
  if (!canArchive && !blocked && !bot.archived && outcome === null) return null;

  return (
    <section className="rounded-lg border border-zinc-800 bg-zinc-900/40 px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-medium text-zinc-200">
            {bot.archived ? "Archived" : "Archive bot"}
          </div>
          <p className="mt-0.5 text-xs text-zinc-500">
            {bot.archived
              ? "Hidden from the bot list’s default view. Nothing was deleted; its history is kept in full."
              : blocked
                ? "Retire this bot and return its capital to the account. Not available yet — see below."
                : "Retire this finished bot: it is closed, its capital returns to the account, and it leaves the default list view. Nothing is deleted."}
          </p>
        </div>
        {bot.archived ? (
          <button
            type="button"
            onClick={() => void run(false)}
            disabled={submitting}
            className="shrink-0 rounded-md border border-zinc-600 px-3 py-2 text-sm font-semibold text-zinc-200 hover:border-zinc-500 hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {submitting ? "Unarchiving…" : "Unarchive bot"}
          </button>
        ) : (
          (canArchive || blocked) && (
            <button
              type="button"
              onClick={blocked ? undefined : () => setDialogOpen(true)}
              disabled={blocked}
              /*
               * `title` as well as the panel below, so the reason is reachable
               * from the control itself and not only from prose beside it.
               */
              title={
                blocked
                  ? "This bot still holds a position. Liquidate it first."
                  : undefined
              }
              className="shrink-0 rounded-md border border-zinc-700 px-3 py-2 text-sm font-semibold text-zinc-300 hover:border-zinc-600 hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-zinc-700 disabled:hover:bg-transparent"
            >
              Archive bot
            </button>
          )
        )}
      </div>

      {/*
       * The reason the button above is disabled, stated where the operator is
       * already looking, with the remedy named. A 409 they have to read and
       * interpret is the thing this exists to avoid -- and the amount is the
       * real held quantity, not a generic phrase, matching how `LiquidateAction`
       * names the position it would sell.
       */}
      {blocked && (
        <div className="mt-3 rounded-md border border-amber-500/30 bg-amber-500/[0.06] px-3 py-2 text-sm text-amber-100">
          <div className="font-medium">Liquidate the position first</div>
          <p className="mt-0.5 text-[0.8125rem] leading-snug opacity-90">
            This bot still holds{" "}
            <span className="font-medium">
              {formatQuantity(held)} {baseAssetOf(bot.pair, bot.capitalAsset)}
            </span>
            . Archiving would return its full {formatMoney(bot.allocatedCapital)}{" "}
            {bot.capitalAsset} allocation to the account while that capital is still sitting in
            inventory rather than in cash, so it is refused. Use{" "}
            <span className="font-medium">Liquidate position</span> above to sell the holding, then
            archive once it is flat. Nothing is ever sold on your behalf.
          </p>
        </div>
      )}

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
          onConfirm={() => void run(true)}
          onCancel={() => {
            if (!submitting) setDialogOpen(false);
          }}
        />
      )}
    </section>
  );
}
