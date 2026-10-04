import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../config/env';
import { prisma } from '../lib/prisma';
import { resolveLocale } from '../plugins/auth';
import { getAvailabilityCalendar, releaseExpiredHolds } from '../modules/inventory/engine';
import { computeQuote } from '../modules/pricing/engine';
import { addDays, toServiceDate } from '../utils/date';
import { AppError, assertFound } from '../utils/errors';

/** Full product detail page payload - the workhorse of the whole frontend. */
export async function productRoutes(app: FastifyInstance): Promise<void> {
  app.get('/products/:slug', async (request) => {
    const { slug } = z.object({ slug: z.string().min(1) }).parse(request.params);
    const query = z
      .object({
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        quantity: z.coerce.number().int().min(1).max(20).optional(),
        locale: z.string().optional(),
      })
      .parse(request.query);

    const locale = resolveLocale(request);

    const product = await prisma.product.findUnique({
      where: { slug },
      include: {
        translations: true,
        media: { orderBy: { position: 'asc' } },
        tags: true,
        destination: { include: { parent: true } },
        merchant: { select: { id: true, name: true, slug: true, ratingAvg: true, ratingCount: true } },
        cancellationPolicy: true,
        // Category extensions (Phase 0). Included so the detail response can
        // carry them — without this the room grid, stay policies, flight
        // segments and sailing ports are all written to the database and never
        // reach a guest. Same "writer without a reader" shape as the search
        // facets. Optional, so a non-stay product simply gets nulls.
        stay: true,
        flight: true,
        sailing: true,
        vehicle: true,
        bundle: { include: { components: { orderBy: { position: 'asc' } } } },
        ticketTypes: {
          where: { active: true },
          orderBy: [{ position: 'asc' }, { basePriceCents: 'asc' }],
          include: {
            translations: true,
            priceRules: { where: { active: true } },
          },
        },
        priceRules: { where: { active: true } },
        reviews: {
          where: { status: 'PUBLISHED' },
          orderBy: { createdAt: 'desc' },
          take: 8,
          include: {
            user: { select: { firstName: true, avatarUrl: true, countryCode: true } },
            media: true,
          },
        },
      },
    });

    if (!product || product.status === 'ARCHIVED') throw AppError.notFound('Experience');
    if (product.status === 'DRAFT' && request.user?.role !== 'ADMIN' && request.user?.role !== 'MERCHANT') {
      throw AppError.notFound('Experience');
    }

    /**
     * Picks the translation for the requested locale.
     *
     * Matching is on the language *subtag*, not the full tag. The catalogue
     * stores bare tags (`en`, `zh`) while `resolveLocale` returns regional ones
     * (`en-US`, `zh-CN`); an exact-equality lookup would silently fall through
     * to English and serve Chinese guests an English product page.
     */
    const language = locale.split('-')[0]!.toLowerCase();
    const translation =
      product.translations.find((t) => t.locale.toLowerCase() === locale.toLowerCase()) ??
      product.translations.find((t) => t.locale.split('-')[0]!.toLowerCase() === language) ??
      product.translations.find((t) => t.locale.toLowerCase().startsWith('en')) ??
      product.translations.find((t) => t.locale.toLowerCase() === product.defaultLocale.toLowerCase()) ??
      product.translations[0];

    const quantity = query.quantity ?? 1;
    const today = toServiceDate(new Date());
    const selectedDate = query.date ? toServiceDate(query.date) : today;

    // Price every variant for the selected date so the ticket picker and the
    // calendar always agree with what checkout will charge.
    const ticketTypes = product.ticketTypes.map((ticketType) => {
      const quote = computeQuote({
        basePriceCents: ticketType.basePriceCents,
        compareAtPriceCents: ticketType.compareAtCents,
        taxBps: ticketType.taxBps,
        feeBps: ticketType.feeBps,
        rules: [...ticketType.priceRules, ...product.priceRules].map((rule) => ({
          id: rule.id,
          kind: rule.kind,
          name: rule.name,
          priority: rule.priority,
          conditions: rule.conditions,
          adjustment: rule.adjustment,
          minQuantity: rule.minQuantity,
          maxUses: rule.maxUses,
          usedCount: rule.usedCount,
          startsAt: rule.startsAt,
          endsAt: rule.endsAt,
          active: rule.active,
        })),
        context: { serviceDate: selectedDate, quoteDate: new Date(), quantity },
      });

      const ttTranslation =
        ticketType.translations.find((t) => t.locale === locale) ?? ticketType.translations[0];

      return {
        id: ticketType.id,
        code: ticketType.code,
        name: ttTranslation?.name ?? ticketType.name,
        description: ttTranslation?.description ?? ticketType.description,
        currency: ticketType.currency,
        basePriceCents: ticketType.basePriceCents,
        compareAtPriceCents: quote.compareAtPriceCents,
        unitPriceCents: quote.unitPriceCents,
        taxCents: quote.taxCents,
        feeCents: quote.feeCents,
        markupCents: quote.markupCents,
        totalPerUnitCents: quote.totalPerUnitCents,
        lineTotalCents: quote.lineTotalCents,
        discountCents: quote.discountCents,
        appliedRules: quote.appliedRules,
        inventoryMode: ticketType.inventoryMode,
        maxPerOrder: ticketType.maxPerOrder,
        minPerOrder: ticketType.minPerOrder,
        minAge: ticketType.minAge,
        maxAge: ticketType.maxAge,
        isRefundable: ticketType.isRefundable,
        isTransferable: ticketType.isTransferable,
        requiresPassport: ticketType.requiresPassport,
      };
    });

    const ratingBreakdown = await prisma.ratingBreakdown.findMany({
      where: { productId: product.id },
      orderBy: { stars: 'desc' },
    });

    const totalRatings = ratingBreakdown.reduce((sum, r) => sum + r.count, 0);

    // Similar experiences power the "You might also like" rail.
    const similar = await prisma.searchDocument.findMany({
      where: {
        productId: { not: product.id },
        status: 'PUBLISHED',
        ...(product.destinationId ? { destinationPath: { has: product.destination!.slug } } : { type: product.type }),
      },
      orderBy: { popularityScore: 'desc' },
      take: 8,
      include: { product: { include: { media: { orderBy: { position: 'asc' }, take: 1 }, translations: { take: 1 } } } },
    });

    return {
      id: product.id,
      slug: product.slug,
      type: product.type,
      fulfillment: product.fulfillment,
      status: product.status,
      name: translation?.name ?? product.slug,
      shortName: translation?.shortName,
      summary: translation?.summary ?? product.summary,
      description: translation?.description,
      highlights: translation?.highlights ?? product.highlights,
      includes: translation?.includes ?? product.includes,
      excludes: translation?.excludes ?? product.excludes,
      meetingPoint: translation?.meetingPoint ?? product.meetingPoint,
      media: product.media.map((m) => ({ url: m.url, type: m.type, altText: m.altText })),
      tags: product.tags.map((t) => ({ slug: t.slug, label: t.label })),
      destination: product.destination
        ? {
            slug: product.destination.slug,
            name: product.destination.name,
            level: product.destination.level,
            countryCode: product.destination.countryCode,
            parent: product.destination.parent?.name ?? null,
          }
        : null,
      location: {
        latitude: product.latitude,
        longitude: product.longitude,
        addressLine: product.addressLine,
        timezone: product.timezone,
      },
      flags: {
        instantConfirm: product.instantConfirm,
        mobileTicket: product.mobileTicket,
        freeCancellation: product.freeCancellation,
        skipTheLine: product.skipTheLine,
        wheelchairAccessible: product.wheelchairAccessible,
        ticketOnly: product.ticketOnly,
        languages: product.languages,
        durationMinutes: product.durationMinutes,
        minAge: product.minAge,
        maxAge: product.maxAge,
      },
      merchant: product.merchant,
      /**
       * Category-specific display fields, mirroring what search ships on each
       * hit. The detail page renders a different header per category (route and
       * cabin for a flight, stars and board basis for a hotel, ship and length
       * for a cruise), so these have to travel with the payload rather than
       * being inferred from the type enum.
       */
      category: {
        airlineName: product.airlineName,
        flightRoute: product.flightRoute,
        cabinClass: product.cabinClass,
        roomCategory: product.roomCategory,
        starCategory: product.starCategory,
        boardBasis: product.boardBasis,
        cruiseLine: product.cruiseLine,
        shipName: product.shipName,
        cruiseNights: product.cruiseNights,
        itineraryPorts: product.itineraryPorts,
        groupSizeCap: product.groupSizeCap,
        privateDeparture: product.privateDeparture,
      },
      rating: {
        average: product.ratingAvg,
        count: product.ratingCount,
        breakdown: ratingBreakdown.map((r) => ({
          stars: r.stars,
          count: r.count,
          percent: totalRatings ? Math.round((r.count / totalRatings) * 100) : 0,
        })),
      },
      cancellationPolicy: product.cancellationPolicy
        ? {
            refundType: product.cancellationPolicy.refundType,
            freeCancelHours: product.cancellationPolicy.freeCancelHours,
            tiers: product.cancellationPolicy.tiers,
            adminFeeCents: product.cancellationPolicy.adminFeeCents,
            description: product.cancellationPolicy.description,
          }
        : null,

      /**
       * Category depth. Exactly one of these is non-null, decided by the
       * product's type rather than by which extension row happens to exist —
       * a hotel with no backfilled `stay` row should read as "unknown", not as
       * a ticket with missing fields.
       *
       * The `Json` columns are passed through as parsed values. They are
       * written only by the backfill and the seed, so they are trusted; but
       * every numeric bound inside `policies` may legitimately be `null` ("not
       * supplied by a feed"), which is why the client must treat absent and
       * zero as different things.
       */
      stay: product.stay
        ? {
            propertyType: product.stay.propertyType,
            starRating: product.stay.starRating,
            brand: product.stay.brand,
            checkInTime: product.stay.checkInTime,
            checkOutTime: product.stay.checkOutTime,
            roomTypes: product.stay.roomTypes,
            policies: product.stay.policies,
            roomTypeTranslations: product.stay.roomTypeTranslations,
          }
        : null,
      flight: product.flight
        ? {
            marketingCarrier: product.flight.marketingCarrier,
            marketingCarrierCode: product.flight.marketingCarrierCode,
            operatingCarrier: product.flight.operatingCarrier,
            alliance: product.flight.alliance,
            segmentCount: product.flight.segmentCount,
            segments: product.flight.segments,
            cabins: product.flight.cabins,
            fareFamilies: product.flight.fareFamilies,
            ticketingRules: product.flight.ticketingRules,
            /**
             * Where this itinerary came from. `SEED` means the schedule and
             * fare were written by this repo, not supplied by an airline.
             *
             * The storefront must show this. A schedule nobody can fly is not a
             * product, and the only reason it is sellable today is that the
             * demo disclaimer is a config flag — see `config.flights`.
             */
            dataOrigin: config.flights.origin,
            requiresDisclosure: config.flights.disclose,
          }
        : null,
      sailing: product.sailing
        ? {
            shipName: product.sailing.shipName,
            lineName: product.sailing.lineName,
            lineCode: product.sailing.lineCode,
            shipCode: product.sailing.shipCode,
            // A sailing is a departure, not a date range: `nights` plus the two
            // ports is what makes "which ship, when, from where, for how long"
            // answerable without a lookup.
            sailDate: product.sailing.sailDate,
            nights: product.sailing.nights,
            embarkationPort: product.sailing.embarkationPort,
            returnPort: product.sailing.returnPort,
            embarkationClosesAt: product.sailing.embarkationClosesAt,
            ports: product.sailing.ports,
            cabinCategories: product.sailing.cabinCategories,
            inclusions: product.sailing.inclusions,
          }
        : null,
      vehicle: product.vehicle
        ? {
            serviceKind: product.vehicle.serviceKind,
            vehicleClasses: product.vehicle.vehicleClasses,
            transferOptions: product.vehicle.transferOptions,
            rentalPolicy: product.vehicle.rentalPolicy,
            supplyPolicy: product.vehicle.supplyPolicy,
          }
        : null,
      /**
       * What a package is made of. The headline price is deliberately absent —
       * it is derived from the components at read time so it cannot drift when a
       * component reprices.
       */
      bundle: product.bundle
        ? {
            components: product.bundle.components.map((component) => ({
              kind: component.kind,
              label: component.label,
              position: component.position,
              required: component.required,
              startOffsetDays: component.startOffsetDays,
              stayNights: component.stayNights,
              quantity: component.quantity,
            })),
          }
        : null,
      selectedDate: selectedDate.toISOString().slice(0, 10),
      quantity,
      ticketTypes,
      reviews: product.reviews.map((review) => ({
        id: review.id,
        rating: review.rating,
        title: review.title,
        body: review.body,
        locale: review.locale,
        helpfulCount: review.helpfulCount,
        merchantReply: review.merchantReply,
        createdAt: review.createdAt,
        author: review.user
          ? {
              name: `${review.user.firstName} ${review.user.firstName.charAt(0)}.`,
              avatarUrl: review.user.avatarUrl,
              countryCode: review.user.countryCode,
            }
          : null,
        media: review.media.map((m) => m.url),
      })),
      similar: similar.map((doc) => ({
        productId: doc.productId,
        slug: doc.product.slug,
        title: doc.product.translations[0]?.name ?? doc.product.slug,
        imageUrl: doc.product.media[0]?.url ?? null,
        priceCents: doc.basePriceCents,
        currency: doc.currency,
        ratingAvg: doc.ratingAvg,
        ratingCount: doc.ratingCount,
        badge: doc.instantConfirm ? 'Instant confirmation' : null,
      })),
    };
  });

  /** 90-day availability calendar for the date picker. */
  app.get('/products/:slug/availability', async (request) => {
    const { slug } = z.object({ slug: z.string() }).parse(request.params);
    const query = z
      .object({
        from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        days: z.coerce.number().int().min(7).max(365).optional(),
      })
      .parse(request.query);

    const product = await prisma.product.findUnique({ where: { slug }, select: { id: true } });
    if (!product) throw AppError.notFound('Experience');

    await releaseExpiredHolds(100);

    const from = query.from ? toServiceDate(query.from) : toServiceDate(new Date());
    const to = addDays(from, query.days ?? 90);

    return { from: from.toISOString().slice(0, 10), days: await getAvailabilityCalendar({ productId: product.id, from, to }) };
  });

  /** Live availability for one ticket type on one date (used by the picker). */
  app.get('/products/:slug/availability/:ticketTypeId', async (request) => {
    const { slug, ticketTypeId } = z.object({ slug: z.string(), ticketTypeId: z.string() }).parse(request.params);
    const query = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).parse(request.query);

    await releaseExpiredHolds(50);

    const records = await prisma.inventoryRecord.findMany({
      where: { ticketTypeId, serviceDate: toServiceDate(query.date) },
    });

    const product = assertFound(
      await prisma.product.findUnique({ where: { slug }, select: { id: true, slug: true } }),
      'Experience',
    );
    void product;

    return records.map((record) => ({
      timeSlot: record.timeSlot,
      available: Math.max(0, record.capacityTotal - record.capacityHeld - record.capacitySold),
      status: record.status,
      netPriceCents: record.netPriceCents,
    }));
  });

  /** Products in the same destination, for the "explore nearby" module. */
  app.get('/products/:slug/nearby', async (request) => {
    const { slug } = z.object({ slug: z.string() }).parse(request.params);
    const query = z.object({ limit: z.coerce.number().int().min(1).max(24).optional() }).parse(request.query);

    const product = assertFound(
      await prisma.product.findUnique({ where: { slug }, select: { id: true, destinationId: true, latitude: true, longitude: true } }),
      'Experience',
    );

    const nearby = await prisma.searchDocument.findMany({
      where: {
        status: 'PUBLISHED',
        ...(product.destinationId
          ? { product: { destinationId: product.destinationId }, NOT: { productId: product.id } }
          : {}),
      },
      take: query.limit ?? 6,
      orderBy: { popularityScore: 'desc' },
    });

    return nearby.map((doc) => ({
      productId: doc.productId,
      title: doc.title,
      priceCents: doc.basePriceCents,
      currency: doc.currency,
      ratingAvg: doc.ratingAvg,
    }));
  });
}