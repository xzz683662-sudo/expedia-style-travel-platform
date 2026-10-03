/**
 * Phase 1 — bundle seeding.
 *
 * A `ProductBundle` is not a new thing to sell. It is a `Product` of type
 * `PACKAGE` whose components point at ordinary `TicketType`s, and buying one
 * expands into N ordinary cart lines. That is deliberate: the booking engine,
 * the pricing rules, the holds and the ticket issuer already work per line, so
 * a bundle inherits all of them instead of needing a parallel implementation
 * that could drift.
 *
 * What the bundle *adds* is indivisibility — every component is held in one
 * transaction, so a sold-out room can never leave the customer holding a
 * flight they no longer need.
 *
 * Why these particular components
 * -------------------------------
 * The flight and the hotel below share a destination and a currency, which is
 * what makes the pairing realistic and also keeps the seeded cart single-currency
 * (the cart rejects mixed currencies, and a demo package that cannot be added to a
 * cart is not a demo). The hotel sells `PER_NIGHT`, so the component carries
 * `stayNights: 3` and the expansion produces three room-nights alongside the one
 * flight — the shape a real "flight + 3 nights" package sells.
 *
 * The discount is a `Bundle`-level saving, not a price rule on the components:
 * the components keep their own prices so the saving is visible arithmetic rather
 * than a silently cheaper line item.
 *
 * Idempotent: keyed on the package slug, re-runnable.
 */
import type { PrismaClient, Product, TicketType } from '@prisma/client';
import { logger } from '../src/lib/logger';

/** The package this file creates, and the components it is assembled from. */
const PACKAGE = {
  slug: 'london-flight-and-stay',
  name: 'London Flight & 3-Night Stay',
  summary:
    'Business-class London flights plus three nights in a luxury suite, booked as one indivisible package.',
  highlights: [
    'Return flights in Business class',
    'Three nights in a Deluxe suite',
    'One booking, one cancellation',
    'Airport-ready itinerary',
  ],
  flightCode: 'LONDON-FL-BIZ',
  hotelCode: 'LONDON-HT-SUITE',
  stayNights: 3,
  /** Bundled pricing saves 8% against buying the components separately. */
  discountBps: 800,
};

type SeedBundleInput = {
  flight: TicketType;
  hotel: TicketType;
  hotelProduct: Product;
  flightProduct: Product;
};

/**
 * Resolves the components by their stable `code`, not by index or by "the first
 * FLIGHT we find".
 *
 * A seed that picks by ordinal silently re-points itself at a different product
 * whenever the catalogue is reordered, and then the package it claims to describe
 * no longer matches what a customer sees. Codes are the stable identity here.
 */
async function resolveComponents(prisma: PrismaClient): Promise<SeedBundleInput | null> {
  const flight = await prisma.ticketType.findFirst({
    where: { code: PACKAGE.flightCode, active: true },
    include: { product: true },
  });
  const hotel = await prisma.ticketType.findFirst({
    where: { code: PACKAGE.hotelCode, active: true },
    include: { product: true },
  });

  if (!flight || !hotel) {
    logger.warn('seed.bundle_components_missing', {
      flightCode: PACKAGE.flightCode,
      hotelCode: PACKAGE.hotelCode,
      flightFound: Boolean(flight),
      hotelFound: Boolean(hotel),
    });
    return null;
  }

  return { flight, hotel, hotelProduct: hotel.product, flightProduct: flight.product };
}

