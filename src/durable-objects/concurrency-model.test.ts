/**
 * What this runtime actually does when two events reach one Durable Object.
 *
 * THIS FILE ASSERTS NO PRODUCT BEHAVIOUR. It is a probe: it exists to turn an
 * assumption this project has been carrying — and, in one place, carrying
 * WRONGLY — into a measured fact, because step 21's design depends on which
 * answer is true and how much of it is load-bearing.
 *
 * THE ANSWERS, MEASURED ON THIS RUNTIME (step 21, section 0):
 *
 *   1. An RPC IS delivered, and runs to completion, while the object is
 *      suspended on an exchange call. Read → exchange call → write is a real
 *      lost update everywhere it appears in `BotInstance`.
 *   2. An ALARM is delivered on the same terms. Two `getOrderStatus` calls were
 *      observed outstanding simultaneously, so the poll and a second pass are
 *      genuinely inside the object together. This is the concurrency step 20
 *      introduced.
 *   3. A storage-only read-modify-write survived a two-pass race on the same
 *      `fillId`: exactly one pass applied it, with the `fillId` identity check
 *      isolated as the only guard standing. Consistent with storage awaits
 *      being gated, and weak evidence in that direction — see probe 3 for what
 *      it can and cannot establish.
 *
 * Together: defend every sequence that spans an exchange call or a D1 write;
 * treat storage-only sequences as probably atomic but do not BUILD on it, since
 * `#mutateState` costs one storage read and is correct under either model.
 *
 * These are assertions rather than logs on purpose. A measured fact that
 * silently reverts is worse than no measurement, and if the runtime's delivery
 * behaviour changes, step 21's guard should be re-derived rather than trusted.
 *
 * THE ASSUMPTION. `rate-limiter.test.ts` says, in a comment that has been read
 * as settled since step 8: "A Durable Object serialises nothing across an
 * await." That test proves a real lost-update defence, but it proves it by
 * calling `limiter.acquire(...)` as a direct in-process method call from inside
 * `runInDurableObject` — never through the stub. So it demonstrates the
 * ARITHMETIC is safe against interleaving; it demonstrates nothing about
 * whether the runtime would deliver that second call in the first place. It is
 * not evidence either way, and it is the only thing in this repository that
 * looks like evidence.
 *
 * WHY IT MATTERS NOW. Until step 20 this object had one high-frequency writer
 * (`onPriceUpdate`, once per closed candle) and a handful of rare ones. Step 20
 * armed a 30-second alarm, so the poll and the price feed can now both be
 * inside `BotInstance` at once, mutating the same `position` and the same
 * `openOrderIds`. Step 21 has to make that safe, and the shape of the fix
 * differs depending on the answer:
 *
 *   - If events are delivered while the object is suspended on an EXCHANGE call
 *     (a fetch, or the cross-DO RPC to `RateLimiter`), then every read → network
 *     await → write sequence in this object is a real lost update, and the
 *     `#mutateState` discipline is load-bearing.
 *   - If events are ALSO delivered while it is suspended on a STORAGE await,
 *     then `IdempotencyGuard.beginAttempt` — a bare get-then-put with nothing
 *     between the two — can mint two orders on one sequence, and the fill
 *     application paths need defending too. If they are not, that get-then-put
 *     is atomic and needs nothing.
 *
 * A METHODOLOGICAL LIMIT, RECORDED HONESTLY. The obvious way to write these
 * probes is to suspend the object on a promise the test resolves by hand. That
 * is invalid, and getting it wrong would produce a confident FALSE result. A
 * hand-made promise is not I/O: resolving it queues an ordinary microtask, and
 * a microtask always interleaves regardless of what any input gate does. Such a
 * probe would "prove" the object is unserialised no matter what the runtime
 * actually guarantees.
 *
 * So the suspensions here are genuine. `FakeExchange` mocks the venue, but
 * every exchange call this object makes still goes through `#exchange()`, which
 * wraps the client in a REAL `RateLimiter` Durable Object — a real cross-object
 * RPC, suspended and resumed by the runtime rather than by this file. The
 * probes observe ARRIVALS (did a second pass get inside?) rather than
 * orderings, because arrival is the thing the runtime decides and ordering is
 * the thing microtasks decide.
 *
 * Probe 3 is the one this limit bites hardest, and its docblock says what it
 * can and cannot establish rather than overclaiming.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { seedPlaceholderTotalBalance } from "../capital";
import type { Database } from "../db/database";
import { freshDatabase } from "../db/test-helpers";
import { fromDecimalString as m } from "../shared/money";
import type { ExchangeOutcome } from "../shared/downtime";
import type { OrderStatus, Pair, Price } from "../shared/exchange-client";
import type { DcaParams } from "../strategies/dca";
import type { BotInstance, CreateDcaBotRequest } from "./bot-instance";
import { FakeExchange, TEST_PAIR } from "./fake-exchange";
import { botStub, inBot, noopFeed, rateLimiterStub } from "./test-helpers";

/** Matches `bot-instance.test.ts`: far enough forward that no alarm is overdue. */
const T0 = 1_900_000_000_000;
const ACTOR = "owner@example.com";

