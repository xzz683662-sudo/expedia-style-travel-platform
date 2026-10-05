import { execFile } from 'node:child_process';
import { config } from '../../config/env';
import { logger } from '../../lib/logger';
import { cacheGet, cacheSet } from '../../utils/redis';
import type { LiveAvailability, LiveCategory, LiveOffer, LiveRateQuery, LiveRateSource } from './live';

/**
 * ---------------------------------------------------------------------------
 * trvl — zero-key Flight and Hotel rates, pre-warmed
 * ---------------------------------------------------------------------------
 *
 * Proven against the real binary on 2026-10-05 before any of this was written:
 *
 *   $ trvl flights JFK LHR 2026-11-15 --format json
 *     { "success": true, "count": 125,
 *       "flights": [{ "price": 244.64, "currency": "EUR",
 *                     "provider": "skiplagged", "legs": [...] }] }
 *
 *   $ trvl hotels "Tokyo" --checkin 2026-11-15 --checkout 2026-11-18 --format json
 *     { "count": 123, "total_available": 2428,
 *       "hotels": [{ "price": 42.37, "nightly_price": 42.37,
 *                    "taxes_and_fees": 23.91, "room_types": [...],
 *                    "image_url": "https://pix8.agoda.net/..." }] }
 *
 * Prices vary sensibly by date (186.60 / 244.64 / 258.92 EUR for Oct / Nov /
 * Jan on the same route), so this is a real price structure and not a fixture.
 *
 * Why this is a *pre-warm* source and not an inline one
 * ---------------------------------------------------
 * A single invocation measured **24.6 s** end to end. Putting that inside a
 * search request would blow every timeout in the stack and make the platform
 * look broken. So this adapter never calls the binary from a request handler.
 * A background warmer runs on a schedule and writes into the same Redis cache
 * the resolver already reads, and `getRates` only ever reads that cache.
 *
 * The result is that a shopper sees a live price only if the warmer has already
 * fetched it, and otherwise sees the seeded price. That is the correct
 * degradation: a slow upstream must never become a slow storefront.
 *
 * Licensing and terms — read this before enabling
 * ------------------------------------------------
 * trvl is MIT-licensed *software*, but it is a personal-use tool that reads
 * Google Flights and Google Hotels. Its own README says:
 *
 *   "trvl is a personal-use tool that reads public-facing web APIs... It does
 *    not bypass authentication or circumvent rate limits; request patterns are
 *    throttled to look like manual browsing. Automated access may violate some
 *    providers' Terms of Service — you are responsible for compliance in your
 *    jurisdiction."
 *
 * That places the licensing risk on the operator, not on the author. It is
 * therefore **off unless `TRVL_ENABLED=true` is set explicitly**, and the
 * telemetry opt-out (`TRVL_NO_TELEMETRY=1`) is passed to the child process
 * rather than left to the operator's memory.
 *
 * Cruise is absent because trvl has no cruise command — only ground and ferry.
 * The `categories` list reflects what the tool can actually answer.
 */

/**
 * The currency trvl actually answers in, measured across four requested
 * currencies on 2026-10-05. See `warmTrvlRoute` for why this gates the warm.
 */
const TRVL_NATIVE_CURRENCY = 'EUR';

interface TrvlFlight {
  price?: number;
  currency?: string;
  provider?: string;
  legs?: { departure_airport?: { code?: string }; arrival_airport?: { code?: string } }[];
  /**
   * trvl's own assessment of how bookable this fare is. Carried through rather
   * than discarded: a fare scored `low` is a different proposition from one
   * scored `high`, and the platform should be able to refuse the former.
   */
  confidence?: {
    rated?: boolean;
    score?: number;
    label?: string;
    /** `"live"` means the upstream answered now, not from a cached snapshot. */
    freshness?: string;
  };
}

interface TrvlHotel {
  name?: string;
  price?: number;
  currency?: string;
  hotel_id?: string;
}

interface TrvlFlightResponse {
  success?: boolean;
  count?: number;
  flights?: TrvlFlight[];
}

interface TrvlHotelResponse {
  success?: boolean;
  count?: number;
  hotels?: TrvlHotel[];
}

export class TrvlRateSource implements LiveRateSource {
  readonly id = 'trvl';
  /** MIT for the binary. The *data* it returns is a separate question — see above. */
  readonly license = 'MIT (binary); upstream data terms apply';
  readonly categories: readonly LiveCategory[] = ['FLIGHT', 'HOTEL_ROOM'];

