/**
 * The manual-adjustment form (this session's brief; the LAST piece of spec step
 * 10). The dashboard's fourth write surface, after liquidate (10.9), the kill
 * switch (10.10) and create-bot (10.11), and it reuses their two conventions: a
 * `submitting` guard + disabled/spinner button so a double-click cannot log two
 * adjustments (brief item 5), and honest, DISTINCT error handling keyed on the
 * backend's typed error code rather than prose (brief item 3).
 *
 * WHY THIS EXISTS (spec 8.6)
 * -------------------------
 * When the account owner moves funds on the exchange OUTSIDE the bot -- a deposit
 * or a withdrawal -- they log it here so the reconciliation job can subtract it
 * from any detected discrepancy before deciding whether to alert (section 9).
 * Logging it FIRST is the point: an un-logged withdrawal reads as an unexplained
 * balance drop, which is exactly the "severe drift" reconciliation escalates.
 *
 * THE SIGN CONVENTION IS MADE UNAMBIGUOUS, NOT REMEMBERED (brief item 2)
 * --------------------------------------------------------------------
 * The backend's `amount` is signed (negative = withdrawal). Rather than ask
 * anyone to type a minus, the form takes an explicit Deposit/Withdrawal choice
 * plus an UNSIGNED magnitude, and builds the signed string itself. The sign is
 * shown three ways -- the chosen direction, its colour, and a live preview of the
 * exact value that will be logged -- so it is never a fact to recall.
 *
 * WHAT IT SENDS (`POST /api/manual-adjustments`, `logManualAdjustment`)
 * -------------------------------------------------------------------
 * `{ accountLabel, asset, amount, note }`, all required. This endpoint is the
 * simplest write in the system: it just inserts the row and a paired audit-log
 * entry -- no capital-ledger check, no exchange call -- so a brand-new account
 * label works and there is no state-dependent refusal to handle.
 *
 * NO READ ENDPOINT, SO NO LIST (brief item 4)
 * -------------------------------------------
 * There is deliberately no `GET /api/manual-adjustments`. So this page does NOT
 * keep a client-side history of adjustments; it shows the honest single-action
 * confirmation from the 201 response (the server's own saved record) and nothing
 * more. The missing read endpoint is recorded as an open question, not worked
 * around. One consequence, surfaced honestly below: with no idempotency key and
 * no way to read back, a blind resubmit after a lost response risks a duplicate.
 */

import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { ApiError, fetchBots, logManualAdjustment } from "../api/client";
import type { Bot, ManualAdjustment as ManualAdjustmentRow } from "../api/types";
import { formatDateTime, formatQuantity } from "../format";

// ---------------------------------------------------------------------------
// Validation -- pure string checks, no float ever constructed. The decimal
// grammar mirrors the backend's money parser (src/shared/money.ts): digits,
// optional single dot, at most 8 fractional places. Unsigned here on purpose --
// the sign comes from the Deposit/Withdrawal choice, never from the amount text.
// ---------------------------------------------------------------------------

const DECIMAL = /^\d+(\.\d{1,8})?$/;

type Direction = "deposit" | "withdrawal";
type Errors = Record<string, string>;

function validate(
  accountLabel: string,
  asset: string,
  direction: Direction | null,
  magnitude: string,
  note: string,
): Errors {
  const errors: Errors = {};
  if (accountLabel.trim() === "") errors.accountLabel = "Required.";
  if (asset.trim() === "") errors.asset = "Required.";
  if (direction === null) errors.direction = "Choose deposit or withdrawal.";

  const amount = magnitude.trim();
  if (amount === "") errors.amount = "Required.";
  else if (!DECIMAL.test(amount)) errors.amount = "Enter a number (up to 8 decimal places).";
  // A zero deposit/withdrawal records no movement -- always invalid, the same
  // category as a non-numeric amount (brief item 3 allows only always-invalid
  // client checks). The backend would accept "0"; a client-side non-zero rule
  // here is not ledger-dependent guessing, it is "there is no amount to log".
  else if (!/[1-9]/.test(amount)) errors.amount = "Must be greater than zero.";

  // Note is REQUIRED by the backend (requireString) and by section 8.6, so it is
  // enforced here too -- a manual adjustment with no explanation is the thing
  // reconciliation will later have to make sense of.
  if (note.trim() === "") errors.note = "Required — say what this movement was.";
  return errors;
}

