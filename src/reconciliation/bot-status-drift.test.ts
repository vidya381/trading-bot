/**
 * The bot-status comparison (step 3b): D1's `bot_instances.status` against the
 * Durable Object's own `state.status`.
 *
 * WHAT THIS IS FOR. Before it, `snapshot.state.status` was read by nothing
 * outside the Durable Object, so the two stores could disagree forever with
 * nothing looking. Live testnet bot `bot-gvtr1a` did exactly that -- row
 * `halted`, object `running`, receiving prices, and invisible to BOTH emergency
 * stops, which each select their targets with `status IN ('created','running')`.
 * See `docs/open-items/resume-split-brain.md`.
 *
 * THE SHAPE OF EVERY TEST BELOW. A disagreement is never acted on the first
 * time it is seen: reconciliation reads the rows once at the top of a run and
 * each snapshot later in the same run, and every status transition writes those
 * two stores one after the other -- so a healthy transition in flight IS a
 * disagreement across those two reads. Confirmation therefore takes two runs,
 * which is why almost every test here calls `reconcileAccount` twice, exactly as
 * the live-order drift tests in `reconcile.test.ts` do.
 */

import { beforeEach, describe, expect, it } from "vitest";

import { reconcileAccount, type ReconciliationPorts } from "./reconcile";
import { seedPlaceholderTotalBalance } from "../capital";
import type { Database } from "../db/database";
import type { AlertRow, BotStatus } from "../db/schema";
import {
  botInstanceRow,
  capitalLedgerRow,
  freshDatabase,
} from "../db/test-helpers";
import type { BotInstance, BotRuntimeState, BotSnapshot } from "../durable-objects/bot-instance";
import { FakeExchange, TEST_PAIR } from "../durable-objects/fake-exchange";
import { inBot, noopFeed, rateLimiterStub } from "../durable-objects/test-helpers";
import { fromDecimalString as m, ZERO } from "../shared/money";
import { DCA_SCHEMA_VERSION, EMPTY_POSITION, type DcaParams } from "../strategies/dca";

// `import.meta.glob` is a Vite feature, declared locally rather than by pulling
// "vite/client" into tsconfig's `types` -- the same arrangement, and the same
// reason, as `src/db/no-raw-d1.test.ts`.
declare global {
  interface ImportMeta {
    glob(
      pattern: string,
      options: { query: string; eager: true },
    ): Record<string, unknown>;
  }
}

const SOURCES = import.meta.glob("/src/reconciliation/*.ts", {
  query: "?raw",
  eager: true,
}) as Record<string, { default: string }>;

const T0 = 1_910_000_000_000;
const ACCOUNT = "main";
const BOT = "dca-btc-1";
const ACTOR = "owner@example.com";

let db: Database;
let exchange: FakeExchange;
let clock: number;
let ids: number;
let halted: { botInstanceId: string; detail: string }[];
let snapshots: Map<string, BotSnapshot>;

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
  halted = [];
  snapshots = new Map();
});

function ports(overrides: Partial<ReconciliationPorts> = {}): ReconciliationPorts {
  return {
    db,
    exchange,
    now: () => clock,
    newId: () => `id-${(ids += 1)}`,
    haltBot: async (botInstanceId, detail) => {
      halted.push({ botInstanceId, detail });
      // What the real port does: the object's own `#halt`, which mirrors.
      await db.botInstances.update(
        { id: botInstanceId, status: { ne: "stopped" } },
        { status: "halted", halt_reason: detail, halted_at: clock, updated_at: clock },
      );
      const snapshot = snapshots.get(botInstanceId);
      if (snapshot !== undefined) {
        snapshots.set(botInstanceId, {
          ...snapshot,
          state: { ...snapshot.state, status: "halted", haltReason: detail, haltedAt: clock },
        });
      }
    },
    snapshotBot: async (botInstanceId) => snapshots.get(botInstanceId) ?? null,
    ...overrides,
  };
}

function snapshotFor(botInstanceId: string, state: Partial<BotRuntimeState> = {}): BotSnapshot {
  return {
    config: {
      strategy: "dca",
      schemaVersion: DCA_SCHEMA_VERSION,
      botInstanceId,
      accountLabel: ACCOUNT,
      exchange: "binance",
      pair: TEST_PAIR,
      capitalAsset: "USDT",
      allocatedCapital: m("400"),
      params,
    },
    state: {
      schemaVersion: DCA_SCHEMA_VERSION,
      status: "running",
      cycleCount: 0,
      position: EMPTY_POSITION,
      nextSequence: 1,
      openOrderIds: [],
      haltReason: null,
      haltedAt: null,
      lastPrice: m("65000"),
      lastPriceAt: T0,
      realizedGross: ZERO,
      filters: null,
      exitOrderId: null,
      ...state,
    },
    orders: [],
  };
}

