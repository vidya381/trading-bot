/**
 * The 21.4 Stage 1 candle fetch: reach, refusal, and the honesty about depth.
 *
 * Four properties, each one this module would look correct without:
 *
 *  1. IT WORKS WITH NO BOT. That is the entire point of the extension -- 21.4
 *     needs candles for a candidate coin, and a candidate coin has no bot by
 *     definition. So the headline test asserts an empty `bot_instances` table
 *     while the fetch succeeds, because a version of this that quietly still
 *     needed an attached client would pass every other test here.
 *  2. TRUNCATION IS REPORTED, NOT HIDDEN. Gemini's `/v2/candles` has no
 *     time-range parameter and returns a fixed recent window (21.7 open
 *     question 1). A request reaching past that window comes back short, and
 *     the caller must be told -- "the Assess stage must be told how much
 *     history it actually received and must not reason as though it had more".
 *  3. IT FAILS CLOSED, four ways: unknown account, untradable pair, unreadable
 *     tradable set, failed candle call. None of them yields an empty array,
 *     which is the shape a silent failure would take (21.5 requirement 6).
 *  4. THE VENUE IS THE REGISTRY'S, NOT THE CALLER'S, and the tradable set is
 *     checked BEFORE any candle request is spent.
 *
 * The exchange is a stub throughout, as in every other test in this repository:
 * `getCandles` and its clients have their own tests, and driving a real client
 * here would make these assertions depend on a venue's live catalogue and on
 * whatever depth its window happened to hold this morning. NOTHING HERE HAS
 * SPOKEN TO GEMINI OR BINANCE.
 */

import { beforeEach, describe, expect, it } from "vitest";

import {
  CandleWindowError,
  VERIFIED_INTERVALS,
  fetchCandleWindow,
  type CandleSource,
  type CandleWindowPorts,
} from "./candles";
import type { TradablePairSource } from "./tradability";
import type { Database } from "../db/database";
import type { ExchangeOutcome } from "../shared/downtime";
import type { Candle, CandleInterval, Timestamp } from "../shared/exchange-client";
import type { CandleQuery } from "../workers/candles";
import { accountRow, botInstanceRow, freshDatabase } from "../db/test-helpers";

const T0 = 1_910_000_000_000;
const MINUTE = 60_000;

/** The venue catalogues the stub lister answers with, per account. */
const CATALOGUE: Record<string, string[]> = {
  "gemini-main": ["BTCUSD", "ETHUSD", "SOLUSD"],
  main: ["BTCUSDT", "ETHUSDT"],
};

let db: Database;

beforeEach(async () => {
  db = await freshDatabase();
  await db.accounts.insert(accountRow({ account_label: "main", exchange: "binance" }));
  await db.accounts.insert(accountRow({ account_label: "gemini-main", exchange: "gemini" }));
});

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

/**
 * One closed minute candle opening at `openTime`. The OHLCV values are
 * deliberately distinct per candle so "the array came back untouched" is a real
 * assertion rather than a shape check.
 */
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
 * A stub venue holding a FIXED recent window, which is Gemini's `/v2/candles`
 * behaviour exactly: no time-range parameter, so `since` is honoured by
 * filtering the window locally and cannot reach past its start.
 */
function windowOf(pair: string, oldestOpen: Timestamp, count: number): Candle[] {
  return Array.from({ length: count }, (_, i) =>
    candle(pair, oldestOpen + i * MINUTE, 100n + BigInt(i)),
  );
}

interface StubSource {
  readonly source: CandleSource;
  readonly calls: { account: string; exchange: string; query: CandleQuery }[];
}

/** Records every call, and filters its fixed window the way the client does. */
function fixedWindow(candles: Candle[], at: Timestamp = T0): StubSource {
  const calls: StubSource["calls"] = [];
  return {
    calls,
    source: async (account, query) => {
      calls.push({ account: account.label, exchange: account.exchange, query });
      const since = query.since;
      return {
        ok: true,
        value: since === undefined ? candles : candles.filter((c) => c.closeTime > since),
        at,
      };
    },
  };
}