/** Build the SIGNED decimal string the backend expects from the explicit
 *  direction and the unsigned magnitude. A withdrawal is negated; a deposit is
 *  sent as-is (the money parser accepts a bare positive). */
function signedAmount(direction: Direction, magnitude: string): string {
  const trimmed = magnitude.trim();
  return direction === "withdrawal" ? `-${trimmed}` : trimmed;
}

// ---------------------------------------------------------------------------
// Backend-error -> honest, distinct message (brief item 3)
// ---------------------------------------------------------------------------

type OutcomeTone = "success" | "error" | "warning";

interface Outcome {
  readonly tone: OutcomeTone;
  readonly title: string;
  readonly body: ReactNode;
}

const OUTCOME_CLASS: Record<OutcomeTone, string> = {
  success: "border-emerald-500/40 bg-emerald-500/10 text-emerald-100",
  error: "border-red-500/30 bg-red-500/5 text-red-200",
  warning: "border-amber-500/40 bg-amber-500/10 text-amber-100",
};

function describeError(error: unknown): Outcome {
  if (error instanceof ApiError) {
    switch (error.code) {
      case "missing_field":
      case "invalid_amount":
        return {
          tone: "error",
          title: "A field was rejected",
          body: `${error.message} Nothing was logged.`,
        };
      case "no_schema":
        return {
          tone: "error",
          title: "This environment has no database yet",
          body: "Manual adjustments can’t be logged here until the schema is migrated (deferred to go-live). Nothing was logged.",
        };
      case "unauthenticated":
        return {
          tone: "error",
          title: "Session expired",
          body: "Your Cloudflare Access session has expired — reload to sign in again. Nothing was logged.",
        };
      case "network_error":
      case "bad_response":
        // Unlike a bot create (which is idempotent by id), this endpoint has NO
        // idempotency key and NO read endpoint. So a resubmit after a lost
        // response could write a SECOND row, and there is no way to check from
        // here. Say exactly that rather than inviting a blind retry.
        return {
          tone: "warning",
          title: "Couldn’t confirm — the adjustment may or may not have been logged",
          body: "The request failed before a result came back, and there’s no way to check from the dashboard (this endpoint has no read/list yet). Don’t simply resubmit — logging again could create a duplicate. Reconcile against the exchange, or check with whoever manages the database, before logging the same movement a second time.",
        };
      default:
        return { tone: "error", title: "Couldn’t log the adjustment", body: `${error.message} Nothing was logged.` };
    }
  }
  return {
    tone: "error",
    title: "Couldn’t log the adjustment",
    body: `${error instanceof Error ? error.message : "unexpected error"}. Nothing was logged.`,
  };
}

// ---------------------------------------------------------------------------
// Shared input chrome (same look as the create-bot form)
// ---------------------------------------------------------------------------

const INPUT_BASE =
  "mt-1.5 w-full rounded-md border bg-zinc-950 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 focus:outline-none disabled:opacity-50";

function inputBorder(hasError: boolean): string {
  return hasError ? "border-red-500/60" : "border-zinc-700 focus:border-emerald-500/60";
}

