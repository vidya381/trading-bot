/**
 * The real transport behind `AssessModel` (spec 21.4 Stage 2).
 *
 * This is the binding adapter and NOTHING ELSE. It sits beside `envNewsFetcher`,
 * `envCandleLister` and `envSymbolLister` for the same reason those exist:
 * everything under `src/research/` stays free of Cloudflare bindings and
 * testable without them, and the one place that touches `env` lives here.
 *
 * ── IT IS A COMPOSITION, NOT AN IMPLEMENTATION ──
 *
 * Every decision this file appears to make was already made, argued and tested
 * elsewhere, and this file must not re-make any of them:
 *
 *   * WHAT IS SENT -- `buildAssessPrompt` (assess-prompt.ts). Not touched here.
 *   * WITH WHAT SETTINGS -- `ASSESS_MODEL_SETTINGS` (assess.ts), imported and
 *     read off the request rather than restated. A second copy of
 *     `temperature: 0` in this file would be a second thing to keep in step, and
 *     the copy that drifts is the one nobody is watching.
 *   * HOW THE ANSWER IS READ -- `parseAssessResponse` (assess-parse.ts), reached
 *     through `assessCandidate`. This file does not parse, validate, narrow,
 *     unwrap, retry or default. It hands the transport's value back untouched.
 *
 * ── IT PERFORMS NO NARROWING, AND THAT IS THE WHOLE POINT ──
 *
 * The obvious thing to write here is `return raw.response`. **That is exactly
 * the bug decision log 37 found with a live call.** The probe hand-extracted
 * `.response` and assumed it was a JSON string, because Cloudflare's own
 * generated type says `{ response: string }` for this model's output arm. The
 * real answer came back as an already-parsed OBJECT, the parser refused it, and
 * the refusal was correct.
 *
 * So `unwrapModelEnvelope` owns the narrowing, and this file hands over the
 * whole transport value: `text` and `raw` are the SAME object by identity.
 * `text` is typed `unknown` on the port precisely so a transport can decline to
 * narrow, and declining is the right choice for a shape this system does not
 * control and has already been wrong about once.
 *
 * There is a second, sharper reason not to be clever here, and it is worth
 * stating because the tempting version looks harmless: **`JSON.stringify(raw)`
 * would be actively dangerous.** It would make the answer arrive as text, which
 * makes `findDuplicateKey` run, which makes the result report
 * `duplicateKeyCheck: "performed"` -- for a scan over bytes this system
 * generated itself, which can never contain a duplicate key. That is the
 * "theatre" failure `DuplicateKeyCheck` documents, reintroduced at the transport
 * layer where the parser's own tests would never see it. A mutation test covers
 * exactly this.
 *
 * ── IT CATCHES NOTHING ──
 *
 * No try/catch around `ai.run`, no retry, no fallback, no default. A transport
 * failure propagates to `assessCandidate`'s caller as itself, and a response the
 * parser refuses propagates as `AssessParseError`. Decision log 37's zero-retry
 * decision stands and is argued there: "retry until it parses" selects the
 * answer for passing the validator rather than for being what the model gave.
 *
 * The one guard is the missing binding, which is a precondition rather than a
 * failure of a call that happened.
 */

import type { AssessModel, AssessModelRequest } from "../research/assess";

/**
 * The `Env` fields this adapter needs, and nothing more.
 *
 * Narrower than `Env` on purpose: a function that takes the whole environment
 * can quietly grow a dependency on any binding in it, and this one must only
 * ever reach Workers AI. `AI` is optional because it is optional on `Env` --
 * only the testnet environment declares the binding today (decision log 38),
 * and production deliberately does not.
 */
export interface AssessModelEnv {
  readonly AI?: Ai;
}

export type AssessModelErrorCode =
  /** No `ai` binding in this environment. No call was attempted. */
  | "no_ai_binding";

export class AssessModelError extends Error {
  readonly code: AssessModelErrorCode;
  constructor(code: AssessModelErrorCode, message: string) {
    super(message);
    this.name = "AssessModelError";
    this.code = code;
  }
}

/**
 * Map this system's settings onto Workers AI's own parameter names.
 *
 * The only translation in this file, and it is a rename rather than a decision:
 * `maxTokens` is `max_tokens` and `responseFormat` is `response_format` because
 * that is what the binding's input type calls them. Every VALUE comes off the
 * request, so changing a setting means editing `ASSESS_MODEL_SETTINGS` and
 * nowhere else.
 */
function inputsFor(request: AssessModelRequest) {
  return {
    prompt: request.prompt,
    temperature: request.settings.temperature,
    seed: request.settings.seed,
    max_tokens: request.settings.maxTokens,
    response_format: request.settings.responseFormat,
  };
}

/**
 * Build the real `AssessModel` for an environment.
 *
 * A factory rather than a bare function because the port takes only a request:
 * the binding has to be closed over somewhere, and doing it here keeps
 * `assessCandidate`'s signature free of `Env` -- which is what lets every test
 * in `src/research/` drive a stub without a Worker environment.
 *
 * The prompt variant is used rather than `messages`, matching what the live
 * probe sent and what `AssessModel` documents: the grounding rules and the data
 * travel as ONE string, so no caller can drop a system message and silently
 * lose 21.5 requirement 1's instruction while the data still looks intact.
 */
export function envAssessModel(env: AssessModelEnv): AssessModel {
  return async (request) => {
    const ai = env.AI;
    if (ai === undefined) {
      throw new AssessModelError(
        "no_ai_binding",
        "no `ai` binding in this environment, so no model can be reached and NO CALL WAS " +
          "ATTEMPTED. Only the testnet environment declares one (decision log 38); production " +
          "deliberately does not. This is not a model outage and retrying will not help.",
      );
    }

    // The one call. Deliberately not narrowed, not stringified, not inspected:
    // `unwrapModelEnvelope` owns the transport shape (see the header).
    const raw: unknown = await ai.run(request.model, inputsFor(request));

    return { text: raw, raw };
  };
}
