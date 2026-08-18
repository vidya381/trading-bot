/**
 * `/proposals/:id` — one permanent record, rendered through the SAME components a
 * live proposal is (spec 21.5 requirement 5).
 *
 * ── ⚠ THE FIDELITY CLAIM, AND IT IS TRACED RATHER THAN ASSERTED ──
 *
 * A `derive` record is handed to the UNCHANGED `ProposalView`. Not a history
 * variant, not a lookalike: the same component, the same summary card, the same
 * concentration banner, the same three-way citation classification, the same
 * evidence tables, and the same staleness policy recomputed on the same one-second
 * tick. The reason that is possible is mechanical rather than lucky —
 *
 *   **THE HANDLER THAT WROTE THE ROW STORED THE VERY OBJECT IT PUT ON THE WIRE.**
 *
 * `getAccountDerive` builds `deriveProposalInputsView(...)` ONCE and uses it for
 * both the response and the stored `inputs_json`, and `deriveProposalReasoningView`
 * is the response's own `derive` object SPREAD plus two fields. So `envelope`,
 * `duplicateKeyCheck`, `settings`, `latencyMs`, `promptChars` and `promptVersion`
 * were never wire-only and there was never anything to lose.
 * `src/api/proposal-replay.ts` carries the trace; `api.test.ts` proves it against a
 * real pipeline run and real D1 by comparing the two objects.
 *
 * ── ⚠ THE TWO THINGS A HISTORICAL RECORD GENUINELY CANNOT DO, STATED ON SCREEN ──
 *
 * 1. **No Stage 2 response beside the Stage 3 one.** `ProposalView` takes an
 *    optional `assess`, and with it renders Stage 2's own evidence table and the
 *    drift comparison between the two independent gathers. A derive row does not
 *    carry the id of the assess row it derives from — migration 0009 records that
 *    as a DECISION, because nothing in the `/derive` request carries the link and an
 *    `assessProposalId` taken from the caller would be a client-asserted claim this
 *    system cannot verify. So this renders with `assess={null}`, which is the state
 *    `ProposalView` has supported since step 44 and the one a reviewer who pasted
 *    only the derive response has always seen. The banner below says so out loud
 *    rather than letting an absent section imply something was lost.
 *
 * 2. **An `assess` record cannot go through `ProposalView` at all**, and that is
 *    structural: `ProposalView` is built around a derivation's parameters, and an
 *    assessment has none — which is the same fact `only_a_derivation_can_be_approved`
 *    enforces in SQL. `ProposalAssessRecord` renders it instead, reusing every
 *    component that is genuinely about a bundle or an evidence set and naming what
 *    it does not carry. Its payload is rebuilt exactly; only the renderer differs.
 *
 * ── ⚠ READ-ONLY, AND NO CREATE-BOT LINK ──
 *
 * `offerCreateBot={false}`. The path from a proposal to a bot exists once, through a
 * LIVE proposal, built to decision log 46's four constraints; a second entry point
 * from a history page would be a second place that copy lives and drifts. This
 * suppresses an AFFORDANCE and not a guarantee — `prefill-does-not-approve.test.ts`
 * holds identically either way, and `proposals.outcome` still moves off NULL in
 * exactly two places on the backend, neither reachable from here.
 */

import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ApiError, fetchProposal } from "../api/client";
import type { ProposalRecordResponse } from "../api/research-types";
import { ErrorBoundary } from "../components/ErrorBoundary";
import { ProposalAssessRecord } from "../components/ProposalAssessRecord";
import { ProposalView } from "../components/ProposalView";
import { formatDateTime } from "../format";
import { OUTCOME_CLASS, OUTCOME_TITLE, historyRowOf, rerunHref } from "../proposalHistory";

function LoadError({ error, id }: { error: Error; id: string }) {
  const code = error instanceof ApiError ? error.code : null;

  if (code === "unknown_proposal") {
    return (
      <div className="rounded-lg border border-amber-500/40 bg-amber-500/5 px-4 py-6 text-sm text-amber-200">
        <p className="font-semibold">No proposal has that id.</p>
        <p className="mt-1 text-xs text-amber-200/80">
          Proposal ids come from the <code>proposalId</code> a real <code>/assess</code> or{" "}
          <code>/derive</code> response carries. There is no way to mint one, and section 8.7 means
          none has ever been deleted — so this really is an id that was never issued, rather than a
          record that has gone.
        </p>
        <p className="mt-2 text-xs">
          <code className="tabular">{id}</code>
        </p>
      </div>
    );
  }
  if (code === "unauthenticated") {
    return (
      <div className="rounded-lg border border-red-500/30 bg-red-500/5 px-4 py-10 text-center text-sm text-red-300">
        Your Cloudflare Access session has expired. Reload to sign in again.
      </div>
    );
  }
  return (
    <div className="rounded-lg border border-red-500/30 bg-red-500/5 px-4 py-10 text-center text-sm text-red-300">
      Couldn’t load this proposal: {error.message}
    </div>
  );
}

