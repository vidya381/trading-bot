import { describe, expect, it } from "vitest";
import { StaticCredentialProvider } from "../credentials";
import {
  buildPayload,
  geminiAccountNickname,
  geminiKeyScope,
  GeminiSigner,
  isGeminiAccountNickname,
  NonceGenerator,
  resolveAccountField,
  toBase64Utf8,
} from "./signing";

/**
 * Independent signing vectors.
 *
 * Gemini does not publish a worked example with an expected signature the way
 * Binance does (that is what lets `binance/signing.test.ts` assert against the
 * exchange's own stated output). To get the same guarantee -- an expectation not
 * computed the same way the implementation computes it -- these were produced by
 * an external tool, `openssl`, over a fixed secret and payload:
 *
 *   PAYLOAD=$(printf '%s' "$JSON" | base64)
 *   printf '%s' "$PAYLOAD" | openssl dgst -sha384 -hmac "$SECRET"
 *
 * A test that derived the expected hex by calling this module's own `sign` would
 * agree with a broken `sign`; a value from `openssl` does not.
 */
const VECTOR_SECRET = "1234abcd1234abcd5678ef905678ef90";

const V1_JSON = '{"request":"/v1/order/status","nonce":123456789}';
const V1_PAYLOAD_B64 = "eyJyZXF1ZXN0IjoiL3YxL29yZGVyL3N0YXR1cyIsIm5vbmNlIjoxMjM0NTY3ODl9";
const V1_SIGNATURE =
  "0576ea5c1635f0a96af133948a94e3f72cbf90043c5ad27ad9485b350a095c59f77e8a4e13d09b8748f17ab2838b801f";

const V2_PAYLOAD_B64 =
  "eyJyZXF1ZXN0IjoiL3YxL29yZGVyL25ldyIsIm5vbmNlIjo5ODc2NTQzMjEsInN5bWJvbCI6ImJ0Y3VzZCIsImFtb3VudCI6IjEuNSIsInByaWNlIjoiMzAwMDAuMDAiLCJzaWRlIjoiYnV5IiwidHlwZSI6ImV4Y2hhbmdlIGxpbWl0IiwiY2xpZW50X29yZGVyX2lkIjoiZ2VtaW5pLWRjYS1idGMtMyJ9";
const V2_SIGNATURE =
  "d62effaa57a836bc2fd25838fd5651c1cf2062970ba45a7b844a068f1a7828d0ed7d15bea317ead1fb3244833f1c7d06";

/**
 * The master-key vectors: the same payloads WITH Gemini's `account` field.
 *
 * The JSON below is not this module's output -- it is written by hand to Gemini's
 * documented shape (a top-level `account` string, placed immediately after
 * `nonce`, exactly as in Gemini's own example body for `/v1/balances`:
 * `{"request":"/v1/balances","nonce":"<nonce>","account":"primary",...}`) and then
 * base64'd and HMAC'd by `openssl`, as above. So the expectation is the SHAPE
 * Gemini documents, derived without running `buildPayload`; an implementation that
 * spelled the field `accounts`, nested it, or appended it in a different position
 * produces different bytes and fails here.
 */
const V3_JSON =
  '{"request":"/v1/order/new","nonce":987654321,"account":"primary","symbol":"btcusd",' +
  '"amount":"1.5","price":"30000.00","side":"buy","type":"exchange limit",' +
  '"client_order_id":"gemini-dca-btc-3"}';
const V3_PAYLOAD_B64 =
  "eyJyZXF1ZXN0IjoiL3YxL29yZGVyL25ldyIsIm5vbmNlIjo5ODc2NTQzMjEsImFjY291bnQiOiJwcmltYXJ5Iiwic3ltYm9sIjoiYnRjdXNkIiwiYW1vdW50IjoiMS41IiwicHJpY2UiOiIzMDAwMC4wMCIsInNpZGUiOiJidXkiLCJ0eXBlIjoiZXhjaGFuZ2UgbGltaXQiLCJjbGllbnRfb3JkZXJfaWQiOiJnZW1pbmktZGNhLWJ0Yy0zIn0=";
const V3_SIGNATURE =
  "19af9febd9ec3e54be2f797c328b427f8b12eb0ea278292cba7c7a68b967ef71e5f9edfc67ab0a0c3ccadc62a7ac0b31";

const V4_JSON = '{"request":"/v1/balances","nonce":123456789,"account":"primary"}';
const V4_PAYLOAD_B64 =
  "eyJyZXF1ZXN0IjoiL3YxL2JhbGFuY2VzIiwibm9uY2UiOjEyMzQ1Njc4OSwiYWNjb3VudCI6InByaW1hcnkifQ==";
