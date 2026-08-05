/**
 * Section 9's three drift tiers, as pure logic.
 *
 * No I/O, no clock, no storage -- everything here is a function of a finding
 * and a threshold set, following the same rule as `/src/shared` and
 * `/src/strategies`. The orchestrator in `reconcile.ts` does the observing;
 * this file only decides what an observation means.
 *
 * ---------------------------------------------------------------------------
 * THE CLASSIFICATION RULE
 * ---------------------------------------------------------------------------
 * Section 9 describes the three tiers qualitatively and gives no thresholds
 * anywhere:
 *
 *   minor      "timing noise, e.g. a fill recorded a few seconds late"
 *   meaningful "a specific bot's believed position doesn't match reality"
 *   severe     "unexplained balance change, unexpected orders, suspected key
 *               compromise"
 *
 * Read carefully, those are not three points on one numeric scale. "Unexpected
 * orders" is listed under severe with no qualifier -- an order on the account
 * that this system cannot attribute to any bot is a severe event whether it is
 * for 0.001 BTC or 10 BTC, because the thing it evidences (something else is
 * trading this account) is the same size either way. Meanwhile a position
 * mismatch is meaningful, and the same mismatch observed two seconds after a
 * fill is merely a fill recorded late.
 *
 * So classification is two-stage, and the confirmed rule is:
 *
 *   1. The KIND of finding sets a FLOOR (`TIER_FLOOR` below).
 *   2. Magnitude, where a finding has one, may ESCALATE above that floor.
 *   3. Magnitude may NEVER lower a floor.
 *
 * Rule 3 is the load-bearing one. Without it, a small unexpected order
 * classifies as minor and gets auto-corrected and silently logged -- which is
 * precisely the event section 9 wants the account-wide circuit breaker for.
 *
 * ---------------------------------------------------------------------------
 * WHERE THE DEFAULT NUMBERS COME FROM
 * ---------------------------------------------------------------------------
 * They are chosen here, not taken from the spec, because the spec contains
 * none. They are deliberately conservative -- a false halt costs a human
 * review, a missed halt costs money -- and they are per-account configurable
 * so the testnet trial (section 17) can tune them against real observations
 * rather than leaving them at values nobody has tested.
 */

import type { DriftClassification } from "../db/schema";
import { ALERTING_TIERS, ORDER_STATE_DRIFT_KINDS } from "../shared/alert-types";
import { abs, ONE, ZERO, type Money } from "../shared/money";

/**
 * What kind of divergence was observed.
 *
 * The four marked INGESTED are not observed by reconciliation at all: they are
 * read out of the `alerts` table, where step 6's Durable Object wrote them and
 * where, until this step, nothing read them. See `INGESTED_ALERT_TYPES`.
 */
export type FindingKind =
  /** D1's mirror disagrees with the Durable Object's own state. */
  | "mirror_drift"
  /** An order left the book inside the timing window: section 9's "fill recorded late". */
  | "order_recently_terminated"
  /** The exchange and the bot disagree about an order's state or filled quantity. */
  | "order_state_drift"
  /** INGESTED. Step 6's `cancel_fill_discrepancy`: a fill raced a cancellation. */
  | "cancel_fill_discrepancy"
  /** INGESTED. Step 6's `cancel_failed`: an order may still be live after a halt. */
  | "cancel_failed"
  /** INGESTED. Step 6's `unknown_order_fill`: a fill for an order no bot placed. */
  | "unknown_order_fill"
  /** INGESTED. Step 6's `order_state_drift`: the state machine refused a fill. */
  | "reported_order_state_drift"
  /** An open order on the account that no bot on it will claim. */
  | "unknown_open_order"
  /** A balance change this system cannot explain from its own records. */
  | "balance_drift"
  /** sum(bot allocations) disagrees with capital_ledger.total_allocated. */
  | "ledger_allocation_drift"
  /** A grid bot holds base with no sell resting against any of it. */
  | "uncovered_held_inventory";

