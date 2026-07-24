/**
 * The global kill switch control page (spec section 7.4; this session's brief).
 *
 * Its own top-level surface at `/kill-switch` -- NOT the per-bot detail page --
 * reachable without navigating into any specific bot (from the status strip's
 * kill-switch tile on the home page, and from the tripped banner anywhere). A
 * total-blast-radius control lives one deliberate click off the routine bot list
 * rather than inline beside it.
 *
 * Three parts:
 *   1. A prominent status card (item 1): ARMED or TRIPPED, and when tripped the
 *      reason, who pulled it, and exactly when.
 *   2. The TRIGGER control (KillSwitchTrigger): type-to-confirm + a reason.
 *   3. The RESET control (KillSwitchReset): a distinct, separate action + a note.
 *
 * Status comes from `GET /api/kill-switch`, polled every 5s (keeping last-good
 * data through a blip, like the rest of the dashboard) and re-read immediately
 * after any trigger/reset attempt via `poll.refetch`, so the card, the strip and
 * the banner all reflect the real state at once. Honest load states: a
 * not-yet-provisioned environment (`no_schema`) and an expired session are shown
 * as themselves rather than a blank page.
 */

import { Link } from "react-router-dom";
import { ApiError, fetchKillSwitch } from "../api/client";
import { usePolling } from "../api/usePolling";
import type { KillSwitchStatus } from "../api/types";
import { KillSwitchTrigger } from "../components/KillSwitchTrigger";
import { KillSwitchReset } from "../components/KillSwitchReset";
import { formatDateTime, formatTime } from "../format";

function BackLink() {
  return (
    <Link
      to="/"
      className="text-sm text-zinc-400 underline-offset-2 hover:text-zinc-200 hover:underline"
    >
      ← Back to bots
    </Link>
  );
}

function StatusCard({ status }: { status: KillSwitchStatus }) {
  if (status.state === "tripped") {
    return (
      <section className="rounded-xl border border-red-500/50 bg-red-600/15 p-5">
        <div className="flex items-center gap-2">
          <span className="text-2xl" aria-hidden>
            ⛔
          </span>
          <h1 className="text-xl font-bold uppercase tracking-wide text-red-200">
            Kill switch tripped
          </h1>
        </div>
        <dl className="mt-3 space-y-2 text-sm">
          <div>
            <dt className="text-xs font-medium uppercase tracking-wide text-red-300/80">Reason</dt>
            <dd className="mt-0.5 text-zinc-100">{status.reason ?? "no reason recorded"}</dd>
          </div>
          <div className="flex flex-wrap gap-x-8 gap-y-2">
            <div>
              <dt className="text-xs font-medium uppercase tracking-wide text-red-300/80">Pulled by</dt>
              <dd className="mt-0.5 text-zinc-100">{status.trippedBy ?? "unknown"}</dd>
            </div>
            <div>
              <dt className="text-xs font-medium uppercase tracking-wide text-red-300/80">When</dt>
              <dd className="tabular mt-0.5 text-zinc-100">{formatDateTime(status.trippedAt)}</dd>
            </div>
          </div>
        </dl>
        <p className="mt-3 text-sm text-red-200/90">
          Every bot on every account has been halted. No bot can be created or resumed until a human
          resets the switch below.
        </p>
      </section>
    );
  }

  return (
    <section className="rounded-xl border border-emerald-500/30 bg-emerald-500/[0.06] p-5">
      <div className="flex items-center gap-2">
        <span className="text-2xl" aria-hidden>
          ✅
        </span>
        <h1 className="text-xl font-bold uppercase tracking-wide text-emerald-200">
          Kill switch armed
        </h1>
      </div>
      <p className="mt-2 text-sm text-zinc-300">
        Normal operation. All bots run under their own controls. Trip the switch below only in a genuine
        emergency — it halts everything, everywhere, at once.
      </p>
      {status.resetAt !== null && (
        <p className="mt-2 text-xs text-zinc-500">
          Last reset {formatDateTime(status.resetAt)}
          {status.resetBy !== null ? ` by ${status.resetBy}` : ""}.
        </p>
      )}
    </section>
  );
}

function LoadState({ error }: { error: Error }) {
  const code = error instanceof ApiError ? error.code : null;
  if (code === "no_schema" || code === "kill_switch_unavailable") {
    return (
      <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 px-4 py-8 text-center text-sm text-zinc-400">
        This environment is not provisioned yet — its database schema is deferred to go-live, so there is
        no kill-switch state to show. This is expected on a fresh production deploy.
      </div>
    );
  }
  if (code === "unauthenticated") {
    return (
      <div className="rounded-xl border border-red-500/30 bg-red-500/5 px-4 py-8 text-center text-sm text-red-300">
        Your Cloudflare Access session has expired — reload to sign in again.
      </div>
    );
  }
  return (
    <div className="rounded-xl border border-red-500/30 bg-red-500/5 px-4 py-8 text-center text-sm text-red-300">
      Couldn’t load the kill switch: {error.message}
      <div className="mt-1 text-xs text-red-400/70">
        If this persists, your Cloudflare Access session may have expired — reload to sign in again.
      </div>
    </div>
  );
}

export function KillSwitchPage() {
  const poll = usePolling<KillSwitchStatus>(fetchKillSwitch);
  const status = poll.data;
  const firstLoad = poll.loading && status === null;
  const hardError = poll.error !== null && status === null;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-3">
          <BackLink />
          <h1 className="text-xl font-semibold text-zinc-100">Global kill switch</h1>
        </div>
        <div className="flex items-center gap-2 text-xs text-zinc-500">
          <span
            className={[
              "inline-block h-2 w-2 rounded-full",
              poll.error ? "bg-red-400" : "bg-emerald-400",
            ].join(" ")}
            aria-hidden
          />
          <span>
            {poll.error ? "Update failed" : "Live"} · updated {formatTime(poll.lastUpdated)}
          </span>
        </div>
      </div>

      {firstLoad ? (
        <div className="rounded-xl border border-zinc-800 px-4 py-10 text-center text-sm text-zinc-500">
          Loading kill-switch status…
        </div>
      ) : hardError ? (
        <LoadState error={poll.error!} />
      ) : status !== null ? (
        <>
          <StatusCard status={status} />
          <KillSwitchTrigger state={status.state} onChanged={poll.refetch} />
          <KillSwitchReset state={status.state} onChanged={poll.refetch} />
        </>
      ) : null}
    </div>
  );
}
