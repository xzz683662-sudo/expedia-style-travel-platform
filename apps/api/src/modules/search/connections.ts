/**
 * Connection and stopover search over `FlightSegment`.
 *
 * Why this is a table query and not a filter on `ProductFlight.segments`
 * ------------------------------------------------------------------------
 * "Which flights connect through HKG?" means matching an airport that is the
 * *neither the origin nor the destination of the product. "Which itineraries
 * give me a 3-hour layover at LHR?" means subtracting one arrival from the
 * next departure. Both need to compare across legs, which a Json blob cannot
 * index — every candidate product would be parsed in Postgres before it could
 * be rejected. `FlightSegment` carries `departureAirport`, `arrivalAirport` and
 * both timestamps as columns precisely so these become ordinary `WHERE`
 * clauses.
 *
 * Every function here degrades to an empty result rather than throwing when
 * there is no usable schedule. The seeds populate airports and carriers but
 * frequently leave times null, and "no layover information" must not read as
 * "no connecting flights".
 */

import { prisma } from '../../lib/prisma';

/** One flight product and the itinerary legs that make up its journey. */
export interface ConnectionItinerary {
  productId: string;
  /** Legs in travel order, ascending by `seq`. */
  legs: ConnectionLeg[];
  /** Layover minutes between consecutive legs. `null` where it cannot be known. */
  layoversMinutes: (number | null)[];
}

export interface ConnectionLeg {
  seq: number;
  marketingCarrier: string;
  marketingCarrierCode: string | null;
  flightNumber: string | null;
  aircraft: string | null;
  departureAirport: string;
  /**
   * Terminal and actual times are null until a live feed supplies them. They are
   * carried anyway: a leg that knows its gate is worth showing, and a caller
   * that renders them must handle absence rather than be handed a schema
   * without the field at all.
   */
  departureTerminal: string | null;
  departureScheduledAt: Date | null;
  departureActualAt: Date | null;
  arrivalAirport: string;
  arrivalTerminal: string | null;
  arrivalScheduledAt: Date | null;
  arrivalActualAt: Date | null;
  durationMinutes: number | null;
  cabinCode: string | null;
  /** Fare/booking codes are supplier-supplied; null on demo inventory. */
  bookingClass: string | null;
  fareFamily: string | null;
}

/** Filters for {@link findFlightsConnectingThrough}. */
export interface ConnectionQuery {
  /**
   * Airport the itinerary must pass through, in any position. Matched
   * case-insensitively against both endpoints of every leg, so a one-leg
   * flight whose origin *is* the airport counts — a traveller departing LHR
   * has, trivially, passed through it.
   */
  airport: string;
  /**
   * Require a genuine intermediate stop: the airport must be reached by one
   * leg and left by a later one. Defaults to false, which keeps "flights to
   * HKG" from being the answer to "flights through HKG".
   */
  requireChange?: boolean;
  /** Cap on total itinerary duration, in minutes. Skipped when unset. */
  maxDurationMinutes?: number;
  /** Cap on the shortest layover, in minutes. Skipped when unset. */
  minLayoverMinutes?: number;
  /** Cap on the longest layover, in minutes. Skipped when unset. */
  maxLayoverMinutes?: number;
  limit?: number;
}

const MAX_LIMIT = 50;
const DEFAULT_LIMIT = 20;

function normaliseAirport(value: string): string {
  return value.trim().toUpperCase();
}

/**
 * Flights whose itinerary touches `airport`.
 *
 * The airport test runs in SQL so the index on `departureAirport` and
 * `arrivalAirport` does the work; itinerary assembly and layover maths happen
 * afterwards on the handful of products that survived.
 */
