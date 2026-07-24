/**
 * The create-bot form (this session's brief; the last piece of spec step 10).
 *
 * The dashboard's THIRD write surface, after the liquidate action (step 10.9)
 * and the global kill switch (step 10.10), and it reuses their two established
 * conventions: a `submitting` guard + disabled/spinner button so a double-click
 * cannot fire two creates (brief item 7), and honest, DISTINCT error handling
 * keyed on the backend's typed error code rather than prose (brief item 7).
 *
 * WHAT IT SENDS (`POST /api/bots`, `createBot` in api/client.ts)
 * -------------------------------------------------------------
 * A flat body plus a strategy-specific `params` object, exactly what the backend
 * handler decodes. On success the backend answers 201 with the created bot's
 * full detail (the write-response convention), so we navigate straight to
 * `/bots/:id` -- the person immediately sees what they just made (brief item 6),
 * not the list.
 *
 * HOW THE VISIBLE FIELDS ADAPT PER STRATEGY (brief item 2)
 * -------------------------------------------------------
 * A grid/DCA segmented toggle drives which fieldset MOUNTS. Only the selected
 * strategy's inputs exist in the DOM, so the payload can never carry a stale
 * field from the other strategy. Shared fields (bot id, account, exchange, pair,
 * capital asset, allocated capital) sit above the switch and stay put.
 *
 * THE MANDATORY-VS-OPTIONAL TAKE-PROFIT DISTINCTION (brief item 3)
 * ---------------------------------------------------------------
 * The two strategies genuinely differ (spec 6.1) and the form reflects it rather
 * than treating them identically:
 *   - stop-loss is REQUIRED for both, always marked with a `*`.
 *   - DCA take-profit (`takeProfitPct`) is REQUIRED -- it defines the cycle's
 *     exit -- and marked `*`.
 *   - grid take-profit (`takeProfitAmount`) is OPTIONAL, labelled (optional), and
 *     it is a realized-profit AMOUNT, not a percentage; grid also cashes out on
 *     an upside breakout by default (the `breakoutTakeProfit` checkbox alongside).
 *
 * CAPITAL IS THE SERVER'S TRUTH (brief items 4, 5)
 * ------------------------------------------------
 * The capital field is a plain amount. We do NOT duplicate the capital-ledger
 * check client-side (it would drift from the real ledger), and we do NOT
 * pre-compute planned-spend-vs-allocation. Those come back as the backend's real
 * `insufficient_capital` (its message carries available vs requested, shown
 * verbatim) and `exceeds_allocated_capital`. Client validation catches ONLY
 * things that are always invalid regardless of ledger state: missing required
 * fields, non-numeric input, and stop-loss/drop percentages outside a sensible
 * 0-100% (the same `<100%` rule the backend enforces, checked with the existing
 * `compareDecimal` so no float is ever built and the two cannot disagree).
 */

import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ApiError, createBot, fetchBots } from "../api/client";
import type { Bot, CreateBotRequest, Strategy } from "../api/types";
import { compareDecimal } from "../format";

// ---------------------------------------------------------------------------
// Validation helpers -- pure string checks, no float ever constructed. The
// decimal grammar mirrors the backend's money parser (src/shared/money.ts):
// digits, optional single dot, at most 8 fractional places, and no sign
// (every amount and percentage a bot takes is positive).
// ---------------------------------------------------------------------------

const DECIMAL = /^\d+(\.\d{1,8})?$/;

/** A decimal string that is strictly greater than zero. */
function isPositiveDecimal(raw: string): boolean {
  const t = raw.trim();
  return DECIMAL.test(t) && /[1-9]/.test(t);
}

type Errors = Record<string, string>;

function requirePositive(errors: Errors, key: string, value: string): void {
  const t = value.trim();
  if (t === "") errors[key] = "Required.";
  else if (!DECIMAL.test(t)) errors[key] = "Enter a number (up to 8 decimal places).";
  else if (!/[1-9]/.test(t)) errors[key] = "Must be greater than zero.";
}

