/**
 * The standing-alert lifecycle, and the agreement between its two callers.
 *
 * There are two very different things to prove here and this file is
 * deliberately split along that line.
 *
 * 1. THE MECHANISM does what it claims: one row per open incident under
 *    repeated raising, resolution only from a pass that actually observed, and
 *    a fresh row when a resolved incident returns.
 *
 * 2. THE TWO CALLERS AGREE. That is the reason the mechanism was extracted out
 *    of `reconcile.ts` at step 20, so proving each of them correct in isolation
 *    would miss the point entirely -- a second, parallel implementation would
 *    also pass its own tests, right up until the two drifted apart. So the
 *    second half of this file runs reconciliation's REAL cron pass and a REAL
 *    `BotInstance` poll against ONE database, repeatedly, and asserts both the
 *    dedup and the ownership boundary between them.
 */

import { beforeEach, describe, expect, it } from "vitest";

import { raiseStandingAlert, resolveClearedStandingAlerts, standingAlertKey } from "./standing";
import { seedPlaceholderTotalBalance } from "../capital";
import type { Database } from "../db/database";
import { botInstanceRow, freshDatabase } from "../db/test-helpers";
import type { BotInstance, CreateDcaBotRequest } from "../durable-objects/bot-instance";
import { POLL_STANDING_ALERT_TYPES } from "../durable-objects/bot-instance";
import { FakeExchange, TEST_PAIR } from "../durable-objects/fake-exchange";
import { inBot, noopFeed, rateLimiterStub } from "../durable-objects/test-helpers";
import { reconcileAccount, type ReconciliationPorts } from "../reconciliation/reconcile";
import { fromDecimalString as m, ZERO } from "../shared/money";
import type { DcaParams } from "../strategies/dca";

const T0 = 1_910_000_000_000; // future: an armed alarm must not already be overdue (step 20)
const SOURCE = "test-writer";

let db: Database;

beforeEach(async () => {
  db = await freshDatabase();
  // `alerts.bot_instance_id` is a real foreign key, so the bots an incident is
  // attributed to have to exist.
  for (const id of ["bot-1", "bot-2", "someone-elses-bot"]) {
    await db.botInstances.insert(botInstanceRow({ id, account_label: "fixture" }));
  }
});

let ids = 0;
const newId = () => `alert-${(ids += 1)}`;

