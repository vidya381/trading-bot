import { describe, expect, it } from "vitest";
import { StaticCredentialProvider } from "../credentials";
import {
  buildPayload,
  GeminiSigner,
  NonceGenerator,
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
