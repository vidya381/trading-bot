/**
 * The watchlist's write-time guarantees, against real D1.
 *
 * Four properties, and each is one this module would look correct without:
 *
 *  1. THE CAP IS ENFORCED, not documented. 21.3's bound is the only thing
 *     between this feature and "an unbounded market-wide scan", which that
 *     section forbids in as many words.
 *  2. AN UNTRADABLE PAIR IS REFUSED, and so is a pair whose tradability could
 *     not be READ. The second is the one that rots quietly: an outage produces
 *     no tradable set, and storing the pair anyway leaves a row nothing ever
 *     validated in the one list whose value is that a human vouched for it.
 *  3. BOTH WRITES AUDIT THEMSELVES, through the existing `db.auditLog` path.
 *  4. THE READ PATH REPORTS CURRENT STATE -- live entries only, in a stable
 *     order, with removed ones gone from it and still present in the table.
 *
 * The exchange is a stub because the point here is the decision, not the
 * transport: `listTradablePairs` and its cache have their own tests, and driving
 * a real client would make these assertions depend on a venue's catalogue.
 */

import { beforeEach, describe, expect, it } from "vitest";

import {
  addToWatchlist,
  readWatchlist,
  removeFromWatchlist,
  watchlistSize,
  WatchlistError,
  WATCHLIST_MAX_ENTRIES,
  type TradablePairSource,
  type WatchlistAccount,
  type WatchlistPorts,
} from "./watchlist";
import type { Database } from "../db/database";
import { accountRow, freshDatabase, watchlistRow } from "../db/test-helpers";

const T0 = 1_910_000_000_000;

const GEMINI: WatchlistAccount = { label: "gemini-main", exchange: "gemini" };
const BINANCE: WatchlistAccount = { label: "main", exchange: "binance" };

/** The venue catalogues the stub lister answers with, per account. */
const CATALOGUE: Record<string, string[]> = {
  "gemini-main": ["BTCUSD", "ETHUSD", "SOLUSD", "LINKUSD", "DOGEUSD", "AVAXUSD"],
  main: ["BTCUSDT", "ETHUSDT"],
};

let db: Database;
let ids: number;
let clock: number;

/** Every account the lister knows about, so the `accounts` foreign key holds. */
beforeEach(async () => {
  db = await freshDatabase();
  await db.accounts.insert(accountRow({ account_label: "main", exchange: "binance" }));
  await db.accounts.insert(
    accountRow({ account_label: "gemini-main", exchange: "gemini" }),
  );
  ids = 0;
  clock = T0;
});

/** Distinct and ordered, so an id collision cannot make a test pass by accident. */
const newId = () => `id-${String((ids += 1)).padStart(3, "0")}`;
/** Advances, so `added_at` ordering is a real ordering rather than a tie. */
const now = () => (clock += 1_000);

const listing: TradablePairSource = async (account) => ({
  ok: true,
  pairs: [...(CATALOGUE[account.label] ?? [])],
  cached: false,
  fetchedAt: T0,
});

/** A lister that could not reach the venue at all. */
const unreadable: TradablePairSource = async () => ({
  ok: false,
  failure: {
    ok: false,
    kind: "transport",
    message: "connect ETIMEDOUT",
    retryable: true,
    at: T0,
  },
});

function portsWith(listTradablePairs: TradablePairSource = listing): WatchlistPorts {
  return { db, now, newId, listTradablePairs };
}

async function add(pair: string, account = GEMINI, note = "chosen for a reason") {
  return await addToWatchlist(portsWith(), { account, pair, note, actor: "owner@example.com" });
}

async function auditActions(): Promise<string[]> {
  const rows = await db.auditLog.findMany({
    orderBy: [{ column: "created_at", direction: "asc" }],
  });
  return rows.map((row) => row.action);
}

// ---------------------------------------------------------------------------
// 1. The cap
// ---------------------------------------------------------------------------

