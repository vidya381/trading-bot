/**
 * The reconciliation pass (spec section 9), build step 7.
 *
 * One `reconcileAccount` call is one run against one exchange account. The
 * Cron Trigger Worker in `/src/workers/reconciliation.ts` calls it on a
 * schedule; nothing here reads a clock or a binding directly, so a test drives
 * exactly the same code path the cron does.
 *
 * ---------------------------------------------------------------------------
 * WHAT A DISCREPANCY MEANS HERE (the balance model)
 * ---------------------------------------------------------------------------
 * Section 9 says to compare the exchange against "what each relevant Durable
 * Object and D1 believe is true". For ORDERS that is straightforward: the
 * object holds its own order records and the exchange lists its open orders.
 *
 * For BALANCES it is not, because nothing in this system maintained a real
 * internal balance before this file. `capital_ledger.total_balance` was
 * whatever a human typed into `seedPlaceholderTotalBalance`, and step 5's own
 * header says total_balance is "reconciliation's to write". Comparing the
 * exchange against that placeholder would report a large discrepancy on every
 * run that is not drift at all -- it is the placeholder being a guess.
 *
 * So balances are reconciled as a DELTA between runs:
 *
 *     internal_calculated_balance = previous run's exchange balance
 *                                 + everything this system itself did since
 *     discrepancy                 = exchange_reported_balance
 *                                 - internal_calculated_balance
 *                                 - unreconciled manual adjustments
 *
 * The discrepancy is therefore the UNEXPLAINED part of the change, which is
 * the only quantity worth alerting on. This also matches migration 0001's note
 * that `discrepancy` "is NOT a plain difference of these two columns".
 *
 * The FIRST run for an (account, asset) has no previous snapshot to subtract
 * from. It adopts the exchange's balance as the baseline, records the row with
 * a zero discrepancy, and raises nothing. There is no honest alternative: with
 * no prior observation there is no change to explain, and treating the whole
 * balance as unexplained would trip the circuit breaker on first run of every
 * account, forever.
 *
 * ---------------------------------------------------------------------------
 * WHAT AUTO-CORRECT IS ALLOWED TO TOUCH
 * ---------------------------------------------------------------------------
 * The D1 mirror, and nothing else. Section 8.1 makes each Durable Object the
 * source of truth for its own state and section 8.2 calls D1 "mirrored from"
 * it. A cron writing into a running bot's position would make two writers to
 * one number, from outside the object that serialises access to it, using a
 * read that is already stale by the time the write lands.
 *
 * The practical consequence is that a minor finding is only ever emitted for
 * something this job CAN fix. Where the mirror is wrong in a way that cannot
 * be repaired from the object's own snapshot, the finding is raised as
 * meaningful instead -- because "minor" in section 9 is defined by its action
 * ("auto-correct, log, no alert"), and a minor finding nobody can correct
 * would be a silent one.
 *
 * ---------------------------------------------------------------------------
 * RATE LIMITING
 * ---------------------------------------------------------------------------
 * Nothing in this file knows about section 5.4's budget, and that is by
 * design rather than by omission. `ReconciliationPorts.exchange` is supplied by
 * `/src/workers/reconciliation.ts`, which wraps it in the account's
 * `RateLimiter` Durable Object at ROUTINE priority before calling in. So every
 * exchange read below is gated, and this module still takes its dependencies as
 * parameters and knows nothing about bindings.
 *
 * Routine because every call here is a read on a schedule: one pass costs
 * roughly 20 weight for balances plus 26 per distinct pair, every 5 minutes,
 * against 1200/minute. This job was never the exposure. The exposure is a
 * severe-drift trip cancelling many orders at once -- and those cancellations
 * do not happen here either. They happen inside each bot's own object, through
 * `haltBot`, at RISK-EXIT priority, drawing on the slice reserved for exactly
 * that.
 */

import type { Database } from "../db/database";
import type {
  AlertRow,
  AuditLogRow,
  BalanceSnapshotRow,
  BotInstanceRow,
  DriftClassification,
  ManualAdjustmentRow,
  OrderRow,
} from "../db/schema";
import type { BotSnapshot } from "../durable-objects/bot-instance";
import {
  raiseStandingAlert,
  resolveClearedStandingAlerts,
  standingAlertKey,
} from "../alerts";
import {
  isReconciliationAlertType,
  reconciliationAlertType,
  type AlertingTier,
} from "../shared/alert-types";
import { isUsable } from "../shared/downtime";
import type {
  Balance,
  OrderStatus,
  Pair,
  RestExchangeClient,
  SymbolFilters,
  Timestamp,
} from "../shared/exchange-client";
import { parseClientOrderId } from "../shared/idempotency";
import { mul, toDecimalString, ZERO, type Money } from "../shared/money";
import { compareWithExchange, type TrackedOrder } from "../shared/order-state";
import {
  activeBotsOnAccount,
  tripAccountCircuitBreaker,
  type HaltBotPort,
} from "./circuit-breaker";
import {
  classifyAll,
  DEFAULT_DRIFT_THRESHOLDS,
  highestTier,
  INGESTED_ALERT_TYPES,
  type FindingKind,
  type ClassifiedFinding,
  type DriftThresholds,
  type Finding,
} from "./findings";

/**
 * Statuses whose bots reconciliation examines.
 *
 * `stopped` is excluded: its capital is released and it holds no position, so
 * there is nothing of its to compare. `halted` is INCLUDED, and deliberately
 * -- a halted bot can still have an order the halt failed to cancel (step 6
 * raises `cancel_failed` for exactly that), and that order is live on the
 * exchange whatever this system's status column says.
 */
const RECONCILED_STATUSES = ["created", "running", "halted"] as const;

/** Everything this module needs from the outside, so tests can supply it. */
export interface ReconciliationPorts {
  readonly db: Database;
  /**
   * The REST half of section 4.1. As in step 6, there is deliberately no
   * default: building a Binance client needs live API credentials and step
   * 4.1's decision 2 recorded that whose exchange account will be used is
   * still undecided.
   */
  readonly exchange: RestExchangeClient;
  readonly now: () => Timestamp;
  readonly newId: () => string;
  /** Halt one bot through its own section 7.2 path. Must be idempotent. */
  readonly haltBot: HaltBotPort;
  /** Read a bot's own state. Null when the object holds none. */
  readonly snapshotBot: (botInstanceId: string) => Promise<BotSnapshot | null>;
  readonly thresholds?: DriftThresholds;
}

/**
 * A finding plus, where one exists, the repair that makes it minor.
 *
 * The correction is a closure rather than data because only the detection site
 * knows what "fix this" means. Keeping it OUT of `Finding` is what lets
 * `findings.ts` stay pure and independently testable.
 */
interface PendingFinding {
  readonly finding: Finding;
  /** Present only on findings whose kind carries a `minor` floor. */
  readonly correct?: () => Promise<void>;
}

/** A classified finding still paired with its correction. */
interface ClassifiedEntry {
  readonly classified: ClassifiedFinding;
  readonly correct?: () => Promise<void>;
}

export interface ReconciliationRunResult {
  readonly runId: string;
  readonly accountLabel: string;
  readonly at: Timestamp;
  readonly findings: readonly ClassifiedFinding[];
  /** The worst tier seen, or null for a clean run. */
  readonly tier: DriftClassification | null;
  readonly haltedBotIds: readonly string[];
  readonly circuitBreakerTripped: boolean;
  /** Human-readable descriptions of what was auto-corrected. */
  readonly autoCorrections: readonly string[];
  /** `alerts.id`s written by step 6 that this run consumed and resolved. */
  readonly consumedAlertIds: readonly string[];
  /**
   * What could not be checked, and why.
   *
   * Section 5.6: an unreachable exchange is not data. A run that could not read
   * the balances reports that here rather than concluding they are unchanged.
   */
  readonly skipped: readonly string[];
}

// ---------------------------------------------------------------------------

export async function reconcileAccount(
  ports: ReconciliationPorts,
  accountLabel: string,
): Promise<ReconciliationRunResult> {
  const { db, newId } = ports;
  const thresholds = ports.thresholds ?? DEFAULT_DRIFT_THRESHOLDS;
  const runId = newId();
  const at = ports.now();

  const pending: PendingFinding[] = [];
  const skipped: string[] = [];

  const bots = await db.botInstances.findMany({
    where: { account_label: accountLabel, status: { in: [...RECONCILED_STATUSES] } },
  });
  const botIds = bots.map((bot) => bot.id);

  // 1. Read what step 6 already wrote and nothing has ever read.
  pending.push(...(await ingestBotAlerts(db, botIds)));

  // 2. Orders: the Durable Objects, D1, and the exchange, three ways.
  const snapshots = new Map<string, BotSnapshot>();
  pending.push(
    ...(await reconcileOrders(ports, accountLabel, bots, snapshots, skipped, thresholds)),
  );

  // 3. Balances, per asset, as a delta from the previous run.
  pending.push(...(await reconcileBalances(ports, accountLabel, bots, runId, at, skipped)));

  // 4. Step 5's open question 2: does the ledger agree with the bot rows?
  pending.push(...(await reconcileAllocations(db, accountLabel)));

  // 5. Classify. Kind sets the floor, magnitude only escalates.
  //
  // `classifyAll` maps, so its output is index-aligned with its input. Pairing
  // each classified finding back with its correction here means `act` never
  // has to look one up, which is the kind of lookup that silently matches the
  // wrong entry the first time two findings look alike.
  const findings = classifyAll(
    pending.map((entry) => entry.finding),
    thresholds,
  );
  const entries: ClassifiedEntry[] = findings.map((classified, index) => ({
    classified,
    correct: pending[index]!.correct,
  }));
  const tier = highestTier(findings);

  // 6. Act.
  const outcome = await act(ports, accountLabel, runId, at, entries);

  // 6b. Close standing alerts whose finding did not recur -- the other half of
  // the one-row-per-incident lifecycle `raiseStandingAlert` introduces. Gated on
  // the pass having actually READ something: a run that skipped its exchange
  // reads saw no findings because it saw nothing, and treating that as "resolved"
  // would clear a live incident on the strength of an outage (section 5.6).
  await resolveClearedAlerts(db, accountLabel, findings, skipped.length === 0, botIds);

  await db.auditLog.insert({
    id: newId(),
    actor: "reconciliation",
    action: "reconciliation.run",
    target_bot_instance_id: null,
    details_json: {
      run_id: runId,
      account_label: accountLabel,
      tier,
      findings: findings.map((finding) => ({
        kind: finding.kind,
        tier: finding.tier,
        floor: finding.floor,
        escalated: finding.escalated,
        bot_instance_id: finding.botInstanceId,
        asset: finding.asset,
        detail: finding.detail,
        // STRUCTURED, and load-bearing rather than decorative: this is what a
        // later run matches on to escalate an unconfirmed live-order drift.
        client_order_id: finding.clientOrderId ?? null,
        // Structured for the same reason, and read back by the same scan: it
        // is how a later run recognises the SAME status disagreement.
        status_pair: finding.statusPair ?? null,
        source_alert_id: finding.sourceAlertId ?? null,
      })),
      halted: outcome.haltedBotIds,
      circuit_breaker_tripped: outcome.circuitBreakerTripped,
      auto_corrections: outcome.autoCorrections,
      consumed_alert_ids: outcome.consumedAlertIds,
      skipped,
    },
    created_at: at,
  } satisfies AuditLogRow);

  return {
    runId,
    accountLabel,
    at,
    findings,
    tier,
    haltedBotIds: outcome.haltedBotIds,
    circuitBreakerTripped: outcome.circuitBreakerTripped,
    autoCorrections: outcome.autoCorrections,
    consumedAlertIds: outcome.consumedAlertIds,
    skipped,
  };
}

