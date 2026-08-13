/**
 * Stage 3's answer: EVERY parameter, and what each one rests on (spec 21.4
 * stage 4, requirement 2).
 *
 * ── EVERY FIELD, ALWAYS, IN THE CREATE-BOT FORM'S OWN ORDER AND WORDING ──
 *
 * 21.4 stage 3 requires a proposal to fill every field the create-bot form
 * requires, with "nothing left as 'tune this yourself'" — a half-specified
 * proposal pushes the hardest judgement back onto the human while still looking
 * like an answer. The backend refuses an incomplete set before a response
 * exists, so this component renders the full field list unconditionally: a field
 * quietly omitted here would undo that guarantee at the last step. Labels and
 * hints are copied from `GridLadderView` and `DcaPositionView` so a reviewer
 * reads the same words on the proposal and on the bot it would become.
 *
 * ── EVERY NUMBER SITS BESIDE THE EVIDENCE IT CAME FROM, CLASSIFIED ──
 *
 * `validatedProposalView` keys its citations by field name and ships whole
 * evidence items rather than bare ids, precisely so a human approving
 * `orderSize: 50.00` reads the datum it rests on in the same place. Each set
 * runs through `CitationList`, so decision log 43's three kinds stay
 * distinguishable — and a field resting on NO fetched data (its live example is
 * a null `takeProfitAmount` justified by `news.status`) says so at field level
 * rather than leaving a reviewer to notice it badge by badge.
 *
 * ── ⚠ THESE NUMBERS PASSED THE REAL VALIDATORS, WHICH IS NOT THE SAME AS BEING GOOD ──
 *
 * The set below already passed `decodeGridParams`/`decodeDcaParams` — the very
 * decoders a human's own form submission runs through — plus the mandatory
 * stop-loss, the sanity bounds, the venue's published minimum-order floor, and a
 * headroom check against the real capital ledger (21.5 requirement 3). None of
 * that answers whether the numbers are sensible for this market. `allocatedCapital`
 * in particular is a PREFILL, not a reservation: nothing has been allocated, and
 * the binding check runs against the ledger again at creation time.
 *
 * ── ⚠ THE SHAPE CHECK, AND THE CRASH IT EXISTS FOR ──
 *
 * `fieldsFor` used to dispatch on `params.strategy` and then read that strategy's
 * fields **on the assumption that they were there**. They were, for every response
 * the backend can produce. They were not for a hand-edited test file carrying
 * `strategy: "dca"` over grid-shaped params, which reached `formatMoney` with
 * `undefined` and threw out of `roundDecimal` — taking the whole page to a blank
 * black screen with no visible error.
 *
 * `proposalFieldsOf` (`../proposalFields.ts`) now runs the check FIRST and returns
 * the field list only when it passes, so this component cannot render a field for a
 * params object that failed. A mismatch renders the same kind of red warning
 * `ProposalStrategy` already renders for a Stage 2 / Stage 3 strategy disagreement.
 * That is not a coincidence of styling: both are the same category of fault —
 * PASTED INPUT WHOSE PARTS DO NOT AGREE — and this page's input is pasted by design
 * (decision log 44).
 *
 * The field lists come from the BACKEND (`src/research/proposal-shape.ts`) rather
 * than being re-typed, so they cannot drift from the ones a response is actually
 * built from, and the decision lives in a React-free module so it is TESTED rather
 * than eye-verified — a mutation run found the inline version's call site
 * unreachable by any test. This component is now presentational.
 */

import type { DeriveResult, EvidenceItem, ValidatedProposal } from "../api/research-types";
import type { ParamsShapeCheck } from "../../../src/research/proposal-shape";
import { proposalFieldsOf, type FieldSpec } from "../proposalFields";
import { formatMoney } from "../format";
import { CitationList } from "./ProposalCitations";

const MINIMUM_ORDER_COPY: Readonly<Record<ValidatedProposal["minimumOrderCheck"], string>> = {
  notional:
    "The venue publishes a NOTIONAL floor and the proposed order sizes clear it.",
  quantity:
    "The venue publishes a QUANTITY floor and the implied quantities clear it.",
  both: "The venue publishes both floors and both were checked.",
  none_published:
    "The venue publishes NEITHER floor, so nothing was checked. That is honest, not a pass — no minimum-order guarantee stands behind these sizes.",
};

