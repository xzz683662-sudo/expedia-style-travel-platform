import { OrderStatus, PaymentChannel, PaymentStatus, TicketStatus, type PriceRule, type Product, type TicketType } from '@prisma/client';
import { config } from '../../config/env';
import { logger } from '../../lib/logger';
import { prisma } from '../../lib/prisma';
import { differenceInDays, hoursBetween, toServiceDate } from '../../utils/date';
import { AppError, assertFound } from '../../utils/errors';
import { generateBarcode, generateOrderNumber, generateTicketNumber } from '../../utils/ids';
import { allocate, applyBps, sumCents } from '../../utils/money';
import { computeQuote, type Quote } from '../pricing/engine';
import { consumeHold, placeHold, placeStayHold, releaseHold, returnSoldUnits } from '../inventory/engine';
import { getPaymentGateway, isOfflineMethod } from '../payments/gateway';
import { createInAppNotification, emitOrderCreated, emitOrderEvent, emitPaymentEvent } from '../realtime/notify';
import { generateTicketArtifacts } from '../ticketing/issuer';

/**
 * ---------------------------------------------------------------------------
 * Booking engine
 * ---------------------------------------------------------------------------
 *
 * Owns the state machine that turns a cart into fulfilled tickets:
 *
 *   PENDING_PAYMENT --payment captured--> CONFIRMED --redeemed--> COMPLETED
 *          |                                  |
 *          +-- expired ------------------------+
 *          +-- cancelled --> (units returned)
 *
 *   CONFIRMED --refund (full/partial)--> REFUNDED / PARTIALLY_REFUNDED
 *
 * Every transition writes an `OrderStatusLog`, which doubles as the audit
 * trail a marketplace needs for dispute handling.
 */

export type CheckoutLine = {
  ticketTypeId: string;
  serviceDate: string;
  timeSlot?: string | null;
  quantity: number;
  holdToken?: string;
  /**
   * Stay range. Present only for multi-night products; a single-date line omits
   * both and behaves exactly as before. `serviceDate` must equal `checkInDate`
   * when both are set — it is kept in sync so date-only queries (calendar,
   * availability, order listings) do not need to learn about stays.
   */
  checkInDate?: string | null;
  checkOutDate?: string | null;
  roomTypeCode?: string | null;
};

export type CheckoutInput = {
  userId?: string | null;
  lines: CheckoutLine[];
  contactEmail: string;
  contactPhone?: string;
  customerNote?: string;
  couponCode?: string;
  promoCode?: string;
  channel?: string;
  locale?: string;
  market?: string;
  utmSource?: string;
  utmCampaign?: string;
  travelerProfiles?: {
    fullName: string;
    email?: string;
    isLead?: boolean;
  }[];
  /** Alias accepted by the HTTP layer. */
  travelers?: {
    fullName: string;
    email?: string;
    isLead?: boolean;
  }[];
  addOns?: { addOnId: string; quantity: number }[];
};

export type CheckoutResult = {
  orderId: string;
  orderNumber: string;
  status: OrderStatus;
  currency: string;
  totalCents: number;
  holds: { holdToken: string; expiresAt: string }[];
};

/**
 * Creates a pending order: re-prices every line server-side, places fresh
 * inventory holds, applies coupon/tax/mark-up, and persists the snapshot.
 *
 * Pricing is *always* recomputed here - the client is never trusted for money.
 */
