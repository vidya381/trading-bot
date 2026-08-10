/**
 * Candidate selection: what it selects, and what it refuses to pretend.
 *
 * Five properties, each one this module would look correct without:
 *
 *  1. BOTH SOURCES FEED ONE LIST, and a coin on both is ONE candidate carrying
 *     TWO sources. Dedup that dropped provenance would pass any test that only
 *     counted candidates, and would destroy 21.5 requirement 2's "which
 *     watchlist entry, or which trending pull" permanently.
 *  2. TRENDING IS FILTERED THROUGH THE VENUE'S REAL CATALOGUE, via the same
 *     `checkTradable` the watchlist write path and the candle fetch use.
 *  3. A FAILED TRENDING PULL IS FATAL, not a silent fall back to the watchlist.
 *     This is the one requirement whose violation is invisible in the output:
 *     a watchlist-only set is a perfectly well-formed candidate set.
 *  4. "COULD NOT READ THE CATALOGUE" IS NOT "NOT LISTED". An outage must not
 *     be recorded as fifteen untradable coins.
 *  5. THE NAMED ENTRY POINT VALIDATES AGAINST THE SAME REAL TRADABLE SET, and
 *     refuses rather than returning an empty set.
 *
 * The exchange and the trending vendor are both stubs. NOTHING HERE HAS SPOKEN
 * TO GEMINI, BINANCE, OR ANY TRENDING VENDOR -- no trending vendor has been
 * chosen at all (see `candidates.ts`'s header and decision log 31).
 */

import { beforeEach, describe, expect, it } from "vitest";

import {
  CandidateSelectionError,
  selectGeneralCandidates,
  selectNamedCandidate,
  type CandidateSource,
  type GeneralCandidatePorts,
  type NamedCandidatePorts,
  type TrendingCoin,
  type TrendingSource,
} from "./candidates";
import type { TradablePairSource } from "./tradability";
import type { Database } from "../db/database";
import { accountRow, freshDatabase, watchlistRow } from "../db/test-helpers";

const T0 = 1_910_000_000_000;

/** The venue catalogues the stub lister answers with, per account. */
/**
 * The venue catalogues the stub lister answers with, per account.
 *
 * The two `...PERP` entries are REAL strings from Gemini's live catalogue,
 * observed during the trending verification run (decision log 31). They are
 * here so the perp test below is checking against a catalogue shaped like the
 * real one rather than one invented to make the test pass -- step 28's lesson
 * about fixtures that model the wrong catalogue.
 */
const CATALOGUE: Record<string, string[]> = {
  "gemini-main": [
    "BTCUSD",
    "ETHUSD",
    "SOLUSD",
    "LINKUSD",
    "DOGEUSD",
    "HYPEGUSDPERP",
    "HYPEUSDCPERP",
    // The shape of Perpetual Protocol's real spot ticker: contains "perp",
    // does not end in it, and must stay acceptable at every research path.
    "PERPUSD",
  ],
  main: ["BTCUSDT", "ETHUSDT"],
};

let db: Database;
let clock: number;
let ids: number;
let listingCalls: number;

beforeEach(async () => {
  db = await freshDatabase();
  await db.accounts.insert(accountRow({ account_label: "main", exchange: "binance" }));
  await db.accounts.insert(accountRow({ account_label: "gemini-main", exchange: "gemini" }));
  clock = T0;
  ids = 0;
  listingCalls = 0;
});

/** Advances, so two timestamps in one run are distinguishable. */
const now = () => (clock += 1_000);
const newId = () => `pull-${String((ids += 1)).padStart(3, "0")}`;

const listing: TradablePairSource = async (account) => {
  listingCalls += 1;
  return {
    ok: true,
    pairs: CATALOGUE[account.label] ?? [],
    cached: false,
    fetchedAt: T0,
  };
};

const unreadableListing: TradablePairSource = async () => {
  listingCalls += 1;
  return {
    ok: false,
    failure: {
      ok: false,
      kind: "transport",
      message: "connection reset",
      retryable: true,
      at: T0,
    },
  };
};

