// Pre-deploy guard: refuse to deploy a dashboard build that was built for a
// different environment than the one being deployed to (spec section 11.3).
//
// The dashboard's environment banner is a compile-time constant baked into the
// bundle from VITE_ENVIRONMENT at build time. `wrangler deploy --env <X>`
// uploads whatever sits in dashboard/dist -- it does NOT rebuild and does NOT
// check what that dist was built for. So a bare `wrangler deploy --env
// production` run after a testnet build silently ships the testnet dashboard to
// production, wrong banner and all. The npm `deploy:*` scripts avoid this by
// rebuilding first, but nothing stopped the bare command -- until this guard.
//
// This script is wired into wrangler.jsonc as the per-environment
// `build.command`, so Wrangler runs it on EVERY `wrangler deploy --env <X>`,
// before it uploads anything. A non-zero exit aborts the deploy (nothing
// reaches Cloudflare). It compares the target env (passed as argv[2], hardcoded
// per env in wrangler.jsonc) against the `.build-env.json` stamp that the Vite
// build writes into dashboard/dist (see dashboard/vite.config.ts), and fails
// loudly on mismatch, missing build, or missing stamp.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The two real, deployable environments. "development" is never deployable. */
const DEPLOYABLE = new Set(["testnet", "production"]);

/** The stamp file the Vite build writes into the output directory. */
const STAMP_FILE = ".build-env.json";

/**
 * Pure check: does the build in `distDir` match `expectedEnv`? Returns a result
 * rather than exiting, so it is testable without spawning a process. `ok: true`
 * means the deploy may proceed.
 *
 * @param {{ distDir: string, expectedEnv: string }} args
 * @returns {{ ok: boolean, message: string }}
 */
export function checkBuild({ distDir, expectedEnv }) {
  const indexHtml = join(distDir, "index.html");
  const stampPath = join(distDir, STAMP_FILE);
  const fix = `Run \`npm run deploy:${expectedEnv}\` -- it rebuilds the dashboard for ${expectedEnv}, then deploys.`;

  // No build at all. Deploying now would upload nothing (or a stray older dist);
  // either way it is not a fresh build for this environment.
  if (!existsSync(indexHtml)) {
    return {
      ok: false,
      message:
        `No dashboard build found in ${distDir} (missing index.html).\n` +
        `Nothing was deployed. ${fix}`,
    };
  }

  // A build exists but predates this guard (or was produced by some path that
  // did not stamp it). We cannot prove which environment it targets, so we must
  // refuse rather than assume.
  if (!existsSync(stampPath)) {
    return {
      ok: false,
      message:
        `Dashboard build in ${distDir} has no ${STAMP_FILE} stamp, so the ` +
        `environment it was built for cannot be verified.\n${fix}`,
    };
  }

  let builtFor;
  try {
    builtFor = JSON.parse(readFileSync(stampPath, "utf8")).environment;
  } catch (err) {
    return {
      ok: false,
      message: `Could not read ${join(distDir, STAMP_FILE)}: ${err.message}.\n${fix}`,
    };
  }

  if (builtFor !== expectedEnv) {
    return {
      ok: false,
      message:
        `Dashboard build MISMATCH.\n` +
        `  built for : ${builtFor}\n` +
        `  deploying : ${expectedEnv}\n` +
        `The dist in ${distDir} was built for "${builtFor}", but this deploy ` +
        `targets "${expectedEnv}". Uploading it would serve the ${builtFor} ` +
        `dashboard -- wrong environment banner and all -- on ${expectedEnv}.\n${fix}`,
    };
  }

  return {
    ok: true,
    message: `Dashboard build verified: built for "${builtFor}", deploying to "${expectedEnv}".`,
  };
}

/**
 * Resolve the dashboard dist directory. Overridable via DASHBOARD_DIST_DIR for
 * the tests (which point it at fixture directories); in real deploys it is
 * always <repo>/dashboard/dist, resolved from this file's own location so it
 * does not depend on the process working directory.
 */
export function resolveDistDir() {
  if (process.env.DASHBOARD_DIST_DIR) return process.env.DASHBOARD_DIST_DIR;
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
  return join(repoRoot, "dashboard", "dist");
}

// CLI entry point. Skipped when this module is imported (e.g. by the tests).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  // Wrangler runs `build.command` for more than just `deploy` (e.g. `dev`).
  // Only enforce on deploy: WRANGLER_COMMAND is set by Wrangler to the running
  // command. When unset (the script was run directly), enforce too -- the only
  // reason to run it by hand is to check a build. Skip on any other wrangler
  // command so `wrangler dev` is never gated on having a matching prod build.
  const wranglerCommand = process.env.WRANGLER_COMMAND;
  if (wranglerCommand && wranglerCommand !== "deploy") {
    process.exit(0);
  }

  const expectedEnv = process.argv[2];
  if (!DEPLOYABLE.has(expectedEnv)) {
    console.error(
      `verify-dashboard-build: expected target env "testnet" or "production" ` +
        `as the first argument, got "${expectedEnv ?? ""}".`,
    );
    process.exit(2);
  }

  const result = checkBuild({ distDir: resolveDistDir(), expectedEnv });
  if (!result.ok) {
    console.error(`\n✘ Deploy blocked -- ${result.message}\n`);
    process.exit(1);
  }
  console.log(`✓ ${result.message}`);
}
