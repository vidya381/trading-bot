/**
 * WHICH BOTS AN EMERGENCY STOP VISITS (step 3c).
 *
 * Both sweeps used to select targets with `status IN ('created','running')`.
 * That makes an emergency stop only as good as D1's accuracy, and tonight
 * proved D1 can be wrong: live bot `bot-gvtr1a` had a row saying `halted` while
 * its Durable Object was internally `running`, subscribed to its price feed and
 * able to trade. It was invisible to the global kill switch and to its
 * account's circuit breaker, at the one moment that invisibility matters.
 *
 * 3a fixed the known cause and 3b detects the condition. This is neither: it is
 * INSURANCE against causes not yet found, and it must hold without waiting for
 * a detector pass to have run first. So the sweeps now visit `halted` bots too.
 *
 * THE THREE THINGS THAT MADE THIS SAFE TO DO, each pinned below:
 *   1. `#halt` on an already-halted bot writes NOTHING -- no state, no alert,
 *      no audit row -- so the extra visit costs one idempotent RPC.
 *   2. `stopped` is excluded, because `#halt` THROWS on one rather than
 *      no-oping, which would report a false failure on every pull.
 *   3. `haltedBotIds` keeps its meaning; already-halted bots are reported
 *      separately, so the count a human reads in an emergency did not silently
 *      change what it counts.
 */

import { beforeEach, describe, expect, it } from "vitest";

import {
  readCircuitBreaker,
  tripAccountCircuitBreaker,
  type HaltBotOutcome,
} from "./circuit-breaker";
import { tripGlobalKillSwitch } from "./kill-switch";
import { reconcileAccount, type ReconciliationPorts } from "./reconcile";
import { seedPlaceholderTotalBalance } from "../capital";
import type { Database } from "../db/database";
import type { BotStatus } from "../db/schema";
import { botInstanceRow, capitalLedgerRow, freshDatabase } from "../db/test-helpers";
import type { BotInstance } from "../durable-objects/bot-instance";
import { FakeExchange, TEST_PAIR } from "../durable-objects/fake-exchange";
import { inBot, noopFeed, rateLimiterStub } from "../durable-objects/test-helpers";
import { fromDecimalString as m, ZERO } from "../shared/money";
import type { DcaParams } from "../strategies/dca";

const T0 = 1_920_000_000_000;
const ACCOUNT = "main";
const HUMAN = "owner@example.com";

let db: Database;
let exchange: FakeExchange;
let clock: number;
let ids: number;
/** Every bot the sweep called the halt port for, in call order. */
let visited: string[];

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

beforeEach(async () => {
  db = await freshDatabase();
  exchange = new FakeExchange();
  exchange.now = T0;
  clock = T0;
  ids = 0;
  visited = [];
});

const newId = (): string => `id-${(ids += 1)}`;

/** The production port's shape: report `already_halted` rather than swallow it. */
function reportingHalt() {
  return async (botInstanceId: string): Promise<HaltBotOutcome> => {
    visited.push(botInstanceId);
    const row = await db.botInstances.findOne({ id: botInstanceId });
    if (row?.status === "stopped") {
      // What `BotInstance.#halt` really does, and the reason `stopped` is not
      // in the swept set.
      throw new Error("a stopped bot cannot be halted; its capital is released");
    }
    if (row?.status === "halted") return "already_halted";
    await db.botInstances.update(
      { id: botInstanceId, status: { ne: "stopped" } },
      { status: "halted", halt_reason: "swept", halted_at: clock, updated_at: clock },
    );
    return "halted";
  };
}

async function insertBot(
  id: string,
  status: BotStatus,
  extra: Record<string, unknown> = {},
): Promise<void> {
  await db.botInstances.insert(
    botInstanceRow({
      id,
      account_label: ACCOUNT,
      status,
      halt_reason: status === "halted" ? "manual: earlier" : null,
      halted_at: status === "halted" ? T0 - 60_000 : null,
      ...extra,
    }),
  );
}

// ===========================================================================
// The target set
// ===========================================================================