function Field({
  label,
  htmlFor,
  help,
  error,
  children,
}: {
  label: string;
  htmlFor: string;
  help?: ReactNode;
  error?: string;
  children: ReactNode;
}) {
  return (
    <div>
      <label htmlFor={htmlFor} className="block text-sm font-medium text-zinc-300">
        {label} <span className="text-red-400">*</span>
      </label>
      {help && <p className="mt-0.5 text-xs text-zinc-500">{help}</p>}
      {children}
      {error && <p className="mt-1 text-xs text-red-400">{error}</p>}
    </div>
  );
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.filter((v) => v !== ""))].sort();
}

// ---------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------

export function ManualAdjustment() {
  const [accountLabel, setAccountLabel] = useState("");
  const [asset, setAsset] = useState("");
  const [direction, setDirection] = useState<Direction | null>(null);
  const [magnitude, setMagnitude] = useState("");
  const [note, setNote] = useState("");

  const [fieldErrors, setFieldErrors] = useState<Errors>({});
  const [submitting, setSubmitting] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  // Best-effort suggestions for the account and asset fields, so an operator can
  // pick a label that already exists rather than retype it. Purely a convenience
  // (there is no accounts endpoint, and none is invented): the fields stay free
  // text -- a brand-new account works -- and a failed fetch is ignored.
  const [known, setKnown] = useState<Bot[]>([]);
  useEffect(() => {
    const controller = new AbortController();
    fetchBots(controller.signal)
      .then(setKnown)
      .catch(() => {
        /* suggestions are optional; ignore */
      });
    return () => controller.abort();
  }, []);

  const previewValid =
    direction !== null && magnitude.trim() !== "" && DECIMAL.test(magnitude.trim()) && /[1-9]/.test(magnitude.trim());

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (submitting) return; // double-click guard (brief item 5)

    const errors = validate(accountLabel, asset, direction, magnitude, note);
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) {
      setOutcome({
        tone: "error",
        title: "Some fields need attention",
        body: "Fix the highlighted fields, then log the adjustment. Nothing was submitted.",
      });
      return;
    }

    setOutcome(null);
    setSubmitting(true);
    try {
      const saved = await logManualAdjustment({
        accountLabel: accountLabel.trim(),
        asset: asset.trim(),
        amount: signedAmount(direction!, magnitude),
        note: note.trim(),
      });
      // Honest single-action confirmation from the SERVER's saved record (brief
      // item 4). No client-side list is kept -- there is no read endpoint. Clear
      // the amount and note for the next entry; keep account/asset/direction so a
      // batch of movements on the same account is quick, with the preview and this
      // banner keeping each one's sign visible.
      setOutcome(confirmation(saved));
      setMagnitude("");
      setNote("");
      setFieldErrors({});
    } catch (error) {
      setOutcome(describeError(error));
    } finally {
      setSubmitting(false);
    }
  }

  const accountList = "known-accounts";
  const assetList = "known-assets";

  return (
    <div className="mx-auto max-w-xl space-y-6">
      <div>
        <Link to="/" className="text-sm text-zinc-400 underline-offset-2 hover:text-zinc-200 hover:underline">
          ← Back to bots
        </Link>
      </div>

      <div>
        <h1 className="text-xl font-semibold text-zinc-100">Log a manual adjustment</h1>
        <p className="mt-1 text-sm text-zinc-400">
          Record a deposit or withdrawal you made on the exchange outside the bots, so reconciliation can
          account for it instead of flagging it as an unexplained balance change. Log it{" "}
          <span className="text-zinc-300">before or right after</span> you move the funds.
        </p>
      </div>

      <datalist id={accountList}>
        {unique(known.map((b) => b.accountLabel)).map((v) => (
          <option key={v} value={v} />
        ))}
      </datalist>
      <datalist id={assetList}>
        {unique([...known.map((b) => b.capitalAsset), ...known.map((b) => b.pair)]).map((v) => (
          <option key={v} value={v} />
        ))}
      </datalist>

      <form className="space-y-6" onSubmit={onSubmit} noValidate>
        <section className="space-y-4 rounded-xl border border-zinc-800 bg-zinc-900/40 p-5">
          <Field
            label="Account"
            htmlFor="accountLabel"
            error={fieldErrors.accountLabel}
            help="The exchange account label the funds moved on."
          >
            <input
              id="accountLabel"
              type="text"
              value={accountLabel}
              onChange={(e) => setAccountLabel(e.target.value)}
              placeholder="e.g. main"
              list={accountList}
              disabled={submitting}
              autoComplete="off"
              aria-invalid={fieldErrors.accountLabel !== undefined}
              className={[INPUT_BASE, inputBorder(fieldErrors.accountLabel !== undefined)].join(" ")}
            />
          </Field>

          <Field
            label="Asset"
            htmlFor="asset"
            error={fieldErrors.asset}
            help="The asset that moved, e.g. USDT or BTC."
          >
            <input
              id="asset"
              type="text"
              value={asset}
              onChange={(e) => setAsset(e.target.value)}
              placeholder="USDT"
              list={assetList}
              disabled={submitting}
              autoComplete="off"
              aria-invalid={fieldErrors.asset !== undefined}
              className={[INPUT_BASE, inputBorder(fieldErrors.asset !== undefined)].join(" ")}
            />
          </Field>

          {/* Direction: the sign, made an explicit choice rather than a typed
              minus (brief item 2). No default -- it must be chosen. */}
          <div>
            <span className="block text-sm font-medium text-zinc-300">
              Direction <span className="text-red-400">*</span>
            </span>
            <p className="mt-0.5 text-xs text-zinc-500">
              A deposit adds to the balance (+); a withdrawal removes from it (−).
            </p>
            <div
              className="mt-1.5 grid grid-cols-2 gap-2"
              role="radiogroup"
              aria-label="Direction"
              aria-invalid={fieldErrors.direction !== undefined}
            >
              <DirectionButton
                selected={direction === "deposit"}
                onClick={() => setDirection("deposit")}
                disabled={submitting}
                tone="deposit"
                sign="+"
                label="Deposit"
                sublabel="funds in"
              />
              <DirectionButton
                selected={direction === "withdrawal"}
                onClick={() => setDirection("withdrawal")}
                disabled={submitting}
                tone="withdrawal"
                sign="−"
                label="Withdrawal"
                sublabel="funds out"
              />
            </div>
            {fieldErrors.direction && <p className="mt-1 text-xs text-red-400">{fieldErrors.direction}</p>}
          </div>

          <Field
            label="Amount"
            htmlFor="magnitude"
            error={fieldErrors.amount}
            help="How much moved, as a positive number. The sign is set by the direction above — don’t type a minus."
          >
            <input
              id="magnitude"
              type="text"
              inputMode="decimal"
              value={magnitude}
              onChange={(e) => setMagnitude(e.target.value)}
              placeholder="250.5"
              disabled={submitting}
              autoComplete="off"
              aria-invalid={fieldErrors.amount !== undefined}
              className={["tabular ", INPUT_BASE, inputBorder(fieldErrors.amount !== undefined)].join(" ")}
            />
          </Field>

          {/* Live preview of the exact signed value that will be logged -- the
              third, unmissable statement of the sign (brief item 2). */}
          <div
            className={[
              "rounded-lg border px-3 py-2 text-sm",
              previewValid && direction === "withdrawal"
                ? "border-red-500/40 bg-red-500/10 text-red-200"
                : previewValid
                  ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-100"
                  : "border-zinc-800 bg-zinc-950/40 text-zinc-500",
            ].join(" ")}
          >
            {previewValid ? (
              <>
                Will log:{" "}
                <span className="tabular font-semibold">
                  {direction === "withdrawal" ? "−" : "+"}
                  {formatQuantity(magnitude.trim())} {asset.trim() || "…"}
                </span>{" "}
                — {direction === "withdrawal" ? "withdrawal (funds leaving the account)" : "deposit (funds entering the account)"}
              </>
            ) : (
              "Choose a direction and enter an amount to see exactly what will be logged."
            )}
          </div>

          <Field
            label="Note"
            htmlFor="note"
            error={fieldErrors.note}
            help="Why the funds moved. Reconciliation reads this to explain the balance change."
          >
            <textarea
              id="note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={3}
              placeholder="e.g. Withdrew 250 USDT to cold storage"
              disabled={submitting}
              aria-invalid={fieldErrors.note !== undefined}
              className={[INPUT_BASE, "resize-y", inputBorder(fieldErrors.note !== undefined)].join(" ")}
            />
          </Field>
        </section>

        {outcome !== null && (
          <div className={["rounded-md border px-3 py-2 text-sm", OUTCOME_CLASS[outcome.tone]].join(" ")}>
            <div className="font-semibold">{outcome.title}</div>
            <div className="mt-0.5 text-[0.8125rem] leading-snug opacity-90">{outcome.body}</div>
          </div>
        )}

        <div className="flex items-center gap-3">
          <button
            type="submit"
            disabled={submitting}
            className="inline-flex items-center gap-2 rounded-md bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {submitting && (
              <span
                className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/40 border-t-white"
                aria-hidden
              />
            )}
            {submitting ? "Logging…" : "Log adjustment"}
          </button>
          <Link to="/" className="text-sm font-medium text-zinc-400 hover:text-zinc-200">
            Cancel
          </Link>
        </div>
      </form>
    </div>
  );
}

