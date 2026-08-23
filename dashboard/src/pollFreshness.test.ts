/**
 * GROUP D — `pollFreshness`, the honesty half of decision log 54.
 *
 * `pollEngine`'s three rules make the poll able to complete. These pin the part
 * that says so when it still does not: what is on screen has a real age, and an
 * age past the threshold gets stated rather than displayed silently behind a
 * green "Live" dot.
 */

import { describe, expect, it } from "vitest";
import {
  POLL_STALE_AFTER_MS,
  pollFreshness,
  pollFreshnessMessage,
} from "./pollFreshness";
import { formatAge } from "./proposal";

const NOW = 1_700_000_000_000;

describe("D. pollFreshness", () => {
  it("D1: no poll has EVER succeeded — `never`, with no age at all", () => {
    const freshness = pollFreshness(null, NOW);

    // `never` is not a worse `stale`. There is no timestamp behind it, so there
    // is no number to show, and `ageMs` says so rather than reporting a 0 that
    // would read as "just updated".
    expect(freshness.verdict).toBe("never");
    expect(freshness.ageMs).toBeNull();
    expect(pollFreshnessMessage(freshness)).toContain("has ever succeeded");
  });

  it("D2: inside the threshold — `fresh`, and nothing to say", () => {
    const freshness = pollFreshness(NOW - 14_999, NOW);

    expect(freshness.verdict).toBe("fresh");
    expect(freshness.ageMs).toBe(14_999);
    // A "this is fresh" banner is a reassurance the page has not earned
    // (`ProposalFreshness`'s argument, reused).
    expect(pollFreshnessMessage(freshness)).toBeNull();
  });

  it("D3: past the threshold — `stale`, said in words, with the age reused from formatAge", () => {
    const freshness = pollFreshness(NOW - 45_000, NOW);

    expect(freshness.verdict).toBe("stale");
    expect(freshness.ageMs).toBe(45_000);
    expect(freshness.thresholdMs).toBe(POLL_STALE_AFTER_MS);

    // `formatAge` is NOT redefined here -- it already exists in `proposal.ts`,
    // already handles clock skew, and is already what `ProposalFreshness`
    // renders with. This asserts the reuse rather than the formatting.
    expect(pollFreshnessMessage(freshness)).toBe(
      `Not updated for ${formatAge(45_000)} — this data has stopped refreshing.`,
    );
  });

  it("D4: the EXACT boundary is stale, pinned deliberately", () => {
    // The threshold is the longest age still considered current, so reaching it
    // is no longer being within it. Pinned because an off-by-one here is exactly
    // the kind of thing a mutation run catches and a reviewer does not.
    expect(pollFreshness(NOW - POLL_STALE_AFTER_MS, NOW).verdict).toBe("stale");
    expect(pollFreshness(NOW - POLL_STALE_AFTER_MS + 1, NOW).verdict).toBe("fresh");
    expect(POLL_STALE_AFTER_MS).toBe(15_000);
  });

  it("D5: CLOCK SKEW — a timestamp in the future is not stale, and does not throw", () => {
    const freshness = pollFreshness(NOW + 60_000, NOW);

    // A warning no refresh could ever clear is worse than no warning: the age is
    // negative because the machine's clock moved, not because the data stopped.
    expect(freshness.verdict).toBe("fresh");
    expect(freshness.ageMs).toBe(-60_000);
    expect(pollFreshnessMessage(freshness)).toBeNull();
  });

  it("D6: ⚠ THE WARM ROW — staleness does NOT depend on `error`", () => {
    // Decision log 54 PART 3's dangerous row, exactly: during the starvation no
    // setState ever ran, so `error` stayed NULL while `lastUpdated` froze. An
    // implementation that consulted `error` would have called this fresh, because
    // there was no error to see.
    const frozen = NOW - 90_000;
    const errorFree = { data: ["a bot"], error: null, loading: false, lastUpdated: frozen };
    const withError = {
      data: ["a bot"],
      error: new Error("network_error"),
      loading: false,
      lastUpdated: frozen,
    };

    const a = pollFreshness(errorFree.lastUpdated, NOW);
    const b = pollFreshness(withError.lastUpdated, NOW);

    expect(a.verdict).toBe("stale");
    expect(a).toEqual(b);

    // Stronger than an assertion about behaviour: `error` is not reachable from
    // this function. Two positional parameters plus an optional threshold.
    expect(pollFreshness.length).toBe(2);
  });

  it("D7: it is NOT wired into any banner's verdict — the banner still decides from data and loading alone", () => {
    const SOURCES = import.meta.glob("/dashboard/src/**/*.{ts,tsx}", {
      query: "?raw",
      eager: true,
    }) as Record<string, { default: string }>;

    // The guard would pass vacuously if the glob returned nothing.
    expect(Object.keys(SOURCES).length).toBeGreaterThan(20);
    expect(Object.keys(SOURCES)).toContain("/dashboard/src/killSwitchBannerState.ts");

    /*
     * `killSwitchBannerState.ts:41-51` states that an edit adding a staleness
     * input to its verdict would DROP A CONFIRMED TRIPPED BANNER on the first
     * transient blip -- "a strictly worse bug than the one this module fixes".
     * This module is one import away from being that edit, so the distance is
     * enforced mechanically rather than remembered.
     */
    const bannerDeciders = [
      "/dashboard/src/killSwitchBannerState.ts",
      "/dashboard/src/components/KillSwitchBanner.tsx",
    ];
    for (const path of bannerDeciders) {
      expect(SOURCES[path]!.default, `${path} must not consult poll freshness`).not.toMatch(
        /from ["'].*pollFreshness["']/,
      );
    }

    // And the verdict function still reads exactly what it always read.
    const decider = SOURCES["/dashboard/src/killSwitchBannerState.ts"]!.default;
    const body = decider.slice(decider.indexOf("export function killSwitchBannerState"));
    expect(body).toContain("poll.data");
    expect(body).toContain("poll.loading");
    expect(body).not.toContain("stale");
    expect(body).not.toContain("lastUpdated");
  });
});
