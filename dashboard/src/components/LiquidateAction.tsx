/**
 * The liquidate-position control on the bot detail view (this session's brief).
 *
 * A halted bot that still holds a position can be closed out by a human through
 * the unified `liquidatePosition` backend built at step 10.3: cancel any open
 * orders, place a marketable limit sell at the current price, and STAY halted
 * afterwards. This is the only UI that reaches that endpoint.
 *
 * WHAT THIS RENDERS AND WHEN (brief items 1, 6)
 * ---------------------------------------------
 * The trigger button appears ONLY when the bot is halted (enforced by the
 * caller) AND holds a position greater than zero. A halted-but-flat bot has
 * nothing to liquidate, so per the brief's "if it's not a valid action, don't
 * render it at all" the button is simply absent -- never shown-but-disabled.
 * The button and dialog carry the established danger styling (solid red on the
 * point of no return) because this is a real, irreversible order once live funds
 * are involved.
 *
 * THE CONFIRMATION (brief item 2)
 * -------------------------------
 * Clicking opens a plain yes/no dialog (NOT the type-to-confirm pattern, which
 * is reserved for the global kill switch). It names the real position -- the
 * actual base asset and amount, not a generic message -- and states plainly that
 * the sell is a limit order at market price and the bot remains halted.
 *
 * THE OUTCOMES (brief item 3)
 * ---------------------------
 * Every real backend outcome gets a distinct message. The subtlety is that the
 * price-unusable case is NOT an error: `liquidatePosition` returns a 200 with
 * `result.action: "no_price"` after alerting and leaving the position held. So
 * a success is inspected by `result.action`; the thrown `ApiError` paths
 * (`invalid_status`, `not_attached`, everything else) are mapped by code.
 *
 * After a successful response the caller's `onLiquidated` refetches immediately
 * (brief item 4) so the refreshed position shows without waiting for the poll.
 * While a request is in flight both dialog buttons are disabled and the confirm
 * button shows a loading state, so a double-click cannot fire two requests
 * (brief item 5).
 */

import { useEffect, useRef, useState } from "react";
import { ApiError, liquidateBot } from "../api/client";
import type { BotDetail } from "../api/types";
import { baseAssetOf, formatQuantity, signOf } from "../format";

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

/** Map a successful `{ result }` to its distinct, honest message. */
function outcomeForResult(action: string, amount: string, asset: string): Outcome {
  switch (action) {
    case "liquidating":
      return {
        tone: "success",
        title: "Liquidation order placed",
        text:
          `A limit sell of ${amount} ${asset} was placed at the current market price. The bot stays ` +
          `halted. The order is usually marketable, but on a fast move it may rest until it fills. ` +
          `Watch this bot's order history and alerts to confirm it completed.`,
      };
    case "no_price":
      return {
        tone: "warning",
        title: "Nothing sold: no current price",
        text:
          `A current price could not be read, so nothing was sold. The position (${amount} ${asset}) is ` +
          `still held on the halted bot and a critical alert was raised. Try again once the exchange is ` +
          `reachable.`,
      };
    case "nothing_to_liquidate":
      return {
        tone: "info",
        title: "Nothing to liquidate",
        text: "The position is already flat, so there was nothing to sell.",
      };
    case "hold":
      return {
        tone: "info",
        title: "An exit order is already live",
        text:
          "A liquidation or exit sell is already resting for this bot, so no second order was placed.",
      };
    default:
      // A success shape we did not enumerate. Honest rather than silent.
      return {
        tone: "info",
        title: "Liquidation acknowledged",
        text: `The bot reported "${action}".`,
      };
  }
}

/** Map a thrown `ApiError` (or any error) to its distinct message. */
function outcomeForError(error: unknown): Outcome {
  if (error instanceof ApiError) {
    if (error.code === "invalid_status") {
      return {
        tone: "error",
        title: "Bot is no longer halted",
        text:
          "This bot is not halted anymore; it may have resumed since the page loaded. Liquidation only " +
          "applies to a halted bot, and nothing was sold. The view will refresh to its current state.",
      };
    }
    if (error.code === "not_attached") {
      return {
        tone: "error",
        title: "No exchange connection",
        text:
          "This environment has no exchange credentials wired yet, so the position cannot be sold. " +
          "This is expected until live keys are configured; nothing was sold.",
      };
    }
    if (error.code === "unauthenticated") {
      return {
        tone: "error",
        title: "Session expired",
        text: "Your Cloudflare Access session has expired. Reload to sign in again. Nothing was sold.",
      };
    }
    return {
      tone: "error",
      title: "Liquidation failed",
      text: `${error.message} Nothing was sold.`,
    };
  }
  return {
    tone: "error",
    title: "Liquidation failed",
    text: `${error instanceof Error ? error.message : "unexpected error"}. Nothing was sold.`,
  };
}