/**
 * The two links that tie `shared/alert-types.ts` -- which the DASHBOARD also
 * imports, and which therefore cannot import this file -- back to the real
 * unions here.
 *
 * Both are type assertions doing real work rather than documentation: renaming a
 * `FindingKind`, or dropping/renaming a `DriftClassification`, fails the Worker
 * typecheck at these two lines instead of silently emptying the dashboard's
 * drift-alert set and taking the "Apply missed fills" control off screen with no
 * other signal. `shared/alert-types.test.ts` covers the runtime half.
 */
export const ORDER_STATE_DRIFT_FINDING_KINDS: readonly FindingKind[] = ORDER_STATE_DRIFT_KINDS;

/** The tiers that raise an alert row. `minor` never does (section 9). */
export const ALERTING_DRIFT_TIERS: readonly DriftClassification[] = ALERTING_TIERS;

/**
 * The floor each kind carries, before any magnitude is considered.
 *
 * Every entry is an argument about section 9, so each is justified rather than
 * tabulated silently.
 */
export const TIER_FLOOR: Readonly<Record<FindingKind, DriftClassification>> = {
  // The mirror is derived data by definition (section 8.2 calls D1 "mirrored
  // from" the object). It being behind is the expected consequence of step 6's
  // deliberate write ordering -- object storage first, D1 second -- so a crash
  // in that gap produces exactly this and nothing is actually wrong on the
  // exchange. Auto-correcting it is the whole point.
  mirror_drift: "minor",

  // Section 9's own example of minor: "a fill recorded a few seconds late".
  // Detection decides whether an order qualifies, using `timingWindowMs`; by
  // the time a finding carries this kind, that judgement is already made.
  order_recently_terminated: "minor",

  // Section 9's own definition of meaningful: "a specific bot's believed
  // position doesn't match reality".
  order_state_drift: "meaningful",

  // Step 6's decision 3 left the position deliberately understating what the
  // bot holds, because a cancellation response carries no trade id to
  // deduplicate on, and said "reconciliation owns it". This is that ownership.
  // Meaningful and not minor: the bot's position is known to be wrong, which
  // is the definition above, and step 6 could not fix it.
  cancel_fill_discrepancy: "meaningful",

  // An order that may still be resting on the exchange for a bot that believes
  // it has halted. The bot will not manage it and nothing will cancel it.
  cancel_failed: "meaningful",

  // Section 9 lists "unexpected orders" under SEVERE, and a fill against an
  // order no bot recorded placing is the strongest form of that: something
  // placed an order on this account and it executed. Severe at any size.
  unknown_order_fill: "severe",

  // Step 6 raised this when the order state machine refused a fill
  // (`overfill`, `invalid_transition`, `invalid_quantity`) and halted the bot
  // itself. Meaningful: the bot is already halted, so the tier's action is
  // mostly a confirmation, but it must not be filed as noise.
  reported_order_state_drift: "meaningful",

  // Section 9's "unexpected orders", observed directly rather than via a fill.
  unknown_open_order: "severe",

  // Section 9's "unexplained balance change", and the ONLY kind whose tier is
  // genuinely a question of size.
  //
  // Minor as a floor, which looks surprising until you consider what a
  // near-zero residual actually is. This job reconstructs the expected balance
  // change from recorded trades, rounding notionals half-even at scale 8; the
  // exchange did its own arithmetic. A residual of a few satoshi is that
  // difference, plus any fee paid in a third asset that step 6 could not
  // convert. Treating every non-zero residual as meaningful would halt a bot
  // on rounding, every run, forever -- a false-positive machine, and the
  // fastest way to teach someone to ignore this system's alerts.
  //
  // So the numbers decide: below `meaningfulPct` it is noise (logged, no
  // alert), above it a bot's reality is in question, above `severePct` it is
  // section 9's "unexplained balance change" and the account is latched.
  balance_drift: "minor",

  // Step 5's open question 2 asked step 7 to check this, and said it is "the
  // only detector of a leaked reservation". It is an internal bookkeeping
  // disagreement, not an exchange one, so it never reaches severe by kind.
  ledger_allocation_drift: "meaningful",

  // A grid bot that has bought base and has no sell resting against any of it.
  // Nothing is MISCOUNTED here -- the position, the cost and the realized
  // profit are all correct -- which is why this is not a position-drift kind.
  // What is wrong is that the strategy has stopped managing what it bought: the
  // rung that was supposed to close that round trip is not on the exchange, and
  // section 6.2's replace-on-fill is the only thing that would ever put it
  // there. It cannot self-heal, because `decide` only places a ladder when
  // `placed` is false, so this state persists until a human acts.
  //
  // Meaningful rather than severe: the bot's stop-loss and breakout exits still
  // read `heldQuantity` directly and still cover the position, so this is a bot
  // needing attention rather than an account to latch. Reachable both from the
  // slot-collision bug this was written for AND from `applyMissedFills`, which
  // deliberately leaves rungs empty -- so it is a standing condition worth
  // detecting on its own, not a proxy for one defect.
  uncovered_held_inventory: "meaningful",
};

