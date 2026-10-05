import { config } from '../../config/env';
import { logger } from '../../lib/logger';
import { prisma } from '../../lib/prisma';
import { warmTrvlRoute, type WarmQuery } from './trvl-source';
import type { LiveRateQuery } from './live';

/**
 * ---------------------------------------------------------------------------
 * trvl route warmer
 * ---------------------------------------------------------------------------
 *
 * Populates the Redis cache that {@link TrvlRateSource} reads. It exists because
 * a trvl invocation costs ~25 s, which cannot be spent inside a search request,
 * and because a route nobody has searched has no cache entry to read. The warmer
 * therefore front-runs demand: it warms the routes most likely to be searched
 * next, and anything it misses simply falls back to the seeded price.
 *
 * Two properties are deliberate:
 *
 *   - **Bounded concurrency.** Each call is a process spawn that can occupy
 *     ~25 s. Running routes in parallel would be faster but would multiply
 *     upstream load on providers that are already rate-limiting, which is both
 *     rude and self-defeating. Sequential, one at a time.
 *   - **A hard route cap per pass.** A pass that tried to warm everything would
 *     never finish, because one pass's own work exceeds the interval. The cap
 *     makes the loop terminate predictably and leaves the rest to the next pass.
 */

/** How many routes one pass may warm. */
const ROUTES_PER_PASS = 3;

/** Plausible future dates, so a warmed price is not stale on arrival. */
function upcomingDates(): string[] {
  const today = new Date();
  return [7, 14, 21].map((days) => {
    const date = new Date(today.getTime() + days * 86_400_000);
    return date.toISOString().slice(0, 10);
  });
}

/**
 * Routes worth warming: real flights that have inventory records on a soon date.
 *
 * Drawn from the platform's own catalogue rather than a hand-written list, so a
 * route nobody sells is never warmed and a route that stops selling stops being
 * warmed without anyone editing this file.
 *
 * Both ends come from the product's own itinerary: the first leg's departure and
 * the last leg's arrival. Filtering on `seq: 1` alone would miss any product
 * whose first leg is the return of a round trip, since its origin is not where
 * the traveller starts.
 */
async function candidateRoutes(): Promise<Array<LiveRateQuery & WarmQuery>> {
  const dates = upcomingDates();

  // Two queries rather than one nested select, because `ProductFlight.segments`
  // is a `Json` column: Prisma cannot `orderBy` or `take` inside it. The
  // `FlightSegment` table is the queryable copy — its own docs say so — and
  // `@@index([productId])` makes the extra lookup cheap.
  const flights = await prisma.productFlight.findMany({
    take: ROUTES_PER_PASS,
    orderBy: { updatedAt: 'desc' },
    select: { productId: true, product: { select: { slug: true } } },
  });

  const routes: Array<LiveRateQuery & WarmQuery> = [];
  for (const flight of flights) {
    const segments = await prisma.flightSegment.findMany({
      where: { productId: flight.productId },
      orderBy: { seq: 'asc' },
      select: { departureAirport: true, arrivalAirport: true },
    });
    if (segments.length === 0) continue;

    const from = segments[0]!.departureAirport.trim().toUpperCase();
    const to = segments[segments.length - 1]!.arrivalAirport.trim().toUpperCase();
    // Both ends must be real IATA codes. Half a route is not a cheaper query, it
    // is a rejected one that costs a process spawn to discover.
    if (from.length !== 3 || to.length !== 3) continue;

    const slug = flight.product.slug;
    const currency = await firstCurrency(slug);
    // trvl answers in EUR whatever `--currency` says, and the repo has no FX
    // table, so a non-EUR product can never accept its answer. Skipping here
    // saves a ~25 s spawn per skipped route instead of discovering it after.
    if (currency !== 'EUR') continue;

    routes.push({
      slug,
      category: 'FLIGHT',
      serviceDate: dates[0]!,
      quantity: 1,
      currency,
      from,
      to,
    });
  }
  return routes;
}

/**
 * The currency this product sells in.
 *
 * Read rather than assumed because `computeQuote` performs no FX conversion: a
 * quote warmed in the wrong currency is discarded by `pickOffer`, so warming it
 * would burn ~25 s of upstream for nothing.
 */
async function firstCurrency(slug: string): Promise<string | null> {
  const ticketType = await prisma.ticketType.findFirst({
    where: { product: { slug }, active: true },
    select: { currency: true },
  });
  return ticketType?.currency ?? null;
}

/**
 * Starts the warmer. Returns `null` when trvl is disabled, so the caller can
 * log that fact rather than silently running nothing.
 */
export function startTrvlWarmer(): NodeJS.Timeout | null {
  if (!config.supply.trvl.enabled || config.supply.trvl.binaryPath === '') {
    logger.info('supply.trvl_warmer_disabled');
    return null;
  }

  const run = async (): Promise<void> => {
    let routes: Array<LiveRateQuery & WarmQuery>;
    try {
      routes = await candidateRoutes();
    } catch (error) {
      logger.warn('supply.trvl_warm_routes_failed', { reason: (error as Error).message });
      return;
    }

    for (const route of routes) {
      // One route at a time, and a fresh date each pass, so a warmed entry is
      // never older than the interval that produces it.
      const warmed = await warmTrvlRoute({ ...route, serviceDate: route.serviceDate }).catch(
        (error: unknown) => {
          logger.warn('supply.trvl_warm_failed', { slug: route.slug, reason: (error as Error).message });
          return false;
        },
      );
      if (warmed) {
        logger.info('supply.trvl_warmed', { slug: route.slug, from: route.from, category: route.category });
      }
    }
  };

  // Offset from boot so it does not race the hold sweeper in `index.ts`, which
  // also starts five seconds in.
  setTimeout(() => void run(), 15_000);
  const timer = setInterval(() => void run(), config.supply.trvl.warmTtlSeconds * 1_000);
  logger.info('supply.trvl_warmer_started', {
    intervalSeconds: config.supply.trvl.warmTtlSeconds,
    routesPerPass: ROUTES_PER_PASS,
  });
  return timer;
}