import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

/**
 * The expected version is written out LITERALLY here and deliberately NOT
 * imported from package.json. The handler imports it from package.json; a test
 * that imported it too would compare a value against itself and pass for every
 * possible value, which is what this assertion did until it was corrected.
 *
 * WHAT THE LITERAL DETECTS: the handler no longer reporting package.json's
 * version verbatim -- a hardcoded string, a computed value, a dropped or
 * renamed field -- and package.json's version moving at all. Build identity
 * comes from Cloudflare's per-deploy version id, NOT from this number, so this
 * number moving is not a routine event; a deliberate bump must edit this line.
 *
 * WHAT IT CANNOT DETECT, and no test in this repository can: whether any
 * deployment is running this code. `SELF` is the Worker built from this source
 * tree by the test runner, never a deployed one, so a stale `/health` on a real
 * deployment answers to nothing here. This guards the handler's contract. It
 * does NOT guard deploy identity and must not be read as though it does -- see
 * the handler's own docblock for what `/health` can and cannot certify.
 */
const EXPECTED_VERSION = "0.1.0";

describe("/health", () => {
  it("reports the package version and the environment it is running in", async () => {
    const response = await SELF.fetch("https://example.com/health");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toStrictEqual({
      status: "ok",
      version: EXPECTED_VERSION,
      // vitest.config.ts pins the testnet environment, so this asserts the
      // environments really are separately configured (spec section 16).
      environment: "testnet",
    });
  });

  it("does not serve unknown routes", async () => {
    const response = await SELF.fetch("https://example.com/");

    expect(response.status).toBe(404);
  });
});
