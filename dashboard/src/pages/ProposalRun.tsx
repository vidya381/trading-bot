/**
 * `/proposal/run` — the NAMED-COIN trigger (spec 21.6).
 *
 * The first dashboard control that calls `/assess` and `/derive`. Everything it
 * decides lives in `src/research/` as pure, tested TypeScript; this file is the
 * form, the waiting states and the failure panel, and it renders a SUCCESSFUL run
 * through the same `ProposalView` the paste page renders through — unchanged, not
 * reimplemented.
 *
 * ── ⚠ THIS SPENDS REAL MONEY AND WRITES A PERMANENT RECORD ──
 *
 * One press is TWO paid Workers AI inferences and, on success, TWO permanent
 * rows in `proposals` that nothing in this system can delete (migration 0009,
 * section 8.7). The button says so, above the fold, rather than in a tooltip.
 *
 * ── ⚠ 21.1 IS UNTOUCHED ──
 *
 * There is no approve button here, no prefilled create-bot link, and nothing on
 * this page creates, starts or modifies a bot. A proposal becomes a bot only when
 * a human reads it and fills in the create-bot form, which runs every check it
 * runs today. This page shortens the path to READING a proposal; it does not
 * shorten the path to making one real.
 *
 * ── THE PASTE PAGE IS NOT REPLACED ──
 *
 * `/proposal` stays exactly as it is. It is the fallback and the debug tool: it
 * renders a response saved hours ago with no backend running, no Access session
 * and no spend, and it is where adversarial input gets tried — which is how entry
 * 45's blank-screen crash was found. A trigger cannot do either of those things.
 *
 * ── AUTHENTICATION ──
 *
 * None here, exactly as everywhere else in this dashboard. Cloudflare Access sits
 * in front of this origin and the browser's existing session cookie authenticates
 * the same-origin `/api/*` request automatically (`api/client.ts`, spec 11).
 * There is no token to attach and no login UI. An expired session comes back as
 * `unauthenticated` and is surfaced as that.
 */

import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { ApiError, fetchAccountSymbols, fetchAccounts, fetchAssess, fetchDerive } from "../api/client";
import type { Account } from "../api/types";
import type { AssessResponse } from "../api/research-types";
import { ErrorBoundary } from "../components/ErrorBoundary";
import { ProposalView } from "../components/ProposalView";
import { canonicalPair, suggestPairs } from "../research/pairMatch";
import {
  observedRunRangeSeconds,
  observedStageRangeSeconds,
  runProposal,
  type ProposalClient,
  type ResearchRequest,
  type RunOutcome,
  type RunPhase,
} from "../research/proposalRun";
import { describeRunFailure, type RunStage, type StageFailure } from "../research/runErrors";

/**
 * The seven intervals `handlers.ts` accepts.
 *
 * ⚠ THIS IS NOT THE VERIFIED SET AND MUST NOT BE READ AS ONE. `VERIFIED_INTERVALS`
 * (`src/research/candles.ts`) is currently just `["1m"]`, and anything else is
 * refused with `interval_not_verified`. That list is deliberately NOT mirrored
 * here: `candles.ts` has imports so the dashboard cannot import it, and a
 * hand-copied narrower list is exactly the mirror entry 45 argues against — it
 * would keep refusing an interval on the day someone verifies it, silently, with
 * nothing failing to compile. So the backend stays the authority: every real
 * interval is offered, `1m` is the default because it is the one known to work,
 * and an unverified choice comes back as the endpoint's own refusal.
 */
const INTERVALS: readonly string[] = ["1m", "5m", "15m", "30m", "1h", "6h", "1d"];

const INPUT =
  "mt-1.5 block w-full rounded-md border bg-zinc-950 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:ring-1 focus:ring-emerald-500/40 disabled:opacity-50";