let db: Database;
let exchange: ProbeExchange;
let clock: number;
let idCounter: number;
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
    botInstanceId: "probe-bot",
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
 * A `FakeExchange` that records when each `getOrderStatus` STARTS and FINISHES,
 * and can hold each one open on a real suspension.
 *
 * The hold is `holdUntil`, a promise the TEST owns — which by the note at the
 * top of this file cannot itself prove anything about serialisation. Its only
 * job is to keep a pass parked inside the object long enough for a second event
 * to have the opportunity to arrive. What is measured is whether that second
 * event's own `begin` marker appears before the first pass's `end` marker: two
 * `begin`s outstanding at once means two passes were genuinely inside this
 * object at the same time, which is a fact about delivery, not about microtasks.
 *
 * Calls are numbered rather than labelled by caller. There is no reliable way
 * to ask "who is calling" from inside the client, and numbering is enough: the
 * whole question is whether call N+1 starts before call N ends.
 */
class ProbeExchange extends FakeExchange {
  readonly events: string[] = [];
  /** Set to a pending promise to park every `getOrderStatus` on entry. */
  holdUntil: Promise<void> | null = null;
  /** Set to a pending promise to park every `cancelOrder`, keeping a halt in flight. */
  holdCancelUntil: Promise<void> | null = null;
  #calls = 0;

  /** How many `cancelOrder` calls have entered, parked or not. */
  cancelsEntered = 0;

  override async cancelOrder(
    pair: Pair,
    clientOrderId: string,
  ): Promise<ExchangeOutcome<OrderStatus>> {
    this.cancelsEntered += 1;
    if (this.holdCancelUntil !== null) await this.holdCancelUntil;
    return await super.cancelOrder(pair, clientOrderId);
  }

  override async getOrderStatus(
    pair: Pair,
    clientOrderId: string,
  ): Promise<ExchangeOutcome<OrderStatus>> {
    this.#calls += 1;
    const call = this.#calls;
    this.events.push(`read-${call}:begin`);
    if (this.holdUntil !== null) await this.holdUntil;
    const outcome = await super.getOrderStatus(pair, clientOrderId);
    this.events.push(`read-${call}:end`);
    return outcome;
  }

  /** How many `getOrderStatus` calls have begun but not yet ended. */
  outstanding(): number {
    const begun = this.events.filter((e) => e.endsWith(":begin")).length;
    const ended = this.events.filter((e) => e.endsWith(":end")).length;
    return begun - ended;
  }
}

/**
 * Every gate handed out, so `afterEach` can open any the test did not.
 * A gate left closed parks a pass inside the object forever.
 */
const pendingGates: Array<() => void> = [];

/**
 * Every stub call started, so `afterEach` can await them.
 *
 * A test that fails its assertion abandons whatever it had in flight, and an
 * abandoned RPC resolves into the harness's teardown — "Closing rpc while
 * resolve was pending", and from there a native crash landing on whichever
 * file runs next. The failure gets attributed to innocent code.
 */
const pendingCalls: Array<Promise<unknown>> = [];

/** Start a stub call and register it for teardown. */
function track<T>(call: Promise<T>): Promise<T> {
  pendingCalls.push(call.catch(() => undefined));
  return call;
}

/** A gate the test opens by hand. See the class docblock for what it may prove. */
function openable(): { promise: Promise<void>; open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  pendingGates.push(open);
  return { promise, open };
}

/** Let the runtime make progress. Real macrotasks, not microtasks. */
async function settle(turns = 10): Promise<void> {
  for (let i = 0; i < turns; i++) await new Promise((resolve) => setTimeout(resolve, 1));
}

