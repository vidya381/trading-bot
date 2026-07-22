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
| `grid.ts` | 6.2 | 9 — not built |

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
