/**
 * "Create a bot from this proposal" — the PREFILL, and nothing more.
 *
 * ── ⚠ WHAT THIS IS, STATED AGAINST THE THING IT LOOKS LIKE ──
 *
 * Spec 21.1 allows exactly one shape here and forbids the other, in one sentence:
 * the only way a proposal becomes a bot is *"a human reading it and filling in (or
 * confirming a prefilled) create-bot form, which runs every check it runs today,
 * unchanged and unweakened."* The parenthesis is this module. The rest of that
 * sentence is the constraint every decision below answers to.
 *
 * So: this module MOVES VALUES INTO A FORM. It does not create anything, it does
 * not approve anything, it does not weaken or skip a check, and it does not give
 * the create-bot form a second mode. The form it fills in is `pages/CreateBot.tsx`
 * — THE form, the same component `/bots/new` has always mounted for manual
 * creation, with the same validation, the same two real network calls, the same
 * submit path and the same server-side decoders, tradability gate, mandatory
 * stop-loss and binding capital compare-and-swap. What arrives from here is a set
 * of DIFFERENT DEFAULT VALUES in ordinary `useState`. Nothing else about that form
 * knows a proposal exists, apart from one banner and one optional body field.
 *
 * ── ⚠ THE ONE SENTENCE IN THE RECORD THAT THIS STEP APPEARS TO CONTRADICT ──
 *
 * `src/api/handlers.ts` (`createBot`, decision log 45 PART 2) says: *"A field that
 * PREFILLED the form from a stored proposal would be the one-click bridge 21.1
 * forbids."* That sentence is still true and this module does not do what it
 * forbids, and the distinction is worth stating precisely rather than glossed:
 *
 *   * WHAT IT FORBIDS is `POST /api/bots` READING the `proposals` row and taking
 *     parameters out of it. That would make the record an INPUT to a creation, so
 *     a wrong stored value could become a real bot with no human in between, and
 *     `proposalId` would stop being a record of a decision and start being a
 *     substitute for one.
 *   * WHAT THIS DOES is carry values the human is ALREADY LOOKING AT, in their own
 *     browser, from one page of the dashboard to another, through the URL. The
 *     backend is not involved and its behaviour is byte-identical: it still reads
 *     NOTHING out of the proposal record except to check the row can take an
 *     outcome, and every parameter still arrives in the request body. The
 *     api.test.ts test that submits a body deliberately DISAGREEING with the
 *     proposal and asserts the bot gets the BODY's numbers is unchanged and still
 *     passes — which is the mechanical statement of the same fact.
 *
 * The practical consequence, and the reason this is not a distinction without a
 * difference: **a human can edit every value between here and the submit, and the
 * edited value is the one that becomes the bot.** The proposal cannot supply a
 * value to the server, so it still cannot supply a wrong one.
 *
 * ── WHY THE URL, AND NOT ROUTER STATE ──
 *
 * `navigate(path, { state })` would also keep one component, and it was the other
 * real candidate. The URL wins on four counts, three of them specific to this
 * feature:
 *
 *  1. IT IS THE ONLY CROSS-ROUTE DATA PATTERN THIS DASHBOARD ALREADY HAS.
 *     `pages/Alerts.tsx` puts its filters in `useSearchParams` and says why: a view
 *     that is worth reaching should be reachable. Nothing here uses `location.state`
 *     for anything, and inventing a second convention for the one screen that
 *     commits capital is the wrong place to be novel.
 *  2. IT IS VISIBLE. A prefill carried in router state is invisible to the human it
 *     is being handed to; the same prefill in the address bar can be read, checked
 *     against the proposal page, and pasted into a message. For a feature whose
 *     entire design principle is "no hidden bridge from a proposal to a creation",
 *     an invisible transport is the wrong default.
 *  3. THE BANNER AND THE VALUES TRAVEL TOGETHER OR NOT AT ALL. `readProposalPrefill`
 *     refuses everything unless a `proposalId` and a recognised `strategy` are both
 *     present (see below), so there is no reload, no new tab and no hand-edit that
 *     can produce prefilled numbers with no banner over them. Router state would
 *     have the same property only by accident of it all being one object.
 *  4. It survives a reload and a copy-paste, which router state does not, and the
 *     failure mode when something IS missing is an ordinary blank form.
 *
 * ⚠ THE COST, STATED: the URL is a snapshot of the PROPOSAL's values, and it is
 * never rewritten as the human edits. So a reload restores the proposal's numbers
 * and discards the edits — the same thing a reload of a half-typed manual form
 * does. The alternative (syncing edits back into the URL) is worse and was
 * rejected: it would make the address bar claim to be the proposal's parameters
 * while actually holding a human's revisions, which is the one thing the banner
 * must never be wrong about.
 *
 * ── FAIL CLOSED, AND WHAT "CLOSED" MEANS FOR A FORM ──
 *
 * The input here is a URL, which is untrusted text in exactly the sense decision
 * log 45's pasted proposal was — the paste that reached `formatMoney` with
 * `undefined` and took the whole page to a blank black screen. Two rules follow:
 *
 *   * IDENTITY IS ALL-OR-NOTHING. No `proposalId`, or a `strategy` that is not one
 *     of the two real ones, means NO PREFILL AT ALL — not a partial one. `/bots/new`
 *     then renders exactly the manual form it always has, with no banner. This is
 *     what makes "prefilled values always carry their provenance" a structural
 *     property rather than a thing every caller must remember.
 *   * A FIELD THAT CANNOT BE READ IS LEFT EMPTY, NEVER GUESSED. An absent or
 *     unusable field is recorded in `incomplete` and the form keeps its ordinary
 *     default, and the banner names it. Substituting a plausible number would be
 *     the degraded-result-indistinguishable-from-a-good-one failure spec 21.5
 *     requirement 6 is about.
 *
 * A field that IS present is passed through VERBATIM, including junk. That is
 * deliberate: the form's own validator is the thing that judges values, and a
 * silently dropped bad value would hide from the human that the URL claimed it.
 *
 * ── NOTHING HERE TOUCHES THE NETWORK ──
 *
 * No import from `../api/client`, no fetch, no side effect of any kind, in either
 * direction. Navigating to a prefilled form is a pure `<Link>`, and a proposal's
 * `outcome` is written by exactly one thing: a real, completed `POST /api/bots`
 * carrying `proposalId`, at submit time, through `withProposalId` below.
 * `prefill-does-not-approve.test.ts` enforces that at the source level, because it
 * is the guarantee this whole step is judged on and no typecheck can see it.
 */

