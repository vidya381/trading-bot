import { describe, expect, it } from "vitest";
import { DOCUMENTED_EXAMPLE_CREDENTIALS, fakeCredentialProvider } from "../credentials";
import {
  buildQueryString,
  ClockOffset,
  DEFAULT_RESYNC_INTERVAL_MS,
  DEFAULT_SAFETY_MARGIN_MS,
  RequestSigner,
  SigningError,
} from "./signing";

/**
 * The worked example from the exchange's own signing documentation.
 *
 * The value of this vector is that the expected signature is THEIRS, not
 * something this test computed. A test that derived the expectation the same way
 * the implementation does would agree with a broken implementation.
 */
const DOC_PAYLOAD =
  "symbol=LTCBTC&side=BUY&type=LIMIT&timeInForce=GTC&quantity=1&price=0.1&recvWindow=5000&timestamp=1499827319559";
const DOC_SIGNATURE =
  "c8db56825ae71d6d79447849e617115f4a920fa2acdcab2b053c4b2838bd6b71";

/** The same example, with a symbol containing non-ASCII characters. */
const DOC_PAYLOAD_UNICODE =
  "symbol=%EF%BC%91%EF%BC%92%EF%BC%93%EF%BC%94%EF%BC%95%EF%BC%96&side=BUY&type=LIMIT&timeInForce=GTC&quantity=1&price=0.1&recvWindow=5000&timestamp=1499827319559";
const DOC_SIGNATURE_UNICODE =
  "e1353ec6b14d888f1164ae9af8228a3dbd508bc82eb867db8ab6046442f33ef3";

const AT = 1_700_000_000_000;

describe("buildQueryString", () => {
  it("reproduces the documented payload byte for byte", () => {
    const payload = buildQueryString([
      ["symbol", "LTCBTC"],
      ["side", "BUY"],
      ["type", "LIMIT"],
      ["timeInForce", "GTC"],
      ["quantity", "1"],
      ["price", "0.1"],
      ["recvWindow", 5000],
      ["timestamp", 1499827319559],
    ]);

    expect(payload).toBe(DOC_PAYLOAD);
  });

  it("percent-encodes non-ASCII exactly as the exchange requires before signing", () => {
    const payload = buildQueryString([
      ["symbol", "１２３４５６"],
      ["side", "BUY"],
      ["type", "LIMIT"],
      ["timeInForce", "GTC"],
      ["quantity", "1"],
      ["price", "0.1"],
      ["recvWindow", 5000],
      ["timestamp", 1499827319559],
    ]);

    expect(payload).toBe(DOC_PAYLOAD_UNICODE);
  });

  it("preserves the given order rather than sorting", () => {
    // The signature covers the literal string sent, so reordering would break it.
    expect(
      buildQueryString([
        ["zebra", "1"],
        ["alpha", "2"],
      ]),
    ).toBe("zebra=1&alpha=2");
  });

  it("drops undefined values so optional parameters need no conditional", () => {
    expect(
      buildQueryString([
        ["symbol", "BTCUSDT"],
        ["icebergQty", undefined],
        ["timestamp", 1],
      ]),
    ).toBe("symbol=BTCUSDT&timestamp=1");
  });

  it("keeps a zero, which is a real value rather than an absent one", () => {
    expect(buildQueryString([["limit", 0]])).toBe("limit=0");
  });

  it("returns an empty string when everything is absent", () => {
    expect(buildQueryString([["a", undefined]])).toBe("");
  });
});

