/**
 * "Clone this bot" — the PREFILL, and nothing more.
 *
 * ── WHAT THIS IS ──
 *
 * The operator is looking at a bot's detail page. They want another bot configured
 * the same way. This module carries that bot's CURRENT configuration — the values
 * already rendered on the screen in front of them — into the ordinary create-bot
 * form as its starting values, through the URL, where every one of them stays
 * editable and the ordinary submit path runs every check it always runs.
 *
 * It is the same shape of thing `proposalPrefill.ts` is, applied to a different
 * source, and it is deliberately a SEPARATE MODULE rather than a relaxation of
 * that one. The reasoning is stated in full below under "WHY NOT RELAX
 * `readProposalPrefill`", because a future reader's first instinct will be that
 * one decoder with an optional id would have done.
 *
 * ── WHAT IT IS NOT: THERE IS NO LINK BETWEEN THE TWO BOTS ──
 *
 * ⚠ THE SOURCE BOT IS A READ SOURCE AND NOTHING ELSE. Three separate facts, each
 * structural rather than a promise:
 *
 *   1. NOTHING IS WRITTEN TO THE SOURCE. This module makes no request of any kind
 *      — no import from `api/client`, no `fetch`, no side effect, in either
 *      direction — exactly as `proposalPrefill.ts` does not, and
 *      `prefill-does-not-approve.test.ts` enforces that over source for this file
 *      too. Cloning a bot cannot change it, cannot halt it, cannot touch its
 *      capital.
 *   2. THE NEW BOT'S ID IS NOT CARRIED. `botInstanceId` is conspicuously ABSENT
 *      from everything below. The create-bot form mints a fresh random id at
 *      mount (`generatedId`) and this prefill has no way to override it, so a
 *      cloned bot cannot inherit, collide with, or be derived from the source
 *      bot's id. That absence is load-bearing and is pinned by a test.
 *   3. `sourceBotId` NEVER LEAVES THE BROWSER. It is carried so the banner can
 *      say honestly where the numbers came from, and that is its only use. It is
 *      not put in the create-bot request body, there is no column for it, and
 *      `POST /api/bots` would reject it — `createBot`'s decoder does not read it.
 *      Contrast `proposalPrefill.ts`'s `proposalId`, which IS submitted (through
 *      `withProposalId`, at submit time only) because a proposal record has an
 *      outcome to write. A bot has nothing of the sort, so nothing is sent.
 *
 * The new bot therefore gets a fresh id, an empty order/trade/alert history, its
 * own Durable Object, and its own capital reservation taken through the same
 * compare-and-swap every manual creation goes through. Its only relationship to
 * the source is that a human started from the same numbers.
 *
 * ── WHY NOT RELAX `readProposalPrefill` ──
 *
 * That decoder returns null unless BOTH a `proposalId` and a recognised `strategy`
 * are present. The obvious cheap move is to widen the id check to "a proposalId OR
 * a cloneFrom" and reuse everything. It was rejected for three reasons, in
 * increasing order of how much they matter:
 *
 *   1. ITS NON-FIELD DATA IS PROPOSAL-SHAPED AND A BOT HAS NONE OF IT.
 *      `ProposalPrefill` requires `generatedAt` and `stalenessInputs`, and the
 *      form's banner computes a live staleness verdict from them. A bot's config
 *      has no derive timestamp and no four fetch times, so a clone would have to
 *      supply them empty — which makes `incomplete` name `generatedAt` and
 *      `freshness`, and makes `worstVerdict` answer `unknown`. The operator would
 *      then be shown "this prefill is incomplete" and "freshness unknown" about a
 *      set of values that is neither: the config is exactly complete and freshness
 *      is not a concept that applies. That is a degraded result presented as if it
 *      were the real one, which is the specific failure `proposalPrefill.ts`'s own
 *      header is written against.
 *   2. IT WOULD MAKE THE FAIL-CLOSED RULE A DISJUNCTION. Today that rule is one
 *      sentence with a test per clause: no id, no prefill. Relaxed, it becomes
 *      "one of these two ids, and then a second switch decides which of two
 *      banners and which of two provenance stories applies" — the branch that
 *      goes wrong is the one where neither is present and the code falls through
 *      to the more permissive arm. Two decoders that each refuse everything they
 *      do not recognise have no such arm.
 *   3. IT WOULD PUT THE PROPOSAL FLOW AT RISK FOR A FEATURE THAT DOES NOT NEED IT.
 *      The proposal path is the one that commits capital on model output and has
 *      the most invariants pinned to it. A parallel module cannot regress it,
 *      because it does not edit it. Nothing in `proposalPrefill.ts` changed to
 *      make this work.
 *
 * ── WHAT IS SHARED ANYWAY, AND HOW THE DUPLICATION IS KEPT HONEST ──
 *
 * The cost of a parallel decoder is a second implementation of the field mapping,
 * and that mapping is precisely the error-prone part: grid and DCA BOTH have a
 * parameter called `stopLossPct`, and they are two different inputs in two
 * different fieldsets (`gridStopLossPct` / `dcaStopLossPct`). Two things hold that
 * down:
 *
 *   * THE WIRE FIELD LISTS ARE NOT COPIED. `WIRE_FIELDS` is imported from
 *     `proposalPrefill.ts`, which an existing test already pins element-for-element
 *     against the backend's authoritative `GRID_PROPOSAL_FIELDS` /
 *     `DCA_PROPOSAL_FIELDS`. A parameter added to a strategy therefore reaches
 *     both encoders or neither.
 *   * THE MAPPING IS PINNED AGAINST THE OTHER DECODER, MECHANICALLY.
 *     `botClonePrefill.test.ts` feeds the SAME parameter query string to both
 *     `readProposalPrefill` and `readBotClonePrefill` and asserts the resulting
 *     `fields` are deep-equal. Either decoder drifting — in the mapping, in the
 *     boolean parsing, in what counts as "unset" — fails that test.
 *
 * ── FAIL CLOSED ──
 *
 * Same rule, same reasons, one extra clause:
 *
 *   * NO `cloneFrom`, OR AN UNRECOGNISED `strategy` → NO PREFILL AT ALL. Not a
 *     partial one. `/bots/new` then renders exactly the manual form, with no
 *     banner, so prefilled values can never appear without provenance over them.
 *   * ⚠ A URL CLAIMING BOTH PROVENANCES IS REFUSED. If a `proposalId` is present
 *     this returns null, unconditionally. A hand-built URL carrying both ids would
 *     otherwise be readable as either, and the two banners say materially
 *     different things — one of them would be a lie. Neither decoder is the right
 *     place to guess which; the ambiguous URL simply prefills nothing here, and
 *     the proposal decoder (which is asked first) handles it as the proposal it
 *     says it is.
 *   * A FIELD THAT CANNOT BE READ IS LEFT EMPTY, NEVER GUESSED. It is recorded in
 *     `incomplete`, the form keeps its ordinary default, and the banner names it.
 *
 * A field that IS present is passed through VERBATIM, junk included: the form's
 * own validator judges values, and a silently dropped bad value would hide from
 * the operator that the URL claimed it.
 */

