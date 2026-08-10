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
  // Section 21.3's watchlist (`/src/research/watchlist.ts`). Each of these
  // reuses the status an existing code with the same SHAPE of refusal already
  // carries, rather than picking a fresh one per endpoint:
  //
  //   cap_exceeded            409, like `duplicate_bot_instance` -- the request
  //                           is well formed and conflicts with current state;
  //                           removing a pair makes the identical request work.
  //   already_watched         409, the same conflict, and the closest analogue
  //                           in this table is literally a duplicate insert.
  //   not_watched             404, like `unknown_bot_instance` -- the thing the
  //                           caller named is not there to act on.
  //   pair_not_tradable       400. The caller sent a bad field value and can fix
  //                           it by asking differently, which is exactly what
  //                           `invalid_parameter` means one row up.
  //   tradable_set_unreadable 503, joining `not_attached` and `throttled` as the
  //                           "a dependency is down, retry later" tier. NOT 502:
  //                           this is a REFUSAL to write on unverifiable input,
  //                           not a proxied exchange error, which is why it
  //                           differs from the symbols endpoint's 502 (that one
  //                           IS relaying a failed read the caller asked for).
  //
  // `requires_human_actor` is deliberately absent: the watchlist reuses the
  // kill switch's spelling, so it is already mapped to 403 six rows above. A
  // second entry would be a second place to change.
  cap_exceeded: 409,
  already_watched: 409,
  not_watched: 404,
  pair_not_tradable: 400,
  tradable_set_unreadable: 503,
  // Section 21.4 Stage 1's candle fetch (`/src/research/candles.ts`). Same rule
  // as the watchlist rows above: reuse the status an existing code with the same
  // SHAPE of refusal already carries.
  //
  //   unknown_account       404, like `unknown_bot_instance` and `not_watched`
  //                         -- the thing the caller named is not there. THIS ROW
  //                         IS LOAD-BEARING IN A WAY THE OTHERS ARE NOT: the
  //                         same code is thrown elsewhere in this surface as a
  //                         `notFound(...)` ApiError, which carries its own
  //                         status and never consults this table. `fetchCandleWindow`
  //                         throws it as a MODULE error instead, so without this
  //                         row it would take the table's 400 default -- a
  //                         missing account reported as a bad request, and the
  //                         same URL answering 404 or 400 depending on which
  //                         handler happened to look the account up.
  //   interval_not_verified 400, like `pair_not_tradable` and `invalid_parameter`
  //                         -- a bad field value the caller fixes by asking
  //                         differently (`interval=1m`).
  //   candles_unavailable   502, and deliberately NOT the 503 that
  //                         `tradable_set_unreadable` takes two rows up. That
  //                         one is a refusal to act on input this system could
  //                         not verify; this one is a READ THE CALLER ASKED FOR
  //                         that the venue failed to serve, which is precisely
  //                         what the symbols endpoint already relays as a 502
  //                         (`exchange_unavailable`). Same tier, same meaning.
  //   no_candles_returned   502, with `candles_unavailable`. The venue answered
  //                         successfully and the answer was unusable, which is
  //                         what a bad gateway IS. Not 404: the pair is listed
  //                         -- tradability passed before the fetch ran -- so
  //                         this is not a missing resource, and reporting it as
  //                         one would tell the caller to stop asking about a
  //                         pair the venue says it trades.
  unknown_account: 404,
  interval_not_verified: 400,
  candles_unavailable: 502,
  no_candles_returned: 502,
  // Bot creation's tradability gate (`/src/research/tradability.ts`, wired in
  // `createBot`). `pair_not_tradable` and `tradable_set_unreadable` are NOT
  // repeated here -- the watchlist rows above already map them, and bot creation
  // reuses the same `checkTradable` and therefore the same two codes. That reuse
  // is the point: one refusal, one status, one place to change it.
  //
  //   instrument_not_spot      400, with `pair_not_tradable`. The caller sent a
  //                            field value this system will not act on and can
  //                            fix by asking differently (name a spot pair).
  //   instrument_type_unknown  502. The venue answered SUCCESSFULLY and the
  //                            answer was unusable, which is what a bad gateway
  //                            is -- the same reasoning `no_candles_returned`
  //                            carries one row up. Deliberately not 400: there
  //                            is nothing the caller can rephrase, because the
  //                            problem is the venue's payload, not their input.
  //   instrument_unreadable    503, joining `tradable_set_unreadable`,
  //                            `not_attached` and `throttled` in the "a
  //                            dependency is down, retry later" tier. Same
  //                            shape as its tradability twin: a REFUSAL to
  //                            create on input that could not be verified, not
  //                            a proxied read the caller asked for.
  instrument_not_spot: 400,
  instrument_type_unknown: 502,
  instrument_unreadable: 503,
};

/**
 * The status a coded module refusal maps to, for a handler that must build the
 * `ApiError` itself rather than throwing the module's own error class.
 *
 * `createBot` needs this: the tradability and instrument checks return REFUSAL
 * VALUES rather than throwing (see `tradability.ts` on why), so there is no
 * coded error for `errorResponse` to catch and the handler has to construct
 * one. Reading the status from this table rather than writing `400` at the call
 * site keeps this file's opening claim true -- that it is "the single place an
 * error becomes an HTTP status" -- instead of quietly becoming one of two.
 */
export function statusForCode(code: string, fallback = 400): number {
  return STATUS_BY_CODE[code] ?? fallback;
}

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
