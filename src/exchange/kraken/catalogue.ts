/**
 * Kraken's pair and asset catalogue (spec section 23.3 touchpoint 2, decision
 * log entry 90 PROBLEM 1).
 *
 * NO BINANCE OR GEMINI ANALOGUE. This module exists because Kraken names the
 * same market four different ways and only one of them is a name the client may
 * send, only one is a name a reply may be keyed by, and neither of those two is
 * the name the rest of this system uses:
 *
 *   canonical  XXBTZUSD    the AssetPairs KEY, and what every reply is keyed by
 *   altname    XBTUSD      what a request may name
 *   wsname     XBT/USD     the websocket/display form
 *   ticker     BTCUSD      what this codebase calls it (`Pair`)
 *
 * `toGeminiSymbol`'s one-line `replace().toLowerCase()` has no Kraken analogue,
 * and the reason is not aesthetic. Kraken is ALIAS-TOLERANT ON INPUT AND
 * CANONICAL ON OUTPUT: `AssetPairs?pair=BTCUSD` and `?pair=XBTUSD` both answer,
 * and both answer under the key `XXBTZUSD` (verified live, entry 90 PART 1). A
 * client can therefore send a name it can never match the reply against.
 *
 * THE CORRUPTION A TRANSFORMATION FUNCTION CAUSES. `BTC` -> `XBT` as a string
 * substitution looks obviously right and is obviously wrong. `WBTCUSD` (Wrapped
 * BTC) and `TBTCUSD` (tBTC) are both live pairs, and the substitution turns them
 * into `WXBTUSD` and `TXBTUSD`, which do not exist. The reverse substitution is
 * worse: `XBT` -> `BTC` turns the live `AIXBTUSD` into the nonexistent
 * `AIBTCUSD`. A ticker the pipeline surfaced legitimately becomes a pair that
 * cannot be traded, and the failure arrives as `EQuery:Unknown asset pair`
 * naming nothing. This is entry 89 PART 5's "silently routing an order into the
 * wrong version of a market", one layer down, as a string-handling bug.
 *
 * SO EVERY ANSWER HERE IS A LOOKUP IN DATA KRAKEN PUBLISHED, never a rule
 * applied to a string. The four indexes below are built from `/0/public/
 * AssetPairs` and `/0/public/Assets` and nothing else -- with exactly one
 * documented exception, `KRAKEN_ASSET_TICKER_ALIASES`, which exists because
 * `BTC` appears in no Kraken response field anywhere (checked across all 839
 * assets: no asset has `BTC` or `DOGE` as its code or its altname). That table
 * is keyed by WHOLE ASSET CODE and is never applied as a substring, which is
 * precisely why `WBTC`, `TBTC` and `AIXBT` pass through it untouched.
 *
 * THE PREFIXING IS PER-FIELD, NOT PER-PAIR. Only 44 of 1440 pair keys differ
 * from their own altname (verified live), which invites the conclusion that the
 * other 1396 need no un-prefixing. They do: `ARBUSD` is keyed plainly, its
 * altname is `ARBUSD`, and its `quote` field still reads `ZUSD`. Asset codes are
 * therefore un-prefixed through `/public/Assets`' own `altname` regardless of
 * how the pair looked -- which balances and every other asset-keyed endpoint
 * need too (entry 90 PROBLEM 1, third bullet).
 *
 * WHERE IT REFUSES TO ANSWER. Two cases, both deliberate, both loud:
 *
 *   - A name this catalogue does not hold resolves to `undefined` (or throws,
 *     via the `require*` forms). It never falls back to a transformation.
 *   - A name that two DIFFERENT pairs claim resolves to `undefined` and is
 *     listed in `ambiguousPairNames`. Today's catalogue has no such collision
 *     across all four naming spaces (checked, all 1440 pairs), but that is a
 *     property of today's data, not a guarantee Kraken makes. Picking a winner
 *     by precedence would be a guess about which market to trade, and that is
 *     the one guess entry 89 ruled out.
 *
 * NOTHING HERE PERFORMS I/O. The client fetches; this parses and indexes; the
 * cache below holds the result. That is the same division `SymbolFilterCache`
 * draws, and for the same reason: every expiry boundary stays reproducible in a
 * test, and the one place that performs I/O stays the client.
 *
 * Unwrapping Kraken's `{error, result}` envelope is NOT this module's job -- the
 * error array is `parse.ts`'s (section 23.3 touchpoint 4). `buildKrakenCatalogue`
 * takes the two `result` objects already unwrapped.
 */

