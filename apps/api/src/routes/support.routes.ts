import { z } from 'zod';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { AppError } from '../utils/errors';
import { requireRole } from '../plugins/auth';
import { generateIdempotencyKey } from '../utils/ids';
import { removePaymentMethod, setDefaultPaymentMethod } from '../modules/payments/methods';

/**
 * ---------------------------------------------------------------------------
 * Customer support console
 * ---------------------------------------------------------------------------
 *
 * Deliberately narrower than `/admin`:
 *   - look up customers and their orders
 *   - correct bound profile fields and adjust wallet balances
 *   - issue goodwill refunds against a paid order
 *   - verify coupon codes
 *
 * It cannot touch the catalogue, pricing rules, inventory, or staff accounts.
 * Every mutation writes an AuditLog row and, for money movement, a
 * WalletTransaction — so support activity stays reconstructable after the fact.
 *
 * SUPPORT sits *below* ADMIN on purpose: the cheapest way to stop an agent
 * breaking pricing is to never let them reach it.
 */

/**
 * `requireRole` returns a hook, so it must sit in `preHandler`. It is wrapped in
 * a named function rather than an inline spread because Fastify cannot infer the
 * handler signature from an array built by spreading a `as const` tuple.
 */
const supportOnly = { preHandler: [requireRole('SUPPORT', 'ADMIN')] };

const CUSTOMER_SELECT = {
  id: true,
  email: true,
  firstName: true,
  lastName: true,
  phone: true,
  locale: true,
  countryCode: true,
  role: true,
  avatarUrl: true,
  marketingOptIn: true,
  emailVerifiedAt: true,
  walletCents: true,
  walletEnabled: true,
  createdAt: true,
} as const;

/**
 * The payment-method shape support may see: a token-backed reference, never a
 * secret. `providerToken` is omitted for the same reason the customer API omits
 * it — support needs to identify a card, not to use it.
 */
function toSupportMethod(method: {
  id: string;
  channel: string;
  brand: string | null;
  last4: string | null;
  label: string | null;
  isDefault: boolean;
  verifiedAt: Date | null;
  expiresAt: Date | null;
  createdAt: Date;
}) {
  return {
    id: method.id,
    channel: method.channel,
    brand: method.brand,
    last4: method.last4,
    label: method.label,
    isDefault: method.isDefault,
    verified: method.verifiedAt !== null,
    expiresAt: method.expiresAt,
    createdAt: method.createdAt,
  };
}

const lookupQuery = z.object({
  q: z.string().trim().min(2).max(120).optional(),
  role: z.enum(['CUSTOMER', 'SUPPORT', 'ADMIN']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().optional(),
});

const profilePatch = z
  .object({
    firstName: z.string().trim().min(1).max(80).optional(),
    lastName: z.string().trim().min(1).max(80).optional(),
    phone: z.string().trim().max(40).nullable().optional(),
    locale: z.string().trim().min(2).max(10).optional(),
    countryCode: z
      .string()
      .trim()
      .length(2)
      .toUpperCase()
      .nullable()
      .optional(),
    marketingOptIn: z.boolean().optional(),
    // Whether the stored-value balance may be spent at checkout.
    walletEnabled: z.boolean().optional(),
    // Points and tier live on LoyaltyAccount, not User — they are adjusted
    // here so both balances stay editable from one screen.
    loyaltyPoints: z.number().int().min(0).max(10_000_000).optional(),
    loyaltyTier: z.enum(['MEMBER', 'SILVER', 'GOLD', 'PLATINUM']).optional(),
  })
  .refine((body) => Object.keys(body).length > 0, { message: 'No fields to update' });

const walletAdjust = z.object({
  // Signed: positive credits the shopper, negative debits them.
  amountCents: z
    .number()
    .int()
    .refine((v) => v !== 0, { message: 'Amount must be non-zero' }),
  currency: z.string().trim().length(3).toUpperCase().default('USD'),
  note: z.string().trim().min(3).max(280),
});

const goodwillRefund = z.object({
  amountCents: z.number().int().positive('Refund must be positive'),
  reason: z.string().trim().min(3).max(280),
});

/** Writes an audit row. Never throws — losing the log must not fail the action. */
async function audit(input: {
  request: FastifyRequest;
  action: string;
  entityType: string;
  entityId: string;
  before?: unknown;
  after?: unknown;
}): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        actorId: input.request.user?.id ?? null,
        actorRole: input.request.user?.role ?? null,
        action: input.action,
        entityType: input.entityType,
        entityId: input.entityId,
        before: (input.before ?? undefined) as never,
        after: (input.after ?? undefined) as never,
        ip: input.request.ip ?? null,
      },
    });
  } catch (error) {
    logger.error('support.audit_write_failed', {
      action: input.action,
      reason: (error as Error).message,
    });
  }
}

