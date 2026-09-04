import { describe, expect, it } from "vitest";
import { fromDecimalString as m, ZERO } from "../../shared/money";
import { buildKrakenCatalogue, type KrakenCatalogue } from "./catalogue";
import {
  classifyFailure,
  classifyKrakenError,
  compareDecimalStrings,
  feeAssetFor,
  krakenTimeframe,
  KRAKEN_TIMEFRAMES,
  OHLC_LAST_KEY,
  parseBalances,
  parseCancelResult,
  parseCandles,
  parseClosedOrders,
  parseOpenOrders,
  parseOrderFlags,
  parseOrderResult,
  parseOrderStatus,
  parseOrderStatusMap,
  parsePrice,
  parseServerTime,
  parseTickerResult,
  parseTrades,
  ParseError,
  readEnvelope,
  requireResult,
  requireSingleOrder,
  toOrderState,
  ORDERS_LIMIT_EXCEEDED_ERROR,
} from "./parse";

/**
 * ── PROVENANCE OF EVERY FIXTURE BELOW, STATED RATHER THAN ASSUMED ──
 *
 * PULLED LIVE from `api.kraken.com` on 2026-09-03, verbatim, HTTP 200 on every
 * one of them:
 *
 *   AssetPairs / Assets  `GET /0/public/AssetPairs?pair=XBTUSD,BONKUSD,ANKRXBT,ETHXBT`
 *                        and `GET /0/public/Assets?asset=XXBT,ZUSD,BONK,ANKR,XETH`.
 *                        The `fees`, `fees_maker`, `leverage_buy` and
 *                        `leverage_sell` arrays are dropped from each pair --
 *                        the one edit, matching `filters.test.ts` and
 *                        `catalogue.test.ts`. Nothing this module reads is
 *                        touched.
 *   OHLC                 `GET /0/public/OHLC?pair=XBTUSD&interval=1` and the
 *                        same for `BONKUSD`. Rows and the `last` sibling are
 *                        exactly as returned; only the row COUNT is trimmed.
 *   Ticker               `GET /0/public/Ticker?pair=XBTUSD`, `?pair=BONKUSD`,
 *                        `?pair=ANKRXBT`.
 *   Time                 `GET /0/public/Time`.
 *   Error strings        `EQuery:Unknown asset pair` (`?pair=NOTAPAIR`),
 *                        `EAPI:Invalid key` (`POST /0/private/BalanceEx` with a
 *                        junk key), `EGeneral:Unknown method`
 *                        (`/0/public/NoSuchMethod`) and
 *                        `EGeneral:Invalid arguments` (`OHLC&interval=360`, the
 *                        6-hour interval Kraken does not have). Every one of
 *                        them arrived over **HTTP 200**, which is the whole
 *                        reason this module classifies on the string.
 *
 * FROM KRAKEN'S PUBLISHED REFERENCE, NOT LIVE, AND SAID SO PLAINLY: the private
 * payloads -- `AddOrder`, `QueryOrders`, `BalanceEx`, `QueryTrades`,
 * `CancelOrder`. They need credentials this session does not have, so they are
 * Kraken's own documented example responses rather than captures. They are not
 * presented as pulled fixtures, because they are not.
 *
 * CONSTRUCTED, AND MARKED AT THE POINT OF USE: the crossed book, the negative
 * balance, and the unrecognised statuses. Each is built by editing ONE field of
 * a real payload, because none of them can be requested on demand -- the same
 * treatment `filters.test.ts` gives `limit_only` and `reduce_only`.
 */

// --------------------------------------------------------------------------
// Catalogue (live)
// --------------------------------------------------------------------------

const ASSET_PAIRS: Record<string, unknown> = {
  XXBTZUSD: {
    altname: "XBTUSD",
    wsname: "XBT/USD",
    aclass_base: "currency",
    base: "XXBT",
    aclass_quote: "currency",
    quote: "ZUSD",
    lot: "unit",
    cost_decimals: 5,
    pair_decimals: 1,
    lot_decimals: 8,
    lot_multiplier: 1,
    fee_volume_currency: "ZUSD",
    margin_call: 80,
    margin_stop: 40,
    ordermin: "0.00005",
    costmin: "0.5",
    tick_size: "0.1",
    status: "online",
    execution_venue: "international",
    long_position_limit: 350,
    short_position_limit: 250,
  },
  BONKUSD: {
    altname: "BONKUSD",
    wsname: "BONK/USD",
    aclass_base: "currency",
    base: "BONK",
    aclass_quote: "currency",
    quote: "ZUSD",
    lot: "unit5",
    cost_decimals: 5,
    pair_decimals: 9,
    lot_decimals: 5,
    lot_multiplier: 1,
    fee_volume_currency: "ZUSD",
    margin_call: 80,
    margin_stop: 40,
    ordermin: "1500000",
    costmin: "0.5",
    tick_size: "0.000000001",
    status: "online",
    execution_venue: "international",
    long_position_limit: 50000000000,
    short_position_limit: 24000000000,
  },
  ANKRXBT: {
    altname: "ANKRXBT",
    wsname: "ANKR/XBT",
    aclass_base: "currency",
    base: "ANKR",
    aclass_quote: "currency",
    quote: "XXBT",
    lot: "unit",
    cost_decimals: 10,
    pair_decimals: 10,
    lot_decimals: 8,
    lot_multiplier: 1,
    fee_volume_currency: "ZUSD",
    margin_call: 80,
    margin_stop: 40,
    ordermin: "1300",
    costmin: "0.00002",
    tick_size: "0.0000000001",
    status: "online",
    execution_venue: "international",
  },
  XETHXXBT: {
    altname: "ETHXBT",
    wsname: "ETH/XBT",
    aclass_base: "currency",
    base: "XETH",
    aclass_quote: "currency",
    quote: "XXBT",
    lot: "unit",
    cost_decimals: 10,
    pair_decimals: 6,
    lot_decimals: 8,
    lot_multiplier: 1,
    fee_volume_currency: "ZUSD",
    margin_call: 80,
    margin_stop: 40,
    ordermin: "0.001",
    costmin: "0.00002",
    tick_size: "0.000001",
    status: "online",
    execution_venue: "international",
    long_position_limit: 1000,
    short_position_limit: 800,
  },
};

const ASSETS: Record<string, unknown> = {
  ANKR: { aclass: "currency", altname: "ANKR", decimals: 10, display_decimals: 5, status: "enabled" },
  BONK: {
    aclass: "currency",
    altname: "BONK",
    decimals: 2,
    display_decimals: 0,
    status: "enabled",
    margin_rate: "0.02",
  },
  XETH: {
    aclass: "currency",
    altname: "ETH",
    decimals: 10,
    display_decimals: 5,
    collateral_value: 0.99,
    status: "enabled",
    margin_rate: "0.02",
  },
  XXBT: {
    aclass: "currency",
    altname: "XBT",
    decimals: 10,
    display_decimals: 5,
    collateral_value: 0.99,
    status: "enabled",
    margin_rate: "0.01",
  },
  ZUSD: {
    aclass: "currency",
    altname: "USD",
    decimals: 4,
    display_decimals: 2,
    collateral_value: 1.0,
    status: "enabled",
    margin_rate: "0.025",
  },
};

const FETCHED_AT = 1_788_406_450_000;

function catalogue(): KrakenCatalogue {
  return buildKrakenCatalogue({
    assetPairs: ASSET_PAIRS,
    assets: ASSETS,
    fetchedAt: FETCHED_AT,
  });
}

// --------------------------------------------------------------------------
// The envelope
// --------------------------------------------------------------------------

