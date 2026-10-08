import { ProductStatus, ProductType, type Prisma } from '@prisma/client';
import { config } from '../../config/env';
import { logger } from '../../lib/logger';
import { prisma } from '../../lib/prisma';
import { liveRates } from '../supply/live-adapters';
import { LIVE_CATEGORY_BY_PRODUCT_TYPE, type LivePriceInfo } from '../supply/live';
import { eachDay, formatServiceDate, toServiceDate } from '../../utils/date';

/**
 * ---------------------------------------------------------------------------
 * Search & merchandising
 * ---------------------------------------------------------------------------
 *
 * Two interchangeable backends:
 *
 *   - OpenSearch when `OPENSEARCH_NODE` is configured (multi-locale analyzers,
 *     relevance tuning, facets, typo tolerance at scale).
 *   - Postgres full-text search (`search_documents.body` + trigram titles)
 *     otherwise, so the platform is fully functional out of the box.
 *
 * Both expose the same `searchProducts()` contract including pagination,
 * facets, geo distance and a "cheapest available price for the requested
 * dates" resolution step.
 */

export type SearchParams = {
  query?: string;
  destinationSlug?: string;
  destinationSlugIn?: string[];
  type?: ProductType;
  typeIn?: ProductType[];
  serviceDate?: string;
  serviceDates?: string[];
  minPriceCents?: number;
  maxPriceCents?: number;
  minRating?: number;
  instantConfirmOnly?: boolean;
  freeCancellationOnly?: boolean;
  skipTheLineOnly?: boolean;
  /**
   * Phase 0 category facets. Each one is meaningful for a single category and
   * simply yields no matches elsewhere, so they do not need to be namespaced by
   * category — `starRating=5&type=HOTEL_ROOM` is the intended usage, and
   * `starRating=5&type=FLIGHT` correctly returns nothing rather than silently
   * dropping the filter.
   */
  starRatingIn?: number[];
  carrierCodeIn?: string[];
  carrierNameIn?: string[];
  shipNameIn?: string[];
  destinationPortIn?: string[];
  boardBasisIn?: string[];
  languages?: string[];
  tags?: string[];
  latitude?: number;
  longitude?: number;
  radiusKm?: number;
  sort?: SortOption;
  page?: number;
  pageSize?: number;
  locale?: string;
  currency?: string;
  /**
   * Unified discovery mode. `TYPE` (the default) additionally returns one
   * bucket per category so the storefront can render category rails next to the
   * flat, unified result list — the whole point of a cross-category search.
   */
  groupBy?: 'TYPE' | 'NONE';
  /** Maximum hits returned inside each category bucket. */
  groupLimit?: number;
};

/**
 * One category bucket of a unified search response.
 *
 * `count` is the number of matching, *bookable* products in that category, and
 * `items` is the top slice of them using the same ranking as the flat list.
 * Together with `facets.types` this lets the client render a category tab bar
 * and category rails without issuing one request per category.
 */
export type SearchGroup = {
  type: ProductType;
  label: string;
  count: number;
  items: SearchHit[];
};

export type SortOption =
  | 'RELEVANCE'
  | 'PRICE_ASC'
  | 'PRICE_DESC'
  | 'RATING'
  | 'POPULARITY'
  | 'DISTANCE';