import type { DeriveResponse } from "../api/research-types";
import { freshnessOf } from "../proposal";
import {
  stalenessOf,
  type ProposalStaleness,
  type StalenessInput,
} from "../../../src/research/staleness";
import {
  checkParamsShape,
  isProposalStrategy,
} from "../../../src/research/proposal-shape";

/** The create-bot route, in one place so the link and the tests cannot disagree. */
export const CREATE_BOT_PATH = "/bots/new";

/**
 * THE STRATEGIES THE CREATE-BOT FORM CAN BE PREFILLED FOR.
 *
 * ⚠ IT HAS BEEN THREE THINGS, AND THE HISTORY IS THE ARGUMENT FOR ITS PRESENT
 * SHAPE. It began as `= ProposalStrategy` while both unions held the same two
 * members. It became its own two-member literal when `ProposalStrategy` grew
 * `trailing_stop` and this one could not follow, because `/bots/new` had no
 * trailing-stop controls and `POST /api/bots` had no branch for one. It now holds
 * all three, because both of those are built: `CreateBotRequest` has a
 * `TrailingStopParamsInput` arm and the form has a `trailPct` field.
 *
 * ⚠ THAT IT CURRENTLY MATCHES `ProposalStrategy` AGAIN IS NOT A REASON TO ALIAS
 * IT. The two questions stayed different the whole way through -- "what can a
 * proposal be ABOUT" against "what can `/bots/new` BUILD" -- and the aliased
 * version was silently wrong for however long it took somebody to notice that one
 * union had grown. Written out as its own literal, with its own guard below, so
 * the next strategy that is proposable before it is creatable separates them
 * again by being absent HERE rather than by being wrong everywhere.
 *
 * It is deliberately NOT pinned to `CreateBotRequest["strategy"]` by an import:
 * this module is one of the two the dashboard shares across the `tsc` seam. The
 * agreement is pinned by a test instead, the same way every other mirror here is.
 */
export const PREFILL_STRATEGIES = ["grid", "dca", "trailing_stop"] as const;

export type PrefillStrategy = (typeof PREFILL_STRATEGIES)[number];

/**
 * A label the create-bot form can actually be filled from.
 *
 * ⚠ IT STILL ASKS TWO QUESTIONS, THOUGH BOTH CURRENTLY ANSWER THE SAME SET. A
 * label must be a real proposal strategy AND be in `PREFILL_STRATEGIES`. Today
 * every member of the first is a member of the second, so the second conjunct
 * rejects nothing -- and it is kept, because it is the entire mechanism by which
 * a future proposable-but-not-yet-creatable strategy gets refused here instead of
 * being passed through to a form with no controls for it. `proposalPrefill.test.ts`
 * asserts the present coincidence explicitly, so the day it stops holding is a
 * test failure that names the change rather than a silent widening.
 */
