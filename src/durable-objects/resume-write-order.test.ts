/**
 * `resume()`'s two status writes, and the ORDER they happen in.
 *
 * WHY THIS IS ITS OWN FILE, and why the property is worth a file at all.
 *
 * `#resumePass` writes the bot's new status to two separate stores: D1's
 * `bot_instances` row and the Durable Object's own storage. There is no
 * transaction spanning them -- there cannot be, they are different systems --
 * so an interruption between the two leaves them permanently disagreeing. That
 * is not hypothetical: live testnet bot `bot-gvtr1a` sat with
 * `bot_instances.status = 'halted'` while its own state said `running`,
 * subscribed to its price feed and receiving prices, with no `bot.resumed`
 * audit row anywhere.
 *
 * The interruption cannot be prevented. What CAN be chosen is which way the
 * wreckage points, and the two directions are not equally safe:
 *
 *   - object `running` / D1 `halted` (the OLD order) -- the bot is live and
 *     INVISIBLE to both emergency stops, because the global kill switch and the
 *     account circuit breaker both select on `status IN ('created','running')`
 *     and `halted` is the one non-terminal status neither sweep looks at.
 *   - object `halted` / D1 `running` (the NEW order) -- the sweeps still see it,
 *     and nothing anywhere trades on D1's opinion, because every order-placing
 *     site sits behind `#onPriceUpdatePass`'s read of the object's OWN state.
 *
 * So `#mirrorStatus` must be observed BEFORE `#mutateState`. The two lines look
 * interchangeable and a reasonable person tidying up would swap them back, which
 * is exactly why the order is pinned here rather than left to the comment beside
 * it. `pins the D1 write before the object write` is the test that fails if they
 * are swapped.
 *
 * NOT COVERED HERE, deliberately: nothing DETECTS a mismatch once it exists.
 * That is `docs/open-items/resume-split-brain.md` part 3b, a separate step.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { seedPlaceholderTotalBalance } from "../capital";
import { Database } from "../db/database";
import { freshDatabase } from "../db/test-helpers";
import { fromDecimalString as m } from "../shared/money";
import type { Price } from "../shared/exchange-client";
import type { BotInstance, BotRuntimeState, CreateDcaBotRequest } from "./bot-instance";
import type { DcaParams } from "../strategies/dca";
import { FakeExchange, TEST_PAIR } from "./fake-exchange";
import { inBot, noopFeed, rateLimiterStub } from "./test-helpers";

/** Matches `bot-instance.test.ts`: a future origin, so no alarm is born overdue. */
const T0 = 1_900_000_000_000;
const ACTOR = "owner@example.com";
const BOT_ID = "dca-btc-1";
/** The Durable Object storage key `#putState` writes. */
const STATE_KEY = "state";

let db: Database;
let exchange: FakeExchange;
let clock: number;
let objectName: string;
let nameCounter = 0;

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

function creation(): CreateDcaBotRequest {
  return {
    botInstanceId: BOT_ID,
    accountLabel: "main",
    exchange: "binance",
    pair: TEST_PAIR,
    capitalAsset: "USDT",
    allocatedCapital: m("400"),
    params,
    actor: ACTOR,
  };
}

function priceAt(value: string): Price {
  return { pair: TEST_PAIR, price: m(value), at: clock };
}

/**
 * A `Database` that runs `hook` before every `botInstances.update`, then
 * delegates to the real one.
 *
 * A `Proxy` rather than a subclass because `Database` and `Repository` both
 * carry private fields: a method invoked with `this` bound to the proxy would
 * throw on `#d1`. Every function is therefore bound back to the real target and
 * only the one property is replaced.
 */
function withBotRowUpdateHook(
  real: Database,
  hook: (values: Record<string, unknown>) => Promise<void>,
): Database {
  const bind = <T extends object>(target: T, prop: string | symbol): unknown => {
    const value = (target as Record<string | symbol, unknown>)[prop];
    return typeof value === "function" ? (value as (...args: never[]) => unknown).bind(target) : value;
  };

  const repository = new Proxy(real.botInstances, {
    get(target, prop) {
      if (prop !== "update") return bind(target, prop);
      return async (where: never, values: Record<string, unknown>) => {
        await hook(values);
        return await target.update(where, values as never);
      };
    },
  });

  return new Proxy(real, {
    get(target, prop) {
      return prop === "botInstances" ? repository : bind(target, prop);
    },
  }) as Database;
}

/**
 * Run `body` inside this test's Durable Object.
 *
 * `database` is injectable so one test can hand the object a hooked `Database`
 * while every read the ASSERTIONS make still goes through the plain one.
 */
async function run<T>(
  body: (bot: BotInstance, state: DurableObjectState) => Promise<T>,
  database: Database = db,
): Promise<T> {
  return await inBot(objectName, async (instance, state) => {
    instance.attach({
      db: database,
      exchange,
      now: () => clock,
      newId: () => crypto.randomUUID(),
      limiterFor: () => rateLimiterStub(`limiter-${objectName}`),
      sleep: async () => undefined,
      feedFor: () => noopFeed,
    });
    return await body(instance, state);
  });
}