function coin(overrides: Partial<TrendingCoin> = {}): TrendingCoin {
  return {
    coinId: "solana",
    symbol: "SOL",
    name: "Solana",
    rank: 0,
    raw: { id: "solana", score: 0 },
    ...overrides,
  };
}

function trending(coins: readonly TrendingCoin[], vendor = "stub-vendor"): TrendingSource {
  return async () => ({ ok: true, value: { vendor, coins }, at: T0 + 500 });
}

const failedTrending: TrendingSource = async () => ({
  ok: false,
  kind: "transport",
  message: "trending host did not answer",
  retryable: true,
  at: T0 + 500,
});

function generalPorts(overrides: Partial<GeneralCandidatePorts> = {}): GeneralCandidatePorts {
  return {
    db,
    listTradablePairs: listing,
    fetchTrending: trending([]),
    now,
    newId,
    ...overrides,
  };
}

function namedPorts(overrides: Partial<NamedCandidatePorts> = {}): NamedCandidatePorts {
  return { db, listTradablePairs: listing, now, ...overrides };
}

/** Add a live watchlist row for the Gemini account. */
async function watch(
  pair: string,
  overrides: Partial<{ id: string; note: string; addedAt: number }> = {},
) {
  await db.watchlist.insert(
    watchlistRow({
      id: overrides.id ?? `wl-${pair}`,
      account_label: "gemini-main",
      pair,
      note: overrides.note ?? `${pair} is on the list on purpose`,
      added_by: "owner@example.com",
      added_at: overrides.addedAt ?? T0 - 10_000,
    }),
  );
}

const GENERAL = {
  accountLabel: "gemini-main",
  requestedBy: "owner@example.com",
  quoteAssets: ["USD"],
} as const;

function sourceKinds(sources: readonly CandidateSource[]): string[] {
  return sources.map((source) => source.kind);
}

describe("selectGeneralCandidates: the watchlist half", () => {
  it("returns the watchlist's live entries, in the read path's order", async () => {
    await watch("BTCUSD", { id: "wl-1" });
    await watch("ETHUSD", { id: "wl-2" });

    const set = await selectGeneralCandidates(generalPorts(), GENERAL);

    expect(set.entryPoint).toBe("general");
    expect(set.candidates.map((c) => c.pair)).toEqual(["BTCUSD", "ETHUSD"]);
    expect(set.watchlist).toEqual({ readAt: expect.any(Number), entriesRead: 2 });
    expect(set.trending?.returned).toBe(0);
  });

  it("carries which watchlist entry, its note and its author on every candidate", async () => {
    await watch("BTCUSD", { id: "wl-42", note: "deepest book on the venue" });

    const set = await selectGeneralCandidates(generalPorts(), GENERAL);

    expect(set.candidates[0]?.sources).toEqual([
      {
        kind: "watchlist",
        entryId: "wl-42",
        note: "deepest book on the venue",
        addedBy: "owner@example.com",
        addedAt: T0 - 10_000,
      },
    ]);
  });

  it("reads only this account's live entries", async () => {
    await watch("BTCUSD");
    await db.watchlist.insert(
      watchlistRow({ id: "wl-other", account_label: "main", pair: "ETHUSDT" }),
    );
    await db.watchlist.insert(
      watchlistRow({
        id: "wl-removed",
        account_label: "gemini-main",
        pair: "LINKUSD",
        removed_by: "owner@example.com",
        removed_at: T0 - 5_000,
      }),
    );

    const set = await selectGeneralCandidates(generalPorts(), GENERAL);

    expect(set.candidates.map((c) => c.pair)).toEqual(["BTCUSD"]);
    expect(set.watchlist?.entriesRead).toBe(1);
  });

  it("does not re-check a watchlist pair against the venue", async () => {
    // Recorded as a deviation in the module header rather than a gap: a pair
    // delisted after it was added stays a candidate until someone removes it.
    await watch("DELISTEDUSD");

    const set = await selectGeneralCandidates(generalPorts(), GENERAL);

    expect(CATALOGUE["gemini-main"]).not.toContain("DELISTEDUSD");
    expect(set.candidates.map((c) => c.pair)).toEqual(["DELISTEDUSD"]);
  });
});

