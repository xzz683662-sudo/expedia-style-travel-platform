import type { Prisma } from '@prisma/client';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { requireRole } from '../plugins/auth';
import { AppError } from '../utils/errors';
import { resolveLocale } from '../plugins/auth';

/**
 * ===========================================================================
 * Promotional banners
 * ===========================================================================
 *
 * Two audiences:
 *   - Public: `GET /promo/banners` returns the banners eligible for a slot,
 *     already resolved into the caller's language. No auth, heavily cached.
 *   - Admin: full CRUD under `/admin/promo/*` with an audit trail.
 *
 * Resolving the language server-side keeps the client dumb: it just renders
 * `title` / `body` / `ctaLabel` and never has to know a fallback exists.
 */

const THEMES = ['brand', 'accent', 'success', 'warning', 'neutral'] as const;
const themeSchema = z.enum(THEMES);

type BannerRow = {
  id: string;
  slot: string;
  titleEn: string;
  titleZh: string | null;
  bodyEn: string | null;
  bodyZh: string | null;
  ctaLabelEn: string | null;
  ctaLabelZh: string | null;
  ctaHref: string | null;
  imageUrl: string | null;
  theme: string;
  startsAt: Date | null;
  endsAt: Date | null;
  isActive: boolean;
  sortOrder: number;
  markets: string[];
  locales: string[];
  clickCount: number;
};

/** Picks the caller's language, falling back to English when it is missing. */
function localize(row: BannerRow, locale: string) {
  const zh = locale.toLowerCase().startsWith('zh');
  const pick = (en: string | null, cn: string | null) => (zh ? (cn ?? en) : en);

  return {
    id: row.id,
    slot: row.slot,
    title: pick(row.titleEn, row.titleZh) ?? '',
    body: pick(row.bodyEn, row.bodyZh),
    ctaLabel: pick(row.ctaLabelEn, row.ctaLabelZh),
    ctaHref: row.ctaHref,
    imageUrl: row.imageUrl,
    theme: THEMES.includes(row.theme as (typeof THEMES)[number]) ? row.theme : 'brand',
    sortOrder: row.sortOrder,
  };
}

/** Active + in-window + matching the caller's market/locale targeting. */
function isEligible(row: BannerRow, now: Date, market: string, locale: string): boolean {
  if (!row.isActive) return false;
  if (row.startsAt && row.startsAt > now) return false;
  if (row.endsAt && row.endsAt < now) return false;
  if (row.markets.length > 0 && !row.markets.includes(market)) return false;
  if (row.locales.length > 0 && !row.locales.some((l) => locale.toLowerCase().startsWith(l.toLowerCase()))) {
    return false;
  }
  return true;
}

