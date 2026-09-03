/**
 * THE CROSS-CHECK that keeps wiredness a DERIVED FACT rather than a
 * hand-maintained opinion.
 *
 * WHAT CHANGED, AND WHY THIS FILE CHANGED WITH IT. This used to police a
 * `Record<ExchangeId, boolean>` against the real dispatch, because "does a
 * `case` exist in a `switch`" is not a question code can ask -- so a person had
 * to answer it, and this test existed to catch them answering it wrongly. That
 * hazard is now gone at the source: `exchange-dispatch.ts` dispatches through
 * `EXCHANGE_RESOLVERS`, whose `null` entry IS the askable form of that question,
 * and `isWiredExchange` computes the answer from it and from `METHOD_WEIGHTS`.
 *
 * So this file no longer asserts WHICH venues are wired. Pinning today's answer
 * is exactly the staleness the derivation removes -- `wiredExchanges()` used to
 * be asserted equal to `["binance", "gemini"]`, which would have had to be
 * edited by hand on the very day the thing it describes changed. What is
 * asserted instead is that THE DERIVATION HOLDS, for every `ExchangeId`, against
 * the real tables -- a property that stays true as venues come and go -- plus
 * the two mutation tests that prove wiredness really does follow the code with
 * no manual step.
 *
 * SECRETS ARE ALL PRESENT ON PURPOSE. The distinction under test is "is there a
 * resolver at all", not "is it configured". A missing secret makes a real
 * resolver return `{ ok: false, reason }` -- still a resolution -- so a
 * fully-populated env is what isolates the one difference this is about.
 * `exchange.test.ts`, `exchange-gemini.test.ts` and `exchange-kraken.test.ts`
 * own the fail-closed behaviour itself; nothing here duplicates it.
 */

import { describe, expect, it } from "vitest";
import { env as testEnv } from "cloudflare:test";
import { EXCHANGE_IDS, type ExchangeId } from "../db/schema";
import {
  describeUnwiredExchange,
  hasCredentialsResolver,
  hasRateLimitCostModel,
  isWiredExchange,
  wiredExchanges,
} from "./venue-wiring";
import {
  EXCHANGE_RESOLVERS,
  resolveExchangeForAccount,
  type ExchangeResolver,
} from "./exchange-dispatch";
import {
  GEMINI_METHOD_WEIGHTS,
  METHOD_WEIGHTS,
  type MethodWeights,
} from "../exchange/rate-limited";

const NOW = () => 1_700_000_000_000;

/** 88 base64 characters, the shape Kraken issues. Not a real credential. */
const KRAKEN_SECRET = `${"a".repeat(86)}==`;

/**
 * Every secret and binding every resolver reads, so only the dispatch itself can
 * differ between venues. The real test `env` supplies the bindings (a resolver
 * also needs `RATE_LIMITER` before it will hand back a client); the secrets are
 * layered on top because the suite deliberately holds none.
 */
function fullyConfiguredEnv(environment: "testnet" | "production"): Env {
  return {
    ...testEnv,
    ENVIRONMENT: environment,
    BINANCE_API_KEY: "binance-key",
    BINANCE_API_SECRET: "binance-secret",
    GEMINI_API_KEY: "gemini-key",
    GEMINI_API_SECRET: "gemini-secret",
    KRAKEN_API_KEY: "kraken-key",
    // Well-formed base64, unlike the other two venues' secrets: Kraken's must
    // DECODE, and its resolver refuses one that does not.
    KRAKEN_API_SECRET: KRAKEN_SECRET,
  } as unknown as Env;
}

