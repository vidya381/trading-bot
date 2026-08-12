/**
 * Stage 1 assembly: an honest partial bundle, and the isolation that makes it
 * honest.
 *
 * Six properties, each one this module would look correct without:
 *
 *  1. FAILURE IS ISOLATED PER INPUT, IN BOTH DIRECTIONS. A candle fetch that
 *     failed must not cost this candidate its concentration flag, and a
 *     `bot_instances` read that failed must not cost it its candles. This is
 *     the property the whole file exists for, so it is tested as a MATRIX --
 *     every failure case asserts the failed slot AND the surviving slots'
 *     real values, never just that a bundle came back.
 *  2. ASSEMBLY NEVER THROWS. The three real inputs throw six, two and two ways
 *     between them, and every one of those must arrive as a recorded state on
 *     one slot rather than as an exception out of the bundle.
 *  3. FAIL-CLOSED IS UNTOUCHED WITHIN AN INPUT. The recorded failure is the
 *     module's OWN error with its OWN code -- `candles_unavailable`,
 *     `bot_list_unreadable` -- not a flattened restatement, and never an empty
 *     candle array or a clean concentration result (21.5 requirement 6).
 *  4. THE NEWS SLOT IS A STATE, NOT AN ABSENCE. It is present, identical and
 *     correctly shaped in every bundle including the ones where everything
 *     else failed, and it carries no `error`, no `failedAt` and no `fetchedAt`
 *     -- so nothing downstream can render the deliberate pause of decision log
 *     30 as a fetch that went wrong.
 *  5. EVERY FETCH KEEPS ITS OWN TIMESTAMP. The clock advances on every read, so
 *     a bundle that collapsed the sub-fetch times into one instant fails here
 *     rather than in a proposal that claims data was fetched when it was not
 *     (21.5 requirement 4).
 *  6. A SET IS ORDER-PRESERVING AND UNFILTERED. `bundles[i]` is
 *     `set.candidates[i]`, flagged or clean, succeeded or failed, always.
 *
 * The candidate-selection input has no failure case here ON PURPOSE and that is
 * a statement rather than a gap: a `Candidate` exists only because selection
 * already succeeded, so selection's failures are refusals out of
 * `selectNamedCandidate`/`selectGeneralCandidates` that produce nothing to
 * bundle. What IS tested is that the candidate arrives verbatim -- merged
 * provenance and all -- because a summarised one would destroy exactly what
 * 21.5 requirement 2 needs.
 *
 * The database is real (`freshDatabase`, the real migrations); the exchange and
 * the failed-read case are stubs, as everywhere else in this folder. NOTHING
 * HERE HAS SPOKEN TO A VENUE OR TO A NEWS VENDOR.
 */

import { beforeEach, describe, expect, it } from "vitest";

import {
  NEWS_NOT_YET_AVAILABLE,
  gatherCandidateData,
  gatherCandidateSetData,
  gatherDeriveContext,
  type CandidateGatherBundle,
  type DeriveContextPorts,
  type GatherPorts,
  type GatherRequest,
  type NewsInput,
} from "./gather";
import { CandleWindowError, type CandleSource } from "./candles";
import { ConcentrationError, type ConcentrationPolicy } from "./concentration";
import type { Candidate, CandidateSet, CandidateSource } from "./candidates";
import type { SymbolDetailSource, TradablePairSource } from "./tradability";
import type { Database } from "../db/database";
import type { CapitalLedgerRow } from "../db/schema";
import type { Candle, SymbolFilters, Timestamp } from "../shared/exchange-client";
import { ONE } from "../shared/money";
import { accountRow, botInstanceRow, capitalLedgerRow, freshDatabase } from "../db/test-helpers";

const T0 = 1_930_000_000_000;
const MINUTE = 60_000;

const CATALOGUE: Record<string, string[]> = {
  "gemini-main": ["BTCUSD", "ETHUSD", "SOLUSD"],
};

let db: Database;
let clock: number;

beforeEach(async () => {
  db = await freshDatabase();
  await db.accounts.insert(accountRow({ account_label: "gemini-main", exchange: "gemini" }));
  clock = T0;
});

/**
 * A clock that MOVES on every read.
 *
 * Property 5 depends on this: with a frozen clock, a bundle that collapsed
 * every sub-fetch into one timestamp would be indistinguishable from one that
 * kept them apart, and the test would pass on the bug.
 */
const now = (): Timestamp => (clock += 1_000);

const listing: TradablePairSource = async (account) => ({
  ok: true,
  pairs: [...(CATALOGUE[account.label] ?? [])],
  cached: false,
  fetchedAt: T0,
});

function candle(pair: string, openTime: Timestamp, close: bigint): Candle {
  return {
    pair,
    openTime,
    closeTime: openTime + MINUTE,
    open: close - 1n,
    high: close + 2n,
    low: close - 3n,
    close,
    volume: 4n,
    closed: true,
  };
}

