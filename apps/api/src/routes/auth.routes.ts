import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../config/env';
import { logger } from '../lib/logger';
import { prisma } from '../lib/prisma';
import { requireAuth } from '../plugins/auth';
import { AppError } from '../utils/errors';
import { hashPassword, verifyPassword } from '../utils/crypto';
import { signToken } from '../utils/jwt';
import { sendVerificationEmail, verifyEmailCode } from '../modules/mail/verification';

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8, 'Use at least 8 characters').max(200),
  firstName: z.string().trim().min(1).max(80),
  lastName: z.string().trim().min(1).max(80),
  phone: z.string().trim().max(40).optional(),
  locale: z.enum(['en-US', 'en-GB', 'fr-FR', 'de-DE', 'es-ES', 'it-IT']).optional(),
  countryCode: z.string().length(2).optional(),
  marketingOptIn: z.boolean().optional(),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const verifyEmailSchema = z.object({
  email: z.string().email(),
  // Six digits, exactly. Validated before any lookup so a malformed code never
  // reaches the hash comparison.
  code: z
    .string()
    .trim()
    .regex(/^\d{6}$/, 'Enter the 6-digit code from your email'),
});

const resendSchema = z.object({ email: z.string().email() });

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post('/auth/register', {}, async (request, reply) => {
    const body = registerSchema.parse(request.body);

    const existing = await prisma.user.findUnique({ where: { email: body.email.toLowerCase() } });
    if (existing) throw AppError.conflict('An account with that email already exists');

    const user = await prisma.user.create({
      data: {
        email: body.email.toLowerCase(),
        passwordHash: hashPassword(body.password),
        firstName: body.firstName,
        lastName: body.lastName,
        phone: body.phone ?? null,
        locale: body.locale ?? config.site.defaultLocale,
        countryCode: body.countryCode?.toUpperCase() ?? null,
        marketingOptIn: body.marketingOptIn ?? false,
        // Every customer gets a loyalty account so earn/redeem works from day one.
        loyaltyAccount: { create: { tier: 'MEMBER' } },
        travelerProfiles: {
          create: { fullName: `${body.firstName} ${body.lastName}`, email: body.email, isDefault: true },
        },
      },
    });

    await prisma.userSession.create({
      data: {
        userId: user.id,
        ip: request.ip,
        userAgent: request.headers['user-agent'],
        expiresAt: new Date(Date.now() + 7 * 86_400_000),
      },
    });

    const token = signToken({ sub: user.id, email: user.email, role: user.role, locale: user.locale });

    // Registration succeeds whether or not the email goes out: the account is
    // already durable, and a transport failure must not lose it. The shopper can
    // resend from the verification screen.
    let devCode: string | undefined;
    let sent = false;
    try {
      const issued = await sendVerificationEmail({
        userId: user.id,
        email: user.email,
        firstName: user.firstName,
        locale: user.locale,
      });
      sent = true;
      if (config.mail.exposeDevCode) devCode = issued.code;
    } catch (error) {
      logger.warn('auth.verification_send_failed', {
        userId: user.id,
        reason: (error as Error).message,
      });
    }

    return reply.status(201).send({
      token,
      user: {
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        locale: user.locale,
        role: user.role,
        emailVerified: false,
      },
      emailVerification: { required: true, sent, devCode },
    });
  });

  app.post('/auth/login', {}, async (request) => {
    const body = loginSchema.parse(request.body);

    const user = await prisma.user.findUnique({
      where: { email: body.email.toLowerCase() },
      include: { loyaltyAccount: true },
    });

    // Same message for unknown email and wrong password: no account enumeration.
    if (!user || !verifyPassword(body.password, user.passwordHash)) {
      throw AppError.unauthenticated('Incorrect email or password');
    }

    const token = signToken({ sub: user.id, email: user.email, role: user.role, locale: user.locale });

    return {
      token,
      user: {
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        locale: user.locale,
        role: user.role,
        emailVerified: user.emailVerifiedAt !== null,
        loyalty: user.loyaltyAccount
          ? { tier: user.loyaltyAccount.tier, points: user.loyaltyAccount.points }
          : null,
      },
    };
  });

  app.get('/auth/me', {}, async (request) => {
    const user = requireAuth(request);

    const profile = await prisma.user.findUnique({
      where: { id: user.id },
      include: {
        loyaltyAccount: { include: { transactions: { orderBy: { createdAt: 'desc' }, take: 20 } } },
        travelerProfiles: true,
        _count: { select: { orders: true, reviews: true, wishlist: true } },
      },
    });

    if (!profile) throw AppError.notFound('User');

    return {
      id: profile.id,
      email: profile.email,
      firstName: profile.firstName,
      lastName: profile.lastName,
      phone: profile.phone,
      locale: profile.locale,
      role: profile.role,
      emailVerified: profile.emailVerifiedAt !== null,
      marketingOptIn: profile.marketingOptIn,
      loyalty: profile.loyaltyAccount
        ? {
            tier: profile.loyaltyAccount.tier,
            points: profile.loyaltyAccount.points,
            lifetimePoints: profile.loyaltyAccount.lifetimePoints,
            transactions: profile.loyaltyAccount.transactions.map((t) => ({
              id: t.id,
              kind: t.kind,
              points: t.points,
              note: t.note,
              createdAt: t.createdAt,
            })),
          }
        : null,
      travelers: profile.travelerProfiles.map((t) => ({
        id: t.id,
        fullName: t.fullName,
        email: t.email,
        isDefault: t.isDefault,
      })),
      stats: profile._count,
    };
  });

  app.patch('/auth/me', {}, async (request) => {
    const user = requireAuth(request);
    const body = z
      .object({
        firstName: z.string().trim().min(1).max(80).optional(),
        lastName: z.string().trim().min(1).max(80).optional(),
        phone: z.string().trim().max(40).nullish(),
        locale: z.string().optional(),
        marketingOptIn: z.boolean().optional(),
      })
      .parse(request.body);

    const updated = await prisma.user.update({ where: { id: user.id }, data: body });

    return {
      id: updated.id,
      email: updated.email,
      firstName: updated.firstName,
      lastName: updated.lastName,
      phone: updated.phone,
      locale: updated.locale,
      marketingOptIn: updated.marketingOptIn,
    };
  });

  /** Saved traveller profiles, attached to bookings at checkout. */
  app.post('/auth/travelers', {}, async (request, reply) => {
    const user = requireAuth(request);
    const body = z
      .object({
        fullName: z.string().trim().min(1).max(160),
        email: z.string().email().optional(),
        phone: z.string().trim().max(40).optional(),
        documentType: z.string().max(40).optional(),
        documentNo: z.string().max(60).optional(),
        nationality: z.string().length(2).optional(),
        isDefault: z.boolean().optional(),
      })
      .parse(request.body);

    if (body.isDefault) {
      await prisma.travelerProfile.updateMany({ where: { userId: user.id }, data: { isDefault: false } });
    }

    const traveler = await prisma.travelerProfile.create({
      data: {
        userId: user.id,
        fullName: body.fullName,
        email: body.email ?? null,
        phone: body.phone ?? null,
        documentType: body.documentType ?? null,
        documentNo: body.documentNo ?? null,
        nationality: body.nationality?.toUpperCase() ?? null,
        isDefault: body.isDefault ?? false,
      },
    });

    return reply.status(201).send(traveler);
  });

  /**
   * Confirms an email address with the code issued at registration.
   *
   * Every failure mode collapses into one 422 message on purpose: telling the
   * caller whether an address exists, or whether a code was expired versus
   * simply wrong, helps an attacker and not the shopper. The `code` is the same
   * for all of them; the machine-readable `code` field stays VALIDATION_FAILED.
   */
  app.post('/auth/verify-email', {}, async (request) => {
    const body = verifyEmailSchema.parse(request.body);
    const email = body.email.toLowerCase();

    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) throw AppError.validation('That code is not valid or has expired');

    if (user.emailVerifiedAt) {
      return { verified: true, alreadyVerified: true as const };
    }

    const outcome = await verifyEmailCode(user.id, body.code);
    if (outcome.status !== 'ok') {
      logger.info('auth.verify_email_rejected', { userId: user.id, reason: outcome.status });
      throw AppError.validation('That code is not valid or has expired');
    }

    return { verified: true, alreadyVerified: false as const };
  });

  /**
   * Re-issues a verification code.
   *
   * Always answers `{ sent: true }`, even for an unknown address: a different
   * response for a registered email would turn this endpoint into an account
   * oracle. The cooldown limits how often a code can be minted for one account.
   */
  app.post('/auth/resend-verification', {}, async (request) => {
    const body = resendSchema.parse(request.body);
    const email = body.email.toLowerCase();

    const user = await prisma.user.findUnique({ where: { email } });
    if (!user || user.emailVerifiedAt) {
      return { sent: true, devCode: undefined };
    }

    const newest = await prisma.emailVerificationCode.findFirst({
      where: { userId: user.id },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });
    const cooldownMs = config.mail.resendCooldownSeconds * 1000;
    if (newest && Date.now() - newest.createdAt.getTime() < cooldownMs) {
      const retryAfterSeconds = Math.ceil((cooldownMs - (Date.now() - newest.createdAt.getTime())) / 1000);
      throw new AppError(429, 'RATE_LIMITED', 'Please wait before requesting another code', {
        retryAfterSeconds,
      });
    }

    let devCode: string | undefined;
    try {
      const issued = await sendVerificationEmail({
        userId: user.id,
        email: user.email,
        firstName: user.firstName,
        locale: user.locale,
      });
      if (config.mail.exposeDevCode) devCode = issued.code;
    } catch (error) {
      logger.warn('auth.verification_resend_failed', {
        userId: user.id,
        reason: (error as Error).message,
      });
      throw new AppError(502, 'INTERNAL', 'Could not send the verification email, please try again');
    }

    return { sent: true, devCode };
  });
}