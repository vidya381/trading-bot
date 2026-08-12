/**
 * The over-concentration flag, presented prominently (spec 21.4 stage 1).
 *
 * The spec's own wording is the whole design brief for this file: the
 * concentration read is "a flag on the proposal for the human to weigh,
 * PRESENTED PROMINENTLY, not a silent filter". So this component
 *
 *   - renders FIRST in the proposal, above the strategy, the parameters and the
 *     reasoning, so it cannot be buried below content a reader scrolls past;
 *   - is the loudest thing on the page after the app-wide kill-switch banner,
 *     and carries `role="alert"`;
 *   - blocks nothing and hides nothing. Nothing here filters the proposal out.
 *     The flag is an input to the human's decision, exactly as 21.1 requires.
 *
 * ── THREE STATES, AND THE MIDDLE ONE IS THE POINT ──
 *
 * `ConcentrationResult` is a VARIANT on the backend, not a flag list with a
 * boolean, and the slot around it can also have failed. So there are three
 * genuinely different facts and this renders three genuinely different things:
 *
 *   FLAGGED    -- the check ran and found something to weigh. Loud.
 *   DID NOT RUN -- the read failed or threw. ALSO LOUD, and deliberately: an
 *                 unknown is not a clean result, and the failure mode this
 *                 guards against is a reviewer glancing at a quiet strip and
 *                 reading "nothing shown" as "nothing there". `/assess` and
 *                 `/derive` both let a failed concentration read through rather
 *                 than failing the request (a usable, grounded proposal should
 *                 not be lost to an unrelated D1 error), which is correct and is
 *                 exactly why the gap has to be visible here.
 *   NO CONCENTRATION -- the check ran and found nothing. A positive statement,
 *                 rendered quietly, because a clean result should not compete
 *                 for attention with the two above.
 */

import type { GatheredInput, ConcentrationResult } from "../api/research-types";
import { formatDateTime } from "../format";

function FlagRow({
  code,
  statement,
  observed,
  threshold,
  capitalAsset,
  basis,
}: {
  code: string;
  statement: string;
  observed: string;
  threshold: string;
  capitalAsset: string | null;
  basis: string | null;
}) {
  return (
    <li className="rounded border border-amber-500/40 bg-amber-950/30 px-3 py-2">
      <div className="text-sm font-medium text-amber-100">{statement}</div>
      <dl className="mt-1.5 flex flex-wrap gap-x-6 gap-y-1 text-xs">
        <div>
          <dt className="inline text-amber-200/60">observed: </dt>
          <dd className="tabular inline text-amber-100">{observed}</dd>
        </div>
        <div>
          <dt className="inline text-amber-200/60">threshold: </dt>
          <dd className="tabular inline text-amber-100">{threshold}</dd>
        </div>
        {capitalAsset !== null && (
          <div>
            <dt className="inline text-amber-200/60">asset: </dt>
            <dd className="inline text-amber-100">{capitalAsset}</dd>
          </div>
        )}
        {basis !== null && (
          <div>
            <dt className="inline text-amber-200/60">basis: </dt>
            <dd className="inline text-amber-100">
              {basis === "pair_only"
                ? "this exact pair (the base asset could not be resolved)"
                : "the base asset"}
            </dd>
          </div>
        )}
        <div>
          <dt className="inline text-amber-200/60">rule: </dt>
          <dd className="inline text-amber-100">
            <code>{code}</code>
          </dd>
        </div>
      </dl>
    </li>
  );
}

export function ProposalConcentration({
  concentration,
}: {
  concentration: GatheredInput<ConcentrationResult>;
}) {
  // THE CHECK DID NOT RUN. Loud, because unknown is not clean.
  if (concentration.outcome !== "ok") {
    const detail =
      concentration.outcome === "failed"
        ? `${concentration.error.code}: ${concentration.error.message}`
        : `${concentration.error.name}: ${concentration.error.message}`;
    return (
      <section
        role="alert"
        className="overflow-hidden rounded-lg border-2 border-amber-500/70 bg-amber-500/10"
      >
        <div className="bg-amber-500/20 px-4 py-2">
          <h2 className="flex items-center gap-2 text-sm font-bold uppercase tracking-wide text-amber-200">
            <span aria-hidden>⚠</span>
            Over-concentration: NOT CHECKED
          </h2>
        </div>
        <div className="px-4 py-3 text-sm text-amber-100">
          <p>
            The read of what this account already holds did not complete, so whether this proposal
            would over-concentrate the account is <strong>unknown</strong>. That is not the same as
            it being fine.
          </p>
          <p className="mt-2 text-xs text-amber-200/70">
            {concentration.outcome === "threw_unexpectedly"
              ? "Something beneath the check threw — this is NOT one of its enumerated refusals. "
              : ""}
            {detail}
            {" · observed at "}
            {formatDateTime(concentration.failedAt)}
          </p>
        </div>
      </section>
    );
  }

  const result = concentration.value;

  // THE CHECK RAN AND FLAGGED. The case the spec calls out by name.
  if (result.assessment === "flagged") {
    return (
      <section
        role="alert"
        className="overflow-hidden rounded-lg border-2 border-amber-500 bg-amber-500/10"
      >
        <div className="bg-amber-500 px-4 py-2">
          <h2 className="flex items-center gap-2 text-sm font-bold uppercase tracking-wide text-amber-950">
            <span aria-hidden>⚠</span>
            Over-concentration flagged — {result.flags.length} finding
            {result.flags.length === 1 ? "" : "s"} to weigh
          </h2>
        </div>
        <div className="space-y-3 px-4 py-3">
          <p className="text-sm text-amber-100">
            This account already holds positions that make this proposal worth a second look. This
            is <strong>not a block and not a filter</strong> — nothing was withheld or downgraded.
            It is a fact for you to weigh before approving.
          </p>
          <ul className="space-y-2">
            {result.flags.map((flag, index) => (
              <FlagRow
                key={`${flag.code}-${index}`}
                code={flag.code}
                statement={flag.statement}
                observed={flag.observed}
                threshold={flag.threshold}
                capitalAsset={flag.capitalAsset}
                basis={flag.basis}
              />
            ))}
          </ul>
          <dl className="tabular flex flex-wrap gap-x-6 gap-y-1 text-xs text-amber-200/70">
            <div>
              <dt className="inline">bots on this pair: </dt>
              <dd className="inline text-amber-100">{result.samePairBots}</dd>
            </div>
            <div>
              <dt className="inline">stopped bots on this pair: </dt>
              <dd className="inline text-amber-100">{result.samePairStoppedBots}</dd>
            </div>
            <div>
              <dt className="inline">committed bots on this account: </dt>
              <dd className="inline text-amber-100">{result.committedBots}</dd>
            </div>
            <div>
              <dt className="inline">bot list read at: </dt>
              <dd className="inline text-amber-100">{formatDateTime(result.readAt)}</dd>
            </div>
          </dl>
        </div>
      </section>
    );
  }

  // THE CHECK RAN AND FOUND NOTHING. A positive statement, rendered quietly.
  return (
    <section className="rounded-lg border border-zinc-800 bg-zinc-900/40 px-4 py-2.5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-zinc-400">
          Over-concentration: checked, nothing flagged
        </h2>
        <span className="tabular text-xs text-zinc-500">
          {result.samePairBots} bot(s) on this pair · {result.committedBots} committed on this
          account · {result.rowsRead} row(s) read at {formatDateTime(result.readAt)}
        </span>
      </div>
    </section>
  );
}
