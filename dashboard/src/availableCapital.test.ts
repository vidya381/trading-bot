/**
 * `availableCapital.ts` -- the AVAILABLE tiles' shape, labelling and refusals.
 *
 * WHAT THIS FILE CAN AND CANNOT PROVE, stated up front because the gap is real.
 * The dashboard has no jsdom and no testing-library, and a test importing a
 * `.tsx` collects ZERO TESTS RATHER THAN FAILING inside the Workers pool this
 * suite runs in (decision logs 44, 45, 46, 48). So nothing here mounts
 * `AccountSummary` or reads a rendered DOM node.
 *
 * That is exactly why every decision worth asserting was pushed OUT of the
 * component and into this module: how many cards exist, which account and asset
 * each belongs to, what its label says, which hint sentence it carries, and
 * whether it is flagged over-allocated are all decided here and are all checked
 * below. What remains unproven by any test -- the amber CLASS ATTRIBUTE reaching
 * the screen, and the tile's position in the grid -- is verified by the
 * operator's eyes, as it is for every other tile in that row.
 *
 * The money fixtures are the operator's REAL, live-confirmed ledger values for
 * `gemini-main`/USD, written as the raw scale-8 integers D1 actually stores, so
 * the test fails if the raw -> decimal-string mapping ever changes underneath
 * the figure a human reads.
 */

import { describe, expect, it } from "vitest";
import { toDecimalString } from "../../src/shared/money";
import { formatMoney } from "./format";
import type { Account, AccountAssetHeadroom } from "./api/types";
import {
  availableCapital,
  cardsForAsset,
  assetsWithoutTotals,
  AVAILABLE_HINT,
  OVER_ALLOCATED_HINT,
} from "./availableCapital";

/**
 * The operator's live figures for `gemini-main`/USD, raw scale-8, confirmed
 * against the deployed ledger. `AVAILABLE_RAW` is not written as a literal on
 * purpose -- it is the subtraction, so a test that passed while the constant was
 * wrong is not possible.
 */
const BALANCE_RAW = 9_995_669_131_000n;
const ALLOCATED_RAW = 260_806_000_000n;
const AVAILABLE_RAW = BALANCE_RAW - ALLOCATED_RAW;

/** One ledger row as the API publishes it: raw bigints rendered to decimals. */
function headroom(
  asset: string,
  balance: bigint,
  allocated: bigint,
  updatedAt = 1_900_000_000_000,
): AccountAssetHeadroom {
  return {
    asset,
    totalBalance: toDecimalString(balance),
    totalAllocated: toDecimalString(allocated),
    // Computed server-side by `readAccountCapital`; mirrored here exactly.
    available: toDecimalString(balance - allocated),
    updatedAt,
  };
}

function account(
  accountLabel: string,
  assets: readonly AccountAssetHeadroom[] | null,
  exchange = "gemini",
): Account {
  return {
    accountLabel,
    exchange,
    createdAt: 1_900_000_000_000,
    capital: assets === null ? null : { readAt: 1_900_000_000_001, rowsRead: assets.length, assets },
  };
}

describe("the operator's live figure", () => {
  it("carries balance - allocated exactly, to the last digit of scale 8", () => {
    const capital = availableCapital([
      account("gemini-main", [headroom("USD", BALANCE_RAW, ALLOCATED_RAW)]),
    ]);

    expect(capital.cards).toHaveLength(1);
    const [card] = capital.cards;

    // The raw subtraction, as the operator confirmed it against live D1.
    expect(AVAILABLE_RAW).toBe(9_734_863_131_000n);
    // And the figure the tile actually shows, to full stored precision.
    expect(card.value).toBe("97348.63131000");
    expect(card.value).toBe(toDecimalString(AVAILABLE_RAW));

    // The two inputs travel with it, unrounded, so the tile can be checked by
    // hand against the ledger without a second request.
    expect(card.totalBalance).toBe("99956.69131000");
    expect(card.totalAllocated).toBe("2608.06000000");

    expect(card.accountLabel).toBe("gemini-main");
    expect(card.asset).toBe("USD");
    expect(card.overAllocated).toBe(false);
    expect(card.hint).toBe(AVAILABLE_HINT);
  });

  it("renders in the money column as 97348.63, and never as a float", () => {
    const capital = availableCapital([
      account("gemini-main", [headroom("USD", BALANCE_RAW, ALLOCATED_RAW)]),
    ]);
    // Two decimals like every other money tile in the row. The exact value is
    // still on the card for anyone who needs it; only the display is shortened.
    expect(formatMoney(capital.cards[0].value)).toBe("97348.63");
  });

  it("does not round, clamp or otherwise touch the value on its way through", () => {
    // A value with significant digits at the very bottom of scale 8: it must
    // survive intact, because this module performs no arithmetic on money.
    const capital = availableCapital([account("a", [headroom("USD", 100_000_001n, 1n)])]);
    expect(capital.cards[0].value).toBe("1.00000000");
    expect(capital.cards[0].totalBalance).toBe("1.00000001");
  });
});

