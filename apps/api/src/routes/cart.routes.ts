import { createHash, randomBytes } from 'node:crypto';
import { CartStatus, type Prisma } from '@prisma/client';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { createPendingOrder } from '../modules/booking/engine';
import { computeQuote } from '../modules/pricing/engine';
import { resolveLocale } from '../plugins/auth';
import { AppError, assertFound } from '../utils/errors';
import { toServiceDate } from '../utils/date';

const guestTokenHeader = 'x-cart-token';

function guestToken(request: FastifyRequest): string | undefined {
  const value = request.headers[guestTokenHeader];
  return typeof value === 'string' ? value : undefined;
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

type CartTicketType = Prisma.TicketTypeGetPayload<{
  include: { product: { include: { priceRules: true } }; priceRules: true };
}>;

function quoteUnitPrice(
  ticketType: CartTicketType,
  serviceDate: Date,
  quantity: number,
  timeSlot: string,
): number {
  const quote = computeQuote({
    basePriceCents: ticketType.basePriceCents,
    compareAtPriceCents: ticketType.compareAtCents,
    taxBps: ticketType.taxBps,
    feeBps: ticketType.feeBps,
    rules: [...ticketType.priceRules, ...ticketType.product.priceRules].map((rule) => ({
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
    context: { serviceDate, quoteDate: new Date(), quantity, timeSlot },
  });
  return quote.totalPerUnitCents;
}

async function lockOpenCart(tx: Prisma.TransactionClient, cartId: string) {
  const result = await tx.cart.updateMany({
    where: { id: cartId, status: CartStatus.OPEN },
    data: { updatedAt: new Date() },
  });
  if (result.count !== 1) throw AppError.conflict('This cart is no longer open');
  return assertFound(await tx.cart.findUnique({ where: { id: cartId } }), 'Open cart');
}

async function resolveCart(request: FastifyRequest, create = false) {
  const token = guestToken(request);
  if (request.user) {
    const userCart = await prisma.cart.findFirst({
      where: { userId: request.user.id, status: CartStatus.OPEN },
    });
    const guestCart = token
      ? await prisma.cart.findUnique({ where: { guestTokenHash: hashToken(token) }, include: { items: true } })
      : null;

    if (guestCart && guestCart.userId && guestCart.userId !== request.user.id) {
      throw AppError.forbidden('This cart belongs to another account');
    }
    if (guestCart && guestCart.userId === null && guestCart.status === CartStatus.OPEN) {
      if (userCart) {
        const userItemCount = await prisma.cartItem.count({ where: { cartId: userCart.id } });
        if (userCart.currency !== guestCart.currency && userItemCount > 0 && guestCart.items.length > 0) {
          throw AppError.conflict('Your saved cart uses a different currency from this account cart');
        }
        await prisma.$transaction(async (tx) => {
          for (const item of guestCart.items) {
            await tx.cartItem.create({
              data: {
                cartId: userCart.id,
                productId: item.productId,
                ticketTypeId: item.ticketTypeId,
                serviceDate: item.serviceDate,
                timeSlot: item.timeSlot,
                quantity: item.quantity,
                unitPriceCents: item.unitPriceCents,
                locale: item.locale,
              },
            });
          }
          await tx.cart.update({
            where: { id: guestCart.id },
            data: { status: CartStatus.ABANDONED },
          });
          if (userItemCount === 0 && guestCart.items.length > 0) {
            await tx.cart.update({
              where: { id: userCart.id },
              data: { currency: guestCart.currency },
            });
          }
        });
      } else {
        await prisma.cart.update({
          where: { id: guestCart.id },
          data: { userId: request.user.id, guestTokenHash: null },
        });
        return guestCart;
      }
    }

    if (userCart) return userCart;
    if (!create) throw AppError.notFound('Open cart');
    return prisma.cart.create({
      data: {
        userId: request.user.id,
        locale: resolveLocale(request),
      },
    });
  }

  if (token) {
    const cart = await prisma.cart.findUnique({ where: { guestTokenHash: hashToken(token) } });
    if (!cart || cart.status !== CartStatus.OPEN || cart.userId) {
      throw AppError.unauthenticated('Your shopping cart is no longer available');
    }
    return cart;
  }

  if (!create) throw AppError.unauthenticated('A cart token is required');
  const secret = randomBytes(32).toString('base64url');
  const cart = await prisma.cart.create({
    data: {
      guestTokenHash: hashToken(secret),
      locale: resolveLocale(request),
    },
  });
  return { ...cart, newGuestToken: secret };
}

async function cartPayload(cartId: string, locale: string) {
  const cart = await prisma.cart.findUnique({
    where: { id: cartId },
    include: {
      items: {
        orderBy: { createdAt: 'asc' },
        include: {
          product: { include: { translations: true, media: { orderBy: { position: 'asc' }, take: 1 } } },
          ticketType: { include: { translations: true } },
        },
      },
    },
  });
  if (!cart) throw AppError.notFound('Cart');

  const language = locale.split('-')[0]!.toLowerCase();
  return {
    id: cart.id,
    currency: cart.currency,
    status: cart.status,
    items: cart.items.map((item) => {
      const productTranslation =
        item.product.translations.find((entry) => entry.locale.split('-')[0]!.toLowerCase() === language) ??
        item.product.translations.find((entry) => entry.locale.toLowerCase().startsWith('en'));
      const ticketTranslation =
        item.ticketType.translations.find((entry) => entry.locale.split('-')[0]!.toLowerCase() === language) ??
        item.ticketType.translations.find((entry) => entry.locale.toLowerCase().startsWith('en'));
      return {
        id: item.id,
        productId: item.productId,
        slug: item.product.slug,
        productType: item.product.type,
        title: productTranslation?.name ?? item.product.slug,
        imageUrl: item.product.media[0]?.url ?? null,
        ticketTypeId: item.ticketTypeId,
        optionName: ticketTranslation?.name ?? item.ticketType.name,
        serviceDate: item.serviceDate.toISOString().slice(0, 10),
        timeSlot: item.timeSlot,
        quantity: item.quantity,
        minPerOrder: item.ticketType.minPerOrder,
        maxPerOrder: item.ticketType.maxPerOrder,
        unitPriceCents: item.unitPriceCents,
        currency: item.ticketType.currency,
        lineTotalCents: item.unitPriceCents * item.quantity,
      };
    }),
  };
}

export async function cartRoutes(app: FastifyInstance): Promise<void> {
  app.get('/cart', async (request) => {
    const cart = await resolveCart(request, true);
    const payload = await cartPayload(cart.id, resolveLocale(request));
    return { ...payload, guestToken: 'newGuestToken' in cart ? cart.newGuestToken : undefined };
  });

  app.post('/cart/items', async (request, reply) => {
    const cart = await resolveCart(request);
    const body = z
      .object({
        ticketTypeId: z.string().min(1),
        serviceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        timeSlot: z.string().max(10).nullish(),
        quantity: z.number().int().min(1).max(20),
      })
      .parse(request.body);

    const ticketType = await prisma.ticketType.findFirst({
      where: { id: body.ticketTypeId, active: true },
      include: {
        product: { include: { priceRules: { where: { active: true } } } },
        priceRules: { where: { active: true } },
      },
    });
    if (!ticketType || ticketType.product.status !== 'PUBLISHED') {
      throw AppError.notFound('Bookable product option');
    }
    if (body.quantity < ticketType.minPerOrder || body.quantity > ticketType.maxPerOrder) {
      throw AppError.validation(
        `Quantity must be between ${ticketType.minPerOrder} and ${ticketType.maxPerOrder}`,
      );
    }
    const serviceDate = toServiceDate(body.serviceDate);
    if (serviceDate.getTime() < toServiceDate(new Date()).getTime()) {
      throw AppError.validation('Service date cannot be in the past');
    }
    await prisma.$transaction(async (tx) => {
      const openCart = await lockOpenCart(tx, cart.id);
      const itemCount = await tx.cartItem.count({ where: { cartId: cart.id } });
      if (ticketType.currency !== openCart.currency && itemCount > 0) {
        throw AppError.validation('A cart can contain products in one currency only');
      }
      if (itemCount === 0 && ticketType.currency !== openCart.currency) {
        await tx.cart.update({ where: { id: cart.id }, data: { currency: ticketType.currency } });
      }
      await tx.cartItem.create({
        data: {
          cartId: cart.id,
          productId: ticketType.productId,
          ticketTypeId: ticketType.id,
          serviceDate,
          timeSlot: body.timeSlot ?? null,
          quantity: body.quantity,
          unitPriceCents: quoteUnitPrice(ticketType, serviceDate, body.quantity, body.timeSlot ?? ''),
          locale: resolveLocale(request),
        },
      });
    });

    const payload = await cartPayload(cart.id, resolveLocale(request));
    return reply.status(201).send(payload);
  });

  app.patch('/cart/items/:id', async (request) => {
    const cart = await resolveCart(request);
    const { id } = z.object({ id: z.string().min(1) }).parse(request.params);
    const { quantity } = z.object({ quantity: z.number().int().min(1).max(20) }).parse(request.body);
    await prisma.$transaction(async (tx) => {
      await lockOpenCart(tx, cart.id);
      const item = await tx.cartItem.findFirst({
        where: { id, cartId: cart.id },
        include: {
          ticketType: {
            include: {
              product: { include: { priceRules: { where: { active: true } } } },
              priceRules: { where: { active: true } },
            },
          },
        },
      });
      if (!item) throw AppError.notFound('Cart item');
      if (quantity < item.ticketType.minPerOrder || quantity > item.ticketType.maxPerOrder) {
        throw AppError.validation(
          `Quantity must be between ${item.ticketType.minPerOrder} and ${item.ticketType.maxPerOrder}`,
        );
      }
      const serviceDate = toServiceDate(item.serviceDate);
      const unitPriceCents = quoteUnitPrice(item.ticketType, serviceDate, quantity, item.timeSlot ?? '');
      await tx.cartItem.update({ where: { id }, data: { quantity, unitPriceCents } });
    });
    return cartPayload(cart.id, resolveLocale(request));
  });

  app.delete('/cart/items/:id', async (request) => {
    const cart = await resolveCart(request);
    const { id } = z.object({ id: z.string().min(1) }).parse(request.params);
    await prisma.$transaction(async (tx) => {
      await lockOpenCart(tx, cart.id);
      const result = await tx.cartItem.deleteMany({ where: { id, cartId: cart.id } });
      if (result.count === 0) throw AppError.notFound('Cart item');
    });
    return cartPayload(cart.id, resolveLocale(request));
  });

  app.post('/cart/checkout', async (request) => {
    const cart = await resolveCart(request);
    const body = z
      .object({
        contactEmail: z.string().email(),
        contactPhone: z.string().max(40).optional(),
        customerNote: z.string().max(1000).optional(),
        couponCode: z.string().max(40).optional(),
        travelers: z
          .array(z.object({ fullName: z.string().min(1).max(160), email: z.string().email().optional() }))
          .optional(),
      })
      .parse(request.body);
    const claimed = await prisma.cart.updateMany({
      where: { id: cart.id, status: CartStatus.OPEN },
      data: { status: CartStatus.CHECKOUT },
    });
    if (claimed.count !== 1) throw AppError.conflict('This cart is already being checked out');

    let orderCreated = false;
    try {
      const items = await prisma.cartItem.findMany({
        where: { cartId: cart.id },
        include: { ticketType: { select: { currency: true } } },
        orderBy: { createdAt: 'asc' },
      });
      if (items.length === 0) throw AppError.validation('Your cart is empty');
      if (new Set(items.map((item) => item.ticketType.currency)).size > 1) {
        throw AppError.validation('A cart can contain products in one currency only');
      }
      const order = await createPendingOrder({
        userId: request.user?.id ?? null,
        lines: items.map((item) => ({
          ticketTypeId: item.ticketTypeId,
          serviceDate: item.serviceDate.toISOString().slice(0, 10),
          timeSlot: item.timeSlot,
          quantity: item.quantity,
        })),
        contactEmail: body.contactEmail,
        contactPhone: body.contactPhone,
        customerNote: body.customerNote,
        couponCode: body.couponCode ?? cart.promoCode ?? undefined,
        travelers: body.travelers,
        locale: resolveLocale(request),
      });
      orderCreated = true;
      await prisma.cart.update({ where: { id: cart.id }, data: { status: CartStatus.CONVERTED } });
      return order;
    } catch (error) {
      if (!orderCreated) {
        await prisma.cart.update({ where: { id: cart.id }, data: { status: CartStatus.OPEN } });
      }
      throw error;
    }
  });
}
