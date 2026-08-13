/**
 * A refusal from `/assess` or `/derive`, turned into something a human can act
 * on — WITHOUT ever losing the backend's own code.
 *
 * ── THE RULE THIS MODULE EXISTS TO KEEP ──
 *
 * Every message this produces carries the REAL code and the REAL message the
 * endpoint returned. There is no "something went wrong" anywhere in this file
 * and no branch that swallows a code it does not recognise: the default arm
 * prints the code and the message verbatim, because an unrecognised code is
 * still a fact and a dashboard that hides it sends its reader to look in the
 * wrong place. That is `describeError`'s rule in `pages/CreateBot.tsx`, followed
 * here rather than reinvented — the `tone` / `title` / `text` shape below is
 * that page's `Outcome`, deliberately, so a reviewer meets one convention.
 *
 * (It is a COPY of that shape rather than an import: `Outcome` is a local type
 * inside `CreateBot.tsx`, a 1,400-line `.tsx` that no test in this repository can
 * import — React does not resolve in the Workers pool this suite runs in, so a
 * test importing it collects zero tests rather than failing, which entry 45's
 * gap (b) shows is most of the way to no test at all. Hoisting `Outcome` out of
 * that file would mean editing the create-bot form, whose only verification is
 * the operator's eyes. Stated as the judgement call it is.)
 *
 * ── ⚠ WHICH STAGE FAILED IS PART OF THE ANSWER, NOT DECORATION ──
 *
 * The two stages fail for genuinely different reasons and cost genuinely
 * different amounts. An Assess refusal usually means the run never started: no
 * inference was spent. A Derive refusal means **an Assess inference has already
 * been paid for** — 10.5-41.5 s of real model time on the eight samples this
 * project has taken — and the strategy judgement it produced is still good. A
 * reader who cannot tell those apart cannot tell "try a different pair" from
 * "press the button again and it will probably work".
 *
 * `assessAlreadySpent` carries that fact explicitly so the page states it rather
 * than leaving it to be inferred from the stage badge.
 *
 * ── ⚠ THE SAME CODE MEANS TWO DIFFERENT THINGS AT TWO DIFFERENT STATUSES ──
 *
 * This is the subtlety in the whole module and it is why every branch below
 * tests the STATUS as well as the code. `envelope.ts` maps `missing_field`,
 * `unexpected_field`, `duplicate_key`, `strategy_not_recognised` and
 * `citation_unknown` to 4xx as REQUEST faults — but `getAccountAssess` and
 * `getAccountDerive` both re-throw the PARSER's codes at 502 when a MODEL
 * answered badly, and the parser's vocabulary contains those same five words.
 *
 *   `missing_field` at 400 -> this dashboard built a bad request.
 *   `missing_field` at 502 -> the model's answer was missing a field.
 *
 * Reporting the second as the first would tell an operator to fix a form that is
 * working correctly. `citation_unknown` is the sharpest case: at 409 it is the
 * stale-resubmission refusal this whole two-call flow is built around, and at 502
 * it is a model inventing an id.
 *
 * ── WHAT IS DELIBERATELY NOT ENUMERATED ──
 *
 * Codes these two endpoints cannot emit get no branch. `proposal_not_derivable`,
 * `unknown_proposal`, `proposal_already_resolved` and `proposal_account_mismatch`
 * belong to `POST /api/bots` and `POST /api/proposals/:id/reject`, not to
 * `/assess` or `/derive` — a branch for them here would be a check that cannot
 * fire, reading in review like coverage. If one ever does arrive, the default arm
 * prints it in full.
 */

/** Which of the two calls refused. */
export type RunStage = "assess" | "derive";

/** `CreateBot.tsx`'s `Outcome` tones, unchanged. */
export type FailureTone = "error" | "warning";

export interface StageFailure {
  readonly stage: RunStage;
  readonly tone: FailureTone;
  /** The backend's own code, ALWAYS. `""` only when nothing came back at all. */
  readonly code: string;
  /** The real HTTP status. `0` when the request never got a response. */
  readonly status: number;
  /** The backend's own message, verbatim and never paraphrased away. */
  readonly message: string;
  readonly title: string;
  /** What the code means here, in plain words. */
  readonly text: string;
  /** What to do next. Empty when there is honestly nothing useful to say. */
  readonly next: string;
  /**
   * True when a real, paid Assess inference was already spent before this
   * failure. Only ever true on the derive stage.
   */
  readonly assessAlreadySpent: boolean;
}

/**
 * The minimum this module needs off a thrown error. Structural rather than an
 * `instanceof ApiError` check so the pure logic is testable without constructing
 * the client's class, and so an error from any other source still reports
 * honestly instead of falling off the end.
 */
export interface FailureInput {
  readonly code: string;
  readonly message: string;
  readonly status: number;
}

const STAGE_NAME: Record<RunStage, string> = {
  assess: "Assess",
  derive: "Derive",
};

/**
 * Read a thrown value into the three fields this module reasons about.
 *
 * `ApiError` (api/client.ts) already carries exactly `code`, `message` and
 * `status`, so the structural read picks it up without importing it. Anything
 * else — a `TypeError` from a bug in this dashboard, a `DOMException` — is
 * reported as what it literally is at status 0, never as a backend refusal.
 */