export const promoRoutes: FastifyPluginAsync = async (app) => {
  /**
   * Storefront-facing. Returns banners grouped by slot so the client can render
   * each region without knowing the slot names.
   */
  app.get('/promo/banners', async (request) => {
    const query = z
      .object({
        slot: z.string().optional(),
        market: z.string().optional(),
      })
      .parse(request.query ?? {});

    const locale = resolveLocale(request);
    const market = query.market ?? request.headers['x-market']?.toString() ?? 'US';
    const now = new Date();

    const rows = await prisma.promoBanner.findMany({
      where: query.slot ? { slot: query.slot } : undefined,
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'desc' }],
      take: 50,
    });

    const eligible = rows
      .filter((row) => isEligible(row as BannerRow, now, market, locale))
      .map((row) => localize(row as BannerRow, locale));

    return {
      locale,
      market,
      banners: eligible,
      grouped: eligible.reduce<Record<string, typeof eligible>>((acc, banner) => {
        (acc[banner.slot] ??= []).push(banner);
        return acc;
      }, {}),
    };
  });

  /** Fire-and-forget click counter — used for merchandising reporting. */
  app.post('/promo/banners/:id/click', async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);

    const updated = await prisma.promoBanner.updateMany({
      where: { id },
      data: { clickCount: { increment: 1 } },
    });

    if (updated.count === 0) throw AppError.notFound('Banner');
    return reply.status(204).send();
  });

  // -------------------------------------------------------------------------
  // Admin
  // -------------------------------------------------------------------------
  const bannerInput = z.object({
    slot: z.string().min(1).max(40).default('home'),
    titleEn: z.string().min(1).max(160),
    titleZh: z.string().max(160).optional().nullable(),
    bodyEn: z.string().max(600).optional().nullable(),
    bodyZh: z.string().max(600).optional().nullable(),
    ctaLabelEn: z.string().max(60).optional().nullable(),
    ctaLabelZh: z.string().max(60).optional().nullable(),
    ctaHref: z.string().max(300).optional().nullable(),
    imageUrl: z.string().url().max(500).optional().nullable().or(z.literal('')),
    theme: themeSchema.default('brand'),
    startsAt: z.coerce.date().optional().nullable(),
    endsAt: z.coerce.date().optional().nullable(),
    isActive: z.boolean().default(true),
    sortOrder: z.number().int().min(0).max(9999).default(0),
    markets: z.array(z.string().length(2)).max(20).default([]),
    locales: z.array(z.string()).max(20).default([]),
  });

  app.get('/admin/promo/banners', { preHandler: requireRole('ADMIN') }, async (request) => {
    const query = z
      .object({
        slot: z.string().optional(),
        includeInactive: z.coerce.boolean().default(true),
      })
      .parse(request.query ?? {});

    const rows = await prisma.promoBanner.findMany({
      where: {
        ...(query.slot ? { slot: query.slot } : {}),
        ...(query.includeInactive ? {} : { isActive: true }),
      },
      orderBy: [{ slot: 'asc' }, { sortOrder: 'asc' }, { createdAt: 'desc' }],
    });

    const now = new Date();
    return {
      items: rows.map((row) => ({
        ...row,
        live: isEligible(row as BannerRow, now, 'US', 'en'),
      })),
    };
  });

  app.post('/admin/promo/banners', { preHandler: requireRole('ADMIN') }, async (request, reply) => {
    const body = bannerInput.parse(request.body ?? {});

    if (body.startsAt && body.endsAt && body.endsAt <= body.startsAt) {
      throw AppError.badRequest('endDate must be after startDate');
    }

    const created = await prisma.promoBanner.create({
      data: {
        ...body,
        imageUrl: body.imageUrl || null,
        titleZh: body.titleZh || null,
        bodyEn: body.bodyEn || null,
        bodyZh: body.bodyZh || null,
        ctaLabelEn: body.ctaLabelEn || null,
        ctaLabelZh: body.ctaLabelZh || null,
        ctaHref: body.ctaHref || null,
      },
    });

    await prisma.auditLog.create({
      data: {
        actorId: request.user?.id,
        actorRole: request.user?.role,
        action: 'promo.banner.create',
        entityType: 'PromoBanner',
        entityId: created.id,
        after: created as unknown as Prisma.InputJsonValue,
        ip: request.ip,
      },
    });

    return reply.status(201).send(created);
  });

  app.patch('/admin/promo/banners/:id', { preHandler: requireRole('ADMIN') }, async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const body = bannerInput.partial().parse(request.body ?? {});

    const before = await prisma.promoBanner.findUnique({ where: { id } });
    if (!before) throw AppError.notFound('Banner');

    const startsAt = body.startsAt === undefined ? before.startsAt : body.startsAt;
    const endsAt = body.endsAt === undefined ? before.endsAt : body.endsAt;
    if (startsAt && endsAt && endsAt <= startsAt) {
      throw AppError.badRequest('endDate must be after startDate');
    }

    const updated = await prisma.promoBanner.update({ where: { id }, data: body });

    await prisma.auditLog.create({
      data: {
        actorId: request.user?.id,
        actorRole: request.user?.role,
        action: 'promo.banner.update',
        entityType: 'PromoBanner',
        entityId: id,
        before: before as unknown as Prisma.InputJsonValue,
        after: updated as unknown as Prisma.InputJsonValue,
        ip: request.ip,
      },
    });

    return updated;
  });

  app.delete('/admin/promo/banners/:id', { preHandler: requireRole('ADMIN') }, async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);

    const before = await prisma.promoBanner.findUnique({ where: { id } });
    if (!before) throw AppError.notFound('Banner');

    await prisma.promoBanner.delete({ where: { id } });

    await prisma.auditLog.create({
      data: {
        actorId: request.user?.id,
        actorRole: request.user?.role,
        action: 'promo.banner.delete',
        entityType: 'PromoBanner',
        entityId: id,
        before: before as unknown as Prisma.InputJsonValue,
        ip: request.ip,
      },
    });

    return reply.status(204).send();
  });
};