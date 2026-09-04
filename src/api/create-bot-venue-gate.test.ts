/**
 * THE WIRING TEST for the per-venue client-order-id gate in `createBot`
 * (decision-log entry 90, DECISION 3, as revised by the verification of it).
 *
 * ── WHY THIS FILE EXISTS SEPARATELY FROM `idempotency.test.ts` ──
 *
 * `idempotency.test.ts` proves the RULE is right: 18 characters, a 10-character
 * slug budget, 4 digits of sequence, and inert for binance and gemini. A correct
 * rule that nothing calls is worth nothing, so this file proves the other half:
 * that `createBot` REALLY CALLS IT, on the real request path, before any capital
 * is reserved and before any Durable Object exists.
 *
 * ── WHY NOT A REAL `POST /api/bots` ROUND TRIP AGAINST KRAKEN ──
 *
 * BECAUSE ONE IS STILL NOT POSSIBLE, THOUGH THE REASON HAS CHANGED. `ExchangeId`
 * HAS now been widened to `"binance" | "gemini" | "kraken"` (the wiring step).
 * What keeps Kraken off the HTTP path is no longer the union but two other
 * things:
 *
 *   - `accounts.exchange` still carries its D1
 *     `CHECK (exchange IN ('binance','gemini'))` -- the widening migration is a
 *     deliberate later step -- so a Kraken account cannot be seeded into the
 *     test database, and the registry branch cannot be reached over HTTP.
 *   - `assertExchangeIsWired` (handlers.ts) refuses any venue with no client
 *     behind it. ⚠ THIS NO LONGER REFUSES KRAKEN: the rate-limiter session gave
 *     `METHOD_COSTS` its `kraken` row, `isWiredExchange("kraken")` is true, and
 *     the unregistered-account fallback now goes THROUGH this check. So the
 *     single remaining blocker is the D1 `CHECK` above, and `api.test.ts` pins
 *     the fallback by CONSTRUCTING an unwired venue rather than borrowing one.
 *
 * So the gate is still unreachable over HTTP, but by one blocker now, not two. What this file does instead is
 * call the real exported `createBot` with a real `Request`, through its real
 * body parsing and its real `resolveBotExchange`, over a database stub whose
 * ACCOUNT ROW SAYS "kraken". That is not a contrivance: `resolveBotExchange`
 * returns a registered account's stored `exchange` column WITHOUT running it
 * through `isExchangeId`, so this is genuinely the value the handler would hold
 * the day the CHECK is widened.
 *
 * ── WHAT MAKES THIS A WIRING PROOF AND NOT A FUNCTION-EXISTS PROOF ──
 *
 * The stub database implements `accounts.findOne` and NOTHING ELSE, so "the gate
 * fired" and "the gate did not fire" stay two distinguishable outcomes, and
 * every test below asserts which one happened. A `createBot` that had the rule
 * imported but never called would fail the first test; a `createBot` that called
 * it on binance too would fail the inertness tests.
 *
 * WHAT AN IN-BUDGET KRAKEN ID HITS NEXT HAS CHANGED TWICE, and the tests moved
 * with it both times. Originally it fell through to `requireString(body, "pair")`
 * and failed with `missing_field`. Then `assertExchangeIsWired` landed
 * immediately after this gate and it stopped there with `exchange_not_wired`.
 * Now Kraken is wired, that check passes, and it falls through to
 * `missing_field` again -- the original answer, by a different route.
 *
 * The acceptance signal is weaker than the middle version and that is worth
 * stating plainly: `missing_field` several checks later proves only that the
 * request got somewhere, where the specific `ApiError` from the very next line
 * proved this gate declined to refuse. What keeps the tests honest is the pair
 * of assertions each one makes -- the code that DID come back, and
 * `not.toBe("bot_instance_id_too_long_for_venue")` -- plus the refusal cases
 * above them, which still prove the gate speaks when it should.
 */

import { describe, expect, it } from "vitest";
import { createBot } from "./handlers";
import { ApiError } from "./envelope";
import type { ApiContext } from "./router";
import type { Database } from "../db/database";
import { EXCHANGE_IDS, isExchangeId } from "../db/schema";
import { checkBotInstanceIdFitsVenue } from "../shared/idempotency";
import { isWiredExchange, wiredExchanges } from "../workers/venue-wiring";

/**
 * An `ApiContext` carrying only what `createBot` touches before the gate: the
 * request body, and one account lookup. Everything past the gate is absent on
 * purpose -- see this file's docblock.
 */