describe("the 10-entry cap", () => {
  it("accepts the tenth entry and refuses the eleventh", async () => {
    // The boundary in both directions in one test, because a cap tested only on
    // the rejecting side passes just as well when it is off by one and refuses
    // the tenth -- which would silently shrink 21.3's list to nine.
    for (const pair of ["BTCUSD", "ETHUSD", "SOLUSD", "LINKUSD", "DOGEUSD", "AVAXUSD"]) {
      await add(pair);
    }
    // Three more straight into the table, so the count reaches nine without
    // needing three more tradable symbols invented for the fixture.
    for (const n of [1, 2, 3]) {
      await db.watchlist.insert(watchlistRow({ id: `wl-pad-${n}`, pair: `PAD${n}` }));
    }
    expect(await watchlistSize(db)).toBe(WATCHLIST_MAX_ENTRIES - 1);

    // The tenth goes through.
    const tenth = await add("BTCUSDT", BINANCE);
    expect(tenth.exchangePair).toBe("BTCUSDT");
    expect(await watchlistSize(db)).toBe(WATCHLIST_MAX_ENTRIES);

    // The eleventh does not, and leaves the list exactly as it was.
    await expect(add("ETHUSDT", BINANCE)).rejects.toThrow(WatchlistError);
    await expect(add("ETHUSDT", BINANCE)).rejects.toMatchObject({ code: "cap_exceeded" });
    expect(await watchlistSize(db)).toBe(WATCHLIST_MAX_ENTRIES);
    expect(await db.watchlist.findOne({ pair: "ETHUSDT" })).toBeNull();
  });

  it("counts across accounts, not per account", async () => {
    // The bound protects the cost of a pipeline RUN -- candle fetches, news
    // fetches, two LLM calls PER CANDIDATE -- and that cost does not care which
    // account a candidate is registered under. A per-account cap would let two
    // accounts fund twenty candidates while each looked compliant.
    for (let i = 0; i < WATCHLIST_MAX_ENTRIES; i += 1) {
      await db.watchlist.insert(
        watchlistRow({ id: `wl-${i}`, account_label: "gemini-main", pair: `pad${i}` }),
      );
    }
    await expect(add("BTCUSDT", BINANCE)).rejects.toMatchObject({ code: "cap_exceeded" });
  });

  it("counts only LIVE entries, so a removal makes room again", async () => {
    // If the count included soft-deleted rows the list would be permanently
    // full after ten edits, which is the failure mode a soft delete introduces
    // and the reason the count carries `removed_at: null`.
    for (let i = 0; i < WATCHLIST_MAX_ENTRIES; i += 1) {
      await db.watchlist.insert(
        watchlistRow({ id: `wl-${i}`, pair: `pad${i}`, account_label: "gemini-main" }),
      );
    }
    await expect(add("BTCUSD")).rejects.toMatchObject({ code: "cap_exceeded" });

    await removeFromWatchlist(portsWith(), {
      account: GEMINI,
      pair: "pad0",
      actor: "owner@example.com",
    });

    const entry = await add("BTCUSD");
    expect(entry.exchangePair).toBe("BTCUSD");
    expect(await watchlistSize(db)).toBe(WATCHLIST_MAX_ENTRIES);
    // The removed row is still there. Section 8.7, and 21.5's interest in what
    // was considered and dropped.
    expect(await db.watchlist.count()).toBe(WATCHLIST_MAX_ENTRIES + 1);
  });

  it("refuses before it calls the exchange", async () => {
    // Ordering, asserted rather than assumed: an eleventh add must not spend a
    // venue request or rate-limit budget to be told no.
    for (let i = 0; i < WATCHLIST_MAX_ENTRIES; i += 1) {
      await db.watchlist.insert(watchlistRow({ id: `wl-${i}`, pair: `pad${i}` }));
    }
    let calls = 0;
    const counting: TradablePairSource = async (account) => {
      calls += 1;
      return await listing(account);
    };
    await expect(
      addToWatchlist(portsWith(counting), {
        account: GEMINI,
        pair: "BTCUSD",
        note: "n",
        actor: "owner@example.com",
      }),
    ).rejects.toMatchObject({ code: "cap_exceeded" });
    expect(calls).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 2. Tradability, fail closed
// ---------------------------------------------------------------------------

describe("pair validation", () => {
  it("refuses a pair the venue does not list, and stores nothing", async () => {
    await expect(add("PEPEUSD")).rejects.toMatchObject({ code: "pair_not_tradable" });
    expect(await db.watchlist.count()).toBe(0);
    expect(await auditActions()).toEqual([]);
  });

  it("refuses a pair tradable on the OTHER account's venue", async () => {
    // `BTCUSDT` is real -- on Binance. Validating against the wrong venue is
    // what a watchlist with no account column would have had to do.
    await expect(add("BTCUSDT", GEMINI)).rejects.toMatchObject({ code: "pair_not_tradable" });
    await add("BTCUSDT", BINANCE);
    expect(await watchlistSize(db)).toBe(1);
  });

  it("refuses a case-folded near-miss and names the venue's own spelling", async () => {
    // THE CASE THE LIVE RUN ACTUALLY HIT (step 28, 2026-08-08). `listTradablePairs`
    // does not report Gemini's wire format: `/v1/symbols` returns lowercase and
    // `parseSymbolList` upper-cases to this system's `Pair` convention, so the
    // real listing is `BTCUSD`. A `btcusd` written from memory of the Gemini API
    // -- which is what the first live attempt sent -- must be refused, because
    // accepting it would store a symbol every later exchange call has to
    // re-spell. That is a validation that validated nothing.
    //
    // The fixture is uppercase for the same reason: a stub that models the wrong
    // catalogue teaches the wrong shape to whoever reads it next.
    await expect(add("btcusd")).rejects.toMatchObject({ code: "pair_not_tradable" });
    await expect(add("btcusd")).rejects.toThrow(/"BTCUSD"/);
    expect(await db.watchlist.count()).toBe(0);
  });

  it("refuses when the tradable set cannot be READ, rather than storing unchecked", async () => {
    // The §5.6 case. An outage is not permission to store a pair "to fix
    // later": the entry that gets stored on an outage is never revisited.
    await expect(
      addToWatchlist(portsWith(unreadable), {
        account: GEMINI,
        pair: "BTCUSD",
        note: "n",
        actor: "owner@example.com",
      }),
    ).rejects.toMatchObject({ code: "tradable_set_unreadable" });
    expect(await db.watchlist.count()).toBe(0);
    expect(await auditActions()).toEqual([]);
  });

  it("refuses an automated actor", async () => {
    await expect(
      addToWatchlist(portsWith(), {
        account: GEMINI,
        pair: "BTCUSD",
        note: "trending on CoinGecko",
        actor: "cron",
      }),
    ).rejects.toMatchObject({ code: "requires_human_actor" });
    expect(await db.watchlist.count()).toBe(0);
  });

  it("refuses a blank note, because the note is the only record of the choice", async () => {
    await expect(
      addToWatchlist(portsWith(), {
        account: GEMINI,
        pair: "BTCUSD",
        note: "   ",
        actor: "owner@example.com",
      }),
    ).rejects.toMatchObject({ code: "missing_field" });
    expect(await db.watchlist.count()).toBe(0);
  });

  it("refuses a duplicate of a live entry", async () => {
    await add("BTCUSD");
    await expect(add("BTCUSD")).rejects.toMatchObject({ code: "already_watched" });
    expect(await watchlistSize(db)).toBe(1);
  });

  it("allows re-adding a pair that was removed", async () => {
    // The reason the unique index is partial. Changing your mind twice is
    // ordinary; a plain UNIQUE would forbid it forever.
    const first = await add("BTCUSD");
    await removeFromWatchlist(portsWith(), {
      account: GEMINI,
      pair: "BTCUSD",
      actor: "owner@example.com",
    });
    const second = await add("BTCUSD", GEMINI, "back on, the range tightened");
    expect(second.id).not.toBe(first.id);
    expect(await watchlistSize(db)).toBe(1);
    expect(await db.watchlist.count()).toBe(2);
  });

  it("does NOT re-check tradability on removal", async () => {
    // Deliberate asymmetry. A delisted pair is the entry MOST in need of
    // removing, and an outage must not be enough to freeze the list -- so the
    // removal path takes a lister that always fails and must still succeed.
    await add("BTCUSD");
    const removed = await removeFromWatchlist(portsWith(unreadable), {
      account: GEMINI,
      pair: "BTCUSD",
      actor: "owner@example.com",
    });
    expect(removed.exchangePair).toBe("BTCUSD");
    expect(await watchlistSize(db)).toBe(0);
  });

  it("lets exactly one of two concurrent removals win", async () => {
    // The `removed_at: null` in the removal's UPDATE looks redundant beside the
    // `findOne` two lines above it, and a mutant deleting it survives every
    // sequential test in this file. It is the whole guard against the interleave
    // this test drives: both calls read the live row before either writes.
    //
    // Without it the second UPDATE matches by id and rewrites `removed_at`, so
    // BOTH callers believe they removed the pair and the log carries two
    // removals of one entry, the second naming an actor who removed nothing.
    await add("BTCUSD");
    const removal = () =>
      removeFromWatchlist(portsWith(), {
        account: GEMINI,
        pair: "BTCUSD",
        actor: "owner@example.com",
      });

    const outcomes = await Promise.allSettled([removal(), removal()]);
    expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(1);
    const rejected = outcomes.find((o) => o.status === "rejected");
    expect((rejected as PromiseRejectedResult).reason).toMatchObject({ code: "not_watched" });

    expect(await watchlistSize(db)).toBe(0);
    expect(await auditActions()).toEqual(["watchlist.added", "watchlist.removed"]);
  });

  it("refuses to remove a pair that is not on the list", async () => {
    await expect(
      removeFromWatchlist(portsWith(), {
        account: GEMINI,
        pair: "BTCUSD",
        actor: "owner@example.com",
      }),
    ).rejects.toMatchObject({ code: "not_watched" });
    expect(await auditActions()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 3. Audit logging, on both writes
// ---------------------------------------------------------------------------

describe("audit logging", () => {
  it("writes one audit entry on an add, naming the actor, pair and account", async () => {
    const entry = await add("BTCUSD", GEMINI, "deepest book on the venue");

    const rows = await db.auditLog.findMany({ where: { action: "watchlist.added" } });
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.actor).toBe("owner@example.com");
    expect(row.target_bot_instance_id).toBeNull();
    expect(row.created_at).toBe(entry.addedAt);
    expect(row.details_json).toMatchObject({
      watchlist_id: entry.id,
      account_label: "gemini-main",
      exchange: "gemini",
      pair: "BTCUSD",
      note: "deepest book on the venue",
      size_before: 0,
    });
  });

  it("writes one audit entry on a removal, carrying who added it and when", async () => {
    const added = await add("BTCUSD");
    await removeFromWatchlist(portsWith(), {
      account: GEMINI,
      pair: "BTCUSD",
      note: "superseded by the solusd run",
      actor: "second@example.com",
    });

    const rows = await db.auditLog.findMany({ where: { action: "watchlist.removed" } });
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.actor).toBe("second@example.com");
    expect(row.target_bot_instance_id).toBeNull();
    expect(row.details_json).toMatchObject({
      watchlist_id: added.id,
      account_label: "gemini-main",
      pair: "BTCUSD",
      note: "superseded by the solusd run",
      added_by: "owner@example.com",
      added_at: added.addedAt,
    });
  });

  it("writes exactly one entry per successful write and none per refusal", async () => {
    await add("BTCUSD");
    await expect(add("BTCUSD")).rejects.toThrow(WatchlistError);
    await expect(add("PEPEUSD")).rejects.toThrow(WatchlistError);
    await removeFromWatchlist(portsWith(), {
      account: GEMINI,
      pair: "BTCUSD",
      actor: "owner@example.com",
    });
    await expect(
      removeFromWatchlist(portsWith(), {
        account: GEMINI,
        pair: "BTCUSD",
        actor: "owner@example.com",
      }),
    ).rejects.toThrow(WatchlistError);

    expect(await auditActions()).toEqual(["watchlist.added", "watchlist.removed"]);
  });

  it("records an absent removal note as null rather than as an empty reason", async () => {
    await add("BTCUSD");
    await removeFromWatchlist(portsWith(), {
      account: GEMINI,
      pair: "BTCUSD",
      actor: "owner@example.com",
    });
    const row = (await db.auditLog.findMany({ where: { action: "watchlist.removed" } }))[0]!;
    expect((row.details_json as { note: unknown }).note).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 4. The read path
// ---------------------------------------------------------------------------

describe("readWatchlist", () => {
  it("returns the live list in a stable order, and nothing removed", async () => {
    const btc = await add("BTCUSD");
    const eth = await add("ETHUSD");
    const sol = await add("SOLUSD");
    await removeFromWatchlist(portsWith(), {
      account: GEMINI,
      pair: "ETHUSD",
      actor: "owner@example.com",
    });

    const live = await readWatchlist(db);
    expect(live.map((e) => e.exchangePair)).toEqual(["BTCUSD", "SOLUSD"]);
    expect(live[0]).toEqual(btc);
    expect(live[1]).toEqual(sol);
    // Removed, not gone.
    expect(await db.watchlist.findOne({ id: eth.id })).not.toBeNull();
  });

  it("orders by id when two entries share a timestamp", async () => {
    // One operator pasting two commands can land two rows in one millisecond.
    // Without the tiebreak the order is SQLite's choice, and a candidate list
    // that reorders itself between runs makes two pipeline runs incomparable.
    await db.watchlist.insert(watchlistRow({ id: "wl-b", pair: "ETHUSD", added_at: T0 }));
    await db.watchlist.insert(watchlistRow({ id: "wl-a", pair: "BTCUSD", added_at: T0 }));
    expect((await readWatchlist(db)).map((e) => e.id)).toEqual(["wl-a", "wl-b"]);
  });

  it("narrows to one account when asked, and spans every account otherwise", async () => {
    await add("BTCUSD", GEMINI);
    await add("BTCUSDT", BINANCE);

    expect((await readWatchlist(db)).map((e) => e.accountLabel)).toEqual([
      "gemini-main",
      "main",
    ]);
    expect(
      (await readWatchlist(db, { accountLabel: "main" })).map((e) => e.exchangePair),
    ).toEqual(["BTCUSDT"]);
  });

  it("returns an empty list rather than failing when nothing is watched", async () => {
    expect(await readWatchlist(db)).toEqual([]);
    expect(await watchlistSize(db)).toBe(0);
  });

  it("reports what the writes actually did, not what they were asked to do", async () => {
    // The read path is what a later pipeline stage trusts, so it is checked
    // against a sequence of accepted AND refused writes rather than a clean run.
    await add("BTCUSD");
    await expect(add("PEPEUSD")).rejects.toThrow(WatchlistError);
    await add("SOLUSD");
    await expect(add("BTCUSD")).rejects.toThrow(WatchlistError);
    await removeFromWatchlist(portsWith(), {
      account: GEMINI,
      pair: "BTCUSD",
      actor: "owner@example.com",
    });
    await add("LINKUSD");

    expect((await readWatchlist(db)).map((e) => e.exchangePair)).toEqual([
      "SOLUSD",
      "LINKUSD",
    ]);
  });
});
