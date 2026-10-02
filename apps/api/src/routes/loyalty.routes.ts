import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { requireAuth } from '../plugins/auth';
import { AppError, assertFound } from '../utils/errors';
import { toServiceDate } from '../utils/date';

const TIER_THRESHOLDS: { tier: 'MEMBER' | 'SILVER' | 'GOLD' | 'PLATINUM'; points: number }[] = [
  { tier: 'PLATINUM', points: 50_000 },
  { tier: 'GOLD', points: 15_000 },
  { tier: 'SILVER', points: 3_000 },
];

export async function loyaltyRoutes(app: FastifyInstance): Promise<void> {
  /** Public programme terms, rendered on the marketing page. */
  app.get('/loyalty/program', async () => ({
    tiers: [
      { tier: 'MEMBER', threshold: 0, perks: ['Earn 1 point per $1', 'Member-only pricing', 'Free cancellation up to 24h'] },
      { tier: 'SILVER', threshold: 3_000, perks: ['Early access to flash sales', 'Free ticket changes', 'Priority support'] },
      { tier: 'GOLD', threshold: 15_000, perks: ['Room upgrades when available', 'Airport transfer credit', 'Late checkout'] },
      { tier: 'PLATINUM', threshold: 50_000, perks: ['Concierge booking desk', 'Guaranteed room availability', 'Annual travel credit'] },
    ],
    earnRate: '1 point per $1 spent',
    redeemRate: '100 points = $1 off',
  }));

  app.get('/loyalty/account', {}, async (request) => {
    const user = requireAuth(request);

    const account = await prisma.loyaltyAccount.findUnique({
      where: { userId: user.id },
      include: { transactions: { orderBy: { createdAt: 'desc' }, take: 50 } },
    });

    if (!account) {
      const created = await prisma.loyaltyAccount.create({ data: { userId: user.id, tier: 'MEMBER' } });
      return { tier: created.tier, points: created.points, lifetimePoints: created.lifetimePoints, balanceValueCents: 0, nextTier: null, transactions: [] };
    }

    const next = [...TIER_THRESHOLDS].reverse().find((t) => t.points > account.lifetimePoints) ?? null;

    return {
      tier: account.tier,
      points: account.points,
      lifetimePoints: account.lifetimePoints,
      balanceValueCents: Math.floor(account.points / 100),
      nextTier: next
        ? { tier: next.tier, pointsNeeded: next.points - account.lifetimePoints, progress: Math.min(100, Math.round((account.lifetimePoints / next.points) * 100)) }
        : null,
      transactions: account.transactions.map((t) => ({
        id: t.id,
        kind: t.kind,
        points: t.points,
        note: t.note,
        createdAt: t.createdAt,
      })),
    };
  });

  /** Redeem points against a pending order. */
  app.post('/loyalty/redeem', {}, async (request) => {
    const user = requireAuth(request);
    const body = z.object({ orderId: z.string(), points: z.number().int().min(100) }).parse(request.body);

    const [account, order] = await Promise.all([
      assertFound(await prisma.loyaltyAccount.findUnique({ where: { userId: user.id } }), 'Loyalty account'),
      assertFound(await prisma.order.findUnique({ where: { id: body.orderId } }), 'Order'),
    ]);

    if (order.userId !== user.id) throw AppError.forbidden();
    if (order.status !== 'PENDING_PAYMENT') throw AppError.conflict('Points can only be applied before payment');
    if (account.points < body.points) throw AppError.validation('You do not have that many points');

    const creditCents = Math.floor(body.points / 100);
    if (creditCents > order.totalCents) {
      throw AppError.validation(`You can apply at most ${order.totalCents} points on this order`);
    }

    const result = await prisma.$transaction(async (tx) => {
      const updated = await tx.loyaltyAccount.update({
        where: { id: account.id },
        data: { points: { decrement: body.points } },
      });
      await tx.loyaltyTransaction.create({
        data: { accountId: account.id, orderId: order.id, kind: 'REDEEM', points: -body.points, balanceAfter: updated.points, note: 'Redeemed at checkout' },
      });
      await tx.order.update({
        where: { id: order.id },
        data: {
          pointsRedeemed: body.points,
          totalCents: order.totalCents - creditCents,
          discountCents: { increment: creditCents },
        },
      });
      return { creditCents, remainingPoints: updated.points };
    });

    return result;
  });
}

