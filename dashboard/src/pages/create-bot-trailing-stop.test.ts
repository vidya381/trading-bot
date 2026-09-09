/**
 * TRAILING STOP ON THE CREATE-BOT FORM, checked at the source level.
 *
 * `trailPct.test.ts` proves the RULE is right, by running the backend's own
 * validator beside it. It cannot prove that the form offers the strategy, that the
 * field is wired to that rule, or that the body it builds carries the one parameter
 * the request has a shape for -- and none of those is visible to the type checker
 * either, because a form that simply never renders the toggle option compiles
 * perfectly.
 *
 * Nothing here can mount the component. A test importing a `.tsx` COLLECTS ZERO
 * TESTS RATHER THAN FAILING inside the Workers pool this suite runs in
 * (docs/open-items/component-test-harness.md, still open) -- so this is the pattern
 * `post-halt-notice.test.ts`, `grid-ladder-config.test.ts`,
 * `proposal-summary-card.test.ts` and `prefill-does-not-approve.test.ts` already
 * use, for decision log 45's reason: **a guard whose call site nothing can check is
 * most of the way to no guard.**
 *
 * ⚠ WHAT THIS PROVES AND WHAT IT DOES NOT. It proves the strategy is selectable,
 * that everything selectable is buildable and everything buildable is selectable,
 * that the field's verdict comes from `trailPct.ts` rather than a number typed into
 * the component, that the submitted `params` carries `trailPct` and nothing else,
 * that the venue bot-id check is not inside a strategy branch, and that the
 * trailing-stop risk panel offers no stop-loss the request could not carry. It
 * proves NOTHING about layout, spacing, or whether the panel reads clearly on the
 * deployed page. Those are the operator's, as every UI step here has been.
 */

import { describe, expect, it } from "vitest";
import type { CreateBotRequest } from "../api/types";

// `import.meta.glob` is a Vite feature. Declared here rather than by adding
// "vite/client" to tsconfig's `types`, which would also pull the DOM lib into
// scope while typechecking Worker source. Mirrors the guards named above.
declare global {
  interface ImportMeta {
    glob(
      pattern: string,
      options: { query: string; eager: true },
    ): Record<string, unknown>;
  }
}

const SOURCES = import.meta.glob("/dashboard/src/**/*.{ts,tsx}", {
  query: "?raw",
  eager: true,
}) as Record<string, { default: string }>;

const FORM = "/dashboard/src/pages/CreateBot.tsx";
const RULE = "/dashboard/src/trailPct.ts";
const TYPES = "/dashboard/src/api/types.ts";

function raw(path: string): string {
  const module = SOURCES[path];
  expect(module, `${path} is not in the scanned source set`).toBeDefined();
  return module!.default;
}

/** Source lines only: prose about a rule is not a violation of it. */
function code(path: string): string {
  return raw(path)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => !line.startsWith("//") && !line.startsWith("*") && !line.startsWith("/*"))
    .join("\n");
}

/** The body of one named function in a file, up to the next one. */
function slice(source: string, from: string, to: string): string {
  const start = source.indexOf(from);
  expect(start, `${JSON.stringify(from)} was not found`).toBeGreaterThanOrEqual(0);
  const end = source.indexOf(to, start);
  expect(end, `${JSON.stringify(to)} was not found after it`).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe("the files under guard", () => {
  it("found every one of them", () => {
    // Without this, every assertion below passes vacuously the moment the glob
    // stops matching -- the one way a source guard rots unnoticed.
    for (const path of [FORM, RULE, TYPES]) {
      expect(Object.keys(SOURCES)).toContain(path);
      expect(raw(path).length).toBeGreaterThan(500);
    }
  });
});

describe("the strategy is selectable, and everything selectable is buildable", () => {
  /**
   * The toggle's own literal, read out of the source.
   *
   * Deliberately parsed rather than string-matched, so the two assertions below
   * compare SETS and a reordering of the toggle is not a failure while a missing
   * member still is.
   */
  function toggleOptions(): string[] {
    const match = /\(\[([^\]]*)\] as const\)\.map\(\(option\)/.exec(code(FORM));
    expect(match, "the strategy toggle's option list was not found").not.toBeNull();
    return [...match![1]!.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]!);
  }

  /** Every `strategy: "..."` literal `buildRequest` puts into a request body. */
  function builtStrategies(): string[] {
    const body = slice(code(FORM), "function buildRequest()", "async function onSubmit");
    return [...body.matchAll(/strategy:\s*"([a-z_]+)"/g)].map((m) => m[1]!);
  }

  it("offers trailing stop alongside DCA and grid", () => {
    expect(toggleOptions()).toContain("trailing_stop");
    expect(toggleOptions().sort()).toEqual(["dca", "grid", "trailing_stop"]);
  });

  it("⚠ builds a request for every option it offers, and offers every one it builds", () => {
    /*
     * The pin the compiler cannot make. `CreatableStrategy` guarantees the toggle's
     * TYPE and `buildRequest`'s return TYPE agree; neither says the toggle actually
     * renders a button for each, nor that a branch exists for each button. A toggle
     * with an option `buildRequest` has no branch for falls through to grid and
     * submits grid parameters under a trailing-stop label; the reverse is a
     * strategy the form can build and nobody can pick.
     */
    expect([...builtStrategies()].sort()).toEqual([...toggleOptions()].sort());
  });

  it("renders the toggle's words through `strategyLabel`, never the wire value", () => {
    // `{option}` would print "trailing_stop" on the button and "Trailing stop"
    // everywhere else in the dashboard.
    expect(code(FORM)).toContain("{strategyLabel(option)}");
    expect(code(FORM)).not.toMatch(/>\s*\{option\}\s*</);
  });
});