export async function createPendingOrder(input: CheckoutInput): Promise<CheckoutResult> {
  if (input.lines.length === 0) throw AppError.badRequest('Your cart is empty');

  const orderNumber = generateOrderNumber();
  const locale = input.locale ?? config.site.defaultLocale;
  const market = input.market ?? config.site.defaultMarket;

  // --- 1. Load and validate every requested line ---------------------------
  const ticketTypeIds = input.lines.map((line) => line.ticketTypeId);
  const ticketTypes = await prisma.ticketType.findMany({
    where: { id: { in: ticketTypeIds }, active: true },
    include: {
      product: {
        include: {
          translations: { where: { locale } },
          media: { orderBy: { position: 'asc' }, take: 1 },
          merchant: { select: { id: true, commissionBps: true, status: true } },
          priceRules: { where: { active: true } },
        },
      },
      priceRules: { where: { active: true } },
    },
  });
  const ticketTypeById = new Map(ticketTypes.map((t) => [t.id, t]));

  type PricedLine = {
    line: CheckoutLine;
    ticketType: TicketType & {
      product: Product & {
        translations: { name: string }[];
        media: { url: string }[];
        merchant: { id: string; commissionBps: number; status: string } | null;
        priceRules: PriceRule[];
      };
      priceRules: PriceRule[];
    };
    serviceDate: Date;
    quote: Quote;
    /** Stay nights; 1 for every non-stay line. */
    nights: number;
    checkIn: Date;
    checkOut: Date;
    roomTypeCode: string | null;
  };

  const pricedLines: PricedLine[] = [];
  for (const line of input.lines) {
    const ticketType = ticketTypeById.get(line.ticketTypeId);
    if (!ticketType) throw AppError.notFound('Ticket option');
    if (ticketType.product.status !== 'PUBLISHED') {
      throw AppError.conflict('This experience is not currently on sale');
    }
    if (line.quantity < ticketType.minPerOrder || line.quantity > ticketType.maxPerOrder) {
      throw AppError.validation(
        `Quantity for ${ticketType.name} must be between ${ticketType.minPerOrder} and ${ticketType.maxPerOrder}`,
      );
    }

    const serviceDate = toServiceDate(line.serviceDate);
    if (serviceDate.getTime() < toServiceDate(new Date()).getTime()) {
      throw AppError.validation('Service date cannot be in the past');
    }

    // --- Stay lines: derive nights and enforce the property's length policy --
    // `nights` is what activates LENGTH_OF_STAY. Passing it unconditionally as 1
    // for non-stay lines keeps that rule kind inert on single-date products
    // instead of silently applying a "1 night" condition to an attraction ticket.
    const isStay = Boolean(line.checkInDate && line.checkOutDate);
    let nights = 1;
    let checkIn = serviceDate;
    let checkOut = serviceDate;

    if (isStay) {
      checkIn = toServiceDate(line.checkInDate as string);
      checkOut = toServiceDate(line.checkOutDate as string);
      if (checkOut.getTime() <= checkIn.getTime()) {
        throw AppError.validation('Check-out must be after check-in');
      }
      nights = differenceInDays(checkOut, checkIn);
      // A stay spanning a month is a data-entry error far more often than a real
      // booking. Cap it rather than letting one line try to hold 400 room-nights.
      if (nights > 30) {
        throw AppError.validation('Stays are limited to 30 nights');
      }
      const stay = await prisma.productStay.findUnique({
        where: { productId: ticketType.productId },
        select: { policies: true },
      });
      const policies = (stay?.policies ?? {}) as {
        minNights?: number | null;
        maxNights?: number | null;
      };
      // `policies` is a Json column and the backfill writes an explicit `null`
      // for every limit it could not derive, rather than omitting the key. So a
      // missing limit arrives as JSON null, which is `!== undefined` — guarding
      // on `!== undefined` alone reads "no maximum" as "maximum of null", which
      // then formats as 0 and rejects every stay. Treat null and undefined alike.
      const minNights = typeof policies.minNights === 'number' ? policies.minNights : null;
      const maxNights = typeof policies.maxNights === 'number' ? policies.maxNights : null;
      if (minNights !== null && nights < minNights) {
        throw AppError.validation(`This property requires a minimum stay of ${minNights} nights`);
      }
      if (maxNights !== null && nights > maxNights) {
        throw AppError.validation(`This property allows a maximum stay of ${maxNights} nights`);
      }
    }

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
      context: {
        serviceDate,
        quoteDate: new Date(),
        quantity: line.quantity,
        timeSlot: line.timeSlot ?? '',
        nights,
      },
    });

    pricedLines.push({ line, ticketType, serviceDate, quote, nights, checkIn, checkOut, roomTypeCode: line.roomTypeCode ?? null });
  }

  const currency = pricedLines[0].ticketType.currency || config.booking.defaultCurrency;

  // --- 2. Place inventory holds (fresh holds beat trusting client tokens) --
  const holds: { holdToken: string; expiresAt: string }[] = [];

  for (const priced of pricedLines) {
    try {
      // A stay claims the same room on every night, so it needs the multi-date
      // hold. Single-date lines keep the original path untouched.
      const hold =
        priced.nights > 1
          ? await placeStayHold({
              ticketTypeId: priced.ticketType.id,
              checkIn: priced.checkIn,
              checkOut: priced.checkOut,
              quantity: priced.line.quantity,
              userId: input.userId ?? null,
              roomTypeCode: priced.roomTypeCode,
            })
          : await placeHold({
              ticketTypeId: priced.ticketType.id,
              serviceDate: priced.serviceDate,
              timeSlot: priced.line.timeSlot ?? "",
              quantity: priced.line.quantity,
              userId: input.userId ?? null,
            });
      holds.push({ holdToken: hold.holdToken, expiresAt: hold.expiresAt.toISOString() });
    } catch (error) {
      // Roll back the holds we already took so we never leak capacity.
      await Promise.all(holds.map((h) => releaseHold(h.holdToken).catch(() => undefined)));
      throw error;
    }
  }

  try {
    // --- 3. Persist the order snapshot ------------------------------------
    // A stay line is priced per room per night, so its multiplier is
    // `nights * quantity`; a ticket line has nights = 1 and reduces to
    // `quantity`. Using one expression keeps the four totals consistent with each
    // other — they must all scale by the same factor or the ledger disagrees.
    const lineUnits = (p: PricedLine) => p.nights * p.line.quantity;

    const subtotal = sumCents(pricedLines.map((p) => p.quote.unitPriceCents * lineUnits(p)));
    const markupTotal = sumCents(pricedLines.map((p) => p.quote.markupCents * lineUnits(p)));

    // Coupons discount the pre-tax subtotal.
    const coupon = input.couponCode
      ? await validateCoupon(input.couponCode, subtotal, input.userId, pricedLines.map((p) => p.ticketType.product.type))
      : null;

    let discountTotal = coupon ? Math.min(coupon.discountCents, subtotal) : 0;

    // Promo codes are informational banners unless they carry a coupon.
    let addOnTotal = 0;
    const addOns: { id: string; name: string; quantity: number; unitPriceCents: number; totalCents: number }[] = [];
    if (input.addOns?.length) {
      const addOnRecords = await prisma.addOn.findMany({
        where: { id: { in: input.addOns.map((a) => a.addOnId) }, active: true },
      });
      for (const requested of input.addOns) {
        const addOn = addOnRecords.find((a) => a.id === requested.addOnId);
        if (!addOn) continue;
        const quantity = Math.min(Math.max(1, requested.quantity), addOn.maxPerOrder);
        const totalCents = addOn.priceCents * quantity;
        addOns.push({ id: addOn.id, name: addOn.name, quantity, unitPriceCents: addOn.priceCents, totalCents });
        addOnTotal += totalCents;
      }
    }

    const grossTotal = subtotal + addOnTotal;
    // Spread the coupon discount across lines proportionally so per-item
    // refunds stay exact. `allocate` returns one amount per weight, summing
    // back to the total so no cent is lost or invented.
    const discountPerLine = allocate(
      discountTotal,
      // Weight by the same `lineUnits` the subtotal uses. Weighting by
      // `quantity` alone made a coupon spread as if every line were one night,
      // so the per-line discount stopped summing to `discountTotal` against a
      // multi-night subtotal — and per-item refunds, which reuse this split,
      // would refund the wrong amounts.
      pricedLines.map((p) => p.quote.unitPriceCents * lineUnits(p)),
    );

    const lineTotals = pricedLines.map((pricedItem, index) => {
      const lineDiscount = discountPerLine[index] ?? 0;
      const quantity = pricedItem.line.quantity;
      // A stay is sold per room per night, so the line subtotal is
      // unit x rooms x nights. Omitting `nights` here charges a 3-night booking
      // for one night: the customer is quoted 616.00 x 3 in the cart and then
      // invoiced 616.00. `nights` is 1 for single-date lines, so this reduces to
      // the original quantity-only arithmetic.
      const unitsBilled = quantity * pricedItem.nights;
      const lineSubtotalAfterDiscount = pricedItem.quote.unitPriceCents * unitsBilled - lineDiscount;
      // Re-derive per-unit tax/fee on the discounted base so tax is never
      // collected on money the customer did not pay.
      const taxCents = Math.round(
        (pricedItem.quote.taxCents * lineSubtotalAfterDiscount) /
          (pricedItem.quote.totalPerUnitCents * unitsBilled || 1),
      );
      const feeCents = Math.round(
        (pricedItem.quote.feeCents * lineSubtotalAfterDiscount) /
          (pricedItem.quote.totalPerUnitCents * unitsBilled || 1),
      );
      const totalCents = lineSubtotalAfterDiscount + taxCents + feeCents;
      return { taxCents, feeCents, totalCents, lineDiscount };
    });

    const totalCents = sumCents(lineTotals.map((l) => l.totalCents)) + addOnTotal;
    const expiresAt = new Date(Date.now() + config.booking.checkoutTokenTtlMinutes * 60_000);

    const order = await prisma.$transaction(async (tx) => {
      const created = await tx.order.create({
        data: {
          orderNumber,
          userId: input.userId ?? null,
          status: OrderStatus.PENDING_PAYMENT,
          channel: input.channel ?? 'WEB',
          locale,
          market,
          currency,
          contactEmail: input.contactEmail,
          contactPhone: input.contactPhone ?? null,
          customerNote: input.customerNote ?? null,
          subtotalCents: grossTotal,
          discountCents: discountTotal,
          taxCents: sumCents(lineTotals.map((l) => l.taxCents)),
          feeCents: sumCents(lineTotals.map((l) => l.feeCents)),
          markupCents: markupTotal,
          totalCents,
          couponId: coupon?.couponId ?? null,
          utmSource: input.utmSource ?? null,
          utmCampaign: input.utmCampaign ?? null,
          expiresAt,
          items: {
            create: pricedLines.map((pricedItem, index) => {
              const translation = pricedItem.ticketType.product.translations[0];
              const quantity = pricedItem.line.quantity;
              const commissionBps = pricedItem.ticketType.product.merchant?.commissionBps ?? config.booking.platformFeeBps;
              const netAmount = applyBps(
                pricedItem.quote.unitPriceCents * quantity * pricedItem.nights - lineTotals[index].lineDiscount,
                commissionBps,
              );
              return {
                productId: pricedItem.ticketType.product.id,
                productName: translation?.name ?? pricedItem.ticketType.product.slug,
                productSlug: pricedItem.ticketType.product.slug,
                productType: pricedItem.ticketType.product.type,
                thumbnailUrl: pricedItem.ticketType.product.media[0]?.url ?? null,
                ticketTypeId: pricedItem.ticketType.id,
                ticketTypeName: pricedItem.ticketType.name,
                ticketTypeCode: pricedItem.ticketType.code,
                serviceDate: pricedItem.serviceDate,
                timeSlot: pricedItem.line.timeSlot ?? null,
                // Stay snapshot — all null for single-date lines.
                checkInDate: pricedItem.nights > 1 ? pricedItem.checkIn : null,
                checkOutDate: pricedItem.nights > 1 ? pricedItem.checkOut : null,
                nights: pricedItem.nights > 1 ? pricedItem.nights : null,
                roomTypeCode: pricedItem.roomTypeCode,
                nightlyPriceCents: pricedItem.nights > 1 ? pricedItem.quote.unitPriceCents : null,
                quantity,
                adultCount: quantity,
                baseUnitPriceCents: pricedItem.quote.basePriceCents,
                unitPriceCents: pricedItem.quote.unitPriceCents,
                compareAtUnitPriceCents: pricedItem.quote.compareAtPriceCents,
                ruleTrace: pricedItem.quote.appliedRules,
                taxBps: pricedItem.ticketType.taxBps,
                taxCents: lineTotals[index].taxCents,
                feeCents: lineTotals[index].feeCents,
                markupCents: pricedItem.quote.markupCents,
                lineTotalCents: lineTotals[index].totalCents,
                merchantId: pricedItem.ticketType.product.merchant?.id ?? null,
                merchantCommissionBps: commissionBps,
                netAmountCents: netAmount,
              };
            }),
          },
          addOns: { create: addOns.map((a) => ({ addOnId: a.id, name: a.name, quantity: a.quantity, unitPriceCents: a.unitPriceCents, totalCents: a.totalCents })) },
          travelers: {
            create: (input.travelerProfiles ?? input.travelers ?? [{ fullName: input.contactEmail.split('@')[0], isLead: true }]).map((t) => ({
              fullName: t.fullName,
              email: t.email ?? input.contactEmail,
              isLead: t.isLead ?? false,
            })),
          },
          orderStatusLogs: { create: { toStatus: OrderStatus.PENDING_PAYMENT, reason: 'checkout initiated' } },
        },
      });

      // Link the holds to the order so expiry can find them.
      await tx.inventoryHold.updateMany({
        where: { holdToken: { in: holds.map((h) => h.holdToken) } },
        data: { userId: input.userId ?? null },
      });

      if (coupon) {
        await tx.couponRedemption.create({
          data: { couponId: coupon.couponId, orderId: created.id, userId: input.userId ?? null, amountCents: discountTotal },
        });
        await tx.coupon.update({
          where: { id: coupon.couponId },
          data: { usageCount: { increment: 1 } },
        });
      }

      // Record the credit sale side of the ledger immediately; the payable to
      // the merchant is settled later by the finance job.
      await tx.ledgerEntry.createMany({
        data: [
          { orderId: created.id, account: 'GROSS_SALES', direction: 'CREDIT', amountCents: grossTotal, currency, description: 'Order gross', reference: created.orderNumber },
          ...(discountTotal > 0 ? [{ orderId: created.id, account: 'MARKETING_FEE' as const, direction: 'DEBIT' as const, amountCents: discountTotal, currency, description: 'Coupon discount', reference: created.orderNumber }] : []),
          { orderId: created.id, account: 'TAX_PAYABLE', direction: 'CREDIT', amountCents: sumCents(lineTotals.map((l) => l.taxCents)), currency, description: 'Tax collected', reference: created.orderNumber },
        ],
      });

      return created;
    });

    logger.info('booking.order_created', { orderNumber, totalCents, lines: pricedLines.length });

    // Realtime: the operator console watches checkouts start; the shopper's own
    // sessions pick this up as "cart submitted".
    emitOrderCreated({
      orderId: order.id,
      orderNumber: order.orderNumber,
      status: order.status,
      userId: input.userId ?? null,
      totalCents: order.totalCents,
      currency: order.currency,
      itemCount: pricedLines.length,
    });

    return {
      orderId: order.id,
      orderNumber: order.orderNumber,
      status: order.status,
      currency: order.currency,
      totalCents: order.totalCents,
      holds,
    };
  } catch (error) {
    await Promise.all(holds.map((h) => releaseHold(h.holdToken).catch(() => undefined)));
    throw error;
  }
}

