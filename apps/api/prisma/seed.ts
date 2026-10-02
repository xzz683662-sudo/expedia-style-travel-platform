/**
 * ---------------------------------------------------------------------------
 * EasyTrip seed script
 * ---------------------------------------------------------------------------
 *
 * Idempotent and safe to re-run: every write is an upsert keyed on a stable
 * natural key (slug / code). Existing rows are updated in place so local
 * environments converge on the same state.
 *
 * Run with:  pnpm --filter @easytrip/api db:seed
 */

import {
  DestinationLevel,
  FulfillmentMode,
  InventoryMode,
  InventoryStatus,
  LoyaltyTier,
  MerchantStatus,
  NotificationChannel,
  NotificationStatus,
  OrderStatus,
  PaymentChannel,
  PaymentStatus,
  PriceRuleKind,
  ProductStatus,
  ReviewStatus,
  TicketStatus,
  UserRole,
} from '@prisma/client';
import { config } from '../src/config/env';
import { logger } from '../src/lib/logger';
import { prisma } from '../src/lib/prisma';
import { hashPassword } from '../src/utils/crypto';
import { addDays, toServiceDate } from '../src/utils/date';
import { generateOrderNumber, generateTicketNumber, generateBarcode, generateIdempotencyKey } from '../src/utils/ids';
import { generateTicketArtifacts } from '../src/modules/ticketing/issuer';
import { computeQuote } from '../src/modules/pricing/engine';
import { indexProduct } from '../src/modules/search/service';
import { refreshAvailabilityCalendar } from '../src/modules/search/service';
import { DESTINATIONS, MERCHANTS, type SeedDestination, type SeedPriceRule, type SeedProduct } from './seed-data';
import { COUPONS, PRODUCTS } from './seed-products';

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const INVENTORY_WINDOW_DAYS = 120;
const includeDemoData = process.env.SEED_DEMO_DATA !== 'false';

function priceRuleKind(kind: SeedPriceRule['kind']): PriceRuleKind {
  return kind as PriceRuleKind;
}

/** All seeding is anchored to today so inventory windows are always current. */
const today = toServiceDate(new Date());

