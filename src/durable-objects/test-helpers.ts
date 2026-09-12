/**
 * Test-only helpers for the Durable Objects.
 *
 * Not exported from `index.ts` and never imported by a Worker, so esbuild never
 * bundles it -- the same arrangement as `/src/db/test-helpers.ts`.
 */

import { env, runInDurableObject } from "cloudflare:test";
import type { BotInstance } from "./bot-instance";
import type { RateLimiter } from "./rate-limiter";
import type { PriceFeed, PriceFeedConfig, PriceFeedPort, PriceFeedStatus } from "./price-feed";

/**
 * A price-feed port that does nothing — for tests that drive a bot's lifecycle
 * but not its feed wiring. It MUST be injected wherever a test reaches a status
 * transition, because the real `PRICE_FEED` binding's `subscribe` opens a live
 * socket, exactly as `FakeExchange` is injected in place of the real client.
 */
export const noopFeed: PriceFeedPort = {
  subscribe: async () => {},
  unsubscribe: async () => {},
  status: async () => healthyFeedStatus(),
};

/**
 * A feed that is connected, subscribed, and has JUST forwarded something.
 *
 * ⚠ THE DEFAULT IS DELIBERATELY THE ONE THAT SUPPRESSES NOTHING. A bot's
 * staleness check now asks the feed whether it had anything to send; a double
 * answering "I have never forwarded anything" would silence
 * `price_updates_stale` across every test that injects a feed without caring
 * about one, including the tests that exist to prove the alert still fires.
 *
 * So the default says the feed is healthy AND current, which is the reading
 * under which the bot's own staleness is entirely the bot's own problem -- the
 * behaviour every pre-existing test was written against. A test that wants the
 * other case asks for it explicitly.
 */
export function healthyFeedStatus(overrides: Partial<PriceFeedStatus> = {}): PriceFeedStatus {
  return {
    config: null,
    connected: true,
    alarmAt: null,
    stopped: false,
    watermark: null,
    // `Date.now()` rather than a fixed instant: a bot compares this against its
    // own clock, and a constant would age into the past as a suite runs.
    lastForwardAt: Date.now(),
    reconnectAttempts: 0,
    blindSince: null,
    escalated: false,
    subscriberCount: 1,
    subscribers: [],
    ...overrides,
  };
}

/**
 * A feed whose `status()` a test can move between passes.
 *
 * For the staleness verdict, which is now a COMPARISON between a bot and its
 * feed rather than a timeout on the bot alone. A fixed double could only ever
 * express one side of that, so the tests that care set this directly.
 */
export function mutableFeed(initial: Partial<PriceFeedStatus> = {}): {
  readonly port: PriceFeedPort;
  status: PriceFeedStatus;
} {
  const holder: { port: PriceFeedPort; status: PriceFeedStatus } = {
    status: healthyFeedStatus(initial),
    port: {
      subscribe: async () => {},
      unsubscribe: async () => {},
      status: async () => holder.status,
    },
  };
  return holder;
}

/** A recording price-feed port, for the step 14 D wiring tests. */
export function recordingFeed(): {
  readonly port: PriceFeedPort;
  readonly subscribes: Array<{ botInstanceId: string; config: PriceFeedConfig }>;
  readonly unsubscribes: string[];
} {
  const subscribes: Array<{ botInstanceId: string; config: PriceFeedConfig }> = [];
  const unsubscribes: string[] = [];
  return {
    subscribes,
    unsubscribes,
    port: {
      subscribe: async (botInstanceId, config) => void subscribes.push({ botInstanceId, config }),
      unsubscribe: async (botInstanceId) => void unsubscribes.push(botInstanceId),
      status: async () => healthyFeedStatus(),
    },
  };
}

/**
 * The `BOT_INSTANCE` namespace, narrowed.
 *
 * `wrangler types` emits this as optional on the base env, correctly: the base
 * config block in wrangler.jsonc declares no Durable Object binding, so a
 * Worker deployed without `--env` genuinely has none. Tests are pinned to the
 * testnet environment (step 1, decision 6), where it is always present. This
 * checks rather than asserts, so losing that pinning says so in one line
 * instead of surfacing as a null dereference somewhere further in.
 */
export function botInstanceNamespace(): DurableObjectNamespace<BotInstance> {
  const binding = env.BOT_INSTANCE;
  if (binding === undefined) {
    throw new Error(
      "no BOT_INSTANCE binding in the test environment. vitest.config.ts pins " +
        "tests to the testnet environment, which declares one in wrangler.jsonc; " +
        "check that pinning is still in place.",
    );
  }
  return binding;
}

