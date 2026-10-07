import { FulfillmentMode, InventoryMode, InventorySource, Prisma, ProductStatus, ProductType, ScrapedStatus } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { indexProduct } from '../search/service';
import { AppError, assertFound } from '../../utils/errors';

/**
 * ---------------------------------------------------------------------------
 * Inventory feed — promotion (the audited, priced step)
 * ---------------------------------------------------------------------------
 *
 * The only path by which a scraped row becomes a sellable product, and the
 * reason this feature can exist at all: a human decides the price, and the
 * decision is recorded.
 *
 * What it deliberately does NOT do:
 *   - **It never uses the scraped price.** `costCents` is typed by a person. If
 *     the operator wants the scraped number as a starting point the UI may
 *     pre-fill it, but the value is a decision and it is logged as one.
 *   - **It does not create `InventoryRecord` rows from scraped availability.**
 *     A nightly snapshot does not know what sold today. Under option A the
 *     platform owns the inventory it sells and seeds it explicitly, like any
 *     other first-party product.
 *
 * The product is created as `DRAFT`. It is not sellable until an operator
 * publishes it through the normal admin flow, so a promotion mistake cannot
 * reach a shopper on its own.
 */

export interface PromoteInput {
  scrapedId: string;
  /** The operator making the decision. Recorded on the audit row. */
  actorId: string;
  actorRole?: string;
  ip?: string;
  /** Our own cost basis. Never the scraped price. */
  costCents: number;
  /** Retail base. `computeQuote` still owns markup, tax and fees. */
  basePriceCents: number;
  currency: string;
  destinationSlug: string;
  merchantSlug?: string;
  /** Defaults to CONFIRMATION — never promise instant confirmation for these. */
  fulfillment?: FulfillmentMode;
  nameEn?: string;
  nameZh?: string;
  summaryEn?: string;
  markups?: { taxBps?: number; feeBps?: number };
}

export interface PromoteResult {
  productId: string;
  ticketTypeId: string;
  /** True when the row was already promoted and nothing new was created. */
  alreadyPromoted: boolean;
}

const DEFAULT_TAX_BPS = 0;
const DEFAULT_FEE_BPS = 0;

/** ASCII slug; `NFKD` strips accents. Returns '' for non-Latin input. */
function slugify(input: string): string {
  return input
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

function sanitizeId(externalId: string): string {
  return externalId.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 16) || 'x';
}

/**
 * Turns one staged row into a first-party `Product` + `TicketType`.
 *
 * Idempotent: promoting an already-promoted row returns the existing ids instead
 * of creating a duplicate, so a double-click cannot fork the catalogue.
 */
