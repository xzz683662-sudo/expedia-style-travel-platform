import { existsSync } from 'node:fs';
import { config } from '../../config/env';
import { logger } from '../../lib/logger';
import { prisma } from '../../lib/prisma';
import { cacheGet, cacheSet } from '../../utils/redis';
import { parseTrvlJson, runTrvlBinary, warmKeyFor, TRVL_NATIVE_CURRENCY, TRVL_SOURCE_ID } from './trvl-source';

/**
 * What the platform sells and settles in.
 *
 * Kept in lockstep with `utils/fx`'s reporting currency: it is the single
 * currency the whole catalogue is denominated in. trvl still answers EUR, and
 * that EUR is converted to this on the way out of `pickOffer` — so the warmed
 * cache is keyed by this while holding upstream-currency rows.
 */
const SETTLEMENT_CURRENCY = config.booking.defaultCurrency;

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

/**
 * Flights inspected per pass.
 *
 * Deliberately much larger than {@link ROUTES_PER_PASS}. An earlier version took
 * the newest nine flights and filtered them afterwards, and on this catalogue that
 * returned nine non-EUR products every single time — melbourne, sydney, singapore,
 * kyoto, tokyo, vancouver, toronto, las-vegas, chicago — so the warmer started,
 * logged, and silently warmed nothing.
 *
 * Now that the platform settles in a single currency there is no currency filter
 * left to satisfy, so this simply has to cover the catalogue: there are 34
 * flights and a shopper can ask for any of them.
 */
const FLIGHTS_SCANNED_PER_PASS = 120;

/**
 * Routes warmed per pass.
 *
 * Sized to the catalogue rather than to taste. An earlier value of 3 warmed nine
 * routes and search still showed no live price on any of the sixteen EUR flights,
 * because the odds of a shopper's query landing on one of nine specific routes
 * are poor. This now covers the whole flight catalogue in one pass.
 *
 * The cap is now about wall clock rather than coverage: calls are sequential and
 * measured between 0.8 s and 7 s for a valid pair, so a pass is bounded to tens
 * of seconds. Sequential because the providers behind this rate-limit on request
 * cadence, and a warmer that fans out is the reason it gets throttled.
 */
const ROUTES_PER_PASS = 40;

/**
 * Days one `dates` call covers.
 *
 * A month is what the single CalendarGraph request is designed for; going wider
 * splits into per-date searches and loses the entire benefit.
 */
const DAYS_PER_CALL = 30;

/** Plausible future dates, so a warmed price is not stale on arrival. */
/**
 * Start of the warmed window.
 *
 * Today, not "a week out". The detail page prices `selectedDate`, which defaults
 * to today when the shopper did not pass one, and `LiveRateQuery.serviceDate` is
 * an exact-date lookup rather than a range. Starting the window seven days ahead
 * meant the single most common request — open a product page with no date — never
 * hit a warm entry, which is how an entire cache can be full and still be useless.
 *
 * The window is `[today, today + DAYS_PER_CALL)`, so a product page asked for any
 * date in the next month finds one.
 */