beforeEach(async () => {
  db = await freshDatabase();
  exchange = new FakeExchange();
  exchange.now = T0;
  clock = T0;
  nameCounter += 1;
  objectName = `resume-order-${nameCounter}`;

  await seedPlaceholderTotalBalance(
    db,
    { accountLabel: "main", asset: "USDT", totalBalance: m("10000"), note: "test fixture" },
    { actor: ACTOR, now: T0 },
  );
});

/** Create, start and halt -- the state every test below resumes FROM. */
async function haltedBot(): Promise<void> {
  await run((bot) => bot.create(creation()));
  await run((bot) => bot.start(ACTOR));
  await run((bot) => bot.halt("manual", "operator paused it", ACTOR));
}

async function storedState(): Promise<BotRuntimeState> {
  return (await run((bot) => bot.snapshot())).state;
}

async function rowStatus(): Promise<string> {
  return (await db.botInstances.findOne({ id: BOT_ID }))!.status;
}

async function resumedAuditRows(): Promise<unknown[]> {
  return await db.auditLog.findMany({ where: { action: "bot.resumed" } });
}

async function openHaltAlerts(): Promise<unknown[]> {
  return await db.alerts.findMany({
    where: { bot_instance_id: BOT_ID, alert_type: "halt_manual", resolved: false },
  });
}