export async function promoteScrapedRow(input: PromoteInput): Promise<PromoteResult> {
  const scraped = assertFound(
    await prisma.scrapedInventory.findUnique({ where: { id: input.scrapedId } }),
    'ScrapedInventory row',
  );

  if (scraped.status === ScrapedStatus.PROMOTED && scraped.promotedProductId) {
    const existing = await prisma.product.findUnique({
      where: { id: scraped.promotedProductId },
      include: { ticketTypes: { take: 1 } },
    });
    if (existing && existing.ticketTypes[0]) {
      return { productId: existing.id, ticketTypeId: existing.ticketTypes[0].id, alreadyPromoted: true };
    }
  }
  if (scraped.status === ScrapedStatus.REJECTED) {
    throw AppError.conflict('This row was rejected; clear the rejection before promoting it');
  }
  if (scraped.status === ScrapedStatus.STALE) {
    throw AppError.conflict('This row is stale; refresh the feed before promoting it');
  }

  if (!Number.isInteger(input.costCents) || input.costCents < 0) throw AppError.validation('costCents must be a non-negative integer');
  if (!Number.isInteger(input.basePriceCents) || input.basePriceCents < 0) throw AppError.validation('basePriceCents must be a non-negative integer');
  const currency = input.currency.trim().toUpperCase();
  if (currency.length !== 3) throw AppError.validation('currency must be a 3-letter ISO code');

  const destination = assertFound(
    await prisma.destination.findUnique({ where: { slug: input.destinationSlug }, select: { id: true, timezone: true } }),
    'Destination',
  );

  let merchantId: string | null = null;
  if (input.merchantSlug) {
    const merchant = await prisma.merchant.findUnique({ where: { slug: input.merchantSlug }, select: { id: true } });
    if (!merchant) throw AppError.notFound('Merchant');
    merchantId = merchant.id;
  }

  const nameEn = input.nameEn?.trim() || scraped.name;
  const baseSlug = slugify(nameEn) || 'hotel';
  const slug = `${baseSlug}-${sanitizeId(scraped.externalId)}`;
  const existingSlug = await prisma.product.findUnique({ where: { slug }, select: { id: true } });
  if (existingSlug) throw AppError.conflict(`A product already uses the slug "${slug}"`);

  const starCategory = scraped.starRating ? Math.max(1, Math.min(5, Math.round(scraped.starRating))) : null;

  const product = await prisma.product.create({
    data: {
      slug,
      type: ProductType.HOTEL_ROOM,
      // DRAFT, not PUBLISHED: a promotion must be reviewed before it can sell.
      status: ProductStatus.DRAFT,
      // Never INSTANT_TICKET by default — there is no supplier confirmation
      // behind a scraped row, and promising one would be a false claim.
      fulfillment: input.fulfillment ?? FulfillmentMode.CONFIRMATION,
      merchantId,
      destinationId: destination.id,
      latitude: scraped.latitude,
      longitude: scraped.longitude,
      timezone: destination.timezone,
      defaultLocale: 'en',
      summary: input.summaryEn ?? null,
      roomCategory: null,
      starCategory,
      // Provenance: this is the audited link back to the staged row.
      sourceScrapedId: scraped.id,
      translations: {
        create: [
          { locale: 'en', name: nameEn, summary: input.summaryEn ?? null },
          // A zh row is only created when someone actually translated it —
          // fabricating one would ship an English string labelled Chinese.
          ...(input.nameZh?.trim() ? [{ locale: 'zh', name: input.nameZh.trim() }] : []),
        ],
      },
      ticketTypes: {
        create: [
          {
            code: `${slug}-std`,
            name: nameEn,
            basePriceCents: input.basePriceCents,
            costCents: input.costCents,
            currency,
            taxBps: input.markups?.taxBps ?? DEFAULT_TAX_BPS,
            feeBps: input.markups?.feeBps ?? DEFAULT_FEE_BPS,
            inventoryMode: InventoryMode.PER_NIGHT,
            // The row came from a feed, and the column says so. This is the
            // one place the schema's `MERCHANT_FEED` value is written.
            inventorySource: InventorySource.MERCHANT_FEED,
            active: true,
          },
        ],
      },
    },
    include: { ticketTypes: true },
  });

  const ticketType = product.ticketTypes[0];
  if (!ticketType) throw AppError.conflict('Product was created without a ticket type');

  await prisma.$transaction([
    prisma.scrapedInventory.update({
      where: { id: scraped.id },
      data: {
        status: ScrapedStatus.PROMOTED,
        promotedProductId: product.id,
        notes: null,
      },
    }),
    prisma.auditLog.create({
      data: {
        actorId: input.actorId,
        actorRole: input.actorRole ?? null,
        action: 'inventory_feed.promote',
        entityType: 'Product',
        entityId: product.id,
        ip: input.ip ?? null,
        // Both numbers are recorded, so "why is this priced like this" stays
        // answerable — including the scraped figure that was deliberately NOT
        // used.
        before: { scrapedId: scraped.id, scrapedPriceCents: scraped.priceCents, scrapedCurrency: scraped.currency } as Prisma.InputJsonValue,
        after: { productId: product.id, ticketTypeId: ticketType.id, costCents: input.costCents, basePriceCents: input.basePriceCents, currency } as Prisma.InputJsonValue,
      },
    }),
  ]);

  await indexProduct(product.id);

  return { productId: product.id, ticketTypeId: ticketType.id, alreadyPromoted: false };
}

/**
 * Marks a row as deliberately not sellable.
 *
 * A first-class action rather than a delete: the ingest job keys on
 * `(source, externalId)`, so deleting the row would let the next run recreate
 * it. `REJECTED` is that memory.
 */
export async function rejectScrapedRow(input: {
  scrapedId: string;
  actorId: string;
  actorRole?: string;
  ip?: string;
  notes?: string;
}): Promise<{ id: string; status: ScrapedStatus }> {
  const scraped = assertFound(
    await prisma.scrapedInventory.findUnique({ where: { id: input.scrapedId } }),
    'ScrapedInventory row',
  );
  if (scraped.status === ScrapedStatus.PROMOTED) {
    throw AppError.conflict('This row was promoted; pause or archive the product instead');
  }

  const updated = await prisma.scrapedInventory.update({
    where: { id: scraped.id },
    data: { status: ScrapedStatus.REJECTED, notes: input.notes ?? null },
  });

  await prisma.auditLog.create({
    data: {
      actorId: input.actorId,
      actorRole: input.actorRole ?? null,
      action: 'inventory_feed.reject',
      entityType: 'ScrapedInventory',
      entityId: scraped.id,
      ip: input.ip ?? null,
      after: { status: updated.status, notes: updated.notes } as Prisma.InputJsonValue,
    },
  });

  return { id: updated.id, status: updated.status };
}
