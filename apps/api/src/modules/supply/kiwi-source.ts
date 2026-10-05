import { config } from '../../config/env';
import { logger } from '../../lib/logger';
import { prisma } from '../../lib/prisma';
import type { LiveAvailability, LiveCategory, LiveOffer, LiveRateQuery, LiveRateSource } from './live';

/**
 * ---------------------------------------------------------------------------
 * Kiwi.com Tequila — FLIGHT and HOTEL_ROOM rates
 * ---------------------------------------------------------------------------
 *
 * Verified against the live upstream on 2026-10-05, not taken from docs:
 *
 *   GET https://tequila-api.kiwi.com/v2/search?fly_from=SFO
 *     -> 403 {"error_code":403,"message":"'apikey' header is required"}
 *
 * That 403 is the good outcome. It proves the endpoint is alive and enforcing a
 * credential, which is the opposite of the 410 that `api.amadeus.com` returns
 * now that its self-service portal has been decommissioned. An endpoint that
 * answers with a structured credential error is one this adapter can actually
 * use the day a key arrives.
 *
 * Scope and honesty about what this does NOT solve
 * -----------------------------------------------
 * Tequila is a *metasearch aggregator*. Its prices are what Kiwi found across
 * the OTA landscape, not inventory this platform holds. Consequences that matter
 * more than the integration itself:
 *
 *   - **Sellability is not bookable inventory.** Tequila reports no allotment.
 *     Every offer here carries `sellable: null` ("the source did not say") and
 *     never `0`. The platform's own `InventoryRecord` remains the only authority
 *     on whether the last seat is gone, which is exactly why this file does not
 *     touch inventory.
 *   - **The price is a cost input, never a retail price.** It reaches
 *     `computeQuote` as `basePriceCents` and is marked up, taxed and fee'd by
 *     the platform like any other. See `modules/pricing`.
 *   - **No confirmation exists.** A Tequila price cannot be turned into a
 *     confirmed booking here, because there is no supplier relationship behind
 *     it. `InventoryHold` still governs what the platform is willing to sell;
 *     this only moves the number the shopper is quoted. That is a genuine
 *     limitation of the approach and is recorded as such in
 *     `docs/supply-sources.md` rather than papered over.
 *
 * Key acquisition is by email magic link at `tequila.kiwi.com` — a partner
 * agreement, not a self-service signup, and it may be refused. Until
 * `KIWI_API_KEY` is set this class returns `[]` for everything, which is the
 * same observable behaviour as having no Kiwi source at all.
 */

/** Tequila returns a deep object; these are the only fields read from it. */
interface KiwiResponse {
  itineraries?: KiwiItinerary[];
  // `hotels` is only populated on hotel endpoints, and even then not always.
  hotels?: KiwiHotel[];
}

interface KiwiItinerary {
  price?: string | number;
  currency?: string;
  /** Kiwi's own seat availability hint, when the itinerary has one. */
  available_seats?: number | null;
  // Booking/sellability signals vary by response shape; treat absent as unknown.
  bookable?: boolean;
  bags_recharge?: boolean;
  route?: unknown[];
}

interface KiwiHotel {
  price?: string | number;
  currency?: string;
  available_rooms?: number | null;
  deep_link?: string;
}

export class KiwiRateSource implements LiveRateSource {
  readonly id = 'kiwi.tequila';
  /**
   * Not a public open-data licence. Tequila is a commercial partner feed with a
   * signed agreement, so the accurate SPDX-ish answer is "see agreement" —
   * which is precisely why this must never be presented as open data.
   */
  readonly license = 'Proprietary (Kiwi partner agreement)';
  readonly categories: readonly LiveCategory[] = ['FLIGHT', 'HOTEL_ROOM'];

  /** No key means "not configured", which the resolver treats as "no data". */
  private get configured(): boolean {
    return config.supply.kiwi.apiKey.length > 0;
  }

