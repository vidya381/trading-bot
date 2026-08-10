/**
 * The over-concentration flag: what it states, and what it refuses to state.
 *
 * Seven properties, each one this module would look correct without:
 *
 *  1. A FAILED `bot_instances` READ IS NEVER A CLEAN RESULT. This is the one
 *     violation that is invisible in the output: "no concentration" is a
 *     perfectly well-formed answer, and it is the answer that hides the exact
 *     risk this check exists to surface.
 *  2. "NO BOTS AT ALL" AND "EVERY BOT STOPPED" ARE BOTH CLEAN AND ARE NOT THE
 *     SAME SENTENCE -- step 24's `audit_empty_balance_set` distinction, step
 *     30's coverage variants, one module further on.
 *  3. THE THRESHOLDS ARE BOUNDARIES, AT THE VALUE AND ONE STEP EITHER SIDE. Both
 *     are "at or above"; an off-by-one is the bug this file exists to catch, and
 *     the money boundary is tested one satoshi out in both directions.
 *  4. STOPPED BOTS ARE EXCLUDED FROM THE FIGURES AND REPORTED BESIDE THEM. Step
 *     25: `releaseBotCapital` leaves `allocated_capital` on the row, so counting
 *     them overstates the book -- but `close` does not flatten, so discarding
 *     them silently hides inventory.
 *  5. ARCHIVED BOTS COUNT. Step 26 settled it for the account totals; a
 *     concentration figure that moved when a dashboard toggle flipped would be
 *     the same silent omission in a new place.
 *  6. NOTHING IS SUMMED ACROSS CAPITAL ASSETS, ever.
 *  7. IT IS A FLAG, NOT A FILTER. Every candidate comes back, in its own
 *     position, flagged or not.
 *
 * The base-asset split is a NAMING INFERENCE and is tested as one -- including
 * the case where it cannot be made, which must degrade to a stated exact-pair
 * figure and never to silence.
 *
 * The database is real (`freshDatabase`, the real migrations); the failed-read
 * case uses a stub that throws, because there is no way to make the real local
 * D1 fail on demand without dropping a table the migration bookkeeping would
 * then consider applied.
 */

import { beforeEach, describe, expect, it } from "vitest";

import {
  ConcentrationError,
  DEFAULT_CONCENTRATION_POLICY,
  assessCandidateSetConcentration,
  assessConcentration,
  checkCandidateConcentration,
  readAccountExposure,
  type AccountExposure,
  type ConcentrationPolicy,
  type ConcentrationResult,
} from "./concentration";
import type { Candidate, CandidateSet } from "./candidates";
import type { Database } from "../db/database";
import { ONE } from "../shared/money";
import { accountRow, botInstanceRow, freshDatabase } from "../db/test-helpers";

const T0 = 1_920_000_000_000;

let db: Database;
let clock: number;

beforeEach(async () => {
  db = await freshDatabase();
  await db.accounts.insert(accountRow({ account_label: "gemini-main", exchange: "gemini" }));
  await db.accounts.insert(accountRow({ account_label: "main", exchange: "binance" }));
  clock = T0;
});

const now = () => (clock += 1_000);

/** A candidate as `candidates.ts` builds one. Provenance is not what is tested here. */
function candidate(overrides: Partial<Candidate> = {}): Candidate {
  return {
    accountLabel: "gemini-main",
    exchange: "gemini",
    pair: "BTCUSD",
    sources: [
      { kind: "named", requestedAs: "BTCUSD", requestedBy: "owner@example.com", requestedAt: T0 },
    ],
    ...overrides,
  };
}

/** Insert one committed `gemini-main` bot. Money is Money: SCALE 8 bigint. */
async function bot(
  id: string,
  pair: string,
  allocated: bigint,
  overrides: Parameters<typeof botInstanceRow>[0] = {},
): Promise<void> {
  await db.botInstances.insert(
    botInstanceRow({
      id,
      account_label: "gemini-main",
      exchange: "gemini",
      pair,
      allocated_capital: allocated,
      capital_asset: "USD",
      status: "running",
      ...overrides,
    }),
  );
}

/** Only the same-pair count can fire. */
const COUNT_ONLY: ConcentrationPolicy = {
  samePairBotCountFlagAt: 2,
  // 101% is unreachable: a share cannot exceed the total it is a share of.
  assetCapitalShareFlagAtPct: 101n * ONE,
};

/** Only the asset share can fire. */
const SHARE_ONLY: ConcentrationPolicy = {
  samePairBotCountFlagAt: 99,
  assetCapitalShareFlagAtPct: 40n * ONE,
};

function codes(result: ConcentrationResult): string[] {
  return result.assessment === "flagged" ? result.flags.map((flag) => flag.code) : [];
}

async function assess(
  options: Parameters<typeof assessConcentration>[2] = {},
  which: Partial<Candidate> = {},
): Promise<ConcentrationResult> {
  const exposure = await readAccountExposure(db, "gemini-main", now);
  return assessConcentration(exposure, candidate(which), options);
}

// ---------------------------------------------------------------------------
// Property 1: a failed read is never a clean result
// ---------------------------------------------------------------------------

