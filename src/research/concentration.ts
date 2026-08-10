/**
 * The over-concentration FLAG for section 21.4 Stage 1's third bullet.
 *
 * Section 21 as a whole is still PLANNED, NOT YET BUILT -- no pipeline, no
 * prompt, no proposal record, no Workers AI call, no Assess stage, no Derive
 * stage. This module is one more piece of Stage 1's deterministic groundwork:
 * given a candidate this account might get a bot for, it reads `bot_instances`
 * and states what the account is ALREADY holding that the candidate would add
 * to. No model is involved anywhere.
 *
 * ── IT IS A FLAG. IT IS NEVER A FILTER, AND IT NEVER BLOCKS ──
 *
 * 21.4: "This is a flag on the proposal for the human to weigh, presented
 * prominently, not a silent filter."
 *
 * So NOTHING here refuses a candidate, drops one, reorders one, or lowers a
 * score. There is no "too concentrated" return value that a caller could treat
 * as a rejection, and `assessCandidateSetConcentration` returns exactly one
 * result per candidate in the candidate's own order -- a caller that used this
 * to shorten a candidate list would have to do so deliberately and against the
 * grain of every type here. The two `ConcentrationError` codes are a blank field
 * and a failed read; neither is ever "this candidate is bad".
 *
 * That is a different shape from every other refusal in this folder
 * (`pair_not_tradable`, `interval_not_verified`, `not_covered`) and the
 * difference is deliberate: those answer "can this system honestly do this at
 * all", which is a fact about capability. This answers "should you want to",
 * which is a judgement, and 21.1 puts judgements on the human's side of the
 * boundary.
 *
 * ── FACTS FIRST, VERDICT SECOND (21.5 requirement 2) ──
 *
 * "The human must be able to verify the reasoning against the real source before
 * approving." Applied here, that means the result is not a boolean. Every
 * `ConcentrationResult` -- flagged or clean -- carries the counts, the exact
 * `bigint` money totals, the bot ids, the pairs held, the quote assets used, and
 * the policy that was applied, so a human can re-run the same `SELECT` and get
 * the same numbers. The flag's `statement` is a rendering OF those facts, never
 * a substitute for them.
 *
 * Bot ids specifically: "3 existing bots on BTCUSD" is checkable only if you can
 * go and look at which three.
 *
 * ── THE THRESHOLDS ARE POLICY, NOT FINDINGS ──
 *
 * See `DEFAULT_CONCENTRATION_POLICY`. 21.4 names the two cases and gives no
 * numbers; the numbers below are chosen, not derived, and they are in one named
 * constant for exactly the reason `VERIFIED_INTERVALS` and
 * `DERIVATIVE_NAME_SUFFIXES` are: a change to what this system believes should
 * appear in a diff.
 *
 * ── WHAT IS REUSED RATHER THAN REBUILT ──
 *
 *   * `Candidate` / `CandidateSet` from `candidates.ts`, by import. This module
 *     declares no pair, account or exchange type of its own and does not
 *     re-resolve the account: the candidate already carries an `accountLabel`
 *     and `exchange` that `resolveAccount` read from the registry, and reading
 *     them again here would be a second answer to a settled question.
 *   * `db.botInstances` (`Repository`) for the read -- the only sanctioned path
 *     to D1 (`no-raw-d1.test.ts`), so the money columns arrive through
 *     `CAST(... AS TEXT)` / `fromStorageString` and are exact past 2^53.
 *   * TWO RULES from `dashboard/src/accountTotals.ts` (step 25), taken as rules
 *     rather than as code -- that module is dashboard-side, folds a `Bot[]`
 *     already fetched over HTTP, and touches no database, so there is nothing
 *     here it could have been called for:
 *       1. `stopped` bots are EXCLUDED from committed capital, because
 *          `releaseBotCapital` subtracts a closed bot's allocation from the
 *          ledger but LEAVES `bot_instances.allocated_capital` on the row as
 *          history. Summing every row reports returned capital as still
 *          committed, an overstatement that grows with every bot ever closed.
 *       2. GROUPED BY CAPITAL ASSET, ALWAYS. A share computed over a total that
 *          blended USD and USDT would be a percentage of nothing, and it would
 *          look completely normal.
 *     A stopped bot is not silently discarded, though: it is counted and
 *     reported separately, because `close` cancels orders and releases capital
 *     WITHOUT flattening the position (step 25's other finding), so a stopped
 *     bot can genuinely still hold inventory. That is exposure a human weighing
 *     concentration should see -- it is just not committed capital, and folding
 *     it into the percentage would misstate the denominator.
 *
 * ── ARCHIVED BOTS COUNT ──
 *
 * Step 26 settled this for the account totals and the same answer holds here:
 * `archived` is a view flag, orthogonal to `status`. An archived bot is
 * halted-or-stopped, not closed; it holds its allocation and may hold inventory.
 * A concentration figure that changed when someone flipped a dashboard toggle
 * would be step 25's silent omission in a new place. Pinned by a test.
 *
 * ── FAIL CLOSED, AND THE ONE DISTINCTION THAT MATTERS MOST ──
 *
 * A failed `bot_instances` read throws `bot_list_unreadable`. It does NOT return
 * a clean result. This is section 5.6's rule at the place it bites hardest: a
 * check whose whole purpose is to surface risk, reporting "no concentration"
 * because it could not look, hides exactly the risk it exists to catch, and the
 * proposal it feeds would read as reassuring.
 *
 * The three states are therefore kept apart, and every one is representable:
 *
 *   * the read FAILED                    -> throws `bot_list_unreadable`
 *   * the account has NO BOT ROWS AT ALL  -> clean, `rowsRead: 0`
 *   * it has rows, all of them `stopped`  -> clean, `rowsRead > 0`,
 *                                            `committedBots: 0`
 *
 * The last two are both "no concentration" and are not the same sentence -- the
 * same "quiet day versus broken check" distinction step 24's
 * `audit_empty_balance_set` and step 30's coverage variants each needed. And a
 * clean result is a VARIANT (`assessment: "no_concentration"`), not an empty
 * flag array: the flagged variant's `flags` is a non-empty tuple, so "flagged
 * with nothing to show" cannot be constructed, which is `news.ts`'s covered-with-
 * zero-articles trick one module over.
 */