  async getRates(query: LiveRateQuery): Promise<LiveOffer[]> {
    if (!this.configured) return [];

    const isFlight = query.category === 'FLIGHT';
    const url = isFlight ? await this.flightUrl(query) : await this.hotelUrl(query);

    // A product that cannot be resolved into an upstream query yields no URL, so
    // there is nothing to fetch. Returning `[]` is correct: it means "this
    // source has no data for this product", not "this source is broken".
    if (!url) return [];

    const payload = await this.request(url, query);
    if (!payload) return [];

    const fetchedAt = Date.now();
    const rows = isFlight ? (payload.itineraries ?? []) : (payload.hotels ?? []);

    // Each response row is already a priced, dated variant, so it maps one-to-one
    // onto an offer. Anything unpriced or non-numeric is dropped here rather
    // than reaching `pickOffer`, which would reject it anyway but only after it
    // had been cached.
    const offers: LiveOffer[] = [];
    for (const row of rows) {
      const cents = toCents(row.price);
      const currency = typeof row.currency === 'string' ? row.currency.toUpperCase() : '';
      if (cents === null || currency === '') continue;

      // `null` (unknown) and never `0`: Tequila reports no allotment, so
      // claiming "sold out" from it would take live products off the shelf.
      const sellable = readSellable(row);
      if (sellable === 0) continue;

      offers.push({
        sourceId: this.id,
        // Namespaced by slug and kind so two rows for one search cannot collide
        // in the batch cache.
        externalId: `${query.slug}:${isFlight ? 'itinerary' : 'room'}:${offers.length}`,
        netPriceCents: cents,
        currency,
        sellable,
        fetchedAt,
      });
    }
    return offers;
  }

  /**
   * Returns `[]` on purpose, and this is not a stub.
   *
   * Tequila publishes no per-date room or seat allotment, so there is nothing
   * truthful to return. Fabricating capacity from a nightly price would make the
   * platform sell seats it never confirmed — the exact failure that
   * `LiveAvailability`'s `null`/`0` distinction exists to prevent. The platform's
   * `InventoryRecord` and `InventoryHold` stay the sole authority on sellability.
   */
  async getAvailability(_query: LiveRateQuery): Promise<LiveAvailability[]> {
    return [];
  }

  /**
   * Builds the search URL from the product's own first and last segment.
   *
   * Two joins are needed, not one. `LiveRateQuery.slug` is `Product.slug` (the
   * public join key defined in `live.ts`), while `FlightSegment.productId`
   * references `Product.id` — a cuid such as `cmuu96v7d001idsuz7uz5a2hu`, not
   * `london-international-flight`. Querying `FlightSegment` with the slug
   * directly returns zero rows for every product, silently, which would look
   * exactly like "this source has no data". The slug is therefore resolved to
   * the id first.
   *
   * `FlightSegment` is then the queryable itinerary copy: `ProductFlight.segments`
   * is the denormalised Json, and its own docs say to read the table instead.
   */
  private async flightUrl(query: LiveRateQuery): Promise<string | null> {
    const product = await prisma.product.findUnique({
      where: { slug: query.slug },
      select: { id: true },
    });
    if (!product) return null;

    const segments = await prisma.flightSegment.findMany({
      where: { productId: product.id },
      orderBy: { seq: 'asc' },
      select: { departureAirport: true, arrivalAirport: true },
    });

    const route = resolveRoute(segments);
    if (!route) return null;

    const url = new URL(`${config.supply.kiwi.baseUrl}/v2/search`);
    url.searchParams.set('fly_from', route.from);
    url.searchParams.set('fly_to', route.to);
    url.searchParams.set('date_from', toTequilaDate(query.serviceDate));
    url.searchParams.set('date_to', toTequilaDate(query.checkOutDate ?? query.serviceDate));
    url.searchParams.set('curr', query.currency);
    url.searchParams.set('adults', String(query.quantity));
    url.searchParams.set('limit', '20');
    url.searchParams.set('sort', 'price');
    return url.toString();
  }

