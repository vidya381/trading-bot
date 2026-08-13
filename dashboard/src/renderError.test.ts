/**
 * `describeRenderError` — the pure half of the error boundary.
 *
 * ── ⚠ WHAT IS AND IS NOT COVERED HERE, STATED FIRST ──
 *
 * NOT COVERED: the CATCHING. React error boundaries only fire on the client;
 * `getDerivedStateFromError` and `componentDidCatch` are not called during server
 * rendering, and `react-dom/server` does not even resolve inside the Workers
 * runtime this suite runs in (both `server.edge` and `server.browser` fail on their
 * CJS requires — verified by probe, not assumed). Testing that would need jsdom
 * plus a second vitest pool, which is a toolchain change rather than part of a
 * crash fix. **So `ErrorBoundary`'s catching is verified by the operator's eyes and
 * by nothing else**, as decision log 44 already records for every component here.
 *
 * COVERED: the MESSAGE a reader ends up looking at, which is the part with real
 * branching in it. `describeRenderError` lives in a REACT-FREE module (`renderError.ts`) precisely
 * so this half is testable at all -- a test importing `ErrorBoundary.tsx` collects
 * ZERO tests, because React itself does not resolve in this runtime.
 *
 * The property that matters most is the last block: **the fallback must not throw**.
 * A boundary whose own fallback crashes has nothing left to catch it and produces
 * exactly the blank page it exists to prevent — and `throw`ing a non-Error is
 * ordinary in JavaScript, so this is a live path rather than a hypothetical.
 */

import { describe, expect, it } from "vitest";
import { describeRenderError } from "./renderError";

const WHERE = "The parameters section";

describe("describeRenderError", () => {
  it("carries a real Error's own name and message, and names where it happened", () => {
    // The real crash: a TypeError out of `roundDecimal`. `kind` matters because
    // "TypeError" is a genuine clue about what went wrong, and a fallback that
    // printed only prose would throw it away.
    const report = describeRenderError(
      new TypeError("undefined is not an object (evaluating 'value.startsWith')"),
      WHERE,
    );
    expect(report.kind).toBe("TypeError");
    expect(report.detail).toBe("undefined is not an object (evaluating 'value.startsWith')");
    expect(report.heading).toBe("The parameters section could not be rendered");
  });

  it("says so when an Error carries no message rather than rendering an empty line", () => {
    const report = describeRenderError(new Error(""), WHERE);
    expect(report.detail).toBe("The error carried no message.");
    expect(report.kind).toBe("Error");
  });

  it("tells the reader nothing was created, and that the rest of the page still stands", () => {
    // The two things a reviewer actually needs from a contained failure: that no
    // capital moved, and that this is a rendering fault rather than a verdict on
    // the proposal.
    const report = describeRenderError(new Error("boom"), WHERE);
    expect(report.advice).toContain("Nothing has been created, started or modified");
    expect(report.advice).toContain("no capital has been touched");
    expect(report.advice).toContain("not a statement about the proposal");
  });

  // ── THE PROPERTY THAT MATTERS: the fallback itself must never throw ──

  describe("⚠ survives every throwable value, because a crashing fallback is a blank page", () => {
    const NASTY: readonly [string, unknown][] = [
      ["a string", "just a string"],
      ["a number", 42],
      ["zero", 0],
      ["a boolean", false],
      ["null", null],
      ["undefined", undefined],
      ["a plain object", { code: "weird" }],
      ["an array", [1, 2, 3]],
      ["a symbol", Symbol("nope")],
      ["a bigint", 123n],
      // The one `api.test.ts` already found once: `String(Object.create(null))`
      // throws "Cannot convert object to primitive value".
      ["a null-prototype object", Object.create(null)],
      // A getter that throws, which is how a proxy or a class with a broken
      // accessor arrives.
      [
        "an object whose toString throws",
        {
          toString() {
            throw new Error("toString exploded");
          },
        },
      ],
      // Circular, which defeats JSON.stringify.
      [
        "a circular object",
        (() => {
          const circular: Record<string, unknown> = { name: "loop" };
          circular.self = circular;
          return circular;
        })(),
      ],
    ];

    for (const [label, value] of NASTY) {
      it(`does not throw on ${label}, and still produces all four fields`, () => {
        let report;
        expect(() => {
          report = describeRenderError(value, WHERE);
        }, `describeRenderError threw on ${label} — the fallback would blank the page`).not.toThrow();

        // Every field non-empty, so the rendered block can never be visually blank.
        // `not.toBe("")` alone would pass on `undefined`, which is the weak-assertion
        // bug decision log 36 recorded; type and content are both checked.
        for (const [field, text] of Object.entries(report as unknown as Record<string, unknown>)) {
          expect(typeof text, `${field} is not a string for ${label}`).toBe("string");
          expect((text as string).length, `${field} is empty for ${label}`).toBeGreaterThan(0);
        }
      });
    }

    it("labels a non-Error throw as one, so a reader is not told it was an error object", () => {
      const report = describeRenderError("just a string", WHERE);
      expect(report.detail).toContain("A non-error value was thrown");
      // `typeof` is the honest `kind` when there is no constructor name.
      expect(report.kind).toBe("string");
    });

    it("reports null and undefined by name rather than as an absent message", () => {
      expect(describeRenderError(null, WHERE).detail).toContain("threw null");
      expect(describeRenderError(undefined, WHERE).detail).toContain("threw undefined");
    });

    it("falls back to a plain sentence when the value cannot be converted to text at all", () => {
      const report = describeRenderError(
        {
          toString() {
            throw new Error("nope");
          },
        },
        WHERE,
      );
      expect(report.detail.length).toBeGreaterThan(0);
      expect(report.kind).toBe("object");
    });
  });

  it("names the guarded region, so nested boundaries are distinguishable", () => {
    // `ProposalView` wraps parameters and evidence separately and the page wraps the
    // whole thing; a reader must be able to tell which one caught.
    expect(describeRenderError(new Error("x"), "The evidence section").heading).toBe(
      "The evidence section could not be rendered",
    );
    expect(describeRenderError(new Error("x"), "The proposal").heading).toBe(
      "The proposal could not be rendered",
    );
  });
});