function alertFor(overrides: Partial<Parameters<typeof raiseStandingAlert>[2]> = {}) {
  return {
    alertType: "unattributable_fill",
    botInstanceId: "bot-1",
    severity: "critical" as const,
    category: "trading" as const,
    source: SOURCE,
    message: "the condition",
    at: T0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. The mechanism
// ---------------------------------------------------------------------------

describe("raiseStandingAlert", () => {
  it("writes ONE row however many times the same incident is re-detected", async () => {
    // The whole point. At step 20's 30-second cadence an unconditional insert
    // writes ~2,880 identical rows per bot per day, and "how many unresolved
    // criticals are there" -- the one number that most needs to mean something
    // -- stops meaning anything.
    for (let i = 0; i < 20; i++) {
      await raiseStandingAlert(db, newId, alertFor());
    }

    expect(await db.alerts.count({ alert_type: "unattributable_fill" })).toBe(1);
  });

  it("reports whether it actually wrote, so first detection is distinguishable", async () => {
    expect(await raiseStandingAlert(db, newId, alertFor())).toBe(true);
    expect(await raiseStandingAlert(db, newId, alertFor())).toBe(false);
  });

  it("does not key on the message: a re-detection whose wording drifts is the same incident", async () => {
    await raiseStandingAlert(db, newId, alertFor({ message: "0.5 filled at 10:00, run abc" }));
    await raiseStandingAlert(db, newId, alertFor({ message: "0.9 filled at 10:30, run def" }));

    const rows = await db.alerts.findMany({ where: { alert_type: "unattributable_fill" } });
    expect(rows).toHaveLength(1);
    // The FIRST wording is kept. The row is the incident, not the latest reading.
    expect(rows[0]!.message).toMatch(/run abc/);
  });

  it("keeps separate incidents separate: by bot, by type, and by writer", async () => {
    await raiseStandingAlert(db, newId, alertFor());
    await raiseStandingAlert(db, newId, alertFor({ botInstanceId: "bot-2" }));
    await raiseStandingAlert(db, newId, alertFor({ alertType: "poll_blind" }));
    // A different writer keeps its own row, because it also owns its own
    // resolution -- deduping across writers would suppress an alert behind a
    // row this writer could never close.
    await raiseStandingAlert(db, newId, alertFor({ source: "reconciliation" }));

    expect(await db.alerts.count()).toBe(4);
  });

  it("raises a FRESH row once the previous incident has been resolved", async () => {
    await raiseStandingAlert(db, newId, alertFor());
    const [first] = await db.alerts.findMany({ where: {} });
    await db.alerts.update({ id: first!.id }, { resolved: true });

    await raiseStandingAlert(db, newId, alertFor());

    const rows = await db.alerts.findMany({ where: {} });
    expect(rows).toHaveLength(2);
    expect(rows.filter((row) => !row.resolved)).toHaveLength(1);
  });
});

describe("resolveClearedStandingAlerts", () => {
  function pass(overrides: Partial<Parameters<typeof resolveClearedStandingAlerts>[1]> = {}) {
    return {
      source: SOURCE,
      owns: () => true,
      stillOpen: new Set<string>(),
      observed: true,
      inScope: () => true,
      ...overrides,
    };
  }

  it("closes an incident the pass did not re-find", async () => {
    await raiseStandingAlert(db, newId, alertFor());

    const resolved = await resolveClearedStandingAlerts(db, pass());

    expect(resolved).toHaveLength(1);
    expect((await db.alerts.findMany({ where: {} }))[0]!.resolved).toBe(true);
  });

  it("leaves an incident the pass DID re-find", async () => {
    await raiseStandingAlert(db, newId, alertFor());

    await resolveClearedStandingAlerts(
      db,
      pass({ stillOpen: new Set([standingAlertKey("unattributable_fill", "bot-1")]) }),
    );

    expect((await db.alerts.findMany({ where: {} }))[0]!.resolved).toBe(false);
  });

  it("resolves NOTHING on a pass that observed nothing", async () => {
    // Section 5.6 applied to the alert lifecycle, and the nastiest failure
    // available in this module: a pass that could not reach the exchange found
    // no condition because it LOOKED at nothing. Closing on that basis clears a
    // live incident on the strength of an outage.
    await raiseStandingAlert(db, newId, alertFor());

    const resolved = await resolveClearedStandingAlerts(db, pass({ observed: false }));

    expect(resolved).toEqual([]);
    expect((await db.alerts.findMany({ where: {} }))[0]!.resolved).toBe(false);
  });

  it("never touches a row it does not own, even under its own source", async () => {
    // `reconciliation_blind`, `cancel_failed` and friends share a source with
    // the standing types but have their own lifecycles.
    await raiseStandingAlert(db, newId, alertFor({ alertType: "cancel_failed" }));

    await resolveClearedStandingAlerts(
      db,
      pass({ owns: (alertType) => alertType === "unattributable_fill" }),
    );

    expect((await db.alerts.findMany({ where: {} }))[0]!.resolved).toBe(false);
  });

  it("never touches a row outside the scope this pass covered", async () => {
    await raiseStandingAlert(db, newId, alertFor({ botInstanceId: "someone-elses-bot" }));

    await resolveClearedStandingAlerts(
      db,
      pass({ inScope: (botInstanceId) => botInstanceId === "bot-1" }),
    );

    expect((await db.alerts.findMany({ where: {} }))[0]!.resolved).toBe(false);
  });

  it("never touches another writer's row", async () => {
    await raiseStandingAlert(db, newId, alertFor({ source: "reconciliation" }));

    await resolveClearedStandingAlerts(db, pass());

    expect((await db.alerts.findMany({ where: {} }))[0]!.resolved).toBe(false);
  });
});
// ---------------------------------------------------------------------------
// 2. The two real callers, ONE database, ONE bot
// ---------------------------------------------------------------------------

const ACCOUNT = "main";
const BOT_ID = "poll-bot";
const ACTOR = "owner@example.com";

const params: DcaParams = {
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

/**
 * The two writers, on the same bot, seeing the same underlying problem.
 *
 * ONE BOT IS THE POINT. An earlier version of this block gave each writer its
 * own bot, and every cross-writer assertion in it passed even with the
 * ownership checks deleted -- the bot-scoping alone was enough to keep them
 * apart, so the test proved nothing about ownership. Production looks like this
 * instead: reconciliation reconciles the very account its bots are polling, so
 * both writers hold open incidents against the SAME `bot_instance_id` and the
 * only things separating them are `source` and `owns`.
 *
 * The shared condition is real rather than staged: one resting base order that
 * the venue reports as fully filled with no per-fill detail behind it. The bot's
 * poll reads that as an unattributable fill; reconciliation reads the same
 * order, against the same exchange, as meaningful order-state drift.
 */
describe("reconciliation's cron and the bot's poll share ONE lifecycle", () => {
  let exchange: FakeExchange;
  let clock: number;
  let objectName: string;
  let nameCounter = 0;
  let clientOrderId: string;

  /** Attach this test's dependencies and run something inside the real object. */
  async function inThisBot<T>(body: (bot: BotInstance) => Promise<T>): Promise<T> {
    return await inBot(objectName, async (bot) => {
      bot.attach({
        db,
        exchange,
        now: () => clock,
        newId: () => `bot-${(ids += 1)}`,
        limiterFor: () => rateLimiterStub(`limiter-${objectName}`),
        sleep: async () => undefined,
        feedFor: () => noopFeed,
      });
      return await body(bot);
    });
  }

  /**
   * Reconciliation's ports, over the same database -- and reading the REAL
   * Durable Object rather than a hand-built snapshot, so the drift it finds is
   * the bot's actual state against the actual exchange.
   */
  function ports(): ReconciliationPorts {
    return {
      db,
      exchange,
      now: () => clock,
      newId: () => `recon-${(ids += 1)}`,
      haltBot: async (botInstanceId, detail) => {
        await db.botInstances.update(
          { id: botInstanceId, status: { ne: "stopped" } },
          { status: "halted", halt_reason: detail, halted_at: clock, updated_at: clock },
        );
      },
      snapshotBot: async () => await inThisBot((bot) => bot.snapshotIfCreated()),
    };
  }

  const reconciliationPass = () => reconcileAccount(ports(), ACCOUNT);
  const pollPass = () => inThisBot((bot) => bot.checkOpenOrders(ACTOR));

  const openRows = async (alertType: string) =>
    await db.alerts.findMany({ where: { alert_type: alertType } });

  const DRIFT = "reconciliation_meaningful_order_state_drift";
  const UNATTRIBUTABLE = "unattributable_fill";

  beforeEach(async () => {
    exchange = new FakeExchange();
    exchange.now = T0;
    clock = T0;
    nameCounter += 1;
    objectName = `standing-bot-${nameCounter}`;

    await seedPlaceholderTotalBalance(
      db,
      { accountLabel: ACCOUNT, asset: "USDT", totalBalance: m("10000"), note: "fixture" },
      { actor: ACTOR, now: T0 },
    );

    const creation: CreateDcaBotRequest = {
      botInstanceId: BOT_ID,
      accountLabel: ACCOUNT,
      exchange: "binance",
      pair: TEST_PAIR,
      capitalAsset: "USDT",
      allocatedCapital: m("400"),
      params,
      actor: ACTOR,
    };
    await inThisBot(async (bot) => {
      await bot.create(creation);
      await bot.start(ACTOR);
      await bot.onPriceUpdate({ pair: TEST_PAIR, price: m("100"), at: clock });
    });
    clientOrderId = exchange.placed[0]!.clientOrderId;

    // The condition both writers see: fully filled on the venue, nothing
    // recorded here, and no per-fill detail to attribute it with.
    exchange.resting.get(clientOrderId)!.filledQuantity = m("1");

    // Balances reconcile cleanly, so the only findings are about the order.
    exchange.balances = [{ asset: "USDT", free: m("10000"), locked: ZERO }];
    await db.balanceSnapshots.insert({
      id: "bs-baseline",
      reconciliation_run_id: "run-0",
      account_label: ACCOUNT,
      asset: "USDT",
      exchange_reported_balance: m("10000"),
      internal_calculated_balance: m("10000"),
      discrepancy: ZERO,
      classification: null,
      checked_at: T0 - 300_000,
    });

    // Past reconciliation's 60-second timing window, so the order that left the
    // book is real drift rather than section 9's "a fill recorded a few seconds
    // late" -- which is minor, auto-corrected, and deliberately raises no row.
    clock += 600_000;
  });

  it("both writers really do raise, against the same bot", async () => {
    // Without this the assertions below could pass vacuously.
    await reconciliationPass();
    await pollPass();

    const drift = await openRows(DRIFT);
    const unattributable = await openRows(UNATTRIBUTABLE);
    expect(drift).toHaveLength(1);
    expect(unattributable).toHaveLength(1);
    expect(drift[0]!.bot_instance_id).toBe(BOT_ID);
    expect(unattributable[0]!.bot_instance_id).toBe(BOT_ID);
    // Same bot, same incident key but for the type -- kept apart by `source`.
    expect(drift[0]!.source).toBe("reconciliation");
    expect(unattributable[0]!.source).toBe("bot-instance");
  });

  it("each writes ONE row under repeated firing, at either cadence", async () => {
    // Five cron passes and ten poll passes of two unchanged conditions. Under
    // the pre-step-18 unconditional insert that is 15 rows; under a poll with
    // its own private dedup it is whatever that second copy happened to do.
    for (let i = 0; i < 5; i++) await reconciliationPass();
    for (let i = 0; i < 10; i++) await pollPass();

    expect(await openRows(UNATTRIBUTABLE)).toHaveLength(1);
    expect(await openRows(DRIFT)).toHaveLength(1);
  });

  it("interleaving them, as a 30-second timer and a 5-minute cron do, changes nothing", async () => {
    for (let i = 0; i < 5; i++) {
      await pollPass();
      await reconciliationPass();
      await pollPass();
    }

    expect(await openRows(UNATTRIBUTABLE)).toHaveLength(1);
    expect(await openRows(DRIFT)).toHaveLength(1);
  });

  it("the poll does not resolve reconciliation's incident on the same bot", async () => {
    // Ownership, with bot-scoping deliberately removed as a defence: both rows
    // name this bot. A writer that could close another's row would be closing
    // an incident it never observed -- and the poll cannot see what
    // reconciliation compares (D1's mirror, the ledger, the account balance).
    await reconciliationPass();
    await pollPass();

    // The poll's own condition clears; reconciliation's does not.
    exchange.resting.get(clientOrderId)!.filledQuantity = ZERO;
    await pollPass();

    expect((await openRows(UNATTRIBUTABLE))[0]!.resolved).toBe(true);
    expect((await openRows(DRIFT))[0]!.resolved).toBe(false);
  });

  it("and reconciliation does not resolve the poll's, on a pass that resolves its own", async () => {
    // Deliberately not "run a pass and check nothing happened": that would pass
    // just as well if the resolve half never ran at all. A stale
    // reconciliation-owned incident is planted on the SAME bot, so one pass
    // closes one row and leaves the other, and the only thing distinguishing
    // them is ownership.
    await pollPass();
    await raiseStandingAlert(db, () => "stale-balance-alert", {
      alertType: "reconciliation_meaningful_balance_drift",
      botInstanceId: BOT_ID,
      severity: "critical",
      category: "trading",
      source: "reconciliation",
      message: "a balance discrepancy from an earlier run, no longer present",
      at: T0,
    });

    await reconciliationPass();

    expect((await openRows("reconciliation_meaningful_balance_drift"))[0]!.resolved).toBe(true);
    expect((await openRows(UNATTRIBUTABLE))[0]!.resolved).toBe(false);
    // And it did find, and keep, its own order-state incident.
    expect((await openRows(DRIFT))[0]!.resolved).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 3. There is only ONE implementation, mechanically
// ---------------------------------------------------------------------------

declare global {
  interface ImportMeta {
    glob(pattern: string, options: { query: string; eager: true }): Record<string, unknown>;
  }
}

const SOURCES = import.meta.glob("/src/**/*.ts", { query: "?raw", eager: true }) as Record<
  string,
  { default: string }
>;

describe("no second, parallel implementation", () => {
  it("found the source files to check", () => {
    // Without this the assertions below would pass vacuously, which is the one
    // way a source-level guard rots unnoticed.
    expect(Object.keys(SOURCES)).toContain("/src/alerts/standing.ts");
    expect(Object.keys(SOURCES)).toContain("/src/durable-objects/bot-instance.ts");
  });

  it("declares the raise/resolve pair in exactly one file", () => {
    const declarations = Object.entries(SOURCES)
      .filter(([path]) => !path.endsWith(".test.ts"))
      .filter(([, module]) => /function\s+(raiseStandingAlert|resolveClearedStandingAlerts)\s*\(/.test(module.default))
      .map(([path]) => path);

    expect(declarations).toEqual(["/src/alerts/standing.ts"]);
  });

  it("raises every re-detected condition through the standing path, never `#alert`", () => {
    // The realistic regression: someone adds another poll alert next to the
    // existing ones and reaches for `#alert`, which is right for a discrete
    // event and catastrophic for a condition re-derived every 30 seconds.
    //
    // THE SET IS IMPORTED, NOT RETYPED (step 22). The first version listed the
    // three types by hand, which meant a fourth was covered only if whoever
    // added it also remembered to extend this guard -- and the whole point of
    // the guard is that they did not remember. `price_updates_stale` was
    // exactly that fourth type. Reading the real set makes the coverage
    // automatic, and `POLL_STANDING_ALERT_TYPES` is exported for this.
    const source = SOURCES["/src/durable-objects/bot-instance.ts"]!.default.split("\n");
    const standingTypes = [...POLL_STANDING_ALERT_TYPES];
    expect(standingTypes.length).toBeGreaterThan(3);

    const offenders: string[] = [];
    for (const [index, line] of source.entries()) {
      const match = /alertType:\s*"([a-z_]+)"/.exec(line);
      if (match === null || !standingTypes.includes(match[1]!)) continue;
      const preceding = source.slice(Math.max(0, index - 12), index).join("\n");
      if (!preceding.includes("#raiseStanding(")) {
        offenders.push(`line ${index + 1}: ${match[1]} is not raised through #raiseStanding`);
      }
    }

    expect(offenders).toEqual([]);
  });
});
