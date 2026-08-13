/**
 * `/proposal` — where a real `/derive` response becomes a readable proposal
 * (spec 21.4 stage 4).
 *
 * ── WHY THIS PAGE TAKES PASTED RESPONSES RATHER THAN CALLING THE ENDPOINTS ──
 *
 * Stated plainly because it is the one design choice on this page a reader is
 * entitled to question.
 *
 * Stage 4 is a RENDERING and ASSEMBLY concern. Both of its inputs already exist:
 * `/assess` and `/derive` are real, live-verified endpoints, and a client that
 * has run the two-call flow is holding both responses. Nothing about assembling
 * them into a proposal needs a third call, a model, or a new endpoint.
 *
 * Making this page CALL the two endpoints instead would be a different decision
 * with real consequences, and it belongs to a different part of the spec:
 *
 *   - It is a TRIGGER decision (21.6), not a rendering one. Both endpoints are
 *     curl-only today by explicit choice (decision log 42: "no dashboard control
 *     — consistent with /candles, /gather, /assess, /derive and the watchlist").
 *   - Each `/derive` call costs a real, paid Workers AI inference, and each pair
 *     of calls has taken 45–88 seconds of model time across the six live runs so
 *     far. A button that spends money and blocks for a minute is a design
 *     problem of its own, not a side effect of building a renderer.
 *   - The two-call flow needs the client-side projection step 42 specifies
 *     (`citations: [.citations[].id]`), which is genuinely new client behaviour
 *     rather than presentation.
 *
 * So: paste what the two calls really returned. The whole `{data, error}`
 * envelope from `curl` is accepted as-is, and so is a bare `data` object if you
 * have already run it through `jq '.data'`.
 *
 * ── ⚠ NOTHING IS SENT, AND THIS PAGE STORES NOTHING ──
 *
 * This page makes no network request of any kind, and it writes nothing — no D1
 * row, no `audit_log` entry, no KV key, no `localStorage`. Reloading it loses the
 * pasted responses.
 *
 * ⚠ THAT IS NO LONGER THE SAME AS THE PROPOSAL BEING LOST. Spec 21.5 requirement
 * 5's permanent record now EXISTS and the BACKEND wrote it when the two calls ran
 * (migration 0009, `src/research/proposal-log.ts`): the full bundle, the full
 * prompt, the raw model response, retained indefinitely per section 8.7. Both
 * pasted responses carry the `proposalId` of the row holding theirs, and the
 * rendered footer shows both ids so a reviewer can act on them
 * (`POST /api/bots` with `proposalId`, or `POST /api/proposals/:id/reject`).
 *
 * The distinction is worth keeping straight: this page is a VIEWER over data that
 * is already recorded elsewhere, not the only copy of it.
 */

import { useState } from "react";
import { Link } from "react-router-dom";
import type { AssessResponse, DeriveResponse } from "../api/research-types";
import { ErrorBoundary } from "../components/ErrorBoundary";
import { ProposalView } from "../components/ProposalView";

/**
 * Accept either the `{ data, error }` envelope every endpoint answers in, or the
 * bare `data` object.
 *
 * A failure envelope is reported as the backend's own error rather than as a
 * parse problem: pasting a real refusal is a normal thing to do, and telling
 * someone their JSON is malformed when the backend simply said 409 would send
 * them looking in the wrong place.
 */
function unwrapEnvelope(parsed: unknown): { ok: true; data: unknown } | { ok: false; message: string } {
  if (typeof parsed !== "object" || parsed === null) {
    return { ok: false, message: "the pasted text is valid JSON but not an object" };
  }
  const record = parsed as Record<string, unknown>;
  if ("data" in record && "error" in record) {
    if (record.error !== null) {
      const error = record.error as { code?: unknown; message?: unknown };
      return {
        ok: false,
        message: `this is a FAILURE response from the backend, not a proposal: ${String(error.code)} — ${String(error.message)}`,
      };
    }
    return { ok: true, data: record.data };
  }
  return { ok: true, data: parsed };
}

/**
 * A shape check on locally-pasted text, and nothing more.
 *
 * This is NOT validation of the pipeline's output and must not grow into it: the
 * backend already resolved every citation, ran the real create-bot decoders and
 * checked the venue floor and the capital headroom. All this does is refuse to
 * render an object that is obviously not the response it claims to be, so a
 * missing key surfaces as a sentence rather than as a blank screen.
 */
function requireKeys(data: unknown, keys: readonly string[], what: string): string | null {
  if (typeof data !== "object" || data === null) return `${what}: expected an object`;
  const record = data as Record<string, unknown>;
  const missing = keys.filter((key) => !(key in record));
  if (missing.length > 0) {
    return `${what}: this does not look like the right response — it has no ${missing.join(", ")}. Paste the whole body of the call, envelope and all.`;
  }
  return null;
}

interface Parsed {
  readonly derive: DeriveResponse | null;
  readonly assess: AssessResponse | null;
  readonly deriveError: string | null;
  readonly assessError: string | null;
}