export async function findFlightsConnectingThrough(query: ConnectionQuery): Promise<ConnectionItinerary[]> {
  const airport = normaliseAirport(query.airport);
  if (!airport) return [];

  const productIds = await prisma.flightSegment.findMany({
    where: {
      OR: [{ departureAirport: airport }, { arrivalAirport: airport }],
    },
    select: { productId: true },
    distinct: ['productId'],
    take: MAX_LIMIT * 5,
  });

  if (productIds.length === 0) return [];

  const rows = await prisma.flightSegment.findMany({
    where: { productId: { in: productIds.map((row) => row.productId) } },
    orderBy: [{ productId: 'asc' }, { seq: 'asc' }],
    select: {
      productId: true,
      seq: true,
      marketingCarrier: true,
      marketingCarrierCode: true,
      flightNumber: true,
      aircraft: true,
      departureAirport: true,
      departureTerminal: true,
      departureScheduledAt: true,
      departureActualAt: true,
      arrivalAirport: true,
      arrivalTerminal: true,
      arrivalScheduledAt: true,
      arrivalActualAt: true,
      durationMinutes: true,
      cabinCode: true,
      bookingClass: true,
      fareFamily: true,
    },
  });

  // The leg type stays a flat segment shape; productId is carried by the map
  // key rather than threaded through every row.
  const byProduct = new Map<string, ConnectionLeg[]>();
  const productIdByLegs = new Map<ConnectionLeg[], string>();
  for (const row of rows) {
    const legs = byProduct.get(row.productId) ?? [];
    const isNewGroup = legs.length === 0;
    legs.push({
      seq: row.seq,
      marketingCarrier: row.marketingCarrier,
      marketingCarrierCode: row.marketingCarrierCode,
      flightNumber: row.flightNumber,
      aircraft: row.aircraft,
      departureAirport: row.departureAirport,
      departureTerminal: row.departureTerminal,
      departureScheduledAt: row.departureScheduledAt,
      departureActualAt: row.departureActualAt,
      arrivalAirport: row.arrivalAirport,
      arrivalTerminal: row.arrivalTerminal,
      arrivalScheduledAt: row.arrivalScheduledAt,
      arrivalActualAt: row.arrivalActualAt,
      durationMinutes: row.durationMinutes,
      cabinCode: row.cabinCode,
      bookingClass: row.bookingClass,
      fareFamily: row.fareFamily,
    });
    if (isNewGroup) productIdByLegs.set(legs, row.productId);
    byProduct.set(row.productId, legs);
  }

  const results: ConnectionItinerary[] = [];
  for (const legs of byProduct.values()) {
    if (query.requireChange && !hasIntermediateStop(legs, airport)) continue;
    const layoversMinutes = layoversBetween(legs);
    if (!withinLayoverBounds(layoversMinutes, query)) continue;
    if (query.maxDurationMinutes !== undefined && !withinTotalDuration(legs, query.maxDurationMinutes)) {
      continue;
    }
    results.push({ productId: productIdByLegs.get(legs)!, legs, layoversMinutes });
  }

  const limit = Math.min(Math.max(query.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
  return results.slice(0, limit);
}

/**
 * True when the airport is both reached and then left.
 *
 * Requires two distinct legs on either side, so a flight that merely departs
 * from the airport does not qualify as a connection through it.
 */
function hasIntermediateStop(legs: ConnectionLeg[], airport: string): boolean {
  const arrivesAt = legs.filter((leg) => leg.arrivalAirport === airport);
  const leavesFrom = legs.filter((leg) => leg.departureAirport === airport);
  if (arrivesAt.length === 0 || leavesFrom.length === 0) return false;
  const lastArrival = Math.max(...arrivesAt.map((leg) => leg.seq));
  const firstDeparture = Math.min(...leavesFrom.map((leg) => leg.seq));
  return firstDeparture > lastArrival;
}

/**
 * Minutes between consecutive legs, or null where a gap cannot be computed
 * because one of the two timestamps is missing.
 */
function layoversBetween(legs: ConnectionLeg[]): (number | null)[] {
  const gaps: (number | null)[] = [];
  for (let i = 0; i + 1 < legs.length; i += 1) {
    const arrival = legs[i].arrivalScheduledAt;
    const departure = legs[i + 1].departureScheduledAt;
    gaps.push(arrival && departure ? Math.round((departure.getTime() - arrival.getTime()) / 60_000) : null);
  }
  return gaps;
}

/**
 * Check the layover bounds against the gaps that are actually known.
 *
 * A gap of null is skipped rather than treated as zero or as infinite. When no
 * gap is known at all the filter cannot discriminate, so it passes — otherwise
 * a filter the data cannot answer would silently hide every result.
 */
function withinLayoverBounds(gaps: (number | null)[], query: ConnectionQuery): boolean {
  const known = gaps.filter((gap): gap is number => gap !== null);
  if (known.length === 0) return true;
  if (query.minLayoverMinutes !== undefined && !known.some((gap) => gap >= query.minLayoverMinutes!)) {
    return false;
  }
  if (query.maxLayoverMinutes !== undefined && !known.some((gap) => gap <= query.maxLayoverMinutes!)) {
    return false;
  }
  return true;
}

/**
 * Sum the legs plus the layovers, or null when any piece is unknown. A missing
 * timestamp means the journey length is genuinely unknown, and reporting the
 * legs alone would understate it.
 */
function totalDurationMinutes(legs: ConnectionLeg[]): number | null {
  let total = 0;
  for (let i = 0; i < legs.length; i += 1) {
    const leg = legs[i];
    if (leg.durationMinutes === null) return null;
    total += leg.durationMinutes;
    if (i + 1 < legs.length) {
      const arrival = leg.arrivalScheduledAt;
      const departure = legs[i + 1].departureScheduledAt;
      if (!arrival || !departure) return null;
      total += Math.round((departure.getTime() - arrival.getTime()) / 60_000);
    }
  }
  return total;
}

function withinTotalDuration(legs: ConnectionLeg[], maxMinutes: number): boolean {
  const total = totalDurationMinutes(legs);
  return total === null ? true : total <= maxMinutes;
}

/**
 * Layover durations across every itinerary, for a "connections at X" summary.
 *
 * Returns the airports where a change of aircraft happens, with how many
 * itineraries change there and the median layover. An airport with no known
 * timing is listed with a null median rather than omitted, so the response
 * shape does not depend on how complete the schedule happens to be.
 */
export interface ConnectionPointSummary {
  airport: string;
  itineraries: number;
  medianLayoverMinutes: number | null;
}

export async function summariseConnectionPoints(): Promise<ConnectionPointSummary[]> {
  const rows = await prisma.flightSegment.findMany({
    orderBy: [{ productId: 'asc' }, { seq: 'asc' }],
    select: {
      productId: true,
      seq: true,
      departureAirport: true,
      departureScheduledAt: true,
      arrivalAirport: true,
      arrivalScheduledAt: true,
    },
  });

  const gapsByAirport = new Map<string, number[]>();
  const itinerariesByAirport = new Map<string, Set<string>>();

  for (let i = 0; i + 1 < rows.length; i += 1) {
    const current = rows[i];
    const next = rows[i + 1];
    if (current.productId !== next.productId) continue;

    const airport = current.arrivalAirport;
    const itineraries = itinerariesByAirport.get(airport) ?? new Set<string>();
    itineraries.add(current.productId);
    itinerariesByAirport.set(airport, itineraries);

    if (current.arrivalScheduledAt && next.departureScheduledAt) {
      const minutes = Math.round(
        (next.departureScheduledAt.getTime() - current.arrivalScheduledAt.getTime()) / 60_000,
      );
      if (minutes >= 0) {
        const gaps = gapsByAirport.get(airport) ?? [];
        gaps.push(minutes);
        gapsByAirport.set(airport, gaps);
      }
    }
  }

  return [...itinerariesByAirport.entries()]
    .map(([airport, itineraries]) => {
      const gaps = [...(gapsByAirport.get(airport) ?? [])].sort((a, b) => a - b);
      return {
        airport,
        itineraries: itineraries.size,
        medianLayoverMinutes: gaps.length === 0 ? null : median(gaps),
      };
    })
    .sort((a, b) => b.itineraries - a.itineraries || a.airport.localeCompare(b.airport));
}

function median(sorted: number[]): number {
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? Math.round((sorted[middle - 1] + sorted[middle]) / 2) : sorted[middle];
}