import type { Plugin } from "vite";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Deploy guard (see scripts/verify-dashboard-build.mjs and wrangler.jsonc).
//
// Every build stamps the output directory with a `.build-env.json` recording
// which environment the bundle was built for -- the same VITE_ENVIRONMENT that
// gets inlined into the shipped code and drives the banner (spec section 11.3).
// The pre-deploy check reads this stamp to refuse a deploy whose dashboard build
// does not match the target `--env`, so a stale dist can never be uploaded to
// the wrong environment. Reading a stamp the build wrote is deterministic;
// grepping the minified bundle for "testnet"/"production" would not be.
//
// The normalization here MUST match src/env.ts's resolveEnvironment(): an unset
// or unknown value is "development", never testnet/production. That is what makes
// a plain `vite build` (no VITE_ENVIRONMENT) fail the guard against either real
// environment rather than being mistaken for one of them.
// The dashboard toolchain deliberately does not depend on @types/node
// (tsconfig.node.json declares no "types"), so declare the single Node global
// this build step reads rather than pulling in all of Node's typings. Module
// scoped -- this file is a module, so it does not leak `process` into globals.
// VITE_ENVIRONMENT is injected as a real environment variable by the build /
// deploy scripts (see package.json), not from a .env file.
declare const process: { env: Record<string, string | undefined> };

function buildEnvStamp(): Plugin {
  const raw = process.env.VITE_ENVIRONMENT;
  const environment =
    raw === "testnet" || raw === "production" ? raw : "development";
  return {
    name: "build-env-stamp",
    apply: "build",
    generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: ".build-env.json",
        source:
          JSON.stringify(
            { environment, builtAt: new Date().toISOString() },
            null,
            2,
          ) + "\n",
      });
    },
  };
}

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
  plugins: [react(), tailwindcss(), buildEnvStamp()],
  server: {
    proxy: {
      "/api": "http://localhost:8787",
      "/health": "http://localhost:8787",
    },
  },
});
