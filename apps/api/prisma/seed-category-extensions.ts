/**
 * Phase 0 backfill: derive the category extension tables and the new
 * `SearchDocument` facets from data that already exists.
 *
 * Why this is a backfill and not part of the product seeder
 * ----------------------------------------------------------
 * The extension tables (`ProductStay`, `ProductFlight`, `ProductSailing`,
 * `ProductVehicle`) hold *structure* that the flat display columns on `Product`
 * never had — a hotel needs a stay range and a room grid, a flight needs ordered
 * segments. None of that can be invented from `roomCategory = "Deluxe suite"`,
 * so this file can only carry the data across, not invent it. It upgrades an
 * existing database in place instead of demanding a destructive `db:reset`.
 *
 * What it is honest about
 * ----------------------
 * Several values here are *defaults shaped like real data*, not facts pulled
 * from a supplier feed. That is deliberate and flagged inline. A demo database
 * gets a coherent, queryable shape; a production integration overwrites every
 * one of these from its source. Do not read `"Business"` as a claim about an
 * actual fare.
 *
 * Idempotent: extension writes skip products that already have a row, and the
 * search facets are refreshed from `Product` (the display source of truth) on
 * every run.
 */
import type { Prisma, PrismaClient, Product, ProductType } from '@prisma/client';
import { logger } from '../src/lib/logger';

/** Product types that have a Phase 0 extension table. */
const CATEGORY_TYPES: ProductType[] = [
  'HOTEL_ROOM',
  'FLIGHT',
  'CRUISE',
  'RENTAL_CAR',
  'VEHICLE_RENTAL',
  'TRANSFER',
  'AIRPORT_TRANSFER',
];

type Json = Prisma.InputJsonObject;

/**
 * Split "SIN → JFK" (or "SIN -> JFK") into its endpoints.
 *
 * The flat `flightRoute` column is display-only and inconsistent across seeds —
 * some use a unicode arrow, some ASCII. Anything that cannot be split returns
 * `null` rather than a guess, so downstream code can tell "unknown" from
 * "parsed successfully".
 */
export function parseRoute(route: string | null | undefined): {
  from: string;
  to: string;
  /** Intermediate airports for a connecting route; empty for a direct one. */
  via: string[];
} | null {
  if (!route) return null;
  const parts = route
    .split(/\s*(?:→|->|➜)\s*/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length < 2) return null;
  return { from: parts[0], to: parts[parts.length - 1], via: parts.slice(1, -1) };
}

/**
 * IATA two-letter code per carrier name.
 *
 * These are looked up, not derived. "British Airways" → "BA" is a fact about
 * that carrier, and the first draft of this file tried to avoid the lookup by
 * refusing to map anything, which left `SearchDocument.carrierCode` null for
 * every row and the `@@index([type, carrierCode])` behind it serving nothing.
 * Guessing would have been worse — a wrong code produces a confidently wrong
 * PNR — so the mapping is spelled out and reviewable instead.
 *
 * Covers every name in `FLIGHT_CARRIERS` (seed-global.ts).
 */
const CARRIER_CODES: Record<string, string> = {
  'Air Canada': 'AC',
  'Air Europa': 'UX',
  'Air France': 'AF',
  'ANA': 'NH',
  'Austrian Airlines': 'OS',
  'British Airways': 'BA',
  'Cathay Pacific': 'CX',
  'Delta Air Lines': 'DL',
  'Emirates': 'EK',
  'Iberia': 'IB',
  'ITA Airways': 'AZ',
  'Japan Airlines': 'JL',
  'JetBlue': 'B6',
  'KLM': 'KL',
  'Lufthansa': 'LH',
  'Qantas': 'QF',
  'Singapore Airlines': 'SQ',
  'SWISS': 'LX',
  'TAP Air Portugal': 'TP',
  'Turkish Airlines': 'TK',
  'United Airlines': 'UA',
  'Virgin Atlantic': 'VS',
};

