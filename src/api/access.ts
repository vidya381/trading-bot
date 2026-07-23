/**
 * Cloudflare Access JWT verification (spec section 11), build step 10 (backend
 * API layer).
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS WHEN ACCESS ALREADY GATES THE WORKER
 * ---------------------------------------------------------------------------
 * Cloudflare Access sits in front of this Worker and, in the normal path, no
 * request reaches application code without a valid Access session. Section 11
 * calls the `Cf-Access-Authenticated-User-Email` header "cryptographically
 * verified by Cloudflare, not spoofable by an outside request", and uses it as
 * the `audit_log` actor.
 *
 * This module is the belt to that braces. A request that somehow bypassed Access
 * -- a misconfigured route, a Worker reachable on a path Access does not cover,
 * a future refactor that moves the binding -- would arrive with whatever headers
 * it chose, and trusting the email header on its own would let it act as anyone.
 * So before the email is trusted as the actor for a liquidation, a reset or a
 * kill-switch pull, the accompanying `Cf-Access-Jwt-Assertion` token is verified
 * independently against Cloudflare's public keys. The header is then required to
 * MATCH the verified token's `email` claim, so the two Access-provided values
 * cannot disagree.
 *
 * ---------------------------------------------------------------------------
 * NO LIBRARY
 * ---------------------------------------------------------------------------
 * RS256 is verified with the Web Crypto API (`crypto.subtle`), native to the
 * Workers runtime. Section 2 forbids third-party crypto/Node shims, and
 * `wrangler.jsonc` sets no `nodejs_compat` flag; a JWT library would drag one
 * or the other in. The whole verification is ~a page of `atob`, `TextEncoder`
 * and `crypto.subtle.verify`.
 *
 * ---------------------------------------------------------------------------
 * WHERE THE CONFIG COMES FROM
 * ---------------------------------------------------------------------------
 *   - `ACCESS_AUD`  -- the Access application's Audience (AUD) tag. A SECRET,
 *     set per environment with `wrangler secret put ACCESS_AUD --env <env>`,
 *     because the tag differs between the testnet and production Access apps.
 *   - `ACCESS_TEAM_DOMAIN` -- the Zero Trust team domain, e.g.
 *     `myteam.cloudflareaccess.com`. A plain VAR in wrangler.jsonc (it is not
 *     sensitive). The token issuer is `https://<team-domain>` and the JWKS lives
 *     at `<issuer>/cdn-cgi/access/certs`.
 *
 * Both are read by `accessConfigFromEnv`. If either is absent the layer refuses
 * every request with a 503 rather than trusting the header alone -- an
 * unconfigured verifier is a broken control, and a broken safety control fails
 * closed.
 */

import { ApiError } from "./envelope";

/** A single RSA public key from Cloudflare's JWKS. */
interface Jwk {
  readonly kty: string;
  readonly kid: string;
  readonly n: string;
  readonly e: string;
  readonly alg?: string;
  readonly use?: string;
}

/** Cloudflare's JWKS document: the set of keys tokens may be signed with. */
export interface Jwks {
  readonly keys: readonly Jwk[];
}

/** How the JWKS is fetched. Injected so tests serve their own signing key. */
export type JwksFetcher = (url: string) => Promise<Jwks>;

export interface AccessConfig {
  /** ACCESS_AUD: the Access application's Audience tag. */
  readonly aud: string;
  /** `https://<team-domain>`: the expected `iss`. */
  readonly issuer: string;
  /** `<issuer>/cdn-cgi/access/certs`. */
  readonly jwksUrl: string;
  /** Milliseconds since epoch, as everywhere else. Defaults to `Date.now`. */
  readonly now?: () => number;
  /** Raw (uncached) JWKS fetch. Defaults to a real network fetch. */
  readonly fetchJwks?: JwksFetcher;
  /** Where fetched key sets are cached. Defaults to a per-isolate singleton. */
  readonly jwksCache?: Map<string, Jwks>;
}

/**
 * Small tolerance for clock skew between this isolate and Cloudflare's signer,
 * applied to `exp` and `nbf`. Seconds. A minute is generous for a token minted
 * seconds ago and comfortably inside any real drift.
 */
const CLOCK_SKEW_SECONDS = 60;

/** Per-isolate default JWKS cache. Access rotates keys rarely; a miss refetches. */
const DEFAULT_JWKS_CACHE = new Map<string, Jwks>();

// ---------------------------------------------------------------------------
// base64url helpers
// ---------------------------------------------------------------------------