async function validateCoupon(
  code: string,
  subtotalCents: number,
  userId: string | null | undefined,
  productTypes: string[],
): Promise<{ couponId: string; discountCents: number } | null> {
  const coupon = await prisma.coupon.findUnique({ where: { code: code.toUpperCase() } });
  if (!coupon || !coupon.active) throw AppError.validation('That promo code is not valid');

  const now = new Date();
  if (coupon.startsAt && coupon.startsAt.getTime() > now.getTime()) {
    throw AppError.validation('That promo code is not active yet');
  }
  if (coupon.endsAt && coupon.endsAt.getTime() < now.getTime()) {
    throw AppError.validation('That promo code has expired');
  }
  if (coupon.usageLimit !== null && coupon.usageCount >= coupon.usageLimit) {
    throw AppError.validation('That promo code has been fully redeemed');
  }
  if (subtotalCents < coupon.minOrderCents) {
    throw AppError.validation(`Spend at least ${(coupon.minOrderCents / 100).toFixed(2)} to use this code`);
  }
  if (coupon.appliesToTypes.length > 0 && !productTypes.some((t) => coupon.appliesToTypes.includes(t as never))) {
    throw AppError.validation('That promo code does not apply to these experiences');
  }
  if (userId && coupon.perUserLimit > 0) {
    const used = await prisma.couponRedemption.count({ where: { couponId: coupon.id, userId } });
    if (used >= coupon.perUserLimit) {
      throw AppError.validation('You have already used this promo code');
    }
  }

  let discountCents: number;
  if (coupon.discountType === 'PERCENTAGE') {
    const raw = applyBps(subtotalCents, coupon.discountValue);
    discountCents = coupon.maxDiscountCents ? Math.min(raw, coupon.maxDiscountCents) : raw;
  } else if (coupon.discountType === 'FIXED_AMOUNT') {
    discountCents = Math.min(coupon.discountValue, subtotalCents);
  } else {
    discountCents = 0; // FREE_SHIPPING / FREE_ENTRY are no-ops for this catalogue
  }

  return { couponId: coupon.id, discountCents };
}

