/**
 * The reconciliation pass (spec section 9), end to end.
 *
 * Real D1 in the Workers runtime, with the exchange mocked, per section 14.
 * The Durable Objects are supplied through the `snapshotBot` / `haltBot` ports
 * for most tests -- which is what those ports are for -- and one test at the
 * bottom drives a REAL `BotInstance` through the real halt path, so the wiring
 * between the two is not only asserted in a fake.
 *
 * The three tiers of section 9 each get their own describe block, and each
 * asserts the ACTION, not just the classification:
 *
 *   minor      -> auto-corrected, logged, and NO alert row written
 *   meaningful -> that one bot halted, alert written, nothing auto-corrected
 *   severe     -> circuit breaker tripped, EVERY bot on the account halted
 */

import { beforeEach, describe, expect, it } from "vitest";

import { readCircuitBreaker } from "./circuit-breaker";
import { reconcileAccount, type ReconciliationPorts } from "./reconcile";
import type { Database } from "../db/database";
import type { AlertRow } from "../db/schema";
import {
  alertRow,
  botInstanceRow,
  capitalLedgerRow,
  freshDatabase,
  manualAdjustmentRow,
  orderRow,
  tradeRow,
} from "../db/test-helpers";
import type { BotRuntimeState, BotSnapshot } from "../durable-objects/bot-instance";
import { FakeExchange, TEST_PAIR } from "../durable-objects/fake-exchange";
import { inBot } from "../durable-objects/test-helpers";
import { fromDecimalString as m, ZERO } from "../shared/money";
import type { TrackedOrder } from "../shared/order-state";
import { DCA_SCHEMA_VERSION, EMPTY_POSITION, type DcaParams } from "../strategies/dca";

const T0 = 1_770_000_000_000;
const ACCOUNT = "main";

let db: Database;
let exchange: FakeExchange;
let clock: number;
let ids: number;
let halted: { botInstanceId: string; detail: string }[];
let snapshots: Map<string, BotSnapshot>;
/** Bots whose halt port should throw, to test the failure path. */
let unhaltable: Set<string>;

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
  unhaltable = new Set();
});

function ports(overrides: Partial<ReconciliationPorts> = {}): ReconciliationPorts {
  return {
    db,
    exchange,
    now: () => clock,
    newId: () => `id-${(ids += 1)}`,
    haltBot: async (botInstanceId, detail) => {
      if (unhaltable.has(botInstanceId)) throw new Error("object unreachable");
      halted.push({ botInstanceId, detail });
      await db.botInstances.update(
        { id: botInstanceId, status: { ne: "stopped" } },
        { status: "halted", halt_reason: detail, halted_at: clock, updated_at: clock },
      );
    },
    snapshotBot: async (botInstanceId) => snapshots.get(botInstanceId) ?? null,
    ...overrides,
  };
}

function trackedOrder(overrides: Partial<TrackedOrder> = {}): TrackedOrder {
  return {
    clientOrderId: "v1-dca-btc-1-0",
    pair: TEST_PAIR,
    side: "buy",
    price: m("65000"),
    quantity: m("0.01"),
    filledQuantity: ZERO,
    state: "pending",
    fills: [],
    createdAt: T0 - 600_000,
    updatedAt: T0 - 600_000,
    ...overrides,
  };
}

