/**
 * The independent price reference (entry 86 PART 6's open item).
 *
 * ── REAL-DATA DISCIPLINE, AND WHAT IS AND IS NOT REAL HERE ──
 *
 * The prices in the threshold tests are **live Gemini and Kraken public tickers,
 * captured together on 2026-09-04** by requesting `/v1/pubticker/{symbol}` and
 * `/0/public/Ticker?pair={altname}` for each pair in the same pass. They are
 * pasted here exactly as returned. They are what `DIVERGENCE_THRESHOLD`'s
 * docblock tabulates, so the constant and the tests that defend it rest on the
 * same seventeen observations rather than on two separate guesses.
 *
 * That matters more than it usually does. A false-positive threshold in this
 * check does not produce a wrong number somewhere -- it produces an alert that
 * fires on healthy feeds, and entry 86 already recorded what happens to an alert
 * surface nobody can trust. The only way to know 2% is above the noise is to
 * have measured the noise.
 *
 * **CONSTRUCTED, AND LABELLED WHERE IT APPEARS:** the sandbox reproduction's
 * frozen `78172.34` against a live BTC price, and the sub-satoshi rounding
 * cases. Neither can be requested on demand -- the first is a fault that has to
 * be induced and the second needs a price below anything currently listed -- so
 * they are built by hand and say so, which is the treatment entry 91 and entry
 * 92 give their own constructed fixtures and for the same reason: a fixture
 * posing as pulled data teaches the wrong shape next time.
 */

import { beforeEach, describe, expect, it } from "vitest";

import type { Database } from "../db/database";
import { botInstanceRow, freshDatabase } from "../db/test-helpers";
import type { ExchangeOutcome } from "../shared/downtime";
import type { Pair, Price, Timestamp } from "../shared/exchange-client";
import { fromDecimalString as m, toTrimmedString, type Money } from "../shared/money";
import {
  asPercent,
  crossCheckRunsIn,
  crossCheckSource,
  divergenceBetween,
  evaluateCrossCheck,
  DIVERGENCE_THRESHOLD,
  PRICE_REFERENCE_DIVERGENCE_ALERT,
  quantumAllowance,
  runPriceCrossCheck,
  type CrossCheckPorts,
} from "./price-cross-check";

const T0 = 1_760_000_000_000;
const ACCOUNT = "cross-check-main";

// ---------------------------------------------------------------------------
// LIVE CAPTURE -- Gemini and Kraken public tickers, 2026-09-04, one pass.
//
// `/v1/pubticker/{symbol}`.`last` and `/0/public/Ticker?pair=...`.`c[0]`.
// Verbatim; only the pair name has been added as a label.
// ---------------------------------------------------------------------------
const LIVE_SPREADS: readonly { pair: Pair; gemini: string; kraken: string }[] = [
  { pair: "BTCUSD", gemini: "80760.01", kraken: "80768.6" },
  { pair: "ETHUSD", gemini: "2501.64", kraken: "2506.64" },
  { pair: "SOLUSD", gemini: "103.617", kraken: "103.6" },
  { pair: "DOGEUSD", gemini: "0.08686", kraken: "0.0868891" },
  { pair: "LINKUSD", gemini: "11.82415", kraken: "11.86862" },
  { pair: "LTCUSD", gemini: "50.83", kraken: "50.93" },
  { pair: "XRPUSD", gemini: "1.44513", kraken: "1.44501" },
  { pair: "AVAXUSD", gemini: "7.452", kraken: "7.463" },
  { pair: "DOTUSD", gemini: "0.869", kraken: "0.871" },
  { pair: "SHIBUSD", gemini: "0.000005302", kraken: "0.00000531" },
  { pair: "PEPEUSD", gemini: "0.000003623", kraken: "0.00000363" },
  { pair: "BONKUSD", gemini: "0.000003088", kraken: "0.000003085" },
  { pair: "ATOMUSD", gemini: "1.516", kraken: "1.5126" },
  { pair: "FILUSD", gemini: "0.7682", kraken: "0.771" },
  { pair: "AAVEUSD", gemini: "132.9009", kraken: "132.77" },
  { pair: "UNIUSD", gemini: "6.2696", kraken: "6.3103" },
  { pair: "CRVUSD", gemini: "0.3726", kraken: "0.371" },
];

