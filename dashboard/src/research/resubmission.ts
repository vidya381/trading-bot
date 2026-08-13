/**
 * THE RESUBMISSION PROJECTION — the one genuinely new piece of client BEHAVIOUR
 * the two-call flow needs (decision log 42, decision log 44's transport section).
 *
 * `GET /api/accounts/:label/assess` returns a Stage 2 result whose citations are
 * whole `EvidenceItem`s. `GET /api/accounts/:label/derive` requires the same
 * assessment with its citations as BARE ID STRINGS, carrying exactly four
 * fields. Entry 42 states the whole of the client's job in one line:
 *
 *     citations: [.citations[].id]
 *
 * This module is that line, written out, so it can be tested rather than typed
 * into a shell each time.
 *
 * ── ⚠ THIS IS A CONTRACT WITH A REAL BACKEND PARSER, NOT A CONVENIENCE SHAPE ──
 *
 * `parseResubmittedAssessment` (`src/research/assess-resubmit.ts`) refuses
 * anything that is not exactly one clean assessment, and it refuses in both
 * directions: a MISSING field is `missing_field` and an EXTRA field is
 * `unexpected_field` (`requireExactFields`). So a projection that helpfully
 * forwarded `evidence`, `model`, `latencyMs` or `promptChars` would be refused
 * just as firmly as one that dropped `envelope` — and the human would read a
 * confusing 400 about their own dashboard rather than anything about their coin.
 * The same exactness applies one level down: each claim carries `statement` and
 * `citations` and NOTHING else.
 *
 * ── WHY THE CITATIONS ARE REDUCED TO IDS RATHER THAN FORWARDED WHOLE ──
 *
 * Not a size optimisation. `parseResubmittedAssessment` refuses an object
 * citation with `citation_not_a_string` and its docblock says why: the `label`,
 * `value` and `source` in a resubmitted item are a rendering of data as it stood
 * at the ORIGINAL call, `/derive` gathers its own fresh bundle and re-resolves
 * every id against THAT, and a field accepted and ignored reads exactly like one
 * that was used. Sending ids makes "your values are not used" true in the wire
 * shape rather than only in a comment.
 *
 * ── WHY THIS IS A DASHBOARD-LOCAL MIRROR AND HOW THE MIRROR IS PINNED ──
 *
 * `RESUBMITTED_ASSESSMENT_FIELDS` is the backend's own constant and the honest
 * thing would be to import it. It cannot be imported: `assess-resubmit.ts` pulls
 * in `assess-prompt`, `assess-parse`, `../db/schema` and `gather`, which drags
 * the Worker's D1 and Workers types into the dashboard's `tsc -b` and breaks it —
 * the failure `dashboard/src/derive.ts` already records and the reason
 * `staleness.ts` had to be written with zero imports to cross that seam.
 *
 * So this file names the four fields itself, and `resubmission.test.ts` closes
 * the gap the way entry 45 says a mirror must be closed rather than trusted: the
 * TEST imports the real `RESUBMITTED_ASSESSMENT_FIELDS` AND runs the real
 * `parseResubmittedAssessment` over this module's real output against a real
 * bundle. A drift here is a test failure, not a live 400.
 *
 * NOTHING HERE FETCHES, STORES OR RENDERS. One pure function over a value the
 * caller already holds.
 */

import type { AssessResult, DuplicateKeyCheck, Strategy } from "../api/research-types";

/**
 * One claim, projected: the statement as it was, and the citations reduced to
 * the ids `resolveCitations` will look up in THIS run's fresh evidence set.
 */
export interface ResubmittedClaim {
  readonly statement: string;
  readonly citations: readonly string[];
}

/**
 * The exact object `?assessment=` carries, and the exact four fields
 * `RESUBMITTED_ASSESSMENT_FIELDS` names.
 *
 * `envelope` and `duplicateKeyCheck` are the ORIGINAL `/assess` call's audit
 * facts. They are forwarded rather than defaulted for the reason
 * `assess-resubmit.ts` gives at length: the backend cannot verify them, carries
 * them anyway so the audit trail is not silently invented, and a manufactured
 * audit fact is worse than an unverified one. A client that made one up would be
 * doing the inventing on the backend's behalf.
 */
export interface ResubmittedAssessment {
  readonly strategy: Strategy;
  readonly claims: readonly ResubmittedClaim[];
  readonly envelope: string;
  readonly duplicateKeyCheck: DuplicateKeyCheck;
}

/**
 * The four field names, in the order `RESUBMITTED_ASSESSMENT_FIELDS` declares
 * them. Exported so the test can compare the two lists directly rather than
 * inferring agreement from a parse that happened to pass.
 */
export const RESUBMITTED_FIELDS: readonly string[] = Object.freeze([
  "strategy",
  "claims",
  "envelope",
  "duplicateKeyCheck",
]);

/**
 * Project a Stage 2 result into the object `/derive` accepts.
 *
 * Takes the `assess` member of an `AssessResponse` — not the whole response —
 * because `entryPoint`, `selectedAt`, `proposalId` and `bundle` are the
 * response's own fields and have no place in the assessment. Passing the whole
 * response and picking here would put the same four-field decision in two
 * places.
 *
 * @param assess the `assess` member of a real `GET .../assess` response.
 * @returns exactly four fields, with every citation reduced to its id.
 */
export function projectResubmission(assess: AssessResult): ResubmittedAssessment {
  return {
    strategy: assess.strategy,
    claims: assess.claims.map((claim) => ({
      statement: claim.statement,
      citations: claim.citations.map((citation) => citation.id),
    })),
    envelope: assess.envelope,
    duplicateKeyCheck: assess.duplicateKeyCheck,
  };
}

/**
 * The projection as the exact bytes that go on the wire.
 *
 * A separate function rather than a `JSON.stringify` at the call site because
 * `parseResubmittedAssessment` runs its DUPLICATE-KEY SCAN on the submitted
 * TEXT, not on a parsed object — it is the one caller in this system holding the
 * client's own bytes, and that scan is the only reason it can catch
 * `{"strategy":"dca","strategy":"grid"}`. So the text is a real part of the
 * contract and gets a named producer.
 *
 * `JSON.stringify` over a freshly built object literal cannot emit a duplicate
 * key, so this client's submissions always pass that scan. That is a property of
 * this caller, not a property the backend may assume, and the backend does not
 * assume it.
 */
export function encodeResubmission(assessment: ResubmittedAssessment): string {
  return JSON.stringify(assessment);
}