describe("resume(): the order of its two status writes", () => {
  /**
   * TEST 1 -- the D1 write fails.
   *
   * With D1 first, this is the FIRST of the two writes, so the failure lands
   * before anything durable has changed. The whole of `resume`'s fail-closed
   * property has to survive it: the object stays halted, the halt alert stays
   * open, and no `bot.resumed` row claims a transition that did not happen.
   */
  it("fails closed when the D1 write fails: the object stays halted and nothing is claimed", async () => {
    await haltedBot();

    const refusing = withBotRowUpdateHook(db, async (values) => {
      if (values.status === "running") throw new Error("simulated D1 failure");
    });

    await expect(run((bot) => bot.resume(ACTOR), refusing)).rejects.toThrow(/simulated D1 failure/);

    // The object never left `halted`, and it kept the reason it stopped for.
    const state = await storedState();
    expect(state.status).toBe("halted");
    expect(state.haltReason).toMatch(/operator paused it/);
    expect(state.haltedAt).not.toBeNull();

    // D1 never moved either, so the two stores still AGREE. A failed resume
    // must not be a way to create the very mismatch this ordering is about.
    expect(await rowStatus()).toBe("halted");

    // Steps 4 and 5 sit after both writes, so neither ran: the halt alert is
    // still open and no audit row claims a resume.
    expect(await openHaltAlerts()).toHaveLength(1);
    expect(await resumedAuditRows()).toHaveLength(0);
  });

  /**
   * TEST 2 -- the object write fails AFTER D1 has already committed.
   *
   * This is the interruption this reordering aims: it is no longer preventable,
   * so what is asserted is that the state it leaves behind is the SAFE one. The
   * safety claim is deliberately checked by BEHAVIOUR -- feed the bot a price
   * and watch it place nothing -- rather than by reading a status field back,
   * because "D1 says running" is only harmless if it genuinely cannot reach an
   * order-placing site, and a field assertion would not show that.
   */
  it("leaves the safe direction when the object write fails: D1 running, object halted, and it trades nothing", async () => {
    await haltedBot();

    await expect(
      run(async (bot, state) => {
        const storage = state.storage as unknown as {
          put: (key: unknown, value?: unknown) => Promise<void>;
        };
        const realPut = storage.put.bind(storage);
        storage.put = async (key: unknown, value?: unknown) => {
          const status = (value as BotRuntimeState | undefined)?.status;
          if (key === STATE_KEY && status === "running") {
            throw new Error("simulated object-storage failure");
          }
          return await realPut(key, value);
        };
        try {
          return await bot.resume(ACTOR);
        } finally {
          storage.put = realPut;
        }
      }),
    ).rejects.toThrow(/simulated object-storage failure/);

    // The mismatch exists, and it points the safe way.
    expect(await rowStatus()).toBe("running");
    expect((await storedState()).status).toBe("halted");

    // THE SAFETY PROPERTY, asserted behaviourally. A price arrives; the object
    // reads its OWN state, not the row, and does nothing with it.
    const ignored = await run((bot) => bot.onPriceUpdate(priceAt("100")));
    expect(ignored).toMatchObject({ status: "halted", action: "ignored" });
    expect(exchange.placed).toHaveLength(0);

    // And the assertion above is not vacuous: the SAME price on the SAME
    // fixture, once the object really is running, does place the base order.
    await run((bot) => bot.resume(ACTOR));
    await run((bot) => bot.onPriceUpdate(priceAt("100")));
    expect(exchange.placed).toHaveLength(1);
  });

  /**
   * TEST 3 -- THE ORDERING PIN.
   *
   * The recording double captures, at the instant of the D1 write, what the
   * object's own storage still says. D1 first means the object is still
   * `halted` at that moment; swapping the two lines back makes it `running`,
   * and both assertions here fail. This is the test that turns a comment into
   * an invariant.
   */
  it("pins the D1 write before the object write", async () => {
    await haltedBot();

    const sequence: string[] = [];
    /** What the OBJECT's own storage said while D1 was being written. */
    let objectStatusDuringD1Write: string | undefined;

    await run(async (bot, state) => {
      const storage = state.storage as unknown as {
        put: (key: unknown, value?: unknown) => Promise<void>;
        get: (key: unknown) => Promise<unknown>;
      };
      const realPut = storage.put.bind(storage);
      storage.put = async (key: unknown, value?: unknown) => {
        if (key === STATE_KEY && (value as BotRuntimeState | undefined)?.status === "running") {
          sequence.push("object:running");
        }
        return await realPut(key, value);
      };

      const recording = withBotRowUpdateHook(db, async (values) => {
        if (values.status !== "running") return;
        sequence.push("d1:running");
        const stored = (await storage.get(STATE_KEY)) as BotRuntimeState | undefined;
        objectStatusDuringD1Write = stored?.status;
      });

      bot.attach({ db: recording });
      try {
        return await bot.resume(ACTOR);
      } finally {
        storage.put = realPut;
      }
    });

    expect(sequence).toEqual(["d1:running", "object:running"]);
    // The same fact from the other side, and the one that cannot be fooled by
    // any subtlety in how the two hooks are layered: when D1 was written, the
    // object had NOT yet been flipped.
    expect(objectStatusDuringD1Write).toBe("halted");
  });

  /**
   * TEST 4 -- steps 4 and 5 stay LAST.
   *
   * Resolving the halt alert and writing the `bot.resumed` audit row must
   * happen after BOTH status writes, so that an interrupted resume leaves a
   * visible contradiction -- a row saying `running` beside an unresolved
   * critical halt alert and no audit entry -- rather than a quiet one. Test 1
   * shows they do not run on a failure; this shows where they sit on success.
   */
  it("resolves the halt alert and audits only after both status writes", async () => {
    await haltedBot();
    expect(await openHaltAlerts()).toHaveLength(1);

    const sequence: string[] = [];

    await run(async (bot, state) => {
      const storage = state.storage as unknown as {
        put: (key: unknown, value?: unknown) => Promise<void>;
      };
      const realPut = storage.put.bind(storage);
      storage.put = async (key: unknown, value?: unknown) => {
        if (key === STATE_KEY && (value as BotRuntimeState | undefined)?.status === "running") {
          sequence.push("object:running");
        }
        return await realPut(key, value);
      };

      const recording = withBotRowUpdateHook(db, async (values) => {
        if (values.status === "running") sequence.push("d1:running");
      });
      // `resolveHaltAlerts` and `#audit` reach D1 through repositories the hook
      // above does not wrap, so they are observed on their own tables.
      const watched = new Proxy(recording, {
        get(target, prop) {
          if (prop === "alerts") {
            return new Proxy(target.alerts, {
              get(alerts, alertProp) {
                const value = (alerts as unknown as Record<string | symbol, unknown>)[alertProp];
                if (alertProp !== "update") {
                  return typeof value === "function"
                    ? (value as (...args: never[]) => unknown).bind(alerts)
                    : value;
                }
                return async (where: never, values: never) => {
                  sequence.push("alert:resolved");
                  return await alerts.update(where, values);
                };
              },
            });
          }
          if (prop === "auditLog") {
            return new Proxy(target.auditLog, {
              get(audit, auditProp) {
                const value = (audit as unknown as Record<string | symbol, unknown>)[auditProp];
                if (auditProp !== "insert") {
                  return typeof value === "function"
                    ? (value as (...args: never[]) => unknown).bind(audit)
                    : value;
                }
                return async (row: { action?: string }) => {
                  if (row.action === "bot.resumed") sequence.push("audit:resumed");
                  return await audit.insert(row as never);
                };
              },
            });
          }
          const value = (target as unknown as Record<string | symbol, unknown>)[prop];
          return typeof value === "function"
            ? (value as (...args: never[]) => unknown).bind(target)
            : value;
        },
      }) as Database;

      bot.attach({ db: watched });
      try {
        return await bot.resume(ACTOR);
      } finally {
        storage.put = realPut;
      }
    });

    expect(sequence).toEqual(["d1:running", "object:running", "alert:resolved", "audit:resumed"]);

    // And the effects really landed, not just the calls.
    expect(await openHaltAlerts()).toHaveLength(0);
    expect(await resumedAuditRows()).toHaveLength(1);
    expect(await rowStatus()).toBe("running");
    expect((await storedState()).status).toBe("running");
  });
});
