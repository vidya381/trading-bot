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
 * NO RATE LIMITING
 * ---------------------------------------------------------------------------
 * Section 5.4's RateLimiter Durable Object still does not exist. One pass
 * costs roughly 20 weight for balances plus 26 per distinct pair, every 5
 * minutes, against a 1200/minute budget -- so this job cannot meaningfully
 * starve a running bot. The exposure that does exist is a severe-drift trip
 * cancelling many orders at once, which is step 6's open question 7 and gets
 * materially worse at step 9's grid, not here.
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
  pending.push(...(await reconcileOrders(ports, bots, snapshots, skipped, thresholds)));

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
  bots: readonly BotInstanceRow[],
  snapshots: Map<string, BotSnapshot>,
  skipped: string[],
  thresholds: DriftThresholds,
): Promise<PendingFinding[]> {
  const { db, exchange, now } = ports;
  const pending: PendingFinding[] = [];
  const at = now();

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

    if (remoteOpen !== null) {
      pending.push(...(await liveOrderFindings(ports, bot, snapshot, remoteOpen, at, thresholds)));
    }
  }

  // Attribution runs once per pair over every order the exchange reports, not
  // per bot, so an order belonging to no bot is found exactly once.
  pending.push(...unknownOrderFindings(openOrdersByPair, bots, snapshots));

  return pending;
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

/** Orders the object believes are live, against what the exchange reports. */
async function liveOrderFindings(
  ports: ReconciliationPorts,
  bot: BotInstanceRow,
  snapshot: BotSnapshot,
  remoteOpen: readonly OrderStatus[],
  at: Timestamp,
  thresholds: DriftThresholds,
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
      pending.push(...driftAgainst(bot, local, remote));
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
    const age = at - status.updatedAt;
    if (age >= 0 && age <= thresholds.timingWindowMs) {
      // Section 9's own example of minor drift: "a fill recorded a few seconds
      // late". The order resolved inside the window, so the object simply has
      // not been told yet.
      pending.push({
        finding: {
          kind: "order_recently_terminated",
          scope: "bot",
          botInstanceId: bot.id,
          asset: null,
          detail:
            `${clientOrderId} left the book ${age}ms ago as ${status.state} with ` +
            `${toDecimalString(status.filledQuantity)} filled, inside the ` +
            `${thresholds.timingWindowMs}ms timing window. Treated as a late fill, not ` +
            `drift; the bot's own fill path will record it.`,
          // No magnitude: a fill recorded late is usually the WHOLE order, and
          // section 9 names exactly that as minor.
        },
      });
      continue;
    }

    pending.push(...driftAgainst(bot, local, status, `it is no longer on the book`));
  }

  return pending;
}

function driftAgainst(
  bot: BotInstanceRow,
  local: TrackedOrder,
  remote: OrderStatus,
  context = "",
): PendingFinding[] {
  const comparison = compareWithExchange(local, {
    state: remote.state,
    filledQuantity: remote.filledQuantity,
  });
  if (comparison.matches) return [];

  return [
    {
      finding: {
        kind: "order_state_drift",
        scope: "bot",
        botInstanceId: bot.id,
        asset: null,
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
  if (assets.size === 0) return [];

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
      const delta = activity.get(asset) ?? { amount: ZERO, attributed: true };
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
 * The window start is per asset (each asset's own last snapshot), so this
 * computes from the OLDEST baseline across the assets involved and lets each
 * asset take the slice it needs. Trades before an asset's own baseline are
 * excluded by the caller's arithmetic, because that baseline already contains
 * them.
 */
async function recordedActivity(
  ports: ReconciliationPorts,
  accountLabel: string,
  bots: readonly BotInstanceRow[],
  skipped: string[],
): Promise<Map<string, { amount: Money; attributed: boolean }>> {
  const { db, exchange } = ports;
  const result = new Map<string, { amount: Money; attributed: boolean }>();
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
  const add = (asset: string, amount: Money): void => {
    const current = result.get(asset) ?? { amount: ZERO, attributed: true };
    result.set(asset, { amount: current.amount + amount, attributed: current.attributed });
  };
  const markUnattributed = (asset: string): void => {
    const current = result.get(asset) ?? { amount: ZERO, attributed: true };
    result.set(asset, { amount: current.amount, attributed: false });
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
      markUnattributed(bot.capital_asset);
      markUnattributed(trade.fee_asset);
      continue;
    }

    // Half-even, matching order-state.ts's NOTIONAL_ROUNDING, so this
    // reconstruction and the figures the bot itself computed round the same
    // way. They can still differ from the exchange's own arithmetic by a
    // sub-satoshi amount, which is one of the things `meaningfulPct` exists to
    // absorb.
    const notional = mul(trade.price, trade.quantity, "half-even");

    if (order.side === "buy") {
      add(filters.baseAsset, trade.quantity);
      add(filters.quoteAsset, -notional);
    } else {
      add(filters.baseAsset, -trade.quantity);
      add(filters.quoteAsset, notional);
    }

    // The fee leaves the account in whatever asset it was charged in.
    add(trade.fee_asset, -trade.fee_amount);
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
      await db.alerts.insert({
        id: newId(),
        severity: "critical",
        category: "trading",
        alert_type: `reconciliation_severe_${finding.kind}`,
        bot_instance_id: finding.botInstanceId,
        source: "reconciliation",
        message: `SEVERE drift (run ${runId}): ${finding.detail}`,
        resolved: false,
        created_at: at,
      } satisfies AlertRow);
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
      await db.alerts.insert({
        id: newId(),
        severity: "critical",
        category: "trading",
        alert_type: `reconciliation_meaningful_${finding.kind}`,
        bot_instance_id: finding.botInstanceId,
        source: "reconciliation",
        message: `MEANINGFUL drift (run ${runId}): ${finding.detail}`,
        resolved: false,
        created_at: at,
      } satisfies AlertRow);

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