// ---------------------------------------------------------------------------
// Standing alerts: one row per open incident, not one per detection
// ---------------------------------------------------------------------------

/**
 * This module's `source`. Scopes BOTH halves of the standing-alert lifecycle,
 * so reconciliation deduplicates against, and resolves, only its own rows.
 */
const RECONCILIATION_SOURCE = "reconciliation";

/**
 * A CEILING ON THE SCAN, NOT A BOUND ON IT. The bound is the `created_at`
 * predicate in the query below; this only stops a pathological `audit_log` from
 * being read into memory wholesale.
 *
 * THE NAME IS LOAD-BEARING. The previous one -- `RECENT_RUN_SCAN` -- read as
 * "how far back we look", and that misreading is exactly what produced the
 * defect this value was raised to close. `audit_log` has no account column, so
 * the account filter is a POST-filter in JavaScript while `LIMIT` is applied in
 * SQL across every account's rows. One cron tick writes ONE ROW PER ACCOUNT, so
 * at the old value of 20 an eleventh account pushed this account's previous run
 * out of the scan, `alreadySeen` was permanently false, and nothing ever
 * escalated -- silently, because a minor finding raises no alert row by design.
 *
 * THE HEADROOM ARITHMETIC. Rows inside the window are
 * `accounts x (unconfirmedWindowMs / cron interval)` = `accounts x (600s / 300s)`
 * = `2 x accounts`. At 500 this supports 250 accounts, against the ~10 the old
 * value did. `reconcile.test.ts` pins that relationship, so raising the account
 * count past what this supports fails the suite rather than failing in
 * production.
 */
export const RECENT_RUN_SCAN_CAP = 500;

/**
 * Raise a finding's alert ONCE per open incident.
 *
 * The mechanism itself now lives in `/src/alerts/standing.ts`, because step 20's
 * 30-second `BotInstance` poll is a second writer that re-detects conditions on
 * a schedule and needs the identical lifecycle -- not a parallel one that could
 * drift from this one. Read that file's header for why an unconditional insert
 * is wrong for a re-detected condition (the measured 186 identical criticals in
 * four hours), why the message is not part of the key, and why the notification
 * cooldown is untouched. What stays here is only what is reconciliation's:
 * every finding it raises is `critical` / `trading`.
 */
async function raiseFindingAlert(
  db: Database,
  newId: () => string,
  alert: {
    alertType: string;
    botInstanceId: string | null;
    message: string;
    at: Timestamp;
  },
): Promise<void> {
  await raiseStandingAlert(db, newId, {
    alertType: alert.alertType,
    botInstanceId: alert.botInstanceId,
    severity: "critical",
    category: "trading",
    source: RECONCILIATION_SOURCE,
    message: alert.message,
    at: alert.at,
  });
}

/**
 * Close standing alerts whose finding did NOT recur on this pass.
 *
 * The other half of the incident lifecycle, and it must never be separated from
 * the raise: deduplicating without it would leave one row that never clears and
 * suppresses every future alert of that kind for that bot, forever.
 *
 * What this function contributes is reconciliation's own three answers to the
 * shared mechanism's questions -- which rows it OWNS (only the ones its
 * `reconciliation_{tier}_{kind}` scheme produced: `reconciliation_blind`,
 * `reconciliation_halt_failed` and `orphaned_bot_row` are this module's too but
 * have their own lifecycles), which are IN SCOPE (this account's bots), and
 * whether the pass actually OBSERVED anything. That last one is section 5.6
 * applied to the alert lifecycle and is passed in rather than inferred, because
 * "found nothing" and "saw nothing" are indistinguishable from inside.
 */
async function resolveClearedAlerts(
  db: Database,
  accountLabel: string,
  findings: readonly ClassifiedFinding[],
  observed: boolean,
  botIds: readonly string[],
): Promise<void> {
  // Built through the same two functions the raise side uses, so the key this
  // compares against cannot drift from the `alert_type` actually written. A
  // `minor` finding raises no row, so it can never match one and is skipped.
  const stillOpen = new Set(
    findings
      .filter((finding) => finding.tier !== "minor")
      .map((finding) =>
        standingAlertKey(
          reconciliationAlertType(finding.tier as AlertingTier, finding.kind),
          finding.botInstanceId,
        ),
      ),
  );

  await resolveClearedStandingAlerts(db, {
    source: RECONCILIATION_SOURCE,
    owns: isReconciliationAlertType,
    stillOpen,
    observed,
    scope: { kind: "account", botInstanceIds: botIds },
  });
}

// ---------------------------------------------------------------------------
// 1. Closing step 6's loop
// ---------------------------------------------------------------------------

/**
 * Turn unresolved alerts written by step 6 into findings.
 *
 * This is the read side of the loop step 6's deviations flagged: "section 9's
 * reconciliation is relied on by three paths here and does not exist yet.
 * Those alerts currently go into a table nobody reads automatically."
 *
 * Ingested findings carry NO magnitude, deliberately. The alert's payload is
 * prose in `message`, and re-deriving a number by parsing that prose would be
 * a guess wearing a threshold's authority. They classify by kind alone -- which
 * is exactly the case the kind-floor rule exists to handle, and it means
 * `unknown_order_fill` reaches severe without any number being involved.
 */
async function ingestBotAlerts(db: Database, botIds: readonly string[]): Promise<PendingFinding[]> {
  if (botIds.length === 0) return [];

  const rows = await db.alerts.findMany({
    where: {
      bot_instance_id: { in: [...botIds] },
      alert_type: { in: Object.keys(INGESTED_ALERT_TYPES) },
      resolved: false,
    },
    orderBy: [{ column: "created_at", direction: "asc" }],
  });

  return rows.map((row) => {
    const kind = INGESTED_ALERT_TYPES[row.alert_type]!;
    return {
      finding: {
        kind,
        // An unattributable fill is an account-level event even though step 6
        // recorded it against the bot that noticed it.
        scope: kind === "unknown_order_fill" ? "account" : "bot",
        botInstanceId: row.bot_instance_id,
        asset: null,
        detail: `raised by ${row.source} at ${row.created_at}: ${row.message}`,
        sourceAlertId: row.id,
      } satisfies Finding,
    };
  });
}

// ---------------------------------------------------------------------------
// 2. Orders
// ---------------------------------------------------------------------------

async function reconcileOrders(
  ports: ReconciliationPorts,
  accountLabel: string,
  bots: readonly BotInstanceRow[],
  snapshots: Map<string, BotSnapshot>,
  skipped: string[],
  thresholds: DriftThresholds,
): Promise<PendingFinding[]> {
  const { db, exchange, now } = ports;
  const pending: PendingFinding[] = [];
  const at = now();

  // ONCE PER RUN, not per bot: one query answers it for every bot on the
  // account, and the escalation is a property of the run rather than of any one
  // order's evaluation.
  const seenUnconfirmed = await unconfirmedDriftFromRecentRuns(
    db,
    accountLabel,
    at,
    thresholds.unconfirmedWindowMs,
  );

  // One call per distinct pair, not per bot: several bots can share a pair.
  const openOrdersByPair = new Map<Pair, OrderStatus[] | null>();

  for (const bot of bots) {
    const snapshot = await ports.snapshotBot(bot.id);
    if (snapshot === null) {
      // Step 6's open question 6: capital reserved and the bot row written,
      // then a crash before the object's own storage. There is no belief to
      // compare against, so this is not drift in any of section 9's three
      // senses -- it is a bot that never finished being born. Reported as a
      // system alert rather than forced into a tier it does not fit.
      skipped.push(
        `bot ${bot.id}: the bot_instances row exists but its Durable Object holds ` +
          `no state (step 6, open question 6). Nothing to reconcile against.`,
      );
      await db.alerts.insert({
        id: ports.newId(),
        severity: "warning",
        category: "system",
        alert_type: "orphaned_bot_row",
        bot_instance_id: bot.id,
        source: "reconciliation",
        message:
          `bot ${bot.id} has a bot_instances row with status ${bot.status} but its ` +
          `Durable Object holds no configuration. Capital is reserved for a bot that ` +
          `cannot trade; recovery is manual.`,
        resolved: false,
        created_at: at,
        notified_at: null,
      } satisfies AlertRow);
      continue;
    }
    snapshots.set(bot.id, snapshot);

    if (!openOrdersByPair.has(bot.pair)) {
      const outcome = await exchange.getOpenOrders(bot.pair);
      if (!isUsable(outcome)) {
        // Section 5.6. An unreachable exchange is not evidence that there are
        // no open orders, and concluding otherwise here would raise a
        // meaningful finding for every live order and halt every bot on the
        // pair.
        openOrdersByPair.set(bot.pair, null);
        skipped.push(
          `open orders for ${bot.pair}: ${outcome.kind} ${outcome.message}. ` +
            `Order reconciliation skipped for this pair.`,
        );
      } else {
        openOrdersByPair.set(bot.pair, outcome.value);
      }
    }

    const remoteOpen = openOrdersByPair.get(bot.pair) ?? null;
    const d1Orders = await db.orders.findMany({ where: { bot_instance_id: bot.id } });

    pending.push(...mirrorFindings(db, bot, snapshot, d1Orders));
    // The bot-level counterpart of `mirrorFindings`, and it sits here rather
    // than in its own pass so it reads the snapshot this loop already fetched:
    // the comparison costs no extra cross-object RPC on the ordinary run where
    // the two stores agree.
    pending.push(...(await botStatusFindings(ports, bot, snapshot, seenUnconfirmed)));
    pending.push(...uncoveredInventoryFindings(bot, snapshot));

    if (remoteOpen !== null) {
      pending.push(
        ...(await liveOrderFindings(ports, bot, snapshot, remoteOpen, seenUnconfirmed)),
      );
    }
  }

  // Attribution runs once per pair over every order the exchange reports, not
  // per bot, so an order belonging to no bot is found exactly once.
  pending.push(...unknownOrderFindings(openOrdersByPair, bots, snapshots));

  return pending;
}

