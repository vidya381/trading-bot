/**
 * The section 21.3 fixed watchlist: the deliberate half of candidate selection.
 *
 * Section 21 as a whole is still PLANNED, NOT YET BUILT -- no pipeline, no
 * prompt, no proposal record, no model call. This module is one piece of its
 * groundwork and nothing more: the list of pairs an operator chose, moved out of
 * code and configuration into D1 (migration 0008) so that changing it is an edit
 * rather than a deploy, with the write path carrying the checks a config
 * constant never could.
 *
 * ── The rule this module exists to hold, stated first ──
 *
 * 21.3 names TWO candidate sources and keeps them structurally separate:
 *
 *   1. This watchlist -- 5-10 coins, "chosen deliberately by the operators".
 *   2. A live trending pull -- "the only way the system can ever surface
 *      something the operators did not already think to look for".
 *
 * NOTHING AUTOMATED MAY WRITE HERE. There is no `syncFromTrending`, no upsert,
 * no bulk import, and both entry points below refuse the automated actors
 * (`system`, `ci`, `cron`, `reconciliation`) that `placeholder-balance.ts`
 * already names -- imported rather than re-listed, so the two cannot drift.
 *
 * The temptation is real and worth naming, because it presents itself as
 * convenience: both sources produce pairs, both feed the same pipeline (21.2:
 * "one feature, not two"), and having one table would mean one read path. It is
 * still wrong, for two reasons that outlive the convenience.
 *
 * First, 21.5's source-transparency requirement is that every proposal displays
 * "the real source the candidate came from -- which watchlist entry, or which
 * trending pull, and when". Merged into one table, that distinction is gone at
 * the moment it is written, and no amount of downstream care recovers it.
 *
 * Second, 21.3's hype hazard: trending measures ATTENTION, not quality, and its
 * coins are "disproportionately the ones with the least history and the most
 * noise". A watchlist entry carries a human's stated reason (`note`, NOT NULL).
 * A trending hit carries a popularity number. Storing them in one table makes
 * them indistinguishable to every later reader, which is precisely how a
 * proposal comes to read as confident because its input was loud.
 *
 * ── What is deliberately NOT here ──
 *
 *   * No dashboard control. Editing is `wrangler d1 execute` for now; the UI is
 *     a later step, deferred on purpose and recorded as such.
 *   * No candidate selection, no trending pull, no `getCandles` extension, no
 *     Workers AI call. `readWatchlist` is a plain function with no caller yet --
 *     the pipeline is what will consume it.
 *   * No API endpoint, so nothing here is reachable over HTTP.
 *
 * ── The three checks on a write, and the one on a removal ──
 *
 * TRADABILITY, fail closed. A pair that the account's venue will not trade
 * cannot become a bot, so it "has no business consuming a pipeline run or a
 * human's attention" (21.3, said there of the trending source and true here for
 * the same reason). The tradable set comes from `listTradablePairs` via the
 * cached `listAccountSymbols` path built at step 11 -- 21.3 is explicit that it
 * "is the authority, not a hardcoded list". An UNREADABLE tradable set refuses
 * the write too: "could not check" is not "checked and fine", which is section
 * 5.6 applied one layer out.
 *
 * THE CAP, 10 active entries. 21.3's bound, enforced rather than documented.
 *
 * AUDIT, through the existing path. `db.auditLog.insert` / `insertStatement`,
 * the same call every other consequential write in this system makes; there is
 * no second audit mechanism here. The row and its audit entry go in ONE
 * `Database.batch`, so a watchlist entry with no record of who added it is not a
 * state this table can reach.
 *
 * REMOVAL does not re-check tradability, and that is a deviation worth being
 * explicit about. Refusing to remove a pair the venue has DELISTED would trap
 * exactly the entry most in need of removing, and would make an exchange outage
 * enough to freeze the list -- the failure runs the wrong way. What removal does
 * check is that the pair is genuinely on the live list, which is the actual
 * precondition, and it writes its own audit entry.
 */

import { NON_HUMAN_ACTORS } from "../capital";
import type { Database } from "../db";
import type { AuditLogRow, WatchlistRow } from "../db/schema";
import type { Pair, Timestamp } from "../shared/exchange-client";
import { checkTradable, type TradablePairSource, type VenueAccount } from "./tradability";

export type { TradablePairSource } from "./tradability";

