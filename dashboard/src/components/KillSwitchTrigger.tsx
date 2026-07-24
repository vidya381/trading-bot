/**
 * The TRIGGER control for the global kill switch (this session's brief items 2,
 * 3, 5, 7, 8).
 *
 * This is deliberately NOT the liquidate action's plain yes/no confirm. A global
 * pull halts every bot on every account at once -- its blast radius is total --
 * so it uses the type-to-confirm pattern reserved for exactly this control:
 *
 *   - a required REASON (item 3): a real free-text input the operator fills in.
 *     It becomes the permanent record of why the switch was pulled (it lands in
 *     the alert and audit log), so it is never a placeholder or default. The
 *     backend refuses an empty one.
 *   - a required CONFIRMATION PHRASE (item 2): the operator must type
 *     `HALT ALL BOTS` exactly. The red trip button stays visibly disabled until
 *     BOTH the reason is non-empty and the phrase matches character-for-character.
 *
 * THE RESULT IS SHOWN HONESTLY (items 5, 7). The backend sweep never rethrows on
 * an unreachable bot: it returns a 200 listing what it `haltedBotIds` and what it
 * `failures` to reach. So a partial outcome is a success to inspect, not an error
 * -- both lists are rendered. The one genuinely in-between case is the POST
 * itself failing mid-flight (a network drop after the latch may already have been
 * written): the true state is then unknown, the switch may already be tripped,
 * and because the pull is idempotent it is safe to re-read/retry -- shown as an
 * explicit "outcome unknown" state rather than a false success or false failure.
 *
 * IN-FLIGHT PROTECTION (item 8): a `submitting` guard drops a second submit and
 * the button disables + shows a spinner while the request is in flight, so a
 * double-click cannot fire two pulls.
 *
 * The input form shows only while the switch is ARMED; once tripped it collapses
 * to its lingering outcome banner (the primary action then is Reset). After any
 * attempt -- success OR failure -- `onChanged` re-reads the real status so the
 * page reflects the truth, which is what resolves the unknown case above.
 */

import { useState } from "react";
import { ApiError, triggerKillSwitch } from "../api/client";
import type { GlobalTripResult, KillSwitchState } from "../api/types";

/** The exact phrase the operator must type to unlock the trip button (item 2). */
export const CONFIRM_PHRASE = "HALT ALL BOTS";

type OutcomeTone = "success" | "warning" | "error";

interface Outcome {
  readonly tone: OutcomeTone;
  readonly title: string;
  readonly text: string;
  /** A trip result to render as halted/failed lists, when we have one. */
  readonly result?: GlobalTripResult;
}

const OUTCOME_CLASS: Record<OutcomeTone, string> = {
  success: "border-emerald-500/30 bg-emerald-500/5 text-emerald-200",
  warning: "border-amber-500/40 bg-amber-500/10 text-amber-100",
  error: "border-red-500/30 bg-red-500/5 text-red-200",
};

function outcomeForResult(result: GlobalTripResult): Outcome {
  const halted = result.haltedBotIds.length;
  const failed = result.failures.length;
  const title = result.newlyTripped
    ? `Kill switch pulled — ${halted} bot${halted === 1 ? "" : "s"} halted`
    : `Already tripped — re-swept, ${halted} bot${halted === 1 ? "" : "s"} halted`;
  return {
    tone: failed > 0 ? "warning" : "success",
    title,
    text:
      failed > 0
        ? `${failed} bot${failed === 1 ? "" : "s"} could NOT be reached and may still be trading — ` +
          `see the list below. Pulling again re-sweeps them (it is safe and idempotent). No bot on any ` +
          `account can be created or resumed until the switch is reset.`
        : `Every active bot on every account was halted. No bot can be created or resumed until the ` +
          `switch is reset.`,
    result,
  };
}

