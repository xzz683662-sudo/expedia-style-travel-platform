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
export function parseRoute(route: string | null | undefined): { from: string; to: string } | null {
  if (!route) return null;
  const parts = route
    .split(/\s*(?:→|->|➜)\s*/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length !== 2) return null;
  return { from: parts[0], to: parts[1] };
}

/**
 * IATA carrier code from a carrier name.
 *
 * Only recognises a name that *is* a 2-letter code. "British Airways" → "BA"
 * is a lookup against a carrier table, not a transform, and guessing it would
 * produce confidently wrong PNRs — so it stays null here.
 */
function carrierCodeFromName(name: string | null | undefined): string | null {
  if (!name) return null;
  const explicit = /^\s*([A-Z0-9]{2})\s*$/.exec(name);
  return explicit ? explicit[1] : null;
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
 * Multi-city itineraries need a real `FlightSegment` table; until one exists
 * this is correct for the direct case and lossy for the rest — `segmentCount`
 * reports what we emit, not the true itinerary length.
 */
function segmentsFor(product: Product): Json[] {
  const route = parseRoute(product.flightRoute);
  if (!route) return [];

  return [
    {
      seq: 1,
      marketingCarrier: product.airlineName ?? 'UNKNOWN',
      operatingCarrier: product.airlineName,
      flightNumber: null, // not carried by the flat columns
      aircraft: null,
      departure: { airport: route.from, scheduledAt: null, offset: null },
      arrival: { airport: route.to, scheduledAt: null, offset: null },
      durationMinutes: null,
      cabinCode: product.cabinClass,
      bookingClass: null,
      fareFamily: null,
    },
  ];
}

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
      const existing = await prisma.productFlight.findUnique({ where: { productId: product.id } });
      if (existing) return null;

      const segments = segmentsFor(product);
      await prisma.productFlight.create({
        data: {
          productId: product.id,
          marketingCarrier: product.airlineName ?? 'UNKNOWN',
          marketingCarrierCode: carrierCodeFromName(product.airlineName),
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
        segmentCount: isFlight ? (route ? 1 : 0) : null,
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
  logger.info('seed.category_extensions_backfilled', { ...counts, searchFacets: facets });

  return counts;
}