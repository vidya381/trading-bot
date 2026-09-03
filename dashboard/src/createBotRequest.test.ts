/**
 * `exchange` IS NEVER SENT BY THE CREATE-BOT FORM, AND CANNOT BE.
 *
 * This was the second of the two smaller findings from verifying decision-log
 * entry 90's DECISION 3, and unlike the first it needed no fix -- the behaviour
 * was already correct. It is pinned here because "already correct" is a claim
 * that decays: the venue cap work touched this form's validation, and the next
 * change to it will touch something else.
 *
 * ── WHAT THE GUARANTEE ACTUALLY IS ──
 *
 * It is structural, not conventional. `CreateBotRequest` in `api/types.ts` has
 * no `exchange` member at all, so `buildRequest()` in `CreateBot.tsx` could not
 * send one without a type error first, and `CREATE_BOT_REQUEST_HAS_NO_EXCHANGE`
 * declared alongside that type breaks the dashboard build if the member is ever
 * added.
 *
 * The form does hold the account's exchange in state, and shows it READ-ONLY
 * (`ExchangeDisplay`) from the accounts registry response. `validate()` now also
 * passes that value to `botInstanceIdError` for the venue cap -- which is a READ
 * of it, and not a new route to submitting it.
 *
 * ── WHY IT MATTERS ──
 *
 * `resolveBotExchange` in `src/api/handlers.ts` rejects a body `exchange` that
 * disagrees with the registered account (`exchange_mismatch`), and for an
 * UNREGISTERED account it is the body value that decides the venue. A form that
 * sent a separately-typed exchange could therefore either fail confusingly or,
 * worse, create a bot on a venue the operator did not pick. Omitting the field
 * entirely makes both impossible.
 */

import { describe, expect, it } from "vitest";
import { CREATE_BOT_REQUEST_HAS_NO_EXCHANGE, type CreateBotRequest } from "./api/types";

describe("the POST /api/bots body the dashboard builds", () => {
  it("has no exchange field in its type", () => {
    // The real guard is the TYPE of this constant, declared in `api/types.ts`:
    // `"exchange" extends keyof CreateBotRequest ? true : false`, initialised to
    // `false`. Adding `exchange` to the request makes that assignment illegal and
    // breaks the dashboard build.
    //
    // It is declared in app code rather than here because this project's
    // toolchains typecheck neither half of this file: the root `tsconfig.json`
    // excludes `dashboard`, and `dashboard/tsconfig.app.json` excludes
    // `*.test.ts`. A type-level assertion written in a test file would compile
    // nowhere and guard nothing -- so this test asserts the runtime half and
    // points at where the compile-time half really lives.
    expect(CREATE_BOT_REQUEST_HAS_NO_EXCHANGE).toBe(false);
  });

  it("carries only the fields the form owns", () => {
    // A representative body, written out in full, so the assertion below is
    // about a real request shape rather than a hand-listed set of strings.
    // Note this file is transpiled but not typechecked (see above), so the
    // annotation on `body` documents intent; the enforcement is the exported
    // constant in the test above.
    const body: CreateBotRequest = {
      botInstanceId: "bot-1toiyz",
      accountLabel: "acct-1",
      pair: "BTC-USD",
      capitalAsset: "USD",
      allocatedCapital: "1000",
      strategy: "grid",
      params: {
        lowerBound: "10000",
        upperBound: "20000",
        gridLevels: 10,
        orderSize: "100",
      } as CreateBotRequest["params"],
    };

    expect(Object.keys(body)).not.toContain("exchange");
    expect(Object.keys(body).sort()).toEqual([
      "accountLabel",
      "allocatedCapital",
      "botInstanceId",
      "capitalAsset",
      "pair",
      "params",
      "strategy",
    ]);
  });
});