/**
 * `fromDecimalString` refuses more than 8 decimal places, and three of the live
 * captures carry nine (`0.000005302`). That refusal is correct and must not be
 * softened: this is exactly the sub-satoshi precision entry 92 PART 3 found the
 * crossed-book detector mishandling. Truncating here is what the real path does
 * too -- a `Money` price IS the rounded value -- so the tests measure the same
 * numbers the check measures, rounding included.
 */
function atScale(decimal: string): Money {
  const [whole, fraction = ""] = decimal.split(".");
  return m(`${whole}.${fraction.slice(0, 8).padEnd(1, "0")}`);
}

// ---------------------------------------------------------------------------

describe("the threshold sits above real cross-exchange spread", () => {
  it("measures each live capture at the divergence the two tickers actually showed", () => {
    // Pins the arithmetic against the numbers `DIVERGENCE_THRESHOLD`'s docblock
    // quotes. If `divergenceBetween` is ever rewritten, this says whether the
    // researched threshold still means what it was measured to mean.
    const measured = LIVE_SPREADS.map(({ pair, gemini, kraken }) => ({
      pair,
      divergence: divergenceBetween(atScale(gemini), atScale(kraken))!,
    }));

    const worst = measured.reduce((a, b) => (b.divergence > a.divergence ? b : a));
    expect(worst.pair).toBe("UNIUSD");
    // 0.647%, the widest of the seventeen. Still a third of the threshold.
    expect(asPercent(worst.divergence)).toBe("0.647064%");
    expect(worst.divergence).toBeLessThan(DIVERGENCE_THRESHOLD);
  });

  it("does NOT alert on any of the seventeen live pairs", async () => {
    // ⚠ THE FALSE-POSITIVE TEST, and the one this check would be worse than
    // useless without. Every pair here was healthy on both venues at capture
    // time. A threshold that fires on any of them is a threshold that fires on
    // a normal Tuesday.
    for (const { pair, gemini, kraken } of LIVE_SPREADS) {
      const outcome = evaluateCrossCheck(pair, atScale(gemini), atScale(kraken));
      expect(
        outcome.status,
        `${pair}: gemini ${gemini} vs kraken ${kraken} is ordinary spread ` +
          `(${asPercent(outcome.divergence ?? 0n)}) and must not alert`,
      ).toBe("agreed");
    }
  });

  it("leaves room above the worst live reading rather than hugging it", () => {
    // The threshold is a decision, not an emergent value, so its relationship
    // to the data is asserted rather than left to a reader to recompute.
    const worst = LIVE_SPREADS.map(({ gemini, kraken }) =>
      divergenceBetween(atScale(gemini), atScale(kraken))!,
    ).reduce((a, b) => (b > a ? b : a));

    expect(DIVERGENCE_THRESHOLD).toBe(m("0.02")); // 2%
    // At least 3x the worst observed normal spread.
    expect(DIVERGENCE_THRESHOLD).toBeGreaterThan(worst * 3n);
    // And well under 1% is what "normal" looked like, on every one of them.
    expect(worst).toBeLessThan(m("0.01"));
  });
});

// ---------------------------------------------------------------------------

