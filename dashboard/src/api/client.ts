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

import type {
  ApiEnvelope,
  Account,
  AccountSymbols,
  Alert,
  AlertCategory,
  AlertSeverity,
  ApplyMissedFillsResponse,
  Bot,
  BotDetail,
  CreateBotRequest,
  KillSwitchStatus,
  LiquidateResponse,
  ManualAdjustment,
  ManualAdjustmentRequest,
  ResumeResponse,
  StartResponse,
  TriggerKillSwitchResponse,
} from "./types";

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

interface RequestOptions {
  readonly signal?: AbortSignal;
  /** A JSON request body. Sent as `application/json` when present. */
  readonly body?: unknown;
}

async function requestJson<T>(path: string, method: string, options: RequestOptions = {}): Promise<T> {
  const { signal, body: requestBody } = options;
  const hasBody = requestBody !== undefined;
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      signal,
      headers: {
        accept: "application/json",
        ...(hasBody ? { "content-type": "application/json" } : {}),
      },
      // Same-origin; the Access cookie rides along by default. Explicit for
      // clarity that we rely on it.
      credentials: "same-origin",
      ...(hasBody ? { body: JSON.stringify(requestBody) } : {}),
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
  return requestJson<Bot[]>("/api/bots", "GET", { signal });
}

/**
 * Every registered account and its exchange (`GET /api/accounts`). The real,
 * authoritative list the create-bot form's account dropdown reads -- so an
 * account is chosen, never typed, and its exchange comes back alongside it rather
 * than being asked for a second time.
 */
export function fetchAccounts(signal?: AbortSignal): Promise<Account[]> {
  return requestJson<Account[]>("/api/accounts", "GET", { signal });
}

/**
 * One account's live tradable pairs (`GET /api/accounts/:label/symbols`), for the
 * create-bot pair typeahead. This is a REAL exchange call behind an hour-long KV
 * cache, so it can genuinely fail -- the caller must branch on the code:
 *   - `exchange_unavailable` (502) -- the venue could not be reached (the Binance
 *     geo-block seen live). Not the user's mistake; the form says so and suggests
 *     a different account rather than a generic error.
 *   - `unknown_account` (404)      -- no such registered account (rare here, since
 *     the dropdown only offers registered accounts).
 */
export function fetchAccountSymbols(label: string, signal?: AbortSignal): Promise<AccountSymbols> {
  return requestJson<AccountSymbols>(`/api/accounts/${encodeURIComponent(label)}/symbols`, "GET", { signal });
}

/**
 * The three filters `GET /api/alerts` supports SERVER-SIDE (`listAlerts` in
 * src/api/handlers.ts). All optional; an omitted field is not sent, so the
 * backend returns that dimension unfiltered. There is deliberately no
 * `botInstanceId` filter -- the backend does not offer one, and the cross-bot
 * feed does not need it (it shows every bot).
 */
export interface AlertFilters {
  readonly category?: AlertCategory;
  readonly severity?: AlertSeverity;
  readonly resolved?: boolean;
}

/**
 * Alerts across every bot and account (`GET /api/alerts`). Filtering is
 * SERVER-SIDE via query params -- the backend validates each value and 400s an
 * unrecognised one (`invalid_filter`), so we only ever send values from the
 * typed unions above and never fetch-everything-then-filter.
 */
export function fetchAlerts(filters: AlertFilters = {}, signal?: AbortSignal): Promise<Alert[]> {
  const params = new URLSearchParams();
  if (filters.category !== undefined) params.set("category", filters.category);
  if (filters.severity !== undefined) params.set("severity", filters.severity);
  if (filters.resolved !== undefined) params.set("resolved", String(filters.resolved));
  const query = params.toString();
  return requestJson<Alert[]>(`/api/alerts${query ? `?${query}` : ""}`, "GET", { signal });
}

/**
 * One bot's full detail (`GET /api/bots/:id`). A missing bot surfaces as an
 * `ApiError` with code `unknown_bot` (404); a schema-less environment as
 * `no_schema` (503) -- the detail page branches on those codes to show an
 * honest message rather than a blank page.
 */
