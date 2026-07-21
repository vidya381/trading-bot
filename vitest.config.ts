import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// Read every file in /migrations, ordered by leading number, and split each
// into individual SQL statements. Tests apply these to the real (local) D1
// database with `applyD1Migrations`, so the schema under test is always the
// migration files themselves -- there is no second, hand-maintained copy of
// the schema that could drift from what a deploy would actually create.
//
// A relative path, resolved against the working directory, rather than
// `import.meta.dirname`. Building an absolute path needs `node:path` and
// therefore `@types/node`, and tsconfig's `types` array is deliberately narrow
// (step 1, decision 5): pulling in Node's globals to typecheck one line of
// config would also make them visible while typechecking Worker source, where
// nothing should be reaching for them. Vitest always runs from the project
// root, so this resolves the same way.
const migrations = await readD1Migrations("./migrations");

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
      miniflare: {
        // The D1 binding is declared HERE rather than in wrangler.jsonc, on
        // purpose. Miniflare only needs a binding name to spin up a local
        // SQLite database; a `d1_databases` block in wrangler.jsonc would
        // additionally need a real `database_id`, and step 1's decision 1
        // rejected placeholder resource IDs as too easy to mistake for real
        // ones. See docs/d1-provisioning.md for the exact commands that add
        // the real binding once a scoped API token exists.
        d1Databases: ["DB"],
        bindings: {
          // Not application config: the migration set, handed to the test
          // runtime so `applyD1Migrations` can run it. No Worker reads this.
          TEST_MIGRATIONS: migrations,
        },
      },
    }),
  ],
});
