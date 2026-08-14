/**
 * What the status strip's five count tiles display, given whatever the
 * dashboard's two independent polls have produced so far.
 *
 * WHY THIS IS A MODULE AND NOT A FUNCTION INSIDE StatusStrip.tsx.
 * The same reason `accountTotals.ts` sits beside `AccountSummary.tsx` rather
 * than inside it: this repository's suite runs in the Workers runtime, which
 * has no DOM, and a `.tsx` module cannot even be IMPORTED there -- its JSX
 * compiles to a `react/jsx-runtime` import, and React ships CommonJS that
 * workerd cannot `require`. `citations.test.ts` records the same constraint.
 * Pulling the rule out here is what makes it directly testable; the component
 * keeps only the placement and the colour.
 *
 * THE RULE
 * --------
 * A NULL LIST IS NOT AN EMPTY FLEET. `null` is `usePolling`'s "no successful
 * load yet", and it means that for as long as the load keeps failing -- not
 * merely while the first request is in flight. Every tile fed from a null list
 * reads `UNKNOWN`.
 *
 * An empty ARRAY is a real, confirmed answer and still counts to 0. An account
 * that genuinely has no bots should read as having none.
 *
 * The distinction was previously lost one level up, where the page coalesced
 * each poll's `data` with `?? []` before the strip ever saw it -- so a fleet
 * nobody had loaded yet rendered as RUNNING 0 / HALTED 0 / UNRESOLVED ALERTS 0,
 * in the same styling a confirmed zero uses. It is the rule the rest of this
 * codebase already states out loud: "NULL IS NOT ZERO" (api/types.ts), "Null
 * means UNKNOWN, never zero" (accountTotals.ts).
 *
 * COUNTS ARE RETURNED AS STRINGS, already rendered. There is deliberately no
 * `number | null` for the component to re-decide: one place converts a count
 * into something displayable, and it is this one.
 */

import type { Alert, Bot, BotStatus } from "./api/types";

/**
 * What a count tile shows when the list it counts has not arrived.
 *
 * The same glyph `KillSwitchTile` already shows for a null kill-switch status,
 * and the same one `AccountSummary`'s `Unknown` shows for a withheld total: one
 * mark for "not known", used everywhere on that page.
 *
 * Deliberately NOT a shimmer or a spinner. Those say "wait, this is coming",
 * which is a promise a failed poll does not keep, and this one glyph has to
 * serve the failed-load case as well as the loading one. It also occupies the
 * tile at its natural size, so the strip does not reflow when real numbers
 * land -- which is the whole reason the strip is mounted unconditionally.
 */
export const UNKNOWN = "—";

/** Each count tile's display value: a decimal count, or `UNKNOWN`. */
export interface CountValues {
  readonly running: string;
  readonly halted: string;
  readonly stopped: string;
  readonly created: string;
  readonly unresolved: string;
}

function countByStatus(bots: readonly Bot[], status: BotStatus): number {
  return bots.reduce((n, bot) => (bot.status === status ? n + 1 : n), 0);
}

/**
 * Resolve both polls into the five display values.
 *
 * Per-list rather than one page-wide loading flag, because the bot list and the
 * alert list are separate subscriptions that fail separately: alerts failing
 * must not blank the four status counts, and bots failing must not blank the
 * alert count. Either being null hides only the tiles it actually feeds.
 */
export function countValues(
  bots: readonly Bot[] | null,
  alerts: readonly Alert[] | null,
): CountValues {
  const count = (status: BotStatus): string =>
    bots === null ? UNKNOWN : String(countByStatus(bots, status));
  return {
    running: count("running"),
    halted: count("halted"),
    stopped: count("stopped"),
    created: count("created"),
    unresolved:
      alerts === null
        ? UNKNOWN
        : String(alerts.reduce((n, alert) => (alert.resolved ? n : n + 1), 0)),
  };
}