import type { BotDetail } from "../api/types";
import { checkParamsShape } from "../../../src/research/proposal-shape";
import {
  CREATE_BOT_PATH,
  WIRE_FIELDS,
  type DcaPrefillFields,
  type GridPrefillFields,
  type PrefillFields,
  type PrefillStrategy,
} from "./proposalPrefill";

/**
 * The subset of a prefill the create-bot form actually seeds its state from.
 *
 * Declared here, and satisfied structurally by BOTH `ProposalPrefill` and
 * `BotClonePrefill`, so `CreateBot.tsx` reads its defaults from ONE value of ONE
 * type rather than branching per source at every `useState`. The provenance
 * halves — a proposal's id and staleness, a clone's source bot — stay on their own
 * types, where only their own banner can see them.
 */
export interface FormPrefillSeed {
  readonly strategy: PrefillStrategy;
  readonly accountLabel: string;
  readonly pair: string;
  readonly capitalAsset: string;
  readonly allocatedCapital: string;
  readonly fields: PrefillFields;
}

/**
 * Everything `/bots/new` needs in order to open pre-filled from a bot AND to say
 * honestly where the values came from.
 *
 * ⚠ NO `botInstanceId`, BY DESIGN — see the module header, point 2. The new bot's
 * id is minted by the form and never inherited.
 */