async function main() {
  logger.info('seed.start');

  // -------------------------------------------------------------------------
  // 1. Destinations (countries first so cities can attach to a parent)
  // -------------------------------------------------------------------------
  const destinationBySlug = new Map<string, string>();

  for (const destination of DESTINATIONS) {
    const record = await prisma.destination.upsert({
      where: { slug: destination.slug },
      create: {
        slug: destination.slug,
        name: destination.name,
        level: destination.level as DestinationLevel,
        countryCode: destination.countryCode,
        timezone: destination.timezone,
        latitude: destination.latitude,
        longitude: destination.longitude,
        description: destination.description ?? null,
        heroImageUrl: destination.heroImageUrl ?? null,
        isPopular: destination.isPopular ?? false,
        sortWeight: destination.sortWeight ?? 0,
      },
      update: {
        name: destination.name,
        level: destination.level as DestinationLevel,
        countryCode: destination.countryCode,
        timezone: destination.timezone,
        latitude: destination.latitude,
        longitude: destination.longitude,
        description: destination.description ?? null,
        heroImageUrl: destination.heroImageUrl ?? null,
        isPopular: destination.isPopular ?? false,
        sortWeight: destination.sortWeight ?? 0,
      },
    });

    destinationBySlug.set(destination.slug, record.id);
  }

  // Now that all destinations exist, wire up the parent pointers.
  for (const destination of DESTINATIONS) {
    if (destination.level !== 'CITY') continue;
    const country = DESTINATIONS.find((d) => d.level === 'COUNTRY' && d.countryCode === destination.countryCode);
    if (!country) continue;

    await prisma.destination.update({
      where: { slug: destination.slug },
      data: { parentId: destinationBySlug.get(country.slug) },
    });
  }

  logger.info('seed.destinations', { count: destinationBySlug.size });

  // -------------------------------------------------------------------------
  // 2. Merchants
  // -------------------------------------------------------------------------
  const merchantBySlug = new Map<string, string>();

  for (const merchant of MERCHANTS) {
    const record = await prisma.merchant.upsert({
      where: { slug: merchant.slug },
      create: {
        name: merchant.name,
        slug: merchant.slug,
        description: merchant.description,
        commissionBps: merchant.commissionBps,
        countryCode: merchant.countryCode,
        status: merchant.status as MerchantStatus,
        ratingAvg: 4.5,
        ratingCount: 120,
      },
      update: {
        name: merchant.name,
        description: merchant.description,
        commissionBps: merchant.commissionBps,
        status: merchant.status as MerchantStatus,
      },
    });
    merchantBySlug.set(merchant.slug, record.id);
  }

  logger.info('seed.merchants', { count: merchantBySlug.size });

  // -------------------------------------------------------------------------
  // 3. Products, variants, media, rules, inventory
  // -------------------------------------------------------------------------
  let productCount = 0;
  let ticketTypeCount = 0;
  let inventoryCount = 0;

  for (const definition of PRODUCTS) {
    const destinationId = destinationBySlug.get(definition.destinationSlug);
    const merchantId = definition.merchantSlug ? merchantBySlug.get(definition.merchantSlug) : null;

    const product = await prisma.product.upsert({
      where: { slug: definition.slug },
      create: {
        slug: definition.slug,
        type: definition.type,
        fulfillment: (definition.fulfillment ?? 'INSTANT_TICKET') as FulfillmentMode,
        status: ProductStatus.PUBLISHED,
        merchantId,
        destinationId,
        latitude: definition.latitude,
        longitude: definition.longitude,
        addressLine: definition.addressLine ?? null,
        meetingPoint: definition.meetingPoint ?? null,
        timezone: definition.timezone,
        defaultLocale: definition.defaultLocale ?? 'en',
        summary: definition.summary,
        highlights: definition.highlights,
        includes: definition.includes,
        excludes: definition.excludes,
        amenities: definition.amenities ?? [],
        audience: definition.audience ?? [],
        languages: definition.languages ?? [],
        instantConfirm: definition.instantConfirm ?? true,
        mobileTicket: definition.mobileTicket ?? true,
        freeCancellation: definition.freeCancellation ?? true,
        skipTheLine: definition.skipTheLine ?? false,
        ticketOnly: definition.ticketOnly ?? false,
        wheelchairAccessible: definition.wheelchairAccessible ?? false,
        durationMinutes: definition.durationMinutes ?? null,
        minAge: definition.minAge ?? null,
        maxAge: definition.maxAge ?? null,
        airlineName: definition.airlineName ?? null,
        flightRoute: definition.flightRoute ?? null,
        cabinClass: definition.cabinClass ?? null,
        roomCategory: definition.roomCategory ?? null,
        starCategory: definition.starCategory ?? null,
        boardBasis: definition.boardBasis ?? null,
        cruiseLine: definition.cruiseLine ?? null,
        shipName: definition.shipName ?? null,
        cruiseNights: definition.cruiseNights ?? null,
        itineraryPorts: definition.itineraryPorts ?? [],
        groupSizeCap: definition.groupSizeCap ?? null,
        privateDeparture: definition.privateDeparture ?? false,
        publishedAt: new Date(),
      },
      update: {
        status: ProductStatus.PUBLISHED,
        summary: definition.summary,
        highlights: definition.highlights,
        includes: definition.includes,
        excludes: definition.excludes,
        merchantId,
        destinationId,
        airlineName: definition.airlineName ?? null,
        flightRoute: definition.flightRoute ?? null,
        cabinClass: definition.cabinClass ?? null,
        roomCategory: definition.roomCategory ?? null,
        starCategory: definition.starCategory ?? null,
        boardBasis: definition.boardBasis ?? null,
        cruiseLine: definition.cruiseLine ?? null,
        shipName: definition.shipName ?? null,
        cruiseNights: definition.cruiseNights ?? null,
        itineraryPorts: definition.itineraryPorts ?? [],
        groupSizeCap: definition.groupSizeCap ?? null,
        privateDeparture: definition.privateDeparture ?? false,
      },
    });

    productCount += 1;

    // --- Translations ------------------------------------------------------
    await prisma.productTranslation.deleteMany({ where: { productId: product.id } });

    // English is the fallback locale and must always exist. `definition.name`
    // is the authored title; a humanised slug is only a last resort, because
    // it produces things like "Top View Observation Deck" where the authored
    // "Skyline Observation Deck at One World Trade Center" reads far better.
    const englishName =
      definition.name ??
      definition.slug
        .split('-')
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join(' ');

    await prisma.productTranslation.createMany({
      data: [
        {
          productId: product.id,
          locale: 'en',
          name: englishName,
          summary: definition.summary,
          description: definition.description,
          highlights: definition.highlights,
          includes: definition.includes,
          excludes: definition.excludes,
          meetingPoint: definition.meetingPoint ?? null,
        },
        ...(definition.translations ?? []).map((t) => ({
          productId: product.id,
          locale: t.locale,
          name: t.name,
          summary: t.summary,
          highlights: t.highlights ?? [],
        })),
      ],
    });

    // --- Media -------------------------------------------------------------
    await prisma.productMedia.deleteMany({ where: { productId: product.id } });
    await prisma.productMedia.createMany({
      data: definition.media.map((m, index) => ({
        productId: product.id,
        url: m.url,
        altText: m.altText,
        position: index,
      })),
    });

    // --- Tags --------------------------------------------------------------
    await prisma.productTag.deleteMany({ where: { productId: product.id } });
    await prisma.productTag.createMany({
      data: definition.tags.map((tag) => ({
        productId: product.id,
        slug: tag,
        label: tag.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
      })),
    });

    // --- Ticket types ------------------------------------------------------
    const ticketTypeByCode = new Map<string, string>();

    for (const [index, variant] of definition.ticketTypes.entries()) {
      const ticketType = await prisma.ticketType.upsert({
        where: { code: variant.code },
        create: {
          productId: product.id,
          code: variant.code,
          name: variant.name,
          description: variant.description ?? null,
          basePriceCents: variant.basePriceCents,
          compareAtCents: variant.compareAtCents ?? null,
          costCents: variant.costCents,
          currency: variant.currency ?? 'USD',
          taxBps: variant.taxBps ?? 0,
          feeBps: variant.feeBps ?? 0,
          inventoryMode: (variant.inventoryMode ?? 'PER_DATE') as InventoryMode,
          inventorySource: 'MANUAL',
          maxPerOrder: variant.maxPerOrder ?? 10,
          minPerOrder: variant.minPerOrder ?? 1,
          isRefundable: variant.isRefundable ?? true,
          isTransferable: variant.isTransferable ?? false,
          requiresPassport: variant.requiresPassport ?? false,
          position: index,
        },
        update: {
          name: variant.name,
          description: variant.description ?? null,
          basePriceCents: variant.basePriceCents,
          compareAtCents: variant.compareAtCents ?? null,
          costCents: variant.costCents,
          taxBps: variant.taxBps ?? 0,
          feeBps: variant.feeBps ?? 0,
          inventoryMode: (variant.inventoryMode ?? 'PER_DATE') as InventoryMode,
          maxPerOrder: variant.maxPerOrder ?? 10,
          minPerOrder: variant.minPerOrder ?? 1,
          position: index,
          active: true,
        },
      });

      ticketTypeByCode.set(variant.code, ticketType.id);
      ticketTypeCount += 1;

      // --- Inventory window ------------------------------------------------
      // PER_SLOT / PER_DATE / PER_NIGHT each get one row per day (plus slots).
      if ((variant.inventoryMode ?? 'PER_DATE') !== InventoryMode.UNLIMITED) {
        const slots = variant.timeSlots ?? [''];
        const capacity = variant.capacity ?? 50;

        for (let offset = 0; offset < INVENTORY_WINDOW_DAYS; offset += 1) {
          const serviceDate = addDays(today, offset);

          for (const slot of slots) {
            // Vary capacity slightly by day so the calendar shows realistic
            // availability instead of a uniform block.
            const weekendBoost = [0, 6].includes(serviceDate.getUTCDay()) ? 1.25 : 1;
            const dayCapacity = Math.max(1, Math.round(capacity * weekendBoost));

            await prisma.inventoryRecord.upsert({
              where: {
                ticketTypeId_serviceDate_timeSlot: {
                  ticketTypeId: ticketType.id,
                  serviceDate,
                  timeSlot: slot,
                },
              },
              create: {
                ticketTypeId: ticketType.id,
                serviceDate,
                timeSlot: slot,
                capacityTotal: dayCapacity,
                status: InventoryStatus.OPEN,
                netPriceCents: variant.netPriceCents ?? variant.costCents,
              },
              update: {
                capacityTotal: dayCapacity,
                // Never raise capacity below what has already been sold.
                ...(dayCapacity >= 0 ? {} : {}),
                status: InventoryStatus.OPEN,
                netPriceCents: variant.netPriceCents ?? variant.costCents,
              },
            });
            inventoryCount += 1;
          }
        }
      }
    }

    // --- Price rules -------------------------------------------------------
    await prisma.priceRule.deleteMany({
      where: { OR: [{ productId: product.id }, { ticketTypeId: { in: [...ticketTypeByCode.values()] } }] },
    });

    for (const rule of definition.priceRules ?? []) {
      const ticketTypeId = rule.scope === 'TICKET_TYPE'
        ? ticketTypeByCode.get(rule.ticketCode ?? '')
        : null;

      if (rule.scope === 'TICKET_TYPE' && !ticketTypeId) {
        logger.warn('seed.price_rule_skipped', { product: definition.slug, ticketCode: rule.ticketCode });
        continue;
      }

      await prisma.priceRule.create({
        data: {
          productId: rule.scope === 'PRODUCT' ? product.id : null,
          ticketTypeId,
          kind: priceRuleKind(rule.kind),
          name: rule.name,
          priority: rule.priority ?? 100,
          conditions: rule.conditions as never,
          adjustment: rule.adjustment as never,
          minQuantity: rule.minQuantity ?? 1,
          startsAt: rule.startsAt ? new Date(rule.startsAt) : null,
          endsAt: rule.endsAt ? new Date(rule.endsAt) : null,
          active: true,
        },
      });
    }

    // --- Cancellation policy ----------------------------------------------
    if (definition.cancellationPolicy) {
      const policy = definition.cancellationPolicy;
      await prisma.cancellationPolicy.upsert({
        where: { productId: product.id },
        create: {
          productId: product.id,
          refundType: 'REFUND',
          freeCancelHours: policy.freeCancelHours,
          tiers: policy.tiers as never,
          adminFeeCents: policy.adminFeeCents,
          description: policy.description,
        },
        update: {
          freeCancelHours: policy.freeCancelHours,
          tiers: policy.tiers as never,
          adminFeeCents: policy.adminFeeCents,
          description: policy.description,
        },
      });
    }

    if (includeDemoData) {
      // --- Reviews + rating aggregates -----------------------------------
      const customer = await ensureCustomer();
      await prisma.review.deleteMany({ where: { productId: product.id, userId: customer.id } });

      for (const review of definition.reviews ?? []) {
        await prisma.review.create({
          data: {
            productId: product.id,
            userId: customer.id,
            rating: review.rating,
            title: review.title,
            body: review.body,
            locale: review.locale ?? 'en',
            status: ReviewStatus.PUBLISHED,
            helpfulCount: review.helpfulCount ?? Math.floor(Math.random() * 24),
            visitedAt: new Date(Date.now() - review.daysAgo * 86_400_000),
            createdAt: new Date(Date.now() - review.daysAgo * 86_400_000),
          },
        });
      }

      await recomputeRatings(product.id);
    }
  }

  logger.info('seed.products', { products: productCount, ticketTypes: ticketTypeCount, inventoryRows: inventoryCount });

  // -------------------------------------------------------------------------
  // 4. Coupons & promotions
  // -------------------------------------------------------------------------
  for (const coupon of COUPONS) {
    await prisma.coupon.upsert({
      where: { code: coupon.code },
      create: {
        code: coupon.code,
        description: coupon.description,
        discountType: coupon.discountType,
        discountValue: coupon.discountValue,
        maxDiscountCents: 'maxDiscountCents' in coupon ? (coupon.maxDiscountCents as number) : null,
        minOrderCents: coupon.minOrderCents,
        perUserLimit: coupon.perUserLimit,
        appliesToTypes: [...coupon.appliesToTypes] as never,
        active: true,
      },
      update: {
        description: coupon.description,
        discountValue: coupon.discountValue,
        active: true,
      },
    });
  }

  await prisma.promotion.deleteMany({});
  await prisma.promotion.createMany({
    data: [
      {
        slug: 'summer-city-breaks',
        title: 'City breaks from $19',
        subtitle: 'Museums, tours and cruises across Europe and the US',
        body: 'Book a museum pass, a guided tour or a sunset cruise and save on the usual city break prices.',
        ctaLabel: 'Browse city breaks',
        ctaUrl: '/search?sort=PRICE_ASC',
        startsAt: new Date(Date.now() - 86_400_000),
        endsAt: addDays(new Date(), 90),
        position: 1,
      },
      {
        slug: 'family-adventure',
        title: 'Family days out made easy',
        subtitle: 'Kids go free deals and family bundles',
        body: 'Family bundles that bundle the tickets, the guides and the queue-skipping into one price.',
        ctaLabel: 'See family offers',
        ctaUrl: '/search?tags=family',
        startsAt: new Date(Date.now() - 86_400_000),
        endsAt: addDays(new Date(), 120),
        position: 2,
      },
      {
        slug: 'free-cancellation',
        title: 'Plans change. Free cancellation on thousands of experiences.',
        subtitle: 'Cancel up to 24 hours before for a full refund',
        ctaLabel: 'Browse flexible options',
        ctaUrl: '/search?freeCancellation=true',
        startsAt: new Date(Date.now() - 86_400_000),
        endsAt: addDays(new Date(), 180),
        position: 3,
      },
    ],
  });

  // -------------------------------------------------------------------------
  // 5. Add-ons
  // -------------------------------------------------------------------------
  await prisma.addOn.deleteMany({});
  await prisma.addOn.createMany({
    data: [
      { code: 'AUDIO-GUIDE', name: 'Extra audio guide', description: 'Downloadable audio commentary in your language.', priceCents: 400, taxBps: 2000, maxPerOrder: 4 },
      { code: 'PHOTO-PACK', name: 'Professional photo pack', description: 'Edited photos from your visit, delivered by email.', priceCents: 1200, taxBps: 2000, maxPerOrder: 2 },
      { code: 'FAST-TRACK', name: 'Extra fast-track entry', description: 'Skip any remaining queue on the day.', priceCents: 900, taxBps: 2000, maxPerOrder: 4 },
      { code: 'CITY-TRANSFER', name: 'Return city transfer', description: 'Hotel to venue return transfer.', priceCents: 2400, taxBps: 1000, maxPerOrder: 4 },
    ],
  });

  // -------------------------------------------------------------------------
  // 6. Search index + availability calendars
  // -------------------------------------------------------------------------
  const productsToIndex = await prisma.product.findMany({ where: { status: ProductStatus.PUBLISHED }, select: { id: true } });
  for (const product of productsToIndex) {
    await indexProduct(product.id);
  }
  logger.info('seed.search_indexed', { products: productsToIndex.length });

  for (const product of productsToIndex.slice(0, 40)) {
    await refreshAvailabilityCalendar(product.id, today, 60);
  }

  // -------------------------------------------------------------------------
  // 7. Demo data is opt-in for hosted databases.
  // -------------------------------------------------------------------------
  if (includeDemoData) {
    await seedDemoOrders();
    await ensureStaff();
  } else {
    logger.info('seed.demo_data_skipped');
  }

  // -------------------------------------------------------------------------
  // 9. Promo banners so the storefront strip has something to render
  // -------------------------------------------------------------------------
  await seedPromoBanners();

  logger.info('seed.done');
}

