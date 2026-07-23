/**
 * The global kill switch, end to end across multiple accounts (spec section
 * 7.4), build step 10.3.
 *
 * Real Durable Object storage and real D1 in the Workers runtime, per section
 * 14, and the REAL halt path -- the sweep reaches each bot's own object over RPC
 * and drives its section 7.2 halt. This is the test the module's own
 * (`../reconciliation/kill-switch.test.ts`, injected port) cannot be: that a
 * single pull actually halts bots on DIFFERENT accounts, not just one, and that
 * every account is then blocked from creating or resuming until a human resets.
 *
 * It goes through the worker wrapper `tripGlobalKillSwitchFromEnv`, so the
 * binding-to-namespace wiring the future dashboard button depends on is
 * exercised too.
 */

import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { seedPlaceholderTotalBalance } from "../capital";
import type { Database } from "../db/database";
import { freshDatabase } from "../db/test-helpers";
import { fromDecimalString as m } from "../shared/money";
import type { DcaParams } from "../strategies/dca";
import type { GridParams } from "../strategies/grid";
import {
  resetGlobalKillSwitchFromEnv,
  tripGlobalKillSwitchFromEnv,
} from "../workers/kill-switch";
import { isGloballyTripped } from "../reconciliation/kill-switch";
import type { BotInstance } from "./bot-instance";
import { FakeExchange, TEST_PAIR } from "./fake-exchange";
import { inBot, rateLimiterStub } from "./test-helpers";

const T0 = 1_760_000_000_000;
const HUMAN = "owner@example.com";

let db: Database;
let exchange: FakeExchange;
let clock: number;
let idCounter: number;
let suffix: number;
let counter = 0;

const dcaParams: DcaParams = {
  baseOrderSize: m("100"),
  additionalOrderSize: m("100"),
  stepMultiplier: m("1.5"),
  dropPct: m("5"),
  maxAdditionalBuys: 2,
  takeProfitPct: m("2"),
  stopLossPct: m("20"),
  autoRestart: false,
  sellOnStopLoss: false,
};

const gridParams: GridParams = {
  upperBound: m("110"),
  lowerBound: m("90"),
  gridLines: 5,
  spacing: "arithmetic",
  orderSize: m("100"),
  stopLossPct: m("10"),
  breakoutTakeProfit: true,
  breakoutThresholdPct: null,
  takeProfitAmount: null,
};

/**
 * Run inside the bot whose Durable Object name IS its botInstanceId, so the
 * kill switch's `namespace.idFromName(botInstanceId)` reaches this same object.
 */
async function inBotId<T>(id: string, body: (bot: BotInstance) => Promise<T>): Promise<T> {
  return await inBot(id, async (instance) => {
    instance.attach({
      db,
      exchange,
      now: () => clock,
      newId: () => {
        idCounter += 1;
        return `generated-${idCounter}`;
      },
      limiterFor: () => rateLimiterStub(`limiter-${id}`),
      sleep: async () => undefined,
    });
    return await body(instance);
  });
}

/** Seed a fresh account and create+start a bot on it. No orders are placed. */
async function startBot(id: string, account: string, strategy: "dca" | "grid"): Promise<void> {
  await seedPlaceholderTotalBalance(
    db,
    { accountLabel: account, asset: "USDT", totalBalance: m("10000"), note: "test fixture" },
    { actor: HUMAN, now: T0 },
  );
  const base = {
    botInstanceId: id,
    accountLabel: account,
    exchange: "binance" as const,
    pair: TEST_PAIR,
    capitalAsset: "USDT" as const,
    allocatedCapital: m("500"),
    actor: HUMAN,
  };
  if (strategy === "dca") {
    await inBotId(id, (bot) => bot.create({ ...base, params: dcaParams }));
  } else {
    await inBotId(id, (bot) => bot.createGrid({ ...base, params: gridParams }));
  }
  await inBotId(id, (bot) => bot.start(HUMAN));
}

beforeEach(async () => {
  db = await freshDatabase();
  exchange = new FakeExchange();
  clock = T0;
  idCounter = 0;
  counter += 1;
  suffix = counter;
});

describe("a single pull halts bots across every account", () => {
  it("halts real DCA and grid bots on two different accounts and latches", async () => {
    const a1 = `gks-a-dca-${suffix}`;
    const a2 = `gks-a-grid-${suffix}`;
    const b1 = `gks-b-dca-${suffix}`;
    await startBot(a1, `acct-a-${suffix}`, "dca");
    await startBot(a2, `acct-a-${suffix}`, "grid");
    await startBot(b1, `acct-b-${suffix}`, "dca");

    const outcome = await tripGlobalKillSwitchFromEnv(
      env,
      { reason: "genuine emergency, halt everything", actor: HUMAN },
      { now: () => clock, newId: () => `ks-${(idCounter += 1)}` },
    );
    expect(outcome.ran).toBe(true);
    if (!outcome.ran) throw new Error("unreachable");
    expect(outcome.result.haltedBotIds.slice().sort()).toEqual([a1, a2, b1].sort());

    // Every bot, on BOTH accounts, is really halted -- in D1 and in its own
    // Durable Object state.
    for (const id of [a1, a2, b1]) {
      const row = await db.botInstances.findOne({ id });
      expect(row!.status).toBe("halted");
      const snapshot = await inBotId(id, (bot) => bot.snapshot());
      expect(snapshot.state.status).toBe("halted");
    }

    expect(await isGloballyTripped(db)).toBe(true);
  });

  it("blocks creating or resuming a bot on ANY account until reset", async () => {
    const a1 = `gks2-a-${suffix}`;
    await startBot(a1, `acct-a-${suffix}`, "dca");
    await tripGlobalKillSwitchFromEnv(env, { reason: "down", actor: HUMAN }, { now: () => clock });

    // Resume of the halted bot is blocked.
    await expect(inBotId(a1, (bot) => bot.resume(HUMAN))).rejects.toMatchObject({
      code: "globally_tripped",
    });

    // Creating a bot on a DIFFERENT, untouched account is blocked too -- the
    // switch spans every account, and the global check runs before capital is
    // ever considered, so no balance seed is needed to hit it.
    const fresh = `gks2-c-${suffix}`;
    await expect(
      inBotId(fresh, (bot) =>
        bot.create({
          botInstanceId: fresh,
          accountLabel: `acct-c-${suffix}`,
          exchange: "binance",
          pair: TEST_PAIR,
          capitalAsset: "USDT",
          allocatedCapital: m("500"),
          params: dcaParams,
          actor: HUMAN,
        }),
      ),
    ).rejects.toMatchObject({ code: "globally_tripped" });

    // After a human reset, resume is allowed again (global armed, account armed).
    await resetGlobalKillSwitchFromEnv(env, { actor: HUMAN, note: "resolved" }, { now: () => clock });
    expect(await isGloballyTripped(db)).toBe(false);
    const resumed = await inBotId(a1, (bot) => bot.resume(HUMAN));
    expect(resumed.status).toBe("running");
  });
});
