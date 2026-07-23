/**
 * The Discord webhook implementation of `AlertNotifier` (spec sections 2, 10).
 *
 * The only provider built at step 8. The webhook URL is a Wrangler secret
 * (`DISCORD_WEBHOOK_URL`), read by the worker shell and passed in here -- never
 * hard-coded, never in `wrangler.jsonc`, and never a real URL in a test.
 *
 * Nothing else in the system imports this class except the worker shell that
 * wires it up: `dispatch.ts` depends only on `AlertNotifier`. A Telegram
 * provider would sit beside this file and change nothing else.
 *
 * ---------------------------------------------------------------------------
 * MAKING THE TWO CATEGORIES DISTINGUISHABLE (section 10)
 * ---------------------------------------------------------------------------
 * Section 10 requires business/trading and system/health alerts to be
 * "visually distinguishable". A Discord embed is distinguished on two axes at
 * once here, so it survives either being missed:
 *
 *   - VISUALLY: the stripe colour is chosen from a category-specific palette,
 *     and the title carries a category emoji plus a `[TRADING]` / `[SYSTEM]`
 *     label.
 *   - STRUCTURALLY: Category and Severity are their own embed fields, so a
 *     future dashboard (or a human filtering in Discord) can tell them apart
 *     without parsing prose.
 */

import type { AlertCategory, AlertSeverity } from "../db";
import type { AlertNotifier, NotifiableAlert, NotifyResult } from "./notifier";

/** A `fetch`-shaped port, so tests never touch the network. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface DiscordNotifierOptions {
  /** Defaults to the runtime's global `fetch`. Overridden in every test. */
  readonly fetch?: FetchLike;
  /** The bot name shown on the message. */
  readonly username?: string;
}

// Embed stripe colours, as Discord's integer RGB. Category picks the family,
// severity picks the shade, so `[SYSTEM] critical` never wears the same colour
// as `[TRADING] critical`.
const COLORS: Record<AlertCategory, Record<AlertSeverity, number>> = {
  trading: { info: 0x2ecc71, warning: 0xf1c40f, critical: 0xe74c3c },
  system: { info: 0x95a5a6, warning: 0xe67e22, critical: 0x9b59b6 },
};

const CATEGORY_EMOJI: Record<AlertCategory, string> = {
  trading: "📈",
  system: "⚙️",
};

const SEVERITY_EMOJI: Record<AlertSeverity, string> = {
  info: "🟢",
  warning: "🟡",
  critical: "🔴",
};

export class DiscordNotifier implements AlertNotifier {
  readonly #webhookUrl: string;
  readonly #fetch: FetchLike;
  readonly #username: string;

  constructor(webhookUrl: string, options: DiscordNotifierOptions = {}) {
    if (webhookUrl.trim() === "") {
      // An empty URL would POST to nowhere and look like a silent success or a
      // confusing 404. The worker shell already declines to build this when the
      // secret is unset; this is the backstop for a misconfigured one.
      throw new Error("DiscordNotifier requires a non-empty webhook URL");
    }
    this.#webhookUrl = webhookUrl;
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
    this.#username = options.username ?? "trading-bot alerts";
  }

  async send(alert: NotifiableAlert): Promise<NotifyResult> {
    const payload = this.#payload(alert);

    let response: Response;
    try {
      response = await this.#fetch(this.#webhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
    } catch (error) {
      // A dropped connection or DNS failure. Expected; the dispatcher retries.
      return {
        delivered: false,
        reason: `network error posting to Discord: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }

    // Discord returns 204 No Content on a successful webhook post. Any 2xx is
    // accepted; anything else -- 429 rate limit, 4xx bad webhook, 5xx outage --
    // leaves the alert un-notified for the next run to retry.
    if (response.ok) {
      return { delivered: true };
    }
    const retryAfter = response.headers.get("retry-after");
    return {
      delivered: false,
      reason:
        `Discord returned ${response.status}` +
        (retryAfter !== null ? ` (retry-after ${retryAfter}s)` : ""),
    };
  }

  /** The Discord webhook JSON body. Exposed via `send`; split out for testing. */
  #payload(alert: NotifiableAlert): unknown {
    const title =
      `${SEVERITY_EMOJI[alert.severity]} ${CATEGORY_EMOJI[alert.category]} ` +
      `[${alert.category.toUpperCase()}] ${alert.alertType}`;

    return {
      username: this.#username,
      embeds: [
        {
          title,
          description: alert.message,
          color: COLORS[alert.category][alert.severity],
          timestamp: new Date(alert.createdAt).toISOString(),
          fields: [
            { name: "Category", value: alert.category, inline: true },
            { name: "Severity", value: alert.severity, inline: true },
            {
              name: "Bot",
              value: alert.botInstanceId ?? "account-wide",
              inline: true,
            },
            { name: "Source", value: alert.source, inline: true },
            { name: "Alert type", value: alert.alertType, inline: true },
          ],
          footer: { text: `alert ${alert.id}` },
        },
      ],
    };
  }
}
