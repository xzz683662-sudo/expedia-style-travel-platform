/**
 * ---------------------------------------------------------------------------
 * Nearest real airport to a city
 * ---------------------------------------------------------------------------
 *
 * The flight seed used to build a route by picking both ends from the same
 * `HUBS` pool, so `origin` and `hub` could land on the same airport and produce
 * `JFK → JFK` — a flight that departs where it arrives. Seven of the 34 flight
 * products were degenerate, and a customer browsing the catalogue could book
 * one.
 *
 * Picking a departure airport by hand does not fix it: any fixed list needs a
 * second list to guarantee the two ends differ, and the two lists drift apart
 * as soon as either is edited. Instead the departure airport is *derived* — the
 * real airport nearest the city the product belongs to, resolved against the
 * OurAirports import (see `docs/supply-sources.md`).
 *
 * That makes the two ends independent by construction: the departure comes from
 * geography, the arrival from `HUBS`, and no city can generate a same-airport
 * route unless `HUBS` happens to contain its own nearest airport. That residue
 * is handled explicitly in `flightProduct` rather than assumed away.
 */

export interface AirportRow {
  iataCode: string;
  name: string;
  latitude: number | null;
  longitude: number | null;
}

/** One resolved airport, as stored on `Destination`. */
export interface NearbyAirport {
  iataCode: string;
  name: string;
  latitude: number;
  longitude: number;
  /** Great-circle distance from the query point, in km. */
  distanceKm: number;
}

/**
 * The closest airport with a usable position.
 *
 * Rows without coordinates are skipped rather than treated as at distance zero
 * — a null that became 0 would place the airport on Null Island and win every
 * comparison.
 *
 * Ties break on the IATA code so the result is deterministic: two airports at
 * the same distance must not swap between runs, or the seeded catalogue would
 * change on every re-seed and the smoke suite would chase a moving target.
 */
export function nearestAirport(
  point: { lat: number; lng: number },
  airports: AirportRow[],
): NearbyAirport | null {
  let best: NearbyAirport | null = null;

  for (const airport of airports) {
    if (airport.latitude === null || airport.longitude === null) continue;

    const distanceKm = haversineKm(point.lat, point.lng, airport.latitude, airport.longitude);

    if (
      best === null ||
      distanceKm < best.distanceKm ||
      // Deterministic tie-break, as above.
      (distanceKm === best.distanceKm && airport.iataCode < best.iataCode)
    ) {
      best = {
        iataCode: airport.iataCode,
        name: airport.name,
        latitude: airport.latitude,
        longitude: airport.longitude,
        distanceKm,
      };
    }
  }

  return best;
}

/**
 * Airports within `radiusKm`, nearest first.
 *
 * Used to pick a departure that is plausible but not always the same one — a
 * city with two airports should not have every one of its flights leave from
 * the identical runway, and picking from a small radius keeps the choice real
 * without inventing a route the city cannot support.
 */
export function airportsWithin(
  point: { lat: number; lng: number },
  airports: AirportRow[],
  radiusKm: number,
  limit = 3,
): NearbyAirport[] {
  return airports
    .filter((a): a is AirportRow & { latitude: number; longitude: number } =>
      a.latitude !== null && a.longitude !== null,
    )
    .map((a) => ({
      iataCode: a.iataCode,
      name: a.name,
      latitude: a.latitude,
      longitude: a.longitude,
      distanceKm: haversineKm(point.lat, point.lng, a.latitude, a.longitude),
    }))
    .filter((a) => a.distanceKm <= radiusKm)
    .sort((a, b) => a.distanceKm - b.distanceKm || a.iataCode.localeCompare(b.iataCode))
    .slice(0, limit);
}

/** Great-circle distance in km. */
export function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}