export function isPrefillStrategy(value: unknown): value is PrefillStrategy {
  return (
    isProposalStrategy(value) && (PREFILL_STRATEGIES as readonly string[]).includes(value)
  );
}

// ---------------------------------------------------------------------------
// The mapped form values
// ---------------------------------------------------------------------------

/**
 * ⚠ THESE KEYS ARE THE CREATE-BOT FORM'S OWN STATE NAMES, NOT THE PROPOSAL'S.
 *
 * The two vocabularies genuinely differ, and that difference is the whole of the
 * mapping this module exists to get right:
 *
 *   | proposal (`GridParams`/`DcaParams`) | form (`CreateBot.tsx` state)      |
 *   | ----------------------------------- | --------------------------------- |
 *   | grid `stopLossPct`                  | `gridStopLossPct`                 |
 *   | dca  `stopLossPct`                  | `dcaStopLossPct`                  |
 *   | dca  `takeProfitPct`                | `dcaTakeProfitPct`                |
 *
 * BOTH strategies carry a field literally called `stopLossPct` and they are
 * different form inputs, mounted in different fieldsets. A mapping that wrote
 * "the" stop-loss into one variable would be correct for one strategy and
 * silently wrong for the other — a grid proposal creating a bot with no stop-loss
 * where the human saw one on screen. That is the specific bug the mutation run
 * for this step targets first, and it is why the form's names are used here
 * rather than the proposal's.
 *
 * Numbers arrive as strings because every input on that form holds a string and
 * no float is ever constructed on the way (`format.ts`'s standing rule).
 */
export interface GridPrefillFields {
  readonly strategy: "grid";
  readonly lowerBound: string;
  readonly upperBound: string;
  readonly gridLines: string;
  readonly spacing: "arithmetic" | "geometric";
  readonly orderSize: string;
  readonly gridStopLossPct: string;
  /** "" when the proposal left it unset — an OPTIONAL field for grid. */
  readonly takeProfitAmount: string;
  readonly breakoutTakeProfit: boolean;
  /** "" when unset; the backend defaults it. */
  readonly breakoutThresholdPct: string;
}

export interface DcaPrefillFields {
  readonly strategy: "dca";
  readonly baseOrderSize: string;
  readonly additionalOrderSize: string;
  readonly stepMultiplier: string;
  readonly dropPct: string;
  readonly maxAdditionalBuys: string;
  readonly dcaTakeProfitPct: string;
  readonly dcaStopLossPct: string;
  readonly autoRestart: boolean;
  /*
   * ⚠ NO `sellOnStopLoss`. It is the one DCA parameter the create-bot form does
   * not offer, because the backend rejects `true` as unimplemented
   * (`validateDcaParams`) and the form therefore always sends `false` with no
   * toggle. A proposal cannot legitimately carry `true` — 21.5 requirement 3 runs
   * the real decoders before a human ever sees it — but "cannot legitimately"
   * is not "cannot", and a value silently dropped on the way to a form is exactly
   * the failure this module is written against. So a `true` is not mapped and is
   * not hidden either: it lands in `unrepresentable`, the banner says so, and the
   * form submits `false` where the human can see that is what it is doing.
   */
}

/**
 * Section 22's one parameter, and the one case in this table where the wire name
 * and the form's state name are THE SAME WORD.
 *
 * ⚠ THAT SAMENESS IS A FACT, NOT A SHORTCUT, and it is worth saying why the
 * mapping table above does not gain a row. Grid and DCA both carry a parameter
 * literally called `stopLossPct` into two different DOM nodes, which is what
 * forces `gridStopLossPct` / `dcaStopLossPct` and is the specific bug the mutation
 * run for that step targeted first. `trailPct` collides with nothing: no other
 * strategy has a field of that name, and the create form's state is called
 * `trailPct` too. So the identity mapping here is the CORRECT mapping rather than
 * an unwritten one, and a later strategy that did collide would still have to
 * declare its own prefixed name.
 *
 * ⚠ NO STOP-LOSS AND NO ORDER SIZE, matching `TrailingStopParamsInput`. The trail
 * is the stop and the single entry is sized by `allocatedCapital` (spec 22.2
 * decisions 1 and 4), so there is no third value for a URL to carry -- which also
 * means this strategy has no optional field, no boolean, and nothing that can
 * arrive as `null`. It is the simplest arm of this union by some distance, and
 * the encode/decode round trip below is correspondingly total.
 */
