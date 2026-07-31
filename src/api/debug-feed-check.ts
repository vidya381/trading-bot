/**
 * TEMPORARY DIAGNOSTIC — `GET /api/debug/feed-check`. DELETE AFTER ONE CONFIRMING RUN.
 *
 * This is **Tier 1** (decision-log 14.7), the step after 14.6's Tier 0. Tier 0
 * proved that Cloudflare's edge can open a WebSocket to Gemini's sandbox marketdata
 * feed — but it proved it from the Worker's own fetch handler, deliberately
 * INDEPENDENT of the `PriceFeed` Durable Object, so a failure could not be blamed on
 * DO lifecycle. Tier 1 asks the next question, and the one the whole arc rests on:
 * does the REAL `PriceFeed` object — not a standalone lookalike — actually connect,
 * survive a real minute boundary, and forward a real CLOSED candle to a subscriber?
 *
 * The automated suite cannot answer that. Every engine and lifecycle test injects a
 * fake `connect` (14.3 decision 6) and a spy `deliver` (14.4 decision 5), which is
 * exactly the gap that let the `wss://`-passed-to-`fetch` transport bug survive
 * until Tier 0 ran live (14.6). So this route drives the real object, live, once.
 *
 * It is NOT a feature, a health probe, or a monitoring endpoint.
 *
 * ── HOW IT OBSERVES THE FAN-OUT (the hard part) ──────────────────────────────
 * A Durable Object's storage is unreadable from outside, and `#fanOut` records
 * nothing per-subscriber, so "did a candle reach the subscriber" has to be inferred
 * from evidence the object leaves where the Worker can see it. Two channels, both
 * used, because neither alone is enough:
 *
 *  1. `PriceFeed.debugSnapshot()` — the temporary READ-ONLY RPC this diagnostic
 *     added to the object (marked for removal there too). Polled every few seconds,
 *     it gives `connected`, `subscribers`, `lastMessageAt` and — the load-bearing
 *     one — `watermark`. `#forwardClosed` writes the watermark ONLY after
 *     `await this.#deps.forward(price)` resolves, and in production `forward` IS
 *     `#fanOut` over the subscriber table. So a watermark that advances past its
 *     primed baseline, while `debug-check` is in `subscribers`, proves a real closed
 *     candle went through the real fan-out with this subscriber in the list.
 *  2. The `alerts` table in D1 — per-subscriber attribution, for free. The throwaway
 *     id is not a real bot, so its `onPriceUpdate` throws `not_created`, the fan-out
 *     delivery REJECTS, and `#fanOut` records a `price_feed_fanout_failed` alert
 *     naming `debug-check` in the message. That row is written by the real feed, to
 *     D1, and read back here: direct evidence that the cross-DO RPC was issued for
 *     THIS id. The rejection is expected and inherent to using a fake subscriber —
 *     `allSettled` isolates it, and no real bot is affected.
 *
 * Channel 1 answers "did the feed connect and forward"; channel 2 answers "did it
 * reach this subscriber". A run needs both to be unambiguous.
 *
 * ── THE SCHEMA PRECONDITION (why this refuses without an `alerts` table) ──────
 * `#fanOut` awaits `#alert(...)` when a delivery rejects, and that insert throws on a
 * database with no `alerts` table — which would propagate out of `forward` and stop
 * `#forwardClosed` from ever writing the watermark. A perfectly healthy feed would
 * then look broken. So this refuses up front rather than reporting a false negative.
 *
 * ── THE REQUEST-DURATION CONSTRAINT (why the wait is what it is) ──────────────
 * Cloudflare imposes NO hard wall-clock limit on an HTTP-triggered Worker while the
 * client stays connected (CPU time is the real limit, and waiting on a timer costs
 * none); 524 is an ORIGIN timeout and does not apply to a Worker-generated response.
 * The one real hazard is that a runtime update gives in-flight requests a 30-second
 * grace period, so an arbitrarily long hold is not free.
 *
 * Against that, the cadence the step-14 probe MEASURED: the replay batch primes
 * `#current` without forwarding, and the first forward happens when a frame with a
 * newer `openTime` arrives — and candle frames arrive only on activity, 35–70s
 * apart (heartbeats every ~5s). Worst case is therefore ~60s to the boundary plus up
 * to ~70s of quiet ≈ 130s. Hence a 120s default (`?waitMs=`, clamped to 180s), and —
 * importantly — a quiet market is reported as INCONCLUSIVE, not as a failure: a feed
 * that is connected and receiving frames but saw no rollover in the window is not a
 * broken feed, it is a short window. Re-run rather than debug.
 *
 * ── REMOVAL (do this right after the one confirming run) ─────────────────────
 *   1. Delete this file (`src/api/debug-feed-check.ts`).
 *   2. Delete its test (`src/api/debug-feed-check.test.ts`).
 *   3. Delete the marked `TEMPORARY DIAGNOSTIC` block AND the `handleFeedCheck`
 *      import in `src/api/index.ts`.
 *   4. Delete the marked `TEMPORARY DIAGNOSTIC READ PATH` block (`debugSnapshot`)
 *      and the `PriceFeedDebugSnapshot` interface in
 *      `src/durable-objects/price-feed.ts`.
 *   5. Note the removal (commit hash) in decision-log 14.7, as 14.6 did.
 *
 * ── Safety ───────────────────────────────────────────────────────────────────
 * Read-only market data only: no bot is created, no order path is reachable, no
 * credentials are touched (the feed is public and credential-free by design, step 14
 * decision 1). The subscriber id is deliberately fake, and it is ALWAYS removed in a
 * `finally`, so the check cannot leave a phantom subscriber in the registry. Gated
 * behind the same Cloudflare Access + JWT check as every other `/api/*` route.
 */