export function readFailure(error: unknown): FailureInput {
  if (typeof error === "object" && error !== null) {
    const record = error as { code?: unknown; message?: unknown; status?: unknown };
    if (typeof record.code === "string" && typeof record.status === "number") {
      return {
        code: record.code,
        message: typeof record.message === "string" ? record.message : "",
        status: record.status,
      };
    }
  }
  return {
    code: "",
    message: error instanceof Error ? error.message : String(error),
    status: 0,
  };
}

/**
 * `DeriveValidationError` reaches the wire as `<layer>/<code>` — `decoder/…`,
 * `strategy_validator/…` or `sanity_bound/…` — because "the real create-bot
 * decoder refused this" and "this stage's own sanity bound refused this" are
 * different facts about a proposal and `DeriveValidationError.layer` exists to
 * keep them apart. A reader shown the bare code would lose the distinction the
 * backend went to trouble to preserve.
 */
const VALIDATION_LAYERS: Record<string, string> = {
  decoder: "the real create-bot decoder",
  strategy_validator: "the real strategy validator",
  sanity_bound: "this stage's own sanity bound",
};

function validationLayerOf(code: string): { readonly layer: string; readonly rest: string } | null {
  const slash = code.indexOf("/");
  if (slash <= 0) return null;
  const layer = code.slice(0, slash);
  const described = VALIDATION_LAYERS[layer];
  if (described === undefined) return null;
  return { layer: described, rest: code.slice(slash + 1) };
}

/**
 * Turn a refusal into a stage-tagged, honest description.
 *
 * @param stage which call refused. Decides `assessAlreadySpent` and the title.
 * @param error whatever was thrown. Read structurally by `readFailure`.
 */