function FieldBlock({
  spec,
  citations,
}: {
  spec: FieldSpec;
  citations: readonly EvidenceItem[] | undefined;
}) {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 px-4 py-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <div>
          <div className="text-xs uppercase tracking-wide text-zinc-500">{spec.label}</div>
          {spec.hint !== null && <div className="text-[11px] text-zinc-600">{spec.hint}</div>}
        </div>
        <div className="tabular text-lg font-semibold text-zinc-100">{spec.value}</div>
      </div>
      <div className="mt-3 border-t border-zinc-800 pt-3">
        {citations === undefined ? (
          <div className="text-xs text-amber-300">
            No citations arrived for <code>{spec.field}</code>. The backend requires one per field,
            so treat this as a fault in the response.
          </div>
        ) : (
          <CitationList citations={citations} />
        )}
      </div>
    </div>
  );
}

/**
 * The mismatch banner. Same visual language as `ProposalStrategy`'s
 * strategy-disagreement warning — `role="alert"`, red, "do not act on this" —
 * because it is the same category of fault and a reviewer should recognise it as
 * one rather than learning a second convention.
 *
 * The field lists are printed in full. "9 fields are missing" is the kind of
 * summary that makes a reader go and diff two documents by hand; naming them means
 * the edit that caused it is visible from this block alone.
 */
function ParamsShapeWarning({ check }: { check: Extract<ParamsShapeCheck, { ok: false }> }) {
  return (
    <div
      role="alert"
      className="rounded-lg border border-red-500/50 bg-red-500/10 px-4 py-4 text-sm text-red-100"
    >
      <h4 className="font-semibold text-red-200">
        ⚠ This params object does not match its claimed strategy
      </h4>
      <p className="mt-2">{check.message}</p>

      <dl className="mt-3 space-y-1.5 border-t border-red-500/30 pt-3 text-xs">
        <div>
          <dt className="inline text-red-200/70">Claimed strategy: </dt>
          <dd className="inline font-mono text-red-100">{check.claimedStrategy}</dd>
        </div>
        {check.looksLike !== null && (
          <div>
            <dt className="inline text-red-200/70">Fields actually match: </dt>
            <dd className="inline font-mono text-red-100">{check.looksLike}</dd>
          </div>
        )}
        {check.missing.length > 0 && (
          <div>
            <dt className="inline text-red-200/70">
              Missing ({check.missing.length}):{" "}
            </dt>
            <dd className="inline font-mono text-red-100">{check.missing.join(", ")}</dd>
          </div>
        )}
        {check.unexpected.length > 0 && (
          <div>
            <dt className="inline text-red-200/70">
              Unrecognised ({check.unexpected.length}):{" "}
            </dt>
            <dd className="inline font-mono text-red-100">{check.unexpected.join(", ")}</dd>
          </div>
        )}
        <div>
          <dt className="inline text-red-200/70">Refusal code: </dt>
          <dd className="inline font-mono text-red-100">{check.code}</dd>
        </div>
      </dl>

      <p className="mt-3 text-xs text-red-100/70">
        No parameter fields are rendered above, deliberately: printing blanks for values that are
        not there is how a malformed document comes to look like a half-specified proposal. Nothing
        has been created or modified by viewing this.
      </p>
    </div>
  );
}

