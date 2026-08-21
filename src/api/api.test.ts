/**
 * The dashboard API endpoints, end to end (spec step 10, backend half), build
 * step 10.
 *
 * Real D1 and real Durable Objects in the Workers runtime, per section 14; only
 * the exchange is mocked (`FakeExchange`). Every request goes through the real
 * `handleApiRequest`, including the Access JWT verification -- tokens are signed
 * with a Web Crypto key (test-helpers.ts) and the JWKS is injected, so the auth
 * gate is exercised on live endpoints, not bypassed.
 *
 * Bot ids are unique per test: `freshDatabase` clears D1 each test but Durable
 * Object storage persists across a file, so a reused id would still hold a
 * previously-created object (the same reason the kill-switch e2e test suffixes
 * its ids).
 */

import { env, SELF } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { seedPlaceholderTotalBalance } from "../capital";
import type { Database } from "../db/database";
import {
  alertRow,
  botInstanceRow,
  capitalLedgerRow,
  freshDatabase,
  orderRow,
  tradeRow,
} from "../db/test-helpers";
import { FakeExchange, TEST_PAIR } from "../durable-objects/fake-exchange";
import { inBot, rateLimiterStub } from "../durable-objects/test-helpers";
import type { BotInstance } from "../durable-objects/bot-instance";
import { tripAccountCircuitBreaker } from "../reconciliation/circuit-breaker";
import { reconcileAccount } from "../reconciliation/reconcile";
import { isGloballyTripped, tripGlobalKillSwitch } from "../reconciliation/kill-switch";
import type { DcaParams } from "../strategies/dca";
import type { GridParams } from "../strategies/grid";
import { fromDecimalString as m, toDecimalString } from "../shared/money";
import type { Jwks } from "./access";
import { handleApiRequest } from "./index";
import { generateSigningKey, signAccessJwt, type SigningKey } from "./test-helpers";
import type { SymbolLister, SymbolDetailLister } from "../workers/symbols";
import type { CandleLister } from "../workers/candles";
import type { AssessModel } from "../research/assess";
import type { DeriveModel } from "../research/derive";
import { proposals } from "../db/schema";
import { PROPOSAL_LIST_COLUMNS, PROPOSAL_PAYLOAD_COLUMNS } from "./serialize";
import type { Candle, SymbolFilters } from "../shared/exchange-client";
/*
 * ⚠ THE DASHBOARD'S PREFILL MODULE, IMPORTED INTO A WORKER TEST ON PURPOSE.
 *
 * The two prefill tests in the property-5 block below check what happens to a real
 * `proposals` row when a human clicks through to a pre-filled form and then does,
 * or does not, submit it. That question is only answerable here, against real D1
 * and the real endpoint -- so the module under test comes to the harness rather
 * than the harness being rebuilt beside the module.
 *
 * The import is safe across this project's deliberate TypeScript 5.7 / 7 split for
 * the same reason `staleness.ts` can go the other way (decision log 45):
 * `proposalPrefill.ts` reaches only dependency-free files -- `api/research-types.ts`
 * (types, zero imports), `src/research/staleness.ts` and
 * `src/research/proposal-shape.ts` (both zero imports by contract) -- plus
 * `dashboard/src/proposal.ts`, which imports only those. No React, no DOM, no
 * `vite/client`. Both typechecks are run and both are clean; if that ever stops
 * being true it fails at the build rather than silently.
 */
import {
  createBotHref,
  readProposalPrefill,
  withProposalId,
  type GridPrefillFields,
} from "../../dashboard/src/research/proposalPrefill";
import type { DeriveResponse } from "../../dashboard/src/api/research-types";

const T0 = 1_900_000_000_000; // future: an armed alarm must not already be overdue (step 20)
const HUMAN = "owner@example.com";

let db: Database;
let exchange: FakeExchange;
let clock: number;
let idCounter: number;
let suffix: number;
let fileCounter = 0;
let key: SigningKey;
let jwksCache: Map<string, Jwks>;

const dcaParamsJson = {
  baseOrderSize: "100",
  additionalOrderSize: "100",
  stepMultiplier: "1.5",
  dropPct: "5",
  maxAdditionalBuys: 2,
  takeProfitPct: "2",
  stopLossPct: "20",
  autoRestart: false,
  sellOnStopLoss: false,
};

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

beforeAll(async () => {
  key = await generateSigningKey();
});

beforeEach(async () => {
  db = await freshDatabase();
  exchange = new FakeExchange();
  clock = T0;
  idCounter = 0;
  fileCounter += 1;
  suffix = fileCounter;
  jwksCache = new Map();
});

/** Attach real deps (including the fake exchange) to a bot's own object. */
async function inBotId<T>(id: string, body: (bot: BotInstance) => Promise<T>): Promise<T> {
  return await inBot(id, async (instance) => {
    instance.attach({
      db,
      exchange,
      now: () => clock,
      newId: () => `gen-${(idCounter += 1)}`,
      limiterFor: () => rateLimiterStub(`limiter-${id}`),
      sleep: async () => undefined,
    });
    return await body(instance);
  });
}

interface ApiCall {
  readonly body?: unknown;
  /** Override the actor email in the token and header. */
  readonly email?: string;
  /** Explicit token: `null` sends none; a string sends it verbatim. */
  readonly token?: string | null;
  /** Override the email HEADER only (to force a mismatch); `null` sends none. */
  readonly headerEmail?: string | null;
  /** Inject the symbols endpoint's lister so no live exchange call is made. */
  readonly symbolLister?: SymbolLister;
  /** Inject the candles endpoint's lister, for the same reason. */
  readonly candleLister?: CandleLister;
  /** Inject bot creation's per-symbol details lister, for the same reason. */
  readonly symbolDetailLister?: SymbolDetailLister;
  /** Inject the assess endpoint's model, so NO test ever reaches a paid vendor. */
  readonly assessModel?: AssessModel;
  /** Inject the derive endpoint's model, for the same reason. */
  readonly deriveModel?: DeriveModel;
  /** Inject a Database, to drive a read failure the real one cannot be made to produce. */
  readonly db?: Database;
}

async function api(method: string, path: string, call: ApiCall = {}): Promise<{ status: number; body: any }> {
  const email = call.email ?? HUMAN;
  const token =
    call.token !== undefined
      ? call.token
      : await signAccessJwt(key, { email, exp: Math.floor(clock / 1000) + 3600 });

  const headers = new Headers();
  if (call.body !== undefined) headers.set("content-type", "application/json");
  if (token !== null) headers.set("Cf-Access-Jwt-Assertion", token);
  const headerEmail = call.headerEmail !== undefined ? call.headerEmail : email;
  if (headerEmail !== null) headers.set("Cf-Access-Authenticated-User-Email", headerEmail);

  const request = new Request(`https://dash.example.com${path}`, {
    method,
    headers,
    ...(call.body !== undefined ? { body: JSON.stringify(call.body) } : {}),
  });

  const response = await handleApiRequest(request, env, {
    now: () => clock,
    newId: () => `api-${(idCounter += 1)}`,
    access: { now: () => clock, fetchJwks: async () => key.jwks, jwksCache },
    ...(call.symbolLister !== undefined ? { symbolLister: call.symbolLister } : {}),
    ...(call.candleLister !== undefined ? { candleLister: call.candleLister } : {}),
    ...(call.symbolDetailLister !== undefined
      ? { symbolDetailLister: call.symbolDetailLister }
      : {}),
    ...(call.assessModel !== undefined ? { assessModel: call.assessModel } : {}),
    ...(call.deriveModel !== undefined ? { deriveModel: call.deriveModel } : {}),
    ...(call.db !== undefined ? { db: call.db } : {}),
  });
  return { status: response.status, body: await response.json() };
}

async function seedBalance(account: string, total = "10000"): Promise<void> {
  await seedPlaceholderTotalBalance(
    db,
    { accountLabel: account, asset: "USDT", totalBalance: m(total), note: "test fixture" },
    { actor: HUMAN, now: T0 },
  );
}

async function createDcaBot(id: string, account: string, capital = "500"): Promise<void> {
  await inBotId(id, (bot) =>
    bot.create({
      botInstanceId: id,
      accountLabel: account,
      exchange: "binance",
      pair: TEST_PAIR,
      capitalAsset: "USDT",
      allocatedCapital: m(capital),
      params: dcaParams,
      actor: HUMAN,
    }),
  );
}

// ---------------------------------------------------------------------------
// Bot-creation tradability fixtures (the POST /api/bots gate)
// ---------------------------------------------------------------------------

/**
 * A catalogue shaped like Gemini's REAL one: spot pairs and perpetuals in ONE
 * list, which is the whole reason the gate needs two checks rather than one.
 *
 * `HYPEUSDCPERP` and `HYPEGUSDPERP` are not invented. They were read off
 * Gemini's live catalogue during step 31's verification run, alongside the fact
 * that no spot `HYPEUSD` exists -- so a perpetual really is something an
 * operator can see on the venue's own listing and type in good faith.
 */
const BOT_CATALOGUE: readonly string[] = [
  TEST_PAIR,
  "BTCUSD",
  "DOGEUSD",
  "HYPEUSDCPERP",
  "HYPEGUSDPERP",
];

/** A lister answering with that catalogue, counting how often it is asked. */
function botCatalogue(pairs: readonly string[] = BOT_CATALOGUE) {
  const calls = { n: 0 };
  const lister: SymbolLister = async () => {
    calls.n += 1;
    return { ok: true, value: [...pairs], at: T0 };
  };
  return { lister, calls };
}

/**
 * `SymbolFilters` as `parseSymbolDetails` would build them, with the instrument
 * type the venue reported.
 *
 * `instrument` is passed explicitly rather than derived from the pair name,
 * deliberately: deriving it here would make the fixture agree with a suffix
 * heuristic, and the point of this gate is that it reads a FIELD. A test whose
 * fixture encodes the naming convention could not tell the two apart.
 */
function symbolFilters(
  pair: string,
  instrument: SymbolFilters["instrument"],
): SymbolFilters {
  return {
    pair,
    baseAsset: "BTC",
    quoteAsset: "USD",
    status: "TRADING",
    tickSize: m("0.01"),
    minPrice: m("0"),
    maxPrice: m("0"),
    stepSize: m("0.00000001"),
    minQuantity: m("0.00001"),
    maxQuantity: m("0"),
    minNotional: m("0"),
    maxNotional: m("0"),
    ...(instrument === undefined ? {} : { instrument }),
    fetchedAt: T0,
  };
}

/**
 * A details lister that reports each pair's instrument type from an explicit
 * map, defaulting to `spot`. Counts calls so a test can assert the per-symbol
 * request was NOT spent when the catalogue check already refused.
 */
function botDetails(byPair: Readonly<Record<string, SymbolFilters["instrument"]>> = {}) {
  const calls: string[] = [];
  const lister: SymbolDetailLister = async (_account, pair) => {
    calls.push(pair);
    const instrument = pair in byPair ? byPair[pair] : "spot";
    return { ok: true, value: symbolFilters(pair, instrument), at: T0 };
  };
  return { lister, calls };
}

/** The two ports a bot creation needs, with the venue answering normally. */
function botPorts(byPair: Readonly<Record<string, SymbolFilters["instrument"]>> = {}) {
  const catalogue = botCatalogue();
  const details = botDetails(byPair);
  return {
    symbolLister: catalogue.lister,
    symbolDetailLister: details.lister,
    catalogueCalls: catalogue.calls,
    detailCalls: details.calls,
  };
}

// ---------------------------------------------------------------------------
// Auth gate on a live endpoint
// ---------------------------------------------------------------------------

describe("Access verification gates every endpoint", () => {
  it("accepts a request with a valid token", async () => {
    const res = await api("GET", "/api/bots");
    expect(res.status).toBe(200);
    expect(res.body).toStrictEqual({ data: [], error: null });
  });

  it("rejects a request with no token (401)", async () => {
    const res = await api("GET", "/api/bots", { token: null });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("access_jwt_missing");
  });

  it("rejects a tampered token (401)", async () => {
    const good = await signAccessJwt(key, { email: HUMAN, exp: Math.floor(clock / 1000) + 3600 });
    const parts = good.split(".");
    // Flip the first signature char (see access.test.ts for why not the last).
    parts[2] = (parts[2]!.startsWith("A") ? "B" : "A") + parts[2]!.slice(1);
    const res = await api("GET", "/api/bots", { token: parts.join(".") });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("access_bad_signature");
  });

  it("rejects when the email header disagrees with the token (401)", async () => {
    const res = await api("GET", "/api/bots", { headerEmail: "someone-else@example.com" });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("access_email_mismatch");
  });

  it("404s an unknown API route (after auth)", async () => {
    const res = await api("GET", "/api/nope");
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("not_found");
  });

  it("405s a wrong method on a known route", async () => {
    const res = await api("DELETE", "/api/bots");
    expect(res.status).toBe(405);
    expect(res.body.error.code).toBe("method_not_allowed");
  });
});

// ---------------------------------------------------------------------------
// /health alias (unauthenticated, through the real Worker)
// ---------------------------------------------------------------------------

describe("health", () => {
  it("serves /api/health unauthenticated, like /health", async () => {
    const response = await SELF.fetch("https://dash.example.com/api/health");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ status: "ok", environment: "testnet" });
  });
});

// ---------------------------------------------------------------------------
// Bots (endpoints 1-4)
// ---------------------------------------------------------------------------

