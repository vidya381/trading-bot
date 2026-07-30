/**
 * TEMPORARY DIAGNOSTIC — `GET /api/debug/ws-check`. DELETE AFTER ONE CONFIRMING RUN.
 *
 * This is the step 14 / decision-log 14.6 **Tier 0** gate (spec §4.6; step 11 Q4;
 * step 13 "Tier 0"): confirm that Cloudflare's EDGE can actually open an outbound
 * WebSocket to Gemini's sandbox marketdata feed and receive real `candles_1m`
 * frames — the same "451 killed Binance" geo-block risk, re-checked for Gemini —
 * INDEPENDENT of the `PriceFeed` Durable Object. If the edge cannot reach the feed,
 * nothing downstream (the DO, the fan-out, live trading) can work, so this is the
 * one question that must be answered before anything else proceeds.
 *
 * It is NOT a feature, a health probe, or a monitoring endpoint. It exists to answer
 * one question once, live, from the deployed testnet Worker, and is to be removed
 * immediately after a single confirming request — exactly like the earlier, since-
 * removed `/api/debug/exchange-check` (decision-log 03).
 *
 * ── REMOVAL (do this right after the one confirming run) ──────────────────────
 *   1. Delete this file (`src/api/debug-ws-check.ts`).
 *   2. Delete its test (`src/api/debug-ws-check.test.ts`).
 *   3. Delete the marked `TEMPORARY DIAGNOSTIC` block AND the `handleWsCheck`
 *      import in `src/api/index.ts`.
 *   4. Note the removal (commit hash) in decision-log 14.6, as 03 did.
 *
 * ── Safety ───────────────────────────────────────────────────────────────────
 * Read-only market data only. It opens no order path, imports nothing that signs a
 * request, and touches no credentials — the feed is public. It is gated behind the
 * same Cloudflare Access + JWT check as every other `/api/*` route (it is wired
 * AFTER `authenticate()` in index.ts), so no new Access surface is added.
 */

import { GeminiPriceFeedCodec } from "../exchange/gemini/price-feed";
import type { Pair } from "../shared/exchange-client";

/** The probe pair. The request fixes this to BTCUSD, the sandbox's liquid market. */
const PROBE_PAIR = "BTCUSD" as Pair;

/** How long to listen after subscribing, in ms (the request's "~10 seconds"). */
const LISTEN_MS = 10_000;

/** The minimal socket surface the diagnostic drives; the transport is injected. */
export interface WsCheckSocket {
  send(data: string): void;
  close(): void;
}

/** How an opened socket delivers events back to the diagnostic. */
export interface WsCheckHandlers {
  onMessage: (raw: string) => void;
  onClose: () => void;
}

/** Open the outbound socket. Rejects/throws if the connection cannot be made. */
export type WsCheckConnect = (url: string, handlers: WsCheckHandlers) => Promise<WsCheckSocket>;

/** The JSON summary the route returns (plus `url`/`pair` context in the Response). */
export interface WsCheckResult {
  /** Did the outbound WebSocket handshake complete? The primary pass/fail signal. */
  readonly connectionOpened: boolean;
  /** How many frames arrived during the listen window. */
  readonly messagesReceived: number;
  /** The `type` of the first frame received, or null if none arrived / it had none. */
  readonly firstMessageType: string | null;
  /** Whether any `candles_1m_updates` frame arrived — the "real market data" signal. */
  readonly candlesUpdateReceived: boolean;
  /** The connect error, when `connectionOpened` is false; null otherwise. */
  readonly error: string | null;
}

/** Seams the automated suite overrides so no live call and no real 10s wait occur. */
export interface WsCheckDeps {
  readonly connect: WsCheckConnect;
  /** Resolves after `ms`; the listen window. Injected so tests need no real timer. */
  readonly wait: (ms: number) => Promise<void>;
  /** The listen window length; defaults to `LISTEN_MS`. */
  readonly listenMs?: number;
}

/**
 * Read a frame's `type` field without interpreting the payload. Null if the frame
 * is not JSON, is not an object, or carries no string `type`. Deliberately does NOT
 * reuse the codec's `parseMessage` — this diagnostic reports the RAW wire `type`,
 * not the codec's interpretation of it.
 */