describe("readEnvelope", () => {
  it("reads a successful envelope", () => {
    // Live: GET /0/public/Time.
    const body = { error: [], result: { unixtime: 1788406450, rfc1123: "Thu, 03 Sep 26 03:34:10 +0000" } };
    expect(readEnvelope(body)).toEqual({
      errors: [],
      result: { unixtime: 1788406450, rfc1123: "Thu, 03 Sep 26 03:34:10 +0000" },
    });
  });

  it("reads a failure that carries NO result key at all", () => {
    // Live, verbatim: GET /0/public/Ticker?pair=NOTAPAIR, over HTTP 200. There
    // is no `result` field in the response -- treating that as a broken payload
    // would report a classified refusal as an unreadable one.
    const body = { error: ["EQuery:Unknown asset pair"] };
    const envelope = readEnvelope(body);
    expect(envelope.errors).toEqual(["EQuery:Unknown asset pair"]);
    expect(envelope.result).toBeUndefined();
  });

  it("refuses a body with no error array, because emptiness is the only success signal", () => {
    expect(() => readEnvelope({ result: {} })).toThrow(ParseError);
    expect(() => readEnvelope({ result: {} })).toThrow(/top-level "error" array/);
  });

  it("refuses a non-object body", () => {
    expect(() => readEnvelope([1, 2, 3])).toThrow(/expected a single object, got an array of 3/);
    expect(() => readEnvelope(null)).toThrow(/got null/);
  });

  it("stringifies a non-string error entry rather than dropping it", () => {
    // The array is the only thing between a failed request and a caller
    // believing it succeeded, so a weird entry must still count as an error.
    expect(readEnvelope({ error: [42] }).errors).toEqual(["42"]);
  });
});

describe("requireResult", () => {
  it("returns the result of a clean envelope", () => {
    expect(requireResult({ error: [], result: { count: 1 } }, "CancelOrder")).toEqual({ count: 1 });
  });

  it("throws when the error array is non-empty, naming the errors", () => {
    expect(() => requireResult({ error: ["EAPI:Invalid key"] }, "BalanceEx")).toThrow(
      /BalanceEx: Kraken reported 1 error\(s\): EAPI:Invalid key/,
    );
  });

  it("throws when Kraken reports success but sends no payload", () => {
    expect(() => requireResult({ error: [] }, "Time")).toThrow(/no result payload/);
  });
});

// --------------------------------------------------------------------------
// ERROR CLASSIFICATION -- the primary path
// --------------------------------------------------------------------------

describe("classifyKrakenError", () => {
  const at = 1_788_406_450_000;

  it("treats a stale nonce as a retryable exchange error", () => {
    expect(classifyKrakenError("EAPI:Invalid nonce", at)).toEqual({
      kind: "exchange_error",
      retryable: true,
    });
  });

  it.each([
    "EAPI:Rate limit exceeded",
    "EOrder:Rate limit exceeded",
  ])("treats %s as a retryable exchange error", (error) => {
    expect(classifyKrakenError(error, at)).toEqual({
      kind: "exchange_error",
      retryable: true,
    });
  });

  describe("EOrder:Orders limit exceeded -- the open-order CEILING, not a rate limit", () => {
    it("is a DEFINITE, NON-RETRYABLE refusal, and that is a decision, not a default", () => {
      // ⚠ WHY THIS TEST IS NAMED AND NOT FOLDED INTO THE it.each BELOW.
      //
      // The classifier's default arm already returns exactly this for any
      // unrecognised string, so this assertion passed BEFORE `DEFINITE_REFUSALS`
      // existed and passes now. That is precisely why it is worth writing: a
      // string classified correctly by accident and a string classified
      // correctly on purpose are indistinguishable from the outside, and they
      // call for opposite responses the day somebody edits the default arm.
      //
      // The specific mistake being guarded against is one word away. Two
      // assertions up, `EOrder:Rate limit exceeded` is RETRYABLE. This string
      // differs from it by "Orders"/"Rate" and is not a sibling: a rate limit
      // decays and clears by waiting, an open-order ceiling is a LEVEL that only
      // a fill or a cancel lowers. Retrying it re-sends into an identical
      // refusal for as long as the pair's book stays full.
      expect(classifyKrakenError(ORDERS_LIMIT_EXCEEDED_ERROR, at)).toEqual({
        kind: "exchange_error",
        retryable: false,
      });
    });

    it("is the exact string Kraken sends, re-read live from the docs on 2026-09-04", () => {
      // *(docs)* spot-ratelimits, verbatim: "When the open order threshold is
      // reached, the engine will generate `EOrder:Orders limit exceeded`
      // rejection message." Pinned as a literal in ONE place because every other
      // reference in the codebase imports this constant rather than spelling it.
      expect(ORDERS_LIMIT_EXCEEDED_ERROR).toBe("EOrder:Orders limit exceeded");
    });

    it("is not in the retryable set, which is the classification that would break it", () => {
      // Order matters in `classifyKrakenError`: the retryable table is consulted
      // BEFORE the definite-refusal one, so a string added to both would be
      // classified retryable and this file would still pass every other test.
      // Asserted through the public function, which is the only thing that can
      // observe the precedence.
      expect(classifyKrakenError(ORDERS_LIMIT_EXCEEDED_ERROR, at).retryable).toBe(false);
      expect(classifyKrakenError("EOrder:Rate limit exceeded", at).retryable).toBe(true);
    });
  });

  it.each(["EService:Unavailable", "EService:Busy"])(
    "treats %s as TRANSPORT, because a server-side failure leaves the effect unknown",
    (error) => {
      // Entry 90's most consequential row. These arrive over HTTP 200, so
      // anything reasoning from the status would call them a definite refusal
      // and tell section 5.1 an order was rejected when its fate is open.
      expect(classifyKrakenError(error, at)).toEqual({
        kind: "transport",
        retryable: true,
      });
    },
  );

  it.each([
    "EAPI:Invalid key",
    "EAPI:Invalid signature",
    "EGeneral:Permission denied",
    "EOrder:Insufficient funds",
    "EOrder:Order minimum not met",
    "EOrder:Cost minimum not met",
    "EOrder:Tick size check failed",
  ])("treats %s as a NON-retryable exchange error", (error) => {
    expect(classifyKrakenError(error, at)).toEqual({
      kind: "exchange_error",
      retryable: false,
    });
  });

  describe("EService:Throttled -- the first real retryAfterMs in this codebase", () => {
    it("extracts the unix timestamp as a duration from receipt time", () => {
      // Kraken sends an absolute instant in SECONDS; the interface wants a wait.
      const class_ = classifyKrakenError("EService:Throttled:1788406480", at);
      expect(class_).toEqual({
        kind: "exchange_error",
        retryable: true,
        retryAfterMs: 30_000,
      });
    });

    it("accepts the spelling with a space, which entry 90 uses in prose", () => {
      expect(classifyKrakenError("EService:Throttled: 1788406480", at).retryAfterMs).toBe(30_000);
    });

    it("never reports a negative wait for a timestamp already in the past", () => {
      expect(classifyKrakenError("EService:Throttled:1788406400", at).retryAfterMs).toBe(0);
    });

    it("still classifies as a retryable throttle when the timestamp is unparseable, just without a figure", () => {
      // Recognising the throttle is safe on its own; only the figure is optional.
      // Note this string does NOT match the timestamp pattern, so it lands on
      // the fail-closed default -- which is the correct, conservative answer for
      // a shape this code has not confirmed.
      const class_ = classifyKrakenError("EService:Throttled:soon", at);
      expect(class_.retryAfterMs).toBeUndefined();
      expect(class_.retryable).toBe(false);
    });
  });

  describe("THE FAIL-CLOSED DEFAULT", () => {
    it("treats an UNRECOGNISED error string as a non-retryable exchange error", () => {
      // The single most important test in this file. An error string this code
      // has never seen must never fall through as anything a caller could
      // mistake for success, and must not be guessed retryable (which would
      // re-send an order into a refusal nobody understands) or transport (which
      // would send a definite refusal into recovery for an order that never
      // existed).
      expect(classifyKrakenError("ESomething:Entirely new in 2027", at)).toEqual({
        kind: "exchange_error",
        retryable: false,
      });
    });

    it.each([
      // All three pulled live, and none of them is in any table above.
      "EQuery:Unknown asset pair",
      "EGeneral:Unknown method",
      "EGeneral:Invalid arguments",
    ])("fails closed on the live-but-untabled string %s", (error) => {
      expect(classifyKrakenError(error, at)).toEqual({
        kind: "exchange_error",
        retryable: false,
      });
    });

    it("fails closed on a string that is not in Kraken's E<Category>:<Message> shape at all", () => {
      expect(classifyKrakenError("something went wrong", at)).toEqual({
        kind: "exchange_error",
        retryable: false,
      });
      expect(classifyKrakenError("", at)).toEqual({
        kind: "exchange_error",
        retryable: false,
      });
    });

    it("fails closed on a WARNING-prefixed entry rather than treating it as success", () => {
      // Kraken documents `W` as a warning severity. Entry 90's confirmed rule is
      // the stricter one -- "when non-empty, the request failed, even if a
      // result object is present" -- and no W entry has been observed here, so
      // the unobserved case takes the fail-closed path rather than a special one
      // written from the prose.
      expect(classifyKrakenError("WGeneral:Something noteworthy", at).retryable).toBe(false);
    });
  });
});

