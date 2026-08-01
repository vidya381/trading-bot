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
 * THE EXCHANGE CLIENT (step 3.2 -- resolved; wrong-venue bug fixed)
 * ---------------------------------------------------------------------------
 * When nothing is injected, each account's client is built PER ACCOUNT by
 * `resolveExchangeForAccount` (./exchange-dispatch.ts), keyed by the account's
 * registered `ExchangeId` -- the same single dispatch seam `BotInstance` uses.
 * That resolver picks `resolveDefaultExchange` (Binance) or
 * `resolveGeminiExchange` (Gemini), each of which derives its base URL purely
 * from `env.ENVIRONMENT` so testnet and production can never be pointed at each
 * other. See those files for the full enforcement argument.
 *
 * THIS WAS THE BUG. Until now this file called `resolveDefaultExchange`
 * directly, once, above the account loop -- a Binance client for EVERY account,
 * whatever it was registered as. `BotInstance` had dispatched correctly since
 * step 11, so a Gemini account's orders went to Gemini while its balances were
 * read from Binance. It stayed invisible for two compounding reasons: the
 * account's Binance reads initially SUCCEEDED (a Binance testnet faucet balance
 * of 445 assets was recorded under a Gemini account, and `1MBABYDOGE` in a
 * Gemini account is not a thing anyone was reading for); and reconciliation
 * measures each run against the PREVIOUS run's exchange figure, so two reads of
 * the same wrong venue always differ by zero. The control could not detect that
 * it was auditing the wrong exchange, because it only ever compared the wrong
 * exchange against itself. Then Binance began geo-blocking the Worker and every
 * read failed instead -- silently, for eleven hours; see BLINDNESS below.
 *
 * The account's exchange comes from the `accounts` registry (migration 0006),
 * falling back to its bots' `exchange` column. An account with neither is
 * REFUSED, not defaulted: guessing a venue is the whole failure mode above.
 *
 * A missing secret is now per-account rather than an abort of the whole pass,
 * so a missing GEMINI_API_KEY cannot stop a Binance account being reconciled --
 * and it raises an alert, because an account nobody is reconciling must not be
 * a quiet fact. Credential resolution still happens AFTER the schema guard so
 * an environment deployed empty before go-live no-ops on "no schema".
 *
 * Tests inject `exchangeFor` (a `FakeExchange`), which now receives the
 * account's exchange as its second argument and so can assert WHICH venue an
 * account was routed to -- the assertion whose absence let this ship.
 *
 * ---------------------------------------------------------------------------
 * BLINDNESS (the second bug: silent failure of the thing that catches failures)
 * ---------------------------------------------------------------------------
 * `reconcile.ts` correctly refuses to invent data it could not read: a failed
 * balance read is pushed onto the run's `skipped` list and NO snapshot is
 * written, because recording an unread balance as an unchanged one would make
 * the next run measure from a fiction (section 5.6). But `skipped` was only
 * ever written into the run's `audit_log` details and a `console.log`. No
 * alert, no notification, no escalation. So reconciliation -- the control that
 * exists to catch everything else -- could fail completely on every pass, in
 * total silence. It did, 143 times in a row.
 *
 * `auditBlindness` below closes that: an account with no balance observation
 * newer than `BLIND_AFTER_MS` gets one standing critical alert, resolved
 * automatically when observation resumes. See its own comment for why it is one
 * row per incident rather than per pass, and for what it deliberately does NOT
 * cover (a cron that never fires at all).
 *
 * ---------------------------------------------------------------------------
 * NO SCHEMA -> NO-OP
 * ---------------------------------------------------------------------------
 * Production is deployed but its D1 database is deliberately empty: migrations
 * are not applied until go-live (section 16.1). Without a guard, the first D1
 * read here -- `accountLabels`, which queries `bot_instances` -- throws a raw
 * `no such table` error every time the cron fires. So before any real query,
 * `db.tableExists("bot_instances")` is checked, and a missing schema returns a
 * clean no-op with a reason, exactly like the binding checks above. This is a
 * proactive, specific check rather than a try/catch: it suppresses ONLY the
 * "schema not applied yet" case, and any other D1 error still surfaces because
 * nothing here catches it. An earlier version of this header claimed the
 * exchange-client check already guarded D1; it did not -- `accountLabels` runs
 * before the per-account exchange check, so this guard is what actually
 * delivers that promise.
 */

