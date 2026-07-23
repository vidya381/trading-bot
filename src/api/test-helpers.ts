/**
 * Test-only helpers for the dashboard API layer, build step 10.
 *
 * Not exported from `index.ts` and imported only by `*.test.ts`, so esbuild
 * never bundles it into the Worker -- the same arrangement as
 * `/src/db/test-helpers.ts` and `/src/durable-objects/test-helpers.ts`.
 *
 * The centrepiece is a real RSA keypair minted with Web Crypto and used to SIGN
 * Access JWTs, so the verification tests exercise `crypto.subtle.verify` against
 * signatures this suite actually produced -- a valid one is accepted, a tampered
 * one is not -- rather than against a canned string. The public half is served
 * as a JWKS through the injected `fetchJwks`, so no network is touched.
 *
 * The constants below MATCH vitest.config.ts's `ACCESS_AUD` / `ACCESS_TEAM_DOMAIN`
 * bindings, so a token signed here verifies against the config that
 * `accessConfigFromEnv` builds from the (test) environment -- the real
 * secret-reading path is the one under test.
 */

import type { Jwks } from "./access";

/** Matches vitest.config.ts's ACCESS_AUD binding. */
export const TEST_AUD = "test-access-aud";
/** Matches `https://<ACCESS_TEAM_DOMAIN>` for vitest.config.ts's binding. */
export const TEST_ISSUER = "https://testteam.cloudflareaccess.com";
/** Where `accessConfigFromEnv` derives the JWKS URL to. */
export const TEST_JWKS_URL = `${TEST_ISSUER}/cdn-cgi/access/certs`;
export const DEFAULT_KID = "test-key-1";

export interface SigningKey {
  readonly privateKey: CryptoKey;
  readonly kid: string;
  /** The public key set, as `fetchJwks` would return it. */
  readonly jwks: Jwks;
}

/** Mint an RSA-2048 signing key and its single-key JWKS. */
export async function generateSigningKey(kid = DEFAULT_KID): Promise<SigningKey> {
  const pair = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const publicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const jwk = { ...publicJwk, kid, alg: "RS256", use: "sig" } as unknown as Jwks["keys"][number];
  return { privateKey: pair.privateKey, kid, jwks: { keys: [jwk] } };
}

function toBase64Url(input: string | Uint8Array): string {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export interface ClaimsInput {
  readonly email: string;
  /** Absolute epoch SECONDS. */
  readonly exp: number;
  readonly aud?: string | readonly string[];
  readonly iss?: string;
  readonly nbf?: number;
  readonly iat?: number;
}

/** Sign a well-formed RS256 Access JWT. Defaults `iss`/`aud` to the test values. */
export async function signAccessJwt(key: SigningKey, claims: ClaimsInput): Promise<string> {
  const header = { alg: "RS256", kid: key.kid, typ: "JWT" };
  const payload: Record<string, unknown> = {
    iss: claims.iss ?? TEST_ISSUER,
    aud: claims.aud ?? TEST_AUD,
    email: claims.email,
    exp: claims.exp,
  };
  if (claims.nbf !== undefined) payload.nbf = claims.nbf;
  if (claims.iat !== undefined) payload.iat = claims.iat;

  const signingInput = `${toBase64Url(JSON.stringify(header))}.${toBase64Url(JSON.stringify(payload))}`;
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key.privateKey,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${toBase64Url(new Uint8Array(signature))}`;
}

/**
 * Build a token with an arbitrary header `alg` and an empty signature, for the
 * "reject alg: none" case -- a real attacker's forgery, not something
 * `signAccessJwt` can produce.
 */
export function forgeUnsignedJwt(claims: ClaimsInput, alg = "none"): string {
  const header = { alg, kid: DEFAULT_KID, typ: "JWT" };
  const payload = { iss: claims.iss ?? TEST_ISSUER, aud: claims.aud ?? TEST_AUD, email: claims.email, exp: claims.exp };
  return `${toBase64Url(JSON.stringify(header))}.${toBase64Url(JSON.stringify(payload))}.`;
}