const V4_SIGNATURE =
  "fb95ae863fa9918a9fdbe9ab41240626ae003306d99f28183308b5920dbbe7358b0546c5d557e37921aa5c40dbe90173";

function signerWith(apiSecret: string): GeminiSigner {
  return new GeminiSigner(
    new StaticCredentialProvider({ apiKey: "public-key", apiSecret }),
  );
}

describe("toBase64Utf8", () => {
  it("base64-encodes an ASCII payload", () => {
    expect(toBase64Utf8(V1_JSON)).toBe(V1_PAYLOAD_B64);
  });

  it("flattens UTF-8 to bytes before encoding, rather than throwing on it", () => {
    // btoa alone throws on any code point above 0xFF; this must not.
    const encoded = toBase64Utf8("café");
    expect(atob(encoded)).toBe(
      String.fromCharCode(...new TextEncoder().encode("café")),
    );
  });
});

describe("buildPayload", () => {
  it("writes request then nonce, and reproduces the documented byte layout", () => {
    // No params: exactly `{request, nonce}`, matching the openssl vector's input.
    expect(buildPayload("/v1/order/status", 123456789)).toBe(V1_PAYLOAD_B64);
  });

  it("preserves the given parameter order after request and nonce", () => {
    const payload = buildPayload("/v1/order/new", 987654321, [
      ["symbol", "btcusd"],
      ["amount", "1.5"],
      ["price", "30000.00"],
      ["side", "buy"],
      ["type", "exchange limit"],
      ["client_order_id", "gemini-dca-btc-3"],
    ]);
    expect(payload).toBe(V2_PAYLOAD_B64);
    // Decoding proves the wire JSON key order is request, nonce, then as given.
    expect(atob(payload)).toBe(
      '{"request":"/v1/order/new","nonce":987654321,"symbol":"btcusd",' +
        '"amount":"1.5","price":"30000.00","side":"buy","type":"exchange limit",' +
        '"client_order_id":"gemini-dca-btc-3"}',
    );
  });

  it("drops undefined params so an optional field needs no call-site conditional", () => {
    const payload = buildPayload("/v1/order/new", 1, [
      ["symbol", "btcusd"],
      ["client_order_id", undefined],
    ]);
    expect(atob(payload)).toBe('{"request":"/v1/order/new","nonce":1,"symbol":"btcusd"}');
  });

  it("reproduces the documented master-key order payload, byte for byte", () => {
    // `account` first among the params, so it lands right after request/nonce.
    const payload = buildPayload("/v1/order/new", 987654321, [
      ["account", "primary"],
      ["symbol", "btcusd"],
      ["amount", "1.5"],
      ["price", "30000.00"],
      ["side", "buy"],
      ["type", "exchange limit"],
      ["client_order_id", "gemini-dca-btc-3"],
    ]);
    expect(atob(payload)).toBe(V3_JSON);
    expect(payload).toBe(V3_PAYLOAD_B64);
  });

  it("reproduces the documented master-key balances payload, byte for byte", () => {
    const payload = buildPayload("/v1/balances", 123456789, [["account", "primary"]]);
    expect(atob(payload)).toBe(V4_JSON);
    expect(payload).toBe(V4_PAYLOAD_B64);
  });

  it("serialises an options array inline", () => {
    const payload = buildPayload("/v1/order/new", 1, [["options", ["maker-or-cancel"]]]);
    expect(atob(payload)).toBe(
      '{"request":"/v1/order/new","nonce":1,"options":["maker-or-cancel"]}',
    );
  });
});

describe("GeminiSigner.sign", () => {
  it("reproduces an independently computed HMAC-SHA384 hex signature", async () => {
    const signer = signerWith(VECTOR_SECRET);
    expect(await signer.sign(V1_PAYLOAD_B64)).toBe(V1_SIGNATURE);
  });

  it("signs the second vector identically to openssl", async () => {
    const signer = signerWith(VECTOR_SECRET);
    expect(await signer.sign(V2_PAYLOAD_B64)).toBe(V2_SIGNATURE);
  });

  it("signs a master-key order payload identically to openssl", async () => {
    const signer = signerWith(VECTOR_SECRET);
    expect(await signer.sign(V3_PAYLOAD_B64)).toBe(V3_SIGNATURE);
  });

  it("signs a master-key balances payload identically to openssl", async () => {
    const signer = signerWith(VECTOR_SECRET);
    expect(await signer.sign(V4_PAYLOAD_B64)).toBe(V4_SIGNATURE);
  });

  it("signs the payload that CARRIES account, not the one without it", async () => {
    // The signature covers the exact payload bytes, so adding `account` must
    // change the signature. A client that signed the account-less payload and
    // sent the account-carrying one would fail with InvalidSignature.
    const signer = signerWith(VECTOR_SECRET);
    expect(await signer.sign(V3_PAYLOAD_B64)).not.toBe(V2_SIGNATURE);
  });

  it("is SHA-384, not SHA-256: a 96-hex-character (48-byte) digest", async () => {
    const signer = signerWith(VECTOR_SECRET);
    expect(await signer.sign(V1_PAYLOAD_B64)).toHaveLength(96);
  });

  it("a different secret produces a different signature", async () => {
    const other = signerWith("a-different-secret-entirely");
    expect(await other.sign(V1_PAYLOAD_B64)).not.toBe(V1_SIGNATURE);
  });
});

