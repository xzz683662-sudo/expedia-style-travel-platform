import { Prisma, ProductType } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { resolveLocale } from '../plugins/auth';
import { TYPE_LABELS, searchProducts, typeLabel } from '../modules/search/service';
import { findFlightsConnectingThrough, summariseConnectionPoints } from '../modules/search/connections';
import { realtimeFlights } from '../modules/supply/realtime-flight';
import { AppError } from '../utils/errors';

const listSchema = z.object({
  q: z.string().trim().max(200).optional(),
  destination: z.string().trim().max(200).optional(),
  destinations: z.string().trim().max(600).optional(),
  type: z.enum(Object.keys(TYPE_LABELS) as [string, ...string[]]).optional(),
  /**
   * Unified multi-category query: a comma-separated list of product types, e.g.
   * `/search?types=HOTEL_ROOM,TOUR`. Coexists with the single `type` alias so
   * existing links keep working; `types` wins when both are sent.
   */
  types: z.string().trim().max(600).optional(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  dates: z.string().trim().max(200).optional(),
  minPrice: z.coerce.number().int().min(0).optional(),
  maxPrice: z.coerce.number().int().min(0).optional(),
  minRating: z.coerce.number().min(0).max(5).optional(),
  instantConfirm: z.coerce.boolean().optional(),
  freeCancellation: z.coerce.boolean().optional(),
  skipTheLine: z.coerce.boolean().optional(),
  /**
   * Phase 0 category facets. CSV lists so a card grid can offer multi-select
   * ("4 or 5 stars", "any of these carriers") in one request, matching how
   * `tags` already behaves. Validated and dropped when empty.
   */
  stars: z.string().trim().max(60).optional(),
  carriers: z.string().trim().max(200).optional(),
  carrierCodes: z.string().trim().max(200).optional(),
  ships: z.string().trim().max(200).optional(),
  destinationPorts: z.string().trim().max(200).optional(),
  boardBasis: z.string().trim().max(200).optional(),
  tags: z.string().trim().max(400).optional(),
  lat: z.coerce.number().min(-90).max(90).optional(),
  lng: z.coerce.number().min(-180).max(180).optional(),
  radiusKm: z.coerce.number().min(1).max(500).optional(),
  sort: z.enum(['RELEVANCE', 'PRICE_ASC', 'PRICE_DESC', 'RATING', 'POPULARITY', 'DISTANCE']).optional(),
  /** `TYPE` returns one bucket per category (default); `NONE` disables grouping. */
  groupBy: z.enum(['TYPE', 'NONE']).optional(),
  groupLimit: z.coerce.number().int().min(1).max(24).optional(),
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(60).optional(),
  locale: z.string().optional(),
});

const PRODUCT_TYPE_VALUES = Object.keys(TYPE_LABELS) as [string, ...string[]];

/** Splits a CSV query parameter, dropping blanks and unknown enum values. */
function csv(value: string | undefined, allowed?: readonly string[]): string[] | undefined {
  const parts = value
    ?.split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  if (!parts?.length) return undefined;
  const values = allowed ? parts.filter((part) => allowed.includes(part)) : parts;
  return values.length ? values : undefined;
}

/**
 * CSV of integers within `[min, max]`.
 *
 * Out-of-range and non-numeric entries are dropped rather than rejected: a
 * storefront that offers "3, 4, 5 stars" chips should not 422 because one chip
 * carried a stray value, and it should not silently widen the filter either.
 * Deduplicated so `?stars=4,4,5` produces one index round-trip per value.
 */
function csvNumberList(value: string | undefined, min: number, max: number): number[] | undefined {
  const parsed = (value ?? '')
    .split(',')
    .map((part) => Number.parseInt(part.trim(), 10))
    .filter((n) => Number.isInteger(n) && n >= min && n <= max);
  const unique = [...new Set(parsed)];
  return unique.length ? unique : undefined;
}

/**
 * Search + discovery endpoints.
 * Mirrors the shape Expedia-style clients expect: filters, facets, sorting
 * and pagination all round-trip through the same query string.
 */
export async function searchRoutes(app: FastifyInstance): Promise<void> {
  app.get('/search', async (request) => {
    const params = listSchema.parse(request.query);
    const locale = resolveLocale(request);

    // `types` (multi) supersedes the legacy single `type` filter so both the
    // category tabs and the multi-select facet feed the same unified query.
    const types = csv(params.types, PRODUCT_TYPE_VALUES) as ProductType[] | undefined;

    const started = Date.now();
    const result = await searchProducts({
      query: params.q,
      destinationSlug: params.destination,
      destinationSlugIn: csv(params.destinations),
      type: types ? undefined : (params.type as ProductType | undefined),
      typeIn: types,
      serviceDate: params.date,
      serviceDates: csv(params.dates),
      minPriceCents: params.minPrice,
      maxPriceCents: params.maxPrice,
      minRating: params.minRating,
      instantConfirmOnly: params.instantConfirm,
      freeCancellationOnly: params.freeCancellation,
      skipTheLineOnly: params.skipTheLine,
      // `stars` is numeric and bounded; a bad value yields undefined rather than
      // a 500 or a filter that silently matches nothing the user can see.
      starRatingIn: csvNumberList(params.stars, 1, 5),
      carrierCodeIn: csv(params.carrierCodes),
      carrierNameIn: csv(params.carriers),
      shipNameIn: csv(params.ships),
      destinationPortIn: csv(params.destinationPorts),
      boardBasisIn: csv(params.boardBasis),
      tags: csv(params.tags),
      latitude: params.lat,
      longitude: params.lng,
      radiusKm: params.radiusKm,
      sort: params.sort,
      groupBy: params.groupBy ?? 'TYPE',
      groupLimit: params.groupLimit,
      page: params.page,
      pageSize: params.pageSize,
      locale,
    });

    // Fire-and-forget merchandising analytics.
    if (request.user) {
      void prisma.searchQueryLog.create({
        data: {
          userId: request.user.id,
          query: params.q,
          productType: (types?.[0] ?? params.type) as ProductType | undefined,
          filters: JSON.parse(JSON.stringify(params)),
          sort: params.sort,
          resultCount: result.total,
          tookMs: Date.now() - started,
        },
      });
    }

    return result;
  });

  /**
   * Category roll-up for the unified search panel.
   *
   * One aggregate instead of one request per category: the storefront uses it to
   * render the category tab bar (and its counts) *before* the shopper types
   * anything, so the multi-category nature of the catalogue is visible up front.
   */
  app.get('/search/categories', async (request) => {
    const query = z.object({ destination: z.string().trim().max(200).optional() }).parse(request.query);
    const locale = resolveLocale(request);

    const rows = await prisma.searchDocument.groupBy({
      by: ['type'],
      where: {
        status: 'PUBLISHED',
        ...(query.destination ? { destinationPath: { has: query.destination } } : {}),
      },
      _count: { _all: true },
      _min: { basePriceCents: true },
    });

    const categories = rows
      .map((row) => ({
        type: row.type,
        label: typeLabel(row.type, locale),
        productCount: row._count._all,
        fromPriceCents: row._min.basePriceCents ?? 0,
      }))
      .sort((a, b) => b.productCount - a.productCount);

    return { categories, total: categories.reduce((sum, category) => sum + category.productCount, 0) };
  });

  /** Popular destinations for the landing page and the nav mega-menu. */
  app.get('/destinations', async () => {
    const destinations = await prisma.destination.findMany({
      where: { level: 'CITY', isPopular: true },
      orderBy: { sortWeight: 'asc' },
      // No hard cap: the catalogue now spans 34 cities across 14 countries, and
      // a `take` here silently truncated the tail — Sydney and Melbourne simply
      // vanished from the landing page and the geo coverage check. The home page
      // still renders only the first 8; this endpoint is the full list.
      include: {
        products: {
          where: { status: 'PUBLISHED' },
          select: { id: true },
        },
      },
    });

    return destinations.map((d) => ({
      slug: d.slug,
      name: d.name,
      countryCode: d.countryCode,
      heroImageUrl: d.heroImageUrl,
      latitude: d.latitude,
      longitude: d.longitude,
      productCount: d.products.length,
    }));
  });

  /** Curated landing rails: "Trending now", "Top rated", "Family picks". */
  app.get('/collections/:slug', async (request) => {
    const { slug } = z.object({ slug: z.string() }).parse(request.params);

    const known: Record<string, { title: string; filter: Record<string, unknown> }> = {
      trending: { title: 'Trending now', filter: { sort: 'POPULARITY', pageSize: 12 } },
      'top-rated': { title: 'Traveler favorites', filter: { sort: 'RATING', minRating: 4.5, pageSize: 12 } },
      'skip-the-line': { title: 'Skip the line', filter: { skipTheLineOnly: true, pageSize: 12 } },
      'free-cancellation': { title: 'Free cancellation', filter: { freeCancellationOnly: true, pageSize: 12 } },
      'instant-confirmation': { title: 'Instant confirmation', filter: { instantConfirmOnly: true, pageSize: 12 } },
      deals: { title: 'Deals of the day', filter: { sort: 'PRICE_ASC', pageSize: 12 } },
    };

    const collection = known[slug];
    if (!collection) throw AppError.notFound('Collection');

    const result = await searchProducts({
      ...(collection.filter as Parameters<typeof searchProducts>[0]),
      page: 1,
    });

    return { ...result, title: collection.title };
  });

  /**
   * Flights that connect through an airport.
   *
   * `requireChange=true` is the difference between "flights to HKG" and
   * "flights via HKG" — without it the first leg of any HKG departure counts as
   * a connection, which is true but useless.
   */
  app.get('/search/connections', async (request) => {
    const params = z
      .object({
        airport: z.string().trim().min(2).max(4),
        requireChange: z.coerce.boolean().default(false),
        maxDurationMinutes: z.coerce.number().int().positive().max(60 * 48).optional(),
        minLayoverMinutes: z.coerce.number().int().min(0).max(60 * 24).optional(),
        maxLayoverMinutes: z.coerce.number().int().min(0).max(60 * 24).optional(),
        limit: z.coerce.number().int().positive().max(50).default(20),
      })
      .refine(
        (value) =>
          value.minLayoverMinutes === undefined ||
          value.maxLayoverMinutes === undefined ||
          value.minLayoverMinutes <= value.maxLayoverMinutes,
        { message: 'minLayoverMinutes must not exceed maxLayoverMinutes' },
      )
      .parse(request.query);

    const itineraries = await findFlightsConnectingThrough(params);

    // Products carry the commercial terms the itinerary alone does not: price,
    // cabin and cancellation. A leg list without them is not bookable, so the
    // two are joined here rather than making the caller do it.
    const products = await prisma.product.findMany({
      where: { id: { in: itineraries.map((itinerary) => itinerary.productId) } },
      select: {
        id: true,
        slug: true,
        summary: true,
        airlineName: true,
        flightRoute: true,
        cabinClass: true,
        ratingAvg: true,
        ratingCount: true,
        freeCancellation: true,
        instantConfirm: true,
        ticketTypes: { where: { active: true }, orderBy: { basePriceCents: 'asc' }, take: 1, select: { basePriceCents: true, currency: true } },
        destination: { select: { slug: true, name: true, countryCode: true } },
      },
    });
    const byId = new Map(products.map((product) => [product.id, product]));

    return {
      airport: params.airport.toUpperCase(),
      requireChange: params.requireChange,
      total: itineraries.length,
      items: itineraries
        .map((itinerary) => {
          const product = byId.get(itinerary.productId);
          // A segment row can outlive its product if the product was deleted
          // outside a cascade; skipping keeps the list self-consistent.
          if (!product) return null;
          const cheapest = product.ticketTypes[0] ?? null;
          const { ticketTypes, ...rest } = product;
          return {
            ...rest,
            priceCents: cheapest?.basePriceCents ?? null,
            currency: cheapest?.currency ?? null,
            itinerary: itinerary.legs,
            layoversMinutes: itinerary.layoversMinutes,
          };
        })
        .filter((item): item is NonNullable<typeof item> => item !== null),
    };
  });

  /** Where itineraries actually change aircraft, for a connection picker. */
  app.get('/search/connections/points', async () => ({ items: await summariseConnectionPoints() }));

  /**
   * Airport directory, imported from an open dataset — see
   * `docs/supply-sources.md` and `pnpm --filter @easytrip/api supply:import`.
   *
   * The catalogue carries ~4,000 real airports with coordinates and IATA/ICAO
   * codes. That is what makes `/search/connections` able to answer for an airport
   * the platform sells no flight to: without it, a connection picker can only
   * offer hubs already present in the inventory.
   *
   * `origin` travels with every row because the dataset's licence has to be
   * attributable from the data, not from someone's memory of where it came from.
   */
  app.get('/search/airports', async (request) => {
    const params = z
      .object({
        q: z.string().trim().max(120).optional(),
        country: z.string().trim().length(2).toUpperCase().optional(),
        near: z
          .string()
          .trim()
          .regex(/^-?\d+(?:\.\d+)?,-?\d+(?:\.\d+)?$/)
          .optional(),
        radiusKm: z.coerce.number().int().min(1).max(500).default(100),
        limit: z.coerce.number().int().min(1).max(50).default(20),
      })
      .parse(request.query);

    const where: Prisma.DestinationWhereInput = {
      level: 'AIRPORT',
      iataCode: { not: null },
    };

    if (params.country) where.countryCode = params.country;
    if (params.q) {
      // Matches the code or the name. `contains` is case-insensitive on Postgres
      // for ASCII, which covers every airport name in this dataset.
      where.OR = [{ iataCode: { contains: params.q.toUpperCase() } }, { name: { contains: params.q } }];
    }

    if (params.near) {
      const [lat, lng] = params.near.split(',').map(Number) as [number, number];
      // Bounding box first, then an exact great-circle filter. The box uses the
      // `latitude`/`longitude` index; the circle is what actually answers
      // "within N km", and a box alone would return a square.
      const latDelta = params.radiusKm / 111.32;
      const lngDelta = params.radiusKm / (111.32 * Math.max(0.01, Math.cos((lat * Math.PI) / 180)));
      where.latitude = { gte: lat - latDelta, lte: lat + latDelta };
      where.longitude = { gte: lng - lngDelta, lte: lng + lngDelta };
    }

    const rows = await prisma.destination.findMany({
      where,
      select: {
        slug: true,
        name: true,
        iataCode: true,
        icaoCode: true,
        countryCode: true,
        latitude: true,
        longitude: true,
        origin: true,
      },
      orderBy: [{ iataCode: 'asc' }],
      take: params.limit,
    });

    let items = rows.map((row) => ({
      ...row,
      distanceKm:
        params.near && row.latitude !== null && row.longitude !== null
          ? haversineKm(
              Number(params.near.split(',')[0]),
              Number(params.near.split(',')[1]),
              row.latitude,
              row.longitude,
            )
          : null,
    }));

    if (params.near) {
      items = items
        .filter((row) => row.distanceKm !== null && row.distanceKm <= params.radiusKm)
        .sort((a, b) => (a.distanceKm ?? 0) - (b.distanceKm ?? 0));
    }

    return { total: items.length, items };
  });

  /** Provenance for one imported row: which dataset, under which licence. */
  app.get('/search/airports/:iata/source', async (request) => {
    const { iata } = z
      .object({ iata: z.string().trim().length(3).toUpperCase() })
      .parse(request.params);

    const airport = await prisma.destination.findUnique({
      where: { iataCode: iata },
      select: { id: true, name: true, iataCode: true, origin: true },
    });
    if (!airport) throw AppError.notFound('Airport');

    const records = await prisma.supplySourceRecord.findMany({
      where: { entityType: 'Destination', entityId: airport.id },
      select: { sourceId: true, externalId: true, license: true, syncedAt: true, origin: true },
      orderBy: { syncedAt: 'desc' },
    });

    return { airport, sources: records };
  });

  /**
   * Live flight positions, fetched in real time from community ADS-B sources —
   * see `docs/supply-sources.md` ("Real-time sources"). Unlike the import
   * registry these adapters never write a row: positions are seconds-fresh and
   * ephemeral, so they live in a 30s Redis cache and nowhere else. The source
   * that answered travels on every item, so provenance is visible without
   * being persisted.
   */
  app.get('/search/flights/live', async (request) => {
    const params = z
      .object({
        lat: z.coerce.number().min(-90).max(90),
        lng: z.coerce.number().min(-180).max(180),
        radiusNm: z.coerce.number().int().min(1).max(250).default(25),
      })
      .parse(request.query);

    return { items: await realtimeFlights.near(params.lat, params.lng, params.radiusNm) };
  });

  app.get('/search/flights/:callsign/live', async (request) => {
    const { callsign } = z
      .object({ callsign: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{3,8}$/) })
      .parse(request.params);

    const flight = await realtimeFlights.byCallsign(callsign);
    if (!flight) throw AppError.notFound('Live flight');
    return { flight };
  });
}

/** Great-circle distance in km. Used only for ranking, so precision is ample. */
function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}