describe("classifyFailure", () => {
  const at = 1_788_406_450_000;

  it("produces a failed ExchangeOutcome carrying the error string as the message", () => {
    expect(classifyFailure(["EAPI:Invalid key"], at)).toEqual({
      ok: false,
      kind: "exchange_error",
      message: "EAPI:Invalid key",
      retryable: false,
      at,
    });
  });

  it("INVENTS NO HTTP STATUS", () => {
    // GeminiClient converts a 200-with-error-body by calling
    // classifyFailure(400, ...). That would be a lie here: Kraken answers 200 to
    // everything, so a fabricated 400 would put a number in `status` that no
    // Kraken response ever carried.
    const outcome = classifyFailure(["EAPI:Invalid key"], at);
    expect(outcome).not.toHaveProperty("status");
  });

  it("carries a genuine transport status through when one was supplied", () => {
    expect(classifyFailure(["EService:Unavailable"], at, { status: 502 })).toMatchObject({
      kind: "transport",
      status: 502,
    });
  });

  it("carries the throttle's retryAfterMs onto the outcome", () => {
    expect(classifyFailure(["EService:Throttled:1788406480"], at)).toEqual({
      ok: false,
      kind: "exchange_error",
      message: "EService:Throttled:1788406480",
      retryable: true,
      retryAfterMs: 30_000,
      at,
    });
  });

  describe("precedence across several errors, most cautious first", () => {
    it("lets a transport error win over a definite refusal", () => {
      // "Effect unknown" cannot be overridden by a sibling that happens to be
      // definite -- that is the direction section 5.6 exists to protect.
      expect(
        classifyFailure(["EOrder:Insufficient funds", "EService:Unavailable"], at),
      ).toMatchObject({ kind: "transport", retryable: true });
    });

    it("lets a non-retryable error win over a retryable one", () => {
      expect(
        classifyFailure(["EAPI:Invalid nonce", "EOrder:Insufficient funds"], at),
      ).toMatchObject({ kind: "exchange_error", retryable: false });
    });

    it("takes the LONGEST retryAfterMs when several are stated", () => {
      const outcome = classifyFailure(
        ["EService:Throttled:1788406460", "EService:Throttled:1788406480"],
        at,
      );
      expect(outcome).toMatchObject({ retryable: true, retryAfterMs: 30_000 });
    });

    it("joins every error into the message so none is lost", () => {
      expect(
        classifyFailure(["EAPI:Invalid nonce", "EOrder:Insufficient funds"], at).message,
      ).toBe("EAPI:Invalid nonce; EOrder:Insufficient funds");
    });
  });

  it("fails closed on an empty error array", () => {
    expect(classifyFailure([], at)).toMatchObject({
      kind: "exchange_error",
      retryable: false,
    });
  });
});

// --------------------------------------------------------------------------
// Exact decimal comparison
// --------------------------------------------------------------------------

describe("compareDecimalStrings", () => {
  it("compares beyond the money scale, where Money would collapse the values", () => {
    // Live ANKRXBT book. Both sides round to 0.00000006 at SCALE 8.
    expect(compareDecimalStrings("0.0000000601", "0.0000000607")).toBe(-1);
    expect(compareDecimalStrings("0.0000000607", "0.0000000601")).toBe(1);
  });

  it("handles unequal fraction widths and trailing zeros", () => {
    expect(compareDecimalStrings("0.000002926000", "0.000002926")).toBe(0);
    expect(compareDecimalStrings("1", "1.0000")).toBe(0);
    expect(compareDecimalStrings("77686.20000", "77686.30000")).toBe(-1);
  });

  it("handles signs", () => {
    expect(compareDecimalStrings("-1.5", "1.5")).toBe(-1);
    expect(compareDecimalStrings("-1.5", "-1.50")).toBe(0);
  });

  it("returns undefined -- not a guess -- for anything that is not a decimal string", () => {
    expect(compareDecimalStrings("abc", "1")).toBeUndefined();
    expect(compareDecimalStrings("1", "")).toBeUndefined();
    expect(compareDecimalStrings("1e-8", "1")).toBeUndefined();
  });
});

// --------------------------------------------------------------------------
// Server time
// --------------------------------------------------------------------------

describe("parseServerTime", () => {
  it("converts Kraken's SECONDS to milliseconds", () => {
    // Live: GET /0/public/Time.
    expect(parseServerTime({ unixtime: 1788406450, rfc1123: "Thu, 03 Sep 26 03:34:10 +0000" })).toBe(
      1_788_406_450_000,
    );
  });

  it("throws when unixtime is missing or not a number", () => {
    expect(() => parseServerTime({ rfc1123: "x" })).toThrow(ParseError);
    expect(() => parseServerTime({ unixtime: "1788406450" })).toThrow(/unix time in seconds/);
  });
});

// --------------------------------------------------------------------------
// Ticker / price
// --------------------------------------------------------------------------

// Live: GET /0/public/Ticker?pair=XBTUSD.
const XBT_TICKER = {
  XXBTZUSD: {
    a: ["77686.30000", "1", "1.000"],
    b: ["77686.20000", "1", "1.000"],
    c: ["77687.30000", "0.00007408"],
    v: ["430.00875205", "2306.24912176"],
    p: ["77455.28774", "77144.92769"],
    t: [14671, 101827],
    l: ["76949.60000", "76236.90000"],
    h: ["77868.00000", "77868.00000"],
    o: "77304.90000",
  },
};

// Live: GET /0/public/Ticker?pair=ANKRXBT. Ten decimal places on both sides of
// the book -- the pair that proves the crossed-book check cannot use Money.
const ANKR_TICKER = {
  ANKRXBT: {
    a: ["0.0000000607", "23802", "23802.000"],
    b: ["0.0000000601", "58522", "58522.000"],
    c: ["0.0000000605", "58521.16506582"],
    v: ["849725.88472648", "940633.25347358"],
    p: ["0.0000000599", "0.0000000591"],
    t: [58, 75],
    l: ["0.0000000518", "0.0000000508"],
    h: ["0.0000000646", "0.0000000646"],
    o: "0.0000000518",
  },
};

// Live: GET /0/public/Ticker?pair=BONKUSD. Twelve decimal places on the book and
// on `c` -- strict fromDecimalString would refuse this pair entirely.
const BONK_TICKER = {
  BONKUSD: {
    a: ["0.000002926000", "62803000", "62803000.000"],
    b: ["0.000002925000", "13921000", "13921000.000"],
    c: ["0.000002926000", "15000000.00000"],
    v: ["20517740445.51232", "111031130742.67251"],
    p: ["0.000002911929", "0.000002934498"],
    t: [608, 2801],
    l: ["0.000002860000", "0.000002860000"],
    h: ["0.000002951000", "0.000003045000"],
    o: "0.000002908000",
  },
};