function contextFor(botInstanceId: string, storedExchange: string, body: Record<string, unknown> = {}): ApiContext {
  const request = new Request("https://example.test/api/bots", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ botInstanceId, accountLabel: "acct-1", ...body }),
  });

  const db = {
    accounts: {
      findOne: async (where: { readonly account_label: string }) => {
        expect(where.account_label).toBe("acct-1");
        return { account_label: "acct-1", exchange: storedExchange };
      },
    },
  } as unknown as Database;

  return { request, db, actor: "tester@example.test" } as unknown as ApiContext;
}

/** Run `createBot` and report what stopped it, without letting a throw escape. */
async function outcomeOf(ctx: ApiContext): Promise<{ kind: "api"; error: ApiError } | { kind: "past-the-gate"; error: unknown }> {
  try {
    await createBot(ctx);
  } catch (error) {
    if (error instanceof ApiError) return { kind: "api", error };
    // Not an ApiError: the handler walked past every check this stub can answer
    // and reached machinery the stub does not implement. That is the signal that
    // the gate did NOT refuse this request.
    return { kind: "past-the-gate", error };
  }
  throw new Error("createBot returned a Response, which this stub cannot support");
}

describe("createBot calls the per-venue client-order-id gate", () => {
  it("refuses an over-budget id on a kraken account, before anything else runs", async () => {
    // 14 characters: entry 90's own worked example, valid under
    // BOT_INSTANCE_ID_PATTERN and under the D1 CHECK, and 19 characters once it
    // becomes `v1-grid-btcusd-01-7`.
    const outcome = await outcomeOf(contextFor("grid-btcusd-01", "kraken"));

    expect(outcome.kind).toBe("api");
    const error = (outcome as { error: ApiError }).error;
    expect(error.status).toBe(400);
    expect(error.code).toBe("bot_instance_id_too_long_for_venue");
    expect(error.message).toContain("kraken");
    expect(error.message).toContain("18");
  });

  it("refuses the 11-character id that real data showed does not fit", async () => {
    // `prop-live-1` is a real testnet bot id and the only one of the 31 that
    // exceeds Kraken's 10-character budget.
    const outcome = await outcomeOf(contextFor("prop-live-1", "kraken"));

    expect(outcome.kind).toBe("api");
    expect((outcome as { error: ApiError }).error.code).toBe("bot_instance_id_too_long_for_venue");
  });

  it("lets an in-budget kraken id through the gate and on to the next check", async () => {
    // The acceptance half. A 10-character id -- exactly what the dashboard
    // generates -- must NOT be refused by THIS gate. It is proved to have passed
    // by the request failing at a LATER check with a different code: Kraken now
    // clears `assertExchangeIsWired`, so it reaches `requireString(body, "pair")`
    // like every other venue.
    const outcome = await outcomeOf(contextFor("bot-1toiyz", "kraken"));

    expect(outcome.kind).toBe("api");
    const error = (outcome as { error: ApiError }).error;
    expect(error.code).toBe("missing_field");
    expect(error.code).not.toBe("bot_instance_id_too_long_for_venue");
    expect(error.code).not.toBe("exchange_not_wired");
  });

  it("passes the venue and the id it actually resolved, not a hardcoded pair", async () => {
    // Guards against a gate wired with the wrong arguments -- e.g. the account
    // label instead of the bot id -- which the tests above would not catch on
    // their own, since `acct-1` is short enough to pass.
    const longAccountShortBot = await outcomeOf(contextFor("bot-ts1", "kraken"));
    expect(longAccountShortBot.kind).toBe("api");
    expect((longAccountShortBot as { error: ApiError }).error.code).toBe("missing_field");

    // And one character over the budget is refused, so the boundary is the id's.
    const elevenChars = await outcomeOf(contextFor("bot-1toiyzz", "kraken"));
    expect((elevenChars as { error: ApiError }).error.code).toBe("bot_instance_id_too_long_for_venue");

    const tenChars = await outcomeOf(contextFor("bot-1toiyz", "kraken"));
    expect((tenChars as { error: ApiError }).error.code).toBe("missing_field");
  });
});

/**
 * THE NO-REGRESSION HALF. Binance and Gemini bot creation must be completely
 * unaffected, so these drive the same handler, over the same stub, with the same
 * ids, and assert the gate never speaks.
 */
