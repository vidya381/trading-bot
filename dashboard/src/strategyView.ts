/**
 * WHICH STRATEGY VIEW THE DETAIL PAGE SHOULD RENDER, and the one figure the
 * shared list/summary rows read off a position regardless of strategy.
 *
 * ── THE FAILURE THIS EXISTS FOR, OBSERVED FOR REAL ──
 *
 * `/bots/bot-ts1` -- the first live trailing-stop bot (decision log 86) --
 * rendered a COMPLETELY BLANK PAGE. No header, no banner, no layout. The cause
 * was not a missing field; it was a throw during render:
 *
 *     TypeError: Cannot read properties of undefined (reading 'startsWith')
 *         at roundDecimal   (format.ts:31)
 *         at formatMoney    (format.ts:117)
 *         at DcaPositionView (DcaPositionView.tsx:182)
 *
 * `StrategyState.tsx` dispatched with `if (strategy === "grid") ... else <Dca>`.
 * A trailing-stop bot is not grid, so it fell through to the DCA view, which
 * read `params.baseOrderSize` off a `{ trailPct }` object. React's response to an
 * uncaught render error is to unmount the WHOLE tree, so one undefined string
 * took the entire app off the screen -- exactly the outcome `ErrorBoundary.tsx`
 * was written for and which no page outside `/proposal*` was wrapped in.
 *
 * ⚠ NOTHING WOULD HAVE CAUGHT IT. The dashboard's `Position` mirror already had
 * its `trailing_stop` variant (pinned by a parity test), but `Strategy` and
 * `BotConfig` did not -- so the fall-through type-checked. `else` is not a
 * default case; it is a claim that there are exactly two strategies, and it was
 * false.
 *
 * ── WHY THIS IS A MODULE AND NOT A TERNARY INSIDE THE .tsx ──
 *
 * The same reason `killSwitchBannerState.ts`, `statusCounts.ts` and
 * `proposalFields.ts` exist, and it is sharper here than for any of them. This
 * repository's suite runs inside the Workers runtime, which has no DOM, and a
 * test importing a `.tsx` COLLECTS ZERO TESTS RATHER THAN FAILING
 * (docs/open-items/component-test-harness.md). A dispatch written inline in
 * `StrategyState.tsx` is a decision no test can reach -- and this one had been
 * wrong, in production, for a whole strategy.
 *
 * So the decision lives here, where `strategyView.test.ts` drives every strategy
 * and every degenerate state through it, and the component keeps only the JSX.
 */

import type { BotConfig, BotRuntimeState, GridLadder, Position, Strategy } from "./api/types";

/**
 * Every strategy, as VALUES rather than only as a type.
 *
 * The exhaustiveness check below is what keeps this list honest: adding a
 * variant to `Strategy` without adding it here fails to compile, because the
 * record would be missing a key. That is the tripwire for the next strategy --
 * a type union alone cannot be iterated at runtime, and a hand-written list
 * that can drift from its union is how the blank page happened in the first
 * place.
 */
const STRATEGY_KEYS: Readonly<Record<Strategy, true>> = {
  dca: true,
  grid: true,
  trailing_stop: true,
};

export const STRATEGIES: readonly Strategy[] = Object.keys(STRATEGY_KEYS) as Strategy[];

/** How a strategy names itself on screen, in the operator's words rather than the wire's. */
const STRATEGY_LABELS: Readonly<Record<Strategy, string>> = {
  dca: "DCA",
  grid: "Grid",
  trailing_stop: "Trailing stop",
};

export function strategyLabel(strategy: string): string {
  return strategy in STRATEGY_LABELS ? STRATEGY_LABELS[strategy as Strategy] : strategy;
}

/**
 * What the strategy section should render.
 *
 * A CLOSED SET WITH AN EXPLICIT `unsupported` MEMBER. That member is the whole
 * point: the previous code had no way to say "this is a strategy I do not know",
 * so it said "this is DCA" instead and crashed. An honest bordered message for
 * an unknown strategy is a worse page than a real view and a far better one than
 * no page at all.
 */
/** The config narrowed to one strategy, so a view cannot be handed another's params. */
type ConfigFor<S extends Strategy> = Extract<BotConfig, { strategy: S }>;

export type StrategyView =
  /** A `bot_instances` row whose Durable Object holds no state. */
  | { readonly kind: "orphan" }
  /** A grid bot whose ladder has not been written yet. */
  | { readonly kind: "grid-no-ladder" }
  /*
   * ⚠ EACH ARM CARRIES ITS OWN NARROWED CONFIG, and that is the part that makes
   * the fix structural rather than careful. The caller destructures
   * `view.config` and gets `GridParams` / `DcaParams` / `TrailingStopParams`
   * by construction -- there is no way to reach a view holding the wrong params,
   * which is the single thing that went wrong. A dispatcher that returned only a
   * tag would leave every call site to re-narrow, and a re-narrow that fails has
   * to render SOMETHING; returning the proof with the verdict removes the
   * question.
   */
  | { readonly kind: "grid"; readonly config: ConfigFor<"grid">; readonly ladder: GridLadder }
  | { readonly kind: "dca"; readonly config: ConfigFor<"dca"> }
  | { readonly kind: "trailing-stop"; readonly config: ConfigFor<"trailing_stop"> }
  /**
   * A strategy this build has no view for. Carries the name so the message can
   * say WHICH one, which is the difference between a fixable report and "it
   * broke".
   */
  | { readonly kind: "unsupported"; readonly strategy: string };

