/**
 * DOES THIS PARAMS OBJECT ACTUALLY HAVE THE FIELDS ITS OWN STRATEGY LABEL CLAIMS?
 *
 * A defensive shape check for the proposal renderer, and the reason it exists is a
 * real crash rather than a hypothetical: during operator verification a
 * hand-edited test file carrying `strategy: "dca"` over GRID-shaped params reached
 * `ProposalParameters`, which read `params.baseOrderSize` (absent), handed
 * `undefined` to `formatMoney`, and threw `TypeError: undefined is not an object
 * (evaluating 'value.startsWith')` out of `roundDecimal`. React unmounted the tree
 * and **the whole page went blank and black with no visible error.**
 *
 * ── THIS IS THE SAME PROBLEM THE STRATEGY-DISAGREEMENT BANNER ALREADY SOLVES ──
 *
 * `ProposalStrategy` already handles a Stage 2 / Stage 3 strategy mismatch by
 * rendering a clear red warning and saying "do not act on this proposal", rather
 * than trusting the pasted input. That case and this one are the same category --
 * **pasted input whose parts do not agree with each other** -- and only the
 * manifestation differs: one is two labels disagreeing, this is a label
 * disagreeing with the object underneath it. So it gets the same treatment.
 *
 * ── ⚠ A REAL BACKEND RESPONSE CANNOT PRODUCE THIS, AND THAT IS NOT A REASON TO
 *    SKIP THE CHECK ──
 *
 * The backend makes the mismatch unrepresentable, in three independent places:
 * `DERIVE_MODEL_SETTINGS` sends a per-strategy JSON schema naming exactly one
 * strategy's fields; `requireExactFields` refuses a response with any field
 * missing or extra; and `validatedProposalView` builds its output from a
 * discriminated union on `ValidatedProposal.params.strategy`, so it cannot emit a
 * grid body under a dca tag. **The crash was reached by a hand-edited file, not by
 * any response this system can generate.**
 *
 * The check is still right, for the reason the page exists at all: the proposal
 * view's input is PASTED (decision log 44 -- it makes no network request, by
 * design), so its input is untrusted text in exactly the sense a resubmitted
 * assessment is. `parseResubmittedAssessment` does not skip validating a
 * resubmission because a well-behaved client would have sent a good one, and this
 * does not skip validating a paste for the same reason. What the backend
 * guarantees about ITS OWN output says nothing about what arrives in a textarea.
 *
 * ── WHY THE FIELD LISTS LIVE HERE AND ARE NOT RE-TYPED IN THE DASHBOARD ──
 *
 * This file has NO IMPORTS, deliberately and load-bearingly, exactly as
 * `staleness.ts` does: the dashboard imports it directly across the seam, which is
 * only possible while both toolchains can compile it unchanged. An import of
 * `StrategyType` from `/src/db/schema` would pull the Worker's D1 types into the
 * dashboard's `tsc -b` and break it -- the failure `dashboard/src/derive.ts`
 * already records.
 *
 * The alternative was a documented MIRROR of the two field lists in
 * `dashboard/src/`. That is worse here than usual: a mirror that drifted would not
 * fail to compile and would not throw -- it would report a well-formed proposal as
 * malformed, or (far worse) pass a malformed one through to the crash this module
 * exists to prevent. `proposal-shape.test.ts` pins these lists TWO ways instead:
 * against `GRID_DERIVE_FIELDS`/`DCA_DERIVE_FIELDS` (spec 21.4 Stage 3's own
 * quotation), and against the real key set `validatedProposalView` emits when run
 * over a real `DeriveResult`. The second pin is the one that matters, because the
 * component reads the VIEW's output and not the prompt's field list.
 *
 * ── WHAT THIS MODULE DOES NOT DO ──
 *
 * It does not validate VALUES. Whether `orderSize` is a sensible number, or even a
 * number at all, is not asked here: the real decoders, the real strategy
 * validators, the sanity bounds, the venue floor and the headroom check already
 * ran on the backend (21.5 requirement 3), and re-implementing any of them in a
 * rendering layer is the drift the spec's own words forbid. This answers one
 * question -- **are the fields this label implies actually present?** -- and it
 * answers it structurally.
 *
 * It also does not decide the proposal is BAD. A shape mismatch means the pasted
 * document is not a coherent proposal, which is a different and much narrower
 * statement than the judgement question decision logs 40-44 keep carrying forward.
 */