/**
 * 21.3's bound: "A small set of 5-10 coins ... Expandable later by an explicit
 * decision to expand it."
 *
 * Ten, the top of that range, counted over ACTIVE rows across every account --
 * not per account. What the bound protects is the cost and attention of a
 * pipeline RUN ("each candidate costs candle fetches, news fetches, and two LLM
 * calls"), and that cost is per candidate wherever the candidate is registered.
 * A per-account cap would let two accounts fund twenty candidates while each
 * looked compliant.
 *
 * Widening it is meant to be this line plus a test, which is why the number is
 * deliberately not ALSO a database trigger -- see the migration header.
 */
export const WATCHLIST_MAX_ENTRIES = 10;

/**
 * The account a watchlist entry belongs to, and therefore the venue to check.
 *
 * An alias for `VenueAccount`, which is the same `{ label, exchange }` the
 * candle fetch and the tradability check take. Kept under this name because it
 * is what the API layer and `index.ts` already import.
 */
export type WatchlistAccount = VenueAccount;

export interface WatchlistPorts {
  readonly db: Database;
  readonly now: () => Timestamp;
  readonly newId: () => string;
  readonly listTradablePairs: TradablePairSource;
}

export type WatchlistErrorCode =
  /** The write would take the live list past `WATCHLIST_MAX_ENTRIES`. */
  | "cap_exceeded"
  /** The account's venue does not list this pair. */
  | "pair_not_tradable"
  /** The tradable set could not be read, so tradability is unknown. */
  | "tradable_set_unreadable"
  /** Listed, but its NAME says perpetual. An inference; see `tradability.ts`. */
  | "pair_not_spot_by_name"
  /** The pair is already on the live list for this account. */
  | "already_watched"
  /** No live entry for this account and pair, so there is nothing to remove. */
  | "not_watched"
  /** A blank pair, or a blank note on an add. */
  | "missing_field"
  /** An empty or automated actor. See the header. */
  | "requires_human_actor";

export class WatchlistError extends Error {
  readonly code: WatchlistErrorCode;
  constructor(code: WatchlistErrorCode, message: string) {
    super(message);
    this.name = "WatchlistError";
    this.code = code;
  }
}

/** One live watchlist entry, as the pipeline will read it. */
export interface WatchlistEntry {
  readonly id: string;
  readonly accountLabel: string;
  readonly exchangePair: Pair;
  readonly note: string;
  readonly addedBy: string;
  readonly addedAt: Timestamp;
}

function entryOf(row: WatchlistRow): WatchlistEntry {
  return {
    id: row.id,
    accountLabel: row.account_label,
    exchangePair: row.pair,
    note: row.note,
    addedBy: row.added_by,
    addedAt: row.added_at,
  };
}

/**
 * THE READ PATH (requirement 4): the current watchlist, oldest entry first.
 *
 * A plain function over a `Database`, taking no ports and no environment,
 * because the pipeline stage that will call it needs the list and nothing else.
 * It reads only LIVE entries -- `removed_at IS NULL`, matching the migration's
 * two partial indexes -- so a removed pair is invisible here while staying in
 * the table as history.
 *
 * Ordered by `added_at` then `id`. The tiebreak is not decoration: two entries
 * added in the same millisecond (one operator, one paste, two commands) would
 * otherwise come back in whatever order SQLite chose, and a candidate list that
 * reorders itself between runs makes two pipeline runs incomparable for no
 * reason.
 *
 * `accountLabel` narrows to one account's entries; omitted, it returns every
 * account's, which is what a general-entry-point run over the whole list wants.
 */
export async function readWatchlist(
  db: Database,
  options: { readonly accountLabel?: string } = {},
): Promise<WatchlistEntry[]> {
  const rows = await db.watchlist.findMany({
    where:
      options.accountLabel === undefined
        ? { removed_at: null }
        : { removed_at: null, account_label: options.accountLabel },
    orderBy: [
      { column: "added_at", direction: "asc" },
      { column: "id", direction: "asc" },
    ],
  });
  return rows.map(entryOf);
}

/** How many pairs the live list currently holds, across every account. */
export async function watchlistSize(db: Database): Promise<number> {
  return await db.watchlist.count({ removed_at: null });
}

function requireHuman(actor: string): string {
  const trimmed = actor.trim();
  if (trimmed === "" || NON_HUMAN_ACTORS.includes(trimmed)) {
    throw new WatchlistError(
      "requires_human_actor",
      `editing the watchlist requires a human actor, got ${JSON.stringify(actor)}. ` +
        `Section 21.3's watchlist is the source that exists BECAUSE someone chose ` +
        `each entry; an automated writer would make it the second copy of the ` +
        `trending pull, which 21.3 keeps structurally separate.`,
    );
  }
  return trimmed;
}