/**
 * Decide from `config.strategy` -- the AUTHORITATIVE discriminator -- never from
 * the presence of a state field. Two strategies populate `position`, so
 * "position is non-empty" cannot tell DCA from trailing stop, and `BotRuntimeState`
 * says so directly.
 *
 * Takes the two nullable halves rather than the whole `BotDetail` so a test can
 * hand it a state shape without inventing twenty unrelated summary fields.
 */
export function strategyViewFor(
  config: BotConfig | null,
  state: BotRuntimeState | null,
): StrategyView {
  if (config === null || state === null) return { kind: "orphan" };

  switch (config.strategy) {
    case "grid":
      return state.ladder === undefined
        ? { kind: "grid-no-ladder" }
        : { kind: "grid", config, ladder: state.ladder };
    case "dca":
      return { kind: "dca", config };
    case "trailing_stop":
      return { kind: "trailing-stop", config };
    default: {
      /*
       * ⚠ THE BRANCH THAT DID NOT EXIST. `never` here means the compiler has
       * proved every `Strategy` is handled above -- add a variant to the union
       * and THIS LINE fails to build, at the exact moment the omission is made.
       *
       * The runtime arm below it is not redundant with that proof: `config`
       * crosses a network seam from a Worker that may be a deploy ahead of this
       * bundle, so a strategy the compiler has never heard of can genuinely
       * arrive here. It gets a message, not a throw.
       */
      const unreachable: never = config;
      return { kind: "unsupported", strategy: String((unreachable as BotConfig).strategy) };
    }
  }
}

/**
 * The price a position was entered at, or `null` when there is none to show.
 *
 * ONE IMPLEMENTATION FOR THE LIST AND THE DETAIL SUMMARY, which previously each
 * carried their own `position.strategy === "dca"` test -- and each therefore
 * silently dropped the entry price for trailing-stop bots, whose
 * `averageEntryPrice` is a REAL entry price (22.2 decision 4 makes it a
 * single-entry strategy, so it is an average of one). Two copies of a
 * strategy test is two places to forget the next strategy in; this is one, and
 * it is exhaustive over the `Position` union, so forgetting is a compile error.
 *
 * `null` rather than "0.00000000" for a bot holding nothing: a zero entry price
 * is not a price, and rendering it as one invites an operator to reconcile
 * against a number that never existed. Grid returns null always -- a ladder
 * stores no average entry at all, which is a different fact from having one of
 * zero.
 */
export function entryPriceOf(position: Position | null): string | null {
  if (position === null) return null;
  switch (position.strategy) {
    case "grid":
      return null;
    case "dca":
    case "trailing_stop":
      return position.averageEntryPrice === "0.00000000" ? null : position.averageEntryPrice;
    default: {
      // Same two-layer guard as `strategyViewFor`: a compile-time proof that the
      // union is covered, and a runtime answer for a payload from a newer Worker.
      const unreachable: never = position;
      void unreachable;
      return null;
    }
  }
}

/**
 * The three figures section 22.4 touchpoint 5 requires a trailing-stop view to
 * show, taken from the position the BACKEND published.
 *
 * ⚠ `trailLevel` IS NOT RE-DERIVED HERE, and that is deliberate. `positionOf`
 * (src/api/serialize.ts) computes it with `trailLevelOf` -- the strategy's own
 * function, cross-checked against `stopLossPrice` to the last digit by
 * `trailing-stop-dashboard-parity.test.ts`. A second copy of that arithmetic in
 * the dashboard would not fail to compile and would not throw; it would quietly
 * show a stop level a rounding step away from the one the bot actually compares
 * against, on the screen an operator reads to decide whether to intervene. That
 * is the exact failure `derive.ts`'s header refuses, applied here.
 *
 * `null` for both derived figures until the first price arrives -- never "0",
 * which would render as a real stop sitting at zero.
 */
export interface TrailingStopFigures {
  readonly heldQuantity: string;
  readonly cost: string;
  readonly realizedGross: string;
  /** The single entry price, or null while the bot holds nothing. */
  readonly entryPrice: string | null;
  /** Highest price seen since entry, or null before the first price. */
  readonly highWaterMark: string | null;
  /** `highWaterMark x (100 - trailPct) / 100`, or null before the first price. */
  readonly trailLevel: string | null;
}

/**
 * `null` when the published position is not a trailing-stop one.
 *
 * That cannot happen for a bot whose `config.strategy` is `trailing_stop` -- the
 * serializer derives both from the same snapshot -- so the null arm is a seam
 * guard, not an expected state. It exists so the view renders an honest "state
 * unavailable" panel instead of reading fields off the wrong variant, which is
 * the mistake that started all of this.
 */
export function trailingStopFigures(position: Position | null): TrailingStopFigures | null {
  if (position === null || position.strategy !== "trailing_stop") return null;
  return {
    heldQuantity: position.heldQuantity,
    cost: position.cost,
    realizedGross: position.realizedGross,
    entryPrice: entryPriceOf(position),
    highWaterMark: position.highWaterMark,
    trailLevel: position.trailLevel,
  };
}