/**
 * Block until `predicate` holds, or fail saying what never happened.
 *
 * THE BARRIER THESE PROBES NEEDED, and the reason is worth recording: the first
 * version used a fixed `settle()` as a barrier — "wait 10ms, then assert the
 * pass is parked inside the exchange". In isolation that always held. Run with
 * the other 60 files it failed intermittently, because 10ms is not a guarantee
 * that an RPC has been delivered on a loaded machine; it is a guess. The probe
 * was measuring the harness's scheduling, not the runtime's.
 *
 * A fixed delay is never a barrier. Waiting on the CONDITION is.
 */
async function waitUntil(
  predicate: () => boolean,
  what: string,
  timeoutMs = 2000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`);
}

/** Block until `n` exchange reads are parked inside the object at once. */
async function waitForOutstanding(n: number): Promise<void> {
  await waitUntil(
    () => exchange.outstanding() >= n,
    `${n} concurrent exchange read(s) inside the object ` +
      `(saw ${exchange.outstanding()}; events so far: ${exchange.events.join(", ")})`,
  );
}

/** The poll schedule as stored, or null before the object has written one. */
async function nextPollAt(): Promise<number | null> {
  return await inBot(objectName, async (_bot, state) => {
    const schedule = (await state.storage.get("poll-schedule")) as
      | { nextPollAt: number | null }
      | undefined;
    return schedule?.nextPollAt ?? null;
  });
}

/**
 * Block until the object has re-armed its poll for `at`.
 *
 * The completion signal for a runtime-delivered alarm, which has no promise a
 * test can await. Throws rather than timing out silently: a probe that gave up
 * waiting and carried on would report whatever the half-finished state happened
 * to be.
 */
async function waitForPollRearmedAfter(firedAt: number): Promise<void> {
  for (let i = 0; i < 200; i++) {
    const next = await nextPollAt();
    if (next !== null && next > firedAt) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(
    `the poll was never re-armed past ${firedAt}; the alarm's pass did not complete`,
  );
}

/**
 * Attach this test's dependencies to the object, once.
 *
 * The probes then drive it through `botStub(...)` — a real RPC through the
 * namespace — rather than through `inBot`, which runs the body INSIDE the
 * object and would therefore bypass the very delivery decision being measured.
 * `attach` persists on the instance, so one call here serves the stub calls
 * that follow.
 */
async function attachDependencies(): Promise<void> {
  await run(async () => undefined);
}

/**
 * Run one body inside the object with dependencies attached.
 *
 * Setup only. The measurements themselves go through `botStub(...)`.
 */
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

/** A RUNNING bot with one resting, unfilled base order — and so an armed alarm. */
async function runningWithRestingOrder(): Promise<string> {
  await run((bot) => bot.create(creation()));
  await run((bot) => bot.start(ACTOR));
  await run((bot) => bot.onPriceUpdate(priceAt("100")));
  return exchange.placed[0]!.clientOrderId;
}

beforeEach(async () => {
  db = await freshDatabase();
  exchange = new ProbeExchange();
  exchange.now = T0;
  clock = T0;
  idCounter = 0;
  nameCounter += 1;
  objectName = `probe-${nameCounter}`;

  await seedPlaceholderTotalBalance(
    db,
    { accountLabel: "main", asset: "USDT", totalBalance: m("10000"), note: "probe fixture" },
    { actor: ACTOR, now: T0 },
  );
});

/**
 * Leave nothing of this test still running inside the object.
 *
 * NOT TIDINESS — this file segfaulted `workerd` without it. The probes run
 * clean in isolation and crashed the pool when run with the rest of the suite,
 * because probe 2 arms a REAL alarm and the pass it triggers kept going after
 * the test returned: writing state, and reaching for a D1 database the harness
 * had already torn down. An unawaited pass against a disposed binding is not a
 * test failure, it is a native crash, and it lands on whichever file happens to
 * be next.
 *
 * So every gate is opened (nothing may stay parked), the object is drained
 * until no exchange call is outstanding, and the alarm is disarmed so the
 * runtime cannot deliver one more.
 */
afterEach(async () => {
  // Order matters: unpark everything first, or awaiting the calls below hangs.
  exchange.holdUntil = null;
  for (const open of pendingGates.splice(0)) open();

  await Promise.allSettled(pendingCalls.splice(0));

  // The alarm is disarmed before the last wait, so the runtime cannot deliver
  // one more pass into a teardown that has already begun.
  await inBot(objectName, async (_bot, state) => {
    await state.storage.deleteAlarm();
  });

  // The tail of a runtime-delivered pass is D1 work with no handle to await.
  // Bounded on the observable end rather than on a fixed delay.
  await waitUntil(() => exchange.outstanding() === 0, "the object to go quiet").catch(() => {});
  await settle(5);
});