export function messageType(raw: string): string | null {
  try {
    const msg: unknown = JSON.parse(raw);
    if (typeof msg !== "object" || msg === null) return null;
    const type = (msg as { type?: unknown }).type;
    return typeof type === "string" ? type : null;
  } catch {
    return null;
  }
}

/**
 * The route's core logic: open the socket, send the subscribe frame, listen for the
 * window, and summarise what arrived. Transport and timing are injected so the suite
 * drives it against a mock socket with no live call and no real wait.
 *
 * A connect that throws is the "edge is geo-blocked / cannot reach the feed" fail:
 * `connectionOpened: false` with the error. A connect that succeeds but yields no
 * `candles_1m_updates` frame is the "opened but the market is fed differently than
 * local" fail: `connectionOpened: true`, `candlesUpdateReceived: false`.
 */
export async function runWsCheck(
  url: string,
  subscribeFrame: string,
  deps: WsCheckDeps,
): Promise<WsCheckResult> {
  const listenMs = deps.listenMs ?? LISTEN_MS;
  let messagesReceived = 0;
  let firstMessageType: string | null = null;
  let candlesUpdateReceived = false;

  let socket: WsCheckSocket;
  try {
    socket = await deps.connect(url, {
      onMessage: (raw) => {
        messagesReceived += 1;
        const type = messageType(raw);
        if (messagesReceived === 1) firstMessageType = type;
        if (type === "candles_1m_updates") candlesUpdateReceived = true;
      },
      onClose: () => {},
    });
  } catch (error) {
    return {
      connectionOpened: false,
      messagesReceived: 0,
      firstMessageType: null,
      candlesUpdateReceived: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  try {
    socket.send(subscribeFrame);
    await deps.wait(listenMs);
  } finally {
    // Always release the socket, even if `wait` rejects — this diagnostic must not
    // leave an outbound connection pinned open.
    socket.close();
  }

  return {
    connectionOpened: true,
    messagesReceived,
    firstMessageType,
    candlesUpdateReceived,
    error: null,
  };
}

/**
 * Production transport: an outbound WebSocket via the fetch-Upgrade handshake. This
 * mirrors `PriceFeed`'s `openOutboundSocket` exactly, on purpose — the whole point of
 * Tier 0 is to prove THIS handshake works from the edge, so the diagnostic uses the
 * same one the DO would, just without the DO around it.
 */
async function openWsCheckSocket(url: string, handlers: WsCheckHandlers): Promise<WsCheckSocket> {
  const response = await fetch(url, { headers: { Upgrade: "websocket" } });
  const ws = response.webSocket;
  if (ws === null) {
    throw new Error(
      `ws-check: no WebSocket in the upgrade response for ${url} (status ${response.status})`,
    );
  }
  ws.accept();
  ws.addEventListener("message", (event: MessageEvent) => {
    handlers.onMessage(typeof event.data === "string" ? event.data : "");
  });
  const onClose = () => handlers.onClose();
  ws.addEventListener("close", onClose);
  ws.addEventListener("error", onClose);
  return {
    send: (data) => ws.send(data),
    close: () => {
      try {
        ws.close();
      } catch {
        /* already closed */
      }
    },
  };
}

/**
 * The route handler. Resolves the socket URL AND the real `candles_1m` BTCUSD
 * subscribe frame from the existing `GeminiPriceFeedCodec`, so there is no second
 * copy of Gemini's wire format here: on the testnet Worker `socketUrl("testnet")`
 * is `wss://api.sandbox.gemini.com/v2/marketdata` — the exact sandbox feed the
 * request names and the `PriceFeed` DO would use. Returns the summary as plain JSON;
 * the pass/fail is read from the body (200 either way — the diagnostic itself ran).
 *
 * `deps` is injectable for tests, but production callers pass nothing.
 */
export async function handleWsCheck(env: Env, deps?: Partial<WsCheckDeps>): Promise<Response> {
  const codec = new GeminiPriceFeedCodec();
  const url = codec.socketUrl(env.ENVIRONMENT);
  const subscribeFrame = codec.subscribeMessage(PROBE_PAIR);

  const result = await runWsCheck(url, subscribeFrame, {
    connect: deps?.connect ?? openWsCheckSocket,
    wait: deps?.wait ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    listenMs: deps?.listenMs,
  });

  return Response.json({ url, pair: PROBE_PAIR, ...result });
}
