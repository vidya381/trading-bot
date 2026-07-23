/**
 * The provider-agnostic notification boundary (spec section 10, step 8).
 *
 * Section 2 lists "Discord or Telegram webhook (whichever the account owner
 * prefers)". Section 10 describes the throttling and the two alert categories
 * but says nothing about the wire format of either provider, deliberately: the
 * dispatcher and the cooldown logic must not know one exists.
 *
 * So this file defines the seam. `AlertNotifier` is the whole of what the
 * dispatcher depends on; `DiscordNotifier` is the one implementation built now.
 * A Telegram provider later is a new class implementing this interface, with no
 * change to `dispatch.ts` or `cooldown.ts`.
 *
 * `NotifiableAlert` is NOT `AlertRow`. The dispatcher maps a D1 row onto this
 * shape before handing it over, so a provider never sees a database column name
 * or the money/CAST conventions of `/src/db`. It is the alert as a fact to be
 * announced, not as a stored record.
 */

import type { AlertCategory, AlertSeverity } from "../db";

/**
 * One alert, as a provider needs to see it. Camel-cased and free of storage
 * concerns; `botInstanceId` is null for account-wide alerts (the circuit
 * breaker, a reconciliation finding attributed to no single bot).
 */
export interface NotifiableAlert {
  readonly id: string;
  readonly severity: AlertSeverity;
  readonly category: AlertCategory;
  readonly alertType: string;
  readonly botInstanceId: string | null;
  readonly source: string;
  readonly message: string;
  /** The alert's own `created_at`, ms since epoch. Not the send time. */
  readonly createdAt: number;
}

/**
 * The result of one send attempt.
 *
 * A result rather than a thrown error, because "the webhook returned 503" is a
 * routine, expected outcome the dispatcher must handle by leaving the alert to
 * be retried -- not an exception. (The dispatcher also guards against a
 * provider that throws anyway; see `dispatch.ts`.) `delivered: false` and a
 * thrown error are treated identically: the alert is not marked notified and
 * the cooldown is not advanced.
 */
export type NotifyResult =
  | { readonly delivered: true }
  | { readonly delivered: false; readonly reason: string };

export interface AlertNotifier {
  /**
   * Attempt to deliver one alert. Must resolve (not reject) for an expected
   * transport failure, returning `delivered: false` with a human-readable
   * reason. May reject only for genuinely unexpected faults.
   */
  send(alert: NotifiableAlert): Promise<NotifyResult>;
}
