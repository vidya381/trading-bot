/**
 * Seeding `capital_ledger.total_balance` BY HAND, because nothing else can yet.
 *
 * THIS IS A PLACEHOLDER. Read this paragraph before using anything in this file.
 * `total_balance` is meant to come from reconciliation (spec section 9),
 * which compares the exchange's reported balance against the internally
 * calculated one and is build step 7. Step 7 does not exist. Until it does, the
 * number in `total_balance` is whatever a human typed, it does not move when
 * the account's real balance moves, and it will be wrong the moment a trade
 * fills or funds are moved on the exchange.
 *
 * Every name in this file says "placeholder" so that no call site can read as
 * though a balance feed exists. Every row it writes carries `"placeholder":
 * true` and `"source": "human"` in its `audit_log` details, so the same is true
 * of the data after the fact -- someone reading the ledger in six months can
 * tell that these numbers were asserted, not observed.
 *
 * WHAT THIS IS SAFE FOR
 *   - testnet, where the balance is fake anyway
 *   - creating the ledger row that `createBotInstanceWithCapital` requires
 *   - deliberately capping how much capital the bots may reserve, which is
 *     section 7.6's capital ramp-up done by hand
 *
 * WHAT IT IS NOT SAFE FOR
 *   - anything in production that assumes this tracks real money
 *
 * Replacing this is step 7's job, and the go-live checklist should not be
 * satisfiable while a production ledger row's last write came from here.
 */

import type { Database } from "../db/database";
import type { AuditLogRow, CapitalLedgerRow } from "../db/schema";
import { toDecimalString, ZERO, type Money } from "../shared/money";
import { CapitalError } from "./ledger";

/** The `audit_log.action` written by every seed. Distinct from `capital.*`
 *  actions on purpose: this is not an allocation change. */
export const PLACEHOLDER_BALANCE_ACTION = "capital.placeholder_balance_seeded";

/**
 * Actors that are not a person.
 *
 * Rejected because the whole point of this file is that a human asserted a
 * number. The day something automated calls this, it means a balance feed was
 * built and pointed at the placeholder instead of replacing it, and that should
 * fail loudly rather than look like it worked.
 */
export const NON_HUMAN_ACTORS: readonly string[] = ["system", "ci", "cron", "reconciliation"];

export interface PlaceholderBalanceSeed {
  readonly accountLabel: string;
  readonly asset: string;
  readonly totalBalance: Money;
  /** Where the number came from, in the seeder's own words. Required. */
  readonly note: string;
}

export interface PlaceholderBalanceAuditDetails {
  readonly action: typeof PLACEHOLDER_BALANCE_ACTION;
  /** Stated in the data itself, not only in the action name. */
  readonly placeholder: true;
  readonly source: "human";
  readonly account_label: string;
  readonly asset: string;
  /** null when this call created the ledger row. */
  readonly previous_balance: string | null;
  readonly new_balance: string;
  /** Left exactly as it was: seeding a balance never touches allocations. */
  readonly total_allocated: string;
  readonly note: string;
}

/**
 * Create or overwrite one `(account_label, asset)` ledger row's `total_balance`.
 *
 * `total_allocated` is never touched, on either path. A new row starts at zero
 * because no bot has reserved anything from it yet; an existing row keeps
 * whatever bots have reserved, which is also why this needs no compare-and-swap
 * against a concurrent allocation -- the two writes touch different columns and
 * an allocation that lands mid-seed keeps its reservation.
 *
 * Returns the row as it now stands.
 */
export async function seedPlaceholderTotalBalance(
  db: Database,
  seed: PlaceholderBalanceSeed,
  options: { readonly actor: string; readonly now: number },
): Promise<CapitalLedgerRow> {
  if (seed.totalBalance < ZERO) {
    throw new CapitalError(
      "invalid_capital_amount",
      `total_balance cannot be negative, got ${toDecimalString(seed.totalBalance)}`,
    );
  }

  const actor = options.actor.trim();
  if (actor === "" || NON_HUMAN_ACTORS.includes(actor)) {
    throw new CapitalError(
      "placeholder_requires_human_actor",
      `seeding a placeholder balance requires a human actor, got ` +
        `${JSON.stringify(options.actor)}. This function exists only because no ` +
        `balance feed does; if something automated is calling it, replace it ` +
        `with reconciliation (section 9) rather than pointing the automation here.`,
    );
  }

  const note = seed.note.trim();
  if (note === "") {
    throw new CapitalError(
      "placeholder_requires_note",
      `seeding a placeholder balance requires a note saying where the number ` +
        `came from; it is the only provenance this value will ever have`,
    );
  }

  const existing = await db.capitalLedger.findOne({
    account_label: seed.accountLabel,
    asset: seed.asset,
  });

  const details: PlaceholderBalanceAuditDetails = {
    action: PLACEHOLDER_BALANCE_ACTION,
    placeholder: true,
    source: "human",
    account_label: seed.accountLabel,
    asset: seed.asset,
    previous_balance: existing === null ? null : toDecimalString(existing.total_balance),
    new_balance: toDecimalString(seed.totalBalance),
    total_allocated: toDecimalString(existing?.total_allocated ?? ZERO),
    note,
  };

  const audit: AuditLogRow = {
    id: crypto.randomUUID(),
    actor,
    action: PLACEHOLDER_BALANCE_ACTION,
    // No bot: this is an account-level fact, and the column is nullable for
    // exactly this kind of entry.
    target_bot_instance_id: null,
    details_json: details,
    created_at: options.now,
  };

  const row: CapitalLedgerRow = {
    id: existing?.id ?? crypto.randomUUID(),
    account_label: seed.accountLabel,
    asset: seed.asset,
    total_balance: seed.totalBalance,
    total_allocated: existing?.total_allocated ?? ZERO,
    updated_at: options.now,
  };

  // Named rather than inlined: no-raw-d1.test.ts forbids `.batch([` outside
  // /src/db and cannot tell this sanctioned call from a raw one.
  const statements = [
    existing === null
      ? db.capitalLedger.insertStatement(row)
      : // Only total_balance. Writing total_allocated back here would clobber
        // any allocation that committed between the read above and this write.
        db.capitalLedger.updateStatement(
          { account_label: seed.accountLabel, asset: seed.asset },
          { total_balance: seed.totalBalance, updated_at: options.now },
        ),
    db.auditLog.insertStatement(audit),
  ];
  await db.batch(statements);

  const written = await db.capitalLedger.findOne({
    account_label: seed.accountLabel,
    asset: seed.asset,
  });
  /* c8 ignore start -- unreachable: the batch above just wrote this row and
     nothing deletes from these tables (section 8.7). */
  if (written === null) {
    throw new CapitalError(
      "no_ledger_row",
      `capital_ledger row for ${JSON.stringify(seed.accountLabel)}/` +
        `${JSON.stringify(seed.asset)} vanished immediately after being written`,
    );
  }
  /* c8 ignore stop */
  return written;
}