import type { Asset, Pair, Timestamp } from "../../shared/exchange-client";

export class CatalogueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CatalogueError";
  }
}

/**
 * THE ONLY FACT IN THIS FILE THAT KRAKEN DOES NOT PUBLISH.
 *
 * Kraken's `/public/Assets` gives `XXBT` an `altname` of `XBT` -- never `BTC`.
 * `BTC` and `DOGE` appear in no Kraken response field anywhere: not as an asset
 * code, not as an altname, not in a `wsname`, not in a pair's `base`. So the
 * last hop from Kraken's vocabulary to this system's cannot be derived from the
 * catalogue, and pretending otherwise would mean either dropping `BTC` support
 * or inventing a substring rule. This table is the honest third option.
 *
 * KEYED BY WHOLE ASSET CODE, MATCHED WHOLE, NEVER AS A SUBSTRING. That property
 * is the entire point: `WBTC`, `TBTC` and `AIXBT` are distinct assets whose
 * codes merely contain these letters, and a substring rule would rewrite all
 * three into markets that do not exist. Two entries, both of them venue-wide
 * renames Kraken documents (XBT is BTC; XDG is DOGE).
 *
 * SUFFIXED CODES ARE NOT ALIASED, AND THAT IS DELIBERATE. Kraken lists `XBT.M`
 * (bonded/earn BTC), `DOT.S` (staked DOT) and 42 others as assets in their own
 * right. `XBT.M` is not `XBT`, so it is not `BTC`: it resolves to itself. Anything
 * else would report an earn balance as spot BTC -- a wrong number in a balance,
 * which is the failure section 9's reconciliation exists to catch and which this
 * module has no business creating.
 */
export const KRAKEN_ASSET_TICKER_ALIASES: Readonly<Record<string, Asset>> = Object.freeze({
  XBT: "BTC",
  XDG: "DOGE",
});

/** One asset, as Kraken publishes it plus the ticker this system uses. */
export interface KrakenAsset {
  /** Kraken's canonical code: the `/public/Assets` key, e.g. `XXBT`, `ZUSD`. */
  readonly code: string;
  /** Kraken's own short name, e.g. `XBT`, `USD`. Un-prefixing, per the venue. */
  readonly altname: string;
  /** This system's ticker, e.g. `BTC`, `USD`. `altname` after the alias table. */
  readonly ticker: Asset;
  readonly decimals: number;
  readonly displayDecimals: number;
  /** Kraken's raw asset status (`enabled`, `withdrawal_only`). Not interpreted here. */
  readonly status: string;
}

/** One tradable pair, in all four naming spaces at once. */
export interface KrakenPair {
  /** The AssetPairs KEY, e.g. `XXBTZUSD`. What replies are keyed by. */
  readonly canonical: Pair;
  /** The name a request may carry, e.g. `XBTUSD`. */
  readonly altname: string;
  /** The websocket/display form, e.g. `XBT/USD`. */
  readonly wsname: string;
  /** This system's `Pair`, e.g. `BTCUSD`. Built from the two assets' tickers. */
  readonly ticker: Pair;
  readonly base: KrakenAsset;
  readonly quote: KrakenAsset;
  /**
   * Kraken's raw pair status: `online`, `cancel_only`, `post_only`,
   * `limit_only`, `reduce_only`. NOT mapped onto `SymbolStatus` here -- that
   * mapping has to fail closed and is `filters.ts`'s job (touchpoint 3).
   */
  readonly status: string;
  /**
   * The unmodified AssetPairs entry.
   *
   * Carried so `filters.ts` can build `SymbolFilters` from the SAME response
   * this catalogue was built from, rather than the client fetching a 1.1MB
   * document twice and risking two views of one venue.
   */
  readonly raw: Readonly<Record<string, unknown>>;
}

/** An entry the catalogue could not use, kept so it can be logged, not hidden. */
export interface CatalogueOmission {
  readonly key: string;
  readonly reason: string;
}

/**
 * How a result-map key was matched back to a pair. See `selectPairResult`.
 *
 * There is deliberately no `wsname` member. Once separators are stripped, every
 * live pair's wsname IS its altname -- `XBT/USD` -> `XBTUSD` -- on all 1440 of
 * them, checked. A separate arm would report a distinction the venue does not
 * make; a wsname-keyed reply matches, and reports itself as `altname`.
 */