/** A bot row, its ledger and a balance baseline: a run with no OTHER findings. */
async function seedAccount(rowStatus: BotStatus, objectStatus: BotStatus): Promise<void> {
  await db.botInstances.insert(
    botInstanceRow({
      id: BOT,
      account_label: ACCOUNT,
      status: rowStatus,
      halt_reason: rowStatus === "halted" ? "manual: seeded" : null,
      halted_at: rowStatus === "halted" ? T0 - 60_000 : null,
      allocated_capital: m("400"),
    }),
  );
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
  snapshots.set(
    BOT,
    snapshotFor(BOT, {
      status: objectStatus,
      haltReason: objectStatus === "halted" ? "manual: seeded" : null,
      haltedAt: objectStatus === "halted" ? T0 - 60_000 : null,
    }),
  );
}

async function alertsFor(botInstanceId: string): Promise<AlertRow[]> {
  return await db.alerts.findMany({ where: { bot_instance_id: botInstanceId } });
}

async function rowStatus(): Promise<string> {
  return (await db.botInstances.findOne({ id: BOT }))!.status;
}

// ===========================================================================
// TEST 1 -- when it is raised at all
// ===========================================================================

describe("the comparison itself", () => {
  it("is raised on object-running / D1-halted, on the inverse, and never when they agree", async () => {
    // (a) THE DANGEROUS POLARITY -- bot-gvtr1a's exact condition.
    await seedAccount("halted", "running");
    const dangerous = await reconcileAccount(ports(), ACCOUNT);
    expect(dangerous.findings.some((f) => f.kind === "bot_status_unconfirmed")).toBe(true);
    expect(
      dangerous.findings.find((f) => f.kind === "bot_status_unconfirmed")!.statusPair,
    ).toBe("halted/running");

    // (b) THE INVERSE -- what step 3a's write order produces on interruption.
    db = await freshDatabase();
    snapshots = new Map();
    await seedAccount("running", "halted");
    const safe = await reconcileAccount(ports(), ACCOUNT);
    expect(safe.findings.some((f) => f.kind === "bot_status_unconfirmed")).toBe(true);
    expect(safe.findings.find((f) => f.kind === "bot_status_unconfirmed")!.statusPair).toBe(
      "running/halted",
    );

    // (c) AGREEMENT -- for every status a reconciled bot can hold. Nothing.
    for (const status of ["created", "running", "halted"] as const) {
      db = await freshDatabase();
      snapshots = new Map();
      await seedAccount(status, status);
      const clean = await reconcileAccount(ports(), ACCOUNT);
      expect(
        clean.findings.some((f) => f.kind.startsWith("bot_status_")),
        `status ${status} agreed with itself and must raise nothing`,
      ).toBe(false);
    }
  });

  it("never examines a stopped bot at all", async () => {
    // `RECONCILED_STATUSES` is created/running/halted -- `stopped` is excluded
    // deliberately (its capital is released and it holds no position), so a
    // stopped row is not fetched and cannot produce a status finding however
    // far its object has drifted. Asserted rather than assumed, because the
    // brief for this step named `stopped` as part of the set and it is not.
    await seedAccount("running", "running");
    await db.botInstances.update({ id: BOT }, { status: "stopped" });
    snapshots.set(BOT, snapshotFor(BOT, { status: "running" }));

    const result = await reconcileAccount(ports(), ACCOUNT);

    expect(result.findings.some((f) => f.kind.startsWith("bot_status_"))).toBe(false);
    expect(halted).toEqual([]);
  });
});

// ===========================================================================
// TEST 2 + 3 -- the two-run confirmation
// ===========================================================================

