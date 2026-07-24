/**
 * Thin fetch wrappers over the dashboard API (build step 10.4).
 *
 * All requests are same-origin `/api/*`. There is NO auth code here on purpose:
 * Cloudflare Access sits in front of this origin and the browser's existing
 * Access session cookie authenticates every request automatically (spec section
 * 11, this session's brief item 8). There is no login UI to build.
 *
 * Every endpoint answers in the `{ data, error }` envelope; `unwrap` turns a
 * failure envelope into a thrown `ApiError` carrying the backend's typed code,
 * so callers can branch on `error.code` rather than on prose.
 */

import type { ApiEnvelope, Alert, Bot, BotDetail, LiquidateResponse } from "./types";

/** An API failure, carrying the backend's typed error code. */
export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
  }
}

async function requestJson<T>(path: string, method: string, signal?: AbortSignal): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      signal,
      headers: { accept: "application/json" },
      // Same-origin; the Access cookie rides along by default. Explicit for
      // clarity that we rely on it.
      credentials: "same-origin",
    });
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === "AbortError") throw cause;
    throw new ApiError("network_error", "could not reach the API", 0);
  }

  // Access returns HTML (a login redirect) when a session has expired. Guard the
  // JSON parse so that surfaces as a clear error rather than a parse crash.
  let body: ApiEnvelope<T>;
  try {
    body = (await response.json()) as ApiEnvelope<T>;
  } catch {
    if (response.status === 401 || response.status === 403) {
      throw new ApiError("unauthenticated", "your session has expired -- reload to sign in again", response.status);
    }
    throw new ApiError("bad_response", `unexpected non-JSON response (${response.status})`, response.status);
  }

  if (body.error !== null) {
    throw new ApiError(body.error.code, body.error.message, response.status);
  }
  return body.data;
}

export function fetchBots(signal?: AbortSignal): Promise<Bot[]> {
  return requestJson<Bot[]>("/api/bots", "GET", signal);
}

export function fetchAlerts(signal?: AbortSignal): Promise<Alert[]> {
  return requestJson<Alert[]>("/api/alerts", "GET", signal);
}

/**
 * One bot's full detail (`GET /api/bots/:id`). A missing bot surfaces as an
 * `ApiError` with code `unknown_bot` (404); a schema-less environment as
 * `no_schema` (503) -- the detail page branches on those codes to show an
 * honest message rather than a blank page.
 */
export function fetchBot(id: string, signal?: AbortSignal): Promise<BotDetail> {
  return requestJson<BotDetail>(`/api/bots/${encodeURIComponent(id)}`, "GET", signal);
}

/**
 * Liquidate a halted bot's position (`POST /api/bots/:id/liquidate`). No request
 * body -- the backend takes the actor from the verified Access identity.
 *
 * The caller MUST inspect `result.action`, not just await success: the
 * price-unusable outcome is a 200 with `action: "no_price"` (position left held,
 * alerted), not a thrown error. A no-longer-halted bot throws `ApiError` with
 * code `invalid_status`; an environment with no exchange wired throws
 * `not_attached`.
 */
export function liquidateBot(id: string, signal?: AbortSignal): Promise<LiquidateResponse> {
  return requestJson<LiquidateResponse>(`/api/bots/${encodeURIComponent(id)}/liquidate`, "POST", signal);
}