describe("over-allocated (allocated exceeds balance)", () => {
  // The live figures inverted: the account owes more than it holds by exactly
  // the amount it was previously free by.
  const capital = availableCapital([
    account("gemini-main", [headroom("USD", ALLOCATED_RAW, BALANCE_RAW)]),
  ]);
  const [card] = capital.cards;

  it("shows the negative figure and does NOT clamp it to zero", () => {
    expect(card.value).toBe("-97348.63131000");
    expect(card.value).toBe(toDecimalString(ALLOCATED_RAW - BALANCE_RAW));
    // The specific thing that must never happen: a real over-allocation tidied
    // into a reassuring zero.
    expect(card.value).not.toBe("0.00000000");
    expect(formatMoney(card.value)).toBe("-97348.63");
  });

  it("flags the card so the component renders it amber", () => {
    expect(card.overAllocated).toBe(true);
  });

  it("swaps the subtext for the one that names the condition", () => {
    expect(card.hint).toBe(OVER_ALLOCATED_HINT);
    expect(card.hint).toBe("over-allocated: allocated exceeds balance");
  });

  it("is still a card, still counted, still on screen", () => {
    // The failure mode being guarded: dropping the row as "impossible" and
    // leaving the operator with no tile at all.
    expect(capital.cards).toHaveLength(1);
    expect(capital.malformedRows).toBe(0);
    expect(capital.unreadableAccounts).toEqual([]);
  });

  it("treats exactly-zero headroom as healthy, not as over-allocated", () => {
    const exact = availableCapital([account("a", [headroom("USD", BALANCE_RAW, BALANCE_RAW)])]);
    expect(exact.cards[0].value).toBe("0.00000000");
    expect(exact.cards[0].overAllocated).toBe(false);
    expect(exact.cards[0].hint).toBe(AVAILABLE_HINT);
  });
});

describe("two accounts funding the same asset", () => {
  // Deliberately constructed even though today's live data has one account:
  // "never summed" is the property most likely to be broken by a future
  // refactor and least likely to be noticed, because a blended figure looks
  // completely normal.
  const capital = availableCapital([
    account("gemini-main", [headroom("USD", BALANCE_RAW, ALLOCATED_RAW)]),
    account("gemini-second", [headroom("USD", 500_000_000_000n, 100_000_000_000n)]),
  ]);

  it("produces one card per account, never one combined card", () => {
    expect(capital.cards).toHaveLength(2);
    expect(capital.cards.map((card) => card.accountLabel)).toEqual([
      "gemini-main",
      "gemini-second",
    ]);
  });

  it("never sums the two accounts' headroom", () => {
    const values = capital.cards.map((card) => card.value);
    expect(values).toEqual(["97348.63131000", "4000.00000000"]);
    // The number that must not exist anywhere in the output: 97348.63131 +
    // 4000 = 101348.63131. No bot can spend it, because no ledger row holds it.
    const summed = toDecimalString(AVAILABLE_RAW + 400_000_000_000n);
    expect(summed).toBe("101348.63131000");
    expect(values).not.toContain(summed);
  });

  it("labels each card with its account, so two USD tiles are tellable apart", () => {
    expect(capital.cards.map((card) => card.label)).toEqual([
      "Available · gemini-main",
      "Available · gemini-second",
    ]);
  });

  it("orders by asset then account, stably across repeated polls", () => {
    const reversed = availableCapital([
      account("gemini-second", [headroom("USD", 500_000_000_000n, 100_000_000_000n)]),
      account("gemini-main", [headroom("USD", BALANCE_RAW, ALLOCATED_RAW)]),
    ]);
    // Same order regardless of the order the API happened to return them in --
    // a row that reshuffled under a 5-second poll would be unreadable.
    expect(reversed.cards.map((card) => card.accountLabel)).toEqual([
      "gemini-main",
      "gemini-second",
    ]);
  });

  it("keeps the plain label when each asset has only one funding account", () => {
    const split = availableCapital([
      account("gemini-main", [headroom("USD", BALANCE_RAW, ALLOCATED_RAW)]),
      account("binance-main", [headroom("USDT", 500_000_000_000n, 0n)], "binance"),
    ]);
    // Today's case, and the brief's requirement: this reads as a single
    // AVAILABLE tile per strip, with no account decoration to explain.
    expect(split.cards.map((card) => card.label)).toEqual(["Available", "Available"]);
    expect(split.cards.map((card) => card.asset)).toEqual(["USD", "USDT"]);
  });
});