describe("RequestSigner", () => {
  const signer = () => new RequestSigner(fakeCredentialProvider());

  it("matches the signature published in the exchange's documentation", async () => {
    await expect(signer().sign(DOC_PAYLOAD)).resolves.toBe(DOC_SIGNATURE);
  });

  it("matches the documented signature for the non-ASCII example too", async () => {
    await expect(signer().sign(DOC_PAYLOAD_UNICODE)).resolves.toBe(
      DOC_SIGNATURE_UNICODE,
    );
  });

  it("produces lowercase hex of the expected length", async () => {
    const signature = await signer().sign("a=1");

    expect(signature).toMatch(/^[0-9a-f]{64}$/);
  });

  it("appends the signature last, covering everything before it", async () => {
    const query = await signer().signQuery([
      ["symbol", "LTCBTC"],
      ["side", "BUY"],
      ["type", "LIMIT"],
      ["timeInForce", "GTC"],
      ["quantity", "1"],
      ["price", "0.1"],
      ["recvWindow", 5000],
      ["timestamp", 1499827319559],
    ]);

    expect(query).toBe(`${DOC_PAYLOAD}&signature=${DOC_SIGNATURE}`);
  });

  it("gives different signatures for different payloads", async () => {
    const one = await signer().sign("a=1");
    const two = await signer().sign("a=2");

    expect(one).not.toBe(two);
  });

  it("gives different signatures under different secrets", async () => {
    const other = new RequestSigner(
      fakeCredentialProvider({ apiSecret: "a-completely-different-secret" }),
    );

    expect(await other.sign(DOC_PAYLOAD)).not.toBe(DOC_SIGNATURE);
  });

  it("exposes the api key for the header without signing it", () => {
    expect(signer().apiKey).toBe(DOCUMENTED_EXAMPLE_CREDENTIALS.apiKey);
  });

  it("reuses the imported key across calls", async () => {
    let reads = 0;
    const credentials = { ...DOCUMENTED_EXAMPLE_CREDENTIALS };
    const reusing = new RequestSigner({
      getCredentials: () => {
        reads += 1;
        return credentials;
      },
    });

    await reusing.sign("a=1");
    await reusing.sign("a=2");
    await reusing.sign("a=3");

    // Credentials are read every time, but the same object comes back, so the
    // CryptoKey import happens once.
    expect(reads).toBe(3);
    await expect(reusing.sign(DOC_PAYLOAD)).resolves.toBe(DOC_SIGNATURE);
  });

  it("re-imports when the provider returns a rotated credential object", async () => {
    let current = { ...DOCUMENTED_EXAMPLE_CREDENTIALS };
    const rotating = new RequestSigner({ getCredentials: () => current });

    expect(await rotating.sign(DOC_PAYLOAD)).toBe(DOC_SIGNATURE);

    current = { apiKey: "new-key", apiSecret: "a-rotated-secret" };

    // A cached key would still produce the documented signature here.
    expect(await rotating.sign(DOC_PAYLOAD)).not.toBe(DOC_SIGNATURE);
  });
});

