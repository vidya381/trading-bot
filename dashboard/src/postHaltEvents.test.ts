/**
 * THE POST-HALT NOTICE'S VERDICTS, tested where they can be reached.
 *
 * The dashboard has no component-test harness
 * (`docs/open-items/component-test-harness.md`), so nothing in this repository
 * can mount `PostHaltNotice.tsx` and read the DOM. That is why every decision it
 * renders lives in `postHaltEvents.ts` and is tested here, and why the
 * component's CALL SITE is pinned separately at the source level in
 * `components/post-halt-notice.test.ts`.
 *
 * ⚠ WHAT THIS FILE PROVES AND WHAT IT DOES NOT. It proves the verdicts are
 * right. It proves nothing about colour, contrast, placement, or whether the
 * amber band is legible on the deployed page -- those are the operator's, as
 * every UI step in this project has been.
 */

import { describe, expect, it } from "vitest";

import {
  alertRowAnchor,
  POST_HALT_KIND_LABEL,
  postHaltNotice,
  postHaltTagTitle,
} from "./postHaltEvents";
import type { Bot, PostHaltEvent } from "./api/types";

const AT = 1_787_650_864_861;

function event(overrides: Partial<PostHaltEvent> = {}): PostHaltEvent {
  return {
    kind: "cycle_completed",
    at: AT,
    status: "halted",
    haltReasonAtTime: "stop_loss: price fell through the stop-loss",
    clientOrderId: "bot-xs0ufw-7",
    summary: "cycle 1 completed while this bot was halted",
    grossProfit: "1.99999200",
    capitalAsset: "USDT",
    suppressed: "the bot would have halted `take_profit_reached` for review (autoRestart is off)",
    auditId: "audit-row-1",
    alertId: "alert-row-1",
    ...overrides,
  };
}

/** A halted bot carrying whatever post-halt events a test wants. */
function bot(postHaltEvents: PostHaltEvent[], overrides: Partial<Bot> = {}): Bot {
  return {
    id: "bot-xs0ufw",
    accountLabel: "gemini-main",
    exchange: "gemini",
    pair: "BTC-USD",
    strategy: "dca",
    status: "halted",
    allocatedCapital: "400.00000000",
    capitalAsset: "USDT",
    stopLossPct: "20.00000000",
    takeProfitPct: "2.00000000",
    haltReason: "stop_loss: price fell through the stop-loss",
    haltedAt: AT,
    archived: false,
    createdAt: AT,
    updatedAt: AT,
    position: null,
    lastPrice: null,
    cycleCount: 1,
    postHaltEvents,
    fees: { reported: "0.00000000", unpricedCount: 0 },
    orphaned: false,
    ...overrides,
  };
}

describe("when the notice renders at all", () => {
  it("says nothing for a bot with no post-halt events", () => {
    // NULL, not an empty notice. Every healthy bot in the fleet takes this path,
    // and a notice with zero items would draw an empty amber band on all of them.
    expect(postHaltNotice(bot([]))).toBeNull();
    expect(postHaltTagTitle(bot([]))).toBeNull();
  });

  it("says nothing for a running bot that never halted", () => {
    expect(postHaltNotice(bot([], { status: "running", haltReason: null }))).toBeNull();
  });

  it("tolerates a payload from a backend that predates the field", () => {
    // A browser tab cached before the deploy that added `postHaltEvents` will
    // hand this module a bot without one. Rendering nothing is right; throwing
    // inside a render would take the whole page down through React's unmount,
    // which is the blank-page failure `BotDetail.tsx`'s header records.
    const older = { ...bot([]) } as Partial<Bot>;
    delete older.postHaltEvents;
    expect(postHaltNotice(older as Bot)).toBeNull();
  });
});

