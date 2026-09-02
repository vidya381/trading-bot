/**
 * "Clone this bot" → the create-bot form: the round trip for BOTH strategies, the
 * all-or-nothing identity rule, the two things that deliberately do NOT travel,
 * and the proof that the proposal prefill is untouched.
 *
 * ── WHAT THESE TESTS ARE FOR, AND WHAT NO TEST HERE CAN DO ──
 *
 * This project still has no jsdom, no testing-library, and `react-dom/server` does
 * not resolve in the Workers pool this suite runs in, so a test importing a `.tsx`
 * collects ZERO tests rather than failing (decision logs 44-46). That is why every
 * decision this feature makes lives in `botClonePrefill.ts` and none of it lives in
 * a component: that module is React-free and fully driven here, while
 * `CloneBotLink.tsx`, `CloneSourceBanner.tsx` and the changed lines of
 * `CreateBot.tsx` are covered by typecheck, a real Vite build, the source-level
 * guard in `prefill-does-not-approve.test.ts`, and the operator's eyes.
 *
 * ── THE ROUND TRIP IS THE POINT, AND IT IS DRIVEN FROM A REAL RESPONSE SHAPE ──
 *
 * Each strategy's test starts from a `BotDetail` exactly as `GET /api/bots/:id`
 * serialises one — the D1 summary fields plus the Durable Object's `config`, with
 * every Money already rendered to the decimal string `jsonSafe` produces — runs it
 * through `cloneBotHref`, and decodes the resulting URL back into form-ready
 * values. Both ends are the real functions the dashboard calls. What is asserted
 * is the FORM's vocabulary, not the config's, because the translation between the
 * two is where the bug would be.
 *
 * ⚠ THE `stopLossPct` MAPPING IS WHY BOTH STRATEGIES GET A FULL TEST. Grid and DCA
 * both have a parameter with that exact name, and they are two different inputs in
 * two different fieldsets of the create-bot form (`gridStopLossPct` /
 * `dcaStopLossPct`). A mapping that is right for one and wrong for the other
 * typechecks, renders, and creates a bot with no stop-loss where a human saw one.
 */

import { describe, expect, it } from "vitest";
import type { BotDetail, DcaParams, GridParams } from "../api/types";
import {
  CLONE_KEYS,
  CREATE_BOT_PATH,
  cloneBotHref,
  cloneRefusal,
  cloneSearchParams,
  readBotClonePrefill,
} from "./botClonePrefill";
import { readProposalPrefill, WIRE_FIELDS } from "./proposalPrefill";
// Section 7 asserts that a trailing-stop config PASSES the backend's shape check,
// which is the fact the old refusal message contradicted. Imported from the
// backend directly, the same crossing `botClonePrefill.ts` itself makes.
import { checkParamsShape } from "../../../src/research/proposal-shape";

// ---------------------------------------------------------------------------
// Fixtures -- the shape `GET /api/bots/:id` really returns
// ---------------------------------------------------------------------------

const GRID_PARAMS: GridParams = {
  upperBound: "64036.14000000",
  lowerBound: "62660.91000000",
  gridLines: 8,
  spacing: "geometric",
  orderSize: "60.00000000",
  stopLossPct: "5.00000000",
  breakoutTakeProfit: true,
  breakoutThresholdPct: "2.50000000",
  // `null` is a real, present value meaning "this bot has no realized-profit
  // target" -- distinct from a field that never arrived. The round trip has to
  // preserve that difference, and a test below pins it.
  takeProfitAmount: null,
};

const DCA_PARAMS: DcaParams = {
  baseOrderSize: "100.00000000",
  additionalOrderSize: "150.00000000",
  stepMultiplier: "1.50000000",
  dropPct: "3.00000000",
  maxAdditionalBuys: 4,
  takeProfitPct: "2.00000000",
  stopLossPct: "20.00000000",
  autoRestart: true,
  // The only accepted value: `validateDcaParams` rejects `true` at creation, so
  // no stored config can carry it. The `true` case is tested separately as the
  // hand-edited-URL case it would have to be.
  sellOnStopLoss: false,
};

