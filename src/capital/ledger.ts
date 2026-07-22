/**
 * Capital ledger and bot-creation validation (spec section 8.5), build step 5.
 *
 * Section 8.5 is three sentences: check `total_balance - total_allocated >=
 * requested_capital` before creating a bot, block creation if it fails, and
 * update `total_allocated` when bots are created, closed, or resized. This file
 * is that, plus the three things those sentences leave open.
 *
 * WHAT AN ALLOCATION IS
 * ---------------------
 * A reservation of headroom, not a valuation. Closing a bot releases exactly
 * what was reserved for it, whatever the position ended up being worth.
 * Profit and loss never touch `total_allocated`; they reach `total_balance`,
 * which is reconciliation's to write (section 9, step 7) and which nothing here
 * maintains -- see `placeholder-balance.ts` for how it gets a value meanwhile.
 *
 * This is why migration 0001 deliberately has no `CHECK (total_allocated <=
 * total_balance)`: a losing bot legitimately leaves an account allocated beyond
 * its balance, and that state has to be representable so reconciliation can
 * alert on it. The check that matters guards *new* allocations and lives here.
 *
 * CONCURRENCY
 * -----------
 * Read, decide, then `UPDATE ... WHERE total_allocated = <the value that was
 * read>`. If the update changes no rows, something else moved the number in
 * between; re-read and decide again from the new value, up to
 * MAX_ALLOCATION_ATTEMPTS. Deciding again rather than retrying the write is the
 * point -- the availability check is re-run against what is now true, so two
 * concurrent creations that each fit but do not both fit cannot both succeed.
 *
 * No Durable Object. One would serialise this properly, but none exists in this
 * codebase until step 6, and introducing the project's first DO as a dependency
 * of the validation layer that step 6 itself calls is backwards.
 *
 * ORDERING OF THE MULTI-ROW WRITES
 * --------------------------------
 * D1 has no interactive transaction, only `batch`, which cannot span a
 * conditional update whose `changes` count has to be inspected. So these
 * operations are two or three statements that can be interrupted between, and
 * the ordering rule is:
 *
 *   grow the reservation BEFORE the bot row, shrink it AFTER.
 *
 * Every partial failure then leaves capital over-reserved rather than
 * under-reserved. The bad outcome is losing access to capital you own, which a
 * human can see in the audit log and correct; the outcome that rule prevents is
 * the same capital being allocated to two bots, which is money actually lost.
 */

import type { Database } from "../db/database";
import type { AuditLogRow, BotInstanceRow, CapitalLedgerRow, StrategyType } from "../db/schema";
import { BOT_INSTANCE_ID_PATTERN } from "../shared/idempotency";
import { toDecimalString, ZERO, type Money } from "../shared/money";

/**
 * How many times a conflicting conditional update is retried before giving up.
 *
 * Five, and no backoff between attempts. Each retry is a fresh D1 read, which
 * is a real round trip and therefore already spaces the attempts out; adding a
 * sleep would mostly lengthen the window in which a third writer can interleave.
 * Contention here is bounded by how fast a human creates bots, so five losses in
 * a row means something is wrong that waiting will not fix.
 */
export const MAX_ALLOCATION_ATTEMPTS = 5;

export type CapitalErrorCode =
  /** The id does not match BOT_INSTANCE_ID_PATTERN. */
  | "invalid_bot_instance_id"
  /** A requested or resized capital amount that is zero or negative. */
  | "invalid_capital_amount"
  /** No capital_ledger row for this (account_label, asset). */
  | "no_ledger_row"
  /** total_balance - total_allocated < requested. Section 8.5's block. */
  | "insufficient_capital"
  /** MAX_ALLOCATION_ATTEMPTS conditional updates all lost their race. */
  | "allocation_conflict"
  /** A bot with this id already exists. */
  | "duplicate_bot_instance"
  /** No bot_instances row with this id. */
  | "unknown_bot_instance"
  /** Close or resize of a bot whose capital was already released. */
  | "bot_already_stopped"
  /** Releasing would drive total_allocated below zero: the ledger disagrees
   *  with the bot rows, and this refuses to paper over it. */
  | "release_exceeds_allocated"
  /** A reservation was taken, the write that justified it failed, and undoing
   *  the reservation ALSO failed. Capital is reserved for nothing. Names the
   *  amount and account because a human has to fix it. */
  | "reservation_leaked"
  /** A placeholder balance was seeded by an automated actor. There is no
   *  balance feed to be automated yet, so this means someone built one
   *  without replacing the placeholder. */
  | "placeholder_requires_human_actor"
  /** A placeholder balance was seeded without saying where the number came
   *  from. */
  | "placeholder_requires_note";

