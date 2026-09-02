/**
 * The shapes `GET /api/accounts/:label/assess` and `GET /api/accounts/:label/derive`
 * return (spec 21.4 stages 2 and 3), mirrored from the backend's
 * `src/api/serialize.ts`.
 *
 * Kept OUT of `api/types.ts` deliberately. That file mirrors the bot/alert/
 * capital surface the dashboard has always read; this is the research pipeline,
 * a separate feature with its own endpoints, its own vocabulary (evidence,
 * citations, claims) and its own decision-log arc (entries 30-43). One file per
 * surface keeps a change to one from touching the other.
 *
 * The same two conventions `api/types.ts` fixes apply here unchanged:
 *   - Every money value is an exact DECIMAL STRING ("63757.71000000"), never a
 *     JS number. The backend's `jsonSafe` pass converts every `Money` bigint on
 *     the way out; nothing here parses one back into a float.
 *   - Every timestamp is epoch milliseconds as a number.
 *
 * ⚠ THESE ARE NOW FETCHED, AND THE PREVIOUS PARAGRAPH HERE SAID THEY NEVER WERE.
 * It read: "NOTHING IN THIS FILE IS FETCHED BY THE DASHBOARD TODAY. There is no
 * `fetchAssess`/`fetchDerive` in `api/client.ts`, on purpose..." That was true
 * through decision log 45 and is false now: `fetchAssess` and `fetchDerive` exist
 * in `api/client.ts`, and `pages/ProposalRun.tsx` calls them for the NAMED entry
 * point. The statement is corrected in place rather than deleted, because the
 * reasoning it carried still holds and is now a live constraint rather than an
 * argument for not building:
 *
 *   - Each run costs TWO real paid inferences and blocks for tens of seconds.
 *   - Each writes a permanent, undeletable proposal record (migration 0009).
 *   - Making the call was a TRIGGER decision (spec 21.6), taken deliberately and
 *     separately from the RENDERING decision entry 44 made.
 *
 * The rendering path is unchanged: a successful run hands the same two responses
 * to the same `ProposalView` a paste does. The paste page (`pages/Proposal.tsx`)
 * still exists and still makes no network request of any kind.
 *
 * ⚠ ONLY THE NAMED ENTRY POINT IS TRIGGERABLE. `entryPoint=general` still 503s
 * (no trending vendor -- entries 30, 31, 45), and the watchlist door has no
 * dashboard control either.
 */

// ---------------------------------------------------------------------------
// Evidence and citations -- the vocabulary both stages share
// ---------------------------------------------------------------------------

/**
 * One citable datum, exactly as the model was shown it (`evidenceItemView`).
 *
 * All four fields are load-bearing and none is decoration:
 *   - `id`     what a claim cites, and what `resolveCitations` validated.
 *   - `label`  what the model read beside the value.
 *   - `value`  the rendered datum, BYTE-IDENTICAL to what went into the prompt.
 *   - `source` the path into the gather bundle it came from.
 *
 * `source` is the field this dashboard's citation classification reads, and it
 * is the ONLY field that can answer "is this fetched data, an absence marker, or
 * an earlier stage's own claim?" -- see `src/citations.ts` and decision log 43.
 */
export interface EvidenceItem {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly source: string;
}

/** One claim or note, with its citations RESOLVED to whole items, not bare ids. */
export interface CitedClaim {
  readonly statement: string;
  readonly citations: readonly EvidenceItem[];
}

// ---------------------------------------------------------------------------
// Stage 1 -- the gathered bundle (`candidateGatherBundleView`)
// ---------------------------------------------------------------------------

/**
 * The three-armed outcome every gathered slot carries (`gatheredInputView`).
 *
 * NEVER collapsed to a boolean, and the renderer must not collapse it either:
 * "the venue refused for a reason it enumerated" (`failed`) and "something
 * beneath it broke" (`threw_unexpectedly`) are different facts, and both are
 * different from `ok`. `failedAt` rides on the failure arms only -- a slot that
 * succeeded has a real fetch time inside its own value.
 */