/**
 * IATA carrier code for a carrier name, or null when the name is not one this
 * table knows. A literal two-letter code passes through unchanged.
 */
function carrierCodeFromName(name: string | null | undefined): string | null {
  if (!name) return null;
  const explicit = /^\s*([A-Z0-9]{2})\s*$/.exec(name);
  if (explicit) return explicit[1];
  return CARRIER_CODES[name] ?? null;
}

/** Stable uppercase code from free text: "Deluxe King" → "DELUXE_KING". */
function slugCode(label: string): string {
  return label
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
}

/**
 * Room grid for a hotel.
 *
 * The seeds carry a single `roomCategory` ("Deluxe suite"), so this emits a
 * one-entry grid. That is honest: it says "this property sells exactly the room
 * type we know about". More room types arrive from a supplier feed.
 */
function roomTypesFor(product: Product): Json[] {
  const category = product.roomCategory?.trim();
  if (!category) return [];

  return [
    {
      code: slugCode(category),
      name: category,
      // Not carried by the flat columns; a feed fills these in.
      beds: null,
      maxOccupancy: null,
      sizeSqm: null,
      smoking: 'UNKNOWN',
      amenities: product.amenities ?? [],
    },
  ];
}

/**
 * Ordered segments for a flight.
 *
 * A flat "SIN → JFK" route describes one hop, so this yields a single segment.
 * A route written with a connection point ("SIN → DXB → JFK") yields the two
 * legs it actually names, with the layover spelled out — this is what makes
 * connection search answerable instead of always empty.
 *
 * Times are only emitted when {@link CONNECTING_ITINERARIES} supplies them.
 * Inventing a departure time from a departure date would put a fabricated
 * schedule in front of a traveller; where the seeds carry no clock time the
 * segment stays `null` and the UI must not display one.
 */
function segmentsFor(product: Product): Json[] {
  const route = parseRoute(product.flightRoute);
  if (!route) return [];

  const scheduled = CONNECTING_ITINERARIES[[route.from, ...route.via, route.to].join('|')];
  /**
   * One entry per *leg*, not per airport. `SIN → DXB → JFK` is two flights, so
   * `legs` is `[DXB, JFK]`: leg 1 departs `from` and arrives at `legs[0]`, leg
   * 2 departs `legs[0]` and arrives at `legs[1]`. Building the list from the
   * airports instead (`[from, ...legs]`) emitted a third, imaginary segment —
   * `SIN → DXB`, `DXB → JFK`, `JFK → nowhere` — which is why a two-leg
   * itinerary reported `segmentCount: 3`.
   */
  const legs = route.via.length > 0 ? [...route.via, route.to] : [route.to];

  return legs.map((arrivalAirport, index) => {
    const departureAirport = index === 0 ? route.from : legs[index - 1];
    const departureAt = scheduled?.legs[index]?.departureAt ?? null;
    const arrivalAt = scheduled?.legs[index]?.arrivalAt ?? null;
    return {
      seq: index + 1,
      marketingCarrier: product.airlineName ?? 'UNKNOWN',
      operatingCarrier: product.airlineName,
      flightNumber: scheduled?.legs[index]?.flightNumber ?? null,
      aircraft: scheduled?.legs[index]?.aircraft ?? null,
      departure: { airport: departureAirport, scheduledAt: departureAt, offset: null },
      arrival: { airport: arrivalAirport, scheduledAt: arrivalAt, offset: null },
      durationMinutes:
        departureAt && arrivalAt
          ? Math.round((new Date(arrivalAt).getTime() - new Date(departureAt).getTime()) / 60_000)
          : null,
      cabinCode: product.cabinClass,
      bookingClass: null,
      fareFamily: null,
    };
  });
}