/**
 * A grid bot holding base with no sell resting against any of it.
 *
 * WHAT THIS CATCHES, and why nothing else did. Section 6.2 step 3 is the only
 * thing that ever puts a sell on a grid ladder: a buy fills, and its
 * replacement sell goes one rung up. If that replacement is never placed, the
 * base the buy acquired stays held with no order that would ever sell it, and
 * `decide` will not repair it -- it places a ladder only while `placed` is
 * false, so an incomplete ladder stays incomplete for the life of the bot.
 *
 * Every number remains correct while this is true, which is exactly why it
 * needed its own detector. The position is right, the cost basis is right, the
 * realized profit is right, D1 agrees with the object, and the exchange agrees
 * with both. Every existing check compares two records that DO match. What is
 * wrong is not a disagreement at all -- it is an absence, and only the ladder's
 * own shape reveals it.
 *
 * MANY WAYS TO REACH IT, and no count is given here on purpose. This said "TWO
 * WAYS" and named the `claimSlot` slot collision and `applyMissedFills`; an
 * investigation into two live bots then found three more, one of which -- a buy
 * filling in several executions, where replace-on-fill sized the sell from the
 * final execution alone -- was not an edge case at all but the ORDINARY path,
 * needing no cancellation, no collision and no repair to fire. The specific
 * routes have been closed since (see `acquisitionOf` in `strategies/grid.ts`,
 * and the replacement queue in `bot-instance.ts`), but the lesson is the count:
 * an exhaustive list here was wrong within weeks of being written and read as
 * authoritative while it was wrong.
 *
 * So this detector is deliberately CAUSE-BLIND. It asks one question of the
 * ladder's own shape -- is more base held than resting sells cover -- and that
 * question stays correct however the gap arrived, including by routes nobody
 * has thought of yet. It is a standing condition worth detecting on its own,
 * not a regression test for any particular defect. `applyMissedFills` remains
 * the one route that is BY DESIGN: it folds fills on a halted bot with
 * `placeReplacement: false` and honestly leaves the rungs empty.
 *
 * RUNS ON A HALTED BOT TOO, which is a reversal of what this used to do and of
 * the reasoning that went with it: "its ladder has been swept on purpose and a
 * human is already the one holding it." Both halves proved false in practice. A
 * halt sweep cancels orders; it does not sell what the bot already holds, so
 * uncovered base survives the halt exactly as it was. And "a human is holding
 * it" assumed the human had been told -- but this was the only thing that would
 * have told them, and skipping halted bots is precisely why two of them sat
 * uncovered and unreported. Detection is cheap and silence was not.
 *
 * DETECTION ONLY, on a halted bot as on a running one. Section 9's standing
 * rule is unchanged: reconciliation halts and alerts and never auto-corrects.
 * The meaningful tier's action is `haltBot`, and `halt` is idempotent -- an
 * already-halted bot returns `already_halted` and changes nothing -- so a
 * halted bot found here gains an alert and nothing else. Nothing is cancelled,
 * nothing is placed. Repairing the ladder is a separate, human-triggered
 * action.
 *
 * `stopped` is not a case here: `RECONCILED_STATUSES` excludes it upstream, so
 * no snapshot of one ever reaches this. Still silent when a liquidation is live
 * (`exitOrderId`), because that sell is precisely the cover this looks for.
 */
function uncoveredInventoryFindings(
  bot: BotInstanceRow,
  snapshot: BotSnapshot,
): PendingFinding[] {
  const ladder = snapshot.state.ladder;
  if (ladder === undefined) return []; // Not a grid bot.
  if (snapshot.state.exitOrderId !== null) return [];
  if (ladder.heldQuantity <= ZERO) return [];

  const restingSell = ladder.slots.reduce(
    (total, slot) => (slot !== null && slot.side === "sell" ? total + slot.quantity : total),
    ZERO,
  );
  if (restingSell >= ladder.heldQuantity) return [];

  const uncovered = ladder.heldQuantity - restingSell;
  const queued = snapshot.state.pendingReplacements ?? [];
  return [
    {
      finding: {
        kind: "uncovered_held_inventory",
        scope: "bot",
        botInstanceId: bot.id,
        asset: null,
        detail:
          `grid bot ${bot.id} holds ${toDecimalString(ladder.heldQuantity)} base on ${bot.pair} ` +
          `with only ${toDecimalString(restingSell)} covered by resting sells -- ` +
          `${toDecimalString(uncovered)} has no sell against it. Section 6.2's replace-on-fill is ` +
          `the only thing that places a grid sell, and it does not re-run for a rung already ` +
          `missed, so this will not correct itself. ` +
          (queued.length > 0
            ? `${queued.length} replacement(s) are queued waiting for their level to free up, so ` +
              `this may clear on its own within a poll or two.`
            : `Nothing is queued to place one.`),
      },
    },
  ];
}

/**
 * D1 versus the object's own snapshot.
 *
 * Every disagreement here is between two of THIS system's own stores, so the
 * exchange has no opinion on it and nothing is at risk on the exchange. Step
 * 6's deliberate write ordering -- object storage first, D1 second -- makes a
 * lagging mirror the expected result of a crash, which is why section 9's
 * minor tier fits it exactly.
 */
function mirrorFindings(
  db: Database,
  bot: BotInstanceRow,
  snapshot: BotSnapshot,
  d1Orders: readonly OrderRow[],
): PendingFinding[] {
  const pending: PendingFinding[] = [];
  const byId = new Map(d1Orders.map((row) => [row.id, row]));

  for (const local of snapshot.orders) {
    const row = byId.get(local.clientOrderId);

    if (row === undefined) {
      // Not correctable from here: an `orders` row needs `exchange_order_id`,
      // which the object's TrackedOrder does not carry, and inventing one
      // would put a fabricated value in a column reconciliation itself reads.
      // Raised as meaningful rather than minor, because a minor finding nobody
      // can auto-correct would be silent by construction.
      pending.push({
        finding: {
          kind: "order_state_drift",
          scope: "bot",
          botInstanceId: bot.id,
          asset: null,
          detail:
            `order ${local.clientOrderId} exists in the Durable Object but has no ` +
            `row in D1. It cannot be recreated here without fabricating ` +
            `exchange_order_id, so it needs a human.`,
        },
      });
      continue;
    }

    if (row.status === local.state && row.filled_quantity === local.filledQuantity) continue;

    pending.push({
      finding: {
        kind: "mirror_drift",
        scope: "bot",
        botInstanceId: bot.id,
        asset: null,
        detail:
          `D1 mirror for ${local.clientOrderId} says ${row.status} / ` +
          `${toDecimalString(row.filled_quantity)} filled; the Durable Object says ` +
          `${local.state} / ${toDecimalString(local.filledQuantity)}. The object is ` +
          `the source of truth (section 8.1), so the mirror is corrected from it.`,
        // No magnitude, deliberately. See `Magnitude.reference`: the only
        // denominator available here is this order's own quantity, and a
        // mirror lagging by a whole order -- the ordinary result of a crash
        // between step 6's two writes -- would then read as a 100% divergence
        // and escalate. It is section 9's canonical minor case.
      },
      correct: async () => {
        await db.orders.update(
          { id: local.clientOrderId },
          {
            status: local.state,
            filled_quantity: local.filledQuantity,
            updated_at: local.updatedAt,
          },
        );
      },
    });
  }

  return pending;
}

