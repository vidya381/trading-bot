/**
 * The reconciliation Cron Trigger (spec section 9), build step 7.
 *
 * This is the binding-aware shell around `/src/reconciliation`. Everything it
 * does that involves a decision lives in that folder and takes its
 * dependencies as parameters; this file only supplies the real ones.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS NOT A SEPARATE WORKER
 * ---------------------------------------------------------------------------
 * Section 3's architecture diagram lists "Cron Trigger Worker: reconciliation
 * job" as its own box, and this is a `scheduled` handler on the existing
 * Worker instead.
 *
 * Cloudflare's model is that a cron trigger is a HANDLER on a Worker, not a
 * kind of Worker. A genuinely separate deployment would need its own name, its
 * own `wrangler.jsonc` entry, its own copy of the D1 and Durable Object
 * bindings, its own deploy step in CI, and its own place in the section 16
 * version-tracking story -- all so that two handlers on the same code could
 * live in different processes. The separation section 3 is drawing is a
 * separation of CONCERNS, and that is preserved by this code living in
 * `/src/reconciliation` with no knowledge of a cron at all.
 *
 * ---------------------------------------------------------------------------
 * THERE IS NO EXCHANGE CLIENT
 * ---------------------------------------------------------------------------
 * Deployed today, this handler does nothing except say so. Building a Binance
 * client needs live API credentials; step 4.1's decision 2 recorded that whose
 * exchange account will be used is still undecided, and no secret exists in
 * either environment.
 *
 * That is handled the same way step 6's decision 13 handled it: there is no
 * default client, and the absence is explicit rather than papered over with
 * one constructed against credentials that do not exist. The check happens
 * BEFORE any D1 access, deliberately -- it means a production deploy, whose
 * database has no schema until go-live (section 16.1), gets a clean no-op
 * instead of a failing query every five minutes.
 */

import { databaseFrom, type Database } from "../db";
import type { BotInstance, BotSnapshot } from "../durable-objects/bot-instance";
import {
  reconcileAccount,
  type DriftThresholds,
  type ReconciliationRunResult,
} from "../reconciliation";
import type { RestExchangeClient, Timestamp } from "../shared/exchange-client";

/**
 * How the handler obtains a client for one exchange account.
 *
 * Returns null when no credentials are available for that account, which is
 * currently always. A factory rather than a single client because section 3's
 * isolation principle is per exchange account, and two accounts will one day
 * mean two key pairs.
 */
export type ExchangeFactory = (accountLabel: string) => RestExchangeClient | null;

export interface ScheduledOptions {
  readonly exchangeFor?: ExchangeFactory;
  readonly now?: () => Timestamp;
  readonly newId?: () => string;
  readonly thresholds?: DriftThresholds;
}

/** No credentials exist yet, in either environment. See the file header. */
const NO_EXCHANGE_CONFIGURED: ExchangeFactory = () => null;

export interface ScheduledResult {
  readonly ran: boolean;
  readonly reason?: string;
  readonly runs: readonly ReconciliationRunResult[];
}

/**
 * Every exchange account this system knows about.
 *
 * The union of accounts that have bots and accounts that have a capital ledger
 * row. The second half matters: an account whose bots were all closed still
 * holds funds, and section 9's severe tier is about unexplained balance
 * changes, which do not require a bot to exist in order to happen.
 */
async function accountLabels(db: Database): Promise<string[]> {
  const bots = await db.botInstances.findMany();
  const ledger = await db.capitalLedger.findMany();
  return [
    ...new Set([
      ...bots.map((bot) => bot.account_label),
      ...ledger.map((row) => row.account_label),
    ]),
  ].sort();
}

/**
 * Run one reconciliation pass over every account.
 *
 * Exported separately from the handler so a test drives exactly this, and so
 * the dashboard can eventually offer a "reconcile now" button without
 * duplicating the wiring.
 */
export async function runScheduledReconciliation(
  env: Env,
  options: ScheduledOptions = {},
): Promise<ScheduledResult> {
  const exchangeFor = options.exchangeFor ?? NO_EXCHANGE_CONFIGURED;
  const now = options.now ?? (() => Date.now());
  const newId = options.newId ?? (() => crypto.randomUUID());

  const namespace = env.BOT_INSTANCE;
  if (namespace === undefined) {
    // The base config block declares no Durable Object binding, so a Worker
    // deployed with no --env genuinely has none. Same check, same reason, as
    // `databaseFrom`.
    return {
      ran: false,
      reason:
        "no BOT_INSTANCE binding in this environment. Only testnet and production " +
        "declare one; a deploy with no --env has neither a database nor any bots.",
      runs: [],
    };
  }

  const db = databaseFrom(env);
  const labels = await accountLabels(db);
  const runs: ReconciliationRunResult[] = [];

  for (const accountLabel of labels) {
    const exchange = exchangeFor(accountLabel);
    if (exchange === null) {
      // Not an alert. Nothing is wrong: no credentials have been created yet,
      // and raising a critical alert every five minutes for a known, recorded
      // state would train whoever reads the dashboard to ignore it.
      continue;
    }

    const stubFor = (botInstanceId: string) =>
      namespace.get(namespace.idFromName(botInstanceId)) as DurableObjectStub<BotInstance>;

    runs.push(
      await reconcileAccount(
        {
          db,
          exchange,
          now,
          newId,
          thresholds: options.thresholds,
          snapshotBot: async (botInstanceId: string): Promise<BotSnapshot | null> =>
            await stubFor(botInstanceId).snapshotIfCreated(),
          haltBot: async (botInstanceId: string, detail: string): Promise<void> => {
            // `manual` is the documented reason for a halt driven by section
            // 7.3 or 7.4 rather than by the strategy's own rules, and the
            // detail carries which run concluded it. `halt` is idempotent:
            // an already-halted bot returns `already_halted` and changes
            // nothing.
            await stubFor(botInstanceId).halt("manual", detail, "reconciliation");
          },
        },
        accountLabel,
      ),
    );
  }

  if (labels.length > 0 && runs.length === 0) {
    return {
      ran: false,
      reason:
        `${labels.length} account(s) exist but none has exchange credentials, so ` +
        `nothing could be reconciled. See step 4.1's decision 2.`,
      runs: [],
    };
  }

  return { ran: true, runs };
}

/** The `scheduled` handler itself, wired into the Worker's default export. */
export async function scheduled(
  _event: ScheduledController,
  env: Env,
  _ctx: ExecutionContext,
): Promise<void> {
  const result = await runScheduledReconciliation(env);
  if (!result.ran) {
    // Observability is enabled in wrangler.jsonc, so this reaches the
    // Cloudflare dashboard's logs.
    console.log(`reconciliation did not run: ${result.reason ?? "unknown"}`);
    return;
  }
  for (const run of result.runs) {
    console.log(
      `reconciliation ${run.runId} account=${run.accountLabel} tier=${run.tier ?? "clean"} ` +
        `findings=${run.findings.length} halted=${run.haltedBotIds.length} ` +
        `breaker=${run.circuitBreakerTripped} skipped=${run.skipped.length}`,
    );
  }
}