/**
 * Confirms an order: captures payment, converts holds to sales, issues tickets,
 * awards loyalty points, and fires notifications. Called by the payment
 * webhook (and synchronously for offline methods).
 */
export async function confirmPaidOrder(orderId: string, providerChargeId?: string): Promise<void> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: {
      items: { include: { ticketType: { include: { product: { include: { destination: true } } } } } },
      travelers: true,
      payments: true,
    },
  });
  if (!order) throw AppError.notFound('Order');

  // Idempotency: if already confirmed, do nothing.
  if (order.status === OrderStatus.CONFIRMED || order.status === OrderStatus.COMPLETED) return;

  const ticketPayloads = await Promise.all(
    order.items.map(async (item) => {
      const product = item.ticketType.product;
      const ticketNumber = generateTicketNumber();
      const barcode = generateBarcode();
      const serviceDate = toServiceDate(item.serviceDate);

      const artifacts = await generateTicketArtifacts({
        ticketNumber,
        barcode,
        orderNumber: order.orderNumber,
        productName: item.productName,
        destinationName: product.destination?.name ?? null,
        holderName: order.travelers[0]?.fullName ?? order.contactEmail,
        holderEmail: order.contactEmail,
        serviceDate,
        timeSlot: item.timeSlot,
        quantity: item.quantity,
        totalCents: item.lineTotalCents,
        currency: order.currency,
      });

      return { item, ticketNumber, barcode, artifacts, serviceDate };
    }),
  );

  await prisma.$transaction(async (tx) => {
    await tx.order.update({
      where: { id: order.id },
      data: {
        status: OrderStatus.CONFIRMED,
        paidAt: new Date(),
        confirmedAt: new Date(),
        payments: {
          updateMany: {
            where: { status: { in: [PaymentStatus.INITIATED, PaymentStatus.AUTHORIZED] } },
            data: { status: PaymentStatus.CAPTURED, capturedAt: new Date(), providerChargeId: providerChargeId ?? undefined },
          },
        },
        orderStatusLogs: { create: { fromStatus: order.status, toStatus: OrderStatus.CONFIRMED, reason: 'payment captured' } },
      },
    });

    for (const payload of ticketPayloads) {
      const ticket = await tx.ticket.create({
        data: {
          orderId: order.id,
          ticketNumber: payload.ticketNumber,
          productId: payload.item.productId,
          productName: payload.item.productName,
          productSlug: payload.item.productSlug,
          destinationName: payload.item.ticketType.product.destination?.name ?? null,
          holderName: order.travelers[0]?.fullName ?? order.contactEmail,
          holderEmail: order.contactEmail,
          status: TicketStatus.ISSUED,
          qrPayload: payload.artifacts.qrPayload,
          qrImageUrl: payload.artifacts.qrImageUrl,
          pdfUrl: payload.artifacts.pdfUrl,
          barcode: payload.barcode,
          validFrom: payload.serviceDate,
          serviceDate: payload.serviceDate,
          timeSlot: payload.item.timeSlot,
          items: {
            create: {
              ticketTypeId: payload.item.ticketTypeId,
              name: payload.item.ticketTypeName,
              holderName: order.travelers[0]?.fullName ?? order.contactEmail,
            },
          },
        },
      });
      await tx.orderStatusLog.create({
        data: { orderId: order.id, fromStatus: order.status, toStatus: order.status, reason: `ticket issued ${ticket.ticketNumber}` },
      });
    }

    // Merchant payable + platform fee.
    for (const item of order.items) {
      if (!item.merchantId) continue;
      await tx.ledgerEntry.create({
        data: { orderId: order.id, merchantId: item.merchantId, account: 'MERCHANT_PAYABLE', direction: 'CREDIT', amountCents: item.netAmountCents, currency: order.currency, description: 'Merchant net', reference: order.orderNumber },
      });
      await tx.ledgerEntry.create({
        data: { orderId: order.id, merchantId: item.merchantId, account: 'PLATFORM_FEE', direction: 'CREDIT', amountCents: item.lineTotalCents - item.netAmountCents, currency: order.currency, description: 'Platform fee', reference: order.orderNumber },
      });
    }

    // Loyalty earn (10% of the order value back as points).
    if (order.userId) {
      const account = await tx.loyaltyAccount.findUnique({ where: { userId: order.userId } });
      if (account) {
        const points = Math.floor(order.totalCents / 100);
        await tx.loyaltyAccount.update({
          where: { id: account.id },
          data: { points: { increment: points }, lifetimePoints: { increment: points } },
        });
        await tx.loyaltyTransaction.create({
          data: { accountId: account.id, orderId: order.id, kind: 'EARN', points, balanceAfter: account.points + points },
        });
        await tx.order.update({ where: { id: order.id }, data: { pointsEarned: points } });
      }
    }

    // Queue confirmation notification.
    await tx.notification.create({
      data: { userId: order.userId, orderId: order.id, channel: 'EMAIL', template: 'order-confirmed', locale: order.locale, subject: `Your EasyTrip booking ${order.orderNumber}` },
    });
  });

  // Move holds to sold *after* the order transaction committed, so a failure
  // here can be retried without double-issuing tickets.
  //
  // Stay holds are reached through their group, not their child rows: a 3-night
  // booking holds three child `InventoryHold`s under one group token, and each
  // child's own token resolves to the single-record path. Consuming the children
  // directly would sell the nights but leave the group ACTIVE, which the TTL
  // sweeper would then treat as a live claim.
  const stayGroups = await prisma.inventoryHoldGroup.findMany({
    where: { userId: order.userId, status: 'ACTIVE' },
    select: { holdToken: true },
  });
  for (const group of stayGroups) {
    await consumeHold(group.holdToken).catch(() => undefined);
  }

  const singleHolds = await prisma.inventoryHold.findMany({
    where: { userId: order.userId, status: 'ACTIVE', groupId: null },
    select: { holdToken: true },
  });
  for (const hold of singleHolds) {
    await consumeHold(hold.holdToken).catch(() => undefined);
  }

  logger.info('booking.order_confirmed', { orderNumber: order.orderNumber, tickets: ticketPayloads.length });

  // Realtime: the order page swaps to "Confirmed" and the tickets appear
  // without a refresh; the console sees the sale land.
  emitOrderEvent({
    orderId: order.id,
    orderNumber: order.orderNumber,
    status: OrderStatus.CONFIRMED,
    fromStatus: order.status,
    userId: order.userId,
    reason: 'payment captured',
    totalCents: order.totalCents,
    currency: order.currency,
  });

  if (order.userId) {
    await createInAppNotification({
      userId: order.userId,
      orderId: order.id,
      template: 'order-confirmed',
      subject: `Order ${order.orderNumber} is confirmed`,
      locale: order.locale,
      payload: {
        orderNumber: order.orderNumber,
        ticketCount: ticketPayloads.length,
        totalCents: order.totalCents,
        currency: order.currency,
        status: OrderStatus.CONFIRMED,
      },
    });
  }
}