/** A venue call that failed. */
function failingSource(
  failure: Extract<ExchangeOutcome<Candle[]>, { ok: false }>,
): StubSource {
  const calls: StubSource["calls"] = [];
  return {
    calls,
    source: async (account, query) => {
      calls.push({ account: account.label, exchange: account.exchange, query });
      return failure;
    },
  };
}

function portsWith(
  getCandles: CandleSource,
  listTradablePairs: TradablePairSource = listing,
): CandleWindowPorts {
  return { db, listTradablePairs, getCandles };
}

// ---------------------------------------------------------------------------
// 1. The reach: any listed pair, with no bot anywhere
// ---------------------------------------------------------------------------

describe("reach", () => {
  it("fetches candles for a pair that has no bot instance attached", async () => {
    // THE WHOLE POINT OF THE EXTENSION (21.4). `bot_instances` is empty and
    // stays empty; nothing is attached, nothing is created, and the fetch still
    // resolves a client from the account registry alone.
    const stub = fixedWindow(windowOf("SOLUSD", T0, 5));

    const window = await fetchCandleWindow(portsWith(stub.source), {
      accountLabel: "gemini-main",
      pair: "SOLUSD",
      interval: "1m",
    });

    expect(await db.botInstances.count()).toBe(0);
    expect(window.candles).toHaveLength(5);
    expect(window.pair).toBe("SOLUSD");
    expect(window.exchange).toBe("gemini");
    expect(window.accountLabel).toBe("gemini-main");
  });

  it("fetches for a pair while a bot exists on a DIFFERENT pair", async () => {
    // The near-miss version of the same property: a client is resolved for the
    // account, not borrowed from whatever bot happens to be running.
    await db.botInstances.insert(
      botInstanceRow({ id: "dca-btc-1", account_label: "main", pair: "BTCUSDT" }),
    );
    const stub = fixedWindow(windowOf("ETHUSDT", T0, 3));

    const window = await fetchCandleWindow(portsWith(stub.source), {
      accountLabel: "main",
      pair: "ETHUSDT",
      interval: "1m",
    });

    expect(window.candles).toHaveLength(3);
    expect(stub.calls).toEqual([
      { account: "main", exchange: "binance", query: { pair: "ETHUSDT", interval: "1m" } },
    ]);
    // Not merely `since: undefined`. 21.5 requires a proposal to log its full
    // inputs, and a query object carrying a key whose value is undefined
    // records "a range was requested" in anything that serialises it.
    expect(Object.hasOwn(stub.calls[0]!.query, "since")).toBe(false);
  });

  it("returns the client's candles untouched, oldest-first", async () => {
    const candles = windowOf("BTCUSD", T0, 4);
    const stub = fixedWindow(candles);

    const window = await fetchCandleWindow(portsWith(stub.source), {
      accountLabel: "gemini-main",
      pair: "BTCUSD",
      interval: "1m",
    });

    // Not "has 4 entries" -- the exact rows, so a filter or a re-sort quietly
    // added here would fail rather than pass on the count.
    expect(window.candles).toEqual(candles);
  });

  it("takes the exchange from the registry, not from the pair's spelling", async () => {
    // `BTCUSD` is Gemini's; asking for it on the Binance account must consult
    // BINANCE's catalogue and be refused, not silently reach the other venue.
    const stub = fixedWindow(windowOf("BTCUSD", T0, 3));

    await expect(
      fetchCandleWindow(portsWith(stub.source), {
        accountLabel: "main",
        pair: "BTCUSD",
        interval: "1m",
      }),
    ).rejects.toMatchObject({ code: "pair_not_tradable" });
    expect(stub.calls).toEqual([]);
  });

  it("passes the interval and since straight through to the client", async () => {
    const stub = fixedWindow(windowOf("ETHUSD", T0, 10));

    await fetchCandleWindow(portsWith(stub.source), {
      accountLabel: "gemini-main",
      pair: "ETHUSD",
      interval: "1m",
      since: T0 + 2 * MINUTE,
    });

    expect(stub.calls).toEqual([
      {
        account: "gemini-main",
        exchange: "gemini",
        query: { pair: "ETHUSD", interval: "1m", since: T0 + 2 * MINUTE },
      },
    ]);
  });

  it("reports the venue's own answer time as fetchedAt", async () => {
    // 21.5 requirement 4 times a proposal from when its data was FETCHED. That
    // must be the outcome's `at`, not a clock this module reads afterwards.
    const stub = fixedWindow(windowOf("BTCUSD", T0, 2), T0 + 999);

    const window = await fetchCandleWindow(portsWith(stub.source), {
      accountLabel: "gemini-main",
      pair: "BTCUSD",
      interval: "1m",
    });

    expect(window.fetchedAt).toBe(T0 + 999);
  });
});

