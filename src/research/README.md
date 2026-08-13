# `/src/research` — groundwork for section 21

> ⚠ **THE "PLANNED, NOT YET BUILT" BANNER IS RETIRED.** It held through step 36
> and is now false in every part: there is a real `ai` binding, two live
> model-calling endpoints (`GET /assess`, `GET /derive`, steps 40 and 42), a
> rendered human-facing proposal (step 44), and — as of the step this paragraph
> was written — **21.5 requirement 5's permanent proposal record**, written
> automatically on every real call to either endpoint and retained indefinitely
> per section 8.7. See *The proposal record* below.
>
> ⚠ Several module headers in this folder still carry the old banner. They were
> already stale before this step (they say "no Assess stage", untrue since step
> 37) and are **not** swept here — read them as "as of the step that wrote them",
> and read this README and `index.ts` as current.

**What still does not exist:** no trending vendor, so `entryPoint=general` 503s
(logs 30, 31); no news vendor, so every bundle's news slot is
`not_yet_available`; no batch or watchlist entry point to either model stage; no
scheduled or reactive trigger (21.6); and **no record of a FAILED run**, so the
refusal rate is not measurable from the proposal table.

What exists is the storage for **21.3's fixed watchlist**, **all three of 21.4
Stage 1's reads**, **candidate selection for 21.2's entry points and one deliberate third door**,
**the assembly that collects Stage 1's inputs into one bundle per candidate** —
which reads nothing new and consumes everything above it — **21.4 Stage 2's
prompt, its fail-closed parser, and the port a model would sit behind**, and now
**21.4 Stage 3's two strategy-conditional prompts, its strict parser, its
three-layer validation and a second empty port**.

> ### ⚠ Derive cannot detect a bad upstream judgement
>
> This is the single most important thing to know about Stage 3, and it is
> stated here rather than buried in a module header because it is invisible in
> the output.
>
> Decision log 40 recorded a live Assess run whose grid recommendation was
> **correctly grounded in real fetched candles and financially meaningless** —
> the Gemini sandbox those candles came from had sat at one price for 83 minutes
> and then roughly five hours, and a flat series reads as a tight, stable range,
> which is exactly the shape that makes "grid" look obviously right.
>
> **Derive, handed such a judgement, would faithfully turn it into concrete
> bounds, line counts and order sizes that look equally plausible** — fully
> cited, passing every decoder, every validator and every sanity bound, because
> it is doing its job correctly on the inputs it was given.
>
> Nothing in this folder can notice that. Every check Stage 3 performs answers
> *"is this parameter set internally consistent, grounded in the fetched data,
> and acceptable to the real create-bot validators?"*. **Not one of them answers
> *"was the fetched data worth reasoning about?"***, and none can look upstream.
> A well-grounded proposal derived from a meaningless assessment is
> indistinguishable, by every mechanism this stage has, from one derived from a
> good assessment.
>
> Derive can only be **well grounded in whatever judgement it is given**. The
> human in 21.1 is the only part of this pipeline that can tell the two apart.
> This is tracked, not solved.

| File | What it is |
| --- | --- |
| `watchlist.ts` | `addToWatchlist` / `removeFromWatchlist` / `readWatchlist`: the deliberate half of candidate selection, over `watchlist` (migration 0008) |
| `tradability.ts` | `checkTradable`: "will this account's venue trade this pair?", asked once and shared by every caller below, plus an **opt-in** naming heuristic for perpetuals; `checkSpotInstrument`: the structural "is it spot?" the order path uses |
| `candles.ts` | `fetchCandleWindow`: 21.4 Stage 1's candle fetch for **any** listed, tradable pair — no bot required — reporting how much history it actually got |
| `news.ts` | `fetchNewsSentiment`: 21.4 Stage 1's news and pre-scored sentiment for one asset, with 21.7 open question 2's coverage distinction built in. **Its wire format is assumed, not verified** — see below |
| `candidates.ts` | `selectNamedCandidate` / `selectWatchlistCandidates` / `selectGeneralCandidates`: three doors feeding one `CandidateSet`. **No trending vendor is chosen** — `TrendingSource` is an abstract port with no client behind it, so the general door cannot run at all today |
| `concentration.ts` | `readAccountExposure` + `assessConcentration`: 21.4 Stage 1's third read — what the account already holds on a candidate's pair and asset. **A flag for a human, never a filter**, and its two thresholds are **policy choices verified against nothing** |
| `gather.ts` | `gatherCandidateData` / `gatherCandidateSetData`: Stage 1's four inputs collected into one bundle per candidate. **No read of its own.** Returns an **honest partial** bundle — one input's failure never removes another's result — and carries the **paused** news slot. Plus `gatherDeriveContext`: Stage 3's **two extra real reads**, deliberately separate |
| `capital.ts` | `readAccountCapital`: the account's real `capital_ledger` headroom (section 8.5). **A read only** — no reservation, no write, no `total_allocated` touched. The figure it returns is a **prefill**, stale by construction from the instant it is read |
| `derive-prompt.ts` | `buildDerivePrompt`: **two** deterministic prompt builders, one per strategy, from the **same** evidence, grounding and injection-defence machinery as Stage 2. Never a universal schema with optional fields |
| `derive-parse.ts` | `parseDeriveResponse` + `validateProposal`: the strict reader and the **three-layer** validation — the real decoders, the real strategy validators, then only what neither of those checks. Any failure refuses the **whole** proposal |
| `derive.ts` | The `DeriveModel` **port with nothing behind it**, the per-strategy determinism settings, `DeriveResult`, and `deriveParameters` — which catches nothing, calls the model **once**, and refuses four ways **before** spending an inference |
| `assess-prompt.ts` | `buildAssessPrompt`: the **deterministic, pure** transformation from a bundle to the exact prompt text plus a table of citable `EvidenceItem`s. Every outcome state produces text; a failed input produces **more** text, never silence |
| `assess-parse.ts` | `parseAssessResponse`: the **strict, fail-closed** reader. Resolves exactly `"dca"` or `"grid"` with cited claims, or throws. No case folding, no fence stripping, no JSON-from-prose extraction, no default |
| `assess.ts` | The `AssessModel` **port with nothing behind it**, the determinism settings that would be requested, `AssessResult`, and `assessCandidate` — which catches nothing and refuses a bundle with no price history **before** any model call |

## Stage 1 assembly is collection, not judgement

`gather.ts` adds no read. It calls `fetchCandleWindow` and
`readAccountExposure`/`assessConcentration`, carries the `Candidate` verbatim,
and puts the paused news state in the fourth slot.

**A bundle always comes back.** Each input's real state is recorded on its own
slot, and deciding whether the result is fit to show a human is **Stage 4's job**
(21.4, "Explain and assemble"), which does not exist yet.

That is not a weakening of 21.5 requirement 6, and the distinction is the whole
design:

- **Within** an input, fail-closed is untouched. `fetchCandleWindow` still throws
  six ways rather than returning a short window; `readAccountExposure` still
  throws rather than reporting "no concentration" for a read it could not do.
  Nothing in assembly catches those and substitutes a value.
- **Between** inputs, a failure is **recorded, not propagated**. A failed candle
  fetch puts the real `CandleWindowError` — with its real code — in the candles
  slot and leaves every other slot alone.

