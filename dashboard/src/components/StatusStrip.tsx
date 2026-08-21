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
 *
 * A NULL LIST IS NOT AN EMPTY FLEET
 * ---------------------------------
 * `bots` and `alerts` are nullable, and null means "no successful load yet".
 * They were previously non-null, because the page coalesced each poll's `data`
 * with `?? []` before passing it down -- so on first load, and for as long as a
 * failed first load kept failing, this strip counted an empty array and
 * reported a confident RUNNING 0 / HALTED 0 / UNRESOLVED ALERTS 0 for a fleet
 * it knew nothing about. The money rollup below never had that bug: it renders
 * nothing at all rather than "a strip of confident zeroes" (see
 * `AccountSummary`), which is why only the top row was ever wrong.
 *
 * The rule the rest of this codebase already states -- "NULL IS NOT ZERO"
 * (api/types.ts), "Null means UNKNOWN, never zero" (accountTotals.ts) -- now
 * holds here too, and it holds through a FAILED poll and not merely a slow one.
 * That distinction is the whole point: a `loading` flag goes false when the
 * first fetch fails, so gating on it alone would have left an expired Access
 * session showing a fleet-wide all-clear underneath the error box that admits
 * the load failed.
 *
 * The rule itself lives in `statusCounts.ts`, which is where it is tested --
 * this file places what that module produced and chooses a colour for it.
 */

import { Link } from "react-router-dom";
import { ENVIRONMENT } from "../env";
import type { Account, Alert, Bot, KillSwitchStatus } from "../api/types";
import { accountTotals } from "../accountTotals";
import { availableCapital } from "../availableCapital";
import { countValues, UNKNOWN } from "../statusCounts";
import { AccountSummary } from "./AccountSummary";

interface TileProps {
  readonly label: string;
  readonly value: string;
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
  /*
   * An unknown value is always muted, whatever the tone. RUNNING is the tile
   * this matters for: it carries `tone="good"` and no `muted` flag, so before
   * this gate existed its loading-state zero rendered in full emerald -- a
   * healthy green 0 that looked exactly like a confirmed "nothing is running".
   */
  const unknown = value === UNKNOWN;
  return (
    <div className="flex flex-col rounded-lg border border-zinc-800 bg-zinc-900/60 px-4 py-3">
      <span className="text-xs font-medium uppercase tracking-wide text-zinc-500">{label}</span>
      <span
        className={[
          "tabular mt-1 text-2xl font-semibold",
          unknown || (muted && value === "0") ? "text-zinc-600" : TONE_CLASS[tone],
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
function UnresolvedAlertsTile({ count }: { count: string }) {
  return (
    <Link
      to="/alerts?resolved=false"
      className="flex flex-col rounded-lg border border-zinc-800 bg-zinc-900/60 px-4 py-3 transition-colors hover:border-zinc-700 hover:bg-zinc-900"
    >
      <span className="text-xs font-medium uppercase tracking-wide text-zinc-500">Unresolved alerts</span>
      <span
        className={[
          "tabular mt-1 text-2xl font-semibold",
          /*
           * `UNKNOWN` lands in the muted arm alongside a real zero, which is
           * the correct colour for it but for a different reason -- and it is
           * the reason the count itself now has to say which it is. A muted 0
           * here reads as an all-clear, and this tile was showing one for an
           * alert feed it had not loaded.
           */
          count === "0" || count === UNKNOWN ? "text-zinc-600" : "text-amber-300",
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
  accounts,
}: {
  bots: Bot[] | null;
  alerts: Alert[] | null;
  killSwitch: KillSwitchStatus | null;
  /**
   * `GET /api/accounts`, carrying each account's `capital_ledger` headroom.
   *
   * A SECOND poll, not derived from `bots`, because it answers a question the
   * bot list structurally cannot: capital that is free is capital NO bot has
   * claimed, so there is no row anywhere in `bots` that represents it. Null
   * until its first successful load -- and null renders no AVAILABLE tiles at
   * all rather than zeroed ones, for the same reason the count tiles above
   * refuse to report a confident 0 for a fleet they have not seen.
   */
  accounts: Account[] | null;
}) {
  const counts = countValues(bots, alerts);
  /*
   * Derived from the SAME `bots` list the count tiles above and the table below
   * are built from -- one poll, one source of truth, so the money row can never
   * describe a different fleet than the one on screen.
   *
   * `?? []` is safe HERE and nowhere else on this page: `accountTotals([])`
   * returns an empty array, and `AccountSummary` renders exactly nothing for
   * it. So a not-yet-loaded fleet produces no money tiles rather than zeroed
   * ones -- which is the behaviour this row already had, and the behaviour the
   * count tiles above have just been given.
   */
  const totals = accountTotals(bots ?? []);
  /*
   * Deliberately handed the RAW nullable list, unlike `bots` above. `?? []`
   * would be wrong here: an empty account list and an unloaded one are
   * different, and `availableCapital` distinguishes them itself -- null yields
   * no cards AND no "unreadable" note, whereas a loaded-but-empty list could
   * legitimately carry accounts whose ledger read failed and which must be
   * named on screen.
   */
  const capital = availableCapital(accounts);

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
        <Tile label="Running" value={counts.running} tone="good" />
        <Tile label="Halted" value={counts.halted} tone="bad" muted />
        <Tile label="Stopped" value={counts.stopped} tone="neutral" muted />
        <Tile label="Created" value={counts.created} tone="neutral" muted />
        <UnresolvedAlertsTile count={counts.unresolved} />
      </section>
      <AccountSummary totals={totals} capital={capital} />
    </div>
  );
}
