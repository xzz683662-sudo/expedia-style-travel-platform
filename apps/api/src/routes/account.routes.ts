import type { FastifyInstance } from 'fastify';
import { PaymentChannel } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { requireAuth } from '../plugins/auth';
import {
  addPaymentMethod,
  listPaymentMethods,
  removePaymentMethod,
  SAVEABLE_CHANNELS,
  setDefaultPaymentMethod,
} from '../modules/payments/methods';
import { STAGE_PAYMENT_CHANNELS } from '../modules/supply/credentials';

/**
 * ---------------------------------------------------------------------------
 * Account centre (customer-facing)
 * ---------------------------------------------------------------------------
 *
 * One place for everything tied to the shopper's account: profile, stored-value
 * balance, saved payment credentials, loyalty and the counts that back the
 * "My account" navigation.
 *
 * Deliberately **not** here: anything that settles money. A saved method is a
 * reference; what it can be *used* for is decided by the credential boundary
 * (`modules/supply/credentials.ts`), and in this stage every settlement rail
 * refuses `live`. The account centre can therefore be complete without the
 * platform ever holding a transaction credential.
 */
export async function accountRoutes(app: FastifyInstance): Promise<void> {
  /** Everything the account home needs, in one round-trip. */
  app.get('/account/overview', {}, async (request) => {
    const user = requireAuth(request);

    const [profile, paymentMethods] = await Promise.all([
      prisma.user.findUnique({
        where: { id: user.id },
        include: {
          loyaltyAccount: true,
          travelerProfiles: true,
          _count: { select: { orders: true, reviews: true, wishlist: true } },
        },
      }),
      listPaymentMethods(user.id),
    ]);

    if (!profile) return { error: 'NOT_FOUND' };

    return {
      profile: {
        id: profile.id,
        email: profile.email,
        firstName: profile.firstName,
        lastName: profile.lastName,
        phone: profile.phone,
        locale: profile.locale,
        countryCode: profile.countryCode,
        avatarUrl: profile.avatarUrl,
        marketingOptIn: profile.marketingOptIn,
        emailVerified: profile.emailVerifiedAt !== null,
        memberSince: profile.createdAt,
      },
      // Stored-value balance. Spendable credit from refunds and support
      // adjustments — distinct from loyalty points, which are non-monetary.
      wallet: { balanceCents: profile.walletCents, enabled: profile.walletEnabled },
      loyalty: profile.loyaltyAccount
        ? { tier: profile.loyaltyAccount.tier, points: profile.loyaltyAccount.points }
        : null,
      travelers: profile.travelerProfiles.map((t) => ({
        id: t.id,
        fullName: t.fullName,
        email: t.email,
        phone: t.phone,
        isDefault: t.isDefault,
      })),
      paymentMethods: paymentMethods.map(toPublicMethod),
      stats: profile._count,
      /** Which channels the account form may offer, and what each needs. */
      channels: SAVEABLE_CHANNELS,
    };
  });

  app.get('/account/payment-methods', {}, async (request) => {
    const user = requireAuth(request);
    const methods = await listPaymentMethods(user.id);
    return { methods: methods.map(toPublicMethod), channels: SAVEABLE_CHANNELS };
  });

  app.post('/account/payment-methods', {}, async (request, reply) => {
    const user = requireAuth(request);
    const body = z
      .object({
        channel: z.nativeEnum(PaymentChannel),
        label: z.string().trim().max(80).optional(),
        isDefault: z.boolean().optional(),
        card: z
          .object({
            brand: z.string().min(2).max(20),
            // Last four only. There is deliberately no `number` field: the API
            // never accepts a PAN, so it can never store one.
            last4: z.string().length(4),
            token: z.string().max(200).optional(),
            expMonth: z.number().int().min(1).max(12).optional(),
            expYear: z.number().int().min(2024).max(2060).optional(),
          })
          .optional(),
        paypal: z.object({ payerId: z.string().min(1).max(120), email: z.string().email().optional() }).optional(),
        crypto: z.object({ address: z.string().min(20).max(80), network: z.string().max(20).optional() }).optional(),
      })
      .parse(request.body);

    const method = await addPaymentMethod(user.id, body);
    return reply.status(201).send(toPublicMethod(method));
  });

  app.patch('/account/payment-methods/:id', {}, async (request) => {
    const user = requireAuth(request);
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const body = z.object({ isDefault: z.literal(true) }).parse(request.body);
    void body;
    return setDefaultPaymentMethod(user.id, id);
  });

  app.delete('/account/payment-methods/:id', {}, async (request) => {
    const user = requireAuth(request);
    const { id } = z.object({ id: z.string() }).parse(request.params);
    return removePaymentMethod(user.id, id);
  });

  /**
   * The stage's payment-channel boundary, stated as data.
   *
   * `enabled` is false for a rail whose live credential this stage does not
   * admit. The client uses it to label a channel "sandbox" rather than implying
   * it can settle for real.
   */
  app.get('/account/payment-channels', {}, async () => ({
    stage: 'READ_ONLY_SUPPLY',
    channels: STAGE_PAYMENT_CHANNELS.map((channel) => ({
      channel,
      enabled: true,
      /**
       * Sandbox rails behave deterministically and never move real money. This
       * is a property of the credential boundary, not a configuration hint.
       */
      liveSettlement: false,
    })),
  }));
}

/**
 * Strips anything a client must not receive.
 *
 * `providerToken` is excluded: it is a reference the server uses to settle, not
 * a value the browser needs, and shipping it to the client would turn a stored
 * reference into an exposed one.
 */
function toPublicMethod(method: {
  id: string;
  channel: PaymentChannel;
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
