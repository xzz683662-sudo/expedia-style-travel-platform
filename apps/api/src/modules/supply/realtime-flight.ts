import { cacheGet, cacheSet } from '../../utils/redis';
import { AppError } from '../../utils/errors';

/**
 * ---------------------------------------------------------------------------
 * Real-time flight tracking — live queries, never imports
 * ---------------------------------------------------------------------------
 *
 * A second kind of supply source, deliberately *not* shaped like
 * {@link ./source.ts | SupplySource}: that interface streams rows into the
 * canonical tables, while these adapters answer "where is this aircraft right
 * now" from community ADS-B networks and must never write a row at all.
 *
 * Positions are seconds-fresh and ephemeral. They live in a short Redis cache
 * and nowhere else — no Prisma model, no seed, no provenance table. That keeps
 * the "written but never read" failure mode structurally impossible and keeps
 * licence questions moot: nothing is redistributed or stored, so upstream
 * terms are consumed transiently exactly as their APIs intend.
 *
 * Sources are enumerated and tried in order; the first one that answers wins
 * and its id travels on every response, so provenance is visible at read time
 * without ever being persisted. A source that throws falls through to the
 * next; if *every* source in the chain throws, the finder raises 503 rather
 * than dressing a source outage up as a 404.
 *
 * Freshness and reachability of every source below were verified against the
 * live APIs on 2026-10-04 — see `docs/supply-sources.md` ("Real-time sources").
 */

export interface LiveFlight {
  /** ICAO 24-bit address, lowercase hex, unique per airframe. */
  icao24: string;
  /** Radio callsign, trimmed, e.g. `DAL112`. */
  callsign: string;
  /** Registration / tail number, e.g. `N829NW`, when the source has it. */
  registration: string | null;
  /** Aircraft type code, e.g. `A333`. */
  aircraftType: string | null;
  latitude: number;
  longitude: number;
  /** Barometric altitude in feet; `null` when the source reports none. */
  altitudeFt: number | null;
  /** True when the source reports the airframe on the ground. */
  onGround: boolean;
  /** Ground speed in knots. */
  groundSpeedKt: number | null;
  /** True track in degrees. */
  headingDeg: number | null;
  /** Transponder code, when broadcast. */
  squawk: string | null;
  /** Epoch seconds of the position fix. */
  positionTime: number;
  /** Which adapter answered — provenance travels with the response. */
  source: string;
}

export interface RealtimeFlightSource {
  readonly id: string;
  /** Widest radius (nm) the source accepts for `near`. */
  readonly maxRadiusNm: number;
  /**
   * Whether `byCallsign` actually filters. OpenSky's anonymous `/states/all`
   * *ignores* its `callsign` parameter (verified 2026-10-04: the probe came
   * back with unfiltered global states), so it must not claim this
   * capability — a fallback that returns the wrong aircraft is worse than no
   * fallback.
   */
  readonly supportsCallsign: boolean;
  byCallsign(callsign: string): Promise<LiveFlight | null>;
  near(lat: number, lon: number, radiusNm: number): Promise<LiveFlight[]>;
}

const FETCH_TIMEOUT_MS = 8_000;

async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!response.ok) {
    throw new Error(`${url} responded ${response.status}`);
  }
  return response.json() as Promise<unknown>;
}

/**
 * ---------------------------------------------------------------------------
 * adsb.lol — primary source
 * ---------------------------------------------------------------------------
 *
 * Community ADS-B aggregator, no key, no account. Verified live 2026-10-04:
 * `/v2/callsign/DAL112` and `/v2/point/51.47/-0.45/5` both returned fresh
 * traffic around London. `alt_baro` is feet *or* the string `"ground"`, which
 * is why the normaliser branches on the type rather than trusting the number.
 */
export class AdsbLolSource implements RealtimeFlightSource {
  readonly id = 'adsb-lol';
  readonly maxRadiusNm = 250;
  readonly supportsCallsign = true;

  constructor(private readonly baseUrl = 'https://api.adsb.lol/v2') {}