function requireText(value: string, field: string): string {
  const trimmed = value.trim();
  if (trimmed === "") {
    throw new WatchlistError("missing_field", `watchlist ${field} must not be blank`);
  }
  return trimmed;
}

/**
 * Assert the pair is one the account's venue will actually trade.
 *
 * The decision itself lives in `tradability.ts` and is shared with section
 * 21.4's candle fetch -- see that module's header for why it fails closed in
 * both directions and why the comparison is exact. What stays here is the
 * refusal's shape: a `WatchlistError` carrying the shared code and message, so
 * the API layer's status mapping is untouched.
 *
 * It OPTS IN to the naming heuristic, which is the only spot-versus-perpetual
 * check this path can afford: the real one costs an exchange request per symbol
 * and this path is on the write path of a human typing a symbol they saw on the
 * venue's own listing. Before it existed, `HYPEUSDCPERP` was accepted here with
 * zero resistance -- it IS on Gemini's list. Read `tradability.ts` on what that
 * heuristic does not guarantee before relying on it for anything more.
 */
async function assertTradable(
  ports: WatchlistPorts,
  account: WatchlistAccount,
  pair: Pair,
): Promise<void> {
  const refusal = await checkTradable(
    ports.listTradablePairs,
    account,
    pair,
    `Refusing rather than storing it unchecked -- an entry nothing validated is ` +
      `exactly what this list must not contain.`,
    "reject-derivative-names",
  );
  if (refusal !== null) throw new WatchlistError(refusal.code, refusal.message);
}

export interface AddToWatchlistRequest {
  readonly account: WatchlistAccount;
  /** The venue's own symbol, exactly as `listTradablePairs` reports it. */
  readonly pair: Pair;
  /** Why this coin is worth a pipeline run. Required; see the migration. */
  readonly note: string;
  /** An authenticated email. Automated actors are refused. */
  readonly actor: string;
}

/**
 * Add one pair to the watchlist.
 *
 * The order of the checks is deliberate: actor and shape first (free), then the
 * duplicate check and the cap (one D1 read each), and the exchange call LAST, so
 * a re-add of a pair already on the list or an eleventh entry costs no venue
 * request and no rate-limit budget.
 *
 * The cap is checked against a COUNT immediately before the write, not against a
 * list read earlier, and the honest limit of that is worth recording: two adds
 * running concurrently could both see 9 and both insert, landing 11. Nothing
 * here serialises them, because the intended writer is one human at a terminal
 * and the alternative -- a database trigger -- would put 21.3's number in two
 * places that can disagree (migration header). The duplicate case, which is the
 * one a rushed operator actually hits, IS closed structurally by the migration's
 * unique partial index.
 */
export async function addToWatchlist(
  ports: WatchlistPorts,
  request: AddToWatchlistRequest,
): Promise<WatchlistEntry> {
  const { db } = ports;
  const actor = requireHuman(request.actor);
  const pair = requireText(request.pair, "pair");
  const note = requireText(request.note, "note");

  const existing = await db.watchlist.findOne({
    account_label: request.account.label,
    pair,
    removed_at: null,
  });
  if (existing !== null) {
    throw new WatchlistError(
      "already_watched",
      `${JSON.stringify(pair)} is already on the watchlist for account ` +
        `${JSON.stringify(request.account.label)} (entry ${existing.id}, added by ` +
        `${existing.added_by}). A duplicate is not a second opinion; it is one coin ` +
        `costing two pipeline runs.`,
    );
  }

  const size = await watchlistSize(db);
  if (size >= WATCHLIST_MAX_ENTRIES) {
    throw new WatchlistError(
      "cap_exceeded",
      `the watchlist already holds ${size} entries and the cap is ` +
        `${WATCHLIST_MAX_ENTRIES} (spec 21.3: "a small set of 5-10 coins ... ` +
        `deliberately small: it bounds cost"). Remove a pair first, or widen ` +
        `WATCHLIST_MAX_ENTRIES by an explicit decision -- 21.3 allows exactly that ` +
        `and nothing else.`,
    );
  }

  await assertTradable(ports, request.account, pair);

  const now = ports.now();
  const row: WatchlistRow = {
    id: ports.newId(),
    account_label: request.account.label,
    pair,
    note,
    added_by: actor,
    added_at: now,
    removed_by: null,
    removed_at: null,
  };

  const audit: AuditLogRow = {
    id: ports.newId(),
    actor,
    action: "watchlist.added",
    // The watchlist targets no bot. It is a list of candidates for a proposal
    // that a human would still have to turn into a bot themselves (21.1).
    target_bot_instance_id: null,
    details_json: {
      watchlist_id: row.id,
      account_label: row.account_label,
      exchange: request.account.exchange,
      pair,
      note,
      // The size the cap was judged against, so the entry that filled the list
      // can be identified later without replaying every row's timestamps.
      size_before: size,
    },
    created_at: now,
  };

  // Named rather than inlined: no-raw-d1.test.ts forbids `.batch([` outside
  // /src/db and cannot tell this sanctioned call from a raw one.
  const statements = [db.watchlist.insertStatement(row), db.auditLog.insertStatement(audit)];
  await db.batch(statements);

  return entryOf(row);
}

