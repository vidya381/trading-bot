/**
 * The error -> HTTP status map, tested directly.
 *
 * WHY THIS FILE EXISTS AT ALL, given `api.test.ts` drives every endpoint end to
 * end: because some rows of `STATUS_BY_CODE` are deliberately NOT reachable over
 * HTTP, and a row nothing exercises is a row that silently rots.
 *
 * Two of the watchlist's rows are like that, and both are defensive on purpose:
 *
 *  - `not_watched` from the MODULE. `removeWatchlistEntry` resolves the id to a
 *    live row first and throws its own `ApiError(404, "not_watched")` for a
 *    non-live one, so `removeFromWatchlist`'s own `not_watched` is reachable
 *    only when a concurrent removal wins the race between those two reads. The
 *    map row is what stops that path degrading to a silent 400 the day it fires.
 *  - `requires_human_actor`. `ctx.actor` is an email verified off the Access
 *    JWT, so the module's automated-actor refusal cannot fire over HTTP today.
 *    It fires the moment anything else calls the module.
 *
 * A mutation run confirmed the gap rather than assuming it: flipping
 * `not_watched` to 400 failed NO test in `api.test.ts`. This file is the fix,
 * and it also pins the deliberate spellings -- the watchlist reusing the kill
 * switch's `requires_human_actor` rather than adding a second code for the same
 * refusal, and `tradable_set_unreadable` sitting in the 503 "dependency is down"
 * tier rather than with the 400s.
 */

import { describe, expect, it } from "vitest";
import { ApiError, errorResponse, statusForCode } from "./envelope";

/** A wrapped module's error: a real `Error` carrying a `code`. */
function coded(code: string, message = "refused"): Error {
  const error = new Error(message);
  (error as Error & { code: string }).code = code;
  return error;
}

async function statusAndCode(error: unknown): Promise<{ status: number; code: string }> {
  const response = errorResponse(error);
  const body = (await response.json()) as { error: { code: string } };
  return { status: response.status, code: body.error.code };
}

describe("STATUS_BY_CODE covers the watchlist's refusals", () => {
  it.each([
    // A well-formed request that conflicts with current state, and which the
    // identical request would satisfy once a pair is removed.
    ["cap_exceeded", 409],
    ["already_watched", 409],
    // The thing the caller named is not there to act on.
    ["not_watched", 404],
    // A bad field value the caller can fix by asking differently.
    ["pair_not_tradable", 400],
    // A dependency is down; this is a REFUSAL to write on unverifiable input,
    // not a relayed read failure (which is why it is not the symbols endpoint's
    // 502). Same tier as `not_attached` and `throttled`.
    ["tradable_set_unreadable", 503],
    // Reused from the kill switch rather than duplicated -- one spelling, one
    // row. If the watchlist ever grows its own, this assertion is where the
    // divergence shows up.
    ["requires_human_actor", 403],
  ])("maps %s to %i", async (code, status) => {
    expect(await statusAndCode(coded(code))).toEqual({ status, code });
  });

  it.each([
    // Section 21.4's candle fetch. Each reuses the status tier an existing code
    // with the same SHAPE of refusal already carries.
    //
    // The load-bearing one. `unknown_account` is thrown as a `notFound(...)`
    // ApiError by `getAccountSymbols` and `requireWatchlistAccount` -- which
    // carries its own status and never reaches this table. `fetchCandleWindow`
    // throws it as a MODULE error, so this row is the only thing standing
    // between it and the table's 400 default: the same missing account
    // answering 404 on /symbols and 400 on /candles.
    ["unknown_account", 404],
    // A bad field value the caller fixes by asking differently (`interval=1m`),
    // like `pair_not_tradable` and `invalid_parameter`.
    ["interval_not_verified", 400],
    // A read the caller asked for that the venue failed to serve -- the
    // symbols endpoint's 502 tier, NOT `tradable_set_unreadable`'s 503. That
    // one refuses to act on unverifiable input; these relay a failed read.
    ["candles_unavailable", 502],
    // The venue answered successfully and the answer was unusable, which is
    // what a bad gateway is. Not 404: tradability passed before the fetch, so
    // the pair is listed and this is not a missing resource.
    ["no_candles_returned", 502],
  ])("maps %s to %i", async (code, status) => {
    expect(await statusAndCode(coded(code))).toEqual({ status, code });
  });

  it("maps pair_not_spot_by_name to 400, and STATES it rather than inheriting it", async () => {
    // The research paths' naming heuristic (step 33). A bad field value the
    // caller fixes by naming a spot pair -- the same tier as `pair_not_tradable`
    // and, deliberately, a DIFFERENT CODE from `instrument_not_spot`: both mean
    // "not spot", but one is a field the venue published and this one is an
    // inference from a naming convention Gemini has never documented. An
    // operator reading a log must be able to tell which check spoke.
    expect(await statusAndCode(coded("pair_not_spot_by_name"))).toEqual({
      status: 400,
      code: "pair_not_spot_by_name",
    });

    // THE SECOND ASSERTION IS NOT REDUNDANT, and it exists because a mutation
    // run proved the first one is not enough: deleting the table row entirely
    // failed NO test, since the table's own default is also 400 and an absent
    // row is indistinguishable from a stated one at runtime today. Passing an
    // alien fallback is what tells them apart -- and the difference stops being
    // cosmetic the moment anything changes that default, at which point every
    // code with a row keeps its status and every code without one moves.
    expect(statusForCode("pair_not_spot_by_name", 599)).toBe(400);
    expect(statusForCode("some_future_refusal_with_no_row", 599)).toBe(599);
  });

  it("keeps the candle read failure and the unverifiable-input refusal apart", async () => {
    // The distinction is the whole reason both rows exist, and a single table
    // is exactly where it would quietly collapse into one number.
    const read = await statusAndCode(coded("candles_unavailable"));
    const refusal = await statusAndCode(coded("tradable_set_unreadable"));
    expect(read.status).toBe(502);
    expect(refusal.status).toBe(503);
    expect(read.status).not.toBe(refusal.status);
  });

  it("carries the module's own message through verbatim", async () => {
    // The codes are for the caller's code; the message is for the human reading
    // it, and the module's messages name the exact remedy (which pair, whose
    // entry, what the cap is). Flattening them would throw that away.
    const response = errorResponse(coded("cap_exceeded", "the watchlist already holds 10 entries"));
    const body = (await response.json()) as { error: { message: string } };
    expect(body.error.message).toBe("the watchlist already holds 10 entries");
  });

  it("lets a handler's own ApiError win over the map", async () => {
    // `removeWatchlistEntry` throws `ApiError(404, "not_watched")` directly for
    // an already-removed id, and that path must not be re-routed through the
    // table. Same code, chosen status, first tier of `errorResponse`.
    expect(await statusAndCode(new ApiError(404, "not_watched", "already removed"))).toEqual({
      status: 404,
      code: "not_watched",
    });
  });

  it("defaults an unlisted code to 400, not 500", async () => {
    // The table's own note: these modules throw a code precisely when they
    // refuse a request on its merits, so an unlisted one is far likelier a
    // validation refusal than an internal fault.
    expect(await statusAndCode(coded("some_future_watchlist_refusal"))).toEqual({
      status: 400,
      code: "some_future_watchlist_refusal",
    });
  });

  it("still sends an uncoded error to 500 with a generic message", async () => {
    // Nothing above widened the catch-all. An error this layer did not reason
    // about may carry text that is not safe to echo.
    expect(await statusAndCode(new Error("boom"))).toEqual({
      status: 500,
      code: "internal_error",
    });
  });
});