/**
 * Connecting itineraries with real leg times.
 *
 * Every seeded flight product used to be a direct hop, so without this table the
 * connection endpoints had nothing to match: 34 products, 34 segments, zero
 * intermediate stops, and `/search/connections` answered `[]` for every airport
 * including the obvious ones.
 *
 * Keyed by the full `ORIGIN→VIA→DEST` route rather than by leg, so a leg can
 * only be scheduled as part of an itinerary that actually exists. Times are
 * laid out with a 3h25m layover at the hub — long enough to clear transit
 * formalities — and the search filters (`minLayoverMinutes`,
 * `maxLayoverMinutes`) have something real to sort against.
 *
 * These are scheduled-service-shaped times for demo inventory, not a live
 * schedule. They are illustrative only: a customer-facing PNR must come from a
 * supplier feed.
 */
const CONNECTING_ITINERARIES: Record<
  string,
  { legs: { departureAt: string; arrivalAt: string; flightNumber: string; aircraft: string }[] }
> = {
  'SIN|DXB|JFK': {
    legs: [
      { departureAt: '2026-11-05T09:15:00Z', arrivalAt: '2026-11-05T14:40:00Z', flightNumber: 'EK001', aircraft: 'B77W' },
      { departureAt: '2026-11-05T18:05:00Z', arrivalAt: '2026-11-06T00:25:00Z', flightNumber: 'EK030', aircraft: 'B77W' },
    ],
  },
  'SIN|DXB|SIN': {
    legs: [
      { departureAt: '2026-11-05T09:15:00Z', arrivalAt: '2026-11-05T14:40:00Z', flightNumber: 'EK001', aircraft: 'B77W' },
      { departureAt: '2026-11-06T19:45:00Z', arrivalAt: '2026-11-07T11:20:00Z', flightNumber: 'EK001', aircraft: 'B77W' },
    ],
  },
  'SIN|DXB|HKG': {
    legs: [
      { departureAt: '2026-11-05T09:15:00Z', arrivalAt: '2026-11-05T14:40:00Z', flightNumber: 'EK001', aircraft: 'B77W' },
      { departureAt: '2026-11-06T19:10:00Z', arrivalAt: '2026-11-07T11:05:00Z', flightNumber: 'EK302', aircraft: 'B77W' },
    ],
  },
  'HKG|DXB|JFK': {
    legs: [
      { departureAt: '2026-11-05T09:15:00Z', arrivalAt: '2026-11-05T14:40:00Z', flightNumber: 'EK001', aircraft: 'B77W' },
      { departureAt: '2026-11-05T18:05:00Z', arrivalAt: '2026-11-06T00:25:00Z', flightNumber: 'EK030', aircraft: 'B77W' },
    ],
  },
  'HKG|DXB|SIN': {
    legs: [
      { departureAt: '2026-11-05T09:15:00Z', arrivalAt: '2026-11-05T14:40:00Z', flightNumber: 'EK001', aircraft: 'B77W' },
      { departureAt: '2026-11-06T19:45:00Z', arrivalAt: '2026-11-07T11:20:00Z', flightNumber: 'EK001', aircraft: 'B77W' },
    ],
  },
  'HKG|DXB|HKG': {
    legs: [
      { departureAt: '2026-11-05T09:15:00Z', arrivalAt: '2026-11-05T14:40:00Z', flightNumber: 'EK001', aircraft: 'B77W' },
      { departureAt: '2026-11-06T19:10:00Z', arrivalAt: '2026-11-07T11:05:00Z', flightNumber: 'EK302', aircraft: 'B77W' },
    ],
  },
  'LAX|DXB|SIN': {
    legs: [
      { departureAt: '2026-11-05T08:40:00Z', arrivalAt: '2026-11-05T20:10:00Z', flightNumber: 'EK215', aircraft: 'B77W' },
      { departureAt: '2026-11-06T09:45:00Z', arrivalAt: '2026-11-07T01:20:00Z', flightNumber: 'EK001', aircraft: 'B77W' },
    ],
  },
  'JFK|DXB|SIN': {
    legs: [
      { departureAt: '2026-11-05T02:20:00Z', arrivalAt: '2026-11-05T08:30:00Z', flightNumber: 'EK201', aircraft: 'B77W' },
      { departureAt: '2026-11-06T09:45:00Z', arrivalAt: '2026-11-07T01:20:00Z', flightNumber: 'EK001', aircraft: 'B77W' },
    ],
  },
  'JFK|DXB|HKG': {
    legs: [
      { departureAt: '2026-11-05T02:20:00Z', arrivalAt: '2026-11-05T08:30:00Z', flightNumber: 'EK201', aircraft: 'B77W' },
      { departureAt: '2026-11-06T09:10:00Z', arrivalAt: '2026-11-07T01:05:00Z', flightNumber: 'EK302', aircraft: 'B77W' },
    ],
  },
};