import type { Database } from "../db";
import type { BotStatus, ExchangeId } from "../db/schema";
import type { Pair, Timestamp } from "../shared/exchange-client";
import {
  ONE,
  ZERO,
  divideRounded,
  toDecimalString,
  toTrimmedString,
  type Money,
} from "../shared/money";
import type { Candidate, CandidateSet } from "./candidates";

// ---------------------------------------------------------------------------
// The policy. JUDGEMENT CALLS, NOT VERIFIED FACTS.
// ---------------------------------------------------------------------------

/**
 * ── READ THIS BEFORE QUOTING EITHER NUMBER AS THOUGH IT MEANT SOMETHING ──
 *
 * 21.4 names two concentration cases and gives NO thresholds for either:
 *
 *   1. "proposing a third bot on a pair that already has two"
 *   2. "proposing more exposure to an asset the account is already heavily in"
 *
 * The numbers below are POLICY CHOICES, in the same category as
 * `VERIFIED_INTERVALS` (`candles.ts`) and `DERIVATIVE_NAME_SUFFIXES`
 * (`tradability.ts`): nothing has been verified against anything, no backtest
 * supports them, no market data was consulted, and no operator has yet said they
 * are the right numbers. They are here, named, in one place, so that changing
 * them is a visible edit rather than a tuning session.
 *
 * `samePairBotCountFlagAt: 2` -- flag when the candidate's pair ALREADY has this
 * many committed bots, so the proposal would be the third. That is 21.4's own
 * example read as a boundary rather than as an illustration, which is itself the
 * judgement: the spec says a third bot on a pair that has two is worth flagging,
 * and it does not say a second bot on a pair that has one is not. Two is the
 * looser of the two available readings of one sentence.
 *
 * `assetCapitalShareFlagAtPct: 40%` -- flag when committed capital already in
 * the candidate's base asset is at or above this share of the account's
 * committed capital IN THAT CAPITAL ASSET. The reasoning, such as it is: 21.3
 * bounds the watchlist at 5-10 coins, so the feature's own design assumes an
 * account spreading over several; at 40% one asset is more than two
 * equal-weight positions' worth of the book, which is the point at which "the
 * account is already heavily in" this asset stops being arguable. THAT IS AN
 * ARGUMENT, NOT EVIDENCE. A different operator would defend 25% or 60% just as
 * well, and on today's real testnet account -- 9 of 11 bots on `BTCUSD` -- any
 * threshold below about 80% fires identically, so the live data cannot
 * discriminate between candidate values either.
 *
 * THE COMPARISON IS "AT OR ABOVE" IN BOTH CASES, which the `FlagAt` in each
 * name is there to state. Exactly 2 bots flags. Exactly 40.00000000% flags.
 * That choice is arbitrary in the same way the numbers are, and it is tested at
 * the boundary in both directions precisely because it is arbitrary.
 */
export interface ConcentrationPolicy {
  /** Committed bots already on the candidate's pair, at or above which to flag. */
  readonly samePairBotCountFlagAt: number;
  /** Share of committed capital in the candidate's base asset, as a percent at SCALE. */
  readonly assetCapitalShareFlagAtPct: Money;
}

export const DEFAULT_CONCENTRATION_POLICY: ConcentrationPolicy = {
  samePairBotCountFlagAt: 2,
  assetCapitalShareFlagAtPct: 40n * ONE,
};

// ---------------------------------------------------------------------------
// Base assets: what this module can and cannot know
// ---------------------------------------------------------------------------