/**
 * A bot as the detail endpoint serialises it.
 *
 * `allocatedCapital` on the ROW is deliberately different from the one inside
 * `config` in these fixtures (`4000` vs `3500`). They agree on every bot that has
 * never been resized, which is every bot today — making them differ here is what
 * lets a test assert WHICH ONE the clone copies, rather than passing either way.
 */
function botFixture(
  strategy: "grid" | "dca",
  overrides: Partial<BotDetail> = {},
): BotDetail {
  const config =
    strategy === "grid"
      ? ({
          strategy: "grid" as const,
          schemaVersion: 1,
          botInstanceId: "grid-src-001",
          accountLabel: "gemini-main",
          exchange: "gemini",
          pair: "BTCUSD",
          capitalAsset: "USD",
          allocatedCapital: "3500.00000000",
          params: GRID_PARAMS,
        })
      : ({
          strategy: "dca" as const,
          schemaVersion: 1,
          botInstanceId: "dca-src-001",
          accountLabel: "gemini-main",
          exchange: "gemini",
          pair: "ETHUSD",
          capitalAsset: "USD",
          allocatedCapital: "3500.00000000",
          params: DCA_PARAMS,
        });

  return {
    id: strategy === "grid" ? "grid-src-001" : "dca-src-001",
    accountLabel: "gemini-main",
    exchange: "gemini",
    pair: strategy === "grid" ? "BTCUSD" : "ETHUSD",
    strategy,
    status: "running",
    allocatedCapital: "4000.00000000",
    capitalAsset: "USD",
    stopLossPct: strategy === "grid" ? "5.00000000" : "20.00000000",
    takeProfitPct: strategy === "grid" ? null : "2.00000000",
    haltReason: null,
    haltedAt: null,
    archived: false,
    createdAt: 1_755_000_000_000,
    updatedAt: 1_755_000_100_000,
    position: null,
    lastPrice: "63757.71000000",
    cycleCount: strategy === "grid" ? 0 : 3,
    fees: { reported: "1.20000000", unpricedCount: 0 },
    orphaned: false,
    config,
    state: null,
    orders: [],
    trades: [],
    alerts: [],
    ...overrides,
  };
}

/** The decoded prefill for a bot, or a hard failure if no link was offered. */
function prefillFor(bot: BotDetail) {
  const href = cloneBotHref(bot);
  expect(href, "a clone link should be offered for this bot").not.toBeNull();
  expect(href!.startsWith(`${CREATE_BOT_PATH}?`)).toBe(true);
  const prefill = readBotClonePrefill(new URLSearchParams(href!.split("?")[1]!));
  expect(prefill, "the link this module built should decode").not.toBeNull();
  return prefill!;
}

// ---------------------------------------------------------------------------
// 1. A DCA bot's full config round-trips into form-ready values
// ---------------------------------------------------------------------------

describe("a DCA bot's configuration round-trips into the create-bot form", () => {
  it("carries every shared field, INCLUDING the allocated capital", () => {
    const prefill = prefillFor(botFixture("dca"));

    expect(prefill.sourceBotId).toBe("dca-src-001");
    expect(prefill.strategy).toBe("dca");
    expect(prefill.accountLabel).toBe("gemini-main");
    expect(prefill.pair).toBe("ETHUSD");
    expect(prefill.capitalAsset).toBe("USD");
    /*
     * ⚠ THE ROW'S FIGURE, NOT THE OBJECT'S. `resizeBotCapital` rewrites
     * `bot_instances.allocated_capital` and leaves the stored `config.allocatedCapital`
     * at its creation-time value, and the row is what `BotSummary` renders. The
     * fixture makes them differ so this assertion can only pass one way: the
     * number in the box must be the number on the page the operator clicked from.
     */
    expect(prefill.allocatedCapital).toBe("4000.00000000");
    expect(prefill.allocatedCapital).not.toBe("3500.00000000");
  });

  it("maps every DCA parameter to the form's own state name", () => {
    const prefill = prefillFor(botFixture("dca"));
    expect(prefill.fields).toEqual({
      strategy: "dca",
      baseOrderSize: "100.00000000",
      additionalOrderSize: "150.00000000",
      stepMultiplier: "1.50000000",
      dropPct: "3.00000000",
      maxAdditionalBuys: "4",
      // THE MAPPING: DCA's `takeProfitPct`/`stopLossPct` are the form's two
      // `dca…` inputs, which are different DOM nodes from grid's.
      dcaTakeProfitPct: "2.00000000",
      dcaStopLossPct: "20.00000000",
      autoRestart: true,
    });
  });

  it("reports nothing missing and nothing unrepresentable", () => {
    const prefill = prefillFor(botFixture("dca"));
    expect(prefill.incomplete).toEqual([]);
    expect(prefill.unrepresentable).toEqual([]);
  });

  it("carries `autoRestart: false` as false rather than as unreadable", () => {
    // `Boolean("false")` is `true`; a strict parse is the only correct one here,
    // and the round trip has to survive the falsy value as well as the truthy.
    const bot = botFixture("dca");
    const params: DcaParams = { ...DCA_PARAMS, autoRestart: false };
    const prefill = prefillFor({
      ...bot,
      config: { ...bot.config!, strategy: "dca", params },
    } as BotDetail);
    expect(prefill.fields).toMatchObject({ strategy: "dca", autoRestart: false });
    expect(prefill.incomplete).toEqual([]);
  });

  it("numbers cross as strings, because every input on that form holds one", () => {
    const prefill = prefillFor(botFixture("dca"));
    expect(prefill.fields.strategy).toBe("dca");
    if (prefill.fields.strategy !== "dca") return;
    // `maxAdditionalBuys` is a NUMBER in the config and a STRING in the form.
    expect(typeof prefill.fields.maxAdditionalBuys).toBe("string");
    expect(prefill.fields.maxAdditionalBuys).toBe("4");
  });
});

