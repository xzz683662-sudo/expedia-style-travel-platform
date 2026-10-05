import { config } from '../../config/env';
import { logger } from '../../lib/logger';
import { cacheGet, cacheSet } from '../../utils/redis';
import { convertMinorUnits } from '../../utils/fx';

/**
 * ---------------------------------------------------------------------------
 * Live supply — real-time rates and sellability
 * ---------------------------------------------------------------------------
 *
 * A third kind of source, alongside the two that already exist here:
 *
 *   - {@link ./source.ts | SupplySource}  streams identity/geometry into the
 *     canonical tables. Writes rows.
 *   - {@link ./realtime-flight.ts | RealtimeFlightFinder}  answers "where is
 *     this aircraft right now". Writes nothing, but carries no commercial data.
 *   - **This module**  answers "what does it cost and can I still sell it",
 *     writes nothing, and feeds the *pricing* engine rather than the search
 *     index.
 *
 * Why it is a separate file and not an extension of `SupplySource`
 * ---------------------------------------------------------------------
 * `SupplySource` is an importer: `getRates` exists so an adapter can declare
 * "I have no rates, derive them". Live rate data has the opposite shape — it is
 * the authority, consulted per request, and must never be bulk-written into
 * `TicketType.basePriceCents`, because that column is the price a *previous*
 * order was priced against. Folding live rates into the importer contract would
 * invite exactly that bug.
 *
 * The three null/empty distinctions below are load-bearing. Collapsing any of
 * them takes products off the shelf or puts them on sale for free.
 *
 *   `[]`     this source does not carry this data — try the next one.
 *            Identical to the `SupplySource` convention above.
 *   `null`   unknown. The upstream did not say. NOT zero, NOT "unavailable".
 *   `0`      a real answer: confirmed sold out.
 *
 * Prices are integer minor units plus an ISO currency, like every other money
 * in this repo. Upstream net rates are converted here and nowhere else.
 */

/** The categories that carry commercial terms. Attractions are not live-sourced. */
export type LiveCategory = 'FLIGHT' | 'HOTEL_ROOM' | 'CRUISE';

/**
 * What the live layer did to one product's price, for display and support.
 *
 * Lives here rather than in `modules/search` because two very different callers
 * need it: search, which prices many products at once, and the product detail
 * route, which prices one. Both must report the same shape, or a shopper who
 * searches then opens a product sees two different explanations of the same
 * number.
 */
export interface LivePriceInfo {
  /** Upstream net cost in minor units, before platform markup. */
  netPriceCents: number;
  currency: string;
  sourceId: string;
  /** True when every source failed — surfaced for support, not for shoppers. */
  degraded: boolean;
}

/** One upstream price for one sellable variant on one date. */
export interface LiveOffer {
  sourceId: string;
  /** Namespaced with `slug` so two sources cannot collide on one variant. */
  externalId: string;
  /**
   * Upstream net cost of ONE unit, in minor units of `currency`. This is a
   * *cost*, not a retail price: platform markup, tax and fee are applied
   * afterwards by `modules/pricing`, exactly as they are for a seeded price.
   */
  netPriceCents: number;
  currency: string;
  /** Units believed sellable. `null` = the source did not say. `0` = sold out. */
  sellable: number | null;
  fetchedAt: number;
}

/** Upstream stock for one date, in the platform's own inventory dimension. */
export interface LiveAvailability {
  sourceId: string;
  /** `YYYY-MM-DD`. */
  serviceDate: string;
  /** Aligns with `InventoryRecord.dimensionKey`: cabin / room type / ''. */
  dimensionKey: string;
  capacityTotal: number;
}

export interface LiveRateQuery {
  /** The platform's own slug — the join key back to `Product`. */
  slug: string;
  category: LiveCategory;
  /** First night. `YYYY-MM-DD`. */
  serviceDate: string;
  /** Departure morning, for a multi-night stay. Exclusive, as everywhere else. */
  checkOutDate?: string | null;
  quantity: number;
  /**
   * The currency the platform sells this variant in (`TicketType.currency`).
   *
   * Required, not optional: an offer in any other currency has to be discarded,
   * because `computeQuote` performs no FX conversion and would happily treat
   * 100 EUR as 100 USD. Passing the seller's currency is what makes that
   * rejection decidable.
   */
  currency: string;
}

/** What actually reached the shopper, for display and support. */
export interface LiveQuote {
  netPriceCents: number;
  currency: string;
  sellable: number | null;
  sourceId: string;
  fetchedAt: number;
  /** True when the answer came from cache rather than the upstream. */
  fromCache: boolean;
}

