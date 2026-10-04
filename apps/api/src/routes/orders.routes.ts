import { OrderStatus, PaymentChannel } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { requireAuth } from '../plugins/auth';
import { cancelOrder, confirmPaidOrder, createPendingOrder, initiatePayment, quoteCancellation } from '../modules/booking/engine';
import { AppError, assertFound } from '../utils/errors';

const checkoutSchema = z.object({
  lines: z
    .array(
      z.object({
        ticketTypeId: z.string().min(1),
        serviceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        timeSlot: z.string().max(10).nullish(),
        quantity: z.number().int().min(1).max(20),
      }),
    )
    .min(1, 'Add at least one experience'),
  contactEmail: z.string().email(),
  contactPhone: z.string().max(40).optional(),
  customerNote: z.string().max(1000).optional(),
  couponCode: z.string().max(40).optional(),
  addOns: z.array(z.object({ addOnId: z.string(), quantity: z.number().int().min(1).max(10) })).optional(),
  travelers: z
    .array(z.object({ fullName: z.string().min(1).max(160), email: z.string().email().optional(), isLead: z.boolean().optional() }))
    .optional(),
  channel: z.enum(['WEB', 'MOBILE', 'MINI_PROGRAM', 'PARTNER_API']).optional(),
  locale: z.string().optional(),
  market: z.string().optional(),
  utmSource: z.string().max(80).optional(),
  utmCampaign: z.string().max(80).optional(),
  /** Optional: pay immediately with an offline method (voucher/bank). */
  offlinePayment: z.object({ method: z.enum(['VOUCHER', 'BANK_TRANSFER', 'CASH_ON_SITE']) }).optional(),
});