describe("a failed bot_instances read", () => {
  /** A `Database` whose only reachable method throws, as a real D1 outage would. */
  const unreadable = {
    botInstances: {
      findMany: async () => {
        throw new Error("D1_ERROR: Network connection lost");
      },
    },
  } as unknown as Database;

  it("throws bot_list_unreadable rather than reporting no concentration", async () => {
    await expect(readAccountExposure(unreadable, "gemini-main", now)).rejects.toThrow(
      ConcentrationError,
    );
    await expect(
      readAccountExposure(unreadable, "gemini-main", now),
    ).rejects.toMatchObject({ code: "bot_list_unreadable" });
  });

  it("says why, naming the risk of the alternative, and keeps the cause", async () => {
    let thrown: unknown;
    try {
      await readAccountExposure(unreadable, "gemini-main", now);
    } catch (caught) {
      thrown = caught;
    }
    expect(thrown).toBeInstanceOf(ConcentrationError);
    const error = thrown as ConcentrationError;
    expect(error.message).toContain("D1_ERROR: Network connection lost");
    expect(error.message).toContain("Refusing to report on concentration");
    expect(error.cause).toBeInstanceOf(Error);
  });

  it("refuses through the single-candidate entry point too", async () => {
    await expect(
      checkCandidateConcentration({ db: unreadable, now }, candidate()),
    ).rejects.toMatchObject({ code: "bot_list_unreadable" });
  });

  it("refuses through the candidate-set entry point too", async () => {
    const set: CandidateSet = {
      entryPoint: "general",
      accountLabel: "gemini-main",
      exchange: "gemini",
      requestedBy: "owner@example.com",
      selectedAt: T0,
      candidates: [candidate()],
      watchlist: null,
      trending: null,
    };
    await expect(
      assessCandidateSetConcentration({ db: unreadable, now }, set),
    ).rejects.toMatchObject({ code: "bot_list_unreadable" });
  });

  it("is a different outcome from the clean one, not a differently-worded one", async () => {
    // The pair of assertions that makes property 1 falsifiable: the same account
    // label, one read that works and one that does not, and the two must not
    // both produce a result object.
    const clean = await readAccountExposure(db, "gemini-main", now);
    expect(clean.rowsRead).toBe(0);
    await expect(readAccountExposure(unreadable, "gemini-main", now)).rejects.toBeInstanceOf(
      ConcentrationError,
    );
  });
});

// ---------------------------------------------------------------------------
// Property 2: clean, and legibly clean, in two different ways
// ---------------------------------------------------------------------------

describe("an account with nothing to be concentrated in", () => {
  it("reports no_concentration explicitly when it has no bot rows at all", async () => {
    const result = await assess();
    expect(result.assessment).toBe("no_concentration");
    expect(result).not.toHaveProperty("flags");
    expect(result.rowsRead).toBe(0);
    expect(result.committedBots).toBe(0);
    expect(result.stoppedBots).toBe(0);
    expect(result.samePairBots).toBe(0);
    expect(result.perAsset).toEqual([]);
    expect(result.pairsHeld).toEqual([]);
  });

  it("distinguishes 'never had a bot' from 'every bot is stopped'", async () => {
    const never = await assess();
    await bot("b1", "BTCUSD", 100n * ONE, { status: "stopped" });
    await bot("b2", "BTCUSD", 100n * ONE, { status: "stopped" });
    await bot("b3", "BTCUSD", 100n * ONE, { status: "stopped" });
    const allStopped = await assess();

    // Both clean -- and that is correct, because a stopped bot holds no
    // allocation. What must not be lost is that they are different situations.
    expect(never.assessment).toBe("no_concentration");
    expect(allStopped.assessment).toBe("no_concentration");
    expect(never.rowsRead).toBe(0);
    expect(allStopped.rowsRead).toBe(3);
    expect(allStopped.committedBots).toBe(0);
    expect(allStopped.stoppedBots).toBe(3);
    // And three stopped bots on the candidate's own pair is stated, not dropped.
    expect(allStopped.samePairStoppedBots).toBe(3);
    expect(allStopped.samePairStoppedBotIds).toEqual(["b1", "b2", "b3"]);
    expect(allStopped.samePairBots).toBe(0);
  });

  it("reports clean for a pair the account has never touched, while stating what it holds", async () => {
    await bot("b1", "BTCUSD", 500n * ONE);
    await bot("b2", "BTCUSD", 500n * ONE);
    const result = await assess({ policy: COUNT_ONLY }, { pair: "LINKUSD" });

    expect(result.assessment).toBe("no_concentration");
    expect(result.samePairBots).toBe(0);
    expect(result.committedBots).toBe(2);
    // The clean answer still carries the facts, so a human sees WHAT was checked.
    expect(result.pairsHeld).toEqual([{ pair: "BTCUSD", bots: 2 }]);
    expect(result.perAsset[0]?.committed).toBe("1000.00000000");
    expect(result.perAsset[0]?.samePairCommitted).toBe("0.00000000");
    expect(result.perAsset[0]?.samePairSharePct).toBe("0.00000000");
  });

  it("cannot reach a zero-capital asset group through the real table at all", async () => {
    // Migration 0001's `allocated_capital > 0` CHECK refuses the row outright, so
    // an asset group summing to zero is unreachable from a real read. Recorded as
    // a test rather than as a comment because it is the reason `sharePct`'s null
    // branch is exercised only by the pure fold below -- and the reason that
    // branch stays: it is a guard against a future migration, not dead code
    // covering a case the schema currently permits.
    await expect(bot("b1", "BTCUSD", 0n)).rejects.toThrow(/allocated_capital > 0/);
  });
});

// ---------------------------------------------------------------------------
// Property 3a: the same-pair count boundary
// ---------------------------------------------------------------------------