/**
 * A venue that answers with three minute candles, at its OWN instant.
 *
 * `at` is deliberately far from anything the test clock produces, so
 * `CandleWindow.fetchedAt` surviving into the bundle is a real assertion rather
 * than a coincidence of two clocks agreeing.
 */
const VENUE_ANSWERED_AT = 1_940_000_000_000;

const candles: CandleSource = async (_account, query) => ({
  ok: true,
  value: [
    candle(query.pair, T0, 100n),
    candle(query.pair, T0 + MINUTE, 101n),
    candle(query.pair, T0 + 2 * MINUTE, 102n),
  ],
  at: VENUE_ANSWERED_AT,
});

/** A venue call that failed -- `candles_unavailable`, the six-way refusal's fifth. */
const candlesDown: CandleSource = async () => ({
  ok: false,
  kind: "transport",
  message: "connect ETIMEDOUT",
  retryable: true,
  at: VENUE_ANSWERED_AT,
});

/** A port that throws raw, as a driver bug or an unwrapped rejection would. */
const candlesThrow: CandleSource = async () => {
  throw new TypeError("fetch failed: undefined is not an object");
};

function ports(overrides: Partial<GatherPorts> = {}): GatherPorts {
  return { db, listTradablePairs: listing, getCandles: candles, now, ...overrides };
}

/**
 * A `Database` whose bot-list read throws, as a real D1 outage would.
 *
 * `accounts.findOne` still works, so the candle fetch is unaffected -- which is
 * the whole point: this is the port that isolates concentration's failure from
 * candles' success.
 */
function unreadableBotList(kind: "d1" | "raw"): Database {
  return {
    accounts: { findOne: db.accounts.findOne.bind(db.accounts) },
    botInstances: {
      findMany: async () => {
        if (kind === "raw") throw "D1 dropped a string, which is legal JavaScript";
        throw new Error("D1_ERROR: Network connection lost");
      },
    },
  } as unknown as Database;
}

function source(overrides: Partial<CandidateSource> = {}): CandidateSource {
  return {
    kind: "named",
    requestedAs: "BTCUSD",
    requestedBy: "owner@example.com",
    requestedAt: T0,
    ...overrides,
  } as CandidateSource;
}

function candidate(overrides: Partial<Candidate> = {}): Candidate {
  return {
    accountLabel: "gemini-main",
    exchange: "gemini",
    pair: "BTCUSD",
    sources: [source()],
    ...overrides,
  };
}

function candidateSet(
  candidates: readonly Candidate[],
  overrides: Partial<CandidateSet> = {},
): CandidateSet {
  return {
    entryPoint: "general",
    accountLabel: "gemini-main",
    exchange: "gemini",
    requestedBy: "owner@example.com",
    selectedAt: T0,
    candidates,
    watchlist: { readAt: T0, entriesRead: candidates.length },
    trending: {
      pullId: "pull-1",
      vendor: "stub",
      fetchedAt: T0 - 5_000,
      quoteAssets: ["USD"],
      returned: 0,
      accepted: 0,
      pairsMatched: 0,
      rejected: [],
    },
    ...overrides,
  };
}

const REQUEST: GatherRequest = { interval: "1m" };

/** Insert one committed `gemini-main` bot. Money is Money: SCALE 8 bigint. */
async function bot(id: string, pair: string, allocated: bigint): Promise<void> {
  await db.botInstances.insert(
    botInstanceRow({
      id,
      account_label: "gemini-main",
      exchange: "gemini",
      pair,
      allocated_capital: allocated,
      capital_asset: "USD",
      status: "running",
    }),
  );
}

/** Fires the same-pair count flag at two, and nothing else. */
const COUNT_AT_TWO: ConcentrationPolicy = {
  samePairBotCountFlagAt: 2,
  assetCapitalShareFlagAtPct: 101n * ONE,
};

// ---------------------------------------------------------------------------
// Property 1a: everything succeeds
// ---------------------------------------------------------------------------

