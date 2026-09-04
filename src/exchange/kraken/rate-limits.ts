/**
 * Kraken's rate-limit model, transcribed from the venue's own current documentation.
 *
 * Decision-log 90 PROBLEM 2 established that Kraken's model is structurally
 * different from Binance's, not numerically different, and separated the work
 * into its own session. This file is that session's transcription half: the
 * constants, and nothing that decides policy with them.
 *
 * ---------------------------------------------------------------------------
 * HOW THESE NUMBERS WERE VERIFIED (2026-09-03)
 * ---------------------------------------------------------------------------
 * Entry 89 PART 2 established that Kraken's own documentation can be wrong about
 * Kraken, so every figure below was re-read against the live sources on the date
 * above rather than carried over from entry 90's research. Marked per fact:
 *
 *   *(docs)*    docs.kraken.com/api/docs/guides/spot-rest-ratelimits and
 *               .../spot-ratelimits, fetched as raw markdown.
 *   *(support)* support.kraken.com article 206548367 (last updated 2026-08-10)
 *               and article 360045239571 (last updated 2025-12-11).
 *   *(live)*    A request actually made from this machine.
 *
 * Entry 90's tier tables and its Add/Edit/Cancel rows were CONFIRMED unchanged.
 * What this pass corrected or added is marked ⚠ below and recorded in the
 * decision log; nothing was silently adjusted.
 *
 * ---------------------------------------------------------------------------
 * ⚠ WHAT THIS FILE DELIBERATELY DOES NOT MODEL
 * ---------------------------------------------------------------------------
 * 1. ~~**The batch-cancel escape hatch.**~~ **NOW MODELLED**, by the session
 *    below this header's own date -- see `krakenBatchCancelCost` and
 *    `KRAKEN_BATCH_CANCEL_MAX_IDS` at the foot of this file. It did not need a
 *    new `RestExchangeClient` method after all: it needed an OPTIONAL capability
 *    (`BatchCancellingClient` in `shared/exchange-client.ts`), because neither
 *    Binance nor Gemini has an endpoint that cancels a named SET of orders and
 *    forcing them to stub one would have been a lie with a signature.
 * 2. ~~**The open-order ceiling.**~~ **NOW MODELLED**, by the session below
 *    this header's own date -- see `KRAKEN_OPEN_ORDER_CEILINGS` at the foot of
 *    this file. It is still a LEVEL, not a rate, and the distinction survives
 *    the modelling: the number lives here beside the tier tables it is keyed by,
 *    and is read by a CREATION-TIME check, never by `DecayingCounter`, `Budget`
 *    or anything else that depletes and recovers. Routing it through the rate
 *    limiter would have been the one wrong answer -- a ceiling that does not
 *    decay cannot be waited out, so a gate that queued against it would queue
 *    forever.
 */

/**
 * Kraken's account verification tiers.
 *
 * ⚠ The two sources disagree on which tiers exist. *(docs)* lists Starter,
 * Intermediate and Pro. *(support)*, despite being the more recently updated
 * page, lists only "Standard (formerly Intermediate)" and "Verified with higher
 * limits (formerly Pro)" and has NO Starter row at all. The developer docs are
 * taken as authoritative for the tier set, because they are the page the API
 * itself is documented from and they are the only one that still describes the
 * entry-level tier an unverified account actually sits in.
 */
export type KrakenTier = "starter" | "intermediate" | "pro";

/**
 * The tier this system assumes until a real account says otherwise.
 *
 * ⚠ CHOSEN, NOT OBSERVED. No real Kraken account exists yet, so no tier has been
 * confirmed. Starter is the most conservative REAL tier -- the smallest counter
 * and the slowest decay on both budgets -- which makes every cost model built on
 * it an over-estimate for any account that turns out to be higher, and never an
 * under-estimate. Over-estimating throttles; under-estimating gets the account
 * rate-limited mid-halt.
 *
 * This is a single constant precisely so that confirming the real tier is a
 * one-line change with a test that fails if the tables stop agreeing with it.
 */
export const KRAKEN_DEFAULT_TIER: KrakenTier = "starter";

// ---------------------------------------------------------------------------
// Budget 1 -- the REST call counter
// ---------------------------------------------------------------------------

export interface KrakenRestTier {
  /** Counter value at which the venue starts refusing. */
  readonly maxCounter: number;
  /** Units shed per second. */
  readonly decayPerSecond: number;
}