import { ApiError } from "./envelope";
import { databaseFrom } from "../db";
import type { AlertRow, ExchangeId } from "../db/schema";
import type {
  PriceFeed,
  PriceFeedConfig,
  PriceFeedDebugSnapshot,
} from "../durable-objects/price-feed";
import type { Pair, Timestamp } from "../shared/exchange-client";

/**
 * The throwaway subscriber id. Deliberately not a UUID and not any real bot's id:
 * anyone reading the registry, the alerts table or this file should see at a glance
 * that it is a diagnostic artefact and not a bot that went missing.
 */
export const DEBUG_SUBSCRIBER_ID = "debug-check";

/** The probe market: Gemini's sandbox BTCUSD, the same one every prior probe used. */
const PROBE_EXCHANGE: ExchangeId = "gemini";
const PROBE_PAIR = "BTCUSD" as Pair;
const PROBE_CONFIG: PriceFeedConfig = { exchange: PROBE_EXCHANGE, pair: PROBE_PAIR };

/** `PRICE_FEED.getByName("gemini:BTCUSD")` — the shared feed for this market. */
export const FEED_KEY = `${PROBE_EXCHANGE}:${PROBE_PAIR}`;

/** See the request-duration note in the header for where these numbers come from. */
const DEFAULT_WAIT_MS = 120_000;
const MAX_WAIT_MS = 180_000;
const MIN_WAIT_MS = 10_000;
/** How often the feed's snapshot is polled during the wait. */
const POLL_MS = 5_000;
/**
 * Slack subtracted from the alert-query lower bound. The alert's `created_at` is the
 * feed object's clock and this route's `since` is the Worker's; they are both
 * Cloudflare wall clocks, but a second of skew should not hide the row.
 */
const ALERT_CLOCK_SLACK_MS = 5_000;

/** The subset of the real `PriceFeed` stub this diagnostic drives. */
export interface FeedProbePort {
  subscribe(botInstanceId: string, config: PriceFeedConfig): Promise<void>;
  unsubscribe(botInstanceId: string): Promise<void>;
  debugSnapshot(): Promise<PriceFeedDebugSnapshot> | PriceFeedDebugSnapshot;
}

/** One poll of the feed's state, kept in the result so the live run is legible. */
export interface FeedCheckSample {
  /** Milliseconds since the check started. */
  readonly atMs: number;
  readonly connected: boolean;
  readonly watermark: number | null;
  readonly subscriberCount: number;
  /** Milliseconds since the feed last received ANY frame, at this poll. */
  readonly sinceLastMessageMs: number | null;
}

