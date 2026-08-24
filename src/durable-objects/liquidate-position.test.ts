/**
 * The unified human-triggered liquidation (`BotInstance.liquidatePosition`),
 * spec sections 4.5 / 6.2 / 6.3 / 7.2, build step 10.3.
 *
 * Real Durable Object storage and real D1 inside the Workers runtime, per
 * section 14; only the exchange is mocked. Both strategies are driven through
 * the SAME public call, which is the point of it: a future dashboard button
 * closes a halted DCA bot and a halted grid bot identically.
 *
 * The scenario this exists for is the one the DCA `sellOnStopLoss` refusal (step
 * 6, decision 14) and the grid manual-halt-does-not-liquidate rule (step 9,
 * decision 2) deliberately leave open: a bot halts holding a position, and a
 * human later decides to close it out, on purpose, through the same mechanism
 * grid's stop-loss already uses.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { seedPlaceholderTotalBalance } from "../capital";
import type { Database } from "../db/database";
import { freshDatabase } from "../db/test-helpers";
import { fromDecimalString as m, ZERO } from "../shared/money";
import type { Price } from "../shared/exchange-client";
import type { DcaParams } from "../strategies/dca";
import type { GridParams } from "../strategies/grid";
import type { BotInstance, CreateDcaBotRequest, CreateGridBotRequest } from "./bot-instance";
import { BotInstanceError } from "./bot-instance";
import { FakeExchange, TEST_PAIR } from "./fake-exchange";
import { inBot, noopFeed, rateLimiterStub } from "./test-helpers";

const T0 = 1_900_000_000_000; // future: an armed alarm must not already be overdue (step 20)
const ACTOR = "owner@example.com";

let db: Database;
let exchange: FakeExchange;
let clock: number;
let idCounter: number;
let objectName: string;
let nameCounter = 0;

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

/** Levels 90, 95, 100, 105, 110. Stop-loss at 81, breakout at 115. */
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

function dcaCreation(overrides: Partial<CreateDcaBotRequest> = {}): CreateDcaBotRequest {
  return {
    botInstanceId: "dca-liq",
    accountLabel: "main",
    exchange: "binance",
    pair: TEST_PAIR,
    capitalAsset: "USDT",
    allocatedCapital: m("400"),
    params: dcaParams,
    actor: ACTOR,
    ...overrides,
  };
}

function gridCreation(overrides: Partial<CreateGridBotRequest> = {}): CreateGridBotRequest {
  return {
    botInstanceId: "grid-liq",
    accountLabel: "main",
    exchange: "binance",
    pair: TEST_PAIR,
    capitalAsset: "USDT",
    allocatedCapital: m("500"),
    params: gridParams,
    actor: ACTOR,
    ...overrides,
  };
}

function priceAt(value: string): Price {
  return { pair: TEST_PAIR, price: m(value), at: clock };
}

async function run<T>(body: (bot: BotInstance) => Promise<T>): Promise<T> {
  return await inBot(objectName, async (instance) => {
    instance.attach({
      db,
      exchange,
      now: () => clock,
      newId: () => {
        idCounter += 1;
        return `generated-${idCounter}`;
      },
      limiterFor: () => rateLimiterStub(`limiter-${objectName}`),
      sleep: async () => undefined,
      feedFor: () => noopFeed,
    });
    return await body(instance);
  });
}

beforeEach(async () => {
  db = await freshDatabase();
  exchange = new FakeExchange();
  clock = T0;
  idCounter = 0;
  nameCounter += 1;
  objectName = `liq-${nameCounter}`;

  await seedPlaceholderTotalBalance(
    db,
    { accountLabel: "main", asset: "USDT", totalBalance: m("10000"), note: "test fixture" },
    { actor: ACTOR, now: T0 },
  );
});

/** The most recently placed order on the fake. */
function lastPlaced() {
  return exchange.placed[exchange.placed.length - 1]!;
}

// ---------------------------------------------------------------------------
// DCA: a real halted DCA bot liquidated
// ---------------------------------------------------------------------------

