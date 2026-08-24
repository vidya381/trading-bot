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
import { DEFAULT_DRIFT_THRESHOLDS } from "./findings";
import {
  EMPTY_BALANCE_SET_ALERT,
  reconcileAccount,
  type ReconciliationPorts,
} from "./reconcile";
import { alertView } from "../api/serialize";
// The dashboard's own gate for the "Apply missed fills" control, executed here
// against what this module really writes. See src/shared/alert-types.test.ts.
import { isOpenDriftAlert } from "../../dashboard/src/driftAlerts";
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
import type { GridLadder, GridSlot } from "../strategies/grid";

const T0 = 1_910_000_000_000; // future: an armed alarm must not already be overdue (step 20)
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

    // Step 61: a LIVE order's first sighting is `order_drift_unconfirmed` --
    // minor, no alert, no halt -- because the owning bot's own 30-second poll
    // usually resolves it before this job looks again. This test is about what
    // happens to CONFIRMED drift, so it runs the pass that confirms it first.
    await reconcileAccount(ports(), ACCOUNT);
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

  it("writes a drift alert the dashboard's repair control actually recognises", async () => {
    /**
     * The end-to-end half of the alert-type contract (`shared/alert-types.test.ts`
     * covers the derivation half). This drives the REAL detection, the REAL
     * `raiseStandingAlert` and the REAL serializer, then asks the dashboard's own
     * predicate whether it would offer "Apply missed fills" for what came out.
     *
     * Without it, the two sides could be renamed apart and nothing would fail:
     * the repair button would simply stop appearing on a bot that has drift,
     * which on screen is indistinguishable from having no drift at all.
     */
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

    // Two passes: step 61 makes a LIVE order's first sighting unconfirmed and
    // alert-free, so the row this asserts on only exists once it is confirmed.
    await reconcileAccount(ports(), ACCOUNT);
    await reconcileAccount(ports(), ACCOUNT);

    const [raised] = await alerts();
    // Serialized exactly as `GET /api/bots/:id` serves it to the dashboard.
    expect(isOpenDriftAlert(alertView(raised!))).toBe(true);
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

// ---------------------------------------------------------------------------
// Standing alerts: one row per open incident, not one per pass (step 18)
// ---------------------------------------------------------------------------

describe("a persistent finding does not re-alert on every pass", () => {
  beforeEach(async () => {
    await seedBot("dca-btc-1");
    await seedLedger("400");
    await seedBaseline("USDT", "5000");
    exchange.balances = [{ asset: "USDT", free: m("5000"), locked: ZERO }];
  });

  /** Put the account into the unchanged meaningful-drift state and run a pass. */
  async function passWithDrift(): Promise<void> {
    const order = trackedOrder();
    snapshots.set(
      "dca-btc-1",
      snapshotFor("dca-btc-1", [order], { openOrderIds: [order.clientOrderId] }),
    );
    await reconcileAccount(ports(), ACCOUNT);
  }

  /**
   * Two passes, which is what a LIVE order now takes to become meaningful drift.
   *
   * Step 61: the first sighting of a disagreement on an order still ON THE BOOK
   * is `order_drift_unconfirmed` -- minor, no alert row, no halt -- because the
   * owning bot polls that same order every 30 seconds and will usually have
   * resolved it before this job looks again. The second sighting escalates. The
   * tests below are about the ALERT LIFECYCLE, so they need the condition to
   * have reached the tier that writes a row; they say so by asking for it
   * explicitly rather than by hiding a second pass inside `passWithDrift`, which
   * the two audit-row-counting tests above still depend on being one pass.
   */
  async function passUntilConfirmed(): Promise<void> {
    await passWithDrift();
    await passWithDrift();
  }

  beforeEach(async () => {
    await exchange.placeOrder({
      pair: TEST_PAIR,
      clientOrderId: "v1-dca-btc-1-0",
      side: "buy",
      type: "limit",
      price: m("65000"),
      quantity: m("0.01"),
    });
    exchange.fillFor("v1-dca-btc-1-0", { quantity: m("0.005") });
    await db.orders.insert(
      orderRow({
        id: "v1-dca-btc-1-0",
        bot_instance_id: "dca-btc-1",
        client_order_id: "v1-dca-btc-1-0",
        price: m("65000"),
        quantity: m("0.01"),
        filled_quantity: ZERO,
        status: "pending",
      }),
    );
  });

  it("writes ONE alert row across many passes of the same unchanged condition", async () => {
    // The measured bug: 186 identical unresolved criticals in four hours,
    // because reconciliation re-detects every 5 minutes and deliberately never
    // auto-corrects order-state drift. The row count stops meaning anything.
    for (let i = 0; i < 5; i++) await passWithDrift();

    const raised = await alerts({ alert_type: "reconciliation_meaningful_order_state_drift" });
    expect(raised).toHaveLength(1);
  });

  it("keeps the full per-pass record in the audit log, which is where history belongs", async () => {
    // This is what makes deduplicating the alert safe rather than lossy.
    for (let i = 0; i < 3; i++) await passWithDrift();

    const runs = await db.auditLog.findMany({ where: { action: "reconciliation.run" } });
    expect(runs).toHaveLength(3);
    for (const entry of runs) {
      const details = entry.details_json as unknown as { findings: unknown[] };
      expect(details.findings.length).toBeGreaterThan(0);
    }
  });

  it("resolves the standing alert once the finding stops recurring", async () => {
    await passUntilConfirmed();
    expect(await alerts({ resolved: false })).not.toHaveLength(0);

    // The drift is corrected: the bot now agrees with the exchange.
    const corrected = trackedOrder({ filledQuantity: m("0.005"), state: "partially_filled" });
    snapshots.set(
      "dca-btc-1",
      snapshotFor("dca-btc-1", [corrected], { openOrderIds: [corrected.clientOrderId] }),
    );
    await db.orders.update({ id: "v1-dca-btc-1-0" }, { filled_quantity: m("0.005"), status: "partially_filled" });
    await reconcileAccount(ports(), ACCOUNT);

    const drift = await alerts({ alert_type: "reconciliation_meaningful_order_state_drift" });
    expect(drift).toHaveLength(1);
    expect(drift[0]!.resolved).toBe(true);
  });

  it("does NOT resolve on a pass that could not read the exchange", async () => {
    // Section 5.6, applied to the alert lifecycle: a run that saw nothing found
    // nothing, and treating that as "the problem went away" would clear a live
    // incident on the strength of an outage. The nastiest possible failure here.
    await passUntilConfirmed();
    exchange.openOrdersFailure = { kind: "transport", message: "unreachable" };
    exchange.balancesFailure = { kind: "transport", message: "unreachable" };

    await reconcileAccount(ports(), ACCOUNT);

    const drift = await alerts({ alert_type: "reconciliation_meaningful_order_state_drift" });
    expect(drift).toHaveLength(1);
    expect(drift[0]!.resolved).toBe(false);
  });

  it("raises a fresh incident if the same drift returns after being resolved", async () => {
    await passUntilConfirmed();
    // Resolve it by hand, standing in for a corrected pass.
    const [first] = await alerts({ alert_type: "reconciliation_meaningful_order_state_drift" });
    await db.alerts.update({ id: first!.id }, { resolved: true });

    await passUntilConfirmed();

    const drift = await alerts({ alert_type: "reconciliation_meaningful_order_state_drift" });
    expect(drift).toHaveLength(2);
    expect(drift.filter((row) => !row.resolved)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// The live-order timing tolerance (step 61)
// ---------------------------------------------------------------------------

describe("a live order's disagreement is not drift on first sight", () => {
  beforeEach(async () => {
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
    // The exchange says half filled; the bot has not recorded it yet. Its own
    // 30-second poll would apply this by its real fill id long before this
    // five-minute job comes round again.
    exchange.fillFor("v1-dca-btc-1-0", { quantity: m("0.005") });
    // The D1 mirror agrees with the object, so `mirrorFindings` stays silent and
    // the only thing under test here is the live-order comparison.
    await db.orders.insert(
      orderRow({
        id: "v1-dca-btc-1-0",
        bot_instance_id: "dca-btc-1",
        client_order_id: "v1-dca-btc-1-0",
        price: m("65000"),
        quantity: m("0.01"),
        filled_quantity: ZERO,
        status: "pending",
      }),
    );
  });

  /** The bot still believes nothing has filled, and the order is still OPEN. */
  function driftingLiveOrder(): void {
    const order = trackedOrder();
    snapshots.set(
      "dca-btc-1",
      snapshotFor("dca-btc-1", [order], { openOrderIds: [order.clientOrderId] }),
    );
  }

  it("does NOT halt on the first sighting: the false alarm that halted two real bots", async () => {
    driftingLiveOrder();

    const result = await reconcileAccount(ports(), ACCOUNT);

    // Reported, and reported honestly -- but as a condition that has not yet
    // earned an action.
    const finding = result.findings.find((entry) => entry.kind === "order_drift_unconfirmed");
    expect(finding).toBeDefined();
    expect(finding!.tier).toBe("minor");
    expect(result.findings.some((entry) => entry.kind === "order_state_drift")).toBe(false);

    // THE FIX: nothing halted, no alert row, and the bot is still running.
    expect(result.haltedBotIds).toEqual([]);
    expect(halted).toEqual([]);
    expect((await db.botInstances.findOne({ id: "dca-btc-1" }))!.status).toBe("running");
    expect(await alerts({ alert_type: "reconciliation_meaningful_order_state_drift" })).toHaveLength(0);

    // And the run's own audit row carries it, structurally, which is both the
    // record and the memory the escalation below reads.
    const [run] = await db.auditLog.findMany({ where: { action: "reconciliation.run" } });
    const details = run!.details_json as unknown as {
      findings: { kind: string; client_order_id: string | null }[];
    };
    expect(
      details.findings.some(
        (entry) =>
          entry.kind === "order_drift_unconfirmed" && entry.client_order_id === "v1-dca-btc-1-0",
      ),
    ).toBe(true);
  });

  it("DOES halt once the same disagreement survives a second run", async () => {
    // The safety property. The tolerance delays a false alarm by one run; it
    // does not silence a real one. A drift the bot's own poll has had ten passes
    // to resolve, and has not, is drift.
    driftingLiveOrder();
    await reconcileAccount(ports(), ACCOUNT);
    expect(halted).toEqual([]);

    const result = await reconcileAccount(ports(), ACCOUNT);

    expect(result.findings.some((entry) => entry.kind === "order_state_drift")).toBe(true);
    expect(result.tier).toBe("meaningful");
    expect(result.haltedBotIds).toEqual(["dca-btc-1"]);
    expect((await db.botInstances.findOne({ id: "dca-btc-1" }))!.status).toBe("halted");
    const raised = await alerts({ alert_type: "reconciliation_meaningful_order_state_drift" });
    expect(raised).toHaveLength(1);
    expect(raised[0]!.message).toMatch(/still disagreeing on a later run/);
  });

  it("forgives again once the bot's own poll has caught up", async () => {
    // The other half of "delays, not silences": a disagreement that DOES
    // self-resolve never reaches the tier that halts, however many runs follow.
    driftingLiveOrder();
    await reconcileAccount(ports(), ACCOUNT);

    // The poll applied the fill, exactly as it would have within 30 seconds.
    const caughtUp = trackedOrder({ filledQuantity: m("0.005"), state: "partially_filled" });
    snapshots.set(
      "dca-btc-1",
      snapshotFor("dca-btc-1", [caughtUp], { openOrderIds: [caughtUp.clientOrderId] }),
    );

    const result = await reconcileAccount(ports(), ACCOUNT);

    expect(result.findings.some((entry) => entry.kind === "order_state_drift")).toBe(false);
    expect(result.haltedBotIds).toEqual([]);
    expect((await db.botInstances.findOne({ id: "dca-btc-1" }))!.status).toBe("running");
  });

  it("does not escalate on an unconfirmed sighting older than the window", async () => {
    // The window is what stops an ancient, long-resolved sighting escalating a
    // brand-new disagreement. Two turns of the five-minute cron.
    driftingLiveOrder();
    await reconcileAccount(ports(), ACCOUNT);

    clock += DEFAULT_DRIFT_THRESHOLDS.unconfirmedWindowMs + 1;
    const result = await reconcileAccount(ports(), ACCOUNT);

    expect(result.findings.some((entry) => entry.kind === "order_drift_unconfirmed")).toBe(true);
    expect(result.findings.some((entry) => entry.kind === "order_state_drift")).toBe(false);
    expect(result.haltedBotIds).toEqual([]);
  });

  it("leaves the TERMINATED-order branch exactly as it was", async () => {
    // The 60s `timingWindowMs` and its `order_recently_terminated` finding are
    // deliberately untouched by this step. `driftAgainst` is shared by both
    // branches, so this asserts the shared function still reports the
    // terminated case as real drift rather than inheriting the new tolerance.
    await exchange.cancelOrder(TEST_PAIR, "v1-dca-btc-1-0");
    clock += DEFAULT_DRIFT_THRESHOLDS.timingWindowMs + 1;
    driftingLiveOrder();

    const result = await reconcileAccount(ports(), ACCOUNT);

    // Gone from the book, outside the window: real drift on the FIRST run.
    expect(result.findings.some((entry) => entry.kind === "order_state_drift")).toBe(true);
    expect(result.haltedBotIds).toEqual(["dca-btc-1"]);
  });
});

// ---------------------------------------------------------------------------
// The terminated-order tolerance on a venue with no last-update time (Gemini)
// ---------------------------------------------------------------------------

describe("a terminated order on a venue that reports no last-update time", () => {
  beforeEach(async () => {
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
    // Filled in full on the exchange, so it has LEFT the book -- which is what
    // puts this order down the terminated branch rather than the live one. The
    // bot has not recorded it.
    exchange.fillFor("v1-dca-btc-1-0");
    await db.orders.insert(
      orderRow({
        id: "v1-dca-btc-1-0",
        bot_instance_id: "dca-btc-1",
        client_order_id: "v1-dca-btc-1-0",
        price: m("65000"),
        quantity: m("0.01"),
        filled_quantity: ZERO,
        status: "pending",
      }),
    );
  });

  /** The bot still believes nothing filled, on an order that has left the book. */
  function driftingTerminatedOrder(): void {
    const order = trackedOrder();
    snapshots.set(
      "dca-btc-1",
      snapshotFor("dca-btc-1", [order], { openOrderIds: [order.clientOrderId] }),
    );
  }

  it("PINS THE BUG: a fabricated updatedAt halts on the first sighting, with no forgiveness", async () => {
    // THE ORIGINAL GEMINI DEFECT, reproduced through the fake rather than
    // described. Gemini's parser used to set `updatedAt = createdAt`, so this is
    // that payload exactly: a venue that DOES report a last-update time, whose
    // reported value IS the order's creation instant, ten minutes old.
    //
    // `age` is then the order's whole life rather than time since it terminated,
    // it clears the 60s window every time, and the tolerance the window exists to
    // provide never applies to any Gemini order older than a minute. The bot
    // halts on the FIRST sighting of a disagreement its own 30-second poll was
    // about to resolve -- which is the false-alarm halt step 61 fixed for live
    // orders and could not fix here.
    //
    // This test does not fail after the fix, and is not meant to: it pins the
    // MECHANISM, so that the characterisation survives as evidence of what the
    // fabricated timestamp did. The test below is the same scenario on a venue
    // reporting the truth, and that is where the behaviour changes.
    exchange.reportsUpdateTime = true;
    exchange.now = T0 - 600_000; // updatedAt === createdAt === ten minutes ago.
    driftingTerminatedOrder();

    const result = await reconcileAccount(ports(), ACCOUNT);

    expect(result.findings.some((entry) => entry.kind === "order_state_drift")).toBe(true);
    expect(result.findings.some((entry) => entry.kind === "order_recently_terminated")).toBe(false);
    expect(result.tier).toBe("meaningful");
    expect(result.haltedBotIds).toEqual(["dca-btc-1"]);
    expect((await db.botInstances.findOne({ id: "dca-btc-1" }))!.status).toBe("halted");
  });

  it("does NOT halt on the first sighting once the venue stops fabricating a timestamp", async () => {
    // THE FIX. Same order, same age, same disagreement -- but the venue now
    // reports no last-update time at all, which is the truth about Gemini. There
    // is no age to compute, so the branch falls back to step 61's run-to-run
    // memory instead of inventing one.
    exchange.reportsUpdateTime = false;
    exchange.now = T0 - 600_000;
    driftingTerminatedOrder();

    const result = await reconcileAccount(ports(), ACCOUNT);

    const finding = result.findings.find((entry) => entry.kind === "order_drift_unconfirmed");
    expect(finding).toBeDefined();
    expect(finding!.tier).toBe("minor");
    expect(result.findings.some((entry) => entry.kind === "order_state_drift")).toBe(false);

    // Nothing halted, no alert row, bot still running.
    expect(result.haltedBotIds).toEqual([]);
    expect(halted).toEqual([]);
    expect((await db.botInstances.findOne({ id: "dca-btc-1" }))!.status).toBe("running");
    expect(await alerts({ alert_type: "reconciliation_meaningful_order_state_drift" })).toHaveLength(
      0,
    );

    // Remembered STRUCTURALLY, on the field rather than in the prose -- this is
    // what the second run below matches on.
    const [run] = await db.auditLog.findMany({ where: { action: "reconciliation.run" } });
    const details = run!.details_json as unknown as {
      findings: { kind: string; client_order_id: string | null }[];
    };
    expect(
      details.findings.some(
        (entry) =>
          entry.kind === "order_drift_unconfirmed" && entry.client_order_id === "v1-dca-btc-1-0",
      ),
    ).toBe(true);
  });

  it("DOES halt once the same terminated disagreement survives a second run", async () => {
    // The safety property, and the reason "no clock" is not "no halt". Escalation
    // is unconditional: the tolerance delays a false alarm by one five-minute
    // cycle, it does not silence a real drift.
    exchange.reportsUpdateTime = false;
    exchange.now = T0 - 600_000;
    driftingTerminatedOrder();

    await reconcileAccount(ports(), ACCOUNT);
    expect(halted).toEqual([]);

    const result = await reconcileAccount(ports(), ACCOUNT);

    expect(result.findings.some((entry) => entry.kind === "order_state_drift")).toBe(true);
    expect(result.tier).toBe("meaningful");
    expect(result.haltedBotIds).toEqual(["dca-btc-1"]);
    expect((await db.botInstances.findOne({ id: "dca-btc-1" }))!.status).toBe("halted");
    const raised = await alerts({ alert_type: "reconciliation_meaningful_order_state_drift" });
    expect(raised).toHaveLength(1);
    expect(raised[0]!.message).toMatch(/still disagreeing on a later run/);
  });

  it("forgives again once the bot's own poll has folded the terminated order", async () => {
    // The other half of "delays, not silences". The poll applying the fill is
    // exactly what the forgiveness was waiting for, and it never escalates after.
    exchange.reportsUpdateTime = false;
    exchange.now = T0 - 600_000;
    driftingTerminatedOrder();
    await reconcileAccount(ports(), ACCOUNT);

    const caughtUp = trackedOrder({ filledQuantity: m("0.01"), state: "filled" });
    snapshots.set(
      "dca-btc-1",
      snapshotFor("dca-btc-1", [caughtUp], { openOrderIds: [caughtUp.clientOrderId] }),
    );

    const result = await reconcileAccount(ports(), ACCOUNT);

    expect(result.findings.some((entry) => entry.kind === "order_state_drift")).toBe(false);
    expect(result.haltedBotIds).toEqual([]);
    expect((await db.botInstances.findOne({ id: "dca-btc-1" }))!.status).toBe("running");
  });

  it("cannot degenerate into 'always applies': a first sighting is minor at ANY size", async () => {
    // The ceiling on `order_drift_unconfirmed` is PINNED at minor, so the whole
    // order's quantity disagreeing still does not halt on first sight -- and the
    // run above proves it still escalates on the second. Both rejected failure
    // modes are closed by the same pair of facts.
    exchange.reportsUpdateTime = false;
    exchange.now = T0 - 600_000;
    driftingTerminatedOrder();

    const result = await reconcileAccount(ports(), ACCOUNT);

    const finding = result.findings.find((entry) => entry.kind === "order_drift_unconfirmed");
    expect(finding!.floor).toBe("minor");
    expect(finding!.tier).toBe("minor");
    expect(finding!.escalated).toBe(false);
    // The disagreement really is the whole order, not a rounding residual.
    expect(finding!.detail).toMatch(/Delta 0\.01000000 of 0\.01000000/);
  });

  it("BINANCE IS UNAFFECTED: a real updateTime keeps both halves of its window", async () => {
    // The regression guard the design session named as test 4, asserting BOTH
    // halves in one body so a future edit cannot satisfy half of it. A venue that
    // reports its transitions honestly must keep exactly the tolerance it had --
    // fixing the venue that does not report them must cost it nothing.
    exchange.reportsUpdateTime = true;

    // HALF ONE -- inside the 60s window: minor, forgiven, on the FIRST run, and
    // NOT routed through the clockless fallback.
    exchange.now = T0 - 5_000;
    driftingTerminatedOrder();

    const inside = await reconcileAccount(ports(), ACCOUNT);

    const forgiven = inside.findings.find((entry) => entry.kind === "order_recently_terminated");
    expect(forgiven).toBeDefined();
    expect(forgiven!.tier).toBe("minor");
    expect(inside.findings.some((entry) => entry.kind === "order_drift_unconfirmed")).toBe(false);
    expect(inside.haltedBotIds).toEqual([]);
    expect((await db.botInstances.findOne({ id: "dca-btc-1" }))!.status).toBe("running");

    // HALF TWO -- outside the window: real drift, halting, on the FIRST run. No
    // first-sighting grace is inherited from the fallback path.
    exchange.now = T0 - (DEFAULT_DRIFT_THRESHOLDS.timingWindowMs + 1);

    const outside = await reconcileAccount(ports(), ACCOUNT);

    expect(outside.findings.some((entry) => entry.kind === "order_state_drift")).toBe(true);
    expect(outside.findings.some((entry) => entry.kind === "order_drift_unconfirmed")).toBe(false);
    expect(outside.tier).toBe("meaningful");
    expect(outside.haltedBotIds).toEqual(["dca-btc-1"]);
  });
});

// ===========================================================================
// Uncovered held inventory (the 2026-08-05 slot collision, detected)
// ===========================================================================

describe("a grid bot holding base with no sell against it", () => {
  /** A placed ladder over levels 90/95/100/105/110. */
  function ladderWith(overrides: Partial<GridLadder> = {}): GridLadder {
    return {
      levels: [m("90"), m("95"), m("100"), m("105"), m("110")],
      slots: [null, null, null, null, null],
      heldQuantity: ZERO,
      heldCost: ZERO,
      realizedGross: ZERO,
      placed: true,
      ...overrides,
    };
  }

  function sellSlot(clientOrderId: string, quantity: string, costBasis: string): GridSlot {
    return { side: "sell", clientOrderId, costBasis: m(costBasis), quantity: m(quantity) };
  }

  beforeEach(async () => {
    await seedBot("grid-btc-1");
    await seedLedger("400");
    await seedBaseline("USDT", "5000");
    exchange.balances = [{ asset: "USDT", free: m("5000"), locked: ZERO }];
  });

  it("is found even though every number in the books is correct", async () => {
    // This is the point of the detector. The position, cost, realized profit,
    // D1 mirror and exchange all agree -- there is no disagreement anywhere for
    // the other checks to find. What is wrong is an ABSENCE: base was bought
    // and the sell that would close the round trip was never placed.
    snapshots.set(
      "grid-btc-1",
      snapshotFor("grid-btc-1", [], { ladder: ladderWith({ heldQuantity: m("1.05"), heldCost: m("99.75") }) }),
    );

    const result = await reconcileAccount(ports(), ACCOUNT);

    const finding = result.findings.find((f) => f.kind === "uncovered_held_inventory");
    expect(finding).toBeDefined();
    expect(finding!.tier).toBe("meaningful");
    expect(finding!.botInstanceId).toBe("grid-btc-1");
    expect(finding!.detail).toContain("1.05000000");
    expect(finding!.detail).toContain("Nothing is queued");
  });

  it("counts partial cover rather than treating any sell as enough", async () => {
    // Half the position has a sell against it; the other half does not. The
    // bot-4xcq8p shape exactly: some rungs replaced, some silently lost.
    snapshots.set(
      "grid-btc-1",
      snapshotFor("grid-btc-1", [], {
        ladder: ladderWith({
          heldQuantity: m("1.05"),
          heldCost: m("99.75"),
          slots: [null, null, sellSlot("sell-1", "0.5", "95"), null, null],
        }),
      }),
    );

    const result = await reconcileAccount(ports(), ACCOUNT);

    const finding = result.findings.find((f) => f.kind === "uncovered_held_inventory");
    expect(finding).toBeDefined();
    // 1.05 held, 0.5 covered -> 0.55 exposed.
    expect(finding!.detail).toContain("0.55000000");
  });

  it("says so when replacements are queued, because that clears on its own", async () => {
    snapshots.set(
      "grid-btc-1",
      snapshotFor("grid-btc-1", [], {
        ladder: ladderWith({ heldQuantity: m("1.05"), heldCost: m("99.75") }),
        pendingReplacements: [
          { levelIndex: 2, side: "sell", price: m("100"), quantity: m("1.05"), costBasis: m("95") },
        ],
      }),
    );

    const result = await reconcileAccount(ports(), ACCOUNT);

    const finding = result.findings.find((f) => f.kind === "uncovered_held_inventory");
    expect(finding!.detail).toContain("1 replacement(s) are queued");
  });

  it("stays silent when every held unit is covered", async () => {
    snapshots.set(
      "grid-btc-1",
      snapshotFor("grid-btc-1", [], {
        ladder: ladderWith({
          heldQuantity: m("1.05"),
          heldCost: m("99.75"),
          slots: [null, null, sellSlot("sell-1", "1.05", "95"), null, null],
        }),
      }),
    );

    const result = await reconcileAccount(ports(), ACCOUNT);
    expect(result.findings.some((f) => f.kind === "uncovered_held_inventory")).toBe(false);
  });

  // --- Stage C: halted bots are detected too. ----------------------------
  //
  // This block replaces a test that pinned the OPPOSITE behaviour ("stays
  // silent on a halted bot, whose ladder was swept on purpose"). Its reasoning
  // was that a halt sweeps the ladder and a human already holds the bot. Both
  // halves were false: a halt cancels resting orders but never sells what the
  // bot already holds, so uncovered base survives a halt untouched; and the
  // human only "already holds it" if something told them, which this was the
  // only thing that would have done. Two live bots sat uncovered and
  // unreported behind that early return.

  it("is found on a HALTED bot, whose halt cancelled orders but sold nothing", async () => {
    snapshots.set(
      "grid-btc-1",
      snapshotFor("grid-btc-1", [], {
        status: "halted",
        haltReason: "manual",
        ladder: ladderWith({ heldQuantity: m("1.05"), heldCost: m("99.75") }),
      }),
    );

    const result = await reconcileAccount(ports(), ACCOUNT);

    const finding = result.findings.find((f) => f.kind === "uncovered_held_inventory");
    expect(finding).toBeDefined();
    expect(finding!.tier).toBe("meaningful");
    expect(finding!.botInstanceId).toBe("grid-btc-1");
    expect(finding!.detail).toContain("1.05000000");
  });

  it("writes the alert row for a halted bot, which is the whole point of finding it", async () => {
    snapshots.set(
      "grid-btc-1",
      snapshotFor("grid-btc-1", [], {
        status: "halted",
        haltReason: "manual",
        ladder: ladderWith({ heldQuantity: m("1.05"), heldCost: m("99.75") }),
      }),
    );

    await reconcileAccount(ports(), ACCOUNT);

    const alerts = await db.alerts.findMany({
      where: { alert_type: "reconciliation_meaningful_uncovered_held_inventory" },
    });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.bot_instance_id).toBe("grid-btc-1");
    expect(alerts[0]!.resolved).toBe(false);
  });

  it("DETECTS ONLY on a halted bot: nothing is placed and nothing is cancelled", async () => {
    // Section 9's standing rule, unchanged by widening detection: reconciliation
    // halts and alerts and never auto-corrects. Finding uncovered inventory must
    // not put a sell on the exchange to cover it -- that is a separate,
    // human-triggered repair. Asserted against the exchange itself rather than
    // against an intention, so a future "helpful" corrective call fails here.
    snapshots.set(
      "grid-btc-1",
      snapshotFor("grid-btc-1", [], {
        status: "halted",
        haltReason: "manual",
        ladder: ladderWith({ heldQuantity: m("1.05"), heldCost: m("99.75") }),
      }),
    );
    const placedBefore = exchange.placed.length;
    const cancelledBefore = exchange.cancelled.length;

    const result = await reconcileAccount(ports(), ACCOUNT);

    expect(result.findings.some((f) => f.kind === "uncovered_held_inventory")).toBe(true);
    expect(exchange.placed.length).toBe(placedBefore);
    expect(exchange.cancelled.length).toBe(cancelledBefore);
  });

  it("counts only SELL cover: a resting buy does not defend a held position", async () => {
    // The live shape, and a real coverage gap found by mutation testing: a grid
    // holding base almost always has buys still resting below it. Summing every
    // slot instead of only the sells would read those buys as cover and report
    // the ladder healthy -- the detector's one question answered backwards, on
    // the most common ladder there is.
    snapshots.set(
      "grid-btc-1",
      snapshotFor("grid-btc-1", [], {
        ladder: ladderWith({
          heldQuantity: m("1.05"),
          heldCost: m("99.75"),
          slots: [
            { side: "buy", clientOrderId: "buy-low", costBasis: null, quantity: m("2") },
            null,
            null,
            null,
            null,
          ],
        }),
      }),
    );

    const result = await reconcileAccount(ports(), ACCOUNT);

    const finding = result.findings.find((f) => f.kind === "uncovered_held_inventory");
    expect(finding).toBeDefined();
    // The resting buy of 2 covers nothing: all 1.05 is exposed.
    expect(finding!.detail).toContain("1.05000000");
  });

  it("still finds it on a RUNNING bot: widening detection did not narrow it", async () => {
    // The unregression guard for the status gate's removal. A `!== "running"`
    // early return replaced by `=== "halted"` would pass every halted-bot test
    // above and silently lose the original case.
    snapshots.set(
      "grid-btc-1",
      snapshotFor("grid-btc-1", [], {
        status: "running",
        ladder: ladderWith({ heldQuantity: m("1.05"), heldCost: m("99.75") }),
      }),
    );

    const result = await reconcileAccount(ports(), ACCOUNT);
    expect(result.findings.some((f) => f.kind === "uncovered_held_inventory")).toBe(true);
  });

  it("stays silent while a liquidation sell is live, which IS the cover", async () => {
    snapshots.set(
      "grid-btc-1",
      snapshotFor("grid-btc-1", [], {
        exitOrderId: "v1-grid-btc-1-9",
        ladder: ladderWith({ heldQuantity: m("1.05"), heldCost: m("99.75") }),
      }),
    );

    const result = await reconcileAccount(ports(), ACCOUNT);
    expect(result.findings.some((f) => f.kind === "uncovered_held_inventory")).toBe(false);
  });

  it("stays silent for a DCA bot, which has no ladder at all", async () => {
    snapshots.set("grid-btc-1", snapshotFor("grid-btc-1"));
    const result = await reconcileAccount(ports(), ACCOUNT);
    expect(result.findings.some((f) => f.kind === "uncovered_held_inventory")).toBe(false);
  });
});

// ===========================================================================
// The empty balance set (the 2026-08-05 faucet re-provision, made observable)
// ===========================================================================

/**
 * Replays the real recorded sequence for account `main` on 2026-08-05, at the
 * shape that matters rather than at its full 504-asset width.
 *
 * From `audit_log` and `balance_snapshots` on the testnet database:
 *
 *   11:45:38Z  clean pass, 445 assets, 0G at 1302
 *   11:50:38Z  HTTP 502 -- 85 consecutive passes skip their balance reads
 *   18:55:38Z  reads recover, but the exchange reports NO holdings: four
 *              passes wrote no snapshot and recorded `skipped: []`
 *   19:15:38Z  504 assets, 0G at 3569, compared against the 11:45 baseline
 *              -> 268 drifts, 256 severe -> breaker tripped
 *
 * The bug is the third step. The fourth is CORRECT behaviour given a stale
 * baseline and is asserted here so the fix cannot quietly suppress it.
 */
describe("when the exchange reports an empty balance set", () => {
  /** 0G, at the two balances the faucet actually had it at. */
  const BEFORE = "1302";
  const AFTER = "3569";

  beforeEach(async () => {
    await seedBot("dca-btc-1");
    snapshots.set("dca-btc-1", snapshotFor("dca-btc-1"));
  });

  it("records it as unread, not as a balance of zero, once the account has been seen", async () => {
    await seedBaseline("0G", BEFORE);
    exchange.balances = [];

    const result = await reconcileAccount(ports(), ACCOUNT);

    expect(result.skipped.some((entry) => entry.includes("NO holdings"))).toBe(true);
    // The baseline survives: nothing is recorded as having drained to zero, so
    // the next real read still measures its delta from the last true one.
    const written = await db.balanceSnapshots.findMany({
      where: { reconciliation_run_id: result.runId },
    });
    expect(written).toEqual([]);
  });

  it("raises one standing alert, distinct from blindness", async () => {
    await seedBaseline("0G", BEFORE);
    exchange.balances = [];

    await reconcileAccount(ports(), ACCOUNT);
    clock += 300_000;
    await reconcileAccount(ports(), ACCOUNT);

    const raised = await alerts({ alert_type: EMPTY_BALANCE_SET_ALERT });
    expect(raised).toHaveLength(1); // one per incident, not one per pass
    expect(raised[0]!.resolved).toBe(false);
    expect(raised[0]!.severity).toBe("critical");
    // The pass READ successfully -- it was told nothing is there. An operator
    // needs that distinguished from "could not read at all".
    expect(raised[0]!.alert_type).not.toBe("reconciliation_blind");
  });

  it("stays silent for an account never observed holding anything", async () => {
    // No baseline seeded: the case the original early return was right about.
    exchange.balances = [];

    const result = await reconcileAccount(ports(), ACCOUNT);

    expect(result.skipped.some((entry) => entry.includes("NO holdings"))).toBe(false);
    expect(await alerts({ alert_type: EMPTY_BALANCE_SET_ALERT })).toEqual([]);
  });

  it("does not let the empty pass resolve a live standing alert", async () => {
    // Section 5.6 applied to the alert lifecycle. This is what those four real
    // passes were entitled to do: they reported `skipped: []`, so they counted
    // as an observation and could have closed a live incident having seen
    // nothing at all.
    await seedBaseline("0G", BEFORE);
    await db.alerts.insert(
      alertRow({
        id: "standing-1",
        alert_type: "reconciliation_meaningful_order_state_drift",
        bot_instance_id: "dca-btc-1",
        source: "reconciliation",
        resolved: false,
      }),
    );
    exchange.balances = [];

    await reconcileAccount(ports(), ACCOUNT);

    const [standing] = await alerts({ id: "standing-1" });
    expect(standing!.resolved).toBe(false);
  });

  it("clears the incident when holdings are visible again", async () => {
    await seedBaseline("0G", BEFORE);
    exchange.balances = [];
    await reconcileAccount(ports(), ACCOUNT);

    clock += 300_000;
    exchange.balances = [{ asset: "0G", free: m(AFTER), locked: ZERO }];
    await reconcileAccount(ports(), ACCOUNT);

    const raised = await alerts({ alert_type: EMPTY_BALANCE_SET_ALERT });
    expect(raised).toHaveLength(1);
    expect(raised[0]!.resolved).toBe(true);
  });

  it("still trips the breaker on the re-provisioned balances, against the surviving baseline", async () => {
    // The fix must not suppress the real finding. 3569 - 1302 = 2267
    // unexplained, exactly what run 12ec9351 recorded.
    await seedBaseline("0G", BEFORE);
    exchange.balances = [];
    await reconcileAccount(ports(), ACCOUNT);

    clock += 300_000;
    exchange.balances = [{ asset: "0G", free: m(AFTER), locked: ZERO }];
    const result = await reconcileAccount(ports(), ACCOUNT);

    const drift = result.findings.find((finding) => finding.asset === "0G");
    expect(drift?.kind).toBe("balance_drift");
    expect(drift?.tier).toBe("severe");
    expect(drift?.detail).toContain("2267.00000000 remains unexplained");
    expect(result.circuitBreakerTripped).toBe(true);
    expect((await readCircuitBreaker(db, ACCOUNT))?.state).toBe("tripped");
  });
});

// ===========================================================================
// The per-asset activity window (the double-counted lifetime activity, step 24)
// ===========================================================================

/**
 * `recordedActivity` used to window its trade query from the account's OLDEST
 * snapshot and hand every asset that one lifetime sum, which the caller then
 * added to a five-minute-old baseline that already contained it.
 *
 * Measured live on `gemini-main` before the fix: the reported discrepancy was
 * exactly the account's lifetime net activity, negated, on every pass --
 * +0.00149818 BTC and 96.24 USD, the latter at 0.0965% of balance against a
 * 0.1% meaningful threshold, climbing with every fill.
 *
 * These use the real shape: an OLDER snapshot, a trade after it, then the
 * baseline that already reflects that trade. With one snapshot only, oldest and
 * baseline are the same row and the bug is invisible -- which is why every
 * existing test in this file passed both before and after the fix.
 */
describe("the activity window is each asset's own baseline", () => {
  const OLDEST = T0 - 900_000;
  const BASELINE = T0 - 300_000;

  beforeEach(async () => {
    await seedBot("dca-btc-1");
    snapshots.set("dca-btc-1", snapshotFor("dca-btc-1"));
    await db.orders.insert(
      orderRow({ id: "ord-1", bot_instance_id: "dca-btc-1", side: "buy", status: "filled" }),
    );
  });

  /** A snapshot pair with a trade settled BETWEEN them. */
  async function tradeBeforeBaseline(): Promise<void> {
    await seedBaseline("USDT", "5000", OLDEST);
    await seedBaseline("BTC", "0", OLDEST);
    await db.trades.insert(
      tradeRow({
        id: "trd-old",
        order_id: "ord-1",
        bot_instance_id: "dca-btc-1",
        price: m("65000"),
        quantity: m("0.01"),
        fee_amount: ZERO,
        fee_asset: "USDT",
        fee_reporting_amount: null,
        fee_reporting_asset: null,
        fee_conversion_rate: null,
        executed_at: OLDEST + 120_000,
      }),
    );
    // The baseline the pass will subtract from ALREADY reflects that buy:
    // 5000 - 650 = 4350 USDT, and 0.01 BTC in.
    await seedBaseline("USDT", "4350", BASELINE);
    await seedBaseline("BTC", "0.01", BASELINE);
  }

  it("does not count a trade the baseline already contains", async () => {
    await tradeBeforeBaseline();
    // Nothing has happened since the baseline, so nothing is unexplained.
    exchange.balances = [
      { asset: "USDT", free: m("4350"), locked: ZERO },
      { asset: "BTC", free: m("0.01"), locked: ZERO },
    ];

    const result = await reconcileAccount(ports(), ACCOUNT);

    expect(result.findings).toEqual([]);
    expect(result.tier).toBeNull();
    expect(result.circuitBreakerTripped).toBe(false);
    const rows = await db.balanceSnapshots.findMany({
      where: { reconciliation_run_id: result.runId },
    });
    // The predicted balance is the baseline itself, unmoved.
    expect(rows.find((row) => row.asset === "USDT")!.internal_calculated_balance).toBe(m("4350"));
    expect(rows.every((row) => row.discrepancy === ZERO)).toBe(true);
  });

  it("still counts a trade that settled after the baseline", async () => {
    // The window must exclude the past without excluding the present.
    await tradeBeforeBaseline();
    await db.trades.insert(
      tradeRow({
        id: "trd-new",
        order_id: "ord-1",
        exchange_trade_id: "556678",
        bot_instance_id: "dca-btc-1",
        price: m("65000"),
        quantity: m("0.01"),
        fee_amount: ZERO,
        fee_asset: "USDT",
        fee_reporting_amount: null,
        fee_reporting_asset: null,
        fee_conversion_rate: null,
        executed_at: BASELINE + 60_000,
      }),
    );
    exchange.balances = [
      { asset: "USDT", free: m("3700"), locked: ZERO }, // 4350 - 650
      { asset: "BTC", free: m("0.02"), locked: ZERO }, // 0.01 + 0.01
    ];

    const result = await reconcileAccount(ports(), ACCOUNT);

    expect(result.findings).toEqual([]);
    const rows = await db.balanceSnapshots.findMany({
      where: { reconciliation_run_id: result.runId },
    });
    expect(rows.find((row) => row.asset === "USDT")!.internal_calculated_balance).toBe(m("3700"));
    expect(rows.find((row) => row.asset === "BTC")!.internal_calculated_balance).toBe(m("0.02"));
  });

  it("reports real drift against the baseline, not against lifetime activity", async () => {
    await tradeBeforeBaseline();
    // 1000 USDT left that nothing explains. The finding must be that 1000 --
    // not 1000 plus the 650 the baseline already absorbed.
    exchange.balances = [
      { asset: "USDT", free: m("3350"), locked: ZERO },
      { asset: "BTC", free: m("0.01"), locked: ZERO },
    ];

    const result = await reconcileAccount(ports(), ACCOUNT);

    const rows = await db.balanceSnapshots.findMany({
      where: { reconciliation_run_id: result.runId },
    });
    expect(rows.find((row) => row.asset === "USDT")!.discrepancy).toBe(m("-1000"));
  });

  it("lets an old unattributable trade go, instead of blinding the asset forever", async () => {
    // The `attributed` flag used to be per asset with no timestamp, so a single
    // unattributable trade suppressed that asset's findings for the rest of the
    // account's life. Outside the window the baseline absorbed it regardless.
    await tradeBeforeBaseline();
    exchange.filtersFailure = { kind: "transport", message: "timeout" };
    exchange.balances = [
      { asset: "USDT", free: m("3350"), locked: ZERO },
      { asset: "BTC", free: m("0.01"), locked: ZERO },
    ];

    const result = await reconcileAccount(ports(), ACCOUNT);

    // The filters read really did fail, so `recordedActivity` still reports
    // that. What must NOT appear is the per-asset refusal to conclude anything,
    // because no trade inside USDT's window needed those filters.
    expect(result.skipped.some((entry) => entry.includes("symbol filters"))).toBe(true);
    expect(
      result.skipped.some((entry) => entry.includes("balance reconciliation for USDT")),
    ).toBe(false);
    expect(result.findings.some((entry) => entry.asset === "USDT")).toBe(true);
  });
});
