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
  ArchiveResponse,
  CloseResponse,
  Bot,
  BotDetail,
  CheckOpenOrdersResponse,
  CreateBotRequest,
  CreateBotResponse,
  HaltResponse,
  KillSwitchStatus,
  LiquidateResponse,
  ManualAdjustment,
  ManualAdjustmentRequest,
  ResumeResponse,
  StartResponse,
  TriggerKillSwitchResponse,
  UnarchiveResponse,
} from "./types";
import type {
  AssessResponse,
  DeriveResponse,
  ProposalListResponse,
  ProposalOutcomeFilter,
  ProposalRecordResponse,
  ProposalStage,
} from "./research-types";

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
      throw new ApiError("unauthenticated", "your session has expired, reload to sign in again", response.status);
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
 * Every registered account, its exchange, and its `capital_ledger` headroom
 * (`GET /api/accounts`). The real, authoritative list the create-bot form's
 * account dropdown reads -- so an account is chosen, never typed, and its
 * exchange comes back alongside it rather than being asked for a second time.
 *
 * ALSO the source of the bot list's AVAILABLE tiles. One endpoint rather than a
 * second capital-only one, because the account registry and the per-account
 * ledger rows are the same fact at the same grain -- (account, asset) -- and
 * splitting them would give the dashboard two lists it then had to join.
 *
 * `account.capital` is nullable: null means the LEDGER READ FAILED, not that the
 * account holds nothing. See `Account.capital`.
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
 * Halt one bot on purpose (`POST /api/bots/:id/halt`). The ONLY bot action that
 * takes a request body: `reason` is the operator's free-text explanation, stored
 * as `manual: <reason>` so a halted bot always says why it stopped. The backend
 * rejects a missing or whitespace-only reason with `missing_field` (400), so
 * callers must gate on the TRIMMED value rather than sending a request that can
 * only fail. The actor is still the verified Access identity, never sent.
 *
 * Two success actions, and they are not interchangeable: `halted` (this call
 * stopped the bot) and `already_halted` (it was stopped before this call --
 * `#halt` returned early, changed nothing, and KEPT the original reason). A
 * caller that reports every 200 as "halted by you" is lying in the second case.
 *
 * Its refusals are narrower than every other write on this page:
 *   - `invalid_status` (409) -- the bot is `stopped`, so its capital is already
 *     released and there is nothing to halt. The only status refused.
 *   - `not_created`    (404) -- the object holds no config for this id.
 * It asserts NEITHER latch, the inverse of resume: halting reduces risk and must
 * work while the kill switch is pulled or an account breaker is tripped.
 *
 * A 200 does NOT prove the exchange is clear. The status is marked halted before
 * the cancellations run, and a cancellation whose outcome cannot be confirmed
 * leaves that order open with a `cancel_failed` alert rather than being assumed
 * cancelled (section 5.6). The alerts are the evidence, not this response.
 */