The failure a whole-bundle throw would cause is specific: one unreachable venue
would erase a concentration flag that was read successfully from D1 and is
exactly what 21.4 wants "presented prominently". Losing a real risk signal
because an unrelated fetch failed is not failing closed; it is failing closed on
the wrong thing.

### It composes the existing types and invents no error vocabulary

`GatheredInput<T, E>` has three states and no taxonomy of its own. The `failed`
arm carries **the producing module's own error object** — a real
`CandleWindowError`, a real `ConcentrationError` — so `error.code` reads exactly
as it would for a direct caller. A second vocabulary restating
`candles_unavailable` as some flatter `fetch_failed` would drift from the first.

The third state, `threw_unexpectedly`, exists because it is **reachable**:
`fetchCandleWindow` does not wrap its ports, so a `Database` or `CandleSource`
that throws raw produces something that is not a `CandleWindowError`. Folding it
into `failed` would mean typing `error` as `CandleWindowError` while sometimes
holding a D1 exception.

`readAccountExposure` catches broadly and normalises, so **concentration has no
reachable `threw_unexpectedly` today**. A test pins that, so a change removing
that catch shows up there rather than in a proposal.

### The news slot is a state, not a TODO

Every bundle carries `NEWS_NOT_YET_AVAILABLE`, a frozen shared value in the same
discriminant position every other input's state lives in. It has **no `error`, no
`failedAt` and no `fetchedAt`**, because no request was made and a timestamp
would claim one was — so it is structurally incapable of being rendered as a
failed fetch. `GatherPorts` also holds **no news source**, so assembly cannot
reach a vendor even by mistake.

`NewsInput` is a **one-armed union on purpose**. The `ok`/`failed` arms are not
pre-declared, because nothing can produce them. When a vendor is chosen (decision
log 30 lists the three conditions, none met), the arms are added and every
exhaustive switch stops compiling until each is handled — which is why the pause
lives in the type instead of a comment.

### Every fetch keeps its own timestamp

The sub-fetches are not simultaneous, so no single bundle-level fetch time is
manufactured. `candles.value.fetchedAt` is the venue's answer instant,
`concentration.value.readAt` the D1 read's, `candidate.sources[]` carries each
provenance time, and a failed slot's `failedAt` is when the failure was
*observed*. `assembledAt` sits beside them and is **not** one of them — it is
when assembly ran, the same kind of thing `CandidateSet.selectedAt` is.

### One read for N candidates, and what a failed read then means

`gatherCandidateSetData` does **one** `bot_instances` read for the whole set —
step 34's design — and reports it on `exposure`. If that read fails, every
candidate's concentration slot carries **that same error object by identity**.
Not a duplicated guess: it genuinely was one read, and N identical recorded
failures is an accurate report of it. Candles are unaffected and still fetched
per candidate.

## Stage 2 is a prompt, a parser and an empty port

No model is called from anywhere in this repository. `AssessModel` is abstract,
`wrangler.jsonc` has no `ai` binding, and every test drives a stub that returns a
string a human wrote. The two pieces that are built are the two whose
correctness is checkable **without** a model, and they are the two that decide
whether 21.5's grounding and fail-closed rules actually hold.

**Grounding is enforced, not requested.** The prompt forbids outside knowledge in
21.5 requirement 1's own terms, and pairs that instruction with something
mechanical: every datum is emitted with a stable **evidence id**, every claim
must cite one, and the parser **refuses the whole response** if a citation names
an id this run's prompt never emitted. That does not prove a claim's prose is
true of the datum it cites — nothing mechanical can — but it means every claim
arrives attached to a real fetched value a human can read beside it.

**A missing input is stated, never omitted.** A failed candle fetch, a failed
concentration read and the paused news slot each produce a labelled line
carrying the producing module's own error code and message. An absent section
would read to a model exactly like "there was nothing to report", and those are
opposite facts.

**The candle series is bucketed, and the omission is in the prompt.** A real run
returned 1,440 one-minute candles (decision log 36); the leading candidate
model's documented context window is 24,000 tokens. So the prompt carries
whole-window aggregates computed from every candle plus at most
`CANDLE_BUCKET_COUNT` contiguous buckets, and states in prose how many candles
there really were and that the individual ones were left out.

**The parser has no lenient path.** No case folding (`"DCA"` is refused), no
fence stripping, no first-`{`-to-last-`}` extraction, no ignored extra field, no
dropped bad citation, and no default strategy. It also refuses a duplicate key,
because `JSON.parse` silently keeps the last of two and
`{"strategy":"dca","strategy":"grid"}` would otherwise resolve cleanly.

**The transport envelope is unwrapped; the content rules are not relaxed.** One
real call showed this model, in JSON-schema mode, returning
`{ response: { strategy: "grid", claims: [...] } }` — `.response` is an
**already-parsed object**, not the string Cloudflare's own generated type
declares for that arm. The parser refused it, and that refusal was *correct*: a
wrong assumption held to the right standard. `unwrapModelEnvelope` now
recognises the transport shapes (`bare_string`, `envelope_string`,
`envelope_object`, `bare_object`) and every one of them lands in the **same**
`validateAnswerObject`, so a rule relaxed for one path would have to be relaxed
for the other in the same visible edit.

**One protection is sometimes structurally unavailable, and says so.** The
duplicate-key scan works on the model's own bytes, and on the object path the
transport already consumed them. Re-stringifying the parsed object and scanning
*that* would be theatre — it can never find a duplicate — so it is not done.
Instead every result carries `duplicateKeyCheck: "performed" |
"unavailable_transport_parsed"`, so an audit record states which guarantees
actually held for that proposal. Whether `returnRawResponse` recovers the bytes
is an open question for the next probe, not an assumption.

**Third-party text is delimited and labelled, never removed.** A trending
vendor's `name`, `symbol` and `coinId`, and a human's watchlist `note`, are free
text this system did not write, and all of it lands in the DATA section. Each is
wrapped as `<<<UNTRUSTED_TEXT chars=N>>> … <<<END_UNTRUSTED_TEXT>>>`, and the
prompt's **rule 3** — stated before any data — says everything between those
markers is data to report on and never an instruction, on the same footing as
the price numbers. An injection attempt is emitted **byte for byte**: stripping
it would be this system silently altering fetched data, and would destroy the
evidence an operator needs to see that it happened.

**This reduces risk; it does not eliminate it.** A delimiter is a convention a
model may honour or ignore, and nothing here can force it. Two structural limits
bound the real damage whether or not the delimiters work, and they are the reason
this is a reasonable place to stand: **(1)** this stage produces a recommendation
a human reviews against the real data (21.1) — it creates no bot and has no write
path to one; **(2)** the citation check still holds, so a hijacked answer can
still only point at evidence ids this run really emitted. An injection can change
the *answer*; it cannot change the *data the answer is checked against*.

**Zero retries, deliberately.** `assessCandidate` calls the model exactly once,
and a parse refusal ends the run. "Retry until it parses" would convert
fail-closed into fail-open: the accepted answer would be the one selected for
passing the validator rather than the one the model gave, with disagreeing
samples discarded silently. It also fights the determinism stance — with
`temperature: 0` and a fixed seed, a retry that *succeeds* is evidence the
pinning did not hold, and a loop would consume exactly that signal.