describe("the same-pair bot count signal", () => {
  it("does not fire one below the threshold", async () => {
    await bot("b1", "BTCUSD", 100n * ONE);
    const result = await assess({ policy: COUNT_ONLY });
    expect(result.samePairBots).toBe(1);
    expect(result.assessment).toBe("no_concentration");
  });

  it("fires exactly AT the threshold", async () => {
    await bot("b1", "BTCUSD", 100n * ONE);
    await bot("b2", "BTCUSD", 100n * ONE);
    const result = await assess({ policy: COUNT_ONLY });
    expect(result.samePairBots).toBe(2);
    expect(codes(result)).toEqual(["same_pair_bot_count"]);
  });

  it("fires above the threshold, and states the facts a human can check", async () => {
    await bot("b1", "BTCUSD", 100n * ONE);
    await bot("b2", "BTCUSD", 100n * ONE);
    await bot("b3", "BTCUSD", 100n * ONE);
    const result = await assess({ policy: COUNT_ONLY });
    expect(result.samePairBots).toBe(3);
    expect(result.samePairBotIds).toEqual(["b1", "b2", "b3"]);

    if (result.assessment !== "flagged") throw new Error("expected a flag");
    const flag = result.flags[0];
    expect(flag.code).toBe("same_pair_bot_count");
    expect(flag.observed).toBe('3 committed bots on "BTCUSD"');
    expect(flag.threshold).toBe("2 or more");
    // The statement carries the ids, so "3 existing bots on BTCUSD" is checkable
    // rather than merely assertive (21.5 requirement 2).
    expect(flag.statement).toContain('"b1", "b2", "b3"');
    expect(flag.statement).toContain("would be number 4");
    expect(flag.statement).toContain("policy choice, not a verified limit");
  });

  it("counts only the candidate's own pair", async () => {
    await bot("b1", "BTCUSD", 100n * ONE);
    await bot("b2", "ETHUSD", 100n * ONE);
    await bot("b3", "DOGEUSD", 100n * ONE);
    const result = await assess({ policy: COUNT_ONLY });
    expect(result.samePairBots).toBe(1);
    expect(result.committedBots).toBe(3);
    expect(result.assessment).toBe("no_concentration");
  });

  it("counts a differently-CASED spelling of the same pair, and names it", async () => {
    // Both sides should be `parseSymbolList` output, upper-cased since step 3, so
    // this should be unreachable. It is folded anyway because the two failure
    // directions are not equal: over-counting shows a human a flag they can
    // dismiss, while under-counting reports "0 bots on BTCUSD" with two btcusd
    // bots in the table -- a false clean result, which is the one thing this
    // module must not produce.
    await bot("b1", "btcusd", 100n * ONE);
    await bot("b2", "BTCUSD", 100n * ONE);
    const result = await assess({ policy: COUNT_ONLY });

    expect(result.samePairBots).toBe(2);
    expect(result.samePairSpellings).toEqual(["BTCUSD", "btcusd"]);
    if (result.assessment !== "flagged") throw new Error("expected a flag");
    // Folded, but never silently: the spelling is stated so the merge is visible.
    expect(result.flags[0].statement).toContain("differs from the candidate's spelling in case");
    expect(result.flags[0].statement).toContain('"BTCUSD", "btcusd"');
  });

  it("reports exactly one spelling when nothing unusual happened", async () => {
    await bot("b1", "BTCUSD", 100n * ONE);
    await bot("b2", "BTCUSD", 100n * ONE);
    const result = await assess({ policy: COUNT_ONLY });
    expect(result.samePairSpellings).toEqual(["BTCUSD"]);
    if (result.assessment !== "flagged") throw new Error("expected a flag");
    expect(result.flags[0].statement).not.toContain("in case only");
  });

  it("counts a case-variant stopped bot as a stopped bot on the pair", async () => {
    await bot("b1", "btcusd", 100n * ONE, { status: "stopped" });
    const result = await assess({ policy: COUNT_ONLY });
    expect(result.samePairStoppedBots).toBe(1);
    expect(result.samePairStoppedBotIds).toEqual(["b1"]);
  });

  it("does not reach the threshold on stopped bots, and says they are there", async () => {
    await bot("b1", "BTCUSD", 100n * ONE);
    await bot("b2", "BTCUSD", 100n * ONE, { status: "stopped" });
    await bot("b3", "BTCUSD", 100n * ONE, { status: "stopped" });
    const result = await assess({ policy: COUNT_ONLY });

    expect(result.samePairBots).toBe(1);
    expect(result.samePairStoppedBots).toBe(2);
    // One committed bot is below a threshold of two, and two stopped ones do not
    // make up the difference -- their capital has been returned to the ledger.
    expect(result.assessment).toBe("no_concentration");
  });

  it("mentions stopped bots on the pair when it does fire", async () => {
    await bot("b1", "BTCUSD", 100n * ONE);
    await bot("b2", "BTCUSD", 100n * ONE);
    await bot("b3", "BTCUSD", 100n * ONE, { status: "stopped" });
    const result = await assess({ policy: COUNT_ONLY });
    if (result.assessment !== "flagged") throw new Error("expected a flag");
    expect(result.flags[0].statement).toContain("A further 1 stopped bot");
    expect(result.flags[0].statement).toContain("may still hold inventory");
  });

  it("counts created and halted bots, not only running ones", async () => {
    await bot("b1", "BTCUSD", 100n * ONE, { status: "created" });
    await bot("b2", "BTCUSD", 100n * ONE, { status: "halted", halt_reason: "stop_loss", halted_at: T0 });
    const result = await assess({ policy: COUNT_ONLY });
    expect(result.samePairBots).toBe(2);
    expect(codes(result)).toEqual(["same_pair_bot_count"]);
  });
});

// ---------------------------------------------------------------------------
// Property 5: archived bots count
// ---------------------------------------------------------------------------