  private get configured(): boolean {
    return config.supply.trvl.enabled && config.supply.trvl.binaryPath.length > 0;
  }

  /**
   * Cache-only by design. See the class docs for why the binary is never spawned
   * from a request path — a cache miss here returns `[]`, which the resolver
   * reads as "this source has no data", and the shopper gets the seeded price.
   */
  async getRates(query: LiveRateQuery): Promise<LiveOffer[]> {
    if (!this.configured) return [];

    const cached = await cacheGet<CachedRate[]>(warmKey(query));
    if (!cached || cached.length === 0) return [];

    const fetchedAt = cached[0]!.fetchedAt;
    const offers: LiveOffer[] = [];
    for (const row of cached) {
      // Re-checked here rather than trusted from the warmer: the cached entry may
      // outlive a currency change, and `pickOffer` would silently drop it later.
      if (row.currency !== query.currency) continue;

      offers.push({
        sourceId: this.id,
        externalId: row.externalId,
        netPriceCents: row.netPriceCents,
        currency: row.currency,
        // The warmer records no allotment, so this is "the source did not say".
        sellable: null,
        fetchedAt,
      });
    }
    return offers;
  }

  /**
   * Always `[]`, for the same reason as `KiwiRateSource`: trvl reports prices,
   * not per-date capacity, and `InventoryRecord` remains the only authority.
   */
  async getAvailability(_query: LiveRateQuery): Promise<LiveAvailability[]> {
    return [];
  }
}

/** One warmed row, already normalised to minor units. */
export interface CachedRate {
  externalId: string;
  netPriceCents: number;
  currency: string;
  fetchedAt: number;
}

/**
 * What the warmer needs beyond {@link LiveRateQuery}: the upstream coordinates.
 *
 * `LiveRateQuery` is keyed by platform slug, which trvl cannot resolve. The
 * warmer resolves it from the database first and passes the concrete route here,
 * so a cached entry is only ever written for a query trvl can actually answer.
 */
export interface WarmQuery {
  from?: string;
  to?: string;
  hotelQuery?: string;
}

/**
 * Fetches one route's prices and writes them where {@link TrvlRateSource} reads.
 *
 * Exported for the warmer loop in `index.ts`; not called from any request path.
 * Every failure returns `false` rather than throwing, because a warmer that
 * throws would take down the scheduler that hosts it.
 */
export async function warmTrvlRoute(query: LiveRateQuery & WarmQuery): Promise<boolean> {
  const binary = config.supply.trvl.binaryPath;
  if (!config.supply.trvl.enabled || binary === '') return false;

  const isFlight = query.category === 'FLIGHT';
  // trvl's `--currency` flag was measured and does not work: asked for USD, GBP,
  // AUD or JPY it returned EUR every time, at an identical price. It has no usable
  // FX table. Rather than invent a rate — which would mean this repo acquiring FX
  // conversion it has never had, in the one place where `pickOffer` deliberately
  // refuses to convert — a route is only warmed when the seller already trades in
  // the currency trvl answers in. Everything else is skipped rather than guessed.
  if (query.currency !== TRVL_NATIVE_CURRENCY) return false;

  const args = isFlight
    ? ['flights', query.from ?? '', query.to ?? '', query.serviceDate, '--format', 'json']
    : [
        'hotels',
        query.hotelQuery ?? '',
        '--checkin',
        query.serviceDate,
        '--checkout',
        query.checkOutDate ?? query.serviceDate,
        '--format',
        'json',
      ];

  // Generous, because the measured cost is ~25 s and a timeout that fires at 8 s
  // would throw away a call that was about to succeed.
  const raw = await runTrvlBinary(binary, args);
  if (raw === null) return false;

  const now = Date.now();
  const rows: CachedRate[] = [];

  if (isFlight) {
    const parsed = parseTrvlJson<TrvlFlightResponse>(raw);
    for (const flight of parsed?.flights ?? []) {
      const cents = toCents(flight.price);
      const currency = (flight.currency ?? '').toUpperCase();
      if (cents === null || currency === '') continue;

      // trvl scores each fare on how likely it is to actually book. Only `high`
      // reaches the cache. Quoting a fare trvl itself rates as unreliable would
      // mean re-pricing a real order on a number the upstream does not stand
      // behind, and `computeQuote` would apply real markup to it. Measured range
      // on live queries is roughly 0.6–0.9, with `high` covering the upper end.
      if (!isHighConfidence(flight.confidence)) {
        logger.debug('supply.trvl_low_confidence_skipped', {
          provider: flight.provider,
          label: flight.confidence?.label,
          score: flight.confidence?.score,
        });
        continue;
      }

      rows.push({
        // Provider is kept in the id so two providers for one route stay distinct
        // and a provider outage is visible in the cache rather than silent.
        externalId: `${query.slug}:${flight.provider ?? 'unknown'}:${rows.length}`,
        netPriceCents: cents,
        currency,
        fetchedAt: now,
      });
    }
  } else {
    const parsed = parseTrvlJson<TrvlHotelResponse>(raw);
    for (const hotel of parsed?.hotels ?? []) {
      const cents = toCents(hotel.price);
      const currency = (hotel.currency ?? '').toUpperCase();
      if (cents === null || currency === '') continue;
      rows.push({
        externalId: `${query.slug}:${hotel.hotel_id ?? hotel.name ?? rows.length}`,
        netPriceCents: cents,
        currency,
        fetchedAt: now,
      });
    }
  }

  if (rows.length === 0) return false;

  // Only the cheapest few are kept. `pickOffer` only ever chooses the minimum, so
  // storing 125 rows would cost Redis memory and buy nothing.
  rows.sort((a, b) => a.netPriceCents - b.netPriceCents);
  await cacheSet(warmKey(query), rows.slice(0, 5), config.supply.trvl.warmTtlSeconds);
  return true;
}