export interface LiveResult {
  /** `null` means "no source answered" — fall back to the seeded price. */
  quote: LiveQuote | null;
  /**
   * True when at least one source was consulted and every one of them failed or
   * declined. Distinct from `quote === null` with `degraded === false`, which
   * means the layer is simply switched off.
   */
  degraded: boolean;
}

/** One adapter per upstream. Remove a category from `categories` if it cannot serve it. */
export interface LiveRateSource {
  /** Matches an `id` row in `docs/supply-sources.md`. */
  readonly id: string;
  /** SPDX-ish, so attribution is answerable from data. */
  readonly license: string;
  readonly categories: readonly LiveCategory[];
  getRates(query: LiveRateQuery): Promise<LiveOffer[]>;
  getAvailability(query: LiveRateQuery): Promise<LiveAvailability[]>;
}

/** How fresh a read may be. Checkout passes `bypassCache` and gets a live call. */
export type LiveFreshness = 'search' | 'detail' | 'availability' | 'checkout';

const TTL_BY_FRESHNESS: Record<LiveFreshness, number> = {
  search: config.supply.live.searchTtlSeconds,
  detail: config.supply.live.detailTtlSeconds,
  availability: config.supply.live.availabilityTtlSeconds,
  // Deliberately 0. A price the shopper agreed to has to be re-proven, not
  // read back from a cache that may have been warm when a competitor's hold
  // landed on the last seat.
  checkout: 0,
};

/**
 * The single consumer-facing entry point.
 *
 * `null` is always a legitimate answer and never an error: it means "no live
 * source carries this", and the caller's job is to fall back to
 * `TicketType.basePriceCents`. That keeps the platform fully functional with the
 * layer disabled, with every source down, or with no commercial source wired at
 * all — which, per `docs/supply-sources.md`, is the state of the world today.
 */
export interface LiveRateResolver {
  resolve(query: LiveRateQuery, freshness?: LiveFreshness): Promise<LiveResult>;
  resolveAvailability(query: LiveRateQuery, freshness?: LiveFreshness): Promise<LiveAvailability[]>;
  /** Every source errored or declined. Surfaces in `/ready` and `SearchHit.live`. */
  readonly degraded: boolean;
  readonly enabled: boolean;
}

export class LiveRateFinder implements LiveRateResolver {
  private lastDegraded = false;
  private readonly isEnabled: boolean;

  constructor(
    private readonly sources: readonly LiveRateSource[],
    enabled = config.supply.live.enabled,
  ) {
    this.isEnabled = enabled;
  }

  get degraded(): boolean {
    return this.lastDegraded;
  }

  get enabled(): boolean {
    return this.isEnabled;
  }

  async resolve(query: LiveRateQuery, freshness: LiveFreshness = 'search'): Promise<LiveResult> {
    // Switching the layer off must be indistinguishable from having no source,
    // so the cached path is skipped entirely rather than serving a stale entry
    // written before the operator turned it off.
    if (!this.enabled) return { quote: null, degraded: false };

    const key = cacheKey(query, freshness);
    if (key) {
      const cached = await cacheGet<LiveOffer[]>(key);
      // An empty array is a real cached answer ("verified unsold"), and it is
      // truthy, so the hit check returns it rather than re-walking the chain.
      if (cached) {
        return { quote: await pickOffer(cached, query, true), degraded: this.lastDegraded };
      }
    }

    const chain = this.sources.filter((source) => source.categories.includes(query.category));
    const offers: LiveOffer[] = [];
    let sawSource = false;

    for (const source of chain) {
      sawSource = true;
      try {
        offers.push(...(await source.getRates(query)));
      } catch (error) {
        // Source down or rate-limited: fall through to the next one. A single
        // flaky upstream must not make the whole category unbuyable.
        logger.warn('live.rate_source_failed', {
          sourceId: source.id,
          slug: query.slug,
          reason: (error as Error).message,
        });
      }
    }

    this.lastDegraded = sawSource && offers.length === 0;
    if (offers.length > 0 && key) {
      // Cached as the whole batch so the hit path can still pick the cheapest
      // for a different quantity without another upstream call.
      await cacheSet(key, offers, TTL_BY_FRESHNESS[freshness]);
    }
    return { quote: await pickOffer(offers, query, false), degraded: this.lastDegraded };
  }

