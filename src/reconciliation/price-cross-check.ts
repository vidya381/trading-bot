/**
 * THE INDEPENDENT PRICE REFERENCE (spec 5.7; decision log entries 86 and 92).
 *
 * Entry 86 built three price-feed detectors and then wrote down, in PART 6, the
 * gap it could not close that night:
 *
 *   > Cross-checking the feed against the same venue's REST endpoint would NOT
 *   > have caught this. The sandbox's REST ticker reported the identical frozen
 *   > `78172.34`. Both sources agreed because BOTH WERE THE SAME FICTION. [...]
 *   > The real fix for that is a GENUINELY INDEPENDENT REFERENCE -- a second
 *   > venue, or a published index price. Not built tonight.
 *
 * This is that check. Kraken is the second venue (entries 90-96 wired it), and
 * `krakenPublicClient` reaches it with no credentials at all.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS CATCHES THAT THE THREE EXISTING DETECTORS CANNOT
 * ---------------------------------------------------------------------------
 * All three are SYMPTOM detectors, and each has a shape the fault must take:
 *
 *   * `price_feed_blind` / `price_updates_stale` -- liveness. A feed publishing
 *     a wrong price briskly is, to both of them, a healthy feed.
 *   * `price_feed_value_frozen` -- a value that does not move AND nothing
 *     trading. A wrong price that moves normally has neither property.
 *   * the crossed-book refusal -- a book that is arithmetically impossible. A
 *     wrong price with a sane bid/ask around it is not impossible, just wrong.
 *
 * So a feed that is simply WRONG -- fresh timestamps, uncrossed book, price
 * ticking along, describing a market that is not the one the bot thinks it is
 * trading -- passes all three. The only thing that can catch it is a number
 * from somewhere else. That is the entire content of this module.
 *
 * ---------------------------------------------------------------------------
 * ⚠ OBSERVE, DON'T GATE (entry 92's rule, applied here without exception)
 * ---------------------------------------------------------------------------
 * A divergence NEVER withholds a price from a bot, never halts one, never
 * refuses a parse. It writes one alert row and returns a finding. That is
 * deliberate and it is not timidity:
 *
 *   * The failure this catches is INDISTINGUISHABLE FROM THE CHECK ITSELF
 *     BREAKING. Kraken listing a pair under a name that resolves to a different
 *     market, a catalogue gone stale, a thin Kraken book on a pair that is
 *     liquid on the primary -- each produces the same divergence a broken feed
 *     does. Gating on it would let this file's own bugs stop a working bot.
 *   * A bot deprived of prices is not safe, it is BLIND. It stops updating its
 *     stop-loss and its trailing high-water mark while its position stays open.
 *     Entry 86 measured the cost of a wrong price; the cost of no price is worse
 *     and arrives faster.
 *   * The right response to "two venues disagree by 40%" is a human deciding
 *     which one is lying, which is what an alert is for.
 *
 * ---------------------------------------------------------------------------
 * ⚠ THIS CHECK'S OWN FAILURES ARE NOT EVIDENCE ABOUT THE PRIMARY FEED
 * ---------------------------------------------------------------------------
 * Kraken timing out says nothing whatsoever about Gemini's prices. Every way
 * this check can fail to reach an answer -- Kraken unreachable, the pair not
 * listed there, the primary read refused by the rate budget, a price too small
 * to compare at scale 8 -- produces a `skipped` outcome carrying its reason, and
 * `observed` goes false for that pair. A skip raises nothing AND resolves
 * nothing: `resolveClearedStandingAlerts`' `observed` flag exists for exactly
 * this, and closing a live divergence row because Kraken was down would be the
 * section 5.6 mistake ("a pass that could not reach the exchange found nothing
 * because it SAW nothing") committed on the alert table.
 */

import { raiseStandingAlert, resolveClearedStandingAlerts, standingAlertKey } from "../alerts";
import type { Database } from "../db";
import type { ExchangeId } from "../db/schema";
import type { ExchangeOutcome } from "../shared/downtime";
import { div, divideRounded, ONE, toTrimmedString, type Money } from "../shared/money";
import { normalisePairName } from "../exchange/kraken/catalogue";
import type { Pair, Price, Timestamp } from "../shared/exchange-client";

// ---------------------------------------------------------------------------
// The threshold, and how it was arrived at
// ---------------------------------------------------------------------------

