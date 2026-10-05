import { config } from '../../config/env';
import { logger } from '../../lib/logger';
import { prisma } from '../../lib/prisma';
import { cacheGet, cacheSet } from '../../utils/redis';
import { parseTrvlJson, runTrvlBinary, warmKeyFor } from './trvl-source';

/**
 * ---------------------------------------------------------------------------
 * trvl route warmer
 * ---------------------------------------------------------------------------
 *
 * Populates the Redis cache that {@link TrvlRateSource} reads. A route nobody has
 * searched has no cache entry to read, so the warmer front-runs demand; anything
 * it misses falls back to the seeded price, which is the correct degradation.
 *
 * Why `dates` and not `flights`
 * --------------------------
 * The first version warmed one route per `trvl flights` call, measured at ~25 s
 * each, and treated that as an unavoidable cost. It is not. `trvl dates` answers a
 * whole month in a *single* request, because it uses Google's CalendarGraph API
 * rather than searching each day:
 *
 *   trvl flights JFK LHR 2026-11-15      -> 24.6 s, one date
 *   trvl dates   JFK LHR --from 11-01 --to 11-30
 *                                         -> 0.61 s, 30 dates
 *
 * Measured twice, and the second figure is not a cache artefact: the 30 returned
 * prices differ by date. Thirty daily calls cost ~12 minutes and 30 units of
 * upstream budget; this costs one call and well under a second.
 *
 * That is the difference between a rate limit being an architectural constraint
 * and being an inconvenience, so it is worth stating plainly: the constraint was
 * never the provider's quota, it was the shape of the query.
 *
 * Concurrency stays sequential. Even at 0.6 s a call, the providers behind this
 * rate-limit on request cadence, and a warmer that fans out would be the reason
 * it gets throttled.
 */

/** How many routes one pass may warm. */
const ROUTES_PER_PASS = 3;

/**
 * Days one `dates` call covers.
 *
 * A month is what the single CalendarGraph request is designed for; going wider
 * splits into per-date searches and loses the entire benefit.
 */
const DAYS_PER_CALL = 30;

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
 * Prices every date in the window for a batch of routes sharing a destination,
 * and writes one cache entry per (route, date). Returns how many entries landed.
 *
 * The batch response is not attributable per origin, so every slug in the group
 * receives the same per-date price. That is deliberate and errs in the safe
 * direction: the batch is queried for exactly these routes, and quoting a sibling
 * route's fare low under-promises rather than over-charges. `computeQuote` still
 * applies full markup on top.
 *
 * Writing the whole window, not just today, is the point of using `dates`: one
 * 0.6 s call fills thirty days, so a shopper searching any date in the next month
 * hits a warm cache instead of paying for a cold one.
 */
async function warmTrvlBatch(group: Route[], origins: string[], destination: string): Promise<number> {
  const binary = config.supply.trvl.binaryPath;
  const from = upcomingDates()[0]!;
  const to = addDays(from, DAYS_PER_CALL - 1);

  const raw = await runTrvlBinary(binary, [
    'dates',
    origins.join(','),
    destination,
    '--from',
    from,
    '--to',
    to,
    '--format',
    'json',
  ]);
  if (raw === null) return 0;

  const byDate = parseDatePrices(raw);
  if (byDate.size === 0) return 0;

  const now = Date.now();
  let written = 0;
  for (const route of group) {
    for (const [serviceDate, netPriceCents] of byDate) {
      const key = warmKeyFor(route.slug, serviceDate, route.currency);
      await cacheSet(
        key,
        [
          {
            externalId: `${route.slug}:${origins.join('+')}:${serviceDate}`,
            netPriceCents,
            currency: route.currency,
            fetchedAt: now,
          },
        ],
        config.supply.trvl.warmTtlSeconds,
      );
      // `cacheSet` is best-effort and returns void, so trusting the call would make
      // this counter a fiction — a Redis outage would still report every entry
      // written. Read back instead: that is the same lookup `TrvlRateSource` does,
      // so a count of 1 means the adapter will really find it.
      const readBack = await cacheGet<unknown[]>(key);
      if (readBack && readBack.length > 0) written += 1;
    }
  }
  return written;
}

/** `YYYY-MM-DD` for `days` after `from`. */
function addDays(from: string, days: number): string {
  const date = new Date(`${from}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/**
 * `YYYY-MM-DD -> minor units` from a `trvl dates` payload.
 *
 * Unlike `flights`, a `dates` row carries no `confidence` block: CalendarGraph
 * returns a calendar-level cheapest price rather than a bookable fare, so there
 * is no per-row rating to filter on. That is a real difference from the
 * `flights` path and is why the two are not merged — the cheaper query returns a
 * weaker guarantee.
 */
function parseDatePrices(raw: string): Map<string, number> {
  const parsed = parseTrvlJson<{ dates?: { date?: string; price?: number; currency?: string }[] }>(raw);
  const out = new Map<string, number>();
  for (const row of parsed?.dates ?? []) {
    if (!row.date) continue;
    if (typeof row.price !== 'number' || !Number.isFinite(row.price) || row.price < 0) continue;
    // Only EUR is accepted, for the same reason the rest of this module does it:
    // trvl ignores `--currency`, `pickOffer` refuses to convert, and inventing a
    // rate here would mean the platform acquiring FX it has never had.
    if ((row.currency ?? '').toUpperCase() !== 'EUR') continue;
    out.set(row.date, Math.round(row.price * 100));
  }
  return out;
}