/** A feed alert raised during the window, trimmed to what a live run needs to read. */
export interface FeedCheckAlert {
  readonly alertType: string;
  readonly severity: string;
  readonly message: string;
  readonly createdAt: number;
}

export interface FeedCheckResult {
  /**
   * `pass` — a real closed candle was forwarded through the real fan-out.
   * `inconclusive` — the feed connected and was receiving frames, but no candle
   *   closed inside the window (a quiet market or too short a wait). Re-run.
   * `fail` — the feed never connected, or the subscribe itself failed.
   */
  readonly verdict: "pass" | "inconclusive" | "fail";
  /** Did the real DO hold a live outbound socket at any poll? */
  readonly feedConnected: boolean;
  /** Was the throwaway id actually present in the durable registry? */
  readonly subscriptionRegistered: boolean;
  /** Did the watermark advance past its primed baseline (channel 1)? */
  readonly candleForwarded: boolean;
  /** Was a fan-out to THIS subscriber evidenced in D1 (channel 2)? */
  readonly deliveredToDebugSubscriber: boolean;
  /** How long into the window the forward was observed, if it was. */
  readonly forwardedAfterMs: number | null;
  readonly watermarkAtPrime: number | null;
  readonly watermarkAtEnd: number | null;
  /** Whether any frame at all reached the feed (heartbeats count — it is liveness). */
  readonly framesObserved: boolean;
  readonly waitedMs: number;
  /** False means a phantom subscriber may remain — see `errors`, and re-run. */
  readonly unsubscribed: boolean;
  readonly feedAlerts: readonly FeedCheckAlert[];
  readonly errors: readonly string[];
  readonly samples: readonly FeedCheckSample[];
  /** One sentence, so a live run does not have to be interpreted field by field. */
  readonly summary: string;
}

/** Seams the suite overrides so no live call and no real 2-minute wait occur. */
export interface FeedCheckDeps {
  readonly feed: FeedProbePort;
  /** Alerts created at or after `since`; the handler supplies the real D1 query. */
  readonly alertsSince: (since: Timestamp) => Promise<readonly AlertRow[]>;
  readonly now: () => Timestamp;
  readonly wait: (ms: number) => Promise<void>;
  readonly waitMs?: number;
  readonly pollMs?: number;
}

/**
 * The route's core logic: subscribe a throwaway id to the real feed, poll the real
 * feed's state until a candle closes or the window expires, ALWAYS unsubscribe, then
 * corroborate against D1.
 *
 * Structure worth noting: the unsubscribe is in a `finally` that runs even if the
 * subscribe threw. `unsubscribe` is idempotent (14.4 decision 1 — a `DELETE` of a
 * non-member is a no-op), so an unnecessary call is free, whereas a subscribe that
 * inserted the row and THEN failed would otherwise leave the phantom subscriber this
 * check is explicitly required not to leave.
 */