import { databaseFrom, type Database } from "../db";
import { isExchangeId, type AlertRow, type ExchangeId } from "../db/schema";
import type { BotInstance, BotSnapshot } from "../durable-objects/bot-instance";
import { withRateLimit, type RateLimiterPort } from "../exchange/rate-limited";
import {
  reconcileAccount,
  type DriftThresholds,
  type ReconciliationRunResult,
} from "../reconciliation";
import type { RestExchangeClient, Timestamp } from "../shared/exchange-client";
import { resolveExchangeForAccount } from "./exchange-dispatch";

/**
 * How the handler obtains a client for one exchange account.
 *
 * A factory rather than a single client because section 3's isolation principle
 * is per exchange account, and two accounts will one day mean two key pairs.
 *
 * This is the type the two RESOLVERS return, and it stays keyed on the account
 * label alone: `resolveDefaultExchange` and `resolveGeminiExchange` are each
 * already specific to one exchange, so telling them which exchange to build
 * would be telling them what they are. Choosing BETWEEN them is
 * `resolveExchangeForAccount`'s job, one level up.
 *
 * The `| null` return is for INJECTED factories (a test that wants an account
 * skipped). The production path returns null for no account: a client that
 * cannot be built is an ALERT, not a silent skip -- see `runScheduledReconciliation`.
 */
export type ExchangeFactory = (accountLabel: string) => RestExchangeClient | null;

/**
 * How a TEST supplies a client, standing in for the whole per-account dispatch.
 *
 * Distinct from `ExchangeFactory` because it receives the account's REGISTERED
 * exchange as well as its label, which is the entire point: this seam is where
 * a test asserts that an account was routed to the venue it actually trades on.
 * The production code used to resolve one Binance client above the account loop
 * and hand it to every account, and no test could tell -- the seam only ever
 * saw a label, so "reconciled the Gemini account against Binance" and
 * "reconciled the Gemini account against Gemini" were indistinguishable from
 * inside a test. Widening this type is what makes that assertable.
 */
export type TestExchangeFactory = (
  accountLabel: string,
  exchange: ExchangeId,
) => RestExchangeClient | null;

export interface ScheduledOptions {
  readonly exchangeFor?: TestExchangeFactory;
  readonly now?: () => Timestamp;
  readonly newId?: () => string;
  readonly thresholds?: DriftThresholds;
  /**
   * The `RateLimiter` Durable Object for an account (section 5.4).
   *
   * Defaults to the `RATE_LIMITER` binding. Overridable for tests only; there
   * is deliberately no way to ask for no limiter at all.
   */
  readonly limiterFor?: (accountLabel: string) => RateLimiterPort;
  /** How the rate-limit wait is performed. Injected so tests need no delay. */
  readonly sleep?: (ms: number) => Promise<void>;
  /**
   * The database. Defaults to `databaseFrom(env)`. Overridable for tests (and,
   * later, a dashboard "reconcile now" button) without reaching for the binding.
   */
  readonly db?: Database;
}

export interface ScheduledResult {
  readonly ran: boolean;
  readonly reason?: string;
  readonly runs: readonly ReconciliationRunResult[];
}

/** An account to reconcile, and the venue its funds actually live on. */
interface ReconcilableAccount {
  readonly label: string;
  /**
   * `null` when no registered or inferable exchange could be determined. NOT a
   * reason to guess one -- reading the wrong venue is exactly the failure this
   * type exists to prevent, so a null becomes a refusal plus an alert.
   */
  readonly exchange: ExchangeId | null;
}

/**
 * Every exchange account this system knows about, WITH its exchange.
 *
 * The union of accounts that have bots and accounts that have a capital ledger
 * row. The second half matters: an account whose bots were all closed still
 * holds funds, and section 9's severe tier is about unexplained balance
 * changes, which do not require a bot to exist in order to happen.
 *
 * The exchange comes from the `accounts` registry first (migration 0006, the
 * authoritative record), falling back to the `exchange` on the account's own
 * bot rows for an account that predates registration or was never registered
 * by hand. An unrecognised string resolves to `null` rather than to a default:
 * `isExchangeId` guards it here for the same reason `BotInstance` guards its
 * own stored value before dispatching.
 */