/**
 * The record's own facts — who, when, and what was decided — above the proposal.
 *
 * ⚠ THIS IS THE PART A LIVE PROPOSAL DOES NOT HAVE, and it is why the outcome copy
 * inside `ProposalView` is suppressed on this page rather than left saying "the
 * outcome is still unrecorded". For a resolved record that sentence is simply false,
 * and it is the one sentence on the page a reader would act on.
 */
function RecordHeader({ data }: { data: ProposalRecordResponse }) {
  const record = data.proposal;
  const row = historyRowOf(record, Date.now());
  const rerun = rerunHref(record);

  return (
    <section className="space-y-3 rounded-lg border border-zinc-700 bg-zinc-900/60 px-4 py-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span
          title={OUTCOME_TITLE[row.outcome]}
          className={[
            "inline-flex shrink-0 items-center rounded border px-2 py-0.5 text-[11px] uppercase tracking-wide",
            OUTCOME_CLASS[row.outcome],
          ].join(" ")}
        >
          {row.outcomeLabel}
        </span>
        <span className="rounded border border-zinc-700 px-1.5 py-0.5 text-[11px] uppercase tracking-wide text-zinc-400">
          stage {record.stage}
        </span>
        <span className="text-xs text-zinc-500">
          <code className="tabular">{record.id}</code>
        </span>
      </div>

      <dl className="grid gap-x-6 gap-y-2 text-xs sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <dt className="text-[11px] uppercase tracking-wide text-zinc-500">Proposed</dt>
          <dd className="tabular text-zinc-200">{formatDateTime(record.createdAt)}</dd>
          <dd className="text-[11px] text-zinc-600">{row.ageLabel} ago</dd>
        </div>
        <div>
          <dt className="text-[11px] uppercase tracking-wide text-zinc-500">Proposed by</dt>
          {/*
           * ⚠ THE ACCESS-VERIFIED EMAIL, never a caller-supplied string. Decision
           * log 45's mutant M19 exists because a body-supplied actor would attribute
           * a human decision to someone else in a permanent, undeletable record.
           */}
          <dd className="text-zinc-200">{record.actor}</dd>
        </div>
        <div>
          <dt className="text-[11px] uppercase tracking-wide text-zinc-500">Data fetched</dt>
          <dd className="tabular text-zinc-200">{formatDateTime(record.dataFetchedAt)}</dd>
          <dd className="text-[11px] text-zinc-600">
            spec 21.5 req. 4 — the venue&rsquo;s answer time, not the write time
          </dd>
        </div>
        <div>
          <dt className="text-[11px] uppercase tracking-wide text-zinc-500">Decision</dt>
          {record.outcome === null ? (
            <dd className="text-amber-200">none recorded</dd>
          ) : (
            <>
              <dd className="text-zinc-200">
                {record.outcome} by {record.outcomeActor}
              </dd>
              <dd className="tabular text-[11px] text-zinc-600">
                {formatDateTime(record.outcomeAt)} · after {row.pendingLabel}
              </dd>
            </>
          )}
        </div>
      </dl>

      {record.outcomeNote !== null && (
        <p className="rounded border border-zinc-800 bg-zinc-950/40 px-3 py-2 text-xs text-zinc-400">
          <span className="text-zinc-500">Note recorded with the decision: </span>
          {record.outcomeNote}
        </p>
      )}

      {record.outcomeBotInstanceId !== null && (
        <p className="text-xs text-zinc-500">
          A real bot was created from this proposal:{" "}
          <Link
            to={`/bots/${encodeURIComponent(record.outcomeBotInstanceId)}`}
            className="tabular text-zinc-300 underline underline-offset-2 hover:text-zinc-100"
          >
            {record.outcomeBotInstanceId}
          </Link>
          . ⚠ The bot was built from what a human typed into the create-bot form, not from this
          record — nothing is ever read out of a proposal and used as an input (spec 21.1).
        </p>
      )}

      {rerun !== null && (
        <p className="text-xs text-zinc-500">
          Nobody recorded a decision on this one. To ask again with current data,{" "}
          <Link to={rerun} className="text-zinc-300 underline underline-offset-2 hover:text-zinc-100">
            run the pipeline fresh
          </Link>{" "}
          for <span className="text-zinc-400">{record.pair}</span> on{" "}
          <span className="text-zinc-400">{record.accountLabel}</span> — that form is not prefilled
          from here, and pressing it costs two paid inferences and writes two new permanent rows.
          This page changes nothing about this record either way.
        </p>
      )}
    </section>
  );
}

/**
 * ⚠ THE ONE LIMIT OF A HISTORICAL DERIVE RECORD, on screen rather than implied.
 *
 * Rendered ABOVE the proposal, because a reader who finds the Stage 2 evidence table
 * missing after scrolling has already read the proposal without knowing why.
 */
