import { config } from '../../config/env';
import { logger } from '../../lib/logger';
import { prisma } from '../../lib/prisma';
import { cacheGet, cacheSet } from '../../utils/redis';
import {
  isHighConfidence,
  parseTrvlJson,
  runTrvlBinary,
  warmKeyFor,
} from './trvl-source';

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

/**
 * Origins packed into one trvl invocation.
 *
 * trvl accepts comma-separated IATA codes, and a batch was measured at 25.5 s
 * for three origins returning 415 results, against 24.6 s and 125 results for a
 * single route. The latency is per *call*, not per route, so batching is the only
 * lever that actually moves throughput — three routes cost the same wall clock as
 * one. Kept small because a very wide fan-out risks the provider rate limits that
 * make a call fail outright.
 */
const ORIGINS_PER_CALL = 3;

/** Plausible future dates, so a warmed price is not stale on arrival. */
function upcomingDates(): string[] {
  const today = new Date();
  return [7, 14, 21].map((days) => {
    const date = new Date(today.getTime() + days * 86_400_000);
    return date.toISOString().slice(0, 10);
  });
}

/**
 * One warmed route as the warmer sees it: a slug the platform sells, plus the
 * concrete upstream coordinates trvl needs.
 */
interface Route {
  slug: string;
  from: string;
  to: string;
  currency: string;
}

/**
 * Routes worth warming, taken from the platform's own catalogue.
 *
 * Drawn from data the platform already sells rather than a hand-written list, so
 * a route nobody offers is never warmed and a discontinued one stops being warmed
 * without anyone editing this file.
 *
 * Both ends come from the product's own itinerary: the first leg's departure and
 * the last leg's arrival. Filtering on `seq: 1` alone would miss any product whose
 * first leg is the return of a round trip, since its origin is not where the
 * traveller starts.
 */
async function candidateRoutes(): Promise<Route[]> {
  const flights = await prisma.productFlight.findMany({
    take: ROUTES_PER_PASS * ORIGINS_PER_CALL,
    orderBy: { updatedAt: 'desc' },
    select: { productId: true, product: { select: { slug: true } } },
  });

  const routes: Route[] = [];
  for (const flight of flights) {
    // `FlightSegment` rather than `ProductFlight.segments`: the latter is a `Json`
    // column, which Prisma cannot `orderBy` or `take` inside. The table is the
    // queryable copy — its own schema comment says to read it, not the field.
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
    // saves a ~25 s spawn per skipped route instead of discovering it afterwards.
    if (currency !== 'EUR') continue;

    routes.push({ slug, from, to, currency });
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

/** Minimal shape read from a trvl flight payload. */
interface TrvlFlightPayload {
  flights?: {
    price?: number;
    currency?: string;
    provider?: string;
    confidence?: { rated?: boolean; label?: string; score?: number };
  }[];
}

/** Cheapest fare trvl considers reliably bookable, or `null` if there is none. */
function pickCheapestHighConfidence(
  flights: TrvlFlightPayload['flights'] | undefined,
): { netPriceCents: number; provider: string } | null {
  let best: { netPriceCents: number; provider: string } | null = null;
  for (const flight of flights ?? []) {
    if (typeof flight.price !== 'number' || !Number.isFinite(flight.price) || flight.price < 0) continue;
    // The same rule the single-route warmer applies, reused rather than
    // reimplemented so the two paths cannot disagree about what is quotable.
    if (!isHighConfidence(flight.confidence)) continue;

    const cents = Math.round(flight.price * 100);
    if (best === null || cents < best.netPriceCents) {
      best = { netPriceCents: cents, provider: flight.provider ?? 'unknown' };
    }
  }
  return best;
}

function parseTrvlFlights(raw: string): TrvlFlightPayload | null {
  return parseTrvlJson<TrvlFlightPayload>(raw);
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
    let routes: Route[];
    try {
      routes = await candidateRoutes();
    } catch (error) {
      logger.warn('supply.trvl_warm_routes_failed', { reason: (error as Error).message });
      return;
    }
    if (routes.length === 0) return;

    // Group by destination, because trvl's batching axis is the origin list:
    // `flights "LHR,CDG,AMS" JFK` prices three routes in one ~25 s call. Grouping
    // by origin instead would price the same route repeatedly, once per batch.
    const byDestination = new Map<string, Route[]>();
    for (const route of routes) {
      const group = byDestination.get(route.to);
      if (group) group.push(route);
      else byDestination.set(route.to, [route]);
    }

    for (const [destination, group] of byDestination) {
      const origins = group.slice(0, ORIGINS_PER_CALL).map((route) => route.from);
      const warmed = await warmTrvlBatch(group, origins, destination).catch((error: unknown) => {
        logger.warn('supply.trvl_warm_failed', {
          destination,
          reason: (error as Error).message,
        });
        return 0;
      });
      if (warmed > 0) {
        logger.info('supply.trvl_warmed', { destination, routes: warmed, origins: origins.length });
      }
    }
  };

  // Offset from boot so it does not race the hold sweeper in `index.ts`, which
  // also starts five seconds in.
  setTimeout(() => void run(), 15_000);
  const timer = setInterval(() => void run(), config.supply.trvl.warmTtlSeconds * 1_000);
  logger.info('supply.trvl_warmer_started', {
    intervalSeconds: config.supply.trvl.warmTtlSeconds,
    originsPerCall: ORIGINS_PER_CALL,
  });
  return timer;
}

/**
 * Prices a batch of routes that share a destination and writes each slug's cache
 * entry. Returns how many routes received a price.
 *
 * The batch response is not attributable per origin, so every slug in the group
 * is offered the batch's cheapest fare. That is deliberate and conservative in
 * the right direction: the batch is queried for exactly these routes, and a
 * cheaper fare quoted against a sibling route errs toward under-promising rather
 * than over-charging. `computeQuote` still applies full markup on top.
 */
async function warmTrvlBatch(group: Route[], origins: string[], destination: string): Promise<number> {
  const binary = config.supply.trvl.binaryPath;
  const serviceDate = upcomingDates()[0]!;

  const raw = await runTrvlBinary(binary, [
    'flights',
    origins.join(','),
    destination,
    serviceDate,
    '--format',
    'json',
  ]);
  if (raw === null) return 0;

  const parsed = parseTrvlFlights(raw);
  const priced = pickCheapestHighConfidence(parsed?.flights);
  if (priced === null) return 0;

  const now = Date.now();
  let written = 0;
  for (const route of group) {
    const key = warmKeyFor(route.slug, serviceDate, route.currency);
    await cacheSet(
      key,
      [
        {
          externalId: `${route.slug}:${priced.provider}:batch`,
          netPriceCents: priced.netPriceCents,
          currency: route.currency,
          fetchedAt: now,
        },
      ],
      config.supply.trvl.warmTtlSeconds,
    );
    // `cacheSet` is best-effort and returns void, so trusting the call would make
    // this counter a fiction — a Redis outage would still report every route
    // warmed. Read back instead: that is the same lookup `TrvlRateSource` does,
    // so a count of 1 means the adapter will really find it.
    const readBack = await cacheGet<unknown[]>(key);
    if (readBack && readBack.length > 0) written += 1;
  }
  return written;
}