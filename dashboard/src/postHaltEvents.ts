/**
 * WHAT THE POST-HALT NOTICE SAYS, decided outside React.
 *
 * ── WHY THIS IS A MODULE AND NOT SIX LINES INSIDE A `.tsx` ──
 *
 * `docs/open-items/component-test-harness.md`: a test importing a `.tsx`
 * COLLECTS ZERO TESTS in the Workers pool rather than failing, so any decision
 * left inside a component is unreachable by the suite AND reports green.
 * `proposalFields.ts`'s header records the finding that forced this pattern -- a
 * mutant deleting a guard's call site survived, because the call site was one
 * line in a `.tsx`. Every verdict below is therefore here, where it can be tested
 * and mutated; `PostHaltNotice.tsx` renders what this returns and decides
 * nothing.
 *
 * ── WHAT IT IS FOR ──
 *
 * A halted bot can still have orders resting on the exchange. When one fills, the
 * books move -- honestly, and by design -- but the lifecycle transition it would
 * normally drive is refused, because the bot is already halted for an earlier,
 * safety-relevant reason that stays primary. The backend records that as a
 * `PostHaltEvent` (see `BotRuntimeState.postHaltEvents` in bot-instance.ts) and
 * deliberately does NOT touch `status`, `halt_reason` or `updated_at`.
 *
 * The consequence is the whole reason this exists: on every other field a
 * SCREEN CAN SEE, a bot whose books moved after halting is IDENTICAL to one that
 * has sat untouched. Same status badge, same halt banner, same "updated". This is
 * the only thing that says otherwise.
 *
 * ── ⚠ THE ONE DISTINCTION THE RENDERING MUST NOT BLUR ──
 *
 * Each event holds two facts of opposite kinds, and an operator who conflates
 * them reaches the wrong conclusion in the expensive direction:
 *
 *   * `grossProfit` -- REAL. Booked, in the ledger, in the audit log.
 *   * `suppressed`  -- A COUNTERFACTUAL. It did NOT happen. No restart occurred
 *     and none will; the bot is exactly as halted as it was.
 *
 * `postHaltNotice` keeps them as separate fields with separate names for that
 * reason, rather than pre-composing one sentence a renderer would have to split.
 *
 * ── SEVERITY, AND WHY THIS IS NOT RED ──
 *
 * The backend raises the matching alert at `warning`, and `AlertList.tsx` fixes
 * the vocabulary for the whole dashboard: info sky, warning amber, critical red.
 * Red is the halt banner's, and the halt is the primary safety fact. Amber says
 * "important, and not the reason this bot stopped", which is exactly true here.
 * Colour is never the only carrier -- `ProposalFreshness.tsx:95-96`, "a
 * distinction a colour-blind reviewer cannot make is the same as no distinction"
 * -- so every verdict below also carries words.
 */

import type { Bot, PostHaltEvent } from "./api/types";

/**
 * The anchor `AlertList` puts on each alert row, so a notice can link to the
 * exact row rather than to the top of the page.
 *
 * Spelled ONCE, here, for the reason `APPLY_MISSED_FILLS_ANCHOR` and
 * `CHECK_OPEN_ORDERS_ANCHOR` are: two sides have to agree about a string, and a
 * rename that moves only one of them produces no error and no failing request --
 * just a link that silently scrolls nowhere.
 */
export function alertRowAnchor(alertId: string): string {
  return `alert-${alertId}`;
}

/** One event, resolved into the fields a renderer prints and nothing more. */
export interface PostHaltNoticeItem {
  /** What happened, in words. Never the raw wire enum. */
  readonly label: string;
  readonly at: number;
  /** The order whose fill caused it. */
  readonly clientOrderId: string;
  /**
   * Booked money, or null for a future event kind that has none. Null is NOT
   * zero: it means this kind of event does not carry a profit, and a renderer
   * must omit the figure rather than print "0".
   */
  readonly grossProfit: string | null;
  readonly capitalAsset: string;
  /** The transition that did NOT happen. Rendered as the counterfactual it is. */
  readonly suppressed: string;
  /** The halt this landed under, as it read at the time. */
  readonly haltReasonAtTime: string | null;
  /** `audit_log.id`. There is no audit screen; this is shown, not linked. */
  readonly auditId: string;
  /** `alerts.id`. Linkable: the row is in this page's own alert list. */
  readonly alertId: string;
}

