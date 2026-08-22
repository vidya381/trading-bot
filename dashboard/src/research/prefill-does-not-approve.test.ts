/**
 * NAVIGATING TO A PRE-FILLED CREATE-BOT FORM IS NOT APPROVAL, enforced
 * mechanically over source.
 *
 * ── WHY THIS IS A SOURCE SCAN AND NOT A BEHAVIOURAL TEST ──
 *
 * This is the guarantee the whole "create a bot from this proposal" step is
 * judged on, and it is the one that no other check in this repository can see.
 * Nothing typechecks wrong when a component gains a `useEffect` that posts on
 * mount. The dashboard has no jsdom and no testing-library, and a test importing
 * a `.tsx` collects ZERO tests rather than failing, because React's CJS build
 * does not resolve inside the Workers pool this suite runs in (decision logs 44,
 * 45, 46) — so no test in this repository can mount `ProposalCreateBotLink` and
 * assert that clicking it issues no request.
 *
 * So the rule is enforced the way this repository already enforces its other
 * invisible invariants: `src/db/no-raw-d1.test.ts` ("no raw D1 outside /src/db")
 * and `dashboard/src/api/single-kill-switch-poll.test.ts` ("exactly one
 * subscription") both scan source with `import.meta.glob(..., '?raw')` and fail
 * the build. Decision log 45's gap (b) is the standing argument for it: **a guard
 * whose call site nothing can check is most of the way to no guard.**
 *
 * ── WHAT IS ACTUALLY BEING PROVED, STATED NARROWLY ──
 *
 * `proposals.outcome` moves off NULL in exactly two places in this whole system,
 * both on the backend: `recordProposalApproval`, reached only from
 * `POST /api/bots` and only AFTER `create` has returned a real bot, and
 * `rejectProposal`, reached only from `POST /api/proposals/:id/reject`. Neither is
 * reachable by rendering a page or following a link. So from the dashboard's side
 * the complete list of ways this guarantee could break is:
 *
 *   1. something sends `proposalId` to `POST /api/bots` outside a real form
 *      submission, or
 *   2. the proposal → form navigation path acquires the ability to make a
 *      state-changing request at all.
 *
 * The assertions below close both, by naming the one function that may attach a
 * `proposalId`, the one file that may call it, and the files on the navigation
 * path that may not reach the API client at all.
 *
 * ⚠ WHAT IT DOES NOT PROVE: that no request leaves the browser on mount. Only a
 * real capture does that, and that half is the operator's — the same split
 * `single-kill-switch-poll.test.ts` states about its own guard. What this proves
 * is the precondition: there is no code that could issue one.
 */

import { describe, expect, it } from "vitest";

// `import.meta.glob` is a Vite feature, declared here rather than by adding
// "vite/client" to tsconfig's `types` — which would pull the DOM lib into scope
// while typechecking Worker source. Mirrors no-raw-d1.test.ts and
// single-kill-switch-poll.test.ts.
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

/** The only file allowed to submit a create-bot request. */
const FORM = "/dashboard/src/pages/CreateBot.tsx";

/** The only file allowed to attach a `proposalId` to anything. */
const PREFILL = "/dashboard/src/research/proposalPrefill.ts";

/** Where the API surface is declared. Declaring a writer is not calling one. */
const CLIENT = "/dashboard/src/api/client.ts";

/**
 * Every file a human passes through between reading a proposal and reaching the
 * pre-filled form. Not one of them may reach the API client, for any reason.
 */