function windowStart(): string {
  return new Date().toISOString().slice(0, 10);
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
    take: FLIGHTS_SCANNED_PER_PASS,
    orderBy: { updatedAt: 'desc' },
    select: {
      productId: true,
      product: { select: { slug: true } },
    },
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
    // Both ends must be real IATA codes, and they must differ. A same-airport
    // "route" is not a cheaper query, it is a slower one: measured at 34 s versus
    // 0.6 s for a valid pair, because trvl retries providers looking for a fare
    // that cannot exist. One such route in a batch costs thirty times the budget.
    if (from.length !== 3 || to.length !== 3 || from === to) continue;

    routes.push({ slug: flight.product.slug, from, to, currency: TRVL_NATIVE_CURRENCY });
    if (routes.length >= ROUTES_PER_PASS) break;
  }
  return routes;
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

  // A configured-but-absent binary is the common case: `TRVL_BINARY_PATH` points
  // at a download, and `/tmp` does not survive a machine restart. Checking only
  // that the string is non-empty meant every route logged a `spawn ENOENT` on
  // every pass — measured at 34 identical failures per pass, 15 minutes apart,
  // for a source that can never answer. Proving the binary exists *once*, here,
  // turns that into a single honest log line.
  if (!existsSync(config.supply.trvl.binaryPath)) {
    logger.warn('supply.trvl_warmer_disabled', {
      reason: 'binary not found',
      binaryPath: config.supply.trvl.binaryPath,
    });
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

    // One `dates` call per route. Measured, not assumed:
    //
    //   HKG -> DXB              6689 ms, 21 dates
    //   JFK -> DXB               831 ms, 21 dates
    //   DXB -> DXB             56116 ms, 0 dates
    //   "HKG,DXB,JFK" -> DXB   11560 ms, 0 dates
    //
    // So `dates` takes a single origin — the comma-separated form that `flights`
    // accepts silently returns nothing — and the origin must differ from the
    // destination. An earlier version grouped routes by destination and passed
    // several origins at once, on the assumption that batching worked the way it
    // does for `flights`. It does not: every such call returned zero and still
    // cost 11–30 s. Grouping was removed rather than patched, because a batch that
    // prices nothing is worse than no batch — it looks like coverage.
    for (const route of routes) {
      const warmed = await warmTrvlRoute(route).catch((error: unknown) => {
        logger.warn('supply.trvl_warm_failed', { slug: route.slug, reason: (error as Error).message });
        return 0;
      });
      if (warmed > 0) {
        logger.info('supply.trvl_warmed', { slug: route.slug, from: route.from, to: route.to, days: warmed });
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
    daysPerCall: DAYS_PER_CALL,
  });
  return timer;
}

/**
 * Prices every date in the window for one route and writes one cache entry per
 * date. Returns how many entries landed.
 *
 * Writing the whole window, not just today, is the point of using `dates`: one
 * call fills thirty days, so a shopper searching any date in the next month hits
 * a warm cache instead of paying for a cold one.
 */
async function warmTrvlRoute(route: Route): Promise<number> {
  const binary = config.supply.trvl.binaryPath;
  const from = windowStart();
  const to = addDays(from, DAYS_PER_CALL - 1);

  const raw = await runTrvlBinary(binary, [
    'dates',
    route.from,
    route.to,
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
  for (const [serviceDate, netPriceCents] of byDate) {
    // Keyed by the *settlement* currency, because that is what the resolver
    // asks with: `warmKeyFor` mirrors the resolver's cache identity. The stored
    // row keeps the upstream currency, because `pickOffer` converts on read.
    // Keying on EUR here instead would mean a USD request never finds a warmed
    // entry — a full cache and zero hits, which is the failure this module has
    // already produced once.
    const key = warmKeyFor(route.slug, serviceDate, SETTLEMENT_CURRENCY);
    await cacheSet(
      key,
      [
        {
          // The full `LiveOffer` shape, not a trimmed one.
          //
          // `LiveRateFinder.resolve()` reads this exact key itself, before it
          // ever reaches `TrvlRateSource.getRates` — so whatever is written here
          // is consumed as `LiveOffer[]` verbatim. A warmer row missing
          // `sourceId` therefore produced a quote whose `sourceId` was
          // `undefined`, silently, and `LivePriceInfo.sourceId` reached the
          // search response as null. One key, one shape.
          sourceId: TRVL_SOURCE_ID,
          externalId: `${route.slug}:${route.from}${route.to}:${serviceDate}`,
          netPriceCents,
          // The upstream's currency. `pickOffer` converts to the settlement
          // currency on the way out via `utils/fx`.
          currency: TRVL_NATIVE_CURRENCY,
          // The warmer records no allotment. `null` is "the source did not say",
          // which is a different claim from `0` ("confirmed sold out").
          sellable: null,
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
    // trvl ignores `--currency` and answers EUR, measured across four requested
    // currencies. Anything else is skipped rather than guessed at: the row has
    // no rate of its own, and inventing one is exactly what `utils/fx` exists
    // to prevent. `pickOffer` converts this EUR to the settlement currency.
    if ((row.currency ?? '').toUpperCase() !== TRVL_NATIVE_CURRENCY) continue;
    out.set(row.date, Math.round(row.price * 100));
  }
  return out;
}