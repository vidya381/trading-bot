/**
 * The silent-subscription detector.
 *
 * Two layers, the same split `price-cross-check.test.ts` uses:
 *
 *   - `evaluateFeedSilence` directly, because every interesting case is a
 *     COMBINATION of "how long has the feed been quiet" and "what was the market
 *     doing", and driving each one through a live feed and a live venue would
 *     test the fixtures rather than the rule;
 *   - `runFeedSilenceCheck` against a real database, because the alert
 *     lifecycle -- one standing row, resolved only by a pass that actually
 *     looked -- is a property of the whole thing.
 */

import { beforeEach, describe, expect, it } from "vitest";

import { freshDatabase } from "../db/test-helpers";
import type { Database } from "../db";
import { ok, type ExchangeOutcome } from "../shared/downtime";
import { fromDecimalString, ZERO, type Money } from "../shared/money";
import type { Candle, Pair, Timestamp } from "../shared/exchange-client";
import {
  evaluateFeedSilence,
  runFeedSilenceCheck,
  FEED_SILENCE_MS,
  FEED_SUBSCRIPTION_SILENT_ALERT,
  feedSilenceSource,
  type FeedSilencePorts,
  type FeedSnapshot,
} from "./feed-silence";

const PAIR = "SOLUSDT" as Pair;
const NOW: Timestamp = 1_760_000_000_000;

/** A feed that is up, subscribed, and last forwarded `ago` ms before NOW. */
function feed(ago: number, overrides: Partial<FeedSnapshot> = {}): FeedSnapshot {
  return {
    connected: true,
    stopped: false,
    subscriberCount: 2,
    lastForwardAt: NOW - ago,
    ...overrides,
  };
}

/** A one-minute candle at `openTime`, with or without trading in it. */
function candle(openTime: Timestamp, volume: Money = fromDecimalString("12.5")): Candle {
  return {
    pair: PAIR,
    openTime,
    closeTime: openTime + 60_000,
    open: fromDecimalString("100"),
    high: fromDecimalString("100"),
    low: fromDecimalString("100"),
    close: fromDecimalString("100"),
    volume,
    closed: true,
  };
}

// ---------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------

