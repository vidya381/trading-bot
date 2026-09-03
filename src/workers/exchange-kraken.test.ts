import { describe, expect, it } from "vitest";
import { CredentialError } from "../exchange/credentials";
import { KRAKEN_BASE_URLS } from "../exchange/kraken/client";
import { krakenBaseUrlForEnvironment, resolveKrakenExchange } from "./exchange-kraken";

const NOW = () => 1_700_000_000_000;

/**
 * A syntactically valid Kraken secret: 88 base64 characters decoding to 64
 * bytes, which is the shape Kraken issues. Not a real credential and not
 * accepted by anything but `decodeApiSecret` -- the resolver's job is to prove
 * the value DECODES, never that the venue would accept it.
 */
const VALID_SECRET = `${"a".repeat(86)}==`;

/** A minimal Env with just the fields the resolver reads. */
function env(overrides: Partial<Env>): Env {
  return overrides as Env;
}

describe("krakenBaseUrlForEnvironment", () => {
  it("maps production to the real host", () => {
    expect(krakenBaseUrlForEnvironment("production")).toBe(KRAKEN_BASE_URLS.production);
  });

  it("throws on testnet rather than returning the production host", () => {
    // The entire point of entry 90 DECISION 1. The failure mode this guards is
    // not an exception -- it is a function that quietly returns
    // https://api.kraken.com for "testnet".
    expect(() => krakenBaseUrlForEnvironment("testnet")).toThrow(CredentialError);
    try {
      krakenBaseUrlForEnvironment("testnet");
      expect.unreachable("testnet must not yield a base URL");
    } catch (error) {
      expect((error as Error).message).not.toContain(KRAKEN_BASE_URLS.production);
      expect((error as Error).message).toContain("no sandbox");
    }
  });

  it("has exactly one URL to hand out, so no branch can produce a testnet host", () => {
    expect(Object.keys(KRAKEN_BASE_URLS)).toEqual(["production"]);
  });

  it.each([undefined, "", "unconfigured", "staging", "prod"])(
    "throws on the unrecognised value %o rather than guessing an exchange",
    (value) => {
      expect(() => krakenBaseUrlForEnvironment(value as string | undefined)).toThrow(
        CredentialError,
      );
    },
  );
});