describe("ClockOffset", () => {
  it("starts unsynced and refuses to produce a timestamp", () => {
    const clock = new ClockOffset();

    expect(clock.isSynced).toBe(false);
    expect(clock.offsetMs).toBeNull();
    expect(clock.syncedAt).toBeNull();
    expect(clock.ageMs(AT)).toBeNull();
    expect(() => clock.timestampFor(AT)).toThrow(SigningError);
    expect(() => clock.timestampFor(AT)).toThrow(/before the exchange clock has been synced/);
  });

  it("always needs a refresh before the first sync", () => {
    expect(new ClockOffset().needsRefresh(AT)).toBe(true);
  });

  it("computes the offset against the midpoint of the round trip", () => {
    const clock = new ClockOffset({ safetyMarginMs: 0 });
    // Sent at 1000, replied at 1400: the midpoint is 1200. The server said 1500,
    // so the exchange clock is 300ms ahead of the local one.
    clock.record({ serverTimeMs: 1500, sentAt: 1000, receivedAt: 1400 });

    expect(clock.offsetMs).toBe(300);
    expect(clock.roundTripMs).toBe(400);
    expect(clock.syncedAt).toBe(1400);
    expect(clock.isSynced).toBe(true);
  });

  it("handles a local clock running ahead of the exchange", () => {
    const clock = new ClockOffset({ safetyMarginMs: 0 });
    clock.record({ serverTimeMs: 900, sentAt: 1000, receivedAt: 1000 });

    expect(clock.offsetMs).toBe(-100);
    expect(clock.timestampFor(5000)).toBe(4900);
  });

  it("applies the offset to a request timestamp", () => {
    const clock = new ClockOffset({ safetyMarginMs: 0 });
    clock.record({ serverTimeMs: AT + 2500, sentAt: AT, receivedAt: AT });

    expect(clock.timestampFor(AT + 60_000)).toBe(AT + 62_500);
  });

  it("biases the timestamp backwards by the safety margin", () => {
    const clock = new ClockOffset();
    clock.record({ serverTimeMs: AT, sentAt: AT, receivedAt: AT });

    // The exchange rejects a timestamp more than 1s AHEAD but tolerates
    // recvWindow of lateness, so the margin is spent on the tight side.
    expect(clock.timestampFor(AT)).toBe(AT - DEFAULT_SAFETY_MARGIN_MS);
  });

  it("rounds to a whole millisecond, since the midpoint can be fractional", () => {
    const clock = new ClockOffset({ safetyMarginMs: 0 });
    clock.record({ serverTimeMs: 1000, sentAt: 1000, receivedAt: 1001 });

    expect(clock.offsetMs).toBe(-0.5);
    expect(Number.isInteger(clock.timestampFor(2000))).toBe(true);
  });

  it("reports age and refresh need against the sync time", () => {
    const clock = new ClockOffset();
    clock.record({ serverTimeMs: AT, sentAt: AT, receivedAt: AT });

    expect(clock.ageMs(AT + 1000)).toBe(1000);
    expect(clock.needsRefresh(AT + 1000)).toBe(false);
    expect(clock.needsRefresh(AT + DEFAULT_RESYNC_INTERVAL_MS - 1)).toBe(false);
    expect(clock.needsRefresh(AT + DEFAULT_RESYNC_INTERVAL_MS)).toBe(true);
  });

  it("honours a custom refresh interval", () => {
    const clock = new ClockOffset();
    clock.record({ serverTimeMs: AT, sentAt: AT, receivedAt: AT });

    expect(clock.needsRefresh(AT + 999, 1000)).toBe(false);
    expect(clock.needsRefresh(AT + 1000, 1000)).toBe(true);
  });

  it("replaces the offset on a later sample", () => {
    const clock = new ClockOffset({ safetyMarginMs: 0 });
    clock.record({ serverTimeMs: 1100, sentAt: 1000, receivedAt: 1000 });
    expect(clock.offsetMs).toBe(100);

    clock.record({ serverTimeMs: 2050, sentAt: 2000, receivedAt: 2000 });
    expect(clock.offsetMs).toBe(50);
  });

  it("clears back to unsynced", () => {
    const clock = new ClockOffset();
    clock.record({ serverTimeMs: AT, sentAt: AT, receivedAt: AT });

    clock.clear();

    expect(clock.isSynced).toBe(false);
    expect(clock.offsetMs).toBeNull();
    expect(clock.roundTripMs).toBeNull();
    expect(clock.needsRefresh(AT)).toBe(true);
  });

  it.each([
    ["a non-positive server time", { serverTimeMs: 0, sentAt: 1, receivedAt: 2 }],
    ["a NaN server time", { serverTimeMs: NaN, sentAt: 1, receivedAt: 2 }],
    ["a non-finite local clock", { serverTimeMs: 1, sentAt: Infinity, receivedAt: 2 }],
  ])("rejects %s", (_label, sample) => {
    expect(() => new ClockOffset().record(sample)).toThrow(SigningError);
  });

  it("rejects a sample whose reply precedes its request", () => {
    expect(() =>
      new ClockOffset().record({ serverTimeMs: 1000, sentAt: 500, receivedAt: 400 }),
    ).toThrow(/precedes/);
  });

  it("rejects a negative safety margin", () => {
    expect(() => new ClockOffset({ safetyMarginMs: -1 })).toThrow(SigningError);
  });
});
