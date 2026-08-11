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
      // Do not open a remote proxy session for bindings that have no local
      // simulation. THIS IS WHAT LETS THE `ai` BINDING EXIST AT ALL.
      //
      // Workers AI has no local implementation: miniflare's `ai` plugin builds
      // a `remoteProxyClientWorker` and nothing else (see its AI_PLUGIN, which
      // has no local branch). The pool therefore calls wrangler's
      // `maybeStartOrUpdateRemoteProxySession` at CONFIG-PARSE TIME -- before a
      // single test runs -- and in this project that session is refused,
      // because the testnet Worker sits behind Cloudflare Access and there is
      // no service token in the test environment. The whole suite then reports
      // 0 tests and an error per test file. Decision log 37 recorded that as
      // the blocking open problem for wiring Assess, and described it as a
      // structural incompatibility -- WHICH IT IS NOT. See docs/decision-log/38.md,
      // which supersedes that framing.
      //
      // The gate is one option, and the failure was a DEFAULT rather than
      // anything this project configured. In @cloudflare/vitest-pool-workers
      // 0.18.6 the pool declares `remoteBindings: z.boolean().default(true)`
      // (dist/pool/index.mjs:2514) and starts the session only
      // `if (options.remoteBindings)` (:2603). Setting it false skips the
      // handshake entirely, so `ai` stays declared in wrangler.jsonc for real
      // deploys while tests never try to reach Cloudflare.
      //
      // WHAT THIS COSTS, STATED PLAINLY: `env.AI` still EXISTS in tests as a
      // binding object, but it is wired to a proxy client with no connection
      // string, so CALLING it fails. That is the correct trade and not a
      // limitation to work around -- nothing in this repository may call a
      // model from a test. `AssessModel` (src/research/assess.ts) is an
      // injected port precisely so the model is never reached from the suite,
      // and a test that somehow did call `env.AI` SHOULD fail loudly rather
      // than quietly contact a paid API.
      //
      // Safe for everything else here because this project has no remote-only
      // bindings: D1, KV, R2 and Durable Objects are all locally simulated by
      // miniflare, and none of them is declared with `experimental_remote`.
      remoteBindings: false,
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
        //
        // The ALERT_COOLDOWNS KV namespace (step 8, section 8.3) IS declared
        // here rather than in wrangler.jsonc, deliberately: the real namespace
        // is not provisioned yet (docs/kv-provisioning.md), and this project
        // does not commit placeholder resource ids (step 4, decision 1).
        // Miniflare needs only the binding name to spin up a local KV, so tests
        // exercise the real KvCooldownStore without any Cloudflare resource.
        // ALERT_COOLDOWNS (step 8) and SYMBOL_CACHE (step 11): both real
        // namespaces are unprovisioned, so they live here rather than in
        // wrangler.jsonc (see the note above). Miniflare needs only the binding
        // name to spin up a local KV, so tests exercise the real
        // KvCooldownStore and KvSymbolCacheStore without any Cloudflare resource.
        kvNamespaces: ["ALERT_COOLDOWNS", "SYMBOL_CACHE"],
        bindings: {
          // Not application config: the migration set, handed to the test
          // runtime so `applyD1Migrations` can run it. No Worker reads this.
          TEST_MIGRATIONS: migrations,
          // Build step 10 (dashboard API), section 11. The Access verifier's two
          // settings, supplied to tests here rather than in wrangler.jsonc:
          // ACCESS_AUD is a real secret (never committed) and ACCESS_TEAM_DOMAIN
          // is deliberately empty in wrangler.jsonc until the account owner sets
          // it. Test values so `accessConfigFromEnv` -- the real path that reads
          // the secret -- is the one under test; the JWKS fetch is injected per
          // test so no network is touched and the tests sign their own tokens.
          ACCESS_AUD: "test-access-aud",
          ACCESS_TEAM_DOMAIN: "testteam.cloudflareaccess.com",
        },
      },
    }),
  ],
});
