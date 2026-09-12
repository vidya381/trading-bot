/**
 * THE SILENT SUBSCRIPTION DETECTOR (spec 5.7; this session).
 *
 * ---------------------------------------------------------------------------
 * THE AMBIGUITY THIS EXISTS TO RESOLVE, AND WHY NOTHING ELSE COULD
 * ---------------------------------------------------------------------------
 * A `PriceFeed` that has forwarded nothing for a long time is in one of two
 * states, and from inside the feed they are IDENTICAL:
 *
 *   QUIET   -- nothing traded, so there was nothing to forward. Correct,
 *              honest behaviour. Kraken emits an `ohlc` frame only on real
 *              activity, so a thin pair overnight genuinely goes minutes at a
 *              time with no update at all.
 *   DEAD    -- the socket is open and heartbeating, but the `ohlc`
 *              subscription itself has stopped delivering. The step 14 probe
 *              already has a verdict shape for exactly this: `connectionOpened`
 *              true, `candlesUpdateReceived` false.
 *
 * Every existing detector is blind to the difference, and each for a structural
 * reason rather than an oversight:
 *
 *   * `price_feed_blind` advances its staleness clock on ANY inbound frame, and
 *     a heartbeat is an inbound frame. Kraken heartbeats at ~1/second, so a feed
 *     delivering no candles at all stays permanently FRESH to it.
 *   * `price_feed_value_frozen` needs candles to look at. It fires on a value
 *     that repeats across forwards; a feed forwarding NOTHING gives it nothing
 *     to count, so it is silent precisely when this condition holds.
 *   * `price_updates_stale` was a per-bot timeout, and this session made it a
 *     comparison against `PriceFeedStatus.lastForwardAt` -- which correctly
 *     stopped it reporting a quiet market as a broken bot, and in doing so
 *     handed this case to something else. That something else is this file.
 *
 * ---------------------------------------------------------------------------
 * THE SIGNAL: THE SAME VENUE, A DIFFERENT TRANSPORT
 * ---------------------------------------------------------------------------
 * Quiet and dead differ in exactly one observable way -- whether the market
 * actually traded -- and the feed is the one thing that cannot answer it. So
 * this asks somewhere else: the venue's REST candles.
 *
 * ⚠ AND THAT IS A GENUINELY INDEPENDENT ANSWER HERE, WHICH IS WORTH SAYING
 * BECAUSE IT IS NOT INDEPENDENT IN `price-cross-check.ts`. That check refuses to
 * run when the primary venue IS the reference venue, and it is right to: a venue
 * cannot corroborate its own PRICES. But this check is not asking whether a
 * number is correct. It is asking whether any trading happened, and the failure
 * being detected is a property of ONE TRANSPORT -- a WebSocket subscription that
 * stopped delivering. REST on the same venue is not the same channel, does not
 * share the subscription, and cannot fail in the same way. For a Kraken account
 * this is therefore the ideal reference rather than a compromised one.
 *
 * ---------------------------------------------------------------------------
 * ⚠ OBSERVE, DON'T GATE -- entry 92's rule, inherited unchanged
 * ---------------------------------------------------------------------------
 * A finding here never withholds a price, halts a bot, or restarts a feed. It
 * writes one standing row and returns a finding. A feed this check believes dead
 * may simply be on a pair whose REST and WebSocket views disagree about what a
 * minute is, and restarting a working feed on that basis would replace a
 * reporting problem with a risk one.
 *
 * ---------------------------------------------------------------------------
 * ⚠ THIS CHECK'S OWN FAILURES SAY NOTHING ABOUT THE FEED
 * ---------------------------------------------------------------------------
 * Unreadable candles, an unreachable feed, a pair the venue does not list --
 * each is a `skipped` outcome carrying its reason, and `observed` goes false.
 * A skip raises nothing AND resolves nothing, because closing a live row on the
 * strength of an outage is the section 5.6 mistake committed on the alert table.
 */

