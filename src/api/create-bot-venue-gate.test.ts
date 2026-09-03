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
 * BECAUSE ONE IS NOT POSSIBLE YET, AND DELIBERATELY SO. Kraken is not a venue a
 * bot can be created on:
 *
 *   - `ExchangeId` in `db/schema.ts` is `"binance" | "gemini"`, and this change
 *     does not widen it. Entry 90 step (c), the Kraken client, does not exist,
 *     so a bot created on Kraken today would reserve capital and then halt at
 *     its first trade with `not_attached` -- the exact failure this gate exists
 *     to prevent, arriving through a different door.
 *   - `POST /api/bots` with `exchange: "kraken"` is therefore refused with 400
 *     `invalid_exchange`, and `api.test.ts` already pins that behaviour.
 *   - `accounts.exchange` carries a D1 `CHECK (exchange IN ('binance','gemini'))`,
 *     so a Kraken account cannot be seeded into the test database either.
 *
 * So the gate is unreachable over HTTP, and will stay unreachable until Kraken
 * is enabled on purpose. What this file does instead is call the real exported
 * `createBot` with a real `Request`, through its real body parsing and its real
 * `resolveBotExchange`, over a database stub whose ACCOUNT ROW SAYS "kraken".
 * That is not a contrivance: `resolveBotExchange` returns a registered account's
 * stored `exchange` column WITHOUT running it through `isExchangeId`, so this is
 * genuinely the value the handler would hold the day the venue is enabled.
 *
 * ── WHAT MAKES THIS A WIRING PROOF AND NOT A FUNCTION-EXISTS PROOF ──
 *
 * The stub database implements `accounts.findOne` and NOTHING ELSE. Any request
 * that gets past the gate walks into an unimplemented property and dies with a
 * `TypeError`, not an `ApiError`. So "the gate fired" and "the gate did not
 * fire" are two different, distinguishable outcomes here, and every test below
 * asserts which one happened. A `createBot` that had the rule imported but never
 * called would fail the first test; a `createBot` that called it on binance too
 * would fail the inertness tests.
 */

import { describe, expect, it } from "vitest";
import { createBot } from "./handlers";
import { ApiError } from "./envelope";
import type { ApiContext } from "./router";
import type { Database } from "../db/database";
import { EXCHANGE_IDS, isExchangeId } from "../db/schema";
import { checkBotInstanceIdFitsVenue } from "../shared/idempotency";

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
    // generates -- must NOT be refused by the gate. It is proved to have passed
    // by the request failing at the NEXT thing `createBot` does, which is
    // `requireString(body, "pair")`, with a different code.
    const outcome = await outcomeOf(contextFor("bot-1toiyz", "kraken"));

    expect(outcome.kind).toBe("api");
    const error = (outcome as { error: ApiError }).error;
    expect(error.code).toBe("missing_field");
    expect(error.message).toContain("pair");
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
  for (const exchange of EXCHANGE_IDS) {
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
  it("does not accept kraken as an exchange a bot can be created on", () => {
    expect(isExchangeId("kraken")).toBe(false);
    expect(EXCHANGE_IDS).not.toContain("kraken");
    expect([...EXCHANGE_IDS].sort()).toEqual(["binance", "gemini"]);
  });

  it("already knows kraken's budget, so enabling the venue needs no second change", () => {
    // The gate is live now and keyed on the venue string. Widening `ExchangeId`
    // is the only thing standing between these two facts and a refused request.
    expect(checkBotInstanceIdFitsVenue("kraken", "grid-btcusd-01")).not.toBeNull();
    expect(checkBotInstanceIdFitsVenue("kraken", "bot-1toiyz")).toBeNull();
  });
});