describe("one account holding several assets", () => {
  const capital = availableCapital([
    account("gemini-main", [
      headroom("USD", BALANCE_RAW, ALLOCATED_RAW),
      headroom("BTC", 100_000_000n, 0n),
    ]),
  ]);

  it("emits a card per asset and never blends them", () => {
    expect(capital.cards).toHaveLength(2);
    // Sorted by asset: BTC before USD.
    expect(capital.cards.map((card) => card.asset)).toEqual(["BTC", "USD"]);
    expect(capital.cards.map((card) => card.value)).toEqual(["1.00000000", "97348.63131000"]);
  });

  it("selects one asset's cards for its own strip", () => {
    expect(cardsForAsset(capital, "USD").map((card) => card.value)).toEqual(["97348.63131000"]);
    expect(cardsForAsset(capital, "ETH")).toEqual([]);
  });
});

describe("what it refuses to show", () => {
  it("renders nothing at all before the first successful load", () => {
    // NULL IS NOT ZERO. A confident "0.00 available" for a ledger that has not
    // loaded is indistinguishable from a genuinely exhausted account.
    expect(availableCapital(null)).toEqual({
      cards: [],
      unreadableAccounts: [],
      malformedRows: 0,
    });
  });

  it("names the accounts whose ledger read FAILED rather than omitting them", () => {
    const capital = availableCapital([
      account("gemini-main", [headroom("USD", BALANCE_RAW, ALLOCATED_RAW)]),
      account("broken", null),
    ]);
    expect(capital.cards).toHaveLength(1);
    expect(capital.unreadableAccounts).toEqual(["broken"]);
  });

  it("distinguishes an unseeded account from an unreadable one", () => {
    // An account with no ledger row is a real, common state -- nothing creates
    // one automatically. It produces no card AND no failure note; only a read
    // that actually failed produces the note.
    const capital = availableCapital([account("unseeded", [])]);
    expect(capital.cards).toEqual([]);
    expect(capital.unreadableAccounts).toEqual([]);
  });

  it("drops and counts a row whose money strings do not parse", () => {
    const capital = availableCapital([
      account("gemini-main", [
        { asset: "USD", totalBalance: "oops", totalAllocated: "0", available: "0", updatedAt: 1 },
        headroom("BTC", 100_000_000n, 0n),
      ]),
    ]);
    expect(capital.malformedRows).toBe(1);
    expect(capital.cards.map((card) => card.asset)).toEqual(["BTC"]);
  });

  it("does not label a lone survivor as if it had a sibling", () => {
    // The dropped row must not leave the remaining USD tile wearing an
    // account-disambiguating label for a tile that is not on screen.
    const capital = availableCapital([
      account("gemini-main", [headroom("USD", BALANCE_RAW, ALLOCATED_RAW)]),
      account("broken-row", [
        { asset: "USD", totalBalance: "x", totalAllocated: "x", available: "x", updatedAt: 1 },
      ]),
    ]);
    expect(capital.cards.map((card) => card.label)).toEqual(["Available"]);
  });
});

describe("assets with headroom but no bots", () => {
  const capital = availableCapital([
    account("gemini-main", [
      headroom("USD", BALANCE_RAW, ALLOCATED_RAW),
      headroom("BTC", 100_000_000n, 0n),
    ]),
  ]);

  it("reports the assets the bot-derived totals do not cover", () => {
    // USD has bots; BTC does not. BTC still needs a strip, because "what can I
    // start a bot with" is the whole point of the figure.
    expect(assetsWithoutTotals(capital, ["USD"])).toEqual(["BTC"]);
  });

  it("reports none when every funded asset already has a strip", () => {
    expect(assetsWithoutTotals(capital, ["USD", "BTC"])).toEqual([]);
  });

  it("does not repeat an asset funded by two accounts", () => {
    const two = availableCapital([
      account("a", [headroom("USD", BALANCE_RAW, ALLOCATED_RAW)]),
      account("b", [headroom("USD", 100n, 0n)]),
    ]);
    expect(assetsWithoutTotals(two, [])).toEqual(["USD"]);
  });
});