  async byCallsign(callsign: string): Promise<LiveFlight | null> {
    const payload = (await fetchJson(`${this.baseUrl}/callsign/${encodeURIComponent(callsign)}`)) as {
      ac?: AdsbLolAircraft[];
    };
    const aircraft = payload.ac?.[0];
    return aircraft ? [aircraft].map((row) => this.normalise(row))[0] : null;
  }

  async near(lat: number, lon: number, radiusNm: number): Promise<LiveFlight[]> {
    const payload = (await fetchJson(
      `${this.baseUrl}/point/${lat}/${lon}/${Math.min(radiusNm, this.maxRadiusNm)}`,
    )) as { ac?: AdsbLolAircraft[] };
    return (payload.ac ?? []).map((row) => this.normalise(row));
  }

  private normalise(row: AdsbLolAircraft): LiveFlight {
    const onGround = row.alt_baro === 'ground';
    return {
      icao24: (row.hex ?? '').toLowerCase(),
      callsign: (row.flight ?? '').trim(),
      registration: row.r ?? null,
      aircraftType: row.t ?? null,
      latitude: row.lat,
      longitude: row.lon,
      altitudeFt: onGround || typeof row.alt_baro !== 'number' ? null : row.alt_baro,
      onGround,
      groundSpeedKt: typeof row.gs === 'number' ? row.gs : null,
      headingDeg: typeof row.track === 'number' ? row.track : null,
      squawk: row.squawk ?? null,
      positionTime: Math.round(Date.now() / 1000 - (row.seen_pos ?? 0)),
      source: this.id,
    };
  }
}

/** Upstream record shape, limited to the fields this module reads. */
interface AdsbLolAircraft {
  hex?: string;
  flight?: string;
  r?: string;
  t?: string;
  alt_baro?: number | 'ground';
  gs?: number;
  track?: number;
  squawk?: string;
  lat?: number;
  lon?: number;
  seen_pos?: number;
}

/**
 * ---------------------------------------------------------------------------
 * OpenSky Network — fallback for radius queries
 * ---------------------------------------------------------------------------
 *
 * Anonymous access is rate-limited (a few hundred credits a day), which is
 * exactly why it is the *fallback*: it is only hit when adsb.lol fails, and
 * the finder's cache keeps either source from being hammered. Verified live
 * 2026-10-04 with a bounding box around London.
 *
 * State vectors arrive as positional arrays in the documented order — the
 * tuple destructure below *is* the field mapping, so it is written out rather
 * than hidden behind index arithmetic.
 */
export class OpenSkySource implements RealtimeFlightSource {
  readonly id = 'opensky-network';
  readonly maxRadiusNm = 250;
  readonly supportsCallsign = false;

  constructor(private readonly baseUrl = 'https://opensky-network.org/api') {}

  async byCallsign(): Promise<LiveFlight | null> {
    // Anonymous /states/all cannot filter by callsign (see `supportsCallsign`).
    return null;
  }

  async near(lat: number, lon: number, radiusNm: number): Promise<LiveFlight[]> {
    const radiusKm = Math.min(radiusNm, this.maxRadiusNm) * 1.852;
    const latDelta = radiusKm / 111.32;
    const lngDelta = radiusKm / (111.32 * Math.max(0.01, Math.cos((lat * Math.PI) / 180)));
    const payload = (await fetchJson(
      `${this.baseUrl}/states/all` +
        `?lamin=${(lat - latDelta).toFixed(4)}&lomin=${(lon - lngDelta).toFixed(4)}` +
        `&lamax=${(lat + latDelta).toFixed(4)}&lomax=${(lon + lngDelta).toFixed(4)}`,
    )) as { states?: OpenSkyState[] | null };

    // OpenSky answers a bounding *square*; the contract is a circle, so the
    // great-circle filter here is what actually enforces the radius.
    return (payload.states ?? [])
      .map((state) => this.normalise(state))
      .filter((flight) => flight !== null)
      .filter((flight) => haversineNm(lat, lon, flight.latitude, flight.longitude) <= radiusNm);
  }