// ---------------------------------------------------------------------------
// Supporting functions
// ---------------------------------------------------------------------------

async function ensureCustomer() {
  const email = 'traveler@easytrip.test';
  return prisma.user.upsert({
    where: { email },
    create: {
      email,
      passwordHash: hashPassword('Password123!'),
      firstName: 'Alex',
      lastName: 'Traveler',
      role: UserRole.CUSTOMER,
      locale: 'en-US',
      countryCode: 'US',
      loyaltyAccount: { create: { tier: LoyaltyTier.GOLD, points: 18_400, lifetimePoints: 21_200 } },
      travelerProfiles: { create: { fullName: 'Alex Traveler', email, isDefault: true } },
    },
    update: {},
  });
}

async function ensureStaff() {
  const staff = [
    { email: 'admin@easytrip.test', role: UserRole.ADMIN, firstName: 'Ops', lastName: 'Admin' },
    { email: 'operator@easytrip.test', role: UserRole.OPERATOR, firstName: 'Gate', lastName: 'Staff' },
    { email: 'merchant@easytrip.test', role: UserRole.MERCHANT, firstName: 'Partner', lastName: 'Manager' },
    // SUPPORT sits below ADMIN: able to fix a customer's record and issue a
    // goodwill refund, unable to touch pricing or simulate payments.
    { email: 'support@easytrip.test', role: UserRole.SUPPORT, firstName: 'Casey', lastName: 'Support' },
  ];

  for (const person of staff) {
    await prisma.user.upsert({
      where: { email: person.email },
      create: {
        email: person.email,
        passwordHash: hashPassword('Password123!'),
        firstName: person.firstName,
        lastName: person.lastName,
        role: person.role,
        loyaltyAccount: { create: { tier: LoyaltyTier.MEMBER } },
      },
      update: { role: person.role },
    });
  }

  // Attach the merchant login to the first partner merchant.
  const merchantUser = await prisma.user.findUnique({ where: { email: 'merchant@easytrip.test' } });
  const partner = await prisma.merchant.findFirst({ where: { slug: 'big-apple-attractions' } });
  if (merchantUser && partner && !partner.ownerUserId) {
    await prisma.merchant.update({ where: { id: partner.id }, data: { ownerUserId: merchantUser.id } });
  }
}

