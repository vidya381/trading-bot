/**
 * The RESET control for the global kill switch (this session's brief item 4).
 *
 * A distinct, separate action from triggering -- never folded into one toggle.
 * Re-arming requires a NOTE (a real free-text input, same reasoning as the
 * trigger's reason): it is the only record of what was resolved and why it is
 * safe to re-arm, and the backend refuses an empty one.
 *
 * Reset does NOT use the type-to-confirm phrase: that pattern is reserved for the
 * trigger, whose blast radius is total. Re-arming is comparatively safe -- it
 * halts nothing and resumes nothing -- so a plain confirm (button enabled once
 * the note is non-empty) is proportionate. The copy is explicit about what reset
 * does NOT do: every bot halted by the pull stays halted until resumed
 * individually, and any account whose own circuit breaker is tripped stays
 * blocked until that too is reset.
 *
 * IN-FLIGHT PROTECTION (item 8): a `submitting` guard drops a second submit and
 * the button disables + spins while the request is in flight.
 *
 * The form shows only while the switch is TRIPPED; when armed it collapses to a
 * muted note plus any lingering outcome banner. After any attempt, `onChanged`
 * re-reads the real status.
 */

import { useState } from "react";
import { ApiError, resetKillSwitch } from "../api/client";
import type { KillSwitchState } from "../api/types";

type OutcomeTone = "success" | "warning" | "error";

interface Outcome {
  readonly tone: OutcomeTone;
  readonly title: string;
  readonly text: string;
}

const OUTCOME_CLASS: Record<OutcomeTone, string> = {
  success: "border-emerald-500/30 bg-emerald-500/5 text-emerald-200",
  warning: "border-amber-500/40 bg-amber-500/10 text-amber-100",
  error: "border-red-500/30 bg-red-500/5 text-red-200",
};

function outcomeForError(error: unknown): Outcome {
  if (error instanceof ApiError) {
    if (error.code === "network_error" || error.code === "bad_response") {
      return {
        tone: "warning",
        title: "Outcome unknown, could not confirm",
        text:
          "The request failed before a result came back. The switch may or may not have re-armed; the " +
          "status above will refresh to show the true state. Resetting again is safe.",
      };
    }
    if (error.code === "not_tripped") {
      return {
        tone: "warning",
        title: "Already armed",
        text: "The switch is not tripped, so there was nothing to reset.",
      };
    }
    if (error.code === "no_schema" || error.code === "kill_switch_unavailable") {
      return {
        tone: "error",
        title: "Not provisioned in this environment",
        text:
          "This environment's database schema is not provisioned until go-live, so there is no switch " +
          "state to reset. Nothing was changed.",
      };
    }
    if (error.code === "missing_field" || error.code === "requires_reason") {
      return {
        tone: "error",
        title: "A note is required",
        text: "Re-arming needs a note recording what was resolved. Nothing was changed.",
      };
    }
    if (error.code === "requires_human_actor") {
      return {
        tone: "error",
        title: "A human actor is required",
        text: "The kill switch can only be reset by an authenticated person. Nothing was changed.",
      };
    }
    if (error.code === "unauthenticated") {
      return {
        tone: "error",
        title: "Session expired",
        text: "Your Cloudflare Access session has expired. Reload to sign in again. Nothing was changed.",
      };
    }
    return { tone: "error", title: "Reset failed", text: `${error.message} Nothing was changed.` };
  }
  return {
    tone: "error",
    title: "Reset failed",
    text: `${error instanceof Error ? error.message : "unexpected error"}. Nothing was changed.`,
  };
}

export function KillSwitchReset({
  state,
  onChanged,
}: {
  state: KillSwitchState;
  /** Re-read the real switch status after any attempt (success or failure). */
  onChanged: () => void;
}) {
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  const noteGiven = note.trim() !== "";
  const canSubmit = !submitting && noteGiven;

  async function reset() {
    if (!canSubmit) return; // gate + double-click guard (item 8)
    setSubmitting(true);
    try {
      await resetKillSwitch(note.trim());
      setOutcome({
        tone: "success",
        title: "Kill switch re-armed",
        text:
          "New bots can be created and halted bots resumed again. Note: every bot halted by the pull " +
          "stays halted until you resume it individually, and any account whose own circuit breaker is " +
          "tripped stays blocked until that too is reset.",
      });
      setNote("");
    } catch (error) {
      setOutcome(outcomeForError(error));
    } finally {
      setSubmitting(false);
      onChanged();
    }
  }

  const tripped = state === "tripped";

  return (
    <section className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-5">
      <h2 className="text-base font-semibold text-zinc-100">Reset (re-arm) the kill switch</h2>
      <p className="mt-1 text-sm text-zinc-400">
        A separate action from triggering. Re-arming lets bots be created and resumed again. It does not
        resume any halted bot on its own.
      </p>

      {tripped ? (
        <form
          className="mt-4 space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            void reset();
          }}
        >
          <div>
            <label htmlFor="ks-note" className="block text-sm font-medium text-zinc-300">
              Note <span className="text-red-400">*</span>
            </label>
            <p className="mt-0.5 text-xs text-zinc-500">
              Recorded permanently: what was resolved and why it is safe to re-arm.
            </p>
            <textarea
              id="ks-note"
              value={note}
              onChange={(event) => setNote(event.target.value)}
              disabled={submitting}
              rows={2}
              placeholder="e.g. rotated the compromised API key and confirmed balances reconcile"
              className="mt-1.5 w-full resize-y rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-zinc-500 focus:outline-none disabled:opacity-50"
            />
          </div>

          <button
            type="submit"
            disabled={!canSubmit}
            className="inline-flex items-center gap-2 rounded-md border border-zinc-600 bg-zinc-800 px-4 py-2 text-sm font-semibold text-zinc-100 hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {submitting && (
              <span
                className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/30 border-t-white"
                aria-hidden
              />
            )}
            {submitting ? "Re-arming…" : "Reset kill switch"}
          </button>
          {!canSubmit && !submitting && (
            <p className="text-xs text-zinc-600">Enter a note to enable.</p>
          )}
        </form>
      ) : (
        <p className="mt-4 rounded-md border border-zinc-800 bg-zinc-900/40 px-3 py-2 text-sm text-zinc-400">
          The switch is armed, so there is nothing to reset.
        </p>
      )}

      {outcome !== null && (
        <div className={["mt-4 rounded-md border px-3 py-2 text-sm", OUTCOME_CLASS[outcome.tone]].join(" ")}>
          <div className="font-semibold">{outcome.title}</div>
          <p className="mt-0.5 text-[0.8125rem] leading-snug opacity-90">{outcome.text}</p>
        </div>
      )}
    </section>
  );
}