export interface TrailingStopPrefillFields {
  readonly strategy: "trailing_stop";
  readonly trailPct: string;
}

export type PrefillFields =
  | GridPrefillFields
  | DcaPrefillFields
  | TrailingStopPrefillFields;

/**
 * Everything `/bots/new` needs in order to open pre-filled AND to say honestly
 * where the values came from.
 *
 * The provenance half is not decoration. Decision log 46 settled the constraint
 * before any of this was built: *"A visible AI-sourced banner is required on the
 * form when it has been prefilled, so nobody reviews model output believing they
 * typed it."* Every field below that is not a form value exists to make that
 * banner say something true.
 */
export interface ProposalPrefill {
  /**
   * The permanent record's id (migration 0009). Carried so the banner can name it
   * and so the SUBMIT can pass it to `POST /api/bots` — those are its only two
   * uses, and neither is an input to the bot.
   */
  readonly proposalId: string;
  readonly strategy: PrefillStrategy;
  readonly accountLabel: string;
  readonly pair: string;
  readonly capitalAsset: string;
  readonly allocatedCapital: string;
  /**
   * `DeriveResponse.selectedAt` — when the derive request resolved this pair to a
   * candidate.
   *
   * ⚠ LABELLED FOR WHAT IT IS AND NOT CALLED A FETCH TIME. The response carries no
   * "the proposal record was created at" field, and `selectedAt` is the closest
   * honest answer to "when was this proposal made": it is the start of the call
   * that produced it. The real fetch times — the ones 21.5 requirement 4 is about
   * — are in `stalenessInputs`, separately, and they are what the staleness
   * verdict is computed from. `proposal.ts` keeps exactly this distinction with
   * its `AssemblyTimestamp` type and it is kept here for the same reason.
   *
   * Null when it could not be read.
   */
  readonly generatedAt: number | null;
  /**
   * The four real fetch times, each already PAIRED with its own threshold.
   *
   * ⚠ THE PAIRING IS CARRIED, NOT RE-DERIVED, AND THAT IS DELIBERATE. `freshnessOf`
   * builds these from the same four objects the ages come from, and its own
   * docblock says why: *"a component that paired them itself could pair the capital
   * ledger's age against the price window's threshold and look entirely correct."*
   * The price threshold in particular is per-strategy (15 min grid, 60 min DCA),
   * so a create-bot page that looked the thresholds up again would be a second
   * place that lookup can be wrong. Carrying the pair means there is still exactly
   * one.
   */
  readonly stalenessInputs: readonly StalenessInput[];
  readonly fields: PrefillFields;
  /**
   * Fields that were absent or unreadable, so the form kept its ordinary default.
   * Named in the banner. Empty on every prefill this dashboard itself produces.
   */
  readonly incomplete: readonly string[];
  /**
   * Proposed values this form has no control for and therefore does not carry.
   * See the `sellOnStopLoss` note above. Empty on every real proposal.
   */
  readonly unrepresentable: readonly string[];
}

// ---------------------------------------------------------------------------
// Encoding: the proposal page's link
// ---------------------------------------------------------------------------

/**
 * The wire names, which are the PROPOSAL's field names rather than the form's.
 *
 * Chosen that way on purpose: the URL sits beside the proposal page in a human's
 * browser, and a reader comparing the two should see the same words. The
 * translation to the form's names happens once, in `readProposalPrefill`, which is
 * the single place the mapping table above is implemented.
 */
const KEY = {
  proposalId: "proposalId",
  strategy: "strategy",
  accountLabel: "accountLabel",
  pair: "pair",
  capitalAsset: "capitalAsset",
  allocatedCapital: "allocatedCapital",
  generatedAt: "generatedAt",
  freshness: "freshness",
} as const;

/** One `{key, at, thresholdMs}` triple. `at` is empty when the input never fetched. */
function encodeFreshness(inputs: readonly StalenessInput[]): string {
  return inputs
    .map((input) => `${input.key}:${input.at === null ? "" : input.at}:${input.thresholdMs}`)
    .join(",");
}

function decodeFreshness(raw: string | null): readonly StalenessInput[] {
  if (raw === null || raw.trim() === "") return [];
  const inputs: StalenessInput[] = [];
  for (const part of raw.split(",")) {
    const bits = part.split(":");
    if (bits.length !== 3) continue;
    const key = bits[0] ?? "";
    const at = bits[1] ?? "";
    const threshold = bits[2] ?? "";
    if (key === "") continue;
    // A threshold that cannot be read is not defaulted to anything: without it
    // there is no comparison to make, so the whole triple is dropped and the
    // input simply is not among those checked. `worstVerdict` answers `unknown`
    // for an empty set, never `fresh`, so dropping every triple fails closed.
    if (!/^\d+$/.test(threshold)) continue;
    inputs.push({
      key,
      at: /^\d+$/.test(at) ? Number(at) : null,
      thresholdMs: Number(threshold),
    });
  }
  return inputs;
}

