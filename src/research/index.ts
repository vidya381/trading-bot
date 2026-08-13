/**
 * Groundwork for spec section 21's LLM-assisted research pipeline.
 *
 * ⚠ THE FOLDER'S OLD BANNER IS RETIRED HERE. Section 21 was "PLANNED, NOT YET
 * BUILT" through step 36; it is not any more. There IS a Workers AI binding, there
 * ARE two live model-calling endpoints (steps 40, 42), Stage 4's rendering exists
 * (step 44), and 21.5 REQUIREMENT 5'S PERMANENT PROPOSAL RECORD NOW EXISTS --
 * `proposal-log.ts` over migration 0009's `proposals` table, written automatically
 * on every real `/assess` and `/derive` call, with the full inputs, the full prompt
 * and the raw model response, retained indefinitely per section 8.7.
 *
 * ⚠ SOME MODULE HEADERS IN THIS FOLDER STILL CARRY THE OLD BANNER, and they were
 * already stale before this step (they say "no Assess stage", which stopped being
 * true at step 37). They are not swept here; read them as "as of the step that
 * wrote them", and read THIS file and the README as current.
 *
 * What still does NOT exist: no trending vendor, so `entryPoint=general` 503s
 * (steps 30, 31); no news vendor, so every bundle's news slot is
 * `not_yet_available`; no batch or watchlist entry point to either model stage; no
 * scheduled or reactive trigger (21.6); and no record of a FAILED run, so the
 * refusal rate is not measurable from the proposal table (see `proposal-log.ts`).
 *
 * What exists is the
 * storage for 21.3's fixed watchlist -- the deliberate, human-chosen half of
 * candidate selection -- the read path a later stage will consume, 21.4 Stage
 * 1's candle fetch for arbitrary tradable pairs, 21.4 Stage 1's
 * news-and-sentiment fetch, and 21.2/21.3's candidate selection for both entry
 * points, 21.4 Stage 1's over-concentration FLAG, the assembly that collects
 * those inputs into one bundle per candidate, and -- new, and the reason the
 * banner above is now qualified -- 21.4 STAGE 2'S PROMPT AND ITS PARSER.
 *
 * Stage 3 (Derive) now exists on the same terms: `derive-prompt.ts` builds TWO
 * strategy-conditional prompts from the SAME evidence, grounding and
 * injection-defence machinery Stage 2 uses; `derive-parse.ts` reads a proposed
 * parameter set strictly and validates it through the REAL create-bot decoders
 * and the REAL strategy validators before adding only the checks neither of
 * those makes; and `derive.ts` holds the `DeriveModel` port -- also with NOTHING
 * BEHIND IT -- and a runner that calls a model exactly once and refuses four
 * ways before spending anything.
 *
 * ⚠ DERIVE CANNOT DETECT A BAD UPSTREAM JUDGEMENT. Decision log 40 found that
 * thin or frozen sandbox data produces a confident-LOOKING Assess judgement that
 * is financially meaningless; Derive would turn such a judgement into concrete
 * numbers that look equally plausible and pass every check here, because every
 * check answers "is this internally consistent and grounded?" and none answers
 * "was the input worth reasoning about?". Tracked, not solved -- see the README.
 *
 * Stage 2 exists as three pure pieces and an unimplemented port:
 * `assess-prompt.ts` turns a bundle into the exact text a model would receive,
 * `assess-parse.ts` reads a model's raw answer or refuses it fail-closed, and
 * `assess.ts` holds the `AssessModel` port, the determinism settings that would
 * be requested, and the runner that joins the two. NOTHING BEHIND THAT PORT
 * EXISTS -- it is abstract in exactly the way `TrendingSource` and `NewsSource`
 * are, and every test drives a stub that returns a string a human wrote.
 *
 * Two Stage 2 decisions worth knowing before reading the code. Third-party text
 * (a trending vendor's `name`/`symbol`/`coinId`, a watchlist `note`) is WRAPPED
 * IN DELIMITERS and labelled as data-not-instruction rather than removed, which
 * REDUCES injection risk without eliminating it -- see `UNTRUSTED_TEXT_TOKEN`
 * for the two structural limits that actually bound the damage. And there are
 * ZERO RETRIES: a parse refusal ends the run, because "retry until it parses"
 * is fail-closed converted into fail-open.
 *
 * The assembly (`gather.ts`) reads nothing new. It returns an HONEST PARTIAL
 * bundle: each input's real success or failure is recorded on its own slot, and
 * one input's failure never removes another's result. Whether a bundle is fit to
 * show a human is Stage 4's judgement and is NOT made here.
 *
 * The news slot in every bundle is `NEWS_NOT_YET_AVAILABLE` -- a deliberate
 * paused state, never a failed fetch. See decision log 30.
 *
 * The concentration check is a flag for a human, never a filter: it reads
 * `bot_instances` and states what an account already holds. Its two thresholds
 * are POLICY CHOICES verified against nothing -- see
 * `DEFAULT_CONCENTRATION_POLICY` before quoting either number.
 *
 * The news fetch's wire format is ASSUMED, not verified: nothing here has ever
 * called CoinDesk and this project holds no key for it. See `news.ts`'s header
 * before relying on any of it.
 *
 * The trending pull, 21.3's other source, has a PORT (`TrendingSource`) and no
 * vendor: no trending API has been chosen, no client exists, and nothing here
 * has ever called one. It also must never be added as a writer of the watchlist
 * table -- see `watchlist.ts`'s header for why that separation is structural
 * rather than stylistic, and `candidates.ts`'s for how the two sources are
 * merged at read time without losing which is which.
 */

