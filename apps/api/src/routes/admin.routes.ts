import { OrderStatus, ProductStatus } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { requireRole } from '../plugins/auth';
import { indexProduct, reindexAll } from '../modules/search/service';
import { seedInventoryWindow } from '../modules/inventory/engine';
import { computeQuote } from '../modules/pricing/engine';
import { assertFound } from '../utils/errors';
import { addDays, toServiceDate } from '../utils/date';
import { hashPassword } from '../utils/crypto';

/**
 * Operator / merchant / admin surface.
 * This is where an Expedia-style business actually gets run day to day:
 * catalogue, inventory, orders, finance and gate operations.
 */
export async function adminRoutes(app: FastifyInstance): Promise<void> {
  const staff = { preHandler: [requireRole('OPERATOR', 'ADMIN', 'MERCHANT')] };
  const adminOnly = { preHandler: [requireRole('ADMIN')] };

  // -------------------------------------------------------------------------
  // Dashboard
  // -------------------------------------------------------------------------
  app.get('/admin/dashboard', staff, async () => {
    const since = new Date(Date.now() - 30 * 86_400_000);

    const [orderCount, revenue, pendingOps, recentOrders, topProducts, lowInventory, recentReviews] = await Promise.all([
      prisma.order.count({ where: { placedAt: { gte: since } } }),
      prisma.order.aggregate({
        where: { placedAt: { gte: since }, status: { in: [OrderStatus.CONFIRMED, OrderStatus.COMPLETED] } },
        _sum: { totalCents: true, refundedCents: true },
        _avg: { totalCents: true },
      }),
      prisma.order.count({ where: { status: OrderStatus.PENDING_PAYMENT } }),
      prisma.order.findMany({
        orderBy: { placedAt: 'desc' },
        take: 12,
        select: {
          id: true,
          orderNumber: true,
          status: true,
          currency: true,
          totalCents: true,
          placedAt: true,
          contactEmail: true,
          user: { select: { firstName: true, lastName: true } },
          _count: { select: { items: true, tickets: true } },
        },
      }),
      prisma.orderItem.groupBy({
        by: ['productId', 'productName'],
        _sum: { lineTotalCents: true, quantity: true },
        where: { order: { placedAt: { gte: since }, status: { in: [OrderStatus.CONFIRMED, OrderStatus.COMPLETED] } } },
        orderBy: { _sum: { lineTotalCents: 'desc' } },
        take: 8,
      }),
      prisma.inventoryRecord.findMany({
        where: { serviceDate: { gte: toServiceDate(new Date()) } },
        include: { ticketType: { include: { product: { select: { slug: true, translations: { where: { locale: 'en' }, take: 1 } } } } } },
        orderBy: { capacityHeld: 'desc' },
        take: 200,
      }),
      prisma.review.findMany({
        where: { status: 'PENDING' },
        orderBy: { createdAt: 'desc' },
        include: { product: { select: { slug: true, translations: { where: { locale: 'en' }, take: 1 } } } },
        take: 10,
      }),
    ]);

    const critical = lowInventory
      .map((record) => {
        const remaining = record.capacityTotal - record.capacityHeld - record.capacitySold;
        return { record, remaining };
      })
      .filter((r) => r.remaining <= Math.max(5, r.record.capacityTotal * 0.1))
      .slice(0, 12)
      .map(({ record, remaining }) => ({
        ticketTypeId: record.ticketTypeId,
        productName: record.ticketType.product.translations[0]?.name ?? record.ticketType.product.slug,
        productSlug: record.ticketType.product.slug,
        serviceDate: record.serviceDate,
        timeSlot: record.timeSlot,
        remaining,
        capacityTotal: record.capacityTotal,
      }));

    const gross = revenue._sum.totalCents ?? 0;
    const refunded = revenue._sum.refundedCents ?? 0;

    return {
      period: { since: since.toISOString(), until: new Date().toISOString() },
      kpis: {
        orders30d: orderCount,
        grossRevenueCents: gross,
        refundedCents: refunded,
        netRevenueCents: gross - refunded,
        averageOrderValueCents: Math.round(revenue._avg.totalCents ?? 0),
        pendingOperations: pendingOps,
        refundRate: gross ? Math.round((refunded / gross) * 1000) / 10 : 0,
      },
      recentOrders: recentOrders.map((o) => ({
        id: o.id,
        orderNumber: o.orderNumber,
        status: o.status,
        totalCents: o.totalCents,
        currency: o.currency,
        placedAt: o.placedAt,
        customer: o.user ? `${o.user.firstName} ${o.user.lastName}` : o.contactEmail,
        itemCount: o._count.items,
        ticketCount: o._count.tickets,
      })),
      topProducts: topProducts.map((p) => ({
        productId: p.productId,
        productName: p.productName,
        revenueCents: p._sum.lineTotalCents ?? 0,
        units: p._sum.quantity ?? 0,
      })),
      criticalInventory: critical,
      pendingReviews: recentReviews,
    };
  });

  // -------------------------------------------------------------------------
  // Catalogue
  // -------------------------------------------------------------------------
  app.get('/admin/products', staff, async (request) => {
    const query = z
      .object({
        status: z.nativeEnum(ProductStatus).optional(),
        q: z.string().max(200).optional(),
        page: z.coerce.number().int().min(1).optional(),
        pageSize: z.coerce.number().int().min(1).max(100).optional(),
      })
      .parse(request.query);

    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;

    const where = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.q ? { slug: { contains: query.q, mode: 'insensitive' as const } } : {}),
    };

    const [products, total] = await Promise.all([
      prisma.product.findMany({
        where,
        orderBy: { updatedAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: {
          translations: { where: { locale: 'en' }, take: 1 },
          destination: { select: { name: true, slug: true } },
          merchant: { select: { name: true } },
          ticketTypes: { where: { active: true }, orderBy: { basePriceCents: 'asc' } },
          _count: { select: { reviews: true } },
        },
      }),
      prisma.product.count({ where }),
    ]);

    return {
      items: products.map((product) => ({
        id: product.id,
        slug: product.slug,
        name: product.translations[0]?.name ?? product.slug,
        type: product.type,
        status: product.status,
        destination: product.destination?.name ?? null,
        merchant: product.merchant?.name ?? 'Platform owned',
        ratingAvg: product.ratingAvg,
        reviewCount: product._count.reviews,
        variants: product.ticketTypes.length,
        priceFromCents: product.ticketTypes[0]?.basePriceCents ?? 0,
        currency: product.ticketTypes[0]?.currency ?? 'USD',
        updatedAt: product.updatedAt,
      })),
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
    };
  });

  app.patch('/admin/products/:id', staff, async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const body = z
      .object({
        status: z.nativeEnum(ProductStatus).optional(),
        instantConfirm: z.boolean().optional(),
        freeCancellation: z.boolean().optional(),
        skipTheLine: z.boolean().optional(),
        popularityScore: z.number().optional(),
      })
      .parse(request.body);

    const product = await prisma.product.update({
      where: { id },
      data: {
        ...body,
        ...(body.status === ProductStatus.PUBLISHED ? { publishedAt: new Date() } : {}),
      },
    });

    await indexProduct(id);

    return { id: product.id, status: product.status, updatedAt: product.updatedAt };
  });

  /** Price simulation: "what happens if I add this rule?" without saving it. */
  app.post('/admin/pricing/simulate', staff, async (request) => {
    const body = z
      .object({
        productId: z.string(),
        serviceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        quantity: z.number().int().min(1).max(20).default(1),
      })
      .parse(request.body);

    const product = assertFound(
      await prisma.product.findUnique({
        where: { id: body.productId },
        include: { priceRules: { where: { active: true } }, ticketTypes: { where: { active: true }, include: { priceRules: { where: { active: true } } } } },
      }),
      'Product',
    );

    const serviceDate = toServiceDate(body.serviceDate);

    return product.ticketTypes.map((ticketType) => {
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
        context: { serviceDate, quoteDate: new Date(), quantity: body.quantity },
      });

      return {
        ticketTypeId: ticketType.id,
        name: ticketType.name,
        basePriceCents: quote.basePriceCents,
        finalPriceCents: quote.unitPriceCents,
        taxCents: quote.taxCents,
        feeCents: quote.feeCents,
        totalPerUnitCents: quote.totalPerUnitCents,
        appliedRules: quote.appliedRules,
      };
    });
  });

  /** Open/close inventory and top up capacity for a date window. */
  app.post('/admin/inventory/adjust', staff, async (request) => {
    const body = z
      .object({
        ticketTypeId: z.string(),
        from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        days: z.number().int().min(1).max(365).default(90),
        capacity: z.number().int().min(0).max(10_000),
        closeDates: z.boolean().optional(),
        timeSlots: z.array(z.string().max(10)).optional(),
      })
      .parse(request.body);

    const from = toServiceDate(body.from);
    const to = addDays(from, body.days - 1);

    if (body.closeDates) {
      await prisma.inventoryRecord.updateMany({
        where: { ticketTypeId: body.ticketTypeId, serviceDate: { gte: from, lte: to } },
        data: { status: 'CLOSED', closedReason: 'Manually closed by operator' },
      });
      return { closed: true, from, to };
    }

    const created = await seedInventoryWindow({
      ticketTypeId: body.ticketTypeId,
      from,
      to,
      capacity: body.capacity,
      timeSlots: body.timeSlots,
    });

    return { rows: created, from, to };
  });

  app.get('/admin/inventory', staff, async (request) => {
    const query = z
      .object({
        productId: z.string().optional(),
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      })
      .parse(request.query);

    const where = {
      ...(query.productId ? { ticketType: { productId: query.productId } } : {}),
      ...(query.date
        ? { serviceDate: toServiceDate(query.date) }
        : query.from && query.to
          ? { serviceDate: { gte: toServiceDate(query.from), lte: toServiceDate(query.to) } }
          : {}),
    };

    const records = await prisma.inventoryRecord.findMany({
      where,
      include: { ticketType: { include: { product: { select: { slug: true, translations: { where: { locale: 'en' }, take: 1 } } } } } },
      orderBy: [{ serviceDate: 'asc' }, { timeSlot: 'asc' }],
      take: 500,
    });

    return records.map((r) => ({
      id: r.id,
      ticketTypeId: r.ticketTypeId,
      ticketTypeName: r.ticketType.name,
      productName: r.ticketType.product.translations[0]?.name ?? r.ticketType.product.slug,
      productSlug: r.ticketType.product.slug,
      serviceDate: r.serviceDate,
      timeSlot: r.timeSlot,
      total: r.capacityTotal,
      held: r.capacityHeld,
      sold: r.capacitySold,
      available: Math.max(0, r.capacityTotal - r.capacityHeld - r.capacitySold),
      status: r.status,
      netPriceCents: r.netPriceCents,
    }));
  });

  // -------------------------------------------------------------------------
  // Orders & finance
  // -------------------------------------------------------------------------
  app.get('/admin/orders', staff, async (request) => {
    const query = z
      .object({
        status: z.nativeEnum(OrderStatus).optional(),
        q: z.string().max(200).optional(),
        page: z.coerce.number().int().min(1).optional(),
        pageSize: z.coerce.number().int().min(1).max(100).optional(),
      })
      .parse(request.query);

    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;

    const where = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.q
        ? {
            OR: [
              { orderNumber: { contains: query.q.toUpperCase(), mode: 'insensitive' as const } },
              { contactEmail: { contains: query.q, mode: 'insensitive' as const } },
            ],
          }
        : {}),
    };

    const [orders, total] = await Promise.all([
      prisma.order.findMany({
        where,
        orderBy: { placedAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: {
          items: { select: { productName: true, quantity: true } },
          _count: { select: { tickets: true } },
          user: { select: { email: true, firstName: true, lastName: true } },
        },
      }),
      prisma.order.count({ where }),
    ]);

    return {
      items: orders.map((order) => ({
        id: order.id,
        orderNumber: order.orderNumber,
        status: order.status,
        totalCents: order.totalCents,
        refundedCents: order.refundedCents,
        currency: order.currency,
        channel: order.channel,
        market: order.market,
        customer: order.user?.email ?? order.contactEmail,
        itemCount: order.items.length,
        units: order.items.reduce((sum, i) => sum + i.quantity, 0),
        ticketCount: order._count.tickets,
        placedAt: order.placedAt,
      })),
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
    };
  });

  /** Ledger view for finance reconciliation. */
  app.get('/admin/finance/ledger', staff, async (request) => {
    const query = z
      .object({
        from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        account: z.string().optional(),
        merchantId: z.string().optional(),
      })
      .parse(request.query);

    const entries = await prisma.ledgerEntry.findMany({
      where: {
        ...(query.merchantId ? { merchantId: query.merchantId } : {}),
        ...(query.account ? { account: query.account as never } : {}),
        ...(query.from || query.to
          ? {
              createdAt: {
                ...(query.from ? { gte: toServiceDate(query.from) } : {}),
                ...(query.to ? { lte: new Date(toServiceDate(query.to).getTime() + 86_400_000) } : {}),
              },
            }
          : {}),
      },
      include: { merchant: { select: { name: true, slug: true } }, order: { select: { orderNumber: true } } },
      orderBy: { createdAt: 'desc' },
      take: 300,
    });

    // Net by account for the selected period.
    const totals = await prisma.ledgerEntry.groupBy({
      by: ['account', 'direction'],
      _sum: { amountCents: true },
      where: {
        ...(query.merchantId ? { merchantId: query.merchantId } : {}),
        ...(query.account ? { account: query.account as never } : {}),
        ...(query.from || query.to
          ? {
              createdAt: {
                ...(query.from ? { gte: toServiceDate(query.from) } : {}),
                ...(query.to ? { lte: new Date(toServiceDate(query.to).getTime() + 86_400_000) } : {}),
              },
            }
          : {}),
      },
    });

    return {
      totals: totals.map((t) => ({
        account: t.account,
        direction: t.direction,
        amountCents: t._sum.amountCents ?? 0,
      })),
      entries: entries.map((entry) => ({
        id: entry.id,
        createdAt: entry.createdAt,
        account: entry.account,
        direction: entry.direction,
        amountCents: entry.amountCents,
        currency: entry.currency,
        description: entry.description,
        orderNumber: entry.order?.orderNumber ?? null,
        merchant: entry.merchant?.name ?? null,
      })),
    };
  });

  /** Generate merchant settlements from ledger entries in a period. */
  app.post('/admin/finance/settle', adminOnly, async (request) => {
    const body = z
      .object({ merchantId: z.string(), from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) })
      .parse(request.body);

    const from = toServiceDate(body.from);
    const to = new Date(toServiceDate(body.to).getTime() + 86_400_000);

    const [payable, refunds] = await Promise.all([
      prisma.ledgerEntry.aggregate({
        where: { merchantId: body.merchantId, account: 'MERCHANT_PAYABLE', direction: 'CREDIT', createdAt: { gte: from, lt: to } },
        _sum: { amountCents: true },
      }),
      prisma.ledgerEntry.aggregate({
        where: { merchantId: body.merchantId, account: 'REFUNDS', direction: 'DEBIT', createdAt: { gte: from, lt: to } },
        _sum: { amountCents: true },
      }),
    ]);

    const gross = payable._sum.amountCents ?? 0;
    const refundTotal = refunds._sum.amountCents ?? 0;
    const fee = Math.round(gross * 0.05);
    const net = gross - refundTotal - fee;

    const settlement = await prisma.settlement.create({
      data: {
        merchantId: body.merchantId,
        periodStart: from,
        periodEnd: toServiceDate(body.to),
        grossCents: gross,
        feeCents: fee,
        refundCents: refundTotal,
        netCents: net,
        status: 'PENDING',
      },
    });

    return settlement;
  });

  app.get('/admin/merchants', staff, async () => {
    const merchants = await prisma.merchant.findMany({
      include: {
        _count: { select: { products: true, settlements: true } },
        ledgerEntries: {
          where: { account: 'MERCHANT_PAYABLE' },
          select: { amountCents: true, direction: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    return merchants.map((m) => ({
      id: m.id,
      name: m.name,
      slug: m.slug,
      status: m.status,
      commissionBps: m.commissionBps,
      productCount: m._count.products,
      ratingAvg: m.ratingAvg,
      payableCents: m.ledgerEntries.reduce((sum, e) => sum + (e.direction === 'CREDIT' ? e.amountCents : -e.amountCents), 0),
      settlements: m._count.settlements,
    }));
  });

  // -------------------------------------------------------------------------
  // Review moderation
  // -------------------------------------------------------------------------
  app.get('/admin/reviews', staff, async (request) => {
    const query = z.object({ status: z.enum(['PENDING', 'PUBLISHED', 'REJECTED']).optional() }).parse(request.query);
    const reviews = await prisma.review.findMany({
      where: query.status ? { status: query.status } : {},
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: {
        product: { include: { translations: { where: { locale: 'en' }, take: 1 } } },
        user: { select: { email: true, firstName: true } },
        media: true,
      },
    });

    return reviews.map((review) => ({
      id: review.id,
      rating: review.rating,
      title: review.title,
      body: review.body,
      status: review.status,
      productName: review.product.translations[0]?.name ?? review.product.slug,
      productSlug: review.product.slug,
      author: review.user?.email ?? 'Anonymous',
      media: review.media.map((m) => m.url),
      createdAt: review.createdAt,
    }));
  });

  app.patch('/admin/reviews/:id', staff, async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const body = z
      .object({
        status: z.enum(['PENDING', 'PUBLISHED', 'REJECTED']).optional(),
        merchantReply: z.string().max(2000).optional(),
      })
      .parse(request.body);

    const review = await prisma.review.update({
      where: { id },
      data: {
        ...(body.status ? { status: body.status } : {}),
        ...(body.merchantReply ? { merchantReply: body.merchantReply, merchantRepliedAt: new Date() } : {}),
      },
      include: { product: { select: { id: true } } },
    });

    // Keep aggregates in sync after moderation.
    const stats = await prisma.review.aggregate({
      where: { productId: review.productId, status: 'PUBLISHED' },
      _avg: { rating: true },
      _count: { _all: true },
    });
    await prisma.product.update({
      where: { id: review.productId },
      data: { ratingAvg: Math.round((stats._avg.rating ?? 0) * 10) / 10, ratingCount: stats._count._all },
    });
    await indexProduct(review.productId);

    return { id: review.id, status: review.status };
  });

  // -------------------------------------------------------------------------
  // Coupons
  // -------------------------------------------------------------------------
  app.get('/admin/coupons', staff, async () => {
    const coupons = await prisma.coupon.findMany({
      orderBy: { createdAt: 'desc' },
      include: { _count: { select: { redemptions: true } } },
      take: 100,
    });
    return coupons.map((coupon) => ({
      id: coupon.id,
      code: coupon.code,
      description: coupon.description,
      discountType: coupon.discountType,
      discountValue: coupon.discountValue,
      usageLimit: coupon.usageLimit,
      usageCount: coupon.usageCount,
      endsAt: coupon.endsAt,
      active: coupon.active,
      redemptions: coupon._count.redemptions,
    }));
  });

  app.post('/admin/coupons', adminOnly, async (request, reply) => {
    const body = z
      .object({
        code: z.string().min(3).max(40).transform((c) => c.toUpperCase()),
        description: z.string().max(300).optional(),
        discountType: z.enum(['PERCENTAGE', 'FIXED_AMOUNT', 'FREE_SHIPPING', 'FREE_ENTRY']),
        discountValue: z.number().int().min(0),
        maxDiscountCents: z.number().int().min(0).optional(),
        minOrderCents: z.number().int().min(0).default(0),
        usageLimit: z.number().int().min(1).optional(),
        perUserLimit: z.number().int().min(1).default(1),
        endsAt: z.string().datetime().optional(),
      })
      .parse(request.body);

    const coupon = await prisma.coupon.create({
      data: {
        code: body.code,
        description: body.description ?? null,
        discountType: body.discountType,
        discountValue: body.discountValue,
        maxDiscountCents: body.maxDiscountCents ?? null,
        minOrderCents: body.minOrderCents,
        usageLimit: body.usageLimit ?? null,
        perUserLimit: body.perUserLimit,
        endsAt: body.endsAt ? new Date(body.endsAt) : null,
        createdById: request.user?.id,
      },
    });

    return reply.status(201).send(coupon);
  });

  // -------------------------------------------------------------------------
  // Maintenance
  // -------------------------------------------------------------------------
  app.post('/admin/search/reindex', adminOnly, async () => ({ indexed: await reindexAll() }));

  /** Seeds an operator account so the console is usable immediately. */
  app.post('/admin/bootstrap', adminOnly, async (request, reply) => {
    const body = z
      .object({
        email: z.string().email(),
        password: z.string().min(8),
        firstName: z.string().default('Ops'),
        lastName: z.string().default('Admin'),
      })
      .parse(request.body);

    const user = await prisma.user.create({
      data: {
        email: body.email.toLowerCase(),
        passwordHash: hashPassword(body.password),
        firstName: body.firstName,
        lastName: body.lastName,
        role: 'ADMIN',
      },
    });

    return reply.status(201).send({ id: user.id, email: user.email, role: user.role });
  });

  app.get('/admin/audit', staff, async () => {
    const logs = await prisma.auditLog.findMany({ orderBy: { createdAt: 'desc' }, take: 200 });
    return logs;
  });
}