import { raiseStandingAlert, resolveClearedStandingAlerts, standingAlertKey } from "../alerts";
import type { Database } from "../db";
import type { ExchangeOutcome } from "../shared/downtime";
import type { Candle, Pair, Timestamp } from "../shared/exchange-client";

/** The alert this check owns. */
export const FEED_SUBSCRIPTION_SILENT_ALERT = "price_feed_subscription_silent";

export function feedSilenceSource(accountLabel: string): string {
  return `feed-silence:${accountLabel}`;
}

/**
 * How long a feed may forward nothing before this check asks the venue about it.
 *
 * ⚠ DELIBERATELY LONGER THAN `PRICE_STALENESS_MS` (10 minutes), and the ordering
 * matters. This is the SECOND opinion on a condition the bot-side check has
 * already declined to alert about, so firing it sooner would recreate the false
 * positive one layer further out -- an alert surface saying "quiet market" in
 * two different voices.
 *
 * 15 minutes is also comfortably longer than the longest gap a HEALTHY Kraken
 * feed has been measured producing. Step 14 put the worst case between two
 * forwards at ~130s on a liquid pair; the overnight SOLUSDT episode that
 * prompted this work ran to 11 minutes. Fifteen is past both, so a feed silent
 * for this long on a pair that DID trade is not explicable by cadence.
 *
 * The threshold is not doing the detection, which is the whole point of this
 * module: it only decides when the question is worth asking. The answer comes
 * from the venue.
 */
export const FEED_SILENCE_MS = 900_000;

/**
 * How far back the reference read looks for signs of life.
 *
 * Matched to `FEED_SILENCE_MS` rather than set independently: the question is
 * "did the market trade during the window this feed forwarded nothing", and a
 * window that did not cover the silence would be answering a different one.
 */
export const REFERENCE_WINDOW_MS = FEED_SILENCE_MS;

export type FeedSilenceStatus =
  /** The feed forwarded recently. Nothing to ask. */
  | "forwarding"
  /** Silent, and the venue agrees nothing traded. Correct behaviour. */
  | "quiet"
  /** Silent while the venue traded. The subscription is not delivering. */
  | "silent"
  /** No verdict was reachable. Raises nothing, resolves nothing. */
  | "skipped";

export interface FeedSilenceOutcome {
  readonly pair: Pair;
  readonly status: FeedSilenceStatus;
  /** How long the feed has forwarded nothing, when that is known. */
  readonly silentForMs?: number;
  /** Candles the reference venue reports WITH VOLUME inside the window. */
  readonly activeCandles?: number;
  /** Total volume across those candles, as a decimal string for the message. */
  readonly reason?: string;
}

function skip(pair: Pair, reason: string): FeedSilenceOutcome {
  return { pair, status: "skipped", reason };
}

/**
 * What the feed looks like from outside, narrowed to what this check reads.
 *
 * A subset of `PriceFeedStatus` rather than the whole thing, so this module can
 * be driven from plain data in a test and never has to construct a Durable
 * Object. The runner passes the real status straight in.
 */
export interface FeedSnapshot {
  readonly connected: boolean;
  readonly stopped: boolean;
  readonly subscriberCount: number;
  readonly lastForwardAt: number | null;
}

/**
 * The whole decision, as a pure function of two observations.
 *
 * Separated from the I/O for the reason `evaluateCrossCheck` is: every
 * interesting case here is a combination of "how long has the feed been quiet"
 * and "what was the market doing", and contriving each one through a live feed
 * and a live venue would test the fixtures rather than the rule.
 *
 * ⚠ `activeCandles` COUNTS CANDLES WITH VOLUME, NOT CANDLES. Kraken's OHLC
 * endpoint returns a row for a minute in which nothing traded -- the same
 * zero-volume row `#trackFrozenValue` keys its own detector off. Counting rows
 * would find "activity" in every quiet minute and fire this alert constantly on
 * exactly the thin pairs it was built to stop bothering people about.
 */