export {
  selectGeneralCandidates,
  selectNamedCandidate,
  selectWatchlistCandidates,
  CandidateSelectionError,
  type Candidate,
  type CandidateEntryPoint,
  type CandidateSelectionErrorCode,
  type CandidateSet,
  type CandidateSource,
  type GeneralCandidatePorts,
  type NamedCandidatePorts,
  type NamedCandidateSource,
  type SelectGeneralCandidatesRequest,
  type SelectNamedCandidateRequest,
  type SelectWatchlistCandidatesRequest,
  type WatchlistCandidatePorts,
  type TrendingCandidateSource,
  type TrendingCoin,
  type TrendingPull,
  type TrendingPullReport,
  type TrendingRejection,
  type TrendingRejectionReason,
  type TrendingSource,
  type WatchlistCandidateSource,
  type WatchlistReadReport,
} from "./candidates";

export {
  assessCandidateSetConcentration,
  assessConcentration,
  checkCandidateConcentration,
  readAccountExposure,
  ConcentrationError,
  DEFAULT_CONCENTRATION_POLICY,
  type AccountExposure,
  type AssessConcentrationOptions,
  type AssetConcentrationFacts,
  type AssetSignalBasis,
  type BaseAssetResolution,
  type CandidateSetConcentration,
  type ConcentrationErrorCode,
  type ConcentrationFacts,
  type ConcentrationFlag,
  type ConcentrationFlagCode,
  type ConcentrationPolicy,
  type ConcentrationPorts,
  type ConcentrationResult,
  type ExposureBot,
  type PairHolding,
} from "./concentration";

export {
  gatherCandidateData,
  gatherCandidateSetData,
  gatherDeriveContext,
  SymbolFiltersUnavailableError,
  NEWS_NOT_YET_AVAILABLE,
  type CandidateGatherBundle,
  type CandidateSetGatherBundle,
  type CandleInput,
  type CapitalInput,
  type ConcentrationInput,
  type DeriveContext,
  type DeriveContextPorts,
  type ExposureInput,
  type GatherPorts,
  type GatherRequest,
  type GatheredInput,
  type NewsInput,
  type NewsNotYetAvailable,
  type SymbolFiltersInput,
} from "./gather";

export {
  ASSESS_PROMPT_VERSION,
  ASSESS_STRATEGIES,
  CANDLE_BUCKET_COUNT,
  SHARED_GROUNDING_RULES,
  UNTRUSTED_TEXT_TOKEN,
  EvidenceCollector,
  bucketCandles,
  buildAssessPrompt,
  collectBundleEvidence,
  numberedRules,
  wrapUntrusted,
  type AssessPrompt,
  type CandleBucket,
  type EvidenceItem,
} from "./assess-prompt";

export {
  ASSESS_RESPONSE_SCHEMA,
  AssessParseError,
  findDuplicateKey,
  parseAssessResponse,
  readModelAnswer,
  requireExactFields,
  resolveCitations,
  unwrapModelEnvelope,
  type AssessEnvelopeShape,
  type AssessParseErrorCode,
  type CitedClaim,
  type DuplicateKeyCheck,
  type ModelAnswer,
  type ParseRefusal,
  type ParsedAssessment,
  type SharedParseCode,
  type UnwrappedAnswer,
} from "./assess-parse";

export {
  AssessResubmitError,
  RESUBMITTED_ASSESSMENT_FIELDS,
  assessEvidenceOf,
  parseResubmittedAssessment,
  type AssessResubmitErrorCode,
} from "./assess-resubmit";

