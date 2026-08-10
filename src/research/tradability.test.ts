/**
 * The naming heuristic, tested where it actually lives.
 *
 * Everything else in `tradability.ts` is exercised through its callers
 * (`watchlist.test.ts`, `candles.test.ts`, `candidates.test.ts`, `api.test.ts`)
 * because that is where the refusals turn into a `WatchlistError`, a 400 or a
 * discarded candidate. This file exists for the one thing those cannot show
 * clearly: the heuristic ITSELF -- one string comparison and one venue-table
 * lookup -- and the four properties it would look correct without.
 *
 *  1. IT REJECTS A REAL PERPETUAL. `HYPEUSDCPERP` is a real Gemini symbol
 *     (decision log 31, confirmed live in 32), and every research path accepted
 *     it before this existed.
 *  2. IT DOES NOT REJECT `PERPUSD`. Perpetual Protocol is a real token with a
 *     real spot ticker that CONTAINS "perp" and does not END in it. This is the
 *     single assertion separating `endsWith` from `includes`, and decision log
 *     31 flagged the risk before the code existed.
 *  3. THE TABLE IS CONSULTED PER VENUE. A hard-coded `["perp"]` would pass every
 *     Gemini test in this file.
 *  4. IT IS OPT-IN PER CALL SITE. The order path passes
 *     "structural-check-elsewhere" so its real `product_type` check stays the
 *     one that answers -- see `assertBotPairIsSpotTradable` and the regression
 *     test in `api.test.ts`.
 *
 * NOTHING HERE HAS SPOKEN TO GEMINI OR BINANCE. The catalogues are stubs; the
 * perpetual symbols in them are real strings copied from a live listing, not a
 * live listing.
 */

import { describe, expect, it } from "vitest";

import { checkTradable, type TradablePairSource, type VenueAccount } from "./tradability";
import type { ExchangeId } from "../db/schema";

const GEMINI: VenueAccount = { label: "gemini-main", exchange: "gemini" };
const BINANCE: VenueAccount = { label: "main", exchange: "binance" };

const REFUSING = "Refusing, for the caller's own reason.";

/**
 * A stub catalogue.
 *
 * `HYPEUSDCPERP` and `HYPEGUSDPERP` are REAL strings off Gemini's live
 * catalogue (decision log 31). `PERPUSD` is the shape of Perpetual Protocol's
 * real spot ticker; Gemini is not known to list it, and it is here as the exact
 * false-reject this heuristic must not produce.
 */
const GEMINI_PAIRS = ["BTCUSD", "ETHUSD", "PERPUSD", "HYPEGUSDPERP", "HYPEUSDCPERP"];

function catalogue(pairs: readonly string[]): TradablePairSource {
  return async () => ({ ok: true, pairs: [...pairs], cached: false, fetchedAt: 1_910_000_000_000 });
}

const unreadable: TradablePairSource = async () => ({
  ok: false,
  failure: {
    ok: false,
    kind: "transport",
    message: "connection reset",
    retryable: true,
    at: 1_910_000_000_000,
  },
});

const gemini = catalogue(GEMINI_PAIRS);

describe("checkTradable's derivative-naming heuristic", () => {
  it("rejects a real Gemini perpetual that the venue genuinely lists", async () => {
    // The gap decision log 31 flagged and 32 closed only at the order path:
    // this pair IS on Gemini's list, so the catalogue check passes it. Before
    // this heuristic, `addToWatchlist`, `fetchCandleWindow` and
    // `selectNamedCandidate` all accepted it with zero resistance.
    const refusal = await checkTradable(
      gemini,
      GEMINI,
      "HYPEUSDCPERP",
      REFUSING,
      "reject-derivative-names",
    );

    expect(refusal?.code).toBe("pair_not_spot_by_name");
    expect(refusal?.message).toContain("HYPEUSDCPERP");
    // Not `pair_not_tradable`: the venue really does list it, and saying
    // otherwise would send an operator hunting a spelling mistake that is not
    // there -- the same honesty rule the bot gate's ordering already follows.
    expect(refusal?.message).toContain("is listed on gemini");
  });

  it("rejects the OTHER real perpetual too, so the fixture is not carrying one case", async () => {
    const refusal = await checkTradable(
      gemini,
      GEMINI,
      "HYPEGUSDPERP",
      REFUSING,
      "reject-derivative-names",
    );

    expect(refusal?.code).toBe("pair_not_spot_by_name");
  });

  it("does NOT reject PERPUSD, which contains 'perp' but does not end in it", async () => {
    // THE `endsWith`-VERSUS-`includes` TEST, and the reason the heuristic is
    // written the way it is. Perpetual Protocol is a real token whose spot
    // ticker is `PERPUSD`; a substring match would refuse a genuine spot pair
    // and call it a derivative. Decision log 31 flagged this before any of this
    // code existed, and 32 repeated it as a reason not to use a naming rule at
    // the order path at all.
    const refusal = await checkTradable(
      gemini,
      GEMINI,
      "PERPUSD",
      REFUSING,
      "reject-derivative-names",
    );

    expect(refusal).toBeNull();
  });

  it("leaves an ordinary spot pair completely unaffected", async () => {
    expect(
      await checkTradable(gemini, GEMINI, "BTCUSD", REFUSING, "reject-derivative-names"),
    ).toBeNull();
    expect(
      await checkTradable(gemini, GEMINI, "ETHUSD", REFUSING, "reject-derivative-names"),
    ).toBeNull();
  });

  it("consults the venue table rather than one hard-coded rule", async () => {
    // A DELIBERATELY HYPOTHETICAL CATALOGUE. Binance's spot host does not list
    // perpetuals at all -- that is exactly why its table row is `[]` -- so this
    // fixture could not happen today. It is here because a hard-coded `["perp"]`
    // inside the heuristic passes every other test in this file, and only a
    // second venue answering DIFFERENTLY about the same string can catch it.
    //
    // What it pins is the lookup, not a claim about Binance. If a client for
    // `fapi.binance.com` is ever added, the table row changes and so does this.
    const refusal = await checkTradable(
      catalogue(["BTCUSDT", "HYPEUSDCPERP"]),
      BINANCE,
      "HYPEUSDCPERP",
      REFUSING,
      "reject-derivative-names",
    );

    expect(refusal).toBeNull();
  });

  it("is skipped entirely when the call site says the structural check runs elsewhere", async () => {
    // The order path's answer. `POST /api/bots` opts out so that
    // `checkSpotInstrument`'s real `product_type` read is the thing that
    // refuses -- both to keep real venue evidence in the message a human reads,
    // and so that check cannot be deleted with every test still green.
    const refusal = await checkTradable(
      gemini,
      GEMINI,
      "HYPEUSDCPERP",
      REFUSING,
      "structural-check-elsewhere",
    );

    expect(refusal).toBeNull();
  });
});