/**
 * Every strategy (spec sections 6 and 22), as this file's own literal rather than
 * an import -- see the module header on why nothing is imported here.
 *
 * PINNED TO `StrategyType` (`/src/db/schema.ts`) BY A TWO-WAY TYPE ASSERTION IN
 * `proposal-shape.test.ts`, not by this comment. `staleness.ts` carries its own
 * copy of the same union for the same reason and is pinned the same way; both are
 * short literals whose whole cost is one assertion each, and a third shared
 * dependency-free file to hold one union would be worse than either.
 *
 * ⚠ `trailing_stop` IS HERE BECAUSE `validatedProposalView` CAN NOW EMIT ONE.
 * It had been left at two members while the view's own union grew a third arm,
 * and the pin above was consequently a standing `tsc` error rather than a guard.
 * Leaving it at two would have been worse than the crash it was written for:
 * `checkParamsShape` would answer `strategy_not_recognised` for a PERFECTLY VALID
 * trailing-stop proposal, and the page would raise a red "do not act on this"
 * banner over a genuine response -- a false alarm on real data, which is the one
 * failure a guard must never produce.
 */
export const PROPOSAL_STRATEGIES = ["grid", "dca", "trailing_stop"] as const;

export type ProposalStrategy = (typeof PROPOSAL_STRATEGIES)[number];

/**
 * Grid's rendered parameter fields, exactly as `validatedProposalView` emits them
 * and exactly as spec 21.4 Stage 3 lists them.
 *
 * ⚠ `takeProfitAmount` and `breakoutThresholdPct` are NULLABLE and are still
 * REQUIRED here, and the distinction is the whole point of this check. The view
 * emits `null` for an unset optional field; it never omits the key. So `null` is a
 * present field and `undefined` is a missing one -- and `undefined` is precisely
 * what reached `formatMoney` and crashed the page. A rule that accepted "absent or
 * null" would let the original crash straight through.
 */
export const GRID_PROPOSAL_FIELDS: readonly string[] = Object.freeze([
  "upperBound",
  "lowerBound",
  "gridLines",
  "spacing",
  "orderSize",
  "stopLossPct",
  "breakoutTakeProfit",
  "breakoutThresholdPct",
  "takeProfitAmount",
]);

/** DCA's rendered parameter fields. All nine; see `GRID_PROPOSAL_FIELDS` on nullability. */
export const DCA_PROPOSAL_FIELDS: readonly string[] = Object.freeze([
  "baseOrderSize",
  "additionalOrderSize",
  "stepMultiplier",
  "dropPct",
  "maxAdditionalBuys",
  "takeProfitPct",
  "stopLossPct",
  "autoRestart",
  "sellOnStopLoss",
]);

/**
 * Trailing stop's rendered parameter field. ONE, and that is the whole set (22.2
 * decision 1): `trailPct` is both the trail distance below the high-water mark
 * and the initial stop distance from entry.
 *
 * ⚠ A ONE-FIELD LIST IS A WEAKER CHECK THAN THE OTHER TWO, AND SAYING SO IS THE
 * POINT. `satisfies` asks whether every required field is present, so this list
 * is satisfied by anything carrying a `trailPct`. What still does the work here
 * is the EXACTNESS rule below -- `unexpected` is measured against this list, so a
 * document carrying `trailPct` PLUS a strategy's worth of other fields is
 * refused, which is the merged-response fault this module already refuses for
 * grid and dca.
 *
 * There is deliberately no order size to render: the single entry is sized by
 * `allocatedCapital`, which the view publishes beside `params` (22.2, the
 * consequence of decisions 1 and 4).
 */
export const TRAILING_STOP_PROPOSAL_FIELDS: readonly string[] = Object.freeze(["trailPct"]);

/**
 * THE STRATEGY-CONDITIONAL SEAM. One function, so there is one place a wrong
 * answer can come from and one place a test can pin.
 *
 * An exhaustive switch rather than a lookup with a default, for
 * `deriveFieldsFor`'s stated reason: a fourth strategy must fail to COMPILE here
 * rather than silently receive one of these three lists.
 */
export function proposalFieldsFor(strategy: ProposalStrategy): readonly string[] {
  switch (strategy) {
    case "grid":
      return GRID_PROPOSAL_FIELDS;
    case "dca":
      return DCA_PROPOSAL_FIELDS;
    case "trailing_stop":
      return TRAILING_STOP_PROPOSAL_FIELDS;
  }
}

export function isProposalStrategy(value: unknown): value is ProposalStrategy {
  return typeof value === "string" && (PROPOSAL_STRATEGIES as readonly string[]).includes(value);
}

/**
 * What a params object turned out to be.
 *
 * A discriminated union rather than a boolean plus loose detail fields, so the
 * renderer cannot read `missing` on a result that has none, and so "it is fine"
 * and "it is fine but here is a warning anyway" are not both representable.
 */
