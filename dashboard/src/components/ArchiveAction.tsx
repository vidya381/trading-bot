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
 * It writes one boolean on the bot's `bot_instances` row. It does not delete,
 * and it is not a soft delete that becomes a hard one later -- the backend's
 * storage layer has no delete method at all, so there is no path from here to a
 * removed row. The bot's Durable Object is not even called: its configuration,
 * position, ladder or DCA entries, order history and idempotency records are
 * untouched, as are its orders, trades, alerts and audit entries in D1. Its
 * capital allocation is untouched too -- archiving is NOT closing, and only the
 * `stopped` transition returns capital to the ledger.
 *
 * That is why the dialog spends its words on what does NOT happen. An operator
 * who reads "archive" as "delete" will either avoid a harmless action or, worse,
 * use it believing they have cleaned something up.
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
            Archiving hides <span className="font-medium text-zinc-100">{bot.id}</span> from the bot
            list’s default view. It stays {bot.status}; nothing about it is stopped, sold or changed.
          </p>
          {/*
           * The load-bearing paragraph. "Archive" reads as "delete" to most
           * people, and every one of these is a fact about what this action
           * does not touch, not a reassurance about intent.
           */}
          <div className="rounded-md border border-zinc-700 bg-zinc-800/40 px-3 py-2 text-[0.8125rem] text-zinc-300">
            <span className="font-medium text-zinc-100">Nothing is deleted.</span> This bot’s full
            history — every order, trade and alert — its strategy state and its configuration are all
            kept exactly as they are, and this page will look the same afterwards. Its allocated
            capital is unchanged too: archiving is not closing.
          </div>
          <p className="text-[0.8125rem] text-zinc-400">
            You can find it again with <span className="font-medium">Show archived</span> on the bot
            list, and unarchive it from here at any time. It keeps counting toward this account’s
            totals while archived, because its allocation and position are still real.
          </p>
          <p className="text-[0.8125rem] text-zinc-400">
            One thing to know: an archived bot cannot be started or resumed. Unarchive it first — a
            running bot must never be hidden from the default view.
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
  const canArchive = !bot.archived && (bot.status === "halted" || bot.status === "stopped");

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
                title: "Bot archived",
                text:
                  "It is hidden from the bot list’s default view and nothing else changed. Its history, " +
                  "state and allocated capital are exactly as they were. Use Show archived on the bot " +
                  "list to see it, or unarchive it here.",
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
  // not archived. Never a shown-but-disabled button.
  if (!canArchive && !bot.archived && outcome === null) return null;

  return (
    <section className="rounded-lg border border-zinc-800 bg-zinc-900/40 px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-medium text-zinc-200">
            {bot.archived ? "Archived" : "Archive bot"}
          </div>
          <p className="mt-0.5 text-xs text-zinc-500">
            {bot.archived
              ? "Hidden from the bot list’s default view. Nothing was deleted, and it cannot be started or resumed until it is unarchived."
              : "Hide this finished bot from the bot list’s default view. Nothing is deleted and it can be brought back at any time."}
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
          canArchive && (
            <button
              type="button"
              onClick={() => setDialogOpen(true)}
              className="shrink-0 rounded-md border border-zinc-700 px-3 py-2 text-sm font-semibold text-zinc-300 hover:border-zinc-600 hover:bg-zinc-800"
            >
              Archive bot
            </button>
          )
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
          onConfirm={() => void run(true)}
          onCancel={() => {
            if (!submitting) setDialogOpen(false);
          }}
        />
      )}
    </section>
  );
}
