import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { version } from "../../package.json";

describe("/health", () => {
  it("reports the package version and the environment it is running in", async () => {
    const response = await SELF.fetch("https://example.com/health");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toStrictEqual({
      status: "ok",
      version,
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
