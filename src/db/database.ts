/**
 * The one entry point to D1 (spec section 8.2), build step 4.
 *
 * `Database` takes the raw `D1Database` binding in its constructor and keeps it
 * in a private field. Nothing on its surface returns it, and nothing on its
 * surface accepts SQL. Application code is handed a `Database`, not a binding,
 * so the shortest path to the data is also the only correct one.
 *
 * The remaining way to write raw SQL is for a call site to reach past this and
 * use `env.DB` itself. That is not preventable in the type system, so
 * `no-raw-d1.test.ts` fails the build if any file outside /src/db does it.
 */

import { DatabaseError } from "./columns";
import { Repository } from "./table";
import {
  accounts,
  alerts,
  auditLog,
  balanceSnapshots,
  botInstances,
  capitalLedger,
  circuitBreakers,
  globalKillSwitch,
  manualAdjustments,
  orders,
  proposals,
  trades,
  watchlist,
} from "./schema";

export class Database {
  readonly #d1: D1Database;

  readonly botInstances: Repository<typeof botInstances.columns>;
  readonly accounts: Repository<typeof accounts.columns>;
  readonly watchlist: Repository<typeof watchlist.columns>;
  readonly capitalLedger: Repository<typeof capitalLedger.columns>;
  readonly orders: Repository<typeof orders.columns>;
  readonly trades: Repository<typeof trades.columns>;
  readonly balanceSnapshots: Repository<typeof balanceSnapshots.columns>;
  readonly manualAdjustments: Repository<typeof manualAdjustments.columns>;
  readonly auditLog: Repository<typeof auditLog.columns>;
  readonly alerts: Repository<typeof alerts.columns>;
  readonly circuitBreakers: Repository<typeof circuitBreakers.columns>;
  readonly globalKillSwitch: Repository<typeof globalKillSwitch.columns>;
  /** The permanent proposal record (migration 0009, spec 21.5 requirement 5). */
  readonly proposals: Repository<typeof proposals.columns>;

  constructor(d1: D1Database) {
    this.#d1 = d1;
    this.botInstances = new Repository(d1, botInstances);
    this.accounts = new Repository(d1, accounts);
    this.watchlist = new Repository(d1, watchlist);
    this.capitalLedger = new Repository(d1, capitalLedger);
    this.orders = new Repository(d1, orders);
    this.trades = new Repository(d1, trades);
    this.balanceSnapshots = new Repository(d1, balanceSnapshots);
    this.manualAdjustments = new Repository(d1, manualAdjustments);
    this.auditLog = new Repository(d1, auditLog);
    this.alerts = new Repository(d1, alerts);
    this.circuitBreakers = new Repository(d1, circuitBreakers);
    this.globalKillSwitch = new Repository(d1, globalKillSwitch);
    this.proposals = new Repository(d1, proposals);
  }

  /**
   * Run several statements as one atomic unit.
   *
   * Statements come from a repository's `insertStatement` / `updateStatement`,
   * so they carry the same encoding guarantees as the executing methods -- this
   * accepts prepared statements, not SQL.
   *
   * D1 wraps a batch in a transaction and rolls the whole thing back if any
   * statement fails, which is what recording a fill needs: the trade row and
   * the order's new filled_quantity must both land or neither must.
   */
  async batch(statements: readonly D1PreparedStatement[]): Promise<void> {
    if (statements.length === 0) return;
    await this.#d1.batch(statements as D1PreparedStatement[]);
  }

  /**
   * Whether a table exists in this database.
   *
   * Added at step 8's follow-up so the cron Workers can tell "the schema has
   * not been applied yet" (production before go-live, section 16.1) from a
   * genuine failure. It queries `sqlite_master`, which always exists -- even on
   * an empty database -- so this method itself never throws `no such table`.
   * The result is a boolean, so a caller guards on it without a try/catch and
   * without intercepting any other error.
   *
   * The raw statement is allowed here because this file is inside /src/db; the
   * `no-raw-d1` build check forbids it only elsewhere.
   */
  async tableExists(name: string): Promise<boolean> {
    const row = await this.#d1
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1")
      .bind(name)
      .first();
    return row !== null;
  }
}

/**
 * Build a `Database` from a Worker or Durable Object's environment.
 *
 * This exists so that nothing outside /src/db has to name the binding.
 * `no-raw-d1.test.ts` fails the build on any `env.DB` elsewhere, and its
 * message says "construct a `Database` once and pass that" -- which needs one
 * sanctioned place to do the constructing. This is that place.
 *
 * The binding is optional on the base env for a real reason (step 4's
 * `test-helpers.rawD1` documents it): the base config block in wrangler.jsonc
 * declares no database, so a Worker deployed without `--env` genuinely has
 * none. Checking rather than asserting means that mistake says so in one line.
 */
export function databaseFrom(env: { readonly DB?: D1Database }): Database {
  if (env.DB === undefined) {
    throw new DatabaseError(
      "missing_binding",
      "no DB binding in this environment. Only the testnet and production " +
        "environments in wrangler.jsonc declare one; a deploy with no --env has " +
        "no database at all, deliberately.",
    );
  }
  return new Database(env.DB);
}