export class CapitalError extends Error {
  readonly code: CapitalErrorCode;

  constructor(code: CapitalErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "CapitalError";
    this.code = code;
  }
}

/**
 * The `audit_log.action` values this module writes.
 *
 * `capital_ledger` is a mutable current-state row, not an append-only log, so
 * these entries are the only record that an allocation ever changed. Step 4's
 * open question 6 asked for `details_json` to stop being `unknown` once a step
 * defined a shape; this is that shape for the capital half.
 */
export type CapitalAction = "capital.allocated" | "capital.released" | "capital.resized";

/**
 * The `details_json` payload for every allocation change.
 *
 * Money is written with `toDecimalString`, which is both readable in a
 * dashboard and exactly parseable back by `fromDecimalString` -- no precision
 * is traded for legibility. `snake_case` to match the columns beside it.
 */
export interface AllocationAuditDetails {
  readonly action: CapitalAction;
  readonly account_label: string;
  readonly asset: string;
  /** Signed: negative on a release or a downward resize. */
  readonly allocation_delta: string;
  readonly previous_allocated: string;
  readonly new_allocated: string;
  /** As observed on the read that won. Not written by this module. */
  readonly total_balance: string;
  readonly available_after: string;
  /** Conditional-update attempts this change needed. 1 means uncontended. */
  readonly attempts: number;
}

/** Everything a caller must supply to create a bot instance (section 6.1). */
export interface BotInstanceCreation {
  /** Must match BOT_INSTANCE_ID_PATTERN -- checked before any database call. */
  readonly id: string;
  readonly accountLabel: string;
  /** Which capital_ledger row funds this bot. */
  readonly asset: string;
  readonly exchange: string;
  readonly pair: string;
  readonly strategyType: StrategyType;
  /** Opaque here: the shape is per-strategy and step 6's to define. */
  readonly strategyParams: unknown;
  readonly stopLossPct: Money;
  /** Mandatory for DCA, optional for grid -- the schema enforces which. */
  readonly takeProfitPct: Money | null;
  readonly requestedCapital: Money;
}

export interface CapitalOptions {
  /** `audit_log.actor`: an authenticated email, or 'system' for automation. */
  readonly actor: string;
  /** Unix epoch milliseconds, as everywhere else in this codebase. */
  readonly now: number;
  readonly maxAttempts?: number;
}

export interface AllocationResult {
  readonly botInstanceId: string;
  readonly accountLabel: string;
  readonly asset: string;
  readonly previousAllocated: Money;
  readonly newAllocated: Money;
  /** total_balance - newAllocated. Negative if the account is over-allocated. */
  readonly availableAfter: Money;
  readonly attempts: number;
}

/**
 * Reject a bot instance id before it reaches the database.
 *
 * The pattern is `BOT_INSTANCE_ID_PATTERN` from the idempotency module, which
 * owns it: the id is embedded verbatim in every `clientOrderId`, so it is that
 * module's length budget being spent. The migration's GLOB check is the third
 * layer. This one exists so the caller gets a typed error naming the rule
 * rather than a SQLITE_CONSTRAINT string, and so a bad id costs no round trip.
 */
export function assertBotInstanceId(id: string): void {
  if (!BOT_INSTANCE_ID_PATTERN.test(id)) {
    throw new CapitalError(
      "invalid_bot_instance_id",
      `bot instance id ${JSON.stringify(id)} must be 1-20 characters of ` +
        `[a-z0-9_-], starting with a letter or digit. It is embedded in every ` +
        `clientOrderId, so a UUID does not fit and would not be parseable back ` +
        `to this bot during reconciliation.`,
    );
  }
}

