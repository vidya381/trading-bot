import { version } from "../../package.json";

// Durable Object classes must be exported from the Worker named by `main` in
// wrangler.jsonc, which is this file. Re-exported rather than defined here so
// the class keeps its own module.
export { BotInstance } from "../durable-objects/bot-instance";
export { RateLimiter } from "../durable-objects/rate-limiter";

import { scheduled as reconciliationScheduled } from "./reconciliation";
import { runNotificationDispatch } from "./notifications";

// wrangler.jsonc's `triggers.crons` declares two expressions: "*/5 * * * *"
// (reconciliation) and "* * * * *" (notification dispatch). Cloudflare fires
// the `scheduled` handler once per matching expression and passes it back as
// `controller.cron`, so the handler routes on it. A cron is a handler on a
// Worker, not a kind of Worker (see reconciliation.ts's header), which is why
// both jobs share one deployment and are told apart here.
const NOTIFICATION_CRON = "* * * * *";

/**
 * The `scheduled` handler. Routes each cron to its job:
 *   - every 5 minutes: reconciliation (section 9).
 *   - every minute: notification dispatch (section 10, step 8).
 * An unrecognised cron falls through to reconciliation, matching the prior
 * behaviour when it was the only scheduled job.
 */
const scheduled: ExportedHandlerScheduledHandler<Env> = async (controller, env, ctx) => {
  if (controller.cron === NOTIFICATION_CRON) {
    const result = await runNotificationDispatch(env);
    if (!result.ran) {
      console.log(`notification dispatch did not run: ${result.reason ?? "unknown"}`);
      return;
    }
    const r = result.result!;
    console.log(
      `notification dispatch: scanned=${r.scanned} sent=${r.sent} ` +
        `throttled=${r.throttled} failed=${r.failed}`,
    );
    return;
  }

  // The 5-minute reconciliation cron, or any other schedule, runs section 9.
  await reconciliationScheduled(controller, env, ctx);
};

/**
 * Main API Worker (placeholder).
 *
 * Only /health exists at this stage. Bot management routes, Durable Object
 * bindings, and Cloudflare Access header handling arrive in later build steps.
 */
export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      // Spec section 16: a deployed version must always be confirmable against
      // what is actually running. Spec section 11.3: the environment must be
      // confirmable programmatically, not just from the dashboard banner.
      return Response.json({
        status: "ok",
        version,
        environment: env.ENVIRONMENT,
      });
    }

    return new Response("Not Found", { status: 404 });
  },

  // Section 9 reconciliation (5-minute cron) and section 10 notification
  // dispatch (1-minute cron), routed by `controller.cron` in the handler above.
  // A cron trigger is a handler on a Worker rather than a kind of Worker, so
  // section 3's separate "Cron Trigger Worker" boxes are preserved as a
  // separation of concerns -- the logic lives in /src/reconciliation and
  // /src/notifications and knows nothing about crons -- not as extra
  // deployments. See the headers of ./reconciliation.ts and ./notifications.ts.
  scheduled,
} satisfies ExportedHandler<Env>;
