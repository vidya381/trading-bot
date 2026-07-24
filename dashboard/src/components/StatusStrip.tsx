/**
 * The status strip (this session's brief item 5): environment badge, the
 * running/halted/stopped counts, and the unresolved-alert count. Sourced from
 * GET /api/bots and GET /api/alerts.
 *
 * The counts are derived here from the already-polled lists rather than fetched
 * separately -- one source of truth per poll, so a tile can never disagree with
 * the table below it.
 */

import { ENVIRONMENT } from "../env";
import type { Alert, Bot, BotStatus } from "../api/types";

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

export function StatusStrip({ bots, alerts }: { bots: Bot[]; alerts: Alert[] }) {
  const running = countByStatus(bots, "running");
  const halted = countByStatus(bots, "halted");
  const stopped = countByStatus(bots, "stopped");
  const created = countByStatus(bots, "created");
  const unresolved = alerts.reduce((n, alert) => (alert.resolved ? n : n + 1), 0);

  return (
    <section className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
      <div className="flex flex-col justify-center rounded-lg border border-zinc-800 bg-zinc-900/60 px-4 py-3">
        <span className="text-xs font-medium uppercase tracking-wide text-zinc-500">Environment</span>
        <span className="mt-1 text-lg font-semibold uppercase tracking-wide text-zinc-100">
          {ENVIRONMENT}
        </span>
      </div>
      <Tile label="Running" value={running} tone="good" />
      <Tile label="Halted" value={halted} tone="bad" muted />
      <Tile label="Stopped" value={stopped} tone="neutral" muted />
      <Tile label="Created" value={created} tone="neutral" muted />
      <Tile label="Unresolved alerts" value={unresolved} tone="warn" muted />
    </section>
  );
}
