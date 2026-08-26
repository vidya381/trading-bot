/**
 * The order-state-drift repair control on the bot detail view.
 *
 * The UI for `POST /api/bots/:id/apply-missed-fills` (step 18), which until now
 * had no dashboard control at all -- deliberately, per that step's open question
 * 1: "the API is the honest surface until it has been used once in anger". It
 * has now been used in anger, on the 2026-07-31 incident, so this is the
 * control.
 *
 * WHAT THE ENDPOINT ACTUALLY DOES (read from source, not assumed)
 * --------------------------------------------------------------
 * For each order the bot still believes open, it reads `getOrderStatus` (which
 * has always sent `include_trades`), and for every execution the local record
 * does not already carry it applies the fill through the SAME code path a live
 * fill takes -- `applyFill` for the order transition, `applyEntry`/`planFill` for
 * the position, `#mirrorOrderUpdate`/`#mirrorTrade` for D1. No new arithmetic
 * exists in that path, which is the property that stops a repaired position from
 * disagreeing with a normally-recorded one.
 *
 * The fill ids are the exchange's own (Gemini's `tid`), never synthesised --
 * `applyFill` deduplicates on `fillId`, so a made-up id would make the real fill
 * either double-count or be silently swallowed. That same check makes the whole
 * operation idempotent for free: a second run applies nothing.
 *
 * WHEN THIS RENDERS (brief item 1)
 * --------------------------------
 * Only while this bot has an OPEN order-state-drift alert -- see `driftAlerts.ts`
 * for the five types and for why `cancel_fill_discrepancy`/`cancel_failed` are
 * excluded. This is not a permanently-visible button: it writes trades and moves
 * a position, and section 9's whole stance is that doing so needs a human acting
 * on a specific finding. No finding, no button. The alerts it keys off are
 * already on the detail payload (`GET /api/bots/:id` returns this bot's alerts),
 * so this costs no extra request.
 *
 * THE RUNNING-BOT REFUSAL (brief item 3)
 * -------------------------------------
 * The backend refuses anything but `halted` with `invalid_status`, so the repair
 * cannot race the bot's own pipeline. This mirrors that in two layers rather than
 * one:
 *   - Pre-flight: if a drift alert stands but the bot is not halted (a
 *     reconciliation halt that failed, or a bot resumed while the incident is
 *     still open), the panel renders WITHOUT the button and says why. This
 *     codebase does not ship buttons that only ever error (see the create-bot
 *     form's `sellOnStopLoss` decision).
 *   - The 409 branch below still exists, for the bot being resumed between page
 *     load and click.
 *
 * THE GRID WARNING (brief item 2)
 * ------------------------------
 * A grid fill normally places the paired replacement sell (`#applyGridFillToOrder`).
 * This path passes `placeReplacement: false`, so it does not. That is not an
 * oversight and the dialog says so: placing a live order from inside a correction
 * endpoint, on a bot that may still be halted, would put orders on the exchange
 * without the consent the operator withheld by leaving it halted -- resuming
 * trading through the back door. The consequence is real and permanent enough to
 * state plainly: the rung comes back EMPTY, and nothing places it later either.
 * That is still true, but the REASON changed and the old one is no longer a fact
 * about this system: it used to be "`#placeInitialLadder` only ever runs once
 * (`placed: true`)", which was a real defect -- a grid bot whose ladder was
 * cleared wholesale and later resumed never rebuilt it at all, and two live bots
 * sat inert because of it. `decide` now rebuilds a ladder that is VACANT as well
 * as one that was never placed (see `vacantLadder`), so a wholesale clear is
 * self-correcting on the next tick.
 *
 * This path is deliberately NOT covered by that, and the exclusion is what keeps
 * this warning honest: the repair leaves base HELD with an empty rung, and
 * `vacantLadder` refuses to rebuild while anything is held -- rebuilding would
 * place buys around inventory that has no sell against it. So the rung stays
 * empty until a human acts, and re-placing that level is still a separate manual
 * decision. See `docs/open-items/grid-ladder-placed-latch.md`.
 *
 * The honest upside is stated too: this leaves no PHANTOM order. `planFill`
 * clears the filled level's slot itself and returns the replacement as a separate
 * intent, so suppressing the placement leaves the ladder showing the acquired
 * base, its cost, and an empty rung -- all true. A phantom would make the very
 * next reconciliation pass raise fresh drift.
 *
 * THE OUTCOMES (brief items 4, 5)
 * ------------------------------
 * A 200 does NOT mean everything was repaired, so this never renders a generic
 * "done". Four success shapes are distinguished from the real result, and the
 * applied fills are listed individually (which order, which fill id, how much, at
 * what price) because "what exactly did this write" is the only question worth
 * asking after a repair. `skipped` lines are shown VERBATIM: the backend
 * deliberately distinguishes an unreadable order from a response carrying no
 * per-fill detail ("the detail was not reported" is not "nothing filled"), and
 * re-deriving that from string matching would be a weaker second copy of a
 * judgement already made.
 *
 * A dropped request is an explicit "outcome unknown" rather than a failure --
 * with the genuinely useful fact that retrying is safe here, because the repair
 * is idempotent by fill id. Same in-flight/double-click guard as every other
 * write surface.
 */

