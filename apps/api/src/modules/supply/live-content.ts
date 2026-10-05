import { ProductType } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { logger } from '../../lib/logger';
import { cacheGet, cacheSet } from '../../utils/redis';
import { realtimeFlights, type LiveFlight } from './realtime-flight';

/**
 * ---------------------------------------------------------------------------
 * Live content — what is actually true about a product right now
 * ---------------------------------------------------------------------------
 *
 * Deliberately a *separate* concern from {@link ./live.ts | live.ts}, which
 * answers "what does it cost and can I still sell it". This file never
 * influences price, stock or availability, and nothing in `booking/*` imports
 * it. Same separation `docs/supply-sources.md` insists on for the import
 * registry: identity and geometry come from one place, money from another.
 *
 * Why this is a geo query and not a callsign lookup
 * --------------------------------------------------
 * The catalogue cannot produce a reliable callsign. `FlightSegment` has no
 * `registration` column, `flightNumber` is populated on only 12 of 40 rows, and
 * the seeded carrier code and flight number disagree — carrier `BA` on flight
 * `EK001` — so `BAEK001` is not a callsign that exists. `adsbdb` is keyed on
 * registration, which the catalogue does not carry at all. All three were
 * verified against the live APIs on 2026-10-04; the reasoning is recorded in
 * `docs/supply-sources.md` so it is not re-derived.
 *
 * What the catalogue *does* carry is geography: all 34 `FLIGHT` products have
 * populated `latitude` / `longitude`. That is a real join key, and the existing
 * `RealtimeFlightFinder.near()` already answers against it.
 *
 * What this deliberately does not do
 * -----------------------------------
 * It does not claim a live aircraft belongs to a seeded product. "Air traffic
 * near London Heathrow" is a true, useful, clearly-labelled fact. "This is your
 * EK001" is not knowable from public ADS-B plus a synthetic catalogue, and
 * asserting it would be a lie told in the booking funnel.
 */

const CACHE_TTL_SECONDS = 60;

/**
 * What the cache stores, as opposed to what the caller receives.
 *
 * `null` cannot be used to record a verified-empty answer: `cacheSet` writes
 * `JSON.stringify(null)` and `cacheGet` parses it straight back to `null`, which
 * is indistinguishable from a cache miss — so a quiet airport would re-walk the
 * source chain on every product view, and the fallback source's anonymous quota
 * is scarce. This wrapper makes the two states separable.
 */
type CachedContent = { content: LiveContent } | { empty: true };

const CACHED_EMPTY: CachedContent = { empty: true };

/**
 * Default radius, in nautical miles.
 *
 * Wide enough that a product anchored at a city returns *something* on any day,
 * narrow enough that the aircraft is plausibly related to the destination rather
 * than being scattered traffic from a neighbouring country.
 */
const DEFAULT_RADIUS_NM = 25;

export interface LiveContent {
  /** Positions near the product, if any are broadcast right now. */
  flights: LiveFlight[];
  /** Human-readable summary for the UI; `null` when nothing is nearby. */
  summary: string | null;
  /**
   * Always `true`. The UI must render this as ambient context, never as a
   * claim about the booked product — see the module comment.
   */
  advisory: true;
  fetchedAt: number;
  fromCache: boolean;
}

/**
 * Live air traffic near a product's own coordinates.
 *
 * Returns `null` for a product without usable coordinates rather than throwing:
 * a cruise on the open sea or a hotel pinned to nothing has no meaningful
 * centre, and "no answer" is a legitimate result the caller renders as nothing.
 */
export async function liveAirTrafficNear(
  slug: string,
  options: { radiusNm?: number; type?: ProductType } = {},
): Promise<LiveContent | null> {
  const product = await prisma.product.findUnique({
    where: { slug },
    select: { id: true, slug: true, latitude: true, longitude: true, type: true },
  });

  if (!product) return null;
  // Only flights carry an origin to fly from. A hotel's "live air traffic" is
  // noise — the airport it is near already has its own product.
  if (options.type && options.type !== ProductType.FLIGHT) return null;
  if (product.type !== ProductType.FLIGHT) return null;
  if (product.latitude === null || product.longitude === null) return null;

  const radiusNm = options.radiusNm ?? DEFAULT_RADIUS_NM;
  const key = `live:content:air:${product.slug}:${product.latitude.toFixed(2)}:${product.longitude.toFixed(2)}:${radiusNm}`;

  const cached = await cacheGet<CachedContent>(key);
  // A cached negative result short-circuits to `null` rather than falling
  // through to the fetch, which is the whole reason the wrapper exists.
  if (cached) {
    return 'empty' in cached ? null : { ...cached.content, fromCache: true };
  }

  let flights: LiveFlight[];
  try {
    flights = await realtimeFlights.near(product.latitude, product.longitude, radiusNm);
  } catch (error) {
    // An upstream outage must not break a product page. Returning `null` drops
    // the panel; throwing would take the whole detail response with it.
    logger.warn('live.content_air_failed', {
      slug: product.slug,
      reason: (error as Error).message,
    });
    return null;
  }

  const airborne = flights.filter((flight) => !flight.onGround && flight.callsign !== '');

  // Ground traffic is not a selling point. Between roughly 22:00 and 06:00 UTC
  // the only aircraft near a European airport are parked ones: a verified
  // Amsterdam probe at 22:39 returned 7 aircraft, all `onGround`, zero in the
  // air. Surfacing that as "air traffic near your flight" would fill the panel
  // with rows the UI then filters away, and state a summary ("7 aircraft on the
  // ground") that reads as filler. So an all-ground result reports nothing at
  // all — the caller renders no panel, which is the honest outcome.
  if (airborne.length === 0) {
    await cacheSet(key, CACHED_EMPTY, CACHE_TTL_SECONDS);
    return null;
  }

  const content: LiveContent = {
    flights: airborne.slice(0, 12),
    summary: `${airborne.length} aircraft on approach nearby`,
    advisory: true,
    fetchedAt: Date.now(),
    fromCache: false,
  };

  await cacheSet(key, { content } as CachedContent, CACHE_TTL_SECONDS);
  return content;
}