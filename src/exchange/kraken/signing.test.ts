import { describe, expect, it } from "vitest";
import {
  fakeKrakenCredentialProvider,
  KRAKEN_DOCUMENTED_EXAMPLE_CREDENTIALS,
  StaticCredentialProvider,
} from "../credentials";
import {
  buildBody,
  decodeApiSecret,
  KRAKEN_FORM_CONTENT_TYPE,
  KrakenSigner,
  NonceGenerator,
  SigningError,
} from "./signing";

/**
 * KRAKEN'S OWN WORKED EXAMPLE. This is the vector that matters.
 *
 * Every value below is quoted verbatim from Kraken's Spot REST authentication
 * guide (docs.kraken.com/api/docs/guides/spot-rest-auth), where its Python, Go
 * and Node samples all share them precisely so an implementer can check their
 * output before going near production. Cross-checked against Kraken's support
 * article on the authentication algorithm, and reproduced independently with
 * `openssl` before a line of `signing.ts` was written.
 *
 * The point is that `DOC_SIGNATURE` is KRAKEN'S stated output, not this
 * implementation's. A test that derived the expectation the way the code derives
 * it would agree with a broken implementation -- and this signer has three
 * separate ways to be broken while still returning a well-formed base64 string
 * (see `signing.ts`'s header). This vector catches all three.
 */
const DOC_NONCE = 1616492376594;
const DOC_PATH = "/0/private/AddOrder";
const DOC_BODY =
  "nonce=1616492376594&ordertype=limit&pair=XBTUSD&price=37500&type=buy&volume=1.25";
const DOC_SIGNATURE =
  "4/dpxb3iT4tp/ZCVEwSnEsLxx0bqyhLpdfOpc6fn7OR8+UClSV5n9E6aSS8MPtnRfp32bAb0nmbRn6H8ndwLUQ==";

/**
 * The signature the documented example produces IF THE SECRET IS NOT DECODED --
 * i.e. if this signer copied Binance's and Gemini's `TextEncoder().encode()` of
 * the secret instead of base64-decoding it to raw bytes.
 *
 * Produced with `openssl`, keyed on the secret's own 88 characters rather than
 * the 64 bytes they decode to. It is pinned as a NEGATIVE assertion because
 * "not equal to the documented signature" is too weak a statement to catch this:
 * this is the specific wrong answer the most likely mistake yields, and it is a
 * perfectly well-formed base64 HMAC-SHA512 that Kraken answers with a bare
 * `EAPI:Invalid signature`.
 */
const DOC_SIGNATURE_IF_SECRET_NOT_DECODED =
  "zA0LsmBEQjAhiVXDC0d286hCa9i387Mf1ZKLsYKEAfzW+x3m5FeiAkR7eoNxQ7ykM1KedtbCWKAZ4wyKRSmgfQ==";

/**
 * Independent vectors over a second secret, on the endpoints this client will
 * actually call.
 *
 * Kraken publishes exactly one worked example, so these were generated the way
 * `gemini/signing.test.ts` generates its own -- by an external tool rather than
 * by this module:
 *
 *   KEYHEX=$(printf '%s' "$SECRET" | base64 -d | xxd -p | tr -d '\n')
 *   { printf '%s' "$PATH"; printf '%s%s' "$NONCE" "$BODY" | openssl dgst -sha256 -binary; } \
 *     | openssl dgst -sha512 -mac HMAC -macopt "hexkey:$KEYHEX" -binary | base64
 *
 * They exist so the documented vector is not load-bearing on its own: one value
 * could in principle be reproduced by a coincidence of path and body, four
 * cannot.
 */
const VECTOR_SECRET = "MTIzNGFiY2QxMjM0YWJjZDU2NzhlZjkwNTY3OGVmOTA=";