export interface BotClonePrefill extends FormPrefillSeed {
  /**
   * The bot these values were read from. Carried for the banner ONLY: it is never
   * submitted, never stored, and creates no relationship between the two bots.
   */
  readonly sourceBotId: string;
  /** Fields that were absent or unreadable, so the form kept its ordinary default. */
  readonly incomplete: readonly string[];
  /** Configured values this form has no control for. See `sellOnStopLoss`. */
  readonly unrepresentable: readonly string[];
}

/**
 * The wire names, which are the BOT CONFIG's field names.
 *
 * The same words `proposalPrefill.ts` uses, deliberately: the two URLs then differ
 * only in which id they carry, a reader comparing a clone URL against the bot
 * detail page sees the same words on both, and the cross-decoder equivalence test
 * can feed one parameter string to both.
 */
const KEY = {
  /** ⚠ The clone's identity parameter. Distinct from the proposal's, never both. */
  cloneFrom: "cloneFrom",
  strategy: "strategy",
  accountLabel: "accountLabel",
  pair: "pair",
  capitalAsset: "capitalAsset",
  allocatedCapital: "allocatedCapital",
} as const;

/**
 * The PROPOSAL prefill's identity parameter, named here for one purpose: to
 * detect it and refuse. Nothing in this module ever writes it.
 *
 * ⚠ A BARE CONSTANT RATHER THAN A MEMBER OF `KEY` ABOVE, DELIBERATELY.
 * `prefill-does-not-approve.test.ts` fails the build on any line that puts a
 * `proposalId` into an object, so that "exactly one function can attach one to a
 * request" stays checkable by reading one call site. A `proposalId: "proposalId"`
 * entry in a key table is harmless and would still trip it — correctly, because a
 * guard that had to distinguish harmless occurrences from real ones would be a
 * guard with an exception list. So this module does not write that shape at all.
 */
const COMPETING_PROPOSAL_KEY = "proposalId";

// ---------------------------------------------------------------------------
// Encoding: the bot detail page's link
// ---------------------------------------------------------------------------

/**
 * Turn a fetched bot into the query string `/bots/new` reads, or NULL when this
 * bot cannot offer an honest one.
 *
 * ⚠ NULL HAS EXACTLY TWO CAUSES, AND NEITHER IS THE BOT'S STATUS. Running, halted,
 * stopped and archived all clone identically — a config is a config whatever the
 * bot is currently doing, and an operator's most likely reason to clone is having
 * just watched one finish. What it refuses is a bot whose config cannot be read:
 *
 *   1. `config` IS NULL — the bot row exists but its Durable Object holds no
 *      state (`orphaned`). There are no parameters to copy. The detail page
 *      already surfaces this as an orphan, and `CloneBotLink` renders the refusal
 *      in place rather than a link that would prefill nothing.
 *   2. THE PARAMS DO NOT MATCH THEIR OWN STRATEGY LABEL, checked with the same
 *      `checkParamsShape` the proposal page's parameter table is gated on, or the
 *      config's strategy disagrees with the bot row's. Reading
 *      `params.baseOrderSize` off a grid-shaped object would produce a form
 *      pre-filled with `undefined` — the fault that took a page to a blank screen,
 *      one layer later where it commits capital instead of rendering a table.
 */