export type GatheredInput<T> =
  | { readonly outcome: "ok"; readonly value: T }
  | {
      readonly outcome: "failed";
      readonly error: { readonly code: string; readonly message: string };
      readonly failedAt: number;
    }
  | {
      readonly outcome: "threw_unexpectedly";
      readonly error: { readonly name: string; readonly message: string };
      readonly failedAt: number;
    };

export type CandidateSource =
  | {
      readonly kind: "named";
      readonly requestedAs: string;
      readonly requestedBy: string;
      readonly requestedAt: number;
    }
  | {
      readonly kind: "watchlist";
      readonly entryId: string;
      readonly note: string;
      readonly addedBy: string;
      readonly addedAt: number;
    }
  | {
      readonly kind: "trending";
      readonly pullId: string;
      readonly vendor: string;
      readonly fetchedAt: number;
      readonly coinId: string;
      readonly symbol: string;
      readonly name: string;
      readonly rank: number | null;
      readonly raw: unknown;
    };

export interface Candidate {
  readonly accountLabel: string;
  readonly exchange: string;
  readonly pair: string;
  /** Non-empty by construction on the backend. A coin on two lists has two. */
  readonly sources: readonly CandidateSource[];
}

export interface Candle {
  readonly openTime: number;
  readonly closeTime: number;
  readonly open: string;
  readonly high: string;
  readonly low: string;
  readonly close: string;
  readonly volume: string;
  readonly closed: boolean;
}

/**
 * A candle window and its honest account of how much history it really is.
 *
 * `truncated` and `missingHistoryMs` are the deterministic limited-history
 * signals spec 21.3 requires to be stated plainly, and they are FACTS from the
 * venue rather than model prose -- see `src/proposal.ts`.
 */
export interface CandleWindow {
  readonly accountLabel: string;
  readonly exchange: string;
  readonly pair: string;
  readonly interval: string;
  /** 21.5 requirement 4's fetch time: when the venue answered. */
  readonly fetchedAt: number;
  readonly requestedSince: number | null;
  readonly earliestOpenTime: number;
  readonly earliestCloseTime: number;
  readonly latestCloseTime: number;
  readonly truncated: boolean;
  readonly missingHistoryMs: number | null;
  readonly count: number;
  readonly candles: readonly Candle[];
}

/** The paused news slot (decision log 30). No error, no failedAt, no fetchedAt. */
export interface NewsInput {
  readonly outcome: string;
  readonly reason: string;
  readonly decisionLogEntry: string;
}

export interface ConcentrationFlag {
  readonly code: "same_pair_bot_count" | "asset_capital_share";
  readonly observed: string;
  readonly threshold: string;
  readonly statement: string;
  readonly basis: "base_asset" | "pair_only" | null;
  readonly capitalAsset: string | null;
}

/**
 * The over-concentration read (spec 21.4 stage 1's third input).
 *
 * A VARIANT, not a flag list with a boolean: `no_concentration` is a positive
 * statement that the check ran and found nothing, which is a different fact from
 * a `flags` array that happens to be empty. The renderer must keep those apart,
 * and must keep BOTH apart from the check having failed to run at all.
 *
 * Only the fields the proposal view actually shows are named; `ConcentrationFacts`
 * carries more (`pairsHeld`, `perAsset`, `policy`, the id lists) and travels in
 * the raw JSON for a reader who wants it.
 */
export type ConcentrationResult = {
  readonly accountLabel: string;
  readonly exchange: string;
  readonly pair: string;
  /** When the account's bot list was read. A real read time, not an assembly time. */
  readonly readAt: number;
  readonly rowsRead: number;
  readonly committedBots: number;
  readonly stoppedBots: number;
  readonly samePairBots: number;
  readonly samePairStoppedBots: number;
} & (
  | { readonly assessment: "no_concentration" }
  | { readonly assessment: "flagged"; readonly flags: readonly ConcentrationFlag[] }
);

export interface CandidateGatherBundle {
  readonly candidate: Candidate;
  readonly candles: GatheredInput<CandleWindow>;
  readonly news: NewsInput;
  readonly concentration: GatheredInput<ConcentrationResult>;
  /**
   * When assembly ran. ⚠ NOT a fetch time -- the real ones are
   * `candles.value.fetchedAt` and `concentration.value.readAt`. Timing staleness
   * from this field reads a render time as a data time (21.5 requirement 4).
   */
  readonly assembledAt: number;
}