/**
 * How far two venues may disagree before it is worth waking someone: **2%**.
 *
 * ⚠ MEASURED, NOT CHOSEN. Live Gemini and Kraken public tickers were sampled
 * together on 2026-09-04, seventeen pairs across two liquidity tiers, and the
 * divergence recorded for each. That distribution is what this constant sits
 * above:
 *
 * ```
 *   XRPUSD   0.008%     BONKUSD  0.097%     AVAXUSD  0.148%
 *   BTCUSD   0.011%     AAVEUSD  0.099%     PEPEUSD  0.193%
 *   SOLUSD   0.016%     SHIBUSD  0.151%     LTCUSD   0.197%
 *   DOGEUSD  0.034%     ETHUSD   0.200%     ATOMUSD  0.225%
 *   DOTUSD   0.230%     FILUSD   0.364%     LINKUSD  0.375%
 *   CRVUSD   0.430%     UNIUSD   0.647%
 * ```
 *
 * Worst observed: **0.647%** (UNIUSD). Every one of the seventeen came in under
 * 1%, which matches what cross-exchange arbitrage keeps true of any pair liquid
 * enough to run a bot on -- the two books are kept within a fraction of a
 * percent of each other by people whose whole job is that.
 *
 * 2% is therefore roughly **3x the worst normal reading**, which leaves room for
 * the things that legitimately widen a spread without anything being wrong: a
 * fast minute where two venues' last trades are seconds apart on a moving
 * market, a thin book on one side, a venue-specific listing event.
 *
 * ⚠ AND IT IS NOT A FINELY TUNED NUMBER, DELIBERATELY. The failure class this
 * exists for does not arrive at 2.1%. Entry 86's sandbox published `78172.34`
 * against a real BTC market -- **orders of magnitude** of divergence, not a
 * percentage point or two. Any threshold between "above spread noise" and
 * "below broken" catches that identically, so this is set where a false positive
 * is implausible rather than where the last basis point of sensitivity is
 * squeezed out. Tightening it would buy no detection and cost real alerts.
 */
export const DIVERGENCE_THRESHOLD: Money = divideRounded(2n * ONE, 100n, "exact");

/** `alerts.alert_type` for a primary feed that disagrees with the reference venue. */
export const PRICE_REFERENCE_DIVERGENCE_ALERT = "price_feed_reference_divergence";

/**
 * The `source` this check owns, per account.
 *
 * Its own string rather than reconciliation's `reconciliation:{account}`, so the
 * pass can use `StandingAlertScope.kind === "source"` -- which is documented for
 * exactly this case, "a writer whose source string is already account-qualified"
 * -- and cannot reach `reconciliation_blind` or any other writer's rows even by
 * accident.
 */
export function crossCheckSource(accountLabel: string): string {
  return `price-cross-check:${accountLabel}`;
}

/**
 * The environments this check runs in.
 *
 * ⚠ PRODUCTION ONLY, AND THE REASON IS ENTRY 86'S OWN FINDING. On testnet the
 * primary feed IS a simulator -- that is the whole subject of entry 86, and the
 * reason `SANDBOX_PRICE_WARNING` exists. Cross-checking a known-fictional feed
 * against the real market would diverge on every pair, every pass, forever, and
 * report as its conclusion a thing the operator was already told statically:
 * that the testnet venue is not the market. An alert surface that is wrong 100%
 * of the time in one environment is how the surface stops being read, which is
 * the same argument `#trackFrozenValue` makes for one row per incident.
 *
 * Environment-gated rather than condition-gated, and that follows entry 86 PART
 * 6's precedent verbatim: "the testnet venue is a simulator" is a STANDING
 * PROPERTY OF THE DEPLOYMENT, true whether or not any particular price is
 * currently wrong, so it is answered from `ENVIRONMENT` and not from the data.
 *
 * The cost is stated plainly, as entry 90 states its own: this check cannot be
 * exercised end-to-end outside production. What CAN be exercised outside
 * production is every decision it makes, because all of them live in
 * `evaluateCrossCheck` and `divergenceBetween`, which take numbers and return
 * verdicts and have never heard of an environment.
 */
export const CROSS_CHECK_ENVIRONMENTS: readonly string[] = ["production"];

export function crossCheckRunsIn(environment: string | undefined): boolean {
  return environment !== undefined && CROSS_CHECK_ENVIRONMENTS.includes(environment);
}

// ---------------------------------------------------------------------------
// The arithmetic
// ---------------------------------------------------------------------------