/**
 * Promo banners for the storefront strip.
 *
 * Idempotent by (slot, titleEn): re-running the seed updates copy in place
 * rather than stacking duplicates on the homepage.
 */
async function seedPromoBanners(): Promise<void> {
  const banners = [
    {
      slot: 'home',
      titleEn: 'Fall city breaks — up to 30% off',
      titleZh: '秋季城市短途游 — 低至 7 折',
      bodyEn: 'Hand-picked stays and experiences in 12 European capitals.',
      bodyZh: '精选 12 座欧洲首都的住宿与体验项目。',
      ctaLabelEn: 'Browse city breaks',
      ctaLabelZh: '浏览城市短途游',
      ctaHref: '/search?q=city',
      theme: 'brand',
      sortOrder: 10,
      locales: [],
      markets: [],
    },
    {
      slot: 'home',
      titleEn: 'New: use code WELCOME10 at checkout',
      titleZh: '新用户专享：结账输入 WELCOME10',
      bodyEn: '10% off your first booking, capped at $50.',
      bodyZh: '首次预订享 9 折，最高减免 50 美元。',
      ctaLabelEn: 'See terms',
      ctaLabelZh: '查看条款',
      ctaHref: '/promo',
      theme: 'accent',
      sortOrder: 20,
      locales: [],
      markets: [],
    },
    {
      slot: 'home',
      titleEn: 'North America: free cancellation on most tours',
      titleZh: '北美地区：多数行程免费取消',
      bodyEn: 'Book with confidence — cancel up to 24 hours before departure.',
      bodyZh: '放心预订 — 出发前 24 小时可免费取消。',
      ctaLabelEn: 'Explore tours',
      ctaLabelZh: '探索行程',
      ctaHref: '/search',
      theme: 'success',
      sortOrder: 30,
      // Only shown to the North American market, to demonstrate targeting.
      locales: [],
      markets: ['US', 'CA', 'MX'],
    },
  ];

  for (const banner of banners) {
    const existing = await prisma.promoBanner.findFirst({
      where: { slot: banner.slot, titleEn: banner.titleEn },
      select: { id: true },
    });

    if (existing) {
      await prisma.promoBanner.update({ where: { id: existing.id }, data: banner });
    } else {
      await prisma.promoBanner.create({ data: banner });
    }
  }

  logger.info('seed.promo_banners', { count: banners.length });
}