// ---------------------------------------------------------------------------
// Stage 2 -- Assess (`assessResultView`)
// ---------------------------------------------------------------------------

/**
 * The strategies a proposal can be ABOUT, mirroring the Worker's `StrategyType`.
 *
 * ⚠ NOT THE SAME QUESTION AS "what can the create-bot form build". That is
 * `PrefillStrategy` (`../research/proposalPrefill.ts`), which is still the two
 * strategies `CreateBotRequest` has a params shape for. The two were aliased
 * while both had two members and diverged the moment `validatedProposalView`
 * learned to emit a trailing-stop params object.
 */
export type Strategy = "dca" | "grid" | "trailing_stop";

/** Whether the duplicate-key scan could run at all for a given answer. */
export type DuplicateKeyCheck = "performed" | "unavailable_transport_parsed";

export interface AssessResult {
  readonly strategy: Strategy;
  readonly claims: readonly CitedClaim[];
  /**
   * EVERYTHING the model was offered, not only what it cited. What the model
   * IGNORED is visible only from the difference between this and the citations
   * (21.5 requirement 2), which is why the renderer shows the difference rather
   * than only the cited subset.
   */
  readonly evidence: readonly EvidenceItem[];
  readonly promptVersion: string;
  readonly promptChars: number;
  readonly model: string;
  readonly settings: unknown;
  /** Which transport envelope the answer arrived in. */
  readonly envelope: string;
  readonly duplicateKeyCheck: DuplicateKeyCheck;
  readonly latencyMs: number;
}

/** The whole `GET /api/accounts/:label/assess` payload (the envelope's `data`). */
export interface AssessResponse {
  readonly entryPoint: "named";
  readonly selectedAt: number;
  /**
   * The permanent proposal record's id (spec 21.5 requirement 5, migration 0009).
   * Every real call writes a row; this names it.
   */
  readonly proposalId: string;
  readonly bundle: CandidateGatherBundle;
  readonly assess: AssessResult;
}

// ---------------------------------------------------------------------------
// Stage 3 -- Derive (`deriveResultView`)
// ---------------------------------------------------------------------------

export interface AssetHeadroom {
  readonly asset: string;
  readonly totalBalance: string;
  readonly totalAllocated: string;
  readonly available: string;
  readonly updatedAt: number;
}

export interface AccountCapital {
  readonly accountLabel: string;
  /** When the ledger was read. Stale from that instant on (`capital.ts`). */
  readonly readAt: number;
  readonly rowsRead: number;
  readonly assets: readonly AssetHeadroom[];
}

export interface SymbolFilters {
  readonly pair: string;
  readonly baseAsset: string;
  readonly quoteAsset: string;
  readonly status: string;
  readonly tickSize: string;
  readonly stepSize: string;
  readonly minQuantity: string;
  readonly minNotional: string;
  readonly fetchedAt: number;
}

/**
 * The filters slot, which cannot go through `gatheredInputView`: its error is a
 * plain `Error` (name + message), not a coded one, because `gather.ts` invents
 * no error vocabulary for a venue refusal it did not itself enumerate.
 */
export type SymbolFiltersInput =
  | { readonly outcome: "ok"; readonly value: SymbolFilters }
  | {
      readonly outcome: "failed" | "threw_unexpectedly";
      readonly error: { readonly name: string; readonly message: string };
      readonly failedAt: number;
    };

export interface DeriveContext {
  readonly capital: GatheredInput<AccountCapital>;
  readonly filters: SymbolFiltersInput;
  /** When Stage 3's extra reads ran. ⚠ Again NOT a fetch time. */
  readonly gatheredAt: number;
}

