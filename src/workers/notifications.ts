/**
 * The notification-dispatch Cron Trigger (spec section 10), build step 8.
 *
 * The binding-aware shell around `/src/notifications`, exactly as
 * `./reconciliation.ts` is the shell around `/src/reconciliation`. Everything
 * that involves a decision lives in that folder and takes its dependencies as
 * parameters; this file only supplies the real ones.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A CRON, AND A SEPARATE ONE FROM RECONCILIATION
 * ---------------------------------------------------------------------------
 * A cron rather than inline sends at each alert write site: recording and
 * notifying are separate concerns (section 10), alerts are raised from two
 * execution contexts (the BotInstance Durable Object and the reconciliation
 * Worker), and an outbound webhook POST must never sit on the halt path where
 * speed is a safety property (step 3.1). See `dispatch.ts`.
 *
 * A cron on its OWN schedule (every minute) rather than folded into the
 * 5-minute reconciliation pass: a halt or stop-loss ping should not wait up to
 * five minutes behind reconciliation. Both are `scheduled` handlers on the same
 * Worker, distinguished by `event.cron` in `api.ts`. The protective ACTION
 * already happened synchronously in the Durable Object; only the human ping is
 * paced here, and one minute is well inside section 10's 15-minute cooldown.
 *
 * ---------------------------------------------------------------------------
 * NO KV, NO SECRET -> NO-OP
 * ---------------------------------------------------------------------------
 * Handled the same way `./reconciliation.ts` handles the absent exchange
 * client: the `ALERT_COOLDOWNS` KV namespace and the `DISCORD_WEBHOOK_URL`
 * secret do not exist in either environment yet (see docs/kv-provisioning.md).
 * When either is missing this returns without touching D1, so the every-minute
 * cron on a not-yet-provisioned or deliberately-empty production database is a
 * clean no-op rather than a failing query. The checks happen BEFORE any D1
 * access, deliberately.
 */

import { databaseFrom, type Database } from "../db";
import {
  DiscordNotifier,
  dispatchPendingAlerts,
  KvCooldownStore,
  DEFAULT_COOLDOWN_MS,
  type AlertNotifier,
  type CooldownStore,
  type DispatchResult,
} from "../notifications";

// The two bindings this step introduces. Both optional: not every environment
// has them (the `unconfigured` base has neither; production has neither until
// go-live). `wrangler types` cannot emit a secret, and the KV namespace is not
// in wrangler.jsonc until it is provisioned, so they are declared here and the
// shell treats their absence as a reason to no-op.
declare global {
  interface Env {
    readonly ALERT_COOLDOWNS?: KVNamespace;
    readonly DISCORD_WEBHOOK_URL?: string;
  }
}

export interface DispatchOptions {
  /** Override the notifier. Tests pass a mock; production builds a Discord one. */
  readonly notifier?: AlertNotifier;
  /** Override the cooldown store. Tests pass an in-memory one. */
  readonly cooldown?: CooldownStore;
  /** Override the database. Tests pass one over the local D1. */
  readonly db?: Database;
  readonly now?: () => number;
  readonly windowMs?: number;
  readonly limit?: number;
}

export interface DispatchRunResult {
  readonly ran: boolean;
  readonly reason?: string;
  readonly result?: DispatchResult;
}

/**
 * Run one notification-dispatch pass.
 *
 * Exported separately from the handler so a test drives exactly this, and so
 * the dashboard can later offer a "resend now" button without duplicating the
 * wiring.
 */
export async function runNotificationDispatch(
  env: Env,
  options: DispatchOptions = {},
): Promise<DispatchRunResult> {
  const windowMs = options.windowMs ?? DEFAULT_COOLDOWN_MS;
  const now = options.now ?? (() => Date.now());

  // Build the notifier first (cheap, no I/O), so a missing secret short-circuits
  // before any D1 access. A test-supplied notifier skips the secret entirely.
  let notifier: AlertNotifier;
  if (options.notifier !== undefined) {
    notifier = options.notifier;
  } else {
    const webhookUrl = env.DISCORD_WEBHOOK_URL;
    if (webhookUrl === undefined || webhookUrl.trim() === "") {
      return {
        ran: false,
        reason:
          "no DISCORD_WEBHOOK_URL secret in this environment, so no alert can be " +
          "sent. Set it with `wrangler secret put DISCORD_WEBHOOK_URL --env <env>`.",
      };
    }
    notifier = new DiscordNotifier(webhookUrl);
  }

  // The cooldown store, likewise before D1.
  let cooldown: CooldownStore;
  if (options.cooldown !== undefined) {
    cooldown = options.cooldown;
  } else {
    const kv = env.ALERT_COOLDOWNS;
    if (kv === undefined) {
      return {
        ran: false,
        reason:
          "no ALERT_COOLDOWNS KV binding in this environment, so section 10's " +
          "cooldown cannot be enforced. See docs/kv-provisioning.md.",
      };
    }
    cooldown = new KvCooldownStore(kv, { windowMs });
  }

  // Only now touch D1. A test may inject one; otherwise it comes from the DB
  // binding, which `databaseFrom` refuses if absent (a deploy with no --env).
  const db = options.db ?? databaseFrom(env);

  const result = await dispatchPendingAlerts({
    db,
    notifier,
    cooldown,
    now,
    windowMs,
    ...(options.limit !== undefined ? { limit: options.limit } : {}),
  });

  return { ran: true, result };
}