export function cloneSearchParams(bot: BotDetail): URLSearchParams | null {
  const config = bot.config;
  if (config === null) return null;
  /*
   * The row's `strategy_type` and the object's `config.strategy` are written
   * together at creation and neither is ever rewritten, so they agree on every
   * real bot. They are compared anyway: if they ever disagree, one of the two
   * screens the operator is reading is wrong about what this bot IS, and the
   * right answer is to refuse rather than to pick one.
   */
  if (config.strategy !== bot.strategy) return null;

  /*
   * `checkParamsShape` wants the strategy label INSIDE the params object, because
   * a proposal's params carry their own. A bot config keeps the label one level
   * up, so it is put back for the check and never used from there afterwards.
   * This verifies the object has EXACTLY its strategy's fields, no more and none
   * missing, before a single value is read off it.
   */
  const shape = checkParamsShape({ ...config.params, strategy: config.strategy });
  if (!shape.ok) return null;

  const params = new URLSearchParams();
  params.set(KEY.cloneFrom, bot.id);
  params.set(KEY.strategy, shape.strategy);
  /*
   * ⚠ THE IDENTITY AND CAPITAL FIELDS COME FROM THE BOT ROW, NOT FROM `config`.
   *
   * Both carry them, and they can genuinely differ in one place: `allocated_capital`
   * on the D1 row is what `resizeBotCapital` rewrites, while the object's stored
   * `config.allocatedCapital` keeps the amount the bot was CREATED with. The row is
   * the authoritative one, it is the number `BotSummary` renders, and it is
   * therefore the number the operator is looking at when they press Clone. A clone
   * that quietly used the creation-time figure would put a different amount in the
   * box than the page above it shows.
   */
  params.set(KEY.accountLabel, bot.accountLabel);
  params.set(KEY.pair, bot.pair);
  params.set(KEY.capitalAsset, bot.capitalAsset);
  params.set(KEY.allocatedCapital, bot.allocatedCapital);
  /*
   * ⚠ NO `exchange`. It is not an input on the create-bot form: the form derives
   * it, read-only, from the account registry once the selected account resolves
   * (`POST /api/bots` rejects a body that disagrees with the registry anyway). A
   * carried exchange would be a value in the URL that no field consumes and that
   * could contradict the registry's answer.
   *
   * ⚠ NO `botInstanceId`. See the module header, point 2.
   */

  const record = config.params as unknown as Readonly<Record<string, unknown>>;
  for (const field of WIRE_FIELDS[shape.strategy]) {
    const value = record[field];
    // `null` is a real, present value for the two optional grid fields and encodes
    // as the empty string. `undefined` cannot occur — `checkParamsShape` refused it
    // — and is skipped rather than stringified into the literal text "undefined",
    // which is what would land in the form's input box.
    if (value === undefined) continue;
    params.set(field, value === null ? "" : String(value));
  }
  return params;
}

/**
 * The full `to=` for a `<Link>`, or null when this bot cannot offer one.
 *
 * A string rather than an object so the control is a plain link with a real href
 * an operator can see, middle-click and copy — and so that "clicking it navigates
 * and does nothing else" is one line of JSX to check.
 */
export function cloneBotHref(bot: BotDetail): string | null {
  const params = cloneSearchParams(bot);
  return params === null ? null : `${CREATE_BOT_PATH}?${params.toString()}`;
}

// ---------------------------------------------------------------------------
// Decoding: what /bots/new reads
// ---------------------------------------------------------------------------

/** A required text value. Missing or empty → the form's default, and it is named. */
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
 * An OPTIONAL text value: `""` is a real answer meaning "this bot has it unset",
 * so it is NOT incomplete. Only an absent key is.
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

function spacingOf(params: URLSearchParams, incomplete: string[]): "arithmetic" | "geometric" {
  const raw = params.get("spacing");
  if (raw === "arithmetic" || raw === "geometric") return raw;
  // The form's own default, recorded as incomplete so the banner tells the
  // operator to check it rather than letting an unreadable value read as a chosen
  // one.
  incomplete.push("spacing");
  return "arithmetic";
}