export interface PostHaltNotice {
  readonly items: readonly PostHaltNoticeItem[];
  /**
   * The headline, already pluralised. Built here rather than in JSX because
   * "1 event"/"2 events" is a decision, and decisions in a `.tsx` are untestable.
   */
  readonly heading: string;
  /**
   * TRUE when the bot is no longer halted but events are still attached.
   *
   * The backend clears `postHaltEvents` in the same write that clears
   * `haltReason`, so this should never be true -- and the dashboard does not get
   * to ASSUME that, because the assumption is about the other side of a wire.
   * Surfacing the inconsistency is strictly better than hiding it: an annotation
   * about a halt sitting on a running bot is either a real backend defect or a
   * stale poll, and both are things an operator should be told rather than shown
   * a confidently wrong screen.
   */
  readonly staleForStatus: boolean;
}

/**
 * What each `kind` is called on screen.
 *
 * ⚠ A `Record` OVER THE UNION, not a lookup with a fallback. A new `kind` added
 * to the wire type fails the dashboard typecheck HERE, which is where someone can
 * fix it -- rather than rendering a raw enum on a page nobody is watching, or
 * silently rendering nothing at all.
 */
export const POST_HALT_KIND_LABEL: Record<PostHaltEvent["kind"], string> = {
  cycle_completed: "A take-profit cycle completed",
};

/**
 * Whether an event kind carries booked money.
 *
 * Separate from the label for a reason worth stating: `grossProfit` is a
 * non-optional string on the wire, so "has a profit" cannot be read off its
 * presence. Today's one kind always has one. A future kind that does not must be
 * added here rather than left to print a meaningless "0.00".
 */
const KIND_HAS_PROFIT: Record<PostHaltEvent["kind"], boolean> = {
  cycle_completed: true,
};

/**
 * The notice for one bot, or null when there is nothing to say.
 *
 * NULL FOR THE EMPTY CASE, deliberately, rather than a notice with zero items:
 * the caller renders nothing at all, and cannot accidentally draw an empty amber
 * band on every healthy bot in the fleet.
 */
export function postHaltNotice(bot: Bot): PostHaltNotice | null {
  const events = bot.postHaltEvents ?? [];
  if (events.length === 0) return null;

  const items = events.map(
    (event): PostHaltNoticeItem => ({
      label: POST_HALT_KIND_LABEL[event.kind],
      at: event.at,
      clientOrderId: event.clientOrderId,
      grossProfit: KIND_HAS_PROFIT[event.kind] ? event.grossProfit : null,
      capitalAsset: event.capitalAsset,
      suppressed: event.suppressed,
      haltReasonAtTime: event.haltReasonAtTime,
      auditId: event.auditId,
      alertId: event.alertId,
    }),
  );

  return {
    items,
    heading:
      items.length === 1
        ? "Something happened after this bot halted"
        : `${items.length} things happened after this bot halted`,
    staleForStatus: bot.status !== "halted",
  };
}

/**
 * The list-view tag's tooltip.
 *
 * The list has room for a word, not a paragraph, and a bare "post-halt" pill
 * would be a puzzle rather than information -- so the whole fact travels in the
 * `title`, exactly as `ArchivedTag` and `OrphanTag` already do.
 */
export function postHaltTagTitle(bot: Bot): string | null {
  const notice = postHaltNotice(bot);
  if (notice === null) return null;
  const count = notice.items.length;
  return (
    `${count === 1 ? "One thing" : `${count} things`} happened to this bot after it halted, ` +
    `and its halt reason deliberately does not mention them. The books moved; the bot did not ` +
    `restart. Open the bot to see what and when.`
  );
}