/**
 * The relative gap between two prices, against their MIDPOINT.
 *
 * Midpoint rather than "the reference is the denominator", for two reasons that
 * both matter. It is symmetric -- neither venue is declared correct, and this
 * check has no basis for declaring one, since a divergence is precisely the
 * state in which we do not know which number is the lie. And it is the
 * denominator the 2% threshold was MEASURED with, so the constant and the
 * arithmetic that reads it are on the same footing.
 *
 * `undefined` when the midpoint is zero, which is the only input this cannot
 * answer for. A caller turns that into a skip; there is no relative divergence
 * between two prices of nothing.
 */
export function divergenceBetween(a: Money, b: Money): Money | undefined {
  const sum = a + b;
  if (sum === 0n) return undefined;
  // `* 2n` before the divide, not a midpoint computed first: halving an odd sum
  // would discard a quantum before the ratio is taken, which is a rounding error
  // introduced by the check's own arithmetic in a function whose entire job is
  // measuring rounding-sized quantities.
  const gap = a > b ? a - b : b - a;
  return div(gap * 2n, sum, "half-up");
}

/**
 * How much of a divergence one unit of scale-8 rounding could account for.
 *
 * ⚠ THIS IS ENTRY 92 PART 3'S LESSON, APPLIED BEFORE IT COSTS ANYTHING. That
 * entry found the crossed-book detector -- built and verified against Gemini,
 * where no symbol prices below the money scale -- refusing `ANKRXBT`'s real book
 * forever, because two genuinely different prices six units apart at the tenth
 * decimal are IDENTICAL once rounded to `Money`. Its portable conclusion: *a
 * safety check built against one venue's typical price ranges can misfire
 * silently on another venue's real data, without either the check or the data
 * being wrong.*
 *
 * This check has that same exposure and it is arithmetically obvious once
 * looked for. Both prices arrive as `Money`, so each carries up to half a
 * quantum of rounding, and their difference carries up to a whole one. On BTC at
 * 80,760 a quantum is 1.2e-13 of the price and nothing could care less. On a
 * sub-satoshi listing it is not small: SHIB at 0.00000530 is 530 quanta, so ONE
 * unit of rounding is 0.19% -- a tenth of the threshold, from nothing but the
 * representation. Push the price another order of magnitude down and rounding
 * alone clears 2% while both venues agree perfectly.
 *
 * So the allowance is ADDED TO THE THRESHOLD rather than a floor being imposed
 * on which pairs may be checked. A floor would be a second arbitrary number and
 * would silently drop real, actively-traded meme-coin pairs from the check; this
 * is exact, derived per pair from the price itself, and it degrades in the safe
 * direction -- as a price approaches the scale limit the band widens until the
 * check declines to conclude anything (`evaluateCrossCheck` skips once the
 * allowance alone would exceed the threshold), which is honest rather than
 * either blind or noisy.
 */
export function quantumAllowance(a: Money, b: Money): Money | undefined {
  const sum = a + b;
  if (sum === 0n) return undefined;
  // One quantum, expressed against the same midpoint `divergenceBetween` uses.
  // Rounded UP: an allowance that under-states the representation's own error
  // is an allowance that lets rounding present as a finding.
  return div(1n * 2n, sum, "ceil");
}

// ---------------------------------------------------------------------------
// One pair's verdict
// ---------------------------------------------------------------------------

export type CrossCheckStatus = "agreed" | "diverged" | "skipped";

export interface CrossCheckOutcome {
  readonly pair: Pair;
  readonly status: CrossCheckStatus;
  /** Present when both prices were read. */
  readonly primaryPrice?: Money;
  readonly referencePrice?: Money;
  /** The measured gap, and the band it was measured against. Both present together. */
  readonly divergence?: Money;
  readonly allowed?: Money;
  /** Why nothing was concluded. Present exactly when `status` is `"skipped"`. */
  readonly reason?: string;
}

/**
 * Render a `Money` ratio as a percentage, for a message a human reads.
 *
 * A ratio is `Money` with `ONE` meaning 100%, so scaling by 100 moves it into
 * percentage points and `toTrimmedString` drops the padding. No rounding: at
 * scale 8 a ratio carries six decimal places of a percent, and a quantum
 * allowance of `0.000001%` is a number this module genuinely means.
 */
export function asPercent(ratio: Money): string {
  return `${toTrimmedString(ratio * 100n)}%`;
}

/**
 * Decide one pair, from two numbers. NO I/O, NO CLOCK, NO ENVIRONMENT.
 *
 * Every judgement this module makes is here, which is what lets the whole
 * decision surface be tested without a venue -- the same separation
 * `/src/reconciliation`'s header claims for the rest of the folder.
 */
