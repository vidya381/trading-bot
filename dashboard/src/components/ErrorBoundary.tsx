/**
 * DEFENCE IN DEPTH: any render error becomes a VISIBLE, CONTAINED message rather
 * than a silent blank page.
 *
 * ── THE FAILURE THIS EXISTS FOR, OBSERVED FOR REAL ──
 *
 * During operator verification of the proposal record, a hand-edited test file
 * threw a `TypeError` out of `ProposalParameters`. React's default behaviour on an
 * uncaught render error is to unmount the whole tree, so **the entire page became
 * blank and black with no visible error at all** -- the worst available outcome,
 * because it is indistinguishable from a page that has not loaded, from a routing
 * bug, and from a backend outage. The operator had no way to tell which.
 *
 * `checkParamsShape` (`src/research/proposal-shape.ts`) fixes that specific crash
 * at its cause. THIS is the second, independent layer, and it is deliberately
 * ignorant of what went wrong: it exists for the NEXT unexpected shape, which by
 * definition nobody has anticipated. A shape check can only catch the classes
 * someone thought of; a boundary catches the ones nobody did.
 *
 * ── WHAT IT DOES NOT DO ──
 *
 * It does not retry, reload, or "recover". A render that threw produced no trusted
 * output, and re-running it against the same input produces the same throw. It
 * shows what happened and stops -- which is `NOTHING SILENTLY DEGRADES` (21.5
 * requirement 6) applied to a rendering layer: a partial page presented as a whole
 * one is the failure, and a stated failure is not.
 *
 * It also does not report anywhere. There is no error-reporting endpoint in this
 * project and inventing one here would be a backend decision made in a component.
 * It logs to the console, where the operator's devtools already are.
 *
 * ── ⚠ THE CATCHING MECHANISM IS NOT COVERED BY ANY TEST, AND CANNOT BE HERE ──
 *
 * React error boundaries only fire on the CLIENT: `componentDidCatch` and
 * `getDerivedStateFromError` are not called during server rendering, so a test
 * would need a real DOM. The dashboard has no test runner of its own and the root
 * suite runs inside the Workers runtime, where `react-dom/server` does not even
 * resolve (both `server.edge` and `server.browser` fail on their CJS requires --
 * verified by probe, not assumed). Adding jsdom plus a second vitest pool is a
 * toolchain change, not part of a crash fix.
 *
 * So: **`ErrorBoundary`'s catching is verified by the operator's eyes and by
 * nothing else**, exactly as decision log 44 records for all eight proposal
 * components.
 *
 * What IS testable is the message a reader ends up looking at, and that is why
 * `describeRenderError` lives in `../renderError.ts` -- a REACT-FREE file, because a
 * test importing this one collects ZERO tests rather than failing (React's own CJS
 * build does not resolve in the Workers runtime either). `renderError.test.ts`
 * drives thirteen throwable shapes through it, since a fallback that throws has
 * nothing left to catch it and reproduces the blank page.
 *
 * WHAT REMAINS IN THIS FILE is only the class React requires and the JSX.
 */

import { Component, type ErrorInfo, type ReactNode } from "react";
import { describeRenderError, type RenderErrorReport } from "../renderError";

export function RenderErrorFallback({ report }: { report: RenderErrorReport }) {
  return (
    <section
      role="alert"
      className="rounded-lg border border-red-500/50 bg-red-500/10 px-4 py-4 text-sm"
    >
      <h3 className="font-semibold text-red-200">⚠ {report.heading}</h3>
      <p className="mt-2 text-red-100/90">
        <span className="rounded bg-red-500/20 px-1.5 py-0.5 font-mono text-xs">{report.kind}</span>{" "}
        <span className="font-mono text-xs">{report.detail}</span>
      </p>
      <p className="mt-2 text-xs text-red-100/70">{report.advice}</p>
    </section>
  );
}

interface ErrorBoundaryProps {
  /** Names the part being guarded, so a nested boundary's message says which one caught. */
  readonly where: string;
  readonly children: ReactNode;
}

interface ErrorBoundaryState {
  readonly error: unknown;
  readonly caught: boolean;
}

/**
 * A class component, which is not a stylistic choice: `getDerivedStateFromError`
 * and `componentDidCatch` have no hook equivalent, and React 19 still provides
 * none. This is the one place in this dashboard that must be a class.
 *
 * `caught` is a separate boolean rather than `error !== null`, because `null` and
 * `undefined` are both throwable and a boundary that treated `throw null` as "no
 * error" would render nothing and reproduce the blank page it exists to prevent.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { error: null, caught: false };

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    return { error, caught: true };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    // The operator's devtools are where the stack is useful. There is deliberately
    // no reporting endpoint -- see the module header.
    console.error(`render error in ${this.props.where}`, error, info.componentStack);
  }

  override render(): ReactNode {
    if (this.state.caught) {
      return <RenderErrorFallback report={describeRenderError(this.state.error, this.props.where)} />;
    }
    return this.props.children;
  }
}