// ---------------------------------------------------------------------------

describe("probe 1: an RPC arriving while the object is suspended on an exchange call", () => {
  /**
   * MEASURED: it is. `onPriceUpdate` is delivered AND runs to completion while
   * a poll sits parked inside the same object on an exchange read.
   *
   * This is the premise of the whole step. Every read → exchange call → write
   * sequence in `BotInstance` is a genuine lost update, not a theoretical one,
   * and `#mutateState` is load-bearing rather than defensive.
   *
   * If this ever fails, the runtime's delivery behaviour has changed and step
   * 21's guard should be re-derived rather than trusted.
   */
  it("delivers onPriceUpdate while a poll is parked on an exchange read", async () => {
    await runningWithRestingOrder();
    await attachDependencies();

    const gate = openable();
    exchange.holdUntil = gate.promise;

    const stub = botStub(objectName);

    // Park a poll inside the object, suspended on the exchange read.
    const poll = track(stub.checkOpenOrders("probe"));
    await waitForOutstanding(1); // it really is parked

    // A price tick arrives while it is parked. On this bot `decide` returns
    // `hold` (position is empty, an order is resting), so the tick touches no
    // exchange call of its own and its RESOLUTION is the signal.
    let tickResolved = false;
    const tick = track(
      stub.onPriceUpdate(priceAt("101")).then((result) => {
        tickResolved = true;
        return result;
      }),
    );

    await waitUntil(() => tickResolved, "the price tick to complete while the poll was parked");

    // The claim is not just that the tick finished -- it is that it finished
    // WHILE the poll was still inside the object. Asserting the poll is still
    // parked at this instant is what makes it an interleaving rather than a
    // sequence.
    expect(exchange.outstanding()).toBe(1);

    gate.open();
    exchange.holdUntil = null;
    await Promise.all([poll, tick]);
  });
});

describe("probe 2: an alarm arriving while the object is suspended on an exchange call", () => {
  /**
   * MEASURED: it is. The observed event order is
   *
   *     read-1:begin, read-2:begin, read-1:end, read-2:end
   *
   * and the second read can only be the alarm's, because this bot has exactly
   * one open order and the manual pass was parked before the alarm was armed.
   * Two `getOrderStatus` calls outstanding at once means two passes were
   * genuinely inside this object at the same time.
   *
   * This is the specific concurrency step 20 introduced and step 21 exists to
   * make safe. It is also the sharpest correction to the standing assumption:
   * the alarm does not wait for the object to be idle.
   */
  it("delivers the alarm while a manual pass is parked on an exchange read", async () => {
    await runningWithRestingOrder();
    await attachDependencies();

    // Make the poll DUE on the injected clock, so a delivered alarm actually
    // runs a pass rather than returning early. Read from the bot's OWN schedule
    // rather than a hardcoded interval: the healthy cadence is per-tier now
    // (see `pollTierFor`), and a literal here would quietly stop making the poll
    // due -- and this probe would fail as a timeout rather than as a wrong
    // number, which is a much harder thing to read.
    clock = await inBot(objectName, async (_bot, state) => {
      const schedule = await state.storage.get<{ nextPollAt: number | null }>("poll-schedule");
      return schedule!.nextPollAt!;
    });
    exchange.now = clock;

    const gate = openable();
    exchange.holdUntil = gate.promise;

    const stub = botStub(objectName);

    // Park a manual pass inside the object first. `checkOpenOrders` reaches the
    // exchange before it writes any state, so the alarm set below survives.
    const manual = track(stub.checkOpenOrders("probe"));
    await waitForOutstanding(1);

    // Now arm a REAL alarm, in real wall-clock time, and let the runtime
    // deliver it. The object's own `#syncAlarm` works in the injected clock's
    // far-future terms, so this cannot collide with it.
    await inBot(objectName, async (_bot, state) => {
      await state.storage.setAlarm(Date.now() + 50);
    });

    // THE MEASUREMENT. Two reads outstanding means the alarm was delivered
    // while the manual pass was still parked. If the runtime deferred it until
    // the object was idle, this never reaches 2 and the wait throws.
    await waitForOutstanding(2);
    const alarmArrivedDuringPass = exchange.outstanding() >= 2;

    gate.open();
    exchange.holdUntil = null;
    await manual;

    // Drain the alarm's pass before returning. It has no promise to await --
    // the runtime owns it -- so this waits on its observable end instead. See
    // `afterEach`: a pass still running when the test returns reaches a
    // disposed D1 binding and takes the runtime down with it.
    // Wait for the alarm's pass to FINISH, on a precise signal rather than a
    // timer. The exchange read ending is not the pass ending: `#observeOpenOrders`
    // still has its audit, its D1 standing-alert resolve, and `#syncAlarm` to
    // go, and returning mid-pass leaves D1 work running into teardown -- which
    // is what "Closing rpc while resolve was pending" was, and what made this
    // file segfault the pool when run with the rest of the suite.
    //
    // Re-arming the schedule is the last thing `alarm()` does, so the schedule
    // showing the NEXT poll time is the pass having completed. Timers were
    // tried first and were flaky; this is exact.
    // Any instant strictly later than the one it fired at. Deliberately not the
    // exact next poll time: the healthy cadence is per-tier now, and this probe
    // is about whether the alarm was DELIVERED during the manual pass, not about
    // what interval it re-armed at. Pinning the number here would make a tier
    // change look like a concurrency regression.
    await waitForPollRearmedAfter(clock);

    expect(exchange.outstanding()).toBe(0);
    expect(alarmArrivedDuringPass).toBe(true);
    // The interleaving itself, pinned. Asserting only the boolean above would
    // pass just as well if the alarm had run tidily after the manual pass
    // finished -- the trap the step 20 cross-caller test fell into.
    expect(exchange.events.slice(0, 3)).toEqual([
      "read-1:begin",
      "read-2:begin",
      "read-1:end",
    ]);
  });
});