export function evaluateCrossCheck(
  pair: Pair,
  primaryPrice: Money,
  referencePrice: Money,
): CrossCheckOutcome {
  const divergence = divergenceBetween(primaryPrice, referencePrice);
  const allowance = quantumAllowance(primaryPrice, referencePrice);
  if (divergence === undefined || allowance === undefined) {
    return {
      pair,
      status: "skipped",
      primaryPrice,
      referencePrice,
      reason:
        `both prices round to zero at scale 8 (primary ${toTrimmedString(primaryPrice)}, ` +
        `reference ${toTrimmedString(referencePrice)}), so there is no relative ` +
        `divergence to measure`,
    };
  }

  // The band this pair is judged against: the researched threshold, widened by
  // whatever the representation itself could account for. See `quantumAllowance`.
  const allowed = DIVERGENCE_THRESHOLD + allowance;

  if (allowance >= DIVERGENCE_THRESHOLD) {
    // The scale limit has swallowed the threshold. Anything this could report
    // would be indistinguishable from rounding, so it reports nothing -- and
    // says so, rather than returning "agreed" and implying a check happened.
    return {
      pair,
      status: "skipped",
      primaryPrice,
      referencePrice,
      divergence,
      allowed,
      reason:
        `prices this small cannot be cross-checked at scale 8: one unit of rounding ` +
        `is ${asPercent(allowance)} of ${toTrimmedString(referencePrice)}, which is at ` +
        `or above the ${asPercent(DIVERGENCE_THRESHOLD)} threshold, so a divergence and ` +
        `a rounding artefact would look identical (decision log entry 92 PART 3)`,
    };
  }

  return {
    pair,
    status: divergence > allowed ? "diverged" : "agreed",
    primaryPrice,
    referencePrice,
    divergence,
    allowed,
  };
}

/** A pair the check declined to conclude anything about, and why. */
function skip(pair: Pair, reason: string): CrossCheckOutcome {
  return { pair, status: "skipped", reason };
}

// ---------------------------------------------------------------------------
// The pass
// ---------------------------------------------------------------------------

/**
 * How the check reaches its two sources. Ports, for the reason every other port
 * in this folder exists: no test in this repository may fall through to a live
 * venue call.
 */
export interface CrossCheckPorts {
  /** The bot's own venue -- whichever exchange the account actually runs on. */
  readonly primaryPrice: (pair: Pair) => Promise<ExchangeOutcome<Price>>;
  /**
   * Which pairs the reference venue lists. Read ONCE per pass and reused, so a
   * ten-pair account costs one catalogue read rather than ten.
   */
  readonly referenceListing: () => Promise<ExchangeOutcome<readonly Pair[]>>;
  readonly referencePrice: (pair: Pair) => Promise<ExchangeOutcome<Price>>;
}

export interface CrossCheckRequest {
  readonly accountLabel: string;
  /** The venue the account trades on, which is also the venue being checked. */
  readonly primaryExchange: ExchangeId;
  /** The reference venue's id, for the alert message. `"kraken"` in practice. */
  readonly referenceExchange: ExchangeId;
  /** Distinct pairs with at least one RUNNING bot on them. */
  readonly pairs: readonly Pair[];
  readonly at: Timestamp;
}

export interface CrossCheckResult {
  readonly accountLabel: string;
  readonly outcomes: readonly CrossCheckOutcome[];
  /**
   * Whether this pass genuinely read both sources for at least one pair.
   *
   * Feeds `StandingAlertPass.observed`. False means the alert table is left
   * exactly as it was -- nothing raised, nothing resolved.
   */
  readonly observed: boolean;
  /**
   * The pairs named in an alert row this pass actually WROTE.
   *
   * Empty when a divergence was found but its incident was already open, which
   * is the difference between "first detection" and "still true" -- the
   * distinction `raiseStandingAlert` returns a boolean for.
   */
  readonly raised: readonly Pair[];
  /** Alert ids closed by this pass, because their divergence is gone. */
  readonly resolved: readonly string[];
}

/** One pair's line in the alert message: both prices, both venues, the gap. */
function divergenceLine(request: CrossCheckRequest, outcome: CrossCheckOutcome): string {
  return (
    `${outcome.pair} differs by ${asPercent(outcome.divergence!)} ` +
    `(${request.primaryExchange} ${toTrimmedString(outcome.primaryPrice!)} vs ` +
    `${request.referenceExchange} ${toTrimmedString(outcome.referencePrice!)}, ` +
    `band ${asPercent(outcome.allowed!)})`
  );
}