function outcomeForError(error: unknown): Outcome {
  if (error instanceof ApiError) {
    // A network drop (or an unreadable response) after the POST left: we do not
    // know whether the latch was written or any bot halted. This is the crux of
    // item 7 -- neither a success nor a clean failure.
    if (error.code === "network_error" || error.code === "bad_response") {
      return {
        tone: "warning",
        title: "Outcome unknown — could not confirm",
        text:
          "The request failed before a result came back. The switch may already be tripped and some " +
          "bots may already be halted, or nothing may have happened. Pulling again is safe (the action " +
          "is idempotent); the status above will refresh to show the true state.",
      };
    }
    if (error.code === "no_schema" || error.code === "kill_switch_unavailable") {
      return {
        tone: "error",
        title: "Nothing to halt in this environment",
        text:
          "This environment has no bots to halt yet — its database schema (and exchange) are not " +
          "provisioned until go-live. Nothing was changed.",
      };
    }
    if (error.code === "missing_field" || error.code === "requires_reason") {
      return {
        tone: "error",
        title: "A reason is required",
        text: "The pull needs a reason recording the emergency. Nothing was changed.",
      };
    }
    if (error.code === "requires_human_actor") {
      return {
        tone: "error",
        title: "A human actor is required",
        text:
          "The global kill switch can only be pulled by an authenticated person, never an automated " +
          "actor. Nothing was changed.",
      };
    }
    if (error.code === "unauthenticated") {
      return {
        tone: "error",
        title: "Session expired",
        text: "Your Cloudflare Access session has expired — reload to sign in again. Nothing was changed.",
      };
    }
    return { tone: "error", title: "Pull failed", text: `${error.message} Nothing was changed.` };
  }
  return {
    tone: "error",
    title: "Pull failed",
    text: `${error instanceof Error ? error.message : "unexpected error"}. Nothing was changed.`,
  };
}

function BotIdList({ ids, tone }: { ids: readonly string[]; tone: "halted" | "failed" }) {
  if (ids.length === 0) return null;
  return (
    <ul className="mt-1 space-y-0.5">
      {ids.map((id) => (
        <li key={id} className="tabular font-mono text-xs">
          <span aria-hidden>{tone === "halted" ? "✓ " : "✗ "}</span>
          {id}
        </li>
      ))}
    </ul>
  );
}

