/**
 * Cloudflare Access JWT verification (spec section 11), build step 10.
 *
 * The defensive check the brief calls for specifically: a request with a VALID
 * signature is accepted, a TAMPERED or MISSING one is rejected. The signatures
 * here are real -- minted with a Web Crypto RSA key in `test-helpers.ts` and
 * verified with the same `crypto.subtle` the Worker uses -- so this exercises
 * the cryptography, not a stub of it. The public key is served through an
 * injected `fetchJwks`, so no network is touched.
 */

import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { accessConfigFromEnv, authenticate, verifyAccessJwt, type AccessConfig } from "./access";
import {
  DEFAULT_KID,
  forgeUnsignedJwt,
  generateSigningKey,
  signAccessJwt,
  TEST_AUD,
  TEST_ISSUER,
  TEST_JWKS_URL,
  type SigningKey,
} from "./test-helpers";

const NOW_MS = 1_760_000_000_000;
const NOW_SECONDS = Math.floor(NOW_MS / 1000);
const EMAIL = "owner@example.com";

let key: SigningKey;

beforeAll(async () => {
  key = await generateSigningKey();
});

let config: AccessConfig;

beforeEach(() => {
  config = {
    aud: TEST_AUD,
    issuer: TEST_ISSUER,
    jwksUrl: TEST_JWKS_URL,
    now: () => NOW_MS,
    fetchJwks: async () => key.jwks,
    jwksCache: new Map(),
  };
});

/** A request carrying a token and (by default) a matching email header. */
function request(token: string | null, email: string | null = EMAIL): Request {
  const headers = new Headers();
  if (token !== null) headers.set("Cf-Access-Jwt-Assertion", token);
  if (email !== null) headers.set("Cf-Access-Authenticated-User-Email", email);
  return new Request("https://dash.example.com/api/bots", { headers });
}

async function validToken(overrides: Partial<Parameters<typeof signAccessJwt>[1]> = {}): Promise<string> {
  return await signAccessJwt(key, { email: EMAIL, exp: NOW_SECONDS + 3600, ...overrides });
}

describe("verifyAccessJwt", () => {
  it("accepts a valid token and returns its email claim", async () => {
    const claims = await verifyAccessJwt(await validToken(), config);
    expect(claims.email).toBe(EMAIL);
  });

  it("rejects a token whose signature was tampered with", async () => {
    const token = await validToken();
    // Flip the FIRST character of the signature segment. (The last base64url
    // char of a 256-byte RSA signature carries "don't care" low bits, so
    // flipping it can decode to the same bytes; the first char always changes
    // byte 0.)
    const parts = token.split(".");
    const sig = parts[2]!;
    parts[2] = (sig.startsWith("A") ? "B" : "A") + sig.slice(1);
    await expect(verifyAccessJwt(parts.join("."), config)).rejects.toMatchObject({
      code: "access_bad_signature",
    });
  });

  it("rejects a token whose payload was edited after signing", async () => {
    // Sign as owner, then swap in an attacker's email. The signature no longer
    // covers the payload, so it must fail -- this is the whole point.
    const token = await validToken();
    const [header, , signature] = token.split(".") as [string, string, string];
    const forgedPayload = btoa(JSON.stringify({ iss: TEST_ISSUER, aud: TEST_AUD, email: "attacker@evil.com", exp: NOW_SECONDS + 3600 }))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    await expect(verifyAccessJwt(`${header}.${forgedPayload}.${signature}`, config)).rejects.toMatchObject({
      code: "access_bad_signature",
    });
  });

  it("rejects alg: none (an unsigned forgery)", async () => {
    const forged = forgeUnsignedJwt({ email: EMAIL, exp: NOW_SECONDS + 3600 });
    await expect(verifyAccessJwt(forged, config)).rejects.toMatchObject({
      code: "access_bad_algorithm",
    });
  });

  it("rejects an expired token", async () => {
    const expired = await validToken({ exp: NOW_SECONDS - 3600 });
    await expect(verifyAccessJwt(expired, config)).rejects.toMatchObject({
      code: "access_token_expired",
    });
  });

  it("rejects a token not yet valid (nbf in the future)", async () => {
    const future = await validToken({ nbf: NOW_SECONDS + 3600 });
    await expect(verifyAccessJwt(future, config)).rejects.toMatchObject({
      code: "access_token_not_yet_valid",
    });
  });

  it("rejects a wrong audience", async () => {
    const wrong = await validToken({ aud: "some-other-app" });
    await expect(verifyAccessJwt(wrong, config)).rejects.toMatchObject({
      code: "access_bad_audience",
    });
  });

  it("rejects a wrong issuer", async () => {
    const wrong = await validToken({ iss: "https://someone-else.cloudflareaccess.com" });
    await expect(verifyAccessJwt(wrong, config)).rejects.toMatchObject({
      code: "access_bad_issuer",
    });
  });

  it("rejects a token signed by a key not in the JWKS", async () => {
    const otherKey = await generateSigningKey("rotated-out-key");
    const token = await signAccessJwt(otherKey, { email: EMAIL, exp: NOW_SECONDS + 3600 });
    // config.fetchJwks still serves only the original key, so the kid is unknown
    // even after the one forced refetch.
    await expect(verifyAccessJwt(token, config)).rejects.toMatchObject({
      code: "access_unknown_key",
    });
  });

  it("accepts an audience array that includes the expected aud", async () => {
    const token = await validToken({ aud: ["another-app", TEST_AUD] });
    const claims = await verifyAccessJwt(token, config);
    expect(claims.email).toBe(EMAIL);
  });
});