const V2_NONCE = 1700000000000;
const V2_PATH = "/0/private/BalanceEx";
const V2_BODY = "nonce=1700000000000";
const V2_SIGNATURE =
  "O7ZTAeunaDvw+1minF1mLorGYT3WFaLOvt9noBw/Ztoj1YBuk/ssixJ3nh4mbD38EB0O2JXgUG5YlhAEqhLfQA==";

const V3_NONCE = 1700000000001;
const V3_PATH = "/0/private/AddOrder";
const V3_BODY =
  "nonce=1700000000001&ordertype=limit&pair=XXBTZUSD&type=buy&volume=0.5&price=30000.00" +
  "&oflags=fciq&cl_ord_id=v1-dca-btc-3";
const V3_SIGNATURE =
  "bVxUDJMXmu5cZT5dD1c0CPm08OM2Pui6DvB2LmaM0cKlKNxuJcvf5ebE5Zt/Iw7SJBDcXfzu5QV3+PyRFvhl9A==";

/** V2's nonce and body EXACTLY, signed under a different path. Pins that the
 *  path is genuinely part of the signed message rather than decoration. */
const V4_PATH = "/0/private/Balance";
const V4_SIGNATURE =
  "F8f5AtcXkzpES3p+qZ7LibfKErlraMXHLW8ekcte8eh7VTY0FdMp8n7q529T7TDFGV2u8VVkuZaXfQcsreTG9A==";

function docSigner(): KrakenSigner {
  return new KrakenSigner(fakeKrakenCredentialProvider());
}

function signerWith(apiSecret: string): KrakenSigner {
  return new KrakenSigner(
    new StaticCredentialProvider({ apiKey: "public-key", apiSecret }),
  );
}

describe("Kraken's documented worked example", () => {
  it("produces EXACTLY the signature Kraken publishes", async () => {
    // The whole file exists for this assertion.
    await expect(docSigner().sign(DOC_PATH, DOC_NONCE, DOC_BODY)).resolves.toBe(
      DOC_SIGNATURE,
    );
  });

  it("reaches the documented signature through signedRequest too", async () => {
    const signed = await docSigner().signedRequest(DOC_PATH, DOC_NONCE, [
      ["ordertype", "limit"],
      ["pair", "XBTUSD"],
      ["price", "37500"],
      ["type", "buy"],
      ["volume", "1.25"],
    ]);

    // The body it built is Kraken's documented body, byte for byte...
    expect(signed.body).toBe(DOC_BODY);
    // ...and the header carries Kraken's documented signature.
    expect(signed.headers["API-Sign"]).toBe(DOC_SIGNATURE);
    expect(signed.headers["API-Key"]).toBe(KRAKEN_DOCUMENTED_EXAMPLE_CREDENTIALS.apiKey);
    expect(signed.path).toBe(DOC_PATH);
    expect(signed.nonce).toBe(DOC_NONCE);
  });

  it("does NOT produce the signature that skipping the base64 decode would give", async () => {
    // If `#key()` ever regresses to TextEncoder-encoding the secret the way the
    // Binance and Gemini signers do, this is the exact value it would return.
    await expect(docSigner().sign(DOC_PATH, DOC_NONCE, DOC_BODY)).resolves.not.toBe(
      DOC_SIGNATURE_IF_SECRET_NOT_DECODED,
    );
  });

  it("uses a secret that really is base64 of a 64-byte key", () => {
    // Guards the constant itself: Kraken's secret must decode, and Binance's
    // (held by the other constant) must not be substitutable for it.
    expect(decodeApiSecret(KRAKEN_DOCUMENTED_EXAMPLE_CREDENTIALS.apiSecret)).toHaveLength(
      64,
    );
  });
});

