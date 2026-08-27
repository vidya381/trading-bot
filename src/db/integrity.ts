/**
 * Cross-table invariants that no single write can enforce.
 *
 * Every constraint in `migrations/` is scoped to ONE row of ONE table, because
 * that is all a `CHECK` can see. The invariants here span two tables and are
 * therefore unenforceable at write time and undetectable at read time unless
 * something goes looking, which is what this module is for.
 *
 * READ-ONLY, AND DELIBERATELY SO. Nothing here corrects anything. Section 9's
 * rule -- halt and alert, never auto-correct -- applies with more force to a
 * detector than to the reconciliation pass itself: a query that found a broken
 * invariant and then "fixed" it would be destroying the evidence of how the
 * invariant broke, which is the only thing that leads to the actual bug.
 */

import type { Database } from "./database";
import type { BotStatus, OrderRow } from "./schema";
import { ALLOWED_TRANSITIONS, isTerminal, type OrderState } from "../shared/order-state";

/**
 * The statuses from which a bot must place no further orders, and must have
 * none of its own still resting.
 *
 * `created` is NOT here: a created bot has never traded, so it trivially has no
 * orders, and including it would add rows that can only ever be empty.
 * `running` obviously is not -- an open order on a running bot is the ordinary
 * case, not a defect.
 */
export const INACTIVE_STATUSES = ["halted", "stopped"] as const satisfies readonly BotStatus[];

/**
 * The order states that mean "still live on the exchange, as far as this system
 * knows".
 *
 * DERIVED from the state machine rather than written out, so it cannot drift
 * from it. `ALLOWED_TRANSITIONS` has one key per `OrderState` and `isTerminal`
 * is the same predicate the Durable Object's own sweep uses; a seventh state
 * added later is classified here automatically, in the safe direction (a new
 * state is "open" until someone marks it terminal).
 */
export const OPEN_ORDER_STATES: readonly OrderState[] = (
  Object.keys(ALLOWED_TRANSITIONS) as OrderState[]
).filter((state) => !isTerminal(state));

/** One bot that is inactive while orders it placed are still open. */
export interface InactiveBotWithOpenOrders {
  readonly botInstanceId: string;
  readonly status: BotStatus;
  /** When the bot halted, for judging how long the orders have been stranded. */
  readonly haltedAt: number | null;
  readonly openOrders: readonly OrderRow[];
}

/**
 * Bots that are `halted` or `stopped` and still have open orders in `orders`.
 *
 * ── WHY THIS COMBINATION IS A DEFECT AND NOT A RACE ──
 *
 * `#halt` cancels every open order and `#closePass` refuses to release capital
 * while any order is unresolved, so on both paths a bot arrives at these
 * statuses with nothing of its own resting. A row here therefore means one of
 * the two mechanisms did not complete, and both leave live exposure behind:
 *
 *   - halted: the bot will not trade, but an order it already placed can still
 *     FILL, moving real base on an account nobody is watching for it.
 *   - stopped: the same, on a bot that nothing observes at all -- `#pollArmed`
 *     excludes `stopped`, and reconciliation's `RECONCILED_STATUSES` is
 *     `created`/`running`/`halted`, so a stopped bot is read by no scheduled
 *     job in this system. That is the worse half, and it is the half no
 *     existing check covers.
 *
 * It is not a timing artefact the way a status/snapshot mismatch is. Both
 * tables are read here in one direction -- open orders first, then the bots
 * that own them -- and a halt landing between the two reads can only ever make
 * this report MORE rows than are really broken, never fewer, because the second
 * read is the one that observes the newer status. A row that appears for that
 * reason disappears on the next run; one that persists is real.
 *
 * ── WHY IT READS ORDERS FIRST ──
 *
 * The open-order set is small (a DCA bot has at most one, a grid ladder a few
 * dozen) and the terminal orders that dominate the table are excluded by the
 * first query, so the second is an `IN` over a handful of ids rather than a
 * scan of every bot. The obvious other order -- every inactive bot, then its
 * orders -- reads the largest set in the system first and asks a question about
 * each row of it.
 */
export async function findInactiveBotsWithOpenOrders(
  db: Database,
): Promise<InactiveBotWithOpenOrders[]> {
  const openOrders = await db.orders.findMany({
    where: { status: { in: OPEN_ORDER_STATES } },
    orderBy: [{ column: "created_at", direction: "asc" }],
  });
  if (openOrders.length === 0) return [];

  const botIds = [...new Set(openOrders.map((order) => order.bot_instance_id))];
  const inactive = await db.botInstances.findMany({
    where: { id: { in: botIds }, status: { in: [...INACTIVE_STATUSES] } },
  });
  if (inactive.length === 0) return [];

  // Sorted worst-first: `stopped` before `halted`, because a stopped bot is the
  // one no scheduled job will ever look at again. Within a status, the oldest
  // halt first -- the longer an order has been stranded, the less likely it is
  // that anything is coming to resolve it.
  return inactive
    .map((bot) => ({
      botInstanceId: bot.id,
      status: bot.status,
      haltedAt: bot.halted_at,
      openOrders: openOrders.filter((order) => order.bot_instance_id === bot.id),
    }))
    .sort((left, right) => {
      if (left.status !== right.status) return left.status === "stopped" ? -1 : 1;
      return (left.haltedAt ?? 0) - (right.haltedAt ?? 0);
    });
}
