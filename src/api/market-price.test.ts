/**
 * The halted-bot market price: who gets one, who does not, and what it may
 * never touch.
 *
 * A bot's `state.lastPrice` is written in ONE place, gated on
 * `status === "running"`, from its own feed subscription -- so a halted bot's
 * price is correctly frozen at the instant it halted. This feature does not
 * change that. It adds a SEPARATE, freshly-fetched spot price, shown only for a
 * halted bot, so an operator can see where the market is before deciding
 * whether to resume.
 *
 * The three properties under test are the three that make it safe:
 *   1. It is fetched for a halted bot and for NOTHING else.
 *   2. It never touches `lastPrice` or anything a PnL figure reads -- pinned
 *      STRUCTURALLY, in `market-price-isolation.test.ts`, because the property
 *      is an absence and no behavioural test can pin one.
 *   3. It always carries its own timestamp.
 */

import { beforeEach, describe, expect, it } from "vitest";

import { marketPriceFor } from "./handlers";
import { botDetail } from "./serialize";
import type { Database } from "../db/database";
import type { BotInstanceRow, BotStatus } from "../db/schema";
import { botInstanceRow, freshDatabase } from "../db/test-helpers";
import type { MarketPriceLister } from "../workers/market-price";
import { fromDecimalString as m } from "../shared/money";
import { TEST_PAIR } from "../durable-objects/fake-exchange";

const T0 = 1_930_000_000_000;
const ACCOUNT = "main";
const BOT = "dca-btc-1";

let db: Database;
/** Every (account, pair) the lister was actually asked for. */
let asked: { label: string; pair: string }[];

beforeEach(async () => {
  db = await freshDatabase();
  asked = [];
});

/** A lister that answers, and records that it was reached. */
function answeringLister(price = "68000", at = T0 + 1_500): MarketPriceLister {
  return async (account, pair) => {
    asked.push({ label: account.label, pair });
    return { ok: true, value: { pair, price: m(price), at }, at };
  };
}

/** A lister that fails, as an unreachable venue really does. */
const failingLister: MarketPriceLister = async (account, pair, _env, now) => {
  asked.push({ label: account.label, pair });
  return {
    ok: false,
    kind: "exchange_error",
    message: "venue unreachable",
    retryable: true,
    at: now(),
  };
};

async function seedBot(status: BotStatus, archived = false): Promise<BotInstanceRow> {
  const row = botInstanceRow({
    id: BOT,
    account_label: ACCOUNT,
    status,
    archived,
    pair: TEST_PAIR,
    exchange: "binance",
    halt_reason: status === "halted" ? "manual: paused" : null,
    halted_at: status === "halted" ? T0 - 60_000 : null,
  });
  await db.botInstances.insert(row);
  return row;
}

/**
 * The REAL gate, from `handlers.ts`. Not a local re-statement of
 * `archived || status !== "halted"` -- that predicate IS the safety property,
 * and a copy of it here would be a second implementation free to drift.
 */
async function fetchFor(row: BotInstanceRow, lister: MarketPriceLister) {
  return await marketPriceFor(
    { marketPriceLister: lister, env: {} as Env, now: () => T0 },
    row,
  );
}

// ===========================================================================
// 1 -- who gets one
// ===========================================================================

describe("who a market price is fetched for", () => {
  it("is populated for a halted, unarchived bot", async () => {
    const row = await seedBot("halted");

    const price = await fetchFor(row, answeringLister());

    expect(price).not.toBeNull();
    expect(asked).toEqual([{ label: ACCOUNT, pair: TEST_PAIR }]);
  });

  it("is NOT fetched for created, running, stopped, or archived bots", async () => {
    for (const status of ["created", "running", "stopped"] as const) {
      db = await freshDatabase();
      asked = [];
      const row = await seedBot(status);

      expect(await fetchFor(row, answeringLister())).toBeNull();
      // Not merely absent from the response -- the venue was never reached.
      expect(asked, `status ${status} must not reach the venue`).toEqual([]);
    }

    // Archived, and HALTED: the status alone would qualify it, and the flag is
    // what excludes it. Resume is refused for an archived bot until it is
    // explicitly unarchived, so a live price answers a question the operator
    // cannot act on yet.
    db = await freshDatabase();
    asked = [];
    const archived = await seedBot("halted", true);
    expect(await fetchFor(archived, answeringLister())).toBeNull();
    expect(asked).toEqual([]);
  });

  it("is null, not an error, when the venue cannot be reached", async () => {
    const row = await seedBot("halted");

    // The venue WAS reached and refused -- and the result is still just null.
    expect(await fetchFor(row, failingLister)).toBeNull();
    expect(asked).toHaveLength(1);
  });
});

// ===========================================================================
// 3 -- the freshness timestamp
// ===========================================================================

describe("the freshness timestamp", () => {
  it("is present and carries the fetch time, not the bot's frozen one", async () => {
    const frozenAt = T0 - 60_000;
    const fetchedAt = T0 + 1_500;
    const row = await seedBot("halted");

    const price = await fetchFor(row, answeringLister("68000", fetchedAt));

    expect(price).not.toBeNull();
    expect(price!.at).toBe(fetchedAt);
    // The whole point: it is NOT the moment the bot's own price froze.
    expect(price!.at).not.toBe(frozenAt);
  });

  it("travels with the price through the serializer, on the detail shape", async () => {
    const row = await seedBot("halted");
    const fetchedAt = T0 + 2_000;

    const detail = botDetail(row, null, [], [], [], { reported: "0.00000000", unpricedCount: 0 }, {
      price: "68000.00000000",
      at: fetchedAt,
    });

    expect(detail.marketPrice).toEqual({ price: "68000.00000000", at: fetchedAt });
    // And it did NOT become the bot's own price, which stays null for an
    // orphaned snapshot rather than borrowing the market's number.
    expect(detail.lastPrice).toBeNull();
  });

  it("defaults to null on the serializer, so an un-fetched bot renders nothing", async () => {
    const row = await seedBot("running");

    const detail = botDetail(row, null, [], [], [], { reported: "0.00000000", unpricedCount: 0 });

    expect(detail.marketPrice).toBeNull();
  });
});