describe("archived bots", () => {
  it("count toward concentration exactly as unarchived ones do", async () => {
    await bot("b1", "BTCUSD", 500n * ONE, { archived: true });
    await bot("b2", "BTCUSD", 500n * ONE, { archived: true, status: "halted", halt_reason: "stop_loss", halted_at: T0 });
    const result = await assess({ policy: COUNT_ONLY });

    // Step 26: `archived` is a view flag orthogonal to `status`. An archived bot
    // still holds its allocation, so a figure that changed when someone flipped a
    // dashboard toggle would be step 25's silent omission in a new place.
    expect(result.samePairBots).toBe(2);
    expect(result.perAsset[0]?.committed).toBe("1000.00000000");
    expect(codes(result)).toEqual(["same_pair_bot_count"]);
  });
});

// ---------------------------------------------------------------------------
// Property 3b: the asset-share boundary, to the satoshi
// ---------------------------------------------------------------------------

describe("the asset capital-share signal", () => {
  it("fires at exactly the threshold share", async () => {
    await bot("btc", "BTCUSD", 400n * ONE);
    await bot("eth", "ETHUSD", 600n * ONE);
    const result = await assess({ policy: SHARE_ONLY });

    expect(result.perAsset[0]?.baseAssetSharePct).toBe("40.00000000");
    expect(codes(result)).toEqual(["asset_capital_share"]);
  });

  it("does not fire ONE SATOSHI below the threshold share", async () => {
    // 399.99999999 of 999.99999999 -- rounds to 40.00000000% at SCALE, and is
    // NOT 40%. The comparison is cross-multiplied precisely so this case is
    // decided on the real value rather than on the rendered one.
    await bot("btc", "BTCUSD", 400n * ONE - 1n);
    await bot("eth", "ETHUSD", 600n * ONE);
    const result = await assess({ policy: SHARE_ONLY });

    expect(result.perAsset[0]?.baseAssetSharePct).toBe("40.00000000");
    expect(result.assessment).toBe("no_concentration");
  });

  it("fires ONE SATOSHI above the threshold share", async () => {
    await bot("btc", "BTCUSD", 400n * ONE + 1n);
    await bot("eth", "ETHUSD", 600n * ONE);
    const result = await assess({ policy: SHARE_ONLY });
    expect(codes(result)).toEqual(["asset_capital_share"]);
  });

  it("states the fact, the totals, the bot count and the derivation", async () => {
    await bot("btc1", "BTCUSD", 300n * ONE);
    await bot("btc2", "BTCUSD", 500n * ONE);
    await bot("eth", "ETHUSD", 200n * ONE);
    const result = await assess({ policy: SHARE_ONLY });
    if (result.assessment !== "flagged") throw new Error("expected a flag");

    const flag = result.flags[0];
    expect(flag.code).toBe("asset_capital_share");
    expect(flag.capitalAsset).toBe("USD");
    expect(flag.basis).toBe("base_asset");
    expect(flag.observed).toBe("80.00000000% of committed USD");
    expect(flag.threshold).toBe("40% or more");
    expect(flag.statement).toContain("80% of");
    expect(flag.statement).toContain("BTC-based pairs");
    expect(flag.statement).toContain("800.00000000 of 1000.00000000 USD");
    expect(flag.statement).toContain("across 2 bots");
    expect(flag.statement).toContain("a naming inference, not a venue statement");
  });

  it("groups the same base asset across different pairs", async () => {
    // BTCUSD and BTCUSDT are one BTC exposure, not two unrelated ones. The quote
    // assets come from the account's own bots plus the caller's statement.
    await bot("btc1", "BTCUSD", 300n * ONE);
    await bot("btc2", "BTCUSDT", 300n * ONE, { capital_asset: "USD" });
    await bot("eth", "ETHUSD", 400n * ONE);
    const result = await assess({ policy: SHARE_ONLY, quoteAssets: ["USD", "USDT"] });

    expect(result.baseAsset).toEqual({
      resolved: true,
      baseAsset: "BTC",
      quoteStripped: "USD",
    });
    expect(result.perAsset[0]?.baseAssetBots).toBe(2);
    expect(result.perAsset[0]?.baseAssetCommitted).toBe("600.00000000");
    expect(result.perAsset[0]?.baseAssetSharePct).toBe("60.00000000");
    expect(codes(result)).toEqual(["asset_capital_share"]);
  });

  it("strips the LONGEST matching quote asset, so BTCUSDT is BTC and never BTCT", async () => {
    await bot("btc", "BTCUSDT", 900n * ONE, { capital_asset: "USDT" });
    await bot("eth", "ETHUSDT", 100n * ONE, { capital_asset: "USDT" });
    const result = await assess(
      { policy: SHARE_ONLY, quoteAssets: ["USD", "USDT"] },
      { pair: "BTCUSDT" },
    );

    expect(result.baseAsset).toEqual({
      resolved: true,
      baseAsset: "BTC",
      quoteStripped: "USDT",
    });
    expect(result.quoteAssetsConsidered).toEqual(["USDT", "USD"]);
    expect(result.perAsset[0]?.baseAssetCommitted).toBe("900.00000000");
  });

  it("is exact past 2^53, where a float total would not be", async () => {
    // 90000000.00000001 and 10000000.00000002: a share computed through IEEE
    // doubles loses the last digits of both.
    await bot("btc", "BTCUSD", 9_000_000_000_000_001n);
    await bot("eth", "ETHUSD", 1_000_000_000_000_002n);
    const result = await assess({ policy: SHARE_ONLY });
    expect(result.perAsset[0]?.committed).toBe("100000000.00000003");
    expect(result.perAsset[0]?.baseAssetCommitted).toBe("90000000.00000001");
    expect(result.perAsset[0]?.baseAssetSharePct).toBe("90.00000000");
    expect(codes(result)).toEqual(["asset_capital_share"]);
  });

  it("excludes stopped bots from both the part and the whole", async () => {
    await bot("btc", "BTCUSD", 300n * ONE);
    await bot("eth", "ETHUSD", 700n * ONE);
    // A stopped BTC bot's allocation has been returned to the ledger; counting it
    // would put BTC at 80% of a total that does not exist.
    await bot("btcOld", "BTCUSD", 1_000n * ONE, { status: "stopped" });
    const result = await assess({ policy: SHARE_ONLY });

    expect(result.perAsset[0]?.committed).toBe("1000.00000000");
    expect(result.perAsset[0]?.baseAssetSharePct).toBe("30.00000000");
    expect(result.stoppedBots).toBe(1);
    expect(result.assessment).toBe("no_concentration");
  });
});