export {
  ASSESS_MODEL,
  ASSESS_MODEL_CONTEXT_TOKENS,
  ASSESS_MODEL_SETTINGS,
  AssessError,
  assessCandidate,
  type AssessErrorCode,
  type AssessModel,
  type AssessModelRequest,
  type AssessModelResponse,
  type AssessModelSettings,
  type AssessResult,
} from "./assess";

export {
  readAccountCapital,
  headroomFor,
  hasAnyHeadroom,
  ResearchCapitalError,
  type AccountCapital,
  type AssetHeadroom,
  type ResearchCapitalErrorCode,
} from "./capital";

export {
  DCA_DERIVE_FIELDS,
  DERIVE_CAPITAL_FIELDS,
  DERIVE_PROMPT_VERSION,
  GRID_DERIVE_FIELDS,
  buildDerivePrompt,
  deriveFieldsFor,
  type DerivePrompt,
} from "./derive-prompt";

export {
  DeriveParseError,
  DeriveValidationError,
  checkDeriveSanityBounds,
  deriveResponseSchema,
  parseDeriveResponse,
  plannedSpendOf,
  validateProposal,
  type CitedValue,
  type DeriveParseErrorCode,
  type DeriveValidationErrorCode,
  type MinimumOrderCheck,
  type ParsedProposal,
  type ValidatedProposal,
} from "./derive-parse";

export {
  DERIVE_MODEL,
  DERIVE_MODEL_CONTEXT_TOKENS,
  DERIVE_MODEL_SETTINGS,
  DeriveError,
  deriveParameters,
  type DeriveErrorCode,
  type DeriveModel,
  type DeriveModelRequest,
  type DeriveModelResponse,
  type DeriveModelSettings,
  type DeriveResult,
} from "./derive";

export {
  ProposalLogError,
  checkProposalCanTakeOutcome,
  logAssessProposal,
  logDeriveProposal,
  proposalRecordOf,
  recordProposalApproval,
  rejectProposal,
  type LogProposalRequest,
  type ProposalLogErrorCode,
  type ProposalLogPorts,
  type ProposalPayload,
  type ProposalRecord,
  type RejectProposalRequest,
} from "./proposal-log";

export {
  DCA_PROPOSAL_FIELDS,
  GRID_PROPOSAL_FIELDS,
  PROPOSAL_STRATEGIES,
  checkParamsShape,
  isProposalStrategy,
  proposalFieldsFor,
  type ParamsShapeCheck,
  type ParamsShapeErrorCode,
  type ProposalStrategy,
} from "./proposal-shape";

export {
  DEFAULT_STALENESS_POLICY,
  priceThresholdFor,
  stalenessOf,
  verdictFor,
  worstVerdict,
  type InputStaleness,
  type ProposalStaleness,
  type StalenessInput,
  type StalenessPolicy,
  type StalenessStrategy,
  type StalenessVerdict,
} from "./staleness";

export {
  fetchCandleWindow,
  CandleWindowError,
  type CandleSource,
  type CandleWindow,
  type CandleWindowErrorCode,
  type CandleWindowPorts,
  type FetchCandleWindowRequest,
} from "./candles";

export {
  fetchNewsSentiment,
  NewsSentimentError,
  COINDESK_WIRE_FIELDS,
  DEFAULT_ARTICLE_LIMIT,
  MAX_ARTICLES,
  type CoveredNewsSentiment,
  type FetchNewsSentimentRequest,
  type NewsArticle,
  type NewsSentimentErrorCode,
  type NewsSentimentPorts,
  type NewsSentimentResult,
  type NewsSource,
  type QuietNewsSentiment,
  type SentimentCounts,
  type SentimentLabel,
  type UncoveredNewsSentiment,
} from "./news";

export {
  checkTradable,
  checkSpotInstrument,
  type DerivativeNamePolicy,
  type InstrumentRefusal,
  type InstrumentRefusalCode,
  type SymbolDetailSource,
  type TradabilityRefusal,
  type TradabilityRefusalCode,
  type VenueAccount,
} from "./tradability";

export {
  addToWatchlist,
  readWatchlist,
  removeFromWatchlist,
  watchlistSize,
  WatchlistError,
  WATCHLIST_MAX_ENTRIES,
  type AddToWatchlistRequest,
  type RemoveFromWatchlistRequest,
  type TradablePairSource,
  type WatchlistAccount,
  type WatchlistEntry,
  type WatchlistErrorCode,
  type WatchlistPorts,
} from "./watchlist";
