import { describe, expect, it } from "vitest";
import { CredentialError } from "../exchange/credentials";
import { GEMINI_BASE_URLS } from "../exchange/gemini/client";
import { geminiBaseUrlForEnvironment, resolveGeminiExchange } from "./exchange-gemini";

const NOW = () => 1_700_000_000_000;

/** A minimal Env with just the fields the resolver reads. */
function env(overrides: Partial<Env>): Env {
  return overrides as Env;
}

describe("geminiBaseUrlForEnvironment", () => {
  it("maps testnet to the sandbox host and never production", () => {
    const url = geminiBaseUrlForEnvironment("testnet");
    expect(url).toBe(GEMINI_BASE_URLS.sandbox);
    expect(url).not.toBe(GEMINI_BASE_URLS.production);
  });

  it("maps production to the real host and never the sandbox", () => {
    const url = geminiBaseUrlForEnvironment("production");
    expect(url).toBe(GEMINI_BASE_URLS.production);
    expect(url).not.toBe(GEMINI_BASE_URLS.sandbox);
  });

  it.each([undefined, "", "unconfigured", "staging", "prod"])(
    "throws on the unrecognised value %o rather than guessing an exchange",
    (value) => {
      expect(() => geminiBaseUrlForEnvironment(value as string | undefined)).toThrow(CredentialError);
    },
  );
});

describe("resolveGeminiExchange", () => {
  it("refuses outside a trading environment", () => {
    const result = resolveGeminiExchange(env({ ENVIRONMENT: "unconfigured" }), NOW);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("not a trading environment");
  });

  it("fails closed naming BOTH secrets when neither is set", () => {
    const result = resolveGeminiExchange(env({ ENVIRONMENT: "testnet" }), NOW);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("GEMINI_API_KEY");
      expect(result.reason).toContain("GEMINI_API_SECRET");
      expect(result.reason).toContain("--env testnet");
    }
  });

  it("fails closed naming the single missing secret", () => {
    const result = resolveGeminiExchange(
      env({ ENVIRONMENT: "testnet", GEMINI_API_KEY: "k" }),
      NOW,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("GEMINI_API_SECRET");
      expect(result.reason).not.toContain("GEMINI_API_KEY or");
    }
  });

  it("treats a blank secret as missing", () => {
    const result = resolveGeminiExchange(
      env({ ENVIRONMENT: "testnet", GEMINI_API_KEY: "k", GEMINI_API_SECRET: "   " }),
      NOW,
    );
    expect(result.ok).toBe(false);
  });

  it("never leaks a secret value into the reason", () => {
    const result = resolveGeminiExchange(
      env({ ENVIRONMENT: "testnet", GEMINI_API_KEY: "super-secret-key" }),
      NOW,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).not.toContain("super-secret-key");
  });

  it("returns a factory when both secrets are present, without any network call", () => {
    const result = resolveGeminiExchange(
      env({ ENVIRONMENT: "testnet", GEMINI_API_KEY: "k", GEMINI_API_SECRET: "s" }),
      NOW,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      // The factory only CONSTRUCTS a client; the constructor sends nothing.
      const client = result.exchangeFor("gemini-testnet");
      expect(client).not.toBeNull();
      expect(typeof client!.getAccountBalances).toBe("function");
    }
  });
});