function ConfirmDialog({
  amount,
  asset,
  pair,
  submitting,
  onConfirm,
  onCancel,
}: {
  amount: string;
  asset: string;
  pair: string;
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
        aria-labelledby="liquidate-title"
        className="w-full max-w-md rounded-xl border border-red-500/40 bg-zinc-900 p-5 shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 id="liquidate-title" className="text-lg font-semibold text-red-200">
          Liquidate this position?
        </h2>

        <div className="mt-3 rounded-lg border border-red-500/20 bg-red-500/5 px-3 py-2">
          <div className="text-xs font-medium uppercase tracking-wide text-red-300/80">
            Position to sell
          </div>
          <div className="tabular mt-0.5 text-xl font-semibold text-zinc-100">
            {amount} {asset}
          </div>
          <div className="text-xs text-zinc-500">{pair}</div>
        </div>

        <div className="mt-3 space-y-2 text-sm text-zinc-300">
          <p>
            This sells the entire held position as a <span className="font-medium">limit order at the
            current market price</span>. The bot <span className="font-medium">stays halted</span>{" "}
            afterwards. Liquidating does not resume it or release its capital.
          </p>
          <p className="text-red-300">
            This is a real, irreversible order once live funds are involved.
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
            className="inline-flex items-center gap-2 rounded-md bg-red-600 px-3 py-2 text-sm font-semibold text-white hover:bg-red-500 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {submitting && (
              <span
                className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/40 border-t-white"
                aria-hidden
              />
            )}
            {submitting ? "Liquidating…" : "Liquidate position"}
          </button>
        </div>
      </div>
    </div>
  );
}

export function LiquidateAction({
  bot,
  onLiquidated,
}: {
  bot: BotDetail;
  /** Force an immediate refetch of the bot after a successful response. */
  onLiquidated: () => void;
}) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  // Guard state writes after unmount: a successful liquidation triggers a
  // refetch that can hide this component (position drops to zero), and a
  // resumed bot removes it from the halted-only caller entirely.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const held = bot.position?.heldQuantity ?? "0";
  const canLiquidate = signOf(held) === "positive";
  const asset = baseAssetOf(bot.pair, bot.capitalAsset);
  // A quantity, not money: this is the base-asset amount that would be SOLD, so
  // it keeps its exact (trimmed) precision rather than being rounded to cents.
  const amount = formatQuantity(held);

  async function confirm() {
    if (submitting) return; // double-click guard (brief item 5)
    setSubmitting(true);
    try {
      const { result } = await liquidateBot(bot.id);
      if (!mounted.current) return;
      setOutcome(outcomeForResult(result.action, amount, asset));
      setDialogOpen(false);
      // A successful response is the one case we refresh immediately (item 4);
      // errors fall through to the existing 5s poll so their banner persists.
      onLiquidated();
    } catch (error) {
      if (!mounted.current) return;
      setOutcome(outcomeForError(error));
      setDialogOpen(false);
    } finally {
      if (mounted.current) setSubmitting(false);
    }
  }

  // Nothing to show: no live action and no lingering outcome.
  if (!canLiquidate && outcome === null) return null;

  return (
    <section className="rounded-lg border border-red-500/20 bg-red-500/[0.03] px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-medium text-red-200">Liquidate position</div>
          <p className="mt-0.5 text-xs text-zinc-500">
            Sell the held position at market and leave the bot halted. Irreversible once live.
          </p>
        </div>
        {canLiquidate && (
          <button
            type="button"
            onClick={() => setDialogOpen(true)}
            className="shrink-0 rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm font-semibold text-red-200 hover:bg-red-500/20"
          >
            Liquidate position
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
          amount={amount}
          asset={asset}
          pair={bot.pair}
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
