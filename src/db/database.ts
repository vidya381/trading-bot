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

import { Repository } from "./table";
import {
  alerts,
  auditLog,
  balanceSnapshots,
  botInstances,
  capitalLedger,
  manualAdjustments,
  orders,
  trades,
} from "./schema";

export class Database {
  readonly #d1: D1Database;

  readonly botInstances: Repository<typeof botInstances.columns>;
  readonly capitalLedger: Repository<typeof capitalLedger.columns>;
  readonly orders: Repository<typeof orders.columns>;
  readonly trades: Repository<typeof trades.columns>;
  readonly balanceSnapshots: Repository<typeof balanceSnapshots.columns>;
  readonly manualAdjustments: Repository<typeof manualAdjustments.columns>;
  readonly auditLog: Repository<typeof auditLog.columns>;
  readonly alerts: Repository<typeof alerts.columns>;

  constructor(d1: D1Database) {
    this.#d1 = d1;
    this.botInstances = new Repository(d1, botInstances);
    this.capitalLedger = new Repository(d1, capitalLedger);
    this.orders = new Repository(d1, orders);
    this.trades = new Repository(d1, trades);
    this.balanceSnapshots = new Repository(d1, balanceSnapshots);
    this.manualAdjustments = new Repository(d1, manualAdjustments);
    this.auditLog = new Repository(d1, auditLog);
    this.alerts = new Repository(d1, alerts);
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
}