describe("when all four inputs succeed", () => {
  it("returns every real value, plus the paused news slot", async () => {
    // On a DIFFERENT pair to the candidate, so the default policy's 40% asset
    // share cannot fire: a single BTCUSD bot would be 100% of this account's
    // committed USD in BTC, which is a flag rather than the clean case wanted
    // here.
    await bot("b1", "ETHUSD", 1_000n * ONE);

    const bundle = await gatherCandidateData(ports(), candidate(), REQUEST);

    expect(bundle.candles.outcome).toBe("ok");
    expect(bundle.concentration.outcome).toBe("ok");
    expect(bundle.news.outcome).toBe("not_yet_available");

    if (bundle.candles.outcome !== "ok") throw new Error("unreachable");
    if (bundle.concentration.outcome !== "ok") throw new Error("unreachable");

    // The candle array is the venue's, untouched.
    expect(bundle.candles.value.candles).toHaveLength(3);
    expect(bundle.candles.value.pair).toBe("BTCUSD");
    expect(bundle.candles.value.interval).toBe("1m");
    // The exchange came from the registry, not from the candidate.
    expect(bundle.candles.value.exchange).toBe("gemini");

    // The concentration read really read this account's bot.
    expect(bundle.concentration.value.rowsRead).toBe(1);
    expect(bundle.concentration.value.committedBots).toBe(1);
    expect(bundle.concentration.value.samePairBots).toBe(0);
    expect(bundle.concentration.value.assessment).toBe("no_concentration");
  });

  it("carries the candidate verbatim, with every source it arrived with", async () => {
    // A coin on BOTH of 21.3's sources: one candidate, two sources (21.5 req 2).
    const merged = candidate({
      sources: [
        source({
          kind: "watchlist",
          entryId: "wl-9",
          note: "deep book",
          addedBy: "owner@example.com",
          addedAt: T0 - 90_000,
        }),
        source({
          kind: "trending",
          pullId: "pull-1",
          vendor: "stub",
          fetchedAt: T0 - 5_000,
          coinId: "bitcoin",
          symbol: "BTC",
          name: "Bitcoin",
          rank: 3,
          raw: { anything: true },
        }),
      ] as Candidate["sources"],
    });

    const bundle = await gatherCandidateData(ports(), merged, REQUEST);

    // By identity: nothing was rebuilt, summarised or re-ordered.
    expect(bundle.candidate).toBe(merged);
    expect(bundle.candidate.sources).toHaveLength(2);
    expect(bundle.candidate.sources.map((s) => s.kind)).toEqual(["watchlist", "trending"]);
  });

  it("reports a real concentration flag rather than a verdict", async () => {
    await bot("b1", "BTCUSD", 1_000n * ONE);
    await bot("b2", "BTCUSD", 1_000n * ONE);

    const bundle = await gatherCandidateData(ports(), candidate(), {
      ...REQUEST,
      policy: COUNT_AT_TWO,
    });

    if (bundle.concentration.outcome !== "ok") throw new Error("unreachable");
    expect(bundle.concentration.value.assessment).toBe("flagged");
    // Flagged, and still fully assembled: a flag is not a refusal.
    expect(bundle.candles.outcome).toBe("ok");
  });
});

// ---------------------------------------------------------------------------
// Property 1b: the isolation matrix -- one input fails, the others survive
// ---------------------------------------------------------------------------

describe("when the candle fetch fails", () => {
  it("records the real CandleWindowError and still returns concentration", async () => {
    await bot("b1", "BTCUSD", 1_000n * ONE);
    await bot("b2", "BTCUSD", 1_000n * ONE);

    const bundle = await gatherCandidateData(
      ports({ getCandles: candlesDown }),
      candidate(),
      { ...REQUEST, policy: COUNT_AT_TWO },
    );

    expect(bundle.candles.outcome).toBe("failed");
    if (bundle.candles.outcome !== "failed") throw new Error("unreachable");
    expect(bundle.candles.error).toBeInstanceOf(CandleWindowError);
    expect(bundle.candles.error.code).toBe("candles_unavailable");
    expect(bundle.candles.failedAt).toBeGreaterThan(T0);

    // THE POINT: the concentration flag survived the candle failure intact.
    expect(bundle.concentration.outcome).toBe("ok");
    if (bundle.concentration.outcome !== "ok") throw new Error("unreachable");
    expect(bundle.concentration.value.assessment).toBe("flagged");
    expect(bundle.concentration.value.samePairBots).toBe(2);
    expect(bundle.concentration.value.samePairBotIds).toEqual(["b1", "b2"]);

    // And so did the candidate and the news slot.
    expect(bundle.candidate.pair).toBe("BTCUSD");
    expect(bundle.news).toBe(NEWS_NOT_YET_AVAILABLE);
  });

  it("records each of the interval, account and tradability refusals as itself", async () => {
    const cases: { request: GatherRequest; who: Candidate; code: string }[] = [
      { request: { interval: "1h" }, who: candidate(), code: "interval_not_verified" },
      { request: REQUEST, who: candidate({ accountLabel: "ghost" }), code: "unknown_account" },
      { request: REQUEST, who: candidate({ pair: "DOGEUSD" }), code: "pair_not_tradable" },
    ];

    for (const { request, who, code } of cases) {
      const bundle = await gatherCandidateData(ports(), who, request);
      expect(bundle.candles.outcome).toBe("failed");
      if (bundle.candles.outcome !== "failed") throw new Error("unreachable");
      // The module's OWN code, not a flattened restatement of it.
      expect(bundle.candles.error.code).toBe(code);
    }
  });

  it("never substitutes an empty candle array for a failed fetch", async () => {
    const bundle = await gatherCandidateData(
      ports({ getCandles: candlesDown }),
      candidate(),
      REQUEST,
    );
    // 21.5 requirement 6: the shape a silent failure would take here is `[]`,
    // and it is unreachable -- the value is not in the failed arm at all.
    expect(bundle.candles).not.toHaveProperty("value");
  });

  it("separates a port that threw from a refusal the module enumerated", async () => {
    await bot("b1", "BTCUSD", 1_000n * ONE);

    const bundle = await gatherCandidateData(
      ports({ getCandles: candlesThrow }),
      candidate(),
      REQUEST,
    );

    expect(bundle.candles.outcome).toBe("threw_unexpectedly");
    if (bundle.candles.outcome !== "threw_unexpectedly") throw new Error("unreachable");
    expect(bundle.candles.error).toBeInstanceOf(TypeError);
    expect(bundle.candles.error).not.toBeInstanceOf(CandleWindowError);

    // Still isolated.
    expect(bundle.concentration.outcome).toBe("ok");
  });
});