describe("GeminiSigner.authHeaders", () => {
  it("returns the three headers with the base64 payload and its hex signature", async () => {
    const signer = signerWith(VECTOR_SECRET);
    const headers = await signer.authHeaders("/v1/order/status", 123456789);
    expect(headers).toEqual({
      "X-GEMINI-APIKEY": "public-key",
      "X-GEMINI-PAYLOAD": V1_PAYLOAD_B64,
      "X-GEMINI-SIGNATURE": V1_SIGNATURE,
    });
  });

  it("carries the api key from the provider, unsigned", async () => {
    const signer = signerWith(VECTOR_SECRET);
    const headers = await signer.authHeaders("/v1/balances", 1);
    expect(headers["X-GEMINI-APIKEY"]).toBe("public-key");
  });
});

describe("GeminiSigner key caching and rotation", () => {
  it("re-imports the key when the provider returns a new credentials object", async () => {
    let current = { apiKey: "k1", apiSecret: VECTOR_SECRET };
    const signer = new GeminiSigner({ getCredentials: () => current });

    const first = await signer.sign(V1_PAYLOAD_B64);
    expect(first).toBe(V1_SIGNATURE);

    // A rotation hands back a different object with a different secret.
    current = { apiKey: "k2", apiSecret: "rotated-secret" };
    const second = await signer.sign(V1_PAYLOAD_B64);
    expect(second).not.toBe(first);
  });
});

describe("geminiKeyScope", () => {
  // Gemini: "Master API keys are formatted with a prepending master-, while
  // account level API keys are formatted with a prepending account-."
  it("reads a master key off its documented prefix", () => {
    expect(geminiKeyScope("master-abc123")).toBe("master");
  });

  it("reads an account-level key off its documented prefix", () => {
    expect(geminiKeyScope("account-abc123")).toBe("account");
  });

  it("refuses to classify a key carrying neither prefix", () => {
    expect(geminiKeyScope("vmPUZE6mv9SD5VNHk4HlWFsOr6aKE2zvsw0MuIgwCIPy")).toBe("unknown");
  });
});

/**
 * Gemini's OWN published `name` -> `account` pairs, from the example response on
 * its `/v1/account/list` reference page.
 *
 * The independent oracle for the nickname rule: these three pairs were written by
 * Gemini, not derived by this code or by this test, and they exercise all three
 * clauses of the documented derivation at once — lower-casing ("Primary"), spaces
 * to dashes ("My Custody Account") and symbol removal ("Other exchange account!",
 * whose "!" disappears BEFORE the spaces become dashes). An implementation that
 * applied the clauses in the wrong order, or skipped one, disagrees with Gemini's
 * own table here.
 */
const GEMINI_DOCUMENTED_ACCOUNTS: ReadonlyArray<readonly [name: string, account: string]> = [
  ["Primary", "primary"],
  ["My Custody Account", "my-custody-account"],
  ["Other exchange account!", "other-exchange-account"],
];

describe("geminiAccountNickname", () => {
  it.each(GEMINI_DOCUMENTED_ACCOUNTS)(
    "derives Gemini's own documented nickname for %o",
    (name, account) => {
      expect(geminiAccountNickname(name)).toBe(account);
    },
  );

  it("removes symbols BEFORE turning spaces into dashes", () => {
    // If the order were reversed, the dashes inserted for the spaces would
    // themselves be stripped as symbols and this would collapse to "abc".
    expect(geminiAccountNickname("A! B? C")).toBe("a-b-c");
  });
});