export function ProposalParameters({ derive }: { derive: DeriveResult }) {
  const { proposal } = derive;

  // ONE call, and the guard and the field list come back TOGETHER. The component
  // does not get to check the shape and then decide whether to honour it -- see
  // `proposalFields.ts` on the surviving mutant that made that separation necessary.
  const { shape, specs } = proposalFieldsOf(proposal.params);

  return (
    <section className="space-y-3">
      <h3 className="text-sm font-semibold uppercase tracking-wide text-zinc-400">
        Parameters, and why — every field the create-bot form requires
      </h3>

      {!shape.ok && <ParamsShapeWarning check={shape} />}

      <div className="rounded-lg border border-zinc-700 bg-zinc-900/60 px-4 py-3">
        <div className="grid gap-x-6 gap-y-3 sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <div className="text-xs uppercase tracking-wide text-zinc-500">Reference price</div>
            <div className="tabular text-sm text-zinc-100">
              {formatMoney(proposal.referencePrice)}
            </div>
            <div className="text-[11px] text-zinc-600">the price these numbers were sized against</div>
          </div>
          <div>
            <div className="text-xs uppercase tracking-wide text-zinc-500">
              Headroom at proposal
            </div>
            <div className="tabular text-sm text-zinc-100">
              {formatMoney(proposal.availableAtProposal)} {proposal.capitalAsset}
            </div>
            <div className="text-[11px] text-zinc-600">as read; may have changed since</div>
          </div>
          <div>
            <div className="text-xs uppercase tracking-wide text-zinc-500">Minimum-order check</div>
            <div className="text-sm text-zinc-100">{proposal.minimumOrderCheck}</div>
            <div className="text-[11px] text-zinc-600">
              {/*
               * A fallback rather than a bare lookup. An unrecognised value renders
               * `undefined` as nothing, which would silently drop the sentence that
               * says whether a floor was checked at all — and `none_published` being
               * honest rather than a pass is the whole point of that sentence.
               */}
              {MINIMUM_ORDER_COPY[proposal.minimumOrderCheck] ??
                `Unrecognised minimum-order check value. Nothing here can say which venue floor, if any, was applied.`}
            </div>
          </div>
          <div>
            <div className="text-xs uppercase tracking-wide text-zinc-500">Strategy</div>
            {/*
             * The CHECKED value, never `proposal.params.strategy` read raw. A pasted
             * document can carry anything there, and React throws "Objects are not
             * valid as a React child" on a non-primitive — another route to the blank
             * page. `claimedStrategy` is already rendered for display.
             */}
            <div className="text-sm uppercase text-zinc-100">
              {shape.ok ? shape.strategy : shape.claimedStrategy}
            </div>
            <div className="text-[11px] text-zinc-600">
              {shape.ok
                ? "validated by the real create-bot decoders"
                : "as claimed by this document — see the warning above"}
            </div>
          </div>
        </div>
      </div>

      {/*
       * Capital first, and separated from the strategy fields, because it is the
       * one number on this page denominated in real money the account holds and
       * the one most easily read as a commitment. It is not one.
       */}
      <div className="grid gap-3 lg:grid-cols-2">
        <FieldBlock
          spec={{
            field: "allocatedCapital",
            label: "Allocated capital (suggested)",
            value: `${formatMoney(proposal.allocatedCapital)} ${proposal.capitalAsset}`,
            hint: "a PREFILL a human confirms — nothing is allocated, and the real check runs against the ledger at creation",
          }}
          citations={proposal.allocatedCapitalCitations}
        />
        <FieldBlock
          spec={{
            field: "capitalAsset",
            label: "Capital asset",
            value: proposal.capitalAsset,
            hint: "order sizes and capital are denominated in this",
          }}
          citations={proposal.capitalAssetCitations}
        />
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        {specs.map((spec) => (
          <FieldBlock key={spec.field} spec={spec} citations={proposal.citations[spec.field]} />
        ))}
      </div>

      {derive.notes.length > 0 && (
        <div className="space-y-3">
          <h4 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
            Stage 3&rsquo;s notes on the set as a whole
          </h4>
          <ol className="space-y-3">
            {derive.notes.map((note, index) => (
              <li key={index} className="rounded-lg border border-zinc-800 bg-zinc-900/40 px-4 py-3">
                <div className="flex gap-3">
                  <span className="tabular shrink-0 text-xs text-zinc-600">{index + 1}.</span>
                  <p className="min-w-0 text-sm text-zinc-200">{note.statement}</p>
                </div>
                <div className="mt-3 pl-6">
                  <CitationList citations={note.citations} />
                </div>
              </li>
            ))}
          </ol>
        </div>
      )}
    </section>
  );
}