/**
 * D1's `bot_instances.status` against the object's own `state.status`.
 *
 * THE GAP THIS CLOSES. `mirrorFindings` above compares this system's two stores
 * ORDER BY ORDER and has never compared the bot's own status, and nothing else
 * did either: before this function, `snapshot.state.status` was read by nothing
 * outside the Durable Object itself. Live testnet bot `bot-gvtr1a` sat with
 * `bot_instances.status = 'halted'` while its object said `running` --
 * subscribed to its price feed, receiving prices, and INVISIBLE to both
 * emergency stops, because the global kill switch and the account circuit
 * breaker each select their targets with `status IN ('created','running')`.
 * Reconciliation held both values in hand on every pass and compared neither.
 * See `docs/open-items/resume-split-brain.md`.
 *
 * ── WHY BOTH DIRECTIONS ARE CONFIRMED ACROSS TWO RUNS, INCLUDING THE SAFE ONE ──
 *
 * The design this was built from had the safe polarity (object not running, D1
 * says running) auto-correct on FIRST sighting, on the reasoning that it is
 * only a stale mirror and `mirror_drift` corrects those immediately. Building
 * it showed that to be wrong, and dangerously so.
 *
 * `#resumePass` now writes D1 FIRST and the object second (step 3a). So a
 * perfectly healthy resume, caught by this job in the window between its two
 * writes, presents as EXACTLY the safe polarity: the row already says
 * `running`, the object still says `halted`. Correcting the row "back" to
 * `halted` there would overwrite a live human resume -- and the object would
 * then finish its own write and become `running`, leaving `running`/`halted`:
 * the dangerous state, MANUFACTURED BY THE DETECTOR out of a healthy
 * transition. The one thing this function exists to find, it would have
 * created.
 *
 * So neither direction acts on a first sighting. Both are recorded as
 * `bot_status_unconfirmed` and both need the same disagreement, in the same
 * direction, on a later run. The status pair is part of the memory key, so a
 * bot that flapped between two different disagreements never confirms either.
 *
 * ── AND BOTH ARE RE-VERIFIED IMMEDIATELY BEFORE ACTING ──
 *
 * `bots` is read once at the top of a run and each snapshot later, so by the
 * time a disagreement is confirmed both halves are already old. Confirming
 * re-reads BOTH -- the row and the object -- and drops the finding entirely if
 * they now agree or now disagree differently. What remains unclosed, and is
 * stated rather than papered over: `act()` runs after every finding is
 * collected and classified, so a transition landing in THAT gap is still
 * possible. It is bounded by having to have presented the identical
 * disagreement a full run earlier, which a transition in flight cannot do.
 */
async function botStatusFindings(
  ports: ReconciliationPorts,
  bot: BotInstanceRow,
  snapshot: BotSnapshot,
  seenUnconfirmed: UnconfirmedMemory,
): Promise<PendingFinding[]> {
  const { db } = ports;
  const observed = statusPairOf(bot.status, snapshot.state.status);
  if (observed === null) return [];

  const key = `${bot.id}::${observed}`;
  if (!seenUnconfirmed.has("bot_status_unconfirmed", key)) {
    return [
      {
        finding: {
          kind: "bot_status_unconfirmed",
          scope: "bot",
          botInstanceId: bot.id,
          asset: null,
          statusPair: observed,
          detail:
            `bot ${bot.id}: D1 says ${bot.status}, its Durable Object says ` +
            `${snapshot.state.status}. First sighting -- a status transition writes those two ` +
            `stores one after the other, so one in flight across this run's two reads looks ` +
            `exactly like this. Recorded, not acted on; a later run that finds the same ` +
            `disagreement escalates it.`,
        },
      },
    ];
  }

  // Confirmed by a previous run. Re-read both halves before doing anything.
  const [fresh, freshSnapshot] = await Promise.all([
    db.botInstances.findOne({ id: bot.id }),
    ports.snapshotBot(bot.id),
  ]);
  if (fresh === null || freshSnapshot === null) return [];
  // A row that reached `stopped` between the two reads belongs to
  // `releaseBotCapital` alone -- its capital is released and `#mirrorStatus`
  // refuses to write over it for the same reason. Nothing to reconcile.
  if (fresh.status === "stopped") return [];
  const current = statusPairOf(fresh.status, freshSnapshot.state.status);
  if (current !== observed) return [];

  // THE DANGEROUS DIRECTION: the object is live and the row hides it from both
  // emergency stops. Halt it -- which cancels its resting orders, mirrors the
  // row, alerts and audits, and does NOT liquidate: the position is preserved
  // for a human, exactly as a kill-switch halt preserves one.
  if (freshSnapshot.state.status === "running") {
    return [
      {
        finding: {
          kind: "bot_status_drift",
          scope: "bot",
          botInstanceId: bot.id,
          asset: null,
          statusPair: current,
          detail:
            `bot ${bot.id} believes it is RUNNING while D1 says ${fresh.status}. Confirmed ` +
            `across two runs. Both emergency stops select bots to halt by reading D1 for ` +
            `created/running, so this bot is live and invisible to the global kill switch and ` +
            `to its account's circuit breaker. Halting it converges both stores; its position ` +
            `is left untouched for review.`,
        },
      },
    ];
  }

  // THE SAFE DIRECTION: nothing trades on the row, but it lies to every human
  // and every query that reads it. Correct it FROM the object (section 8.1),
  // and NEVER the other way -- resuming a bot because a mirror said so would
  // put it back to trading on no human's decision.
  const objectStatus = freshSnapshot.state.status;
  return [
    {
      finding: {
        kind: "bot_status_mirror_stale",
        scope: "bot",
        botInstanceId: bot.id,
        asset: null,
        statusPair: current,
        detail:
          `bot ${bot.id}: D1 says ${fresh.status}, the object says ${objectStatus}. Confirmed ` +
          `across two runs. The object is the source of truth (section 8.1), so the row is ` +
          `corrected from it. The object is NOT touched -- a stale mirror is never a reason ` +
          `to put a bot back to trading.`,
      },
      correct: async () => {
        // Conditional on the row still saying what it said, so a transition
        // landing between the re-read above and this write loses the race
        // rather than being overwritten by it. `#mirrorStatus`'s own
        // `ne: "stopped"` guard is preserved for the same reason it exists
        // there: a released bot's status belongs to `releaseBotCapital` alone.
        await db.botInstances.update(
          { id: bot.id, status: fresh.status },
          {
            status: objectStatus,
            halt_reason: freshSnapshot.state.haltReason,
            halted_at: freshSnapshot.state.haltedAt,
            updated_at: ports.now(),
          },
        );
      },
    },
  ];
}

/** `"<d1>/<object>"`, or null when the two agree. */
function statusPairOf(d1Status: string, objectStatus: string): string | null {
  return d1Status === objectStatus ? null : `${d1Status}/${objectStatus}`;
}

/**
 * Live orders this account's own RECENT RUNS already reported as an unconfirmed
 * disagreement, as `${botInstanceId}::${clientOrderId}`.
 *
 * THE ASYMMETRY THIS EXISTS TO CLOSE. Two observers watch the same order at
 * different cadences: the owning bot polls it every THIRTY SECONDS, this job
 * looks every FIVE MINUTES. The LIVE branch originally forgave nothing, so a
 * fill that landed between two poll passes was reported as meaningful drift and
 * halted the bot, for a disagreement the poll would have cleared seconds later
 * by its real fill id. That is what halted two real bots.
 *
 * The terminated-order branch forgave the same gap with a 60-second window
 * measured against the venue's own `updatedAt`. That window is GONE: it could
 * only work on a venue that reported a real transition time, it inverted into an
 * immediate halt whenever a venue's clock ran fast, and it made the safety
 * outcome depend on per-venue payload quality. Both branches now share THIS
 * memory, so there is one mechanism and one bound for every exchange.
 *
 * WHY THE MEMORY LIVES IN `audit_log` AND NOT SOMEWHERE NEW. This job is
 * structurally BLIND to the other observer: `BotSnapshot` carries `config`,
 * `state` and `orders`, and the poll's schedule lives under its own storage key
 * inside the Durable Object, so nothing here can ask when that bot last polled
 * or whether its poll is even healthy. What this job does have is its own
 * history -- every run already writes its complete findings list to
 * `audit_log.details_json`, which `/src/alerts/standing.ts` names as the reason
 * the alerts table may be deduplicated at all. Reading it back makes the record
 * and the memory the same object, with no new table, no new column and no new
 * alert type.
 *
 * A minor finding is deliberately enough to remember with: it is written to that
 * findings list like any other, while raising no alert row and halting nothing.
 *
 * ── GENERALISED AT STEP 3b, from one hard-coded kind to a table ──
 *
 * This scan read exactly one kind (`order_drift_unconfirmed`) and required a
 * `client_order_id`, because an order was the only thing that had ever needed
 * confirming twice. The bot-status comparison needs the identical mechanism
 * keyed on something else, and the choice was one generalised reader or a
 * second parallel one. It is one, deliberately: two readers would mean two
 * audit-log scans per run for one question, two places to keep the recorded
 * finding shape in step with, and the standing risk that a later fix to the
 * window or the row cap lands on only one of them. `CONFIRMABLE_KINDS` is now
 * the single place naming which kinds confirm across runs and how each one says
 * "the same condition" -- adding a third is one entry, and the `satisfies`
 * ties every key to a real `FindingKind`.
 */

/** One finding as `reconcileAccount` records it into `audit_log.details_json`. */
interface RecordedFinding {
  readonly kind?: unknown;
  readonly bot_instance_id?: unknown;
  readonly client_order_id?: unknown;
  readonly status_pair?: unknown;
}

/**
 * The kinds that participate in run-to-run confirmation, and how each one
 * identifies the same condition across two runs.
 *
 * A `null` key means this recorded finding cannot be matched (a field the kind
 * needs is missing from an older audit row), which is treated as "not seen
 * before" -- the direction that costs an extra run rather than an unearned
 * escalation.
 */
const CONFIRMABLE_KINDS = {
  order_drift_unconfirmed: (finding: RecordedFinding): string | null =>
    typeof finding.bot_instance_id === "string" && typeof finding.client_order_id === "string"
      ? `${finding.bot_instance_id}::${finding.client_order_id}`
      : null,
  bot_status_unconfirmed: (finding: RecordedFinding): string | null =>
    typeof finding.bot_instance_id === "string" && typeof finding.status_pair === "string"
      ? `${finding.bot_instance_id}::${finding.status_pair}`
      : null,
} satisfies Record<string, (finding: RecordedFinding) => string | null> &
  Partial<Record<FindingKind, unknown>>;

type ConfirmableKind = keyof typeof CONFIRMABLE_KINDS;