describe("when the bot_instances read fails", () => {
  it("records bot_list_unreadable and still returns the candles", async () => {
    const bundle = await gatherCandidateData(
      ports({ db: unreadableBotList("d1") }),
      candidate(),
      REQUEST,
    );

    expect(bundle.concentration.outcome).toBe("failed");
    if (bundle.concentration.outcome !== "failed") throw new Error("unreachable");
    expect(bundle.concentration.error).toBeInstanceOf(ConcentrationError);
    expect(bundle.concentration.error.code).toBe("bot_list_unreadable");
    // The D1 error itself is not lost.
    expect(bundle.concentration.error.cause).toBeInstanceOf(Error);

    // THE POINT: the candles survived the concentration failure intact.
    expect(bundle.candles.outcome).toBe("ok");
    if (bundle.candles.outcome !== "ok") throw new Error("unreachable");
    expect(bundle.candles.value.candles).toHaveLength(3);
    expect(bundle.candles.value.fetchedAt).toBe(VENUE_ANSWERED_AT);

    expect(bundle.news).toBe(NEWS_NOT_YET_AVAILABLE);
  });

  it("never substitutes a clean concentration result for a failed read", async () => {
    const bundle = await gatherCandidateData(
      ports({ db: unreadableBotList("d1") }),
      candidate(),
      REQUEST,
    );
    // The invisible violation: "no_concentration" is a well-formed answer and
    // is the one that hides the risk the check exists to surface.
    expect(bundle.concentration).not.toHaveProperty("value");
    expect(JSON.stringify(bundle.concentration)).not.toContain("no_concentration");
  });

  it("separates a driver that threw a non-Error from an enumerated refusal", async () => {
    const bundle = await gatherCandidateData(
      ports({ db: unreadableBotList("raw") }),
      candidate(),
      REQUEST,
    );

    // `readAccountExposure` catches broadly and normalises, so even a thrown
    // string arrives as the module's own error. Pinned because it is the reason
    // this input has no reachable `threw_unexpectedly` today, and a change that
    // removed that catch should show up here rather than in a proposal.
    expect(bundle.concentration.outcome).toBe("failed");
    if (bundle.concentration.outcome !== "failed") throw new Error("unreachable");
    expect(bundle.concentration.error.code).toBe("bot_list_unreadable");
    expect(bundle.candles.outcome).toBe("ok");
  });

  it("records a fold refusal per candidate, not per read", async () => {
    await bot("b1", "BTCUSD", 1_000n * ONE);

    // The fold refuses a candidate whose account is not the one that was read.
    const set = candidateSet([
      candidate(),
      candidate({ pair: "ETHUSD", accountLabel: "someone-else" }),
    ]);
    const assembled = await gatherCandidateSetData(ports(), set, REQUEST);

    expect(assembled.bundles[0]?.concentration.outcome).toBe("ok");

    const second = assembled.bundles[1]?.concentration;
    expect(second?.outcome).toBe("failed");
    if (second?.outcome !== "failed") throw new Error("unreachable");
    expect(second.error).toBeInstanceOf(ConcentrationError);
    expect(second.error.code).toBe("missing_field");

    // And the shared exposure read is still reported as the success it was.
    expect(assembled.exposure.outcome).toBe("ok");
  });
});

describe("when both real inputs fail", () => {
  it("returns a bundle rather than throwing, with both failures recorded", async () => {
    const bundle = await gatherCandidateData(
      ports({ db: unreadableBotList("d1"), getCandles: candlesDown }),
      candidate(),
      REQUEST,
    );

    expect(bundle.candles.outcome).toBe("failed");
    expect(bundle.concentration.outcome).toBe("failed");
    // Assembly is collection, not judgement: a bundle still comes back, and
    // deciding whether it is fit to show a human is Stage 4's job.
    expect(bundle.candidate.pair).toBe("BTCUSD");
    expect(bundle.news).toBe(NEWS_NOT_YET_AVAILABLE);
  });
});

// ---------------------------------------------------------------------------
// Property 4: the news slot
// ---------------------------------------------------------------------------