/**
 * ── A NAMING INFERENCE, NOT A VENUE STATEMENT ──
 *
 * 21.4's second case is about an ASSET ("more exposure to an asset the account
 * is already heavily in"), and `bot_instances` has NO base-asset column. It has
 * `pair` and `capital_asset`. So the two groupings this table can answer
 * exactly are BY PAIR and BY CAPITAL ASSET, and neither is the asset in
 * question:
 *
 *   * By pair, `BTCUSD` and `BTCUSDT` are two unrelated things when they are in
 *     fact the same BTC exposure twice.
 *   * By capital asset, every bot on the real testnet account is `USD`, so the
 *     share is 100% for every candidate forever. A flag that always fires is not
 *     a flag.
 *
 * `news.ts` already refused to split a pair -- "it does not derive `BTC` from
 * `BTCUSD`: Gemini's symbols are concatenated and separator-less, so splitting
 * one needs the venue's own symbol details, and a guess at the split point is
 * wrong for exactly the newly-listed, oddly-named coins 21.3's trending source
 * exists to surface." That refusal stands and this does not overturn it. What
 * this does is narrower and does not guess:
 *
 * The quote assets are not guessed, they are OBSERVED -- the distinct
 * `capital_asset` values on this account's own bots, plus any the caller states
 * (`selectGeneralCandidates` already takes `quoteAssets` from an operator). A
 * pair is split only when it ENDS IN one of those, longest first so `BTCUSDT`
 * strips `USDT` rather than turning into `BTCT`. A pair that ends in none of
 * them is NOT split, is NOT assumed, and is COUNTED as undetermined, so every
 * base-asset total that had one is reported as a floor rather than as a total.
 *
 * WHY IT IS SAFE HERE AND WOULD NOT BE ELSEWHERE: the output is a flag a human
 * reads, and the module cannot block, filter or order anything. A wrong split
 * therefore produces a sentence a human can see is wrong -- the report names the
 * suffix it stripped -- and never a refused pair, a skipped candidate, or an
 * order. `news.ts` is deciding what to ASK A VENDOR, where a wrong guess becomes
 * a false claim about coverage.
 *
 * KNOWN LIMITS, both real:
 *   * A venue writing `BTC-USD` splits to nothing and reports undetermined for
 *     every pair. Neither venue here does; both concatenate.
 *   * The strip is a string operation, so a base asset whose own ticker ends in
 *     a quote asset's letters would mis-split. `USDUSD` is the shape of it.
 *     Nothing in either catalogue looks like that today.
 */
export type BaseAssetResolution =
  | {
      readonly resolved: true;
      readonly baseAsset: string;
      /** Which quote asset was stripped, so the split can be checked. */
      readonly quoteStripped: string;
    }
  | {
      readonly resolved: false;
      readonly reason: "no_known_quote_suffix";
      /** Every quote asset that was tried, longest first. */
      readonly quotesTried: readonly string[];
    };

/**
 * Normalise a quote-asset list: trimmed, upper-cased, deduplicated, LONGEST
 * FIRST.
 *
 * The ordering is load-bearing, not tidiness. With `["USD", "USDT"]` in the
 * other order, `BTCUSDT` strips `USD` and yields a base asset of `BTCT`, which
 * groups with nothing and is wrong in a way no type check notices. Length
 * descending, then alphabetical so the order is stable across runs.
 */
function normaliseQuotes(quoteAssets: Iterable<string>): string[] {
  const seen = new Set<string>();
  for (const raw of quoteAssets) {
    const quote = raw.trim().toUpperCase();
    if (quote !== "") seen.add(quote);
  }
  return [...seen].sort((a, b) => b.length - a.length || a.localeCompare(b));
}

/**
 * Split a pair into its base asset, or report that it could not be split.
 *
 * `quotes` must already be `normaliseQuotes` output. The pair is upper-cased for
 * the comparison, which is a different act from the case-folding `checkTradable`
 * deliberately refuses: nothing here is matched against a venue catalogue and no
 * result is ever handed to an exchange, so this is a grouping key rather than a
 * symbol. `upper.length > quote.length` rather than `>=`, so a pair that IS its
 * own quote asset yields no base rather than an empty-string one.
 */
function resolveBaseAsset(pair: Pair, quotes: readonly string[]): BaseAssetResolution {
  const upper = pair.toUpperCase();
  for (const quote of quotes) {
    if (upper.length > quote.length && upper.endsWith(quote)) {
      return {
        resolved: true,
        baseAsset: upper.slice(0, upper.length - quote.length),
        quoteStripped: quote,
      };
    }
  }
  return { resolved: false, reason: "no_known_quote_suffix", quotesTried: quotes };
}

// ---------------------------------------------------------------------------
// What was read
// ---------------------------------------------------------------------------

/** One `bot_instances` row, reduced to the five fields concentration needs. */
export interface ExposureBot {
  readonly id: string;
  readonly pair: Pair;
  readonly capitalAsset: string;
  readonly allocatedCapital: Money;
  readonly status: BotStatus;
  readonly archived: boolean;
}

/**
 * One account's bot list as this check read it. The result of the ONE D1 query.
 *
 * Separate from the assessment so that a general run over fifteen candidates
 * costs one read rather than fifteen identical ones, and so the folding is a
 * pure function over a value a test can construct by hand. `rowsRead` is the
 * count BEFORE the stopped split, which is what makes "this account has never
 * had a bot" distinguishable from "every bot it has is stopped".
 */