/** Creates or refreshes the package product and its component graph. */
export async function seedBundles(prisma: PrismaClient): Promise<number> {
  const parts = await resolveComponents(prisma);
  if (!parts) return 0;

  const { flight, hotel, hotelProduct, flightProduct } = parts;

  // A package is priced from what it contains, so a seed that invents a base
  // price would show a discount that does not reconcile against the components.
  const flightNightly = flight.basePriceCents;
  const stayPerNight = hotel.basePriceCents;
  const undiscounted = flightNightly + stayPerNight * PACKAGE.stayNights;
  const discounted = Math.round((undiscounted * (10_000 - PACKAGE.discountBps)) / 10_000);

  const product = await prisma.product.upsert({
    where: { slug: PACKAGE.slug },
    update: {
      summary: PACKAGE.summary,
      highlights: PACKAGE.highlights,
      status: 'PUBLISHED',
      destinationId: flightProduct.destinationId ?? hotelProduct.destinationId,
    },
    create: {
      slug: PACKAGE.slug,
      type: 'PACKAGE',
      status: 'PUBLISHED',
      summary: PACKAGE.summary,
      highlights: PACKAGE.highlights,
      instantConfirm: true,
      freeCancellation: true,
      merchantId: flightProduct.merchantId,
      destinationId: flightProduct.destinationId ?? hotelProduct.destinationId,
      defaultLocale: 'en',
      fulfillment: 'INSTANT_TICKET',
      // `basePriceCents` is the per-package starting point; the sellable options
      // below are what actually price it.
    },
  });

  // `Product` has no `name` column — display copy lives in `ProductTranslation`
  // keyed by locale, the same as every other product in the catalogue.
  await prisma.productTranslation.upsert({
    where: { productId_locale: { productId: product.id, locale: 'en' } },
    update: { name: PACKAGE.name, summary: PACKAGE.summary },
    create: {
      productId: product.id,
      locale: 'en',
      name: PACKAGE.name,
      summary: PACKAGE.summary,
    },
  });

  // The single sellable option for the package. It is priced for display only —
  // buying expands into the components and each is priced by its own rules, so
  // the option must never be the thing that is charged.
  await prisma.ticketType.upsert({
    where: { code: `${PACKAGE.slug.toUpperCase()}-PKG` },
    update: {
      name: `${PACKAGE.name} (per traveller)`,
      basePriceCents: discounted,
      // Must track the components. A cart rejects mixed currencies, so a package
      // whose own ticket type says USD while its GBP components expand into the
      // cart is a package nobody can buy.
      currency: flight.currency,
      costCents: Math.round(
        (flight.costCents + hotel.costCents * PACKAGE.stayNights) / 1,
      ),
      active: true,
    },
    create: {
      productId: product.id,
      code: `${PACKAGE.slug.toUpperCase()}-PKG`,
      name: `${PACKAGE.name} (per traveller)`,
      description: `${PACKAGE.flightCode} + ${PACKAGE.stayNights} nights of ${PACKAGE.hotelCode}.`,
      // Placeholder. Checkout never charges this: a bundle is expanded into its
      // component lines, each priced on its own ticket type, so the components
      // are what the customer is actually billed for.
      basePriceCents: discounted,
      currency: flight.currency,
      costCents: flight.costCents + hotel.costCents * PACKAGE.stayNights,
      inventoryMode: 'PER_DATE',
      maxPerOrder: 8,
      minPerOrder: 1,
      isRefundable: true,
      active: true,
    },
  });

  // Rebuild the component graph wholesale. A package is a definition, not an
  // accumulating log: editing the seed should change the package, not leave
  // removed components behind still attached to it.
  await prisma.productBundle.upsert({
    where: { productId: product.id },
    update: {
      components: {
        deleteMany: {},
        create: [
          {
            ticketTypeId: flight.id,
            kind: 'FLIGHT',
            label: flight.name,
            position: 0,
            quantity: 1,
            required: true,
            startOffsetDays: 0,
          },
          {
            ticketTypeId: hotel.id,
            kind: 'STAY',
            label: hotel.name,
            position: 1,
            quantity: 1,
            required: true,
            // Check-in on arrival day, so the room is held from the same date the
            // flight lands — the reason a bundle exists at all.
            startOffsetDays: 0,
            stayNights: PACKAGE.stayNights,
          },
        ],
      },
    },
    create: {
      productId: product.id,
      components: {
        create: [
          {
            ticketTypeId: flight.id,
            kind: 'FLIGHT',
            label: flight.name,
            position: 0,
            quantity: 1,
            required: true,
            startOffsetDays: 0,
          },
          {
            ticketTypeId: hotel.id,
            kind: 'STAY',
            label: hotel.name,
            position: 1,
            quantity: 1,
            required: true,
            startOffsetDays: 0,
            stayNights: PACKAGE.stayNights,
          },
        ],
      },
    },
  });

  // The package needs inventory of its own to be findable, even though buying it
  // holds the components' inventory instead.
  await prisma.searchDocument.upsert({
    where: { productId: product.id },
    update: { title: PACKAGE.name, basePriceCents: discounted, status: 'PUBLISHED' },
    create: {
      productId: product.id,
      title: PACKAGE.name,
      summary: PACKAGE.summary,
      body: [PACKAGE.name, PACKAGE.summary, ...PACKAGE.highlights].join(' '),
      keywords: ['london', 'flight', 'hotel', 'package', 'bundle', 'business', 'suite'],
      tags: ['package', 'flight', 'hotel'],
      destinationPath: flightProduct.slug ? [flightProduct.slug] : [],
      type: 'PACKAGE',
      status: 'PUBLISHED',
      instantConfirm: true,
      freeCancellation: true,
      // The bundle's headline price. Not stored on `ProductBundle` on purpose —
      // it is derived from live component prices at read time so it cannot drift
      // when a component reprices. This denormalised copy only feeds search
      // ranking and the price-range facet.
      basePriceCents: discounted,
    },
  });

  logger.info('seed.bundles_seeded', {
    slug: PACKAGE.slug,
    productId: product.id,
    undiscounted,
    discounted,
    savedCents: undiscounted - discounted,
    nights: PACKAGE.stayNights,
  });

  return 1;
}