// ---------------------------------------------------------------------------
// 2. A grid bot's full config round-trips into form-ready values
// ---------------------------------------------------------------------------

describe("a grid bot's configuration round-trips into the create-bot form", () => {
  it("carries every shared field, INCLUDING the allocated capital", () => {
    const prefill = prefillFor(botFixture("grid"));

    expect(prefill.sourceBotId).toBe("grid-src-001");
    expect(prefill.strategy).toBe("grid");
    expect(prefill.accountLabel).toBe("gemini-main");
    expect(prefill.pair).toBe("BTCUSD");
    expect(prefill.capitalAsset).toBe("USD");
    expect(prefill.allocatedCapital).toBe("4000.00000000");
    expect(prefill.allocatedCapital).not.toBe("3500.00000000");
  });

  it("maps every grid parameter to the form's own state name", () => {
    const prefill = prefillFor(botFixture("grid"));
    expect(prefill.fields).toEqual({
      strategy: "grid",
      lowerBound: "62660.91000000",
      upperBound: "64036.14000000",
      gridLines: "8",
      spacing: "geometric",
      orderSize: "60.00000000",
      // THE MAPPING: grid's `stopLossPct` is the form's `gridStopLossPct`.
      gridStopLossPct: "5.00000000",
      // `null` in the config -- a real, present "unset" -- becomes the empty
      // string the form's optional input holds, NOT a missing field.
      takeProfitAmount: "",
      breakoutTakeProfit: true,
      breakoutThresholdPct: "2.50000000",
    });
  });

  it("⚠ a `null` optional is 'unset', not 'missing' -- it is not reported incomplete", () => {
    /*
     * The `null`-is-present rule, which is the difference between "this bot has no
     * take-profit target" and "the link failed to carry it". Conflating them would
     * make the banner cry incomplete about a perfectly complete config, and
     * eventually train an operator to ignore it.
     */
    const prefill = prefillFor(botFixture("grid"));
    expect(prefill.fields).toMatchObject({ strategy: "grid", takeProfitAmount: "" });
    expect(prefill.incomplete).toEqual([]);
    expect(prefill.unrepresentable).toEqual([]);
  });

  it("carries `breakoutTakeProfit: false` and an arithmetic ladder faithfully", () => {
    const bot = botFixture("grid");
    const params: GridParams = {
      ...GRID_PARAMS,
      spacing: "arithmetic",
      breakoutTakeProfit: false,
      breakoutThresholdPct: null,
      takeProfitAmount: "250.00000000",
    };
    const prefill = prefillFor({
      ...bot,
      config: { ...bot.config!, strategy: "grid", params },
    } as BotDetail);
    expect(prefill.fields).toEqual({
      strategy: "grid",
      lowerBound: "62660.91000000",
      upperBound: "64036.14000000",
      gridLines: "8",
      spacing: "arithmetic",
      orderSize: "60.00000000",
      gridStopLossPct: "5.00000000",
      takeProfitAmount: "250.00000000",
      breakoutTakeProfit: false,
      breakoutThresholdPct: "",
    });
    expect(prefill.incomplete).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 3. Clone is offered for every status, and never creates a link to the source
// ---------------------------------------------------------------------------

describe("what the clone deliberately does and does not carry", () => {
  it("offers a link for every bot status, and for an archived bot", () => {
    /*
     * The decision this feature was built to, asserted rather than left to the
     * component: a configuration is copyable whatever the bot is currently doing,
     * and the moment an operator most wants "another one like that" is usually
     * just after watching one stop.
     */
    for (const status of ["created", "running", "halted", "stopped"] as const) {
      expect(cloneBotHref(botFixture("grid", { status })), status).not.toBeNull();
      expect(cloneBotHref(botFixture("dca", { status })), status).not.toBeNull();
    }
    expect(cloneBotHref(botFixture("grid", { status: "stopped", archived: true }))).not.toBeNull();
    expect(cloneBotHref(botFixture("dca", { status: "halted", archived: true }))).not.toBeNull();
  });

  it("⚠ never carries the source bot's instance id, so the new bot gets a fresh one", () => {
    /*
     * THE "NO RELATIONSHIP" GUARANTEE, at the wire. The create-bot form mints
     * `botInstanceId` at mount and this prefill has no field for it; the URL must
     * not smuggle one in either. `cloneFrom` carries the source id for the banner
     * and is not a form value -- so the assertion is that no PARAMETER a form
     * field reads holds it.
     */
    const params = cloneSearchParams(botFixture("grid"))!;
    expect(params.get("botInstanceId")).toBeNull();
    expect(params.get("id")).toBeNull();
    // The only place the source id appears is the provenance key.
    const carrying = [...params.entries()].filter(([, v]) => v === "grid-src-001");
    expect(carrying).toEqual([[CLONE_KEYS.cloneFrom, "grid-src-001"]]);
  });

  it("⚠ never carries a `proposalId`, so a clone cannot resolve anybody's proposal", () => {
    const params = cloneSearchParams(botFixture("dca"))!;
    expect(params.get("proposalId")).toBeNull();
    expect(params.get("generatedAt")).toBeNull();
    expect(params.get("freshness")).toBeNull();
  });

  it("does not carry the exchange, which the form derives from the account registry", () => {
    // `POST /api/bots` rejects a body whose exchange disagrees with the registry,
    // and the form's venue box is read-only and filled from the accounts response.
    // A carried value would be one nothing reads and that could contradict it.
    expect(cloneSearchParams(botFixture("grid"))!.get("exchange")).toBeNull();
  });

  it("encodes exactly the strategy's own parameter fields, from the shared lists", () => {
    /*
     * `WIRE_FIELDS` is imported from `proposalPrefill.ts` rather than copied, and
     * an existing test there pins it element-for-element against the backend's
     * authoritative `GRID_PROPOSAL_FIELDS`/`DCA_PROPOSAL_FIELDS`. So a parameter
     * added to a strategy reaches both encoders or neither, and this checks the
     * clone encoder actually walks its list.
     */
    for (const strategy of ["grid", "dca"] as const) {
      const params = cloneSearchParams(botFixture(strategy))!;
      for (const field of WIRE_FIELDS[strategy]) {
        expect(params.has(field), `${strategy}.${field}`).toBe(true);
      }
      for (const field of WIRE_FIELDS[strategy === "grid" ? "dca" : "grid"]) {
        // The other strategy's fields, except the two names both share.
        if (WIRE_FIELDS[strategy].includes(field)) continue;
        expect(params.has(field), `${strategy} must not carry ${field}`).toBe(false);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 4. The existing proposal-to-bot prefill flow is completely unaffected
// ---------------------------------------------------------------------------

/**
 * A proposal URL, built from the proposal encoder's own wire vocabulary rather
 * than from a `DeriveResponse` fixture. `proposalPrefill.test.ts` drives the real
 * `prefillSearchParams` end of that flow, in full, and is unchanged by this step —
 * that file passing is the primary regression evidence. What is added here is the
 * INTERFERENCE check the other file cannot make, because it does not know the
 * clone decoder exists.
 */
function proposalUrlParams(): URLSearchParams {
  const params = new URLSearchParams();
  params.set("proposalId", "prop-01JABCDEF");
  params.set("strategy", "grid");
  params.set("accountLabel", "gemini-main");
  params.set("pair", "BTCUSD");
  params.set("capitalAsset", "USD");
  params.set("allocatedCapital", "500.00000000");
  params.set("generatedAt", "1755000004000");
  params.set("freshness", "candles:1755000000000:900000,capital:1755000001000:3600000");
  params.set("upperBound", "64036.14000000");
  params.set("lowerBound", "62660.91000000");
  params.set("gridLines", "8");
  params.set("spacing", "geometric");
  params.set("orderSize", "60.00000000");
  params.set("stopLossPct", "5.00000000");
  params.set("breakoutTakeProfit", "true");
  params.set("breakoutThresholdPct", "2.50000000");
  params.set("takeProfitAmount", "");
  return params;
}

describe("the proposal → create-bot prefill is unaffected by any of this", () => {
  it("still decodes a proposal URL into exactly the prefill it always did", () => {
    const prefill = readProposalPrefill(proposalUrlParams());
    expect(prefill).not.toBeNull();
    expect(prefill!.proposalId).toBe("prop-01JABCDEF");
    expect(prefill!.strategy).toBe("grid");
    expect(prefill!.accountLabel).toBe("gemini-main");
    expect(prefill!.pair).toBe("BTCUSD");
    expect(prefill!.capitalAsset).toBe("USD");
    expect(prefill!.allocatedCapital).toBe("500.00000000");
    expect(prefill!.generatedAt).toBe(1_755_000_004_000);
    expect(prefill!.stalenessInputs).toHaveLength(2);
    expect(prefill!.incomplete).toEqual([]);
    expect(prefill!.unrepresentable).toEqual([]);
    expect(prefill!.fields).toEqual({
      strategy: "grid",
      lowerBound: "62660.91000000",
      upperBound: "64036.14000000",
      gridLines: "8",
      spacing: "geometric",
      orderSize: "60.00000000",
      gridStopLossPct: "5.00000000",
      takeProfitAmount: "",
      breakoutTakeProfit: true,
      breakoutThresholdPct: "2.50000000",
    });
  });

  it("⚠ a CLONE url produces no proposal prefill -- the form stays manual, not proposal-branded", () => {
    /*
     * The interference check in the direction that matters most. A clone URL has a
     * recognised `strategy` and a full set of parameters; the ONLY thing keeping
     * `readProposalPrefill` from claiming them is its `proposalId` requirement. If
     * that ever relaxed, an operator cloning a bot would be shown an AI-provenance
     * banner over numbers no model produced -- and the submit would try to resolve
     * a proposal that does not exist.
     */
    for (const strategy of ["grid", "dca"] as const) {
      const url = new URLSearchParams(cloneBotHref(botFixture(strategy))!.split("?")[1]!);
      expect(readProposalPrefill(url), strategy).toBeNull();
    }
  });

  it("⚠ a PROPOSAL url produces no clone prefill", () => {
    expect(readBotClonePrefill(proposalUrlParams())).toBeNull();
  });

  it("⚠ a url claiming BOTH provenances is refused by the clone decoder outright", () => {
    /*
     * Refused in the decoder, not by call order. `CreateBot.tsx` asks the proposal
     * decoder first, but that ordering must not be the thing keeping the two apart
     * -- a reordering would be an invisible regression. So the clone decoder
     * refuses a proposal-bearing URL by itself, whoever asks and in whatever order.
     */
    const both = new URLSearchParams(cloneBotHref(botFixture("grid"))!.split("?")[1]!);
    both.set("proposalId", "prop-01JABCDEF");
    expect(readBotClonePrefill(both)).toBeNull();
    // Whitespace is not an id, and must not be treated as one in either direction.
    both.set("proposalId", "   ");
    expect(readBotClonePrefill(both)).not.toBeNull();
  });

  it("⚠ both decoders map the SAME parameters to byte-identical form fields", () => {
    /*
     * THE DUPLICATION GUARD. A parallel decoder was chosen over relaxing the
     * existing one (see `botClonePrefill.ts`'s header), and its one real cost is a
     * second implementation of the field mapping -- the part where grid's and DCA's
     * identically-named `stopLossPct` go to two different form inputs. This closes
     * it: the same parameter string, differing only in which id it carries, must
     * decode to the same `fields` through both modules. Either one drifting -- in
     * the mapping, in the boolean parsing, in what counts as unset -- fails here.
     */
    for (const strategy of ["grid", "dca"] as const) {
      const shared = new URLSearchParams(cloneBotHref(botFixture(strategy))!.split("?")[1]!);
      shared.delete(CLONE_KEYS.cloneFrom);

      const asClone = new URLSearchParams(shared);
      asClone.set(CLONE_KEYS.cloneFrom, "src-bot");
      const asProposal = new URLSearchParams(shared);
      asProposal.set("proposalId", "prop-x");

      const clone = readBotClonePrefill(asClone);
      const proposal = readProposalPrefill(asProposal);
      expect(clone, strategy).not.toBeNull();
      expect(proposal, strategy).not.toBeNull();
      expect(clone!.fields, strategy).toEqual(proposal!.fields);
      // And the shared non-field values, which are read the same way.
      expect(clone!.accountLabel).toBe(proposal!.accountLabel);
      expect(clone!.pair).toBe(proposal!.pair);
      expect(clone!.capitalAsset).toBe(proposal!.capitalAsset);
      expect(clone!.allocatedCapital).toBe(proposal!.allocatedCapital);
      /*
       * `incomplete` is compared with the proposal-only keys removed. A clone URL
       * legitimately has no `generatedAt` and no `freshness` -- they are not
       * concepts a bot config has -- which is one of the three reasons the two
       * decoders are separate at all.
       */
      const proposalOnly = new Set(["generatedAt", "freshness"]);
      expect(clone!.incomplete).toEqual(
        proposal!.incomplete.filter((key) => !proposalOnly.has(key)),
      );
    }
  });
});

// ---------------------------------------------------------------------------
// 5. Malformed or incomplete clone input fails closed
// ---------------------------------------------------------------------------

describe("a malformed or incomplete clone source fails closed", () => {
  /** The clone URL for a grid bot, as a mutable starting point. */
  function goodUrl(): URLSearchParams {
    return new URLSearchParams(cloneBotHref(botFixture("grid"))!.split("?")[1]!);
  }

  it("sanity: the unmodified URL does decode, so the negatives below mean something", () => {
    // Without this every assertion in this block could pass for the wrong reason.
    expect(readBotClonePrefill(goodUrl())).not.toBeNull();
  });

  it("⚠ NO PREFILL AT ALL without a source bot id -- not a partial one", () => {
    /*
     * THE ALL-OR-NOTHING RULE, which is what makes "prefilled values always carry
     * their provenance" structural rather than something every caller must
     * remember. A partial prefill on a missing id would put a full set of numbers
     * in front of an operator with nothing on screen saying where they came from.
     */
    const url = goodUrl();
    url.delete(CLONE_KEYS.cloneFrom);
    expect(readBotClonePrefill(url)).toBeNull();
  });

  it("an empty or whitespace-only source id is not an id", () => {
    for (const value of ["", "   ", "\t"]) {
      const url = goodUrl();
      url.set(CLONE_KEYS.cloneFrom, value);
      expect(readBotClonePrefill(url), JSON.stringify(value)).toBeNull();
    }
  });

  it("⚠ NO PREFILL AT ALL for a missing or unrecognised strategy", () => {
    const missing = goodUrl();
    missing.delete("strategy");
    expect(readBotClonePrefill(missing)).toBeNull();

    for (const bogus of ["", "GRID", "martingale", "dca ", "null", "0"]) {
      const url = goodUrl();
      url.set("strategy", bogus);
      expect(readBotClonePrefill(url), JSON.stringify(bogus)).toBeNull();
    }
  });

  it("an empty query string is an ordinary manual visit, not an error", () => {
    expect(readBotClonePrefill(new URLSearchParams())).toBeNull();
    expect(readBotClonePrefill(new URLSearchParams("foo=bar"))).toBeNull();
  });

  it("⚠ a field that cannot be read is left EMPTY and NAMED, never guessed", () => {
    /*
     * The second half of failing closed, for a URL that does carry an identity.
     * Every missing parameter must land in `incomplete` -- which the banner prints
     * -- and the form keeps its own ordinary default. Substituting a plausible
     * number would be a degraded result indistinguishable from a good one, on the
     * screen that commits capital.
     */
    const url = goodUrl();
    for (const key of ["orderSize", "gridLines", "stopLossPct", "allocatedCapital", "pair"]) {
      url.delete(key);
    }
    const prefill = readBotClonePrefill(url);
    expect(prefill).not.toBeNull();
    expect(prefill!.fields).toMatchObject({
      strategy: "grid",
      orderSize: "",
      gridLines: "",
      gridStopLossPct: "",
    });
    expect(prefill!.allocatedCapital).toBe("");
    expect(prefill!.pair).toBe("");
    expect([...prefill!.incomplete].sort()).toEqual(
      ["allocatedCapital", "gridLines", "orderSize", "pair", "stopLossPct"].sort(),
    );
  });

  it("an unreadable boolean is unreadable, not false -- `Boolean(\"false\")` is true", () => {
    const url = goodUrl();
    url.set("breakoutTakeProfit", "yes");
    const prefill = readBotClonePrefill(url)!;
    // The form's own default is kept and the field is NAMED, rather than a junk
    // value being coerced into a risk control silently flipping state.
    expect(prefill.fields).toMatchObject({ strategy: "grid", breakoutTakeProfit: true });
    expect(prefill.incomplete).toContain("breakoutTakeProfit");
  });

  it("an unreadable spacing keeps the form's default and says so", () => {
    const url = goodUrl();
    url.set("spacing", "logarithmic");
    const prefill = readBotClonePrefill(url)!;
    expect(prefill.fields).toMatchObject({ strategy: "grid", spacing: "arithmetic" });
    expect(prefill.incomplete).toContain("spacing");
  });

  it("a present-but-junk value is passed through VERBATIM for the form to reject", () => {
    /*
     * Deliberately NOT sanitised here. The create-bot form's validator is the thing
     * that judges values, and a silently dropped bad value would hide from the
     * operator that the URL claimed it -- they would see an empty box and assume
     * the link simply did not carry it.
     */
    const url = goodUrl();
    url.set("orderSize", "not-a-number");
    const prefill = readBotClonePrefill(url)!;
    expect(prefill.fields).toMatchObject({ strategy: "grid", orderSize: "not-a-number" });
    expect(prefill.incomplete).not.toContain("orderSize");
  });

  it("a hand-edited `sellOnStopLoss=true` is NAMED, never silently dropped", () => {
    /*
     * No stored config can carry it -- `validateDcaParams` rejects `true` at
     * creation -- so this can only arrive from a hand-edited URL. The form has no
     * control for it and will submit `false`; that difference is surfaced rather
     * than hidden.
     */
    const url = new URLSearchParams(cloneBotHref(botFixture("dca"))!.split("?")[1]!);
    url.set("sellOnStopLoss", "true");
    const prefill = readBotClonePrefill(url)!;
    expect(prefill.unrepresentable).toEqual(["sellOnStopLoss"]);
  });
});

// ---------------------------------------------------------------------------
// 6. A bot whose config cannot be read offers no link at all
// ---------------------------------------------------------------------------

describe("a bot with no readable configuration offers no link", () => {
  it("an orphan (no object state) gets no link, at any status", () => {
    /*
     * NOT A STATUS GATE. The bot row exists but its Durable Object holds nothing,
     * so there are no parameters to copy -- there is no honest URL to build.
     * `CloneBotLink` renders the reason in place rather than nothing, because an
     * operator who expects the control on every bot reads its absence as a broken
     * page.
     */
    const orphan = botFixture("grid", { config: null, state: null, orphaned: true });
    expect(cloneSearchParams(orphan)).toBeNull();
    expect(cloneBotHref(orphan)).toBeNull();
  });

  it("params that do not match their own strategy label get no link", () => {
    // The fault that once took a page to a blank screen, refused one layer earlier
    // than the form -- prefilling `undefined` into a box that commits capital.
    const bot = botFixture("grid");
    const mislabelled = {
      ...bot,
      config: { ...bot.config!, strategy: "grid" as const, params: DCA_PARAMS as never },
    } as BotDetail;
    expect(cloneBotHref(mislabelled)).toBeNull();
  });

  it("a params object missing a field gets no link, rather than one with a hole in it", () => {
    const bot = botFixture("dca");
    const { dropPct: _dropped, ...partial } = DCA_PARAMS;
    const holed = {
      ...bot,
      config: { ...bot.config!, strategy: "dca" as const, params: partial as never },
    } as BotDetail;
    expect(cloneBotHref(holed)).toBeNull();
  });

  it("a config whose strategy disagrees with the bot row gets no link", () => {
    /*
     * They are written together at creation and neither is ever rewritten, so this
     * cannot happen today. If it ever does, one of the two things on the operator's
     * screen is wrong about what this bot IS, and refusing is the only honest
     * answer -- picking one would render a confident, possibly wrong form.
     */
    const bot = botFixture("grid");
    expect(cloneBotHref({ ...bot, strategy: "dca" } as BotDetail)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 7. ⚠ WHY a bot cannot be cloned, which the page used to get WRONG
// ---------------------------------------------------------------------------

/**
 * A real trailing-stop bot, shaped as `GET /api/bots/:id` serves one. Its config
 * is correct and complete -- `{ trailPct }` is the entire parameter set (22.2
 * decision 1) -- which is the whole point of the fixture.
 */
function trailingStopBot(overrides: Partial<BotDetail> = {}): BotDetail {
  const base = botFixture("dca");
  return {
    ...base,
    id: "bot-ts1",
    pair: "BTCUSD",
    strategy: "trailing_stop",
    cycleCount: 0,
    takeProfitPct: null,
    stopLossPct: "10.00000000",
    config: {
      strategy: "trailing_stop",
      schemaVersion: 1,
      botInstanceId: "bot-ts1",
      accountLabel: "gemini-main",
      exchange: "gemini",
      pair: "BTCUSD",
      capitalAsset: "USD",
      allocatedCapital: "500.00000000",
      params: { trailPct: "10.00000000" },
    },
    ...overrides,
  };
}

describe("the refusal names the RIGHT cause", () => {
  it("⚠ a trailing-stop bot is refused for the form's limits, NOT as a broken config", () => {
    /*
     * THE WRONG MESSAGE THIS TEST EXISTS FOR, WHICH WAS LIVE ON `bot-ts1`.
     * `checkParamsShape` did not recognise `trailing_stop`, so it answered
     * `strategy_not_recognised`, `cloneSearchParams` returned null, and
     * `CloneBotLink` -- which inferred the reason from `config === null` alone --
     * told the operator that their bot's stored parameters did not match their
     * own label. They match perfectly. The real reason is that `/bots/new` has no
     * trailing-stop controls.
     */
    expect(cloneRefusal(trailingStopBot())).toBe("strategy_not_creatable");
    // And still no link, which was always right -- only the explanation was wrong.
    expect(cloneBotHref(trailingStopBot())).toBeNull();
  });

  it("its params DO pass the shape check, which is what makes the old message a lie", () => {
    // Stated separately from the refusal, because this is the fact the old
    // message contradicted. A trailing-stop config is coherent.
    const config = trailingStopBot().config!;
    expect(checkParamsShape({ ...config.params, strategy: config.strategy }).ok).toBe(true);
  });

  it("an orphan and an incoherent config keep their own, different causes", () => {
    expect(cloneRefusal(botFixture("grid", { config: null, orphaned: true }))).toBe("no_config");
    const bot = botFixture("grid");
    const mislabelled = {
      ...bot,
      config: { ...bot.config!, strategy: "grid" as const, params: DCA_PARAMS as never },
    } as BotDetail;
    expect(cloneRefusal(mislabelled)).toBe("incoherent_config");
  });

  it("a bot that CAN be cloned has no refusal at all", () => {
    // The pairing that matters: a refusal reason and a link are mutually exclusive.
    for (const strategy of ["grid", "dca"] as const) {
      expect(cloneRefusal(botFixture(strategy))).toBeNull();
      expect(cloneBotHref(botFixture(strategy))).not.toBeNull();
    }
  });
});
