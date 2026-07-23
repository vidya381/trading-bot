# Strategies

Spec section 6, as pure logic.

Nothing in this folder performs I/O, reads a clock, or touches storage. A
strategy takes a configuration, a position and a price, and returns the action
it wants taken. The `BotInstance` Durable Object carries that action out.

That separation is section 13's requirement rather than a preference:
backtesting must run "the same strategy code ... without duplication" against
historical candles, which is only possible if the strategy does not depend on
the machinery that talks to an exchange.

| File | Spec | Build step |
| --- | --- | --- |
| `dca.ts` | 6.3 | 6 — built |
| `grid.ts` | 6.2 | 9 — built |

## `dca.ts`

`decide()` is the whole of section 6.3's running behaviour as one function.
Order of checks matters and is deliberate: stop-loss first, so a risk exit
cannot lose a race to a routine buy at the same price update; then take-profit;
then an additional buy, and only when no order is outstanding.

Two readings of the spec are encoded here and are worth knowing:

- **Exhausting `maxAdditionalBuys` does not halt.** Section 6.3 step 5 names
  "maximum buys are exhausted and price continues falling" as a halt condition
  but gives no threshold for "continues falling". The mandatory stop-loss,
  measured from average entry, already is that threshold. So the bot stops
  buying, keeps watching, and halts when the stop-loss is breached.

- **Take-profit is a cycle completion, not a section 7.2 halt.** Section 7.2
  lists take-profit among the halt triggers and says a halt never auto-resumes;
  section 6.3 step 6 says the bot may auto-restart after a take-profit exit.
  Both cannot hold. 6.3 step 6 is the specific rule for DCA, so `autoRestart`
  on begins a fresh cycle, and `autoRestart` off halts with reason
  `take_profit_reached` — which keeps 7.2 true for every path that does not
  have 6.3 step 6's explicit permission.

Order sizes are denominated in the **quote** asset, so they can be checked
against `allocated_capital` directly. Every rounding direction is named at its
call site (step 2's decision 3) and chosen to be conservative: thresholds round
so that a trigger requires the full configured move, and sizes round down so
the bot never plans to spend more than it said it would.

## `grid.ts`

`decide()` is the price-driven half of section 6.2 (initial placement,
stop-loss, breakout, accumulated take-profit); `planFill()` is the fill-driven
half (the replace-on-fill rule of step 3). The split is the same one DCA has
between `decide` and the object's `onFill`.

Four readings of section 6.2 are encoded here, all recorded in the step 9
decision-log entry:

- **A started grid places buys only.** Section 6.2 step 2 says "buy orders
  below and sell orders above", but capital is quote-denominated (step 6), so a
  fresh bot holds no base to sell. Every sell is created by replace-on-fill,
  funded by the buy one level below it.

- **Ladder state is a stored levels array plus one slot per level.** Prices are
  built once and persisted (as DCA stores `averageEntryPrice`); each sell slot
  carries the cost basis of the buy it replaced, so realized profit per round
  trip is exact.

- **"Significantly above the highest line" defaults to one grid step above it**
  — the ladder's own spacing, the only scale the spec supplies —
  configurable via `breakoutThresholdPct`.

- **The upside breakout cash-out defaults to ON** (`breakoutTakeProfit`), per
  the spec's "should be configurable but defaults to on".

Order sizes are quote-denominated as in DCA. Level prices round half-even (a
grid has no directional interest and each price is snapped to tickSize again at
placement); the stop-loss and breakout prices round up so a marginal move does
not trigger early or cash out early; quantities floor.

Geometric spacing computes its ratio with a pure-integer binary-search root —
no floating point in a price calculation — and fills the interior by repeated
multiplication with the two bounds pinned, so no accumulated rounding moves the
grid off the bounds a human chose.
