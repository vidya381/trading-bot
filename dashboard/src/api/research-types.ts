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
 * ⚠ NOTHING IN THIS FILE IS FETCHED BY THE DASHBOARD TODAY. There is no
 * `fetchAssess`/`fetchDerive` in `api/client.ts`, on purpose: both endpoints are
 * curl-only (decision log 42, "no dashboard control"), each `/derive` call costs
 * a real paid inference, and putting a button on one is a TRIGGER decision
 * (spec 21.6) rather than the RENDERING decision this stage is. These types
 * exist so the renderer is typed against the real wire shape rather than `any`.
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

export type Strategy = "dca" | "grid";

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

/** Which minimum-order floor the venue actually published for this pair. */
export type MinimumOrderCheck = "notional" | "quantity" | "both" | "none_published";

export interface ValidatedProposal {
  readonly params: GridParams | DcaParams;
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
   * The bundle THIS request gathered -- a second, independent gather, not a
   * replay of the one `/assess` used. It is the newer of the two and is the one
   * the proposal view treats as current.
   */
  readonly bundle: CandidateGatherBundle;
  readonly context: DeriveContext;
  readonly assessment: ResubmittedAssessment;
  readonly derive: DeriveResult;
}
