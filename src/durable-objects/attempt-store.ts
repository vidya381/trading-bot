/**
 * The real `AttemptStore` (spec section 5.1), backed by Durable Object storage.
 *
 * Step 2 built the idempotency module against an injected port and supplied
 * `InMemoryAttemptStore` for its tests, deliberately leaving the persisted
 * implementation to this step. This is it. The in-memory one stays: section 13
 * backtesting needs a store that touches nothing.
 *
 * THE REFERENCE-LEAK QUESTION
 * ---------------------------
 * Step 2's decision 12 records a bug found in the in-memory store -- it copied
 * records on write but not on read, so a caller mutating a returned record
 * silently corrupted the store -- and asserts that "the persisted implementation
 * at step 6 will not share references either". That was a reasonable
 * expectation, not a measured fact, and Durable Object storage keeps an
 * in-memory write cache in front of SQLite, which is exactly where a shared
 * reference could have survived.
 *
 * It was measured rather than assumed. `storage-probe.test.ts` shows that DO
 * storage returns a fresh structure from every `get`, both after a `put` in the
 * same context and across two reads of the same key, and that mutating either
 * side leaves the other untouched. So this class needs no defensive copying of
 * its own, and `attempt-store.test.ts` runs the same mutation tests against it
 * that caught the original bug -- if a runtime change ever introduced sharing,
 * those fail here rather than surfacing as a corrupted idempotency record.
 *
 * WHY BIGINT IS SAFE HERE AND NOT IN D1
 * -------------------------------------
 * `OrderAttempt` carries no money today, but state stored alongside it does.
 * D1 rejects a bound `bigint` outright and returns INTEGER lossily on read,
 * which is why /src/db encodes money as decimal strings. Durable Object storage
 * has neither problem: it serializes with structuredClone semantics, and the
 * probe confirms values past 2^53 round-trip exactly. So DO state stores
 * `Money` as the `bigint` it is, and the string encoding is applied only at the
 * D1 boundary. Two conventions, each matched to what its storage can actually
 * represent.
 */

import type { AttemptStore, OrderAttempt } from "../shared/idempotency";

/**
 * Key prefix for attempt records.
 *
 * Namespaced because this object's storage also holds its config, state and
 * order history. `list({ prefix })` is the only way to enumerate attempts
 * without also reading everything else, and the probe confirms prefix listing
 * returns keys in lexicographic order.
 */
export const ATTEMPT_KEY_PREFIX = "attempt:";

export function attemptKey(clientOrderId: string): string {
  return `${ATTEMPT_KEY_PREFIX}${clientOrderId}`;
}

/**
 * Attempt records in this Durable Object's own storage.
 *
 * A note on `list()`, which is the port's shape rather than this class's
 * choice: it returns every attempt this bot has ever recorded, and
 * `IdempotencyGuard.highestSequence()` and `unresolvedAttempts()` both call it
 * and filter in JavaScript. That is free for a Map and is not free for storage
 * that, under section 8.7's retain-everything rule, grows for the life of the
 * bot.
 *
 * The Durable Object therefore does not call `highestSequence()` on the
 * order-placing path. It keeps its own monotonic sequence counter in its state
 * and persists it with everything else, so a full scan happens only on the
 * recovery path, where reading every unresolved attempt is the actual point.
 * See the note in `bot-instance.ts`. This is recorded as friction in the
 * decision log rather than fixed by widening the port, because narrowing it
 * properly means adding query methods that the in-memory and backtest
 * implementations would also have to grow.
 */
export class DurableObjectAttemptStore implements AttemptStore {
  readonly #storage: DurableObjectStorage;

  constructor(storage: DurableObjectStorage) {
    this.#storage = storage;
  }

  async get(clientOrderId: string): Promise<OrderAttempt | undefined> {
    return await this.#storage.get<OrderAttempt>(attemptKey(clientOrderId));
  }

  async put(attempt: OrderAttempt): Promise<void> {
    await this.#storage.put(attemptKey(attempt.clientOrderId), attempt);
  }

  async list(): Promise<OrderAttempt[]> {
    const entries = await this.#storage.list<OrderAttempt>({ prefix: ATTEMPT_KEY_PREFIX });
    return [...entries.values()];
  }
}
