/**
 * The notification-dispatch worker shell (section 10, step 8).
 *
 * Two kinds of test:
 *   - the binding guards, which make the every-minute cron a clean no-op until
 *     the KV namespace and the Discord secret are provisioned; and
 *   - a REAL BotInstance halt, driven through the Durable Object into the same
 *     env.DB the shell reads, so the whole chain -- a bot raises an alert, the
 *     shell's own databaseFrom(env) + KvCooldownStore(env.ALERT_COOLDOWNS) find
 *     it, a ping goes out -- is exercised with only the notifier mocked. This
 *     is the BotInstance side of "no alert path left in isolation"; the circuit
 *     breaker side is covered end to end in dispatch.test.ts.
 */

import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { seedPlaceholderTotalBalance } from "../capital";
import { freshDatabase, alertRow } from "../db/test-helpers";
import type { Database } from "../db";
import { InMemoryCooldownStore } from "../notifications";
import type { AlertNotifier, NotifiableAlert, NotifyResult } from "../notifications";
import { FakeExchange, TEST_PAIR } from "../durable-objects/fake-exchange";
import { inBot, rateLimiterStub } from "../durable-objects/test-helpers";
import type { BotInstance, CreateDcaBotRequest } from "../durable-objects/bot-instance";
import type { DcaParams } from "../strategies/dca";
import { fromDecimalString as m } from "../shared/money";
import { runNotificationDispatch } from "./notifications";

const T0 = 1_760_000_000_000;
const ACTOR = "owner@example.com";

class RecordingNotifier implements AlertNotifier {
  readonly sent: NotifiableAlert[] = [];
  async send(alert: NotifiableAlert): Promise<NotifyResult> {
    this.sent.push(alert);
    return { delivered: true };
  }
}

/** A minimal env carrying neither the secret nor the KV binding. */
const bareEnv = { ENVIRONMENT: "testnet" } as unknown as Env;

describe("binding guards (no-op until provisioned)", () => {
  it("does not run without a DISCORD_WEBHOOK_URL secret", async () => {
    const result = await runNotificationDispatch(bareEnv, {
      cooldown: new InMemoryCooldownStore(),
    });
    expect(result.ran).toBe(false);
    expect(result.reason).toContain("DISCORD_WEBHOOK_URL");
  });

  it("does not run without the ALERT_COOLDOWNS KV binding", async () => {
    // Notifier injected, so the secret check is skipped and the KV check is what
    // fails.
    const result = await runNotificationDispatch(bareEnv, {
      notifier: new RecordingNotifier(),
    });
    expect(result.ran).toBe(false);
    expect(result.reason).toContain("ALERT_COOLDOWNS");
  });
});

describe("dispatching with injected dependencies", () => {
  it("runs and reports what it sent", async () => {
    const db = await freshDatabase();
    // Null bot: no bot_instances seed needed for the FK, and this test only
    // checks the shell dispatches what it finds.
    await db.alerts.insert(
      alertRow({ id: "a1", alert_type: "halt_stop_loss", bot_instance_id: null, created_at: T0 }),
    );
    const notifier = new RecordingNotifier();

    const result = await runNotificationDispatch(bareEnv, {
      db,
      notifier,
      cooldown: new InMemoryCooldownStore(),
      now: () => T0,
    });

    expect(result.ran).toBe(true);
    expect(result.result).toMatchObject({ scanned: 1, sent: 1 });
    expect(notifier.sent.map((a) => a.alertType)).toEqual(["halt_stop_loss"]);
  });
});

// ---------------------------------------------------------------------------
// A real BotInstance halt, through the shell's real DB and KV wiring.
// ---------------------------------------------------------------------------

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

describe("a real BotInstance halt is delivered through the shell", () => {
  let db: Database;
  let exchange: FakeExchange;
  let objectName: string;
  let botCounter = 0;

  beforeEach(async () => {
    db = await freshDatabase();
    exchange = new FakeExchange();
    botCounter += 1;
    objectName = `notif-bot-${botCounter}`;
    await seedPlaceholderTotalBalance(
      db,
      { accountLabel: "main", asset: "USDT", totalBalance: m("10000"), note: "test fixture" },
      { actor: ACTOR, now: T0 },
    );
  });

  function run<T>(body: (bot: BotInstance) => Promise<T>): Promise<T> {
    return inBot(objectName, async (instance) => {
      instance.attach({
        db,
        exchange,
        now: () => T0,
        newId: (() => {
          let n = 0;
          return () => `notif-gen-${(n += 1)}`;
        })(),
        limiterFor: () => rateLimiterStub(`limiter-${objectName}`),
        sleep: async () => undefined,
      });
      return body(instance);
    });
  }

  it("a bot's halt alert is found by databaseFrom(env) and pinged, cooldown in real KV", async () => {
    const creation: CreateDcaBotRequest = {
      botInstanceId: objectName,
      accountLabel: "main",
      exchange: "binance",
      pair: TEST_PAIR,
      capitalAsset: "USDT",
      allocatedCapital: m("400"),
      params,
      actor: ACTOR,
    };

    // Drive the real Durable Object: it writes a `halt_manual` alert to env.DB
    // via its own `#alert` funnel, with notified_at NULL.
    await run((bot) => bot.create(creation));
    const halt = await run((bot) => bot.halt("manual", "operator paused for review", ACTOR));
    expect(halt.status).toBe("halted");

    const written = await db.alerts.findMany({ where: { alert_type: "halt_manual" } });
    expect(written).toHaveLength(1);
    expect(written[0]!.notified_at).toBeNull();

    // The shell builds its OWN db (databaseFrom(env)) and its OWN cooldown
    // (KvCooldownStore over the real env.ALERT_COOLDOWNS). Only the notifier is
    // mocked. env.DB is the database freshDatabase() cleared and the bot wrote
    // to, so the shell sees the bot's alert.
    const notifier = new RecordingNotifier();
    const result = await runNotificationDispatch(env, { notifier, now: () => T0 });

    expect(result.ran).toBe(true);
    expect(notifier.sent.map((a) => a.alertType)).toContain("halt_manual");

    // Marked processed in D1 by the shell's own database handle.
    const after = await db.alerts.findOne({ id: written[0]!.id });
    expect(after!.notified_at).toBe(T0);
  });
});