/** Must be a valid non-negative decimal, but zero is allowed. */
function requireNonNegative(errors: Errors, key: string, value: string): void {
  const t = value.trim();
  if (t === "") errors[key] = "Required.";
  else if (!DECIMAL.test(t)) errors[key] = "Enter a number (up to 8 decimal places).";
}

/** A sensible percentage in the open interval (0, 100) -- the backend's rule. */
function requirePercentUnder100(errors: Errors, key: string, value: string): void {
  const t = value.trim();
  if (t === "") errors[key] = "Required.";
  else if (!DECIMAL.test(t)) errors[key] = "Enter a percentage.";
  else if (!/[1-9]/.test(t)) errors[key] = "Must be greater than 0%.";
  else if (compareDecimal(t, "100") >= 0) errors[key] = "Must be below 100%.";
}

/**
 * A percentage greater than 0 with NO upper cap. Used for the DCA take-profit:
 * it is measured above average entry and the backend imposes no ceiling, so a
 * client-side <100% rule would reject configs the server accepts (drift).
 */
function requirePercentPositive(errors: Errors, key: string, value: string): void {
  const t = value.trim();
  if (t === "") errors[key] = "Required.";
  else if (!DECIMAL.test(t)) errors[key] = "Enter a percentage.";
  else if (!/[1-9]/.test(t)) errors[key] = "Must be greater than 0%.";
}

function requireInteger(errors: Errors, key: string, value: string, min: number): void {
  const t = value.trim();
  if (t === "") errors[key] = "Required.";
  else if (!/^\d+$/.test(t)) errors[key] = "Enter a whole number.";
  else if (Number(t) < min) errors[key] = `Must be at least ${min}.`;
}

// ---------------------------------------------------------------------------
// Backend-error → honest message (brief item 7)
// ---------------------------------------------------------------------------

type OutcomeTone = "error" | "warning";

interface Outcome {
  readonly tone: OutcomeTone;
  readonly title: string;
  readonly text: string;
  /** A follow-on link (e.g. to the kill-switch page), when one helps. */
  readonly link?: { readonly to: string; readonly label: string };
}

const OUTCOME_CLASS: Record<OutcomeTone, string> = {
  error: "border-red-500/30 bg-red-500/5 text-red-200",
  warning: "border-amber-500/40 bg-amber-500/10 text-amber-100",
};

function describeError(error: unknown, id: string, account: string, asset: string): Outcome {
  if (error instanceof ApiError) {
    switch (error.code) {
      case "insufficient_capital":
        // The message carries available vs requested; surface it verbatim (item 4).
        return {
          tone: "error",
          title: "Not enough available capital",
          text: `${error.message} No bot was created — lower the allocated amount or free up capital on this account.`,
        };
      case "exceeds_allocated_capital":
        // A DIFFERENT refusal from insufficient_capital: the config would out-spend
        // its own allocation, independent of the ledger. Its message says by how much.
        return {
          tone: "error",
          title: "Configuration out-spends its allocation",
          text: `${error.message} No bot was created.`,
        };
      case "no_ledger_row":
        return {
          tone: "error",
          title: "No capital ledger for this account",
          text: `The account "${account}" has no capital ledger for ${asset} yet, so capital cannot be allocated to it. Check the account label and capital asset. No bot was created.`,
        };
      case "duplicate_bot_instance":
      case "already_created":
        return {
          tone: "error",
          title: "That bot ID is already taken",
          text: `A bot with the ID "${id}" already exists. Choose a different ID. No new bot was created.`,
        };
      case "globally_tripped":
        return {
          tone: "error",
          title: "The global kill switch is pulled",
          text: "No bot can be created on any account while the global kill switch is tripped. Reset it first. No bot was created.",
          link: { to: "/kill-switch", label: "Go to the kill switch" },
        };
      case "account_tripped":
        return {
          tone: "error",
          title: "This account's circuit breaker is tripped",
          text: `The circuit breaker for "${account}" is tripped, so no bot can be created on it until a human resets it. No bot was created.`,
        };
      case "invalid_parameter":
        return {
          tone: "error",
          title: "A parameter was rejected",
          text: `${error.message} No bot was created.`,
        };
      case "invalid_amount":
      case "invalid_capital_amount":
      case "missing_field":
      case "invalid_strategy":
        return {
          tone: "error",
          title: "A field was rejected",
          text: `${error.message} No bot was created.`,
        };
      case "network_error":
      case "bad_response":
        // No response came back: we cannot know whether the create landed. Reusing
        // the SAME id makes a retry safe -- if the first one succeeded it comes back
        // as duplicate_bot_instance rather than making a second bot.
        return {
          tone: "warning",
          title: "Couldn’t confirm — the bot may or may not have been created",
          text: `The request failed before a result came back. Check the bot list: if "${id}" is there, it was created. Submitting again with the same ID is safe — a duplicate would be reported rather than making a second bot.`,
        };
      case "unauthenticated":
        return {
          tone: "error",
          title: "Session expired",
          text: "Your Cloudflare Access session has expired — reload to sign in again. No bot was created.",
        };
      default:
        return { tone: "error", title: "Creation failed", text: `${error.message} No bot was created.` };
    }
  }
  return {
    tone: "error",
    title: "Creation failed",
    text: `${error instanceof Error ? error.message : "unexpected error"}. No bot was created.`,
  };
}