**Open question: 13.5 seconds for one call.** The first real call took
**13,540 ms** for a ~4,000-token prompt. One sample, not a distribution — but a
12-candidate general run assessed sequentially would spend **over two and a half
minutes in model calls alone**, and Stage 3 is a second call per candidate.
Whether Assess can run synchronously inside an HTTP response, or whether the
pipeline must be queued, is **unanswered here on purpose**: the answer reshapes
the endpoint, the proposal record and how a human is told a run is in progress,
and choosing an architecture from one data point is worse than leaving it open.

**One precondition, in the runner rather than the collector.** `assessCandidate`
refuses a bundle with no usable candle window **before** calling the model. That
is not the quality judgement Stage 4 owns — it is the absence of the only input
the question is about, and a strategy pick with no prices could only come from
the training knowledge requirement 1 forbids.

## Stage 3 is two prompts, one parser, and three validation layers

**Two prompts and two schemas, never one with optional fields.** A grid bot and
a DCA bot need different parameters, so `buildDerivePrompt` dispatches on the
strategy Stage 2 actually chose and builds exactly one branch's field list,
field contract, worked shape example and JSON schema. The rejected alternative —
one schema carrying every field of both strategies with the irrelevant ones
optional — fails specifically: an optional field is a field the model **may**
fill in, so a DCA proposal would be free to carry an `upperBound`, and
`requireExactFields` would have nothing exact to require.

What the two share is everything else: the same `EvidenceCollector`, the same
`collectBundleEvidence` id vocabulary, the same `SHARED_GROUNDING_RULES`, the
same `wrapUntrusted` injection defence, the same transport reader and the same
citation check.

**Stage 2's choice is an input, never a question.** The prompt states the
strategy as decided and forbids arguing with it, and a response naming a
different one is a **total refusal** (`strategy_disagreement`) rather than a
signal to weigh — 21.2 says a divergence between stages is a bug, and weighing
it would put a strategy choice in front of a human that no stage is accountable
for.

**Every proposed number carries a citation**, by the same mechanism Stage 2's
claims do. Each field arrives as `{value, citations}`, the citations resolve
against the ids this run's prompt really emitted, and an empty or invented
citation is fatal for the whole proposal. The `value` itself is **never
inspected here** — it goes to the real decoder untouched, which is what makes
the decoder reuse real rather than nominal.

### The three validation layers, and why the third is smaller than it looks

They run in the real create-bot path's own order:

1. **`decodeGridParams` / `decodeDcaParams`** — the exact decoders
   `POST /api/bots` runs on a human's own submission, handed the model's
   `parameters` object with nothing added, removed, renamed or coerced, plus the
   same two literals the handler adds.
2. **`validateGridParams` / `validateDcaParams`** — the exact validators
   `BotInstance.createGrid` / `create` run before any capital is reserved.
3. **Only what neither of those checks.**

21.5 requirement 3 names an inverted grid range and a zero percentage as sanity
bounds. **Both are already refused by layer 2, by the real code** —
`buildLevels` throws `upperBound must be above lowerBound`, and both validators
throw on every non-positive percentage. A second copy in layer 3 would be the
duplicated risk check requirement 3's own first bullet forbids **and** — because
layer 3 runs last — a check that could never fire, which is exactly the
"theatre" this project refused once already (decision log 37's duplicate-key
finding). So no copy exists, the cases are tested, and **the tests assert which
layer refused**, so deleting a real validator from the chain fails the suite
instead of being silently absorbed.

What layer 3 genuinely adds is three things nothing upstream does:

- **The minimum order floor.** Neither decoder nor validator knows the pair
  exists; section 4.3's filters are applied at **order** time, far too late to
  tell a human their proposed size cannot be sent.
- **The capital headroom comparison.** `validateXParams` checks the config
  against its own `allocatedCapital`; nothing checks `allocatedCapital` against
  the **account**.
- **The capital asset** being one the account actually holds a ledger row for.

### The minimum-order floor is reported, not assumed

**Gemini publishes no notional bounds at all** — `parseSymbolDetails` sets
`minNotional: DISABLED`. A check written only against `minNotional` would
therefore be a **permanent no-op on the only venue this system runs against**,
passing every proposal forever while reading in review like a floor. Gemini
publishes `min_order_size` instead, which lands on `minQuantity`.

So the check runs in whichever dimension the venue actually publishes, using the
strategy's own `quantityForLevel`/`quantityForQuote` at the **highest** price an
order would be placed at (where the implied quantity is smallest), and
`MinimumOrderCheck` records which floor held **for that proposal** —
`"notional"`, `"quantity"`, `"both"`, or `"none_published"`. Same instinct as
`DuplicateKeyCheck`: a guarantee that could not be checked is reported, never
faked.

### The capital figure is a PREFILL, and that word is load-bearing

`readAccountCapital` reads `capital_ledger` and does the subtraction
`total_balance - total_allocated`. It **writes nothing, reserves nothing and
holds no lock**, and 21.1 guarantees this pipeline has no write path to one.

**The binding check remains `createBotInstanceWithCapital`'s**, which re-reads
the ledger inside a compare-and-swap at the moment a bot is created and refuses
with `insufficient_capital`. Between Derive's read and that moment there is an
arbitrarily long gap in which another bot may be created or the balance
rewritten, so **the headroom Derive proposes within is stale by construction
from the instant it is read** (21.5 requirement 4). If Derive proposes 500 and
the ledger has 400 by submission time, the real flow refuses — correctly, and
without needing to know this stage exists.

The subtraction is restated here; the **check** is not copied. That distinction
is deliberate: `total_balance - total_allocated` is the definition of
"available" and already appears verbatim in `AllocationAuditDetails`, while
comparing it against a request and refusing is `ledger.ts`'s alone.

### Four refusals before the model is called

`deriveParameters` refuses — spending no inference — when there is no price
history, when the capital ledger could not be **read**, when the account has no
headroom on any asset, and when the pair's filters could not be read. Each is
the absence of something the question is *about* rather than a quality
judgement, and the last is the one that would be easiest to wave through: a
floor that did not arrive is not a floor that said zero, so proceeding would
present a parameter set as validated when the one check requirement 3 names that
nothing else performs could not run at all.

**Zero retries**, for Stage 2's reason, which is stronger here: Assess picks
between two words, so a resampling loop is at worst a biased coin, while Derive
proposes nine numbers against validators — a retry loop would be a search
procedure whose objective is "parameters that squeeze through the checks".

## Candidate selection: one shape, three doors, merged provenance

21.2 says the entry points "differ **only** in how the candidate coin or coins
are chosen", so every function returns the same `CandidateSet` holding the same
`Candidate`. They are kept from converging by their ports rather than by
discipline: `NamedCandidatePorts` has no trending source in it, so the named
path cannot reach a vendor even by mistake.

Deduplication **merges provenance rather than dropping it**. A coin on both the
watchlist and the trending pull is one candidate carrying two sources, and
`Candidate.sources` is a non-empty tuple, so a candidate that came from nowhere
is unrepresentable. 21.5 requirement 2 needs "**which** watchlist entry, or
**which** trending pull, and when" — so the sources carry `entryId` and `pullId`
respectively, plus the vendor's raw item by identity.