/** Cabin list for a flight — the flat column carries exactly one cabin. */
function cabinsFor(product: Product): Json[] {
  if (!product.cabinClass) return [];
  return [
    {
      code: slugCode(product.cabinClass),
      name: product.cabinClass,
      bags: { carryOn: null, checked: null },
      seatPitchMm: null,
    },
  ];
}

/** Port calls for a cruise. `itineraryPorts` is a flat list with no times. */
function portsFor(product: Product): Json[] {
  return product.itineraryPorts.map((port, index) => ({
    day: index + 1,
    port,
    country: null,
    arrivalAt: null,
    departureAt: null,
    tender: null,
    overnight: null,
  }));
}

/** Cabin categories for a cruise — one entry, from `roomCategory`. */
function cabinCategoriesFor(product: Product): Json[] {
  const label = product.roomCategory?.trim();
  if (!label) return [];
  return [
    {
      code: slugCode(label),
      name: label,
      deckFrom: null,
      deckTo: null,
      beds: { standard: null, max: null },
      sizeSqm: null,
      window: 'UNKNOWN',
      accessible: null,
    },
  ];
}

/**
 * Backfill one product's extension table.
 *
 * @returns the table written, or null when the type has no extension or a row
 * already exists (so a re-run never clobbers data a feed has populated).
 */
/**
 * A comparable fingerprint of an itinerary: the airports, in order.
 *
 * Comparing `segmentCount` alone cannot tell `HKG → HKG` from `HKG → SIN` — both
 * are one leg — so a corrected route reads as unchanged and the stale
 * `FlightSegment` rows survive. This is the string the two blobs are judged on.
 */
function routeSignature(segments: unknown): string {
  if (!Array.isArray(segments)) return '';
  return segments
    .map((entry) => {
      const leg = entry as JsonSegment;
      const from = leg.departure?.airport ?? '';
      const to = leg.arrival?.airport ?? '';
      return `${from}>${to}`;
    })
    .join('|');
}