/** A stub for a bot instance id, which doubles as the Durable Object's name. */
export function botStub(botInstanceId: string): DurableObjectStub<BotInstance> {
  const namespace = botInstanceNamespace();
  return namespace.get(namespace.idFromName(botInstanceId));
}

/**
 * Run `body` inside a `BotInstance`, with the instance typed as one.
 *
 * The cast is the whole reason this exists, and it is worth explaining rather
 * than spreading across every test file.
 *
 * `runInDurableObject` constrains its object to `DurableObject<Cloudflare.Env>`.
 * `BotInstance` extends `DurableObject<Env>` -- the Worker's own environment,
 * NOT `Cloudflare.Env`. That difference is deliberate and predates this step:
 * step 4 augmented the `Cloudflare.Env` namespace rather than the global `Env`
 * specifically so test-only bindings (`TEST_MIGRATIONS`) stay invisible while
 * typechecking Worker source. The two types therefore do not unify, and without
 * an explicit type argument TypeScript falls back to the constraint, at which
 * point the instance has no methods on it at all.
 *
 * So the cast is a consequence of a property worth keeping, isolated here.
 */
export async function inBot<T>(
  botInstanceId: string,
  body: (bot: BotInstance, state: DurableObjectState) => Promise<T>,
): Promise<T> {
  return await runInDurableObject(botStub(botInstanceId), async (instance, state) =>
    body(instance as unknown as BotInstance, state),
  );
}

// ---------------------------------------------------------------------------
// The RateLimiter (section 5.4), step 8
// ---------------------------------------------------------------------------

/** The `RATE_LIMITER` namespace, narrowed. See `botInstanceNamespace`. */
export function rateLimiterNamespace(): DurableObjectNamespace<RateLimiter> {
  const binding = env.RATE_LIMITER;
  if (binding === undefined) {
    throw new Error(
      "no RATE_LIMITER binding in the test environment. vitest.config.ts pins " +
        "tests to the testnet environment, which declares one in wrangler.jsonc; " +
        "check that pinning is still in place.",
    );
  }
  return binding;
}

/**
 * A stub for one exchange account's limiter.
 *
 * The name IS the account label, which is the whole of section 5.4's "one per
 * exchange account": two bots on one account resolve to the same object and
 * therefore contend for one budget, and two accounts cannot.
 */
export function rateLimiterStub(accountLabel: string): DurableObjectStub<RateLimiter> {
  const namespace = rateLimiterNamespace();
  return namespace.get(namespace.idFromName(accountLabel));
}

/** Run `body` inside a `RateLimiter`. The cast is the same one `inBot` explains. */
export async function inLimiter<T>(
  accountLabel: string,
  body: (limiter: RateLimiter, state: DurableObjectState) => Promise<T>,
): Promise<T> {
  return await runInDurableObject(rateLimiterStub(accountLabel), async (instance, state) =>
    body(instance as unknown as RateLimiter, state),
  );
}

// ---------------------------------------------------------------------------
// The PriceFeed (section 4.6), step 14
// ---------------------------------------------------------------------------

/** The `PRICE_FEED` namespace, narrowed. See `botInstanceNamespace`. */
export function priceFeedNamespace(): DurableObjectNamespace<PriceFeed> {
  const binding = env.PRICE_FEED;
  if (binding === undefined) {
    throw new Error(
      "no PRICE_FEED binding in the test environment. vitest.config.ts pins " +
        "tests to the testnet environment, which declares one in wrangler.jsonc; " +
        "check that pinning is still in place.",
    );
  }
  return binding;
}

/**
 * A stub for one (exchange, pair) feed. The name IS `"<exchange>:<pair>"`, which
 * is the whole of "one shared feed per market": two bots on the same pair resolve
 * to the same object and share its one socket.
 */
export function priceFeedStub(key: string): DurableObjectStub<PriceFeed> {
  const namespace = priceFeedNamespace();
  return namespace.get(namespace.idFromName(key));
}

/** Run `body` inside a `PriceFeed`. The cast is the same one `inBot` explains. */
export async function inFeed<T>(
  key: string,
  body: (feed: PriceFeed, state: DurableObjectState) => Promise<T>,
): Promise<T> {
  return await runInDurableObject(priceFeedStub(key), async (instance, state) =>
    body(instance as unknown as PriceFeed, state),
  );
}