/** How a caller decides the new `total_allocated` from what was just read. */
type NextAllocation = (row: CapitalLedgerRow) => Money;

interface Adjustment {
  /** The ledger row as observed on the attempt that won. */
  readonly row: CapitalLedgerRow;
  readonly previousAllocated: Money;
  readonly newAllocated: Money;
  readonly attempts: number;
}

/**
 * The conditional-update loop. Every change to `total_allocated` goes through
 * here.
 *
 * `computeNext` runs on every attempt, against freshly read state, and throws
 * to refuse. A refusal is final: only a lost race is retried.
 */
async function adjustAllocated(
  db: Database,
  accountLabel: string,
  asset: string,
  computeNext: NextAllocation,
  now: number,
  maxAttempts: number,
): Promise<Adjustment> {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const row = await db.capitalLedger.findOne({ account_label: accountLabel, asset });
    if (row === null) {
      throw new CapitalError(
        "no_ledger_row",
        `no capital_ledger row for account ${JSON.stringify(accountLabel)} ` +
          `asset ${JSON.stringify(asset)}. Nothing creates one automatically: ` +
          `total_balance has no source yet, so it must be seeded deliberately ` +
          `with seedPlaceholderTotalBalance.`,
      );
    }

    const next = computeNext(row);

    if (next === row.total_allocated) {
      // Nothing to write. Still a success -- a resize to the current size is a
      // no-op, not an error, so a redelivered queue message is harmless.
      return { row, previousAllocated: next, newAllocated: next, attempts: attempt };
    }

    // The compare-and-swap. `total_allocated` in the filter is the value read
    // above, encoded as a storage string by the same codec that writes it, so
    // it compares numerically against the INTEGER column.
    const changes = await db.capitalLedger.update(
      { account_label: accountLabel, asset, total_allocated: row.total_allocated },
      { total_allocated: next, updated_at: now },
    );

    if (changes === 1) {
      return {
        row,
        previousAllocated: row.total_allocated,
        newAllocated: next,
        attempts: attempt,
      };
    }

    // changes === 0: total_allocated moved between the read and the write.
    // Loop, re-read, and re-run computeNext against the new value.
  }

  throw new CapitalError(
    "allocation_conflict",
    `could not update total_allocated for account ${JSON.stringify(accountLabel)} ` +
      `asset ${JSON.stringify(asset)} after ${maxAttempts} attempts; another ` +
      `writer won every time. Nothing was changed. Safe to retry.`,
  );
}

function auditRow(
  action: CapitalAction,
  botInstanceId: string,
  accountLabel: string,
  asset: string,
  adjustment: Adjustment,
  options: CapitalOptions,
): AuditLogRow {
  const details: AllocationAuditDetails = {
    action,
    account_label: accountLabel,
    asset,
    allocation_delta: toDecimalString(adjustment.newAllocated - adjustment.previousAllocated),
    previous_allocated: toDecimalString(adjustment.previousAllocated),
    new_allocated: toDecimalString(adjustment.newAllocated),
    total_balance: toDecimalString(adjustment.row.total_balance),
    available_after: toDecimalString(adjustment.row.total_balance - adjustment.newAllocated),
    attempts: adjustment.attempts,
  };
  return {
    id: crypto.randomUUID(),
    actor: options.actor,
    action,
    target_bot_instance_id: botInstanceId,
    details_json: details,
    created_at: options.now,
  };
}

function resultOf(
  botInstanceId: string,
  accountLabel: string,
  asset: string,
  adjustment: Adjustment,
): AllocationResult {
  return {
    botInstanceId,
    accountLabel,
    asset,
    previousAllocated: adjustment.previousAllocated,
    newAllocated: adjustment.newAllocated,
    availableAfter: adjustment.row.total_balance - adjustment.newAllocated,
    attempts: adjustment.attempts,
  };
}

async function requireBot(db: Database, id: string): Promise<BotInstanceRow> {
  const bot = await db.botInstances.findOne({ id });
  if (bot === null) {
    throw new CapitalError("unknown_bot_instance", `no bot instance ${JSON.stringify(id)}`);
  }
  return bot;
}

