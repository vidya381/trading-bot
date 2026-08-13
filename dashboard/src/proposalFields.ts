/**
 * WHICH parameter fields to render, and WHETHER to render any — the whole decision
 * `ProposalParameters` used to make inline.
 *
 * ── WHY THIS IS A SEPARATE, REACT-FREE FILE ──
 *
 * Because the version that lived in the `.tsx` could not be tested, and a mutation
 * run proved it. `checkParamsShape` itself is covered exhaustively, but the ONE LINE
 * that called it — `shape.ok ? fieldsFor(...) : []` — was not, and a mutant that
 * deleted the guard and restored the original crash **SURVIVED**: no test could
 * reach it, because a test importing a `.tsx` collects ZERO tests (React's own CJS
 * build does not resolve inside the Workers runtime this suite runs in).
 *
 * A guard whose call site nothing can check is most of the way to no guard. So the
 * decision moved here, where the root suite can drive it, and the component became
 * presentational: it maps over `specs` and renders `shape` when it is not ok. The
 * same discipline `proposal.ts`, `format.ts` and `renderError.ts` already keep, for
 * the same reason.
 *
 * ── THE ORDER IS THE CREATE-BOT FORM'S OWN, AND THAT IS DELIBERATE ──
 *
 * Labels, hints and sequence are copied from `GridLadderView` and `DcaPositionView`
 * so a reviewer reads the same words on the proposal and on the bot it would become.
 * 21.4 Stage 3 requires every field the form requires, with "nothing left as 'tune
 * this yourself'", and the backend refuses an incomplete set before a response
 * exists — so the list is rendered in full and unconditionally whenever the shape
 * check passes. A field quietly omitted here would undo that guarantee at the last
 * step.
 */

import { checkParamsShape, type ParamsShapeCheck, type ProposalStrategy } from "../../src/research/proposal-shape";
import { formatMoney, formatPercent } from "./format";

/** One field's rendered value, its hint, and the key its citations are under. */
export interface FieldSpec {
  readonly field: string;
  readonly label: string;
  readonly value: string;
  readonly hint: string | null;
}

const NOT_SET = "Not set";

function money(value: string | null): string {
  return value === null ? NOT_SET : formatMoney(value);
}

function percent(value: string | null): string {
  return value === null ? NOT_SET : formatPercent(value);
}

function flag(value: boolean): string {
  return value ? "Enabled" : "Disabled";
}

/**
 * The result of asking "can these params be rendered, and as what?".
 *
 * `specs` is EMPTY whenever `shape.ok` is false, and that pairing is the property
 * worth testing: a caller cannot render fields for a params object that failed the
 * check, because there are none to render. Returning both together — rather than a
 * check the caller then chooses to honour — is what removes the untestable branch
 * from the component.
 */
export interface ProposalFields {
  readonly shape: ParamsShapeCheck;
  readonly specs: readonly FieldSpec[];
}

/**
 * Check a pasted params object and, if it holds up, build its field list.
 *
 * Takes `unknown` for `checkParamsShape`'s reason: the caller's value is typed as a
 * union the pasted document may simply not be, and a parameter typed as that union
 * would make the check impossible to write honestly.
 */
export function proposalFieldsOf(params: unknown): ProposalFields {
  const shape = checkParamsShape(params);
  if (!shape.ok) {
    // NO FIELDS. Printing blanks for values that are not there is how a malformed
    // document comes to look like a half-specified proposal.
    return { shape, specs: [] };
  }
  return { shape, specs: specsFor(params as ParamsRecord, shape.strategy) };
}

/**
 * A params object whose fields the shape check has ALREADY confirmed present.
 *
 * Indexed access rather than a discriminated union, and this is a deliberate trade
 * with its reasoning attached: the value arrives from JSON as `unknown`, so
 * narrowing it to `ValidatedProposal["params"]` would need a cast that asserts
 * exactly what `checkParamsShape` just established at RUNTIME. Reading through an
 * index type keeps the runtime check as the only authority and stops the type system
 * from claiming a guarantee it did not verify.
 */
