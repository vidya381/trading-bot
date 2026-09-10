/**
 * THE REPAIR PATH, END TO END, OVER A REAL `KrakenClient` (2026-09-10).
 *
 * ⚠ WHAT PRODUCED THIS FILE. A production trailing-stop bot on `kraken-main`
 * placed its single entry, the entry FILLED on Kraken, and the bot's own books
 * went on saying it held nothing. Reconciliation caught the money moving --
 * $20.0725 of USDT leaving the account with no recorded activity to explain it
 * -- escalated it to the severe tier and tripped the account-wide circuit
 * breaker, halting all three bots on the account. That was the control working.
 *
 * What did NOT work was every path built to fix it afterwards. `applyMissedFills`
 * is the repair for exactly this condition and it refused, sixty-six times, with
 * the same sentence each time: "the exchange reported no per-fill detail, so
 * there is nothing with a real fill id to apply". `checkOpenOrders` refused
 * identically. `repairPosition` refuses a non-DCA bot at its first gate. The
 * position sat real, unrecorded and untrailed, and `liquidatePosition` could not
 * close it either, because it sizes from a `position.quantity` that was zero.
 *
 * THE CAUSE WAS ONE BOOLEAN. `KrakenClient.getOrderStatus` sent `trades: false`
 * on both of its order reads. Kraken populates an order record's `trades` array
 * only "if trades info requested" (its own OpenAPI wording), so no ids came
 * back, so `parseOrderStatus` had nothing to carry, so `fills` was absent on
 * every Kraken order this system had ever read -- and absent `fills` is exactly
 * what all three repair paths correctly refuse to act on, because applying a
 * fill needs a REAL exchange fill id and this codebase will not synthesise one.
 * `parseTrades` and `feeAssetFor` had existed since the venue was built, fully
 * tested, and nothing called them.
 *
 * ── WHY THIS FILE EXISTS AND `kraken/client.test.ts` IS NOT ENOUGH ──
 *
 * That file now proves `getOrderStatus` returns fills. It cannot prove the thing
 * that actually failed, which is a PATH, not a method: that a halted bot's
 * repair reaches a real Kraken execution, folds it through the same
 * `applyFill`/`applyEntry` chain a live fill takes, and leaves the bot's own
 * stored position agreeing with the exchange. Every layer between the two --
 * `openOrderIds`, the rate-limited wrapper, the D1 mirror, the fill's
 * deduplication by id -- is a place this could still not work.
 *
 * So this drives a REAL `BotInstance`, with real Durable Object storage and real
 * D1, against a REAL `KrakenClient` whose only fake is `fetch`. Nothing about
 * the venue is stubbed: the catalogue is resolved, the order is signed and
 * "sent", the status is read from `OpenOrders`/`ClosedOrders`, and the
 * executions come back through `QueryTrades` and `parseTrades`.
 *
 * ── PROVENANCE OF THE PAYLOADS ──
 *
 * The same two-tier discipline every other Kraken test file uses, and the same
 * split. LIVE, pulled from `api.kraken.com` and reused verbatim from
 * `client.test.ts`: `AssetPairs` and `Assets` (the fee/leverage arrays dropped,
 * as there). FROM KRAKEN'S PUBLISHED OpenAPI DOCUMENT, not live, because they
 * need credentials this suite does not have: `AddOrder`, `OpenOrders`,
 * `ClosedOrders` and `QueryTrades`.
 *
 * The fill PRICE and FEE below are the production incident's own -- 78,290.50
 * and 0.15931 USD -- so the arithmetic this file asserts is the arithmetic that
 * actually had to come out right. The QUANTITY is deliberately NOT copied from
 * the incident: it is read back from the order this bot really placed, because
 * a hardcoded one silently becomes a partial-fill test the moment the entry
 * sizing moves by a satoshi. See `placedQuantity`. It lands one satoshi off the
 * production figure (0.00025436 against 0.00025435), for the ordinary reason
 * that this test's crossed limit is not to the cent the one the live bot sent.
 */