// ---------------------------------------------------------------------------
// Small presentational primitives (shared input chrome)
// ---------------------------------------------------------------------------

const INPUT_BASE =
  "mt-1.5 w-full rounded-md border bg-zinc-950 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 focus:outline-none disabled:opacity-50";

function inputBorder(hasError: boolean): string {
  return hasError ? "border-red-500/60" : "border-zinc-700 focus:border-emerald-500/60";
}

function Field({
  label,
  htmlFor,
  required,
  help,
  error,
  children,
}: {
  label: string;
  htmlFor: string;
  required?: boolean;
  help?: ReactNode;
  error?: string;
  children: ReactNode;
}) {
  return (
    <div>
      <label htmlFor={htmlFor} className="block text-sm font-medium text-zinc-300">
        {label}{" "}
        {required ? (
          <span className="text-red-400">*</span>
        ) : (
          <span className="text-xs font-normal text-zinc-500">(optional)</span>
        )}
      </label>
      {help && <p className="mt-0.5 text-xs text-zinc-500">{help}</p>}
      {children}
      {error && <p className="mt-1 text-xs text-red-400">{error}</p>}
    </div>
  );
}

/** A labelled text/number input driven by the `Field` chrome. */
function TextInput({
  id,
  label,
  value,
  onChange,
  required,
  help,
  error,
  placeholder,
  list,
  numeric,
  disabled,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  required?: boolean;
  help?: ReactNode;
  error?: string;
  placeholder?: string;
  list?: string;
  numeric?: boolean;
  disabled?: boolean;
}) {
  return (
    <Field label={label} htmlFor={id} required={required} help={help} error={error}>
      <input
        id={id}
        type="text"
        inputMode={numeric ? "decimal" : undefined}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        list={list}
        disabled={disabled}
        autoComplete="off"
        aria-invalid={error !== undefined}
        className={[numeric ? "tabular " : "", INPUT_BASE, inputBorder(error !== undefined)].join(" ")}
      />
    </Field>
  );
}

function Checkbox({
  id,
  label,
  checked,
  onChange,
  help,
  disabled,
}: {
  id: string;
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  help?: ReactNode;
  disabled?: boolean;
}) {
  return (
    <div>
      <label htmlFor={id} className="flex items-center gap-2 text-sm font-medium text-zinc-300">
        <input
          id={id}
          type="checkbox"
          checked={checked}
          onChange={(event) => onChange(event.target.checked)}
          disabled={disabled}
          className="h-4 w-4 rounded border-zinc-600 bg-zinc-950 accent-emerald-500 disabled:opacity-50"
        />
        {label}
      </label>
      {help && <p className="mt-0.5 ml-6 text-xs text-zinc-500">{help}</p>}
    </div>
  );
}

