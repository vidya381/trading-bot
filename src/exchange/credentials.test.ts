import { describe, expect, it } from "vitest";
import {
  CredentialError,
  DOCUMENTED_EXAMPLE_CREDENTIALS,
  fakeCredentialProvider,
  StaticCredentialProvider,
} from "./credentials";

describe("StaticCredentialProvider", () => {
  it("returns the credentials it was given", () => {
    const provider = new StaticCredentialProvider({
      apiKey: "key-abc",
      apiSecret: "secret-xyz",
    });

    expect(provider.getCredentials()).toStrictEqual({
      apiKey: "key-abc",
      apiSecret: "secret-xyz",
    });
  });

  it("returns the same frozen object every time, so the signer can cache on it", () => {
    const provider = new StaticCredentialProvider({
      apiKey: "key",
      apiSecret: "secret",
    });

    const first = provider.getCredentials();
    expect(provider.getCredentials()).toBe(first);
    expect(Object.isFrozen(first)).toBe(true);
  });

  it.each([
    ["apiKey", { apiKey: "", apiSecret: "secret" }],
    ["apiKey", { apiKey: "   ", apiSecret: "secret" }],
    ["apiSecret", { apiKey: "key", apiSecret: "" }],
    ["apiSecret", { apiKey: "key", apiSecret: "\t\n" }],
  ])("rejects a blank %s rather than signing with it", (field, credentials) => {
    expect(() => new StaticCredentialProvider(credentials)).toThrow(CredentialError);
    expect(() => new StaticCredentialProvider(credentials)).toThrow(field);
  });

  it("rejects a missing key without putting its value in the message", () => {
    expect(
      () =>
        new StaticCredentialProvider({
          apiKey: undefined as unknown as string,
          apiSecret: "secret",
        }),
    ).toThrow(CredentialError);
  });

  it("never echoes the secret in an error message", () => {
    // The secret is valid here and the key is not, so if the message included
    // the whole credential set this would catch it.
    let message = "";
    try {
      new StaticCredentialProvider({ apiKey: "", apiSecret: "super-secret-value" });
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).not.toContain("super-secret-value");
  });
});

describe("fakeCredentialProvider", () => {
  it("needs no real credentials to exist, so CI never depends on a secret", () => {
    const provider = fakeCredentialProvider();

    expect(provider.getCredentials()).toStrictEqual(DOCUMENTED_EXAMPLE_CREDENTIALS);
  });

  it("accepts overrides for tests that care about a specific key", () => {
    const provider = fakeCredentialProvider({ apiKey: "my-test-key" });

    expect(provider.getCredentials().apiKey).toBe("my-test-key");
    expect(provider.getCredentials().apiSecret).toBe(
      DOCUMENTED_EXAMPLE_CREDENTIALS.apiSecret,
    );
  });
});
