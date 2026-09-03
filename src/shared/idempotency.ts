/**
 * Idempotency (spec section 5.1).
 *
 * Two responsibilities:
 *  1. Generate a `clientOrderId` deterministically from the bot instance and an
 *     internal sequence number, so the same logical order always produces the
 *     same id no matter how many times a queue message is redelivered.
 *  2. Track attempt records, so a consumer that has already recorded
 *     "attempting to place order X" looks the order up by its id instead of
 *     placing a duplicate.
 *
 * Storage is injected as a port. There is no Durable Object here -- step 6
 * supplies an implementation backed by DO storage.
 */

import type { Timestamp } from "./exchange-client";

/**
 * Maximum `clientOrderId` length the exchange accepts.
 *
 * Binance caps this at 36 characters. It is enforced here rather than at the
 * Binance client, because an id that the exchange will reject must fail when it
 * is generated, not after an order has already been recorded as attempted.
 */
export const MAX_CLIENT_ORDER_ID_LENGTH = 36;

/**
 * Prefix identifying the id scheme.
 *
 * Versioned so the format can change later without making old ids ambiguous:
 * a parser can tell a v1 id from a future v2 one.
 */
export const CLIENT_ORDER_ID_SCHEME = "v1";

/**
 * Bot instance ids must be short lowercase slugs.
 *
 * This constrains how bot instance ids are minted at step 6, and the reason is
 * worth stating: the id is embedded in the `clientOrderId` verbatim so that
 * reconciliation (section 9) can look at an unexpected open order on the
 * exchange and say which bot owns it. A hash would fit any input but would make
 * an orphaned order untraceable, which is precisely the case reconciliation
 * exists to investigate.
 */
export const BOT_INSTANCE_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,19}$/;

/**
 * Largest permitted sequence number: 12 digits.
 *
 * Chosen so the length invariant is total rather than dependent on the caller.
 * The longest possible id is "v1-" (3) + a 20-character slug + "-" (1) + 12
 * digits = exactly MAX_CLIENT_ORDER_ID_LENGTH. Without this bound a valid slug
 * combined with a large sequence could produce an id the exchange rejects, and
 * it would only be discovered at the moment an order was being placed.
 *
 * A trillion orders is far beyond anything a bot instance will reach.
 */
export const MAX_SEQUENCE = 999_999_999_999;

// ---------------------------------------------------------------------------
// PER-VENUE CLIENT-ORDER-ID BUDGETS (decision-log entry 90, DECISION 3)
// ---------------------------------------------------------------------------

/**
 * The longest bot instance id `BOT_INSTANCE_ID_PATTERN` accepts.
 *
 * Stated as a number because the budget arithmetic below needs it and a regex
 * quantifier cannot be read at runtime. `idempotency.test.ts` asserts the two
 * agree in both directions, so this cannot drift from the pattern silently.
 */
export const MAX_BOT_INSTANCE_ID_LENGTH = 20;

/**
 * What the scheme itself spends: `"v1"` + `"-"` before the slug, and the `"-"`
 * between the slug and the sequence. `v1-<slug>-<sequence>`.
 */
export const CLIENT_ORDER_ID_OVERHEAD = CLIENT_ORDER_ID_SCHEME.length + 2;

/**
 * Venues whose client-order-id ceiling this module knows.
 *
 * DELIBERATELY WIDER THAN `ExchangeId`, which is `"binance" | "gemini"` and is
 * not changed here. Kraken is not yet a venue a bot can be created on -- entry
 * 90 step (c), the Kraken client, does not exist -- but its ceiling is known
 * now, and the gate below is wired into bot creation now, so that enabling the
 * venue later is a one-line change to `ExchangeId` rather than a change that
 * also has to remember this. `db/schema.ts`'s `ExchangeId` is a subset of this
 * type, and `handlers.ts` asserts that at compile time.
 */
export type VenueId = "binance" | "gemini" | "kraken";