/** A recognised strategy label, or null. Local rather than imported so this
 *  decoder's refusal does not depend on the proposal vocabulary's guard. */
function isCloneStrategy(value: unknown): value is PrefillStrategy {
  return value === "grid" || value === "dca";
}

/**
 * Read a clone prefill out of `/bots/new`'s query string, or NULL for anything
 * else — an ordinary manual visit, a proposal prefill, or a URL that does not
 * carry a coherent clone source.
 *
 * ⚠ THE ALL-OR-NOTHING RULE IS HERE AND IT IS THE PROPERTY WORTH MUTATING.
 * Without a real `cloneFrom` and a recognised `strategy`, and with no `proposalId`
 * competing for the same values, this returns null and the form is exactly the
 * manual form. Prefilled values and the banner that explains them cannot be
 * separated by any URL anybody can construct.
 */
export function readBotClonePrefill(params: URLSearchParams): BotClonePrefill | null {
  /*
   * The ambiguity clause comes FIRST, before anything is read: a URL claiming both
   * provenances is refused here outright rather than resolved by precedence, so
   * this function's answer does not depend on the order its callers ask in.
   */
  const competing = params.get(COMPETING_PROPOSAL_KEY);
  if (competing !== null && competing.trim() !== "") return null;

  const sourceBotId = params.get(KEY.cloneFrom);
  if (sourceBotId === null || sourceBotId.trim() === "") return null;

  const rawStrategy = params.get(KEY.strategy);
  if (!isCloneStrategy(rawStrategy)) return null;

  const incomplete: string[] = [];
  const unrepresentable: string[] = [];

  let fields: PrefillFields;
  if (rawStrategy === "grid") {
    const grid: GridPrefillFields = {
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
    fields = grid;
  } else {
    /*
     * A `sellOnStopLoss: true` the form cannot express. Named, never dropped.
     *
     * ⚠ NO EXISTING BOT CAN CARRY IT — `validateDcaParams` rejects `true` at
     * creation, so every stored DCA config has `false`. "Cannot legitimately" is
     * not "cannot", and a value silently dropped on the way to a form is exactly
     * the failure this module is written against, so it is surfaced rather than
     * assumed away.
     */
    if (params.get("sellOnStopLoss") === "true") unrepresentable.push("sellOnStopLoss");
    const dca: DcaPrefillFields = {
      strategy: "dca",
      baseOrderSize: text(params, "baseOrderSize", incomplete),
      additionalOrderSize: text(params, "additionalOrderSize", incomplete),
      stepMultiplier: text(params, "stepMultiplier", incomplete),
      dropPct: text(params, "dropPct", incomplete),
      maxAdditionalBuys: text(params, "maxAdditionalBuys", incomplete),
      // THE MAPPING. DCA's `takeProfitPct`/`stopLossPct` are the form's two `dca…`
      // inputs, which are DIFFERENT DOM nodes from grid's.
      dcaTakeProfitPct: text(params, "takeProfitPct", incomplete),
      dcaStopLossPct: text(params, "stopLossPct", incomplete),
      autoRestart: bool(params, "autoRestart", incomplete, false),
    };
    fields = dca;
  }

  return {
    sourceBotId: sourceBotId.trim(),
    strategy: rawStrategy,
    accountLabel: text(params, KEY.accountLabel, incomplete),
    pair: text(params, KEY.pair, incomplete),
    // The form's own default asset, so a prefill missing it looks like a fresh
    // form rather than an empty required box.
    capitalAsset: text(params, KEY.capitalAsset, incomplete, "USDT"),
    allocatedCapital: text(params, KEY.allocatedCapital, incomplete),
    fields,
    incomplete,
    unrepresentable,
  };
}

/**
 * Exposed for the tests that pin the encode/decode vocabulary. Not read by any
 * component; the two functions above are the whole public surface.
 */
export const CLONE_KEYS = Object.freeze(KEY);

/** Re-exported so a caller needs one import to build a link. */
export { CREATE_BOT_PATH };
