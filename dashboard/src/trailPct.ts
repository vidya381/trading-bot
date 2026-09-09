/**
 * `trailPct` validation for the create-bot form.
 *
 * ── WHY THIS IS NOT A NUMBER LITERAL IN THE COMPONENT ──
 *
 * Because the bounds are not settled. `TRAIL_PCT_MIN`/`TRAIL_PCT_MAX` are marked
 * PROVISIONAL in `src/strategies/trailing-stop.ts` (spec 22.5 open question 1):
 * "a deliberate starting range, not a backtested result", and that file says in
 * as many words that when they are settled, "this constant pair and the message
 * below are the only things that change". A `1` and a `20` typed into
 * `CreateBot.tsx` would make that false -- the form would keep enforcing the old
 * range after the backend moved, and the operator would be refused in the field
 * for a value the server now accepts, or (worse) waved through to a 400.
 *
 * So the range is IMPORTED from the validator that owns it, exactly as
 * `botId.ts` imports `BOT_INSTANCE_ID_PATTERN` and `checkBotInstanceIdFitsVenue`
 * rather than restating them, and as `accountTotals.ts` reaches across the same
 * seam for the money helpers. There is one definition of what a legal trail is,
 * and the form cannot drift from it without the import breaking.
 *
 * ── AND WHY IT IS A SEPARATE FILE RATHER THAN A HELPER IN THE `.tsx` ──
 *
 * `proposalFields.ts` records the mechanism: a decision written inline in a
 * component is a decision NO TEST IN THIS REPOSITORY CAN REACH, because a test
 * importing a `.tsx` collects zero tests rather than failing inside the Workers
 * pool the suite runs in (docs/open-items/component-test-harness.md). A mutation
 * run proved a deleted guard survived that way. This module is React-free so
 * `trailPct.test.ts` can drive it directly -- and, more than that, can drive the
 * BACKEND'S OWN validator over the same inputs and assert the two agree.
 *
 * ── WHAT IT DELIBERATELY DOES NOT CHECK ──
 *
 * Nothing about capital. `validateTrailingStopParams` also refuses a
 * non-positive `allocatedCapital`, but that is the allocated-capital field's
 * rule and the form already applies `requirePositive` to it; re-checking it here
 * would put one field's error under another field's label. Everything the ledger
 * knows -- availability, the account's own allocation -- stays the server's, the
 * way the create form's docblock says capital is always the server's truth.
 */

import { fromDecimalString, toTrimmedString } from "../../src/shared/money";
import { TRAIL_PCT_MAX, TRAIL_PCT_MIN } from "../../src/strategies/trailing-stop";

/**
 * The permitted range, rendered for help text and error messages.
 *
 * Derived from the `Money` constants rather than written out, so the words the
 * operator reads move when the range does. `toTrimmedString` drops the scale's
 * trailing zeros, so these read "1" and "20" rather than "1.00000000".
 */
export const TRAIL_PCT_MIN_TEXT = toTrimmedString(TRAIL_PCT_MIN);
export const TRAIL_PCT_MAX_TEXT = toTrimmedString(TRAIL_PCT_MAX);

/**
 * The same decimal grammar the rest of the form uses (`DECIMAL` in
 * `CreateBot.tsx`): digits, one optional dot, at most 8 fractional places, no
 * sign. It is the non-negative half of `money.ts`'s own `DECIMAL_PATTERN`, which
 * is what `fromDecimalString` parses with -- so anything this accepts, the
 * parser below accepts too, and no float is ever constructed on the way.
 */
const DECIMAL = /^\d+(\.\d{1,8})?$/;

/**
 * The field error for a trail percentage, or null when the server would take it.
 *
 * ⚠ THE ACCEPTED SET IS EXACTLY THE SERVER'S, AND IS NEITHER WIDENED NOR
 * NARROWED. `validateTrailingStopParams` raises three separate refusals --
 * `<= 0`, `>= 100`, and outside `[TRAIL_PCT_MIN, TRAIL_PCT_MAX]` -- but the
 * third is strictly the tightest of the three, so a value passing it passes all
 * of them and a value failing it fails at least one. One range check here is
 * therefore the same predicate, not an approximation of it, and
 * `trailPct.test.ts` pins that equivalence by running the real validator.
 *
 * The three-way split exists on the server so the message can say WHICH kind of
 * wrong a value is. Under a form field there is one number to type to, so the
 * range is stated once, with the reason in a clause -- the shortening `botId.ts`
 * makes for the same reason.
 */
export function trailPctError(raw: string): string | null {
  const t = raw.trim();
  if (t === "") return "Required.";
  if (!DECIMAL.test(t)) return "Enter a percentage (up to 8 decimal places).";

  // Exact integer arithmetic, in the backend's own representation, compared
  // against the backend's own constants. No float, and no second opinion about
  // what "1" or "20" means.
  const value = fromDecimalString(t);
  if (value < TRAIL_PCT_MIN || value > TRAIL_PCT_MAX) {
    return (
      `Must be between ${TRAIL_PCT_MIN_TEXT}% and ${TRAIL_PCT_MAX_TEXT}%: below that, ordinary ` +
      `market noise exits the position almost immediately; above it, the trail gives back most ` +
      `of what it gained before it triggers.`
    );
  }
  return null;
}