describe("the swept set", () => {
  it("includes halted bots in the GLOBAL kill switch, and excludes stopped ones", async () => {
    await insertBot("live", "running");
    await insertBot("fresh", "created");
    await insertBot("already", "halted");
    await insertBot("closed", "stopped");

    const result = await tripGlobalKillSwitch(db, {
      reason: "suspected compromise",
      actor: HUMAN,
      now: T0,
      haltBot: reportingHalt(),
      newId,
    });

    expect(visited.slice().sort()).toEqual(["already", "fresh", "live"]);
    expect(visited).not.toContain("closed");
    expect(result.haltedBotIds.slice().sort()).toEqual(["fresh", "live"]);
    expect(result.alreadyHaltedBotIds).toEqual(["already"]);
    // The stopped bot produced no FAILURE either -- it was never visited, which
    // is the difference between excluding it and letting `#halt` throw.
    expect(result.failures).toEqual([]);
  });

  it("includes halted bots in the ACCOUNT circuit breaker, and excludes stopped ones", async () => {
    await insertBot("live", "running");
    await insertBot("already", "halted");
    await insertBot("closed", "stopped");

    const result = await tripAccountCircuitBreaker(db, {
      accountLabel: ACCOUNT,
      reason: "meaningful drift",
      runId: "run-1",
      actor: "reconciliation",
      now: T0,
      haltBot: reportingHalt(),
      newId,
    });

    expect(visited.slice().sort()).toEqual(["already", "live"]);
    expect(result.haltedBotIds).toEqual(["live"]);
    expect(result.alreadyHaltedBotIds).toEqual(["already"]);
    expect(result.failures).toEqual([]);
    expect((await readCircuitBreaker(db, ACCOUNT))!.state).toBe("tripped");
  });

  it("sweeps an ARCHIVED bot that is halted, because archived is not a status", async () => {
    // `archived` is orthogonal to `status` by explicit design, and an archived
    // bot's object can be secretly live exactly like any other. Neither sweep
    // filters on the flag, in either direction -- asserted so that "hidden from
    // the default list view" never quietly becomes "exempt from the kill
    // switch".
    await insertBot("archived-halted", "halted", { archived: true });
    await insertBot("archived-stopped", "stopped", { archived: true });

    await tripGlobalKillSwitch(db, {
      reason: "everything down",
      actor: HUMAN,
      now: T0,
      haltBot: reportingHalt(),
      newId,
    });

    expect(visited).toEqual(["archived-halted"]);
  });

  it("reaches the bots D1 believes are live BEFORE the already-halted ones", async () => {
    // The sweep is a sequential loop of awaited cross-object RPCs, so every bot
    // visited ahead of a live one delays stopping it. Insurance must not slow
    // the emergency path down. The halted bots are inserted FIRST so that the
    // query's own row order would put them first if nothing reordered.
    await insertBot("halted-a", "halted");
    await insertBot("halted-b", "halted");
    await insertBot("live-a", "running");
    await insertBot("live-b", "created");

    await tripGlobalKillSwitch(db, {
      reason: "everything down",
      actor: HUMAN,
      now: T0,
      haltBot: reportingHalt(),
      newId,
    });

    expect(visited.slice(0, 2).sort()).toEqual(["live-a", "live-b"]);
    expect(visited.slice(2).sort()).toEqual(["halted-a", "halted-b"]);
  });
});

// ===========================================================================
// The no-op, against a REAL BotInstance
// ===========================================================================

describe("sweeping a genuinely halted bot", () => {
  /**
   * The claim that made 3c safe, checked against the real object rather than a
   * double: `#halt`'s already-halted branch reads the clock and the state and
   * returns. No status write, no alert row, no audit row, no exchange call.
   * If that were ever to change, a kill-switch pull on an account of halted
   * bots would write one duplicate alert per bot, per pull.
   */
  it("writes nothing at all: no duplicate alert, no duplicate audit row, no state change", async () => {
    const objectName = `sweep-noop-${Date.now()}`;
    const attach = (bot: BotInstance): void =>
      bot.attach({
        db,
        exchange,
        now: () => clock,
        newId: () => `n-${(ids += 1)}`,
        limiterFor: () => rateLimiterStub(`limiter-${objectName}`),
        sleep: async () => undefined,
        feedFor: () => noopFeed,
      });

    await seedPlaceholderTotalBalance(
      db,
      { accountLabel: ACCOUNT, asset: "USDT", totalBalance: m("5000"), note: "test fixture" },
      { actor: HUMAN, now: T0 },
    );

    await inBot(objectName, async (bot) => {
      attach(bot as BotInstance);
      await (bot as BotInstance).create({
        botInstanceId: "dca-btc-1",
        accountLabel: ACCOUNT,
        exchange: "binance",
        pair: TEST_PAIR,
        capitalAsset: "USDT",
        allocatedCapital: m("400"),
        params,
        actor: HUMAN,
      });
      await (bot as BotInstance).start(HUMAN);
      await (bot as BotInstance).halt("manual", "operator paused it", HUMAN);
    });

    const before = {
      snapshot: await inBot(objectName, async (bot) => {
        attach(bot as BotInstance);
        return await (bot as BotInstance).snapshot();
      }),
      alerts: (await db.alerts.findMany({ where: { bot_instance_id: "dca-btc-1" } })).length,
      audits: (await db.auditLog.findMany({ where: { target_bot_instance_id: "dca-btc-1" } })).length,
      row: await db.botInstances.findOne({ id: "dca-btc-1" }),
    };
    expect(before.snapshot.state.status).toBe("halted");
    expect(before.alerts).toBeGreaterThan(0); // the halt really did alert once

    // THE SWEEP, through the real object, twice -- because a kill switch that
    // is pulled twice must stay safe.
    const realHalt = async (botInstanceId: string): Promise<HaltBotOutcome> => {
      visited.push(botInstanceId);
      return await inBot(objectName, async (bot) => {
        attach(bot as BotInstance);
        const result = await (bot as BotInstance).halt("manual", "kill switch", "kill-switch");
        return result.action === "already_halted" ? "already_halted" : "halted";
      });
    };

    const first = await tripGlobalKillSwitch(db, {
      reason: "everything down",
      actor: HUMAN,
      now: T0 + 1,
      haltBot: realHalt,
      newId,
    });
    const second = await tripGlobalKillSwitch(db, {
      reason: "again",
      actor: HUMAN,
      now: T0 + 2,
      haltBot: realHalt,
      newId,
    });

    // It really was visited, both times -- the assertions below are about a
    // call that happened, not one that was skipped.
    expect(visited).toEqual(["dca-btc-1", "dca-btc-1"]);
    expect(first.haltedBotIds).toEqual([]);
    expect(first.alreadyHaltedBotIds).toEqual(["dca-btc-1"]);
    expect(second.alreadyHaltedBotIds).toEqual(["dca-btc-1"]);

    const after = {
      snapshot: await inBot(objectName, async (bot) => {
        attach(bot as BotInstance);
        return await (bot as BotInstance).snapshot();
      }),
      alerts: (await db.alerts.findMany({ where: { bot_instance_id: "dca-btc-1" } })).length,
      audits: (await db.auditLog.findMany({ where: { target_bot_instance_id: "dca-btc-1" } })).length,
      row: await db.botInstances.findOne({ id: "dca-btc-1" }),
    };

    // NOTHING MOVED.
    expect(after.alerts).toBe(before.alerts);
    expect(after.audits).toBe(before.audits);
    expect(after.snapshot.state).toEqual(before.snapshot.state);
    expect(after.row!.halt_reason).toBe(before.row!.halt_reason);
    expect(after.row!.halted_at).toBe(before.row!.halted_at);
    expect(after.row!.updated_at).toBe(before.row!.updated_at);
    // And nothing was sent to the exchange on either pull.
    expect(exchange.cancelled).toEqual([]);
  });
});