export interface VenueOrderIdBudget {
  /** The venue's own `clientOrderId` ceiling, in characters. */
  readonly maxClientOrderIdLength: number;
  /** How much of that is left for the bot instance id. */
  readonly maxBotInstanceIdLength: number;
  /** The remainder, reserved for the sequence number's digits. */
  readonly reservedSequenceDigits: number;
}

/**
 * How the three numbers per venue were chosen.
 *
 * `maxClientOrderIdLength` is the venue's rule and nothing else. The split of
 * the remainder into slug and sequence digits IS a choice, and it is a choice
 * about a bot's whole life: sequence numbers are allocated monotonically and
 * never reused (`IdempotencyGuard.decide` -- "a fresh order needs a fresh
 * sequence"), so the digits reserved here are a hard ceiling on how many orders
 * one bot instance may ever place on that venue.
 *
 * - **binance / gemini** keep the scheme's original split unchanged: a
 *   20-character slug and 12 digits, which is `MAX_CLIENT_ORDER_ID_LENGTH`
 *   exactly. Nothing about these two venues is altered by this table.
 *
 * - **kraken** caps `cl_ord_id` at 18 characters for free-format text, which
 *   `v1-<slug>-<sequence>` is (it is neither a 36-character UUID nor 32 hex
 *   characters, the two other forms Kraken accepts). That leaves 14 for slug
 *   plus digits. Entry 90 measured the real `bot_instances` rows: the longest
 *   id in use is 11 characters, and 30 of 31 are 10 or shorter. An 11-character
 *   budget would leave 3 digits -- 1,000 orders in a bot's lifetime, which is
 *   reachable. 10 leaves 4 digits and 10,000 orders, which is not, and it is
 *   what the generated ids already are. Hence 10.
 */
export const VENUE_ORDER_ID_BUDGETS: Readonly<Record<VenueId, VenueOrderIdBudget>> = {
  binance: { maxClientOrderIdLength: 36, maxBotInstanceIdLength: 20, reservedSequenceDigits: 12 },
  gemini: { maxClientOrderIdLength: 36, maxBotInstanceIdLength: 20, reservedSequenceDigits: 12 },
  kraken: { maxClientOrderIdLength: 18, maxBotInstanceIdLength: 10, reservedSequenceDigits: 4 },
};

/** The budget for a venue name, or null if this module does not know it. */
export function venueOrderIdBudget(venue: string): VenueOrderIdBudget | null {
  return Object.hasOwn(VENUE_ORDER_ID_BUDGETS, venue)
    ? VENUE_ORDER_ID_BUDGETS[venue as VenueId]
    : null;
}

/** Why one bot instance id does not fit one venue. Every number the message needs. */
export interface VenueIdLengthViolation {
  readonly venue: VenueId;
  readonly botInstanceId: string;
  readonly actualLength: number;
  readonly maxBotInstanceIdLength: number;
  readonly maxClientOrderIdLength: number;
  /** What `makeClientOrderId` would emit for this id at sequence 0. */
  readonly shortestClientOrderId: string;
}

/**
 * Does this bot instance id fit this venue's client-order-id ceiling?
 *
 * Returns the violation rather than throwing, so the API layer can turn it into
 * its own refusal and the dashboard can turn it into field text, from one rule.
 *
 * ── WHY THIS IS INERT FOR BINANCE AND GEMINI, BY CONSTRUCTION ──
 *
 * A venue whose slug budget is the scheme-wide maximum is not constrained by
 * this gate at all, and the early return below says so explicitly rather than
 * relying on the arithmetic to work out. That matters: an id longer than
 * `MAX_BOT_INSTANCE_ID_LENGTH` is ALREADY refused, by `assertBotInstanceId` in
 * `capital/ledger.ts`, with the `invalid_bot_instance_id` error and message
 * that names the real rule. If this gate also rejected such an id it would get
 * there first and change that refusal's code and wording on two venues that
 * have no Kraken problem. It must not. So for binance and gemini this function
 * returns null for every input, including inputs that are invalid for other
 * reasons, and the existing refusal stands untouched.
 *
 * An unknown venue also returns null: this module refusing a venue it has no
 * ceiling for would be inventing a limit, and `isExchangeId` is what guards
 * unknown venue strings.
 */
