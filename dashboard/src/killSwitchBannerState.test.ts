/**
 * THE BANNER MUST NEVER LET "WE DO NOT KNOW" LOOK LIKE "WE CHECKED, IT IS SAFE".
 *
 * ── THE BUG THIS PINS ──
 *
 * `KillSwitchBanner.tsx:35` decided with one line, from the kill switch's first
 * commit (`db52912`, 2026-07-24) until the step following decision log 47:
 *
 *     if (status === null || status.state !== "tripped") return null;
 *
 * `status` is `usePolling`'s `data`, which is `null` until the first SUCCESSFUL
 * load and stays `null` for as long as the load keeps failing -- the catch keeps
 * `data: prev.data`, and `prev.data` is still null. So if `GET /api/kill-switch`
 * failed from the very first request while the switch was ACTUALLY TRIPPED, the
 * loudest safety element in the system rendered nothing and said nothing. It was
 * pixel-identical to a confirmed all-clear. Decision log 47 section 8 named this
 * and deferred it; these tests are its closure.
 *
 * The rule this file drives is the same one the rest of this codebase already
 * states out loud: "NULL IS NOT ZERO" (api/types.ts), "Null means UNKNOWN, never
 * zero" (accountTotals.ts), "A NULL LIST IS NOT AN EMPTY FLEET"
 * (statusCounts.ts). Here it is "a null status is not an armed switch", on the
 * one element where getting it wrong hides a halted fleet.
 *
 * ── ⚠ THE HALF THAT MUST *NOT* CHANGE, AND IS TESTED AS HARD AS THE NEW HALF ──
 *
 * Step 47's last-good behaviour is deliberate: once a poll has succeeded even
 * once, a LATER failure keeps the bar up rather than dropping it. The obvious
 * over-fix for the bug above -- treating `error !== null` as "unknown" -- would
 * replace a confirmed TRIPPED bar with a hedge on the first transient blip,
 * which is strictly worse than the bug it fixes.
 *
 * So `error` is exhaustively varied below and asserted to change NOTHING. The
 * boundary that matters is `data`, not `error`, and `LAST_GOOD_BOUNDARY` states
 * it as one pair of cases that differ in exactly one field.
 *
 * ── THE MUTATION RUN, AND ITS ONE SURVIVOR ──
 *
 * 14 mutants applied to `killSwitchBannerState.ts` and reverted; the module has
 * exactly one importer that any test can reach, so this file is the whole
 * verdict. 13 KILLED, 1 SURVIVED and PROVEN EQUIVALENT.
 *
 *   M1  original bug restored ("not tripped" means armed)        KILLED (24 failed)
 *   M2  never-succeeded returns "pending" (bar never appears)    KILLED  (9)
 *   M3  first-load-in-flight returns "unknown" (flash on load)   KILLED  (8)
 *   M4  first-load-in-flight returns "armed"                     KILLED  (8)
 *   M5  ⚠ the over-fix: any error means unknown                  KILLED (19)
 *   M6  unrecognised state falls back to "armed"                 KILLED (10)
 *   M7  armed and tripped swapped                                KILLED (20)
 *   M8  outer null guard inverted                                KILLED (39)
 *   M9  loading predicate negated                                KILLED (14)
 *   M10 hardcode "armed"                                         KILLED (33)
 *   M11 hardcode "unknown"                                       KILLED (26)
 *   M12 "not armed" read as tripped (false red bar)              KILLED  (8)
 *   M13 phase check first, guarded by `&& data === null`         SURVIVED
 *   M14 phase check first, UNGUARDED                             KILLED (13)
 *
 * M13 IS EQUIVALENT, NOT A GAP, and the difference between it and M14 is the
 * whole point. M13 reorders the branches but keeps `&& poll.data === null` on
 * the phase check, so last-good data still wins; brute-forced over every
 * (data-shape x loading) pair it differs from the original on NOTHING. M14 is
 * the same reorder with that clause dropped -- and it is a real bug, dropping a
 * confirmed TRIPPED bar to silence during the forced refetch that follows a
 * trigger. It was killed by 13 assertions. A surviving mutant is a claim to
 * check, not automatically a hole.
 *
 * ── WHAT THESE TESTS DO NOT COVER, STATED SO IT IS NOT ASSUMED ──
 *
 * Nothing here mounts a component. The dashboard has no jsdom and no
 * testing-library, and a test importing a `.tsx` collects ZERO TESTS rather than
 * failing inside the Workers pool (docs/open-items/component-test-harness.md).
 * So the amber band's COLOUR, CONTRAST, COPY and POSITION are the operator's to
 * verify, not an assertion here. What is proven is that the VERDICT the banner
 * renders from is right for every input the poll can produce.
 */

import { describe, expect, it } from "vitest";

import {
  killSwitchBannerState,
  type KillSwitchBannerState,
  type KillSwitchPollView,
} from "./killSwitchBannerState";
import { ApiError } from "./api/client";
import type { KillSwitchStatus } from "./api/types";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ARMED: KillSwitchStatus = {
  state: "armed",
  reason: null,
  trippedAt: null,
  trippedBy: null,
  resetAt: 1_755_000_000_000,
  resetBy: "operator",
};

