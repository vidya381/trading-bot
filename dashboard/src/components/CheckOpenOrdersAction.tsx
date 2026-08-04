/**
 * The manual open-order observation control on the bot detail view.
 *
 * The UI for `POST /api/bots/:id/check-open-orders` (step 22), which exposes a
 * pass that has existed since step 19 and been on a 30-second alarm since step
 * 20, but has been reachable only by the alarm and the test suite.
 *
 * WHY A BUTTON FOR SOMETHING A TIMER ALREADY DOES
 * ----------------------------------------------
 * Precisely because the timer may not be doing it. The two conditions that put
 * this control in front of an operator both mean the SCHEDULED path has stopped
 * working:
 *
 *   - `poll_blind` -- five consecutive passes could not read this bot's open
 *     orders; the poll has backed off to one attempt every five minutes.
 *   - `price_updates_stale` -- this running bot has had no live price for over
 *     ten minutes, against a measured feed cadence of one closed candle every
 *     35-70 seconds.
 *
 * Without a manual trigger the operator's only move on either is to wait for a
 * backed-off timer and hope. This is the natural first move instead: it costs
 * one order-status read per open order at routine priority (it can never draw
 * on the slice reserved for getting OUT of a position), and it answers the only
 * question that matters -- are this bot's books actually current.
 *
 * WHEN IT RENDERS, AND WHY THAT GATE DIFFERS FROM ITS NEIGHBOUR
 * -----------------------------------------------------------
 * `ApplyMissedFillsAction` is gated on an open drift FINDING, because it writes
 * trades to correct a belief the system has just proved wrong, and section 9's
 * whole stance is that such a correction needs a human acting on a specific
 * finding. This one is gated on capability instead -- the bot has open orders
 * and is not stopped -- for two reasons:
 *
 *   1. It re-derives what is true right now rather than acting on a stored
 *      belief, and it is the SAME pass the alarm has been running unattended
 *      every 30 seconds. A human pressing it introduces no operation the system
 *      was not already performing.
 *   2. It is needed exactly when no finding exists to gate on. A blind poll
 *      raises `poll_blind`, not a drift alert -- and gating a recovery control
 *      on the machinery that is broken is the silent-gap failure this codebase
 *      refuses everywhere else.
 *
 * A bot with no open orders shows nothing: the pass would read zero orders and
 * report nothing, and a button whose only outcome is "nothing to do" teaches an
 * operator to distrust the page. A `stopped` bot is refused by the backend
 * outright (its capital is released), so it shows nothing either.
 *
 * IT IS NOT READ-ONLY, AND THE DIALOG SAYS SO
 * -------------------------------------------
 * On a RUNNING GRID bot, a buy this pass folds in places its paired replacement
 * sell -- the grid recycling exactly as it would on a pushed fill, because step
 * 19 derives `placeReplacement` from `status === "running"` rather than
 * hardcoding it. That is correct behaviour and it is also a live order going to
 * the exchange from a button labelled "check", which is precisely the kind of
 * thing an operator must be told before they press it, not after. Its sibling
 * control passes `placeReplacement: false` unconditionally, so the two genuinely
 * differ here and the dialog states which one this is.
 *
 * THE OUTCOMES
 * ------------
 * A 200 is not a clean bill of health, so this never renders a generic "done".
 * Five shapes are distinguished from the real result -- and `deferred` is one of
 * them, deliberately: a pass that stood aside for a concurrent one (step 21's
 * one-way yield) returns three empty arrays, which is indistinguishable from a
 * clean pass unless the flag is read. "I did not look" is a very different
 * answer from "your books are up to date", and the honest response is to try
 * again, which is always safe.
 */