/**
 * How far magnitude is allowed to push each kind ABOVE its floor.
 *
 * This map was added after a test caught the original rule being wrong, and
 * the mistake is worth recording rather than quietly fixing.
 *
 * The first version let any finding escalate all the way to severe. That reads
 * fine until you notice what the denominator is for an ORDER-level finding: an
 * order's own quantity. A resting order that half-filled without the bot
 * hearing about it is a 50% divergence of that order -- so every ordinary
 * unrecorded fill escalated to severe and tripped the account-wide circuit
 * breaker. Meaningful would have become unreachable in practice, and the tier
 * separation section 9 draws would have collapsed into two tiers.
 *
 * The underlying error was treating one ratio as comparable across kinds when
 * the denominators are different things. "50% of one order" and "50% of the
 * account's balance" are not two points on one scale.
 *
 * So: section 9 says a position mismatch is meaningful and puts no size on it,
 * and it is honoured literally. The only tier section 9 describes with an
 * implicit size dimension is "unexplained balance change" -- and that is the
 * one kind whose amount and reference are the same asset at account scale.
 * It is therefore the only kind magnitude can carry to severe.
 *
 * Everything else reaches severe by KIND (the two unexpected-order cases) or
 * not at all.
 */
export const TIER_CEILING: Readonly<Record<FindingKind, DriftClassification>> = {
  // Both stores are this system's own. However wrong the mirror is, the
  // exchange is not involved and nothing is at risk there.
  mirror_drift: "meaningful",
  // A large unrecorded fill inside the timing window is worth promoting out of
  // "noise", but it is still one order on one bot.
  order_recently_terminated: "meaningful",
  // Section 9's own words, honoured literally.
  order_state_drift: "meaningful",
  cancel_fill_discrepancy: "meaningful",
  cancel_failed: "meaningful",
  reported_order_state_drift: "meaningful",
  // Bookkeeping between two of this system's own tables. A leaked reservation
  // is real and needs a human, but halting every bot on the account over it
  // would be a worse outcome than the mismatch.
  ledger_allocation_drift: "meaningful",
  // Bot-scoped, and its natural magnitude ("how much base is uncovered") is a
  // fraction of one bot's own position -- the denominator `TIER_CEILING` exists
  // to keep out of the escalation path. A bot holding all of its inventory
  // uncovered is 100% of a small thing, not an account-scale event.
  uncovered_held_inventory: "meaningful",
  // The one kind where magnitude means what the severe tier is about.
  balance_drift: "severe",
  // Already severe by kind; the ceiling is only ever reached from below.
  unknown_open_order: "severe",
  unknown_order_fill: "severe",
};

/**
 * Alert types written by step 6 that this job reads back and acts on.
 *
 * Step 6's deviations recorded that "section 9's reconciliation is relied on
 * by three paths here and does not exist yet. Those alerts currently go into a
 * table nobody reads automatically." This constant is the read side of that
 * loop.
 *
 * It is four entries, not three. `cancel_failed` was not on step 6's list of
 * three but describes the same class of problem -- this system's belief about
 * an order diverging from the exchange's -- and leaving it unread while
 * reading its three neighbours would have been an arbitrary line.
 */