const TRIPPED: KillSwitchStatus = {
  state: "tripped",
  reason: "reconciliation discrepancy over threshold",
  trippedAt: 1_755_000_100_000,
  trippedBy: "reconciliation",
  resetAt: null,
  resetBy: null,
};

/**
 * A status whose `state` is a string this UI does not recognise.
 *
 * NOT a hypothetical. `requestJson` does `(await response.json()) as
 * ApiEnvelope<T>` -- a cast with no runtime validation -- so a backend that ever
 * answers a renamed, added or malformed `state` reaches the banner as a value
 * TypeScript believes cannot exist. The cast here reproduces exactly that: it is
 * how the value arrives in production, not a contrivance to reach a branch.
 */
const UNRECOGNISED = { ...ARMED, state: "disabled" } as unknown as KillSwitchStatus;

/** Every error shape the poll can hold, including "none". */
const ERRORS: readonly (Error | null)[] = [
  null,
  new Error("Failed to fetch"),
  new ApiError("unauthenticated", "your session has expired, reload to sign in again", 401),
  new ApiError("no_schema", "this environment has no database schema yet", 503),
];

const poll = (over: Partial<KillSwitchPollView>): KillSwitchPollView => ({
  data: null,
  error: null,
  loading: false,
  ...over,
});

// ---------------------------------------------------------------------------
// The exhaustive matrix
// ---------------------------------------------------------------------------

/**
 * Every (data, loading) pair with its expected verdict, written out rather than
 * computed. A table derived from the function under test would pass against any
 * implementation, including a broken one.
 */
const CASES: readonly {
  readonly name: string;
  readonly data: KillSwitchStatus | null;
  readonly loading: boolean;
  readonly expected: KillSwitchBannerState;
}[] = [
  {
    name: "a tripped status, first poll still in flight (a forced refetch after a trigger)",
    data: TRIPPED,
    loading: true,
    expected: "tripped",
  },
  { name: "a tripped status, poll settled", data: TRIPPED, loading: false, expected: "tripped" },
  { name: "an armed status, first poll still in flight", data: ARMED, loading: true, expected: "armed" },
  { name: "an armed status, poll settled", data: ARMED, loading: false, expected: "armed" },
  {
    name: "an UNRECOGNISED state string, poll in flight",
    data: UNRECOGNISED,
    loading: true,
    expected: "unknown",
  },
  {
    name: "an UNRECOGNISED state string, poll settled",
    data: UNRECOGNISED,
    loading: false,
    expected: "unknown",
  },
  {
    name: "no status, first poll still in flight -- ordinary load, not a failure",
    data: null,
    loading: true,
    expected: "pending",
  },
  {
    name: "no status, first poll SETTLED -- nothing was ever obtained",
    data: null,
    loading: false,
    expected: "unknown",
  },
];

describe("killSwitchBannerState", () => {
  it("covers every (data-kind x loading x error) combination below", () => {
    // Guards against a case being deleted or an error shape dropped, which would
    // shrink the matrix silently while leaving the suite green.
    expect(CASES).toHaveLength(8);
    expect(ERRORS).toHaveLength(4);
    expect(CASES.length * ERRORS.length).toBe(32);
  });

  for (const { name, data, loading, expected } of CASES) {
    for (const [index, error] of ERRORS.entries()) {
      const label = error === null ? "no error" : `error #${index}: ${error.message}`;
      it(`${name} -- with ${label} -- is "${expected}"`, () => {
        expect(killSwitchBannerState(poll({ data, loading, error }))).toBe(expected);
      });
    }
  }

  it("produces only the four declared states, and produces all four", () => {
    const produced = new Set<KillSwitchBannerState>();
    for (const { data, loading } of CASES) {
      for (const error of ERRORS) produced.add(killSwitchBannerState(poll({ data, loading, error })));
    }
    expect([...produced].sort()).toEqual(["armed", "pending", "tripped", "unknown"]);
  });
});

// ---------------------------------------------------------------------------
// The bug itself, named
// ---------------------------------------------------------------------------