/**
 * Turn a real `/derive` response into the query string `/bots/new` reads.
 *
 * Returns NULL when the proposal's params do not hold up, using the SAME
 * `checkParamsShape` the proposal page's own parameter table is gated on
 * (decision log 45 PART 5). That is not belt-and-braces: a params object whose
 * fields disagree with its own strategy label is exactly the thing that produced
 * a blank black page, and reading `params.baseOrderSize` off a grid-shaped object
 * here would produce a form pre-filled with `undefined` — the same fault one layer
 * later, where it commits capital instead of rendering a table. A refused shape
 * means no link is offered at all.
 */
export function prefillSearchParams(derive: DeriveResponse): URLSearchParams | null {
  const proposal = derive.derive.proposal;
  const shape = checkParamsShape(proposal.params);
  if (!shape.ok) return null;
  /*
   * ⚠ A SECOND REFUSAL, AND IT IS NOT A SHAPE FAULT -- the same one
   * `cloneSearchParams` has always made explicitly, and the one THIS function was
   * missing. `checkParamsShape` answers "are these params coherent for their own
   * label"; a trailing-stop proposal's are, and were, long before the form could
   * build one. What it cannot answer is whether `/bots/new` has anywhere to PUT
   * them.
   *
   * Without this line the answer came from a ternary further down, which sent
   * every non-grid strategy through the DCA field list -- so a trailing-stop
   * proposal produced an offered link carrying no parameters, and the operator
   * landed on a blank form with no banner. Refused HERE, the proposal page states
   * it on the page the button is on, which is where a person can act on it.
   *
   * Today this rejects nothing: every `ProposalStrategy` is a `PrefillStrategy`.
   * It is the guard for the next one that is not.
   */
  if (!isPrefillStrategy(shape.strategy)) return null;

  const params = new URLSearchParams();
  params.set(KEY.proposalId, derive.proposalId);
  params.set(KEY.strategy, shape.strategy);
  params.set(KEY.accountLabel, derive.bundle.candidate.accountLabel);
  params.set(KEY.pair, derive.bundle.candidate.pair);
  params.set(KEY.capitalAsset, proposal.capitalAsset);
  params.set(KEY.allocatedCapital, proposal.allocatedCapital);
  params.set(KEY.generatedAt, String(derive.selectedAt));
  // The four real fetch times with the thresholds `freshnessOf` paired them with.
  params.set(KEY.freshness, encodeFreshness(freshnessOf(derive).thresholds));

  /*
   * The params object, under its OWN field names. Read through an index type for
   * `proposalFields.ts`'s stated reason: the value arrived as JSON, `checkParamsShape`
   * is the only thing that established its shape, and narrowing it with a cast
   * would let the type system claim a guarantee it did not verify.
   */
  const p = proposal.params as unknown as Readonly<Record<string, unknown>>;
  // The table, not a ternary. A ternary has a fall-through arm and this does not:
  // an unlisted strategy cannot silently take another strategy's field list,
  // because `isPrefillStrategy` above has already refused it.
  for (const field of WIRE_FIELDS[shape.strategy]) {
    const value = p[field];
    // `null` is a real, present value for the two optional grid fields and it
    // encodes as the empty string. `undefined` cannot occur — `checkParamsShape`
    // has already refused it — and is skipped rather than stringified into the
    // literal text "undefined", which is what would land in the form's input box.
    if (value === undefined) continue;
    params.set(field, value === null ? "" : String(value));
  }
  return params;
}

/**
 * The full `to=` for a `<Link>`, or null when this proposal cannot offer one.
 *
 * A string rather than an object so the button is a plain link with a real href a
 * human can see, middle-click, and copy — see the module header on visibility.
 */
export function createBotHref(derive: DeriveResponse): string | null {
  const params = prefillSearchParams(derive);
  return params === null ? null : `${CREATE_BOT_PATH}?${params.toString()}`;
}

/**
 * The wire field names per strategy.
 *
 * ⚠ NOT a mirror of the backend's lists, and it must not become one:
 * `GRID_PROPOSAL_FIELDS` / `DCA_PROPOSAL_FIELDS` in `src/research/proposal-shape.ts`
 * are the authority (they are themselves spec 21.4 Stage 3's own quotation), and
 * `proposalPrefill.test.ts` asserts these two arrays EQUAL them, element for
 * element. They are written out here only so the encode loop has a defined order;
 * a field added to the backend's list and not here fails that test rather than
 * silently dropping out of every prefilled form.
 */