/**
 * The Stage 2 result the client resubmitted, echoed back with its provenance
 * stated (`resubmittedAssessmentView`).
 *
 * `source: "client_resubmitted"` is the point of this object. `/derive` takes
 * its assessment from an earlier, SEPARATE HTTP call that this system stores
 * nothing about, and `citationsReverified: true` says what was actually checked:
 * every citation resolved against the evidence THIS request gathered. The claims
 * below therefore carry the CURRENT `EvidenceItem` values, not the ones the
 * client sent -- a real ten-minute gap moved `candles.last_close` from 63775.31
 * to 63757.71 in the live run behind decision log 42.
 *
 * `unverifiedOriginalCall` describes the original model call, which this system
 * did not witness. Labelled, not published bare, so nothing reads a
 * client-asserted fact as an observed one.
 */
export interface ResubmittedAssessment {
  readonly source: "client_resubmitted";
  readonly citationsReverified: true;
  readonly strategy: Strategy;
  readonly claims: readonly CitedClaim[];
  readonly unverifiedOriginalCall: {
    readonly envelope: string;
    readonly duplicateKeyCheck: DuplicateKeyCheck;
  };
}

export interface GridParams {
  readonly strategy: "grid";
  readonly upperBound: string;
  readonly lowerBound: string;
  readonly gridLines: number;
  readonly spacing: "arithmetic" | "geometric";
  readonly orderSize: string;
  readonly stopLossPct: string;
  readonly breakoutTakeProfit: boolean;
  readonly breakoutThresholdPct: string | null;
  readonly takeProfitAmount: string | null;
}

export interface DcaParams {
  readonly strategy: "dca";
  readonly baseOrderSize: string;
  readonly additionalOrderSize: string;
  readonly stepMultiplier: string;
  readonly dropPct: string;
  readonly maxAdditionalBuys: number;
  readonly takeProfitPct: string;
  readonly stopLossPct: string;
  readonly autoRestart: boolean;
  readonly sellOnStopLoss: boolean;
}

/**
 * Section 22's proposed trailing-stop parameters, mirroring
 * `ProposalParamsView`'s third arm in `src/api/serialize.ts`.
 *
 * ONE FIELD, and that is the entire set (22.2 decision 1): `trailPct` is both the
 * trail distance below the high-water mark and the initial stop distance from
 * entry. There is no order size -- the single entry is sized by
 * `allocatedCapital`, which `ValidatedProposal` already carries beside `params`.
 *
 * ⚠ THE ARM WHOSE ABSENCE WAS THE POINT. `validatedProposalView` read nine DCA
 * fields off this shape for as long as its own `else` branch stood, and this
 * mirror could not have caught that -- it did not know the shape existed.
 */
export interface TrailingStopParams {
  readonly strategy: "trailing_stop";
  readonly trailPct: string;
}

/** Which minimum-order floor the venue actually published for this pair. */
export type MinimumOrderCheck = "notional" | "quantity" | "both" | "none_published";

export interface ValidatedProposal {
  readonly params: GridParams | DcaParams | TrailingStopParams;
  readonly allocatedCapital: string;
  readonly capitalAsset: string;
  /** The headroom AS READ. A PREFILL a human confirms, never a reservation. */
  readonly availableAtProposal: string;
  readonly referencePrice: string;
  /** `none_published` is honest, not a pass. */
  readonly minimumOrderCheck: MinimumOrderCheck;
  /** Keyed by the exact strategy field name; each holds whole `EvidenceItem`s. */
  readonly citations: Readonly<Record<string, readonly EvidenceItem[]>>;
  readonly allocatedCapitalCitations: readonly EvidenceItem[];
  readonly capitalAssetCitations: readonly EvidenceItem[];
}

export interface DeriveResult {
  readonly strategy: Strategy;
  readonly proposal: ValidatedProposal;
  readonly notes: readonly CitedClaim[];
  /** Everything Stage 3 was offered, cited or not. See `AssessResult.evidence`. */
  readonly evidence: readonly EvidenceItem[];
  readonly promptVersion: string;
  readonly promptChars: number;
  readonly model: string;
  readonly settings: unknown;
  readonly envelope: string;
  readonly duplicateKeyCheck: DuplicateKeyCheck;
  readonly latencyMs: number;
}