export function describeRunFailure(stage: RunStage, error: unknown): StageFailure {
  const { code, message, status } = readFailure(error);
  const spent = stage === "derive";
  const base = {
    stage,
    code,
    status,
    message,
    assessAlreadySpent: spent,
  } as const;
  const label = STAGE_NAME[stage];

  // ── The request never reached a result at all ──────────────────────────────
  if (status === 0) {
    return {
      ...base,
      tone: "warning",
      title: `${label} could not be reached`,
      text:
        code === "network_error"
          ? "The request failed before any answer came back, so it is not known whether the call ran."
          : `The request failed before any answer came back: ${message}`,
      next:
        stage === "assess"
          ? "Nothing was proposed and most likely nothing was spent. Check your connection and run it again."
          : "The Assess inference was already paid for. Running the whole thing again spends a second one.",
    };
  }

  if (code === "unauthenticated") {
    return {
      ...base,
      tone: "error",
      title: "Your Cloudflare Access session has expired",
      text: "The dashboard is behind Access and its session cookie is no longer valid, so the call never reached the endpoint.",
      next: "Reload the page to sign in again, then run it once more.",
    };
  }

  // ── A MODEL answered, and its answer was unusable (502) ────────────────────
  //
  // Checked BEFORE the 4xx table, because five of the parser's codes collide by
  // name with request-fault codes and only the status separates them.
  if (status === 502) {
    const validation = validationLayerOf(code);
    if (validation !== null) {
      return {
        ...base,
        tone: "error",
        title: `${label}: the proposed parameters were refused by ${validation.layer}`,
        text: `The model answered and its parameters were rejected before anything was shown: ${message}`,
        next: "Nothing was created and no capital moved. Running it again asks the model for a fresh answer, which may or may not pass.",
      };
    }
    return {
      ...base,
      tone: "error",
      title: `${label}: the model's answer was unusable`,
      text: `${message} The inference was spent and the answer was refused rather than shown to you in a degraded form.`,
      next: "Running it again asks the model a second time. It is not a fix — the same prompt can produce the same unusable shape.",
    };
  }

  // ── THE STALE RESUBMISSION — the refusal this two-call flow is built around ─
  //
  // ⚠ THE `status === 409` IS LOAD-BEARING EVEN THOUGH THE 502 BLOCK ABOVE
  // ALREADY CATCHES THE OTHER MEANING. A mutation run removed it and NOTHING
  // FAILED — which was true and was still the wrong conclusion. What the guard
  // protects is the ADVICE: this branch is the only one in the file that tells a
  // reader the refusal is expected and to just run it again. `citation_unknown`
  // is the one code in `envelope.ts` deliberately left OUT of the status table
  // precisely because it means three different things at three statuses, so a
  // future fourth meaning arriving here must NOT inherit "this is normal, press
  // the button again". Pinned by a test that hands it a third status.
  if (code === "citation_unknown" && status === 409) {
    return {
      ...base,
      tone: "warning",
      title: "Derive: the assessment cited data this run no longer has",
      text: `${message} Both calls gather their own data independently, so between them the candle window can shorten, a candle fetch can fail, or a concentration flag can clear — and an assessment resting on evidence that is gone is refused rather than derived from.`,
      next: "This is expected drift, not a fault. Run the whole thing again: a fresh Assess produces claims grounded in data Derive will still have.",
    };
  }

  switch (code) {
    // ── Preconditions the run could not meet (503) ───────────────────────────
    case "no_price_history":
      return {
        ...base,
        tone: "error",
        title: `${label}: no usable price history`,
        text: `${message} No model was asked, because a strategy chosen with no prices could only come from training knowledge.`,
        next: "Nothing was spent on this call. Try a pair the venue has candles for.",
      };
    case "candles_unavailable":
    case "no_candles_returned":
      return {
        ...base,
        tone: "warning",
        title: `${label}: the venue's candles could not be read`,
        text: `${message} This is the exchange or the connection to it, not anything you typed.`,
        next: "Nothing was proposed. Try again in a moment.",
      };
    case "tradable_set_unreadable":
      return {
        ...base,
        tone: "warning",
        title: `${label}: the venue's tradable list could not be read`,
        text: `${message} Whether this pair can be traded is unknown, and an unknown is not treated as a yes.`,
        next: "Try again in a moment, or pick a different account.",
      };
    case "capital_unreadable":
      return {
        ...base,
        tone: "error",
        title: "Derive: the capital ledger could not be read",
        text: `${message} Parameters are sized against real headroom, so no numbers were proposed.`,
        next: "The Assess inference was already spent. Fix the ledger read before running it again.",
      };
    case "symbol_filters_unreadable":
      return {
        ...base,
        tone: "error",
        title: "Derive: the venue's order rules could not be read",
        text: `${message} Tick size, step size and the minimum-order floor decide whether a proposed order is even placeable.`,
        next: "The Assess inference was already spent. Try again in a moment.",
      };
    case "no_ai_binding":
      return {
        ...base,
        tone: "error",
        title: `${label}: no model is wired up in this environment`,
        text: `${message} This is a deployment configuration fact, not a data problem.`,
        next: "Nothing was spent. This needs whoever looks after the Worker's bindings.",
      };
    case "no_capital_headroom":
      return {
        ...base,
        tone: "warning",
        title: "Derive: this account has no capital headroom",
        text: `${message} There is nothing to size a bot against, so no parameters were proposed.`,
        next: "The Assess inference was already spent. Free up capital on this account, or use a different one.",
      };

    // ── The request itself (4xx) ─────────────────────────────────────────────
    case "pair_not_tradable":
    case "pair_not_spot_by_name":
    case "instrument_not_spot":
      return {
        ...base,
        tone: "error",
        title: `${label}: this account cannot trade that pair`,
        text: `${message} A coin that cannot become a bot is refused before any work is done, rather than producing a proposal nobody could act on.`,
        next: "Nothing was spent. Pick a pair from this account's own tradable list.",
      };
    case "interval_not_verified":
      return {
        ...base,
        tone: "error",
        title: `${label}: that candle interval is not verified on this venue`,
        text: `${message} Each venue spells its intervals differently, so an unverified one does not error — it returns correctly-shaped candles of a DIFFERENT duration that nothing downstream could detect. It is refused instead.`,
        next: "Nothing was spent. Choose a verified interval and run it again.",
      };
    case "unknown_account":
      return {
        ...base,
        tone: "error",
        title: `${label}: that account is not registered`,
        text: `${message} Reloading refetches the account list.`,
        next: "Nothing was spent. Reload the page and pick an account again.",
      };
    case "strategy_not_recognised":
      // At 400 this is the RESUBMISSION being refused -- so the strategy this
      // dashboard forwarded is not one of the backend's two literals. That is a
      // fault in this projection, not in the operator's input.
      //
      // ⚠ GUARDED ON THE STAGE, and a mutation run is what showed why. `/assess`
      // has no resubmission in it at all: the only way it can produce this code
      // is `AssessParseError` at 502, which the block above already handles. So
      // an assess-stage one at any other status is something this dashboard has
      // never seen, and describing it as "the resubmitted assessment" would name
      // a thing that does not exist on that call. It falls to the default arm,
      // which prints the truth.
      if (stage !== "derive") break;
      return {
        ...base,
        tone: "error",
        title: "Derive: the resubmitted assessment named an unrecognised strategy",
        text: `${message} The assessment forwarded from Assess should only ever carry "dca" or "grid", so this points at the dashboard's own projection rather than at anything you did.`,
        next: "The Assess inference was already spent. Report this — it is a bug in the trigger, not a data problem.",
      };
    case "missing_field":
    case "invalid_field":
    case "invalid_filter":
      return {
        ...base,
        tone: "error",
        title: `${label}: the request was rejected`,
        text: `${message} The dashboard builds every parameter of this call, so a rejection here points at the trigger rather than at anything you typed.`,
        next: "Nothing was spent on the model. Report this — it is a bug in the trigger.",
      };
  }

  // ── Anything else: the real code and the real message, in full ─────────────
  return {
    ...base,
    tone: "error",
    title: `${label} refused the request (${code || "no code"}, HTTP ${status})`,
    text:
      message === ""
        ? "The endpoint refused it and returned no message."
        : message,
    next: spent
      ? "The Assess inference was already spent. Nothing was created and no capital moved."
      : "Nothing was created and no capital moved.",
  };
}
