/**
 * The real transport behind `DeriveModel` (spec 21.4 Stage 3).
 *
 * The binding adapter and NOTHING ELSE, sitting beside `envAssessModel` for the
 * reason that file gives: everything under `src/research/` stays free of
 * Cloudflare bindings, and the one place that touches `env` lives here.
 *
 * ── IT IS A COMPOSITION, AND EVERY DECISION IT APPEARS TO MAKE WAS MADE ELSEWHERE ──
 *
 *   * WHAT IS SENT -- `buildDerivePrompt` (derive-prompt.ts), reached through
 *     `deriveParameters`. Not touched here.
 *   * WITH WHAT SETTINGS -- `DERIVE_MODEL_SETTINGS[strategy]` (derive.ts), read
 *     OFF THE REQUEST and never restated. A second `temperature: 0` here would
 *     be a second thing to keep in step, and the copy that drifts is the one
 *     nobody is watching.
 *   * HOW THE ANSWER IS READ -- `parseDeriveResponse` and `validateProposal`,
 *     reached through `deriveParameters`. This file does not parse, validate,
 *     narrow, unwrap, retry or default.
 *
 * ── THE SCHEMA IS PER-STRATEGY, AND THIS FILE STILL CHOOSES NOTHING ──
 *
 * Stage 3's `response_format` differs between grid and DCA, which is the one
 * genuinely new thing at this seam. It is handled by NOT handling it: the
 * request arrives with its settings already selected by
 * `deriveParameters`, this file forwards `request.settings.responseFormat`
 * verbatim, and `request.strategy` travels beside it so an audit record can show
 * the two agreed.
 *
 * **THE TEMPTING BUG HERE IS A LOOKUP.** Writing
 * `DERIVE_MODEL_SETTINGS[request.strategy]` in this file instead of forwarding
 * `request.settings` would look identical in review, would pass every test that
 * only checks the sent schema, and would silently become the authority on which
 * schema is served -- in a file whose whole justification is that it decides
 * nothing. Then a caller that had already picked settings could have them
 * quietly replaced. A mutation test covers exactly this.
 *
 * ── IT PERFORMS NO NARROWING, FOR STEP 37's REASON ──
 *
 * The obvious line to write is `return raw.response`. That is exactly the bug
 * decision log 37's first live probe found: Cloudflare's own generated type says
 * `{ response: string }` for this model's output arm, and the real answer
 * arrives as an already-parsed OBJECT. So `text` and `raw` are THE SAME VALUE BY
 * IDENTITY and `unwrapModelEnvelope` owns the shape.
 *
 * `JSON.stringify(raw)` would be actively dangerous for the reason
 * `envAssessModel` documents: it would make the answer arrive as text, which
 * makes `findDuplicateKey` run, which makes the result report
 * `duplicateKeyCheck: "performed"` for a scan over bytes this system generated
 * itself and which therefore can never contain a duplicate key. That is step
 * 37's "theatre" failure reintroduced one layer below where the parser's own
 * tests could see it.
 *
 * ── IT CATCHES NOTHING ──
 *
 * No try/catch around `ai.run`, no retry, no fallback, no default. Stage 3's
 * zero-retry decision is argued in `derive.ts` and is stronger than Stage 2's:
 * Derive proposes nine numbers against validators, so a retry loop would be a
 * search procedure whose objective function is "parameters that squeeze through
 * the checks".
 *
 * The one guard is the missing binding, which is a precondition rather than a
 * failure of a call that happened.
 */

import type { DeriveModel, DeriveModelRequest } from "../research/derive";

/**
 * The `Env` fields this adapter needs, and nothing more.
 *
 * Narrower than `Env` on purpose, exactly as `AssessModelEnv` is: a function
 * taking the whole environment can quietly grow a dependency on any binding in
 * it, and this one may only ever reach Workers AI. `AI` is optional because it
 * is optional on `Env` -- only testnet declares the binding (decision log 38),
 * and production deliberately does not.
 */
export interface DeriveModelEnv {
  readonly AI?: Ai;
}

export type DeriveModelErrorCode =
  /** No `ai` binding in this environment. No call was attempted. */
  | "no_ai_binding";

export class DeriveModelError extends Error {
  readonly code: DeriveModelErrorCode;
  constructor(code: DeriveModelErrorCode, message: string) {
    super(message);
    this.name = "DeriveModelError";
    this.code = code;
  }
}

/**
 * Map this system's settings onto Workers AI's own parameter names.
 *
 * The only translation in this file, and a rename rather than a decision:
 * `maxTokens` is `max_tokens` and `responseFormat` is `response_format` because
 * that is what the binding's input type calls them. EVERY VALUE COMES OFF THE
 * REQUEST, so changing a setting means editing `DERIVE_MODEL_SETTINGS` and
 * nowhere else.
 */
function inputsFor(request: DeriveModelRequest) {
  return {
    prompt: request.prompt,
    temperature: request.settings.temperature,
    seed: request.settings.seed,
    max_tokens: request.settings.maxTokens,
    response_format: request.settings.responseFormat,
  };
}

/**
 * Build the real `DeriveModel` for an environment.
 *
 * A factory rather than a bare function because the port takes only a request:
 * the binding has to be closed over somewhere, and doing it here keeps
 * `deriveParameters`' signature free of `Env` -- which is what lets every test
 * in `src/research/` drive a stub without a Worker environment.
 *
 * The prompt variant is used rather than `messages`, matching `envAssessModel`
 * and what four live probes have sent: the grounding rules and the data travel
 * as ONE string, so no caller can drop a system message and silently lose 21.5
 * requirement 1's instruction while the data still looks intact.
 */
export function envDeriveModel(env: DeriveModelEnv): DeriveModel {
  return async (request) => {
    const ai = env.AI;
    if (ai === undefined) {
      throw new DeriveModelError(
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
