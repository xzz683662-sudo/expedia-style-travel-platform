import { ReviewStatus } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { requireAuth } from '../plugins/auth';
import { AppError, assertFound } from '../utils/errors';

const PRODUCT_TYPES_LABEL: Record<string, string> = {
  ATTRACTION_TICKET: 'Attraction tickets',
  ACTIVITY: 'Activities',
  TOUR: 'Tours',
  DAY_TRIP: 'Day trips',
  PACKAGE: 'Packages',
  HOTEL_ROOM: 'Hotels',
  TRANSFER: 'Transfers',
  VEHICLE_RENTAL: 'Car rental',
  GUIDED_TOUR: 'Guided tours',
  RESTAURANT: 'Restaurants',
  CRUISE: 'Cruises',
  RENTAL_CAR: 'Car rental',
};

export async function socialRoutes(app: FastifyInstance): Promise<void> {
  // -------------------------------------------------------------------------
  // Reviews
  // -------------------------------------------------------------------------
  app.get('/products/:slug/reviews', async (request) => {
    const { slug } = z.object({ slug: z.string() }).parse(request.params);
    const query = z
      .object({
        page: z.coerce.number().int().min(1).optional(),
        pageSize: z.coerce.number().int().min(1).max(50).optional(),
        sort: z.enum(['RECENT', 'HIGHEST', 'LOWEST', 'MOST_HELPFUL']).optional(),
        minRating: z.coerce.number().int().min(1).max(5).optional(),
        withPhotos: z.coerce.boolean().optional(),
      })
      .parse(request.query);

    const product = assertFound(await prisma.product.findUnique({ where: { slug }, select: { id: true } }), 'Experience');

    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 10;

    const where = {
      productId: product.id,
      status: ReviewStatus.PUBLISHED,
      ...(query.minRating ? { rating: { gte: query.minRating } } : {}),
      ...(query.withPhotos ? { media: { some: {} } } : {}),
    };

    const orderBy =
      query.sort === 'HIGHEST'
        ? ({ rating: 'desc' } as const)
        : query.sort === 'LOWEST'
          ? ({ rating: 'asc' } as const)
          : query.sort === 'MOST_HELPFUL'
            ? ({ helpfulCount: 'desc' } as const)
            : ({ createdAt: 'desc' } as const);

    const [reviews, total, breakdown] = await Promise.all([
      prisma.review.findMany({
        where,
        orderBy,
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: {
          user: { select: { firstName: true, avatarUrl: true, countryCode: true, locale: true } },
          media: true,
        },
      }),
      prisma.review.count({ where }),
      prisma.ratingBreakdown.findMany({ where: { productId: product.id }, orderBy: { stars: 'desc' } }),
    ]);

    const totalRatings = breakdown.reduce((sum, r) => sum + r.count, 0);
    const stats = await prisma.product.findUnique({
      where: { id: product.id },
      select: { ratingAvg: true, ratingCount: true },
    });

    // Sentiment summary shown under the score ("92% of travelers would book again").
    const positive = breakdown.filter((b) => b.stars >= 4).reduce((sum, b) => sum + b.count, 0);

    return {
      summary: {
        average: stats?.ratingAvg ?? 0,
        total: stats?.ratingCount ?? 0,
        recommendedPercent: totalRatings ? Math.round((positive / totalRatings) * 100) : 0,
        breakdown: breakdown.map((b) => ({
          stars: b.stars,
          count: b.count,
          percent: totalRatings ? Math.round((b.count / totalRatings) * 100) : 0,
        })),
      },
      items: reviews.map((review) => ({
        id: review.id,
        rating: review.rating,
        title: review.title,
        body: review.body,
        locale: review.locale,
        helpfulCount: review.helpfulCount,
        merchantReply: review.merchantReply,
        visitedAt: review.visitedAt,
        createdAt: review.createdAt,
        verified: Boolean(review.orderId),
        author: review.user
          ? {
              name: `${review.user.firstName} ${review.user.firstName.charAt(0)}.`,
              avatarUrl: review.user.avatarUrl,
              countryCode: review.user.countryCode,
            }
          : { name: 'EasyTrip guest', avatarUrl: null, countryCode: null },
        media: review.media.map((m) => m.url),
      })),
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
    };
  });

  /** Only customers who actually travelled can review, one review per item. */
  app.post('/products/:slug/reviews', {}, async (request, reply) => {
    const { slug } = z.object({ slug: z.string() }).parse(request.params);
    const user = requireAuth(request);
    const body = z
      .object({
        rating: z.number().int().min(1).max(5),
        title: z.string().max(160).optional(),
        body: z.string().min(20, 'Tell other travelers a little more').max(4000),
        locale: z.string().optional(),
        orderId: z.string().optional(),
        mediaUrls: z.array(z.string().url()).max(8).optional(),
      })
      .parse(request.body);

    const product = assertFound(await prisma.product.findUnique({ where: { slug }, select: { id: true } }), 'Experience');

    // Verified purchase check when an order is referenced.
    if (body.orderId) {
      const ordered = await prisma.order.findFirst({
        where: { id: body.orderId, userId: user.id, items: { some: { productId: product.id } } },
        select: { id: true },
      });
      if (!ordered) throw AppError.forbidden('That order does not include this experience');
    }

    const existing = await prisma.review.findFirst({
      where: { productId: product.id, userId: user.id, ...(body.orderId ? { orderId: body.orderId } : {}) },
    });
    if (existing) throw AppError.conflict('You have already reviewed this experience');

    const review = await prisma.$transaction(async (tx) => {
      const created = await tx.review.create({
        data: {
          productId: product.id,
          userId: user.id,
          orderId: body.orderId ?? null,
          rating: body.rating,
          title: body.title ?? null,
          body: body.body,
          locale: body.locale ?? user.locale,
          media: body.mediaUrls?.length
            ? { create: body.mediaUrls.map((url, index) => ({ url, position: index })) }
            : undefined,
        },
      });

      // Recompute aggregates from scratch - incremental updates drift over time.
      const stats = await tx.review.aggregate({
        where: { productId: product.id, status: ReviewStatus.PUBLISHED },
        _avg: { rating: true },
        _count: { _all: true },
      });

      await tx.product.update({
        where: { id: product.id },
        data: { ratingAvg: Math.round((stats._avg.rating ?? 0) * 10) / 10, ratingCount: stats._count._all },
      });

      const grouped = await tx.review.groupBy({
        by: ['rating'],
        where: { productId: product.id, status: ReviewStatus.PUBLISHED },
        _count: { _all: true },
      });

      for (let stars = 1; stars <= 5; stars += 1) {
        const count = grouped.find((g) => g.rating === stars)?._count._all ?? 0;
        await tx.ratingBreakdown.upsert({
          where: { productId_stars: { productId: product.id, stars } },
          create: { productId: product.id, stars, count },
          update: { count },
        });
      }

      return created;
    });

    const { indexProduct } = await import('../modules/search/service.js');
    void indexProduct(product.id);

    return reply.status(201).send(review);
  });

  app.post('/reviews/:id/helpful', {}, async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const review = await prisma.review.update({ where: { id }, data: { helpfulCount: { increment: 1 } }, select: { id: true, helpfulCount: true } });
    return review;
  });

  // -------------------------------------------------------------------------
  // Wishlist
  // -------------------------------------------------------------------------
  app.post('/wishlist', {}, async (request) => {
    const user = requireAuth(request);
    const body = z.object({ productId: z.string(), serviceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }).parse(request.body);

    const item = await prisma.wishlistItem.upsert({
      where: { userId_productId: { userId: user.id, productId: body.productId } },
      create: { userId: user.id, productId: body.productId, serviceDate: body.serviceDate ? new Date(`${body.serviceDate}T00:00:00Z`) : null },
      update: body.serviceDate ? { serviceDate: new Date(`${body.serviceDate}T00:00:00Z`) } : {},
    });
    return item;
  });

  app.delete('/wishlist/:productId', {}, async (request) => {
    const user = requireAuth(request);
    const { productId } = z.object({ productId: z.string() }).parse(request.params);
    await prisma.wishlistItem.deleteMany({ where: { userId: user.id, productId } });
    return { removed: true };
  });

  app.get('/wishlist', {}, async (request) => {
    const user = requireAuth(request);
    const items = await prisma.wishlistItem.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: 'desc' },
      include: { product: { include: { media: { take: 1 }, translations: { take: 1 } } } },
    });
    return items.map((item) => ({
      productId: item.productId,
      slug: item.product.slug,
      title: item.product.translations[0]?.name ?? item.product.slug,
      imageUrl: item.product.media[0]?.url ?? null,
      serviceDate: item.serviceDate?.toISOString().slice(0, 10) ?? null,
      createdAt: item.createdAt,
    }));
  });
}