/**
 * Give back a reservation after the write that justified it failed.
 *
 * Best effort by definition: if this also fails the capital stays reserved for
 * a bot that does not exist, and that is worth a distinct error code, because
 * it is the one failure in this module that no retry fixes and a human has to
 * see.
 */
async function undoReservation(
  db: Database,
  accountLabel: string,
  asset: string,
  amount: Money,
  options: CapitalOptions,
  maxAttempts: number,
  cause: unknown,
): Promise<never> {
  try {
    await adjustAllocated(
      db,
      accountLabel,
      asset,
      (row) => (row.total_allocated < amount ? row.total_allocated : row.total_allocated - amount),
      options.now,
      maxAttempts,
    );
  } catch (rollbackFailure) {
    throw new CapitalError(
      "reservation_leaked",
      `reserved ${toDecimalString(amount)} ${asset} on account ` +
        `${JSON.stringify(accountLabel)}, then failed to create the bot AND ` +
        `failed to release the reservation. That capital is now allocated to ` +
        `nothing and will not be freed by a retry. Original failure: ` +
        `${String(cause)}. Rollback failure: ${String(rollbackFailure)}`,
      { cause },
    );
  }
  throw cause;
}

/**
 * Section 8.5's creation check, and the creation itself.
 *
 * Reserves the capital, then writes the `bot_instances` row and its audit entry
 * as one batch. Both halves are here rather than split across two callers
 * because `audit_log.target_bot_instance_id` is a foreign key to
 * `bot_instances` -- an audit entry for a creation is not writable until the
 * bot row exists, so the alternative was an allocation history that cannot be
 * joined to the bots it describes.
 *
 * Step 6's Durable Object calls this to be born; it does not write its own
 * `bot_instances` row.
 */
export async function createBotInstanceWithCapital(
  db: Database,
  request: BotInstanceCreation,
  options: CapitalOptions,
): Promise<AllocationResult> {
  const maxAttempts = options.maxAttempts ?? MAX_ALLOCATION_ATTEMPTS;

  assertBotInstanceId(request.id);
  if (request.requestedCapital <= ZERO) {
    throw new CapitalError(
      "invalid_capital_amount",
      `requested capital must be positive, got ${toDecimalString(request.requestedCapital)}`,
    );
  }

  // A courtesy check: the PRIMARY KEY enforces this regardless, and two
  // simultaneous creations of the same id will still race past it. Done first
  // so the common case fails before any capital is reserved and released again.
  if ((await db.botInstances.findOne({ id: request.id })) !== null) {
    throw new CapitalError(
      "duplicate_bot_instance",
      `bot instance ${JSON.stringify(request.id)} already exists`,
    );
  }

  const adjustment = await adjustAllocated(
    db,
    request.accountLabel,
    request.asset,
    (row) => {
      const available = row.total_balance - row.total_allocated;
      if (available < request.requestedCapital) {
        throw new CapitalError(
          "insufficient_capital",
          `account ${JSON.stringify(request.accountLabel)} has ` +
            `${toDecimalString(available)} ${request.asset} available ` +
            `(balance ${toDecimalString(row.total_balance)} minus allocated ` +
            `${toDecimalString(row.total_allocated)}), which does not cover the ` +
            `requested ${toDecimalString(request.requestedCapital)}`,
        );
      }
      return row.total_allocated + request.requestedCapital;
    },
    options.now,
    maxAttempts,
  );

  const botRow: BotInstanceRow = {
    id: request.id,
    account_label: request.accountLabel,
    exchange: request.exchange,
    pair: request.pair,
    strategy_type: request.strategyType,
    strategy_params_json: request.strategyParams,
    stop_loss_pct: request.stopLossPct,
    take_profit_pct: request.takeProfitPct,
    allocated_capital: request.requestedCapital,
    status: "created",
    halt_reason: null,
    halted_at: null,
    schema_version: 1,
    created_at: options.now,
    updated_at: options.now,
    capital_asset: request.asset,
  };

  // Named rather than inlined: no-raw-d1.test.ts forbids `.batch([` outside
  // /src/db, and that pattern cannot tell this sanctioned call from a raw one.
  const statements = [
    db.botInstances.insertStatement(botRow),
    db.auditLog.insertStatement(
      auditRow("capital.allocated", request.id, request.accountLabel, request.asset, adjustment, options),
    ),
  ];

  try {
    await db.batch(statements);
  } catch (cause) {
    // The reservation is already committed and now has nothing to fund.
    return await undoReservation(
      db,
      request.accountLabel,
      request.asset,
      request.requestedCapital,
      options,
      maxAttempts,
      cause,
    );
  }

  return resultOf(request.id, request.accountLabel, request.asset, adjustment);
}