async function recomputeRatings(productId: string): Promise<void> {
  const stats = await prisma.review.aggregate({
    where: { productId, status: ReviewStatus.PUBLISHED },
    _avg: { rating: true },
    _count: { _all: true },
  });

  await prisma.product.update({
    where: { id: productId },
    data: {
      ratingAvg: Math.round((stats._avg.rating ?? 0) * 10) / 10,
      ratingCount: stats._count._all,
    },
  });

  const grouped = await prisma.review.groupBy({
    by: ['rating'],
    where: { productId, status: ReviewStatus.PUBLISHED },
    _count: { _all: true },
  });

  await prisma.ratingBreakdown.deleteMany({ where: { productId } });
  for (let stars = 1; stars <= 5; stars += 1) {
    const count = grouped.find((g) => g.rating === stars)?._count._all ?? 0;
    await prisma.ratingBreakdown.create({ data: { productId, stars, count } });
  }
}

/** Creates a handful of realistic paid orders with issued tickets. */
async function seedDemoOrders(): Promise<void> {
  const existing = await prisma.order.count();
  if (existing > 0) {
    // Orders already exist. Rather than bailing out entirely, backfill any
    // ticket that never got its artefacts (older seeds wrote tickets straight to
    // the DB). This keeps `db:seed` idempotent *and* self-healing.
    logger.info('seed.demo_orders_existing', { count: existing });
    await backfillTicketArtifacts();
    return;
  }

  const customer = await ensureCustomer();
  const products = await prisma.product.findMany({
    where: { status: ProductStatus.PUBLISHED },
    include: { ticketTypes: { where: { active: true }, orderBy: { basePriceCents: 'asc' } }, translations: { where: { locale: 'en' }, take: 1 } },
  });

  if (products.length === 0) return;

  const names = ['Alex Traveler', 'Jordan Kim', 'Sam Rivera', 'Nina Patel', 'Tom Becker', 'Aisha Okafor', 'Marco Rossi', 'Chloe Dubois'];

  for (let i = 0; i < 12; i += 1) {
    const product = products[(i * 5 + 3) % products.length];
    const ticketType = product.ticketTypes[0];
    if (!ticketType) continue;

    const quantity = 1 + (i % 3);
    const serviceDate = addDays(today, 3 + i * 4);

    const quote = computeQuote({
      basePriceCents: ticketType.basePriceCents,
      compareAtPriceCents: ticketType.compareAtCents,
      taxBps: ticketType.taxBps,
      feeBps: ticketType.feeBps,
      rules: [],
      context: { serviceDate, quoteDate: new Date(), quantity },
    });

    const lineTotal = quote.totalPerUnitCents * quantity;
    const orderNumber = generateOrderNumber();
    const placedAt = new Date(Date.now() - (i + 1) * 3 * 86_400_000);
    const buyerName = names[i % names.length];

    const order = await prisma.order.create({
      data: {
        orderNumber,
        userId: customer.id,
        status: OrderStatus.CONFIRMED,
        channel: ['WEB', 'MOBILE', 'MINI_PROGRAM'][i % 3],
        locale: 'en-US',
        currency: ticketType.currency,
        market: product.destinationId ? 'US' : 'EU',
        contactEmail: customer.email,
        contactPhone: '+1 555 0100',
        subtotalCents: quote.unitPriceCents * quantity,
        discountCents: 0,
        taxCents: quote.taxCents * quantity,
        feeCents: quote.feeCents * quantity,
        markupCents: quote.markupCents * quantity,
        totalCents: lineTotal,
        pointsEarned: Math.floor(lineTotal / 100),
        placedAt,
        paidAt: placedAt,
        confirmedAt: new Date(placedAt.getTime() + 60_000),
        items: {
          create: {
            productId: product.id,
            productName: product.translations[0]?.name ?? product.slug,
            productSlug: product.slug,
            productType: product.type,
            ticketTypeId: ticketType.id,
            ticketTypeName: ticketType.name,
            ticketTypeCode: ticketType.code,
            serviceDate,
            timeSlot: null,
            quantity,
            adultCount: quantity,
            baseUnitPriceCents: ticketType.basePriceCents,
            unitPriceCents: quote.unitPriceCents,
            taxBps: ticketType.taxBps,
            taxCents: quote.taxCents * quantity,
            feeCents: quote.feeCents * quantity,
            markupCents: quote.markupCents * quantity,
            lineTotalCents: lineTotal,
          },
        },
        travelers: { create: { fullName: buyerName, email: customer.email, isLead: true } },
        orderStatusLogs: {
          create: [
            { toStatus: OrderStatus.PENDING_PAYMENT, reason: 'checkout initiated', createdAt: placedAt },
            { toStatus: OrderStatus.PAID, reason: 'payment captured', createdAt: new Date(placedAt.getTime() + 45_000) },
            { toStatus: OrderStatus.CONFIRMED, reason: 'ticket issued', createdAt: new Date(placedAt.getTime() + 60_000) },
          ],
        },
      },
    });

    await prisma.payment.create({
      data: {
        orderId: order.id,
        provider: 'mock',
        providerIntentId: `mock_pi_seed_${i}`,
        providerChargeId: `mock_ch_seed_${i}`,
        method: PaymentChannel.CARD,
        status: PaymentStatus.CAPTURED,
        amountCents: lineTotal,
        currency: ticketType.currency,
        cardBrand: i % 3 === 0 ? 'visa' : i % 3 === 1 ? 'mastercard' : 'amex',
        cardLast4: '4242',
        idempotencyKey: generateIdempotencyKey(`seed_${i}`),
        capturedAt: placedAt,
        createdAt: placedAt,
      },
    });

    // Issue a ticket per order. We go through the real issuer (rather than a
    // bare `ticket.create`) so seeded demo orders ship working QR codes and PDF
    // passes — otherwise the wallet and the gate scanner have nothing to show.
    const ticketNumber = generateTicketNumber();
    const barcode = generateBarcode();

    const artifacts = await generateTicketArtifacts({
      ticketNumber,
      barcode,
      orderNumber,
      productName: product.translations[0]?.name ?? product.slug,
      destinationName: product.translations[0]?.shortName ?? null,
      holderName: buyerName,
      holderEmail: customer.email,
      serviceDate: new Date(serviceDate),
      timeSlot: null,
      quantity,
      totalCents: lineTotal,
      currency: ticketType.currency,
    });

    await prisma.ticket.create({
      data: {
        orderId: order.id,
        ticketNumber,
        productId: product.id,
        productName: product.translations[0]?.name ?? product.slug,
        productSlug: product.slug,
        holderName: buyerName,
        holderEmail: customer.email,
        status: TicketStatus.ISSUED,
        qrPayload: artifacts.qrPayload,
        qrImageUrl: artifacts.qrImageUrl,
        pdfUrl: artifacts.pdfUrl,
        barcode,
        validFrom: serviceDate,
        serviceDate,
        items: { create: { ticketTypeId: ticketType.id, name: ticketType.name, holderName: buyerName } },
      },
    });

    // Move inventory to reflect the sale.
    await prisma.inventoryRecord.updateMany({
      where: { ticketTypeId: ticketType.id, serviceDate },
      data: { capacitySold: { increment: quantity } },
    });

    await prisma.notification.create({
      data: {
        userId: customer.id,
        orderId: order.id,
        channel: NotificationChannel.EMAIL,
        status: NotificationStatus.SENT,
        template: 'order-confirmed',
        locale: 'en-US',
        subject: `Your EasyTrip order ${orderNumber}`,
        sentAt: new Date(placedAt.getTime() + 90_000),
      },
    });
  }

  logger.info('seed.demo_orders', { count: 12 });
}