describe("what one event resolves to", () => {
  it("carries the event type as words, never the raw wire enum", () => {
    const notice = postHaltNotice(bot([event()]))!;
    expect(notice.items[0]!.label).toBe("A take-profit cycle completed");
    expect(notice.items[0]!.label).not.toContain("cycle_completed");
  });

  it("keeps the booked profit and the asset it is denominated in", () => {
    // REAL money. The suppressed transition below did not happen; this did, and
    // the two must never be presented with the same weight.
    const notice = postHaltNotice(bot([event()]))!;
    expect(notice.items[0]!.grossProfit).toBe("1.99999200");
    expect(notice.items[0]!.capitalAsset).toBe("USDT");
  });

  it("keeps the suppressed transition as its own field, phrased as a counterfactual", () => {
    const notice = postHaltNotice(bot([event()]))!;
    // Separate from the profit, so a renderer cannot compose one sentence that
    // reads as though the restart happened.
    expect(notice.items[0]!.suppressed).toContain("would have");
    expect(notice.items[0]!.grossProfit).not.toContain("would have");
  });

  it("keeps when it happened, the order that caused it, and the halt it landed under", () => {
    const notice = postHaltNotice(bot([event()]))!;
    expect(notice.items[0]!.at).toBe(AT);
    expect(notice.items[0]!.clientOrderId).toBe("bot-xs0ufw-7");
    // Captured at the time, not read back off the bot: a resume clears the live
    // field and this has to stay true afterwards.
    expect(notice.items[0]!.haltReasonAtTime).toContain("stop_loss");
  });

  it("carries both row ids through unchanged", () => {
    // The pointers are the whole reason the backend's `#audit`/`#alert` return
    // their generated ids. Mangling one here would make the link land nowhere.
    const notice = postHaltNotice(bot([event()]))!;
    expect(notice.items[0]!.auditId).toBe("audit-row-1");
    expect(notice.items[0]!.alertId).toBe("alert-row-1");
  });
});

describe("the heading", () => {
  it("is singular for one event", () => {
    expect(postHaltNotice(bot([event()]))!.heading).toBe(
      "Something happened after this bot halted",
    );
  });

  it("counts and pluralises for more than one", () => {
    const notice = postHaltNotice(bot([event(), event({ alertId: "alert-row-2" })]))!;
    expect(notice.heading).toBe("2 things happened after this bot halted");
    expect(notice.items).toHaveLength(2);
  });

  it("preserves the order the backend recorded them in", () => {
    // The backend appends, so index 0 is the oldest. A renderer showing them
    // out of order would misdescribe a sequence of events.
    const notice = postHaltNotice(
      bot([event({ clientOrderId: "first" }), event({ clientOrderId: "second" })]),
    )!;
    expect(notice.items.map((item) => item.clientOrderId)).toEqual(["first", "second"]);
  });
});

describe("the status cross-check", () => {
  it("is not flagged stale on the halted bot these events belong to", () => {
    expect(postHaltNotice(bot([event()]))!.staleForStatus).toBe(false);
  });

  it("IS flagged when the events outlived the halt", () => {
    // `#resumePass` clears `postHaltEvents` in the same write that clears
    // `haltReason`, so this should be unreachable -- and the dashboard does not
    // get to assume that about the other side of a wire. Showing the
    // inconsistency beats rendering a confidently wrong screen.
    const resumed = bot([event()], { status: "running", haltReason: null });
    expect(postHaltNotice(resumed)!.staleForStatus).toBe(true);
    // And it still renders: the events are not hidden just because the status
    // disagrees with them.
    expect(postHaltNotice(resumed)!.items).toHaveLength(1);
  });

  it("is flagged for a stopped bot too, not only a running one", () => {
    expect(postHaltNotice(bot([event()], { status: "stopped" }))!.staleForStatus).toBe(true);
  });
});

describe("the label table", () => {
  it("covers every kind the wire type allows", () => {
    // A `Record` over the union, so a new `kind` fails the dashboard typecheck
    // rather than rendering a raw enum. This asserts the table is not empty and
    // that no entry is a placeholder.
    const labels = Object.values(POST_HALT_KIND_LABEL);
    expect(labels.length).toBeGreaterThan(0);
    for (const label of labels) {
      expect(label.length).toBeGreaterThan(10);
      expect(label).not.toMatch(/_/);
    }
  });
});

describe("the list-view tag's tooltip", () => {
  it("says what happened and, just as importantly, what did not", () => {
    const title = postHaltTagTitle(bot([event()]))!;
    expect(title).toContain("after it halted");
    // The two facts an operator must not conflate, both present in the one
    // sentence the list has room for.
    expect(title).toContain("books moved");
    expect(title).toContain("did not restart");
  });

  it("counts, so the pill does not under-report a bot with several", () => {
    expect(postHaltTagTitle(bot([event(), event()]))!).toContain("2 things");
  });
});

describe("the alert-row anchor", () => {
  it("is built from the alert id, in one place both sides read", () => {
    // Spelled once for the reason `APPLY_MISSED_FILLS_ANCHOR` is: a rename that
    // moves only one side produces no error and no failing request, just a link
    // that scrolls nowhere.
    expect(alertRowAnchor("alert-row-1")).toBe("alert-alert-row-1");
  });

  it("is distinct per alert, so a bot with several links to the right one", () => {
    expect(alertRowAnchor("a")).not.toBe(alertRowAnchor("b"));
  });
});