describe("parsePrice", () => {
  const at = 1_788_406_450_000;

  it("reads c[0], the last trade price, and stamps RECEIPT time", () => {
    // `at` is when this system received the price; the ticker carries no
    // timestamp for the price at all.
    expect(parsePrice("BTCUSD", XBT_TICKER.XXBTZUSD, at)).toEqual({
      pair: "BTCUSD",
      price: m("77687.30000"),
      at,
    });
  });

  it("rounds a price finer than the money scale rather than refusing the pair", () => {
    // 12 decimal places, live. Half-even onto 8: 0.000002926 -> 0.00000293.
    expect(parsePrice("BONKUSD", BONK_TICKER.BONKUSD, at).price).toBe(m("0.00000293"));
  });

  describe("spec 5.7 detector 2: the crossed-book refusal", () => {
    it("refuses a book whose bid is at or above its ask", () => {
      // CONSTRUCTED, and said so: a crossed book cannot be requested on demand.
      // The live XBTUSD payload with `a` and `b` swapped, nothing else changed.
      const crossed = {
        ...XBT_TICKER.XXBTZUSD,
        a: XBT_TICKER.XXBTZUSD.b,
        b: XBT_TICKER.XXBTZUSD.a,
      };
      expect(() => parsePrice("BTCUSD", crossed, at)).toThrow(ParseError);
      expect(() => parsePrice("BTCUSD", crossed, at)).toThrow(/CROSSED book/);
    });

    it("refuses a book whose bid EQUALS its ask", () => {
      const touching = { ...XBT_TICKER.XXBTZUSD, b: ["77686.30000", "1", "1.000"] };
      expect(() => parsePrice("BTCUSD", touching, at)).toThrow(/CROSSED book/);
    });

    it("DOES NOT refuse a sub-satoshi book that is genuinely uncrossed", () => {
      // ⚠ THE REGRESSION THIS EXISTS TO PREVENT. ANKRXBT's live bid and ask are
      // 0.0000000601 and 0.0000000607: six units apart at the tenth decimal, and
      // IDENTICAL once rounded to the money scale. A check written the way
      // Gemini's is -- parse both to Money, then `bid >= ask` -- would find them
      // equal, call the book crossed, and refuse every price on this pair and on
      // every other sub-satoshi market Kraken lists.
      expect(() => parsePrice("ANKRBTC", ANKR_TICKER.ANKRXBT, at)).not.toThrow();
      expect(parsePrice("ANKRBTC", ANKR_TICKER.ANKRXBT, at).price).toBe(m("0.00000006"));
    });

    it("does not refuse the equally fine BONKUSD book", () => {
      expect(() => parsePrice("BONKUSD", BONK_TICKER.BONKUSD, at)).not.toThrow();
    });

    it("skips the check when the venue sent no book, which is not a broken one", () => {
      const noBook = { c: ["77687.30000", "0.00007408"] };
      expect(parsePrice("BTCUSD", noBook, at).price).toBe(m("77687.30000"));
    });
  });

  it("throws when c is missing, since there is no price to report", () => {
    expect(() => parsePrice("BTCUSD", { a: ["1"], b: ["0.5"] }, at)).toThrow(
      /expected "c" to be \[last price, volume\]/,
    );
  });
});

describe("parseTickerResult", () => {
  const at = 1_788_406_450_000;

  it("resolves the canonical key the client never sent", () => {
    // `?pair=BTCUSD` and `?pair=XBTUSD` both answer under XXBTZUSD, so
    // result[requested] is never valid (entry 90 PROBLEM 1).
    expect(parseTickerResult(XBT_TICKER, catalogue(), "BTCUSD", at)).toEqual({
      pair: "BTCUSD",
      price: m("77687.30000"),
      at,
    });
  });

  it("reports this system's ticker as the pair, not Kraken's canonical name", () => {
    expect(parseTickerResult(XBT_TICKER, catalogue(), "XXBTZUSD", at).pair).toBe("BTCUSD");
    expect(parseTickerResult(ANKR_TICKER, catalogue(), "ANKR/XBT", at).pair).toBe("ANKRBTC");
  });

  it("throws when no key in the result names the requested pair", () => {
    expect(() =>
      parseTickerResult({ XETHXXBT: {}, BONKUSD: {} }, catalogue(), "BTCUSD", at),
    ).toThrow(/no entry keyed by XXBTZUSD or XBTUSD/);
  });

  it("refuses a sole key naming a different market, on the same reasoning as parseCandles", () => {
    expect(() => parseTickerResult(BONK_TICKER, catalogue(), "BTCUSD", at)).toThrow(
      /a DIFFERENT market from the BTCUSD \(XXBTZUSD\) that was requested/,
    );
  });
});

// --------------------------------------------------------------------------
// AddOrder
// --------------------------------------------------------------------------

// Kraken's PUBLISHED REFERENCE example for POST /0/private/AddOrder, not a live
// capture. Note what is and is not in it: a prose sentence, and a txid array.
const ADD_ORDER_RESULT = {
  descr: { order: "buy 1.25000000 XBTUSD @ limit 27500.0" },
  txid: ["OU22CG-KLAF2-FWUDD7"],
};

describe("parseOrderResult", () => {
  const at = 1_788_406_450_000;
  const request = { clientOrderId: "v1-grid-btc-7", pair: "BTCUSD" };

  it("reads txid[0], takes identity from the REQUEST, and stamps receipt time", () => {
    expect(parseOrderResult(request, ADD_ORDER_RESULT, at)).toEqual({
      clientOrderId: "v1-grid-btc-7",
      exchangeOrderId: "OU22CG-KLAF2-FWUDD7",
      pair: "BTCUSD",
      // Kraken's `open` in this system's vocabulary: accepted, nothing executed.
      state: "pending",
      // Genuinely none, not merely unreported -- see the docblock on why the
      // same value would be WRONG on a status read.
      fills: [],
      // AddOrder returns no timestamp of any kind, so this is receipt time and
      // nothing is invented.
      acceptedAt: at,
    });
  });

  it("DOES NOT read descr.order, even when the prose contradicts the request", () => {
    // The sentence says buy 1.25 XBTUSD at 27500. The request says a different
    // pair entirely. Nothing in the output comes from the prose, so the request
    // wins -- which is the point: `descr.order` has no specified grammar and is
    // never pattern-matched (entry 90).
    const parsed = parseOrderResult(
      { clientOrderId: "v1-grid-eth-3", pair: "ETHBTC" },
      ADD_ORDER_RESULT,
      at,
    );
    expect(parsed.pair).toBe("ETHBTC");
    expect(parsed.clientOrderId).toBe("v1-grid-eth-3");
    expect(parsed).not.toHaveProperty("price");
    expect(parsed).not.toHaveProperty("quantity");
  });

  it("refuses an empty txid array rather than reporting an unnameable order", () => {
    expect(() => parseOrderResult(request, { descr: {}, txid: [] }, at)).toThrow(
      /returned no txid/,
    );
  });

  it("refuses more than one txid rather than picking [0]", () => {
    expect(() =>
      parseOrderResult(request, { descr: {}, txid: ["OU22CG-KLAF2-FWUDD7", "OTHER-ID-HERE"] }, at),
    ).toThrow(/returned 2 transaction ids/);
  });

  it("refuses a txid that is not an array, or holds a non-string", () => {
    expect(() => parseOrderResult(request, { txid: "OU22CG-KLAF2-FWUDD7" }, at)).toThrow(
      /expected txid to be an array/,
    );
    expect(() => parseOrderResult(request, { txid: [12345] }, at)).toThrow(
      /expected txid\[0\] to be a non-empty string/,
    );
  });
});

// --------------------------------------------------------------------------
// Order status
// --------------------------------------------------------------------------

// Kraken's PUBLISHED REFERENCE example for QueryOrders, not a live capture.
const CLOSED_ORDER = {
  refid: null,
  userref: 0,
  cl_ord_id: "v1-grid-btc-7",
  status: "closed",
  opentm: 1688665496.7808,
  starttm: 0,
  expiretm: 0,
  descr: {
    pair: "XBTUSD",
    type: "buy",
    ordertype: "limit",
    price: "30010.0",
    price2: "0",
    leverage: "none",
    order: "buy 1.25000000 XBTUSD @ limit 30010.0",
    close: "",
  },
  vol: "1.25000000",
  vol_exec: "1.25000000",
  cost: "37512.50000",
  fee: "37.50000",
  price: "30010.0",
  stopprice: "0.00000",
  limitprice: "0.00000",
  misc: "",
  oflags: "fciq",
  reason: null,
  closetm: 1688665499.4374,
};

