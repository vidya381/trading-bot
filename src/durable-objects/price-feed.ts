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
}

const INITIAL_STATE: PersistedFeedState = {
  config: null,
  watermark: null,
  reconnectAttempts: 0,
  blindSince: null,
  escalated: false,
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
      if (stored !== undefined) this.#state = stored;
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

    this.#state = { ...this.#state, watermark: candle.closeTime };
    await this.#persist();
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
    // A successful open clears any backoff/blind state from a prior outage.
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

    for (let i = 0; i < results.length; i++) {
      const id = ids[i]!;
      const result = results[i]!;

      if (result.status === "fulfilled") {
        // Includes a non-running bot's `"ignored"` -- a successful RPC. A
        // subscriber that can be reached is healthy whatever it did with the
        // price.
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
    const config = this.#state.config;
    const row: AlertRow = {
      id: crypto.randomUUID(),
      severity,
      category,
      alert_type: alertType,
      bot_instance_id: botInstanceId,
      source: config === null ? "price-feed" : `price-feed:${config.exchange}:${config.pair}`,
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