export type ParamsShapeCheck =
  | {
      readonly ok: true;
      /** Narrowed, so a caller can hand it straight to `proposalFieldsFor`. */
      readonly strategy: ProposalStrategy;
    }
  | {
      readonly ok: false;
      readonly code: ParamsShapeErrorCode;
      /** A complete sentence for a human, naming what is wrong and what to do. */
      readonly message: string;
      /** The label as it arrived, rendered for display. Never trusted as a strategy. */
      readonly claimedStrategy: string;
      /** Required fields that are absent or `undefined`. Empty when that is not the fault. */
      readonly missing: readonly string[];
      /**
       * Present fields that the CLAIMED strategy does not require.
       *
       * ⚠ NOT "fields belonging to neither strategy", which is what this held in its
       * first form and which was a real hole found by its own test: an object
       * carrying BOTH strategies' fields — the shape a naive merge of two responses
       * produces — satisfied grid's list, had no field from outside the union, and
       * PASSED. It would have rendered as a grid bot while silently dropping a
       * complete DCA description sitting in the same object.
       *
       * The rule is now the same one `requireExactFields` enforces on the backend:
       * a field set is exact, and extra is as much a fault as missing. When the
       * label itself is unrecognisable there is no claimed strategy to compare
       * against, so that branch reports fields outside the union instead and says so.
       */
      readonly unexpected: readonly string[];
      /**
       * The strategy whose field list the object ACTUALLY satisfies, when there is
       * one. This is what makes the warning useful rather than merely accurate: for
       * the real crash it says "this object is grid-shaped and labelled dca", which
       * points straight at the edit that caused it.
       */
      readonly looksLike: ProposalStrategy | null;
    };

export type ParamsShapeErrorCode =
  /** `params` was absent, null, or not an object. */
  | "params_not_an_object"
  /** The `strategy` discriminant was absent or not one of the two. */
  | "strategy_not_recognised"
  /** The label is real, and the fields it requires are not all there. */
  | "fields_do_not_match_strategy";

function satisfies(params: Record<string, unknown>, fields: readonly string[]): boolean {
  return fields.every((field) => hasField(params, field));
}

/** `strategy` when the object carries that strategy's whole field list, else null. */
function shapeOf(
  params: Record<string, unknown>,
  fields: readonly string[],
  strategy: ProposalStrategy,
): ProposalStrategy | null {
  return satisfies(params, fields) ? strategy : null;
}

/**
 * A field counts as present when the key EXISTS and its value is not `undefined`.
 *
 * Both halves matter and neither is redundant. `Object.hasOwn` alone would accept
 * `{ baseOrderSize: undefined }`, which is exactly the value that crashed
 * `roundDecimal`. A bare `!== undefined` alone would accept a value inherited from
 * a prototype -- which `JSON.parse` cannot produce, but a hand-built object in a
 * future test can, and the check should not depend on how its input was made.
 */
function hasField(params: Record<string, unknown>, field: string): boolean {
  return Object.hasOwn(params, field) && params[field] !== undefined;
}

/**
 * Check a pasted proposal's params object against its own strategy label.
 *
 * Takes `unknown`, deliberately: its caller holds a value typed as a
 * `ValidatedProposal["params"]` union that the pasted document may simply not be,
 * and a parameter typed as that union would make the check impossible to write
 * honestly -- TypeScript would already believe the thing being questioned.
 */
