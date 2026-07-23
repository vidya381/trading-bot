/**
 * The one JSON envelope every dashboard endpoint answers in, build step 10
 * (backend API layer).
 *
 * The brief fixes the shape: `{ data, error: null }` on success. This file is
 * that, its failure mirror `{ data: null, error: { code, message } }`, and the
 * single place an error becomes an HTTP status. Keeping the mapping here rather
 * than in each handler means every endpoint fails the same way, and a handler
 * only has to `throw` -- it never builds a Response for the error path.
 *
 * WHY A TYPED CODE AND NOT JUST A MESSAGE
 * ---------------------------------------
 * The modules this layer wraps already speak in typed error codes
 * (`CapitalError.code`, `BotInstanceError.code`, `CircuitBreakerError.code`,
 * `GlobalKillSwitchError.code`, the strategy validators). The frontend needs to
 * branch on those -- "insufficient_capital" is a form error to show inline,
 * "globally_tripped" is a banner -- so the code is carried through verbatim
 * rather than flattened into prose. The message is for a human; the code is for
 * the code.
 */

/** The success half. `error` is always literally `null`, per the brief. */
export interface ApiSuccess<T> {
  readonly data: T;
  readonly error: null;
}

/** The failure half. `data` is always `null` so the shape is symmetric. */
export interface ApiFailure {
  readonly data: null;
  readonly error: {
    readonly code: string;
    readonly message: string;
  };
}

export type ApiEnvelope<T> = ApiSuccess<T> | ApiFailure;

/**
 * An error a handler throws to fail a request with a chosen status and code.
 *
 * Handlers throw this directly for their own refusals (a bad body, an unknown
 * bot). Errors from the wrapped modules are translated into one of these by
 * `errorResponse` below, so the envelope never has to know their classes.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

/** A 400 for a malformed or invalid request body. */
export function badRequest(code: string, message: string): ApiError {
  return new ApiError(400, code, message);
}

/** A 404 for a resource that does not exist. */
export function notFound(code: string, message: string): ApiError {
  return new ApiError(404, code, message);
}

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" } as const;

/** A success envelope as a `Response`. Defaults to 200; 201 for a creation. */
export function ok<T>(data: T, status = 200): Response {
  const body: ApiSuccess<T> = { data, error: null };
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

/** A failure envelope as a `Response`. */
export function fail(status: number, code: string, message: string): Response {
  const body: ApiFailure = { data: null, error: { code, message } };
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

/**
 * The `audit_log.action` codes on the errors the wrapped modules throw, mapped
 * to the HTTP status each deserves.
 *
 * A refusal the caller could fix by asking differently is a 4xx; a leaked
 * reservation or a rollback failure is a 5xx, because nothing the caller does
 * changes it. The default for a coded error we did not enumerate is 400, not
 * 500: these modules throw a code precisely when they refuse a request on its
 * merits, so an unlisted one is far more likely a validation refusal than an
 * internal fault. Genuinely unexpected errors do not carry a `.code` at all and
 * fall through to the 500 path in `errorResponse`.
 */
const STATUS_BY_CODE: Readonly<Record<string, number>> = {
  // Capital (section 8.5).
  insufficient_capital: 400,
  invalid_capital_amount: 400,
  invalid_bot_instance_id: 400,
  no_ledger_row: 400,
  duplicate_bot_instance: 409,
  unknown_bot_instance: 404,
  bot_already_stopped: 409,
  allocation_conflict: 409,
  release_exceeds_allocated: 500,
  reservation_leaked: 500,
  placeholder_requires_human_actor: 403,
  placeholder_requires_note: 400,
  // BotInstance lifecycle (sections 6, 7).
  not_created: 404,
  already_created: 409,
  invalid_status: 409,
  not_attached: 503,
  throttled: 503,
  orphaned_bot_row: 409,
  // Account circuit breaker (section 7.3).
  account_tripped: 409,
  reset_requires_human_actor: 403,
  reset_requires_note: 400,
  not_tripped: 409,
  // Global kill switch (section 7.4).
  globally_tripped: 409,
  requires_human_actor: 403,
  requires_reason: 400,
  // Strategy validation (sections 6.2, 6.3).
  invalid_parameter: 400,
};

interface CodedError {
  readonly code: string;
  readonly message: string;
}

function isCodedError(error: unknown): error is CodedError {
  if (!(error instanceof Error)) return false;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && code !== "";
}

/**
 * Translate any thrown value into a failure `Response`.
 *
 * Three tiers: an `ApiError` carries its own status; a wrapped module's coded
 * error is looked up in `STATUS_BY_CODE` (defaulting to 400, see the table's
 * note); anything else is a 500 with a generic message, because an error with
 * no code is not one this layer reasoned about and its text may not be safe to
 * echo. The real error is still logged for the operator.
 */
export function errorResponse(error: unknown): Response {
  if (error instanceof ApiError) {
    return fail(error.status, error.code, error.message);
  }
  if (isCodedError(error)) {
    const status = STATUS_BY_CODE[error.code] ?? 400;
    return fail(status, error.code, error.message);
  }
  console.error("unhandled API error", error);
  return fail(500, "internal_error", "an unexpected error occurred");
}