describe("the original defect: an unknown status must not read as armed", () => {
  it('a never-successful poll is "unknown", NOT "armed"', () => {
    const state = killSwitchBannerState(poll({ data: null, loading: false, error: new Error("503") }));
    expect(state).toBe("unknown");
    expect(state).not.toBe("armed");
  });

  it('"armed" is only ever returned from a real status object that said "armed"', () => {
    // The property the old `status.state !== "tripped"` line broke: it reached
    // the silent branch from a null status. Nothing may now claim "armed"
    // without a status in hand saying so.
    for (const { data, loading } of CASES) {
      for (const error of ERRORS) {
        if (killSwitchBannerState(poll({ data, loading, error })) === "armed") {
          expect(data).not.toBeNull();
          expect(data!.state).toBe("armed");
        }
      }
    }
  });

  it("the old one-line rule and the new rule disagree exactly where the bug was", () => {
    // The old rule, transcribed verbatim from KillSwitchBanner.tsx:35, as it
    // stood in `db52912`. Kept here because "the fix changes behaviour" is a
    // claim worth demonstrating rather than asserting -- and because it shows
    // the change is CONFINED to the null-status-after-settling case.
    const oldRuleRendersNothing = (view: KillSwitchPollView): boolean =>
      view.data === null || view.data.state !== "tripped";
    const newRuleRendersNothing = (view: KillSwitchPollView): boolean => {
      const state = killSwitchBannerState(view);
      return state === "armed" || state === "pending";
    };

    const disagreements: string[] = [];
    for (const { name, data, loading } of CASES) {
      for (const error of ERRORS) {
        const view = poll({ data, loading, error });
        if (oldRuleRendersNothing(view) !== newRuleRendersNothing(view)) disagreements.push(name);
      }
    }

    // Two case-rows differ, across all four error shapes: the never-succeeded
    // one (the bug) and the unrecognised-state one (the fail-safe that came with
    // it). Nothing else changes -- in particular no tripped or armed case does.
    expect([...new Set(disagreements)].sort()).toEqual([
      "an UNRECOGNISED state string, poll in flight",
      "an UNRECOGNISED state string, poll settled",
      "no status, first poll SETTLED -- nothing was ever obtained",
    ]);
  });
});

// ---------------------------------------------------------------------------
// ⚠ The boundary step 47 built deliberately, which this step must not move
// ---------------------------------------------------------------------------

describe("last-good data persists through a later failure (step 47, unchanged)", () => {
  /**
   * The two views differ in EXACTLY ONE FIELD: whether a poll ever succeeded.
   * Both are failing right now, with the same error, and neither is loading.
   * That single field is the whole boundary.
   */
  const LAST_GOOD_BOUNDARY = {
    succeededOnceThenFailing: poll({ data: TRIPPED, loading: false, error: new Error("503") }),
    neverSucceeded: poll({ data: null, loading: false, error: new Error("503") }),
  };

  it("a tripped bar stays up while the poll is failing, if it ever succeeded", () => {
    expect(killSwitchBannerState(LAST_GOOD_BOUNDARY.succeededOnceThenFailing)).toBe("tripped");
  });

  it("the same failure with nothing ever obtained is the new unknown state", () => {
    expect(killSwitchBannerState(LAST_GOOD_BOUNDARY.neverSucceeded)).toBe("unknown");
  });

  it("the two differ only in `data`", () => {
    const { succeededOnceThenFailing: a, neverSucceeded: b } = LAST_GOOD_BOUNDARY;
    expect(a.loading).toBe(b.loading);
    expect(a.error?.message).toBe(b.error?.message);
    expect(a.data).not.toBe(b.data);
  });

  it("an armed bar also survives a later failure -- it does not become unknown", () => {
    // The symmetric half. An operator who has seen a confirmed all-clear must
    // not have it retracted into a hedge by one dropped request.
    for (const error of ERRORS) {
      expect(killSwitchBannerState(poll({ data: ARMED, loading: false, error }))).toBe("armed");
    }
  });

  it("`error` NEVER changes the verdict, for any status", () => {
    // Stated as a standalone property because the tempting over-fix for the
    // original bug is `if (poll.error) return "unknown"`, and that edit would
    // silently retract a real tripped banner on a transient blip. If this test
    // ever fails, read the module header before "fixing" it.
    for (const { data, loading } of CASES) {
      const withoutError = killSwitchBannerState(poll({ data, loading, error: null }));
      for (const error of ERRORS) {
        expect(killSwitchBannerState(poll({ data, loading, error }))).toBe(withoutError);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// The no-false-alarm half
// ---------------------------------------------------------------------------

describe("the unknown bar must not fire during an ordinary page load", () => {
  it("the very first render of a fresh mount is `pending`, not `unknown`", () => {
    // `usePolling`'s exact initial state, transcribed: data null, error null,
    // loading true. Every page load passes through this for ~1.4 s (decision log
    // 47's measured baseline API latency). A bar here would appear on every load
    // and teach the operator to ignore bars.
    expect(killSwitchBannerState({ data: null, error: null, loading: true })).toBe("pending");
  });

  it("`pending` becomes `unknown` only once the first poll has settled with nothing", () => {
    const fresh: KillSwitchPollView = { data: null, error: null, loading: true };
    expect(killSwitchBannerState(fresh)).toBe("pending");
    // `usePolling` sets `loading: false` in BOTH its success and its catch path.
    // Settled with no data means the catch path ran.
    expect(killSwitchBannerState({ ...fresh, loading: false })).toBe("unknown");
  });

  it("a settled poll with no data and no error is still `unknown`, not `armed`", () => {
    // Not reachable through `usePolling` today (it sets one of data/error on
    // every settle). Pinned anyway: the fail-safe direction for a combination
    // nobody planned is to admit ignorance, never to imply an all-clear.
    expect(killSwitchBannerState({ data: null, error: null, loading: false })).toBe("unknown");
  });
});
