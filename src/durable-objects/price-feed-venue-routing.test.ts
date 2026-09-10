/**
 * WHICH EXCHANGE DOES A FEED ACTUALLY TALK TO -- the regression test for the
 * misrouting bug, at the Durable Object level rather than the codec level.
 *
 * `PriceFeed` built one `GeminiPriceFeedCodec` in a field initialiser and never
 * consulted its own `config.exchange` for anything but an alert label. So a
 * `kraken:BTCUSDT` feed opened Gemini's socket, sent Gemini's subscribe frame,
 * and forwarded Gemini's prices to bots placing real Kraken orders. Every unit
 * test passed throughout: they all configured `exchange: "gemini"`, which was
 * the one venue the hardcoded codec happened to be right for.
 *
 * These tests configure a feed as KRAKEN and assert on what actually leaves and
 * enters the object -- the URL it dials, the frame it sends, and whose payload
 * format it can read. They fail on the old code.
 *
 * `ENVIRONMENT` is `testnet` here (vitest.config.ts pins the testnet Wrangler
 * environment), which is why Gemini resolves to its sandbox host while Kraken
 * resolves to its single real one -- Kraken publishes no sandbox, and a feed is
 * a credential-free read (see `kraken/price-feed.ts`).
 */

import { beforeEach, describe, expect, it } from "vitest";

import type { Database } from "../db/database";
import { freshDatabase } from "../db/test-helpers";
import { fromDecimalString as m } from "../shared/money";
import type { Price } from "../shared/exchange-client";
import type { FeedSocket, PriceFeed, SocketHandlers } from "./price-feed";
import { inFeed } from "./test-helpers";

const NOW = 1_789_062_300_000; // 2026-09-10T17:45:00Z, after the captured frames

const KRAKEN_CONFIG = { exchange: "kraken", pair: "BTCUSDT" } as const;
const GEMINI_CONFIG = { exchange: "gemini", pair: "BTCUSD" } as const;

/** The real Kraken v2 snapshot captured 2026-09-10; newest row opens 17:43. */
const KRAKEN_SNAPSHOT =
  '{"channel":"ohlc","type":"snapshot","timestamp":"2026-09-10T17:44:43.105760475Z","data":[' +
  '{"symbol":"BTC/USDT","open":77363.9,"high":77363.9,"low":77324.6,"close":77326.4,"trades":5,"volume":0.03288232,"vwap":77335.4,"interval_begin":"2026-09-10T17:40:00.000000000Z","interval":1,"timestamp":"2026-09-10T17:41:00.000000Z"},' +
  '{"symbol":"BTC/USDT","open":77357.1,"high":77370.1,"low":77357.1,"close":77370.1,"trades":2,"volume":0.00208254,"vwap":77369.2,"interval_begin":"2026-09-10T17:41:00.000000000Z","interval":1,"timestamp":"2026-09-10T17:42:00.000000Z"},' +
  '{"symbol":"BTC/USDT","open":77351.6,"high":77351.6,"low":77327.3,"close":77340.1,"trades":17,"volume":1.29749671,"vwap":77343.9,"interval_begin":"2026-09-10T17:43:00.000000000Z","interval":1,"timestamp":"2026-09-10T17:44:00.000000Z"}]}';

/**
 * The next minute's `update`, in the captured frame's exact shape (a
 * single-row, current-only update -- the rollover behaviour measured live).
 * Its arrival is what closes the 17:43 candle.
 */
const KRAKEN_UPDATE_1744 =
  '{"channel":"ohlc","type":"update","timestamp":"2026-09-10T17:44:12.114514810Z","data":[' +
  '{"symbol":"BTC/USDT","open":77340.1,"high":77361.0,"low":77340.1,"close":77358.4,"trades":6,' +
  '"volume":0.10422131,"vwap":77349.5,"interval_begin":"2026-09-10T17:44:00.000000000Z",' +
  '"interval":1,"timestamp":"2026-09-10T17:45:00.000000Z"}]}';