describe("the news slot", () => {
  it("is present, identical and correctly shaped in every bundle", async () => {
    const everythingWorks = await gatherCandidateData(ports(), candidate(), REQUEST);
    const everythingBroken = await gatherCandidateData(
      ports({ db: unreadableBotList("d1"), getCandles: candlesThrow }),
      candidate(),
      REQUEST,
    );

    for (const bundle of [everythingWorks, everythingBroken]) {
      expect(bundle.news).toBe(NEWS_NOT_YET_AVAILABLE);
      expect(bundle.news.outcome).toBe("not_yet_available");
      expect(bundle.news.decisionLogEntry).toBe("docs/decision-log/30.md");
      expect(bundle.news.reason).toContain("vendor");
    }
  });

  it("cannot be read as a failed fetch: no error, no failedAt, no fetchedAt", () => {
    // The structural half of decision log 30's pause. A renderer that keys off
    // any of these three would have to invent the fetch that never happened.
    expect(NEWS_NOT_YET_AVAILABLE).not.toHaveProperty("error");
    expect(NEWS_NOT_YET_AVAILABLE).not.toHaveProperty("failedAt");
    expect(NEWS_NOT_YET_AVAILABLE).not.toHaveProperty("fetchedAt");
    expect(NEWS_NOT_YET_AVAILABLE).not.toHaveProperty("value");
    expect(Object.keys(NEWS_NOT_YET_AVAILABLE).sort()).toEqual([
      "decisionLogEntry",
      "outcome",
      "reason",
    ]);
  });

  it("is frozen, so no bundle can mutate another's", async () => {
    const a = await gatherCandidateData(ports(), candidate(), REQUEST);
    const b = await gatherCandidateData(ports(), candidate({ pair: "ETHUSD" }), REQUEST);
    expect(Object.isFrozen(NEWS_NOT_YET_AVAILABLE)).toBe(true);
    expect(a.news).toBe(b.news);
  });

  it("pins the union to exactly one arm, so a vendor landing is a compile error", () => {
    // THE PIN. `NewsInput` is one-armed today. When a vendor is chosen and
    // `ok`/`failed` arms are added, this assignment stops compiling and every
    // exhaustive switch downstream does too -- which is why the pause lives in
    // the type instead of in a TODO.
    const pinned: NewsInput["outcome"] = "not_yet_available";
    const exhaustive: Record<NewsInput["outcome"], true> = { not_yet_available: true };
    expect(pinned).toBe("not_yet_available");
    expect(Object.keys(exhaustive)).toEqual(["not_yet_available"]);
  });
});

// ---------------------------------------------------------------------------
// Property 5: every fetch keeps its own timestamp
// ---------------------------------------------------------------------------

describe("timestamps", () => {
  it("keeps each sub-fetch's own instant rather than collapsing them", async () => {
    await bot("b1", "BTCUSD", 1_000n * ONE);

    const bundle = await gatherCandidateData(ports(), candidate(), REQUEST);
    if (bundle.candles.outcome !== "ok") throw new Error("unreachable");
    if (bundle.concentration.outcome !== "ok") throw new Error("unreachable");

    const venue = bundle.candles.value.fetchedAt;
    const d1 = bundle.concentration.value.readAt;

    // The venue's own answer time, not this process's clock.
    expect(venue).toBe(VENUE_ANSWERED_AT);
    // The D1 read's own time, from the moving clock.
    expect(d1).toBeGreaterThanOrEqual(T0);
    expect(d1).toBeLessThan(VENUE_ANSWERED_AT);

    // Three distinct instants. A bundle-level `fetchedAt` would make at least
    // two of these equal, which is the collapse 21.5 requirement 4 forbids.
    expect(new Set([venue, d1, bundle.assembledAt]).size).toBe(3);
  });

  it("times a failure from when it was observed, since there is no fetch time", async () => {
    const before = clock;
    const bundle = await gatherCandidateData(
      ports({ getCandles: candlesDown }),
      candidate(),
      REQUEST,
    );
    if (bundle.candles.outcome !== "failed") throw new Error("unreachable");
    expect(bundle.candles.failedAt).toBeGreaterThan(before);
    expect(bundle.candles.failedAt).toBeLessThanOrEqual(clock);
  });

  it("preserves the set's own provenance timestamps beside the per-fetch ones", async () => {
    const set = candidateSet([candidate()]);
    const assembled = await gatherCandidateSetData(ports(), set, REQUEST);

    // Carried whole, so "which trending pull, and when" survives (21.5 req 2).
    expect(assembled.set).toBe(set);
    expect(assembled.set.trending?.fetchedAt).toBe(T0 - 5_000);
    expect(assembled.set.watchlist?.readAt).toBe(T0);
    expect(assembled.set.selectedAt).toBe(T0);
    // And is not the same instant as assembly.
    expect(assembled.assembledAt).toBeGreaterThan(T0);
  });
});

// ---------------------------------------------------------------------------
// Property 6: a set is order-preserving and unfiltered
// ---------------------------------------------------------------------------

