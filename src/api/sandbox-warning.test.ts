/**
 * SPEC 5.7's operator-visible half: the sandbox warning on a bot's detail.
 *
 * ⚠ WHAT THIS IS FOR, AND WHY IT IS NOT THE FROZEN-VALUE DETECTOR. That detector
 * answers "is this feed stuck right now", roughly ten minutes after a freeze
 * starts. This answers a different question -- "should I believe these numbers
 * at all" -- and it has to answer it BEFORE a live test starts, which a detector
 * by construction cannot. On 2026-09-02 a trailing-stop bot ran its first live
 * test against a sandbox market frozen for eleven hours, and three rounds of
 * investigation went by before anyone asked whether the price was real.
 *
 * Deliberately static and environment-gated rather than condition-gated: that
 * the testnet venue is a simulator is true whether or not a feed is stuck.
 */
import { describe, expect, it } from "vitest";

import type { Database } from "../db/database";
import { botInstanceRow, freshDatabase } from "../db/test-helpers";
import { SANDBOX_PRICE_WARNING, botDetail, sandboxPriceWarning } from "./serialize";

/** Matches `handlers.ts`'s own constant: a bot with no trades has no fees. */
const NO_FEES = { reported: "0.00000000", unpricedCount: 0 } as const;

let db: Database;
let counter = 0;

async function seedBot() {
  db = await freshDatabase();
  const row = botInstanceRow({ id: `warn-${counter++}`, pair: "BTCUSD", exchange: "gemini" });
  await db.botInstances.insert(row);
  return row;
}

describe("sandboxPriceWarning", () => {
  it("warns on testnet, which is the deploy that points at the sandbox", () => {
    expect(sandboxPriceWarning("testnet")).toBe(SANDBOX_PRICE_WARNING);
  });

  it("says nothing on production or an unconfigured deploy", () => {
    expect(sandboxPriceWarning("production")).toBeNull();
    expect(sandboxPriceWarning("unconfigured")).toBeNull();
    expect(sandboxPriceWarning(undefined)).toBeNull();
  });

  it("names the failure modes an operator has to look for, not just 'be careful'", () => {
    // A warning that does not say WHAT to distrust is one an operator learns to
    // scroll past. These three are what the sandbox actually did.
    expect(SANDBOX_PRICE_WARNING).toContain("frozen");
    expect(SANDBOX_PRICE_WARNING).toContain("zero volume");
    expect(SANDBOX_PRICE_WARNING).toContain("crossed book");
    // And where to read the reasoning.
    expect(SANDBOX_PRICE_WARNING).toContain("5.7");
  });
});

describe("the warning on the bot detail shape", () => {
  it("rides on the detail payload as a top-level field on testnet", async () => {
    const row = await seedBot();
    const detail = botDetail(row, null, [], [], [], NO_FEES, null, "testnet");
    expect((detail as { warning?: string }).warning).toBe(SANDBOX_PRICE_WARNING);
  });

  it("is ABSENT off testnet, so a production response keeps its old shape exactly", async () => {
    // Absent, not `null` -- the same treatment `proposalLink` gets, so a reader
    // testing `if (body.warning)` needs no knowledge of the environment and a
    // production payload is byte-identical to what it was before this existed.
    const row = await seedBot();
    const detail = botDetail(row, null, [], [], [], NO_FEES, null, "production");
    expect("warning" in detail).toBe(false);
  });

  it("defaults to absent when no environment is passed at all", async () => {
    const row = await seedBot();
    const detail = botDetail(row, null, [], [], [], NO_FEES);
    expect("warning" in detail).toBe(false);
  });

  it("does not disturb the rest of the payload", async () => {
    const row = await seedBot();
    const plain = botDetail(row, null, [], [], [], NO_FEES, null, "production");
    const warned = botDetail(row, null, [], [], [], NO_FEES, null, "testnet");
    const { warning, ...withoutWarning } = warned as Record<string, unknown>;
    expect(warning).toBe(SANDBOX_PRICE_WARNING);
    expect(withoutWarning).toStrictEqual(plain);
  });
});
