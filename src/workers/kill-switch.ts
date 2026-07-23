/**
 * The binding-aware shell around the global kill switch (spec section 7.4),
 * build step 10.3.
 *
 * The same shape as `/src/workers/reconciliation.ts`: every decision lives in
 * `/src/reconciliation/kill-switch.ts` and takes its dependencies as
 * parameters; this file only supplies the real ones -- the D1 database and, for
 * a trip, the `haltBot` port built from the `BOT_INSTANCE` Durable Object
 * namespace so the sweep goes through each bot's own existing halt path.
 *
 * These two functions are the backend the future dashboard's kill-switch button
 * and its reset call (build step 10). No HTTP route or UI is built here (that is
 * step 10, gated behind Cloudflare Access at step 11); this is the callable
 * seam, exposed and tested, that those will invoke.
 *
 * The binding and schema guards mirror the reconciliation worker exactly: a
 * deploy with no `--env` has no `BOT_INSTANCE` namespace and no database, and
 * production is deployed with an empty database until go-live (section 16.1), so
 * both are handled with a clean, reasoned refusal rather than a raw error.
 */

import { databaseFrom } from "../db";
import type { BotInstance } from "../durable-objects/bot-instance";
import {
  resetGlobalKillSwitch,
  tripGlobalKillSwitch,
  type GlobalResetRequest,
  type GlobalTripRequest,
  type GlobalTripResult,
} from "../reconciliation/kill-switch";

/** What the caller supplies; the bindings and default clock/id are filled in here. */
export interface KillSwitchOptions {
  readonly now?: () => number;
  readonly newId?: () => string;
}

/** A refusal that never reached the switch (no binding, no schema). */
export interface KillSwitchNoOp {
  readonly ran: false;
  readonly reason: string;
}

export interface KillSwitchTripped {
  readonly ran: true;
  readonly result: GlobalTripResult;
}

/**
 * Pull the global kill switch from a Worker environment.
 *
 * Builds the `haltBot` port from the `BOT_INSTANCE` namespace -- the same
 * `stubFor(...).halt("manual", ...)` the reconciliation worker uses for a
 * section 7.3 trip -- so the sweep halts each bot through its own object, which
 * uses its own risk-exit budget for the cancellations.
 */
export async function tripGlobalKillSwitchFromEnv(
  env: Env,
  request: Pick<GlobalTripRequest, "reason" | "actor">,
  options: KillSwitchOptions = {},
): Promise<KillSwitchTripped | KillSwitchNoOp> {
  const now = options.now ?? (() => Date.now());
  const newId = options.newId ?? (() => crypto.randomUUID());

  const namespace = env.BOT_INSTANCE;
  if (namespace === undefined) {
    return {
      ran: false,
      reason:
        "no BOT_INSTANCE binding in this environment. Only testnet and production declare " +
        "one; a deploy with no --env has neither a database nor any bots to halt.",
    };
  }

  const db = databaseFrom(env);
  if (!(await db.tableExists("bot_instances"))) {
    // An emergency stop with nothing to stop. The latch would have nowhere to
    // live either, so this is a clean no-op rather than a partial trip.
    return {
      ran: false,
      reason:
        "no schema in this environment yet (the `bot_instances` table does not exist). " +
        "Migrations are deferred to go-live (section 16.1). There are no bots to halt.",
    };
  }

  const stubFor = (botInstanceId: string): DurableObjectStub<BotInstance> =>
    namespace.get(namespace.idFromName(botInstanceId)) as DurableObjectStub<BotInstance>;

  const result = await tripGlobalKillSwitch(db, {
    reason: request.reason,
    actor: request.actor,
    now: now(),
    newId,
    haltBot: async (botInstanceId: string, detail: string): Promise<void> => {
      // `halt` is idempotent: an already-halted bot returns `already_halted`.
      await stubFor(botInstanceId).halt("manual", detail, "kill-switch");
    },
  });

  return { ran: true, result };
}

/**
 * Re-arm the global kill switch from a Worker environment.
 *
 * No `BOT_INSTANCE` namespace is needed -- a reset touches only the latch, no
 * bot -- so this guards on the database alone.
 */
export async function resetGlobalKillSwitchFromEnv(
  env: Env,
  request: Pick<GlobalResetRequest, "actor" | "note">,
  options: KillSwitchOptions = {},
): Promise<void> {
  const now = options.now ?? (() => Date.now());
  const newId = options.newId ?? (() => crypto.randomUUID());
  const db = databaseFrom(env);
  await resetGlobalKillSwitch(db, {
    actor: request.actor,
    note: request.note,
    now: now(),
    newId,
  });
}