export function evaluateFeedSilence(
  pair: Pair,
  feed: FeedSnapshot,
  candles: readonly Candle[],
  now: Timestamp,
  silenceMs: number = FEED_SILENCE_MS,
): FeedSilenceOutcome {
  if (feed.stopped || feed.subscriberCount === 0) {
    // A feed nobody is subscribed to is SUPPOSED to forward nothing. Its socket
    // is closed on purpose and its silence is the design working.
    return skip(pair, "the feed has no subscribers, so forwarding nothing is correct");
  }

  if (feed.lastForwardAt === null) {
    // Never forwarded anything. Real, but not distinguishable from a feed that
    // started moments ago, and this module holds no start time to measure
    // against -- inventing one from the first pass that noticed would restart on
    // every eviction. `price_updates_stale` covers a bot in this state.
    return skip(pair, "the feed has never forwarded a candle, so there is no silence to time");
  }

  const silentForMs = now - feed.lastForwardAt;
  if (silentForMs < silenceMs) {
    return { pair, status: "forwarding", silentForMs };
  }

  // ⚠ ONLY CANDLES INSIDE THE SILENCE ITSELF. A candle that closed BEFORE the
  // feed's last forward was, by definition, not missed by it -- counting one
  // would report a feed as broken for failing to send something it had already
  // sent, which is how a detector earns a reputation for crying wolf.
  const active = candles.filter(
    (candle) => candle.openTime > feed.lastForwardAt! && candle.volume > 0n,
  );

  if (active.length === 0) {
    return { pair, status: "quiet", silentForMs, activeCandles: 0 };
  }

  return { pair, status: "silent", silentForMs, activeCandles: active.length };
}

export interface FeedSilencePorts {
  /** The live feed's own view of itself, per pair. */
  readonly feedStatus: (pair: Pair) => Promise<FeedSnapshot | null>;
  /**
   * The venue's own candles over the window, read over REST.
   *
   * A DIFFERENT TRANSPORT from the feed being judged; see this file's header on
   * why that makes the same venue an acceptable reference here and not in
   * `price-cross-check.ts`.
   */
  readonly referenceCandles: (
    pair: Pair,
    since: Timestamp,
  ) => Promise<ExchangeOutcome<readonly Candle[]>>;
}

export interface FeedSilenceRequest {
  readonly accountLabel: string;
  /** Distinct pairs with at least one RUNNING bot on them. */
  readonly pairs: readonly Pair[];
  readonly at: Timestamp;
}

export interface FeedSilenceResult {
  readonly accountLabel: string;
  readonly outcomes: readonly FeedSilenceOutcome[];
  /** Whether any pair reached a real verdict. Feeds the standing-alert gate. */
  readonly observed: boolean;
  readonly raised: readonly Pair[];
  readonly resolved: readonly string[];
}

/** One pair's line in the alert message. */
function silentLine(outcome: FeedSilenceOutcome): string {
  return (
    `${outcome.pair} (silent ${Math.round((outcome.silentForMs ?? 0) / 60_000)} min while the ` +
    `venue's own REST candles show ${outcome.activeCandles} minute(s) of real trading)`
  );
}

export function feedSilenceMessage(silent: readonly FeedSilenceOutcome[]): string {
  return (
    `price feed subscription appears to have stopped delivering: ${silent.map(silentLine).join("; ")}. ` +
    `The socket is connected and heartbeating, so price_feed_blind cannot see this, and the feed ` +
    `has forwarded no candles for price_feed_value_frozen to count. Every bot on these pairs is ` +
    `evaluating its stop-loss and take-profit against a price that has stopped arriving, and its ` +
    `own price_updates_stale check will correctly stay quiet because the feed is not delivering ` +
    `to anyone. Re-subscribing the feed is the remedy: stop and resume one bot on the pair.`
  );
}