/** A Gemini frame — the format these feeds were wrongly being fed all along. */
const GEMINI_FRAME = JSON.stringify({
  type: "candles_1m_updates",
  symbol: "BTCUSDT",
  changes: [[1_789_062_180_000, 77223.56, 77223.56, 77223.56, 77223.56, 0]],
});

let counter = 0;
const freshKey = () => `routing:${counter++}`;

let db: Database;
beforeEach(async () => {
  db = await freshDatabase();
});

/** A `connect` that records the URL it was asked for and hands back a socket. */
function capturingConnect() {
  const urls: string[] = [];
  const sockets: FakeSocket[] = [];
  return {
    urls,
    sockets,
    connect: async (url: string, handlers: SocketHandlers): Promise<FeedSocket> => {
      urls.push(url);
      const socket = new FakeSocket(handlers);
      sockets.push(socket);
      return socket;
    },
  };
}

class FakeSocket implements FeedSocket {
  readonly sent: string[] = [];
  closed = false;
  readonly #handlers: SocketHandlers;
  constructor(handlers: SocketHandlers) {
    this.#handlers = handlers;
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.closed = true;
  }
  async deliver(raw: string): Promise<void> {
    await this.#handlers.onMessage(raw);
  }
}

describe("a feed configured for kraken talks to KRAKEN", () => {
  it("dials Kraken's v2 socket, not Gemini's", async () => {
    const fake = capturingConnect();
    await inFeed(freshKey(), async (feed: PriceFeed) => {
      feed.attach({ now: () => NOW, forward: async () => {}, connect: fake.connect });
      await feed.startFeed(KRAKEN_CONFIG);
    });

    expect(fake.urls).toHaveLength(1);
    expect(new URL(fake.urls[0]!).host).toBe("ws.kraken.com");
    expect(fake.urls[0]).not.toContain("gemini");
  });

  it("sends Kraken's ohlc subscribe frame with the slashed ISO-A3 symbol", async () => {
    const fake = capturingConnect();
    await inFeed(freshKey(), async (feed: PriceFeed) => {
      feed.attach({ now: () => NOW, forward: async () => {}, connect: fake.connect });
      await feed.startFeed(KRAKEN_CONFIG);
    });

    expect(JSON.parse(fake.sockets[0]!.sent[0]!)).toStrictEqual({
      method: "subscribe",
      params: { channel: "ohlc", symbol: ["BTC/USDT"], interval: 1 },
    });
  });

  it("parses Kraken's real frames and forwards the closed candle's price", async () => {
    const forwarded: Price[] = [];
    const fake = capturingConnect();
    await inFeed(freshKey(), async (feed: PriceFeed) => {
      feed.attach({
        now: () => NOW,
        forward: async (p) => void forwarded.push(p),
        connect: fake.connect,
      });
      await feed.startFeed(KRAKEN_CONFIG);
      // Snapshot primes (forwards no history on a first connect); the 17:44
      // update is a newer minute, which closes and forwards 17:43.
      await fake.sockets[0]!.deliver(KRAKEN_SNAPSHOT);
      await fake.sockets[0]!.deliver(KRAKEN_UPDATE_1744);
    });

    expect(forwarded).toHaveLength(1);
    expect(forwarded[0]!.pair).toBe("BTCUSDT");
    expect(forwarded[0]!.price).toBe(m("77340.10000000"));
  });

  it("CANNOT read a Gemini frame — it forwards nothing and records it malformed", async () => {
    // The exact regression. On the old code this frame parsed cleanly and its
    // price (Gemini's 77223.56, a number Kraken never printed) was forwarded to
    // every bot on the pair.
    const forwarded: Price[] = [];
    const fake = capturingConnect();
    await inFeed(freshKey(), async (feed: PriceFeed) => {
      feed.attach({
        now: () => NOW,
        forward: async (p) => void forwarded.push(p),
        connect: fake.connect,
      });
      await feed.startFeed(KRAKEN_CONFIG);
      await fake.sockets[0]!.deliver(GEMINI_FRAME);
    });

    expect(forwarded).toStrictEqual([]);
    const alerts = await db.alerts.findMany({ where: { alert_type: "price_feed_malformed" } });
    expect(alerts.length).toBeGreaterThan(0);
  });

  it("surfaces a rejected Kraken subscription instead of going quiet forever", async () => {
    const fake = capturingConnect();
    await inFeed(freshKey(), async (feed: PriceFeed) => {
      feed.attach({ now: () => NOW, forward: async () => {}, connect: fake.connect });
      await feed.startFeed(KRAKEN_CONFIG);
      await fake.sockets[0]!.deliver(
        '{"error":"Currency pair not supported XBT/USDT","method":"subscribe",' +
          '"success":false,"symbol":"XBT/USDT","time_in":"2026-09-10T17:44:44.609516Z",' +
          '"time_out":"2026-09-10T17:44:44.609555Z"}',
      );
    });

    const alerts = await db.alerts.findMany({ where: { alert_type: "price_feed_malformed" } });
    expect(alerts.length).toBeGreaterThan(0);
    expect(alerts[0]!.message).toContain("Currency pair not supported");
  });
});