function base64UrlToBytes(input: string): Uint8Array {
  const base64 = input.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64.length % 4 === 0 ? base64 : base64 + "=".repeat(4 - (base64.length % 4));
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function base64UrlToString(input: string): string {
  return new TextDecoder().decode(base64UrlToBytes(input));
}

function decodeJson(segment: string, what: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(base64UrlToString(segment));
  } catch {
    throw denied("access_jwt_malformed", `the Access token's ${what} is not valid base64url JSON`);
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw denied("access_jwt_malformed", `the Access token's ${what} is not a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

/** Every verification failure is a 401. One helper so the status is uniform. */
function denied(code: string, message: string): ApiError {
  return new ApiError(401, code, message);
}

// ---------------------------------------------------------------------------
// JWKS
// ---------------------------------------------------------------------------

async function networkFetchJwks(url: string): Promise<Jwks> {
  const response = await fetch(url);
  if (!response.ok) {
    throw denied(
      "access_jwks_unavailable",
      `could not fetch Cloudflare's Access signing keys from ${url} (HTTP ${response.status})`,
    );
  }
  return (await response.json()) as Jwks;
}

async function loadJwks(config: AccessConfig, refresh: boolean): Promise<Jwks> {
  const cache = config.jwksCache ?? DEFAULT_JWKS_CACHE;
  if (!refresh) {
    const cached = cache.get(config.jwksUrl);
    if (cached !== undefined) return cached;
  }
  const fetched = await (config.fetchJwks ?? networkFetchJwks)(config.jwksUrl);
  cache.set(config.jwksUrl, fetched);
  return fetched;
}

/**
 * Find the signing key named by the token's `kid`, refetching the JWKS ONCE on
 * a miss. A `kid` absent from the cached set is the ordinary symptom of a key
 * rotation, so a single forced refresh is tried before giving up.
 */
async function resolveKey(config: AccessConfig, kid: string): Promise<Jwk> {
  let jwks = await loadJwks(config, false);
  let jwk = jwks.keys.find((key) => key.kid === kid);
  if (jwk === undefined) {
    jwks = await loadJwks(config, true);
    jwk = jwks.keys.find((key) => key.kid === kid);
  }
  if (jwk === undefined) {
    throw denied(
      "access_unknown_key",
      `the Access token is signed with key ${JSON.stringify(kid)}, which is not among ` +
        `Cloudflare's current signing keys. The token may be forged, or from a different team.`,
    );
  }
  return jwk;
}

async function verifySignature(jwk: Jwk, signingInput: string, signature: Uint8Array): Promise<boolean> {
  const key = await crypto.subtle.importKey(
    "jwk",
    { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  return await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    signature,
    new TextEncoder().encode(signingInput),
  );
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

/** The claims this system reads off a verified token. */
export interface AccessClaims {
  readonly email: string;
}

/**
 * Verify one Access JWT and return its claims, or throw a 401.
 *
 * The order matters: structure, then algorithm, then signature, THEN the
 * claims. Checking `aud`/`exp` before the signature would be reading assertions
 * from an unverified document; nothing the token says is trusted until the
 * signature holds.
 */
export async function verifyAccessJwt(token: string, config: AccessConfig): Promise<AccessClaims> {
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw denied("access_jwt_malformed", "the Access token is not a three-part JWT");
  }
  const [headerB64, payloadB64, signatureB64] = parts as [string, string, string];

  const header = decodeJson(headerB64, "header");
  if (header.alg !== "RS256") {
    // Reject "none" and any symmetric or unexpected algorithm outright, rather
    // than trying to accommodate it. Cloudflare Access signs with RS256; an
    // "alg" this system does not expect is a red flag, not a format to support.
    throw denied(
      "access_bad_algorithm",
      `the Access token's alg is ${JSON.stringify(header.alg)}, not RS256`,
    );
  }
  if (typeof header.kid !== "string" || header.kid === "") {
    throw denied("access_jwt_malformed", "the Access token has no key id (kid)");
  }

  const jwk = await resolveKey(config, header.kid);
  const valid = await verifySignature(jwk, `${headerB64}.${payloadB64}`, base64UrlToBytes(signatureB64));
  if (!valid) {
    throw denied(
      "access_bad_signature",
      "the Access token's signature does not verify against Cloudflare's signing key. " +
        "It was tampered with or not issued by Access.",
    );
  }

  // Signature holds: from here the payload is trustworthy and its claims can be
  // checked.
  const claims = decodeJson(payloadB64, "payload");
  const nowSeconds = Math.floor((config.now ?? Date.now)() / 1000);

  if (claims.iss !== config.issuer) {
    throw denied(
      "access_bad_issuer",
      `the Access token's issuer ${JSON.stringify(claims.iss)} is not this environment's ` +
        `team domain ${JSON.stringify(config.issuer)}`,
    );
  }

  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audiences.includes(config.aud)) {
    throw denied(
      "access_bad_audience",
      "the Access token's audience does not include this environment's ACCESS_AUD. " +
        "It was issued for a different Access application.",
    );
  }

  if (typeof claims.exp !== "number" || nowSeconds > claims.exp + CLOCK_SKEW_SECONDS) {
    throw denied("access_token_expired", "the Access token has expired");
  }
  if (typeof claims.nbf === "number" && nowSeconds < claims.nbf - CLOCK_SKEW_SECONDS) {
    throw denied("access_token_not_yet_valid", "the Access token is not valid yet (nbf in the future)");
  }

  if (typeof claims.email !== "string" || claims.email.trim() === "") {
    throw denied("access_no_email", "the Access token carries no email claim");
  }

  return { email: claims.email };
}