// ---------------------------------------------------------------------------
// The base-asset inference, including when it cannot be made
// ---------------------------------------------------------------------------

describe("when the base asset cannot be determined", () => {
  it("degrades to the exact pair and SAYS SO, rather than to silence", async () => {
    // No quote asset the account uses is a suffix of "WEIRDPAIR", so no split is
    // possible. The signal must not vanish.
    await bot("w1", "WEIRDPAIR", 900n * ONE);
    await bot("eth", "ETHUSD", 100n * ONE);
    const result = await assess({ policy: SHARE_ONLY }, { pair: "WEIRDPAIR" });

    expect(result.baseAsset).toEqual({
      resolved: false,
      reason: "no_known_quote_suffix",
      quotesTried: ["USD"],
    });
    expect(result.assetSignalBasis).toBe("pair_only");
    expect(result.perAsset[0]?.baseAssetSharePct).toBeNull();
    expect(result.perAsset[0]?.samePairSharePct).toBe("90.00000000");

    if (result.assessment !== "flagged") throw new Error("expected a flag");
    const flag = result.flags.find((f) => f.code === "asset_capital_share");
    expect(flag?.basis).toBe("pair_only");
    expect(flag?.statement).toContain("base asset could not be determined");
    expect(flag?.statement).toContain("EXACT PAIR only");
    expect(flag?.statement).toContain("understates any exposure");
  });

  it("declares the base-asset figure a FLOOR when another bot's pair cannot be split", async () => {
    await bot("btc", "BTCUSD", 500n * ONE);
    await bot("weird", "WEIRDPAIR", 500n * ONE);
    const result = await assess({ policy: SHARE_ONLY });

    expect(result.perAsset[0]?.undeterminedBaseAssetBots).toBe(1);
    expect(result.perAsset[0]?.baseAssetSharePct).toBe("50.00000000");
    if (result.assessment !== "flagged") throw new Error("expected a flag");
    expect(result.flags[0].statement).toContain("could not be split");
    expect(result.flags[0].statement).toContain("FLOOR");
  });

  it("does not split a pair that IS its own quote asset", async () => {
    await bot("u1", "USD", 100n * ONE);
    const result = await assess({ policy: SHARE_ONLY }, { pair: "USD" });
    expect(result.baseAsset.resolved).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Property 6: never across capital assets
// ---------------------------------------------------------------------------

describe("capital assets", () => {
  it("are never summed together, and each flag names its own", async () => {
    await bot("usd1", "BTCUSD", 900n * ONE, { capital_asset: "USD" });
    await bot("usd2", "ETHUSD", 100n * ONE, { capital_asset: "USD" });
    await bot("usdt1", "BTCUSDT", 100n * ONE, { capital_asset: "USDT" });
    await bot("usdt2", "ETHUSDT", 900n * ONE, { capital_asset: "USDT" });
    const result = await assess({ policy: SHARE_ONLY, quoteAssets: ["USD", "USDT"] });

    expect(result.perAsset.map((entry) => entry.capitalAsset)).toEqual(["USD", "USDT"]);
    expect(result.perAsset[0]?.committed).toBe("1000.00000000");
    expect(result.perAsset[1]?.committed).toBe("1000.00000000");
    // BTC is 90% of the USD book and 10% of the USDT book. One blended figure
    // would say 50% -- a percentage of a total in no currency at all.
    expect(result.perAsset[0]?.baseAssetSharePct).toBe("90.00000000");
    expect(result.perAsset[1]?.baseAssetSharePct).toBe("10.00000000");

    if (result.assessment !== "flagged") throw new Error("expected a flag");
    expect(result.flags).toHaveLength(1);
    expect(result.flags[0].capitalAsset).toBe("USD");
    expect(result.flags[0].statement).toContain("committed USD capital");
  });

  it("orders the groups by committed capital descending, as bigint", async () => {
    // "9" > "10" lexicographically, so a string sort puts USDT first.
    await bot("a", "BTCUSD", 9n * ONE, { capital_asset: "USDT" });
    await bot("b", "BTCUSD", 10n * ONE, { capital_asset: "USD" });
    const result = await assess({ policy: COUNT_ONLY });
    expect(result.perAsset.map((entry) => entry.capitalAsset)).toEqual(["USD", "USDT"]);
  });
});

// ---------------------------------------------------------------------------
// Property 7: a flag, not a filter -- and both entry points
// ---------------------------------------------------------------------------

describe("both of 21.2's entry points", () => {
  function set(pairs: readonly string[]): CandidateSet {
    return {
      entryPoint: "general",
      accountLabel: "gemini-main",
      exchange: "gemini",
      requestedBy: "owner@example.com",
      selectedAt: T0,
      candidates: pairs.map((pair) => candidate({ pair })),
      watchlist: { readAt: T0, entriesRead: pairs.length },
      trending: null,
    };
  }

  it("returns one result per candidate, in order, with nothing filtered out", async () => {
    await bot("b1", "BTCUSD", 900n * ONE);
    await bot("b2", "BTCUSD", 100n * ONE);
    const assessed = await assessCandidateSetConcentration(
      { db, now },
      set(["LINKUSD", "BTCUSD", "ETHUSD"]),
    );

    expect(assessed.results).toHaveLength(3);
    expect(assessed.results.map((r) => r.pair)).toEqual(["LINKUSD", "BTCUSD", "ETHUSD"]);
    // The flagged candidate is still present, in its own position. This is a flag
    // for a human to weigh, never a filter (21.4).
    expect(assessed.results[0]?.assessment).toBe("no_concentration");
    expect(assessed.results[1]?.assessment).toBe("flagged");
    expect(assessed.results[2]?.assessment).toBe("no_concentration");
  });

  it("spends ONE bot_instances read for a whole candidate set", async () => {
    await bot("b1", "BTCUSD", 100n * ONE);
    let reads = 0;
    const counting = {
      botInstances: {
        findMany: async (...args: unknown[]) => {
          reads += 1;
          return await (
            db.botInstances.findMany as (...a: never[]) => Promise<unknown[]>
          )(...(args as never[]));
        },
      },
    } as unknown as Database;

    await assessCandidateSetConcentration({ db: counting, now }, set(["A", "B", "C", "D", "E"]));
    expect(reads).toBe(1);
  });

  it("gives a named candidate the same answer as the same candidate in a set", async () => {
    await bot("b1", "BTCUSD", 600n * ONE);
    await bot("b2", "BTCUSD", 400n * ONE);
    const named = await checkCandidateConcentration({ db, now }, candidate());
    const inSet = await assessCandidateSetConcentration({ db, now }, set(["BTCUSD"]));

    // 21.2: the entry points differ only in how candidates are chosen. Any
    // divergence in what this reports about the same candidate would be a bug.
    const { readAt: _a, ...namedFacts } = named;
    const first = inSet.results[0];
    if (first === undefined) throw new Error("expected a result");
    const { readAt: _b, ...setFacts } = first;
    expect(namedFacts).toEqual(setFacts);
  });

  it("publishes the exposure the results were derived from", async () => {
    await bot("b1", "BTCUSD", 100n * ONE, { status: "stopped" });
    const assessed = await assessCandidateSetConcentration({ db, now }, set(["BTCUSD"]));
    expect(assessed.exposure.rowsRead).toBe(1);
    expect(assessed.exposure.committed).toEqual([]);
    expect(assessed.exposure.stopped.map((b) => b.id)).toEqual(["b1"]);
    expect(assessed.exposure.readAt).toBeGreaterThan(T0);
  });
});

// ---------------------------------------------------------------------------
// Guards and pins
// ---------------------------------------------------------------------------

describe("guards", () => {
  it("refuses a candidate whose account is not the one that was read", async () => {
    const exposure = await readAccountExposure(db, "gemini-main", now);
    expect(() => assessConcentration(exposure, candidate({ accountLabel: "main" }))).toThrow(
      ConcentrationError,
    );
    try {
      assessConcentration(exposure, candidate({ accountLabel: "main" }));
    } catch (thrown) {
      expect((thrown as ConcentrationError).code).toBe("missing_field");
      expect((thrown as Error).message).toContain("well-formed report about the wrong account");
    }
  });

  it("refuses a blank pair and a blank account label", async () => {
    const exposure = await readAccountExposure(db, "gemini-main", now);
    expect(() => assessConcentration(exposure, candidate({ pair: "   " }))).toThrow(
      /candidate.pair must not be blank/,
    );
    await expect(readAccountExposure(db, "  ", now)).rejects.toMatchObject({
      code: "missing_field",
    });
  });

  it("reads only the named account's bots", async () => {
    await bot("mine", "BTCUSD", 100n * ONE);
    await db.botInstances.insert(
      botInstanceRow({ id: "theirs", account_label: "main", pair: "BTCUSDT" }),
    );
    const exposure = await readAccountExposure(db, "gemini-main", now);
    expect(exposure.rowsRead).toBe(1);
    expect(exposure.committed.map((b) => b.id)).toEqual(["mine"]);
  });

  /**
   * The policy pin, for the reason `VERIFIED_INTERVALS` and
   * `COINDESK_WIRE_FIELDS` are pinned: these two numbers are POLICY, not
   * findings, and changing one is a decision that must appear in a diff rather
   * than happen as a one-character edit.
   */
  it("pins the default policy", () => {
    expect(DEFAULT_CONCENTRATION_POLICY).toEqual({
      samePairBotCountFlagAt: 2,
      assetCapitalShareFlagAtPct: 4_000_000_000n,
    });
    expect(DEFAULT_CONCENTRATION_POLICY.assetCapitalShareFlagAtPct).toBe(40n * ONE);
  });

  it("echoes the policy it applied onto every result", async () => {
    const clean = await assess({ policy: SHARE_ONLY });
    expect(clean.policy).toEqual(SHARE_ONLY);
    const defaulted = await assess();
    expect(defaulted.policy).toEqual(DEFAULT_CONCENTRATION_POLICY);
  });
});

// ---------------------------------------------------------------------------
// The shape of the real account, as decision log 32 recorded it
// ---------------------------------------------------------------------------

describe("the REAL testnet account, read 2026-08-10T20:35:36Z", () => {
  /**
   * REAL STATE, not a reconstruction from this log. Read from the live testnet
   * `bot_instances` at the timestamp in the describe name:
   *
   *   13 bots, ALL on `gemini-main`, ALL `capital_asset` "USD", NONE stopped.
   *   11 on BTCUSD totalling 1650.00 USD -- 7 running, 1 halted, 1
   *   halted+archived, 2 created (`v-spot-1` and `v-perp-1`, both created by
   *   steps 32/33's own live verification runs).
   *   2 on DOGEUSD totalling 100.00 USD, both running.
   *
   * `v-perp-1` IS A SPOT BOT. Its pair is `BTCUSD`; the name is leftover from a
   * rejected-then-reused botId in step 32's perpetual regression test, and it is
   * spelled out here because a future reader grepping for "perp" will find it and
   * draw the wrong conclusion. Nothing in this repository infers an instrument
   * from a bot id, and this test is the proof that concentration does not either
   * -- `v-perp-1` counts as one of the eleven BTCUSD bots.
   *
   * TWO THINGS HERE ARE STILL NOT REAL, and are named rather than implied:
   *
   *   1. THE PER-BOT SPLIT of each total. The live read gave the pair totals, not
   *      a figure per bot. Distributed evenly (11 x 150, 2 x 50) because every
   *      figure this module reports is an aggregate, so the output is INVARIANT
   *      to the split given the totals -- which is itself asserted below.
   *   2. THE BOT IDS, except `v-spot-1` and `v-perp-1`. So `samePairBotIds` is
   *      tested for its CONTENTS as a set, and the two real ids are asserted by
   *      name; the seven `btc-r*` placeholders stand for real ids this test does
   *      not know.
   *
   * WHAT IS REAL AND IS THE POINT: 13 rows, 0 stopped, one quote asset, and the
   * two shares -- 1650/1750 = 94.28571429% and 100/1750 = 5.71428571%, both
   * confirmed against by-hand arithmetic before this test was written.
   */
  beforeEach(async () => {
    for (let i = 1; i <= 7; i += 1) await bot(`btc-r${i}`, "BTCUSD", 150n * ONE);
    await bot("btc-h1", "BTCUSD", 150n * ONE, {
      status: "halted",
      halt_reason: "stop_loss",
      halted_at: T0,
    });
    await bot("btc-h2", "BTCUSD", 150n * ONE, {
      status: "halted",
      halt_reason: "stop_loss",
      halted_at: T0,
      archived: true,
    });
    await bot("v-spot-1", "BTCUSD", 150n * ONE, { status: "created" });
    await bot("v-perp-1", "BTCUSD", 150n * ONE, { status: "created" });
    await bot("doge-1", "DOGEUSD", 50n * ONE);
    await bot("doge-2", "DOGEUSD", 50n * ONE);
  });

  it("reads the account as it really is: 13 rows, none stopped, one quote asset", async () => {
    const exposure = await readAccountExposure(db, "gemini-main", now);
    expect(exposure.rowsRead).toBe(13);
    expect(exposure.committed).toHaveLength(13);
    // NOT A PASS FOR THE STOPPED-EXCLUSION RULE. No bot in this account has ever
    // been stopped, so that rule -- real code, and the reason the `allocated`
    // figure is not simply a SUM of the column -- is exercised ONLY by the
    // fixtures above, never against real data. Recorded as an unobserved path.
    expect(exposure.stopped).toEqual([]);
    // Likewise the multi-asset path: one quote asset is all this account has ever
    // used, so the per-capital-asset grouping is correct-but-unobserved too.
    expect(exposure.quoteAssetsObserved).toEqual(["USD"]);
  });

  it("flags a twelfth BTCUSD bot on both signals, with the real percentages", async () => {
    const result = await assess();
    expect(result.rowsRead).toBe(13);
    expect(result.committedBots).toBe(13);
    expect(result.stoppedBots).toBe(0);
    expect(result.samePairBots).toBe(11);
    expect(result.pairsHeld).toEqual([
      { pair: "BTCUSD", bots: 11 },
      { pair: "DOGEUSD", bots: 2 },
    ]);

    const usd = result.perAsset[0];
    expect(result.perAsset).toHaveLength(1);
    expect(usd?.capitalAsset).toBe("USD");
    expect(usd?.bots).toBe(13);
    expect(usd?.committed).toBe("1750.00000000");
    expect(usd?.baseAssetBots).toBe(11);
    expect(usd?.baseAssetCommitted).toBe("1650.00000000");
    // 1650 / 1750 = 94.285714285714...%, half-even at SCALE 8.
    expect(usd?.baseAssetSharePct).toBe("94.28571429");
    expect(usd?.undeterminedBaseAssetBots).toBe(0);

    expect(result.baseAsset).toEqual({
      resolved: true,
      baseAsset: "BTC",
      quoteStripped: "USD",
    });
    expect(codes(result)).toEqual(["same_pair_bot_count", "asset_capital_share"]);
    if (result.assessment !== "flagged") throw new Error("expected flags");
    expect(result.flags[0].statement).toContain("would be number 12");
    expect(result.flags[1]?.statement).toContain(
      "1650.00000000 of 1750.00000000 USD, across 11 bots",
    );
  });

  it("counts v-perp-1 as one of the eleven BTCUSD bots, its name notwithstanding", async () => {
    const result = await assess();
    expect(result.samePairBotIds).toContain("v-perp-1");
    expect(result.samePairBotIds).toContain("v-spot-1");
    expect([...result.samePairBotIds].sort()).toEqual(
      [
        "btc-h1",
        "btc-h2",
        "btc-r1",
        "btc-r2",
        "btc-r3",
        "btc-r4",
        "btc-r5",
        "btc-r6",
        "btc-r7",
        "v-perp-1",
        "v-spot-1",
      ].sort(),
    );
  });

  it("flags a third DOGEUSD bot on the COUNT, at exactly the boundary, and not on the share", async () => {
    const result = await assess({}, { pair: "DOGEUSD" });
    expect(result.samePairBots).toBe(2);
    // 100 / 1750 = 5.714285714...%, nowhere near 40%.
    expect(result.perAsset[0]?.baseAssetSharePct).toBe("5.71428571");
    // The count signal DOES fire: two existing bots is exactly the threshold, so
    // a third DOGEUSD proposal is flagged even though its share is 5.7%. Pinned
    // because "DOGE does not flag" is the natural summary of the share figure and
    // it is wrong about the overall result.
    expect(codes(result)).toEqual(["same_pair_bot_count"]);
  });

  it("reports a genuinely new pair as clean, against the same thirteen bots", async () => {
    const result = await assess({}, { pair: "LINKUSD" });
    expect(result.assessment).toBe("no_concentration");
    expect(result.committedBots).toBe(13);
    expect(result.samePairBots).toBe(0);
    expect(result.perAsset[0]?.baseAssetSharePct).toBe("0.00000000");
  });

  it("reports the same figures however the pair totals are split per bot", async () => {
    // The claim that licenses the invented per-bot split above: every figure is an
    // aggregate, so a lopsided distribution summing to the same pair totals must
    // produce an identical report. If this ever fails, the split stopped being an
    // implementation detail and the real per-bot numbers have to be obtained.
    const even = await assess();
    await freshDatabase();
    await db.accounts.insert(accountRow({ account_label: "gemini-main", exchange: "gemini" }));
    await bot("btc-big", "BTCUSD", 1_640n * ONE);
    for (let i = 1; i <= 10; i += 1) await bot(`btc-tiny${i}`, "BTCUSD", ONE);
    await bot("doge-big", "DOGEUSD", 99n * ONE);
    await bot("doge-tiny", "DOGEUSD", ONE);
    const lopsided = await assess();

    expect(lopsided.perAsset[0]?.committed).toBe(even.perAsset[0]?.committed);
    expect(lopsided.perAsset[0]?.baseAssetCommitted).toBe(even.perAsset[0]?.baseAssetCommitted);
    expect(lopsided.perAsset[0]?.baseAssetSharePct).toBe("94.28571429");
    expect(codes(lopsided)).toEqual(codes(even));
  });
});

// ---------------------------------------------------------------------------
// The pure fold, over a hand-built exposure
// ---------------------------------------------------------------------------

describe("assessConcentration as a pure function", () => {
  /** No database at all: the threshold arithmetic, isolated from any read. */
  function exposureOf(
    bots: readonly { id: string; pair: string; allocated: bigint }[],
  ): AccountExposure {
    return {
      accountLabel: "gemini-main",
      readAt: T0,
      rowsRead: bots.length,
      committed: bots.map((b) => ({
        id: b.id,
        pair: b.pair,
        capitalAsset: "USD",
        allocatedCapital: b.allocated,
        status: "running",
        archived: false,
      })),
      stopped: [],
      quoteAssetsObserved: ["USD"],
    };
  }

  it("decides the share boundary on the exact value, not the rendered one", () => {
    const cases: readonly { allocated: bigint; flagged: boolean }[] = [
      { allocated: 400n * ONE - 1n, flagged: false },
      { allocated: 400n * ONE, flagged: true },
      { allocated: 400n * ONE + 1n, flagged: true },
    ];
    for (const { allocated, flagged } of cases) {
      const result = assessConcentration(
        exposureOf([
          { id: "btc", pair: "BTCUSD", allocated },
          { id: "eth", pair: "ETHUSD", allocated: 600n * ONE },
        ]),
        candidate(),
        { policy: SHARE_ONLY },
      );
      expect(codes(result)).toEqual(flagged ? ["asset_capital_share"] : []);
    }
  });

  it("states a share of null, not 0%, when there is no committed capital to divide by", () => {
    // Unreachable through the real table (see the CHECK-constraint test above),
    // so it is asserted here where an exposure can be built by hand. Null rather
    // than 0% because an account with no committed capital has no share of it,
    // and 0% would be a claim.
    const exposure = exposureOf([{ id: "btc", pair: "BTCUSD", allocated: 0n }]);
    const result = assessConcentration(exposure, candidate(), { policy: SHARE_ONLY });
    expect(result.perAsset[0]?.committed).toBe("0.00000000");
    expect(result.perAsset[0]?.samePairSharePct).toBeNull();
    expect(result.perAsset[0]?.baseAssetSharePct).toBeNull();
    expect(result.assessment).toBe("no_concentration");
  });

  it("decides the count boundary at 1, 2 and 3 existing bots", () => {
    for (const [count, flagged] of [
      [1, false],
      [2, true],
      [3, true],
    ] as const) {
      const bots = Array.from({ length: count }, (_, i) => ({
        id: `b${i}`,
        pair: "BTCUSD",
        allocated: 10n * ONE,
      }));
      const result = assessConcentration(exposureOf(bots), candidate(), { policy: COUNT_ONLY });
      expect(codes(result)).toEqual(flagged ? ["same_pair_bot_count"] : []);
    }
  });
});