import { beforeEach, describe, expect, it } from "vitest";

import { seedPlaceholderTotalBalance } from "../capital";
import type { Database } from "../db/database";
import { freshDatabase } from "../db/test-helpers";
import { fakeKrakenCredentialProvider } from "../exchange/credentials";
import { KrakenClient, KRAKEN_BASE_URLS, KRAKEN_ENDPOINTS } from "../exchange/kraken/client";
import type { FetchLike } from "../exchange/kraken/client";
import type { Price } from "../shared/exchange-client";
import {
  divideRounded,
  fromDecimalString as m,
  max,
  mul,
  ONE,
  toDecimalString,
  ZERO,
} from "../shared/money";
import { trailLevelOf } from "../strategies/trailing-stop";
import type { BotInstance } from "./bot-instance";
import { inBot, noopFeed, rateLimiterStub } from "./test-helpers";

const ACTOR = "owner@example.com";
const NOW = 1_900_000_000_000;
const PAIR = "BTCUSD";
const ACCOUNT = "kraken-main";
const BASE = KRAKEN_BASE_URLS.production;

/** The incident's own numbers. See the header. */
const FILL_PRICE = "78290.50000";
const FILL_FEE = "0.15931";
/**
 * The quantity is READ BACK from the order the bot actually placed, not written
 * here, and that is deliberate rather than lazy. The bot sizes its single entry
 * by dividing its allocation by a crossed limit price and flooring to the
 * venue's step, so hardcoding a figure here would silently test a PARTIAL fill
 * the moment that arithmetic moved by one satoshi -- which is exactly what the
 * first draft of this file did. The venue fills the order the bot sent.
 */
let placedQuantity = "0.00000000";
const KRAKEN_TXID = "OTYZ4T-OD652-ZVJESU";
const KRAKEN_TRADE_ID = "TCCCTY-WE2O6-P3NB37";

// --------------------------------------------------------------------------
// Fixtures
// --------------------------------------------------------------------------

/** Live: GET /0/public/AssetPairs?pair=XBTUSD (fee/leverage arrays dropped). */
const ASSET_PAIRS = {
  XXBTZUSD: {
    altname: "XBTUSD",
    wsname: "XBT/USD",
    aclass_base: "currency",
    base: "XXBT",
    aclass_quote: "currency",
    quote: "ZUSD",
    lot: "unit",
    cost_decimals: 5,
    pair_decimals: 1,
    lot_decimals: 8,
    lot_multiplier: 1,
    fee_volume_currency: "ZUSD",
    margin_call: 80,
    margin_stop: 40,
    ordermin: "0.00005",
    costmin: "0.5",
    tick_size: "0.1",
    status: "online",
  },
};

/** Live: GET /0/public/Assets?asset=XXBT,ZUSD. */
const ASSETS = {
  XXBT: { aclass: "currency", altname: "XBT", decimals: 10, display_decimals: 5, status: "enabled" },
  ZUSD: { aclass: "currency", altname: "USD", decimals: 4, display_decimals: 2, status: "enabled" },
};

/** Kraken's published reference shape for AddOrder. */
const ADD_ORDER_RESULT = {
  descr: { order: "buy XBTUSD @ limit 78628.9" },
  txid: [KRAKEN_TXID],
};

/**
 * One order record. `trades` is present ONLY when `filled` -- which is the whole
 * point: Kraken sends the array only for an order that has executions AND a
 * request that asked for them.
 */