describe("buildBody", () => {
  it("writes the nonce first and reproduces the documented body byte for byte", () => {
    expect(
      buildBody(DOC_NONCE, [
        ["ordertype", "limit"],
        ["pair", "XBTUSD"],
        ["price", "37500"],
        ["type", "buy"],
        ["volume", "1.25"],
      ]),
    ).toBe(DOC_BODY);
  });

  it("preserves the given parameter order after the nonce", () => {
    expect(
      buildBody(V3_NONCE, [
        ["ordertype", "limit"],
        ["pair", "XXBTZUSD"],
        ["type", "buy"],
        ["volume", "0.5"],
        ["price", "30000.00"],
        ["oflags", "fciq"],
        ["cl_ord_id", "v1-dca-btc-3"],
      ]),
    ).toBe(V3_BODY);
  });

  it("emits only the nonce when there are no parameters", () => {
    expect(buildBody(V2_NONCE)).toBe(V2_BODY);
  });

  it("drops undefined params so an optional field needs no call-site conditional", () => {
    expect(
      buildBody(1, [
        ["pair", "XXBTZUSD"],
        ["cl_ord_id", undefined],
        ["type", "buy"],
      ]),
    ).toBe("nonce=1&pair=XXBTZUSD&type=buy");
  });

  it("percent-encodes values that would otherwise break the body", () => {
    // `&` and `=` in a value must not be able to forge an extra parameter.
    expect(buildBody(1, [["userref", "a&b=c"]])).toBe("nonce=1&userref=a%26b%3Dc");
  });

  it("does not encode the decimal points in a rendered Money value", () => {
    // A price that came back percent-encoded would still sign and send
    // consistently, but Kraken would read a different number.
    expect(buildBody(1, [["price", "30000.00"]])).toBe("nonce=1&price=30000.00");
  });
});

describe("decodeApiSecret", () => {
  it("decodes a Kraken secret to its raw key bytes, not its characters", () => {
    const decoded = decodeApiSecret(VECTOR_SECRET);

    // This secret is base64 of a known ASCII string, so the decode is checkable
    // without trusting any other part of this module.
    expect(new TextDecoder().decode(decoded)).toBe("1234abcd1234abcd5678ef905678ef90");
    // 44 base64 characters in, 32 raw bytes out. An implementation that skipped
    // the decode would have produced 44 bytes.
    expect(VECTOR_SECRET).toHaveLength(44);
    expect(decoded).toHaveLength(32);
  });

  it("decodes Kraken's own 88-character example secret to 64 bytes", () => {
    expect(
      decodeApiSecret(KRAKEN_DOCUMENTED_EXAMPLE_CREDENTIALS.apiSecret),
    ).toHaveLength(64);
  });

  it("tolerates surrounding whitespace from a paste", () => {
    expect(decodeApiSecret(`  ${VECTOR_SECRET}\n`)).toEqual(
      decodeApiSecret(VECTOR_SECRET),
    );
  });

  it("rejects a blank secret rather than signing with an empty key", () => {
    expect(() => decodeApiSecret("   ")).toThrow(SigningError);
  });

  it("rejects a secret whose length is not a multiple of four", () => {
    // The signature of a truncated paste.
    expect(() => decodeApiSecret("MTIzNGFiY2Q")).toThrow(/not valid base64/);
  });

  it("rejects a secret containing characters outside the base64 alphabet", () => {
    expect(() => decodeApiSecret("MTIz NGFi*2Q=")).toThrow(/not valid base64/);
  });

  it("cannot detect a valid-base64 secret from the wrong venue, and does not pretend to", () => {
    // Binance's example secret is 64 alphanumeric characters, so it IS
    // syntactically valid base64 and decodes without complaint -- to 48 bytes,
    // not the 64 Kraken issues. Pinned as a limit of local validation, not a
    // capability: only Kraken can reject a well-formed key that is not its own.
    const binanceStyle =
      "NhqPtmdSJYdKjVHjA7PZj4Mge3R5YNiP1e3UZjInClVN65XAbvqqM6A7H5fATj0j";

    expect(binanceStyle).toHaveLength(64);
    expect(decodeApiSecret(binanceStyle)).toHaveLength(48);
  });

  it("never puts the secret into its error message", () => {
    const secret = "not-valid-base64-at-all!!";
    try {
      decodeApiSecret(secret);
      expect.unreachable("expected decodeApiSecret to throw");
    } catch (error) {
      expect((error as Error).message).not.toContain(secret);
      // The length is reported, because a truncated paste is the common cause.
      expect((error as Error).message).toContain(String(secret.length));
    }
  });
});

