import { ProductType } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../config/env';
import { prisma } from '../lib/prisma';
import { resolveLocale } from '../plugins/auth';
import { TYPE_LABELS, searchProducts, typeLabel } from '../modules/search/service';
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
  ships: z.string().trim().max(200).optional(),
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
      carrierNameIn: csv(params.carriers),
      shipNameIn: csv(params.ships),
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
}