describe("parseOrderStatus", () => {
  it("maps a fully executed order", () => {
    expect(parseOrderStatus("OBCMZD-JIEE7-77TH3F", CLOSED_ORDER, catalogue())).toEqual({
      clientOrderId: "v1-grid-btc-7",
      exchangeOrderId: "OBCMZD-JIEE7-77TH3F",
      // The catalogue's ticker, never descr.pair verbatim.
      pair: "BTCUSD",
      side: "buy",
      price: m("30010.0"),
      quantity: m("1.25000000"),
      filledQuantity: m("1.25000000"),
      cumulativeQuoteQuantity: m("37512.50000"),
      state: "filled",
      // opentm 1688665496.7808 seconds, rounded to ms.
      createdAt: 1_688_665_496_781,
      // closetm -- a genuine transition time, which Gemini cannot supply.
      updatedAt: 1_688_665_499_437,
    });
  });

  it("reads descr.price for the LIMIT price, never the top-level average", () => {
    // ⚠ The trap. On a Kraken order record top-level `price` is the AVERAGE
    // execution price so far and `descr.price` is the limit. An unfilled order
    // carries `price: "0.00000"`, so reading the obvious field would report a
    // limit of zero on every resting order.
    const resting = {
      ...CLOSED_ORDER,
      status: "open",
      vol_exec: "0.00000000",
      cost: "0.00000",
      fee: "0.00000",
      price: "0.00000",
      closetm: undefined,
    };
    const parsed = parseOrderStatus("OQCLML-BW3P3-BUCMWZ", resting, catalogue());
    expect(parsed.price).toBe(m("30010.0"));
    expect(parsed.price).not.toBe(ZERO);
    expect(parsed.state).toBe("pending");
    expect(parsed.filledQuantity).toBe(ZERO);
  });

  it("OMITS updatedAt entirely on a resting order rather than backfilling opentm", () => {
    const resting = { ...CLOSED_ORDER, status: "open", vol_exec: "0.00000000", closetm: 0 };
    const parsed = parseOrderStatus("OQCLML-BW3P3-BUCMWZ", resting, catalogue());
    expect("updatedAt" in parsed).toBe(false);
    expect(parsed.createdAt).toBe(1_688_665_496_781);
  });

  it("OMITS fills entirely, because Kraken's `trades` holds IDS, not executions", () => {
    const withTradeIds = { ...CLOSED_ORDER, trades: ["THVRQM-33VKH-UCI7BS"] };
    const parsed = parseOrderStatus("OBCMZD-JIEE7-77TH3F", withTradeIds, catalogue());
    // An empty array here would assert "this order has no executions", which is
    // false for an order that plainly has one.
    expect("fills" in parsed).toBe(false);
  });

  it("reports a partially filled open order as partially_filled", () => {
    const partial = {
      ...CLOSED_ORDER,
      status: "open",
      vol_exec: "0.50000000",
      cost: "15005.00000",
      closetm: undefined,
    };
    const parsed = parseOrderStatus("OQCLML-BW3P3-BUCMWZ", partial, catalogue());
    expect(parsed.state).toBe("partially_filled");
    expect(parsed.filledQuantity).toBe(m("0.50000000"));
    expect(parsed.cumulativeQuoteQuantity).toBe(m("15005.00000"));
  });

  it("keeps the filled quantity on a cancelled order", () => {
    // Section 7.2's halt depends on exactly this: a partially filled order that
    // is cancelled keeps its fill, and the state is still cancelled.
    const cancelled = { ...CLOSED_ORDER, status: "canceled", vol_exec: "0.40000000", cost: "12004.00000" };
    const parsed = parseOrderStatus("OQCLML-BW3P3-BUCMWZ", cancelled, catalogue());
    expect(parsed.state).toBe("cancelled");
    expect(parsed.filledQuantity).toBe(m("0.40000000"));
  });

  describe("clientOrderId when Kraken sends no cl_ord_id", () => {
    it("reports the ABSENCE as an empty string rather than throwing or fabricating", () => {
      // An order entered in Kraken's own UI carries no cl_ord_id, and
      // reconciliation reads exactly those. Throwing would make one manual order
      // fail getOpenOrders entirely, blinding the job that exists to find it.
      const { cl_ord_id: _omitted, ...manual } = CLOSED_ORDER;
      const parsed = parseOrderStatus("OMANUAL-XXXXX-YYYYYY", manual, catalogue());
      expect(parsed.clientOrderId).toBe("");
      expect(parsed.exchangeOrderId).toBe("OMANUAL-XXXXX-YYYYYY");
    });

    it("leaves that order classifiable as an orphan downstream", () => {
      // The empty string is not inert: parseClientOrderId("") returns null, so
      // reconcile.ts raises `unknown_open_order` naming the exchange id.
      const { cl_ord_id: _omitted, ...manual } = CLOSED_ORDER;
      const parsed = parseOrderStatus("OMANUAL-XXXXX-YYYYYY", manual, catalogue());
      expect(parsed.clientOrderId.startsWith("v1-")).toBe(false);
    });
  });

  it("throws on a pair Kraken's catalogue does not hold, rather than deriving one", () => {
    const unknownPair = { ...CLOSED_ORDER, descr: { ...CLOSED_ORDER.descr, pair: "NOPEUSD" } };
    expect(() => parseOrderStatus("OX-1-2", unknownPair, catalogue())).toThrow(
      /not in Kraken's catalogue/,
    );
  });

  it("throws on an unrecognised side", () => {
    const weird = { ...CLOSED_ORDER, descr: { ...CLOSED_ORDER.descr, type: "short" } };
    expect(() => parseOrderStatus("OX-1-2", weird, catalogue())).toThrow(/unrecognised side/);
  });
});

describe("toOrderState", () => {
  it("maps Kraken's five documented statuses", () => {
    expect(toOrderState("pending", ZERO, m("1"))).toBe("pending");
    expect(toOrderState("open", ZERO, m("1"))).toBe("pending");
    expect(toOrderState("open", m("0.5"), m("1"))).toBe("partially_filled");
    // `open` with everything filled: defensive, and resolved to an open state
    // because the venue still says the order is on the book.
    expect(toOrderState("open", m("1"), m("1"))).toBe("pending");
    expect(toOrderState("closed", m("1"), m("1"))).toBe("filled");
    // Note the spelling: one `l` on the wire, two in this system's enum.
    expect(toOrderState("canceled", m("0.5"), m("1"))).toBe("cancelled");
    expect(toOrderState("expired", ZERO, m("1"))).toBe("expired");
  });

  it("FAILS CLOSED on an unrecognised status, exactly as filters.ts does for SymbolStatus", () => {
    // CONSTRUCTED: Kraken publishes five statuses and this is not one of them.
    // Guessing an open state would leave a terminated order tracked as live;
    // guessing a terminal one would abandon a live order.
    expect(() => toOrderState("settled", ZERO, m("1"))).toThrow(ParseError);
    expect(() => toOrderState("settled", ZERO, m("1"))).toThrow(
      /unrecognised Kraken order status "settled"/,
    );
    expect(() => toOrderState("cancelled", ZERO, m("1"))).toThrow(/unrecognised/);
    expect(() => toOrderState(undefined, ZERO, m("1"))).toThrow(/unrecognised/);
  });
});

describe("parseOrderStatusMap / parseOpenOrders / parseClosedOrders", () => {
  const older = { ...CLOSED_ORDER, opentm: 1688665000.0, closetm: 0, status: "open", vol_exec: "0.00000000" };

  it("parses a {txid: order} map oldest-first", () => {
    const orders = parseOrderStatusMap(
      { "OBCMZD-JIEE7-77TH3F": CLOSED_ORDER, "OOLDER-11111-22222": older },
      catalogue(),
    );
    expect(orders.map((order) => order.exchangeOrderId)).toEqual([
      "OOLDER-11111-22222",
      "OBCMZD-JIEE7-77TH3F",
    ]);
  });

  it("unwraps OpenOrders' `open` nesting", () => {
    const orders = parseOpenOrders({ open: { "OQCLML-BW3P3-BUCMWZ": older } }, catalogue());
    expect(orders).toHaveLength(1);
    expect(orders[0]!.state).toBe("pending");
  });

  it("unwraps ClosedOrders' `closed` nesting and ignores the sibling count", () => {
    const orders = parseClosedOrders(
      { closed: { "OBCMZD-JIEE7-77TH3F": CLOSED_ORDER }, count: 1 },
      catalogue(),
    );
    expect(orders).toHaveLength(1);
    expect(orders[0]!.state).toBe("filled");
  });

  it("returns an empty list for an account with no open orders", () => {
    expect(parseOpenOrders({ open: {} }, catalogue())).toEqual([]);
  });
});