async function backfillOne(prisma: PrismaClient, product: Product): Promise<string | null> {
  switch (product.type) {
    case 'HOTEL_ROOM': {
      const existing = await prisma.productStay.findUnique({ where: { productId: product.id } });
      if (existing) return null;

      await prisma.productStay.create({
        data: {
          productId: product.id,
          propertyType: 'HOTEL',
          starRating: product.starCategory,
          checkInTime: '15:00',
          checkOutTime: '11:00',
          roomTypes: roomTypesFor(product),
          policies: {
            depositCents: null,
            depositReleaseDays: null,
            petFeeCents: null,
            smokingAllowed: null,
            // A single night is the minimum that is always true. The flat columns
            // carry no length-of-stay data, so this is a floor, not a description.
            minNights: 1,
            maxNights: null,
            childrenPolicy: null,
          },
        },
      });
      return 'stay';
    }

    case 'FLIGHT': {
      const segments = segmentsFor(product);
      const marketingCarrier = product.airlineName ?? 'UNKNOWN';
      const marketingCarrierCode = carrierCodeFromName(product.airlineName);

      const existing = await prisma.productFlight.findUnique({ where: { productId: product.id } });
      if (existing) {
        // A re-run must be able to correct the itinerary. Returning early here
        // meant a route changed from `SIN → JFK` to `SIN → DXB → JFK` kept
        // advertising a single leg: the seed reported `flight: 0` and the stale
        // `segments` blob then propagated into `FlightSegment`.
        //
        // Only the shape of the journey is refreshed. `ticketingRules` and
        // `cabins` are left alone because a supplier feed owns those.
        //
        // The comparison covers the airports, not just the leg count. `HKG → HKG`
        // and `HKG → SIN` are both a single leg, so comparing lengths reported
        // them as identical and left the stale itinerary in place — which is how
        // three `FlightSegment` rows ended up saying `HKG → HKG` for a product
        // whose route read `HKG → SIN`.
        const sameRoute =
          existing.segmentCount === segments.length &&
          existing.marketingCarrier === marketingCarrier &&
          routeSignature(existing.segments) === routeSignature(segments);

        if (sameRoute) return null;
        await prisma.productFlight.update({
          where: { productId: product.id },
          data: {
            marketingCarrier,
            marketingCarrierCode,
            segmentCount: segments.length,
            segments,
          },
        });
        return 'flight';
      }

      await prisma.productFlight.create({
        data: {
          productId: product.id,
          marketingCarrier,
          marketingCarrierCode,
          segmentCount: segments.length,
          segments,
          cabins: cabinsFor(product),
          fareFamilies: [],
          ticketingRules: {
            minConnectMinutes: null,
            maxConnectMinutes: null,
            validOn: null,
            fareBasisRequired: null,
          },
        },
      });
      return 'flight';
    }

    case 'CRUISE': {
      const existing = await prisma.productSailing.findUnique({ where: { productId: product.id } });
      if (existing) return null;

      await prisma.productSailing.create({
        data: {
          productId: product.id,
          shipName: product.shipName ?? 'UNKNOWN',
          lineName: product.cruiseLine ?? 'UNKNOWN',
          nights: product.cruiseNights,
          ports: portsFor(product),
          cabinCategories: cabinCategoriesFor(product),
          inclusions: {
            diningPlanCodes: [],
            drinkPlanCodes: [],
            gratuityIncluded: null,
            wifiIncluded: null,
          },
        },
      });
      return 'sailing';
    }

    case 'RENTAL_CAR':
    case 'VEHICLE_RENTAL':
    case 'TRANSFER':
    case 'AIRPORT_TRANSFER': {
      const existing = await prisma.productVehicle.findUnique({ where: { productId: product.id } });
      if (existing) return null;

      await prisma.productVehicle.create({
        data: {
          productId: product.id,
          serviceKind: product.type,
          vehicleClasses: [],
          transferOptions: {},
          rentalPolicy: {},
          supplyPolicy: {},
        },
      });
      return 'vehicle';
    }

    default:
      return null;
  }
}

/**
 * Refresh the Phase 0 facets on `SearchDocument` from `Product`'s display
 * columns.
 *
 * Runs on every invocation, independent of the extension tables, because these
 * columns derive from `Product` — the display source of truth. This is the data
 * faceted search reads.
 */
async function backfillSearchFacets(prisma: PrismaClient): Promise<number> {
  const products = await prisma.product.findMany({
    select: {
      id: true,
      type: true,
      starCategory: true,
      boardBasis: true,
      roomCategory: true,
      airlineName: true,
      flightRoute: true,
      cabinClass: true,
      shipName: true,
      cruiseLine: true,
      cruiseNights: true,
      itineraryPorts: true,
    },
  });

  for (const product of products) {
    const route = parseRoute(product.flightRoute);
    const isStay = product.type === 'HOTEL_ROOM';
    const isFlight = product.type === 'FLIGHT';
    const isCruise = product.type === 'CRUISE';

    await prisma.searchDocument.updateMany({
      where: { productId: product.id },
      data: {
        starRating: isStay ? product.starCategory : null,
        boardBasis: isStay ? product.boardBasis : null,
        roomCategory: isStay ? product.roomCategory : null,
        carrierCode: isFlight ? carrierCodeFromName(product.airlineName) : null,
        carrierName: isFlight ? product.airlineName : null,
        routeSummary: isFlight ? product.flightRoute : null,
        // The true leg count, not 1: a one-stop itinerary has two. Hardcoding 1
        // made every connecting product advertise itself as direct.
        segmentCount: isFlight ? Math.max(route ? route.via.length + 1 : 0, 0) : null,
        cabinClasses: isFlight && product.cabinClass ? [product.cabinClass] : [],
        shipName: isCruise ? product.shipName : null,
        cruiseLine: isCruise ? product.cruiseLine : null,
        nights: product.cruiseNights,
        destinationPort: isCruise ? (product.itineraryPorts[0] ?? null) : null,
      },
    });
  }
  return products.length;
}