describe("the field's verdict comes from the backend's bounds", () => {
  it("validate() routes the trail percentage through `trailPctError`", () => {
    const body = slice(code(FORM), "function validate(): Errors", "function buildRequest()");
    expect(body).toContain("trailPctError(trailPct)");
  });

  it("⚠ the component never restates the range itself", () => {
    /*
     * `trailPct.ts` imports `TRAIL_PCT_MIN`/`TRAIL_PCT_MAX` from the validator that
     * owns them, and that file says in as many words that when 22.5's open question
     * 1 settles, "this constant pair and the message below are the only things that
     * change". A comparison written into the form would make that false silently:
     * the field would keep enforcing the old range after the backend moved.
     */
    expect(code(FORM)).not.toMatch(/TRAIL_PCT_(MIN|MAX)\b(?!_TEXT)/);

    const importers = Object.entries(SOURCES)
      .filter(([path]) => !path.endsWith(".test.ts") && !path.endsWith(".test.tsx"))
      .filter(([, module]) => /from\s+["'][^"']*strategies\/trailing-stop["']/.test(module.default))
      .map(([path]) => path);
    expect(importers, "only the rule module may reach for the bounds").toEqual([RULE]);
  });

  it("the help text names the range from those same constants", () => {
    // So the words under the field move when the range does.
    const source = code(FORM);
    expect(source).toContain("TRAIL_PCT_MIN_TEXT");
    expect(source).toContain("TRAIL_PCT_MAX_TEXT");
  });
});

describe("the body it submits carries one parameter and no more", () => {
  /** `buildRequest`'s trailing-stop return, from its discriminant to its close. */
  function trailingBranch(): string {
    return slice(code(FORM), 'strategy: "trailing_stop"', 'if (strategy === "dca")');
  }

  it("sends `trailPct`, trimmed", () => {
    expect(trailingBranch()).toContain("params: { trailPct: trailPct.trim() }");
  });

  it("⚠ sends no order size and no stop-loss, which the request has no field for", () => {
    /*
     * The single entry is sized by `allocatedCapital` and the trail IS the stop
     * (spec 22.2 decisions 1 and 4). `TrailingStopParamsInput` therefore has exactly
     * one member, and `decodeTrailingStopParams` reads exactly one -- so an extra
     * field here would be silently dropped on the way rather than refused, which is
     * the shape of a control that looks configured and governs nothing.
     */
    const branch = trailingBranch();
    for (const absent of ["orderSize", "baseOrderSize", "stopLossPct", "takeProfit"]) {
      expect(branch, `${absent} must not reach the trailing-stop body`).not.toContain(absent);
    }
  });

  it("⚠ carries only the fields the form owns, and no `exchange`", () => {
    /*
     * The runtime half of `createBotRequest.test.ts`'s guarantee, restated for the
     * third arm: the account registry is authoritative for the venue, so the body
     * omits it entirely rather than sending a value that could disagree. The
     * compile-time half is `CREATE_BOT_REQUEST_HAS_NO_EXCHANGE` in `api/types.ts`,
     * and `keyof` over a union is the INTERSECTION of its members' keys -- so a new
     * arm cannot weaken it, but it also cannot be the thing that proves this arm
     * omits the field.
     */
    const body: CreateBotRequest = {
      botInstanceId: "bot-1toiyz",
      accountLabel: "acct-1",
      pair: "BTC-USD",
      capitalAsset: "USD",
      allocatedCapital: "1000",
      strategy: "trailing_stop",
      params: { trailPct: "5" },
    };
    expect(Object.keys(body)).not.toContain("exchange");
    expect(Object.keys(body).sort()).toEqual([
      "accountLabel",
      "allocatedCapital",
      "botInstanceId",
      "capitalAsset",
      "pair",
      "params",
      "strategy",
    ]);
    expect(Object.keys(body.params)).toEqual(["trailPct"]);
  });
});