/** The whole `GET /api/accounts/:label/derive` payload (the envelope's `data`). */
export interface DeriveResponse {
  readonly entryPoint: "named";
  readonly selectedAt: number;
  /**
   * The permanent proposal record's id (spec 21.5 requirement 5, migration 0009).
   *
   * THIS is the id a human hands to `POST /api/bots` as its optional `proposalId`
   * to record that this proposal became a real bot -- the only thing that will ever
   * connect a bot back to the reasoning behind it. It is a record, never an input:
   * nothing is read out of the proposal to build the bot (21.1).
   */
  readonly proposalId: string;
  /**
   * The bundle THIS request gathered -- a second, independent gather, not a
   * replay of the one `/assess` used. It is the newer of the two and is the one
   * the proposal view treats as current.
   */
  readonly bundle: CandidateGatherBundle;
  readonly context: DeriveContext;
  readonly assessment: ResubmittedAssessment;
  readonly derive: DeriveResult;
}

// ---------------------------------------------------------------------------
// Spec 21.5 requirement 5 -- the permanent record, READ
// ---------------------------------------------------------------------------

/**
 * ⚠ THESE TWO ENDPOINTS ARE FREE, UNLIKE EVERYTHING ABOVE THEM IN THIS FILE.
 *
 * `/assess` and `/derive` each cost a real paid inference and each WRITE a
 * permanent row. `GET /api/proposals` and `GET /api/proposals/:id` call no model,
 * touch no venue and write nothing at all -- they read rows that already exist.
 * The distinction is worth stating here because the two surfaces now share a file
 * and a reader skimming it should not have to work out which is which.
 *
 * They close what decision logs 46, 48 and 49 each carried forward, in entry 46's
 * words: *"it reads like a missing feature and is actually a missing READ."*
 */

/** `assess` | `derive` -- which pipeline stage wrote the row (migration 0009). */
export type ProposalStage = "assess" | "derive";

/**
 * The two outcomes a human decision can take.
 *
 * ⚠ THERE IS DELIBERATELY NO `"ignored"`. Spec 21.5 names three outcomes and this
 * system stores two, because "ignored" is an ABSENCE and nothing observes a human
 * failing to act. A record with `outcome: null` IS 21.5's "ignored", read after the
 * fact -- see `ProposalOutcomeFilter` below for how it is asked for.
 */
export type ProposalOutcome = "approved" | "rejected";

/**
 * One proposal record, without its two large payloads.
 *
 * The SAME shape both endpoints publish: a list row and a single record's summary
 * are the same fact seen from two places, and the backend builds both through one
 * `proposalSummaryView` so `pendingMs` cannot mean one thing in a table and another
 * on a detail page.
 */
export interface ProposalRecordSummary {
  readonly id: string;
  readonly stage: ProposalStage;
  readonly accountLabel: string;
  readonly pair: string;
  readonly entryPoint: "named" | "watchlist" | "general";
  readonly strategy: Strategy;
  /** The email VERIFIED off the Access token when the proposal was generated. */
  readonly actor: string;
  readonly model: string;
  readonly promptVersion: string;
  /** 21.5 requirement 4: when the price window was FETCHED, not when this rendered. */
  readonly dataFetchedAt: number;
  readonly createdAt: number;
  /** `null` is 21.5's "ignored", read after the fact. Nothing ever writes that word. */
  readonly outcome: ProposalOutcome | null;
  readonly outcomeBotInstanceId: string | null;
  readonly outcomeActor: string | null;
  readonly outcomeAt: number | null;
  readonly outcomeNote: string | null;
  /**
   * How long the proposal sat before anyone decided, or `null` while it is still
   * sitting -- "how long it sat" is not a finished quantity while it is still
   * sitting. Decision log 45 measured a real one at 28,013,070 ms (7h 46m).
   */
  readonly pendingMs: number | null;
}

/**
 * How faithful a rebuilt proposal is, published as data rather than left to infer.
 *
 * ⚠ `exact` IS TRUE FOR EVERY ROW THIS PIPELINE HAS EVER WRITTEN, and that is a
 * traced finding rather than a hope: the handler stores the very object it puts on
 * the wire, so `envelope`, `duplicateKeyCheck`, `settings`, `latencyMs`,
 * `promptChars` and `promptVersion` are all in the stored reasoning -- they were
 * never wire-only. See `src/api/proposal-replay.ts` for the trace.
 */