describe("selectGeneralCandidates: the trending half", () => {
  it("admits a trending coin the venue lists, with the vendor's own detail", async () => {
    const ports = generalPorts({
      fetchTrending: trending([coin({ coinId: "solana", symbol: "SOL", rank: 3 })], "gecko-stub"),
    });

    const set = await selectGeneralCandidates(ports, GENERAL);

    expect(set.candidates.map((c) => c.pair)).toEqual(["SOLUSD"]);
    expect(set.candidates[0]?.sources).toEqual([
      {
        kind: "trending",
        pullId: "pull-001",
        vendor: "gecko-stub",
        fetchedAt: T0 + 500,
        coinId: "solana",
        symbol: "SOL",
        name: "Solana",
        rank: 3,
        raw: { id: "solana", score: 0 },
      },
    ]);
    expect(set.trending).toMatchObject({
      pullId: "pull-001",
      vendor: "gecko-stub",
      fetchedAt: T0 + 500,
      quoteAssets: ["USD"],
      returned: 1,
      accepted: 1,
      pairsMatched: 1,
      rejected: [],
    });
  });

  it("carries the vendor's raw item by identity, not a copy", async () => {
    const raw = { id: "solana", score: 0, data: { total_volume: "$1" } };
    const ports = generalPorts({ fetchTrending: trending([coin({ raw })]) });

    const set = await selectGeneralCandidates(ports, GENERAL);
    const source = set.candidates[0]?.sources[0];

    expect(source?.kind).toBe("trending");
    expect(source?.kind === "trending" && source.raw).toBe(raw);
  });

  it("filters out a trending coin the venue does not list, and says what it tried", async () => {
    const ports = generalPorts({
      fetchTrending: trending([
        coin({ coinId: "solana", symbol: "SOL" }),
        coin({ coinId: "some-new-thing", symbol: "NEWCOIN", name: "New Thing", rank: 1 }),
      ]),
    });

    const set = await selectGeneralCandidates(ports, GENERAL);

    expect(set.candidates.map((c) => c.pair)).toEqual(["SOLUSD"]);
    expect(set.trending?.returned).toBe(2);
    expect(set.trending?.accepted).toBe(1);
    expect(set.trending?.rejected).toEqual([
      {
        coinId: "some-new-thing",
        symbol: "NEWCOIN",
        name: "New Thing",
        rank: 1,
        triedPairs: ["NEWCOINUSD"],
        reason: "not_tradable",
      },
    ]);
  });

  it("keeps accepted + rejected equal to what the vendor returned", async () => {
    const ports = generalPorts({
      fetchTrending: trending([
        coin({ symbol: "SOL" }),
        coin({ coinId: "a", symbol: "NOPE" }),
        coin({ coinId: "b", symbol: "  " }),
        coin({ coinId: "c", symbol: "LINK" }),
      ]),
    });

    const set = await selectGeneralCandidates(ports, GENERAL);
    const report = set.trending;

    expect(report).not.toBeNull();
    expect((report?.accepted ?? 0) + (report?.rejected.length ?? 0)).toBe(report?.returned);
  });

  it("does not treat a venue's perpetual pairs as a spelling variant of spot", async () => {
    // A REAL case from the live trending run (decision log 31): HYPE trended,
    // Gemini does not list HYPEUSD, and its catalogue DOES carry HYPEGUSDPERP
    // and HYPEUSDCPERP. A perpetual is a DIFFERENT INSTRUMENT -- different
    // margin, funding and liquidation semantics -- and every order, fill and
    // PnL path in this system is spot. Surfacing one as "that venue spells it
    // ..." would invite an operator to trade something this system cannot.
    //
    // It holds because `checkTradable`'s near-match is an exact
    // case-insensitive equality, not a prefix or substring match. That was
    // INCIDENTAL when it was written -- nothing in this repository knew what a
    // perpetual was -- and it is still the near-match rule doing the work here,
    // not the naming heuristic added later: `${BASE}${QUOTE}` cannot construct
    // a `PERP` suffix, so this path never presents one to be name-matched.
    // Pinned so that a later, fuzzier near-match -- which would look like a
    // usability improvement in isolation -- cannot quietly start recommending
    // one.
    const ports = generalPorts({
      fetchTrending: trending([
        coin({ coinId: "hyperliquid", symbol: "HYPE", name: "Hyperliquid", rank: 11 }),
      ]),
    });

    const set = await selectGeneralCandidates(ports, GENERAL);

    expect(CATALOGUE["gemini-main"]).toContain("HYPEGUSDPERP");
    expect(set.candidates).toEqual([]);
    expect(set.trending?.rejected).toEqual([
      {
        coinId: "hyperliquid",
        symbol: "HYPE",
        name: "Hyperliquid",
        rank: 11,
        triedPairs: ["HYPEUSD"],
        reason: "not_tradable",
      },
    ]);
    // Nothing perp-shaped reaches the caller by ANY route -- not as a
    // candidate, not as a near-match in a message, not in the report.
    expect(JSON.stringify(set)).not.toContain("PERP");
  });

  it("records a blank vendor symbol as unusable rather than as untradable", async () => {
    const ports = generalPorts({
      fetchTrending: trending([coin({ coinId: "mystery", symbol: "   ", name: "Mystery" })]),
    });

    const set = await selectGeneralCandidates(ports, GENERAL);

    expect(set.candidates).toEqual([]);
    expect(set.trending?.rejected).toEqual([
      {
        coinId: "mystery",
        symbol: "   ",
        name: "Mystery",
        rank: 0,
        triedPairs: [],
        reason: "unusable_symbol",
      },
    ]);
  });

  it("upper-cases a vendor ticker to form the hypothesis, and stores the venue's spelling", async () => {
    const ports = generalPorts({ fetchTrending: trending([coin({ symbol: "sol" })]) });

    const set = await selectGeneralCandidates(ports, GENERAL);

    expect(set.candidates.map((c) => c.pair)).toEqual(["SOLUSD"]);
    const source = set.candidates[0]?.sources[0];
    // The vendor's own spelling is kept verbatim on the source; only the pair
    // is in this system's convention.
    expect(source?.kind === "trending" && source.symbol).toBe("sol");
  });

  it("tries every quote asset and matches each listed one", async () => {
    const ports = generalPorts({ fetchTrending: trending([coin({ symbol: "BTC" })]) });

    const set = await selectGeneralCandidates(ports, {
      ...GENERAL,
      quoteAssets: ["USD", "EUR"],
    });

    expect(set.candidates.map((c) => c.pair)).toEqual(["BTCUSD"]);
    expect(set.trending?.accepted).toBe(1);
    expect(set.trending?.pairsMatched).toBe(1);
    expect(set.trending?.quoteAssets).toEqual(["USD", "EUR"]);
  });

  it("normalises and deduplicates the quote assets", async () => {
    const ports = generalPorts({ fetchTrending: trending([coin({ symbol: "SOL" })]) });

    const set = await selectGeneralCandidates(ports, {
      ...GENERAL,
      quoteAssets: [" usd ", "USD", ""],
    });

    expect(set.trending?.quoteAssets).toEqual(["USD"]);
    expect(set.trending?.rejected).toEqual([]);
    expect(set.candidates.map((c) => c.pair)).toEqual(["SOLUSD"]);
  });

  it("refuses an empty quote-asset list rather than defaulting one", async () => {
    await expect(
      selectGeneralCandidates(generalPorts(), { ...GENERAL, quoteAssets: [] }),
    ).rejects.toMatchObject({ code: "missing_field" });
    await expect(
      selectGeneralCandidates(generalPorts(), { ...GENERAL, quoteAssets: ["  "] }),
    ).rejects.toMatchObject({ code: "missing_field" });
  });

  it("checks trending pairs through the same cached listing path, not a second one", async () => {
    const ports = generalPorts({
      fetchTrending: trending([coin({ symbol: "SOL" }), coin({ coinId: "l", symbol: "LINK" })]),
    });

    await selectGeneralCandidates(ports, GENERAL);

    // Two coins, one quote asset: the shared `checkTradable` asks the port once
    // per hypothesis, which in production is `listAccountSymbols` and its KV
    // cache -- the same path the watchlist and the candle fetch use.
    expect(listingCalls).toBe(2);
  });
});

