/**
 * The RECORDING half of section 10's alerting: what goes into the `alerts`
 * table, and when a row is one incident rather than one detection.
 *
 * `/src/notifications` is the notifying half and deliberately writes no alert
 * row; this is its counterpart, and the two agree on one key (see
 * `standing.ts`). Both of the system's scheduled re-detectors -- the
 * reconciliation cron and the `BotInstance` open-order poll -- raise and
 * resolve through here, so their lifecycles cannot drift apart.
 *
 * TWO LIFECYCLES LIVE HERE, and the split is by what makes a row stop being
 * true, not by who wrote it:
 *
 *  - `standing.ts` -- a CONDITION a scheduled pass re-derives. Raised once per
 *    open incident, closed when a pass that genuinely observed stops finding it.
 *  - `halt.ts` -- a discrete EVENT that a later state transition makes historical.
 *    One row per halt, closed when the bot successfully resumes.
 *
 * Keeping the second one out of the first is deliberate: `halt.ts`'s header
 * explains why reusing the standing resolver would have cost that module's
 * `observed` guard its meaning.
 */

export {
  raiseStandingAlert,
  resolveClearedStandingAlerts,
  standingAlertKey,
  type StandingAlert,
  type StandingAlertPass,
} from "./standing";

export { resolveHaltAlerts, type HaltAlertScope } from "./halt";
