// Test-runtime bindings.
//
// `env` from "cloudflare:test" is typed as `Cloudflare.Env` in
// @cloudflare/vitest-pool-workers 0.18.6. The `ProvidedEnv` interface that
// Cloudflare's docs (and this file, until step 4) tell you to augment does not
// exist in this version -- augmenting it compiled fine and did nothing.
//
// Only TEST_MIGRATIONS is declared here now. `DB` used to be too, because
// wrangler.jsonc could not declare a D1 binding without a real database_id;
// the databases exist as of step 4.1, so `DB` comes from `wrangler types` via
// worker-configuration.d.ts and must NOT be repeated here. Two declarations
// that can disagree is worse than one.
//
// TEST_MIGRATIONS is test-only permanently: it is the migration set that
// `applyD1Migrations` needs, supplied by vitest.config.ts's miniflare options.
// No Worker ever reads it, which is why it augments `Cloudflare.Env` (what
// `env` from "cloudflare:test" is typed as) rather than the global `Env` (what
// the Worker's own fetch handler sees).
//
// Written with an inline `import(...)` type so this file stays a global script.
// A top-level `import` would turn it into a module and the namespace
// declaration would stop merging.
declare namespace Cloudflare {
  interface Env {
    TEST_MIGRATIONS: import("@cloudflare/vitest-pool-workers").D1Migration[];

    // Step 8, section 8.3. The alert-cooldown KV namespace, supplied to tests by
    // vitest.config.ts's miniflare `kvNamespaces`. Declared here (test-visible,
    // on `Cloudflare.Env`) rather than in worker-configuration.d.ts because the
    // real namespace is not provisioned yet, so it is not in wrangler.jsonc and
    // `wrangler types` cannot emit it (docs/kv-provisioning.md). The Worker's
    // own view of this binding is the optional `declare global` augmentation in
    // src/workers/notifications.ts. Both go away once the namespace is
    // provisioned and `wrangler types` emits it on both interfaces.
    ALERT_COOLDOWNS: KVNamespace;
  }
}