describe("evaluateFeedSilence", () => {
  it("says nothing about a feed that is still forwarding", () => {
    const outcome = evaluateFeedSilence(PAIR, feed(60_000), [], NOW);
    expect(outcome.status).toBe("forwarding");
  });

  it("calls a long silence QUIET when the venue shows no trading either", () => {
    // ⚠ THE FALSE ALARM, AT ITS SOURCE. This is `bot-wfemoo`'s overnight SOLUSDT
    // shape: the feed forwarded nothing for twenty minutes because the pair did
    // not trade for twenty minutes. Kraken's own REST candles agree -- rows
    // exist for those minutes, and every one carries zero volume. Correct
    // behaviour end to end, and nothing should be raised about it.
    const quiet = [0, 1, 2, 3].map((i) => candle(NOW - 19 * 60_000 + i * 60_000, ZERO));
    const outcome = evaluateFeedSilence(PAIR, feed(20 * 60_000), quiet, NOW);

    expect(outcome.status).toBe("quiet");
    expect(outcome.activeCandles).toBe(0);
  });

  it("calls it SILENT when the venue traded and the feed forwarded none of it", () => {
    // The condition nothing else in the system can see: socket connected,
    // heartbeats current, `price_feed_value_frozen` with no candles to count,
    // and every bot on the pair quietly not evaluating its stop-loss.
    const traded = [0, 1, 2].map((i) => candle(NOW - 19 * 60_000 + i * 60_000));
    const outcome = evaluateFeedSilence(PAIR, feed(20 * 60_000), traded, NOW);

    expect(outcome.status).toBe("silent");
    expect(outcome.activeCandles).toBe(3);
  });

  it("counts VOLUME, not rows -- a zero-volume candle is not activity", () => {
    // ⚠ THE DISTINCTION THE WHOLE DETECTOR RESTS ON. Kraken returns a row for a
    // minute in which nothing traded, so counting rows would find "activity" in
    // every quiet minute and fire this alert constantly on exactly the thin
    // pairs it exists to stop bothering people about. The same zero-volume
    // signal `#trackFrozenValue` already keys its own detector off.
    const rows = [0, 1, 2, 3, 4].map((i) => candle(NOW - 19 * 60_000 + i * 60_000, ZERO));
    expect(evaluateFeedSilence(PAIR, feed(20 * 60_000), rows, NOW).status).toBe("quiet");

    // One real trade among them flips it, and only one is needed.
    const withOneTrade = [...rows];
    withOneTrade[2] = candle(withOneTrade[2]!.openTime, fromDecimalString("0.4"));
    const outcome = evaluateFeedSilence(PAIR, feed(20 * 60_000), withOneTrade, NOW);
    expect(outcome.status).toBe("silent");
    expect(outcome.activeCandles).toBe(1);
  });

  it("ignores trading that happened BEFORE the feed's last forward", () => {
    // ⚠ A candle that closed before the last forward was not missed -- the feed
    // sent it. Counting one would report a working feed as broken for failing to
    // do something it had already done, which is how a detector earns a
    // reputation for crying wolf and stops being read.
    const lastForwardAgo = 20 * 60_000;
    const before = candle(NOW - 40 * 60_000);
    const outcome = evaluateFeedSilence(PAIR, feed(lastForwardAgo), [before], NOW);

    expect(outcome.status).toBe("quiet");
    expect(outcome.activeCandles).toBe(0);
  });

  it("skips a feed nobody is subscribed to, whose silence is the design working", () => {
    const outcome = evaluateFeedSilence(
      PAIR,
      feed(60 * 60_000, { subscriberCount: 0 }),
      [candle(NOW - 60_000)],
      NOW,
    );
    expect(outcome.status).toBe("skipped");
    expect(outcome.reason).toMatch(/no subscribers/);
  });

  it("skips a stopped feed", () => {
    const outcome = evaluateFeedSilence(
      PAIR,
      feed(60 * 60_000, { stopped: true }),
      [candle(NOW - 60_000)],
      NOW,
    );
    expect(outcome.status).toBe("skipped");
  });

  it("skips a feed that has never forwarded, having no silence to time", () => {
    const outcome = evaluateFeedSilence(
      PAIR,
      feed(0, { lastForwardAt: null }),
      [candle(NOW - 60_000)],
      NOW,
    );
    expect(outcome.status).toBe("skipped");
    expect(outcome.reason).toMatch(/never forwarded/);
  });

  it("holds its fire right up to the threshold", () => {
    const traded = [candle(NOW - 60_000)];
    expect(evaluateFeedSilence(PAIR, feed(FEED_SILENCE_MS - 1), traded, NOW).status).toBe(
      "forwarding",
    );
    expect(evaluateFeedSilence(PAIR, feed(FEED_SILENCE_MS), traded, NOW).status).toBe("silent");
  });

  it("sits comfortably above the per-bot staleness threshold", () => {
    // ⚠ THE ORDERING BETWEEN THE TWO CHECKS, ASSERTED RATHER THAN ASSUMED. This
    // is the SECOND opinion on a condition `price_updates_stale` has already
    // declined to alert about. Firing sooner would recreate the false positive
    // one layer out -- the alert surface saying "quiet market" in two voices.
    const PRICE_STALENESS_MS = 600_000;
    expect(FEED_SILENCE_MS).toBeGreaterThan(PRICE_STALENESS_MS);
  });
});

// ---------------------------------------------------------------------------
// The lifecycle
// ---------------------------------------------------------------------------