async function reconcilableAccounts(db: Database): Promise<ReconcilableAccount[]> {
  const bots = await db.botInstances.findMany();
  const ledger = await db.capitalLedger.findMany();
  const registry = await db.accounts.findMany();

  const exchangeByLabel = new Map<string, unknown>();
  // Registry first, so a hand-registered account wins over an inference.
  for (const row of registry) exchangeByLabel.set(row.account_label, row.exchange);
  for (const bot of bots) {
    if (!exchangeByLabel.has(bot.account_label)) {
      exchangeByLabel.set(bot.account_label, bot.exchange);
    }
  }
  // A ledger-only account contributes a label but no exchange to infer from.
  for (const row of ledger) {
    if (!exchangeByLabel.has(row.account_label)) exchangeByLabel.set(row.account_label, undefined);
  }

  return [...exchangeByLabel.entries()]
    .map(([label, exchange]) => ({
      label,
      exchange: isExchangeId(exchange) ? exchange : null,
    }))
    .sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));
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
  const now = options.now ?? (() => Date.now());
  const newId = options.newId ?? (() => crypto.randomUUID());

  const limiterNamespace = env.RATE_LIMITER;
  if (limiterNamespace === undefined && options.limiterFor === undefined) {
    // Same reasoning as the `BOT_INSTANCE` check below, and the same reasoning
    // `BotInstance` uses for its own limiter: an environment with no budget to
    // spend against is not one to reconcile ungated. Refusing is the safe
    // default for a risk control.
    return {
      ran: false,
      reason:
        "no RATE_LIMITER binding in this environment, so section 5.4's budget " +
        "cannot be enforced. Only testnet and production declare one.",
      runs: [],
    };
  }
  const limiterFor =
    options.limiterFor ??
    ((accountLabel: string): RateLimiterPort =>
      limiterNamespace!.get(limiterNamespace!.idFromName(accountLabel)));

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

  const db = options.db ?? databaseFrom(env);

  // No schema yet -> clean no-op. Production is deployed with an empty database
  // (migrations deferred to go-live, section 16.1); without this the first read
  // below throws `no such table: bot_instances` every five minutes. A specific
  // check, not a try/catch: only a missing schema is suppressed, and any other
  // D1 error still surfaces because nothing here catches it. See the header.
  if (!(await db.tableExists("bot_instances"))) {
    return {
      ran: false,
      reason:
        "no schema in this environment yet (the `bot_instances` table does not " +
        "exist). Migrations are deferred to go-live (section 16.1). See " +
        "docs/d1-provisioning.md.",
      runs: [],
    };
  }

  const accounts = await reconcilableAccounts(db);
  const labels = accounts.map((account) => account.label);
  const runs: ReconciliationRunResult[] = [];
  const unresolvable: string[] = [];

  for (const account of accounts) {
    const accountLabel = account.label;

    // ---- Dispatch, per account, to the venue the account actually trades on.
    //
    // This used to be one `resolveDefaultExchange(env, now)` hoisted above the
    // loop: a Binance client for every account regardless of its registered
    // exchange. `BotInstance` had dispatched correctly since step 11, so orders
    // went to Gemini while reconciliation read Binance for the same account --
    // and because reconciliation compares each run against the PREVIOUS run's
    // exchange figure, the drift between two reads of the same wrong venue was
    // always zero and nothing ever flagged it. Resolution is per account and
    // inside the loop so one account's missing secret cannot blind another's.
    let exchange: RestExchangeClient | null;
    if (account.exchange === null) {
      // No known venue. Refusing is the only safe move: picking a default is
      // precisely how the wrong-venue bug read a Gemini account from Binance.
      unresolvable.push(
        `${accountLabel}: no registered exchange (and none inferable from its bots), ` +
          `so there is no venue to read. Register it -- see docs/d1-provisioning.md.`,
      );
      await alertUnreconcilable(db, options, accountLabel, now(), unresolvable.at(-1)!);
      continue;
    }

    if (options.exchangeFor !== undefined) {
      exchange = options.exchangeFor(accountLabel, account.exchange);
    } else {
      const resolved = resolveExchangeForAccount(account.exchange, env, now);
      if (!resolved.ok) {
        // A missing secret for THIS account's exchange. Previously this aborted
        // the whole pass with `ran: false`; now it is per-account, and it
        // ALERTS. A monitoring job that cannot see an account must say so out
        // loud -- the eleven-hour blind spot was silent precisely because the
        // "could not read" path only ever wrote to an audit JSON field.
        unresolvable.push(`${accountLabel} (${account.exchange}): ${resolved.reason}`);
        await alertUnreconcilable(db, options, accountLabel, now(), unresolvable.at(-1)!);
        continue;
      }
      exchange = resolved.exchangeFor(accountLabel);
    }

    if (exchange === null) {
      // An injected factory chose to skip this account. Not an alert and not a
      // failure: the production path above never yields null, so this is only
      // reachable via a test seam.
      continue;
    }

    const stubFor = (botInstanceId: string) =>
      namespace.get(namespace.idFromName(botInstanceId)) as DurableObjectStub<BotInstance>;

    // Section 5.4, wired here rather than inside `/src/reconciliation`. That
    // folder takes every dependency as a parameter and knows nothing about
    // bindings (step 7, decision 8), so the limiter is a binding concern and
    // belongs on this side of the line -- and wrapping here means `reconcile.ts`
    // needed no change at all to be routed through the budget.
    //
    // ROUTINE priority for the whole pass. Every exchange call reconciliation
    // makes is a READ, and step 7 measured the cost at roughly 20 weight plus
    // 26 per distinct pair per five minutes against 1200/minute. Tagging a
    // periodic audit as risk-exit would let it draw on the slice reserved for
    // getting out of positions, to buy nothing: if the budget is that tight,
    // the correct outcome is that this run is throttled and reports what it
    // could not check, which it already knows how to do.
    //
    // Note the halts this job performs are NOT routine, and are not affected:
    // they go through `haltBot` into the bot's own object, which uses its own
    // risk-exit view for the cancellations.
    const gatedExchange = withRateLimit(exchange, limiterFor(accountLabel), {
      priority: "routine",
      now,
      label: `reconciliation ${accountLabel}`,
      ...(options.sleep !== undefined ? { sleep: options.sleep } : {}),
    });

    const run = await reconcileAccount(
      {
        db,
        exchange: gatedExchange,
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
    );
    runs.push(run);

    // The run happened; whether it SAW anything is a separate question, and it
    // is the question nothing used to ask.
    await auditBlindness(db, options, accountLabel, run, now());
  }

  if (labels.length > 0 && runs.length === 0) {
    // Every account was refused or skipped. Reachable in production now that a
    // missing secret is per-account rather than an up-front abort, so the reason
    // carries the specifics instead of assuming a test seam.
    return {
      ran: false,
      reason:
        `${labels.length} account(s) exist but no exchange client could be obtained ` +
        `for any of them, so nothing could be reconciled` +
        (unresolvable.length > 0 ? `: ${unresolvable.join("; ")}` : "."),
      runs: [],
    };
  }

  return { ran: true, runs };
}