function OutcomeView({ outcome }: { outcome: Outcome }) {
  const result = outcome.result;
  return (
    <div className={["mt-4 rounded-md border px-3 py-2 text-sm", OUTCOME_CLASS[outcome.tone]].join(" ")}>
      <div className="font-semibold">{outcome.title}</div>
      <p className="mt-0.5 text-[0.8125rem] leading-snug opacity-90">{outcome.text}</p>
      {result && (result.haltedBotIds.length > 0 || result.failures.length > 0) && (
        <div className="mt-2 grid gap-3 sm:grid-cols-2">
          {result.haltedBotIds.length > 0 && (
            <div>
              <div className="text-xs font-medium uppercase tracking-wide text-emerald-300/80">
                Halted ({result.haltedBotIds.length})
              </div>
              <BotIdList ids={result.haltedBotIds} tone="halted" />
            </div>
          )}
          {result.failures.length > 0 && (
            <div>
              <div className="text-xs font-medium uppercase tracking-wide text-red-300">
                Could not reach ({result.failures.length})
              </div>
              <ul className="mt-1 space-y-0.5">
                {result.failures.map((failure) => (
                  <li key={failure.botInstanceId} className="text-xs">
                    <span className="tabular font-mono">
                      <span aria-hidden>✗ </span>
                      {failure.botInstanceId}
                    </span>
                    <span className="text-red-200/70"> — {failure.message}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function KillSwitchTrigger({
  state,
  onChanged,
}: {
  state: KillSwitchState;
  /** Re-read the real switch status after any attempt (success or failure). */
  onChanged: () => void;
}) {
  const [reason, setReason] = useState("");
  const [confirmText, setConfirmText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  const phraseMatches = confirmText === CONFIRM_PHRASE;
  const reasonGiven = reason.trim() !== "";
  const canSubmit = !submitting && reasonGiven && phraseMatches;

  async function trip() {
    if (!canSubmit) return; // gate + double-click guard (item 8)
    setSubmitting(true);
    try {
      const { result } = await triggerKillSwitch(reason.trim());
      setOutcome(outcomeForResult(result));
      // Clear the inputs so a future re-arm starts from a blank, deliberate form.
      setReason("");
      setConfirmText("");
    } catch (error) {
      setOutcome(outcomeForError(error));
    } finally {
      setSubmitting(false);
      // Reveal the true state whichever way it went -- this is what resolves the
      // "outcome unknown" case for a mid-flight failure (item 7).
      onChanged();
    }
  }

  const armed = state === "armed";

  return (
    <section className="rounded-xl border border-red-500/30 bg-red-500/[0.04] p-5">
      <h2 className="text-base font-semibold text-red-200">Trigger the global kill switch</h2>
      <p className="mt-1 text-sm text-zinc-400">
        Halts <span className="font-medium text-zinc-200">every bot on every account</span> immediately
        through each bot's own halt path, and latches so nothing can be created or resumed until a human
        resets it. Use only in a genuine emergency.
      </p>

      {armed ? (
        <form
          className="mt-4 space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            void trip();
          }}
        >
          <div>
            <label htmlFor="ks-reason" className="block text-sm font-medium text-zinc-300">
              Reason <span className="text-red-400">*</span>
            </label>
            <p className="mt-0.5 text-xs text-zinc-500">
              Recorded permanently — this is the record of why the switch was pulled.
            </p>
            <textarea
              id="ks-reason"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              disabled={submitting}
              rows={2}
              placeholder="e.g. suspected key compromise on the main account"
              className="mt-1.5 w-full resize-y rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-red-500/60 focus:outline-none disabled:opacity-50"
            />
          </div>

          <div>
            <label htmlFor="ks-confirm" className="block text-sm font-medium text-zinc-300">
              Type <span className="font-mono text-red-300">{CONFIRM_PHRASE}</span> to confirm{" "}
              <span className="text-red-400">*</span>
            </label>
            <input
              id="ks-confirm"
              type="text"
              value={confirmText}
              onChange={(event) => setConfirmText(event.target.value)}
              disabled={submitting}
              autoComplete="off"
              spellCheck={false}
              placeholder={CONFIRM_PHRASE}
              aria-invalid={confirmText !== "" && !phraseMatches}
              className={[
                "tabular mt-1.5 w-full rounded-md border bg-zinc-950 px-3 py-2 font-mono text-sm text-zinc-100 placeholder:text-zinc-600 focus:outline-none disabled:opacity-50",
                confirmText !== "" && !phraseMatches
                  ? "border-red-500/60"
                  : phraseMatches
                    ? "border-emerald-500/50"
                    : "border-zinc-700 focus:border-red-500/60",
              ].join(" ")}
            />
          </div>

          <button
            type="submit"
            disabled={!canSubmit}
            className="inline-flex items-center gap-2 rounded-md bg-red-600 px-4 py-2 text-sm font-semibold text-white hover:bg-red-500 disabled:cursor-not-allowed disabled:bg-red-950 disabled:text-red-300/40"
          >
            {submitting && (
              <span
                className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/40 border-t-white"
                aria-hidden
              />
            )}
            {submitting ? "Halting every bot…" : "Trip kill switch — halt every bot"}
          </button>
          {!canSubmit && !submitting && (
            <p className="text-xs text-zinc-600">
              {!reasonGiven
                ? "Enter a reason and type the confirmation phrase to enable."
                : `Type ${CONFIRM_PHRASE} exactly to enable.`}
            </p>
          )}
        </form>
      ) : (
        <p className="mt-4 rounded-md border border-zinc-800 bg-zinc-900/40 px-3 py-2 text-sm text-zinc-400">
          The switch is already tripped. To pull it again (for example to re-sweep bots that could not be
          reached), reset it first, then trigger.
        </p>
      )}

      {outcome !== null && <OutcomeView outcome={outcome} />}
    </section>
  );
}