export function haltBot(id: string, reason: string, signal?: AbortSignal): Promise<HaltResponse> {
  return requestJson<HaltResponse>(`/api/bots/${encodeURIComponent(id)}/halt`, "POST", {
    signal,
    body: { reason },
  });
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
 * Close a bot and return its capital to the account
 * (`POST /api/bots/:id/close`). No request body.
 *
 * The only action that releases an allocation, and it does not come back:
 * nothing moves a bot out of `stopped`. It cancels open orders but NEVER sells,
 * which is why it refuses a bot that still holds a position (`position_held`,
 * 409) -- liquidate by hand first. A second close is `bot_already_stopped`.
 */
export function closeBot(id: string, signal?: AbortSignal): Promise<CloseResponse> {
  return requestJson<CloseResponse>(`/api/bots/${encodeURIComponent(id)}/close`, "POST", { signal });
}

/**
 * Retire a finished bot AND return its capital
 * (`POST /api/bots/:id/archive`). No request body.
 *
 * ⚠ ARCHIVING NOW CLOSES. Step 26 wrote one boolean and promised the allocation
 * was untouched; step 26.1 changed that on purpose -- capital reserved for a
 * finished bot is capital no new bot can use. The bot moves to `stopped` and its
 * allocation returns to the account. `result.capitalReleased` says whether THIS
 * call did it.
 *
 * STILL NOT A DELETE, and still structurally so: the bot's own state, order and
 * trade history, alerts and audit entries are all kept, permanently, and its
 * detail page still renders. Nothing in this system can delete a bot's data --
 * the backend's storage layer has no delete method at all.
 *
 * A repeat is a SUCCESS, not an error: `result.action` is `already_archived`
 * with `capitalReleased: false`. The refusals are `invalid_status` (409) on a
 * `running` or `created` bot, and `position_held` (409) on one still carrying
 * inventory.
 */
export function archiveBot(id: string, signal?: AbortSignal): Promise<ArchiveResponse> {
  return requestJson<ArchiveResponse>(`/api/bots/${encodeURIComponent(id)}/archive`, "POST", { signal });
}

/**
 * Put an archived bot back in the default view (`POST /api/bots/:id/unarchive`).
 *
 * Refuses nothing, by design -- a gate here could only strand a bot in the
 * hidden state. It resumes nothing either: a halted bot comes back halted.
 * A repeat reports `not_archived` and is still a 200.
 */
export function unarchiveBot(id: string, signal?: AbortSignal): Promise<UnarchiveResponse> {
  return requestJson<UnarchiveResponse>(`/api/bots/${encodeURIComponent(id)}/unarchive`, "POST", { signal });
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
 * Observe this bot's resting orders right now
 * (`POST /api/bots/:id/check-open-orders`, step 22).
 *
 * The same pass the 30-second alarm runs, triggered by a person. That is the
 * point rather than a caveat: the conditions it answers -- `poll_blind` (the
 * venue has been unreadable for five consecutive passes, now retrying at the
 * five-minute floor) and `price_updates_stale` (no live price for over ten
 * minutes on a running bot) -- both mean the SCHEDULED path has stopped
 * working, and without this the operator's only move is to wait for a
 * backed-off timer.
 *
 * TWO THINGS THE CALLER MUST NOT MISSTATE:
 *   - A 200 is not a clean bill of health. `skipped` carries every order this
 *     pass could not read or could not apply; `deferred` says it stood aside
 *     for a concurrent pass and looked at nothing, which three empty arrays
 *     cannot be distinguished from.
 *   - It is not read-only. On a RUNNING GRID bot a folded buy places its paired
 *     replacement sell, exactly as a live fill would.
 *
 * Its refusals, from the bot object:
 *   - `invalid_status` (409) -- the bot is `stopped`; its capital is released.
 *     A `halted` bot is explicitly fine and is a useful case.
 *   - `not_attached`   (503) -- no exchange client could be built here.
 *   - `not_created`    (404) -- the object holds no config for this id.
 *
 * Safe to retry: applied fills deduplicate on the exchange's own ids.
 */
export function checkOpenOrders(id: string, signal?: AbortSignal): Promise<CheckOpenOrdersResponse> {
  return requestJson<CheckOpenOrdersResponse>(
    `/api/bots/${encodeURIComponent(id)}/check-open-orders`,
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
export function createBot(
  request: CreateBotRequest,
  signal?: AbortSignal,
): Promise<CreateBotResponse> {
  // `CreateBotResponse` rather than `BotDetail`: the 201 additionally carries
  // `proposalLink` when the body named a proposal, and `recorded: false` on it is
  // a real outcome the form must report (decision log 45's soft failure). Typing
  // it as a plain BotDetail would make that field invisible to every caller.
  return requestJson<CreateBotResponse>("/api/bots", "POST", { signal, body: request });
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

// ---------------------------------------------------------------------------
// Section 21.4 research pipeline -- the NAMED entry point only (spec 21.6)
// ---------------------------------------------------------------------------

/**
 * ⚠ THE TWO CALLS BELOW EACH COST A REAL, PAID WORKERS AI INFERENCE, and each
 * blocks for tens of seconds (`MEASURED_LATENCY` in `research/proposalRun.ts`
 * carries the real samples). They are the only functions in this file with that
 * property, and it is why they are grouped and labelled rather than filed
 * alphabetically among the free reads above.
 *
 * They also each write a permanent, undeletable proposal record on success
 * (migration 0009, 21.5 requirement 5). There is no dry run.
 *
 * `research-types.ts` used to state that nothing in it was fetched by the
 * dashboard. That is no longer true, and its header says so.
 */

/** Shared by both: the parameters the two endpoints take identically. */
interface ResearchQuery {
  readonly pair: string;
  readonly interval: string;
  readonly since?: number;
  readonly quoteAssets?: readonly string[];
}

/**
 * Build the query both endpoints share.
 *
 * An absent `since` or `quoteAssets` is OMITTED, never sent empty. Both
 * endpoints parse strictly -- an empty `since` is `invalid_field` and an empty
 * `quoteAssets` is not the same request as no filter at all -- so "omit or send a
 * real value" is the only correct handling, and doing it in one place means the
 * two calls cannot disagree about it.
 */
function researchParams(query: ResearchQuery): URLSearchParams {
  const params = new URLSearchParams();
  params.set("pair", query.pair);
  params.set("interval", query.interval);
  if (query.since !== undefined) params.set("since", String(query.since));
  if (query.quoteAssets !== undefined && query.quoteAssets.length > 0) {
    params.set("quoteAssets", query.quoteAssets.join(","));
  }
  return params;
}

/**
 * Stage 2 (`GET /api/accounts/:label/assess`) -- gather one named candidate and
 * ask a model which strategy fits.
 *
 * Its refusals are the ones `describeRunFailure` (`research/runErrors.ts`)
 * enumerates. Note that `missing_field`, `unexpected_field`, `duplicate_key`,
 * `strategy_not_recognised` and `citation_unknown` each arrive with TWO possible
 * meanings separated only by the status: 4xx is a bad REQUEST, 502 is the MODEL's
 * answer being unusable. A caller that branches on the code alone will report the
 * second as the first.
 */
export function fetchAssess(
  accountLabel: string,
  query: ResearchQuery,
  signal?: AbortSignal,
): Promise<AssessResponse> {
  const path = `/api/accounts/${encodeURIComponent(accountLabel)}/assess?${researchParams(query)}`;
  return requestJson<AssessResponse>(path, "GET", { signal });
}

/**
 * Stage 3 (`GET /api/accounts/:label/derive`) -- derive real parameters for an
 * assessment a PREVIOUS `/assess` call returned.
 *
 * `assessment` is the exact JSON text `encodeResubmission` produced. It goes in a
 * query parameter because the endpoint is a GET with a nested `claims` array
 * (decision log 42's transport note), and `URLSearchParams` percent-encodes it.
 *
 * ⚠ NO LENGTH GUARD EXISTS ON EITHER SIDE. Entry 42 measured a real submission at
 * ~1-2 KB (~2-3 KB encoded) and recorded that a very long claim list could
 * approach a URL cap. That limitation is unchanged by this dashboard calling the
 * endpoint instead of `curl`, and inventing a client-side cap here would be this
 * layer deciding a limit the endpoint has not stated.
 *
 * Its distinctive refusal is `citation_unknown` at 409: the resubmitted
 * assessment cited evidence THIS run's own fresh gather does not emit. That is
 * ordinary drift between two independent gathers, not a fault.
 */
export function fetchDerive(
  accountLabel: string,
  query: ResearchQuery,
  assessment: string,
  signal?: AbortSignal,
): Promise<DeriveResponse> {
  const params = researchParams(query);
  params.set("assessment", assessment);
  const path = `/api/accounts/${encodeURIComponent(accountLabel)}/derive?${params}`;
  return requestJson<DeriveResponse>(path, "GET", { signal });
}

// ---------------------------------------------------------------------------
// Spec 21.5 requirement 5 -- reading the permanent proposal record
// ---------------------------------------------------------------------------

/**
 * ⚠ THESE TWO ARE FREE, UNLIKE THE TWO ABOVE THEM. `fetchAssess` and `fetchDerive`
 * each spend a paid inference and each write a permanent row; these read rows that
 * already exist. They call no model, touch no venue, and write nothing -- the
 * backend routes are `GET` and neither can reach `proposals.outcome`, which still
 * moves off NULL in exactly two places (`POST /api/bots` and
 * `POST /api/proposals/:id/reject`).
 */

/**
 * The filters `GET /api/proposals` supports SERVER-SIDE. All optional; an omitted
 * field is not sent, so the backend returns that dimension unfiltered.
 *
 * The backend validates each value and 400s an unrecognised one (`invalid_filter`),
 * so callers send only values from the typed unions and never
 * fetch-everything-then-filter -- `fetchAlerts`' rule, and it matters more here
 * because this table has no delete path and grows by two rows per real run.
 */
export interface ProposalFilters {
  readonly accountLabel?: string;
  readonly stage?: ProposalStage;
  /** `pending` means no decision has been recorded -- 21.5's "ignored". */
  readonly outcome?: ProposalOutcomeFilter;
  readonly limit?: number;
  readonly offset?: number;
}

/**
 * A page of proposal history (`GET /api/proposals`).
 *
 * ⚠ REAL PAGINATION, NOT A CAPPED LIST. The response carries `page.total` -- the
 * count behind the filters across the whole table -- so a reader can be told "26–50
 * of 312" rather than being handed a next button and a guess. The backend REFUSES a
 * `limit` above its maximum rather than clamping it, so a caller cannot receive a
 * silently shortened page and believe it is complete; that arrives as an
 * `invalid_filter` 400.
 */
export function fetchProposals(
  filters: ProposalFilters = {},
  signal?: AbortSignal,
): Promise<ProposalListResponse> {
  const params = new URLSearchParams();
  if (filters.accountLabel !== undefined) params.set("accountLabel", filters.accountLabel);
  if (filters.stage !== undefined) params.set("stage", filters.stage);
  if (filters.outcome !== undefined) params.set("outcome", filters.outcome);
  if (filters.limit !== undefined) params.set("limit", String(filters.limit));
  if (filters.offset !== undefined) params.set("offset", String(filters.offset));
  const query = params.toString();
  return requestJson<ProposalListResponse>(
    `/api/proposals${query ? `?${query}` : ""}`,
    "GET",
    { signal },
  );
}

/**
 * One whole proposal record (`GET /api/proposals/:id`), rebuilt into the exact
 * shape the live endpoint returned.
 *
 * ⚠ IT IS A LARGE RESPONSE, and it is the only one in this file that is. A derive
 * record carries the full candle window plus the ~23 KB prompt and the raw model
 * answer -- which is why it is fetched for ONE proposal, on purpose, and why
 * `fetchProposals` exists so nothing pays that cost to browse.
 *
 * `unknown_proposal` (404) is its only refusal. Section 8.7 means no id was ever
 * deleted, so a 404 really does mean the id was never issued.
 */
export function fetchProposal(id: string, signal?: AbortSignal): Promise<ProposalRecordResponse> {
  return requestJson<ProposalRecordResponse>(
    `/api/proposals/${encodeURIComponent(id)}`,
    "GET",
    { signal },
  );
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
