/**
 * Tests for the TEMPORARY `/api/debug/feed-check` diagnostic (decision-log 14.7,
 * Tier 1). DELETE this file when the route is removed after its one confirming run.
 *
 * Discipline, per section 14: the suite makes NO live call. `runFeedCheck`'s feed
 * port, D1 read, clock and wait are all injected, so a scripted sequence of feed
 * snapshots stands in for two minutes of real market data and the window elapses
 * instantly. These tests prove the route's LOGIC — the evidence rules (a primed
 * watermark is a baseline, not a forward), the pass/inconclusive/fail split, and the
 * guarantee that the throwaway subscriber is always removed. The real verification
 * is running the deployed route once, live, against the real PriceFeed object.
 *
 * ORDERING MATTERS, as in schema-guard.test.ts: the no-schema describe is defined
 * FIRST, before anything applies migrations, because that is the only way `env.DB`
 * is genuinely schema-less within a file.
 */

import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  DEBUG_SUBSCRIBER_ID,
  FEED_KEY,
  handleFeedCheck,
  resolveWaitMs,
  runFeedCheck,
  type FeedProbePort,
} from "./debug-feed-check";
import { handleApiRequest } from "./index";
import type { AlertRow } from "../db/schema";
import type { PriceFeedConfig, PriceFeedDebugSnapshot } from "../durable-objects/price-feed";

const T0 = 1_760_000_000_000;
/** The watermark the replay batch primes on a first connect (14.3 decision 2). */
const PRIMED = 1_759_999_999_999;
/** A later close time: the watermark AFTER a real candle was finalised and fanned out. */
const ADVANCED = PRIMED + 60_000;

type ScriptedSnapshot = Partial<PriceFeedDebugSnapshot>;

/**
 * A fake `PriceFeed` stub that replays scripted snapshots (the last one repeats
 * forever) and records every subscribe/unsubscribe.
 */
function scriptedFeed(
  script: readonly ScriptedSnapshot[],
  failures: { subscribe?: Error; unsubscribe?: Error } = {},
): {
  port: FeedProbePort;
  subscribes: Array<{ id: string; config: PriceFeedConfig }>;
  unsubscribes: string[];
} {
  const subscribes: Array<{ id: string; config: PriceFeedConfig }> = [];
  const unsubscribes: string[] = [];
  let index = 0;

  const port: FeedProbePort = {
    subscribe: async (id, config) => {
      subscribes.push({ id, config });
      if (failures.subscribe !== undefined) throw failures.subscribe;
    },
    unsubscribe: async (id) => {
      unsubscribes.push(id);
      if (failures.unsubscribe !== undefined) throw failures.unsubscribe;
    },
    debugSnapshot: async () => {
      const step = script[Math.min(index, script.length - 1)] ?? {};
      index += 1;
      return {
        config: { exchange: "gemini", pair: "BTCUSD" },
        connected: true,
        subscribers: [DEBUG_SUBSCRIBER_ID],
        watermark: null,
        lastMessageAt: T0,
        reconnectAttempts: 0,
        blindSince: null,
        ...step,
      } satisfies PriceFeedDebugSnapshot;
    },
  };
  return { port, subscribes, unsubscribes };
}

/** A clock the injected `wait` advances, so the window elapses with no real delay. */
function fakeClock(): { now: () => number; wait: (ms: number) => Promise<void> } {
  let clock = T0;
  return {
    now: () => clock,
    wait: async (ms) => {
      clock += ms;
    },
  };
}

function alertRow(overrides: Partial<AlertRow> = {}): AlertRow {
  return {
    id: "alert-1",
    severity: "warning",
    category: "system",
    alert_type: "price_feed_fanout_failed",
    bot_instance_id: null,
    source: `price-feed:${FEED_KEY}`,
    message: `delivering a price to bot ${DEBUG_SUBSCRIBER_ID} failed: this bot instance has no configuration`,
    resolved: false,
    created_at: T0 + 61_000,
    notified_at: null,
    ...overrides,
  };
}

const noAlerts = async (): Promise<readonly AlertRow[]> => [];

// ---------------------------------------------------------------------------
// The schema precondition. FIRST in the file: env.DB has no tables until some
// test applies migrations, which is the only way to observe this branch.
// ---------------------------------------------------------------------------