  async resolveAvailability(
    query: LiveRateQuery,
    freshness: LiveFreshness = 'availability',
  ): Promise<LiveAvailability[]> {
    if (!this.enabled) return [];

    const key = `${cacheKey(query, freshness)}:avail`;
    if (key) {
      const cached = await cacheGet<LiveAvailability[]>(key);
      if (cached) return cached;
    }

    const chain = this.sources.filter((source) => source.categories.includes(query.category));
    const rows: LiveAvailability[] = [];
    for (const source of chain) {
      try {
        rows.push(...(await source.getAvailability(query)));
      } catch (error) {
        logger.warn('live.availability_source_failed', {
          sourceId: source.id,
          slug: query.slug,
          reason: (error as Error).message,
        });
      }
    }
    if (rows.length > 0 && key) await cacheSet(key, rows, TTL_BY_FRESHNESS[freshness]);
    return rows;
  }
}

/**
 * Cheapest usable offer, converted into the seller's currency, or `null`.
 *
 * Three rejections happen here, and each one is a bug this repo has already
 * paid for in a different shape:
 *
 *   - **Unconvertible price.** `Number('')` is `0` and `Number('1,20')` is
 *     `NaN`, both of which are plausible results of parsing an upstream string.
 *     Only a genuine non-negative integer passes.
 *   - **No rate available.** Conversion failing is *not* a silent pass-through.
 *     A missing rate table has to leave the seeded price alone rather than let
 *     "100 EUR" be read as "100 USD" — the exact bug this function existed to
 *     prevent before `utils/fx` existed.
 *   - **Confirmed sold out.** `sellable === 0` is a real answer and must win
 *     over a cheaper offer that merely happens to be listed first.
 *
 * The returned quote is always in `query.currency`, which is what makes it
 * safe to hand to `computeQuote`: that function still performs no conversion of
 * its own, and this is now what guarantees it never has to.
 */
async function pickOffer(offers: LiveOffer[], query: LiveRateQuery, fromCache: boolean): Promise<LiveQuote | null> {
  const usable = offers.filter(
    (offer) =>
      typeof offer.netPriceCents === 'number' &&
      Number.isInteger(offer.netPriceCents) &&
      offer.netPriceCents >= 0,
  );
  if (usable.length === 0) return null;

  // A confirmed-zero beats a cheaper quote: the price is irrelevant if there is
  // nothing to sell. Ties fall back to the earliest fetch, so a fresh answer
  // wins over a stale one at the same price.
  const soldOut = usable.filter((offer) => offer.sellable === 0);
  const pool = soldOut.length > 0 ? soldOut : usable;

  const priced = await Promise.all(
    pool.map(async (offer) => {
      const netPriceCents =
        offer.currency === query.currency
          ? offer.netPriceCents
          : await convertMinorUnits(offer.netPriceCents, offer.currency, query.currency);
      return netPriceCents === null ? null : { offer, netPriceCents };
    }),
  );
  const converted = priced.filter((row): row is { offer: LiveOffer; netPriceCents: number } => row !== null);
  if (converted.length === 0) return null;

  const best = converted.reduce((a, b) =>
    b.netPriceCents < a.netPriceCents || (b.netPriceCents === a.netPriceCents && b.offer.fetchedAt > a.offer.fetchedAt)
      ? b
      : a,
  );

  return {
    netPriceCents: best.netPriceCents,
    currency: query.currency,
    sellable: best.offer.sellable,
    sourceId: best.offer.sourceId,
    fetchedAt: best.offer.fetchedAt,
    fromCache,
  };
}

/** `null` when caching is off for this freshness, so nothing is read or written. */
function cacheKey(query: LiveRateQuery, freshness: LiveFreshness): string | null {  const ttl = TTL_BY_FRESHNESS[freshness];
  if (ttl <= 0) return null;
  return [
    'live:rate',
    query.slug,
    query.category,
    query.serviceDate,
    query.checkOutDate ?? '',
    String(query.quantity),
    // The cached payload is the *upstream's* currency, unconverted, so the raw
    // rows are in fact currency-independent. The key still names the currency
    // because it names the request: `pickOffer` converts on the way out, and two
    // callers asking for different currencies must not race on one entry and
    // overwrite each other's answer with whichever conversion landed last.
    query.currency,
    freshness,
  ].join(':');
}

/**
 * Which live category a product type maps to, if any.
 *
 * Deliberately keyed by the Prisma enum's *string* values rather than by
 * `ProductType`, so this module stays a pure contract with no Prisma import —
 * `live.ts` is imported by adapters and by the probe, and pulling the generated
 * client in would make the seam heavier than the thing it seams. A rename of the
 * enum fails the type check here rather than silently returning `undefined`.
 */
export const LIVE_CATEGORY_BY_PRODUCT_TYPE: Readonly<Record<string, LiveCategory>> = {
  FLIGHT: 'FLIGHT',
  HOTEL_ROOM: 'HOTEL_ROOM',
  CRUISE: 'CRUISE',
};