export async function itineraryRoutes(app: FastifyInstance): Promise<void> {
  app.get('/itineraries', {}, async (request) => {
    const user = requireAuth(request);
    const itineraries = await prisma.itinerary.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: 'desc' },
      include: { items: { orderBy: [{ day: 'asc' }, { position: 'asc' }] }, _count: { select: { items: true } } },
    });

    return itineraries.map((it) => ({
      id: it.id,
      name: it.name,
      destinationSummary: it.destinationSummary,
      startDate: it.startDate,
      endDate: it.endDate,
      totalCents: it.totalCents,
      itemCount: it._count.items,
      isPublic: it.isPublic,
      items: it.items.map((item) => ({
        id: item.id,
        orderId: item.orderId,
        productId: item.productId,
        day: item.day,
        position: item.position,
        title: item.title,
        notes: item.notes,
        costCents: item.costCents,
      })),
    }));
  });

  app.post('/itineraries', {}, async (request, reply) => {
    const user = requireAuth(request);
    const body = z
      .object({
        name: z.string().min(1).max(160),
        destinationSummary: z.string().max(300).optional(),
        startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      })
      .parse(request.body);

    if (body.startDate && body.endDate && body.endDate < body.startDate) {
      throw AppError.validation('The trip end date must be on or after its start date');
    }

    const itinerary = await prisma.itinerary.create({
      data: {
        userId: user.id,
        name: body.name,
        destinationSummary: body.destinationSummary ?? null,
        startDate: body.startDate ? toServiceDate(body.startDate) : null,
        endDate: body.endDate ? toServiceDate(body.endDate) : null,
        shareToken: undefined,
      },
    });

    return reply.status(201).send({ ...itinerary, itemCount: 0, items: [] });
  });

  /** Append a confirmed order to a trip plan - the "build my itinerary" flow. */
  app.post('/itineraries/:id/items', {}, async (request) => {
    const user = requireAuth(request);
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const body = z.object({ orderId: z.string(), day: z.number().int().min(1).max(30).optional(), notes: z.string().max(500).optional() }).parse(request.body);

    const itinerary = assertFound(await prisma.itinerary.findUnique({ where: { id } }), 'Itinerary');
    if (itinerary.userId !== user.id) throw AppError.forbidden();

    const order = assertFound(
      await prisma.order.findUnique({ where: { id: body.orderId }, include: { items: true } }),
      'Order',
    );
    if (order.userId !== user.id) throw AppError.forbidden();
    if (order.status !== 'CONFIRMED' && order.status !== 'COMPLETED') {
      throw AppError.conflict('Only confirmed bookings can be added to a trip plan');
    }
    const alreadyAdded = await prisma.itineraryItem.findFirst({
      where: { itineraryId: itinerary.id, orderId: order.id },
      select: { id: true },
    });
    if (alreadyAdded) throw AppError.conflict('This booking is already in the trip plan');

    const created = await prisma.$transaction(async (tx) => {
      const items = [];
      for (const [index, orderItem] of order.items.entries()) {
        const item = await tx.itineraryItem.create({
          data: {
            itineraryId: itinerary.id,
            orderId: order.id,
            productId: orderItem.productId,
            day: body.day ?? 1,
            position: index,
            title: orderItem.productName,
            notes: body.notes ?? null,
            costCents: orderItem.lineTotalCents,
          },
        });
        items.push(item);
      }
      await tx.itinerary.update({ where: { id: itinerary.id }, data: { totalCents: { increment: order.totalCents } } });
      return items;
    });

    return created;
  });
}