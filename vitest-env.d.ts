// Test-runtime bindings.
//
// `env` from "cloudflare:test" is typed as `Cloudflare.Env` in
// @cloudflare/vitest-pool-workers 0.18.6. The `ProvidedEnv` interface that
// Cloudflare's docs (and this file, until step 4) tell you to augment does not
// exist in this version -- augmenting it compiled fine and did nothing.
//
// Augmenting `Cloudflare.Env` rather than the global `Env` is deliberate: the
// global `Env` is what the Worker's fetch handler sees, and neither binding
// below exists in a deployed Worker yet. Only tests should be able to see them.
//
//  - DB: supplied by vitest.config.ts's miniflare options, because
//    wrangler.jsonc cannot declare a D1 binding without a real database_id.
//    Once the real database is provisioned (docs/d1-provisioning.md), the
//    binding belongs in wrangler.jsonc, `wrangler types` will emit it into
//    both `Env` and `Cloudflare.Env`, and this line must be DELETED so there
//    is one declaration of DB rather than two that can disagree.
//  - TEST_MIGRATIONS: the migration set, for applyD1Migrations. Test-only
//    permanently; no Worker ever reads it.
//
// Written with inline `import(...)` types so this file stays a global script.
// A top-level `import` would turn it into a module and the namespace
// declaration would stop merging.
declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    TEST_MIGRATIONS: import("@cloudflare/vitest-pool-workers").D1Migration[];
  }
}