describe("bots", () => {
  it("lists every bot with status, strategy, pair, position and allocation", async () => {
    const account = `acct-${suffix}`;
    await seedBalance(account);
    const dcaId = `d${suffix}`;
    const gridId = `g${suffix}`;
    await createDcaBot(dcaId, account);
    await inBotId(gridId, (bot) =>
      bot.createGrid({
        botInstanceId: gridId,
        accountLabel: account,
        exchange: "binance",
        pair: TEST_PAIR,
        capitalAsset: "USDT",
        allocatedCapital: m("500"),
        params: gridParams,
        actor: HUMAN,
      }),
    );

    const res = await api("GET", "/api/bots");
    expect(res.status).toBe(200);
    const ids = res.body.data.map((b: any) => b.id).sort();
    expect(ids).toEqual([dcaId, gridId].sort());
    const dca = res.body.data.find((b: any) => b.id === dcaId);
    expect(dca).toMatchObject({
      strategy: "dca",
      status: "created",
      pair: TEST_PAIR,
      // Money is serialized as the canonical fixed-precision decimal string
      // (toDecimalString), matching how audit_log details are written.
      allocatedCapital: "500.00000000",
      capitalAsset: "USDT",
    });
    expect(dca.position).toMatchObject({ strategy: "dca", heldQuantity: "0.00000000" });
  });

  // -------------------------------------------------------------------------
  // The account rollup's inputs (step 25)
  //
  // Every test below pins one figure the main page's account summary adds up.
  // They are backend tests for a frontend feature on purpose: the dashboard has
  // no test runner yet (its own step), so the contract these assert is the only
  // place the rollup's inputs can be held still.
  // -------------------------------------------------------------------------

  /** A resting order plus the fills to apply to it, through the REAL fill path. */
  async function haltedBotWithFills(
    id: string,
    account: string,
    fills: readonly { fillId: string; feeAmount: bigint; feeAsset: string; part: bigint }[],
  ): Promise<void> {
    await seedBalance(account);
    await createDcaBot(id, account);
    await inBotId(id, (bot) => bot.start(HUMAN));
    await inBotId(id, (bot) => bot.onPriceUpdate({ pair: TEST_PAIR, price: m("100"), at: clock }));
    const clientOrderId = exchange.placed[0]!.clientOrderId;
    const resting = exchange.resting.get(clientOrderId)!.request;
    exchange.nextCancelFailure = { kind: "exchange_error", message: "could not read response" };
    await inBotId(id, (bot) => bot.halt("manual", "seeding fills", HUMAN));
    exchange.fillsByOrder.set(
      clientOrderId,
      fills.map((fill) => ({
        fillId: fill.fillId,
        price: resting.price,
        quantity: resting.quantity / fill.part,
        feeAmount: fill.feeAmount,
        feeAsset: fill.feeAsset,
        executedAt: clock + 1000,
      })),
    );
    await api("POST", `/api/bots/${id}/apply-missed-fills`);
  }

  it("totals each bot's fees from its trade history, and counts the fills it could not price", async () => {
    const account = `acct-${suffix}`;
    const id = `fee${suffix}`;
    // Two real fills through `#mirrorTrade`, which does section 5.5's conversion
    // at fill time. The USDT fee IS the capital asset, so it converts at a rate
    // of ONE and needs no lookup. The BNB fee has no rate available -- the
    // lookup knows only the base asset's price -- so all three reporting
    // columns are left NULL rather than guessed, and that fee is real money
    // this total cannot include.
    await haltedBotWithFills(id, account, [
      { fillId: "tid-usdt", feeAmount: m("0.25"), feeAsset: "USDT", part: 2n },
      { fillId: "tid-bnb", feeAmount: m("0.075"), feeAsset: "BNB", part: 2n },
    ]);

    const res = await api("GET", "/api/bots");
    const bot = res.body.data.find((b: any) => b.id === id);

    // The priced fee only. NOT 0.325: adding a BNB amount to a USDT one would
    // be adding two different currencies and calling the result money.
    expect(bot.fees.reported).toBe("0.25000000");
    // And the un-addable one is COUNTED, so the total can be shown as a floor
    // rather than passed off as complete. This is what suppresses the net
    // figure on the dashboard.
    expect(bot.fees.unpricedCount).toBe(1);

    // The rows really are as claimed -- the count is not a serializer artefact.
    expect(await db.trades.count({ bot_instance_id: id, fee_reporting_amount: { isNull: true } })).toBe(1);
  });

  it("sums fees exactly past 2^53, where a float total would drift", async () => {
    const account = `acct-${suffix}`;
    const id = `big${suffix}`;
    await seedBalance(account);
    await createDcaBot(id, account);
    await db.orders.insert(orderRow({ id: `o-${id}`, bot_instance_id: id }));
    // 1000000000.00000001 and 0.00000001. Their exact sum differs from the
    // float sum: at 1e9 a float64's spacing is coarser than 1e-8, so the small
    // fee vanishes entirely if this total is ever computed as a number.
    await db.trades.insert(
      tradeRow({
        id: `t1-${id}`,
        order_id: `o-${id}`,
        bot_instance_id: id,
        exchange_trade_id: "big-1",
        fee_reporting_amount: 100_000_000_000_000_001n,
        fee_reporting_asset: "USDT",
      }),
    );
    await db.trades.insert(
      tradeRow({
        id: `t2-${id}`,
        order_id: `o-${id}`,
        bot_instance_id: id,
        exchange_trade_id: "big-2",
        fee_reporting_amount: 1n,
        fee_reporting_asset: "USDT",
      }),
    );

    const res = await api("GET", "/api/bots");
    const bot = res.body.data.find((b: any) => b.id === id);
    // The last digit is the whole point. `sumMoney` keeps the total on
    // SQLite's side as a 64-bit INTEGER (money columns are INTEGER, read via
    // CAST(... AS TEXT)), so it survives; a float would have lost the 1n.
    expect(bot.fees.reported).toBe("1000000000.00000002");
    expect(bot.fees.unpricedCount).toBe(0);
  });

  it("publishes a grid bot's held cost basis, which used to be DCA-only", async () => {
    const account = `acct-${suffix}`;
    const gridId = `gc${suffix}`;
    await seedBalance(account);
    await inBotId(gridId, (bot) =>
      bot.createGrid({
        botInstanceId: gridId,
        accountLabel: account,
        exchange: "binance",
        pair: TEST_PAIR,
        capitalAsset: "USDT",
        allocatedCapital: m("500"),
        params: gridParams,
        actor: HUMAN,
      }),
    );

    const list = await api("GET", "/api/bots");
    const summary = list.body.data.find((b: any) => b.id === gridId);
    // Without this the grid arm published a held QUANTITY with nothing to value
    // it against, so an account-level "in position" total silently omitted
    // every grid bot.
    expect(summary.position).toMatchObject({ strategy: "grid", cost: "0.00000000" });

    // Pinned to its real source rather than to a literal: the summary's `cost`
    // is the ladder's `heldCost` from the object's own state, which the detail
    // endpoint exposes separately.
    const detail = await api("GET", `/api/bots/${gridId}`);
    expect(summary.position.cost).toBe(detail.body.data.state.ladder.heldCost);
  });

  it("carries the live price and cycle count in the LIST, not only the detail", async () => {
    const account = `acct-${suffix}`;
    const id = `lp${suffix}`;
    await seedBalance(account);
    await createDcaBot(id, account);
    await inBotId(id, (bot) => bot.start(HUMAN));
    await inBotId(id, (bot) => bot.onPriceUpdate({ pair: TEST_PAIR, price: m("100"), at: clock }));

    const res = await api("GET", "/api/bots");
    const bot = res.body.data.find((b: any) => b.id === id);
    // Marking a held position to market needs a price. Before this it meant one
    // `/api/bots/:id` fetch per bot for a number the list had already read.
    expect(bot.lastPrice).toBe("100.00000000");
    expect(bot.cycleCount).toBe(0);
  });

  it("reports an orphan's position, price and cycles as null -- not zero -- but still totals its fees", async () => {
    const id = `orph${suffix}`;
    // A `bot_instances` row with no Durable Object behind it (the step-6
    // orphan), plus a trade in D1. The two sources fail independently: object
    // state is gone, trade history is not.
    await db.botInstances.insert(botInstanceRow({ id, account_label: `acct-${suffix}` }));
    await db.orders.insert(orderRow({ id: `o-${id}`, bot_instance_id: id }));
    await db.trades.insert(
      tradeRow({
        id: `t-${id}`,
        order_id: `o-${id}`,
        bot_instance_id: id,
        exchange_trade_id: "orph-1",
        fee_reporting_amount: m("1.5"),
        fee_reporting_asset: "USDT",
      }),
    );

    const res = await api("GET", "/api/bots");
    const bot = res.body.data.find((b: any) => b.id === id);

    expect(bot.orphaned).toBe(true);
    expect(bot.position).toBeNull();
    // NULL, NOT 0. An object holding no state has not completed zero cycles and
    // has not seen a price of zero -- both facts are unknown, and a rollup that
    // read them as zeroes would report a confident total built on missing data.
    expect(bot.cycleCount).toBeNull();
    expect(bot.lastPrice).toBeNull();
    // The fee total survives, because it never came from the object.
    expect(bot.fees).toEqual({ reported: "1.50000000", unpricedCount: 0 });
  });

  it("gives the same fee figure on the detail endpoint as on the list", async () => {
    const account = `acct-${suffix}`;
    const id = `agr${suffix}`;
    await haltedBotWithFills(id, account, [
      { fillId: "tid-1", feeAmount: m("0.4"), feeAsset: "USDT", part: 2n },
      { fillId: "tid-2", feeAmount: m("0.1"), feeAsset: "BNB", part: 2n },
    ]);

    const list = await api("GET", "/api/bots");
    const detail = await api("GET", `/api/bots/${id}`);
    // One query path, so an operator who clicks into a bot cannot be shown a
    // different cost than the page they clicked from.
    expect(detail.body.data.fees).toEqual(list.body.data.find((b: any) => b.id === id).fees);
    expect(detail.body.data.fees.unpricedCount).toBe(1);
  });

  it("returns full detail for one bot, including config and state", async () => {
    const account = `acct-${suffix}`;
    await seedBalance(account);
    const id = `d${suffix}`;
    await createDcaBot(id, account);

    const res = await api("GET", `/api/bots/${id}`);
    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe(id);
    expect(res.body.data.config.strategy).toBe("dca");
    expect(res.body.data.state.status).toBe("created");
    expect(res.body.data.orders).toEqual([]);
    expect(res.body.data.alerts).toEqual([]);
  });

  it("404s an unknown bot", async () => {
    const res = await api("GET", `/api/bots/missing${suffix}`);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("unknown_bot");
  });

  it("creates a bot, reusing the capital-ledger check, and returns it (201)", async () => {
    const account = `acct-${suffix}`;
    await seedBalance(account);
    const id = `c${suffix}`;

    const res = await api("POST", "/api/bots", {
      ...botPorts(),
      body: {
        botInstanceId: id,
        accountLabel: account,
        exchange: "binance",
        pair: TEST_PAIR,
        capitalAsset: "USDT",
        allocatedCapital: "500",
        strategy: "dca",
        params: dcaParamsJson,
      },
    });

    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ id, status: "created", strategy: "dca" });

    // The bot row and the reservation really landed.
    const row = await db.botInstances.findOne({ id });
    expect(row!.status).toBe("created");
    const ledger = await db.capitalLedger.findOne({ account_label: account, asset: "USDT" });
    expect(ledger!.total_allocated).toBe(m("500"));
    // The creation was audited to the verified human actor.
    const audit = await db.auditLog.findMany({ where: { target_bot_instance_id: id } });
    expect(audit.some((a) => a.action === "capital.allocated" && a.actor === HUMAN)).toBe(true);
  });

  it("rejects a create missing a stop-loss (400)", async () => {
    const account = `acct-${suffix}`;
    await seedBalance(account);
    const noStop: Record<string, unknown> = { ...dcaParamsJson };
    delete noStop.stopLossPct;
    const res = await api("POST", "/api/bots", {
      body: {
        botInstanceId: `n${suffix}`,
        accountLabel: account,
        exchange: "binance",
        pair: TEST_PAIR,
        capitalAsset: "USDT",
        allocatedCapital: "500",
        strategy: "dca",
        params: noStop,
      },
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("invalid_parameter");
  });

  it("rejects a create that exceeds available capital (400)", async () => {
    const account = `acct-${suffix}`;
    await seedBalance(account, "100"); // less than the requested 500
    const res = await api("POST", "/api/bots", {
      ...botPorts(),
      body: {
        botInstanceId: `x${suffix}`,
        accountLabel: account,
        exchange: "binance",
        pair: TEST_PAIR,
        capitalAsset: "USDT",
        allocatedCapital: "500",
        strategy: "dca",
        params: dcaParamsJson,
      },
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("insufficient_capital");
  });

  it("starts a created bot, moving it to running and auditing the human actor", async () => {
    const account = `acct-${suffix}`;
    await seedBalance(account);
    const id = `s${suffix}`;
    await createDcaBot(id, account);

    const res = await api("POST", `/api/bots/${id}/start`);
    expect(res.status).toBe(200);
    expect(res.body.data.result).toMatchObject({ status: "running", action: "started" });
    // The refreshed bot in the response already shows the new status.
    expect(res.body.data.bot).toMatchObject({ id, status: "running" });
    // start places no order in this call -- it subscribes and moves status; the
    // order comes on the next price update, so nothing hit the exchange here.
    expect(exchange.placed).toEqual([]);
    // The D1 row was mirrored and the start audited to the verified human actor.
    const row = await db.botInstances.findOne({ id });
    expect(row!.status).toBe("running");
    const audit = await db.auditLog.findMany({ where: { action: "bot.started" } });
    expect(audit[0]!.actor).toBe(HUMAN);
  });

  it("refuses to start a bot that is not created, surfacing invalid_status (409)", async () => {
    const account = `acct-${suffix}`;
    await seedBalance(account);
    const id = `sr${suffix}`;
    await createDcaBot(id, account);
    await inBotId(id, (bot) => bot.start(HUMAN)); // already running

    const res = await api("POST", `/api/bots/${id}/start`);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("invalid_status");
  });

  /**
   * `BotInstance.halt` has thorough tests of its own (bot-instance.test.ts: the
   * order of marking vs cancelling, idempotence, the stopped-bot refusal). These
   * are the ENDPOINT's, and the fact each one exists to pin is that a HUMAN can
   * now reach that path for ONE bot -- previously only the kill switch (all bots)
   * and reconciliation (automated) could.
   */
  it("halts a running bot, recording the operator's reason and the human actor", async () => {
    const account = `acct-${suffix}`;
    await seedBalance(account);
    const id = `h${suffix}`;
    await createDcaBot(id, account);
    await inBotId(id, (bot) => bot.start(HUMAN));

    const res = await api("POST", `/api/bots/${id}/halt`, {
      body: { reason: "spread looks wrong, stopping to look" },
    });
    expect(res.status).toBe(200);
    expect(res.body.data.result).toMatchObject({ status: "halted", action: "halted" });
    // The refreshed bot already shows the halt, so no second fetch is needed.
    expect(res.body.data.bot).toMatchObject({ id, status: "halted" });
    expect(res.body.data.bot.haltReason).toContain("spread looks wrong");

    // Mirrored to D1 as `manual: <reason>` -- the enum, then the operator's text.
    const row = await db.botInstances.findOne({ id });
    expect(row!.status).toBe("halted");
    expect(row!.halt_reason).toBe("manual: spread looks wrong, stopping to look");
    expect(row!.halted_at).toBe(clock);

    // The audit actor is the VERIFIED email, not "kill-switch" or
    // "reconciliation" -- the whole point of exposing this at the API layer.
    const audit = await db.auditLog.findMany({ where: { action: "bot.halted" } });
    expect(audit[0]!.actor).toBe(HUMAN);
    expect(audit[0]!.details_json).toMatchObject({ reason: "manual" });
  });

  it("requires a reason (400)", async () => {
    const account = `acct-${suffix}`;
    await seedBalance(account);
    const id = `hnr${suffix}`;
    await createDcaBot(id, account);
    await inBotId(id, (bot) => bot.start(HUMAN));

    const res = await api("POST", `/api/bots/${id}/halt`, { body: {} });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("missing_field");
    // Refused before anything happened: the bot is untouched.
    const row = await db.botInstances.findOne({ id });
    expect(row!.status).toBe("running");
  });

  /**
   * A double-click must not be a failure, and must not overwrite the first
   * halt's reason. This is `#halt`'s existing idempotence, over the wire.
   */
  it("is idempotent: halting an already-halted bot succeeds and changes nothing", async () => {
    const account = `acct-${suffix}`;
    await seedBalance(account);
    const id = `hh${suffix}`;
    await createDcaBot(id, account);
    await inBotId(id, (bot) => bot.start(HUMAN));

    const first = await api("POST", `/api/bots/${id}/halt`, { body: { reason: "first" } });
    expect(first.status).toBe(200);
    const second = await api("POST", `/api/bots/${id}/halt`, { body: { reason: "second" } });
    expect(second.status).toBe(200);
    expect(second.body.data.result).toMatchObject({ status: "halted", action: "already_halted" });

    const row = await db.botInstances.findOne({ id });
    expect(row!.halt_reason).toBe("manual: first");
  });

  /**
   * The composition this endpoint unblocks. `liquidate` refuses a running bot and
   * tells the caller to halt it first; before this endpoint existed, a caller
   * following that instruction had nowhere to go short of the global kill switch.
   */
  it("makes a running bot liquidatable, which is what the refusal tells you to do", async () => {
    const account = `acct-${suffix}`;
    await seedBalance(account);
    const id = `hl${suffix}`;
    await createDcaBot(id, account);
    await inBotId(id, (bot) => bot.start(HUMAN));
    await inBotId(id, (bot) => bot.onPriceUpdate({ pair: TEST_PAIR, price: m("100"), at: clock }));
    const base = exchange.placed[0]!.clientOrderId;
    await inBotId(id, (bot) => bot.onFill(base, exchange.fillFor(base)));

    const refused = await api("POST", `/api/bots/${id}/liquidate`);
    expect(refused.status).toBe(409);

    const halted = await api("POST", `/api/bots/${id}/halt`, { body: { reason: "closing out" } });
    expect(halted.status).toBe(200);

    exchange.currentPrice = m("100");
    const res = await api("POST", `/api/bots/${id}/liquidate`);
    expect(res.status).toBe(200);
    expect(res.body.data.result).toMatchObject({ status: "halted", action: "liquidating" });
  });

  /**
   * A halt is risk-REDUCING, so unlike `resume` it asserts neither latch. A
   * pulled kill switch must not block stopping a bot it somehow left running.
   */
  it("halts even while the global kill switch is pulled", async () => {
    const account = `acct-${suffix}`;
    await seedBalance(account);
    const id = `hks${suffix}`;
    await createDcaBot(id, account);
    await inBotId(id, (bot) => bot.start(HUMAN));
    // Latch the switch WITHOUT its sweep, the same way the resume test above
    // trips the account breaker: a real trip halts every running bot itself, so
    // it cannot produce the state under test. This is the bot the sweep failed to
    // reach (`failures`, section 7.4) -- still running, switch still pulled.
    await tripGlobalKillSwitch(db, {
      reason: "genuine emergency",
      actor: HUMAN,
      now: T0,
      haltBot: async () => undefined,
      newId: () => `ks-${(idCounter += 1)}`,
    });

    const res = await api("POST", `/api/bots/${id}/halt`, { body: { reason: "missed by the sweep" } });
    expect(res.status).toBe(200);
    expect(res.body.data.result).toMatchObject({ status: "halted", action: "halted" });
  });

  it("404s a halt on a bot that was never created", async () => {
    const res = await api("POST", `/api/bots/nosuch-${suffix}/halt`, { body: { reason: "x" } });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("not_created");
  });

  /**
   * The six tests above are the endpoint's. These five are the DASHBOARD
   * CONTROL's: each one pins a specific sentence the halt dialog or its outcome
   * banner puts in front of an operator, at the layer the control actually talks
   * to. `#halt`'s own mechanics are covered in bot-instance.test.ts; what is
   * unpinned until now is whether the claims the UI makes about them survive the
   * round trip.
   */

  /**
   * The dialog's central claim -- "halting cancels every order this bot has
   * resting on the exchange" -- and the number it prints, which it reads from
   * `state.openOrderIds` on the detail payload. Both, end to end.
   */
  it("cancels the resting order the dialog names, and empties the list the dialog counts", async () => {
    const account = `acct-${suffix}`;
    await seedBalance(account);
    const id = `hc${suffix}`;
    await createDcaBot(id, account);
    await inBotId(id, (bot) => bot.start(HUMAN));
    await inBotId(id, (bot) => bot.onPriceUpdate({ pair: TEST_PAIR, price: m("100"), at: clock }));
    const clientOrderId = exchange.placed[0]!.clientOrderId;

    // What the dialog reads to say "its 1 open order is cancelled".
    const before = await api("GET", `/api/bots/${id}`);
    expect(before.body.data.state.openOrderIds).toEqual([clientOrderId]);

    const res = await api("POST", `/api/bots/${id}/halt`, { body: { reason: "spread looks wrong" } });
    expect(res.status).toBe(200);

    // The cancellation actually went to the exchange, and the order is closed in
    // D1 rather than merely forgotten locally.
    expect(exchange.cancelled).toContain(clientOrderId);
    const order = await db.orders.findOne({ client_order_id: clientOrderId });
    expect(order!.status).toBe("cancelled");

    const after = await api("GET", `/api/bots/${id}`);
    expect(after.body.data.status).toBe("halted");
    expect(after.body.data.state.openOrderIds).toEqual([]);
  });

  /**
   * "The position is NOT sold" -- the assumption an operator is most likely to
   * make about a control labelled halt, and the one the dialog spends a box
   * correcting. A halt stops trading; exiting is `liquidate`, a separate action.
   */
  it("keeps the position and its capital: halting stops trading, it does not sell", async () => {
    const account = `acct-${suffix}`;
    await seedBalance(account);
    const id = `hp${suffix}`;
    await createDcaBot(id, account);
    await inBotId(id, (bot) => bot.start(HUMAN));
    await inBotId(id, (bot) => bot.onPriceUpdate({ pair: TEST_PAIR, price: m("100"), at: clock }));
    const base = exchange.placed[0]!.clientOrderId;
    const fill = exchange.fillFor(base);
    await inBotId(id, (bot) => bot.onFill(base, fill));
    const placedBefore = exchange.placed.length;

    const res = await api("POST", `/api/bots/${id}/halt`, { body: { reason: "stepping away" } });

    expect(res.status).toBe(200);
    expect(res.body.data.bot.status).toBe("halted");
    // Still holding EXACTLY what it bought, and no sell was placed on the way
    // out. Compared against the fill rather than asserted non-zero: an empty DCA
    // position serialises as "0.00000000", so a `not.toBe("0")` here would pass
    // against a position that had been zeroed (found by mutation, see 23.md).
    expect(res.body.data.bot.position.heldQuantity).toBe(toDecimalString(fill.quantity));
    expect(exchange.placed).toHaveLength(placedBefore);
    // A halt is not a close: the reservation stands (`bot.closed` is what
    // releases it, and nothing audited one here).
    const closed = await db.auditLog.findMany({ where: { action: "bot.closed" } });
    expect(closed).toHaveLength(0);
  });

  /**
   * The banner that refuses to report a clean book it cannot verify. Section 5.6
   * forbids treating an unconfirmable cancellation as a cancellation, so the
   * order stays open and alerted -- and the halt still succeeds, which is the
   * combination the success copy has to survive.
   */
  it("still halts when a cancellation cannot be confirmed, leaving the order open and alerted", async () => {
    const account = `acct-${suffix}`;
    await seedBalance(account);
    const id = `hcf${suffix}`;
    await createDcaBot(id, account);
    await inBotId(id, (bot) => bot.start(HUMAN));
    await inBotId(id, (bot) => bot.onPriceUpdate({ pair: TEST_PAIR, price: m("100"), at: clock }));
    const clientOrderId = exchange.placed[0]!.clientOrderId;
    exchange.cancelFailure = { kind: "transport", message: "connection reset" };

    const res = await api("POST", `/api/bots/${id}/halt`, { body: { reason: "halting anyway" } });

    // A halt that half happened is still a halt: the status flip is durable and
    // comes first, so this is a 200 even though the exchange is not clear.
    expect(res.status).toBe(200);
    expect(res.body.data.result).toMatchObject({ status: "halted", action: "halted" });

    const after = await api("GET", `/api/bots/${id}`);
    expect(after.body.data.status).toBe("halted");
    // NOT assumed cancelled -- still open, and the alert the banner sends the
    // operator to look for is really there.
    expect(after.body.data.state.openOrderIds).toEqual([clientOrderId]);
    expect(
      after.body.data.alerts.filter((alert: any) => alert.alertType === "cancel_failed"),
    ).toHaveLength(1);
  });

  /**
   * The gate the confirm button mirrors. `requireString` trims before testing,
   * so a reason of spaces is refused exactly like a missing one -- which is why
   * the dialog disables on the TRIMMED value rather than on emptiness.
   */
  it("rejects a whitespace-only reason (400), the same as a missing one", async () => {
    const account = `acct-${suffix}`;
    await seedBalance(account);
    const id = `hws${suffix}`;
    await createDcaBot(id, account);
    await inBotId(id, (bot) => bot.start(HUMAN));

    const res = await api("POST", `/api/bots/${id}/halt`, { body: { reason: "   \n  " } });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("missing_field");
    const row = await db.botInstances.findOne({ id });
    expect(row!.status).toBe("running");
  });

  /**
   * The one status the endpoint actually refuses, and the only error branch in
   * the control that is a backend rule rather than a UI choice. Documented in
   * the handler since the endpoint was written; untested at this layer until
   * now.
   */
  it("refuses a STOPPED bot with invalid_status (409)", async () => {
    const account = `acct-${suffix}`;
    await seedBalance(account);
    const id = `hst${suffix}`;
    await createDcaBot(id, account);
    await inBotId(id, (bot) => bot.start(HUMAN));
    await inBotId(id, (bot) => bot.halt("manual", "first", HUMAN));
    await inBotId(id, (bot) => bot.close(HUMAN));

    const res = await api("POST", `/api/bots/${id}/halt`, { body: { reason: "too late" } });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("invalid_status");
  });

  /**
   * The backend accepts `created`; the dashboard deliberately offers no button
   * there. Pinned so the UI gate is readable as the scope choice it is rather
   * than as a limit being mirrored -- if this ever starts failing, the reasoning
   * in `HaltAction`'s docblock is what changed, not the button.
   */
  it("halts a CREATED bot, so the button's absence there is a UI choice, not a limit", async () => {
    const account = `acct-${suffix}`;
    await seedBalance(account);
    const id = `hcr${suffix}`;
    await createDcaBot(id, account); // never started

    const res = await api("POST", `/api/bots/${id}/halt`, { body: { reason: "never mind" } });

    expect(res.status).toBe(200);
    expect(res.body.data.result).toMatchObject({ status: "halted", action: "halted" });
  });

  it("resumes a halted bot, clearing its halt reason and auditing the human actor", async () => {
    const account = `acct-${suffix}`;
    await seedBalance(account);
    const id = `rs${suffix}`;
    await createDcaBot(id, account);
    await inBotId(id, (bot) => bot.start(HUMAN));
    await inBotId(id, (bot) =>
      bot.halt("order_rejected", "exchange refused the order", HUMAN),
    );

    const res = await api("POST", `/api/bots/${id}/resume`);
    expect(res.status).toBe(200);
    expect(res.body.data.result).toMatchObject({ status: "running", action: "resumed" });
    // The refreshed bot in the response shows the new status AND a cleared
    // reason. This assertion was inverted before: resume used to keep the
    // reason, so the detail view showed a running bot still advertising the
    // failure it had already recovered from. The history lives in the audit
    // entry below, which is where a past event belongs.
    expect(res.body.data.bot).toMatchObject({ id, status: "running" });
    expect(res.body.data.bot.haltReason).toBeNull();
    // Resume places no order in this call, exactly like start: it re-subscribes
    // and moves the status; the order attempt comes on the next price update.
    expect(exchange.placed.filter((o) => o.side === "sell")).toEqual([]);
    const row = await db.botInstances.findOne({ id });
    expect(row!.status).toBe("running");
    expect(row!.halt_reason).toBeNull();
    expect(row!.halted_at).toBeNull();
    const audit = await db.auditLog.findMany({ where: { action: "bot.resumed" } });
    expect(audit[0]!.actor).toBe(HUMAN);
    expect(String((audit[0]!.details_json as unknown as Record<string, unknown>)["previous_halt_reason"]))
      .toContain("order_rejected");
  });

  it("refuses to resume a bot that is not halted, surfacing invalid_status (409)", async () => {
    const account = `acct-${suffix}`;
    await seedBalance(account);
    const id = `rr${suffix}`;
    await createDcaBot(id, account); // still `created`, never halted

    const res = await api("POST", `/api/bots/${id}/resume`);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("invalid_status");
  });

  /**
   * Resume asserts BOTH risk latches and `start` asserts neither, so these two
   * are the endpoint's genuinely distinct failures. Each also proves the refusal
   * happens BEFORE the status flip: the bot must still be halted afterwards, or
   * the latch would last exactly as long as it takes someone to click resume
   * (sections 7.3 step 7, 7.4).
   */
  it("refuses to resume while this account's circuit breaker is tripped (409)", async () => {
    const account = `acct-${suffix}`;
    await seedBalance(account);
    const id = `rcb${suffix}`;
    await createDcaBot(id, account);
    await inBotId(id, (bot) => bot.start(HUMAN));
    await inBotId(id, (bot) => bot.halt("manual", "operator review", HUMAN));
    await tripAccountCircuitBreaker(db, {
      accountLabel: account,
      reason: "severe drift",
      runId: null,
      actor: "reconciliation",
      now: T0,
      haltBot: async () => undefined,
      newId: () => `cb-${(idCounter += 1)}`,
    });

    const res = await api("POST", `/api/bots/${id}/resume`);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("account_tripped");
    // Nothing changed: the bot is still halted.
    const row = await db.botInstances.findOne({ id });
    expect(row!.status).toBe("halted");
  });

  /**
   * Step 57, fix 2, through the real endpoint: the refusal has to reach the
   * dashboard as a coded 409, not as a 500 with a generic message. This also
   * proves the new `BotInstanceErrorCode` survives the Durable Object RPC
   * boundary, which is the thing `snapshotIfCreated`'s docblock warns is not
   * automatic.
   */
  it("refuses to resume a bot with an open drift alert, surfacing position_unverified (409)", async () => {
    const account = `acct-${suffix}`;
    await seedBalance(account);
    const id = `rdr${suffix}`;
    await createDcaBot(id, account);
    await inBotId(id, (bot) => bot.start(HUMAN));
    await inBotId(id, (bot) =>
      bot.halt("manual", "reconciliation run r-9 found meaningful drift: ...", "reconciliation"),
    );
    await db.alerts.insert(
      alertRow({
        id: `drift-${suffix}`,
        bot_instance_id: id,
        alert_type: "reconciliation_meaningful_order_state_drift",
        source: "reconciliation",
        resolved: false,
      }),
    );

    const res = await api("POST", `/api/bots/${id}/resume`);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("position_unverified");
    // The operator is told WHY, not just refused.
    expect(res.body.error.message).toMatch(/disagrees with the exchange/);
    const row = await db.botInstances.findOne({ id });
    expect(row!.status).toBe("halted");
  });

  /**
   * Fix 3 through the real endpoint. The two things worth asserting here rather
   * than in the DO's own suite: `?commit` defaults to REPORT, and this is
   * reachable while step 58's drift alert stands -- which is the whole point,
   * since resolving that alert is what it exists to enable.
   */
  it("reports a position repair without committing, and defaults to report mode", async () => {
    const account = `acct-${suffix}`;
    await seedBalance(account);
    const id = `rp${suffix}`;
    await createDcaBot(id, account);
    await inBotId(id, (bot) => bot.start(HUMAN));
    await inBotId(id, (bot) => bot.halt("manual", "operator review", HUMAN));
    // The alert that makes `resume` refuse. This endpoint must not be behind it.
    await db.alerts.insert(
      alertRow({
        id: `rpdrift-${suffix}`,
        bot_instance_id: id,
        alert_type: "reconciliation_meaningful_order_state_drift",
        source: "reconciliation",
        resolved: false,
      }),
    );

    const res = await api("POST", `/api/bots/${id}/repair-position`);
    expect(res.status).toBe(200);
    // A freshly halted bot with no fills has nothing to repair.
    expect(res.body.data.result.outcome).toBe("no_change");
    expect(res.body.data.result.committed).toBe(false);

    // And resume is still refused, proving the two are independent.
    const resume = await api("POST", `/api/bots/${id}/resume`);
    expect(resume.status).toBe(409);
    expect(resume.body.error.code).toBe("position_unverified");
  });

  it("rejects a malformed ?commit value rather than guessing", async () => {
    const account = `acct-${suffix}`;
    await seedBalance(account);
    const id = `rpc${suffix}`;
    await createDcaBot(id, account);

    const res = await api("POST", `/api/bots/${id}/repair-position?commit=yes`);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("invalid_field");
  });

  it("refuses to resume while the global kill switch is pulled (409)", async () => {
    const account = `acct-${suffix}`;
    await seedBalance(account);
    const id = `rks${suffix}`;
    await createDcaBot(id, account);
    await inBotId(id, (bot) => bot.start(HUMAN));
    // The pull halts the bot itself, which is the realistic path to this state.
    const trip = await api("POST", "/api/kill-switch/trigger", {
      body: { reason: "genuine emergency" },
    });
    expect(trip.body.data.result.haltedBotIds).toContain(id);

    const res = await api("POST", `/api/bots/${id}/resume`);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("globally_tripped");
    const row = await db.botInstances.findOne({ id });
    expect(row!.status).toBe("halted");

    // And after a human re-arms the switch, the same request succeeds -- proof
    // the refusal was the latch and not a permanent block on the bot.
    await api("POST", "/api/kill-switch/reset", { body: { note: "resolved" } });
    const after = await api("POST", `/api/bots/${id}/resume`);
    expect(after.status).toBe(200);
    expect(after.body.data.result).toMatchObject({ status: "running", action: "resumed" });
  });

  it("refuses to liquidate a RUNNING bot, reusing the existing rejection (409)", async () => {
    const account = `acct-${suffix}`;
    await seedBalance(account);
    const id = `r${suffix}`;
    await createDcaBot(id, account);
    await inBotId(id, (bot) => bot.start(HUMAN)); // now running

    const res = await api("POST", `/api/bots/${id}/liquidate`);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("invalid_status");
  });

  it("liquidates a halted bot holding a position through the unified path", async () => {
    const account = `acct-${suffix}`;
    await seedBalance(account);
    const id = `l${suffix}`;
    await createDcaBot(id, account);
    await inBotId(id, (bot) => bot.start(HUMAN));
    // Place and fill the base order so a real position is held.
    await inBotId(id, (bot) => bot.onPriceUpdate({ pair: TEST_PAIR, price: m("100"), at: clock }));
    const base = exchange.placed[0]!.clientOrderId;
    await inBotId(id, (bot) => bot.onFill(base, exchange.fillFor(base)));
    await inBotId(id, (bot) => bot.halt("manual", "operator review", HUMAN));

    exchange.currentPrice = m("100");
    const res = await api("POST", `/api/bots/${id}/liquidate`);
    expect(res.status).toBe(200);
    expect(res.body.data.result).toMatchObject({ status: "halted", action: "liquidating" });
    // A sell was placed and the human actor is on the audit entry.
    expect(exchange.placed.some((o) => o.side === "sell")).toBe(true);
    const audit = await db.auditLog.findMany({ where: { action: "bot.liquidated" } });
    expect(audit[0]!.actor).toBe(HUMAN);
  });
});

// ---------------------------------------------------------------------------
// Apply missed fills (step 18's repair) -- the endpoint, over the wire
//
// `BotInstance.applyMissedFills` has its own tests (bot-instance.test.ts,
// grid-bot-instance.test.ts). These are the ENDPOINT's, added with its dashboard
// control: every one of them asserts a fact the UI states to an operator, so a
// backend change that made the copy a lie would fail here rather than silently
// on screen.
// ---------------------------------------------------------------------------

describe("apply missed fills", () => {
  /**
   * A halted DCA bot with one order it still believes open -- the shape of the
   * 2026-07-31 incident. The cancellation is forced to fail exactly as it did
   * live, so the order stays believed-open rather than being recorded cancelled.
   */
  async function haltedWithRestingOrder(id: string, account: string): Promise<string> {
    await seedBalance(account);
    await createDcaBot(id, account);
    await inBotId(id, (bot) => bot.start(HUMAN));
    await inBotId(id, (bot) => bot.onPriceUpdate({ pair: TEST_PAIR, price: m("100"), at: clock }));
    const clientOrderId = exchange.placed[0]!.clientOrderId;
    exchange.nextCancelFailure = { kind: "exchange_error", message: "could not read response" };
    await inBotId(id, (bot) => bot.halt("manual", "reconciliation found drift", HUMAN));
    return clientOrderId;
  }

  it("returns exactly what it corrected, leaves the bot halted, and audits the human", async () => {
    const account = `acct-${suffix}`;
    const id = `amf${suffix}`;
    const clientOrderId = await haltedWithRestingOrder(id, account);
    const resting = exchange.resting.get(clientOrderId)!.request;
    exchange.fillsByOrder.set(clientOrderId, [
      {
        // The exchange's OWN id, as `include_trades` reports it. Never synthesised.
        fillId: "gemini-tid-4242",
        price: resting.price,
        quantity: resting.quantity,
        feeAmount: 0n,
        feeAsset: "USDT",
        executedAt: clock + 1000,
      },
    ]);

    const res = await api("POST", `/api/bots/${id}/apply-missed-fills`);

    expect(res.status).toBe(200);
    // The dashboard renders these four fields per applied fill, and the two
    // money fields as decimal strings -- not numbers.
    expect(res.body.data.result.applied).toEqual([
      {
        clientOrderId,
        fillId: "gemini-tid-4242",
        quantity: toDecimalString(resting.quantity),
        price: toDecimalString(resting.price),
      },
    ]);
    expect(res.body.data.result.skipped).toEqual([]);
    // It never resumes: halted before, halted after, in the result AND the
    // refreshed bot the response carries.
    expect(res.body.data.result.status).toBe("halted");
    expect(res.body.data.bot).toMatchObject({ id, status: "halted" });

    // The books actually moved: the order is filled and the trade row exists.
    const row = await db.orders.findOne({ client_order_id: clientOrderId });
    expect(row!.status).toBe("filled");
    expect(await db.trades.count({ bot_instance_id: id })).toBe(1);

    // And the actor is the verified human, not "cron" -- the reason this is an
    // Access-gated endpoint rather than part of reconciliation.
    const audit = await db.auditLog.findMany({ where: { action: "bot.missed_fills_applied" } });
    expect(audit).toHaveLength(1);
    expect(audit[0]!.actor).toBe(HUMAN);
  });

  it("refuses on a bot that is not halted, surfacing invalid_status (409)", async () => {
    // The refusal the dashboard mirrors BEFORE sending: a repair must not race
    // the bot's own pipeline.
    const account = `acct-${suffix}`;
    await seedBalance(account);
    const id = `amfr${suffix}`;
    await createDcaBot(id, account);
    await inBotId(id, (bot) => bot.start(HUMAN)); // running

    const res = await api("POST", `/api/bots/${id}/apply-missed-fills`);

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("invalid_status");
    expect(await db.trades.count({ bot_instance_id: id })).toBe(0);
  });

  it("reports an unreadable order in `skipped` as a 200 -- a success is not a repair", async () => {
    // The distinction the UI must not flatten: this is HTTP 200 with nothing
    // applied. A frontend that only awaited success would call it done.
    const account = `acct-${suffix}`;
    const id = `amfu${suffix}`;
    await haltedWithRestingOrder(id, account);
    exchange.orderStatusFailure = { kind: "transport", message: "connection reset" };

    const res = await api("POST", `/api/bots/${id}/apply-missed-fills`);

    expect(res.status).toBe(200);
    expect(res.body.data.result.applied).toEqual([]);
    expect(res.body.data.result.skipped.join(" ")).toContain("connection reset");
    expect(await db.trades.count({ bot_instance_id: id })).toBe(0);
  });

  it("distinguishes 'no per-fill detail reported' from 'nothing filled'", async () => {
    // The venue answered, but carried no `trades`. There is no real fill id to
    // apply, so the order is reported as UNREAD rather than treated as unfilled.
    const account = `acct-${suffix}`;
    const id = `amfn${suffix}`;
    await haltedWithRestingOrder(id, account);

    const res = await api("POST", `/api/bots/${id}/apply-missed-fills`);

    expect(res.status).toBe(200);
    expect(res.body.data.result.applied).toEqual([]);
    expect(res.body.data.result.skipped.join(" ")).toContain("no per-fill detail");
  });

  it("is idempotent over the wire: a second call applies nothing and double-counts nothing", async () => {
    // The dashboard's "outcome unknown -- retrying is safe" copy is a claim about
    // this. It holds because `applyFill` deduplicates on the exchange's fill id.
    const account = `acct-${suffix}`;
    const id = `amfi${suffix}`;
    const clientOrderId = await haltedWithRestingOrder(id, account);
    exchange.fillsByOrder.set(clientOrderId, [
      exchange.fillFor(clientOrderId, { fillId: "gemini-tid-9" }),
    ]);

    const first = await api("POST", `/api/bots/${id}/apply-missed-fills`);
    const second = await api("POST", `/api/bots/${id}/apply-missed-fills`);

    expect(first.body.data.result.applied).toHaveLength(1);
    expect(second.status).toBe(200);
    expect(second.body.data.result.applied).toEqual([]);
    expect(await db.trades.count({ bot_instance_id: id })).toBe(1);
  });

  it("on a GRID bot, records the fill and places NO replacement order", async () => {
    // The claim the grid confirmation dialog makes, asserted through the real
    // endpoint: the paired sell a normal fill would have placed is suppressed,
    // because placing a live order from a correction path on a halted bot would
    // be resuming trading through the back door.
    const account = `acct-${suffix}`;
    await seedBalance(account);
    const id = `amfg${suffix}`;
    await inBotId(id, (bot) =>
      bot.createGrid({
        botInstanceId: id,
        accountLabel: account,
        exchange: "binance",
        pair: TEST_PAIR,
        capitalAsset: "USDT",
        allocatedCapital: m("500"),
        params: gridParams,
        actor: HUMAN,
      }),
    );
    await inBotId(id, (bot) => bot.start(HUMAN));
    await inBotId(id, (bot) => bot.onPriceUpdate({ pair: TEST_PAIR, price: m("100"), at: clock }));
    const buy = exchange.placed.find((order) => order.side === "buy")!.clientOrderId;
    // Every cancellation fails, as it did live, so the ladder stays intact.
    exchange.cancelFailure = { kind: "exchange_error", message: "could not read response" };
    await inBotId(id, (bot) => bot.halt("manual", "reconciliation found drift", HUMAN));

    const placedBefore = exchange.placed.length;
    exchange.fillsByOrder.set(buy, [exchange.fillFor(buy, { fillId: "gemini-tid-500" })]);

    const res = await api("POST", `/api/bots/${id}/apply-missed-fills`);

    expect(res.status).toBe(200);
    expect(res.body.data.result.applied).toHaveLength(1);
    expect(res.body.data.result.applied[0].fillId).toBe("gemini-tid-500");
    // Nothing new reached the exchange -- the ladder comes back a rung short.
    expect(exchange.placed).toHaveLength(placedBefore);
    expect(res.body.data.result.status).toBe("halted");
  });
});

// ---------------------------------------------------------------------------
// Check open orders (step 22): the manual observation pass
// ---------------------------------------------------------------------------

describe("check open orders", () => {
  /** A RUNNING bot with one resting, unfilled base order. */
  async function runningWithRestingOrder(id: string, account: string): Promise<string> {
    await seedBalance(account);
    await createDcaBot(id, account);
    await inBotId(id, (bot) => bot.start(HUMAN));
    await inBotId(id, (bot) => bot.onPriceUpdate({ pair: TEST_PAIR, price: m("100"), at: clock }));
    return exchange.placed[0]!.clientOrderId;
  }

  it("folds a resting fill on a RUNNING bot and audits the verified human", async () => {
    // The difference from `apply-missed-fills` that matters most: this one's
    // NORMAL case is a running bot. The repair refuses anything but halted.
    const account = `acct-${suffix}`;
    const id = `coc${suffix}`;
    const clientOrderId = await runningWithRestingOrder(id, account);
    const resting = exchange.resting.get(clientOrderId)!.request;
    exchange.fillsByOrder.set(clientOrderId, [
      {
        fillId: "gemini-tid-7788",
        price: resting.price,
        quantity: resting.quantity,
        feeAmount: 0n,
        feeAsset: "USDT",
        executedAt: clock + 1000,
      },
    ]);

    const res = await api("POST", `/api/bots/${id}/check-open-orders`);

    expect(res.status).toBe(200);
    expect(res.body.data.result.status).toBe("running");
    expect(res.body.data.result.applied).toEqual([
      {
        clientOrderId,
        fillId: "gemini-tid-7788",
        quantity: toDecimalString(resting.quantity),
        price: toDecimalString(resting.price),
      },
    ]);
    expect(res.body.data.result.skipped).toEqual([]);
    expect(res.body.data.result.closed).toEqual([]);
    // The field three empty arrays cannot otherwise be distinguished from.
    expect(res.body.data.result.deferred).toBe(false);
    expect(res.body.data.bot).toMatchObject({ id, status: "running" });

    // The books really moved, through the ordinary live path.
    const row = await db.orders.findOne({ client_order_id: clientOrderId });
    expect(row!.status).toBe("filled");
    expect(await db.trades.count({ bot_instance_id: id })).toBe(1);

    // A real person, not "system" -- the whole reason this is Access-gated
    // rather than only an alarm.
    const audit = await db.auditLog.findMany({ where: { action: "bot.open_orders_checked" } });
    expect(audit).toHaveLength(1);
    expect(audit[0]!.actor).toBe(HUMAN);
  });

  it("is allowed on a HALTED bot and places nothing", async () => {
    // Step 19: observing a halted bot is safe and useful, because a halt whose
    // cancellation failed leaves live orders on the exchange while a human is
    // deciding about exactly those books.
    const account = `acct-${suffix}`;
    const id = `coch${suffix}`;
    await runningWithRestingOrder(id, account);
    exchange.cancelFailure = { kind: "exchange_error", message: "could not read response" };
    await inBotId(id, (bot) => bot.halt("manual", "reconciliation found drift", HUMAN));
    exchange.cancelFailure = null;
    const placedBefore = exchange.placed.length;

    const res = await api("POST", `/api/bots/${id}/check-open-orders`);

    expect(res.status).toBe(200);
    expect(res.body.data.result.status).toBe("halted");
    expect(exchange.placed).toHaveLength(placedBefore);
  });

  it("refuses a STOPPED bot with invalid_status (409)", async () => {
    // Its capital is released, so a pass would be work whose result nothing may
    // use. This is the refusal the dashboard mirrors before sending.
    const account = `acct-${suffix}`;
    const id = `cocs${suffix}`;
    await runningWithRestingOrder(id, account);
    await inBotId(id, (bot) => bot.close(HUMAN));

    const res = await api("POST", `/api/bots/${id}/check-open-orders`);

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("invalid_status");
  });

  it("reports an unreadable order in `skipped` as a 200 -- a success is not a clean bill of health", async () => {
    const account = `acct-${suffix}`;
    const id = `cocu${suffix}`;
    await runningWithRestingOrder(id, account);
    exchange.orderStatusFailure = { kind: "transport", message: "connection reset" };

    const res = await api("POST", `/api/bots/${id}/check-open-orders`);

    expect(res.status).toBe(200);
    expect(res.body.data.result.applied).toEqual([]);
    expect(res.body.data.result.skipped.join(" ")).toContain("connection reset");
    expect(await db.trades.count({ bot_instance_id: id })).toBe(0);
  });

  it("surfaces the tick-staleness alert a pass raised, on the bot the operator is looking at", async () => {
    // The end-to-end shape of step 22: the alert is bot-scoped (unlike the
    // feed's own `price_feed_blind`, which carries a null bot id by design), so
    // it reaches the bot's detail payload and the control that answers it.
    const account = `acct-${suffix}`;
    const id = `cocp${suffix}`;
    await runningWithRestingOrder(id, account);
    clock += 600_000;
    exchange.now = clock;

    const res = await api("POST", `/api/bots/${id}/check-open-orders`);
    expect(res.status).toBe(200);

    const detail = await api("GET", `/api/bots/${id}`);
    const stale = detail.body.data.alerts.filter(
      (alert: { alertType: string }) => alert.alertType === "price_updates_stale",
    );
    expect(stale).toHaveLength(1);
    expect(stale[0].resolved).toBe(false);
    expect(stale[0].severity).toBe("warning");
  });

  it("405s on GET, so the wrong method is not a missing endpoint", async () => {
    const res = await api("GET", `/api/bots/whatever/check-open-orders`);
    expect(res.status).toBe(405);
  });
});

// ---------------------------------------------------------------------------
// Closing (step 26.1)
//
// `BotInstance.close()` and `releaseBotCapital` have existed and been tested
// since steps 6 and 5 -- with NO ROUTE TO THEM. Nothing outside the test suite
// could reach either, which meant the `stopped` status was unreachable in
// production and an allocation, once made, could never be returned. This block
// covers the route that fixes that, and the one gate it adds on top.
// ---------------------------------------------------------------------------

describe("closing", () => {
  async function haltedFlatBot(id: string, account: string): Promise<void> {
    await seedBalance(account);
    await createDcaBot(id, account);
    await inBotId(id, (bot) => bot.start(HUMAN));
    await inBotId(id, (bot) => bot.halt("manual", "done", HUMAN));
  }

  it("closes a flat bot and returns its capital to the account", async () => {
    const account = `acct-${suffix}`;
    const id = `cl${suffix}`;
    await haltedFlatBot(id, account);
    expect(
      (await db.capitalLedger.findOne({ account_label: account, asset: "USDT" }))!.total_allocated,
    ).toBe(m("500"));

    const res = await api("POST", `/api/bots/${id}/close`);

    expect(res.status).toBe(200);
    expect(res.body.data.result).toMatchObject({ status: "stopped", action: "closed" });
    expect(res.body.data.bot).toMatchObject({ id, status: "stopped" });
    expect(
      (await db.capitalLedger.findOne({ account_label: account, asset: "USDT" }))!.total_allocated,
    ).toBe(m("0"));
    expect(await db.auditLog.count({ action: "capital.released" })).toBe(1);
    // It does NOT archive. The two actions are separate, and closing leaves the
    // bot visible on the list -- which is the safe direction if the operator
    // meant to archive and only got halfway.
    expect((await db.botInstances.findOne({ id }))!.archived).toBe(false);
  });

  it("refuses a bot that still holds a position, and sells nothing", async () => {
    const account = `acct-${suffix}`;
    const id = `clh${suffix}`;
    await seedBalance(account);
    await createDcaBot(id, account);
    await inBotId(id, (bot) => bot.start(HUMAN));
    await inBotId(id, (bot) => bot.onPriceUpdate({ pair: TEST_PAIR, price: m("100"), at: clock }));
    const clientOrderId = exchange.placed[0]!.clientOrderId;
    const resting = exchange.resting.get(clientOrderId)!.request;
    exchange.nextCancelFailure = { kind: "exchange_error", message: "could not read response" };
    await inBotId(id, (bot) => bot.halt("manual", "done", HUMAN));
    exchange.fillsByOrder.set(clientOrderId, [
      {
        fillId: `gemini-tid-${id}`,
        price: resting.price,
        quantity: resting.quantity,
        feeAmount: m("0.1"),
        feeAsset: "USDT",
        executedAt: clock + 1000,
      },
    ]);
    await api("POST", `/api/bots/${id}/apply-missed-fills`);
    const placedBefore = exchange.placed.length;

    const res = await api("POST", `/api/bots/${id}/close`);

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("position_held");
    // Nothing released, nothing sold, status untouched.
    expect((await db.botInstances.findOne({ id }))!.status).toBe("halted");
    expect(
      (await db.capitalLedger.findOne({ account_label: account, asset: "USDT" }))!.total_allocated,
    ).toBe(m("500"));
    expect(await db.auditLog.count({ action: "capital.released" })).toBe(0);
    expect(exchange.placed.length).toBe(placedBefore);
  });

  it("refuses a second close rather than releasing the same capital twice", async () => {
    const account = `acct-${suffix}`;
    const id = `cl2${suffix}`;
    await haltedFlatBot(id, account);
    expect((await api("POST", `/api/bots/${id}/close`)).status).toBe(200);

    const second = await api("POST", `/api/bots/${id}/close`);

    // The ledger's own mutual exclusion, surfaced rather than swallowed.
    expect(second.status).toBeGreaterThanOrEqual(400);
    expect(
      (await db.capitalLedger.findOne({ account_label: account, asset: "USDT" }))!.total_allocated,
    ).toBe(m("0"));
    expect(await db.auditLog.count({ action: "capital.released" })).toBe(1);
  });

  it("404s an unknown bot without creating anything", async () => {
    const res = await api("POST", `/api/bots/nope${suffix}/close`);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("unknown_bot");
    expect(await db.botInstances.count()).toBe(0);
  });

  it("405s on GET, so the wrong method is not a missing endpoint", async () => {
    expect((await api("GET", `/api/bots/whatever/close`)).status).toBe(405);
  });
});

// ---------------------------------------------------------------------------
// Archiving (step 26, and step 26.1 which changed what it MEANS)
//
// ⚠ THE GUARANTEE THIS BLOCK TESTS WAS DELIBERATELY SPLIT IN TWO AT STEP 26.1,
// AND BOTH HALVES ARE INTENTIONAL. Step 26 built archiving as one boolean and
// this block's headline test asserted the whole claim in one line: "archiving
// removes nothing", proved by deep-comparing the entire detail payload across an
// archive. That claim is now FALSE for one specific thing and still TRUE for
// everything else, so it is two tests instead of one:
//
//   1. NOTHING IS DELETED -- still true, still structural, and still proved by
//      the same deep comparison. History, strategy state and configuration all
//      survive an archive untouched. See "refused archive changes nothing at
//      all", which now carries that deep compare, and the retained-history
//      assertions inside the success case.
//   2. THE STATUS AND THE ALLOCATION DO CHANGE -- new, and the point of the
//      step. Archiving closes the bot: `halted` becomes `stopped` and the
//      capital returns to the ledger. See "archives a FLAT halted bot".
//
// A future reader finding the old one-line claim in decision log 26 should read
// this comment as the amendment, not assume a test was weakened. The deep
// compare was not deleted; it moved to the case where the old guarantee still
// holds completely -- a REFUSED archive, which must still touch nothing.
//
// The rest of the block is unchanged in intent: archiving must not remove a row,
// must not let a hidden bot start trading, and must stay idempotent.
// ---------------------------------------------------------------------------

describe("archiving", () => {
  /** A halted DCA bot with a FLAT position -- the ordinary archivable case. */
  async function haltedBot(id: string, account: string): Promise<void> {
    await seedBalance(account);
    await createDcaBot(id, account);
    await inBotId(id, (bot) => bot.start(HUMAN));
    await inBotId(id, (bot) => bot.halt("manual", "done experimenting", HUMAN));
  }

  /**
   * A halted DCA bot that IS still holding base asset.
   *
   * The position is built the honest way -- a real resting buy, a real fill
   * folded through the real `apply-missed-fills` endpoint -- rather than by
   * writing state, so the gate is exercised against a position the system
   * actually produced. The cancellation is failed on purpose so the order stays
   * believed-open through the halt and there is something for the fill to land
   * on.
   */
  async function haltedBotHoldingPosition(id: string, account: string): Promise<void> {
    await seedBalance(account);
    await createDcaBot(id, account);
    await inBotId(id, (bot) => bot.start(HUMAN));
    await inBotId(id, (bot) => bot.onPriceUpdate({ pair: TEST_PAIR, price: m("100"), at: clock }));
    const clientOrderId = exchange.placed[0]!.clientOrderId;
    const resting = exchange.resting.get(clientOrderId)!.request;
    exchange.nextCancelFailure = { kind: "exchange_error", message: "could not read response" };
    await inBotId(id, (bot) => bot.halt("manual", "finished with this experiment", HUMAN));
    exchange.fillsByOrder.set(clientOrderId, [
      {
        fillId: `gemini-tid-${id}`,
        price: resting.price,
        quantity: resting.quantity,
        feeAmount: m("0.1"),
        feeAsset: "USDT",
        executedAt: clock + 1000,
      },
    ]);
    await api("POST", `/api/bots/${id}/apply-missed-fills`);
  }

  /**
   * ⚠ THE HALF OF THE OLD GUARANTEE THAT WAS DELIBERATELY REVERSED (step 26.1).
   *
   * Step 26's version of this test was named "archives a halted bot, LEAVING ITS
   * STATUS AND EVERYTHING ELSE ALONE" and asserted `status: "halted"` and
   * `allocated_capital` still reserved after the archive. Both assertions were
   * correct then and are wrong now, on purpose: archiving a finished bot that is
   * holding nothing now closes it, because capital reserved for a finished bot
   * is capital no new bot can spend.
   *
   * What did NOT change is asserted here too, in the same test, so the two are
   * impossible to confuse: the row still exists, the allocation column still
   * carries its historical figure, the halt reason survives, and the object's
   * own history is untouched. Retiring a bot is not erasing one.
   */
  it("archives a FLAT halted bot: it is CLOSED, its capital returns, and nothing is deleted", async () => {
    const account = `acct-${suffix}`;
    const id = `ar${suffix}`;
    await haltedBot(id, account);
    const before = (await api("GET", `/api/bots/${id}`)).body.data;
    expect(Number(before.position.heldQuantity)).toBe(0);
    // The capital is genuinely reserved before the archive, or the release below
    // would be proving nothing.
    expect(
      (await db.capitalLedger.findOne({ account_label: account, asset: "USDT" }))!.total_allocated,
    ).toBe(m("500"));

    const res = await api("POST", `/api/bots/${id}/archive`);

    expect(res.status).toBe(200);
    expect(res.body.data.result).toEqual({ action: "archived", capitalReleased: true });
    expect(res.body.data.bot).toMatchObject({ id, archived: true, status: "stopped" });

    const row = await db.botInstances.findOne({ id });
    expect(row!.archived).toBe(true);
    // THE CHANGE: the status moved, and it moved via `releaseBotCapital`, which
    // is the only writer of this value in the whole system.
    expect(row!.status).toBe("stopped");
    // THE POINT: the account's allocation is back to zero and available.
    const ledger = await db.capitalLedger.findOne({ account_label: account, asset: "USDT" });
    expect(ledger!.total_allocated).toBe(m("0"));
    expect(await db.auditLog.count({ action: "capital.released" })).toBe(1);
    expect(await db.auditLog.count({ action: "bot.closed" })).toBe(1);

    // WHAT DID NOT CHANGE. `allocated_capital` keeps its historical figure --
    // it is never zeroed, it has a CHECK (> 0), and `status` is what records
    // that the reservation was returned.
    expect(row!.allocated_capital).toBe(m("500"));
    expect(row!.halt_reason).toContain("manual");
    // And the bot's own record is intact and still readable.
    const after = (await api("GET", `/api/bots/${id}`)).body.data;
    expect(after.config).not.toBeNull();
    expect(after.state).not.toBeNull();
    expect(after.orders.length).toBe(before.orders.length);
    expect(after.trades.length).toBe(before.trades.length);

    const audit = await db.auditLog.findMany({ where: { action: "bot.archived" } });
    expect(audit).toHaveLength(1);
    expect(audit[0]!.actor).toBe(HUMAN);
    expect(audit[0]!.target_bot_instance_id).toBe(id);
    // `status` records what the GATE saw (pre-close), and `capital_released`
    // records what this action did -- neither is recoverable from the row after.
    expect(audit[0]!.details_json).toMatchObject({
      status: "halted",
      account_label: account,
      capital_released: true,
    });
  });

  it("archives an already-stopped bot without releasing its capital a second time", async () => {
    const account = `acct-${suffix}`;
    const id = `as${suffix}`;
    await haltedBot(id, account);
    // Closed through the endpoint this step exposed, rather than by reaching
    // into the object -- the release has already happened before the archive.
    expect((await api("POST", `/api/bots/${id}/close`)).status).toBe(200);
    expect((await db.botInstances.findOne({ id }))!.status).toBe("stopped");
    expect(await db.auditLog.count({ action: "capital.released" })).toBe(1);

    const res = await api("POST", `/api/bots/${id}/archive`);

    expect(res.status).toBe(200);
    // `capitalReleased: false` is the load-bearing assertion. A second release
    // would have thrown `bot_already_stopped`; reporting `true` here would be
    // this endpoint claiming credit for capital it did not return.
    expect(res.body.data.result).toEqual({ action: "archived", capitalReleased: false });
    expect((await db.botInstances.findOne({ id }))!.archived).toBe(true);
    expect(await db.auditLog.count({ action: "capital.released" })).toBe(1);
    expect(await db.auditLog.count({ action: "bot.closed" })).toBe(1);
  });

  it("refuses a running bot, and changes nothing at all", async () => {
    const account = `acct-${suffix}`;
    const id = `arun${suffix}`;
    await seedBalance(account);
    await createDcaBot(id, account);
    await inBotId(id, (bot) => bot.start(HUMAN));

    const res = await api("POST", `/api/bots/${id}/archive`);

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("invalid_status");
    // The message has to say what IS allowed, since the operator's next move is
    // to halt it first.
    expect(res.body.error.message).toContain("halted or stopped");
    const row = await db.botInstances.findOne({ id });
    expect(row!.archived).toBe(false);
    expect(row!.status).toBe("running");
    expect(await db.auditLog.count({ action: "bot.archived" })).toBe(0);
  });

  it("refuses a `created` bot, which the backend could accept but deliberately does not", async () => {
    const account = `acct-${suffix}`;
    const id = `acr${suffix}`;
    await seedBalance(account);
    await createDcaBot(id, account);

    const res = await api("POST", `/api/bots/${id}/archive`);

    // A bot that has never started is not finished with, it is not started.
    // Pinned so the scope choice stays legible rather than looking accidental
    // (the same reason step 23 pinned `HaltAction` refusing `created`).
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("invalid_status");
    expect((await db.botInstances.findOne({ id }))!.archived).toBe(false);
  });

  it("is idempotent: archiving twice writes one audit entry, not two", async () => {
    const account = `acct-${suffix}`;
    const id = `aid${suffix}`;
    await haltedBot(id, account);

    const first = await api("POST", `/api/bots/${id}/archive`);
    expect(first.body.data.result).toEqual({ action: "archived", capitalReleased: true });
    const second = await api("POST", `/api/bots/${id}/archive`);

    // Not an error -- a double-click is harmless, as it is for halt.
    expect(second.status).toBe(200);
    expect(second.body.data.result).toEqual({ action: "already_archived", capitalReleased: false });
    expect(second.body.data.bot.archived).toBe(true);
    expect(await db.auditLog.count({ action: "bot.archived" })).toBe(1);
    // And the release is idempotent too: the repeat must not attempt a second
    // close, which would surface `bot_already_stopped` as a failed archive.
    expect(await db.auditLog.count({ action: "capital.released" })).toBe(1);
    expect(await db.auditLog.count({ action: "bot.closed" })).toBe(1);
  });

  it("unarchives, and reports a bot that was not archived rather than failing", async () => {
    const account = `acct-${suffix}`;
    const id = `aun${suffix}`;
    await haltedBot(id, account);
    await api("POST", `/api/bots/${id}/archive`);

    const res = await api("POST", `/api/bots/${id}/unarchive`);
    expect(res.status).toBe(200);
    expect(res.body.data.result).toEqual({ action: "unarchived" });
    // `stopped`, not `halted`: the archive above closed it. Unarchiving is still
    // purely a visibility change -- it does NOT re-allocate capital and does not
    // move the status back, which is exactly why the bot comes back stopped.
    expect(res.body.data.bot).toMatchObject({ archived: false, status: "stopped" });
    expect((await db.botInstances.findOne({ id }))!.archived).toBe(false);
    expect(await db.auditLog.count({ action: "bot.unarchived" })).toBe(1);

    // Unarchiving resumes nothing and RE-ALLOCATES nothing: the bot comes back
    // exactly as stopped as the archive left it, with its capital still returned
    // to the account. Re-funding a closed bot is not built (that is the next
    // step's problem, deliberately out of scope here), so this is the honest
    // assertion rather than an aspirational one.
    expect((await db.botInstances.findOne({ id }))!.status).toBe("stopped");
    expect(
      (await db.capitalLedger.findOne({ account_label: account, asset: "USDT" }))!.total_allocated,
    ).toBe(m("0"));

    const again = await api("POST", `/api/bots/${id}/unarchive`);
    expect(again.status).toBe(200);
    expect(again.body.data.result).toEqual({ action: "not_archived" });
    expect(await db.auditLog.count({ action: "bot.unarchived" })).toBe(1);
  });

  /**
   * The reversing half must have NO status gate, and this is the only test that
   * can see that -- every bot reachable through the archive endpoint is halted
   * or stopped, so a gate copied from `archive` would pass every other test in
   * this block unnoticed.
   *
   * The flag is written directly to reach the case, the same way the `start`
   * gate's test does. A bot archived in a status archiving would now refuse is
   * exactly the one that must not be strandable: if unarchive could refuse it
   * too, it would be hidden with no way back, which is the one outcome this
   * feature must never produce.
   */
  it("unarchives from a status that archiving itself would refuse, so nothing can be stranded", async () => {
    const account = `acct-${suffix}`;
    const id = `astr${suffix}`;
    await seedBalance(account);
    await createDcaBot(id, account);
    expect((await db.botInstances.findOne({ id }))!.status).toBe("created");
    // Archiving refuses this status, so an unarchive that reused the same gate
    // would refuse it too -- which is the whole point of the case.
    expect((await api("POST", `/api/bots/${id}/archive`)).status).toBe(409);
    // So the flag is written directly to reach a state the endpoint declines to
    // produce.
    await db.botInstances.update({ id }, { archived: true });

    // In this state the SAME archive call now succeeds as a no-op rather than
    // refusing: idempotence must not depend on the status, or a bot could be
    // both already hidden and refused for the state it is already in.
    const repeat = await api("POST", `/api/bots/${id}/archive`);
    expect(repeat.status).toBe(200);
    expect(repeat.body.data.result).toEqual({ action: "already_archived", capitalReleased: false });

    const res = await api("POST", `/api/bots/${id}/unarchive`);

    expect(res.status).toBe(200);
    expect(res.body.data.result).toEqual({ action: "unarchived" });
    expect((await db.botInstances.findOne({ id }))!.archived).toBe(false);
  });

  it("404s an unknown bot on both endpoints, without creating anything", async () => {
    const archive = await api("POST", `/api/bots/nope${suffix}/archive`);
    expect(archive.status).toBe(404);
    expect(archive.body.error.code).toBe("unknown_bot");

    const unarchive = await api("POST", `/api/bots/nope${suffix}/unarchive`);
    expect(unarchive.status).toBe(404);
    expect(unarchive.body.error.code).toBe("unknown_bot");
    expect(await db.botInstances.count()).toBe(0);
  });

  /**
   * ⚠ HALF OF STEP 26's HEADLINE CLAIM, PRESERVED EXACTLY -- and now attached to
   * the case where it is still completely true.
   *
   * Step 26 asserted "archiving removes NOTHING" by deep-comparing the entire
   * `GET /api/bots/:id` payload across an archive, with only `archived` and
   * `updatedAt` permitted to differ. Step 26.1 made that false for a SUCCESSFUL
   * archive -- the status and the allocation now change on purpose -- but it is
   * still exactly true for a REFUSED one, and a refusal that quietly did half
   * the work would be far worse than the old behaviour.
   *
   * So the deep compare is not deleted and not weakened; it is pointed at the
   * refusal, where "nothing moved" is still the whole requirement. The bot used
   * here is the very bot step 26 used -- one with real orders, trades and alerts
   * -- and it is now the bot the gate refuses, because building real history for
   * a DCA bot means giving it a real position.
   *
   * The three history assertions BEFORE the call are not decoration. Without
   * them this test would pass just as happily against a bot with no history at
   * all, comparing two empty arrays and proving nothing.
   */
  it("refused archive changes nothing at all: the whole detail payload survives intact", async () => {
    const account = `acct-${suffix}`;
    const id = `akeep${suffix}`;
    await haltedBotHoldingPosition(id, account);

    const before = (await api("GET", `/api/bots/${id}`)).body.data;
    // There is genuinely something to lose.
    expect(before.orders.length).toBeGreaterThan(0);
    expect(before.trades.length).toBeGreaterThan(0);
    expect(before.alerts.length).toBeGreaterThan(0);
    expect(before.state).not.toBeNull();
    expect(before.config).not.toBeNull();
    expect(before.archived).toBe(false);
    // And it is genuinely holding something, which is why it gets refused.
    expect(Number(before.position.heldQuantity)).toBeGreaterThan(0);

    const refused = await api("POST", `/api/bots/${id}/archive`);
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe("position_held");

    const after = (await api("GET", `/api/bots/${id}`)).body.data;
    // NOT ONE FIELD may differ here -- not even `updatedAt`, because unlike the
    // step 26 version nothing was written at all.
    expect(after).toStrictEqual(before);

    // And the same again through the row counts, which the payload's own
    // ordering and limits cannot hide.
    expect(await db.orders.count({ bot_instance_id: id })).toBe(before.orders.length);
    expect(await db.trades.count({ bot_instance_id: id })).toBe(before.trades.length);
    expect(await db.alerts.count({ bot_instance_id: id })).toBe(before.alerts.length);
    // The capital allocation is untouched -- a refused archive releases nothing.
    const ledger = await db.capitalLedger.findOne({ account_label: account, asset: "USDT" });
    expect(ledger!.total_allocated).toBe(m("500"));
    expect(await db.auditLog.count({ action: "capital.released" })).toBe(0);
    expect(await db.auditLog.count({ action: "bot.archived" })).toBe(0);
  });

  /**
   * The gate's message must name the remedy, because the remedy is a DIFFERENT
   * button and the operator has no way to guess it from a 409 code.
   */
  it("names the held amount and points at liquidation, and never sells anything itself", async () => {
    const account = `acct-${suffix}`;
    const id = `amsg${suffix}`;
    await haltedBotHoldingPosition(id, account);
    const placedBefore = exchange.placed.length;

    const refused = await api("POST", `/api/bots/${id}/archive`);

    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe("position_held");
    expect(refused.body.error.message).toMatch(/liquidate/i);
    // The real held quantity, not a generic phrase.
    expect(refused.body.error.message).toContain(TEST_PAIR);
    // THE DECISION THIS ENCODES: the gate refuses, it never sells on the
    // operator's behalf. Not one order was placed.
    expect(exchange.placed.length).toBe(placedBefore);
  });

  it("refuses a GRID bot that is holding base asset, through the ladder rather than a DCA position", async () => {
    // The two strategies keep their held quantity in completely different
    // places (`state.position.quantity` vs `state.ladder.heldQuantity`), so a
    // gate that read only DCA's would pass every other test in this block while
    // letting every grid bot release capital over live inventory.
    const account = `acct-${suffix}`;
    const id = `agrid${suffix}`;
    await seedBalance(account);
    await inBotId(id, (bot) =>
      bot.createGrid({
        botInstanceId: id,
        accountLabel: account,
        exchange: "binance",
        pair: TEST_PAIR,
        capitalAsset: "USDT",
        allocatedCapital: m("500"),
        params: gridParams,
        actor: HUMAN,
      }),
    );
    await inBotId(id, (bot) => bot.start(HUMAN));
    await inBotId(id, (bot) => bot.onPriceUpdate({ pair: TEST_PAIR, price: m("100"), at: clock }));
    const buy = exchange.placed.find((order) => order.side === "buy")!.clientOrderId;
    exchange.cancelFailure = { kind: "exchange_error", message: "could not read response" };
    await inBotId(id, (bot) => bot.halt("manual", "done", HUMAN));
    exchange.fillsByOrder.set(buy, [exchange.fillFor(buy, { fillId: `gemini-tid-${id}` })]);
    await api("POST", `/api/bots/${id}/apply-missed-fills`);

    const detail = (await api("GET", `/api/bots/${id}`)).body.data;
    expect(detail.position.strategy).toBe("grid");
    expect(Number(detail.position.heldQuantity)).toBeGreaterThan(0);

    const refused = await api("POST", `/api/bots/${id}/archive`);

    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe("position_held");
    expect((await db.botInstances.findOne({ id }))!.status).toBe("halted");
    expect(
      (await db.capitalLedger.findOne({ account_label: account, asset: "USDT" }))!.total_allocated,
    ).toBe(m("500"));
  });

  /**
   * The ledger invariant, checked by RUNNING RECONCILIATION -- not by
   * re-deriving its arithmetic here.
   *
   * `reconcileAllocations` (src/reconciliation/reconcile.ts) compares
   * `capital_ledger.total_allocated` against `SUM(allocated_capital)` over bots
   * whose status is NOT `stopped`, and raises `ledger_allocation_drift` when
   * they disagree. That predicate names `status` and knows nothing about
   * `archived` -- so an archive that released capital WITHOUT also flipping the
   * status to `stopped` would leave reconciliation reporting drift on every run,
   * forever. This build releases through `close()`, which performs that flip, so
   * the bot leaves BOTH sides of the comparison at once.
   *
   * ⚠ WRITTEN THE SLOW WAY ON PURPOSE. The first version of this test summed
   * `allocated_capital` itself and compared it to the ledger -- which is the
   * invariant's arithmetic copied into the test, and would have agreed with a
   * bug in the real predicate just as happily as with a correct one. Building
   * the ports and calling `reconcileAccount` is more setup for exactly one
   * reason: it is the actual auditor that would page the operator.
   */
  it("leaves reconciliation's ledger invariant intact: a real reconciliation run finds no drift", async () => {
    const account = `acct-${suffix}`;
    const archivedId = `ainv${suffix}`;
    const survivorId = `aliv${suffix}`;
    await seedBalance(account, "10000");
    await createDcaBot(survivorId, account, "700");
    await haltedBot(archivedId, account);

    const reconcile = async () =>
      await reconcileAccount(
        {
          db,
          exchange,
          now: () => clock,
          newId: () => `rec-${(idCounter += 1)}`,
          haltBot: async () => {},
          snapshotBot: async (botInstanceId) =>
            await inBotId(botInstanceId, (bot) => bot.snapshotIfCreated()),
        },
        account,
      );

    // Clean before, or the "clean after" below would prove nothing -- the
    // vacuous-assertion failure this suite has hit more than once.
    const before = await reconcile();
    expect(before.findings.map((f) => f.kind)).not.toContain("ledger_allocation_drift");
    expect(
      (await db.capitalLedger.findOne({ account_label: account, asset: "USDT" }))!.total_allocated,
    ).toBe(m("1200"));

    expect((await api("POST", `/api/bots/${archivedId}/archive`)).status).toBe(200);
    expect(
      (await db.capitalLedger.findOne({ account_label: account, asset: "USDT" }))!.total_allocated,
    ).toBe(m("700"));

    /*
     * Still clean: the ledger fell by 500 and the summed side fell by 500 too,
     * because the archived bot is now `stopped` and drops out of the sum.
     *
     * ⚠ THIS ASSERTION COMES BEFORE THE STATUS ONE BELOW, DELIBERATELY. With the
     * order reversed, breaking the release so that it left the bot `halted`
     * failed on `expect(status).toBe("stopped")` -- a precondition -- and the
     * drift assertion never ran at all. The test would have reported a catch it
     * had not actually made. Reconciliation's verdict is this test's subject, so
     * it is the assertion that must fire first.
     */
    const after = await reconcile();
    expect(after.findings.map((f) => f.kind)).not.toContain("ledger_allocation_drift");

    // And the mechanism behind it: the bot left the sum by becoming `stopped`.
    expect((await db.botInstances.findOne({ id: archivedId }))!.status).toBe("stopped");

    // The survivor kept its reservation; only the archived bot's came back.
    expect((await db.botInstances.findOne({ id: survivorId }))!.status).toBe("created");
  });

  it("keeps archived bots in GET /api/bots, because hiding them is the view's job", async () => {
    const account = `acct-${suffix}`;
    const kept = `alive${suffix}`;
    const hidden = `ahid${suffix}`;
    await seedBalance(account, "20000");
    await createDcaBot(kept, account);
    await haltedBot(hidden, account);
    await api("POST", `/api/bots/${hidden}/archive`);

    const res = await api("GET", "/api/bots");

    // Both, always. The dashboard filters its table client-side so the
    // account-level totals keep counting an archived bot's allocation and
    // position -- a total that changed when a view toggle flipped would be the
    // silent omission step 25 exists to prevent.
    expect(res.body.data.map((b: any) => b.id).sort()).toEqual([kept, hidden].sort());
    expect(res.body.data.find((b: any) => b.id === hidden).archived).toBe(true);
    expect(res.body.data.find((b: any) => b.id === kept).archived).toBe(false);
  });

  /**
   * The `bot_archived` gate, on a bot that is archived but still HALTED.
   *
   * That combination is no longer what the archive endpoint produces -- it now
   * closes -- but it is emphatically still a real state: every bot archived
   * before this step shipped is sitting in it, and an orphan archived today
   * still lands there (it cannot be closed). So the flag is written directly to
   * reach it, and the "unarchive restores the resume path" half of this test,
   * which step 26 wrote, is preserved intact for exactly those bots.
   */
  it("refuses to resume an archived-but-halted bot, and unarchiving restores the path", async () => {
    const account = `acct-${suffix}`;
    const id = `ares${suffix}`;
    await haltedBot(id, account);
    await db.botInstances.update({ id }, { archived: true });

    const refused = await api("POST", `/api/bots/${id}/resume`);

    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe("bot_archived");
    // Refused BEFORE the object was called, so the bot is exactly as it was --
    // the property every one of resume's own refusals already has.
    const row = await db.botInstances.findOne({ id });
    expect(row!.status).toBe("halted");
    expect(await db.auditLog.count({ action: "bot.resumed" })).toBe(0);

    // And unarchiving restores the path, since nothing here is a one-way door.
    await api("POST", `/api/bots/${id}/unarchive`);
    const resumed = await api("POST", `/api/bots/${id}/resume`);
    expect(resumed.status).toBe(200);
    expect((await db.botInstances.findOne({ id }))!.status).toBe("running");
  });

  /**
   * `start`'s gate is unreachable through the archive endpoint TODAY -- a
   * `created` bot cannot be archived, and `start` accepts nothing else -- so
   * the flag is written directly here to reach it.
   *
   * It is not dead code: it becomes reachable the moment `created` joins
   * `ARCHIVABLE_STATUSES`, which the constant's own comment names as a
   * one-line change. Testing it now is what stops that change from silently
   * opening the "running and hidden" hole the resume gate exists to close.
   */
  it("refuses to start an archived bot, the gate that only matters if `created` is ever archivable", async () => {
    const account = `acct-${suffix}`;
    const id = `astart${suffix}`;
    await seedBalance(account);
    await createDcaBot(id, account);
    await db.botInstances.update({ id }, { archived: true });

    const res = await api("POST", `/api/bots/${id}/start`);

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("bot_archived");
    expect((await db.botInstances.findOne({ id }))!.status).toBe("created");
    expect(exchange.placed).toEqual([]);
  });

  /**
   * ⚠ THE CONSEQUENCE OF ARCHIVING NOW CLOSING, ASSERTED RATHER THAN LEFT TO BE
   * DISCOVERED IN PRODUCTION.
   *
   * Before this step, archive → unarchive → resume was a complete round trip:
   * archiving changed nothing, so the bot came back exactly as resumable as it
   * went in. It is not any more, and the reason is structural rather than a
   * missing feature. Archiving closes; closing sets `stopped`; `resume()`
   * accepts only `halted`; and nothing in this system moves a bot out of
   * `stopped`. So archiving is now the end of a bot's trading life.
   *
   * That is the intended meaning of the change -- a retired bot is retired --
   * but it is a one-way door and the operator must not meet it by surprise.
   * Re-funding a closed bot is a separate piece of work and is deliberately not
   * built here; this test pins the CURRENT truth so that work has something to
   * flip when it arrives.
   */
  it("cannot be resumed after archiving, even once unarchived: archiving closes, and closing is final", async () => {
    const account = `acct-${suffix}`;
    const id = `afin${suffix}`;
    await haltedBot(id, account);

    expect((await api("POST", `/api/bots/${id}/archive`)).status).toBe(200);
    expect((await db.botInstances.findOne({ id }))!.status).toBe("stopped");

    // Archived: refused by the archive gate, which runs first and never even
    // asks the object what its status is.
    const whileArchived = await api("POST", `/api/bots/${id}/resume`);
    expect(whileArchived.status).toBe(409);
    expect(whileArchived.body.error.code).toBe("bot_archived");

    await api("POST", `/api/bots/${id}/unarchive`);

    // Unarchived, and STILL refused -- now by the object itself, because it is
    // stopped rather than halted. This is the assertion that would have been
    // `expect(200)` before this step.
    const afterUnarchive = await api("POST", `/api/bots/${id}/resume`);
    expect(afterUnarchive.status).toBe(409);
    expect(afterUnarchive.body.error.code).toBe("invalid_status");
    expect((await db.botInstances.findOne({ id }))!.status).toBe("stopped");
    expect(await db.auditLog.count({ action: "bot.resumed" })).toBe(0);
    // Starting it is refused too, for its own reason: `start` takes `created`.
    expect((await api("POST", `/api/bots/${id}/start`)).status).toBe(409);
  });

  it("405s on GET, so the wrong method is not a missing endpoint", async () => {
    expect((await api("GET", `/api/bots/whatever/archive`)).status).toBe(405);
    expect((await api("GET", `/api/bots/whatever/unarchive`)).status).toBe(405);
  });
});

// ---------------------------------------------------------------------------
// Alerts (endpoint 5)
// ---------------------------------------------------------------------------

describe("alerts", () => {
  beforeEach(async () => {
    await db.alerts.insert(alertRow({ id: `al1-${suffix}`, category: "trading", severity: "critical", resolved: false, created_at: T0 + 1 }));
    await db.alerts.insert(alertRow({ id: `al2-${suffix}`, category: "system", severity: "warning", resolved: true, created_at: T0 + 2 }));
    await db.alerts.insert(alertRow({ id: `al3-${suffix}`, category: "trading", severity: "info", resolved: false, created_at: T0 + 3 }));
  });

  it("lists all alerts newest-first", async () => {
    const res = await api("GET", "/api/alerts");
    expect(res.status).toBe(200);
    expect(res.body.data.map((a: any) => a.id)).toEqual([`al3-${suffix}`, `al2-${suffix}`, `al1-${suffix}`]);
  });

  it("filters by category, severity and resolved", async () => {
    expect((await api("GET", "/api/alerts?category=system")).body.data).toHaveLength(1);
    expect((await api("GET", "/api/alerts?severity=critical")).body.data).toHaveLength(1);
    expect((await api("GET", "/api/alerts?resolved=false")).body.data.map((a: any) => a.id).sort()).toEqual(
      [`al1-${suffix}`, `al3-${suffix}`].sort(),
    );
  });

  it("400s an unknown filter value", async () => {
    const res = await api("GET", "/api/alerts?severity=nope");
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("invalid_filter");
  });
});

// ---------------------------------------------------------------------------
// Manual adjustments (endpoint 6)
// ---------------------------------------------------------------------------

describe("manual adjustments", () => {
  it("logs an adjustment and audits the actor (201)", async () => {
    const account = `acct-${suffix}`;
    const res = await api("POST", "/api/manual-adjustments", {
      body: { accountLabel: account, asset: "USDT", amount: "-200.5", note: "moved to cold storage" },
    });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ accountLabel: account, asset: "USDT", amount: "-200.50000000" });

    const rows = await db.manualAdjustments.findMany({ where: { account_label: account } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.amount).toBe(m("-200.5"));
    expect(rows[0]!.reconciled_at).toBeNull();

    const audit = await db.auditLog.findMany({ where: { action: "manual_adjustment.logged" } });
    expect(audit[0]!.actor).toBe(HUMAN);
  });

  it("400s a missing note", async () => {
    const res = await api("POST", "/api/manual-adjustments", {
      body: { accountLabel: `acct-${suffix}`, asset: "USDT", amount: "10" },
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("missing_field");
  });
});

// ---------------------------------------------------------------------------
// Circuit breakers (endpoints 7-8)
// ---------------------------------------------------------------------------

describe("circuit breakers", () => {
  it("reports armed by default and tripped after a trip", async () => {
    const account = `acct-${suffix}`;
    await seedBalance(account);

    let res = await api("GET", "/api/circuit-breakers");
    expect(res.body.data.find((b: any) => b.accountLabel === account)).toMatchObject({ state: "armed" });

    await tripAccountCircuitBreaker(db, {
      accountLabel: account,
      reason: "severe drift",
      runId: null,
      actor: "reconciliation",
      now: T0,
      haltBot: async () => undefined,
      newId: () => `cb-${(idCounter += 1)}`,
    });

    res = await api("GET", "/api/circuit-breakers");
    expect(res.body.data.find((b: any) => b.accountLabel === account)).toMatchObject({
      state: "tripped",
      reason: "severe drift",
    });
  });

  it("resets a tripped breaker (human-only) and re-arms it", async () => {
    const account = `acct-${suffix}`;
    await tripAccountCircuitBreaker(db, {
      accountLabel: account,
      reason: "severe drift",
      runId: null,
      actor: "reconciliation",
      now: T0,
      haltBot: async () => undefined,
      newId: () => `cb-${(idCounter += 1)}`,
    });

    const res = await api("POST", `/api/circuit-breakers/${account}/reset`, {
      body: { note: "investigated, keys rotated" },
    });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ accountLabel: account, state: "armed", resetBy: HUMAN });
  });

  it("409s a reset of an un-tripped breaker", async () => {
    const res = await api("POST", `/api/circuit-breakers/acct-${suffix}/reset`, {
      body: { note: "nothing to do" },
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("not_tripped");
  });
});

// ---------------------------------------------------------------------------
// Global kill switch (endpoints 9-11)
// ---------------------------------------------------------------------------

describe("global kill switch", () => {
  it("is armed by default", async () => {
    const res = await api("GET", "/api/kill-switch");
    expect(res.status).toBe(200);
    expect(res.body.data.state).toBe("armed");
  });

  it("trips, halting active bots on every account, then reads tripped, then resets", async () => {
    const account = `acct-${suffix}`;
    await seedBalance(account);
    const id = `k${suffix}`;
    await createDcaBot(id, account);
    await inBotId(id, (bot) => bot.start(HUMAN)); // running -> will be halted

    const trip = await api("POST", "/api/kill-switch/trigger", {
      body: { reason: "genuine emergency" },
    });
    expect(trip.status).toBe(200);
    expect(trip.body.data.result.haltedBotIds).toContain(id);
    expect(trip.body.data.killSwitch.state).toBe("tripped");
    expect(await isGloballyTripped(db)).toBe(true);

    const status = await api("GET", "/api/kill-switch");
    expect(status.body.data).toMatchObject({ state: "tripped", trippedBy: HUMAN });

    const reset = await api("POST", "/api/kill-switch/reset", { body: { note: "resolved" } });
    expect(reset.status).toBe(200);
    expect(reset.body.data.state).toBe("armed");
    expect(await isGloballyTripped(db)).toBe(false);
  });

  it("400s a trigger with no reason", async () => {
    const res = await api("POST", "/api/kill-switch/trigger", { body: {} });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("missing_field");
  });

  it("409s a reset when not tripped", async () => {
    const res = await api("POST", "/api/kill-switch/reset", { body: { note: "n" } });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("not_tripped");
  });
});

// ---------------------------------------------------------------------------
// Reconciliation (endpoint 12)
// ---------------------------------------------------------------------------

describe("reconciliation", () => {
  it("lists recent runs with their findings and classifications", async () => {
    // A reconciliation run records itself as an audit_log entry.
    await db.auditLog.insert({
      id: `rec-${suffix}`,
      actor: "reconciliation",
      action: "reconciliation.run",
      target_bot_instance_id: null,
      details_json: {
        run_id: `run-${suffix}`,
        account_label: `acct-${suffix}`,
        tier: "meaningful",
        findings: [{ kind: "balance_drift", tier: "meaningful", detail: "20 USDT unexplained" }],
        halted: [`b-${suffix}`],
        circuit_breaker_tripped: false,
        skipped: [],
      },
      created_at: T0 + 5,
    });

    const res = await api("GET", "/api/reconciliation");
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0]).toMatchObject({
      id: `rec-${suffix}`,
      actor: "reconciliation",
      details: { tier: "meaningful", run_id: `run-${suffix}` },
    });
  });
});

describe("accounts (step 11)", () => {
  it("GET /api/accounts lists registered accounts and their exchange, ordered by label", async () => {
    await db.accounts.insert({ account_label: `z-${suffix}`, exchange: "gemini", created_at: T0, updated_at: T0 });
    await db.accounts.insert({ account_label: `a-${suffix}`, exchange: "binance", created_at: T0, updated_at: T0 });

    const res = await api("GET", "/api/accounts");

    expect(res.status).toBe(200);
    const mine = (res.body.data as { accountLabel: string; exchange: string }[]).filter((a) =>
      a.accountLabel.endsWith(`-${suffix}`),
    );
    // `capital` rides on every account. An account with no ledger row reports
    // an EMPTY asset list, which is a real state -- nothing creates a ledger
    // row automatically -- and is deliberately not the same as the `null` that
    // means the read failed.
    expect(mine).toEqual([
      {
        accountLabel: `a-${suffix}`,
        exchange: "binance",
        createdAt: T0,
        capital: { readAt: expect.any(Number), rowsRead: 0, assets: [] },
      },
      {
        accountLabel: `z-${suffix}`,
        exchange: "gemini",
        createdAt: T0,
        capital: { readAt: expect.any(Number), rowsRead: 0, assets: [] },
      },
    ]);
  });

  /*
   * ── AVAILABLE CAPITAL ─────────────────────────────────────────────────────
   *
   * `available = total_balance - total_allocated`, published per (account,
   * asset) for the bot list's AVAILABLE tiles. NOT a new calculation: it is the
   * same subtraction `createBotInstanceWithCapital` runs as its binding gate,
   * reached here through `readAccountCapital`, which reserves nothing and
   * writes nothing.
   *
   * The figures below are the operator's REAL live values for `gemini-main`/USD,
   * written as the raw scale-8 integers D1 stores.
   */
  const BALANCE_RAW = 9_995_669_131_000n;
  const ALLOCATED_RAW = 260_806_000_000n;

  interface ServedHeadroom {
    asset: string;
    totalBalance: string;
    totalAllocated: string;
    available: string;
    updatedAt: number;
  }
  interface ServedAccount {
    accountLabel: string;
    capital: { readAt: number; rowsRead: number; assets: ServedHeadroom[] } | null;
  }

  const servedCapital = (body: unknown, label: string): ServedAccount["capital"] =>
    (body as { data: ServedAccount[] }).data.find((a) => a.accountLabel === label)!.capital;

  it("serves available = balance - allocated exactly, at the operator's live figures", async () => {
    const label = `cap-${suffix}`;
    await db.accounts.insert({ account_label: label, exchange: "gemini", created_at: T0, updated_at: T0 });
    await db.capitalLedger.insert(
      capitalLedgerRow({
        id: `cl-${suffix}`,
        account_label: label,
        asset: "USD",
        total_balance: BALANCE_RAW,
        total_allocated: ALLOCATED_RAW,
        updated_at: T0,
      }),
    );

    const res = await api("GET", "/api/accounts");
    expect(res.status).toBe(200);

    const capital = servedCapital(res.body, label)!;
    expect(capital.rowsRead).toBe(1);
    expect(capital.assets).toEqual([
      {
        asset: "USD",
        totalBalance: "99956.69131000",
        totalAllocated: "2608.06000000",
        // 9995669131000 - 260806000000 = 9734863131000, i.e. $97,348.63131000.
        available: "97348.63131000",
        updatedAt: T0,
      },
    ]);

    // The same figure, derived rather than asserted, so this fails if either
    // input string or the subtraction drifts.
    expect(toDecimalString(BALANCE_RAW - ALLOCATED_RAW)).toBe(capital.assets[0]!.available);
  });

  it("serves a NEGATIVE available, unclamped, when allocated exceeds balance", async () => {
    const label = `over-${suffix}`;
    await db.accounts.insert({ account_label: label, exchange: "gemini", created_at: T0, updated_at: T0 });
    // The live figures inverted. Migration 0001 has no
    // `CHECK (total_allocated <= total_balance)` precisely so this state is
    // representable, and it must reach the dashboard rather than be tidied away.
    await db.capitalLedger.insert(
      capitalLedgerRow({
        id: `cl-over-${suffix}`,
        account_label: label,
        asset: "USD",
        total_balance: ALLOCATED_RAW,
        total_allocated: BALANCE_RAW,
        updated_at: T0,
      }),
    );

    const res = await api("GET", "/api/accounts");
    expect(res.status).toBe(200);

    const capital = servedCapital(res.body, label)!;
    expect(capital.assets[0]!.available).toBe("-97348.63131000");
    // The one outcome that would hide real drift from the operator.
    expect(capital.assets[0]!.available).not.toBe("0.00000000");
  });

  it("serves available = 0 when allocated exactly equals balance", async () => {
    const label = `flat-${suffix}`;
    await db.accounts.insert({ account_label: label, exchange: "gemini", created_at: T0, updated_at: T0 });
    await db.capitalLedger.insert(
      capitalLedgerRow({
        id: `cl-flat-${suffix}`,
        account_label: label,
        asset: "USD",
        total_balance: BALANCE_RAW,
        total_allocated: BALANCE_RAW,
        updated_at: T0,
      }),
    );

    const res = await api("GET", "/api/accounts");
    const capital = servedCapital(res.body, label)!;
    expect(capital.assets[0]!.available).toBe("0.00000000");
  });

  it("keeps two accounts' headroom separate and never sums them", async () => {
    // Two accounts on the SAME asset. Constructed even though live data has one,
    // because a blended total is unspendable (a bot draws from one ledger row)
    // and would look completely normal on screen.
    const first = `two-a-${suffix}`;
    const second = `two-b-${suffix}`;
    for (const [label, id] of [[first, "a"], [second, "b"]] as const) {
      await db.accounts.insert({ account_label: label, exchange: "gemini", created_at: T0, updated_at: T0 });
      await db.capitalLedger.insert(
        capitalLedgerRow({
          id: `cl-${id}-${suffix}`,
          account_label: label,
          asset: "USD",
          total_balance: label === first ? BALANCE_RAW : 500_000_000_000n,
          total_allocated: label === first ? ALLOCATED_RAW : 100_000_000_000n,
          updated_at: T0,
        }),
      );
    }

    const res = await api("GET", "/api/accounts");
    expect(servedCapital(res.body, first)!.assets[0]!.available).toBe("97348.63131000");
    expect(servedCapital(res.body, second)!.assets[0]!.available).toBe("4000.00000000");

    // 97348.63131 + 4000 appears nowhere: there is no combined figure at all.
    const every = (res.body as { data: ServedAccount[] }).data.flatMap(
      (a) => a.capital?.assets.map((row) => row.available) ?? [],
    );
    expect(every).not.toContain("101348.63131000");
  });

  it("serves every asset row for one account, ordered by asset", async () => {
    const label = `multi-${suffix}`;
    await db.accounts.insert({ account_label: label, exchange: "gemini", created_at: T0, updated_at: T0 });
    await db.capitalLedger.insert(
      capitalLedgerRow({
        id: `cl-usd-${suffix}`,
        account_label: label,
        asset: "USD",
        total_balance: BALANCE_RAW,
        total_allocated: ALLOCATED_RAW,
        updated_at: T0,
      }),
    );
    await db.capitalLedger.insert(
      capitalLedgerRow({
        id: `cl-btc-${suffix}`,
        account_label: label,
        asset: "BTC",
        total_balance: 100_000_000n,
        total_allocated: 0n,
        updated_at: T0,
      }),
    );

    const capital = servedCapital((await api("GET", "/api/accounts")).body, label)!;
    expect(capital.rowsRead).toBe(2);
    expect(capital.assets.map((row) => row.asset)).toEqual(["BTC", "USD"]);
    expect(capital.assets.map((row) => row.available)).toEqual([
      "1.00000000",
      "97348.63131000",
    ]);
  });

  it("reads the ledger without changing it -- no reservation, no write", async () => {
    const label = `ro-${suffix}`;
    await db.accounts.insert({ account_label: label, exchange: "gemini", created_at: T0, updated_at: T0 });
    await db.capitalLedger.insert(
      capitalLedgerRow({
        id: `cl-ro-${suffix}`,
        account_label: label,
        asset: "USD",
        total_balance: BALANCE_RAW,
        total_allocated: ALLOCATED_RAW,
        updated_at: T0,
      }),
    );

    const before = (await db.capitalLedger.findOne({ account_label: label, asset: "USD" }))!;
    await api("GET", "/api/accounts");
    await api("GET", "/api/accounts");
    const after = (await db.capitalLedger.findOne({ account_label: label, asset: "USD" }))!;

    // Including `updated_at`: a display read must not even touch the row.
    expect(after).toEqual(before);
  });

  it("GET /api/accounts/:label/symbols returns pairs, cached on the second call", async () => {
    const account = `sym-${suffix}`;
    await db.accounts.insert({ account_label: account, exchange: "binance", created_at: T0, updated_at: T0 });

    let calls = 0;
    const symbolLister: SymbolLister = async () => {
      calls += 1;
      return { ok: true, value: ["BTCUSDT", "ETHUSDT"], at: T0 };
    };

    const first = await api("GET", `/api/accounts/${account}/symbols`, { symbolLister });
    expect(first.status).toBe(200);
    expect(first.body.data).toEqual({
      accountLabel: account,
      exchange: "binance",
      pairs: ["BTCUSDT", "ETHUSDT"],
      cached: false,
      fetchedAt: T0,
    });

    const second = await api("GET", `/api/accounts/${account}/symbols`, { symbolLister });
    expect(second.status).toBe(200);
    expect(second.body.data.cached).toBe(true);
    // The second call was served from the KV cache; the exchange was hit once.
    expect(calls).toBe(1);
  });

  it("GET /api/accounts/:label/symbols is 404 for an unregistered account", async () => {
    const res = await api("GET", `/api/accounts/nope-${suffix}/symbols`, {
      symbolLister: async () => ({ ok: true, value: [], at: T0 }),
    });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("unknown_account");
  });

  it("GET /api/accounts/:label/symbols surfaces an exchange failure as 502", async () => {
    const account = `down-${suffix}`;
    await db.accounts.insert({ account_label: account, exchange: "gemini", created_at: T0, updated_at: T0 });

    const res = await api("GET", `/api/accounts/${account}/symbols`, {
      symbolLister: async () => ({
        ok: false,
        kind: "transport",
        message: "exchange unreachable",
        retryable: true,
        at: T0,
      }),
    });
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe("exchange_unavailable");
  });
});

// ---------------------------------------------------------------------------
// Watchlist (section 21.3)
// ---------------------------------------------------------------------------

/**
 * The HTTP surface over `/src/research/watchlist.ts`.
 *
 * The module's own rules -- the cap, fail-closed tradability, the audit entries,
 * the read path -- already have their own file of tests. What is proved HERE is
 * the endpoint layer's share and only that: request parsing, that the actor is
 * the VERIFIED Access email rather than anything the caller sent, that each of
 * the module's coded refusals reaches HTTP as the right status, and that the
 * `TradablePairSource` port is wired to the real cached `listAccountSymbols`
 * rather than to a stub that only tests see.
 *
 * The exchange is injected through `symbolLister`, which is the SAME seam the
 * symbols endpoint uses -- so these tests exercise the real
 * `listAccountSymbols` (cache included), and the only thing replaced is the
 * network call at the far end of it.
 */
describe("watchlist endpoints (section 21.3)", () => {
  const GEMINI_PAIRS = ["BTCUSD", "ETHUSD", "SOLUSD", "LINKUSD", "DOGEUSD"];

  /** A lister answering with a fixed catalogue, counting how often it is asked. */
  function catalogue(pairs: readonly string[] = GEMINI_PAIRS) {
    const calls = { n: 0 };
    const lister: SymbolLister = async () => {
      calls.n += 1;
      return { ok: true, value: [...pairs], at: T0 };
    };
    return { lister, calls };
  }

  /** A lister that cannot reach the venue at all. */
  function unreachable() {
    const calls = { n: 0 };
    const lister: SymbolLister = async () => {
      calls.n += 1;
      return { ok: false, kind: "transport" as const, message: "connect ETIMEDOUT", retryable: true, at: T0 };
    };
    return { lister, calls };
  }

  /** A registered account, unique per test so the KV symbol cache cannot leak. */
  async function account(prefix: string, exchange: "gemini" | "binance" = "gemini") {
    const label = `${prefix}-${suffix}`;
    await db.accounts.insert({ account_label: label, exchange, created_at: T0, updated_at: T0 });
    return label;
  }

  async function watchlistAudit() {
    const rows = await db.auditLog.findMany({
      orderBy: [{ column: "created_at", direction: "asc" }],
    });
    return rows.filter((row) => row.action.startsWith("watchlist."));
  }

  // -- POST /api/watchlist ---------------------------------------------------

  it("POST /api/watchlist adds a pair and returns it, 201", async () => {
    const label = await account("wl-add");
    const { lister } = catalogue();

    const res = await api("POST", "/api/watchlist", {
      symbolLister: lister,
      body: { accountLabel: label, pair: "BTCUSD", note: "deepest book on the venue" },
    });

    expect(res.status).toBe(201);
    expect(res.body.error).toBeNull();
    expect(res.body.data).toEqual({
      id: expect.any(String),
      accountLabel: label,
      pair: "BTCUSD",
      note: "deepest book on the venue",
      addedBy: HUMAN,
      addedAt: T0,
    });

    // It is really in the table, and really audited -- not just echoed back.
    const listed = await api("GET", "/api/watchlist", { symbolLister: lister });
    expect(listed.body.data).toEqual([res.body.data]);
    const audit = await watchlistAudit();
    expect(audit.map((row) => row.action)).toEqual(["watchlist.added"]);
    expect(audit[0]!.actor).toBe(HUMAN);
  });

  it("records the VERIFIED token email as actor, not the one in the body", async () => {
    // The whole reason this layer never reads an actor from a request. The
    // watchlist's value is that a named human vouched for each row, so an actor
    // the caller can choose is an audit trail that proves nothing.
    const label = await account("wl-actor");
    const { lister } = catalogue();

    const spoofed = await api("POST", "/api/watchlist", {
      symbolLister: lister,
      email: "real@example.com",
      body: {
        accountLabel: label,
        pair: "BTCUSD",
        note: "n",
        actor: "someone-else@example.com",
      },
    });
    expect(spoofed.status).toBe(400);
    expect(spoofed.body.error.code).toBe("actor_not_accepted");
    expect(await db.watchlist.count()).toBe(0);

    // Without the field, the recorded actor is the token's email.
    const res = await api("POST", "/api/watchlist", {
      symbolLister: lister,
      email: "real@example.com",
      body: { accountLabel: label, pair: "BTCUSD", note: "n" },
    });
    expect(res.status).toBe(201);
    expect(res.body.data.addedBy).toBe("real@example.com");
    expect((await watchlistAudit())[0]!.actor).toBe("real@example.com");
  });

  it("validates the pair it stores, ignoring any query-string of the same name", async () => {
    // The property underneath fail-closed: the pair that was CHECKED must be the
    // pair that lands in the row. A query parameter shadowing the body field
    // would let a caller have one pair validated and a different one stored,
    // which is a validation that validates nothing. Nothing reads the query
    // string on this route; this pins that.
    const label = await account("wl-qs");
    const { lister } = catalogue();

    const res = await api("POST", "/api/watchlist?pair=PEPEUSD", {
      symbolLister: lister,
      body: { accountLabel: label, pair: "BTCUSD", note: "n" },
    });

    expect(res.status).toBe(201);
    expect(res.body.data.pair).toBe("BTCUSD");
    expect((await db.watchlist.findMany()).map((r) => r.pair)).toEqual(["BTCUSD"]);
  });

  it("derives the exchange from the registry, never from the request body", async () => {
    // Step 11's lesson applied to this table. If the caller could name the
    // exchange, they could pick which venue their pair is validated against --
    // send a Binance symbol, claim Binance, and have it accepted onto a Gemini
    // account whose venue has never heard of it.
    const label = await account("wl-venue"); // registered as gemini
    const { lister } = catalogue(); // the gemini catalogue: no BTCUSDT in it

    const spoofed = await api("POST", "/api/watchlist", {
      symbolLister: lister,
      body: { accountLabel: label, pair: "BTCUSDT", note: "n", exchange: "binance" },
    });
    expect(spoofed.status).toBe(400);
    expect(spoofed.body.error.code).toBe("pair_not_tradable");
    expect(await db.watchlist.count()).toBe(0);

    // And the registry's exchange is what the audit entry records.
    await api("POST", "/api/watchlist", {
      symbolLister: lister,
      body: { accountLabel: label, pair: "BTCUSD", note: "n", exchange: "binance" },
    });
    const audit = (await watchlistAudit())[0]!;
    expect((audit.details_json as { exchange: unknown }).exchange).toBe("gemini");
  });

  it("POST is 409 cap_exceeded once the list holds ten", async () => {
    const label = await account("wl-cap");
    const { lister, calls } = catalogue();
    for (let i = 0; i < 10; i += 1) {
      await db.watchlist.insert({
        id: `cap-${suffix}-${i}`,
        account_label: label,
        pair: `pad${i}`,
        note: "fixture",
        added_by: HUMAN,
        added_at: T0,
        removed_by: null,
        removed_at: null,
      });
    }

    const res = await api("POST", "/api/watchlist", {
      symbolLister: lister,
      body: { accountLabel: label, pair: "BTCUSD", note: "n" },
    });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("cap_exceeded");
    // The module refuses before reaching the venue, and the endpoint does not
    // undo that by pre-fetching the catalogue for its own reasons.
    expect(calls.n).toBe(0);
    expect(await db.watchlist.count({ removed_at: null })).toBe(10);
  });

  it("POST is 400 pair_not_tradable for a pair the venue does not list", async () => {
    const label = await account("wl-untradable");
    const { lister } = catalogue();

    const res = await api("POST", "/api/watchlist", {
      symbolLister: lister,
      body: { accountLabel: label, pair: "PEPEUSD", note: "seen it trending" },
    });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("pair_not_tradable");
    expect(await db.watchlist.count()).toBe(0);
    expect(await watchlistAudit()).toEqual([]);
  });

  it("POST is 409 already_watched for a duplicate", async () => {
    const label = await account("wl-dup");
    const { lister } = catalogue();
    const body = { accountLabel: label, pair: "BTCUSD", note: "n" };

    expect((await api("POST", "/api/watchlist", { symbolLister: lister, body })).status).toBe(201);
    const res = await api("POST", "/api/watchlist", { symbolLister: lister, body });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("already_watched");
    expect(await db.watchlist.count({ removed_at: null })).toBe(1);
    expect((await watchlistAudit()).length).toBe(1);
  });

  it("POST is 503 tradable_set_unreadable when the venue cannot be asked", async () => {
    // Fail closed, and 503 rather than the symbols endpoint's 502: this is a
    // REFUSAL to write on unverifiable input, not a relayed read failure.
    const label = await account("wl-down");
    const { lister } = unreachable();

    const res = await api("POST", "/api/watchlist", {
      symbolLister: lister,
      body: { accountLabel: label, pair: "BTCUSD", note: "n" },
    });

    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe("tradable_set_unreadable");
    expect(res.body.error.message).toContain("connect ETIMEDOUT");
    expect(await db.watchlist.count()).toBe(0);
  });

  it("POST is 404 for an unregistered account", async () => {
    const res = await api("POST", "/api/watchlist", {
      symbolLister: catalogue().lister,
      body: { accountLabel: `nope-${suffix}`, pair: "BTCUSD", note: "n" },
    });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("unknown_account");
  });

  it("POST is 400 for a missing or blank field", async () => {
    const label = await account("wl-fields");
    const { lister } = catalogue();
    for (const body of [
      { pair: "BTCUSD", note: "n" },
      { accountLabel: label, note: "n" },
      { accountLabel: label, pair: "BTCUSD" },
      { accountLabel: label, pair: "BTCUSD", note: "   " },
    ]) {
      const res = await api("POST", "/api/watchlist", { symbolLister: lister, body });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("missing_field");
    }
    expect(await db.watchlist.count()).toBe(0);
  });

  it("uses the REAL cached listAccountSymbols, so two adds cost one venue call", async () => {
    // The port wiring, asserted rather than assumed. If the endpoint reached for
    // the exchange directly instead of going through `listAccountSymbols`, this
    // would be two calls -- and the watchlist's idea of what is tradable could
    // drift from the dropdown the operator reads.
    const label = await account("wl-cache");
    const { lister, calls } = catalogue();

    await api("POST", "/api/watchlist", {
      symbolLister: lister,
      body: { accountLabel: label, pair: "BTCUSD", note: "n" },
    });
    await api("POST", "/api/watchlist", {
      symbolLister: lister,
      body: { accountLabel: label, pair: "ETHUSD", note: "n" },
    });

    expect(await db.watchlist.count({ removed_at: null })).toBe(2);
    expect(calls.n).toBe(1);
  });

  // -- DELETE /api/watchlist/:id --------------------------------------------

  it("DELETE /api/watchlist/:id removes the entry and audits it", async () => {
    const label = await account("wl-del");
    const { lister } = catalogue();
    const added = await api("POST", "/api/watchlist", {
      symbolLister: lister,
      body: { accountLabel: label, pair: "BTCUSD", note: "n" },
    });

    const res = await api("DELETE", `/api/watchlist/${added.body.data.id}`, {
      symbolLister: lister,
    });

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual(added.body.data);
    expect((await api("GET", "/api/watchlist", { symbolLister: lister })).body.data).toEqual([]);
    expect((await watchlistAudit()).map((row) => row.action)).toEqual([
      "watchlist.added",
      "watchlist.removed",
    ]);
    // Soft delete: the row is still there, marked.
    const row = await db.watchlist.findOne({ id: added.body.data.id });
    expect(row?.removed_by).toBe(HUMAN);
    expect(row?.removed_at).toBe(T0);
  });

  it("DELETE never asks the exchange, so a delisting cannot trap an entry", async () => {
    // Decision: removal does NOT re-check tradability. Driven with a lister that
    // always fails -- the removal must still succeed, and must not have called
    // it at all.
    const label = await account("wl-del-down");
    const added = await api("POST", "/api/watchlist", {
      symbolLister: catalogue().lister,
      body: { accountLabel: label, pair: "BTCUSD", note: "n" },
    });

    const { lister, calls } = unreachable();
    const res = await api("DELETE", `/api/watchlist/${added.body.data.id}`, { symbolLister: lister });

    expect(res.status).toBe(200);
    expect(calls.n).toBe(0);
    expect(await db.watchlist.count({ removed_at: null })).toBe(0);
  });

  it("records the verified email as the REMOVAL actor too, whatever the caller sends", async () => {
    // The same audit-truth property as the add, on the other half. A removal is
    // the entry's last recorded human act, and `removed_by` is the only place it
    // is kept -- so a caller-supplied actor here would be a false record of who
    // took a pair off the list.
    const label = await account("wl-del-actor");
    const { lister } = catalogue();
    const added = await api("POST", "/api/watchlist", {
      symbolLister: lister,
      email: "real@example.com",
      body: { accountLabel: label, pair: "BTCUSD", note: "n" },
    });

    const res = await api(
      "DELETE",
      `/api/watchlist/${added.body.data.id}?actor=someone-else%40example.com`,
      { symbolLister: lister, email: "real@example.com" },
    );

    expect(res.status).toBe(200);
    const row = await db.watchlist.findOne({ id: added.body.data.id });
    expect(row?.removed_by).toBe("real@example.com");
    const removal = (await watchlistAudit()).find((r) => r.action === "watchlist.removed")!;
    expect(removal.actor).toBe("real@example.com");
  });

  it("DELETE is 404 unknown_watchlist_entry for an id that does not exist", async () => {
    const res = await api("DELETE", `/api/watchlist/nope-${suffix}`, {
      symbolLister: catalogue().lister,
    });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("unknown_watchlist_entry");
    expect(await watchlistAudit()).toEqual([]);
  });

  it("DELETE is 404 not_watched for an entry already removed", async () => {
    const label = await account("wl-twice");
    const { lister } = catalogue();
    const added = await api("POST", "/api/watchlist", {
      symbolLister: lister,
      body: { accountLabel: label, pair: "BTCUSD", note: "n" },
    });
    const path = `/api/watchlist/${added.body.data.id}`;
    expect((await api("DELETE", path, { symbolLister: lister })).status).toBe(200);

    const res = await api("DELETE", path, { symbolLister: lister });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("not_watched");
    // No second removal audit entry for a removal that did not happen.
    expect((await watchlistAudit()).filter((r) => r.action === "watchlist.removed")).toHaveLength(1);
  });

  it("DELETE on a STALE id does not remove the live entry for the same pair", async () => {
    // The one guard this handler adds that the module cannot. The migration's
    // unique index is PARTIAL, so a removed row and a live row may share
    // (account, pair). The module is addressed by pair; passing a dead row's
    // pair through would silently kill the live entry that replaced it.
    const label = await account("wl-stale");
    const { lister } = catalogue();
    const body = { accountLabel: label, pair: "BTCUSD", note: "n" };

    const first = await api("POST", "/api/watchlist", { symbolLister: lister, body });
    await api("DELETE", `/api/watchlist/${first.body.data.id}`, { symbolLister: lister });
    const second = await api("POST", "/api/watchlist", {
      symbolLister: lister,
      body: { ...body, note: "back on, the range tightened" },
    });
    expect(second.body.data.id).not.toBe(first.body.data.id);

    const res = await api("DELETE", `/api/watchlist/${first.body.data.id}`, { symbolLister: lister });

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("not_watched");
    // The live entry is untouched.
    const live = await api("GET", "/api/watchlist", { symbolLister: lister });
    expect(live.body.data).toEqual([second.body.data]);
  });

  it("DELETE carries an optional ?note= into the audit entry", async () => {
    const label = await account("wl-note");
    const { lister } = catalogue();
    const added = await api("POST", "/api/watchlist", {
      symbolLister: lister,
      body: { accountLabel: label, pair: "BTCUSD", note: "n" },
    });

    await api("DELETE", `/api/watchlist/${added.body.data.id}?note=superseded%20by%20solusd`, {
      symbolLister: lister,
    });

    const removal = (await watchlistAudit()).find((r) => r.action === "watchlist.removed")!;
    expect((removal.details_json as { note: unknown }).note).toBe("superseded by solusd");
  });

  it("DELETE is 400 for a present-but-blank ?note=", async () => {
    const label = await account("wl-blank-note");
    const { lister } = catalogue();
    const added = await api("POST", "/api/watchlist", {
      symbolLister: lister,
      body: { accountLabel: label, pair: "BTCUSD", note: "n" },
    });

    const res = await api("DELETE", `/api/watchlist/${added.body.data.id}?note=%20%20`, {
      symbolLister: lister,
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("invalid_field");
    expect(await db.watchlist.count({ removed_at: null })).toBe(1);
  });

  // -- GET /api/watchlist ----------------------------------------------------

  it("GET spans every account unscoped, and narrows with ?accountLabel=", async () => {
    const gem = await account("wl-g");
    const bin = await account("wl-b", "binance");
    const { lister } = catalogue();
    const binanceLister: SymbolLister = async () => ({ ok: true, value: ["BTCUSDT"], at: T0 });

    await api("POST", "/api/watchlist", {
      symbolLister: lister,
      body: { accountLabel: gem, pair: "BTCUSD", note: "gemini one" },
    });
    await api("POST", "/api/watchlist", {
      symbolLister: binanceLister,
      body: { accountLabel: bin, pair: "BTCUSDT", note: "binance one" },
    });

    const all = await api("GET", "/api/watchlist", { symbolLister: lister });
    expect(all.status).toBe(200);
    expect(all.body.data.map((e: { pair: string }) => e.pair)).toEqual(["BTCUSD", "BTCUSDT"]);

    const scoped = await api("GET", `/api/watchlist?accountLabel=${bin}`, { symbolLister: lister });
    expect(scoped.status).toBe(200);
    expect(scoped.body.data).toEqual([
      { id: expect.any(String), accountLabel: bin, pair: "BTCUSDT", note: "binance one", addedBy: HUMAN, addedAt: T0 },
    ]);
  });

  it("GET is 404 for an unregistered ?accountLabel=, not an empty list", async () => {
    // A typo'd label would otherwise report "nothing is watched" about an
    // account that does not exist, and the caller could not tell the difference.
    const res = await api("GET", `/api/watchlist?accountLabel=gemini-mian-${suffix}`, {
      symbolLister: catalogue().lister,
    });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("unknown_account");
  });

  it("GET returns an empty list for a registered account with nothing watched", async () => {
    const label = await account("wl-empty");
    const res = await api("GET", `/api/watchlist?accountLabel=${label}`, {
      symbolLister: catalogue().lister,
    });
    expect(res.status).toBe(200);
    expect(res.body).toStrictEqual({ data: [], error: null });
  });

  // -- Routing and auth ------------------------------------------------------

  it("is routed on the three methods it declares and no others", async () => {
    const collectionOther = await api("PUT", "/api/watchlist", { symbolLister: catalogue().lister });
    expect(collectionOther.status).toBe(405);
    expect(collectionOther.body.error.code).toBe("method_not_allowed");

    const itemOther = await api("POST", `/api/watchlist/some-id`, { symbolLister: catalogue().lister });
    expect(itemOther.status).toBe(405);
  });

  it("refuses an unauthenticated write", async () => {
    const label = await account("wl-auth");
    const res = await api("POST", "/api/watchlist", {
      token: null,
      symbolLister: catalogue().lister,
      body: { accountLabel: label, pair: "BTCUSD", note: "n" },
    });
    expect(res.status).toBe(401);
    expect(await db.watchlist.count()).toBe(0);
  });
});

describe("bot creation dispatches exchange from the account registry (step 11)", () => {
  async function createBotBody(account: string, id: string, exchange?: string) {
    const body: Record<string, unknown> = {
      botInstanceId: id,
      accountLabel: account,
      pair: TEST_PAIR,
      capitalAsset: "USDT",
      allocatedCapital: "500",
      strategy: "dca",
      params: dcaParamsJson,
    };
    if (exchange !== undefined) body.exchange = exchange;
    return api("POST", "/api/bots", { ...botPorts(), body });
  }

  it("derives the exchange from the registry when the account is registered, body exchange omitted", async () => {
    const account = `reg-${suffix}`;
    await seedBalance(account);
    await db.accounts.insert({ account_label: account, exchange: "gemini", created_at: T0, updated_at: T0 });

    const res = await createBotBody(account, `rb-${suffix}`);
    expect(res.status).toBe(201);

    const row = await db.botInstances.findOne({ id: `rb-${suffix}` });
    expect(row!.exchange).toBe("gemini");
  });

  it("rejects a body exchange that disagrees with the registry (400)", async () => {
    const account = `mis-${suffix}`;
    await seedBalance(account);
    await db.accounts.insert({ account_label: account, exchange: "gemini", created_at: T0, updated_at: T0 });

    const res = await createBotBody(account, `mb-${suffix}`, "binance");
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("exchange_mismatch");
  });

  it("soft-falls back to the body exchange for an unregistered account", async () => {
    const account = `unreg-${suffix}`;
    await seedBalance(account);

    const res = await createBotBody(account, `ub-${suffix}`, "binance");
    expect(res.status).toBe(201);
    const row = await db.botInstances.findOne({ id: `ub-${suffix}` });
    expect(row!.exchange).toBe("binance");
  });

  it("rejects an unregistered account with no exchange given (400)", async () => {
    const account = `bare-${suffix}`;
    await seedBalance(account);

    const res = await createBotBody(account, `bb-${suffix}`);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("unregistered_account");
  });

  it("rejects an unknown exchange value on the fallback path (400)", async () => {
    const account = `bad-${suffix}`;
    await seedBalance(account);

    const res = await createBotBody(account, `xb-${suffix}`, "kraken");
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("invalid_exchange");
  });
});

/**
 * POST /api/bots refuses a pair the venue does not list, and refuses a
 * PERPETUAL that it does.
 *
 * Before this gate existed, `pair` was a free-typed string that reached bot
 * creation with no check of any kind -- `bot-instance.ts` has never called
 * `listTradablePairs`. So these tests are not defending a refinement; they are
 * the first thing standing between a typo and a bot with capital reserved
 * against a symbol that does not exist.
 *
 * THE LOAD-BEARING ASSERTION IN EVERY REFUSAL TEST IS NOT THE STATUS CODE. It
 * is that NOTHING HAPPENED: no `bot_instances` row, no `capital_ledger`
 * allocation, no `capital.allocated` audit entry, and no Durable Object -- the
 * last proved by re-using the same bot id afterwards and getting a 201 rather
 * than the 409 `already_created` a live object would answer with. A gate that
 * returns the right error after reserving capital is worse than no gate, because
 * it looks correct.
 */
describe("bot creation refuses untradable and non-spot pairs (POST /api/bots)", () => {
  /** A registered account, unique per test so the KV symbol cache cannot leak. */
  async function botAccount(prefix: string, exchange: "gemini" | "binance" = "gemini") {
    const label = `${prefix}-${suffix}`;
    await db.accounts.insert({ account_label: label, exchange, created_at: T0, updated_at: T0 });
    await seedBalance(label);
    return label;
  }

  function createBody(account: string, id: string, pair: string) {
    return {
      botInstanceId: id,
      accountLabel: account,
      pair,
      capitalAsset: "USDT",
      allocatedCapital: "500",
      strategy: "dca",
      params: dcaParamsJson,
    };
  }

  /** Assert a refused request left no trace anywhere. */
  async function expectNoSideEffects(account: string, id: string) {
    expect(await db.botInstances.findOne({ id })).toBeNull();

    const ledger = await db.capitalLedger.findOne({ account_label: account, asset: "USDT" });
    expect(ledger!.total_allocated).toBe(m("0"));

    const audit = await db.auditLog.findMany({ where: { target_bot_instance_id: id } });
    expect(audit).toEqual([]);
  }

  it("creates a bot on a real spot pair (201), reading the venue's instrument type", async () => {
    const account = await botAccount("spot-ok");
    const ports = botPorts();
    const id = `sok-${suffix}`;

    const res = await api("POST", "/api/bots", {
      ...ports,
      body: createBody(account, id, "BTCUSD"),
    });

    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ id, status: "created" });
    // Both questions were actually asked of the venue, in order.
    expect(ports.catalogueCalls.n).toBe(1);
    expect(ports.detailCalls).toEqual(["BTCUSD"]);
  });

  it("refuses a pair the venue does not list, before any ledger allocation or DO", async () => {
    const account = await botAccount("unlisted");
    const ports = botPorts();
    const id = `unl-${suffix}`;

    const res = await api("POST", "/api/bots", {
      ...ports,
      body: createBody(account, id, "FAKEUSD"),
    });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("pair_not_tradable");
    await expectNoSideEffects(account, id);

    // The per-symbol request was NEVER spent: the cached catalogue answered
    // first, which is the whole reason the two checks are in this order.
    expect(ports.detailCalls).toEqual([]);

    // NOTHING was created -- proved by the id still being free.
    const retry = await api("POST", "/api/bots", {
      ...botPorts(),
      body: createBody(account, id, "BTCUSD"),
    });
    expect(retry.status).toBe(201);
  });

  it("refuses a REAL Gemini perpetual by name, before any ledger allocation or DO", async () => {
    const account = await botAccount("perp");
    const ports = botPorts({ HYPEUSDCPERP: "derivative" });
    const id = `perp-${suffix}`;

    const res = await api("POST", "/api/bots", {
      ...ports,
      body: createBody(account, id, "HYPEUSDCPERP"),
    });

    expect(res.status).toBe(400);
    // A DISTINCT code from `pair_not_tradable`: the venue does list this pair.
    // Reporting it as "not tradable" would be flatly untrue and would send an
    // operator hunting for a spelling mistake that is not there.
    expect(res.body.error.code).toBe("instrument_not_spot");
    expect(res.body.error.message).toContain("HYPEUSDCPERP");
    expect(res.body.error.message).toContain("derivative");
    expect(res.body.error.message).toContain("perpetual swap");

    await expectNoSideEffects(account, id);

    // It really did pass the catalogue check -- the perp IS listed -- so the
    // refusal came from the instrument field and nothing else.
    expect(ports.catalogueCalls.n).toBe(1);
    expect(ports.detailCalls).toEqual(["HYPEUSDCPERP"]);

    const retry = await api("POST", "/api/bots", {
      ...botPorts(),
      body: createBody(account, id, "BTCUSD"),
    });
    expect(retry.status).toBe(201);
  });

  it("REGRESSION: the perp refusal here comes from product_type, never from the name", async () => {
    // THE MASKING TEST. Step 33 added a cheap naming heuristic to
    // `checkTradable` for the research paths, which cannot afford the
    // per-symbol request `checkSpotInstrument` costs. That heuristic runs in the
    // SAME function this gate calls FIRST, and reaches the SAME conclusion about
    // the SAME string -- so had this gate opted into it, `HYPEUSDCPERP` would be
    // refused by an inference before `checkSpotInstrument` was ever reached, and
    // the structural check could then have been DELETED OUTRIGHT with every test
    // in this file still green.
    //
    // That is decision log 32's own standing convention arriving one layer up:
    // multiple signals that each independently reach one conclusion let any of
    // them silently backstop the others. There it was two FIELDS in one parser;
    // here it is two FUNCTIONS at one gate.
    //
    // So `assertBotPairIsSpotTradable` passes "structural-check-elsewhere", and
    // this test exists to keep it that way. It must survive whatever the
    // research paths do, because the thing it protects is the evidence behind a
    // refusal on the endpoint that reserves capital.
    const account = await botAccount("perp-evidence");
    const ports = botPorts({ HYPEUSDCPERP: "derivative" });
    const id = `pev-${suffix}`;

    const res = await api("POST", "/api/bots", {
      ...ports,
      body: createBody(account, id, "HYPEUSDCPERP"),
    });

    // The per-symbol details request WAS spent. If the naming heuristic had
    // answered, `checkTradable` would have refused and this would be empty --
    // which is the single assertion that would have failed had the gate opted
    // in, and the reason this test is not redundant with the one above it.
    expect(ports.detailCalls).toEqual(["HYPEUSDCPERP"]);

    expect(res.body.error.code).toBe("instrument_not_spot");
    expect(res.body.error.code).not.toBe("pair_not_spot_by_name");
    // The message carries what the VENUE said, not what this repository guessed
    // from a suffix Gemini has never documented.
    expect(res.body.error.message).toContain("derivative");
    expect(res.body.error.message).not.toContain("ENDS IN");
    expect(res.body.error.message).not.toContain("NOT A STATEMENT FROM THE VENUE");
  });

  it("refuses when the venue reports an instrument type this code cannot map", async () => {
    const account = await botAccount("unmapped");
    const id = `unm-${suffix}`;

    const res = await api("POST", "/api/bots", {
      ...botPorts({ BTCUSD: "unknown" }),
      body: createBody(account, id, "BTCUSD"),
    });

    // 502, not 400: the venue answered successfully and the answer was
    // unusable. There is nothing the caller can rephrase.
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe("instrument_type_unknown");
    await expectNoSideEffects(account, id);
  });

  it("refuses when the venue reports NO instrument type at all (fail closed)", async () => {
    const account = await botAccount("absent");
    const id = `abs-${suffix}`;

    const res = await api("POST", "/api/bots", {
      // `undefined` -- the field simply is not on the payload.
      ...botPorts({ BTCUSD: undefined }),
      body: createBody(account, id, "BTCUSD"),
    });

    // THE ONE THAT LOOKS WRONG AND IS NOT. Gemini lists spot and perpetuals in
    // one catalogue, so on that venue "no instrument type" and "this might be a
    // perpetual" are the same sentence. A field that did not arrive is not a
    // field that said "spot".
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe("instrument_type_unknown");
    expect(res.body.error.message).toContain("did not report");
    await expectNoSideEffects(account, id);
  });

  it("refuses when the tradable set cannot be read at all (503)", async () => {
    const account = await botAccount("cat-down");
    const id = `cd-${suffix}`;
    const details = botDetails();

    const res = await api("POST", "/api/bots", {
      symbolLister: async () => ({
        ok: false,
        kind: "transport" as const,
        message: "connect ETIMEDOUT",
        retryable: true,
        at: T0,
      }),
      symbolDetailLister: details.lister,
      body: createBody(account, id, "BTCUSD"),
    });

    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe("tradable_set_unreadable");
    await expectNoSideEffects(account, id);
    expect(details.calls).toEqual([]);
  });

  it("refuses when the symbol details cannot be read at all (503)", async () => {
    const account = await botAccount("det-down");
    const id = `dd-${suffix}`;

    const res = await api("POST", "/api/bots", {
      symbolLister: botCatalogue().lister,
      symbolDetailLister: async () => ({
        ok: false,
        kind: "exchange_error" as const,
        message: "502 from venue",
        retryable: true,
        at: T0,
      }),
      body: createBody(account, id, "BTCUSD"),
    });

    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe("instrument_unreadable");
    await expectNoSideEffects(account, id);
  });

  it("asks BINANCE no instrument question, because its spot endpoint has none", async () => {
    const account = await botAccount("bin", "binance");
    const ports = botPorts();
    const id = `bin-${suffix}`;

    const res = await api("POST", "/api/bots", {
      ...ports,
      body: createBody(account, id, TEST_PAIR),
    });

    expect(res.status).toBe(201);
    // The catalogue check still runs -- that is venue-independent. The
    // per-symbol details request does NOT, because `/api/v3/exchangeInfo` is
    // the spot API and Binance's perpetuals are a different host this system
    // cannot reach. Spending a request to ask an unanswerable question would be
    // theatre.
    expect(ports.catalogueCalls.n).toBe(1);
    expect(ports.detailCalls).toEqual([]);
  });

  it("reports a bad strategy parameter without spending an exchange request", async () => {
    const account = await botAccount("params-first");
    const ports = botPorts();
    const noStop: Record<string, unknown> = { ...dcaParamsJson };
    delete noStop.stopLossPct;

    const res = await api("POST", "/api/bots", {
      ...ports,
      body: { ...createBody(account, `pf-${suffix}`, "FAKEUSD"), params: noStop },
    });

    // Free checks first, network last: the pair is ALSO invalid here, and the
    // params still win because deciding them costs nothing.
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("invalid_parameter");
    expect(ports.catalogueCalls.n).toBe(0);
    expect(ports.detailCalls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Candles (section 21.4, Stage 1)
// ---------------------------------------------------------------------------

/**
 * The HTTP surface over `/src/research/candles.ts`.
 *
 * The module's own rules -- the interval gate, fail-closed tradability, the
 * truncation arithmetic, the five refusals -- already have their own file of
 * tests. What is proved HERE is the endpoint layer's share and only that:
 * query parsing, that each of the module's coded refusals reaches HTTP as the
 * intended status through `STATUS_BY_CODE` rather than a hand-written one, that
 * the depth fields are actually VISIBLE over the wire, and that the
 * `TradablePairSource` port is the real cached `listAccountSymbols` shared with
 * the watchlist rather than a stub only tests see.
 *
 * That last one matters more than it looks: the whole reason this endpoint
 * exists is to be curl-ed against a real venue, and an endpoint wired to a
 * different tradable-set path than the rest of the system would verify the
 * wrong thing.
 *
 * The exchange is injected through `candleLister` (and `symbolLister` for the
 * tradability gate) -- the SAME seams the Worker defaults to the real listers
 * on. NOTHING HERE CONTACTS GEMINI OR BINANCE.
 */
describe("candles endpoint (section 21.4)", () => {
  const MINUTE = 60_000;
  const GEMINI_PAIRS = ["BTCUSD", "ETHUSD", "SOLUSD"];

  function catalogueLister(pairs: readonly string[] = GEMINI_PAIRS): SymbolLister {
    return async () => ({ ok: true, value: [...pairs], at: T0 });
  }

  function candleAt(openTime: number, close: bigint): Candle {
    return {
      pair: "BTCUSD",
      openTime,
      closeTime: openTime + MINUTE,
      open: close - 1n,
      high: close + 2n,
      low: close - 3n,
      close,
      volume: 400_000_000n,
      closed: true,
    };
  }

  /** A venue holding a fixed recent window, filtered by `since` as the client does. */
  function windowLister(oldestOpen: number, count: number) {
    const calls: { pair: string; interval: string; since?: number }[] = [];
    const all = Array.from({ length: count }, (_, i) =>
      candleAt(oldestOpen + i * MINUTE, 100_000_000n + BigInt(i) * 1_000_000n),
    );
    const lister: CandleLister = async (_account, query) => {
      calls.push({ pair: query.pair, interval: query.interval, ...(query.since === undefined ? {} : { since: query.since }) });
      const since = query.since;
      return {
        ok: true,
        value: since === undefined ? all : all.filter((c) => c.closeTime > since),
        at: T0,
      };
    };
    return { lister, calls, all };
  }

  /** A venue call that fails. */
  function failingCandles(kind: "transport" | "exchange_error" = "transport"): CandleLister {
    return async () => ({ ok: false, kind, message: "connect ETIMEDOUT", retryable: true, at: T0 });
  }

  async function account(prefix: string, exchange: "gemini" | "binance" = "gemini") {
    const label = `${prefix}-${suffix}`;
    await db.accounts.insert({ account_label: label, exchange, created_at: T0, updated_at: T0 });
    return label;
  }

  function candlesPath(label: string, query: Record<string, string>) {
    const params = new URLSearchParams(query);
    return `/api/accounts/${label}/candles?${params.toString()}`;
  }

  // -- The successful read ---------------------------------------------------

  it("returns the full window shape, with money as decimal strings", async () => {
    const label = await account("cd-ok");
    const { lister, calls } = windowLister(T0 - 3 * MINUTE, 3);

    const res = await api("GET", candlesPath(label, { pair: "BTCUSD", interval: "1m" }), {
      symbolLister: catalogueLister(),
      candleLister: lister,
    });

    expect(res.status).toBe(200);
    expect(res.body.error).toBeNull();
    expect(res.body.data).toEqual({
      accountLabel: label,
      exchange: "gemini",
      pair: "BTCUSD",
      interval: "1m",
      fetchedAt: T0,
      requestedSince: null,
      earliestOpenTime: T0 - 3 * MINUTE,
      earliestCloseTime: T0 - 2 * MINUTE,
      latestCloseTime: T0,
      truncated: false,
      missingHistoryMs: null,
      count: 3,
      // Money as EXACT decimal strings at scale 8, never JS numbers -- a
      // fractional cent or a value past 2^53 would lose precision as a number,
      // and `JSON.stringify` throws on the underlying bigint outright.
      candles: [
        { openTime: T0 - 3 * MINUTE, closeTime: T0 - 2 * MINUTE, open: "0.99999999", high: "1.00000002", low: "0.99999997", close: "1.00000000", volume: "4.00000000", closed: true },
        { openTime: T0 - 2 * MINUTE, closeTime: T0 - MINUTE, open: "1.00999999", high: "1.01000002", low: "1.00999997", close: "1.01000000", volume: "4.00000000", closed: true },
        { openTime: T0 - MINUTE, closeTime: T0, open: "1.01999999", high: "1.02000002", low: "1.01999997", close: "1.02000000", volume: "4.00000000", closed: true },
      ],
    });
    // The venue was asked exactly what the caller asked for, once.
    expect(calls).toEqual([{ pair: "BTCUSD", interval: "1m" }]);
  });

  it("carries ?since= through and reports a satisfied range as untruncated", async () => {
    const label = await account("cd-since");
    const oldest = T0 - 30 * MINUTE;
    const { lister, calls } = windowLister(oldest, 30);
    const wanted = T0 - 10 * MINUTE;

    const res = await api(
      "GET",
      candlesPath(label, { pair: "BTCUSD", interval: "1m", since: String(wanted) }),
      { symbolLister: catalogueLister(), candleLister: lister },
    );

    expect(res.status).toBe(200);
    expect(calls).toEqual([{ pair: "BTCUSD", interval: "1m", since: wanted }]);
    expect(res.body.data.requestedSince).toBe(wanted);
    expect(res.body.data.truncated).toBe(false);
    expect(res.body.data.missingHistoryMs).toBeNull();
    expect(res.body.data.count).toBe(10);
  });

  it("REPORTS TRUNCATION over the wire when the window cannot reach back far enough", async () => {
    // The reason this endpoint exists. 21.7's open question 1 says Gemini's
    // /v2/candles has no time-range parameter; this asserts the shortfall is
    // legible in the RESPONSE BODY, not merely computed internally, so a real
    // curl against a real venue can settle the question.
    const label = await account("cd-trunc");
    const oldest = T0 - 30 * MINUTE;
    const { lister } = windowLister(oldest, 30);
    const wanted = T0 - 24 * 60 * MINUTE;

    const res = await api(
      "GET",
      candlesPath(label, { pair: "BTCUSD", interval: "1m", since: String(wanted) }),
      { symbolLister: catalogueLister(), candleLister: lister },
    );

    expect(res.status).toBe(200);
    expect(res.body.data.truncated).toBe(true);
    expect(res.body.data.missingHistoryMs).toBe(oldest - wanted);
    expect(res.body.data.requestedSince).toBe(wanted);
    expect(res.body.data.earliestOpenTime).toBe(oldest);
    expect(res.body.data.count).toBe(30);
    // A 200, not an error: the caller gets what there was AND is told what is
    // missing. Failing the request would hide real candles behind a limitation.
    expect(res.body.error).toBeNull();
  });

  it("carries the IN-PROGRESS candle's closed:false through to the wire", async () => {
    // A mutation run found this too: every fixture here was a closed candle, so
    // hardcoding `closed: true` in the serializer passed everything. Gemini
    // really does send the in-progress candle at the end of its window, and
    // `closed` is the ONLY thing telling a consumer to drop it. Published as
    // false, it costs one candle; published as true, it is a partial bar that
    // looks final and enters a volatility read as though the period had ended.
    const label = await account("cd-inprogress");
    const closedTwo = [
      candleAt(T0 - 3 * MINUTE, 100_000_000n),
      candleAt(T0 - 2 * MINUTE, 101_000_000n),
    ];
    const inProgress: Candle = { ...candleAt(T0 - MINUTE, 102_000_000n), closed: false };
    const lister: CandleLister = async () => ({
      ok: true,
      value: [...closedTwo, inProgress],
      at: T0,
    });

    const res = await api("GET", candlesPath(label, { pair: "BTCUSD", interval: "1m" }), {
      symbolLister: catalogueLister(),
      candleLister: lister,
    });

    expect(res.status).toBe(200);
    expect(res.body.data.candles.map((c: { closed: boolean }) => c.closed)).toEqual([
      true,
      true,
      false,
    ]);
    // It is NOT filtered out on the way through: the count and the depth fields
    // still describe the whole window the venue sent.
    expect(res.body.data.count).toBe(3);
    expect(res.body.data.latestCloseTime).toBe(T0);
  });

  it("count matches the candles array, so a jq check needs no download", async () => {
    const label = await account("cd-count");
    const { lister } = windowLister(T0 - 7 * MINUTE, 7);

    const res = await api("GET", candlesPath(label, { pair: "BTCUSD", interval: "1m" }), {
      symbolLister: catalogueLister(),
      candleLister: lister,
    });

    expect(res.body.data.count).toBe(res.body.data.candles.length);
    expect(res.body.data.count).toBe(7);
  });

  it("shares the watchlist's cached tradable set rather than a second path", async () => {
    // Two candle requests must cost ONE catalogue call: that is what proves the
    // gate goes through `listAccountSymbols` (and its KV cache) rather than
    // around it, exactly as the watchlist's own two-adds-one-call test does.
    const label = await account("cd-cache");
    let catalogueCalls = 0;
    const symbolLister: SymbolLister = async () => {
      catalogueCalls += 1;
      return { ok: true, value: [...GEMINI_PAIRS], at: T0 };
    };
    const { lister } = windowLister(T0 - 2 * MINUTE, 2);
    const path = candlesPath(label, { pair: "BTCUSD", interval: "1m" });

    expect((await api("GET", path, { symbolLister, candleLister: lister })).status).toBe(200);
    expect((await api("GET", path, { symbolLister, candleLister: lister })).status).toBe(200);

    expect(catalogueCalls).toBe(1);
  });

  // -- Query parsing (this layer's own refusals) -----------------------------

  it("is 400 missing_field with no ?pair=", async () => {
    const label = await account("cd-nopair");
    const res = await api("GET", candlesPath(label, { interval: "1m" }), {
      symbolLister: catalogueLister(),
      candleLister: windowLister(T0, 1).lister,
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("missing_field");
  });

  it("is 400 missing_field for a present-but-blank ?pair=", async () => {
    // A mutation run found this. `?pair=` reaches the module as "" and is
    // refused there as untradable -- also a 400, which is why dropping the
    // blank check here changed no status and no test. But the code would be
    // `pair_not_tradable`, telling an operator the venue does not list a symbol
    // they never named, and it would spend a catalogue call to say so.
    const label = await account("cd-blankpair");
    let catalogueCalls = 0;
    const symbolLister: SymbolLister = async () => {
      catalogueCalls += 1;
      return { ok: true, value: [...GEMINI_PAIRS], at: T0 };
    };

    const res = await api("GET", candlesPath(label, { pair: "  ", interval: "1m" }), {
      symbolLister,
      candleLister: windowLister(T0, 1).lister,
    });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("missing_field");
    expect(catalogueCalls).toBe(0);
  });

  it("is 400 missing_field with no ?interval=", async () => {
    const label = await account("cd-nointerval");
    const res = await api("GET", candlesPath(label, { pair: "BTCUSD" }), {
      symbolLister: catalogueLister(),
      candleLister: windowLister(T0, 1).lister,
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("missing_field");
  });

  it("is 400 invalid_filter for a string that is not an interval at all", async () => {
    // Distinct from `interval_not_verified`: "1w" is not a CandleInterval, so
    // this layer refuses it while parsing. The module never sees it.
    const label = await account("cd-badinterval");
    const res = await api("GET", candlesPath(label, { pair: "BTCUSD", interval: "1w" }), {
      symbolLister: catalogueLister(),
      candleLister: windowLister(T0, 1).lister,
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("invalid_filter");
    expect(res.body.error.message).toContain("1m");
  });

  it.each([["abc"], [""], ["-1"], ["1.5"], ["1e3x"]])(
    "is 400 invalid_field for ?since=%s",
    async (value) => {
      const label = await account(`cd-since-${value === "" ? "empty" : value.replace(/\W/g, "")}`);
      const res = await api(
        "GET",
        candlesPath(label, { pair: "BTCUSD", interval: "1m", since: value }),
        { symbolLister: catalogueLister(), candleLister: windowLister(T0, 1).lister },
      );
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("invalid_field");
    },
  );

  it("accepts ?since=0 as a real value rather than treating it as absent", async () => {
    // The falsy-zero trap. `since=0` asks for everything and must reach the
    // module as 0, not as "no range requested" -- which the response's
    // `requestedSince` is what proves.
    const label = await account("cd-zero");
    const { lister, calls } = windowLister(T0 - 2 * MINUTE, 2);

    const res = await api(
      "GET",
      candlesPath(label, { pair: "BTCUSD", interval: "1m", since: "0" }),
      { symbolLister: catalogueLister(), candleLister: lister },
    );

    expect(res.status).toBe(200);
    expect(calls).toEqual([{ pair: "BTCUSD", interval: "1m", since: 0 }]);
    expect(res.body.data.requestedSince).toBe(0);
    expect(res.body.data.truncated).toBe(true);
  });

  // -- The module's refusals, each mapped through STATUS_BY_CODE -------------

  it("is 400 interval_not_verified for a real but unverified interval", async () => {
    const label = await account("cd-unverified");
    let candleCalls = 0;
    const lister: CandleLister = async () => {
      candleCalls += 1;
      return { ok: true, value: [candleAt(T0, 100_000_000n)], at: T0 };
    };

    const res = await api("GET", candlesPath(label, { pair: "BTCUSD", interval: "1h" }), {
      symbolLister: catalogueLister(),
      candleLister: lister,
    });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("interval_not_verified");
    expect(res.body.error.message).toContain('"1h"');
    // The gate is BEFORE the venue call, over HTTP as well as in the module.
    expect(candleCalls).toBe(0);
  });

  it("is 404 unknown_account for an unregistered label", async () => {
    // The row this endpoint added to STATUS_BY_CODE. `unknown_account` is
    // thrown here by the MODULE, not as an ApiError, so without that row it
    // would take the table's 400 default -- the same URL answering 400 where
    // /symbols answers 404.
    const res = await api(
      "GET",
      candlesPath(`nope-${suffix}`, { pair: "BTCUSD", interval: "1m" }),
      { symbolLister: catalogueLister(), candleLister: windowLister(T0, 1).lister },
    );
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("unknown_account");
  });

  it("is 400 pair_not_tradable for a pair the venue does not list", async () => {
    const label = await account("cd-untradable");
    let candleCalls = 0;
    const lister: CandleLister = async () => {
      candleCalls += 1;
      return { ok: true, value: [candleAt(T0, 100_000_000n)], at: T0 };
    };

    const res = await api("GET", candlesPath(label, { pair: "PEPEUSD", interval: "1m" }), {
      symbolLister: catalogueLister(),
      candleLister: lister,
    });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("pair_not_tradable");
    expect(candleCalls).toBe(0);
  });

  it("is 400 pair_not_tradable for a case-folded near-miss, naming the venue's spelling", async () => {
    // Step 28's live finding, over the wire on this endpoint: the catalogue is
    // `BTCUSD`, and `btcusd` must be refused with the real spelling named.
    const label = await account("cd-case");
    const res = await api("GET", candlesPath(label, { pair: "btcusd", interval: "1m" }), {
      symbolLister: catalogueLister(),
      candleLister: windowLister(T0, 1).lister,
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("pair_not_tradable");
    expect(res.body.error.message).toContain("BTCUSD");
  });

  it("is 503 tradable_set_unreadable when the venue cannot be asked", async () => {
    // NOT 502. This is a refusal to fetch on input this system could not
    // verify, which is the `not_attached`/`throttled` tier, and it is
    // deliberately a different status from the failed read below.
    const label = await account("cd-noset");
    const symbolLister: SymbolLister = async () => ({
      ok: false,
      kind: "transport",
      message: "connect ETIMEDOUT",
      retryable: true,
      at: T0,
    });

    const res = await api("GET", candlesPath(label, { pair: "BTCUSD", interval: "1m" }), {
      symbolLister,
      candleLister: windowLister(T0, 1).lister,
    });

    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe("tradable_set_unreadable");
  });

  it("is 502 candles_unavailable when the venue call fails", async () => {
    const label = await account("cd-down");
    const res = await api("GET", candlesPath(label, { pair: "BTCUSD", interval: "1m" }), {
      symbolLister: catalogueLister(),
      candleLister: failingCandles(),
    });

    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe("candles_unavailable");
    // The venue's own account of the failure survives to the caller.
    expect(res.body.error.message).toContain("connect ETIMEDOUT");
    // And no empty window was returned in its place.
    expect(res.body.data).toBeNull();
  });

  it("is 502 no_candles_returned for a successful but empty response", async () => {
    const label = await account("cd-empty");
    const empty: CandleLister = async () => ({ ok: true, value: [], at: T0 });

    const res = await api("GET", candlesPath(label, { pair: "BTCUSD", interval: "1m" }), {
      symbolLister: catalogueLister(),
      candleLister: empty,
    });

    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe("no_candles_returned");
    expect(res.body.data).toBeNull();
  });

  // -- The route itself ------------------------------------------------------

  it("requires an Access token like every other route", async () => {
    const label = await account("cd-auth");
    const res = await api("GET", candlesPath(label, { pair: "BTCUSD", interval: "1m" }), {
      token: null,
      symbolLister: catalogueLister(),
      candleLister: windowLister(T0, 1).lister,
    });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("access_jwt_missing");
  });

  it("is 405 on a write method, not 404", async () => {
    // Read-only by construction: the path exists, the method does not.
    const label = await account("cd-method");
    const res = await api("POST", candlesPath(label, { pair: "BTCUSD", interval: "1m" }), {
      symbolLister: catalogueLister(),
      candleLister: windowLister(T0, 1).lister,
    });
    expect(res.status).toBe(405);
    expect(res.body.error.code).toBe("method_not_allowed");
  });
});

/**
 * The HTTP surface over `/src/research/gather.ts` (section 21.4 Stage 1).
 *
 * WHAT IS PROVED HERE, and what deliberately is not. The assembly's own rules --
 * per-input isolation, the one-read-for-N-candidates design, the news pause, the
 * timestamp discipline -- have their own file of tests against the module. What
 * this file owns is the layer's share, and one property that exists ONLY at this
 * boundary and cannot be observed from inside the module at all:
 *
 *   EVERY INPUT'S OUTCOME MUST SURVIVE SERIALIZATION.
 *
 * That is not a restatement of the module's tests. `gather.ts` records a failure
 * as a real `CandleWindowError` instance, and `Error`'s `message` and `name` are
 * NON-ENUMERABLE -- so a bundle that reached `JSON.stringify` unserialized comes
 * back with `"error": {}` on every failed slot: a 200, correctly shaped, and
 * mute about what went wrong. Equally, `ConcentrationFacts.policy` carries a raw
 * `Money` bigint that throws `TypeError` outright inside `JSON.stringify`. Both
 * bugs are invisible to every test that stops at the module, which is why the
 * failure tests below assert THROUGH THE WIRE (`res.body`) rather than against a
 * returned object.
 *
 * The exchange is injected through `candleLister`/`symbolLister` -- the same
 * seams the Worker defaults to the real listers on. NOTHING HERE CONTACTS
 * GEMINI, BINANCE, OR ANY TRENDING VENDOR.
 */
describe("gather endpoint (section 21.4 Stage 1 assembly)", () => {
  const MINUTE = 60_000;
  const GEMINI_PAIRS = ["BTCUSD", "ETHUSD", "SOLUSD", "DOGEUSD"];
  /** Deliberately far from `clock`, so a surviving `fetchedAt` is a real assertion. */
  const VENUE_ANSWERED_AT = 1_960_000_000_000;

  function catalogueLister(pairs: readonly string[] = GEMINI_PAIRS): SymbolLister {
    return async () => ({ ok: true, value: [...pairs], at: T0 });
  }

  function candleAt(pair: string, openTime: number, close: bigint): Candle {
    return {
      pair,
      openTime,
      closeTime: openTime + MINUTE,
      open: close - 1n,
      high: close + 2n,
      low: close - 3n,
      close,
      volume: 400_000_000n,
      closed: true,
    };
  }

  /** A venue answering with three candles per pair, recording what it was asked. */
  function venue() {
    const calls: { pair: string; interval: string }[] = [];
    const lister: CandleLister = async (_account, query) => {
      calls.push({ pair: query.pair, interval: query.interval });
      return {
        ok: true,
        value: [
          candleAt(query.pair, T0 - 3 * MINUTE, 100_000_000n),
          candleAt(query.pair, T0 - 2 * MINUTE, 101_000_000n),
          candleAt(query.pair, T0 - MINUTE, 102_000_000n),
        ],
        at: VENUE_ANSWERED_AT,
      };
    };
    return { lister, calls };
  }

  /** A venue that fails for ONE named pair and answers for every other. */
  function venueFailingFor(badPair: string) {
    const calls: string[] = [];
    const lister: CandleLister = async (_account, query) => {
      calls.push(query.pair);
      if (query.pair === badPair) {
        return { ok: false, kind: "transport", message: "connect ETIMEDOUT", retryable: true, at: VENUE_ANSWERED_AT };
      }
      return {
        ok: true,
        value: [candleAt(query.pair, T0 - MINUTE, 100_000_000n)],
        at: VENUE_ANSWERED_AT,
      };
    };
    return { lister, calls };
  }

  async function account(prefix: string) {
    const label = `${prefix}-${suffix}`;
    await db.accounts.insert({ account_label: label, exchange: "gemini", created_at: T0, updated_at: T0 });
    return label;
  }

  async function watch(label: string, pair: string, id: string) {
    await db.watchlist.insert({
      id: `${id}-${suffix}`,
      account_label: label,
      pair,
      note: `${pair} is on the list on purpose`,
      added_by: HUMAN,
      added_at: T0 - 10_000,
      removed_by: null,
      removed_at: null,
    });
  }

  /** A committed bot, so concentration has something real to report. */
  async function bot(label: string, id: string, pair: string, allocated: string) {
    await db.botInstances.insert(
      botInstanceRow({
        id: `${id}-${suffix}`,
        account_label: label,
        exchange: "gemini",
        pair,
        allocated_capital: m(allocated),
        capital_asset: "USD",
        status: "running",
      }),
    );
  }

  function gatherPath(label: string, query: Record<string, string>) {
    return `/api/accounts/${label}/gather?${new URLSearchParams(query).toString()}`;
  }

  // -- The successful gather --------------------------------------------------

  it("returns a full named bundle with every input's own outcome and timestamp", async () => {
    const label = await account("gt-named");
    await bot(label, "b1", "BTCUSD", "500");
    await bot(label, "b2", "BTCUSD", "500");
    const { lister, calls } = venue();

    const res = await api("GET", gatherPath(label, { entryPoint: "named", pair: "BTCUSD", interval: "1m" }), {
      symbolLister: catalogueLister(),
      candleLister: lister,
    });

    expect(res.status).toBe(200);
    expect(res.body.error).toBeNull();
    expect(res.body.data.entryPoint).toBe("named");

    const bundle = res.body.data.bundle;

    // The candidate, verbatim, with the provenance 21.5 requirement 2 needs --
    // including WHO asked, taken from the verified Access token and never a
    // caller-supplied string.
    expect(bundle.candidate).toEqual({
      accountLabel: label,
      exchange: "gemini",
      pair: "BTCUSD",
      sources: [
        { kind: "named", requestedAs: "BTCUSD", requestedBy: HUMAN, requestedAt: expect.any(Number) },
      ],
    });

    // Candles: the outcome, and the VENUE's own answer instant -- not `now`.
    expect(bundle.candles.outcome).toBe("ok");
    expect(bundle.candles.value.fetchedAt).toBe(VENUE_ANSWERED_AT);
    expect(bundle.candles.value.count).toBe(3);
    expect(bundle.candles.value.candles[0].close).toBe("1.00000000");
    // A successful slot carries no `failedAt`: it has a real fetch time inside.
    expect(bundle.candles.failedAt).toBeUndefined();

    // Concentration: the flag, its facts, and the READ's own instant.
    expect(bundle.concentration.outcome).toBe("ok");
    expect(bundle.concentration.value.assessment).toBe("flagged");
    expect(bundle.concentration.value.readAt).toEqual(expect.any(Number));
    expect(bundle.concentration.value.samePairBots).toBe(2);

    // The news slot is a STATE, not a failure and not an absence.
    expect(bundle.news).toEqual({
      outcome: "not_yet_available",
      reason: expect.stringContaining("No news or sentiment vendor has been chosen"),
      decisionLogEntry: "docs/decision-log/30.md",
    });
    expect(bundle.news.error).toBeUndefined();
    expect(bundle.news.failedAt).toBeUndefined();
    expect(bundle.news.fetchedAt).toBeUndefined();

    expect(bundle.assembledAt).toEqual(expect.any(Number));
    expect(res.body.data.selectedAt).toEqual(expect.any(Number));

    // One candidate, one venue candle request.
    expect(calls).toEqual([{ pair: "BTCUSD", interval: "1m" }]);
  });

  /**
   * THE SERIALIZATION BOUNDARY'S SHARPEST EDGE, and the reason this test is
   * separate from the one above rather than an assertion inside it.
   *
   * `ConcentrationFacts.policy` is echoed so a human can reconstruct the
   * numbers, and `assetCapitalShareFlagAtPct` inside it is a raw `Money` bigint
   * -- the ONE bigint on this path that is not already rendered by the module.
   * Unconverted, `JSON.stringify` throws `TypeError: Do not know how to
   * serialize a BigInt` and this endpoint returns 500 on every successful
   * gather. It is also the last field anyone auditing money would look at,
   * because it is policy rather than an amount.
   */
  it("renders the policy echo's bigint threshold as a decimal string", async () => {
    const label = await account("gt-policy");
    await bot(label, "b1", "BTCUSD", "500");

    const res = await api("GET", gatherPath(label, { entryPoint: "named", pair: "BTCUSD", interval: "1m" }), {
      symbolLister: catalogueLister(),
      candleLister: venue().lister,
    });

    expect(res.status).toBe(200);
    expect(res.body.data.bundle.concentration.value.policy).toEqual({
      samePairBotCountFlagAt: 2,
      assetCapitalShareFlagAtPct: "40.00000000",
    });
  });

  // -- A REAL per-input failure, all the way to the wire ----------------------

  /**
   * The test the brief asked for by name: a genuine `fetchCandleWindow` refusal
   * driven through the endpoint, asserted on `res.body`.
   *
   * Two independent bugs die here, and neither is visible from inside the
   * module. First, `Error`'s non-enumerable `message` -- an unserialized error
   * arrives as `{}`, so `expect(...message).toContain(...)` is what proves the
   * explicit view ran. Second, isolation surviving the wire: the concentration
   * slot must still carry its real result in the SAME response, because a
   * candle failure erasing a successfully-read risk flag is the exact outcome
   * `gather.ts` exists to prevent.
   */
  it("carries a real candle failure to the wire with its code AND message, without touching the other slots", async () => {
    const label = await account("gt-fail");
    await bot(label, "b1", "BTCUSD", "500");
    await bot(label, "b2", "BTCUSD", "500");

    const res = await api("GET", gatherPath(label, { entryPoint: "named", pair: "BTCUSD", interval: "1m" }), {
      symbolLister: catalogueLister(),
      candleLister: venueFailingFor("BTCUSD").lister,
    });

    // A 200. Assembly ran; one input failed. The status is NOT the answer.
    expect(res.status).toBe(200);
    expect(res.body.error).toBeNull();

    const bundle = res.body.data.bundle;
    expect(bundle.candles.outcome).toBe("failed");
    // The producing module's OWN code, not a flattened restatement.
    expect(bundle.candles.error.code).toBe("candles_unavailable");
    // The message survived. `{}` here is the non-enumerable-property bug.
    expect(bundle.candles.error.message).toContain("connect ETIMEDOUT");
    expect(bundle.candles.failedAt).toEqual(expect.any(Number));
    // A failed slot has no value to read. The type says so; so does the wire.
    expect(bundle.candles.value).toBeUndefined();

    // ISOLATION, over the wire: the risk flag is untouched and still real.
    expect(bundle.concentration.outcome).toBe("ok");
    expect(bundle.concentration.value.assessment).toBe("flagged");
    expect(bundle.concentration.value.samePairBots).toBe(2);
    // And the paused news slot is still exactly itself.
    expect(bundle.news.outcome).toBe("not_yet_available");
  });

  /**
   * The THIRD outcome state, which the two above do not reach. `fetchCandleWindow`
   * does not wrap its ports, so a `CandleLister` that throws RAW produces
   * something that is not a `CandleWindowError` and never will be -- and
   * `gather.ts` keeps that a distinct state rather than dressing it up as one of
   * the module's enumerated refusals. This asserts the distinction survives the
   * wire: no `code` field, because inventing one is exactly the lie the third
   * arm exists to prevent.
   */
  it("carries a raw port throw as threw_unexpectedly, with no invented code", async () => {
    const label = await account("gt-threw");
    await bot(label, "b1", "BTCUSD", "500");
    const throwing: CandleLister = async () => {
      throw new TypeError("fetch failed: undefined is not an object");
    };

    const res = await api("GET", gatherPath(label, { entryPoint: "named", pair: "BTCUSD", interval: "1m" }), {
      symbolLister: catalogueLister(),
      candleLister: throwing,
    });

    expect(res.status).toBe(200);
    const candles = res.body.data.bundle.candles;
    expect(candles.outcome).toBe("threw_unexpectedly");
    expect(candles.error).toEqual({
      name: "TypeError",
      message: "fetch failed: undefined is not an object",
    });
    // NOT a refusal the module enumerated, so it must carry no code.
    expect(candles.error.code).toBeUndefined();
    expect(candles.failedAt).toEqual(expect.any(Number));
    // Still isolated: concentration is untouched.
    expect(res.body.data.bundle.concentration.outcome).toBe("ok");
  });

  it("describes a thrown NON-Error rather than reporting an empty object", async () => {
    const label = await account("gt-threw-string");
    const throwing: CandleLister = async () => {
      // Legal JavaScript, and the reason `error` is typed `unknown`.
      throw "the driver threw a bare string";
    };

    const res = await api("GET", gatherPath(label, { entryPoint: "named", pair: "BTCUSD", interval: "1m" }), {
      symbolLister: catalogueLister(),
      candleLister: throwing,
    });

    expect(res.status).toBe(200);
    expect(res.body.data.bundle.candles.error).toEqual({
      name: "string",
      message: "the driver threw a bare string",
    });
  });

  /**
   * AN ENDPOINT THAT REPORTS FAILURES MUST NOT FAIL WHILE DESCRIBING ONE.
   *
   * `String(Object.create(null))` throws `TypeError: Cannot convert object to
   * primitive value`. Unguarded, that throw escapes the serializer, is caught by
   * `handleApiRequest`'s funnel, and turns a 200-with-one-failed-slot into a
   * blanket 500 -- losing the concentration result that was read successfully,
   * which is the precise failure `gather.ts`'s isolation exists to prevent,
   * reintroduced one layer up at the very last moment.
   */
  it("survives a thrown value that cannot be converted to a string", async () => {
    const label = await account("gt-threw-hostile");
    await bot(label, "b1", "BTCUSD", "500");
    const throwing: CandleLister = async () => {
      throw Object.create(null);
    };

    const res = await api("GET", gatherPath(label, { entryPoint: "named", pair: "BTCUSD", interval: "1m" }), {
      symbolLister: catalogueLister(),
      candleLister: throwing,
    });

    // Not a 500.
    expect(res.status).toBe(200);
    expect(res.body.data.bundle.candles.outcome).toBe("threw_unexpectedly");
    expect(res.body.data.bundle.candles.error.message).toContain("cannot be converted to a string");
    // The successfully-read risk flag survived the hostile throw.
    expect(res.body.data.bundle.concentration.outcome).toBe("ok");
    expect(res.body.data.bundle.concentration.value.assessment).toBeDefined();
  });

  it("reports an interval the module refuses as that input's own failure, not a 400", async () => {
    const label = await account("gt-unverified");

    // `6h` parses as a real interval at this layer and is refused by the module
    // as unverified -- so it arrives as a RECORDED failure on the candles slot
    // rather than as a request-level refusal. The same error the candles
    // endpoint returns as a top-level 400, in its other correct place.
    const res = await api("GET", gatherPath(label, { entryPoint: "named", pair: "BTCUSD", interval: "6h" }), {
      symbolLister: catalogueLister(),
      candleLister: venue().lister,
    });

    expect(res.status).toBe(200);
    expect(res.body.data.bundle.candles.outcome).toBe("failed");
    expect(res.body.data.bundle.candles.error.code).toBe("interval_not_verified");
    // `not.toBe("")` would PASS for `undefined`, which is exactly the shape the
    // non-enumerable-message bug takes. Assert the type and the content.
    expect(typeof res.body.data.bundle.candles.error.message).toBe("string");
    expect(res.body.data.bundle.candles.error.message).toContain("6h");
  });

  // -- The watchlist door: N candidates, in the set's order -------------------

  it("returns one bundle per candidate in the set's order, and reads bot_instances once", async () => {
    const label = await account("gt-set");
    await watch(label, "BTCUSD", "w1");
    await watch(label, "ETHUSD", "w2");
    await watch(label, "SOLUSD", "w3");
    await bot(label, "b1", "BTCUSD", "500");
    const { lister, calls } = venue();

    const res = await api("GET", gatherPath(label, { entryPoint: "watchlist", interval: "1m" }), {
      symbolLister: catalogueLister(),
      candleLister: lister,
    });

    expect(res.status).toBe(200);
    expect(res.body.data.entryPoint).toBe("watchlist");

    const set = res.body.data.set;
    expect(set.count).toBe(3);
    // `bundles[i]` is `set.candidates[i]`, always.
    expect(set.bundles.map((b: any) => b.candidate.pair)).toEqual(
      set.set.candidates.map((c: any) => c.pair),
    );
    expect(set.bundles.map((b: any) => b.candidate.pair)).toEqual(["BTCUSD", "ETHUSD", "SOLUSD"]);

    // The set-level provenance survived, and says which door this came through.
    expect(set.set.entryPoint).toBe("watchlist");
    expect(set.set.trending).toBeNull();
    expect(set.set.watchlist).toEqual({ readAt: expect.any(Number), entriesRead: 3 });

    // ONE bot_instances read for N candidates, reported beside the results, with
    // its money rendered -- `ExposureBot.allocatedCapital` is the other bigint.
    expect(set.exposure.outcome).toBe("ok");
    expect(set.exposure.value.rowsRead).toBe(1);
    expect(set.exposure.value.committed[0].allocatedCapital).toBe("500.00000000");

    // N candidates cost exactly N candle requests -- the number the live
    // rate-budget question is about.
    expect(calls.map((c) => c.pair)).toEqual(["BTCUSD", "ETHUSD", "SOLUSD"]);
  });

  /**
   * A failing candidate keeps its POSITION and its neighbours keep their data.
   * A set that dropped it, or stopped at it, would still return a well-formed
   * response -- which is why the assertion is on the whole ordered list.
   */
  it("keeps a failed candidate in position without disturbing its neighbours", async () => {
    const label = await account("gt-partial");
    await watch(label, "BTCUSD", "w1");
    await watch(label, "ETHUSD", "w2");
    await watch(label, "SOLUSD", "w3");

    const res = await api("GET", gatherPath(label, { entryPoint: "watchlist", interval: "1m" }), {
      symbolLister: catalogueLister(),
      candleLister: venueFailingFor("ETHUSD").lister,
    });

    expect(res.status).toBe(200);
    const bundles = res.body.data.set.bundles;
    expect(bundles).toHaveLength(3);
    expect(bundles.map((b: any) => [b.candidate.pair, b.candles.outcome])).toEqual([
      ["BTCUSD", "ok"],
      ["ETHUSD", "failed"],
      ["SOLUSD", "ok"],
    ]);
    expect(bundles[1].candles.error.code).toBe("candles_unavailable");
    expect(bundles[0].candles.value.count).toBe(1);
    expect(bundles[2].candles.value.count).toBe(1);
  });

  it("returns an empty bundle list for an empty watchlist, not a refusal", async () => {
    const label = await account("gt-empty");

    const res = await api("GET", gatherPath(label, { entryPoint: "watchlist", interval: "1m" }), {
      symbolLister: catalogueLister(),
      candleLister: venue().lister,
    });

    expect(res.status).toBe(200);
    expect(res.body.data.set.count).toBe(0);
    expect(res.body.data.set.bundles).toEqual([]);
    expect(res.body.data.set.set.watchlist.entriesRead).toBe(0);
  });

  // -- The general door refuses, and says why ---------------------------------

  it("is 503 no_trending_vendor for entryPoint=general, naming the pause not an outage", async () => {
    const label = await account("gt-general");
    const { lister, calls } = venue();

    const res = await api("GET", gatherPath(label, { entryPoint: "general", interval: "1m" }), {
      symbolLister: catalogueLister(),
      candleLister: lister,
    });

    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe("no_trending_vendor");
    // It must not read as a transient vendor failure -- there is no vendor.
    expect(res.body.error.message).toContain("NO TRENDING VENDOR HAS BEEN CHOSEN");
    expect(res.body.error.message).toContain("entryPoint=watchlist");
    // BEFORE any work: no venue was called.
    expect(calls).toEqual([]);
  });

  /**
   * The refusal must not depend on any other parameter being well formed, or a
   * caller learns "interval is required" for a door that could never run.
   */
  it("refuses general BEFORE parsing interval, so the reason is the real one", async () => {
    const label = await account("gt-general-bare");

    const res = await api("GET", gatherPath(label, { entryPoint: "general" }), {
      symbolLister: catalogueLister(),
    });

    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe("no_trending_vendor");
  });

  /**
   * It refuses even for an account that does not exist. The refusal is about
   * this system's missing vendor, not about the request, so it must not be
   * reachable only after a registry read succeeds.
   */
  it("refuses general before the registry read", async () => {
    const res = await api("GET", gatherPath(`nope-${suffix}`, { entryPoint: "general", interval: "1m" }), {
      symbolLister: catalogueLister(),
    });

    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe("no_trending_vendor");
  });

  // -- Request-level refusals -------------------------------------------------

  it("is 400 missing_field with no entryPoint", async () => {
    const label = await account("gt-noentry");
    const res = await api("GET", gatherPath(label, { interval: "1m" }), {
      symbolLister: catalogueLister(),
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("missing_field");
  });

  it("is 400 invalid_filter for an entryPoint that is not one", async () => {
    const label = await account("gt-badentry");
    const res = await api("GET", gatherPath(label, { entryPoint: "everything", interval: "1m" }), {
      symbolLister: catalogueLister(),
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("invalid_filter");
    expect(res.body.error.message).toContain("watchlist");
  });

  it("is 400 missing_field for a named request with no pair", async () => {
    const label = await account("gt-nopair");
    const res = await api("GET", gatherPath(label, { entryPoint: "named", interval: "1m" }), {
      symbolLister: catalogueLister(),
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("missing_field");
  });

  it("is 400 missing_field with no interval, and offers no default", async () => {
    const label = await account("gt-nointerval");
    const res = await api("GET", gatherPath(label, { entryPoint: "named", pair: "BTCUSD" }), {
      symbolLister: catalogueLister(),
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("missing_field");
    expect(res.body.error.message).toContain("no default");
  });

  /**
   * REFUSED, not ignored. A silently-dropped `pair` reads exactly like a filter
   * that was applied -- someone would conclude the watchlist run only gathered
   * that pair, and the bundle list would not obviously contradict them.
   */
  it("is 400 invalid_field for a pair sent to the watchlist door", async () => {
    const label = await account("gt-straypair");
    await watch(label, "BTCUSD", "w1");

    const res = await api("GET", gatherPath(label, { entryPoint: "watchlist", pair: "BTCUSD", interval: "1m" }), {
      symbolLister: catalogueLister(),
      candleLister: venue().lister,
    });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("invalid_field");
    expect(res.body.error.message).toContain("only valid with entryPoint=named");
  });

  it("rejects a malformed since rather than reading it as the epoch", async () => {
    const label = await account("gt-since");
    for (const value of ["", "abc", "-1", "1.5"]) {
      const res = await api(
        "GET",
        gatherPath(label, { entryPoint: "watchlist", interval: "1m", since: value }),
        { symbolLister: catalogueLister(), candleLister: venue().lister },
      );
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("invalid_field");
    }
  });

  it("is 404 unknown_account for an unregistered account", async () => {
    const res = await api(
      "GET",
      gatherPath(`nope-${suffix}`, { entryPoint: "watchlist", interval: "1m" }),
      { symbolLister: catalogueLister(), candleLister: venue().lister },
    );
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("unknown_account");
  });

  /**
   * A NAMED candidate that the venue does not list is a request-level refusal,
   * because selection failed and there is no candidate to bundle. That is the
   * boundary between this endpoint's 4xx and its 200-with-a-failed-slot, and it
   * is worth pinning because the two look similar from outside.
   */
  it("is 400 pair_not_tradable for a named pair the venue does not list", async () => {
    const label = await account("gt-untradable");
    const res = await api(
      "GET",
      gatherPath(label, { entryPoint: "named", pair: "PEPEUSD", interval: "1m" }),
      { symbolLister: catalogueLister(), candleLister: venue().lister },
    );
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("pair_not_tradable");
  });

  it("requires Access like every other route, and is read-only", async () => {
    const label = await account("gt-auth");

    const unauth = await api("GET", gatherPath(label, { entryPoint: "watchlist", interval: "1m" }), {
      token: null,
    });
    expect(unauth.status).toBe(401);

    const written = await api("POST", gatherPath(label, { entryPoint: "watchlist", interval: "1m" }), {
      symbolLister: catalogueLister(),
    });
    expect(written.status).toBe(405);
    expect(written.body.error.code).toBe("method_not_allowed");
  });
});

/**
 * The assess endpoint (section 21.4 Stage 2) -- gather then one model call.
 *
 * NO TEST HERE REACHES A MODEL. Every assessment is driven by an injected fake
 * that records its calls, and three tests assert the call count POSITIVELY
 * rather than inferring it from the response -- `news.ts`'s mutation lesson
 * (decision log 30), where a test asserted the right conclusion for the wrong
 * reason and, under mutation, pointed the suite at a live vendor.
 *
 * Five properties, each one this endpoint would look correct without:
 *
 *  1. THE WHOLE ANSWER IS ON THE WIRE. Strategy, claims with their citations
 *     RESOLVED to real evidence, every evidence item OFFERED (not just the cited
 *     ones), the envelope shape, the duplicate-key report, and the gather bundle
 *     that produced it all. Anything missing here is a proposal a human cannot
 *     check (21.5 requirement 2).
 *  2. A FAILED INPUT IS REPORTED, NOT HIDDEN. A failed concentration read comes
 *     back in the bundle with its own code, beside a real assessment -- because
 *     the prompt states it as missing and the answer is still grounded.
 *  3. NO PRICES MEANS NO MODEL CALL. The precondition fires before the model,
 *     and the model is asked ZERO times.
 *  4. A BAD ANSWER IS A FAILED REQUEST. A parse refusal is a 502 carrying the
 *     parser's own code -- never a 200 with a degraded body.
 *  5. THE BIGINTS SURVIVE. The bundle carries `policy.assetCapitalShareFlagAtPct`
 *     and `allocatedCapital`, both of which throw `JSON.stringify` unconverted
 *     (decision log 36). These assertions run against `res.body`, after
 *     serialization, because that is the only place the bug exists.
 */
describe("assess endpoint (section 21.4 Stage 2)", () => {
  const MINUTE = 60_000;
  const VENUE_ANSWERED_AT = 1_960_000_000_000;

  const catalogue: SymbolLister = async () => ({ ok: true, value: ["BTCUSD", "ETHUSD"], at: T0 });

  function candleAt(pair: string, openTime: number, close: bigint): Candle {
    return {
      pair,
      openTime,
      closeTime: openTime + MINUTE,
      open: close - 1n,
      high: close + 2n,
      low: close - 3n,
      close,
      volume: 400_000_000n,
      closed: true,
    };
  }

  const goodVenue: CandleLister = async (_account, query) => ({
    ok: true,
    value: [
      candleAt(query.pair, T0 - 3 * MINUTE, 100_000_000n),
      candleAt(query.pair, T0 - 2 * MINUTE, 101_000_000n),
      candleAt(query.pair, T0 - MINUTE, 102_000_000n),
    ],
    at: VENUE_ANSWERED_AT,
  });

  const deadVenue: CandleLister = async () => ({
    ok: false,
    kind: "transport",
    message: "connect ETIMEDOUT",
    retryable: true,
    at: VENUE_ANSWERED_AT,
  });

  async function account(prefix: string) {
    const label = `${prefix}-${suffix}`;
    await db.accounts.insert({ account_label: label, exchange: "gemini", created_at: T0, updated_at: T0 });
    return label;
  }

  async function bot(label: string, id: string, pair: string, allocated: string) {
    await db.botInstances.insert(
      botInstanceRow({
        id: `${id}-${suffix}`,
        account_label: label,
        exchange: "gemini",
        pair,
        allocated_capital: m(allocated),
        capital_asset: "USD",
        status: "running",
      }),
    );
  }

  /** A model that answers with whatever it is given, and counts its calls. */
  function fakeModel(answer: unknown) {
    const prompts: string[] = [];
    const model: AssessModel = async (request) => {
      prompts.push(request.prompt);
      return { text: answer, raw: answer };
    };
    return { model, prompts };
  }

  /** The shape a real call really returns (decision logs 37, 39). */
  const goodAnswer = (citations: string[] = ["candles.range_pct"]) => ({
    response: {
      strategy: "grid",
      claims: [{ statement: "The range is wide relative to the close.", citations }],
    },
  });

  const assessPath = (label: string, query: Record<string, string>) =>
    `/api/accounts/${label}/assess?${new URLSearchParams(query).toString()}`;

  // -- Property 1: the whole answer ------------------------------------------

  it("returns the assessment and the bundle it was drawn from", async () => {
    const label = await account("as-ok");
    await bot(label, "b1", "BTCUSD", "500");
    const { model, prompts } = fakeModel(goodAnswer());

    const res = await api("GET", assessPath(label, { pair: "BTCUSD", interval: "1m" }), {
      symbolLister: catalogue,
      candleLister: goodVenue,
      assessModel: model,
    });

    expect(res.status).toBe(200);
    expect(prompts, "the model was not called exactly once").toHaveLength(1);

    const { assess, bundle, entryPoint } = res.body.data;
    expect(entryPoint).toBe("named");

    expect(assess.strategy).toBe("grid");
    expect(assess.model).toBe("@cf/meta/llama-3.3-70b-instruct-fp8-fast");
    expect(assess.envelope).toBe("envelope_object");
    expect(assess.duplicateKeyCheck).toBe("unavailable_transport_parsed");
    expect(assess.promptVersion).toBe("assess/1");
    expect(assess.promptChars).toBe(prompts[0]!.length);
    expect(typeof assess.latencyMs).toBe("number");

    // The claim's citation is RESOLVED: id, label, the rendered value, and the
    // path into the bundle. A bare id would leave a reader unable to check it.
    expect(assess.claims).toHaveLength(1);
    const cited = assess.claims[0].citations[0];
    expect(cited.id).toBe("candles.range_pct");
    expect(typeof cited.label).toBe("string");
    // TYPE AND CONTENT, not `not.toBe("")`. A dropped field is `undefined`, and
    // `expect(undefined).not.toBe("")` PASSES -- the exact weak-assertion bug
    // decision log 36 recorded, found here again by the mutation run.
    expect(typeof cited.value).toBe("string");
    expect(cited.value).toMatch(/%$/);
    expect(typeof cited.source).toBe("string");
    expect(cited.source).toContain("candles.value.candles");
    // And the resolved citation carries the SAME value the evidence table does,
    // so the two cannot drift into disagreeing about one datum.
    const offered = assess.evidence.find((e: { id: string }) => e.id === "candles.range_pct");
    expect(offered).toBeDefined();
    expect(cited.value).toBe(offered.value);
    expect(cited.source).toBe(offered.source);

    // Everything OFFERED, so what the model ignored is visible.
    expect(assess.evidence.length).toBeGreaterThan(assess.claims[0].citations.length);
    expect(assess.evidence.some((e: { id: string }) => e.id === "concentration.status")).toBe(true);
    expect(assess.evidence.some((e: { id: string }) => e.id === "news.status")).toBe(true);

    // The settings that produced it, echoed whole.
    expect(assess.settings.temperature).toBe(0);
    expect(assess.settings.seed).toBe(20260811);
    expect(assess.settings.responseFormat.type).toBe("json_schema");

    // And the raw source data beside the answer.
    expect(bundle.candles.outcome).toBe("ok");
    expect(bundle.candles.value.count).toBe(3);
    expect(bundle.news.outcome).toBe("not_yet_available");
    expect(bundle.candidate.pair).toBe("BTCUSD");
  });

  // -- Property 5: the bigints that throw JSON.stringify ----------------------

  it("serializes the bundle's money fields rather than returning a 500", async () => {
    const label = await account("as-money");
    await bot(label, "b1", "BTCUSD", "500");
    await bot(label, "b2", "BTCUSD", "500");
    const { model } = fakeModel(goodAnswer());

    const res = await api("GET", assessPath(label, { pair: "BTCUSD", interval: "1m" }), {
      symbolLister: catalogue,
      candleLister: goodVenue,
      assessModel: model,
    });

    expect(res.status).toBe(200);
    // The policy threshold: a POLICY field, not an amount, and the last place
    // anyone auditing money looks. Unconverted it is a 500 on every success.
    expect(res.body.data.bundle.concentration.value.policy.assetCapitalShareFlagAtPct).toBe("40.00000000");
    expect(res.body.data.bundle.candles.value.candles[0].close).toBe("1.00000000");
  });

  // -- Property 2: a failed input is reported, not hidden ---------------------

  it("still assesses when the concentration read failed, and reports the failure", async () => {
    const label = await account("as-conc");
    const { model, prompts } = fakeModel(goodAnswer());
    // A Proxy rather than a spread: `Database`'s own methods (`tableExists`,
    // which the schema guard calls before any handler runs) may live on a
    // prototype, and a spread would drop them and turn this into a 500 for a
    // reason that has nothing to do with what is being tested.
    // Methods are bound to the TARGET, not the proxy. `Database` uses private
    // fields (`#d1`), and a private field read through a Proxy receiver throws
    // "Cannot read private member ... from an object whose class did not declare
    // it" -- which would turn this into a 500 for a reason that has nothing to do
    // with what is being tested. The schema guard calls `tableExists` before any
    // handler runs, so it fails first and the test never reaches the assertion.
    const brokenBots = new Proxy(db.botInstances, {
      get(target, prop) {
        if (prop === "findMany") {
          return async () => {
            throw new Error("D1 refused the read");
          };
        }
        const value = Reflect.get(target, prop, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const broken = new Proxy(db, {
      get(target, prop) {
        if (prop === "botInstances") return brokenBots;
        const value = Reflect.get(target, prop, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as Database;

    const res = await api("GET", assessPath(label, { pair: "BTCUSD", interval: "1m" }), {
      symbolLister: catalogue,
      candleLister: goodVenue,
      assessModel: model,
      db: broken,
    });

    expect(res.status).toBe(200);
    expect(prompts).toHaveLength(1);
    // The assessment happened...
    expect(res.body.data.assess.strategy).toBe("grid");
    // ...the gap is reported with the producing module's OWN code...
    expect(res.body.data.bundle.concentration.outcome).toBe("failed");
    expect(res.body.data.bundle.concentration.error.code).toBe("bot_list_unreadable");
    // ...and the model was TOLD it was missing rather than not told at all.
    expect(prompts[0]).toContain("bot_list_unreadable");
    expect(prompts[0]).toContain("MISSING");
  });

  // -- Property 3: no prices, no model call ----------------------------------

  it("refuses with no candle window, and does NOT call the model", async () => {
    const label = await account("as-nocandles");
    const { model, prompts } = fakeModel(goodAnswer());

    const res = await api("GET", assessPath(label, { pair: "BTCUSD", interval: "1m" }), {
      symbolLister: catalogue,
      candleLister: deadVenue,
      assessModel: model,
    });

    // 502, and `candles_unavailable`: the venue answered badly, which is the
    // same distinction that code draws one stage earlier. The generic
    // `no_price_history` is what the precondition threw; the wire reports why.
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe("candles_unavailable");
    expect(res.body.error.message).toContain("no assessment was attempted");
    expect(res.body.error.message).toContain("BTCUSD");
    expect(prompts, "a model call was spent on a candidate with no prices").toHaveLength(0);
  });

  it("refuses an untradable pair before any model call", async () => {
    const label = await account("as-untradable");
    const { model, prompts } = fakeModel(goodAnswer());

    const res = await api("GET", assessPath(label, { pair: "NOPEUSD", interval: "1m" }), {
      symbolLister: catalogue,
      candleLister: goodVenue,
      assessModel: model,
    });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("pair_not_tradable");
    expect(prompts).toHaveLength(0);
  });

  // -- Property 4: a bad answer is a failed request --------------------------

  it("turns a parse refusal into a 502 carrying the parser's own code", async () => {
    const label = await account("as-badjson");
    const { model, prompts } = fakeModel({ response: "I'd suggest a grid here." });

    const res = await api("GET", assessPath(label, { pair: "BTCUSD", interval: "1m" }), {
      symbolLister: catalogue,
      candleLister: goodVenue,
      assessModel: model,
    });

    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe("not_json");
    expect(res.body.data).toBeNull();
    expect(prompts, "the endpoint retried a refused answer").toHaveLength(1);
  });

  it("refuses a hedged strategy rather than coercing it", async () => {
    const label = await account("as-hedged");
    const { model } = fakeModel({
      response: { strategy: "dca or grid", claims: [{ statement: "x", citations: ["candles.count"] }] },
    });

    const res = await api("GET", assessPath(label, { pair: "BTCUSD", interval: "1m" }), {
      symbolLister: catalogue,
      candleLister: goodVenue,
      assessModel: model,
    });

    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe("strategy_not_recognised");
  });

  it("refuses an invented citation, so ungrounded prose never reaches a human", async () => {
    const label = await account("as-invented");
    const { model } = fakeModel(goodAnswer(["candles.rsi_14"]));

    const res = await api("GET", assessPath(label, { pair: "BTCUSD", interval: "1m" }), {
      symbolLister: catalogue,
      candleLister: goodVenue,
      assessModel: model,
    });

    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe("citation_unknown");
  });

  // -- Parameters -------------------------------------------------------------

  it("requires `pair`", async () => {
    const label = await account("as-nopair");
    const res = await api("GET", assessPath(label, { interval: "1m" }), { symbolLister: catalogue });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("missing_field");
  });

  it("requires `interval`, with no default", async () => {
    const label = await account("as-nointerval");
    const res = await api("GET", assessPath(label, { pair: "BTCUSD" }), { symbolLister: catalogue });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("missing_field");
    expect(res.body.error.message).toContain("DIFFERENT");
  });

  /**
   * The refusal must name the REAL cause, not the proximate one.
   *
   * `1h` is a declared interval that `VERIFIED_INTERVALS` does not contain, so
   * the candle fetch refuses with `interval_not_verified` and the bundle comes
   * back with no window -- which then trips `assessCandidate`'s
   * `no_price_history` precondition. Reporting THAT would send an operator to
   * check the venue's prices when the actual answer is "this system has never
   * verified that interval". The endpoint surfaces the candle module's own code
   * and status instead, with the precondition itself untouched.
   */
  it("names the real reason a candle window is missing, not just `no_price_history`", async () => {
    const label = await account("as-badinterval");
    const { model, prompts } = fakeModel(goodAnswer());
    const res = await api("GET", assessPath(label, { pair: "BTCUSD", interval: "1h" }), {
      symbolLister: catalogue,
      candleLister: goodVenue,
      assessModel: model,
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("interval_not_verified");
    // Both halves: what actually failed, and that nothing was assessed because of it.
    expect(res.body.error.message).toContain("no assessment was attempted");
    expect(res.body.error.message).toContain("BTCUSD");
    expect(prompts).toHaveLength(0);
  });

  it("is Access-gated like every other route", async () => {
    const label = await account("as-auth");
    const res = await api("GET", assessPath(label, { pair: "BTCUSD", interval: "1m" }), { token: null });
    expect(res.status).toBe(401);
  });
});


// ---------------------------------------------------------------------------
// Section 21.4 Stage 3 (Derive)
// ---------------------------------------------------------------------------

/**
 * `GET /api/accounts/:label/derive`, driven as the TWO SEPARATE CALLS it is.
 *
 * ── WHAT IS GENUINELY NEW HERE, AND WHAT IS PORTED ──
 *
 * Everything about building the prompt, reading the answer and validating the
 * parameters was proven live in step 41 and is covered by
 * `src/research/derive*.test.ts`. The ONE thing no test in this repository has
 * ever exercised is the boundary this endpoint introduces: **an assessment that
 * arrived from an earlier, separate HTTP call, re-verified against evidence
 * gathered later.** The deleted probe called Assess fresh inside the same
 * request, so the assessment and the evidence were the same objects and drift
 * was impossible by construction.
 *
 * So the tests below do the real thing: they call `/assess`, take its REAL
 * response body, project the citations to ids exactly as a client would, MOVE
 * THE VENUE ON, and then call `/derive` as a second request. Three of them then
 * make that second call fail in the three ways only a second call can.
 *
 * The probe's own four properties are ported rather than assumed, and ONE
 * CHANGES DELIBERATELY: the probe reported a refusal at 200 because a refusal
 * was its RESULT. A real endpoint refuses with a status, and the assertions say
 * which -- 502 with the parser's or validator's own code for a bad model answer,
 * 409 for a stale resubmission, 400 for a malformed one.
 *
 * NO TEST HERE REACHES A MODEL. Both stages are driven by injected fakes, and
 * every refusal test asserts positively that the Derive model was called ZERO
 * times -- `news.ts`'s mutation lesson (decision log 30), and here it also means
 * a rejected resubmission never costs a paid inference.
 */
describe("derive endpoint (section 21.4 Stage 3)", () => {
  const MINUTE = 60_000;
  const VENUE_ANSWERED_AT = 1_960_000_000_000;

  const catalogue: SymbolLister = async () => ({ ok: true, value: ["BTCUSD", "ETHUSD"], at: T0 });

  /**
   * A venue whose window this test can MOVE, which is what makes the two calls
   * genuinely separate rather than two reads of one frozen fixture.
   *
   * `count` sets how deep the window is (and therefore how many
   * `candles.bucket.NN` ids exist); `shift` moves both the times and the prices,
   * so a later window is different DATA and not the same numbers restamped.
   */
  let venueCount = 40;
  let venueShift = 0;

  const venue: CandleLister = async (_account, query) => ({
    ok: true,
    value: Array.from({ length: venueCount }, (_, i) => {
      const step = venueShift + i;
      const close = BigInt(100 + (step % 7)) * 1_000_000n;
      return {
        pair: query.pair,
        openTime: T0 - (venueCount - i) * MINUTE + venueShift * MINUTE,
        closeTime: T0 - (venueCount - i) * MINUTE + venueShift * MINUTE + MINUTE,
        open: close - 1_000_000n,
        high: close + 8_000_000n,
        low: close - 4_000_000n,
        close,
        volume: 400_000_000n,
        closed: true,
      };
    }),
    at: VENUE_ANSWERED_AT + venueShift * MINUTE,
  });

  /** Gemini's real shape: a quantity floor, and NO notional floor. */
  const details: SymbolDetailLister = async (_account, pair) => ({
    ok: true,
    value: {
      pair,
      baseAsset: "BTC",
      quoteAsset: "USD",
      status: "TRADING",
      tickSize: 1_000_000n,
      minPrice: 0n,
      maxPrice: 0n,
      stepSize: 100_000n,
      minQuantity: 100_000n,
      maxQuantity: 0n,
      minNotional: 0n,
      maxNotional: 0n,
      instrument: "spot",
      fetchedAt: VENUE_ANSWERED_AT,
    },
    at: VENUE_ANSWERED_AT,
  });

  beforeEach(() => {
    venueCount = 40;
    venueShift = 0;
  });

  async function deriveAccount(prefix: string) {
    const label = `${prefix}-${suffix}`;
    await db.accounts.insert({ account_label: label, exchange: "gemini", created_at: T0, updated_at: T0 });
    await seedPlaceholderTotalBalance(
      db,
      { accountLabel: label, asset: "USD", totalBalance: m("10000"), note: "derive fixture" },
      { actor: HUMAN, now: T0 },
    );
    return label;
  }

  /** What the Assess model says. `citations` is the id list under test. */
  const assessAnswer = (citations: string[] = ["candles.range_pct"]) => ({
    response: {
      strategy: "grid",
      claims: [{ statement: "The range is wide relative to the close.", citations }],
    },
  });

  const cited = (value: unknown, id = "candles.last_close") => ({ value, citations: [id] });

  const deriveAnswer = (overrides: Record<string, unknown> = {}) => ({
    response: {
      strategy: "grid",
      parameters: {
        upperBound: cited("108.00000000", "candles.high"),
        lowerBound: cited("96.00000000", "candles.low"),
        gridLines: cited(5, "candles.range_pct"),
        spacing: cited("arithmetic", "candles.range_pct"),
        orderSize: cited("50.00000000", "capital.row.01.available"),
        stopLossPct: cited("5.00000000", "candles.range_pct"),
        breakoutTakeProfit: cited(true, "assessment.strategy"),
        breakoutThresholdPct: cited(null, "candles.range_pct"),
        takeProfitAmount: cited(null, "capital.row.01.available"),
      },
      allocatedCapital: cited("400.00000000", "capital.row.01.available"),
      capitalAsset: cited("USD", "capital.row.01.asset"),
      notes: [{ statement: "The observed range sets the bounds.", citations: ["candles.range_pct"] }],
      ...overrides,
    },
  });

  function fakes(assess: unknown, derive: unknown) {
    const assessCalls: string[] = [];
    const deriveCalls: { prompt: string; strategy: string }[] = [];
    const assessModel: AssessModel = async (request) => {
      assessCalls.push(request.prompt);
      return { text: assess, raw: assess };
    };
    const deriveModel: DeriveModel = async (request) => {
      deriveCalls.push({ prompt: request.prompt, strategy: request.strategy });
      return { text: derive, raw: derive };
    };
    return { assessModel, deriveModel, assessCalls, deriveCalls };
  }

  const derivePath = (label: string, query: Record<string, string>) =>
    `/api/accounts/${label}/derive?${new URLSearchParams(query).toString()}`;

  /**
   * THE CLIENT'S WHOLE JOB, written out rather than hidden in a helper.
   *
   * `/assess` publishes each citation as a whole `EvidenceItem`; `/derive` takes
   * evidence ID STRINGS, because the submitted `label`/`value`/`source` are a
   * rendering of data as it stood at the ORIGINAL call and this stage must
   * ignore them. That is the one projection a caller performs, and it is four
   * lines of `jq`.
   */
  function resubmissionFrom(assess: any): string {
    return JSON.stringify({
      strategy: assess.strategy,
      claims: assess.claims.map((claim: any) => ({
        statement: claim.statement,
        citations: claim.citations.map((item: any) => item.id),
      })),
      envelope: assess.envelope,
      duplicateKeyCheck: assess.duplicateKeyCheck,
    });
  }

  /** Call `/assess` for real and hand back its REAL response body. */
  async function realAssess(label: string, assessModel: AssessModel) {
    const res = await api(
      "GET",
      `/api/accounts/${label}/assess?${new URLSearchParams({ pair: "BTCUSD", interval: "1m" }).toString()}`,
      { symbolLister: catalogue, candleLister: venue, symbolDetailLister: details, assessModel },
    );
    expect(res.status, "the /assess call this test builds on did not succeed").toBe(200);
    return res.body.data.assess;
  }

  // -- Requirement 1: /assess's response already supports resubmission --------

  it("returns from /assess everything a client needs to resubmit, with nothing missing", async () => {
    const label = await deriveAccount("dv-shape");
    const f = fakes(assessAnswer(), deriveAnswer());
    const assess = await realAssess(label, f.assessModel);

    // The exact strategy string, unmodified.
    expect(assess.strategy).toBe("grid");
    // The exact claims, with their exact citations, each carrying its id.
    expect(assess.claims).toHaveLength(1);
    expect(assess.claims[0].statement).toBe("The range is wide relative to the close.");
    expect(assess.claims[0].citations[0].id).toBe("candles.range_pct");
    // The two audit fields the resubmission contract requires.
    expect(assess.envelope).toBe("envelope_object");
    expect(assess.duplicateKeyCheck).toBe("unavailable_transport_parsed");

    // And the projection really is total: every field the contract needs is
    // present and non-undefined on the real body.
    const submission = JSON.parse(resubmissionFrom(assess));
    expect(Object.keys(submission).sort()).toEqual([
      "claims",
      "duplicateKeyCheck",
      "envelope",
      "strategy",
    ]);
    expect(submission.claims[0].citations).toEqual(["candles.range_pct"]);
  });

  // -- THE NEW BOUNDARY: a real second call, against time-shifted evidence ----

  it("derives from an assessment resubmitted after the venue MOVED", async () => {
    const label = await deriveAccount("dv-shift");
    const f = fakes(assessAnswer(), deriveAnswer());

    // CALL 1.
    const assess = await realAssess(label, f.assessModel);
    const submission = resubmissionFrom(assess);

    // Real time passes: the venue now answers with a later, differently-priced
    // window. Same ids, different data -- the ordinary case.
    venueShift = 600;

    // CALL 2, a genuinely separate request.
    const res = await api(
      "GET",
      derivePath(label, { pair: "BTCUSD", interval: "1m", assessment: submission }),
      {
        symbolLister: catalogue,
        candleLister: venue,
        symbolDetailLister: details,
        deriveModel: f.deriveModel,
      },
    );

    expect(res.status).toBe(200);
    // ONE assess call (the first request) and ONE derive call. The second
    // request did NOT re-run Stage 2.
    expect(f.assessCalls, "/derive made its own Assess call").toHaveLength(1);
    expect(f.deriveCalls).toHaveLength(1);

    const body = res.body.data;
    expect(body.assessment.source).toBe("client_resubmitted");
    expect(body.assessment.citationsReverified).toBe(true);
    expect(body.assessment.strategy).toBe("grid");

    // THE ASSERTION THAT MAKES RE-VERIFICATION VISIBLE: the citation came back
    // resolved against the SECOND call's evidence, not the first's.
    const fresh = body.assessment.claims[0].citations[0];
    const offered = body.derive.evidence.find((e: { id: string }) => e.id === "candles.range_pct");
    expect(fresh.id).toBe("candles.range_pct");
    expect(fresh.value).toBe(offered.value);
    // And that really is a different window than /assess saw.
    const first = assess.evidence.find((e: { id: string }) => e.id === "candles.last_close");
    const second = body.derive.evidence.find((e: { id: string }) => e.id === "candles.last_close");
    expect(second.value).not.toBe(first.value);

    // A real, fully validated proposal.
    expect(body.derive.strategy).toBe("grid");
    expect(body.derive.promptVersion).toBe("derive/1");
    expect(body.derive.proposal.params.strategy).toBe("grid");
    expect(body.derive.proposal.params.upperBound).toBe("108.00000000");
    expect(body.derive.proposal.params.gridLines).toBe(5);
    expect(body.derive.proposal.allocatedCapital).toBe("400.00000000");
    expect(body.derive.proposal.capitalAsset).toBe("USD");
    expect(body.derive.proposal.availableAtProposal).toBe("10000.00000000");
    // Gemini publishes a quantity floor only, and the response says so.
    expect(body.derive.proposal.minimumOrderCheck).toBe("quantity");
    // Every number beside the ids it rests on, as whole evidence items.
    expect(body.derive.proposal.citations.upperBound[0].id).toBe("candles.high");
    expect(body.derive.proposal.citations.orderSize[0].id).toBe("capital.row.01.available");
    expect(body.derive.notes[0].citations[0].id).toBe("candles.range_pct");

    // Stage 2's own claims reached Stage 3's prompt as citable evidence.
    expect(f.deriveCalls[0]!.strategy).toBe("grid");
    expect(f.deriveCalls[0]!.prompt).toContain('THE STRATEGY IS ALREADY DECIDED AND IT IS "grid"');
    expect(f.deriveCalls[0]!.prompt).toContain("The range is wide relative to the close.");

    // The unverifiable audit facts are carried, and LABELLED as unverifiable.
    expect(body.assessment.unverifiedOriginalCall.envelope).toBe("envelope_object");
    expect(body.assessment.unverifiedOriginalCall.duplicateKeyCheck).toBe(
      "unavailable_transport_parsed",
    );
  });

  it("REFUSES a resubmission whose citation no longer resolves, without calling the model", async () => {
    // THE TEST THAT PROVES RE-VERIFICATION IS REAL RATHER THAN DECORATIVE.
    //
    // The first call sees a 40-candle window, so the Assess model can and does
    // cite `candles.bucket.19`. The venue then answers with 8 candles -- a
    // shallower window, which is an ordinary thing to happen -- and only buckets
    // 01..08 exist. Nobody fabricated anything; the id aged out.
    const label = await deriveAccount("dv-stale");
    const f = fakes(assessAnswer(["candles.bucket.19"]), deriveAnswer());

    const assess = await realAssess(label, f.assessModel);
    expect(assess.claims[0].citations[0].id).toBe("candles.bucket.19");

    venueCount = 8;

    const res = await api(
      "GET",
      derivePath(label, { pair: "BTCUSD", interval: "1m", assessment: resubmissionFrom(assess) }),
      {
        symbolLister: catalogue,
        candleLister: venue,
        symbolDetailLister: details,
        deriveModel: f.deriveModel,
      },
    );

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("citation_unknown");
    expect(res.body.error.message).toContain("candles.bucket.19");
    // THE ASSERTION THAT MATTERS: no paid inference was spent on a stale
    // assessment, and no proposal was produced from one.
    expect(f.deriveCalls, "the model was called with a stale assessment").toHaveLength(0);
    expect(res.body.data).toBe(null);
  });

  it("REFUSES a fabricated citation the same way, so honesty is not what is being checked", async () => {
    const label = await deriveAccount("dv-fake");
    const f = fakes(assessAnswer(), deriveAnswer());
    const assess = await realAssess(label, f.assessModel);

    const submission = JSON.parse(resubmissionFrom(assess));
    submission.claims[0].citations = ["candles.rsi_14"];

    const res = await api(
      "GET",
      derivePath(label, { pair: "BTCUSD", interval: "1m", assessment: JSON.stringify(submission) }),
      {
        symbolLister: catalogue,
        candleLister: venue,
        symbolDetailLister: details,
        deriveModel: f.deriveModel,
      },
    );

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("citation_unknown");
    expect(f.deriveCalls).toHaveLength(0);
  });

  it("REFUSES every price citation when the candle fetch fails on the second call", async () => {
    const label = await deriveAccount("dv-nocandles");
    const f = fakes(assessAnswer(), deriveAnswer());
    const assess = await realAssess(label, f.assessModel);

    const brokenVenue: CandleLister = async () => ({
      ok: false,
      kind: "transport",
      message: "gemini did not answer the candle request",
      retryable: true,
      at: VENUE_ANSWERED_AT,
    });

    const res = await api(
      "GET",
      derivePath(label, { pair: "BTCUSD", interval: "1m", assessment: resubmissionFrom(assess) }),
      {
        symbolLister: catalogue,
        candleLister: brokenVenue,
        symbolDetailLister: details,
        deriveModel: f.deriveModel,
      },
    );

    // The re-verification fires FIRST -- before `deriveParameters`' own
    // no-price-history precondition -- because the assessment is checked against
    // the fresh bundle as soon as it exists.
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("citation_unknown");
    expect(f.deriveCalls).toHaveLength(0);
  });

  it("REFUSES a strategy that is not exactly dca or grid", async () => {
    const label = await deriveAccount("dv-strat");
    const f = fakes(assessAnswer(), deriveAnswer());
    const assess = await realAssess(label, f.assessModel);

    for (const strategy of ["GRID", "Dca", " grid", "momentum", "dca or grid"]) {
      const submission = JSON.parse(resubmissionFrom(assess));
      submission.strategy = strategy;
      const res = await api(
        "GET",
        derivePath(label, { pair: "BTCUSD", interval: "1m", assessment: JSON.stringify(submission) }),
        {
          symbolLister: catalogue,
          candleLister: venue,
          symbolDetailLister: details,
          deriveModel: f.deriveModel,
        },
      );
      expect(res.status, `${strategy} was not refused`).toBe(400);
      expect(res.body.error.code).toBe("strategy_not_recognised");
    }
    expect(f.deriveCalls, "a model was called for an unrecognised strategy").toHaveLength(0);
  });

  it("refuses a self-contradictory resubmission that JSON.parse would silently resolve", async () => {
    // The duplicate-key scan runs here and cannot run on either model path,
    // because this endpoint holds the caller's own bytes.
    const label = await deriveAccount("dv-dupe");
    const f = fakes(assessAnswer(), deriveAnswer());
    const assess = await realAssess(label, f.assessModel);

    const inner = resubmissionFrom(assess).replace('{"strategy":"grid"', '{"strategy":"dca","strategy":"grid"');
    const res = await api(
      "GET",
      derivePath(label, { pair: "BTCUSD", interval: "1m", assessment: inner }),
      {
        symbolLister: catalogue,
        candleLister: venue,
        symbolDetailLister: details,
        deriveModel: f.deriveModel,
      },
    );

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("duplicate_key");
    expect(f.deriveCalls).toHaveLength(0);
  });

  // -- Ported from the probe: the model-answer refusals, now with statuses ----

  /** The two-call flow, collapsed for the tests that are about Stage 3's answer. */
  async function deriveAfterAssess(
    label: string,
    f: ReturnType<typeof fakes>,
  ): Promise<{ status: number; body: any }> {
    const assess = await realAssess(label, f.assessModel);
    return await api(
      "GET",
      derivePath(label, { pair: "BTCUSD", interval: "1m", assessment: resubmissionFrom(assess) }),
      {
        symbolLister: catalogue,
        candleLister: venue,
        symbolDetailLister: details,
        deriveModel: f.deriveModel,
      },
    );
  }

  it("refuses a PARSE failure at 502 with the parser's own code", async () => {
    const label = await deriveAccount("dv-parse");
    const f = fakes(assessAnswer(), deriveAnswer({ notes: [] }));

    const res = await deriveAfterAssess(label, f);

    // The probe reported this at 200 because a refusal was its RESULT. A real
    // endpoint refuses with a status; the CODE is preserved either way.
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe("notes_empty");
    expect(res.body.data).toBe(null);
    // Exactly one call: a refusal is never resampled.
    expect(f.deriveCalls).toHaveLength(1);
  });

  it("refuses a VALIDATION failure at 502, naming the LAYER that refused", async () => {
    const label = await deriveAccount("dv-valid");
    const answer = deriveAnswer();
    // An inverted range: refused by the REAL buildLevels inside validateGridParams.
    (answer.response.parameters as Record<string, unknown>)["upperBound"] = cited("10.00000000", "candles.low");
    const f = fakes(assessAnswer(), answer);

    const res = await deriveAfterAssess(label, f);

    expect(res.status).toBe(502);
    // `<layer>/<code>`, so "the real strategy validator refused" stays
    // distinguishable from "the real decoder refused" and from this stage's own
    // bounds. A test that only asserted "it refuses" would still pass the day
    // someone dropped validateGridParams from the chain.
    expect(res.body.error.code).toBe("strategy_validator/validator_rejected");
    expect(res.body.error.message).toContain("validateGridParams");
  });

  it("refuses a DECODER failure at 502, naming the decoder layer", async () => {
    const label = await deriveAccount("dv-decode");
    const answer = deriveAnswer();
    // A JSON number where the decoder requires a decimal string.
    (answer.response.parameters as Record<string, unknown>)["orderSize"] = cited(50, "candles.high");
    const f = fakes(assessAnswer(), answer);

    const res = await deriveAfterAssess(label, f);

    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe("decoder/decoder_rejected");
    expect(res.body.error.message).toContain("decodeGridParams");
  });

  it("refuses an INVENTED citation in the model's own answer, so ungrounded numbers never appear", async () => {
    const label = await deriveAccount("dv-cite");
    const answer = deriveAnswer();
    (answer.response.parameters as Record<string, unknown>)["orderSize"] = cited("50.00000000", "candles.rsi_14");
    const f = fakes(assessAnswer(), answer);

    const res = await deriveAfterAssess(label, f);

    // 502, not 409: this is the MODEL inventing an id, not a caller resubmitting
    // a stale one. Same code, different owner, different status.
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe("citation_unknown");
  });

  it("refuses a strategy DISAGREEMENT between the two stages", async () => {
    const label = await deriveAccount("dv-disagree");
    const f = fakes(assessAnswer(), deriveAnswer({ strategy: "dca" }));

    const res = await deriveAfterAssess(label, f);

    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe("strategy_disagreement");
  });

  it("never returns a partial proposal: a refusal carries no data at all", async () => {
    const label = await deriveAccount("dv-partial");
    const f = fakes(assessAnswer(), deriveAnswer({ notes: [] }));

    const res = await deriveAfterAssess(label, f);

    expect(res.body.data).toBe(null);
    expect(res.body.error.code).toBe("notes_empty");
  });

  it("refuses before the model call when the account has no ledger row", async () => {
    const label = `dv-nocap-${suffix}`;
    await db.accounts.insert({ account_label: label, exchange: "gemini", created_at: T0, updated_at: T0 });
    const f = fakes(assessAnswer(), deriveAnswer());

    const res = await deriveAfterAssess(label, f);

    // 409, not 503: the ledger READ SUCCEEDED and found nothing fundable. That
    // is a conflict with current state, fixed by funding the account, never by
    // retrying -- reporting it as 503 would send an operator hunting an outage.
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("no_capital_headroom");
    // Assess still ran in the FIRST call -- it does not need capital. Derive did
    // not spend an inference in the second.
    expect(f.assessCalls).toHaveLength(1);
    expect(f.deriveCalls, "Stage 3 called the model with no headroom").toHaveLength(0);
  });

  // -- The bundle and the second gather travel with the proposal -------------

  it("returns the fresh bundle and Stage 3's own two reads beside the proposal", async () => {
    const label = await deriveAccount("dv-context");
    const f = fakes(assessAnswer(), deriveAnswer());

    const res = await deriveAfterAssess(label, f);
    const body = res.body.data;

    expect(res.status).toBe(200);
    // Stage 1's bundle, with every slot's own outcome.
    expect(body.bundle.candles.outcome).toBe("ok");
    expect(body.bundle.news.outcome).toBe("not_yet_available");
    expect(body.bundle.candidate.pair).toBe("BTCUSD");
    // Stage 3's two extra reads, in the same envelope shape.
    expect(body.context.capital.outcome).toBe("ok");
    expect(body.context.capital.value.assets[0].asset).toBe("USD");
    expect(body.context.capital.value.assets[0].available).toBe("10000.00000000");
    expect(body.context.filters.outcome).toBe("ok");
    expect(body.context.filters.value.minQuantity).toBe("0.00100000");
    expect(body.context.filters.value.minNotional).toBe("0.00000000");
    expect(typeof body.context.gatheredAt).toBe("number");
    // The money bigints all rendered rather than throwing JSON.stringify.
    expect(body.bundle.concentration.value.policy.assetCapitalShareFlagAtPct).toBe("40.00000000");
  });

  it("gathers ONCE, so the evidence verified against is the evidence derived from", async () => {
    // THE PROPERTY, NOT THE VALUES. A second gather inside one request would
    // return identical data under these deterministic stubs, so no assertion
    // comparing numbers could ever notice it -- and yet the assessment would
    // then have been checked against one evidence set while the human is shown
    // another. Counting the venue calls pins the property directly.
    const label = await deriveAccount("dv-onegather");
    const f = fakes(assessAnswer(), deriveAnswer());
    const assess = await realAssess(label, f.assessModel);

    let candleCalls = 0;
    const countingVenue: CandleLister = async (account, query, env, now) => {
      candleCalls += 1;
      return await venue(account, query, env, now);
    };

    const res = await api(
      "GET",
      derivePath(label, { pair: "BTCUSD", interval: "1m", assessment: resubmissionFrom(assess) }),
      {
        symbolLister: catalogue,
        candleLister: countingVenue,
        symbolDetailLister: details,
        deriveModel: f.deriveModel,
      },
    );

    expect(res.status).toBe(200);
    expect(candleCalls, "the derive request fetched candles more than once").toBe(1);
  });

  // -- What it writes, and what it still must not ----------------------------

  /**
   * ⚠ THIS TEST'S CLAIM CHANGED AT THE STEP THAT BUILT THE PROPOSAL RECORD, and
   * it is restated rather than loosened.
   *
   * It used to assert "writes NOTHING: no bot, no audit row, no capital movement",
   * which was true while 21.5 requirement 5 was unbuilt (decision log 42). Now
   * every real `/assess` and `/derive` call writes a `proposals` row and an
   * `audit_log` entry, deliberately and unconditionally.
   *
   * The part that MUST NOT change is the 21.1 guarantee, and it is asserted more
   * specifically than before rather than less: no bot, no Durable Object, no
   * capital movement, and the ONLY audit entries are the two proposal records --
   * named individually, so a future write of any other kind fails here.
   */
  it("writes ONLY the proposal record: no bot, no capital movement (21.1)", async () => {
    const label = await deriveAccount("dv-nowrite");
    const before = {
      bots: await db.botInstances.count(),
      ledger: (await db.capitalLedger.findOne({ account_label: label, asset: "USD" }))!,
    };
    const f = fakes(assessAnswer(), deriveAnswer());

    const res = await deriveAfterAssess(label, f);
    expect(res.status).toBe(200);

    // 21.1: the pipeline has NO write path to a bot.
    expect(await db.botInstances.count()).toBe(before.bots);
    const after = (await db.capitalLedger.findOne({ account_label: label, asset: "USD" }))!;
    // The proposal suggested 400; `total_allocated` must be untouched (21.1).
    expect(after.total_allocated).toBe(before.ledger.total_allocated);
    expect(after.total_balance).toBe(before.ledger.total_balance);

    // The two rows this chain SHOULD have written, and nothing else. `dv-nowrite`
    // seeds a placeholder balance, so its own audit entry is expected too --
    // listed by name for the same reason: an unnamed count would absorb a new
    // write silently.
    const actions = (await db.auditLog.findMany({ orderBy: [{ column: "created_at", direction: "asc" }] }))
      .map((row) => row.action)
      .sort();
    expect(actions).toEqual(["capital.placeholder_balance_seeded", "proposal.assessed", "proposal.derived"]);
    // And both records exist, unresolved: nobody has acted on them.
    const proposals = await db.proposals.findMany({});
    expect(proposals).toHaveLength(2);
    expect(proposals.every((row) => row.outcome === null)).toBe(true);
  });

  // -- Parameter handling ----------------------------------------------------

  it("requires pair, interval and assessment, with no defaults", async () => {
    const label = await deriveAccount("dv-params");
    const f = fakes(assessAnswer(), deriveAnswer());
    const assess = await realAssess(label, f.assessModel);
    const assessment = resubmissionFrom(assess);
    const opts = {
      symbolLister: catalogue,
      candleLister: venue,
      symbolDetailLister: details,
      deriveModel: f.deriveModel,
    };

    expect((await api("GET", derivePath(label, { interval: "1m", assessment }), opts)).status).toBe(400);
    expect((await api("GET", derivePath(label, { pair: "BTCUSD", assessment }), opts)).status).toBe(400);

    const noAssessment = await api("GET", derivePath(label, { pair: "BTCUSD", interval: "1m" }), opts);
    expect(noAssessment.status).toBe(400);
    expect(noAssessment.body.error.code).toBe("missing_field");
    expect(noAssessment.body.error.message).toContain("assessment");

    // An interval outside the union is refused rather than coerced.
    expect(
      (await api("GET", derivePath(label, { pair: "BTCUSD", interval: "2m", assessment }), opts)).status,
    ).toBe(400);

    // No DERIVE model was reached by any of those. (Assess ran once, in the
    // setup call above, and never again.)
    expect(f.deriveCalls).toHaveLength(0);
    expect(f.assessCalls).toHaveLength(1);
  });

  it("refuses a malformed assessment before spending anything", async () => {
    const label = await deriveAccount("dv-malformed");
    const f = fakes(assessAnswer(), deriveAnswer());
    const opts = {
      symbolLister: catalogue,
      candleLister: venue,
      symbolDetailLister: details,
      deriveModel: f.deriveModel,
    };

    for (const [assessment, code] of [
      ["not json", "not_json"],
      ["[]", "not_an_object"],
      ['{"strategy":"grid"}', "missing_field"],
    ] as const) {
      const res = await api(
        "GET",
        derivePath(label, { pair: "BTCUSD", interval: "1m", assessment }),
        opts,
      );
      expect(res.status, `${assessment} was not refused`).toBe(400);
      expect(res.body.error.code).toBe(code);
    }
    expect(f.deriveCalls).toHaveLength(0);
  });

  it("is Access-gated like every other route", async () => {
    const label = await deriveAccount("dv-auth");
    const res = await api(
      "GET",
      derivePath(label, { pair: "BTCUSD", interval: "1m", assessment: "{}" }),
      { token: null },
    );
    expect(res.status).toBe(401);
  });
});

/**
 * The permanent proposal record, end to end (spec 21.5 requirement 5).
 *
 * Real D1, real endpoints, real Access verification; only the exchange and the
 * two models are injected. NO TEST HERE REACHES A MODEL.
 *
 * Six properties, each one this feature would look correct without:
 *
 *  1. A REAL /assess CALL PRODUCES A REAL ROW WITH THE FULL INPUTS. Not a
 *     summary: the whole bundle, every candle, and the prompt text the WIRE
 *     deliberately omits.
 *  2. SAME FOR /derive, plus Stage 3's own two reads and the re-verified
 *     resubmitted assessment -- both upstream inputs, on the row.
 *  3. WHAT WAS STORED IS WHAT THE HUMAN WAS SHOWN. Asserted by comparing the
 *     stored payload against the response body, which is the only place the
 *     "one rendering, two uses" design can be checked.
 *  4. A FAILED RUN WRITES NOTHING. A parse refusal spends a model call and leaves
 *     no row -- 21.5 logs proposals, and a refusal produced none.
 *  5. THE OUTCOME LINK IS REAL. `POST /api/bots` with a `proposalId` records an
 *     approval naming the bot it created, every refusal happens BEFORE the bot
 *     exists, and a request without the field behaves exactly as it always did.
 *  6. NOTHING IS EVER DELETED OR OVERWRITTEN (section 8.7).
 */
describe("proposal record (section 21.5 requirement 5)", () => {
  const MINUTE = 60_000;
  const VENUE_ANSWERED_AT = 1_960_000_000_000;

  const catalogue: SymbolLister = async () => ({ ok: true, value: ["BTCUSD", "ETHUSD"], at: T0 });

  let venueCount = 40;

  const venue: CandleLister = async (_account, query) => ({
    ok: true,
    value: Array.from({ length: venueCount }, (_, i) => {
      const close = BigInt(100 + (i % 7)) * 1_000_000n;
      return {
        pair: query.pair,
        openTime: T0 - (venueCount - i) * MINUTE,
        closeTime: T0 - (venueCount - i) * MINUTE + MINUTE,
        open: close - 1_000_000n,
        high: close + 8_000_000n,
        low: close - 4_000_000n,
        close,
        volume: 400_000_000n,
        closed: true,
      };
    }),
    at: VENUE_ANSWERED_AT,
  });

  const deadVenue: CandleLister = async () => ({
    ok: false,
    kind: "transport",
    message: "connect ETIMEDOUT",
    retryable: true,
    at: VENUE_ANSWERED_AT,
  });

  const details: SymbolDetailLister = async (_account, pair) => ({
    ok: true,
    value: {
      pair,
      baseAsset: "BTC",
      quoteAsset: "USD",
      status: "TRADING",
      tickSize: 1_000_000n,
      minPrice: 0n,
      maxPrice: 0n,
      stepSize: 100_000n,
      minQuantity: 100_000n,
      maxQuantity: 0n,
      minNotional: 0n,
      maxNotional: 0n,
      instrument: "spot",
      fetchedAt: VENUE_ANSWERED_AT,
    },
    at: VENUE_ANSWERED_AT,
  });

  beforeEach(() => {
    venueCount = 40;
  });

  async function proposalAccount(prefix: string) {
    const label = `${prefix}-${suffix}`;
    await db.accounts.insert({ account_label: label, exchange: "gemini", created_at: T0, updated_at: T0 });
    await seedPlaceholderTotalBalance(
      db,
      { accountLabel: label, asset: "USD", totalBalance: m("10000"), note: "proposal fixture" },
      { actor: HUMAN, now: T0 },
    );
    return label;
  }

  const assessAnswer = (citations: string[] = ["candles.range_pct"]) => ({
    response: {
      strategy: "grid",
      claims: [{ statement: "The range is wide relative to the close.", citations }],
    },
  });

  const cited = (value: unknown, id = "candles.last_close") => ({ value, citations: [id] });

  const deriveAnswer = () => ({
    response: {
      strategy: "grid",
      parameters: {
        upperBound: cited("108.00000000", "candles.high"),
        lowerBound: cited("96.00000000", "candles.low"),
        gridLines: cited(5, "candles.range_pct"),
        spacing: cited("arithmetic", "candles.range_pct"),
        orderSize: cited("50.00000000", "capital.row.01.available"),
        stopLossPct: cited("5.00000000", "candles.range_pct"),
        breakoutTakeProfit: cited(true, "assessment.strategy"),
        breakoutThresholdPct: cited(null, "candles.range_pct"),
        takeProfitAmount: cited(null, "capital.row.01.available"),
      },
      allocatedCapital: cited("400.00000000", "capital.row.01.available"),
      capitalAsset: cited("USD", "capital.row.01.asset"),
      notes: [{ statement: "The observed range sets the bounds.", citations: ["candles.range_pct"] }],
    },
  });

  function fakes(assess: unknown, derive: unknown) {
    const assessCalls: string[] = [];
    const deriveCalls: string[] = [];
    const assessModel: AssessModel = async (request) => {
      assessCalls.push(request.prompt);
      return { text: assess, raw: assess };
    };
    const deriveModel: DeriveModel = async (request) => {
      deriveCalls.push(request.prompt);
      return { text: derive, raw: derive };
    };
    return { assessModel, deriveModel, assessCalls, deriveCalls };
  }

  /** Call `/assess` for real; returns the whole response body's `data`. */
  async function realAssess(label: string, assessModel: AssessModel) {
    const res = await api(
      "GET",
      `/api/accounts/${label}/assess?${new URLSearchParams({ pair: "BTCUSD", interval: "1m" }).toString()}`,
      { symbolLister: catalogue, candleLister: venue, symbolDetailLister: details, assessModel },
    );
    expect(res.status, "the /assess call this test builds on did not succeed").toBe(200);
    return res.body.data;
  }

  /** The client's one projection: whole `EvidenceItem`s down to bare ids. */
  function resubmissionFrom(assess: any): string {
    return JSON.stringify({
      strategy: assess.strategy,
      claims: assess.claims.map((claim: any) => ({
        statement: claim.statement,
        citations: claim.citations.map((item: any) => item.id),
      })),
      envelope: assess.envelope,
      duplicateKeyCheck: assess.duplicateKeyCheck,
    });
  }

  async function realDerive(label: string, submission: string, deriveModel: DeriveModel) {
    const res = await api(
      "GET",
      `/api/accounts/${label}/derive?${new URLSearchParams({ pair: "BTCUSD", interval: "1m", assessment: submission }).toString()}`,
      { symbolLister: catalogue, candleLister: venue, symbolDetailLister: details, deriveModel },
    );
    expect(res.status, "the /derive call this test builds on did not succeed").toBe(200);
    return res.body.data;
  }

  // -- Property 1: /assess writes a real row with the full inputs -------------

  it("a real /assess call produces a real logged row with the FULL inputs", async () => {
    const label = await proposalAccount("pr-assess");
    const f = fakes(assessAnswer(), deriveAnswer());

    expect(await db.proposals.count(), "the table was not empty before the call").toBe(0);

    const data = await realAssess(label, f.assessModel);

    // The id is on the response, so a human can name this proposal later.
    expect(typeof data.proposalId).toBe("string");
    expect(data.proposalId).not.toBe("");

    const rows = await db.proposals.findMany({});
    expect(rows, "exactly one row per successful call").toHaveLength(1);
    const row = rows[0]!;

    expect(row.id).toBe(data.proposalId);
    expect(row.stage).toBe("assess");
    expect(row.account_label).toBe(label);
    expect(row.pair).toBe("BTCUSD");
    expect(row.entry_point).toBe("named");
    expect(row.strategy_type).toBe("grid");
    // The VERIFIED Access email, not a caller-supplied string.
    expect(row.actor).toBe(HUMAN);
    expect(row.model).toBe("@cf/meta/llama-3.3-70b-instruct-fp8-fast");
    expect(row.prompt_version).toBe("assess/1");
    // 21.5 requirement 4: the venue's own answer time, NOT the write time.
    expect(row.data_fetched_at).toBe(VENUE_ANSWERED_AT);
    expect(row.outcome).toBeNull();

    // ── THE FULL INPUTS, not a summary ──
    const inputs = row.inputs_json as any;
    expect(inputs.bundle.candidate.pair).toBe("BTCUSD");
    expect(inputs.bundle.candidate.accountLabel).toBe(label);
    // Every candle the venue returned, individually. A summarised bundle would
    // carry a count and pass every shape assertion.
    expect(inputs.bundle.candles.value.candles).toHaveLength(40);
    expect(inputs.bundle.candles.value.count).toBe(40);
    expect(typeof inputs.bundle.candles.value.candles[0].close).toBe("string");
    // The real provenance: who asked, as what, and when.
    expect(inputs.bundle.candidate.sources[0].kind).toBe("named");
    expect(inputs.bundle.candidate.sources[0].requestedBy).toBe(HUMAN);
    // The paused news slot travels too -- an absent input recorded as absent.
    expect(inputs.bundle.news.outcome).toBe("not_yet_available");

    // ── THE REASONING, including the prompt the WIRE omits ──
    const reasoning = row.reasoning_json as any;
    expect(reasoning.promptText).toBe(f.assessCalls[0]);
    expect(reasoning.promptText.length).toBeGreaterThan(1_000);
    expect(reasoning.promptVersion).toBe("assess/1");
    expect(reasoning.strategy).toBe("grid");
    expect(reasoning.claims[0].statement).toBe("The range is wide relative to the close.");
    // Citations RESOLVED to whole evidence items, and everything OFFERED.
    expect(reasoning.claims[0].citations[0].id).toBe("candles.range_pct");
    expect(reasoning.evidence.length).toBeGreaterThan(reasoning.claims[0].citations.length);
    // The determinism stance this answer was produced under.
    expect(reasoning.settings.temperature).toBe(0);
    expect(reasoning.settings.seed).toBe(20260811);
    // The raw transport response BY IDENTITY, both what it narrowed from and to.
    expect(reasoning.response.raw).toEqual({ response: { strategy: "grid", claims: [{ statement: "The range is wide relative to the close.", citations: ["candles.range_pct"] }] } });

    // ⚠ THE PROMPT IS ON THE ROW AND NOT ON THE WIRE. Both halves asserted, since
    // the whole point of storing it is that the response does not.
    expect(data.assess.promptText).toBeUndefined();
    expect(data.assess.promptChars).toBe(reasoning.promptText.length);
  });

  it("writes the audit entry in the same call, as a POINTER not a copy", async () => {
    const label = await proposalAccount("pr-audit");
    const f = fakes(assessAnswer(), deriveAnswer());
    const data = await realAssess(label, f.assessModel);

    const audits = await db.auditLog.findMany({ where: { action: "proposal.assessed" } });
    expect(audits).toHaveLength(1);
    expect(audits[0]!.actor).toBe(HUMAN);
    expect(audits[0]!.target_bot_instance_id).toBeNull();
    const details_ = audits[0]!.details_json as any;
    expect(details_.proposal_id).toBe(data.proposalId);
    // NOT a second copy of the payload -- see migration 0009's third reason.
    expect(JSON.stringify(details_).length).toBeLessThan(600);
  });

  // -- Property 2: /derive writes a row with BOTH upstream inputs -------------

  it("a real /derive call produces a real logged row with both upstream inputs", async () => {
    const label = await proposalAccount("pr-derive");
    const f = fakes(assessAnswer(), deriveAnswer());

    const assessData = await realAssess(label, f.assessModel);
    const data = await realDerive(label, resubmissionFrom(assessData.assess), f.deriveModel);

    // TWO rows now: one per stage, because the two calls gathered independently.
    const rows = await db.proposals.findMany({ orderBy: [{ column: "created_at", direction: "asc" }] });
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.stage)).toEqual(["assess", "derive"]);

    const row = rows[1]!;
    expect(row.id).toBe(data.proposalId);
    expect(row.id).not.toBe(assessData.proposalId);
    expect(row.prompt_version).toBe("derive/1");
    expect(row.strategy_type).toBe("grid");
    expect(row.data_fetched_at).toBe(VENUE_ANSWERED_AT);

    const inputs = row.inputs_json as any;
    // Stage 1's bundle...
    expect(inputs.bundle.candles.value.candles).toHaveLength(40);
    // ...Stage 3's own two extra reads...
    expect(inputs.context.capital.outcome).toBe("ok");
    expect(inputs.context.capital.value.assets.length).toBeGreaterThan(0);
    expect(inputs.context.filters.outcome).toBe("ok");
    expect(inputs.context.filters.value.pair).toBe("BTCUSD");
    // ...and the RESUBMITTED assessment, labelled as what it is.
    expect(inputs.assessment.source).toBe("client_resubmitted");
    expect(inputs.assessment.citationsReverified).toBe(true);
    expect(inputs.assessment.claims[0].citations[0].id).toBe("candles.range_pct");
    // Its two unverifiable audit facts are stored LABELLED as unverifiable, never
    // flattened into observations.
    expect(inputs.assessment.unverifiedOriginalCall.envelope).toBe("envelope_object");

    const reasoning = row.reasoning_json as any;
    expect(reasoning.promptText).toBe(f.deriveCalls[0]);
    // The validated parameter set, with each number beside the ids it rests on.
    expect(reasoning.proposal.params.upperBound).toBe("108.00000000");
    expect(reasoning.proposal.allocatedCapital).toBe("400.00000000");
    expect(reasoning.proposal.minimumOrderCheck).toBe("quantity");
    expect(reasoning.proposal.citations.upperBound[0].id).toBe("candles.high");
    expect(data.derive.promptText).toBeUndefined();
  });

  // -- Property 3: stored == shown -------------------------------------------

  it("⚠ stores EXACTLY what the response showed the human", async () => {
    // The only place the "one rendering, two uses" design can be checked. A second
    // rendering for storage -- even a faithful one -- is a copy that drifts, and
    // 21.5 requirement 2 is about checking reasoning against the real source.
    const label = await proposalAccount("pr-same");
    const f = fakes(assessAnswer(), deriveAnswer());

    const assessData = await realAssess(label, f.assessModel);
    const assessRow = (await db.proposals.findOne({ stage: "assess" }))!;
    expect((assessRow.inputs_json as any).bundle).toEqual(assessData.bundle);
    expect((assessRow.inputs_json as any).selectedAt).toBe(assessData.selectedAt);

    const data = await realDerive(label, resubmissionFrom(assessData.assess), f.deriveModel);
    const deriveRow = (await db.proposals.findOne({ stage: "derive" }))!;
    const inputs = deriveRow.inputs_json as any;
    expect(inputs.bundle).toEqual(data.bundle);
    expect(inputs.context).toEqual(data.context);
    expect(inputs.assessment).toEqual(data.assessment);
    // And the reasoning is the wire view PLUS the two fields it omits -- so every
    // field the response published is byte-identical on the row.
    const reasoning = deriveRow.reasoning_json as any;
    for (const key of Object.keys(data.derive)) {
      expect(reasoning[key], `stored ${key} differs from the response`).toEqual(data.derive[key]);
    }
  });

  // -- Property 4: a failed run writes nothing -------------------------------

  it("writes NO row when the model answers unusably", async () => {
    const label = await proposalAccount("pr-badmodel");
    // A real model call that returns something the parser refuses.
    const f = fakes({ response: { strategy: "bicycle", claims: [] } }, deriveAnswer());

    const res = await api(
      "GET",
      `/api/accounts/${label}/assess?${new URLSearchParams({ pair: "BTCUSD", interval: "1m" }).toString()}`,
      { symbolLister: catalogue, candleLister: venue, assessModel: f.assessModel },
    );
    expect(res.status).toBe(502);
    // The model WAS called and the refusal is real, so this is not a precondition
    // short-circuit dressed as a parse failure.
    expect(f.assessCalls).toHaveLength(1);
    expect(await db.proposals.count()).toBe(0);
    expect(await db.auditLog.findMany({ where: { action: "proposal.assessed" } })).toHaveLength(0);
  });

  it("⚠ FAILS THE REQUEST when the record write itself fails, rather than returning an unrecorded proposal", async () => {
    // THE FAIL-CLOSED RULE, and the test a mutation run found missing: without it,
    // a `catch` around the log call left every other assertion green while
    // `/assess` quietly returned proposals that are not in the permanent record --
    // a degraded result indistinguishable from a good one, which is exactly what
    // 21.5 requirement 6 forbids.
    //
    // The cost is real and is the reason this needs stating rather than assuming:
    // the model call has already happened, so the discarded inference is paid for.
    // The alternative is worse.
    const label = await proposalAccount("pr-writefail");
    const f = fakes(assessAnswer(), deriveAnswer());

    // Bound to the TARGET for the reason the concentration test above documents:
    // `Database` uses private fields, and a private read through a Proxy receiver
    // throws for an unrelated reason before the handler is reached.
    const brokenProposals = new Proxy(db.proposals, {
      get(target, prop) {
        if (prop === "insertStatement") {
          return () => {
            throw new Error("D1 refused the proposal insert");
          };
        }
        const value = Reflect.get(target, prop, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const broken = new Proxy(db, {
      get(target, prop) {
        if (prop === "proposals") return brokenProposals;
        const value = Reflect.get(target, prop, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as Database;

    const res = await api(
      "GET",
      `/api/accounts/${label}/assess?${new URLSearchParams({ pair: "BTCUSD", interval: "1m" }).toString()}`,
      { symbolLister: catalogue, candleLister: venue, assessModel: f.assessModel, db: broken },
    );

    // NOT a 200 with a warning, and not a 200 at all.
    expect(res.status).toBe(500);
    expect(res.body.data).toBeNull();
    // The assessment DID happen -- so this is genuinely the write failing, not a
    // precondition short-circuit wearing the same status.
    expect(f.assessCalls).toHaveLength(1);
    // And nothing partial was left behind: no row, and no audit entry claiming one.
    expect(await db.proposals.count()).toBe(0);
    expect(await db.auditLog.findMany({ where: { action: "proposal.assessed" } })).toHaveLength(0);
  });

  it("writes NO row when a precondition refuses before the model", async () => {
    const label = await proposalAccount("pr-nohistory");
    const f = fakes(assessAnswer(), deriveAnswer());

    const res = await api(
      "GET",
      `/api/accounts/${label}/assess?${new URLSearchParams({ pair: "BTCUSD", interval: "1m" }).toString()}`,
      { symbolLister: catalogue, candleLister: deadVenue, assessModel: f.assessModel },
    );
    expect(res.status).toBe(502);
    expect(f.assessCalls, "a refusal must cost no inference").toHaveLength(0);
    expect(await db.proposals.count()).toBe(0);
  });

  it("writes NO row when a resubmission is stale", async () => {
    const label = await proposalAccount("pr-stale");
    const f = fakes(assessAnswer(["candles.bucket.19"]), deriveAnswer());
    const assessData = await realAssess(label, f.assessModel);
    expect(await db.proposals.count()).toBe(1);

    // The window shrinks: bucket 19 no longer exists (decision log 42, check 7).
    venueCount = 8;
    const res = await api(
      "GET",
      `/api/accounts/${label}/derive?${new URLSearchParams({ pair: "BTCUSD", interval: "1m", assessment: resubmissionFrom(assessData.assess) }).toString()}`,
      { symbolLister: catalogue, candleLister: venue, symbolDetailLister: details, deriveModel: f.deriveModel },
    );
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("citation_unknown");
    expect(f.deriveCalls).toHaveLength(0);
    // Still just the assess row. No derive row for a derivation that never happened.
    expect(await db.proposals.count()).toBe(1);
    expect(await db.proposals.findOne({ stage: "derive" })).toBeNull();
  });

  // -- Property 5: the outcome link ------------------------------------------

  it("⚠ POST /api/bots with a proposalId records a real approval naming the bot", async () => {
    const label = await proposalAccount("pr-approve");
    const f = fakes(assessAnswer(), deriveAnswer());
    const assessData = await realAssess(label, f.assessModel);
    const data = await realDerive(label, resubmissionFrom(assessData.assess), f.deriveModel);

    const botId = `pr-bot-${suffix}`;
    clock = T0 + 7 * MINUTE;
    const created = await api("POST", "/api/bots", {
      body: {
        botInstanceId: botId,
        accountLabel: label,
        pair: "BTCUSD",
        capitalAsset: "USD",
        allocatedCapital: "400",
        strategy: "grid",
        params: {
          upperBound: "108",
          lowerBound: "96",
          gridLines: 5,
          spacing: "arithmetic",
          orderSize: "50",
          stopLossPct: "5",
          breakoutTakeProfit: true,
        },
        // THE LINK. Optional, and the only thing that ever connects this bot back
        // to the reasoning behind it.
        proposalId: data.proposalId,
      },
      symbolLister: catalogue,
      symbolDetailLister: details,
    });

    expect(created.status).toBe(201);
    expect(created.body.data.proposalLink).toEqual({
      proposalId: data.proposalId,
      recorded: true,
      error: null,
    });

    const row = (await db.proposals.findOne({ id: data.proposalId }))!;
    expect(row.outcome).toBe("approved");
    expect(row.outcome_bot_instance_id).toBe(botId);
    expect(row.outcome_actor).toBe(HUMAN);
    expect(row.outcome_at).toBe(T0 + 7 * MINUTE);

    // The bot really exists, and the audit trail names both.
    expect(await db.botInstances.findOne({ id: botId })).not.toBeNull();
    const audits = await db.auditLog.findMany({ where: { action: "proposal.approved" } });
    expect(audits).toHaveLength(1);
    expect(audits[0]!.target_bot_instance_id).toBe(botId);
    expect((audits[0]!.details_json as any).pending_ms).toBe(7 * MINUTE);

    // ⚠ AND THE ASSESS ROW IS STILL UNRESOLVED. Approving the derivation does not
    // resolve the assessment it came from -- nothing links them, by design.
    expect((await db.proposals.findOne({ stage: "assess" }))!.outcome).toBeNull();
  });

  /*
   * ── THE PREFILL FLOW, AGAINST THE REAL ENDPOINT AND THE REAL TABLE ──
   *
   * These two drive the DASHBOARD's prefill module (`dashboard/src/research/
   * proposalPrefill.ts`) over a REAL `/derive` response and then act — or
   * deliberately do not act — against the real `POST /api/bots` and the real
   * `proposals` row. They live here rather than beside the module because the
   * property being checked is not about encoding: it is about what happens to a
   * row in D1, and this is the file that can ask.
   *
   * ⚠ THE ONE LINK THEY CANNOT DRIVE, STATED SO THE PAIR IS NOT READ AS MORE THAN
   * IT IS: `buildRequest` lives inside `pages/CreateBot.tsx` and no test in this
   * repository can import a `.tsx` (React's CJS build does not resolve in the
   * Workers pool — a test that imports one collects ZERO tests rather than
   * failing). So the body below is assembled from the prefill's form-field values
   * the way that function assembles it from the identically-named state, and the
   * one hop between them is covered by a source assertion in
   * `prefill-does-not-approve.test.ts` and by the operator's eyes. That hop is
   * pre-existing code this step did not change.
   */
  it("⚠ navigating to the pre-filled form and NOT submitting leaves the proposal PENDING", async () => {
    const label = await proposalAccount("pr-nav");
    const f = fakes(assessAnswer(), deriveAnswer());
    const assessData = await realAssess(label, f.assessModel);
    const data = await realDerive(label, resubmissionFrom(assessData.assess), f.deriveModel);

    // The whole of what pressing "Open the create-bot form, pre-filled" does: build
    // a link, and read it back on the other page. Every line the dashboard executes
    // between reading a proposal and looking at a filled-in form is in these two
    // calls, and neither can reach the network -- the module imports no client.
    const href = createBotHref(data as DeriveResponse);
    expect(href, "a valid derivation should offer a link").not.toBeNull();
    const prefill = readProposalPrefill(new URLSearchParams(href!.split("?")[1]!));
    expect(prefill, "the link should decode into a prefill").not.toBeNull();

    // It really did carry the proposal, so this is not vacuous.
    expect(prefill!.proposalId).toBe(data.proposalId);
    expect(prefill!.accountLabel).toBe(label);
    expect(prefill!.strategy).toBe("grid");

    // ⚠ AND NOW THE ASSERTION. Checked against the real row rather than against
    // "we did not call the endpoint", which would only restate the test's own
    // setup. The human then closes the tab: that is the absence of any further
    // call, which is what the rest of this test's silence represents.
    const row = (await db.proposals.findOne({ id: data.proposalId }))!;
    expect(row.outcome).toBeNull();
    expect(row.outcome_bot_instance_id).toBeNull();
    expect(row.outcome_actor).toBeNull();
    expect(row.outcome_at).toBeNull();

    // Nothing else moved either: no bot, no capital reserved, and no audit entry
    // beyond the two the two model calls themselves wrote.
    expect(await db.botInstances.count()).toBe(0);
    const ledger = (await db.capitalLedger.findOne({ account_label: label, asset: "USD" }))!;
    expect(toDecimalString(ledger.total_allocated)).toBe("0.00000000");
    const actions = (await db.auditLog.findMany({})).map((entry) => entry.action).sort();
    expect(actions).not.toContain("proposal.approved");
    expect(actions).not.toContain("proposal.rejected");
    expect(actions).not.toContain("bot.created");
  });

  it("⚠ a real submission from a pre-filled form records the approval, with the PROPOSAL's numbers", async () => {
    const label = await proposalAccount("pr-prefill");
    const f = fakes(assessAnswer(), deriveAnswer());
    const assessData = await realAssess(label, f.assessModel);
    const data = await realDerive(label, resubmissionFrom(assessData.assess), f.deriveModel);

    const prefill = readProposalPrefill(
      new URLSearchParams(createBotHref(data as DeriveResponse)!.split("?")[1]!),
    )!;
    expect(prefill.fields.strategy).toBe("grid");
    const fields = prefill.fields as GridPrefillFields;

    // The body the create-bot form builds out of exactly these values. Note the
    // mapping under test: the form's `gridStopLossPct` is the request's
    // `params.stopLossPct`, and `exchange` is deliberately never sent.
    const botId = `pr-prefilled-${suffix}`;
    clock = T0 + 11 * MINUTE;
    const created = await api("POST", "/api/bots", {
      body: withProposalId(
        {
          botInstanceId: botId,
          accountLabel: prefill.accountLabel,
          pair: prefill.pair,
          capitalAsset: prefill.capitalAsset,
          allocatedCapital: prefill.allocatedCapital,
          strategy: "grid",
          params: {
            upperBound: fields.upperBound,
            lowerBound: fields.lowerBound,
            gridLines: Number(fields.gridLines),
            spacing: fields.spacing,
            orderSize: fields.orderSize,
            stopLossPct: fields.gridStopLossPct,
            breakoutTakeProfit: fields.breakoutTakeProfit,
            breakoutThresholdPct: fields.breakoutThresholdPct === "" ? null : fields.breakoutThresholdPct,
            takeProfitAmount: fields.takeProfitAmount === "" ? null : fields.takeProfitAmount,
          },
        },
        prefill.proposalId,
      ),
      symbolLister: catalogue,
      symbolDetailLister: details,
    });

    // Step 45's contract, unchanged and unweakened -- same 201, same link shape.
    expect(created.status).toBe(201);
    expect(created.body.data.proposalLink).toEqual({
      proposalId: data.proposalId,
      recorded: true,
      error: null,
    });

    const row = (await db.proposals.findOne({ id: data.proposalId }))!;
    expect(row.outcome).toBe("approved");
    expect(row.outcome_bot_instance_id).toBe(botId);
    expect(row.outcome_actor).toBe(HUMAN);

    /*
     * ⚠ AND THE BOT REALLY HAS THE PROPOSAL'S PARAMETERS, read back off the stored
     * config rather than off the response. This is what makes the mapping test an
     * end-to-end statement rather than a claim about a URL: the numbers the model
     * derived survived the encode, the decode, the form's field names, the request
     * body and the real `decodeGridParams`, and came out the other side unchanged.
     */
    const bot = (await db.botInstances.findOne({ id: botId }))!;
    const params = bot.strategy_params_json as any;
    expect(bot.strategy_type).toBe("grid");
    expect(params.upperBound).toBe("108.00000000");
    expect(params.lowerBound).toBe("96.00000000");
    expect(params.gridLines).toBe(5);
    expect(params.spacing).toBe("arithmetic");
    expect(params.orderSize).toBe("50.00000000");
    // The one a wrong mapping would get wrong while everything else looked right.
    expect(params.stopLossPct).toBe("5.00000000");
    expect(toDecimalString(bot.stop_loss_pct)).toBe("5.00000000");
    expect(toDecimalString(bot.allocated_capital)).toBe("400.00000000");
    expect(bot.capital_asset).toBe("USD");
    expect(bot.pair).toBe("BTCUSD");
  });

  it("behaves exactly as before when no proposalId is given", async () => {
    const botId = `pr-plain-${suffix}`;
    const label = await proposalAccount("pr-plain");
    const created = await api("POST", "/api/bots", {
      body: {
        botInstanceId: botId,
        accountLabel: label,
        pair: "BTCUSD",
        capitalAsset: "USD",
        allocatedCapital: "400",
        strategy: "grid",
        params: { upperBound: "108", lowerBound: "96", gridLines: 5, spacing: "arithmetic", orderSize: "50", stopLossPct: "5", breakoutTakeProfit: true },
      },
      symbolLister: catalogue,
      symbolDetailLister: details,
    });
    expect(created.status).toBe(201);
    // ABSENT, not null: an ordinary creation's response shape is unchanged.
    expect("proposalLink" in created.body.data).toBe(false);
    expect(await db.proposals.count()).toBe(0);
  });

  it("⚠ refuses a bad proposalId BEFORE the bot exists", async () => {
    // The property that matters is not "creation is refused" but "NOTHING
    // HAPPENED" -- the same standard `assertBotPairIsSpotTradable` is held to.
    const label = await proposalAccount("pr-badlink");
    const botId = `pr-nobot-${suffix}`;
    const res = await api("POST", "/api/bots", {
      body: {
        botInstanceId: botId,
        accountLabel: label,
        pair: "BTCUSD",
        capitalAsset: "USD",
        allocatedCapital: "400",
        strategy: "grid",
        params: { upperBound: "108", lowerBound: "96", gridLines: 5, spacing: "arithmetic", orderSize: "50", stopLossPct: "5", breakoutTakeProfit: true },
        proposalId: "no-such-proposal",
      },
      symbolLister: catalogue,
      symbolDetailLister: details,
    });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("unknown_proposal");
    // No bot row, and no capital reserved.
    expect(await db.botInstances.findOne({ id: botId })).toBeNull();
    const ledger = (await db.capitalLedger.findOne({ account_label: label, asset: "USD" }))!;
    expect(toDecimalString(ledger.total_allocated)).toBe("0.00000000");
  });

  it("refuses to approve an ASSESS proposal, before the bot exists", async () => {
    const label = await proposalAccount("pr-assessonly");
    const f = fakes(assessAnswer(), deriveAnswer());
    const assessData = await realAssess(label, f.assessModel);
    const botId = `pr-noassess-${suffix}`;

    const res = await api("POST", "/api/bots", {
      body: {
        botInstanceId: botId,
        accountLabel: label,
        pair: "BTCUSD",
        capitalAsset: "USD",
        allocatedCapital: "400",
        strategy: "grid",
        params: { upperBound: "108", lowerBound: "96", gridLines: 5, spacing: "arithmetic", orderSize: "50", stopLossPct: "5", breakoutTakeProfit: true },
        proposalId: assessData.proposalId,
      },
      symbolLister: catalogue,
      symbolDetailLister: details,
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("proposal_not_derivable");
    expect(await db.botInstances.findOne({ id: botId })).toBeNull();
  });

  it("refuses a proposal belonging to a DIFFERENT account, before the bot exists", async () => {
    const label = await proposalAccount("pr-acct-a");
    const other = await proposalAccount("pr-acct-b");
    const f = fakes(assessAnswer(), deriveAnswer());
    const assessData = await realAssess(label, f.assessModel);
    const data = await realDerive(label, resubmissionFrom(assessData.assess), f.deriveModel);
    const botId = `pr-xacct-${suffix}`;

    const res = await api("POST", "/api/bots", {
      body: {
        botInstanceId: botId,
        accountLabel: other,
        pair: "BTCUSD",
        capitalAsset: "USD",
        allocatedCapital: "400",
        strategy: "grid",
        params: { upperBound: "108", lowerBound: "96", gridLines: 5, spacing: "arithmetic", orderSize: "50", stopLossPct: "5", breakoutTakeProfit: true },
        proposalId: data.proposalId,
      },
      symbolLister: catalogue,
      symbolDetailLister: details,
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("proposal_account_mismatch");
    expect(await db.botInstances.findOne({ id: botId })).toBeNull();
  });

  it("⚠ the proposal supplies NO input to the bot (21.1)", async () => {
    // The parameters in the body are what the bot is built from, full stop. A body
    // that deliberately DISAGREES with the proposal still produces the body's bot,
    // which is what makes `proposalId` a record rather than a one-click bridge.
    const label = await proposalAccount("pr-noinput");
    const f = fakes(assessAnswer(), deriveAnswer());
    const assessData = await realAssess(label, f.assessModel);
    const data = await realDerive(label, resubmissionFrom(assessData.assess), f.deriveModel);
    // The proposal says grid 96..108, orderSize 50, allocated 400.
    expect(data.derive.proposal.params.upperBound).toBe("108.00000000");

    const botId = `pr-diff-${suffix}`;
    const created = await api("POST", "/api/bots", {
      body: {
        botInstanceId: botId,
        accountLabel: label,
        pair: "BTCUSD",
        capitalAsset: "USD",
        allocatedCapital: "250",
        strategy: "grid",
        params: { upperBound: "200", lowerBound: "150", gridLines: 4, spacing: "arithmetic", orderSize: "60", stopLossPct: "9", breakoutTakeProfit: false },
        proposalId: data.proposalId,
      },
      symbolLister: catalogue,
      symbolDetailLister: details,
    });
    expect(created.status).toBe(201);
    const bot = (await db.botInstances.findOne({ id: botId }))!;
    // The BODY's numbers, not the proposal's.
    expect(toDecimalString(bot.allocated_capital)).toBe("250.00000000");
    expect((bot.strategy_params_json as any).upperBound).toBe("200.00000000");
    // And the record still says a human approved it, which is the honest statement:
    // they acted on it. What they typed is on the bot.
    expect((await db.proposals.findOne({ id: data.proposalId }))!.outcome).toBe("approved");
  });

  // -- The reject endpoint ---------------------------------------------------

  it("POST /api/proposals/:id/reject records a rejection, with and without a note", async () => {
    const label = await proposalAccount("pr-reject");
    const f = fakes(assessAnswer(), deriveAnswer());
    const assessData = await realAssess(label, f.assessModel);
    const data = await realDerive(label, resubmissionFrom(assessData.assess), f.deriveModel);

    clock = T0 + 3 * MINUTE;
    const res = await api("POST", `/api/proposals/${data.proposalId}/reject`, {
      body: { note: "bounds too tight for this pair" },
    });
    expect(res.status).toBe(200);
    expect(res.body.data.proposal.outcome).toBe("rejected");
    expect(res.body.data.proposal.outcomeNote).toBe("bounds too tight for this pair");
    expect(res.body.data.proposal.outcomeActor).toBe(HUMAN);
    expect(res.body.data.proposal.pendingMs).toBe(3 * MINUTE);
    // The two large payloads are NOT on this response -- their absence is the point.
    expect("inputs" in res.body.data.proposal).toBe(false);
    expect("reasoning" in res.body.data.proposal).toBe(false);

    // AN ASSESSMENT MAY ALSO BE REJECTED, and that is why Stage 2 rows are kept.
    const second = await api("POST", `/api/proposals/${assessData.proposalId}/reject`, {});
    expect(second.status).toBe(200);
    expect(second.body.data.proposal.stage).toBe("assess");
    expect(second.body.data.proposal.outcomeNote).toBeNull();
  });

  it("⚠ records the VERIFIED Access email, never an actor from the body", async () => {
    // The layer's standing rule (21.5 requirement 2), and a mutation run found it
    // untested: a body-supplied actor would let a caller attribute a human decision
    // to someone else in a permanent, undeleteable record. `addWatchlistEntry`
    // refuses one outright for the same reason.
    const label = await proposalAccount("pr-actor");
    const f = fakes(assessAnswer(), deriveAnswer());
    const assessData = await realAssess(label, f.assessModel);

    const res = await api("POST", `/api/proposals/${assessData.proposalId}/reject`, {
      body: { note: "not pursuing", actor: "impostor@example.com" },
      email: HUMAN,
    });
    expect(res.status).toBe(200);
    expect(res.body.data.proposal.outcomeActor).toBe(HUMAN);
    const row = (await db.proposals.findOne({ id: assessData.proposalId }))!;
    expect(row.outcome_actor).toBe(HUMAN);
    // And the audit entry names the same verified human.
    const audit = (await db.auditLog.findMany({ where: { action: "proposal.rejected" } }))[0]!;
    expect(audit.actor).toBe(HUMAN);
  });

  it("⚠ still returns 201 when the outcome LINK write fails, and says the link is missing", async () => {
    // The one place the fail-closed rule is deliberately REVERSED, and a mutation
    // run found it untested. By this point a real bot exists and capital is
    // reserved; failing the response would tell an operator that creation failed
    // when it did not, and the recovery they would attempt -- creating it again --
    // is the worst available action.
    const label = await proposalAccount("pr-linkfail");
    const f = fakes(assessAnswer(), deriveAnswer());
    const assessData = await realAssess(label, f.assessModel);
    const data = await realDerive(label, resubmissionFrom(assessData.assess), f.deriveModel);

    // `findOne` still works, so the pre-creation checks pass; only the UPDATE
    // fails, which is the only failure that cannot be moved before `create`.
    const brokenProposals = new Proxy(db.proposals, {
      get(target, prop) {
        if (prop === "update") {
          return async () => {
            throw new Error("D1 refused the outcome update");
          };
        }
        const value = Reflect.get(target, prop, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const broken = new Proxy(db, {
      get(target, prop) {
        if (prop === "proposals") return brokenProposals;
        const value = Reflect.get(target, prop, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as Database;

    const botId = `pr-linkfail-bot-${suffix}`;
    const created = await api("POST", "/api/bots", {
      body: {
        botInstanceId: botId,
        accountLabel: label,
        pair: "BTCUSD",
        capitalAsset: "USD",
        allocatedCapital: "400",
        strategy: "grid",
        params: { upperBound: "108", lowerBound: "96", gridLines: 5, spacing: "arithmetic", orderSize: "50", stopLossPct: "5", breakoutTakeProfit: true },
        proposalId: data.proposalId,
      },
      symbolLister: catalogue,
      symbolDetailLister: details,
      db: broken,
    });

    // The creation SUCCEEDED and is reported as such.
    expect(created.status).toBe(201);
    expect(created.body.data.id).toBe(botId);
    expect(await db.botInstances.findOne({ id: botId })).not.toBeNull();
    // And the missing link is REPORTED rather than swallowed: it is the only thing
    // that will ever connect this bot back to the reasoning behind it.
    expect(created.body.data.proposalLink.proposalId).toBe(data.proposalId);
    expect(created.body.data.proposalLink.recorded).toBe(false);
    expect(created.body.data.proposalLink.error).toContain("D1 refused the outcome update");
    // The proposal is genuinely still unresolved -- no half-written outcome.
    expect((await db.proposals.findOne({ id: data.proposalId }))!.outcome).toBeNull();
  });

  it("refuses a second decision rather than overwriting the first", async () => {
    const label = await proposalAccount("pr-twice");
    const f = fakes(assessAnswer(), deriveAnswer());
    const assessData = await realAssess(label, f.assessModel);
    await api("POST", `/api/proposals/${assessData.proposalId}/reject`, { body: { note: "first" } });

    const again = await api("POST", `/api/proposals/${assessData.proposalId}/reject`, {
      body: { note: "second" },
      email: "someone@else.com",
    });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe("proposal_already_resolved");

    const row = (await db.proposals.findOne({ id: assessData.proposalId }))!;
    expect(row.outcome_note).toBe("first");
    expect(row.outcome_actor).toBe(HUMAN);
  });

  it("refuses to reject an unknown proposal, and is Access-gated", async () => {
    const missing = await api("POST", "/api/proposals/nope/reject", {});
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe("unknown_proposal");

    const unauthenticated = await api("POST", "/api/proposals/nope/reject", { token: null });
    expect(unauthenticated.status).toBe(401);
  });

  // -- Property 6: retention -------------------------------------------------

  it("⚠ retains every proposal, resolved or not, with no way to delete one", async () => {
    const label = await proposalAccount("pr-retain");
    const f = fakes(assessAnswer(), deriveAnswer());
    const assessData = await realAssess(label, f.assessModel);
    await realDerive(label, resubmissionFrom(assessData.assess), f.deriveModel);
    await api("POST", `/api/proposals/${assessData.proposalId}/reject`, {});

    // Both rows still there: one resolved, one not.
    expect(await db.proposals.count()).toBe(2);
    // There is no route that could remove one. Checked against the real router
    // rather than by inspection -- the method map is what an operator can reach.
    for (const method of ["DELETE", "PUT", "PATCH"]) {
      const res = await api(method, `/api/proposals/${assessData.proposalId}`, {});
      expect([404, 405], `${method} on a proposal is reachable`).toContain(res.status);
    }
    expect(await db.proposals.count()).toBe(2);
  });

  // -- Property 7: READING the record (GET /api/proposals, GET /api/proposals/:id)

  /**
   * ⚠ THE PARITY TEST, AGAINST REAL D1 AND A REAL PIPELINE RUN.
   *
   * `proposal-replay.test.ts` proves the reconstruction against the serializer's own
   * views. This proves it against the whole system: a real `/derive` call runs, its
   * real response body is captured, the real row it wrote is read back through the
   * real endpoint, and the two objects are compared. Every layer the payload passes
   * through -- `JSON.stringify` into D1's TEXT column, SQLite, `JSON.parse` out,
   * the handler, `JSON.stringify` onto the wire again -- is in the loop.
   *
   * If any of it were lossy, this is where it would show.
   */
  it("⚠ GET /api/proposals/:id rebuilds the EXACT body /derive returned", async () => {
    const label = await proposalAccount("pr-replay");
    const f = fakes(assessAnswer(), deriveAnswer());
    const assessData = await realAssess(label, f.assessModel);
    const live = await realDerive(label, resubmissionFrom(assessData.assess), f.deriveModel);

    const res = await api("GET", `/api/proposals/${live.proposalId}`, {});
    expect(res.status).toBe(200);
    expect(res.body.data.replay.ok).toBe(true);
    expect(res.body.data.replay.stage).toBe("derive");

    // The whole response, field for field. Not a subset, not a spot check.
    expect(res.body.data.replay.response).toEqual(live);

    // And the two fields the brief suspected of not surviving storage, named.
    expect(res.body.data.replay.response.derive.envelope).toBe(live.derive.envelope);
    expect(res.body.data.replay.response.derive.duplicateKeyCheck).toBe(
      live.derive.duplicateKeyCheck,
    );
  });

  it("⚠ rebuilds the exact body /assess returned, too", async () => {
    const label = await proposalAccount("pr-replay-a");
    const f = fakes(assessAnswer(), deriveAnswer());
    const live = await realAssess(label, f.assessModel);

    const res = await api("GET", `/api/proposals/${live.proposalId}`, {});
    expect(res.status).toBe(200);
    expect(res.body.data.replay.stage).toBe("assess");
    expect(res.body.data.replay.response).toEqual(live);
    // ⚠ AND IT SAYS THE RENDERER CANNOT BE REUSED. The payload is exact; what is
    // absent is a derivation for `ProposalView` to render, which an assessment
    // structurally does not have.
    expect(res.body.data.replay.fidelity.renderableByProposalView).toBe(false);
  });

  it("⚠ returns the prompt and the raw model response, which the live call never did", async () => {
    /*
     * The record's two extra fields, and both halves of the property: they are NOT
     * in the replayed wire shape (that would make it a different object from the one
     * a live run returns), and they ARE published beside it. Decision log 45's live
     * check 2 confirmed the prompt is *"stored server-side, never returned over the
     * wire"*; this is the one endpoint where that changes, on purpose, because
     * reconstructing what produced an answer is the row's entire job.
     */
    const label = await proposalAccount("pr-recordonly");
    const f = fakes(assessAnswer(), deriveAnswer());
    const live = await realAssess(label, f.assessModel);
    expect("promptText" in live.assess).toBe(false);

    const res = await api("GET", `/api/proposals/${live.proposalId}`, {});
    expect("promptText" in res.body.data.replay.response.assess).toBe(false);
    expect("response" in res.body.data.replay.response.assess).toBe(false);

    expect(typeof res.body.data.replay.recordOnly.promptText).toBe("string");
    // The real prompt, not a placeholder: it is the exact text the fake model saw.
    expect(res.body.data.replay.recordOnly.promptText).toBe(f.assessCalls[0]);
    expect(res.body.data.replay.recordOnly.promptText.length).toBe(live.assess.promptChars);
    // ⚠ BOTH `text` AND `raw`, kept separately on purpose (`serialize.ts`): the
    // narrowing from Workers AI's output union to a string is a decision an
    // implementation makes, and the record holds what it narrowed FROM as well as
    // what it narrowed TO. Here the fake returns the same object for both.
    expect(res.body.data.replay.recordOnly.response).toEqual({
      text: assessAnswer(),
      raw: assessAnswer(),
    });
  });

  it("returns the record's own summary beside the replay, without the payloads", async () => {
    const label = await proposalAccount("pr-summary");
    const f = fakes(assessAnswer(), deriveAnswer());
    const live = await realAssess(label, f.assessModel);

    const res = await api("GET", `/api/proposals/${live.proposalId}`, {});
    const proposal = res.body.data.proposal;
    expect(proposal.id).toBe(live.proposalId);
    expect(proposal.stage).toBe("assess");
    expect(proposal.accountLabel).toBe(label);
    expect(proposal.pair).toBe("BTCUSD");
    expect(proposal.actor).toBe(HUMAN);
    expect(proposal.outcome).toBeNull();
    expect(proposal.pendingMs).toBeNull();
    // Same shape the reject endpoint publishes, and the payloads are still absent
    // from it -- they are on `replay`, once, rather than in two places.
    expect("inputs" in proposal).toBe(false);
    expect("reasoning" in proposal).toBe(false);
  });

  it("404s an unknown id and is Access-gated", async () => {
    const missing = await api("GET", "/api/proposals/never-issued", {});
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe("unknown_proposal");

    const unauthenticated = await api("GET", "/api/proposals/never-issued", { token: null });
    expect(unauthenticated.status).toBe(401);
    const listUnauthenticated = await api("GET", "/api/proposals", { token: null });
    expect(listUnauthenticated.status).toBe(401);
  });

  it("⚠ reading a pending proposal leaves it pending, and writes nothing", async () => {
    /*
     * THE READ-ONLY GUARANTEE, checked against the real row rather than restated.
     * Decision log 48 verified live that clicking through to a form changes no
     * outcome; this is the same property for the history view, which is the other
     * surface that now touches these rows.
     */
    const label = await proposalAccount("pr-readonly");
    const f = fakes(assessAnswer(), deriveAnswer());
    const assessData = await realAssess(label, f.assessModel);
    const live = await realDerive(label, resubmissionFrom(assessData.assess), f.deriveModel);
    const auditBefore = await db.auditLog.count();

    await api("GET", "/api/proposals", {});
    await api("GET", `/api/proposals/${live.proposalId}`, {});
    await api("GET", `/api/proposals/${assessData.proposalId}`, {});

    for (const id of [live.proposalId, assessData.proposalId]) {
      const row = (await db.proposals.findOne({ id }))!;
      expect(row.outcome).toBeNull();
      expect(row.outcome_actor).toBeNull();
      expect(row.outcome_at).toBeNull();
      expect(row.outcome_bot_instance_id).toBeNull();
    }
    // No bot, no capital movement, and not one new audit entry.
    expect(await db.auditLog.count()).toBe(auditBefore);
    expect(await db.botInstances.count()).toBe(0);
  });

  // -- The list endpoint -----------------------------------------------------

  it("GET /api/proposals lists real rows, newest first, with a real total", async () => {
    const label = await proposalAccount("pr-list");
    const f = fakes(assessAnswer(), deriveAnswer());
    const assessData = await realAssess(label, f.assessModel);
    clock = T0 + MINUTE;
    const deriveData = await realDerive(label, resubmissionFrom(assessData.assess), f.deriveModel);

    const res = await api("GET", "/api/proposals", {});
    expect(res.status).toBe(200);
    expect(res.body.data.proposals.map((row: any) => row.id)).toEqual([
      deriveData.proposalId,
      assessData.proposalId,
    ]);
    expect(res.body.data.page).toEqual({
      limit: 25,
      offset: 0,
      total: 2,
      returned: 2,
      hasMore: false,
    });
    expect(res.body.data.filters).toEqual({ accountLabel: null, stage: null, outcome: null });
  });

  it("⚠ never puts a proposal's inputs or reasoning on the list response", async () => {
    /*
     * THE LIST ENDPOINT'S WHOLE DESIGN, asserted on the wire. Migration 0009's third
     * argument for a dedicated table was that `Repository.findMany` selects the full
     * column list and every unrelated read pays for the payload -- measured at a
     * 290,459-byte ceiling. A list built on `findMany` would have reproduced that
     * cost inside the table that exists because of the argument.
     */
    const label = await proposalAccount("pr-list-size");
    const f = fakes(assessAnswer(), deriveAnswer());
    await realAssess(label, f.assessModel);

    const res = await api("GET", "/api/proposals", {});
    const row = res.body.data.proposals[0];
    expect("inputs" in row).toBe(false);
    expect("reasoning" in row).toBe(false);
    expect("inputs_json" in row).toBe(false);
    expect("reasoning_json" in row).toBe(false);
    expect("promptText" in row).toBe(false);
    // Positively: the row IS the same shape a single record's summary takes, so the
    // list and the detail page cannot disagree about what a proposal is.
    const one = await api("GET", `/api/proposals/${row.id}`, {});
    expect(row).toEqual(one.body.data.proposal);
  });

  it("⚠ PROPOSAL_LIST_COLUMNS is every column except the two payloads", () => {
    /*
     * The drift guard. A column added to `proposals` later must be either listed or
     * deliberately excluded, and this is where that decision gets made rather than
     * being made by omission -- `schema.test.ts`'s literal-table-list rule, applied
     * to a projection.
     */
    expect([...PROPOSAL_LIST_COLUMNS, ...PROPOSAL_PAYLOAD_COLUMNS].sort()).toEqual(
      Object.keys(proposals.columns).sort(),
    );
    expect(PROPOSAL_PAYLOAD_COLUMNS).toEqual(["inputs_json", "reasoning_json"]);
  });

  it("filters by accountLabel, stage and outcome against real rows", async () => {
    const label = await proposalAccount("pr-filter-a");
    const other = await proposalAccount("pr-filter-b");
    const f = fakes(assessAnswer(), deriveAnswer());
    const assessData = await realAssess(label, f.assessModel);
    const deriveData = await realDerive(label, resubmissionFrom(assessData.assess), f.deriveModel);
    const otherAssess = await realAssess(other, f.assessModel);
    await api("POST", `/api/proposals/${assessData.proposalId}/reject`, { body: { note: "no" } });

    const byAccount = await api("GET", `/api/proposals?accountLabel=${label}`, {});
    expect(byAccount.body.data.proposals.map((row: any) => row.id).sort()).toEqual(
      [assessData.proposalId, deriveData.proposalId].sort(),
    );
    expect(byAccount.body.data.page.total).toBe(2);

    const byStage = await api("GET", "/api/proposals?stage=derive", {});
    expect(byStage.body.data.proposals.map((row: any) => row.id)).toEqual([deriveData.proposalId]);

    const rejected = await api("GET", "/api/proposals?outcome=rejected", {});
    expect(rejected.body.data.proposals.map((row: any) => row.id)).toEqual([
      assessData.proposalId,
    ]);

    // ⚠ THE FILTER 21.5 EXISTS FOR: the ones nobody acted on. `pending` is not a
    // stored value -- it is `outcome IS NULL`, read after the fact.
    const pending = await api("GET", "/api/proposals?outcome=pending", {});
    expect(pending.body.data.proposals.map((row: any) => row.id).sort()).toEqual(
      [deriveData.proposalId, otherAssess.proposalId].sort(),
    );
    expect(pending.body.data.filters.outcome).toBe("pending");

    // Combined, and the echo describes what was ANSWERED rather than what the URL said.
    const both = await api("GET", `/api/proposals?accountLabel=${label}&outcome=pending`, {});
    expect(both.body.data.proposals.map((row: any) => row.id)).toEqual([deriveData.proposalId]);
    expect(both.body.data.filters).toEqual({
      accountLabel: label,
      stage: null,
      outcome: "pending",
    });
  });

  it("⚠ pages without repeating or skipping a row, even when two share a timestamp", async () => {
    /*
     * THE PAGING BUG THAT LOOKS LIKE DATA LOSS. `/assess` and `/derive` can write
     * two rows in the same millisecond, and `created_at` alone is not a total order.
     * Under LIMIT/OFFSET an unstable sort does not merely reorder -- a row can
     * appear on two consecutive pages while another appears on neither. The tie
     * break on `id` is what makes the order total; this drives it with the clock
     * held still so every row shares one `created_at`.
     */
    const label = await proposalAccount("pr-paging");
    const f = fakes(assessAnswer(), deriveAnswer());
    const ids: string[] = [];
    for (let index = 0; index < 5; index += 1) {
      ids.push((await realAssess(label, f.assessModel)).proposalId);
    }
    expect(new Set((await db.proposals.findMany({})).map((row) => row.created_at)).size).toBe(1);

    const seen: string[] = [];
    for (let offset = 0; offset < 5; offset += 2) {
      const page = await api("GET", `/api/proposals?limit=2&offset=${offset}`, {});
      expect(page.body.data.page.total).toBe(5);
      seen.push(...page.body.data.proposals.map((row: any) => row.id));
    }
    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);
    expect([...seen].sort()).toEqual([...ids].sort());

    // And the last page reports that it is the last one.
    const last = await api("GET", "/api/proposals?limit=2&offset=4", {});
    expect(last.body.data.page).toEqual({
      limit: 2,
      offset: 4,
      total: 5,
      returned: 1,
      hasMore: false,
    });
    const past = await api("GET", "/api/proposals?limit=2&offset=99", {});
    expect(past.body.data.proposals).toEqual([]);
    expect(past.body.data.page.total).toBe(5);
    expect(past.body.data.page.hasMore).toBe(false);
  });

  it("400s a bad filter or a bad page rather than guessing", async () => {
    for (const query of [
      "stage=gather",
      "outcome=ignored",
      "accountLabel=",
      "limit=0",
      "limit=101",
      "limit=-1",
      "limit=1.5",
      "offset=-1",
    ]) {
      const res = await api("GET", `/api/proposals?${query}`, {});
      expect(res.status, `${query} was not refused`).toBe(400);
      expect(res.body.error.code).toBe("invalid_filter");
    }
  });

  it("an account with no proposals is an empty page, not an error", async () => {
    // The deliberate divergence from `listWatchlist`: section 8.7 keeps every row
    // forever and an account can be de-registered, so a label this registry does not
    // know must still be a query rather than a 404.
    const res = await api("GET", "/api/proposals?accountLabel=retired-last-year", {});
    expect(res.status).toBe(200);
    expect(res.body.data.proposals).toEqual([]);
    expect(res.body.data.page.total).toBe(0);
  });
});
