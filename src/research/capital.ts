/**
 * The account's REAL current capital headroom, read from `capital_ledger`
 * (spec section 8.5), for 21.4 Stage 3.
 *
 * This is a deliberate expansion of what the research pipeline reads. Stage 2
 * never needed it: choosing between dca and grid is a question about the coin,
 * and how much money the account has spare cannot make a range-bound series
 * trend. Stage 3 does need it, because 21.4 Stage 3 requires `allocatedCapital`
 * to be one of the fields the proposal fills in, and a capital figure proposed
 * without knowing the account's real headroom is a number invented to look like
 * an answer.
 *
 * ── WHAT THIS IS, AND THE THING IT MUST NEVER BE MISTAKEN FOR ──
 *
 * **THIS READ IS A PREFILL. IT IS NOT A RESERVATION, NOT A COMMITMENT, AND NOT
 * THE CAPITAL CHECK.**
 *
 * The binding check is `createBotInstanceWithCapital` (`src/capital/ledger.ts`),
 * which re-reads `capital_ledger` inside a compare-and-swap loop at the moment a
 * bot is actually created, refuses with `insufficient_capital` if
 * `total_balance - total_allocated < requested`, and re-runs that decision
 * against freshly read state on every retry. That check is unchanged, unweakened
 * and unbypassed by anything in this folder, and 21.1 guarantees this pipeline
 * has no write path to it at all.
 *
 * What this module produces is a number a human sees in a proposal and may
 * choose to type into the create-bot form. Between the two there is an
 * arbitrarily long gap in which another bot may be created, another proposal
 * approved, or the balance rewritten by reconciliation. **The headroom reported
 * here is therefore STALE BY CONSTRUCTION the moment it is read**, exactly as
 * 21.5 requirement 4 says a proposal's data is, and nothing downstream may treat
 * it as an entitlement. If Derive proposes 500 and the real ledger has 400 by
 * submission time, the create-bot flow refuses -- correctly, and without needing
 * to know this module exists.
 *
 * That is why this file reads and returns, and does nothing else. It writes no
 * row, takes no reservation, touches no `total_allocated`, and holds no lock.
 *
 * ── WHY IT IS ITS OWN MODULE AND NOT A CALL INTO `ledger.ts` ──
 *
 * `src/capital/ledger.ts` exposes no read-only headroom function: its three
 * exported operations all WRITE (`createBotInstanceWithCapital`,
 * `releaseBotCapital`, `resizeBotCapital`), and the availability arithmetic
 * lives inside a closure passed to the compare-and-swap loop, reachable only by
 * performing an allocation. Calling any of them here would be this pipeline
 * committing capital, which 21.1 forbids in the plainest terms it has.
 *
 * So the SUBTRACTION is restated here and the CHECK is not. That distinction is
 * the one worth holding on to: `total_balance - total_allocated` is not a risk
 * check, it is the definition of the word "available", and it appears verbatim
 * in `AllocationAuditDetails.available_after` and in `AllocationResult` already.
 * The risk check -- comparing that figure against a request and refusing -- is
 * `ledger.ts`'s, is not copied, and stays the only thing that can stop a bot
 * being created.
 */

import type { Database } from "../db/database";
import type { CapitalLedgerRow } from "../db/schema";
import type { Timestamp } from "../shared/exchange-client";
import { ZERO, type Money } from "../shared/money";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type ResearchCapitalErrorCode =
  /**
   * `capital_ledger` could not be read, so headroom is UNKNOWN.
   *
   * Never "the account has nothing spare". Section 5.6's rule -- a failed read
   * is not data -- applied to money: reporting an unreadable ledger as zero
   * headroom would make every proposal refuse for the wrong reason, and
   * reporting it as unlimited would put a fabricated number in front of a human
   * about to commit real capital.
   */
  | "ledger_unreadable";

