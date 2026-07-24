import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// The dashboard is served same-origin as the API in every deployed environment
// (the Worker's static-assets binding serves this build; /api/* and /health are
// routed to the Worker itself -- see wrangler.jsonc `assets.run_worker_first`).
// So the app always fetches same-origin `/api/*`. For local `vite dev` there is
// no Worker on :5173, so proxy those paths to a local `wrangler dev` (:8787).
// Note: /api/* is gated by Cloudflare Access in deployment; locally the backend
// fails closed unless you have a session, so a local look shows the chrome with
// the list/strip in their empty or error state. That is expected -- populated
// data needs the deployed, Access-gated origin.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      "/api": "http://localhost:8787",
      "/health": "http://localhost:8787",
    },
  },
});