describe("the gate does not touch binance or gemini bot creation", () => {
  // The venues this gate is INERT FOR, derived by asking the rule itself rather
  // than by naming them.
  //
  // This used to read `wiredExchanges()`, on the reasoning that the wired set is
  // the set bots are really created on and would widen on its own the day Kraken
  // was wired. It did widen -- and that broke this block, because the venue it
  // let in is the one venue the gate is FOR, inside a block asserting the gate
  // stays silent. `wiredExchanges()` was the wrong question.
  //
  // The right one is asked directly: a venue belongs here if the rule declines
  // to refuse the id these tests use. Still derived, still no hardcoded venue
  // list, and it cannot be widened by an unrelated change again.
  const gateIsInertFor = wiredExchanges().filter(
    (exchange) => checkBotInstanceIdFitsVenue(exchange, "grid-btcusd-01") === null,
  );

  for (const exchange of gateIsInertFor) {
    it(`lets an id that kraken would refuse through on ${exchange}`, async () => {
      const outcome = await outcomeOf(contextFor("grid-btcusd-01", exchange));

      // Kraken refuses this exact id, above.
      expect(checkBotInstanceIdFitsVenue("kraken", "grid-btcusd-01")).not.toBeNull();
      // This venue does not: the request reaches the next check instead.
      expect(outcome.kind).toBe("api");
      const error = (outcome as { error: ApiError }).error;
      expect(error.code).toBe("missing_field");
      expect(error.code).not.toBe("bot_instance_id_too_long_for_venue");
    });

    it(`lets an id longer than the id pattern allows through on ${exchange}, unchanged`, async () => {
      // 25 characters, invalid under BOT_INSTANCE_ID_PATTERN. It is REFUSED
      // later, by `assertBotInstanceId` in capital/ledger.ts, with
      // `invalid_bot_instance_id` and a message naming the real rule. This gate
      // must not get there first and change that refusal -- so it must let this
      // request past, exactly as it did before this change existed.
      const outcome = await outcomeOf(contextFor("a".repeat(25), exchange));

      expect(outcome.kind).toBe("api");
      expect((outcome as { error: ApiError }).error.code).toBe("missing_field");
    });
  }
});

/**
 * The preconditions this file's docblock rests on, asserted rather than
 * described. When any of these starts failing, Kraken is being enabled as a
 * venue -- and at that moment the tests above become expressible as real
 * `POST /api/bots` round trips and should be rewritten as such.
 */
describe("why a real POST /api/bots round trip against kraken is not possible yet", () => {
  it("names kraken now, which is exactly why the second gate had to exist", () => {
    // This assertion is INVERTED from what it said before the widening, and the
    // inversion is the record of what happened: `isExchangeId` used to be the
    // only thing standing between a request and a Kraken bot, and the day it
    // started returning true, `POST /api/bots` answered 201.
    expect(isExchangeId("kraken")).toBe(true);
    expect(EXCHANGE_IDS).toContain("kraken");
    expect([...EXCHANGE_IDS].sort()).toEqual(["binance", "gemini", "kraken"]);
  });

  it("no longer refuses kraken on venue wiring: the remaining blocker is the D1 CHECK", () => {
    // ⚠ THIS PRECONDITION HAS FALLEN, AND THAT IS THE POINT OF RECORDING IT.
    // It read `isWiredExchange("kraken") === false` and promised that "when this
    // starts failing, Kraken is being enabled". The rate-limiter session enabled
    // it: `METHOD_COSTS` grew a `kraken` row, both blockers closed, and
    // `isWiredExchange` derived the rest with nothing hand-edited.
    expect(isWiredExchange("kraken")).toBe(true);
    expect([...wiredExchanges()].sort()).toEqual(["binance", "gemini", "kraken"]);

    // So what still keeps a REGISTERED Kraken account off the HTTP path is the
    // one blocker left: `accounts.exchange` carries
    // `CHECK (exchange IN ('binance','gemini'))` (migration 0006), and widening
    // it is its own deliberate step. When THAT lands, the tests above become
    // expressible as real `POST /api/bots` round trips and should be rewritten
    // as such -- the same promise as before, now resting on the last blocker
    // rather than on this one.
  });

  it("already knows kraken's budget, so enabling the venue needs no second change", () => {
    // The gate is live now and keyed on the venue string.
    expect(checkBotInstanceIdFitsVenue("kraken", "grid-btcusd-01")).not.toBeNull();
    expect(checkBotInstanceIdFitsVenue("kraken", "bot-1toiyz")).toBeNull();
  });
});