export function fetchBot(id: string, signal?: AbortSignal): Promise<BotDetail> {
  return requestJson<BotDetail>(`/api/bots/${encodeURIComponent(id)}`, "GET", { signal });
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
  return requestJson<LiquidateResponse>(`/api/bots/${encodeURIComponent(id)}/liquidate`, "POST", { signal });
}

/**
 * Start a created bot (`POST /api/bots/:id/start`). No request body -- the
 * backend takes the actor from the verified Access identity.
 *
 * Unlike liquidate, there is NO success-with-a-different-action to inspect:
 * `BotInstance.start` only moves the status `created -> running` (it places no
 * order and makes no exchange call -- the base order/ladder fires later, on the
 * next price update), so a success is always `result.action: "started"`. Its
 * one refusal -- a bot that is no longer `created` -- arrives as a thrown
 * `ApiError` with code `invalid_status` (409). It therefore never returns the
 * `not_attached`/price/reachability outcomes liquidate can.
 */
export function startBot(id: string, signal?: AbortSignal): Promise<StartResponse> {
  return requestJson<StartResponse>(`/api/bots/${encodeURIComponent(id)}/start`, "POST", { signal });
}

/**
 * Resume a halted bot (`POST /api/bots/:id/resume`). No request body -- the
 * backend takes the actor from the verified Access identity. Section 7.2 step 5:
 * the only path out of `halted`, and human-only by construction.
 *
 * Like start, there is no success-with-a-different-action to inspect: a success
 * is always `result.action: "resumed"`. Its refusals, ALL raised before the
 * status flip so a failure leaves the bot halted:
 *   - `invalid_status`   (409) -- the bot is not halted anymore.
 *   - `globally_tripped` (409) -- the global kill switch is pulled. Start cannot
 *                                 produce this; resume asserts both latches.
 *   - `account_tripped`  (409) -- this account's circuit breaker is tripped.
 *                                 Likewise unique to resume.
 *   - `not_attached`     (503) -- no PRICE_FEED binding in this environment.
 * An unreachable feed/exchange is NOT among them: that path reconnects in the
 * background and the resume still succeeds (see types.ts for why).
 */
export function resumeBot(id: string, signal?: AbortSignal): Promise<ResumeResponse> {
  return requestJson<ResumeResponse>(`/api/bots/${encodeURIComponent(id)}/resume`, "POST", { signal });
}

/**
 * Repair order-state drift on a halted bot (`POST /api/bots/:id/apply-missed-fills`).
 * No request body -- the backend takes the actor from the verified Access
 * identity, and that identity is the point: section 9 never auto-corrects drift,
 * so this is a named human's decision in the audit log, not "cron".
 *
 * THE CALLER MUST INSPECT `result.skipped`, not merely await success. A 200 does
 * not mean everything was repaired: an order the exchange could not be read for,
 * or one whose response carried no per-fill detail, lands in `skipped` and is
 * still a 200. Treating success as "done" would report a half-finished repair as
 * finished.
 *
 * Its refusals, both from the bot object:
 *   - `invalid_status` (409) -- the bot is not halted. The repair must not race a
 *     live pipeline, so this is refused rather than queued.
 *   - `not_attached`  (503) -- no exchange client could be built for this account
 *     in this environment.
 *   - `not_created`   (404) -- the object holds no config for this id.
 *
 * It is IDEMPOTENT by construction (the exchange's own fill ids, deduplicated by
 * `applyFill`), so a retry after a lost response cannot double-count. It never
 * changes the bot's status and never places an order.
 */
export function applyMissedFills(id: string, signal?: AbortSignal): Promise<ApplyMissedFillsResponse> {
  return requestJson<ApplyMissedFillsResponse>(
    `/api/bots/${encodeURIComponent(id)}/apply-missed-fills`,
    "POST",
    { signal },
  );
}