describe("a genuinely broken feed", () => {
  /**
   * ⚠ CONSTRUCTED, from the 2026-09-02 incident's shape. `78172.34` is the value
   * entry 86 records the Gemini sandbox publishing 1439 times consecutively --
   * a real captured number -- and it is compared here against the LIVE Kraken
   * BTC price from the same capture as the table above. The pairing is the
   * construction: those two numbers were never observed at the same moment.
   */
  const SANDBOX_FROZEN = "78172.34";
  const LIVE_BTC = "80768.6";

  it("fires on the sandbox incident's own numbers", () => {
    const outcome = evaluateCrossCheck("BTCUSD", m(SANDBOX_FROZEN), m(LIVE_BTC));
    expect(outcome.status).toBe("diverged");
    expect(asPercent(outcome.divergence!)).toBe("3.266949%");
  });

  it("fires on the class of fault, not just on that one gap", () => {
    // The incident this exists for does not arrive at a tuned percentage. A feed
    // reporting a different market, a decimal shift, a stale-by-weeks price:
    // each is orders of magnitude out, and all of them must land the same way.
    const cases: readonly [string, string, string][] = [
      ["a decimal place lost", "8076.86", "80768.6"],
      ["a decimal place gained", "807686", "80768.6"],
      ["a different market entirely", "2506.64", "80768.6"],
      ["weeks-stale", "43000", "80768.6"],
    ];
    for (const [label, primary, reference] of cases) {
      const outcome = evaluateCrossCheck("BTCUSD", m(primary), m(reference));
      expect(outcome.status, `${label} must alert`).toBe("diverged");
    }
  });

  it("catches a divergence in either direction", () => {
    // Symmetric by construction (`divergenceBetween` divides by the midpoint),
    // and asserted because a check that only noticed the primary reading LOW
    // would miss half the fault class.
    const low = evaluateCrossCheck("BTCUSD", m("60000"), m("80768.6"));
    const high = evaluateCrossCheck("BTCUSD", m("100000"), m("80768.6"));
    expect(low.status).toBe("diverged");
    expect(high.status).toBe("diverged");
  });

  it("does not fire just above the live noise floor", () => {
    // 1% -- above every one of the seventeen live readings, below the threshold.
    // This is the deliberate dead band, asserted so a future "tighten it a bit"
    // has to argue with a test rather than with a comment.
    const outcome = evaluateCrossCheck("BTCUSD", m("80768.6"), m("81576.28"));
    expect(asPercent(outcome.divergence!)).toBe("0.995018%");
    expect(outcome.status).toBe("agreed");
  });
});

// ---------------------------------------------------------------------------

describe("scale-8 rounding cannot masquerade as a divergence", () => {
  it("widens the band by exactly what one quantum is worth", () => {
    // SHIB from the live capture: 0.00000530 is 530 quanta, so one unit of
    // rounding is ~0.19% -- a tenth of the threshold, from the representation
    // alone. This is entry 92 PART 3's fault line, measured.
    const shib = atScale("0.000005302");
    const allowance = quantumAllowance(shib, atScale("0.00000531"))!;
    expect(asPercent(allowance)).toBe("0.188502%");
    expect(evaluateCrossCheck("SHIBUSD", shib, atScale("0.00000531")).allowed).toBe(
      DIVERGENCE_THRESHOLD + allowance,
    );
  });

  it("⚠ CONSTRUCTED: declines to conclude anything about a price near the scale floor", () => {
    // 0.00000002 -- two quanta. No such pair is currently listed on either
    // venue, which is why this is built rather than captured. One unit of
    // rounding here is 50% of the price, so a divergence and an artefact are
    // literally the same number and the honest answer is "cannot tell".
    const outcome = evaluateCrossCheck("FAKEUSD", m("0.00000002"), m("0.00000003"));
    expect(outcome.status).toBe("skipped");
    expect(outcome.reason).toContain("cannot be cross-checked at scale 8");
    expect(outcome.reason).toContain("entry 92 PART 3");
  });

  it("⚠ CONSTRUCTED: reports rather than divides when both prices round to zero", () => {
    const outcome = evaluateCrossCheck("DUSTUSD", 0n, 0n);
    expect(outcome.status).toBe("skipped");
    expect(outcome.reason).toContain("round to zero at scale 8");
  });

  it("still catches a real divergence on a sub-satoshi pair", () => {
    // The allowance must not neuter the check on cheap coins. BONK's live price
    // against a tenfold error on the same pair: the band widens by 0.03% and the
    // fault is 163%, so the widening changes nothing that matters.
    const outcome = evaluateCrossCheck("BONKUSD", atScale("0.00000031"), atScale("0.000003085"));
    expect(outcome.status).toBe("diverged");
  });
});

// ---------------------------------------------------------------------------