export async function orderRoutes(app: FastifyInstance): Promise<void> {
  // -------------------------------------------------------------------------
  // Checkout
  // -------------------------------------------------------------------------
  app.post('/orders', {}, async (request, reply) => {
    const user = request.user;
    const body = checkoutSchema.parse(request.body);

    const result = await createPendingOrder({
      userId: user?.id ?? null,
      lines: body.lines,
      contactEmail: body.contactEmail,
      contactPhone: body.contactPhone,
      customerNote: body.customerNote,
      couponCode: body.couponCode,
      channel: body.channel,
      locale: body.locale,
      market: body.market,
      utmSource: body.utmSource,
      utmCampaign: body.utmCampaign,
      travelers: body.travelers,
      addOns: body.addOns,
    });

    if (body.offlinePayment) {
      await initiatePayment({
        orderId: result.orderId,
        method: body.offlinePayment.method as PaymentChannel,
        idempotencyKey: `offline_${result.orderId}`,
      });
      await confirmPaidOrder(result.orderId);
      const refreshed = assertFound(await prisma.order.findUnique({ where: { id: result.orderId } }), 'Order');
      return reply.status(201).send({
        ...result,
        status: refreshed.status,
        tickets: await prisma.ticket.findMany({ where: { orderId: refreshed.id }, select: { ticketNumber: true } }),
      });
    }

    return reply.status(201).send(result);
  });

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------
  app.get('/orders', {}, async (request) => {
    const user = requireAuth(request);
    const query = z
      .object({
        status: z.nativeEnum(OrderStatus).optional(),
        page: z.coerce.number().int().min(1).optional(),
        pageSize: z.coerce.number().int().min(1).max(50).optional(),
      })
      .parse(request.query);

    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 10;

    const [orders, total] = await Promise.all([
      prisma.order.findMany({
        where: { userId: user.id, ...(query.status ? { status: query.status } : {}) },
        orderBy: { placedAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: {
          items: {
            select: {
              productName: true,
              productSlug: true,
              thumbnailUrl: true,
              serviceDate: true,
              quantity: true,
              timeSlot: true,
              // Stay lines need their range in the list view too, otherwise
              // "My bookings" shows one ambiguous date for a multi-night stay.
              checkInDate: true,
              checkOutDate: true,
              nights: true,
            },
          },
          tickets: { select: { id: true, ticketNumber: true, status: true } },
        },
      }),
      prisma.order.count({ where: { userId: user.id, ...(query.status ? { status: query.status } : {}) } }),
    ]);

    return {
      items: orders.map((order) => ({
        id: order.id,
        orderNumber: order.orderNumber,
        status: order.status,
        currency: order.currency,
        totalCents: order.totalCents,
        placedAt: order.placedAt,
        items: order.items,
        ticketCount: order.tickets.length,
      })),
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
    };
  });

  /** Guest order lookup by number + email - the standard OTA "manage booking". */
  app.get('/orders/lookup', {}, async (request) => {
    const query = z
      .object({ orderNumber: z.string().min(4), email: z.string().email() })
      .parse(request.query);

    const order = await prisma.order.findFirst({
      where: { orderNumber: query.orderNumber.toUpperCase(), contactEmail: query.email.toLowerCase() },
      select: { id: true },
    });
    if (!order) throw AppError.notFound('Order');
    if (!request.user || request.user.role !== 'ADMIN') {
      // Allow the guest to see the detail via a short-lived lookup token.
      return { orderId: order.id, requireAuth: true };
    }
    return { orderId: order.id, requireAuth: false };
  });

  app.get('/orders/:id', {}, async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const user = request.user;

    const order = assertFound(await prisma.order.findUnique({ where: { id }, include: orderInclude }), 'Order');

    const isOwner = user && order.userId === user.id;
    const isStaff = user && ['ADMIN', 'OPERATOR'].includes(user.role);
    if (!isOwner && !isStaff) {
      throw AppError.forbidden('This order belongs to another account');
    }

    return serializeOrder(order);
  });

  // -------------------------------------------------------------------------
  // Cancellation / refund
  // -------------------------------------------------------------------------
  app.get('/orders/:id/cancellation-quote', {}, async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const user = requireAuth(request);

    const order = assertFound(await prisma.order.findUnique({ where: { id }, select: { userId: true } }), 'Order');
    if (order.userId !== user.id && user.role !== 'ADMIN') throw AppError.forbidden();

    return quoteCancellation(id);
  });

  app.post('/orders/:id/cancel', {}, async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const body = z.object({ reason: z.string().max(300).optional(), refundCents: z.number().int().min(0).optional() }).parse(request.body ?? {});
    const user = request.user;

    return cancelOrder({
      orderId: id,
      userId: user?.id ?? null,
      reason: body.reason,
      refundCents: body.refundCents,
    });
  });

  // -------------------------------------------------------------------------
  // Payment
  // -------------------------------------------------------------------------
  app.post('/orders/:id/pay', {}, async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const body = z
      .object({
        method: z.nativeEnum(PaymentChannel).default(PaymentChannel.CARD),
        idempotencyKey: z.string().min(8).max(120),
        card: z
          .object({
            number: z.string().min(12).max(25),
            expMonth: z.number().int().min(1).max(12),
            expYear: z.number().int().min(2024).max(2060),
            cvc: z.string().min(3).max(4),
            holderName: z.string().max(120).optional(),
          })
          .optional(),
      })
      .parse(request.body);

    // `initiatePayment` fulfils the order itself when the gateway captures
    // synchronously; asynchronous flows are completed by the webhook.
    return initiatePayment({
      orderId: id,
      method: body.method,
      card: body.card,
      idempotencyKey: body.idempotencyKey,
    });
  });

  /** Public payment webhook (mock gateway posts here; Hyperswitch would too). */
  app.post('/webhooks/payment', async (request, reply) => {
    const event = request.body as {
      id: string;
      type: string;
      data: { object: { id: string; metadata?: { order_id?: string } } };
    };

    // Record the event once; duplicates are no-ops.
    const existing = await prisma.paymentEvent.findUnique({ where: { eventId: event.id } });
    if (existing) return reply.status(200).send({ received: true, duplicate: true });

    const orderId = event.data?.object?.metadata?.order_id;
    await prisma.paymentEvent.create({
      data: {
        provider: 'webhook',
        eventId: event.id,
        type: event.type,
        payload: JSON.parse(JSON.stringify(event)),
        processedAt: new Date(),
      },
    });

    if (orderId && ['payment_intent.succeeded', 'charge.succeeded'].includes(event.type)) {
      await confirmPaidOrder(orderId, event.data.object.id);
    }

    return reply.status(200).send({ received: true });
  });
}