export async function runFeedCheck(deps: FeedCheckDeps): Promise<FeedCheckResult> {
  const waitMs = deps.waitMs ?? DEFAULT_WAIT_MS;
  const pollMs = deps.pollMs ?? POLL_MS;
  const startedAt = deps.now();
  const deadline = startedAt + waitMs;

  const errors: string[] = [];
  const samples: FeedCheckSample[] = [];
  let feedConnected = false;
  let subscriptionRegistered = false;
  let framesObserved = false;
  let watermarkAtPrime: number | null = null;
  let watermarkAtEnd: number | null = null;
  let forwardedAfterMs: number | null = null;
  let subscribed = false;
  let unsubscribed = false;

  try {
    try {
      await deps.feed.subscribe(DEBUG_SUBSCRIBER_ID, PROBE_CONFIG);
      subscribed = true;
    } catch (error) {
      // Recorded, not rethrown: the `finally` below must still run, because a
      // subscribe can insert the registry row and fail afterwards (its
      // `startFeed` is a second step).
      errors.push(`subscribe failed: ${describe(error)}`);
    }

    // Poll until a candle is observed forwarded, or the window expires. The first
    // poll happens immediately, so a feed that is already up is visible at t=0.
    for (;;) {
      const elapsed = deps.now() - startedAt;
      let snapshot: PriceFeedDebugSnapshot;
      try {
        snapshot = await deps.feed.debugSnapshot();
      } catch (error) {
        errors.push(`debugSnapshot failed at ${elapsed}ms: ${describe(error)}`);
        break;
      }

      if (snapshot.connected) feedConnected = true;
      if (snapshot.subscribers.includes(DEBUG_SUBSCRIBER_ID)) subscriptionRegistered = true;
      if (snapshot.lastMessageAt > 0) framesObserved = true;
      watermarkAtEnd = snapshot.watermark;
      samples.push({
        atMs: elapsed,
        connected: snapshot.connected,
        watermark: snapshot.watermark,
        subscriberCount: snapshot.subscribers.length,
        sinceLastMessageMs:
          snapshot.lastMessageAt > 0 ? deps.now() - snapshot.lastMessageAt : null,
      });

      // The FIRST non-null watermark is the baseline, not evidence. On a first-ever
      // connect the replay batch primes it to `newest.openTime - 1` WITHOUT
      // forwarding anything (14.3 decision 2), so only a strict advance past that
      // baseline means a candle was actually finalised and fanned out.
      if (snapshot.watermark !== null) {
        if (watermarkAtPrime === null) {
          watermarkAtPrime = snapshot.watermark;
        } else if (snapshot.watermark > watermarkAtPrime) {
          forwardedAfterMs = elapsed;
          break;
        }
      }

      if (deps.now() + pollMs > deadline) break;
      await deps.wait(pollMs);
    }
  } finally {
    try {
      await deps.feed.unsubscribe(DEBUG_SUBSCRIBER_ID);
      unsubscribed = true;
    } catch (error) {
      errors.push(
        `unsubscribe failed: ${describe(error)} — a phantom "${DEBUG_SUBSCRIBER_ID}" ` +
          `subscriber may remain in the ${FEED_KEY} registry; re-run to clear it`,
      );
    }
  }

  // Channel 2, read AFTER the loop: `#fanOut` awaits its alert insert before
  // `#forwardClosed` writes the watermark, so by the time an advance is visible the
  // row is already committed — there is no race to poll around.
  let feedAlerts: readonly FeedCheckAlert[] = [];
  try {
    const rows = await deps.alertsSince(startedAt - ALERT_CLOCK_SLACK_MS);
    feedAlerts = rows
      .filter((row) => row.source.startsWith("price-feed"))
      .map((row) => ({
        alertType: row.alert_type,
        severity: row.severity,
        message: row.message,
        createdAt: row.created_at,
      }));
  } catch (error) {
    errors.push(`reading feed alerts failed: ${describe(error)}`);
  }

  const deliveredToDebugSubscriber = feedAlerts.some(
    (alert) =>
      alert.alertType === "price_feed_fanout_failed" &&
      alert.message.includes(DEBUG_SUBSCRIBER_ID),
  );

  const candleForwarded = forwardedAfterMs !== null;
  const verdict: FeedCheckResult["verdict"] = !subscribed
    ? "fail"
    : !feedConnected
      ? "fail"
      : candleForwarded
        ? "pass"
        : "inconclusive";

  return {
    verdict,
    feedConnected,
    subscriptionRegistered,
    candleForwarded,
    deliveredToDebugSubscriber,
    forwardedAfterMs,
    watermarkAtPrime,
    watermarkAtEnd,
    framesObserved,
    waitedMs: deps.now() - startedAt,
    unsubscribed,
    feedAlerts,
    errors,
    samples,
    summary: summarise({
      verdict,
      subscribed,
      feedConnected,
      framesObserved,
      candleForwarded,
      deliveredToDebugSubscriber,
      forwardedAfterMs,
      waitMs,
    }),
  };
}

