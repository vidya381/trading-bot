/**
 * Matching a typed pair against an account's REAL tradable set.
 *
 * A pure module rather than logic inside the page, for entry 45 gap (b)'s
 * reason: a decision that lives in a `.tsx` cannot be tested at all in this
 * repository — React does not resolve in the Workers pool the suite runs in, so
 * a test importing one collects zero tests instead of failing. Everything the
 * trigger page DECIDES lives in a `.ts`; the page renders.
 *
 * ── WHY THIS EXISTS RATHER THAN REUSING `PairCombobox` ──
 *
 * `pages/CreateBot.tsx` has a full ARIA combobox over the same symbol list, and
 * reusing it would be the obvious move. It is NOT reused, and that is a judgement
 * call worth stating: it is a private component inside a 1,400-line file, it
 * depends on three more private helpers there (`INPUT_BASE`, `inputBorder`,
 * `Field`), and extracting it means editing the create-bot form — the most
 * safety-critical surface in this dashboard, verified by typecheck and the
 * operator's eyes and by nothing else. That edit is not worth making as a side
 * effect of building a trigger.
 *
 * So this page gets a smaller input: a text field, the same real symbol list
 * behind it, and the membership test below. The COMMITTED value is still
 * constrained to a symbol the venue really lists, which is the property that
 * mattered.
 *
 * ⚠ THE MEMBERSHIP TEST IS AN AFFORDANCE, NOT A GATE. `selectNamedCandidate`
 * checks tradability for real, against the live cached set, and refuses with
 * `pair_not_tradable` — and a pair that passes here can still be refused there,
 * because this list can be up to an hour stale (the symbols endpoint's KV cache)
 * and because this check knows nothing about the derivative-name rule
 * `tradability.ts` applies. Nothing here is a second implementation of that gate.
 */

/** How many suggestions to offer at once. The full set is 300+ on Gemini. */
export const MAX_PAIR_SUGGESTIONS = 8;

/**
 * The pairs worth offering for what has been typed so far, prefix matches first.
 *
 * Prefix before substring for the reason `CreateBot.tsx`'s combobox gives:
 * typing "BTC" should offer BTCUSD before something that merely contains it.
 * Case-insensitive, because venues disagree about case and a human typing "btc"
 * has not made a mistake.
 *
 * An empty query returns NOTHING rather than the whole list: this is a
 * suggestion strip under a text field, not a browsable picker, and dumping 300
 * symbols under an untouched input is noise.
 */
export function suggestPairs(pairs: readonly string[], query: string): readonly string[] {
  const q = query.trim().toUpperCase();
  if (q === "") return [];
  const starts: string[] = [];
  const contains: string[] = [];
  for (const pair of pairs) {
    const upper = pair.toUpperCase();
    if (upper.startsWith(q)) starts.push(pair);
    else if (upper.includes(q)) contains.push(pair);
  }
  return [...starts, ...contains].slice(0, MAX_PAIR_SUGGESTIONS);
}

/**
 * The venue's own spelling of a typed pair, or `null` if the venue does not list
 * it.
 *
 * Returns the LIST's casing rather than the typed casing, deliberately: both
 * endpoints document `pair` as "the venue's own symbol, exactly as
 * GET /api/accounts/:label/symbols reports it", and sending back what someone
 * typed would mean sending a spelling the venue never used.
 */
export function canonicalPair(pairs: readonly string[], typed: string): string | null {
  const q = typed.trim().toUpperCase();
  if (q === "") return null;
  return pairs.find((pair) => pair.toUpperCase() === q) ?? null;
}