function orderRecord(options: { filled: boolean }): Record<string, unknown> {
  return {
    refid: null,
    userref: 0,
    cl_ord_id: clientOrderId(),
    status: options.filled ? "closed" : "open",
    opentm: 1_789_020_959.801,
    starttm: 0,
    expiretm: 0,
    descr: {
      pair: "XBTUSD",
      type: "buy",
      ordertype: "limit",
      price: "78628.9",
      price2: "0",
      leverage: "none",
      order: `buy ${placedQuantity} XBTUSD @ limit 78628.9`,
      close: "",
    },
    vol: placedQuantity,
    vol_exec: options.filled ? placedQuantity : "0.00000000",
    cost: options.filled ? "19.91319" : "0.00000",
    fee: options.filled ? FILL_FEE : "0.00000",
    price: options.filled ? FILL_PRICE : "0.0",
    stopprice: "0.00000",
    limitprice: "0.00000",
    misc: "",
    // DECISION 4: this system asserts the flag on every order it places, which
    // is what makes the fee asset below a fact rather than an inference.
    oflags: "fciq",
    reason: null,
    ...(options.filled ? { closetm: 1_789_020_959.86 } : { closetm: 0 }),
    ...(options.filled ? { trades: [KRAKEN_TRADE_ID] } : {}),
  };
}

/**
 * Kraken's published reference shape for QueryTrades: a BARE `{txid: trade}`
 * map, with no `trades` wrapper, and a `fee` carrying NO currency field.
 */
function queryTradesResult(): Record<string, unknown> {
  return {
    [KRAKEN_TRADE_ID]: {
      ordertxid: KRAKEN_TXID,
      postxid: "TKH2SE-M7IF5-CFI7LT",
      pair: "XXBTZUSD",
      time: 1_789_020_959.76,
      type: "buy",
      ordertype: "limit",
      price: FILL_PRICE,
      cost: "19.91319",
      fee: FILL_FEE,
      vol: placedQuantity,
      margin: "0.00000",
      misc: "",
      trade_id: 93_748_276,
      maker: false,
    },
  };
}

// --------------------------------------------------------------------------
// Harness
// --------------------------------------------------------------------------

let db: Database;
let botName: string;
let nameCounter = 0;
/** Flipped once the venue has executed the entry. */
let filledOnVenue = false;
let paths: string[] = [];

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

const envelope = (result: unknown): Response => json({ error: [], result });

/** The bot's own id scheme: `v1-<botInstanceId>-<sequence>`, first order is 0. */
const clientOrderId = (): string => `v1-${botName}-0`;

/**
 * A real Kraken client whose ONLY fake is `fetch`. Every route answers the way
 * Kraken does, and the order's fate is driven by `filledOnVenue` -- a resting
 * order lives in `OpenOrders`, an executed one moves to `ClosedOrders` and
 * gains its `trades` array.
 */
function krakenClient(): KrakenClient {
  const fetchLike: FetchLike = async (input) => {
    const path = new URL(input).pathname;
    paths.push(path);

    if (path === KRAKEN_ENDPOINTS.assetPairs) return envelope(ASSET_PAIRS);
    if (path === KRAKEN_ENDPOINTS.assets) return envelope(ASSETS);
    if (path === KRAKEN_ENDPOINTS.addOrder) return envelope(ADD_ORDER_RESULT);
    if (path === KRAKEN_ENDPOINTS.openOrders) {
      return envelope(
        filledOnVenue ? { open: {} } : { open: { [KRAKEN_TXID]: orderRecord({ filled: false }) } },
      );
    }
    if (path === KRAKEN_ENDPOINTS.closedOrders) {
      return envelope(
        filledOnVenue
          ? { closed: { [KRAKEN_TXID]: orderRecord({ filled: true }) }, count: 1 }
          : { closed: {}, count: 0 },
      );
    }
    if (path === KRAKEN_ENDPOINTS.queryTrades) return envelope(queryTradesResult());
    throw new Error(`unexpected Kraken path ${path}`);
  };

  return new KrakenClient({
    baseUrl: BASE,
    credentials: fakeKrakenCredentialProvider(),
    fetch: fetchLike,
    now: () => NOW,
  });
}

