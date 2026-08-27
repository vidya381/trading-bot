/**
 * The cross-table invariant checks.
 *
 * The condition under test is the one the `bot-xs0ufw` incident left behind and
 * that nothing in this system detected: a bot marked `halted` or `stopped` with
 * an order of its own still resting on the exchange.
 */

import { beforeEach, describe, expect, it } from "vitest";
import type { Database } from "./database";
import { botInstanceRow, freshDatabase, orderRow } from "./test-helpers";
import {
  findInactiveBotsWithOpenOrders,
  INACTIVE_STATUSES,
  OPEN_ORDER_STATES,
} from "./integrity";
import { TERMINAL_STATES } from "../shared/order-state";

let db: Database;

beforeEach(async () => {
  db = await freshDatabase();
});

/** A bot row and one order belonging to it. */
async function seed(
  botInstanceId: string,
  status: "created" | "running" | "halted" | "stopped",
  orderStatus: "pending" | "partially_filled" | "filled" | "cancelled",
  overrides: { haltedAt?: number } = {},
): Promise<void> {
  await db.botInstances.insert(
    botInstanceRow({
      id: botInstanceId,
      status,
      // Migration 0001's `halt_requires_reason` CHECK: a halted row must carry
      // BOTH columns, so a halted fixture cannot leave them null.
      halt_reason: status === "halted" ? "stop_loss: price 79" : null,
      halted_at: status === "halted" ? (overrides.haltedAt ?? 1_900_000_000_000) : null,
    }),
  );
  await db.orders.insert(
    orderRow({
      id: `${botInstanceId}-ord`,
      bot_instance_id: botInstanceId,
      client_order_id: `${botInstanceId}-cli`,
      status: orderStatus,
    }),
  );
}

describe("OPEN_ORDER_STATES", () => {
  it("is every non-terminal state, derived from the state machine", () => {
    expect([...OPEN_ORDER_STATES].sort()).toEqual(["partially_filled", "pending"]);
    // The derivation, not just the current answer: no terminal state may be in
    // it, or a cancelled order would be reported as still live forever.
    for (const state of TERMINAL_STATES) {
      expect(OPEN_ORDER_STATES).not.toContain(state);
    }
  });
});

describe("findInactiveBotsWithOpenOrders", () => {
  it("finds a halted bot whose order was never cancelled", async () => {
    // The incident's shape exactly: status and halt_reason written, cancel
    // sweep skipped.
    await seed("bot-xs", "halted", "pending", { haltedAt: 1_900_000_000_000 });

    const findings = await findInactiveBotsWithOpenOrders(db);

    expect(findings).toHaveLength(1);
    expect(findings[0]!.botInstanceId).toBe("bot-xs");
    expect(findings[0]!.status).toBe("halted");
    expect(findings[0]!.haltedAt).toBe(1_900_000_000_000);
    expect(findings[0]!.openOrders.map((order) => order.id)).toEqual(["bot-xs-ord"]);
  });

  it("finds a stopped bot too -- the half no scheduled job reads", async () => {
    // `RECONCILED_STATUSES` is created/running/halted and `#pollArmed` excludes
    // `stopped`, so this row is invisible to every other check in the system.
    await seed("bot-st", "stopped", "partially_filled");

    const findings = await findInactiveBotsWithOpenOrders(db);
    expect(findings.map((finding) => finding.botInstanceId)).toEqual(["bot-st"]);
  });

  it("is silent on the healthy combinations", async () => {
    // A running bot with a resting order is the ORDINARY case.
    await seed("bot-run", "running", "pending");
    // A halted bot whose sweep worked. This is what a correct halt leaves.
    await seed("bot-clean", "halted", "cancelled");
    // A stopped bot whose order filled before it closed.
    await seed("bot-done", "stopped", "filled");
    // A created bot has never traded.
    await seed("bot-new", "created", "pending");

    expect(await findInactiveBotsWithOpenOrders(db)).toEqual([]);
  });

  it("returns nothing when the only orders are terminal", async () => {
    await seed("bot-clean", "halted", "cancelled");
    expect(await findInactiveBotsWithOpenOrders(db)).toEqual([]);
  });

  it("groups every open order under its own bot", async () => {
    await seed("bot-grid", "halted", "pending");
    await db.orders.insert(
      orderRow({
        id: "bot-grid-ord-2",
        bot_instance_id: "bot-grid",
        client_order_id: "bot-grid-cli-2",
        status: "partially_filled",
      }),
    );
    // A terminal order on the same bot is NOT reported: it is resolved.
    await db.orders.insert(
      orderRow({
        id: "bot-grid-ord-3",
        bot_instance_id: "bot-grid",
        client_order_id: "bot-grid-cli-3",
        status: "cancelled",
      }),
    );

    const findings = await findInactiveBotsWithOpenOrders(db);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.openOrders.map((order) => order.id).sort()).toEqual([
      "bot-grid-ord",
      "bot-grid-ord-2",
    ]);
  });

  it("sorts stopped before halted, then oldest halt first", async () => {
    await seed("bot-halted-new", "halted", "pending", { haltedAt: 2_000_000_000_000 });
    await seed("bot-halted-old", "halted", "pending", { haltedAt: 1_000_000_000_000 });
    await seed("bot-stopped", "stopped", "pending");

    const findings = await findInactiveBotsWithOpenOrders(db);
    expect(findings.map((finding) => finding.botInstanceId)).toEqual([
      "bot-stopped",
      "bot-halted-old",
      "bot-halted-new",
    ]);
  });

  it("names the two statuses it considers inactive", () => {
    expect([...INACTIVE_STATUSES]).toEqual(["halted", "stopped"]);
  });
});