**A failed trending pull is fatal, not a fall back to the watchlist.** 21.5
requirement 6 names "the trending source is unreachable" as a fail-closed
condition, and 21.3 says the trending pull exists because "it is the only way
the system can ever surface something the operators did not already think to
look for". A watchlist-only set returned under the name "general candidates"
would be a degraded result indistinguishable from a good one.

### The third door, and the deviation from 21.2 it represents

That last paragraph used to end "an explicit watchlist-only entry point could be
added later, deliberately and under its own name". **It has been**, and this is
the record of it: `selectWatchlistCandidates` sources the watchlist half alone,
returning `entryPoint: "watchlist"` and `trending: null`.

**This is a deviation from 21.2, which names two entry points, and it is recorded
as one rather than folded in quietly.** The justification is 21.2's own rule —
the doors "differ **only** in how the candidate coin or coins are chosen", which
is exactly and only what this differs in. Same `CandidateSet`, same `Candidate`,
same everything downstream; no second prompt set and no second code path below
selection.

What 21.2 forbids is untouched: `selectGeneralCandidates` still throws
`trending_unavailable` rather than degrade, **nothing routes to the watchlist
door as a fallback**, and a caller reaches it only by naming it. A door an
operator has to ask for by name is the opposite of a silent degradation, and the
set says which door it came through so the two are not confusable even with the
set alone in hand.

It exists because it is the only way to run the N-candidate gather that decision
log 35's open question is about, and `WatchlistCandidatePorts` holds **no
catalogue port at all**, so it cannot re-check tradability even by mistake —
matching `selectGeneralCandidates`' treatment of the identical rows, so the two
doors cannot disagree about them.

### Spot versus perpetual: closed twice, with two different strengths

Gemini's real catalogue carries **perpetual** pairs (`HYPEGUSDPERP`,
`HYPEUSDCPERP`) alongside spot, and `parseSymbolList` passes every string
through unfiltered. Until step 32 nothing in this repository knew what a
perpetual was, so `addToWatchlist`, `fetchCandleWindow` and
`selectNamedCandidate` all accepted one with zero resistance, while every order,
fill and PnL path here is spot. It is now checked in two places, and **the two
are not equally strong — that difference is the point, not an oversight**:

| where | what it reads | strength |
| --- | --- | --- |
| `POST /api/bots` (`checkSpotInstrument`) | Gemini's own `product_type` / `contract_type` fields, one uncached request per symbol | **structural.** The venue states it. Verified live, step 32 |
| watchlist, candles, both candidate entry points (`checkTradable`, opt-in) | the symbol's own last characters against `DERIVATIVE_NAME_SUFFIXES` | **an inference.** Free, and Gemini publishes no such naming rule |

The research paths take the cheap one because they cannot afford the other:
`checkTradable` runs on every watchlist add, every candle fetch and up to ~15
times per candidate-selection run, and the structural check costs a request per
symbol. The match is `endsWith`, never `includes`, so `PERPUSD` — Perpetual
Protocol's real spot ticker — is not refused; a test pins exactly that.

**The order path deliberately opts OUT** of the naming heuristic
(`"structural-check-elsewhere"`). Letting a weaker inference answer first would
put a guess in the refusal message on the endpoint that reserves capital, and
would mask `checkSpotInstrument` from its own most realistic input — a regression
test in `api.test.ts` pins that `HYPEUSDCPERP` there is still refused by
`instrument_not_spot`. **Residual risk stays, in both directions**: a perpetual
that does not follow the naming convention passes the research paths silently,
and a future spot pair ending in those letters is wrongly refused. The false
reject is the preferred direction because it is loud, immediately fixable in one
table, and cannot block a legitimate bot. See decision logs 31 and 32.

Candidate selection's trending path was already structurally safe before any of
this, and only incidentally: `${BASE}${QUOTE}` cannot construct a `PERP` suffix,
and `checkTradable`'s near-match is an exact equality so no perp is ever offered
as "the venue's own spelling". Two tests pin both, and they are still what does
the work there.

A trending pull that matches nothing on the venue is a **fact**, not a failure,
and is reported as one: `TrendingPullReport` carries what came back, what was
accepted, and every rejection with the exact pairs that were tried. That last
field is load-bearing — without it, "the pair-spelling convention does not hold
on this venue" is indistinguishable from "a quiet day".

## The over-concentration flag is a flag, and structurally not a filter

21.4: *"This is a flag on the proposal for the human to weigh, presented
prominently, **not a silent filter**."*

So nothing in `concentration.ts` refuses, drops, reorders or scores a candidate.
`assessCandidateSetConcentration` returns exactly one result per candidate in the
candidate's own order, and there is no return value a caller could read as a
rejection. Its only two error codes are a blank field and a **failed read** —
never "this candidate is bad". That is a different shape from every other refusal
in this folder (`pair_not_tradable`, `interval_not_verified`, `not_covered`), and
deliberately: those answer *can this system honestly do this at all*, which is a
capability fact. This answers *should you want to*, which 21.1 puts on the
human's side of the boundary.

### The two thresholds are POLICY, not findings

21.4 names two cases and gives no numbers. `DEFAULT_CONCENTRATION_POLICY` holds
both, in the same category as `VERIFIED_INTERVALS` and
`DERIVATIVE_NAME_SUFFIXES` — **nothing has been verified against anything**, no
backtest supports them, and no operator has yet said they are right.

| | value | the judgement in it |
| --- | --- | --- |
| `samePairBotCountFlagAt` | **2** committed bots already on the pair | 21.4's own example ("a third bot on a pair that already has two") read as a *boundary* rather than an illustration. The looser of the two available readings of one sentence |
| `assetCapitalShareFlagAtPct` | **40%** of committed capital in the candidate's base asset | An argument, not evidence: 21.3 bounds the watchlist at 5–10 coins, so the design assumes a book spread over several, and at 40% one asset is more than two equal-weight positions' worth. 25% or 60% is equally defensible |

Both comparisons are **at or above** — exactly 2 flags, exactly 40.00000000%
flags — which the `FlagAt` in each name states and which is tested one step out
in both directions. The money boundary is decided by **cross-multiplied bigint**,
never by comparing a share already rounded to SCALE, so a value a hair under 40%
that *renders* as `40.00000000` does not flag. On today's real account (9 of 11
bots on `BTCUSD`) any threshold below ~80% fires identically, so **the live data
cannot discriminate between candidate values either**.

### Verified against real testnet state, 2026-08-10T20:35:36Z

The live `bot_instances` read, and what the fold produces from it. Every figure
below is real except where marked.

| | |
| --- | --- |
| bots on `gemini-main` | **13** — 11 `BTCUSD`, 2 `DOGEUSD` |
| statuses | 7 running, 1 halted, 1 halted+archived, 2 created, 2 running (DOGE). **None stopped** |
| capital assets | **`USD` only** |
| committed capital | **1750.00 USD** (all 13, since none are stopped) |
| BTC-derived | **1650.00 USD** across 11 bots |
| DOGE-derived | **100.00 USD** across 2 bots |

Computed output under `DEFAULT_CONCENTRATION_POLICY`, confirmed against by-hand
arithmetic before it was pinned:

| candidate | `samePairBots` | base-asset share | flags |
| --- | --- | --- | --- |
| `BTCUSD` | 11 | **94.28571429%** (1650/1750) | `same_pair_bot_count`, `asset_capital_share` |
| `DOGEUSD` | 2 | **5.71428571%** (100/1750) | `same_pair_bot_count` **only** |
| `LINKUSD` | 0 | 0.00000000% | none — `no_concentration` |

**`DOGEUSD` still flags**, on the count signal, at exactly the boundary: two
existing bots is the threshold, so a third DOGE proposal is flagged even though
its share is 5.7%. "DOGE does not flag" is the natural summary of the share
figure and it is wrong about the result; a test pins it.

**`v-perp-1` is a SPOT bot.** Its pair is `BTCUSD`; the name is leftover from a
rejected-then-reused botId in step 32's perpetual regression test. It counts as
one of the eleven, and a test says so by name — nothing in this repository infers
an instrument from a bot id, and a future reader grepping for "perp" will find
this.

**Two things in the pinned fixture are still not real, and are named in the
test:** the **per-bot split** of each pair total (the read gave pair totals, not
per-bot figures — distributed evenly, which is licensed by a test asserting the
report is *invariant* to the split given the same totals), and the **bot ids**
apart from `v-spot-1` and `v-perp-1`.

#### Two paths that are correct and unobserved

Same shape as step 31's merge/dedup path and step 32's Binance permission gap —
built, tested against fixtures, never exercised against real data. Not new kinds
of problem, and not fixed here:

1. **The stopped-bot exclusion.** The rule that makes `committed` something other
   than a plain `SUM` of the column exists because `releaseBotCapital` leaves
   `allocated_capital` behind. **No bot in this account has ever been stopped**, so
   the rule has only ever run against fixtures.
2. **The multi-quote-asset path.** Per-capital-asset grouping and the longest-first
   suffix strip both have real code. This account has only ever used `USD`, so one
   group is all that has ever been observed.

#### The bot count keeps moving, and this is the third correction