describe("DCA liquidation (sections 6.3, 7.2)", () => {
  /** Create, start, fill the base order at `price`, so a real position is held. */
  async function dcaWithPosition(price = "100"): Promise<void> {
    await run((bot) => bot.create(dcaCreation()));
    await run((bot) => bot.start(ACTOR));
    await run((bot) => bot.onPriceUpdate(priceAt(price)));
    const base = exchange.placed[0]!.clientOrderId;
    await run((bot) => bot.onFill(base, exchange.fillFor(base)));
  }

  it("closes out a bot that halted at a stop-loss holding its position (the sellOnStopLoss gap)", async () => {
    await dcaWithPosition("100"); // holds 1.0 BTC at cost 100

    // DCA does NOT auto-sell at a stop-loss (sellOnStopLoss is refused): it
    // halts holding the position. Drop below the 20% stop (100 -> 80).
    const halt = await run((bot) => bot.onPriceUpdate(priceAt("80")));
    expect(halt.status).toBe("halted");
    let snapshot = await run((bot) => bot.snapshot());
    expect(snapshot.state.position.quantity).toBe(m("1")); // still held, not sold

    // The human liquidates at the current price. Set it below cost so the
    // realized figure is a loss, recorded honestly rather than hidden.
    exchange.currentPrice = m("80");
    const result = await run((bot) => bot.liquidatePosition(ACTOR));
    expect(result.action).toBe("liquidating");
    expect(result.status).toBe("halted");

    // A marketable limit SELL of the whole position was placed at 80.
    const sell = lastPlaced();
    expect(sell.side).toBe("sell");
    expect(sell.price).toBe(m("80"));
    expect(sell.quantity).toBe(m("1"));

    snapshot = await run((bot) => bot.snapshot());
    expect(snapshot.state.exitOrderId).toBe(sell.clientOrderId);
    expect(snapshot.state.exitKind).toBe("liquidation");
    // An audit entry names the human actor.
    const audit = await db.auditLog.findMany({ where: { action: "bot.liquidated" } });
    expect(audit).toHaveLength(1);
    expect(audit[0]!.actor).toBe(ACTOR);

    // Fill it: the bot STAYS halted (not a cycle completion, no auto-restart),
    // the position goes flat, and the loss is realized.
    await run((bot) => bot.onFill(sell.clientOrderId, exchange.fillFor(sell.clientOrderId)));
    snapshot = await run((bot) => bot.snapshot());
    expect(snapshot.state.status).toBe("halted");
    expect(snapshot.state.position.quantity).toBe(ZERO);
    expect(snapshot.state.exitOrderId).toBeNull();
    expect(snapshot.state.realizedGross).toBe(m("-20")); // (80 - 100) x 1
  });

  it("is callable regardless of why the bot is halted (a manual halt)", async () => {
    await dcaWithPosition("100");
    await run((bot) => bot.halt("manual", "operator review", ACTOR));

    const result = await run((bot) => bot.liquidatePosition(ACTOR));
    expect(result.action).toBe("liquidating");
    expect(lastPlaced().side).toBe("sell");
  });

  it("refuses to liquidate a RUNNING bot", async () => {
    await run((bot) => bot.create(dcaCreation()));
    await run((bot) => bot.start(ACTOR)); // status running

    await expect(run((bot) => bot.liquidatePosition(ACTOR))).rejects.toMatchObject({
      code: "invalid_status",
    });
    // Nothing was sold.
    expect(exchange.placed.filter((o) => o.side === "sell")).toHaveLength(0);
  });

  it("is a no-op when the position is already flat", async () => {
    await run((bot) => bot.create(dcaCreation()));
    await run((bot) => bot.start(ACTOR));
    await run((bot) => bot.halt("manual", "review", ACTOR)); // halted, never bought

    const result = await run((bot) => bot.liquidatePosition(ACTOR));
    expect(result.action).toBe("nothing_to_liquidate");
    expect(exchange.placed).toHaveLength(0);
    const alerts = await db.alerts.findMany({ where: { alert_type: "liquidation_noop" } });
    expect(alerts).toHaveLength(1);

    // STEP 72: born resolved. This is a RECEIPT -- the click landed and there
    // was nothing to sell -- not an open incident, and nothing would ever have
    // closed it. It used to sit `resolved: false` forever, inflating the one
    // number an operator reads to decide what needs attention.
    expect(alerts[0]!.resolved).toBe(true);
    // AND NOT SUPPRESSED, which is the half worth asserting: the notification
    // dispatcher selects on `notified_at IS NULL` and never reads `resolved`,
    // so the outbound ping is completely unaffected by the line above.
    expect(alerts[0]!.notified_at).toBeNull();
    const pending = await db.alerts.findMany({ where: { notified_at: null } });
    expect(pending.map((row) => row.id)).toContain(alerts[0]!.id);
  });

  it("still raises CONDITION alerts unresolved: the default is unchanged", async () => {
    // The guard on step 72's blast radius. Only receipts were reclassified; an
    // alert that describes something still going on must still arrive open, or
    // the change would have quietly emptied the operator's queue.
    await run((bot) => bot.create(dcaCreation()));
    await run((bot) => bot.start(ACTOR));
    await run((bot) => bot.halt("manual", "review", ACTOR));

    const halts = await db.alerts.findMany({ where: { alert_type: "halt_manual" } });
    expect(halts).toHaveLength(1);
    expect(halts[0]!.resolved).toBe(false);
  });

  it("does not double-sell when a liquidation is already live", async () => {
    await dcaWithPosition("100");
    await run((bot) => bot.halt("manual", "review", ACTOR));
    await run((bot) => bot.liquidatePosition(ACTOR));
    const placedAfterFirst = exchange.placed.length;

    // A second click while the first sell is still resting is an idempotent no-op.
    const second = await run((bot) => bot.liquidatePosition(ACTOR));
    expect(second.action).toBe("hold");
    expect(exchange.placed.length).toBe(placedAfterFirst);
  });

  it("leaves the position held and alerts when no current price can be read (section 5.6)", async () => {
    await dcaWithPosition("100");
    await run((bot) => bot.halt("manual", "review", ACTOR));

    // The exchange cannot be reached for a price. A liquidation must not sell at
    // a stale or unknown price, so nothing is placed and the position is held.
    exchange.currentPriceFailure = { kind: "transport", message: "timeout" };
    const result = await run((bot) => bot.liquidatePosition(ACTOR));
    expect(result.action).toBe("no_price");

    expect(exchange.placed.filter((o) => o.side === "sell")).toHaveLength(0);
    const snapshot = await run((bot) => bot.snapshot());
    expect(snapshot.state.position.quantity).toBe(m("1")); // still held
    expect(snapshot.state.exitOrderId).toBeNull();
    const alerts = await db.alerts.findMany({ where: { alert_type: "liquidation_no_price" } });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.severity).toBe("critical");
  });
});