export type ResultMatch = "canonical" | "altname" | "sole-key";

export interface SelectedResult<T> {
  readonly key: string;
  readonly value: T;
  readonly matchedBy: ResultMatch;
}

/**
 * Normalise a PAIR name for lookup: upper-case, separators removed.
 *
 * `XBT/USD`, `BTC-USD` and `btcusd` are all names a bot's config or a Kraken
 * field might carry for a market, and none of them is a different market. No
 * pair name Kraken publishes contains a `.` (checked across all 1440), so
 * stripping punctuation here cannot merge two distinct pairs -- unlike on the
 * asset side, where `.` is load-bearing and `normaliseAssetName` keeps it.
 */
export function normalisePairName(name: string): string {
  return name.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/**
 * Normalise an ASSET code for lookup: upper-case, nothing removed.
 *
 * Deliberately NOT the pair normaliser. Kraken's `.` suffixes name separate
 * assets (`XBT.M` is bonded BTC, `DOT.S` is staked DOT); stripping the dot would
 * collapse `DOT.S` onto `DOTS` and, worse, invite the reading that it is `DOT`.
 */
export function normaliseAssetName(code: string): string {
  return code.toUpperCase();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(
  source: Record<string, unknown>,
  field: string,
): string | undefined {
  const raw = source[field];
  return typeof raw === "string" && raw !== "" ? raw : undefined;
}

function readInteger(source: Record<string, unknown>, field: string): number | undefined {
  const raw = source[field];
  return typeof raw === "number" && Number.isFinite(raw) ? raw : undefined;
}

/**
 * A one-name-to-one-entry index that reports collisions instead of resolving
 * them.
 *
 * Registering the same entry under a name twice is normal and silent -- `WBTCUSD`
 * is its own canonical key, its own altname AND its own ticker. Registering two
 * DIFFERENT entries under one name marks the name ambiguous, and an ambiguous
 * name resolves to `undefined` forever after. Identity comparison, not equality:
 * two distinct pairs are two distinct objects.
 */
class NameIndex<T> {
  readonly #byName = new Map<string, T>();
  readonly #ambiguous = new Set<string>();

  register(name: string, entry: T): void {
    const existing = this.#byName.get(name);
    if (existing === undefined) {
      this.#byName.set(name, entry);
      return;
    }
    if (existing !== entry) this.#ambiguous.add(name);
  }

  get(name: string): T | undefined {
    if (this.#ambiguous.has(name)) return undefined;
    return this.#byName.get(name);
  }

  get ambiguousNames(): readonly string[] {
    return [...this.#ambiguous].sort();
  }
}

/**
 * The catalogue: every name Kraken has for every pair and asset it lists, in
 * both directions.
 *
 * Immutable once built. Holds no timer, fetches nothing, and knows nothing about
 * how old it is -- `KrakenCatalogueCache` answers that, exactly as
 * `SymbolFilterCache` does for filters.
 */
export class KrakenCatalogue {
  readonly #pairs: readonly KrakenPair[];
  readonly #assets: readonly KrakenAsset[];
  readonly #pairIndex: NameIndex<KrakenPair>;
  readonly #assetIndex: NameIndex<KrakenAsset>;

  /** When the underlying AssetPairs/Assets responses were fetched. */
  readonly fetchedAt: Timestamp;
  /** AssetPairs entries that could not be used, with the reason for each. */
  readonly omittedPairs: readonly CatalogueOmission[];
  /** Assets entries that could not be used, with the reason for each. */
  readonly omittedAssets: readonly CatalogueOmission[];

  /** @internal Use `buildKrakenCatalogue`. */
  constructor(init: {
    pairs: readonly KrakenPair[];
    assets: readonly KrakenAsset[];
    pairIndex: NameIndex<KrakenPair>;
    assetIndex: NameIndex<KrakenAsset>;
    fetchedAt: Timestamp;
    omittedPairs: readonly CatalogueOmission[];
    omittedAssets: readonly CatalogueOmission[];
  }) {
    this.#pairs = init.pairs;
    this.#assets = init.assets;
    this.#pairIndex = init.pairIndex;
    this.#assetIndex = init.assetIndex;
    this.fetchedAt = init.fetchedAt;
    this.omittedPairs = init.omittedPairs;
    this.omittedAssets = init.omittedAssets;
  }

  get pairCount(): number {
    return this.#pairs.length;
  }

  get assetCount(): number {
    return this.#assets.length;
  }

  pairs(): readonly KrakenPair[] {
    return this.#pairs;
  }

  assets(): readonly KrakenAsset[] {
    return this.#assets;
  }

  /** Names two different pairs both claim. Each resolves to `undefined`. */
  get ambiguousPairNames(): readonly string[] {
    return this.#pairIndex.ambiguousNames;
  }

  /** Codes two different assets both claim. Each resolves to `undefined`. */
  get ambiguousAssetNames(): readonly string[] {
    return this.#assetIndex.ambiguousNames;
  }

  /**
   * Find a pair by ANY of its four names, or `undefined`.
   *
   * `BTCUSD`, `XBTUSD`, `XXBTZUSD`, `XBT/USD` and `btc-usd` all reach the one
   * `XXBTZUSD` entry. `WBTCUSD` reaches WBTC/USD and `TBTCUSD` reaches TBTC/USD,
   * because each is looked up whole rather than rewritten.
   */
  resolvePair(name: string): KrakenPair | undefined {
    return this.#pairIndex.get(normalisePairName(name));
  }

  /** `resolvePair`, but throws rather than returning `undefined`. */
  requirePair(name: string): KrakenPair {
    const found = this.resolvePair(name);
    if (found !== undefined) return found;
    const normalised = normalisePairName(name);
    if (this.#pairIndex.ambiguousNames.includes(normalised)) {
      throw new CatalogueError(
        `${name}: ambiguous on Kraken -- more than one pair claims the name ` +
          `${normalised}; refusing to guess which market was meant`,
      );
    }
    throw new CatalogueError(
      `${name}: not in Kraken's catalogue of ${this.#pairs.length} pairs ` +
        `(checked as a canonical key, an altname, a wsname and a ticker); ` +
        `refusing to derive a name Kraken did not publish`,
    );
  }

  /** The name to SEND: Kraken's altname, e.g. `BTCUSD` -> `XBTUSD`. */
  requestNameFor(name: string): string {
    return this.requirePair(name).altname;
  }

  /** The key a REPLY will carry: Kraken's canonical, e.g. `BTCUSD` -> `XXBTZUSD`. */
  responseKeyFor(name: string): Pair {
    return this.requirePair(name).canonical;
  }

  /** This system's `Pair` for any Kraken name, e.g. `XXBTZUSD` -> `BTCUSD`. */
  tickerForPair(name: string): Pair {
    return this.requirePair(name).ticker;
  }

  /** Find an asset by its code, its altname or its ticker. */
  resolveAsset(code: string): KrakenAsset | undefined {
    return this.#assetIndex.get(normaliseAssetName(code));
  }

  /** `resolveAsset`, but throws rather than returning `undefined`. */
  requireAsset(code: string): KrakenAsset {
    const found = this.resolveAsset(code);
    if (found !== undefined) return found;
    throw new CatalogueError(
      `${code}: not in Kraken's catalogue of ${this.#assets.length} assets ` +
        `(checked as a code, an altname and a ticker); refusing to guess a ticker`,
    );
  }

  /**
   * UN-PREFIX an asset code: `ZUSD` -> `USD`, `XXBT` -> `BTC`, `ARB` -> `ARB`.
   *
   * What balances and every other asset-keyed endpoint need. Note the third
   * example: most codes are already plain, and the prefixing is per-field, so
   * this must be called on EVERY code rather than only on ones that look
   * prefixed. Throws on an unknown code, because a balance mislabelled with a
   * guessed ticker is a wrong number in a place section 9 will have to
   * reconcile, and an unknown code means this catalogue is stale -- which the
   * caller can fix by refetching, but only if it is told.
   */
  tickerForAsset(code: string): Asset {
    return this.requireAsset(code).ticker;
  }

  /** The reverse: this system's ticker -> Kraken's code. `BTC` -> `XXBT`. */
  assetCodeFor(ticker: Asset): string {
    return this.requireAsset(ticker).code;
  }

  /**
   * Read the one entry for `pair` out of a Kraken result map.
   *
   * EVERY KRAKEN RESPONSE IS A MAP KEYED BY A NAME THE CLIENT DID NOT CHOOSE, so
   * `result[requested]` is never valid (entry 90 PROBLEM 1). This tries the
   * pair's canonical key and its altname -- which covers a wsname-keyed reply
   * too, since the two are one string once separators are stripped -- and, only
   * if neither matches and the map holds exactly ONE entry, returns that entry
   * marked `sole-key`.
   *
   * That last case is entry 90's "or read the single key out of the map". It is
   * reported rather than hidden: a caller placing an order can insist on a
   * `canonical` match, while a caller reading a ticker for a pair it just asked
   * about can accept `sole-key`. Making it a returned fact rather than an
   * internal fallback is the whole point -- an unreported guess here is an order
   * priced off the wrong book.
   */
  selectPairResult<T>(
    result: Readonly<Record<string, T>>,
    pair: KrakenPair,
  ): SelectedResult<T> | undefined {
    const entries = Object.entries(result);
    const attempts: readonly (readonly [ResultMatch, string])[] = [
      ["canonical", pair.canonical],
      ["altname", pair.altname],
    ];
    for (const [matchedBy, wanted] of attempts) {
      const target = normalisePairName(wanted);
      for (const [key, value] of entries) {
        if (normalisePairName(key) === target) return { key, value, matchedBy };
      }
    }
    if (entries.length === 1) {
      const [key, value] = entries[0]!;
      return { key, value, matchedBy: "sole-key" };
    }
    return undefined;
  }
}

/**
 * Build the catalogue from `/0/public/AssetPairs` and `/0/public/Assets`.
 *
 * Both arguments are the `result` OBJECT, already unwrapped from Kraken's
 * `{error, result}` envelope -- the error array belongs to `parse.ts`.
 *
 * FAILURE POLICY, AND WHY IT IS SPLIT. A response that is not an object at all
 * throws: the venue's contract is broken and there is nothing to index. A single
 * unusable ENTRY among 1440 is omitted and recorded in `omittedPairs` instead,
 * because taking the whole venue down over one malformed listing would be a
 * worse failure than the one it prevents -- and the pair is not silently lost
 * either: any attempt to resolve it fails loudly, naming it. A response with no
 * usable pairs throws, since caching an empty catalogue would turn one bad fetch
 * into a venue that appears to list nothing.
 */
export function buildKrakenCatalogue(input: {
  assetPairs: unknown;
  assets: unknown;
  fetchedAt: Timestamp;
}): KrakenCatalogue {
  const { assetPairs, assets, fetchedAt } = input;
  if (!isRecord(assets)) {
    throw new CatalogueError(
      `Assets result is not an object (got ${assets === null ? "null" : typeof assets})`,
    );
  }
  if (!isRecord(assetPairs)) {
    throw new CatalogueError(
      `AssetPairs result is not an object (got ${
        assetPairs === null ? "null" : typeof assetPairs
      })`,
    );
  }

  const assetList: KrakenAsset[] = [];
  const assetIndex = new NameIndex<KrakenAsset>();
  const assetsByCode = new Map<string, KrakenAsset>();
  const omittedAssets: CatalogueOmission[] = [];

  for (const [code, entry] of Object.entries(assets)) {
    if (!isRecord(entry)) {
      omittedAssets.push({ key: code, reason: "entry is not an object" });
      continue;
    }
    const altname = readString(entry, "altname");
    if (altname === undefined) {
      omittedAssets.push({ key: code, reason: "no usable altname" });
      continue;
    }
    // The alias table is consulted on the WHOLE altname, so `WBTC` and `AIXBT`
    // pass through untouched and `XBT.M` stays `XBT.M`. See its own comment.
    const ticker = KRAKEN_ASSET_TICKER_ALIASES[altname.toUpperCase()] ?? altname;
    const asset: KrakenAsset = {
      code,
      altname,
      ticker,
      decimals: readInteger(entry, "decimals") ?? 0,
      displayDecimals: readInteger(entry, "display_decimals") ?? 0,
      status: readString(entry, "status") ?? "",
    };
    assetList.push(asset);
    assetsByCode.set(code, asset);
    assetIndex.register(normaliseAssetName(code), asset);
    assetIndex.register(normaliseAssetName(altname), asset);
    assetIndex.register(normaliseAssetName(ticker), asset);
  }

  const pairList: KrakenPair[] = [];
  const pairIndex = new NameIndex<KrakenPair>();
  const omittedPairs: CatalogueOmission[] = [];

  for (const [canonical, entry] of Object.entries(assetPairs)) {
    if (!isRecord(entry)) {
      omittedPairs.push({ key: canonical, reason: "entry is not an object" });
      continue;
    }
    const altname = readString(entry, "altname");
    const wsname = readString(entry, "wsname");
    const baseCode = readString(entry, "base");
    const quoteCode = readString(entry, "quote");
    if (altname === undefined || baseCode === undefined || quoteCode === undefined) {
      omittedPairs.push({
        key: canonical,
        reason: "missing altname, base or quote",
      });
      continue;
    }
    const base = assetsByCode.get(baseCode);
    const quote = assetsByCode.get(quoteCode);
    if (base === undefined || quote === undefined) {
      // Un-prefixing is per-field, so a pair whose assets are not in the Assets
      // response cannot be given a ticker without inventing one.
      omittedPairs.push({
        key: canonical,
        reason: `asset ${base === undefined ? baseCode : quoteCode} is not in the Assets response`,
      });
      continue;
    }
    const pair: KrakenPair = {
      canonical,
      altname,
      wsname: wsname ?? "",
      ticker: `${base.ticker}${quote.ticker}`,
      base,
      quote,
      status: readString(entry, "status") ?? "",
      raw: entry,
    };
    pairList.push(pair);
    pairIndex.register(normalisePairName(canonical), pair);
    pairIndex.register(normalisePairName(altname), pair);
    if (wsname !== undefined) pairIndex.register(normalisePairName(wsname), pair);
    pairIndex.register(normalisePairName(pair.ticker), pair);
  }

  if (pairList.length === 0) {
    throw new CatalogueError(
      `AssetPairs yielded no usable pairs out of ${Object.keys(assetPairs).length} ` +
        `entries; refusing to build a catalogue that resolves nothing`,
    );
  }

  return new KrakenCatalogue({
    pairs: pairList,
    assets: assetList,
    pairIndex,
    assetIndex,
    fetchedAt,
    omittedPairs,
    omittedAssets,
  });
}

/**
 * How long a fetched catalogue stays usable.
 *
 * The same hour `DEFAULT_FILTER_MAX_AGE_MS` gives filters, and deliberately so:
 * both answer "what does this venue currently list", both go stale the moment
 * Kraken lists or delists something, and giving them different lifetimes would
 * mean a client that holds filters for a pair its catalogue can no longer name.
 */
export const DEFAULT_CATALOGUE_MAX_AGE_MS = 3_600_000;

/**
 * The cached catalogue, with an age.
 *
 * Deliberately the same shape as `SymbolFilterCache` (`binance/filters.ts`) --
 * `put`/`get`/`peek`/`isStale`/`invalidate`, an age it reports rather than a
 * timer it runs, and no fetching of its own. The client decides to refetch. Two
 * differences follow from the data, not from a different opinion about caching:
 * it holds ONE catalogue rather than a map keyed by pair (Kraken publishes the
 * whole catalogue in one document, and half a catalogue is not a thing that can
 * be fetched), and `get` takes only `now`.
 */
export class KrakenCatalogueCache {
  #entry: KrakenCatalogue | undefined;
  readonly #maxAgeMs: number;

  constructor(options: { maxAgeMs?: number } = {}) {
    const maxAge = options.maxAgeMs ?? DEFAULT_CATALOGUE_MAX_AGE_MS;
    if (!Number.isFinite(maxAge) || maxAge <= 0) {
      throw new CatalogueError(`maxAgeMs must be positive, got ${maxAge}`);
    }
    this.#maxAgeMs = maxAge;
  }

  get maxAgeMs(): number {
    return this.#maxAgeMs;
  }

  put(catalogue: KrakenCatalogue): void {
    this.#entry = catalogue;
  }

  /** The catalogue if present AND still fresh; otherwise undefined. */
  get(now: Timestamp): KrakenCatalogue | undefined {
    if (this.#entry === undefined) return undefined;
    return this.isStale(this.#entry, now) ? undefined : this.#entry;
  }

  /**
   * The catalogue regardless of age.
   *
   * Separate from `get` so that using a stale catalogue is always a deliberate
   * act at the call site rather than something that happens by default.
   */
  peek(): KrakenCatalogue | undefined {
    return this.#entry;
  }

  isStale(catalogue: KrakenCatalogue, now: Timestamp): boolean {
    return now - catalogue.fetchedAt >= this.#maxAgeMs;
  }

  invalidate(): void {
    this.#entry = undefined;
  }
}