describe("a whole candidate set", () => {
  it("returns one bundle per candidate, in the set's order, never filtered", async () => {
    await bot("b1", "BTCUSD", 1_000n * ONE);
    await bot("b2", "BTCUSD", 1_000n * ONE);

    const set = candidateSet([
      candidate({ pair: "SOLUSD" }),
      candidate({ pair: "BTCUSD" }),
      candidate({ pair: "ETHUSD" }),
    ]);
    const assembled = await gatherCandidateSetData(ports(), set, {
      ...REQUEST,
      policy: COUNT_AT_TWO,
    });

    expect(assembled.bundles).toHaveLength(3);
    expect(assembled.bundles.map((b) => b.candidate.pair)).toEqual([
      "SOLUSD",
      "BTCUSD",
      "ETHUSD",
    ]);
    // The flagged one is in its own position, not first, not removed.
    expect(assessments(assembled.bundles)).toEqual([
      "no_concentration",
      "flagged",
      "no_concentration",
    ]);
    for (const bundle of assembled.bundles) expect(bundle.candles.outcome).toBe("ok");
  });

  it("keeps a failing candidate in position without disturbing its neighbours", async () => {
    await bot("b1", "ETHUSD", 1_000n * ONE);

    // Only the middle candidate's candles fail: it is not on the venue's
    // catalogue, so `checkTradable` refuses it and only it.
    const set = candidateSet([
      candidate({ pair: "BTCUSD" }),
      candidate({ pair: "DOGEUSD" }),
      candidate({ pair: "ETHUSD" }),
    ]);
    const assembled = await gatherCandidateSetData(ports(), set, REQUEST);

    expect(assembled.bundles.map((b) => b.candles.outcome)).toEqual(["ok", "failed", "ok"]);
    const failed = assembled.bundles[1]?.candles;
    if (failed?.outcome !== "failed") throw new Error("unreachable");
    expect(failed.error.code).toBe("pair_not_tradable");

    // Every candidate's concentration is unaffected, including the failed one's.
    expect(assembled.bundles.map((b) => b.concentration.outcome)).toEqual(["ok", "ok", "ok"]);
    const middle = assembled.bundles[1]?.concentration;
    if (middle?.outcome !== "ok") throw new Error("unreachable");
    expect(middle.value.pair).toBe("DOGEUSD");
    expect(middle.value.rowsRead).toBe(1);
  });

  it("does one bot-list read for N candidates and reports it", async () => {
    await bot("b1", "BTCUSD", 1_000n * ONE);

    let reads = 0;
    const counting = {
      accounts: { findOne: db.accounts.findOne.bind(db.accounts) },
      botInstances: {
        findMany: async (...args: unknown[]) => {
          reads += 1;
          return (db.botInstances.findMany as (...a: unknown[]) => unknown)(...args);
        },
      },
    } as unknown as Database;

    const set = candidateSet([
      candidate({ pair: "BTCUSD" }),
      candidate({ pair: "ETHUSD" }),
      candidate({ pair: "SOLUSD" }),
    ]);
    const assembled = await gatherCandidateSetData(ports({ db: counting }), set, REQUEST);

    expect(reads).toBe(1);
    expect(assembled.exposure.outcome).toBe("ok");
    if (assembled.exposure.outcome !== "ok") throw new Error("unreachable");
    // 21.5 requirement 2's "the actual raw data it used".
    expect(assembled.exposure.value.rowsRead).toBe(1);
    expect(assembled.exposure.value.committed.map((b) => b.id)).toEqual(["b1"]);
  });

  it("records the shared read's failure on every candidate, candles intact", async () => {
    const set = candidateSet([candidate({ pair: "BTCUSD" }), candidate({ pair: "ETHUSD" })]);
    const assembled = await gatherCandidateSetData(
      ports({ db: unreadableBotList("d1") }),
      set,
      REQUEST,
    );

    expect(assembled.exposure.outcome).toBe("failed");
    if (assembled.exposure.outcome !== "failed") throw new Error("unreachable");

    for (const bundle of assembled.bundles) {
      expect(bundle.concentration.outcome).toBe("failed");
      if (bundle.concentration.outcome !== "failed") throw new Error("unreachable");
      // The read's OWN error, propagated by identity -- not a second one
      // invented per candidate, which would restate one fact N times and let
      // the copies drift.
      expect(bundle.concentration.error.code).toBe("bot_list_unreadable");
      expect(bundle.concentration.error).toBe(assembled.exposure.error);
      // And every candidate still has its candles.
      expect(bundle.candles.outcome).toBe("ok");
    }
  });

  it("works unchanged for a named set of one (21.2: not two code paths)", async () => {
    await bot("b1", "BTCUSD", 1_000n * ONE);

    const named = candidateSet([candidate()], {
      entryPoint: "named",
      watchlist: null,
      trending: null,
    });
    const assembled = await gatherCandidateSetData(ports(), named, REQUEST);

    expect(assembled.bundles).toHaveLength(1);
    expect(assembled.bundles[0]?.candles.outcome).toBe("ok");
    expect(assembled.bundles[0]?.concentration.outcome).toBe("ok");
    expect(assembled.bundles[0]?.news).toBe(NEWS_NOT_YET_AVAILABLE);
    expect(assembled.set.trending).toBeNull();
  });

  it("returns no bundles, and no error, for an empty set", async () => {
    const assembled = await gatherCandidateSetData(ports(), candidateSet([]), REQUEST);
    // A quiet day is a real answer from the general entry point, not a failure.
    expect(assembled.bundles).toEqual([]);
    expect(assembled.exposure.outcome).toBe("ok");
  });

  it("merges the operator's stated quote assets into the base-asset split", async () => {
    // Every bot is USD, so the observed set cannot split a USDT candidate --
    // exactly the case `AssessConcentrationOptions.quoteAssets` exists for.
    await bot("b1", "BTCUSD", 1_000n * ONE);

    const withoutHelp = await gatherCandidateSetData(
      ports(),
      candidateSet([candidate({ pair: "SOLUSD" })], {
        trending: null,
      }),
      REQUEST,
    );
    const first = withoutHelp.bundles[0]?.concentration;
    if (first?.outcome !== "ok") throw new Error("unreachable");
    // "USD" IS observed, so this one splits regardless -- the assertion is that
    // the set's own quote assets are the source of the extra ones below.
    expect(first.value.quoteAssetsConsidered).toEqual(["USD"]);

    const withHelp = await gatherCandidateSetData(
      ports(),
      candidateSet([candidate({ pair: "SOLUSD" })], {
        trending: {
          pullId: "pull-1",
          vendor: "stub",
          fetchedAt: T0,
          quoteAssets: ["USDC"],
          returned: 0,
          accepted: 0,
          pairsMatched: 0,
          rejected: [],
        },
      }),
      REQUEST,
    );
    const second = withHelp.bundles[0]?.concentration;
    if (second?.outcome !== "ok") throw new Error("unreachable");
    // Read off `CandidateSet.trending`, not restated by the caller.
    expect(second.value.quoteAssetsConsidered).toEqual(["USDC", "USD"]);
  });
});