// ---------------------------------------------------------------------------
// Grid: a real halted grid bot liquidated through the SAME unified call
// ---------------------------------------------------------------------------

describe("grid liquidation through the same call (section 6.2)", () => {
  /** Create, start, place the ladder at 100, and fill the buy at 95. */
  async function gridWithPosition(): Promise<void> {
    await run((bot) => bot.createGrid(gridCreation()));
    await run((bot) => bot.start(ACTOR));
    await run((bot) => bot.onPriceUpdate(priceAt("100")));
    const buyAt95 = exchange.placed.find((o) => o.price === m("95"))!.clientOrderId;
    await run((bot) => bot.onFill(buyAt95, exchange.fillFor(buyAt95)));
  }

  it("closes out a manually-halted grid bot with the identical liquidatePosition call", async () => {
    await gridWithPosition();
    // A manual halt cancels the ladder but does NOT liquidate (step 9, decision
    // 2): the held position remains.
    await run((bot) => bot.halt("manual", "operator review", ACTOR));
    let snapshot = await run((bot) => bot.snapshot());
    const held = snapshot.state.ladder!.heldQuantity;
    expect(held).toBeGreaterThan(ZERO);

    exchange.currentPrice = m("95");
    const result = await run((bot) => bot.liquidatePosition(ACTOR));
    expect(result.action).toBe("liquidating");
    expect(result.status).toBe("halted");

    const sell = lastPlaced();
    expect(sell.side).toBe("sell");
    expect(sell.quantity).toBe(held);
    snapshot = await run((bot) => bot.snapshot());
    expect(snapshot.state.exitKind).toBe("liquidation");
    // The stale ladder slots were cleared, so the liquidation sell is the only
    // live order.
    expect(snapshot.state.ladder!.slots.every((slot) => slot === null)).toBe(true);

    // Fill it: folds through the grid exit-fill path, position flat, still halted.
    await run((bot) => bot.onFill(sell.clientOrderId, exchange.fillFor(sell.clientOrderId)));
    snapshot = await run((bot) => bot.snapshot());
    expect(snapshot.state.status).toBe("halted");
    expect(snapshot.state.ladder!.heldQuantity).toBe(ZERO);
    expect(snapshot.state.exitOrderId).toBeNull();
  });

  it("refuses to liquidate a running grid bot", async () => {
    await run((bot) => bot.createGrid(gridCreation()));
    await run((bot) => bot.start(ACTOR));
    await run((bot) => bot.onPriceUpdate(priceAt("100"))); // running, ladder placed

    await expect(run((bot) => bot.liquidatePosition(ACTOR))).rejects.toBeInstanceOf(BotInstanceError);
  });
});

