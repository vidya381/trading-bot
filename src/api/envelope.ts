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
  //   pair_not_spot_by_name   400, with `pair_not_tradable`, and for the same
  //                           reason: a field value this system will not act on
  //                           that the caller can fix by naming a spot pair.
  //                           Deliberately a SEPARATE code from
  //                           `instrument_not_spot` further down even though
  //                           both mean "not spot", because the EVIDENCE
  //                           differs -- that one is a field the venue
  //                           published, this one is an inference from a naming
  //                           convention the venue never documented. Collapsing
  //                           them would make an operator reading a log unable
  //                           to tell which check spoke, and would let a change
  //                           to either one hide inside the other's row.
  pair_not_tradable: 400,
  tradable_set_unreadable: 503,
  pair_not_spot_by_name: 400,
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
  // Section 21.4 Stage 1's assembly endpoint (`/src/research/gather.ts`).
  //
  //   no_trending_vendor    503, joining `tradable_set_unreadable`,
  //                         `not_attached` and `instrument_unreadable` in the
  //                         "a dependency this system needs is not there" tier.
  //                         It is raised as an `ApiError` by `getAccountGather`
  //                         and therefore carries its own status without
  //                         consulting this table -- the row exists so the code
  //                         has ONE documented status if anything else ever
  //                         throws it, rather than silently taking the 400
  //                         default. Deliberately NOT 501: the endpoint is
  //                         implemented and two of its three doors work.
  //   trending_unavailable  503, and UNREACHABLE OVER HTTP TODAY -- the general
  //                         door refuses before `selectGeneralCandidates` is
  //                         ever called, so nothing can produce this code
  //                         through the API. The row is here for the same
  //                         reason `requires_human_actor`'s is: the module
  //                         still throws it, and when a vendor is finally wired
  //                         this must not quietly become a 400. A failed
  //                         trending pull is a dependency being down, which is
  //                         the tier above, not a caller's bad request.
  no_trending_vendor: 503,

  // Section 21.4 Stage 2 (Assess, /src/research/assess.ts + /src/workers/assess.ts).
  //
  //   no_price_history  503, joining `tradable_set_unreadable` and
  //                     `no_trending_vendor`. The request is well formed and the
  //                     system cannot serve it right now because an UPSTREAM
  //                     input is missing -- `assessCandidate` refuses to ask a
  //                     model to judge volatility with no prices, since the only
  //                     place such an answer could come from is the training
  //                     knowledge 21.5 requirement 1 forbids. Retrying later,
  //                     when the venue answers, is the right response, which is
  //                     what 503 tells a caller and 400 would not.
  //
  //   no_ai_binding     503, with `no_trending_vendor` for the same reason and
  //                     almost the same sentence: the environment has no vendor
  //                     configured, NO CALL WAS ATTEMPTED, and retrying without
  //                     changing the deployment cannot help.
  //
  // AssessParseError's twenty codes are deliberately NOT listed here. They share
  // one status (502, the model answered and its answer was unusable -- exactly
  // `candles_unavailable`'s distinction one stage earlier) and `getAccountAssess`
  // maps the class in one place, keeping each real code on the wire. Twenty
  // near-identical rows would be a second vocabulary to keep in step.
  no_price_history: 503,
  no_ai_binding: 503,
  trending_unavailable: 503,

  // Section 21.4 Stage 3 (Derive, /src/research/derive.ts). `no_price_history`
  // and `no_ai_binding` are NOT repeated -- Stage 3 throws the same two spellings
  // for the same two reasons, and one code must have one status.
  //
  //   capital_unreadable        503, with `no_price_history`. The request is well
  //                             formed and an UPSTREAM read failed, so the real
  //                             headroom is unknown. `deriveParameters` refuses
  //                             rather than proposing an allocation figure
  //                             anyway (section 5.6: a failed read is never
  //                             data). Retrying when D1 answers is the right
  //                             response, which is what 503 says and 400 does not.
  //   symbol_filters_unreadable 503, for the same reason one row up: the venue's
  //                             minimum order size could not be read, so the one
  //                             check 21.5 requirement 3 names that nothing else
  //                             in this system performs before an order is placed
  //                             cannot run at all.
  //   no_capital_headroom       409, and deliberately NOT 503. THE READ
  //                             SUCCEEDED. The account genuinely has no asset
  //                             with a positive balance minus allocation, so
  //                             there is no allocation any proposal could suggest
  //                             that could become a bot. That is a well-formed
  //                             request conflicting with current state --
  //                             `duplicate_bot_instance`'s and `cap_exceeded`'s
  //                             shape -- and it is fixed by funding the account
  //                             or stopping a bot, never by retrying. Reporting
  //                             it as 503 would send an operator to look for an
  //                             outage that is not happening.
  capital_unreadable: 503,
  symbol_filters_unreadable: 503,
  no_capital_headroom: 409,

  // Section 21.5 requirement 5's proposal record (`/src/research/proposal-log.ts`,
  // migration 0009). Same rule as every block above: reuse the status an existing
  // code with the same SHAPE of refusal already carries.
  //
  //   unknown_proposal          404, like `unknown_bot_instance` and
  //                             `not_watched` -- the thing the caller named is not
  //                             there to act on. Section 8.7 means it was never
  //                             deleted either, so a 404 here really does mean the
  //                             id was never issued.
  //   proposal_already_resolved 409, with `already_watched` and
  //                             `duplicate_bot_instance`: a well-formed request
  //                             conflicting with CURRENT state. Nothing overwrites
  //                             a recorded human decision, so it is not fixable by
  //                             rephrasing -- which is exactly what 409 says.
  //   proposal_not_derivable    400, with `pair_not_tradable` and
  //                             `invalid_parameter`: the caller named the wrong
  //                             KIND of record and fixes it by naming the derive
  //                             proposal instead. Deliberately not 409 -- nothing
  //                             about current state is in conflict; an assessment
  //                             will never become approvable however long you wait.
  //   proposal_account_mismatch 400, for the same reason: a field value this
  //                             system will not act on, fixed by naming the right
  //                             proposal or the right account.
  //   no_fetch_time             500, and it is the ONE row here that is not a
  //                             caller's fault. It is unreachable through the
  //                             pipeline -- both stages refuse with
  //                             `no_price_history` before the model call -- so
  //                             reaching it means a precondition was removed,
  //                             which is an internal fault and not something a
  //                             caller can rephrase. It must NOT take the table's
  //                             400 default and read as a bad request.
  unknown_proposal: 404,
  proposal_already_resolved: 409,
  proposal_not_derivable: 400,
  proposal_account_mismatch: 400,
  no_fetch_time: 500,

  // ── `citation_unknown` IS DELIBERATELY ABSENT FROM THIS TABLE ──
  //
  // It is the one code in this system carried by THREE different error classes
  // whose correct statuses genuinely differ, so there is no single row that is
  // right:
  //
  //   AssessParseError.citation_unknown     502 -- the Assess MODEL invented an
  //                                         id. The vendor answered and its
  //                                         answer was unusable.
  //   DeriveParseError.citation_unknown     502 -- the Derive MODEL did.
  //   AssessResubmitError.citation_unknown  409 -- the CALLER resubmitted a
  //                                         Stage 2 result whose citation no
  //                                         longer resolves against the evidence
  //                                         this request just gathered (the
  //                                         window shrank, the candle fetch
  //                                         failed, a concentration flag
  //                                         cleared). Well formed, conflicting
  //                                         with CURRENT state, exactly like
  //                                         `already_watched` -- fixed by
  //                                         running /assess again, never by
  //                                         rephrasing, and never the vendor's
  //                                         fault.
  //
  // All three handlers therefore raise an `ApiError` carrying the status
  // explicitly, which never consults this table. A row here would silently make
  // one of the three wrong, and the wrong one would be whichever handler someone
  // later simplified into a bare `throw`.
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