describe("selectGeneralCandidates: dedup preserves provenance", () => {
  it("merges a coin on both sources into one candidate with both sources", async () => {
    await watch("BTCUSD", { id: "wl-btc", note: "the reference pair" });
    const ports = generalPorts({
      fetchTrending: trending([coin({ coinId: "bitcoin", symbol: "BTC", name: "Bitcoin", rank: 2 })]),
    });

    const set = await selectGeneralCandidates(ports, GENERAL);

    expect(set.candidates).toHaveLength(1);
    const candidate = set.candidates[0];
    expect(candidate?.pair).toBe("BTCUSD");
    expect(sourceKinds(candidate?.sources ?? [])).toEqual(["watchlist", "trending"]);
    expect(candidate?.sources[0]).toMatchObject({ kind: "watchlist", entryId: "wl-btc" });
    expect(candidate?.sources[1]).toMatchObject({
      kind: "trending",
      coinId: "bitcoin",
      rank: 2,
      pullId: "pull-001",
    });
    // The overlap is still counted by both halves: it was read, and it trended.
    expect(set.watchlist?.entriesRead).toBe(1);
    expect(set.trending?.accepted).toBe(1);
  });

  it("keeps the merged candidate in its watchlist position", async () => {
    await watch("BTCUSD", { id: "wl-btc" });
    await watch("ETHUSD", { id: "wl-eth" });
    const ports = generalPorts({
      fetchTrending: trending([
        coin({ coinId: "solana", symbol: "SOL" }),
        coin({ coinId: "ethereum", symbol: "ETH" }),
      ]),
    });

    const set = await selectGeneralCandidates(ports, GENERAL);

    expect(set.candidates.map((c) => c.pair)).toEqual(["BTCUSD", "ETHUSD", "SOLUSD"]);
    expect(sourceKinds(set.candidates[1]?.sources ?? [])).toEqual(["watchlist", "trending"]);
    expect(sourceKinds(set.candidates[2]?.sources ?? [])).toEqual(["trending"]);
  });

  it("orders by first appearance, not by pair name", async () => {
    // Every other fixture here happens to be alphabetical, so a mutant that
    // sorted the pairs survived the whole ordering suite. These three are
    // deliberately not: watchlist order is SOL then BTC, and ETH arrives last
    // from trending, so an alphabetical answer is visibly a different answer.
    await watch("SOLUSD", { id: "wl-b", addedAt: T0 - 30_000 });
    await watch("BTCUSD", { id: "wl-a", addedAt: T0 - 20_000 });
    const ports = generalPorts({
      fetchTrending: trending([coin({ coinId: "ethereum", symbol: "ETH" })]),
    });

    const set = await selectGeneralCandidates(ports, GENERAL);

    expect(set.candidates.map((c) => c.pair)).toEqual(["SOLUSD", "BTCUSD", "ETHUSD"]);
  });

  it("keeps a merged candidate at its first appearance even when that is not first alphabetically", async () => {
    await watch("SOLUSD", { id: "wl-b", addedAt: T0 - 30_000 });
    await watch("BTCUSD", { id: "wl-a", addedAt: T0 - 20_000 });
    const ports = generalPorts({
      fetchTrending: trending([
        coin({ coinId: "bitcoin", symbol: "BTC" }),
        coin({ coinId: "ethereum", symbol: "ETH" }),
      ]),
    });

    const set = await selectGeneralCandidates(ports, GENERAL);

    expect(set.candidates.map((c) => c.pair)).toEqual(["SOLUSD", "BTCUSD", "ETHUSD"]);
    expect(sourceKinds(set.candidates[1]?.sources ?? [])).toEqual(["watchlist", "trending"]);
  });

  it("merges rather than duplicates when one vendor returns the same coin twice", async () => {
    const ports = generalPorts({
      fetchTrending: trending([
        coin({ coinId: "solana", symbol: "SOL", rank: 0 }),
        coin({ coinId: "solana-again", symbol: "SOL", rank: 7 }),
      ]),
    });

    const set = await selectGeneralCandidates(ports, GENERAL);

    expect(set.candidates).toHaveLength(1);
    expect(set.candidates[0]?.sources).toHaveLength(2);
    expect(set.candidates[0]?.sources.map((s) => (s.kind === "trending" ? s.rank : null))).toEqual([
      0, 7,
    ]);
    expect(set.trending?.accepted).toBe(2);
  });

  it("gives every candidate at least one source", async () => {
    await watch("BTCUSD");
    const ports = generalPorts({ fetchTrending: trending([coin({ symbol: "SOL" })]) });

    const set = await selectGeneralCandidates(ports, GENERAL);

    expect(set.candidates).toHaveLength(2);
    for (const candidate of set.candidates) {
      expect(candidate.sources.length).toBeGreaterThan(0);
    }
  });
});

