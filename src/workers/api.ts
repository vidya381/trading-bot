import { version } from "../../package.json";

// Durable Object classes must be exported from the Worker named by `main` in
// wrangler.jsonc, which is this file. Re-exported rather than defined here so
// the class keeps its own module.
export { BotInstance } from "../durable-objects/bot-instance";

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
} satisfies ExportedHandler<Env>;