export function checkBotInstanceIdFitsVenue(
  venue: string,
  botInstanceId: string,
): VenueIdLengthViolation | null {
  const budget = venueOrderIdBudget(venue);
  if (budget === null) return null;
  if (budget.maxBotInstanceIdLength >= MAX_BOT_INSTANCE_ID_LENGTH) return null;
  if (botInstanceId.length <= budget.maxBotInstanceIdLength) return null;

  return {
    venue: venue as VenueId,
    botInstanceId,
    actualLength: botInstanceId.length,
    maxBotInstanceIdLength: budget.maxBotInstanceIdLength,
    maxClientOrderIdLength: budget.maxClientOrderIdLength,
    shortestClientOrderId: `${CLIENT_ORDER_ID_SCHEME}-${botInstanceId}-0`,
  };
}

/**
 * The violation as one sentence, shared by the API refusal and the dashboard so
 * an operator reads the same explanation in both places.
 */
export function describeVenueIdLengthViolation(violation: VenueIdLengthViolation): string {
  return (
    `bot instance id ${JSON.stringify(violation.botInstanceId)} is ` +
    `${violation.actualLength} characters, over the ` +
    `${violation.maxBotInstanceIdLength} that ${violation.venue} allows: it is embedded in ` +
    `every clientOrderId, and ${violation.venue} caps those at ` +
    `${violation.maxClientOrderIdLength} characters ` +
    `(${JSON.stringify(violation.shortestClientOrderId)} is already ` +
    `${violation.shortestClientOrderId.length}). Use a shorter id.`
  );
}

export type IdempotencyErrorCode =
  | "invalid_bot_instance_id"
  | "invalid_sequence"
  | "client_order_id_too_long"
  | "unknown_attempt"
  | "attempt_already_resolved";

export class IdempotencyError extends Error {
  readonly code: IdempotencyErrorCode;

  constructor(code: IdempotencyErrorCode, message: string) {
    super(message);
    this.name = "IdempotencyError";
    this.code = code;
  }
}

/**
 * Build the deterministic `clientOrderId` for one bot instance and sequence
 * number. Pure: the same inputs always produce the same id.
 */
export function makeClientOrderId(botInstanceId: string, sequence: number): string {
  if (!BOT_INSTANCE_ID_PATTERN.test(botInstanceId)) {
    throw new IdempotencyError(
      "invalid_bot_instance_id",
      `bot instance id ${JSON.stringify(botInstanceId)} must be 1-20 characters ` +
        `of [a-z0-9_-] and start with a letter or digit`,
    );
  }

  if (!Number.isSafeInteger(sequence) || sequence < 0 || sequence > MAX_SEQUENCE) {
    throw new IdempotencyError(
      "invalid_sequence",
      `sequence must be an integer in [0, ${MAX_SEQUENCE}], got ${sequence}`,
    );
  }

  const id = `${CLIENT_ORDER_ID_SCHEME}-${botInstanceId}-${sequence}`;
  /* c8 ignore start -- unreachable given the bounds above; kept as a guard so a
     future change to the scheme or the bounds cannot silently emit an id the
     exchange would reject. */
  if (id.length > MAX_CLIENT_ORDER_ID_LENGTH) {
    throw new IdempotencyError(
      "client_order_id_too_long",
      `generated id ${JSON.stringify(id)} is ${id.length} characters, ` +
        `over the ${MAX_CLIENT_ORDER_ID_LENGTH} the exchange accepts`,
    );
  }
  /* c8 ignore stop */
  return id;
}

/**
 * Recover the bot instance and sequence from a `clientOrderId`.
 *
 * Returns null for anything not matching the current scheme, including ids not
 * generated by this system -- which is exactly what reconciliation needs in
 * order to spot an order it did not place.
 */