/** What a run remembers of the runs before it. */
interface UnconfirmedMemory {
  has(kind: ConfirmableKind, key: string): boolean;
}

async function unconfirmedDriftFromRecentRuns(
  db: Database,
  accountLabel: string,
  at: Timestamp,
  windowMs: number,
): Promise<UnconfirmedMemory> {
  const seen = new Map<ConfirmableKind, Set<string>>();
  for (const kind of Object.keys(CONFIRMABLE_KINDS) as ConfirmableKind[]) {
    seen.set(kind, new Set<string>());
  }
  const rows = await db.auditLog.findMany({
    // THE TIME BOUND IS HERE, IN SQL, and this is the only thing that bounds
    // how far back the memory reaches. It used to be a `break` in the loop
    // below, which could not work: `LIMIT` is applied AFTER `WHERE` and AFTER
    // `ORDER BY`, so a tick writing one row per account exhausted the row
    // budget on the current tick before the loop ever reached a prior one.
    //
    // It is also cheaper than what it replaces. There is no index on `action`
    // (`migrations/0001_initial_schema.sql` indexes `created_at`,
    // `target_bot_instance_id` and `actor`), so the old query walked
    // `created_at` backwards filtering on `action` until it accumulated enough
    // matches, unbounded in how far it could walk. This is a bounded index
    // range.
    where: { action: "reconciliation.run", created_at: { gte: at - windowMs } },
    orderBy: [{ column: "created_at", direction: "desc" }],
    limit: RECENT_RUN_SCAN_CAP,
  });

  for (const row of rows) {
    const details = row.details_json as {
      account_label?: unknown;
      findings?: readonly RecordedFinding[];
    };
    if (details.account_label !== accountLabel) continue;
    for (const finding of details.findings ?? []) {
      const kind = finding.kind;
      if (typeof kind !== "string" || !(kind in CONFIRMABLE_KINDS)) continue;
      const key = CONFIRMABLE_KINDS[kind as ConfirmableKind](finding);
      if (key !== null) seen.get(kind as ConfirmableKind)!.add(key);
    }
  }
  return { has: (kind, key) => seen.get(kind)?.has(key) === true };
}

/** Orders the object believes are live, against what the exchange reports. */
async function liveOrderFindings(
  ports: ReconciliationPorts,
  bot: BotInstanceRow,
  snapshot: BotSnapshot,
  remoteOpen: readonly OrderStatus[],
  seenUnconfirmed: UnconfirmedMemory,
): Promise<PendingFinding[]> {
  const pending: PendingFinding[] = [];
  const localById = new Map(snapshot.orders.map((order) => [order.clientOrderId, order]));
  const remoteById = new Map(remoteOpen.map((order) => [order.clientOrderId, order]));

  for (const clientOrderId of snapshot.state.openOrderIds) {
    const local = localById.get(clientOrderId);
    if (local === undefined) {
      pending.push({
        finding: {
          kind: "order_state_drift",
          scope: "bot",
          botInstanceId: bot.id,
          asset: null,
          detail:
            `the bot lists ${clientOrderId} as open but holds no order record for ` +
            `it; its own state is internally inconsistent`,
        },
      });
      continue;
    }

    const remote = remoteById.get(clientOrderId);
    if (remote !== undefined) {
      // STILL ON THE BOOK, so the owning bot's own poll is still armed on it and
      // will read it again within thirty seconds. A first sighting is reported
      // as UNCONFIRMED -- logged, no alert, no halt -- and only a disagreement
      // this account's runs have already seen inside `unconfirmedWindowMs`
      // becomes real drift. Escalation is unconditional at that point: see
      // `unconfirmedDriftFromRecentRuns` for why waiting is bounded and why it
      // cannot become "never halts".
      const alreadySeen = seenUnconfirmed.has("order_drift_unconfirmed", `${bot.id}::${clientOrderId}`);
      pending.push(
        ...driftAgainst(
          bot,
          local,
          remote,
          alreadySeen
            ? `still disagreeing on a later run, so the bot's own 30s poll has not resolved it`
            : "",
          alreadySeen ? "order_state_drift" : "order_drift_unconfirmed",
        ),
      );
      continue;
    }

    // Believed open, not on the book. Ask what became of it rather than
    // assuming: "absent from open orders" is filled, cancelled, expired or
    // rejected, and those are four different situations.
    const outcome = await ports.exchange.getOrderStatus(bot.pair, clientOrderId);
    if (!isUsable(outcome)) {
      pending.push({
        finding: {
          kind: "order_state_drift",
          scope: "bot",
          botInstanceId: bot.id,
          asset: null,
          detail:
            `${clientOrderId} is not among the exchange's open orders and its status ` +
            `could not be read (${outcome.kind}: ${outcome.message}), so what happened ` +
            `to it is unknown`,
        },
      });
      continue;
    }

    const status = outcome.value;

    // VENUE CLOCKS MAY INFORM RECORDS, NEVER DECISIONS. Whether this bot halts
    // over a terminated order does not read `updatedAt` on any venue -- there is
    // no branch on whether the payload brought a clock, and no age arithmetic
    // anywhere in this function. `liveOrderFindings` takes no `at` and no
    // `thresholds` precisely so that this is enforced by the compiler rather
    // than by convention: reintroducing a timestamp comparison here means first
    // re-plumbing a clock into the signature, which is a visible, reviewable act
    // instead of a one-line slip.
    //
    // WHY "HOW LONG AGO DID THIS TERMINATE" IS NOT ASKED AT ALL. Both ways of
    // answering it were evaluated and rejected, because they fail in opposite
    // directions and each is worse than the other's failure:
    //
    //  - order-CREATION time (what Gemini's parser used to fabricate, and what
    //    Binance's parser still falls back to): `age` is the order's whole life,
    //    so the window NEVER applies to anything older than a minute and the
    //    tolerance is dead on the venue;
    //  - RECEIPT time: `age` is always ~0, so the window ALWAYS applies, which
    //    would silence real, persistent drift on every terminated order,
    //    unconditionally. Strictly worse than the bug it would fix, because the
    //    bug is loud and this is silent.
    //
    // Neither works because both answer the question with a timestamp that does
    // not encode it. So the question is abandoned rather than re-answered, and
    // this uses the mechanism that needs no clock at all: THE SAME run-to-run
    // memory the live branch above uses, called the same way, reading the same
    // `seenUnconfirmed` set built by the same query. A first sighting is
    // `order_drift_unconfirmed` -- minor, no alert row, no halt, but written to
    // this run's findings list, which is what makes it remembered. A sighting
    // this account's runs have already seen inside `unconfirmedWindowMs`
    // escalates to `order_state_drift` and halts, unconditionally: no severity
    // check, no poll-health check, no retry budget.
    //
    // BOTH FAILURE MODES STAY CLOSED, now for every venue rather than one. It
    // cannot become "never applies", because a first sighting has no prior audit
    // row by construction and `order_drift_unconfirmed` has its ceiling PINNED
    // at minor, so magnitude cannot promote it. It cannot become "always
    // applies", because the second sighting escalates with nothing gating it.
    // (The third road into "never applies" was through the MEMORY rather than
    // the clock -- a row-limited scan that could not see a prior sighting once
    // enough accounts ticked between two runs. See `RECENT_RUN_SCAN_CAP`.)
    //
    // WHAT THIS COSTS, stated rather than elided: a genuine persistent drift now
    // halts AT MOST ONE ~5-MINUTE CYCLE LATER than the timestamp path did on a
    // venue that reported one -- never indefinitely, and never twice forgiven.
    // That is the identical trade step 61 made deliberately for the live branch,
    // on the evidence of two real bots halted for a disagreement their own 30s
    // poll was about to resolve.
    //
    // And an order that terminated and AGREES still produces no finding at all,
    // because `driftAgainst` returns empty on a match. The tolerance is about
    // disagreements only.
    const alreadySeenTerminated = seenUnconfirmed.has(
      "order_drift_unconfirmed",
      `${bot.id}::${clientOrderId}`,
    );
    pending.push(
      ...driftAgainst(
        bot,
        local,
        status,
        alreadySeenTerminated
          ? `it is no longer on the book, and still disagreeing on a later run, so the ` +
            `bot's own 30s poll has not resolved it`
          : `it is no longer on the book, and this is the first run to see it, so whether ` +
            `it terminated recently is decided by whether a later run still finds it`,
        alreadySeenTerminated ? "order_state_drift" : "order_drift_unconfirmed",
      ),
    );
  }

  return pending;
}

/**
 * `kind` is a parameter, and the default keeps the terminated-order caller
 * exactly as it was. The live-order caller passes `order_drift_unconfirmed` on a
 * first sighting -- same comparison, same prose, a tier that does not halt. The
 * ALTERNATIVE was a second copy of this function for the live branch, and two
 * independently-worded comparisons of the same two quantities is the drift step
 * 57 spent an entry refusing to introduce.
 */
function driftAgainst(
  bot: BotInstanceRow,
  local: TrackedOrder,
  remote: OrderStatus,
  context = "",
  kind: FindingKind = "order_state_drift",
): PendingFinding[] {
  const comparison = compareWithExchange(local, {
    state: remote.state,
    filledQuantity: remote.filledQuantity,
  });
  if (comparison.matches) return [];

  return [
    {
      finding: {
        kind,
        scope: "bot",
        botInstanceId: bot.id,
        asset: null,
        clientOrderId: local.clientOrderId,
        detail:
          `${local.clientOrderId}: the exchange reports ${remote.state} with ` +
          `${toDecimalString(remote.filledQuantity)} filled, the bot believes ` +
          `${local.state} with ${toDecimalString(local.filledQuantity)}` +
          (context === "" ? "" : ` (${context})`) +
          `. Delta ${toDecimalString(comparison.filledQuantityDelta)} of ` +
          `${toDecimalString(local.quantity)}.`,
        // No magnitude. Section 9 calls a position mismatch meaningful and
        // puts no size on it; the delta is in base units against an order
        // quantity, which is not a fraction of anything the severe tier is
        // about. The numbers are in `detail` for the human, not for the tier.
      },
    },
  ];
}