function AssessUnavailableNote() {
  return (
    <p className="rounded-lg border border-zinc-800 bg-zinc-900/20 px-4 py-2.5 text-xs text-zinc-500">
      <strong className="text-zinc-400">Stage 2&rsquo;s own evidence is not shown, and it is
      not missing from the record.</strong>{" "}
      A derive record does not carry the id of the assessment it derives from — migration 0009
      records that as a decision, because nothing in the request carries the link and an id taken
      from the caller would be a claim this system cannot verify. So the Stage 2 evidence table and
      the two-gather drift comparison are absent here, exactly as they are for anyone reviewing a
      derive response on its own. Everything Stage 3 was offered, cited or not, is below in full.
      The assessment Stage 3 was GIVEN is rendered in the strategy section, re-verified against this
      run&rsquo;s own evidence.
    </p>
  );
}

/** A replay the backend could not rebuild. Reported precisely, beside a real record. */
function ReplayRefused({ data }: { data: ProposalRecordResponse }) {
  if (data.replay.ok) return null;
  return (
    <div role="alert" className="rounded-lg border border-red-500/40 bg-red-500/5 px-4 py-4 text-sm text-red-200">
      <p className="font-semibold">This record&rsquo;s stored payload could not be rebuilt.</p>
      <p className="mt-1 text-xs text-red-200/80">
        The record itself is above and is intact — its id, actor, model, timestamps and outcome are
        all real. What could not be reassembled into the shape the live endpoint returned is the
        stored proposal payload, and refusing to render it half-built is deliberate: printing blanks
        for values that are not there is how a truncated document comes to look like a
        half-specified proposal.
      </p>
      <p className="mt-2 text-xs">
        <code>{data.replay.code}</code>
        {data.replay.fields.length > 0 && (
          <>
            {" — missing: "}
            <code>{data.replay.fields.join(", ")}</code>
          </>
        )}
      </p>
      <p className="mt-1 text-xs text-red-200/70">{data.replay.message}</p>
    </div>
  );
}

/** Fields the row carries that the current build does not know about. */
function UnexpectedFieldsNote({ fields }: { fields: readonly string[] }) {
  if (fields.length === 0) return null;
  return (
    <p className="rounded-lg border border-amber-500/40 bg-amber-500/5 px-4 py-2.5 text-xs text-amber-200">
      <strong className="font-semibold">This record was written by a different build.</strong> It
      carries {fields.length} field(s) this version does not declare:{" "}
      <code>{fields.join(", ")}</code>. They are carried through and rendered as stored rather than
      dropped — a row written by an older serializer is a normal thing to find in a table with no
      delete path — but the rest of this page was built against the current shape, so read anything
      surprising with that in mind.
    </p>
  );
}

export function ProposalRecord() {
  const { id = "" } = useParams();
  const [data, setData] = useState<ProposalRecordResponse | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    fetchProposal(id, controller.signal)
      .then((response) => {
        setData(response);
        setError(null);
      })
      .catch((cause: unknown) => {
        if (cause instanceof DOMException && cause.name === "AbortError") return;
        setError(cause instanceof Error ? cause : new Error(String(cause)));
        setData(null);
      })
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, [id]);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-xl font-semibold text-zinc-100">Proposal record</h1>
          <p className="text-xs text-zinc-500">
            Spec 21.5 requirement 5 — the permanent log, read back. Nothing on this page writes.
          </p>
        </div>
        <Link
          to="/proposals"
          className="text-sm text-zinc-400 underline-offset-2 hover:text-zinc-200 hover:underline"
        >
          ← Back to proposal history
        </Link>
      </div>

      {loading && data === null ? (
        <div className="rounded-lg border border-zinc-800 px-4 py-10 text-center text-sm text-zinc-500">
          Loading the record…
        </div>
      ) : error !== null ? (
        <LoadError error={error} id={id} />
      ) : data === null ? null : (
        <>
          <RecordHeader data={data} />
          <ReplayRefused data={data} />
          {data.replay.ok && <UnexpectedFieldsNote fields={data.replay.fidelity.unexpectedStageFields} />}
          {data.replay.ok && data.replay.stage === "derive" && <AssessUnavailableNote />}

          {/*
           * ⚠ THE OUTER BOUNDARY, for `pages/Proposal.tsx`'s reason. `ProposalView`
           * wraps its card, parameters and evidence sections individually, so a
           * failure in any of them is contained; this catches everything OUTSIDE
           * them — the header, the concentration banner, the limits panel, and
           * `freshnessOf`/`dataLimits` themselves, which run before any of it
           * renders. React's default on an uncaught render error is to unmount the
           * whole tree, which is what turned a single TypeError into a blank black
           * page during step 45's live verification.
           *
           * ⚠ IT MATTERS MORE HERE THAN ON THE PASTE PAGE. There the input is a
           * textarea a reader can correct; here it is a permanent row nobody can
           * edit, so a crash with no boundary would make one record permanently
           * unreadable with nothing on screen to say which one.
           */}
          <ErrorBoundary where="This proposal record">
            {data.replay.ok && data.replay.stage === "derive" && (
              <ProposalView derive={data.replay.response} assess={null} offerCreateBot={false} />
            )}
            {data.replay.ok && data.replay.stage === "assess" && (
              <ProposalAssessRecord assess={data.replay.response} />
            )}
          </ErrorBoundary>
        </>
      )}
    </div>
  );
}