/**
 * Evaluates the cancellation policy and computes a refund quote without
 * mutating anything - the UI uses this to show "you will be refunded $X".
 */
export async function quoteCancellation(orderId: string): Promise<{
  refundable: boolean;
  refundCents: number;
  penaltyCents: number;
  refundBps: number;
  reason: string;
  policy: unknown;
}> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: { items: { include: { ticketType: { include: { product: { include: { cancellationPolicy: true } } } } } } },
  });
  if (!order) throw AppError.notFound('Order');

  const now = new Date();

  // The notice period is measured against the *earliest* leg of the booking.
  // Seeding the reduce from the first item avoids inventing an out-of-range
  // sentinel date, which would silently poison the comparison with NaN.
  const firstServiceDate = order.items.reduce(
    (earliest, item) => {
      const serviceDate = toServiceDate(item.serviceDate);
      return serviceDate < earliest ? serviceDate : earliest;
    },
    order.items.length > 0 ? toServiceDate(order.items[0].serviceDate) : now,
  );

  // Positive when the service is still in the future. `hoursBetween(a, b)`
  // returns `b - a`, so "now" has to be the first argument here.
  const hoursNotice = hoursBetween(now, firstServiceDate);

  let refundBps = 0;
  let policy: unknown = null;
  let reason = 'Non-refundable';
  let resolvedAnyPolicy = false;

  for (const item of order.items) {
    const itemPolicy = item.ticketType.product.cancellationPolicy;
    if (!itemPolicy) continue;
    policy = itemPolicy;

    const tiers = (itemPolicy.tiers ?? []) as { minHoursBefore: number; refundBps: number }[];
    const matching = tiers
      .filter((tier) => hoursNotice >= tier.minHoursBefore)
      .sort((a, b) => b.minHoursBefore - a.minHoursBefore)[0];

    const itemRefundBps = matching?.refundBps ?? 0;

    // The whole order refunds at the least favourable line's rate. `0` is a
    // legitimate value here, so track "resolved" separately rather than
    // treating zero as "not computed yet".
    if (!resolvedAnyPolicy) {
      refundBps = itemRefundBps;
      resolvedAnyPolicy = true;
    } else {
      refundBps = Math.min(refundBps, itemRefundBps);
    }

    if (matching) {
      reason = `${Math.round(matching.refundBps / 100)}% refund when cancelling ${Math.round(hoursNotice)}h ahead`;
    }
  }

  const refundCents = applyBps(order.totalCents, refundBps);
  const penaltyCents = order.totalCents - refundCents;

  return {
    refundable: refundBps > 0,
    refundCents,
    penaltyCents,
    refundBps,
    reason,
    policy,
  };
}