/** Flattens the loyalty relation so the console renders one row per customer. */
function shapeCustomer(user: {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  phone: string | null;
  locale: string;
  countryCode: string | null;
  role: string;
  avatarUrl: string | null;
  marketingOptIn: boolean;
  emailVerifiedAt: Date | null;
  walletCents: number;
  walletEnabled: boolean;
  createdAt: Date;
  loyaltyAccount?: { points: number; lifetimePoints: number; tier: string } | null;
  _count?: { orders: number; reviews: number };
}) {
  return {
    id: user.id,
    email: user.email,
    firstName: user.firstName,
    lastName: user.lastName,
    phone: user.phone,
    locale: user.locale,
    countryCode: user.countryCode,
    role: user.role,
    avatarUrl: user.avatarUrl,
    marketingOptIn: user.marketingOptIn,
    emailVerified: user.emailVerifiedAt !== null,
    createdAt: user.createdAt,
    walletCents: user.walletCents,
    walletEnabled: user.walletEnabled,
    loyaltyPoints: user.loyaltyAccount?.points ?? 0,
    loyaltyTier: user.loyaltyAccount?.tier ?? 'MEMBER',
    lifetimePoints: user.loyaltyAccount?.lifetimePoints ?? 0,
    orderCount: user._count?.orders ?? 0,
    reviewCount: user._count?.reviews ?? 0,
  };
}