/**
 * Orders on the exchange that no bot on this account will claim.
 *
 * Section 9 lists "unexpected orders" under severe with no size qualifier, and
 * `TIER_FLOOR` honours that: this reaches severe by kind, so no threshold is
 * involved and no magnitude is attached.
 *
 * LIMITATION, stated rather than hidden: `RestExchangeClient.getOpenOrders`
 * takes a pair, so this can only see orders on pairs some bot on this account
 * already trades. An unexpected order on an untraded symbol is invisible to
 * this check. Widening it means changing section 4.1's interface, which is a
 * step 3 edit and was out of scope here.
 */
function unknownOrderFindings(
  openOrdersByPair: ReadonlyMap<Pair, OrderStatus[] | null>,
  bots: readonly BotInstanceRow[],
  snapshots: ReadonlyMap<string, BotSnapshot>,
): PendingFinding[] {
  const pending: PendingFinding[] = [];
  const knownBotIds = new Set(bots.map((bot) => bot.id));

  for (const [pair, orders] of openOrdersByPair) {
    if (orders === null) continue;

    for (const order of orders) {
      const parsed = parseClientOrderId(order.clientOrderId);

      if (parsed === null) {
        pending.push({
          finding: {
            kind: "unknown_open_order",
            scope: "account",
            botInstanceId: null,
            asset: null,
            detail:
              `open order ${order.clientOrderId} on ${pair} (exchange id ` +
              `${order.exchangeOrderId}, ${order.side} ${toDecimalString(order.quantity)} @ ` +
              `${toDecimalString(order.price)}) does not match this system's ` +
              `clientOrderId scheme at all. Something other than this bot placed it.`,
          },
        });
        continue;
      }

      if (!knownBotIds.has(parsed.botInstanceId)) {
        // Parses as ours but names a bot that is not active on this account.
        // Could be a bot closed while its order still rested; still severe,
        // because either way an order is live that nothing is managing.
        pending.push({
          finding: {
            kind: "unknown_open_order",
            scope: "account",
            botInstanceId: null,
            asset: null,
            detail:
              `open order ${order.clientOrderId} on ${pair} names bot ` +
              `${parsed.botInstanceId}, which is not an active bot on this account. ` +
              `The order is live and nothing is managing it.`,
          },
        });
        continue;
      }

      const snapshot = snapshots.get(parsed.botInstanceId);
      if (snapshot === undefined) continue; // Already reported as orphaned.

      const known = snapshot.orders.some(
        (candidate) => candidate.clientOrderId === order.clientOrderId,
      );
      if (!known) {
        pending.push({
          finding: {
            kind: "unknown_open_order",
            scope: "account",
            botInstanceId: null,
            asset: null,
            detail:
              `open order ${order.clientOrderId} on ${pair} names bot ` +
              `${parsed.botInstanceId}, which holds no record of placing it.`,
          },
        });
      }
    }
  }

  return pending;
}

// ---------------------------------------------------------------------------
// 3. Balances
// ---------------------------------------------------------------------------

async function reconcileBalances(
  ports: ReconciliationPorts,
  accountLabel: string,
  bots: readonly BotInstanceRow[],
  runId: string,
  at: Timestamp,
  skipped: string[],
): Promise<PendingFinding[]> {
  const { db, exchange, newId } = ports;

  const balancesOutcome = await exchange.getAccountBalances();
  if (!isUsable(balancesOutcome)) {
    // Section 5.6 again, and this is the case where it matters most: an
    // unreadable balance must never be recorded as an unchanged one, because
    // the next run would then measure its delta from a fiction.
    skipped.push(
      `account balances: ${balancesOutcome.kind} ${balancesOutcome.message}. ` +
        `No balance snapshots written this run, so the next run still measures ` +
        `from the last real observation.`,
    );
    return [];
  }

  const balances = balancesOutcome.value;
  const byAsset = new Map(balances.map((balance) => [balance.asset, balance]));

  const ledgerRows = await db.capitalLedger.findMany({
    where: { account_label: accountLabel },
  });

  // The union: assets this system allocates capital in, plus anything the
  // account actually holds. The second half is what makes an asset APPEARING
  // out of nowhere visible at all.
  const assets = new Set<string>([
    ...ledgerRows.map((row) => row.asset),
    ...balances.filter((balance) => balance.free + balance.locked > ZERO).map((b) => b.asset),
  ]);

  // An exchange reporting NOTHING is not the same as an account with nothing
  // to check, and until step 24 those two cases shared one silent early return.
  // See `auditEmptyBalanceSet` for the incident that distinguished them.
  const empty = assets.size === 0;
  await auditEmptyBalanceSet(ports, accountLabel, empty, at, skipped);
  if (empty) return [];

  const activity = await recordedActivity(ports, accountLabel, bots, skipped);
  const pending: PendingFinding[] = [];

  for (const asset of [...assets].sort()) {
    const balance: Balance | undefined = byAsset.get(asset);
    const exchangeTotal = balance === undefined ? ZERO : balance.free + balance.locked;

    const previous = await db.balanceSnapshots.findMany({
      where: { account_label: accountLabel, asset },
      orderBy: [{ column: "checked_at", direction: "desc" }],
      limit: 1,
    });
    const baseline = previous[0];

    const adjustments = await db.manualAdjustments.findMany({
      where: { account_label: accountLabel, asset, reconciled_at: null },
    });
    const adjustmentTotal = adjustments.reduce((total, row) => total + row.amount, ZERO);

    let internal: Money;
    let discrepancy: Money;
    let classification: DriftClassification | null = null;

    if (baseline === undefined) {
      // First observation. Adopt, do not accuse. See the file header.
      internal = exchangeTotal;
      discrepancy = ZERO;
      classification = "minor";
    } else {
      // From THIS asset's own baseline, not from the account's first snapshot.
      // The baseline below already contains everything that settled before it,
      // so anything earlier would be counted twice (step 24).
      const delta = activitySince(activity, asset, baseline.checked_at);
      if (!delta.attributed) {
        // Some trade in the window could not be attributed to an asset, so the
        // expected change is not knowable and any residual would be noise
        // dressed as a finding.
        skipped.push(
          `balance reconciliation for ${asset}: some trades in the window could not ` +
            `be attributed to a base/quote asset, so the expected change is unknown.`,
        );
        continue;
      }
      internal = baseline.exchange_reported_balance + delta.amount;
      // Section 8.6: subtract unreconciled logged adjustments BEFORE deciding
      // whether to alert. The result is what is genuinely unexplained.
      discrepancy = exchangeTotal - internal - adjustmentTotal;

      if (discrepancy !== ZERO) {
        pending.push({
          finding: {
            kind: "balance_drift",
            scope: "account",
            botInstanceId: null,
            asset,
            detail:
              `${asset}: the exchange reports ${toDecimalString(exchangeTotal)}. From the ` +
              `last observation of ${toDecimalString(baseline.exchange_reported_balance)} ` +
              `plus ${toDecimalString(delta.amount)} of this system's own recorded ` +
              `activity, ${toDecimalString(internal)} was expected. ` +
              `${adjustments.length} unreconciled manual adjustment(s) totalling ` +
              `${toDecimalString(adjustmentTotal)} were subtracted. ` +
              `${toDecimalString(discrepancy)} remains unexplained.`,
            magnitude: { amount: discrepancy, reference: exchangeTotal },
          },
        });
      }
    }

    const snapshot: BalanceSnapshotRow = {
      id: newId(),
      reconciliation_run_id: runId,
      account_label: accountLabel,
      asset,
      exchange_reported_balance: exchangeTotal,
      internal_calculated_balance: internal,
      discrepancy,
      // Filled in by `act` for anything that produced a finding; this is the
      // clean-run value, and NULL keeps meaning "no drift to classify"
      // (step 4, open question 3, confirmed rather than changed).
      classification,
      checked_at: at,
    };

    // The snapshot row and the marking of the adjustments it consumed go in
    // ONE batch, so they are atomic.
    //
    // That ordering question is otherwise genuinely nasty. Mark first and
    // crash, and the adjustment is consumed with its explanation lost, so the
    // next run over-alerts. Write first and crash, and the same adjustment is
    // subtracted again next run, explaining away a real discrepancy -- which
    // under-alerts, and is the direction that loses money. D1's batch is a
    // transaction, so neither happens.
    const statements = [
      db.balanceSnapshots.insertStatement(snapshot),
      ...adjustments.map((row: ManualAdjustmentRow) =>
        db.manualAdjustments.updateStatement({ id: row.id }, { reconciled_at: at }),
      ),
    ];
    await db.batch(statements);

    // Reconciliation is what gives `capital_ledger.total_balance` a real
    // source, exactly as step 5's header said it would. Only for an asset that
    // already has a ledger row: creating one would declare capital available
    // for allocation, and that is a human's decision, not a cron's.
    const ledgerRow = ledgerRows.find((row) => row.asset === asset);
    if (ledgerRow !== undefined && ledgerRow.total_balance !== exchangeTotal) {
      await db.capitalLedger.update(
        { account_label: accountLabel, asset },
        { total_balance: exchangeTotal, updated_at: at },
      );
    }
  }

  return pending;
}

/** `alert_type` for an exchange that reported no holdings at all. */
export const EMPTY_BALANCE_SET_ALERT = "reconciliation_empty_balance_set";

