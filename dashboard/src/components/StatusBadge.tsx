/**
 * The bot-status pill, one place so the list and the status strip colour a
 * status identically (the halted/running colour coding from the spec).
 *
 *   - running: green   -- actively placing/managing orders.
 *   - halted:  red     -- a risk stop fired or a human/breaker pulled it; needs
 *                         review before it ever resumes (section 7.2).
 *   - stopped: zinc    -- deliberately closed, no longer active.
 *   - created: sky     -- configured but never started (idle).
 */

import type { BotStatus } from "../api/types";

const STATUS_CLASS: Record<BotStatus, string> = {
  running: "bg-emerald-500/15 text-emerald-300 ring-emerald-500/30",
  halted: "bg-red-500/15 text-red-300 ring-red-500/30",
  stopped: "bg-zinc-500/15 text-zinc-300 ring-zinc-500/30",
  created: "bg-sky-500/15 text-sky-300 ring-sky-500/30",
};

export function StatusBadge({ status }: { status: BotStatus }) {
  return (
    <span
      className={[
        "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium uppercase tracking-wide ring-1 ring-inset",
        STATUS_CLASS[status],
      ].join(" ")}
    >
      {status}
    </span>
  );
}