async function inNamed<T>(body: (bot: BotInstance) => Promise<T>): Promise<T> {
  return await inBot(botName, async (instance) => {
    instance.attach({
      db,
      exchange: krakenClient(),
      now: () => NOW,
      limiterFor: () => rateLimiterStub(`limiter-${botName}`),
      sleep: async () => undefined,
      feedFor: () => noopFeed,
    });
    return await body(instance);
  });
}

const priceAt = (value: string): Price => ({ pair: PAIR, price: m(value), at: NOW });

beforeEach(async () => {
  db = await freshDatabase();
  nameCounter += 1;
  botName = `krfill${nameCounter}`;
  filledOnVenue = false;
  placedQuantity = "0.00000000";
  paths = [];
  await seedPlaceholderTotalBalance(
    db,
    { accountLabel: ACCOUNT, asset: "USD", totalBalance: m("509.40"), note: "test fixture" },
    { actor: ACTOR, now: NOW },
  );
});

/** A trailing-stop bot that has placed its single entry and is resting on it. */
async function botWithRestingEntry(): Promise<void> {
  await inNamed((bot) =>
    bot.createTrailingStop({
      botInstanceId: botName,
      accountLabel: ACCOUNT,
      exchange: "kraken",
      pair: PAIR,
      capitalAsset: "USD",
      allocatedCapital: m("20"),
      params: { trailPct: m("5") },
      actor: ACTOR,
    }),
  );
  await inNamed((bot) => bot.start(ACTOR));
  // The entry is priced to CROSS the spread, so it is placed at a limit above
  // the market -- the same marketable limit the real bot sent.
  await inNamed((bot) => bot.onPriceUpdate(priceAt("78432.0")));

  const snapshot = await inNamed((bot) => bot.snapshot());
  expect(snapshot.state.openOrderIds).toEqual([clientOrderId()]);
  expect(snapshot.state.position.quantity).toBe(ZERO);

  // The venue now fills exactly what the bot sent. See `placedQuantity`.
  const placed = snapshot.orders.find((entry) => entry.clientOrderId === clientOrderId())!;
  placedQuantity = toDecimalString(placed.quantity);
  expect(placedQuantity).toBe("0.00025436");
}

// --------------------------------------------------------------------------