import { useEffect, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import { ApiError, checkOpenOrders } from "../api/client";
import type { Alert, BotDetail, OrderCheckResult } from "../api/types";
import { formatMoney, formatQuantity, formatTime } from "../format";
import { CHECK_OPEN_ORDERS_ANCHOR, openPollAlerts } from "../pollAlerts";

type OutcomeTone = "success" | "warning" | "info" | "error";

const OUTCOME_CLASS: Record<OutcomeTone, string> = {
  success: "border-emerald-500/30 bg-emerald-500/5 text-emerald-200",
  warning: "border-amber-500/30 bg-amber-500/5 text-amber-200",
  info: "border-zinc-700 bg-zinc-900/40 text-zinc-300",
  error: "border-red-500/30 bg-red-500/5 text-red-200",
};

/** A finished attempt: either the backend's own result, or an error message. */
type Outcome =
  | { readonly kind: "result"; readonly result: OrderCheckResult }
  | { readonly kind: "message"; readonly tone: OutcomeTone; readonly title: string; readonly text: string };

/** Map a thrown `ApiError` (or any error) to its distinct, honest message. */
function outcomeForError(error: unknown): Outcome {
  if (error instanceof ApiError) {
    if (error.code === "invalid_status") {
      return {
        kind: "message",
        tone: "error",
        title: "This bot has been stopped",
        text:
          "A stopped bot has no open orders to check — its capital has already been released back " +
          "to the ledger, so a pass would be work whose result nothing may use. Nothing was " +
          "written. This most likely means the bot was closed since this page loaded.",
      };
    }
    if (error.code === "not_attached") {
      return {
        kind: "message",
        tone: "error",
        title: "No exchange client in this environment",
        text:
          `${error.message} The pass reads the exchange to find out what the orders actually did, ` +
          "so it cannot run at all here. Nothing was written and the bot is unchanged.",
      };
    }
    if (error.code === "not_created") {
      return {
        kind: "message",
        tone: "error",
        title: "This bot object holds no state",
        text:
          `${error.message} There is a database row but no live object behind it, so there are no ` +
          "open orders to read. Nothing was written.",
      };
    }
    if (error.code === "unauthenticated") {
      return {
        kind: "message",
        tone: "error",
        title: "Session expired",
        text:
          "Your Cloudflare Access session has expired — reload to sign in again. Nothing was written.",
      };
    }
    if (error.code === "network_error" || error.code === "bad_response") {
      return {
        kind: "message",
        tone: "warning",
        title: "Outcome unknown — couldn’t confirm",
        text:
          `${error.message}. The request may or may not have reached the bot, so a fill may already ` +
          "have been recorded. Running this again is SAFE: applied fills deduplicate on the " +
          "exchange's own ids, so one that already landed is not applied twice.",
      };
    }
    return {
      kind: "message",
      tone: "error",
      title: "Couldn’t check open orders",
      text: `${error.message} The bot is unchanged.`,
    };
  }
  return {
    kind: "message",
    tone: "error",
    title: "Couldn’t check open orders",
    text: `${error instanceof Error ? error.message : "unexpected error"}. The bot is unchanged.`,
  };
}

/** The heading and tone for a real result, by what the pass actually did. */
function summarise(result: OrderCheckResult): { tone: OutcomeTone; title: string; lead: string } {
  // FIRST, because it is the one outcome that looks like every other empty one.
  if (result.deferred) {
    return {
      tone: "info",
      title: "Didn’t look — another pass was already running",
      lead:
        "This pass stood aside rather than reading the books underneath something that was already " +
        "changing them (a price update, a halt, or a fill arriving). Nothing was read and nothing " +
        "was written, so this is NOT a statement that the books are fine. Try again in a moment.",
    };
  }

  const applied = result.applied.length;
  const skipped = result.skipped.length;
  const closed = result.closed.length;
  const fills = `${applied} ${applied === 1 ? "fill" : "fills"}`;
  const orders = `${skipped} ${skipped === 1 ? "order" : "orders"}`;

  if (skipped > 0 && applied === 0 && closed === 0) {
    return {
      tone: "warning",
      title: `Nothing recorded — ${orders} could not be accounted for`,
      lead:
        "The books are still behind the exchange. Each order is listed below with the backend's own " +
        "reason: either it could not be read at all, or it was read and this pass deliberately " +
        "refused to act on it.",
    };
  }
  if (skipped > 0) {
    return {
      tone: "warning",
      title: `Recorded ${fills} — ${orders} could not be accounted for`,
      lead: "This pass is INCOMPLETE. What moved is listed below; so is what did not, with the reason for each.",
    };
  }
  if (applied > 0 || closed > 0) {
    return {
      tone: "success",
      title:
        applied > 0
          ? `Recorded ${fills}${closed > 0 ? ` and closed ${closed}` : ""}`
          : `Closed ${closed} ${closed === 1 ? "order" : "orders"}`,
      lead:
        "Every order this bot believed open was read, and the exchange's record is now reflected here. " +
        "The position, orders and trades below have moved.",
    };
  }
  return {
    tone: "success",
    title: "Books are current",
    lead:
      "Every order this bot believes open was read successfully, and the exchange reported nothing " +
      "this system does not already have. The orders really are still resting.",
  };
}

function AppliedTable({ applied }: { applied: OrderCheckResult["applied"] }) {
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

/** The result banner: exactly what the pass did, never a generic "done". */
function ResultBanner({ result, isGrid }: { result: OrderCheckResult; isGrid: boolean }) {
  const { tone, title, lead } = summarise(result);
  const placedReplacements = isGrid && result.status === "running" && result.applied.length > 0;

  return (
    <div className={["mt-3 rounded-md border px-3 py-2 text-sm", OUTCOME_CLASS[tone]].join(" ")}>
      <div className="font-medium">{title}</div>
      <p className="mt-0.5 text-[0.8125rem] leading-snug opacity-90">{lead}</p>

      {result.applied.length > 0 && <AppliedTable applied={result.applied} />}

      {result.closed.length > 0 && (
        <div className="mt-3">
          <div className="text-xs font-medium uppercase tracking-wide text-zinc-400">
            Closed to match the exchange ({result.closed.length})
          </div>
          <ul className="mt-1 space-y-1">
            {result.closed.map((id) => (
              <li key={id} className="tabular rounded border border-zinc-700 bg-zinc-900/50 px-2 py-1.5 text-xs break-all text-zinc-300">
                {id}
              </li>
            ))}
          </ul>
          <p className="mt-1.5 text-[0.75rem] leading-snug text-zinc-400">
            These ended cancelled, expired or rejected on the exchange and this system still believed
            them open. An order is only ever closed here when the filled quantities agree — one that
            ended with more filled than was recorded is left open and reported below instead, because
            a terminal order can never accept the missing fill afterwards.
          </p>
        </div>
      )}

      {result.skipped.length > 0 && (
        <div className="mt-3">
          <div className="text-xs font-medium uppercase tracking-wide text-amber-300/80">
            Not accounted for ({result.skipped.length})
          </div>
          <ul className="mt-1 space-y-1">
            {result.skipped.map((reason, index) => (
              <li
                key={`${index}:${reason}`}
                className="rounded border border-amber-500/20 bg-amber-500/5 px-2 py-1.5 text-xs break-words text-amber-100/90"
              >
                {reason}
              </li>
            ))}
          </ul>
          <p className="mt-1.5 text-[0.75rem] leading-snug text-amber-200/70">
            Two different things live in this list and the backend words them differently on purpose:
            an order it could not READ (an unreachable venue is never treated as “nothing filled”),
            and an order it read and then deliberately REFUSED to act on — a fill with no real
            exchange id behind it, or one the order state machine would not accept. The second kind
            is now recorded in the audit log as well.
          </p>
        </div>
      )}

      {placedReplacements && (
        <p className="mt-3 rounded border border-sky-500/25 bg-sky-500/5 px-2 py-1.5 text-[0.8125rem] leading-snug text-sky-100/90">
          <span className="font-medium">Paired replacement sells were placed.</span> This bot is a
          running grid, so each buy folded in above recycled its rung exactly as it would have on a
          live fill. That is the grid working normally — but it does mean real orders went to the
          exchange from this action. Check the ladder and order history below.
        </p>
      )}

      <p className="mt-3 text-[0.8125rem] leading-snug opacity-90">
        The bot is <span className="font-medium">{result.status}</span> — this never changes a bot's
        status. The pass is recorded in the audit log against your Access identity whenever it moved
        or refused something.
      </p>
    </div>
  );
}

/** The poll-health alerts that make this control urgent, shown so the reason is visible. */
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

  const openOrders = bot.state?.openOrderIds.length ?? 0;
  // The one case where this places live orders. Both halves matter: a halted
  // grid folds the fill and places nothing.
  const willPlaceReplacements = bot.strategy === "grid" && bot.status === "running";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-black/60 p-4"
      onClick={submitting ? undefined : onCancel}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="check-open-orders-title"
        className="my-8 w-full max-w-lg rounded-xl border border-sky-500/40 bg-zinc-900 p-5 shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 id="check-open-orders-title" className="text-lg font-semibold text-sky-200">
          Check open orders now?
        </h2>

        <div className="mt-3 space-y-3 text-sm text-zinc-300">
          <p>
            This asks the exchange what actually happened to the{" "}
            <span className="font-medium">
              {openOrders} {openOrders === 1 ? "order" : "orders"}
            </span>{" "}
            this bot believes are still resting, and folds in any execution this system has not seen.
            It is the same pass that normally runs by itself every 30 seconds — running it now is
            what helps when that automatic pass has backed off or gone blind.
          </p>

          {willPlaceReplacements ? (
            <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-[0.8125rem] text-amber-100">
              <div className="font-semibold">
                This can place real orders. Read this before confirming.
              </div>
              <p className="mt-1 leading-snug">
                This bot is a <span className="font-semibold">running grid</span>. If a buy level
                turns out to have filled while resting, the bot will place the paired sell one rung
                above it, exactly as it would have the moment the fill arrived — that is how a grid
                recycles, and suppressing it here would leave the ladder silently short a rung.
              </p>
              <p className="mt-2 leading-snug text-amber-200/80">
                This is the opposite choice from “Apply missed fills”, which never places anything.
                That one repairs a halted bot's books without resuming trading; this one is the
                bot's normal observation, and a running bot acting on what it observes is the point.
                Halt the bot first if you want the fills recorded without any order being placed.
              </p>
            </div>
          ) : (
            <div className="rounded-md border border-zinc-700 bg-zinc-950/40 px-3 py-2 text-[0.8125rem]">
              <div className="font-medium text-zinc-200">What this writes</div>
              <p className="mt-0.5 text-zinc-400">
                Any execution the exchange reports that this system does not already have is recorded
                as a real trade and applied to the position, through the same code a live fill takes.
                Orders that ended cancelled or expired on the exchange are closed to match.{" "}
                {bot.status === "halted"
                  ? "This bot is halted, so no order will be placed."
                  : "No replacement order arises for this strategy."}
              </p>
            </div>
          )}

          <ul className="list-disc space-y-1 pl-5 text-[0.8125rem] text-zinc-400">
            <li>
              It uses the exchange's own fill ids, so running it twice cannot double-count anything.
            </li>
            <li>
              It never changes the bot's <span className="text-zinc-200">status</span>, and it never
              resumes a halted bot.
            </li>
            <li>
              A success does not mean the books are clean: an order that cannot be read is reported
              as unread rather than assumed unfilled, and you will see exactly what was and was not
              accounted for.
            </li>
            <li>
              It reads at <span className="text-zinc-200">routine</span> priority, so it cannot eat
              into the rate-limit budget reserved for getting out of a position.
            </li>
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
            className="inline-flex items-center gap-2 rounded-md bg-sky-600 px-3 py-2 text-sm font-semibold text-white hover:bg-sky-500 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {submitting && (
              <span
                className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/40 border-t-white"
                aria-hidden
              />
            )}
            {submitting ? "Checking…" : "Check open orders"}
          </button>
        </div>
      </div>
    </div>
  );
}