export interface ProposalReplayFidelity {
  readonly exact: boolean;
  /** Fields the row carries that the CURRENT wire shape does not declare. */
  readonly unexpectedStageFields: readonly string[];
  /**
   * ⚠ ALWAYS TRUE FOR A DERIVE RECORD. Nothing links a derive row to the assess
   * row it derives from (migration 0009 records that as a decision), so Stage 2's
   * own evidence table and the two-gather drift comparison cannot be rendered.
   * `ProposalView` already supports that state -- `assess={null}` is what a
   * reviewer holding only the derive response has always seen.
   */
  readonly assessResponseUnavailable: boolean;
  /**
   * ⚠ FALSE FOR AN ASSESS RECORD, and that is structural rather than a storage
   * gap: `ProposalView` is built around a derivation's parameters, allocated
   * capital and reference price, and an assessment has none of those. Its payload
   * is rebuilt exactly; what cannot be reused is the renderer.
   */
  readonly renderableByProposalView: boolean;
}

/** What the record holds and no live response ever carried. */
export interface ProposalRecordOnly {
  /** The full prompt, ~16 KB at Stage 2 and ~23 KB at Stage 3. */
  readonly promptText: unknown;
  /** The transport's own answer, `text` and `raw`, by identity. */
  readonly response: unknown;
}

/**
 * A stored proposal rebuilt into the response the live endpoint returned.
 *
 * ⚠ `response` IS TYPED AS THE REAL `AssessResponse` / `DeriveResponse`, and that
 * is the whole fidelity claim stated in this dashboard's own type system: a
 * historical record is handed to the unchanged `ProposalView`, not to a
 * history-shaped lookalike.
 */
export type ProposalReplay =
  | {
      readonly ok: true;
      readonly stage: "assess";
      readonly response: AssessResponse;
      readonly recordOnly: ProposalRecordOnly;
      readonly fidelity: ProposalReplayFidelity;
    }
  | {
      readonly ok: true;
      readonly stage: "derive";
      readonly response: DeriveResponse;
      readonly recordOnly: ProposalRecordOnly;
      readonly fidelity: ProposalReplayFidelity;
    }
  | {
      readonly ok: false;
      readonly code: string;
      readonly message: string;
      /** The exact field names, so the page never says "something is missing". */
      readonly fields: readonly string[];
    };

/** The whole `GET /api/proposals/:id` payload. */
export interface ProposalRecordResponse {
  readonly proposal: ProposalRecordSummary;
  /**
   * ⚠ A REFUSED REPLAY ARRIVES BESIDE A GOOD `proposal`, not instead of it. A row
   * whose payload cannot be rebuilt is a real finding about a permanent record, and
   * its id, actor, model, timestamps and outcome are all still true.
   */
  readonly replay: ProposalReplay;
}

/**
 * `pending` is the one filter value the column cannot hold: it means
 * `outcome IS NULL`, which is 21.5's "ignored" read after the fact and the reason
 * `idx_proposals_unresolved` exists. A history view that could filter to `approved`
 * and `rejected` but not to the rows in between would omit the one question the
 * table was built to answer.
 */
export type ProposalOutcomeFilter = ProposalOutcome | "pending";

/** The paging facts, computed by the backend so the page and the query agree. */
export interface ProposalPageInfo {
  readonly limit: number;
  readonly offset: number;
  /** Rows matching the filters across the WHOLE table, not just this page. */
  readonly total: number;
  readonly returned: number;
  readonly hasMore: boolean;
}

/** The whole `GET /api/proposals` payload. */
export interface ProposalListResponse {
  readonly proposals: readonly ProposalRecordSummary[];
  readonly page: ProposalPageInfo;
  /**
   * The filters ACTUALLY APPLIED, echoed by the backend. A page that renders its
   * own URL's filters is describing what it asked for; this describes what was
   * answered, which is the difference that shows up the day a parameter is dropped.
   */
  readonly filters: {
    readonly accountLabel: string | null;
    readonly stage: ProposalStage | null;
    readonly outcome: ProposalOutcomeFilter | null;
  };
}