/**
 * The message an operator reads: every diverged pair, both prices, both venues.
 *
 * Everything needed to start deciding WHICH source is lying, in the row itself.
 * A message that said only "prices diverge" would send someone to two exchange
 * websites before they had the first fact.
 *
 * ⚠ ONE ROW PER INCIDENT, AND THE KNOWN COST OF THAT. The standing-alert key is
 * `(alert_type, bot_instance_id, source)` and this writer uses a null bot, so an
 * account has AT MOST ONE open divergence row and this message describes every
 * pair diverging AT THE MOMENT IT WAS WRITTEN. A pair that starts diverging
 * while that row is already open is therefore NOT named in it -- the row says
 * "this account's prices disagree with the reference", which stays true, but its
 * pair list can lag. That is the same trade `#trackFrozenValue` and
 * `auditBlindness` both take, for the reason entry 86 gives: a row per detection
 * would be 288 rows a day per pair, "which is how an alert surface stops being
 * read". The findings returned by this pass are always complete and current;
 * only the persisted row's prose can trail.
 */
export function divergenceMessage(
  request: CrossCheckRequest,
  diverged: readonly CrossCheckOutcome[],
): string {
  const lines = diverged.map((outcome) => divergenceLine(request, outcome)).join("; ");
  const subject =
    diverged.length === 1
      ? `${diverged[0]!.pair} is priced differently`
      : `${diverged.length} pairs are priced differently`;
  return (
    `${subject} on ${request.primaryExchange} than on ${request.referenceExchange}, ` +
    `by more than ordinary cross-exchange spread: ${lines}. The band is a ` +
    `${asPercent(DIVERGENCE_THRESHOLD)} threshold -- measured against live ` +
    `cross-exchange spreads, which run well under 1% on any pair liquid enough to ` +
    `trade -- plus each price's scale-8 rounding allowance. ` +
    `${request.primaryExchange} is the feed account ${request.accountLabel}'s bots are ` +
    `trading on, and NOTHING HAS BEEN WITHHELD FROM THEM: they are still receiving and ` +
    `acting on the ${request.primaryExchange} price (spec 5.7; decision log entry 92's ` +
    `observe-don't-gate rule). This feed will look healthy to every other check -- ` +
    `fresh timestamps, an uncrossed book, a price that moves -- because being WRONG is ` +
    `not one of the conditions they test for. Either one venue is wrong about this ` +
    `market, or the two names refer to different markets. Decide which before trusting ` +
    `the price again.`
  );
}

/**
 * Run the cross-check for one account and reconcile its alert rows.
 *
 * The order is: read the reference listing once, then per pair read both sides,
 * evaluate, and collect. Alerts are raised for divergences and resolved for
 * pairs that were CHECKED and agreed -- never for pairs that were skipped, whose
 * absence from the findings means "not looked at", not "no longer true".
 */
