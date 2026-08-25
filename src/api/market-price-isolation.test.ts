/**
 * THE MARKET PRICE MUST NEVER BECOME A TRADING INPUT.
 *
 * The halted-bot market price is a decoration on one screen. Every calculation
 * in this system -- `unrealizedPnl`, the grid ladder's divider, the stop-loss
 * and breakout checks, every order this bot will ever place -- reads the bot's
 * OWN `lastPrice`, or a `Price` handed to it by its own feed. If the two ever
 * merge, every PnL figure silently changes meaning and a number fetched for a
 * human to look at starts sizing orders.
 *
 * WHY THIS IS A SOURCE SCAN AND NOT A BEHAVIOURAL TEST. The property is an
 * ABSENCE: that `marketPrice` appears nowhere in the strategy or Durable Object
 * layers. No behavioural test can pin an absence -- someone could add a read of
 * it inside `gridDecide` tomorrow and every existing test would still pass. So
 * it is checked mechanically, as a build failure, in the shape
 * `src/db/no-raw-d1.test.ts` established for exactly this class of guarantee.
 */

import { describe, expect, it } from "vitest";

// `import.meta.glob` is a Vite feature, declared locally rather than by adding
// "vite/client" to tsconfig's `types` -- the same arrangement, and the same
// reason, as `src/db/no-raw-d1.test.ts`.
declare global {
  interface ImportMeta {
    glob(
      pattern: string,
      options: { query: string; eager: true },
    ): Record<string, unknown>;
  }
}

const SOURCES = import.meta.glob("/src/**/*.ts", { query: "?raw", eager: true }) as Record<
  string,
  { default: string }
>;

/**
 * Where the market price is ALLOWED to be named.
 *
 * The API layer that assembles it, the worker module that fetches it, and their
 * own tests. Nothing else -- and specifically not the strategies, not the
 * Durable Objects, not reconciliation.
 */
const ALLOWED = [
  "/src/api/serialize.ts",
  "/src/api/handlers.ts",
  "/src/api/router.ts",
  "/src/api/index.ts",
  "/src/workers/market-price.ts",
];

const isTest = (path: string): boolean => path.endsWith(".test.ts");

describe("the market price never reaches a decision path", () => {
  it("is named nowhere outside the API assembly layer and its fetcher", () => {
    const offenders = Object.entries(SOURCES)
      .filter(([path]) => !isTest(path) && !ALLOWED.includes(path))
      .filter(([, module]) => /\bmarketPrice\b|\bMarketPrice\b/.test(module.default))
      .map(([path]) => path);

    expect(offenders).toEqual([]);
  });

  it("is absent from the strategies, which decide what to trade", () => {
    // Named individually rather than swept, so deleting one of these files
    // cannot quietly empty the assertion.
    for (const path of ["/src/strategies/grid.ts", "/src/strategies/dca.ts"]) {
      const source = SOURCES[path];
      expect(source, `${path} must exist for this guard to mean anything`).toBeDefined();
      expect(source!.default, path).not.toMatch(/marketPrice/i);
    }
  });

  it("is absent from the Durable Object that holds state and places orders", () => {
    const source = SOURCES["/src/durable-objects/bot-instance.ts"];
    expect(source).toBeDefined();
    // Neither the field, nor the port, nor the module.
    expect(source!.default).not.toMatch(/marketPrice/i);
    expect(source!.default).not.toMatch(/market-price/);
  });

  it("does not appear in BotRuntimeState, so it can never be persisted", () => {
    // The narrower half of the guard above, and the one that matters most: the
    // runtime state is what survives eviction and what every pipeline pass
    // reads. A field here would outlive the request that fetched it.
    const source = SOURCES["/src/durable-objects/bot-instance.ts"]!.default;
    const start = source.indexOf("export interface BotRuntimeState");
    expect(start).toBeGreaterThan(-1);
    const state = source.slice(start, source.indexOf("}", start));
    expect(state).not.toMatch(/market/i);
    // And the fields it DOES have are still the ones the pipeline expects, so
    // this guard cannot pass by the interface having been renamed away.
    expect(state).toMatch(/lastPrice/);
    expect(state).toMatch(/lastPriceAt/);
  });

  it("is not read by the dashboard's PnL or ladder maths", () => {
    // `unrealizedPnl` lives in derive.ts and is called by the ladder view, the
    // DCA position view and the account rollup. If `marketPrice` ever reaches
    // it, every profit figure on the dashboard changes meaning at once.
    const derive = DASHBOARD["/dashboard/src/derive.ts"];
    expect(derive, "derive.ts must exist for this guard to mean anything").toBeDefined();
    expect(derive!.default).not.toMatch(/marketPrice/i);

    const totals = DASHBOARD["/dashboard/src/accountTotals.ts"];
    expect(totals).toBeDefined();
    expect(totals!.default).not.toMatch(/marketPrice/i);

    const ladder = DASHBOARD["/dashboard/src/components/GridLadderView.tsx"];
    expect(ladder).toBeDefined();
    expect(ladder!.default).not.toMatch(/marketPrice/i);
  });
});

const DASHBOARD = import.meta.glob("/dashboard/src/**/*.{ts,tsx}", {
  query: "?raw",
  eager: true,
}) as Record<string, { default: string }>;