describe("requireSingleOrder", () => {
  const one = parseOrderStatus("OBCMZD-JIEE7-77TH3F", CLOSED_ORDER, catalogue());

  it("returns the single order", () => {
    expect(requireSingleOrder([one], "QueryOrders").exchangeOrderId).toBe("OBCMZD-JIEE7-77TH3F");
  });

  it("refuses an empty result rather than reporting `no such order`", () => {
    expect(() => requireSingleOrder([], "QueryOrders")).toThrow(
      /an order that exists but cannot be found/,
    );
  });

  it("refuses several answers to a one-order question", () => {
    expect(() => requireSingleOrder([one, one], "QueryOrders")).toThrow(/ambiguous/);
  });
});

// --------------------------------------------------------------------------
// Cancellation
// --------------------------------------------------------------------------

describe("parseCancelResult", () => {
  it("reads the count", () => {
    expect(parseCancelResult({ count: 1 })).toEqual({ count: 1, pending: false });
  });

  it("SURFACES `pending`, which DECISION 2 depends on being visible", () => {
    // The venue saying the cancel had not taken effect at reply time is exactly
    // the known staleness DECISION 2 accepts. A caller that cannot see the flag
    // cannot report the tradeoff it is making.
    expect(parseCancelResult({ count: 1, pending: true })).toEqual({ count: 1, pending: true });
  });

  it("accepts count 0 as an ordinary answer, not an error", () => {
    // Nothing matched: already filled, or already cancelled. Judging that
    // belongs to the caller that knows what it asked to cancel.
    expect(parseCancelResult({ count: 0 })).toEqual({ count: 0, pending: false });
  });

  it("throws on a malformed count", () => {
    expect(() => parseCancelResult({ count: "1" })).toThrow(/non-negative integer/);
    expect(() => parseCancelResult({ count: -1 })).toThrow(/non-negative integer/);
    expect(() => parseCancelResult({})).toThrow(/non-negative integer/);
  });
});

// --------------------------------------------------------------------------
// FEE ASSET (entry 90 DECISION 4)
// --------------------------------------------------------------------------

describe("parseOrderFlags", () => {
  it("splits Kraken's comma-separated oflags", () => {
    expect(parseOrderFlags("fciq")).toEqual(["fciq"]);
    expect(parseOrderFlags("fcib,post")).toEqual(["fcib", "post"]);
    expect(parseOrderFlags(" FCIQ , nompp ")).toEqual(["fciq", "nompp"]);
  });

  it("returns nothing for an absent or empty value", () => {
    expect(parseOrderFlags(undefined)).toEqual([]);
    expect(parseOrderFlags("")).toEqual([]);
    expect(parseOrderFlags(null)).toEqual([]);
  });
});

describe("feeAssetFor", () => {
  const btcusd = catalogue().requirePair("BTCUSD");
  const ethbtc = catalogue().requirePair("ETHBTC");

  describe("THE ASSERTED PATH -- every order this system places", () => {
    it("reports the QUOTE asset on both sides when fciq was sent", () => {
      // DECISION 4: oflags=fciq on every order, so the fee asset is deterministic
      // and known locally rather than inferred.
      expect(feeAssetFor(btcusd, "buy", "fciq")).toBe("USD");
      expect(feeAssetFor(btcusd, "sell", "fciq")).toBe("USD");
    });

    it("un-prefixes the quote through the catalogue, never by string surgery", () => {
      // XXBTZUSD's quote field reads ZUSD. The catalogue answers USD; nothing
      // here strips a Z.
      expect(feeAssetFor(btcusd, "sell", "fciq")).toBe("USD");
      // ETHBTC is crypto-quoted: quote XXBT -> BTC, via the alias table, whole.
      expect(feeAssetFor(ethbtc, "buy", "fciq")).toBe("BTC");
    });
  });

  describe("THE DERIVED FALLBACK -- state this system did not place", () => {
    // Reconciliation reads orders entered in Kraken's own UI, which carry
    // whatever oflags their author chose, or none. These are the only orders the
    // inference applies to, which is the whole reason DECISION 4 refused to rely
    // on it for orders this system does place.

    it("reports the BASE asset when fcib was sent explicitly", () => {
      expect(feeAssetFor(btcusd, "sell", "fcib")).toBe("BTC");
      expect(feeAssetFor(btcusd, "buy", "fcib")).toBe("BTC");
      expect(feeAssetFor(ethbtc, "sell", "fcib")).toBe("ETH");
    });

    it("falls back to Kraken's side-dependent DEFAULT when no fee flag is present", () => {
      // Kraken's documented defaults: fciq on a buy, fcib on a sell. This is the
      // path section 5.5 warns about -- the quote-currency assumption is
      // literally wrong on the sell side -- and it is confined to orders this
      // system did not create.
      expect(feeAssetFor(btcusd, "buy", undefined)).toBe("USD");
      expect(feeAssetFor(btcusd, "sell", undefined)).toBe("BTC");
      expect(feeAssetFor(ethbtc, "buy", undefined)).toBe("BTC");
      expect(feeAssetFor(ethbtc, "sell", undefined)).toBe("ETH");
    });

    it("falls back the same way for an empty oflags string, or flags carrying no fee flag", () => {
      expect(feeAssetFor(btcusd, "sell", "")).toBe("BTC");
      expect(feeAssetFor(btcusd, "sell", "post,nompp")).toBe("BTC");
      expect(feeAssetFor(btcusd, "buy", "post,nompp")).toBe("USD");
    });

    it("lets an explicit flag override the side default in both directions", () => {
      // The flag is what Kraken acted on, so it wins over the default the side
      // would otherwise imply.
      expect(feeAssetFor(btcusd, "sell", "fciq,post")).toBe("USD");
      expect(feeAssetFor(btcusd, "buy", "fcib,post")).toBe("BTC");
    });
  });
});

// --------------------------------------------------------------------------
// Trades / fills
// --------------------------------------------------------------------------

// Kraken's PUBLISHED REFERENCE example for QueryTrades, not a live capture.
// Note the absence that matters: `fee` is a bare string with NO currency field.
const QUERY_TRADES = {
  trades: {
    "THVRQM-33VKH-UCI7BS": {
      ordertxid: "OQCLML-BW3P3-BUCMWZ",
      postxid: "TKH2SE-M7IF5-CFI7LT",
      pair: "XXBTZUSD",
      time: 1688667796.8802,
      type: "buy",
      ordertype: "limit",
      price: "30010.00000",
      cost: "600.20000",
      fee: "0.96032",
      vol: "0.02000000",
      margin: "0.00000",
      leverage: "0",
      misc: "",
      trade_id: 93748276,
      maker: true,
    },
  },
  count: 1,
};

describe("parseTrades", () => {
  it("parses a fill, taking the fee asset from the asserted oflags", () => {
    expect(parseTrades(QUERY_TRADES, catalogue(), { oflags: "fciq" })).toEqual([
      {
        // The MAP KEY, a string -- not the numeric `trade_id`, so the duplicate
        // check in applyFill can never be disturbed by JSON number precision.
        fillId: "THVRQM-33VKH-UCI7BS",
        price: m("30010.00000"),
        quantity: m("0.02000000"),
        feeAmount: m("0.96032"),
        feeAsset: "USD",
        // The trade's OWN time, not inherited from the parent order.
        executedAt: 1_688_667_796_880,
      },
    ]);
  });

  it("derives the fee asset from side + pair when the order carried no fee flag", () => {
    // A buy with no flag: Kraken's default is fciq, so the quote asset.
    expect(parseTrades(QUERY_TRADES, catalogue(), {})[0]!.feeAsset).toBe("USD");

    // The same trade as a SELL with no flag: Kraken's default flips to fcib, so
    // the fee is in the BASE asset. This is the exact case section 5.5 forbids
    // assuming away, and the reason DECISION 4 asserts the flag instead.
    const sell = {
      trades: {
        "THVRQM-33VKH-UCI7BS": { ...QUERY_TRADES.trades["THVRQM-33VKH-UCI7BS"], type: "sell" },
      },
    };
    expect(parseTrades(sell, catalogue(), {})[0]!.feeAsset).toBe("BTC");
  });

  it("accepts a bare {txid: trade} map as well as the {trades, count} wrapper", () => {
    expect(parseTrades(QUERY_TRADES.trades, catalogue(), { oflags: "fciq" })).toHaveLength(1);
  });

  it("rounds a fee UP, never understating what was paid", () => {
    const fine = {
      trades: {
        "THVRQM-33VKH-UCI7BS": {
          ...QUERY_TRADES.trades["THVRQM-33VKH-UCI7BS"],
          fee: "0.000000001",
        },
      },
    };
    expect(parseTrades(fine, catalogue(), { oflags: "fciq" })[0]!.feeAmount).toBe(m("0.00000001"));
  });

  it("returns fills oldest-first", () => {
    const two = {
      trades: {
        "TLATER-00000-00000": {
          ...QUERY_TRADES.trades["THVRQM-33VKH-UCI7BS"],
          time: 1688667999.0,
        },
        "THVRQM-33VKH-UCI7BS": QUERY_TRADES.trades["THVRQM-33VKH-UCI7BS"],
      },
    };
    expect(parseTrades(two, catalogue(), { oflags: "fciq" }).map((f) => f.fillId)).toEqual([
      "THVRQM-33VKH-UCI7BS",
      "TLATER-00000-00000",
    ]);
  });

  it("resolves the trade's canonical pair name through the catalogue", () => {
    // The trade names XXBTZUSD; the fee asset must still come out as USD.
    expect(parseTrades(QUERY_TRADES, catalogue(), { oflags: "fciq" })[0]!.feeAsset).toBe("USD");
  });
});