/** Normalise an email for comparison: trimmed and lower-cased. */
function canonicalEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Authenticate one request and return the actor email to record.
 *
 * Reads both Access-provided values -- the JWT (`Cf-Access-Jwt-Assertion`) and
 * the email header (`Cf-Access-Authenticated-User-Email`) -- verifies the JWT,
 * and requires the header to match the verified `email` claim. The returned
 * actor is the VERIFIED claim, not the header: the header is only ever trusted
 * to the extent it agrees with a signature that checks out.
 */
export async function authenticate(request: Request, config: AccessConfig): Promise<string> {
  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  if (token === null || token === "") {
    throw denied(
      "access_jwt_missing",
      "no Cf-Access-Jwt-Assertion header. Every request must arrive through Cloudflare " +
        "Access, which sets it; a request without it did not.",
    );
  }

  const headerEmail = request.headers.get("Cf-Access-Authenticated-User-Email");
  if (headerEmail === null || headerEmail.trim() === "") {
    throw denied(
      "access_email_missing",
      "no Cf-Access-Authenticated-User-Email header alongside the token",
    );
  }

  const claims = await verifyAccessJwt(token, config);
  if (canonicalEmail(claims.email) !== canonicalEmail(headerEmail)) {
    throw denied(
      "access_email_mismatch",
      "the Cf-Access-Authenticated-User-Email header does not match the verified token's " +
        "email claim. The two Access values disagree; the request is refused.",
    );
  }

  return claims.email;
}

/**
 * Build the verifier config from the environment, or refuse.
 *
 * `overrides` lets a caller inject the clock, the JWKS fetcher and the cache
 * (tests do; the Worker leaves them defaulted). The `aud` and team domain come
 * only from the environment -- there is no override for them, so a test cannot
 * accidentally verify against a made-up audience while the code path that reads
 * the real secret goes unexercised.
 */
export function accessConfigFromEnv(
  env: Env,
  overrides: Pick<AccessConfig, "now" | "fetchJwks" | "jwksCache"> = {},
): AccessConfig {
  const aud = env.ACCESS_AUD;
  if (aud === undefined || aud === "") {
    throw new ApiError(
      503,
      "access_unconfigured",
      "no ACCESS_AUD secret in this environment, so the Access token cannot be verified. " +
        "Set it with `wrangler secret put ACCESS_AUD --env <env>`. The API refuses every " +
        "request until it exists rather than trusting the email header alone.",
    );
  }
  const domain = env.ACCESS_TEAM_DOMAIN;
  if (domain === undefined || domain === "") {
    throw new ApiError(
      503,
      "access_unconfigured",
      "no ACCESS_TEAM_DOMAIN var in this environment, so the token issuer and JWKS URL are " +
        "unknown. Set it in wrangler.jsonc to your Zero Trust team domain " +
        "(e.g. myteam.cloudflareaccess.com).",
    );
  }

  const issuer = normalizeIssuer(domain);
  return {
    aud,
    issuer,
    jwksUrl: `${issuer}/cdn-cgi/access/certs`,
    ...overrides,
  };
}

/** `myteam.cloudflareaccess.com` or a full URL -> `https://myteam.cloudflareaccess.com`. */
function normalizeIssuer(domain: string): string {
  const trimmed = domain.trim().replace(/\/+$/, "");
  return /^https?:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`;
}

// The two Access settings this module reads. `ACCESS_TEAM_DOMAIN` is also
// declared in wrangler.jsonc's testnet/production vars; `ACCESS_AUD` is a secret
// and so lives only here for typing. Both optional, mirroring how
// src/workers/notifications.ts declares DISCORD_WEBHOOK_URL -- the base env
// (a deploy with no --env) has neither, and `accessConfigFromEnv` handles that
// with a 503 rather than a type assertion.
declare global {
  interface Env {
    readonly ACCESS_AUD?: string;
    readonly ACCESS_TEAM_DOMAIN?: string;
  }
}
