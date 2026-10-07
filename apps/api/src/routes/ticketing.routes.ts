import { TicketStatus } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { requireRole } from '../plugins/auth';
import { completeOrderIfFullyRedeemed } from '../modules/booking/engine';
import { AppError, assertFound } from '../utils/errors';
import { generateToken } from '../utils/ids';
import { toServiceDate } from '../utils/date';

export async function ticketingRoutes(app: FastifyInstance): Promise<void> {
  // -------------------------------------------------------------------------
  // Customer-facing
  // -------------------------------------------------------------------------
  app.get('/tickets', {}, async (request) => {
    const user = requireRoleFromRequest(request);
    const query = z
      .object({
        status: z.nativeEnum(TicketStatus).optional(),
        upcomingOnly: z.coerce.boolean().optional(),
      })
      .parse(request.query);

    const tickets = await prisma.ticket.findMany({
      where: {
        order: { userId: user.id },
        ...(query.status ? { status: query.status } : {}),
        ...(query.upcomingOnly ? { validFrom: { gte: toServiceDate(new Date()) } } : {}),
      },
      orderBy: { validFrom: 'asc' },
      include: { order: { select: { orderNumber: true, status: true } }, items: true },
    });

    return tickets.map((ticket) => ({
      id: ticket.id,
      ticketNumber: ticket.ticketNumber,
      orderNumber: ticket.order?.orderNumber,
      productName: ticket.productName,
      destinationName: ticket.destinationName,
      status: ticket.status,
      serviceDate: ticket.serviceDate,
      timeSlot: ticket.timeSlot,
      holderName: ticket.holderName,
      qrImageUrl: ticket.qrImageUrl,
      pdfUrl: ticket.pdfUrl,
      items: ticket.items.map((i) => ({ name: i.name, status: i.status })),
    }));
  });

  app.get('/tickets/:ticketNumber', {}, async (request) => {
    const { ticketNumber } = z.object({ ticketNumber: z.string() }).parse(request.params);
    const user = request.user;

    const ticket = await prisma.ticket.findUnique({
      where: { ticketNumber: ticketNumber.toUpperCase() },
      include: { order: true, items: true, scans: { orderBy: { scannedAt: 'desc' } } },
    });
    if (!ticket) throw AppError.notFound('Ticket');

    const isOwner = user && ticket.order?.userId === user.id;
    const isStaff = user && ['ADMIN', 'OPERATOR'].includes(user.role);
    if (!isOwner && !isStaff) throw AppError.forbidden();

    return {
      id: ticket.id,
      ticketNumber: ticket.ticketNumber,
      orderNumber: ticket.order?.orderNumber,
      productName: ticket.productName,
      productSlug: ticket.productSlug,
      destinationName: ticket.destinationName,
      holderName: ticket.holderName,
      status: ticket.status,
      qrPayload: ticket.qrPayload,
      qrImageUrl: ticket.qrImageUrl,
      pdfUrl: ticket.pdfUrl,
      barcode: ticket.barcode,
      serviceDate: ticket.serviceDate,
      timeSlot: ticket.timeSlot,
      validFrom: ticket.validFrom,
      validTo: ticket.validTo,
      scans: ticket.scans.map((s) => ({ scannedAt: s.scannedAt, gateName: s.gateName, result: s.result, note: s.note })),
      items: ticket.items.map((i) => ({ id: i.id, name: i.name, holderName: i.holderName, status: i.status, redeemedQty: i.redeemedQty })),
    };
  });

  /** Guest re-download by order number + email, mirroring the OTA "lost ticket" flow. */
  app.post('/tickets/recover', {}, async (request) => {
    const body = z
      .object({ orderNumber: z.string().min(4), email: z.string().email() })
      .parse(request.body);

    const order = await prisma.order.findFirst({
      where: { orderNumber: body.orderNumber.toUpperCase(), contactEmail: body.email.toLowerCase() },
      include: { tickets: true },
    });
    if (!order || order.tickets.length === 0) {
      throw AppError.notFound('Tickets for that order number');
    }

    return {
      orderNumber: order.orderNumber,
      tickets: order.tickets.map((t) => ({
        ticketNumber: t.ticketNumber,
        pdfUrl: t.pdfUrl,
        qrImageUrl: t.qrImageUrl,
        productName: t.productName,
      })),
    };
  });

  /** Nominate a new holder before the service date (name change / gift). */
  app.post('/tickets/:ticketNumber/transfer', {}, async (request) => {
    const { ticketNumber } = z.object({ ticketNumber: z.string() }).parse(request.params);
    const body = z.object({ toEmail: z.string().email(), fromEmail: z.string().email() }).parse(request.body);
    const user = requireRoleFromRequest(request);

    const ticket = assertFound(
      await prisma.ticket.findUnique({ where: { ticketNumber: ticketNumber.toUpperCase() }, include: { order: true, items: true } }),
      'Ticket',
    );
    if (ticket.order?.userId !== user.id) throw AppError.forbidden();
    if (ticket.status !== TicketStatus.ISSUED) {
      throw AppError.conflict('Only unused tickets can be transferred');
    }
    if (ticket.serviceDate.getTime() < toServiceDate(new Date()).getTime()) {
      throw AppError.conflict('Tickets cannot be transferred after the service date');
    }

    const token = generateToken(20);
    await prisma.ticketTransfer.create({
      data: {
        ticketId: ticket.id,
        fromEmail: body.fromEmail.toLowerCase(),
        toEmail: body.toEmail.toLowerCase(),
        token,
        expiresAt: new Date(Date.now() + 48 * 3_600_000),
      },
    });

    return { token, expiresInHours: 48, message: `Transfer invite sent to ${body.toEmail}` };
  });

  app.post('/tickets/transfer/:token/accept', {}, async (request) => {
    const { token } = z.object({ token: z.string() }).parse(request.params);
    const body = z.object({ fullName: z.string().min(1).max(160) }).parse(request.body);

    const transfer = await prisma.ticketTransfer.findUnique({ where: { token } });
    if (!transfer) throw AppError.notFound('Transfer');
    if (transfer.status !== 'PENDING') throw AppError.conflict('This transfer was already used');
    if (transfer.expiresAt.getTime() < Date.now()) throw AppError.conflict('This transfer link has expired');

    await prisma.$transaction(async (tx) => {
      await tx.ticket.update({
        where: { id: transfer.ticketId },
        data: { holderName: body.fullName, holderEmail: transfer.toEmail },
      });
      await tx.ticketItem.updateMany({
        where: { ticketId: transfer.ticketId },
        data: { holderName: body.fullName },
      });
      await tx.ticketTransfer.update({
        where: { id: transfer.id },
        data: { status: 'ACCEPTED', acceptedAt: new Date() },
      });
    });

    return { transferred: true, holderName: body.fullName };
  });

  // -------------------------------------------------------------------------
  // Gate / operator endpoints (staff auth)
  // -------------------------------------------------------------------------
  app.post('/scan/verify', { preHandler: [requireRole('ADMIN')] }, async (request) => {
    const body = z
      .object({
        code: z.string().min(4, 'Scan a QR or type the ticket number'),
        gate: z.string().max(120).optional(),
        deviceId: z.string().max(120).optional(),
        /** Scan only checks validity; redeem actually consumes the ticket. */
        commit: z.boolean().default(false),
      })
      .parse(request.body);

    const raw = body.code.trim();
    const ticketNumber = raw.startsWith('EASYTRIP1.')
      ? decodeQrPayload(raw).ticketNumber
      : raw.toUpperCase().replace(/^TKT-/, 'TKT-');

    const ticket = await prisma.ticket.findFirst({
      where: {
        OR: [{ ticketNumber: ticketNumber.toUpperCase() }, { barcode: raw.split('|').pop() ?? raw }],
      },
      include: { order: true, items: true },
    });

    if (!ticket) {
      await prisma.verificationLog.create({ data: { ticketNumber: raw, result: 'INVALID' } });
      return { valid: false, result: 'INVALID', message: 'Ticket not found' };
    }

    const today = toServiceDate(new Date());
    const serviceDate = toServiceDate(ticket.serviceDate);

    let result = 'VALID';
    let message = 'Ticket is valid';

    if (ticket.status === TicketStatus.VOID) {
      result = 'VOID';
      message = 'This ticket was cancelled or refunded';
    } else if (ticket.status === TicketStatus.REDEEMED) {
      result = 'ALREADY_USED';
      message = 'This ticket has already been used';
    } else if (ticket.status === TicketStatus.EXPIRED) {
      result = 'EXPIRED';
      message = 'This ticket has expired';
    } else if (serviceDate.getTime() < today.getTime()) {
      result = 'WRONG_DATE';
      message = `Valid for ${ticket.serviceDate.toISOString().slice(0, 10)}`;
    } else if (ticket.order?.status === 'CANCELLED' || ticket.order?.status === 'REFUNDED') {
      result = 'VOID';
      message = 'The order behind this ticket was cancelled';
    }

    if (body.commit && result === 'VALID') {
      const pending = ticket.items.filter((item) => item.redeemedQty < 1);
      if (pending.length === 0) {
        result = 'ALREADY_USED';
        message = 'All seats on this ticket are already redeemed';
      } else {
        for (const item of pending) {
          await prisma.ticketItem.update({ where: { id: item.id }, data: { redeemedQty: 1, status: TicketStatus.REDEEMED } });
          await prisma.ticketScan.create({
            data: {
              ticketId: ticket.id,
              ticketItemId: item.id,
              gateName: body.gate ?? null,
              deviceId: body.deviceId ?? null,
              result: 'VALID',
              operatorId: request.user?.id,
            },
          });
        }
        await prisma.ticket.update({ where: { id: ticket.id }, data: { status: TicketStatus.REDEEMED } });
        message = `Admitted: ${pending.length} guest${pending.length === 1 ? '' : 's'}`;
        await completeOrderIfFullyRedeemed(ticket.orderId);
      }
    }

    await prisma.verificationLog.create({
      data: { ticketNumber: ticket.ticketNumber, ticketId: ticket.id, result, scannedBy: request.user?.id },
    });

    return {
      valid: result === 'VALID',
      result,
      message,
      ticket: {
        ticketNumber: ticket.ticketNumber,
        productName: ticket.productName,
        holderName: ticket.holderName,
        serviceDate: ticket.serviceDate,
        timeSlot: ticket.timeSlot,
        destinationName: ticket.destinationName,
        partySize: ticket.items.length,
        redeemedSeats: ticket.items.filter((i) => i.redeemedQty > 0).length,
      },
    };
  });

  /** A dedicated redemption endpoint for hardware scanners. */
  app.post('/scan/redeem', { preHandler: [requireRole('ADMIN')] }, async (request) => {
    const body = z
      .object({ code: z.string().min(4), gate: z.string().max(120).optional(), deviceId: z.string().max(120).optional() })
      .parse(request.body);

    return app.inject({
      method: 'POST',
      url: '/scan/verify',
      headers: request.headers as Record<string, string>,
      payload: { ...body, commit: true },
    }).then((res) => res.json());
  });

  /** Today's admissions for a gate/operator dashboard. */
  app.get('/scan/stats', { preHandler: [requireRole('ADMIN')] }, async (request) => {
    const query = z.object({ gate: z.string().max(120).optional() }).parse(request.query);
    const today = toServiceDate(new Date());
    const dayStart = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
    const dayEnd = new Date(dayStart.getTime() + 86_400_000);

    const [total, admitted, recent] = await Promise.all([
      prisma.ticket.count({ where: { serviceDate: today } }),
      prisma.ticketScan.count({ where: { scannedAt: { gte: dayStart, lt: dayEnd }, result: 'VALID', ...(query.gate ? { gateName: query.gate } : {}) } }),
      prisma.ticketScan.findMany({
        where: { scannedAt: { gte: dayStart, lt: dayEnd }, ...(query.gate ? { gateName: query.gate } : {}) },
        include: { ticket: { select: { ticketNumber: true, productName: true, holderName: true } } },
        orderBy: { scannedAt: 'desc' },
        take: 25,
      }),
    ]);

    return {
      date: today.toISOString().slice(0, 10),
      gate: query.gate ?? null,
      ticketsToday: total,
      admitted,
      noShowRate: total ? Math.round(((total - admitted) / total) * 100) : 0,
      recent: recent.map((s) => ({
        scannedAt: s.scannedAt,
        gateName: s.gateName,
        result: s.result,
        ticketNumber: s.ticket?.ticketNumber,
        productName: s.ticket?.productName,
        holderName: s.ticket?.holderName,
      })),
    };
  });
}

function requireRoleFromRequest(request: { user?: { id: string; role: string } }) {
  if (!request.user) throw AppError.unauthenticated();
  return request.user;
}

/** Extracts the ticket number from a signed QR payload. */
function decodeQrPayload(payload: string): { ticketNumber: string } {
  try {
    const body = payload.replace('EASYTRIP1.', '');
    const parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as { t?: string };
    return { ticketNumber: parsed.t ?? '' };
  } catch {
    throw AppError.badRequest('Unreadable QR code');
  }
}