/** Distinct-value suggestions for the shared free-text fields, if any bots exist. */
function unique(values: readonly string[]): string[] {
  return [...new Set(values.filter((v) => v !== ""))].sort();
}

/** A short random slug so a fresh form has a unique, editable id prefilled. */
function generatedId(): string {
  return `bot-${Math.random().toString(36).slice(2, 8)}`;
}

// ---------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------

export function CreateBot() {
  const navigate = useNavigate();

  const [strategy, setStrategy] = useState<Strategy>("dca");

  // Shared fields.
  const [botInstanceId, setBotInstanceId] = useState(generatedId);
  const [accountLabel, setAccountLabel] = useState("");
  const [exchange, setExchange] = useState("binance");
  const [pair, setPair] = useState("");
  const [capitalAsset, setCapitalAsset] = useState("USDT");
  const [allocatedCapital, setAllocatedCapital] = useState("");

  // DCA fields.
  const [baseOrderSize, setBaseOrderSize] = useState("");
  const [additionalOrderSize, setAdditionalOrderSize] = useState("");
  const [stepMultiplier, setStepMultiplier] = useState("1");
  const [dropPct, setDropPct] = useState("");
  const [maxAdditionalBuys, setMaxAdditionalBuys] = useState("0");
  const [dcaTakeProfitPct, setDcaTakeProfitPct] = useState("");
  const [dcaStopLossPct, setDcaStopLossPct] = useState("");
  const [autoRestart, setAutoRestart] = useState(false);

  // Grid fields.
  const [upperBound, setUpperBound] = useState("");
  const [lowerBound, setLowerBound] = useState("");
  const [gridLines, setGridLines] = useState("");
  const [spacing, setSpacing] = useState<"arithmetic" | "geometric">("arithmetic");
  const [orderSize, setOrderSize] = useState("");
  const [gridStopLossPct, setGridStopLossPct] = useState("");
  const [breakoutTakeProfit, setBreakoutTakeProfit] = useState(true);
  const [breakoutThresholdPct, setBreakoutThresholdPct] = useState("");
  const [takeProfitAmount, setTakeProfitAmount] = useState("");

  const [fieldErrors, setFieldErrors] = useState<Errors>({});
  const [submitting, setSubmitting] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  // Best-effort suggestions for the shared free-text fields, so an operator can
  // pick an account/pair that already has a capital ledger rather than retype
  // it. Purely a convenience: the fields stay free text (a brand-new account
  // still works), and a failed fetch is ignored -- there is no accounts endpoint
  // to depend on, and none is invented here.
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

  function switchStrategy(next: Strategy) {
    if (next === strategy) return;
    setStrategy(next);
    // Clear cross-strategy validation noise and any stale outcome.
    setFieldErrors({});
    setOutcome(null);
  }

  function validate(): Errors {
    const errors: Errors = {};

    if (botInstanceId.trim() === "") errors.botInstanceId = "Required.";
    else if (!/^[A-Za-z0-9._:-]+$/.test(botInstanceId.trim()))
      errors.botInstanceId = "Use letters, digits, dot, dash, underscore or colon only.";
    if (accountLabel.trim() === "") errors.accountLabel = "Required.";
    if (exchange.trim() === "") errors.exchange = "Required.";
    if (pair.trim() === "") errors.pair = "Required.";
    if (capitalAsset.trim() === "") errors.capitalAsset = "Required.";
    requirePositive(errors, "allocatedCapital", allocatedCapital);

    if (strategy === "dca") {
      requirePositive(errors, "baseOrderSize", baseOrderSize);
      requireInteger(errors, "maxAdditionalBuys", maxAdditionalBuys, 0);
      // additionalOrderSize/stepMultiplier are only USED when there are additional
      // buys, and the backend only requires them positive then (validateDcaParams);
      // otherwise they must still be valid numbers since they are sent.
      const buys = /^\d+$/.test(maxAdditionalBuys.trim()) ? Number(maxAdditionalBuys.trim()) : 0;
      if (buys > 0) {
        requirePositive(errors, "additionalOrderSize", additionalOrderSize);
        requirePositive(errors, "stepMultiplier", stepMultiplier);
      } else {
        requireNonNegative(errors, "additionalOrderSize", additionalOrderSize);
        requireNonNegative(errors, "stepMultiplier", stepMultiplier);
      }
      requirePercentUnder100(errors, "dropPct", dropPct);
      requirePercentPositive(errors, "dcaTakeProfitPct", dcaTakeProfitPct); // mandatory
      requirePercentUnder100(errors, "dcaStopLossPct", dcaStopLossPct); // mandatory
    } else {
      requirePositive(errors, "upperBound", upperBound);
      requirePositive(errors, "lowerBound", lowerBound);
      if (
        errors.upperBound === undefined &&
        errors.lowerBound === undefined &&
        compareDecimal(lowerBound.trim(), upperBound.trim()) >= 0
      ) {
        errors.lowerBound = "Lower bound must be below the upper bound.";
      }
      requireInteger(errors, "gridLines", gridLines, 2);
      requirePositive(errors, "orderSize", orderSize);
      requirePercentUnder100(errors, "gridStopLossPct", gridStopLossPct); // mandatory
      // Optional grid extras: only validated when a value is present.
      if (takeProfitAmount.trim() !== "" && !isPositiveDecimal(takeProfitAmount)) {
        errors.takeProfitAmount = "Enter a positive amount, or leave blank.";
      }
      if (breakoutTakeProfit && breakoutThresholdPct.trim() !== "" && !isPositiveDecimal(breakoutThresholdPct)) {
        errors.breakoutThresholdPct = "Enter a positive percentage, or leave blank.";
      }
    }

    return errors;
  }

  function buildRequest(): CreateBotRequest {
    const base = {
      botInstanceId: botInstanceId.trim(),
      accountLabel: accountLabel.trim(),
      exchange: exchange.trim(),
      pair: pair.trim(),
      capitalAsset: capitalAsset.trim(),
      allocatedCapital: allocatedCapital.trim(),
    };
    if (strategy === "dca") {
      return {
        ...base,
        strategy: "dca",
        params: {
          baseOrderSize: baseOrderSize.trim(),
          additionalOrderSize: additionalOrderSize.trim(),
          stepMultiplier: stepMultiplier.trim(),
          dropPct: dropPct.trim(),
          maxAdditionalBuys: Number(maxAdditionalBuys.trim()),
          takeProfitPct: dcaTakeProfitPct.trim(),
          stopLossPct: dcaStopLossPct.trim(),
          autoRestart,
          sellOnStopLoss: false,
        },
      };
    }
    return {
      ...base,
      strategy: "grid",
      params: {
        upperBound: upperBound.trim(),
        lowerBound: lowerBound.trim(),
        gridLines: Number(gridLines.trim()),
        spacing,
        orderSize: orderSize.trim(),
        stopLossPct: gridStopLossPct.trim(),
        breakoutTakeProfit,
        breakoutThresholdPct:
          breakoutTakeProfit && breakoutThresholdPct.trim() !== "" ? breakoutThresholdPct.trim() : null,
        takeProfitAmount: takeProfitAmount.trim() !== "" ? takeProfitAmount.trim() : null,
      },
    };
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (submitting) return; // double-click guard (brief item 7)

    const errors = validate();
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) {
      setOutcome({
        tone: "error",
        title: "Some fields need attention",
        text: "Fix the highlighted fields, then create the bot. Nothing was submitted.",
      });
      return;
    }

    setOutcome(null);
    setSubmitting(true);
    try {
      const bot = await createBot(buildRequest());
      // Success: go straight to the created bot's detail page (brief item 6). The
      // component unmounts on navigation, so no post-success state reset is needed.
      navigate(`/bots/${encodeURIComponent(bot.id)}`);
    } catch (error) {
      setOutcome(describeError(error, botInstanceId.trim(), accountLabel.trim(), capitalAsset.trim()));
      // A taken id is worth pinning to its field as well as the banner.
      if (error instanceof ApiError && (error.code === "duplicate_bot_instance" || error.code === "already_created")) {
        setFieldErrors((prev) => ({ ...prev, botInstanceId: "Already taken — choose another." }));
      }
      setSubmitting(false); // stay on the form to correct and retry
    }
  }

  const accountList = "known-accounts";
  const pairList = "known-pairs";
  const assetList = "known-assets";

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Link to="/" className="text-sm text-zinc-400 underline-offset-2 hover:text-zinc-200 hover:underline">
          ← Back to bots
        </Link>
      </div>

      <div>
        <h1 className="text-xl font-semibold text-zinc-100">Create a bot</h1>
        <p className="mt-1 text-sm text-zinc-400">
          Configuration is saved and capital is reserved on submit; no orders are placed until the bot is
          started. Capital is checked against this account’s live ledger by the server.
        </p>
      </div>

      {/* Suggestion lists for the shared free-text fields (best effort). */}
      <datalist id={accountList}>
        {unique(known.map((b) => b.accountLabel)).map((v) => (
          <option key={v} value={v} />
        ))}
      </datalist>
      <datalist id={pairList}>
        {unique(known.map((b) => b.pair)).map((v) => (
          <option key={v} value={v} />
        ))}
      </datalist>
      <datalist id={assetList}>
        {unique(known.map((b) => b.capitalAsset)).map((v) => (
          <option key={v} value={v} />
        ))}
      </datalist>

      <form className="space-y-8" onSubmit={onSubmit} noValidate>
        {/* ---- Shared configuration ---- */}
        <section className="space-y-4 rounded-xl border border-zinc-800 bg-zinc-900/40 p-5">
          <h2 className="text-base font-semibold text-zinc-200">Bot</h2>

          <TextInput
            id="botInstanceId"
            label="Bot ID"
            value={botInstanceId}
            onChange={setBotInstanceId}
            required
            error={fieldErrors.botInstanceId}
            help="Unique identifier, shown in the list and used in the bot’s URL. A suggestion is prefilled; edit it if you like."
            disabled={submitting}
          />
          <TextInput
            id="accountLabel"
            label="Account"
            value={accountLabel}
            onChange={setAccountLabel}
            required
            error={fieldErrors.accountLabel}
            help="Exchange account label — maps to a stored API key and to this account’s capital ledger."
            placeholder="e.g. main"
            list={accountList}
            disabled={submitting}
          />
          <div className="grid gap-4 sm:grid-cols-2">
            <TextInput
              id="exchange"
              label="Exchange"
              value={exchange}
              onChange={setExchange}
              required
              error={fieldErrors.exchange}
              help="Binance is the only exchange in v1."
              disabled={submitting}
            />
            <TextInput
              id="pair"
              label="Pair"
              value={pair}
              onChange={setPair}
              required
              error={fieldErrors.pair}
              help="Binance symbol, e.g. BTCUSDT."
              placeholder="BTCUSDT"
              list={pairList}
              disabled={submitting}
            />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <TextInput
              id="capitalAsset"
              label="Capital asset"
              value={capitalAsset}
              onChange={setCapitalAsset}
              required
              error={fieldErrors.capitalAsset}
              help="The quote asset your capital is held in — usually the pair’s quote (USDT)."
              list={assetList}
              disabled={submitting}
            />
            <TextInput
              id="allocatedCapital"
              label="Allocated capital"
              value={allocatedCapital}
              onChange={setAllocatedCapital}
              required
              numeric
              error={fieldErrors.allocatedCapital}
              help="Amount to reserve for this bot. The server checks it against the account’s available balance."
              placeholder="500"
              disabled={submitting}
            />
          </div>
        </section>

        {/* ---- Strategy toggle ---- */}
        <section className="space-y-4 rounded-xl border border-zinc-800 bg-zinc-900/40 p-5">
          <h2 className="text-base font-semibold text-zinc-200">Strategy</h2>
          <div className="inline-flex rounded-lg border border-zinc-700 p-0.5" role="tablist" aria-label="Strategy">
            {(["dca", "grid"] as const).map((option) => {
              const active = strategy === option;
              return (
                <button
                  key={option}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  onClick={() => switchStrategy(option)}
                  disabled={submitting}
                  className={[
                    "rounded-md px-4 py-1.5 text-sm font-medium uppercase transition-colors disabled:opacity-50",
                    active ? "bg-emerald-600 text-white" : "text-zinc-300 hover:bg-zinc-800",
                  ].join(" ")}
                >
                  {option}
                </button>
              );
            })}
          </div>

          {strategy === "dca" ? (
            <div className="space-y-4">
              <TextInput
                id="baseOrderSize"
                label="Base order size"
                value={baseOrderSize}
                onChange={setBaseOrderSize}
                required
                numeric
                error={fieldErrors.baseOrderSize}
                help="The first buy, placed immediately when the bot starts."
                disabled={submitting}
              />
              <div className="grid gap-4 sm:grid-cols-2">
                <TextInput
                  id="maxAdditionalBuys"
                  label="Max additional buys"
                  value={maxAdditionalBuys}
                  onChange={setMaxAdditionalBuys}
                  required
                  numeric
                  error={fieldErrors.maxAdditionalBuys}
                  help="How many safety orders may fire after the base order (0 for none)."
                  disabled={submitting}
                />
                <TextInput
                  id="additionalOrderSize"
                  label="Additional order size"
                  value={additionalOrderSize}
                  onChange={setAdditionalOrderSize}
                  required
                  numeric
                  error={fieldErrors.additionalOrderSize}
                  help="Size of the first additional buy."
                  disabled={submitting}
                />
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <TextInput
                  id="stepMultiplier"
                  label="Step multiplier"
                  value={stepMultiplier}
                  onChange={setStepMultiplier}
                  required
                  numeric
                  error={fieldErrors.stepMultiplier}
                  help="Scales each successive additional buy (1 = same size each time)."
                  disabled={submitting}
                />
                <TextInput
                  id="dropPct"
                  label="Drop % per additional buy"
                  value={dropPct}
                  onChange={setDropPct}
                  required
                  numeric
                  error={fieldErrors.dropPct}
                  help="Price fall from the last entry that triggers the next buy."
                  disabled={submitting}
                />
              </div>
              <Checkbox
                id="autoRestart"
                label="Auto-restart a fresh cycle after take-profit"
                checked={autoRestart}
                onChange={setAutoRestart}
                help="When off, the bot stays stopped after a take-profit exit for human review (spec 6.3)."
                disabled={submitting}
              />
            </div>
          ) : (
            <div className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <TextInput
                  id="lowerBound"
                  label="Lower bound"
                  value={lowerBound}
                  onChange={setLowerBound}
                  required
                  numeric
                  error={fieldErrors.lowerBound}
                  help="Bottom of the grid — the lowest buy line."
                  disabled={submitting}
                />
                <TextInput
                  id="upperBound"
                  label="Upper bound"
                  value={upperBound}
                  onChange={setUpperBound}
                  required
                  numeric
                  error={fieldErrors.upperBound}
                  help="Top of the grid — the highest sell line."
                  disabled={submitting}
                />
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <TextInput
                  id="gridLines"
                  label="Number of grid lines"
                  value={gridLines}
                  onChange={setGridLines}
                  required
                  numeric
                  error={fieldErrors.gridLines}
                  help="Total price levels in the ladder (at least 2)."
                  disabled={submitting}
                />
                <Field label="Spacing" htmlFor="spacing" required>
                  <select
                    id="spacing"
                    value={spacing}
                    onChange={(event) => setSpacing(event.target.value as "arithmetic" | "geometric")}
                    disabled={submitting}
                    className={[INPUT_BASE, inputBorder(false)].join(" ")}
                  >
                    <option value="arithmetic">Arithmetic (equal price gaps)</option>
                    <option value="geometric">Geometric (equal % gaps)</option>
                  </select>
                </Field>
              </div>
              <TextInput
                id="orderSize"
                label="Order size per line"
                value={orderSize}
                onChange={setOrderSize}
                required
                numeric
                error={fieldErrors.orderSize}
                help="Amount committed at each grid level."
                disabled={submitting}
              />
            </div>
          )}
        </section>

        {/* ---- Risk controls (mandatory-vs-optional differs per strategy) ---- */}
        <section className="space-y-4 rounded-xl border border-zinc-800 bg-zinc-900/40 p-5">
          <h2 className="text-base font-semibold text-zinc-200">Risk controls</h2>

          {strategy === "dca" ? (
            <>
              <TextInput
                id="dcaStopLossPct"
                label="Stop-loss %"
                value={dcaStopLossPct}
                onChange={setDcaStopLossPct}
                required
                numeric
                error={fieldErrors.dcaStopLossPct}
                help="Drawdown from average entry that halts the bot. Mandatory."
                disabled={submitting}
              />
              <TextInput
                id="dcaTakeProfitPct"
                label="Take-profit %"
                value={dcaTakeProfitPct}
                onChange={setDcaTakeProfitPct}
                required
                numeric
                error={fieldErrors.dcaTakeProfitPct}
                help="Rise above average entry that closes the position. Mandatory for DCA — it defines the cycle’s exit."
                disabled={submitting}
              />
            </>
          ) : (
            <>
              <TextInput
                id="gridStopLossPct"
                label="Stop-loss %"
                value={gridStopLossPct}
                onChange={setGridStopLossPct}
                required
                numeric
                error={fieldErrors.gridStopLossPct}
                help="Break below the lowest grid line by this % halts the bot. Mandatory."
                disabled={submitting}
              />
              <TextInput
                id="takeProfitAmount"
                label="Take-profit amount"
                value={takeProfitAmount}
                onChange={setTakeProfitAmount}
                numeric
                error={fieldErrors.takeProfitAmount}
                help="Optional for grid — halts once realized profit reaches this amount (a profit amount, not a percentage). Leave blank to rely on the stop-loss and the breakout exit below."
                disabled={submitting}
              />
              <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-3">
                <Checkbox
                  id="breakoutTakeProfit"
                  label="Cash out on an upside breakout"
                  checked={breakoutTakeProfit}
                  onChange={setBreakoutTakeProfit}
                  help="Recommended (spec default): if price runs above the grid, treat it as a take-profit rather than leaving the bot idle."
                  disabled={submitting}
                />
                {breakoutTakeProfit && (
                  <div className="mt-3">
                    <TextInput
                      id="breakoutThresholdPct"
                      label="Breakout threshold %"
                      value={breakoutThresholdPct}
                      onChange={setBreakoutThresholdPct}
                      numeric
                      error={fieldErrors.breakoutThresholdPct}
                      help="Optional — how far above the top line counts as a breakout. Blank uses the backend default."
                      disabled={submitting}
                    />
                  </div>
                )}
              </div>
            </>
          )}
        </section>

        {outcome !== null && (
          <div className={["rounded-md border px-3 py-2 text-sm", OUTCOME_CLASS[outcome.tone]].join(" ")}>
            <div className="font-semibold">{outcome.title}</div>
            <p className="mt-0.5 text-[0.8125rem] leading-snug opacity-90">{outcome.text}</p>
            {outcome.link && (
              <Link
                to={outcome.link.to}
                className="mt-1.5 inline-block text-[0.8125rem] font-medium underline underline-offset-2"
              >
                {outcome.link.label} →
              </Link>
            )}
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
            {submitting ? "Creating…" : "Create bot"}
          </button>
          <Link to="/" className="text-sm font-medium text-zinc-400 hover:text-zinc-200">
            Cancel
          </Link>
        </div>
      </form>
    </div>
  );
}