type ParamsRecord = Readonly<Record<string, string | number | boolean | null | undefined>>;

function str(value: ParamsRecord[string]): string {
  // Every value here has passed `hasField`, so it is present and not `undefined`.
  // `String` on a real string is identity; on the two numeric fields it is what the
  // old code did explicitly. Never reached with `undefined`.
  return typeof value === "string" ? value : String(value);
}

function nullableDecimal(value: ParamsRecord[string]): string | null {
  return value === null ? null : str(value);
}

/**
 * The field list for a strategy whose fields are confirmed present.
 *
 * `strategy` is the NARROWED value off a passing check, never `params.strategy` read
 * again — reading the label a second time is how a guard gets bypassed by a later
 * edit that looks harmless. An exhaustive switch, so a third strategy fails to
 * compile here rather than silently taking one of these two branches.
 */
function specsFor(params: ParamsRecord, strategy: ProposalStrategy): readonly FieldSpec[] {
  switch (strategy) {
    case "grid":
      return [
        { field: "lowerBound", label: "Lower bound", value: money(str(params.lowerBound)), hint: null },
        { field: "upperBound", label: "Upper bound", value: money(str(params.upperBound)), hint: null },
        {
          field: "gridLines",
          label: "Grid lines",
          value: str(params.gridLines),
          hint: "including both bounds",
        },
        { field: "spacing", label: "Spacing", value: str(params.spacing), hint: null },
        {
          field: "orderSize",
          label: "Order size per line",
          value: money(str(params.orderSize)),
          hint: null,
        },
        {
          field: "stopLossPct",
          label: "Stop-loss",
          value: percent(str(params.stopLossPct)),
          hint: null,
        },
        {
          field: "takeProfitAmount",
          label: "Take-profit amount",
          value: money(nullableDecimal(params.takeProfitAmount)),
          hint: "close the whole grid at this realized profit",
        },
        {
          field: "breakoutTakeProfit",
          label: "Breakout take-profit",
          value: flag(params.breakoutTakeProfit === true),
          hint: "cash out on an upside breakout",
        },
        {
          field: "breakoutThresholdPct",
          label: "Breakout threshold",
          value: percent(nullableDecimal(params.breakoutThresholdPct)),
          hint: "above the upper bound",
        },
      ];
    case "dca":
      return [
        {
          field: "baseOrderSize",
          label: "Base order size",
          value: money(str(params.baseOrderSize)),
          hint: null,
        },
        {
          field: "additionalOrderSize",
          label: "Additional order size",
          value: money(str(params.additionalOrderSize)),
          hint: null,
        },
        {
          field: "stepMultiplier",
          label: "Step multiplier",
          value: str(params.stepMultiplier),
          hint: "compounds each additional buy",
        },
        {
          field: "dropPct",
          label: "Drop per buy",
          value: percent(str(params.dropPct)),
          hint: "from the last entry price",
        },
        {
          field: "maxAdditionalBuys",
          label: "Max additional buys",
          value: str(params.maxAdditionalBuys),
          hint: "excludes the base order",
        },
        {
          field: "takeProfitPct",
          label: "Take-profit",
          value: percent(str(params.takeProfitPct)),
          hint: "above average entry",
        },
        {
          field: "stopLossPct",
          label: "Stop-loss",
          value: percent(str(params.stopLossPct)),
          hint: "below average entry",
        },
        {
          field: "autoRestart",
          label: "Auto-restart",
          value: flag(params.autoRestart === true),
          hint: "new cycle after a take-profit",
        },
        {
          field: "sellOnStopLoss",
          label: "Sell on stop-loss",
          value: flag(params.sellOnStopLoss === true),
          hint: "a stop-loss halts and holds the position",
        },
      ];
  }
}