/** The real client, wired once. Injected into `runProposal` so tests never fetch. */
const REAL_CLIENT: ProposalClient = {
  assess: (request, signal) =>
    fetchAssess(
      request.accountLabel,
      {
        pair: request.pair,
        interval: request.interval,
        ...(request.since === undefined ? {} : { since: request.since }),
        ...(request.quoteAssets === undefined ? {} : { quoteAssets: request.quoteAssets }),
      },
      signal,
    ),
  derive: (request, assessment, signal) =>
    fetchDerive(
      request.accountLabel,
      {
        pair: request.pair,
        interval: request.interval,
        ...(request.since === undefined ? {} : { since: request.since }),
        ...(request.quoteAssets === undefined ? {} : { quoteAssets: request.quoteAssets }),
      },
      assessment,
      signal,
    ),
};

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

// ---------------------------------------------------------------------------
// The waiting states
// ---------------------------------------------------------------------------

/** Seconds since a start instant, ticking once a second while a run is live. */
function useElapsedSeconds(startedAt: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (startedAt === null) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [startedAt]);
  return startedAt === null ? 0 : Math.max(0, Math.floor((now - startedAt) / 1000));
}

/**
 * ⚠ THE WAITING COPY IS A REPORT, NOT A PROGRESS BAR — AND NOT A PROMISE.
 *
 * There is no percentage and no countdown, on purpose. Nothing here knows how far
 * through a model call it is, and `MEASURED_LATENCY` is MODEL time only — the
 * gathers, the tradability check and the record write sit outside it, so a bar
 * built from those numbers would fill up and then sit at 100% while the request
 * was still genuinely running.
 *
 * ⚠ AND THE RANGE IS NOT A CEILING, WHICH THIS PAGE LEARNED THE HARD WAY. The
 * first version rendered a bare "Derive has taken 27-47s", and the first real run
 * through it took 77s (decision log 46). A bare range shown during a wait reads
 * as a bound on that wait, however honestly it was sourced. So every range here
 * now carries its SAMPLE COUNT and the words that say what it is — a record of
 * what has happened — and the ELAPSED COUNTER is the primary readout, because it
 * is the only number on screen that is a fact about the run in progress.
 *
 * The second stage's line names the strategy Assess REALLY chose, which is a fact
 * the first stage could not have shown.
 */
function WaitingPanel({ phase, startedAt }: { phase: RunPhase; startedAt: number }) {
  const elapsed = useElapsedSeconds(startedAt);
  const assessRange = observedStageRangeSeconds("assess");
  const deriveRange = observedStageRangeSeconds("derive");
  const assessing = phase.kind === "assessing";
  const strategy = phase.kind === "deriving" ? phase.assess.assess.strategy : null;
  const range = assessing ? assessRange : deriveRange;

  return (
    <section
      aria-live="polite"
      className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 px-4 py-4"
    >
      <div className="flex items-center gap-3">
        <span
          className="inline-block h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-emerald-700 border-t-emerald-300"
          aria-hidden
        />
        <div>
          <p className="text-sm font-semibold text-emerald-100">
            {assessing
              ? "Asking which strategy fits…"
              : `Deciding ${strategy === null ? "" : `${strategy} `}parameters…`}
          </p>
          <p className="text-xs text-emerald-200/70">
            <span className="font-semibold text-emerald-100">{elapsed}s elapsed</span> on this
            stage. For reference only: {assessing ? "Assess" : "Derive"} has run{" "}
            {range.minS}–{range.maxS}s of model time across {range.runs} measured runs — that is
            what has happened before, not a limit on this one.
          </p>
        </div>
      </div>

      <ol className="mt-3 space-y-1 text-xs">
        <li className={assessing ? "text-emerald-100" : "text-emerald-300/60"}>
          {assessing ? "▶" : "✓"} Stage 2 — Assess: gather this pair&rsquo;s real candles and ask a
          model which strategy fits.
          {!assessing && strategy !== null && (
            <>
              {" "}
              Answered <span className="font-semibold text-emerald-100">{strategy}</span> in{" "}
              {(phase as { assess: AssessResponse }).assess.assess.latencyMs.toLocaleString()} ms of
              model time.
            </>
          )}
        </li>
        <li className={assessing ? "text-emerald-300/40" : "text-emerald-100"}>
          {assessing ? "·" : "▶"} Stage 3 — Derive: gather again, re-verify every citation against
          the new data, then ask for real parameters.
        </li>
      </ol>

      <p className="mt-3 text-[11px] text-emerald-200/50">
        Those figures are model time only — each call also fetches candles and reads the ledger
        before, and writes its proposal record after, so the real wait is longer.{" "}
        <strong className="text-emerald-200/70">
          Nothing caps how long a run can take: the longest Derive on record ({deriveRange.maxS}s)
          happened on a run this page was calling a 47-second job at the time.
        </strong>{" "}
        Leaving this page abandons the run; the inferences already made are still paid for and
        still recorded.
      </p>
    </section>
  );
}

