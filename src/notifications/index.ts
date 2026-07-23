/**
 * Alerts outbound notification (spec section 10, build step 8).
 *
 * The logic half. Everything here takes its dependencies as parameters and
 * knows nothing about bindings, secrets, or cron triggers -- the worker shell
 * in `/src/workers/notifications.ts` supplies the real database, KV namespace,
 * Discord webhook and clock. See `dispatch.ts` for why this is a dispatcher
 * reading the alerts table rather than inline sends at each write site.
 */

export type { AlertNotifier, NotifiableAlert, NotifyResult } from "./notifier";
export { DiscordNotifier, type DiscordNotifierOptions, type FetchLike } from "./discord";
export {
  cooldownKey,
  DEFAULT_COOLDOWN_MS,
  KvCooldownStore,
  InMemoryCooldownStore,
  type CooldownStore,
} from "./cooldown";
export {
  dispatchPendingAlerts,
  type DispatchPorts,
  type DispatchResult,
} from "./dispatch";
