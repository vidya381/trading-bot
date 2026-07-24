// Tests for the pre-deploy dashboard guard (scripts/verify-dashboard-build.mjs).
//
// Runs on Node's built-in test runner (`node --test`), NOT vitest: the guard is
// a plain Node CLI that reads the filesystem and is invoked by Wrangler, so it
// belongs outside the Workers pool that vitest.config.ts sets up. Run with
// `npm run test:deploy-guard`. No new dependencies.
//
// Two layers:
//   1. checkBuild() -- the pure match/mismatch/missing logic, tested directly.
//   2. the CLI -- exit codes and the WRANGLER_COMMAND gate, tested by spawning
//      the script against fixture dist directories (proves the deploy actually
//      aborts, which is what protects Cloudflare).

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";

import { checkBuild } from "./verify-dashboard-build.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const scriptPath = join(here, "verify-dashboard-build.mjs");

const tmpDirs = [];
after(() => tmpDirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

/** Build a throwaway dist directory. `env` null omits index.html (no build at
 * all); env "none" writes a build with no stamp; otherwise stamps it. */
function makeDist({ env }) {
  const dir = mkdtempSync(join(tmpdir(), "dist-"));
  tmpDirs.push(dir);
  if (env === null) return dir; // no build at all
  writeFileSync(join(dir, "index.html"), "<!doctype html>");
  mkdirSync(join(dir, "assets"), { recursive: true });
  if (env !== "none") {
    writeFileSync(
      join(dir, ".build-env.json"),
      JSON.stringify({ environment: env, builtAt: "2026-07-23T00:00:00.000Z" }),
    );
  }
  return dir;
}

// ---- checkBuild(): pure logic ---------------------------------------------

test("matching build passes", () => {
  const distDir = makeDist({ env: "production" });
  const r = checkBuild({ distDir, expectedEnv: "production" });
  assert.equal(r.ok, true);
  assert.match(r.message, /verified/);
});

test("mismatched build fails and names both environments", () => {
  const distDir = makeDist({ env: "testnet" });
  const r = checkBuild({ distDir, expectedEnv: "production" });
  assert.equal(r.ok, false);
  assert.match(r.message, /MISMATCH/);
  assert.match(r.message, /built for : testnet/);
  assert.match(r.message, /deploying : production/);
});

test("missing build (no index.html) fails", () => {
  const distDir = makeDist({ env: null });
  const r = checkBuild({ distDir, expectedEnv: "testnet" });
  assert.equal(r.ok, false);
  assert.match(r.message, /No dashboard build found/);
});

test("build with no stamp fails (cannot verify env)", () => {
  const distDir = makeDist({ env: "none" });
  const r = checkBuild({ distDir, expectedEnv: "testnet" });
  assert.equal(r.ok, false);
  assert.match(r.message, /no \.build-env\.json stamp/);
});

test("development build never satisfies a real environment", () => {
  const distDir = makeDist({ env: "development" });
  assert.equal(checkBuild({ distDir, expectedEnv: "testnet" }).ok, false);
  assert.equal(checkBuild({ distDir, expectedEnv: "production" }).ok, false);
});

// ---- CLI: exit codes and the WRANGLER_COMMAND gate -------------------------

function runCli({ env, arg, wranglerCommand }) {
  const childEnv = { ...process.env, DASHBOARD_DIST_DIR: makeDist({ env }) };
  // Never let the parent's WRANGLER_COMMAND leak in; set it only when the case
  // asks for it, so the gate is exercised deterministically.
  delete childEnv.WRANGLER_COMMAND;
  if (wranglerCommand) childEnv.WRANGLER_COMMAND = wranglerCommand;
  return spawnSync(process.execPath, [scriptPath, arg], {
    env: childEnv,
    encoding: "utf8",
  });
}

test("CLI aborts (exit 1) on a mismatch during deploy", () => {
  const res = runCli({ env: "testnet", arg: "production", wranglerCommand: "deploy" });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /Deploy blocked/);
  assert.match(res.stderr, /MISMATCH/);
});

test("CLI succeeds (exit 0) on a match during deploy", () => {
  const res = runCli({ env: "production", arg: "production", wranglerCommand: "deploy" });
  assert.equal(res.status, 0);
  assert.match(res.stdout, /verified/);
});

test("CLI no-ops (exit 0) on non-deploy Wrangler commands even when mismatched", () => {
  // A mismatched build must NOT block `wrangler dev`.
  const res = runCli({ env: "testnet", arg: "production", wranglerCommand: "dev" });
  assert.equal(res.status, 0);
  assert.equal(res.stdout.trim(), "");
});

test("CLI rejects an unknown target env argument (exit 2)", () => {
  const res = runCli({ env: "production", arg: "staging", wranglerCommand: "deploy" });
  assert.equal(res.status, 2);
  assert.match(res.stderr, /expected target env/);
});