describe("the schema precondition (defined first, on a genuinely empty D1)", () => {
  it("refuses on a database with no `alerts` table, without touching the feed", async () => {
    const feed = scriptedFeed([{}]);
    const response = await handleFeedCheck(
      new URL("https://dash.example.com/api/debug/feed-check"),
      env,
      { feed: feed.port },
    );
    const body = (await response.json()) as { verdict: string; error: string };

    expect(body.verdict).toBe("unavailable");
    expect(body.error).toContain("alerts");
    // The point of refusing: a missing table makes the feed's fan-out alert insert
    // throw, so the watermark never advances and a healthy feed looks broken.
    expect(body.error).toContain("would report as broken");
    expect(feed.subscribes).toStrictEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The core logic
// ---------------------------------------------------------------------------

describe("runFeedCheck (Tier 1 route logic, scripted feed)", () => {
  it("PASSES when the watermark advances past its primed baseline", async () => {
    // The real sequence: connect (no watermark yet) -> the replay batch primes it
    // (NOT a forward) -> a minute boundary finalises a candle and the fan-out runs.
    const feed = scriptedFeed([
      { watermark: null },
      { watermark: PRIMED },
      { watermark: PRIMED },
      { watermark: ADVANCED },
    ]);
    const clock = fakeClock();

    const result = await runFeedCheck({
      feed: feed.port,
      alertsSince: async () => [alertRow()],
      now: clock.now,
      wait: clock.wait,
      waitMs: 120_000,
      pollMs: 5_000,
    });

    expect(result.verdict).toBe("pass");
    expect(result.feedConnected).toBe(true);
    expect(result.subscriptionRegistered).toBe(true);
    expect(result.candleForwarded).toBe(true);
    expect(result.watermarkAtPrime).toBe(PRIMED);
    expect(result.watermarkAtEnd).toBe(ADVANCED);
    // Polls at 0/5/10/15s: the advance is seen on the fourth.
    expect(result.forwardedAfterMs).toBe(15_000);
    expect(result.deliveredToDebugSubscriber).toBe(true);
    expect(result.errors).toStrictEqual([]);
    expect(result.summary).toContain("PASS");
  });

  it("subscribes the throwaway id with the probe market, and always unsubscribes it", async () => {
    const feed = scriptedFeed([{ watermark: PRIMED }, { watermark: ADVANCED }]);
    const clock = fakeClock();

    const result = await runFeedCheck({
      feed: feed.port,
      alertsSince: noAlerts,
      now: clock.now,
      wait: clock.wait,
      waitMs: 60_000,
      pollMs: 5_000,
    });

    expect(feed.subscribes).toStrictEqual([
      { id: "debug-check", config: { exchange: "gemini", pair: "BTCUSD" } },
    ]);
    expect(feed.unsubscribes).toStrictEqual(["debug-check"]);
    expect(result.unsubscribed).toBe(true);
  });

  it("stops the moment the forward is observed rather than waiting out the window", async () => {
    const feed = scriptedFeed([{ watermark: PRIMED }, { watermark: ADVANCED }]);
    const clock = fakeClock();

    const result = await runFeedCheck({
      feed: feed.port,
      alertsSince: noAlerts,
      now: clock.now,
      wait: clock.wait,
      waitMs: 180_000,
      pollMs: 5_000,
    });

    expect(result.forwardedAfterMs).toBe(5_000);
    expect(result.waitedMs).toBe(5_000);
    expect(result.samples).toHaveLength(2);
  });

  it("is INCONCLUSIVE when the feed is connected and live but no candle closes", async () => {
    // A quiet market: the watermark primes and never moves. This is the case the
    // verdict split exists for — a short window is not a broken feed.
    const feed = scriptedFeed([{ watermark: PRIMED }]);
    const clock = fakeClock();

    const result = await runFeedCheck({
      feed: feed.port,
      alertsSince: noAlerts,
      now: clock.now,
      wait: clock.wait,
      waitMs: 30_000,
      pollMs: 5_000,
    });

    expect(result.verdict).toBe("inconclusive");
    expect(result.feedConnected).toBe(true);
    expect(result.framesObserved).toBe(true);
    expect(result.candleForwarded).toBe(false);
    expect(result.watermarkAtPrime).toBe(PRIMED);
    expect(result.summary).toContain("quiet market");
    expect(result.waitedMs).toBe(30_000);
  });

  it("does NOT read the primed watermark itself as a forwarded candle", async () => {
    // The trap this check exists to avoid: on a first-ever connect the replay batch
    // sets the watermark to `newest.openTime - 1` WITHOUT forwarding anything.
    const feed = scriptedFeed([{ watermark: null }, { watermark: PRIMED }]);
    const clock = fakeClock();

    const result = await runFeedCheck({
      feed: feed.port,
      alertsSince: noAlerts,
      now: clock.now,
      wait: clock.wait,
      waitMs: 20_000,
      pollMs: 5_000,
    });

    expect(result.candleForwarded).toBe(false);
    expect(result.verdict).toBe("inconclusive");
  });

  it("FAILS when the feed never holds a socket, and still unsubscribes", async () => {
    const feed = scriptedFeed([{ connected: false, watermark: null, lastMessageAt: 0 }]);
    const clock = fakeClock();

    const result = await runFeedCheck({
      feed: feed.port,
      alertsSince: async () => [
        alertRow({
          alert_type: "price_feed_blind",
          message: "price feed for gemini:BTCUSD lost its connection",
        }),
      ],
      now: clock.now,
      wait: clock.wait,
      waitMs: 20_000,
      pollMs: 5_000,
    });

    expect(result.verdict).toBe("fail");
    expect(result.feedConnected).toBe(false);
    expect(result.framesObserved).toBe(false);
    expect(feed.unsubscribes).toStrictEqual(["debug-check"]);
    // The blind alert is surfaced, so a live failure says WHY without a second trip.
    expect(result.feedAlerts.map((a) => a.alertType)).toStrictEqual(["price_feed_blind"]);
    expect(result.summary).toContain("FAIL");
  });

  it("FAILS when the subscribe itself throws — and STILL unsubscribes", async () => {
    // A subscribe can insert the registry row and then fail in its second step
    // (`startFeed`), so the cleanup must not be conditional on the subscribe.
    const feed = scriptedFeed([{ watermark: PRIMED }], {
      subscribe: new Error("no BOT_INSTANCE binding"),
    });
    const clock = fakeClock();

    const result = await runFeedCheck({
      feed: feed.port,
      alertsSince: noAlerts,
      now: clock.now,
      wait: clock.wait,
      waitMs: 10_000,
      pollMs: 5_000,
    });

    expect(result.verdict).toBe("fail");
    expect(result.errors[0]).toContain("subscribe failed");
    expect(feed.unsubscribes).toStrictEqual(["debug-check"]);
    expect(result.summary).toContain("nothing was checked");
  });

  it("reports a failed unsubscribe loudly instead of throwing", async () => {
    const feed = scriptedFeed([{ watermark: PRIMED }, { watermark: ADVANCED }], {
      unsubscribe: new Error("RPC timed out"),
    });
    const clock = fakeClock();

    const result = await runFeedCheck({
      feed: feed.port,
      alertsSince: noAlerts,
      now: clock.now,
      wait: clock.wait,
      waitMs: 60_000,
      pollMs: 5_000,
    });

    expect(result.unsubscribed).toBe(false);
    expect(result.errors[0]).toContain("phantom");
    // The forward was still observed and reported — the cleanup failure does not
    // discard the result the run was for.
    expect(result.verdict).toBe("pass");
  });

  it("passes on the watermark alone, but says so, when D1 shows no fan-out alert", async () => {
    const feed = scriptedFeed([{ watermark: PRIMED }, { watermark: ADVANCED }]);
    const clock = fakeClock();

    const result = await runFeedCheck({
      feed: feed.port,
      alertsSince: noAlerts,
      now: clock.now,
      wait: clock.wait,
      waitMs: 60_000,
      pollMs: 5_000,
    });

    expect(result.verdict).toBe("pass");
    expect(result.deliveredToDebugSubscriber).toBe(false);
    expect(result.summary).toContain("watermark alone");
  });

  it("ignores alerts from sources other than the price feed", async () => {
    const feed = scriptedFeed([{ watermark: PRIMED }, { watermark: ADVANCED }]);
    const clock = fakeClock();

    const result = await runFeedCheck({
      feed: feed.port,
      alertsSince: async () => [
        alertRow({ source: "bot-instance", alert_type: "stop_loss" }),
        alertRow(),
      ],
      now: clock.now,
      wait: clock.wait,
      waitMs: 60_000,
      pollMs: 5_000,
    });

    expect(result.feedAlerts).toHaveLength(1);
    expect(result.deliveredToDebugSubscriber).toBe(true);
  });

  it("records a snapshot RPC failure and still cleans up", async () => {
    const feed: FeedProbePort = {
      subscribe: async () => {},
      unsubscribe: async () => {},
      debugSnapshot: () => {
        throw new Error("durable object reset");
      },
    };
    const clock = fakeClock();

    const result = await runFeedCheck({
      feed,
      alertsSince: noAlerts,
      now: clock.now,
      wait: clock.wait,
      waitMs: 60_000,
      pollMs: 5_000,
    });

    expect(result.verdict).toBe("fail");
    expect(result.errors[0]).toContain("debugSnapshot failed");
    expect(result.unsubscribed).toBe(true);
  });
});

describe("resolveWaitMs (the request-duration clamp)", () => {
  it("defaults to 120s and clamps to the 10s–180s range", () => {
    expect(resolveWaitMs(null)).toBe(120_000);
    expect(resolveWaitMs("not a number")).toBe(120_000);
    expect(resolveWaitMs("45000")).toBe(45_000);
    expect(resolveWaitMs("1")).toBe(10_000);
    expect(resolveWaitMs("600000")).toBe(180_000);
  });
});

describe("the route is gated behind the same authenticate() as every /api/* route", () => {
  it("rejects an unauthenticated request BEFORE reaching the feed (401)", async () => {
    // No Cf-Access-Jwt-Assertion header: authenticate() throws before the diagnostic
    // block runs, so an unauthenticated caller never subscribes anything anywhere.
    const request = new Request("https://dash.example.com/api/debug/feed-check");
    const response = await handleApiRequest(request, env);
    expect(response.status).toBe(401);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("access_jwt_missing");
  });
});
