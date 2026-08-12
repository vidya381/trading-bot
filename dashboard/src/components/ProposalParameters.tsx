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
 */

import type { DeriveResult, EvidenceItem, ValidatedProposal } from "../api/research-types";
import { formatMoney, formatPercent } from "../format";
import { CitationList } from "./ProposalCitations";

/** One field's rendered value, its hint, and the citations behind it. */
interface FieldSpec {
  readonly field: string;
  readonly label: string;
  readonly value: string;
  readonly hint: string | null;
}

const NOT_SET = "Not set";

function money(value: string | null): string {
  return value === null ? NOT_SET : formatMoney(value);
}

function percent(value: string | null): string {
  return value === null ? NOT_SET : formatPercent(value);
}

function flag(value: boolean): string {
  return value ? "Enabled" : "Disabled";
}

function fieldsFor(params: ValidatedProposal["params"]): readonly FieldSpec[] {
  if (params.strategy === "grid") {
    return [
      { field: "lowerBound", label: "Lower bound", value: money(params.lowerBound), hint: null },
      { field: "upperBound", label: "Upper bound", value: money(params.upperBound), hint: null },
      {
        field: "gridLines",
        label: "Grid lines",
        value: String(params.gridLines),
        hint: "including both bounds",
      },
      { field: "spacing", label: "Spacing", value: params.spacing, hint: null },
      {
        field: "orderSize",
        label: "Order size per line",
        value: money(params.orderSize),
        hint: null,
      },
      { field: "stopLossPct", label: "Stop-loss", value: percent(params.stopLossPct), hint: null },
      {
        field: "takeProfitAmount",
        label: "Take-profit amount",
        value: money(params.takeProfitAmount),
        hint: "close the whole grid at this realized profit",
      },
      {
        field: "breakoutTakeProfit",
        label: "Breakout take-profit",
        value: flag(params.breakoutTakeProfit),
        hint: "cash out on an upside breakout",
      },
      {
        field: "breakoutThresholdPct",
        label: "Breakout threshold",
        value: percent(params.breakoutThresholdPct),
        hint: "above the upper bound",
      },
    ];
  }
  return [
    {
      field: "baseOrderSize",
      label: "Base order size",
      value: money(params.baseOrderSize),
      hint: null,
    },
    {
      field: "additionalOrderSize",
      label: "Additional order size",
      value: money(params.additionalOrderSize),
      hint: null,
    },
    {
      field: "stepMultiplier",
      label: "Step multiplier",
      value: params.stepMultiplier,
      hint: "compounds each additional buy",
    },
    {
      field: "dropPct",
      label: "Drop per buy",
      value: percent(params.dropPct),
      hint: "from the last entry price",
    },
    {
      field: "maxAdditionalBuys",
      label: "Max additional buys",
      value: String(params.maxAdditionalBuys),
      hint: "excludes the base order",
    },
    {
      field: "takeProfitPct",
      label: "Take-profit",
      value: percent(params.takeProfitPct),
      hint: "above average entry",
    },
    {
      field: "stopLossPct",
      label: "Stop-loss",
      value: percent(params.stopLossPct),
      hint: "below average entry",
    },
    {
      field: "autoRestart",
      label: "Auto-restart",
      value: flag(params.autoRestart),
      hint: "new cycle after a take-profit",
    },
    {
      field: "sellOnStopLoss",
      label: "Sell on stop-loss",
      value: flag(params.sellOnStopLoss),
      hint: "a stop-loss halts and holds the position",
    },
  ];
}

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

export function ProposalParameters({ derive }: { derive: DeriveResult }) {
  const { proposal } = derive;
  const specs = fieldsFor(proposal.params);

  return (
    <section className="space-y-3">
      <h3 className="text-sm font-semibold uppercase tracking-wide text-zinc-400">
        Parameters, and why — every field the create-bot form requires
      </h3>

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
              {MINIMUM_ORDER_COPY[proposal.minimumOrderCheck]}
            </div>
          </div>
          <div>
            <div className="text-xs uppercase tracking-wide text-zinc-500">Strategy</div>
            <div className="text-sm uppercase text-zinc-100">{proposal.params.strategy}</div>
            <div className="text-[11px] text-zinc-600">
              validated by the real create-bot decoders
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