// ---------------------------------------------------------------------------
// The failure panel
// ---------------------------------------------------------------------------

const TONE_CLASS: Record<StageFailure["tone"], string> = {
  error: "border-red-500/30 bg-red-500/5 text-red-200",
  warning: "border-amber-500/40 bg-amber-500/10 text-amber-100",
};

/**
 * ⚠ THE STAGE IS THE HEADLINE AND THE REAL CODE IS ALWAYS ON SCREEN.
 *
 * A Derive refusal after a successful Assess is a materially different situation
 * from an Assess refusal — an inference has been paid for, a strategy judgement
 * exists and is still good, and the right next move is usually different. So the
 * stage is a badge, not a sentence buried in prose, and `assessAlreadySpent` gets
 * its own line rather than being left to inference.
 *
 * `code` and the HTTP status are rendered verbatim in monospace, always. That is
 * the requirement this panel exists for: `citation_unknown`, `pair_not_tradable`
 * and `decoder/invalid_parameter` are different facts, and a reader who is only
 * told "something went wrong" cannot tell which one happened.
 */
function FailurePanel({ failure, assess }: { failure: StageFailure; assess: AssessResponse | null }) {
  return (
    <section role="alert" className={`rounded-lg border px-4 py-4 ${TONE_CLASS[failure.tone]}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded border border-current/40 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider">
          {failure.stage === "assess" ? "Stage 2 · Assess" : "Stage 3 · Derive"}
        </span>
        <h2 className="text-sm font-semibold">{failure.title}</h2>
      </div>

      <p className="mt-2 text-xs leading-relaxed">{failure.text}</p>
      {failure.next !== "" && <p className="mt-2 text-xs leading-relaxed">{failure.next}</p>}

      <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[11px]">
        <dt className="opacity-70">Code</dt>
        <dd className="font-mono">{failure.code === "" ? "(none returned)" : failure.code}</dd>
        <dt className="opacity-70">HTTP</dt>
        <dd className="font-mono">{failure.status === 0 ? "(no response)" : failure.status}</dd>
        {failure.message !== "" && (
          <>
            <dt className="opacity-70">Endpoint said</dt>
            <dd className="font-mono leading-relaxed">{failure.message}</dd>
          </>
        )}
      </dl>

      {failure.assessAlreadySpent && (
        <p className="mt-3 border-t border-current/20 pt-2 text-[11px]">
          ⚠ The Assess inference was already made and paid for
          {assess === null ? "" : `, and its proposal record is ${assess.proposalId}`}. Running this
          again spends a second one.
        </p>
      )}

      {assess !== null && (
        <p className="mt-2 text-[11px]">
          Assess itself succeeded: it chose{" "}
          <span className="font-semibold">{assess.assess.strategy}</span> with{" "}
          {assess.assess.claims.length} cited claim
          {assess.assess.claims.length === 1 ? "" : "s"}. Only the parameter derivation failed.
        </p>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------

type Screen =
  | { readonly kind: "form" }
  | { readonly kind: "running"; readonly phase: RunPhase; readonly startedAt: number }
  | { readonly kind: "settled"; readonly outcome: RunOutcome };

export function ProposalRun() {
  const [accounts, setAccounts] = useState<readonly Account[]>([]);
  const [accountsError, setAccountsError] = useState<string | null>(null);
  const [accountsLoading, setAccountsLoading] = useState(true);

  const [accountLabel, setAccountLabel] = useState("");
  const [pairs, setPairs] = useState<readonly string[]>([]);
  const [pairsError, setPairsError] = useState<string | null>(null);
  const [pairsLoading, setPairsLoading] = useState(false);

  const [typedPair, setTypedPair] = useState("");
  const [interval, setInterval] = useState("1m");
  const [screen, setScreen] = useState<Screen>({ kind: "form" });

  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setAccountsLoading(true);
    fetchAccounts(controller.signal)
      .then((list) => {
        setAccounts(list);
        setAccountsError(null);
      })
      .catch((error: unknown) => {
        if (isAbort(error)) return;
        setAccountsError(
          error instanceof ApiError
            ? `${error.message} (${error.code})`
            : "The account list could not be loaded.",
        );
      })
      .finally(() => setAccountsLoading(false));
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (accountLabel === "") {
      setPairs([]);
      setPairsError(null);
      return;
    }
    const controller = new AbortController();
    setPairsLoading(true);
    setPairsError(null);
    fetchAccountSymbols(accountLabel, controller.signal)
      .then((result) => setPairs(result.pairs))
      .catch((error: unknown) => {
        if (isAbort(error)) return;
        setPairs([]);
        setPairsError(
          error instanceof ApiError
            ? `${error.message} (${error.code})`
            : "This account's tradable pairs could not be loaded.",
        );
      })
      .finally(() => setPairsLoading(false));
    return () => controller.abort();
  }, [accountLabel]);

  // Abort any in-flight run when the page goes away. The inferences already made
  // are still paid for and still recorded -- aborting stops us waiting, not them.
  useEffect(() => () => abortRef.current?.abort(), []);

  const resolvedPair = canonicalPair(pairs, typedPair);
  const suggestions = suggestPairs(pairs, typedPair);
  // The venue's list is the only thing that can say "not a real symbol", so the
  // input is only judged once that list is actually in hand.
  const pairUnknown = typedPair.trim() !== "" && pairs.length > 0 && resolvedPair === null;
  /*
   * ⚠ A FAILED SYMBOLS LOAD MUST NOT LOCK THE BUTTON. `GET /symbols` is a real
   * exchange call behind a KV cache and it genuinely fails (the Binance geo-block
   * is a confirmed live example), and when it does this page holds no list to
   * check against -- which is not the same as knowing the pair is wrong. Gating on
   * `resolvedPair` alone would leave the run permanently unavailable while the
   * copy beside the field said "you can still type a symbol", and a control that
   * contradicts its own instructions is worse than one that is plainly disabled.
   *
   * `selectNamedCandidate` checks tradability for real on the server either way,
   * so the honest behaviour is to send what was typed and let the endpoint answer
   * with `pair_not_tradable` if it is wrong.
   */
  const effectivePair = resolvedPair ?? (pairs.length === 0 ? typedPair.trim() : "");
  const running = screen.kind === "running";
  const canRun = accountLabel !== "" && effectivePair !== "" && !running;
  const runRange = observedRunRangeSeconds();

  async function run() {
    if (accountLabel === "" || effectivePair === "") return;
    const controller = new AbortController();
    abortRef.current = controller;
    const startedAt = Date.now();
    setScreen({ kind: "running", phase: { kind: "assessing" }, startedAt });

    const request: ResearchRequest = {
      accountLabel,
      pair: effectivePair,
      interval,
    };

    // Which call was in flight, for the unexpected-throw path below.
    let reached: RunStage = "assess";

    try {
      const outcome = await runProposal(
        REAL_CLIENT,
        request,
        // Each phase restarts the elapsed clock, because the number that helps is
        // "how long has THIS call been running", not "how long since I pressed".
        (phase) => {
          if (phase.kind === "deriving") reached = "derive";
          setScreen({ kind: "running", phase, startedAt: Date.now() });
        },
        controller.signal,
      );
      setScreen({ kind: "settled", outcome });
    } catch (error) {
      // Deliberate cancellation. The page is going away; there is nothing to show.
      if (isAbort(error)) return;
      /*
       * ⚠ ANYTHING ELSE IS A BUG IN THIS DASHBOARD, AND IT STILL HAS TO BE
       * VISIBLE. `runProposal` refuses by RETURNING, so the only throws that
       * reach here are unexpected ones. Rethrowing would reject a promise nobody
       * awaits: React would not catch it, the error boundary would not catch it
       * (boundaries do not catch async throws), and the page would sit on
       * "Running…" forever — indistinguishable from a call that is still going,
       * which is the same class of unreadable failure as entry 45's blank screen.
       *
       * So it is shown, through the same panel, with `readFailure` reporting it
       * as what it literally is at status 0 rather than dressing it as a backend
       * refusal.
       */
      setScreen({
        kind: "settled",
        outcome: {
          kind: "failed",
          failure: describeRunFailure(reached, error),
          assess: null,
        },
      });
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-xl font-semibold text-zinc-100">Ask about a coin</h1>
          <p className="text-xs text-zinc-500">
            Spec 21.4, named entry point — assess one pair, then derive real parameters for review.
          </p>
        </div>
        <div className="flex items-center gap-3 text-sm">
          <Link to="/proposal" className="text-zinc-400 underline-offset-2 hover:text-zinc-200 hover:underline">
            Paste saved responses
          </Link>
          <Link to="/" className="text-zinc-400 underline-offset-2 hover:text-zinc-200 hover:underline">
            ← Back to bots
          </Link>
        </div>
      </div>

      <section className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-xs leading-relaxed text-amber-100">
        <p className="font-semibold">Running this spends real money and leaves a permanent record.</p>
        <p className="mt-1">
          One press makes <strong>two paid model calls</strong>. The {runRange.runs} whole runs
          measured so far took{" "}
          <strong>
            {runRange.minS}–{runRange.maxS} seconds
          </strong>{" "}
          of model time — and longer in real terms, because the data fetches sit outside that.{" "}
          <strong>That is a record of what has happened, not a limit</strong>: this project does
          not control inference time and has never established a ceiling. Each successful call
          writes a proposal row that nothing in this system can delete.
        </p>
        <p className="mt-1">
          It creates no bot and moves no capital. The proposal is something to read; the create-bot
          form is still the only way anything becomes real.
        </p>
      </section>

      <section className="space-y-4 rounded-lg border border-zinc-800 bg-zinc-900/40 px-4 py-4">
        <div>
          <label htmlFor="run-account" className="text-xs font-medium text-zinc-300">
            Account <span className="text-red-400">*</span>
          </label>
          <p className="text-[11px] text-zinc-500">
            Decides the venue, the tradable list and the capital ledger the parameters are sized
            against.
          </p>
          {accountsLoading ? (
            <p className="mt-1.5 text-sm text-zinc-400">Loading accounts…</p>
          ) : accountsError !== null ? (
            <p className="mt-1.5 text-sm text-red-300">{accountsError}</p>
          ) : (
            <select
              id="run-account"
              value={accountLabel}
              disabled={running}
              onChange={(event) => {
                setAccountLabel(event.target.value);
                setTypedPair("");
              }}
              className={`${INPUT} border-zinc-700`}
            >
              <option value="" disabled>
                Select an account…
              </option>
              {accounts.map((account) => (
                <option key={account.accountLabel} value={account.accountLabel}>
                  {account.accountLabel} ({account.exchange})
                </option>
              ))}
            </select>
          )}
        </div>

        <div>
          <label htmlFor="run-pair" className="text-xs font-medium text-zinc-300">
            Pair <span className="text-red-400">*</span>
          </label>
          <p className="text-[11px] text-zinc-500">
            The venue&rsquo;s own symbol. The account&rsquo;s real tradable list is behind this
            field; the endpoint checks tradability for itself either way.
          </p>
          <input
            id="run-pair"
            type="text"
            autoComplete="off"
            spellCheck={false}
            value={typedPair}
            disabled={running || accountLabel === ""}
            placeholder={accountLabel === "" ? "Select an account first" : "e.g. BTCUSD"}
            onChange={(event) => setTypedPair(event.target.value)}
            className={`${INPUT} ${pairUnknown ? "border-red-500/60" : "border-zinc-700"}`}
          />
          {pairsLoading && <p className="mt-1 text-[11px] text-zinc-500">Loading tradable pairs…</p>}
          {pairsError !== null && (
            <p className="mt-1 text-[11px] text-amber-300">
              {pairsError} You can still type a symbol — the endpoint checks it for real.
            </p>
          )}
          {suggestions.length > 0 && resolvedPair === null && (
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {suggestions.map((pair) => (
                <button
                  key={pair}
                  type="button"
                  onClick={() => setTypedPair(pair)}
                  className="rounded border border-zinc-700 px-2 py-0.5 font-mono text-[11px] text-zinc-300 hover:border-zinc-500 hover:text-zinc-100"
                >
                  {pair}
                </button>
              ))}
            </div>
          )}
          {pairUnknown && (
            <p className="mt-1 text-[11px] text-red-300">
              This account&rsquo;s venue does not list that symbol.
            </p>
          )}
        </div>

        <div>
          <label htmlFor="run-interval" className="text-xs font-medium text-zinc-300">
            Candle interval <span className="text-red-400">*</span>
          </label>
          <p className="text-[11px] text-zinc-500">
            No default on the endpoint, and it matters: a wrong interval does not error, it returns
            correctly-shaped candles of a different duration. Only intervals verified on the venue
            are accepted — <code>1m</code> is the one verified today, and anything else comes back
            as <code>interval_not_verified</code>.
          </p>
          <select
            id="run-interval"
            value={interval}
            disabled={running}
            onChange={(event) => setInterval(event.target.value)}
            className={`${INPUT} border-zinc-700`}
          >
            {INTERVALS.map((value) => (
              <option key={value} value={value}>
                {value}
                {value === "1m" ? " (verified)" : ""}
              </option>
            ))}
          </select>
        </div>

        <div className="flex flex-wrap items-center gap-3 border-t border-zinc-800 pt-4">
          <button
            type="button"
            disabled={!canRun}
            onClick={() => void run()}
            className="rounded-md bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-500 disabled:cursor-not-allowed disabled:bg-zinc-700 disabled:text-zinc-400"
          >
            {running ? "Running…" : "Run it — 2 paid model calls"}
          </button>
          {screen.kind === "settled" && (
            <span className="text-xs text-zinc-500">
              Change anything above and press again to run a fresh pair of calls.
            </span>
          )}
        </div>
      </section>

      {screen.kind === "running" && <WaitingPanel phase={screen.phase} startedAt={screen.startedAt} />}

      {screen.kind === "settled" && screen.outcome.kind === "failed" && (
        <FailurePanel failure={screen.outcome.failure} assess={screen.outcome.assess} />
      )}

      {screen.kind === "settled" && screen.outcome.kind === "ok" && (
        /*
         * ⚠ THE RENDERING PATH IS ENTRY 44'S, UNCHANGED. Same component, same
         * props, same nested error boundaries. A trigger that rendered its results
         * its own way would be a second proposal renderer, and the copy that
         * drifts is the one nobody is watching.
         *
         * `assess` is passed because we HAVE it: it enables Stage 2's own evidence
         * table and the cross-gather drift comparison, which a pasted derive
         * response alone cannot show. That comparison is more useful here than
         * anywhere, since the two gathers really did happen minutes apart.
         */
        <ErrorBoundary where="The proposal">
          <ProposalView derive={screen.outcome.derive} assess={screen.outcome.assess} />
        </ErrorBoundary>
      )}
    </div>
  );
}