/**
 * Close a bot and release its capital.
 *
 * Releases exactly `allocated_capital` -- the reservation, not what the
 * position turned out to be worth. A bot that lost money still frees its full
 * reservation here, and the loss appears later as `total_balance` falling when
 * reconciliation writes it.
 *
 * `status = 'stopped'` is the marker that capital has been released, because
 * `allocated_capital` has a `CHECK (> 0)` and so cannot be zeroed to mean
 * "returned". Setting it is also the mutual exclusion: it is a conditional
 * update on the bot not already being stopped, so of two concurrent closes only
 * one changes a row and only one release happens.
 */
export async function releaseBotCapital(
  db: Database,
  botInstanceId: string,
  options: CapitalOptions,
): Promise<AllocationResult> {
  const maxAttempts = options.maxAttempts ?? MAX_ALLOCATION_ATTEMPTS;
  const bot = await requireBot(db, botInstanceId);

  // Shrink the claim first, per the ordering rule: if this succeeds and the
  // ledger update below does not, the capital stays reserved. Over-reserved,
  // which is the safe direction.
  const claimed = await db.botInstances.update(
    { id: botInstanceId, status: { ne: "stopped" } },
    { status: "stopped", updated_at: options.now },
  );
  if (claimed !== 1) {
    throw new CapitalError(
      "bot_already_stopped",
      `bot instance ${JSON.stringify(botInstanceId)} is already stopped; its ` +
        `capital was released when it stopped and releasing again would free ` +
        `the same capital twice`,
    );
  }

  const amount = bot.allocated_capital;
  const adjustment = await adjustAllocated(
    db,
    bot.account_label,
    bot.capital_asset,
    (row) => {
      if (row.total_allocated < amount) {
        throw new CapitalError(
          "release_exceeds_allocated",
          `releasing ${toDecimalString(amount)} ${bot.capital_asset} from bot ` +
            `${JSON.stringify(botInstanceId)} would drive total_allocated below ` +
            `zero (currently ${toDecimalString(row.total_allocated)}). The ledger ` +
            `and the bot rows disagree; this needs reconciling, not forcing.`,
        );
      }
      return row.total_allocated - amount;
    },
    options.now,
    maxAttempts,
  );

  // Last, and deliberately not batched with anything: the statement above whose
  // result had to be inspected cannot be part of a batch. A crash here loses
  // the audit entry for a release that did happen -- a hole in the history,
  // not a wrong balance.
  await db.auditLog.insert(
    auditRow("capital.released", botInstanceId, bot.account_label, bot.capital_asset, adjustment, options),
  );

  return resultOf(botInstanceId, bot.account_label, bot.capital_asset, adjustment);
}

/**
 * Resize a running bot's allocation, up or down.
 *
 * Upward is a new allocation and is checked against available balance exactly
 * as creation is -- the bot's existing allocation is already inside
 * `total_allocated`, so only the delta has to fit. Downward frees the
 * difference immediately.
 *
 * A resize to the size it already is succeeds and writes nothing, including no
 * audit entry, because nothing changed. That makes a redelivered message
 * harmless rather than a source of phantom history.
 */