describe("probe 3: two passes racing to apply the SAME fill", () => {
  /**
   * The storage question, asked as an outcome instead of as a mechanism.
   *
   * WHAT THE FIRST VERSION OF THIS PROBE GOT WRONG, recorded because it is the
   * same trap the file header warns about in a second disguise. It instrumented
   * `storage.put` with a depth counter and looked for re-entry while one pass
   * was parked on the exchange gate. It reported zero — and proved nothing,
   * because a pass parked in the EXCHANGE is not doing storage work at all.
   * There was never an opportunity for the interleaving it claimed to be
   * hunting. A clean result there measured the setup, not the runtime.
   *
   * So this asks the question the design actually needs answered, at the level
   * where it has consequences. Both passes are released from a genuine
   * suspension AT THE SAME INSTANT and then race through the identical
   * storage-only sequence — `#order()` get, `#state()` get, `applyFill`,
   * `#putOrder` put, `#putState` put — against the same order and the same
   * `fillId`.
   *
   * `#pollOpenOrders` deduplicates by real identity, not by a flag:
   *
   *     if (order.fills.some((existing) => existing.fillId === fill.fillId)) continue;
   *
   * That check is a read, and the write that makes it true comes later. If a
   * foreign task can resume between them, both passes see an unrecorded fill
   * and both apply it, and the position ends up holding the fill TWICE. Step
   * 19's whole idempotency argument rests on that not happening.
   *
   * A doubled position is decisive: storage sequences interleave, and the
   * identity check needs to become a compare-and-swap. A single application is
   * evidence of absence in the weak sense only — it did not happen across these
   * rounds, not that it cannot — which is why `#mutateState` re-reads inside
   * the write regardless. That costs one storage read and is correct under
   * either model.
   *
   * WHY THE FILL IS HALF THE ORDER, established by a mutant that SURVIVED. The
   * first version used a full fill and asserted the position held it once. That
   * assertion passed with BOTH identity checks deleted — the poll's `continue`
   * and `applyFill`'s `duplicate_fill` — because a full fill is guarded twice
   * more over: the first application takes the order to `filled`, so the second
   * is refused as `fill_after_terminal`, and even without that it would be
   * refused as `overfill`. Four independent guards, and the probe could not see
   * past the outer two. It was measuring the state machine's belt and braces,
   * not the thing it named.
   *
   * At half the quantity the order stays `partially_filled` and two
   * applications total exactly its quantity, so neither `fill_after_terminal`
   * nor `overfill` fires and the identity check is genuinely alone. The same
   * two-line mutant now doubles the position and fails this test, which is what
   * makes the passing result mean something.
   */
  it("records whether the fillId identity check can be defeated by a concurrent pass", async () => {
    const clientOrderId = await runningWithRestingOrder();
    const order = exchange.resting.get(clientOrderId)!;

    // A PARTIAL execution — half the order — and the halving is what makes this
    // probe mean anything. See the docblock: against a FULL fill, three further
    // guards (`fill_after_terminal`, `overfill`, and the poll's own `continue`)
    // each independently prevent the double-apply, so the assertion below
    // passes no matter what the identity check does. At half the quantity the
    // order stays `partially_filled` rather than terminal and two applications
    // total exactly its quantity rather than exceeding it, so those three fall
    // silent and the `fillId` check is the only thing left standing.
    exchange.fillsByOrder.set(clientOrderId, [
      {
        fillId: "gemini-tid-race",
        price: order.request.price,
        quantity: order.request.quantity / 2n,
        feeAmount: 0n,
        feeAsset: "USDT",
        executedAt: T0 + 1000,
      },
    ]);

    await attachDependencies();
    const stub = botStub(objectName);

    const gate = openable();
    exchange.holdUntil = gate.promise;

    // Two passes, both parked inside the object on a real exchange suspension.
    const first = track(stub.checkOpenOrders("probe-a"));
    const second = track(stub.checkOpenOrders("probe-b"));
    await waitForOutstanding(2); // both really are inside

    // Released together: from here they race through storage only.
    gate.open();
    exchange.holdUntil = null;
    const [a, b] = await Promise.all([first, second]);

    const position = await inBot(objectName, async (bot) => (await bot.snapshot()).state.position);

    const applied = [...a.applied, ...b.applied];

    // MEASURED: the identity check held. Exactly one pass applied the fill and
    // the position holds half the order, not all of it.
    expect(applied).toHaveLength(1);
    expect(position.quantity).toBe(order.request.quantity / 2n);
  });
});