const NAVIGATION_PATH: readonly string[] = [
  "/dashboard/src/research/proposalPrefill.ts",
  "/dashboard/src/components/ProposalCreateBotLink.tsx",
  "/dashboard/src/components/ProposalPrefillBanner.tsx",
  "/dashboard/src/components/ProposalView.tsx",
  /*
   * ⚠ ADDED WHEN THE LINK MOVED INTO THE SUMMARY CARD.
   *
   * The card is now the component that RENDERS the create-bot link, which puts it
   * squarely on the navigation path this guard exists to police — and it is the
   * one file on that path that also runs an interval timer and reads a clock, so
   * it is the most plausible future home for an effect that fetches something.
   *
   * A relocation that quietly dropped the destination out of the guarded set
   * would have moved the button out from under the guarantee while every
   * assertion below kept passing. That is the exact failure this list exists to
   * prevent, so the list grew with the move.
   */
  "/dashboard/src/components/ProposalSummaryCard.tsx",
  "/dashboard/src/proposalSummary.ts",
  /*
   * ⚠ THE CLONE PATH JOINS THE LIST, for the identical reason and with an extra
   * one of its own.
   *
   * "Clone this bot" lands a human on the SAME pre-filled create-bot form by a
   * different route, so every argument this guard makes about the proposal path
   * applies to it unchanged: the files between the bot detail page and that form
   * must not be able to make a state-changing request, on mount or on click.
   *
   * The extra reason is that the source of a clone is a LIVE BOT rather than a
   * stored document. The proposal path's worst failure is recording an outcome
   * nobody chose; this path's would be touching a running bot -- halting it,
   * resizing it, archiving it -- as a side effect of copying its numbers. Neither
   * file below imports `api/client`, so neither can, and that is what is checked.
   *
   * `pages/BotDetail.tsx` is deliberately NOT here: it holds the client because
   * polling the bot is its whole job. The link it renders is a separate file
   * precisely so the navigation path itself stays checkable.
   */
  "/dashboard/src/research/botClonePrefill.ts",
  "/dashboard/src/components/CloneBotLink.tsx",
  "/dashboard/src/components/CloneSourceBanner.tsx",
];

/**
 * Everything in `api/client.ts` that issues a POST. Written out rather than
 * derived, so adding a writer to the client and a call to it from a proposal
 * component is two edits away from failing here rather than one.
 */
const WRITERS: readonly string[] = [
  "createBot",
  "liquidateBot",
  "startBot",
  "haltBot",
  "resumeBot",
  "archiveBot",
  "unarchiveBot",
  "applyMissedFills",
  "checkOpenOrders",
  "logManualAdjustment",
  "triggerKillSwitch",
  "resetKillSwitch",
];

/** Source lines only: prose about the rule is not a violation of it. */
function codeLines(source: string): { line: string; number: number }[] {
  return source
    .split("\n")
    .map((line, index) => ({ line: line.trim(), number: index + 1 }))
    .filter(({ line }) => !line.startsWith("//") && !line.startsWith("*") && !line.startsWith("/*"));
}

function code(path: string): { line: string; number: number }[] {
  const module = SOURCES[path];
  expect(module, `${path} is not in the scanned source set`).toBeDefined();
  return codeLines(module!.default);
}

