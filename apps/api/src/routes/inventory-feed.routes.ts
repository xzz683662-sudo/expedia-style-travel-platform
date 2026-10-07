import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../config/env';
import { prisma } from '../lib/prisma';
import { requireRole } from '../plugins/auth';
import { assertFound } from '../utils/errors';
import { ingestApifyHotels, ingestCityBatch, refreshStale } from '../modules/inventory-feed/scraper';
import { promoteScrapedRow, rejectScrapedRow } from '../modules/inventory-feed/promote';

/**
 * ---------------------------------------------------------------------------
 * Inventory feed review surface (operator-only)
 * ---------------------------------------------------------------------------
 *
 * A review queue over `ScrapedInventory` plus the audited promote/reject
 * actions. Every route is gated twice:
 *
 *   1. `feedEnabled` returns 404 while `INVENTORY_FEED_ENABLED=false`, so the
 *      surface is invisible rather than merely unauthorised. That is the
 *      rollback story: turn the flag off and the endpoints cease to exist.
 *   2. `requireRole('ADMIN')` for the mutating actions.
 *
 * The queue is a projection: it returns candidate fields, never `raw`, except
 * on the detail route where an operator reviewing a row needs the full payload.
 */
export async function inventoryFeedRoutes(app: FastifyInstance): Promise<void> {
  const adminOnly = { preHandler: [feedEnabled, requireRole('ADMIN')] };
  const staff = { preHandler: [feedEnabled, requireRole('ADMIN')] };

  // -------------------------------------------------------------------------
  // Review queue
  // -------------------------------------------------------------------------
  app.get('/admin/inventory-feed', staff, async (request) => {
    const query = z
      .object({
        status: z.enum(['NEW', 'REVIEWED', 'PROMOTED', 'REJECTED', 'STALE']).optional(),
        city: z.string().optional(),
        /** Free-text search over the staged name. Trigram-backed (indexes.sql). */
        q: z.string().trim().min(1).max(120).optional(),
        limit: z.coerce.number().int().min(1).max(200).default(50),
      })
      .parse(request.query ?? {});

    const rows = await prisma.scrapedInventory.findMany({
      where: {
        ...(query.status ? { status: query.status } : {}),
        ...(query.city ? { citySlug: query.city } : {}),
        // The index layer reading the database directly: `contains` becomes
        // `ILIKE '%q%'`, served by `scraped_inventory_name_trgm` rather than a
        // Seq Scan. No second store, no reindex step.
        ...(query.q ? { name: { contains: query.q, mode: 'insensitive' as const } } : {}),
      },
      orderBy: [{ fetchedAt: 'desc' }],
      take: query.limit,
      select: {
        id: true,
        source: true,
        sourceRunId: true,
        externalId: true,
        externalRef: true,
        fetchedAt: true,
        syncedAt: true,
        name: true,
        citySlug: true,
        countryCode: true,
        latitude: true,
        longitude: true,
        starRating: true,
        propertyUrl: true,
        priceCents: true,
        currency: true,
        rawPriceText: true,
        checkIn: true,
        checkOut: true,
        status: true,
        promotedProductId: true,
        notes: true,
      },
    });

    const counts = await prisma.scrapedInventory.groupBy({ by: ['status'], _count: { _all: true } });

    return {
      enabled: config.inventoryFeed.enabled,
      counts: Object.fromEntries(counts.map((c) => [c.status, c._count._all])),
      rows: rows.map((row) => ({
        ...row,
        // The scraped price is *evidence*. Labelled so no caller mistakes it
        // for a sellable amount; see docs/supply-sources.md.
        scrapedPriceIsEvidenceOnly: true,
      })),
    };
  });

  /** One row including the untouched payload (an operator reviewing needs it). */
  app.get('/admin/inventory-feed/:id', staff, async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const row = assertFound(
      await prisma.scrapedInventory.findUnique({ where: { id } }),
      'ScrapedInventory row',
    );
    return { ...row, scrapedPriceIsEvidenceOnly: true };
  });

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  /**
   * Triggers one ingest batch. Manual first, by design: a bad first run on a
   * timer is a bad run every night. The planned row count is logged before the
   * run starts because an Apify run is billed.
   */
  app.post('/admin/inventory-feed/scrape', adminOnly, async (request) => {
    const body = z
      .object({
        location: z.array(z.string().min(1)).min(1).max(10),
        checkIn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        checkOut: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        limit: z.number().int().min(1).optional(),
      })
      .parse(request.body ?? {});

    return ingestApifyHotels(body);
  });

  /**
   * Scrapes many cities into the staging table in one call, retrying each one.
   *
   * This is the "fill the database" entry point: the actor answers roughly one
   * request in a thousand (measured 0.107%), so a single-query route is not a
   * practical way to populate the staging table. A city that never succeeds is
   * reported in `perCity` rather than failing the whole batch.
   */
  app.post('/admin/inventory-feed/scrape-batch', adminOnly, async (request) => {
    const body = z
      .object({
        cities: z.array(z.string().min(1)).min(1).max(200),
        checkIn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        checkOut: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        limitPerCity: z.number().int().min(1).optional(),
        maxAttempts: z.number().int().min(1).max(10).optional(),
      })
      .parse(request.body ?? {});

    return ingestCityBatch(body);
  });

  /** Promotes a staged row into a first-party product, priced from OUR cost. */
  app.post('/admin/inventory-feed/:id/promote', adminOnly, async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const body = z
      .object({
        costCents: z.number().int().min(0),
        basePriceCents: z.number().int().min(0),
        currency: z.string().length(3),
        destinationSlug: z.string().min(1),
        merchantSlug: z.string().min(1).optional(),
        fulfillment: z.enum(['INSTANT_TICKET', 'CONFIRMATION', 'ON_SITE_PAYMENT']).optional(),
        nameEn: z.string().min(1).max(200).optional(),
        nameZh: z.string().min(1).max(200).optional(),
        summaryEn: z.string().max(2000).optional(),
        markups: z.object({ taxBps: z.number().int().min(0).optional(), feeBps: z.number().int().min(0).optional() }).optional(),
      })
      .parse(request.body ?? {});

    return promoteScrapedRow({
      scrapedId: id,
      actorId: request.user!.id,
      actorRole: request.user!.role,
      ip: request.ip,
      ...body,
    });
  });

  /** Rejects a row. First-class, not a delete, so a re-run cannot resurrect it. */
  app.post('/admin/inventory-feed/:id/reject', adminOnly, async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const body = z.object({ notes: z.string().max(500).optional() }).parse(request.body ?? {});

    return rejectScrapedRow({
      scrapedId: id,
      actorId: request.user!.id,
      actorRole: request.user!.role,
      ip: request.ip,
      notes: body.notes,
    });
  });

  /**
   * Marks unconfirmed staged rows STALE. Exposed as an explicit action rather
   * than a tick on the 60s sweeper: the right cadence is daily, owned by this
   * module, and switchable off with the feature flag.
   */
  app.post('/admin/inventory-feed/refresh-stale', adminOnly, async () => refreshStale());
}

/**
 * Returns 404 — not 403 — while the feed is disabled.
 *
 * An invisible surface is the cleanest rollback: with the flag off there is
 * nothing to authenticate against and nothing to leak. Must be `async`; a
 * synchronous Fastify hook returning `undefined` is treated as callback-style
 * and hangs (see `.github/skills/repo-playbook/SKILL.md`).
 */
async function feedEnabled(_request: unknown, reply: any): Promise<unknown> {
  if (!config.inventoryFeed.enabled) {
    return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Inventory feed is disabled' } });
  }
  return undefined;
}