describe("confirmation across two runs", () => {
  it("first sighting is unconfirmed: no alert, no halt, but recorded in the run", async () => {
    await seedAccount("halted", "running");

    const first = await reconcileAccount(ports(), ACCOUNT);

    const finding = first.findings.find((f) => f.kind === "bot_status_unconfirmed");
    expect(finding).toBeDefined();
    expect(finding!.tier).toBe("minor");
    // The three things a first sighting must NOT do.
    expect(halted).toEqual([]);
    expect(await alertsFor(BOT)).toHaveLength(0);
    expect(await rowStatus()).toBe("halted");
    // And the one it must: be in the run record, which is also the memory the
    // next run reads.
    expect(first.findings.map((f) => f.kind)).toContain("bot_status_unconfirmed");
  });

  it("second sighting confirms: haltBot called exactly once, alert raised", async () => {
    await seedAccount("halted", "running");

    await reconcileAccount(ports(), ACCOUNT);
    const second = await reconcileAccount(ports(), ACCOUNT);

    expect(second.findings.some((f) => f.kind === "bot_status_drift")).toBe(true);
    expect(second.tier).toBe("meaningful");
    // EXACTLY once -- not once per finding, not once per run.
    expect(halted).toHaveLength(1);
    expect(halted[0]!.botInstanceId).toBe(BOT);
    expect(second.haltedBotIds).toEqual([BOT]);

    const raised = await alertsFor(BOT);
    expect(raised.some((a) => a.alert_type === "reconciliation_meaningful_bot_status_drift")).toBe(
      true,
    );
    // The halt converged the two stores.
    expect(await rowStatus()).toBe("halted");
  });
});

// ===========================================================================
// TEST 4 -- THE FALSE-POSITIVE GUARD
// ===========================================================================

describe("a healthy transition in flight is never halted", () => {
  /**
   * THE TEST THIS MODULE EXISTS TO PASS.
   *
   * Entry 57 records reconciliation halting two real bots for a disagreement
   * that was a race, not drift. This comparison is exposed to precisely that:
   * `#resumePass` writes D1 and then the object, so a run whose row read lands
   * between those two writes sees a mismatch on a bot that is mid-resume and
   * perfectly healthy.
   *
   * Both halves of the guard are asserted: the first sighting never acts, AND a
   * primed memory still does not act once the transition has completed, because
   * confirming re-reads both stores before doing anything.
   */
  it("yields only an unconfirmed finding, and still does not halt once the resume lands", async () => {
    // A resume that has written D1 and not yet written the object.
    await seedAccount("running", "halted");

    const first = await reconcileAccount(ports(), ACCOUNT);
    expect(first.findings.some((f) => f.kind === "bot_status_unconfirmed")).toBe(true);
    expect(first.tier).toBe("minor");
    expect(halted).toEqual([]);
    expect(await alertsFor(BOT)).toHaveLength(0);

    // The resume now completes: the object catches up to the row. The memory
    // from run 1 still says "seen once", so ONLY the re-read stands between
    // this bot and an unearned action.
    snapshots.set(BOT, snapshotFor(BOT, { status: "running" }));

    const second = await reconcileAccount(ports(), ACCOUNT);

    expect(second.findings.some((f) => f.kind.startsWith("bot_status_"))).toBe(false);
    expect(halted).toEqual([]);
    expect(await alertsFor(BOT)).toHaveLength(0);
    // The row was never corrected backwards -- which is the outcome that would
    // have MANUFACTURED the dangerous state out of a healthy resume.
    expect(await rowStatus()).toBe("running");
  });

  /**
   * THE NARROWEST VERSION OF THE SAME RACE, and the one only the pre-action
   * re-read can catch.
   *
   * Above, the transition completes BETWEEN two runs, so the second run's own
   * top-of-run reads already agree and nothing is raised. Here it completes
   * DURING the confirming run -- after the `bot_instances` rows were read and
   * after the first snapshot, but before the finding is acted on. The
   * top-of-run evidence says "disagrees, and it disagreed last run too", which
   * is everything the escalation needs; only re-reading both stores can tell
   * that the disagreement has since resolved itself.
   *
   * Without the re-read this run would write `halted` over the row of a bot
   * that is now genuinely running -- taking a healthy resume and turning it
   * into the `running`/`halted` split-brain this whole module exists to find.
   * The detector would have manufactured its own finding.
   */
  it("drops the finding when the transition completes mid-run, between the read and the act", async () => {
    await seedAccount("running", "halted");

    // Run 1 primes the memory: seen once, object behind the row.
    await reconcileAccount(ports(), ACCOUNT);
    expect(halted).toEqual([]);

    // Run 2: the object catches up part-way through. The first read of this run
    // still sees `halted`; every read after it sees `running`.
    let reads = 0;
    const catchingUp = ports({
      snapshotBot: async (botInstanceId) => {
        reads += 1;
        return snapshotFor(botInstanceId, { status: reads === 1 ? "halted" : "running" });
      },
    });

    const second = await reconcileAccount(catchingUp, ACCOUNT);

    // The re-read really did happen -- the confirm path asked a second time.
    expect(reads).toBeGreaterThan(1);
    // And it changed the outcome: nothing raised, nothing corrected, nothing
    // halted, and the row still says what the completed resume made it say.
    expect(second.findings.some((f) => f.kind.startsWith("bot_status_"))).toBe(false);
    expect(second.autoCorrections).toEqual([]);
    expect(halted).toEqual([]);
    expect(await rowStatus()).toBe("running");
  });
});