export function parseClientOrderId(
  clientOrderId: string,
): { botInstanceId: string; sequence: number } | null {
  const prefix = `${CLIENT_ORDER_ID_SCHEME}-`;
  if (!clientOrderId.startsWith(prefix)) return null;

  const body = clientOrderId.slice(prefix.length);
  // The sequence is the digits after the final separator; the bot instance id
  // may itself contain "-", so split from the right.
  const separator = body.lastIndexOf("-");
  if (separator <= 0) return null;

  const botInstanceId = body.slice(0, separator);
  const sequenceText = body.slice(separator + 1);

  if (!BOT_INSTANCE_ID_PATTERN.test(botInstanceId)) return null;
  if (!/^\d+$/.test(sequenceText)) return null;

  const sequence = Number(sequenceText);
  if (!Number.isSafeInteger(sequence)) return null;

  return { botInstanceId, sequence };
}

/**
 * Lifecycle of an attempt record.
 *
 * `attempting` is written BEFORE the order is sent. That ordering is the whole
 * point: if the Worker dies between recording and sending, the record still
 * exists, and recovery looks the order up rather than sending it again.
 */
export type AttemptState =
  /** Recorded, outcome unknown. The order may or may not exist on the exchange. */
  | "attempting"
  /** The exchange acknowledged the order. */
  | "placed"
  /** Confirmed never to have reached the exchange; the sequence is spent regardless. */
  | "failed";

export interface OrderAttempt {
  clientOrderId: string;
  botInstanceId: string;
  sequence: number;
  state: AttemptState;
  recordedAt: Timestamp;
  updatedAt: Timestamp;
  /** Present once the exchange has acknowledged the order. */
  exchangeOrderId?: string;
  /** Why the attempt failed, when it did. */
  failureReason?: string;
}

/**
 * Storage port for attempt records.
 *
 * Deliberately minimal so a Durable Object can satisfy it directly at step 6.
 */
export interface AttemptStore {
  get(clientOrderId: string): Promise<OrderAttempt | undefined>;
  put(attempt: OrderAttempt): Promise<void>;
  list(): Promise<OrderAttempt[]>;
}

/** In-memory store, for tests and for backtesting (section 13). */
export class InMemoryAttemptStore implements AttemptStore {
  readonly #attempts = new Map<string, OrderAttempt>();

  // Copies on the way in and on the way out. A caller that mutates a record it
  // received must not be able to change what is stored, because the persisted
  // implementation at step 6 will not share references either -- so behaviour
  // that only works in memory would not survive the switch.
  async get(clientOrderId: string): Promise<OrderAttempt | undefined> {
    const stored = this.#attempts.get(clientOrderId);
    return stored === undefined ? undefined : { ...stored };
  }

  async put(attempt: OrderAttempt): Promise<void> {
    this.#attempts.set(attempt.clientOrderId, { ...attempt });
  }

  async list(): Promise<OrderAttempt[]> {
    return [...this.#attempts.values()].map((attempt) => ({ ...attempt }));
  }
}

/**
 * What the caller should do about a requested order.
 *
 * `place` and `recover` are the two halves of section 5.1: a first attempt
 * sends the order, a redelivery looks it up by `clientOrderId` instead.
 */
export type AttemptDecision =
  | { action: "place"; clientOrderId: string; attempt: OrderAttempt }
  | { action: "recover"; clientOrderId: string; attempt: OrderAttempt; reason: string };

/**
 * Enforces the record-before-place protocol for one bot instance.
 *
 * Holds no state of its own; everything lives in the injected store, so it is
 * safe to construct per request.
 */
export class IdempotencyGuard {
  readonly #store: AttemptStore;
  readonly #botInstanceId: string;

  constructor(store: AttemptStore, botInstanceId: string) {
    if (!BOT_INSTANCE_ID_PATTERN.test(botInstanceId)) {
      throw new IdempotencyError(
        "invalid_bot_instance_id",
        `bot instance id ${JSON.stringify(botInstanceId)} is not a valid slug`,
      );
    }
    this.#store = store;
    this.#botInstanceId = botInstanceId;
  }