describe("resolveKrakenExchange", () => {
  it("refuses outside a trading environment", () => {
    const result = resolveKrakenExchange(env({ ENVIRONMENT: "unconfigured" }), NOW);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("not a trading environment");
  });

  describe("entry 90 DECISION 1: testnet refuses, whatever the secrets say", () => {
    // The three states an operator's testnet environment can be in. All three
    // must produce the SAME refusal, because the answer does not depend on the
    // credentials: there is no host for them to authenticate against.
    it.each([
      ["no secrets at all", {}],
      ["both secrets present and well-formed", {
        KRAKEN_API_KEY: "kraken-key",
        KRAKEN_API_SECRET: VALID_SECRET,
      }],
      ["one secret present", { KRAKEN_API_KEY: "kraken-key" }],
    ])("refuses with %s", (_label, secrets) => {
      const result = resolveKrakenExchange(
        env({ ENVIRONMENT: "testnet", ...secrets } as Partial<Env>),
        NOW,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toContain("testnet");
        expect(result.reason).toContain("no sandbox");
      }
    });

    it("does not blame a missing secret for what is an environment refusal", () => {
      // The check order this pins: a testnet deploy with no secrets must NOT be
      // told to run `wrangler secret put`. Setting the secret would not help,
      // and sending an operator to do it hides the real answer.
      const result = resolveKrakenExchange(env({ ENVIRONMENT: "testnet" }), NOW);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).not.toContain("wrangler secret put");
        expect(result.reason).toContain("will not change this");
      }
    });

    it("never names the production host in the refusal", () => {
      const result = resolveKrakenExchange(
        env({
          ENVIRONMENT: "testnet",
          KRAKEN_API_KEY: "kraken-key",
          KRAKEN_API_SECRET: VALID_SECRET,
        }),
        NOW,
      );
      expect(result.ok).toBe(false);
      // The reason may explain that it is refusing to POINT AT the production
      // host -- it must not read as an instruction to use it.
      if (!result.ok) expect(result.reason).toContain("Refusing to build a client");
    });
  });

  describe("fail-closed on credentials, in production", () => {
    it("fails closed naming BOTH secrets when neither is set", () => {
      const result = resolveKrakenExchange(env({ ENVIRONMENT: "production" }), NOW);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toContain("KRAKEN_API_KEY");
        expect(result.reason).toContain("KRAKEN_API_SECRET");
        expect(result.reason).toContain("--env production");
      }
    });

    it("fails closed naming the single missing secret", () => {
      const result = resolveKrakenExchange(
        env({ ENVIRONMENT: "production", KRAKEN_API_KEY: "k" }),
        NOW,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toContain("KRAKEN_API_SECRET");
        expect(result.reason).not.toContain("KRAKEN_API_KEY or");
      }
    });

    it("fails closed on a missing key when the secret is set", () => {
      const result = resolveKrakenExchange(
        env({ ENVIRONMENT: "production", KRAKEN_API_SECRET: VALID_SECRET }),
        NOW,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toContain("KRAKEN_API_KEY");
        expect(result.reason).not.toContain("KRAKEN_API_SECRET or");
      }
    });

    it("treats a blank secret as missing", () => {
      const result = resolveKrakenExchange(
        env({ ENVIRONMENT: "production", KRAKEN_API_KEY: "k", KRAKEN_API_SECRET: "   " }),
        NOW,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toContain("KRAKEN_API_SECRET");
    });

    it("refuses a malformed secret cleanly instead of throwing", () => {
      // Kraken's secret is base64 that must DECODE, unlike Binance's and
      // Gemini's. `decodeApiSecret` throws; the resolver must convert that into
      // a reason, or a mistyped secret becomes an unhandled error at resolve
      // time instead of a clean refusal.
      const result = resolveKrakenExchange(
        env({
          ENVIRONMENT: "production",
          KRAKEN_API_KEY: "k",
          KRAKEN_API_SECRET: "not-valid-base64!",
        }),
        NOW,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toContain("KRAKEN_API_SECRET");
        expect(result.reason).toContain("base64");
      }
    });

    it("refuses a truncated paste, the common real cause", () => {
      const result = resolveKrakenExchange(
        env({ ENVIRONMENT: "production", KRAKEN_API_KEY: "k", KRAKEN_API_SECRET: "abcde" }),
        NOW,
      );
      expect(result.ok).toBe(false);
    });

    it("never leaks a secret value into the reason", () => {
      const secret = "super-secret-value-that-is-not-base64";
      const result = resolveKrakenExchange(
        env({
          ENVIRONMENT: "production",
          KRAKEN_API_KEY: "super-secret-key",
          KRAKEN_API_SECRET: secret,
        }),
        NOW,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).not.toContain(secret);
        expect(result.reason).not.toContain("super-secret-key");
      }
    });
  });

  describe("production with valid secrets", () => {
    it("returns a factory, without any network call", () => {
      const result = resolveKrakenExchange(
        env({
          ENVIRONMENT: "production",
          KRAKEN_API_KEY: "kraken-key",
          KRAKEN_API_SECRET: VALID_SECRET,
        }),
        NOW,
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        // The factory only CONSTRUCTS a client; the constructor sends nothing.
        const client = result.exchangeFor("kraken-production");
        expect(client).not.toBeNull();
        expect(typeof client!.getAccountBalances).toBe("function");
        expect(typeof client!.placeOrder).toBe("function");
      }
    });

    it("builds every account's client against the one production host", () => {
      const result = resolveKrakenExchange(
        env({
          ENVIRONMENT: "production",
          KRAKEN_API_KEY: "kraken-key",
          KRAKEN_API_SECRET: VALID_SECRET,
        }),
        NOW,
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.exchangeFor("one")).not.toBe(result.exchangeFor("two"));
      }
    });
  });
});
