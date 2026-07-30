/**
 * Tests for the TEMPORARY `/api/debug/ws-check` diagnostic (decision-log 14.6,
 * Tier 0). DELETE this file when the route is removed after its one confirming run.
 *
 * Discipline, per section 14: the suite makes NO live call. `runWsCheck`'s transport
 * (`connect`) and timing (`wait`) are injected, so a mock socket delivers captured
 * frames synchronously and the 10s listen window resolves instantly. The real
 * edge→Gemini handshake is proven only by running the deployed route once, live —
 * these tests prove the route's LOGIC, not the wire.
 */

import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { handleApiRequest } from "./index";
import {
  messageType,
  runWsCheck,
  type WsCheckConnect,
  type WsCheckHandlers,
} from "./debug-ws-check";

/** The listen window never actually elapses in tests. */
const immediateWait = async (): Promise<void> => {};

/**
 * A mock socket that, when the diagnostic sends its subscribe frame, synchronously
 * replays `frames` back through `onMessage` — so the tally is complete before the
 * (immediate) `wait` resolves. Captures what was sent so the subscribe frame can be
 * asserted.
 */
function mockConnect(frames: string[]): { connect: WsCheckConnect; sent: string[]; closed: () => boolean } {
  const sent: string[] = [];
  let didClose = false;
  const connect: WsCheckConnect = async (_url, handlers: WsCheckHandlers) => ({
    send: (data) => {
      sent.push(data);
      for (const frame of frames) handlers.onMessage(frame);
    },
    close: () => {
      didClose = true;
    },
  });
  return { connect, sent, closed: () => didClose };
}

const HEARTBEAT = JSON.stringify({ type: "heartbeat", socket_sequence: 1 });
const CANDLES = JSON.stringify({
  type: "candles_1m_updates",
  symbol: "BTCUSD",
  changes: [[1_760_000_000_000, "60000", "60010", "59990", "60005", "1.5"]],
});

describe("runWsCheck (Tier 0 route logic, mocked socket)", () => {
  it("reports a PASS: opened, frames tallied, first type, and a candles update", async () => {
    // heartbeat FIRST, so `firstMessageType` is genuinely the first frame, not just
    // whichever frame happened to be a candle.
    const mock = mockConnect([HEARTBEAT, CANDLES]);
    const result = await runWsCheck("wss://feed.example", "SUBSCRIBE", {
      connect: mock.connect,
      wait: immediateWait,
    });

    expect(result).toStrictEqual({
      connectionOpened: true,
      messagesReceived: 2,
      firstMessageType: "heartbeat",
      candlesUpdateReceived: true,
      error: null,
    });
    // The subscribe frame was sent, and the socket was released.
    expect(mock.sent).toStrictEqual(["SUBSCRIBE"]);
    expect(mock.closed()).toBe(true);
  });

  it("reports a FAIL when the connection never opens (edge geo-blocked)", async () => {
    const connect: WsCheckConnect = async () => {
      throw new Error("451: unavailable from a restricted location");
    };
    const result = await runWsCheck("wss://feed.example", "SUBSCRIBE", {
      connect,
      wait: immediateWait,
    });

    expect(result.connectionOpened).toBe(false);
    expect(result.messagesReceived).toBe(0);
    expect(result.candlesUpdateReceived).toBe(false);
    expect(result.error).toContain("451");
  });

  it("reports a FAIL when it opens but no candles_1m_updates arrives (wrong feed / timeout)", async () => {
    // Only heartbeats — connection is up, but no real market data. This is the
    // "opens but times out with zero relevant messages" signal from the request.
    const mock = mockConnect([HEARTBEAT, HEARTBEAT]);
    const result = await runWsCheck("wss://feed.example", "SUBSCRIBE", {
      connect: mock.connect,
      wait: immediateWait,
    });

    expect(result.connectionOpened).toBe(true);
    expect(result.messagesReceived).toBe(2);
    expect(result.candlesUpdateReceived).toBe(false);
    expect(result.firstMessageType).toBe("heartbeat");
  });

  it("reports a FAIL when it opens and receives nothing at all", async () => {
    const mock = mockConnect([]);
    const result = await runWsCheck("wss://feed.example", "SUBSCRIBE", {
      connect: mock.connect,
      wait: immediateWait,
    });

    expect(result.connectionOpened).toBe(true);
    expect(result.messagesReceived).toBe(0);
    expect(result.firstMessageType).toBeNull();
    expect(result.candlesUpdateReceived).toBe(false);
    expect(mock.closed()).toBe(true);
  });
});

describe("messageType (raw wire type, not the codec's interpretation)", () => {
  it("reads a string `type`", () => {
    expect(messageType(CANDLES)).toBe("candles_1m_updates");
    expect(messageType(HEARTBEAT)).toBe("heartbeat");
  });

  it("is null for a frame with no string `type`", () => {
    expect(messageType(JSON.stringify({ changes: [] }))).toBeNull();
    expect(messageType(JSON.stringify({ type: 7 }))).toBeNull();
  });

  it("is null for a non-object or non-JSON frame", () => {
    expect(messageType("not json")).toBeNull();
    expect(messageType(JSON.stringify("a string"))).toBeNull();
    expect(messageType(JSON.stringify(null))).toBeNull();
  });
});

describe("the route is gated behind the same authenticate() as every /api/* route", () => {
  it("rejects an unauthenticated request BEFORE reaching the socket (401)", async () => {
    // No Cf-Access-Jwt-Assertion header: authenticate() throws before the diagnostic
    // block runs, so an unauthenticated caller never opens any outbound connection.
    const request = new Request("https://dash.example.com/api/debug/ws-check");
    const response = await handleApiRequest(request, env);
    expect(response.status).toBe(401);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("access_jwt_missing");
  });
});