describe("wiredness is derived from the two real blockers", () => {
  it.each([...EXCHANGE_IDS])(
    "%s: isWiredExchange is exactly (has resolver AND has cost model)",
    (exchange) => {
      expect(isWiredExchange(exchange)).toBe(
        hasCredentialsResolver(exchange) && hasRateLimitCostModel(exchange),
      );
    },
  );

  it.each([...EXCHANGE_IDS])(
    "%s: the resolver check reads the table dispatch really uses",
    (exchange) => {
      const resolution = resolveExchangeForAccount(exchange, fullyConfiguredEnv("production"), NOW);
      // Dispatch is TOTAL now -- a venue with no resolver returns a refusal that
      // names the gap, where the old `default`-less switch returned `undefined`.
      expect(resolution).toBeDefined();
      // A venue the predicate calls resolvable must not come back with the
      // "no credentials resolver" refusal, and vice versa. This is the half that
      // could once drift: the predicate and the dispatch now read one table.
      const refusedForNoResolver =
        !resolution.ok && resolution.reason.includes("no credentials resolver in this build");
      expect(refusedForNoResolver).toBe(!hasCredentialsResolver(exchange));
    },
  );

  it.each([...EXCHANGE_IDS])("%s: the cost-model check reads METHOD_WEIGHTS itself", (exchange) => {
    expect(hasRateLimitCostModel(exchange)).toBe(METHOD_WEIGHTS[exchange] !== undefined);
  });

  it("covers every ExchangeId in both source tables, with no venue unanswered", () => {
    // The runtime half of the compile-time totality: a `Record<ExchangeId, ...>`
    // cannot be missing a key, but this also catches a key added to the object
    // that is not an ExchangeId at all.
    expect(Object.keys(EXCHANGE_RESOLVERS).sort()).toEqual([...EXCHANGE_IDS].sort());
    // METHOD_WEIGHTS is deliberately NOT asserted total here: it is missing its
    // kraken row on purpose (entry 90 step (d)), which is the open `tsc` error
    // at rate-limited.ts:196 and the reason Kraken is unwired. Asserting
    // totality would duplicate rate-limited.test.ts's own failing assertion and
    // add a second red test for one gap.
  });

  it("a venue is wired only if BOTH blockers are closed, never just one", () => {
    for (const exchange of EXCHANGE_IDS) {
      if (isWiredExchange(exchange)) {
        expect(hasCredentialsResolver(exchange)).toBe(true);
        expect(hasRateLimitCostModel(exchange)).toBe(true);
      }
    }
    expect(wiredExchanges().every(isWiredExchange)).toBe(true);
  });
});

/** Stands in for a resolver when a test needs one present but never calls it. */
const STUB_RESOLVER: ExchangeResolver = () => ({ ok: false, reason: "stub resolver" });

/**
 * Run `body` with one venue's two blockers forced into a known state, then put
 * both tables back exactly as they were.
 *
 * WHY THE TESTS BELOW USE THIS INSTEAD OF WHICHEVER VENUE HAPPENS TO BE UNWIRED.
 * Asserting against Kraken's real state would pin TODAY's answer, which is the
 * staleness this whole rewrite removes -- every such test would go red on the
 * day the rate-limiter session lands its `METHOD_WEIGHTS` row, and would have to
 * be hand-edited to say the opposite. Constructing the state instead tests the
 * DERIVATION, which is what has to keep working. These stay green through that
 * transition.
 *
 * Mutating module-level tables is not something this suite does lightly. It is
 * synchronous with no `await` between mutation and restore, and the restore is
 * in a `finally`.
 */
function withWiringState(
  exchange: ExchangeId,
  state: { readonly resolver: boolean; readonly costModel: boolean },
  body: () => void,
): void {
  const resolvers = EXCHANGE_RESOLVERS as Record<string, ExchangeResolver | null>;
  const weights = METHOD_WEIGHTS as Record<string, MethodWeights | undefined>;
  // `?? null` only covers an absent key, which cannot happen: EXCHANGE_RESOLVERS
  // is total over ExchangeId. It is here to satisfy the index-signature read,
  // not to paper over a real case.
  const savedResolver: ExchangeResolver | null = resolvers[exchange] ?? null;
  const savedWeights = weights[exchange];
  // `delete` vs assignment matters: the missing kraken row is an ABSENT KEY, not
  // a key holding undefined, and the restore has to reproduce whichever it was.
  const hadWeightsKey = Object.prototype.hasOwnProperty.call(weights, exchange);
  try {
    resolvers[exchange] = state.resolver ? (savedResolver ?? STUB_RESOLVER) : null;
    if (state.costModel) weights[exchange] = savedWeights ?? GEMINI_METHOD_WEIGHTS;
    else delete weights[exchange];
    body();
  } finally {
    resolvers[exchange] = savedResolver;
    if (hadWeightsKey) weights[exchange] = savedWeights;
    else delete weights[exchange];
  }
}

