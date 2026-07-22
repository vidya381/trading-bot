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
        // No `d1Databases` here. The DB binding comes from wrangler.jsonc's
        // testnet environment as of step 4.1, and the pool picks it up from
        // there. Tests still run against a LOCAL SQLite database that
        // miniflare creates from that binding -- declaring the binding does
        // not point tests at the remote database, and nothing in the suite
        // touches Cloudflare.
        bindings: {
          // Not application config: the migration set, handed to the test
          // runtime so `applyD1Migrations` can run it. No Worker reads this.
          TEST_MIGRATIONS: migrations,
        },
      },
    }),
  ],
});