describe("what the heuristic does not disturb", () => {
  it("reports an UNLISTED perp-shaped symbol as not tradable, not as a derivative", async () => {
    // Ordering: the catalogue answers first, so the strongest TRUE fact is the
    // one that surfaces. What is wrong with `FOOPERP` is that this venue does
    // not list it, and "it looks like a derivative" would be a less useful
    // answer that happens to also be an unverifiable one.
    const refusal = await checkTradable(
      gemini,
      GEMINI,
      "FOOPERP",
      REFUSING,
      "reject-derivative-names",
    );

    expect(refusal?.code).toBe("pair_not_tradable");
  });

  it("still fails closed on an unreadable catalogue rather than name-matching", async () => {
    // A perp-shaped symbol must not let an outage be answered from the string
    // alone. Section 5.6: a failed read is never data -- including when this
    // code thinks it could guess the answer.
    const refusal = await checkTradable(
      unreadable,
      GEMINI,
      "HYPEUSDCPERP",
      REFUSING,
      "reject-derivative-names",
    );

    expect(refusal?.code).toBe("tradable_set_unreadable");
  });

  it("does not case-fold the catalogue comparison to reach a name match", async () => {
    // Step 28's rule survives: `hypeusdcperp` is not on the (upper-cased)
    // catalogue, so it is `pair_not_tradable`. The heuristic folds the pair for
    // its OWN suffix test and never for the catalogue's membership test.
    const refusal = await checkTradable(
      gemini,
      GEMINI,
      "hypeusdcperp",
      REFUSING,
      "reject-derivative-names",
    );

    expect(refusal?.code).toBe("pair_not_tradable");
  });
});

describe("the refusal says what kind of evidence it has", () => {
  it("states that it is an inference and names where to fix a wrong one", async () => {
    // Requirement, not decoration. A false reject is the failure direction this
    // heuristic deliberately prefers BECAUSE it is loud and immediately
    // fixable, and that is only true if the operator reading the refusal is
    // told it is a naming inference and where the table lives.
    const refusal = await checkTradable(
      gemini,
      GEMINI,
      "HYPEUSDCPERP",
      REFUSING,
      "reject-derivative-names",
    );

    expect(refusal?.message).toContain("NOT A STATEMENT FROM THE VENUE");
    expect(refusal?.message).toContain("DERIVATIVE_NAME_SUFFIXES");
    expect(refusal?.message).toContain("src/research/tradability.ts");
    expect(refusal?.message).toContain(REFUSING);
  });
});

describe("the venue table must be exhaustive", () => {
  it("fails to compile if a venue has no entry", () => {
    // A RUNTIME NO-OP that is really a COMPILE-TIME assertion: `tsc --noEmit`
    // covers `src/**/*.ts` including this file, so the `@ts-expect-error` below
    // fails the typecheck the day it stops being an error -- which is the day
    // someone widens `ExchangeId` and the real table stops being exhaustive.
    //
    // This mirrors the shape of `DERIVATIVE_NAME_SUFFIXES` rather than
    // importing it, because the property under test is the TYPE, and the real
    // table is private on purpose (nothing outside this module may read a
    // per-venue naming rule and re-implement the check).
    // @ts-expect-error -- a venue with no entry is not a valid table
    const incomplete: Readonly<Record<ExchangeId, readonly string[]>> = { gemini: ["perp"] };
    void incomplete;

    const complete: Readonly<Record<ExchangeId, readonly string[]>> = {
      gemini: ["perp"],
      binance: [],
    };
    expect(Object.keys(complete).sort()).toEqual(["binance", "gemini"]);
  });
});