function assessments(bundles: readonly CandidateGatherBundle[]): string[] {
  return bundles.map((bundle) =>
    bundle.concentration.outcome === "ok" ? bundle.concentration.value.assessment : "failed",
  );
}

// ---------------------------------------------------------------------------
// Stage 3's second gather: the two REAL extra reads
// ---------------------------------------------------------------------------

/**
 * `gatherDeriveContext` holds the same four properties as the bundle above --
 * every failure recorded on its own slot, no failure erasing another's result,
 * never throwing, each read keeping its own timestamp -- plus one that is new
 * and is the reason it exists at all: THE CAPITAL FIGURE IS THE REAL ONE, read
 * from `capital_ledger` through the real repository and the real migrations.
 *
 * The database here is real. The symbol-details port is a stub, as every venue
 * port in this folder is.
 */
const SYMBOL_FILTERS: SymbolFilters = {
  pair: "BTCUSD",
  baseAsset: "BTC",
  quoteAsset: "USD",
  status: "TRADING",
  tickSize: 1_000_000n,
  minPrice: 0n,
  maxPrice: 0n,
  stepSize: 100_000n,
  minQuantity: 100_000n,
  maxQuantity: 0n,
  // Gemini's real shape: NO notional bounds published. See `parseSymbolDetails`.
  minNotional: 0n,
  maxNotional: 0n,
  fetchedAt: VENUE_ANSWERED_AT,
};

const symbolDetails: SymbolDetailSource = async () => ({
  ok: true,
  value: SYMBOL_FILTERS,
  at: VENUE_ANSWERED_AT,
});

const symbolDetailsDown: SymbolDetailSource = async () => ({
  ok: false,
  kind: "transport",
  message: "connect ETIMEDOUT",
  retryable: true,
  at: VENUE_ANSWERED_AT,
});

function derivePorts(overrides: Partial<DeriveContextPorts> = {}): DeriveContextPorts {
  return { ...ports(), getSymbolDetails: symbolDetails, ...overrides };
}

async function seedLedger(overrides: Partial<CapitalLedgerRow> = {}): Promise<void> {
  await db.capitalLedger.insert(
    capitalLedgerRow({
      account_label: "gemini-main",
      asset: "USD",
      total_balance: 500_000_000_000n,
      total_allocated: 100_000_000_000n,
      ...overrides,
    }),
  );
}

