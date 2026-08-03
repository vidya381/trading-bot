/**
 * The RECORDING half of section 10's alerting: what goes into the `alerts`
 * table, and when a row is one incident rather than one detection.
 *
 * `/src/notifications` is the notifying half and deliberately writes no alert
 * row; this is its counterpart, and the two agree on one key (see
 * `standing.ts`). Both of the system's scheduled re-detectors -- the
 * reconciliation cron and the `BotInstance` open-order poll -- raise and
 * resolve through here, so their lifecycles cannot drift apart.
 */

export {
  raiseStandingAlert,
  resolveClearedStandingAlerts,
  standingAlertKey,
  type StandingAlert,
  type StandingAlertPass,
} from "./standing";