export interface RemoveFromWatchlistRequest {
  readonly account: WatchlistAccount;
  readonly pair: Pair;
  /** Why it is coming off. Optional -- see the note in the body. */
  readonly note?: string;
  readonly actor: string;
}

/**
 * Take one pair off the watchlist.
 *
 * A soft delete: `removed_at`/`removed_by` are set and the row stays. The access
 * layer offers no hard delete (see /src/db/table.ts) and this does not reach
 * past it; the history is also worth having, since "someone considered this coin
 * and then changed their mind" is the same kind of negative signal 21.5 wants
 * kept about proposals nobody acted on.
 *
 * Written as a conditional UPDATE whose WHERE carries `removed_at IS NULL`, so
 * `changes` answers "was it on the list" against the database rather than
 * against a row read a moment earlier -- the idiom `setArchived` and the capital
 * ledger already use, and it means a second removal writes no second audit
 * entry.
 *
 * The removal note is OPTIONAL where the add's is required, which is not an
 * oversight: the add's note is the justification for spending pipeline runs on a
 * coin, and nothing else records it, while a removal's reason is often just "we
 * are done with it" and the entry's own `added_at`/`removed_at` span already say
 * how long it was considered. An absent note is recorded as absent.
 */
export async function removeFromWatchlist(
  ports: WatchlistPorts,
  request: RemoveFromWatchlistRequest,
): Promise<WatchlistEntry> {
  const { db } = ports;
  const actor = requireHuman(request.actor);
  const pair = requireText(request.pair, "pair");
  const note = request.note === undefined ? null : requireText(request.note, "note");

  const row = await db.watchlist.findOne({
    account_label: request.account.label,
    pair,
    removed_at: null,
  });
  if (row === null) {
    throw new WatchlistError(
      "not_watched",
      `${JSON.stringify(pair)} is not on the watchlist for account ` +
        `${JSON.stringify(request.account.label)}, so there is nothing to remove`,
    );
  }

  const now = ports.now();
  const changed = await db.watchlist.update(
    { id: row.id, removed_at: null },
    { removed_at: now, removed_by: actor },
  );
  if (changed !== 1) {
    // Lost the race to a concurrent removal. Reported rather than swallowed: the
    // entry IS off the list, but this caller did not take it off and no audit
    // entry naming this actor should claim otherwise.
    throw new WatchlistError(
      "not_watched",
      `${JSON.stringify(pair)} was removed from account ` +
        `${JSON.stringify(request.account.label)}'s watchlist by someone else first`,
    );
  }

  // Sequential, where the add batches its two writes -- and the asymmetry is the
  // point. The add has nothing to inspect: its INSERT either lands or throws, so
  // one batch keeps the row and its audit entry inseparable. Here the UPDATE's
  // `changes` IS the decision (`setArchived`'s idiom), and a batch would commit
  // an audit entry claiming a removal in the case where the update matched
  // nothing. Of the two failure shapes, "no audit row for a removal that
  // happened" is recoverable from the row itself; "an audit row for a removal
  // that did not" is a false record of a human act, which this log exists to be
  // trusted about.
  await db.auditLog.insert({
    id: ports.newId(),
    actor,
    action: "watchlist.removed",
    target_bot_instance_id: null,
    details_json: {
      watchlist_id: row.id,
      account_label: row.account_label,
      exchange: request.account.exchange,
      pair,
      note,
      // Carried so the removal entry alone answers "how long was this watched,
      // and whose choice was it originally".
      added_by: row.added_by,
      added_at: row.added_at,
    },
    created_at: now,
  } satisfies AuditLogRow);

  return entryOf(row);
}