const GRID_WIRE_FIELDS: readonly string[] = [
  "upperBound",
  "lowerBound",
  "gridLines",
  "spacing",
  "orderSize",
  "stopLossPct",
  "breakoutTakeProfit",
  "breakoutThresholdPct",
  "takeProfitAmount",
];

/**
 * ONE FIELD, pinned against `TRAILING_STOP_PROPOSAL_FIELDS` by the same test that
 * pins the other two. A one-element list looks like a thing not worth a constant;
 * it is here for exactly the reason the other two are -- so that a field added to
 * the backend's list and not to this one fails a test rather than dropping out of
 * every prefilled form in silence.
 */
const TRAILING_STOP_WIRE_FIELDS: readonly string[] = ["trailPct"];

const DCA_WIRE_FIELDS: readonly string[] = [
  "baseOrderSize",
  "additionalOrderSize",
  "stepMultiplier",
  "dropPct",
  "maxAdditionalBuys",
  "takeProfitPct",
  "stopLossPct",
  "autoRestart",
  "sellOnStopLoss",
];

/** Exposed for the test that pins them against the backend's own lists. */
/**
 * Keyed by `PrefillStrategy`, NOT by `ProposalStrategy`, and the annotation is
 * still what says so even now that the two hold the same members. A strategy is
 * refused BEFORE this is indexed (`isPrefillStrategy`, at both the encoder and
 * both decoders), rather than indexed and found `undefined` -- which would loop
 * zero fields and emit a URL carrying a strategy label and no parameters at all.
 *
 * ⚠ THAT IS NOT HYPOTHETICAL: IT IS WHAT THIS FILE USED TO DO. Before trailing
 * stop was creatable, `prefillSearchParams` chose its field list with
 * `shape.strategy === "grid" ? GRID : DCA` and had no guard, so a trailing-stop
 * proposal took the DCA list, found every one of those nine fields `undefined` on
 * a `{ trailPct }` object, set none of them, and produced a real, offered link
 * whose query string carried `strategy=trailing_stop` and no parameters. The
 * decoder then refused it and the operator landed on a blank manual form with no
 * banner and no statement of why. The guard below is what makes that shape
 * impossible rather than merely absent today.
 */
export const WIRE_FIELDS: Readonly<Record<PrefillStrategy, readonly string[]>> = Object.freeze({
  grid: GRID_WIRE_FIELDS,
  dca: DCA_WIRE_FIELDS,
  trailing_stop: TRAILING_STOP_WIRE_FIELDS,
});

// ---------------------------------------------------------------------------
// Decoding: what /bots/new reads
// ---------------------------------------------------------------------------

/**
 * A required text value. Missing or empty → the form's default, and the field
 * name is recorded so the banner can say the prefill was incomplete.
 */
function text(
  params: URLSearchParams,
  key: string,
  incomplete: string[],
  fallback = "",
): string {
  const raw = params.get(key);
  if (raw === null || raw.trim() === "") {
    incomplete.push(key);
    return fallback;
  }
  return raw.trim();
}

/**
 * An OPTIONAL text value: `""` is a real answer meaning "the proposal left this
 * unset", so it is NOT incomplete. Only an absent key is.
 *
 * ⚠ THIS IS THE `null`-IS-PRESENT RULE, ONE LAYER DOWN. `checkParamsShape` exists
 * because the proposal view emits `null` for an unset optional and never omits the
 * key, so "absent" and "null" are different facts. The encoder writes `null` as an
 * empty string and this reads it back as "unset" — while a key that never arrived
 * is still reported as missing.
 */
function optionalText(params: URLSearchParams, key: string, incomplete: string[]): string {
  const raw = params.get(key);
  if (raw === null) {
    incomplete.push(key);
    return "";
  }
  return raw.trim();
}

/**
 * A strict boolean. Anything that is not exactly `"true"` or `"false"` is
 * unreadable rather than falsy — `Boolean("false")` is `true`, and a breakout
 * take-profit silently flipping on is not a rounding error.
 */
function bool(
  params: URLSearchParams,
  key: string,
  incomplete: string[],
  fallback: boolean,
): boolean {
  const raw = params.get(key);
  if (raw === "true") return true;
  if (raw === "false") return false;
  incomplete.push(key);
  return fallback;
}