export interface AccountExposure {
  readonly accountLabel: string;
  /** When the read happened. Not a render time (21.5 requirement 4's habit). */
  readonly readAt: Timestamp;
  readonly rowsRead: number;
  /** `status !== "stopped"`. See the module header on why. */
  readonly committed: readonly ExposureBot[];
  /** Reported, never folded into a percentage. See the module header. */
  readonly stopped: readonly ExposureBot[];
  /** Distinct `capital_asset` values observed, longest first. */
  readonly quoteAssetsObserved: readonly string[];
}

// ---------------------------------------------------------------------------
// What is reported
// ---------------------------------------------------------------------------

/** A pair this account holds committed bots on, and how many. */
export interface PairHolding {
  readonly pair: Pair;
  readonly bots: number;
}

/**
 * One capital asset's worth of concentration facts. Every money field is an
 * exact decimal string in `capitalAsset`; nothing is ever summed across two.
 */
export interface AssetConcentrationFacts {
  readonly capitalAsset: string;
  readonly bots: number;
  /** Committed capital in this asset, across every pair. The denominator. */
  readonly committed: string;

  readonly samePairBots: number;
  readonly samePairCommitted: string;
  /** Percent at SCALE, or null when there is no committed capital to divide by. */
  readonly samePairSharePct: string | null;

  /** Null throughout when the candidate's own base asset could not be resolved. */
  readonly baseAssetBots: number | null;
  readonly baseAssetCommitted: string | null;
  readonly baseAssetSharePct: string | null;

  /**
   * Committed bots in this asset whose OWN pair could not be split.
   *
   * Non-zero makes every `baseAsset*` figure above a FLOOR rather than a total:
   * one of those unsplittable pairs could be more of the candidate's base asset
   * and this module cannot tell. Counted rather than ignored for the reason
   * `accountTotals`' `Incompleteness` counts exist -- a total that quietly drops
   * a term still looks like a total.
   */
  readonly undeterminedBaseAssetBots: number;
}

/** Which of the two available denominators the asset signal actually used. */
export type AssetSignalBasis =
  /** The candidate's base asset, resolved by suffix strip. The intended one. */
  | "base_asset"
  /** The candidate's exact pair, because its base asset could not be resolved. */
  | "pair_only";

export type ConcentrationFlagCode =
  /** 21.4's first case: a third bot on a pair that already has two. */
  | "same_pair_bot_count"
  /** 21.4's second case: more exposure to an asset already heavily held. */
  | "asset_capital_share";

/**
 * One thing a human should weigh, stated as the fact plus the policy that made
 * it notable.
 *
 * `observed` and `threshold` are separate strings on purpose: a reader who
 * disagrees with the policy can still use the observation, and a reader who
 * trusts the policy can see what it was compared against without re-deriving
 * it. `statement` is a rendering of both and carries no information neither has.
 */
export interface ConcentrationFlag {
  readonly code: ConcentrationFlagCode;
  readonly observed: string;
  readonly threshold: string;
  readonly statement: string;
  /** Set on `asset_capital_share`; null on the count flag, which has one basis. */
  readonly basis: AssetSignalBasis | null;
  /** The capital asset this flag is about; null on the count flag. */
  readonly capitalAsset: string | null;
}

/** Everything both result variants carry. Verifiable facts, no verdict. */
export interface ConcentrationFacts {
  readonly accountLabel: string;
  readonly exchange: ExchangeId;
  readonly pair: Pair;
  readonly readAt: Timestamp;

  /** `bot_instances` rows for this account, before any status split. */
  readonly rowsRead: number;
  readonly committedBots: number;
  readonly stoppedBots: number;

  readonly samePairBots: number;
  readonly samePairBotIds: readonly string[];
  /**
   * Every distinct spelling the same-pair match actually hit, sorted.
   *
   * Normally exactly `[pair]`. The match is case-insensitive (see the fold), and
   * this is what stops that from being a silent merge: anything here other than
   * the candidate's own spelling means the upper-casing guarantee
   * `parseSymbolList` has held since step 3 has broken somewhere, and a human
   * reading the report can see it rather than trusting it.
   */
  readonly samePairSpellings: readonly Pair[];
  /**
   * Stopped bots on the candidate's pair, and their ids.
   *
   * Beside the committed count rather than inside it: a stopped bot may still
   * hold inventory (`close` does not flatten), so it is exposure worth seeing,
   * but its allocation has been returned to the ledger and counting it as
   * committed would overstate the account's book.
   */
  readonly samePairStoppedBots: number;
  readonly samePairStoppedBotIds: readonly string[];

  readonly baseAsset: BaseAssetResolution;
  readonly assetSignalBasis: AssetSignalBasis;
  /** Quote assets the split was attempted with: observed plus caller-stated. */
  readonly quoteAssetsConsidered: readonly string[];

  /** Every pair this account holds committed bots on, most bots first. */
  readonly pairsHeld: readonly PairHolding[];
  /** One entry per capital asset among the committed bots, most capital first. */
  readonly perAsset: readonly AssetConcentrationFacts[];

  /** The policy that was applied, echoed so the numbers are reconstructable. */
  readonly policy: ConcentrationPolicy;
}

/**
 * The answer. A VARIANT rather than a flag list, so "flagged with nothing to
 * show" is unrepresentable and a clean result is a positive statement rather
 * than the absence of one.
 *
 * Neither variant means "do not create this bot". See the module header.
 */