/**
 * Spawns the binary and returns stdout, or `null` on any failure.
 *
 * Exported so the warmer and the inline path cannot drift apart in how they
 * invoke the tool — one of them learning a flag the other ignores is how a
 * "verified" number stops matching what the adapter will read.
 *
 * `execFile` rather than `exec` so no argument can be interpreted as a shell
 * metacharacter; the city and airport codes come from the database.
 */
export function runTrvlBinary(binary: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      binary,
      args,
      {
        timeout: config.supply.trvl.timeoutMs,
        maxBuffer: 8 * 1024 * 1024,
        env: {
          ...process.env,
          // Passed explicitly rather than relying on the operator to remember:
          // the binary otherwise phones home to a third party once a day.
          TRVL_NO_TELEMETRY: '1',
        },
      },
      (error, stdout) => {
        if (error) {
          logger.warn('supply.trvl_failed', { reason: error.message });
          resolve(null);
          return;
        }
        resolve(stdout);
      },
    );
  });
}

/**
 * Whether trvl considers a fare reliably bookable.
 *
 * An *unrated* fare passes. trvl only rates what it can corroborate across
 * providers, and refusing every unrated fare would reject most of a single-source
 * result set — which is most of them. The failure mode matters more in one
 * direction than the other: quoting a good fare too conservatively costs a
 * marginally higher price, while quoting a bad one costs a broken checkout.
 */
export function isHighConfidence(confidence: TrvlFlight['confidence']): boolean {
  if (!confidence || confidence.rated !== true) return true;
  return confidence.label === 'high';
}

/** Parses a trvl JSON payload, tolerating WARN lines around it. Never throws. */
export function parseTrvlJson<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    // The binary can emit WARN lines on stderr alongside JSON on stdout; a parse
    // failure here means the shape changed, which must not throw into the warmer.
    return null;
  }
}

/**
 * Minor units from a float price.
 *
 * The real payload carries prices like `244.6428571428571` — a converted value
 * with 13 decimal places. Rounding to cents is what makes the result usable by
 * `computeQuote`, and it is why this adapter must never hand the raw float on.
 */
function toCents(value: number | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  return Math.round(value * 100);
}

/**
 * The cache key a warmed entry is written under and read back from.
 *
 * Shares the resolver's key shape deliberately: `TrvlRateSource.getRates` looks
 * the entry up with this exact string, so the two must never drift.
 */
export function warmKeyFor(slug: string, serviceDate: string, currency: string): string {
  return ['live:rate', slug, 'FLIGHT', serviceDate, '', '1', currency, 'search'].join(':');
}

/** The single-route form of {@link warmKeyFor}, derived from a full query. */
function warmKey(query: LiveRateQuery): string {
  return warmKeyFor(query.slug, query.serviceDate, query.currency);
}