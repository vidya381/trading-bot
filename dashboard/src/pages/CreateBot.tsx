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
 * ACCOUNT, EXCHANGE AND PAIR ARE WIRED TO THE REGISTRY, NOT FREE-TYPED (step 11)
 * ----------------------------------------------------------------------------
 * These three fields used to be free text with best-effort suggestions -- which
 * let a person type an account that does not exist, an exchange that disagrees
 * with it, or a pair the venue will not trade. They are now driven by the real
 * backend (step 11's account registry and live pair listing):
 *
 *   - ACCOUNT is a dropdown populated from `GET /api/accounts`. Selecting one
 *     stores both its label and its exchange, straight from that response.
 *   - EXCHANGE is a READ-ONLY confirmation of the selected account's real venue.
 *     It is never an input and is never sent: `POST /api/bots` derives the
 *     exchange from the registry (a body value that disagrees is rejected), so
 *     omitting it makes a wrong-venue bot structurally impossible.
 *   - PAIR is a searchable TYPEAHEAD over `GET /api/accounts/:label/symbols` for
 *     the selected account, refetched whenever the account changes and disabled
 *     until one is chosen. A plain <select> would be a thousands-long list on
 *     Binance and a <datalist> would still allow free-typed junk; the combobox
 *     filters fast AND constrains the committed value to a real symbol from the
 *     fetched set -- the mistake this rewiring removes.
 *
 * Two SEQUENTIAL real network calls (accounts on mount, then symbols after a
 * pick) each show an honest loading indicator, and the symbols call's real
 * failures are surfaced distinctly -- `exchange_unavailable` (the Binance
 * geo-block) as "our end, try a different account", not a generic error.
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
 *
 * ── ⚠ IT CAN OPEN PRE-FILLED FROM A PROPOSAL, AND IT IS STILL THIS FORM ──
 *
 * `/bots/new` accepts a query string describing an LLM proposal
 * (`research/proposalPrefill.ts`, spec 21.1, decision logs 44-46). What arrives is
 * DIFFERENT DEFAULT VALUES for the `useState` calls below and one banner. That is
 * the whole of it, and the things it deliberately is NOT are the point:
 *
 *   * NO SECOND COMPONENT AND NO SECOND ROUTE. `/bots/new` mounts this file for a
 *     manual creation and for a pre-filled one, and there is no `mode` prop, no
 *     variant and no branch anywhere below on "did this come from a proposal".
 *     A parallel simplified form is exactly what 21.1 forbids, and the cheapest way
 *     to be sure this one runs every check it always runs is for there to be only
 *     one of it.
 *   * NO FIELD IS LOCKED, READ-ONLY OR SPECIAL. The prefill seeds ordinary state
 *     and then has nothing more to do with it: every input is the same input with
 *     the same `onChange`, `validate()` is unchanged and unaware, and `buildRequest`
 *     reads the same state it always read. Editing a pre-filled field and editing a
 *     hand-typed one are the same operation.
 *   * NO CHECK IS SKIPPED OR PRE-SATISFIED. Every validation below runs, and every
 *     server-side check runs on submit against the account's state RIGHT NOW. A
 *     proposal can sit for hours -- decision log 45 measured a real 7.8-hour gap
 *     between a proposal and the decision on it -- so a capital figure or a pair
 *     that was fine when it was derived can fail here. That refusal is the check
 *     working, and it arrives through the same `describeError` paths as always.
 *   * NOTHING IS RECORDED BY ARRIVING. The proposal's `outcome` is written by
 *     exactly one thing: a real, completed `POST /api/bots` carrying `proposalId`,
 *     attached in `onSubmit` by `withProposalId` and nowhere else. Opening this
 *     page, editing it, and abandoning it leave the proposal pending.
 *
 * The URL is read ONCE, at mount, and never written back -- so a reload restores
 * the PROPOSAL's numbers and drops edits, exactly as a reload of a half-typed
 * manual form drops those. `proposalPrefill.ts` argues that trade in full.
 *
 * ── ⚠ IT CAN ALSO OPEN PRE-FILLED BY CLONING AN EXISTING BOT ──
 *
 * A SECOND, SEPARATE query string describes an existing bot's configuration
 * (`research/botClonePrefill.ts`), reached from the Clone control on any bot's
 * detail page. Everything in the five bullets above applies to it WORD FOR WORD:
 * one component, one route, no locked fields, no skipped check, and nothing
 * recorded by arriving -- less than nothing, in fact, since a clone has no outcome
 * to write and sends no source id to the server at all.
 *
 * ⚠ THE TWO PREFILLS ARE TWO DECODERS, NOT TWO MODES OF ONE. Each refuses
 * everything it does not recognise, and `readBotClonePrefill` additionally refuses
 * any URL that also carries a `proposalId`, so a link can never be read under the
 * wrong banner. `botClonePrefill.ts` argues that choice in full. What reaches the
 * state below is one `FormPrefillSeed` from whichever decoder answered -- so there
 * is still no branch per source at any `useState`, and a manual visit (both null)
 * is byte-identical to what it always was.
 *
 * ⚠ ONLY THE PROPOSAL PREFILL CAN EVER ATTACH A `proposalId` TO THE SUBMIT. The
 * clone seed is deliberately not consulted by `onSubmit`; `withProposalId` still
 * reads `prefill` alone, so cloning cannot resolve anybody's proposal.
 */

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import {
  ApiError,
  createBot,
  fetchAccounts,
  fetchAccountSymbols,
  fetchBots,
} from "../api/client";
import type { Account, Bot, CreateBotRequest, ProposalLink } from "../api/types";

/**
 * The strategies this form can actually create: the discriminants of
 * `CreateBotRequest`, and nothing else. See the `useState` that uses it.
 */
type CreatableStrategy = CreateBotRequest["strategy"];
import { compareDecimal } from "../format";
import { ProposalPrefillBanner } from "../components/ProposalPrefillBanner";
import { CloneSourceBanner } from "../components/CloneSourceBanner";
import { readProposalPrefill, withProposalId } from "../research/proposalPrefill";
import { readBotClonePrefill, type FormPrefillSeed } from "../research/botClonePrefill";
import { botInstanceIdError, maxBotInstanceIdLengthFor } from "../botId";

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
          text: `${error.message} No bot was created. Lower the allocated amount, or free up capital on this account.`,
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
      case "unregistered_account":
      case "unknown_account":
        // Defensive: the account dropdown only ever offers registered accounts,
        // so this should not happen. It can only surface if the account was
        // de-registered after the form loaded -- reloading refetches the list.
        return {
          tone: "error",
          title: "That account is no longer registered",
          text: `The account "${account}" is not in the registry, so a bot cannot be created on it. Reload the form to refresh the account list. No bot was created.`,
        };
      case "exchange_mismatch":
        // This form omits `exchange` entirely, so the registry is authoritative
        // and a mismatch cannot originate here -- surfaced verbatim if it ever does.
        return {
          tone: "error",
          title: "Account and exchange disagree",
          text: `${error.message} No bot was created.`,
        };
      case "invalid_parameter":
        return {
          tone: "error",
          title: "The server rejected a parameter",
          text: `${error.message} No bot was created.`,
        };
      case "invalid_amount":
      case "invalid_capital_amount":
      case "missing_field":
      case "invalid_strategy":
        return {
          tone: "error",
          title: "The server rejected a field",
          text: `${error.message} No bot was created.`,
        };
      case "network_error":
      case "bad_response":
        // No response came back: we cannot know whether the create landed. Reusing
        // the SAME id makes a retry safe -- if the first one succeeded it comes back
        // as duplicate_bot_instance rather than making a second bot.
        return {
          tone: "warning",
          title: "Couldn’t confirm: the bot may or may not have been created",
          text: `The request failed before a result came back. Check the bot list: if "${id}" is there, it was created. Submitting again with the same ID is safe: a duplicate would be reported rather than making a second bot.`,
        };
      case "unauthenticated":
        return {
          tone: "error",
          title: "Session expired",
          text: "Your Cloudflare Access session has expired. Reload to sign in again. No bot was created.",
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

/**
 * A short random slug so a fresh form has a unique, editable id prefilled.
 *
 * `toString(36)` emits only digits and lowercase letters, so `bot-` plus six of
 * them is 10 characters and always satisfies `BOT_INSTANCE_ID_PATTERN`. Ten is
 * also exactly Kraken's budget (decision-log entry 90, DECISION 3), so the
 * prefilled value needs no venue-specific variant -- it already fits the
 * tightest venue this system knows. Anything typed over it is checked by
 * `botInstanceIdError`.
 */
function generatedId(): string {
  return `bot-${Math.random().toString(36).slice(2, 8)}`;
}

/** Field help that names the venue's own limit once an account is selected. */
function botIdHelp(exchange: string): string {
  const base =
    "Unique identifier, shown in the list and used in the bot’s URL. A suggestion is prefilled; edit it if you like.";
  if (exchange === "") return base;
  return `${base} Up to ${maxBotInstanceIdLengthFor(exchange)} characters on ${exchange}: lowercase letters, digits, dash or underscore.`;
}

/** True for the AbortError a cancelled in-flight fetch throws (component teardown
 *  or a superseded account selection) -- swallowed, never surfaced as an error. */
function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

/**
 * The symbols endpoint's real failures → an honest, DISTINCT message (brief item
 * 4). `exchange_unavailable` is the confirmed Binance geo-block: it is OUR side
 * that could not reach the venue, so the copy says so plainly rather than
 * implying the person did something wrong.
 */
function describeSymbolsError(error: unknown, accountLabel: string): Outcome {
  if (error instanceof ApiError) {
    switch (error.code) {
      case "exchange_unavailable":
        return {
          tone: "warning",
          title: "This exchange couldn’t be reached",
          text: `We couldn’t load the tradable pairs for “${accountLabel}”. This is most likely a connection problem on our end reaching the exchange, not anything you did. Try again, or pick a different account.`,
        };
      case "unknown_account":
        return {
          tone: "error",
          title: "That account is no longer registered",
          text: `“${accountLabel}” is not in the registry anymore. Reload the form to refresh the account list.`,
        };
      case "unauthenticated":
        return {
          tone: "error",
          title: "Session expired",
          text: "Your Cloudflare Access session has expired. Reload to sign in again.",
        };
      default:
        return {
          tone: "error",
          title: "Couldn’t load tradable pairs",
          text: `${error.message} Try again, or pick a different account.`,
        };
    }
  }
  return {
    tone: "error",
    title: "Couldn’t load tradable pairs",
    text: "The request failed before a result came back. Try again, or pick a different account.",
  };
}

// ---------------------------------------------------------------------------
// Account / Exchange / Pair -- wired to the step-11 registry (this session)
// ---------------------------------------------------------------------------

/** A small inline "loading…" row for a field whose value is being fetched, so a
 *  sequential real call never leaves the form looking frozen (brief item 5). */
function LoadingRow({ text }: { text: string }) {
  return (
    <div className="mt-1.5 flex items-center gap-2 rounded-md border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-zinc-400">
      <span
        className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-zinc-600 border-t-zinc-300"
        aria-hidden
      />
      {text}
    </div>
  );
}

/**
 * The account dropdown, populated from `GET /api/accounts` (brief item 1). Shows
 * the account label; the parent stores both the label and its exchange from the
 * same response. A loading row while fetching, an honest error with retry if it
 * fails, and a clear "register one first" note if the registry is empty.
 */
function AccountSelect({
  accounts,
  value,
  onChange,
  loading,
  error,
  onRetry,
  disabled,
  fieldError,
}: {
  accounts: readonly Account[];
  value: string;
  onChange: (label: string) => void;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  disabled: boolean;
  fieldError?: string;
}) {
  return (
    <Field
      label="Account"
      htmlFor="accountLabel"
      required
      help="Which registered exchange account this bot trades on. Its exchange and capital ledger come with it."
      error={fieldError}
    >
      {loading ? (
        <LoadingRow text="Loading accounts…" />
      ) : error !== null ? (
        <div className="mt-1.5 rounded-md border border-red-500/30 bg-red-500/5 px-3 py-2 text-sm text-red-200">
          <p>{error}</p>
          <button
            type="button"
            onClick={onRetry}
            className="mt-1.5 text-xs font-medium underline underline-offset-2 hover:text-red-100"
          >
            Try again
          </button>
        </div>
      ) : accounts.length === 0 ? (
        <div className="mt-1.5 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-100">
          No accounts are registered yet, and a bot has to be created on one. Registering an account
          happens outside this dashboard, so ask whoever looks after this system to add one.
        </div>
      ) : (
        <select
          id="accountLabel"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          disabled={disabled}
          aria-invalid={fieldError !== undefined}
          className={[INPUT_BASE, inputBorder(fieldError !== undefined)].join(" ")}
        >
          <option value="" disabled>
            Select an account…
          </option>
          {accounts.map((account) => (
            <option key={account.accountLabel} value={account.accountLabel}>
              {account.accountLabel}
            </option>
          ))}
        </select>
      )}
    </Field>
  );
}

/**
 * The selected account's exchange, shown READ-ONLY (brief item 2) -- a
 * confirmation of what the account trades on, never an input and never sent. The
 * registry is authoritative, so this is displayed, not chosen.
 */
function ExchangeDisplay({ exchange }: { exchange: string }) {
  return (
    <div>
      <div className="text-sm font-medium text-zinc-300">Exchange</div>
      <p className="mt-0.5 text-xs text-zinc-500">Set by the account you pick. Shown to confirm the venue, not chosen.</p>
      <div className={[INPUT_BASE, "flex items-center border-zinc-800 bg-zinc-950/60"].join(" ")}>
        {exchange === "" ? (
          <span className="text-zinc-600">Select an account first</span>
        ) : (
          <span className="font-medium capitalize text-zinc-200">{exchange}</span>
        )}
      </div>
    </div>
  );
}

/** How many filtered pairs to render at once. A venue's full set can be thousands
 *  (Binance); this caps the DOM while a "keep typing" hint covers the remainder. */
const MAX_PAIR_RESULTS = 100;

/**
 * A searchable typeahead over an account's live tradable pairs (brief item 3).
 *
 * WHY THIS RATHER THAN A <select> OR <datalist>: Gemini returns 300+ symbols and
 * Binance thousands. A native <select> that long is unscannable; a <datalist>
 * still lets a person commit free-typed junk -- the exact mistake this rewiring
 * removes. A combobox filters fast AND constrains the committed value to a real
 * symbol: the parent's `pair` is only ever set to a member of `pairs`.
 *
 * Keyed on the account in the parent, so selecting a different account remounts
 * this and its query/highlight reset cleanly -- a stale query can never survive.
 */
function PairCombobox({
  id,
  pairs,
  value,
  onChange,
  disabled,
  fieldError,
}: {
  id: string;
  pairs: readonly string[];
  value: string;
  onChange: (pair: string) => void;
  disabled: boolean;
  fieldError?: string;
}) {
  /*
   * The search text starts as whatever pair is already committed, so a form that
   * opens with a pair (a proposal prefill) shows it in the box instead of an empty
   * field over a hidden value. For a manual creation `value` is `""` and this is
   * exactly what it always was. Read once: `onInput` owns it from then on.
   */
  const [query, setQuery] = useState(value);
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);

  // O(1) membership for committing an exactly-typed value on blur.
  const pairSet = useMemo(() => new Set(pairs.map((p) => p.toUpperCase())), [pairs]);

  const matches = useMemo(() => {
    const q = query.trim().toUpperCase();
    if (q === "") return pairs;
    // Prefix matches first (BTC → BTCUSDT before ...), then other substrings.
    const starts: string[] = [];
    const contains: string[] = [];
    for (const p of pairs) {
      const u = p.toUpperCase();
      if (u.startsWith(q)) starts.push(p);
      else if (u.includes(q)) contains.push(p);
    }
    return [...starts, ...contains];
  }, [pairs, query]);
  const shown = matches.slice(0, MAX_PAIR_RESULTS);

  // Close the listbox on an outside click (a blur alone misses non-focusable targets).
  useEffect(() => {
    if (!open) return;
    function onDocMouseDown(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onDocMouseDown);
    return () => document.removeEventListener("mousedown", onDocMouseDown);
  }, [open]);

  function commit(pair: string) {
    onChange(pair);
    setQuery(pair);
    setOpen(false);
  }

  function onInput(next: string) {
    setQuery(next);
    setOpen(true);
    setHighlight(0);
    // Clear any committed pair the moment the text stops naming it, so a stale
    // value can never be submitted behind text that no longer matches.
    if (value !== "" && next.toUpperCase() !== value.toUpperCase()) onChange("");
  }

  function onBlur() {
    // Honour an exactly-typed symbol the person never clicked (case-insensitive),
    // committing the canonically-cased pair from the list.
    const q = query.trim().toUpperCase();
    if (value === "" && pairSet.has(q)) {
      const exact = pairs.find((p) => p.toUpperCase() === q);
      if (exact !== undefined) {
        onChange(exact);
        setQuery(exact);
      }
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (!open) setOpen(true);
      else setHighlight((h) => Math.min(h + 1, shown.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setHighlight((h) => Math.max(h - 1, 0));
    } else if (event.key === "Enter") {
      if (open && shown[highlight] !== undefined) {
        event.preventDefault(); // pick the highlighted pair; do NOT submit the form
        commit(shown[highlight]);
      }
    } else if (event.key === "Escape") {
      setOpen(false);
    }
  }

  return (
    <div ref={containerRef} className="relative">
      <input
        id={id}
        type="text"
        role="combobox"
        aria-expanded={open}
        aria-autocomplete="list"
        aria-controls={`${id}-listbox`}
        aria-invalid={fieldError !== undefined}
        autoComplete="off"
        spellCheck={false}
        value={query}
        disabled={disabled}
        placeholder="Type to search, e.g. BTC"
        onChange={(event) => onInput(event.target.value)}
        onFocus={() => setOpen(true)}
        onBlur={onBlur}
        onKeyDown={onKeyDown}
        className={[INPUT_BASE, inputBorder(fieldError !== undefined)].join(" ")}
      />
      {open && !disabled && shown.length > 0 && (
        <ul
          id={`${id}-listbox`}
          role="listbox"
          className="absolute z-10 mt-1 max-h-64 w-full overflow-auto rounded-md border border-zinc-700 bg-zinc-950 py-1 shadow-xl"
        >
          {shown.map((pair, index) => {
            const active = index === highlight;
            const selected = pair.toUpperCase() === value.toUpperCase();
            return (
              <li
                key={pair}
                role="option"
                aria-selected={selected}
                // onMouseDown (not onClick) so the pick lands BEFORE the input's blur.
                onMouseDown={(event) => {
                  event.preventDefault();
                  commit(pair);
                }}
                onMouseEnter={() => setHighlight(index)}
                className={[
                  "cursor-pointer px-3 py-1.5 text-sm",
                  active ? "bg-emerald-600/20 text-emerald-100" : "text-zinc-200",
                ].join(" ")}
              >
                {pair}
              </li>
            );
          })}
          {matches.length > shown.length && (
            <li className="px-3 py-1.5 text-xs text-zinc-500">
              {(matches.length - shown.length).toLocaleString()} more. Keep typing to narrow the list.
            </li>
          )}
        </ul>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------

export function CreateBot() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  /*
   * ── THE PREFILL, READ ONCE AND NEVER AGAIN ──
   *
   * `useState` with an initialiser rather than `useMemo`, because "once, at mount"
   * is exactly the semantics wanted and is the semantics `useState` guarantees --
   * `useMemo` is a cache with no such promise. Every use below is a DEFAULT VALUE
   * for another piece of state, so from the first render onwards this form holds
   * ordinary state and the URL is history.
   *
   * `null` for an ordinary manual visit, and `readProposalPrefill` returns null for
   * anything lacking a real proposal id and a recognised strategy -- so prefilled
   * values can never appear without the banner that explains them.
   */
  const [prefill] = useState(() => readProposalPrefill(searchParams));
  /*
   * ── THE CLONE PREFILL, READ THE SAME WAY, FROM A DIFFERENT DECODER ──
   *
   * Also once, also at mount, also null for an ordinary manual visit.
   * `readBotClonePrefill` returns null for anything lacking a real `cloneFrom`
   * and a recognised `strategy`, AND for any URL that carries a `proposalId` --
   * so the two can never both answer, and prefilled values can never appear
   * under the wrong banner.
   *
   * ⚠ THE PROPOSAL IS ASKED FIRST AND THE GUARD IS STILL IN THE DECODER. The
   * `prefill === null` short-circuit here is an optimisation, not the safety
   * property: `readBotClonePrefill` refuses a proposal-bearing URL by itself, so
   * this order cannot be the thing that keeps the two apart. A test pins that.
   */
  const [clonePrefill] = useState(() =>
    prefill === null ? readBotClonePrefill(searchParams) : null,
  );
  /*
   * ONE SEED FOR THE STATE BELOW, whichever decoder answered. Both prefill types
   * satisfy `FormPrefillSeed` structurally, so every `useState` initialiser reads
   * one value of one type and no line below branches on where it came from. Null
   * for a manual visit, which is what every `??` fallback here has always meant.
   */
  const seed: FormPrefillSeed | null = prefill ?? clonePrefill;
  const gridPrefill = seed?.fields.strategy === "grid" ? seed.fields : null;
  const dcaPrefill = seed?.fields.strategy === "dca" ? seed.fields : null;

  /*
   * ⚠ `CreatableStrategy`, NOT `Strategy`. The two diverged when `Strategy` grew
   * its `trailing_stop` member (spec 22): the bot LIST and DETAIL pages must
   * render every strategy that exists, but this form can only build the ones
   * `CreateBotRequest` has a params shape for, and the toggle below offers
   * exactly those. Deriving the type from the request rather than restating it
   * means a strategy becomes selectable here only when the request it produces
   * is real -- and until then the omission is a compile error, not a form that
   * submits a body the backend has no branch for.
   *
   * The seed cannot widen it either: both prefill decoders refuse an
   * unrecognised strategy outright (`isCloneStrategy`), so a clone link from a
   * trailing-stop bot yields no prefill rather than a half-filled DCA form.
   */
  const [strategy, setStrategy] = useState<CreatableStrategy>(() => seed?.strategy ?? "dca");

  // Shared fields.
  const [botInstanceId, setBotInstanceId] = useState(generatedId);
  const [accountLabel, setAccountLabel] = useState(() => seed?.accountLabel ?? "");
  // Read-only, derived from the selected account (step 11); never an input, never sent.
  // ⚠ NOT CARRIED BY EITHER PREFILL, deliberately -- the account registry is the
  // authority on which venue an account trades at, and a carried value could
  // contradict it.
  const [exchange, setExchange] = useState("");
  const [pair, setPair] = useState(() => seed?.pair ?? "");
  const [capitalAsset, setCapitalAsset] = useState(() => seed?.capitalAsset ?? "USDT");
  const [allocatedCapital, setAllocatedCapital] = useState(() => seed?.allocatedCapital ?? "");

  // DCA fields. Each falls back to EXACTLY the default it had before the prefill
  // existed, so a manual visit is byte-identical to what it always was.
  const [baseOrderSize, setBaseOrderSize] = useState(() => dcaPrefill?.baseOrderSize ?? "");
  const [additionalOrderSize, setAdditionalOrderSize] = useState(
    () => dcaPrefill?.additionalOrderSize ?? "",
  );
  const [stepMultiplier, setStepMultiplier] = useState(() => dcaPrefill?.stepMultiplier ?? "1");
  const [dropPct, setDropPct] = useState(() => dcaPrefill?.dropPct ?? "");
  const [maxAdditionalBuys, setMaxAdditionalBuys] = useState(
    () => dcaPrefill?.maxAdditionalBuys ?? "0",
  );
  const [dcaTakeProfitPct, setDcaTakeProfitPct] = useState(() => dcaPrefill?.dcaTakeProfitPct ?? "");
  const [dcaStopLossPct, setDcaStopLossPct] = useState(() => dcaPrefill?.dcaStopLossPct ?? "");
  const [autoRestart, setAutoRestart] = useState(() => dcaPrefill?.autoRestart ?? false);

  // Grid fields.
  const [upperBound, setUpperBound] = useState(() => gridPrefill?.upperBound ?? "");
  const [lowerBound, setLowerBound] = useState(() => gridPrefill?.lowerBound ?? "");
  const [gridLines, setGridLines] = useState(() => gridPrefill?.gridLines ?? "");
  const [spacing, setSpacing] = useState<"arithmetic" | "geometric">(
    () => gridPrefill?.spacing ?? "arithmetic",
  );
  const [orderSize, setOrderSize] = useState(() => gridPrefill?.orderSize ?? "");
  const [gridStopLossPct, setGridStopLossPct] = useState(() => gridPrefill?.gridStopLossPct ?? "");
  const [breakoutTakeProfit, setBreakoutTakeProfit] = useState(
    () => gridPrefill?.breakoutTakeProfit ?? true,
  );
  const [breakoutThresholdPct, setBreakoutThresholdPct] = useState(
    () => gridPrefill?.breakoutThresholdPct ?? "",
  );
  const [takeProfitAmount, setTakeProfitAmount] = useState(() => gridPrefill?.takeProfitAmount ?? "");

  const [fieldErrors, setFieldErrors] = useState<Errors>({});
  const [submitting, setSubmitting] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  /*
   * ⚠ THE ONE SUCCESS THAT MUST NOT NAVIGATE AWAY. `POST /api/bots` answers 201
   * with `proposalLink.recorded: false` when the bot WAS created but the outcome
   * write afterwards failed -- decision log 45's deliberate soft failure, which
   * exists because failing the response would tell an operator creation failed
   * when it did not, and the recovery they would attempt (creating it again) is
   * the worst available action. That branch has been unreachable from this
   * dashboard until now, because this form never sent a `proposalId`. Sending one
   * makes it reachable, so it is handled: the bot is real and is linked to, the
   * missing record is stated, and the submit control is gone so it cannot be
   * pressed twice.
   */
  const [createdWithoutLink, setCreatedWithoutLink] = useState<
    { readonly botId: string; readonly link: ProposalLink } | null
  >(null);

  // Account registry (step 11): the real list the account dropdown reads. First
  // of two sequential real calls; `accountsReload` bumps to retry after a failure.
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [accountsLoading, setAccountsLoading] = useState(true);
  const [accountsError, setAccountsError] = useState<string | null>(null);
  const [accountsReload, setAccountsReload] = useState(0);

  // The selected account's live tradable pairs (step 11). Second sequential call;
  // cleared and refetched on every account change; `pairsReload` bumps to retry.
  const [pairs, setPairs] = useState<string[]>([]);
  const [pairsLoading, setPairsLoading] = useState(false);
  const [pairsError, setPairsError] = useState<Outcome | null>(null);
  const [pairsReload, setPairsReload] = useState(0);

  // Best-effort suggestions for the capital-asset field only. Account and pair are
  // now driven by the registry (below), so this no longer feeds them -- it just
  // offers assets already in use so an operator can pick USDT/USD rather than
  // retype it. Purely a convenience: the field stays free text and a failed fetch
  // is ignored.
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

  // Load the registered accounts on mount (and on an explicit retry). The account
  // dropdown shows a loading row until this resolves (brief item 5).
  useEffect(() => {
    const controller = new AbortController();
    setAccountsLoading(true);
    setAccountsError(null);
    fetchAccounts(controller.signal)
      .then((rows) => {
        setAccounts(rows);
        setAccountsLoading(false);
      })
      .catch((error) => {
        if (isAbort(error)) return;
        setAccounts([]);
        setAccountsError(
          error instanceof ApiError
            ? `Couldn’t load accounts: ${error.message}`
            : "Couldn’t load accounts. Check your connection and try again.",
        );
        setAccountsLoading(false);
      });
    return () => controller.abort();
  }, [accountsReload]);

  /*
   * Reconcile a selected account against the registry once the list is in hand.
   *
   * `onSelectAccount` already does this for a click, and a click can only pick an
   * account that is in the list. A PRE-FILLED account label arrives before the
   * list does and was chosen by something else entirely -- a proposal made
   * possibly hours ago (decision log 45 measured a real 7.8-hour gap) -- so both
   * halves have to be handled here rather than assumed:
   *
   *   * STILL REGISTERED: fill in the read-only exchange from the same response
   *     the dropdown reads, so the venue box is not blank beside a chosen account.
   *   * NO LONGER REGISTERED: clear it and say so. Leaving it would put a value in
   *     the <select> that has no <option>, which renders as though a different
   *     account were chosen -- a wrong account displayed on the screen that
   *     commits capital. This is the account half of "real state may have changed
   *     since the proposal was generated", surfaced as a real, current validation
   *     failure rather than carried silently to the server.
   *
   * Inert for a manual creation: the label always matches a row, so this only ever
   * re-sets `exchange` to the value `onSelectAccount` already set.
   */
  useEffect(() => {
    if (accountLabel === "" || accounts.length === 0) return;
    const account = accounts.find((a) => a.accountLabel === accountLabel);
    if (account === undefined) {
      setAccountLabel("");
      setExchange("");
      setPair("");
      setFieldErrors((prev) => ({
        ...prev,
        accountLabel: `“${accountLabel}” is not a registered account any more. Pick one.`,
      }));
      return;
    }
    setExchange(account.exchange);
  }, [accounts, accountLabel]);

  // Whenever the selected account changes (or an explicit retry), fetch THAT
  // account's live tradable pairs -- the second sequential real call (brief items
  // 3, 5). Cleared first, so the pair list can never belong to a previous account;
  // a superseded in-flight fetch is aborted by the cleanup, so only the current
  // account's result ever lands.
  useEffect(() => {
    if (accountLabel === "") {
      setPairs([]);
      setPairsError(null);
      setPairsLoading(false);
      return;
    }
    const controller = new AbortController();
    const label = accountLabel;
    setPairsLoading(true);
    setPairs([]);
    setPairsError(null);
    fetchAccountSymbols(label, controller.signal)
      .then((result) => {
        setPairs([...result.pairs]);
        setPairsLoading(false);
      })
      .catch((error) => {
        if (isAbort(error)) return;
        setPairsError(describeSymbolsError(error, label));
        setPairsLoading(false);
      });
    return () => controller.abort();
  }, [accountLabel, pairsReload]);

  function switchStrategy(next: CreatableStrategy) {
    if (next === strategy) return;
    setStrategy(next);
    // Clear cross-strategy validation noise and any stale outcome.
    setFieldErrors({});
    setOutcome(null);
  }

  /** Pick an account: store its label AND its exchange (from the same accounts
   *  response), and clear the pair -- a pair from the previous account has no
   *  meaning here (brief items 1-3). The symbols effect refetches on the change. */
  function onSelectAccount(label: string) {
    if (label === accountLabel) return;
    const account = accounts.find((a) => a.accountLabel === label);
    setAccountLabel(label);
    setExchange(account?.exchange ?? "");
    setPair("");
    setFieldErrors((prev) => {
      const next = { ...prev };
      delete next.accountLabel;
      delete next.pair;
      return next;
    });
    setOutcome(null);
  }

  function validate(): Errors {
    const errors: Errors = {};

    // The server's own rule, imported rather than restated -- see botId.ts. It
    // also applies the selected venue's client-order-id cap, which is why
    // `exchange` is passed: the form knows the venue read-only, so the operator
    // is told here rather than by a 400 after submitting.
    const botIdError = botInstanceIdError(botInstanceId, exchange);
    if (botIdError !== null) errors.botInstanceId = botIdError;
    if (accountLabel.trim() === "") errors.accountLabel = "Select an account.";
    // exchange is derived read-only from the account and never submitted, so it
    // is not validated here -- picking a valid account is what makes it valid.
    if (pair.trim() === "") errors.pair = "Select a trading pair.";
    else if (pairs.length > 0 && !pairs.includes(pair)) errors.pair = "Choose a pair from the list.";
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
      // NB: no `exchange` -- the registry derives it from accountLabel. Sending a
      // separately-typed value could disagree with the account; omitting it makes
      // that impossible (see CreateBotBase in api/types.ts).
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
        title: "A few fields need fixing",
        text: "Fix the highlighted fields, then create the bot. Nothing was submitted.",
      });
      return;
    }

    setOutcome(null);
    setSubmitting(true);
    try {
      /*
       * ⚠ THE ONLY PLACE IN THIS DASHBOARD THAT EVER SENDS A `proposalId`, and it
       * is inside the submit handler by construction: this line runs when a human
       * has pressed Create and validation has passed, and at no other moment.
       * Navigating to a pre-filled form, editing it, and leaving send nothing at
       * all -- there is no request to send. That is the whole of the
       * "navigation is not approval" guarantee on this side, and
       * `prefill-does-not-approve.test.ts` enforces the "only place" half over
       * source, since nothing else can see it.
       *
       * `withProposalId` omits the field entirely when there is no prefill, so a
       * manual creation's body is byte-identical to what it always was.
       */
      const bot = await createBot(withProposalId(buildRequest(), prefill?.proposalId ?? null));
      if (bot.proposalLink !== undefined && !bot.proposalLink.recorded) {
        // The bot IS created. Stay put and say so rather than navigating away from
        // the one place this failure can be reported. See `createdWithoutLink`.
        setCreatedWithoutLink({ botId: bot.id, link: bot.proposalLink });
        setSubmitting(false);
        return;
      }
      // Success: go straight to the created bot's detail page (brief item 6). The
      // component unmounts on navigation, so no post-success state reset is needed.
      navigate(`/bots/${encodeURIComponent(bot.id)}`);
    } catch (error) {
      setOutcome(describeError(error, botInstanceId.trim(), accountLabel.trim(), capitalAsset.trim()));
      // A taken id is worth pinning to its field as well as the banner.
      if (error instanceof ApiError && (error.code === "duplicate_bot_instance" || error.code === "already_created")) {
        setFieldErrors((prev) => ({ ...prev, botInstanceId: "Already taken. Choose another." }));
      }
      setSubmitting(false); // stay on the form to correct and retry
    }
  }

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
          Submitting saves the configuration and reserves the capital. No orders are placed until you start
          the bot, and the server checks the capital against this account’s live ledger.
        </p>
      </div>

      {/*
       * ⚠ ABOVE THE FORM, NOT BESIDE A FIELD. If these values came from a
       * proposal, that is a fact about EVERY box below, and it has to be read
       * before any of them rather than found while scrolling. Absent entirely on a
       * manual creation -- `prefill` is null and this renders nothing, which is
       * why nothing else on this page needed a branch.
       */}
      {prefill !== null && <ProposalPrefillBanner prefill={prefill} currentStrategy={strategy} />}
      {/*
       * The clone banner, in the same place and for the same reason. Mutually
       * exclusive with the one above by construction -- `clonePrefill` is only
       * read when `prefill` is null, and the decoder refuses a proposal-bearing
       * URL anyway -- so at most one of these ever renders, and a manual creation
       * renders neither.
       */}
      {clonePrefill !== null && (
        <CloneSourceBanner prefill={clonePrefill} currentStrategy={strategy} />
      )}

      {/* Suggestion list for the capital-asset field only (best effort). Account
          and pair are now driven by the registry, not scraped from existing bots. */}
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
            help={botIdHelp(exchange)}
            disabled={submitting}
          />
          <AccountSelect
            accounts={accounts}
            value={accountLabel}
            onChange={onSelectAccount}
            loading={accountsLoading}
            error={accountsError}
            onRetry={() => setAccountsReload((n) => n + 1)}
            disabled={submitting}
            fieldError={fieldErrors.accountLabel}
          />
          <div className="grid gap-4 sm:grid-cols-2">
            <ExchangeDisplay exchange={exchange} />
            <Field
              label="Pair"
              htmlFor="pair"
              required
              help={
                accountLabel === ""
                  ? "Pick an account first. Its tradable pairs load here."
                  : pairs.length > 0
                    ? `Search ${pairs.length.toLocaleString()} tradable pairs on this account.`
                    : "The account’s live tradable pairs."
              }
              error={fieldErrors.pair}
            >
              {accountLabel === "" ? (
                <input
                  id="pair"
                  type="text"
                  disabled
                  placeholder="Select an account first"
                  className={[INPUT_BASE, inputBorder(false)].join(" ")}
                />
              ) : pairsLoading ? (
                <LoadingRow text="Loading tradable pairs…" />
              ) : pairsError !== null ? (
                <div className={["mt-1.5 rounded-md border px-3 py-2 text-sm", OUTCOME_CLASS[pairsError.tone]].join(" ")}>
                  <div className="font-semibold">{pairsError.title}</div>
                  <p className="mt-0.5 text-[0.8125rem] leading-snug opacity-90">{pairsError.text}</p>
                  <button
                    type="button"
                    onClick={() => setPairsReload((n) => n + 1)}
                    className="mt-1.5 text-xs font-medium underline underline-offset-2"
                  >
                    Try again
                  </button>
                </div>
              ) : pairs.length === 0 ? (
                <div className="mt-1.5 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-100">
                  This account reported no tradable pairs.
                </div>
              ) : (
                <PairCombobox
                  key={accountLabel}
                  id="pair"
                  pairs={pairs}
                  value={pair}
                  onChange={setPair}
                  disabled={submitting}
                  fieldError={fieldErrors.pair}
                />
              )}
            </Field>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <TextInput
              id="capitalAsset"
              label="Capital asset"
              value={capitalAsset}
              onChange={setCapitalAsset}
              required
              error={fieldErrors.capitalAsset}
              help="The quote asset your capital is held in, usually the pair’s quote (USDT)."
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
                help="When off, the bot stays stopped after a take-profit exit so a person can review it."
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
                  help="Bottom of the grid: the lowest buy line."
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
                  help="Top of the grid: the highest sell line."
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
                help="Rise above average entry that closes the position. Mandatory for DCA: it defines the cycle’s exit."
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
                help="Falling this far below the lowest grid line halts the bot. Mandatory."
                disabled={submitting}
              />
              <TextInput
                id="takeProfitAmount"
                label="Take-profit amount"
                value={takeProfitAmount}
                onChange={setTakeProfitAmount}
                numeric
                error={fieldErrors.takeProfitAmount}
                help="Optional for grid. Halts once realized profit reaches this amount (a profit amount, not a percentage). Leave blank to rely on the stop-loss and the breakout exit below."
                disabled={submitting}
              />
              <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-3">
                <Checkbox
                  id="breakoutTakeProfit"
                  label="Cash out on an upside breakout"
                  checked={breakoutTakeProfit}
                  onChange={setBreakoutTakeProfit}
                  help="Recommended, and on by default: if price runs above the grid, treat it as a take-profit rather than leaving the bot idle."
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
                      help="Optional. How far above the top line counts as a breakout; leave blank to use the default."
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

        {createdWithoutLink !== null ? (
          /*
           * ⚠ CREATED, BUT NOT LINKED. Both halves stated, because reporting only
           * one of them is how an operator either re-submits a bot that already
           * exists or believes a proposal was recorded when it was not. No submit
           * control here at all -- the action that would repeat the creation is
           * simply not on the screen.
           */
          <div
            role="alert"
            className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-100"
          >
            <div className="font-semibold">
              The bot was created. The link back to its proposal was not recorded.
            </div>
            <p className="mt-0.5 text-[0.8125rem] leading-snug opacity-90">
              “{createdWithoutLink.botId}” exists and its capital is reserved —{" "}
              <strong>do not submit this form again</strong>. What failed afterwards was the write
              recording that proposal{" "}
              <code className="tabular">{createdWithoutLink.link.proposalId}</code> was approved, so
              that proposal still reads as pending and nothing now connects this bot back to the
              reasoning behind it. The server said:{" "}
              <span className="font-mono">{createdWithoutLink.link.error ?? "(no message)"}</span>
            </p>
            <Link
              to={`/bots/${encodeURIComponent(createdWithoutLink.botId)}`}
              className="mt-1.5 inline-block text-[0.8125rem] font-medium underline underline-offset-2"
            >
              Go to the bot →
            </Link>
          </div>
        ) : (
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
        )}
      </form>
    </div>
  );
}
