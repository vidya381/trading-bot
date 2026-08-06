/**
 * The status strip (bot-list session's brief item 5): environment badge, the
 * running/halted/stopped counts, the unresolved-alert count, and -- added this
 * session (kill-switch brief item 6) -- the global kill-switch state. Sourced
 * from GET /api/bots, GET /api/alerts, and GET /api/kill-switch.
 *
 * The counts are derived here from the already-polled lists rather than fetched
 * separately -- one source of truth per poll, so a tile can never disagree with
 * the table below it.
 *
 * The kill-switch tile is a LINK to the control page, so the strip both reflects
 * the most severe global state (a tripped switch renders as a filled-red tile,
 * impossible to mistake for the muted count tiles) AND is the way to reach the
 * control from the main page without navigating into any specific bot. The loud
 * everywhere-signal is the separate App-level banner; this is the always-present,
 * at-a-glance state next to the fleet counts.
 *
 * STEP 25 ADDED A SECOND ROW: the account-level money rollup (`AccountSummary`),
 * below the counts rather than mixed into them. The two rows answer different
 * questions -- "what is the fleet DOING" and "what is the fleet WORTH" -- and
 * interleaving a currency figure among count tiles that share a visual
 * treatment would invite reading one as the other. Same source array, same
 * poll, same one-source-of-truth rule as the counts above it.
 */

import { Link } from "react-router-dom";
import { ENVIRONMENT } from "../env";
import type { Alert, Bot, BotStatus, KillSwitchStatus } from "../api/types";
import { accountTotals } from "../accountTotals";
import { AccountSummary } from "./AccountSummary";

function countByStatus(bots: Bot[], status: BotStatus): number {
  return bots.reduce((n, bot) => (bot.status === status ? n + 1 : n), 0);
}

interface TileProps {
  readonly label: string;
  readonly value: number;
  readonly tone: "neutral" | "good" | "bad" | "warn";
  readonly muted?: boolean;
}

const TONE_CLASS: Record<TileProps["tone"], string> = {
  neutral: "text-zinc-100",
  good: "text-emerald-300",
  bad: "text-red-300",
  warn: "text-amber-300",
};

function Tile({ label, value, tone, muted }: TileProps) {
  return (
    <div className="flex flex-col rounded-lg border border-zinc-800 bg-zinc-900/60 px-4 py-3">
      <span className="text-xs font-medium uppercase tracking-wide text-zinc-500">{label}</span>
      <span
        className={[
          "tabular mt-1 text-2xl font-semibold",
          muted && value === 0 ? "text-zinc-600" : TONE_CLASS[tone],
        ].join(" ")}
      >
        {value}
      </span>
    </div>
  );
}

/**
 * The unresolved-alert tile: a link to the cross-bot alert feed, pre-filtered to
 * unresolved (`/alerts?resolved=false`) so the destination matches what the
 * count means (this session's brief item 6). Keeps the muted-when-zero treatment
 * of the plain count tiles.
 */
function UnresolvedAlertsTile({ count }: { count: number }) {
  return (
    <Link
      to="/alerts?resolved=false"
      className="flex flex-col rounded-lg border border-zinc-800 bg-zinc-900/60 px-4 py-3 transition-colors hover:border-zinc-700 hover:bg-zinc-900"
    >
      <span className="text-xs font-medium uppercase tracking-wide text-zinc-500">Unresolved alerts</span>
      <span
        className={[
          "tabular mt-1 text-2xl font-semibold",
          count === 0 ? "text-zinc-600" : "text-amber-300",
        ].join(" ")}
      >
        {count}
      </span>
    </Link>
  );
}

/**
 * The kill-switch tile: a link to the control page that shows the current state
 * at a glance. Tripped is a filled-red tile so it cannot read as one more count;
 * `null` (not yet loaded, or a failed poll before any success) shows a muted
 * dash rather than implying "armed".
 */
function KillSwitchTile({ status }: { status: KillSwitchStatus | null }) {
  const tripped = status?.state === "tripped";
  return (
    <Link
      to="/kill-switch"
      className={[
        "flex flex-col justify-center rounded-lg border px-4 py-3 transition-colors",
        tripped
          ? "border-red-500/60 bg-red-600/20 hover:bg-red-600/30"
          : "border-zinc-800 bg-zinc-900/60 hover:border-zinc-700 hover:bg-zinc-900",
      ].join(" ")}
    >
      <span className="text-xs font-medium uppercase tracking-wide text-zinc-500">Kill switch</span>
      <span
        className={[
          "mt-1 text-lg font-semibold uppercase tracking-wide",
          status === null ? "text-zinc-600" : tripped ? "text-red-300" : "text-emerald-300",
        ].join(" ")}
      >
        {status === null ? "—" : tripped ? "Tripped" : "Armed"}
      </span>
    </Link>
  );
}

export function StatusStrip({
  bots,
  alerts,
  killSwitch,
}: {
  bots: Bot[];
  alerts: Alert[];
  killSwitch: KillSwitchStatus | null;
}) {
  const running = countByStatus(bots, "running");
  const halted = countByStatus(bots, "halted");
  const stopped = countByStatus(bots, "stopped");
  const created = countByStatus(bots, "created");
  const unresolved = alerts.reduce((n, alert) => (alert.resolved ? n : n + 1), 0);
  // Derived from the SAME `bots` array the count tiles above and the table
  // below are built from -- one poll, one source of truth, so the money row
  // can never describe a different fleet than the one on screen.
  const totals = accountTotals(bots);

  return (
    <div className="space-y-4">
      <section className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-7">
        <div className="flex flex-col justify-center rounded-lg border border-zinc-800 bg-zinc-900/60 px-4 py-3">
          <span className="text-xs font-medium uppercase tracking-wide text-zinc-500">Environment</span>
          <span className="mt-1 text-lg font-semibold uppercase tracking-wide text-zinc-100">
            {ENVIRONMENT}
          </span>
        </div>
        <KillSwitchTile status={killSwitch} />
        <Tile label="Running" value={running} tone="good" />
        <Tile label="Halted" value={halted} tone="bad" muted />
        <Tile label="Stopped" value={stopped} tone="neutral" muted />
        <Tile label="Created" value={created} tone="neutral" muted />
        <UnresolvedAlertsTile count={unresolved} />
      </section>
      <AccountSummary totals={totals} />
    </div>
  );
}