describe("gatherDeriveContext", () => {
  it("reads the account's REAL capital headroom from capital_ledger", async () => {
    await seedLedger();
    const bundle = await gatherCandidateData(ports(), candidate(), REQUEST);

    const derived = await gatherDeriveContext(derivePorts(), bundle);

    if (derived.capital.outcome !== "ok") throw new Error("unreachable");
    expect(derived.capital.value.rowsRead).toBe(1);
    // 5000 - 1000, exactly, from the real codec.
    expect(derived.capital.value.assets[0]!.available).toBe(400_000_000_000n);
    expect(derived.capital.value.assets[0]!.asset).toBe("USD");
  });

  it("reads the pair's REAL trading filters through the same port the create-bot gate uses", async () => {
    await seedLedger();
    const bundle = await gatherCandidateData(ports(), candidate(), REQUEST);

    const derived = await gatherDeriveContext(derivePorts(), bundle);

    if (derived.filters.outcome !== "ok") throw new Error("unreachable");
    expect(derived.filters.value.minQuantity).toBe(100_000n);
    expect(derived.filters.value.pair).toBe("BTCUSD");
  });

  it("asks the venue about THIS candidate's account and pair, not a restated one", async () => {
    await seedLedger();
    const seen: { label?: string; pair?: string } = {};
    const spy: SymbolDetailSource = async (account, pair) => {
      seen.label = account.label;
      seen.pair = pair;
      return { ok: true, value: SYMBOL_FILTERS, at: VENUE_ANSWERED_AT };
    };
    const bundle = await gatherCandidateData(ports(), candidate({ pair: "ETHUSD" }), REQUEST);

    await gatherDeriveContext(derivePorts({ getSymbolDetails: spy }), bundle);

    expect(seen.label).toBe("gemini-main");
    expect(seen.pair).toBe("ETHUSD");
  });

  it("records a failed filter read WITHOUT losing the capital figure", async () => {
    await seedLedger();
    const bundle = await gatherCandidateData(ports(), candidate(), REQUEST);

    const derived = await gatherDeriveContext(
      derivePorts({ getSymbolDetails: symbolDetailsDown }),
      bundle,
    );

    expect(derived.filters.outcome).toBe("failed");
    if (derived.filters.outcome !== "failed") throw new Error("unreachable");
    // The venue's OWN words, not a second vocabulary describing them.
    expect(derived.filters.error.message).toContain("transport");
    expect(derived.filters.error.message).toContain("ETIMEDOUT");
    // Isolation, in the direction that matters.
    expect(derived.capital.outcome).toBe("ok");
  });

  it("records a failed capital read WITHOUT losing the filters", async () => {
    const bundle = await gatherCandidateData(ports(), candidate(), REQUEST);
    const brokenLedger = {
      ...db,
      capitalLedger: {
        findMany: async () => {
          throw new Error("D1_ERROR: Network connection lost");
        },
      },
    } as unknown as Database;

    const derived = await gatherDeriveContext(derivePorts({ db: brokenLedger }), bundle);

    expect(derived.capital.outcome).toBe("failed");
    if (derived.capital.outcome !== "failed") throw new Error("unreachable");
    expect(derived.capital.error.code).toBe("ledger_unreadable");
    expect(derived.filters.outcome).toBe("ok");
  });

  it("never throws, whatever both reads do", async () => {
    const bundle = await gatherCandidateData(ports(), candidate(), REQUEST);
    const brokenLedger = {
      ...db,
      capitalLedger: {
        findMany: async () => {
          throw new Error("everything is on fire");
        },
      },
    } as unknown as Database;

    const derived = await gatherDeriveContext(
      derivePorts({ db: brokenLedger, getSymbolDetails: symbolDetailsDown }),
      bundle,
    );

    expect(derived.capital.outcome).toBe("failed");
    expect(derived.filters.outcome).toBe("failed");
    // And the bundle it was given survives untouched.
    expect(derived.bundle).toBe(bundle);
  });

  it("reports an account with no ledger row as a successful read, not a failure", async () => {
    const bundle = await gatherCandidateData(ports(), candidate(), REQUEST);
    const derived = await gatherDeriveContext(derivePorts(), bundle);

    expect(derived.capital.outcome).toBe("ok");
    if (derived.capital.outcome !== "ok") throw new Error("unreachable");
    expect(derived.capital.value.assets).toEqual([]);
  });

  it("keeps its own gather time separate from either read's", async () => {
    await seedLedger();
    const bundle = await gatherCandidateData(ports(), candidate(), REQUEST);
    const derived = await gatherDeriveContext(derivePorts(), bundle);

    if (derived.capital.outcome !== "ok" || derived.filters.outcome !== "ok") {
      throw new Error("unreachable");
    }
    // `gatheredAt` is when assembly ran; the ledger read has its own instant and
    // the venue answered at its own. Three distinct times, none manufactured
    // from another (21.5 requirement 4).
    expect(derived.gatheredAt).not.toBe(derived.capital.value.readAt);
    expect(derived.filters.value.fetchedAt).toBe(VENUE_ANSWERED_AT);
  });

  it("does NOT read symbol details during the ordinary Stage 1 gather", async () => {
    // The cost argument on `DeriveContext`: a per-symbol uncached request must
    // not be spent on every Assess run. A port that throws if touched proves it.
    let touched = 0;
    const tripwire: SymbolDetailSource = async () => {
      touched += 1;
      return { ok: true, value: SYMBOL_FILTERS, at: VENUE_ANSWERED_AT };
    };
    await gatherCandidateData({ ...ports(), getSymbolDetails: tripwire } as never, candidate(), REQUEST);
    expect(touched).toBe(0);
  });
});