describe("wiredness follows the code, with no manual flag to flip", () => {
  it("kraken's resolver blocker is closed, and stays closed", () => {
    // Permanent, and the half entry 94's message got wrong: Kraken HAS a
    // credentials resolver (`workers/exchange-kraken.ts`). Only the cost model
    // is outstanding.
    expect(hasCredentialsResolver("kraken")).toBe(true);
  });

  it("kraken is wired exactly when it has a cost model, and on nothing else", () => {
    // Says "the cost model is the ONLY remaining blocker" without pinning which
    // side of it today falls on. True now (both false) and true after the
    // rate-limiter session (both true), with no edit in between -- which is the
    // property being claimed, stated in a form that can hold across the change.
    expect(isWiredExchange("kraken")).toBe(hasRateLimitCostModel("kraken"));
  });

  it.each([...EXCHANGE_IDS])(
    "%s: adding a cost model wires it, removing one un-wires it, with nothing else touched",
    (exchange) => {
      // THE PROPERTY THE DERIVATION EXISTS FOR, proved in both directions rather
      // than asserted in prose. The rate-limiter session adds one row and its
      // venue becomes tradable in that same commit -- nobody has to notice a
      // failing test and flip a boolean, which is exactly what the previous
      // design required and what it would have got wrong.
      withWiringState(exchange, { resolver: true, costModel: false }, () => {
        expect(isWiredExchange(exchange)).toBe(false);
        expect(wiredExchanges()).not.toContain(exchange);
      });
      withWiringState(exchange, { resolver: true, costModel: true }, () => {
        expect(isWiredExchange(exchange)).toBe(true);
        expect(wiredExchanges()).toContain(exchange);
      });
    },
  );

  it.each([...EXCHANGE_IDS])(
    "%s: a venue with no resolver is never wired, whatever its cost model says",
    (exchange) => {
      // The other conjunct, and the reason both are checked rather than only the
      // one Kraken happens to be blocked on. A cost model alone must not make a
      // venue tradable: there would be nothing to authenticate with.
      withWiringState(exchange, { resolver: false, costModel: true }, () => {
        expect(isWiredExchange(exchange)).toBe(false);
      });
    },
  );

  it.each([...EXCHANGE_IDS])("%s: the harness restores both tables exactly", (exchange) => {
    // The harness is only safe if it really does put things back -- every test
    // that runs after one of these depends on it. Captured and compared rather
    // than asserted against known values, so this holds whatever state the
    // build is in, and so it also catches the subtle half: an ABSENT
    // METHOD_WEIGHTS key must be restored as absent, not as a key holding
    // undefined. `hasOwnProperty` is what tells those two apart.
    const resolverBefore = hasCredentialsResolver(exchange);
    const costModelBefore = hasRateLimitCostModel(exchange);
    const keyBefore = Object.prototype.hasOwnProperty.call(METHOD_WEIGHTS, exchange);

    withWiringState(exchange, { resolver: !resolverBefore, costModel: !costModelBefore }, () => {
      expect(hasCredentialsResolver(exchange)).toBe(!resolverBefore);
      expect(hasRateLimitCostModel(exchange)).toBe(!costModelBefore);
    });

    expect(hasCredentialsResolver(exchange)).toBe(resolverBefore);
    expect(hasRateLimitCostModel(exchange)).toBe(costModelBefore);
    expect(Object.prototype.hasOwnProperty.call(METHOD_WEIGHTS, exchange)).toBe(keyBefore);
  });
});