function spacingOf(
  params: URLSearchParams,
  incomplete: string[],
): "arithmetic" | "geometric" {
  const raw = params.get("spacing");
  if (raw === "arithmetic" || raw === "geometric") return raw;
  // The form's own default. Recorded as incomplete so the banner tells the human
  // to check it rather than letting an unreadable value read as a chosen one.
  incomplete.push("spacing");
  return "arithmetic";
}

/**
 * Read a prefill out of `/bots/new`'s query string, or NULL for an ordinary
 * manual visit.
 *
 * ⚠ THE ALL-OR-NOTHING RULE IS HERE AND IT IS THE ONE PROPERTY WORTH MUTATING.
 * Without a real `proposalId` and a recognised `strategy` this returns null and
 * the form is exactly the manual form, so prefilled values and the banner that
 * explains them cannot be separated by any URL anybody can construct. A version
 * that returned a partial prefill on a missing id would put model-derived numbers
 * in front of a human with nothing on screen saying where they came from, which
 * is decision log 46's fourth constraint failing silently.
 */
export function readProposalPrefill(params: URLSearchParams): ProposalPrefill | null {
  const proposalId = params.get(KEY.proposalId);
  if (proposalId === null || proposalId.trim() === "") return null;

  const rawStrategy = params.get(KEY.strategy);
  // `isPrefillStrategy`, not `isProposalStrategy`. The two accept the same set
  // today; this is the one that answers "can this FORM be filled from it", which
  // is the question being asked here, and it is the one that will narrow first.
  if (!isPrefillStrategy(rawStrategy)) return null;

  const incomplete: string[] = [];
  const unrepresentable: string[] = [];

  const generatedRaw = params.get(KEY.generatedAt);
  const generatedAt =
    generatedRaw !== null && /^\d+$/.test(generatedRaw) ? Number(generatedRaw) : null;
  if (generatedAt === null) incomplete.push(KEY.generatedAt);

  const stalenessInputs = decodeFreshness(params.get(KEY.freshness));
  if (stalenessInputs.length === 0) incomplete.push(KEY.freshness);

  let fields: PrefillFields;
  if (rawStrategy === "trailing_stop") {
    /*
     * ONE FIELD, and no mapping: the proposal's `trailPct` is the form's
     * `trailPct` (see `TrailingStopPrefillFields`). `text` rather than
     * `optionalText` because it is mandatory -- an absent one is genuinely
     * incomplete and the banner must say so, exactly as it does for a missing
     * grid bound.
     *
     * ⚠ NOTHING IS RANGE-CHECKED HERE, deliberately. A value that arrives outside
     * `TRAIL_PCT_MIN`/`MAX` is passed through VERBATIM, the way every other field
     * in this module is: the create form's own `trailPctError` judges it, in the
     * field, against the backend's own constants. Silently dropping or clamping it
     * would hide from the operator that the URL claimed it -- which is the failure
     * this whole module is written against.
     */
    fields = {
      strategy: "trailing_stop",
      trailPct: text(params, "trailPct", incomplete),
    };
  } else if (rawStrategy === "grid") {
    fields = {
      strategy: "grid",
      lowerBound: text(params, "lowerBound", incomplete),
      upperBound: text(params, "upperBound", incomplete),
      gridLines: text(params, "gridLines", incomplete),
      spacing: spacingOf(params, incomplete),
      orderSize: text(params, "orderSize", incomplete),
      // THE MAPPING. Grid's `stopLossPct` is the form's `gridStopLossPct`.
      gridStopLossPct: text(params, "stopLossPct", incomplete),
      takeProfitAmount: optionalText(params, "takeProfitAmount", incomplete),
      breakoutTakeProfit: bool(params, "breakoutTakeProfit", incomplete, true),
      breakoutThresholdPct: optionalText(params, "breakoutThresholdPct", incomplete),
    };
  } else {
    // A `sellOnStopLoss: true` the form cannot express. Named, never dropped.
    if (params.get("sellOnStopLoss") === "true") unrepresentable.push("sellOnStopLoss");
    fields = {
      strategy: "dca",
      baseOrderSize: text(params, "baseOrderSize", incomplete),
      additionalOrderSize: text(params, "additionalOrderSize", incomplete),
      stepMultiplier: text(params, "stepMultiplier", incomplete),
      dropPct: text(params, "dropPct", incomplete),
      maxAdditionalBuys: text(params, "maxAdditionalBuys", incomplete),
      // THE MAPPING. DCA's `takeProfitPct`/`stopLossPct` are the form's two
      // `dca…` inputs, which are DIFFERENT DOM nodes from grid's.
      dcaTakeProfitPct: text(params, "takeProfitPct", incomplete),
      dcaStopLossPct: text(params, "stopLossPct", incomplete),
      autoRestart: bool(params, "autoRestart", incomplete, false),
    };
  }

  return {
    proposalId: proposalId.trim(),
    strategy: rawStrategy,
    accountLabel: text(params, KEY.accountLabel, incomplete),
    pair: text(params, KEY.pair, incomplete),
    // The form's own default asset, so a prefill missing it looks like a fresh
    // form rather than an empty required box.
    capitalAsset: text(params, KEY.capitalAsset, incomplete, "USDT"),
    allocatedCapital: text(params, KEY.allocatedCapital, incomplete),
    generatedAt,
    stalenessInputs,
    fields,
    incomplete,
    unrepresentable,
  };
}