describe("applyMissedFills over a real KrakenClient", () => {
  it("REACHES AND APPLIES a real Kraken execution the bot never saw", async () => {
    await botWithRestingEntry();

    // The venue executes the entry. Nothing tells the bot: this is the exact
    // shape of the incident -- Kraken filled the order, the bot's 30-second poll
    // could not attribute it, and the books stayed at zero.
    filledOnVenue = true;
    await inNamed((bot) => bot.halt("manual", "circuit breaker: balance_drift", "reconciliation"));

    paths = [];
    const result = await inNamed((bot) => bot.applyMissedFills(ACTOR));

    // ⚠ THE ASSERTION THIS FILE EXISTS FOR. Before the fix this was `applied: []`
    // and a `skipped` entry reading "the exchange reported no per-fill detail".
    expect(result.skipped).toEqual([]);
    expect(result.applied).toEqual([
      {
        clientOrderId: clientOrderId(),
        // Kraken's OWN trade id. Nothing here synthesised it, which is the
        // property that makes the repair idempotent and the reason it refused
        // to act without one.
        fillId: KRAKEN_TRADE_ID,
        quantity: placedQuantity,
        price: "78290.50000000",
      },
    ]);
    // It really did go and read the executions.
    expect(paths).toContain(KRAKEN_ENDPOINTS.queryTrades);
  });

  it("leaves the bot's stored position agreeing with the exchange", async () => {
    await botWithRestingEntry();
    filledOnVenue = true;
    await inNamed((bot) => bot.halt("manual", "circuit breaker: balance_drift", "reconciliation"));
    await inNamed((bot) => bot.applyMissedFills(ACTOR));

    const snapshot = await inNamed((bot) => bot.snapshot());
    const position = snapshot.state.position;

    // The real held quantity, not zero.
    expect(position.quantity).toBe(m(placedQuantity));
    // Cost is the executed NOTIONAL -- price x quantity -- and deliberately
    // excludes the fee, which is booked on the trade row instead.
    expect(position.cost).toBe(mul(m(FILL_PRICE), m(placedQuantity), "half-even"));
    // And therefore a real entry price, derived the same way `applyEntry`
    // derives every other one.
    expect(position.averageEntryPrice).toBe(
      divideRounded(position.cost * ONE, position.quantity, "half-even"),
    );
    expect(position.entries).toHaveLength(1);

    // The order is terminal and no longer tracked as live.
    const order = snapshot.orders.find((entry) => entry.clientOrderId === clientOrderId())!;
    expect(order.state).toBe("filled");
    expect(order.filledQuantity).toBe(m(placedQuantity));
    expect(snapshot.state.openOrderIds).toEqual([]);
  });

  it("does not write or move the high-water mark -- the trail anchors on `max`, not on the repair", async () => {
    // ⚠ THE REPAIR MUST NOT INVENT A MARK, and this is the assertion that says
    // so. `decide` takes `max(averageEntryPrice, highWaterMark ?? ZERO)`, so the
    // trail is anchored by that `max` and NEVER by the repair: whatever the mark
    // was before the fill was folded is what it is afterwards. A repair that
    // stamped the repair-time price onto it would move a live stop to a level
    // the position never actually reached.
    //
    // ⚠ AND THE MARK IS NOT ABSENT HERE, WHICH IS WORTH PINNING RATHER THAN
    // ARRANGING AWAY. `#onPriceUpdatePass` raises it on EVERY tick a
    // trailing-stop bot sees, position or no position -- so a bot that watched
    // the market before its entry filled already carries one, which is the state
    // a real halted bot is in. The `max` is what makes that harmless.
    await botWithRestingEntry();
    const before = (await inNamed((bot) => bot.snapshot())).state.highWaterMark;
    expect(before).toBe(m("78432.0")); // the tick that triggered the entry

    filledOnVenue = true;
    await inNamed((bot) => bot.halt("manual", "circuit breaker: balance_drift", "reconciliation"));
    await inNamed((bot) => bot.applyMissedFills(ACTOR));

    const state = (await inNamed((bot) => bot.snapshot())).state;
    expect(state.highWaterMark).toBe(before);

    // A REAL trail level, off a real entry: never zero, and never derived from a
    // position of zero.
    const reference = max(state.position.averageEntryPrice, state.highWaterMark ?? ZERO);
    expect(reference).toBeGreaterThan(ZERO);
    // Rounded UP, so a protective level triggers no later than the exact price.
    expect(trailLevelOf(reference, m("5"))).toBe(m("74510.40000000"));
  });

  it("anchors the trail on the REAL entry when no mark outranks it", async () => {
    // The same `max`, from the other side: with a mark at or below the entry --
    // a bot whose last tick was under its own fill price -- the reference is the
    // entry itself. Not zero, and not the lower mark. This is the arithmetic the
    // production bot's own numbers produce: a 78,290.50 entry on a 5% trail.
    expect(trailLevelOf(max(m("78290.50001966"), m("78000.0")), m("5"))).toBe(
      m("74375.97501868"),
    );
    // And an absent mark degrades to exactly the same answer, which is what
    // makes `?? ZERO` safe rather than a hole.
    expect(trailLevelOf(max(m("78290.50001966"), ZERO), m("5"))).toBe(m("74375.97501868"));
  });

  it("records the trade in D1, with the fee in the asset Kraken actually charged", async () => {
    await botWithRestingEntry();
    filledOnVenue = true;
    await inNamed((bot) => bot.halt("manual", "circuit breaker: balance_drift", "reconciliation"));
    await inNamed((bot) => bot.applyMissedFills(ACTOR));

    const trades = await db.trades.findMany({ where: { bot_instance_id: botName } });
    expect(trades).toHaveLength(1);
    expect(trades[0]).toMatchObject({
      order_id: clientOrderId(),
      exchange_trade_id: KRAKEN_TRADE_ID,
      price: m(FILL_PRICE),
      quantity: m(placedQuantity),
      fee_amount: m(FILL_FEE),
      // USD, the QUOTE asset, from the order's own `oflags=fciq`. Section 5.5
      // forbids assuming this; DECISION 4 makes it a fact the request set.
      fee_asset: "USD",
    });
  });

  it("does NOT resume the bot, place an order, or touch its status", async () => {
    await botWithRestingEntry();
    filledOnVenue = true;
    await inNamed((bot) => bot.halt("manual", "circuit breaker: balance_drift", "reconciliation"));

    paths = [];
    const result = await inNamed((bot) => bot.applyMissedFills(ACTOR));

    expect(result.status).toBe("halted");
    expect((await inNamed((bot) => bot.snapshot())).state.status).toBe("halted");
    // Repairing the books must not put anything on the exchange. Resuming stays
    // a separate, explicit decision.
    expect(paths).not.toContain(KRAKEN_ENDPOINTS.addOrder);
  });

  it("is IDEMPOTENT: a second pass finds the id already applied and changes nothing", async () => {
    await botWithRestingEntry();
    filledOnVenue = true;
    await inNamed((bot) => bot.halt("manual", "circuit breaker: balance_drift", "reconciliation"));
    await inNamed((bot) => bot.applyMissedFills(ACTOR));

    const second = await inNamed((bot) => bot.applyMissedFills(ACTOR));
    // The order has left `openOrderIds`, so the second pass has nothing to visit
    // at all -- and the position is untouched either way, which is the property
    // that matters and the reason a REAL fill id is required.
    expect(second.applied).toEqual([]);
    const snapshot = await inNamed((bot) => bot.snapshot());
    expect(snapshot.state.position.quantity).toBe(m(placedQuantity));
    expect((await db.trades.findMany({ where: { bot_instance_id: botName } })).length).toBe(1);
  });
});