export type SearchResult = {
  items: SearchHit[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  facets: Facets;
  /** Per-category buckets for the unified discovery flow (empty when groupBy=NONE). */
  groups: SearchGroup[];
  tookMs: number;
  engine: 'opensearch' | 'postgres';
};

export type SearchHit = {
  productId: string;
  slug: string;
  title: string;
  summary: string | null;
  type: ProductType;
  imageUrl: string | null;
  priceCents: number;
  compareAtPriceCents: number | null;
  currency: string;
  ratingAvg: number;
  ratingCount: number;
  reviewCount: number;
  freeCancellation: boolean;
  instantConfirm: boolean;
  skipTheLine: boolean;
  destinationName: string | null;
  countryCode: string | null;
  latitude: number | null;
  longitude: number | null;
  distanceKm: number | null;
  nextAvailableDate: string | null;
  /**
   * Present only when a live source priced this hit, and the price shown is that
   * source's net cost. Absent means the seeded `TicketType.basePriceCents` stands,
   * which is the normal case — the storefront renders it either way.
   */
  live: LivePriceInfo | null;
  /**
   * A highlight worth surfacing on the card, as a **code, not copy**.
   *
   * It used to send the display string (`'Priority entry'`), which meant the API
   * owned UI text and — because the storefront is bilingual — shipped English
   * words onto otherwise Chinese cards. A code keeps the two concerns apart: the
   * API decides *what* is true about a product, the web layer decides how to say
   * it. See `search.badgePRIORITY_ENTRY` and friends in the dictionaries.
   */
  badgeCode: SearchBadgeCode | null;
  tags: string[];

  /**
   * Category facets, carried straight from `SearchDocument`.
   *
   * These are the Phase 0 additions: a hotel can be filtered by official stars
   * and board basis, a flight by carrier and route, a cruise by ship. They stay
   * flat and nullable here because the storefront renders a card per category —
   * a `HotelCard` needs `starRating`, a `FlightCard` needs `routeSummary`, and
   * neither should have to know the other's field exists. The structured form
   * lives in the `ProductStay` / `ProductFlight` / `ProductSailing` tables and
   * is served by the product endpoint, not the search list.
   */
  starRating: number | null;
  boardBasis: string | null;
  carrierCode: string | null;
  carrierName: string | null;
  routeSummary: string | null;
  shipName: string | null;
  destinationPort: string | null;

  /**
   * Category-specific display fields, mirrored from `Product`.
   *
   * The storefront renders a different card per category — a flight shows the
   * route and cabin, a hotel the star rating and board basis, a cruise the ship
   * and duration. Shipping them on the hit means the card never has to guess or
   * issue a second request per product.
   *
   * All optional: absent for categories that do not use them.
   */
  category?: ProductCategoryInfo;
};

/** The subset of `Product` fields that are specific to one product type. */
export type ProductCategoryInfo = {
  airlineName: string | null;
  flightRoute: string | null;
  cabinClass: string | null;
  roomCategory: string | null;
  starCategory: number | null;
  boardBasis: string | null;
  cruiseLine: string | null;
  shipName: string | null;
  cruiseNights: number | null;
  itineraryPorts: string[];
  groupSizeCap: number | null;
  privateDeparture: boolean;
};

export type Facets = {
  types: { value: string; label: string; count: number }[];
  destinations: { value: string; label: string; count: number }[];
  priceRange: { minCents: number; maxCents: number };
  ratings: { value: number; count: number }[];
  tags: { value: string; label: string; count: number }[];
};

function emptyFacets(): Facets {
  return { types: [], destinations: [], priceRange: { minCents: 0, maxCents: 0 }, ratings: [], tags: [] };
}

/**
 * Resolves the cheapest sellable price per product for the requested dates.
 * Products with no availability on any requested date are dropped entirely -
 * this is what makes search results bookable rather than merely attractive.
 *
 * Returns the live metadata alongside the prices rather than mutating silently:
 * a shopper whose price moved needs to be able to see that an upstream moved it,
 * and support needs to know which source to ask.
 */
/**
 * Sellable units per ticket type, summed by the database.
 *
 * **The aggregate is the whole point of this function.** The obvious
 * implementation — fetch each ticket type with its `InventoryRecord` rows
 * nested and reduce them in Node — loads one object per row. At 5,133 ticket
 * types and a 120-day window that is roughly 200,000 rows per search, and a
 * single unfiltered request was measured growing the API's RSS by **707 MB**
 * (122 MB → 829 MB in 5.7 s). `pnpm verify` runs search hundreds of times, so
 * the container ran out of memory and the API was killed mid-suite.
 *
 * Postgres can add those numbers up without shipping them: `groupBy` returns
 * one row per ticket type, so the memory cost is proportional to the number of
 * *listings*, not to the number of inventory rows. Only three numbers are ever
 * needed — capacity, held, sold — and none of them needs its rows in Node.
 *
 * `rows` is returned alongside because `UNLIMITED` inventory counts 1,000 units
 * *per row*, which is a row count rather than a capacity sum.
 */
async function sumSellableUnits(
  ticketTypes: { id: string; inventoryMode: InventoryMode }[],
  dates: Date[],
): Promise<Map<string, { sellable: number; rows: number }>> {
  const totals = new Map<string, { sellable: number; rows: number }>();
  if (ticketTypes.length === 0) return totals;

  const ids = ticketTypes.map((t) => t.id);
  const modeById = new Map(ticketTypes.map((t) => [t.id, t.inventoryMode]));
  const now = new Date();

  // Postgres caps a statement at 65,535 bind parameters; one id per chunk keeps
  // this far below it and bounds the result set as the catalogue grows.
  const CHUNK = 1000;
  for (let offset = 0; offset < ids.length; offset += CHUNK) {
    const rows = await prisma.inventoryRecord.groupBy({
      by: ['ticketTypeId'],
      where: {
        ticketTypeId: { in: ids.slice(offset, offset + CHUNK) },
        // A closed or sold-out record contributes nothing, so it is excluded
        // rather than fetched and skipped — the same arithmetic, less data.
        status: { notIn: ['CLOSED', 'SOLD_OUT'] },
        serviceDate: dates.length ? { in: dates } : { gte: now },
      },
      _sum: { capacityTotal: true, capacityHeld: true, capacitySold: true },
      _count: { _all: true },
    });

    for (const row of rows) {
      const capacity = row._sum.capacityTotal ?? 0;
      const held = row._sum.capacityHeld ?? 0;
      const sold = row._sum.capacitySold ?? 0;
      const count = row._count?._all ?? 0;
      const sellable = modeById.get(row.ticketTypeId) === 'UNLIMITED' ? count * 1_000 : Math.max(0, capacity - held - sold);
      totals.set(row.ticketTypeId, { sellable, rows: count });
    }
  }

  // A ticket type with no sellable records at all is absent from `groupBy`,
  // which reads as zero. Stating it explicitly keeps the availability gate
  // below a simple lookup rather than a "missing means zero" convention.
  for (const id of ids) {
    if (!totals.has(id)) totals.set(id, { sellable: 0, rows: 0 });
  }

  return totals;
}

async function resolveAvailabilityAndPrice(
  productIds: string[],
  dates: Date[],
  requestedDates?: string[],
): Promise<{
  prices: Map<string, { minPriceCents: number; compareAtCents: number | null; nextDate: string | null; availableQty: number }>;
  livePrices: Map<string, LivePriceInfo>;
}> {
  const result = new Map<string, { minPriceCents: number; compareAtCents: number | null; nextDate: string | null; availableQty: number }>();
  if (productIds.length === 0) return { prices: result, livePrices: new Map() };

  // Bundles carry no inventory of their own, so they must bypass the
  // availability gate below and be resolved from their components instead.
  const bundleRows = await prisma.productBundle.findMany({
    where: { productId: { in: productIds } },
    select: { productId: true },
  });
  const bundleProductIds = new Set(bundleRows.map((b) => b.productId));

  // Ticket types carry only what pricing and the availability gate need. The
  // inventory is deliberately *absent* here — see `sumSellableUnits`.
  const ticketTypes = await prisma.ticketType.findMany({
    where: { productId: { in: productIds }, active: true },
    select: {
      id: true,
      productId: true,
      basePriceCents: true,
      compareAtCents: true,
      inventoryMode: true,
    },
  });

  const units = await sumSellableUnits(ticketTypes, dates);

  for (const ticketType of ticketTypes) {
    const available = units.get(ticketType.id)?.sellable ?? 0;

    // With explicit dates we require availability on *at least one* of them;
    // this keeps multi-date browsing useful while never showing dead ends.
    // A bundle is exempt: it never holds stock itself, and its availability is
    // resolved from its components in `addBundleAvailability`. Gating it here
    // would drop every package from search.
    const isBundle = bundleProductIds.has(ticketType.productId);
    if (available <= 0 && !isBundle) continue;

    const existing = result.get(ticketType.productId);
    if (!existing || ticketType.basePriceCents < existing.minPriceCents) {
      result.set(ticketType.productId, {
        minPriceCents: ticketType.basePriceCents,
        compareAtCents: ticketType.compareAtCents,
        nextDate: requestedDates?.[0] ?? null,
        availableQty: available,
      });
    }
  }

  await addBundleAvailability(result, bundleProductIds, dates, requestedDates);

  const livePrices = await applyLiveRates(result, ticketTypes);

  return { prices: result, livePrices };
}

/**
 * Overlays live upstream net rates onto the resolved search prices.
 *
 * Ordering matters and is the whole point of this function:
 *
 *   1. **Availability is decided before this runs.** `InventoryRecord` above is
 *      the only authority on whether anything is sellable. No live source in the
 *      chain reports a trustworthy allotment, and one that did would be advisory
 *      anyway — a source can prove "sold out", never "in stock".
 *   2. **A live price only ever replaces the number a live quote returned.** A
 *      `null` quote (no source configured, or all sources down) leaves the
 *      seeded `basePriceCents` untouched, so search behaves exactly as it did
 *      before this layer existed.
 *   3. **The value stored is a cost, not a retail price.** `minPriceCents` is
 *      compared against `TicketType.basePriceCents` upstream, which is itself a
 *      pre-markup cost, so substituting a net rate here keeps the comparison
 *      like-for-like. Platform markup, tax and fee are applied later by
 *      `computeQuote`, exactly as for a seeded price.
 *
 * Failure is absorbed rather than propagated: a live layer that throws would
 * otherwise take the whole search endpoint down, which is a far worse outcome
 * than quoting a slightly stale number.
 */
/**
 * Applies live upstream net rates onto the resolved search prices, and returns
 * what it did per product so `SearchHit.live` can report it.
 *
 * Ordering matters and is the whole point of this function:
 *
 *   1. **Availability is decided before this runs.** `InventoryRecord` above is
 *      the only authority on whether anything is sellable. No live source in the
 *      chain reports a trustworthy allotment, and one that did would be advisory
 *      anyway — a source can prove "sold out", never "in stock".
 *   2. **A live price only ever replaces the number a live quote returned.** A
 *      `null` quote (no source configured, or all sources down) leaves the
 *      seeded `basePriceCents` untouched, so search behaves exactly as it did
 *      before this layer existed.
 *   3. **The value stored is a cost, not a retail price.** `minPriceCents` is
 *      compared against `TicketType.basePriceCents` upstream, which is itself a
 *      pre-markup cost, so substituting a net rate here keeps the comparison
 *      like-for-like. Platform markup, tax and fee are applied later by
 *      `computeQuote`, exactly as for a seeded price.
 *
 * Failure is absorbed rather than propagated: a live layer that throws would
 * otherwise take the whole search endpoint down, which is a far worse outcome
 * than quoting a slightly stale number.
 */
async function applyLiveRates(
  prices: Map<string, { minPriceCents: number; compareAtCents: number | null; nextDate: string | null; availableQty: number }>,
  ticketTypes: { id: string; productId: string }[],
): Promise<Map<string, LivePriceInfo>> {
  const applied = new Map<string, LivePriceInfo>();
  if (!liveRates.enabled || prices.size === 0) return applied;

  // One live lookup per product, not per ticket type: the upstream answers per
  // product/date, and asking twice for the same row is how rate limits and
  // inconsistent prices between variants of one product are introduced.
  const productById = new Map<string, string>();
  for (const ticketType of ticketTypes) {
    if (!productById.has(ticketType.productId)) productById.set(ticketType.productId, ticketType.id);
  }

  const settled = await Promise.all(
    [...prices.keys()].map(async (productId) => {
      const entry = prices.get(productId);
      const ticketTypeId = productById.get(productId);
      if (!entry || !ticketTypeId) return null;

      // Slug and currency are both required by `LiveRateQuery`, and neither can
      // be invented here — so they are read from the product and its ticket
      // type rather than guessed. This costs one indexed lookup per product,
      // which the search index already does for the same row.
      const product = await prisma.product.findUnique({
        where: { id: productId },
        select: { slug: true, type: true },
      });
      if (!product) return null;

      const currency = await prisma.ticketType.findUnique({
        where: { id: ticketTypeId },
        select: { currency: true },
      });
      if (!currency) return null;

      const category = LIVE_CATEGORY_BY_PRODUCT_TYPE[product.type];
      if (!category) return null;

      const result = await liveRates.resolve(
        {
          slug: product.slug,
          category,
          serviceDate: entry.nextDate ?? new Date().toISOString().slice(0, 10),
          quantity: 1,
          currency: currency.currency,
        },
        'search',
      );

      // `quote === null` means "no source answered", not "unavailable" — leave
      // the seeded price alone. `degraded` is surfaced on the hit for support.
      return result.quote
        ? {
            productId,
            netPriceCents: result.quote.netPriceCents,
            currency: result.quote.currency,
            sourceId: result.quote.sourceId,
            degraded: result.degraded,
          }
        : null;
    }),
  );

  for (const outcome of settled) {
    if (!outcome) continue;
    const entry = prices.get(outcome.productId);
    if (!entry) continue;
    entry.minPriceCents = outcome.netPriceCents;
    applied.set(outcome.productId, {
      netPriceCents: outcome.netPriceCents,
      currency: outcome.currency,
      sourceId: outcome.sourceId,
      degraded: outcome.degraded,
    });
  }
  return applied;
}

/**
 * Only the three categories the live layer carries. Attractions and everything
 * else keep their seeded price, because no source in the chain prices them and
 * guessing would be worse than not answering. See
 * `LIVE_CATEGORY_BY_PRODUCT_TYPE` in `modules/supply/live.ts`, which is shared
 * with the product detail route so both resolve a category the same way.
 */

/**
 * Folds component availability up into each bundle.
 *
 * A bundle holds no inventory of its own — its `TicketType` exists only as a
 * booking entry point, and what is actually sold is its components. Left
 * unhandled, every package is dropped by the "no availability" rule above and
 * silently disappears from search, which is how a seeded package can exist in
 * the database and return zero results.
 *
 * A package is bookable when every **required** component has stock. Optional
 * components are skipped on expansion if they are sold out, so letting one gate
 * the package would hide trips that are still perfectly bookable.
 */
async function addBundleAvailability(
  result: Map<string, { minPriceCents: number; compareAtCents: number | null; nextDate: string | null; availableQty: number }>,
  bundleProductIds: Set<string>,
  dates: Date[],
  requestedDates?: string[],
): Promise<void> {
  if (bundleProductIds.size === 0) return;

  const bundles = await prisma.productBundle.findMany({
    where: { productId: { in: [...bundleProductIds] } },
    include: { components: true },
  });
  if (bundles.length === 0) return;

  const componentIds = bundles.flatMap((b) => b.components.map((c) => c.ticketTypeId));
  if (componentIds.length === 0) return;

  const componentTypes = await prisma.ticketType.findMany({
    where: { id: { in: componentIds }, active: true },
    select: { id: true, inventoryMode: true },
  });

  // Same aggregate as the main path — a bundle's components have their own
  // inventory, and loading their rows would reintroduce the memory blow-up
  // `sumSellableUnits` exists to avoid.
  const unitsById = await sumSellableUnits(componentTypes, dates);

  for (const bundle of bundles) {
    const own = result.get(bundle.productId);
    if (!own) continue;

    const unitsFor = (ticketTypeId: string): number => unitsById.get(ticketTypeId)?.sellable ?? 0;

    // Required components gate the package; optional ones only widen it.
    const required = bundle.components.filter((c) => c.required);
    const gating = required.length > 0 ? required : bundle.components;
    const leastAvailable = gating.map((c) => unitsFor(c.ticketTypeId)).sort((a, b) => a - b)[0] ?? 0;
    if (leastAvailable <= 0) continue;

    result.set(bundle.productId, {
      ...own,
      // A trip of several bookings can be sold to fewer travellers than any one
      // component allows on its own.
      availableQty: Math.min(leastAvailable, own.availableQty || leastAvailable),
      nextDate: own.nextDate ?? requestedDates?.[0] ?? null,
    });
  }
}

function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/**
 * Rows pulled from Postgres before availability/price resolution.
 *
 * This is a **hard cap on how many results search can ever report**, because
 * `total` is `Math.min(count, hits.length)` after the availability gate drops
 * anything unbookable. Set below the catalogue size it does not merely slow
 * things down — it silently deletes the tail. At 400 against a 468-product
 * catalogue the last 70 listings stopped appearing in *any* search, including a
 * plain unfiltered one, with no error anywhere. It is the same failure the
 * `/destinations` endpoint had when a `take` hid Sydney and Melbourne.
 *
 * The cap exists because each candidate costs an inventory join (one
 * `TicketType` fetch with nested `InventoryRecord`s) and a price resolution, so
 * it is not free to remove. It is instead set well above the catalogue and
 * guarded: if the count ever exceeds it, the request logs
 * `search.candidates_truncated` so the next person finds a warning rather than a
 * mystery. Grow the catalogue by an order of magnitude and this is the line to
 * revisit.
 */
const CANDIDATE_LIMIT = 5000;

/** Ranking window shared by the flat list, the category buckets and the facets. */
function candidateOrderBy(sort: SortOption | undefined): Prisma.SearchDocumentOrderByWithRelationInput | undefined {
  if (sort === 'PRICE_ASC' || sort === 'PRICE_DESC') {
    // Price is only known after availability resolution, so fall back to the
    // popularity ordering here and do the real price sort in memory.
    return { popularityScore: 'desc' };
  }
  if (sort === 'RATING') return { ratingAvg: 'desc' };
  if (sort === 'POPULARITY' || sort === 'RELEVANCE') return { popularityScore: 'desc' };
  return undefined;
}

/**
 * Buckets ranked hits per category, preserving the global ranking inside each
 * bucket (the input is already sorted). The largest categories come first: an
 * "Attractions (18)" rail is more useful to a shopper than a "Cruises (1)" one.
 */
function buildGroups(hits: SearchHit[], params: SearchParams): SearchGroup[] {
  if (params.groupBy === 'NONE') return [];
  const limit = Math.min(24, Math.max(1, params.groupLimit ?? 8));

  const buckets = new Map<ProductType, SearchHit[]>();
  for (const hit of hits) {
    const bucket = buckets.get(hit.type);
    if (bucket) bucket.push(hit);
    else buckets.set(hit.type, [hit]);
  }

  return [...buckets.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .map(([type, items]) => ({
      type,
      label: typeLabel(type, params.locale),
      count: items.length,
      items: items.slice(0, limit),
    }));
}

/** Postgres backend: trigram-ish ILIKE + tsvector ranking. */
async function searchPostgres(params: SearchParams): Promise<SearchResult> {
  const started = Date.now();
  const page = Math.max(1, params.page ?? 1);
  const pageSize = Math.min(60, Math.max(1, params.pageSize ?? 24));

  const requestedDates = params.serviceDates ?? (params.serviceDate ? [params.serviceDate] : undefined);
  const dates = requestedDates?.map((d) => toServiceDate(d)) ?? [];

  // `whereBase` deliberately excludes the category filter. The type counts are
  // computed *before* the category narrowing is applied — the "disjunctive
  // facet" behaviour Elasticsearch gets from `post_filter` plus global
  // aggregations. Without it, selecting "Hotels" would report every other
  // category as zero and the tab bar would collapse to one usable tab.
  const whereBase: Prisma.SearchDocumentWhereInput = {
    status: ProductStatus.PUBLISHED,
  };
  const andFilters: Prisma.SearchDocumentWhereInput[] = [];

  if (params.query) {
    const terms = params.query.trim().split(/\s+/).filter(Boolean);
    // Every term must appear somewhere (AND), matching typical OTA behaviour.
    for (const term of terms) {
      andFilters.push({
        OR: [
          { title: { contains: term, mode: 'insensitive' } },
          { keywords: { has: term.toLowerCase() } },
          { tags: { has: term.toLowerCase() } },
          { destinationPath: { has: term.toLowerCase() } },
          { body: { contains: term, mode: 'insensitive' } },
        ],
      });
    }
  }

  const destinationSlugs = params.destinationSlugIn ?? (params.destinationSlug ? [params.destinationSlug] : []);
  if (destinationSlugs.length > 0) {
    andFilters.push({ OR: destinationSlugs.map((slug) => ({ destinationPath: { has: slug } })) });
  }

  if (params.minRating !== undefined) whereBase.ratingAvg = { gte: params.minRating };
  if (params.instantConfirmOnly) whereBase.instantConfirm = true;
  if (params.freeCancellationOnly) whereBase.freeCancellation = true;
  if (params.skipTheLineOnly) whereBase.skipTheLine = true;
  if (params.starRatingIn?.length) whereBase.starRating = { in: params.starRatingIn };
  if (params.carrierCodeIn?.length) whereBase.carrierCode = { in: params.carrierCodeIn };
  if (params.carrierNameIn?.length) whereBase.carrierName = { in: params.carrierNameIn };
  if (params.shipNameIn?.length) whereBase.shipName = { in: params.shipNameIn };
  if (params.destinationPortIn?.length) whereBase.destinationPort = { in: params.destinationPortIn };
  if (params.boardBasisIn?.length) whereBase.boardBasis = { in: params.boardBasisIn };
  if (params.tags?.length) whereBase.tags = { hasSome: params.tags.map((t) => t.toLowerCase()) };

  if (andFilters.length > 0) whereBase.AND = andFilters;

  // Filter the categories at the database level so a narrow category is never
  // crowded out of the ranked window by a dominant one.
  const typeFilter = params.typeIn?.length ? { in: params.typeIn } : params.type;
  const where: Prisma.SearchDocumentWhereInput = typeFilter ? { ...whereBase, type: typeFilter } : whereBase;

  const total = await prisma.searchDocument.count({ where });

  // Truncation used to be invisible: the cap silently removed listings from
  // every result page, including an unfiltered one, and the only symptom was a
  // result count that quietly stopped growing. Say it out loud instead.
  if (total > CANDIDATE_LIMIT) {
    logger.warn('search.candidates_truncated', {
      matching: total,
      candidateLimit: CANDIDATE_LIMIT,
      note: 'raise CANDIDATE_LIMIT — the tail of these results is not being shown',
    });
  }

  const candidates = await prisma.searchDocument.findMany({
    where,
    take: CANDIDATE_LIMIT,
    orderBy: candidateOrderBy(params.sort),
  });

  const { prices, livePrices } = await resolveAvailabilityAndPrice(
    candidates.map((c) => c.productId),
    dates,
    requestedDates,
  );

  let hits: SearchHit[] = candidates
    .filter((doc) => prices.has(doc.productId))
    .map((doc) => {
      const price = prices.get(doc.productId)!;
      const distance =
        params.latitude !== undefined && params.longitude !== undefined && doc.latitude !== null && doc.longitude !== null
          ? haversineKm(params.latitude, params.longitude, doc.latitude, doc.longitude)
          : null;

      return {
        productId: doc.productId,
        slug: doc.productId,
        title: doc.title,
        summary: doc.summary,
        type: doc.type,
        imageUrl: null,
        priceCents: price.minPriceCents,
        compareAtPriceCents: price.compareAtCents && price.compareAtCents > price.minPriceCents ? price.compareAtCents : null,
        currency: doc.currency,
        ratingAvg: doc.ratingAvg,
        ratingCount: doc.ratingCount,
        reviewCount: doc.ratingCount,
        freeCancellation: doc.freeCancellation,
        instantConfirm: doc.instantConfirm,
        skipTheLine: doc.skipTheLine,
        destinationName: doc.cityName,
        countryCode: doc.countryCode,
        latitude: doc.latitude,
        longitude: doc.longitude,
        distanceKm: distance,
        nextAvailableDate: price.nextDate,
        // Keyed by productId, which is what `resolveAvailabilityAndPrice`
        // populates. Reading `doc.id` here (the SearchDocument primary key) is
        // always a miss, so every Postgres-backed hit silently reported
        // `live: null` even when a source had answered.
        live: livePrices.get(doc.productId) ?? null,
        badgeCode: null,
        tags: doc.tags,
        starRating: doc.starRating ?? null,
        boardBasis: doc.boardBasis ?? null,
        carrierCode: doc.carrierCode ?? null,
        carrierName: doc.carrierName ?? null,
        routeSummary: doc.routeSummary ?? null,
        shipName: doc.shipName ?? null,
        destinationPort: doc.destinationPort ?? null,
      };
    });

  // --- Filters that depend on resolved prices ------------------------------
  if (params.minPriceCents !== undefined) hits = hits.filter((h) => h.priceCents >= params.minPriceCents!);
  if (params.maxPriceCents !== undefined) hits = hits.filter((h) => h.priceCents <= params.maxPriceCents!);
  if (params.radiusKm !== undefined && params.latitude !== undefined) {
    hits = hits.filter((h) => h.distanceKm !== null && h.distanceKm <= params.radiusKm!);
  }

  hits.sort(comparatorFor(params.sort));

  // Category rails are only meaningful on the unified (unfiltered) view — once
  // a single category is selected the flat list *is* the answer.
  const groups = typeFilter ? [] : buildGroups(hits, params);

  const totalFiltered = hits.length;
  const paged = hits.slice((page - 1) * pageSize, page * pageSize);

  // One hydration pass covers both the paginated slice and the category rails.
  const hydrationNeeded = new Map<string, SearchHit>();
  for (const hit of paged) hydrationNeeded.set(hit.productId, hit);
  for (const group of groups) for (const hit of group.items) hydrationNeeded.set(hit.productId, hit);

  const hydrated = new Map((await hydrateHits([...hydrationNeeded.values()], params.locale)).map((hit) => [hit.productId, hit]));
  const items = paged.map((hit) => hydrated.get(hit.productId) ?? hit);
  const hydratedGroups = groups.map((group) => ({
    ...group,
    items: group.items.map((hit) => hydrated.get(hit.productId) ?? hit),
  }));

  const facets = await buildFacets(hits, typeFilter ? whereBase : undefined, params.locale);

  return {
    items,
    total: Math.min(total, totalFiltered),
    page,
    pageSize,
    totalPages: Math.ceil(totalFiltered / pageSize),
    facets,
    groups: hydratedGroups,
    tookMs: Date.now() - started,
    engine: 'postgres',
  };
}

function comparatorFor(sort: SortOption | undefined): (a: SearchHit, b: SearchHit) => number {
  switch (sort) {
    case 'PRICE_ASC':
      return (a, b) => a.priceCents - b.priceCents;
    case 'PRICE_DESC':
      return (a, b) => b.priceCents - a.priceCents;
    case 'RATING':
      return (a, b) => b.ratingAvg - a.ratingAvg || b.ratingCount - a.ratingCount;
    case 'DISTANCE':
      return (a, b) => (a.distanceKm ?? Infinity) - (b.distanceKm ?? Infinity);
    case 'POPULARITY':
    case 'RELEVANCE':
    default:
      return (a, b) => b.ratingAvg * Math.log(b.ratingCount + 2) - a.ratingAvg * Math.log(a.ratingCount + 2);
  }
}

/**
 * Fills in the fields the search projection does not denormalise: the display
 * title in the requested language, the hero image, tags, and the
 * category-specific block the storefront card renders.
 *
 * The locale matters here: every listing ships an English *and* a Chinese
 * translation, and `translations: { take: 1 }` would return whichever row
 * Postgres happened to order first — usually the English one, so a Chinese
 * shopper would see English titles in the results. The translations are
 * therefore fetched explicitly and matched on the locale subtag.
 */
async function hydrateHits(hits: SearchHit[], locale = 'en'): Promise<SearchHit[]> {
  if (hits.length === 0) return hits;

  const products = await prisma.product.findMany({
    where: { id: { in: hits.map((h) => h.productId) } },
    include: {
      media: { orderBy: { position: 'asc' }, take: 1 },
      translations: true,
      tags: true,
    },
  });
  const byId = new Map(products.map((p) => [p.id, p]));

  /** Picks the translation for `locale`, falling back to English, then any. */
  const pickTranslation = (translations: typeof products[number]['translations']) =>
    translations.find((t) => t.locale.toLowerCase().startsWith(locale.split('-')[0]!.toLowerCase())) ??
    translations.find((t) => t.locale.toLowerCase().startsWith('en')) ??
    translations[0];

  return hits.map((hit) => {
    const product = byId.get(hit.productId);
    if (!product) return hit;

    const translation = pickTranslation(product.translations);

    return {
      ...hit,
      slug: product.slug,
      title: translation?.name ?? product.slug,
      summary: translation?.summary ?? hit.summary,
      imageUrl: product.media[0]?.url ?? null,
      // Positive, trust-building signal only. A discount percentage is
      // deliberately not used here: the storefront reads as a premium
      // consultancy, not a bargain bin.
      badgeCode: badgeCodeFor(product),
      tags: product.tags.map((t) => t.slug),
      category: {
        airlineName: product.airlineName,
        flightRoute: product.flightRoute,
        cabinClass: product.cabinClass,
        roomCategory: product.roomCategory,
        starCategory: product.starCategory,
        boardBasis: product.boardBasis,
        cruiseLine: product.cruiseLine,
        shipName: product.shipName,
        cruiseNights: product.cruiseNights,
        itineraryPorts: product.itineraryPorts,
        groupSizeCap: product.groupSizeCap,
        privateDeparture: product.privateDeparture,
      },
    };
  });
}

/**
 * The small highlight a card may carry. Ranked from most to least
 * differentiating, so a product always gets the strongest honest signal it has.
 *
 * Deliberately a closed union rather than a free string: it is a value the web
 * layer translates, so an open string would just reintroduce untranslatable
 * copy into the API.
 */
export type SearchBadgeCode = 'PRIORITY_ENTRY' | 'PRIVATE_DEPARTURE' | 'INSTANT_CONFIRMATION';

function badgeCodeFor(product: {
  skipTheLine: boolean;
  instantConfirm: boolean;
  privateDeparture: boolean;
}): SearchBadgeCode | null {
  if (product.skipTheLine) return 'PRIORITY_ENTRY';
  if (product.privateDeparture) return 'PRIVATE_DEPARTURE';
  if (product.instantConfirm) return 'INSTANT_CONFIRMATION';
  return null;
}

/**
 * Computes the facet block for a result set.
 *
 * `disjunctiveWhere` is supplied when a category filter is active: the category
 * counts then come from a database aggregate over the filter set *excluding*
 * the category narrowing, so the tab bar stays fully populated (and the shopper
 * can widen the search) instead of collapsing to the one selected tab.
 */
async function buildFacets(hits: SearchHit[], disjunctiveWhere?: Prisma.SearchDocumentWhereInput, locale = 'en'): Promise<Facets> {
  const facets = emptyFacets();

  if (disjunctiveWhere) {
    const rows = await prisma.searchDocument.groupBy({
      by: ['type'],
      where: disjunctiveWhere,
      _count: { _all: true },
    });
    facets.types = rows
      .map((row) => ({ value: row.type, label: typeLabel(row.type, locale), count: row._count._all }))
      .sort((a, b) => b.count - a.count);
  }

  if (hits.length === 0) return facets;

  const typeCounts = new Map<string, number>();
  const destinationCounts = new Map<string, number>();
  const tagCounts = new Map<string, number>();
  let min = Infinity;
  let max = 0;

  for (const hit of hits) {
    typeCounts.set(hit.type, (typeCounts.get(hit.type) ?? 0) + 1);
    if (hit.destinationName) destinationCounts.set(hit.destinationName, (destinationCounts.get(hit.destinationName) ?? 0) + 1);
    for (const tag of hit.tags) tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
    min = Math.min(min, hit.priceCents);
    max = Math.max(max, hit.priceCents);
  }

  facets.priceRange = { minCents: Number.isFinite(min) ? min : 0, maxCents: max };

  if (!disjunctiveWhere) {
    facets.types = [...typeCounts.entries()]
      .map(([value, count]) => ({ value, label: typeLabel(value, locale), count }))
      .sort((a, b) => b.count - a.count);
  }

  facets.destinations = [...destinationCounts.entries()]
    .map(([value, count]) => ({ value, label: value, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 20);

  facets.tags = [...tagCounts.entries()]
    .map(([value, count]) => ({ value, label: value, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 20);

  facets.ratings = [5, 4, 3].map((value) => ({
    value,
    count: hits.filter((h) => h.ratingAvg >= value - 0.5).length,
  }));

  return facets;
}

export const TYPE_LABELS: Record<string, string> = {
  ATTRACTION_TICKET: 'Landmark access',
  ACTIVITY: 'Signature activities',
  TOUR: 'Tours',
  DAY_TRIP: 'Day trips',
  PACKAGE: 'Curated packages',
  HOTEL_ROOM: 'Hotels & suites',
  TRANSFER: 'Transfers',
  VEHICLE_RENTAL: 'Car hire',
  GUIDED_TOUR: 'Private guides',
  RESTAURANT: 'Dining',
  CRUISE: 'Ocean & river cruises',
  RENTAL_CAR: 'Car hire',
  FLIGHT: 'International flights',
  AIRPORT_TRANSFER: 'Airport transfers',
};

/**
 * Simplified Chinese category labels, parallel to {@link TYPE_LABELS}.
 *
 * The storefront asks for the localized label via `searchDocuments.locale`
 * (`zh` → `zh-CN`), so the rails and facet counts read naturally in Chinese
 * instead of showing an English enum label.
 */
export const TYPE_LABELS_ZH: Record<string, string> = {
  ATTRACTION_TICKET: '殿堂级景点',
  ACTIVITY: '特色活动',
  TOUR: '深度旅行团',
  DAY_TRIP: '一日游',
  PACKAGE: '臻选套餐',
  HOTEL_ROOM: '豪华酒店',
  TRANSFER: '接送服务',
  VEHICLE_RENTAL: '租车服务',
  GUIDED_TOUR: '私人向导',
  RESTAURANT: '餐饮订位',
  CRUISE: '邮轮与河轮',
  RENTAL_CAR: '租车服务',
  FLIGHT: '国际机票',
  AIRPORT_TRANSFER: '机场接送',
};

/** Picks the label set for an API locale (`zh-CN`, `en-US`, ...). */
export function typeLabel(type: string, locale = 'en'): string {
  const table = String(locale).toLowerCase().startsWith('zh') ? TYPE_LABELS_ZH : TYPE_LABELS;
  return table[type] ?? TYPE_LABELS[type] ?? type;
}

/** OpenSearch backend. Falls back to Postgres on any failure. */
async function searchOpenSearch(params: SearchParams): Promise<SearchResult> {
  const started = Date.now();
  const page = Math.max(1, params.page ?? 1);
  const pageSize = Math.min(60, Math.max(1, params.pageSize ?? 24));

  const must: unknown[] = [];
  // Two filter sets: the full one used for hits, and `facetFilter`, which omits
  // the category narrowing so the category aggregation stays "disjunctive" —
  // picking "Hotels" must not zero out every other tab. This is the OpenSearch
  // equivalent of Elasticsearch's post_filter + global aggregation pattern.
  const facetFilter: unknown[] = [{ term: { status: 'PUBLISHED' } }];
  const typeClauses: unknown[] = [];

  if (params.query) {
    must.push({
      multi_match: {
        query: params.query,
        fields: ['title^3', 'titleAll^2', 'keywords^2', 'tags', 'destinationPath', 'summary', 'body'],
        type: 'best_fields',
        fuzziness: 'AUTO',
      },
    });
  }

  const slugs = params.destinationSlugIn ?? (params.destinationSlug ? [params.destinationSlug] : []);
  if (slugs.length) facetFilter.push({ terms: { destinationPath: slugs } });
  if (params.type) typeClauses.push({ term: { type: params.type } });
  if (params.typeIn?.length) typeClauses.push({ terms: { type: params.typeIn } });
  if (params.minRating) facetFilter.push({ range: { ratingAvg: { gte: params.minRating } } });
  if (params.instantConfirmOnly) facetFilter.push({ term: { instantConfirm: true } });
  if (params.freeCancellationOnly) facetFilter.push({ term: { freeCancellation: true } });
  if (params.skipTheLineOnly) facetFilter.push({ term: { skipTheLine: true } });
  if (params.starRatingIn?.length) facetFilter.push({ terms: { starRating: params.starRatingIn } });
  if (params.carrierCodeIn?.length) facetFilter.push({ terms: { carrierCode: params.carrierCodeIn } });
  if (params.carrierNameIn?.length) facetFilter.push({ terms: { carrierName: params.carrierNameIn } });
  if (params.shipNameIn?.length) facetFilter.push({ terms: { shipName: params.shipNameIn } });
  if (params.destinationPortIn?.length) facetFilter.push({ terms: { destinationPort: params.destinationPortIn } });
  if (params.boardBasisIn?.length) facetFilter.push({ terms: { boardBasis: params.boardBasisIn } });
  if (params.minPriceCents !== undefined) facetFilter.push({ range: { basePriceCents: { gte: params.minPriceCents } } });
  if (params.maxPriceCents !== undefined) facetFilter.push({ range: { basePriceCents: { lte: params.maxPriceCents } } });

  const filter: unknown[] = [...facetFilter, ...typeClauses];

  const sortClause: unknown[] = [];
  switch (params.sort) {
    case 'PRICE_ASC':
      sortClause.push({ basePriceCents: 'asc' });
      break;
    case 'PRICE_DESC':
      sortClause.push({ basePriceCents: 'desc' });
      break;
    case 'RATING':
      sortClause.push({ ratingAvg: 'desc' });
      break;
    case 'DISTANCE':
      if (params.latitude !== undefined && params.longitude !== undefined) {
        sortClause.push({
          _geo_distance: {
            location: { lat: params.latitude, lon: params.longitude },
            order: 'asc',
            unit: 'km',
          },
        });
      }
      break;
    default:
      sortClause.push({ popularityScore: 'desc' }, { ratingAvg: 'desc' });
  }

  if (params.latitude !== undefined && params.longitude !== undefined && params.radiusKm !== undefined) {
    filter.push({
      geo_distance: {
        distance: `${params.radiusKm}km`,
        location: { lat: params.latitude, lon: params.longitude },
      },
    });
  }

  const body = {
    from: (page - 1) * pageSize,
    size: pageSize,
    query: { bool: { must: must.length ? must : [{ match_all: {} }], filter } },
    sort: sortClause,
    aggs: {
      // Category counts over the pre-category filter set (see `facetFilter`).
      types: {
        filter: { bool: { filter: facetFilter } },
        aggs: { by_type: { terms: { field: 'type.keyword', size: 20 } } },
      },
      cities: { terms: { field: 'cityName.keyword', size: 20 } },
      tags: { terms: { field: 'tags.keyword', size: 20 } },
      price: { stats: { field: 'basePriceCents' } },
      ratings: { histogram: { field: 'ratingAvg', interval: 1 } },
    },
  };

  try {
    const response = await fetch(`${config.search.node}/${config.search.index}/_search`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(config.search.username ? { Authorization: `Basic ${Buffer.from(`${config.search.username}:${config.search.password}`).toString('base64')}` } : {}),
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) throw new Error(`OpenSearch responded ${response.status}`);
    type Aggregation = {
      buckets?: { key: string; doc_count: number }[];
      value?: number;
      by_type?: { buckets?: { key: string; doc_count: number }[] };
    };
    const data = (await response.json()) as {
      hits: { total: { value: number }; hits: Record<string, unknown>[] };
      aggregations: Record<string, Aggregation>;
    };

    const requestedDates = params.serviceDates ?? (params.serviceDate ? [params.serviceDate] : undefined);
    const dates = requestedDates?.map((d) => toServiceDate(d)) ?? [];
    const rawHits = data.hits.hits.map((h) => h._source as Record<string, unknown>);

    const { prices, livePrices } = await resolveAvailabilityAndPrice(
      rawHits.map((h) => h.productId as string),
      dates,
      requestedDates,
    );

    const items: SearchHit[] = rawHits
      .filter((h) => prices.has(h.productId as string))
      .map((h) => {
        const price = prices.get(h.productId as string)!;
        const location = h.location as { lat: number; lon: number } | undefined;
        const distance =
          params.latitude !== undefined && params.longitude !== undefined && location
            ? haversineKm(params.latitude, params.longitude, location.lat, location.lon)
            : null;

        return {
          productId: h.productId as string,
          slug: h.productId as string,
          title: h.title as string,
          summary: (h.summary as string) ?? null,
          type: h.type as ProductType,
          imageUrl: null,
          priceCents: price.minPriceCents,
          compareAtPriceCents: price.compareAtCents && price.compareAtCents > price.minPriceCents ? price.compareAtCents : null,
          currency: (h.currency as string) ?? 'USD',
          ratingAvg: (h.ratingAvg as number) ?? 0,
          ratingCount: (h.ratingCount as number) ?? 0,
          reviewCount: (h.ratingCount as number) ?? 0,
          freeCancellation: (h.freeCancellation as boolean) ?? false,
          instantConfirm: (h.instantConfirm as boolean) ?? false,
          skipTheLine: (h.skipTheLine as boolean) ?? false,
          destinationName: (h.cityName as string) ?? null,
          countryCode: (h.countryCode as string) ?? null,
          latitude: (h.latitude as number) ?? null,
          longitude: (h.longitude as number) ?? null,
          distanceKm: distance,
          nextAvailableDate: price.nextDate,
          live: livePrices.get(h.productId as string) ?? null,
          badgeCode: null,
          tags: (h.tags as string[]) ?? [],
          starRating: (h.starRating as number) ?? null,
          boardBasis: (h.boardBasis as string) ?? null,
          carrierCode: (h.carrierCode as string) ?? null,
          carrierName: (h.carrierName as string) ?? null,
          routeSummary: (h.routeSummary as string) ?? null,
          shipName: (h.shipName as string) ?? null,
          destinationPort: (h.destinationPort as string) ?? null,
        };
      });

    const hydratedItems = await hydrateHits(items, params.locale);
    const categoryFiltered = Boolean(params.type || params.typeIn?.length);

    return {
      items: hydratedItems,
      total: data.hits.total.value,
      page,
      pageSize,
      totalPages: Math.ceil(data.hits.total.value / pageSize),
      facets: {
        types: (data.aggregations.types?.by_type?.buckets ?? []).map((b) => ({ value: b.key, label: typeLabel(b.key, params.locale), count: b.doc_count })),
        destinations: (data.aggregations.cities?.buckets ?? []).map((b) => ({ value: b.key, label: b.key, count: b.doc_count })),
        tags: (data.aggregations.tags?.buckets ?? []).map((b) => ({ value: b.key, label: b.key, count: b.doc_count })),
        priceRange: {
          minCents: data.aggregations.price?.value ?? 0,
          maxCents: 0,
        },
        ratings: (data.aggregations.ratings?.buckets ?? []).map((b) => ({ value: Number(b.key), count: b.doc_count })),
      },
      // Category rails only make sense on the unified view; once a category is
      // selected the flat list is the answer.
      groups: categoryFiltered ? [] : buildGroups(hydratedItems, params),
      tookMs: Date.now() - started,
      engine: 'opensearch',
    };
  } catch (error) {
    logger.warn('search.opensearch_failed_falling_back', { reason: (error as Error).message });
    return searchPostgres(params);
  }
}

export async function searchProducts(params: SearchParams): Promise<SearchResult> {
  return config.search.enabled ? searchOpenSearch(params) : searchPostgres(params);
}

/** Projects a published product into the search index / `search_documents` table. */
export async function indexProduct(productId: string): Promise<void> {
  const product = await prisma.product.findUnique({
    where: { id: productId },
    include: {
      translations: true,
      tags: true,
      media: { orderBy: { position: 'asc' } },
      ticketTypes: { where: { active: true }, orderBy: { basePriceCents: 'asc' } },
      destination: true,
      reviews: { where: { status: 'PUBLISHED' }, select: { body: true, title: true } },
    },
  });
  if (!product) return;

  // Build the ancestor chain so searching "france" also finds Paris products.
  const destinationPath: string[] = [];
  let cursor = product.destination;
  while (cursor) {
    destinationPath.unshift(cursor.slug);
    cursor = cursor.parentId
      ? await prisma.destination.findUnique({ where: { id: cursor.parentId }, include: { parent: true } })
      : null;
  }

  const defaultTranslation = product.translations.find((t) => t.locale === product.defaultLocale) ?? product.translations[0];

  // Every locale's copy goes into `body` — not just the default.
  //
  // The Postgres matcher scans `title`/`body`/`keywords`, so a Chinese shopper
  // searching 「私享向导」 must hit a product whose only English word is
  // "guide". That works because `body` is matched as a *substring*
  // (`contains`), so a contiguous query matches a contiguous field regardless of
  // language — no tokeniser is involved. FTS cannot do this here: measured on
  // this catalogue, `to_tsvector('simple', '伦敦私享向导一日')` yields the single
  // lexeme `'伦敦私享向导一日':1`, i.e. Chinese is not segmentable at all without
  // zhparser. See docs/search-index-design.md.
  const localizedCopy = product.translations.flatMap((t) => [
    t.name,
    t.summary ?? '',
    ...(t.highlights ?? []),
    ...(t.includes ?? []),
  ]);

  const body = [
    ...localizedCopy,
    defaultTranslation?.description ?? '',
    product.addressLine ?? '',
    product.meetingPoint ?? '',
    product.airlineName ?? '',
    product.cruiseLine ?? '',
    product.shipName ?? '',
    product.roomCategory ?? '',
    product.cabinClass ?? '',
    ...product.reviews.map((r) => `${r.title ?? ''} ${r.body}`),
  ]
    .filter(Boolean)
    .join(' ');

  const basePriceCents = product.ticketTypes[0]?.basePriceCents ?? 0;
  const ratingBreakdown = await prisma.ratingBreakdown.findMany({ where: { productId } });
  const popularity =
    product.ratingAvg * 10 +
    Math.log(product.ratingCount + 1) * 5 +
    (product.instantConfirm ? 3 : 0) +
    (product.skipTheLine ? 2 : 0);

  const doc = {
    productId: product.id,
    title: defaultTranslation?.name ?? product.slug,
    titleAll: product.translations.map((t) => t.name),
    summary: defaultTranslation?.summary ?? null,
    body,
    // `keywords` holds **tokens**, not prose.
    //
    // The Postgres matcher tests this field with `has`, which is an exact
    // array-element comparison. Seeding it with whole sentences (`localizedCopy`
    // contains full titles, summaries and highlight paragraphs) meant those
    // entries could only ever be hit by a shopper typing the sentence verbatim —
    // and the same content was already reachable through `body`, which is
    // substring-matched. So the array was simultaneously useless and, because
    // the two fields match differently, a source of "why did *that* not match"
    // behaviour that cannot be explained to a user.
    //
    // Tags stay: a tag label is a genuine token (`five-star`,
    // `breakfast-included`), lives in no other indexed field, and is exactly
    // what exact matching is for. The prose is in `body`, unaltered.
    keywords: product.tags
      .map((t) => t.label)
      .filter(Boolean)
      .map((k) => String(k).toLowerCase()),
    tags: product.tags.map((t) => t.slug),
    destinationPath,
    countryCode: product.destination?.countryCode ?? null,
    cityName: destinationPath.length ? product.destination?.name ?? null : null,
    type: product.type,
    latitude: product.latitude,
    longitude: product.longitude,
    ratingAvg: product.ratingAvg,
    ratingCount: product.ratingCount,
    basePriceCents,
    currency: product.ticketTypes[0]?.currency ?? 'USD',
    popularityScore: popularity,
    instantConfirm: product.instantConfirm,
    freeCancellation: product.freeCancellation,
    skipTheLine: product.skipTheLine,
    status: product.status,
    indexedAt: new Date(),
  };

  await prisma.searchDocument.upsert({
    where: { productId: product.id },
    create: doc,
    update: doc,
  });

  if (ratingBreakdown.length > 0) {
    // Keep the breakdown warm for the reviews tab without a second query.
    void ratingBreakdown;
  }

  if (config.search.enabled) {
    try {
      const endpoint = `${config.search.node}/${config.search.index}/_doc/${encodeURIComponent(product.id)}`;
      await fetch(endpoint, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...doc,
          // OpenSearch needs a geo_point for geo_distance sorting.
          location: product.latitude !== null && product.longitude !== null
            ? { lat: product.latitude, lon: product.longitude }
            : undefined,
        }),
      });
    } catch (error) {
      logger.warn('search.index_push_failed', { productId, reason: (error as Error).message });
    }
  }
}

/** Bulk reindex, used after seeding or when back-filling translations. */
export async function reindexAll(): Promise<number> {
  const products = await prisma.product.findMany({ where: { status: 'PUBLISHED' }, select: { id: true } });
  for (const product of products) await indexProduct(product.id);
  return products.length;
}

/** Recalculates cached availability per day for a product (calendar UI). */
export async function refreshAvailabilityCalendar(productId: string, from: Date, days = 90): Promise<void> {
  const ticketTypes = await prisma.ticketType.findMany({
    where: { productId, active: true },
    select: { id: true, basePriceCents: true, inventoryMode: true },
  });
  if (ticketTypes.length === 0) return;

  const window = eachDay(from, new Date(from.getTime() + days * 86_400_000));
  const records = await prisma.inventoryRecord.findMany({
    where: {
      ticketTypeId: { in: ticketTypes.map((t) => t.id) },
      serviceDate: { gte: window[0], lte: window[window.length - 1] },
    },
  });

  const priceByType = new Map(ticketTypes.map((t) => [t.id, t.basePriceCents]));

  for (const day of window) {
    const key = formatServiceDate(day);
    let available = 0;
    let minPrice = Infinity;

    for (const record of records) {
      if (formatServiceDate(record.serviceDate) !== key) continue;
      if (record.status !== 'OPEN') continue;
      available += Math.max(0, record.capacityTotal - record.capacityHeld - record.capacitySold);
      minPrice = Math.min(minPrice, priceByType.get(record.ticketTypeId) ?? 0);
    }

    const existing = await prisma.availabilityCalendar.findUnique({
      where: { productId_serviceDate: { productId, serviceDate: day } },
    });

    const status = available === 0 ? 'SOLD_OUT' : available < 10 ? 'LIMITED' : 'AVAILABLE';

    if (available === 0 && !existing) {
      // Only persist meaningful rows; absent = "not bookable".
      continue;
    }

    const data = { status, minPriceCents: Number.isFinite(minPrice) ? minPrice : 0, availableQty: available, updatedAt: new Date() };
    if (existing) {
      await prisma.availabilityCalendar.update({ where: { id: existing.id }, data });
    } else {
      await prisma.availabilityCalendar.create({ data: { productId, serviceDate: day, ...data } });
    }
  }
}

export function assertSearchEngine(): void {
  if (!config.search.enabled) {
    logger.info('search.engine', { engine: 'postgres', note: 'set OPENSEARCH_NODE to enable OpenSearch' });
  }
}