export async function supportRoutes(app: FastifyInstance): Promise<void> {
  // -------------------------------------------------------------------------
  // Customer lookup
  // -------------------------------------------------------------------------
  app.get('/support/customers', supportOnly, async (request) => {
    const q = lookupQuery.parse(request.query ?? {});

    const users = await prisma.user.findMany({
      where: {
        ...(q.role ? { role: q.role } : {}),
        ...(q.q
          ? {
              OR: [
                { email: { contains: q.q, mode: 'insensitive' as const } },
                { firstName: { contains: q.q, mode: 'insensitive' as const } },
                { lastName: { contains: q.q, mode: 'insensitive' as const } },
                { phone: { contains: q.q, mode: 'insensitive' as const } },
              ],
            }
          : {}),
      },
      select: {
        ...CUSTOMER_SELECT,
        loyaltyAccount: { select: { points: true, lifetimePoints: true, tier: true } },
        _count: { select: { orders: true, reviews: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: q.limit + 1,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
    });

    const hasMore = users.length > q.limit;
    const page = hasMore ? users.slice(0, q.limit) : users;

    return {
      items: page.map(shapeCustomer),
      nextCursor: hasMore ? (page[page.length - 1]?.id ?? null) : null,
    };
  });

  // -------------------------------------------------------------------------
  // Single customer: profile, orders, wallet ledger
  // -------------------------------------------------------------------------
  app.get('/support/customers/:id', supportOnly, async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);

    const user = await prisma.user.findUnique({
      where: { id },
      select: {
        ...CUSTOMER_SELECT,
        loyaltyAccount: { select: { points: true, lifetimePoints: true, tier: true } },
        orders: {
          orderBy: { placedAt: 'desc' },
          take: 20,
          select: {
            id: true,
            orderNumber: true,
            status: true,
            totalCents: true,
            currency: true,
            placedAt: true,
          },
        },
        walletLedger: { orderBy: { createdAt: 'desc' }, take: 20 },
        // Saved payment references. Never a secret: only a token, brand and the
        // last four — see modules/payments/methods.ts.
        paymentMethods: { orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }] },
      },
    });

    if (!user) throw AppError.notFound('Customer');

    const { orders, walletLedger, loyaltyAccount, paymentMethods, ...profile } = user;

    return {
      ...shapeCustomer({ ...profile, loyaltyAccount, _count: { orders: orders.length, reviews: 0 } }),
      orders,
      walletTransactions: walletLedger,
      paymentMethods: paymentMethods.map(toSupportMethod),
    };
  });

  /**
   * Detach a saved payment method from a customer.
   *
   * Support may *remove* a compromised or stale method, and set which one is
   * default — but may never *add* one, because adding requires the customer's
   * own token. That asymmetry is deliberate: a support agent cannot introduce a
   * payment credential.
   */
  app.delete('/support/customers/:id/payment-methods/:methodId', supportOnly, async (request) => {
    const { id, methodId } = z.object({ id: z.string(), methodId: z.string() }).parse(request.params);

    const method = await prisma.paymentMethod.findUnique({ where: { id: methodId } });
    if (!method || method.userId !== id) throw AppError.notFound('Payment method');

    await removePaymentMethod(id, methodId);

    await audit({
      request,
      action: 'support.payment_method.remove',
      entityType: 'PaymentMethod',
      entityId: methodId,
      before: { channel: method.channel, brand: method.brand, last4: method.last4, isDefault: method.isDefault },
    });

    return { ok: true, removedId: methodId };
  });

  /** Make one of a customer's saved methods their default. */
  app.patch('/support/customers/:id/payment-methods/:methodId', supportOnly, async (request) => {
    const { id, methodId } = z.object({ id: z.string(), methodId: z.string() }).parse(request.params);
    const body = z.object({ isDefault: z.literal(true) }).parse(request.body ?? {});

    const method = await prisma.paymentMethod.findUnique({ where: { id: methodId } });
    if (!method || method.userId !== id) throw AppError.notFound('Payment method');

    await setDefaultPaymentMethod(id, methodId);

    await audit({
      request,
      action: 'support.payment_method.set_default',
      entityType: 'PaymentMethod',
      entityId: methodId,
      after: { isDefault: body.isDefault },
    });

    return { ok: true, defaultId: methodId };
  });

  // -------------------------------------------------------------------------
  // Edit bound profile fields (incl. both balances)
  // -------------------------------------------------------------------------
  app.patch('/support/customers/:id', supportOnly, async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const body = profilePatch.parse(request.body ?? {});

    const before = await prisma.user.findUnique({
      where: { id },
      select: { ...CUSTOMER_SELECT, loyaltyAccount: { select: { points: true, tier: true } } },
    });
    if (!before) throw AppError.notFound('Customer');

    // Support cannot edit an email, a password, or a role — those are
    // privilege-escalation vectors, not profile data.
    const { loyaltyPoints, loyaltyTier, ...profileFields } = body;

    await prisma.$transaction(async (tx) => {
      if (Object.keys(profileFields).length > 0) {
        await tx.user.update({ where: { id }, data: profileFields });
      }

      if (loyaltyPoints !== undefined || loyaltyTier !== undefined) {
        await tx.loyaltyAccount.upsert({
          where: { userId: id },
          create: {
            userId: id,
            points: loyaltyPoints ?? 0,
            lifetimePoints: loyaltyPoints ?? 0,
            tier: loyaltyTier ?? 'MEMBER',
          },
          update: {
            ...(loyaltyPoints !== undefined
              ? { points: loyaltyPoints, lifetimePoints: loyaltyPoints }
              : {}),
            ...(loyaltyTier !== undefined ? { tier: loyaltyTier } : {}),
          },
        });
      }
    });

    await audit({
      request,
      action: 'support.customer.update_profile',
      entityType: 'User',
      entityId: id,
      before: {
        firstName: before.firstName,
        lastName: before.lastName,
        phone: before.phone,
        locale: before.locale,
        marketingOptIn: before.marketingOptIn,
        walletEnabled: before.walletEnabled,
        loyaltyPoints: before.loyaltyAccount?.points ?? 0,
        loyaltyTier: before.loyaltyAccount?.tier ?? 'MEMBER',
      },
      after: body,
    });

    return { ok: true };
  });

  // -------------------------------------------------------------------------
  // Stored-value balance adjustment
  // -------------------------------------------------------------------------
  app.post('/support/customers/:id/wallet', supportOnly, async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const body = walletAdjust.parse(request.body ?? {});

    const user = await prisma.user.findUnique({
      where: { id },
      select: { id: true, walletCents: true, walletEnabled: true },
    });
    if (!user) throw AppError.notFound('Customer');

    const nextBalance = user.walletCents + body.amountCents;
    // A negative balance reads as "the shopper owes us", which the storefront
    // has no way to explain or settle. Refuse instead of silently clamping.
    if (nextBalance < 0) {
      throw AppError.badRequest(
        `Insufficient balance: ${user.walletCents} available, ${Math.abs(body.amountCents)} requested as a debit`,
      );
    }

    const transaction = await prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id },
        data: { walletCents: nextBalance, walletEnabled: true },
      });

      return tx.walletTransaction.create({
        data: {
          userId: id,
          kind: body.amountCents > 0 ? 'CREDIT' : 'DEBIT',
          amountCents: body.amountCents,
          currency: body.currency,
          balanceAfterCents: nextBalance,
          note: body.note,
          actorId: request.user?.id ?? null,
          actorEmail: request.user?.email ?? null,
        },
      });
    });

    await audit({
      request,
      action: 'support.customer.adjust_wallet',
      entityType: 'User',
      entityId: id,
      before: { walletCents: user.walletCents },
      after: { walletCents: nextBalance, deltaCents: body.amountCents, note: body.note },
    });

    return { ok: true, balanceCents: nextBalance, transactionId: transaction.id };
  });

  // -------------------------------------------------------------------------
  // Goodwill refund against a paid order
  // -------------------------------------------------------------------------
  app.post('/support/orders/:id/refund', supportOnly, async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const body = goodwillRefund.parse(request.body ?? {});

    const order = await prisma.order.findUnique({
      where: { id },
      include: { user: { select: { walletCents: true } }, refunds: true },
    });
    if (!order) throw AppError.notFound('Order');

    const refundable = ['PAID', 'CONFIRMED', 'COMPLETED', 'PARTIALLY_REFUNDED'];
    if (!refundable.includes(order.status)) {
      throw AppError.badRequest(`Cannot refund an order in status ${order.status}`);
    }

    // Guest checkout (no account) leaves userId null — there is no wallet to
    // credit, so those orders can only be refunded by the admin console.
    const customerId = order.userId;
    const customer = order.user;
    if (!customerId || !customer) {
      throw AppError.badRequest(
        'This is a guest order with no account attached — refund it from the admin console',
      );
    }

    const alreadyRefunded = order.refunds
      .filter((r) => r.status === 'SUCCEEDED')
      .reduce((sum, r) => sum + r.amountCents, 0);
    const remaining = order.totalCents - alreadyRefunded;
    if (body.amountCents > remaining) {
      throw AppError.badRequest(
        `Refund of ${body.amountCents} exceeds the refundable balance of ${remaining} ${order.currency}`,
      );
    }

    // Refunds land as stored-value credit rather than a card chargeback: the
    // platform makes no processor call here, and credit is instant + auditable.
    const newBalance = customer.walletCents + body.amountCents;

    await prisma.$transaction(async (tx) => {
      await tx.refund.create({
        data: {
          orderId: order.id,
          amountCents: body.amountCents,
          currency: order.currency,
          reason: body.reason,
          status: 'SUCCEEDED',
          processedAt: new Date(),
          idempotencyKey: generateIdempotencyKey(`support_refund_${order.id}_${body.amountCents}`),
        },
      });

      await tx.ledgerEntry.create({
        data: {
          orderId: order.id,
          account: 'REFUNDS',
          direction: 'DEBIT',
          amountCents: body.amountCents,
          currency: order.currency,
          description: `Support goodwill: ${body.reason}`,
          reference: order.orderNumber,
        },
      });

      await tx.user.update({
        where: { id: customerId },
        data: { walletCents: newBalance, walletEnabled: true },
      });

      await tx.walletTransaction.create({
        data: {
          userId: customerId,
          orderId: order.id,
          kind: 'REFUND',
          amountCents: body.amountCents,
          currency: order.currency,
          balanceAfterCents: newBalance,
          note: body.reason,
          actorId: request.user?.id ?? null,
          actorEmail: request.user?.email ?? null,
        },
      });
    });

    await audit({
      request,
      action: 'support.order.goodwill_refund',
      entityType: 'Order',
      entityId: order.id,
      before: { status: order.status, refundedCents: alreadyRefunded },
      after: { amountCents: body.amountCents, reason: body.reason },
    });

    return { ok: true, refundedCents: body.amountCents, walletCents: newBalance };
  });

  // -------------------------------------------------------------------------
  // Coupon verification — the "is this code real?" question support gets most
  // -------------------------------------------------------------------------
  app.get('/support/coupons/:code/verify', supportOnly, async (request) => {
    const { code } = z.object({ code: z.string().trim().min(2).max(40) }).parse(request.params);

    const coupon = await prisma.coupon.findUnique({ where: { code: code.toUpperCase() } });
    if (!coupon) return { valid: false, reason: 'No coupon with that code' };

    const now = new Date();
    const notStarted = coupon.startsAt !== null && coupon.startsAt > now;
    const expired = coupon.endsAt !== null && coupon.endsAt < now;
    const usedUp = coupon.usageLimit !== null && coupon.usageCount >= coupon.usageLimit;

    const valid = coupon.active && !notStarted && !expired && !usedUp;

    return {
      valid,
      code: coupon.code,
      description: coupon.description,
      reason: !coupon.active
        ? 'Coupon is inactive'
        : notStarted
          ? `Not active until ${coupon.startsAt?.toISOString()}`
          : expired
            ? `Expired ${coupon.endsAt?.toISOString()}`
            : usedUp
              ? 'Redemption limit reached'
              : 'Valid',
      discountType: coupon.discountType,
      discountValue: coupon.discountValue,
      maxDiscountCents: coupon.maxDiscountCents,
      minOrderCents: coupon.minOrderCents,
      currency: coupon.currency,
      usageLimit: coupon.usageLimit,
      usageCount: coupon.usageCount,
      perUserLimit: coupon.perUserLimit,
      stackable: coupon.stackable,
      startsAt: coupon.startsAt,
      endsAt: coupon.endsAt,
    };
  });

  // -------------------------------------------------------------------------
  // Order lookup — the other question support gets most
  // -------------------------------------------------------------------------
  app.get('/support/orders/lookup', supportOnly, async (request) => {
    const q = z
      .object({
        orderNumber: z.string().trim().min(4).max(40).optional(),
        email: z.string().trim().email().optional(),
        limit: z.coerce.number().int().min(1).max(50).default(20),
      })
      .parse(request.query ?? {});

    if (!q.orderNumber && !q.email) {
      throw AppError.badRequest('Provide an orderNumber or an email to search by');
    }

    const orders = await prisma.order.findMany({
      where: {
        ...(q.orderNumber
          ? { orderNumber: { contains: q.orderNumber, mode: 'insensitive' as const } }
          : {}),
        ...(q.email ? { user: { email: { equals: q.email, mode: 'insensitive' as const } } } : {}),
      },
      include: {
        user: { select: { id: true, email: true, firstName: true, lastName: true, walletCents: true } },
        refunds: { select: { amountCents: true, status: true } },
        _count: { select: { tickets: true } },
      },
      orderBy: { placedAt: 'desc' },
      take: q.limit,
    });

    return {
      items: orders.map((o) => ({
        id: o.id,
        orderNumber: o.orderNumber,
        status: o.status,
        totalCents: o.totalCents,
        refundedCents: o.refunds
          .filter((r) => r.status === 'SUCCEEDED')
          .reduce((sum, r) => sum + r.amountCents, 0),
        currency: o.currency,
        placedAt: o.placedAt,
        customer: o.user,
        ticketCount: o._count.tickets,
      })),
    };
  });

  // -------------------------------------------------------------------------
  // Agent-facing audit trail
  // -------------------------------------------------------------------------
  // Agent-facing audit trail. Restricted to SUPPORT/ADMIN: the rows carry
  // before/after snapshots of wallet balances, so a plain authenticated check
  // would let any shopper read other customers' money movements.
  app.get('/support/audit', supportOnly, async (request) => {
    const q = z
      .object({
        entityId: z.string().optional(),
        action: z.string().optional(),
        limit: z.coerce.number().int().min(1).max(200).default(50),
      })
      .parse(request.query ?? {});

    const entries = await prisma.auditLog.findMany({
      where: {
        ...(q.entityId
          ? { OR: [{ entityId: q.entityId }, { action: { startsWith: 'support.' } }] }
          : {}),
        ...(q.action ? { action: { startsWith: q.action } } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: q.limit,
    });

    return { items: entries };
  });
}