export async function resizeBotCapital(
  db: Database,
  botInstanceId: string,
  newCapital: Money,
  options: CapitalOptions,
): Promise<AllocationResult> {
  const maxAttempts = options.maxAttempts ?? MAX_ALLOCATION_ATTEMPTS;

  if (newCapital <= ZERO) {
    throw new CapitalError(
      "invalid_capital_amount",
      `resized capital must be positive, got ${toDecimalString(newCapital)}. ` +
        `To take a bot's capital to zero, close it instead -- that is what ` +
        `releasing means, and allocated_capital has a CHECK (> 0).`,
    );
  }

  const bot = await requireBot(db, botInstanceId);
  if (bot.status === "stopped") {
    throw new CapitalError(
      "bot_already_stopped",
      `bot instance ${JSON.stringify(botInstanceId)} is stopped and its capital ` +
        `has been released; resizing it would reserve capital for a bot that ` +
        `will not trade`,
    );
  }

  const delta = newCapital - bot.allocated_capital;
  if (delta === ZERO) {
    const row = await db.capitalLedger.findOne({
      account_label: bot.account_label,
      asset: bot.capital_asset,
    });
    if (row === null) {
      throw new CapitalError(
        "no_ledger_row",
        `no capital_ledger row for account ${JSON.stringify(bot.account_label)} ` +
          `asset ${JSON.stringify(bot.capital_asset)}`,
      );
    }
    return resultOf(botInstanceId, bot.account_label, bot.capital_asset, {
      row,
      previousAllocated: row.total_allocated,
      newAllocated: row.total_allocated,
      attempts: 0,
    });
  }

  const growing = delta > ZERO;

  // Shrinking? Update the bot row first, so an interruption leaves the ledger
  // still holding capital the bot no longer claims. Growing? Reserve first, so
  // an interruption leaves capital reserved the bot does not yet claim. Both
  // land on over-reserved.
  //
  // Either way the bot-row update is conditional on the bot not having been
  // stopped meanwhile, and its `changes` count is inspected -- which is why it
  // is not batched with the audit entry. A concurrent close would otherwise
  // make this update match nothing, raise no error, and leave the reservation
  // stranded on a bot that no longer exists to spend it.
  if (!growing) {
    const claimed = await db.botInstances.update(
      { id: botInstanceId, status: { ne: "stopped" } },
      { allocated_capital: newCapital, updated_at: options.now },
    );
    if (claimed !== 1) {
      // Nothing reserved yet, so nothing to undo.
      throw new CapitalError(
        "bot_already_stopped",
        `bot instance ${JSON.stringify(botInstanceId)} was stopped while being resized`,
      );
    }
  }

  const adjustment = await adjustAllocated(
    db,
    bot.account_label,
    bot.capital_asset,
    (row) => {
      if (growing) {
        const available = row.total_balance - row.total_allocated;
        if (available < delta) {
          throw new CapitalError(
            "insufficient_capital",
            `resizing bot ${JSON.stringify(botInstanceId)} from ` +
              `${toDecimalString(bot.allocated_capital)} to ` +
              `${toDecimalString(newCapital)} ${bot.capital_asset} needs ` +
              `${toDecimalString(delta)} more, but account ` +
              `${JSON.stringify(bot.account_label)} has only ` +
              `${toDecimalString(available)} available`,
          );
        }
      } else if (row.total_allocated < -delta) {
        throw new CapitalError(
          "release_exceeds_allocated",
          `resizing bot ${JSON.stringify(botInstanceId)} down by ` +
            `${toDecimalString(-delta)} ${bot.capital_asset} would drive ` +
            `total_allocated below zero (currently ` +
            `${toDecimalString(row.total_allocated)})`,
        );
      }
      return row.total_allocated + delta;
    },
    options.now,
    maxAttempts,
  );

  const audit = auditRow(
    "capital.resized",
    botInstanceId,
    bot.account_label,
    bot.capital_asset,
    adjustment,
    options,
  );

  if (growing) {
    const claimed = await db.botInstances.update(
      { id: botInstanceId, status: { ne: "stopped" } },
      { allocated_capital: newCapital, updated_at: options.now },
    );
    if (claimed !== 1) {
      // Stopped underneath us, after the delta was already reserved.
      return await undoReservation(
        db,
        bot.account_label,
        bot.capital_asset,
        delta,
        options,
        maxAttempts,
        new CapitalError(
          "bot_already_stopped",
          `bot instance ${JSON.stringify(botInstanceId)} was stopped while being ` +
            `resized upward; the reservation was released again`,
        ),
      );
    }
  }

  await db.auditLog.insert(audit);

  return resultOf(botInstanceId, bot.account_label, bot.capital_asset, adjustment);
}