export function CheckOpenOrdersAction({
  bot,
  onChecked,
}: {
  bot: BotDetail;
  /** Force an immediate refetch after an attempt that may have written. */
  onChecked: () => void;
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

  const pollAlerts = openPollAlerts(bot.alerts);
  const hasPollAlert = pollAlerts.length > 0;
  const openOrders = bot.state?.openOrderIds.length ?? 0;
  // The backend's own gate, mirrored: `stopped` is refused outright, and a bot
  // with nothing resting would read zero orders and report nothing.
  const canCheck = bot.status !== "stopped" && openOrders > 0;

  const anchored = hash === `#${CHECK_OPEN_ORDERS_ANCHOR}`;
  useEffect(() => {
    // Deliberately do NOT open the dialog from a URL: a confirmation a link can
    // open is not a confirmation.
    if (anchored && canCheck) {
      sectionRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  }, [anchored, canCheck]);

  async function confirm() {
    if (submitting) return; // double-click guard
    setSubmitting(true);
    try {
      const response = await checkOpenOrders(bot.id);
      if (!mounted.current) return;
      setOutcome({ kind: "result", result: response.result });
      setDialogOpen(false);
      // The orders, trades and position below may have just changed, and seeing
      // that they did is most of the value of running this.
      onChecked();
    } catch (error) {
      if (!mounted.current) return;
      setOutcome(outcomeForError(error));
      setDialogOpen(false);
      if (error instanceof ApiError && (error.code === "network_error" || error.code === "bad_response")) {
        onChecked();
      }
    } finally {
      if (mounted.current) setSubmitting(false);
    }
  }

  // Nothing to check and nothing to report: this control has no business on the
  // page at all.
  if (!canCheck && outcome === null) return null;

  return (
    <section
      ref={sectionRef}
      id={CHECK_OPEN_ORDERS_ANCHOR}
      className={[
        "rounded-lg border px-4 py-3",
        hasPollAlert || anchored
          ? "border-amber-400/50 bg-amber-500/[0.06]"
          : "border-zinc-800 bg-zinc-900/30",
      ].join(" ")}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className={["text-sm font-medium", hasPollAlert ? "text-amber-200" : "text-zinc-200"].join(" ")}>
            Check open orders
          </div>
          <p className="mt-0.5 text-xs text-zinc-500">
            {hasPollAlert ? (
              <>
                This bot's automatic 30-second check is{" "}
                <span className="text-amber-300/90">not working</span>
                {pollAlerts.length > 1 ? ` (${pollAlerts.length} open findings)` : ""}. Until it
                recovers, a fill on a resting order reaches this bot's position through nothing at
                all. Running the pass by hand is the first thing worth trying.
              </>
            ) : (
              <>
                Ask the exchange what happened to the {openOrders}{" "}
                {openOrders === 1 ? "order" : "orders"} this bot believes are resting, without
                waiting for the next automatic pass.
              </>
            )}
          </p>
        </div>
        {canCheck && (
          <button
            type="button"
            onClick={() => setDialogOpen(true)}
            className={[
              "shrink-0 rounded-md border px-3 py-2 text-sm font-semibold",
              hasPollAlert
                ? "border-amber-500/40 bg-amber-500/10 text-amber-200 hover:bg-amber-500/20"
                : "border-zinc-700 bg-zinc-800/60 text-zinc-200 hover:bg-zinc-800",
            ].join(" ")}
          >
            Check now
          </button>
        )}
      </div>

      {hasPollAlert && <TriggeringAlerts alerts={pollAlerts} />}

      {outcome !== null &&
        (outcome.kind === "result" ? (
          <ResultBanner result={outcome.result} isGrid={bot.strategy === "grid"} />
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