function summarise(facts: {
  verdict: FeedCheckResult["verdict"];
  subscribed: boolean;
  feedConnected: boolean;
  framesObserved: boolean;
  candleForwarded: boolean;
  deliveredToDebugSubscriber: boolean;
  forwardedAfterMs: number | null;
  waitMs: number;
}): string {
  if (!facts.subscribed) {
    return "FAIL: the subscribe RPC to the PriceFeed object failed, so nothing was checked.";
  }
  if (!facts.feedConnected) {
    return (
      "FAIL: the PriceFeed object never held a live socket during the window. " +
      "Tier 0 proved the edge CAN reach Gemini, so suspect the DO's own connect path " +
      "(socketUrl for this ENVIRONMENT, the fetch-Upgrade handshake) rather than reachability."
    );
  }
  if (!facts.candleForwarded) {
    return (
      `INCONCLUSIVE: the feed was connected and ${facts.framesObserved ? "receiving frames" : "receiving NOTHING"}, ` +
      `but no candle closed within ${Math.round(facts.waitMs / 1000)}s. ` +
      (facts.framesObserved
        ? "A quiet market, not a broken feed — re-run, optionally with a longer ?waitMs."
        : "Zero frames is NOT normal (heartbeats are ~5s) — treat this as a real problem.")
    );
  }
  return (
    `PASS: the real PriceFeed object connected, crossed a minute boundary, and forwarded a ` +
    `closed candle after ${facts.forwardedAfterMs}ms` +
    (facts.deliveredToDebugSubscriber
      ? `, and D1 confirms the fan-out issued a delivery to "${DEBUG_SUBSCRIBER_ID}".`
      : `. NOTE: no fan-out alert naming "${DEBUG_SUBSCRIBER_ID}" was found in D1, so ` +
        `per-subscriber delivery rests on the watermark alone (which advances only after ` +
        `the fan-out over the registry resolves).`)
  );
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Clamp the caller's `?waitMs` into the range the header explains. */
export function resolveWaitMs(raw: string | null): number {
  if (raw === null) return DEFAULT_WAIT_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return DEFAULT_WAIT_MS;
  return Math.min(Math.max(Math.trunc(parsed), MIN_WAIT_MS), MAX_WAIT_MS);
}

function feedFromEnv(env: Env): FeedProbePort {
  const namespace = env.PRICE_FEED as DurableObjectNamespace<PriceFeed> | undefined;
  if (namespace === undefined) {
    throw new ApiError(
      503,
      "no_price_feed_binding",
      "no PRICE_FEED binding in this environment. Only testnet and production declare " +
        "one; a deploy with no --env has none, so there is no feed object to check.",
    );
  }
  // The same addressing every subscriber uses (14.4 decision 3), so this reaches the
  // exact object a real bot on gemini:BTCUSD would.
  return namespace.get(namespace.idFromName(FEED_KEY));
}

/**
 * The route handler. `deps` is injectable for tests; production callers pass nothing
 * and get the real feed stub, the real D1 alerts query, a real clock and a real wait.
 * Always 200 — the pass/fail is the `verdict` in the body, since the diagnostic
 * itself ran either way.
 */
export async function handleFeedCheck(
  url: URL,
  env: Env,
  deps?: Partial<FeedCheckDeps>,
): Promise<Response> {
  let alertsSince = deps?.alertsSince;
  if (alertsSince === undefined) {
    const db = databaseFrom(env);
    if (!(await db.tableExists("alerts"))) {
      // See the schema-precondition note in the header: without this table the
      // feed's own fan-out alert insert throws, the watermark never advances, and a
      // healthy feed reports as broken. Refuse rather than mislead.
      return Response.json({
        verdict: "unavailable",
        error:
          "this environment has no `alerts` table, and the feed's fan-out writes an " +
          "alert for the (expected) failed delivery to the throwaway subscriber. " +
          "Without it that insert throws inside the fan-out, the watermark never " +
          "advances, and a working feed would report as broken. Apply the D1 " +
          "migrations to this environment first, then re-run.",
      });
    }
    alertsSince = (since) =>
      db.alerts.findMany({
        where: { created_at: { gte: since } },
        orderBy: [{ column: "created_at", direction: "asc" }],
        limit: 50,
      });
  }

  const result = await runFeedCheck({
    feed: deps?.feed ?? feedFromEnv(env),
    alertsSince,
    now: deps?.now ?? (() => Date.now()),
    wait: deps?.wait ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    waitMs: deps?.waitMs ?? resolveWaitMs(url.searchParams.get("waitMs")),
    pollMs: deps?.pollMs,
  });

  return Response.json({
    feedKey: FEED_KEY,
    subscriberId: DEBUG_SUBSCRIBER_ID,
    environment: env.ENVIRONMENT,
    ...result,
  });
}