export type ConcentrationResult =
  | (ConcentrationFacts & { readonly assessment: "no_concentration" })
  | (ConcentrationFacts & {
      readonly assessment: "flagged";
      readonly flags: readonly [ConcentrationFlag, ...ConcentrationFlag[]];
    });

export type ConcentrationErrorCode =
  /** A blank account label or pair on the candidate. */
  | "missing_field"
  /** `bot_instances` could not be read, so concentration is UNKNOWN. */
  | "bot_list_unreadable";

/**
 * Takes an optional `ErrorOptions` third argument where the other error classes
 * in this folder take two. The one caller that uses it is the D1 catch below:
 * the message it builds is a long explanation of a policy, and the underlying D1
 * error is worth keeping as `cause` rather than folding entirely into prose.
 */
export class ConcentrationError extends Error {
  readonly code: ConcentrationErrorCode;
  constructor(code: ConcentrationErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ConcentrationError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// The read
// ---------------------------------------------------------------------------

/**
 * Read one account's bot list. THE ONLY I/O IN THIS MODULE.
 *
 * Filtered by `account_label` alone and not also by exchange, deliberately:
 * `accounts.account_label` is the primary key, `bot_instances.account_label`
 * references it, and the candidate's `exchange` was read from that same registry
 * row by `resolveAccount`. Adding `exchange` to the WHERE could therefore only
 * ever narrow the result by hiding rows whose exchange disagrees with the
 * registry -- which is a data inconsistency, and hiding it is the one thing a
 * concentration check must not do.
 *
 * Any failure becomes `bot_list_unreadable`. The `catch` is deliberately total:
 * this module cannot enumerate every way D1 fails, and the alternative to
 * catching broadly is a caller that gets a raw error from a check whose contract
 * is "never silently clean". The original is attached as `cause` so nothing is
 * lost.
 */
export async function readAccountExposure(
  db: Database,
  accountLabel: string,
  now: () => Timestamp,
): Promise<AccountExposure> {
  const label = requireText(accountLabel, "accountLabel");
  const readAt = now();

  let rows;
  try {
    rows = await db.botInstances.findMany({
      where: { account_label: label },
      // Stable, so two runs over the same table produce the same ids in the same
      // order and a human comparing two reports is comparing reports.
      orderBy: [
        { column: "created_at", direction: "asc" },
        { column: "id", direction: "asc" },
      ],
    });
  } catch (cause) {
    throw new ConcentrationError(
      "bot_list_unreadable",
      `could not read bot_instances for account ${JSON.stringify(label)}: ` +
        `${cause instanceof Error ? cause.message : String(cause)}. Refusing to report ` +
        `on concentration rather than reporting none: this check exists to surface ` +
        `exposure the account already has, so "could not look" reported as "nothing ` +
        `there" would hide the exact risk it was built to catch, in a proposal that ` +
        `would then read as reassuring (section 5.6; 21.5 requirement 6).`,
      { cause },
    );
  }

  const committed: ExposureBot[] = [];
  const stopped: ExposureBot[] = [];
  const assets = new Set<string>();

  for (const row of rows) {
    const bot: ExposureBot = {
      id: row.id,
      pair: row.pair,
      capitalAsset: row.capital_asset,
      allocatedCapital: row.allocated_capital,
      status: row.status,
      archived: row.archived,
    };
    assets.add(row.capital_asset);
    // Archived is NOT consulted. Step 26: it is a view flag, orthogonal to
    // status, and an archived bot still holds its allocation.
    if (row.status === "stopped") stopped.push(bot);
    else committed.push(bot);
  }

  return {
    accountLabel: label,
    readAt,
    rowsRead: rows.length,
    committed,
    stopped,
    quoteAssetsObserved: normaliseQuotes(assets),
  };
}

function requireText(value: string, field: string): string {
  const trimmed = value.trim();
  if (trimmed === "") {
    throw new ConcentrationError("missing_field", `${field} must not be blank`);
  }
  return trimmed;
}

// ---------------------------------------------------------------------------
// The fold. Pure.
// ---------------------------------------------------------------------------

/**
 * A share as a percent at SCALE, or null when there is nothing to divide by.
 *
 * Null rather than zero for a zero denominator, and that is the same rule as
 * everywhere else here: an account with no committed capital has no share of it,
 * and 0% would be a claim.
 */
function sharePct(part: Money, total: Money): string | null {
  if (total <= ZERO) return null;
  return toDecimalString(divideRounded(part * 100n * ONE, total, "half-even"));
}

/**
 * Whether `part` is at or above `flagAtPct` percent of `total`.
 *
 * Cross-multiplied, so the comparison is EXACT bigint integer arithmetic and no
 * rounding sits between the observation and the threshold. Rounding a share to
 * SCALE first and comparing that would make the boundary depend on a rounding
 * mode -- a value a hair under 40% rounding up to exactly 40.00000000 would flag
 * on a number it is not actually at.
 *
 * A non-positive total returns false rather than throwing: no committed capital
 * is not concentration, it is an empty book.
 */
function atOrAboveSharePct(part: Money, total: Money, flagAtPct: Money): boolean {
  if (total <= ZERO) return false;
  return part * 100n * ONE >= flagAtPct * total;
}

interface AssetAccumulator {
  capitalAsset: string;
  bots: number;
  committed: Money;
  samePairBots: number;
  samePairCommitted: Money;
  baseAssetBots: number;
  baseAssetCommitted: Money;
  undeterminedBaseAssetBots: number;
}

export interface AssessConcentrationOptions {
  /**
   * Quote assets to attempt the base-asset split with, ON TOP of the ones
   * observed on the account's own bots.
   *
   * Optional, and there is no default beyond the observed set: which quote
   * assets an account trades in is an operator's statement (the same one
   * `SelectGeneralCandidatesRequest.quoteAssets` already asks for), and
   * inventing one would mis-split a pair silently. Supplying it matters most for
   * the case the observed set cannot cover -- an account whose bots are all
   * `USD` being asked about a `USDT` candidate.
   */
  readonly quoteAssets?: readonly string[];
  readonly policy?: ConcentrationPolicy;
}

/**
 * Fold one candidate against one already-read bot list. Pure, no I/O.
 *
 * Exported because the composition a caller wants differs by entry point -- one
 * named candidate, or fifteen from a general run against the same read -- and
 * because a pure fold over a hand-built `AccountExposure` is the only way to
 * test the threshold boundaries without a database round trip per case.
 *
 * The candidate's `accountLabel` is checked against the exposure's rather than
 * trusted: assessing a candidate for one account against another account's bots
 * would produce a completely well-formed report about the wrong thing, which is
 * the shape of a wrong answer nobody can see.
 */
export function assessConcentration(
  exposure: AccountExposure,
  candidate: Candidate,
  options: AssessConcentrationOptions = {},
): ConcentrationResult {
  const policy = options.policy ?? DEFAULT_CONCENTRATION_POLICY;
  const accountLabel = requireText(candidate.accountLabel, "candidate.accountLabel");
  const pair = requireText(candidate.pair, "candidate.pair");

  if (accountLabel !== exposure.accountLabel) {
    throw new ConcentrationError(
      "missing_field",
      `candidate is for account ${JSON.stringify(accountLabel)} but the bot list was ` +
        `read for ${JSON.stringify(exposure.accountLabel)}. Assessing one account's ` +
        `candidate against another's bots would produce a well-formed report about ` +
        `the wrong account.`,
    );
  }

  const quotes = normaliseQuotes([
    ...exposure.quoteAssetsObserved,
    ...(options.quoteAssets ?? []),
  ]);
  const baseAsset = resolveBaseAsset(pair, quotes);
  const assetSignalBasis: AssetSignalBasis = baseAsset.resolved ? "base_asset" : "pair_only";

  const byAsset = new Map<string, AssetAccumulator>();
  const pairBots = new Map<Pair, number>();
  const samePairBotIds: string[] = [];
  const samePairSpellings = new Set<Pair>();
  const foldedPair = pair.toLowerCase();

  for (const bot of exposure.committed) {
    pairBots.set(bot.pair, (pairBots.get(bot.pair) ?? 0) + 1);

    let acc = byAsset.get(bot.capitalAsset);
    if (acc === undefined) {
      acc = {
        capitalAsset: bot.capitalAsset,
        bots: 0,
        committed: ZERO,
        samePairBots: 0,
        samePairCommitted: ZERO,
        baseAssetBots: 0,
        baseAssetCommitted: ZERO,
        undeterminedBaseAssetBots: 0,
      };
      byAsset.set(bot.capitalAsset, acc);
    }
    acc.bots += 1;
    acc.committed += bot.allocatedCapital;

    // CASE-INSENSITIVE, which is the opposite of `checkTradable`'s rule, and the
    // difference is deliberate rather than an oversight.
    //
    // There, the pair is about to be sent to an exchange, so an inexact match
    // would hand a venue a symbol it has to re-spell and the refusal exists to
    // tell the caller the venue's own spelling. Here the string is a GROUPING
    // KEY that never leaves this process. Both sides should already be
    // `parseSymbolList` output, upper-cased since step 3 -- but if that ever
    // stops being true, the two failure directions are not equally bad:
    //
    //   * folding when it was not needed over-counts a flag a human then weighs
    //     and dismisses, having been shown the spellings;
    //   * NOT folding when it was needed reports "0 existing bots on BTCUSD"
    //     while nine `btcusd` bots sit in the table, which is a false clean
    //     result -- exactly what the module header forbids.
    //
    // So it folds, and `samePairSpellings` reports every spelling it matched, so
    // an unexpected one is a visible fact rather than a silent merge.
    if (bot.pair.toLowerCase() === foldedPair) {
      acc.samePairBots += 1;
      acc.samePairCommitted += bot.allocatedCapital;
      samePairBotIds.push(bot.id);
      samePairSpellings.add(bot.pair);
    }

    if (!baseAsset.resolved) continue;
    const botBase = resolveBaseAsset(bot.pair, quotes);
    if (!botBase.resolved) {
      acc.undeterminedBaseAssetBots += 1;
      continue;
    }
    if (botBase.baseAsset === baseAsset.baseAsset) {
      acc.baseAssetBots += 1;
      acc.baseAssetCommitted += bot.allocatedCapital;
    }
  }

  const samePairStopped = exposure.stopped.filter(
    (bot) => bot.pair.toLowerCase() === foldedPair,
  );
  const samePairBots = samePairBotIds.length;

  const perAsset: AssetConcentrationFacts[] = [...byAsset.values()]
    // Sorted as bigint BEFORE rendering to strings, `accountTotals`' reason:
    // comparing decimal strings is a lexicographic comparison in a numeric
    // costume ("9" > "10").
    .sort((a, b) => {
      if (a.committed !== b.committed) return a.committed < b.committed ? 1 : -1;
      return a.capitalAsset.localeCompare(b.capitalAsset);
    })
    .map((acc) => ({
      capitalAsset: acc.capitalAsset,
      bots: acc.bots,
      committed: toDecimalString(acc.committed),
      samePairBots: acc.samePairBots,
      samePairCommitted: toDecimalString(acc.samePairCommitted),
      samePairSharePct: sharePct(acc.samePairCommitted, acc.committed),
      baseAssetBots: baseAsset.resolved ? acc.baseAssetBots : null,
      baseAssetCommitted: baseAsset.resolved ? toDecimalString(acc.baseAssetCommitted) : null,
      baseAssetSharePct: baseAsset.resolved
        ? sharePct(acc.baseAssetCommitted, acc.committed)
        : null,
      undeterminedBaseAssetBots: acc.undeterminedBaseAssetBots,
    }));

  const facts: ConcentrationFacts = {
    accountLabel,
    exchange: candidate.exchange,
    pair,
    readAt: exposure.readAt,
    rowsRead: exposure.rowsRead,
    committedBots: exposure.committed.length,
    stoppedBots: exposure.stopped.length,
    samePairBots,
    samePairBotIds,
    samePairSpellings: [...samePairSpellings].sort(),
    samePairStoppedBots: samePairStopped.length,
    samePairStoppedBotIds: samePairStopped.map((bot) => bot.id),
    baseAsset,
    assetSignalBasis,
    quoteAssetsConsidered: quotes,
    pairsHeld: [...pairBots.entries()]
      .map(([held, bots]) => ({ pair: held, bots }))
      .sort((a, b) => b.bots - a.bots || a.pair.localeCompare(b.pair)),
    perAsset,
    policy,
  };

  const flags = buildFlags(exposure, facts, byAsset, baseAsset, policy);
  const [first, ...rest] = flags;
  if (first === undefined) return { ...facts, assessment: "no_concentration" };
  return { ...facts, assessment: "flagged", flags: [first, ...rest] };
}

/**
 * The two signals, in the order 21.4 names them.
 *
 * The asset signal is emitted PER CAPITAL ASSET rather than once, so a flag
 * always names the currency its percentage is in. There is no blended figure to
 * emit even if one were wanted (step 25's rule).
 */
function buildFlags(
  exposure: AccountExposure,
  facts: ConcentrationFacts,
  byAsset: ReadonlyMap<string, AssetAccumulator>,
  baseAsset: BaseAssetResolution,
  policy: ConcentrationPolicy,
): ConcentrationFlag[] {
  const flags: ConcentrationFlag[] = [];

  if (facts.samePairBots >= policy.samePairBotCountFlagAt) {
    const ids = facts.samePairBotIds.map((id) => JSON.stringify(id)).join(", ");
    flags.push({
      code: "same_pair_bot_count",
      observed: `${facts.samePairBots} committed bots on ${JSON.stringify(facts.pair)}`,
      threshold: `${policy.samePairBotCountFlagAt} or more`,
      basis: null,
      capitalAsset: null,
      statement:
        `Account ${JSON.stringify(facts.accountLabel)} already has ${facts.samePairBots} ` +
        `committed bot${facts.samePairBots === 1 ? "" : "s"} on ` +
        `${JSON.stringify(facts.pair)} (${ids}), so this proposal would be number ` +
        `${facts.samePairBots + 1}. The configured policy flags at ` +
        `${policy.samePairBotCountFlagAt} or more; that number is a policy choice, not ` +
        `a verified limit (see DEFAULT_CONCENTRATION_POLICY).` +
        (facts.samePairSpellings.some((spelling) => spelling !== facts.pair)
          ? ` NOTE: the matched bots are spelled ` +
            `${facts.samePairSpellings.map((s) => JSON.stringify(s)).join(", ")}, which ` +
            `differs from the candidate's spelling in case only. They were counted, ` +
            `deliberately -- but both spellings should have come from the same ` +
            `upper-cased catalogue, so this is worth looking into.`
          : ``) +
        (facts.samePairStoppedBots > 0
          ? ` A further ${facts.samePairStoppedBots} stopped bot` +
            `${facts.samePairStoppedBots === 1 ? "" : "s"} on this pair ` +
            `${facts.samePairStoppedBots === 1 ? "is" : "are"} not counted above; ` +
            `stopped bots have returned their capital but may still hold inventory.`
          : ``),
    });
  }

  for (const acc of byAsset.values()) {
    const part = baseAsset.resolved ? acc.baseAssetCommitted : acc.samePairCommitted;
    const bots = baseAsset.resolved ? acc.baseAssetBots : acc.samePairBots;
    if (!atOrAboveSharePct(part, acc.committed, policy.assetCapitalShareFlagAtPct)) continue;

    const what = baseAsset.resolved
      ? `${baseAsset.baseAsset}-based pairs`
      : `${JSON.stringify(facts.pair)}`;
    const observed = `${sharePct(part, acc.committed) ?? "0"}% of committed ${acc.capitalAsset}`;
    flags.push({
      code: "asset_capital_share",
      observed,
      threshold: `${toTrimmedString(policy.assetCapitalShareFlagAtPct)}% or more`,
      basis: facts.assetSignalBasis,
      capitalAsset: acc.capitalAsset,
      statement:
        `${toTrimmedString(divideRounded(part * 100n * ONE, acc.committed, "half-even"))}% of ` +
        `account ${JSON.stringify(facts.accountLabel)}'s committed ${acc.capitalAsset} ` +
        `capital is already in ${what} -- ${toDecimalString(part)} of ` +
        `${toDecimalString(acc.committed)} ${acc.capitalAsset}, across ${bots} ` +
        `bot${bots === 1 ? "" : "s"}. The configured policy flags at ` +
        `${toTrimmedString(policy.assetCapitalShareFlagAtPct)}% or more; that number is a ` +
        `policy choice, not a verified limit (see DEFAULT_CONCENTRATION_POLICY).` +
        (baseAsset.resolved
          ? ` The base asset ${JSON.stringify(baseAsset.baseAsset)} was derived by ` +
            `stripping ${JSON.stringify(baseAsset.quoteStripped)} from ` +
            `${JSON.stringify(facts.pair)} -- a naming inference, not a venue statement.`
          : ` The candidate's base asset could not be determined from ` +
            `${JSON.stringify(facts.pair)} (tried ${baseAsset.quotesTried.join(", ") || "none"}), ` +
            `so this share is for that EXACT PAIR only and understates any exposure the ` +
            `account holds to the same asset under a different pair.`) +
        (acc.undeterminedBaseAssetBots > 0
          ? ` ${acc.undeterminedBaseAssetBots} committed bot` +
            `${acc.undeterminedBaseAssetBots === 1 ? "" : "s"} in this asset ` +
            `${acc.undeterminedBaseAssetBots === 1 ? "has a pair" : "have pairs"} that ` +
            `could not be split, so this figure is a FLOOR.`
          : ``) +
        (exposure.stopped.length > 0
          ? ` ${exposure.stopped.length} stopped bot` +
            `${exposure.stopped.length === 1 ? "" : "s"} account-wide ` +
            `${exposure.stopped.length === 1 ? "is" : "are"} excluded from both figures.`
          : ``),
    });
  }

  return flags;
}

// ---------------------------------------------------------------------------
// Composition: the two entry points 21.2 keeps identical
// ---------------------------------------------------------------------------

export interface ConcentrationPorts {
  readonly db: Database;
  readonly now: () => Timestamp;
}

/**
 * One candidate: read, then fold. For 21.2's named entry point, or for any
 * single-candidate caller.
 */
export async function checkCandidateConcentration(
  ports: ConcentrationPorts,
  candidate: Candidate,
  options: AssessConcentrationOptions = {},
): Promise<ConcentrationResult> {
  const exposure = await readAccountExposure(ports.db, candidate.accountLabel, ports.now);
  return assessConcentration(exposure, candidate, options);
}

/** A candidate set's results, in the set's own order, plus the read behind them. */
export interface CandidateSetConcentration {
  readonly exposure: AccountExposure;
  /** One per candidate, in `CandidateSet.candidates` order. Never filtered. */
  readonly results: readonly ConcentrationResult[];
}

/**
 * A whole `CandidateSet`: ONE read, one result per candidate.
 *
 * Works unchanged for both of 21.2's entry points because it takes the shape
 * they share -- a named run is a `CandidateSet` with one candidate and this does
 * not know or care which door it came through, which is 21.2's rule ("not two
 * code paths, not two prompt sets, not two proposal formats") holding here by
 * construction rather than by discipline.
 *
 * `results` has exactly `candidates.length` entries, in order, with no filtering
 * of any kind. A candidate whose concentration is flagged is still in the list,
 * in its own position: this is a flag, never a filter (module header).
 *
 * The `AccountExposure` is returned alongside so a proposal can show the read it
 * was derived from -- 21.5 requirement 2's "the actual raw data it used", and the
 * `readAt` requirement 4 times things from.
 */
export async function assessCandidateSetConcentration(
  ports: ConcentrationPorts,
  set: CandidateSet,
  options: AssessConcentrationOptions = {},
): Promise<CandidateSetConcentration> {
  const exposure = await readAccountExposure(ports.db, set.accountLabel, ports.now);
  return {
    exposure,
    results: set.candidates.map((candidate) => assessConcentration(exposure, candidate, options)),
  };
}