// ---------------------------------------------------------------------------
// GAP A: the cancel sweep's residue, and the quantity read after it
// ---------------------------------------------------------------------------

/**
 * `liquidatePosition` cancels before it sells, and `#cancelOpenOrders`
 * deliberately leaves two classes of order behind: one whose cancellation could
 * not be CONFIRMED, and one entry 57's gate refused to close over a fill the
 * venue reported and this bot had not recorded. Selling the whole position
 * beside either of them is the thing these tests pin shut.
 *
 * The grid ladder is what makes it sharp. `exitOrderId` already refuses a live
 * EXIT order, but a ladder sell is not an exit order and that guard never sees
 * it -- so an unconfirmed ladder sell for part of the position would rest while
 * a fresh sell is sized from the whole of it.
 */
describe("grid liquidation refuses on an unresolved cancel sweep (gap A)", () => {
  async function gridWithPosition(): Promise<void> {
    await run((bot) => bot.createGrid(gridCreation()));
    await run((bot) => bot.start(ACTOR));
    await run((bot) => bot.onPriceUpdate(priceAt("100")));
    const buyAt95 = exchange.placed.find((o) => o.price === m("95"))!.clientOrderId;
    await run((bot) => bot.onFill(buyAt95, exchange.fillFor(buyAt95)));
  }

  it("REFUSES to liquidate while a cancellation could not be confirmed", async () => {
    // The dangerous class: the order may still be LIVE on the exchange. A halt
    // whose sweep failed retains every id, and the ladder still holds a resting
    // SELL -- which `exitOrderId` does not protect against.
    await gridWithPosition();
    exchange.cancelFailure = { kind: "transport", message: "gateway timeout" };
    await run((bot) => bot.halt("manual", "operator review", ACTOR));

    const before = await run((bot) => bot.snapshot());
    const retained = [...before.state.openOrderIds];
    expect(retained.length).toBeGreaterThan(0);
    const heldBefore = before.state.ladder!.heldQuantity;
    const placedBefore = exchange.placed.length;

    exchange.currentPrice = m("95");
    await expect(run((bot) => bot.liquidatePosition(ACTOR))).rejects.toMatchObject({
      code: "orders_unresolved",
    });

    // NOTHING WAS SOLD AND NOTHING WAS CHANGED. The refusal sits before the
    // ladder clear as well as before the sell, so this pass mutated none of its
    // own state -- the ladder is still standing and the ids are still watched.
    expect(exchange.placed.length).toBe(placedBefore);
    const after = await run((bot) => bot.snapshot());
    expect(after.state.exitOrderId).toBeNull();
    expect(after.state.exitKind).toBeUndefined();
    expect(after.state.ladder!.heldQuantity).toBe(heldBefore);
    expect(after.state.openOrderIds).toEqual(retained);
    expect(after.state.ladder!.slots.some((slot) => slot !== null)).toBe(true);
    // Still halted, so still polled: the retention is handed to something.
    expect(after.state.status).toBe("halted");
  });

  it("REFUSES to liquidate while the sweep left an order with an unrecorded fill", async () => {
    // Entry 57's class. The cancellation LANDS, but the venue reports more
    // filled than this bot recorded, so `#recordCancellation` declines to close
    // the local record and the id stays on the list.
    await gridWithPosition();
    exchange.fillOnCancel = m("0.05");
    // Set BEFORE the halt, so the halt's own sweep is the one the gate refuses
    // to close over and the ids reach `liquidatePosition` already retained.
    await run((bot) => bot.halt("manual", "operator review", ACTOR));

    exchange.currentPrice = m("95");
    await expect(run((bot) => bot.liquidatePosition(ACTOR))).rejects.toMatchObject({
      code: "orders_unresolved",
    });

    const after = await run((bot) => bot.snapshot());
    expect(after.state.exitOrderId).toBeNull();
    expect(after.state.openOrderIds.length).toBeGreaterThan(0);
    expect(await db.alerts.count({ alert_type: "cancel_fill_discrepancy" })).toBeGreaterThan(0);
  });

  it("liquidates normally once the outstanding order resolves", async () => {
    // The refusal is a latch on a condition, not a dead end -- entry 64's third
    // test, on this action. Clear the condition and the identical call works.
    await gridWithPosition();
    exchange.cancelFailure = { kind: "transport", message: "gateway timeout" };
    await run((bot) => bot.halt("manual", "operator review", ACTOR));
    exchange.currentPrice = m("95");
    await expect(run((bot) => bot.liquidatePosition(ACTOR))).rejects.toMatchObject({
      code: "orders_unresolved",
    });

    exchange.cancelFailure = null;
    const result = await run((bot) => bot.liquidatePosition(ACTOR));
    expect(result).toMatchObject({ status: "halted", action: "liquidating" });

    const after = await run((bot) => bot.snapshot());
    expect(after.state.exitKind).toBe("liquidation");
    expect(after.state.ladder!.slots.every((slot) => slot === null)).toBe(true);
    // The sell is the ONLY thing left on the list -- which is what the comment
    // above the sweep always claimed and nothing enforced.
    expect(after.state.openOrderIds).toEqual([after.state.exitOrderId]);
  });

  it("sizes the sell from the POST-sweep position, not the pre-sweep snapshot", async () => {
    // `#outsidePoll` is a COUNTER, not a lock, and the sweep is N network
    // cancellations. A fill delivered into that window moves the held position,
    // and the pre-sweep read this method used to size from is by then stale.
    // `onCancelAttempt` folds that fill at exactly the instant the real race
    // would.
    await gridWithPosition();
    exchange.cancelFailure = { kind: "transport", message: "gateway timeout" };
    await run((bot) => bot.halt("manual", "operator review", ACTOR));
    exchange.cancelFailure = null; // the retry sweep resolves cleanly

    const before = await run((bot) => bot.snapshot());
    const heldBefore = before.state.ladder!.heldQuantity;
    const restingSell = exchange.placed.find(
      (o) => o.side === "sell" && o.price === m("100"),
    )!.clientOrderId;

    exchange.currentPrice = m("95");
    let folded = false;
    await run(async (bot) => {
      exchange.onCancelAttempt = async () => {
        if (folded) return;
        folded = true;
        // A PARTIAL fill: it moves the held position without placing a
        // replacement, so the only thing that changes across the sweep is the
        // number this method is about to size from.
        await bot.onFill(restingSell, exchange.fillFor(restingSell, { quantity: m("0.2") }));
      };
      try {
        return await bot.liquidatePosition(ACTOR);
      } finally {
        exchange.onCancelAttempt = null;
      }
    });
    expect(folded).toBe(true);

    const after = await run((bot) => bot.snapshot());
    const heldAfter = after.state.ladder!.heldQuantity;
    // The race really did move it -- otherwise this test proves nothing.
    expect(heldAfter).toBeLessThan(heldBefore);

    const sell = exchange.placed[exchange.placed.length - 1]!;
    expect(sell.side).toBe("sell");
    // Sized from the number that was true when it was sent, and NAMING the old
    // wrong one so it cannot come back quietly.
    expect(sell.quantity).toBe(heldAfter);
    expect(sell.quantity).not.toBe(heldBefore);
  });
});