/**
 * Raise (or clear) the standing "the exchange reported no holdings" alert.
 *
 * THE GAP THIS CLOSES, and it is a real one that hid a real incident. On
 * 2026-08-05 the Binance testnet re-provisioned account `main`. For four
 * consecutive passes between the outage and the re-provision the exchange
 * answered `getAccountBalances` SUCCESSFULLY with a set containing no non-zero
 * balance. The union below was therefore empty, `reconcileBalances` returned on
 * `assets.size === 0`, and the run recorded `skipped: []` -- a clean pass, by
 * every signal the system emits. It wrote no snapshot, raised nothing, and
 * counted as an observation for the purpose of RESOLVING standing alerts.
 *
 * That silence is the whole problem. "The exchange says you hold nothing" and
 * "there is nothing here to check" arrived down the same code path, and only
 * one of them is benign.
 *
 * WHY THE DISCRIMINATOR IS PRIOR OBSERVATION AND NOT THE LEDGER. The obvious
 * guard -- alert when the account has `capital_ledger` expectations -- cannot
 * ever fire. `assets` is the union of ledger assets and non-zero balances, so
 * an empty union already proves there are no ledger rows; the condition would
 * be dead code, and it would have missed this incident exactly, because `main`
 * has no ledger rows at all. What DOES separate the two cases is whether this
 * account has ever been seen holding anything. An account observed with 445
 * assets seven hours ago and zero now has undergone a state change; an account
 * never observed holding anything has not.
 *
 * WHY IT ALSO PUSHES ONTO `skipped`. Section 5.6, in the direction that costs
 * money. An empty response treated as data means the next pass measures its
 * delta from a fiction of zero, and -- worse -- `resolveClearedAlerts` is
 * gated on `skipped.length === 0`, so those four passes were entitled to CLOSE
 * live standing alerts on the strength of having seen nothing. Recording the
 * empty set as unread rather than as read-and-empty fixes both.
 *
 * One row per incident, resolved when holdings are visible again, in the shape
 * `auditBlindness` already uses for its sibling condition. The two are
 * deliberately different alert types: blindness means the pass could not read,
 * this means it read and was told nothing is there, and an operator needs to
 * know which.
 */
async function auditEmptyBalanceSet(
  ports: ReconciliationPorts,
  accountLabel: string,
  empty: boolean,
  at: Timestamp,
  skipped: string[],
): Promise<void> {
  const { db, newId } = ports;
  // Account-scoped, like `auditBlindness`'s rows rather than like a finding's.
  // `owns` below keeps this lifecycle off that one despite the shared source.
  const source = `${RECONCILIATION_SOURCE}:${accountLabel}`;

  if (!empty) {
    await resolveClearedStandingAlerts(db, {
      source,
      owns: (alertType) => alertType === EMPTY_BALANCE_SET_ALERT,
      stillOpen: new Set(),
      // This branch only runs when the exchange returned holdings, which is
      // the observation that clears the incident.
      observed: true,
      scope: { kind: "source" },
    });
    return;
  }

  const seen = await db.balanceSnapshots.findMany({
    where: { account_label: accountLabel },
    orderBy: [{ column: "checked_at", direction: "desc" }],
    limit: 1,
  });
  const lastObservation = seen[0];

  // Never seen holding anything, so there is genuinely nothing to check and
  // nothing has changed. This is the case the original early return was right
  // about, and it stays silent.
  if (lastObservation === undefined) return;

  const since = at - lastObservation.checked_at;
  const when =
    `${new Date(lastObservation.checked_at).toISOString()} ` +
    `(${Math.floor(since / 60000)} minute(s) ago)`;

  skipped.push(
    `account balances: the exchange answered successfully but reported NO holdings at ` +
      `all, and this account was last observed holding assets at ${when}. Treated as ` +
      `unread rather than as a balance of zero, so no snapshots were written this run ` +
      `and the next run still measures from the last real observation.`,
  );

  await raiseStandingAlert(db, newId, {
    alertType: EMPTY_BALANCE_SET_ALERT,
    botInstanceId: null,
    severity: "critical",
    category: "system",
    source,
    message:
      `reconciliation read account ${accountLabel} successfully and the exchange ` +
      `reported NO holdings at all. It was last observed holding assets at ${when}. ` +
      `Nothing has been recorded as having drained to zero: the empty set is treated ` +
      `as unread, so the baseline survives and section 9's drift detection is NOT ` +
      `protecting this account until holdings are visible again. Either the venue is ` +
      `mid-transition (a testnet faucet re-provision does exactly this) or this client ` +
      `is authenticated against an account that is not the one holding the assets.`,
    at,
  });
}

/**
 * One trade's effect on one asset, kept WITH the time it settled.
 *
 * The timestamp is what makes a per-asset window possible at all: without it
 * there is only a lifetime scalar, and a lifetime scalar can only be added to a
 * lifetime baseline -- which is not the baseline this pass has.
 */
interface AssetContribution {
  readonly executedAt: Timestamp;
  readonly amount: Money;
  /** False when the trade could not be attributed to base/quote at all. */
  readonly attributed: boolean;
}

/** Every contribution per asset, unsummed. Sum it with `activitySince`. */
type RecordedActivity = ReadonlyMap<string, readonly AssetContribution[]>;

/**
 * What this system's own activity did to one asset AFTER a given instant.
 *
 * `since` is exclusive and is the asset's own baseline `checked_at`: that
 * snapshot's `exchange_reported_balance` already contains everything that
 * settled at or before it.
 *
 * `attributed` is false when any trade INSIDE the window could not be
 * attributed. Outside the window it does not matter -- the baseline absorbed
 * that trade whether this code could read it or not.
 */
function activitySince(
  activity: RecordedActivity,
  asset: string,
  since: Timestamp,
): { amount: Money; attributed: boolean } {
  const contributions = activity.get(asset);
  if (contributions === undefined) return { amount: ZERO, attributed: true };

  let amount = ZERO;
  let attributed = true;
  for (const entry of contributions) {
    if (entry.executedAt <= since) continue;
    amount += entry.amount;
    if (!entry.attributed) attributed = false;
  }
  return { amount, attributed };
}

/**
 * How much this system's OWN recorded activity should have moved each asset.
 *
 * Everything the bots did between the previous snapshot and now: base in and
 * out on fills, quote out and in against them, and fees in whatever asset the
 * exchange actually charged (section 5.5 is explicit that this is never
 * assumed to be the quote currency).
 *
 * Base and quote come from the exchange's own symbol filters, NOT from
 * slicing the pair string. Step 5's decision 1 rejected deriving an asset from
 * a symbol for a good reason -- it means reimplementing the exchange's symbol
 * table, and being wrong moves money between the wrong ledger rows. Here the
 * exchange is asked instead.
 *
 * ---------------------------------------------------------------------------
 * THE WINDOW IS PER ASSET, AND THAT IS LOAD-BEARING (step 24)
 * ---------------------------------------------------------------------------
 * Each asset's window opens at ITS OWN baseline -- the snapshot
 * `reconcileBalances` is about to subtract from -- because that baseline's
 * `exchange_reported_balance` already contains every trade that settled before
 * it. Adding those trades again double-counts them.
 *
 * This docblock claimed that behaviour before step 24 and the code did not
 * implement it: `since` was the account's OLDEST snapshot, one scalar sum was
 * computed from it, and every asset took that whole lifetime sum onto a
 * five-minute-old baseline. The discrepancy it produced was therefore exactly
 * the account's lifetime net activity, negated, on every pass -- measured on
 * `gemini-main` at 0.00149818 BTC and 96.24 USD against thresholds of 0.1% and
 * 2%, so it was a ratchet climbing toward the meaningful tier as the bots
 * traded. See `docs/decision-log/24.md`.
 *
 * So contributions are kept WITH their timestamps and summed per asset by
 * `activitySince`. One trades query still serves every asset: no asset's window
 * can open earlier than the account's oldest snapshot, so that remains the
 * correct fetch bound -- it is only the wrong SUM bound.
 */
async function recordedActivity(
  ports: ReconciliationPorts,
  accountLabel: string,
  bots: readonly BotInstanceRow[],
  skipped: string[],
): Promise<RecordedActivity> {
  const { db, exchange } = ports;
  const result = new Map<string, AssetContribution[]>();
  const botIds = bots.map((bot) => bot.id);
  if (botIds.length === 0) return result;

  const oldest = await db.balanceSnapshots.findMany({
    where: { account_label: accountLabel },
    orderBy: [{ column: "checked_at", direction: "asc" }],
    limit: 1,
  });
  const since = oldest[0]?.checked_at ?? 0;

  const trades = await db.trades.findMany({
    where: { bot_instance_id: { in: [...botIds] }, executed_at: { gt: since } },
  });
  if (trades.length === 0) return result;

  const orders = await db.orders.findMany({ where: { bot_instance_id: { in: [...botIds] } } });
  const orderById = new Map(orders.map((order) => [order.id, order]));
  const botById = new Map(bots.map((bot) => [bot.id, bot]));

  const filtersByPair = new Map<Pair, SymbolFilters | null>();
  const contribute = (asset: string, entry: AssetContribution): void => {
    const existing = result.get(asset);
    if (existing === undefined) result.set(asset, [entry]);
    else existing.push(entry);
  };
  const add = (asset: string, amount: Money, executedAt: Timestamp): void => {
    contribute(asset, { executedAt, amount, attributed: true });
  };
  // An unattributable trade poisons only the windows that CONTAIN it. Before
  // step 24 the flag was per asset with no timestamp, so one unattributable
  // trade suppressed that asset's finding for the rest of the account's life.
  const markUnattributed = (asset: string, executedAt: Timestamp): void => {
    contribute(asset, { executedAt, amount: ZERO, attributed: false });
  };

  for (const trade of trades) {
    const bot = botById.get(trade.bot_instance_id);
    const order = orderById.get(trade.order_id);
    if (bot === undefined || order === undefined) {
      skipped.push(
        `trade ${trade.id}: no matching order or bot row, so its effect on balances ` +
          `cannot be attributed`,
      );
      continue;
    }

    if (!filtersByPair.has(bot.pair)) {
      const outcome = await exchange.getSymbolFilters(bot.pair);
      filtersByPair.set(bot.pair, isUsable(outcome) ? outcome.value : null);
      if (!isUsable(outcome)) {
        skipped.push(
          `symbol filters for ${bot.pair}: ${outcome.kind} ${outcome.message}. ` +
            `Trades on this pair cannot be attributed to base/quote assets.`,
        );
      }
    }
    const filters = filtersByPair.get(bot.pair) ?? null;
    if (filters === null) {
      // Cannot attribute this trade. Mark every asset it might have touched,
      // so the caller declines to draw a conclusion rather than drawing a
      // wrong one from a partial sum.
      markUnattributed(bot.capital_asset, trade.executed_at);
      markUnattributed(trade.fee_asset, trade.executed_at);
      continue;
    }

    // Half-even, matching order-state.ts's NOTIONAL_ROUNDING, so this
    // reconstruction and the figures the bot itself computed round the same
    // way. They can still differ from the exchange's own arithmetic by a
    // sub-satoshi amount, which is one of the things `meaningfulPct` exists to
    // absorb.
    const notional = mul(trade.price, trade.quantity, "half-even");

    if (order.side === "buy") {
      add(filters.baseAsset, trade.quantity, trade.executed_at);
      add(filters.quoteAsset, -notional, trade.executed_at);
    } else {
      add(filters.baseAsset, -trade.quantity, trade.executed_at);
      add(filters.quoteAsset, notional, trade.executed_at);
    }

    // The fee leaves the account in whatever asset it was charged in.
    add(trade.fee_asset, -trade.fee_amount, trade.executed_at);
  }

  return result;
}