export const INGESTED_ALERT_TYPES: Readonly<Record<string, FindingKind>> = {
  cancel_fill_discrepancy: "cancel_fill_discrepancy",
  cancel_failed: "cancel_failed",
  unknown_order_fill: "unknown_order_fill",
  order_state_drift: "reported_order_state_drift",
};

/**
 * A magnitude, as a ratio waiting to be taken.
 *
 * Kept as two Money values rather than a pre-divided fraction so the
 * comparison below can be exact. `amount / reference` at scale 8 would round,
 * and a threshold comparison that rounds is a threshold that is occasionally
 * the wrong side of itself.
 */
export interface Magnitude {
  /** The size of the divergence. Signed; only its absolute value is used. */
  readonly amount: Money;
  /**
   * What it is a divergence FROM.
   *
   * Must be the SAME ASSET as `amount`, at account scale. That constraint is
   * the whole reason `TIER_CEILING` exists: the first version of this file
   * accepted an order's own quantity here, and "50% of one order" is not
   * comparable to "50% of the account" however similar the two ratios look.
   *
   * In practice only `balance_drift` and `ledger_allocation_drift` can satisfy
   * it, which is why they are the only kinds `reconcile.ts` attaches a
   * magnitude to. Order-level findings are classified by kind alone.
   */
  readonly reference: Money;
}

export interface Finding {
  readonly kind: FindingKind;
  /** Whether the tier's action targets one bot or the whole account. */
  readonly scope: "bot" | "account";
  /** Null for account-scoped findings, which belong to no single bot. */
  readonly botInstanceId: string | null;
  /** Set on balance findings, null elsewhere. */
  readonly asset: string | null;
  /** Human-readable, and it ends up in the alert a person reads at 2am. */
  readonly detail: string;
  /** Absent where a finding has no meaningful size (an unknown order). */
  readonly magnitude?: Magnitude;
  /**
   * The `alerts.id` this finding was read from, when it came from step 6
   * rather than from an observation made this run. Set means: this run
   * consumed that alert, and will mark it resolved if the tier action lands.
   */
  readonly sourceAlertId?: string;
}

export interface ClassifiedFinding extends Finding {
  readonly tier: DriftClassification;
  /** The floor its kind carried, before magnitude. */
  readonly floor: DriftClassification;
  /** True when magnitude pushed it above its floor. */
  readonly escalated: boolean;
}

/**
 * Per-account tuning for the two magnitude thresholds and the timing window.
 *
 * Percentages are scale-8 Money holding the percentage itself, not a rate --
 * the same convention as `bot_instances.stop_loss_pct`, where 2.5% is
 * 250000000.
 */
export interface DriftThresholds {
  /** At or above this fraction of the reference, a `minor` floor becomes meaningful. */
  readonly meaningfulPct: Money;
  /** At or above this fraction, ANY finding becomes severe. */
  readonly severePct: Money;
  /**
   * How recently an order may have left the book for its disappearance to be
   * section 9's "fill recorded a few seconds late" rather than real drift.
   *
   * Read by detection in `reconcile.ts`, not by `classifyFinding` -- but it
   * belongs beside the other two, because all three are the same decision
   * (how much divergence is noise) expressed in different units.
   */
  readonly timingWindowMs: number;
}

/**
 * Defaults, chosen here because section 9 supplies none.
 *
 * `meaningfulPct` at 0.1%: below this, on a spot account, a residual is
 * overwhelmingly rounding, an unconverted fee, or a fill straddling the run
 * boundary. Above it, something moved that this system did not record.
 *
 * `severePct` at 2%: large enough that ordinary trading noise cannot reach it,
 * small enough that it fires long before an account is drained. Tripping the
 * breaker halts every bot on the account and requires a human to re-arm, so
 * this is deliberately not hair-trigger -- but note that the events section 9
 * actually names as severe (unexpected orders) reach that tier by KIND and do
 * not depend on this number at all.
 *
 * `timingWindowMs` at 60s: a comfortable multiple of the round trip to the
 * exchange plus one reconciliation pipeline, and well inside the 5-minute cron
 * interval, so a genuinely stuck order cannot hide inside the window.
 */