// ---------------------------------------------------------------------------
// GAP B: the liquidation sell survives a slot-based re-derivation
// ---------------------------------------------------------------------------

/**
 * `openOrderIds` for a grid is normally exactly what the ladder holds, and
 * `#applyGridFillToOrder` re-derives the whole list from the slots on every
 * ladder fill. The liquidation sell is the one id that is on the list and has
 * never been in a slot -- `#placeLiquidationSell` appends it and gives it no
 * rung, deliberately, because it is shared with DCA which has no ladder at all.
 *
 * Driven through `#gridExit` (a breakout) rather than `liquidatePosition`,
 * BECAUSE gap A's refusal now closes the human route into this state: a
 * liquidation cannot begin with an unresolved order on the list. `#gridExit`
 * has no such refusal and never did, which is exactly why the fix belongs at
 * the shared re-derivation site rather than on the human action.
 */
describe("a late ladder fill does not drop the live liquidation sell (gap B)", () => {
  async function breakoutWithRetainedLadderOrder(): Promise<string> {
    await run((bot) => bot.createGrid(gridCreation()));
    await run((bot) => bot.start(ACTOR));
    await run((bot) => bot.onPriceUpdate(priceAt("100")));
    const buyAt95 = exchange.placed.find((o) => o.price === m("95"))!.clientOrderId;
    await run((bot) => bot.onFill(buyAt95, exchange.fillFor(buyAt95)));

    // The sweep inside `#gridExit`'s halt fails, so every ladder id is retained
    // and stays NON-TERMINAL -- which is what lets a late fill land on one.
    exchange.cancelFailure = { kind: "transport", message: "gateway timeout" };
    exchange.currentPrice = m("115");
    await run((bot) => bot.onPriceUpdate(priceAt("115"))); // breakout -> #gridExit
    exchange.cancelFailure = null;

    const snapshot = await run((bot) => bot.snapshot());
    expect(snapshot.state.exitKind).toBe("liquidation");
    expect(snapshot.state.ladder!.slots.every((slot) => slot === null)).toBe(true);
    return snapshot.state.exitOrderId!;
  }

  it("keeps the liquidation sell on openOrderIds when a late ladder fill re-derives it", async () => {
    const exitId = await breakoutWithRetainedLadderOrder();
    const before = await run((bot) => bot.snapshot());
    expect(before.state.openOrderIds).toContain(exitId);

    // A retained ladder buy, still open on the exchange, fills late. This is the
    // ordinary halted-bot case, not an exotic one: the poll folds fills on a
    // halted bot, and `#gridLevelOf` reconstructs the rung from the order's own
    // `levelIndex`, so a cleared ladder does not stop it reaching the write.
    const lateBuy = before.state.openOrderIds.find((id) => id !== exitId)!;
    await run((bot) => bot.onFill(lateBuy, exchange.fillFor(lateBuy)));

    const after = await run((bot) => bot.snapshot());
    // THE ASSERTION. Before the fix this list was replaced wholesale by the
    // ladder's view of itself, which has never contained this id.
    expect(after.state.openOrderIds).toContain(exitId);
    // And the bot stays observable: a non-empty list on a halted bot is exactly
    // `#pollArmed`, so the sell resting on the exchange is still watched.
    expect(after.state.status).toBe("halted");
    expect(after.state.openOrderIds.length).toBeGreaterThan(0);
    expect(after.state.exitOrderId).toBe(exitId);
  });

  it("still derives openOrderIds from the slots alone when no liquidation is live", async () => {
    // UNREGRESSED. With no exit order, the added condition is false and the
    // write is byte-identical to what it always was: every id on the list is
    // slot-backed, and nothing else is.
    await run((bot) => bot.createGrid(gridCreation()));
    await run((bot) => bot.start(ACTOR));
    await run((bot) => bot.onPriceUpdate(priceAt("100")));
    const buyAt95 = exchange.placed.find((o) => o.price === m("95"))!.clientOrderId;
    await run((bot) => bot.onFill(buyAt95, exchange.fillFor(buyAt95)));

    const snapshot = await run((bot) => bot.snapshot());
    expect(snapshot.state.exitOrderId).toBeNull();
    const slotIds = snapshot.state
      .ladder!.slots.filter((slot) => slot !== null)
      .map((slot) => slot!.clientOrderId);
    expect([...snapshot.state.openOrderIds].sort()).toEqual([...slotIds].sort());
  });
});

