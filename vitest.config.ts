import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// Spec section 14: tests run inside the actual Workers runtime, with direct
// access to Durable Object, D1, KV, and R2 bindings once those exist.
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: {
        configPath: "./wrangler.jsonc",
        // Always the testnet environment. Tests must never load production
        // config or production bindings, even locally.
        environment: "testnet",
      },
    }),
  ],
});