// ---------------------------------------------------------------------------

describe("step 21: a poll that defers AFTER reading", () => {
  /**
   * The deferral that the in-process tests cannot produce, and the only one
   * that exercises `observedEverything`'s `!pass.deferred`.
   *
   * `bot-instance.test.ts` drives its competing pass to completion inside a
   * seam, so by the time the poll looks again the other pass has finished and
   * the poll defers BEFORE its loop -- with `reads === 0`, which every
   * downstream guard already handles. The interesting deferral is the other
   * one: read an order successfully, then find another pass has started while
   * the read was in flight. That pass has `reads > 0` and `unreadable === 0`,
   * which is precisely the shape of a clean pass, and only `deferred`
   * distinguishes it.
   *
   * Getting there needs a genuinely concurrent, still-running competitor, which
   * needs the stub harness in this file: a halt parked inside its own
   * cancellation while the poll resumes from its read.
   */
  it("does not resolve a standing alert it never finished looking for", async () => {
    const clientOrderId = await runningWithRestingOrder();

    // A real `unattributable_fill`: filled on the venue, with no per-fill
    // detail, so there is no id to apply and the incident stands.
    exchange.resting.get(clientOrderId)!.filledQuantity = exchange.placed[0]!.quantity;
    await run((bot) => bot.checkOpenOrders(ACTOR));
    expect(await db.alerts.count({ alert_type: "unattributable_fill", resolved: false })).toBe(1);

    // Now make the venue report nothing wrong, so a pass that DID finish would
    // resolve the incident. Only the deferral should stop it.
    exchange.resting.get(clientOrderId)!.filledQuantity = 0n;

    await attachDependencies();
    const stub = botStub(objectName);

    const readGate = openable();
    const cancelGate = openable();
    exchange.holdUntil = readGate.promise;
    exchange.holdCancelUntil = cancelGate.promise;

    // The poll parks inside its read.
    const poll = track(stub.checkOpenOrders("poll"));
    await waitForOutstanding(1);

    // A halt starts and parks inside its cancellation, so it is still in
    // flight -- `#passesInFlight` is 1 -- when the poll resumes below.
    const halt = track(stub.halt("manual", "operator", ACTOR));
    await waitUntil(
      () => exchange.cancelsEntered > 0,
      "the halt to reach its cancellation and park there",
    );

    // Release the read. The poll now has a successful read in hand and finds
    // it is no longer alone.
    readGate.open();
    exchange.holdUntil = null;
    const result = await poll;

    cancelGate.open();
    exchange.holdCancelUntil = null;
    await halt;

    // It read one order, none of them failed -- indistinguishable from a clean
    // pass except for `deferred`.
    expect(result.deferred).toBe(true);
    expect(await db.alerts.count({ alert_type: "unattributable_fill", resolved: false })).toBe(1);
  });
});