/**
 * Create a bot instance (`POST /api/bots`). Returns the created bot's FULL
 * detail: the 201 body is the same `botDetail` shape as `GET /api/bots/:id`, so
 * the caller navigates straight to it without a second fetch (brief item 6).
 *
 * The backend is the source of truth for everything capital- and account-state
 * dependent, and each refusal is a distinct `ApiError` code the form branches on:
 *   - `insufficient_capital`      -- the ledger's available < requested; the
 *                                    message carries the available-vs-requested
 *                                    detail, shown verbatim (brief item 4).
 *   - `exceeds_allocated_capital` -- the config would out-spend its own
 *                                    allocation (planned spend > allocated).
 *   - `no_ledger_row`             -- the account+asset has no capital ledger yet.
 *   - `duplicate_bot_instance` / `already_created` -- the id is taken.
 *   - `globally_tripped` / `account_tripped` -- a pulled kill switch or a
 *                                    tripped account breaker blocks creation.
 *   - `invalid_parameter`         -- a strategy param failed the backend's own
 *                                    validation.
 * Creation does NOT touch the exchange (config is saved, no orders placed), so
 * unlike liquidate it never returns `not_attached`.
 */
export function createBot(request: CreateBotRequest, signal?: AbortSignal): Promise<BotDetail> {
  return requestJson<BotDetail>("/api/bots", "POST", { signal, body: request });
}

// ---------------------------------------------------------------------------
// Manual adjustments (spec 8.6)
// ---------------------------------------------------------------------------

/**
 * Log a manual fund movement (`POST /api/manual-adjustments`). `amount` is a
 * SIGNED decimal string -- negative withdraws, positive deposits -- and the form
 * builds that sign from an explicit Deposit/Withdrawal choice rather than asking
 * anyone to type a minus.
 *
 * On success the backend answers 201 with the saved row (its authoritative
 * record, including the id and createdAt), which the form shows as the
 * confirmation. Every refusal is a distinct `ApiError` code the form branches on:
 *   - `missing_field`  -- a required field (account, asset, note, or amount) was
 *                         absent or empty.
 *   - `invalid_amount` -- the amount was not a valid decimal (or had more than 8
 *                         decimal places).
 *   - `no_schema`      -- a schema-less environment (production before go-live).
 * There is NO idempotency key on this endpoint: unlike a bot create, a resubmit
 * after a lost response would write a SECOND row, and with no read endpoint that
 * cannot be checked from here -- the form's "couldn't confirm" copy says so
 * rather than inviting a blind retry.
 */
export function logManualAdjustment(
  request: ManualAdjustmentRequest,
  signal?: AbortSignal,
): Promise<ManualAdjustment> {
  return requestJson<ManualAdjustment>("/api/manual-adjustments", "POST", { signal, body: request });
}

// ---------------------------------------------------------------------------
// Global kill switch (spec section 7.4)
// ---------------------------------------------------------------------------

/** Current global kill-switch status (`GET /api/kill-switch`). */
export function fetchKillSwitch(signal?: AbortSignal): Promise<KillSwitchStatus> {
  return requestJson<KillSwitchStatus>("/api/kill-switch", "GET", { signal });
}

/**
 * Pull the global kill switch (`POST /api/kill-switch/trigger`), halting every
 * bot on every account. `reason` is required and becomes the permanent record of
 * why it was pulled; the backend refuses an empty one (`missing_field`).
 *
 * A partial outcome -- some bots halted, some unreachable -- is a normal 200 in
 * `result.failures`, NOT a thrown error. A caller must inspect the result, not
 * merely await success. If the POST itself throws (a network drop after the
 * latch may already have been written), the true state is unknown and the switch
 * may already be tripped; the action is idempotent and safe to re-read/retry.
 */
export function triggerKillSwitch(reason: string, signal?: AbortSignal): Promise<TriggerKillSwitchResponse> {
  return requestJson<TriggerKillSwitchResponse>("/api/kill-switch/trigger", "POST", {
    signal,
    body: { reason },
  });
}

/**
 * Re-arm the global kill switch (`POST /api/kill-switch/reset`). A distinct
 * action from triggering; `note` is required (the record of why it is safe to
 * re-arm). Resetting resumes NO bot -- each halted bot stays halted until resumed
 * individually. A switch that is not tripped throws `not_tripped` (409).
 */
export function resetKillSwitch(note: string, signal?: AbortSignal): Promise<KillSwitchStatus> {
  return requestJson<KillSwitchStatus>("/api/kill-switch/reset", "POST", {
    signal,
    body: { note },
  });
}