export class ResearchCapitalError extends Error {
  readonly code: ResearchCapitalErrorCode;
  constructor(code: ResearchCapitalErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ResearchCapitalError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// The result
// ---------------------------------------------------------------------------

/**
 * One `capital_ledger` row, with the subtraction done.
 *
 * `available` may be NEGATIVE and that is deliberately representable: migration
 * 0001 has no `CHECK (total_allocated <= total_balance)` because a losing bot
 * legitimately leaves an account allocated beyond its balance, and `ledger.ts`
 * says so. Clamping it to zero here would hide an over-allocated account from
 * the one report a human reads before allocating more.
 */
export interface AssetHeadroom {
  readonly asset: string;
  readonly totalBalance: Money;
  readonly totalAllocated: Money;
  /** `totalBalance - totalAllocated`. See the note above about negatives. */
  readonly available: Money;
  /** The ledger row's own `updated_at`, NOT when this read ran. */
  readonly updatedAt: Timestamp;
}

/**
 * Everything `capital_ledger` says about one account, at one moment.
 *
 * `assets` may be EMPTY, and that is a real, common state rather than a failure:
 * `ledger.ts` creates no row automatically ("total_balance has no source yet, so
 * it must be seeded deliberately with seedPlaceholderTotalBalance"), so an
 * account nobody has seeded has no rows at all. An empty list means "this
 * account can fund nothing", which is a fact a proposal must state, not a fetch
 * that went wrong -- the same distinction `NEWS_NOT_YET_AVAILABLE` draws one
 * module over.
 */
export interface AccountCapital {
  readonly accountLabel: string;
  /** When this read ran. See the module header: stale from this instant on. */
  readonly readAt: Timestamp;
  readonly rowsRead: number;
  readonly assets: readonly AssetHeadroom[];
}

// ---------------------------------------------------------------------------
// The read
// ---------------------------------------------------------------------------

function headroomOf(row: CapitalLedgerRow): AssetHeadroom {
  return {
    asset: row.asset,
    totalBalance: row.total_balance,
    totalAllocated: row.total_allocated,
    available: row.total_balance - row.total_allocated,
    updatedAt: row.updated_at,
  };
}

/**
 * Read one account's capital headroom. THE ONLY I/O IN THIS MODULE.
 *
 * Filtered by `account_label` alone, returning every asset row rather than one:
 * `capital_ledger` is keyed by (account_label, asset), a bot's `capital_asset`
 * selects which row funds it, and an account may legitimately hold rows for
 * several. Which asset a proposal should use is a decision Stage 3 makes and a
 * human confirms, so narrowing it here would be this module answering a question
 * it was not asked -- and would hide from the human that another asset had more
 * room.
 *
 * Ordered by asset so two runs over the same table produce the same list in the
 * same order, matching `readAccountExposure`'s reason for ordering its own read:
 * a human comparing two proposals should be comparing proposals.
 *
 * The `catch` is deliberately total, for `readAccountExposure`'s reason: this
 * module cannot enumerate every way D1 fails, and the alternative to catching
 * broadly is a raw driver error escaping a function whose contract is "never
 * silently reports zero".
 */
export async function readAccountCapital(
  db: Database,
  accountLabel: string,
  now: () => Timestamp,
): Promise<AccountCapital> {
  const readAt = now();

  let rows: CapitalLedgerRow[];
  try {
    rows = await db.capitalLedger.findMany({
      where: { account_label: accountLabel },
      orderBy: [{ column: "asset", direction: "asc" }],
    });
  } catch (cause) {
    throw new ResearchCapitalError(
      "ledger_unreadable",
      `could not read capital_ledger for account ${JSON.stringify(accountLabel)}: ` +
        `${cause instanceof Error ? cause.message : String(cause)}. Refusing to report ` +
        `headroom rather than reporting none: a proposal that suggests an allocation ` +
        `figure drawn from a read that did not happen is a fabricated number in front ` +
        `of a human about to commit real capital (section 5.6; 21.5 requirement 6).`,
      { cause },
    );
  }

  return {
    accountLabel,
    readAt,
    rowsRead: rows.length,
    assets: rows.map(headroomOf),
  };
}

/**
 * The headroom for one asset, or `null` if this account has no row for it.
 *
 * `null` is "there is no ledger row", which is `ledger.ts`'s own `no_ledger_row`
 * refusal seen from the read side, and it is NOT the same as a row whose
 * available figure is zero. A caller that treated them alike would tell a human
 * "you have 0 USD spare" about an asset the account has never been funded in.
 */
export function headroomFor(capital: AccountCapital, asset: string): AssetHeadroom | null {
  return capital.assets.find((entry) => entry.asset === asset) ?? null;
}

/** Whether any asset on this account has strictly positive headroom to propose within. */
export function hasAnyHeadroom(capital: AccountCapital): boolean {
  return capital.assets.some((entry) => entry.available > ZERO);
}