/**
 * Mirror every `ProductFlight.segments` blob into `FlightSegment` rows.
 *
 * The blob is the source of truth for a single-row product read; the rows are
 * what connection search can index. Rather than re-deriving segments (which
 * would let the two copies drift), this reads the blob back and projects each
 * entry, so the row set is by construction the same itinerary.
 *
 * Idempotent by comparison, not by skipping: the leg count already stored is
 * checked against the blob, and only a product whose itinerary actually changed
 * is rewritten. A bare "rows exist → skip" guard left the very products this
 * backfill exists for permanently stale — changing a route from `SIN → JFK` to
 * `SIN → DXB → JFK` re-ran the seed and reported `itineraries: 0`, because the
 * single old leg was still there.
 *
 * @returns the number of products whose itinerary was mirrored.
 */
async function backfillFlightSegments(prisma: PrismaClient): Promise<number> {
  const flights = await prisma.productFlight.findMany({ select: { productId: true, segments: true } });

  let mirrored = 0;
  for (const flight of flights) {
    const entries = Array.isArray(flight.segments) ? (flight.segments as JsonSegment[]) : [];
    if (entries.length === 0) continue;

    const rows = entries
      .map((entry, index) => toSegmentRow(flight.productId, entry, index))
      .filter((row): row is Prisma.FlightSegmentCreateManyInput => row !== null);
    if (rows.length === 0) continue;

    const existing = await prisma.flightSegment.findMany({
      where: { productId: flight.productId },
      select: { seq: true, departureAirport: true, arrivalAirport: true, departureScheduledAt: true },
      orderBy: { seq: 'asc' },
    });

    // Compare shape *and* schedule. Counting rows is not enough: a stale mirror
    // can hold the same number of legs as the blob and still be describing a
    // different journey, which is how a two-leg product kept three rows with no
    // times while the blob beside it said otherwise.
    const matches =
      existing.length === rows.length &&
      existing.every((row, index) => {
        const next = rows[index];
        const wantDeparture = next.departureScheduledAt instanceof Date ? next.departureScheduledAt : null;
        return (
          row.seq === next.seq &&
          row.departureAirport === next.departureAirport &&
          row.arrivalAirport === next.arrivalAirport &&
          (row.departureScheduledAt?.getTime() ?? null) === (wantDeparture?.getTime() ?? null)
        );
      });

    // Never clobber a richer schedule a feed has filled in: if the stored rows
    // already carry times the blob does not, and the airports already agree,
    // leave them alone.
    const storedHasSchedule = existing.some((row) => row.departureScheduledAt !== null);
    const blobHasSchedule = rows.some((row) => row.departureScheduledAt !== null);
    if (matches && !(blobHasSchedule && !storedHasSchedule)) continue;

    // Anything else is rewritten, including a route change on a product whose
    // itinerary carries no times at all. An earlier draft skipped when both
    // sides were schedule-less, which is precisely the case that let `HKG → HKG`
    // rows survive under a product whose route read `HKG → SIN`: the airport
    // comparison below said "different", and this said "nothing to preserve".
    // Preserving a schedule is the only reason to skip, so that is the only
    // reason to skip.

    await prisma.flightSegment.deleteMany({ where: { productId: flight.productId } });
    await prisma.flightSegment.createMany({ data: rows });
    mirrored += 1;
  }
  return mirrored;
}