import { useEffect, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import { ApiError, applyMissedFills } from "../api/client";
import type { Alert, BotDetail, MissedFillsResult } from "../api/types";
import { APPLY_MISSED_FILLS_ANCHOR, openDriftAlerts } from "../driftAlerts";
import { formatMoney, formatQuantity, formatTime } from "../format";

type OutcomeTone = "success" | "warning" | "info" | "error";

const OUTCOME_CLASS: Record<OutcomeTone, string> = {
  success: "border-emerald-500/30 bg-emerald-500/5 text-emerald-200",
  warning: "border-amber-500/30 bg-amber-500/5 text-amber-200",
  info: "border-zinc-700 bg-zinc-900/40 text-zinc-300",
  error: "border-red-500/30 bg-red-500/5 text-red-200",
};

/** A finished attempt: either the backend's own result, or an error message. */
type Outcome =
  | { readonly kind: "result"; readonly result: MissedFillsResult }
  | { readonly kind: "message"; readonly tone: OutcomeTone; readonly title: string; readonly text: string };

/** Map a thrown `ApiError` (or any error) to its distinct, honest message. */
function outcomeForError(error: unknown): Outcome {
  if (error instanceof ApiError) {
    if (error.code === "invalid_status") {
      return {
        kind: "message",
        tone: "error",
        title: "Bot is no longer halted",
        text:
          "Missed fills can only be applied to a halted bot, and this one is not halted anymore. It " +
          "was probably resumed since this page loaded. Nothing was written. Repairing the books " +
          "underneath a live pipeline would race the bot's own order handling, which is why the " +
          "backend refuses it. Halt the bot again if you still want to repair it.",
      };
    }
    if (error.code === "not_attached") {
      return {
        kind: "message",
        tone: "error",
        title: "No exchange client in this environment",
        text:
          `${error.message} The repair reads the exchange to find the real fills, so it cannot run at ` +
          "all here. Nothing was written and the bot is unchanged.",
      };
    }
    if (error.code === "not_created") {
      return {
        kind: "message",
        tone: "error",
        title: "This bot object holds no state",
        text:
          `${error.message} There is a database row but no live object behind it, so there are no ` +
          "open orders to re-read. Nothing was written.",
      };
    }
    if (error.code === "unauthenticated") {
      return {
        kind: "message",
        tone: "error",
        title: "Session expired",
        text:
          "Your Cloudflare Access session has expired. Reload to sign in again. Nothing was written.",
      };
    }
    if (error.code === "network_error" || error.code === "bad_response") {
      // The kill switch's "outcome unknown" honesty, and here it comes with a
      // genuinely reassuring fact rather than just a caveat.
      return {
        kind: "message",
        tone: "warning",
        title: "Outcome unknown, couldn’t confirm",
        text:
          `${error.message}. The request may or may not have reached the bot, so some fills may ` +
          "already have been recorded. Running this again is SAFE: the repair deduplicates on the " +
          "exchange's own fill ids, so a fill that already landed is not applied twice. Check the " +
          "order and trade history below, then re-run if anything is still missing.",
      };
    }
    return {
      kind: "message",
      tone: "error",
      title: "Couldn’t apply missed fills",
      text: `${error.message} The bot is unchanged.`,
    };
  }
  return {
    kind: "message",
    tone: "error",
    title: "Couldn’t apply missed fills",
    text: `${error instanceof Error ? error.message : "unexpected error"}. The bot is unchanged.`,
  };
}

/** The heading and tone for a real result, by what it actually did. */
function summarise(result: MissedFillsResult): { tone: OutcomeTone; title: string; lead: string } {
  const applied = result.applied.length;
  const skipped = result.skipped.length;
  const fills = `${applied} ${applied === 1 ? "fill" : "fills"}`;
  const orders = `${skipped} ${skipped === 1 ? "order or fill" : "orders or fills"}`;

  if (applied > 0 && skipped === 0) {
    return {
      tone: "success",
      title: `Recorded ${fills}`,
      lead: "Every order this bot still believed open was read, and every execution the exchange reported is now recorded.",
    };
  }
  if (applied > 0) {
    return {
      tone: "warning",
      title: `Recorded ${fills}, ${orders} could not be applied`,
      lead: "This repair is INCOMPLETE. What was applied is listed below; so is what was not, with the backend's own reason for each.",
    };
  }
  if (skipped > 0) {
    return {
      tone: "warning",
      title: `Nothing recorded, ${orders} could not be applied`,
      lead: "No execution was applied. Every order is listed below with the reason it could not be read or could not be repaired.",
    };
  }
  return {
    tone: "info",
    title: "Nothing to apply",
    lead:
      "Every order the bot still believes open was read successfully, and the exchange reported no " +
      "execution that is not already recorded. Either the drift was already repaired (a second run " +
      "applies nothing) or the orders really are still resting.",
  };
}

function AppliedTable({ applied }: { applied: MissedFillsResult["applied"] }) {
  return (
    <div className="mt-2 overflow-x-auto rounded-md border border-zinc-700/60">
      <table className="w-full text-left text-xs">
        <thead className="bg-zinc-900/60 text-[10px] uppercase tracking-wide text-zinc-500">
          <tr>
            <th className="px-2 py-1.5 font-medium">Order</th>
            <th className="px-2 py-1.5 font-medium">Exchange fill id</th>
            <th className="px-2 py-1.5 text-right font-medium">Quantity</th>
            <th className="px-2 py-1.5 text-right font-medium">Price</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-zinc-800/70">
          {applied.map((fill) => (
            <tr key={`${fill.clientOrderId}:${fill.fillId}`}>
              <td className="tabular px-2 py-1.5 break-all text-zinc-300">{fill.clientOrderId}</td>
              <td className="tabular px-2 py-1.5 break-all text-zinc-300">{fill.fillId}</td>
              <td className="tabular px-2 py-1.5 text-right text-zinc-200">
                {formatQuantity(fill.quantity)}
              </td>
              <td className="tabular px-2 py-1.5 text-right text-zinc-200">
                {formatMoney(fill.price)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SkippedList({ skipped }: { skipped: readonly string[] }) {
  return (
    <div className="mt-3">
      <div className="text-xs font-medium uppercase tracking-wide text-amber-300/80">
        Not applied ({skipped.length})
      </div>
      <ul className="mt-1 space-y-1">
        {skipped.map((reason, index) => (
          <li
            key={`${index}:${reason}`}
            className="rounded border border-amber-500/20 bg-amber-500/5 px-2 py-1.5 text-xs break-words text-amber-100/90"
          >
            {reason}
          </li>
        ))}
      </ul>
      {/*
       * The distinction the backend draws deliberately, restated once so the
       * lines above are read correctly: a response with NO `trades` array means
       * the detail was not reported, which is not the same as "nothing filled".
       */}
      <p className="mt-1.5 text-[0.75rem] leading-snug text-amber-200/70">
        A line here means the drift on that order is still open. An order that could not be read, or
        whose response carried no per-fill detail, is reported as <em>unread</em>. That is not the
        same as “it did not fill”, and it is not safe to treat it as one. Reconciliation will keep
        raising the finding until it is genuinely resolved.
      </p>
    </div>
  );
}

/** The result banner: exactly what was corrected, never a generic "done". */
function ResultBanner({ result, isGrid }: { result: MissedFillsResult; isGrid: boolean }) {
  const { tone, title, lead } = summarise(result);
  const repairedGridRungs = isGrid && result.applied.length > 0;

  return (
    <div className={["mt-3 rounded-md border px-3 py-2 text-sm", OUTCOME_CLASS[tone]].join(" ")}>
      <div className="font-medium">{title}</div>
      <p className="mt-0.5 text-[0.8125rem] leading-snug opacity-90">{lead}</p>

      {result.applied.length > 0 && <AppliedTable applied={result.applied} />}
      {result.skipped.length > 0 && <SkippedList skipped={result.skipped} />}

      {repairedGridRungs && (
        <p className="mt-3 rounded border border-amber-500/25 bg-amber-500/5 px-2 py-1.5 text-[0.8125rem] leading-snug text-amber-100/90">
          <span className="font-medium">The ladder is now short those rungs.</span> No paired
          replacement sell was placed for any of the fills above, and none will be placed later;
          resuming this bot does not re-place them. Check the ladder below: each repaired level now
          shows the acquired base and its cost with an empty rung, which is the truth. Re-placing
          those levels is a separate, manual decision.
        </p>
      )}

      <p className="mt-3 text-[0.8125rem] leading-snug opacity-90">
        The bot is still <span className="font-medium">{result.status}</span>. This never changes a
        bot's status. Resuming stays a separate action. The repair is recorded in the audit log
        against your Access identity.
      </p>
    </div>
  );
}

/** The alerts that justify offering this action, shown so the reason is visible. */
function TriggeringAlerts({ alerts }: { alerts: readonly Alert[] }) {
  return (
    <div className="mt-2 space-y-1">
      {alerts.map((alert) => (
        <div
          key={alert.id}
          className="rounded border border-amber-500/25 bg-amber-500/5 px-2.5 py-1.5 text-xs"
        >
          <div className="flex flex-wrap items-center gap-2">
            <span className="tabular text-amber-300/90">{alert.alertType}</span>
            <span className="text-zinc-500">{formatTime(alert.createdAt)}</span>
          </div>
          <p className="mt-0.5 break-words text-zinc-300">{alert.message}</p>
        </div>
      ))}
    </div>
  );
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

  const isGrid = bot.strategy === "grid";
  const openOrders = bot.state?.openOrderIds.length ?? 0;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-black/60 p-4"
      onClick={submitting ? undefined : onCancel}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="apply-missed-fills-title"
        className="my-8 w-full max-w-lg rounded-xl border border-amber-500/40 bg-zinc-900 p-5 shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 id="apply-missed-fills-title" className="text-lg font-semibold text-amber-200">
          Apply missed fills?
        </h2>

        <div className="mt-3 space-y-3 text-sm text-zinc-300">
          <p>
            This re-reads the{" "}
            <span className="font-medium">
              {openOrders} {openOrders === 1 ? "order" : "orders"}
            </span>{" "}
            this bot still believes are open, and records every execution the exchange reports that
            this system does not already have. It uses the exchange's own fill ids, so running it
            twice cannot double-count anything.
          </p>

          {/*
           * The strategy-specific consequence -- the whole point of this dialog.
           * Not generic copy: what changes is genuinely different per strategy.
           */}
          {isGrid ? (
            <>
              <div className="rounded-md border border-zinc-700 bg-zinc-950/40 px-3 py-2 text-[0.8125rem]">
                <div className="font-medium text-zinc-200">What this writes</div>
                <p className="mt-0.5 text-zinc-400">
                  Each missed fill is recorded as a real trade, its grid level is marked filled, and
                  the ladder's held quantity and cost move by exactly what the exchange says
                  executed, through the same code the live fill path uses, with no separate
                  arithmetic.
                </p>
              </div>

              <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-[0.8125rem] text-amber-100">
                <div className="font-semibold">
                  The paired replacement sell will NOT be placed. Read this before confirming.
                </div>
                <p className="mt-1 leading-snug">
                  When a grid buy level fills normally, the bot immediately places a sell one rung
                  above it. That is how a grid recycles, and this repair suppresses that placement.
                  Every level repaired here comes back with the buy recorded and{" "}
                  <span className="font-semibold">its rung empty</span>, and nothing will fill that
                  gap later: the initial ladder is only ever placed once, so resuming this bot does
                  not re-place them either. The ladder will genuinely be short those rungs until you
                  re-place them by hand.
                </p>
                <p className="mt-2 leading-snug">
                  <span className="font-semibold">This is a deliberate safety choice, not an
                  oversight.</span>{" "}
                  Placing a live order from inside a correction endpoint, on a bot that may still be
                  halted, would put real orders on the exchange without the consent you withheld by
                  leaving it halted. That is resuming trading through the back door. A repair writes books;
                  it does not trade.
                </p>
                <p className="mt-2 leading-snug text-amber-200/80">
                  What it does leave is honest, not broken: no phantom order is created, so the
                  ladder afterwards shows the base you actually acquired, what it cost, and an empty
                  rung. All three are true.
                </p>
              </div>
            </>
          ) : (
            <div className="rounded-md border border-zinc-700 bg-zinc-950/40 px-3 py-2 text-[0.8125rem]">
              <div className="font-medium text-zinc-200">What this writes</div>
              <p className="mt-0.5 text-zinc-400">
                Each missed fill is recorded as a real trade and applied as an entry in this DCA
                cycle, so the held quantity, the cost, and the{" "}
                <span className="text-zinc-200">average entry price</span> are recalculated to
                include it, through the same code the live fill path uses, with no separate
                arithmetic. The take-profit target this cycle is measured against moves with that
                average.
              </p>
            </div>
          )}

          <ul className="list-disc space-y-1 pl-5 text-[0.8125rem] text-zinc-400">
            <li>
              The bot stays <span className="text-zinc-200">halted</span>. This never resumes
              anything, and it places no order of any kind.
            </li>
            <li>
              A success does not mean everything was repaired: an order the exchange cannot be read
              for is reported back as unread rather than assumed unfilled. You will see exactly what
              was and was not applied.
            </li>
            <li>The action is recorded in the audit log against your Access identity.</li>
          </ul>
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
            className="inline-flex items-center gap-2 rounded-md bg-amber-600 px-3 py-2 text-sm font-semibold text-white hover:bg-amber-500 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {submitting && (
              <span
                className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/40 border-t-white"
                aria-hidden
              />
            )}
            {submitting ? "Applying…" : "Apply missed fills"}
          </button>
        </div>
      </div>
    </div>
  );
}

export function ApplyMissedFillsAction({
  bot,
  onApplied,
}: {
  bot: BotDetail;
  /** Force an immediate refetch after an attempt that may have written. */
  onApplied: () => void;
}) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const sectionRef = useRef<HTMLElement>(null);
  const { hash } = useLocation();

  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const driftAlerts = openDriftAlerts(bot.alerts);
  const hasOpenDrift = driftAlerts.length > 0;
  const isHalted = bot.status === "halted";
  const isGrid = bot.strategy === "grid";

  // An alert row in the feed links here with this hash (the natural path: see an
  // alert, act on it). Scroll it into view -- but deliberately do NOT open the
  // dialog from a URL: a confirmation that a link can open is not a confirmation.
  const anchored = hash === `#${APPLY_MISSED_FILLS_ANCHOR}`;
  useEffect(() => {
    if (anchored && hasOpenDrift) {
      sectionRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  }, [anchored, hasOpenDrift]);

  async function confirm() {
    if (submitting) return; // double-click guard
    setSubmitting(true);
    try {
      const response = await applyMissedFills(bot.id);
      if (!mounted.current) return;
      setOutcome({ kind: "result", result: response.result });
      setDialogOpen(false);
      // Refresh immediately: the orders, trades and position below have just
      // changed, and the whole value of this control is seeing that they did.
      onApplied();
    } catch (error) {
      if (!mounted.current) return;
      const failure = outcomeForError(error);
      setOutcome(failure);
      setDialogOpen(false);
      // A dropped request may still have written. Refresh so the history below
      // shows whatever actually landed, rather than leaving a stale view under
      // an "outcome unknown" banner.
      if (error instanceof ApiError && (error.code === "network_error" || error.code === "bad_response")) {
        onApplied();
      }
    } finally {
      if (mounted.current) setSubmitting(false);
    }
  }

  // No open drift finding and no lingering outcome: this action has no business
  // being on the page at all.
  if (!hasOpenDrift && outcome === null) return null;

  return (
    <section
      ref={sectionRef}
      id={APPLY_MISSED_FILLS_ANCHOR}
      className={[
        "rounded-lg border px-4 py-3",
        anchored ? "border-amber-400/60 bg-amber-500/[0.07]" : "border-amber-500/20 bg-amber-500/[0.03]",
      ].join(" ")}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-medium text-amber-200">Apply missed fills</div>
          <p className="mt-0.5 text-xs text-zinc-500">
            This bot has {driftAlerts.length === 1 ? "an open" : `${driftAlerts.length} open`}{" "}
            order-state-drift {driftAlerts.length === 1 ? "finding" : "findings"}: the exchange and
            this system disagree about an order. Reconciliation never corrects that on its own; it
            halts and waits for a person.
          </p>
        </div>
        {hasOpenDrift && isHalted && (
          <button
            type="button"
            onClick={() => setDialogOpen(true)}
            className="shrink-0 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm font-semibold text-amber-200 hover:bg-amber-500/20"
          >
            Apply missed fills
          </button>
        )}
      </div>

      {hasOpenDrift && <TriggeringAlerts alerts={driftAlerts} />}

      {/*
       * Brief item 3: the same refusal the backend makes, made before the
       * request rather than after it. A drift finding on a bot that is not
       * halted is a real state -- a reconciliation halt that failed, or a bot
       * resumed with the incident still open -- so the panel stays and explains,
       * instead of offering a button that could only ever return 409.
       */}
      {hasOpenDrift && !isHalted && (
        <div className="mt-2 rounded-md border border-zinc-700 bg-zinc-900/60 px-3 py-2 text-[0.8125rem] text-zinc-300">
          <div className="font-medium text-zinc-200">
            Can’t repair a bot that is {bot.status}
          </div>
          <p className="mt-0.5 leading-snug text-zinc-400">
            Missed fills can only be applied to a <span className="text-zinc-200">halted</span> bot,
            and the backend refuses anything else. A repair writes trades and moves the position
            while the bot's own pipeline may be doing the same thing on the next candle; the two
            would race, and the books are exactly what is already in doubt. Halt this bot, or let
            reconciliation halt it, and the action will appear here.
          </p>
        </div>
      )}

      {outcome !== null &&
        (outcome.kind === "result" ? (
          <ResultBanner result={outcome.result} isGrid={isGrid} />
        ) : (
          <div className={["mt-3 rounded-md border px-3 py-2 text-sm", OUTCOME_CLASS[outcome.tone]].join(" ")}>
            <div className="font-medium">{outcome.title}</div>
            <p className="mt-0.5 text-[0.8125rem] leading-snug opacity-90">{outcome.text}</p>
          </div>
        ))}

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