/**
 * Ask, per pair, whether a silent feed is quiet or broken, and alert on broken.
 *
 * Mirrors `runPriceCrossCheck`'s shape deliberately -- one standing row per
 * account, every affected pair named in the message, `observed` gating the
 * resolve half -- because it is the same lifecycle and a second spelling of it
 * would be a second thing to keep right.
 */
export async function runFeedSilenceCheck(
  db: Database,
  newId: () => string,
  ports: FeedSilencePorts,
  request: FeedSilenceRequest,
): Promise<FeedSilenceResult> {
  const source = feedSilenceSource(request.accountLabel);
  const outcomes: FeedSilenceOutcome[] = [];
  const raised: Pair[] = [];
  let observedAny = false;

  for (const pair of request.pairs) {
    let feed: FeedSnapshot | null;
    try {
      feed = await ports.feedStatus(pair);
    } catch (error) {
      outcomes.push(
        skip(pair, `the feed could not be asked (${(error as Error).message})`),
      );
      continue;
    }

    if (feed === null) {
      outcomes.push(skip(pair, "no feed is running for this market"));
      continue;
    }

    // Decided WITHOUT the reference read when the feed is plainly forwarding, so
    // the common case costs no venue call at all. A pass over six pairs on a
    // healthy account makes zero REST requests.
    const dry = evaluateFeedSilence(pair, feed, [], request.at);
    if (dry.status !== "silent" && dry.status !== "quiet") {
      outcomes.push(dry);
      if (dry.status === "forwarding") observedAny = true;
      continue;
    }

    const since = Math.min(feed.lastForwardAt!, request.at - REFERENCE_WINDOW_MS);
    const candles = await ports.referenceCandles(pair, since);
    if (!candles.ok) {
      // ⚠ THE CHECK'S OWN CONNECTIVITY, NOT THE FEED'S. Nothing raised, nothing
      // resolved -- a REST outage is not evidence that a WebSocket is healthy
      // any more than it is evidence that it is broken.
      outcomes.push(
        skip(
          pair,
          `the venue's REST candles could not be read (${candles.kind}: ${candles.message}), ` +
            `so there is nothing to tell a quiet market from a dead subscription`,
        ),
      );
      continue;
    }

    const outcome = evaluateFeedSilence(pair, feed, candles.value, request.at);
    outcomes.push(outcome);
    observedAny = true;
  }

  const silent = outcomes.filter((outcome) => outcome.status === "silent");

  if (silent.length > 0) {
    const wrote = await raiseStandingAlert(db, newId, {
      alertType: FEED_SUBSCRIPTION_SILENT_ALERT,
      // ACCOUNT-SCOPED. A dead subscription is a property of the FEED, and every
      // bot on the pair shares it -- a row per bot would multiply one fact by
      // the fleet, which is the trade `divergenceMessage` documents.
      botInstanceId: null,
      // Critical, matching `price_feed_value_frozen` and the divergence row. The
      // severity is about what the condition MEANS: every bot on the pair has
      // silently stopped evaluating its risk controls, and nothing else in the
      // system will say so.
      severity: "critical",
      category: "system",
      source,
      message: feedSilenceMessage(silent),
      at: request.at,
    });
    if (wrote) raised.push(...silent.map((outcome) => outcome.pair));
  }

  const stillOpen = new Set(
    silent.length > 0 ? [standingAlertKey(FEED_SUBSCRIPTION_SILENT_ALERT, null)] : [],
  );

  const resolved = await resolveClearedStandingAlerts(db, {
    source,
    owns: (alertType) => alertType === FEED_SUBSCRIPTION_SILENT_ALERT,
    stillOpen,
    observed: observedAny,
    scope: { kind: "source" },
  });

  return { accountLabel: request.accountLabel, outcomes, observed: observedAny, raised, resolved };
}