// ===========================================================================
// TEST 5 -- the correction direction
// ===========================================================================

describe("the safe polarity is corrected from the object, never the other way", () => {
  it("writes D1 from the snapshot and never resumes the object", async () => {
    await seedAccount("running", "halted");

    await reconcileAccount(ports(), ACCOUNT);
    const second = await reconcileAccount(ports(), ACCOUNT);

    const finding = second.findings.find((f) => f.kind === "bot_status_mirror_stale");
    expect(finding).toBeDefined();
    expect(finding!.tier).toBe("minor");

    // THE CORRECTION: D1 now says what the object says, halt reason and all.
    const row = (await db.botInstances.findOne({ id: BOT }))!;
    expect(row.status).toBe("halted");
    expect(row.halt_reason).toBe("manual: seeded");
    expect(row.halted_at).toBe(T0 - 60_000);

    // THE PIN: the object was not touched in either direction.
    expect(halted).toEqual([]);
    expect(snapshots.get(BOT)!.state.status).toBe("halted");
    // Minor tier: auto-corrected, logged, and NO alert row (section 9).
    expect(await alertsFor(BOT)).toHaveLength(0);
    expect(second.autoCorrections.join(" ")).toMatch(/corrected from it/);
  });

  /**
   * THE STRUCTURAL HALF of the same pin, and the reason it is a source scan.
   *
   * The runtime assertion above can only say that no resume happened on THIS
   * run. It cannot say that resuming is impossible, because the thing that
   * makes it impossible is an ABSENCE -- `ReconciliationPorts` has no resume
   * port and `reconcile.ts` never calls one. An absence is exactly what a
   * behavioural test cannot pin: adding `resume` to the ports and calling it
   * would break no test above, and "reconciliation may put a bot back to
   * trading because a mirror said so" is the one property in this module worth
   * failing a build over. So it is checked mechanically, in the shape
   * `no-raw-d1.test.ts` established.
   */
  it("gives reconciliation no way to resume a bot at all", () => {
    const source = SOURCES["/src/reconciliation/reconcile.ts"]!.default;
    expect(source).not.toMatch(/\.resume\s*\(/);
    expect(source).not.toMatch(/\bresumeBot\b/);

    // And the port surface itself offers nothing to call.
    const portsSource = source.slice(
      source.indexOf("export interface ReconciliationPorts"),
      source.indexOf("interface PendingFinding"),
    );
    expect(portsSource.length).toBeGreaterThan(0);
    expect(portsSource).not.toMatch(/resume/i);
  });
});

// ===========================================================================
// TEST 6 -- position safety, against a REAL BotInstance
// ===========================================================================

describe("halting a live object that D1 had hidden", () => {
  /**
   * Driven through a REAL `BotInstance` and its real `#halt`, not the fake
   * port, because the claim under test is about what halting actually DOES to
   * a bot holding something: cancel the resting orders, keep the position, and
   * never liquidate. A fake halt port could not show any of that.
   */
  it("cancels the resting order, preserves the position, and sells nothing", async () => {
    const objectName = `real-status-drift-${Date.now()}`;
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

    // The ledger has to exist BEFORE `create`, which allocates against it.
    await seedPlaceholderTotalBalance(
      db,
      { accountLabel: ACCOUNT, asset: "USDT", totalBalance: m("5000"), note: "test fixture" },
      { actor: ACTOR, now: T0 },
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

    // A real bot with a real filled position AND a real resting order.
    await inBot(objectName, async (bot) => {
      attach(bot as BotInstance);
      await (bot as BotInstance).create({
        botInstanceId: BOT,
        accountLabel: ACCOUNT,
        exchange: "binance",
        pair: TEST_PAIR,
        capitalAsset: "USDT",
        allocatedCapital: m("400"),
        params,
        actor: ACTOR,
      });
      await (bot as BotInstance).start(ACTOR);
      await (bot as BotInstance).onPriceUpdate({ pair: TEST_PAIR, price: m("100"), at: clock });
      const base = exchange.placed[0]!.clientOrderId;
      await (bot as BotInstance).onFill(base, exchange.fillFor(base));
      // A 6% drop triggers the additional buy, which rests unfilled.
      await (bot as BotInstance).onPriceUpdate({ pair: TEST_PAIR, price: m("94"), at: clock });
    });

    const before = await inBot(objectName, async (bot) => {
      attach(bot as BotInstance);
      return await (bot as BotInstance).snapshot();
    });
    expect(before.state.status).toBe("running");
    expect(before.state.position.quantity).not.toBe(ZERO);
    expect(before.state.openOrderIds).toHaveLength(1);
    const placedBeforeHalt = exchange.placed.length;

    // THE SPLIT-BRAIN, written directly into the row: the object is live and
    // holding, and D1 says it is halted. This is bot-gvtr1a's shape.
    await db.botInstances.update(
      { id: BOT },
      { status: "halted", halt_reason: "manual: interrupted resume", halted_at: T0 - 60_000 },
    );

    const realPorts = ports({
      snapshotBot: async () =>
        await inBot(objectName, async (bot) => {
          attach(bot as BotInstance);
          return await (bot as BotInstance).snapshotIfCreated();
        }),
      haltBot: async (botInstanceId, detail) => {
        halted.push({ botInstanceId, detail });
        await inBot(objectName, async (bot) => {
          attach(bot as BotInstance);
          await (bot as BotInstance).halt("manual", detail, "reconciliation");
        });
      },
    });

    await reconcileAccount(realPorts, ACCOUNT);
    await reconcileAccount(realPorts, ACCOUNT);

    expect(halted).toHaveLength(1);

    const after = await inBot(objectName, async (bot) => {
      attach(bot as BotInstance);
      return await (bot as BotInstance).snapshot();
    });

    // Halted, and the two stores agree again.
    expect(after.state.status).toBe("halted");
    expect(await rowStatus()).toBe("halted");
    // The resting order was CANCELLED.
    expect(exchange.cancelled).toContain(before.state.openOrderIds[0]);
    expect(after.state.openOrderIds).toHaveLength(0);
    // THE POSITION IS PRESERVED, to the satoshi.
    expect(after.state.position.quantity).toBe(before.state.position.quantity);
    expect(after.state.position.cost).toBe(before.state.position.cost);
    // AND NOTHING WAS SOLD. A halt is not a liquidation; the position is left
    // for a human to decide on.
    expect(exchange.placed).toHaveLength(placedBeforeHalt);
    expect(exchange.placed.some((order) => order.side === "sell")).toBe(false);
  });
});

// ===========================================================================
// TEST 7 -- idempotence
// ===========================================================================

describe("after a correction", () => {
  it("the next pass finds nothing", async () => {
    await seedAccount("running", "halted");

    await reconcileAccount(ports(), ACCOUNT);
    const corrected = await reconcileAccount(ports(), ACCOUNT);
    expect(corrected.findings.some((f) => f.kind === "bot_status_mirror_stale")).toBe(true);

    const third = await reconcileAccount(ports(), ACCOUNT);

    expect(third.findings.some((f) => f.kind.startsWith("bot_status_"))).toBe(false);
    expect(third.autoCorrections).toEqual([]);
    expect(halted).toEqual([]);
    expect(await alertsFor(BOT)).toHaveLength(0);
  });

  it("the next pass finds nothing after a confirmed halt either", async () => {
    await seedAccount("halted", "running");

    await reconcileAccount(ports(), ACCOUNT);
    await reconcileAccount(ports(), ACCOUNT);
    expect(halted).toHaveLength(1);

    const third = await reconcileAccount(ports(), ACCOUNT);

    expect(third.findings.some((f) => f.kind.startsWith("bot_status_"))).toBe(false);
    // Still exactly one halt: a converged bot is not re-halted every five
    // minutes forever.
    expect(halted).toHaveLength(1);
  });
});