  get botInstanceId(): string {
    return this.#botInstanceId;
  }

  /** The id this bot instance will use for a given sequence number. */
  clientOrderIdFor(sequence: number): string {
    return makeClientOrderId(this.#botInstanceId, sequence);
  }

  /**
   * Decide whether to place an order for this sequence number, recording the
   * attempt first when the answer is yes.
   *
   * Every previously seen sequence returns `recover`, including one that
   * previously failed: an attempt whose outcome was ambiguous must never be
   * resent under the same id, and a fresh order needs a fresh sequence.
   */
  async beginAttempt(sequence: number, at: Timestamp): Promise<AttemptDecision> {
    const clientOrderId = this.clientOrderIdFor(sequence);
    const existing = await this.#store.get(clientOrderId);

    if (existing !== undefined) {
      return {
        action: "recover",
        clientOrderId,
        attempt: existing,
        reason:
          `order ${clientOrderId} was already recorded as "${existing.state}"; ` +
          `look up its status by clientOrderId instead of placing it again`,
      };
    }

    const attempt: OrderAttempt = {
      clientOrderId,
      botInstanceId: this.#botInstanceId,
      sequence,
      state: "attempting",
      recordedAt: at,
      updatedAt: at,
    };

    // Written before the caller sends anything. If the isolate dies here, the
    // record survives and the retry path takes `recover`.
    await this.#store.put(attempt);
    return { action: "place", clientOrderId, attempt };
  }

  /** Record that the exchange acknowledged the order. */
  async markPlaced(
    clientOrderId: string,
    exchangeOrderId: string,
    at: Timestamp,
  ): Promise<OrderAttempt> {
    return this.#resolve(clientOrderId, at, (attempt) => ({
      ...attempt,
      state: "placed",
      exchangeOrderId,
      updatedAt: at,
    }));
  }

  /**
   * Record that the order definitively never reached the exchange.
   *
   * Only for a confirmed rejection. A timeout or transport failure leaves the
   * outcome unknown, so it must stay `attempting` and be resolved by looking
   * the order up -- see section 5.6 on not treating unreachable as an answer.
   */
  async markFailed(
    clientOrderId: string,
    reason: string,
    at: Timestamp,
  ): Promise<OrderAttempt> {
    return this.#resolve(clientOrderId, at, (attempt) => ({
      ...attempt,
      state: "failed",
      failureReason: reason,
      updatedAt: at,
    }));
  }

  /** Attempts still awaiting an outcome, oldest first -- the recovery worklist. */
  async unresolvedAttempts(): Promise<OrderAttempt[]> {
    const all = await this.#store.list();
    return all
      .filter(
        (attempt) =>
          attempt.state === "attempting" && attempt.botInstanceId === this.#botInstanceId,
      )
      .sort((a, b) => a.sequence - b.sequence);
  }

  /** Highest sequence number used so far, or -1 if none. */
  async highestSequence(): Promise<number> {
    const all = await this.#store.list();
    return all
      .filter((attempt) => attempt.botInstanceId === this.#botInstanceId)
      .reduce((highest, attempt) => Math.max(highest, attempt.sequence), -1);
  }

  async #resolve(
    clientOrderId: string,
    _at: Timestamp,
    update: (attempt: OrderAttempt) => OrderAttempt,
  ): Promise<OrderAttempt> {
    const existing = await this.#store.get(clientOrderId);
    if (existing === undefined) {
      throw new IdempotencyError(
        "unknown_attempt",
        `no attempt recorded for ${clientOrderId}`,
      );
    }
    if (existing.state !== "attempting") {
      throw new IdempotencyError(
        "attempt_already_resolved",
        `attempt ${clientOrderId} is already "${existing.state}"`,
      );
    }
    const updated = update(existing);
    await this.#store.put(updated);
    return updated;
  }
}