Log 32 recorded 11 bots against a prediction of 0. This read found **13** — two
more (`v-spot-1`, `v-perp-1`) created by steps 32/33's own live verification runs.
Step 28 hit the same class of surprise on the watchlist. **Verification runs
create real bots, so the count is stale the moment it is written down**, which is
exactly what 10.14 says ("anything which can change after an entry is written must
be read from the system, never quoted from this log"). Any future step that needs
a bot count must run the `SELECT`. Stating it plainly here because three
occurrences is a pattern, not a run of bad luck.

### It reports facts, not a verdict

Every result — flagged or clean — carries the counts, exact `bigint` money
totals, the **bot ids**, the pairs held, the quote assets used and the policy
applied, so a human can re-run the same `SELECT` and get the same numbers (21.5
requirement 2). The flag's `statement` renders those facts and adds nothing to
them. `"3 existing bots on BTCUSD"` is checkable only if you can go and look at
which three.

### Three states, never two

| | |
| --- | --- |
| the `bot_instances` read **failed** | throws `bot_list_unreadable` |
| the account has **no bot rows at all** | clean, `rowsRead: 0` |
| it has rows and **all are stopped** | clean, `rowsRead > 0`, `committedBots: 0` |

The first is the whole point. A check built to surface risk that reports *no
concentration* because it could not look would hide exactly the risk it exists to
catch, inside a proposal that then reads as reassuring (§5.6, 21.5 requirement
6). The last two are both clean and are **not the same sentence** — step 24's
`audit_empty_balance_set` distinction, step 30's coverage variants. And clean is
a **variant** (`assessment: "no_concentration"`), not an empty flag array: the
flagged variant's `flags` is a non-empty tuple, so "flagged with nothing to show"
cannot be constructed.

### What it borrows from step 25, and why not by calling it

`dashboard/src/accountTotals.ts` is **dashboard-side**: it folds a `Bot[]` the
page already fetched over HTTP, imports `./api/types` and `./derive`, and
**touches no database at all**. There was nothing here it could have been called
for. Two of its *rules* are reused, as rules:

1. **`stopped` bots are excluded from committed capital**, because
   `releaseBotCapital` subtracts a closed bot's allocation from the ledger but
   **leaves `bot_instances.allocated_capital` on the row** as history. Summing
   every row reports returned capital as still committed — an overstatement
   growing with every bot ever closed. Stopped bots are still **counted and
   reported beside** the figures, because `close` does not flatten a position, so
   one can genuinely still hold inventory.
2. **Grouped by capital asset, always.** A share over a total blending USD and
   USDT is a percentage of nothing, and it looks completely normal.

**Archived bots count**, exactly as step 26 settled for the account totals:
`archived` is a view flag orthogonal to `status`, and a concentration figure that
moved when someone flipped a dashboard toggle would be step 25's silent omission
in a new place. Pinned by a test.

### The base asset is a naming inference, and says so

21.4's second case is about an **asset**, and `bot_instances` has **no base-asset
column** — only `pair` and `capital_asset`. Neither is the asset in question: by
pair, `BTCUSD` and `BTCUSDT` are two unrelated things; by capital asset, every
bot on the real account is `USD`, so the share is 100% for every candidate
forever and **a flag that always fires is not a flag**.

`news.ts` refuses to split `BTCUSD` into `BTC` — *"a guess at the split point is
wrong for exactly the newly-listed, oddly-named coins 21.3's trending source
exists to surface"* — and that refusal stands. This does something narrower: the
quote assets are **observed**, not guessed (the distinct `capital_asset` values on
the account's own bots, plus any the caller states, the same list
`selectGeneralCandidates` already takes from an operator), and a pair is split
only when it **ends in one of them, longest first** so `BTCUSDT` strips `USDT`
rather than becoming `BTCT`. A pair matching none is **not** split and is
**counted**, which makes every base-asset figure that had one a stated **floor**.

It is safe here in a way it would not be in `news.ts` because **the output cannot
block anything**: a wrong split yields a sentence a human can see is wrong — the
report names the suffix it stripped — never a refused pair or an order. Known
limits, both real: a venue writing `BTC-USD` splits to nothing (neither venue
here does), and a ticker ending in a quote asset's letters would mis-split. When
no split is possible the signal **degrades to the exact pair and says so**, never
to silence.

### The same-pair match is case-insensitive, unlike `checkTradable`

Deliberately the opposite rule, because the string is a **grouping key that never
leaves the process** rather than a symbol about to be sent to a venue. The two
failure directions are not equal: folding when it was unnecessary over-counts a
flag a human weighs and dismisses, while **not** folding when it was necessary
reports "0 bots on `BTCUSD`" with nine `btcusd` rows in the table — a false clean
result. `samePairSpellings` reports every spelling matched, so the fold is never
silent.

## The two candidate sources stay apart

21.3 feeds the general entry point from two sources, and this folder holds one
of them:

1. **A fixed watchlist** — 5–10 coins *chosen deliberately by the operators*.
2. **A live trending pull** — *the only way the system can ever surface
   something the operators did not already think to look for*.

**The trending pull must never write to the `watchlist` table.** The merge is
tempting because both produce pairs and both feed one pipeline (21.2: "one
feature, not two"), and it is still wrong twice over:

- 21.5 requires every proposal to display *the real source the candidate came
  from — which watchlist entry, or which trending pull, and when*. One table
  destroys that distinction at the moment of writing, and nothing downstream
  recovers it.
- 21.3's **hype hazard**: trending measures attention, not quality. A watchlist
  entry carries a human's stated reason (`note`, NOT NULL); a trending hit
  carries a popularity number. Stored together they are indistinguishable to
  every later reader, which is how a proposal comes to read as confident because
  its input was loud.

The cap makes the merge unattractive as well as forbidden: a trending pull
emptying itself into a 10-row table fails on the eleventh coin.

## What a write checks

| Check | Why | On failure |
| --- | --- | --- |
| Human actor | The list's value is that someone chose each row | `requires_human_actor` |
| Non-blank pair and note | The note is the only record of the reasoning | `missing_field` |
| Not already live | A duplicate is one coin costing two pipeline runs | `already_watched` |
| `WATCHLIST_MAX_ENTRIES` (10) | 21.3's bound, enforced not documented | `cap_exceeded` |
| Tradable on the account's venue | An untradable coin cannot become a bot | `pair_not_tradable` |
| The tradable set was **readable** | "could not check" ≠ "checked and fine" (§5.6) | `tradable_set_unreadable` |

The tradable set comes from `listTradablePairs` through step 11's cached
`listAccountSymbols`, injected as the `TradablePairSource` port — 21.3 is
explicit that it "is the authority, not a hardcoded list", and there is no
second path to the venue here.

Every write also lands an `audit_log` row through `db.auditLog`, the same path
every other consequential write in this system uses. The add batches its row and
its audit entry together; the removal does not, deliberately — see the comment
at that call site.

## Removal does not re-check tradability

Deliberate, and a departure from applying the write-side rule symmetrically.
Refusing to remove a **delisted** pair would trap exactly the entry most in need
of removing, and an exchange outage would be enough to freeze the list. The
failure runs the wrong way. Removal checks the precondition that actually
matters — that the pair is on the live list — and audits itself.

## Removal is a soft delete

`removed_at` / `removed_by`, not a row deletion. `Repository` offers no `delete`
method at all (see `/src/db/table.ts`) and this does not reach past it. Step 26
established the shape for `bot_instances.archived`; this is the same one table
over. The history is worth keeping on its own terms: *someone considered this
coin and then changed their mind* is the same kind of negative signal 21.5 wants
recorded about proposals nobody acted on.

## Deliberately deferred

- **A dashboard control for either the list or the candle window.** Not built,
  on purpose. Both have a curl-able endpoint instead; a UI is its own step.
- **An HTTP endpoint for the news fetch.** Deliberately not built yet, pending a
  decision on how (and whether) to verify it against the real CoinDesk API — the
  same order the candle step took, where the endpoint existed to make the
  function checkable and was written once there was something to check.
- **A trending vendor, and any transport for one.** `TrendingSource` is a port
  and nothing implements it. No trending API has been called from this
  repository, and the vendor research is in decision log 31.
- ~~**Everything LLM-shaped** — Assess, Derive, proposal assembly, the proposal
  record, the audit table.~~ **All of these now exist** (steps 37–44 and the
  proposal-record step). Stage 1 assembly has an endpoint
  (`GET /api/accounts/:label/gather`), built so decision log 35's rate-budget
  open question has a real caller to measure; candidate selection and the
  concentration flag still have none of their own, and are reachable only
  through that one.
- **Any judgement about whether a bundle is good enough.** `gather.ts`
  deliberately does not rank, filter or refuse. That is Stage 4's job and
  building it here would put a policy decision in the collection layer.
- **Concurrent gathering.** `gatherCandidateSetData` fetches candles one
  candidate at a time, so a general run does not burst the rate budget section
  5.4 owns. Isolation does not depend on the ordering, so this can change later
  without changing what a bundle means.
- **A stopped bot, and a second capital asset, on the real account.** Both code
  paths exist and are fixture-tested; neither has ever been observed live. See
  the two unobserved paths above.

`fetchCandleWindow` now has two callers: its endpoint, and `gather.ts`.
`fetchNewsSentiment` still has **no non-test caller at all**, and
`envNewsFetcher`'s `fetch` call has never executed against CoinDesk — `gather.ts`
deliberately does not call it, and holds no port that could. `readWatchlist` now
has two callers, `selectGeneralCandidates` and `selectWatchlistCandidates`.
`concentration.ts`'s caller is `gather.ts`, and **`gather.ts` now has a real
non-test caller** — `getAccountGather` — which is the condition decision log 35
set before its rate-budget question could honestly be measured.

**`selectGeneralCandidates` still has no reachable caller**, because the endpoint
refuses that door before calling it: there is no trending vendor to call and a
stub that failed would report a pull that was never attempted.

**Watchlist entries are not re-checked against the venue at selection time.**
A pair delisted after it was added stays a candidate until someone removes it.
This is the gap step 28 already recorded on `readWatchlist` ("says nothing about
the tradable set having gone stale underneath" it); closing it changes what
membership of the watchlist means, which is a decision rather than a detail.

## `fetchCandleWindow` removes a scoping limit, not the depth limit

Reaching `getCandles` used to mean holding a client, and every route to one ran
through a bot's attached client — so "candles for a pair" meant "candles for a
pair that already has a bot". A candidate coin has no bot by definition. This
resolves a client from the account registry instead, through the same
`clientForAccount` the symbol listing uses.

What it does **not** do is reach deeper history. Gemini's `/v2/candles` takes no
time-range parameter and returns a fixed recent window (spec 21.7, open question
1). That is reported rather than worked around: `earliestCloseTime` says how far
back the window actually goes, and `truncated` / `missingHistoryMs` say when the
requested range was not fully covered. 21.7's requirement is that "the Assess
stage must be told how much history it actually received and must not reason as
though it had more".

Every failure throws a `CandleWindowError` — unverified interval, unknown
account, untradable pair, unreadable tradable set, failed candle call, and a
call that succeeded with an empty array. None returns an empty window, because
an empty array flows into an average as though it meant something (§5.6, 21.5
requirement 6).

## Only `1m` is a verified interval

`VERIFIED_INTERVALS` is `["1m"]`, and anything else is refused with
`interval_not_verified` before any I/O happens. `CandleInterval` declares all
seven both venues nominally support, and its own docblock has said since step 14
that each "must be verified per exchange before first use" — a comment nothing
enforced. It has to be enforced here because the failure is silent: the venues
spell the wider intervals differently (Gemini writes `1hr`/`6hr`/`1day`), so a
wrong mapping returns correctly-shaped candles of the **wrong duration**, which
every type check passes and no later reader can detect.

Widening it is one line in `candles.ts` plus the pin in `candles.test.ts` that
asserts its current contents — the pin exists so widening cannot happen as a
silent one-character edit. Neither is the hard part: an interval belongs on that
list only once someone has read that venue's candles at that timeframe and
confirmed the duration.

## `GET /api/accounts/:label/candles`

Read-only, behind Access like every other route, taking `?pair=`, `?interval=`
and an optional `?since=`. It publishes the whole `CandleWindow` — including
`truncated`, `missingHistoryMs`, `earliestOpenTime` and `count` — because the
depth limit above is a claim about a real venue that no test in this repository
can settle. Every candle in the suite comes from a stub modelling a fixed
window; only a real request can say whether the truncation reporting is
accurate.

The module's codes map to statuses in `api/envelope.ts`, reusing existing tiers:
`interval_not_verified` and `pair_not_tradable` 400, `unknown_account` 404,
`candles_unavailable` and `no_candles_returned` 502 (a read the caller asked for
that the venue failed to serve — the symbols endpoint's tier),
`tradable_set_unreadable` 503 (a refusal to act on input that could not be
verified — a different thing, deliberately a different status).

## `fetchNewsSentiment` is written against an **unverified** wire format

**No call to CoinDesk has ever been made from this repository, and this project
holds no CoinDesk key.** Their reference docs render client-side from a spec
that can only be read by calling the API host, which was not done. The host, the
paths, the `Authorization: Apikey` scheme, the `{ Data, Err }` envelope, the
`PUBLISHED_ON`-is-seconds assumption and every field name in
`COINDESK_WIRE_FIELDS` are **inferences from CoinDesk's public documentation
index and published descriptions of the API** — not observations.

What *is* established from public sources: the sentiment is a **label**
(`POSITIVE` / `NEUTRAL` / `NEGATIVE`), not a number, and it is produced by
prompting a general-purpose language model to categorise each article. 21.4's
reasoning for choosing this vendor survives that — the label is computed outside
*this* system and a human can check it against the headline — but nothing may
treat it as a calibrated score. `fetchNewsSentiment` therefore returns the
labels and their counts and **no derived sentiment index of any kind**.

Every assumption is checked at parse time and a violated one **throws**, so a
wrong guess surfaces as `unexpected_category_payload` /
`unexpected_article_payload` naming the field, not as zero articles. The
assumptions are collected in `COINDESK_WIRE_FIELDS` (pinned by a test, like
`VERIFIED_INTERVALS`) and `COINDESK_ENDPOINTS` in `src/workers/news.ts`, so
correcting them after a live run is one visible diff.

## Coverage is asked as its own question (21.7 open question 2)

> "CoinDesk's coverage of newly listed coins is unverified… If coverage is
> empty, that is a fact the proposal must state, not a gap to paper over."

An article request alone **cannot** answer that: an empty list means both "this
vendor has never heard of this coin" and "this vendor covers it and published
nothing recently". So the category listing is asked **first**, and the article
request is spent only when there is a category to spend it on.

| result | means |
| --- | --- |
| `not_covered` | the vendor lists no category for this asset. No article request was made |
| `no_articles_in_window` | it does, and returned nothing |
| `covered` | it does, and returned articles |

They are **separate variants**, not a flag beside an array: the covered variant's
`articles` is a non-empty tuple type and the other two carry no `articles` field
at all, so "covered with zero articles" cannot be constructed and a reader that
forgets to check `coverage` cannot reach an empty array.

**The distinction is only as good as its premise** — that the category list
enumerates assets. That premise is unverified like the rest. If a live run shows
the category list is a small fixed taxonomy rather than an asset index, **this
design is wrong and must be replaced by a plain statement that the vendor cannot
tell the two apart**, not by a heuristic that guesses.

A spelling difference is **never** reported as no coverage. `"btc"` against a
vendor writing `"BTC"` throws `asset_spelling_mismatch` carrying the vendor's
own spelling — the same exact-match discipline `checkTradable` uses, and for a
sharper reason: a false "nobody is writing about this coin" reads like a finding
rather than like the mistake it is.

## The news fetch takes an **asset**, not a pair, and never caches

`fetchNewsSentiment({ asset: "BTC" })`. It does not derive `BTC` from `BTCUSD`:
Gemini's symbols are concatenated and separator-less, so splitting one needs the
venue's own symbol details, and a guess at the split point is wrong for exactly
the newly-listed, oddly-named coins 21.3's trending source exists to surface.

Nothing is cached, matching `envCandleLister`'s reasoning: 21.5 requirement 4
times a proposal from when its data was fetched, and a cache would make that
timestamp a lie that looks exactly like the truth. Every result carries
`fetchedAt` and `coverageCheckedAt` — the two calls happen at different instants
and one number for both would claim something nothing observed.

Every failure throws a `NewsSentimentError`: `invalid_asset`, `invalid_limit`,
`asset_spelling_mismatch`, `categories_unreadable`, `news_unavailable`,
`vendor_error` (an error in the envelope beside an HTTP 200 — the shape a silent
failure takes with this vendor), `unexpected_category_payload`,
`unexpected_article_payload`. One malformed article fails the whole fetch rather
than being dropped, and an article with no `SENTIMENT` is refused outright,
because that field is the entire reason 21.4 chose this vendor.

## What the manual edit path bypasses

While editing is a raw `wrangler d1 execute`, the cap, the tradability check and
the audit entry are all bypassed — none of that code runs on a raw `INSERT`. The
one guarantee that survives is the migration's unique partial index on
`(account_label, pair) WHERE removed_at IS NULL`. This is stated rather than
hidden; it is the strongest argument for building the dashboard control, and the
reason the SQL commands in the decision log write the paired `audit_log` row by
hand.

---

## The proposal record (21.5 requirement 5)

Every step of the section 21 arc from log 30 to log 44 closed with the same line —
requirement 5 is "NOT satisfied, NOT partially satisfied and NOT begun" — and logs
42 and 44 each **declined to invent a throwaway store**, on the stated grounds that
the real record was coming and would have a different shape, lifetime and owner.
This is that record.

`proposal-log.ts` writes it. `migrations/0009_proposals.sql` carries the full
storage-shape argument. `Database.proposals` has exactly one writer.

### Why a dedicated table and not rows in `audit_log`

21.5 names `audit_log` as the practice this mirrors, so the obvious reading is a
fat `details_json`. Traced through the real code, that does not work — four
reasons, in descending weight:

1. **A proposal has a LIFECYCLE; an audit entry is an EVENT.** The outcome is only
   knowable later, so recording it means UPDATING. **Nothing in this system has
   ever updated `audit_log`** — every writer only INSERTs, and that append-only
   property is what makes the log trustworthy.
2. **`Repository` cannot filter on a JSON column, by design** (`unsupported_filter`,
   see `/src/db/table.ts`). `audit_log` has no `account_label`, `pair` or `stage`,
   so *"every proposal nobody acted on"* — the specific measurement 21.5 exists to
   enable — would be unaskable.
3. **Every read of `audit_log` would pay for the payload.** `findMany` always
   selects the full column list; there is no projection. The measured worst-case
   proposal payload is **290,459 bytes**, so proposals in `details_json` would mean
   `listReconciliationRuns` dragging that per unrelated read.
4. **The outcome link needs something to point at.** `POST /api/bots` takes an
   optional `proposalId`; a foreign key into `audit_log` would point at a table
   where any row of any action could be named.

So: a dedicated table for the **record**, plus an `audit_log` row for the
**event**, in ONE `Database.batch` — the shape migration 0008 set for the
watchlist. The audit entry carries a **pointer**, never a second copy.

### Two rows per pipeline run, and one link that is deliberately absent

`/assess` and `/derive` each perform their **own** fresh gather (log 42's decisive
check: the same evidence id resolved to 63775.31 and 63757.71 ten minutes apart),
so `stage` distinguishes two independently-complete rows rather than one row
picking a gather and discarding the other.

⚠ **A derive row does NOT carry the id of the assess row it derives from**, because
nothing in the request carries that link and an `assessProposalId` taken from the
caller would be a client-asserted claim this system cannot verify — the same class
as `envelope` and `duplicateKeyCheck`. Each row is independently traceable, so
nothing needs the join.

### `ignored` is not a stored value

Only `approved` and `rejected` are decisions a human makes and a system can
witness. **`outcome IS NULL` is 21.5's "ignored"**, read after the fact — no
threshold and no cron sweep, because the signal the requirement asks for is
"nobody acted", and a NULL that stays NULL *is* that.
`idx_proposals_unresolved` is the index for counting it.

⚠ A proposal made thirty seconds ago also has a NULL outcome, so the count is only
meaningful over rows old enough that a human would have acted, and **no threshold
is invented for that**. Counts are also only meaningful **grouped by `stage`**:
only a derivation can be approved.

### `/gather` writes no row, and that is the measurement working

A DEVIATION from the brief, recorded as one. A gather has no reasoning, no
strategy and nothing a human could approve or reject. Gather rows could never be
acted on, so they would inflate the "nobody acted" numerator without bound.
**Nothing is lost**: every logged row carries the full gather bundle, because both
endpoints gather and store it.

### A failed run writes no row either

`assessCandidate` and `deriveParameters` catch nothing, so a refusal throws before
the write. That is 21.5's own wording — "every **proposal** generated" — and a
refusal generated none.

⚠ **The consequence: the refusal rate is not measurable from this table.** How
often the model answers unusably, or a resubmission arrives stale, is invisible
here. Those are real signals and recording them is a later step, because a failure
record has different columns and would be a different table.

### A failed write fails the request

The model call has already happened by then, so a failed write **discards a paid
inference**. It is still right on requirement 6's terms: the alternative is
returning a proposal that is not in the record, to a human with no way to tell.
**The one place this is reversed** is the create-bot outcome link, which runs after
a real bot exists — there the failure is reported in the response body, because
failing the response would misreport a completed, irreversible action.

---

## The staleness thresholds (21.5 requirement 4)

`staleness.ts`. Spec 21.7 open question 4 — *"what 'a meaningful delay' is … is
unset, and should probably differ by strategy"* — answered with four numbers:

| input | threshold | why |
| --- | --- | --- |
| price history, **grid** | **15 min** | bounds are ABSOLUTE prices; once price leaves the ladder the bot created is not the one reviewed |
| price history, **dca** | **60 min** | every behavioural DCA parameter is RELATIVE to the fill price; nothing names an absolute price |
| capital ledger | **1 hour** | a PREFILL; the binding check is the ledger's compare-and-swap at creation, so staleness is a nuisance not a risk |
| bot list | **24 hours** | changes only when a human starts or stops a bot |
| venue rules | **7 days** | slowest-moving; the real filter check happens at order time regardless |

⚠ **These are POLICY CHOICES with no backtest, no volatility model and no market
data behind them** — the same category as `DEFAULT_CONCENTRATION_POLICY`. What the
reasoning supports is the **ordering** and the rough **ratio**; the absolute values
it does not.

**Four thresholds and not one**, because `oldest` is not the answer: a 2-hour-old
venue-rules fetch is usually the oldest and is nowhere near stale, while a
20-minute-old price fetch on a grid proposal is stale and usually is not the
oldest. Both cases are pinned by tests, in the policy module and again through the
dashboard's rendering path.

**Three states, not two.** An input that produced no value has no age to compare and
is `unknown` — not fresh (section 5.6). `stale` outranks `unknown` outranks `fresh`.

`staleness.ts` **has no imports**, deliberately: the dashboard imports it directly,
the third file to cross that seam after `shared/alert-types.ts` and `shared/money.ts`.
A mirror is what fails silently here, so there is not one.

---

## The params shape check (`proposal-shape.ts`) — a crash fix

**Found during operator verification, from a hand-edited test file rather than a real
response.** A file carrying `strategy: "dca"` over GRID-shaped params reached
`ProposalParameters`, which read `params.baseOrderSize` (absent), handed `undefined`
to `formatMoney`, and threw `TypeError: undefined is not an object (evaluating
'value.startsWith')` out of `roundDecimal`. React unmounted the tree and **the whole
page went blank and black with no visible error** — indistinguishable from a page
that had not loaded, a routing bug, or a backend outage.

`checkParamsShape` now runs before any field is read, and a mismatch renders the same
red warning `ProposalStrategy` already renders for a Stage 2 / Stage 3 strategy
disagreement. **Both are the same category of fault** — pasted input whose parts do
not agree — and only the manifestation differs.

⚠ **A real backend response cannot produce this**, in three independent places: the
per-strategy JSON schema, `requireExactFields`, and `validatedProposalView`'s
discriminated union. That is not a reason to skip the check: the proposal page's
input is PASTED by design (log 44), so it is untrusted text in exactly the sense a
resubmitted assessment is — and `parseResubmittedAssessment` does not skip validating
a resubmission because a well-behaved client would have sent a good one.

### Two rules worth knowing

- **`null` is present; `undefined` is missing.** The view emits `null` for an unset
  optional (`takeProfitAmount`, `breakoutThresholdPct`) and never omits the key. A
  rule that accepted "absent or null" would let the original crash straight through.
- **The field set is EXACT** — `requireExactFields`' own rule. Extra is a fault too.
  The first version measured extras against *both* strategies' lists, and its own
  test caught the hole: an object carrying grid AND dca fields (what merging two
  responses produces) passed, and would have rendered as a grid bot while silently
  dropping a complete DCA description.

### The field lists are pinned two ways, not mirrored

`proposal-shape.ts` **has no imports**, so the dashboard imports it directly — fourth
file across that seam after `alert-types.ts`, `money.ts` and `staleness.ts`. A mirror
would not fail to compile and would not throw; it would refuse a good proposal or
pass a bad one. Instead: pinned against `GRID_DERIVE_FIELDS`/`DCA_DERIVE_FIELDS`
(spec 21.4's own quotation), and against the real key set `validatedProposalView`
emits when driven over a real `DeriveResult`. **The second pin is the one that
matters** — the component reads the view's output, not the prompt's field list.

### Defence in depth, and the mutant that shaped it

`ErrorBoundary` wraps the parameters section, the evidence section, and the whole
proposal — so any FUTURE unexpected shape is a visible, contained block instead of a
blank page. Its pure half lives in `dashboard/src/renderError.ts` and **must never
throw**: it runs where nothing is left to catch a second failure, and `throw` accepts
any value (`String(Object.create(null))` throws, a bug this project hit once already).

⚠ **A mutation run found the guard's own CALL SITE unreachable by any test**: it lived
in a `.tsx`, and React's CJS build does not resolve in the Workers runtime, so a test
importing it collects *zero* tests. A guard nothing can check is most of the way to no
guard — so the decision moved to `dashboard/src/proposalFields.ts`, which returns the
check and the field list **together**, making "refused but rendered" unrepresentable.
What remains eye-verified is the JSX alone.