describe("selectGeneralCandidates: fail closed", () => {
  it("refuses the whole run when the trending pull fails", async () => {
    await watch("BTCUSD");
    await watch("ETHUSD");
    const ports = generalPorts({ fetchTrending: failedTrending });

    const error = await selectGeneralCandidates(ports, GENERAL).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(CandidateSelectionError);
    expect((error as CandidateSelectionError).code).toBe("trending_unavailable");
    // The message names what was lost, so an operator reading only the failure
    // knows a watchlist-only set existed and was deliberately not returned.
    expect((error as Error).message).toContain("trending host did not answer");
    expect((error as Error).message).toContain("2 watchlist entries");
  });

  it("does not return watchlist candidates when trending is unreachable", async () => {
    await watch("BTCUSD");
    const ports = generalPorts({ fetchTrending: failedTrending });

    // The property under test is that no CandidateSet exists at all -- not that
    // it is empty. An empty-but-returned set is a well-formed answer to a
    // question nobody asked, which is the degradation 21.5 requirement 6 names.
    await expect(selectGeneralCandidates(ports, GENERAL)).rejects.toBeInstanceOf(
      CandidateSelectionError,
    );
  });

  it("refuses when the tradable set cannot be read, rather than rejecting every coin", async () => {
    await watch("BTCUSD");
    const ports = generalPorts({
      listTradablePairs: unreadableListing,
      fetchTrending: trending([coin({ symbol: "SOL" }), coin({ coinId: "l", symbol: "LINK" })]),
    });

    const error = await selectGeneralCandidates(ports, GENERAL).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(CandidateSelectionError);
    expect((error as CandidateSelectionError).code).toBe("tradable_set_unreadable");
    // It aborts on the FIRST unreadable answer rather than grinding through
    // every coin to reach the same conclusion.
    expect(listingCalls).toBe(1);
  });

  it("refuses an unknown account before spending a trending pull", async () => {
    let pulled = 0;
    const ports = generalPorts({
      fetchTrending: async () => {
        pulled += 1;
        return { ok: true, value: { vendor: "stub-vendor", coins: [] }, at: T0 };
      },
    });

    await expect(
      selectGeneralCandidates(ports, { ...GENERAL, accountLabel: "no-such-account" }),
    ).rejects.toMatchObject({ code: "unknown_account" });
    expect(pulled).toBe(0);
    expect(listingCalls).toBe(0);
  });

  it("refuses a blank requester", async () => {
    await expect(
      selectGeneralCandidates(generalPorts(), { ...GENERAL, requestedBy: "   " }),
    ).rejects.toMatchObject({ code: "missing_field" });
  });
});