describe("describeUnwiredExchange names what is ACTUALLY missing", () => {
  // Built from the same two checks `isWiredExchange` uses, so it can only ever
  // name a gap that is really open. The previous message was one fixed sentence
  // asserting both at once ("no resolver in resolveExchangeForAccount and no
  // rate-limit cost model"), which went stale for its first half the day
  // `exchange-kraken.ts` landed -- it would have sent an operator looking for a
  // resolver sitting right there in the tree. Each case below is constructed, so
  // these hold whichever venues are wired at the time.
  const SUBJECT: ExchangeId = "gemini";

  it("names only the cost model when only the cost model is missing", () => {
    withWiringState(SUBJECT, { resolver: true, costModel: false }, () => {
      const message = describeUnwiredExchange(SUBJECT);
      expect(message).toContain(SUBJECT);
      expect(message).toContain("rate-limit cost model");
      expect(message).toContain("METHOD_WEIGHTS");
      expect(message).not.toContain("no credentials resolver");
    });
  });

  it("names only the resolver when only the resolver is missing", () => {
    withWiringState(SUBJECT, { resolver: false, costModel: true }, () => {
      const message = describeUnwiredExchange(SUBJECT);
      expect(message).toContain("no credentials resolver");
      expect(message).not.toContain("rate-limit cost model");
    });
  });

  it("names both when both are missing", () => {
    withWiringState(SUBJECT, { resolver: false, costModel: false }, () => {
      const message = describeUnwiredExchange(SUBJECT);
      expect(message).toContain("no credentials resolver");
      expect(message).toContain("rate-limit cost model");
    });
  });

  it("points the operator at venues that really are wired", () => {
    withWiringState(SUBJECT, { resolver: true, costModel: false }, () => {
      const message = describeUnwiredExchange(SUBJECT);
      for (const wired of wiredExchanges()) expect(message).toContain(wired);
      // And never at the venue it is refusing.
      expect(message).toContain("until then use one of:");
    });
  });

  it("does not claim a wired venue is unwired", () => {
    // Unreachable through either call site, both of which check first. Asserted
    // so a caller with a bug gets a message saying so, rather than a confident
    // refusal for a venue that works.
    for (const exchange of wiredExchanges()) {
      expect(describeUnwiredExchange(exchange)).toContain("is fully wired");
    }
  });

  it("describes kraken's real gap today", () => {
    // The one deliberately current assertion, kept because it is the message an
    // operator gets from this build right now. It is guarded so that it reports
    // the truth rather than going red on the day Kraken is wired.
    if (isWiredExchange("kraken")) {
      expect(describeUnwiredExchange("kraken")).toContain("is fully wired");
      return;
    }
    const message = describeUnwiredExchange("kraken");
    expect(message).toContain("rate-limit cost model");
    expect(message).not.toContain("no credentials resolver");
  });
});

describe("dispatch is total, so no venue can fall through to undefined", () => {
  it.each([...EXCHANGE_IDS])("%s returns a real resolution in every environment", (exchange) => {
    for (const environment of ["testnet", "production"] as const) {
      const resolution = resolveExchangeForAccount(exchange, fullyConfiguredEnv(environment), NOW);
      // What entry 94 PART 2's bot halted on was `.ok` of `undefined`, from a
      // `switch` with no `default`. There is no such path any more.
      expect(resolution).toBeDefined();
      expect(typeof resolution.ok).toBe("boolean");
    }
  });

  it("routes kraken to the real Kraken resolver, environment refusal included", () => {
    // Proves the `case` is not merely present but wired to the right resolver:
    // only Kraken's refuses testnet outright (entry 90 DECISION 1), and only
    // Kraken's succeeds against a base64 secret in production.
    const onTestnet = resolveExchangeForAccount("kraken", fullyConfiguredEnv("testnet"), NOW);
    expect(onTestnet.ok).toBe(false);
    if (!onTestnet.ok) expect(onTestnet.reason).toContain("no sandbox");

    const onProduction = resolveExchangeForAccount("kraken", fullyConfiguredEnv("production"), NOW);
    expect(onProduction.ok).toBe(true);
  });

  it("still resolves the venues that were already wired", () => {
    for (const exchange of ["binance", "gemini"] as ExchangeId[]) {
      const resolution = resolveExchangeForAccount(exchange, fullyConfiguredEnv("testnet"), NOW);
      // Configured secrets, so these resolve rather than fail closed -- which
      // proves the env above really is complete and the test is measuring
      // dispatch, not a missing variable.
      expect(resolution.ok).toBe(true);
    }
  });
});