function snapshotFor(
  botInstanceId: string,
  orders: TrackedOrder[] = [],
  state: Partial<BotRuntimeState> = {},
): BotSnapshot {
  return {
    config: {
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
    orders,
  };
}

/** A bot row plus its ledger row, so allocations reconcile cleanly by default. */
async function seedBot(id: string, allocated = m("400")): Promise<void> {
  await db.botInstances.insert(
    botInstanceRow({ id, account_label: ACCOUNT, status: "running", allocated_capital: allocated }),
  );
}

async function seedLedger(totalAllocated: string, totalBalance = "5000"): Promise<void> {
  await db.capitalLedger.insert(
    capitalLedgerRow({
      id: "cl-main-usdt",
      account_label: ACCOUNT,
      asset: "USDT",
      total_balance: m(totalBalance),
      total_allocated: m(totalAllocated),
    }),
  );
}

/** Establish a balance baseline, so the next run measures a delta from it. */
async function seedBaseline(asset: string, balance: string, at = T0 - 300_000): Promise<void> {
  await db.balanceSnapshots.insert({
    id: `bs-${asset}-${at}`,
    reconciliation_run_id: "run-0",
    account_label: ACCOUNT,
    asset,
    exchange_reported_balance: m(balance),
    internal_calculated_balance: m(balance),
    discrepancy: ZERO,
    classification: null,
    checked_at: at,
  });
}

async function alerts(where: Partial<AlertRow> = {}): Promise<AlertRow[]> {
  return await db.alerts.findMany({ where, orderBy: [{ column: "created_at", direction: "asc" }] });
}

// ===========================================================================
// A clean run
// ===========================================================================

describe("a clean run", () => {
  it("finds nothing, alerts nothing, and leaves classification NULL", async () => {
    await seedBot("dca-btc-1");
    await seedLedger("400");
    await seedBaseline("USDT", "5000");
    exchange.balances = [{ asset: "USDT", free: m("5000"), locked: ZERO }];
    snapshots.set("dca-btc-1", snapshotFor("dca-btc-1"));

    const result = await reconcileAccount(ports(), ACCOUNT);

    expect(result.findings).toEqual([]);
    expect(result.tier).toBeNull();
    expect(result.haltedBotIds).toEqual([]);
    expect(result.circuitBreakerTripped).toBe(false);
    expect(await alerts()).toEqual([]);

    // Step 4's open question 3, confirmed rather than changed: NULL keeps
    // meaning "this run found no drift to classify".
    const snapshotRows = await db.balanceSnapshots.findMany({
      where: { reconciliation_run_id: result.runId },
    });
    expect(snapshotRows).toHaveLength(1);
    expect(snapshotRows[0]!.classification).toBeNull();
    expect(snapshotRows[0]!.discrepancy).toBe(ZERO);
  });

  it("adopts the exchange balance on the very first run instead of accusing", async () => {
    // No prior snapshot. The placeholder ledger balance is deliberately wrong.
    await seedBot("dca-btc-1");
    await seedLedger("400", "1");
    exchange.balances = [{ asset: "USDT", free: m("5000"), locked: ZERO }];
    snapshots.set("dca-btc-1", snapshotFor("dca-btc-1"));

    const result = await reconcileAccount(ports(), ACCOUNT);

    // Without adoption this would be a 4999 discrepancy on a 5000 balance --
    // severe, on run one, on every account, forever.
    expect(result.tier).toBeNull();
    expect(result.circuitBreakerTripped).toBe(false);
    const rows = await db.balanceSnapshots.findMany({
      where: { reconciliation_run_id: result.runId },
    });
    expect(rows[0]!.discrepancy).toBe(ZERO);
    expect(rows[0]!.exchange_reported_balance).toBe(m("5000"));
    expect(rows[0]!.classification).toBe("minor");
  });

  it("writes total_balance into the ledger, giving step 5's placeholder a real source", async () => {
    await seedLedger("0", "1");
    exchange.balances = [{ asset: "USDT", free: m("4321.5"), locked: m("100") }];

    await reconcileAccount(ports(), ACCOUNT);

    const ledger = await db.capitalLedger.findOne({ account_label: ACCOUNT, asset: "USDT" });
    // free + locked: capital reserved against an open order is still the
    // account's money.
    expect(ledger!.total_balance).toBe(m("4421.5"));
  });
});

// ===========================================================================
// TIER 1: minor drift -> auto-correct, log, NO alert
// ===========================================================================

describe("minor drift", () => {
  it("auto-corrects a lagging D1 mirror and writes no alert", async () => {
    await seedBot("dca-btc-1");
    await seedLedger("400");
    await seedBaseline("USDT", "5000");
    exchange.balances = [{ asset: "USDT", free: m("5000"), locked: ZERO }];

    // The object knows the order is filled; D1 still says pending. This is the
    // exact residue of step 6's write ordering (object storage first, D1
    // second) after a crash in the gap.
    const order = trackedOrder({ state: "filled", filledQuantity: m("0.01") });
    snapshots.set("dca-btc-1", snapshotFor("dca-btc-1", [order]));
    await db.orders.insert(
      orderRow({
        id: order.clientOrderId,
        bot_instance_id: "dca-btc-1",
        client_order_id: order.clientOrderId,
        price: order.price,
        quantity: order.quantity,
        filled_quantity: ZERO,
        status: "pending",
      }),
    );

    const result = await reconcileAccount(ports(), ACCOUNT);

    expect(result.tier).toBe("minor");
    expect(result.findings[0]!.kind).toBe("mirror_drift");

    // The action: corrected.
    const corrected = await db.orders.findOne({ id: order.clientOrderId });
    expect(corrected!.status).toBe("filled");
    expect(corrected!.filled_quantity).toBe(m("0.01"));
    expect(result.autoCorrections).toHaveLength(1);

    // The action: NOT alerted. Section 9 is explicit that minor drift is
    // logged and does not alert.
    expect(await alerts()).toEqual([]);

    // The action: NOT halted.
    expect(result.haltedBotIds).toEqual([]);
    expect((await db.botInstances.findOne({ id: "dca-btc-1" }))!.status).toBe("running");
  });

  it("logs the correction to audit_log, since that is the only record of it", async () => {
    await seedBot("dca-btc-1");
    await seedLedger("400");
    const order = trackedOrder({ state: "filled", filledQuantity: m("0.01") });
    snapshots.set("dca-btc-1", snapshotFor("dca-btc-1", [order]));
    await db.orders.insert(
      orderRow({
        id: order.clientOrderId,
        bot_instance_id: "dca-btc-1",
        client_order_id: order.clientOrderId,
        price: order.price,
        quantity: order.quantity,
        filled_quantity: ZERO,
        status: "pending",
      }),
    );

    const result = await reconcileAccount(ports(), ACCOUNT);
    const audits = await db.auditLog.findMany({ where: { action: "reconciliation.run" } });
    expect(audits).toHaveLength(1);
    const details = JSON.stringify(audits[0]!.details_json);
    expect(details).toContain("mirror_drift");
    expect(details).toContain(result.runId);
  });

  it("treats an order that left the book inside the timing window as a late fill", async () => {
    await seedBot("dca-btc-1");
    await seedLedger("400");
    await seedBaseline("USDT", "5000");
    exchange.balances = [{ asset: "USDT", free: m("5000"), locked: ZERO }];

    // Placed, then filled 5 seconds ago -- well inside the 60s window.
    await exchange.placeOrder({
      pair: TEST_PAIR,
      clientOrderId: "v1-dca-btc-1-0",
      side: "buy",
      type: "limit",
      price: m("65000"),
      quantity: m("0.01"),
    });
    exchange.fillFor("v1-dca-btc-1-0");
    exchange.now = T0 - 5_000;

    const order = trackedOrder();
    snapshots.set(
      "dca-btc-1",
      snapshotFor("dca-btc-1", [order], { openOrderIds: [order.clientOrderId] }),
    );
    await db.orders.insert(
      orderRow({
        id: order.clientOrderId,
        bot_instance_id: "dca-btc-1",
        client_order_id: order.clientOrderId,
        price: order.price,
        quantity: order.quantity,
        filled_quantity: ZERO,
        status: "pending",
      }),
    );

    const result = await reconcileAccount(ports(), ACCOUNT);

    const finding = result.findings.find((entry) => entry.kind === "order_recently_terminated");
    expect(finding).toBeDefined();
    expect(finding!.tier).toBe("minor");
    expect(result.haltedBotIds).toEqual([]);
  });

  it("does NOT treat the same order as minor once it is outside the window", async () => {
    await seedBot("dca-btc-1");
    await seedLedger("400");
    await seedBaseline("USDT", "5000");
    exchange.balances = [{ asset: "USDT", free: m("5000"), locked: ZERO }];

    await exchange.placeOrder({
      pair: TEST_PAIR,
      clientOrderId: "v1-dca-btc-1-0",
      side: "buy",
      type: "limit",
      price: m("65000"),
      quantity: m("0.01"),
    });
    exchange.fillFor("v1-dca-btc-1-0");
    // Ten minutes ago: the bot should have recorded it long since.
    exchange.now = T0 - 600_000;

    const order = trackedOrder();
    snapshots.set(
      "dca-btc-1",
      snapshotFor("dca-btc-1", [order], { openOrderIds: [order.clientOrderId] }),
    );
    await db.orders.insert(
      orderRow({
        id: order.clientOrderId,
        bot_instance_id: "dca-btc-1",
        client_order_id: order.clientOrderId,
        price: order.price,
        quantity: order.quantity,
        filled_quantity: ZERO,
        status: "pending",
      }),
    );

    const result = await reconcileAccount(ports(), ACCOUNT);

    expect(result.findings.some((entry) => entry.kind === "order_state_drift")).toBe(true);
    expect(result.tier).toBe("meaningful");
    expect(result.haltedBotIds).toEqual(["dca-btc-1"]);
  });
});

// ===========================================================================
// TIER 2: meaningful drift -> halt THAT bot only, alert, no auto-correct
// ===========================================================================

describe("meaningful drift", () => {
  beforeEach(async () => {
    await seedBot("dca-btc-1");
    await seedBot("dca-eth-1");
    await seedLedger("800");
    await seedBaseline("USDT", "5000");
    exchange.balances = [{ asset: "USDT", free: m("5000"), locked: ZERO }];
    snapshots.set("dca-eth-1", snapshotFor("dca-eth-1"));
  });

  it("halts only the affected bot, and alerts", async () => {
    // The exchange says half filled; the bot believes nothing has filled.
    await exchange.placeOrder({
      pair: TEST_PAIR,
      clientOrderId: "v1-dca-btc-1-0",
      side: "buy",
      type: "limit",
      price: m("65000"),
      quantity: m("0.01"),
    });
    exchange.fillFor("v1-dca-btc-1-0", { quantity: m("0.005") });

    const order = trackedOrder();
    snapshots.set(
      "dca-btc-1",
      snapshotFor("dca-btc-1", [order], { openOrderIds: [order.clientOrderId] }),
    );
    await db.orders.insert(
      orderRow({
        id: order.clientOrderId,
        bot_instance_id: "dca-btc-1",
        client_order_id: order.clientOrderId,
        price: order.price,
        quantity: order.quantity,
        filled_quantity: ZERO,
        status: "pending",
      }),
    );

    const result = await reconcileAccount(ports(), ACCOUNT);

    expect(result.tier).toBe("meaningful");
    // The action: THAT bot only.
    expect(result.haltedBotIds).toEqual(["dca-btc-1"]);
    expect(halted.map((entry) => entry.botInstanceId)).toEqual(["dca-btc-1"]);
    expect((await db.botInstances.findOne({ id: "dca-btc-1" }))!.status).toBe("halted");
    expect((await db.botInstances.findOne({ id: "dca-eth-1" }))!.status).toBe("running");

    // The action: alerted.
    const raised = await alerts();
    expect(raised).toHaveLength(1);
    expect(raised[0]!.severity).toBe("critical");
    expect(raised[0]!.alert_type).toBe("reconciliation_meaningful_order_state_drift");
    expect(raised[0]!.bot_instance_id).toBe("dca-btc-1");
    expect(raised[0]!.source).toBe("reconciliation");

    // The action: NOT auto-corrected. Section 9 says so explicitly.
    expect(result.autoCorrections).toEqual([]);
    expect((await db.orders.findOne({ id: order.clientOrderId }))!.filled_quantity).toBe(ZERO);

    // The action: the circuit breaker is NOT tripped.
    expect(result.circuitBreakerTripped).toBe(false);
    expect(await readCircuitBreaker(db, ACCOUNT)).toBeNull();
  });

  it("classifies a balance residual between the two thresholds as meaningful", async () => {
    // 5000 expected, 4950 present: 1.01% of the balance. Above the 0.1%
    // noise floor, below the 2% that latches the account.
    exchange.balances = [{ asset: "USDT", free: m("4950"), locked: ZERO }];
    snapshots.set("dca-btc-1", snapshotFor("dca-btc-1"));

    const result = await reconcileAccount(ports(), ACCOUNT);

    const finding = result.findings.find((entry) => entry.kind === "balance_drift");
    expect(finding!.floor).toBe("minor");
    expect(finding!.tier).toBe("meaningful");
    expect(finding!.escalated).toBe(true);

    // Account-scoped, so it alerts and halts nothing. Halting everything is
    // what the severe tier is for.
    expect(result.circuitBreakerTripped).toBe(false);
    expect(result.haltedBotIds).toEqual([]);
    expect((await alerts())[0]!.alert_type).toBe("reconciliation_meaningful_balance_drift");

    const rows = await db.balanceSnapshots.findMany({
      where: { reconciliation_run_id: result.runId },
    });
    expect(rows[0]!.classification).toBe("meaningful");
  });

  it("alerts but halts nothing when the finding belongs to no single bot", async () => {
    // A leaked reservation: step 5's open question 2. Halting every bot for a
    // bookkeeping mismatch would be wrong; that is what severe is for.
    await db.capitalLedger.update(
      { account_label: ACCOUNT, asset: "USDT" },
      { total_allocated: m("900"), updated_at: T0 },
    );
    snapshots.set("dca-btc-1", snapshotFor("dca-btc-1"));

    const result = await reconcileAccount(ports(), ACCOUNT);

    const finding = result.findings.find((entry) => entry.kind === "ledger_allocation_drift");
    expect(finding).toBeDefined();
    expect(finding!.tier).toBe("meaningful");
    expect(result.haltedBotIds).toEqual([]);
    expect((await alerts())[0]!.alert_type).toBe(
      "reconciliation_meaningful_ledger_allocation_drift",
    );
  });

  it("raises a system alert and does not consume the source when the halt fails", async () => {
    unhaltable.add("dca-btc-1");
    const sourceAlert = alertRow({
      id: "alert-src",
      alert_type: "cancel_fill_discrepancy",
      severity: "warning",
      bot_instance_id: "dca-btc-1",
      message: "cancelled with more filled than recorded",
      created_at: T0 - 1000,
    });
    await db.alerts.insert(sourceAlert);
    snapshots.set("dca-btc-1", snapshotFor("dca-btc-1"));

    const result = await reconcileAccount(ports(), ACCOUNT);

    expect(result.consumedAlertIds).not.toContain("alert-src");
    // Left unresolved on purpose: the tier's action did not happen, so the
    // next run must find it again.
    expect((await db.alerts.findOne({ id: "alert-src" }))!.resolved).toBe(false);
    const failure = (await alerts()).find(
      (entry) => entry.alert_type === "reconciliation_halt_failed",
    );
    expect(failure).toBeDefined();
    expect(failure!.category).toBe("system");
  });
});

// ===========================================================================
// TIER 3: severe drift -> trip the breaker, halt EVERYTHING, alert immediately
// ===========================================================================

describe("severe drift", () => {
  beforeEach(async () => {
    await seedBot("dca-btc-1");
    await seedBot("dca-eth-1");
    await seedLedger("800");
    await seedBaseline("USDT", "5000");
    snapshots.set("dca-btc-1", snapshotFor("dca-btc-1"));
    snapshots.set("dca-eth-1", snapshotFor("dca-eth-1"));
  });

  it("trips the breaker on an order this system never placed, at any size", async () => {
    exchange.balances = [{ asset: "USDT", free: m("5000"), locked: ZERO }];
    // A tiny order, so this cannot be passing because of a magnitude rule.
    exchange.injectForeignOrder({
      pair: TEST_PAIR,
      clientOrderId: "not-our-scheme-at-all",
      side: "sell",
      type: "limit",
      price: m("70000"),
      quantity: m("0.00001"),
    });

    const result = await reconcileAccount(ports(), ACCOUNT);

    expect(result.tier).toBe("severe");
    expect(result.findings.some((entry) => entry.kind === "unknown_open_order")).toBe(true);

    // The action: the breaker is tripped and latched.
    expect(result.circuitBreakerTripped).toBe(true);
    const breaker = await readCircuitBreaker(db, ACCOUNT);
    expect(breaker!.state).toBe("tripped");
    expect(breaker!.run_id).toBe(result.runId);
    expect(breaker!.tripped_by).toBe("reconciliation");

    // The action: EVERYTHING on the account halted, not just one bot.
    expect([...result.haltedBotIds].sort()).toEqual(["dca-btc-1", "dca-eth-1"]);
    expect((await db.botInstances.findOne({ id: "dca-btc-1" }))!.status).toBe("halted");
    expect((await db.botInstances.findOne({ id: "dca-eth-1" }))!.status).toBe("halted");

    // The action: alerted immediately, at critical.
    const raised = await alerts();
    expect(raised.some((entry) => entry.alert_type === "circuit_breaker_tripped")).toBe(true);
    expect(raised.every((entry) => entry.severity === "critical")).toBe(true);
  });

  it("trips on an unexplained balance change above severePct", async () => {
    // 5000 expected, 4000 present, no trades and no logged adjustment: 20%.
    exchange.balances = [{ asset: "USDT", free: m("4000"), locked: ZERO }];

    const result = await reconcileAccount(ports(), ACCOUNT);

    const finding = result.findings.find((entry) => entry.kind === "balance_drift");
    expect(finding).toBeDefined();
    expect(finding!.tier).toBe("severe");
    expect(finding!.escalated).toBe(true);
    expect(result.circuitBreakerTripped).toBe(true);
    expect([...result.haltedBotIds].sort()).toEqual(["dca-btc-1", "dca-eth-1"]);

    const snapshotRows = await db.balanceSnapshots.findMany({
      where: { reconciliation_run_id: result.runId },
    });
    expect(snapshotRows[0]!.classification).toBe("severe");
    expect(snapshotRows[0]!.discrepancy).toBe(m("-1000"));
  });

  it("blocks a new bot on the account afterwards, which is what makes it a latch", async () => {
    exchange.balances = [{ asset: "USDT", free: m("4000"), locked: ZERO }];
    await reconcileAccount(ports(), ACCOUNT);

    await expect(
      inBot("latch-check", async (bot) => {
        bot.attach({ db, exchange, now: () => clock, newId: () => "x" });
        return await bot.create({
          botInstanceId: "dca-new-1",
          accountLabel: ACCOUNT,
          exchange: "binance",
          pair: TEST_PAIR,
          capitalAsset: "USDT",
          allocatedCapital: m("400"),
          params,
          actor: "owner@example.com",
        });
      }),
    ).rejects.toThrow(/circuit breaker/i);
  });

  it("does not touch a different account on the same database", async () => {
    await db.botInstances.insert(
      botInstanceRow({ id: "other-1", account_label: "secondary", status: "running" }),
    );
    exchange.balances = [{ asset: "USDT", free: m("4000"), locked: ZERO }];

    await reconcileAccount(ports(), ACCOUNT);

    expect((await db.botInstances.findOne({ id: "other-1" }))!.status).toBe("running");
    expect(await readCircuitBreaker(db, "secondary")).toBeNull();
  });
});

// ===========================================================================
// The delta model: this system's own activity explains its own balance change
// ===========================================================================

describe("expected change from recorded trades", () => {
  beforeEach(async () => {
    await seedBot("dca-btc-1");
    await seedLedger("400");
    await seedBaseline("USDT", "5000");
    await seedBaseline("BTC", "0");
    snapshots.set("dca-btc-1", snapshotFor("dca-btc-1"));
  });

  /** A recorded buy of 0.01 BTC at 65000, so 650 USDT should have left. */
  async function recordBuy(): Promise<void> {
    await db.orders.insert(
      orderRow({
        id: "v1-dca-btc-1-0",
        bot_instance_id: "dca-btc-1",
        client_order_id: "v1-dca-btc-1-0",
        side: "buy",
        price: m("65000"),
        quantity: m("0.01"),
        filled_quantity: m("0.01"),
        status: "filled",
      }),
    );
    await db.trades.insert(
      tradeRow({
        id: "v1-dca-btc-1-0:T1",
        order_id: "v1-dca-btc-1-0",
        bot_instance_id: "dca-btc-1",
        exchange_trade_id: "T1",
        price: m("65000"),
        quantity: m("0.01"),
        fee_amount: ZERO,
        fee_asset: "USDT",
        fee_reporting_amount: null,
        fee_reporting_asset: null,
        fee_conversion_rate: null,
        // Inside the window: after the baseline snapshot.
        executed_at: T0 - 120_000,
      }),
    );
  }

  it("is clean when the exchange moved by exactly what the trades say", async () => {
    await recordBuy();
    exchange.balances = [
      { asset: "USDT", free: m("4350"), locked: ZERO },
      { asset: "BTC", free: m("0.01"), locked: ZERO },
    ];

    const result = await reconcileAccount(ports(), ACCOUNT);

    expect(result.tier).toBeNull();
    expect(result.findings).toEqual([]);
    const rows = await db.balanceSnapshots.findMany({
      where: { reconciliation_run_id: result.runId },
      orderBy: [{ column: "asset", direction: "asc" }],
    });
    // The predicted balance, which is what `internal_calculated_balance` means
    // under the delta model.
    expect(rows.find((row) => row.asset === "USDT")!.internal_calculated_balance).toBe(m("4350"));
    expect(rows.find((row) => row.asset === "BTC")!.internal_calculated_balance).toBe(m("0.01"));
    expect(rows.every((row) => row.discrepancy === ZERO)).toBe(true);
  });

  it("still finds the drift that the trades do NOT explain", async () => {
    await recordBuy();
    // The buy accounts for 650 leaving. Another 1000 left that nothing does.
    exchange.balances = [
      { asset: "USDT", free: m("3350"), locked: ZERO },
      { asset: "BTC", free: m("0.01"), locked: ZERO },
    ];

    const result = await reconcileAccount(ports(), ACCOUNT);

    const finding = result.findings.find((entry) => entry.asset === "USDT");
    expect(finding!.kind).toBe("balance_drift");
    expect(finding!.tier).toBe("severe");
    expect(result.circuitBreakerTripped).toBe(true);

    const rows = await db.balanceSnapshots.findMany({
      where: { reconciliation_run_id: result.runId },
    });
    const usdt = rows.find((row) => row.asset === "USDT")!;
    // Not a plain difference of the two columns: the expected change is
    // subtracted first, which is the whole point of the model.
    expect(usdt.internal_calculated_balance).toBe(m("4350"));
    expect(usdt.discrepancy).toBe(m("-1000"));
  });

  it("stamps each asset's own tier, not the run's worst, onto its snapshot row", async () => {
    await recordBuy();
    // USDT is 1000 short of what the trade explains: severe. BTC is exactly
    // right. The BTC row must not inherit USDT's tier -- it is the record of
    // what was found for BTC.
    exchange.balances = [
      { asset: "USDT", free: m("3350"), locked: ZERO },
      { asset: "BTC", free: m("0.01"), locked: ZERO },
    ];

    const result = await reconcileAccount(ports(), ACCOUNT);

    const rows = await db.balanceSnapshots.findMany({
      where: { reconciliation_run_id: result.runId },
    });
    expect(rows.find((row) => row.asset === "USDT")!.classification).toBe("severe");
    expect(rows.find((row) => row.asset === "BTC")!.classification).toBeNull();
  });

  it("declines to conclude anything when a pair's assets cannot be attributed", async () => {
    await recordBuy();
    // Without symbol filters there is no way to know which assets the trade
    // moved, so the expected change is unknown. Slicing "BTCUSDT" into BTC and
    // USDT is exactly what step 5's decision 1 refused to do.
    exchange.filtersFailure = { kind: "transport", message: "timeout" };
    exchange.balances = [{ asset: "USDT", free: m("3350"), locked: ZERO }];

    const result = await reconcileAccount(ports(), ACCOUNT);

    expect(result.findings.some((entry) => entry.kind === "balance_drift")).toBe(false);
    expect(result.circuitBreakerTripped).toBe(false);
    expect(result.skipped.some((entry) => entry.includes("attributed"))).toBe(true);
  });
});

// ===========================================================================
// Section 8.6: manual adjustments
// ===========================================================================

describe("manual adjustments (section 8.6)", () => {
  beforeEach(async () => {
    await seedBot("dca-btc-1");
    await seedLedger("400");
    await seedBaseline("USDT", "5000");
    snapshots.set("dca-btc-1", snapshotFor("dca-btc-1"));
  });

  it("subtracts a logged withdrawal, so it is not drift at all", async () => {
    // The owner moved 1000 out by hand and logged it. Without the subtraction
    // this is a 20% unexplained drop -- severe, and the breaker would trip.
    await db.manualAdjustments.insert(
      manualAdjustmentRow({
        id: "ma-withdrawal",
        account_label: ACCOUNT,
        asset: "USDT",
        amount: m("-1000"),
        note: "moved to cold storage",
        created_at: T0 - 100_000,
      }),
    );
    exchange.balances = [{ asset: "USDT", free: m("4000"), locked: ZERO }];

    const result = await reconcileAccount(ports(), ACCOUNT);

    expect(result.tier).toBeNull();
    expect(result.circuitBreakerTripped).toBe(false);
    expect(await alerts()).toEqual([]);
    const rows = await db.balanceSnapshots.findMany({
      where: { reconciliation_run_id: result.runId },
    });
    expect(rows[0]!.discrepancy).toBe(ZERO);
  });

  it("marks the adjustment reconciled, so the next run does not subtract it twice", async () => {
    await db.manualAdjustments.insert(
      manualAdjustmentRow({
        id: "ma-withdrawal",
        account_label: ACCOUNT,
        asset: "USDT",
        amount: m("-1000"),
        note: "moved to cold storage",
        created_at: T0 - 100_000,
      }),
    );
    exchange.balances = [{ asset: "USDT", free: m("4000"), locked: ZERO }];

    await reconcileAccount(ports(), ACCOUNT);
    expect((await db.manualAdjustments.findOne({ id: "ma-withdrawal" }))!.reconciled_at).toBe(T0);

    // Second run, five minutes later, nothing further changed. If the
    // adjustment were subtracted again the maths would report +1000 of
    // unexplained gain -- migration 0001's note calls this a spec bug in
    // section 8.6, and reconciled_at is the fix.
    clock = T0 + 300_000;
    exchange.now = clock;
    const second = await reconcileAccount(ports(), ACCOUNT);
    expect(second.tier).toBeNull();
    expect(second.findings).toEqual([]);
  });

  it("only consumes adjustments for the account and asset it is reconciling", async () => {
    await db.manualAdjustments.insert(
      manualAdjustmentRow({
        id: "ma-other-account",
        account_label: "secondary",
        asset: "USDT",
        amount: m("-1000"),
        created_at: T0 - 100_000,
      }),
    );
    exchange.balances = [{ asset: "USDT", free: m("5000"), locked: ZERO }];

    await reconcileAccount(ports(), ACCOUNT);

    expect(
      (await db.manualAdjustments.findOne({ id: "ma-other-account" }))!.reconciled_at,
    ).toBeNull();
  });
});

// ===========================================================================
// Closing step 6's loop
// ===========================================================================

describe("the three alert paths step 6 writes", () => {
  beforeEach(async () => {
    await seedBot("dca-btc-1");
    await seedLedger("400");
    await seedBaseline("USDT", "5000");
    exchange.balances = [{ asset: "USDT", free: m("5000"), locked: ZERO }];
    snapshots.set("dca-btc-1", snapshotFor("dca-btc-1"));
  });

  it("acts on an unresolved cancel_fill_discrepancy by halting the bot", async () => {
    await db.alerts.insert(
      alertRow({
        id: "alert-cancel-race",
        alert_type: "cancel_fill_discrepancy",
        severity: "warning",
        category: "trading",
        bot_instance_id: "dca-btc-1",
        message: "cancelled with 0.005 filled, bot recorded 0.001",
        created_at: T0 - 1000,
      }),
    );

    const result = await reconcileAccount(ports(), ACCOUNT);

    expect(result.tier).toBe("meaningful");
    expect(result.haltedBotIds).toEqual(["dca-btc-1"]);
    // The loop is closed: the alert is now resolved, by this run.
    expect(result.consumedAlertIds).toContain("alert-cancel-race");
    expect((await db.alerts.findOne({ id: "alert-cancel-race" }))!.resolved).toBe(true);
  });

  it("acts on an unresolved order_state_drift by halting the bot", async () => {
    await db.alerts.insert(
      alertRow({
        id: "alert-state-drift",
        alert_type: "order_state_drift",
        severity: "critical",
        bot_instance_id: "dca-btc-1",
        message: "overfill on v1-dca-btc-1-2",
        created_at: T0 - 1000,
      }),
    );

    const result = await reconcileAccount(ports(), ACCOUNT);

    expect(result.tier).toBe("meaningful");
    expect(result.haltedBotIds).toEqual(["dca-btc-1"]);
    expect((await db.alerts.findOne({ id: "alert-state-drift" }))!.resolved).toBe(true);
  });

  it("escalates an unresolved unknown_order_fill to severe and trips the breaker", async () => {
    // Section 9 lists "unexpected orders" under severe. A fill against an
    // order no bot recorded placing is the strongest form of that.
    await db.alerts.insert(
      alertRow({
        id: "alert-unknown-fill",
        alert_type: "unknown_order_fill",
        severity: "critical",
        bot_instance_id: "dca-btc-1",
        message: "fill T99 arrived for v1-ghost-0, which this bot never placed",
        created_at: T0 - 1000,
      }),
    );

    const result = await reconcileAccount(ports(), ACCOUNT);

    expect(result.tier).toBe("severe");
    expect(result.circuitBreakerTripped).toBe(true);
    expect((await readCircuitBreaker(db, ACCOUNT))!.state).toBe("tripped");
    expect((await db.alerts.findOne({ id: "alert-unknown-fill" }))!.resolved).toBe(true);
  });

  it("acts on cancel_failed, the fourth path, by halting the bot", async () => {
    await db.alerts.insert(
      alertRow({
        id: "alert-cancel-failed",
        alert_type: "cancel_failed",
        severity: "critical",
        bot_instance_id: "dca-btc-1",
        message: "could not confirm cancellation of v1-dca-btc-1-1 during a halt",
        created_at: T0 - 1000,
      }),
    );

    const result = await reconcileAccount(ports(), ACCOUNT);
    expect(result.haltedBotIds).toEqual(["dca-btc-1"]);
    expect((await db.alerts.findOne({ id: "alert-cancel-failed" }))!.resolved).toBe(true);
  });

  it("ignores an alert that is already resolved, so one event is acted on once", async () => {
    await db.alerts.insert(
      alertRow({
        id: "alert-done",
        alert_type: "cancel_fill_discrepancy",
        bot_instance_id: "dca-btc-1",
        resolved: true,
        created_at: T0 - 1000,
      }),
    );

    const result = await reconcileAccount(ports(), ACCOUNT);
    expect(result.findings).toEqual([]);
    expect(result.haltedBotIds).toEqual([]);
  });

  it("ignores alert types it does not own, such as a routine take_profit", async () => {
    await db.alerts.insert(
      alertRow({
        id: "alert-tp",
        alert_type: "take_profit",
        severity: "info",
        bot_instance_id: "dca-btc-1",
        created_at: T0 - 1000,
      }),
    );

    const result = await reconcileAccount(ports(), ACCOUNT);
    expect(result.findings).toEqual([]);
    expect((await db.alerts.findOne({ id: "alert-tp" }))!.resolved).toBe(false);
  });
});

// ===========================================================================
// Section 5.6: an unreachable exchange is not data
// ===========================================================================

describe("when the exchange cannot be reached", () => {
  beforeEach(async () => {
    await seedBot("dca-btc-1");
    await seedLedger("400");
    await seedBaseline("USDT", "5000");
  });

  it("writes no balance snapshot rather than recording the balance as unchanged", async () => {
    exchange.balancesFailure = { kind: "transport", message: "connection reset" };
    snapshots.set("dca-btc-1", snapshotFor("dca-btc-1"));

    const result = await reconcileAccount(ports(), ACCOUNT);

    expect(result.tier).toBeNull();
    expect(result.circuitBreakerTripped).toBe(false);
    expect(result.skipped.some((entry) => entry.includes("account balances"))).toBe(true);
    // Nothing written, so the NEXT run still measures its delta from the last
    // real observation rather than from a fiction.
    const rows = await db.balanceSnapshots.findMany({
      where: { reconciliation_run_id: result.runId },
    });
    expect(rows).toEqual([]);
  });

  it("does not conclude an order vanished when open orders could not be read", async () => {
    exchange.openOrdersFailure = { kind: "transport", message: "504" };
    exchange.balances = [{ asset: "USDT", free: m("5000"), locked: ZERO }];
    const order = trackedOrder();
    snapshots.set(
      "dca-btc-1",
      snapshotFor("dca-btc-1", [order], { openOrderIds: [order.clientOrderId] }),
    );
    await db.orders.insert(
      orderRow({
        id: order.clientOrderId,
        bot_instance_id: "dca-btc-1",
        client_order_id: order.clientOrderId,
        price: order.price,
        quantity: order.quantity,
        filled_quantity: ZERO,
        status: "pending",
      }),
    );

    const result = await reconcileAccount(ports(), ACCOUNT);

    // Concluding "not in the open orders list, therefore gone" from a failed
    // request would halt every bot on the pair on any transient 504.
    expect(result.haltedBotIds).toEqual([]);
    expect(result.skipped.some((entry) => entry.includes("open orders"))).toBe(true);
  });

  it("reports an orphaned bot row as a system alert, not as a drift tier", async () => {
    exchange.balances = [{ asset: "USDT", free: m("5000"), locked: ZERO }];
    // No snapshot registered: step 6's open question 6.
    const result = await reconcileAccount(ports(), ACCOUNT);

    expect(result.tier).toBeNull();
    const raised = await alerts();
    expect(raised).toHaveLength(1);
    expect(raised[0]!.alert_type).toBe("orphaned_bot_row");
    expect(raised[0]!.category).toBe("system");
  });
});

// ===========================================================================
// Against a real Durable Object
// ===========================================================================

describe("against a real BotInstance", () => {
  it("halts it through its own section 7.2 path, not through a fake", async () => {
    await seedLedger("0");
    await seedBaseline("USDT", "5000");
    exchange.balances = [{ asset: "USDT", free: m("5000"), locked: ZERO }];

    const objectName = `real-${Date.now()}`;
    await inBot(objectName, async (bot) => {
      bot.attach({ db, exchange, now: () => clock, newId: () => `n-${(ids += 1)}` });
      await bot.create({
        botInstanceId: "dca-btc-1",
        accountLabel: ACCOUNT,
        exchange: "binance",
        pair: TEST_PAIR,
        capitalAsset: "USDT",
        allocatedCapital: m("400"),
        params,
        actor: "owner@example.com",
      });
      await bot.start("owner@example.com");
    });

    // A step-6 alert nobody has read, of the kind step 6 said reconciliation
    // would own.
    await db.alerts.insert(
      alertRow({
        id: "alert-real",
        alert_type: "cancel_fill_discrepancy",
        severity: "warning",
        bot_instance_id: "dca-btc-1",
        message: "cancelled with more filled than recorded",
        created_at: T0 - 1000,
      }),
    );

    const result = await reconcileAccount(
      ports({
        snapshotBot: async (id) =>
          await inBot(objectName, async (bot) => {
            bot.attach({ db, exchange, now: () => clock, newId: () => `n-${(ids += 1)}` });
            return id === "dca-btc-1" ? await bot.snapshotIfCreated() : null;
          }),
        haltBot: async (id, detail) => {
          halted.push({ botInstanceId: id, detail });
          await inBot(objectName, async (bot) => {
            bot.attach({ db, exchange, now: () => clock, newId: () => `n-${(ids += 1)}` });
            await bot.halt("manual", detail, "reconciliation");
          });
        },
      }),
      ACCOUNT,
    );

    expect(result.tier).toBe("meaningful");
    expect(result.haltedBotIds).toEqual(["dca-btc-1"]);

    // The real object really is halted, in its own storage and in the mirror.
    const snapshot = await inBot(objectName, async (bot) => {
      bot.attach({ db, exchange, now: () => clock, newId: () => "n" });
      return await bot.snapshot();
    });
    expect(snapshot.state.status).toBe("halted");
    expect(snapshot.state.haltReason).toContain("meaningful drift");
    expect((await db.botInstances.findOne({ id: "dca-btc-1" }))!.status).toBe("halted");

    // And the object's own halt alert exists alongside reconciliation's.
    const raised = await alerts();
    expect(raised.some((entry) => entry.alert_type === "halt_manual")).toBe(true);
    expect(
      raised.some((entry) => entry.alert_type === "reconciliation_meaningful_cancel_fill_discrepancy"),
    ).toBe(true);
  });

  it("refuses to resume a bot while the account is latched", async () => {
    await seedLedger("0");
    const objectName = `real-resume-${Date.now()}`;
    await inBot(objectName, async (bot) => {
      bot.attach({ db, exchange, now: () => clock, newId: () => `n-${(ids += 1)}` });
      await bot.create({
        botInstanceId: "dca-btc-2",
        accountLabel: ACCOUNT,
        exchange: "binance",
        pair: TEST_PAIR,
        capitalAsset: "USDT",
        allocatedCapital: m("400"),
        params,
        actor: "owner@example.com",
      });
      await bot.start("owner@example.com");
      await bot.halt("manual", "tripped by the breaker", "reconciliation");
    });

    await seedBaseline("USDT", "5000");
    exchange.balances = [{ asset: "USDT", free: m("4000"), locked: ZERO }];
    snapshots.set("dca-btc-2", snapshotFor("dca-btc-2"));
    await reconcileAccount(ports(), ACCOUNT);
    expect((await readCircuitBreaker(db, ACCOUNT))!.state).toBe("tripped");

    // Without this, the breaker lasts exactly as long as it takes someone to
    // click resume.
    await expect(
      inBot(objectName, async (bot) => {
        bot.attach({ db, exchange, now: () => clock, newId: () => "n" });
        return await bot.resume("owner@example.com");
      }),
    ).rejects.toThrow(/circuit breaker/i);
  });
});
