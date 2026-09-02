/**
 * The PriceFeed Durable Object (spec section 4.6, decision-log step 14, Session
 * C1).
 *
 * One instance per (exchange, pair), addressed by `idFromName("<exchange>:<pair>")`.
 * It owns one outbound market-data WebSocket and turns that stream into a series
 * of CLOSED 1-minute candles, each forwarded exactly once as a `Price` to the
 * `#forward` seam (which Session C2 makes a fan-out to every subscribed bot).
 *
 * WHY A DEDICATED OBJECT, and why it never hibernates: step 14 established that an
 * OUTBOUND WebSocket does not hibernate (only inbound server sockets do). So this
 * object cannot sleep while connected — the live socket pins it in memory for up
 * to ~15 minutes, after which it can be evicted and the socket dropped. The two
 * things that must survive eviction (the forwarding watermark and the config) are
 * persisted; the live socket and the in-progress candle are in-memory and rebuilt
 * on every (re)connect. The reconnect itself is driven by this object's ALARM,
 * which is the recovery path after an eviction drops the socket.
 *
 * ── The forwarding model, from the step 14 probe (CURRENT-ONLY, confirmed 6/6) ──
 * Gemini sends no "candle closed" flag, and — verified by the deliberate probe —
 * a rollover message carries ONLY the new minute's candle, never the just-closed
 * one. So closure is inferred by a newer `openTime` appearing: this object keeps
 * the in-progress candle's last-seen OHLCV (`#current`) and, when a message brings
 * a newer `openTime`, FINALISES `#current` (forwards it as the closed candle) and
 * adopts the new one. A monotonic `watermark` (last forwarded close time) dedups.
 *
 * ── Gap-backfill on reconnect: from the WS replay batch, not REST (14.3) ──
 * On every (re)connect the exchange replays a large recent-history batch. On the
 * FIRST connect it is consumed only to prime (no history forwarded). On a
 * RECONNECT it is also the backfill source: the closed candles in it that are
 * newer than the watermark are forwarded, in order, filling the outage gap. This
 * deviates from decision 5 (which specified a REST `getCandles` backfill) and the
 * reasoning is in decision-log 14.3: the batch delivers equivalent coverage
 * synchronously and race-free, where a REST call would race the live socket for no
 * additional data.
 */

import { DurableObject } from "cloudflare:workers";
import { GeminiPriceFeedCodec } from "../exchange/gemini/price-feed";
import type { PriceFeedCodec } from "../exchange/price-feed-codec";
import { databaseFrom } from "../db";
import type { AlertRow, ExchangeId } from "../db/schema";
import type { Candle, Pair, Price, Timestamp } from "../shared/exchange-client";
import { toDecimalString, ZERO } from "../shared/money";

/** The (exchange, pair) a feed instance serves. Set once, by the first caller. */
export interface PriceFeedConfig {
  readonly exchange: ExchangeId;
  readonly pair: Pair;
}

/**
 * The subset of a `PriceFeed` a subscriber (a bot) calls. The real
 * `DurableObjectStub<PriceFeed>` satisfies it structurally; a test injects a
 * double. Declared here because it is the feed's public contract for callers, not
 * a bot-internal type.
 */
export interface PriceFeedPort {
  subscribe(botInstanceId: string, config: PriceFeedConfig): Promise<void>;
  unsubscribe(botInstanceId: string): Promise<void>;
}

/** One subscriber's registry row, as `status()` reports it. */
export interface PriceFeedSubscriberStatus {
  readonly botInstanceId: string;
  /** Failed deliveries since this bot's last successful one. See `#fanOut`. */
  readonly consecutiveFailures: number;
}

/**
 * Everything an operator can ask a feed about itself, read-only.
 *
 * There was previously NO way to inspect a running feed at all: the subscriber
 * registry lives in this object's own SQLite (invisible to D1), the socket and
 * alarm are runtime state, and a Durable Object namespace cannot be enumerated.
 * A feed holding a dead subscriber and burning duration was undiagnosable from
 * outside. This is that missing read.
 */
export interface PriceFeedStatus {
  /** Null once the feed has been stopped, or before its first subscriber. */
  readonly config: PriceFeedConfig | null;
  /** Whether a live outbound socket is held right now. */
  readonly connected: boolean;
  /** The armed alarm's instant, or null when disarmed. The leak, made visible. */
  readonly alarmAt: number | null;
  /** Whether `stopFeed` has latched this feed against self-reconnect. */
  readonly stopped: boolean;
  readonly watermark: number | null;
  readonly reconnectAttempts: number;
  readonly blindSince: number | null;
  readonly escalated: boolean;
  readonly subscriberCount: number;
  readonly subscribers: readonly PriceFeedSubscriberStatus[];
}

/**
 * The only state that must survive eviction. `#current`, the live socket, and
 * `#primed` are deliberately NOT here — they are rebuilt from the exchange's
 * replay batch on every (re)connect.
 */
interface PersistedFeedState {
  config: PriceFeedConfig | null;
  /** Close time of the last candle forwarded; dedups across reconnects. */
  watermark: number | null;
  /** Consecutive failed connect attempts, for the backoff schedule. */
  reconnectAttempts: number;
  /** When the feed exhausted its fast reconnect cycle and went blind. */
  blindSince: number | null;
  /** Whether the 30-minute blind escalation alert has already fired. */
  escalated: boolean;
  /**
   * SPEC 5.7 DETECTOR 1. The close of the last candle forwarded, as a DECIMAL
   * STRING rather than `Money`.
   *
   * A string because this object is the JSON-shaped half of the feed's state and
   * every other field in it is a number or a boolean. Durable Object storage
   * would carry a `bigint` through structured clone, but nothing else here needs
   * that exception and an equality comparison on the decimal form is exactly the
   * comparison this detector wants.
   */
  lastForwardedClose: string | null;
  /**
   * How many consecutive forwarded candles have carried `lastForwardedClose`
   * with NO TRADES AT ALL. See `#trackFrozenValue` for why both halves are
   * required. Counts the candles themselves, so `2` means two in a row.
   */
  frozenRun: number;
  /** Whether `price_feed_value_frozen` has been raised for the current run. */
  frozenAlerted: boolean;
}

const INITIAL_STATE: PersistedFeedState = {
  config: null,
  watermark: null,
  reconnectAttempts: 0,
  blindSince: null,
  escalated: false,
  lastForwardedClose: null,
  frozenRun: 0,
  frozenAlerted: false,
};

const STATE_KEY = "feed-state";

// --- Timing, set from the step 14 probe's measured cadence (Q2: ~5s heartbeats,
// min 4.8s / max 5.2s), NOT the earlier ~30–60s guess. ---
/** No inbound frame for this long while connected ⇒ the socket is silently dead. */
const STALENESS_MS = 20_000; // ~4 missed heartbeats of headroom
/** How often the alarm checks a connected socket's liveness. */
const HEALTH_CHECK_MS = 15_000;
/** Exponential reconnect backoff (section 4.6, 5 attempts): 1,2,4,8,16s. */
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_CAP_MS = 16_000;
const MAX_RECONNECT_ATTEMPTS = 5;
/** Slow retry once blind, so a long outage self-heals rather than dying silently. */
const SLOW_RETRY_MS = 60_000;
/** A blind feed louder after this long: stop-losses are unmonitored meanwhile. */
const BLIND_ESCALATION_MS = 30 * 60_000;
/**
 * Consecutive failed deliveries to ONE subscriber before it is unsubscribed.
 *
 * Five, matching `MAX_RECONNECT_ATTEMPTS`' spirit rather than its mechanism:
 * both say "this has failed enough times that it is a condition, not a blip".
 * At one closed candle a minute that is ~5 minutes of proven-dead delivery
 * before a subscriber is dropped, which is far longer than any transient
 * cross-object RPC failure and far shorter than the forever this used to be.
 *
 * A SUCCESSFUL delivery resets the count, so a bot that fails once and recovers
 * is never pruned. See `#fanOut`.
 */