// ===========================================================================
// The guard that must NOT widen with the sweep
// ===========================================================================

describe("the five-minute re-sweep of a latched account", () => {
  /**
   * `reconcile.ts` re-sweeps an already-latched account only when
   * `activeBotsOnAccount` finds something, "so a quiet latched account does not
   * write an audit row every five minutes". That guard reads `ACTIVE_STATUSES`,
   * which is why 3c added a SECOND constant instead of widening that one.
   *
   * Widening the shared constant would have made the guard permanently true on
   * every latched account -- tripping halts every bot, so a latched account
   * always has halted bots -- and reconciliation would write a
   * `circuit_breaker.swept` row every five minutes, forever, on every account
   * that had ever tripped. This is the test that stops that from being
   * reintroduced by someone tidying two constants into one.
   */
  it("stays quiet once every bot on it is halted", async () => {
    await insertBot("dca-btc-1", "halted");
    await db.capitalLedger.insert(
      capitalLedgerRow({
        id: "cl-main-usdt",
        account_label: ACCOUNT,
        asset: "USDT",
        total_balance: m("5000"),
        total_allocated: m("400"),
      }),
    );
    await db.balanceSnapshots.insert({
      id: "bs-usdt",
      reconciliation_run_id: "run-0",
      account_label: ACCOUNT,
      asset: "USDT",
      exchange_reported_balance: m("5000"),
      internal_calculated_balance: m("5000"),
      discrepancy: ZERO,
      classification: null,
      checked_at: T0 - 300_000,
    });
    exchange.balances = [{ asset: "USDT", free: m("5000"), locked: ZERO }];
    await db.circuitBreakers.insert({
      account_label: ACCOUNT,
      state: "tripped",
      reason: "earlier drift",
      run_id: "run-0",
      tripped_at: T0 - 600_000,
      tripped_by: "reconciliation",
      reset_at: null,
      reset_by: null,
      updated_at: T0 - 600_000,
    });

    const reconPorts: ReconciliationPorts = {
      db,
      exchange,
      now: () => clock,
      newId,
      haltBot: reportingHalt(),
      snapshotBot: async () => null,
    };

    const auditsBefore = (
      await db.auditLog.findMany({ where: { action: "circuit_breaker.swept" } })
    ).length;

    await reconcileAccount(reconPorts, ACCOUNT);
    await reconcileAccount(reconPorts, ACCOUNT);
    await reconcileAccount(reconPorts, ACCOUNT);

    const auditsAfter = (
      await db.auditLog.findMany({ where: { action: "circuit_breaker.swept" } })
    ).length;

    // Three passes over a fully-halted latched account, and not one re-sweep.
    expect(auditsAfter).toBe(auditsBefore);
    expect(visited).toEqual([]);
  });
});