describe("a prefilled trailing stop seeds the field like every other strategy", () => {
  /*
   * `proposalPrefill.test.ts` and `botClonePrefill.test.ts` prove both decoders
   * produce a trailing-stop seed carrying `trailPct`. Neither can prove the FORM
   * reads it: a component that decoded a perfect seed and then ignored it would
   * pass every test in both files, and the field would silently open empty on a
   * link that promised numbers. That is the seam this block covers.
   */
  function seedLine(name: string): string {
    const line = code(FORM)
      .split("\n")
      .find((l) => l.includes(`const [${name}, set`));
    expect(line, `no useState for ${name}`).toBeDefined();
    return line!;
  }

  it("derives a trailing-stop seed beside the grid and DCA ones", () => {
    const source = code(FORM);
    for (const strategy of ["grid", "dca", "trailing_stop"]) {
      expect(source, strategy).toContain(`seed?.fields.strategy === "${strategy}"`);
    }
  });

  it("⚠ seeds `trailPct` from that seed, with the manual visit's own default", () => {
    // The `?? ""` half matters as much as the seed half: a manual visit must be
    // byte-identical to what it was, which is the rule every other field here keeps.
    expect(seedLine("trailPct")).toContain('trailPrefill?.trailPct ?? ""');
  });

  it("seeds it the same way grid and DCA are seeded, not by a special path", () => {
    // Same shape as its neighbours -- a lazy initialiser reading the seed. A
    // trailing stop wired through an effect, or through a branch on where the
    // prefill came from, is the parallel path this form's docblock forbids.
    for (const [name, prefill] of [
      ["trailPct", "trailPrefill"],
      ["gridLines", "gridPrefill"],
      ["dropPct", "dcaPrefill"],
    ] as const) {
      expect(seedLine(name), name).toMatch(
        new RegExp(`useState\\(\\(\\) => ${prefill}\\?\\.`),
      );
    }
  });
});

describe("the venue bot-id cap is keyed on the venue, not on the strategy", () => {
  it("⚠ runs before validate() looks at the strategy at all", () => {
    /*
     * Kraken's 10-character budget (decision-log entry 90, DECISION 3) is a property
     * of the venue's `cl_ord_id` field, and every strategy's orders carry the bot id
     * the same way -- so it must not sit inside a strategy branch, where adding a
     * strategy would be one more place to forget it. This asserts the ORDER in the
     * source, which is the only mechanical form of "outside every branch".
     */
    const body = slice(code(FORM), "function validate(): Errors", "function buildRequest()");
    const check = body.indexOf("botInstanceIdError(botInstanceId, exchange)");
    const firstBranch = body.indexOf('strategy === "');
    expect(check).toBeGreaterThanOrEqual(0);
    expect(firstBranch).toBeGreaterThanOrEqual(0);
    expect(check, "the id check must precede every strategy branch").toBeLessThan(firstBranch);
  });

  it("passes the account's exchange to it, not the selected strategy", () => {
    expect(code(FORM)).toContain("botInstanceIdError(botInstanceId, exchange)");
    expect(code(FORM)).not.toMatch(/botInstanceIdError\([^)]*strategy/);
  });
});

describe("the risk-controls panel is honest about having no fields", () => {
  /** The trailing-stop arm of the Risk-controls section. */
  function riskPanel(): string {
    const section = slice(raw(FORM), "Risk controls</h2>", "{outcome !== null &&");
    return slice(section, 'strategy === "trailing_stop" ?', ': strategy === "dca" ?');
  }

  it("offers no stop-loss or take-profit input", () => {
    // There is no second percentage for this strategy, and a box the request cannot
    // carry is a control that looks configured and governs nothing.
    const panel = riskPanel();
    expect(panel).not.toContain("<TextInput");
    expect(panel).not.toContain("StopLossPct");
  });

  it("says which field is doing the work instead of rendering nothing", () => {
    // Dropping the section would read as "a trailing stop has no risk controls",
    // which is the opposite of true.
    expect(riskPanel()).toContain("The trail is the stop.");
  });
});