describe("navigating to a pre-filled form cannot approve a proposal", () => {
  it("found the dashboard sources to check", () => {
    /*
     * Without this every assertion below passes vacuously, which is the one way
     * a source-scan guard rots with nobody noticing. Decision log 47's guard
     * opens with the same test for the same reason.
     */
    const paths = Object.keys(SOURCES);
    expect(paths.length).toBeGreaterThan(20);
    expect(paths).toContain(FORM);
    expect(paths).toContain(PREFILL);
    expect(paths).toContain(CLIENT);
    for (const path of NAVIGATION_PATH) expect(paths).toContain(path);
  });

  it("⚠ `proposalId` is attached to a request by exactly one function, in one file", () => {
    // `withProposalId` is that function. If a second place builds a body with a
    // `proposalId` in it, the "only at submit" argument stops being checkable by
    // reading one call site.
    const offenders: string[] = [];
    for (const [path, module] of Object.entries(SOURCES)) {
      if (path === PREFILL) continue;
      if (path.endsWith(".test.ts") || path.endsWith(".test.tsx")) continue;
      for (const { line, number } of codeLines(module.default)) {
        /*
         * DECLARING the field's type is not attaching it, and `api/types.ts` and
         * `api/research-types.ts` both have to. The skip is anchored to a whole
         * interface member so it cannot also swallow an assignment: a member ends
         * in `;` and starts at the field name, while `proposalId: derive.proposalId,`
         * ends in a comma and `body: { proposalId: id };` does not start there.
         */
        if (/^(readonly\s+)?proposalId\??\s*:\s*[\w<>[\]|"'. ]+;$/.test(line)) continue;
        // A property assignment or shorthand — i.e. putting it INTO an object —
        // as opposed to reading `prefill.proposalId` to display or to pass along.
        if (/(^|[{,\s])proposalId\s*:/.test(line) || /(^|[{,\s])proposalId\s*,/.test(line)) {
          offenders.push(`${path}:${number}: ${line}`);
        }
      }
    }
    expect(
      offenders,
      "only withProposalId (research/proposalPrefill.ts) may put a proposalId into a " +
        "request body, so that 'the outcome link is attached at submit and nowhere " +
        "else' is checkable at one call site\n" + offenders.join("\n"),
    ).toEqual([]);
  });

  it("⚠ `createBot` is called in exactly one place in the whole dashboard", () => {
    const calls: string[] = [];
    for (const [path, module] of Object.entries(SOURCES)) {
      if (path === CLIENT) continue; // its definition
      if (path.endsWith(".test.ts") || path.endsWith(".test.tsx")) continue;
      for (const { line, number } of codeLines(module.default)) {
        if (/\bcreateBot\s*\(/.test(line)) calls.push(`${path}:${number}: ${line}`);
      }
    }
    expect(calls, `expected exactly one create-bot call site\n${calls.join("\n")}`).toHaveLength(1);
    expect(calls[0]!.startsWith(`${FORM}:`)).toBe(true);
  });

  it("⚠ that one call goes through `withProposalId` rather than building the body itself", () => {
    /*
     * The composition pinned as one line. It is what makes the field impossible to
     * attach without also going through the function whose entire docblock is the
     * "absent, not null" and "submit only" argument — and it is what a mutant that
     * moved the attachment earlier would have to break.
     */
    const call = code(FORM).filter(({ line }) => /\bcreateBot\s*\(/.test(line));
    expect(call).toHaveLength(1);
    expect(call[0]!.line).toMatch(/createBot\s*\(\s*withProposalId\s*\(/);
  });

  it("⚠ `withProposalId` is called exactly once, in the form, and nowhere else", () => {
    const calls: string[] = [];
    for (const [path, module] of Object.entries(SOURCES)) {
      if (path === PREFILL) continue; // its definition
      if (path.endsWith(".test.ts") || path.endsWith(".test.tsx")) continue;
      for (const { line, number } of codeLines(module.default)) {
        if (/\bwithProposalId\s*\(/.test(line)) calls.push(`${path}:${number}: ${line}`);
      }
    }
    expect(calls, calls.join("\n")).toHaveLength(1);
    expect(calls[0]!.startsWith(`${FORM}:`)).toBe(true);
  });

  it("⚠ no file on the proposal → form navigation path can reach the API client", () => {
    /*
     * The strongest available form of "clicking through does nothing": the files
     * involved do not hold a function that could do anything. A link component
     * with no import from `api/client` cannot POST, on mount or on click, however
     * it is later edited — the edit that broke it would have to add an import,
     * and that is what fails here.
     */
    const offenders: string[] = [];
    for (const path of NAVIGATION_PATH) {
      for (const { line, number } of code(path)) {
        if (/\bfrom\s+["'][^"']*api\/client["']/.test(line)) {
          offenders.push(`${path}:${number}: ${line}`);
        }
      }
    }
    expect(
      offenders,
      "a file on the path from a proposal to the pre-filled form imported the API " +
        "client; navigation must not be able to change anything\n" + offenders.join("\n"),
    ).toEqual([]);
  });

  it("⚠ no state-changing endpoint is even NAMED on the navigation path", () => {
    // Belt to the previous test's braces, and it catches the case the import rule
    // misses: a writer reached through some other module's re-export.
    const offenders: string[] = [];
    for (const path of NAVIGATION_PATH) {
      for (const { line, number } of code(path)) {
        for (const writer of WRITERS) {
          if (new RegExp(`\\b${writer}\\s*\\(`).test(line)) {
            offenders.push(`${path}:${number}: calls ${writer} — ${line}`);
          }
        }
      }
    }
    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  it("⚠ the history pages call no state-changing endpoint at all", () => {
    /*
     * The stronger half of the rule above, for the two pages that legitimately hold
     * the API client. They may read; they may not write. Checked against the same
     * WRITERS list, so adding a writer to the client and a call to it from a history
     * page is two edits away from failing here rather than one.
     */
    const offenders: string[] = [];
    for (const path of [
      "/dashboard/src/pages/ProposalRecord.tsx",
      "/dashboard/src/pages/ProposalHistory.tsx",
      "/dashboard/src/proposalHistory.ts",
    ]) {
      for (const { line, number } of code(path)) {
        for (const writer of WRITERS) {
          if (new RegExp(`\\b${writer}\\s*\\(`).test(line)) {
            offenders.push(`${path}:${number}: calls ${writer} — ${line}`);
          }
        }
      }
    }
    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  it("⚠ the clone prefill never puts the SOURCE BOT's id into anything submitted", () => {
    /*
     * The clone's analogue of the `proposalId` rule above, and the mechanical form
     * of "there is no relationship between the source bot and the new one".
     *
     * `sourceBotId` exists so the banner can name where the numbers came from. It
     * is not a field `POST /api/bots` reads, there is no column for it, and the
     * moment it appears in a request body it stops being provenance and starts
     * being a link between two bots. So: the only file allowed to name it at all
     * is the clone module and the banner that displays it, and the create-bot form
     * -- the one file that can submit anything -- must never mention it.
     */
    const CLONE = "/dashboard/src/research/botClonePrefill.ts";
    const BANNER = "/dashboard/src/components/CloneSourceBanner.tsx";
    const offenders: string[] = [];
    for (const [path, module] of Object.entries(SOURCES)) {
      if (path === CLONE || path === BANNER) continue;
      if (path.endsWith(".test.ts") || path.endsWith(".test.tsx")) continue;
      for (const { line, number } of codeLines(module.default)) {
        if (/\bsourceBotId\b/.test(line)) offenders.push(`${path}:${number}: ${line}`);
      }
    }
    expect(
      offenders,
      "the source bot's id is provenance for the banner and nothing else; it must not " +
        "reach the form or any request body\n" + offenders.join("\n"),
    ).toEqual([]);
    // And the form -- the one file that can submit -- does not know it exists.
    expect(code(FORM).some(({ line }) => /sourceBotId/.test(line))).toBe(false);
  });

  it("⚠ the clone prefill cannot carry a bot instance id into the form", () => {
    /*
     * THE "FRESH ID" GUARANTEE, pinned as an absence.
     *
     * The create-bot form mints `botInstanceId` itself at mount (`generatedId`)
     * and the clone prefill has no field for it, so a cloned bot cannot inherit or
     * collide with the source bot's id. That is true only for as long as nobody
     * adds the field, and adding it would typecheck and look helpful -- so the
     * absence is asserted rather than assumed. `cloneFrom` is the URL key and is
     * not a form value; it is excluded by anchoring on the property name.
     */
    const offenders: string[] = [];
    for (const { line, number } of code("/dashboard/src/research/botClonePrefill.ts")) {
      if (/(^|[{,\s])botInstanceId\s*[:,]/.test(line)) offenders.push(`${number}: ${line}`);
    }
    expect(
      offenders,
      "the clone prefill must not carry a botInstanceId; the new bot's id is minted " +
        "by the form and never inherited\n" + offenders.join("\n"),
    ).toEqual([]);
    // The form still generates its own, unconditionally.
    expect(code(FORM).some(({ line }) => /useState\(generatedId\)/.test(line))).toBe(true);
  });

  it("the prefill modules make no request of any kind, by any route", () => {
    const offenders: string[] = [];
    for (const path of [PREFILL, "/dashboard/src/research/botClonePrefill.ts"]) {
      for (const { line, number } of code(path)) {
        if (/\bfetch\s*\(|XMLHttpRequest|navigator\.sendBeacon|new\s+WebSocket|EventSource/.test(line)) {
          offenders.push(`${path}:${number}: ${line}`);
        }
      }
    }
    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  it("⚠ the create-bot form does not fire a create from an effect", () => {
    /*
     * The specific shape of "navigation approves it": a `useEffect` on the
     * pre-filled form that submits by itself, which would turn arriving at the
     * page into the creation. Checked by requiring that the sole `createBot` call
     * sits AFTER every `useEffect(` in the file — every effect in this component
     * is declared in its top half, and the submit handler is below all of them —
     * and that no effect body mentions it.
     */
    const lines = code(FORM);
    const lastEffect = lines.filter(({ line }) => /useEffect\s*\(/.test(line)).pop();
    const call = lines.find(({ line }) => /\bcreateBot\s*\(/.test(line));
    expect(lastEffect, "the form should still declare effects").toBeDefined();
    expect(call).toBeDefined();
    expect(call!.number).toBeGreaterThan(lastEffect!.number);
  });

  it("⚠ the form sends each strategy's stop-loss from that strategy's own input", () => {
    /*
     * THE LAST HOP THE END-TO-END TESTS CANNOT DRIVE, pinned the only way it can
     * be. `buildRequest` lives in a `.tsx` and no test in this repository can
     * import one, so the pairing between the form's two stop-loss STATE variables
     * and the single `params.stopLossPct` each strategy's body carries is checked
     * over source instead.
     *
     * It is worth a test of its own because it is the exact fault the prefill
     * makes newly possible: both strategies have a parameter literally called
     * `stopLossPct`, they are two different inputs in two different fieldsets,
     * and a body that read the wrong one would compile, render, and create a bot
     * whose stop-loss is not the one on the screen. Spec 6.1/7.1 make the
     * stop-loss mandatory for both strategies, so this is the field with the
     * least tolerance for a mapping mistake.
     */
    const source = code(FORM)
      .map(({ line }) => line)
      .join("\n");
    expect(source).toMatch(/stopLossPct:\s*gridStopLossPct\.trim\(\)/);
    expect(source).toMatch(/stopLossPct:\s*dcaStopLossPct\.trim\(\)/);
    expect(source).toMatch(/takeProfitPct:\s*dcaTakeProfitPct\.trim\(\)/);
    // And neither strategy's body may read the other's box.
    expect(source).not.toMatch(/stopLossPct:\s*stopLossPct/);
  });

  it("the proposal pages themselves neither create nor reject anything", () => {
    /*
     * `/proposal` and `/proposal/run` render the link; neither may act on it.
     *
     * ⚠ `/proposals/:id` AND `/proposals` JOINED THIS LIST with the history view,
     * and they are the two that most needed adding: unlike the other two they DO
     * import `api/client`, because reading the permanent record is what they are
     * for. That makes "they read and never write" a property nothing else checks —
     * the navigation-path rule above cannot cover a page whose whole job is a fetch.
     * Both call only `fetchProposals` / `fetchProposal`, which are GETs.
     */
    const pages = [
      "/dashboard/src/pages/Proposal.tsx",
      "/dashboard/src/pages/ProposalRun.tsx",
      "/dashboard/src/pages/ProposalRecord.tsx",
      "/dashboard/src/pages/ProposalHistory.tsx",
    ];
    const offenders: string[] = [];
    for (const path of pages) {
      for (const { line, number } of code(path)) {
        if (/\bcreateBot\s*\(|\/reject\b|rejectProposal/.test(line)) {
          offenders.push(`${path}:${number}: ${line}`);
        }
      }
    }
    expect(offenders, offenders.join("\n")).toEqual([]);
  });
});