describe("runFeedSilenceCheck", () => {
  let db: Database;
  let ids: number;

  beforeEach(async () => {
    db = await freshDatabase();
    ids = 0;
  });

  const newId = () => `alert-${(ids += 1)}`;

  function ports(
    snapshot: FeedSnapshot | null,
    candles: ExchangeOutcome<readonly Candle[]>,
    reads: { candles: number } = { candles: 0 },
  ): FeedSilencePorts {
    return {
      feedStatus: async () => snapshot,
      referenceCandles: async () => {
        reads.candles += 1;
        return candles;
      },
    };
  }

  const run = (p: FeedSilencePorts) =>
    runFeedSilenceCheck(db, newId, p, { accountLabel: "kraken-main", pairs: [PAIR], at: NOW });

  async function rows() {
    return await db.alerts.findMany({ where: { alert_type: FEED_SUBSCRIPTION_SILENT_ALERT } });
  }

  it("raises one critical row when a feed is silent through real trading", async () => {
    const traded = [0, 1].map((i) => candle(NOW - 19 * 60_000 + i * 60_000));
    const result = await run(ports(feed(20 * 60_000), ok(traded, NOW)));

    expect(result.raised).toEqual([PAIR]);
    const alerts = await rows();
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.severity).toBe("critical");
    expect(alerts[0]!.bot_instance_id).toBeNull();
    expect(alerts[0]!.source).toBe(feedSilenceSource("kraken-main"));
    expect(alerts[0]!.message).toMatch(/stopped delivering/);
  });

  it("raises NOTHING, and reads no candles at all, while a feed is forwarding", async () => {
    // The common case must cost nothing. A healthy account making one REST call
    // per pair per pass, forever, to learn that everything is fine, is budget
    // spent on a question that was already answered.
    const reads = { candles: 0 };
    const result = await run(ports(feed(60_000), ok([], NOW), reads));

    expect(result.raised).toEqual([]);
    expect(reads.candles).toBe(0);
    expect(await rows()).toHaveLength(0);
  });

  it("raises nothing for a quiet market, and resolves a row it had open", async () => {
    const traded = [candle(NOW - 19 * 60_000)];
    await run(ports(feed(20 * 60_000), ok(traded, NOW)));
    expect((await rows())[0]!.resolved).toBe(false);

    // Same silence, but now the venue says nothing traded during it.
    const quiet = [candle(NOW - 19 * 60_000, ZERO)];
    const result = await run(ports(feed(20 * 60_000), ok(quiet, NOW)));

    expect(result.raised).toEqual([]);
    const alerts = await rows();
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.resolved).toBe(true);
  });

  it("writes ONE row however many passes re-detect it", async () => {
    const traded = [candle(NOW - 19 * 60_000)];
    for (let i = 0; i < 5; i++) await run(ports(feed(20 * 60_000), ok(traded, NOW)));
    expect(await rows()).toHaveLength(1);
  });

  it("leaves an open row exactly where it was when the candles cannot be read", async () => {
    // ⚠ SECTION 5.6 ON THE ALERT TABLE. A REST outage is not evidence that a
    // WebSocket is healthy. Closing a live row because the check itself went
    // blind is the precise mistake this rule exists to prevent.
    const traded = [candle(NOW - 19 * 60_000)];
    await run(ports(feed(20 * 60_000), ok(traded, NOW)));
    expect((await rows())[0]!.resolved).toBe(false);

    const unreadable: ExchangeOutcome<readonly Candle[]> = {
      ok: false,
      kind: "transport",
      message: "venue unreachable",
      retryable: true,
      at: NOW,
    };
    const result = await run(ports(feed(20 * 60_000), unreadable));

    expect(result.observed).toBe(false);
    expect(result.outcomes[0]!.status).toBe("skipped");
    expect((await rows())[0]!.resolved).toBe(false);
  });

  it("survives a feed that cannot be asked, without failing the pass", async () => {
    const result = await runFeedSilenceCheck(
      db,
      newId,
      {
        feedStatus: async () => {
          throw new Error("PRICE_FEED unreachable");
        },
        referenceCandles: async () => ok([], NOW),
      },
      { accountLabel: "kraken-main", pairs: [PAIR], at: NOW },
    );

    expect(result.outcomes[0]!.status).toBe("skipped");
    expect(result.outcomes[0]!.reason).toMatch(/PRICE_FEED unreachable/);
    expect(result.observed).toBe(false);
    expect(await rows()).toHaveLength(0);
  });

  it("skips a market with no feed running at all", async () => {
    const result = await run(ports(null, ok([], NOW)));
    expect(result.outcomes[0]!.status).toBe("skipped");
    expect(result.observed).toBe(false);
  });
});