/**
 * The REST call counter, per tier *(docs)*. CONFIRMED identical to entry 90.
 *
 * ⚠ Two corrections to how entry 90 described this counter, neither of which
 * changes a number here:
 *
 * 1. It is **per API key**, not per account: *(docs)* "Each API key's counter is
 *    separate." Entry 90 called it account-wide, and the `RateLimiter` Durable
 *    Object is one per account. Those coincide only while an account holds
 *    exactly one key, which is what `credentials.ts` provides today. Two
 *    accounts sharing one key would be UNDER-counted, which is the unsafe
 *    direction, so it is asserted rather than assumed.
 * 2. The decay may be stepwise rather than continuous. The table says
 *    "-0.33/sec" but the prose says the counter "is reduced every couple of
 *    seconds". `DecayingCounter` models it continuously, which is the venue's
 *    published rate; the gate must therefore not treat sub-second recovery as
 *    something to rely on, and `DEFAULT_MAX_WAIT_MS` is derived from the drain
 *    horizon rather than from any single decay tick.
 */
export const KRAKEN_REST_TIERS: Readonly<Record<KrakenTier, KrakenRestTier>> = Object.freeze({
  starter: { maxCounter: 15, decayPerSecond: 0.33 },
  intermediate: { maxCounter: 20, decayPerSecond: 0.5 },
  pro: { maxCounter: 20, decayPerSecond: 1 },
});

/**
 * What one call adds to the REST counter.
 *
 * ⚠ ENTRY 90 NEVER RECORDED THESE, AND KRAKEN'S TWO SOURCES DISAGREE. Recorded
 * as a contradiction rather than resolved silently:
 *
 *   *(docs)*    "Ledger/trade history calls increase the counter by `2`. All
 *               other API calls increase this counter by `1` (except AddOrder,
 *               CancelOrder which operate on a different limiter)."
 *   *(support)* "Account history endpoints (Ledgers, TradesHistory,
 *               **ClosedOrders**) -- +4"; staking +1; all others +1; trading
 *               endpoints 0.
 *
 * They differ on the multiplier (2 vs 4) AND on the membership of the expensive
 * class: only the support page names `ClosedOrders`, and `ClosedOrders` is an
 * endpoint this client actually calls -- on the cancel path and on the status
 * path. So the disagreement is not academic here.
 *
 * **Charged at 4.** The higher of the two, from the only source that names the
 * endpoint at all. Over-charging costs throttling; under-charging spends a
 * counter of 15 twice as fast as the venue is counting it, on the exact path a
 * halt runs down. If the docs' 2 is later confirmed against a live 429, this is
 * the one constant to change.
 */
export const KRAKEN_REST_COUNTER_COSTS = Object.freeze({
  /**
   * A public market-data endpoint.
   *
   * *(docs)* the counter covers private endpoints; public ones are limited by IP
   * instead and are not counted at all, so the true value here is 0. Floored to
   * 1 for the same reason `MINIMUM_WEIGHT` floors Gemini's free call: a zero
   * leaves a path through the gate that is unmeasured, and one unit out of 15 is
   * a cheaper price than an ungated loop.
   */
  publicRequest: 1,
  /** `OpenOrders`, `BalanceEx`, `AddOrder`'s non-trading overhead, etc. */
  standardPrivate: 1,
  /** `Ledgers`, `TradesHistory`, `ClosedOrders`. See the contradiction above. */
  accountHistory: 4,
  /** `AddOrder` / `CancelOrder` charge the matching engine, not this counter. */
  trading: 0,
});

// ---------------------------------------------------------------------------
// Budget 2 -- the per-pair matching-engine counter
// ---------------------------------------------------------------------------

export interface KrakenTradingTier {
  /** Counter value at which the engine returns `EOrder:Rate limit exceeded`. */
  readonly threshold: number;
  /** Units shed per second. */
  readonly decayPerSecond: number;
}

/**
 * The trading-engine counter, per tier *(docs)*. CONFIRMED identical to entry 90.
 *
 * ONE COUNTER PER PAIR, and *(docs)* "the limits are agnostic of the API used,
 * i.e. there is a shared limit across REST, Websockets and FIX" -- so a future
 * WebSocket order path spends the same counter this gate is protecting.
 */
export const KRAKEN_TRADING_TIERS: Readonly<Record<KrakenTier, KrakenTradingTier>> =
  Object.freeze({
    starter: { threshold: 60, decayPerSecond: 1 },
    intermediate: { threshold: 125, decayPerSecond: 2.34 },
    pro: { threshold: 180, decayPerSecond: 3.75 },
  });