const MAX_FANOUT_FAILURES = 5;

/**
 * WHICH ROWS A RESOLVE COVERS, beyond the alert types it names. Always stated,
 * never defaulted.
 *
 * `/src/alerts`'s `StandingAlertScope` records why this is a declared descriptor
 * rather than an optional argument: a writer may only close an incident it was in
 * a position to observe, and a scope that can be FORGOTTEN is one that silently
 * over-closes. That failure is invisible here in a way it is not there -- an
 * over-broad resolve closes a row belonging to a bot that is still failing, and
 * the only symptom is an alert surface that has gone quiet about a live problem.
 * Requiring the argument makes the two-line version of that bug unwritable.
 *
 * The double application `standing.ts` needs (a SQL filter AND a row predicate)
 * is deliberately absent, because here it would be redundant rather than
 * load-bearing: `bot` narrows on a single `bot_instance_id` equality, which the
 * `Where` builder expresses exactly, where that module's `account` scope is an
 * irreducible disjunction its query layer has no `OR` for.
 */
type FeedAlertScope =
  /**
   * Every row this feed raised of the named types, whoever they name. For an
   * incident that belongs to the MARKET -- the socket being down, the value
   * being fiction -- where no single subscriber owns it.
   */
  | { readonly kind: "feed" }
  /**
   * Only the rows naming one bot. For an incident attributed to a single
   * subscriber, where another subscriber's recovery is no evidence at all.
   *
   * ⚠ IT WILL NEVER MATCH A NULL-ATTRIBUTED ROW, and that is correct rather than
   * a gap to close. `#alert` falls back to `bot_instance_id: null` when the FK
   * rejects an id (a bot with no `bot_instances` row), and a row that names
   * nobody cannot be shown to be THIS bot's incident -- closing it on this bot's
   * recovery would be exactly the unobserved-resolve that scoping exists to
   * prevent. Those rows are the historical residue of ids that never had a bot
   * behind them, and they stay open by design.
   */
  | { readonly kind: "bot"; readonly botInstanceId: string };

/**
 * Consecutive unchanged, zero-volume candles before a feed is called frozen
 * (spec 5.7 detector 1).
 *
 * TEN, on a one-minute feed, so ten minutes of a market that neither moved nor
 * traded. The number comes from what it has to separate, not from a round
 * figure: a thin pair really does print isolated zero-volume minutes, and a busy
 * one really does repeat a close to the cent occasionally, so either signal
 * alone would cry wolf. A market doing BOTH for ten consecutive minutes is not a
 * market -- and the incident that produced this ran 1439 such candles in a row,
 * so the threshold has three orders of magnitude of headroom over the case it
 * was written for while still firing within ten minutes of the onset.
 */
const FROZEN_VALUE_RUN = 10;

/** The minimal socket surface this object drives; the transport is injected. */
export interface FeedSocket {
  send(data: string): void;
  close(): void;
}

/** How an opened socket delivers events back to the object. */
export interface SocketHandlers {
  onMessage: (raw: string) => void | Promise<void>;
  onClose: () => void | Promise<void>;
}

/** Injected so tests drive the clock, forward sink, codec, and socket exactly. */
export interface PriceFeedDependencies {
  now: () => Timestamp;
  /**
   * The `#forward` seam: what happens to one closed candle. The production
   * default (C2) is `#fanOut` — deliver it to every subscribed bot. Tests
   * override this with a collector to assert the raw stream the engine produces.
   */
  forward: (price: Price) => Promise<void>;
  /**
   * Deliver one price to one subscriber. The production default is the cross-DO
   * RPC `BOT_INSTANCE.get(idFromName(id)).onPriceUpdate(price)`; tests inject a
   * spy so fan-out and failure isolation are testable without real BotInstances.
   */
  deliver: (botInstanceId: string, price: Price) => Promise<unknown>;
  codec: PriceFeedCodec;
  /** Open the outbound socket. Rejects/throws if the connection cannot be made. */
  connect: (url: string, handlers: SocketHandlers) => Promise<FeedSocket>;
}

/**
 * Translate a WebSocket URL to the http(s) scheme Cloudflare's outbound-WebSocket
 * client requires. On Workers the client is `fetch()` with an `Upgrade: websocket`
 * header, and `fetch` REJECTS a `ws://`/`wss://` URL ("Fetch API cannot load") — the
 * scheme must be `http://`/`https://`, and the handshake response then carries the
 * socket on its `webSocket` property. Gemini's marketdata URL is `wss://`, so this
 * runs on every connect. Exported because passing the `wss://` URL straight to
 * `fetch` was a real bug this transport shipped with — caught by the temporary Tier 0
 * `/api/debug/ws-check` diagnostic (decision-log 14.6, since removed) before the feed
 * ever ran live. The scheme translation and its handshake tests are the permanent
 * residue of that catch; keep them.
 */
export function httpUrlForWebSocket(url: string): string {
  if (url.startsWith("wss://")) return `https://${url.slice("wss://".length)}`;
  if (url.startsWith("ws://")) return `http://${url.slice("ws://".length)}`;
  return url;
}

/**
 * Production transport: an outbound WebSocket via the fetch-Upgrade handshake.
 * `fetchImpl` is injectable so the handshake shape (http(s) scheme, `Upgrade`
 * header, reading `.webSocket`, `.accept()`) is testable without a live socket.
 */
export async function openOutboundSocket(
  url: string,
  handlers: SocketHandlers,
  fetchImpl: typeof fetch = fetch,
): Promise<FeedSocket> {
  const response = await fetchImpl(httpUrlForWebSocket(url), { headers: { Upgrade: "websocket" } });
  const ws = response.webSocket;
  if (ws === null) {
    throw new Error(
      `price feed: no WebSocket in the upgrade response for ${url} (status ${response.status})`,
    );
  }
  ws.accept();
  ws.addEventListener("message", (event: MessageEvent) => {
    const raw = typeof event.data === "string" ? event.data : "";
    void Promise.resolve(handlers.onMessage(raw)).catch(() => {});
  });
  const onClose = () => void Promise.resolve(handlers.onClose()).catch(() => {});
  ws.addEventListener("close", onClose);
  ws.addEventListener("error", onClose);
  return {
    send: (data) => ws.send(data),
    close: () => {
      // DETACH BEFORE CLOSING, and this ordering is the whole point.
      //
      // `ws.close()` dispatches a `close` event, which this transport has wired
      // to `onClose` -> `#onSocketClosed` -> `#scheduleReconnect`. So a feed
      // tearing itself down was asking, through its own teardown, to be
      // reconnected -- and `#scheduleReconnect` re-arms the alarm
      // unconditionally, which is how a stopped feed came back to life with no
      // subscribers and stayed awake indefinitely.
      //
      // Removing the listeners first means the event has nowhere to land. The
      // `#stopped` latch in the object is the second layer (it covers a close
      // event from a socket this transport did not create, e.g. an injected
      // test double), and `alarm()`'s zero-subscriber check is the third.
      ws.removeEventListener("close", onClose);
      ws.removeEventListener("error", onClose);
      try {
        ws.close();
      } catch {
        /* already closed */
      }
    },
  };
}

export class PriceFeed extends DurableObject<Env> {
  #state: PersistedFeedState = INITIAL_STATE;