export function checkParamsShape(params: unknown): ParamsShapeCheck {
  if (typeof params !== "object" || params === null || Array.isArray(params)) {
    return {
      ok: false,
      code: "params_not_an_object",
      message:
        `This proposal's "params" is ${describe(params)} rather than an object, so there are no ` +
        `parameter fields to render. A real /derive response always carries one. Check that the ` +
        `whole response body was pasted, and that it is a derive response rather than an assess one.`,
      claimedStrategy: "(none)",
      missing: [],
      unexpected: [],
      looksLike: null,
    };
  }

  const record = params as Record<string, unknown>;
  // `strategy` is the discriminant, not a parameter, so it is never counted as a
  // field on either side of the comparison.
  const keys = Object.keys(record).filter(
    (key) => key !== "strategy" && record[key] !== undefined,
  );

  // Computed for EVERY strategy before the label is consulted, so the answer to
  // "what is this object actually shaped like" is independent of what it claims.
  //
  // ⚠ ORDER MATTERS NOW THAT THERE ARE THREE, and `PROPOSAL_STRATEGIES`' order is
  // load-bearing rather than incidental: `satisfies` accepts a SUPERSET, and
  // trailing stop's single-field list is satisfied by a great many objects. Grid
  // and dca are therefore asked first, so a grid document that happens to carry a
  // `trailPct` is still reported as grid-shaped. `looksLike` is a DIAGNOSIS
  // ("this object is grid-shaped and labelled dca"), never the verdict -- the
  // verdict is the exact-field comparison below.
  const looksLike: ProposalStrategy | null =
    shapeOf(record, GRID_PROPOSAL_FIELDS, "grid") ??
    shapeOf(record, DCA_PROPOSAL_FIELDS, "dca") ??
    shapeOf(record, TRAILING_STOP_PROPOSAL_FIELDS, "trailing_stop");

  const claimed: unknown = record["strategy"];
  if (!isProposalStrategy(claimed)) {
    // No claimed strategy to compare against, so "extra" can only mean "outside
    // both lists" here. Said in the message rather than left to be inferred.
    const union = new Set(PROPOSAL_STRATEGIES.flatMap((s) => [...proposalFieldsFor(s)]));
    return {
      ok: false,
      code: "strategy_not_recognised",
      message:
        `This proposal's params claim a strategy of ${describe(claimed)}, which is not one this ` +
        `system has (${PROPOSAL_STRATEGIES.join(", ")}). ` +
        (looksLike === null
          ? `Its fields do not match either strategy's, so nothing here can be rendered safely.`
          : `Its fields ARE exactly ${looksLike}'s, so the label is the part that is wrong.`) +
        ` Any fields listed as unrecognised below belong to neither strategy, since there is no ` +
        `claimed one to measure them against.`,
      claimedStrategy: describe(claimed),
      missing: [],
      unexpected: keys.filter((key) => !union.has(key)),
      looksLike,
    };
  }

  const required = proposalFieldsFor(claimed);
  const requiredSet = new Set(required);
  const missing = required.filter((field) => !hasField(record, field));
  // EXACT, not "not from nowhere". See `unexpected` on `ParamsShapeCheck`: this is
  // `requireExactFields`' rule, and the first version's looser one let an object
  // carrying both strategies' fields through.
  const unexpected = keys.filter((key) => !requiredSet.has(key));

  if (missing.length === 0 && unexpected.length === 0) {
    return { ok: true, strategy: claimed };
  }

  /*
   * ⚠ THIS WAS `claimed === "grid" ? "dca" : "grid"` -- a third instance of the
   * same two-strategy assumption this whole change is about, in the module
   * written to catch that class of fault. It is now a search over every OTHER
   * strategy, so the "this document describes two bots at once" diagnosis works
   * for any pair rather than only for the original two.
   *
   * `null` when no other strategy's field set is fully present, which is the
   * ordinary case and falls through to the generic extras wording below.
   */
  const other: ProposalStrategy | null =
    PROPOSAL_STRATEGIES.find(
      (candidate) => candidate !== claimed && satisfies(record, proposalFieldsFor(candidate)),
    ) ?? null;
  const otherFields = new Set(other === null ? [] : proposalFieldsFor(other));
  const extrasAreTheOthers =
    other !== null && unexpected.length > 0 && unexpected.every((field) => otherFields.has(field));

  // Three genuinely different faults, described differently, because "9 fields are
  // missing" is true and useless next to "this object is grid-shaped and labelled
  // dca". The first case is the one that crashed the page.
  let diagnosis: string;
  if (looksLike !== null && looksLike !== claimed) {
    diagnosis =
      `Its fields are exactly ${looksLike}'s, so this object is ${looksLike}-shaped but labelled ` +
      `${claimed} -- the two do not describe the same bot, and rendering it as ${claimed} would ` +
      `print blanks or nonsense for every field.`;
  } else if (missing.length === 0) {
    diagnosis = extrasAreTheOthers
      ? `Every field a ${claimed} proposal needs is present, but so is a complete set of ${other!}'s ` +
        `-- this object describes two different bots at once, which is what merging two responses ` +
        `produces. Rendering it as ${claimed} would silently drop the ${other!} half.`
      : `Every field a ${claimed} proposal needs is present, but it also carries ` +
        `${unexpected.length} field(s) that no ${claimed} proposal has, so this is not the object a ` +
        `real response produces.`;
  } else {
    diagnosis =
      `It is missing ${missing.length} of the ${required.length} fields a ${claimed} proposal ` +
      `requires${unexpected.length > 0 ? `, and carries ${unexpected.length} it does not` : ""}.`;
  }

  return {
    ok: false,
    code: "fields_do_not_match_strategy",
    message:
      `This proposal's params are labelled ${claimed}, but they do not have the fields a ${claimed} ` +
      `proposal requires. ${diagnosis} A real /derive response cannot produce this -- the model is ` +
      `sent a per-strategy JSON schema and the parser refuses any response with a field missing or ` +
      `extra -- so a pasted document that looks like this was edited, truncated, or assembled from ` +
      `two different responses. Do not act on it.`,
    claimedStrategy: claimed,
    missing,
    unexpected,
    looksLike,
  };
}

/** A value named for a human, without ever interpolating the value itself. */
function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "object") return "an object";
  return `${typeof value} (${String(value)})`;
}
