/**
 * Turning any thrown value into something a human can read.
 *
 * ── WHY THIS IS A SEPARATE, REACT-FREE FILE ──
 *
 * It is the only part of the error-boundary story that can be tested. React error
 * boundaries fire on the CLIENT only, and the root vitest suite runs inside the
 * Workers runtime where neither `react` nor `react-dom/server` resolves at all
 * (their CJS builds fail to load — verified by probe, not assumed). A test file
 * that imported `ErrorBoundary.tsx` therefore collects ZERO tests rather than
 * failing loudly, which is the worst of the available outcomes.
 *
 * So the branching lives here with no imports, exactly as `proposal.ts` and
 * `format.ts` keep themselves React-free, and `ErrorBoundary.tsx` is left holding
 * only the class React requires and the JSX.
 *
 * ── ⚠ THE PROPERTY THIS FILE EXISTS TO GUARANTEE ──
 *
 * **IT MUST NEVER THROW.** It runs inside an error boundary's fallback, which is
 * the one place in a React tree with nothing left to catch a second failure: a
 * fallback that throws unmounts the tree and produces exactly the blank page the
 * boundary was added to prevent.
 *
 * That is not a theoretical risk. `throw` accepts any value, and the naive
 * `String(error)` reaches for `Symbol.toPrimitive` — which throws on a
 * null-prototype object, a bug this project has already hit once (`api.test.ts`
 * documents `String(Object.create(null))` throwing "Cannot convert object to
 * primitive value"). Every conversion below is guarded, and the test drives
 * thirteen throwable shapes through it.
 */

/** What the fallback says, as data rather than as markup. */
export interface RenderErrorReport {
  /** The heading. Names the part that failed, so a contained failure reads as contained. */
  readonly heading: string;
  /** The error's own message, or an honest statement that it had none. */
  readonly detail: string;
  /** The error's constructor name where it has one -- `TypeError` is a real clue. */
  readonly kind: string;
  /** What the reader should do next. */
  readonly advice: string;
}

/**
 * Describe a thrown value.
 *
 * @param error anything a `throw` can carry, which is genuinely anything.
 * @param where the guarded region's name, so nested boundaries are distinguishable.
 */
export function describeRenderError(error: unknown, where: string): RenderErrorReport {
  return {
    heading: `${where} could not be rendered`,
    detail: detailOf(error),
    kind: error instanceof Error && error.name !== "" ? error.name : typeof error,
    advice:
      "This is a fault in the pasted response or in this page, not a statement about the proposal. " +
      "Nothing has been created, started or modified, and no capital has been touched. The rest of " +
      "the page above and below this block is unaffected. Check the browser console for the stack, " +
      "and re-paste the two responses exactly as curl returned them.",
  };
}

function detailOf(error: unknown): string {
  if (error instanceof Error) {
    return error.message === "" ? "The error carried no message." : error.message;
  }
  if (error === null || error === undefined) {
    return `Something threw ${String(error)} rather than an error object, so there is no message.`;
  }
  return `A non-error value was thrown: ${textOf(error)}`;
}

/**
 * A last-resort text rendering, guarded twice.
 *
 * `JSON.stringify` for objects (it survives a throwing `toString`, and returns
 * `undefined` rather than throwing for a few inputs), `String` otherwise, and a
 * plain sentence when either throws — a circular object defeats the first and a
 * null-prototype object defeats the second.
 */
function textOf(value: unknown): string {
  try {
    const text = typeof value === "object" ? JSON.stringify(value) : String(value);
    // `JSON.stringify` returns `undefined` for a function or a lone symbol, and
    // interpolating that would print the literal word "undefined" as if it were the
    // thrown value.
    return text === undefined || text === "" ? "(a value with no text form)" : text;
  } catch {
    return "(the thrown value could not be converted to text)";
  }
}