/**
 * Cancels an order (full or partial), returns inventory, issues the refund and
 * voids any tickets that were not yet redeemed.
 */
export async function cancelOrder(params: {
  orderId: string;
  userId?: string | null;
  reason?: string;
  refundCents?: number;
}): Promise<{ refundCents: number; status: OrderStatus }> {
  const order = await prisma.order.findUnique({
    where: { id: params.orderId },
    include: {
      items: { include: { ticketType: true } },
      payments: { where: { status: PaymentStatus.CAPTURED }, orderBy: { createdAt: 'desc' } },
      tickets: { include: { items: true } },
    },
  });
  if (!order) throw AppError.notFound('Order');
  if (params.userId && order.userId && order.userId !== params.userId) throw AppError.forbidden();

  const terminalStatuses: OrderStatus[] = [OrderStatus.CANCELLED, OrderStatus.REFUNDED, OrderStatus.EXPIRED];
  if (terminalStatuses.includes(order.status)) {
    throw AppError.conflict(`Order is already ${order.status}`);
  }

  const quote = await quoteCancellation(order.id);
  const requested = params.refundCents ?? quote.refundCents;
  const refundCents = Math.min(requested, quote.refundCents, order.totalCents);

  // Refund through the gateway (if captured online).
  let providerRefundId: string | undefined;
  const payment = order.payments[0];
  if (payment && refundCents > 0) {
    const gateway = getPaymentGateway();
    const result = await gateway.refund(
      payment.providerChargeId ?? payment.id,
      refundCents,
      `refund_${order.id}_${refundCents}`,
    );
    providerRefundId = result.providerRefundId;
  }

  const now = new Date();
  const fullyRefunded = refundCents >= order.totalCents - order.refundedCents;

  await prisma.$transaction(async (tx) => {
    // Void unredeemed tickets.
    for (const ticket of order.tickets) {
      const anyRedeemed = ticket.items.some((i) => i.redeemedQty > 0);
      if (!anyRedeemed) {
        await tx.ticket.update({ where: { id: ticket.id }, data: { status: TicketStatus.VOID } });
      }
    }

    // Return inventory for lines that were sold.
    for (const item of order.items) {
      const remainingQty = item.quantity - item.refundedQty;
      if (remainingQty <= 0) continue;
      await returnSoldUnits(tx, item.ticketTypeId, item.serviceDate, item.timeSlot, remainingQty);
      await tx.orderItem.update({
        where: { id: item.id },
        data: { refundedQty: item.quantity, status: 'CANCELLED' },
      });
    }

    // Record the refund.
    if (refundCents > 0) {
      await tx.refund.create({
        data: {
          orderId: order.id,
          paymentId: payment?.id,
          amountCents: refundCents,
          currency: order.currency,
          reason: params.reason ?? 'Customer cancellation',
          policySnapshot: quote.policy as never,
          providerRefundId,
          idempotencyKey: `refund_${order.id}_${refundCents}`,
        },
      });
      await tx.ledgerEntry.create({
        data: { orderId: order.id, account: 'REFUNDS', direction: 'DEBIT', amountCents: refundCents, currency: order.currency, description: 'Order cancellation', reference: order.orderNumber },
      });
      if (payment) {
        await tx.payment.update({
          where: { id: payment.id },
          data: {
            refundedCents: { increment: refundCents },
            status: fullyRefunded ? PaymentStatus.REFUNDED : PaymentStatus.PARTIALLY_REFUNDED,
          },
        });
      }
      // Claw back loyalty points.
      if (order.userId && order.pointsEarned > 0) {
        const account = await tx.loyaltyAccount.findUnique({ where: { userId: order.userId } });
        if (account) {
          const clawback = Math.min(account.points, order.pointsEarned);
          if (clawback > 0) {
            await tx.loyaltyAccount.update({ where: { id: account.id }, data: { points: { decrement: clawback } } });
            await tx.loyaltyTransaction.create({
              data: { accountId: account.id, orderId: order.id, kind: 'REVERSAL', points: -clawback, balanceAfter: account.points - clawback, note: 'Order cancelled' },
            });
          }
        }
      }
    }

    const newStatus = refundCents > 0 ? (fullyRefunded ? OrderStatus.REFUNDED : OrderStatus.PARTIALLY_REFUNDED) : OrderStatus.CANCELLED;

    await tx.order.update({
      where: { id: order.id },
      data: {
        status: newStatus,
        refundedCents: { increment: refundCents },
        cancelledAt: now,
        orderStatusLogs: { create: { fromStatus: order.status, toStatus: newStatus, reason: params.reason ?? 'Customer cancellation' } },
        notifications: { create: { channel: 'EMAIL', template: 'order-cancelled', locale: order.locale, subject: `Order ${order.orderNumber} cancelled` } },
      },
    });

    if (fullyRefunded) {
      await tx.ticket.updateMany({ where: { orderId: order.id }, data: { status: TicketStatus.VOID } });
    }
  });

  logger.info('booking.order_cancelled', { orderNumber: order.orderNumber, refundCents });

  // Realtime: refund state is exactly the kind of thing a shopper should not
  // have to refresh to discover.
  const finalStatus = refundCents > 0
    ? fullyRefunded
      ? OrderStatus.REFUNDED
      : OrderStatus.PARTIALLY_REFUNDED
    : OrderStatus.CANCELLED;

  emitOrderEvent({
    orderId: order.id,
    orderNumber: order.orderNumber,
    status: finalStatus,
    fromStatus: order.status,
    userId: order.userId,
    reason: params.reason ?? 'Customer cancellation',
    totalCents: order.totalCents,
    currency: order.currency,
  });

  if (order.userId) {
    await createInAppNotification({
      userId: order.userId,
      orderId: order.id,
      template: 'order-cancelled',
      subject: `Order ${order.orderNumber} cancelled`,
      locale: order.locale,
      payload: { orderNumber: order.orderNumber, refundCents, currency: order.currency, status: finalStatus },
    });
  }

  return { refundCents, status: fullyRefunded ? OrderStatus.REFUNDED : OrderStatus.CANCELLED };
}