  /**
   * Kiwi addresses hotels by its own city id, which the platform does not store.
   *
   * Rather than guess a mapping and risk querying the wrong city — which would
   * return confidently wrong prices for a different destination — this returns
   * `null` until a real mapping exists. An honest "no data" beats a plausible
   * wrong answer, and it is why hotel rates remain unavailable while
   * `HOTEL_ROOM` stays listed in `categories`.
   */
  private async hotelUrl(_query: LiveRateQuery): Promise<string | null> {
    return null;
  }

  private async request(url: string, query: LiveRateQuery): Promise<KiwiResponse | null> {
    try {
      const response = await fetch(url, {
        headers: { apikey: config.supply.kiwi.apiKey, accept: 'application/json' },
        // Bounded so a slow upstream cannot occupy a request handler past the
        // TTL the resolver is already caching against.
        signal: AbortSignal.timeout(8000),
      });

      if (!response.ok) {
        // 401/403 means the credential is wrong, which is an operator problem
        // and must be visible rather than silently degrading every search.
        logger.warn('live.kiwi_rejected', {
          slug: query.slug,
          status: response.status,
          reason: response.status === 429 ? 'rate limited' : 'credential or upstream error',
        });
        return null;
      }
      return (await response.json()) as KiwiResponse;
    } catch (error) {
      // Network failure, DNS, or timeout. The resolver already treats a thrown
      // source as "try the next one", so logging and returning null keeps this
      // adapter from making a transient blip look like a hard failure.
      logger.warn('live.kiwi_request_failed', {
        slug: query.slug,
        reason: (error as Error).message,
      });
      return null;
    }
  }
}

/**
 * Minor units from an upstream price.
 *
 * `Number('')` is `0` and `Number('1,20')` is `NaN` — both are plausible results
 * of parsing a formatted upstream string, and both would be catastrophic here:
 * `0` would sell at no cost and `NaN` would poison the quote. Anything that is
 * not a finite non-negative integer is rejected outright.
 */
function toCents(value: string | number | undefined): number | null {
  if (value === undefined || value === null) return null;
  const numeric = typeof value === 'number' ? value : Number(value.replace(/[^0-9.]/g, ''));
  if (!Number.isFinite(numeric) || numeric < 0) return null;
  return Math.round(numeric * 100);
}

/** `null` when the upstream did not say. Never fabricated, never inferred from price. */
function readSellable(row: KiwiItinerary | KiwiHotel): number | null {
  // `'x' in row` narrows the union, so each branch reads only its own field.
  if ('available_seats' in row && typeof row.available_seats === 'number') {
    return Number.isFinite(row.available_seats) ? row.available_seats : null;
  }
  if ('available_rooms' in row && typeof row.available_rooms === 'number') {
    return Number.isFinite(row.available_rooms) ? row.available_rooms : null;
  }
  // An explicit `bookable: false` is the one trustworthy negative signal Tequila
  // gives; absent it, silence means unknown rather than sold out.
  if ('bookable' in row && row.bookable === false) return 0;
  return null;
}

/**
 * Origin and destination from the ordered segment list.
 *
 * The first segment's departure and the last segment's arrival, so a multi-leg
 * product queries the whole journey rather than just its first hop — a round
 * trip with its return leg omitted would be priced against a different itinerary
 * than the one sold. A degenerate route (same airport out and back on one hop)
 * returns `null` rather than a nonsense query.
 */
function resolveRoute(
  segments: { departureAirport: string; arrivalAirport: string }[],
): { from: string; to: string } | null {
  if (segments.length === 0) return null;
  const from = segments[0]!.departureAirport.trim().toUpperCase();
  const to = segments[segments.length - 1]!.arrivalAirport.trim().toUpperCase();
  if (from === '' || to === '' || from === to) return null;
  return { from, to };
}

/** Tequila takes `DD/MM/YYYY`; this repo speaks `YYYY-MM-DD` everywhere else. */
function toTequilaDate(value: string): string {
  const [year, month, day] = value.split('-');
  if (!year || !month || !day) return value;
  return `${day}/${month}/${year}`;
}