const orderInclude = {
  items: { include: { ticketType: { include: { product: { include: { destination: true } } } } } },
  addOns: true,
  travelers: true,
  payments: true,
  refunds: true,
  tickets: { include: { items: true, scans: { orderBy: { scannedAt: 'desc' } } } },
  orderStatusLogs: { orderBy: { createdAt: 'asc' } },
  coupon: true,
} as const;

function serializeOrder(order: any) {
  return {
    id: order.id,
    orderNumber: order.orderNumber,
    status: order.status,
    currency: order.currency,
    channel: order.channel,
    locale: order.locale,
    contactEmail: order.contactEmail,
    contactPhone: order.contactPhone,
    customerNote: order.customerNote,
    totals: {
      subtotalCents: order.subtotalCents,
      discountCents: order.discountCents,
      taxCents: order.taxCents,
      feeCents: order.feeCents,
      markupCents: order.markupCents,
      totalCents: order.totalCents,
      refundedCents: order.refundedCents,
      pointsEarned: order.pointsEarned,
    },
    placedAt: order.placedAt,
    paidAt: order.paidAt,
    confirmedAt: order.confirmedAt,
    items: order.items.map((item: any) => ({
      id: item.id,
      productName: item.productName,
      productSlug: item.productSlug,
      productType: item.productType,
      thumbnailUrl: item.thumbnailUrl,
      ticketTypeName: item.ticketTypeName,
      serviceDate: item.serviceDate,
      timeSlot: item.timeSlot,
      // Stay snapshot. Null on single-date lines. Without these the order page
      // cannot render "3 nights, 2 Nov – 5 Nov" — the data is on the row but a
      // guest booking three nights would see a single date and no indication of
      // when they actually leave.
      checkInDate: item.checkInDate,
      checkOutDate: item.checkOutDate,
      nights: item.nights,
      roomTypeCode: item.roomTypeCode,
      nightlyPriceCents: item.nightlyPriceCents,
      quantity: item.quantity,
      unitPriceCents: item.unitPriceCents,
      lineTotalCents: item.lineTotalCents,
      refundedQty: item.refundedQty,
      destination: item.ticketType?.product?.destination?.name ?? null,
      meetingPoint: item.ticketType?.product?.meetingPoint ?? null,
    })),
    addOns: order.addOns,
    travelers: order.travelers,
    payments: order.payments.map((p: any) => ({
      id: p.id,
      method: p.method,
      status: p.status,
      amountCents: p.amountCents,
      cardBrand: p.cardBrand,
      cardLast4: p.cardLast4,
      createdAt: p.createdAt,
    })),
    refunds: order.refunds.map((r: any) => ({
      id: r.id,
      amountCents: r.amountCents,
      reason: r.reason,
      processedAt: r.processedAt,
    })),
    tickets: order.tickets.map((t: any) => ({
      id: t.id,
      ticketNumber: t.ticketNumber,
      productName: t.productName,
      status: t.status,
      qrPayload: t.qrPayload,
      qrImageUrl: t.qrImageUrl,
      pdfUrl: t.pdfUrl,
      barcode: t.barcode,
      serviceDate: t.serviceDate,
      timeSlot: t.timeSlot,
      destinationName: t.destinationName,
      holderName: t.holderName,
      scans: t.scans.map((s: any) => ({ scannedAt: s.scannedAt, gateName: s.gateName, result: s.result })),
      items: t.items.map((i: any) => ({ id: i.id, name: i.name, holderName: i.holderName, status: i.status, redeemedQty: i.redeemedQty })),
    })),
    timeline: order.orderStatusLogs.map((log: any) => ({
      from: log.fromStatus,
      to: log.toStatus,
      reason: log.reason,
      createdAt: log.createdAt,
    })),
  };
}