  private normalise(state: OpenSkyState): LiveFlight | null {
    const [icao24, callsign, , timePosition, lastContact, longitude, latitude, baroAltitude, onGround, velocity, trueTrack, , , , squawk] =
      state;
    if (typeof latitude !== 'number' || typeof longitude !== 'number') return null;
    return {
      icao24: icao24.toLowerCase(),
      callsign: (callsign ?? '').trim(),
      registration: null, // OpenSky state vectors carry no tail number.
      aircraftType: null,
      latitude,
      longitude,
      altitudeFt: typeof baroAltitude === 'number' ? Math.round(baroAltitude * 3.28084) : null,
      onGround: onGround === true,
      groundSpeedKt: typeof velocity === 'number' ? Math.round(velocity * 1.94384) : null,
      headingDeg: typeof trueTrack === 'number' ? trueTrack : null,
      squawk: typeof squawk === 'string' ? squawk : null,
      positionTime: timePosition ?? lastContact,
      source: this.id,
    };
  }
}

/** Upstream state-vector tuple, in the documented positional order. */
type OpenSkyState = [
  string, // icao24
  string | null, // callsign
  string, // origin country
  number | null, // time_position
  number, // last_contact
  number | null, // longitude
  number | null, // latitude
  number | null, // baro_altitude (m)
  boolean, // on_ground
  number | null, // velocity (m/s)
  number | null, // true_track
  number | null, // vertical_rate
  number[] | null, // sensors
  number | null, // geo_altitude
  string | null, // squawk
  boolean, // spi
  number, // position source
];

/**
 * ---------------------------------------------------------------------------
 * Finder — the enumerated chain
 * ---------------------------------------------------------------------------
 */

const CACHE_TTL_SECONDS = 30;
const CACHE_PREFIX = 'rt:flight';

export class RealtimeFlightFinder {
  constructor(private readonly sources: RealtimeFlightSource[]) {}

  async byCallsign(callsign: string): Promise<LiveFlight | null> {
    const key = `${CACHE_PREFIX}:cs:${callsign}`;
    const cached = await cacheGet<LiveFlight>(key);
    if (cached) return cached;

    const chain = this.sources.filter((source) => source.supportsCallsign);
    const errors: unknown[] = [];
    for (const source of chain) {
      try {
        const flight = await source.byCallsign(callsign);
        if (flight) {
          await cacheSet(key, flight, CACHE_TTL_SECONDS);
          return flight;
        }
      } catch (error) {
        errors.push(error); // Source down or rate-limited — try the next one.
      }
    }
    if (errors.length === chain.length && chain.length > 0) {
      throw new AppError(503, 'INTERNAL', 'No realtime flight source is reachable right now');
    }
    return null;
  }

  async near(lat: number, lon: number, radiusNm: number): Promise<LiveFlight[]> {
    const key = `${CACHE_PREFIX}:near:${lat.toFixed(2)}:${lon.toFixed(2)}:${radiusNm}`;
    const cached = await cacheGet<LiveFlight[]>(key);
    if (cached) return cached;

    const errors: unknown[] = [];
    for (const source of this.sources) {
      try {
        const flights = await source.near(lat, lon, radiusNm);
        if (flights.length > 0) {
          await cacheSet(key, flights, CACHE_TTL_SECONDS);
          return flights;
        }
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length === this.sources.length && this.sources.length > 0) {
      throw new AppError(503, 'INTERNAL', 'No realtime flight source is reachable right now');
    }
    return [];
  }
}

/** Great-circle distance in nautical miles, for enforcing the radius contract. */
function haversineNm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 3440.065 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Chain order is the fallback order: adsb.lol first (no key, generous limits),
 * OpenSky second (anonymous quota is scarce). Adding a source means adding one
 * class and one entry here — and verifying it live first, per
 * `docs/supply-sources.md`.
 */
export const realtimeFlights = new RealtimeFlightFinder([new AdsbLolSource(), new OpenSkySource()]);
