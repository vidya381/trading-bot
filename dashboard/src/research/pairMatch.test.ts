/**
 * The pair field's two decisions, tested where they live rather than inside the
 * `.tsx` that renders them (entry 45 gap (b): a decision in a `.tsx` is untestable
 * in this repository, because React does not resolve in the Workers pool and a
 * test importing one collects zero tests instead of failing).
 *
 * ⚠ NEITHER FUNCTION IS A TRADABILITY GATE, and the tests are written so that
 * cannot be misread: `selectNamedCandidate` checks tradability for real against
 * the live cached set and refuses with `pair_not_tradable`. These two only decide
 * what to OFFER and which spelling to SEND.
 */

import { describe, expect, it } from "vitest";

import { MAX_PAIR_SUGGESTIONS, canonicalPair, suggestPairs } from "./pairMatch";

const PAIRS = ["BTCUSD", "BTCUSDT", "ETHBTC", "ETHUSD", "SOLUSD", "ZZQUSD"];

describe("suggestPairs", () => {
  it("offers nothing for an untouched field rather than dumping the whole venue", () => {
    expect(suggestPairs(PAIRS, "")).toEqual([]);
    expect(suggestPairs(PAIRS, "   ")).toEqual([]);
  });

  it("puts prefix matches before substring matches", () => {
    // ETHBTC merely CONTAINS "BTC"; the two that start with it come first.
    expect(suggestPairs(PAIRS, "BTC")).toEqual(["BTCUSD", "BTCUSDT", "ETHBTC"]);
  });

  it("is case-insensitive, because venues disagree about case", () => {
    expect(suggestPairs(PAIRS, "btc")).toEqual(suggestPairs(PAIRS, "BTC"));
    expect(suggestPairs(PAIRS, "bTc")).toEqual(suggestPairs(PAIRS, "BTC"));
  });

  it("ignores surrounding whitespace", () => {
    expect(suggestPairs(PAIRS, "  eth ")).toEqual(["ETHBTC", "ETHUSD"]);
  });

  it("offers nothing when nothing matches", () => {
    expect(suggestPairs(PAIRS, "DOGE")).toEqual([]);
  });

  it("caps the list rather than rendering hundreds of symbols", () => {
    const many = Array.from({ length: 300 }, (_, i) => `AAA${String(i).padStart(3, "0")}`);
    expect(suggestPairs(many, "AAA")).toHaveLength(MAX_PAIR_SUGGESTIONS);
  });

  it("returns each pair in the venue's own spelling, not the typed one", () => {
    expect(suggestPairs(PAIRS, "btcusd")[0]).toBe("BTCUSD");
  });
});

describe("canonicalPair", () => {
  it("returns the venue's spelling for a case-insensitive exact match", () => {
    expect(canonicalPair(PAIRS, "btcusd")).toBe("BTCUSD");
    expect(canonicalPair(PAIRS, "  ZzQuSd  ")).toBe("ZZQUSD");
  });

  it("returns null for a prefix, so a partial entry is never submitted as whole", () => {
    // "BTCUSD" is a real pair AND a prefix of "BTCUSDT"; "BTCUS" is neither.
    expect(canonicalPair(PAIRS, "BTCUS")).toBeNull();
  });

  it("returns null for a symbol the venue does not list", () => {
    expect(canonicalPair(PAIRS, "DOGEUSD")).toBeNull();
  });

  it("returns null for an empty entry", () => {
    expect(canonicalPair(PAIRS, "")).toBeNull();
    expect(canonicalPair(PAIRS, "   ")).toBeNull();
  });

  it("returns null when the venue list has not loaded, rather than guessing", () => {
    expect(canonicalPair([], "BTCUSD")).toBeNull();
  });
});