/** `Add Order`, fixed *(docs)*. Charged even if the order fails validation. */
export const KRAKEN_ADD_ORDER_COST = 1;

/**
 * The cancel price ladder *(docs)*, cheapest-last.
 *
 * | Transaction  | Fixed | <5s | <10s | <15s | <45s | <90s | <300s |
 * | Cancel Order |   -   | +8  |  +6  |  +5  |  +4  |  +2  |  +1   |
 *
 * CONFIRMED identical to entry 90's table. Cancel has NO fixed component, so a
 * cancel of an order that has rested 300 seconds or more costs the engine
 * counter nothing at all -- which is Kraken's deliberate incentive to leave
 * orders on the book, and is corroborated by *(support)*'s worked example
 * pricing "placed, then cancelled after 8 seconds" at 7 points: one for the add
 * plus six for the cancel, with no fixed cancel term anywhere in it.
 */
export const KRAKEN_CANCEL_AGE_COSTS: readonly { readonly underMs: number; readonly cost: number }[] =
  Object.freeze([
    { underMs: 5_000, cost: 8 },
    { underMs: 10_000, cost: 6 },
    { underMs: 15_000, cost: 5 },
    { underMs: 45_000, cost: 4 },
    { underMs: 90_000, cost: 2 },
    { underMs: 300_000, cost: 1 },
  ]);

/**
 * What a cancel costs when the order's age is not known.
 *
 * The most expensive rung. FAIL-CLOSED BY CONSTRUCTION: an unknown age must
 * never be cheaper than a known one, or "we could not look it up" becomes the
 * fastest way through the gate -- and the path most likely to lack a local
 * record is reconciliation, which cancels orders this system has lost track of.
 */
export const KRAKEN_CANCEL_COST_UNKNOWN_AGE = 8;

/**
 * How much younger than measured an order is assumed to be.
 *
 * `orders.created_at` is written when this system STARTS placing an order; the
 * engine's clock starts when it accepts one. Our measured age is therefore
 * always slightly LONGER than the true age, and every rung of the ladder above
 * gets cheaper with age -- so measuring naively under-charges, which is the
 * unsafe direction, and does so exactly at the boundaries.
 *
 * One second covers a placement round trip with room to spare. The cost is
 * over-charging an order that sits within a second of a boundary; the benefit is
 * that no order is ever charged a rung below the one the engine will use.
 *
 * ⚠ This is a correction for a measurement this system does not have, not a fix
 * for it. The real fix is to record Kraken's own `opentm` from the AddOrder
 * response and age from that. That is a client and schema change, and is left
 * out of this session deliberately.
 */
export const KRAKEN_AGE_SAFETY_MARGIN_MS = 1_000;

/**
 * The engine cost of cancelling an order of the given age.
 *
 * `ageMs` of `null` means "not known", and is charged the maximum. Ages are
 * biased younger by `KRAKEN_AGE_SAFETY_MARGIN_MS` before the ladder is walked.
 */
export function krakenCancelCost(ageMs: number | null): number {
  if (ageMs === null || !Number.isFinite(ageMs)) return KRAKEN_CANCEL_COST_UNKNOWN_AGE;

  // A negative age means the clock disagrees with itself; treat it as brand new
  // rather than as very old, which is the same fail-closed direction as `null`.
  const effective = Math.max(0, ageMs - KRAKEN_AGE_SAFETY_MARGIN_MS);

  for (const rung of KRAKEN_CANCEL_AGE_COSTS) {
    if (effective < rung.underMs) return rung.cost;
  }
  // Older than the last rung: the engine charges nothing for the cancel itself.
  return 0;
}

// ---------------------------------------------------------------------------
// Batch cancel -- the escape hatch, and its real price
// ---------------------------------------------------------------------------

/**
 * The most order ids one `CancelOrderBatch` request may name *(docs)*.
 *
 * "up to a maximum of 50 total unique IDs/references", and the cap is TOTAL
 * across the `orders` and `cl_ord_ids` arrays rather than per array. Verified
 * against Kraken's published OpenAPI document on 2026-09-04, where the sentence
 * appears on both fields' descriptions.
 *
 * Note this is a DIFFERENT number from `AddOrderBatch`'s, which is 2 to 15. The
 * two batch endpoints are not symmetric in any respect that matters here -- see
 * the cost function below for the other one.
 */