/** Starts a payment for a pending order. */
export async function initiatePayment(params: {
  orderId: string;
  method: PaymentChannel;
  card?: { number: string; expMonth: number; expYear: number; cvc: string; holderName?: string };
  idempotencyKey: string;
}): Promise<{ paymentId: string; status: PaymentStatus; clientSecret?: string; failureMessage?: string }> {
  const order = assertFound(await prisma.order.findUnique({ where: { id: params.orderId } }), 'Order');
  if (order.status !== OrderStatus.PENDING_PAYMENT) {
    throw AppError.conflict(`Order is ${order.status} and cannot be paid`);
  }

  // Reuse an existing intent for the same idempotency key.
  const existing = await prisma.payment.findUnique({
    where: { idempotencyKey: params.idempotencyKey },
  });
  if (existing) {
    return { paymentId: existing.id, status: existing.status, failureMessage: existing.failureMessage ?? undefined };
  }

  const gateway = getPaymentGateway();
  const result = await gateway.createIntent({
    amountCents: order.totalCents,
    currency: order.currency,
    orderId: order.id,
    orderNumber: order.orderNumber,
    customerEmail: order.contactEmail,
    method: params.method,
    idempotencyKey: params.idempotencyKey,
    card: params.card,
  });

  const statusMap: Record<string, PaymentStatus> = {
    INITIATED: PaymentStatus.INITIATED,
    REQUIRES_ACTION: PaymentStatus.REQUIRES_ACTION,
    AUTHORIZED: PaymentStatus.AUTHORIZED,
    CAPTURED: PaymentStatus.CAPTURED,
    FAILED: PaymentStatus.FAILED,
  };

  const payment = await prisma.payment.create({
    data: {
      orderId: order.id,
      provider: result.provider,
      providerIntentId: result.providerIntentId,
      method: params.method,
      status: statusMap[result.status],
      amountCents: order.totalCents,
      currency: order.currency,
      failureCode: result.failureCode,
      failureMessage: result.failureMessage,
      cardBrand: result.cardBrand,
      cardLast4: result.cardLast4,
      idempotencyKey: params.idempotencyKey,
      events: { create: { provider: result.provider, eventId: `evt_intent_${result.providerIntentId}`, type: 'payment_intent.created', payload: result as never } },
    },
  });

  // Realtime: the checkout screen reacts the moment the gateway answers, instead
  // of polling the order endpoint until its status changes.
  emitPaymentEvent({
    orderId: order.id,
    orderNumber: order.orderNumber,
    paymentId: payment.id,
    status: payment.status,
    method: params.method,
    amountCents: order.totalCents,
    currency: order.currency,
    userId: order.userId,
    failureMessage: result.failureMessage,
  });

  if (result.status === 'CAPTURED') {
    await confirmPaidOrder(order.id, result.providerIntentId);
  }

  return {
    paymentId: payment.id,
    status: payment.status,
    clientSecret: result.clientSecret,
    failureMessage: result.failureMessage,
  };
}