// ---------------------------------------------------------------------------
// Staleness, carried forward rather than recomputed from scratch
// ---------------------------------------------------------------------------

/**
 * This prefill's staleness verdict, NOW.
 *
 * ⚠ THE POLICY AND THE COMPARISON ARE THE BACKEND'S, UNCHANGED. This is a
 * one-line composition over `src/research/staleness.ts`'s real `stalenessOf`,
 * exactly as `proposal.ts`'s `stalenessFor` is on the proposal page — the same
 * function, over the same four `{key, at, thresholdMs}` triples that page
 * computed, with the same three-state result. Nothing about the thresholds, the
 * per-strategy price rule, the `>` boundary or the `stale > unknown > fresh`
 * ordering is decided here or copied here.
 *
 * ── ⚠ WHY THE VERDICT IS RE-EVALUATED AGAINST THE CURRENT CLOCK RATHER THAN
 *    CARRIED AS A WORD ──
 *
 * The brief for this step required that a stale-flagged proposal must not arrive
 * here looking fresh. Carrying the VERDICT would satisfy that literally and be
 * strictly worse, because the verdict is a function of time and the whole point of
 * requirement 4 is the time that passes between generation and approval — decision
 * log 45's live run measured a real 7.8-HOUR gap between a proposal and the human
 * decision on it. So the FETCH TIMES travel and the comparison is made here:
 *
 *   * a proposal flagged stale on the proposal page is stale here too, necessarily
 *     — ages only increase, and the thresholds arrived with the data;
 *   * a proposal that was fresh when the button was pressed and goes stale while
 *     the human reads the form is flagged HERE, which a carried word could not do;
 *   * an empty or unreadable input set answers `unknown`, never `fresh`
 *     (`worstVerdict`), so a stripped `freshness` parameter cannot launder a stale
 *     proposal into a clean-looking one.
 *
 * Both directions of that are pinned by tests.
 */
export function prefillStaleness(prefill: ProposalPrefill, now: number): ProposalStaleness {
  return stalenessOf(prefill.stalenessInputs, now);
}

// ---------------------------------------------------------------------------
// Submit: the ONE place a proposal's outcome can be written
// ---------------------------------------------------------------------------

/**
 * Attach `proposalId` to a create-bot body — at SUBMIT TIME, and nowhere else.
 *
 * ── ⚠ THIS FUNCTION IS THE "NAVIGATION IS NOT APPROVAL" GUARANTEE ──
 *
 * Decision log 46 recorded the constraint before this was built: *"It must not
 * silently change a proposal's outcome on mere navigation. Clicking through to a
 * form is not approval; `outcome` is written only when a bot is really created."*
 *
 * The mechanism that makes it true is small and worth stating exactly, because it
 * is easy to assume rather than check. `proposals.outcome` moves from NULL exactly
 * twice in this system: `recordProposalApproval`, reached only from `POST /api/bots`
 * AFTER `create` has returned a real bot, and `rejectProposal`, reached only from
 * `POST /api/proposals/:id/reject`. Neither is reachable by GETting a page. So the
 * complete list of things that could break the guarantee from the dashboard side
 * is "something sends `proposalId` to `POST /api/bots` without a human submitting
 * the form", and this function is the only place in the dashboard that ever puts
 * that field in a body. It is called from the submit handler and from nowhere
 * else; `prefill-does-not-approve.test.ts` asserts that mechanically, over source.
 *
 * ⚠ ABSENT, NOT NULL, when there is no proposal. `POST /api/bots` reads the field
 * with `optionalString`, and entry 45's whole design of the response shape turns on
 * an ordinary creation being byte-identical to what it was before this existed. A
 * body carrying `proposalId: null` is a different request from one carrying no
 * `proposalId`, and the second is the one a manual creation must send.
 */
export function withProposalId<T extends object>(
  request: T,
  proposalId: string | null,
): T & { readonly proposalId?: string } {
  if (proposalId === null || proposalId.trim() === "") return request;
  return { ...request, proposalId: proposalId.trim() };
}