export const KRAKEN_BATCH_CANCEL_MAX_IDS = 50;

/**
 * The engine cost of cancelling several orders in one `CancelOrderBatch`.
 *
 * ---------------------------------------------------------------------------
 * ⚠ IT IS NOT `Add Order Batch`'s SHAPE, AND ASSUMING IT WERE WOULD UNDERCHARGE
 * ---------------------------------------------------------------------------
 * Entry 96 CORRECTION 3 recorded Batch Add at `+(n/2)` -- a genuine bulk
 * DISCOUNT, half price per order. The obvious guess is that Batch Cancel mirrors
 * it. It does not. Re-read from *(docs)*' own cost table on 2026-09-04 rather
 * than carried over:
 *
 * | Transaction  | Fixed  | <5s    | <10s   | <15s   | <45s   | <90s   | <300s  |
 * | Add Order    | +1     | --     | --     | --     | --     | --     | --     |
 * | Batch Add    | +(n/2) | --     | --     | --     | --     | --     | --     |
 * | Cancel Order | --     | +8     | +6     | +5     | +4     | +2     | +1     |
 * | Batch Cancel | --     | +(8xn) | +(6xn) | +(5xn) | +(4xn) | +(2xn) | +(1xn) |
 *
 * **Batch Cancel has NO per-order discount.** n orders cost exactly what n
 * separate cancels cost. Had this been assumed to mirror Batch Add's `n/2`, the
 * gate would have charged HALF what the venue charges, on the risk-exit path, on
 * the one counter entry 90's worst case is about -- undercharging, which is the
 * unsafe direction, by a factor of two.
 *
 * ---------------------------------------------------------------------------
 * WHY THE COST TAKES AGES AND NOT A COUNT
 * ---------------------------------------------------------------------------
 * The published rows are written `+(8xn)` because they price a batch whose
 * orders are all in one age band. A real halt's batch is not: a grid ladder laid
 * over several minutes holds rungs of different ages, and the venue's own table
 * gives each band a different multiplier. So the honest total is the SUM of each
 * order's own rung -- which reduces to exactly `8n` when every order is under
 * five seconds, and is never higher than the sum of the same orders cancelled
 * one at a time, because it IS that sum.
 *
 * `null` ages are charged `KRAKEN_CANCEL_COST_UNKNOWN_AGE` each, for the reason
 * `krakenCancelCost` charges them: an unknown age must never be the cheap way
 * through the gate. An EMPTY list costs 0 and is not an error here -- refusing an
 * empty batch is the caller's job (`KrakenClient.cancelOrderBatch` does refuse
 * it), and a cost function that threw would make the gate the place a caller
 * discovered its own bug.
 *
 * ---------------------------------------------------------------------------
 * ⚠ AND THE COUNTER IT CHARGES DOES NOT GATE IT
 * ---------------------------------------------------------------------------
 * *(docs)*, beside the Batch Cancel row: **"If the rate counter in the batch
 * exceeds maximum for a batch cancel, the requests in batch are still
 * accepted."** Re-confirmed live from the same page on 2026-09-04.
 *
 * So this number is what the venue's counter will REGISTER, not a threshold the
 * request must fit under. That distinction is the whole escape hatch, and it is
 * why `AcquireCost.trading` grew an `unconditional` flag: the charge must still
 * be recorded -- everything issued afterwards has to see the counter it left
 * behind -- and must never refuse or queue the batch itself.
 */
export function krakenBatchCancelCost(ageMs: readonly (number | null)[]): number {
  let total = 0;
  for (const age of ageMs) total += krakenCancelCost(age);
  return total;
}

// ---------------------------------------------------------------------------
// The open-order ceiling -- a LEVEL, not a rate
// ---------------------------------------------------------------------------

