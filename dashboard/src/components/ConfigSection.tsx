/**
 * The read-only "Configuration" block: the parameters a bot was CREATED with,
 * made visible.
 *
 * Not editable, and deliberately so -- these values were validated against
 * allocated capital at creation (`validateDcaParams` / the grid equivalent) and
 * the running bot's Durable Object has been acting on them ever since. Changing
 * one from here would mean changing a live bot's risk profile mid-cycle, which is
 * a whole design of its own, not a form field. This block exists so an operator
 * reading a halted bot's detail page can see what it was configured to do without
 * going to D1.
 *
 * The values come from `config.params` on `GET /api/bots/:id` -- the object's own
 * config, not the create-form's input shape -- so what is shown is what the bot
 * actually holds.
 *
 * Presentation only: the strategy-specific field lists live in the two strategy
 * views, because DCA's and grid's parameters have nothing in common beyond
 * stop-loss.
 */

import type { ReactNode } from "react";
import { trimDecimal } from "../format";

export function ConfigItem({
  label,
  children,
  hint,
}: {
  label: string;
  children: ReactNode;
  hint?: string;
}) {
  return (
    <div className="min-w-0">
      <dt className="text-xs uppercase tracking-wide text-zinc-500">{label}</dt>
      <dd className="tabular mt-0.5 text-sm text-zinc-200">{children}</dd>
      {hint && <div className="mt-0.5 text-xs text-zinc-600">{hint}</div>}
    </div>
  );
}

export function ConfigSection({ children }: { children: ReactNode }) {
  return (
    <section className="space-y-3">
      <h3 className="text-sm font-semibold uppercase tracking-wide text-zinc-400">Configuration</h3>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-4 rounded-lg border border-zinc-800 bg-zinc-900/40 px-4 py-4 sm:grid-cols-3 lg:grid-cols-4">
        {children}
      </dl>
    </section>
  );
}

/** A percentage parameter. Percentages arrive as plain decimal strings ("20" = 20%). */
export function percent(value: string): string {
  return `${trimDecimal(value)}%`;
}

/** A configured on/off flag, worded as what it does rather than as `true`. */
export function enabled(value: boolean): string {
  return value ? "Enabled" : "Disabled";
}