export async function runPriceCrossCheck(
  db: Database,
  newId: () => string,
  ports: CrossCheckPorts,
  request: CrossCheckRequest,
): Promise<CrossCheckResult> {
  const source = crossCheckSource(request.accountLabel);
  const outcomes: CrossCheckOutcome[] = [];
  const raised: Pair[] = [];

  // The reference venue cannot check itself. Not an error and not a gap worth
  // alerting on -- a Kraken account's prices ARE the reference, and comparing a
  // number to itself would report perfect agreement on every pass, which is a
  // green light this system has not earned and must not display.
  if (request.primaryExchange === request.referenceExchange) {
    return {
      accountLabel: request.accountLabel,
      outcomes: request.pairs.map((pair) =>
        skip(
          pair,
          `account ${request.accountLabel} trades on ${request.primaryExchange}, which is ` +
            `the reference venue itself; a venue cannot independently corroborate its own ` +
            `prices, so there is no cross-check to run`,
        ),
      ),
      observed: false,
      raised: [],
      resolved: [],
    };
  }

  const listing = await ports.referenceListing();
  if (!listing.ok) {
    // ⚠ THE CHECK'S OWN CONNECTIVITY, NOT THE FEED'S. Nothing is raised and
    // nothing is resolved. See this file's header.
    return {
      accountLabel: request.accountLabel,
      outcomes: request.pairs.map((pair) =>
        skip(
          pair,
          `the ${request.referenceExchange} catalogue could not be read ` +
            `(${listing.kind}: ${listing.message}), so no reference price is available. ` +
            `This says nothing about the ${request.primaryExchange} feed.`,
        ),
      ),
      observed: false,
      raised: [],
      resolved: [],
    };
  }

  // Normalised, because `BTC/USD`, `btc-usd` and `BTCUSD` are one market and a
  // bot's stored pair need not be spelled the way Kraken's catalogue spells it.
  // `normalisePairName` is the venue module's own rule, reused rather than
  // re-derived -- it is the function that knows no Kraken pair name contains a
  // `.`, so stripping punctuation cannot merge two distinct markets.
  const listed = new Set(listing.value.map((pair) => normalisePairName(pair)));

  let observedAny = false;

  for (const pair of request.pairs) {
    if (!listed.has(normalisePairName(pair))) {
      // ⚠ ROUTINE, AND EXPLICITLY NOT AN ALERT. Not every pair a bot trades is
      // listed on the reference venue, and there is nothing wrong with one that
      // is not -- the two venues simply carry different markets. Recorded so a
      // pass can say which pairs it could not corroborate, because "no alert"
      // and "not checked" must not look the same to anyone reading the result.
      outcomes.push(
        skip(
          pair,
          `not listed on ${request.referenceExchange}, so there is no independent price ` +
            `to compare against. Not a fault: the two venues carry different markets.`,
        ),
      );
      continue;
    }

    const [primary, reference] = await Promise.all([
      ports.primaryPrice(pair),
      ports.referencePrice(pair),
    ]);

    if (!primary.ok) {
      // The PRIMARY read failing is also not evidence of a wrong price -- and it
      // is already covered: a feed this system cannot read is what
      // `price_feed_blind` and `reconciliation_blind` exist to report. A second
      // row saying the same thing in different words is noise.
      outcomes.push(
        skip(
          pair,
          `the ${request.primaryExchange} price could not be read ` +
            `(${primary.kind}: ${primary.message}), so there was nothing to compare`,
        ),
      );
      continue;
    }

    if (!reference.ok) {
      outcomes.push(
        skip(
          pair,
          `the ${request.referenceExchange} reference price could not be read ` +
            `(${reference.kind}: ${reference.message}). This says nothing about the ` +
            `${request.primaryExchange} feed.`,
        ),
      );
      continue;
    }

    const outcome = evaluateCrossCheck(pair, primary.value.price, reference.value.price);
    outcomes.push(outcome);
    // A skip from `evaluateCrossCheck` is still an un-answered question, so it
    // does not count as an observation even though both reads succeeded.
    if (outcome.status !== "skipped") observedAny = true;
  }

  const diverged = outcomes.filter((outcome) => outcome.status === "diverged");

  if (diverged.length > 0) {
    const wrote = await raiseStandingAlert(db, newId, {
      alertType: PRICE_REFERENCE_DIVERGENCE_ALERT,
      // ACCOUNT-SCOPED, NOT BOT-SCOPED. The condition is a property of the
      // PAIR's price, and every bot on that pair shares it, so a row per bot
      // would multiply one fact by the fleet. Every affected pair is named in
      // the message instead -- see `divergenceMessage` for what that costs.
      botInstanceId: null,
      // Critical, matching `price_feed_value_frozen`. The severity is about what
      // the condition MEANS, not about what this check does with it: every bot on
      // the pair is sizing entries and evaluating stop-losses against a number
      // that a second venue says is wrong, which is the same exposure the frozen
      // detector reports and is not a warning-shaped fact.
      severity: "critical",
      category: "system",
      source,
      message: divergenceMessage(request, diverged),
      at: request.at,
    });
    if (wrote) raised.push(...diverged.map((outcome) => outcome.pair));
  }

  const stillOpen = new Set(
    diverged.length > 0 ? [standingAlertKey(PRICE_REFERENCE_DIVERGENCE_ALERT, null)] : [],
  );

  const resolved = await resolveClearedStandingAlerts(db, {
    source,
    owns: (alertType) => alertType === PRICE_REFERENCE_DIVERGENCE_ALERT,
    stillOpen,
    // ⚠ THE LOAD-BEARING FLAG. False when no pair reached a verdict, so a pass
    // that could not reach Kraken leaves an open divergence row exactly where it
    // was rather than closing it on the strength of an outage.
    observed: observedAny,
    scope: { kind: "source" },
  });

  return {
    accountLabel: request.accountLabel,
    outcomes,
    observed: observedAny,
    raised,
    resolved,
  };
}