describe("KrakenSigner.sign", () => {
  it("reproduces the independent BalanceEx vector", async () => {
    await expect(signerWith(VECTOR_SECRET).sign(V2_PATH, V2_NONCE, V2_BODY)).resolves.toBe(
      V2_SIGNATURE,
    );
  });

  it("reproduces the independent AddOrder vector", async () => {
    await expect(signerWith(VECTOR_SECRET).sign(V3_PATH, V3_NONCE, V3_BODY)).resolves.toBe(
      V3_SIGNATURE,
    );
  });

  it("signs the URI path: the same nonce and body under another path differ", async () => {
    const signer = signerWith(VECTOR_SECRET);

    const onBalanceEx = await signer.sign(V2_PATH, V2_NONCE, V2_BODY);
    const onBalance = await signer.sign(V4_PATH, V2_NONCE, V2_BODY);

    expect(onBalanceEx).toBe(V2_SIGNATURE);
    expect(onBalance).toBe(V4_SIGNATURE);
    expect(onBalance).not.toBe(onBalanceEx);
  });

  it("returns base64, not hex like the other two venues", async () => {
    const signature = await signerWith(VECTOR_SECRET).sign(V2_PATH, V2_NONCE, V2_BODY);

    expect(signature).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
    // 64 digest bytes -> 88 base64 characters. Hex would have been 128.
    expect(signature).toHaveLength(88);
  });

  it("gives different signatures under different secrets", async () => {
    const other = new KrakenSigner(
      fakeKrakenCredentialProvider({ apiSecret: VECTOR_SECRET }),
    );

    await expect(other.sign(DOC_PATH, DOC_NONCE, DOC_BODY)).resolves.not.toBe(
      DOC_SIGNATURE,
    );
  });

  it("refuses to sign a body that does not carry the nonce it was given", async () => {
    // The mismatch that yields a well-formed signature Kraken rejects.
    await expect(
      docSigner().sign(DOC_PATH, DOC_NONCE, "nonce=1616492376595&pair=XBTUSD"),
    ).rejects.toThrow(SigningError);
  });

  it("refuses a body with no nonce at all", async () => {
    await expect(docSigner().sign(DOC_PATH, DOC_NONCE, "pair=XBTUSD")).rejects.toThrow(
      /must begin with/,
    );
  });

  it("is not fooled by a nonce that is merely a prefix of the body's nonce", async () => {
    // `nonce=1616492376594...` starts with `nonce=1616492376`, so a naive
    // substring check would accept this and sign the wrong pair of values.
    await expect(docSigner().sign(DOC_PATH, 1616492376, DOC_BODY)).rejects.toThrow(
      SigningError,
    );
  });

  it("surfaces a malformed secret as a SigningError, not a crypto exception", async () => {
    await expect(signerWith("not-base64!").sign(V2_PATH, V2_NONCE, V2_BODY)).rejects.toThrow(
      SigningError,
    );
  });

  it("exposes the api key for the header without signing it", () => {
    expect(docSigner().apiKey).toBe(KRAKEN_DOCUMENTED_EXAMPLE_CREDENTIALS.apiKey);
  });

  it("reuses the imported key across calls", async () => {
    let reads = 0;
    const credentials = { ...KRAKEN_DOCUMENTED_EXAMPLE_CREDENTIALS };
    const reusing = new KrakenSigner({
      getCredentials: () => {
        reads += 1;
        return credentials;
      },
    });

    await reusing.sign(V2_PATH, V2_NONCE, V2_BODY);
    await reusing.sign(V2_PATH, V2_NONCE + 1, "nonce=1700000000001");
    await reusing.sign(V2_PATH, V2_NONCE + 2, "nonce=1700000000002");

    // Credentials are read every time, but the same object comes back, so the
    // CryptoKey import happens once.
    expect(reads).toBe(3);
    await expect(reusing.sign(DOC_PATH, DOC_NONCE, DOC_BODY)).resolves.toBe(DOC_SIGNATURE);
  });

  it("re-imports when the provider returns a rotated credential object", async () => {
    let current = { ...KRAKEN_DOCUMENTED_EXAMPLE_CREDENTIALS };
    const rotating = new KrakenSigner({ getCredentials: () => current });

    expect(await rotating.sign(DOC_PATH, DOC_NONCE, DOC_BODY)).toBe(DOC_SIGNATURE);

    current = { apiKey: "new-key", apiSecret: VECTOR_SECRET };

    // A cached key would still produce the documented signature here.
    expect(await rotating.sign(DOC_PATH, DOC_NONCE, DOC_BODY)).not.toBe(DOC_SIGNATURE);
  });

  it("does not cache a key derived from a secret that failed to decode", async () => {
    let current = { apiKey: "k", apiSecret: "not-base64!" };
    const recovering = new KrakenSigner({ getCredentials: () => current });

    await expect(recovering.sign(DOC_PATH, DOC_NONCE, DOC_BODY)).rejects.toThrow(
      SigningError,
    );

    // A rejected promise left in the cache would make the signer permanently
    // broken even after the secret is corrected.
    current = { ...KRAKEN_DOCUMENTED_EXAMPLE_CREDENTIALS };
    await expect(recovering.sign(DOC_PATH, DOC_NONCE, DOC_BODY)).resolves.toBe(
      DOC_SIGNATURE,
    );
  });
});

