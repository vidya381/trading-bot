/**
 * The status strip must not state a number it does not have.
 *
 * ── THE BUG THIS PINS ──
 *
 * The dashboard page mounts `StatusStrip` unconditionally, above the
 * `firstLoad` / `hardError` ternary that gates the bot table, so the strip is on
 * screen before any fetch has resolved. It used to be handed `botsPoll.data ?? []`
 * and `alertsPoll.data ?? []`, which turned "not loaded" into "empty fleet" one
 * line before the counting happened -- and counting an empty array is honest
 * arithmetic on a dishonest premise. The result was a row of confident zeroes:
 * RUNNING 0 in full emerald, UNRESOLVED ALERTS 0 in the same muted grey a real
 * all-clear uses, for a fleet nothing had loaded yet.
 *
 * The account-money rows below never had the bug -- `accountTotals([])` yields
 * an empty array and `AccountSummary` renders nothing for it -- which is exactly
 * why the loading screenshot showed one row of zeroes and no money rows at all.
 *
 * ── WHY THIS TESTS A FUNCTION AND NOT A RENDER ──
 *
 * There is no component test in this repository and this one is not the first.
 * The suite runs inside the Workers runtime (see vitest.config.ts), which has no
 * DOM, and a `.tsx` module cannot even be imported there: its JSX compiles to a
 * `react/jsx-runtime` import and React ships CommonJS that workerd cannot
 * `require`. `citations.test.ts` records the same constraint.
 *
 * So the rule was extracted into `statusCounts.ts` and is tested at full
 * strength here. What that leaves uncovered is stated plainly rather than
 * implied: this proves no numeric value is PRODUCED for an unloaded list, not
 * that `StatusStrip.tsx` renders what it is given. The component's remaining job
 * is placing five strings into five tiles, and the type system carries that --
 * `CountValues` is all strings, so there is no path by which a tile could show a
 * count this module did not hand it.
 */

import { describe, expect, it } from "vitest";

import { countValues, UNKNOWN } from "./statusCounts";
import type { Alert, Bot, BotStatus } from "./api/types";

/** A bot with only the fields these counts read; the rest are never touched. */
function bot(status: BotStatus): Bot {
  return {
    id: `bot-${status}`,
    accountLabel: "gemini-main",
    exchange: "gemini",
    pair: "BTC-USD",
    strategy: "grid",
    status,
    allocatedCapital: "1000.00000000",
    capitalAsset: "USD",
    stopLossPct: "5.00000000",
    takeProfitPct: null,
    haltReason: null,
    haltedAt: null,
    archived: false,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    position: null,
    lastPrice: null,
    cycleCount: 0,
    fees: { reported: "0.00000000", unpricedCount: 0 },
    orphaned: false,
  };
}

function alert(resolved: boolean): Alert {
  return {
    id: `alert-${resolved}`,
    severity: "warning",
    category: "trading",
    alertType: "test",
    botInstanceId: null,
    source: "test",
    message: "test",
    resolved,
    createdAt: 1_700_000_000_000,
    notifiedAt: null,
  };
}

/** Every tile value the strip can display, as one array. */
function allValues(values: ReturnType<typeof countValues>): readonly string[] {
  return [values.running, values.halted, values.stopped, values.created, values.unresolved];
}

describe("countValues, while a list has not loaded", () => {
  it("renders NO numeric value in any tile when neither list has arrived", () => {
    const values = countValues(null, null);

    // The assertion the bug is really about: not "shows a dash" but "shows no
    // digit anywhere". A future placeholder of "0 of 0" or "—/0" would satisfy
    // a dash check and reintroduce exactly the misreading this fixes.
    for (const value of allValues(values)) {
      expect(value).not.toMatch(/[0-9]/);
      expect(value).toBe(UNKNOWN);
    }
  });

  it("hides only the tiles the failed list feeds, since the two polls fail separately", () => {
    // Bots loaded, alerts not: the four status counts are real, the alert count
    // is not knowable. An all-clear alert tile over an unloaded alert feed is
    // the same lie in a smaller place.
    const botsOnly = countValues([bot("running"), bot("halted")], null);
    expect(botsOnly.running).toBe("1");
    expect(botsOnly.halted).toBe("1");
    expect(botsOnly.stopped).toBe("0");
    expect(botsOnly.unresolved).toBe(UNKNOWN);

    // Alerts loaded, bots not: the mirror image.
    const alertsOnly = countValues(null, [alert(false), alert(true)]);
    expect(alertsOnly.unresolved).toBe("1");
    expect(alertsOnly.running).toBe(UNKNOWN);
    expect(alertsOnly.halted).toBe(UNKNOWN);
    expect(alertsOnly.stopped).toBe(UNKNOWN);
    expect(alertsOnly.created).toBe(UNKNOWN);
  });

  it("still reports a real zero for a fleet that genuinely has no bots", () => {
    // The other half of the rule, and the reason this is not simply "hide zeroes".
    // An empty array is a confirmed answer and must keep reading as one.
    const values = countValues([], []);
    expect(allValues(values)).toEqual(["0", "0", "0", "0", "0"]);
  });
});

describe("countValues, once loaded", () => {
  it("counts each status independently and ignores the others", () => {
    const values = countValues(
      [bot("running"), bot("running"), bot("halted"), bot("stopped"), bot("created")],
      [alert(false), alert(false), alert(true)],
    );
    expect(values).toEqual({
      running: "2",
      halted: "1",
      stopped: "1",
      created: "1",
      unresolved: "2",
    });
  });

  it("counts archived bots, which are hidden from the table but still real", () => {
    // The strip is deliberately given the FULL list (see Dashboard.tsx): an
    // archived bot still holds its allocation and may still hold inventory.
    const archived = { ...bot("halted"), archived: true };
    expect(countValues([archived], []).halted).toBe("1");
  });
});