/**
 * The most orders that may REST on the book at once, per pair, per tier *(docs)*.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS IN THIS FILE BUT NOT IN THIS FILE'S MODEL
 * ---------------------------------------------------------------------------
 * Entries 96 and 98 both deferred this with the same one-line reason, and the
 * reason was right: it is a LEVEL, not a rate. It does not decay, so there is no
 * wait that clears it, so a `DecayingCounter` cannot represent it and a gate
 * that queued against it would queue forever. Nothing here is wired into
 * `AcquireCost`, `Budget`, or the `RateLimiter` Durable Object, and that is the
 * whole point of the separation.
 *
 * It lives in this file anyway because it is transcribed from the SAME
 * `docs.kraken.com/api/docs/guides/spot-ratelimits` page as the two tier tables
 * above, keyed by the SAME `KrakenTier`, on the SAME per-pair axis, and read
 * through the SAME `KRAKEN_DEFAULT_TIER`. Splitting one docs page across two
 * files to honour a distinction the code already honours would cost more than
 * it bought: the next person to confirm a real account's tier must find all
 * three tables, and they are all here.
 *
 * ---------------------------------------------------------------------------
 * HOW THESE NUMBERS WERE VERIFIED (2026-09-04)
 * ---------------------------------------------------------------------------
 * Re-read live from the docs page rather than carried over from entry 90's
 * research, per this file's standing rule:
 *
 *   *(docs)* "The open order limit is the maximum number of open orders **per
 *   pair**. When the open order threshold is reached, the engine will generate
 *   `EOrder:Orders limit exceeded` rejection message."
 *
 *   | | Starter | Intermediate | Pro |
 *   | Max open orders per pair | 60 | 80 | 225 |
 *
 * ⚠ THE SCOPE NEARLY WENT IN BACKWARDS, AND THE SECOND SOURCE IS WHY.
 * *(support)* article 209090607 (updated 2025-12-11) describes the same limit as
 * applying "across each trading pair" -- a phrase that reads just as naturally
 * as an ACCOUNT-WIDE total, and which a summarising read of that page returns as
 * "across all trading pairs combined". If that reading were right, a per-pair
 * ceiling would be the wrong shape entirely and every check built on it would be
 * measuring the wrong thing. The article's own worked example settles it the
 * other way, verbatim: "You have 78 buy limit orders BTC/EUR and 60 sell limit
 * orders on ETH/EUR ... you can place 2 more orders on BTC/EUR and 20 more open
 * orders on ETH/EUR ... On other pairs, you can place 80 orders each." 78+2=80,
 * 60+20=80, and 80 more on every other pair. PER PAIR, corroborated twice.
 *
 * That same *(support)* table is STALE in exactly the way entry 96 CORRECTION 4
 * found article 206548367 to be: it lists only "Verified" (80) and "Verified
 * with high limits" (225) and has no Starter row at all. It therefore
 * corroborates two of these three numbers and cannot corroborate the third,
 * which is stated here rather than glossed. The tier set is taken from *(docs)*,
 * for the same reason `KrakenTier` is.
 *
 * ---------------------------------------------------------------------------
 * ⚠ A SECOND DIMENSION, RECORDED BECAUSE IT IS CURRENTLY INERT AND WOULD NOT BE
 * ---------------------------------------------------------------------------
 * *(support)*, same article: **scheduled orders have their own separate ceiling
 * -- 25 (Verified) / 40 (Verified with high limits) -- AND they also count
 * toward the open-order limit above.** A scheduled order is defined there as one
 * "placed with a start time five seconds or more in the future".
 *
 * NOTHING IS BUILT FOR THIS, DELIBERATELY, because this client cannot create
 * one: `KrakenClient` never sends `starttm` on any path, so every order it
 * places is immediate and the scheduled ceiling is unreachable. It is written
 * down because that inertness is a property of the CLIENT, not of the venue --
 * the day any path sets `starttm`, this ceiling becomes live, it is tighter than
 * the one modelled below, and there is no error string in `parse.ts` and no
 * check anywhere that would catch it. Neither entry 90, 96 nor 98 recorded that
 * this second dimension exists; this comment is so the next person does not have
 * to rediscover it from the same support page.
 */
export const KRAKEN_OPEN_ORDER_CEILINGS: Readonly<Record<KrakenTier, number>> = Object.freeze({
  starter: 60,
  intermediate: 80,
  pro: 225,
});

/**
 * The open-order ceiling for one pair, at the tier this system assumes.
 *
 * Defaulted to `KRAKEN_DEFAULT_TIER` for the same reason every other figure in
 * this file is: no real Kraken account exists yet, Starter is the most
 * conservative REAL tier, and confirming the true tier must stay a one-line
 * change. Over-estimating the ceiling would be the unsafe direction here --
 * it is what lets a bot be created that the venue will later refuse mid-run --
 * so the default is the SMALLEST of the three, and `rate-limits.test.ts` asserts
 * that it is.
 */
export function krakenOpenOrderCeiling(tier: KrakenTier = KRAKEN_DEFAULT_TIER): number {
  return KRAKEN_OPEN_ORDER_CEILINGS[tier];
}