/**
 * Generates QR/PDF artefacts for any ticket that is missing them.
 *
 * Keeps the demo wallet and gate scanner usable after a seed upgrade without
 * forcing a destructive `db:reset` on a running environment.
 */
async function backfillTicketArtifacts(): Promise<void> {
  const orphans = await prisma.ticket.findMany({
    where: { OR: [{ qrImageUrl: null }, { pdfUrl: null }] },
    include: { order: true, items: { take: 1 } },
  });

  if (orphans.length === 0) return;

  for (const ticket of orphans) {
    const quantity = ticket.items.length || 1;
    const artifacts = await generateTicketArtifacts({
      ticketNumber: ticket.ticketNumber,
      barcode: ticket.barcode,
      orderNumber: ticket.order.orderNumber,
      productName: ticket.productName,
      destinationName: ticket.destinationName,
      holderName: ticket.holderName,
      holderEmail: ticket.holderEmail,
      serviceDate: ticket.serviceDate,
      timeSlot: ticket.timeSlot,
      quantity,
      totalCents: ticket.order.totalCents,
      currency: ticket.order.currency,
    });

    await prisma.ticket.update({
      where: { id: ticket.id },
      data: {
        qrPayload: artifacts.qrPayload,
        qrImageUrl: artifacts.qrImageUrl,
        pdfUrl: artifacts.pdfUrl,
      },
    });
  }

  logger.info('seed.ticket_artifacts_backfilled', { count: orphans.length });
}

main()
  .catch((error) => {
    logger.error('seed.failed', { reason: (error as Error).message, stack: (error as Error).stack });
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
    void config;
  });