export const DEFAULT_DRIFT_THRESHOLDS: DriftThresholds = {
  meaningfulPct: ONE / 10n, // 0.1
  severePct: 2n * ONE, // 2.0
  timingWindowMs: 60_000,
};

const TIER_RANK: Readonly<Record<DriftClassification, number>> = {
  minor: 0,
  meaningful: 1,
  severe: 2,
};

/**
 * Is `|amount| / reference >= pct / 100`?
 *
 * Cross-multiplied rather than divided, so it is exact at every magnitude.
 * `pct` is scale-8 percent, so the right-hand side needs `100 * ONE` to match
 * scales: |a| / ref >= pct / (100 * 1e8)  <=>  |a| * 100 * 1e8 >= ref * pct.
 *
 * A non-positive reference means there is nothing to take a fraction OF. That
 * returns false rather than throwing: a divergence on an asset whose balance
 * is zero is real and is already at its kind's floor, and it must not be
 * silently promoted to severe by a degenerate ratio.
 */
export function exceedsFraction(amount: Money, reference: Money, pct: Money): boolean {
  if (reference <= ZERO) return false;
  return abs(amount) * 100n * ONE >= reference * pct;
}

/** Apply the two-stage rule. Pure. */
export function classifyFinding(
  finding: Finding,
  thresholds: DriftThresholds = DEFAULT_DRIFT_THRESHOLDS,
): ClassifiedFinding {
  const floor = TIER_FLOOR[finding.kind];
  const ceiling = TIER_CEILING[finding.kind];
  let tier: DriftClassification = floor;

  const magnitude = finding.magnitude;
  if (magnitude !== undefined) {
    if (exceedsFraction(magnitude.amount, magnitude.reference, thresholds.severePct)) {
      tier = "severe";
    } else if (
      TIER_RANK[floor] < TIER_RANK.meaningful &&
      exceedsFraction(magnitude.amount, magnitude.reference, thresholds.meaningfulPct)
    ) {
      tier = "meaningful";
    }
  }

  // Clamp to how far this KIND may be escalated. See TIER_CEILING: a ratio is
  // only comparable to a threshold when the denominator is the right thing to
  // be a fraction of, and for an order-level finding it is not.
  if (TIER_RANK[tier] > TIER_RANK[ceiling]) tier = ceiling;

  // Belt and braces for rule 3. The ceiling clamp above could in principle
  // push a tier BELOW its floor if the two maps ever disagreed, and a rule
  // that silently downgrades is exactly what rule 3 forbids. Kept so that
  // introducing a downgrade requires deleting this line deliberately.
  if (TIER_RANK[tier] < TIER_RANK[floor]) tier = floor;

  return { ...finding, tier, floor, escalated: TIER_RANK[tier] > TIER_RANK[floor] };
}

export function classifyAll(
  findings: readonly Finding[],
  thresholds: DriftThresholds = DEFAULT_DRIFT_THRESHOLDS,
): ClassifiedFinding[] {
  return findings.map((finding) => classifyFinding(finding, thresholds));
}

/**
 * The worst tier present, or null for a clean run.
 *
 * Null rather than a fourth value, which confirms step 4's open question 3:
 * `balance_snapshots.classification` stays nullable and NULL keeps meaning
 * "this run found no drift to classify". Section 9 names three drift classes
 * and has no word for a clean result, and inventing one would put a value in
 * the column that the spec does not define.
 */
export function highestTier(
  findings: readonly ClassifiedFinding[],
): DriftClassification | null {
  let best: DriftClassification | null = null;
  for (const finding of findings) {
    if (best === null || TIER_RANK[finding.tier] > TIER_RANK[best]) best = finding.tier;
  }
  return best;
}

export function tierRank(tier: DriftClassification): number {
  return TIER_RANK[tier];
}