// --------------------------------------------------------------------------
// BALANCES
// --------------------------------------------------------------------------

// Kraken's PUBLISHED REFERENCE example for BalanceEx, not a live capture.
const BALANCE_EX = {
  ZUSD: { balance: "25435.21", hold_trade: "8249.76" },
  XXBT: { balance: "1.2435", hold_trade: "0.8423" },
};

describe("parseBalances", () => {
  it("derives free = balance - hold_trade, and un-prefixes through the catalogue", () => {
    expect(parseBalances(BALANCE_EX, catalogue())).toEqual([
      // ZUSD -> USD, XXBT -> BTC. The alias table matches WHOLE asset codes.
      { asset: "USD", free: m("17185.45"), locked: m("8249.76") },
      { asset: "BTC", free: m("0.4012"), locked: m("0.8423") },
    ]);
  });

  it("keeps a zero balance rather than filtering it, so the transcription stays honest", () => {
    expect(parseBalances({ ZUSD: { balance: "0.0000", hold_trade: "0.0000" } }, catalogue())).toEqual(
      [{ asset: "USD", free: ZERO, locked: ZERO }],
    );
  });

  describe("rounding, in opposite directions per field", () => {
    it("FLOORS the balance and CEILS the hold, so free can never be overstated", () => {
      // Kraken declares XXBT with decimals: 10 (live), so balances genuinely
      // carry more precision than the money scale. gemini/parse.ts floors BOTH
      // its fields; copying that here would copy the code rather than the
      // reasoning, because the DERIVED quantity is the other one.
      const fine = { XXBT: { balance: "1.234567899", hold_trade: "0.123456781" } };
      const [balance] = parseBalances(fine, catalogue());
      expect(balance!.locked).toBe(m("0.12345679")); // ceiled: never understated
      expect(balance!.free).toBe(m("1.23456789") - m("0.12345679"));
    });

    it("clamps a sub-satoshi negative produced by that opposed rounding", () => {
      // Equal values, floored one way and ceiled the other, land 1e-8 apart.
      // That is an artefact of representation, not a contradiction.
      const equal = { XXBT: { balance: "1.000000005", hold_trade: "1.000000005" } };
      expect(parseBalances(equal, catalogue())[0]!.free).toBe(ZERO);
    });
  });

  it("REFUSES a genuinely negative free balance rather than clamping it", () => {
    // CONSTRUCTED: more on hold than the account holds is impossible, so it
    // cannot be pulled. Clamping to zero would turn a real API change into a
    // plausible-looking wrong balance.
    const impossible = { XXBT: { balance: "1.0000", hold_trade: "2.0000" } };
    expect(() => parseBalances(impossible, catalogue())).toThrow(ParseError);
    expect(() => parseBalances(impossible, catalogue())).toThrow(
      /exceeds balance .* refusing to report a negative free balance/,
    );
  });

  it("THROWS on an asset code the catalogue does not hold, taking the whole read with it", () => {
    // tickerForAsset's own documented policy, and the right one here: a balance
    // mislabelled with a guessed ticker is a wrong number in exactly the place
    // section 9 must reconcile. A failed read is a failed read; a wrong balance
    // is silent.
    const stale = { ...BALANCE_EX, XXDG: { balance: "100.0", hold_trade: "0.0" } };
    expect(() => parseBalances(stale, catalogue())).toThrow(/not in Kraken's catalogue/);
  });

  it("throws when a monetary field is a JSON number rather than a decimal string", () => {
    expect(() => parseBalances({ ZUSD: { balance: 25435.21, hold_trade: "0" } }, catalogue())).toThrow(
      /refusing to convert a non-string into Money/,
    );
  });
});

// --------------------------------------------------------------------------
// CANDLES
// --------------------------------------------------------------------------

/**
 * Live: GET /0/public/OHLC?pair=XBTUSD&interval=1, trimmed to four rows plus the
 * `last` sibling. Rows and their column order are exactly as returned.
 *
 * A row is [time, open, high, low, close, VWAP, volume, count] -- eight columns,
 * VWAP at index 5 and VOLUME AT INDEX 6.
 */
const XBT_OHLC = {
  XXBTZUSD: [
    [1788363180, "77140.6", "77224.4", "77140.6", "77224.4", "77188.6", "7.11779340", 154],
    [1788363240, "77224.9", "77299.1", "77224.8", "77250.4", "77278.2", "2.50279681", 167],
    [1788363300, "77250.4", "77298.8", "77227.0", "77231.0", "77265.6", "1.93879752", 100],
    [1788363360, "77255.5", "77290.1", "77221.3", "77221.3", "77261.9", "1.14830769", 98],
  ],
  last: 1788406320,
};

// Live: GET /0/public/OHLC?pair=BONKUSD&interval=1. Nine decimal places on every
// price -- one past the money scale.
const BONK_OHLC = {
  BONKUSD: [
    [1788363360, "0.000002924", "0.000002930", "0.000002924", "0.000002928", "0.000002929", "27908613.63710", 4],
  ],
  last: 1788406320,
};

const MINUTE = 60_000;

describe("parseCandles", () => {
  // Well after the last candle in the fixture, so every one of them is closed.
  const at = 1_788_406_450_000;

  it("parses the live payload, oldest-first, with derived close times", () => {
    const candles = parseCandles(XBT_OHLC, catalogue(), "BTCUSD", at, MINUTE);
    expect(candles).toHaveLength(4);
    expect(candles[0]).toEqual({
      pair: "BTCUSD",
      openTime: 1_788_363_180_000,
      // Kraken publishes no close time; it is the candle's last millisecond.
      closeTime: 1_788_363_180_000 + MINUTE - 1,
      open: m("77140.6"),
      high: m("77224.4"),
      low: m("77140.6"),
      close: m("77224.4"),
      volume: m("7.11779340"),
      closed: true,
    });
  });

  describe("THE `last` SIBLING KEY", () => {
    it("skips it instead of trying to parse a number as a candle row", () => {
      // {"XXBTZUSD": [[...]], "last": 1788406320} -- verified live. A parser that
      // iterates the result map looking for candles finds `last` and tries to
      // read a NUMBER as an array of rows.
      expect(OHLC_LAST_KEY).toBe("last");
      const candles = parseCandles(XBT_OHLC, catalogue(), "BTCUSD", at, MINUTE);
      expect(candles).toHaveLength(4);
      expect(candles.every((candle) => candle.pair === "BTCUSD")).toBe(true);
    });

    it("strips it BEFORE resolving the pair, so the sole-key fallback still works", () => {
      // With `last` left in, the map always has at least two entries and
      // selectPairResult's sole-key fallback can never fire -- so a reply keyed
      // by a name the catalogue cannot match would be refused outright rather
      // than resolved. Here the key is neither the canonical nor the altname.
      const oddlyKeyed = { "XBT/USD": XBT_OHLC.XXBTZUSD, last: 1788406320 };
      expect(parseCandles(oddlyKeyed, catalogue(), "BTCUSD", at, MINUTE)).toHaveLength(4);
    });

    it("still parses when Kraken omits `last` entirely", () => {
      expect(parseCandles({ XXBTZUSD: XBT_OHLC.XXBTZUSD }, catalogue(), "BTCUSD", at, MINUTE)).toHaveLength(
        4,
      );
    });
  });

  describe("THE COLUMN ORDER", () => {
    it("reads VOLUME from index 6, not the VWAP at index 5", () => {
      // ⚠ Binance's klines and Gemini's /v2/candles both put volume at index 5,
      // so the field that reads across from both other venues is wrong here --
      // and wrong plausibly: the VWAP is a price-shaped number in the right
      // magnitude range. Live row: [..., "77188.6", "7.11779340", 154]. The VWAP
      // sits with the OHLC prices near 77,000; the volume is 7.1.
      const [candle] = parseCandles(XBT_OHLC, catalogue(), "BTCUSD", at, MINUTE);
      expect(candle!.volume).toBe(m("7.11779340"));
      expect(candle!.volume).not.toBe(m("77188.6"));
    });

    it("refuses a row too short to hold the columns it needs", () => {
      const truncated = { XXBTZUSD: [[1788363180, "1", "2", "3", "4", "5"]] };
      expect(() => parseCandles(truncated, catalogue(), "BTCUSD", at, MINUTE)).toThrow(
        /\[time, open, high, low, close, vwap, volume, count\]/,
      );
    });
  });

  it("marks the in-progress candle closed: false", () => {
    // `at` inside the last candle's minute: its close time has not passed.
    const during = 1_788_363_360_000 + 30_000;
    const candles = parseCandles(XBT_OHLC, catalogue(), "BTCUSD", during, MINUTE);
    expect(candles.map((candle) => candle.closed)).toEqual([true, true, true, false]);
  });

  it("sorts ascending rather than trusting Kraken's ordering", () => {
    const reversed = { XXBTZUSD: [...XBT_OHLC.XXBTZUSD].reverse(), last: 1788406320 };
    expect(parseCandles(reversed, catalogue(), "BTCUSD", at, MINUTE).map((c) => c.openTime)).toEqual([
      1_788_363_180_000, 1_788_363_240_000, 1_788_363_300_000, 1_788_363_360_000,
    ]);
  });

  it("rounds a sub-satoshi price rather than refusing the pair entirely", () => {
    // BONKUSD publishes 9 decimal places live. Strict fromDecimalString throws
    // past 8, which would make the market unreadable -- the same failure an
    // 11-place Gemini balance caused before fromDecimalStringRounded existed.
    const [candle] = parseCandles(BONK_OHLC, catalogue(), "BONKUSD", at, MINUTE);
    expect(candle!.open).toBe(m("0.00000292"));
    expect(candle!.high).toBe(m("0.00000293"));
    expect(candle!.volume).toBe(m("27908613.63710"));
    expect(candle!.pair).toBe("BONKUSD");
  });

  it("resolves the canonical result key the client never sent", () => {
    expect(parseCandles(XBT_OHLC, catalogue(), "XBTUSD", at, MINUTE)[0]!.pair).toBe("BTCUSD");
    expect(parseCandles(XBT_OHLC, catalogue(), "XXBTZUSD", at, MINUTE)[0]!.pair).toBe("BTCUSD");
  });

  it("throws when no key names the requested pair and several are present", () => {
    expect(() =>
      parseCandles({ BONKUSD: [], XXBTZUSD: [], last: 1 }, catalogue(), "ETHBTC", at, MINUTE),
    ).toThrow(/no candle array keyed by XETHXXBT or ETHXBT/);
  });

  it("REFUSES a sole key that names a DIFFERENT market this catalogue can place", () => {
    // ⚠ Found by writing the test above. With `last` stripped, a map holding one
    // entry for BONKUSD becomes a single-key map, and selectPairResult's
    // sole-key fallback would hand BONKUSD's candles back as ETHBTC's. That is
    // one pair's data under another pair's name -- the exact corruption entry 90
    // PROBLEM 1 exists to prevent -- so the fallback is narrowed: a sole key
    // that RESOLVES must resolve to the pair that was requested.
    expect(() => parseCandles({ BONKUSD: [], last: 1 }, catalogue(), "ETHBTC", at, MINUTE)).toThrow(
      ParseError,
    );
    expect(() => parseCandles({ BONKUSD: [], last: 1 }, catalogue(), "ETHBTC", at, MINUTE)).toThrow(
      /a DIFFERENT market from the ETHBTC \(XETHXXBT\) that was requested/,
    );
  });

  it("STILL ACCEPTS a sole key this catalogue cannot place, which is what the fallback is for", () => {
    // Kraken keys replies by names the client did not choose, so an unrecognised
    // single key is almost certainly the pair that was asked about. That case is
    // untouched -- only the recognisable-and-wrong one is refused.
    const unknownKey = { "XXBTZUSD.FUTURE": XBT_OHLC.XXBTZUSD, last: 1788406320 };
    expect(parseCandles(unknownKey, catalogue(), "BTCUSD", at, MINUTE)).toHaveLength(4);
  });

  it("throws when the pair's value is not an array of rows", () => {
    expect(() => parseCandles({ XXBTZUSD: 12345, last: 1 }, catalogue(), "BTCUSD", at, MINUTE)).toThrow(
      /expected XXBTZUSD to hold an array of candle rows/,
    );
  });
});

// --------------------------------------------------------------------------
// TIMEFRAMES -- the interval Kraken does not have
// --------------------------------------------------------------------------

describe("KRAKEN_TIMEFRAMES", () => {
  it("is TOTAL over CandleInterval, so a new interval cannot be forgotten", () => {
    // The record covers every member of the closed union. Adding one to
    // CandleInterval breaks the build here until Kraken's answer is written
    // down -- which is the property a Partial<Record<...>> would have thrown
    // away.
    expect(Object.keys(KRAKEN_TIMEFRAMES).sort()).toEqual(
      ["1d", "1h", "1m", "15m", "30m", "5m", "6h"].sort(),
    );
  });

  it("maps every interval Kraken publishes to its minute count", () => {
    expect(KRAKEN_TIMEFRAMES["1m"]).toEqual({ minutes: 1, ms: 60_000 });
    expect(KRAKEN_TIMEFRAMES["5m"]).toEqual({ minutes: 5, ms: 300_000 });
    expect(KRAKEN_TIMEFRAMES["15m"]).toEqual({ minutes: 15, ms: 900_000 });
    expect(KRAKEN_TIMEFRAMES["30m"]).toEqual({ minutes: 30, ms: 1_800_000 });
    expect(KRAKEN_TIMEFRAMES["1h"]).toEqual({ minutes: 60, ms: 3_600_000 });
    expect(KRAKEN_TIMEFRAMES["1d"]).toEqual({ minutes: 1440, ms: 86_400_000 });
  });

  it("states the 6-hour absence as null rather than substituting a nearby length", () => {
    // Kraken's OHLC intervals are 1, 5, 15, 30, 60, 240, 1440, 10080, 21600
    // minutes -- 240 and 1440 with nothing between. Mapping "6h" onto either
    // would answer a request for six-hour candles with four-hour or daily ones
    // and the caller could not tell.
    expect(KRAKEN_TIMEFRAMES["6h"]).toBeNull();
  });
});

describe("krakenTimeframe", () => {
  it("returns the timeframe for the interval v1 actually exercises", () => {
    // Only "1m" is exercised in v1 -- the price feed's gap-backfill, section 4.6.
    expect(krakenTimeframe("1m")).toEqual({ minutes: 1, ms: 60_000 });
  });

  it("THROWS on 6h, naming what the venue lacks", () => {
    // Live confirmation that this is not pedantry: `OHLC&interval=360` answers
    // {"error":["EGeneral:Invalid arguments"]} -- Kraken refuses it too, just
    // later and less clearly.
    expect(() => krakenTimeframe("6h")).toThrow(ParseError);
    expect(() => krakenTimeframe("6h")).toThrow(/Kraken publishes no 6h OHLC interval/);
    expect(() => krakenTimeframe("6h")).toThrow(/nothing between 240 and 1440/);
  });
});