describe("selectGeneralCandidates: the empty case is a fact, not a failure", () => {
  it("returns an empty candidate list with a full account of why", async () => {
    const ports = generalPorts({
      fetchTrending: trending([coin({ coinId: "x", symbol: "NEWCOIN", name: "New" })]),
    });

    const set = await selectGeneralCandidates(ports, GENERAL);

    expect(set.candidates).toEqual([]);
    expect(set.watchlist?.entriesRead).toBe(0);
    expect(set.trending?.returned).toBe(1);
    expect(set.trending?.accepted).toBe(0);
    expect(set.trending?.rejected[0]?.triedPairs).toEqual(["NEWCOINUSD"]);
  });
});

describe("selectNamedCandidate", () => {
  it("returns the one coin the human named, validated against the venue", async () => {
    const set = await selectNamedCandidate(namedPorts(), {
      accountLabel: "gemini-main",
      pair: "BTCUSD",
      requestedBy: "owner@example.com",
    });

    expect(set.entryPoint).toBe("named");
    expect(set.exchange).toBe("gemini");
    expect(set.candidates.map((c) => c.pair)).toEqual(["BTCUSD"]);
    expect(set.candidates[0]?.sources).toEqual([
      {
        kind: "named",
        requestedAs: "BTCUSD",
        requestedBy: "owner@example.com",
        requestedAt: expect.any(Number),
      },
    ]);
    // Neither of 21.3's sources was consulted, and the result says so rather
    // than reporting a read of zero entries that never happened.
    expect(set.watchlist).toBeNull();
    expect(set.trending).toBeNull();
  });

  it("keeps what the human typed beside the pair that was validated", async () => {
    const set = await selectNamedCandidate(namedPorts(), {
      accountLabel: "gemini-main",
      pair: "  BTCUSD  ",
      requestedBy: "owner@example.com",
    });

    expect(set.candidates[0]?.pair).toBe("BTCUSD");
    expect(set.candidates[0]?.sources[0]).toMatchObject({ requestedAs: "  BTCUSD  " });
  });

  it("refuses a pair the venue does not list", async () => {
    const error = await selectNamedCandidate(namedPorts(), {
      accountLabel: "gemini-main",
      pair: "NEWCOINUSD",
      requestedBy: "owner@example.com",
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(CandidateSelectionError);
    expect((error as CandidateSelectionError).code).toBe("pair_not_tradable");
  });

  it("refuses a lowercase pair, naming the venue's own spelling", async () => {
    // Step 28's live finding: the comparison is exact and case-sensitive, and
    // the refusal carries near-matches so the caller is told the real spelling.
    const error = await selectNamedCandidate(namedPorts(), {
      accountLabel: "gemini-main",
      pair: "btcusd",
      requestedBy: "owner@example.com",
    }).catch((e: unknown) => e);

    expect((error as CandidateSelectionError).code).toBe("pair_not_tradable");
    expect((error as Error).message).toContain('"BTCUSD"');
  });

  it("never offers a perpetual pair as the venue's spelling of a spot pair", async () => {
    // The path that would actually leak one. `selectGeneralCandidates` records
    // only a reason and the tried pairs, so a bad near-match cannot reach its
    // caller; this function propagates `checkTradable`'s message VERBATIM, so
    // a near-match widened from exact equality to a prefix or substring test
    // would answer "HYPEUSD is not tradable -- that venue spells it
    // HYPEUSDCPERP", recommending a perpetual to a human by name.
    //
    // Verified as a real hole rather than assumed: with the near-match mutated
    // to `startsWith`, the general-path perp test above still PASSED and this
    // one fails. Nothing in this repository knows what a perpetual is, so this
    // assertion is the whole defence.
    const error = await selectNamedCandidate(namedPorts(), {
      accountLabel: "gemini-main",
      pair: "HYPEUSD",
      requestedBy: "owner@example.com",
    }).catch((e: unknown) => e);

    expect((error as CandidateSelectionError).code).toBe("pair_not_tradable");
    expect((error as Error).message).not.toContain("PERP");
    expect((error as Error).message).not.toContain("spells it");
  });

  it("refuses a perpetual the human named directly, which the venue does list", async () => {
    // THE HUMAN-TYPED PATH decision log 31 flagged. The test above is about a
    // perpetual being RECOMMENDED; this one is about one being ACCEPTED. An
    // operator who reads `HYPEUSDCPERP` off Gemini's own listing and asks for a
    // named research run on it got a valid candidate before step 33, because
    // the catalogue check's only question is whether the venue lists the
    // string -- and it does.
    //
    // A NAMING INFERENCE, not the structural `product_type` check the order
    // path uses. See `tradability.ts` for what it cannot promise.
    const error = await selectNamedCandidate(namedPorts(), {
      accountLabel: "gemini-main",
      pair: "HYPEUSDCPERP",
      requestedBy: "owner@example.com",
    }).catch((e: unknown) => e);

    expect((error as CandidateSelectionError).code).toBe("pair_not_spot_by_name");
    expect((error as Error).message).toContain("HYPEUSDCPERP");
  });

  it("accepts a named PERPUSD, which contains 'perp' but does not end in it", async () => {
    // The `endsWith`-versus-`includes` distinction at the named entry point.
    // Perpetual Protocol is a real token; refusing its spot pair as a
    // derivative is the false reject the heuristic is written to avoid.
    const set = await selectNamedCandidate(namedPorts(), {
      accountLabel: "gemini-main",
      pair: "PERPUSD",
      requestedBy: "owner@example.com",
    });

    expect(set.candidates.map((c) => c.pair)).toEqual(["PERPUSD"]);
  });

  it("refuses when the tradable set cannot be read", async () => {
    const error = await selectNamedCandidate(namedPorts({ listTradablePairs: unreadableListing }), {
      accountLabel: "gemini-main",
      pair: "BTCUSD",
      requestedBy: "owner@example.com",
    }).catch((e: unknown) => e);

    expect((error as CandidateSelectionError).code).toBe("tradable_set_unreadable");
  });

  it("refuses an unknown account before asking any venue", async () => {
    await expect(
      selectNamedCandidate(namedPorts(), {
        accountLabel: "no-such-account",
        pair: "BTCUSD",
        requestedBy: "owner@example.com",
      }),
    ).rejects.toMatchObject({ code: "unknown_account" });
    expect(listingCalls).toBe(0);
  });

  it("refuses a blank pair without spending a catalogue call", async () => {
    await expect(
      selectNamedCandidate(namedPorts(), {
        accountLabel: "gemini-main",
        pair: "   ",
        requestedBy: "owner@example.com",
      }),
    ).rejects.toMatchObject({ code: "missing_field" });
    expect(listingCalls).toBe(0);
  });

  it("refuses a blank requester", async () => {
    await expect(
      selectNamedCandidate(namedPorts(), {
        accountLabel: "gemini-main",
        pair: "BTCUSD",
        requestedBy: "",
      }),
    ).rejects.toMatchObject({ code: "missing_field" });
  });

  it("takes the exchange from the registry, not from the account label's shape", async () => {
    const set = await selectNamedCandidate(namedPorts(), {
      accountLabel: "main",
      pair: "BTCUSDT",
      requestedBy: "owner@example.com",
    });

    expect(set.exchange).toBe("binance");
    expect(set.candidates.map((c) => c.pair)).toEqual(["BTCUSDT"]);
  });
});

describe("the two entry points produce the same candidate shape (21.2)", () => {
  it("agrees on every field but the source kind", async () => {
    await watch("BTCUSD", { id: "wl-btc" });
    const general = await selectGeneralCandidates(generalPorts(), GENERAL);
    const named = await selectNamedCandidate(namedPorts(), {
      accountLabel: "gemini-main",
      pair: "BTCUSD",
      requestedBy: "owner@example.com",
    });

    const g = general.candidates[0];
    const n = named.candidates[0];
    expect(Object.keys(g ?? {}).sort()).toEqual(Object.keys(n ?? {}).sort());
    expect(g?.pair).toBe(n?.pair);
    expect(g?.accountLabel).toBe(n?.accountLabel);
    expect(g?.exchange).toBe(n?.exchange);
    expect(sourceKinds(g?.sources ?? [])).toEqual(["watchlist"]);
    expect(sourceKinds(n?.sources ?? [])).toEqual(["named"]);
  });
});