// ---------------------------------------------------------------------------
// Blindness: a pass that runs but observes nothing
// ---------------------------------------------------------------------------

/**
 * How long an account may go unobserved before it is an alert rather than a
 * blip. Three missed passes at the five-minute cron, so a single transient
 * exchange error stays quiet and a sustained outage does not.
 */
export const BLIND_AFTER_MS = 16 * 60 * 1000;

/** `alert_type` for an account reconciliation cannot see at all. */
export const RECONCILIATION_BLIND_ALERT = "reconciliation_blind";

/**
 * Raise (or clear) the standing "this account is unobserved" alert.
 *
 * THE GAP THIS CLOSES. `reconcile.ts` already refuses to invent data it could
 * not read: an unreadable balance is pushed onto `skipped` and no snapshot is
 * written, because recording an unread balance as an unchanged one would make
 * the next run measure its delta from a fiction (section 5.6). That is right.
 * What was missing is that `skipped` went ONLY into the run's `audit_log`
 * `details_json` and a `console.log` -- no alert row, no notification, no
 * escalation. Reconciliation is the control that catches everything else, and
 * it could fail totally, every five minutes, in complete silence. It did:
 * 143 consecutive passes read nothing and said nothing.
 *
 * So: after every pass, if the account has no balance observation newer than
 * `BLIND_AFTER_MS`, there is an open alert saying so. One row per incident, not
 * one per pass -- an existing unresolved alert is left alone rather than
 * duplicated 288 times a day, and section 10's dispatcher applies its own
 * cooldown on top. When observation resumes, the alert is RESOLVED, so the
 * table reads as incidents rather than as noise.
 *
 * Scope worth stating plainly: this detects "the pass ran and saw nothing". It
 * cannot detect "the cron never fired at all", because it is itself run by that
 * cron. That needs an external dead-man's switch and is deliberately not
 * invented here; it is recorded as an open question in the decision log.
 */
