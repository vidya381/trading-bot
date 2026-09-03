/**
 * Bot-instance-id validation for the create-bot form.
 *
 * ── WHY THIS IS NOT A REGEX IN THE COMPONENT ANY MORE ──
 *
 * It used to be. `CreateBot.tsx` tested the field against
 * `/^[A-Za-z0-9._:-]+$/`, which is LOOSER THAN THE SERVER IN THREE WAYS: it
 * accepted uppercase letters, `.` and `:`, none of which
 * `BOT_INSTANCE_ID_PATTERN` allows, and it bounded the length not at all where
 * the server stops at 20. Every one of those was a field that passed validation,
 * submitted, and came back as a 400 the form had to translate -- the worst shape
 * for a client-side check, since it teaches the operator that the green field
 * means nothing.
 *
 * So the rule is imported from the backend's own module rather than restated
 * here. `dashboard/src` already reaches into `src/shared` this way
 * (`accountTotals.ts` for money, `driftAlerts.ts` for alert types); the point is
 * that there is one definition of what a bot id is, and the form cannot drift
 * from it without the import breaking.
 *
 * The venue cap is the same story one layer up: `checkBotInstanceIdFitsVenue`
 * is the rule `POST /api/bots` enforces (decision-log entry 90, DECISION 3), and
 * calling it here means the operator is told in the field, before submitting,
 * rather than by a refusal afterwards.
 */

import {
  BOT_INSTANCE_ID_PATTERN,
  MAX_BOT_INSTANCE_ID_LENGTH,
  checkBotInstanceIdFitsVenue,
  venueOrderIdBudget,
} from "../../src/shared/idempotency";

/**
 * The field error for a bot id, or null when it is acceptable.
 *
 * `exchange` is the venue the selected account trades on, as the form already
 * holds it read-only. An empty string means no account is selected yet, in which
 * case only the venue-independent rules can be applied -- and that is correct
 * rather than a gap: picking the account is what makes the venue rule knowable,
 * and `validate()` re-runs on submit when it is.
 */
export function botInstanceIdError(rawId: string, exchange: string): string | null {
  const id = rawId.trim();
  if (id === "") return "Required.";

  // Length before shape: "too long" is a more useful thing to be told than
  // "wrong characters" when an id is both, and it is the more likely mistake.
  if (id.length > MAX_BOT_INSTANCE_ID_LENGTH) {
    return `Use ${MAX_BOT_INSTANCE_ID_LENGTH} characters or fewer (this is ${id.length}).`;
  }
  if (!BOT_INSTANCE_ID_PATTERN.test(id)) {
    return "Use lowercase letters, digits, dash or underscore only, starting with a letter or digit.";
  }

  const violation = checkBotInstanceIdFitsVenue(exchange, id);
  if (violation !== null) {
    // Deliberately shorter than the API's own message, which spells out the
    // whole clientOrderId derivation. Under a form field the operator needs the
    // number to type to, and the reason in one clause.
    return (
      `${violation.venue} caps order ids at ${violation.maxClientOrderIdLength} characters, ` +
      `so a bot id must be ${violation.maxBotInstanceIdLength} or fewer here (this is ` +
      `${violation.actualLength}).`
    );
  }

  return null;
}

/**
 * The longest id this venue will accept, for the field's `maxLength` and help
 * text. Falls back to the scheme-wide maximum when no account is selected yet or
 * the venue is one this build does not know.
 */
export function maxBotInstanceIdLengthFor(exchange: string): number {
  return venueOrderIdBudget(exchange)?.maxBotInstanceIdLength ?? MAX_BOT_INSTANCE_ID_LENGTH;
}