describe("isGeminiAccountNickname", () => {
  it.each(GEMINI_DOCUMENTED_ACCOUNTS)(
    "accepts the nickname Gemini publishes for %o",
    (_name, account) => {
      expect(isGeminiAccountNickname(account)).toBe(true);
    },
  );

  it("rejects a display name, which is the mistake that earned InvalidAccountName", () => {
    expect(isGeminiAccountNickname("Primary")).toBe(false);
  });

  it.each(["My Account", "primary!", "PRIMARY", "prim ary", ""])(
    "rejects %o, which Gemini's derivation could never produce",
    (value) => {
      expect(isGeminiAccountNickname(value)).toBe(false);
    },
  );
});

describe("resolveAccountField", () => {
  it("sends the nickname for a master key", () => {
    expect(resolveAccountField("master-abc", "primary")).toEqual({
      ok: true,
      account: "primary",
    });
  });

  it("refuses a master key with no account name (Gemini's MissingAccounts)", () => {
    const resolved = resolveAccountField("master-abc", undefined);
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) {
      expect(resolved.reason).toContain("MASTER");
      expect(resolved.reason).toContain("MissingAccounts");
      expect(resolved.reason).toContain("GEMINI_ACCOUNT_NAME");
    }
  });

  it("treats a blank account name as no account name", () => {
    expect(resolveAccountField("master-abc", "   ").ok).toBe(false);
  });

  it("trims a configured nickname", () => {
    expect(resolveAccountField("master-abc", " primary ")).toEqual({
      ok: true,
      account: "primary",
    });
  });

  it("refuses the live-rejected display name and suggests the real nickname", () => {
    // The exact value that earned `InvalidAccountName` from the sandbox.
    const resolved = resolveAccountField("master-abc", "Primary");
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) {
      expect(resolved.reason).toContain("InvalidAccountName");
      expect(resolved.reason).toContain('Did you mean "primary"?');
    }
  });

  it("refuses a display name with spaces and symbols, suggesting the derivation", () => {
    const resolved = resolveAccountField("master-abc", "Other exchange account!");
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) {
      expect(resolved.reason).toContain('Did you mean "other-exchange-account"?');
    }
  });

  it("does NOT silently normalise a display name into a nickname", () => {
    // Rewriting the value would pick which real account gets traded, on a guess.
    // It must refuse and let a human confirm, not repair itself.
    const resolved = resolveAccountField("master-abc", "Primary");
    expect(resolved.ok).toBe(false);
    expect(resolveAccountField("master-abc", "primary")).toEqual({
      ok: true,
      account: "primary",
    });
  });

  it("applies the nickname check to unclassifiable keys too", () => {
    expect(resolveAccountField("legacy-style-key", "Primary").ok).toBe(false);
  });

  it("sends NO account field for an account-level key", () => {
    expect(resolveAccountField("account-abc", undefined)).toEqual({
      ok: true,
      account: undefined,
    });
  });

  it("refuses an account-level key with a name (Gemini's AccountsOnGroupOnlyApi)", () => {
    const resolved = resolveAccountField("account-abc", "primary");
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) expect(resolved.reason).toContain("AccountsOnGroupOnlyApi");
  });

  it("trusts the configuration for an unclassifiable key, in both directions", () => {
    // No documented prefix: nothing can be derived, so nothing is overridden.
    expect(resolveAccountField("legacy-style-key", "sub-1")).toEqual({
      ok: true,
      account: "sub-1",
    });
    expect(resolveAccountField("legacy-style-key", undefined)).toEqual({
      ok: true,
      account: undefined,
    });
  });
});

describe("NonceGenerator", () => {
  it("returns the wall-clock milliseconds when the clock has advanced", () => {
    const nonce = new NonceGenerator();
    expect(nonce.next(1_700_000_000_000)).toBe(1_700_000_000_000);
    expect(nonce.next(1_700_000_000_005)).toBe(1_700_000_000_005);
  });

  it("strictly increases even when two requests fall in the same millisecond", () => {
    const nonce = new NonceGenerator();
    const a = nonce.next(1_700_000_000_000);
    const b = nonce.next(1_700_000_000_000);
    const c = nonce.next(1_700_000_000_000);
    expect(b).toBe(a + 1);
    expect(c).toBe(b + 1);
  });

  it("never goes backwards when the clock does", () => {
    const nonce = new NonceGenerator();
    const forward = nonce.next(1_700_000_000_010);
    const backward = nonce.next(1_700_000_000_000); // clock stepped back
    expect(backward).toBe(forward + 1);
  });

  it("floors a fractional millisecond", () => {
    const nonce = new NonceGenerator();
    expect(nonce.next(1_700_000_000_000.9)).toBe(1_700_000_000_000);
  });
});