function parseBoth(deriveText: string, assessText: string): Parsed {
  let derive: DeriveResponse | null = null;
  let assess: AssessResponse | null = null;
  let deriveError: string | null = null;
  let assessError: string | null = null;

  if (deriveText.trim() !== "") {
    try {
      const unwrapped = unwrapEnvelope(JSON.parse(deriveText));
      if (!unwrapped.ok) {
        deriveError = unwrapped.message;
      } else {
        deriveError = requireKeys(
          unwrapped.data,
          ["bundle", "context", "assessment", "derive"],
          "derive response",
        );
        if (deriveError === null) derive = unwrapped.data as DeriveResponse;
      }
    } catch (cause) {
      deriveError = `could not parse as JSON: ${cause instanceof Error ? cause.message : String(cause)}`;
    }
  }

  if (assessText.trim() !== "") {
    try {
      const unwrapped = unwrapEnvelope(JSON.parse(assessText));
      if (!unwrapped.ok) {
        assessError = unwrapped.message;
      } else {
        assessError = requireKeys(unwrapped.data, ["bundle", "assess"], "assess response");
        if (assessError === null) assess = unwrapped.data as AssessResponse;
      }
    } catch (cause) {
      assessError = `could not parse as JSON: ${cause instanceof Error ? cause.message : String(cause)}`;
    }
  }

  return { derive, assess, deriveError, assessError };
}

function InputPanel({
  deriveText,
  assessText,
  onDeriveText,
  onAssessText,
  deriveError,
  assessError,
}: {
  deriveText: string;
  assessText: string;
  onDeriveText: (value: string) => void;
  onAssessText: (value: string) => void;
  deriveError: string | null;
  assessError: string | null;
}) {
  return (
    <section className="space-y-4 rounded-lg border border-zinc-800 bg-zinc-900/40 px-4 py-4">
      <div>
        <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-400">
          Paste the two real responses
        </h2>
        <p className="mt-1 text-xs text-zinc-500">
          Nothing is sent anywhere and nothing is stored. The whole{" "}
          <code>{"{ data, error }"}</code> body from <code>curl</code> works as-is; so does a bare{" "}
          <code>data</code> object.
        </p>
      </div>

      <div>
        <label htmlFor="derive-json" className="text-xs font-medium text-zinc-300">
          <code>GET /api/accounts/:label/derive</code> response — required
        </label>
        <textarea
          id="derive-json"
          value={deriveText}
          onChange={(event) => onDeriveText(event.target.value)}
          spellCheck={false}
          rows={6}
          placeholder='{"data":{"entryPoint":"named","bundle":{…},"context":{…},"assessment":{…},"derive":{…}},"error":null}'
          className="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 font-mono text-xs text-zinc-200 placeholder:text-zinc-700 focus:border-zinc-500 focus:outline-none"
        />
        {deriveError !== null && (
          <p className="mt-1 text-xs text-red-300">{deriveError}</p>
        )}
      </div>

      <div>
        <label htmlFor="assess-json" className="text-xs font-medium text-zinc-300">
          <code>GET /api/accounts/:label/assess</code> response — optional
        </label>
        <p className="text-[11px] text-zinc-600">
          Adds Stage 2&rsquo;s own evidence table and the drift comparison between the two gathers.
          The proposal renders without it.
        </p>
        <textarea
          id="assess-json"
          value={assessText}
          onChange={(event) => onAssessText(event.target.value)}
          spellCheck={false}
          rows={4}
          placeholder='{"data":{"entryPoint":"named","bundle":{…},"assess":{…}},"error":null}'
          className="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 font-mono text-xs text-zinc-200 placeholder:text-zinc-700 focus:border-zinc-500 focus:outline-none"
        />
        {assessError !== null && <p className="mt-1 text-xs text-red-300">{assessError}</p>}
      </div>
    </section>
  );
}

export function Proposal() {
  const [deriveText, setDeriveText] = useState("");
  const [assessText, setAssessText] = useState("");
  const { derive, assess, deriveError, assessError } = parseBoth(deriveText, assessText);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-xl font-semibold text-zinc-100">Bot proposal</h1>
          <p className="text-xs text-zinc-500">
            Spec 21.4 stage 4 — the assessment and the derivation, assembled for review.
          </p>
        </div>
        <Link
          to="/"
          className="text-sm text-zinc-400 underline-offset-2 hover:text-zinc-200 hover:underline"
        >
          ← Back to bots
        </Link>
      </div>

      <InputPanel
        deriveText={deriveText}
        assessText={assessText}
        onDeriveText={setDeriveText}
        onAssessText={setAssessText}
        deriveError={deriveError}
        assessError={assessError}
      />

      {derive === null ? (
        <div className="rounded-lg border border-zinc-800 px-4 py-10 text-center text-sm text-zinc-500">
          {deriveText.trim() === ""
            ? "Paste a derive response above to see the proposal."
            : "The derive response could not be read — see the message above."}
        </div>
      ) : (
        /*
         * ⚠ THE OUTER BOUNDARY. `ProposalView` wraps its parameters and evidence
         * sections individually, so a failure in either is contained to that block;
         * this one catches anything OUTSIDE them — the header, the concentration
         * banner, the limits panel, the freshness verdict, or `freshnessOf` and
         * `dataLimits` themselves, which run before any of it renders.
         *
         * It is deliberately OUTSIDE the textareas rather than around the whole page,
         * so a crashing paste never takes away the inputs needed to fix it. That was
         * the practical problem with the blank screen: the operator could not even
         * re-paste without reloading and losing both bodies.
         */
        <ErrorBoundary where="The proposal">
          <ProposalView derive={derive} assess={assess} />
        </ErrorBoundary>
      )}
    </div>
  );
}