async function auditBlindness(
  db: Database,
  options: ScheduledOptions,
  accountLabel: string,
  run: ReconciliationRunResult,
  at: Timestamp,
): Promise<void> {
  const source = `reconciliation:${accountLabel}`;
  const open = await db.alerts.findMany({
    where: { alert_type: RECONCILIATION_BLIND_ALERT, source, resolved: false },
  });

  const latest = await db.balanceSnapshots.findMany({
    where: { account_label: accountLabel },
    orderBy: [{ column: "checked_at", direction: "desc" }],
    limit: 1,
  });
  const lastSeen = latest[0]?.checked_at ?? null;
  const blindFor = lastSeen === null ? null : at - lastSeen;
  const blind = blindFor === null || blindFor > BLIND_AFTER_MS;

  if (!blind) {
    // Observation is current again. Close the incident rather than leaving a
    // resolved failure standing on the dashboard.
    for (const alert of open) {
      await db.alerts.update({ id: alert.id }, { resolved: true });
    }
    return;
  }

  if (open.length > 0) return; // Incident already open.

  const howLong =
    blindFor === null
      ? "there is no balance observation for this account at all"
      : `the last balance observation was ${Math.floor(blindFor / 60000)} minute(s) ago`;

  await db.alerts.insert({
    id: (options.newId ?? (() => crypto.randomUUID()))(),
    severity: "critical",
    category: "system",
    alert_type: RECONCILIATION_BLIND_ALERT,
    bot_instance_id: null,
    source,
    message:
      `reconciliation has not observed account ${accountLabel} for longer than ` +
      `${Math.floor(BLIND_AFTER_MS / 60000)} minutes: ${howLong}. The pass is running ` +
      `but reading nothing, so section 9's drift detection is NOT protecting this ` +
      `account. Reported by the run itself: ` +
      `${run.skipped.length > 0 ? run.skipped.join(" | ") : "no reason recorded"}`,
    resolved: false,
    created_at: at,
    notified_at: null,
  } satisfies AlertRow);
}

/** The same standing-alert treatment for an account no client could be built for. */
async function alertUnreconcilable(
  db: Database,
  options: ScheduledOptions,
  accountLabel: string,
  at: Timestamp,
  reason: string,
): Promise<void> {
  const source = `reconciliation:${accountLabel}`;
  const open = await db.alerts.findMany({
    where: { alert_type: RECONCILIATION_BLIND_ALERT, source, resolved: false },
  });
  if (open.length > 0) return;

  await db.alerts.insert({
    id: (options.newId ?? (() => crypto.randomUUID()))(),
    severity: "critical",
    category: "system",
    alert_type: RECONCILIATION_BLIND_ALERT,
    bot_instance_id: null,
    source,
    message:
      `reconciliation cannot build an exchange client for account ${accountLabel}, so ` +
      `it is not being reconciled at all: ${reason}`,
    resolved: false,
    created_at: at,
    notified_at: null,
  } satisfies AlertRow);
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