// ---------------------------------------------------------------------------
// 1b. The interval gate
// ---------------------------------------------------------------------------

/** Every value `CandleInterval` declares. Spelled out, not derived. */
const ALL_INTERVALS: readonly CandleInterval[] = ["1m", "5m", "15m", "30m", "1h", "6h", "1d"];

describe("interval gate", () => {
  it("verifies exactly 1m today", () => {
    // A PIN, deliberately. Widening `VERIFIED_INTERVALS` is one line in the
    // source, and this assertion is what stops it happening as a silent
    // one-character edit: an interval belongs on that list only once somebody
    // has actually read that venue's candles at that timeframe and confirmed
    // the duration is what it claims. Failing here is the reminder to say so in
    // the decision log.
    expect(VERIFIED_INTERVALS).toEqual(["1m"]);
  });

  it("refuses every declared interval that is not verified", async () => {
    // Driven off `VERIFIED_INTERVALS` rather than a hardcoded "everything but
    // 1m", so widening the list does not silently leave this test asserting the
    // old policy. The pin above is what keeps the list itself honest.
    const unverified = ALL_INTERVALS.filter((i) => !VERIFIED_INTERVALS.includes(i));
    expect(unverified.length).toBeGreaterThan(0);

    for (const interval of unverified) {
      const stub = fixedWindow(windowOf("BTCUSD", T0, 5));
      const error = await fetchCandleWindow(portsWith(stub.source), {
        accountLabel: "gemini-main",
        pair: "BTCUSD",
        interval,
      }).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(CandleWindowError);
      expect(error).toMatchObject({ code: "interval_not_verified" });
      // The refusal names the interval asked for AND what is verified, so an
      // operator is not left guessing which values are allowed.
      expect((error as Error).message).toContain(JSON.stringify(interval));
      expect((error as Error).message).toContain('"1m"');
      // And it cost nothing: no venue request.
      expect(stub.calls).toEqual([]);
    }
  });

  it("lets every verified interval through normally", async () => {
    for (const interval of VERIFIED_INTERVALS) {
      const stub = fixedWindow(windowOf("BTCUSD", T0, 5));
      const window = await fetchCandleWindow(portsWith(stub.source), {
        accountLabel: "gemini-main",
        pair: "BTCUSD",
        interval,
      });
      expect(window.interval).toBe(interval);
      expect(window.candles).toHaveLength(5);
      expect(stub.calls).toHaveLength(1);
    }
  });

  it("refuses an unverified interval BEFORE the account is even looked up", async () => {
    // The ordering claim, tested at its strongest point: an unknown account AND
    // an unverified interval must report the interval, because the gate is pure
    // and the registry read is not. Free checks first, I/O later.
    const stub = fixedWindow(windowOf("BTCUSD", T0, 5));
    let listed = 0;
    const counting: TradablePairSource = async (account) => {
      listed += 1;
      return listing(account);
    };

    await expect(
      fetchCandleWindow(portsWith(stub.source, counting), {
        accountLabel: "no-such-account",
        pair: "BTCUSD",
        interval: "1d",
      }),
    ).rejects.toMatchObject({ code: "interval_not_verified" });
    expect(listed).toBe(0);
    expect(stub.calls).toEqual([]);
  });

  it("spends no D1 read either, not just no venue call", async () => {
    // A mutation run found the gap this closes. Moving the registry READ above
    // the gate (while leaving its refusal below) changes no error code and no
    // response -- every assertion above still passed -- and quietly reintroduces
    // exactly the I/O the ordering exists to avoid. The claim in the docblock is
    // "pure, no I/O", so the only test that can hold it is one that counts.
    //
    // The one place in this file with a stub `db` rather than real D1, and
    // deliberately: what is under test is whether `findOne` is CALLED, which a
    // real database cannot report.
    let reads = 0;
    const countingDb = {
      accounts: {
        findOne: async (where: unknown) => {
          reads += 1;
          return await db.accounts.findOne(where as { account_label: string });
        },
      },
    } as unknown as Database;
    const stub = fixedWindow(windowOf("BTCUSD", T0, 5));

    await expect(
      fetchCandleWindow(
        { db: countingDb, listTradablePairs: listing, getCandles: stub.source },
        { accountLabel: "gemini-main", pair: "BTCUSD", interval: "6h" },
      ),
    ).rejects.toMatchObject({ code: "interval_not_verified" });
    expect(reads).toBe(0);

    // And the same ports DO read once when the interval is verified, so the
    // assertion above is measuring the gate rather than a broken stub.
    await fetchCandleWindow(
      { db: countingDb, listTradablePairs: listing, getCandles: stub.source },
      { accountLabel: "gemini-main", pair: "BTCUSD", interval: "1m" },
    );
    expect(reads).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 2. Depth: the Gemini window limit, reported rather than worked around
// ---------------------------------------------------------------------------

describe("truncation reporting", () => {
  it("reports truncation when more history is asked for than the window holds", async () => {
    // 21.7 OPEN QUESTION 1, modelled exactly: the venue holds a fixed recent
    // window (here 30 minutes) and the caller asks for a day. Nothing fetches
    // deeper; the shortfall is reported.
    const oldestOpen = T0 - 30 * MINUTE;
    const stub = fixedWindow(windowOf("BTCUSD", oldestOpen, 30));
    const wanted = T0 - 24 * 60 * MINUTE;

    const window = await fetchCandleWindow(portsWith(stub.source), {
      accountLabel: "gemini-main",
      pair: "BTCUSD",
      interval: "1m",
      since: wanted,
    });

    expect(window.truncated).toBe(true);
    expect(window.missingHistoryMs).toBe(oldestOpen - wanted);
    expect(window.requestedSince).toBe(wanted);
    expect(window.earliestOpenTime).toBe(oldestOpen);
    expect(window.earliestCloseTime).toBe(oldestOpen + MINUTE);
    expect(window.latestCloseTime).toBe(oldestOpen + 30 * MINUTE);
    // The candles it DID get are still returned -- the point is that the caller
    // is told what they are, not that the request fails.
    expect(window.candles).toHaveLength(30);
  });

  it("does not report truncation when the window covers the request", async () => {
    const oldestOpen = T0 - 30 * MINUTE;
    const stub = fixedWindow(windowOf("BTCUSD", oldestOpen, 30));
    const wanted = T0 - 10 * MINUTE;

    const window = await fetchCandleWindow(portsWith(stub.source), {
      accountLabel: "gemini-main",
      pair: "BTCUSD",
      interval: "1m",
      since: wanted,
    });

    expect(window.truncated).toBe(false);
    expect(window.missingHistoryMs).toBeNull();
    // The client filtered to close times after `since`, so the oldest candle is
    // the one still open at that instant: it OPENED before `since`.
    expect(window.earliestOpenTime).toBeLessThanOrEqual(wanted);
  });

  it("does not report truncation when the window starts exactly at the request", async () => {
    // The boundary that decides whether the comparison is `>` or `>=`. A window
    // whose oldest candle OPENS exactly at `since` has lost nothing: the candle
    // before it closed AT `since`, and `since` asks for close times AFTER that.
    const stub = fixedWindow(windowOf("BTCUSD", T0, 10));

    const window = await fetchCandleWindow(portsWith(stub.source), {
      accountLabel: "gemini-main",
      pair: "BTCUSD",
      interval: "1m",
      since: T0,
    });

    expect(window.earliestOpenTime).toBe(T0);
    expect(window.truncated).toBe(false);
    expect(window.missingHistoryMs).toBeNull();
  });

  it("reports truncation of exactly one millisecond", async () => {
    // The other side of the same boundary, at the smallest size that exists. A
    // shortfall this small is meaningless in practice and is still reported,
    // because the alternative is a threshold nobody chose deliberately.
    const stub = fixedWindow(windowOf("BTCUSD", T0, 10));

    const window = await fetchCandleWindow(portsWith(stub.source), {
      accountLabel: "gemini-main",
      pair: "BTCUSD",
      interval: "1m",
      since: T0 - 1,
    });

    expect(window.truncated).toBe(true);
    expect(window.missingHistoryMs).toBe(1);
  });

  it("reports no truncation and a null shortfall when no range was requested", async () => {
    // Documented behaviour, not an accident: with no `since` there is no
    // requested range to fall short of. `earliestCloseTime` is what answers
    // "how far back does this actually go" in that case.
    const oldestOpen = T0 - 5 * MINUTE;
    const stub = fixedWindow(windowOf("BTCUSD", oldestOpen, 5));

    const window = await fetchCandleWindow(portsWith(stub.source), {
      accountLabel: "gemini-main",
      pair: "BTCUSD",
      interval: "1m",
    });

    expect(window.requestedSince).toBeNull();
    expect(window.truncated).toBe(false);
    expect(window.missingHistoryMs).toBeNull();
    expect(window.earliestCloseTime).toBe(oldestOpen + MINUTE);
  });

  it("never reports truncation without the size of the shortfall", async () => {
    // The flag and the figure are one derivation, so a `truncated: true` with
    // nothing to say cannot occur. Asserted over both directions of the branch.
    for (const since of [undefined, T0 - 1, T0, T0 + MINUTE]) {
      const stub = fixedWindow(windowOf("BTCUSD", T0, 10));
      const window = await fetchCandleWindow(portsWith(stub.source), {
        accountLabel: "gemini-main",
        pair: "BTCUSD",
        interval: "1m",
        ...(since === undefined ? {} : { since }),
      });
      expect(window.truncated).toBe(window.missingHistoryMs !== null);
      if (window.missingHistoryMs !== null) expect(window.missingHistoryMs).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Fail closed
// ---------------------------------------------------------------------------

describe("fail closed", () => {
  it("refuses an unregistered account and asks no venue anything", async () => {
    const stub = fixedWindow(windowOf("BTCUSD", T0, 5));
    let listed = 0;
    const counting: TradablePairSource = async (account) => {
      listed += 1;
      return listing(account);
    };

    await expect(
      fetchCandleWindow(portsWith(stub.source, counting), {
        accountLabel: "no-such-account",
        pair: "BTCUSD",
        interval: "1m",
      }),
    ).rejects.toMatchObject({ code: "unknown_account" });
    expect(listed).toBe(0);
    expect(stub.calls).toEqual([]);
  });

  it("refuses a pair the venue does not list, and spends no candle request", async () => {
    // The ordering matters as much as the refusal: an untradable pair must cost
    // no rate-limit budget, the same reason `addToWatchlist` checks last.
    const stub = fixedWindow(windowOf("PEPEUSD", T0, 5));

    await expect(
      fetchCandleWindow(portsWith(stub.source), {
        accountLabel: "gemini-main",
        pair: "PEPEUSD",
        interval: "1m",
      }),
    ).rejects.toMatchObject({ code: "pair_not_tradable" });
    expect(stub.calls).toEqual([]);
  });

  it("refuses a case-folded near-miss and names the venue's own spelling", async () => {
    // The step 28 live finding, one module over: `listTradablePairs` reports
    // this system's `Pair` convention (`BTCUSD`), not Gemini's wire format. A
    // case-folded accept here would fetch candles under a symbol every later
    // call has to re-spell.
    const stub = fixedWindow(windowOf("BTCUSD", T0, 5));

    await expect(
      fetchCandleWindow(portsWith(stub.source), {
        accountLabel: "gemini-main",
        pair: "btcusd",
        interval: "1m",
      }),
    ).rejects.toThrow(/"BTCUSD"/);
    expect(stub.calls).toEqual([]);
  });

  it("refuses when the tradable set cannot be READ, rather than fetching unchecked", async () => {
    // §5.6 one layer out: "could not check" is not "checked and fine".
    const stub = fixedWindow(windowOf("BTCUSD", T0, 5));

    await expect(
      fetchCandleWindow(portsWith(stub.source, unreadable), {
        accountLabel: "gemini-main",
        pair: "BTCUSD",
        interval: "1m",
      }),
    ).rejects.toMatchObject({ code: "tradable_set_unreadable" });
    expect(stub.calls).toEqual([]);
  });

  it("refuses a failed candle call instead of returning an empty window", async () => {
    const stub = failingSource({
      ok: false,
      kind: "transport",
      message: "connect ETIMEDOUT",
      retryable: true,
      at: T0,
    });

    const rejection = await fetchCandleWindow(portsWith(stub.source), {
      accountLabel: "gemini-main",
      pair: "BTCUSD",
      interval: "1m",
    }).catch((error: unknown) => error);

    expect(rejection).toBeInstanceOf(CandleWindowError);
    expect(rejection).toMatchObject({ code: "candles_unavailable" });
    // The venue's own account of the failure survives into the message, so an
    // operator is not left to guess between a timeout and a bad symbol.
    expect((rejection as Error).message).toContain("connect ETIMEDOUT");
    expect((rejection as Error).message).toContain("transport");
  });

  it("refuses a rate-limited candle call too", async () => {
    // The third failure kind. `rate_limited` means nothing was SENT, which is a
    // different fact from a timeout -- and still not price history.
    const stub = failingSource({
      ok: false,
      kind: "rate_limited",
      message: "budget refused the request",
      retryable: true,
      at: T0,
    });

    await expect(
      fetchCandleWindow(portsWith(stub.source), {
        accountLabel: "gemini-main",
        pair: "BTCUSD",
        interval: "1m",
      }),
    ).rejects.toMatchObject({ code: "candles_unavailable" });
  });

  it("refuses an empty-but-successful response rather than passing on zero candles", async () => {
    // The shape a silent failure takes. An empty array type-checks, flows into
    // an average as though it meant something, and reaches a human looking
    // exactly like a coin that did not trade.
    const stub = fixedWindow([]);

    await expect(
      fetchCandleWindow(portsWith(stub.source), {
        accountLabel: "gemini-main",
        pair: "BTCUSD",
        interval: "1m",
      }),
    ).rejects.toMatchObject({ code: "no_candles_returned" });
  });

  it("refuses when a since filter emptied the window", async () => {
    // The realistic route to an empty array on Gemini: the requested range is
    // entirely newer than the window's newest candle.
    const stub = fixedWindow(windowOf("BTCUSD", T0 - 30 * MINUTE, 30));

    await expect(
      fetchCandleWindow(portsWith(stub.source), {
        accountLabel: "gemini-main",
        pair: "BTCUSD",
        interval: "1m",
        since: T0 + 10 * MINUTE,
      }),
    ).rejects.toMatchObject({ code: "no_candles_returned" });
  });

  it("throws a CandleWindowError, never a bare Error, on every refusal path", async () => {
    // So a caller can map on `.code` without also having to guard against
    // something else having thrown from inside the same call.
    const good = windowOf("BTCUSD", T0, 3);
    const cases: [string, CandleWindowPorts, { label: string; pair: string }][] = [
      ["unknown_account", portsWith(fixedWindow(good).source), { label: "nope", pair: "BTCUSD" }],
      [
        "pair_not_tradable",
        portsWith(fixedWindow(good).source),
        { label: "gemini-main", pair: "PEPEUSD" },
      ],
      [
        "tradable_set_unreadable",
        portsWith(fixedWindow(good).source, unreadable),
        { label: "gemini-main", pair: "BTCUSD" },
      ],
      [
        "candles_unavailable",
        portsWith(
          failingSource({ ok: false, kind: "exchange_error", message: "500", retryable: true, at: T0 })
            .source,
        ),
        { label: "gemini-main", pair: "BTCUSD" },
      ],
      [
        "no_candles_returned",
        portsWith(fixedWindow([]).source),
        { label: "gemini-main", pair: "BTCUSD" },
      ],
    ];

    for (const [code, ports, { label, pair }] of cases) {
      const error = await fetchCandleWindow(ports, {
        accountLabel: label,
        pair,
        interval: "1m",
      }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(CandleWindowError);
      expect(error).toMatchObject({ name: "CandleWindowError", code });
    }
  });
});