describe("authenticate (JWT + email-header agreement)", () => {
  it("returns the verified email when both are present and agree", async () => {
    const actor = await authenticate(request(await validToken()), config);
    expect(actor).toBe(EMAIL);
  });

  it("rejects a request with no token", async () => {
    await expect(authenticate(request(null), config)).rejects.toMatchObject({
      code: "access_jwt_missing",
    });
  });

  it("rejects a request with no email header", async () => {
    await expect(authenticate(request(await validToken(), null), config)).rejects.toMatchObject({
      code: "access_email_missing",
    });
  });

  it("rejects when the email header disagrees with the verified claim", async () => {
    await expect(
      authenticate(request(await validToken(), "someone-else@example.com"), config),
    ).rejects.toMatchObject({ code: "access_email_mismatch" });
  });

  it("compares emails case-insensitively", async () => {
    const actor = await authenticate(request(await validToken(), "Owner@Example.com"), config);
    // The VERIFIED claim is returned, in its original casing.
    expect(actor).toBe(EMAIL);
  });
});

describe("accessConfigFromEnv", () => {
  it("builds issuer and JWKS URL from the environment's team domain and aud", () => {
    const built = accessConfigFromEnv(
      { ACCESS_AUD: "aud-x", ACCESS_TEAM_DOMAIN: "myteam.cloudflareaccess.com" } as unknown as Env,
      {},
    );
    expect(built.aud).toBe("aud-x");
    expect(built.issuer).toBe("https://myteam.cloudflareaccess.com");
    expect(built.jwksUrl).toBe("https://myteam.cloudflareaccess.com/cdn-cgi/access/certs");
  });

  it("refuses (503) when ACCESS_AUD is absent -- fails closed", () => {
    expect(() =>
      accessConfigFromEnv({ ACCESS_TEAM_DOMAIN: "myteam.cloudflareaccess.com" } as unknown as Env, {}),
    ).toThrowError(/ACCESS_AUD/);
  });

  it("refuses (503) when ACCESS_TEAM_DOMAIN is absent -- fails closed", () => {
    expect(() =>
      accessConfigFromEnv({ ACCESS_AUD: "aud-x" } as unknown as Env, {}),
    ).toThrowError(/ACCESS_TEAM_DOMAIN/);
  });

  it("keeps the default kid stable across helper calls", () => {
    // A guard on the shared constant the endpoint tests also rely on.
    expect(key.jwks.keys[0]!.kid).toBe(DEFAULT_KID);
  });
});