describe("KrakenSigner.signedRequest", () => {
  it("returns the exact body it signed, so the caller cannot rebuild a different one", async () => {
    const signed = await signerWith(VECTOR_SECRET).signedRequest(V3_PATH, V3_NONCE, [
      ["ordertype", "limit"],
      ["pair", "XXBTZUSD"],
      ["type", "buy"],
      ["volume", "0.5"],
      ["price", "30000.00"],
      ["oflags", "fciq"],
      ["cl_ord_id", "v1-dca-btc-3"],
    ]);

    expect(signed.body).toBe(V3_BODY);
    expect(signed.headers["API-Sign"]).toBe(V3_SIGNATURE);
  });

  it("carries only the two headers Kraken authenticates with", async () => {
    const signed = await docSigner().signedRequest(DOC_PATH, DOC_NONCE);

    expect(Object.keys(signed.headers).sort()).toStrictEqual(["API-Key", "API-Sign"]);
  });

  it("names the form encoding the signature depends on", () => {
    expect(KRAKEN_FORM_CONTENT_TYPE).toBe("application/x-www-form-urlencoded");
  });
});

describe("NonceGenerator, reused from the Gemini signer", () => {
  it("is the same contract Kraken's increasing-uint64 rule needs", () => {
    const nonces = new NonceGenerator();

    // Strictly increasing even when the clock does not advance between calls.
    expect(nonces.next(1_700_000_000_000)).toBe(1_700_000_000_000);
    expect(nonces.next(1_700_000_000_000)).toBe(1_700_000_000_001);
    expect(nonces.next(1_700_000_000_000)).toBe(1_700_000_000_002);
    // And it tracks the clock once the clock overtakes it again.
    expect(nonces.next(1_700_000_005_000)).toBe(1_700_000_005_000);
    expect(nonces.last).toBe(1_700_000_005_000);
  });

  it("produces a nonce a signed request round-trips unchanged", async () => {
    const nonces = new NonceGenerator();
    const nonce = nonces.next(1_700_000_000_000);

    const signed = await docSigner().signedRequest(V2_PATH, nonce);

    expect(signed.nonce).toBe(nonce);
    expect(signed.body).toBe(`nonce=${nonce}`);
  });
});