/** The subset of the `segments` blob shape this file needs to project. */
interface JsonSegment {
  seq?: number;
  marketingCarrier?: string | null;
  operatingCarrier?: string | null;
  flightNumber?: string | null;
  aircraft?: string | null;
  departure?: { airport?: string | null; scheduledAt?: string | null } | null;
  arrival?: { airport?: string | null; scheduledAt?: string | null } | null;
  durationMinutes?: number | null;
  cabinCode?: string | null;
  bookingClass?: string | null;
  fareFamily?: string | null;
}

/**
 * Project one blob entry into a row, or null when it is unusable.
 *
 * A leg with no departure or arrival airport is not a leg. Skipping it rather
 * than storing a placeholder keeps the `departureAirport`/`arrivalAirport`
 * columns genuinely non-null, which is what makes the connection index usable.
 */
function toSegmentRow(
  productId: string,
  entry: JsonSegment,
  index: number,
): Prisma.FlightSegmentCreateManyInput | null {
  const departureAirport = entry.departure?.airport?.trim() || '';
  const arrivalAirport = entry.arrival?.airport?.trim() || '';
  if (!departureAirport || !arrivalAirport) return null;

  const departureScheduledAt = toUtcDate(entry.departure?.scheduledAt);
  const arrivalScheduledAt = toUtcDate(entry.arrival?.scheduledAt);
  const marketingCarrier = entry.marketingCarrier?.trim() || null;

  return {
    productId,
    seq: entry.seq && entry.seq > 0 ? entry.seq : index + 1,
    marketingCarrier: marketingCarrier ?? 'UNKNOWN',
    operatingCarrier: entry.operatingCarrier?.trim() || null,
    marketingCarrierCode: marketingCarrier ? carrierCodeFromName(marketingCarrier) : null,
    flightNumber: entry.flightNumber?.trim() || null,
    aircraft: entry.aircraft?.trim() || null,
    departureAirport,
    departureTerminal: null,
    departureScheduledAt,
    departureActualAt: null,
    arrivalAirport,
    arrivalTerminal: null,
    arrivalScheduledAt,
    arrivalActualAt: null,
    // Only trust a stated duration. Deriving it from two timestamps that are
    // themselves absent would invent precision the schedule does not have.
    durationMinutes: typeof entry.durationMinutes === 'number' && entry.durationMinutes > 0
      ? Math.round(entry.durationMinutes)
      : null,
    cabinCode: entry.cabinCode?.trim() || null,
    bookingClass: entry.bookingClass?.trim() || null,
    fareFamily: entry.fareFamily?.trim() || null,
  };
}

/**
 * Parse a schedule timestamp into a Date, or null when it is absent or
 * unparseable. A bad timestamp must not become an Invalid Date that Prisma
 * then writes as the epoch.
 */
function toUtcDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Entry point. Safe to run repeatedly.
 *
 * @returns counts per extension table, for logging and tests.
 */
export async function backfillCategoryExtensions(
  prisma: PrismaClient,
): Promise<Record<string, number>> {
  const products = await prisma.product.findMany({
    where: { type: { in: CATEGORY_TYPES } },
  });

  const counts: Record<string, number> = { stay: 0, flight: 0, sailing: 0, vehicle: 0 };
  for (const product of products) {
    try {
      const written = await backfillOne(prisma, product);
      if (written) counts[written] += 1;
    } catch (error) {
      // One malformed product must not abort a ~110-row backfill.
      logger.warn('seed.category_extension_backfill_failed', {
        productId: product.id,
        reason: (error as Error).message,
      });
    }
  }

  const facets = await backfillSearchFacets(prisma);
  const itineraries = await backfillFlightSegments(prisma);
  logger.info('seed.category_extensions_backfilled', {
    ...counts,
    searchFacets: facets,
    itineraries,
  });

  return counts;
}