describe("a feed configured for gemini still talks to GEMINI", () => {
  it("dials Gemini's sandbox socket under the testnet environment", async () => {
    const fake = capturingConnect();
    await inFeed(freshKey(), async (feed: PriceFeed) => {
      feed.attach({ now: () => NOW, forward: async () => {}, connect: fake.connect });
      await feed.startFeed(GEMINI_CONFIG);
    });

    expect(new URL(fake.urls[0]!).host).toBe("api.sandbox.gemini.com");
    expect(JSON.parse(fake.sockets[0]!.sent[0]!)).toStrictEqual({
      type: "subscribe",
      subscriptions: [{ name: "candles_1m", symbols: ["BTCUSD"] }],
    });
  });

  it("still parses Gemini's own frames", async () => {
    // Both frames carry `symbol: "BTCUSD"`, matching this feed's pair: Gemini's
    // codec runs the same spec-5.7 attribution check Kraken's does, and would
    // (correctly) reject a BTCUSDT frame on a BTCUSD feed as malformed.
    const geminiFrame = (openTime: number, close: number) =>
      JSON.stringify({
        type: "candles_1m_updates",
        symbol: "BTCUSD",
        changes: [[openTime, close, close, close, close, 0.5]],
      });

    const forwarded: Price[] = [];
    const fake = capturingConnect();
    await inFeed(freshKey(), async (feed: PriceFeed) => {
      feed.attach({
        now: () => NOW,
        forward: async (p) => void forwarded.push(p),
        connect: fake.connect,
      });
      await feed.startFeed(GEMINI_CONFIG);
      // Primes on the first frame (no history forwarded on a first connect);
      // the newer minute then closes and forwards it.
      await fake.sockets[0]!.deliver(geminiFrame(1_789_062_180_000, 77223.56));
      await fake.sockets[0]!.deliver(geminiFrame(1_789_062_240_000, 77300.0));
    });

    expect(forwarded).toHaveLength(1);
    expect(forwarded[0]!.price).toBe(m("77223.56000000"));
  });
});

describe("a venue with no codec fails loudly rather than borrowing one", () => {
  it("opens NO socket for binance instead of connecting to Gemini", async () => {
    const fake = capturingConnect();
    await inFeed(freshKey(), async (feed: PriceFeed) => {
      feed.attach({ now: () => NOW, forward: async () => {}, connect: fake.connect });
      await feed.startFeed({ exchange: "binance", pair: "BTCUSDT" });
    });

    // The old code would have dialled Gemini here without a word.
    expect(fake.urls).toStrictEqual([]);
    expect(fake.sockets).toStrictEqual([]);
  });
});