// ---------------------------------------------------------------------------
// 4. Ledger integrity (step 5's open question 2)
// ---------------------------------------------------------------------------

/**
 * Does `capital_ledger.total_allocated` still equal the sum of the bots'
 * allocations?
 *
 * Step 5's open question 2 asked step 7 to check this and said it is "the only
 * detector of a leaked reservation" -- the failure mode step 5's decision 5
 * accepted, where a partial failure leaves capital reserved for a bot that
 * does not exist. Nothing else in the system would ever notice until a close
 * started failing.
 */
async function reconcileAllocations(
  db: Database,
  accountLabel: string,
): Promise<PendingFinding[]> {
  const rows = await db.capitalLedger.findMany({ where: { account_label: accountLabel } });
  const pending: PendingFinding[] = [];

  for (const row of rows) {
    const summed = await db.botInstances.sumMoney("allocated_capital", {
      account_label: accountLabel,
      capital_asset: row.asset,
      status: { ne: "stopped" },
    });
    if (summed === row.total_allocated) continue;

    pending.push({
      finding: {
        kind: "ledger_allocation_drift",
        scope: "account",
        botInstanceId: null,
        asset: row.asset,
        detail:
          `capital_ledger for ${accountLabel}/${row.asset} says total_allocated is ` +
          `${toDecimalString(row.total_allocated)}, but the unstopped bots on it sum to ` +
          `${toDecimalString(summed)}. A difference means a reservation leaked (step 5, ` +
          `decision 5) and capital is claimed by nothing. Not auto-corrected: the ` +
          `ledger and the bot rows are both written deliberately, and guessing which ` +
          `is right could free capital a live bot is trading.`,
        magnitude: {
          amount: row.total_allocated - summed,
          reference: row.total_balance > ZERO ? row.total_balance : row.total_allocated,
        },
      },
    });
  }

  return pending;
}

// ---------------------------------------------------------------------------
// 6. Acting on the classification
// ---------------------------------------------------------------------------

interface ActOutcome {
  readonly haltedBotIds: readonly string[];
  readonly circuitBreakerTripped: boolean;
  readonly autoCorrections: readonly string[];
  readonly consumedAlertIds: readonly string[];
}

async function act(
  ports: ReconciliationPorts,
  accountLabel: string,
  runId: string,
  at: Timestamp,
  entries: readonly ClassifiedEntry[],
): Promise<ActOutcome> {
  const { db, newId } = ports;
  const haltedBotIds: string[] = [];
  const autoCorrections: string[] = [];
  const consumedAlertIds: string[] = [];
  let circuitBreakerTripped = false;

  const findings = entries.map((entry) => entry.classified);
  const severe = findings.filter((finding) => finding.tier === "severe");
  const meaningful = findings.filter((finding) => finding.tier === "meaningful");

  // --- Minor: auto-correct, log, NO alert. -------------------------------
  for (const entry of entries) {
    if (entry.classified.tier !== "minor") continue;
    if (entry.correct !== undefined) {
      await entry.correct();
      autoCorrections.push(entry.classified.detail);
    }
    // Section 9 is explicit that minor drift is logged and does NOT alert, so
    // the record is the audit entry this run writes, not a row in `alerts`.
    if (entry.classified.sourceAlertId !== undefined) {
      consumedAlertIds.push(entry.classified.sourceAlertId);
    }
  }

  // --- Severe: trip the breaker. Checked BEFORE meaningful, because tripping
  //     halts every bot on the account anyway, and halting one bot twice
  //     would write two alerts for one event. --------------------------------
  if (severe.length > 0) {
    const reason = severe.map((finding) => `[${finding.kind}] ${finding.detail}`).join(" | ");

    for (const finding of severe) {
      await raiseFindingAlert(db, newId, {
        alertType: reconciliationAlertType("severe", finding.kind),
        botInstanceId: finding.botInstanceId,
        message: `SEVERE drift (run ${runId}): ${finding.detail}`,
        at,
      });
    }

    const trip = await tripAccountCircuitBreaker(db, {
      accountLabel,
      reason,
      runId,
      actor: "reconciliation",
      now: at,
      haltBot: ports.haltBot,
      newId,
    });
    circuitBreakerTripped = true;
    haltedBotIds.push(...trip.haltedBotIds);

    for (const finding of severe) {
      if (finding.sourceAlertId !== undefined) consumedAlertIds.push(finding.sourceAlertId);
    }
    for (const finding of meaningful) {
      if (finding.sourceAlertId !== undefined) consumedAlertIds.push(finding.sourceAlertId);
    }
  } else {
    // --- Meaningful: halt THAT bot only, alert, do not auto-correct. ------
    for (const finding of meaningful) {
      await raiseFindingAlert(db, newId, {
        alertType: reconciliationAlertType("meaningful", finding.kind),
        botInstanceId: finding.botInstanceId,
        message: `MEANINGFUL drift (run ${runId}): ${finding.detail}`,
        at,
      });

      if (finding.scope !== "bot" || finding.botInstanceId === null) {
        // Nothing to halt. An account-scoped meaningful finding -- a ledger
        // mismatch, an unexplained balance below the severe threshold -- is
        // not attributable to one bot, and halting all of them is what the
        // SEVERE tier is for. Alert only, deliberately.
        if (finding.sourceAlertId !== undefined) consumedAlertIds.push(finding.sourceAlertId);
        continue;
      }

      try {
        await ports.haltBot(
          finding.botInstanceId,
          `reconciliation run ${runId} found meaningful drift: ${finding.detail}`,
        );
        if (!haltedBotIds.includes(finding.botInstanceId)) {
          haltedBotIds.push(finding.botInstanceId);
        }
        if (finding.sourceAlertId !== undefined) consumedAlertIds.push(finding.sourceAlertId);
      } catch (error) {
        // The source alert is deliberately NOT consumed: the tier's action did
        // not happen, so the next run must find it again and try once more.
        await db.alerts.insert({
          id: newId(),
          severity: "critical",
          category: "system",
          alert_type: "reconciliation_halt_failed",
          bot_instance_id: finding.botInstanceId,
          source: "reconciliation",
          message:
            `could not halt ${finding.botInstanceId} after meaningful drift: ` +
            `${error instanceof Error ? error.message : String(error)}. The bot may ` +
            `still be trading.`,
          resolved: false,
          created_at: at,
          notified_at: null,
        } satisfies AlertRow);
      }
    }
  }

  // --- Keep an already-latched account swept. ----------------------------
  // If an earlier run tripped the breaker but failed to halt some bot, or a
  // bot somehow reached an active status afterwards, catch it now. Only when
  // there is actually something to halt, so a quiet latched account does not
  // write an audit row every five minutes.
  if (!circuitBreakerTripped) {
    const existing = await db.circuitBreakers.findOne({ account_label: accountLabel });
    if (existing !== null && existing.state === "tripped") {
      const active = await activeBotsOnAccount(db, accountLabel);
      if (active.length > 0) {
        const sweep = await tripAccountCircuitBreaker(db, {
          accountLabel,
          reason: existing.reason ?? "previously tripped",
          runId,
          actor: "reconciliation",
          now: at,
          haltBot: ports.haltBot,
          newId,
        });
        haltedBotIds.push(...sweep.haltedBotIds);
      }
    }
  }

  // --- Close the loop: mark every consumed step-6 alert resolved. --------
  // Only alerts whose tier action actually landed reach here. This is the one
  // place in the codebase that sets `alerts.resolved` to true, and it is what
  // makes step 6's three alert paths a loop rather than a write-only table.
  for (const alertId of consumedAlertIds) {
    await db.alerts.update({ id: alertId }, { resolved: true });
  }

  // --- Stamp each asset's own tier onto its balance snapshot row. --------
  //
  // Per asset, and only from `balance_drift`. Two things this deliberately
  // does NOT do: it does not stamp one run-wide tier onto every asset (a
  // severe USDT residual must not make the BTC row claim severe, since that
  // row is the record of what was found for BTC), and it does not fold in
  // `ledger_allocation_drift`, which is asset-scoped but is a disagreement
  // between two of this system's own tables rather than a finding about the
  // balance this row reports.
  const balanceFindings = findings.filter(
    (finding) => finding.kind === "balance_drift" && finding.asset !== null,
  );
  for (const asset of new Set(balanceFindings.map((finding) => finding.asset!))) {
    const tier = highestTier(balanceFindings.filter((finding) => finding.asset === asset));
    if (tier === null) continue;
    await db.balanceSnapshots.update(
      { reconciliation_run_id: runId, asset },
      { classification: tier },
    );
  }

  return { haltedBotIds, circuitBreakerTripped, autoCorrections, consumedAlertIds };
}