/** The success confirmation, built from the server's saved record (brief item
 *  4). Echoes the signed amount, note and the recorded time so the operator sees
 *  exactly what was written, not just "done". */
function confirmation(saved: ManualAdjustmentRow): Outcome {
  const withdrawal = saved.amount.startsWith("-");
  /*
   * A QUANTITY rather than money, because `asset` here is free-typed by the
   * operator and may be any asset on the account -- rounding an 0.004 BTC
   * withdrawal to two places would echo back a receipt for something they did
   * not log. The exact figure they submitted is the point of this confirmation.
   */
  const shown = withdrawal
    ? `−${formatQuantity(saved.amount.slice(1))}`
    : `+${formatQuantity(saved.amount)}`;
  return {
    tone: "success",
    title: "Adjustment logged",
    body: (
      <>
        Recorded a{" "}
        <span className="font-semibold">{withdrawal ? "withdrawal" : "deposit"}</span> of{" "}
        <span className="tabular font-semibold">
          {shown} {saved.asset}
        </span>{" "}
        on <span className="font-semibold">{saved.accountLabel}</span> at {formatDateTime(saved.createdAt)}.
        Reconciliation will subtract it from the next detected discrepancy on this account. Log another below
        if you need to.
      </>
    ),
  };
}

function DirectionButton({
  selected,
  onClick,
  disabled,
  tone,
  sign,
  label,
  sublabel,
}: {
  selected: boolean;
  onClick: () => void;
  disabled?: boolean;
  tone: "deposit" | "withdrawal";
  sign: string;
  label: string;
  sublabel: string;
}) {
  const selectedClass =
    tone === "withdrawal"
      ? "border-red-500/70 bg-red-500/15 text-red-100"
      : "border-emerald-500/70 bg-emerald-500/15 text-emerald-100";
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onClick}
      disabled={disabled}
      className={[
        "flex items-center gap-2 rounded-lg border px-3 py-2.5 text-left transition-colors disabled:opacity-50",
        selected ? selectedClass : "border-zinc-700 bg-zinc-950 text-zinc-300 hover:border-zinc-600",
      ].join(" ")}
    >
      <span className="text-lg font-bold tabular" aria-hidden>
        {sign}
      </span>
      <span className="flex flex-col leading-tight">
        <span className="text-sm font-semibold">{label}</span>
        <span className="text-xs opacity-70">{sublabel}</span>
      </span>
    </button>
  );
}