  #deps: PriceFeedDependencies = {
    now: () => Date.now(),
    forward: (price) => this.#fanOut(price),
    deliver: (botInstanceId, price) => this.#deliverToBot(botInstanceId, price),
    codec: new GeminiPriceFeedCodec(),
    connect: openOutboundSocket,
  };

  // In-memory, transient, rebuilt on every (re)connect.
  #socket: FeedSocket | null = null;
  #current: Candle | null = null;
  #primed = false;
  #lastMessageAt = 0;
  /**
   * "This feed has been torn down and must not resurrect itself."
   *
   * Set by `stopFeed`, cleared ONLY by a deliberate `startFeed`. Deliberately
   * NOT cleared at the end of `stopFeed`: the race it defends against is a
   * `close` event arriving AFTER `stopFeed` has finished (its `deleteAlarm` is
   * the last statement), so a flag that lifts when `stopFeed` returns would be
   * down for exactly the window that matters.
   *
   * In-memory rather than persisted, and that is correct: it guards one
   * teardown against its own in-flight socket events. An eviction drops the
   * socket, so there is no event left to guard, and a woken feed with no
   * subscribers is caught by `alarm()` instead.
   */
  #stopped = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // The durable subscriber registry: a real SQLite table, so it survives
    // eviction and gives set semantics (and idempotency) for free.
    //
    // `consecutive_failures` is per-subscriber fan-out health (see `#fanOut`).
    // It lives in the table rather than in memory so it survives eviction --
    // an in-memory counter would reset every time the object was evicted, which
    // for a feed whose only subscriber is dead is exactly when it gets evicted.
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS subscribers (" +
        "bot_instance_id TEXT PRIMARY KEY, " +
        "consecutive_failures INTEGER NOT NULL DEFAULT 0)",
    );
    // Feeds that already exist were created with the one-column table, and a
    // Durable Object class carries no migration mechanism -- the constructor IS
    // the migration point. SQLite has no `ADD COLUMN IF NOT EXISTS`, and the
    // statement throws when the column is already present, so that throw is the
    // "already migrated" signal rather than an error to report.
    try {
      ctx.storage.sql.exec(
        "ALTER TABLE subscribers ADD COLUMN consecutive_failures INTEGER NOT NULL DEFAULT 0",
      );
    } catch {
      /* already migrated */
    }
    // Nothing may forward against an unread watermark, so this blocks rather than
    // racing the first message.
    ctx.blockConcurrencyWhile(async () => {
      const stored = await ctx.storage.get<PersistedFeedState>(STATE_KEY);
      // SPREAD OVER THE DEFAULTS, not assigned over them. Every feed running
      // right now has a stored blob written before 5.7's three fields existed,
      // and a bare assignment would leave them `undefined` -- `frozenRun + 1`
      // would be `NaN` and the detector would never fire on exactly the feeds
      // that have been running longest. The same additive treatment
      // `BotRuntimeState` gives `highWaterMark` and `entryAttempts`, applied to
      // a blob that is replaced wholesale rather than field by field.
      if (stored !== undefined) this.#state = { ...INITIAL_STATE, ...stored };
    });
  }

  /** Override the clock, forward sink, deliver, codec, and transport. Tests only. */
  attach(deps: Partial<PriceFeedDependencies>): void {
    this.#deps = {
      now: deps.now ?? this.#deps.now,
      forward: deps.forward ?? this.#deps.forward,
      deliver: deps.deliver ?? this.#deps.deliver,
      codec: deps.codec ?? this.#deps.codec,
      connect: deps.connect ?? this.#deps.connect,
    };
  }

  // -------------------------------------------------------------------------
  // Public lifecycle (Session C2's subscribe/unsubscribe compose these)
  // -------------------------------------------------------------------------

  /**
   * Fix the (exchange, pair) this instance serves. Idempotent: the first caller
   * wins and the value is stable thereafter, because every subscriber on
   * `gemini:BTCUSD` shares the same market.
   */
  async configure(config: PriceFeedConfig): Promise<void> {
    if (this.#state.config !== null) return;
    this.#state = { ...this.#state, config };
    await this.#persist();
  }

  /**
   * Bring the feed up: fix the config and ensure a live connection. C2's
   * `subscribe` calls this when the first subscriber arrives.
   */
  async startFeed(config: PriceFeedConfig): Promise<void> {
    // The ONLY thing that lifts the teardown latch. A feed comes back because a
    // subscriber asked for it, never because one of its own sockets closed.
    this.#stopped = false;
    await this.configure(config);
    await this.#ensureConnected();
  }

  /**
   * Take the feed down: close the socket and cancel the alarm. C2's `unsubscribe`
   * calls this when the last subscriber leaves.
   *
   * The watermark is RESET, not preserved. This is the "going idle" teardown, not
   * a transient reconnect: candles that close while no bot is subscribed are
   * irrelevant, so a later restart must re-prime fresh rather than treat the stale
   * watermark as a reconnect gap and backfill up to a day of candles that nobody
   * was listening for. (A transient reconnect does NOT call `stopFeed`, so it keeps
   * its watermark and backfills correctly — see `#onSocketClosed`.)
   *
   * ── THE CONFIG IS CLEARED TOO, AND THE ORDER OF THIS METHOD IS LOAD-BEARING ──
   *
   * This object used to leave `config` set and delete its alarm in the middle of
   * the teardown. Both were how a stopped feed came back: a `close` event from
   * its own `socket.close()` re-armed the alarm after `deleteAlarm` had already
   * run, and the surviving config then let `#ensureConnected` open a REAL socket
   * for a feed with zero subscribers, re-arming every 15s forever.
   *
   * So, in order: latch first (nothing may reconnect from here), drop the socket
   * reference BEFORE closing it (a re-entrant `#onSocketClosed` sees null),
   * clear the config (a stray alarm now hits `#ensureConnected`'s `config ===
   * null` guard and returns), and delete the alarm LAST, after everything that
   * could re-arm has already run.
   *
   * `reconnectAttempts` / `blindSince` / `escalated` are deliberately left
   * alone: a successful reopen already clears them (`#ensureConnected`), and
   * resetting them here would change when `price_feed_blind` fires.
   */
  async stopFeed(): Promise<void> {
    this.#stopped = true;
    const socket = this.#socket;
    this.#socket = null;
    this.#current = null;
    this.#primed = false;
    socket?.close();
    this.#state = { ...this.#state, config: null, watermark: null };
    await this.#persist();
    await this.#armAlarm(null);
  }

  /**
   * Subscribe a bot to this pair's feed (RPC). Carries the `{exchange, pair}`
   * config because a Durable Object cannot read its own name, so the feed cannot
   * derive its market from the `gemini:BTCUSD` key — the subscriber, which knows
   * its own config, supplies it.
   *
   * Idempotent: `INSERT OR IGNORE`, so a redelivered status transition (section
   * 5.1) cannot double-add. The FIRST subscriber (empty → non-empty) brings the
   * feed up via C1's `startFeed`; later joins only ensure the config is recorded.
   */
  async subscribe(botInstanceId: string, config: PriceFeedConfig): Promise<void> {
    const before = this.#subscriberCount();
    this.ctx.storage.sql.exec(
      "INSERT OR IGNORE INTO subscribers (bot_instance_id, consecutive_failures) VALUES (?, 0)",
      botInstanceId,
    );
    // A re-subscribe starts clean. `INSERT OR IGNORE` leaves an existing row
    // untouched, so without this a bot that halted mid-failure-streak and later
    // resumed would carry those failures into its new subscription and could be
    // pruned by deliveries it never missed.
    this.#resetFailures(botInstanceId);
    if (before === 0 && this.#subscriberCount() > 0) {
      await this.startFeed(config);
    } else {
      await this.configure(config);
    }
    // LAST, once this bot is genuinely back in the registry and the feed is up.
    // If `startFeed` threw, the bot is NOT receiving prices and its prune row is
    // still true, so the throw propagating past this is the correct outcome
    // rather than a case to catch. Reading D1 on every subscribe is affordable
    // in a way it would not be in `#fanOut`: this runs on a bot's start or
    // resume, not once a minute per subscriber.
    await this.#resolvePruned(botInstanceId);
  }

  /**
   * Unsubscribe a bot (RPC). Idempotent: a `DELETE` of a non-member is a no-op, so
   * a redelivered transition is safe. The LAST subscriber leaving (non-empty →
   * empty) takes the feed down via C1's `stopFeed`.
   */
  async unsubscribe(botInstanceId: string): Promise<void> {
    const before = this.#subscriberCount();
    this.ctx.storage.sql.exec(
      "DELETE FROM subscribers WHERE bot_instance_id = ?",
      botInstanceId,
    );
    if (before > 0 && this.#subscriberCount() === 0) {
      await this.stopFeed();
    }
  }

  /**
   * What this feed is doing, right now (RPC). READ-ONLY: it opens nothing,
   * arms nothing, and writes nothing.
   *
   * Note that merely CALLING this instantiates the object if it was evicted --
   * unavoidable, since a Durable Object cannot be observed from outside itself.
   * That costs one short invocation and, because no branch here arms an alarm,
   * the object goes straight back to sleep. Asking a feed how it is does not
   * wake it up for good.
   */
  async status(): Promise<PriceFeedStatus> {
    const rows = this.ctx.storage.sql
      .exec<{ bot_instance_id: string; consecutive_failures: number }>(
        "SELECT bot_instance_id, consecutive_failures FROM subscribers ORDER BY bot_instance_id",
      )
      .toArray();
    return {
      config: this.#state.config,
      connected: this.#socket !== null,
      alarmAt: await this.ctx.storage.getAlarm(),
      stopped: this.#stopped,
      watermark: this.#state.watermark,
      reconnectAttempts: this.#state.reconnectAttempts,
      blindSince: this.#state.blindSince,
      escalated: this.#state.escalated,
      subscriberCount: rows.length,
      subscribers: rows.map((row) => ({
        botInstanceId: row.bot_instance_id,
        consecutiveFailures: row.consecutive_failures,
      })),
    };
  }

  /**
   * Reset the transient stream state for a fresh connection, called the moment a
   * socket opens (before the replay batch), so the batch primes rather than being
   * read as live rollovers. Public so the core-engine tests can drive the engine
   * without a socket; the socket path calls it internally. Does NOT touch the
   * persisted watermark — that is exactly what must survive a reconnect.
   */
  beginConnection(): void {
    this.#current = null;
    this.#primed = false;
  }

  // -------------------------------------------------------------------------
  // The stream engine: one raw frame in, closed candles forwarded out
  // -------------------------------------------------------------------------

  /**
   * Process one raw inbound frame. The socket's `message` listener calls this;
   * the core-engine tests call it directly with captured payloads.
   */
  async handleMessage(raw: string): Promise<void> {
    const config = this.#state.config;
    if (config === null) return;

    const at = this.#deps.now();
    this.#lastMessageAt = at;

    const events = this.#deps.codec.parseMessage(raw, config.pair, at);
    const candles: Candle[] = [];
    for (const event of events) {
      switch (event.kind) {
        case "candle":
          candles.push(event.candle);
          break;
        case "heartbeat":
          // Liveness only; `#lastMessageAt` already advanced, which the staleness
          // alarm reads.
          break;
        case "ignored":
          break;
        case "malformed":
          // A message of a type we recognised but could not parse — an API change
          // to surface, per the codec's contract. Recorded, never swallowed.
          await this.#alert("warning", "system", "price_feed_malformed", event.reason);
          break;
      }
    }

    if (candles.length > 0) await this.#ingestCandles(candles, at);
  }

  /**
   * The CURRENT-ONLY forwarding algorithm (step 14 probe, Q1), plus WS-batch
   * backfill (14.3). `candles` are oldest-first, from one frame.
   */
  async #ingestCandles(candles: Candle[], at: Timestamp): Promise<void> {
    if (!this.#primed) {
      // The replay batch after a (re)connect. Its newest row is the in-progress
      // candle; everything before it is closed history.
      const newest = candles[candles.length - 1]!;
      if (this.#state.watermark === null) {
        // FIRST connect ever: forward NO history (a bot does not want a day of
        // stale candles); prime the watermark to just before the current candle.
        this.#state = { ...this.#state, watermark: newest.openTime - 1 };
        await this.#persist();
      } else {
        // RECONNECT: this batch is also the gap-backfill. Forward the closed
        // candles newer than the watermark, oldest-first — `#forwardClosed`
        // dedups, so only the true outage gap goes out, exactly once.
        for (let i = 0; i < candles.length - 1; i++) {
          await this.#forwardClosed(candles[i]!, at);
        }
      }
      this.#current = newest;
      this.#primed = true;
      return;
    }

    for (const candle of candles) {
      const current = this.#current;
      if (current === null || candle.openTime > current.openTime) {
        // A newer minute has begun: the previous in-progress candle has closed.
        if (current !== null) await this.#forwardClosed(current, at);
        this.#current = candle;
      } else if (candle.openTime === current.openTime) {
        // In-place update of the current candle: keep the latest OHLCV.
        this.#current = candle;
      } else {
        // An older candle out of order (not seen on Gemini's live stream, but
        // handled defensively; the watermark dedups it).
        await this.#forwardClosed(candle, at);
      }
    }
  }

  /**
   * Forward a candle as a closed-candle `Price`, once. Dedups on the monotonic
   * watermark, so a candle already forwarded (across a reconnect, or from the
   * batch backfill) is never delivered twice. Uses the candle's close price and
   * receipt time, per section 5.6 ("when we heard") and step 14 decision 3.
   */
  async #forwardClosed(candle: Candle, at: Timestamp): Promise<void> {
    const watermark = this.#state.watermark;
    if (watermark !== null && candle.closeTime <= watermark) return;

    const price: Price = { pair: candle.pair, price: candle.close, at };
    await this.#deps.forward(price);

    // The fan-out can END this feed: pruning the last failing subscriber calls
    // `unsubscribe`, which calls `stopFeed`, which resets the watermark exactly
    // so a restart re-primes fresh. Writing the watermark back here would undo
    // that and make the next start read as a reconnect, backfilling history
    // nobody asked for.
    if (this.#stopped) return;

    // AFTER the forward, never before. This is a detector, not a gate: a frozen
    // feed still delivers, because withholding prices from a bot holding a
    // position would replace a reporting problem with a risk one. It observes
    // and says so; what to do about it is a human's call.
    await this.#trackFrozenValue(candle, at);

    this.#state = { ...this.#state, watermark: candle.closeTime };
    await this.#persist();
  }

  /**
   * SPEC 5.7 DETECTOR 1: the feed is delivering, and the value is fiction.
   *
   * ⚠ THE GAP THIS FILLS, AND WHY NOTHING ELSE COULD. `#forwardClosed` stamps
   * every price's `at` with RECEIPT time, so `lastPriceAt` on every subscriber is
   * fresh by construction no matter how old the number is. `price_feed_blind`
   * watches heartbeats and `price_updates_stale` watches `lastPriceAt`; both are
   * liveness checks, and a healthy socket delivering a frozen price satisfies
   * both perfectly. On 2026-09-02 exactly that happened for eleven hours across
   * fourteen bots, and the first thing to notice was a human.
   *
   * ⚠ BOTH CONDITIONS, AND THE CONJUNCTION IS THE WHOLE DESIGN. An unchanged
   * close alone is ordinary -- a quiet minute on a liquid pair closes where it
   * opened. Zero volume alone is ordinary too, on a pair that simply had no
   * trades that minute. What is NOT ordinary is a candle that reports the
   * identical price AND that nothing traded to produce it: that is a
   * carry-forward, a venue quoting its own last memory rather than a market. Ten
   * of those in a row is the signature, and it is what the sandbox printed 1439
   * times consecutively.
   *
   * STANDING, NOT REPEATING. One row per incident (`frozenAlerted` latches it,
   * exactly as `escalated` latches the blind escalation), resolved the moment a
   * differing close arrives. A row per frozen candle would be 1439 rows a day
   * on the incident that produced this, which is how an alert surface stops
   * being read.
   *
   * BEST-EFFORT, AND THAT IS LOAD-BEARING. Every D1 write below is wrapped: this
   * runs inside the forwarding path, and a detector that can throw is a detector
   * that can stop a feed delivering prices. The counters live in this object's
   * own state and are correct whether or not the alert row lands.
   */
  async #trackFrozenValue(candle: Candle, at: Timestamp): Promise<void> {
    const close = toDecimalString(candle.close);
    const repeated = this.#state.lastForwardedClose === close;
    const noTrades = candle.volume === ZERO;

    if (repeated && noTrades) {
      // `frozenRun` counts CANDLES, not repeats, so the first match counts the
      // pair of them: the one that matched and the one it matched against.
      // `FROZEN_VALUE_RUN` then reads as "ten candles in a row", which is what
      // the constant claims and what the alert says.
      const run = this.#state.frozenRun === 0 ? 2 : this.#state.frozenRun + 1;
      const firstBreach = run >= FROZEN_VALUE_RUN && !this.#state.frozenAlerted;
      this.#state = {
        ...this.#state,
        frozenRun: run,
        frozenAlerted: this.#state.frozenAlerted || firstBreach,
      };
      if (firstBreach) {
        await this.#reportFrozen(
          `price feed for ${this.#configLabel()} has forwarded ${run} consecutive candles ` +
            `at exactly ${close} with zero volume on every one. A market that neither ` +
            `moves nor trades for ${run} minutes is not reporting a price, it is repeating ` +
            `its last memory of one. Every bot on this pair is evaluating its entries and ` +
            `stop-losses against that number, and nothing else can tell: this feed is ` +
            `connected, its heartbeats are current, and each price carries a fresh receipt ` +
            `timestamp (spec 5.7).`,
          at,
        );
      }
      return;
    }

    // The value moved, or something traded. Either way the run is over.
    const wasAlerted = this.#state.frozenAlerted;
    this.#state = {
      ...this.#state,
      lastForwardedClose: close,
      frozenRun: 0,
      frozenAlerted: false,
    };
    if (wasAlerted) await this.#resolveFrozen();
  }

  /** Raise the standing frozen-value row. Never throws; see `#trackFrozenValue`. */
  async #reportFrozen(message: string, at: Timestamp): Promise<void> {
    try {
      await this.#alert("critical", "system", "price_feed_value_frozen", message);
    } catch (error) {
      // The condition is still recorded in `frozenAlerted`, so this does not
      // re-fire every candle once D1 comes back -- deliberately. A missed alert
      // is a missed alert; re-raising it on recovery would put the row minutes
      // or hours after the onset with no way to tell.
      console.error(
        `price feed ${this.#configLabel()}: frozen-value alert could not be written ` +
          `(${(error as Error).message}). Value frozen since ${at}.`,
      );
    }
  }

  /** Close the standing frozen-value row once prices move again. */
  async #resolveFrozen(): Promise<void> {
    try {
      await this.#resolveOwnAlerts(["price_feed_value_frozen"], { kind: "feed" });
    } catch (error) {
      console.error(
        `price feed ${this.#configLabel()}: prices moved again but the frozen-value alert ` +
          `could not be resolved (${(error as Error).message}).`,
      );
    }
  }

  /**
   * Close the standing blind rows once the feed is connected again.
   *
   * ⚠ THE BUG THIS CLOSES. `price_feed_blind` and `price_feed_blind_escalated`
   * were raised by `#scheduleReconnect` and marked resolved by NOTHING, anywhere
   * in the system -- entry 81 PART 6 confirmed it by grep and left it deliberately
   * out of that scope. The system's other resolving paths could not have covered
   * it even in principle: `resolveHaltAlerts`, `resolveClearedStandingAlerts`,
   * reconciliation's own pass and the two maintenance endpoints are each scoped
   * by `source` or an explicit type list, and none of them names `price-feed:*`.
   * The cost was measured rather than theorised -- two 20-day-old open rows for
   * `gemini:BTCUSD` and `gemini:DOGEUSD` that turned out to be stale bookkeeping,
   * after they had already consumed real time to rule out as a live outage.
   *
   * ── WHY A SUCCESSFUL OPEN IS THE RIGHT CONDITION ──
   *
   * `#recordPollFailure` in `bot-instance.ts` says it "MIRRORS THE PRICE FEED'S
   * BLIND POLICY", and what it gets from the standing path is "a real resolution
   * the moment a pass reads cleanly again". THE CONNECT ATTEMPT IS THIS OBJECT'S
   * PASS: it is the operation that failed `MAX_RECONNECT_ATTEMPTS` times over to
   * produce the alert in the first place, so its success is the same evidence in
   * the same currency. `#syncAlarm`'s rule -- only something that actually
   * observed may close the row, never a mere absence of work -- is satisfied,
   * because this runs on a handshake that really completed and not on a feed that
   * simply stopped being asked for anything.
   *
   * IT IS DELIBERATELY NOT "a fresh price arrived". That is a different alert's
   * job: `price_feed_blind` is a CONNECTION check (5.7's header records it and
   * `price_updates_stale` as the two liveness checks, and `#trackFrozenValue` as
   * the correctness one that neither could ever be). Waiting for a candle would
   * also hold the row open through a legitimately quiet market, and -- worse --
   * would decouple the row from `blindSince`, which is cleared here. The raise is
   * gated on that flag, so a resolve on any LATER event allows a second open row
   * behind the first. Raising and resolving on the same transition is what makes
   * a duplicate impossible.
   *
   * Both types go together because the escalation is the same incident grown
   * louder, not a second one: it can only exist while `blindSince` is set, and it
   * stops describing anything the moment this clears.
   */
  async #resolveBlind(): Promise<void> {
    try {
      await this.#resolveOwnAlerts(["price_feed_blind", "price_feed_blind_escalated"], {
        kind: "feed",
      });
    } catch (error) {
      console.error(
        `price feed ${this.#configLabel()}: the feed reconnected but its blind alert could ` +
          `not be resolved (${(error as Error).message}).`,
      );
    }
  }

  /**
   * Close one bot's fan-out failure rows once a delivery to it succeeds again.
   *
   * ⚠ SAME DEFECT AS `#resolveBlind`, ONE LAYER IN. These rows were raised and
   * closed by nothing, under the same `price-feed:*` source no other resolver
   * reaches. The condition they describe -- "this bot cannot be reached" -- has a
   * precise, already-observed end that this object was throwing away.
   *
   * ── THE EVENT IS THE SUCCESSFUL DELIVERY, AND IT IS ALREADY TRUSTED ──
   *
   * `#fanOut`'s fulfilled branch resets `consecutive_failures` on exactly this
   * event, with the reasoning stated there: a subscriber that can be REACHED is
   * healthy whatever it did with the price, a non-running bot's `"ignored"`
   * included. `consecutive_failures` is to this alert what `blindSince` is to the
   * blind one -- the state that says an incident is open -- so resolving where
   * that state clears keeps the row and the counter from ever disagreeing.
   *
   * ── PER BOT, NOT PER FEED, AND THAT IS THE DIFFERENCE FROM `#resolveBlind` ──
   *
   * A blind feed is one incident belonging to the market: nothing is delivered to
   * anyone, and one reconnect ends it for every subscriber at once. A fan-out
   * failure is attributed to ONE bot by design (entry 81 made these rows joinable
   * precisely so they would appear on that bot's page), and the other subscribers
   * on the same market were being delivered to perfectly throughout. So bot A
   * succeeding is no evidence whatsoever about bot B, and a feed-scoped resolve
   * here would close a live incident on an unrelated bot's recovery -- quietly,
   * and on a surface whose whole job is to still be shouting.
   *
   * Never throws: see the call site on why a resolve that can throw inside
   * `#fanOut` is a candle that is retried forever.
   */
  async #resolveFanoutFailures(botInstanceId: string): Promise<void> {
    try {
      await this.#resolveOwnAlerts(["price_feed_fanout_failed"], {
        kind: "bot",
        botInstanceId,
      });
    } catch (error) {
      console.error(
        `price feed ${this.#configLabel()}: delivery to ${botInstanceId} recovered but its ` +
          `fan-out alerts could not be resolved (${(error as Error).message}).`,
      );
    }
  }

  /**
   * Close a bot's prune row once it subscribes to this feed again.
   *
   * ── WHY THIS IS A REAL RESOLVE AND NOT AN ARTIFICIAL ONE ──
   *
   * The tempting reading is that a pruned subscriber is GONE rather than fixed,
   * so there is nothing to resolve and the row is correctly informational. That
   * reading does not survive contact with `/src/alerts/index.ts`, which names two
   * lifecycles and puts this squarely in the second: "a discrete EVENT that a
   * later state transition makes historical. One row per halt, closed when the
   * bot successfully resumes." A prune IS that shape. One row per prune is right,
   * and `resolveHaltAlerts` already applies the identical treatment to the
   * identical shape one object over.
   *
   * The alert's own text settles it. It says the bot "receives no further prices
   * until it is resumed, which re-subscribes it" -- the row NAMES its exit
   * condition, and `subscribe` is that condition arriving. Left unresolved it
   * ends up asserting, permanently and on the bot's own detail page, that a
   * running bot's stop-loss is not being evaluated. That sentence is either
   * urgent or it is false; there is no version of it that is worth leaving open
   * as history. History is what `audit_log` is for.
   *
   * ── WHAT THIS DELIBERATELY DOES NOT CLAIM ──
   *
   * Not that the bot is healthy -- only that it is subscribed. A bot that
   * re-subscribes and immediately starts failing again accumulates a fresh
   * streak and is pruned again, opening a NEW row, exactly as a feed that
   * re-connects and goes blind again does. Re-arming is the property that makes
   * closing safe.
   *
   * Never throws. `subscribe` is FAIL-CLOSED for its caller -- `BotInstance`
   * treats a throw here as a reason not to start or resume the bot at all -- so a
   * D1 hiccup while tidying a stale row must never be the thing that stops a bot
   * from running.
   */
  async #resolvePruned(botInstanceId: string): Promise<void> {
    try {
      await this.#resolveOwnAlerts(["price_feed_subscriber_pruned"], {
        kind: "bot",
        botInstanceId,
      });
    } catch (error) {
      console.error(
        `price feed ${this.#configLabel()}: ${botInstanceId} re-subscribed but its prune ` +
          `alert could not be resolved (${(error as Error).message}).`,
      );
    }
  }

  /**
   * Mark every open row of the given types, within `scope`, that THIS feed
   * raised as resolved.
   *
   * Scoped by `source` as well as type, so a feed resolves ITS OWN incident and
   * never another market's -- `#alert` writes `price-feed:<exchange>:<pair>` and
   * this reads the same string back. Spelled once, for all four lifecycles, for
   * the reason `#alertSource` is spelled once: a second copy of that scope would
   * fail silently, as rows that are raised and never closed.
   *
   * EVERY matching row, not the newest one. `price_feed_fanout_failed` is raised
   * per failed ATTEMPT rather than latched per incident, so a bot that failed
   * four times and then succeeded has four rows describing one run that is now
   * over. Closing the run means closing all of them.
   *
   * THROWS. Each caller decides what a D1 failure means on its own path, and all
   * of them treat it as best-effort -- see `#trackFrozenValue` on why a detector
   * that can throw is a detector that can stop a feed delivering prices.
   */
  async #resolveOwnAlerts(alertTypes: readonly string[], scope: FeedAlertScope): Promise<void> {
    const db = databaseFrom(this.env);
    const open = await db.alerts.findMany({
      where: {
        alert_type: { in: alertTypes },
        source: this.#alertSource(),
        resolved: false,
        ...(scope.kind === "bot" ? { bot_instance_id: scope.botInstanceId } : {}),
      },
    });
    for (const row of open) {
      await db.alerts.update({ id: row.id }, { resolved: true });
    }
  }

  // -------------------------------------------------------------------------
  // Connection lifecycle + the single multiplexed alarm
  // -------------------------------------------------------------------------

  /**
   * Ensure a live socket, opening one if there is none. Called on `startFeed`, and
   * from the alarm as a reconnect attempt (including after an eviction dropped the
   * in-memory socket). A failed open is not fatal — it schedules the next attempt.
   */
  async #ensureConnected(): Promise<void> {
    if (this.#socket !== null) return;
    const config = this.#state.config;
    if (config === null) return;

    const url = this.#deps.codec.socketUrl(this.env.ENVIRONMENT);
    let socket: FeedSocket;
    try {
      socket = await this.#deps.connect(url, {
        onMessage: (raw) => this.handleMessage(raw),
        onClose: () => this.#onSocketClosed(),
      });
    } catch {
      await this.#scheduleReconnect();
      return;
    }

    this.#socket = socket;
    this.beginConnection(); // fresh connection: the replay batch will re-prime
    this.#lastMessageAt = this.#deps.now();
    // A successful open clears any backoff/blind state from a prior outage. The
    // ALERT ROW is part of that state and was the one piece nothing cleared;
    // `wasBlind` is read BEFORE the clear because the clear is what erases the
    // evidence that there is a row to close.
    const wasBlind = this.#state.blindSince !== null || this.#state.escalated;
    if (
      this.#state.reconnectAttempts !== 0 ||
      this.#state.blindSince !== null ||
      this.#state.escalated
    ) {
      this.#state = { ...this.#state, reconnectAttempts: 0, blindSince: null, escalated: false };
      await this.#persist();
    }
    socket.send(this.#deps.codec.subscribeMessage(config.pair));
    await this.#armAlarm(this.#deps.now() + HEALTH_CHECK_MS);
    // LAST, and only for a feed that actually went blind. Everything that makes
    // the feed live again -- the subscribe frame, the health-check alarm -- runs
    // first; closing a row is reporting, and reporting never goes in front of
    // recovery. Same order, and the same reason, as `#trackFrozenValue` sitting
    // after the forward rather than before it. It cannot throw.
    if (wasBlind) await this.#resolveBlind();
  }

  /** A socket closed or errored (or was found stale): drop it and reconnect. */
  async #onSocketClosed(): Promise<void> {
    // A close event belonging to a teardown we ourselves performed. The
    // transport already removes its listeners before closing, so in production
    // this event should not arrive at all; this catches the cases that bypass
    // that path -- an injected socket double, or an event already queued when
    // `stopFeed` ran. Reconnecting here is precisely the leak.
    if (this.#stopped) return;
    this.#socket?.close();
    this.#socket = null;
    this.#current = null;
    this.#primed = false;
    await this.#scheduleReconnect();
  }

  /**
   * Schedule the next reconnect on the single alarm. Fast exponential backoff for
   * the first `MAX_RECONNECT_ATTEMPTS`; after that the feed is BLIND — it alerts
   * once, keeps a slow retry alive, and escalates the alert's severity if it stays
   * blind past `BLIND_ESCALATION_MS` (the operator's addition), so a long outage
   * grows louder rather than staying one quiet alert.
   */
  async #scheduleReconnect(): Promise<void> {
    const attempts = this.#state.reconnectAttempts + 1;
    this.#state = { ...this.#state, reconnectAttempts: attempts };

    if (attempts <= MAX_RECONNECT_ATTEMPTS) {
      const delay = Math.min(BACKOFF_BASE_MS * 2 ** (attempts - 1), BACKOFF_CAP_MS);
      await this.#persist();
      await this.#armAlarm(this.#deps.now() + delay);
      return;
    }

    const now = this.#deps.now();
    if (this.#state.blindSince === null) {
      this.#state = { ...this.#state, blindSince: now };
      await this.#alert(
        "warning",
        "system",
        "price_feed_blind",
        `price feed for ${this.#configLabel()} lost its connection and could not ` +
          `reconnect in ${MAX_RECONNECT_ATTEMPTS} attempts; retrying every ` +
          `${SLOW_RETRY_MS / 1000}s. Bots on this pair receive no prices until it recovers.`,
      );
    } else if (!this.#state.escalated && now - this.#state.blindSince >= BLIND_ESCALATION_MS) {
      this.#state = { ...this.#state, escalated: true };
      await this.#alert(
        "critical",
        "system",
        "price_feed_blind_escalated",
        `price feed for ${this.#configLabel()} has been blind for over ` +
          `${Math.round(BLIND_ESCALATION_MS / 60_000)} minutes. Stop-losses on this ` +
          `pair have been unmonitored for that entire period.`,
      );
    }
    await this.#persist();
    await this.#armAlarm(now + SLOW_RETRY_MS);
  }

  /**
   * The single alarm handler, multiplexed over connection state (one alarm per
   * DO, so heartbeat and reconnect cannot each own one).
   *
   *  - NO SUBSCRIBERS ⇒ stop. See below.
   *  - Connected and fresh  ⇒ re-arm the health check.
   *  - Connected but stale (no frame within `STALENESS_MS`) ⇒ the socket died
   *    silently; tear it down and reconnect.
   *  - No socket (a scheduled reconnect, or a wake after eviction) ⇒ reconnect.
   *
   * ── THE ZERO-SUBSCRIBER CHECK IS THE BACKSTOP, AND IT COMES FIRST ──
   *
   * Every other branch of this handler re-arms, so an alarm on a feed nobody is
   * listening to is a timer that runs forever, holding an object (and, once it
   * reconnects, an un-hibernatable outbound socket) in memory for no reader.
   * That is the billed leak this whole change exists to end.
   *
   * It is deliberately a check on the CURRENT registry rather than on how the
   * feed got here: it closes not just the two known causes -- a failed
   * `unsubscribe` RPC that left a dead subscriber behind, and a self-inflicted
   * reconnect after `stopFeed` -- but any future gap that leaves a feed running
   * with an empty registry, whatever its cause.
   *
   * The one thing it must NOT do is kill a feed that still has a live bot on it.
   * A subscriber that is halted, unreachable, or failing delivery still COUNTS
   * here; only an empty registry stops the feed. Losing prices is a trading
   * risk, so the connection outlives every failure short of having no reader
   * left at all.
   */
  override async alarm(): Promise<void> {
    if (this.#subscriberCount() === 0) {
      await this.stopFeed();
      return;
    }
    if (this.#socket !== null) {
      if (this.#deps.now() - this.#lastMessageAt > STALENESS_MS) {
        await this.#onSocketClosed();
        return;
      }
      await this.#armAlarm(this.#deps.now() + HEALTH_CHECK_MS);
      return;
    }
    await this.#ensureConnected();
  }

  // -------------------------------------------------------------------------
  // Fan-out (the #forward seam's production implementation)
  // -------------------------------------------------------------------------

  /**
   * Deliver one closed candle to every current subscriber, concurrently.
   *
   * `Promise.allSettled` isolates failures: one slow or throwing bot cannot stall
   * or break delivery to the others. A non-running bot's `onPriceUpdate` returns
   * `"ignored"` — a SUCCESSFUL RPC — so a stale subscriber needs no special-casing.
   *
   * ── FAILURE HANDLING: ALERT EVERY TIME, PRUNE ON A STREAK ──
   *
   * A delivery that REJECTS is recorded as a `system` alert naming the bot, and
   * its consecutive-failure count is incremented. A SUCCESSFUL delivery resets
   * that count to zero, so only an unbroken run of failures accumulates.
   *
   * At `MAX_FANOUT_FAILURES` in a row the subscriber is UNSUBSCRIBED. The old
   * behaviour never pruned at all, on the reasoning that a fan-out exception is
   * usually transient and auto-pruning a live bot would silently blind its
   * stop-loss. That reasoning holds for ONE failure and is what the streak
   * requirement preserves -- but it left no path out for a permanently dead
   * subscriber, and the comment that once stood here deferred that case to
   * "section 9 reconciliation's concern". No such reconciliation was ever
   * written. The result, measured: six halted and stopped bots still holding
   * live subscriber rows, each keeping its feed's alarm chain alive with nothing
   * listening.
   *
   * Pruning the LAST subscriber takes the feed down through `unsubscribe`'s own
   * `stopFeed`, which is the point -- that is the leak closing.
   */
  async #fanOut(price: Price): Promise<void> {
    const ids = this.#subscriberIds();
    if (ids.length === 0) return;

    const results = await Promise.allSettled(ids.map((id) => this.#deps.deliver(id, price)));

    // Collected, then acted on after the loop: `unsubscribe` can call
    // `stopFeed`, and tearing the feed down while still deciding what to do
    // about the other subscribers would read their state mid-teardown.
    const doomed: string[] = [];
    // The bots whose streak this candle ENDED, for the same reason `doomed` is
    // collected rather than acted on inline: these are D1 writes, and the loop
    // above is the one place this object handles delivery outcomes.
    const recovered: string[] = [];

    for (let i = 0; i < results.length; i++) {
      const id = ids[i]!;
      const result = results[i]!;

      if (result.status === "fulfilled") {
        // Includes a non-running bot's `"ignored"` -- a successful RPC. A
        // subscriber that can be reached is healthy whatever it did with the
        // price.
        //
        // READ BEFORE THE RESET, and gated on it, because the reset is what
        // erases the evidence that this bot had open rows -- the same ordering
        // `#ensureConnected` needs around `blindSince`. The gate is also what
        // keeps this off the hot path: the overwhelming majority of deliveries
        // succeed with a streak already at zero, and those must cost no D1 read
        // at all. Only a bot that was actually failing pays for one.
        if (this.#failuresFor(id) !== 0) recovered.push(id);
        this.#resetFailures(id);
        continue;
      }

      const reason = result.reason as Error | undefined;
      const failures = this.#recordFailure(id);
      await this.#alert(
        "warning",
        "system",
        "price_feed_fanout_failed",
        `delivering a price to bot ${id} failed ` +
          `(${failures} consecutive, pruned at ${MAX_FANOUT_FAILURES}): ` +
          `${reason?.message ?? String(result.reason)}`,
        id,
      );
      if (failures >= MAX_FANOUT_FAILURES) doomed.push(id);
    }

    // BEFORE the pruning loop. NOT because it would break otherwise -- it would
    // not, and the weaker claim is the true one: a pass with a recovery has at
    // least one live subscriber, so the pruning below cannot empty the registry,
    // so `unsubscribe`'s zero-check cannot reach `stopFeed` and clear the config
    // that `#alertSource()` is built from. That safety is a property of
    // `unsubscribe`, though, not of anything here, and it is exactly the kind of
    // argument a later change to the zero-check would invalidate silently -- the
    // rows would simply stop matching, under the bare `price-feed` source, with
    // nothing to notice. Ordering it here costs nothing and does not depend on
    // that argument holding. It is also the file's existing rule: recovery
    // first, reporting second, as `#resolveBlind` sits after the subscribe frame
    // and the alarm.
    for (const id of recovered) await this.#resolveFanoutFailures(id);

    for (const id of doomed) {
      // Alerted BEFORE the unsubscribe, while `#configLabel()` can still name
      // the market -- dropping the last subscriber clears the config.
      await this.#alert(
        "warning",
        "system",
        "price_feed_subscriber_pruned",
        `bot ${id} failed ${MAX_FANOUT_FAILURES} consecutive price deliveries on ` +
          `${this.#configLabel()} and has been unsubscribed. It receives no further prices ` +
          `until it is resumed, which re-subscribes it. If this bot is running, its ` +
          `stop-loss is no longer being evaluated and it needs a human.`,
        id,
      );
      await this.unsubscribe(id);
    }
  }

  /** The production delivery: a cross-DO RPC to the bot's `onPriceUpdate`. */
  async #deliverToBot(botInstanceId: string, price: Price): Promise<unknown> {
    const namespace = this.env.BOT_INSTANCE;
    if (namespace === undefined) {
      throw new Error("no BOT_INSTANCE binding; cannot deliver a price to a subscriber");
    }
    return namespace.get(namespace.idFromName(botInstanceId)).onPriceUpdate(price);
  }

  #subscriberIds(): string[] {
    return this.ctx.storage.sql
      .exec<{ bot_instance_id: string }>("SELECT bot_instance_id FROM subscribers")
      .toArray()
      .map((row) => row.bot_instance_id);
  }

  #subscriberCount(): number {
    return this.ctx.storage.sql
      .exec<{ n: number }>("SELECT COUNT(*) AS n FROM subscribers")
      .one().n;
  }

  /** One subscriber's consecutive failures, or 0 if it is not (or no longer) one. */
  #failuresFor(botInstanceId: string): number {
    const rows = this.ctx.storage.sql
      .exec<{ consecutive_failures: number }>(
        "SELECT consecutive_failures FROM subscribers WHERE bot_instance_id = ?",
        botInstanceId,
      )
      .toArray();
    return rows[0]?.consecutive_failures ?? 0;
  }

  /** Count one failed delivery and return the new streak length. */
  #recordFailure(botInstanceId: string): number {
    this.ctx.storage.sql.exec(
      "UPDATE subscribers SET consecutive_failures = consecutive_failures + 1 " +
        "WHERE bot_instance_id = ?",
      botInstanceId,
    );
    return this.#failuresFor(botInstanceId);
  }

  /** Clear a subscriber's streak. A no-op for one already at zero. */
  #resetFailures(botInstanceId: string): void {
    this.ctx.storage.sql.exec(
      "UPDATE subscribers SET consecutive_failures = 0 " +
        "WHERE bot_instance_id = ? AND consecutive_failures != 0",
      botInstanceId,
    );
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * The one place this object's alarm is set or cleared.
   *
   * `null` means DISARM, mirroring `BotInstance`'s `#armAlarm`. Before this the
   * signature was non-nullable and there was no disarm branch at all: the only
   * `deleteAlarm` in the file was inlined at the end of `stopFeed`, so every
   * other path could re-arm and none could stand down. A timer with no way to
   * stop is the shape of the leak.
   *
   * Reads the current alarm first and writes only on a change, so a re-arm to
   * the same instant is not a storage write.
   */
  async #armAlarm(at: Timestamp | null): Promise<void> {
    const current = await this.ctx.storage.getAlarm();
    if (at === null) {
      if (current !== null) await this.ctx.storage.deleteAlarm();
      return;
    }
    if (current !== at) await this.ctx.storage.setAlarm(at);
  }

  async #persist(): Promise<void> {
    await this.ctx.storage.put(STATE_KEY, this.#state);
  }

  /**
   * The `alerts.source` this feed writes, spelled ONCE.
   *
   * Both halves of the frozen-value lifecycle depend on agreeing about it:
   * `#alert` writes it and `#resolveFrozen` reads it back in a WHERE clause. A
   * second copy of the format is the exact duplicated-definition bug
   * `shared/alert-types.ts` exists to prevent, and it would fail silently --
   * rows that are raised and never closed.
   */
  #alertSource(): string {
    const config = this.#state.config;
    return config === null ? "price-feed" : `price-feed:${config.exchange}:${config.pair}`;
  }

  #configLabel(): string {
    const config = this.#state.config;
    return config === null ? "an unconfigured feed" : `${config.exchange}:${config.pair}`;
  }

  /**
   * Record a feed-level alert in D1 (section 10). The outbound notification is
   * the dispatcher's separate job, exactly as `BotInstance.#alert` leaves it.
   *
   * ── `botInstanceId` IS NOW PASSED WHERE ONE IS KNOWN ──
   *
   * This used to hardcode `bot_instance_id: null` on every row, with the failing
   * bot's id interpolated into the free-text `message` and nowhere else. The
   * stated reason was that the column is a foreign key into `bot_instances` and
   * an orphaned or DELETED bot would violate it. There is no bot-deletion path
   * anywhere in this system -- bots are archived, never removed -- so every id
   * reaching here resolves, and the column stayed null for a case that cannot
   * happen. The cost was real: `price_feed_fanout_failed` could not be joined,
   * filtered, or counted per bot, and did not appear on its bot's detail page.
   *
   * The fallback below is not defending that old reasoning; it is defending the
   * hot path. This runs inside `#fanOut`, and a throw here would propagate out
   * through `#forwardClosed` before the watermark advances -- turning a
   * constraint failure into a stuck, endlessly-retried candle. An alert is this
   * object's only voice, so losing its attribution beats losing the alert.
   */
  async #alert(
    severity: AlertRow["severity"],
    category: AlertRow["category"],
    alertType: string,
    message: string,
    botInstanceId: string | null = null,
  ): Promise<void> {
    const row: AlertRow = {
      id: crypto.randomUUID(),
      severity,
      category,
      alert_type: alertType,
      bot_instance_id: botInstanceId,
      source: this.#alertSource(),
      message,
      resolved: false,
      created_at: this.#deps.now(),
      notified_at: null,
    };
    const db = databaseFrom(this.env);
    try {
      await db.alerts.insert(row);
    } catch (error) {
      if (botInstanceId === null) throw error;
      // The id is in `message` either way, so the row is still readable by a
      // human -- it just cannot be joined on.
      await db.alerts.insert({ ...row, bot_instance_id: null });
    }
  }
}