/** Marks a pending order expired and releases its holds. */
export async function expireOrder(orderId: string): Promise<void> {
  const order = await prisma.order.findUnique({ where: { id: orderId } });
  if (!order || order.status !== OrderStatus.PENDING_PAYMENT) return;

  await prisma.$transaction(async (tx) => {
    await tx.order.update({
      where: { id: orderId },
      data: { status: OrderStatus.EXPIRED, orderStatusLogs: { create: { fromStatus: order.status, toStatus: OrderStatus.EXPIRED, reason: 'checkout window elapsed' } } },
    });
  });

  logger.info('booking.order_expired', { orderNumber: order.orderNumber });

  // A checkout that silently evaporates is the classic dead-end in an OTA: the
  // shopper is told, in place, that their held seats were released.
  emitOrderEvent({
    orderId: order.id,
    orderNumber: order.orderNumber,
    status: OrderStatus.EXPIRED,
    fromStatus: order.status,
    userId: order.userId,
    reason: 'checkout window elapsed',
    totalCents: order.totalCents,
    currency: order.currency,
  });

  if (order.userId) {
    await createInAppNotification({
      userId: order.userId,
      orderId: order.id,
      template: 'order-expired',
      subject: `Your checkout for ${order.orderNumber} expired`,
      locale: order.locale,
      payload: { orderNumber: order.orderNumber, status: OrderStatus.EXPIRED },
    });
  }
}

/** Marks confirmed tickets as redeemed, completing the order. */
export async function completeOrderIfFullyRedeemed(orderId: string): Promise<void> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: { tickets: { include: { items: true } } },
  });
  if (!order || order.status !== OrderStatus.CONFIRMED) return;

  const allRedeemed = order.tickets.length > 0 && order.tickets.every((t) => t.items.every((i) => i.redeemedQty >= 1));
  if (!allRedeemed) return;

  await prisma.order.update({
    where: { id: orderId },
    data: { status: OrderStatus.COMPLETED, completedAt: new Date(), orderStatusLogs: { create: { fromStatus: OrderStatus.CONFIRMED, toStatus: OrderStatus.COMPLETED, reason: 'all tickets redeemed' } } },
  });

  emitOrderEvent({
    orderId: order.id,
    orderNumber: order.orderNumber,
    status: OrderStatus.COMPLETED,
    fromStatus: order.status,
    userId: order.userId,
    reason: 'all tickets redeemed',
    totalCents: order.totalCents,
    currency: order.currency,
  });
}

export function isOfflinePayment(method: PaymentChannel): boolean {
  return isOfflineMethod(method);
}