describe("the environment gate", () => {
  it("runs on production and nowhere else", () => {
    expect(crossCheckRunsIn("production")).toBe(true);
    // Testnet's primary feed IS a simulator (entry 86), so every pair would
    // diverge on every pass, forever.
    expect(crossCheckRunsIn("testnet")).toBe(false);
    expect(crossCheckRunsIn("unconfigured")).toBe(false);
    expect(crossCheckRunsIn(undefined)).toBe(false);
    expect(crossCheckRunsIn("")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The pass, against a real database
// ---------------------------------------------------------------------------

let db: Database;

beforeEach(async () => {
  db = await freshDatabase();
});

function price(pair: Pair, value: Money, at: Timestamp = T0): ExchangeOutcome<Price> {
  return { ok: true, value: { pair, price: value, at }, at };
}

function unreachable<T>(message: string): ExchangeOutcome<T> {
  return { ok: false, kind: "transport", message, retryable: true, at: T0 };
}

interface PortSpec {
  primary?: Record<string, ExchangeOutcome<Price>>;
  reference?: Record<string, ExchangeOutcome<Price>>;
  listing?: ExchangeOutcome<readonly Pair[]>;
}

function ports(spec: PortSpec): CrossCheckPorts {
  return {
    primaryPrice: async (pair) =>
      spec.primary?.[pair] ?? unreachable<Price>(`no primary fixture for ${pair}`),
    referenceListing: async () => spec.listing ?? { ok: true, value: ["BTCUSD", "ETHUSD"], at: T0 },
    referencePrice: async (pair) =>
      spec.reference?.[pair] ?? unreachable<Price>(`no reference fixture for ${pair}`),
  };
}

function request(overrides: Partial<Parameters<typeof runPriceCrossCheck>[3]> = {}) {
  return {
    accountLabel: ACCOUNT,
    primaryExchange: "gemini" as const,
    referenceExchange: "kraken" as const,
    pairs: ["BTCUSD"],
    at: T0,
    ...overrides,
  };
}

const ids = () => {
  let n = 0;
  return () => `alert-${++n}`;
};

async function openAlerts(): Promise<{ message: string }[]> {
  const rows = await db.alerts.findMany({
    where: { alert_type: PRICE_REFERENCE_DIVERGENCE_ALERT, resolved: false },
  });
  return rows.map((row) => ({ message: row.message }));
}

describe("raising the alert", () => {
  it("writes one critical row naming both prices, both venues and the pair", async () => {
    const result = await runPriceCrossCheck(
      db,
      ids(),
      ports({
        primary: { BTCUSD: price("BTCUSD", m("78172.34")) },
        reference: { BTCUSD: price("BTCUSD", m("80768.6")) },
      }),
      request(),
    );

    expect(result.raised).toEqual(["BTCUSD"]);
    const rows = await db.alerts.findMany({
      where: { alert_type: PRICE_REFERENCE_DIVERGENCE_ALERT },
    });
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.severity).toBe("critical");
    expect(row.category).toBe("system");
    expect(row.source).toBe(crossCheckSource(ACCOUNT));
    expect(row.bot_instance_id).toBeNull();
    // The four facts an operator needs before they can start deciding which
    // venue is lying, all in the row itself.
    expect(row.message).toContain("BTCUSD");
    expect(row.message).toContain("78172.34");
    expect(row.message).toContain("80768.6");
    expect(row.message).toContain("gemini");
    expect(row.message).toContain("kraken");
  });

  it("says in the row that nothing was withheld from the bots", async () => {
    // ⚠ Entry 92's observe-don't-gate rule, stated where the person acting on
    // the alert will read it. An operator who assumes trading stopped will make
    // a different (and worse) decision than one who knows it did not.
    await runPriceCrossCheck(
      db,
      ids(),
      ports({
        primary: { BTCUSD: price("BTCUSD", m("78172.34")) },
        reference: { BTCUSD: price("BTCUSD", m("80768.6")) },
      }),
      request(),
    );
    const [alert] = await openAlerts();
    expect(alert!.message).toContain("NOTHING HAS BEEN WITHHELD");
  });

  it("is one row per incident, not one per pass", async () => {
    const port = ports({
      primary: { BTCUSD: price("BTCUSD", m("78172.34")) },
      reference: { BTCUSD: price("BTCUSD", m("80768.6")) },
    });
    const newId = ids();
    const first = await runPriceCrossCheck(db, newId, port, request());
    const second = await runPriceCrossCheck(db, newId, port, request({ at: T0 + 300_000 }));

    expect(first.raised).toEqual(["BTCUSD"]);
    // Still detected -- the finding is current -- but no second row. 288 passes
    // a day would otherwise be 288 rows for one fault.
    expect(second.raised).toEqual([]);
    expect(second.outcomes[0]!.status).toBe("diverged");
    expect(await openAlerts()).toHaveLength(1);
  });

  it("names every diverged pair in the one row", async () => {
    const result = await runPriceCrossCheck(
      db,
      ids(),
      ports({
        listing: { ok: true, value: ["BTCUSD", "ETHUSD"], at: T0 },
        primary: {
          BTCUSD: price("BTCUSD", m("78172.34")),
          ETHUSD: price("ETHUSD", m("1900")),
        },
        reference: {
          BTCUSD: price("BTCUSD", m("80768.6")),
          ETHUSD: price("ETHUSD", m("2506.64")),
        },
      }),
      request({ pairs: ["BTCUSD", "ETHUSD"] }),
    );

    expect(result.raised).toEqual(["BTCUSD", "ETHUSD"]);
    const [alert] = await openAlerts();
    expect(alert!.message).toContain("2 pairs");
    expect(alert!.message).toContain("BTCUSD");
    expect(alert!.message).toContain("ETHUSD");
  });

  it("closes the row once the two venues agree again", async () => {
    const newId = ids();
    await runPriceCrossCheck(
      db,
      newId,
      ports({
        primary: { BTCUSD: price("BTCUSD", m("78172.34")) },
        reference: { BTCUSD: price("BTCUSD", m("80768.6")) },
      }),
      request(),
    );
    expect(await openAlerts()).toHaveLength(1);

    const recovered = await runPriceCrossCheck(
      db,
      newId,
      ports({
        primary: { BTCUSD: price("BTCUSD", m("80760.01")) },
        reference: { BTCUSD: price("BTCUSD", m("80768.6")) },
      }),
      request({ at: T0 + 300_000 }),
    );

    expect(recovered.resolved).toHaveLength(1);
    expect(await openAlerts()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------

describe("the check's own failures are not evidence about the feed", () => {
  it("raises nothing when Kraken's catalogue is unreachable", async () => {
    const result = await runPriceCrossCheck(
      db,
      ids(),
      ports({
        listing: unreachable<readonly Pair[]>("connect timeout"),
        primary: { BTCUSD: price("BTCUSD", m("78172.34")) },
      }),
      request(),
    );

    expect(result.observed).toBe(false);
    expect(result.outcomes[0]!.status).toBe("skipped");
    expect(result.outcomes[0]!.reason).toContain("says nothing about the gemini feed");
    expect(await openAlerts()).toHaveLength(0);
  });

  it("raises nothing when Kraken's ticker is unreachable", async () => {
    const result = await runPriceCrossCheck(
      db,
      ids(),
      ports({
        primary: { BTCUSD: price("BTCUSD", m("78172.34")) },
        reference: { BTCUSD: unreachable<Price>("503 from api.kraken.com") },
      }),
      request(),
    );

    expect(result.observed).toBe(false);
    expect(result.outcomes[0]!.status).toBe("skipped");
    expect(await openAlerts()).toHaveLength(0);
  });

  it("⚠ does NOT close a live divergence because Kraken went down", async () => {
    // Section 5.6 applied to the alert lifecycle. A pass that saw nothing found
    // nothing; treating that as "resolved" would clear a real incident on the
    // strength of an outage in the checker.
    const newId = ids();
    await runPriceCrossCheck(
      db,
      newId,
      ports({
        primary: { BTCUSD: price("BTCUSD", m("78172.34")) },
        reference: { BTCUSD: price("BTCUSD", m("80768.6")) },
      }),
      request(),
    );
    expect(await openAlerts()).toHaveLength(1);

    const blind = await runPriceCrossCheck(
      db,
      newId,
      ports({
        listing: unreachable<readonly Pair[]>("connect timeout"),
        primary: { BTCUSD: price("BTCUSD", m("78172.34")) },
      }),
      request({ at: T0 + 300_000 }),
    );

    expect(blind.resolved).toEqual([]);
    expect(await openAlerts()).toHaveLength(1);
  });

  it("skips gracefully, and silently, for a pair Kraken does not list", async () => {
    // Confirmed real: not every pair a bot trades exists on both venues.
    // Nothing is wrong when one does not, and nothing may be reported.
    const result = await runPriceCrossCheck(
      db,
      ids(),
      ports({
        listing: { ok: true, value: ["BTCUSD", "ETHUSD"], at: T0 },
        primary: { PONSUSD: price("PONSUSD", m("1.5")) },
      }),
      request({ pairs: ["PONSUSD"] }),
    );

    expect(result.outcomes[0]!.status).toBe("skipped");
    expect(result.outcomes[0]!.reason).toContain("not listed on kraken");
    expect(result.outcomes[0]!.reason).toContain("Not a fault");
    expect(result.observed).toBe(false);
    expect(await openAlerts()).toHaveLength(0);
  });

  it("skips when the primary read fails, rather than duplicating price_feed_blind", async () => {
    const result = await runPriceCrossCheck(
      db,
      ids(),
      ports({
        primary: { BTCUSD: unreachable<Price>("budget_exhausted") },
        reference: { BTCUSD: price("BTCUSD", m("80768.6")) },
      }),
      request(),
    );

    expect(result.outcomes[0]!.status).toBe("skipped");
    expect(result.outcomes[0]!.reason).toContain("could not be read");
    expect(await openAlerts()).toHaveLength(0);
  });

  it("refuses to check the reference venue against itself", async () => {
    // A Kraken account's prices ARE the reference. Reporting perfect agreement
    // every pass would be a green light this system has not earned.
    const result = await runPriceCrossCheck(
      db,
      ids(),
      ports({ primary: { BTCUSD: price("BTCUSD", m("80768.6")) } }),
      request({ primaryExchange: "kraken" }),
    );

    expect(result.observed).toBe(false);
    expect(result.outcomes[0]!.status).toBe("skipped");
    expect(result.outcomes[0]!.reason).toContain("cannot independently corroborate its own");
    expect(await openAlerts()).toHaveLength(0);
  });

  it("matches pair names across the venues' spellings", async () => {
    // `BTC/USD`, `btc-usd` and `BTCUSD` are one market. A bot's stored pair need
    // not be spelled the way the reference catalogue spells it, and a name
    // mismatch presenting as "not listed" would silently switch the check off.
    const result = await runPriceCrossCheck(
      db,
      ids(),
      ports({
        listing: { ok: true, value: ["BTC/USD"], at: T0 },
        primary: { btcusd: price("btcusd", m("80760.01")) },
        reference: { btcusd: price("btcusd", m("80768.6")) },
      }),
      request({ pairs: ["btcusd"] }),
    );

    expect(result.outcomes[0]!.status).toBe("agreed");
    expect(result.observed).toBe(true);
  });
});

// ---------------------------------------------------------------------------

describe("nothing is gated on the result", () => {
  it("returns findings and writes a row, and does not touch any bot", async () => {
    // ⚠ ENTRY 92'S RULE, PINNED STRUCTURALLY. This module has no access to a
    // `BotInstance` stub and no way to halt anything -- `runPriceCrossCheck`
    // takes a `Database` and three read ports, and that is the whole surface.
    // The assertion that survives a refactor is that the bot row is untouched.
    await db.botInstances.insert(
      botInstanceRow({
        id: "grid-btc-1",
        account_label: ACCOUNT,
        exchange: "gemini",
        pair: "BTCUSD",
        status: "running",
      }),
    );

    await runPriceCrossCheck(
      db,
      ids(),
      ports({
        primary: { BTCUSD: price("BTCUSD", m("78172.34")) },
        reference: { BTCUSD: price("BTCUSD", m("80768.6")) },
      }),
      request(),
    );

    const bot = await db.botInstances.findOne({ id: "grid-btc-1" });
    expect(bot!.status).toBe("running");
    expect(bot!.halt_reason).toBeNull();
    expect(bot!.halted_at).toBeNull();
  });
});

// ---------------------------------------------------------------------------

describe("the message an operator reads", () => {
  it("renders percentages a human can compare to a spread", () => {
    expect(asPercent(m("0.02"))).toBe("2%");
    expect(asPercent(divergenceBetween(m("80760.01"), m("80768.6"))!)).toBe("0.010636%");
    expect(toTrimmedString(m("80768.6"))).toBe("80768.6");
  });
});
