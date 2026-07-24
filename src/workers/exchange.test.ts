/**
 * The real, secret-backed exchange wiring (spec sections 4 and 16), step 3.2.
 *
 * The whole point of these tests is the safety property the runtime cannot be
 * relied on to reveal until it is too late: that the base URL is bound to
 * `env.ENVIRONMENT` in one direction and one direction only, and that a missing
 * secret fails closed with a specific reason rather than building a client that
 * would sign against nothing. No network is touched -- constructing a client
 * makes no request, and no test here calls one.
 */

import { describe, expect, it } from "vitest";

import { BinanceClient, BINANCE_BASE_URLS } from "../exchange/binance/client";
import { CredentialError } from "../exchange/credentials";
import { baseUrlForEnvironment, resolveDefaultExchange } from "./exchange";

const now = () => 1_760_000_000_000;

/** A minimal RATE_LIMITER namespace; its stub is never called by these tests. */
const fakeRateLimiter = {
  idFromName: () => ({}) as DurableObjectId,
  get: () => ({}) as DurableObjectStub,
} as unknown as DurableObjectNamespace;

function envWith(overrides: Record<string, unknown>): Env {
  return { RATE_LIMITER: fakeRateLimiter, ...overrides } as unknown as Env;
}

describe("baseUrlForEnvironment: the mapping cannot be got backwards", () => {
  it("sends testnet to the testnet host, and never to real Binance", () => {
    const url = baseUrlForEnvironment("testnet");
    expect(url).toBe(BINANCE_BASE_URLS.testnet);
    expect(url).toBe("https://testnet.binance.vision");
    expect(url).not.toBe(BINANCE_BASE_URLS.production);
    expect(url).not.toContain("api.binance.com");
  });

  it("sends production to real Binance, and never to the testnet host", () => {
    const url = baseUrlForEnvironment("production");
    expect(url).toBe(BINANCE_BASE_URLS.production);
    expect(url).toBe("https://api.binance.com");
    expect(url).not.toBe(BINANCE_BASE_URLS.testnet);
    expect(url).not.toContain("testnet");
  });

  it.each([["unconfigured"], [""], ["Testnet"], ["prod"], [undefined]])(
    "throws rather than guessing a URL for %p",
    (value) => {
      expect(() => baseUrlForEnvironment(value as string | undefined)).toThrow(
        CredentialError,
      );
    },
  );
});

describe("resolveDefaultExchange: fails closed on a missing secret", () => {
  it("refuses, naming both secrets, when neither is set", () => {
    const result = resolveDefaultExchange(envWith({ ENVIRONMENT: "testnet" }), now);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toContain("BINANCE_API_KEY");
    expect(result.reason).toContain("BINANCE_API_SECRET");
    expect(result.reason).toContain("testnet");
  });

  it("refuses, naming just the missing one, when only the secret is absent", () => {
    const result = resolveDefaultExchange(
      envWith({ ENVIRONMENT: "testnet", BINANCE_API_KEY: "key" }),
      now,
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toContain("BINANCE_API_SECRET");
    expect(result.reason).not.toContain("BINANCE_API_KEY or");
  });

  it("treats a blank secret as missing, not as a usable key", () => {
    const result = resolveDefaultExchange(
      envWith({ ENVIRONMENT: "testnet", BINANCE_API_KEY: "key", BINANCE_API_SECRET: "   " }),
      now,
    );

    expect(result.ok).toBe(false);
  });

  it("refuses to build anything outside a trading environment", () => {
    const result = resolveDefaultExchange(
      envWith({ ENVIRONMENT: "unconfigured", BINANCE_API_KEY: "k", BINANCE_API_SECRET: "s" }),
      now,
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toContain("unconfigured");
  });

  it("never leaks the secret value into the refusal message", () => {
    // Key present, secret blank -> a refusal that names the secret's field but
    // must not contain the (here, valid-looking) key value.
    const result = resolveDefaultExchange(
      envWith({
        ENVIRONMENT: "testnet",
        BINANCE_API_KEY: "super-secret-key-value",
        BINANCE_API_SECRET: "",
      }),
      now,
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).not.toContain("super-secret-key-value");
  });
});

describe("resolveDefaultExchange: builds a real client when the secrets exist", () => {
  it("returns a factory yielding a BinanceClient on testnet", () => {
    const result = resolveDefaultExchange(
      envWith({ ENVIRONMENT: "testnet", BINANCE_API_KEY: "key", BINANCE_API_SECRET: "secret" }),
      now,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    const client = result.exchangeFor("acct-1");
    expect(client).toBeInstanceOf(BinanceClient);
  });

  it("returns a factory yielding a BinanceClient on production too", () => {
    const result = resolveDefaultExchange(
      envWith({ ENVIRONMENT: "production", BINANCE_API_KEY: "key", BINANCE_API_SECRET: "secret" }),
      now,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.exchangeFor("acct-1")).toBeInstanceOf(BinanceClient);
  });
});