// ---------------------------------------------------------------------------
// openOrderIds is MAINTAINED, not re-derived from the ladder
// ---------------------------------------------------------------------------

/**
 * `#gridExit` nulls every ladder slot and never touches `openOrderIds`, while
 * `#cancelOpenOrders` deliberately RETAINS what it could not resolve. That
 * leaves the retained ids tracked but rungless -- and both writes that used to
 * assign this list from the ladder dropped every one of them.
 *
 * Two sites, reachable in different states: the fold
 * (`#applyGridFillToOrder`), on a halted bot; and the placement
 * (`#placeGridOrder`'s slot claim), which needs `running` and is therefore the
 * one that can fire while the bot is actively trading.
 */
describe("openOrderIds survives a slot-based rebuild (maintained, not re-derived)", () => {
  /** Ladder at 100, buy at 95 filled, so a real position is held. */
  async function gridWithPosition(): Promise<void> {
    await run((bot) => bot.createGrid(gridCreation()));
    await run((bot) => bot.start(ACTOR));
    await run((bot) => bot.onPriceUpdate(priceAt("100")));
    const buyAt95 = exchange.placed.find((o) => o.price === m("95"))!.clientOrderId;
    await run((bot) => bot.onFill(buyAt95, exchange.fillFor(buyAt95)));
  }

  /**
   * A breakout exit whose cancel sweep FAILED: every ladder id is retained and
   * still non-terminal, every slot is null, and the liquidation sell is resting.
   * The 2026-07-31 shape.
   */
  async function exitedWithRetainedOrders(): Promise<{ exitId: string; retained: string[] }> {
    await gridWithPosition();
    exchange.cancelFailure = { kind: "transport", message: "gateway timeout" };
    exchange.currentPrice = m("115");
    await run((bot) => bot.onPriceUpdate(priceAt("115"))); // breakout -> #gridExit
    exchange.cancelFailure = null;

    const snapshot = await run((bot) => bot.snapshot());
    expect(snapshot.state.ladder!.slots.every((slot) => slot === null)).toBe(true);
    const exitId = snapshot.state.exitOrderId!;
    const retained = snapshot.state.openOrderIds.filter((id) => id !== exitId);
    // The premise: more than one retained order, so a fold on ONE of them is a
    // real test of whether the OTHERS survive.
    expect(retained.length).toBeGreaterThan(1);
    return { exitId, retained };
  }

  it("keeps the other retained orders when one of them fills completely", async () => {
    const { exitId, retained } = await exitedWithRetainedOrders();
    const [filled, ...others] = retained;

    await run((bot) => bot.onFill(filled!, exchange.fillFor(filled!)));

    const after = await run((bot) => bot.snapshot());
    // The ones that were never resolved are still watched...
    for (const id of others) expect(after.state.openOrderIds).toContain(id);
    // ...including the liquidation sell, which has never had a rung at all.
    expect(after.state.openOrderIds).toContain(exitId);
    // ...and the one that actually completed is correctly gone.
    expect(after.state.openOrderIds).not.toContain(filled);
    expect(after.state.status).toBe("halted");
  });

  it("keeps a retained order that only PARTIALLY fills", async () => {
    // A partial fill resolves nothing: the order is still live on the exchange
    // and must stay watched.
    const { exitId, retained } = await exitedWithRetainedOrders();
    const [filled, ...others] = retained;

    await run((bot) =>
      bot.onFill(filled!, exchange.fillFor(filled!, { quantity: m("0.1") })),
    );

    const after = await run((bot) => bot.snapshot());
    expect(after.state.openOrderIds).toContain(filled);
    for (const id of others) expect(after.state.openOrderIds).toContain(id);
    expect(after.state.openOrderIds).toContain(exitId);
  });

  it("keeps retained orders when a RESUMED bot places its next ladder", async () => {
    // THE RUNNING-BOT CASE, and the dangerous one. `#resumePass` never clears
    // `openOrderIds`, and its drift latch reads `ORDER_STATE_DRIFT_ALERT_TYPES`
    // -- which contains neither `cancel_failed` nor `cancel_fill_discrepancy`.
    // So a bot that exited with orders it could not resolve resumes carrying
    // them, and the next slot claim used to drop every one while it traded.
    const { exitId, retained } = await exitedWithRetainedOrders();

    // Clear the exit so the bot is resumable on ordinary terms.
    await run((bot) => bot.onFill(exitId, exchange.fillFor(exitId)));
    await run((bot) => bot.resume(ACTOR));
    const resumed = await run((bot) => bot.snapshot());
    expect(resumed.state.status).toBe("running");
    for (const id of retained) expect(resumed.state.openOrderIds).toContain(id);

    // REPLACE-ON-FILL is the route, not a fresh ladder: `decide` rebuilds only
    // while `placed` is false, so a resumed grid does not re-place its rungs. A
    // retained BUY filling on the now-running bot plans its paired sell, and
    // `#placeGridOrder` claims that slot -- which is the write under test.
    exchange.currentPrice = m("100");
    const retainedBuy = retained.find(
      (id) => exchange.placed.find((o) => o.clientOrderId === id)?.side === "buy",
    )!;
    expect(retainedBuy).toBeDefined();
    const others = retained.filter((id) => id !== retainedBuy);

    await run((bot) => bot.onFill(retainedBuy, exchange.fillFor(retainedBuy)));

    const after = await run((bot) => bot.snapshot());
    expect(after.state.status).toBe("running");
    // A rung really was claimed -- otherwise this test never reaches the write.
    const slotIds = after.state
      .ladder!.slots.filter((slot) => slot !== null)
      .map((slot) => slot!.clientOrderId);
    expect(slotIds.length).toBeGreaterThan(0);
    for (const id of slotIds) expect(after.state.openOrderIds).toContain(id);
    // THE ASSERTION: the orders this bot still cannot account for are still
    // watched, on a bot that is now trading again.
    for (const id of others) expect(after.state.openOrderIds).toContain(id);
    expect(after.state.openOrderIds).not.toContain(retainedBuy);
  });

  it("UNREGRESSED: an ordinary fold writes exactly the ladder's ids, in level order", async () => {
    // The byte-identical property, asserted as exact array equality rather than
    // set membership: on a healthy running bot nothing is rungless, so the
    // maintained list IS the derived one, same ids and same order.
    await gridWithPosition();

    const after = await run((bot) => bot.snapshot());
    const slotIds = after.state
      .ladder!.slots.filter((slot) => slot !== null)
      .map((slot) => slot!.clientOrderId);
    expect(after.state.openOrderIds).toEqual(slotIds);
  });

  it("UNREGRESSED: an ordinary placement writes exactly the ladder's ids, in level order", async () => {
    // Same property at the other site: the initial ladder is placed one slot
    // claim at a time, and each one writes this list.
    await run((bot) => bot.createGrid(gridCreation()));
    await run((bot) => bot.start(ACTOR));
    await run((bot) => bot.onPriceUpdate(priceAt("100")));

    const after = await run((bot) => bot.snapshot());
    const slotIds = after.state
      .ladder!.slots.filter((slot) => slot !== null)
      .map((slot) => slot!.clientOrderId);
    expect(after.state.openOrderIds).toEqual(slotIds);
    expect(slotIds.length).toBeGreaterThan(1);
  });

  it("CORRECT-DROP: the retained term never adds an id from nowhere", async () => {
    // What this change guarantees, stated exactly. `retained` is filtered from
    // what was ALREADY TRACKED, so the maintained list can only ever be a subset
    // of (what was tracked before) plus (what the ladder holds now). No id can
    // enter it through the retained term.
    //
    // ⚠️ THE LADDER TERM IS A DIFFERENT MATTER, and this test documents it
    // rather than asserting it away. A MANUAL halt leaves stale rungs standing
    // -- `#recordCancellation` never touches the ladder, and only the poll's
    // `#foldTerminalState` clears one -- so `ladderOpenOrderIds` can name orders
    // this bot already resolved, and both this write and the one it replaced
    // include them. That is UNCHANGED, pre-existing behaviour, the same
    // stale-slot defect recorded against `#foldTerminalState`, and it is
    // deliberately not addressed here: it is the opposite direction to the loss
    // this change fixes and belongs in its own session.
    await gridWithPosition();
    exchange.nextCancelFailure = { kind: "transport", message: "connection reset" };
    await run((bot) => bot.halt("manual", "operator review", ACTOR));

    const halted = await run((bot) => bot.snapshot());
    expect(halted.state.openOrderIds.length).toBe(1);
    const retainedId = halted.state.openOrderIds[0]!;
    const trackedBefore = [...halted.state.openOrderIds];

    await run((bot) => bot.resume(ACTOR));
    exchange.currentPrice = m("100");
    await run((bot) => bot.onFill(retainedId, exchange.fillFor(retainedId)));

    const after = await run((bot) => bot.snapshot());
    const slotsNow = after.state
      .ladder!.slots.filter((slot) => slot !== null)
      .map((slot) => slot!.clientOrderId);
    // Nothing appeared that was neither tracked before nor on the ladder now.
    for (const id of after.state.openOrderIds) {
      expect(trackedBefore.includes(id) || slotsNow.includes(id)).toBe(true);
    }
    // And the order that completed is gone, rung cleared and id dropped.
    expect(after.state.openOrderIds).not.toContain(retainedId);
    expect(slotsNow).not.toContain(retainedId);
  });
});