describe("an order that genuinely has no executions yet", () => {
  /**
   * ⚠ THE UNCHANGED-BEHAVIOUR CASE. Wiring `QueryTrades` in must not turn "this
   * order has not filled" into an applied fill, a phantom position, or a
   * request. A resting, unexecuted order carries no `trades` array, so
   * `getOrderStatus` reports no `fills`, and the repair correctly reports that
   * there is nothing to apply -- exactly as it did before the fix.
   */
  it("applies nothing and leaves the position at zero", async () => {
    await botWithRestingEntry();
    await inNamed((bot) => bot.halt("manual", "operator paused it", ACTOR));

    paths = [];
    const result = await inNamed((bot) => bot.applyMissedFills(ACTOR));

    expect(result.applied).toEqual([]);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]).toContain("no per-fill detail");
    // Reported as "nothing to apply", never as an execution.
    expect(result.skipped[0]).toContain("Filled quantity is 0.00000000");

    const snapshot = await inNamed((bot) => bot.snapshot());
    expect(snapshot.state.position.quantity).toBe(ZERO);
    expect(snapshot.state.openOrderIds).toEqual([clientOrderId()]);
    expect(await db.trades.findMany({ where: { bot_instance_id: botName } })).toEqual([]);
  });

  it("sends NO trades request for it, so the added cost is only paid when there are fills", async () => {
    await botWithRestingEntry();
    await inNamed((bot) => bot.halt("manual", "operator paused it", ACTOR));

    paths = [];
    await inNamed((bot) => bot.applyMissedFills(ACTOR));
    expect(paths).not.toContain(KRAKEN_ENDPOINTS.queryTrades);
  });
});
